#!/usr/bin/env bash
# Proof of the agent plug on a real LXD (E2b), run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node02 --sudo --no-install --no-status -- \
#     bash deploy/agent-exit/test/prove-lxd-vm.sh </dev/null
#
# Nothing of it touches the test machine's own kernel or network. It makes a throwaway VM in the test machine's LXD,
# with no network card at all (so LXD adds no link, rule or module there), and runs test/prove-lxd.sh inside it. That
# VM has its own kernel and its own LXD: it loads br_netfilter, builds the exit and plugs real LXD containers in, as
# a node would. Everything the VM needs (LXD's snaps, the container image, two packages, this folder) is fetched on
# the test machine and pushed in, because the VM has no network. The test machine's links, loaded modules, nft tables
# and the sysctls that matter are compared before and after; any difference fails the run. Everything it made is
# removed at the end, also on failure. Prints PASS lines, the inner proof's RESULT line, then ALL PASSED.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=qae2b
POOL=qae2b
VM=qae2b-proof
IMAGE=${QORPERA_AGENT_EXIT_PROOF_IMAGE:-ubuntu:26.04}

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }
lx() { lxc --project "$PROJECT" "$@" </dev/null; }

[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
[[ $(hostname) == qorpera-testvm-* ]] || fail "this runs on a test machine only"
command -v lxc >/dev/null || fail "no LXD here"
lxc project show "$PROJECT" </dev/null >/dev/null 2>&1 && fail "LXD project $PROJECT exists: another E2b proof runs here"

# What the test machine looks like, before and after: the run must change none of it. Other runs on the machine come
# and go meanwhile (Docker's veth and br- links, modules Docker loads), so those are left out of the comparison of
# what appeared; nothing may disappear, and none of the modules a network proof could load may appear.
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

# --- What the VM needs, fetched here ----------------------------------------------------------------------------
mkdir -p "$work/push/snaps" "$work/push/debs" "$work/push/image"
(cd "$work/push/snaps" && snap download lxd --channel=6/stable >/dev/null && snap download core26 >/dev/null)
(cd "$work/push/debs" && apt-get download -q dnsmasq-base conntrack libnetfilter-conntrack3 libnetfilter-cthelper0 \
	libnetfilter-cttimeout1 libnetfilter-queue1 libnfnetlink0 libmnl0 >/dev/null 2>&1) ||
	fail "cannot fetch the packages"
if ! lxc storage show "$POOL" </dev/null >/dev/null 2>&1; then
	lxc storage create "$POOL" dir </dev/null >/dev/null
	made_pool=1
fi
lxc project create "$PROJECT" -c features.images=true -c features.profiles=false -c features.storage.volumes=true \
	</dev/null >/dev/null
lx image copy "$IMAGE" local: --vm --alias qae2b-vm >/dev/null
lx image copy "$IMAGE" local: --alias qae2b-ct >/dev/null
lx image export qae2b-ct "$work/push/image/ct" >/dev/null
cp -r "$here" "$work/push/agent-exit"
pass "fetched LXD's snaps, the packages and the container image on the test machine"

# --- The throwaway VM: no network card at all --------------------------------------------------------------------
lx init qae2b-vm "$VM" --vm --no-profiles --storage "$POOL" -c limits.cpu=4 -c limits.memory=6GiB \
	-d root,size=24GiB >/dev/null
lx start "$VM"
for _ in $(seq 1 120); do lx exec "$VM" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$VM" -- true || fail "the VM's agent did not answer"
[[ -z $(lx exec "$VM" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "the VM has a network card"
pass "a throwaway VM with no network card runs in the test machine"

lx file push -r "$work/push" "$VM/root/" >/dev/null
lx exec "$VM" -- bash -euo pipefail -c '
	touch /etc/qorpera-throwaway-vm
	cd /root/push/snaps
	snap ack core26_*.assert && snap install core26_*.snap >/dev/null
	snap ack lxd_*.assert && snap install lxd_*.snap >/dev/null
	lxd waitready --timeout=120
	dpkg -i /root/push/debs/*.deb >/dev/null
	cd /root/push/image
	if ls ct*.squashfs >/dev/null 2>&1; then lxc image import ct*.tar.* ct*.squashfs --alias qae2b-ct >/dev/null
	else lxc image import ct*.tar.* --alias qae2b-ct >/dev/null; fi
' || fail "setting up LXD in the VM"
pass "LXD, the container image and the packages are set up in the VM, offline"

# --- The proof, inside the VM -----------------------------------------------------------------------------------
lx exec "$VM" -- env QORPERA_AGENT_EXIT_DIR=/root/push/agent-exit QORPERA_AGENT_EXIT_PROOF_IMAGE=qae2b-ct \
	bash /root/push/agent-exit/test/prove-lxd.sh | tee "$work/inner.out" || fail "the proof inside the VM failed"
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
