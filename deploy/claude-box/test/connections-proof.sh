#!/bin/bash
set -uo pipefail
LABEL=${1:?label}
shift
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
P=/opt/qorpera-ccap-proof
B=/var/lib/ccap-proof
L=/var/tmp/ccap-proof-parts
PIN=0dc4f4a9a165fc60
say() { echo "$(date -u +%H:%M:%S) $*"; }
trap 'rm -rf $P $B $L; ls -d $P $B $L 2>&1 | sed "s/^/left: /"' EXIT
cd "$REPO" || exit 2
rm -rf $P $B $L
install -d -m 0755 $L $P $P/src $P/test $P/tls
if [[ $(sha256sum /home/tester/lanes/agent-box-C2/cc/2.1.325/claude 2>/dev/null | cut -c1-16) == "$PIN" ]]; then
	cp /home/tester/lanes/agent-box-C2/cc/2.1.325/claude $L/claude
else
	(cd $L && npm pack --silent "@anthropic-ai/claude-code-linux-x64@2.1.325" >/dev/null && tar xzf ./*.tgz && mv package/claude claude && rm -rf package ./*.tgz)
fi
[[ $(sha256sum $L/claude | cut -c1-16) == "$PIN" ]] || { echo "Claude Code is not the pin"; exit 1; }
(cd $L && apt-get download sshfs >/dev/null 2>&1 && dpkg -x sshfs_*.deb sshfs) || { echo "no sshfs"; exit 1; }
[[ -x /usr/lib/openssh/sftp-server ]] || { echo "no sftp-server"; exit 1; }
install -m 0555 $L/claude $P/claude
install -m 0555 $L/sshfs/usr/bin/sshfs $P/sshfs
for f in cloud-claude-home-shell-client cloud-native-isolation-child; do
	install -m 0444 "packages/runtime/src/$f.ts" "$P/src/$f.ts"
done
install -m 0555 deploy/claude-box/qorpera-claude-box-stage.sh $P/qorpera-claude-box-stage.sh
install -m 0444 "$HERE/connections-stub.py" $P/test/connections-stub.py
npx esbuild "$HERE/connections-proof.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
	--alias:@qorpera/contracts=./packages/contracts/src/index.ts \
	"--banner:js=import { createRequire as __ccap_require } from \"node:module\"; const require = __ccap_require(import.meta.url);" \
	--outfile=$P/connections-proof.bundle.mjs || { echo "BUNDLE FAILED"; exit 1; }
chmod 0444 $P/connections-proof.bundle.mjs
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=ccap proof CA" \
	-keyout $P/tls/ca.key -out $P/tls/ca.pem 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=api.anthropic.com" \
	-keyout $P/tls/server.key -out $P/tls/server.csr 2>/dev/null
printf 'subjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' >$P/tls/ext
openssl x509 -req -in $P/tls/server.csr -CA $P/tls/ca.pem -CAkey $P/tls/ca.key -CAcreateserial -days 2 \
	-extfile $P/tls/ext -out $P/tls/server.pem 2>/dev/null
chmod 0444 $P/tls/ca.pem $P/tls/server.pem $P/tls/server.key
chmod 0400 $P/tls/ca.key
install -d -o 65534 -g 65534 -m 0700 $B

say "caps in this tree: relay $(grep -oE 'MAX_CONNECTIONS = [0-9]+|CONNECTIONS = [0-9]+' packages/runtime/src/cloud-native-egress.ts | tr '\n' ' ')| entry $(grep -oE 'sockets.size >= [0-9]+' packages/runtime/src/cloud-native-isolation-child.ts)"
say "PROOF $LABEL $* start"
systemd-run --quiet --pipe --wait --collect --uid=65534 --gid=65534 --working-directory=$P \
	-p NoNewPrivileges=yes -p PrivateDevices=yes -p "DeviceAllow=/dev/fuse rw" -p BindPaths=/dev/fuse \
	-p CapabilityBoundingSet= -p AmbientCapabilities= -p "RestrictNamespaces=user mnt pid net ipc uts cgroup" \
	-p ProtectSystem=strict -p ProtectHome=yes -p ProtectProc=invisible -p ProcSubset=all -p ProtectKernelTunables=no \
	-p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes -p PrivateTmp=yes \
	-p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK" -p TasksMax=1024 -p ReadWritePaths=$B \
	-p UMask=0077 "$(command -v node)" $P/connections-proof.bundle.mjs "$LABEL" "$@" </dev/null 2>&1
say "PROOF $LABEL end rc=$?"
for f in $B/out-$LABEL/debug-*.txt; do
	echo "=== $(basename "$f"): $(grep -ciE 'Proxy connection ended|ECONNRESET|socket hang up|Connection error' "$f") connection failures"
	grep -iE 'Proxy connection ended|ECONNRESET|socket hang up|Connection error|retry' "$f" | cut -c1-200 | head -4
done
[[ -z $(pgrep -u 65534) ]] && echo "no process of the proof's account left"
