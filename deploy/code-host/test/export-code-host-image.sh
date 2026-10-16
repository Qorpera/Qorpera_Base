#!/usr/bin/env bash
# The code host image as files (5e), for a proof that runs code hosts inside a node VM of its own, which imports
# images from files (P3's prove-coding-session-vm.sh). Run as root on a test machine:
#
#   node scripts/run-on-node.mjs --machine node02 --sudo --no-status -- \
#     bash deploy/code-host/test/export-code-host-image.sh <out dir> </dev/null
#
# It builds the folder program and the image as test/prove-code-host-image.sh does: the program in Docker
# (scripts/build-folder-program.mjs), the image with build-code-host-image.sh in a throwaway build project with its own
# image store, the builder on one plain card on the test machine's existing bridge (no filters, so LXD adds no nft
# rule), downloading through ../coding-machine/test/proof-proxy.py. The build imports the image into the default
# project's store; this exports it from there into <out dir>, then removes the image and the build project again.
# <out dir> must not exist yet (its parent must); it gets:
#
# - the image's files: `image.root` and its metadata, or one file (`lxc image import <files...>` in the record's order
#   gives the same fingerprint);
# - code-host-image-build.json, the build's record (`qorpera.code-host-image-build/v1`: alias, imageFingerprint,
#   bootstrapSha256, git, folderProgramSha256, rootDiskBytes);
# - code-host-image-export.json (`qorpera.code-host-image-export/v1`): the fingerprint, the folder program's sha-256
#   and each image file's name, size and sha-256, in the order `lxc image import` takes them.
#
# The folder program is the one ../../folder-service/folder-program-linux-x64.json records at this tree (the build
# refuses any other), so a node built from the same tree runs the same program. The test machine's modules, sysctls,
# nft ruleset, links and LXD state are listed before and after (../coding-machine/test/host-state.sh): anything that
# differs fails the run, as does a run beside another one that adds an image to the default store. On failure <out dir>
# is removed. Prints EXPORTED <fingerprint> last.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BUILD=qorpera-export-code-host-build
POOL=default
NETWORK=lxdbr0

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

