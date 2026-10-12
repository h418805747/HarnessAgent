# 06 Skills 技能

> 状态：骨架｜对应概要设计 §4

## 目标

以文件包形式承载可复用的高阶能力，按需渐进注入模型上下文，并支持从成功轨迹自动生成与改进。

## 范围

**做**：
- 技能包格式（`SKILL.md` + 资源/脚本/模板）
- 技能发现、命名空间、优先级（project > user > bundled）
- 渐进披露加载（先给元数据，命中后再注入正文）
- 技能调用与执行
- 自生成 / 自改进（从成功轨迹沉淀、迭代）

**不做**：
- 不做底层工具执行（技能内部通过 Tools 调用）
- 不做长期记忆（技能是能力，记忆是知识）

## 关键设计点（草案）

- **渐进披露**：默认只把技能名 + 描述注入上下文，命中后再加载 `SKILL.md`，控制 token 消耗。
- **文件即契约**：技能以目录/文件形式存在，便于版本管理与人工编辑，与"定制不被覆盖"原则一致。
- **自生成闭环**：成功轨迹 → 提炼候选技能 → 校验 → 落盘；失败可回滚。
- **与 Memory 的边界**：Skills 存"怎么做"，Memory 存"发生过什么/用户偏好"。

## 对外接口（草案）

```text
ISkillRegistry  # discover() / list() / get(name) / load(name)
ISkill          # {name, description, path, metadata, resources}
SkillLoader     # progressive_load(name) -> SkillBody
SkillMiner      # mine(trajectory) -> CandidateSkill   （异步）
```

## 依赖

- 内核、Session（轨迹来源）、Tools（技能执行）、Security（技能脚本的沙箱与权限）

## 待定问题

- 自动生成技能的触发条件与质量校验标准。
- 技能与插件的关系：技能是否可作为轻量插件被分发。
- 技能脚本的信任与签名机制。
