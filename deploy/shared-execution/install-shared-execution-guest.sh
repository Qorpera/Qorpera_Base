#!/usr/bin/env bash
# Fail-closed installation of the shared execution service into an execution
# host VM that was booted from the pinned LXD runner guest image. The image
# already carries the runner, native provider host, isolation helper and the
# official harness; this adds the service, the two slot unit templates, one
# account pair per slot, the co-located orchestrator, the folder program with
# its mount unit (F3), and the run box: its host program, unit, socket, folder
# unit and a third account per slot (F3 step 2b). Nothing in the pinned image
# is replaced.
set -euo pipefail

EXPECTED_SERVICE_SHA256="8dfc1074b7c4f3570289ed807eb17962a6b06b03b7c45841d9f46bc11f7525db"
EXPECTED_SERVICE_UNIT_SHA256="f673571b39062b664ec2543b46d7b6728c70c4a00ede09dbc327c6a3b0e4b375"
EXPECTED_HOST_UNIT_SHA256="69f0bb557d70125ee8cc7991699af00c8328220d30fec37b154ca8acea7fca06"
EXPECTED_RUNNER_UNIT_SHA256="1e746f965b2d82ac8353f68adcda2dddeeb948aaf9206ad1fb10df63cfb859d4"
EXPECTED_ENV_EXAMPLE_SHA256="0780a9f852eaecaa5cd7fe849235c0b4093c1f18cd935fad3f9b0e104202400c"
EXPECTED_ORCHESTRATOR_SHA256="2a6605135bbdb66a6879298d3d04571cf429738d6b5361d874e7bdec7b940957"
EXPECTED_ORCHESTRATOR_UNIT_SHA256="12128aaf4be23d759e940407bf32c99b145aa8e927fe31f730a15ce7c447f4df"
# The folder program's recorded build (deploy/folder-service/folder-program-linux-x64.json) and its mount unit.
EXPECTED_FOLDER_PROGRAM_SHA256="214e6ea47db0b7f6cf946bd90207a7352dd35cd05c247cb07d121d93a4e33b43"
EXPECTED_FOLDER_MOUNT_UNIT_SHA256="778e1d8475a757cc013bb81e48404e0738fdb2de6e882ed6052bbd8efba1719e"
# The run box (F3 step 2b).
EXPECTED_BOX_HOST_SHA256="5e1f316f28e4b110fff2ba41fb074a24aa99e232e1040e7dbd19f7883da562a5"
EXPECTED_BOX_UNIT_SHA256="37e036cfeeac5969c8832ef98c3da9da546347fafb1d91965765598fea68ed19"
EXPECTED_BOX_SOCKET_SHA256="3dc1ded7bcc1084df6857d2c6c477377a240c6dfa4a37f0cb5ea9c33ed02158e"
EXPECTED_BOX_READS_SOCKET_SHA256="794558361d2caa6280c24499815dadae0d79ccf6f025e8e4ff12d9612bb7f465"
EXPECTED_BOX_FOLDER_UNIT_SHA256="07c16cbde8a7c9b4b2adc8a081541ffd9fcf0328da49ce6a87253251bbf5e0a0"
STAGING_ROOT="/var/lib/qorpera-bootstrap/shared-execution"
SLOT_COUNT="${QORPERA_SHARED_EXECUTION_SLOTS:-16}"
INSTALL_ROOT="/opt/qorpera/shared-execution"
ORCHESTRATOR_ROOT="/opt/qorpera/runner-orchestrator"
STATE_ROOT="/var/lib/qorpera-shared-execution"
IDENTITY_ROOT="/var/lib/qorpera/identities"
INSTALL_LOG="/var/log/qorpera-shared-execution-install.log"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script as root inside the execution host VM." >&2
	exit 1
fi
if ! [[ ${SLOT_COUNT} =~ ^[1-9][0-9]?$ ]] || ((SLOT_COUNT > 64)); then
	echo "QORPERA_SHARED_EXECUTION_SLOTS must be 1..64." >&2
	exit 1
fi
install -o root -g root -m 0644 /dev/null "${INSTALL_LOG}"
exec > >(tee "${INSTALL_LOG}") 2>&1
echo "Starting fail-closed shared execution installation on $(date --iso-8601=seconds)."

for unit in qorpera-shared-execution.service qorpera-runner-orchestrator.service; do
	if systemctl is-active --quiet "${unit}"; then
		echo "Refusing to replace a running ${unit}." >&2
		exit 1
	fi
