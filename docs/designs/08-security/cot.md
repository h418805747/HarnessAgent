# CoT（思维链）的产生位置与可校验边界

> 状态：草案｜归属 08-security｜配合 [§3.11 输出侧校验](./README.md#311-输出侧校验output-guard)
> 目的：对齐"思维链由谁产生、发生在哪一层、Agent 能校验什么"，作为输出侧校验的前置说明。

## 0. 一句话结论

**CoT 是模型推理层（LLM 服务的第三层）在自回归解码时生成的 token 序列；它不是独立的业务阶段，也不是 Agent 的内部状态。Agent 只是客户端：在请求侧控制，在响应侧消费与校验。**

## 1. LLM 服务的三层拆解

```text
Agent（Harness）—— 客户端，位于服务之外
   │  HTTPS / SSE：messages、tools、reasoning 参数
   ▼
┌──────────────────────────────────────────────────────┐
│ LLM 服务                                              │
│                                                      │
│ ① 请求校验层   鉴权、配额、请求 schema、输入审核、日志   │
│ ② 服务逻辑层   选模型、套 chat template、reasoning 开关 │
│                与预算、流式封装、计费、输出后处理         │
│ ③ 推理层       tokenize → 前向计算 → 采样 → detokenize │
│                └─ 自回归循环：每个 token 都在这里生成    │
│                   thinking token 与 answer token 同一机制 │
└──────────────────────────────────────────────────────┘
```

| 层 | 能决定什么 | 不能做什么 |
|---|---|---|
| ① 请求校验 | 放不放这个请求进来、参数是否合法、是否超配额 | 看不到、也管不了模型会"想"什么 |
| ② 服务逻辑 | 用哪个模型、开不开 reasoning、预算多少、返回不返回 reasoning 字段、流式怎么封包 | **不产生推理内容**，只控制与搬运 |
| ③ 推理层 | 逐 token 生成 thinking、正文、tool_call | 不决定"要不要暴露给客户端"，那是 ② 的协议选择 |

### 1.1 更精确的术语分层

日常说"模型"时，往往把下面几样东西混在一起。设计文档里建议分开：

| 术语 | 是什么 | 归属 |
|---|---|---|
| **模型架构（architecture）** | 层数、隐藏维度、attention / FFN 结构、词表；决定权重如何映射到 transformer 层 | 模型资产 |
| **参数 / 权重（checkpoint）** | 预训练 + 后训练得到的参数集，是数据，不是程序 | 模型资产 |
| **推理引擎（inference runtime）** | 加载权重、映射到 transformer 层、管理 KV cache、执行前向与采样的程序（如 vLLM / TensorRT-LLM / llama.cpp） | 第三层的执行主体 |
| **推理服务（serving stack）** | 在推理引擎之上加 tokenizer、chat template、批处理调度、流式、计费、限流、路由 | ① + ② + ③ 的整体 |
| **Provider** | 对外提供推理服务的实体（第三方 API 或自建集群） | 服务边界之外的组织/设施 |

推理引擎启动时做的不只是"把权重塞进层"：还要初始化 KV cache、做张量并行 / 流水线切分（TP / PP）、量化、warmup；tokenizer 与 chat template 属于服务层，**不属于权重**——同样的权重配不同 template，行为和 reasoning 暴露形式都可能不同。

所以更准确的说法是：**权重是数据，推理引擎是程序，推理服务是把两者包成可调用接口的完整系统。**

### 1.2 推理引擎内部拆分

PyTorch 是张量/算子框架，HF Transformers 是模型定义与加载库；**自回归循环既不在 transformer 的某一层里，也不在 PyTorch 里**，它在"解码循环"这一层。

```text
┌────────────────────────────────────────────────────────────┐
│ ① 服务层（serving）                                          │
│   API/gRPC、鉴权、限流、路由、计费、流式封装、日志/指标          │
│   决定：reasoning 段返不返回、怎么分通道                        │
├────────────────────────────────────────────────────────────┤
│ ② 引擎/调度层（engine）                                      │
│   请求队列、continuous batching、KV cache、PagedAttention、    │
│   TP/PP、量化、CUDA Graph、speculative decoding               │
│   决定：吞吐与延迟，不决定内容                                  │
├────────────────────────────────────────────────────────────┤
│ ③ 解码循环（decoding loop）                                  │
│   prefill → forward → logits → sample → append → stop        │
│   ← CoT token 段就在这里逐 token 产生                          │
├────────────────────────────────────────────────────────────┤
│ ④ 前向计算（model forward / transformer blocks）              │
│   embedding → N×[attention + MLP + norm] → lm_head → logits  │
│   ← 只算"下一个 token 的概率分布"，没有"CoT 模块"               │
├────────────────────────────────────────────────────────────┤
│ ⑤ 算子/硬件层（PyTorch / CUDA / FlashAttention）              │
└────────────────────────────────────────────────────────────┘
```

| 组件 | 职责 | 与 CoT 的关系 |
|---|---|---|
| **服务层** | API、鉴权、流式、计费 | 决定 reasoning 段是否返回、是否单独成字段 |
| **引擎/调度层** | batching、KV cache、并行切分、量化 | 不决定内容；只决定速度与吞吐 |
| **解码循环** | prefill、逐步 forward、采样、停止 | **CoT token 在这里产生** |
| **前向计算** | transformer 层算 logits | 提供每个位置的 next-token 分布；没有"CoT 层" |
| **tokenizer / chat template** | 文本 ↔ token、特殊 token | 决定 reasoning 段的起止标记 |
| **流解析 / 后处理** | detokenize、分通道 | 把 token 段标成 thinking / answer |

**关键：`forward()` 不做自回归。** `model.forward(ids)` 只是一次前向：输入当前 token 序列，输出每个位置的 logits。真正"不断生成"的是外面的循环：

```python
past = None
ids = tokenize(prompt)

while not stopped:
    logits, past = model(ids, past_key_values=past)   # ④ 前向
    next_id = sample(logits[:, -1])                   # ③ 采样
    ids.append(next_id)
    emit(next_id)                                     # 流式输出
    stopped = check_stop(next_id)
```

- HF `transformers` 的 `generate()` 把这个循环封装了；
- vLLM / TensorRT-LLM / SGLang 用自己的高性能循环**替掉** `generate()`，但循环语义不变；
- `LogitsProcessor`、`StoppingCriteria`、`Sampler` 都是这个循环上的周边件，不是网络层。

所以 **CoT 不在 transformer 的某一层，而在"解码循环 + 采样"这一步**。transformer 层只负责"给定上文，下一个 token 的概率分布是什么"；循环负责把这个分布变成一串实际 token。

**CoT 的三层含义，别混在一起**：

| 含义 | 发生在哪 | 是否可观测 |
|---|---|---|
| **隐式推理（latent）** | transformer 的前向计算里，隐状态 / attention 始终在算 | 不可观测，也不是文本 |
| **显式 CoT（verbalized）** | 解码循环逐 token 吐出 | 只有返回文本时才可观测 |
| **被标记的 reasoning 段** | tokenizer / chat template / 流解析 | 是协议层的"分通道"，不是生成机制 |

**围绕框架的外面程序**：

| 程序 | 作用 | 影响 CoT 吗 |
|---|---|---|
| batching / KV cache / PagedAttention | 吞吐与显存 | 不影响内容 |
| TP / PP / 量化 / CUDA Graph | 多卡与性能 | 不影响内容（量化可能轻微影响分布） |
| speculative decoding | 一次猜多个 token 再验证 | 逻辑上仍是自回归，不影响语义 |
| tokenizer / chat template | 消息 → token、特殊 token | **影响 reasoning 段的边界与格式** |
| 输入/输出审核 | 服务侧安全过滤 | 可能截断或改写，属于服务层策略 |
| 日志 / 指标 / 计费 | 可观测性 | 不影响内容 |

一句话：

> **PyTorch 管算子，Transformers 管模型定义与加载，解码循环管"逐 token 生成"，引擎调度管性能，服务层管协议与可见性。CoT 是解码循环产生的一段 token，不是 transformer 里的一个层。**

> 配套示例代码见 [cot-code.py](./cot-code.py)：按「向量 → token / CoT 是否必然存在 / thinking-answer 五种区分方式 / 总结」组织，附输出守卫挂载点与可运行演示。

## 2. CoT 到底发生在哪一层

推理引擎的核心是一个自回归循环：

```text
prompt tokens
  → forward()（按 transformer 层级做前向计算）
  → logits
  → sample()（温度 / top-p / 约束）
  → 追加一个 token
  → 重复，直到 stop 条件
```

- **thinking token 和 answer token 走的是同一个循环、同一套参数、同一个采样器**；区别只在"生成顺序"和"协议上被放到哪个通道"。
- "思考结束、开始回答"在引擎里通常不是硬边界，而是以下之一：
  - 特殊 token / 解析器约定的分隔；
  - 模型在训练中学到的格式转换；
  - Agent 侧把一次生成拆成两次请求（先规划、再回答）。
- 因此 CoT 不是第三层里的一个子模块，而是**第三层解码循环产生的一段 token 前缀**。

> 补充：模型的内部计算（隐状态、注意力）始终存在；CoT 只是其中被" verbalize "出来的那部分。不可见的推理并不等于没有发生。

### 2.1 训练侧：thinking 行为是怎么来的

推理引擎负责"生成"，但不负责"为什么会有 thinking 段"。后者是训练侧塑造的行为，而且不是单一阶段：

| 阶段 | 做什么 | 对 thinking 行为的作用 |
|---|---|---|
| **预训练** | 大规模 next-token 预测 | 打基础；语料里的代码、数学题解、论坛讨论会带来一些"分步推理"的雏形，但不是有意设计的 thinking 模式 |
| **SFT（cold start / 指令微调）** | 用带格式的示范数据做 teacher forcing | **学格式**：什么时候输出 thinking 开始 / 结束标记、什么时候转答案；也学基本的推理套路 |
| **RL（RLVR / GRPO / PPO）** | 用可验证奖励训练（答案对不对、格式对不对） | **学策略**：探索更长的推理链、自我检查、换解法；格式奖励会强化特殊 token 的使用 |
| **拒绝采样 + SFT** | 模型自己生成大量轨迹，筛掉错的，留下对的再训练 | 固化高质量长 CoT，把 RL 探索到的好轨迹变成稳定行为 |
| **蒸馏** | 用强模型的 CoT 轨迹训练小模型 | 小模型获得类似的格式与推理行为，不必自己从头 RL |
| **偏好优化（DPO / RLAIF）** | 人类或模型偏好 | 主要管风格、安全、有用性；不是推理能力的核心来源 |
| **推理时约束解码** | grammar / JSON schema / 强制前缀 | 只保证**格式**，不教内容；属于推理期手段，不是训练 |

**一句话**：格式靠 SFT 学，推理能力靠 RL 练，稳定性靠拒绝采样 / 蒸馏固化；预训练只是底座。

**两个典型例子**：

- **DeepSeek-R1**：cold start SFT（长 CoT 示范）→ reasoning RL（GRPO，奖励 = 答案正确性 + 格式）→ 拒绝采样 + SFT → 全场景 RL（有用性 / 无害性）。
- **Qwen3**：在同一个模型里同时训练 thinking / non-thinking 两种模式，推理时由 chat template 的 `enable_thinking` 控制是否插入 thinking 段；部分版本支持 thinking budget。

**"训练 token 按格式输出"具体指**：

1. 特殊 token 先加入 tokenizer 词表；
2. SFT 数据的目标序列里就包含这些 token，模型用 teacher forcing 逐 token 预测，学会在什么上下文后输出它们；
3. RL 的格式奖励再强化：结构不对扣分，结构对加分；
4. 推理时 chat template / API 参数构造不同前缀，触发模型学过的对应模式。

所以"thinking 开关"通常**不是切换一套权重**，而是改变 prompt 上下文 + 模型学过的双模式行为；少数 provider 会用独立模型或独立 endpoint，但机制上仍是"训练时学会、推理时触发"。

**对 HarnessAgent 的含义**：

- thinking 是模型训练出来的行为，不是 Agent 运行时的一个模块；Agent 只能控制开关、预算、模板和采样参数。
- 格式可以靠训练和约束解码保证，但**内容仍是概率性的**；§3.11 不能假设"模型一定按格式想、想的内容一定安全"。
- 第三方 Provider 的训练过程不在信任域内；能做的仍然是在边界上校验返回的 reasoning / content 流。

> 本节只说明行为来源，训练流程本身不属于 HarnessAgent 的设计范围。

## 3. Agent 侧与模型侧的职责边界

| 层 | 谁负责 | 具体内容 | 校验对象 |
|---|---|---|---|
| **Agent 编排层** | Runtime / Agent Loop | 是否开启推理、推理预算、迭代次数、工具选择、观察结果回灌 | **策略与动作**，不是文本 |
| **模型推理层** | LLM Provider | 逐 token 生成 thinking / 正文 / tool_call | 只有 provider 返回文本时才可校验 |
| **展示层** | Interface | "思考中"、折叠块、进度 | 不产生内容 |

"思维链在 Agent 端做"只对第一层成立：Agent 决定"要不要想、想多久、想完做什么"，但"想的内容"由模型生成。ReAct 式输出里的 `Thought:` 即使由 Agent 的循环结构诱导，文本仍然是模型生成的，校验点仍在模型输出侧。

## 4. CoT 的可见性形态

| 形态 | 典型表现 | Agent 能否校验 |
|---|---|---|
| **visible** | Anthropic thinking blocks、DeepSeek `reasoning_content` | 可以，按流式边界滚动检测 |
| **summary** | 只返回推理摘要 | 只能校验摘要，看不到原文 |
| **opaque / encrypted** | 返回加密 reasoning 片段，客户端不可读 | 不能 |
| **none** | 只返回最终 answer | 不能 |

对应能力标记：

```ts
interface ModelCapabilities {
  reasoningStream: "visible" | "summary" | "opaque" | "none";
}
```

Runtime 据此决定 thinking 阶段校验是否生效；**不可见时直接降级到正文与动作侧校验，不能假设校验过思维链**。

## 5. 对 §3.11 三段式方案的影响

| 方案表述 | 精确表述 |
|---|---|
| "思考阶段开始就校验" | 从**第一个可见 reasoning token 到达**开始滚动校验；`opaque` / `none` 则跳过本阶段 |
| "thinking 有问题就中断重开" | 取消本次请求 / SSE + 丢弃前缀 + 带纠正提示重新发起调用；不是 Agent 内部停线程 |
| "thinking 结束后开始输出内容" | 模型侧可能是一次连续生成，只是协议上把前缀标为 thinking；Agent 看到的是同一条流的分段 |
| "缓存一句再输出" | 正确；代码块 / 命令 / tool_call 参数按结构闭合为单位缓存 |

重开的代价与限制：

- 已生成的推理 token 可能照样计费；
- prompt 不变时，重开大概率得到相似分布的结果；必须带纠正提示或换策略；
- 因此只在**注入 / 越权**这类高置信信号上重开，内容合规问题不重开。

## 6. 两种部署形态的安全差异

| 形态 | ① / ② 是否在信任域内 | 可做的校验 |
|---|---|---|
| **调用第三方 Provider** | 否 | 只能校验跨边界返回的文本与动作；看不到 service 内部 |
| **自建推理服务** | 是 | 可在服务侧加输入/输出审核、约束解码、日志与审计；但服务本身进入 TCB 讨论范围 |

HarnessAgent 当前设计假设**调用第三方 Provider**，因此 §3.11 的校验点落在 Agent 与 Provider 的边界上；自建形态作为可选部署另行讨论。

## 7. 对 §3.11 的结论

1. thinking 阶段校验是**可选能力**，由 `reasoningStream` 决定是否启用。
2. thinking 阶段只做凭据 / PII 脱敏与注入 / 越权信号检测；**不做内容合规重开**。
3. 面向用户的正文按"可展示边界"缓冲放行；已展示内容尽量 `replace` / `retract`。
4. 全文终审可异步，但不能作为唯一防线。
5. 动作安全始终由 PEP 判定，与文本合规互不替代。

## 8. 术语与待定

- `reasoning` / `thinking` / `CoT` 三个词在不同 Provider 文档里含义不完全一致，本文按"模型生成的推理文本"统一使用 CoT。
- reasoning token 是否计入计费、是否计入上下文预算，按 Provider 协议处理，需在 Model Adapter 中归一化。
- `summary` 形态的校验价值有限，是否纳入首版待定。
