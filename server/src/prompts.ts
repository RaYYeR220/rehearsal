// Prompts for the three agent roles: planner, test writer, strategy coder (who also fixes).

export const CONTRACT = `
Runtime: Python 3.12, stripe-python 16 (recent Stripe API version), inside a CreateOS micro-VM whose
network only reaches api.stripe.com:443. The Stripe key is already configured; use the \`stripe\`
module passed in as an argument. Do NOT import requests/urllib/http/socket/subprocess, do NOT read
os.environ, do NOT open files, do NOT call eval/exec. A static check rejects those before your code runs.

Every Stripe request goes through a capability guard. Allowed:
  - any GET (retrieve/list/search)
  - creating prices, products and coupons (POST /v1/prices, /v1/products, /v1/coupons)
  - updating the subscription you were handed (sub["live_id"]) and its items
  - creating a subscription schedule FROM that subscription (from_subscription=sub["live_id"]) and then
    updating/releasing the schedule you created
  - invoice previews (stripe.Invoice.create_preview)
Anything else (deleting objects, touching any other subscription, customers, refunds, charges, payment
methods, payouts) raises guard.Refused and the run fails.

World data (world.json) is passed as a dict:
  world["prices"]: [{id, product, product_name, nickname, lookup_key, unit_amount (cents), currency,
                     interval ("month"|"year"), interval_count}]
  world["subscriptions"]: [{id, customer, customer_name, status ("active"|"trialing"|...), items:
                     [{price, quantity}], current_period_end (unix), trial_end, cancel_at_period_end,
                     metadata}]
  world["frozen_at"]: unix time the world was frozen.
`;

export const STRATEGY_CONTRACT = `
Write strategy.py with exactly these two functions:

def prepare(stripe, world, ctx) -> dict:
    """Runs once before any subscription is touched. Create the new prices/coupons the migration needs
    (find the product id from world["prices"]). Return a dict of whatever migrate() needs (e.g. new price ids).
    ctx = {"mode": "rehearsal" | "apply", "now": unix seconds (the clock you must treat as 'now'), "tag": str|None}
    Always use ctx["now"] instead of time.time(): during a rehearsal the subscriptions live on Stripe test
    clocks frozen at ctx["now"]."""

def migrate(stripe, sub, world, prepared, ctx) -> dict:
    """Change ONE subscription. sub is the world entry for it plus sub["live_id"], the id you must modify
    (during a rehearsal it is a twin on a test clock; during apply it is the real subscription).
    Leave subscriptions the policy says not to touch alone and return {"action": "skipped", "why": ...}.
    Return a small JSON-serialisable dict describing what you did."""

Notes that matter on the current Stripe API:
  - stripe-python 16 objects are NOT dicts: obj.get(...) raises. Use attribute or item access (s.id, s["items"]["data"])
    or convert with obj.to_dict() first. world/sub/prepared are plain dicts.
  - Retrieve the live subscription first: s = stripe.Subscription.retrieve(sub["live_id"]); item ids are in s["items"]["data"][i]["id"].
  - Swap a price in place: stripe.Subscription.modify(id, items=[{"id": item_id, "price": new_price}], proration_behavior=...).
    proration_behavior is one of "create_prorations" | "none" | "always_invoice".
  - Grandfathering for N months is done with a subscription schedule:
      sched = stripe.SubscriptionSchedule.create(from_subscription=id)
      phase0 = sched["phases"][0]  # its start_date is the current period start
      stripe.SubscriptionSchedule.modify(sched["id"], end_behavior="release", proration_behavior="none", phases=[
          {"items": [{"price": old_price, "quantity": q}], "start_date": phase0["start_date"], "end_date": <unix>},
          {"items": [{"price": new_price, "quantity": q}]},
      ])
    A schedule cannot be created for a subscription that is cancelling at period end or already has a schedule.
  - Prices are immutable; to change an amount create a new Price on the same product with the same interval.
  - Make prepare() idempotent within a run (create each new price once and reuse it).
`;

