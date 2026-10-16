#!/usr/bin/env bash
# F3 4e: builds the production office image on node01's host, in its own LXD, from the Ubuntu base already there
# (office-image-dependencies.json pins it), with the recipe the candidate builder proves (office-image-recipe.sh). The
# build VM has no network card and lives in the given project and pool; only it and a base copy this run made are
# deleted. The image is published there with A1's labels and stays. The evidence names the clean commit, the
# installation receipt (the policy's bootstrapSha256) and the image; accept-office-image.sh and
# sign-office-image-provenance.mjs take it from there. See deploy/first-node/OFFICE-IMAGE-PRODUCTION.md.
#
# As root on node01's host, from a clean checkout:
#   bash scripts/build-office-image-production.sh --hostname <node01's hostname> --folder-program <built qorpera-folder> \
#     --evidence <new file> [--project qofleet01] [--pool qorpera-vm] [--root-size 80GiB] </dev/null
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
source "$repo/scripts/office-image-recipe.sh"
usage="usage: build-office-image-production.sh --hostname <host> --folder-program <file> --evidence <new file> \
[--project <name>] [--pool <name>] [--root-size <N>GiB]"
host=''
folder_program=''
evidence=''
project=qofleet01
pool=qorpera-vm
root_size=80GiB
while (($#)); do
	(($# >= 2)) && [[ -n $2 ]] || fail "$usage"
	case $1 in
	--hostname) host=$2 ;;
	--folder-program) folder_program=$2 ;;
	--evidence) evidence=$2 ;;
	--project) project=$2 ;;
	--pool) pool=$2 ;;
	--root-size) root_size=$2 ;;
	*) fail "$usage" ;;
	esac
	shift 2
done
[[ -n $host && -n $folder_program && -n $evidence ]] || fail "$usage"
[[ $project =~ ^[a-z][a-z0-9-]{0,62}$ && $pool =~ ^[a-z][a-z0-9-]{0,62}$ ]] || fail "invalid project or pool name"
# Whole GiB: at least the candidate's 24 GiB, at most a policy's largest root disk.
[[ $root_size =~ ^[1-9][0-9]{1,3}GiB$ ]] && ((${root_size%GiB} >= 24 && ${root_size%GiB} <= 2048)) ||
	fail "the root size is 24GiB to 2048GiB"
