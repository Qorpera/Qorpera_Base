#!/bin/bash
# Build the reviewed company machine image on an LXD node (run as root).
#
#   build-machine-image.sh <guest-package-dir> <node-version> <node-linux-x64-tar.xz-sha256> \
#     <build-project> <build-network> <storage-pool> [machines-project]
#
# One image for every machine: Ubuntu 26.04 with rootful Docker Engine and
# Compose, Node, Python 3, Git and build tools, the toolbox every Qorpera
# machine has (deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md: npm, npx,
# tsc, tsx, pip, uv, ripgrep, fd, jq, sqlite3, curl, zip, unzip, LibreOffice),
# fuse3 and the company folder's program with its unit (F3 step 6c: it mounts
# the folder at /company once the host hands the machine a view), the machine
# guest helper and its watchdog (scripts/package-machine-guest.mjs), and apt's
# and fwupd's self-update units masked. Since 9 Nov 2026 also a desktop for work
# that needs a screen: TigerVNC's X server and a plain XFCE session on display :1
# as the account `desktop`, started only by the agents' `desktop start`, with
# Chromium (the coding image's pinned build) and xdotool behind the `desktop`
# command (README, "The desktop"), and xsel with save_coding_value's clipboard
# helper (20260930705000), which seals a key copied on the desktop for the vault
# and clears the clipboard, and machine_screen's screen helper (20260930708000),
# with which an agent acts on the desktop and sees it in one tool call. Since 12 Nov 2026 every machine also has
# compressed memory from its boot on (zram as large as its memory) and a guard that ends one program when memory and
# that reserve are both nearly gone (earlyoom, from apt), so a machine at the edge keeps answering (README, "Memory").
# Since 12 Nov 2026 the desktop also has the look the office desktops had: one dark dock with the browser, the files and
# a terminal under Qorpera's own icons, a backdrop with the agent's figure for each hour of the day, tidy windows. The
# pictures are in the image; the session writes the look into the desktop's account at every start (README, "The
# desktop's look").
# Since 10 Nov 2026 a desktop is something an agent
# asks for (machine_start with desktop true; a smaller machine refuses `desktop
# start`), `desktop start` opens chosen company files and folders on it, pages
# get 3D drawing, and Playwright with its Chromium, ffmpeg and a `chromium` that
# runs from root's shell are installed, since that is how agents look at pages
# without a screen. An agent that has a Dockerfile builds
# and runs it inside its machine; images are not made from Dockerfiles.
#
# The builder runs in the node's declared image build space (the observer
# policy's buildSpace: its project and its only network) as a build machine:
# no profiles, its own root disk, the isolation NIC, never autostarting, and
# the builder marker. The observer counts it against that space, so the node
# stays ready while it builds; anywhere else it would be an unregistered
# instance that makes the node unavailable (RUNTIME-HOST-INVENTORY.md). It
# needs 4 CPUs and 8 GiB of the space, so build when the space is empty. A
# build space that shares the default project's images (node 2's does) publishes
# straight into the store the machines project uses; one with its own store
# has the image exported and imported there. The script deletes the builder on
# every exit path.
set -euo pipefail
PACKAGE=${1:?guest package directory}
NODE_VERSION=${2:?Node.js version, for example 24.9.0}
NODE_SHA256=${3:?sha-256 of node-vNODE_VERSION-linux-x64.tar.xz from nodejs.org SHASUMS256.txt}
PROJECT=${4:?the build space project, for example qorpera-build}
NETWORK=${5:?the build space network, for example qorpera0}
POOL=${6:?the storage pool for the builder root, for example qorpera-vm}
MACHINES=${7:-machines}
# The toolbox's own pins beside apt's: uv and mise from their release pages, tsc and tsx from npm.
UV_VERSION=0.13.1
UV_SHA256=eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220
# mise-vMISE_VERSION-linux-x64 in the release's SHASUMS256.txt.
MISE_VERSION=2026.10.10
MISE_SHA256=7d79972e15549b286dcf9e25ef8c4fcef3d9fd7c0332d11cdfbc7d2842c418be
TYPESCRIPT_VERSION=7.0.2
TSX_VERSION=4.23.15
# Playwright, from npm, with the Chromium builds that version drives (its own download, from the CDN the Chromium
# below comes from): what agents script pages with, so no machine installs it again.
PLAYWRIGHT_VERSION=1.65.0
# Chromium for the desktop: the coding image's pin (deploy/coding-machine/coding-image.json), Chrome for Testing.
CHROMIUM_VERSION=151.0.7922.34
CHROMIUM_URL=https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-linux64.zip
CHROMIUM_SHA256=ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8
# The company folder's program: the build deploy/folder-service/folder-program-linux-x64.json records
# (scripts/folder-program-artifact.test.mjs keeps this pin on that record).
EXPECTED_FOLDER_PROGRAM_SHA256="ec3b52e473f3bd27b52da8aa708fb28dd1e811d166d6aed8b27f7f574c1eb056"
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
# Only the build record goes to stdout (> image-build.json); the builder's own output goes to stderr.
exec 3>&1 1>&2
[[ $NODE_VERSION =~ ^2[4-9]\.[0-9]+\.[0-9]+$ ]] || { echo "invalid Node.js version" >&2; exit 1; }
[[ $NODE_SHA256 =~ ^[0-9a-f]{64}$ ]] || { echo "invalid Node.js sha-256" >&2; exit 1; }
for file in cloud-machine-guest.mjs cloud-machine-coding-value.mjs cloud-machine-screen.mjs qorpera-machine.slice qorpera-machine-watchdog.service qorpera-machine-watchdog.timer \
	qorpera-machine-folder.service qorpera-machine-desktop.service qorpera-machine-memory.service \
	qorpera-machine-memory-guard.service desktop-session desktop qorpera-chromium.apparmor \
	desktop-selftest.html qorpera-chromium-policy.json chromium qorpera-machine-profile.sh playwright-check.cjs \
	machine-memory lxd-agent-memory.conf qorpera-machine-desktop-dock.path qorpera-machine-desktop-dock.service \
	desktop-look desktop-dock-open desktop-files qorpera-machine-desktop.tmpfiles desktop-art.tar qorpera-folder manifest.json; do
	[[ -f $PACKAGE/$file ]] || { echo "package misses $file" >&2; exit 1; }
done
[[ $(sha256sum <"$PACKAGE/qorpera-folder" | cut -d' ' -f1) == "$EXPECTED_FOLDER_PROGRAM_SHA256" ]] ||
	{ echo "the package's qorpera-folder is not the pinned folder program" >&2; exit 1; }
# The package's own checksums, before anything is installed.
python3 - "$PACKAGE" <<'PY'
import hashlib, json, sys, pathlib
root = pathlib.Path(sys.argv[1])
for artifact in json.loads((root / "manifest.json").read_text())["artifacts"]:
    if hashlib.sha256((root / artifact["file"]).read_bytes()).hexdigest() != artifact["sha256"]:
        sys.exit(f"checksum differs: {artifact['file']}")
PY

STAMP=$(date -u +%Y%m%d%H%M%S)
BUILDER="qorpera-machine-build-$STAMP-$$"
ALIAS="qorpera-machine-$STAMP"
lx() { lxc --project "$PROJECT" "$@"; }
# A project without its own images uses the default project's store.
store() { if [[ $(lxc project get "$1" features.images) == true ]]; then echo "$1"; else echo default; fi; }
[[ $PROJECT != "$MACHINES" && $PROJECT != default ]] || { echo "the builder must run in the node's build space, not in $PROJECT" >&2; exit 1; }
lxc project show "$MACHINES" >/dev/null || { echo "no project $MACHINES: create it first (README)" >&2; exit 1; }
IN_SPACE=$(lx list -f csv -c n)
[[ -z $IN_SPACE ]] || { echo "the build space $PROJECT is in use: build when it is empty" >&2; exit 1; }
EXPORT=
cleanup() {
	lx delete --force "$BUILDER" >/dev/null 2>&1 || true
	[[ -z $EXPORT ]] || rm -rf -- "$EXPORT"
}
trap cleanup EXIT

# Made whole in one request, so the observer never sees a half-made builder. Its stdin is closed: lxc init reads
# instance configuration from a stdin that is not a terminal, and would wait for one left open. Its root is 10 GiB, the smallest machine
# disk: a machine's root can never be smaller than its image.
lx init ubuntu:26.04 "$BUILDER" --vm --no-profiles --storage "$POOL" -d root,size=10GiB -n "$NETWORK" \
	-d eth0,security.mac_filtering=true -d eth0,security.ipv4_filtering=true -d eth0,security.ipv6_filtering=true \
	-d eth0,security.port_isolation=true -c limits.cpu=4 -c limits.memory=8GiB -c boot.mode=uefi-secureboot \
	-c boot.autostart=false -c user.qorpera.image_builder=true -c user.qorpera.purpose=machine-image </dev/null
