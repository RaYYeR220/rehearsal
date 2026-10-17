import { randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { config } from "./config.js";
import { chat, codeBlock, jsonBlock, type Msg } from "./llm.js";
import { checksFixPrompt, checksPrompt, fixPrompt, plannerPrompt, strategyPrompt } from "./prompts.js";
import { client, createBase, destroyQuietly, egressProof, readJson, run, stream, STRIPE_ONLY, uploadHarness } from "./sandbox.js";

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

export interface Universe {
  key: string;
  name: string;
  approach: string;
  status: UStatus;
  sandboxId?: string;
  url?: string;
  attempts: Attempt[];
  report?: any;
  messages: Msg[];
}

export interface Event {
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
  world?: any;
  policy: string[];
  checks?: string;
  universes: Universe[];
  events: Event[];
  approval?: { universe: string; sha256: string; subscriptions: string[]; at: number; sandboxId: string };
  apply?: any;
  refusals: { at: number; universe?: string; why: string; source: string }[];
  error?: string;
  cleaned?: boolean;
}

const store = new Map<string, Rehearsal>();
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export const getRehearsal = (id: string) => store.get(id);
export const listRehearsals = () => [...store.values()].sort((a, b) => b.createdAt - a.createdAt);

function persist(r: Rehearsal) {
  try {
    mkdirSync("runs", { recursive: true });
    writeFileSync(`runs/${r.id}.json`, JSON.stringify(r, null, 2));
  } catch {
    /* best effort */
  }
}

function emit(r: Rehearsal, kind: string, text: string, extra: { universe?: string; data?: any } = {}) {
  const ev: Event = { t: Date.now(), kind, text, ...extra };
  r.events.push(ev);
  bus.emit(r.id, ev);
  persist(r);
}

function setPhase(r: Rehearsal, phase: string, text: string) {
  r.phase = phase;
  emit(r, "phase", text, { data: { phase } });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Forks of one paused parent are taken one at a time; a fork that lands paused is resumed explicitly.
let forkChain: Promise<unknown> = Promise.resolve();
function forkT0(base: Sandbox): Promise<Sandbox> {
  const next = forkChain.then(async () => {
    const f = await base.fork({ start_paused: false, egress: STRIPE_ONLY, ingress_enabled: true });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await f.refresh();
      if (f.status === "running") return f;
      if (f.status === "paused") await f.resume().catch(() => {});
      if (f.status === "failed" || f.status === "error") break;
      await sleep(2000);
    }
    await f.destroy().catch(() => {});
    throw new Error(`fork ${f.id} did not start (last status ${f.status})`);
  });
  forkChain = next.catch(() => {});
  return next;
}
const short = (id: string) => id.slice(0, 6);

function worldSummary(w: any) {
  const prices = w.prices.map((p: any) => `  ${p.id}  ${p.product_name} ${p.nickname ?? ""}  $${(p.unit_amount / 100).toFixed(2)}/${p.interval}`).join("\n");
  const subs = w.subscriptions
    .map((s: any) => `  ${s.id}  ${s.customer_name}  ${s.status}${s.cancel_at_period_end ? " (cancelling)" : ""}  ` + s.items.map((i: any) => `${i.price} x${i.quantity}`).join(", "))
    .join("\n");
  return `Prices:\n${prices}\nSubscriptions (${w.subscriptions.length}):\n${subs}`;
}

// ------------------------------------------------------------------ lifecycle

export function startRehearsal(intent: string): Rehearsal {
  if (!/^(sk|rk)_test_/.test(config.stripeKey)) throw new HttpError(400, "Rehearsal only runs with a Stripe test-mode key");
  const id = randomBytes(4).toString("hex");
  const r: Rehearsal = { id, intent, createdAt: Date.now(), phase: "created", policy: [], universes: [], events: [], refusals: [] };
  store.set(id, r);
  run_(r).catch((e) => {
    r.error = String(e?.message ?? e);
    setPhase(r, "error", `Stopped: ${r.error}`);
  });
  return r;
}

async function run_(r: Rehearsal) {
  // 1. Base VM: install deps while the network is open to PyPI + Stripe only.
  setPhase(r, "boot", "Booting the T0 micro-VM (devbox:1)");
  const base = await createBase(`rh-${r.id}-t0`);
  r.baseId = base.id;
  emit(r, "sandbox", `T0 VM ${base.id} up`, { data: { id: base.id } });
  await uploadHarness(base);
  const pip = await run(base, "pip install -q --disable-pip-version-check stripe==16.0.0 2>&1 | tail -2; python3 -c 'import stripe; print(stripe.VERSION)'", 240_000);
  if (pip.code !== 0) throw new Error(`dependency install failed: ${pip.stdout}${pip.stderr}`);
  emit(r, "deps", `stripe-python ${pip.stdout.trim().split("\n").pop()} installed`);

  // 2. Seal the network: from here on the VM can talk to api.stripe.com and nothing else.
  setPhase(r, "sealing", "Sealing egress to api.stripe.com:443");
  await base.setEgress(STRIPE_ONLY);
  // hostname rules take a moment to propagate; keep probing until only Stripe answers
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 2500));
    r.egress = await egressProof(base);
    if (r.egress.every((e) => e.reachable === e.url.includes("api.stripe.com"))) break;
  }
  if (!r.egress!.every((e) => e.reachable === e.url.includes("api.stripe.com"))) throw new Error("egress seal did not take effect; refusing to continue");
  emit(r, "egress", "Egress sealed", { data: r.egress });

  // 3. Freeze the world.
  setPhase(r, "freezing", "Freezing the billing world at T0");
  const frozen = await run(base, "cd /work && python3 /opt/rehearsal/world.py", 120_000);
  if (frozen.code !== 0) throw new Error(`world freeze failed: ${frozen.stderr || frozen.stdout}`);
  r.world = await readJson(base, "/work/world.json");
  emit(r, "world", `T0 world: ${r.world.subscriptions.length} subscriptions, ${r.world.prices.length} prices`, { data: { subscriptions: r.world.subscriptions.length, prices: r.world.prices.length } });
  const worldJson = JSON.stringify(r.world, null, 1);

  // 4. Plan + write the policy test first; both go into the T0 snapshot so every universe shares them.
  setPhase(r, "planning", "Turning the request into a testable policy and three strategies");
  const plan = jsonBlock<{ policy: string[]; universes: { key: string; name: string; approach: string }[] }>(await chat(plannerPrompt(r.intent, worldSummary(r.world), config.universes), { maxTokens: 3000 }));
  r.policy = plan.policy;
  r.universes = plan.universes.slice(0, config.universes).map((u, i) => ({ key: String.fromCharCode(97 + i), name: u.name, approach: u.approach, status: "queued", attempts: [], messages: [] }));
  emit(r, "plan", "Policy and strategies ready", { data: { policy: r.policy, universes: r.universes.map(({ key, name, approach }) => ({ key, name, approach })) } });

  setPhase(r, "testing", "Writing the policy test before any strategy exists");
  const checksMsgs: Msg[] = checksPrompt(r.intent, r.policy, worldJson);
  let checks = codeBlock(await chat(checksMsgs), "checks.py");
  for (let i = 0; i < 3; i++) {
    if (!checks) throw new Error("model returned no checks.py");
    await base.files.upload("/work/checks.py", checks);
    const t = await run(base, `cd /work && python3 -c "import sys; sys.path.insert(0,'/opt/rehearsal'); import guard; p=guard.static_check(open('checks.py').read()); assert not p, p; import checks; print(checks.check([], {'prices':[],'subscriptions':[]}, {}))"`, 60_000);
    if (t.code === 0) break;
    emit(r, "checks-fix", "Policy test did not load, fixing it");
    checksMsgs.push({ role: "assistant", content: "```python checks.py\n" + checks + "```" }, checksFixPrompt(checks, (t.stderr || t.stdout).slice(-3000)));
    checks = codeBlock(await chat(checksMsgs), "checks.py");
  }
  r.checks = checks!;
  emit(r, "checks", "Policy test written", { data: { sha256: sha(r.checks) } });

  // 5. Snapshot T0.
  setPhase(r, "snapshot", "Pausing T0: RAM, disk and the frozen world become the snapshot every universe forks from");
  await base.pause();
  await base.waitUntilPaused({ timeoutMs: 300_000 });
  emit(r, "paused", `T0 snapshot taken (${base.id})`);

  // 6. Universes.
  setPhase(r, "universes", "Forking universes from T0");
  const queue = [...r.universes];
  const workers = Array.from({ length: Math.max(1, Math.min(config.parallel, queue.length)) }, async () => {
    while (queue.length) {
      const u = queue.shift()!;
      await runUniverse(r, base, u, worldJson).catch((e) => {
        u.status = "failed";
        emit(r, "universe", `Universe ${u.key.toUpperCase()} stopped: ${e?.message ?? e}`, { universe: u.key });
      });
    }
  });
  await Promise.all(workers);
  setPhase(r, "review", "All universes finished. Pick one to approve.");
}

