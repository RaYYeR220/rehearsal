import type { Universe } from "./api";
import { usd } from "./api";

export const UCOLOR: Record<string, string> = { a: "var(--u-a)", b: "var(--u-b)", c: "var(--u-c)", d: "var(--fg-2)" };

/** Landing object: one frozen moment branching into three billing futures. */
export function ForkArt() {
  const W = 620;
  const H = 440;
  const x0 = 70;
  const y0 = 220;
  const lanes = [
    { c: "var(--u-a)", d: `M${x0} ${y0} C 200 ${y0}, 230 80, 360 80 S 560 60, 600 58`, label: "A · swap now, prorate", y: 58, ticks: [380, 450, 520, 590] },
    { c: "var(--u-b)", d: `M${x0} ${y0} C 210 ${y0}, 260 214, 380 206 S 560 196, 600 194`, label: "B · new price at renewal", y: 194, ticks: [400, 470, 540] },
    { c: "var(--u-c)", d: `M${x0} ${y0} C 200 ${y0}, 230 350, 360 352 S 560 336, 600 330`, label: "C · grandfather 3 months", y: 330, ticks: [390, 460, 530, 595] },
  ];
  return (
    <svg className="forkart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="A frozen billing world at T0 forking into three universes">
      <defs>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f4a93b" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#f4a93b" stopOpacity="0" />
        </radialGradient>
        <pattern id="months" width="70" height={H} patternUnits="userSpaceOnUse" x={x0}>
          <line x1="0" y1="30" x2="0" y2={H - 40} stroke="rgba(239,233,221,0.07)" />
        </pattern>
      </defs>
      <rect x={x0} y="0" width={W - x0} height={H} fill="url(#months)" />
      {["T0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"].map((m, i) => (
        <text key={m} x={x0 + i * 70} y={H - 18} fill="var(--fg-3)" fontFamily="var(--mono)" fontSize="11" textAnchor="middle">{m}</text>
      ))}
      {lanes.map((l, i) => (
        <g key={i}>
          <path d={l.d} className="lane draw" stroke={l.c} style={{ animationDelay: `${0.25 + i * 0.22}s` }} />
          {l.ticks.map((tx, k) => (
            <rect key={k} x={tx - 3} y={l.y + (i === 0 ? 2 : i === 1 ? 0 : -2) - 9} width="6" height="12" rx="1.5" fill={l.c} opacity="0.75" className="reveal" style={{ animationDelay: `${1.6 + k * 0.15 + i * 0.1}s` }} />
          ))}
          <text x={W - 6} y={l.y - 16} fill="var(--fg-2)" fontFamily="var(--mono)" fontSize="11.5" textAnchor="end">{l.label}</text>
        </g>
      ))}
      <circle cx={x0} cy={y0} r="46" fill="url(#glow)" className="pulse" />
      <circle cx={x0} cy={y0} r="9" fill="var(--accent)" />
      <circle cx={x0} cy={y0} r="15" fill="none" stroke="var(--accent)" strokeOpacity="0.5" />
      <text x={x0} y={y0 + 40} fill="var(--fg)" fontFamily="var(--serif)" fontSize="22" textAnchor="middle">T0</text>
      <text x={x0} y={y0 + 58} fill="var(--fg-3)" fontFamily="var(--mono)" fontSize="10.5" textAnchor="middle">paused VM</text>
    </svg>
  );
}

/** Live chart: cumulative revenue per universe, from Stripe's own invoices, against the status quo. */
export function ForkChart({ universes, months }: { universes: Universe[]; months: number }) {
  const W = 900;
  const H = 300;
  const L = 64;
  const R = 150;
  const T = 18;
  const B = 34;
  const cum = (arr: number[]) => arr.reduce<number[]>((acc, v) => [...acc, acc[acc.length - 1] + v], [0]);
  const series = universes
    .filter((u) => u.report?.metrics)
    .map((u) => ({ key: u.key, name: u.name, data: cum(u.report!.metrics!.revenue_by_month), ok: u.status === "passed" || u.status === "applied" || u.status === "awaiting_approval" }));
  const base = universes.find((u) => u.report?.metrics)?.report!.metrics!.baseline_by_month;
  const baseline = base ? cum(base) : null;
  const max = Math.max(1, ...series.flatMap((s) => s.data), ...(baseline ?? [0])) * 1.08;
  const x = (i: number) => L + (i / months) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const path = (d: number[]) => d.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Cumulative revenue per universe">
      {series.length > 0 && ticks.map((v, i) => (
        <g key={i}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(239,233,221,0.07)" />
          <text x={L - 10} y={y(v) + 4} textAnchor="end" fill="var(--fg-3)" fontFamily="var(--mono)" fontSize="11">{usd(v)}</text>
        </g>
      ))}
      {Array.from({ length: months + 1 }, (_, i) => (
        <text key={i} x={x(i)} y={H - 10} textAnchor="middle" fill="var(--fg-3)" fontFamily="var(--mono)" fontSize="11">{i === 0 ? "T0" : `M${i}`}</text>
      ))}
      {baseline && (
        <g>
          <path d={path(baseline)} fill="none" stroke="var(--fg-3)" strokeWidth="1.5" strokeDasharray="4 5" />
          <text x={x(months) + 10} y={y(baseline[months]) + 4} fill="var(--fg-3)" fontFamily="var(--mono)" fontSize="11">status quo {usd(baseline[months])}</text>
        </g>
      )}
      {series.map((s) => (
        <g key={s.key}>
          <path d={path(s.data)} fill="none" stroke={UCOLOR[s.key]} strokeWidth="2.25" strokeLinejoin="round" opacity={s.ok ? 1 : 0.55} strokeDasharray={s.ok ? undefined : "2 4"} />
          <circle cx={x(months)} cy={y(s.data[months])} r="4" fill={UCOLOR[s.key]} />
          <text x={x(months) + 10} y={y(s.data[months]) + 4} fill={UCOLOR[s.key]} fontFamily="var(--mono)" fontSize="11.5">{s.key.toUpperCase()} {usd(s.data[months])}</text>
        </g>
      ))}
      <circle cx={x(0)} cy={y(0)} r="6" fill="var(--accent)" />
      {!series.length &&
        universes.map((u, i) => {
          // while nothing is billed yet, show each fork's progress through the simulated months
          const last = u.attempts[u.attempts.length - 1];
          const m = Math.min(months, last?.month ?? 0);
          const yy = T + ((i + 1) / (universes.length + 1)) * (H - T - B);
          return (
            <g key={u.key}>
              <path d={`M${x(0)} ${y(0)} C ${x(0.5)} ${y(0)}, ${x(0.4)} ${yy}, ${x(1)} ${yy} L ${x(months)} ${yy}`} fill="none" stroke={UCOLOR[u.key]} strokeOpacity="0.18" strokeWidth="2" />
              {m > 0 && <path d={`M${x(0)} ${y(0)} C ${x(0.5)} ${y(0)}, ${x(0.4)} ${yy}, ${x(1)} ${yy} L ${x(m)} ${yy}`} fill="none" stroke={UCOLOR[u.key]} strokeWidth="2.25" />}
              <text x={x(months) + 10} y={yy + 4} fill={UCOLOR[u.key]} fontFamily="var(--mono)" fontSize="11.5">{u.key.toUpperCase()} {m ? `M${m}/${months}` : u.status}</text>
            </g>
          );
        })}
    </svg>
  );
}
