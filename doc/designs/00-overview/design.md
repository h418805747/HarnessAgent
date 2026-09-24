# HarnessAgent 概要设计

> 状态：草案 v0.1
> 定位：内核级概要设计（Architecture Overview），后续各模块详细设计在此基础上展开。
> 参考：DeepSeek Harness (dsh) 与 Hermes Agent 的设计思想。

---

## 1. 背景与目标

### 1.1 问题

现状有三类痛点：

1. **现有框架过重**：DeepSeek Harness / Hermes 这类生产力框架功能完整，但内部结构复杂、上手与二次开发成本高。
2. **不匹配自身需求**：通用框架的默认行为、模块边界、交互方式与个人使用习惯存在偏差。
3. **定制易被覆盖**：直接 fork 上游仓库做定制，一旦 `git pull` 升级上游，本地改动频繁冲突甚至被覆盖，定制无法长期维护。

### 1.2 目标

构建一个**薄内核 + 全插件化**的自用 Agent Harness：

- 内核只负责编排，能力全部外置为插件，可配置组合、按需启停。
- **定制与内核物理分离**：所有定制只落在 `profiles/`、`plugins/`、配置文件，升级内核不触碰定制目录。
- 单次运行全程可追溯，会话可恢复、可分叉、可回放。
- 本地优先、可离线、无强制云依赖。
- 显式安全：默认最小权限，危险操作需审批。

### 1.3 非目标

- 不做通用云平台 / 多租户 SaaS。
- 不做模型训练，只做推理侧编排。
- 首版不追求企业级权限体系（RBAC/SSO），但预留扩展点。

---

## 2. 设计原则

### 2.1 借鉴自 DeepSeek Harness

| 原则 | 含义 | 落地方式 |
|---|---|---|
| **Agent = Model + Harness** | 模型负责推理，Harness 负责让 Agent 理解环境、使用工具、持续工作 | 内核只做"环境与编排"，不侵入模型行为 |
| **Everything is a plugin** | 微内核只做挂载/卸载/依赖管理，**能力**全部下沉到插件 | 模型、工具、技能、会话、沙箱、存储、主循环、调度、UI 均为插件。**注意：适用于"能力"，不适用于"信任根"**（见 P8） |
| **Every run is traceable** | 模型可见的一切写入 append-only 事件流 | resume / fork / replay / search 共享同一事件流，状态由事件流重建 |

### 2.2 借鉴自 Hermes Agent

| 实践 | 落地方式 |
|---|---|
| 工具自注册 + 自动发现 | 工具模块导入即注册，无需手工维护清单 |
| Toolset 分组 | 工具按命名包分组，按运行模式/平台启停 |
| SQLite + WAL + FTS5 | 会话持久化与全文检索 |
| Agent 实例按会话缓存 | 复用 prompt 前缀缓存，显著降低 token 成本 |
| Profile 感知的配置/密钥分离 | 配置与密钥分文件、按 profile 隔离 |
| 多平台 Gateway + MCP | 统一消息接入层，工具经 MCP 扩展 |
| 插件优先级 project > user > bundled | 支持用户与项目级定制覆盖 |
| 技能自生成 / 自改进 | 从成功轨迹沉淀技能并迭代 |

### 2.3 本项目的补充原则

| 原则 | 含义 |
|---|---|
| **P4 定制与内核分离** | 定制只写 `~/.harness/`（user）与 `./.harness/`（project），内核目录只读升级 |
| **P5 本地优先** | 默认单机可跑，无云依赖；云端能力均为可选插件 |
| **P6 显式安全** | 默认最小权限，危险操作需审批，全链路审计 |
| **P7 契约稳定** | 内核对外 API 语义化版本，插件契约向后兼容，升级不破坏插件 |
| **P8 信任根不可卸载** | 安全强制点与插件装载权威属内核信任根（TCB），**常驻、不可卸载、不对模型暴露**；"一切皆插件"只适用于能力，不适用于信任根 |

---

## 3. 总体架构

采用**微内核 + 事件驱动 + 分层插件**结构：

