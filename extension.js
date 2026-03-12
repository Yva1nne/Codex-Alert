const vscode = require("vscode");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const OPEN_CODEX_ACTION = "Open Codex";
const RECENT_SESSION_FILE_LIMIT = 5;
const SESSION_READ_DELAY_MS = 120;
const TOOL_EVENT_TTL_MS = 60000;
const LOG_QUERY_LIMIT = 200;
const WINDOWS_SOUND_COMMANDS = Object.freeze({
  systemAsterisk: "[System.Media.SystemSounds]::Asterisk.Play()",
  systemExclamation: "[System.Media.SystemSounds]::Exclamation.Play()",
  systemHand: "[System.Media.SystemSounds]::Hand.Play()",
  systemQuestion: "[System.Media.SystemSounds]::Question.Play()"
});

function activate(context) {
  const controller = new CodexAlertsController(context);
  context.subscriptions.push(controller);
  controller.start().catch((error) => {
    controller.error(`Startup failed: ${formatError(error)}`);
  });
}

function deactivate() {}

class CodexAlertsController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("Codex Alerts");
    this.disposables = [];
    this.sessionMonitor = null;
    this.logMonitor = null;
    this.seenEvents = new ExpiringSet();
    this.backendSummary = "not initialized";
    this.config = loadConfig();
  }

  async start() {
    this.registerCommands();
    this.registerConfigWatcher();
    await this.restart();
  }

  registerCommands() {
    this.disposables.push(
      vscode.commands.registerCommand("codexAlerts.testTaskNotification", async () => {
        await this.notify("task", {
          id: `manual-task-${Date.now()}`,
          title: "Codex task completed",
          detail: "Manual test notification."
        });
      }),
      vscode.commands.registerCommand("codexAlerts.testApprovalNotification", async () => {
        await this.notify("approval", {
          id: `manual-approval-${Date.now()}`,
          title: "Codex needs approval",
          detail: "Manual test notification."
        });
      }),
      vscode.commands.registerCommand("codexAlerts.testUserInputNotification", async () => {
        await this.notify("userInput", {
          id: `manual-input-${Date.now()}`,
          title: "Codex needs input",
          detail: "Manual test notification."
        });
      }),
      vscode.commands.registerCommand("codexAlerts.showDiagnostics", async () => {
        await this.showDiagnostics();
      }),
      vscode.commands.registerCommand("codexAlerts.restart", async () => {
        await this.restart();
        vscode.window.showInformationMessage("Codex Alerts watchers restarted.");
      })
    );
  }

  registerConfigWatcher() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (!event.affectsConfiguration("codexAlerts")) {
          return;
        }

        this.config = loadConfig();
        this.info("Configuration changed, restarting watchers.");
        await this.restart();
      })
    );
  }

  async restart() {
    this.stopWatchers();
    this.seenEvents.clear();
    this.config = loadConfig();

    const home = os.homedir();
    const sessionRoot = path.join(home, ".codex", "sessions");
    const dbPath = path.join(home, ".codex", "state_5.sqlite");
    const queryScriptPath = this.context.asAbsolutePath(path.join("scripts", "query_codex_logs.py"));

    this.sessionMonitor = new SessionMonitor({
      sessionRoot,
      output: this.output,
      debug: this.config.debugLogging,
      onApprovalRequested: (event) => this.handleApprovalRequested(event),
      onUserInputRequested: (event) => this.handleUserInputRequested(event)
    });

    this.logMonitor = new SqlLogMonitor({
      dbPath,
      output: this.output,
      debug: this.config.debugLogging,
      pollIntervalMs: this.config.pollIntervalMs,
      pythonPath: this.config.pythonPath,
      sqlite3Path: this.config.sqlite3Path,
      queryScriptPath,
      onTaskComplete: (event) => this.handleTaskComplete(event)
    });

    await this.sessionMonitor.start();
    await this.logMonitor.start();
    this.backendSummary = this.logMonitor.getBackendSummary();
    this.info(`Watchers ready. Completion backend: ${this.backendSummary}`);
  }

  stopWatchers() {
    if (this.sessionMonitor) {
      this.sessionMonitor.dispose();
      this.sessionMonitor = null;
    }

    if (this.logMonitor) {
      this.logMonitor.dispose();
      this.logMonitor = null;
    }
  }

  async handleTaskComplete(event) {
    if (!this.config.enableTaskCompleteAlerts) {
      return;
    }

    await this.notify("task", {
      id: `task:${event.id}`,
      title: "Codex task completed",
      detail: "The current Codex run reported completion."
    });
  }

  async handleApprovalRequested(event) {
    if (!this.config.enableApprovalAlerts) {
      return;
    }

    const detail = trimText(event.detail || "Codex wants approval for an elevated command.", 160);
    await this.notify("approval", {
      id: `approval:${event.id}`,
      title: "Codex needs approval",
      detail
    });
  }

  async handleUserInputRequested(event) {
    if (!this.config.enableUserInputAlerts) {
      return;
    }

    const detail = trimText(event.detail || "Codex asked for input.", 160);
    await this.notify("userInput", {
      id: `user-input:${event.id}`,
      title: "Codex needs input",
      detail
    });
  }

  async notify(kind, event) {
    if (this.seenEvents.has(event.id)) {
      this.debug(`Skipped duplicate ${kind} event: ${event.id}`);
      return;
    }

    this.seenEvents.add(event.id);

    if (this.shouldSkipNotificationBecauseWindowIsFocused(kind, event)) {
      return;
    }

    this.logEvent(kind, event);
    await this.playSound();

    const message = event.detail ? `${event.title}: ${event.detail}` : event.title;
    const show = kind === "task" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    const selection = await show(message, OPEN_CODEX_ACTION);

    if (selection === OPEN_CODEX_ACTION) {
      vscode.commands.executeCommand("chatgpt.openSidebar").then(
        undefined,
        (error) => this.error(`Failed to open Codex sidebar: ${formatError(error)}`)
      );
    }
  }

  shouldSkipNotificationBecauseWindowIsFocused(kind, event) {
    if (!this.config.onlyNotifyWhenWindowInactive) {
      return false;
    }

    if (!vscode.window.state.focused) {
      return false;
    }

    this.debug(`Skipped ${kind} alert because the VS Code window is focused: ${event.id}`);
    return true;
  }

  async playSound() {
    if (!this.config.enableSound) {
      return;
    }

    if (process.platform !== "win32") {
      return;
    }

    const command = buildWindowsSoundCommand(this.config);

    execFile("powershell", ["-NoProfile", "-Command", command], { windowsHide: true }, (error) => {
      if (error) {
        this.debug(`Sound playback failed: ${formatError(error)}`);
      }
    });
  }

  async showDiagnostics() {
    const home = os.homedir();
    const sessionRoot = path.join(home, ".codex", "sessions");
    const dbPath = path.join(home, ".codex", "state_5.sqlite");
    const lines = [
      `Completion backend: ${this.backendSummary}`,
      `Session root: ${existsSync(sessionRoot) ? sessionRoot : `${sessionRoot} (missing)`}`,
      `State DB: ${existsSync(dbPath) ? dbPath : `${dbPath} (missing)`}`,
      `Task alerts: ${this.config.enableTaskCompleteAlerts ? "on" : "off"}`,
      `Approval alerts: ${this.config.enableApprovalAlerts ? "on" : "off"}`,
      `User-input alerts: ${this.config.enableUserInputAlerts ? "on" : "off"}`,
      `Only when window inactive: ${this.config.onlyNotifyWhenWindowInactive ? "on" : "off"}`,
      `Window focused now: ${vscode.window.state.focused ? "yes" : "no"}`,
      `Sound: ${this.config.enableSound ? "on" : "off"}`,
      `Sound effect: ${normalizeSoundEffect(this.config.soundEffect)}`
    ];

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine("[Diagnostics]");
    for (const line of lines) {
      this.output.appendLine(line);
    }

    await vscode.window.showInformationMessage("Codex Alerts diagnostics written to the output channel.");
  }

  logEvent(kind, event) {
    this.output.appendLine(`[${new Date().toISOString()}] ${kind}: ${event.title}${event.detail ? ` | ${event.detail}` : ""}`);
  }

  info(message) {
    this.output.appendLine(`[info] ${message}`);
  }

  debug(message) {
    if (this.config.debugLogging) {
      this.output.appendLine(`[debug] ${message}`);
    }
  }

  error(message) {
    this.output.appendLine(`[error] ${message}`);
  }

  dispose() {
    this.stopWatchers();
    disposeAll(this.disposables);
    this.output.dispose();
  }
}

