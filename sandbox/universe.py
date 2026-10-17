"""Run one universe of a rehearsal.

  1. Build twins: every real subscription from world.json gets a twin customer on a
     Stripe test clock, with the same items, quantity, trial and renewal date.
  2. Run the agent's strategy (prepare + migrate) against the twins, inside the guard.
  3. Advance the test clocks month by month so Stripe's own billing engine produces
     the invoices, prorations and renewals.
  4. Run the agent's policy checks over the resulting invoice timeline.
  5. Write /work/report.json and /work/public/index.html (served on the live URL).

Exit codes: 0 = clean, 2 = policy violations, 3 = strategy crashed or was refused.
"""
import calendar
import datetime as dt
import hashlib
import importlib.util
import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import stripe

import guard

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
stripe.max_network_retries = 2

WORK = os.environ.get("WORK", "/work")
UNIVERSE = json.load(open(f"{WORK}/universe.json"))
WORLD = json.load(open(f"{WORK}/world.json"))
TAG = UNIVERSE["tag"]                      # e.g. rh-<rehearsal>-<universe>-a<attempt>
MONTHS = int(UNIVERSE.get("months", 6))
CUSTOMERS_PER_CLOCK = 3
PRICES = {p["id"]: p for p in WORLD["prices"]}


def log(kind, **data):
    print(json.dumps({"event": kind, **data}), flush=True)


def add_months(ts, n):
    d = dt.datetime.fromtimestamp(ts, dt.timezone.utc)
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    day = min(d.day, calendar.monthrange(y, m)[1])
    return int(d.replace(year=y, month=m, day=day).timestamp())


def month_index(ts, t0):
    for k in range(0, MONTHS + 2):
        if ts < add_months(t0, k + 1):
            return k
    return MONTHS + 1


def monthly_cents(items):
    total = 0
    for it in items:
        p = PRICES.get(it["price"]) or it.get("_price")
        if not p or p.get("unit_amount") is None:
            continue
        amt = p["unit_amount"] * it.get("quantity", 1)
        n = p.get("interval_count", 1) or 1
        total += amt / (12 * n) if p["interval"] == "year" else amt / n
    return round(total)


def load_module(name):
    path = f"{WORK}/{name}.py"
    problems = guard.static_check(open(path).read())
    if problems:
        raise guard.Refused("static check failed: " + "; ".join(problems))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- twins

