#!/usr/bin/env bash
# The machine desktop (deploy/machine/README.md, "The desktop"), proven on a node's test machine: builds the real
# company machine image with deploy/machine/build-machine-image.sh in a nested LXD project, network and pool this run
# claims, boots a machine from it, and drives its desktop the way an agent does with machine_run: start, open a page
# in Chromium, type, click, screenshot, stop. It also measures how busy an idle desktop with Chromium keeps the machine
# (the idle rule). Everything it made is deleted at the end. The screenshot is printed as base64 between markers.
#
# node scripts/run-on-node.mjs --machine node02 --sudo -- bash scripts/prove-machine-desktop-vm.sh </dev/null
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail "usage: prove-machine-desktop-vm.sh"
[[ $(id -u) == 0 ]] || fail "run through run-on-node.mjs --sudo"
[[ $(hostname) == qorpera-testvm-node0[12] ]] || fail "only a node's test machine runs this proof"
[[ -f /etc/qorpera-test-machine-versions && -c /dev/kvm ]] || fail "operator test VM and nested KVM required"
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
loaded_br_netfilter=0
forward_rules=0
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
	if ((forward_rules)); then
		iptables -D DOCKER-USER -i "$network" -j ACCEPT || status=1
		iptables -D DOCKER-USER -o "$network" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT || status=1
	fi
	# The bridge filter this run loaded goes again, unless something else came to use it meanwhile.
	if ((loaded_br_netfilter)) && [[ $(awk '$1 == "br_netfilter" {print $3}' /proc/modules) == 0 ]]; then
		modprobe -r br_netfilter || status=1
	fi
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

# The build script filters the builder's NIC (MAC, IPv4 and IPv6), and LXD's IPv6 filter needs bridge netfilter,
# which nodes load at bootstrap and the shared test machine does not: load it for this run only.
if ! grep -q '^br_netfilter ' /proc/modules; then
	modprobe br_netfilter
	loaded_br_netfilter=1
fi
# Fresh names only; never adopt or touch another run's resources. Both projects keep their own image store, so the
# build script exports the image from the build space and imports it into the machines project, as on a node whose
# build space has its own store.
lxc --force-local storage create "$pool" dir </dev/null
made+=(pool)
lxc --force-local network create "$network" ipv4.address=auto ipv4.nat=true ipv6.address=none </dev/null
made+=(network)
# Docker on the test machine drops forwarded traffic (FORWARD policy DROP): let this run's bridge out, and back.
iptables -I DOCKER-USER -i "$network" -j ACCEPT
iptables -I DOCKER-USER -o "$network" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
forward_rules=1
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
