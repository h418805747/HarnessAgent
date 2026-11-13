# 09 Interface 交互层

> 状态：骨架｜对应概要设计 §7

## 目标

统一所有人类与外部系统的接入方式，将其归一化为内部 Message/Event 契约，并把 Runtime 的输出渲染回去。交互层本身也是可替换插件。

## 范围

**做**：
- CLI REPL（`ha`）
- TUI（`ha --tui`）
- Web UI（`ha web`，聊天 + 轨迹视图）
- IDE 集成（ACP / MCP Server）
- IM Gateway（多平台常驻守护）
- Headless / 批处理（`ha run`、batch、cron）
- 编程式 SDK（HTTP/JSON-RPC + TS/Python 客户端）
- 人机协作机制：审批、中断/接管、澄清提问、计划审阅、diff 预览、轨迹检视、会话控制

**不做**：
- 不实现 Agent 逻辑（委托 Runtime）
- 不做持久化（委托 Session）

## 关键设计点（草案）

- **统一契约**：所有接入形态共享同一套 Message/Event，UI 只做适配与渲染。
- **流式输出**：基于事件的流式渲染（SSE/WebSocket/ANSI）。
- **审批 UI 统一**：Security 的 `IApproval` 在各前端有一致交互。
- **Slash 命令注册表**：中心命令注册表驱动 CLI 分发、Gateway 菜单、自动补全、帮助文本（借鉴 Hermes）。
- **UI 可插拔**：CLI/TUI/Web/Gateway 各自为插件，按需启用。
- **壳 ↔ 服务**：壳只发 `ensure(profile)`、不持有身份；`device_id` 由服务生成持有，`worker_id` 每次 `ensure` 取得不缓存。v1 无账号、无配对，协议与生命周期见 `../../prd/03-architecture.md` §8。
- **壳的两个维度**：① 对话（一任务一线程，产物条目内联）；② **工作空间**（真实本地文件夹 + 文件树，产物直接落在该目录，改动文件在树中标记）。任务列表只显示名称与创建时间，点击进入对话。
- **「待我处理」只装会打断的事**：**命令审核模块判为需审批的命令**、澄清提问、阻断（登录墙 / 预算超限）。**不弹模态**，只做状态栏计数 + 托盘徽标。v1 不做 git 关联与逐行 diff（放第二版本）。

## 对外接口（草案）

```text
IInterface    # start() / stop() / send(message) / on_event(event)
IMessage      # {source, session_key, content, attachments, meta}
IApprovalUI   # prompt(approval_request) -> Approval
CommandRegistry  # register(name, handler, help) / resolve(name)
```

## 依赖

- 内核、Runtime（会话驱动）、Security（审批）、Session（轨迹视图）

## 待定问题

- 壳 ↔ 服务协议细节：信封结构、断线补偿（事件 `seq`）、多订阅者的读写权限（方向已定，见 `../../prd/03-architecture.md` §8.6）。
- Web UI 是否独立仓库/独立发布节奏。
- TUI 与 Web 的轨迹视图交互一致性。
- IM Gateway 的常驻进程模型（单进程多适配器 vs 每适配器一进程）。
