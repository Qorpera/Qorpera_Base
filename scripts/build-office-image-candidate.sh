#!/usr/bin/env bash
# F3 4e: builds a candidate office image from the staged base, offline, in a disposable nested VM on node01's test
# machine, in a project this run claims. The test machine fetches the recipe's packages and pinned downloads
# (deploy/lxd-company-computer-guest/office-image-dependencies.json); the VM, which has no network card, installs
# them, then the office package (INSTALLATION.md), and runs the toolbox probe from a computer's shell. Without
# --stage the candidate is deleted with the project. With --stage it is exported, unified, to
# /var/lib/qorpera-office-stage/<fingerprint prefix>/img.tar.gz for the folder remount proof, and stays on this
# test machine. See deploy/test-machine/OFFICE-IMAGE-CANDIDATE.md.
#
# node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
#   bash scripts/build-office-image-candidate.sh [--stage] </dev/null
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
source "$repo/scripts/office-image-recipe.sh"
stage_candidate=0
if [[ $# -gt 0 ]]; then
	[[ $# -eq 1 && "$1" == --stage ]] || fail "usage: build-office-image-candidate.sh [--stage]"
	stage_candidate=1
fi
recipe="$repo/deploy/lxd-company-computer-guest/office-image-dependencies.json"
base=$(jq -er '.base.fingerprint | select(test("^[0-9a-f]{64}$"))' "$recipe")
stages=/var/lib/qorpera-office-stage
base_stage="$stages/${base:0:12}"
# The office account of the last production generation (A1), so the folder remount proof sees the same ids.
office_id=20045

[[ $(id -u) == 0 ]] || fail "run through run-on-node.mjs --sudo"
# Staged office images stay on node01's test machine.
[[ $(hostname) == qorpera-testvm-node01 ]] || fail "only node01's test machine holds the staged office images"
[[ -f /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "operator test VM and nested KVM required"
# A VM needs KVM and the vsock its LXD agent talks over; this run never loads a module on the test machine.
[[ -d /sys/module/kvm && -d /sys/module/vhost_vsock ]] || fail "kvm or vhost_vsock is not loaded"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
[[ $(lxc remote list --format json | jq -r '.local.Addr') == unix:// ]] || fail "local LXD is not its Unix socket"
for file in img img.root; do
	[[ -f "$base_stage/$file" && ! -L "$base_stage/$file" ]] || fail "no staged split base at $base_stage"
done
[[ ! -L "$base_stage" && ! -L "$stages" ]] || fail "the stage is a symlink"
[[ $(cat "$base_stage/img" "$base_stage/img.root" | sha256sum | awk '{print $1}') == "$base" ]] || fail "the staged base is not $base"
[[ $(dpkg --print-architecture) == amd64 ]] || fail "the recipe pins x86_64 downloads"
lxd_dir=/var/snap/lxd/common/lxd
[[ -d "$lxd_dir" ]] || lxd_dir=/var/lib/lxd
(($(df --output=avail -B1 "$lxd_dir" | tail -1) >= 32 * 1024 * 1024 * 1024)) || fail "less than 32 GiB free under $lxd_dir"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
# Keep LXD's project+instance Unix-socket paths below sockaddr_un's limit.
project="qoc-${suffix}"
pool="$project"
vm="qorpera-office-${suffix}"
work=$(mktemp -d /tmp/qorpera-office-candidate.XXXXXXXX)
made_project=0
made_pool=0
made_vm=0
staged=''
lx() { lxc --force-local --project "$project" "$@" </dev/null; }

machine_state() {
	# Other queued suites may create Docker links; this build creates no network.
	ip -br link | awk '{print $1}' | sed 's/@.*//' | grep -vE '^(veth|br-)' | sort
	nft list tables | sort
	sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.netfilter.nf_conntrack_max
	if [[ -f /proc/sys/net/bridge/bridge-nf-call-iptables ]]; then
		cat /proc/sys/net/bridge/bridge-nf-call-iptables
	else
		echo 'no br_netfilter'
	fi
	# The staged base is only read.
	stat -c '%n %s %Y %a %U' "$base_stage" "$base_stage"/*
}

cleanup() {
	local status=$?
	trap - EXIT
	set +e
	if ((made_vm)); then lx delete --force "$vm" || status=1; fi
	# Every image in the claimed project is this run's: the base import and the candidate.
	if ((made_project)); then
		for held in $(lx image list --format json | jq -r '.[].fingerprint'); do lx image delete "$held" || status=1; done
	fi
	if ((made_project)); then lxc --force-local project delete "$project" </dev/null || status=1; fi
	if ((made_pool)); then lxc --force-local storage delete "$pool" </dev/null || status=1; fi
	machine_state >"$work/after"
	diff -u "$work/before" "$work/after" || status=1
	awk '{print $1}' /proc/modules | sort >"$work/modules-after"
	if [[ -n $(comm -23 "$work/modules-before" "$work/modules-after") ]]; then
		echo 'FAIL: a shared-test-VM kernel module disappeared' >&2
		status=1
	fi
	for module in br_netfilter bridge stp llc tun macvlan macvtap vhost_net nft_meta_bridge nf_conntrack_bridge fuse vhost vhost_vsock vsock; do
		if grep -qx "$module" "$work/modules-after" && ! grep -qx "$module" "$work/modules-before"; then
			echo "FAIL: shared-test-VM module appeared: $module" >&2
			status=1
		fi
	done
	# A staged candidate from a failed run is not a candidate.
	if [[ -n "$staged" && $status != 0 ]]; then rm -rf -- "$staged" || status=1; fi
	if [[ -f "$work/evidence.json" ]]; then
		echo 'OFFICE_IMAGE_CANDIDATE_EVIDENCE_BEGIN'
		cat "$work/evidence.json"
		echo 'OFFICE_IMAGE_CANDIDATE_EVIDENCE_END'
	fi
	rm -rf -- "$work"
	exit "$status"
}
machine_state >"$work/before"
awk '{print $1}' /proc/modules | sort >"$work/modules-before"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Claim fresh names only. Never adopt, stop or delete another proof's resources.
lxc --force-local project create "$project" -c features.images=true -c features.profiles=false \
	-c features.storage.volumes=true </dev/null
made_project=1
lxc --force-local storage create "$pool" dir </dev/null
made_pool=1
lx image import "$base_stage/img" "$base_stage/img.root"
[[ $(lx image list --format json | jq -r 'if length == 1 then .[0].fingerprint else empty end') == "$base" ]] || fail "the project does not hold exactly the staged base"
# The test machine runs four test slots: a 4 GiB VM waits until it cannot push a test run out of memory.
for _attempt in $(seq 1 120); do
	available=$(awk '$1 == "MemAvailable:" {print $2}' /proc/meminfo)
	((available >= 6 * 1024 * 1024)) && break
	echo "MemAvailable is $((available / 1024)) MiB, under 6 GiB; waiting"
	sleep 30
done
((available >= 6 * 1024 * 1024)) || fail "MemAvailable stayed under 6 GiB for an hour"
# No profile, so no NIC. The dir pool keeps the disk sparse.
lx init "$base" "$vm" --vm --no-profiles --storage "$pool" \
	-c limits.cpu=2 -c limits.memory=4GiB -d root,size=24GiB \
	-c user.qorpera.acceptance=office-image-candidate
made_vm=1
office_image_boot_and_fetch

# The company folder's program, built in its pinned Rust image; the packager refuses any program but the one
# deploy/folder-service/folder-program-linux-x64.json pins. Then the office package (INSTALLATION.md) with the folder,
# and the toolbox probe.
node scripts/build-folder-program.mjs --out "$work/qorpera-folder" >"$work/folder-record.json"
office_image_install

office_image_seal
lx publish "$vm" --alias office-candidate description="Qorpera office candidate (F3 4e, nested proof only)"
candidate=$(lx image list --format json | jq -r '.[] | select(.aliases | any(.name == "office-candidate")) | .fingerprint')
[[ $candidate =~ ^[0-9a-f]{64}$ ]] || fail "the published candidate has no fingerprint"
if ((stage_candidate)); then
	# Unified, so the folder remount proof can check the tarball against its fingerprint.
	# Set only once this run made the directory, so a failure never deletes an earlier stage.
	[[ ! -e "$stages/${candidate:0:12}" ]] || fail "$stages/${candidate:0:12} already exists"
	install -d -o root -g root -m 0700 "$stages/${candidate:0:12}"
	staged="$stages/${candidate:0:12}"
	mkdir "$work/export"
	lx image export "$candidate" "$work/export/"
	exported=("$work/export"/*)
	[[ ${#exported[@]} == 1 && $(sha256sum "${exported[0]}" | awk '{print $1}') == "$candidate" ]] || fail "the export is not one unified image"
	install -o root -g root -m 0400 "${exported[0]}" "$staged/img.tar.gz"
	rm -rf -- "$work/export"
fi
jq -n --slurpfile measured "$work/measured.json" --slurpfile probe "$work/probe.json" \
	--arg base "$base" --arg candidate "$candidate" --arg staged "${staged:+$staged/img.tar.gz}" \
	--arg recipe "$(sha256sum "$recipe" | awk '{print $1}')" \
	--arg package "$(sha256sum "$push/package/manifest.json" | awk '{print $1}')" \
	--arg closure "$(wc -l <"$work/wanted")" --rawfile root "$work/root-toolbox.txt" --rawfile office "$work/office-unit" \
	--arg folder "$(awk '{print $1}' "$work/folder-program")" --rawfile folderUnits "$work/folder-unit-files" \
	--rawfile denials "$work/apparmor-denials" --slurpfile fuseStdio "$work/fusermount3-stdio.json" \
	--rawfile fuseProfile "$work/fusermount3-profile" --rawfile fuseDenials "$work/fusermount3-denials" \
	'{base: $base, candidate: $candidate, staged: (if $staged == "" then null else $staged end), recipeSha256: $recipe,
	packageManifestSha256: $package, aptClosurePackages: ($closure | tonumber), dependencies: $measured[0],
	rootToolbox: ($root | split("\n") | map(select(startswith("toolbox: ")) | ltrimstr("toolbox: "))), shellToolbox: $probe[0],
	rootFolder: ($root | split("\n") | map(select(startswith("folder: ")) | ltrimstr("folder: "))),
	probeAppArmorDenials: ($denials | split("\n") | map(select(. != ""))),
	fusermount3AsRoot: {kernel: ($fuseProfile | split("\n")[0]), appArmor: ($fuseProfile | split("\n")[1]),
		stdio: $fuseStdio[0], appArmorDenials: ($fuseDenials | split("\n") | map(select(. != "")))},
	officeUnit: ($office | split("\n") | map(select(. != "") | split("=") | {key: .[0], value: (.[1:] | join("="))}) | from_entries),
	folderProgramSha256: $folder, folderUnitFiles: ($folderUnits | split("\n") | map(select(. != "") | split(" ") | map(select(. != "")))),
	network: "none"}' >"$work/evidence.json"
echo "Office image candidate $candidate from base $base${staged:+, staged at $staged/img.tar.gz}"
