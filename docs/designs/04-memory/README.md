# 04 Memory 记忆

> 状态：草案｜对应概要设计 §4、§5.2

## 目标

提供**短期上下文管理**与**长期记忆**两类能力，统一读写接口，实现跨会话的知识沉淀与召回。

## 范围

**做**：
- 短期：会话内上下文窗口管理、压缩/摘要、裁剪策略
- 长期：语义记忆（事实/偏好）与情节记忆（历史事件）的写入与召回
- 召回算法：关键词（FTS5 倒排）/ 向量 / 混合（RRF 融合）
- 遗忘、合并、冲突消解策略
- 多 Provider 支持（可替换后端）

**不做**：
- 不负责原始事件持久化（委托 Session，Memory 是派生视图）
- 不做模型调用编排（委托 Runtime）

## 关键设计点（草案）

- **写入时机**：主循环结束后的异步侧路，从事件流提炼，不阻塞对话。
- **召回时机**：Runtime 上下文装配阶段，作为 `IContextProvider` 提供片段。
- **分层记忆**：工作记忆（当前会话）→ 情节记忆（历史会话）→ 语义记忆（提炼后的事实/偏好）。
- **可插拔后端**：默认 SQLite（FTS5 倒排，零依赖）；向量为可选增强（sqlite-vec + 本地小模型）；可换 Chroma / 外部向量库 / 第三方记忆服务插件。
- **用户建模**：预留跨会话用户画像（类似 USER.md 的持久化模型）。

## 检索方案选型（调研结论）

### 对标调研

| 框架 | 本地检索机制 | 索引 | 内置向量 | 取向 |
|---|---|---|---|---|
| **Hermes** | SQLite **FTS5**（`unicode61` + `trigram` 双索引），`bm25()` 排序 | 有（倒排） | ❌（可选外部插件） | 本地关键词召回 + 两阶段 LLM 精炼 |
| **Claude Code** | 记忆**文件注入**（CLAUDE.md 全量 / MEMORY.md 前 200 行或 25KB）+ **ripgrep** 词法扫描搜代码 | ❌ 无 | ❌ 无 | 不做 RAG，靠上下文注入 |
| **DeepSeek Harness** | 内核不预设，由记忆插件决定：FTS5 / FTS5+embedding / **BM25(jieba)+FAISS+图谱 → RRF 融合** | 插件决定 | 插件提供 | 插件化，可混合 |

共性：都坚持本地、少依赖；**关键词/倒排是默认，向量是可选增强**；中文场景需 `trigram` 或 `jieba`。

### 关键洞察：语义从哪来

"同义不同词"（历史说"高兴"、现在搜"开心"）的语义匹配，只有三种来源：

| 来源 | 做法 | 代表 |
|---|---|---|
| **检索器** | embedding 向量近义匹配 | DSH `dsh-deepmemory`、Hermes 可选外部记忆插件 |
| **模型自身** | 上下文注入 + 多轮查询扩展 | Claude Code |
| **写侧规范化** | 写入时提炼为规范表述 / 结构化事实 | Claude Code Auto Memory、Hermes `MEMORY.md` / `USER.md` |

- Claude Code 是"**注入优先**"路线：文本只要已在上下文窗口内，模型天然懂同义，**用"少检索"绕过语义问题**——代价是数据量必须小，超出窗口即失效。
- Hermes 的纯 FTS5 恰恰**存在**该问题（其文档自述"deploy"与"deployment strategy"可能漏召回），故才开放 embedding 外部插件。
- 我们的记忆是**长期、跨会话、规模化**的，不能靠"少检索"回避，必须正面解决。

### 选型结论

1. **默认 FTS5**：`unicode61`（英文/通用）+ `trigram`（**中文与子串搜索必备**）双索引，`bm25` 排序。
2. **向量为可选增强**：`sqlite-vec` + 本地小嵌入模型（如 `bge-small-zh-v1.5`，512 维），默认不外发数据。
3. **混合检索**：FTS5 + 向量 → **RRF 融合**，再按 `recency × importance × relevance` 加权（参考 dsh-deepmemory）。
4. **查询扩展**：召回前用 LLM 把查询扩成同义/多语言词（`开心 → 开心|高兴|愉快|happy`），直接补上同义召回，成本远低于多轮往返。
5. **写侧规范化**：记忆写入时提炼为规范表述并抽取实体/标签，**让检索不依赖原始用词**。
6. **两阶段召回**：倒排/向量快速定候选 → LLM 精炼摘要，避免把原始历史塞进上下文。
7. **索引与事件流分离**：Session 存 append-only 事件（真相源），Memory 只建**可重建的派生索引**，索引损坏不影响事实。

## 存储分层与数据落位（补充）

> 本节回答：哪些数据存到哪里、分几层、谁是真相源。
> 物理存储由 `10-control-plane` 的服务持有（单库、单写入者）；本模块负责 L1/L2 的设计与接口，**不直接持有数据库句柄**。

### 物理介质

| 介质 | 持有者 | 存什么 | 依据 |
|---|---|---|---|
| **SQLite 单库**（WAL + FTS5，带 `profile_id`） | 服务（唯一写者） | 任务、线程事件流、提醒、审计、记忆、全文/向量索引 | `10-control-plane` §持久层 |
| **文件系统**（profile 目录 / 工作区） | 各模块 + 用户 | 配置、技能包、插件、工作区产物、日志、浏览器 profile | `01-kernel` §IProfile |
| **SecretStore** | Security | API Key、令牌；不进 config、不进 DB、不进事件流 | `08-security` §6 |
| **可选外部存储** | 插件 | 外部向量库、第三方记忆服务、Postgres（替换默认实现） | 本模块 §可插拔后端、`03-session` §存储可插拔 |

