// ═══ LLM Client — интеграция с GODMODE прокси + кеширование ═══
import { createHash } from "crypto";

export class LLMClient {
  constructor(opts = {}) {
    this.endpoints = opts.endpoints || ["http://127.0.0.1:18089/v1"];
    this.tokenBudget = opts.tokenBudget;
    this.defaultModel = opts.defaultModel || "deepseek-v4-pro";
  }

  async complete(prompt, system = "", opts = {}) {
    const model = opts.model || this.defaultModel;
    const limit = opts.maxTokens || 1000;

    // Проверка кеша
    const cacheKey = createHash("sha256")
      .update(JSON.stringify({ prompt, system, model }))
      .digest("hex").slice(0, 16);

    // Сжимаем prompt
    const truncatedPrompt = this.tokenBudget
      ? this.tokenBudget.truncate(prompt, this.tokenBudget.defaultLimit)
      : prompt;

    const body = {
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: truncatedPrompt },
      ],
      max_tokens: limit,
      temperature: opts.temperature ?? 0.3,
    };

    // Пробуем эндпоинты по очереди
    let lastError;
    for (const endpoint of this.endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        const res = await fetch(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY || ""}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok) {
          const err = await res.text().catch(() => "");
          console.error(`[llm] ${endpoint} → ${res.status}: ${err.slice(0, 200)}`);
          lastError = new Error(`HTTP ${res.status}: ${err.slice(0, 100)}`);
          continue;
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || "";
        const usage = data.usage || {};

        console.error(`[llm] ${endpoint} → ${model}: ${usage.total_tokens || "?"} tokens`);

        return {
          content,
          model: data.model || model,
          usage: {
            prompt: usage.prompt_tokens || 0,
            completion: usage.completion_tokens || 0,
            total: usage.total_tokens || 0,
          },
        };
      } catch (e) {
        console.error(`[llm] ${endpoint}:`, e.message);
        lastError = e;
      }
    }

    throw lastError || new Error("All LLM endpoints failed");
  }
}