def build_twins(t0):
    subs = WORLD["subscriptions"]
    clocks = []
    for i in range(0, len(subs), CUSTOMERS_PER_CLOCK):
        clock = stripe.test_helpers.TestClock.create(frozen_time=t0, name=f"{TAG}-{i // CUSTOMERS_PER_CLOCK}")
        clocks.append(clock.id)

    def make(i_sub):
        i, s = i_sub
        clock = clocks[i // CUSTOMERS_PER_CLOCK]
        cust = stripe.Customer.create(
            name=f"{s['customer_name']} (twin)",
            test_clock=clock,
            metadata={"rehearsal_universe": TAG, "twin_of": s["customer"]},
        )
        pm = stripe.PaymentMethod.attach("pm_card_visa", customer=cust.id)
        stripe.Customer.modify(cust.id, invoice_settings={"default_payment_method": pm.id})
        params = dict(
            customer=cust.id,
            items=[{"price": it["price"], "quantity": it["quantity"]} for it in s["items"]],
            metadata={"rehearsal_universe": TAG, "twin_of": s["id"], **{k: v for k, v in s.get("metadata", {}).items()}},
            proration_behavior="none",
        )
        if s.get("trial_end") and s["trial_end"] > t0:
            params["trial_end"] = s["trial_end"]
        elif s.get("current_period_end") and s["current_period_end"] > t0 + 3600:
            params["billing_cycle_anchor"] = s["current_period_end"]
        if s.get("cancel_at_period_end"):
            params["cancel_at_period_end"] = True
        twin = stripe.Subscription.create(**params)
        return s["id"], {"twin_sub": twin.id, "twin_customer": cust.id, "clock": clock}

    with ThreadPoolExecutor(max_workers=6) as ex:
        twins = dict(ex.map(make, list(enumerate(subs))))
    return clocks, twins


def advance(clocks, target):
    def one(cid):
        stripe.test_helpers.TestClock.advance(cid, frozen_time=target)
        deadline = time.time() + 240
        while time.time() < deadline:
            c = stripe.test_helpers.TestClock.retrieve(cid)
            if c.status == "ready":
                return
            if c.status == "internal_failure":
                raise RuntimeError(f"test clock {cid} failed while advancing")
            time.sleep(1.5)
        raise TimeoutError(f"test clock {cid} did not finish advancing")

    with ThreadPoolExecutor(max_workers=len(clocks)) as ex:
        list(ex.map(one, clocks))


# ---------------------------------------------------------------- timeline + metrics

def existing_invoices(twins):
    """Invoices Stripe issued while the twins were being created: not part of the migration."""
    ids = set()
    for tw in twins.values():
        for inv in stripe.Invoice.list(customer=tw["twin_customer"], limit=20).auto_paging_iter():
            ids.add(inv.id)
    return ids


def collect(t0, twins, skip_ids=frozenset()):
    timeline = []
    for s in WORLD["subscriptions"]:
        tw = twins[s["id"]]
        sub = stripe.Subscription.retrieve(tw["twin_sub"], expand=["items.data.price"]).to_dict()
        after_items = []
        for it in sub["items"]["data"]:
            p = it["price"]
            rec = p.get("recurring") or {}
            entry = {"price": p["id"], "quantity": it.get("quantity") or 1, "unit_amount": p.get("unit_amount"),
                     "interval": rec.get("interval"), "interval_count": rec.get("interval_count", 1)}
            entry["_price"] = {"unit_amount": entry["unit_amount"], "interval": entry["interval"], "interval_count": entry["interval_count"]}
            after_items.append(entry)
        invoices = []
        for inv in stripe.Invoice.list(customer=tw["twin_customer"], limit=100).auto_paging_iter():
            if inv.id in skip_ids:
                continue
            inv = inv.to_dict()
            lines = []
            for ln in stripe.Invoice.list_lines(inv["id"], limit=100).auto_paging_iter():
                ln = ln.to_dict()
                price_id = None
                pricing = ln.get("pricing") or {}
                if pricing.get("price_details"):
                    price_id = pricing["price_details"].get("price")
                elif ln.get("price"):
                    price_id = ln["price"]["id"] if isinstance(ln["price"], dict) else ln["price"]
                parent = ln.get("parent") or {}
                proration = bool(ln.get("proration")) or bool(
                    (parent.get("subscription_item_details") or {}).get("proration"))
                lines.append({"price": price_id, "amount": ln.get("amount"), "quantity": ln.get("quantity"),
                              "proration": proration, "description": ln.get("description"),
                              "period_start": (ln.get("period") or {}).get("start"), "period_end": (ln.get("period") or {}).get("end")})
            invoices.append({"id": inv["id"], "month": month_index(inv["created"], t0), "created": inv["created"],
                             "status": inv["status"], "amount_due": inv["amount_due"], "amount_paid": inv["amount_paid"],
                             "billing_reason": inv.get("billing_reason"), "lines": lines})
        invoices.sort(key=lambda x: x["created"])
        timeline.append({
            "real_sub": s["id"], "customer_name": s["customer_name"],
            "before": {"items": [{**it, **{k: PRICES[it["price"]][k] for k in ("unit_amount", "interval", "interval_count")}}
                                 for it in s["items"] if it["price"] in PRICES],
                       "monthly": monthly_cents(s["items"]), "status": s["status"]},
            "after": {"items": [{k: v for k, v in it.items() if k != "_price"} for it in after_items],
                      "monthly": monthly_cents(after_items), "status": sub["status"]},
            "invoices": invoices,
        })
    return timeline


def baseline_revenue(t0):
    """What the status quo would collect per month: renewals at today's prices."""
    by_month = [0] * MONTHS
    for s in WORLD["subscriptions"]:
        if s.get("cancel_at_period_end"):
            continue
        for it in s["items"]:
            p = PRICES.get(it["price"])
            if not p:
                continue
            step = (12 if p["interval"] == "year" else 1) * (p.get("interval_count") or 1)
            nxt = s.get("trial_end") if s.get("trial_end") and s["trial_end"] > t0 else s.get("current_period_end")
            k = 0
            while nxt and month_index(nxt, t0) < MONTHS and k < 40:
                by_month[month_index(nxt, t0)] += p["unit_amount"] * it["quantity"]
                nxt = add_months(nxt, step)
                k += 1
    return by_month


def metrics(t0, timeline):
    revenue = [0] * MONTHS
    proration_total = 0
    proration_lines = 0
    failed = 0
    for c in timeline:
        for inv in c["invoices"]:
            if inv["month"] < MONTHS:
                revenue[inv["month"]] += inv["amount_paid"]
            if inv["status"] in ("open", "uncollectible"):
                failed += 1
            for ln in inv["lines"]:
                if ln["proration"]:
                    proration_lines += 1
                    proration_total += ln["amount"]
    mrr_before = sum(c["before"]["monthly"] for c in timeline)
    mrr_after = sum(c["after"]["monthly"] for c in timeline if c["after"]["status"] not in ("canceled",))
    changes = [(c["after"]["monthly"] - c["before"]["monthly"]) for c in timeline]
    increased = [d for d in changes if d > 0]
    max_pct = 0
    for c in timeline:
        b = c["before"]["monthly"]
        if b:
            max_pct = max(max_pct, round(100 * (c["after"]["monthly"] - b) / b))
    base = baseline_revenue(t0)
    return {
        "revenue_by_month": revenue, "baseline_by_month": base,
        "revenue_total": sum(revenue), "baseline_total": sum(base),
        "mrr_before": mrr_before, "mrr_after": mrr_after,
        "customers": len(timeline), "customers_increased": len(increased),
        "max_increase_pct": max_pct, "proration_lines": proration_lines,
        "proration_total": proration_total, "failed_invoices": failed,
    }


# ---------------------------------------------------------------- report page

def write_public(report):
    os.makedirs(f"{WORK}/public", exist_ok=True)
    with open(f"{WORK}/public/report.json", "w") as f:
        json.dump(report, f, indent=2)
    tpl = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "page.html")).read()
    with open(f"{WORK}/public/index.html", "w") as f:
        f.write(tpl.replace("__REPORT__", json.dumps(report).replace("</", "<\\/")))


