# 05 Tools 工具

> 状态：骨架｜对应概要设计 §4、§5.2

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

## 对外接口（草案）

```python
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
