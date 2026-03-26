const vscode = require("vscode");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const OPEN_CODEX_ACTION = "Open Codex";
const RECENT_SESSION_FILE_LIMIT = 5;
const SESSION_READ_DELAY_MS = 120;
const SESSION_SCAN_INTERVAL_MS = 1500;
const SESSION_NEW_FILE_GRACE_MS = 5000;
const SESSION_NEW_FILE_MAX_START_BYTES = 64 * 1024;
const TOOL_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOOL_EVENT_CACHE_LIMIT = 2048;
const TOOL_EVENT_STATE_KEY = "codexAlerts.seenEvents";
const LOG_QUERY_LIMIT = 200;
const APPROVAL_LIKE_COMMAND_PATTERNS = Object.freeze([
  /\bRemove-Item\b/i,
  /\brm\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i
]);
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

const WINDOWS_NOTIFICATION_ICONS = Object.freeze({
  task: "Information",
  approval: "Warning",
  userInput: "Warning"
});

class CodexAlertsController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("Codex Alerts");
    this.disposables = [];
    this.sessionMonitor = null;
    this.logMonitors = [];
    this.seenEvents = new ExpiringSet(context.globalState, TOOL_EVENT_STATE_KEY);
    this.backendSummary = "not initialized";
    this.config = loadConfig();
    this.strings = createRuntimeStrings();
  }

  async start() {
    try {
      await this.seenEvents.initialize();
    } catch (error) {
      this.error(`Recent alert cache initialization failed: ${formatError(error)}`);
    }
    this.registerCommands();
    this.registerConfigWatcher();
    await this.restart();
  }

  registerCommands() {
    this.disposables.push(
      vscode.commands.registerCommand("codexAlerts.testTaskNotification", async () => {
        await this.notify("task", {
          id: `manual-task-${Date.now()}`,
          title: this.strings.taskCompletedTitle,
          detail: this.strings.manualTestDetail
        });
      }),
      vscode.commands.registerCommand("codexAlerts.testApprovalNotification", async () => {
        await this.notify("approval", {
          id: `manual-approval-${Date.now()}`,
          title: this.strings.approvalTitle,
          detail: this.strings.manualTestDetail
        });
      }),
      vscode.commands.registerCommand("codexAlerts.testUserInputNotification", async () => {
        await this.notify("userInput", {
          id: `manual-input-${Date.now()}`,
          title: this.strings.userInputTitle,
          detail: this.strings.manualTestDetail
        });
      }),
      vscode.commands.registerCommand("codexAlerts.showDiagnostics", async () => {
        await this.showDiagnostics();
      }),
      vscode.commands.registerCommand("codexAlerts.restart", async () => {
        await this.restart();
        vscode.window.showInformationMessage(this.strings.watchersRestarted);
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
    this.config = loadConfig();
    this.strings = createRuntimeStrings();

    const home = os.homedir();
    const sessionRoot = path.join(home, ".codex", "sessions");
    const dbPaths = selectPreferredCodexLogDbs(home);
    const queryScriptPath = this.context.asAbsolutePath(path.join("scripts", "query_codex_logs.py"));

    this.sessionMonitor = new SessionMonitor({
      sessionRoot,
      output: this.output,
      debug: this.config.debugLogging,
      onApprovalRequested: (event) => this.handleApprovalRequested(event),
      onUserInputRequested: (event) => this.handleUserInputRequested(event)
    });

    this.logMonitors = dbPaths.map((dbPath) => new SqlLogMonitor({
      dbPath,
      output: this.output,
      debug: this.config.debugLogging,
      pollIntervalMs: this.config.pollIntervalMs,
      pythonPath: this.config.pythonPath,
      sqlite3Path: this.config.sqlite3Path,
      queryScriptPath,
      onTaskComplete: (event) => this.handleTaskComplete(event)
    }));

    await this.sessionMonitor.start();
    await Promise.all(this.logMonitors.map((monitor) => monitor.start()));
    this.backendSummary = this.logMonitors.map((monitor) => monitor.getBackendSummary()).join("; ");
    this.info(`Watchers ready. Completion backend: ${this.backendSummary}`);
  }

  stopWatchers() {
    if (this.sessionMonitor) {
      this.sessionMonitor.dispose();
      this.sessionMonitor = null;
    }

    if (this.logMonitors.length > 0) {
      for (const monitor of this.logMonitors) {
        monitor.dispose();
      }
      this.logMonitors = [];
    }
  }

  async handleTaskComplete(event) {
    if (!this.config.enableTaskCompleteAlerts) {
      return;
    }

    await this.notify("task", {
      id: `task:${event.id}`,
      title: this.strings.taskCompletedTitle,
      detail: this.strings.taskCompletedDetail
    });
  }

  async handleApprovalRequested(event) {
    if (!this.config.enableApprovalAlerts) {
      return;
    }

    const detail = trimText(sanitizeUserFacingText(event.detail, this.strings.approvalDetail), 160);
    await this.notify("approval", {
      id: `approval:${event.id}`,
      title: this.strings.approvalTitle,
      detail
    });
  }

  async handleUserInputRequested(event) {
    if (!this.config.enableUserInputAlerts) {
      return;
    }

    const detail = trimText(sanitizeUserFacingText(event.detail, this.strings.userInputDetail), 160);
    await this.notify("userInput", {
      id: `user-input:${event.id}`,
      title: this.strings.userInputTitle,
      detail
    });
  }

  async notify(kind, event) {
    if (this.seenEvents.has(event.id)) {
      this.debug(`Skipped duplicate ${kind} event: ${event.id}`);
      return;
    }

    try {
      await this.seenEvents.add(event.id);
    } catch (error) {
      this.error(`Recent alert cache update failed: ${formatError(error)}`);
    }

    if (this.shouldSkipNotificationBecauseWindowIsFocused(kind, event)) {
      return;
    }

    this.logEvent(kind, event);
    await this.playSound();

    const title = sanitizeNotificationTitle(kind, event.title);
    const detail = sanitizeUserFacingText(event.detail, "");
    const message = detail ? `${title}: ${detail}` : title;
    if (this.config.useWindowsMessageBox && process.platform === "win32") {
      try {
        this.showWindowsNotification(kind, title, message);
        return;
      } catch (error) {
        this.error(`Windows notification failed, falling back to VS Code notifications: ${formatError(error)}`);
      }
    }

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

  showWindowsNotification(kind, title, message) {
    const encodedCommand = encodePowerShellCommand(buildWindowsNotificationScript());
    const env = {
      ...process.env,
      CODEX_ALERT_KIND: kind,
      CODEX_ALERT_TITLE: title,
      CODEX_ALERT_MESSAGE: message,
      CODEX_ALERT_ICON: WINDOWS_NOTIFICATION_ICONS[kind] || "Information",
      CODEX_ALERT_FLASH_TASKBAR: this.config.flashTaskbarOnAlert ? "1" : "0",
      CODEX_ALERT_PARENT_PID: String(process.pid),
      CODEX_ALERT_TIMEOUT_MS: "6000"
    };

    execFile("powershell", ["-NoProfile", "-EncodedCommand", encodedCommand], { windowsHide: true, env }, (error) => {
      if (error) {
        this.error(`Windows notification failed: ${formatError(error)}`);
      }
    });
  }

  async showDiagnostics() {
    const home = os.homedir();
    const sessionRoot = path.join(home, ".codex", "sessions");
    const lines = [
      `Completion backend: ${this.backendSummary}`,
      `Session root: ${existsSync(sessionRoot) ? sessionRoot : `${sessionRoot} (missing)`}`,
      `State DB: ${existsSync(path.join(home, ".codex", "state_5.sqlite")) ? path.join(home, ".codex", "state_5.sqlite") : `${path.join(home, ".codex", "state_5.sqlite")} (missing)`}`,
      `Logs DB: ${existsSync(path.join(home, ".codex", "logs_1.sqlite")) ? path.join(home, ".codex", "logs_1.sqlite") : `${path.join(home, ".codex", "logs_1.sqlite")} (missing)`}`,
      `Task alerts: ${this.config.enableTaskCompleteAlerts ? "on" : "off"}`,
      `Approval alerts: ${this.config.enableApprovalAlerts ? "on" : "off"}`,
      `User-input alerts: ${this.config.enableUserInputAlerts ? "on" : "off"}`,
      `Only when window inactive: ${this.config.onlyNotifyWhenWindowInactive ? "on" : "off"}`,
      `Window focused now: ${vscode.window.state.focused ? "yes" : "no"}`,
      `Windows native notification: ${this.config.useWindowsMessageBox ? "on" : "off"}`,
      `Flash taskbar: ${this.config.flashTaskbarOnAlert ? "on" : "off"}`,
      `Sound: ${this.config.enableSound ? "on" : "off"}`,
      `Sound effect: ${normalizeSoundEffect(this.config.soundEffect)}`
    ];

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine("[Diagnostics]");
    for (const line of lines) {
      this.output.appendLine(line);
    }

    await vscode.window.showInformationMessage(this.strings.diagnosticsWritten);
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
    this.startedAtMs = Date.now();
  }

  async start() {
    if (!existsSync(this.sessionRoot)) {
      this.output.appendLine(`[warn] Session root not found: ${this.sessionRoot}`);
      return;
    }

    await this.primeRecentFiles();
    this.startWatcher();
    this.startPolling();
  }

  async primeRecentFiles() {
    const files = await collectRecentJsonlFiles(this.sessionRoot, RECENT_SESSION_FILE_LIMIT);
    await Promise.all(files.map((file) => this.primeFile(file)));
    this.debug(`Primed ${files.length} recent session files.`);
  }

  async primeFile(filePath, startAtEnd = true) {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return;
      }

      this.fileState.set(filePath, {
        offset: startAtEnd ? stat.size : 0,
        remainder: ""
      });
      this.debug(`Primed ${filePath} at ${startAtEnd ? "EOF" : "start"} (${stat.size} bytes).`);
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
      this.output.appendLine(`[warn] Recursive session watch failed, using polling: ${formatError(error)}`);
    }
  }

  startPolling() {
    this.fallbackTimer = setInterval(() => {
      this.scanRecentFiles().catch((scanError) => {
        this.debug(`Session polling scan failed: ${formatError(scanError)}`);
      });
    }, SESSION_SCAN_INTERVAL_MS);
  }

  async scanRecentFiles() {
    const files = await collectRecentJsonlFiles(this.sessionRoot, RECENT_SESSION_FILE_LIMIT);
    for (const filePath of files) {
      if (!this.fileState.has(filePath)) {
        await this.primeFile(filePath, await this.shouldPrimeFromStart(filePath));
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
      await this.primeFile(filePath, await this.shouldPrimeFromStart(filePath));
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

    const toolCall = extractToolCallRecord(record);
    if (!toolCall) {
      return;
    }

    const payload = toolCall.payload;
    const eventId = payload.call_id || `${filePath}:${record.timestamp}`;
    this.debug(`Inspecting tool call ${payload.name || "unknown"} for ${eventId}.`);

    if (payload.name === "request_user_input") {
      const args = getToolCallArguments(payload.arguments);
      const detail = formatUserInputDetail(args);
      this.debug(`Matched user input request for ${eventId}.`);
      this.onUserInputRequested({
        id: eventId,
        detail
      });
      return;
    }

    const args = getToolCallArguments(payload.arguments);
    if (!args) {
      if (isApprovalCandidateToolName(payload.name)) {
        this.debug(`Skipped ${payload.name || "unknown"} for ${eventId}: parse failure.`);
      }
      return;
    }

    const approval = findApprovalRequest(args, payload.name);
    if (!approval) {
      if (isApprovalCandidateToolName(payload.name)) {
        this.debug(`Skipped ${payload.name || "unknown"} for ${eventId}: not an approval candidate.`);
      }
      return;
    }

    const detail = formatApprovalDetail(approval.toolName || payload.name, approval.args);
    this.debug(`Matched approval request for ${eventId} via ${approval.toolName || payload.name || "unknown"}.`);
    this.onApprovalRequested({
      id: eventId,
      detail
    });
  }

  debug(message) {
    if (this.debugEnabled) {
      this.output.appendLine(`[session-debug] ${message}`);
    }
  }

  async shouldPrimeFromStart(filePath) {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return false;
      }

      const createdAtMs = Number(stat.birthtimeMs) || 0;
      const modifiedAtMs = Number(stat.mtimeMs) || 0;
      const referenceTime = createdAtMs > 0 ? createdAtMs : modifiedAtMs;
      const recentlyCreated = referenceTime >= (this.startedAtMs - SESSION_NEW_FILE_GRACE_MS);
      const smallEnoughToReplay = stat.size <= SESSION_NEW_FILE_MAX_START_BYTES;
      const primeFromStart = recentlyCreated && smallEnoughToReplay;
      this.debug(
        `Discovered ${filePath} (created ${new Date(createdAtMs || referenceTime).toISOString()}, `
        + `modified ${new Date(modifiedAtMs || referenceTime).toISOString()}, `
        + `size ${stat.size}); priming at ${primeFromStart ? "start" : "EOF"}.`
      );
      return primeFromStart;
    } catch (error) {
      this.debug(`Failed to inspect ${filePath} before priming: ${formatError(error)}. Defaulting to EOF.`);
      return false;
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
      this.debug(`Matched task_complete log row ${row.id} from ${row.target || "unknown"}.`);
      this.onTaskComplete({ id: row.id });
      return;
    }

    if (isResponseCompletedLogMessage(message)) {
      this.debug(`Matched response.completed row ${row.id} from ${row.target || "unknown"}.`);
      this.onTaskComplete({ id: row.id });
      return;
    }

    if (this.debugEnabled && message.includes("task_complete")) {
      this.debug(`Observed task_complete-like row ${row.id} but did not match exactly: ${trimText(message, 160)}`);
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
  constructor(storage, storageKey) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.values = new Map();
    this.persistPromise = Promise.resolve();
  }

  async initialize() {
    const entries = this.storage.get(this.storageKey, []);
    this.values.clear();

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry.key !== "string") {
          continue;
        }

        const timestamp = Number(entry.timestamp) || 0;
        if (timestamp > 0) {
          this.values.set(entry.key, timestamp);
        }
      }
    }

    this.cleanup();
    await this.persist();
  }

  async add(key) {
    this.cleanup();
    this.values.set(key, Date.now());
    this.trimToLimit();
    await this.persist();
  }

  has(key) {
    this.cleanup();
    return this.values.has(key);
  }

  async clear() {
    this.values.clear();
    await this.persist();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamp] of this.values.entries()) {
      if (now - timestamp > TOOL_EVENT_TTL_MS) {
        this.values.delete(key);
      }
    }
    this.trimToLimit();
  }

  trimToLimit() {
    if (this.values.size <= TOOL_EVENT_CACHE_LIMIT) {
      return;
    }

    const entries = [...this.values.entries()].sort((left, right) => left[1] - right[1]);
    const overflow = entries.length - TOOL_EVENT_CACHE_LIMIT;
    for (let index = 0; index < overflow; index += 1) {
      this.values.delete(entries[index][0]);
    }
  }

  async persist() {
    this.persistPromise = this.persistPromise
      .catch(() => undefined)
      .then(async () => {
        const entries = [...this.values.entries()]
          .sort((left, right) => left[1] - right[1])
          .map(([key, timestamp]) => ({ key, timestamp }));
        await this.storage.update(this.storageKey, entries);
      });
    await this.persistPromise;
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
    useWindowsMessageBox: config.get("useWindowsMessageBox", true),
    flashTaskbarOnAlert: config.get("flashTaskbarOnAlert", true),
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
  if (value && typeof value === "object") {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractToolCallRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const payload = record.payload;
  if (payload && typeof payload === "object" && payload.type === "function_call") {
    return { payload };
  }

  if (record.type === "function_call") {
    return {
      payload: {
        name: record.name,
        arguments: record.arguments,
        call_id: record.call_id
      }
    };
  }

  if (payload && typeof payload === "object" && typeof payload.name === "string" && Object.prototype.hasOwnProperty.call(payload, "arguments")) {
    return { payload };
  }

  return null;
}

function getToolCallArguments(value) {
  return parseNestedJson(value);
}

function isApprovalCandidateToolName(name) {
  if (typeof name !== "string" || !name) {
    return false;
  }

  return name === "shell_command"
    || name === "multi_tool_use.parallel"
    || name === "parallel"
    || name.endsWith(".shell_command")
    || name.endsWith(".parallel");
}

function findApprovalRequest(value, toolName) {
  return findApprovalRequestRecursive(value, normalizeToolName(toolName));
}

function findApprovalRequestRecursive(value, toolName) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findApprovalRequestRecursive(entry, toolName);
      if (match) {
        return match;
      }
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const currentToolName = deriveToolName(toolName, value);
  if (value.sandbox_permissions === "require_escalated") {
    return {
      toolName: currentToolName,
      args: value
    };
  }

  if (currentToolName === "shell_command" && isApprovalLikeShellCommand(value)) {
    return {
      toolName: currentToolName,
      args: value
    };
  }

  for (const entry of Object.values(value)) {
    const match = findApprovalRequestRecursive(entry, currentToolName);
    if (match) {
      return match;
    }
  }

  return null;
}