# ---------------------------------------------------------------- main

def main():
    t0 = int(time.time())
    report = {"universe": UNIVERSE, "frozen_at": WORLD["frozen_at"], "t0": t0, "months": MONTHS,
              "strategy_sha256": hashlib.sha256(open(f"{WORK}/strategy.py", "rb").read()).hexdigest(),
              "phase": "twins", "guard_log": [], "migrations": [], "violations": [], "error": None}
    code = 0
    clocks = []
    write_public(report)
    try:
        log("phase", name="twins", subscriptions=len(WORLD["subscriptions"]))
        clocks, twins = build_twins(t0)
        report["clocks"] = clocks
        pre_ids = existing_invoices(twins)
        log("twins", count=len(twins), clocks=len(clocks))

        report["phase"] = "migrate"
        strategy = load_module("strategy")
        checks = load_module("checks")
        allow = [tw["twin_sub"] for tw in twins.values()]
        default_client = stripe.default_http_client
        guarded = guard.install(allow, TAG, report["guard_log"])
        ctx = {"mode": "rehearsal", "now": t0, "tag": TAG}
        try:
            prepared = strategy.prepare(stripe, WORLD, ctx) or {}
            for s in WORLD["subscriptions"]:
                sub = {**s, "live_id": twins[s["id"]]["twin_sub"]}
                out = strategy.migrate(stripe, sub, WORLD, prepared, ctx)
                report["migrations"].append({"real_sub": s["id"], "result": out})
                log("migrated", real_sub=s["id"], result=out)
        finally:
            stripe.default_http_client = default_client
        report["prepared"] = prepared
        report["guard_calls"] = len(guarded.log)

        report["phase"] = "simulate"
        for k in range(1, MONTHS + 1):
            advance(clocks, add_months(t0, k) + 2 * 3600)
            log("month", k=k, of=MONTHS)
            report["phase"] = f"simulate · month {k}/{MONTHS}"
            write_public(report)
        advance(clocks, add_months(t0, MONTHS) + 2 * 86400)  # let the last renewals finalize and pay

        report["phase"] = "check"
        timeline = collect(t0, twins, pre_ids)
        report["timeline"] = timeline
        report["metrics"] = metrics(t0, timeline)
        violations = checks.check(timeline, WORLD, prepared) or []
        report["violations"] = [str(v) for v in violations]
        code = 2 if violations else 0
        report["phase"] = "done"
    except guard.Refused as e:
        report["error"] = str(e)
        report["refused"] = True
        code = 3
    except Exception as e:
        report["error"] = "".join(traceback.format_exception(e))[-4000:]
        code = 3
    report["exit_code"] = code
    write_public(report)
    summary = {k: report.get(k) for k in ("phase", "error", "violations", "metrics", "strategy_sha256", "exit_code", "refused")}
    print("REHEARSAL_RESULT " + json.dumps(summary), flush=True)
    if report["error"]:
        print(report["error"], file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
