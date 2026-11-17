#!/bin/bash
# C2 proof: what one proof's runs left in B (the stub's view of each tool call, Claude Code's stream, its stderr, the
# canary anywhere in the run host's run folders but the login folders). Usage: report.sh B LABEL MODE (as root).
B=$1 LABEL=$2 MODE=$3
echo "=== stub results"
for f in $B/out-$LABEL/stub-*.jsonl; do
	python3 - "$f" <<'PY'
import json, sys
fn = sys.argv[1]
lines = [json.loads(l) for l in open(fn)]
print(f"--- {fn.split('/')[-1]}")
for l in lines:
    if l.get("tools"):
        print("  tools offered:", " ".join(l["tools"]))
    if l["kind"] == "result":
        txt = l["text"].replace("\n", " | ")
        print(f"  [{l['step']:2}] {l['tool']:12} {l['name']:22} {l['ms']!s:>8} ms err={l['is_error']!s:5} tags={l['tags']} :: {txt[:500]}")
    if l["kind"] == "sub-result":
        print(f"  [sub] err={l['is_error']!s:5} tags={l['tags']} :: {l['text'].replace(chr(10), ' | ')[:500]}")
    if l["kind"] == "refresh":
        print(f"  REFRESH grant={l.get('grant')} auth={l['auth_tags']} body={l['body_tags']}")
PY
done
echo "=== Claude Code's stream (types, the result) and stderr"
for f in $B/out-$LABEL/stream-*.jsonl; do
	echo "--- $(basename $f)"
	python3 - "$f" <<'PY'
import json, sys
for l in open(sys.argv[1]):
    l = l.strip()
    if not l:
        continue
    try:
        d = json.loads(l)
    except Exception:
        print("  raw:", l[:300]); continue
    t = d.get("type")
    if t == "result" or (t == "system" and d.get("subtype") == "init"):
        print("  ", json.dumps({k: d.get(k) for k in ("type", "subtype", "is_error", "num_turns", "result", "tools", "permissionMode", "apiKeySource", "cwd", "model")})[:900])
    elif t == "assistant" and any(b.get("type") == "text" for b in d.get("message", {}).get("content", [])):
        print("   assistant text:", json.dumps([b.get("text") for b in d["message"]["content"] if b.get("type") == "text"])[:300])
PY
done
[[ $MODE == look ]] && cat $B/out-$LABEL/stream-*.jsonl
tail -c 600 $B/sftp.err $B/exec.err 2>/dev/null
for f in $B/out-$LABEL/stderr-*.txt; do echo "--- $(basename $f)"; tail -c 1500 $f; echo; done
echo "=== canary in the run host's run folders (login folders are the caller's and hold it by design)"
grep -rlE --binary-files=text "C2CAN""ARY-[A-Z0-9]+-[0-9a-f]{16}" $B 2>/dev/null | grep -v "^$B/login-" | sed 's/^/canary: /' || true
grep -rlE --binary-files=text "C2CAN""ARY-[A-Z0-9]+-[0-9a-f]{16}" $B 2>/dev/null | grep -v "^$B/login-" | grep -q . || echo "no canary outside the login folders"