lx start "$BUILDER"
for _ in $(seq 1 90); do lx exec "$BUILDER" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$BUILDER" -- cloud-init status --wait >/dev/null
lx exec "$BUILDER" -- env NODE_VERSION="$NODE_VERSION" NODE_SHA256="$NODE_SHA256" UV_VERSION="$UV_VERSION" \
	UV_SHA256="$UV_SHA256" MISE_VERSION="$MISE_VERSION" MISE_SHA256="$MISE_SHA256" TYPESCRIPT_VERSION="$TYPESCRIPT_VERSION" \
	TSX_VERSION="$TSX_VERSION" CHROMIUM_URL="$CHROMIUM_URL" CHROMIUM_SHA256="$CHROMIUM_SHA256" \
	PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" bash -euo pipefail -c '
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	apt-get install -y --no-install-recommends ca-certificates curl git jq unzip zip xz-utils make pkg-config \
		build-essential python3 python3-venv python3-pip docker.io docker-compose-v2 docker-buildx \
		ripgrep fd-find sqlite3 libreoffice-nogui fuse3 file ffmpeg \
		tigervnc-standalone-server xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal xfconf thunar dbus-x11 \
		adwaita-icon-theme \
		x11-utils x11-xserver-utils xdotool wmctrl scrot xsel apparmor earlyoom \
		libnss3 libnspr4 libasound2t64 libgbm1 libcups2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
		libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 libx11-6 libxcb1 libpango-1.0-0 \
		libcairo2 libdbus-1-3 libexpat1 libglib2.0-0t64 libdrm2 libudev1 fonts-dejavu-core fonts-liberation \
		fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
	# Debian names fd fdfind; the toolbox calls it fd.
	ln -sf /usr/bin/fdfind /usr/local/bin/fd
	curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
	echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
	tar -xJf /tmp/node.tar.xz -C /opt
	ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node
	for tool in node npm npx corepack; do ln -sf "/opt/node/bin/$tool" "/usr/local/bin/$tool"; done
	ln -sf /opt/node/bin/node /usr/bin/node
	rm -f /tmp/node.tar.xz
	# No install scripts: tsc and tsx need none (esbuild, under tsx, ships its binary as a platform package).
	npm install -g --ignore-scripts --no-fund --no-audit "typescript@${TYPESCRIPT_VERSION}" "tsx@${TSX_VERSION}"
	for tool in tsc tsx; do ln -sf "/opt/node/bin/$tool" "/usr/local/bin/$tool"; done
	# Playwright for every folder and account: the package beside tsc, its browsers in one shared folder (the
	# profile file the package brings names both). No install script: the browsers are fetched by its own command.
	npm install -g --ignore-scripts --no-fund --no-audit "playwright@${PLAYWRIGHT_VERSION}"
	PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright /opt/node/bin/playwright install chromium
	chmod -R a+rX /opt/ms-playwright
	ln -sf /opt/node/bin/playwright /usr/local/bin/playwright
	curl -fsSLo /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz"
	echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c -
	tar -xzf /tmp/uv.tar.gz -C /tmp
	install -o root -g root -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/
	rm -rf /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu
	# mise installs any other language or version in the home of the user who asks (~/.local/share/mise), without root.
	curl -fsSLo /tmp/mise "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64"
	echo "${MISE_SHA256}  /tmp/mise" | sha256sum -c -
	install -o root -g root -m 0755 /tmp/mise /usr/local/bin/mise
	rm -f /tmp/mise
	systemctl enable docker.service containerd.service
	# The desktop browser: Chrome for Testing, pinned like the coding image one.
	curl -fsSLo /tmp/chromium.zip "$CHROMIUM_URL"
	echo "${CHROMIUM_SHA256}  /tmp/chromium.zip" | sha256sum -c -
	unzip -q /tmp/chromium.zip -d /tmp/chromium
	mv /tmp/chromium/chrome-linux64 /usr/lib/qorpera-chromium
	rm -rf /tmp/chromium.zip /tmp/chromium
	# The desktop runs as its own account, so Chromium keeps its sandbox; root (the agents commands) drives it.
	useradd --create-home --shell /bin/bash --user-group desktop
	# Its look (the dock, the backdrop, the windows) is written into the account by its session at every start
	# (desktop-look, which the package brings), from the pictures unpacked here; nothing of it is kept in the account.
	install -d -o root -g root -m 0755 /opt/qorpera-machine /opt/qorpera-folder /usr/share/qorpera-desktop
	# Where a machine names the figure of the agent it belongs to (one word in desktop-figure; no file: the neutral
	# backdrop).
	install -d -o root -g root -m 0755 /etc/qorpera-machine
	# Where Chrome for Testing reads its managed policy (the package brings the file).
	install -d -o root -g root -m 0755 /etc/opt/chrome_for_testing/policies/managed
	# Where the company folder is mounted; until then an empty folder.
	install -d -o root -g root -m 0755 /company
	# Where the folder program keeps its caches, on the machine disk: root only (the program makes none of it).
	install -d -o root -g root -m 0700 /var/lib/qorpera-folder /var/lib/qorpera-folder/cache \
		/var/lib/qorpera-folder/cache/machine
	# No self-update: the image stays what was reviewed; agents update what they need inside their own machine.
	systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
	# Firmware metadata neither: fwupd-refresh.timer runs fwupdmgr refresh, which starts fwupd.service over D-Bus (its bus
	# name hands activation to systemd). That work counts like any other, so a quiet machine looked busy and never slept
	# (C8 MA-5b). A masked unit refuses every start, the bus activation too.
	systemctl mask fwupd-refresh.timer fwupd-refresh.service fwupd.service
	# The guard runs earlyoom from a unit of its own, with limits worked out for the machine (machine-memory guard): the
	# package unit, which apt started with its own, is off for good.
	systemctl disable --now earlyoom.service
	systemctl mask earlyoom.service
	# Where the LXD agent gets its protection from (the package brings the file).
	install -d -o root -g root -m 0755 /etc/systemd/system/lxd-agent.service.d
'
lx file push "$PACKAGE/cloud-machine-guest.mjs" "$BUILDER/opt/qorpera-machine/cloud-machine-guest.mjs" --uid 0 --gid 0 --mode 0444
lx file push "$PACKAGE/cloud-machine-coding-value.mjs" "$BUILDER/opt/qorpera-machine/cloud-machine-coding-value.mjs" --uid 0 --gid 0 --mode 0444
lx file push "$PACKAGE/cloud-machine-screen.mjs" "$BUILDER/opt/qorpera-machine/cloud-machine-screen.mjs" --uid 0 --gid 0 --mode 0444
lx file push "$PACKAGE/qorpera-folder" "$BUILDER/opt/qorpera-folder/qorpera-folder" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/desktop-session" "$BUILDER/opt/qorpera-machine/desktop-session" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/desktop" "$BUILDER/usr/local/bin/desktop" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/qorpera-chromium.apparmor" "$BUILDER/etc/apparmor.d/qorpera-chromium" --uid 0 --gid 0 --mode 0644
lx file push "$PACKAGE/desktop-selftest.html" "$BUILDER/opt/qorpera-machine/desktop-selftest.html" --uid 0 --gid 0 --mode 0444
lx file push "$PACKAGE/playwright-check.cjs" "$BUILDER/opt/qorpera-machine/playwright-check.cjs" --uid 0 --gid 0 --mode 0444
lx file push "$PACKAGE/chromium" "$BUILDER/usr/local/bin/chromium" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/qorpera-machine-profile.sh" "$BUILDER/etc/profile.d/qorpera-machine.sh" --uid 0 --gid 0 --mode 0644
lx file push "$PACKAGE/qorpera-chromium-policy.json" "$BUILDER/etc/opt/chrome_for_testing/policies/managed/qorpera.json" --uid 0 --gid 0 --mode 0644
lx file push "$PACKAGE/machine-memory" "$BUILDER/opt/qorpera-machine/machine-memory" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/lxd-agent-memory.conf" "$BUILDER/etc/systemd/system/lxd-agent.service.d/qorpera-memory.conf" --uid 0 --gid 0 --mode 0644
lx file push "$PACKAGE/desktop-look" "$BUILDER/opt/qorpera-machine/desktop-look" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/desktop-dock-open" "$BUILDER/opt/qorpera-machine/desktop-dock-open" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/desktop-files" "$BUILDER/opt/qorpera-machine/desktop-files" --uid 0 --gid 0 --mode 0555
lx file push "$PACKAGE/qorpera-machine-desktop.tmpfiles" "$BUILDER/etc/tmpfiles.d/qorpera-machine-desktop.conf" --uid 0 --gid 0 --mode 0644
# The desktop pictures, unpacked by the checks below.
lx file push "$PACKAGE/desktop-art.tar" "$BUILDER/tmp/desktop-art.tar" --uid 0 --gid 0 --mode 0644
for unit in qorpera-machine.slice qorpera-machine-watchdog.service qorpera-machine-watchdog.timer qorpera-machine-folder.service \
	qorpera-machine-desktop.service qorpera-machine-memory.service qorpera-machine-memory-guard.service \
	qorpera-machine-desktop-dock.path qorpera-machine-desktop-dock.service; do
	lx file push "$PACKAGE/$unit" "$BUILDER/etc/systemd/system/$unit" --uid 0 --gid 0 --mode 0644
