#!/usr/bin/env bash
# Proof of the rules reader (E8b) under systemd, run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
#     bash deploy/agent-exit/test/prove-rules-reader-vm.sh </dev/null
#
# (with the default install: the package is built here with esbuild). It changes nothing of the test machine: it makes
# a throwaway VM in the test machine's LXD, with no network card at all, and runs test/prove-rules-reader.sh inside it.
# Everything the VM needs is fetched or built on the test machine and pushed in, because the VM has no network: the
# reader's package from this checkout, this folder, and the packages the exit's installer needs, among them the nodes'
# Node (Ubuntu's nodejs at the version the nodes run), exactly those apt would install on the VM's own package list.
# Before and after, the test machine's links (but Docker's), nft table names, a few sysctls and its network modules are
# compared, as test/prove-lxd-vm.sh does. Everything it made is removed at the end, also on failure. Prints PASS lines,
# the inner proof's, then ALL PASSED.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
PROJECT=qae8b
POOL=qae8b
VM=qae8b-proof
IMAGE=${QORPERA_AGENT_EXIT_PROOF_IMAGE:-ubuntu:26.04}
# The nodes' Node: Ubuntu's nodejs package, and its libnode, at this version.
NODE_VERSION=${QORPERA_AGENT_EXIT_PROOF_NODE:-22.22.1+dfsg+~cs22.19.15-1ubuntu1}

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }
lx() { lxc --project "$PROJECT" "$@" </dev/null; }