export const CHECKS_CONTRACT = `
Write checks.py with exactly one function:

def check(timeline, world, prepared) -> list[str]:
    """Return one human-readable string per policy violation. Empty list = the policy holds."""

timeline is a list, one entry per real subscription, after the migration ran and N months were simulated
on Stripe test clocks:
  {"real_sub": str, "customer_name": str,
   "before": {"items": [{price, quantity, unit_amount, interval, interval_count}], "monthly": cents, "status": str},
   "after":  {"items": [{price, quantity, unit_amount, interval, interval_count}], "monthly": cents, "status": str},
   "invoices": [{"id", "month": int (0 = migration day, 1 = first month after it, ...), "created": unix,
                 "status": "paid"|"open"|"draft"|"void"|"uncollectible", "amount_due": cents,
                 "amount_paid": cents, "billing_reason": "subscription_cycle"|"subscription_update"|
                 "subscription_create"|..., "lines": [{"price": id|None, "amount": cents, "quantity",
                 "proration": bool, "description", "period_start", "period_end"}]}]}
world is the frozen T0 world (see above). prepared is whatever strategy.prepare() returned (it may hold
new price ids, but checks must not depend on its exact shape: identify plans by unit_amount/interval and
world prices instead).

Write checks that are true to the founder's words, not to any particular strategy. Be precise about
which customers each rule covers. Typical rules: who must keep the old price and for how long, who must end
up on the new price, what must not be touched, no surprise charges (e.g. proration lines or invoices
above a stated amount), no failed invoices. A check must never raise; guard dict access with .get().
`;

export function plannerPrompt(intent: string, worldSummary: string, n: number) {
  return [
    {
      role: "system" as const,
      content: `You are the planning step of Rehearsal, an agent that rehearses SaaS pricing changes on Stripe before they touch a real customer. You read a founder's request and the frozen billing world, then (1) restate the request as a precise, testable policy and (2) propose ${n} materially different migration strategies that each honour the policy in a different way, so their outcomes can be compared side by side. Strategies should differ in mechanism (e.g. immediate swap with proration, swap at renewal without proration, subscription-schedule grandfathering, coupon-based soft landing), not in cosmetics. Each strategy runs exactly once, on migration day: there is no later job, cron or manual step, so anything that must happen in month 4 has to be scheduled inside Stripe today (subscription schedules, coupons with a duration, billing anchors). A strategy may knowingly trade off a soft goal, but it must be a real attempt at the policy. Reply with JSON only.`,
    },
    {
      role: "user" as const,
      content: `Founder's request:\n"""${intent}"""\n\nFrozen world:\n${worldSummary}\n\nReply with:\n{"policy": ["one precise, checkable rule per line", ...],\n "universes": [{"key": "a", "name": "2-4 word name", "approach": "2-3 sentences: exactly what this strategy does to which subscriptions and why it differs"}, ...${n} items]}`,
    },
  ];
}

export function checksPrompt(intent: string, policy: string[], worldJson: string) {
  return [
    { role: "system" as const, content: `You write the policy test for Rehearsal. The test is written BEFORE any strategy exists and every strategy is graded against it, so it must encode the founder's words exactly.\n${CONTRACT}\n${CHECKS_CONTRACT}` },
    {
      role: "user" as const,
      content: `Founder's request:\n"""${intent}"""\n\nPolicy:\n${policy.map((p) => `- ${p}`).join("\n")}\n\nworld.json:\n${worldJson}\n\nReturn checks.py in one \`\`\`python checks.py block.`,
    },
  ];
}

export function strategyPrompt(intent: string, policy: string[], universe: { name: string; approach: string }, worldJson: string, checks: string) {
  return [
    { role: "system" as const, content: `You write migration code for Rehearsal. Your code runs for real against Stripe: first on twin subscriptions on test clocks (a rehearsal), and later, only if a human approves, on the real subscriptions. Write careful, correct, minimal code.\n${CONTRACT}\n${STRATEGY_CONTRACT}` },
    {
      role: "user" as const,
      content: `Founder's request:\n"""${intent}"""\n\nPolicy:\n${policy.map((p) => `- ${p}`).join("\n")}\n\nYour strategy: ${universe.name}: ${universe.approach}\n\nworld.json:\n${worldJson}\n\nThe policy test your result will be graded with (checks.py):\n\`\`\`python\n${checks}\`\`\`\n\nReturn strategy.py in one \`\`\`python strategy.py block.`,
    },
  ];
}

export function fixPrompt(code: string, failure: string) {
  return {
    role: "user" as const,
    content: `That run failed. Here is what happened (stderr, guard refusals or policy violations):\n\n${failure}\n\nThe current strategy.py:\n\`\`\`python\n${code}\`\`\`\n\nDiagnose the root cause in one or two sentences, then return the complete corrected strategy.py in one \`\`\`python strategy.py block. If the failure is a policy violation, change the strategy's behaviour, never the policy.`,
  };
}

export function checksFixPrompt(code: string, failure: string) {
  return {
    role: "user" as const,
    content: `checks.py failed to load or crashed:\n\n${failure}\n\nCurrent checks.py:\n\`\`\`python\n${code}\`\`\`\n\nReturn the complete corrected checks.py in one \`\`\`python checks.py block.`,
  };
}
