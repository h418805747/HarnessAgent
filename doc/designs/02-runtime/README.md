# 02 Runtime 运行时

> 状态：草案｜对应概要设计 §5.2

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

## 多轮检索与子代理隔离

### 概念区分：Session / Turn / Iteration

```
Session（会话）   一段完整对话，持久化为事件流
  └─ Turn（轮次）  用户一次请求 → 一次最终回复
       └─ Iteration（迭代）  模型内部：调用工具 → 观察 → 再调用
```

- 用户感知的是 **Turn**（一次问答）；定位一个 bug 所需的是**多次 Iteration**，对用户基本不可见。
- **每次 Iteration 都是一次 LLM API 往返**——这是延迟与 token 成本的真实来源。

### 定位成本的真实形态

典型"修一个 bug"的迭代：搜错误信息 → 读命中文件 → 搜函数定义/调用者 → 找测试与配置 → 收敛，约 **2–5 轮**；陌生大仓库 5–10 轮。每轮携带**累积上下文**，token 单调增长。

### 设计对策

| 对策 | 说明 |
|---|---|
| **并行工具调用** | 一轮内并发多个检索/读取，把多轮压成一轮，显著降低往返 |
| **子代理隔离** | 搜索探索在独立上下文进行，只回传结论 + 路径，避免主上下文膨胀 |
| **上下文预算** | 装配阶段做 token 预算裁剪；历史按需回溯而非全量带入 |
| **前缀缓存** | 按会话缓存实例，复用 prompt 前缀，摊薄多轮成本 |
| **按需索引** | Repo Map / 符号索引作为可选加速，不设为默认依赖 |
| **循环上限** | `max_iterations` + 预算 + grace call，防止无限探索 |

### 与检索工具的关系

- Runtime 只负责**编排与路由**，不实现具体检索（委托 Tools，见 `05-tools`）。
- 子代理为一等公民：其隔离级别（共享上下文 / 独立事件流）需在详细设计中定稿。

## 对外接口（草案）

```text
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
- 检索工具的路由策略：词法 / 结构 / 概念三者何时用哪个，由模型自主选择还是 Runtime 按规则路由。
- 是否需要内置"仓库地图（Repo Map）"作为可选加速，及其与零维护原则的取舍。
