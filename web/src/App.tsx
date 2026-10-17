import { useEffect, useMemo, useState } from "react";
import { api, usd, type Rehearsal, type Universe } from "./api";
import { ForkArt, ForkChart, UCOLOR } from "./charts";

const EXAMPLES = [
  "Raise Pro monthly from $20 to $29. Everyone already on Pro keeps paying $20 for their next 3 renewals, then moves to $29. Don't touch annual plans, Starter or Team.",
  "Move Team from $15 to $18 per seat at each customer's next renewal. No proration charges, nobody gets an invoice mid-cycle.",
  "Retire Starter: move every Starter customer to Pro at $12/month for the first 6 months, no charge today.",
];

function Mark() {
  return (
    <a className="mark" href="/">
      <svg viewBox="0 0 32 32" aria-hidden>
        <circle cx="8" cy="16" r="3.2" fill="#f4a93b" />
        <path d="M10.5 16 C16 16 17 8 26 8 M10.5 16 H26 M10.5 16 C16 16 17 24 26 24" stroke="#efe9dd" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
      <b>Rehearsal</b>
    </a>
  );
}

function Top() {
  return (
    <div className="top">
      <Mark />
      <nav>
        <a href="/#how">How it works</a>
        <a href="https://github.com/RaYYeR220/rehearsal" target="_blank" rel="noreferrer">GitHub</a>
      </nav>
    </div>
  );
}

