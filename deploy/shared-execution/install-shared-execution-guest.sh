#!/usr/bin/env bash
# Fail-closed installation of the shared execution service into an execution
# host VM that was booted from the pinned LXD runner guest image. The image
# already carries the runner, native provider host, isolation helper and the
# official harness; this adds the service, the two slot unit templates, one
# account pair per slot and the co-located orchestrator. Nothing in the pinned
# image is replaced.
set -euo pipefail

EXPECTED_SERVICE_SHA256="eac252200fae8cbed86650019065e6e8a78682a4db202627dd3d32b0949693d2"
EXPECTED_SERVICE_UNIT_SHA256="bc3ce4236ebe7e20b3f976c22359446ac3d0913d7c72507d8d2efe207de2fe08"
EXPECTED_HOST_UNIT_SHA256="655247d166a5f7f2a9b64059a8834226277b6097c3d685a970d7167e2c8b4845"
EXPECTED_RUNNER_UNIT_SHA256="3205cf03e721268d27a9b7801ba25aed8d406768432cf232031e147f7ee17fb5"
EXPECTED_ENV_EXAMPLE_SHA256="ae99258bbec425defb2ecc8e5d133e75d3479cb2029fe3e9ecaca9662cc1060f"
EXPECTED_ORCHESTRATOR_SHA256="176eab0132447fcb0ebcf920e3a6e5bad91bc24119ab4e3f8f881aa4bbbb70ee"
EXPECTED_ORCHESTRATOR_UNIT_SHA256="12128aaf4be23d759e940407bf32c99b145aa8e927fe31f730a15ce7c447f4df"
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

node_version=$(node --version | sed 's/^v//')
if ! dpkg --compare-versions "${node_version}" ge 22.19.0; then
	echo "Node.js ${node_version} is older than the controlled minimum." >&2
	exit 1
fi

# One static account pair per slot. The service chowns each slot's scratch to
# them before a run and empties it after; they never share a directory.
for ((slot = 0; slot < SLOT_COUNT; slot++)); do
	for prefix in qorpera-shared-host qorpera-shared-runner; do
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
install -d -o root -g root -m 0700 /etc/qorpera/shared-execution-credentials "${STATE_ROOT}" "${STATE_ROOT}/journals" "${IDENTITY_ROOT}"
install -d -o root -g root -m 0711 "${STATE_ROOT}/slots"
install -d -o qorpera-orchestrator -g qorpera-orchestrator -m 0700 /var/lib/qorpera-orchestrator
install -o root -g root -m 0555 "${STAGING_ROOT}/qorpera-shared-execution-service.mjs" "${INSTALL_ROOT}/qorpera-shared-execution-service.mjs"
install -o root -g root -m 0555 "${STAGING_ROOT}/qorpera-runner-orchestrator.mjs" "${ORCHESTRATOR_ROOT}/qorpera-runner-orchestrator.mjs"
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-execution.service" /etc/systemd/system/qorpera-shared-execution.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-run-host@.service" /etc/systemd/system/qorpera-shared-run-host@.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-shared-runner@.service" /etc/systemd/system/qorpera-shared-runner@.service
install -o root -g root -m 0644 "${STAGING_ROOT}/qorpera-runner-orchestrator.service" /etc/systemd/system/qorpera-runner-orchestrator.service
install -o root -g root -m 0600 "${STAGING_ROOT}/shared-execution.env.example" /etc/qorpera/shared-execution.env.example

/usr/bin/node --check "${INSTALL_ROOT}/qorpera-shared-execution-service.mjs"
/usr/bin/node --check "${ORCHESTRATOR_ROOT}/qorpera-runner-orchestrator.mjs"
/usr/bin/systemd-analyze verify /etc/systemd/system/qorpera-shared-execution.service \
	/etc/systemd/system/qorpera-shared-run-host@.service /etc/systemd/system/qorpera-shared-runner@.service \
	/etc/systemd/system/qorpera-runner-orchestrator.service
systemctl daemon-reload
# Nothing starts here. The operator writes /etc/qorpera/shared-execution.env,
# the credentials directory and /etc/qorpera/runner-orchestrator.env, attaches
# the identity volumes under ${IDENTITY_ROOT}/<computeIdentityId>, then enables
# qorpera-shared-execution.service and qorpera-runner-orchestrator.service.
echo "Shared execution service installed with ${SLOT_COUNT} slots; not started."
