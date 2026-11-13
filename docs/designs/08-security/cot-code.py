"""
cot-code.py — CoT 的解码、分通道与校验挂载点（设计参考）

阅读顺序与上一轮回答保持一致：

  1. 前向出来的是向量，解码把向量变成 token？
  2. CoT 在解码阶段一定存在吗？
  3. thinking / answer 区分的代码
     ① HF Transformers：它本身不区分
     ② Chat template：在生成前插入标记
     ③ 服务端 parser：vLLM 的做法
     ④ API 协议层：Anthropic 直接给块
     ⑤ Agent 侧兜底：两次调用
  4. 一句话总结
  附 A：输出守卫挂载点（对应 08-security §3.11）
  附 B：可直接运行的最小演示

依赖说明：
- 核心状态机零依赖，可直接运行 `python cot-code.py`
- 标注 `pip install` 的函数需要对应依赖，未安装时不会被执行
- 特殊 token 名称因模型而异，示例中的 `<|thinking|>` / `<|/thinking|>`
  只是占位；实际应从 tokenizer_config.json 的 additional_special_tokens 读取
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterator, Literal, Optional

Channel = Literal["reasoning", "content", "tool_call"]


# ============================================================
# 1. 前向出来的是向量，解码把向量变成 token？
# ============================================================

# 方向对，中间要拆成四步，不能一步到位：
#
#   hidden state（d_model 维向量，每个位置一个）
#      ↓ lm_head（线性投影）
#   logits（vocab_size 维向量，比如 15 万维）
#      ↓ softmax / 温度 / top-p
#   概率分布（每个词表 token 一个概率）
#      ↓ 采样
#   token id（一个整数，比如 12345）
#      ↓ tokenizer.decode
#   文本（可能是一个词、半个词、标点或特殊 token）
#
# 几个容易混的点：
# - “解码循环”的 decode 和“把向量解码成文字”不是一回事；
# - 模型不是把向量“翻译”成人类语义，lm_head 只是投影到词表空间；
# - 一个 token 不等于一个词；
# - 特殊 token 也走同一套 logits → 采样流程。


def sample_next_token_id(hidden, lm_head, temperature: float = 1.0) -> int:
    """
    示意：hidden 是 d_model 维向量，lm_head 是 (vocab_size, d_model) 矩阵。

    真实实现中：
    - hidden 来自 transformer 最后一层的最后一个位置
    - logits = lm_head(hidden) → vocab_size 维
    - softmax / 温度 / top-p 后采样出 token id
    - tokenizer.decode(token_id) 才得到文本
    """
    import numpy as np

    logits = lm_head @ hidden
    logits = logits / temperature
    logits = logits - logits.max()
    probs = np.exp(logits)
    probs = probs / probs.sum()
    return int(np.random.choice(len(probs), p=probs))


def vector_to_text_pipeline_demo() -> None:
    """
    伪代码式说明（不依赖 torch）：

        out = model(input_ids, output_hidden_states=True)
        hidden = out.hidden_states[-1]          # [B, T, d_model]
        logits = model.lm_head(hidden)          # [B, T, vocab]
        probs = softmax(logits[:, -1] / T)
        next_id = sample(probs)                 # 整数 token id
        text = tokenizer.decode(next_id)         # id → 文本
    """
    print("hidden vector -> logits -> token id -> tokenizer.decode -> text")


# ============================================================
# 2. CoT 在解码阶段一定存在吗？
# ============================================================

# 不一定。要区分“隐式计算”和“显式 CoT”。

COT_PRESENCE_TABLE = """
| 情形                                      | 显式 CoT 是否存在                     |
|-------------------------------------------|---------------------------------------|
| 普通 instruct 模型，未要求 step-by-step     | 通常没有；直接给答案                   |
| 普通模型 + “请一步步思考”                  | 有，但只是普通正文 token，不是独立通道 |
| reasoning 模型 + thinking 开启             | 有，模型被训练成先输出 reasoning 段    |
| reasoning 模型 + thinking 关闭             | 没有，或大幅缩短                       |
| reasoning 预算耗尽 / 被截断                | 可能只有部分思考，直接转答案           |
| provider 隐藏 / 加密 reasoning             | 内部可能有，客户端不可见               |
| Agent 分两次调用（先规划、再回答）          | 有，但属于 Agent 编排层                |
"""

COT_PRESENCE_NOTES = """
- 隐式推理（latent）一直在发生，因为每层 attention / MLP 都在算；
- 显式 CoT 是条件性的，由模型训练、prompt、template、reasoning 开关和采样共同决定；
- 不能假设“解码阶段一定有可校验的 thinking”，这正是 reasoningStream 能力标记存在的原因。
"""


def show_cot_presence() -> None:
    print(COT_PRESENCE_TABLE)
    print(COT_PRESENCE_NOTES)


# ============================================================
# 3. thinking / answer 区分的代码
# ============================================================

# 区分不在 transformer 层，而在三处：
#   训练格式 / 特殊 token、chat template、服务端 parser / API 字段。

# ------------------------------------------------------------
# ① HF Transformers：它本身不区分
# ------------------------------------------------------------

# 占位 token；实际以目标模型的 tokenizer_config.json 为准。
# DeepSeek-R1 / Qwen3 / 其他 reasoning 模型使用的特殊 token 各不相同。
START_TOKEN = "<|thinking|>"
END_TOKEN = "<|/thinking|>"


def split_full_text(
    text: str,
    start_token: Optional[str] = None,
    end_token: Optional[str] = None,
) -> tuple[str, str]:
    """
    对“完整文本”做一次性切分，返回 (reasoning, answer)。

    注意：字符串匹配只适合非流式场景；流式请用 TokenReasoningSplitter。
    """
    if start_token and start_token in text:
        text = text.split(start_token, 1)[1]
        if end_token and end_token in text:
            reasoning, _, answer = text.partition(end_token)
            return reasoning, answer
        # 只有开始标记、没有结束标记：视为推理被截断
        return text, ""

    if end_token and end_token in text:
        reasoning, _, answer = text.partition(end_token)
        return reasoning, answer

    return "", text


def hf_transformers_generate_example(
    model_name: str = "deepseek-ai/DeepSeek-R1",
    question: str = "9.11 和 9.9 哪个大？",
) -> tuple[str, str]:
    """
    pip install transformers torch accelerate

    关键点：generate() 只负责生成 token 序列，不区分哪段是 thinking；
    它只认 EOS / stop token。区分发生在模板、特殊 token 和后续 parser。
    """
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(model_name, device_map="auto")

    messages = [{"role": "user", "content": question}]
    prompt = tok.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=False
    )
    inputs = tok(prompt, return_tensors="pt").to(model.device)

    out = model.generate(**inputs, max_new_tokens=1024, do_sample=True)
    generated = out[0][inputs["input_ids"].shape[1]:]
    # skip_special_tokens=False：保留分隔 token，否则无法切分
    text = tok.decode(generated, skip_special_tokens=False)

    return split_full_text(text, START_TOKEN, END_TOKEN)


# ------------------------------------------------------------
# ② Chat template：在生成前插入标记
# ------------------------------------------------------------

# 以简化模板示意（真实模板因模型而异）：
# 模型看到 <|thinking|> 后开始输出推理；训练让它学会在合适位置输出
# <|/thinking|>，然后转答案。Qwen3 这类模型通过 enable_thinking 参数
# 控制模板是否插入 thinking 段。

CHAT_TEMPLATE_EXAMPLE = """\
{% if add_generation_prompt %}
  {{ '<|assistant|>' }}
  {% if enable_thinking %}
    {{ '<|thinking|>' }}
  {% endif %}
{% endif %}\
"""


# ------------------------------------------------------------
# ③ 服务端 parser：vLLM 的做法
# ------------------------------------------------------------

# 启动时指定 reasoning parser：
#
#   vllm serve deepseek-ai/DeepSeek-R1 --reasoning-parser deepseek_r1
#
# 它会在流式输出时把 token 流拆成两个字段。

VLLM_CONTRACT = """
# 非流式响应
{
  "choices": [{
    "message": {
      "role": "assistant",
      "reasoning_content": "用户问的是 9.11 和 9.9 的大小比较……",
      "content": "9.9 更大。"
    }
  }]
}