function Landing({ onStart }: { onStart: (intent: string) => void }) {
  const [intent, setIntent] = useState(EXAMPLES[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replays, setReplays] = useState<string[]>([]);
  useEffect(() => {
    api.replays().then(setReplays).catch(() => {});
  }, []);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      onStart(intent);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="wrap">
      <Top />
      <section className="hero">
        <div className="reveal">
          <div className="eyebrow"><i /> Stripe billing · CreateOS micro-VMs</div>
          <h1 className="display">
            Rehearse the price change. <em>Then</em> ship it.
          </h1>
          <p className="lede">
            Describe the change in a sentence. Rehearsal freezes your Stripe billing, forks it into three sealed universes, and runs each strategy through six months of real invoices before a single customer is touched.
          </p>
          <div className="intent">
            <textarea value={intent} onChange={(e) => setIntent(e.target.value)} aria-label="Describe the pricing change" />
            <div className="row">
              <span>test-mode Stripe · egress: api.stripe.com only</span>
              <button className="btn primary" onClick={go} disabled={busy || intent.trim().length < 10}>
                {busy ? "Starting…" : "Rehearse it"}
              </button>
            </div>
          </div>
          <div className="examples">
            {EXAMPLES.slice(1).map((e) => (
              <button key={e} onClick={() => setIntent(e)}>{e.split(".")[0]}</button>
            ))}
            {replays.slice(-1).map((id) => (
              <button key={id} onClick={() => (window.location.href = `/?replay=${id}`)}>▶ watch a recorded run</button>
            ))}
          </div>
          {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        </div>
        <div className="reveal" style={{ animationDelay: ".15s" }}>
          <ForkArt />
        </div>
      </section>

      <section id="how" className="verbs">
        <div className="verb">
          <div className="n">01</div>
          <h3>Freeze</h3>
          <p>A micro-VM installs its tools, then its network is sealed to api.stripe.com. It reads your catalog and subscriptions and is paused: RAM, disk and data become the T0 snapshot.</p>
        </div>
        <div className="verb">
          <div className="n">02</div>
          <h3>Fork</h3>
          <p>The agent writes the policy test from your words, then three strategies. Each runs in its own byte-identical fork of T0, on twin customers on Stripe test clocks, for six billed months.</p>
        </div>
        <div className="verb">
          <div className="n">03</div>
          <h3>Prove</h3>
          <p>Failures go back to the agent until the test passes. You approve one universe; it stays paused holding that exact code, and applies only if the sha256 still matches.</p>
        </div>
      </section>

      <div className="marquee" aria-hidden>
        <div>
          {[0, 1].map((k) => (
            <span key={k}>
              <span><b>fork</b> byte-identical universes from one paused VM</span>
              <span><b>egress</b> api.stripe.com:443, nothing else</span>
              <span><b>test clocks</b> six months of renewals in minutes</span>
              <span><b>guard</b> every Stripe request checked against an allowlist</span>
              <span><b>pause</b> the approved code is held, not re-generated</span>
              <span><b>live URL</b> every universe serves its own report</span>
            </span>
          ))}
        </div>
      </div>
      <footer>
        <span>Rehearsal · built on CreateOS Sandbox and Stripe Projects</span>
        <span>Runs in Stripe test mode</span>
      </footer>
    </div>
  );
}

const PHASES: [string, string][] = [
  ["boot", "Boot T0 micro-VM"],
  ["sealing", "Seal egress"],
  ["freezing", "Freeze billing world"],
  ["planning", "Policy + strategies"],
  ["testing", "Write the policy test"],
  ["snapshot", "Pause → T0 snapshot"],
  ["universes", "Fork + run universes"],
  ["review", "Review"],
  ["approval", "Human approval"],
  ["applying", "Apply"],
  ["done", "Done"],
];

function Steps({ phase }: { phase: string }) {
  const idx = PHASES.findIndex(([p]) => p === phase);
  return (
    <ul className="steps">
      {PHASES.map(([p, label], i) => (
        <li key={p} className={i < idx || phase === "done" ? "done" : i === idx ? "now" : ""}>
          <span className="s" />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

function UniverseCard({ u, r, onApprove, busy, replay }: { u: Universe; r: Rehearsal; onApprove: (k: string) => void; busy: boolean; replay: boolean }) {
  const m = u.report?.metrics;
  const last = u.attempts[u.attempts.length - 1];
  const delta = m ? m.revenue_total - m.baseline_total : 0;
  const fixes = u.attempts.filter((a) => a.diagnosis);
  return (
    <article className="u reveal" style={{ ["--uc" as any]: UCOLOR[u.key] }}>
      <div className="uh">
        <div>
          <div className="key">UNIVERSE {u.key.toUpperCase()}</div>
          <h3>{u.name}</h3>
        </div>
        <span className={`status ${u.status}`}>{u.status.replace("_", " ")}</span>
      </div>
      <p className="ap">{u.approach}</p>
      {u.attempts.length > 0 && (
        <div className="attempts">
          {u.attempts.map((a) => (
            <span key={a.n} className={`att ${a.exitCode === undefined ? "run" : a.exitCode === 0 ? "pass" : "fail"}`}>
              try {a.n} {a.exitCode === undefined ? (a.month ? `· M${a.month}` : "…") : a.exitCode === 0 ? "✓" : a.refused ? "refused" : a.violations?.length ? `${a.violations.length} broken` : "crash"}
            </span>
          ))}
        </div>
      )}
      {fixes.length > 0 && <div className="fixnote">{fixes[fixes.length - 1].diagnosis}</div>}
      {m && (
        <div className="kpis">
          <div className="kpi"><div className="l">6-mo revenue</div><div className={`v ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`}>{usd(m.revenue_total)}<small>{delta >= 0 ? "+" : "−"}{usd(Math.abs(delta))}</small></div></div>
          <div className="kpi"><div className="l">MRR after</div><div className="v">{usd(m.mrr_after)}<small>was {usd(m.mrr_before)}</small></div></div>
          <div className="kpi"><div className="l">Customers paying more</div><div className="v">{m.customers_increased}<small>/ {m.customers} · max +{m.max_increase_pct}%</small></div></div>
          <div className="kpi"><div className="l">Proration lines</div><div className="v">{m.proration_lines}<small>{usd(m.proration_total)} · {m.failed_invoices} failed</small></div></div>
        </div>
      )}
      {(last?.violations?.length ?? 0) > 0 && u.status !== "passed" && (
        <ul className="viol">
          {last!.violations!.slice(0, 4).map((v, i) => <li key={i}>✗ {v}</li>)}
        </ul>
      )}
      {last?.error && u.status === "failed" && <ul className="viol"><li>{String(last.error).split("\n").filter(Boolean).slice(-1)[0]}</li></ul>}
      <div className="meta">
        {u.sandboxId && <span>vm {u.sandboxId}</span>}
        {last?.sha256 && <span>strategy.py sha256 {last.sha256.slice(0, 16)}…</span>}
        {u.url && !replay && <a href={u.url} target="_blank" rel="noreferrer">open this universe's live report ↗</a>}
      </div>
      {!replay && (r.phase === "review" || r.phase === "done") && !r.approval && (
        <div className="actions">
          <button className={u.status === "passed" ? "btn primary" : "btn danger"} disabled={busy} onClick={() => onApprove(u.key)}>
            {u.status === "passed" ? "Approve this universe" : "Try to approve"}
          </button>
        </div>
      )}
    </article>
  );
}

function RunView({ id, replay }: { id: string; replay: boolean }) {
  const [r, setR] = useState<Rehearsal | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => (replay ? api.replay(id) : api.get(id)).then((x) => alive && setR(x)).catch((e) => alive && setErr(e.message));
    load();
    if (replay) return;
    const es = new EventSource(`/api/rehearsals/${id}/events`);
    let t: any;
    es.addEventListener("ev", () => {
      clearTimeout(t);
      t = setTimeout(load, 150);
    });
    const iv = setInterval(load, 5000);
    return () => {
      alive = false;
      es.close();
      clearInterval(iv);
    };
  }, [id, replay]);

  const months = useMemo(() => r?.universes.find((u) => u.report?.metrics)?.report?.metrics?.revenue_by_month.length ?? 6, [r]);

  if (!r) return <div className="wrap"><Top /><p className="empty">{err ?? "Loading…"}</p></div>;

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    setErr(null);
    try {
      const out = await fn();
      if (out?.rehearsal) setR(out.rehearsal);
      else if (out?.id) setR(out);
    } catch (e: any) {
      setErr(e.message);
      setR(await api.get(id).catch(() => r));
    } finally {
      setBusy(false);
    }
  };

  const live = !["review", "done", "error", "approval"].includes(r.phase);
  const approvedU = r.approval && r.universes.find((u) => u.key === r.approval!.universe);

  return (
    <div className="wrap">
      <Top />
      <section className="run-head">
        <div>
          <div className="eyebrow">{replay ? "Recorded run" : "Rehearsal"} · {r.id}</div>
          <blockquote>“{r.intent}”</blockquote>
        </div>
        <div className="chips">
          <span className={`chip ${live ? "live" : r.phase === "error" ? "bad" : "ok"}`}><span className="dot" />{r.phase}</span>
          {r.baseId && <span className="chip"><span className="dot" />T0 {r.baseId.slice(0, 14)}…</span>}
          {r.world && <span className="chip"><span className="dot" />{r.world.subscriptions.length} subscriptions frozen</span>}
        </div>
      </section>

      <div className="grid-run">
        <aside className="rail">
          <h4>Pipeline</h4>
          <Steps phase={r.phase} />
          {r.egress && (
            <>
              <h4>Egress, probed from inside T0</h4>
              <div className="egress">
                {r.egress.map((e) => (
                  <div key={e.url}><span>{e.url.replace("https://", "").split("/")[0]}</span><span className={e.reachable ? "y" : "n"}>{e.reachable ? `reachable ${e.status}` : "blocked"}</span></div>
                ))}
              </div>
            </>
          )}
          {r.policy.length > 0 && (
            <>
              <h4>Policy the agent will test</h4>
              <ul className="policy">{r.policy.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </>
          )}
          <h4>Event log</h4>
          <div className="log">
            {[...r.events].reverse().slice(0, 120).map((e, i) => (
              <div key={i} className={/refus|failure|error/.test(e.kind) ? "bad" : /passed|applied|checks$|paused/.test(e.kind) ? "ok" : ""}>
                <span>{new Date(e.t).toLocaleTimeString([], { hour12: false })}</span>
                <span>{e.universe && <b>{e.universe.toUpperCase()} </b>}{e.text}</span>
              </div>
            ))}
          </div>
        </aside>

        <main>
          <div className="chart-card">
            <header>
              <h2>Six months, three futures</h2>
              <div className="legend">
                {r.universes.map((u) => <span key={u.key}><i style={{ background: UCOLOR[u.key] }} />{u.key.toUpperCase()} · {u.name}</span>)}
                <span><i style={{ background: "var(--fg-3)" }} />status quo</span>
              </div>
            </header>
            <ForkChart universes={r.universes} months={months > 0 ? months : 6} />
          </div>

          {r.universes.length ? (
            <div className="universes">
              {r.universes.map((u) => (
                <UniverseCard key={u.key} u={u} r={r} busy={busy} replay={replay} onApprove={(k) => act(() => api.approve(r.id, k))} />
              ))}
            </div>
          ) : (
            <p className="empty">The agent is reading your billing world…</p>
          )}

          {err && <div className="refusals"><div className="ref"><span className="src">refused</span><span className="why">{err}</span></div></div>}

          {r.approval && approvedU && (
            <section className="gate reveal">
              <div>
                <h3>Waiting for you.</h3>
                <p>
                  Universe {approvedU.key.toUpperCase()} · {approvedU.name} is <b>paused</b> on VM <code>{r.approval.sandboxId}</code>, holding strategy.py <code>{r.approval.sha256.slice(0, 16)}…</code> exactly as it passed. Approving resumes that VM and applies it to {r.approval.subscriptions.length} real subscriptions, through the same guard.
                </p>
              </div>
              {!replay && (
                <div className="actions">
                  <button className="btn primary" disabled={busy || r.phase !== "approval"} onClick={() => act(() => api.apply(r.id))}>Approve &amp; apply</button>
                  <button className="btn danger" disabled={busy || r.phase !== "approval"} onClick={() => act(() => api.apply(r.id, true))}>Tamper test</button>
                </div>
              )}
            </section>
          )}

          {r.apply && !r.apply.refused && !r.apply.error && (
            <section className="applied reveal">
              <h3>Applied to {r.apply.applied?.length ?? 0} real subscriptions.</h3>
              <p className="meta">sha256 {r.apply.actual_sha256} · {r.apply.guard_log?.length ?? 0} Stripe calls, all inside the allowlist</p>
            </section>
          )}

          {r.refusals.length > 0 && (
            <section className="refusals">
              <div className="section-title">Refusals: every time the system said no</div>
              {r.refusals.map((f, i) => (
                <div className="ref" key={i}><span className="src">{f.source}</span><span className="why">{f.universe ? `Universe ${f.universe.toUpperCase()}: ` : ""}{f.why}</span></div>
              ))}
            </section>
          )}
          {r.error && <div className="refusals"><div className="ref"><span className="src">error</span><span className="why">{r.error}</span></div></div>}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const [id, setId] = useState<string | null>(params.get("r"));
  const replay = params.get("replay");
  if (replay) return <RunView id={replay} replay />;
  if (id) return <RunView id={id} replay={false} />;
  return (
    <Landing
      onStart={async (intent) => {
        const { id } = await api.start(intent);
        window.history.pushState({}, "", `/?r=${id}`);
        setId(id);
      }}
    />
  );
}