async function runUniverse(r: Rehearsal, base: Sandbox, u: Universe, worldJson: string) {
  u.status = "coding";
  emit(r, "universe", `${u.name}: writing strategy.py`, { universe: u.key });
  u.messages = strategyPrompt(r.intent, r.policy, u, worldJson, r.checks!);
  let reply = await chat(u.messages);
  let code = codeBlock(reply, "strategy.py");

  for (let n = 1; n <= config.maxAttempts; n++) {
    if (!code) throw new Error("model returned no strategy.py");
    u.messages.push({ role: "assistant", content: reply });
    const attempt: Attempt = { n, code, sha256: sha(code), startedAt: Date.now() };
    u.attempts.push(attempt);

    // A clean universe for every attempt: fork the paused T0 snapshot again.
    u.status = "forking";
    emit(r, "universe", `${u.name}: forking T0 (attempt ${n})`, { universe: u.key });
    if (u.sandboxId) await destroyQuietly(u.sandboxId);
    const fork = await forkT0(base);
    u.sandboxId = attempt.sandboxId = fork.id;
    u.url = fork.previewUrl(8080);
    emit(r, "fork", `${u.name}: universe VM ${fork.id}`, { universe: u.key, data: { id: fork.id, url: u.url } });

    const tag = `rh-${r.id}-${u.key}-a${n}`;
    await fork.files.upload("/work/strategy.py", code);
    await fork.files.upload("/work/universe.json", JSON.stringify({ key: u.key, name: u.name, approach: u.approach, tag, attempt: n, months: config.months, rehearsal: r.id, intent: r.intent, policy: r.policy }));
    await run(fork, "cd /work/public && (nohup setsid python3 -m http.server 8080 --bind 0.0.0.0 >/tmp/http.log 2>&1 &) ; echo ok", 30_000);

    u.status = "running";
    emit(r, "universe", `${u.name}: running against Stripe (attempt ${n})`, { universe: u.key });
    const res = await stream(fork, "cd /work && python3 /opt/rehearsal/universe.py", (line) => {
      if (!line.startsWith("{")) return;
      try {
        const ev = JSON.parse(line);
        if (ev.event === "month") attempt.month = ev.k;
        if (ev.event === "month" || ev.event === "twins" || ev.event === "phase") emit(r, "progress", describe(ev), { universe: u.key, data: ev });
      } catch {
        /* not an event line */
      }
    });
    attempt.exitCode = res.code;
    attempt.endedAt = Date.now();
    try {
      u.report = await readJson(fork, "/work/public/report.json");
    } catch {
      u.report = undefined;
    }
    attempt.error = u.report?.error ?? (res.code !== 0 && res.code !== 2 ? res.stderr.slice(-3000) : null);
    attempt.violations = u.report?.violations ?? [];
    attempt.refused = !!u.report?.refused;
    if (attempt.refused) r.refusals.push({ at: Date.now(), universe: u.key, why: attempt.error ?? "refused", source: "guard (rehearsal)" });

    if (res.code === 0) {
      u.status = "passed";
      emit(r, "universe", `${u.name}: policy holds after ${n} attempt${n > 1 ? "s" : ""}`, { universe: u.key, data: { metrics: u.report?.metrics } });
      return;
    }

    const failure = attempt.refused
      ? `The capability guard refused a request:\n${attempt.error}`
      : attempt.violations?.length
        ? `The run completed but the policy test found violations:\n${attempt.violations.map((v) => `- ${v}`).join("\n")}`
        : `The strategy crashed:\n${attempt.error ?? res.stderr.slice(-3000)}`;
    emit(r, "failure", `${u.name}: attempt ${n} ${attempt.violations?.length ? `broke the policy (${attempt.violations.length})` : attempt.refused ? "was refused by the guard" : "crashed"}`, { universe: u.key, data: { failure: failure.slice(0, 1500) } });

    if (n === config.maxAttempts) {
      u.status = attempt.violations?.length ? "violations" : "failed";
      return;
    }
    u.status = "fixing";
    u.messages.push(fixPrompt(code, failure.slice(0, 6000)));
    reply = await chat(u.messages);
    attempt.diagnosis = reply.split("```")[0].trim().slice(0, 600);
    emit(r, "fix", `${u.name}: ${attempt.diagnosis || "patched strategy.py"}`, { universe: u.key });
    code = codeBlock(reply, "strategy.py");
  }
}

