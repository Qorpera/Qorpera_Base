# F3 4e: the office image recipe that build-office-image-candidate.sh and build-office-image-production.sh share.
# Sourced, not run. The builder sets repo, recipe, office_id, vm and work, defines fail and lx, and creates the
# stopped build VM (no profile, so no NIC). office_image_boot_and_fetch starts it and fetches everything it installs;
# the builder then puts the pinned folder program at $work/qorpera-folder; office_image_install installs and checks;
# office_image_seal leaves the VM stopped and ready to publish. They set push, deps, installer and probe, and leave
# wanted, measured.json, spec.json, root-toolbox.txt, probe.json, apparmor-denials, fusermount3-*, office-unit,
# folder-unit-files and folder-program in $work for the builder's evidence.

office_image_boot_and_fetch() {
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
# its own archive sources, with private lists: this machine's apt state and sources are neither used nor changed. apt
# reads only its own configuration file: this machine's apt.conf and apt.conf.d, whose hooks (command-not-found's,
# update-notifier's) run as root and write outside $work, stay out. -o options come too late to keep them out.
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
printf '%s\n' 'Dir::Etc::main "/dev/null";' 'Dir::Etc::parts "/dev/null";' >"$apt_root/apt.conf"
export APT_CONFIG="$apt_root/apt.conf"
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
}

office_image_install() {
node scripts/package-company-computer.mjs --out "$push/package" --folder-program "$work/qorpera-folder" >/dev/null
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
# The company folder's units have no [Install]: the helper's socket starts with the office service, and the helper
# starts one mount per computer. None has started.
lx exec "$vm" -- systemctl list-unit-files --no-legend --no-pager 'qorpera-office-folder-*' >"$work/folder-unit-files"
[[ $(awk '{print $1, $2}' "$work/folder-unit-files" | sort | tr '\n' ' ') == "qorpera-office-folder-helper.service static qorpera-office-folder-helper.socket static qorpera-office-folder-mount@.service static " ]] ||
	fail "the company folder's unit files: $(tr '\n' ' ' <"$work/folder-unit-files")"
for unit in qorpera-office-folder-helper.socket qorpera-office-folder-helper.service; do
	[[ $(lx exec "$vm" -- systemctl show "$unit" --property ActiveState,InactiveExitTimestampMonotonic | sort | tr '\n' ' ') == \
		"ActiveState=inactive InactiveExitTimestampMonotonic=0 " ]] || fail "$unit has started"
done
lx exec "$vm" -- sha256sum /opt/qorpera-folder/qorpera-folder >"$work/folder-program"
[[ $(awk '{print $1}' "$work/folder-program") == $(jq -r .sha256 "$repo/deploy/folder-service/folder-program-linux-x64.json") ]] ||
	fail "the installed folder program is not the pinned one"
}

office_image_seal() {
# Seal: nothing of the build stays in the image, and the next boot is a new machine.
lx exec "$vm" -- rm -rf /root/push "$probe"
lx exec "$vm" -- cloud-init clean --logs --machine-id
lx exec "$vm" -- journalctl --rotate
lx exec "$vm" -- journalctl --vacuum-time=1s
lx stop "$vm"
}
