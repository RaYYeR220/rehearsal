"""Guard tests. Run against a Stripe test-mode key:

  STRIPE_SECRET_KEY=sk_test_... python -m pytest sandbox/test_guard.py -q

No request in this file is allowed to reach Stripe unless the test says so; every
refusal happens inside the client before the socket is opened.
"""
import os

import pytest
import stripe

import guard

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_placeholder")
ALLOWED = "sub_allowed000000000000"


@pytest.fixture(autouse=True)
def guarded():
    default = stripe.default_http_client
    log = []
    client = guard.install([ALLOWED], "rh-test", log)
    yield client, log
    stripe.default_http_client = default


def test_other_subscription_is_refused(guarded):
    with pytest.raises(guard.Refused, match="not on the approved list"):
        stripe.Subscription.modify("sub_someoneelse0000000", metadata={"x": "1"})


def test_cancel_is_refused(guarded):
    with pytest.raises(guard.Refused):
        stripe.Subscription.cancel("sub_someoneelse0000000")


def test_refund_is_refused(guarded):
    with pytest.raises(guard.Refused, match="outside the strategy's capabilities"):
        stripe.Refund.create(payment_intent="pi_123")


def test_customer_write_is_refused(guarded):
    with pytest.raises(guard.Refused):
        stripe.Customer.modify("cus_123", email="x@example.com")


def test_delete_is_refused(guarded):
    with pytest.raises(guard.Refused, match="deletes are not allowed"):
        stripe.Product.delete("prod_123")


def test_schedule_from_other_subscription_is_refused(guarded):
    with pytest.raises(guard.Refused, match="approved subscription"):
        stripe.SubscriptionSchedule.create(from_subscription="sub_someoneelse0000000")


def test_foreign_schedule_update_is_refused(guarded):
    with pytest.raises(guard.Refused):
        stripe.SubscriptionSchedule.modify("sub_sched_notours0000", end_behavior="release")


def test_refusals_are_logged(guarded):
    _, log = guarded
    with pytest.raises(guard.Refused):
        stripe.Payout.create(amount=100, currency="usd")
    assert log[-1]["allowed"] is False


def test_static_check_rejects_escape_hatches():
    src = "import requests\nimport os\nk = os.environ['STRIPE_SECRET_KEY']\nexec('1')\nopen('/etc/passwd')\n"
    problems = guard.static_check(src)
    assert len(problems) >= 4


def test_static_check_accepts_plain_strategy():
    src = "def prepare(stripe, world, ctx):\n    return {}\n\ndef migrate(stripe, sub, world, prepared, ctx):\n    return {'action': 'skipped'}\n"
    assert guard.static_check(src) == []


@pytest.mark.skipif(not os.environ.get("STRIPE_SECRET_KEY", "").startswith("sk_test_"), reason="needs a test-mode key")
def test_catalog_create_is_tagged(guarded):
    price = stripe.Price.create(unit_amount=123, currency="usd", product_data={"name": "guard test"}, recurring={"interval": "month"})
    assert price.metadata["rehearsal_universe"] == "rh-test"
    stripe.default_http_client = None
    stripe.Product.modify(price.product, active=False)