function describe(ev: any) {
  if (ev.event === "month") return `month ${ev.k}/${ev.of} billed`;
  if (ev.event === "twins") return `${ev.count} twins on ${ev.clocks} test clocks`;
  if (ev.event === "phase") return ev.name;
  return ev.event;
}

// ------------------------------------------------------------------ approval gate

export async function requestApproval(r: Rehearsal, key: string) {
  const u = r.universes.find((x) => x.key === key);
  if (!u) throw new HttpError(404, "no such universe");
  if (u.status !== "passed") {
    const why = `Universe ${key.toUpperCase()} is "${u.status}". Only a universe whose policy test passed can be approved.`;
    r.refusals.push({ at: Date.now(), universe: key, why, source: "control plane" });
    emit(r, "refused", why, { universe: key });
    throw new HttpError(409, why);
  }
  const last = u.attempts[u.attempts.length - 1];
  u.status = "pausing";
  emit(r, "approval", `${u.name}: pausing the universe VM so the verified code is held exactly as tested`, { universe: u.key });
  const sb = await client.getSandbox(u.sandboxId!);
  await sb.pause();
  await sb.waitUntilPaused({ timeoutMs: 300_000 });
  u.status = "awaiting_approval";
  r.approval = { universe: key, sha256: last.sha256!, subscriptions: r.world.subscriptions.map((s: any) => s.id), at: Date.now(), sandboxId: sb.id };
  setPhase(r, "approval", `Waiting for a human: ${u.name} (sha256 ${last.sha256!.slice(0, 12)}) is paused and holds the exact code that passed`);
}