```
┌───────────────────────────────────────────────────────────────────────┐
│  交互层 / Interface  (可插拔前端)                                        │
│  CLI REPL │ TUI │ Web UI │ IDE(ACP/MCP) │ IM Gateway │ SDK │ Headless  │
└──────────────────────────────┬────────────────────────────────────────┘
                               │  统一 Message/Event 契约
┌──────────────────────────────▼────────────────────────────────────────┐
│  运行时 / Runtime  (编排)                                               │
│  Agent Loop │ Context Assembler │ Model Adapter │ Subagents │ Scheduler │
└───────┬───────────────┬───────────────┬───────────────┬────────────────┘
        │               │               │               │
┌───────▼─────┐ ┌───────▼─────┐ ┌───────▼─────┐ ┌───────▼──────┐
│  Session    │ │  Memory     │ │  Tools      │ │  Skills      │
│  事件流/持久│ │  短期+长期  │ │  注册/沙箱  │ │  包/渐进披露 │
└───────┬─────┘ └───────┬─────┘ └───────┬─────┘ └───────┬──────┘
        │               │               │               │
┌───────▼───────────────▼───────────────▼───────────────▼───────────────┐
│  ★ 信任边界 / Trust Boundary（TCB：常驻、不可卸载、不对模型暴露）        │
│                                                                        │
│  [安全 Security Core]  权限策略 │ 审批流 │ 控制面授权 Gate │ 审计锚点    │
│       ▲ 依赖接口：可替换但不可缺，缺失/异常 → fail-closed（拒绝）        │
│  [L2 安全后端]  策略引擎 │ 沙箱后端 │ 密钥后端 │ 审计 Sink               │
│ ─────────────────────────────────────────────────────────────────────  │
│  [插件 Plugin Host]  Manifest 发现 │ 依赖解析 │ Hooks │ 仅控制面可装卸   │
│ ─────────────────────────────────────────────────────────────────────  │
│  [内核 Kernel]  Container(DI) │ Event Bus │ Config │ Logger/Trace       │
│  ★════════════════════════════════════════════════════════════════════  │
└───────────────────────────────────────────────────────────────────────┘
```

**关键点**：
- 内核不含任何 Agent 业务能力；Session / Memory / Tools / Skills / Runtime / Interface 全部作为插件挂载其上。
- **但 Security Core 与 Plugin Host 属于信任边界（TCB）**：可以"被换实现"，不能"被卸载"，更不能被模型触发移除。
- 即"全插件化"针对的是**能力**；**信任根必须常驻**。

---

## 4. 模块划分

共 **9 个一级模块**（1 个微内核 + 8 个标准模块），每个模块在 `doc/designs/` 下拥有独立设计目录。

| 编号 | 模块 | 目录 | 职责 | 是否可替换 |
|---|---|---|---|---|
| 01 | Kernel 微内核 | `01-kernel/` | 服务容器、事件总线、插件生命周期、分层配置、日志与追踪 | 内核本体（稳定） |
| 02 | Runtime 运行时 | `02-runtime/` | Agent 主循环、上下文装配、模型适配、子代理、调度 | 是（loops/models/scheduling 插件） |
| 03 | Session 会话 | `03-session/` | append-only 事件流、持久化、resume/fork/replay/search | 是（storage 插件） |
| 04 | Memory 记忆 | `04-memory/` | 短期上下文管理 + 长期记忆写入/召回 | 是（memory 插件） |
| 05 | Tools 工具 | `05-tools/` | 工具注册/发现/编排、执行后端、MCP 集成 | 是（tools 插件） |
| 06 | Skills 技能 | `06-skills/` | 技能包格式、渐进披露加载、自生成/自改进 | 是（skills 插件） |
| 07 | Plugin 插件 | `07-plugin/` | Manifest、发现与加载、依赖解析、Hooks、打包分发 | 装载层 |
| 08 | Security 安全 | `08-security/` | 权限策略、审批流、控制面授权、沙箱隔离、密钥、审计 | **内核 TCB，不可卸载**；策略/后端可替换 |
| 09 | Interface 交互 | `09-interface/` | CLI/TUI/Web/IDE/IM Gateway/SDK/Headless | 是（UI 插件） |

### 4.1 各模块一句话说明

