#!/usr/bin/env bash
set -euo pipefail

# Installs the Company Computer image contract inside the image-builder VM:
# the complete runner guest contract (nested, verified against its own
# manifest), the per-screen desktop stack, and the standing screen agent.
# The Company Computer image is a strict superset of the runner image and is
# built, signed, and activated through the same provenance cycle.

PACKAGE_ROOT=${1:-}
WORK_USER="qorpera-runner"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this installer as root inside the image-builder VM." >&2
	exit 1
fi
if [[ -z ${PACKAGE_ROOT} || ${PACKAGE_ROOT} != /* || ! -d ${PACKAGE_ROOT} || -L ${PACKAGE_ROOT} ]]; then
	echo "An absolute physical guest-package directory is required." >&2
	exit 1
fi
if ! grep -q '^VERSION_ID="26.04"$' /etc/os-release; then
	echo "The Company Computer image contract is pinned to Ubuntu 26.04." >&2
	exit 1
fi
if [[ $(uname -m) != x86_64 ]]; then
	echo "The first-node Company Computer image is pinned to x86_64." >&2
	exit 1
fi

# Node arrives with the nested runner contract, so before it runs the nested
# pin is checked with shell tools alone; the full artifact verification
# (which already ran host-side in the build recipe) re-runs below the moment
# node exists.
runner_manifest_sha=$(sha256sum "${PACKAGE_ROOT}/runner/manifest.json" | awk '{ print $1 }')
pinned_runner_sha=$(grep -o '"manifestSha256": *"[0-9a-f]\{64\}"' "${PACKAGE_ROOT}/manifest.json" | grep -o '[0-9a-f]\{64\}' | head -1)
if [[ -z ${pinned_runner_sha} || ${runner_manifest_sha} != "${pinned_runner_sha}" ]]; then
	echo "Nested runner guest package does not match the company manifest pin." >&2
	exit 1
fi

# The runner contract first: it installs the pinned runtime, the service
# accounts, the native harnesses, and the signed sandbox image the shared
# machine's execution lane uses unchanged.
bash "${PACKAGE_ROOT}/runner/install-image-contract.sh" "${PACKAGE_ROOT}/runner"

PACKAGE_ROOT=${PACKAGE_ROOT} node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");

const root = realpathSync(process.env.PACKAGE_ROOT);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (
  manifest.schema !== "qorpera.lxd-company-computer-guest-package/v1" ||
  !manifest.runnerPackage ||
  !/^[0-9a-f]{64}$/.test(manifest.runnerPackage.manifestSha256) ||
  !Array.isArray(manifest.artifacts)
) {
  throw new Error("Company computer guest package manifest is invalid");
}
const runnerManifest = readFileSync(join(root, "runner/manifest.json"));
if (
  createHash("sha256").update(runnerManifest).digest("hex") !== manifest.runnerPackage.manifestSha256
) {
  throw new Error("Nested runner guest package does not match the company manifest pin");
}
const expected = new Set([
  "company-lock-heartbeat.mjs",
  "google-chrome-signing-key.asc",
  "install-image-contract.sh",
  "qorpera-chrome",
  "qorpera-chrome.desktop",
  "qorpera-files",
  "qorpera-files.desktop",
  "qorpera-terminal",
  "qorpera-terminal.desktop",
  "qorpera-company-computer-bootstrap.mjs",
  "qorpera-company-computer-bootstrap.service",
  "qorpera-company-computer-runner.mjs",
  "qorpera-company-computer-runner.service",
  "qorpera-company-computer-screens.mjs",
  "qorpera-company-computer-screens.service",
  "qorpera-screen-session",
  "xfce4-panel.xml",
  "wallpapers/pebble.svg",
  "wallpapers/folio.svg",
  "wallpapers/brain.svg",
  "wallpapers/wisp.svg",
  "wallpapers/halo.svg",
  "wallpapers/ribbon.svg",
  "wallpapers/bloom.svg",
]);
for (const artifact of manifest.artifacts) {
  if (!artifact || typeof artifact.file !== "string" || !expected.delete(artifact.file)) {
    throw new Error("Company computer guest package contains an unexpected artifact");
  }
  const path = resolve(root, artifact.file);
  if (!path.startsWith(`${root}/`) || basename(path) === "manifest.json") {
    throw new Error("Company computer guest package artifact escapes its root");
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.bytes) {
    throw new Error("Company computer guest package artifact metadata is invalid");
  }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== artifact.sha256) throw new Error("Company computer guest package artifact checksum mismatch");
}
if (expected.size !== 0) throw new Error("Company computer guest package is incomplete");
NODE


# The ephemeral bootstrap entry stays installed but never fires on a Company
# Computer (its condition file is bootstrap.json, not company-computer.json);
# disable it so the published image has one deterministic entry point.
systemctl disable qorpera-lxd-runner-bootstrap.service >/dev/null 2>&1 || true

export DEBIAN_FRONTEND=noninteractive
apt-get install --yes dbus-x11 librsvg2-bin scrot tigervnc-standalone-server x11-xserver-utils xauth xfce4 xfce4-terminal

for binary in \
	/usr/bin/Xvnc \
	/usr/bin/Thunar \
	/usr/bin/dbus-run-session \
	/usr/bin/scrot \
	/usr/bin/xfce4-panel \
	/usr/bin/xfce4-session \
	/usr/bin/xfce4-terminal \
	/usr/bin/xfconf-query \
	/usr/bin/xrandr \
	/usr/bin/xset; do
	if [[ ! -x ${binary} ]]; then
		echo "The desktop stack is missing ${binary}." >&2
		exit 1
	fi
done
if ! getent passwd "${WORK_USER}" >/dev/null; then
	echo "The runner contract did not provide the ${WORK_USER} work account." >&2
	exit 1
fi
if ! getent group users >/dev/null; then
	echo "The image does not provide the NAS sharing group users." >&2
	exit 1
fi
if [[ $(getent group users | cut -d: -f3) != 100 ]]; then
	echo "The image's users group does not match the NAS sharing GID 100." >&2
	exit 1
fi
usermod -a -G users qorpera-runner
usermod -a -G users qorpera-native-provider

install -d -o root -g root -m 0755 /opt/qorpera-company-computer
for artifact in \
	company-lock-heartbeat.mjs \
	qorpera-company-computer-bootstrap.mjs \
	qorpera-company-computer-runner.mjs \
	qorpera-company-computer-screens.mjs; do
	install -o root -g root -m 0555 "${PACKAGE_ROOT}/${artifact}" "/opt/qorpera-company-computer/${artifact}"
	node --check "/opt/qorpera-company-computer/${artifact}"
done
install -o root -g root -m 0555 "${PACKAGE_ROOT}/qorpera-screen-session" /usr/local/bin/qorpera-screen-session
bash -n /usr/local/bin/qorpera-screen-session
# One wallpaper per creature, rasterized once at install so the running
# guest never needs the SVG toolchain; the screen agent dresses each screen
# with its owning agent's creature, folio standing in as the default seed.
install -d -o root -g root -m 0755 /usr/share/backgrounds
for creature in pebble folio brain wisp halo ribbon bloom; do
	rsvg-convert "${PACKAGE_ROOT}/wallpapers/${creature}.svg" -w 2560 -h 1600 \
		-o "/usr/share/backgrounds/qorpera-screen-${creature}.png"
	chmod 0644 "/usr/share/backgrounds/qorpera-screen-${creature}.png"
done
cp /usr/share/backgrounds/qorpera-screen-folio.png /usr/share/backgrounds/qorpera-screen.png
chmod 0644 /usr/share/backgrounds/qorpera-screen.png

# Chrome in the dock, from Google's signed apt repository. Provenance: the
# repository signing key ships pinned in this package and its primary
# fingerprint is asserted before it is trusted; the installed version is
# recorded in the image marker. The dock launcher goes through
# qorpera-chrome, which keeps every screen's browser profile on the NAS
# dataset.
PACKAGE_ROOT=${PACKAGE_ROOT} node <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const EXPECTED_PRIMARY_FINGERPRINT = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796";
const armored = readFileSync(join(process.env.PACKAGE_ROOT, "google-chrome-signing-key.asc"), "utf8");
const body = armored.split(/\r?\n\r?\n/)[1].split("=")[0].replace(/-----[^]*?-----/g, "").replace(/\s+/g, "");
const data = Buffer.from(body, "base64");
let offset = 0;
const primaries = [];
while (offset < data.length) {
  const header = data[offset];
  if ((header & 0x80) === 0) break;
  let tag, length, lengthBytes;
  if (header & 0x40) {
    tag = header & 0x3f;
    const first = data[offset + 1];
    if (first < 192) { length = first; lengthBytes = 1; }
    else if (first < 224) { length = (first - 192) * 256 + data[offset + 2] + 192; lengthBytes = 2; }
    else if (first === 255) { length = data.readUInt32BE(offset + 2); lengthBytes = 5; }
    else break;
    offset += 1 + lengthBytes;
  } else {
    tag = (header >> 2) & 0x0f;
    const lengthType = header & 0x03;
    if (lengthType === 0) { length = data[offset + 1]; lengthBytes = 1; }
    else if (lengthType === 1) { length = data.readUInt16BE(offset + 1); lengthBytes = 2; }
    else if (lengthType === 2) { length = data.readUInt32BE(offset + 1); lengthBytes = 4; }
    else break;
    offset += 1 + lengthBytes;
  }
  if (tag === 6) {
    const packet = data.subarray(offset, offset + length);
    const prefix = Buffer.alloc(3);
    prefix[0] = 0x99;
    prefix.writeUInt16BE(length, 1);
    primaries.push(createHash("sha1").update(Buffer.concat([prefix, packet])).digest("hex").toUpperCase());
  }
  offset += length;
}
if (!primaries.includes(EXPECTED_PRIMARY_FINGERPRINT)) {
  throw new Error(`Google signing key fingerprint mismatch: ${primaries.join(", ")}`);
}
NODE
install -d -o root -g root -m 0755 /etc/apt/keyrings
install -o root -g root -m 0644 "${PACKAGE_ROOT}/google-chrome-signing-key.asc" /etc/apt/keyrings/google-chrome.asc
printf '%s\n' \
	"deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" \
	> /etc/apt/sources.list.d/google-chrome.list
apt-get update
apt-get install --yes google-chrome-stable
if [[ ! -x /usr/bin/google-chrome-stable ]]; then
	echo "Google Chrome did not install." >&2
	exit 1
fi
chrome_version=$(/usr/bin/google-chrome-stable --version | awk '{ print $3 }')
install -o root -g root -m 0555 "${PACKAGE_ROOT}/qorpera-chrome" /usr/local/bin/qorpera-chrome
bash -n /usr/local/bin/qorpera-chrome
install -o root -g root -m 0644 "${PACKAGE_ROOT}/qorpera-chrome.desktop" /usr/share/applications/qorpera-chrome.desktop
for launcher in files terminal; do
	install -o root -g root -m 0555 "${PACKAGE_ROOT}/qorpera-${launcher}" "/usr/local/bin/qorpera-${launcher}"
	bash -n "/usr/local/bin/qorpera-${launcher}"
	install -o root -g root -m 0644 "${PACKAGE_ROOT}/qorpera-${launcher}.desktop" \
		"/usr/share/applications/qorpera-${launcher}.desktop"
done

# The dock every screen starts with: Chrome, files, terminal.
install -d -o root -g root -m 0755 /etc/xdg/xfce4/xfconf/xfce-perchannel-xml
install -o root -g root -m 0644 "${PACKAGE_ROOT}/xfce4-panel.xml" \
	/etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml
for unit in \
	qorpera-company-computer-bootstrap.service \
	qorpera-company-computer-runner.service \
	qorpera-company-computer-screens.service; do
	install -o root -g root -m 0644 "${PACKAGE_ROOT}/${unit}" "/etc/systemd/system/${unit}"
done

# The dataset mount point exists in the image; the working world only ever
# materializes on the attached NAS share, never on this disposable root.
install -d -o root -g root -m 0755 /srv/qorpera /srv/qorpera/dataset

systemd-analyze verify \
	/etc/systemd/system/qorpera-company-computer-bootstrap.service \
	/etc/systemd/system/qorpera-company-computer-runner.service \
	/etc/systemd/system/qorpera-company-computer-screens.service
systemctl daemon-reload
# Publication-head sync is retired: the mounted NAS tree is the Company File.
# Remove any stale unit left by an older image-contract install.
systemctl disable --now qorpera-company-computer-sync.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/qorpera-company-computer-sync.service \
	/opt/qorpera-company-computer/qorpera-company-computer-sync.mjs
systemctl daemon-reload
# The provider enables the bootstrap oneshot explicitly after pushing the
# bootstrap files; the published image starts nothing on its own.
systemctl disable \
	qorpera-company-computer-bootstrap.service \
	qorpera-company-computer-runner.service \
	qorpera-company-computer-screens.service \
	>/dev/null 2>&1 || true

manifest_sha256=$(sha256sum "${PACKAGE_ROOT}/manifest.json" | awk '{ print $1 }')
runner_manifest_sha256=$(sha256sum "${PACKAGE_ROOT}/runner/manifest.json" | awk '{ print $1 }')
printf '%s\n' \
	'{' \
	'  "schema": "qorpera.lxd-company-computer-image/v1",' \
	'  "ubuntu_version": "26.04",' \
	'  "architecture": "x86_64",' \
	"  \"guest_package_manifest_sha256\": \"${manifest_sha256}\"," \
	"  \"runner_package_manifest_sha256\": \"${runner_manifest_sha256}\"," \
	"  \"chrome_version\": \"${chrome_version}\"," \
	'  "desktop_stack": "xfce4-tigervnc-chrome"' \
	'}' > /etc/qorpera/lxd-company-computer-image.json
chmod 0644 /etc/qorpera/lxd-company-computer-image.json

if find /var/lib/qorpera-bootstrap -mindepth 1 -type f -print -quit | grep -q .; then
	echo "The published image would contain guest bootstrap secrets." >&2
	exit 1
fi
echo "LXD_COMPANY_COMPUTER_IMAGE_CONTRACT_INSTALLED"
