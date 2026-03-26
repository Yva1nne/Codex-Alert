# Changelog

## v0.0.11 - 2026-03-26

### English

- Fixed the replay issue that could resend historical approval and user-input alerts in bursts.
- Persisted recent alert IDs across watcher restarts and tightened session JSONL replay rules for older files.
- Added optional Windows tray notifications and taskbar flashing.
- Improved task-complete detection across `logs_1.sqlite`, `state_5.sqlite`, and broader Codex log targets.
- Cleaned up release metadata and packaging for GitHub distribution.

### 简体中文

- 修复了历史审批提醒和用户输入提醒可能被集中重复发送的问题。
- 将最近提醒事件做成跨 watcher 重启的持久化去重，并收紧了旧 session JSONL 文件的回放规则。
- 新增可选的 Windows 原生托盘通知和任务栏闪烁能力。
- 增强了 `logs_1.sqlite`、`state_5.sqlite` 及更多 Codex 日志来源上的任务完成检测。
- 补齐了 GitHub 发布所需的元数据和打包整理。

## v0.0.3 - Previous GitHub release

### English

- Initial public GitHub release of Codex Alerts.

### 简体中文

- Codex Alerts 的首个 GitHub 公开发布版本。
