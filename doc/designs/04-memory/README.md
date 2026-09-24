# 04 Memory 记忆

> 状态：骨架｜对应概要设计 §4、§5.2

## 目标

提供**短期上下文管理**与**长期记忆**两类能力，统一读写接口，实现跨会话的知识沉淀与召回。

## 范围

**做**：
- 短期：会话内上下文窗口管理、压缩/摘要、裁剪策略
- 长期：语义记忆（事实/偏好）与情节记忆（历史事件）的写入与召回
- 召回算法：向量 / 关键词 / 混合
- 遗忘、合并、冲突消解策略
- 多 Provider 支持（可替换后端）

**不做**：
- 不负责原始事件持久化（委托 Session，Memory 是派生视图）
- 不做模型调用编排（委托 Runtime）

## 关键设计点（草案）

- **写入时机**：主循环结束后的异步侧路，从事件流提炼，不阻塞对话。
- **召回时机**：Runtime 上下文装配阶段，作为 `IContextProvider` 提供片段。
- **分层记忆**：工作记忆（当前会话）→ 情节记忆（历史会话）→ 语义记忆（提炼后的事实/偏好）。
- **可插拔后端**：默认 sqlite-vec；可选 Chroma / 外部向量库 / 第三方记忆服务插件。
- **用户建模**：预留跨会话用户画像（类似 USER.md 的持久化模型）。

## 对外接口（草案）

```python
IMemoryProvider  # write(record) / recall(query, k) / forget(id)
IContextProvider # collect(session) -> ContextFragment   （由 Memory 实现）
MemoryRecord     # {kind, content, embedding?, source_event_ids, confidence, ts}
```

## 依赖

- 内核、Session（事件来源）、Security（隐私分级与脱敏）

## 待定问题

- 自动写入 vs 显式写入的选择边界。
- 记忆冲突与过期的判定规则。
- 隐私敏感记忆的分级与是否允许上云。
