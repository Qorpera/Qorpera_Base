#!/bin/bash
# P4, inside the box as nobody: start the stub model on the box's own loopback, then Claude Code, UNMODIFIED, with the
# made-up sign-in read from stdin and handed over on fd 3 (never exported, never an argument).
set -u
IFS= read -r TOK
python3 -I /opt/p4/stub.py 18080 "/slot/out/stub-$P4_TAG.jsonl" "$P4_SCEN" >>/slot/out/stub.err 2>&1 &
for _ in $(seq 1 50); do python3 -c 'import socket;socket.create_connection(("127.0.0.1",18080),0.2)' 2>/dev/null && break; sleep 0.1; done
# a second listener on 18099 that only records what reaches it (the "attacker" address of planted settings)
python3 -I /opt/p4/stub.py 18099 "/slot/out/attacker-$P4_TAG.jsonl" "$P4_SCEN" >>/slot/out/stub.err 2>&1 &
ARGS=(-p "Run the P4 scenario." --permission-mode bypassPermissions --output-format json
	--settings /opt/p4/settings.json --setting-sources user --strict-mcp-config)
WRAP=()
[[ -n ${P4_STRACE:-} ]] && WRAP=(strace -f -qq -e trace=execve,execveat -s 200 -o /slot/out/strace.txt)
t0=$(date +%s.%N)
if [[ -n ${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:-} ]]; then
	exec 3< <(printf '%s' "$TOK")
fi
unset TOK
"${WRAP[@]}" /opt/claude/claude "${ARGS[@]}" </dev/null
rc=$?
exec 3<&-
echo "CLAUDE rc=$rc seconds=$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')"
kill %1 %2 2>/dev/null