- **01 Kernel**：只提供 `IContainer` / `IEventBus` / `IPluginHost` / `IConfig` / `ILogger` 五类基础服务，不含业务逻辑。
- **02 Runtime**：驱动"思考—行动—观察"循环，负责把 Session/Memory/Skills/Tools 的信息装配成模型输入，并把输出回写为事件。
- **03 Session**：以 append-only 事件流作为唯一真相源，所有状态均由事件重建。
- **04 Memory**：区分短期（会话内上下文窗口管理、压缩）与长期（跨会话的语义/情节记忆），提供统一读写接口。
- **05 Tools**：统一的工具注册表与执行编排，工具执行经可插拔沙箱后端。
- **06 Skills**：以文件包（`SKILL.md` + 资源）承载可复用能力，按需渐进注入，支持从轨迹中自动生成与改进。
- **07 Plugin**：定义插件清单与契约，负责发现、版本/依赖解析、加载顺序、生命周期钩子。
- **08 Security**：横切所有模块，做权限判定、审批、**控制面授权**、隔离、密钥与审计。**属内核信任根（TCB），常驻不可卸载，其管理操作不对模型暴露。**
- **09 Interface**：所有人类/外部系统接入方式的适配层，统一转换为内部 Message/Event。

---

## 5. 模块协作

### 5.1 启动装配流程

```
0. Security Core 先于一切加载（TCB 引导，不可跳过）
   → 建立 fail-closed 默认策略与保护清单（Protected Set）
1. Kernel 启动
   → 加载分层配置 (default → user → project → env)
2. Plugin Host 发现插件
   → bundled → user(~/.harness/plugins) → project(./.harness/plugins) → pip entry-points
   → 依赖解析（拓扑排序）→ 逐个经 Security 校验后挂载
3. 各插件向 Container 注册服务、向 EventBus 订阅事件
4. TCB 集合冻结（运行期不可变，变更需重启）
5. Runtime 就绪 → Interface 插件启动（CLI/TUI/Web/Gateway）
```

### 5.2 一次对话的完整链路

```
User Input
  │
  ▼
[Interface] 归一化为 Message ──────────────────────────────┐
  │                                                        │
  ▼                                                        │
[Runtime] 开启一轮 Turn                                    │
  ├─1→ [Session]  追加事件 user.message                     │ 事件流
  ├─2→ [Security] 输入安全过滤                              │
  ├─3→ Context Assembler 装配上下文：                       │
  │      ├─ [Session]  历史事件 → 消息序列                  │
  │      ├─ [Memory]   召回相关长期记忆                      │
  │      ├─ [Skills]   注入命中的技能元数据/SKILL.md         │
  │      └─ [Tools]    获取当前可见工具 schema（按 toolset）  │
  ├─4→ [Runtime] 调用 Model Adapter → LLM                   │
  ├─5→ 若返回 tool_calls：                                  │
  │      ├─ [Security] 权限判定 / 触发审批                   │
  │      ├─ [Session]  追加 tool.call 事件                   │
  │      ├─ [Tools]    经沙箱后端执行                        │
  │      ├─ [Security] 审计记录                              │
  │      ├─ [Session]  追加 tool.result 事件                 │
  │      └─ 回到步骤 3（循环，受 max_iterations / 预算约束） │
  ├─6→ 模型给出最终回答                                     │
  ├─7→ [Session] 追加 assistant.message 事件                │
  └─8→ [Interface] 渲染输出 ────────────────────────────────┘

（异步侧路，不阻塞主循环）
  ├─ [Memory] 从事件流提炼长期记忆
  └─ [Skills] 从成功轨迹沉淀/改进技能
```

### 5.3 事件流作为协作中枢

- 所有模块之间**不直接互相调用改写状态**，而是通过"追加事件 + 订阅事件"协作。
- Session 的 append-only 事件流是唯一真相源：`resume` / `fork` / `replay` / `search` 全部基于它重建。
- 模型可见的一切（system prompt、reasoning、工具调用与结果、子代理调度、每次上下文注入）都必须落盘为事件，保证可追溯。

### 5.4 横切与依赖规则

- **依赖方向单向向下**：Interface → Runtime → (Session/Memory/Tools/Skills) → Security → Plugin → Kernel。
- Security 为横切关注点，Runtime/Tools/Interface 在执行敏感动作前**必须**经过 Security 判定。
- 模块之间通过内核的 Service Container 依据**接口**通信，具体实现由插件提供，实现层可替换。
- **单向信任**：Security Core 不得依赖任何普通插件才能运行，否则形成绕过路径；任何"无法判定"一律拒绝。
- **控制面隔离**：插件装卸、策略与配置变更属控制面，仅可由人类（CLI / 配置文件 / supervisor）发起；数据面（模型）只能请求，不能授权。

