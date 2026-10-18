#!/usr/bin/env bash
# Proof of a coding session on a throwaway node (P3), run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node02 --sudo --no-status -- \
#     bash deploy/coding-worker/test/prove-coding-session-vm.sh </dev/null
#
# (run-on-node installs the checkout: the guest package, the executor composition, the guest agent and the folder
# service are built here with esbuild, and the folder program with Docker in its pinned Rust image.)
#
# A coding executor needs what a node has: its custody on an NFS mount, LXD with the agent exit's qagent0 network, and
# KVM for the coding machines. None of that may be made on the shared test machine (no module, sysctl or nft change),
# so the run makes a throwaway node: a VM with no network card in its own LXD project, with LXD, the NFS server and
# Node pushed in (everything is fetched here, as deploy/agent-exit/test/prove-lxd-vm.sh does), 5f's coding image and
# the folder model (phase A): the folder service package with today's folder program, and the coding guest agent. The
# image is built here by deploy/coding-machine/build-coding-image.sh as its test/prove-coding-image.sh builds it: in a
# second throwaway project, the builder with one plain card on the test machine's bridge (no filters, so no nft rule)
# and its downloads through test/proof-proxy.py, run here as nobody. The node makes its coding machines inside itself,
# one level further down, so they need the test machine's nested KVM. With P3_CODE_HOST=1 (phase B), the company's
# code host image is built and exported first (../../code-host/test/export-code-host-image.sh, which needs the
# default storage pool and lxdbr0) and the node runs the company's code host from it, beside the coding machine, for
# the session's repository. test/prove-coding-session-node.sh sets the node
# up; then test/p3-driver.mjs runs the test database here and the executor in the node, for four turns of one coding
# session (ten on phase B: C2's six keep a quiet turn awake, kill the folder service inside the node, and narrow a
# folder a turn read, so its machine gets a new disk from its image; with P3_UNTIL_ARCHIVE=1 it ends after the four,
# once turn 3's archive is judged).
# Before and after, the test machine's links (but Docker's), nft table names, a few sysctls and the modules a proof
# could load are compared: one of those changing, or any module going away, fails the run. Everything it made is
# removed at the end, also on failure. It needs 40 GiB free in /var/tmp. Prints PASS lines, then ALL PASSED.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
PROJECT=qorpera-p3-node
BUILD=qorpera-p3-build
POOL=qorpera-p3
NETWORK=lxdbr0
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
for tool in lxc snap apt-get apt-cache nft jq python3 setpriv setsid docker; do
	command -v "$tool" >/dev/null || fail "no $tool here"
done
NODE=$(command -v node || true)
[[ -n $NODE ]] || NODE=$(ls /usr/local/bin/node /opt/node/bin/node 2>/dev/null | head -1 || true)
[[ -x $NODE ]] || fail "no node here"
NODE=$(readlink -f "$NODE")
# The driver runs last, after about 40 minutes of builds: what node --check cannot see in it is checked first, and
# C1-V's judgments (test/p3-c1v.mjs, which P3_C1V=1 runs after phase B's last turn).
[[ ${P3_C1V:-0} != 1 || ${P3_CODE_HOST:-0} == 1 ]] || fail "P3_C1V=1 runs after phase B's last turn: set P3_CODE_HOST=1 too"
# P3_UNTIL_ARCHIVE=1 ends phase B's session after turn 4, once the archive is judged: a short run, with no C2 turn.
[[ ${P3_UNTIL_ARCHIVE:-0} != 1 || (${P3_CODE_HOST:-0} == 1 && ${P3_C1V:-0} != 1) ]] ||
	fail "P3_UNTIL_ARCHIVE=1 ends phase B after turn 4: set P3_CODE_HOST=1, and not P3_C1V=1"
driver_check=$("$NODE" --test "$HERE/p3-driver.test.mjs" "$HERE/p3-c1v.test.mjs" 2>&1 </dev/null) ||
	{ printf '%s\n' "$driver_check" | tail -n 40; fail "test/p3-driver.test.mjs or test/p3-c1v.test.mjs failed"; }