export async function approveAndApply(r: Rehearsal, opts: { tamper?: boolean } = {}) {
  if (!r.approval) throw new HttpError(409, "nothing is waiting for approval");
  const u = r.universes.find((x) => x.key === r.approval!.universe)!;
  u.status = "applying";
  setPhase(r, "applying", `Approved. Resuming ${u.name} and applying to the real subscriptions`);
  const sb = await client.getSandbox(r.approval.sandboxId);
  await sb.resume();
  await sb.waitUntilRunning({ timeoutMs: 300_000 });
  await sb.files.upload("/work/approval.json", JSON.stringify({ strategy_sha256: r.approval.sha256, subscriptions: r.approval.subscriptions, violations: u.report?.violations ?? [] }));
  if (opts.tamper) {
    // Demonstrates the gate: a single changed byte after approval and the apply refuses.
    await run(sb, `printf '\\n# edited after approval\\n' >> /work/strategy.py`);
    emit(r, "tamper", "Tamper test: strategy.py was edited after approval", { universe: u.key });
  }
  const res = await run(sb, "cd /work && python3 /opt/rehearsal/apply.py", 600_000);
  const line = res.stdout.split("\n").find((l) => l.startsWith("APPLY_RESULT "));
  const out = line ? JSON.parse(line.slice("APPLY_RESULT ".length)) : { error: res.stderr || res.stdout };
  r.apply = { ...out, at: Date.now(), tamper: !!opts.tamper };
  if (out.refused) {
    u.status = "refused";
    r.refusals.push({ at: Date.now(), universe: u.key, why: out.why, source: "apply gate (in VM)" });
    emit(r, "refused", `Apply refused: ${out.why}`, { universe: u.key, data: out });
    // the approval stays on record; re-request to try again with the untampered code
    await sb.pause().catch(() => {});
    u.status = "passed";
    r.approval = undefined;
    setPhase(r, "review", "Apply was refused. Nothing was changed.");
    return r.apply;
  }
  u.status = out.error ? "failed" : "applied";
  emit(r, out.error ? "apply-error" : "applied", out.error ? `Apply failed: ${String(out.error).slice(0, 300)}` : `Applied to ${out.applied?.length ?? 0} real subscriptions`, { universe: u.key, data: out });
  setPhase(r, "done", out.error ? "Apply failed" : "Done");
  return r.apply;
}

export async function cleanup(r: Rehearsal) {
  await Promise.all([r.baseId, ...r.universes.map((u) => u.sandboxId)].map((id) => destroyQuietly(id)));
  r.cleaned = true;
  emit(r, "cleanup", "All sandboxes destroyed");
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
