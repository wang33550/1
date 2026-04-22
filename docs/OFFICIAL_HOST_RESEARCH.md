# 官方宿主研究结论

这份文档记录项目在 `Claude` 与 `Codex` 上的公开集成面研究结果，用来回答：

- 哪些能力来自官方文档
- 哪些能力仍然属于本地可观察信号或工程兜底
- 为什么当前架构不能只靠“猜输出文案”

## 结论先行

### Claude

`Claude Code` 已经提供了官方 hooks，因此 Claude 路径应当以官方 hooks 为主，而不是依赖终端输出猜测。

当前最关键的官方集成面：

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PreCompact`
- `PostCompact`

这意味着：

- `Claude` 有正式的压缩生命周期信号
- `trr` 可以在压缩前后记录状态
- `trr` 可以在 compact session start 时通过 `additionalContext` 注入恢复包

### Codex

当前公开可依赖的能力主要是：

- 会话启动相关 hooks
- 工具调用相关 hooks
- 停止相关 hooks

但目前没有公开、稳定、明确记录的“compaction lifecycle hook”。

所以 `Codex` 路径只能采用：

- 官方 hooks
- 本地 transcript telemetry
- wrapper fallback
- repeat guard

的组合方案，而不能声称“官方已经完整支持压缩恢复”。

## 为什么不能只靠终端文案

项目早期一个直觉是：

> 看宿主有没有输出“正在压缩上下文”之类文案，然后触发恢复

研究后确认，这个思路不够稳，原因有三类：

1. 某些宿主会直接压缩或重建，不一定给稳定文案  
2. 文案会随版本、渠道、中转封装而变化  
3. 即使出现文案，时机也可能晚于真正需要 checkpoint / 注入恢复包的节点

因此：

- `Claude` 应优先使用官方 compact hooks
- `Codex` 应优先使用官方 hooks + transcript telemetry
- PTY 输出匹配只能作为兜底，而不是主依据

## Claude 的架构结论

Claude 路径当前采用：

- 官方 `PreCompact` / `PostCompact` 记录压缩节点
- `SessionStart(source=compact)` 恢复会话时注入 `additionalContext`
- `PreToolUse` / `PostToolUse` 记录命令执行与 guard 决策

这个路径的优点是：

- 官方支持
- 结构化事件更稳定
- 不依赖宿主 UI 文案

项目中的对应实现：

- [src/claude-hooks.ts](/mnt/c/Users/HP/Desktop/上下文压缩/src/claude-hooks.ts)

## Codex 的架构结论

Codex 路径当前采用：

- 官方启动 / 工具 / 停止 hooks
- 本地 `.codex/sessions/*.jsonl` 与归档会话中的 token telemetry
- 当 token 占用从高位明显跌落时，视为“隐藏压缩或会话重建”的强信号
- wrapper / guard 作为兜底层，处理未暴露正式压缩事件的情况

这个路径的优点：

- 比纯输出文案匹配更稳
- 可以利用本地 transcript 里的结构化 token 统计

这个路径的缺点：

- 仍然不是完整官方 compaction API
- 需要更多真实版本样本去校准阈值

项目中的对应实现：

- [src/codex-hooks.ts](/mnt/c/Users/HP/Desktop/上下文压缩/src/codex-hooks.ts)

## 本地 telemetry 的意义

在真实本地验证里，已经确认 `.codex/sessions/**/*.jsonl` 与 `.codex/archived_sessions/*.jsonl` 会出现 token 统计事件，包含类似：

- `model_context_window`
- `last_token_usage`

这说明：

- 本地 transcript 是有价值的旁路信号
- 可以用来辅助判断上下文占用是否突然下跌

但仍需要强调：

`这不是公开文档层面的 compaction API。`

所以它应该被视为：

`Codex 路径的工程增强信号，而不是官方保证的稳定接口。`

## 现在的设计为什么合理

研究之后，当前项目架构变成：

### Claude

官方 hooks 主导：

- 压缩前记录
- 压缩后恢复
- 工具执行 guard

### Codex

混合策略：

- 官方 hooks 收集启动 / 工具 / 停止事件
- telemetry 检测隐藏压缩漂移
- wrapper + guard 兜底

### generic-pty

最低保真兜底：

- 不假设官方事件
- 只依赖 PTY、checkpoint、guard、恢复包

## 当前仍然未知或未完全稳定的部分

- `Codex` 未来是否会公开正式 compaction hook
- 不同 Codex 版本的 token telemetry 结构是否完全一致
- 某些第三方 provider / wrapper 是否会影响可观察信号

这也是为什么仓库里仍然需要：

- 真实宿主 smoke
- 真实长会话反馈包
- 更多跨平台样本

## 参考来源

Claude 方向研究主要参考官方文档：

- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [How Claude Code Works](https://code.claude.com/docs/en/how-claude-code-works)
- [Context Window](https://code.claude.com/docs/en/context-window)

Codex 方向的公开文档层能力较少，因此项目主要依赖：

- 公开 hooks 能力
- 本地 transcript 结构观察
- 真实宿主验证

## 最终判断

这份研究直接决定了项目的产品化路线：

- `Claude`：优先官方 hooks
- `Codex`：官方 hooks + telemetry + wrapper fallback
- 不再把“猜终端文案”当成核心策略
