# 10 Control Plane 控制面

> 状态：草案｜对应 PRD `03-architecture.md` §8、决策 D19 / D20

## 目标

把「壳 ↔ 服务 ↔ Agent 实例（worker）」的连接、实例生命周期与消息路由收敛为一个独立模块。

- **服务**是唯一控制面：管实例、转消息、持有注册表与共享状态。
- **worker** 是数据面：跑 Runtime 主循环、上下文装配、模型调用、工具编排。
- **壳**是页面执行的唯一源头：spawn Chrome、持有 CDP、把语义指令落成输入事件（D20）。

v1 本地部署、单用户、无账号体系。设计上按**可跨机**约束（不共享内存 / 文件句柄 / 本地 socket 路径，只走 HTTP/WS 与 stdio），部署上默认同机。

## 范围

**做**：

- 实例注册表与生命周期：`ensure` / `create` / `start` / `stop` / `destroy` / `resume`
- worker 托管：spawn、stdio JSON-RPC 通道、退出与崩溃处理、`trace_id` 注入
- 消息路由：壳上行指令 → 目标 worker；worker 下行事件流 / tool call → 壳
- 设备身份：`device_id` 生成与持久化、`local.secret` 共享密钥
- 租约与回收：心跳、失联标记、僵尸实例清理
- 配额：每 worker 内存与并发 turn 上限
- 事件序号与断线补偿（`seq`）

**不做**：

- 不做业务决策（Runtime 主循环在 worker，见 `02-runtime`）
- 不做页面执行（在壳，见 `03-architecture` §3）
- 不做账号 / 多租户 / RBAC（v1 非目标）
- 不重复实现存储与调度逻辑（复用 Session 与内核能力）

## 关键设计点（草案）

- **`ensure` 是唯一入口**：壳启动只发 `POST /instances:ensure { profile }`，服务端在**一个锁内原子完成**「查 → 启动 → 登记」。壳不持有 `worker_id`——不缓存、不持久化，每次连接重新 `ensure`。
- **父进程托管（v1）**：服务 spawn worker，经 stdio JSON-RPC 通信。父进程退出即管道断开，天然无孤儿进程。代价是服务重启会中断 worker——但会话已落盘，壳 `ensure` 可 `resume`。
- **detach 列为 v1.1**：改为独立进程 + named pipe（`\\.\pipe\harness-<workerId>`），服务降为 supervisor，重启后重连。需额外处理孤儿、重复启动与重连竞态。
- **`stop` ≠ `destroy`**：`stop` 保留磁盘可 `resume`；`destroy` 删数据。无账号体系时误 `destroy` 等于永久丢失。
- **身份与硬件解耦**：`device_id` 由服务生成，存 `~/.harness/device.json`（**跨 profile 共享**、不进 SQLite、不进 git）；`mac_hints` / `hostname_hint` 仅作展示与"疑似同一台"提示，不参与匹配。
- **持久层单库、单写入者**：任务 / 线程事件流 / 提醒 / 审计 / 记忆同在一份 SQLite（带 `profile_id` 列），库随服务；**worker 不落盘**，会话事件经服务写入。理由：到点提醒、`paused` 回访、日终复盘、全量导出都是跨任务的时间维度查询，单库一条 SQL 即可；分库会让这些逻辑退化成"遍历所有库"。串行执行 + 单写入者，因此 SQLite 的单写者限制不构成瓶颈。
- **服务单实例化**：`~/.harness/harness.lock`。两个进程各自生成 `device_id` 会让注册表分叉。
- **信封而非透明转发**：消息带 `worker_id / msg_id / reply_to / seq / trace_id`。纯字节转发做不到审计、背压与断线补发。
- **多客户端只读订阅、写入串行**：所有连接可收事件流；只有持有当前 turn 的客户端能发用户消息；`interrupt` 需显式请求，不默认"新连接即抢占"。

## 技术栈（已定）

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.x（strict） | 与壳（Electron）、worker 同栈，契约可共享 |
| 运行时 | **Node 22 LTS（ESM）** | Electron 内置固定 Node 版本，统一运行时避免三套心智 |
| HTTP / WS | Fastify + `@fastify/websocket` | 本地场景足够；schema 校验与插件生态成熟 |
| 校验 / 契约 | Zod 定义，导出 JSON Schema | 跨进程契约的唯一来源 |
| 存储（共享，单库） | better-sqlite3（WAL + FTS5），带 `profile_id` 列 | 单库 + 服务单写入者（worker 不落盘）；收敛到 `ISessionStore` / `ITaskStore` 后可换实现 |
| 服务 ↔ worker | **stdio JSON-RPC** | 不占端口、无鉴权问题、与 MCP 同构；父进程退出即断连 |
| 调度 | 轮询 + SQLite 表；cron 表达式用 `croner` | 单用户量级，不需要队列中间件 |
| 日志 | pino，`trace_id` 贯穿壳 / 服务 / worker | 与内核一致 |
| 测试 | Vitest | 与内核一致 |
| 打包 | Node 运行时；Bun 仅用于 `bun build --compile`（可选） | Bun 不进生产进程 |
| 开机自启 | Windows 任务计划（onlogon） | 比安装 Windows Service 少一层权限成本 |

## 对外接口（草案）

```text
IControlPlane  # ensure(profile) / stop(id) / destroy(id) / list()
IWorkerHost    # spawn(profile) / attach(id) / rpc(id, method, params) / on_event(id)
IWorker        # run_turn(msg) / interrupt() / snapshot() / shutdown()
ILease         # renew(worker_id) / expire() / on_expired
IEnvelope      # { worker_id, msg_id, reply_to?, seq, type, payload, trace_id }
```

## 依赖

- 内核（Container / EventBus / Logger）
- Session（会话持久化，供 `resume`）
- Security（审计、密钥、配额判定）
- Interface（壳接入的实际承载，见 `09-interface`）

## 待定问题

- 配额具体数值：每 worker 内存上限、并发 turn 数。
- 断线补发窗口策略：保留多少条 `seq`，超窗口后是否强制快照重放。
- 多壳同时写同一 worker 时的排队策略（拒绝 / 排队 / 抢占需显式化）。
- worker 反复启动失败时的退避策略：何时停止重试并转 `crashed`。
- 「服务」与「worker 宿主」是否拆成两个进程（独立 supervisor），待 detach 落地时一并评估。
