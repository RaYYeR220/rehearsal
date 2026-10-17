"""Apply an approved strategy to the real subscriptions.

Runs only after a human approved one universe. It refuses unless:
  * strategy.py hashes to exactly the sha256 the human approved,
  * the universe it came from finished with zero policy violations,
  * every subscription it touches is on the approved list (enforced per request by guard.py).
The VM can only reach api.stripe.com, so nothing else is reachable either.
"""
import hashlib
import importlib.util
import json
import os
import sys
import time
import traceback

import stripe

import guard

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WORK = os.environ.get("WORK", "/work")


def out(obj, code):
    print("APPLY_RESULT " + json.dumps(obj), flush=True)
    sys.exit(code)


def main():
    manifest = json.load(open(f"{WORK}/approval.json"))
    world = json.load(open(f"{WORK}/world.json"))
    src = open(f"{WORK}/strategy.py", "rb").read()
    sha = hashlib.sha256(src).hexdigest()
    result = {"approved_sha256": manifest["strategy_sha256"], "actual_sha256": sha, "applied": [], "guard_log": []}

    if sha != manifest["strategy_sha256"]:
        out({**result, "refused": True, "why": "strategy.py changed after approval"}, 10)
    if manifest.get("violations"):
        out({**result, "refused": True, "why": "the approved universe had policy violations"}, 10)
    problems = guard.static_check(src.decode())
    if problems:
        out({**result, "refused": True, "why": "; ".join(problems)}, 10)

    approved = set(manifest["subscriptions"])
    unknown = approved - {s["id"] for s in world["subscriptions"]}
    if unknown:
        out({**result, "refused": True, "why": f"approval lists subscriptions that were not in the T0 world: {sorted(unknown)}"}, 10)

    spec = importlib.util.spec_from_file_location("strategy", f"{WORK}/strategy.py")
    strategy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(strategy)

    guard.install(approved, None, result["guard_log"])
    ctx = {"mode": "apply", "now": int(time.time()), "tag": None}
    try:
        prepared = strategy.prepare(stripe, world, ctx) or {}
        for s in world["subscriptions"]:
            if s["id"] not in approved:
                continue
            r = strategy.migrate(stripe, {**s, "live_id": s["id"]}, world, prepared, ctx)
            result["applied"].append({"subscription": s["id"], "result": r})
    except guard.Refused as e:
        out({**result, "refused": True, "why": str(e)}, 10)
    except Exception as e:
        out({**result, "error": "".join(traceback.format_exception(e))[-3000:]}, 3)
    out({**result, "refused": False, "prepared": prepared}, 0)


if __name__ == "__main__":
    main()
