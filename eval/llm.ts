/**
 * 共享 LLM 客户端（OpenAI 兼容）+ token 计量。
 * 默认走 pi 运行时网关（$PI_RUNTIME_GATEWAY_URL），密钥 $LITELLM_API_KEY。
 */
export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class LlmClient {
  readonly usage: Usage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private readonly base: string;
  private readonly key: string;
  readonly model: string;

  constructor(base: string, key: string, model: string) {
    this.base = base;
    this.key = key;
    this.model = model;
  }

  static fromEnv(modelOverride?: string): LlmClient {
    const gateway = process.env.PI_RUNTIME_GATEWAY_URL ?? "https://llm.ubichat.ubisoft.org";
    const base = process.env.EVAL_BASE_URL ?? `${gateway}/v1`;
    const key = process.env.EVAL_API_KEY ?? process.env.LITELLM_API_KEY ?? "";
    const model = modelOverride ?? process.env.EVAL_MODEL ?? "deepseek-v4-1-flash";
    if (!key) throw new Error("缺少 LLM 密钥：设置 EVAL_API_KEY 或 LITELLM_API_KEY");
    return new LlmClient(base.replace(/\/+$/, ""), key, model);
  }

  async chat(system: string, user: string, maxTokens = 4000): Promise<string> {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const d = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const u = d.usage;
    this.usage.calls++;
    this.usage.promptTokens += u?.prompt_tokens ?? 0;
    this.usage.completionTokens += u?.completion_tokens ?? 0;
    this.usage.totalTokens += u?.total_tokens ?? 0;
    return d.choices?.[0]?.message?.content ?? "";
  }

  usageLine(): string {
    const u = this.usage;
    return `LLM 调用 ${u.calls} 次 · prompt ${u.promptTokens} · completion ${u.completionTokens} · 合计 ${u.totalTokens} tokens`;
  }
}
