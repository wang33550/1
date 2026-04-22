# 最终就绪度清单

这份文档回答两个问题：

1. 当前仓库距离“别人可以稳定使用并确实解决实际问题”还差什么  
2. 哪些部分已经从原型进入了产品化状态

## 当前目标使用方式

目标用户体验已经收敛为：

1. 用户机器上只需完成一次安装
2. 之后进入项目目录直接运行 `claude` 或 `codex`
3. `trr` 在后台自动记录状态、创建 checkpoint、检测恢复时机
4. 当发生压缩、会话重建、漂移式重复执行时，自动注入恢复包并尽量阻止危险重复 side effect

理想形态：

```bash
trr setup
```

然后：

```bash
cd /你的项目
claude
```

或：

```bash
cd /你的项目
codex
```

## 已完成

### 核心运行时

- [x] 本地 store
- [x] checkpoint compiler
- [x] frontier builder
- [x] repeat guard
- [x] resume packet builder
- [x] workspace snapshot
- [x] restart handling
- [x] resume de-duplication

### 产品化接入层

- [x] `trr wrap <host>`
- [x] shell integration
- [x] Codex hooks
- [x] Claude hooks
- [x] `trr setup`
- [x] `trr doctor`
- [x] `trr sessions`
- [x] `trr resume`
- [x] `trr smoke`

### 自动化 bootstrap

- [x] 首次进入工作区时自动创建 `trr.config.json`
- [x] 首次运行 `claude` 时自动补齐当前工作区 hooks
- [x] 首次运行 `codex` 时自动补齐 `CODEX_HOME` hooks

### 防重复执行

- [x] 重复危险 side effect 硬拦截
- [x] 重复测试 / 读取 / 安全命令软提醒
- [x] block / warn 时把恢复包回灌给模型，而不是只输出“已阻止”

### 反馈闭环

- [x] `trr export-feedback`
- [x] 默认导出当前工作区最新会话
- [x] 默认脱敏工作区路径、家目录路径和常见密钥
- [x] 反馈包中包含 checkpoint、resume packet、时间线、guard、artifacts、人工标签与备注

### 验证

- [x] 单元测试
- [x] wrapper 集成测试
- [x] Codex hooks 测试
- [x] Claude hooks 测试
- [x] `npm test`
- [x] `trr smoke`
- [x] 本地真实 Codex hook 调用验证

## 还没完成

### P0：真实长会话样本仍然不够

- [ ] 更多真实 `Codex` 自动压缩案例
- [ ] 更多真实 `Claude` 自动压缩案例
- [ ] 更多不同平台 / shell / 宿主版本样本

为什么这仍然是最高优先级：

- `Claude` 有官方 compact hooks，但仍需要真实长会话验证稳定性
- `Codex` 目前仍有一部分依赖 telemetry / wrapper fallback，需要更多真实样本校准

### P1：更高保真的结果保存

- [ ] 为高价值命令输出保存更完整的 artifact
- [ ] 对长日志做“摘要 + 文件落盘 + hash + 路径引用”
- [ ] 让恢复包在必要时能引用完整原始输出，而不仅仅是摘要和 exit code

### P1：分发层

- [ ] 发布到 npm
- [ ] 收集更多社区宿主 / shell 预设

## 现在是否能给别人使用

可以，但定位应当准确：

- 可以开源
- 可以给技术用户内测
- 可以让开发者克隆后试用
- 还不适合大规模宣传成“已经彻底稳定解决所有压缩问题”

更准确的说法是：

`0.1.2 开发者预览版，已具备真实试用价值，但仍需要更多真实反馈包继续迭代。`

## 当前验收标准

如果要判断“是否稳定到足以交给早期用户”，至少要满足：

- README 从零到首次运行不超过 10 分钟
- `trr setup` 之后，用户可以直接 `claude` / `codex`
- 工作区首次运行时能自动 bootstrap
- 自动压缩或漂移后能保住 `next_action`
- 重复 `git push` / `git commit` / `rm` 类命令会被拦截
- 重复测试 / 读取会产生恢复上下文提醒
- `npm test` 与 `trr smoke` 均通过
- 用户能通过 `trr export-feedback --last` 导出真实失败样本

## 结论

当前仓库已经不是“概念原型”，而是：

`一个可以开始给真实开发者试用，并通过反馈包持续迭代的早期产品。`
