"""Freeze the billing world at T0.

Reads the catalog and every live subscription from the Stripe account this
sandbox was given and writes /work/world.json. Every universe is forked from
the same paused VM, so every universe starts from this exact file.
"""
import json
import os
import time

import stripe

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
OUT = os.environ.get("WORLD_PATH", "/work/world.json")


def main():
    products = {}
    for prod in stripe.Product.list(active=True, limit=100).auto_paging_iter():
        prod = prod.to_dict()
        if (prod.get("metadata") or {}).get("rehearsal_universe"):
            continue  # objects created by earlier rehearsals are not part of the real world
        products[prod["id"]] = {"id": prod["id"], "name": prod["name"]}

    prices = []
    for p in stripe.Price.list(active=True, limit=100).auto_paging_iter():
        p = p.to_dict()
        if p["product"] not in products or not p.get("recurring") or (p.get("metadata") or {}).get("rehearsal_universe"):
            continue
        prices.append({
            "id": p["id"],
            "product": p["product"],
            "product_name": products[p["product"]]["name"],
            "nickname": p.get("nickname"),
            "lookup_key": p.get("lookup_key"),
            "unit_amount": p.get("unit_amount"),
            "currency": p["currency"],
            "interval": p["recurring"]["interval"],
            "interval_count": p["recurring"].get("interval_count", 1),
        })
    price_ids = {p["id"] for p in prices}

    subs = []
    for s in stripe.Subscription.list(status="all", limit=100, expand=["data.customer"]).auto_paging_iter():
        s = s.to_dict()
        if s["status"] in ("canceled", "incomplete_expired"):
            continue
        cust = s["customer"]
        if cust.get("test_clock") or (cust.get("metadata") or {}).get("rehearsal_universe"):
            continue  # twins from earlier rehearsals are not real customers
        items = [{"price": it["price"]["id"], "quantity": it.get("quantity") or 1} for it in s["items"]["data"]]
        if not any(i["price"] in price_ids for i in items):
            continue
        first = s["items"]["data"][0]
        subs.append({
            "id": s["id"],
            "customer": cust["id"],
            "customer_name": cust.get("name") or cust.get("email") or cust["id"],
            "status": s["status"],
            "items": items,
            "current_period_end": first.get("current_period_end") or s.get("current_period_end"),
            "trial_end": s.get("trial_end"),
            "cancel_at_period_end": bool(s.get("cancel_at_period_end")),
            "metadata": dict(s.get("metadata") or {}),
        })

    world = {"frozen_at": int(time.time()), "products": list(products.values()), "prices": prices, "subscriptions": subs}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(world, f, indent=2)
    print(json.dumps({"ok": True, "products": len(products), "prices": len(prices), "subscriptions": len(subs)}))


if __name__ == "__main__":
    main()
