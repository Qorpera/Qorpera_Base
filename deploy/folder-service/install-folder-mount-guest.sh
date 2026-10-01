#!/usr/bin/env bash
# Installs the folder program and its mount unit inside a machine (step 1: the execution host), from a package
# made by scripts/package-folder-service.mjs and pushed into the machine. Verifies the files, installs, and
# enables nothing. The coordinator then writes /etc/qorpera-folder/mounts/<id>.json (root, 0600) and starts
# qorpera-folder-mount@<id>. An image rebuild replaces the machine's disk, so this runs again after one (step 2
# moves the program into the shared-execution package).
set -euo pipefail

EXPECTED_MOUNT_UNIT_SHA256="984a236cd49ee40a83de8fefefd546ff90dcd4c3d379a7a56f516abd6df6cd89"
PACKAGE=$(cd "$(dirname "$0")" && pwd)

if [[ $# -ne 0 ]]; then
	echo "Usage: $0 (run from the unpacked package, inside the machine)" >&2
	exit 64
fi
if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script as root." >&2
	exit 1
fi
if systemctl list-units --state=active --plain --no-legend 'qorpera-folder-mount@*' | grep -q .; then
	echo "A folder mount is running; stop it before installing." >&2
	exit 1
fi
sha() { sha256sum "$1" | awk '{ print $1 }'; }
python3 - "${PACKAGE}" <<'PY'
import hashlib, json, os, sys
root = sys.argv[1]
manifest = json.load(open(os.path.join(root, "manifest.json")))
assert manifest["schema"] == "qorpera.folder-service-package/v1", "unknown package"
for artifact in manifest["artifacts"]:
    if artifact["file"] not in ("qorpera-folder", "qorpera-folder-mount@.service", "README.md"):
        continue
    path = os.path.join(root, artifact["file"])
    assert not os.path.islink(path) and os.path.isfile(path), f"missing or unsafe {artifact['file']}"
    data = open(path, "rb").read()
    assert len(data) == artifact["bytes"] and hashlib.sha256(data).hexdigest() == artifact["sha256"], f"checksum mismatch for {artifact['file']}"
PY
echo "package manifest sha256 $(sha "${PACKAGE}/manifest.json")"
if [[ $(sha "${PACKAGE}/qorpera-folder-mount@.service") != "${EXPECTED_MOUNT_UNIT_SHA256}" ]]; then
	echo "Checksum mismatch for qorpera-folder-mount@.service." >&2
	exit 1
fi
if [[ ! -c /dev/fuse ]] || ! grep -qw fuse /proc/filesystems; then
	echo "This machine has no FUSE (/dev/fuse or the fuse filesystem is missing)." >&2
	exit 1
fi
"${PACKAGE}/qorpera-folder" version

install -d -o root -g root -m 0755 /opt/qorpera-folder
install -o root -g root -m 0555 "${PACKAGE}/qorpera-folder" /opt/qorpera-folder/qorpera-folder
install -o root -g root -m 0444 "${PACKAGE}/README.md" /opt/qorpera-folder/README.md
install -d -o root -g root -m 0700 /etc/qorpera-folder /etc/qorpera-folder/mounts
install -o root -g root -m 0644 "${PACKAGE}/qorpera-folder-mount@.service" /etc/systemd/system/qorpera-folder-mount@.service
systemctl daemon-reload
echo "installed: folder program $(sha /opt/qorpera-folder/qorpera-folder); no mount started"
