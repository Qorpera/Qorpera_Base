#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_ARTIFACT_SHA256="41dbdaa7003d1915d9a4a48b0be973f5851d2b5be611c0c1916cbaf3bbca4112"
EXPECTED_INSTALLER_SHA256="3cc37749acf0dd3f1b9c62b33c1ff3a6ce4a7d81813f425d78fee33bc6b0f3cd"
EXPECTED_UNIT_SHA256="12128aaf4be23d759e940407bf32c99b145aa8e927fe31f730a15ce7c447f4df"
EXPECTED_ENV_EXAMPLE_SHA256="da884ac435d4c34d8e00957ddfb17ce31fd9adb1993254c98667ddaed513de5b"
EXPECTED_RUNNER_IMAGE="localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1"
EXPECTED_RUNNER_IMAGE_ARCHIVE_SHA256="c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239"
EXPECTED_RUNNER_IMAGE_COSIGN_BUNDLE_SHA256="98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce"
STAGING_ROOT="/home/company41-admin/step2-lxd"
ARTIFACT_SOURCE="${STAGING_ROOT}/qorpera-runner-orchestrator.mjs"
INSTALLER_SOURCE="${STAGING_ROOT}/install-runner-orchestrator-guest.sh"
UNIT_SOURCE="${STAGING_ROOT}/qorpera-runner-orchestrator.service"
ENV_EXAMPLE_SOURCE="${STAGING_ROOT}/runner-orchestrator.env.example"
PROVENANCE_TOOL="/opt/qorpera/runner-provider/qorpera-lxd-image-provenance.mjs"
PROVENANCE_FILE="/etc/qorpera/lxd-image-provenance.json"
PROVENANCE_PUBLIC_KEY="/etc/qorpera/lxd-image-provenance.pub"
LXD_PROJECT="qorpera-runners"
LXD_POOL="qorpera-vm"
LXD_PROFILE="qorpera-management-v1"
VM_NAME="company41-orchestrator-01"
VM_ADDRESS="10.41.0.2"
VM_MARKER="qorpera.runner-orchestrator-management-vm/v1"
GUEST_STAGING_ROOT="/var/lib/qorpera-bootstrap/orchestrator"
STATE_LOG="/var/log/qorpera-lxd-orchestrator-vm.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo on the LXD host." >&2
	exit 1
