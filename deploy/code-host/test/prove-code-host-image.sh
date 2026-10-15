#!/usr/bin/env bash
# Proof of the code host image (5e), run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node02 --sudo --build --no-status -- \
#     bash deploy/code-host/test/prove-code-host-image.sh </dev/null
#
# It builds the folder program (scripts/build-folder-program.mjs, in Docker) and the image with
# build-code-host-image.sh in a throwaway build project, which imports it into the default project's store, where
# code hosts take it from. Then test/prove-code-host.ts makes three companies' code hosts from it as the coding
# executor does (code-host.ts), runs test/prove-in-code-host.sh inside one, and checks the node observer's view of
# them. The builder has one plain card on the test machine's existing bridge (no filters, so LXD adds no nft rule) and
# downloads through ../coding-machine/test/proof-proxy.py, as the coding image's proof does; the code hosts have no
# card. The test machine's modules, sysctls, nft ruleset, links and LXD state are listed before and after
# (../coding-machine/test/host-state.sh): anything that differs fails the run. This run's projects, code hosts and
# image are removed at the end, also on failure; other runs that add an image to the default store meanwhile would
# fail the comparison too. Prints PASS lines (the inner proofs' among them), then ALL PASSED.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BUILD=qorpera-proof-code-host-build
POOL=default
NETWORK=lxdbr0

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }

