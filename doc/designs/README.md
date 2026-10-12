# HarnessAgent 设计文档索引

本目录存放 HarnessAgent 的设计文档。当前阶段为**概要设计**，各模块详细设计后续逐份补齐。

## 阅读顺序

1. [概要设计（00-overview）](./00-overview/design.md) —— 必读，含模块划分、协作方式、技术框架、人机交互、发布制品。

然后再按需进入各模块设计：

| 编号 | 模块 | 文档 | 状态 |
|---|---|---|---|
| 01 | Kernel 微内核 | [01-kernel](./01-kernel/README.md) | 骨架 |
| 02 | Runtime 运行时 | [02-runtime](./02-runtime/README.md) | 草案 |
| 03 | Session 会话 | [03-session](./03-session/README.md) | 骨架 |
| 04 | Memory 记忆 | [04-memory](./04-memory/README.md) | 草案 |
| 05 | Tools 工具 | [05-tools](./05-tools/README.md) | 草案 |
| 06 | Skills 技能 | [06-skills](./06-skills/README.md) | 骨架 |
| 07 | Plugin 插件 | [07-plugin](./07-plugin/README.md) | 骨架 |
| 08 | Security 安全 | [08-security](./08-security/README.md) | 骨架 |
| 09 | Interface 交互 | [09-interface](./09-interface/README.md) | 骨架 |

## 设计原则速查

- **Agent = Model + Harness**：内核只管编排，不侵入模型行为。
- **Everything is a plugin**：微内核 + 能力全外置，配置驱动组合。
- **Every run is traceable**：append-only 事件流是唯一真相源。
- **定制与内核分离**：定制只写 `~/.harness/` 与 `./.harness/`，升级不覆盖。
- **优先 project > user > bundled**：同名插件可被上层覆盖。
- **P8 信任根不可卸载**：Security Core 与插件装载权威属内核 TCB，常驻、不可卸载、不对模型暴露；"一切皆插件"只适用于能力，不适用于信任根。
- **P9 按职责分语言，靠协议解耦**：内核宿主为 **TypeScript（Node/Bun）**，UI 亦为 TS，记忆/嵌入/中文分词走 **Python 辅助进程**，沙箱可下沉 **Rust/WASM**；插件 **语言无关**（MCP / stdio JSON-RPC）。每个语言切换点必须是进程边界 + 协议。

## 状态说明

- `骨架`：已确定职责边界与关键设计点，待展开详细设计。
- `草案`：已有较完整的详细设计，待评审。
- `定稿`：已评审通过，可作为实现依据。
