# 01 Kernel 微内核

> 状态：骨架｜对应概要设计 §3、§5

## 目标

提供 Agent 运行所需的**最小基础设施**，本身不含任何 Agent 业务能力。所有能力（模型、工具、技能、会话、沙箱、存储、主循环、UI）均以插件形式挂载其上。

## 范围

**做**：
- 服务容器（依赖注入 / 服务注册与解析）
- 事件总线（进程内 pub/sub，预留跨进程扩展）
- 插件宿主（挂载 / 卸载 / 依赖解析 / 生命周期）
- 分层配置（default → user → project → env → CLI 合并）
- 日志与追踪（结构化日志、事件流追踪入口）

**不做**：
- 不实现任何工具、模型调用、记忆、会话存储逻辑
- 不包含具体 UI

## 关键设计点（草案）

- 借鉴 Cordis 的 **service + event** 协作模型：插件之间只通过服务接口与事件通信，不直接互相依赖实现。
- 内核 API 遵循**语义化版本**，插件契约向后兼容。
- 容器支持**运行时替换**：同一接口可被上层插件覆盖，实现可插拔。
- **信任边界（TCB）**：Security Core、Plugin Host 权威、Config 权威属内核信任根，**常驻不可卸载**，且不暴露为模型工具；TCB 集合在 bootstrap 后冻结，变更需重启。
- 事件总线为单进程 asyncio 实现，接口设计预留分布式扩展位。

## 对外接口（草案）

```python
IContainer   # register(service) / resolve(interface) / override(interface, impl)
IEventBus    # publish(event) / subscribe(event_type, handler)
IPluginHost  # mount(plugin) / unmount(plugin) / resolve_dependencies()
IConfig      # get(key, default) / merge(layer) / profile
ILogger      # 结构化日志 + trace 关联
```

## 依赖

- 无（最底层）。

## 待定问题

- 事件总线的可观测性粒度（是否每个事件都落盘、采样策略）。
- 插件热重载是否纳入首版。