function deriveToolName(currentToolName, value) {
  if (!value || typeof value !== "object") {
    return currentToolName;
  }

  if (typeof value.recipient_name === "string" && value.recipient_name.trim()) {
    return normalizeToolName(value.recipient_name);
  }

  if (typeof value.name === "string" && value.name.trim()) {
    return normalizeToolName(value.name);
  }

  return currentToolName;
}

function normalizeToolName(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const trimmed = value.trim();
  const parts = trimmed.split(".");
  return parts[parts.length - 1];
}

function isApprovalLikeShellCommand(args) {
  if (!args || typeof args !== "object") {
    return false;
  }

  if (typeof args.command !== "string" || !args.command.trim()) {
    return false;
  }

  return isLikelyApprovalPromptCommand(args.command);
}

function isLikelyApprovalPromptCommand(command) {
  const value = command.trim();
  if (!value) {
    return false;
  }

  return APPROVAL_LIKE_COMMAND_PATTERNS.some((pattern) => pattern.test(value));
}

function formatApprovalDetail(toolName, args) {
  if (typeof args.justification === "string" && args.justification.trim()) {
    return sanitizeUserFacingText(args.justification.trim(), "");
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

  const detail = parts.length > 0 ? parts.join(" - ") : "Codex asked for input.";
  return sanitizeUserFacingText(detail, "Codex asked for input.");
}

function isResponseCompletedLogMessage(message) {
  if (typeof message !== "string" || !message) {
    return false;
  }

  return message.includes('"type":"response.completed"')
    || message.includes('"type": "response.completed"')
    || message.includes("websocket event: {\"type\":\"response.completed\"");
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

function createRuntimeStrings() {
  if (!isChineseUiLanguage()) {
    return {
      taskCompletedTitle: "Codex task completed",
      taskCompletedDetail: "The current Codex run reported completion.",
      approvalTitle: "Codex needs approval",
      approvalDetail: "Codex wants approval for an elevated command.",
      userInputTitle: "Codex needs input",
      userInputDetail: "Codex asked for input.",
      manualTestDetail: "Manual test notification.",
      watchersRestarted: "Codex Alerts watchers restarted.",
      diagnosticsWritten: "Codex Alerts diagnostics written to the output channel."
    };
  }

  return {
    taskCompletedTitle: "Codex 任务已完成",
    taskCompletedDetail: "当前 Codex 任务已报告完成。",
    approvalTitle: "Codex 等待授权",
    approvalDetail: "Codex 正在等待你授权高权限命令。",
    userInputTitle: "Codex 等待输入",
    userInputDetail: "Codex 正在等待你的输入。",
    manualTestDetail: "这是一条手动测试提醒。",
    watchersRestarted: "Codex Alerts 监听器已重启。",
    diagnosticsWritten: "Codex Alerts 诊断信息已写入输出通道。"
  };
}

function isChineseUiLanguage() {
  const language = String(vscode.env.language || "").toLowerCase();
  return language === "zh-cn" || language === "zh-hans" || language === "zh" || language.startsWith("zh-");
}

function sanitizeUserFacingText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return fallback;
  }

  return isLikelyMojibake(text) ? fallback : text;
}

