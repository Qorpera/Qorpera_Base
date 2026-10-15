#!/usr/bin/env bash
# Proof of the coding machine image (5f), run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node02 --sudo --no-install --no-status -- \
#     bash deploy/coding-machine/test/prove-coding-image.sh </dev/null
#
# It builds the image with build-coding-image.sh in a throwaway build project, makes a throwaway coding machine from
# it as 5g will (no profiles, no /dev/lxd), and runs test/prove-in-coding-machine.sh inside. The builder and the
# machine each have one plain card on the test machine's existing bridge (no filters, so LXD adds no nft rule for
# them); everything else they do happens in their own kernels. The bridge forwards nothing (Docker's FORWARD policy on
# the test machine drops it), so their downloads go through test/proof-proxy.py, run here as nobody on the bridge's
# address for the run's length. The test machine's modules, sysctls, nft ruleset, links and LXD state are listed
# before, while the machine runs and after everything is gone: anything that differs between before and after fails
# the run. Other runs on the test machine come and go meanwhile, so Docker's tables, chains, rules, links and
# addresses are left out, and so are the sysctls of links that come and go, the sysctls that changed on their own in
# the 15 seconds before, and LXD projects that come and go (this run's own are checked gone). Both projects and
# everything in them are removed at the end, also on failure. Prints PASS lines (the inner proof's among them), then
# ALL PASSED.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD=qorpera-proof-build
CODING=qorpera-proof-coding
VM=proof
POOL=default
NETWORK=lxdbr0

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }
lx() { lxc --project "$CODING" "$@" </dev/null; }

