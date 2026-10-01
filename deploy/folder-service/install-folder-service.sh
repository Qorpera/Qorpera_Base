#!/usr/bin/env bash
# Installs the folder service and its vsock bridge on a node host from a package made by
# scripts/package-folder-service.mjs. Verifies every file against the package's manifest and the unit files
# against the pins below, makes the two accounts, installs, and leaves every unit disabled. The coordinator then
# writes /etc/qorpera-folder-service/{config.json,supabase-key} (root, 0400) and enables the socket and the bridge.
set -euo pipefail

EXPECTED_SOCKET_UNIT_SHA256="dbf2b45f55312a1bd94cf19b89d0ea6f33e367d4a996ade854f13fb5d453bbd9"
EXPECTED_SERVICE_UNIT_SHA256="3c79680b0c9b1d204909ea8091408d9dcb349db9d61ecbe17d050fc3c6d9b2bb"
EXPECTED_BRIDGE_UNIT_SHA256="6ab230f7857640564f354d4a3307d764893cedaff2e383d9a5dacea4ae85ac88"
PACKAGE=$(cd "$(dirname "$0")" && pwd)
INSTALL_ROOT="/opt/qorpera-folder-service"
CONFIG_ROOT="/etc/qorpera-folder-service"

if [[ $# -ne 0 ]]; then
	echo "Usage: $0 (run from the unpacked package)" >&2
	exit 64
fi
if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script as root." >&2
	exit 1
fi
for unit in qorpera-folder-service.socket qorpera-folder-service.service qorpera-folder-bridge.service; do
	if systemctl is-active --quiet "${unit}"; then
		echo "${unit} is running; stop it before installing." >&2
		exit 1
	fi
done

sha() { sha256sum "$1" | awk '{ print $1 }'; }
verify() {
	local file=$1 expected=$2
	if [[ ! -f ${file} || -L ${file} ]]; then
		echo "Missing or unsafe file: ${file}" >&2
		exit 1
	fi
	if [[ $(sha "${file}") != "${expected}" ]]; then
		echo "Checksum mismatch for ${file}." >&2
		exit 1
	fi
}
# Every file the package lists, against the manifest; the manifest's own hash is printed for the build record.
python3 - "${PACKAGE}" <<'PY'
import hashlib, json, os, sys
root = sys.argv[1]
manifest = json.load(open(os.path.join(root, "manifest.json")))
assert manifest["schema"] == "qorpera.folder-service-package/v1", "unknown package"
for artifact in manifest["artifacts"]:
    path = os.path.join(root, artifact["file"])
    assert not os.path.islink(path) and os.path.isfile(path), f"missing or unsafe {artifact['file']}"
    data = open(path, "rb").read()
    assert len(data) == artifact["bytes"] and hashlib.sha256(data).hexdigest() == artifact["sha256"], f"checksum mismatch for {artifact['file']}"
PY
echo "package manifest sha256 $(sha "${PACKAGE}/manifest.json")"
verify "${PACKAGE}/qorpera-folder-service.socket" "${EXPECTED_SOCKET_UNIT_SHA256}"
verify "${PACKAGE}/qorpera-folder-service.service" "${EXPECTED_SERVICE_UNIT_SHA256}"
verify "${PACKAGE}/qorpera-folder-bridge.service" "${EXPECTED_BRIDGE_UNIT_SHA256}"
node_version=$(/usr/bin/node --version)
if ! /usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'; then
	echo "Node.js ${node_version} is too old: 22.19.0 or newer is needed." >&2
	exit 1
fi
/usr/bin/node --check "${PACKAGE}/qorpera-folder-service.mjs"
"${PACKAGE}/qorpera-folder" version

for account in qorpera-folder qorpera-folder-bridge; do
	id -u "${account}" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "${account}"
done
install -d -o root -g root -m 0755 "${INSTALL_ROOT}"
install -o root -g root -m 0444 "${PACKAGE}/qorpera-folder-service.mjs" "${INSTALL_ROOT}/qorpera-folder-service.mjs"
install -o root -g root -m 0555 "${PACKAGE}/qorpera-folder" "${INSTALL_ROOT}/qorpera-folder"
install -o root -g root -m 0444 "${PACKAGE}/README.md" "${INSTALL_ROOT}/README.md"
install -d -o root -g root -m 0700 "${CONFIG_ROOT}"
for unit in qorpera-folder-service.socket qorpera-folder-service.service qorpera-folder-bridge.service; do
	install -o root -g root -m 0644 "${PACKAGE}/${unit}" "/etc/systemd/system/${unit}"
done
systemd-analyze verify /etc/systemd/system/qorpera-folder-service.socket /etc/systemd/system/qorpera-folder-service.service /etc/systemd/system/qorpera-folder-bridge.service
systemctl daemon-reload
echo "installed: folder service $(sha "${INSTALL_ROOT}/qorpera-folder-service.mjs"), folder program $(sha "${INSTALL_ROOT}/qorpera-folder"); units disabled"
