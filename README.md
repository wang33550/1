[![CI](https://github.com/wang33550/1/actions/workflows/ci.yml/badge.svg)](https://github.com/wang33550/1/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

# Task Recovery Runtime

`Task Recovery Runtime`（`trr`）是一个面向终端 Coding Agent 的任务恢复层。  
它的目标不是“总结整段历史”，而是把当前任务真正需要继续执行的状态保存下来，在上下文压缩、会话重建、宿主重启之后，尽量让模型无缝接着做，而不是重新读取、重新测试、重新执行危险命令。

当前版本：`0.1.2`

## 这个项目解决什么问题

当 `Codex`、`Claude Code` 或其他终端 Agent 触发自动压缩时，常见问题是：

- 忘记当前 `next_action`
- 忘记刚刚已经跑过的测试和命令结果
- 重复读取同一段文件
- 重复执行 `git push`、`git commit`、`rm`、`curl` 之类高风险操作
- 在压缩后回到旧任务，导致 token 和时间都被浪费

`trr` 的思路是：

- 在本地持续记录任务状态
- 周期性编译 checkpoint
- 在需要恢复时只注入“当前任务必需状态”
- 对危险重复 side effect 做硬拦截
- 对重复测试、重复读取等做软提醒

## 当前产品形态

`v1` 的产品边界已经锁定：

- 只做终端 Coding Agent
- 首发宿主：`codex`、`claude`、`generic-pty`
- 官方支持环境：`Linux`、`macOS`、`Windows + WSL2`
- 不做浏览器聊天框接管
- 不做桌面 GUI
- 不做浏览器插件

当前状态是：`开发者预览版 / 可内测`

这意味着：

- 已经可以克隆仓库、安装、运行、试用
- 已经有完整测试、smoke、checkpoint、resume、guard 链路
- 但仍需要更多真实长会话样本来验证不同宿主版本和环境差异

## 宿主策略

不同宿主的集成面不一样，所以 `trr` 不是“一套猜测逻辑打天下”。

### Claude

- 优先走官方 hooks
- 使用 `PreCompact`、`PostCompact`、`SessionStart(source=compact)`、`PreToolUse`、`PostToolUse`
- 恢复状态通过官方 `additionalContext` 注入

### Codex

- 使用公开的启动 / 工具 / 停止 hooks
- 再结合本地 `.codex/sessions/*.jsonl` 的 token telemetry
- 因为目前没有公开的 compaction hook，所以仍保留 wrapper + guard + 恢复包兜底

### generic-pty

- 最低保真兜底
- 只依赖 PTY 包装、输出检测、checkpoint 和 guard

## 5 分钟上手

首次安装：

```bash
git clone https://github.com/wang33550/1.git
cd 1
npm install
npm run build
npm link
trr doctor
trr setup
trr smoke --format markdown
```

然后重开一个终端。

之后的日常使用应当尽量简单：

```bash
cd /你的项目
claude
```

或：

```bash
cd /你的项目
codex
```

## 现在的用户使用路径

当前已经做到：

### 1. 机器级只需要做一次 shell 集成

`trr setup` 或 `trr install-shell` 完成后，后续直接运行 `claude` / `codex` 即可。

### 2. 工作区第一次启动时自动补齐本地接入

当你在某个项目里第一次运行 `claude` 或 `codex` 时，`trr` 会自动：

- 创建 `trr.config.json`
- 安装缺失的 Claude 工作区 hooks
- 安装缺失的 Codex hooks

也就是说，用户不需要再手工执行：

- `trr config init`
- `trr install-claude-hooks`
- `trr install-codex-hooks`

这些命令仍然保留，但现在主要用于显式控制和排障。

## 推荐命令

常用主路径：

```bash
trr doctor
trr setup
claude
```

或：

```bash
trr doctor
trr setup
codex
```

单终端临时激活，不修改 rc：

```bash
source <(trr env --shell bash)
claude
```

查看最近会话：

```bash
trr sessions
```

手工打印某个会话的恢复包：

```bash
trr resume <session-id> --host claude
```

导出最近会话的脱敏反馈包：

```bash
trr export-feedback --last
```

导出并打印到标准输出：

```bash
trr export-feedback --last --stdout
```

导出指定会话且保留原文：

```bash
trr export-feedback <session-id> --no-redact
```

## `export-feedback` 是做什么的

这条命令是为了后续真实环境迭代准备的。

它会把当前或指定会话导出成一个反馈包，默认写入：

```text
.trr/feedback/
```

反馈包包含：

- 会话基础信息
- 最新 checkpoint
- 当前 resume packet
- 关键事件时间线
- guard 拦截与告警记录
- 最近 artifacts
- 人工标签和备注

默认会做：

- 工作区路径脱敏
- 家目录路径脱敏
- 常见 API key / Bearer token / 长 hex 串脱敏

适合用来：

- 给仓库维护者回传失败样本
- 做不同宿主版本的对比
- 记录“恢复成功 / 失败”的真实案例

## 恢复包里有什么

恢复包不会回放完整历史，而是聚焦“继续当前任务真正需要的内容”：

- `goal`
- `phase`
- `next_action`
- `current_plan`
- `done`
- `open_items`
- `verified_facts`
- `artifacts`
- `do_not_repeat`
- `blocked_actions`
- `recent_side_effects`
- `workspace_state`
- 最近 frontier

当前限制：

- 它已经能保留命令摘要、exit code、测试结果和工作区状态
- 但还不会默认附带每条命令的完整原始 stdout/stderr
- 所以对“需要精确长日志上下文”的场景，后续还要继续增强 artifact 保存

## Guard 行为

### v1 硬拦截

- 重复 `git push`
- 重复 `git commit`
- 重复 `rm`
- 重复 `mv`
- 重复 `cp`
- 重复 `curl`
- 重复 `wget`
- 配置里自定义的危险命令前缀

### v1 软提醒

- 重复测试命令
- 重复构建命令
- 重复读取同一文件片段
- 重复运行相同安全命令

当检测到“可能是压缩后状态漂移导致的重复执行”时，`trr` 不只会拦截，还会把恢复包重新回灌给模型，帮助它继续当前任务。

## 当前有哪些验证

仓库里已经具备：

- 单元测试
- wrapper / hooks / guard 集成测试
- 本地 smoke
- 真实 Codex hook 调用验证
- 本地 trace harvest / corpus eval

你可以直接运行：

```bash
npm test
trr smoke --format markdown
```

## 目前还差什么

距离“可以大规模公开宣传稳定可用”还差：

- 更多真实 `Codex` 长会话自动压缩样本
- 更多真实 `Claude` 长会话自动压缩样本
- 更多不同平台 / shell / 宿主版本的数据
- 更高保真的长日志 artifact 保存能力

所以当前更准确的定位是：

`可以开源给开发者试用，但仍应持续收集真实反馈包做迭代。`

## 配置文件

工作区根目录下的 `trr.config.json` 主要字段：

- `defaultHost`
- `workspaceRoot`
- `storePath`
- `hostProfiles`
- `guardPolicy`
- `resumePolicy`
- `redactionPolicy`

默认 store：

```text
.trr/trr-store.json
```

## 重要文件

运行后常见文件：

- `.trr/trr-store.json`
- `.trr/shims/*`
- `.trr/shell/*`
- `.trr/feedback/*`
- `trr.config.json`
- `.claude/settings.local.json`

## 文档

- [CLI 使用说明](docs/CLI.md)
- [最终就绪度清单](docs/FINAL_READINESS.md)
- [宿主研究结论](docs/OFFICIAL_HOST_RESEARCH.md)
- [真实宿主 smoke 指南](docs/HOST_SMOKE.md)
- [发布说明](docs/releases/v0.1.2.md)

## 对外使用时建议说明

如果你准备把项目公开给其他开发者，建议在仓库首页明确写：

- 当前是 `0.1.2` 开发者预览版
- Claude 路径优先使用官方 hooks
- Codex 路径当前仍包含 telemetry / wrapper fallback
- 欢迎用 `trr export-feedback --last` 回传真实失败样本

## 许可证

MIT