**不持久化（易失）**：上下文窗口、EventBus 事件（内核明确不落盘）、Runtime 实例缓存 / prompt 前缀缓存、租约与心跳。

### 逻辑分层

| 层 | 内容 | 存储 | 能否重建 |
|---|---|---|---|
| **L0 原始事件层**（唯一真相源） | `session.start` / `user.message` / `context.inject` / `model.request` / `model.response` / `tool.call` / `tool.result` / `assistant.message` / `session.fork` / `session.end`，以及安全判定与审计 | SQLite 事件流，append-only | **否**；resume / fork / replay / search 都靠它 |
| **L1 派生索引层** | FTS5 全文索引（`unicode61` + `trigram`）、向量索引、实体/标签 | 同库（FTS5 / sqlite-vec），或外部向量库 | **是**，损坏可重建 |
| **L2 记忆层** | 工作记忆（当前会话摘要）、情节记忆（历史事件）、语义记忆（事实/偏好）、用户画像 | 同库 Memory 表（`MemoryRecord`） | 部分：从 L0 提炼，但提炼结果本身是新数据 |
| **L3 控制面状态层** | 任务、线程元数据、提醒、审批记录、审计锚点 | 同库，带 `profile_id` | 部分 |
| **L4 配置 / 身份 / 密钥层** | 分层配置、profile 路径、`device_id`、`harness.lock`、密钥 | 文件 + SecretStore，不进 DB | 配置可重建；密钥不可 |
| **L5 资产层** | 插件、技能包、工作区文件、浏览器 profile、日志 | 文件系统 | 插件/技能部分可重装；工作区产物不可重建 |

> L2 内部按本模块的三级模型再分：工作记忆 → 情节记忆 → 语义记忆（见上文「关键设计点」）。

### 内容 → 位置对照

| 内容 | 存储位置 | 说明 |
|---|---|---|
| 对话记录（原始） | L0 事件流 | 用户/助手消息、模型推理、system prompt、每次上下文注入、工具调用与结果全部落盘 |
| 对话摘要 / 上下文压缩 | L0 事件 + 会话拆分（`parent_session_id` 链）；摘要正文存事件还是 Memory 表**待定** | 建议存事件（可回放），Memory 只建索引 |
| 任务列表 / 线程 | L3（同库） | 名称 + 创建时间；线程事件流同库 |
| 用户偏好（设置型） | L4 配置文件 | 配置分层 `default → user → project → env → CLI` |
| 用户偏好（对话中学到的） | L2 语义记忆**（建议）** | 文档只写"预留跨会话用户画像（类似 USER.md）"，形态待定 |
| 用户记忆 | 源头 L0；提炼结果 L2；检索靠 L1 | 写入是对话结束后的异步侧路，不阻塞主循环 |
| 审计 / 审批记录 | L0 事件流（append-only） | 所有安全判定结果可回放 |
| API Key / 令牌 | SecretStore | 不进 DB；config 只存引用 |
| 技能 | L5 文件系统 | `SKILL.md` + 资源；自生成技能校验后落盘 |
| 插件 | L5 文件系统 | bundled / user / project 三个来源目录 |
| 工作区产物 | L5 文件系统 | 真实本地目录，产物直接落该目录 |
| 日志 / 追踪 | L5 文件系统 | pino 结构化日志，按日轮转 |
| 设备身份 | L4 文件（`~/.harness/device.json`） | 机器级、跨 profile；不进 SQLite、不进 git |
| 浏览器登录态 | L5（profile/browser） | Chrome `--user-data-dir`；敏感数据，需 Security 前置拦截 |
| 附件 / 图片 | **待定** | 建议二进制存工作区（内容寻址），事件只存引用 + 哈希 |
| 上下文窗口 / 缓存 | 内存，不持久 | prompt 前缀缓存随进程消失 |

### 存储规则

1. **单一写者**：只有服务写 SQLite；worker 不落盘，读写统一走 `ISessionStore` / `IMemoryProvider` 接口由服务代理。
2. **真相源唯一**：L0 不可变；L1/L2 是派生视图，损坏可重建，绝不能让索引反向成为事实。
3. **敏感数据不进事件流**：密钥、明文凭据不落 L0；审计只记"发生了什么"，不记内容本身。
4. **profile 隔离**：单库用 `profile_id` 列；日志 / 技能 / 浏览器 / 工作区按 profile 目录隔离。

### 存储相关待定

- 压缩摘要存事件还是 Memory 表（建议存事件）。
- 用户画像 `USER.md` 是文件还是 DB 表（建议跨 profile 偏好进 DB，项目人设进 `./.harness`）。
- `always-allow` 记录存哪、如何失效（工具/参数级进配置，会话级进 DB，全部写审计）。
- 附件二进制与事件引用格式。
- 实例注册表是否持久化。
- 单库 + `profile_id` 与"每 profile 一库"的切换阈值。

## 对外接口（草案）

```text
IMemoryProvider  # write(record) / recall(query, k) / forget(id)
IContextProvider # collect(session) -> ContextFragment   （由 Memory 实现）
MemoryRecord     # {kind, content, embedding?, source_event_ids, confidence, ts}
```

## 依赖

- 内核、Session（事件来源）、Security（隐私分级与脱敏）
- Control Plane（服务持有 SQLite，单写入者；本模块经接口读写，不直接持有数据库句柄）

## 待定问题

- 自动写入 vs 显式写入的选择边界。
- 记忆冲突与过期的判定规则。
- 隐私敏感记忆的分级与是否允许上云。
