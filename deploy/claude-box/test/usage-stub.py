#!/usr/bin/env python3
"""Claude login usage and resets: a stub of api.anthropic.com for the pinned Claude Code. NOT Anthropic: TLS on
127.0.0.1 with a proof CA, reached through usage-proxy.py. Nothing is forwarded anywhere.

- POST /v1/messages: one short text answer (streamed or not), carrying the unified rate-limit headers of the scenario.
- GET /api/oauth/usage[?...]: the scenario's plan windows (five_hour, seven_day, per-model `limits[]`) and, when the
  query asks for it (cedar_ember=1 or at_wall=1), the scenario's reset status block (`cedar_ember`).
- POST /api/organizations/<org>/reset_rate_limits: the scenario's claim answer: a JSON result, or `"http": 500`, or
  `"hang": true` (no answer until Claude Code gives up), counted in the log.
- POST|GET /api/eval/*: the feature values of the scenario (GrowthBook remote evaluation).
- POST */oauth/token: a renewal, logged as such (the proxy blocks its host, so it should never arrive).
- Everything else: 200 {} and logged.
Tokens carry a canary tag (C2CANARY-<TAG>-...); only the TAG is logged. The scenario is read again for each request.
Usage: usage-stub.py PORT SCENARIO LOGFILE CERT KEY"""
import json, re, ssl, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT, SCEN, LOG, CERT, KEY = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
TAG_RE = re.compile("C2CAN" + r"ARY-([A-Z0-9]+)-")
lock = threading.Lock()
T0 = time.time()


def scenario():
    with open(SCEN) as f:
        return json.load(f)


def tag(s):
    m = TAG_RE.search(s or "")
    return m.group(1) if m else None


def log(rec):
    rec["t"] = round(time.time() - T0, 3)
    with lock, open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


def iso(offset_s):
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + offset_s))


