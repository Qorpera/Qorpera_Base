#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-orchestrator-01"
EXPECTED_ARTIFACT_SHA256="1019b5fe449f112544983ded7a3e9eec6a2e84cdd38fbc29bc79bf9a34cc5e2f"
EXPECTED_UNIT_SHA256="12128aaf4be23d759e940407bf32c99b145aa8e927fe31f730a15ce7c447f4df"
EXPECTED_ENV_EXAMPLE_SHA256="da884ac435d4c34d8e00957ddfb17ce31fd9adb1993254c98667ddaed513de5b"
STAGING_ROOT="/var/lib/qorpera-bootstrap/orchestrator"
ARTIFACT_SOURCE="${STAGING_ROOT}/qorpera-runner-orchestrator.mjs"
UNIT_SOURCE="${STAGING_ROOT}/qorpera-runner-orchestrator.service"
ENV_EXAMPLE_SOURCE="${STAGING_ROOT}/runner-orchestrator.env.example"
INSTALL_ROOT="/opt/qorpera/runner-orchestrator"
SERVICE_NAME="qorpera-runner-orchestrator.service"
SERVICE_USER="qorpera-orchestrator"
STATE_ROOT="/var/lib/qorpera-orchestrator"
INSTALL_LOG="/var/log/qorpera-runner-orchestrator-install.log"
STATE_LOG="/var/log/qorpera-runner-orchestrator-state.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script as root inside the management VM." >&2
	exit 1
fi

install -o root -g root -m 0644 /dev/null "${INSTALL_LOG}"
exec > >(tee "${INSTALL_LOG}") 2>&1
echo "Starting fail-closed Runner Orchestrator installation on $(date --iso-8601=seconds)."

if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to install on unexpected guest $(hostname)." >&2
	exit 1
fi
if systemctl is-active --quiet "${SERVICE_NAME}"; then
	echo "Refusing to replace a running Runner Orchestrator." >&2
	exit 1
fi

configuration=absent-fail-closed
if [[ -e /etc/qorpera/runner-orchestrator.env ]]; then
	if [[ ! -f /etc/qorpera/runner-orchestrator.env || -L /etc/qorpera/runner-orchestrator.env ]]; then
		echo "Refusing an unsafe existing Runner Orchestrator configuration." >&2
		exit 1
	fi
	if [[ $(stat -c '%U:%G:%a' /etc/qorpera/runner-orchestrator.env) != root:root:600 ]]; then
		echo "Refusing an incorrectly owned or readable Runner Orchestrator configuration." >&2
		exit 1
	fi
	configuration=present-preserved
fi

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

verify_sha256 "${ARTIFACT_SOURCE}" "${EXPECTED_ARTIFACT_SHA256}"
verify_sha256 "${UNIT_SOURCE}" "${EXPECTED_UNIT_SHA256}"
verify_sha256 "${ENV_EXAMPLE_SOURCE}" "${EXPECTED_ENV_EXAMPLE_SHA256}"

apt-get update
apt-get install --yes ca-certificates nodejs
node_version=$(node --version | sed 's/^v//')
if ! dpkg --compare-versions "${node_version}" ge 22.19.0; then
	echo "Node.js ${node_version} is older than the controlled orchestrator minimum." >&2
	exit 1
fi

if ! getent passwd "${SERVICE_USER}" >/dev/null; then
	useradd --system --create-home --home-dir "${STATE_ROOT}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o root -g root -m 0755 /etc/qorpera "${INSTALL_ROOT}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0700 "${STATE_ROOT}"
install -o root -g root -m 0755 "${ARTIFACT_SOURCE}" "${INSTALL_ROOT}/qorpera-runner-orchestrator.mjs"
install -o root -g root -m 0644 "${UNIT_SOURCE}" "/etc/systemd/system/${SERVICE_NAME}"
install -o root -g root -m 0600 "${ENV_EXAMPLE_SOURCE}" /etc/qorpera/runner-orchestrator.env.example

/usr/bin/node --check "${INSTALL_ROOT}/qorpera-runner-orchestrator.mjs"
/usr/bin/systemd-analyze verify "/etc/systemd/system/${SERVICE_NAME}"
systemctl daemon-reload
systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
if systemctl is-enabled --quiet "${SERVICE_NAME}"; then
	echo "The Runner Orchestrator unexpectedly became enabled." >&2
	exit 1
fi

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "node=$(node --version)"
	echo "artifact_sha256=$(sha256sum "${INSTALL_ROOT}/qorpera-runner-orchestrator.mjs" | awk '{ print $1 }')"
	echo "unit_load_state=$(systemctl show "${SERVICE_NAME}" -p LoadState --value)"
	echo "unit_file_state=$(systemctl show "${SERVICE_NAME}" -p UnitFileState --value)"
	echo "unit_active_state=$(systemctl show "${SERVICE_NAME}" -p ActiveState --value)"
	echo "configuration=${configuration}"
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${STATE_LOG}"
rm -f "${state_tmp}"

echo "RUNNER_ORCHESTRATOR_UNIT_INSTALLED_DISABLED"
echo "artifact=${INSTALL_ROOT}/qorpera-runner-orchestrator.mjs"
echo "configuration=/etc/qorpera/runner-orchestrator.env (${configuration})"
