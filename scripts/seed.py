"""Seed a test-mode Stripe account with a small, realistic SaaS billing world.

Inkwell (a writing app) with three plans and a dozen customers in different states:
monthly and annual Pro, Starter, per-seat Team, one trial, one cancelling at period end.
Renewal dates are spread across the month like a real customer base.

  STRIPE_SECRET_KEY=sk_test_... python scripts/seed.py
"""
import os
import sys
import time

import stripe

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY") or sys.exit("set STRIPE_SECRET_KEY (test mode)")
if not stripe.api_key.startswith(("sk_test_", "rk_test_")):
    sys.exit("refusing to seed anything but a test-mode key")

DAY = 86400
now = int(time.time())


def price(product, amount, interval, lookup_key, nickname):
    found = stripe.Price.list(lookup_keys=[lookup_key]).data
    if found:
        return found[0]
    return stripe.Price.create(product=product.id, unit_amount=amount, currency="usd",
                               recurring={"interval": interval}, lookup_key=lookup_key, nickname=nickname)


def product(name, key):
    found = [p for p in stripe.Product.search(query=f"metadata['seed_key']:'{key}'").data]
    return found[0] if found else stripe.Product.create(name=name, metadata={"seed_key": key})


starter = product("Inkwell Starter", "starter")
pro = product("Inkwell Pro", "pro")
team = product("Inkwell Team", "team")

P = {
    "starter_m": price(starter, 900, "month", "starter_monthly", "Starter monthly"),
    "pro_m": price(pro, 2000, "month", "pro_monthly", "Pro monthly"),
    "pro_y": price(pro, 20000, "year", "pro_annual", "Pro annual"),
    "team_m": price(team, 1500, "month", "team_seat_monthly", "Team per seat"),
}

CUSTOMERS = [
    # name, email, price, qty, renews_in_days, extra
    ("Maya Chen", "maya@northpaw.io", "pro_m", 1, 4, {}),
    ("Diego Alvarez", "diego@fieldnotes.co", "pro_m", 1, 9, {}),
    ("Priya Natarajan", "priya@lumen.dev", "pro_m", 1, 15, {}),
    ("Tom Becker", "tom@beckerlabs.de", "pro_m", 1, 21, {}),
    ("Aisha Okafor", "aisha@kettle.studio", "pro_m", 1, 27, {"cancel_at_period_end": True}),
    ("Lena Novak", "lena@quietpress.org", "pro_y", 1, 140, {}),
    ("Sam Whitfield", "sam@whitfield.law", "pro_y", 1, 290, {}),
    ("Kenji Watanabe", "kenji@inkblot.jp", "starter_m", 1, 6, {}),
    ("Rosa Martins", "rosa@cafeletra.pt", "starter_m", 1, 18, {}),
    ("Ola Lindqvist", "ola@fjord.se", "pro_m", 1, None, {"trial_days": 10}),
    ("Brightline Media", "billing@brightline.media", "team_m", 8, 12, {}),
    ("Harbor & Co", "ops@harborco.com", "team_m", 3, 24, {}),
]

existing = {c.email for c in stripe.Customer.list(limit=100).auto_paging_iter() if not c.get("test_clock")}
made = 0
for name, email, key, qty, renews, extra in CUSTOMERS:
    if email in existing:
        continue
    cust = stripe.Customer.create(name=name, email=email)
    pm = stripe.PaymentMethod.attach("pm_card_visa", customer=cust.id)
    stripe.Customer.modify(cust.id, invoice_settings={"default_payment_method": pm.id})
    params = {"customer": cust.id, "items": [{"price": P[key].id, "quantity": qty}]}
    if extra.get("trial_days"):
        params["trial_period_days"] = extra["trial_days"]
    else:
        params["billing_cycle_anchor"] = now + renews * DAY
        params["proration_behavior"] = "none"
    if extra.get("cancel_at_period_end"):
        params["cancel_at_period_end"] = True
    stripe.Subscription.create(**params)
    made += 1
    print(f"  + {name:<18} {P[key].nickname:<16} x{qty}")

print(f"seeded {made} subscriptions ({len(CUSTOMERS) - made} already present)")
