#!/usr/bin/env bash
set -euo pipefail

# Installs the Company Computer image contract inside the image-builder VM:
# the complete runner guest contract (nested, verified against its own
# manifest), the per-screen desktop stack, and the two standing guest agents.
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
  "install-image-contract.sh",
  "qorpera-company-computer-bootstrap.mjs",
  "qorpera-company-computer-bootstrap.service",
  "qorpera-company-computer-runner.mjs",
  "qorpera-company-computer-runner.service",
  "qorpera-company-computer-screens.mjs",
  "qorpera-company-computer-screens.service",
  "qorpera-company-computer-sync.mjs",
  "qorpera-company-computer-sync.service",
  "qorpera-screen-session",
  "qorpera-screen-wallpaper.svg",
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

# The runner contract first: it installs the pinned runtime, the service
# accounts, the native harnesses, and the signed sandbox image the shared
# machine's execution lane uses unchanged.
bash "${PACKAGE_ROOT}/runner/install-image-contract.sh" "${PACKAGE_ROOT}/runner"

# The ephemeral bootstrap entry stays installed but never fires on a Company
# Computer (its condition file is bootstrap.json, not company-computer.json);
# disable it so the published image has one deterministic entry point.
systemctl disable qorpera-lxd-runner-bootstrap.service >/dev/null 2>&1 || true

export DEBIAN_FRONTEND=noninteractive
apt-get install --yes dbus-x11 librsvg2-bin scrot tigervnc-standalone-server x11-xserver-utils xauth xfce4 xfce4-terminal

for binary in /usr/bin/Xvnc /usr/bin/xfce4-session /usr/bin/dbus-run-session /usr/bin/xset /usr/bin/scrot; do
	if [[ ! -x ${binary} ]]; then
		echo "The desktop stack is missing ${binary}." >&2
		exit 1
	fi
done
if ! getent passwd "${WORK_USER}" >/dev/null; then
	echo "The runner contract did not provide the ${WORK_USER} work account." >&2
	exit 1
fi

install -d -o root -g root -m 0755 /opt/qorpera-company-computer
for artifact in \
	qorpera-company-computer-bootstrap.mjs \
	qorpera-company-computer-runner.mjs \
	qorpera-company-computer-sync.mjs \
	qorpera-company-computer-screens.mjs; do
	install -o root -g root -m 0555 "${PACKAGE_ROOT}/${artifact}" "/opt/qorpera-company-computer/${artifact}"
	node --check "/opt/qorpera-company-computer/${artifact}"
done
install -o root -g root -m 0555 "${PACKAGE_ROOT}/qorpera-screen-session" /usr/local/bin/qorpera-screen-session
bash -n /usr/local/bin/qorpera-screen-session
# The desktop wallpaper every screen wears: rasterized once at install so
# the running guest never needs the SVG toolchain.
install -d -o root -g root -m 0755 /usr/share/backgrounds
rsvg-convert "${PACKAGE_ROOT}/qorpera-screen-wallpaper.svg" -w 2560 -h 1600 -o /usr/share/backgrounds/qorpera-screen.png
chmod 0644 /usr/share/backgrounds/qorpera-screen.png
for unit in \
	qorpera-company-computer-bootstrap.service \
	qorpera-company-computer-runner.service \
	qorpera-company-computer-sync.service \
	qorpera-company-computer-screens.service; do
	install -o root -g root -m 0644 "${PACKAGE_ROOT}/${unit}" "/etc/systemd/system/${unit}"
done

# The dataset mount point exists in the image; the working world only ever
# materializes on the attached NAS share, never on this disposable root.
install -d -o root -g root -m 0755 /srv/qorpera /srv/qorpera/dataset

systemd-analyze verify \
	/etc/systemd/system/qorpera-company-computer-bootstrap.service \
	/etc/systemd/system/qorpera-company-computer-runner.service \
	/etc/systemd/system/qorpera-company-computer-sync.service \
	/etc/systemd/system/qorpera-company-computer-screens.service
systemctl daemon-reload
# The provider enables the bootstrap oneshot explicitly after pushing the
# bootstrap files; the published image starts nothing on its own.
systemctl disable \
	qorpera-company-computer-bootstrap.service \
	qorpera-company-computer-runner.service \
	qorpera-company-computer-sync.service \
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
	'  "desktop_stack": "xfce4-tigervnc"' \
	'}' > /etc/qorpera/lxd-company-computer-image.json
chmod 0644 /etc/qorpera/lxd-company-computer-image.json

if find /var/lib/qorpera-bootstrap -mindepth 1 -type f -print -quit | grep -q .; then
	echo "The published image would contain guest bootstrap secrets." >&2
	exit 1
fi
echo "LXD_COMPANY_COMPUTER_IMAGE_CONTRACT_INSTALLED"
