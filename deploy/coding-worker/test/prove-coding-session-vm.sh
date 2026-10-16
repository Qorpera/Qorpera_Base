#!/usr/bin/env bash
# Proof of a coding session on a throwaway node (P3), run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node02 --sudo --no-status -- \
#     bash deploy/coding-worker/test/prove-coding-session-vm.sh </dev/null
#
# (run-on-node installs the checkout: the guest package and the executor composition are built here with esbuild.)
#
# A coding executor needs what a node has: its custody on an NFS mount, LXD with the agent exit's qagent0 network, and
# KVM for the coding machines. None of that may be made on the shared test machine (no module, sysctl or nft change),
# so the run makes a throwaway node: a VM with no network card in its own LXD project, with LXD, the NFS server and
# Node pushed in (everything is fetched here, as deploy/agent-exit/test/prove-lxd-vm.sh does), and today's coding
# image, built here beside it. The node makes its coding machines inside itself, one level further down, so they need
# the test machine's nested KVM. test/prove-coding-session-node.sh sets the node up; then test/p3-driver.mjs runs the
# test database here and the executor in the node, for four turns of one coding session. Before and after, the test
# machine's links (but Docker's), nft table names, a few sysctls and the modules a proof could load are compared: one
# of those changing, or any module going away, fails the run. Everything it made is removed at the end, also on
# failure. Prints PASS lines, then ALL PASSED.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
PROJECT=qorpera-p3-node
POOL=qorpera-p3
VM=p3-node
IMAGE=${QORPERA_P3_IMAGE:-ubuntu:26.04}

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }
lx() { lxc --project "$PROJECT" "$@" </dev/null; }

