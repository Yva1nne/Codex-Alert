# Codex Alerts

[![Release](https://img.shields.io/badge/Release-v0.0.11-0969da?style=for-the-badge&logo=github)](https://github.com/Yva1nne/Codex-Alert/releases/tag/v0.0.11)
[![Download VSIX](https://img.shields.io/badge/Download-VSIX-2ea44f?style=for-the-badge&logo=visualstudiocode)](https://github.com/Yva1nne/Codex-Alert/releases/download/v0.0.11/local.codex-alerts-0.0.11.vsix)

[English](#english) | [简体中文](#zh-cn) | [Standalone 中文版](README.zh-CN.md) | [Changelog](CHANGELOG.md)

<a id="english"></a>
## English

Codex Alerts is a lightweight VS Code companion extension that watches local Codex activity and reminds you when attention is needed.

It is designed for a local Codex workflow on Windows and can notify you when:

- a Codex task finishes
- Codex requests elevated command approval
- Codex asks for user input

You can also:

- only notify when the VS Code window is not focused
- show native Windows tray notifications near the taskbar
- flash the VS Code taskbar button when an alert arrives
- choose between the built-in beep and Windows system sounds
- keep task-complete polling independent from approval and input monitoring

### What's New in v0.0.11

- Fixed the replay bug that could resend previously delivered approval or user-input alerts in bursts.
- Persisted recent alert IDs across watcher restarts and tightened session-file replay rules for historical JSONL files.
- Added optional Windows tray notifications and taskbar flashing.
- Improved task-complete detection across more Codex log targets.

### Install the VSIX

1. Download the latest `.vsix` file from the [Releases page](https://github.com/Yva1nne/Codex-Alert/releases).
2. In VS Code, open the Extensions view.
3. Open the `...` menu in the top-right corner.
4. Choose `Install from VSIX...`.
5. Select the downloaded `local.codex-alerts-*.vsix` file.
6. Reload VS Code if prompted.

After installation, open Settings and search for `Codex Alerts` to adjust notification and sound behavior.

### How It Works

This extension does not modify the official ChatGPT/Codex extension. Instead, it watches local Codex data sources:

- `~/.codex/logs_1.sqlite`
  - preferred source for task-complete detection
- `~/.codex/state_5.sqlite`
  - fallback source for task-complete detection
- `~/.codex/sessions/**/*.jsonl`
  - used to detect elevated command approval requests
  - used to detect `request_user_input` tool calls

### Requirements

Task completion alerts require access to the Codex SQLite log database. The extension prefers `~/.codex/logs_1.sqlite` and falls back to `~/.codex/state_5.sqlite`, then automatically tries these backends in order:

1. `python`
2. `py -3`
3. `sqlite3`

If none of them are available:

- task-complete alerts will be unavailable
- approval and user-input alerts will still work through session JSONL monitoring

If Python or `sqlite3` is not on your `PATH`, configure one of these settings:

- `codexAlerts.pythonPath`
- `codexAlerts.sqlite3Path`

### Settings

The extension settings are localized and follow your VS Code display language.

- `codexAlerts.enableTaskCompleteAlerts`
- `codexAlerts.enableApprovalAlerts`
- `codexAlerts.enableUserInputAlerts`
- `codexAlerts.onlyNotifyWhenWindowInactive`
- `codexAlerts.useWindowsMessageBox`
- `codexAlerts.flashTaskbarOnAlert`
- `codexAlerts.enableSound`
- `codexAlerts.soundEffect`
- `codexAlerts.soundFrequencyHz`
- `codexAlerts.soundDurationMs`
- `codexAlerts.pollIntervalMs`
- `codexAlerts.pythonPath`
- `codexAlerts.sqlite3Path`
- `codexAlerts.debugLogging`

### Commands

Available from the Command Palette:

- `Codex Alerts: Test Task Notification`
- `Codex Alerts: Test Approval Notification`
- `Codex Alerts: Test User Input Notification`
- `Codex Alerts: Show Diagnostics`
- `Codex Alerts: Restart Watchers`

### Notes

- On Windows, sound playback uses PowerShell.
- Native tray notifications can appear near the taskbar instead of inside VS Code.
- The `beep` sound effect uses `Console.Beep`.
- The other sound options use Windows system sounds.
- This is a companion extension and does not patch the official Codex extension.

---

<a id="zh-cn"></a>
## 简体中文

Codex Alerts 是一个轻量的 VS Code 配套扩展，用来监听本地 Codex 活动，并在需要你关注时发出提醒。

它主要面向 Windows 下的本地 Codex 工作流，可以在这些场景提醒你：

- Codex 任务完成
- Codex 请求高权限命令审批
- Codex 请求用户输入

你还可以：

- 只在 VS Code 窗口非激活时提醒
- 使用 Windows 原生托盘通知，在任务栏附近弹出提醒
- 在提醒到达时闪烁 VS Code 任务栏按钮
- 在内置 `beep` 和 Windows 系统音之间切换
- 让任务完成轮询与审批、输入监听独立工作

### v0.0.11 更新

- 修复了审批提醒和用户输入提醒会把历史消息重新批量补发的问题。
- 将最近提醒事件做成跨 watcher 重启的持久化去重，并收紧历史 session JSONL 的回放条件。
- 新增可选的 Windows 原生托盘通知和任务栏闪烁。
- 扩大了任务完成检测覆盖的 Codex 日志来源。

### 安装 VSIX

1. 从 [Releases 页面](https://github.com/Yva1nne/Codex-Alert/releases) 下载最新的 `.vsix` 文件。
2. 在 VS Code 中打开扩展视图。
3. 点击右上角的 `...` 菜单。
4. 选择 `从 VSIX 安装...`。
5. 选中下载好的 `local.codex-alerts-*.vsix` 文件。
6. 如果 VS Code 提示，执行重载。

安装完成后，可以在设置中搜索 `Codex Alerts`，调整提醒和音效行为。

### 工作原理

这个扩展不会修改官方 ChatGPT/Codex 扩展，而是监听本地 Codex 数据源：

- `~/.codex/logs_1.sqlite`
  - 任务完成检测的首选数据源
- `~/.codex/state_5.sqlite`
  - 任务完成检测的回退数据源
- `~/.codex/sessions/**/*.jsonl`
  - 用于检测高权限命令审批请求
  - 用于检测 `request_user_input` 工具调用

### 依赖要求

任务完成提醒需要能读取 Codex 的 SQLite 日志库。扩展会优先读取 `~/.codex/logs_1.sqlite`，回退到 `~/.codex/state_5.sqlite`，并按下面顺序自动尝试后端：

1. `python`
2. `py -3`
3. `sqlite3`

如果三者都不可用：

- 任务完成提醒将不可用
- 审批提醒和用户输入提醒仍然可以通过 session JSONL 继续工作

如果 Python 或 `sqlite3` 不在 `PATH` 中，可以配置：

- `codexAlerts.pythonPath`
- `codexAlerts.sqlite3Path`

### 设置

扩展设置说明会跟随 VS Code 的显示语言自动切换。

- `codexAlerts.enableTaskCompleteAlerts`
- `codexAlerts.enableApprovalAlerts`
- `codexAlerts.enableUserInputAlerts`
- `codexAlerts.onlyNotifyWhenWindowInactive`
- `codexAlerts.useWindowsMessageBox`
- `codexAlerts.flashTaskbarOnAlert`
- `codexAlerts.enableSound`
- `codexAlerts.soundEffect`
- `codexAlerts.soundFrequencyHz`
- `codexAlerts.soundDurationMs`
- `codexAlerts.pollIntervalMs`
- `codexAlerts.pythonPath`
- `codexAlerts.sqlite3Path`
- `codexAlerts.debugLogging`

### 命令

可在命令面板中使用：

- `Codex Alerts: Test Task Notification`
- `Codex Alerts: Test Approval Notification`
- `Codex Alerts: Test User Input Notification`
- `Codex Alerts: Show Diagnostics`
- `Codex Alerts: Restart Watchers`

### 说明

- Windows 下声音通过 PowerShell 播放。
- 原生托盘通知可以在任务栏附近弹出，而不是显示在 VS Code 内部。
- `beep` 音效使用 `Console.Beep`。
- 其他音效选项使用 Windows 系统音。
- 这是一个 companion extension，不会修改官方 Codex 扩展。
