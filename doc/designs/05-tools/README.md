# 05 Tools 工具

> 状态：草案｜对应概要设计 §4、§5.2

## 目标

提供统一的工具注册、发现、编排与执行能力，并支持可插拔的沙箱执行后端。

## 范围

**做**：
- 工具注册表（自注册 + 自动发现）
- 工具模型（name / toolset / schema / handler / check_fn / requires_env）
- Toolset 分组与按模式启停
- 执行编排（按名称执行、参数校验、超时、错误处理）
- 执行后端：本地子进程 / Docker / SSH / 云沙箱（可插拔）
- MCP 集成（stdio / SSE / StreamableHTTP）

**不做**：
- 不做权限判定与审批（委托 Security，执行前必经）
- 不做模型调用（委托 Runtime）

## 关键设计点（草案）

- **自注册**：工具模块导入即调用 `registry.register()`，无需维护手工清单（借鉴 Hermes）。
- **Toolset 命名包**：如 `core`、`code`、`web`、`memory`、`browser`，支持按运行模式/平台启停。
- **执行后端可插拔**：同一工具可在本地/容器/远程执行，后端由配置决定。
- **MCP 作为扩展通道**：外部能力优先经 MCP 接入，降低内核体积。
- **执行前钩子**：`on_before_tool_call` / `on_after_tool_call`（对接 Security 与审计）。

## 检索类工具与取舍（调研结论）

### 三类检索能力并存，按任务路由

| 工具类别 | 机制 | 擅长 | 短板 | 维护成本 |
|---|---|---|---|---|
| **词法检索**（grep/glob） | ripgrep 实时正则扫描 | 字面定位、精确、**永远最新** | 不懂概念语义 | **零** |
| **结构检索**（LSP） | 语义导航：定义 / 引用 / 实现 / 调用层级 | 结构关系、影响面分析 | 不做模糊概念匹配 | 低（随语言服务器） |
| **概念检索**（向量/记忆） | embedding 近义匹配 + 混合召回 | 模糊概念、同义表述、历史 | 需索引与嵌入，可能误召回 | 中（需同步/重建） |

### 为什么默认词法而非索引

- 代码高频变更 → 索引**持续过期**，同步维护成本高于检索收益。
- grep 结果**精确、可解释、永远最新**，没有"语义近似但实际错误"的幻觉召回。
- 语义能力**交给模型**：模型自身懂同义与结构，可多轮/并行扩展查询（"plain glob and grep, driven by the model"）。

### 缓解"多轮检索"代价的手段

1. **并行工具调用**：一轮内并发多个 grep/glob/read，把多轮压成一轮（Runtime 能力）。
2. **子代理隔离探索**：搜索类子代理在独立上下文烧 token，只把结论 + 路径带回主上下文（见 `02-runtime`）。
3. **可选索引加速**：Repo Map / 符号索引作为**非默认插件**，大仓库再挂，坚持"零维护优先"。
4. **结果缓存**：工具结果缓存 + prompt 前缀缓存。

**原则**：检索能力**不做死**——词法 / 结构 / 概念三条腿均为可插拔工具，由 Runtime 按任务类型路由。

## 对外接口（草案）

```text
IToolRegistry   # register(tool) / discover() / get(name) / list(toolset)
ITool           # {name, toolset, schema, handler, check_fn, requires_env}
IToolRunner     # run(tool_call, ctx) -> ToolResult
IExecutionBackend  # exec(command, ctx) -> Result   （local/docker/ssh/cloud）
```

## 依赖

- 内核、Security（执行前判定）、Plugin（工具亦可由插件提供）

## 待定问题

- 工具 schema 的版本兼容与工具级权限声明。
- Code Mode SDK（以一段程序组合多步工具调用）是否纳入。
- MCP 连接的生命周期与重连策略。