---

## 6. 技术框架选型

| 领域 | 选型 | 说明 |
|---|---|---|
| 语言/运行时 | **Python 3.12+**（asyncio） | 生态成熟、与 Hermes 一致、开发效率高；工作区亦为 Python |
| 数据模型/校验 | **Pydantic v2** | 事件、配置、工具 schema 的统一建模与校验 |
| 插件/依赖注入 | **自研轻量容器**（借鉴 Cordis 的 service/event 语义）+ Python `entry_points` | 保持内核极薄，避免重框架 |
| 事件总线 | 进程内 asyncio pub/sub（预留跨进程/分布式扩展） | 低延迟、无外部依赖 |
| 存储 | **SQLite（WAL + FTS5）** 默认；可选 Postgres / Redis | 本地优先，全文检索开箱即用 |
| 向量检索 | **sqlite-vec** 默认；可选 Chroma / 外部向量库 | 长期记忆召回 |
| 模型接入 | OpenAI 兼容协议为主，多 Provider 插件（Anthropic/OpenRouter/本地 Ollama…） | 统一 Model Adapter |
| 工具执行沙箱 | 本地子进程 / Docker / SSH / 云沙箱（可插拔后端） | 与 Hermes environments 对齐 |
| 工具扩展协议 | **MCP**（stdio / SSE / StreamableHTTP） | 复用生态，官方 Python SDK |
| CLI | **Typer + Rich + prompt_toolkit** | 交互体验与主题化 |
| TUI | **Textual** | 全屏终端 UI |
| Web UI | **FastAPI + Uvicorn**，SSE/WebSocket 流式；前端为可选独立包 | 聊天 + 轨迹视图 |
| 配置 | TOML/YAML + 环境变量 + profile 分层 | 配置与密钥分离 |
| 可观测 | 结构化 JSON 日志；可选 OpenTelemetry | 分级日志文件 |
| 打包 | **uv / hatchling → PyPI**；Docker；PyInstaller 单文件 | 多形态分发 |
| 质量 | pytest / ruff / mypy / pre-commit | 契约与类型安全 |
| 文档 | MkDocs（Material） | 设计文档 + 用户手册 |

**选型说明**：DeepSeek Harness 采用 TypeScript/Cordis 内核，Hermes 采用 Python。本项目选择 Python，原因是与工作区技术栈一致、生态完整、且可复用 Hermes 的大量工程实践；若未来需要 Code Mode（模型用一段程序组合工具调用），可通过一个独立的 Node/TS 执行插件桥接，而不改变内核语言。

---

## 7. 人机交互方式

### 7.1 支持的接入形态

| 形态 | 入口 | 场景 |
|---|---|---|
| **CLI REPL** | `ha` | 日常交互式对话，首版必做 |
| **TUI** | `ha --tui` | 全屏多面板（对话 / 轨迹 / 工具） |
| **Web UI** | `ha web` | 聊天界面 + 轨迹视图 |
| **IDE 集成** | ACP / MCP Server | VS Code / Zed / JetBrains 内直接调用 |
| **IM Gateway** | 常驻守护进程 | Telegram / Discord / Slack / 飞书 / 钉钉 / 企业微信 / 微信 / QQ |
| **Headless / 批处理** | `ha run` / batch / cron | 脚本化、CI、定时任务 |
| **编程式 SDK** | Python API | 被其他程序嵌入调用 |

### 7.2 人机协作机制

| 机制 | 说明 |
|---|---|
| **审批流** | 危险工具调用前需用户确认，可选 allow / deny / always-allow |
| **中断与接管** | 用户可随时打断正在运行的一轮，接管控制 |
| **澄清提问** | Agent 信息不足时可主动向用户反问 |
| **计划审阅** | Plan 模式：先产出计划待用户确认，再执行 |
| **Diff 预览** | 文件改动执行前展示 diff |
| **轨迹检视** | Trajectory view，可按来源（模型/工具/上下文注入）过滤 |
| **会话控制** | resume / fork / replay / search 四类操作 |

设计取向：**交互层与 Agent 内核解耦**——所有接入形态共享同一套 Message/Event 契约与协作机制，UI 本身也是可替换插件。

