#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_VM_BASE_IMAGE="30b6ca7d8a783322d35995b382ccc3a807ca56a2e6dba577a55bb6a439a5480d"
EXPECTED_ARTIFACT_SHA256="f1f456ab9319acf8a02d1af33994d2975acb05d5b486e83a5f9fee0f489b5eb7"
EXPECTED_INSTALLER_SHA256="59282b0420915f62b6011c794f4d6dddd3f85411daedc007c3f9512561ae1e43"
EXPECTED_UNIT_SHA256="12128aaf4be23d759e940407bf32c99b145aa8e927fe31f730a15ce7c447f4df"
EXPECTED_ENV_EXAMPLE_SHA256="da884ac435d4c34d8e00957ddfb17ce31fd9adb1993254c98667ddaed513de5b"
STAGING_ROOT="/home/company41-admin/step2-lxd"
ARTIFACT_SOURCE="${STAGING_ROOT}/qorpera-runner-orchestrator.mjs"
INSTALLER_SOURCE="${STAGING_ROOT}/install-runner-orchestrator-guest.sh"
UNIT_SOURCE="${STAGING_ROOT}/qorpera-runner-orchestrator.service"
ENV_EXAMPLE_SOURCE="${STAGING_ROOT}/runner-orchestrator.env.example"
LXD_PROJECT="qorpera-runners"
LXD_PROFILE="qorpera-management-v1"
VM_NAME="company41-orchestrator-01"
VM_ADDRESS="10.41.0.2"
VM_MARKER="qorpera.runner-orchestrator-management-vm/v1"
GUEST_STAGING_ROOT="/var/lib/qorpera-bootstrap/orchestrator"
SERVICE_NAME="qorpera-runner-orchestrator.service"
STATE_LOG="/var/log/qorpera-runner-orchestrator-update.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo on the LXD host." >&2
	exit 1
fi
if [[ $# -ne 0 ]]; then
	echo "Usage: $0" >&2
	exit 2
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to update on unexpected host $(hostname)." >&2
	exit 1
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
verify_sha256 "${INSTALLER_SOURCE}" "${EXPECTED_INSTALLER_SHA256}"
verify_sha256 "${UNIT_SOURCE}" "${EXPECTED_UNIT_SHA256}"
verify_sha256 "${ENV_EXAMPLE_SOURCE}" "${EXPECTED_ENV_EXAMPLE_SHA256}"

instance_json=$(lxc query "/1.0/instances/${VM_NAME}?project=${LXD_PROJECT}")
if ! INSTANCE_JSON="${instance_json}" \
	EXPECTED_IMAGE="${EXPECTED_VM_BASE_IMAGE}" \
	EXPECTED_MARKER="${VM_MARKER}" \
	EXPECTED_PROFILE="${LXD_PROFILE}" \
	EXPECTED_ADDRESS="${VM_ADDRESS}" \
	python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["INSTANCE_JSON"])
instance = payload.get("metadata", payload)
config = instance.get("config", {})
devices = instance.get("devices", {})
expected = (
    instance.get("type") == "virtual-machine"
    and instance.get("profiles") == [os.environ["EXPECTED_PROFILE"]]
    and config.get("volatile.base_image") == os.environ["EXPECTED_IMAGE"]
    and config.get("user.qorpera.management_vm") == os.environ["EXPECTED_MARKER"]
    and devices.get("eth0", {}).get("ipv4.address") == os.environ["EXPECTED_ADDRESS"]
)
raise SystemExit(0 if expected else 1)
PY
then
	echo "Refusing to update a drifted management VM." >&2
	exit 1
fi
if [[ $(lxc info "${VM_NAME}" --project "${LXD_PROJECT}" | awk '/^Status:/ { print $2 }') != RUNNING ]]; then
	echo "The recognized management VM must already be running for a controlled update." >&2
	exit 1
fi
if lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- systemctl is-active --quiet "${SERVICE_NAME}"; then
	echo "Refusing to replace a running Runner Orchestrator." >&2
	exit 1
fi
if lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- systemctl is-enabled --quiet "${SERVICE_NAME}"; then
	echo "Refusing to update while the Runner Orchestrator is enabled." >&2
	exit 1
fi
if [[ $(lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- stat -c '%U:%G:%a' /etc/qorpera/runner-orchestrator.env) != root:root:600 ]]; then
	echo "The existing Runner Orchestrator configuration is unsafe." >&2
	exit 1
fi
configuration_before=$(lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- sha256sum /etc/qorpera/runner-orchestrator.env | awk '{ print $1 }')

lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- install -d -o root -g root -m 0700 "${GUEST_STAGING_ROOT}"
lxc file push "${ARTIFACT_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/qorpera-runner-orchestrator.mjs" --project "${LXD_PROJECT}"
lxc file push "${INSTALLER_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/install-runner-orchestrator-guest.sh" --project "${LXD_PROJECT}"
lxc file push "${UNIT_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/qorpera-runner-orchestrator.service" --project "${LXD_PROJECT}"
lxc file push "${ENV_EXAMPLE_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/runner-orchestrator.env.example" --project "${LXD_PROJECT}"
lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- chmod 0700 "${GUEST_STAGING_ROOT}/install-runner-orchestrator-guest.sh"
lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- bash "${GUEST_STAGING_ROOT}/install-runner-orchestrator-guest.sh"

configuration_after=$(lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- sha256sum /etc/qorpera/runner-orchestrator.env | awk '{ print $1 }')
if [[ ${configuration_after} != "${configuration_before}" ]]; then
	echo "The Runner Orchestrator configuration changed during the update." >&2
	exit 1
fi
if lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- systemctl is-enabled --quiet "${SERVICE_NAME}" ||
	lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- systemctl is-active --quiet "${SERVICE_NAME}"; then
	echo "The updated Runner Orchestrator did not remain disabled and inactive." >&2
	exit 1
fi
if [[ $(lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- sha256sum /opt/qorpera/runner-orchestrator/qorpera-runner-orchestrator.mjs | awk '{ print $1 }') != "${EXPECTED_ARTIFACT_SHA256}" ]]; then
	echo "The installed Runner Orchestrator bundle does not match the candidate." >&2
	exit 1
fi

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "vm=${VM_NAME}"
	echo "vm_base_image=${EXPECTED_VM_BASE_IMAGE}"
	echo "artifact_sha256=${EXPECTED_ARTIFACT_SHA256}"
	echo "service=disabled-inactive"
	echo "configuration=present-preserved"
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${STATE_LOG}"
rm -f "${state_tmp}"

echo "RUNNER_ORCHESTRATOR_UPDATED_DISABLED"
echo "vm=${VM_NAME} artifact_sha256=${EXPECTED_ARTIFACT_SHA256}"
echo "configuration=present-preserved"