class SessionMonitor {
  constructor(options) {
    this.sessionRoot = options.sessionRoot;
    this.output = options.output;
    this.debugEnabled = options.debug;
    this.onApprovalRequested = options.onApprovalRequested;
    this.onUserInputRequested = options.onUserInputRequested;
    this.watcher = null;
    this.fallbackTimer = null;
    this.pendingReads = new Map();
    this.fileState = new Map();
  }

  async start() {
    if (!existsSync(this.sessionRoot)) {
      this.output.appendLine(`[warn] Session root not found: ${this.sessionRoot}`);
      return;
    }

    await this.primeRecentFiles();
    this.startWatcher();
  }

  async primeRecentFiles() {
    const files = await collectRecentJsonlFiles(this.sessionRoot, RECENT_SESSION_FILE_LIMIT);
    await Promise.all(files.map((file) => this.primeFile(file)));
    this.debug(`Primed ${files.length} recent session files.`);
  }

  async primeFile(filePath) {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return;
      }

      this.fileState.set(filePath, {
        offset: stat.size,
        remainder: ""
      });
    } catch (error) {
      this.debug(`Prime failed for ${filePath}: ${formatError(error)}`);
    }
  }

  startWatcher() {
    try {
      this.watcher = fs.watch(this.sessionRoot, { recursive: true }, (_eventType, fileName) => {
        if (!fileName || !fileName.endsWith(".jsonl")) {
          return;
        }

        const filePath = path.resolve(this.sessionRoot, fileName);
        this.scheduleRead(filePath);
      });
      this.debug(`Watching session root recursively: ${this.sessionRoot}`);
    } catch (error) {
      this.output.appendLine(`[warn] Recursive session watch failed, falling back to polling: ${formatError(error)}`);
      this.fallbackTimer = setInterval(() => {
        this.scanRecentFiles().catch((scanError) => {
          this.debug(`Fallback scan failed: ${formatError(scanError)}`);
        });
      }, 5000);
    }
  }

  async scanRecentFiles() {
    const files = await collectRecentJsonlFiles(this.sessionRoot, RECENT_SESSION_FILE_LIMIT);
    for (const filePath of files) {
      if (!this.fileState.has(filePath)) {
        await this.primeFile(filePath);
      }
      this.scheduleRead(filePath);
    }
  }

  scheduleRead(filePath) {
    if (this.pendingReads.has(filePath)) {
      clearTimeout(this.pendingReads.get(filePath));
    }

    const timer = setTimeout(() => {
      this.pendingReads.delete(filePath);
      this.readAppended(filePath).catch((error) => {
        this.debug(`Read failed for ${filePath}: ${formatError(error)}`);
      });
    }, SESSION_READ_DELAY_MS);

    this.pendingReads.set(filePath, timer);
  }

  async readAppended(filePath) {
    if (!existsSync(filePath)) {
      return;
    }

    let state = this.fileState.get(filePath);
    if (!state) {
      await this.primeFile(filePath);
      state = this.fileState.get(filePath);
    }

    if (!state) {
      return;
    }

    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return;
    }

    if (stat.size < state.offset) {
      state.offset = 0;
      state.remainder = "";
    }

    if (stat.size === state.offset) {
      return;
    }

    const length = stat.size - state.offset;
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      state.offset = stat.size;
      this.processChunk(filePath, state, buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
  }

  processChunk(filePath, state, chunk) {
    const text = state.remainder + chunk;
    const lines = text.split(/\r?\n/);
    state.remainder = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      this.processLine(filePath, trimmed);
    }
  }

  processLine(filePath, line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      this.debug(`JSON parse failed for ${filePath}: ${formatError(error)}`);
      return;
    }

    if (record.type !== "response_item" || !record.payload || record.payload.type !== "function_call") {
      return;
    }

    const payload = record.payload;
    if (payload.name === "request_user_input") {
      const detail = formatUserInputDetail(parseNestedJson(payload.arguments));
      this.onUserInputRequested({
        id: payload.call_id || `${filePath}:${record.timestamp}`,
        detail
      });
      return;
    }

    const args = parseNestedJson(payload.arguments);
    if (!args || args.sandbox_permissions !== "require_escalated") {
      return;
    }

    const detail = formatApprovalDetail(payload.name, args);
    this.onApprovalRequested({
      id: payload.call_id || `${filePath}:${record.timestamp}`,
      detail
    });
  }

  debug(message) {
    if (this.debugEnabled) {
      this.output.appendLine(`[session-debug] ${message}`);
    }
  }

  dispose() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    for (const timer of this.pendingReads.values()) {
      clearTimeout(timer);
    }
    this.pendingReads.clear();
    this.fileState.clear();
  }
}

