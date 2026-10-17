"""Capability guard for strategy code.

Strategy code is written by the agent and talks to Stripe through stripe-python.
Every request goes through GuardedClient, which allows reads, catalog writes that
carry this run's tag, and writes to the subscriptions on the allowlist. Anything
else raises Refused before a byte leaves the VM. The same guard runs during the
rehearsal (allowlist = twin subscriptions) and during the real apply
(allowlist = the subscriptions the founder approved), so a strategy can't pass
the rehearsal and then do something different in production.

Layer two is the VM's egress rule (api.stripe.com:443 only); layer three is the
static check on the source before it ever runs.
"""
import ast
import json
import re
from urllib.parse import parse_qs, urlparse

import stripe


class Refused(Exception):
    pass


FORBIDDEN_IMPORTS = {"requests", "urllib", "urllib3", "http", "httpx", "socket", "subprocess", "aiohttp", "ctypes", "importlib", "shutil"}
FORBIDDEN_CALLS = {"eval", "exec", "compile", "__import__", "open"}


def static_check(source: str) -> list:
    """Reject strategy source that reaches outside the Stripe client."""
    problems = []
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.split(".")[0] in FORBIDDEN_IMPORTS:
                    problems.append(f"line {node.lineno}: import {a.name} is not allowed")
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] in FORBIDDEN_IMPORTS:
                problems.append(f"line {node.lineno}: from {node.module} import is not allowed")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
            problems.append(f"line {node.lineno}: {node.func.id}() is not allowed")
        elif isinstance(node, ast.Attribute) and node.attr in ("environ", "system", "popen", "api_key"):
            problems.append(f"line {node.lineno}: .{node.attr} is not allowed")
    return problems


SUB_PATH = re.compile(r"^/v1/subscriptions/(sub_[A-Za-z0-9]+)(/.*)?$")
SUB_ITEM_PATH = re.compile(r"^/v1/subscription_items(/si_[A-Za-z0-9]+)?$")
SCHED_PATH = re.compile(r"^/v1/subscription_schedules(/sub_sched_[A-Za-z0-9]+)?(/(release|cancel))?$")
CATALOG_CREATE = {"/v1/prices", "/v1/products", "/v1/coupons"}


class GuardedClient(stripe.RequestsClient):
    def __init__(self, allow_subs, tag, schedule_ids=None, log=None, **kw):
        super().__init__(**kw)
        self.allow_subs = set(allow_subs)
        self.tag = tag  # metadata every created catalog object must carry (None in apply mode)
        self.schedules = set(schedule_ids or [])  # schedules created from allowed subs during this run
        self.item_ids = set()
        self.log = log if log is not None else []

    def _refuse(self, method, path, why):
        self.log.append({"method": method, "path": path, "allowed": False, "why": why})
        raise Refused(f"REFUSED {method} {path}: {why}")

    def request(self, method, url, headers, post_data=None):
        method = method.upper()
        u = urlparse(url)
        path = u.path
        if u.hostname != "api.stripe.com":
            self._refuse(method, url, "only api.stripe.com is reachable")
        form = parse_qs(post_data.decode() if isinstance(post_data, bytes) else (post_data or ""))

        if method == "GET":
            body, status, resp_headers = super().request(method, url, headers, post_data)
            self._learn(body, status)
            return body, status, resp_headers

        if method == "DELETE":
            m = SUB_ITEM_PATH.match(path)
            if m and m.group(1) and m.group(1)[1:] in self.item_ids:
                pass
            else:
                self._refuse(method, path, "deletes are not allowed")
        elif path in CATALOG_CREATE:
            if self.tag and form.get("metadata[rehearsal_universe]", [None])[0] != self.tag:
                # tag it ourselves so rehearsal objects never leak into the real catalog
                extra = f"metadata[rehearsal_universe]={self.tag}"
                post_data = (post_data.decode() + "&" + extra) if isinstance(post_data, bytes) else ((post_data or "") + "&" + extra)
        elif SUB_PATH.match(path):
            sub_id = SUB_PATH.match(path).group(1)
            if sub_id not in self.allow_subs:
                self._refuse(method, path, f"{sub_id} is not on the approved list")
        elif SUB_ITEM_PATH.match(path):
            m = SUB_ITEM_PATH.match(path)
            if m.group(1):
                if m.group(1)[1:] not in self.item_ids:
                    self._refuse(method, path, "subscription item is not on an approved subscription")
            else:
                sub_id = form.get("subscription", [None])[0]
                if sub_id not in self.allow_subs:
                    self._refuse(method, path, f"{sub_id} is not on the approved list")
        elif SCHED_PATH.match(path):
            m = SCHED_PATH.match(path)
            if m.group(1) is None:
                src = form.get("from_subscription", [None])[0]
                if src not in self.allow_subs:
                    self._refuse(method, path, "schedules may only be created from an approved subscription")
            elif m.group(1)[1:] not in self.schedules:
                self._refuse(method, path, "schedule was not created from an approved subscription")
        elif path.startswith("/v1/invoices/create_preview") or path == "/v1/invoices/upcoming":
            pass  # previews don't move money
        else:
            self._refuse(method, path, "endpoint is outside the strategy's capabilities")

        body, status, resp_headers = super().request(method, url, headers, post_data)
        self.log.append({"method": method, "path": path, "allowed": True, "status": status})
        if status < 300 and SCHED_PATH.match(path):
            try:
                self.schedules.add(json.loads(body)["id"])
            except Exception:
                pass
        self._learn(body, status)
        return body, status, resp_headers

    def _learn(self, body, status):
        """Remember item ids of approved subscriptions so item-level edits can be checked."""
        if status >= 300:
            return
        try:
            obj = json.loads(body)
        except Exception:
            return
        objs = obj.get("data", [obj]) if obj.get("object") == "list" else [obj]
        for o in objs:
            if isinstance(o, dict) and o.get("object") == "subscription" and o.get("id") in self.allow_subs:
                for it in (o.get("items") or {}).get("data", []):
                    self.item_ids.add(it["id"])


def install(allow_subs, tag, log):
    client = GuardedClient(allow_subs, tag, log=log)
    stripe.default_http_client = client
    return client