[[ $# -eq 1 ]] || fail "usage: export-code-host-image.sh <out dir>"
[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
[[ $(hostname) == qorpera-testvm-* ]] || fail "this runs on a test machine only"
export PATH=$PATH:/snap/bin
for tool in lxc jq nft python3 sysctl setpriv docker node sha256sum; do command -v "$tool" >/dev/null || fail "no $tool here"; done
PARENT=$(cd "$(dirname "$1")" && pwd) || fail "no directory $(dirname "$1")"
OUT=$PARENT/$(basename "$1")
[[ ! -e $OUT ]] || fail "$OUT exists already"
SOURCE=$(lxc storage get "$POOL" source </dev/null) || fail "no storage pool $POOL"
lxc network show "$NETWORK" </dev/null >/dev/null || fail "no network $NETWORK"
FREE=$(df --output=avail -B1G "$SOURCE" | tail -1 | tr -d ' ')
((FREE >= 20)) || fail "$FREE GiB free in $SOURCE: the builder and the image need 20"
FREE=$(df --output=avail -B1G "$PARENT" | tail -1 | tr -d ' ')
((FREE >= 4)) || fail "$FREE GiB free in $PARENT: the exported image needs 4"

WORK=$(mktemp -d)
CLAIMED=()
MADE_OUT=0
DONE=0
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
# Everything in the claimed project, and this run's image in the default store. Safe to run twice.
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
	image=$(built_image || true)
	if [[ -n $image ]] && lxc image info --project default "$image" </dev/null >/dev/null 2>&1; then
		lxc image delete --project default "$image" </dev/null >/dev/null 2>&1 || echo "could not delete image $image" >&2
	fi
}
cleanup() {
	set +e
	stop_proxy
	teardown
	if ((MADE_OUT == 1 && DONE == 0)); then rm -rf -- "$OUT"; fi
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
compare calibrate before >/dev/null || echo "(changes in the 15 seconds before, left out where they are sysctls)"

# The build project is this run's claim on the name (a second run stops here and removes nothing of this one). It has
# its own image store, so the builder's base image never enters the test machine's own store.
claim=$(lxc project create "$BUILD" -c features.images=true -c features.profiles=false </dev/null 2>&1) ||
	fail "cannot claim LXD project $BUILD (another code host image export may run here): $claim"
CLAIMED+=("$BUILD")
mkdir -m 0755 "$OUT"
MADE_OUT=1
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

# --- The build and the export (a subshell: its failure still reaches the comparison) ---------------------------------
set +e
(
	set -e
	echo "--- the image build"
	start=$SECONDS
	# /tmp is small on a test machine; the export between the two stores goes to /var/tmp.
	TMPDIR=/var/tmp QORPERA_BUILDER_NIC=plain QORPERA_BUILD_PROXY=$PROXY timeout 5400 bash "$HERE/build-code-host-image.sh" \
		"$BUILD" "$NETWORK" "$POOL" "$WORK/qorpera-folder" >"$WORK/image-build.json" 2>"$WORK/build.log" </dev/null ||
		{ tail -n 150 "$WORK/build.log"; fail "the image build failed"; }
	jq . "$WORK/image-build.json"
	FINGERPRINT=$(jq -er .imageFingerprint "$WORK/image-build.json")
	FOLDER_SHA256=$(jq -er .folderProgramSha256 "$WORK/image-build.json")
	[[ $FOLDER_SHA256 == "$(jq -er .sha256 "$HERE/../folder-service/folder-program-linux-x64.json")" ]] ||
		fail "the image's folder program is not the recorded one"
	echo "built in $(((SECONDS - start) / 60)) min"

	echo "--- the export"
	lxc image export --project default "$FINGERPRINT" "$OUT/image" </dev/null >/dev/null
	# One file (a unified image) or two (the metadata and image.root); `lxc image import` takes the metadata first.
	shopt -s nullglob
	PARTS=("$OUT"/*)
	if [[ -f $OUT/image.root ]]; then
		((${#PARTS[@]} == 2)) || fail "unexpected export: ${PARTS[*]}"
		for part in "${PARTS[@]}"; do [[ $part == "$OUT/image.root" ]] || META=$part; done
		PARTS=("$META" "$OUT/image.root")
	else
		((${#PARTS[@]} == 1)) || fail "unexpected export: ${PARTS[*]}"
	fi
	# LXD's fingerprint is the sha-256 of the files in that order, so these files import as exactly this image.
	[[ $(cat "${PARTS[@]}" | sha256sum | cut -d' ' -f1) == "$FINGERPRINT" ]] ||
		fail "the exported files do not make the image's fingerprint"
	install -m 0644 "$WORK/image-build.json" "$OUT/code-host-image-build.json"
	for part in "${PARTS[@]}"; do
		jq -n --arg name "$(basename "$part")" --argjson bytes "$(stat -c %s "$part")" \
			--arg sha256 "$(sha256sum "$part" | cut -d' ' -f1)" '{name: $name, bytes: $bytes, sha256: $sha256}'
	done | jq -s --arg imageFingerprint "$FINGERPRINT" --arg folderProgramSha256 "$FOLDER_SHA256" \
		'{schema: "qorpera.code-host-image-export/v1", imageFingerprint: $imageFingerprint,
		  folderProgramSha256: $folderProgramSha256, files: .}' >"$OUT/code-host-image-export.json"
	chmod 0644 "${PARTS[@]}" "$OUT/code-host-image-export.json"
	jq . "$OUT/code-host-image-export.json"
)
BUILT=$?
set -e
stop_proxy
if [[ -s $WORK/proxy.log ]]; then
	echo "--- what the proxy refused or could not reach"
	tail -n 40 "$WORK/proxy.log"
fi

# --- The test machine is as it was ------------------------------------------------------------------------------------
IMAGE=$(built_image || true)
teardown
for project in "${CLAIMED[@]}"; do
	! lxc project show "$project" </dev/null >/dev/null 2>&1 || fail "LXD project $project is still there"
done
if [[ -n $IMAGE ]]; then
	! lxc image info --project default "$IMAGE" </dev/null >/dev/null 2>&1 || fail "the image $IMAGE is still there"
fi
CLAIMED=()
snapshot after
compare before after || fail "the run changed the test machine (above)"
((BUILT == 0)) || fail "the build or the export failed (above)"
echo "the test machine's modules, sysctls, nft rules, links and LXD state are as before"
DONE=1
echo "EXPORTED $(jq -r .imageFingerprint "$OUT/code-host-image-export.json") into $OUT"