# 流式 delta
{"choices":[{"delta":{"reasoning_content":"用户问的是"}}]}
{"choices":[{"delta":{"content":"9.9 更大"}}]}
"""


def show_vllm_contract() -> None:
    print(VLLM_CONTRACT)


class TokenReasoningSplitter:
    """
    推荐：按 token id 做状态机切分，避免字符串 find 在流式 delta 中被截断。

    start_id / end_id 通过 tokenizer.convert_tokens_to_ids(...) 获得。
    每次 feed() 吃一个 token id：
    - 分隔 token 本身返回 None
    - 其余 token 返回 (channel, token_id)
    - 调用方按 channel 累积 token ids，最后统一 tokenizer.decode()
    """

    def __init__(self, start_id: int, end_id: int) -> None:
        self.start_id = start_id
        self.end_id = end_id
        self.state: Literal["before", "reasoning", "answer"] = "before"

    def feed(self, token_id: int) -> Optional[tuple[Channel, int]]:
        if self.state == "before":
            if token_id == self.start_id:
                self.state = "reasoning"
                return None
            return "content", token_id

        if self.state == "reasoning":
            if token_id == self.end_id:
                self.state = "answer"
                return None
            return "reasoning", token_id

        return "content", token_id


@dataclass
class SplitResult:
    reasoning_ids: list[int]
    content_ids: list[int]


def collect_by_channel(
    token_ids: list[int], splitter: TokenReasoningSplitter
) -> SplitResult:
    result = SplitResult(reasoning_ids=[], content_ids=[])
    for token_id in token_ids:
        span = splitter.feed(token_id)
        if span is None:
            continue
        channel, tid = span
        if channel == "reasoning":
            result.reasoning_ids.append(tid)
        else:
            result.content_ids.append(tid)
    return result


# 对照：文本级切分器（仅非流式）
#
# 不要用它处理流式 delta：特殊 token 可能在两个 delta 之间被切断，
# 字符串 find 会漏判；生产实现应使用 token 级状态机。
class TextReasoningSplitter:
    def __init__(self, start_token: str, end_token: str) -> None:
        self.start_token = start_token
        self.end_token = end_token

    def split(self, text: str) -> tuple[str, str]:
        return split_full_text(text, self.start_token, self.end_token)


# ------------------------------------------------------------
# ④ API 协议层：Anthropic 直接给块
# ------------------------------------------------------------

def anthropic_example(question: str = "9.11 和 9.9 哪个大？") -> tuple[str, str]:
    """
    pip install anthropic

    Anthropic Messages API 把 thinking 作为独立 content block 返回，
    不需要客户端做特殊 token 解析。
    """
    from anthropic import Anthropic

    client = Anthropic()
    resp = client.messages.create(
        model="claude-sonnet-5-5",  # 替换为实际模型 id
        max_tokens=1024,
        thinking={"type": "enabled", "budget_tokens": 1024},
        messages=[{"role": "user", "content": question}],
    )

    reasoning, answer = "", ""
    for block in resp.content:
        if block.type == "thinking":
            reasoning += block.thinking
        elif block.type == "text":
            answer += block.text

    return reasoning, answer


# ------------------------------------------------------------
# ⑤ Agent 侧兜底：两次调用
# ------------------------------------------------------------

def agent_two_call_example(
    llm_complete: Callable[[str], str],
    question: str,
) -> tuple[str, str]:
    """
    如果 provider 既不返回 reasoning、也没有特殊 token，Agent 可以自己
    制造分界：第一次只要推理，第二次只要答案。

    这时 thinking / answer 的区分发生在请求边界，不在单次 decode 内部。
    """
    reasoning = llm_complete(
        f"只输出推理过程，不要给最终答案。问题：{question}"
    )
    answer = llm_complete(
        f"基于以下推理给出最终答案。\n"
        f"推理：\n{reasoning}\n"
        f"问题：{question}"
    )
    return reasoning, answer


# ============================================================
# 4. 一句话总结
# ============================================================

SUMMARY = """
前向算的是隐状态向量，lm_head + 采样把它变成 token id，tokenizer 再把 id 变成文本。
CoT 是否出现取决于模型、模板和开关，不是解码的必然产物。
thinking / answer 的区分不在 transformer 层，而在特殊 token + chat template +
服务端 parser / API 字段；最稳的实现是 token 级状态机，不是字符串切分。
"""


def show_summary() -> None:
    print(SUMMARY)


# ============================================================
# 附 A：输出守卫挂载点（对应 08-security §3.11）
# ============================================================

@dataclass(frozen=True)
class ModelDelta:
    """Model Adapter 归一化后的流式增量。"""

    channel: Channel
    text: str = ""
    token_id: Optional[int] = None


def guarded_stream(
    deltas: Iterator[ModelDelta],
    check_reasoning: Callable[[str], Optional[str]],
    check_content: Callable[[str], Optional[str]],
) -> Iterator[ModelDelta]:
    """
    示意：thinking 与 answer 走不同的守卫策略。

    - reasoning：脱敏 + 注入/越权信号检测，内容合规问题只记录
    - content：按“可展示边界”缓冲后检测，未通过则不放行
    - tool_call：不在这里处理，交 Security PEP 的 check(action)
    """
    for delta in deltas:
        if delta.channel == "reasoning":
            safe = check_reasoning(delta.text)
            if safe:
                yield ModelDelta("reasoning", safe)
        elif delta.channel == "content":
            safe = check_content(delta.text)
            if safe:
                yield ModelDelta("content", safe)
        elif delta.channel == "tool_call":
            # 动作安全由 PEP 负责，不在这里做文本判定
            yield delta


# ============================================================
# 附 B：可直接运行的最小演示
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("1. 向量 → token 的流水线")
    print("=" * 60)
    vector_to_text_pipeline_demo()

    print("\n" + "=" * 60)
    print("2. CoT 一定存在吗？")
    print("=" * 60)
    show_cot_presence()

    print("=" * 60)
    print("3. token 级切分")
    print("=" * 60)
    # 用假 token id 演示状态机：100 = start，101 = end
    START_ID, END_ID = 100, 101
    splitter = TokenReasoningSplitter(START_ID, END_ID)
    raw_tokens = [1, 2, START_ID, 3, 4, END_ID, 5, 6]
    for token_id in raw_tokens:
        span = splitter.feed(token_id)
        if span is not None:
            print(" ", span)

    print("\n完整文本切分：")
    text = f"{START_TOKEN}先比较整数部分。{END_TOKEN}9.9 更大。"
    print(" ", split_full_text(text, START_TOKEN, END_TOKEN))

    print("\n" + "=" * 60)
    print("4. 一句话总结")
    print("=" * 60)
    show_summary()
