# 02 Runtime 运行时

> 状态：骨架｜对应概要设计 §5.2

## 目标

驱动 Agent 的"思考—行动—观察"循环，负责把 Session / Memory / Skills / Tools 的信息装配为模型输入，并把模型输出回写为事件。

## 范围

**做**：
- Agent 主循环（tool call loop，受 `max_iterations` 与预算约束）
- 上下文装配（Context Assembler）
- 模型适配（Model Adapter，多 Provider）
- 子代理（Subagents）与任务委派
- 调度与定时（Scheduler / cron）
- 中断、预算、循环终止策略

**不做**：
- 不直接实现工具执行（委托 Tools）
- 不直接做持久化（委托 Session）
- 不做权限判定（委托 Security）

## 关键设计点（草案）

- **循环可替换**：主循环作为插件，支持 ReAct / Plan-Execute 等不同策略。
- **上下文装配可插拔**：Session 历史、Memory 召回、Skills 注入、Tools schema 各自提供 Provider，由装配器统一编排。
- **实例缓存**：按会话缓存 Runtime/Agent 实例以复用 prompt 前缀缓存（借鉴 Hermes，显著降低 token 成本）。
- **成本与预算**：iteration budget、token budget、grace call 机制。
- **可追溯**：每次上下文注入都产生事件，保证"模型看到的一切"可回放。

## 对外接口（草案）

```python
IRuntime    # run_turn(session, message) / interrupt() / resume()
IContextProvider  # collect(session) -> ContextFragment   （Memory/Skills/Session 均实现）
IModelAdapter     # complete(messages, tools, **opts) -> Response
```

## 依赖

- 内核（Container / EventBus）
- Session、Memory、Tools、Skills、Security（均通过接口）

## 待定问题

- 主循环是否引入显式 Plan 阶段（plan-then-execute）。
- 子代理的隔离级别（共享上下文 / 独立事件流）。
- Code Mode（模型用一段程序组合工具调用）是否纳入首版。
