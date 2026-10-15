#!/usr/bin/env bash
# F3 4d-3: proof of option (c) for "Who makes the namespaces" (RUNTIME-FOLDER-COMPANY-MACHINES.md) in a disposable
# nested VM with no NIC, on a prepared substrate like #1007's, not a built office image. The office and helper unit files
# are copied as they are; scripts/fixtures/office-command-namespaces.py runs one offline and one networked command.
#
# node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- \
#   bash scripts/prove-office-command-namespaces-vm.sh </dev/null
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=${QORPERA_CMDNS_BASE_IMAGE:-ubuntu:26.04}
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || fail "run through run-on-node.mjs --sudo"
[[ $(hostname) == qorpera-testvm-* ]] || fail "only an operator test VM may provision this nested proof"
[[ -f /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "operator test VM and nested KVM required"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
[[ $(lxc remote list --format json | jq -r '.local.Addr') == unix:// ]] || fail "local LXD is not its Unix socket"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
# Keep LXD's project+instance Unix-socket paths below sockaddr_un's limit.
project="qcn-${suffix}"
pool="$project"
vm="qorpera-cmdns-${suffix}"
work=$(mktemp -d /tmp/qorpera-cmdns.XXXXXXXX)
made_project=0
made_pool=0
made_vm=0
fingerprint=''
lx() { lxc --force-local --project "$project" "$@" </dev/null; }

machine_state() {
	# Other queued suites may create Docker links; this proof creates no network on this machine.
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
		echo 'OFFICE_COMMAND_NAMESPACES_EVIDENCE_BEGIN'
		cat "$work/evidence.json"
		echo 'OFFICE_COMMAND_NAMESPACES_EVIDENCE_END'
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
lx image copy "$image" local: --vm --alias cmdns-base
fingerprint=$(lx image list --format json | jq -r 'if length == 1 then .[0].fingerprint else empty end')
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail "did not resolve one immutable VM image"
lx init "$fingerprint" "$vm" --vm --no-profiles --storage "$pool" \
	-c limits.cpu=2 -c limits.memory=4GiB -d root,size=16GiB \
	-c user.qorpera.acceptance=office-command-namespaces
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
[[ $(lx exec "$vm" -- systemd-detect-virt --vm) == kvm ]] || fail "the guest is not a KVM VM"
uuid=$(lx config get "$vm" volatile.uuid)
[[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || fail "missing VM identity"

# Resolve against the nested guest's package database. Download only on the shared VM; package installation, modprobe,
# sysctl and nft happen exclusively inside the nested guest.
mkdir -p "$work/push/debs"
lx file pull "$vm/var/lib/dpkg/status" "$work/vm-status"
apt-get -s -q -o Dir::State::status="$work/vm-status" -o Debug::NoLocking=1 \
	install --no-install-recommends python3 bubblewrap tini iproute2 util-linux fuse3 nftables procps >"$work/plan"
awk '$1 == "Inst" { v = ($3 ~ /^\[/) ? $4 : $3; sub(/^\(/, "", v); print $2 "=" v }' "$work/plan" >"$work/wanted"
if [[ -s "$work/wanted" ]]; then
	(cd "$work/push/debs" && xargs apt-get download -q <"$work/wanted")
fi
lx file push -r "$work/push" "$vm/root/"
lx exec "$vm" -- bash -euc 'if compgen -G "/root/push/debs/*.deb" >/dev/null; then dpkg -i /root/push/debs/*.deb; fi'
lx exec "$vm" -- useradd --system --user-group --no-create-home --shell /usr/sbin/nologin qorpera-office
# The office unit hides this folder without a '-' prefix, so it must exist, as on the image. It stays empty.
lx exec "$vm" -- install -d -m 0700 /etc/qorpera-office/credentials
lx exec "$vm" -- modprobe fuse
lx exec "$vm" -- test -c /dev/fuse

cd "$repo"
node scripts/build-folder-program.mjs --out "$work/qorpera-folder" >"$work/build-record.json"
folder_sha=$(sha256sum "$work/qorpera-folder" | awk '{print $1}')
expected_folder_sha=$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$repo/deploy/folder-service/folder-program-linux-x64.json")
[[ "$folder_sha" == "$expected_folder_sha" ]] || fail "built folder binary differs from the checked-in artifact record"
probe="$repo/scripts/fixtures/office-command-namespaces.py"
office="$repo/deploy/lxd-company-computer-guest/qorpera-company-computer.service"
helper="$repo/deploy/lxd-company-computer-guest/qorpera-office-folder-helper.service"
sha() { sha256sum "$1" | awk '{print $1}'; }
echo "Nested VM: $project/$vm UUID=$uuid image=$fingerprint folder=$folder_sha"

dir="/run/qorpera-cmdns-$uuid"
for mode in offline networked; do
	lx exec "$vm" -- install -d -m 0755 "$dir"
	lx file push "$probe" "$vm$dir/probe.py"
	lx file push "$work/qorpera-folder" "$vm$dir/qorpera-folder"
	lx file push "$office" "$vm$dir/office.service"
	lx file push "$helper" "$vm$dir/helper.service"
	lx exec "$vm" -- chmod 0644 "$dir/probe.py" "$dir/office.service" "$dir/helper.service"
	lx exec "$vm" -- chmod 0555 "$dir/qorpera-folder"
	for pair in "probe.py:$(sha "$probe")" "qorpera-folder:$folder_sha" "office.service:$(sha "$office")" "helper.service:$(sha "$helper")"; do
		[[ $(lx exec "$vm" -- sha256sum "$dir/${pair%%:*}" | awk '{print $1}') == "${pair#*:}" ]] || fail "${pair%%:*} changed on its way into the guest"
	done
	timeout 240 lxc --force-local --project "$project" exec "$vm" -- systemd-run --quiet --wait --pipe --collect \
		--unit "qorpera-cmdns-probe-$mode" --property RuntimeMaxSec=200 --property KillMode=control-group \
		-- python3 "$dir/probe.py" probe "$dir" "$mode" </dev/null >"$work/$mode.json" || true
	lx exec "$vm" -- python3 "$dir/probe.py" cleanup "$dir" || true
	jq -e . "$work/$mode.json" >/dev/null || { cat "$work/$mode.json" >&2; fail "$mode probe printed no record"; }
done

jq -n --arg image "$fingerprint" --arg uuid "$uuid" --arg folder "$folder_sha" \
	--arg probe "$(sha "$probe")" --arg office "$(sha "$office")" --arg helper "$(sha "$helper")" \
	--arg kernel "$(lx exec "$vm" -- uname -r)" --arg bwrap "$(lx exec "$vm" -- bwrap --version)" \
	--slurpfile offline "$work/offline.json" --slurpfile networked "$work/networked.json" \
	'{schema: "qorpera.office-command-namespaces.v1", imageKind: "prepared-substrate", image: $image, vmUuid: $uuid,
	  kernel: $kernel, bwrap: $bwrap, sha256: {folderProgram: $folder, probe: $probe, officeUnit: $office, helperUnit: $helper},
	  offline: $offline[0], networked: $networked[0],
	  result: (if $offline[0].result == "passed" and $networked[0].result == "passed" then "passed" else "failed" end)}' \
	>"$work/evidence.json"
[[ $(jq -r .result "$work/evidence.json") == passed ]] || fail "a mode failed; see the evidence"
echo "PASS: office command namespaces (option c), offline and networked"
