#!/usr/bin/env bash
# Authored by OpenAI Codex. Claude-Review: Pending.
# Preliminary F3 4d substrate proof in an offline, disposable nested VM. This is not
# acceptance of a built office image. The production office unit is copied exactly;
# the harness records image-kind=prepared-substrate and synthetic service authority.
#
# node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- \
#   bash scripts/prove-office-folder-substrate-vm.sh </dev/null
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=${QORPERA_SUBSTRATE_BASE_IMAGE:-ubuntu:26.04}
fail() { echo "FAIL: $*" >&2; exit 1; }
owner_mode=${1:-root-default}
[[ $# -le 1 && ( "$owner_mode" == root-default || "$owner_mode" == office-account ) ]] || fail "owner mode is root-default or office-account"

[[ $(id -u) == 0 ]] || fail "run through run-on-node.mjs --sudo"
[[ $(hostname) == qorpera-testvm-* ]] || fail "only an operator test VM may provision this nested proof"
[[ -f /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "operator test VM and nested KVM required"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
[[ $(lxc remote list --format json | jq -r '.local.Addr') == unix:// ]] || fail "local LXD is not its Unix socket"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
# Keep LXD's project+instance Unix-socket paths below sockaddr_un's limit.
project="qfs-${suffix}"
pool="$project"
vm="qorpera-substrate-${suffix}"
work=$(mktemp -d /tmp/qorpera-substrate.XXXXXXXX)
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
}

cleanup() {
	local status=$?
	trap - EXIT
	set +e
	if ((made_vm)); then lx delete --force "$vm" || status=1; fi
	if [[ -n "$fingerprint" ]]; then lx image delete "$fingerprint" || status=1; fi
	if ((made_project)); then lxc --force-local project delete "$project" </dev/null || status=1; fi
	if ((made_pool)); then lxc --force-local storage delete "$pool" </dev/null || status=1; fi
	machine_state >"$work/after"
	diff -u "$work/before" "$work/after" || status=1
	awk '{print $1}' /proc/modules | sort >"$work/modules-after"
	if [[ -n $(comm -23 "$work/modules-before" "$work/modules-after") ]]; then
		echo 'FAIL: a shared-test-VM kernel module disappeared' >&2
		status=1
	fi
	for module in br_netfilter bridge stp llc tun macvlan macvtap vhost_net nft_meta_bridge nf_conntrack_bridge; do
		if grep -qx "$module" "$work/modules-after" && ! grep -qx "$module" "$work/modules-before"; then
			echo "FAIL: shared-test-VM module appeared: $module" >&2
			status=1
		fi
	done
	if [[ -f "$work/evidence.json" ]]; then
		echo 'OFFICE_FOLDER_SUBSTRATE_EVIDENCE_BEGIN'
		cat "$work/evidence.json"
		echo 'OFFICE_FOLDER_SUBSTRATE_EVIDENCE_END'
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
lx image copy "$image" local: --vm --alias substrate-base
fingerprint=$(lx image list --format json | jq -r 'if length == 1 then .[0].fingerprint else empty end')
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail "did not resolve one immutable VM image"
lx init "$fingerprint" "$vm" --vm --no-profiles --storage "$pool" \
	-c limits.cpu=2 -c limits.memory=4GiB -d root,size=16GiB \
	-c user.qorpera.acceptance=office-folder-substrate
made_vm=1
if ! lx start "$vm"; then
	lx info --show-log "$vm" || true
	fail "nested VM did not start"
fi
for _attempt in $(seq 1 120); do
	if lx exec "$vm" -- true >/dev/null 2>&1; then break; fi
	sleep 2
done
lx exec "$vm" -- true
[[ -z $(lx exec "$vm" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "nested VM unexpectedly has a NIC"
uuid=$(lx config get "$vm" volatile.uuid)
[[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || fail "missing VM identity"

# Resolve against the nested guest's package database. Download only on the shared
# VM; package installation and modprobe happen exclusively inside the nested guest.
mkdir -p "$work/push/debs"
lx file pull "$vm/var/lib/dpkg/status" "$work/vm-status"
apt-get -s -q -o Dir::State::status="$work/vm-status" -o Debug::NoLocking=1 \
	install --no-install-recommends python3 bubblewrap iproute2 util-linux fuse3 >"$work/plan"
awk '$1 == "Inst" { v = ($3 ~ /^\[/) ? $4 : $3; sub(/^\(/, "", v); print $2 "=" v }' "$work/plan" >"$work/wanted"
if [[ -s "$work/wanted" ]]; then
	(cd "$work/push/debs" && xargs apt-get download -q <"$work/wanted")
fi
cp "$repo/deploy/lxd-company-computer-guest/qorpera-company-computer.service" "$work/push/"
lx file push -r "$work/push" "$vm/root/"
# An ordinary shell command, all executed by the nested VM's agent. No shared-VM
# sysctl, nft or module change is part of this wrapper.
lx exec "$vm" -- bash -euc 'if compgen -G "/root/push/debs/*.deb" >/dev/null; then dpkg -i /root/push/debs/*.deb; fi'
lx exec "$vm" -- useradd --system --user-group --no-create-home --shell /usr/sbin/nologin qorpera-office
lx exec "$vm" -- install -d -m 0700 /etc/qorpera-office/credentials
lx exec "$vm" -- install -m 0644 /root/push/qorpera-company-computer.service /etc/systemd/system/qorpera-company-computer.service
lx exec "$vm" -- systemctl daemon-reload
lx exec "$vm" -- modprobe fuse
lx exec "$vm" -- test -c /dev/fuse

cd "$repo"
node scripts/build-folder-program.mjs --out "$work/qorpera-folder" >"$work/build-record.json"
folder_sha=$(sha256sum "$work/qorpera-folder" | awk '{print $1}')
echo "Nested candidate VM: $project/$vm UUID=$uuid image=$fingerprint folder=$folder_sha"
node scripts/test-office-folder-substrate.mjs --project "$project" --vm "$vm" \
	--uuid "$uuid" --image "$fingerprint" --image-kind prepared-substrate \
	--owner-mode "$owner_mode" \
	--folder-binary "$work/qorpera-folder" --folder-sha256 "$folder_sha" \
	--record "$work/evidence.json" --execute
