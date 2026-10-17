import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env files written by `stripe projects env --pull` (or by hand) without a dependency.
for (const f of [".env", ".env.local"]) {
  const p = resolve(process.cwd(), f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  createosKey: process.env.CREATEOS_SANDBOX_API_KEY ?? process.env.CREATEOS_API_KEY ?? "",
  createosBaseUrl: process.env.CREATEOS_SANDBOX_BASE_URL ?? "https://api-eu.sb.createos.sh",
  stripeKey: process.env.STRIPE_SECRET_KEY ?? "",
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.venice.ai/api/v1",
  llmKey: process.env.LLM_API_KEY ?? process.env.VENICE_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",
  shape: process.env.SANDBOX_SHAPE ?? "s-1vcpu-1gb",
  universes: Number(process.env.UNIVERSES ?? 3),
  months: Number(process.env.SIM_MONTHS ?? 6),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),
  // how many universe forks may run at once (plan concurrency minus the paused T0 base)
  parallel: Number(process.env.PARALLEL_UNIVERSES ?? 3),
  need,
};