function sanitizeNotificationTitle(kind, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || isLikelyMojibake(text)) {
    return getFallbackNotificationTitle(kind);
  }

  return text;
}

function getFallbackNotificationTitle(kind) {
  if (!isChineseUiLanguage()) {
    if (kind === "approval") {
      return "Codex needs approval";
    }
    if (kind === "userInput") {
      return "Codex needs input";
    }
    return "Codex task completed";
  }

  if (kind === "approval") {
    return "Codex 等待授权";
  }
  if (kind === "userInput") {
    return "Codex 等待输入";
  }
  return "Codex 任务已完成";
}

function isLikelyMojibake(value) {
  if (typeof value !== "string" || !value) {
    return false;
  }

  if (value.includes("\uFFFD")) {
    return true;
  }

  const matches = value.match(/[锛銆鏈€鎴浣鍙璇鋒彁閱诲脊绐楁甯稿彲鐢ㄦ椂浼氱殑涓€]/g);
  return Array.isArray(matches) && matches.length >= 3;
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

function buildWindowsNotificationScript() {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexAlertsNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public UInt32 cbSize;
    public IntPtr hwnd;
    public UInt32 dwFlags;
    public UInt32 uCount;
    public UInt32 dwTimeout;
  }

  [DllImport("user32.dll")]
  public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
}
"@