done
if systemctl list-units --state=active --plain --no-legend 'qorpera-folder-mount@*' 'qorpera-shared-box*' | grep -q .; then
	echo "Refusing to replace the folder program under a running mount or run box." >&2
	exit 1
fi
for artifact in qorpera-ephemeral-runner.mjs qorpera-native-provider-host.mjs qorpera-native-isolation-child.mjs; do
	if [[ ! -f /opt/qorpera-runner/${artifact} ]]; then
		echo "This guest is not the pinned runner image: /opt/qorpera-runner/${artifact} is missing." >&2
		exit 1
	fi
done

verify_sha256() {
	local file=$1
	local expected=$2
	local actual
	if [[ ! -f ${file} || -L ${file} ]]; then
		echo "Missing or unsafe staged file: ${file}" >&2
		exit 1
	fi
	actual=$(sha256sum "${file}" | awk '{ print $1 }')
	if [[ ${actual} != "${expected}" ]]; then
		echo "Checksum mismatch for ${file}." >&2
		exit 1
	fi
}

verify_sha256 "${STAGING_ROOT}/qorpera-shared-execution-service.mjs" "${EXPECTED_SERVICE_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-execution.service" "${EXPECTED_SERVICE_UNIT_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-run-host@.service" "${EXPECTED_HOST_UNIT_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-runner@.service" "${EXPECTED_RUNNER_UNIT_SHA256}"
verify_sha256 "${STAGING_ROOT}/shared-execution.env.example" "${EXPECTED_ENV_EXAMPLE_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-runner-orchestrator.mjs" "${EXPECTED_ORCHESTRATOR_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-runner-orchestrator.service" "${EXPECTED_ORCHESTRATOR_UNIT_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-folder" "${EXPECTED_FOLDER_PROGRAM_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-folder-mount@.service" "${EXPECTED_FOLDER_MOUNT_UNIT_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-box-host.mjs" "${EXPECTED_BOX_HOST_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-box@.service" "${EXPECTED_BOX_UNIT_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-box@.socket" "${EXPECTED_BOX_SOCKET_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-box-folder@.service" "${EXPECTED_BOX_FOLDER_UNIT_SHA256}"
verify_sha256 "${STAGING_ROOT}/qorpera-shared-box-reads@.socket" "${EXPECTED_BOX_READS_SOCKET_SHA256}"

# A long-lived host must stay the pinned image: no unattended package upgrades,
# no needrestart restarting the sandboxes under a run.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service >/dev/null 2>&1 || true
systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service >/dev/null 2>&1 || true

node_version=$(node --version | sed 's/^v//')
if ! dpkg --compare-versions "${node_version}" ge 22.19.0; then
	echo "Node.js ${node_version} is older than the controlled minimum." >&2
	exit 1
fi

# Three static accounts per slot. The service chowns each slot's scratch to
# the host and runner accounts before a run and empties it after; they never
# share a directory. The box account (F3 step 2b) owns nothing on disk: its
# home and /tmp are the box's own memory.
for ((slot = 0; slot < SLOT_COUNT; slot++)); do
	for prefix in qorpera-shared-host qorpera-shared-runner qorpera-shared-box; do
		account="${prefix}-${slot}"
		if ! getent passwd "${account}" >/dev/null; then
			useradd --system --no-create-home --home-dir "${STATE_ROOT}/slots/${slot}" --shell /usr/sbin/nologin "${account}"
		fi
	done
	install -d -o root -g root -m 0711 "${STATE_ROOT}/slots/${slot}"
	install -d -o "qorpera-shared-host-${slot}" -g "qorpera-shared-host-${slot}" -m 0700 "${STATE_ROOT}/slots/${slot}/host"
	install -d -o "qorpera-shared-runner-${slot}" -g "qorpera-shared-runner-${slot}" -m 0700 \
		"${STATE_ROOT}/slots/${slot}/runner" "${STATE_ROOT}/slots/${slot}/runner/state" "${STATE_ROOT}/slots/${slot}/runner/workspace"
done
if ! getent passwd qorpera-orchestrator >/dev/null; then
	useradd --system --create-home --home-dir /var/lib/qorpera-orchestrator --shell /usr/sbin/nologin qorpera-orchestrator
fi

