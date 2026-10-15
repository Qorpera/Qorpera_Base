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
echo "cloud-init in the build VM: $(lx exec "$vm" -- cloud-init status --wait 2>&1 | tail -1)"

# Everything the VM installs, fetched here. apt resolves the recipe against the guest's own package database and
# its own archive sources, with private lists: this machine's apt state and sources are neither used nor changed.
cd "$repo"
push="$work/push"
deps="$push/dependencies"
apt_root="$work/apt"
mkdir -p "$deps/debs" "$deps/downloads" "$deps/npm-cache" "$push/probe" "$apt_root/sources" "$apt_root/lists/partial" \
	"$apt_root/state" "$apt_root/cache/archives/partial" "$apt_root/preferences"
cp "$recipe" "$deps/office-image-dependencies.json"
cp deploy/lxd-company-computer-guest/install-office-image-dependencies.sh "$push/"
lx file pull "$vm/var/lib/dpkg/status" "$work/vm-status"
lx file pull "$vm/etc/apt/sources.list.d/ubuntu.sources" "$apt_root/sources/ubuntu.sources"
apt_options=(-q -o Debug::NoLocking=1 -o APT::Sandbox::User=root -o APT::Architecture=amd64 -o APT::Architectures=amd64
	-o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts="$apt_root/sources"
	-o Dir::Etc::preferences=/dev/null -o Dir::Etc::preferencesparts="$apt_root/preferences"
	-o Dir::State="$apt_root/state" -o Dir::State::Lists="$apt_root/lists" -o Dir::State::status="$work/vm-status"
	-o Dir::Cache="$apt_root/cache")
apt-get "${apt_options[@]}" update
mapfile -t packages < <(jq -r '.packages[][]' "$recipe")
apt-get "${apt_options[@]}" -s install --no-install-recommends "${packages[@]}" >"$work/plan"
awk '$1 == "Inst" { v = ($3 ~ /^\[/) ? $4 : $3; sub(/^\(/, "", v); print $2 "=" v }' "$work/plan" >"$work/wanted"
if [[ -s "$work/wanted" ]]; then
	(cd "$deps/debs" && xargs apt-get "${apt_options[@]}" download <"$work/wanted")
fi
echo "apt closure: $(wc -l <"$work/wanted") packages, $(du -sh "$deps/debs" | cut -f1)"

# Each pinned download, checked here and again in the VM.
while IFS=$'\t' read -r url sha; do
	file="$deps/downloads/${url##*/}"
	curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 3 --output "$file" "$url"
	[[ $(sha256sum "$file" | awk '{print $1}') == "$sha" ]] || fail "$url is not its pinned file"
done < <(jq -r '.downloads[] | [.url, .sha256] | @tsv' "$recipe")
# The npm tools, cached by the image's own npm.
mkdir "$work/node"
tar --extract --xz --file "$deps/downloads/$(jq -r '.downloads[] | select(.name == "node") | .url | sub(".*/"; "")' "$recipe")" \
	--directory "$work/node" --strip-components 1 --no-same-owner
mapfile -t tools < <(jq -r '.npm[] | "\(.name)@\(.version)"' "$recipe")
HOME="$work" PATH="$work/node/bin:$PATH" npm_config_update_notifier=false npm install --global --prefix "$work/npm-prefix" \
	--cache "$deps/npm-cache" --ignore-scripts --no-fund --no-audit "${tools[@]}"

