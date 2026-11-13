# 技术栈说明

> 自动生成于 2026-11-12（scripts/init.* update 刷新），人工结论请补充到本文件下方。

- 未识别到技术栈信号

## 补充说明（人工维护区）

> 以下为**设计决策**（来源 `docs/designs/00-overview/design.md` §6.2/§6.3），非代码实测；M1 落地后由 `project-update` 复核。

| 领域 | 选型 |
|---|---|
| 内核宿主 | TypeScript 5.x（**Node 22 LTS，ESM**） |
| 运行时（已定） | Node 22 LTS 跑生产进程；Bun 仅用于 `build --compile` 打包，不进生产路径 |
| Agent 服务（控制面） | Fastify + `@fastify/websocket`；实例注册表 + 消息路由 + 调度（`10-control-plane`） |
| Agent 实例（worker） | Node 子进程（服务 spawn），**stdio JSON-RPC** 通信，每 profile 一进程 |
| 跨进程契约 | Zod 定义并导出 JSON Schema，`packages/contracts` 三方共用 |
| 辅助进程 | Python 3.12+（`sidecars/memory-py`，uv 管理），承担记忆/嵌入/中文分词；**v1 后置** |
| 插件与依赖注入 | 自研轻量容器（借鉴 Cordis service/event 语义），插件经 MCP / stdio JSON-RPC / WASM 接入 |
| 数据模型与校验 | Zod（进程内）；JSON Schema（跨进程契约） |
| 存储 | **单库** SQLite（WAL + FTS5，带 `profile_id` 列），Node 侧 **better-sqlite3**（v1 选定）；服务单写入者，worker 不落盘；可选 Postgres / Redis |
| 向量检索 | `sqlite-vec` |
| CLI / TUI | Citty 或 Commander + ora；TUI 用 Ink（React） |
| Web UI | Fastify 或 Hono + SSE/WebSocket；前端 React + Vite |
| 日志与可观测 | pino（结构化 JSON）；可选 OpenTelemetry |
| 质量 | Vitest / ESLint / tsc / pre-commit |
| 包管理与编排 | pnpm + turbo（TS 侧）、uv（Python 侧） |
| 分发 | Bun 打包的单文件二进制（CLI / sidecar）/ npm 包 / Docker |
| 桌面壳 | **Electron**（v1 必需）：主进程 spawn Chrome 并持有 CDP，渲染进程只做 UI |