---

## 8. 发布制品

| 制品 | 形态 | 说明 |
|---|---|---|
| **核心 Python 包** | PyPI `harness-agent` | 内核 + 标准模块 + 内置插件 |
| **CLI 可执行** | `ha`（`pipx` / `uv tool install`） | 主要入口 |
| **Docker 镜像** | `harnessagent/harness:latest` | 容器化部署与沙箱宿主 |
| **单文件二进制** | Windows / macOS / Linux | 免 Python 环境（PyInstaller） |
| **插件 SDK / 脚手架** | PyPI `harness-agent-sdk` + `ha plugin new` | 插件开发模板与类型定义 |
| **默认插件包 / Preset** | `bundled` 插件 + 运行模式预设 | 对应 Standard / Code / Minimal / Creator 式组合 |
| **配置模板** | `profiles/` 与示例 config | 快速初始化 |
| **文档制品** | MkDocs 站点 + 各模块设计文档 | 设计与使用文档 |
| **（可选）桌面应用** | Tauri/Electron 壳 | 后期规划 |

### 8.1 定制不被覆盖的保障机制

这是本项目最核心的工程诉求，机制如下：

1. **目录隔离**：内核源码目录只读升级；定制只写 user（`~/.harness/`）与 project（`./.harness/`）目录。
2. **插件优先级**：`project > user > bundled`，同名插件可被上层覆盖而不改内核。
3. **配置分层合并**：`default → user → project → env → CLI`，逐层覆盖。
4. **契约版本化**：内核对外 API 与插件契约遵循语义化版本，破坏性变更提供迁移期。
5. **升级策略**：升级仅替换内核包与 bundled 插件，定制目录与本地插件包不受影响。

---

## 9. 仓库与文档目录规划

```
HarnessAgent/
├── src/harness_agent/        # 内核与标准模块源码（只读升级）
│   ├── kernel/               # 01
│   ├── runtime/              # 02
│   ├── session/              # 03
│   ├── memory/               # 04
│   ├── tools/                # 05
│   ├── skills/               # 06
│   ├── plugin/               # 07
│   ├── security/             # 08
│   └── interface/            # 09
├── plugins/                  # 官方/bundled 插件
├── profiles/                 # 用户/项目定制（升级不覆盖）
├── doc/
│   ├── designs/              # 设计文档（本目录）
│   └── plans/                # 实施计划
├── tests/
└── README.md
```

设计文档目录：

```
doc/designs/
├── README.md                 # 设计索引
├── 00-overview/design.md     # 概要设计（本文）
├── 01-kernel/README.md
├── 02-runtime/README.md
├── 03-session/README.md
├── 04-memory/README.md
├── 05-tools/README.md
├── 06-skills/README.md
├── 07-plugin/README.md
├── 08-security/README.md
└── 09-interface/README.md
```

---

## 10. 后续设计推进计划

| 阶段 | 产出 |
|---|---|
| M0 | 概要设计（本文），确定模块边界与契约总纲 |
| M1 | 内核 + 插件契约详细设计（01/07） |
| M2 | Session 事件流与 Runtime 主循环详细设计（02/03） |
| M3 | Tools + Security 详细设计（05/08） |
| M4 | Memory + Skills 详细设计（04/06） |
| M5 | Interface/交互详细设计（09） |
| M6 | 实施计划（`doc/plans/`）与首个可运行版本 |

---

## 11. 待定问题（待后续设计确认）

1. **Code Mode**：是否需要模型以"一段程序"组合工具调用？涉及 Node/TS 桥接或 Python 内嵌执行。
2. **多用户/多租户**：首版单用户，是否需要预留多 profile 隔离到进程级。
3. **长期记忆策略**：写入时机（同步/异步）、召回算法（向量/关键词/混合）、遗忘与合并策略。
4. **技能自生成**：自动生成的触发条件、质量校验与回滚机制。
5. **Web UI 是否独立仓库**：前端工程化与内核发布节奏的耦合度。
6. **安全监督进程（supervisor）**：是否需要独立进程守护 TCB，防止同进程内存篡改或强制卸载。
7. **保护清单可扩展性**：是否允许用户将自研插件加入保护清单（该扩展操作本身须为 L3 控制面操作）。
