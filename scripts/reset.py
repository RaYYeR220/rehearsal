"""Put the seeded test-mode world back the way seed.py left it.

Releases subscription schedules on real subscriptions, moves any real subscription
that was migrated back to its seeded price, archives prices that seed.py didn't create,
and deletes rehearsal test clocks (which deletes the twin customers on them).

  STRIPE_SECRET_KEY=sk_test_... python scripts/reset.py
"""
import os
import sys

import stripe

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY") or sys.exit("set STRIPE_SECRET_KEY (test mode)")
if not stripe.api_key.startswith(("sk_test_", "rk_test_")):
    sys.exit("refusing to touch anything but a test-mode key")

SEED_KEYS = {"starter_monthly", "pro_monthly", "pro_annual", "team_seat_monthly"}
seeded = {p.lookup_key: p for p in stripe.Price.list(lookup_keys=list(SEED_KEYS), limit=10).data}
by_product_interval = {(p.product, p.recurring.interval): p.id for p in seeded.values()}

clocks = list(stripe.test_helpers.TestClock.list(limit=100).auto_paging_iter())
for c in clocks:
    stripe.test_helpers.TestClock.delete(c.id)
print(f"deleted {len(clocks)} test clocks")

released = moved = 0
for s in stripe.Subscription.list(status="all", limit=100, expand=["data.customer"]).auto_paging_iter():
    s = s.to_dict()
    if s["status"] in ("canceled", "incomplete_expired") or s["customer"].get("test_clock"):
        continue
    if s.get("schedule"):
        stripe.SubscriptionSchedule.release(s["schedule"])
        released += 1
    item = s["items"]["data"][0]
    price = item["price"]
    if price.get("lookup_key") not in SEED_KEYS:
        target = by_product_interval.get((price["product"], price["recurring"]["interval"]))
        if target:
            stripe.Subscription.modify(s["id"], items=[{"id": item["id"], "price": target}], proration_behavior="none")
            moved += 1
print(f"released {released} schedules, moved {moved} subscriptions back")

archived = 0
for p in stripe.Price.list(active=True, limit=100).auto_paging_iter():
    if p.lookup_key not in SEED_KEYS:
        try:
            stripe.Price.modify(p.id, active=False)
            archived += 1
        except stripe.InvalidRequestError:
            pass  # a product's default price can't be archived; its product is archived below
for prod in stripe.Product.list(active=True, limit=100).auto_paging_iter():
    if "seed_key" not in prod.metadata.to_dict():
        stripe.Product.modify(prod.id, active=False)
print(f"archived {archived} prices")
