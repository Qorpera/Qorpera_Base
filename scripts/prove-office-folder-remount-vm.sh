#!/usr/bin/env bash
# Q3: does the office folder mount come back under the office's running namespaces when its program restarts?
# Boots a staged office image in an offline, disposable nested VM on node01's test machine, in a project this
# run claims, and runs scripts/test-office-folder-remount.mjs against it. The staged image is only read: it is
# imported into this run's own project and deleted with it. See deploy/test-machine/OFFICE-FOLDER-REMOUNT.md.
#
# node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- \
#   bash scripts/prove-office-folder-remount-vm.sh [--image <fingerprint>] </dev/null
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
# A1 (commit c1ac31535), staged for this proof. It predates folder-v2; 4d's acceptance reruns with its own image.
image=9a4935f853ae27b80bb8d2fd8cbe33d1cb3db68bbfe0d47469bb0ebdbbf20f01
if [[ $# -gt 0 ]]; then
	[[ $# -eq 2 && "$1" == --image ]] || fail "usage: prove-office-folder-remount-vm.sh [--image <fingerprint>]"
	image=$2
fi
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
project="qrm-${suffix}"
pool="$project"
vm="qorpera-remount-${suffix}"
work=$(mktemp -d /tmp/qorpera-remount.XXXXXXXX)
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
	if [[ -f "$work/evidence.json" ]]; then
		echo 'OFFICE_FOLDER_REMOUNT_EVIDENCE_BEGIN'
		cat "$work/evidence.json"
		echo 'OFFICE_FOLDER_REMOUNT_EVIDENCE_END'
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
lx image import "$tarball"
[[ $(lx image list --format json | jq -r 'if length == 1 then .[0].fingerprint else empty end') == "$image" ]] || fail "the project does not hold exactly the staged image"
fingerprint=$image
# The image's disk is 80 GiB; the dir pool keeps it sparse. No profile, so no NIC.
lx init "$fingerprint" "$vm" --vm --no-profiles --storage "$pool" \
	-c limits.cpu=2 -c limits.memory=4GiB -d root,size=81GiB \
	-c user.qorpera.acceptance=office-folder-remount
made_vm=1
if ! lx start "$vm"; then
	lx info --show-log "$vm" || true
	fail "nested VM did not start"
fi
for _attempt in $(seq 1 150); do
	if lx exec "$vm" -- true >/dev/null 2>&1; then break; fi
	sleep 2
done
lx exec "$vm" -- true
[[ -z $(lx exec "$vm" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "nested VM unexpectedly has a NIC"
uuid=$(lx config get "$vm" volatile.uuid)
[[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || fail "missing VM identity"

# Nothing is installed in the image under test. FUSE is loaded only inside the nested VM, only if it is missing.
if lx exec "$vm" -- test -c /dev/fuse; then
	fuse=present
else
	lx exec "$vm" -- modprobe fuse
	lx exec "$vm" -- test -c /dev/fuse
	fuse=loaded
fi
# A1 starts its office at boot. With no boot credentials it fails, and Restart=on-failure can hold it in auto-restart.
# Only that loop is stopped; the launcher still refuses an office that runs, or any credential or boot name.
office_state=$(lx exec "$vm" -- systemctl show -p ActiveState,SubState --value qorpera-company-computer.service | paste -sd/ -)
echo "Office service after boot: $office_state"
if [[ "$office_state" == activating/auto-restart ]]; then
	lx exec "$vm" -- systemctl stop qorpera-company-computer.service
	echo "Office service stopped out of its auto-restart loop: $(lx exec "$vm" -- systemctl show -p ActiveState,SubState --value qorpera-company-computer.service | paste -sd/ -)"
fi

cd "$repo"
node scripts/build-folder-program.mjs --out "$work/qorpera-folder" >"$work/build-record.json"
folder_sha=$(sha256sum "$work/qorpera-folder" | awk '{print $1}')
expected_folder_sha=$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$repo/deploy/folder-service/folder-program-linux-x64.json")
[[ "$folder_sha" == "$expected_folder_sha" ]] || fail "built folder binary differs from the checked-in artifact record"
echo "Nested office VM: $project/$vm UUID=$uuid image=$fingerprint folder=$folder_sha fuse=$fuse"
node scripts/test-office-folder-remount.mjs --project "$project" --vm "$vm" \
	--uuid "$uuid" --image "$fingerprint" --fuse "$fuse" \
	--folder-binary "$work/qorpera-folder" --folder-sha256 "$folder_sha" \
	--record "$work/evidence.json" --execute