evidence=$(realpath -m -- "$evidence")
[[ ! -e $evidence && ! -L $evidence && -d $(dirname "$evidence") ]] || fail "$evidence exists or has no directory"
[[ $evidence != "$(realpath -- "$repo")"/* ]] || fail "the evidence must go outside the checkout"

[[ $(id -u) == 0 ]] || fail "run as root on node01's host"
[[ $(hostname) == "$host" ]] || fail "this machine is $(hostname), not $host"
# Test machines build candidates only (build-office-image-candidate.sh).
[[ ! -e /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "a node host with KVM required"
# A VM needs KVM and the vsock its LXD agent talks over; this run never loads a module on the host.
[[ -d /sys/module/kvm && -d /sys/module/vhost_vsock ]] || fail "kvm or vhost_vsock is not loaded"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
[[ $(lxc remote list --format json | jq -r '.local.Addr') == unix:// ]] || fail "local LXD is not its Unix socket"
[[ $(dpkg --print-architecture) == amd64 ]] || fail "the recipe pins x86_64 downloads"
lxc --force-local project show "$project" </dev/null >/dev/null || fail "no LXD project $project"
lxc --force-local storage show "$pool" </dev/null >/dev/null || fail "no storage pool $pool"
recipe="$repo/deploy/lxd-company-computer-guest/office-image-dependencies.json"
base=$(jq -er '.base.fingerprint | select(test("^[0-9a-f]{64}$"))' "$recipe")
# The office account of A1, the last production generation.
office_id=20045

# The image is this commit's only if nothing in the checkout differs from it.
clean_commit() {
	local head porcelain
	head=$(git -C "$repo" rev-parse --verify HEAD) || fail "git cannot read $repo (as root it may need safe.directory)"
	porcelain=$(git -C "$repo" status --porcelain) || fail "git status failed in $repo"
	[[ -z $porcelain ]] || fail "the checkout is not clean: $porcelain"
	echo "$head"
}
commit=$(clean_commit)
[[ $commit =~ ^[0-9a-f]{40}$ ]] || fail "HEAD is not a commit: $commit"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
vm="qorpera-image-build-${suffix}"
work=$(mktemp -d /tmp/qorpera-office-production.XXXXXXXX)
made_vm=0
made_base=0
image=''
lx() { lxc --force-local --project "$project" "$@" </dev/null; }
lq() { lxc --force-local query "$@" </dev/null; }

machine_state() {
	# Guests start and stop meanwhile, so their links are not compared; the build changes no nft table or sysctl.
	nft list tables | sort
	sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.netfilter.nf_conntrack_max
	if [[ -f /proc/sys/net/bridge/bridge-nf-call-iptables ]]; then
		cat /proc/sys/net/bridge/bridge-nf-call-iptables
	else
		echo 'no br_netfilter'
	fi
}

cleanup() {
	local status=$?
	trap - EXIT
	set +e
	if ((made_vm)); then lx delete --force "$vm" || status=1; fi
	# Only the base copy this run made, by its fingerprint. Never another image.
	if ((made_base)); then lx image delete "$base" || status=1; fi
	machine_state >"$work/after"
	diff -u "$work/before" "$work/after" || status=1
	awk '{print $1}' /proc/modules | sort >"$work/modules-after"
	if ! diff -u "$work/modules-before" "$work/modules-after"; then
		echo 'FAIL: a host kernel module appeared or disappeared' >&2
		status=1
	fi
	if [[ -n $image && $status != 0 ]]; then
		echo "FAIL: image $image stays in $project; check it, then delete it by hand" >&2
	fi
	if [[ $status == 0 ]]; then
		(set -o noclobber; cat "$work/evidence.json" >"$evidence") && chmod 0444 "$evidence" || status=1
	fi
	if [[ -f "$work/evidence.json" ]]; then
		echo 'OFFICE_IMAGE_PRODUCTION_EVIDENCE_BEGIN'
		cat "$work/evidence.json"
		echo 'OFFICE_IMAGE_PRODUCTION_EVIDENCE_END'
	fi
	rm -rf -- "$work"
	exit "$status"
}
machine_state >"$work/before"
awk '{print $1}' /proc/modules | sort >"$work/modules-before"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The company folder's program, built from this commit by scripts/build-folder-program.mjs where Docker may run, never
# on this host. Only the build the tree pins is taken.
[[ -f $folder_program && ! -L $folder_program ]] || fail "no folder program at $folder_program"
install -m 0555 -- "$folder_program" "$work/qorpera-folder"
folder_pin="$repo/deploy/folder-service/folder-program-linux-x64.json"
[[ $(sha256sum "$work/qorpera-folder" | awk '{print $1}') == $(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$folder_pin") &&
	$(stat -c %s "$work/qorpera-folder") == $(jq -er '.bytes' "$folder_pin") ]] || fail "$folder_program is not the build $folder_pin pins"

# The base already in the host LXD, by its full fingerprint. It is copied in only when the project cannot see it.
if ! lq "/1.0/images/$base?project=$project" >/dev/null 2>&1; then
	from=$(lxc --force-local image list --all-projects --format json </dev/null |
		jq -r --arg base "$base" '[.[] | select(.fingerprint == $base) | .project][0] // empty')
	[[ -n $from ]] || fail "the host LXD has no image $base"
	lxc --force-local image copy "$base" local: --project "$from" --target-project "$project" </dev/null
	made_base=1
fi
[[ $(lq "/1.0/images/$base?project=$project" | jq -r .fingerprint) == "$base" ]] || fail "$project does not see the base $base"
# Admission stays on: the 4 GiB VM starts only with 16 GiB available, so it never takes an office's memory.
available=$(awk '$1 == "MemAvailable:" {print $2}' /proc/meminfo)
((available >= 16 * 1024 * 1024)) || fail "MemAvailable is $((available / 1024)) MiB, under 16 GiB"
# No profile, so no NIC. Only keys a build machine may carry (runtime-node-inventory.ts BUILD_CONFIG).
lx init "$base" "$vm" --vm --no-profiles --storage "$pool" \
	-c boot.mode=uefi-secureboot -c boot.autostart=false -c limits.cpu=2 -c limits.memory=4GiB -d root,size="$root_size" \
	-c user.qorpera.image_builder=true -c user.qorpera.purpose=office-image-build
made_vm=1
[[ $(lx config device get "$vm" root size) == "$root_size" ]] || fail "the build VM's root is not $root_size"
office_image_boot_and_fetch
office_image_install

# The installation receipt is the image's bootstrap (a policy's guest.bootstrapSha256).
package=$(sha256sum "$push/package/manifest.json" | awk '{print $1}')
lx file pull "$vm/opt/qorpera-office/installation.json" "$work/installation.json"
receipt=$(sha256sum "$work/installation.json" | awk '{print $1}')
[[ $(lx exec "$vm" -- sha256sum /opt/qorpera-office/installation.json | awk '{print $1}') == "$receipt" ]] ||
	fail "the pulled installation receipt differs from the VM's"
jq -e --argjson id "$office_id" --arg package "$package" --arg spec "$(sha256sum "$work/spec.json" | awk '{print $1}')" \
	--slurpfile measured "$work/measured.json" \
	'.schema == "qorpera.office-image-installation-receipt/v1" and .uid == $id and .gid == $id and .architecture == "x64"
	and .packageManifestSha256 == $package and .specSha256 == $spec and .dependencies == $measured[0]' \
	"$work/installation.json" >/dev/null || fail "the installation receipt is not this build's"

office_image_seal
# A1's labels, for people: nothing reads them. No alias: a policy names the image by fingerprint.
jq -n --arg vm "$vm" --arg commit "$commit" --arg base "$base" --arg package "$package" --arg receipt "$receipt" \
	'{source: {type: "instance", name: $vm}, public: false, auto_update: false, profiles: [], aliases: [],
	properties: {description: "Qorpera production office 4e uid/gid 20045 \($commit[0:9])", os: "Ubuntu",
	release: "resolute", architecture: "x86_64", "qorpera.purpose": "production-office-4e",
	"qorpera.packageManifestSha256": $package, "qorpera.baseFingerprint": $base, "qorpera.sourceCommit": $commit,
	"qorpera.installationReceiptSha256": $receipt}}' >"$work/publish.json"
image=$(lq --wait -X POST --data "$(cat "$work/publish.json")" "/1.0/images?project=$project" | jq -r '.metadata.fingerprint')
[[ $image =~ ^[0-9a-f]{64}$ ]] || fail "the published image has no fingerprint"
# LXD may give a published image the default profile; the orchestrator takes an office image only with none (A1's
# clear-image-profiles).
if [[ $(lq "/1.0/images/$image?project=$project" | jq -c .profiles) != '[]' ]]; then
	lq "/1.0/images/$image?project=$project" | jq '{auto_update, public, properties, expires_at, profiles: []}' >"$work/image-put.json"
	lq -X PUT --data "$(cat "$work/image-put.json")" "/1.0/images/$image?project=$project" >/dev/null
fi
# As the orchestrator inspects an office image (lxd-client.ts inspectOfficeImage), plus the labels.
lq "/1.0/images/$image?project=$project" >"$work/image.json"
jq -e --arg image "$image" --slurpfile publish "$work/publish.json" \
	'.fingerprint == $image and .type == "virtual-machine" and .public == false and .auto_update == false
	and .architecture == "x86_64" and (.size | type == "number" and . == floor and . >= 1 and . <= pow(1024; 4))
	and .profiles == [] and .aliases == [] and (.properties as $have | $publish[0].properties | to_entries | all($have[.key] == .value))' \
	"$work/image.json" >/dev/null || fail "image $image is not an office image: $(cat "$work/image.json")"
[[ $(clean_commit) == "$commit" ]] || fail "the checkout moved from $commit during the build"

jq -n --slurpfile measured "$work/measured.json" --slurpfile probe "$work/probe.json" --slurpfile image "$work/image.json" \
	--arg host "$host" --arg commit "$commit" --arg base "$base" --arg project "$project" --arg pool "$pool" \
	--arg rootSize "$root_size" --argjson id "$office_id" --arg receipt "$receipt" \
	--arg spec "$(sha256sum "$work/spec.json" | awk '{print $1}')" \
	--arg recipe "$(sha256sum "$recipe" | awk '{print $1}')" --arg package "$package" \
	--arg closure "$(wc -l <"$work/wanted")" --rawfile root "$work/root-toolbox.txt" --rawfile office "$work/office-unit" \
	--arg folder "$(awk '{print $1}' "$work/folder-program")" --rawfile folderUnits "$work/folder-unit-files" \
	--rawfile denials "$work/apparmor-denials" --slurpfile fuseStdio "$work/fusermount3-stdio.json" \
	--rawfile fuseProfile "$work/fusermount3-profile" --rawfile fuseDenials "$work/fusermount3-denials" \
	'{schema: "qorpera.office-image-build/v1", host: $host, commit: $commit, tree: "clean", baseFingerprint: $base,
	project: $project, pool: $pool, rootSize: $rootSize, rootDiskBytes: (($rootSize | rtrimstr("GiB") | tonumber) * pow(1024; 3)),
	uid: $id, gid: $id, installationReceiptSha256: $receipt, specSha256: $spec,
	image: {fingerprint: $image[0].fingerprint, project: $project, type: $image[0].type, public: $image[0].public,
		autoUpdate: $image[0].auto_update, architecture: $image[0].architecture, bytes: $image[0].size,
		profiles: $image[0].profiles, aliases: $image[0].aliases, properties: $image[0].properties},
	recipeSha256: $recipe, packageManifestSha256: $package, aptClosurePackages: ($closure | tonumber), dependencies: $measured[0],
	rootToolbox: ($root | split("\n") | map(select(startswith("toolbox: ")) | ltrimstr("toolbox: "))), shellToolbox: $probe[0],
	rootFolder: ($root | split("\n") | map(select(startswith("folder: ")) | ltrimstr("folder: "))),
	probeAppArmorDenials: ($denials | split("\n") | map(select(. != ""))),
	fusermount3AsRoot: {kernel: ($fuseProfile | split("\n")[0]), appArmor: ($fuseProfile | split("\n")[1]),
		stdio: $fuseStdio[0], appArmorDenials: ($fuseDenials | split("\n") | map(select(. != "")))},
	officeUnit: ($office | split("\n") | map(select(. != "") | split("=") | {key: .[0], value: (.[1:] | join("="))}) | from_entries),
	folderProgramSha256: $folder, folderUnitFiles: ($folderUnits | split("\n") | map(select(. != "") | split(" ") | map(select(. != "")))),
	network: "none"}' >"$work/evidence.json"
echo "Office image $image from base $base"
