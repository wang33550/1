# CLI 使用说明

所有命令都支持全局参数：

```bash
trr --db /path/to/store.json ...
```

如果不显式传入 `--db`，默认使用当前工作区配置里的 store。

## 推荐主路径

绝大多数用户现在应该这样使用：

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

完成一次 shell 集成之后，后续日常使用直接 `cd 项目 && claude` / `cd 项目 && codex` 即可。

首次进入某个工作区时，`wrap` 会自动补齐：

- `trr.config.json`
- Claude 工作区 hooks
- Codex hooks

## 环境初始化

初始化默认配置：

```bash
trr config init
```

打印当前终端激活脚本：

```bash
trr env --shell bash
source <(trr env --shell bash)
```

持久安装 shell 集成：

```bash
trr install-shell
trr install-shell --shell zsh
trr install-shell --shell powershell
```

显式安装 Claude hooks：

```bash
trr install-claude-hooks
```

显式安装 Codex hooks：

```bash
trr install-codex-hooks
trr install-codex-hooks --codex-home /custom/.codex
```

一键完成常见初始化：

```bash
trr setup
trr setup --skip-shell
trr setup --skip-codex-hooks
trr setup --skip-claude-hooks
```

## 诊断与会话

检查当前工作区、宿主命令、store、shim、shell 集成和工作区快照：

```bash
trr doctor
```

列出最近会话：

```bash
trr sessions
```

手工创建会话：

```bash
trr session create --provider custom --model codex --host codex --workspace "$(pwd)"
```

列出所有会话：

```bash
trr session list
```

## 启动宿主

直接包装启动：

```bash
trr wrap codex
trr wrap claude
trr wrap generic-pty -- node ./scripts/fake-agent.js
```

覆盖工作区根目录：

```bash
trr wrap --workspace-root /path/to/project claude
```

## 恢复相关

输出宿主封装后的恢复包：

```bash
trr resume <session-id> --host claude
trr resume <session-id> --host codex
```

只构造原始恢复包正文：

```bash
trr resume build --session <session-id>
trr resume build --session <session-id> --exclude-latest-user
```

## 反馈包导出

导出当前工作区最新会话：

```bash
trr export-feedback
trr export-feedback --last
```

按宿主过滤最新会话：

```bash
trr export-feedback --host claude
trr export-feedback --host codex
```

导出指定会话：

```bash
trr export-feedback <session-id>
```

常用参数：

```bash
trr export-feedback --last --stdout
trr export-feedback --last --label failure --notes "压缩后回到了旧任务"
trr export-feedback --last --out ./feedback.json
trr export-feedback --last --event-limit 120 --artifact-limit 30
trr export-feedback --last --no-redact
```

默认行为：

- 默认导出当前工作区最新会话
- 默认启用路径和常见密钥脱敏
- 默认写入 `.trr/feedback/`
- 可选附加人工标签和备注

## 事件与 checkpoint

添加简单文本事件：

```bash
trr event add --session <id> --kind user_message --text "修复恢复逻辑"
```

添加结构化事件：

```bash
trr event add \
  --session <id> \
  --kind plan_update \
  --payload-json '{"items":[{"id":"inspect","text":"检查 guard 逻辑","status":"done"}]}'
```

查看事件：

```bash
trr event list --session <id>
trr event list --session <id> --from 10 --to 30
```

创建 checkpoint：

```bash
trr checkpoint create --session <id>
trr checkpoint create --session <id> --force
```

查看最新 checkpoint：

```bash
trr checkpoint show --session <id>
```

## Guard

检查某个动作是否会被判定为重复：

```bash
trr guard check \
  --session <id> \
  --action-json '{"actionType":"command_exec","command":"git push origin main","sideEffect":true}'
```

## Trace

标准化 Codex 归档会话：

```bash
trr trace normalize-codex --file /path/to/rollout.jsonl --out .tmp/codex-trace.json
```

标准化 Claude 会话：

```bash
trr trace normalize-claude --session <session-id> --out .tmp/claude-trace.json
```

采集本地 traces：

```bash
trr trace harvest-local --out-dir .tmp/harvested-traces
```

导入 trace：

```bash
trr trace import --file examples/trace-import.json
```

回放 trace：

```bash
trr trace replay --file examples/trace-import.json --format markdown
```

实时回放：

```bash
trr trace live-replay \
  --file examples/trace-import.json \
  --provider openai \
  --model gpt-5.3-codex \
  --format markdown
```

## Eval

运行内置 benchmark：

```bash
trr eval run --dataset benchmarks/recovery-benchmark.json --format markdown
```

运行 harvested corpus：

```bash
trr eval corpus --dir .tmp/harvested-traces --format markdown
trr eval corpus --dir .tmp/harvested-traces --host codex,claude
```

## Hook 命令

这些命令通常由宿主 hook 自动调用，不需要用户手动执行：

```bash
trr hook claude < hook-payload.json
trr hook codex < hook-payload.json
```

## Smoke

运行内置本地 smoke：

```bash
trr smoke
trr smoke --format markdown
```

## Provider 调试

通过 provider adapter 发送一轮文本：

```bash
trr turn send \
  --session <id> \
  --user-input "继续当前任务" \
  --provider openai \
  --model gpt-5.3-codex
```

## 说明

- `Codex` 路径目前仍包含 wrapper / telemetry fallback，因为公开文档中还没有正式 compaction hook。
- `Claude` 路径优先使用官方 hooks。
- `export-feedback` 适合把真实失败样本打包出来，用于后续迭代。
