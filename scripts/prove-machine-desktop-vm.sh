#!/usr/bin/env bash
# The machine desktop (deploy/machine/README.md, "The desktop"), proven in a throwaway VM with nested LXD: builds the
# real company machine image with deploy/machine/build-machine-image.sh in a nested LXD project, network and pool this
# run claims, boots a machine from it, and drives its desktop the way an agent does with machine_run: start, open a page
# in Chromium, type, click, screenshot, stop. It also measures how busy an idle desktop with Chromium keeps the machine
# (the idle rule). Everything it made is deleted at the end. The screenshot is printed as base64 between markers.
#
# It changes nothing on its host but what it claims, so the host must already let a nested bridge reach the internet
# with the build script's NIC filters: br_netfilter loaded (LXD's IPv6 filter needs it; nodes load it at bootstrap) and
# no FORWARD drop. It refuses otherwise. The shared test machines are not such a host (Docker drops forwarding there,
# and br_netfilter is not loaded): run it as root in a throwaway VM made for it. A node's real image build
# (build-machine-image.sh) runs the same desktop checks on the builder itself.
#
# QORPERA_DESKTOP_PROOF_HOST=yes bash scripts/prove-machine-desktop-vm.sh   (as root, in that VM)
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail "usage: prove-machine-desktop-vm.sh"
[[ $(id -u) == 0 ]] || fail "run as root"
[[ ${QORPERA_DESKTOP_PROOF_HOST:-} == yes ]] || fail "run only in a throwaway VM made for this proof (QORPERA_DESKTOP_PROOF_HOST=yes)"
[[ $(hostname) != qorpera-testvm-node0[12] ]] || fail "the shared test machines are not a host for this proof"
[[ -c /dev/kvm ]] || fail "nested KVM required"
grep -q '^br_netfilter ' /proc/modules || fail "br_netfilter is not loaded: this proof does not load it on its host"
[[ $(iptables -S FORWARD 2>/dev/null | head -1) != "-P FORWARD DROP" ]] || fail "the host drops forwarded traffic"
[[ $(lxc remote get-default) == local ]] || fail "LXD must target its local Unix socket"
lxd_dir=/var/snap/lxd/common/lxd
(($(df --output=avail -B1 "$lxd_dir" | tail -1) >= 30 * 1024 * 1024 * 1024)) || fail "less than 30 GiB free under $lxd_dir"

