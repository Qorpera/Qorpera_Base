#!/bin/bash
# C4c end-to-end proof on a test VM, as root through run-on-node --sudo (with its npm install: the proof is bundled with
# esbuild). C2's prove.sh --prepare installs the box's parts root-owned under /opt/qorpera-c2-proof and makes the nested
# home; this bundles prove-worker.ts twice (the platform, run as root from the repository; the run's process, as nobody
# from the root-owned parts folder) and runs the platform, which runs each worker's run in a unit hardened like the
# company host. cleanup.sh and the lines at the end remove what it made, by exact names.
# Usage: prove-worker.sh [--keep]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
P=/opt/qorpera-c2-proof
B=/var/lib/c4c-proof
H=qorpera-machine-c2e000000000400080000000000000d2
say() { echo "$(date -u +%H:%M:%S) $*"; }
cd "$REPO"

say "prepare: C2's parts and the nested home"
bash "$HERE/prove.sh" shell c4c-prep --prepare 2>&1 | tail -4

install -d -m 0755 $P
BANNER="--banner:js=import { createRequire as __c4c_require } from \"node:module\"; const require = __c4c_require(import.meta.url);"
npx esbuild "$HERE/prove-worker.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
	--alias:@qorpera/contracts=./packages/contracts/src/index.ts --external:esbuild "$BANNER" \
	--outfile=$P/worker.bundle.mjs || { echo "BUNDLE FAILED"; exit 1; }
chmod 0444 $P/worker.bundle.mjs
# The platform's copy lives in the repository (the hosted database's helpers find the repository from it).
npx esbuild "$HERE/prove-worker.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
	--alias:@qorpera/contracts=./packages/contracts/src/index.ts --external:esbuild "$BANNER" \
	--outfile=scripts/.prove-worker.platform.mjs || { echo "BUNDLE FAILED"; exit 1; }

rm -rf $B; install -d -o 65534 -g 65534 -m 0700 $B
S=/var/lib/qorpera-shared-execution
SLOT=$S/slots/11/host
say "this test VM's slot units: $(systemctl list-unit-files --no-legend 'qorpera-shared-run-host@*' 2>/dev/null | wc -l)"
[[ -e $SLOT ]] && { echo "$SLOT exists already: not the proof's"; exit 1; }
MADE=()
for d in $S $S/slots $S/slots/11 $S/journals /var/lib/qorpera /var/lib/qorpera/identities /run/qorpera-shared-execution /srv/qorpera-folder /etc/qorpera-folder; do
	[[ -e $d ]] || { install -d -o root -g root -m 0711 "$d"; MADE+=("$d"); }
done
install -d -o 65534 -g 65534 -m 0700 $SLOT
MADE+=("$SLOT")
pkill -f 'deploy/claude-box/test/renewal-(stub|proxy)\.py' || true
BOOT=$(lxc exec $H -- cat /proc/sys/kernel/random/boot_id </dev/null)
lxc exec $H -- sh -c 'rm -rf /company/QorperaOS /etc/c4c-root-made' </dev/null
say "platform: the home's boot $BOOT"
C4C_REPO="$REPO" node scripts/.prove-worker.platform.mjs platform "$BOOT"
RC=$?
say "platform rc=$RC"

echo "=== the runs' process outputs (tails)"
for f in $B/run*.out; do echo "--- $f"; tail -c 3000 "$f"; echo; done
echo "=== stub logs: kinds"
for f in $B/stub-*.jsonl; do echo "$f: $(python3 -c 'import json,sys,collections; print(dict(collections.Counter(json.loads(l)["kind"] for l in open(sys.argv[1]))))' "$f")"; done

echo "=== hunt on the home, as root"
lxc file push $P/test/hunt.py $H/root/hunt.py --mode 0700 </dev/null >/dev/null
lxc exec $H -- python3 /root/hunt.py c4c </dev/null | tail -15
lxc exec $H -- rm -f /root/hunt.py </dev/null
echo "=== on the run host: the proof account's processes and mounts"
pgrep -u 65534 -a | grep -v -E "^[0-9]+ (sd-pam|systemd)" | head -5 || true
grep -l "fuse.sshfs" /proc/[0-9]*/mountinfo 2>/dev/null | while read -r f; do pid=${f#/proc/}; pid=${pid%/mountinfo}; [[ $(stat -c %u /proc/$pid) == 65534 ]] && echo "sshfs seen by $pid"; done
echo "canaries anywhere under $B: $(grep -rhoaE 'C2CANARY-[A-Z0-9]+-[0-9a-f]{8,}' $B 2>/dev/null | grep -v '^$' | wc -l) (stub logs record tags only)"

echo "=== slot 11's host folder after the runs: $(ls -A $SLOT | wc -l) entries"
ls -A $SLOT | head -5
[[ "${1:-}" == --keep ]] || {
	bash "$HERE/cleanup.sh"
	rm -rf $B
	rm -f scripts/.prove-worker.platform.mjs
	rm -rf "$SLOT"
	for ((i = ${#MADE[@]} - 1; i >= 0; i--)); do [[ ${MADE[i]} == "$SLOT" ]] || rmdir "${MADE[i]}"; done
}
exit $RC