# The office package (INSTALLATION.md) and the toolbox probe.
node scripts/package-company-computer.mjs --out "$push/package" >/dev/null
node --input-type=module -e '
import { build } from "esbuild";
await build({ absWorkingDir: process.argv[1], entryPoints: ["packages/runtime/test/fixtures/company-computer-linux-toolbox-probe.ts"],
	outfile: process.argv[2], bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
' "$repo" "$push/probe/company-computer-linux-toolbox-probe.mjs"
lx file push -r "$push" "$vm/root/"
lx exec "$vm" -- chown -R root:root /root/push
lx exec "$vm" -- chmod -R go-w /root/push

# In the VM: the recipe, then the office package with the measured dependencies as its reviewed pins.
lx exec "$vm" -- bash /root/push/install-office-image-dependencies.sh /root/push/dependencies | tee "$work/root-toolbox.txt"
lx exec "$vm" -- find /root/push/package -type d -exec chmod 0755 {} +
lx exec "$vm" -- find /root/push/package -type f -exec chmod 0444 {} +
installer=/root/push/package/qorpera-office-image-install.cjs
lx exec "$vm" -- /usr/bin/node "$installer" --measure-dependencies >"$work/measured.json"
jq -n --slurpfile measured "$work/measured.json" --argjson id "$office_id" \
	--arg manifest "$(sha256sum "$push/package/manifest.json" | awk '{print $1}')" \
	'{schema: "qorpera.office-image-installation/v1", packageRoot: "/root/push/package", packageManifestSha256: $manifest,
	uid: $id, gid: $id, architecture: "x64", dependencies: $measured[0]}' >"$work/spec.json"
lx file push --uid 0 --gid 0 --mode 0444 "$work/spec.json" "$vm/root/push/spec.json"
lx exec "$vm" -- /usr/bin/node "$installer" --check --spec /root/push/spec.json
lx exec "$vm" -- /usr/bin/node "$installer" --apply --spec /root/push/spec.json

# The toolbox from a computer's shell: the image's shell host as the office account, under every confinement and
# limit key of the installed office unit (the unit itself needs a company's boot credentials to start).
probe=/srv/qorpera-toolbox-probe
lx exec "$vm" -- install -d -o root -g root -m 0755 "$probe"
for directory in workbench desktop screens profiles runtime; do
	lx exec "$vm" -- install -d -o qorpera-office -g qorpera-office -m 0700 "$probe/$directory"
done
lx exec "$vm" -- install -o root -g root -m 0444 /root/push/probe/company-computer-linux-toolbox-probe.mjs \
	/root/push/dependencies/office-image-dependencies.json "$probe/"
boot=$(lx exec "$vm" -- cat /proc/sys/kernel/random/boot_id | tr -d '\n-')
[[ $boot =~ ^[0-9a-f]{32}$ ]] || fail "no boot id in the VM"
properties=()
while IFS= read -r line; do
	properties+=(--property "${line//"%b"/$boot}")
done < <(lx exec "$vm" -- cat /etc/systemd/system/qorpera-company-computer.service |
	grep -E '^(User|Group|WorkingDirectory|Environment|KillMode|UMask|LimitCORE|PrivateTmp|PrivateDevices|ProtectSystem|ProtectHome|ProtectProc|ProcSubset|ProtectHostname|ProtectClock|ProtectKernelTunables|ProtectKernelLogs|ProtectKernelModules|ProtectControlGroups|NoNewPrivileges|CapabilityBoundingSet|AmbientCapabilities|RestrictNamespaces|RestrictAddressFamilies|RestrictSUIDSGID|LockPersonality|MemoryMax|MemorySwapMax|TasksMax|CPUQuota|InaccessiblePaths)=')
((${#properties[@]} == 62)) || fail "the office unit's confinement keys changed: ${properties[*]}"
since=$(lx exec "$vm" -- date +%s)
probe_status=0
lx exec "$vm" -- systemd-run --quiet --wait --pipe --collect --unit qorpera-toolbox-probe "${properties[@]}" \
	--property "ReadWritePaths=$probe" --property RuntimeMaxSec=900 \
	/usr/bin/node "$probe/company-computer-linux-toolbox-probe.mjs" "$probe" "$probe/office-image-dependencies.json" \
	>"$work/probe.json" || probe_status=$?
# AppArmor's denials while it ran go into the evidence. A file_inherit denial means a probed command lost a descriptor
# on exec, so the shell host may have read nothing from it although it exited 0.
lx exec "$vm" -- journalctl -o cat --no-pager --since "@$since" | { grep 'apparmor="DENIED"' || true; } |
	sort -u >"$work/apparmor-denials"
((probe_status == 0)) || fail "toolbox probe exited $probe_status; AppArmor denials: $(cat "$work/apparmor-denials")"
jq -e '.result == "passed" and .uid == '"$office_id" "$work/probe.json" >/dev/null || fail "toolbox probe: $(cat "$work/probe.json")"
! grep -q 'operation="file_inherit"' "$work/apparmor-denials" ||
	fail "AppArmor took a descriptor from a probed command: $(cat "$work/apparmor-denials")"
# fusermount3 printed nothing from a computer's shell in an earlier candidate. Evidence only, as root and outside any
# sandbox: the VM's kernel, fusermount3's AppArmor mode, and its version through Node's stdio (UNIX socketpairs, as the
# shell host's) and through an anonymous pipe, with AppArmor's denials meanwhile.
since=$(lx exec "$vm" -- date +%s)
lx exec "$vm" -- /usr/bin/node -e '
const { spawnSync } = require("node:child_process");
const run = (file, args) => {
	const r = spawnSync(file, args, { encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};
const pipe = run("bash", ["-c", "fusermount3 --version 2>&1 | cat"]);
console.log(JSON.stringify({ socketpair: run("fusermount3", ["--version"]), pipe }));
' >"$work/fusermount3-stdio.json"
lx exec "$vm" -- sh -c 'uname -r; grep "^fusermount3 " /sys/kernel/security/apparmor/profiles || echo none' \
	>"$work/fusermount3-profile"
lx exec "$vm" -- journalctl -o cat --no-pager --since "@$since" | { grep 'apparmor="DENIED"' || true; } |
	sort -u >"$work/fusermount3-denials"

# After the whole build the office service is still disabled and has never started. Its credentials exist only once
# the node's preparation writes them for a boot; the node's activation starts it (preparation, then service-start).
lx exec "$vm" -- systemctl show qorpera-company-computer.service --property LoadState,UnitFileState,ActiveState \
	--property InactiveExitTimestampMonotonic,ExecMainStartTimestampMonotonic >"$work/office-unit"
[[ $(sort "$work/office-unit" | tr '\n' ' ') == "ActiveState=inactive ExecMainStartTimestampMonotonic=0 InactiveExitTimestampMonotonic=0 LoadState=loaded UnitFileState=disabled " ]] ||
	fail "the office unit is not installed, disabled and never started: $(tr '\n' ' ' <"$work/office-unit")"

# Seal: nothing of the build stays in the image, and the next boot is a new machine.
lx exec "$vm" -- rm -rf /root/push "$probe"
lx exec "$vm" -- cloud-init clean --logs --machine-id
lx exec "$vm" -- journalctl --rotate
lx exec "$vm" -- journalctl --vacuum-time=1s
lx stop "$vm"
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
	network: "none"}' >"$work/evidence.json"
echo "Office image candidate $candidate from base $base${staged:+, staged at $staged/img.tar.gz}"
