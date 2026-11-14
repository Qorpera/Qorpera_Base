#!/bin/bash
# P4: Codex in its own box at the same time as Claude Code's, with its own shell and apply_patch on the SAME home
# through its own channel (environments.toml, include_local=false, `codex stdio-to-uds` to the host's cx socket).
# Its made-up ChatGPT sign-in sits in its CODEX_HOME inside its box. Usage: codex-box.sh LABEL KIND SOCKDIR
set -uo pipefail
LABEL=$1 KIND=$2 SOCK=$3
P=/home/tester/lanes/agent-box-P4
HERE=$(cd "$(dirname "$0")" && pwd)
O=$P/out/$LABEL/cx
CODEX=/opt/qorpera-codex-fence/codex
rm -rf "$O"; install -d -m 0755 "$O" "$O/p4"; install -d -o nobody -g nogroup -m 0700 "$O/codex-home" "$O/out" "$O/work"
cp "$HERE"/{stub.py,scen.py} "$O/p4/"
python3 "$O/p4/scen.py" "$KIND" "$O/p4/scenario.json" /company >/dev/null
HEX=$(python3 -c 'import secrets;print(secrets.token_hex(8))')
python3 - "$O/codex-home/auth.json" "$HEX" <<'PY'
import base64, json, sys, time
h = sys.argv[2]
b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
exp = int(time.time()) + 30 * 86400
au = {"chatgpt_plan_type": "plus", "chatgpt_account_id": "acct-p4", "chatgpt_user_id": "user-p4"}
jwt = lambda c, tag: f"{b({'alg': 'none', 'typ': 'JWT'})}.{b(c)}.P4CAN" + f"ARY-FCX-{h}-{tag}"
json.dump({"auth_mode": "chatgpt", "OPENAI_API_KEY": None,
           "tokens": {"id_token": jwt({"email": "p4@example.invalid", "exp": exp, "https://api.openai.com/auth": au}, "id"),
                      "access_token": jwt({"exp": exp, "https://api.openai.com/auth": au}, "access"),
                      "refresh_token": "P4CAN" + f"ARY-FCX-{h}-refresh", "account_id": "acct-p4"},
           "last_refresh": time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime())}, open(sys.argv[1], "w"))
PY
cat >"$O/codex-home/config.toml" <<'T'
model = "gpt-5.5"
model_provider = "p4stub"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false
web_search = "disabled"
project_doc_max_bytes = 0

[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false

[model_providers.p4stub]
name = "p4stub"
base_url = "http://127.0.0.1:18081/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false

[analytics]
enabled = false

[history]
persistence = "none"

[features]
apps = false
plugins = false
remote_plugin = false
recommended_plugins = false
responses_websockets = false
responses_websockets_v2 = false
memories = false
code_mode = { enabled = false }
multi_agent = false
multi_agent_v2 = false
T
cat >"$O/codex-home/environments.toml" <<'T'
default = "home"
include_local = false

[[environments]]
id = "home"
program = "/opt/codex/codex"
args = ["stdio-to-uds", "/run/qorpera-home/cx-exec.sock"]
T
chown -R nobody:nogroup "$O/codex-home"; chmod 0600 "$O/codex-home"/*
cat >"$O/p4/init.sh" <<'S'
#!/bin/bash
python3 -I /opt/p4/stub.py 18081 /slot/out/stub-cx.jsonl /opt/p4/scenario.json >>/slot/out/stub.err 2>&1 &
for _ in $(seq 1 50); do python3 -c 'import socket;socket.create_connection(("127.0.0.1",18081),0.2)' 2>/dev/null && break; sleep 0.1; done
t0=$(date +%s.%N)
/opt/codex/codex exec --skip-git-repo-check -C /company "Run the P4 scenario." </dev/null
echo "CODEX rc=$? seconds=$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')"
kill %1
S
chmod 0755 "$O/p4/init.sh"
echo "$(date -u +%H:%M:%S.%3N) CODEX BOX start"
setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all \
	bwrap --unshare-all --die-with-parent --new-session --hostname p4-codex-slot \
	--ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin \
	--ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /run --tmpfs /tmp --tmpfs /slot \
	--ro-bind "$CODEX" /opt/codex/codex --ro-bind "$O/p4" /opt/p4 \
	--bind "$O/codex-home" /slot/codex-home --bind "$O/out" /slot/out --bind "$O/work" /company \
	--bind "$SOCK/cx-exec.sock" /run/qorpera-home/cx-exec.sock \
	--clearenv --setenv HOME /slot/codex-home --setenv CODEX_HOME /slot/codex-home --setenv PATH /usr/bin:/bin \
	--setenv LANG C.UTF-8 --setenv TERM dumb --setenv RUST_LOG warn --chdir /company \
	/bin/bash /opt/p4/init.sh 2>&1 &
BX=$!
# The drop: once Codex's apply_patch result is in (its last command, a 40 s sleep, then starts), kill its whole box.
for _ in $(seq 1 600); do grep -q '"step": 2' "$O/out/stub-cx.jsonl" 2>/dev/null && break; kill -0 $BX 2>/dev/null || break; sleep 0.2; done
sleep 8
if [[ ${P4_DROP:-cx} == cx ]]; then
	echo "$(date -u +%H:%M:%S.%3N) CODEX BOX DROP: kill -9 of Codex's box mid-command"
	pkill -9 -P $BX 2>/dev/null; kill -9 $BX 2>/dev/null
else
	echo "$(date -u +%H:%M:%S.%3N) CLAUDE BOX DROP: kill -9 of Claude Code's box mid-command"
	pkill -9 -f -- '--hostname p4-slot ' 2>/dev/null
fi
wait $BX 2>/dev/null
echo "$(date -u +%H:%M:%S.%3N) CODEX BOX end"
sleep 2
echo "home after the drop: $(lxc exec p4-home -- sh -c 'systemctl list-units --no-legend --plain "p4-c*" | cut -d" " -f1 | tr "\n" " "; echo; pgrep -af "time.sleep|sleep 15" | grep -v pgrep || echo no-sleep-left' </dev/null | tr '\n' ' ')"
python3 - "$O/out/stub-cx.jsonl" <<'PY'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
reqs = [l for l in lines if l["kind"] == "request"]
print(f"codex stub: {len(reqs)} requests; auth tags {sorted({t for r in reqs for t in r.get('auth_tags', [])})}")
for l in lines:
    if l.get("tools"):
        print("  tools offered:", " ".join(l["tools"]))
    if l["kind"] == "result":
        print(f"  [{l['step']}] {l['tool']} {l['ms']} ms tags={l['tags']} :: {l['text'][:400]!r}")
PY