function Get-ParentProcessId([int]$Pid) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $Pid" -ErrorAction Stop
    return [int]$process.ParentProcessId
  } catch {
    return 0
  }
}

function Get-WindowHandleFromProcessTree([int]$Pid) {
  $visited = New-Object 'System.Collections.Generic.HashSet[int]'
  $currentPid = $Pid
  while ($currentPid -gt 0 -and -not $visited.Contains($currentPid)) {
    $null = $visited.Add($currentPid)
    try {
      $process = Get-Process -Id $currentPid -ErrorAction Stop
      if ($process.MainWindowHandle -ne 0) {
        return $process.MainWindowHandle
      }
    } catch {
    }

    $currentPid = Get-ParentProcessId $currentPid
  }

  return [IntPtr]::Zero
}

if ($env:CODEX_ALERT_FLASH_TASKBAR -eq "1") {
  $handle = Get-WindowHandleFromProcessTree([int]$env:CODEX_ALERT_PARENT_PID)
  if ($handle -ne [IntPtr]::Zero) {
    $flash = New-Object CodexAlertsNative+FLASHWINFO
    $flash.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][CodexAlertsNative+FLASHWINFO])
    $flash.hwnd = $handle
    $flash.dwFlags = 14
    $flash.uCount = 5
    $flash.dwTimeout = 0
    [CodexAlertsNative]::FlashWindowEx([ref]$flash) | Out-Null
  }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Visible = $true
$notifyIcon.BalloonTipTitle = $env:CODEX_ALERT_TITLE
$notifyIcon.BalloonTipText = $env:CODEX_ALERT_MESSAGE
$notifyIcon.Text = [string]::Concat("Codex Alerts - ", $env:CODEX_ALERT_KIND)

switch ($env:CODEX_ALERT_ICON) {
  "Warning" {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
    $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
  }
  default {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
    $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  }
}

$timeoutMs = 6000
if ([int]::TryParse($env:CODEX_ALERT_TIMEOUT_MS, [ref]$timeoutMs) -eq $false) {
  $timeoutMs = 6000
}

$notifyIcon.ShowBalloonTip($timeoutMs)
Start-Sleep -Milliseconds ([Math]::Max($timeoutMs, 3000))
$notifyIcon.Dispose()
`;
}

function encodePowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function selectPreferredCodexLogDbs(home) {
  const logsDbPath = path.join(home, ".codex", "logs_1.sqlite");
  const stateDbPath = path.join(home, ".codex", "state_5.sqlite");

  if (existsSync(logsDbPath)) {
    return [logsDbPath];
  }

  if (existsSync(stateDbPath)) {
    return [stateDbPath];
  }

  return [logsDbPath];
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
