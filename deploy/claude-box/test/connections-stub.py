#!/usr/bin/env python3
import json, signal, socket, ssl, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, SCEN, CERT, KEY, SUMMARY = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
sc = json.load(open(SCEN))
SUBS, HOLD = int(sc.get("subagents", 0)), int(sc.get("holdMs", 0)) / 1000
T0 = time.time()
lock = threading.Lock()
state = {"open": 0, "peak": 0, "connections": 0, "handshakeFailures": 0, "requests": [], "taskTool": None,
         "taskSchema": None, "peakAt": None}


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    return ""


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def setup(self):
        try:
            self.request.do_handshake()
        except Exception:
            with lock:
                state["handshakeFailures"] += 1
            raise
        with lock:
            state["open"] += 1
            state["connections"] += 1
            if state["open"] > state["peak"]:
                state["peak"], state["peakAt"] = state["open"], round(time.time() - T0, 3)
        super().setup()

    def finish(self):
        try:
            super().finish()
        finally:
            with lock:
                state["open"] -= 1

    def note(self, kind):
        with lock:
            state["requests"].append({"t": round(time.time() - T0, 3), "kind": kind, "path": self.path[:80],
                                      "open": state["open"]})

    def reply(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def chunk(self, data):
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def stream(self, model, blocks, stop, hold):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        event = lambda e: f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode()
        self.chunk(event({"type": "message_start", "message": {
            "id": "msg_ccap", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None,
            "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 1}}}))
        if hold:
            time.sleep(hold)
        out = b""
        for i, (start, delta) in enumerate(blocks):
            out += event({"type": "content_block_start", "index": i, "content_block": start})
            out += event({"type": "content_block_delta", "index": i, "delta": delta})
            out += event({"type": "content_block_stop", "index": i})
        out += event({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                      "usage": {"output_tokens": 5}})
        out += event({"type": "message_stop"})
        self.chunk(out)
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def do_GET(self):
        self.note("get")
        self.reply(200 if "models" in self.path else 404, {"models": [], "data": []})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        if "/oauth/token" in self.path:
            self.note("refresh")
            return self.reply(400, {"error": "invalid_grant"})
        if "count_tokens" in self.path:
            self.note("count")
            return self.reply(200, {"input_tokens": 100})
        if "/messages" not in self.path:
            self.note("other")
            return self.reply(404, {"error": "unknown"})
        tools = {t.get("name"): t for t in req.get("tools") or []}
        task = next((name for name in ("Task", "Agent") if name in tools), None)
        messages = req.get("messages") or []
        opening = text_of(messages[0].get("content")) if messages else ""
        model = req.get("model", "claude-ccap-stub")
        text = lambda t: [({"type": "text", "text": ""}, {"type": "text_delta", "text": t})]
        if "CCAP-SUB-" in opening:
            self.note("sub")
            return self.stream(model, text("done"), "end_turn", HOLD)
        if task is None:
            self.note("side")
            return self.stream(model, text("ok"), "end_turn", 0)
        with lock:
            state["taskTool"] = task
            state["taskSchema"] = sorted((tools[task].get("input_schema") or {}).get("properties", {}))
        answered = any(isinstance(b, dict) and b.get("type") == "tool_result"
                       for m in messages if isinstance(m.get("content"), list) for b in m["content"])
        if SUBS == 0 or answered:
            self.note("main-end")
            return self.stream(model, text("CCAP done."), "end_turn", 0)
        self.note("main-tasks")
        blocks = [({"type": "tool_use", "id": f"toolu_ccap{k}", "name": task, "input": {}},
                   {"type": "input_json_delta", "partial_json": json.dumps({
                       "description": f"sub {k}", "prompt": f"CCAP-SUB-{k}: answer done",
                       "subagent_type": "general-purpose"})}) for k in range(SUBS)]
        self.stream(model, blocks, "tool_use", 0)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(CERT, KEY)
server = Server(("127.0.0.1", PORT), H)
server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)


def stop(*_):
    with lock:
        json.dump({k: v for k, v in state.items() if k != "open"}, open(SUMMARY, "w"))
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
print("READY", flush=True)
server.serve_forever()
