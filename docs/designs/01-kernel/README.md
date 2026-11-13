# 01 Kernel 微内核

> 状态：草案 v0.1｜对应概要设计 §3、§5；决策 D19 / D20；M1 工作流 W0
> 语言与运行时：TypeScript 5.x（strict）+ Node 22 LTS（ESM）

## 0. 本次修订

骨架 → 草案。补齐五类基础服务的接口语义、生命周期、失败模式与 bootstrap 时序；修正上一版遗留的 Python 表述（`asyncio`）；明确 M1 只落地最小子集。

## 1. 定位与边界

内核只提供 Agent 运行所需的**最小基础设施**，本身不含任何业务能力。模型、工具、技能、会话、记忆、沙箱、存储、主循环、UI 全部以插件形式挂载。

三条不可越过的边界：

| 边界 | 含义 |
|---|---|
| **能力不进内核** | 内核不 import 任何业务模块；新增能力一律走插件 |
| **信任根不进插件** | Security Core、Plugin Host 权威、Config 权威、Audit 属 TCB，常驻不可卸载 |
| **数据面不驱动控制面** | 模型只能"请求"动作；挂载/卸载、改策略、改配置永不是模型可调用的工具 |

## 2. 分层与依赖方向

```
        apps: shell / cli / tui / web
                    │  只依赖 contracts
        ┌───────────▼───────────┐
        │  runtime / session /  │   业务模块（插件）
        │  memory / tools / ... │
        └───────────┬───────────┘
                    │  只依赖 5 个接口
        ┌───────────▼───────────┐
        │       kernel          │   Container / EventBus / Config / Logger / Profile
        └───────────────────────┘
```

规则（写死）：

1. 依赖只能**向上**，内核不反向依赖任何模块。
2. 模块之间**只经接口与事件**通信，禁止直接 import 对方实现。
3. 跨进程契约一律走 `packages/contracts`（Zod → JSON Schema），禁止共享运行时对象。

## 3. 五类基础服务

### 3.1 IContainer（依赖注入）

不用装饰器、不用 `emitDecoratorMetadata`——编译器配置与打包链会变复杂，收益不匹配。用**显式 token**：

```ts
export const ITaskService = defineService<ITaskService>('task-service'); // 返回带类型的 token
container.provide(ITaskService, () => new SqliteTaskService(...));
const svc = container.get(ITaskService); // 类型自动推导
```

| 语义 | 决定 |
|---|---|
| 生命周期 | **M1 只有 singleton + 懒解析**；transient / scoped 不做（用不到就别写） |
| 循环依赖 | 解析栈检测，命中即抛 `CircularDependencyError`，**不提供延迟注入兜底**——延迟注入会把结构问题藏起来 |
| 覆盖 | **仅在装配期**（TCB 冻结前）允许；运行期覆盖直接抛错，与 `08-security` §3.8「不接受运行期热切换」一致 |
| 覆盖留痕 | 每次覆盖记 `{token, from, to, at}` 进审计，否则"谁把安全实现换掉了"事后无从追查 |
| 释放 | `dispose()` 按初始化的**逆序**执行，单个失败不阻断其余 |

### 3.2 IEventBus（事件总线）

**信封**（所有事件统一）：

```ts
interface Event<T = unknown> {
  id: string;            // ULID，单调可排序
  type: string;          // 'task.status_changed'
  at: number;            // epoch ms
  traceId: string;
  threadId?: string;
  workerId?: string;
  payload: T;            // Zod schema 定义，见 packages/contracts
}
```

分发语义（写死）：

1. **串行**：同一事件的订阅者按注册顺序依次执行，`publish` 返回 Promise。并发分发会让状态机类事件产生竞态。
2. **隔离**：单个 handler 抛错只记录、不中断其余 handler，也不回滚已执行的 handler。
3. **不落盘**：事件持久化是 Session 的职责。EventBus 一旦兼任存储，就会变成隐形的第二真相源。
4. **不承载 token 流**：模型输出的逐字流走流式通道（`IStream`），不进 EventBus。否则每秒数百条事件会冲垮订阅者。
5. **跨进程预留**：接口全异步 + 信封 schema 化，M2 接 worker 时同一套语义迁到 stdio / WS，不改调用方。

