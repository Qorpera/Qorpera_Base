#!/usr/bin/env bash
# P4: does an agent's test machine work with the company folder, from the gateway call to the folder core? Builds a
# stand-in test machine image from ubuntu:26.04 and 6c's guest package in a project and pool this run claims on
# node01's test machine, and runs scripts/test-test-machine-folder.mjs against them: the executor's machine host
# makes its VMs there, nested and offline. See deploy/test-machine/TEST-MACHINE-FOLDER.md.
#
# node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
#   bash scripts/prove-test-machine-folder-vm.sh </dev/null
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail "usage: prove-test-machine-folder-vm.sh"

[[ $(id -u) == 0 ]] || fail "run through run-on-node.mjs --sudo"
[[ $(hostname) == qorpera-testvm-node0[12] ]] || fail "only a node's test machine runs this proof"
[[ -f /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "operator test VM and nested KVM required"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
[[ $(lxc remote list --format json | jq -r '.local.Addr') == unix:// ]] || fail "local LXD is not its Unix socket"
lxd_dir=/var/snap/lxd/common/lxd
[[ -S "$lxd_dir/unix.socket" ]] || fail "no LXD socket at $lxd_dir/unix.socket"
(($(df --output=avail -B1 "$lxd_dir" | tail -1) >= 16 * 1024 * 1024 * 1024)) || fail "less than 16 GiB free under $lxd_dir"
# The folder bridge listens on the machines' vsock port, as on a node: another listener would take their mounts.
[[ -z $(ss -H -l --vsock 2>/dev/null | awk '{print $5}' | grep -E '(^|:)5250$') ]] || fail "vsock port 5250 is in use"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
# Keep LXD's project+instance Unix-socket paths below sockaddr_un's limit: a machine's name is 48 characters.
project="qtm-${suffix}"
pool="$project"
builder="qorpera-p4-build-${suffix}"
work=$(mktemp -d /tmp/qorpera-p4.XXXXXXXX)
made_project=0
made_pool=0
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
	# Every instance and image in the claimed project is this run's: the builder, the machine host's VMs, the second VM.
	if ((made_project)); then
		for held in $(lx list --format json | jq -r '.[].name'); do lx delete --force "$held" || status=1; done
		for held in $(lx image list --format json | jq -r '.[].fingerprint'); do lx image delete "$held" || status=1; done
		lxc --force-local project delete "$project" </dev/null || status=1
	fi
	if ((made_pool)); then lxc --force-local storage delete "$pool" </dev/null || status=1; fi
	if [[ -f "$work/evidence.json" ]]; then
		echo 'TEST_MACHINE_FOLDER_EVIDENCE_BEGIN'
		cat "$work/evidence.json"
		echo 'TEST_MACHINE_FOLDER_EVIDENCE_END'
	fi
	# The last thing that runs, with the project and pool gone: the test machine's state before, and what changed (the
	# log's proof that nothing did).
	machine_state >"$work/after"
	awk '{print $1}' /proc/modules | sort >"$work/modules-after"
	echo 'TEST_MACHINE_HOST_DIFF_BEGIN'
	echo '# before: links, nft tables, sysctls, bridge-nf-call-iptables'
	cat "$work/before"
	echo '# after, against before:'
	if diff -u "$work/before" "$work/after"; then echo 'host state unchanged'; else status=1; fi
	local modules_ok=1 gone
	gone=$(comm -23 "$work/modules-before" "$work/modules-after" | tr '\n' ' ')
	if [[ -n $gone ]]; then
		echo "FAIL: a shared-test-VM kernel module disappeared: $gone"
		modules_ok=0
		status=1
	fi
	for module in br_netfilter bridge stp llc tun macvlan macvtap vhost_net nft_meta_bridge nf_conntrack_bridge fuse \
		vsock vhost_vsock vmw_vsock_virtio_transport_common vsock_loopback vmw_vsock_virtio_transport; do
		if grep -qx "$module" "$work/modules-after" && ! grep -qx "$module" "$work/modules-before"; then
			echo "FAIL: shared-test-VM module appeared: $module"
			modules_ok=0
			status=1
		fi
	done
	if ((modules_ok)); then echo "# modules: no module appeared or disappeared ($(wc -l <"$work/modules-before") before)"; fi
	echo 'TEST_MACHINE_HOST_DIFF_END'
	rm -rf -- "$work"
	exit "$status"
}
machine_state >"$work/before"
awk '{print $1}' /proc/modules | sort >"$work/modules-before"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$repo"
node scripts/build-folder-program.mjs --out "$work/qorpera-folder" >"$work/build-record.json"
folder_sha=$(sha256sum "$work/qorpera-folder" | awk '{print $1}')
expected_folder_sha=$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$repo/deploy/folder-service/folder-program-linux-x64.json")
[[ "$folder_sha" == "$expected_folder_sha" ]] || fail "built folder binary differs from the checked-in artifact record"
package="$work/guest"
node scripts/package-machine-guest.mjs --out "$package" --folder-program "$work/qorpera-folder"
helper_sha=$(sha256sum "$package/cloud-machine-guest.mjs" | awk '{print $1}')
[[ $(jq -r '.artifacts[0].file + " " + .artifacts[0].sha256' "$package/manifest.json") == "cloud-machine-guest.mjs $helper_sha" ]] ||
	fail "the guest package's manifest does not lead with its helper"

# Claim fresh names only. Never adopt, stop or delete another proof's resources.
lxc --force-local project create "$project" -c features.images=true -c features.profiles=false \
	-c features.storage.volumes=true </dev/null
made_project=1
lxc --force-local storage create "$pool" dir </dev/null
made_pool=1

# The stand-in image: 6c's guest package on ubuntu:26.04, installed as deploy/machine/build-machine-image.sh installs
# it, without the network that script's apt and downloads need. No profile, so no NIC.
lx init ubuntu:26.04 "$builder" --vm --no-profiles --storage "$pool" -d root,size=10GiB -c limits.cpu=2 \
	-c limits.memory=2GiB -c boot.mode=uefi-secureboot -c boot.autostart=false -c user.qorpera.acceptance=test-machine-folder
if ! lx start "$builder"; then
	lx info --show-log "$builder" || true
	fail "the image builder did not start"
fi
for _attempt in $(seq 1 150); do
	if lx exec "$builder" -- true >/dev/null 2>&1; then break; fi
	sleep 2
done
lx exec "$builder" -- true
[[ -z $(lx exec "$builder" -- ip -br link | awk '$1 != "lo" {print $1}') ]] || fail "the image builder unexpectedly has a NIC"
# With no network cloud-init can wait long for one; the image needs only that it has run.
lx exec "$builder" -- timeout 300 cloud-init status --wait >/dev/null || echo "cloud-init: $(lx exec "$builder" -- cloud-init status 2>&1 | head -1)"
lx exec "$builder" -- install -d -o root -g root -m 0755 /opt/qorpera-machine /opt/qorpera-folder /company
# The test machine's own Node, as the image's /usr/bin/node (the host runs the helper with it).
lxc --force-local --project "$project" file push "$(readlink -f "$(command -v node)")" "$builder/usr/bin/node" \
	--uid 0 --gid 0 --mode 0755 </dev/null
lxc --force-local --project "$project" file push "$package/cloud-machine-guest.mjs" \
	"$builder/opt/qorpera-machine/cloud-machine-guest.mjs" --uid 0 --gid 0 --mode 0444 </dev/null
lxc --force-local --project "$project" file push "$package/qorpera-folder" "$builder/opt/qorpera-folder/qorpera-folder" \
	--uid 0 --gid 0 --mode 0555 </dev/null
for unit in qorpera-machine.slice qorpera-machine-watchdog.service qorpera-machine-watchdog.timer qorpera-machine-folder.service; do
	lxc --force-local --project "$project" file push "$package/$unit" "$builder/etc/systemd/system/$unit" \
		--uid 0 --gid 0 --mode 0644 </dev/null
done
lx exec "$builder" -- env EXPECTED_FOLDER_PROGRAM_SHA256="$folder_sha" bash -euo pipefail -c '
	systemctl daemon-reload
	systemctl enable qorpera-machine-watchdog.timer
	node --version | grep -q "^v2[4-9]\."
	[[ $(sha256sum </opt/qorpera-folder/qorpera-folder | cut -d" " -f1) == "$EXPECTED_FOLDER_PROGRAM_SHA256" ]]
	/opt/qorpera-folder/qorpera-folder --version
	/usr/bin/flock --version >/dev/null
	[[ $(systemctl is-enabled qorpera-machine-folder.service || true) == static ]]
	[[ -d /company && -z $(ls -A /company) ]]
	systemd-analyze verify /etc/systemd/system/qorpera-machine-watchdog.service /etc/systemd/system/qorpera-machine.slice \
		/etc/systemd/system/qorpera-machine-folder.service
	echo "fusermount3: $(command -v fusermount3 || echo none); docker: $(command -v docker || echo none)"
	cloud-init clean --logs --machine-id
	rm -f /etc/ssh/ssh_host_*
	sync
'
lx stop "$builder"
lx publish "$builder" --alias p4-test-machine
lx delete "$builder"
image=$(lx image info p4-test-machine | awk '/^Fingerprint:/ {print $2}')
[[ "$image" =~ ^[0-9a-f]{64}$ ]] || fail "no image fingerprint"
# As build-machine-image.sh pins it: what was installed (this script and the guest package).
bootstrap=$(cat "$0" "$package/manifest.json" | sha256sum | cut -d' ' -f1)
echo "Stand-in test machine image: $project/$image helper=$helper_sha folder=$folder_sha"

node scripts/test-test-machine-folder.mjs --project "$project" --pool "$pool" --image "$image" \
	--bootstrap-sha256 "$bootstrap" --helper-sha256 "$helper_sha" --folder-binary "$work/qorpera-folder" \
	--work "$work" --record "$work/evidence.json" --execute