def usage_body(sc, query):
    u = sc.get("usage", {})
    body = {}
    for key in ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"):
        w = u.get(key)
        body[key] = None if w is None else {"utilization": w[0], "resets_at": iso(w[1])}
    body["limits"] = [{"kind": "weekly_scoped", "group": "weekly", "percent": m[1], "resets_at": iso(m[2]),
                       "severity": "normal", "is_active": True, "scope": {"model": {"display_name": m[0]}}}
                      for m in u.get("models", [])]
    body["extra_usage"] = None
    if "cedar_ember" in query or "at_wall" in query:
        block = sc.get("cedar_ember")
        if block is not None:
            block = json.loads(json.dumps(block).replace('"@ends"', json.dumps(iso(14 * 86400)))
                               .replace('"@week"', json.dumps(iso(3 * 86400))))
        body["cedar_ember"] = block
    return body


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json", headers=None):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _base(self, method, raw=b""):
        auth = (self.headers.get("authorization") or "") + (self.headers.get("x-api-key") or "")
        return {"kind": "request", "method": method, "path": self.path[:160], "host": (self.headers.get("host") or "")[:60],
                "auth": tag(auth), "bytes": len(raw)}

    def do_GET(self):
        self.route("GET", b"")

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        self.route("POST", self.rfile.read(n) if n else b"")

    def route(self, method, raw):
        sc = scenario()
        rec = self._base(method, raw)
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path.endswith("/oauth/token"):
            rec["kind"] = "renewal"
            log(rec)
            return self._send(400, json.dumps({"error": "invalid_grant"}))
        if url.path == "/api/oauth/usage":
            rec["kind"] = "usage"
            log(rec)
            return self._send(200, json.dumps(usage_body(sc, query)))
        m = re.match(r"^/api/organizations/([^/]+)/reset_rate_limits$", url.path)
        if m and method == "POST":
            try:
                req = json.loads(raw or b"{}")
            except Exception:
                req = {}
            rec.update(kind="claim", org=m.group(1)[:40], grant=str(req.get("grant_id", ""))[:40],
                       program=str(req.get("program", ""))[:40], requestId=bool(req.get("request_id")))
            log(rec)
            claim = sc.get("claim", {"result": "unavailable"})
            if claim.get("hang"):
                time.sleep(90)
                return self._send(504, "{}")
            if claim.get("http"):
                return self._send(int(claim["http"]), json.dumps({"error": {"type": "api_error"}}))
            return self._send(200, json.dumps(claim))
        if url.path.startswith("/api/eval"):
            rec["kind"] = "flags"
            log(rec)
            features = {k: {"value": v, "defaultValue": v} for k, v in sc.get("flags", {}).items()}
            return self._send(200, json.dumps({"features": features, "experiments": []}))
        if url.path == "/api/oauth/profile":
            rec["kind"] = "profile"
            log(rec)
            return self._send(200, json.dumps({
                "account": {"uuid": "00000000-0000-4000-8000-0000000000c2", "email": "c2@example.invalid",
                            "email_address": "c2@example.invalid", "full_name": "Probe", "display_name": "Probe",
                            "has_claude_max": True, "has_claude_pro": False},
                "organization": {"uuid": "00000000-0000-4000-8000-0000000000c3", "name": "Probe",
                                 "organization_type": "claude_max", "billing_type": "stripe_subscription",
                                 "rate_limit_tier": "default_claude_max_20x", "has_extra_usage_enabled": False}}))
        if "/messages" in url.path and method == "POST":
            return self.messages(sc, rec, raw)
        log(rec)
        return self._send(200, "{}")

    def messages(self, sc, rec, raw):
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        rec["kind"] = "messages"
        msgs = req.get("messages") or []
        first = msgs[0].get("content") if msgs else ""
        if isinstance(first, list):
            first = " ".join(b.get("text", "") for b in first if isinstance(b, dict))
        rec.update(model=str(req.get("model", ""))[:60], maxTokens=req.get("max_tokens"), nmsgs=len(msgs),
                   tools=len(req.get("tools") or []), first=str(first)[:200])
        log(rec)
        h = sc.get("headers", {})
        now = int(time.time())
        headers = {
            "anthropic-ratelimit-unified-status": h.get("status", "allowed"),
            "anthropic-ratelimit-unified-representative-claim": h.get("claim", "five_hour"),
            "anthropic-ratelimit-unified-reset": now + int(h.get("5hReset", 9660)),
            "anthropic-ratelimit-unified-5h-status": h.get("5hStatus", "allowed"),
            "anthropic-ratelimit-unified-5h-utilization": h.get("5h", 0.28),
            "anthropic-ratelimit-unified-5h-reset": now + int(h.get("5hReset", 9660)),
            "anthropic-ratelimit-unified-7d-status": h.get("7dStatus", "allowed"),
            "anthropic-ratelimit-unified-7d-utilization": h.get("7d", 0.5),
            "anthropic-ratelimit-unified-7d-reset": now + int(h.get("7dReset", 360000)),
        }
        model = req.get("model", "claude-stub")
        text = "ok"
        if not req.get("stream"):
            return self._send(200, json.dumps({"id": "msg_u", "type": "message", "role": "assistant", "model": model,
                                               "content": [{"type": "text", "text": text}], "stop_reason": "end_turn",
                                               "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 1}}),
                              headers=headers)
        ev = [{"type": "message_start", "message": {"id": "msg_u", "type": "message", "role": "assistant", "model": model,
                                                    "content": [], "stop_reason": None, "stop_sequence": None,
                                                    "usage": {"input_tokens": 10, "output_tokens": 1}}},
              {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
              {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
              {"type": "content_block_stop", "index": 0},
              {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
               "usage": {"output_tokens": 1}},
              {"type": "message_stop"}]
        self._send(200, "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in ev), "text/event-stream",
                   headers)


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)
srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
srv.daemon_threads = True
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print("READY", flush=True)
srv.serve_forever()