# The image's build and export, the node's disk and the coding machine in it: before anything is made.
for place in /var/tmp /var/snap/lxd/common/lxd; do
	[[ -d $place ]] || continue
	free=$(df --output=avail -B1G "$place" | tail -n 1 | tr -d ' ') || fail "cannot read the free space in $place"
	((free >= 40)) || fail "$free GiB free in $place: the coding image's build and export and the node's disk need 40"
done
lxc network show "$NETWORK" </dev/null >/dev/null 2>&1 || fail "no network $NETWORK"
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
made_build=0
PROXY_PID=
FOLDER_PID=
stop_proxy() {
	if [[ -n $PROXY_PID ]]; then
		kill "$PROXY_PID" 2>/dev/null || true
		wait "$PROXY_PID" 2>/dev/null || true
		PROXY_PID=
	fi
}
# The build project and everything in it (the builder deletes itself; the base image it fetched stays). Safe twice.
drop_build() {
	local name
	((made_build)) || return 0
	for name in $(lxc list --project "$BUILD" -c n -f csv </dev/null 2>/dev/null); do
		lxc delete --project "$BUILD" --force "$name" </dev/null >/dev/null 2>&1 || true
	done
	for name in $(lxc image list --project "$BUILD" -c F -f csv </dev/null 2>/dev/null); do
		lxc image delete --project "$BUILD" "$name" </dev/null >/dev/null 2>&1 || true
	done
	if lxc project delete "$BUILD" </dev/null >/dev/null 2>&1; then
		made_build=0
	else
		echo "could not delete LXD project $BUILD" >&2
	fi
}
cleanup() {
	set +e
	# The folder program's build, if it still runs: its node and its docker run (a container still building ends alone).
	if [[ -n $FOLDER_PID ]]; then
		kill -- -"$FOLDER_PID" 2>/dev/null
		wait "$FOLDER_PID" 2>/dev/null
	fi
	stop_proxy
	lx delete --force "$VM" >/dev/null 2>&1
	drop_build
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

# --- Phase B: the company's code host image (5e), as files the node imports -----------------------------------------
# P3_CODE_HOST=1: ../../code-host/test/export-code-host-image.sh builds it from this tree first, while nothing else of
# this run builds (it lists the test machine's state before and after, and fails on any other change), and leaves its
# files and its record for the node.
CODE_HOST=
if [[ ${P3_CODE_HOST:-0} == 1 ]]; then
	start=$SECONDS
	mkdir -p "$WORK/push"
	bash "$REPO/deploy/code-host/test/export-code-host-image.sh" "$WORK/push/code-host" >"$WORK/code-host.log" 2>&1 </dev/null ||
		{ tail -n 80 "$WORK/code-host.log"; fail "the code host image did not build and export"; }
	CODE_HOST=$(jq -er '.imageFingerprint | select(test("^[0-9a-f]{64}$"))' "$WORK/push/code-host/code-host-image-export.json") ||
		fail "the code host image's export has no record"
	[[ $(tail -n 1 "$WORK/code-host.log") == "EXPORTED $CODE_HOST "* ]] || { tail -n 20 "$WORK/code-host.log"; fail "the code host export did not finish"; }
	pass "built the code host image $CODE_HOST (folder program $(jq -r .folderProgramSha256 "$WORK/push/code-host/code-host-image-export.json")," \
		"$(du -sm "$WORK/push/code-host" | cut -f1) MiB exported) in $(((SECONDS - start) / 60)) min"
fi
# The image build's own project: build-coding-image.sh builds only in an empty one that is not the coding project.
claim=$(lxc project create "$BUILD" -c features.images=true -c features.profiles=false </dev/null 2>&1) ||
	fail "cannot claim LXD project $BUILD (a P3 proof's build may be left over): $claim"
made_build=1

# --- What the node needs, fetched here ------------------------------------------------------------------------------
start=$SECONDS
mkdir -p "$WORK/push/snaps" "$WORK/push/debs" "$WORK/push/coding-image" "$WORK/push/node"
# The folder program meanwhile, in the background (Docker, the pinned Rust image), in a session of its own so the
# cleanup can stop it with its docker run.
setsid "$NODE" "$REPO/scripts/build-folder-program.mjs" --out "$WORK/qorpera-folder" >"$WORK/folder-program.out" \
	2>"$WORK/folder-program.log" </dev/null &
FOLDER_PID=$!
# The nodes' and test machines' LXD revision (bootstrap-lxd-host.sh pins it).
(cd "$WORK/push/snaps" && snap download snapd >/dev/null && snap download core26 >/dev/null &&
	snap download lxd --revision=40424 >/dev/null) || fail "cannot fetch LXD 6.9 rev 40424"
# Packages with everything they need, whatever the cloud image already has (dpkg skips those): the NFS server and
# client, bubblewrap (the Git broker's sandbox) and Git (the broker's and the stand-in GitHub's).
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
ls "$WORK/push/debs"/nfs-kernel-server_*.deb "$WORK/push/debs"/nfs-common_*.deb "$WORK/push/debs"/bubblewrap_*.deb \
	"$WORK/push/debs"/git_*.deb >/dev/null 2>&1 ||
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

# --- 5f's coding image, built as deploy/coding-machine/test/prove-coding-image.sh builds it -------------------------
# build-coding-image.sh in the build project, its builder with one plain card on the test machine's bridge. The bridge
# forwards nothing (Docker's FORWARD policy here drops it), so the builder's downloads go through test/proof-proxy.py,
# run as nobody on the bridge's address while it builds. The image lands in the node project's store; it is exported
# for the node, which imports it under the same fingerprint, and leaves the store.
start=$SECONDS
BRIDGE=$(lxc network get "$NETWORK" ipv4.address </dev/null)
[[ $BRIDGE =~ ^[0-9.]+/[0-9]+$ ]] || fail "$NETWORK has no IPv4 address ($BRIDGE)"
setpriv --reuid=65534 --regid=65534 --clear-groups python3 -I - "${BRIDGE%/*}" "$BRIDGE" \
	<"$REPO/deploy/coding-machine/test/proof-proxy.py" >"$WORK/proxy.port" 2>"$WORK/proxy.log" &
PROXY_PID=$!
for _ in $(seq 1 50); do [[ -s $WORK/proxy.port ]] && break; sleep 0.2; done
PORT=$(head -n 1 "$WORK/proxy.port")
[[ $PORT =~ ^[0-9]+$ ]] || fail "the proxy did not start: $(cat "$WORK/proxy.log")"
# /tmp is small on a test machine; the export between the two stores goes to /var/tmp.
TMPDIR=/var/tmp QORPERA_BUILDER_NIC=plain QORPERA_BUILD_PROXY="http://${BRIDGE%/*}:$PORT" timeout 5400 \
	bash "$REPO/deploy/coding-machine/build-coding-image.sh" "$BUILD" "$NETWORK" "$POOL" "$PROJECT" \
	>"$WORK/image-build.json" 2>"$WORK/image-build.log" </dev/null ||
	{ tail -n 150 "$WORK/image-build.log"; tail -n 40 "$WORK/proxy.log"; fail "the coding image build failed"; }
stop_proxy
drop_build
((made_build == 0)) || fail "LXD project $BUILD is still there"
CODING_IMAGE=$(jq -er .imageFingerprint "$WORK/image-build.json") || fail "the image build gave no record"
[[ $CODING_IMAGE =~ ^[0-9a-f]{64}$ ]] || fail "the coding image has no fingerprint"
lx image export "$CODING_IMAGE" "$WORK/push/coding-image/" >/dev/null
[[ -n $(ls -A "$WORK/push/coding-image") ]] || fail "the coding image did not export"
lx image delete "$CODING_IMAGE"
pass "built 5f's coding image $CODING_IMAGE (git $(jq -r .git "$WORK/image-build.json"), Node" \
	"$(jq -r .node "$WORK/image-build.json"), $(du -sm "$WORK/push/coding-image" | cut -f1) MiB exported)" \
	"in $(((SECONDS - start) / 60)) min"

# --- The folder model's pieces: the folder program, the folder service package and the guest agent ------------------
wait "$FOLDER_PID" && [[ -s $WORK/qorpera-folder ]] ||
	{ tail -n 60 "$WORK/folder-program.log"; fail "the folder program did not build"; }
FOLDER_PID=
# The record may be behind this merged tree: the proof uses the program built here.
built=$(sha256sum "$WORK/qorpera-folder" | cut -d' ' -f1)
recorded=$(jq -r .sha256 "$REPO/deploy/folder-service/folder-program-linux-x64.json")
[[ $built == "$recorded" ]] || echo "note: the folder program built here is $built;" \
	"deploy/folder-service/folder-program-linux-x64.json records $recorded"
# The code host runs the program its image has; the node's machines run this one. They must be one program.
if [[ -n $CODE_HOST ]]; then
	in_image=$(jq -r .folderProgramSha256 "$WORK/push/code-host/code-host-image-export.json")
	[[ $built == "$in_image" ]] || fail "the code host image has folder program $in_image, the node's machines $built"
fi
(cd "$REPO" && "$NODE" deploy/coding-worker/test/p3-package.mjs --folder "$WORK/push/folder" \
	--folder-program "$WORK/qorpera-folder" >"$WORK/folder.json") ||
	fail "cannot package the folder service and the guest agent"
pass "built the folder program $(jq -r .programSha256 "$WORK/folder.json") and the guest agent" \
	"$(jq -r .agentSha256 "$WORK/folder.json"), and packaged the folder service"

# --- The throwaway node: no network card at all ----------------------------------------------------------------------
# Its root holds the pushed image, its import and a coding machine made from it (the image's root is 16 GiB).
start=$SECONDS
lx init p3-vm "$VM" --vm --no-profiles --storage "$POOL" -c limits.cpu=6 -c limits.memory=8GiB \
	-c boot.autostart=false -d root,size=80GiB >/dev/null
lx start "$VM"
for _ in $(seq 1 120); do lx exec "$VM" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$VM" -- true || fail "the node's agent did not answer"
[[ -z $(lx exec "$VM" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "the node has a network card"
pass "a throwaway node with no network card runs in the test machine ($((SECONDS - start)) s)"

start=$SECONDS
lx file push -r "$WORK/push" "$VM/root/" >/dev/null
# The node has the images now.
rm -rf "$WORK/push/coding-image" "$WORK/push/code-host"
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

# --- The coding session: the test database here, the executor in the node, Order 9's four turns and C2's six ----------
# P3_NODE_ONLY=1 stops before it: the node alone, for a tree whose executor cannot run a session on 5f's image yet.
if [[ ${P3_NODE_ONLY:-0} == 1 ]]; then
	echo "note: P3_NODE_ONLY=1, so no coding session runs"
else
	(cd "$REPO" && "$NODE" deploy/coding-worker/test/p3-driver.mjs "$PROJECT" "$VM" "$CODING_IMAGE" "$WORK/push/package" \
		"$(sed -n 's/^P3-NODE //p' "$WORK/node.out")") | tee "$WORK/driver.out" || fail "the coding session failed"
	if [[ ${P3_UNTIL_ARCHIVE:-0} == 1 ]]; then
		grep -qx "ARCHIVE PROVEN" "$WORK/driver.out" || fail "the coding session did not finish its archive"
		echo "note: P3_UNTIL_ARCHIVE=1, so the session ended after turn 4: no C2 turn ran"
	else
		grep -qx "SESSION PROVEN" "$WORK/driver.out" || fail "the coding session did not finish"
	fi
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