suffix=$(cut -c 1-8 /proc/sys/kernel/random/uuid)
build="qmdb-$suffix"
machines="qmdm-$suffix"
pool="qmd-$suffix"
network="qmd$suffix"
vm="qmd-vm-$suffix"
work=$(mktemp -d /tmp/qorpera-machine-desktop.XXXXXXXX)
made=()
cleanup() {
	local status=$?
	trap - EXIT
	set +e
	for project in "$machines" "$build"; do
		[[ " ${made[*]} " == *" project:$project "* ]] || continue
		for held in $(lxc --force-local --project "$project" list --format json </dev/null | jq -r '.[].name'); do
			lxc --force-local --project "$project" delete --force "$held" </dev/null || status=1
		done
		for held in $(lxc --force-local --project "$project" image list --format json </dev/null | jq -r '.[].fingerprint'); do
			lxc --force-local --project "$project" image delete "$held" </dev/null || status=1
		done
		lxc --force-local project delete "$project" </dev/null || status=1
	done
	[[ " ${made[*]} " != *" network "* ]] || lxc --force-local network delete "$network" </dev/null || status=1
	[[ " ${made[*]} " != *" pool "* ]] || lxc --force-local storage delete "$pool" </dev/null || status=1
	rm -rf -- "$work"
	echo "cleanup done (status $status)"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$repo"
node scripts/build-folder-program.mjs --out "$work/qorpera-folder" >"$work/build-record.json"
node scripts/package-machine-guest.mjs --out "$work/guest" --folder-program "$work/qorpera-folder" >/dev/null
node_version=$(jq -er .node.version deploy/coding-machine/coding-image.json)
node_sha256=$(jq -er .node.sha256 deploy/coding-machine/coding-image.json)

# Fresh names only; never adopt or touch another run's resources. Both projects keep their own image store, so the
# build script exports the image from the build space and imports it into the machines project, as on a node whose
# build space has its own store.
lxc --force-local storage create "$pool" dir </dev/null
made+=(pool)
lxc --force-local network create "$network" ipv4.address=auto ipv4.nat=true ipv6.address=none </dev/null
made+=(network)
for project in "$build" "$machines"; do
	lxc --force-local project create "$project" -c features.images=true -c features.profiles=false \
		-c features.storage.volumes=true </dev/null
	made+=("project:$project")
done

started=$(date +%s)
bash deploy/machine/build-machine-image.sh "$work/guest" "$node_version" "$node_sha256" "$build" "$network" "$pool" \
	"$machines" >"$work/image-build.json"
echo "image built in $(($(date +%s) - started)) s: $(jq -c . "$work/image-build.json")"
fingerprint=$(jq -er .imageFingerprint "$work/image-build.json")

# A machine from that image, as small as a task machine gets; no NIC (the desktop needs none).
lx() { lxc --force-local --project "$machines" "$@" </dev/null; }
lx init "$fingerprint" "$vm" --vm --no-profiles --storage "$pool" -d root,size=12GiB -c limits.cpu=2 \
	-c limits.memory=4GiB -c boot.mode=uefi-secureboot -c boot.autostart=false
lx start "$vm"
for _ in $(seq 1 150); do lx exec "$vm" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$vm" -- systemctl is-system-running --wait >/dev/null || true
run() { echo "\$ $*"; lx exec "$vm" -- bash -lc "$*"; }
# No executor renews this machine's lease here, so its watchdog would stop everything in the machine's slice (the
# desktop with it) within 10 s, as it should for a machine its executor lost. A real machine's executor keeps the lease.
lx exec "$vm" -- systemctl stop qorpera-machine-watchdog.timer qorpera-machine-watchdog.service

run 'desktop status'
run 'desktop start'
run 'desktop open "data:text/html,<title>Qorpera desktop proof</title><body style=\"font:48px sans-serif;padding:60px\"><h1>Qorpera machine desktop</h1><textarea style=\"font:32px sans-serif;width:90%;height:400px\"></textarea></body>"'
lx exec "$vm" -- bash -lc 'for _ in $(seq 1 60); do desktop windows | grep -q "Qorpera desktop proof" && exit 0; sleep 0.5; done; exit 1' ||
	fail "the page's window did not show"
run 'desktop windows'
run 'desktop click 800 760 && desktop type "typed by an agent" && desktop key Return && desktop type "on the machine desktop"'
sleep 1
run 'desktop shot /root/proof.png'
lx file pull "$vm/root/proof.png" "$work/proof.png"
[[ $(file -b "$work/proof.png") == *"1600 x 1000"* ]] || fail "the screenshot is not 1600x1000: $(file -b "$work/proof.png")"
echo "screenshot sha256 $(sha256sum "$work/proof.png" | cut -d' ' -f1), $(stat -c %s "$work/proof.png") bytes"

# How busy the machine is with the desktop and Chromium open and nothing happening: the idle rule's measure is user,
# nice, system, irq and softirq processor time over 30 s, against 5% of one core.
busy=$(lx exec "$vm" -- bash -c '
	sample() { awk "/^cpu / {print \$2+\$3+\$4+\$7+\$8}" /proc/stat; }
	a=$(sample); sleep 30; b=$(sample)
	echo $(( (b - a) * 1000 / (30 * $(getconf CLK_TCK)) ))')
echo "idle desktop with Chromium: $((busy / 10)).$((busy % 10))% of one core over 30 s (the idle rule's limit is 5%)"

run 'desktop stop'
lx exec "$vm" -- bash -c '[[ -z $(pgrep -u desktop || true) ]]' || fail "programs of the desktop outlived it"
run 'desktop status'
echo 'MACHINE_DESKTOP_SCREENSHOT_BEGIN'
base64 -w 0 "$work/proof.png"
echo
echo 'MACHINE_DESKTOP_SCREENSHOT_END'
echo 'PROOF PASSED'
