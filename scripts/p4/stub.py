#!/usr/bin/env python3
"""P4 scripted model stub (from P2's). NOT a model: answers the Anthropic Messages API (Claude Code) and the OpenAI
Responses API (Codex) on 127.0.0.1 with a fixed list of tool calls from a scenario file, and records each tool result.
Usage: stub.py PORT LOGFILE SCENARIO.json
Logs: requests (tool names on the first main request, which canary tag the auth carried), results (tags, text head),
and per step the ms from sending the tool call to receiving its result. Never forwards anything."""
import json, re, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG, SCEN = int(sys.argv[1]), sys.argv[2], sys.argv[3]
lock = threading.Lock()
TAG_RE = re.compile("P4CAN" + r"ARY-([A-Z]+)-")
T0 = time.time()
sc = json.load(open(SCEN))
steps = sc.get("steps", [])
sent_at = {}
seen = set()
first_tools = []
bg = {"id": ""}
BG_RE = re.compile(r"with ID: ([A-Za-z0-9_-]+)")


def tags(s):
    return sorted(set(TAG_RE.findall(s or "")))


def log(rec):
    rec["t"] = round(time.time() - T0, 4)
    with lock, open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


def content_text(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for b in c:
            if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text"):
                out.append(b.get("text", ""))
            elif isinstance(b, dict):
                out.append(json.dumps(b)[:3000])
            else:
                out.append(str(b))
        return "\n".join(out)
    return json.dumps(c)


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

    def _sse(self, events):
        self._send(200, "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events), "text/event-stream")

    def do_GET(self):
        auth = (self.headers.get("authorization") or "") + (self.headers.get("x-api-key") or "")
        log({"kind": "request", "method": "GET", "path": self.path, "auth_tags": tags(auth)})
        self._send(200 if "models" in self.path else 404, json.dumps({"models": [], "data": []}))

    def do_HEAD(self):
        self._send(200, b"")

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        auth = (self.headers.get("authorization") or "") + (self.headers.get("x-api-key") or "")
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        base = {"kind": "request", "path": self.path, "auth_tags": tags(auth), "auth_scheme": auth.split(" ")[0][:12],
                "body_tags": tags(raw.decode("utf-8", "replace")), "bytes": len(raw)}
        if "count_tokens" in self.path:
            log(base)
            return self._send(200, json.dumps({"input_tokens": 100}))
        if "/messages" in self.path:
            return self.anthropic(req, base)
        if "/responses" in self.path:
            return self.openai_responses(req, base)
        log(base)
        self._send(404, json.dumps({"error": "unknown"}))

    def note_result(self, i, txt, is_error=False):
        if i in seen:
            return
        seen.add(i)
        mm = BG_RE.search(txt or "")
        if mm:
            bg["id"] = mm.group(1)
        ms = round((time.time() - sent_at[i]) * 1000, 1) if i in sent_at else None
        log({"kind": "result", "step": i, "tool": steps[i]["tool"] if i < len(steps) else "?", "name": steps[i].get("name", ""),
             "ms": ms, "is_error": is_error, "tags": tags(txt), "len": len(txt), "text": txt[:6000]})

    def anthropic(self, req, base):
        tools = [t.get("name") for t in req.get("tools") or []]
        main = "Bash" in tools or "Read" in tools
        base["main"] = main
        base["ntools"] = len(tools)
        if main and not first_tools:
            first_tools.extend(tools)
            base["tools"] = tools
        log(base)
        done = {}
        for m in req.get("messages", []):
            if m.get("role") == "user" and isinstance(m.get("content"), list):
                for b in m["content"]:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        mm = re.match(r"toolu_p4s(\d+)_", b.get("tool_use_id", ""))
                        if mm:
                            done[int(mm.group(1))] = b
        for i, b in sorted(done.items()):
            self.note_result(i, content_text(b.get("content")), b.get("is_error", False))
        nxt = (max(done) + 1) if done else 0
        if not main or nxt >= len(steps):
            blocks = [("text", {"type": "text", "text": ""}, {"type": "text_delta", "text": "ok" if not main else "P4 done."})]
            stop = "end_turn"
        else:
            st = steps[nxt]
            sent_at[nxt] = time.time()
            tu = {"type": "tool_use", "id": f"toolu_p4s{nxt}_{sc.get('nonce', 'x')}", "name": st["tool"], "input": {}}
            blocks = [("tool", tu, {"type": "input_json_delta", "partial_json": json.dumps(st["input"]).replace("{bgid}", bg["id"])})]
            stop = "tool_use"
        model = req.get("model", "claude-p4-stub")
        if not req.get("stream"):
            content = []
            for kind, start, delta in blocks:
                if kind == "text":
                    content.append({"type": "text", "text": delta["text"]})
                else:
                    c = dict(start)
                    c["input"] = json.loads(delta["partial_json"])
                    content.append(c)
            return self._send(200, json.dumps({"id": "msg_p4", "type": "message", "role": "assistant", "model": model,
                                               "content": content, "stop_reason": stop, "stop_sequence": None,
                                               "usage": {"input_tokens": 10, "output_tokens": 5}}))
        ev = [{"type": "message_start", "message": {"id": "msg_p4", "type": "message", "role": "assistant", "model": model,
                                                    "content": [], "stop_reason": None, "stop_sequence": None,
                                                    "usage": {"input_tokens": 10, "output_tokens": 1}}}]
        for idx, (kind, start, delta) in enumerate(blocks):
            ev += [{"type": "content_block_start", "index": idx, "content_block": start},
                   {"type": "content_block_delta", "index": idx, "delta": delta},
                   {"type": "content_block_stop", "index": idx}]
        ev += [{"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}},
               {"type": "message_stop"}]
        self._sse(ev)

    def openai_responses(self, req, base):
        tools = {}
        for t in req.get("tools") or []:
            nm = t.get("name") or (t.get("function") or {}).get("name")
            if nm:
                tools[nm] = t.get("type")
        if tools and not first_tools:
            first_tools.extend(sorted(tools))
            base["tools"] = sorted(tools)
        log(base)
        done = {}
        for it in req.get("input") or []:
            if isinstance(it, dict) and it.get("type") in ("function_call_output", "custom_tool_call_output"):
                mm = re.match(r"call_p4s(\d+)_", it.get("call_id", ""))
                if mm:
                    done[int(mm.group(1))] = it
        for i, it in sorted(done.items()):
            o = it.get("output")
            self.note_result(i, o if isinstance(o, str) else content_text(o))
        nxt = (max(done) + 1) if done else 0
        ev = [{"type": "response.created", "response": {"id": "resp_p4"}}]
        if nxt >= len(steps) or not tools:
            ev.append({"type": "response.output_item.done", "item": {"type": "message", "role": "assistant", "id": "msg_p4",
                                                                     "content": [{"type": "output_text", "text": "P4 done."}]}})
        else:
            st = steps[nxt]
            sent_at[nxt] = time.time()
            cid = f"call_p4s{nxt}_{sc.get('nonce', 'x')}"
            if st["tool"] == "shell":
                item = {"type": "function_call", "name": "exec_command", "call_id": cid,
                        "arguments": json.dumps({"cmd": st["input"]["cmd"], "yield_time_ms": st["input"].get("yield", 60000),
                                                 "max_output_tokens": 20000})}
            elif st["tool"] == "apply_patch":
                item = {"type": "custom_tool_call", "name": "apply_patch", "call_id": cid, "input": st["input"]["patch"]}
            else:
                item = {"type": "function_call", "name": st["tool"], "call_id": cid, "arguments": json.dumps(st["input"])}
            ev.append({"type": "response.output_item.done", "item": item})
        ev.append({"type": "response.completed", "response": {"id": "resp_p4", "usage": {
            "input_tokens": 10, "input_tokens_details": None, "output_tokens": 5, "output_tokens_details": None,
            "total_tokens": 15}}})
        self._sse(ev)


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    log({"kind": "start", "port": PORT, "scenario": sc.get("label"), "steps": len(steps)})
    srv.serve_forever()
