# 03 Session 会话

> 状态：骨架｜对应概要设计 §2.1、§5.3

## 目标

以 **append-only 事件流**作为 Agent 状态的唯一真相源，支撑 resume / fork / replay / search。

## 范围

**做**：
- 事件模型与事件流（追加写入，不可变）
- 会话持久化（SQLite + WAL 默认）
- 全文检索（FTS5）
- 会话控制：resume / fork / replay / search
- 上下文压缩触发的会话拆分（`parent_session_id` 链）
- 会话来源标记（cli / web / telegram / ...）

**不做**：
- 不做长期语义记忆（委托 Memory）
- 不做权限校验（委托 Security）

## 关键设计点（草案）

- **事件流是唯一真相源**：状态不做快照拼凑，由事件重建；resume/fork/replay/search 共享同一事件流。
- **记录模型可见的一切**：system prompt、reasoning、tool call/result、subagent 调度、每次上下文注入。
- **事件类型（草案）**：`session.start`、`user.message`、`context.inject`、`model.request/response`、`tool.call`、`tool.result`、`assistant.message`、`session.fork`、`session.end`。
- **会话键**：`f"{platform}:{chat_id}:{thread_id}"`（借鉴 Hermes）。
- **存储可插拔**：SQLite 为默认实现，接口允许替换为 Postgres 等。

## 对外接口（草案）

```python
ISessionStore  # append(event) / read(session_id) / search(query) / fork(session_id) / list()
Session        # 会话句柄：event stream 视图 + 元数据
Event          # 统一事件模型（type / ts / source / payload / trace_id）
```

## 依赖

- 内核（Container / EventBus）
- Security（写入前后的脱敏与审计）

## 待定问题

- 事件 schema 版本化与迁移策略。
- 轨迹视图（trajectory view）的过滤维度定义。
