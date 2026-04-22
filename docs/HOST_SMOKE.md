# 真实宿主 Smoke 指南

这份文档用于回答：

- 当前如何在真实 `claude` / `codex` 上做最小可行验收
- 跑 smoke 时应该观察哪些结果
- 出现失败时优先看哪里

## 目标

Smoke 不是为了证明“所有情况都稳定”，而是为了验证主链路是通的：

- 宿主能正常启动
- `trr` 能记录会话
- checkpoint 能生成
- 恢复包能构建
- guard 能在执行路径上生效

## 预备条件

先在本机完成：

```bash
npm install
npm run build
npm link
trr doctor
trr setup
```

如果只想临时在当前终端激活：

```bash
source <(trr env --shell bash)
```

## Claude smoke

进入一个测试项目目录后：

```bash
claude
```

在会话里给一个明确的小任务，例如：

- 读取一个文件
- 生成一个两步计划
- 运行一次安全测试命令

验收点：

1. `trr sessions` 能看到新会话，`host` 为 `claude`
2. `.claude/settings.local.json` 中存在 `trr hook claude`
3. `.trr/trr-store.json` 中能看到：
   - `host_event`
   - `plan_update`
   - `command_exec`
   - `checkpoint_created`
4. `trr resume <session-id> --host claude` 能输出恢复包

如果你能制造一次真实压缩，则继续观察：

- 是否出现 `compaction_detected`
- 是否有 `resume_injected`
- 压缩后模型是否继续当前 `next_action`

## Codex smoke

进入测试项目目录后：

```bash
codex
```

同样给一个小任务：

- 读取文件
- 建计划
- 跑一次只读或安全测试命令

验收点：

1. `trr sessions` 能看到新会话，`host` 为 `codex`
2. `CODEX_HOME/hooks.json` 中存在 `trr hook codex`
3. `CODEX_HOME/config.toml` 中开启了 `codex_hooks = true`
4. `.trr/trr-store.json` 中能看到：
   - `host_event`
   - `tool_call`
   - `command_exec`
   - `checkpoint_created`

如果触发了真实上下文压力，还要继续看：

- `.codex/sessions/*.jsonl` 是否出现 token telemetry
- `trr` 是否据此记录 `compaction_detected`
- 漂移式重复执行出现时，是否发生 `resume_injected` 或 guard 提示

## 快速检查命令

列出最近会话：

```bash
trr sessions
```

查看最新恢复包：

```bash
trr resume <session-id> --host claude
trr resume <session-id> --host codex
```

导出反馈包：

```bash
trr export-feedback --last
```

## 通过标准

一次最小 smoke 成功，至少要满足：

- 宿主成功启动
- 会话被记录
- checkpoint 被创建
- resume packet 可以生成
- 至少一条命令执行被记录

如果是压缩相关 smoke，则额外要求：

- 出现压缩 / 漂移信号后，模型没有回到旧任务
- `next_action` 能被恢复出来
- 危险重复命令不会被静默再次执行

## 常见失败点

### 1. 宿主没有经过 `trr`

表现：

- `trr sessions` 没有新会话
- `.trr/trr-store.json` 没变化

优先检查：

- shell integration 是否生效
- 当前终端是否重开过
- `which claude` / `which codex` 是否走到了包装后的函数

### 2. Claude hooks 没装进工作区

表现：

- Claude 正常运行，但 `trr` 没收到 hook 事件

优先检查：

- 当前项目是否存在 `.claude/settings.local.json`
- 文件里是否包含 `trr hook claude`

### 3. Codex hooks 没装进 `CODEX_HOME`

表现：

- Codex 能用，但没有 hook 记录

优先检查：

- `CODEX_HOME/hooks.json`
- `CODEX_HOME/config.toml`
- 是否启用了 `codex_hooks = true`

### 4. 恢复包能生成，但没有重新锚定模型

这类问题最值得回传反馈包：

```bash
trr export-feedback --last --label failure --notes "压缩后继续回到旧任务"
```

## 建议的最小人工验收任务

可以固定用下面这类任务做真实 smoke：

1. 让模型读取一个文件并写两步计划
2. 让模型跑一个测试命令
3. 让模型修改一个小文件
4. 尝试制造一次上下文压力或长会话
5. 观察压缩后是否继续当前计划，而不是回头重做

## 结论

`HOST_SMOKE` 的目的不是证明“已经完全稳定”，而是帮你快速判断：

`当前这台机器、这个宿主、这个工作区，主链路到底有没有真正接通。`
