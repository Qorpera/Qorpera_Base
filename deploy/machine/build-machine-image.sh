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
# with which an agent acts on the desktop and sees it in one tool call. Since 10 Nov 2026 a desktop is something an agent
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
	qorpera-machine-folder.service qorpera-machine-desktop.service desktop-session desktop qorpera-chromium.apparmor \
	desktop-selftest.html qorpera-chromium-policy.json chromium qorpera-machine-profile.sh playwright-check.cjs \
	qorpera-folder manifest.json; do
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
		x11-utils x11-xserver-utils xdotool wmctrl scrot xsel apparmor \
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
	# Its panel starts with the default XFCE layout instead of asking on the first start.
	install -d -o desktop -g desktop -m 0755 /home/desktop/.config /home/desktop/.config/xfce4 \
		/home/desktop/.config/xfce4/xfconf /home/desktop/.config/xfce4/xfconf/xfce-perchannel-xml
	install -o desktop -g desktop -m 0644 /etc/xdg/xfce4/panel/default.xml \
		/home/desktop/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml
	install -d -o root -g root -m 0755 /opt/qorpera-machine /opt/qorpera-folder
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
for unit in qorpera-machine.slice qorpera-machine-watchdog.service qorpera-machine-watchdog.timer qorpera-machine-folder.service \
	qorpera-machine-desktop.service; do
	lx file push "$PACKAGE/$unit" "$BUILDER/etc/systemd/system/$unit" --uid 0 --gid 0 --mode 0644
done
lx exec "$BUILDER" -- env EXPECTED_FOLDER_PROGRAM_SHA256="$EXPECTED_FOLDER_PROGRAM_SHA256" \
	PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" bash -euo pipefail -c '
	systemctl daemon-reload
	systemctl enable qorpera-machine-watchdog.timer
	# Checks the reviewed image must pass.
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
	const { execFileSync, spawnSync } = require("node:child_process");
	const crypto = require("node:crypto");
	const fs = require("node:fs");
	const fail = (why) => { console.error(why); process.exit(1); };
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
	# Nothing of that check stays in the desktop account but its panel layout.
	find /home/desktop -mindepth 1 -maxdepth 1 ! -name .config ! -name .bashrc ! -name .profile ! -name .bash_logout \
		-exec rm -rf -- {} +
	find /home/desktop/.config -mindepth 1 -maxdepth 1 ! -name xfce4 -exec rm -rf -- {} +
	find /home/desktop/.config/xfce4 -mindepth 1 -maxdepth 1 ! -name xfconf -exec rm -rf -- {} +
	find /home/desktop/.config/xfce4/xfconf/xfce-perchannel-xml -mindepth 1 ! -name xfce4-panel.xml -exec rm -rf -- {} +
	for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service \
		fwupd-refresh.timer fwupd-refresh.service fwupd.service; do
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
