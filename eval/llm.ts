/**
 * 共享 LLM 客户端（OpenAI 兼容）+ token 计量。
 * 配置注入优先级（高→低）：
 *   1. EVAL_BASE_URL / EVAL_API_KEY / EVAL_MODEL（或 CLI --model）显式指定
 *   2. ZAI_CODING_CN_API_KEY → z.ai coding 端点（GLM；模型默认取 PI_MODEL，兜底 glm-5.3）
 *   3. OPENAI_BASE_URL + OPENAI_API_KEY（OpenAI 兼容网关）
 *   4. pi 运行时网关 $PI_RUNTIME_GATEWAY_URL + LITELLM_API_KEY
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
    const zai = process.env.ZAI_CODING_CN_API_KEY;
    const gateway = process.env.PI_RUNTIME_GATEWAY_URL ?? "https://llm.ubichat.ubisoft.org";
    const base =
      process.env.EVAL_BASE_URL ??
      (zai ? "https://api.z.ai/api/coding/paas/v4" : undefined) ??
      process.env.OPENAI_BASE_URL ??
      `${gateway}/v1`;
    const key =
      process.env.EVAL_API_KEY ??
      process.env.LITELLM_API_KEY ??
      zai ??
      process.env.OPENAI_API_KEY ??
      "";
    const model =
      modelOverride ??
      process.env.EVAL_MODEL ??
      (zai && process.env.PI_MODEL?.startsWith("glm") ? process.env.PI_MODEL : undefined) ??
      (zai ? "glm-5.3" : undefined) ??
      "deepseek-v4-1-flash";
    if (!key)
      throw new Error(
        "缺少 LLM 密钥：设置 EVAL_API_KEY、LITELLM_API_KEY、ZAI_CODING_CN_API_KEY 或 OPENAI_API_KEY",
      );
    return new LlmClient(base.replace(/\/+$/, ""), key, model);
  }

  async chat(system: string, user: string, maxTokens = 4000): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    };
    // EVAL_THINKING=disabled → 关闭深度思考（glm 系列直出，延迟/token 大幅下降）
    if (process.env.EVAL_THINKING === "disabled") body.thinking = { type: "disabled" };
    // 网络重试：千次级长跑必需（ECONNRESET/超时/429/5xx）
    const delays = [2000, 8000, 30000, 60000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const res = await fetch(`${this.base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
          body: JSON.stringify(body),
        });
        if (res.ok) {
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
        if (![429, 500, 502, 503, 504].includes(res.status) || attempt === delays.length)
          throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
        lastErr = new Error(`LLM ${res.status}`);
      } catch (e) {
        lastErr = e;
        if (attempt === delays.length) break;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    throw lastErr;
  }

  usageLine(): string {
    const u = this.usage;
    return `LLM 调用 ${u.calls} 次 · prompt ${u.promptTokens} · completion ${u.completionTokens} · 合计 ${u.totalTokens} tokens`;
  }

  /** 向量嵌入（OpenAI 兼容 /embeddings；glm 网关用 embedding-3） */
  async embed(texts: string[], model = "embedding-3"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${this.base}/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
            body: JSON.stringify({ model, input: batch }),
          });
          if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const d = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
          const rows = (d.data ?? []).sort((a, b) => a.index - b.index);
          if (rows.length !== batch.length) throw new Error(`embed 返回 ${rows.length}/${batch.length}`);
          out.push(...rows.map((r) => r.embedding));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;
    }
    return out;
  }
}