主题命名：`<domain>.<noun>.<verb>`，如 `task.created`、`run.progress`、`approval.requested`。禁止无 domain 前缀的事件。

### 3.3 IConfig（分层配置）

| 项 | 决定 |
|---|---|
| 分层顺序 | `default → user → project → env → CLI`，后者覆盖前者 |
| 校验 | 合并后用 **Zod** 全量校验一次；校验失败即启动失败（fail-fast，不带着半个配置跑） |
| 只读 | 解析完成后**冻结**；运行期修改需重启（TCB 冻结原则） |
| 密钥 | **不进 config**。密钥走 `ISecretStore`（`08-security`），config 只存引用 |
| profile | profile 不是配置项，是**上下文**（见 3.5） |

### 3.4 ILogger（日志与追踪）

- 结构化 JSON，输出 **pino**；开发态走 `pino-pretty`，生产态落 `~/.harness/logs/`（按日轮转）
- 每个 logger 带上下文：`traceId` / `threadId` / `workerId`，由 `logger.child(ctx)` 派生
- **脱敏**：字段名黑名单（`token` / `secret` / `password` / `authorization` / `apiKey`）自动替换为 `***`；不做"事后过滤"，在序列化前拦截
- 事件总线与工具调用的每次分发写一条 debug 级日志，保证"谁在什么时候收到了什么"可回溯

### 3.5 IProfile（新增，取代散落的路径拼接）

上一轮定的"1 进程 = 1 profile"需要一个**唯一入口**，否则 `~/.harness` 路径会散落在十几个模块里。

```ts
interface IProfile {
  id: string;                 // 'default' / 'work'
  root: string;               // ~/.harness/profiles/<id>
  paths: {
    db: string;               // <root>/harness.db
    logs: string;             // <root>/logs
    skills: string;           // <root>/skills
    browser: string;          // <root>/browser   （Chrome --user-data-dir）
    workspace: string;        // 当前工作空间根
  };
}
```

约束：

- 所有模块取路径**只能**经 `IProfile.paths`，禁止自行拼 `~/.harness/...`
- `device_id` 属机器级，不进 profile（`~/.harness/device.json`，见 `10-control-plane`）
- 启动时校验进程内 profile 唯一，第二次绑定直接报错

## 4. IPluginHost（权威在内核，实现在 07）

内核只持有**权威**，发现与解析逻辑归 `07-plugin`：

| 职责 | 归属 |
|---|---|
| 谁可以 `mount` / `unmount`（控制面判定） | **内核 TCB** |
| 保护清单校验（`isProtected`） | **内核 TCB** |
| 插件发现、版本与依赖解析、拓扑排序 | `07-plugin` |
| 生命周期 hooks 调用 | 内核驱动，07 提供实现 |

M1 不做动态发现：内置插件按**静态数组**顺序装配，`mount` 只接受控制面调用。动态发现与热插拔推迟到 M2。

## 5. Bootstrap 时序

```
1. Security Core 先于一切（TCB 引导，不可跳过）
2. Config：分层合并 + Zod 校验（fail-fast）
3. Logger：按 profile 建输出（此后所有步骤可观测）
4. Container：建实例，注册五类基础服务
5. Profile：确定 profile id 与 paths（进程内唯一）
6. EventBus：启动分发循环
7. PluginHost：装配插件（M1 静态数组，M2 发现 + 拓扑排序）
8. 各插件注册服务、订阅事件
9. **TCB 冻结**：保护清单锁定，运行期不可变
10. Runtime 就绪 → Interface 启动（CLI / TUI / Web / 壳）
```

失败即 fail-closed：任一步骤抛错，整体退出，不做"部分可用"。

## 6. 对外接口（定稿版）

