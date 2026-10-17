import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { config } from "./config.js";
import { approveAndApply, bus, cleanup, getRehearsal, HttpError, listRehearsals, requestApproval, startRehearsal, type Event, type Rehearsal } from "./rehearsal.js";

const app = new Hono();

// Strip conversation state from what the browser sees.
const view = (r: Rehearsal) => ({ ...r, universes: r.universes.map(({ messages, ...u }) => u) });

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  return c.json({ error: err.message }, status as 409);
});

app.get("/api/health", (c) => c.json({ ok: true, model: config.llmModel, universes: config.universes, months: config.months }));

app.get("/api/rehearsals", (c) => c.json(listRehearsals().map((r) => ({ id: r.id, intent: r.intent, phase: r.phase, createdAt: r.createdAt }))));

app.post("/api/rehearsals", async (c) => {
  const body = await c.req.json<{ intent?: string }>();
  const intent = (body.intent ?? "").trim();
  if (intent.length < 10) throw new HttpError(400, "describe the pricing change in a sentence or two");
  // one rehearsal at a time: every run holds a paused T0 plus a fork per universe
  const busy = listRehearsals().find((x) => !["review", "done", "error"].includes(x.phase));
  if (busy) return c.json({ error: "A rehearsal is already running. Watch it live.", id: busy.id }, 409);
  // free the sandbox slots held by finished rehearsals (their reports are kept in runs/)
  await Promise.all(listRehearsals().filter((x) => !x.cleaned).map((x) => cleanup(x).catch(() => {})));
  const r = startRehearsal(intent.slice(0, 1200));
  return c.json({ id: r.id });
});

app.get("/api/rehearsals/:id", (c) => {
  const r = getRehearsal(c.req.param("id"));
  if (!r) throw new HttpError(404, "not found");
  return c.json(view(r));
});

app.get("/api/rehearsals/:id/events", (c) => {
  const r = getRehearsal(c.req.param("id"));
  if (!r) throw new HttpError(404, "not found");
  return streamSSE(c, async (s) => {
    const send = (ev: Event) => s.writeSSE({ data: JSON.stringify(ev), event: "ev" });
    const onEv = (ev: Event) => void send(ev);
    bus.on(r.id, onEv);
    s.onAbort(() => {
      bus.off(r.id, onEv);
    });
    while (!s.aborted) {
      await s.writeSSE({ data: "{}", event: "ping" });
      await s.sleep(15_000);
    }
  });
});

app.post("/api/rehearsals/:id/approve", async (c) => {
  const r = getRehearsal(c.req.param("id"));
  if (!r) throw new HttpError(404, "not found");
  const { universe } = await c.req.json<{ universe: string }>();
  await requestApproval(r, universe);
  return c.json(view(r));
});

app.post("/api/rehearsals/:id/apply", async (c) => {
  const r = getRehearsal(c.req.param("id"));
  if (!r) throw new HttpError(404, "not found");
  const { tamper } = await c.req.json<{ tamper?: boolean }>().catch(() => ({ tamper: false }));
  const out = await approveAndApply(r, { tamper: !!tamper });
  return c.json({ apply: out, rehearsal: view(r) });
});

app.post("/api/rehearsals/:id/cleanup", async (c) => {
  const r = getRehearsal(c.req.param("id"));
  if (!r) throw new HttpError(404, "not found");
  await cleanup(r);
  return c.json({ ok: true });
});

// Replays of finished runs (recorded by persist()) so the deployed page always has something real to show.
app.get("/api/replays", (c) => {
  if (!existsSync("runs")) return c.json([]);
  return c.json(readdirSync("runs").filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
});
app.get("/api/replays/:id", (c) => {
  const p = `runs/${c.req.param("id").replace(/[^a-z0-9]/g, "")}.json`;
  if (!existsSync(p)) throw new HttpError(404, "not found");
  const r = JSON.parse(readFileSync(p, "utf8"));
  return c.json(view(r));
});

app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("/*", serveStatic({ path: "./web/dist/index.html" }));

serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`rehearsal on http://localhost:${i.port}`));
