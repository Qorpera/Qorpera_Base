#!/usr/bin/env python3
"""A stub of Anthropic's two hosts with rotating refresh tokens, logging canary tags only.
Usage: renewal-stub.py PORT STATEFILE LOGFILE CERT KEY"""
import json, re, secrets, ssl, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, STATE, LOG, CERT, KEY = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
TAG_RE = re.compile("C2CAN" + r"ARY-([A-Z0-9]+)-")
lock = threading.Lock()
T0 = time.time()


def tag(s):
    m = TAG_RE.search(s or "")
    return m.group(1) if m else None


def state():
    with open(STATE) as f:
        return json.load(f)


def save(st):
    with open(STATE + ".tmp", "w") as f:
        json.dump(st, f)
    import os
    os.replace(STATE + ".tmp", STATE)


def log(rec):
    rec["t"] = round(time.time() - T0, 3)
    rec["wall"] = round(time.time(), 3)
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def base(self, method):
        auth = (self.headers.get("authorization") or "") + (self.headers.get("x-api-key") or "")
        return {"kind": "request", "method": method, "host": (self.headers.get("host") or "")[:60],
                "path": self.path.split("?")[0][:100], "bearer": tag(auth)}

    def do_GET(self):
        rec = self.base("GET")
        log(rec)
        self._send(200, "{}")

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        rec = self.base("POST")
        text = raw.decode("utf-8", "replace")
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
            if "grant_type=" in text:
                from urllib.parse import parse_qs
                req = {k: v[0] for k, v in parse_qs(text).items()}
        if "/oauth/token" in self.path:
            rec["kind"] = "refresh"
            rec["grant"] = str(req.get("grant_type", ""))[:40]
            rec["sent"] = tag(str(req.get("refresh_token", "")))
            rec["form"] = "json" if text.lstrip().startswith("{") else "form"
            rec["fields"] = sorted(req.keys())
            with lock:
                st = state()
                if st.get("refuse") or rec["sent"] is None or rec["sent"] != st.get("valid"):
                    rec["answer"] = "invalid_grant"
                    log(rec)
                    return self._send(400, json.dumps({"error": "invalid_grant",
                                                       "error_description": "Invalid refresh token"}))
                st["n"] = st.get("n", 0) + 1
                new = f"R{st['n']}"
                st["valid"] = new
                st.setdefault("exp", {})[new] = time.time() + int(st.get("expiresIn", 28800))
                save(st)
            rec["answer"] = new
            log(rec)
            access = "sk-ant-oat01-C2CAN" + f"ARY-{new}-" + secrets.token_hex(8)
            refresh = "sk-ant-ort01-C2CAN" + f"ARY-{new}-" + secrets.token_hex(8)
            return self._send(200, json.dumps({
                "token_type": "Bearer", "access_token": access, "refresh_token": refresh,
                "expires_in": int(st.get("expiresIn", 28800)),
                "scope": "user:inference user:profile user:sessions:claude_code",
                "account": {"uuid": "00000000-0000-4000-8000-0000000000c2", "email_address": "probe@example.invalid"},
                "organization": {"uuid": "00000000-0000-4000-8000-0000000000c3"}}))
        if "/messages" in self.path and "count_tokens" not in self.path:
            return self.messages(req, rec)
        log(rec)
        self._send(200, "{}")

    def messages(self, req, rec):
        st = state()
        tools = [t.get("name") for t in req.get("tools") or []]
        main = "Bash" in tools
        rec["main"] = main
        ended = (st.get("exp") or {}).get(rec["bearer"] or "")
        if rec["bearer"] in (st.get("revoked") or []) or (ended is not None and time.time() > ended):
            rec["answer"] = 401
            log(rec)
            return self._send(401, json.dumps({"type": "error", "error": {
                "type": "authentication_error", "message": "OAuth token has expired. Please obtain a new token or refresh your existing token."}}))
        done = 0
        for m in req.get("messages", []):
            if m.get("role") == "user" and isinstance(m.get("content"), list):
                done += sum(1 for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_result")
        steps = st.get("steps", [])
        rec["step"] = done
        log(rec)
        model = req.get("model", "claude-probe")
        if not main or done >= len(steps):
            block = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": "probe done" if main else "ok"}
            stop = "end_turn"
        else:
            block = {"type": "tool_use", "id": f"toolu_p{done}_{secrets.token_hex(3)}", "name": "Bash", "input": {}}
            delta = {"type": "input_json_delta", "partial_json": json.dumps({"command": steps[done], "description": "probe"})}
            stop = "tool_use"
        if not req.get("stream"):
            content = [{"type": "text", "text": delta["text"]}] if stop == "end_turn" else [dict(block, input=json.loads(delta["partial_json"]))]
            return self._send(200, json.dumps({"id": "msg_p", "type": "message", "role": "assistant", "model": model,
                                               "content": content, "stop_reason": stop, "stop_sequence": None,
                                               "usage": {"input_tokens": 10, "output_tokens": 5}}))
        ev = [{"type": "message_start", "message": {"id": "msg_p", "type": "message", "role": "assistant", "model": model,
                                                    "content": [], "stop_reason": None, "stop_sequence": None,
                                                    "usage": {"input_tokens": 10, "output_tokens": 1}}},
              {"type": "content_block_start", "index": 0, "content_block": block},
              {"type": "content_block_delta", "index": 0, "delta": delta},
              {"type": "content_block_stop", "index": 0},
              {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}},
              {"type": "message_stop"}]
        self._send(200, "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in ev), "text/event-stream")


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print("READY", flush=True)
    srv.serve_forever()
