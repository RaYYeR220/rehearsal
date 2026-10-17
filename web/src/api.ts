export type UStatus = "queued" | "coding" | "forking" | "running" | "fixing" | "passed" | "violations" | "failed" | "pausing" | "awaiting_approval" | "applying" | "applied" | "refused";

export interface Attempt {
  n: number;
  sandboxId?: string;
  sha256?: string;
  code: string;
  exitCode?: number;
  error?: string | null;
  violations?: string[];
  refused?: boolean;
  diagnosis?: string;
  startedAt: number;
  endedAt?: number;
  month?: number;
}

export interface Metrics {
  revenue_by_month: number[];
  baseline_by_month: number[];
  revenue_total: number;
  baseline_total: number;
  mrr_before: number;
  mrr_after: number;
  customers: number;
  customers_increased: number;
  max_increase_pct: number;
  proration_lines: number;
  proration_total: number;
  failed_invoices: number;
}

export interface Universe {
  key: string;
  name: string;
  approach: string;
  status: UStatus;
  sandboxId?: string;
  url?: string;
  attempts: Attempt[];
  report?: { metrics?: Metrics; violations?: string[]; timeline?: any[]; strategy_sha256?: string; guard_calls?: number; error?: string };
}

export interface Ev {
  t: number;
  kind: string;
  text: string;
  universe?: string;
  data?: any;
}

export interface Rehearsal {
  id: string;
  intent: string;
  createdAt: number;
  phase: string;
  baseId?: string;
  egress?: { url: string; status: string; reachable: boolean }[];
  world?: { subscriptions: any[]; prices: any[]; frozen_at: number };
  policy: string[];
  checks?: string;
  universes: Universe[];
  events: Ev[];
  approval?: { universe: string; sha256: string; subscriptions: string[]; at: number; sandboxId: string };
  apply?: any;
  refusals: { at: number; universe?: string; why: string; source: string }[];
  error?: string;
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  start: (intent: string) => fetch("/api/rehearsals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent }) }).then((r) => j<{ id: string }>(r)),
  get: (id: string) => fetch(`/api/rehearsals/${id}`).then((r) => j<Rehearsal>(r)),
  replay: (id: string) => fetch(`/api/replays/${id}`).then((r) => j<Rehearsal>(r)),
  replays: () => fetch(`/api/replays`).then((r) => j<string[]>(r)),
  approve: (id: string, universe: string) => fetch(`/api/rehearsals/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ universe }) }).then((r) => j<Rehearsal>(r)),
  apply: (id: string, tamper = false) => fetch(`/api/rehearsals/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tamper }) }).then((r) => j<{ apply: any; rehearsal: Rehearsal }>(r)),
};

export const usd = (cents: number | undefined, digits = 0) =>
  cents === undefined || cents === null ? "—" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
