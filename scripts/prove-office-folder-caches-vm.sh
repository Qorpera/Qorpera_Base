#!/usr/bin/env bash
# MC3c's node e2e: do the office's folder mounts keep their caches on the machine's disk, each in its own folder, and
# does a closed view end the mount within its bound? Boots a staged office image in an offline, disposable nested VM on
# node01's test machine, in a project this run claims, and runs scripts/test-office-folder-caches.mjs against it twice:
# once, then again after the VM restarted. The staged image is only read: it is imported into this run's own project
# and deleted with it. See deploy/test-machine/OFFICE-FOLDER-CACHES.md.
#
# node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
#   bash scripts/prove-office-folder-caches-vm.sh [--image <fingerprint>] [--unpinned-program] </dev/null
#
# Not --no-install: the launcher bundles the folder helper with the repo's esbuild. --unpinned-program is a dry run
# against a folder program that is not the checked-in record's (a branch's work in progress): the record names it, and
# the run is never the proof.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
# A1 (commit c1ac31535), staged for the remount proof. It predates folder-v2; the proof brings its own program and unit.
image=9a4935f853ae27b80bb8d2fd8cbe33d1cb3db68bbfe0d47469bb0ebdbbf20f01
pinned=1
while [[ $# -gt 0 ]]; do
	case "$1" in
		--image) [[ $# -ge 2 ]] || fail "--image needs a fingerprint"; image=$2; shift 2 ;;
		--unpinned-program) pinned=0; shift ;;
		*) fail "usage: prove-office-folder-caches-vm.sh [--image <fingerprint>] [--unpinned-program]" ;;
	esac
done
[[ "$image" =~ ^[0-9a-f]{64}$ ]] || fail "the image is a full sha256 fingerprint"
stage="/var/lib/qorpera-office-stage/${image:0:12}"
tarball="$stage/img.tar.gz"

[[ $(id -u) == 0 ]] || fail "run through run-on-node.mjs --sudo"
# Staged office images stay on node01's test machine.
[[ $(hostname) == qorpera-testvm-node01 ]] || fail "only node01's test machine holds the staged office images"
[[ -f /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "operator test VM and nested KVM required"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
[[ $(lxc remote list --format json | jq -r '.local.Addr') == unix:// ]] || fail "local LXD is not its Unix socket"
[[ -f "$tarball" && ! -L "$tarball" && ! -L "$stage" ]] || fail "no staged unified image at $tarball"
[[ $(sha256sum "$tarball" | awk '{print $1}') == "$image" ]] || fail "the staged image is not $image"
lxd_dir=/var/snap/lxd/common/lxd
[[ -d "$lxd_dir" ]] || lxd_dir=/var/lib/lxd
(($(df --output=avail -B1 "$lxd_dir" | tail -1) >= 16 * 1024 * 1024 * 1024)) || fail "less than 16 GiB free under $lxd_dir"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
# Keep LXD's project+instance Unix-socket paths below sockaddr_un's limit.
project="qfc-${suffix}"
pool="$project"
vm="qorpera-caches-${suffix}"
work=$(mktemp -d /tmp/qorpera-caches.XXXXXXXX)
made_project=0
made_pool=0
made_vm=0
fingerprint=''
lx() { lxc --force-local --project "$project" "$@" </dev/null; }

machine_state() {
	# Other queued suites may create Docker links; this proof creates no network.
	ip -br link | awk '{print $1}' | sed 's/@.*//' | grep -vE '^(veth|br-)' | sort
	nft list tables | sort
	sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.netfilter.nf_conntrack_max
	if [[ -f /proc/sys/net/bridge/bridge-nf-call-iptables ]]; then
		cat /proc/sys/net/bridge/bridge-nf-call-iptables
	else
		echo 'no br_netfilter'
	fi
	# The staged image is only read.
	stat -c '%n %s %Y %a %U' "$stage" "$stage"/*
}

cleanup() {
	local status=$?
	trap - EXIT
	set +e
	if ((made_vm)); then lx delete --force "$vm" || status=1; fi
	# Every image in the claimed project is this run's import, even one whose fingerprint check failed.
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
	for module in br_netfilter bridge stp llc tun macvlan macvtap vhost_net nft_meta_bridge nf_conntrack_bridge fuse; do
		if grep -qx "$module" "$work/modules-after" && ! grep -qx "$module" "$work/modules-before"; then
			echo "FAIL: shared-test-VM module appeared: $module" >&2
			status=1
		fi
	done
	# The second run's record holds the first's; a run that stopped after the first has only that one.
	for record in evidence.json first.json; do
		if [[ -f "$work/$record" ]]; then
			echo 'OFFICE_FOLDER_CACHES_EVIDENCE_BEGIN'
			cat "$work/$record"
			echo 'OFFICE_FOLDER_CACHES_EVIDENCE_END'
			break
		fi
	done
	((pinned)) || echo 'DRY RUN: an unpinned folder program; this run is not the proof'
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
lx image import "$tarball"
[[ $(lx image list --format json | jq -r 'if length == 1 then .[0].fingerprint else empty end') == "$image" ]] || fail "the project does not hold exactly the staged image"
fingerprint=$image
# The image's disk is 80 GiB; the dir pool keeps it sparse. No profile, so no NIC.
lx init "$fingerprint" "$vm" --vm --no-profiles --storage "$pool" \
	-c limits.cpu=2 -c limits.memory=4GiB -d root,size=81GiB \
	-c user.qorpera.acceptance=office-folder-caches
made_vm=1
if ! lx start "$vm"; then
	lx info --show-log "$vm" || true
	fail "nested VM did not start"
fi

# After each boot: the agent answers, the boot finished, no NIC, FUSE, and no office in its restart loop. Prints
# present or loaded.
guest_ready() {
	for _attempt in $(seq 1 150); do
		if lx exec "$vm" -- true >/dev/null 2>&1; then break; fi
		sleep 2
	done
	lx exec "$vm" -- true
	# The guest's lxd-agent drops calls while the guest still boots (`Failed connecting channel 1: context deadline
	# exceeded` right after the restart), as prove-office-command-namespaces-vm.sh found: let the boot finish first. A
	# dropped call answers nothing and is asked again. With no NIC the boot can end degraded, which is fine here.
	local boot=
	for _attempt in $(seq 1 10); do
		boot=$(lx exec "$vm" -- timeout 240 systemctl is-system-running --wait 2>/dev/null) || true
		[[ -n "$boot" ]] && break
		sleep 2
	done
	[[ "$boot" == running || "$boot" == degraded ]] || fail "the nested VM's boot did not finish: ${boot:-no answer}"
	[[ -z $(lx exec "$vm" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "nested VM unexpectedly has a NIC"
	# Nothing is installed in the image under test. FUSE is loaded only inside the nested VM, only if it is missing.
	local fuse
	if lx exec "$vm" -- test -c /dev/fuse; then
		fuse=present
	else
		lx exec "$vm" -- modprobe fuse >&2
		lx exec "$vm" -- test -c /dev/fuse
		fuse=loaded
	fi
	# A1 starts its office at boot. With no boot credentials it fails, and Restart=on-failure can hold it in
	# auto-restart. Only that loop is stopped; the launcher still refuses an office that runs, or any credential.
	local office_state
	office_state=$(lx exec "$vm" -- systemctl show -p ActiveState,SubState --value qorpera-company-computer.service | paste -sd/ -)
	echo "Office service after boot: $office_state" >&2
	if [[ "$office_state" == activating/auto-restart ]]; then
		lx exec "$vm" -- systemctl stop qorpera-company-computer.service
		echo "Office service stopped out of its auto-restart loop: $(lx exec "$vm" -- systemctl show -p ActiveState,SubState --value qorpera-company-computer.service | paste -sd/ -)" >&2
	fi
	echo "$fuse"
}
fuse=$(guest_ready)
uuid=$(lx config get "$vm" volatile.uuid)
[[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || fail "missing VM identity"

cd "$repo"
node scripts/build-folder-program.mjs --out "$work/qorpera-folder" >"$work/build-record.json"
folder_sha=$(sha256sum "$work/qorpera-folder" | awk '{print $1}')
expected_folder_sha=$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$repo/deploy/folder-service/folder-program-linux-x64.json")
program=(--folder-binary "$work/qorpera-folder" --folder-sha256 "$folder_sha")
if ((pinned)); then
	[[ "$folder_sha" == "$expected_folder_sha" ]] || fail "built folder binary differs from the checked-in artifact record"
else
	# The tree may be a copy without .git (run-on-node's): the program's own hash names it.
	echo "DRY RUN: folder program $folder_sha built from this tree; the checked-in record is $expected_folder_sha"
	program+=(--unpinned-program)
fi
echo "Nested office VM: $project/$vm UUID=$uuid image=$fingerprint folder=$folder_sha fuse=$fuse"
node scripts/test-office-folder-caches.mjs --phase first --project "$project" --vm "$vm" \
	--uuid "$uuid" --image "$fingerprint" --fuse "$fuse" "${program[@]}" \
	--record "$work/first.json" --execute

# The machine restarts: /run is gone, the disk stays. The second run finds the caches the first one made.
lx restart "$vm" --timeout 120 || lx restart --force "$vm"
fuse=$(guest_ready)
node scripts/test-office-folder-caches.mjs --phase second --first "$work/first.json" --project "$project" --vm "$vm" \
	--uuid "$uuid" --image "$fingerprint" --fuse "$fuse" "${program[@]}" \
	--record "$work/evidence.json" --execute