[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
[[ $(hostname) == qorpera-testvm-* ]] || fail "this runs on a test machine only"
export PATH=$PATH:/snap/bin
for tool in lxc jq nft python3 sysctl setpriv; do command -v "$tool" >/dev/null || fail "no $tool here"; done
SOURCE=$(lxc storage get "$POOL" source </dev/null) || fail "no storage pool $POOL"
lxc network show "$NETWORK" </dev/null >/dev/null || fail "no network $NETWORK"
FREE=$(df --output=avail -B1G "$SOURCE" | tail -1 | tr -d ' ')
((FREE >= 50)) || fail "$FREE GiB free in $SOURCE: the builder, the image and the machine need 50"

WORK=$(mktemp -d)
CLAIMED=()
PROXY_PID=
stop_proxy() {
	if [[ -n $PROXY_PID ]]; then
		kill "$PROXY_PID" 2>/dev/null || true
		wait "$PROXY_PID" 2>/dev/null || true
		PROXY_PID=
	fi
}
# Everything in the claimed projects, then the projects. Safe to run twice.
teardown() {
	local project name
	for project in "${CLAIMED[@]}"; do
		for name in $(lxc list --project "$project" -c n -f csv </dev/null 2>/dev/null); do
			lxc delete --project "$project" --force "$name" </dev/null >/dev/null 2>&1 || true
		done
		for name in $(lxc image list --project "$project" -c F -f csv </dev/null 2>/dev/null); do
			lxc image delete --project "$project" "$name" </dev/null >/dev/null 2>&1 || true
		done
		if lxc project show "$project" </dev/null >/dev/null 2>&1; then
			lxc project delete "$project" </dev/null >/dev/null 2>&1 || echo "could not delete LXD project $project" >&2
		fi
	done
}
cleanup() {
	set +e
	stop_proxy
	teardown
	rm -rf "$WORK"
}
trap cleanup EXIT

# The test machine's state: snapshot <name> and compare <a> <b>.
. "$HERE/test/host-state.sh"

snapshot calibrate
sleep 15
snapshot before
echo "the test machine before: $(wc -l <"$WORK/before.modules") modules, $(wc -l <"$WORK/before.sysctls") sysctls," \
	"$(wc -l <"$WORK/before.nft") nft lines, $(wc -l <"$WORK/before.links") links"
compare calibrate before >/dev/null || echo "(changes in the 15 seconds before, left out where they are sysctls)"

# The projects are this run's claim on the names (a second run stops here and removes nothing of this one). Each has
# its own image store, so the test machine's own store is never touched.
for project in "$BUILD" "$CODING"; do
	claim=$(lxc project create "$project" -c features.images=true -c features.profiles=false </dev/null 2>&1) ||
		fail "cannot claim LXD project $project (another coding image proof may run here): $claim"
	CLAIMED+=("$project")
done
# The way out for the builder and the machine: the proxy, as nobody, on the bridge's own address.
BRIDGE=$(lxc network get "$NETWORK" ipv4.address </dev/null)
[[ $BRIDGE =~ ^[0-9.]+/[0-9]+$ ]] || fail "$NETWORK has no IPv4 address ($BRIDGE)"
setpriv --reuid=65534 --regid=65534 --clear-groups python3 -I - "${BRIDGE%/*}" "$BRIDGE" <"$HERE/test/proof-proxy.py" \
	>"$WORK/proxy.port" 2>"$WORK/proxy.log" &
PROXY_PID=$!
for _ in $(seq 1 50); do [[ -s $WORK/proxy.port ]] && break; sleep 0.2; done
PORT=$(head -n 1 "$WORK/proxy.port")
[[ $PORT =~ ^[0-9]+$ ]] || fail "the proxy did not start: $(cat "$WORK/proxy.log")"
PROXY=http://${BRIDGE%/*}:$PORT
echo "the proxy listens at $PROXY"

# --- The build, the machine and the proof inside it (a subshell: its failure still reaches the comparison) -----------
set +e
(
	set -e
	echo "--- the image build"
	start=$SECONDS
	# /tmp is small on a test machine; the export between the two stores goes to /var/tmp.
	TMPDIR=/var/tmp QORPERA_BUILDER_NIC=plain QORPERA_BUILD_PROXY=$PROXY timeout 5400 bash "$HERE/build-coding-image.sh" \
		"$BUILD" "$NETWORK" "$POOL" "$CODING" >"$WORK/image-build.json" 2>"$WORK/build.log" </dev/null ||
		{ tail -n 150 "$WORK/build.log"; fail "the image build failed"; }
	tail -n 60 "$WORK/build.log"
	jq . "$WORK/image-build.json"
	FINGERPRINT=$(jq -er .imageFingerprint "$WORK/image-build.json")
	lx image info "$FINGERPRINT" | grep -E '^(Fingerprint|Size|Architecture|Type):'
	pass "the image built in $(((SECONDS - start) / 60)) min and is in $CODING's store"

	start=$SECONDS
	lx init "$FINGERPRINT" "$VM" --vm --no-profiles --storage "$POOL" -d root,size=20GiB -n "$NETWORK" \
		-c limits.cpu=4 -c limits.memory=4GiB -c boot.mode=uefi-secureboot -c boot.autostart=false \
		-c security.devlxd=false >/dev/null
	lx start "$VM"
	for _ in $(seq 1 120); do lx exec "$VM" -- true >/dev/null 2>&1 && break; sleep 2; done
	lx exec "$VM" -- true ||
		{ lx console "$VM" --show-log | tail -n 80 || true; fail "the machine's LXD agent did not answer"; }
	STATE=$(lx exec "$VM" -- timeout 300 systemctl is-system-running --wait || true)
	[[ $STATE == running ]] ||
		{ lx exec "$VM" -- systemctl --failed --no-pager || true; fail "the machine is $STATE after boot"; }
	pass "a coding machine from the image booted to running in $((SECONDS - start)) s, its LXD agent answering without cloud-init"

	lx file push "$HERE/test/prove-in-coding-machine.sh" "$VM/root/prove-in-coding-machine.sh" >/dev/null
	timeout 1800 lxc --project "$CODING" exec "$VM" -- env QORPERA_PROOF_GIT="$(jq -r .git "$WORK/image-build.json")" \
		QORPERA_PROOF_NODE="$(jq -r .node "$WORK/image-build.json")" \
		QORPERA_PROOF_CHROMIUM="$(jq -r .chromium "$WORK/image-build.json")" QORPERA_PROOF_PROXY="$PROXY" \
		bash /root/prove-in-coding-machine.sh </dev/null | tee "$WORK/inner.out"
	grep -qx "ALL PASSED" "$WORK/inner.out" || fail "the proof inside the machine did not finish"

	snapshot during
	echo "--- the test machine while the machine runs (for information)"
	compare before during || true
)
PROOF=$?
set -e
stop_proxy
if [[ -s $WORK/proxy.log ]]; then
	echo "--- what the proxy refused or could not reach"
	tail -n 40 "$WORK/proxy.log"
fi

# --- The test machine is as it was ------------------------------------------------------------------------------------
teardown
for project in "${CLAIMED[@]}"; do
	! lxc project show "$project" </dev/null >/dev/null 2>&1 || fail "LXD project $project is still there"
done
CLAIMED=()
snapshot after
echo "--- the test machine after"
compare before after || fail "the run changed the test machine (above)"
pass "the test machine's modules, sysctls, nft rules, links and LXD state are as before"
((PROOF == 0)) || fail "the proof failed (above)"
echo "ALL PASSED"