class SqlLogMonitor {
  constructor(options) {
    this.dbPath = options.dbPath;
    this.output = options.output;
    this.debugEnabled = options.debug;
    this.pollIntervalMs = options.pollIntervalMs;
    this.onTaskComplete = options.onTaskComplete;
    this.reader = new LogReader({
      dbPath: options.dbPath,
      output: options.output,
      debug: options.debug,
      pythonPath: options.pythonPath,
      sqlite3Path: options.sqlite3Path,
      queryScriptPath: options.queryScriptPath
    });
    this.timer = null;
    this.lastLogId = 0;
  }

  async start() {
    if (!existsSync(this.dbPath)) {
      this.output.appendLine(`[warn] Codex state DB not found: ${this.dbPath}`);
      return;
    }

    if (!(await this.reader.initialize())) {
      this.output.appendLine("[warn] No SQLite backend available. Task completion alerts are disabled.");
      return;
    }

    this.lastLogId = await this.reader.getCurrentMaxId();
    this.debug(`Starting log monitor from id ${this.lastLogId}.`);
    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        this.output.appendLine(`[warn] Codex log polling failed: ${formatError(error)}`);
      });
    }, this.pollIntervalMs);
  }

  async poll() {
    const rows = await this.reader.getRows(this.lastLogId, LOG_QUERY_LIMIT);
    for (const row of rows) {
      this.lastLogId = Math.max(this.lastLogId, Number(row.id) || this.lastLogId);
      this.processRow(row);
    }
  }

  processRow(row) {
    const message = row.message || "";
    if (message.includes("app-server event: codex/event/task_complete")) {
      this.onTaskComplete({ id: row.id });
      return;
    }


  }

  getBackendSummary() {
    return this.reader.getSummary();
  }

  debug(message) {
    if (this.debugEnabled) {
      this.output.appendLine(`[log-debug] ${message}`);
    }
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

class LogReader {
  constructor(options) {
    this.dbPath = options.dbPath;
    this.output = options.output;
    this.debugEnabled = options.debug;
    this.queryScriptPath = options.queryScriptPath;
    this.candidates = buildBackendCandidates(options.pythonPath, options.sqlite3Path, this.queryScriptPath);
    this.activeBackend = null;
  }

  async initialize() {
    for (const backend of this.candidates) {
      if (await backend.isAvailable()) {
        this.activeBackend = backend;
        this.debug(`Using log backend: ${backend.describe()}`);
        return true;
      }
    }

    return false;
  }

  async getCurrentMaxId() {
    const result = await this.runWithFallback((backend) => backend.getCurrentMaxId(this.dbPath));
    return Number(result) || 0;
  }

  async getRows(afterId, limit) {
    const rows = await this.runWithFallback((backend) => backend.getRows(this.dbPath, afterId, limit));
    return Array.isArray(rows) ? rows : [];
  }

  async runWithFallback(run) {
    const backends = this.activeBackend
      ? [this.activeBackend, ...this.candidates.filter((backend) => backend !== this.activeBackend)]
      : this.candidates;
    const errors = [];

    for (const backend of backends) {
      try {
        const value = await run(backend);
        this.activeBackend = backend;
        return value;
      } catch (error) {
        errors.push(`[${backend.describe()}] ${formatError(error)}`);
        this.debug(`Backend failed: ${backend.describe()} -> ${formatError(error)}`);
      }
    }

    throw new Error(`All log backends failed. ${errors.join(" | ")}`);
  }

  getSummary() {
    return this.activeBackend ? this.activeBackend.describe() : "unavailable";
  }

  debug(message) {
    if (this.debugEnabled) {
      this.output.appendLine(`[backend-debug] ${message}`);
    }
  }
}

class PythonBackend {
  constructor(command, prefixArgs, scriptPath) {
    this.command = command;
    this.prefixArgs = prefixArgs;
    this.scriptPath = scriptPath;
  }

  describe() {
    return `python (${[this.command, ...this.prefixArgs].join(" ")})`;
  }

  async isAvailable() {
    try {
      await execFileAsync(this.command, [...this.prefixArgs, "--version"], { timeout: 5000 });
      return existsSync(this.scriptPath);
    } catch {
      return false;
    }
  }

  async getCurrentMaxId(dbPath) {
    const stdout = await execFileAsync(this.command, [...this.prefixArgs, this.scriptPath, dbPath, "max"], {
      timeout: 10000
    });
    const payload = JSON.parse(stdout.trim() || "{}");
    return payload.maxId || 0;
  }

  async getRows(dbPath, afterId, limit) {
    const stdout = await execFileAsync(
      this.command,
      [...this.prefixArgs, this.scriptPath, dbPath, "rows", String(afterId), String(limit)],
      { timeout: 10000 }
    );
    return JSON.parse(stdout.trim() || "[]");
  }
}

class SqliteCliBackend {
  constructor(command) {
    this.command = command;
  }

  describe() {
    return `sqlite3 (${this.command})`;
  }

  async isAvailable() {
    try {
      await execFileAsync(this.command, ["-version"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentMaxId(dbPath) {
    const stdout = await execFileAsync(this.command, [dbPath, "select coalesce(max(id), 0) from logs;"], {
      timeout: 10000
    });
    return Number(stdout.trim()) || 0;
  }

  async getRows(dbPath, afterId, limit) {
    const sql = [
      "select",
      "  id,",
      "  ts,",
      "  target,",
      "  replace(replace(ifnull(message, ''), char(13), ' '), char(10), ' ') as message",
      "from logs",
      `where id > ${Number(afterId) || 0}`,
      "  and target = 'codex_app_server::codex_message_processor'",
      "order by id asc",
      `limit ${Number(limit) || LOG_QUERY_LIMIT};`
    ].join(" ");

    const stdout = await execFileAsync(this.command, ["-csv", "-header", dbPath, sql], {
      timeout: 10000
    });
    return parseCsv(stdout);
  }
}

class ExpiringSet {
  constructor() {
    this.values = new Map();
  }

  add(key) {
    this.cleanup();
    this.values.set(key, Date.now());
  }

  has(key) {
    this.cleanup();
    return this.values.has(key);
  }

  clear() {
    this.values.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamp] of this.values.entries()) {
      if (now - timestamp > TOOL_EVENT_TTL_MS) {
        this.values.delete(key);
      }
    }
  }
}

function buildBackendCandidates(pythonPath, sqlite3Path, scriptPath) {
  const candidates = [];

  if (pythonPath.trim()) {
    candidates.push(new PythonBackend(pythonPath.trim(), [], scriptPath));
  } else {
    candidates.push(new PythonBackend("python", [], scriptPath));
    candidates.push(new PythonBackend("py", ["-3"], scriptPath));
  }

  if (sqlite3Path.trim()) {
    candidates.push(new SqliteCliBackend(sqlite3Path.trim()));
  } else {
    candidates.push(new SqliteCliBackend("sqlite3"));
  }

  return candidates;
}

function loadConfig() {
  const config = vscode.workspace.getConfiguration("codexAlerts");
  return {
    enableTaskCompleteAlerts: config.get("enableTaskCompleteAlerts", true),
    enableApprovalAlerts: config.get("enableApprovalAlerts", true),
    enableUserInputAlerts: config.get("enableUserInputAlerts", true),
    onlyNotifyWhenWindowInactive: config.get("onlyNotifyWhenWindowInactive", false),
    enableSound: config.get("enableSound", true),
    soundEffect: config.get("soundEffect", "beep"),
    soundFrequencyHz: config.get("soundFrequencyHz", 880),
    soundDurationMs: config.get("soundDurationMs", 250),
    pollIntervalMs: config.get("pollIntervalMs", 2000),
    pythonPath: config.get("pythonPath", ""),
    sqlite3Path: config.get("sqlite3Path", ""),
    debugLogging: config.get("debugLogging", false)
  };
}

function parseNestedJson(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatApprovalDetail(toolName, args) {
  if (typeof args.justification === "string" && args.justification.trim()) {
    return args.justification.trim();
  }

  if (typeof args.command === "string" && args.command.trim()) {
    return `Run: ${trimText(args.command.trim(), 120)}`;
  }

  return `${toolName} requested elevated permission.`;
}

function formatUserInputDetail(args) {
  if (!args || !Array.isArray(args.questions) || args.questions.length === 0) {
    return "Codex asked for input.";
  }

  const first = args.questions[0];
  const parts = [];
  if (typeof first.header === "string" && first.header.trim()) {
    parts.push(first.header.trim());
  }
  if (typeof first.question === "string" && first.question.trim()) {
    parts.push(first.question.trim());
  }

  return parts.length > 0 ? parts.join(" - ") : "Codex asked for input.";
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numeric));
}

function trimText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

function normalizeSoundEffect(value) {
  if (value === "beep") {
    return value;
  }

  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(WINDOWS_SOUND_COMMANDS, value)) {
    return value;
  }

  return "beep";
}

function buildWindowsSoundCommand(config) {
  const soundEffect = normalizeSoundEffect(config.soundEffect);
  if (soundEffect !== "beep") {
    return WINDOWS_SOUND_COMMANDS[soundEffect];
  }

  const frequency = clampNumber(config.soundFrequencyHz, 100, 4000, 880);
  const duration = clampNumber(config.soundDurationMs, 50, 5000, 250);
  return `[console]::beep(${frequency}, ${duration})`;
}

async function collectRecentJsonlFiles(root, limit) {
  const files = [];
  await walkDirectory(root, async (filePath, stat) => {
    if (filePath.endsWith(".jsonl")) {
      files.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  });

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files.slice(0, limit).map((entry) => entry.filePath);
}

async function walkDirectory(root, onFile) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(entryPath, onFile);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stat = await fsp.stat(entryPath);
    await onFile(entryPath, stat);
  }
}

function parseCsv(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const rows = [];
  let current = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      current.push(field);
      field = "";
      continue;
    }

    if (char === '\n') {
      current.push(field.replace(/\r$/, ""));
      rows.push(current);
      current = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field.length > 0 || current.length > 0) {
    current.push(field.replace(/\r$/, ""));
    rows.push(current);
  }

  if (rows.length === 0) {
    return [];
  }

  const header = rows.shift();
  return rows.filter((row) => row.length > 0).map((row) => {
    const record = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index]] = row[index] || "";
    }
    return record;
  });
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr && stderr.trim() ? stderr.trim() : stdout && stdout.trim() ? stdout.trim() : error.message;
        reject(new Error(detail));
        return;
      }

      resolve(stdout);
    });
  });
}

function existsSync(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function disposeAll(disposables) {
  while (disposables.length > 0) {
    const disposable = disposables.pop();
    try {
      disposable.dispose();
    } catch {
      // Ignore dispose errors.
    }
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

module.exports = {
  activate,
  deactivate
};