[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
[[ $(hostname) == qorpera-testvm-* ]] || fail "this runs on a test machine only"
export PATH=$PATH:/snap/bin
for tool in lxc jq nft python3 sysctl setpriv docker node; do command -v "$tool" >/dev/null || fail "no $tool here"; done
SOURCE=$(lxc storage get "$POOL" source </dev/null) || fail "no storage pool $POOL"
lxc network show "$NETWORK" </dev/null >/dev/null || fail "no network $NETWORK"
FREE=$(df --output=avail -B1G "$SOURCE" | tail -1 | tr -d ' ')
((FREE >= 30)) || fail "$FREE GiB free in $SOURCE: the builder, the image and the code hosts need 30"
projects() { lxc query '/1.0/projects?recursion=1' </dev/null | jq -r '.[].name'; }
HOSTS=$(projects | grep '^qorpera-codehost-' || true)
[[ -z $HOSTS ]] || fail "code host projects are here already (another code host proof may run): $HOSTS"

WORK=$(mktemp -d)
CLAIMED=()
# The companies' code host projects, named by the proof's three new companies; only these are ever removed.
COMPANIES=()
for _ in 1 2 3; do COMPANIES+=("$(cat /proc/sys/kernel/random/uuid)"); done
CODE_HOSTS=()
for company in "${COMPANIES[@]}"; do CODE_HOSTS+=("qorpera-codehost-${company//-/}"); done
PROXY_PID=
stop_proxy() {
	if [[ -n $PROXY_PID ]]; then
		kill "$PROXY_PID" 2>/dev/null || true
		wait "$PROXY_PID" 2>/dev/null || true
		PROXY_PID=
	fi
}
# The image this run published, from its record or, when the build failed after publishing, its log.
built_image() {
	jq -er '.imageFingerprint | select(test("^[0-9a-f]{64}$"))' "$WORK/image-build.json" 2>/dev/null ||
		sed -n 's/^published \([0-9a-f]\{64\}\) .*/\1/p' "$WORK/build.log" 2>/dev/null | tail -n 1
}
# Everything in the claimed project, this run's code host projects, and this run's image in the default store. Safe
# to run twice.
teardown() {
	local project name image
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
	for project in "${CODE_HOSTS[@]}"; do
		if lxc project show "$project" </dev/null >/dev/null 2>&1; then
			lxc delete --project "$project" --force code-host </dev/null >/dev/null 2>&1 || true
			lxc project delete "$project" </dev/null >/dev/null 2>&1 || echo "could not delete LXD project $project" >&2
		fi
	done
	image=$(built_image || true)
	if [[ -n $image ]] && lxc image info --project default "$image" </dev/null >/dev/null 2>&1; then
		lxc image delete --project default "$image" </dev/null >/dev/null 2>&1 || echo "could not delete image $image" >&2
	fi
}
cleanup() {
	set +e
	stop_proxy
	teardown
	rm -rf "$WORK"
}
trap cleanup EXIT

# The folder program the image carries, built before the test machine is listed (Docker's links and rules come and go).
echo "--- the folder program"
node "$REPO/scripts/build-folder-program.mjs" --out "$WORK/qorpera-folder" </dev/null >"$WORK/folder.json" 2>"$WORK/folder.log" ||
	{ tail -n 60 "$WORK/folder.log"; fail "the folder program build failed"; }
cat "$WORK/folder.json"

# The test machine's state: snapshot <name> and compare <a> <b>.
. "$HERE/../coding-machine/test/host-state.sh"

snapshot calibrate
sleep 15
snapshot before
echo "the test machine before: $(wc -l <"$WORK/before.modules") modules, $(wc -l <"$WORK/before.sysctls") sysctls," \
	"$(wc -l <"$WORK/before.nft") nft lines, $(wc -l <"$WORK/before.links") links"
compare calibrate before >/dev/null || echo "(changes in the 15 seconds before, left out where they are sysctls)"

# The build project is this run's claim on the name (a second run stops here and removes nothing of this one). It has
# its own image store, so the builder's base image never enters the test machine's own store.
claim=$(lxc project create "$BUILD" -c features.images=true -c features.profiles=false </dev/null 2>&1) ||
	fail "cannot claim LXD project $BUILD (another code host image proof may run here): $claim"
CLAIMED+=("$BUILD")
# The way out for the builder: the proxy, as nobody, on the bridge's own address.
BRIDGE=$(lxc network get "$NETWORK" ipv4.address </dev/null)
[[ $BRIDGE =~ ^[0-9.]+/[0-9]+$ ]] || fail "$NETWORK has no IPv4 address ($BRIDGE)"
setpriv --reuid=65534 --regid=65534 --clear-groups python3 -I - "${BRIDGE%/*}" "$BRIDGE" \
	<"$HERE/../coding-machine/test/proof-proxy.py" >"$WORK/proxy.port" 2>"$WORK/proxy.log" &
PROXY_PID=$!
for _ in $(seq 1 50); do [[ -s $WORK/proxy.port ]] && break; sleep 0.2; done
PORT=$(head -n 1 "$WORK/proxy.port")
[[ $PORT =~ ^[0-9]+$ ]] || fail "the proxy did not start: $(cat "$WORK/proxy.log")"
PROXY=http://${BRIDGE%/*}:$PORT
echo "the proxy listens at $PROXY"

# --- The build and the code hosts (a subshell: its failure still reaches the comparison) -----------------------------
set +e
(
	set -e
	echo "--- the image build"
	start=$SECONDS
	# /tmp is small on a test machine; the export between the two stores goes to /var/tmp.
	TMPDIR=/var/tmp QORPERA_BUILDER_NIC=plain QORPERA_BUILD_PROXY=$PROXY timeout 5400 bash "$HERE/build-code-host-image.sh" \
		"$BUILD" "$NETWORK" "$POOL" "$WORK/qorpera-folder" >"$WORK/image-build.json" 2>"$WORK/build.log" </dev/null ||
		{ tail -n 150 "$WORK/build.log"; fail "the image build failed"; }
	tail -n 40 "$WORK/build.log"
	jq . "$WORK/image-build.json"
	FINGERPRINT=$(jq -er .imageFingerprint "$WORK/image-build.json")
	lxc image info --project default "$FINGERPRINT" </dev/null | grep -E '^(Fingerprint|Size|Architecture|Type):'
	[[ -z $(lxc image list --project "$BUILD" -c F -f csv </dev/null) ]] || fail "the build project keeps an image"
	pass "the image built in $(((SECONDS - start) / 60)) min and is in the default project's store only"

	echo "--- the code hosts"
	start=$SECONDS
	timeout 3600 env QORPERA_PROOF_GIT="$(jq -er .git "$WORK/image-build.json")" \
		QORPERA_PROOF_FOLDER_SHA256="$(jq -er .folderProgramSha256 "$WORK/image-build.json")" \
		node "$HERE/test/prove-code-host.ts" "$FINGERPRINT" "$POOL" "${COMPANIES[@]}" </dev/null 2>&1 | tee "$WORK/hosts.out"
	grep -qx "CODE HOSTS PASSED" "$WORK/hosts.out" || fail "the code host proof did not finish"
	pass "the code hosts' proof took $((SECONDS - start)) s"
)
PROOF=$?
set -e
stop_proxy
if [[ -s $WORK/proxy.log ]]; then
	echo "--- what the proxy refused or could not reach"
	tail -n 40 "$WORK/proxy.log"
fi

# --- The test machine is as it was ------------------------------------------------------------------------------------
IMAGE=$(built_image || true)
teardown
for project in "${CLAIMED[@]}" "${CODE_HOSTS[@]}"; do
	! lxc project show "$project" </dev/null >/dev/null 2>&1 || fail "LXD project $project is still there"
done
if [[ -n $IMAGE ]]; then
	! lxc image info --project default "$IMAGE" </dev/null >/dev/null 2>&1 || fail "the image $IMAGE is still there"
fi
CLAIMED=()
CODE_HOSTS=()
snapshot after
echo "--- the test machine after"
compare before after || fail "the run changed the test machine (above)"
pass "the test machine's modules, sysctls, nft rules, links and LXD state are as before"
((PROOF == 0)) || fail "the proof failed (above)"
echo "ALL PASSED"
