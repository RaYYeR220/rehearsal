import { createClient, type Sandbox } from "@nodeops-createos/sandbox";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";

export const client = createClient({ apiKey: config.createosKey, baseUrl: config.createosBaseUrl, timeoutMs: 120_000 });

export const STRIPE_ONLY = ["api.stripe.com:443"];
const PYPI = ["pypi.org:443", "files.pythonhosted.org:443"];
const HARNESS_DIR = resolve(process.cwd(), "sandbox");

export async function createBase(name: string): Promise<Sandbox> {
  return client.createSandbox(
    {
      shape: config.shape,
      rootfs: "devbox:1",
      name,
      envs: { STRIPE_SECRET_KEY: config.stripeKey, WORK: "/work", PYTHONPATH: "/opt/rehearsal", PYTHONUNBUFFERED: "1" },
      egress: [...PYPI, ...STRIPE_ONLY],
    },
    { wait: true, waitTimeoutMs: 180_000 },
  );
}

export async function uploadHarness(sb: Sandbox) {
  await sb.sh("mkdir -p /opt/rehearsal /work/public");
  for (const f of readdirSync(HARNESS_DIR)) {
    if (!/\.(py|html)$/.test(f)) continue;
    await sb.files.upload(`/opt/rehearsal/${f}`, readFileSync(join(HARNESS_DIR, f), "utf8"));
  }
}

export async function run(sb: Sandbox, script: string, timeoutMs = 120_000) {
  const r = await sb.runCommand("bash", ["-lc", script], { timeoutMs });
  return { stdout: r.result.stdout ?? "", stderr: r.result.stderr ?? "", code: r.result.exit_code ?? -1 };
}

/** Stream a command, calling onLine for every stdout line. Resolves with the exit code and captured output. */
export async function stream(sb: Sandbox, script: string, onLine: (line: string) => void, timeoutMs = 20 * 60_000) {
  let stdout = "";
  let stderr = "";
  let code = -1;
  let buf = "";
  for await (const ev of sb.streamCommand("bash", ["-lc", script], { timeoutMs })) {
    if (ev.type === "stdout") {
      stdout += ev.data;
      buf += ev.data;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    } else if (ev.type === "stderr") stderr += ev.data;
    else if (ev.type === "exit") code = ev.exitCode;
    else if (ev.type === "error") stderr += `\n[stream error] ${ev.message}`;
  }
  if (buf) onLine(buf);
  return { stdout, stderr, code };
}

export async function readJson<T>(sb: Sandbox, path: string): Promise<T> {
  const buf = await sb.files.download(path);
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

/** Prove the seal from inside the VM: Stripe answers, everything else times out. */
export async function egressProof(sb: Sandbox) {
  const probe = (url: string) =>
    `code=$(curl -s -m 6 -o /dev/null -w '%{http_code}' ${url} || true); echo "${url} $code"`;
  const r = await run(sb, [probe("https://api.stripe.com/v1/charges"), probe("https://example.com"), probe("https://pypi.org/simple/"), probe("https://api.github.com")].join("; "), 60_000);
  return r.stdout
    .trim()
    .split("\n")
    .map((l) => {
      const [url, code] = l.split(" ");
      return { url, status: code, reachable: code !== "000" };
    });
}

export async function destroyQuietly(id?: string) {
  if (!id) return;
  try {
    const sb = await client.getSandbox(id);
    await sb.destroy();
  } catch {
    /* already gone */
  }
}