```ts
// container
defineService<T>(name: string): ServiceToken<T>
IContainer {
  provide<T>(token: ServiceToken<T>, factory: (c: IContainer) => T): void
  get<T>(token: ServiceToken<T>): T
  has(token: ServiceToken<unknown>): boolean
  override<T>(token: ServiceToken<T>, factory: Factory<T>): void   // 仅装配期
  dispose(): Promise<void>
}

// event bus
IEventBus {
  publish<T>(type: string, payload: T, ctx?: Partial<Omit<Event,'id'|'type'|'at'|'payload'>>): Promise<void>
  subscribe<T>(type: string, handler: (e: Event<T>) => void | Promise<void>): Unsubscribe
  once<T>(type: string, handler: (e: Event<T>) => void | Promise<void>): Unsubscribe
}

// config
IConfig {
  get<T>(path: string): T
  snapshot(): Readonly<Record<string, unknown>>
}

// logger
ILogger {
  child(ctx: { traceId?: string; threadId?: string; workerId?: string }): ILogger
  debug/info/warn/error(msg: string, fields?: Record<string, unknown>): void
}

// profile
IProfile { id: string; root: string; paths: ProfilePaths }
```

## 7. 目录结构

```
packages/kernel/src/
├── container/    # token、注册表、解析栈、dispose
├── events/       # 信封、分发、订阅表
├── config/       # 分层合并、Zod 校验、冻结
├── logger/       # pino 封装、脱敏、child
├── profile/      # profile 解析与路径派生
├── plugins/      # IPluginHost 权威（发现逻辑在 07）
└── index.ts      # 唯一导出入口
```

## 8. M1 范围（W0）

| 能力 | M1 | 后续 |
|---|---|---|
| Container（singleton + 懒解析 + 循环检测 + 装配期覆盖） | 做 | scoped / transient |
| EventBus（串行分发 + 隔离 + 信封） | 做 | 跨进程分发、采样 |
| Config（分层 + Zod + 冻结） | 做 | 运行期热更（不做，需重启） |
| Logger（pino + context + 脱敏） | 做 | OpenTelemetry 导出 |
| Profile（路径派生 + 唯一性校验） | 做 | 多 profile 并行（不做） |
| PluginHost（静态装配 + 保护清单） | 最小版 | 动态发现、热插拔、签名校验 |

## 9. 失败模式（写死，便于测试）

| 场景 | 行为 |
|---|---|
| 循环依赖 | 抛 `CircularDependencyError`，列出完整依赖链 |
| 同名 token 重复 provide（未 override） | 启动失败，提示用 `override` 显式覆盖 |
| 运行期调用 `override` | 抛错并记审计 |
| Config 校验失败 | 启动失败，打印违规路径与期望类型 |
| 插件声明依赖缺失 | 启动失败，列出缺失项（不降级跳过） |
| 卸载保护清单内插件 | 直接 `deny`，不进入审批（`08-security` §3.4） |
| handler 抛错 | 记录 `event.type` + `handler` 标识，其余 handler 继续 |

## 10. 测试要点

- 容器：循环依赖报错文案含完整链；`dispose` 逆序；覆盖留痕
- 事件：订阅顺序稳定；单 handler 抛错不影响其余；`publish` 在 handler 全部完成前不 resolve
- 配置：五层合并优先级；非法值 fail-fast；冻结后写入抛错
- 日志：密钥字段被替换为 `***`（用固定词表逐项断言）
- Profile：两个 profile 同时绑定同一进程 → 报错

## 11. 待定问题

- 事件总线的可观测性粒度（是否每个事件都落盘、采样策略）——当前结论是**不落盘**，持久化归 Session，但审计类事件是否需要例外由 `08-security` 定。
- 插件热重载是否纳入 M2（当前倾向不纳入，重启成本低）。
- 跨进程事件总线（M2 双进程）是否需要独立的 message broker，还是直接复用 stdio JSON-RPC 信封。
- `07-plugin` 的 manifest 仍是 `plugin.toml` + Python 风格 `register(ctx)`，需改为 TS 形态（`plugin.json` + 导出的 `register` 函数），与本模块的接口对齐——**待 07 设计时一并处理**。
