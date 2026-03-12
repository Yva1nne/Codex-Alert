# Codex Alerts

[![Release](https://img.shields.io/badge/Release-v0.0.3-0969da?style=for-the-badge&logo=github)](https://github.com/Yva1nne/Codex-Alert/releases/tag/v0.0.3)
[![下载 VSIX](https://img.shields.io/badge/下载-VSIX-2ea44f?style=for-the-badge&logo=visualstudiocode)](https://github.com/Yva1nne/Codex-Alert/releases/download/v0.0.3/local.codex-alerts-0.0.3.vsix)

[English](README.md#english) | [README 内嵌双语版](README.md#zh-cn)

Codex Alerts 是一个轻量的 VS Code 配套扩展，用来监听本地 Codex 活动，并在需要你关注时发出提醒。

它主要面向 Windows 下的本地 Codex 工作流，可以在这些场景提醒你：

- Codex 任务完成
- Codex 请求高权限命令审批
- Codex 请求用户输入

你还可以：

- 只在 VS Code 窗口非激活时提醒
- 在内置 `beep` 和 Windows 系统音之间切换
- 让任务完成轮询与审批、输入监听独立工作

## 工作原理

这个扩展不会修改官方 ChatGPT/Codex 扩展，而是监听本地 Codex 数据源：

- `~/.codex/state_5.sqlite`
  - 用于检测 `codex/event/task_complete`
- `~/.codex/sessions/**/*.jsonl`
  - 用于检测高权限命令审批请求
  - 用于检测 `request_user_input` 工具调用

## 依赖要求

任务完成提醒需要能读取 Codex 的 SQLite 状态库。扩展会按下面顺序自动尝试后端：

1. `python`
2. `py -3`
3. `sqlite3`

如果三者都不可用：

- 任务完成提醒将不可用
- 审批提醒和用户输入提醒仍然可以通过 session JSONL 继续工作

如果 Python 或 `sqlite3` 不在 `PATH` 中，可以配置：

- `codexAlerts.pythonPath`
- `codexAlerts.sqlite3Path`

## 设置

扩展设置说明会跟随 VS Code 的显示语言自动切换。

- `codexAlerts.enableTaskCompleteAlerts`
- `codexAlerts.enableApprovalAlerts`
- `codexAlerts.enableUserInputAlerts`
- `codexAlerts.onlyNotifyWhenWindowInactive`
- `codexAlerts.enableSound`
- `codexAlerts.soundEffect`
- `codexAlerts.soundFrequencyHz`
- `codexAlerts.soundDurationMs`
- `codexAlerts.pollIntervalMs`
- `codexAlerts.pythonPath`
- `codexAlerts.sqlite3Path`
- `codexAlerts.debugLogging`

## 命令

可在命令面板中使用：

- `Codex Alerts: Test Task Notification`
- `Codex Alerts: Test Approval Notification`
- `Codex Alerts: Test User Input Notification`
- `Codex Alerts: Show Diagnostics`
- `Codex Alerts: Restart Watchers`

## 本地开发

1. 在 VS Code 中打开 `codex-alerts` 文件夹。
2. 按 `F5`。
3. 在新的 Extension Development Host 中运行 Codex。
4. 使用测试命令确认弹窗和音效是否正常。

## 打包

运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build_vsix.ps1
```

生成的安装包会写入 `dist/` 目录。

如果你更想用 Python，原来的打包脚本也还保留：

```powershell
python .\scripts\build_vsix.py
```

## 说明

- Windows 下声音通过 PowerShell 播放。
- `beep` 音效使用 `Console.Beep`。
- 其他音效选项使用 Windows 系统音。
- 这是一个 companion extension，不会修改官方 Codex 扩展。