[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
[[ $(hostname) == qorpera-testvm-* ]] || fail "this runs on a test machine only"
export PATH=$PATH:/snap/bin
for tool in lxc snap apt-get apt-cache nft jq; do command -v "$tool" >/dev/null || fail "no $tool here"; done
NODE=$(command -v node || true)
[[ -n $NODE ]] || NODE=$(ls /usr/local/bin/node /opt/node/bin/node 2>/dev/null | head -1 || true)
[[ -x $NODE ]] || fail "no node here"
NODE=$(readlink -f "$NODE")
# The project first: it is this run's claim on the names (a second run stops here and removes nothing of this one).
claim=$(lxc project create "$PROJECT" -c features.images=true -c features.profiles=false \
	-c features.storage.volumes=true </dev/null 2>&1) ||
	fail "cannot claim LXD project $PROJECT (another P3 proof may run here): $claim"

machine_state() {
	ip -br link | awk '{print $1}' | sed 's/@.*//' | grep -vE '^(veth|br-)' | sort
	echo "--- nft"
	nft list tables 2>/dev/null | sort
	echo "--- sysctls"
	sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.netfilter.nf_conntrack_max 2>/dev/null
	cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo "no br_netfilter"
}
WATCHED_MODULES="br_netfilter bridge stp llc tun macvlan macvtap vhost_net nft_meta_bridge nf_conntrack_bridge nfs nfsv4 nfsd
sunrpc lockd rpcsec_gss_krb5"
modules() { awk '{print $1}' /proc/modules | sort; }

WORK=$(mktemp -d -p /var/tmp)
made_pool=0
cleanup() {
	set +e
	lx delete --force "$VM" >/dev/null 2>&1
	lx delete --force p3-build >/dev/null 2>&1
	for fingerprint in $(lxc image list --project "$PROJECT" -c f -f csv </dev/null 2>/dev/null); do
		lx image delete "$fingerprint" >/dev/null 2>&1
	done
	lxc project delete "$PROJECT" </dev/null >/dev/null 2>&1
	if ((made_pool)); then lxc storage delete "$POOL" </dev/null >/dev/null 2>&1; fi
	rm -rf "$WORK"
}
trap cleanup EXIT
machine_state >"$WORK/before"
modules >"$WORK/modules-before"

# --- What the node needs, fetched here ------------------------------------------------------------------------------
start=$SECONDS
mkdir -p "$WORK/push/snaps" "$WORK/push/debs" "$WORK/push/coding-image" "$WORK/push/node" "$WORK/image-debs"
# The nodes' and test machines' LXD revision (bootstrap-lxd-host.sh pins it).
(cd "$WORK/push/snaps" && snap download snapd >/dev/null && snap download core26 >/dev/null &&
	snap download lxd --revision=40424 >/dev/null) || fail "cannot fetch LXD 6.9 rev 40424"
# Packages with everything they need, whatever the cloud image already has (dpkg skips those): for the node the NFS
# server and client, bubblewrap (the Git broker's sandbox) and Git (the broker's and the stand-in GitHub's); for the
# coding machines Git.
closure() {
	apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances "$@" |
		grep -E '^[a-z0-9]' | sort -u
}
fetch() {
	local into=$1
	shift
	(cd "$into" && for package in $(closure "$@"); do apt-get download -q "$package" >/dev/null 2>>"$WORK/apt.log" || true; done)
}
fetch "$WORK/push/debs" nfs-kernel-server nfs-common bubblewrap git
fetch "$WORK/image-debs" git
ls "$WORK/push/debs"/nfs-kernel-server_*.deb "$WORK/push/debs"/nfs-common_*.deb "$WORK/push/debs"/bubblewrap_*.deb \
	"$WORK/push/debs"/git_*.deb "$WORK/image-debs"/git_*.deb >/dev/null 2>&1 ||
	{ tail -n 20 "$WORK/apt.log"; fail "cannot fetch the packages"; }
cp "$NODE" "$WORK/push/node/node"
cp -r "$HERE/.." "$WORK/push/coding-worker"
# Today's guest helpers and the proof's executor composition, built from this checkout (run-on-node installs it).
(cd "$REPO" && "$NODE" deploy/coding-worker/test/p3-package.mjs --out "$WORK/push/package" >/dev/null) ||
	fail "cannot build the guest package and the executor composition"
if ! lxc storage show "$POOL" </dev/null >/dev/null 2>&1; then
	lxc storage create "$POOL" dir </dev/null >/dev/null
	made_pool=1
fi
lx image copy "$IMAGE" local: --vm --alias p3-vm >/dev/null
pass "fetched LXD's snaps, $(ls "$WORK/push/debs" | wc -l) packages, Node $("$NODE" --version) and the VM image," \
	"and built the guest package, in $((SECONDS - start)) s"

# --- Today's coding image: the base image with Node, Git, the guest helpers and the watchdog -------------------------
# Built one level up, in a VM with no network card beside the node (a coding machine boots in minutes inside it), then
# published, exported and imported into the node under the same fingerprint.
start=$SECONDS
lx init p3-vm p3-build --vm --no-profiles --storage "$POOL" -c limits.cpu=4 -c limits.memory=4GiB \
	-c boot.autostart=false >/dev/null
lx start p3-build
for _ in $(seq 1 120); do lx exec p3-build -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec p3-build -- true || fail "the image builder's agent did not answer"
lx exec p3-build -- mkdir -p /root/build
lx file push "$NODE" p3-build/root/build/node >/dev/null
lx file push -r "$WORK/image-debs" "$WORK/push/package/guest" p3-build/root/build/ >/dev/null
for unit in qorpera-coding-watchdog.service qorpera-coding-watchdog.timer qorpera-coding.slice; do
	lx file push "$HERE/../$unit" "p3-build/root/build/$unit" >/dev/null
done
lx exec p3-build -- env PATH=/usr/sbin:/usr/bin:/sbin:/bin bash -euo pipefail -c '
	cd /root/build
	dpkg -i --skip-same-version image-debs/*.deb >/dev/null
	install -m 0755 -o root -g root node /usr/bin/node
	install -d -m 0755 -o root -g root /opt/qorpera-coding /workspace /var/lib/qorpera-coding
	for file in cloud-coding-command-guest.mjs cloud-coding-git-guest.mjs cloud-coding-watchdog.mjs cloud-coding-storage-guest.mjs; do
		install -m 0444 -o root -g root "guest/$file" "/opt/qorpera-coding/$file"
	done
	install -m 0644 -o root -g root qorpera-coding-watchdog.service qorpera-coding-watchdog.timer qorpera-coding.slice \
		/etc/systemd/system/
	systemctl daemon-reload
	systemctl enable qorpera-coding-watchdog.timer >/dev/null 2>&1
	systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service \
		unattended-upgrades.service >/dev/null 2>&1
	# The image coding uid (1000..199999, no privileged groups): only for sessions whose volume predates member machines.
	groupadd -g 1500 coding
	useradd -u 1500 -g 1500 -M -d /nonexistent -s /usr/sbin/nologin coding
	grep -Eq "^passwd:.*systemd" /etc/nsswitch.conf || { echo "no nss-systemd for passwd" >&2; exit 1; }
	command -v git >/dev/null
	cloud-init clean --logs >/dev/null 2>&1 || true
	cd / && rm -rf /root/build
	sync
' || fail "building the coding image"
lx stop p3-build
lx publish p3-build --alias p3-coding >/dev/null
lx delete p3-build
lx image export p3-coding "$WORK/push/coding-image/" >/dev/null
[[ -n $(ls -A "$WORK/push/coding-image") ]] || fail "the coding image did not export"
CODING_IMAGE=$(lxc image info p3-coding --project "$PROJECT" </dev/null | awk '/^Fingerprint:/ {print $2}')
[[ $CODING_IMAGE =~ ^[0-9a-f]{64}$ ]] || fail "the coding image has no fingerprint"
pass "built today's coding image $CODING_IMAGE ($((SECONDS - start)) s)"

# --- The throwaway node: no network card at all ----------------------------------------------------------------------
start=$SECONDS
lx init p3-vm "$VM" --vm --no-profiles --storage "$POOL" -c limits.cpu=6 -c limits.memory=8GiB \
	-c boot.autostart=false -d root,size=40GiB >/dev/null
lx start "$VM"
for _ in $(seq 1 120); do lx exec "$VM" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$VM" -- true || fail "the node's agent did not answer"
[[ -z $(lx exec "$VM" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "the node has a network card"
pass "a throwaway node with no network card runs in the test machine ($((SECONDS - start)) s)"

start=$SECONDS
lx file push -r "$WORK/push" "$VM/root/" >/dev/null
lx exec "$VM" -- env PATH=/snap/bin:/usr/sbin:/usr/bin:/sbin:/bin bash -euo pipefail -c '
	touch /etc/qorpera-throwaway-vm
	install -m 0755 /root/push/node/node /usr/local/bin/node
	# Before LXD: its socket then belongs to group lxd, which the executor joins.
	groupadd -f lxd
	cd /root/push/snaps
	snap ack snapd_*.assert && snap install snapd_*.snap >/dev/null
	snap ack core26_*.assert && snap install core26_*.snap >/dev/null
	snap ack lxd_*.assert && snap install lxd_*.snap >/dev/null
	lxd waitready --timeout=120
	dpkg -i --skip-same-version /root/push/debs/*.deb >/dev/null
' || fail "setting up the node"
pass "LXD, the NFS packages and Node are set up in the node, offline ($((SECONDS - start)) s)"

# --- The coding node, inside the node VM -----------------------------------------------------------------------------
lx exec "$VM" -- env PATH=/snap/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	bash /root/push/coding-worker/test/prove-coding-session-node.sh /root/push "$CODING_IMAGE" | tee "$WORK/node.out" ||
	fail "setting up the coding node failed"
grep -qx "NODE READY" "$WORK/node.out" || fail "setting up the coding node did not finish"

# --- The coding session: the test database here, the executor in the node, Order 9's four turns ----------------------
# P3_NODE_ONLY=1 stops before it: the node alone.
if [[ ${P3_NODE_ONLY:-0} == 1 ]]; then
	echo "note: P3_NODE_ONLY=1, so no coding session runs"
else
	(cd "$REPO" && "$NODE" deploy/coding-worker/test/p3-driver.mjs "$PROJECT" "$VM" "$CODING_IMAGE" "$WORK/push/package" \
		"$(sed -n 's/^P3-NODE //p' "$WORK/node.out")") | tee "$WORK/driver.out" || fail "the coding session failed"
	grep -qx "SESSION PROVEN" "$WORK/driver.out" || fail "the coding session did not finish"
fi

# --- The test machine is as it was -----------------------------------------------------------------------------------
lx delete --force "$VM" >/dev/null
machine_state >"$WORK/after"
diff -u "$WORK/before" "$WORK/after" || fail "the run changed the test machine (above)"
modules >"$WORK/modules-after"
gone=$(comm -23 "$WORK/modules-before" "$WORK/modules-after")
[[ -z $gone ]] || fail "modules went away on the test machine: $gone"
for module in $WATCHED_MODULES; do
	grep -qx "$module" "$WORK/modules-after" && ! grep -qx "$module" "$WORK/modules-before" &&
		fail "the run loaded $module on the test machine"
done
pass "the test machine's links, nft tables, sysctls and watched modules are as before"
echo "ALL PASSED"
