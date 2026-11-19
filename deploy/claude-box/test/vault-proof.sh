#!/bin/bash
set -uo pipefail
STEP=$1
shift
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
W=/var/lib/clu-vault-proof
S=clu-vault
SX() { lxc exec $S -- "$@" </dev/null; }
say() { echo "$(date -u +%H:%M:%S) $*"; }
up() {
	for _ in $(seq 1 300); do SX systemctl is-active --quiet basic.target 2>/dev/null && break; sleep 1; done
	SX systemctl is-system-running --wait >/dev/null 2>&1
	say "$S: $(SX systemctl is-system-running 2>&1)"
}

case $STEP in
build)
	rm -rf $W
	install -d -m 0700 $W $W/clu $W/clu/tls
	cd "$REPO"
	node scripts/package-model-login-helper.mjs --out $W/clu/pkg >/dev/null || { echo "PACKAGING FAILED"; exit 1; }
	cat $W/clu/pkg/manifest.json
	cp deploy/cloud-secret-broker/qorpera-model-login-helper.service $W/clu/unit-from-branch.service
	npx esbuild "$HERE/vault-client.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
		--alias:@qorpera/contracts=./packages/contracts/src/index.ts \
		"--banner:js=import { createRequire as __clu_require } from \"node:module\"; const require = __clu_require(import.meta.url);" \
		--outfile=$W/clu/client.mjs || { echo "BUNDLE FAILED"; exit 1; }
	pin=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact"]["sha256"])' deploy/first-node/native-claude/linux-x64-artifact.json)
	install -d -m 0700 $W/cc
	(cd $W/cc && npm pack --silent "@anthropic-ai/claude-code-linux-x64@2.1.325" >/dev/null && tar xzf ./*.tgz)
	[[ $(sha256sum $W/cc/package/claude | cut -d' ' -f1) == "$pin" ]] || { echo "NOT THE PINNED CLAUDE CODE"; exit 1; }
	mv $W/cc/package/claude $W/clu/claude
	rm -rf $W/cc
	cp /opt/qorpera-codex-fence/codex $W/clu/codex
	say "Claude Code = the pin $pin; Codex $(sha256sum $W/clu/codex | cut -c1-16) (the test VM's pinned fence Codex)"
	T=$W/clu/tls
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=clu vault proof CA" \
		-keyout $T/ca.key -out $T/ca.pem 2>/dev/null
	openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=api.anthropic.com" \
		-keyout $T/server.key -out $T/server.csr 2>/dev/null
	printf 'subjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' >$T/ext
	openssl x509 -req -in $T/server.csr -CA $T/ca.pem -CAkey $T/ca.key -CAcreateserial -days 2 -extfile $T/ext \
		-out $T/server.pem 2>/dev/null
	rm -f $T/ca.key $T/server.csr $T/ext
	cp "$HERE/usage-stub.py" "$HERE/vault-driver.py" "$HERE/vault-setup.sh" $W/clu/
	python3 "$HERE/unit-props.py" "$REPO/deploy/cloud-secret-broker/qorpera-model-login-helper.service" >$W/clu/unit-props.txt
	if ! lxc info $S >/dev/null 2>&1; then
		# WHY: a pool of the proof's own, so an image volume stuck in the shared default pool cannot stop it.
		lxc storage show clu-pool >/dev/null 2>&1 || lxc storage create clu-pool dir </dev/null || exit 1
		lxc init nested-probe-image $S --vm -s clu-pool -c limits.cpu=2 -c limits.memory=4GiB -d root,size=14GiB -c boot.autostart=false </dev/null >/dev/null || exit 1
		lxc start $S </dev/null || exit 1
	fi
	up
	BR=$(lxc network get lxdbr0 ipv4.address </dev/null | cut -d/ -f1)
	python3 "$HERE/proxy.py" "$BR" 18567 >$W/proxy.out 2>&1 &
	PROXY=$!
	for _ in $(seq 1 50); do grep -q READY $W/proxy.out 2>/dev/null && break; sleep 0.1; done
	via="http://$BR:18567"
	SX env http_proxy=$via https_proxy=$via DEBIAN_FRONTEND=noninteractive sh -c \
		'apt-get -q update >/dev/null && apt-get -q install -y --no-install-recommends bubblewrap nodejs ca-certificates openssl python3 >/dev/null; echo "apt rc=$?"'
	kill $PROXY
	SX rm -rf /root/clu
	tar -C $W -cf - clu | lxc exec $S -- tar -C /root --no-same-owner -xf -
	SX bash /root/clu/vault-setup.sh /root/clu
	rc=$?
	rm -rf $W
	exit $rc
	;;
run)
	mapfile -t props < <(SX cat /root/clu/unit-props.txt)
	unit=()
	for prop in "${props[@]}"; do unit+=(-p "$prop"); done
	echo "=== PTY under the helper unit's settings (PrivateDevices etc.), as its user"
	SX systemd-run --quiet --pipe --wait --collect -p User=qorpera-login-helper -p Group=qorpera-login-helper "${unit[@]}" \
		/usr/bin/script -q -e -c '/usr/bin/stty rows 40 cols 200 && /usr/bin/tty && /usr/bin/stty size && ls -l /dev/ptmx /dev/pts | head -3' /dev/null 2>&1
	echo "pty rc=$?"
	echo "=== control: platform.claude.com reaches the stub when nothing blocks it (curl from the VM itself, outside the helper)"
	SX sh -c ': >/root/clu/stub.log; curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST https://platform.claude.com/v1/oauth/token -d "{}"; cat /root/clu/stub.log'
	echo "=== the cases"
	SX python3 /root/clu/vault-driver.py /root/clu "$@"
	echo "=== the helper's journal"
	SX journalctl -u qorpera-model-login-helper -b --no-pager -o short-iso | tail -30
	SX sh -c 'echo "unit: $(systemctl show -p MemoryPeak -p MemoryCurrent -p NRestarts -p ActiveState qorpera-model-login-helper | tr "\n" " ")"'
	;;
cleanup)
	lxc delete --force $S </dev/null 2>/dev/null && echo "deleted $S"
	lxc list -f csv -c n </dev/null | grep -x $S || echo "$S gone"
	fp=$(lxc image info nested-probe-image </dev/null | awk '/^Fingerprint:/{print $2}')
	lxc storage volume delete clu-pool image/$fp </dev/null 2>/dev/null
	lxc storage delete clu-pool </dev/null && echo "pool clu-pool deleted"
	rm -rf $W
	ls -d $W 2>&1 | sed 's/^/left: /'
	;;
*)
	echo "unknown step $STEP"
	exit 2
	;;
esac