[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
[[ $(hostname) == qorpera-testvm-* ]] || fail "this runs on a test machine only"
command -v lxc >/dev/null || fail "no LXD here"
# The project first: it is this run's claim on the names (a second run stops here and removes nothing of this one).
claim=$(lxc project create "$PROJECT" -c features.images=true -c features.profiles=false \
	-c features.storage.volumes=true </dev/null 2>&1) ||
	fail "cannot claim LXD project $PROJECT (another E8b proof may run here): $claim"

# What the test machine looks like, before and after (as test/prove-lxd-vm.sh compares it).
machine_state() {
	ip -br link | awk '{print $1}' | sed 's/@.*//' | grep -vE '^(veth|br-)' | sort
	echo "--- nft"
	nft list tables 2>/dev/null | sort
	echo "--- sysctls"
	sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.netfilter.nf_conntrack_max 2>/dev/null
	cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo "no br_netfilter"
}
WATCHED_MODULES="br_netfilter bridge stp llc tun macvlan macvtap vhost_net nft_meta_bridge nf_conntrack_bridge"
modules() { awk '{print $1}' /proc/modules | sort; }

work=$(mktemp -d)
made_pool=0
cleanup() {
	set +e
	lx delete --force "$VM" >/dev/null 2>&1
	for fingerprint in $(lxc image list --project "$PROJECT" -c f -f csv </dev/null 2>/dev/null); do
		lx image delete "$fingerprint" >/dev/null 2>&1
	done
	lxc project delete "$PROJECT" </dev/null >/dev/null 2>&1
	if ((made_pool)); then lxc storage delete "$POOL" </dev/null >/dev/null 2>&1; fi
	rm -rf "$work"
}
trap cleanup EXIT
machine_state >"$work/before"
modules >"$work/modules-before"

# --- The reader's package and this folder, from this checkout -------------------------------------------------------
mkdir -p "$work/push/debs"
(cd "$repo" && node scripts/package-agent-exit-rules.mjs --out "$work/push/package" >/dev/null) ||
	fail "cannot build the rules reader's package"
cp -r "$here" "$work/push/agent-exit"
pass "built the rules reader's package ($(ls "$work/push/package" | tr '\n' ' '))"

# --- The throwaway VM: no network card at all --------------------------------------------------------------------
if ! lxc storage show "$POOL" </dev/null >/dev/null 2>&1; then
	lxc storage create "$POOL" dir </dev/null >/dev/null
	made_pool=1
fi
lx image copy "$IMAGE" local: --vm --alias qae8b-vm >/dev/null
lx init qae8b-vm "$VM" --vm --no-profiles --storage "$POOL" -c limits.cpu=2 -c limits.memory=4GiB \
	-d root,size=16GiB >/dev/null
lx start "$VM"
for _ in $(seq 1 120); do lx exec "$VM" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$VM" -- true || fail "the VM's agent did not answer"
[[ -z $(lx exec "$VM" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "the VM has a network card"
pass "a throwaway VM with no network card runs in the test machine"

# --- The packages, as apt would install them on the VM ------------------------------------------------------------
# The installer's check needs dnsmasq and conntrack; the reader runs on /usr/bin/node. apt resolves them against the
# VM's own package list (a simulation: nothing is installed here), and exactly the packages it names are fetched.
lx file pull "$VM/var/lib/dpkg/status" "$work/vm-status" || fail "cannot read the VM's package list"
apt-get -s -q -o Dir::State::status="$work/vm-status" -o Debug::NoLocking=1 install --no-install-recommends \
	"nodejs=$NODE_VERSION" "libnode127=$NODE_VERSION" dnsmasq-base conntrack >"$work/plan" 2>&1 ||
	fail "apt cannot install Node $NODE_VERSION on the VM: $(cat "$work/plan"; apt-cache policy nodejs libnode127)"
awk '$1 == "Inst" { v = ($3 ~ /^\[/) ? $4 : $3; sub(/^\(/, "", v); print $2 "=" v }' "$work/plan" >"$work/wanted"
grep -qxF "nodejs=$NODE_VERSION" "$work/wanted" || fail "apt's plan has no nodejs $NODE_VERSION: $(cat "$work/plan")"
(cd "$work/push/debs" && xargs apt-get download -q <"$work/wanted" >"$work/download" 2>&1) ||
	fail "cannot fetch the packages: $(cat "$work/download")"
pass "fetched the $(wc -l <"$work/wanted") packages apt would install on the VM ($(tr '\n' ' ' <"$work/wanted"))"

lx file push -r "$work/push" "$VM/root/" >/dev/null
lx exec "$VM" -- env PATH=/usr/sbin:/usr/bin:/sbin:/bin NODE_VERSION="$NODE_VERSION" bash -euo pipefail -c '
	touch /etc/qorpera-throwaway-vm
	dpkg -i /root/push/debs/*.deb >/dev/null
	installed=$(dpkg-query -W -f="\${Version}" nodejs)
	[[ $installed == "$NODE_VERSION" ]] || { echo "nodejs $installed installed" >&2; exit 1; }
	[[ $(/usr/bin/node --version) == "v${NODE_VERSION%%+*}" ]] || { echo "node is $(/usr/bin/node --version)" >&2; exit 1; }
	# The boot finished (its network-online wait too), so the proof times the reader, not the boot.
	timeout 300 systemctl is-system-running --wait >/dev/null || true
' || fail "setting up the VM"
pass "the packages are installed in the VM, offline: Node $(lx exec "$VM" -- /usr/bin/node --version) from nodejs $NODE_VERSION"

# --- The proof, inside the VM -----------------------------------------------------------------------------------
lx exec "$VM" -- env PATH=/usr/sbin:/usr/bin:/sbin:/bin QORPERA_AGENT_EXIT_DIR=/root/push/agent-exit \
	QORPERA_AGENT_EXIT_RULES_PACKAGE=/root/push/package \
	bash /root/push/agent-exit/test/prove-rules-reader.sh | tee "$work/inner.out" || fail "the proof inside the VM failed"
grep -q "^ALL PASSED" "$work/inner.out" || fail "the proof inside the VM did not finish"

# --- The test machine is as it was --------------------------------------------------------------------------------
lx delete --force "$VM" >/dev/null
machine_state >"$work/after"
diff -u "$work/before" "$work/after" || fail "the run changed the test machine (above)"
modules >"$work/modules-after"
gone=$(comm -23 "$work/modules-before" "$work/modules-after")
[[ -z $gone ]] || fail "modules went away on the test machine: $gone"
for module in $WATCHED_MODULES; do
	grep -qx "$module" "$work/modules-after" && ! grep -qx "$module" "$work/modules-before" &&
		fail "the run loaded $module on the test machine"
done
pass "the test machine's links, nft tables, sysctls and network modules are as before"
echo "ALL PASSED"
