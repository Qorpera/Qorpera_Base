#!/bin/bash
set -euo pipefail
D=$1
say() { echo "$(date -u +%H:%M:%S) $*"; }
say "host: $(. /etc/os-release; echo $PRETTY_NAME) $(uname -r); node $(/usr/bin/node --version) $(stat -c %U:%G /usr/bin/node); bwrap $(/usr/bin/bwrap --version) $(stat -c %U:%G /usr/bin/bwrap); script $(stat -c '%U:%G %a' /usr/bin/script); stty $(stat -c '%U:%G %a' /usr/bin/stty)"
say "restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo -)"
getent group qorpera-login-helper >/dev/null || groupadd --system qorpera-login-helper
id qorpera-login-helper >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -g qorpera-login-helper qorpera-login-helper
install -d -o root -g root -m 0755 /opt/qorpera-model-login-helper
install -d -o root -g root -m 0700 /etc/qorpera-model-login-helper
install -o root -g root -m 0555 $D/codex /opt/qorpera-model-login-helper/codex
install -o root -g root -m 0555 $D/claude /opt/qorpera-model-login-helper/claude
rm -f $D/codex $D/claude
install -o root -g root -m 0444 $D/pkg/qorpera-model-login-helper.mjs $D/pkg/qorpera-native-isolation-child.mjs /opt/qorpera-model-login-helper/
install -o root -g root -m 0644 $D/pkg/qorpera-model-login-helper.service /etc/systemd/system/qorpera-model-login-helper.service
cmp $D/pkg/qorpera-model-login-helper.service $D/unit-from-branch.service && say "unit = the branch's deploy/cloud-secret-broker/qorpera-model-login-helper.service"
codex_sha=$(sha256sum /opt/qorpera-model-login-helper/codex | cut -d' ' -f1)
claude_sha=$(sha256sum /opt/qorpera-model-login-helper/claude | cut -d' ' -f1)
say "claude sha256 $claude_sha (pin 0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf) $(/opt/qorpera-model-login-helper/claude --version 2>/dev/null </dev/null || true)"
cat >/etc/qorpera-model-login-helper/config.json <<EOF
{"schema": "qorpera.model-login-helper/v1", "socketPath": "/run/qorpera-model-login-helper/helper.sock", "codexPath": "/opt/qorpera-model-login-helper/codex", "codexSha256": "$codex_sha", "temporaryRoot": "/run/qorpera-model-login-helper", "isolationEntryPoint": "/opt/qorpera-model-login-helper/qorpera-native-isolation-child.mjs", "claudePath": "/opt/qorpera-model-login-helper/claude", "claudeSha256": "$claude_sha"}
EOF
chmod 0600 /etc/qorpera-model-login-helper/config.json
for f in token vault-token; do
	rm -f /etc/qorpera-model-login-helper/$f
	python3 -I -c 'import base64, os, sys; fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400); os.write(fd, base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=") + b"\n"); os.close(fd)' /etc/qorpera-model-login-helper/$f
done
install -d -m 0755 /etc/systemd/system/qorpera-model-login-helper.service.d
printf '[Service]\nLoadCredential=qorpera-model-login-helper-vault-token:/etc/qorpera-model-login-helper/vault-token\n' \
	>/etc/systemd/system/qorpera-model-login-helper.service.d/vault-token.conf

ip link show clu0 >/dev/null 2>&1 || { ip link add clu0 type dummy; ip addr add 198.51.7.7/32 dev clu0; ip link set clu0 up; }
grep -q 'api.anthropic.com' /etc/hosts || echo '198.51.7.7 api.anthropic.com platform.claude.com' >>/etc/hosts
install -m 0644 $D/tls/ca.pem /usr/local/share/ca-certificates/clu-vault-proof.crt
update-ca-certificates >/dev/null 2>&1
say "test plumbing: api.anthropic.com -> $(getent ahostsv4 api.anthropic.com | head -1 | cut -d' ' -f1) (resolved: $(resolvectl query --legend=no -4 api.anthropic.com 2>&1 | head -1)); CA in /etc/ssl/certs/ca-certificates.crt: $(grep -c BEGIN /etc/ssl/certs/ca-certificates.crt) certs"
sed 's/("127.0.0.1", PORT)/("198.51.7.7", PORT)/' $D/usage-stub.py >$D/stub.py
grep -q '"198.51.7.7", PORT' $D/stub.py
echo '{}' >$D/scenario.json
: >$D/stub.log
systemctl stop clu-vault-stub 2>/dev/null || true
systemd-run --quiet --unit clu-vault-stub --collect python3 $D/stub.py 443 $D/scenario.json $D/stub.log $D/tls/server.pem $D/tls/server.key
for _ in $(seq 1 50); do ss -ltn | grep -q '198.51.7.7:443' && break; sleep 0.1; done
say "stub: $(ss -ltn | grep 198.51.7.7:443 | awk '{print $4}')"

systemctl daemon-reload
systemctl restart qorpera-model-login-helper
for _ in $(seq 1 60); do [[ -S /run/qorpera-model-login-helper/helper.sock ]] && break; sleep 1; done
sleep 1
say "helper: $(systemctl is-active qorpera-model-login-helper); $(systemctl show -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax -p PrivateDevices -p ProtectSystem -p NoNewPrivileges -p RestrictNamespaces qorpera-model-login-helper | tr '\n' ' ')"
journalctl -u qorpera-model-login-helper -b --no-pager -o cat | tail -5
ls -la /run/qorpera-model-login-helper/
