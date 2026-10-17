import { config } from "./config.js";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

export async function chat(messages: Msg[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.llmKey}` },
        body: JSON.stringify({
          model: config.llmModel,
          messages,
          max_tokens: opts.maxTokens ?? 8000,
          temperature: opts.temperature ?? 0.2,
          venice_parameters: { include_venice_system_prompt: false },
        }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error("LLM returned no content");
      return text;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Pull a fenced block (```python name.py ...```) out of a model reply. */
export function codeBlock(text: string, name?: string): string | null {
  const re = /```(?:python|py)?[ \t]*([^\n`]*)\n([\s\S]*?)```/g;
  const blocks: { label: string; body: string }[] = [];
  for (const m of text.matchAll(re)) blocks.push({ label: m[1].trim(), body: m[2] });
  if (!blocks.length) return null;
  if (name) {
    const hit = blocks.find((b) => b.label.includes(name)) ?? blocks.find((b) => b.body.includes(`# ${name}`));
    if (hit) return hit.body.trimEnd() + "\n";
  }
  return blocks[0].body.trimEnd() + "\n";
}

export function jsonBlock<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw) as T;
}