done
lx exec "$BUILDER" -- env EXPECTED_FOLDER_PROGRAM_SHA256="$EXPECTED_FOLDER_PROGRAM_SHA256" \
	PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" bash -euo pipefail -c '
	systemctl daemon-reload
	systemctl enable qorpera-machine-watchdog.timer qorpera-machine-memory.service qorpera-machine-memory-guard.service
	# The desktop look (12 Nov 2026): the pictures, root-owned and read-only for everyone else; the unit that hears a
	# press on the dock, from every boot on; and the folder such a press asks in, as a boot makes it.
	tar -xf /tmp/desktop-art.tar -C /usr/share/qorpera-desktop --no-same-owner
	rm /tmp/desktop-art.tar
	chown -R root:root /usr/share/qorpera-desktop
	chmod -R u=rwX,go=rX /usr/share/qorpera-desktop
	systemctl enable qorpera-machine-desktop-dock.path
	systemd-tmpfiles --create /etc/tmpfiles.d/qorpera-machine-desktop.conf
	systemctl start qorpera-machine-desktop-dock.path
	# Checks the reviewed image must pass.
	# The desktop look. Every picture the look names is there and is what it says: the nine dock icons, and a frame for
	# each hour of the day for every figure an agent can have and for the neutral backdrop, nothing else beside them.
	for icon in browser-idle browser-running browser-launching browser-launching-2 browser-failed files-idle files-running \
		terminal-idle terminal-running; do
		[[ $(file -b "/usr/share/qorpera-desktop/dock/$icon.png") == "PNG image data, 112 x 112,"* ]] ||
			{ echo "the dock icon $icon is missing or no 112x112 PNG" >&2; exit 1; }
	done
	for figure in planet acorn flame rocket crown heart star cloud bolt mushroom moon puzzle neutral; do
		for hour in $(seq -w 0 23); do
			[[ $(file -b "/usr/share/qorpera-desktop/backdrops/$figure/$hour.png") == "PNG image data, 1920 x 1200,"* ]] ||
				{ echo "the backdrop of $figure for hour $hour is missing or no 1920x1200 PNG" >&2; exit 1; }
		done
	done
	[[ $(find /usr/share/qorpera-desktop -type f | wc -l) == $(( 9 + 13 * 24 )) ]] ||
		{ echo "the desktop pictures are not the 9 icons and 13 sets of 24 frames" >&2; exit 1; }
	[[ -z $(find /usr/share/qorpera-desktop ! -user root -o ! -group root -o -perm /022) ]] ||
		{ echo "someone but root could change a desktop picture" >&2; exit 1; }
	echo "the desktop pictures take $(du -sk /usr/share/qorpera-desktop | cut -f1) KiB of the image" >&2
	# The programs own pictures (the file manager arrows and folders, the terminal menus) come from the Adwaita icon
	# set, which the look names: without it every toolbar would show the same placeholder.
	for icon in symbolic/actions/go-previous-symbolic.svg symbolic/actions/go-up-symbolic.svg scalable/places/folder.svg; do
		[[ -s /usr/share/icons/Adwaita/$icon ]] || { echo "the icon set lacks $icon" >&2; exit 1; }
	done
	[[ $(stat -c "%U:%G %a %F" /run/qorpera-desktop-dock) == "root:desktop 730 directory" ]] ||
		{ echo "the folder a press on the dock asks in is not the root folder only the desktop account may write" >&2; exit 1; }
	[[ $(systemctl is-enabled qorpera-machine-desktop-dock.path) == enabled &&
		$(systemctl is-active qorpera-machine-desktop-dock.path) == active &&
		$(systemctl is-enabled qorpera-machine-desktop-dock.service || true) == static ]] ||
		{ echo "the unit that hears a press on the dock is not enabled, or its service starts by itself" >&2; exit 1; }
	[[ -d /etc/qorpera-machine && -z $(ls -A /etc/qorpera-machine) ]] ||
		{ echo "the image names a figure of its own" >&2; exit 1; }
	# Memory (12 Nov 2026). Every kernel this image holds has the zram module: a later kernel without it would leave
	# every machine without compressed memory, with only a line in each journal to say so.
	[[ -n $(ls /lib/modules) ]] || { echo "the image holds no kernel modules" >&2; exit 1; }
	for kernel in /lib/modules/*; do
		modinfo -k "$(basename "$kernel")" zram >/dev/null ||
			{ echo "the kernel $(basename "$kernel") has no zram module: machines would run without compressed memory" >&2; exit 1; }
	done
	# The boot unit, run here as a boot runs it: the swap is zram as large as the memory, at priority 100, with zstd and
	# the measured settings, and the unit run again changes nothing.
	memory_swap() { awk "\$1 == \"/dev/zram0\" {print \$3, \$5}" /proc/swaps; }
	systemctl start qorpera-machine-memory.service
	read -r swap_kb swap_priority <<<"$(memory_swap)"
	memory_kb=$(awk "/^MemTotal:/ {print \$2}" /proc/meminfo)
	[[ -n ${swap_kb:-} ]] && (( memory_kb - swap_kb >= 0 && memory_kb - swap_kb <= 64 )) && [[ $swap_priority == 100 ]] ||
		{ echo "compressed memory is not the size of the memory at priority 100: $(memory_swap) of $memory_kb" >&2; exit 1; }
	grep -q "\[zstd\]" /sys/block/zram0/comp_algorithm || { echo "compressed memory does not use zstd" >&2; exit 1; }
	[[ $(cat /proc/sys/vm/swappiness) == 150 && $(cat /proc/sys/vm/page-cluster) == 0 ]] ||
		{ echo "vm.swappiness and vm.page-cluster are not the measured 150 and 0" >&2; exit 1; }
	before="$(memory_swap) $(cat /sys/block/zram0/disksize /sys/block/zram0/comp_algorithm)"
	systemctl restart qorpera-machine-memory.service
	[[ "$(memory_swap) $(cat /sys/block/zram0/disksize /sys/block/zram0/comp_algorithm)" == "$before" ]] ||
		{ echo "the memory unit run again changed something" >&2; exit 1; }
	# A machine where it cannot be set up starts all the same: with the module hidden the unit ends well, there is no
	# swap, and the journal says so in one line. With the module back, the unit run again sets it up.
	# Right after a swapoff the device can still be held open for a moment (udev looks at a device that changed), and
	# its reset and the unload of the module are then refused as busy: one image build failed here on 12 Nov 2026 and
	# the same commit built on the next try. Each is asked again for up to 5 s while it is refused; the last try shows
	# its answer and, if it fails, fails the build. (A boot never does this: the memory unit only sets the device up.)
	patient() {
		local try
		for try in $(seq 1 50); do
			"$@" 2>/dev/null && return 0
			sleep 0.1
		done
		"$@"
	}
	swapoff /dev/zram0
	patient bash -c "echo 1 >/sys/block/zram0/reset"
	patient rmmod zram
	mkdir -p /run/modprobe.d && echo "install zram /bin/false" >/run/modprobe.d/qorpera-image-check.conf
	said=$(journalctl -b -t qorpera-machine-memory -o cat | grep -c "^compressed memory is OFF on this machine" || true)
	systemctl restart qorpera-machine-memory.service ||
		{ echo "the memory unit fails where compressed memory cannot be set up: a boot would show a failed unit" >&2; exit 1; }
	[[ -z $(memory_swap) && $(systemctl is-active qorpera-machine-memory.service) == active ]] ||
		{ echo "the memory unit did not end well without the zram module" >&2; exit 1; }
	(( $(journalctl -b -t qorpera-machine-memory -o cat | grep -c "^compressed memory is OFF on this machine") == said + 1 )) ||
		{ echo "the journal does not say in one line that compressed memory is off" >&2; exit 1; }
	rm /run/modprobe.d/qorpera-image-check.conf
	systemctl restart qorpera-machine-memory.service
	[[ -n $(memory_swap) ]] || { echo "compressed memory did not come back with the module" >&2; exit 1; }
	# The guard: earlyoom from our own unit, beside the commands slice, never ended itself; the package unit and
	# systemd-oomd (which ends whole control groups) do not run; the LXD agent and the machine own services are protected.
	systemctl start qorpera-machine-memory-guard.service
	# Its script becomes earlyoom a moment after the unit counts as started.
	for _ in $(seq 1 50); do
		guard=$(systemctl show qorpera-machine-memory-guard.service -p MainPID --value)
		[[ $(cat "/proc/$guard/comm" 2>/dev/null) == earlyoom ]] && break
		sleep 0.1
	done
	[[ $(cat "/proc/$guard/comm") == earlyoom && $(cat "/proc/$guard/oom_score_adj") == -1000 ]] ||
		{ echo "the memory guard does not run earlyoom, protected" >&2; exit 1; }
	grep -q "/qorpera-control.slice/" "/proc/$guard/cgroup" || { echo "the memory guard is not in the control slice" >&2; exit 1; }
	journalctl -b -t qorpera-machine-memory-guard -o cat | grep -q "sending SIGTERM when mem avail <= " ||
		{ echo "the memory guard did not say its limits" >&2; exit 1; }
	[[ $(readlink /etc/systemd/system/earlyoom.service) == /dev/null ]] || { echo "the package earlyoom unit is not masked" >&2; exit 1; }
	if systemctl is-active --quiet earlyoom.service systemd-oomd.service; then echo "another memory guard runs" >&2; exit 1; fi
	for unit in lxd-agent qorpera-machine-folder qorpera-machine-watchdog qorpera-machine-desktop; do
		[[ $(systemctl show "$unit.service" -p OOMScoreAdjust --value) == -900 ]] ||
			{ echo "$unit is not protected when memory runs out" >&2; exit 1; }
	done
	docker --version && docker compose version && docker buildx version
	node --version | grep -q "^v2[4-9]\."
	python3 --version && git --version && gcc --version | head -1
	# The toolbox: every command answers --version (unzip has none; -v prints its version).
	for tool in bash git node npm npx tsc tsx python3 pip pip3 uv uvx mise rg fd jq sqlite3 curl zip libreoffice soffice \
		fusermount3; do
		"$tool" --version >/dev/null || { echo "$tool does not answer --version" >&2; exit 1; }
	done
	unzip -v >/dev/null
	ffmpeg -version >/dev/null
	# Pages without a screen: root runs the image Chromium headless (its wrapper drops the sandbox root cannot use), and
	# a login shell in an empty folder finds Playwright and its browser with nothing installed.
	[[ $(chromium --headless --dump-dom "data:text/html,<p>qorpera-root-headless</p>" 2>/dev/null) == *qorpera-root-headless* ]] ||
		{ echo "root cannot run chromium headless" >&2; exit 1; }
	[[ $(playwright --version) == "Version ${PLAYWRIGHT_VERSION}" ]] || { echo "playwright is not ${PLAYWRIGHT_VERSION}" >&2; exit 1; }
	mkdir /tmp/empty && (cd /tmp/empty && bash -lc "node /opt/qorpera-machine/playwright-check.cjs")
	# The folder program is the pinned one, runs, and is only started by the helper (its unit has no [Install]).
	[[ $(sha256sum </opt/qorpera-folder/qorpera-folder | cut -d" " -f1) == "$EXPECTED_FOLDER_PROGRAM_SHA256" ]]
	/opt/qorpera-folder/qorpera-folder --version
	# The guest helper runs one folder-mount at a time under util-linux flock.
	/usr/bin/flock --version >/dev/null
	[[ $(systemctl is-enabled qorpera-machine-folder.service || true) == static ]]
	[[ -d /company && -z $(ls -A /company) ]]
	for folder in /var/lib/qorpera-folder /var/lib/qorpera-folder/cache /var/lib/qorpera-folder/cache/machine; do
		[[ $(stat -c "%U:%G %a %F" "$folder") == "root:root 700 directory" ]]
	done
	[[ -z $(ls -A /var/lib/qorpera-folder/cache/machine) ]]
	# The desktop: started only by `desktop start`, it comes up, shows Chromium, takes a 1600x1000 screenshot and stops with
	# everything on it. Chromium runs sandboxed as the desktop account (its AppArmor profile allows the user namespaces).
	[[ $(systemctl is-enabled qorpera-machine-desktop.service || true) == static ]]
	apparmor_parser -r /etc/apparmor.d/qorpera-chromium
	[[ $(chromium --version) == *" 151.0.7922.34"* ]]
	DOM=$(runuser -u desktop -- timeout 60 chromium --headless --disable-gpu --dump-dom "data:text/html,<p>qorpera-machine-desktop</p>" 2>/dev/null)
	[[ $DOM == *qorpera-machine-desktop* ]] || { echo "chromium does not render sandboxed" >&2; exit 1; }
	[[ -f /etc/opt/chrome_for_testing/policies/managed/qorpera.json ]]
	desktop start --lang da-DK --tz Europe/Copenhagen
	desktop status | grep "language da-DK, time zone Europe/Copenhagen" >/dev/null || { echo "the desktop lost its language or time zone" >&2; exit 1; }
	# 3D drawing in the browser, text with Danish capitals typed as written, a screenshot the size of the screen.
	desktop selftest
	# A folder with a page in it: linked on the desktop, served on the loopback, opened; one action can save the screen.
	mkdir /tmp/site && echo "<title>qorpera-site</title><h1>site</h1>" >/tmp/site/index.html
	desktop open /tmp/site --shot /tmp/site-shot.png | grep "at http://127.0.0.1:86" >/dev/null || { echo "the folder was not served" >&2; exit 1; }
	for _ in $(seq 1 40); do desktop windows | grep qorpera-site >/dev/null && break; sleep 0.5; done
	desktop windows | grep qorpera-site >/dev/null || { echo "the served folder shows no window" >&2; exit 1; }
	[[ -L /home/desktop/Desktop/site && -s /tmp/site-shot.png ]] || { echo "no link on the desktop, or no picture after the action" >&2; exit 1; }
	# Nothing on the desktop is replaced: the same link is used again, a copy gets a name of its own and keeps what was
	# changed in it, and another folder of the same name gets a number.
	desktop open /tmp/site >/dev/null
	[[ ! -e /home/desktop/Desktop/site-2 ]] || { echo "the same folder got a second link" >&2; exit 1; }
	desktop open /tmp/site --copy | grep "as site-2)" >/dev/null || { echo "a copy did not get a name of its own" >&2; exit 1; }
	[[ -d /home/desktop/Desktop/site-2 && ! -L /home/desktop/Desktop/site-2 && -L /home/desktop/Desktop/site ]]
	echo edited >/home/desktop/Desktop/site-2/kept.txt
	mkdir -p /tmp/other/site && echo "<title>qorpera-other</title>" >/tmp/other/site/index.html
	desktop open /tmp/site >/dev/null && desktop open /tmp/site --copy >/dev/null && desktop open /tmp/other/site >/dev/null
	[[ $(cat /home/desktop/Desktop/site-2/kept.txt) == edited && -d /home/desktop/Desktop/site-3 &&
		$(readlink /home/desktop/Desktop/site-4) == /tmp/other/site && $(readlink /home/desktop/Desktop/site) == /tmp/site ]] ||
		{ echo "opening again replaced something on the desktop" >&2; exit 1; }
	# Two pages of the same name from two folders: the second link gets a number, and the browser still gets its own page.
	mkdir /tmp/pa /tmp/pb && echo "<title>qorpera-page-a</title>" >/tmp/pa/page.html && echo "<title>qorpera-page-b</title>" >/tmp/pb/page.html
	desktop open /tmp/pa/page.html >/dev/null
	desktop open /tmp/pb/page.html | grep "/page.html (on the desktop as page-2.html)" >/dev/null ||
		{ echo "a second page of the same name got the wrong address" >&2; exit 1; }
	for _ in $(seq 1 40); do desktop windows | grep qorpera-page-b >/dev/null && break; sleep 0.5; done
	desktop windows | grep qorpera-page-b >/dev/null || { echo "the second page of the same name did not open" >&2; exit 1; }
	# A picture that nothing could show is refused: /company is a plain folder here.
	if desktop shot /company/never.png 2>/dev/null; then echo "a screenshot went into an unmounted /company" >&2; exit 1; fi
	[[ -z $(ls -A /company) ]]
	desktop open "data:text/html,<title>qorpera-machine-desktop</title><h1>qorpera-machine-desktop</h1>"
	for _ in $(seq 1 60); do desktop windows | grep -q qorpera-machine-desktop && break; sleep 0.5; done
	desktop windows | grep -q qorpera-machine-desktop || { echo "chromium shows no window on the desktop" >&2; exit 1; }
	desktop key ctrl+l && desktop type about:blank && desktop key Return
	desktop click 800 500
	# A click where the pointer already is never waits for a move that cannot come (15 s each before 12 Nov 2026): a
	# second click, a double-click, a move and a drag on that one spot, together well inside 5 s.
	pointer_started=$(date +%s%N)
	desktop click 800 500
	desktop double 800 500
	desktop move 800 500
	desktop drag 800 500 800 500
	(( ($(date +%s%N) - pointer_started) / 1000000 < 5000 )) ||
		{ echo "desktop actions on the spot the pointer is on took $(( ($(date +%s%N) - pointer_started) / 1000000 )) ms" >&2; exit 1; }
	# When memory runs out the screen is not what is ended, and a browser tab goes first: the X server keeps the unit
	# protection, the XFCE session the milder one its script gives it, the browser none, and Chromium marks its tabs.
	scores() { for pid in "$@"; do cat "/proc/$pid/oom_score_adj"; done | sort -u | tr "\n" " "; }
	[[ $(scores $(pgrep -u desktop -x Xvnc)) == "-900 " && $(scores $(pgrep -u desktop -x xfwm4)) == "-100 " ]] ||
		{ echo "the desktop is not protected when memory runs out: Xvnc $(scores $(pgrep -u desktop -x Xvnc)), xfwm4 $(scores $(pgrep -u desktop -x xfwm4))" >&2; exit 1; }
	[[ $(scores $(pgrep -u desktop -o -x chrome)) == "0 " && $(scores $(pgrep -u desktop -f -- "--type=renderer")) == "300 " ]] ||
		{ echo "a browser tab would not be the first to go: the browser $(scores $(pgrep -u desktop -o -x chrome)), its tabs $(scores $(pgrep -u desktop -f -- "--type=renderer"))" >&2; exit 1; }
	desktop shot /tmp/desktop.png | grep -q " 1600 x 1000$" || { echo "the screenshot is not 1600x1000" >&2; exit 1; }
	# A program gets its arguments as given (no $ expansion by systemd), and none starts on a stopped desktop.
	desktop run sh -c "v=literal; echo \"\${v} \\\$HOME\" > /tmp/desktop-run"
	for _ in $(seq 1 50); do [[ -s /tmp/desktop-run ]] && break; sleep 0.1; done
	[[ $(cat /tmp/desktop-run) == "literal \$HOME" ]] || { echo "desktop run changed its arguments: $(cat /tmp/desktop-run)" >&2; exit 1; }
	desktop stop
	if systemctl is-active --quiet qorpera-machine-desktop.service; then echo "the desktop did not stop" >&2; exit 1; fi
	[[ -z $(pgrep -u desktop || true) ]] || { echo "programs of the desktop outlived it" >&2; exit 1; }
	if desktop run sleep 600 2>/dev/null; then echo "a program started on a stopped desktop" >&2; exit 1; fi
	sleep 1
	[[ -z $(pgrep -u desktop || true) ]] || { echo "a program runs without the desktop" >&2; exit 1; }
	# The desktop look on a running desktop (12 Nov 2026), asked of XFCE itself as the desktop account on the session
	# bus. One bar, holding exactly three launchers between two gaps and two clocks and nothing else; each launcher is
	# one entry that runs the dock press for its program under a picture that is there; no icons on the backdrop, one
	# workspace, no compositor.
	look() { runuser -u desktop -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/qorpera-desktop/session/bus xfconf-query "$@"; }
	# What each dock icon shows, as the look keeps it in the account own folder (read as the account).
	marks() { runuser -u desktop -- sh -c "cd /run/qorpera-desktop/session && cat dock-browser.shows dock-files.shows dock-terminal.shows" 2>/dev/null | tr "\n" " "; }
	dock_whole() {
		local entry launcher
		[[ $(look -c xfce4-panel -p /panels | tail -n +3 | tr "\n" " ") == "1 " ]] || return 1
		[[ $(look -c xfce4-panel -lv | awk "\$1 ~ /^\/plugins\/plugin-[0-9]+\$/ {print \$2}" | sort | uniq -c | tr -s " \n" " ") == " 2 clock 3 launcher 2 separator " ]] ||
			return 1
		for entry in 4:terminal 5:files 6:browser; do
			launcher=(/home/desktop/.config/xfce4/panel/launcher-${entry%:*}/*.desktop)
			[[ ${#launcher[@]} == 1 ]] && grep -qx "Exec=/opt/qorpera-machine/desktop-look press ${entry#*:}" "${launcher[0]}" &&
				[[ -s $(sed -n "s/^Icon=//p" "${launcher[0]}") ]] || return 1
		done
	}
	shown() { look -c xfce4-desktop -p /backdrop/screen0/monitorVNC-0/workspace0/last-image; }
	# The backdrop is the frame of a set for the hour it is in a time zone, within 10 s (the watcher looks every 3 s).
	backdrop_is() { # set [zone]
		for _ in $(seq 1 100); do
			[[ $(shown) == "/usr/share/qorpera-desktop/backdrops/$1/$(TZ=${2:-UTC} date +%H).png" ]] && return 0
			sleep 0.1
		done
		return 1
	}
	window() { for _ in $(seq 1 150); do desktop windows | grep -q -- "$1" && return 0; sleep 0.1; done; return 1; }
	desktop start >/dev/null
	dock_whole || { echo "the dock is not one bar with the browser, the files and a terminal: $(look -c xfce4-panel -lv | tr "\n" " ")" >&2; exit 1; }
	[[ $(look -c xfce4-desktop -p /desktop-icons/style) == 0 && $(look -c xfwm4 -p /general/workspace_count) == 1 &&
		$(look -c xfwm4 -p /general/use_compositing) == false ]] ||
		{ echo "the desktop shows icons, more than one workspace or a compositor" >&2; exit 1; }
	# A machine that names no figure shows the neutral backdrop. A figure named while the desktop runs shows within
	# seconds, a saved ghost as the moon; a word that is no figure, and no file, give the neutral backdrop again.
	backdrop_is neutral || { echo "a machine that names no figure does not show the neutral backdrop: $(shown)" >&2; exit 1; }
	for figure in star:star ghost:moon nonsense:neutral; do
		echo "${figure%:*}" >/etc/qorpera-machine/desktop-figure
		backdrop_is "${figure#*:}" || { echo "the backdrop did not follow the figure ${figure%:*}: $(shown)" >&2; exit 1; }
	done
	echo rocket >/etc/qorpera-machine/desktop-figure
	backdrop_is rocket || { echo "the backdrop did not follow the figure rocket: $(shown)" >&2; exit 1; }
	# The dock clocks and the backdrop hour follow the time zone the desktop is given.
	desktop start --tz Pacific/Auckland >/dev/null
	backdrop_is rocket Pacific/Auckland && [[ $(look -c xfce4-panel -p /plugins/plugin-3/timezone) == Pacific/Auckland &&
		$(look -c xfce4-panel -p /plugins/plugin-7/timezone) == Pacific/Auckland ]] ||
		{ echo "the dock clocks or the backdrop did not follow the time zone: $(shown)" >&2; exit 1; }
	rm /etc/qorpera-machine/desktop-figure
	backdrop_is neutral Pacific/Auckland || { echo "the backdrop stayed after its figure was taken away: $(shown)" >&2; exit 1; }
	# A press on each dock icon, as a member presses it (a click on the icon, in the middle of the bar at the bottom of
	# the screen). The program shows its window, started the way desktop open and desktop run start it: a unit of its
	# own, no part of the session, whose protection it would inherit. The terminal runs the desktop account shell; the
	# browser is maximised above the dock on its new tab page. Each icon gets its mark, and a second press brings the
	# same window back and starts nothing.
	desktop click 880 960
	window " Terminal$" || { echo "a press on the dock terminal icon opened no terminal" >&2; exit 1; }
	[[ $(scores $(pgrep -u desktop -x xfce4-terminal)) == "0 " && -n $(pgrep -u desktop -x bash -P "$(pgrep -u desktop -o -x xfce4-terminal)") ]] ||
		{ echo "the dock terminal is no unit of its own, or runs no shell of the desktop account" >&2; exit 1; }
	desktop click 800 960
	window " - Thunar$" || { echo "a press on the dock files icon opened no file manager" >&2; exit 1; }
	desktop click 720 960
	window "Chrome for Testing$" || { echo "a press on the dock browser icon opened no browser" >&2; exit 1; }
	browser=$(pgrep -u desktop -o -x chrome)
	[[ $(scores "$browser") == "0 " ]] && tr "\0" " " <"/proc/$browser/cmdline" | grep -q -- " --start-maximized .* chrome://newtab/ *$" ||
		{ echo "the dock browser is no unit of its own, or was not started as desktop open starts it" >&2; exit 1; }
	read -r _ _ _ _ browser_width browser_height _ <<<"$(DISPLAY=:1 wmctrl -lG | grep "Chrome for Testing$")"
	[[ $browser_width == 1600 ]] && (( browser_height > 800 && browser_height <= 920 )) ||
		{ echo "the dock browser does not fill the screen above the dock: ${browser_width}x${browser_height}" >&2; exit 1; }
	for _ in $(seq 1 50); do
		[[ $(marks) == "running running running " ]] && break
		sleep 0.1
	done
	[[ $(marks) == "running running running " ]] || { echo "a dock icon does not mark its open program" >&2; exit 1; }
	desktop click 720 960
	sleep 1.5
	[[ $(pgrep -u desktop -o -x chrome) == "$browser" && $(desktop windows | grep -c "Chrome for Testing$") == 1 ]] ||
		{ echo "a second press on the dock browser icon started a second browser" >&2; exit 1; }
	# Opened and closed eight times in a row, the dock still answers: no start limit of systemd switches it off (the
	# sixth start of a service within ten seconds is refused unless its unit says otherwise). Each window stays half a
	# second, the least a person leaves it: the press that opened it has seen it by then and waits for nothing.
	for round in 1 2 3 4 5 6 7 8; do
		sleep 0.5
		DISPLAY=:1 wmctrl -c Terminal
		for _ in $(seq 1 50); do desktop windows | grep -q " Terminal$" || break; sleep 0.1; done
		if desktop windows | grep -q " Terminal$"; then echo "the terminal did not close in round $round" >&2; exit 1; fi
		desktop click 880 960
		window " Terminal$" || { echo "the dock stopped answering at press $round of a program opened and closed in a row" >&2; exit 1; }
	done
	[[ $(systemctl is-active qorpera-machine-desktop-dock.path) == active ]] && ! systemctl is-failed --quiet qorpera-machine-desktop-dock.service ||
		{ echo "the dock unit did not survive a program opened and closed in a row" >&2; exit 1; }
	desktop stop >/dev/null
	# Nothing of the desktop account runs any more. With the dock programs open, something of the account was listed in
	# the instant after the stop and was gone a few milliseconds later (once in a build, once in four runs of these
	# checks on a machine; not seen again in 51 stops looked at one by one). So a process that has ended and only waits
	# to be collected is not counted, what still runs gets two seconds to end, and what is left then is named.
	gone() {
		local left=
		for _ in $(seq 1 20); do
			left=$(ps -u desktop -o stat=,pid=,args= 2>/dev/null | grep -v "^Z" | cut -c1-120 || true)
			[[ -z $left ]] && return 0
			sleep 0.1
		done
		echo "programs of the desktop outlived it: $(tr "\n" "|" <<<"$left")" >&2
		return 1
	}
	gone || exit 1
	[[ -z $(ls -A /run/qorpera-desktop-dock) ]] || { echo "a press on the dock left its request behind" >&2; exit 1; }
	# The look is the image, never the account: with everything the account held gone, the next start shows it whole.
	rm -rf /home/desktop/.config
	desktop start >/dev/null
	dock_whole && backdrop_is neutral || { echo "the look did not come back in an emptied account" >&2; exit 1; }
	desktop stop >/dev/null
	# Root and the desktop account (review r1 F1 of #1704). Root keeps what it notes about the desktop in a folder of
	# its own, and reads none of them from a place the account owns: the account, or a page or a program run as it, can
	# make any name there a link to a file only root may read. A file only root can read stands in for such a file (the
	# company folder view, with its pass): none of its bytes may reach a program of the account through a note or a
	# request to the dock. (What desktop open, --copy and desktop shot do with files comes after, below.)
	secret=/root/qorpera-root-only-check
	marker="qorpera-root-only-$(od -An -N12 -tx1 /dev/urandom | tr -d " \n")"
	echo "$marker" >"$secret"
	chmod 0600 "$secret"
	untouched() { [[ $(cat "$secret") == "$marker" && $(stat -c "%U:%G %a" "$secret") == "root:root 600" ]]; }
	desktop start --lang da-DK --tz Europe/Copenhagen >/dev/null
	[[ $(stat -c "%U:%G %a" /run/qorpera-desktop) == "root:root 755" && $(stat -c "%U:%G %a" /run/qorpera-desktop/session) == "desktop:desktop 700" ]] ||
		{ echo "the notes of root about the desktop are not in a folder of root, beside the account own one" >&2; exit 1; }
	# The account can put nothing among the notes of root: no link, no pipe, no file, under any name root reads or writes.
	for note in lang tz last-use serve-8600 serve-8699 "drawn-$$.png" anything; do
		if runuser -u desktop -- ln -sfn "$secret" "/run/qorpera-desktop/$note" 2>/dev/null ||
			runuser -u desktop -- mkfifo "/run/qorpera-desktop/$note.pipe" 2>/dev/null ||
			runuser -u desktop -- sh -c ": >/run/qorpera-desktop/$note.new" 2>/dev/null; then
			echo "the desktop account put $note among the notes of root" >&2; exit 1
		fi
	done
	[[ -f /run/qorpera-desktop/last-use && ! -L /run/qorpera-desktop/last-use && $(cat /run/qorpera-desktop/lang) == da-DK &&
		$(cat /run/qorpera-desktop/tz) == Europe/Copenhagen ]] || { echo "the notes of root are not as root wrote them" >&2; exit 1; }
	# What the account plants in its own folders, under the names root uses for its notes, root never reads: a program
	# root starts for an agent, and one it starts for a press on the dock, get the language and the time zone root
	# noted, and nothing of the file only root can read, in their environment or their command line.
	for note in lang tz last-use; do runuser -u desktop -- ln -sfn "$secret" "/run/qorpera-desktop/session/$note"; done
	gets() { # pid: what a started program was handed
		tr "\0" "\n" <"/proc/$1/environ"
		tr "\0" " " <"/proc/$1/cmdline"
	}
	desktop run sleep 300 >/dev/null
	runuser -u desktop -- sh -c ": >/run/qorpera-desktop-dock/terminal"
	window " Terminal$" || { echo "a press on the dock opened no terminal beside planted links" >&2; exit 1; }
	for program in sleep xfce4-terminal; do
		pid=$(pgrep -u desktop -n -x "$program")
		if gets "$pid" | grep -q "$marker"; then echo "a program of the desktop account ($program) was handed a file only root can read" >&2; exit 1; fi
		[[ $(gets "$pid" | grep -c -x -e "TZ=Europe/Copenhagen" -e "LANGUAGE=da-DK") == 2 ]] ||
			{ echo "a program of the desktop account ($program) did not get the language and time zone root noted" >&2; exit 1; }
	done
	# A request to the dock is its name alone: a link or a pipe of that name is removed, never opened.
	runuser -u desktop -- ln -s "$secret" /run/qorpera-desktop-dock/files
	runuser -u desktop -- mkfifo /run/qorpera-desktop-dock/other
	window " - Thunar$" || { echo "a dock request that was a link opened nothing" >&2; exit 1; }
	for _ in $(seq 1 50); do [[ -z $(ls -A /run/qorpera-desktop-dock) ]] && break; sleep 0.1; done
	[[ -z $(ls -A /run/qorpera-desktop-dock) ]] && untouched || { echo "a dock request that was a link or a pipe was followed, or stayed" >&2; exit 1; }
	# A press on the dock starts one of three fixed programs and can steer nothing else (review r3 F1 of #1704). The
	# account may put any name into the folder a press asks in. Until this was closed, a folder there shaped like the
	# browser address (chrome:/newtab) made root take the address for that folder and put a link to it on the desktop:
	# with the Desktop folder of the account made a link to a folder of root, root wrote a link into that folder, under
	# a name the account chose. Now the broker and the command it runs work in /, look no word up as a file and put
	# nothing on the desktop. The account keeps planting, while each icon is pressed: the address as a folder and as a
	# link to a folder it named, the shapes of the folders and programs root names, and programs named like the tools
	# root runs. Each press starts its program, none of the planted programs runs, and the folder of root is as it
	# was: its owner, its rights, nothing in it.
	guarded=/etc/qorpera-dock-check
	mkdir "$guarded" && chmod 0755 "$guarded"
	install -d -o desktop -g desktop /tmp/qorpera-dock-planted
	cat >/tmp/qorpera-dock-planted/plant.sh <<"PLANT"
cd /run/qorpera-desktop-dock || exit 1
mkdir -p /home/desktop/planted/a-name-the-account-chose
while [ ! -e /tmp/qorpera-dock-planted/stop ]; do
	mkdir -p chrome: home/desktop company usr/bin usr/local/bin opt/qorpera-machine
	if [ "$1" = link ]; then ln -sfn /home/desktop/planted/a-name-the-account-chose chrome:/newtab; else mkdir -p chrome:/newtab; fi
	for tool in desktop bash env find rm systemctl xdpyinfo flock touch mountpoint systemd-run usr/bin/thunar usr/bin/xfce4-terminal usr/local/bin/desktop; do
		[ -e "$tool" ] || { printf "#!/bin/sh\nid >>/tmp/qorpera-dock-planted/ran\n" >"$tool"; chmod 0755 "$tool"; }
	done
done 2>/dev/null
PLANT
	runuser -u desktop -- sh -c "rm -rf /home/desktop/Desktop && ln -s $guarded /home/desktop/Desktop"
	declare -A shows=([browser]="Chrome for Testing" [files]=" - Thunar" [terminal]="Terminal")
	for shape in folder link; do
		for app in browser files terminal; do
			# The program is closed first, so the press is what starts it.
			for _ in $(seq 1 40); do desktop windows | grep -q -- "${shows[$app]}$" || break; DISPLAY=:1 wmctrl -c "${shows[$app]}"; sleep 0.25; done
			runuser -u desktop -- sh /tmp/qorpera-dock-planted/plant.sh "$shape" &
			sleep 0.3
			runuser -u desktop -- sh -c ": >/run/qorpera-desktop-dock/$app"
			started=yes
			window "${shows[$app]}$" || started=no
			sleep 0.5
			runuser -u desktop -- touch /tmp/qorpera-dock-planted/stop
			wait || true
			rm -f /tmp/qorpera-dock-planted/stop
			for _ in $(seq 1 50); do [[ -z $(ls -A /run/qorpera-desktop-dock) ]] && break; sleep 0.1; done
			[[ $(stat -c "%U:%G %a" "$guarded") == "root:root 755" && -z $(ls -A "$guarded") ]] ||
				{ echo "a press on the dock $app icon changed a folder of root through planted names ($shape): $(stat -c "%U:%G %a" "$guarded") $(ls -A "$guarded" | tr "\n" " ")" >&2; exit 1; }
			[[ ! -e /tmp/qorpera-dock-planted/ran ]] ||
				{ echo "a press on the dock $app icon ran a program the desktop account planted ($shape): $(head -1 /tmp/qorpera-dock-planted/ran)" >&2; exit 1; }
			[[ $started == yes ]] || { echo "a press on the dock $app icon started nothing beside planted names ($shape)" >&2; exit 1; }
			[[ -z $(ls -A /run/qorpera-desktop-dock) ]] || { echo "planted names stayed in the folder a press asks in" >&2; exit 1; }
		done
	done
	runuser -u desktop -- rm /home/desktop/Desktop
	rm -rf "$guarded" /tmp/qorpera-dock-planted
	untouched || { echo "the file only root can read was changed" >&2; exit 1; }
	# Root follows no link for the desktop account (review r2 of #1704). What desktop open, --copy and desktop shot do
	# with files is done by desktop-files: as the account, or by root inside folders it holds, on a way of folders that
	# root alone can change with no link on it. Root never looks at a path and then uses the path. The account plants
	# here what the review planted, before the command and while it runs: no byte of the file only root can read may
	# reach it, and nothing of root may be written to, gain a name or change hands.
	files=/opt/qorpera-machine/desktop-files
	mine=/root/qorpera-links
	leaked() { grep -rqs -- "$marker" /home/desktop /run/qorpera-desktop/session /tmp/qorpera-links /srv/qorpera-links; }
	roots_own() { [[ $(ls -A "$mine/folder") == keep && -z $(find "$mine" /etc/qorpera-machine ! -user root) ]] && untouched; }
	swapping() { runuser -u desktop -- sh -c "cd $1 && while [ ! -e /tmp/qorpera-links/stop ]; do $2; done" 2>/dev/null & }
	swapped() { runuser -u desktop -- touch /tmp/qorpera-links/stop; wait || true; rm -f /tmp/qorpera-links/stop; }
	mkdir -p "$mine/folder" "$mine/tree/inner" /srv/qorpera-links/group /srv/qorpera-links/acl /tmp/site-links
	install -d -o desktop -g desktop /tmp/qorpera-links
	echo keep >"$mine/folder/keep"
	echo qorpera-agent-chose-this >"$mine/agent.txt" && chmod 0600 "$mine/agent.txt"
	echo inner >"$mine/tree/inner/b.txt" && ln -s "$secret" "$mine/tree/to-the-file" && chmod 0700 "$mine/tree/inner"
	echo "<title>qorpera-links</title>" >/tmp/site-links/index.html
	# Review r2 F1: a link of root, on a way of root alone, that leads into the home of the account, where the account
	# points it on to the file; as the last name of the way and as a folder in the middle of it. It is copied by
	# neither root nor the account, and opened by neither, also while the account keeps changing its end of the link.
	runuser -u desktop -- ln -s "$secret" /home/desktop/input
	runuser -u desktop -- mkdir /home/desktop/way
	runuser -u desktop -- ln -s "$secret" /home/desktop/way/file.txt
	ln -s /home/desktop/input "$mine/input" && ln -s /home/desktop/input /srv/qorpera-links/input && ln -s /home/desktop/way "$mine/way"
	for target in "$mine/input" /srv/qorpera-links/input /home/desktop/input "$mine/way/file.txt" /home/desktop/way/file.txt; do
		if desktop open "$target" --copy >/dev/null 2>&1 || desktop open "$target" >/dev/null 2>&1; then
			echo "a link that leads to a file only root can read was opened for the desktop account ($target)" >&2; exit 1
		fi
	done
	swapping /home/desktop "echo mine >input.new; mv -f input.new input; ln -sfn $secret input"
	for _ in $(seq 1 25); do "$files" open --copy -- /srv/qorpera-links/input >/dev/null 2>&1 || true; done
	swapped
	if leaked; then echo "bytes of a file only root can read reached the desktop account through a link" >&2; exit 1; fi
	# Review r2 F2: the place of a picture, planted by the account before root writes there: a folder on the way made
	# a link to a folder of root, and the name of the picture made a link to the file. Root writes through neither
	# (the way is not of root alone) and the account cannot; also while the account keeps swapping the folder.
	runuser -u desktop -- ln -s "$mine/folder" /tmp/qorpera-links/capture
	runuser -u desktop -- ln -s "$secret" /tmp/qorpera-links/frame.png
	if desktop shot /tmp/qorpera-links/capture/frame.png >/dev/null 2>&1 || desktop shot /tmp/qorpera-links/frame.png >/dev/null 2>&1; then
		echo "a picture was saved through a link the desktop account planted" >&2; exit 1
	fi
	rm -f /tmp/qorpera-links/capture /tmp/qorpera-links/frame.png
	swapping /tmp/qorpera-links "rm -rf capture; mkdir capture; rm -rf capture; ln -s $mine/folder capture"
	for _ in $(seq 1 25); do desktop shot /tmp/qorpera-links/capture/frame.png >/dev/null 2>&1 || true; done
	swapped
	rm -rf /tmp/qorpera-links/capture
	roots_own || { echo "a picture was written into a folder of root, or over the file only root can read, through a planted link" >&2; exit 1; }
	# Where the whole way is of root alone, root saves the picture and makes the folders for it; elsewhere the account
	# saves it, as its own file. A folder of root that its group may write, or that an ACL opens to the account, is
	# not of root alone: root writes nothing in it, whatever name the account has planted there.
	desktop shot "$mine/pictures/new/a.png" | grep -q " 1600 x 1000$" &&
		[[ $(stat -c "%U:%G %a" "$mine/pictures/new" "$mine/pictures/new/a.png" | tr "\n" " ") == "root:root 755 root:root 644 " ]] ||
		{ echo "a picture on a way of root alone is not a 1600x1000 picture of root in a folder of root" >&2; exit 1; }
	desktop shot /tmp/qorpera-links/own.png | grep -q " 1600 x 1000$" && [[ $(stat -c %U /tmp/qorpera-links/own.png) == desktop ]] ||
		{ echo "a picture saved where the desktop account may write is not a 1600x1000 picture of the account" >&2; exit 1; }
	chgrp desktop /srv/qorpera-links/group && chmod 0775 /srv/qorpera-links/group
	python3 -I -c "import os, struct, sys; os.setxattr(sys.argv[1], \"system.posix_acl_access\", struct.pack(\"<I\", 2) + b\"\".join(struct.pack(\"<HHI\", *entry) for entry in ((1, 7, 0xFFFFFFFF), (2, 7, int(sys.argv[2])), (4, 5, 0xFFFFFFFF), (16, 5, 0xFFFFFFFF), (32, 5, 0xFFFFFFFF))))" /srv/qorpera-links/acl "$(id -u desktop)"
	[[ $(stat -c "%U:%G %a" /srv/qorpera-links/acl) == "root:root 755" ]] || { echo "the folder with an ACL does not look like a folder of root alone" >&2; exit 1; }
	runuser -u desktop -- ln -s "$secret" /srv/qorpera-links/group/planted.png
	if desktop shot /srv/qorpera-links/group/planted.png >/dev/null 2>&1; then echo "a picture was saved through a link in a folder a group can write" >&2; exit 1; fi
	desktop shot /srv/qorpera-links/group/a.png >/dev/null && [[ $(stat -c %U /srv/qorpera-links/group/a.png) == desktop ]] ||
		{ echo "root wrote a picture in a folder that a group can write" >&2; exit 1; }
	refused=$(desktop shot /srv/qorpera-links/acl/a.png 2>&1 || true)
	[[ $refused == *"/srv/qorpera-links/acl has an ACL that lets others write"* && ! -e /srv/qorpera-links/acl/a.png ]] ||
		{ echo "root wrote a picture in a folder that an ACL opens to another account: $refused" >&2; exit 1; }
	roots_own || { echo "saving pictures changed something of root" >&2; exit 1; }
	# Rows 9 and 10 of the list: the Desktop folder of the account. Made a link to a folder of root, nothing is put
	# there: not a link, not a copy the account could read itself, not a copy root reads for it.
	runuser -u desktop -- sh -c "rm -rf /home/desktop/Desktop && ln -s /etc/qorpera-machine /home/desktop/Desktop"
	for words in "/tmp/site-links" "/tmp/site-links --copy" "$mine/agent.txt --copy"; do
		if desktop open $words >/dev/null 2>&1; then echo "something was put on a desktop folder that is a link to a folder of root" >&2; exit 1; fi
	done
	[[ $(stat -c "%U:%G %a" /etc/qorpera-machine) == "root:root 755" && -z $(ls -A /etc/qorpera-machine) ]] ||
		{ echo "a folder of root was changed through the desktop account link" >&2; exit 1; }
	runuser -u desktop -- rm /home/desktop/Desktop
	# And while the account keeps making the names root would use there links to a folder of root and to the file:
	# root links, copies and hands over nothing in that folder itself, so nothing of root gains a name, an owner or a byte.
	runuser -u desktop -- mkdir /home/desktop/Desktop
	swapping /home/desktop/Desktop "for name in site-links site-links-2 site-links-3 agent.txt agent-2.txt tree tree-2; do ln -sfn $mine/folder \$name 2>/dev/null; rm -rf \$name; ln -sfn $secret \$name 2>/dev/null; rm -rf \$name; done"
	for _ in $(seq 1 10); do
		for words in "-- /tmp/site-links" "--copy -- /tmp/site-links" "--copy -- $mine/agent.txt" "--copy -- $mine/tree"; do
			"$files" open $words >/dev/null 2>&1 || true
		done
	done
	swapped
	roots_own || { echo "a race in the desktop folder changed something of root" >&2; exit 1; }
	if leaked; then echo "a race in the desktop folder gave the account bytes of a file only root can read" >&2; exit 1; fi
	# What an agent itself names on a way of root alone is still copied, as the account own: a file only root can
	# read, and a folder, in which a link stays a link (the account gets the name it points at, never what is there).
	runuser -u desktop -- sh -c "cd /home/desktop/Desktop && find . -mindepth 1 -delete"
	desktop open "$mine/agent.txt" --copy | grep -q "(on the desktop as agent.txt)$" && "$files" open --copy -- "$mine/tree" >/dev/null
	[[ $(stat -c "%U:%G %F" /home/desktop/Desktop/agent.txt) == "desktop:desktop regular file" &&
		$(cat /home/desktop/Desktop/agent.txt) == qorpera-agent-chose-this && $(cat /home/desktop/Desktop/tree/inner/b.txt) == inner &&
		$(readlink /home/desktop/Desktop/tree/to-the-file) == "$secret" && -z $(find /home/desktop/Desktop ! -user desktop) ]] ||
		{ echo "what an agent named on a way of root alone was not copied to the desktop as the account own" >&2; exit 1; }
	# A folder in it that another than root can write makes the whole not of root alone: root reads none of it for the
	# account, and the copy that had begun does not stay.
	chmod 0777 "$mine/tree/inner"
	if "$files" open --copy -- "$mine/tree" >/dev/null 2>&1; then echo "root read a folder that others can write, for the desktop account" >&2; exit 1; fi
	chmod 0700 "$mine/tree/inner"
	[[ ! -e /home/desktop/Desktop/tree-2 ]] || { echo "a copy that did not come whole stayed on the desktop" >&2; exit 1; }
	# A copy that is cut off leaves nothing that is not whole (review r1 F1 of #1712): it is made under a name the
	# desktop does not show and gets its name in one step. Here the account side is ended by another (as the memory
	# guard would end it) once a part of a large folder is written: what is then on the desktop under the name is the
	# whole folder or nothing, and nothing stays on its way, because root has the account take that away.
	mkdir "$mine/large"
	for part in a b c; do head -c 100000000 /dev/zero >"$mine/large/$part.bin"; done
	"$files" open --copy -- "$mine/large" >/dev/null 2>&1 &
	for _ in $(seq 1 500); do [[ -n $(find /home/desktop/Desktop -maxdepth 2 -path "*/.qorpera-desktop-copy.*/*.bin" 2>/dev/null) ]] && break; sleep 0.01; done
	pkill -KILL -u desktop -f "desktop-files account take" || true
	wait || true
	[[ ! -e /home/desktop/Desktop/large ]] || diff -r "$mine/large" /home/desktop/Desktop/large >/dev/null ||
		{ echo "a copy that was cut off left a part of itself on the desktop" >&2; exit 1; }
	[[ -z $(find /home/desktop/Desktop -maxdepth 1 -name ".qorpera-desktop-copy.*") ]] ||
		{ echo "a copy on its way stayed on the desktop: $(ls -A /home/desktop/Desktop | tr "\n" " ")" >&2; exit 1; }
	rm -rf "$mine/large"
	roots_own || { echo "copying for the desktop changed something of root" >&2; exit 1; }
	if leaked; then echo "bytes of a file only root can read are in the desktop account folders" >&2; exit 1; fi
	rm -rf "$mine" /srv/qorpera-links /tmp/qorpera-links /tmp/site-links
	desktop stop >/dev/null
	gone || exit 1
	[[ -d /run/qorpera-desktop && -z $(ls -A /run/qorpera-desktop) ]] || { echo "the notes of root outlived the desktop" >&2; exit 1; }
	rm -f "$secret"
	# save_coding_value (20260930705000): no clipboard manager keeps what is copied, and the clipboard helper seals a key
	# copied on the desktop (a made-up npm one), prints only the box, leaves both selections empty, and refuses an empty
	# clipboard and a stopped desktop with a code. It runs as the executor runs it: root, the target on stdin.
	[[ -z $(command -v xfce4-clipman || true) ]] || { echo "a clipboard manager would keep copied keys" >&2; exit 1; }
	desktop start
	node - <<"JS"
	const { execFileSync, spawnSync } = require("node:child_process");
	const crypto = require("node:crypto");
	const fs = require("node:fs");
	const env = { DISPLAY: ":1", PATH: "/usr/bin:/bin" };
	const fail = (why) => { console.error(why); process.exit(1); };
	const key = `npm_${crypto.randomBytes(18).toString("hex")}`;
	// xsel serves what it is given from a process of its own, which wants a home.
	const copy = () => {
		for (const selection of ["--clipboard", "--primary"])
			execFileSync("/usr/bin/xsel", ["--logfile", "/dev/null", selection, "--input"],
				{ input: key, env: { ...env, HOME: "/root" }, stdio: ["pipe", "ignore", "ignore"] });
	};
	copy();
	const id = () => crypto.randomUUID();
	const target = { schema: "qorpera.coding-value-machine-target/v1", service: "npm", valuePattern: "^npm_[A-Za-z0-9]{36}$",
		variable: "npm_token", companyId: id(), companyMachineId: id(), placementId: id(),
		bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), receiptId: id(),
		capturePublicKey: crypto.generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url") };
	const helper = () => spawnSync("/usr/bin/node", ["/opt/qorpera-machine/cloud-machine-coding-value.mjs"], { input: JSON.stringify(target), encoding: "utf8" });
	const read = (selection) => execFileSync("/usr/bin/xsel", ["--logfile", "/dev/null", selection, "--output"], { env, encoding: "utf8" });
	const sealed = helper();
	if (sealed.status !== 0 || JSON.parse(sealed.stdout).schema !== "qorpera.machine-coding-value-box/v1") fail("the clipboard helper sealed no box");
	if (sealed.stdout.includes(key.slice(4)) || sealed.stderr.includes(key.slice(4))) fail("the clipboard helper printed the key");
	if (read("--clipboard") !== "" || read("--primary") !== "") fail("the clipboard helper left the key on the clipboard");
	if (JSON.parse(helper().stdout).code !== "CLIPBOARD_EMPTY") fail("the clipboard helper did not refuse an empty clipboard");
	// The executor clears it itself after a save that did not end cleanly: the same helper with --clear-only.
	copy();
	const clearOnly = spawnSync("/usr/bin/node", ["/opt/qorpera-machine/cloud-machine-coding-value.mjs", "--clear-only"], { encoding: "utf8" });
	if (clearOnly.status !== 0 || JSON.parse(clearOnly.stdout).schema !== "qorpera.machine-coding-value-cleared/v1")
		fail("the clipboard helper did not clear with --clear-only");
	if (read("--clipboard") !== "" || read("--primary") !== "") fail("--clear-only left the key on the clipboard");
	execFileSync("/usr/local/bin/desktop", ["stop"], { stdio: "ignore" });
	if (JSON.parse(helper().stdout).code !== "DESKTOP_NOT_RUNNING") fail("the clipboard helper did not refuse a stopped desktop");
JS
	[[ -z $(pgrep -u desktop || true) ]] || { echo "programs of the desktop outlived it" >&2; exit 1; }
	# machine_screen (20260930708000): the screen helper runs as the executor runs it (root, the request on stdin, under
	# the same boot wrapper, with the environment of an LXD exec). A look on the stopped desktop starts it and shows a
	# 1600x1000 PNG; an open, a click and a typed text act and show the screen, the text arriving in the page; the same
	# receipt a second time exits 96 and acts no more; another boot exits 97; an action on a stopped desktop is refused by
	# its code; no picture stays on the disk and nothing reaches /company.
	node - <<"JS"
	const { execFileSync, spawn, spawnSync } = require("node:child_process");
	const crypto = require("node:crypto");
	const fs = require("node:fs");
	const fail = (why) => { console.error(why); process.exit(1); };
	const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	const ON_BOOT = `{ read -r boot < /proc/sys/kernel/random/boot_id && [ "$boot" = "$0" ]; } || exit 97; [ -f "$2" ] || exit 98; exec "$@"`;
	const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", LANG: "C.UTF-8", USER: "root" };
	const screen = (request, on = boot) => spawnSync("/bin/sh", ["-c", ON_BOOT, on, "/usr/bin/node", "/opt/qorpera-machine/cloud-machine-screen.mjs"], {
		input: JSON.stringify({ schema: "qorpera.machine-screen-request/v1", receiptId: null, action: null, settleMs: 500, look: true, ...request }),
		env, cwd: "/", maxBuffer: 16 * 1024 * 1024, timeout: 22000 });
	const act = (action, settleMs = 500) => ({ receiptId: crypto.randomUUID(), action, settleMs });
	const shown = (run, what) => {
		if (run.status !== 0) fail(`${what}: the screen helper exited ${run.status}`);
		const end = run.stdout.indexOf(10);
		const header = JSON.parse(run.stdout.subarray(0, end).toString("utf8"));
		const png = run.stdout.subarray(end + 1);
		if (header.schema !== "qorpera.machine-screen/v1") fail(`${what}: ${JSON.stringify(header)}`);
		if (header.png !== png.length || png.length < 33 || png.readUInt32BE(16) !== 1600 || png.readUInt32BE(20) !== 1000)
			fail(`${what}: no 1600x1000 screenshot`);
		if (header.action && header.action.exitCode !== 0) fail(`${what}: the action exited ${header.action.exitCode}`);
		return header;
	};
	const first = shown(screen({}), "a look on the stopped desktop");
	if (!first.started) fail("a look did not start the stopped desktop");
	// The desktop is drawn before the start returns: a black 1600x1000 screen is a PNG of 4760 bytes, the drawn one 16 KB.
	if (first.png <= 7800) fail(`a look that started the desktop shows an undrawn screen (${first.png} bytes)`);
	shown(screen(act({ type: "open", target: "file:///opt/qorpera-machine/desktop-selftest.html" }, 3000)), "an open");
	let page = false;
	for (let tries = 0; tries < 30 && !page; tries++) page = String(shown(screen({ settleMs: 1000 }), "a look").activeWindow).includes("SELFTEST[");
	if (!page) fail("the page the open asked for shows no window");
	const click = act({ type: "click", x: 400, y: 400 });
	shown(screen(click), "a click");
	const again = screen(click);
	if (again.status !== 96 || again.stdout.length !== 0) fail("the same receipt acted a second time");
	const typed = shown(screen(act({ type: "type", text: "qorpera screen" }, 1000)), "typed text");
	if (!String(typed.activeWindow).includes("qorpera screen]")) fail(`the typed text did not arrive: ${typed.activeWindow}`);
	// Each action command runs as a transient unit of its own (review r2 F4). Its text reaches desktop as given, never
	// expanded or read as an option; text beyond ASCII is pasted inside the unit and still arrives before the unit ends
	// (and with it the xsel that held it).
	for (const text of ["$HOME ${PATH} %n %% -x", "Ærø Øster"]) {
		const arrived = shown(screen(act({ type: "type", text }, 1000)), `typed ${text}`).activeWindow;
		if (!String(arrived).includes(`${text}]`)) fail(`the typed text ${text} arrived as: ${arrived}`);
	}
	// An action cut off while it waits (review r2 F4): its deadline is its own unit limit (RuntimeMaxSec, the whole unit
	// killed), never a timer of the helper alone. The desktop lock is held, an open (which needs it) waits on it, and the
	// helper is killed a second later: the waiting open is there then, gone past the action deadline (10 s), and the page
	// never opens once the lock is free. The browser the earlier open started is a unit of its own and is still there,
	// long after that action unit ended. Then an action still runs.
	const LOCK = "/run/qorpera-desktop.lock";
	const holder = spawn("/usr/bin/flock", [LOCK, "/usr/bin/sleep", "60"], { stdio: "ignore", detached: true });
	for (let tries = 0; tries < 30 && spawnSync("/usr/bin/flock", ["-n", LOCK, "/usr/bin/true"]).status === 0; tries++) pause(100);
	if (spawnSync("/usr/bin/flock", ["-n", LOCK, "/usr/bin/true"]).status === 0) fail("the desktop lock could not be held");
	// The page name is put together here: this check runs inside a shell whose command line is this whole script, so a
	// name written out in it would be found on that shell by pgrep -f, always (the first build of this check failed so).
	const cutPage = ["qorpera", "cut", "off"].join("-");
	if (spawnSync("/usr/bin/pgrep", ["-f", `${cutPage}.html`]).status === 0) fail("the cut-off page name is on a command line before the open");
	fs.writeFileSync(`/tmp/${cutPage}.html`, `<title>${cutPage}-open</title><h1>cut off</h1>`, { mode: 0o644 });
	fs.writeFileSync(`/tmp/${cutPage}.json`, JSON.stringify({ schema: "qorpera.machine-screen-request/v1", look: true,
		...act({ type: "open", target: `file:///tmp/${cutPage}.html` }, 0) }));
	const cut = spawn("/bin/sh", ["-c", ON_BOOT, boot, "/usr/bin/node", "/opt/qorpera-machine/cloud-machine-screen.mjs"],
		{ stdio: [fs.openSync(`/tmp/${cutPage}.json`, "r"), "ignore", "ignore"], env, cwd: "/" });
	pause(1200);
	const waiting = () => spawnSync("/usr/bin/pgrep", ["-f", `${cutPage}.html`]).status === 0;
	if (!waiting()) fail("the open did not wait on the desktop lock, so the cut-off check tests nothing");
	process.kill(cut.pid, "SIGKILL");
	pause(11000);
	if (waiting()) fail("the cut-off open outlived its deadline: " + spawnSync("/usr/bin/pgrep", ["-af", `${cutPage}.html`], { encoding: "utf8" }).stdout);
	process.kill(-holder.pid, "SIGKILL");
	pause(3000);
	const listed = spawnSync("/usr/bin/wmctrl", ["-l"], { env: { ...env, DISPLAY: ":1" }, encoding: "utf8" }).stdout;
	if (listed.includes(`${cutPage}-open`)) fail("the cut-off open ran once the desktop lock was free");
	if (!listed.includes("SELFTEST[")) fail("the browser an action opened did not outlive the action unit");
	shown(screen(act({ type: "key", keys: ["Escape"] })), "an action after the cut-off one");
	// Keys (review r1 F2): `xdotool key` runs any of its own commands that follows the keys (exec runs a program as root),
	// so none is a key. The helper refuses every word of the installed xdotool help as a key, in capitals too: a newer
	// xdotool with a command its list lacks fails this build until the list has it.
	const help = spawnSync("/usr/bin/xdotool", ["help"], { env: { ...env, DISPLAY: ":1" }, encoding: "utf8" }).stdout
		.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
	if (help.length < 40 || !help.includes("exec") || help.some((word) => /\s/.test(word))) fail(`xdotool help lists ${help.length} commands`);
	for (const word of [...help, "EXEC"]) {
		const keyed = screen(act({ type: "key", keys: [word, "id"] }));
		if (keyed.status !== 0 || JSON.parse(keyed.stdout.toString("utf8")).code !== "SCREEN_REQUEST_INVALID")
			fail(`the screen helper took ${word} as a key`);
	}
	if (screen({}, crypto.randomUUID()).status !== 97) fail("the screen helper ran on another boot");
	execFileSync("/usr/local/bin/desktop", ["stop"], { stdio: "ignore" });
	const refused = screen(act({ type: "click", x: 1, y: 1 }));
	if (refused.status !== 0 || JSON.parse(refused.stdout.toString("utf8")).code !== "DESKTOP_NOT_RUNNING")
		fail("the screen helper acted on a stopped desktop");
	if ((fs.statSync("/run/qorpera-screen").mode & 0o777) !== 0o700 || fs.readdirSync("/run/qorpera-screen/shots").length)
		fail("the screen helper left a picture on the disk");
JS
	[[ -z $(pgrep -u desktop || true) ]] || { echo "programs of the desktop outlived it" >&2; exit 1; }
	[[ -z $(ls -A /company) ]] || { echo "the screen helper wrote into /company" >&2; exit 1; }
	# desktop key refuses every word of the installed xdotool help as a key (exit 2) and runs nothing for it, presses real
	# keys, and fails on a key name xdotool does not know rather than saying it pressed it (review r1 F2).
	desktop start >/dev/null
	words=$(DISPLAY=:1 xdotool help | tail -n +2)
	(( $(wc -w <<<"$words") >= 40 )) || { echo "xdotool help lists no commands" >&2; exit 1; }
	rm -f /tmp/qorpera-key-ran
	for word in $words EXEC; do
		code=0
		desktop key "$word" touch /tmp/qorpera-key-ran 2>/dev/null || code=$?
		[[ $code == 2 ]] || { echo "desktop key took $word as a key (exit $code)" >&2; exit 1; }
	done
	[[ ! -e /tmp/qorpera-key-ran ]] || { echo "a key ran a program" >&2; exit 1; }
	{ desktop key Return && desktop key ctrl+l; } || { echo "desktop key refused a real key" >&2; exit 1; }
	code=0
	desktop key NoSuchKey 2>/dev/null || code=$?
	[[ $code == 2 ]] || { echo "desktop key took a key that does not exist (exit $code)" >&2; exit 1; }
	desktop stop >/dev/null
	[[ -z $(pgrep -u desktop || true) ]] || { echo "programs of the desktop outlived it" >&2; exit 1; }
	# Nothing of these checks stays in the desktop account (its look is written anew at every start), and the image
	# names no figure.
	find /home/desktop -mindepth 1 -maxdepth 1 ! -name .bashrc ! -name .profile ! -name .bash_logout -exec rm -rf -- {} +
	[[ $(ls -A /home/desktop | sort | tr "\n" " ") == ".bash_logout .bashrc .profile " && -z $(ls -A /etc/qorpera-machine) ]] ||
		{ echo "the checks left something in the desktop account, or a figure" >&2; exit 1; }
	for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service \
		fwupd-refresh.timer fwupd-refresh.service fwupd.service earlyoom.service; do
		[[ $(readlink "/etc/systemd/system/$unit") == /dev/null ]]
	done
	# Nothing else refreshes firmware either, whatever fwupd names its units: no fwupd timer runs and no other fwupd unit
	# starts at boot (each is masked, or a service only another unit starts), and every bus name of fwupd starts a masked
	# unit through systemd (a bus file without SystemdService= would have dbus start the daemon itself, past the masks).
	units=$(systemctl list-unit-files --no-legend "*fwupd*")
	while read -r unit state _; do
		[[ $state == masked || ( $unit != *.timer && ( $state == static || $state == disabled ) ) ]] ||
			{ echo "fwupd can still start: $unit is $state" >&2; exit 1; }
	done <<<"$units"
	for bus in /usr/share/dbus-1/system-services/*.service; do
		grep -q "^Name=org\.freedesktop\.fwupd" "$bus" || continue
		service=$(sed -n "s/^SystemdService=//p" "$bus")
		[[ -n $service && $(systemctl is-enabled "$service" || true) == masked ]] ||
			{ echo "the bus file $bus can still start fwupd" >&2; exit 1; }
	done
	systemd-analyze verify /etc/systemd/system/qorpera-machine-watchdog.service /etc/systemd/system/qorpera-machine.slice \
		/etc/systemd/system/qorpera-machine-folder.service
	systemd-analyze verify /etc/systemd/system/qorpera-machine-desktop.service
	systemd-analyze verify /etc/systemd/system/qorpera-machine-desktop-dock.path /etc/systemd/system/qorpera-machine-desktop-dock.service
	systemd-analyze verify /etc/systemd/system/qorpera-machine-memory.service /etc/systemd/system/qorpera-machine-memory-guard.service
	# Nothing of this build stays: logs, keys, caches (the LibreOffice profile too), the machine id.
	apt-get clean
	rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /root/.npm /root/.config/libreoffice
	cloud-init clean --logs --machine-id
	rm -f /etc/ssh/ssh_host_*
	journalctl --rotate --vacuum-time=1s >/dev/null 2>&1 || true
	sync
'
lx stop "$BUILDER"
lx publish "$BUILDER" --alias "$ALIAS" description="Qorpera company machine $STAMP (Ubuntu 26.04, Docker, Node $NODE_VERSION, toolbox, company folder, desktop with Chromium $CHROMIUM_VERSION, Playwright $PLAYWRIGHT_VERSION)"
FINGERPRINT=$(lx image info "$ALIAS" | awk '/^Fingerprint:/ {print $2}')
[[ $FINGERPRINT =~ ^[0-9a-f]{64}$ ]] || { echo "no image fingerprint" >&2; exit 1; }
echo "published $FINGERPRINT (delete it by hand if this build fails from here)" >&2
# Machines are made from the store their project uses. A build space with its own store keeps no copy: export and
# import keep the fingerprint (copying between projects would need LXD to listen on the network).
if [[ $(store "$PROJECT") != "$(store "$MACHINES")" ]]; then
	EXPORT=$(mktemp -d)
	lx image export "$FINGERPRINT" "$EXPORT/image" >/dev/null
	# One file (a published image) or two (metadata and image.root).
	shopt -s nullglob
	PARTS=("$EXPORT"/*)
	if [[ -f $EXPORT/image.root ]]; then
		(( ${#PARTS[@]} == 2 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
		for part in "${PARTS[@]}"; do [[ $part == "$EXPORT/image.root" ]] || META=$part; done
		PARTS=("$META" "$EXPORT/image.root")
	else
		(( ${#PARTS[@]} == 1 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
	fi
	lxc --project "$MACHINES" image import "${PARTS[@]}" --alias "$ALIAS" >/dev/null
	rm -rf -- "$EXPORT"; EXPORT=
	lx image delete "$FINGERPRINT" || echo "the build space still holds $FINGERPRINT: delete it by hand" >&2
fi
[[ $(lxc --project "$MACHINES" image info "$FINGERPRINT" | awk '/^Fingerprint:/ {print $2}') == "$FINGERPRINT" ]] ||
	{ echo "the image is not in the store of project $MACHINES" >&2; exit 1; }
# The bootstrap digest pins exactly what was installed: this script and the guest package.
BOOTSTRAP=$(cat "$0" "$PACKAGE/manifest.json" | sha256sum | cut -d' ' -f1)
jq -n --arg imageFingerprint "$FINGERPRINT" --arg bootstrapSha256 "$BOOTSTRAP" --arg alias "$ALIAS" \
	--arg helperSha256 "$(jq -r '.artifacts[0].sha256' "$PACKAGE/manifest.json")" --arg node "$NODE_VERSION" --arg chromium "$CHROMIUM_VERSION" --arg playwright "$PLAYWRIGHT_VERSION" \
	'{schema: "qorpera.machine-image-build/v1", alias: $alias, imageFingerprint: $imageFingerprint,
	  bootstrapSha256: $bootstrapSha256, helperSha256: $helperSha256, node: $node, chromium: $chromium, playwright: $playwright}' >&3
