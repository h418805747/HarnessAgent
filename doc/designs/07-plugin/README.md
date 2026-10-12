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