fi
if [[ $# -ne 2 || ! $1 =~ ^[0-9a-f]{64}$ || ! $2 =~ ^[0-9a-f]{64}$ ]]; then
	echo "Usage: $0 <signed-image-fingerprint> <guest-package-manifest-sha256>" >&2
	exit 2
fi
image_fingerprint=$1
guest_manifest_sha256=$2

if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to provision on unexpected host $(hostname)." >&2
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

cloud_init_ready_without_devlxd() {
	local vm=$1
	local encoded
	local cloud_init_exit
	set +e
	encoded=$(lxc exec "${vm}" --project "${LXD_PROJECT}" -- /usr/bin/cloud-init status --wait --format json 2>/dev/null)
	cloud_init_exit=$?
	set -e
	if [[ ${cloud_init_exit} -ne 2 ]]; then
		return 1
	fi
	CLOUD_INIT_STATUS="${encoded}" python3 - <<'PY'
import json
import os

try:
    status = json.loads(os.environ["CLOUD_INIT_STATUS"])
except (KeyError, json.JSONDecodeError):
    raise SystemExit(1)

allowed_warnings = {"/dev/lxd/sock does not exist.", "Used fallback datasource"}
warnings = status.get("recoverable_errors", {}).get("WARNING")
if (
    status.get("status") != "done"
    or status.get("extended_status") != "degraded done"
    or status.get("datasource") != "none"
    or status.get("detail") != "DataSourceNone"
    or status.get("errors") != []
    or set(status.get("recoverable_errors", {})) != {"WARNING"}
    or not isinstance(warnings, list)
    or set(warnings) != allowed_warnings
):
    raise SystemExit(1)

for stage_name in ("init-local", "init", "modules-config", "modules-final"):
    stage = status.get(stage_name)
    if not isinstance(stage, dict) or stage.get("errors") != []:
        raise SystemExit(1)
    recoverable = stage.get("recoverable_errors", {})
    if set(recoverable) - {"WARNING"}:
        raise SystemExit(1)
    if any(warning not in allowed_warnings for warning in recoverable.get("WARNING", [])):
        raise SystemExit(1)
PY
}

if [[ ! -x ${PROVENANCE_TOOL} || ! -r ${PROVENANCE_FILE} || ! -r ${PROVENANCE_PUBLIC_KEY} ]]; then
	echo "Signed LXD image provenance is not installed on the host." >&2
	exit 1
fi
/usr/bin/node "${PROVENANCE_TOOL}" verify \
	--provenance "${PROVENANCE_FILE}" \
	--public-key "${PROVENANCE_PUBLIC_KEY}" \
	--image-server local \
	--image-fingerprint "${image_fingerprint}" \
	--guest-package-manifest-sha256 "${guest_manifest_sha256}" \
	--runner-image "${EXPECTED_RUNNER_IMAGE}" \
	--runner-image-archive-sha256 "${EXPECTED_RUNNER_IMAGE_ARCHIVE_SHA256}" \
	--runner-image-cosign-bundle-sha256 "${EXPECTED_RUNNER_IMAGE_COSIGN_BUNDLE_SHA256}"

if ! lxc profile show "${LXD_PROFILE}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
	echo "The dedicated management VM profile is missing; rerun the controlled host bootstrap." >&2
	exit 1
fi
for setting in security.mac_filtering security.ipv4_filtering security.ipv6_filtering security.port_isolation; do
	if [[ $(lxc profile device get "${LXD_PROFILE}" eth0 "${setting}" --project "${LXD_PROJECT}") != true ]]; then
		echo "The management profile does not enforce ${setting}." >&2
		exit 1
	fi
done
if [[ $(lxc profile get "${LXD_PROFILE}" boot.mode --project "${LXD_PROJECT}") != uefi-secureboot ]] ||
	[[ $(lxc profile get "${LXD_PROFILE}" security.devlxd --project "${LXD_PROJECT}") != false ]]; then
	echo "The management profile does not enforce Secure Boot and a disabled DevLXD channel." >&2
	exit 1
fi

if lxc info "${VM_NAME}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
	instance_json=$(lxc query "/1.0/instances/${VM_NAME}?project=${LXD_PROJECT}")
	if ! INSTANCE_JSON="${instance_json}" \
		EXPECTED_IMAGE="${image_fingerprint}" \
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
		echo "Refusing to reuse a drifted management VM." >&2
		exit 1
	fi
else
	lxc init "${image_fingerprint}" "${VM_NAME}" \
		--project "${LXD_PROJECT}" \
		--profile "${LXD_PROFILE}" \
		--storage "${LXD_POOL}" \
		--vm \
		--config boot.mode=uefi-secureboot \
		--config boot.autostart=true \
		--config limits.cpu=2 \
		--config limits.memory=2GiB \
		--config user.qorpera.management_vm="${VM_MARKER}" \
		--device eth0,ipv4.address="${VM_ADDRESS}" \
		--device root,size=96GiB
fi

if [[ $(lxc info "${VM_NAME}" --project "${LXD_PROJECT}" | awk '/^Status:/ { print $2 }') != RUNNING ]]; then
	lxc start "${VM_NAME}" --project "${LXD_PROJECT}"
fi
guest_ready=false
for _attempt in $(seq 1 180); do
	if cloud_init_ready_without_devlxd "${VM_NAME}"; then
		guest_ready=true
		break
	fi
	sleep 2
done
if [[ ${guest_ready} != true ]]; then
	echo "The management VM did not become ready." >&2
	exit 1
fi
if ! lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- /bin/sh -c \
	"hostname -I | tr ' ' '\n' | grep -Fxq '${VM_ADDRESS}'"; then
	echo "The management VM did not receive its source-fenced address." >&2
	exit 1
fi

lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- /usr/bin/install -d -o root -g root -m 0700 "${GUEST_STAGING_ROOT}"
lxc file push "${ARTIFACT_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/qorpera-runner-orchestrator.mjs" --project "${LXD_PROJECT}"
lxc file push "${INSTALLER_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/install-runner-orchestrator-guest.sh" --project "${LXD_PROJECT}"
lxc file push "${UNIT_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/qorpera-runner-orchestrator.service" --project "${LXD_PROJECT}"
lxc file push "${ENV_EXAMPLE_SOURCE}" "${VM_NAME}${GUEST_STAGING_ROOT}/runner-orchestrator.env.example" --project "${LXD_PROJECT}"
lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- /usr/bin/chmod 0700 "${GUEST_STAGING_ROOT}/install-runner-orchestrator-guest.sh"
lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- /usr/bin/bash "${GUEST_STAGING_ROOT}/install-runner-orchestrator-guest.sh"

if lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- /usr/bin/systemctl is-enabled --quiet qorpera-runner-orchestrator.service ||
	lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- /usr/bin/systemctl is-active --quiet qorpera-runner-orchestrator.service; then
	echo "The management VM service did not remain disabled." >&2
	exit 1
fi
if lxc exec "${VM_NAME}" --project "${LXD_PROJECT}" -- /bin/sh -c \
	'id -nG qorpera-orchestrator | tr " " "\n" | grep -Fxq lxd'; then
	echo "The orchestrator service account unexpectedly has LXD authority." >&2
	exit 1
fi

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "vm=${VM_NAME}"
	echo "project=${LXD_PROJECT}"
	echo "profile=${LXD_PROFILE}"
	echo "image_fingerprint=${image_fingerprint}"
	echo "guest_package_manifest_sha256=${guest_manifest_sha256}"
	echo "runner_image=${EXPECTED_RUNNER_IMAGE}"
	echo "runner_image_archive_sha256=${EXPECTED_RUNNER_IMAGE_ARCHIVE_SHA256}"
	echo "runner_image_cosign_bundle_sha256=${EXPECTED_RUNNER_IMAGE_COSIGN_BUNDLE_SHA256}"
	echo "ipv4_address=${VM_ADDRESS}"
	echo "service=installed-disabled"
	echo "lxd_authority=absent"
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${STATE_LOG}"
rm -f "${state_tmp}"

echo "RUNNER_ORCHESTRATOR_MANAGEMENT_VM_READY_DISABLED"
echo "vm=${VM_NAME} address=${VM_ADDRESS}"
echo "Install the private provider CA and real environment before enabling the service."
