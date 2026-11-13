# 07 Plugin 插件

> 状态：骨架｜对应概要设计 §2.1、§5.1、§8.1

## 目标

定义插件契约与装载机制，使内核保持极薄、能力全部可插拔，并保证用户定制可覆盖内置实现。

## 范围

**做**：
- 插件清单（manifest）格式与校验
- 插件发现（bundled / user / project / pip entry-points）
- 版本与依赖解析、加载顺序（拓扑排序）
- 生命周期 Hooks
- 打包与分发规范

**不做**：
- 不实现具体能力（那是各模块/插件的事）

## 关键设计点（草案）

- **优先级**：`project > user > bundled`，同名插件上层覆盖下层，且无需修改内核。
- **来源目录**：
  - bundled：`<repo>/plugins/<name>/`
  - user：`~/.harness/plugins/<name>/`
  - project：`./.harness/plugins/<name>/`
  - pip：`harness_agent.plugins` entry-point 组
- **插件结构**：目录含 manifest（如 `plugin.toml`）+ 入口模块暴露 `register(ctx)`。
- **能力注册**：`ctx.register_tool(...)` / `ctx.register_service(...)` / `ctx.subscribe(...)` / `ctx.invoke_hook(...)`。
- **Hooks**：`on_agent_start/stop`、`on_before_tool_call/after_tool_call`、`on_message_received/sent`、`on_session_start/end`。
- **依赖解析**：按声明的依赖拓扑排序挂载，支持卸载与依赖清理。

### 接入通道与执行链（补充）

**结论：不是 Spring MVC 式的"每个请求拼一条全局拦截器链"**，而是"微内核 + 事件驱动 + 三条固定管线"。插件有四个接入通道：

| 通道 | 机制 | 时机 | 能否阻断 |
|---|---|---|---|
| **Service / DI** | `ctx.register_service(token, impl)`，消费方 `container.get(token)` | 装配期 | 否；覆盖仅装配期允许 |
| **Event** | `ctx.subscribe(type, handler)`，`publish` 串行分发 | 运行期 | 否；单个 handler 抛错只记录，不中断其余 |
| **Tool** | `ctx.register_tool(...)` 进工具注册表 | 装配期 | 否；执行时由 Security 闸口决定 |
| **Hook** | `on_agent_start/stop`、`on_before/after_tool_call`、`on_message_received/sent`、`on_session_start/end` | 指定管线点 | 取决于 Hook 类型（见下） |

**与 Spring Boot 的对照**：

| Spring Boot | HarnessAgent |
|---|---|
| `@Bean` / DI 容器 | `Container.provide` / `get`（显式 token，无装饰器） |
| AutoConfiguration | PluginHost 发现 + manifest + 依赖拓扑排序 |
| `ApplicationEvent` | EventBus（串行、隔离、不落盘） |
| `HandlerInterceptor` | Hook，但**只存在于明确管线点，不是全局链** |
| Servlet `Filter` | Interface 适配层：把各入口归一化为 Message/Event |
| AOP 代理 | **不用**；模块间只经接口与事件通信 |

**真正的执行链只存在于三条固定管线**，插件只能往槽里注册阶段，不能自己决定排到谁前面：

```
工具调用管线：schema 校验 → Security.check → 审批 → 执行（沙箱）→ 审计 → on_after_tool_call
模型调用管线：Context Providers 装配 → 请求守卫 → Model Adapter → 输出守卫 → 事件落盘
消息进入管线：Interface 归一化 → on_message_received → Runtime.run_turn
```

**Hook 契约（建议写死）**：

| 类型 | 能力 | 失败语义 | 例子 |
|---|---|---|---|
| **Observer** | 只观察，不能改结果 | 异常隔离，不影响主流程 | 审计、指标、日志 |
| **Interceptor** | 可校验 / 改写 / 短路 | 必须声明失败时 allow 还是 deny；安全相关一律 deny | `on_before_tool_call` 的安全钩子 |

**顺序规则（写死）**：`manifest.priority` → 依赖拓扑 → 注册顺序，三者一致才确定；禁止"后注册先执行"这类隐式覆盖。安全判定不走 Hook，走 `ISecurityCore` 的 provider 链（见 `08-security` §3.10）。

> 待统一：本文仍写 `plugin.toml` + Python 风格 `register(ctx)`，而 `01-kernel` 已定 TS 形态（`plugin.json` + 导出的 `register` 函数），需在 07 详细设计中一并收敛。

### 插件权限分层（评审补充，重要）

"插件化"不等于"所有插件都可随意装卸"。每个插件在 manifest 中声明三个权限位：

| 权限位 | 含义 | 默认值 |
|---|---|---|
| `replaceable` | 实现可被上层覆盖替换 | `true` |
| `removable` | 运行期可卸载 | `true` |
| `agent_manageable` | 可被 Agent（模型）经控制面工具管理 | **`false`** |

- **TCB 插件**（Kernel 内建、Security Core、Plugin Host 权威、Config 权威、Audit）`removable=false`，进入**保护清单（Protected Set）**，卸载请求直接 `deny`。
- **任何插件**默认为 `agent_manageable=false`：插件管理不是模型可调用的工具。
- 即便 Creator 模式启用插件管理，也只能管理 `agent_manageable=true` 的**非 TCB 插件**，且需人类审批。

### 控制面权威（Control-Plane Authority）

- 只有**控制面**（CLI / 配置文件 / supervisor）可发起 `mount` / `unmount` / 覆盖。
- 数据面（Agent/模型）**无法访问 `IPluginHost`**；插件管理不注册为模型工具。
- `unmount(name)` 前置检查：`is_protected(name)` → 直接拒绝；否则 → `ISecurityCore.authorize_control_plane()` + 人类审批 → 执行 → 写审计。

## 对外接口（草案）

```text
IPluginHost   # discover() / resolve_deps() / status()
              # mount(plugin, authority) / unmount(name, authority)   # authority 必须为控制面
PluginContext # register_tool / register_service / subscribe / invoke_hook / config
PluginManifest# {name, version, entry, priority, dependencies, hooks, capabilities,
              #  protected, replaceable, removable, agent_manageable}
```

## 依赖

- 内核（Container / EventBus / Config）

## 待定问题

- 插件沙箱化（第三方插件是否在受限进程运行）。
- 插件签名与可信来源校验。
- 热插拔/热重载是否纳入首版；若纳入，**保护清单内插件绝不可热卸载**，仅允许非 TCB 插件热插拔。
- 恶意插件在挂载时尝试覆盖安全组件（服务覆盖攻击）的防护策略。
- 插件 manifest 形态统一：`plugin.toml`（Python 风格）vs `plugin.json` + 导出的 `register` 函数（与 `01-kernel` 对齐）。