install -d -o root -g root -m 0755 /etc/qorpera "${INSTALL_ROOT}" "${ORCHESTRATOR_ROOT}"
install -d -o root -g root -m 0700 /etc/qorpera/shared-execution-credentials "${STATE_ROOT}/journals" "${IDENTITY_ROOT}"
# Slot accounts traverse the state root to their own scratch; journals stay root-only.
install -d -o root -g root -m 0711 "${STATE_ROOT}" "${STATE_ROOT}/slots"
install -d -o qorpera-orchestrator -g qorpera-orchestrator -m 0700 /var/lib/qorpera-orchestrator
install -o root -g root -m 0555 "${STAGING_ROOT}/qorpera-shared-execution-service.mjs" "${INSTALL_ROOT}/qorpera-shared-execution-service.mjs"
install -o root -g root -m 0555 "${STAGING_ROOT}/qorpera-runner-orchestrator.mjs" "${ORCHESTRATOR_ROOT}/qorpera-runner-orchestrator.mjs"
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-execution.service" /etc/systemd/system/qorpera-shared-execution.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-run-host@.service" /etc/systemd/system/qorpera-shared-run-host@.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-runner@.service" /etc/systemd/system/qorpera-shared-runner@.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-runner-orchestrator.service" /etc/systemd/system/qorpera-runner-orchestrator.service
install -o root -g root -m 0600 "${STAGING_ROOT}/shared-execution.env.example" /etc/qorpera/shared-execution.env.example
# The folder program (F3): mounts live under /srv/qorpera-folder (root only; the slot units also hide it), each from
# a view file in /etc/qorpera-folder/mounts. No mount starts here.
install -d -o root -g root -m 0755 /opt/qorpera-folder
install -o root -g root -m 0555 "${STAGING_ROOT}/qorpera-folder" /opt/qorpera-folder/qorpera-folder
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-folder-mount@.service" /etc/systemd/system/qorpera-folder-mount@.service
install -d -o root -g root -m 0700 /etc/qorpera-folder /etc/qorpera-folder/mounts /srv/qorpera-folder
/opt/qorpera-folder/qorpera-folder version
# The run box (F3 step 2b): its host program, its units, and the empty mount point of its company folder. No box
# starts here; the service starts each run's box.
install -o root -g root -m 0555 "${STAGING_ROOT}/qorpera-shared-box-host.mjs" "${INSTALL_ROOT}/qorpera-shared-box-host.mjs"
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-box@.service" /etc/systemd/system/qorpera-shared-box@.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-box@.socket" /etc/systemd/system/qorpera-shared-box@.socket
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-box-folder@.service" /etc/systemd/system/qorpera-shared-box-folder@.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-box-reads@.socket" /etc/systemd/system/qorpera-shared-box-reads@.socket
install -d -o root -g root -m 0755 /company
if [[ ! -c /dev/fuse ]] || ! grep -qw fuse /proc/filesystems; then
	# Runs do not need it yet; a folder mount will not start until the image has FUSE.
	echo "Warning: this host has no FUSE (/dev/fuse or the fuse filesystem is missing); folder mounts cannot start."
fi

/usr/bin/node --check "${INSTALL_ROOT}/qorpera-shared-execution-service.mjs"
/usr/bin/node --check "${ORCHESTRATOR_ROOT}/qorpera-runner-orchestrator.mjs"
/usr/bin/node --check "${INSTALL_ROOT}/qorpera-shared-box-host.mjs"
/usr/bin/systemd-analyze verify /etc/systemd/system/qorpera-shared-execution.service \
	/etc/systemd/system/qorpera-shared-run-host@.service /etc/systemd/system/qorpera-shared-runner@.service \
	/etc/systemd/system/qorpera-runner-orchestrator.service /etc/systemd/system/qorpera-shared-box@.service \
	/etc/systemd/system/qorpera-shared-box@.socket /etc/systemd/system/qorpera-shared-box-folder@.service \
	/etc/systemd/system/qorpera-shared-box-reads@.socket
systemctl daemon-reload
# Nothing starts here. The operator writes /etc/qorpera/shared-execution.env,
# the credentials directory and /etc/qorpera/runner-orchestrator.env, attaches
# the identity volumes under ${IDENTITY_ROOT}/<computeIdentityId>, then enables
# qorpera-shared-execution.service and qorpera-runner-orchestrator.service.
echo "Shared execution service installed with ${SLOT_COUNT} slots; not started."
