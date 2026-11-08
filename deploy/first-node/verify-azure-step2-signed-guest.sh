#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="qorpera-step2-compat-01"
EXPECTED_LXD_VERSION="6.9-ab8fad2"
EXPECTED_LXD_REVISION="40424"
EXPECTED_NODE_PACKAGE_VERSION="22.22.1+dfsg+~cs22.19.15-1ubuntu1"
EXPECTED_NODE_VERSION="v22.22.1"
EXPECTED_ZFSUTILS_PACKAGE_VERSION="2.4.1-1ubuntu5"
EXPECTED_IMAGE_FINGERPRINT="f3f763287ee3fe7ba3e31926be8341b2e1567e35283e129f673edb4d5a75d67a"
EXPECTED_IMAGE_BYTES="2398885127"
EXPECTED_PROVENANCE_SHA256="d5bf211f0244290515ffd13eb67581245c8ed767775c54f17ee7e8fb4af22cd8"
EXPECTED_PUBLIC_KEY_SHA256="b62d24b8335468ef39cd7e16a50beb9d5ddab7343c4e5695273cd0a8d8bb1039"
EXPECTED_PROVENANCE_TOOL_SHA256="316006ebe6d263cb716ebf0fbed0917d170f47e777d25838b5720706f787dcec"
EXPECTED_ISOLATION_PROBE_SHA256="d3cbd357fff10c807b95b9d8d261f66e4275d38770805f9123c68a85083e8607"
EXPECTED_ISOLATION_SERVICE_SHA256="0661eaf12145c4fe7aae77b4b6bf362fcae9fa8ecd727b32f22a1fd5177bbd6f"
EXPECTED_MOUTH_PROBE_SHA256="630feca01afe9774d2426e71baf9972351df2c13f71d777c66836a1d8704a932"
EXPECTED_MOUTH_HARNESS_SHA256="55f2c3d0e1daa669227758858dc0e5816e328402bf85c1d04a04feefaa377e5d"
EXPECTED_PACKAGE_MANIFEST_SHA256="873ceaf8a51b4028f77a901d5e5a1320a536dec09c5b2f5b96cee98d50444193"
EXPECTED_NATIVE_CODEX_SHA256="2f2c26cfdfacebbcce848fb50cfaaa4e8d0aa3c6ec3c1009123ecf766c8335f7"
EXPECTED_NATIVE_HELPER_SHA256="84bc4ab892cfe18a905a9dfcae9cd5a8206c054ae114af58feb73d63a7931df9"
EXPECTED_RUNNER_IMAGE="localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1"
EXPECTED_RUNNER_ARCHIVE_SHA256="c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239"
EXPECTED_RUNNER_COSIGN_SHA256="98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce"
EXPECTED_INSTANCE_MARKER="qorpera.azure-step2-signed-guest-acceptance/v1"

PILOT_ROOT="/var/lib/qorpera-step2-phase-a"
PILOT_VERIFIER="${PILOT_ROOT}/verify-azure-step2-signed-guest.sh"
IMAGE_ARCHIVE="${PILOT_ROOT}/qorpera-azure-step2-v52.tar.gz"
PROVENANCE="${PILOT_ROOT}/lxd-image-provenance-v52.json"
PUBLIC_KEY="${PILOT_ROOT}/lxd-image-provenance.pub.pem"
PROVENANCE_TOOL="${PILOT_ROOT}/qorpera-lxd-image-provenance.mjs"
ISOLATION_PROBE="${PILOT_ROOT}/qorpera-native-isolation-probe.mjs"
ISOLATION_SERVICE="${PILOT_ROOT}/qorpera-step2-phase-a-isolation.service"
MOUTH_PROBE="${PILOT_ROOT}/azure-step2-synthetic-mouth.mjs"
MOUTH_HARNESS="${PILOT_ROOT}/cloud-mouth-harness.cjs"
INITIAL_STATE="${PILOT_ROOT}/initial-state.env"
ACCEPTANCE_LOG="/var/log/qorpera-azure-step2-signed-guest.log"

LXD_PROJECT="qorpera-runners"
LXD_POOL="qorpera-vm"
LXD_PROFILE="qorpera-job-v1"
LXD_NETWORK="qorpera0"
IMAGE_ALIAS="qorpera-runner-ubuntu-26.04-v52-signed-pilot"
INSTANCE="qorpera-step2-phase-a-v52"
PERSISTENCE_MARKER="/var/lib/qorpera-step2-phase-a-persistence.txt"
PERSISTENCE_TEXT="qorpera-azure-phase-a-retained-disk-v1"

usage() {
	echo "Usage: $0 --initial|--post-host-reboot|--cleanup|--stage-self EXPECTED_SHA256" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
	usage
	exit 64
fi
mode=$1
stage_self=false
case ${mode} in
	--initial | --post-host-reboot | --cleanup)
		[[ $# -eq 1 ]] || {
			usage
			exit 64
		}
		;;
	--stage-self | stage-self)
		[[ $# -eq 2 && $2 =~ ^[0-9a-f]{64}$ ]] || {
			usage
			exit 64
		}
		stage_self=true
		expected_stage_sha256=$2
		;;
	*)
		usage
		exit 64
		;;
esac
if [[ ${EUID} -ne 0 ]]; then
	echo "Run this verifier through Azure Run Command as root." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to verify an unexpected host: $(hostname)." >&2
	exit 1
fi
if [[ ${stage_self} == true ]]; then
	install -d -o root -g root -m 0700 "${PILOT_ROOT}"
	stage_tmp=$(mktemp "${PILOT_ROOT}/.verifier-stage.XXXXXX")
	awk '
		NR == 1 { print; next }
		!source_started && /^export arg[0-9]+=/ { next }
		!source_started && /^set -- / { next }
		{ source_started=1; print }
	' "$0" >"${stage_tmp}"
	if [[ $(sha256sum "${stage_tmp}" | awk '{ print $1 }') != "${expected_stage_sha256}" ]]; then
		unlink "${stage_tmp}"
		echo "Azure Run Command changed the submitted verifier bytes." >&2
		exit 1
	fi
	install -o root -g root -m 0600 "${stage_tmp}" "${PILOT_VERIFIER}"
	unlink "${stage_tmp}"
	echo "AZURE_STEP2_SIGNED_GUEST_VERIFIER_STAGED"
	sha256sum "${PILOT_VERIFIER}"
	exit 0
fi

instance_is_recognized() {
	[[ $(lxc config get "${INSTANCE}" user.qorpera.acceptance_test --project "${LXD_PROJECT}" 2>/dev/null || true) == "${EXPECTED_INSTANCE_MARKER}" ]]
}

cleanup_instance() {
	if ! lxc info "${INSTANCE}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
		return
	fi
	if ! instance_is_recognized; then
		echo "Refusing to remove an unrecognized instance named ${INSTANCE}." >&2
		exit 1
	fi
	lxc delete "${INSTANCE}" --project "${LXD_PROJECT}" --force
}

stop_instance_durably() {
	lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- sync
	lxc stop "${INSTANCE}" --project "${LXD_PROJECT}" --timeout 120
	[[ $(lxc info "${INSTANCE}" --project "${LXD_PROJECT}" | awk '/^Status:/ { print $2 }') == STOPPED ]]
	zpool sync qorpera-azure-step2
}

if [[ ${mode} == --cleanup ]]; then
	cleanup_instance
	echo "AZURE_STEP2_SIGNED_GUEST_SYNTHETIC_INSTANCE_REMOVED"
	exit 0
fi

if [[ ! -e ${ACCEPTANCE_LOG} ]]; then
	install -o root -g root -m 0644 /dev/null "${ACCEPTANCE_LOG}"
fi
exec > >(tee -a "${ACCEPTANCE_LOG}") 2>&1
echo "Starting ${mode} acceptance at $(date --iso-8601=seconds)."

verify_file() {
	local path=$1
	local expected_sha=$2
	[[ -f ${path} ]] || {
		echo "Missing pilot acceptance file: ${path}." >&2
		exit 1
	}
	[[ $(sha256sum "${path}" | awk '{ print $1 }') == "${expected_sha}" ]] || {
		echo "Pilot acceptance file digest mismatch: ${path}." >&2
		exit 1
	}
}

verify_host() {
	[[ -c /dev/kvm ]]
	[[ -c /dev/tpmrm0 || -c /dev/tpm0 ]]
	local installed_version installed_revision
	installed_version=$(snap list lxd | awk 'NR == 2 { print $2 }')
	installed_revision=$(snap list lxd | awk 'NR == 2 { print $3 }')
	[[ ${installed_version} == "${EXPECTED_LXD_VERSION}" ]]
	[[ ${installed_revision} == "${EXPECTED_LXD_REVISION}" ]]
	[[ $(snap list lxd | awk 'NR == 2 { print $NF }') == held ]]
	[[ $(dpkg-query --show --showformat='${Version}' nodejs) == "${EXPECTED_NODE_PACKAGE_VERSION}" ]]
	[[ $(node --version) == "${EXPECTED_NODE_VERSION}" ]]
	[[ $(dpkg-query --show --showformat='${Version}' zfsutils-linux) == "${EXPECTED_ZFSUTILS_PACKAGE_VERSION}" ]]
	for held_package in nodejs zfsutils-linux; do
		apt-mark showhold | grep -Fxq "${held_package}"
	done
	# Only the loopback listener for the services' own client certificates may exist.
	local loopback_listener='^((127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4})?$'
	[[ $(lxc config get core.https_address) =~ ${loopback_listener} ]]
	[[ -z $(ss -lnt | awk 'NR > 1 && $4 ~ /:8443$/ && $4 !~ /^(127\.0\.0\.1|\[::1\]):8443$/ { print $4 }') ]]
	[[ $(lxc storage show "${LXD_POOL}" | awk '$1 == "driver:" { print $2 }') == zfs ]]
	[[ $(lxc storage get "${LXD_POOL}" source) == qorpera-azure-step2 ]]
	[[ $(lxc network get "${LXD_NETWORK}" ipv4.nat) == true ]]
	[[ $(lxc network get "${LXD_NETWORK}" ipv6.address) == none ]]
	[[ $(lxc profile get "${LXD_PROFILE}" boot.mode --project "${LXD_PROJECT}") == uefi-secureboot ]]
	for property in security.mac_filtering security.ipv4_filtering security.ipv6_filtering security.port_isolation; do
		[[ $(lxc profile device get "${LXD_PROFILE}" eth0 "${property}" --project "${LXD_PROJECT}") == true ]]
	done
	[[ $(lxc profile device get "${LXD_PROFILE}" eth0 network --project "${LXD_PROJECT}") == "${LXD_NETWORK}" ]]
	zpool status -x qorpera-azure-step2 | grep -Fxq "pool 'qorpera-azure-step2' is healthy"
}

verify_inputs() {
	[[ $(stat -c %s "${IMAGE_ARCHIVE}") == "${EXPECTED_IMAGE_BYTES}" ]]
	verify_file "${IMAGE_ARCHIVE}" "${EXPECTED_IMAGE_FINGERPRINT}"
	verify_file "${PROVENANCE}" "${EXPECTED_PROVENANCE_SHA256}"
	verify_file "${PUBLIC_KEY}" "${EXPECTED_PUBLIC_KEY_SHA256}"
	verify_file "${PROVENANCE_TOOL}" "${EXPECTED_PROVENANCE_TOOL_SHA256}"
	verify_file "${ISOLATION_PROBE}" "${EXPECTED_ISOLATION_PROBE_SHA256}"
	verify_file "${ISOLATION_SERVICE}" "${EXPECTED_ISOLATION_SERVICE_SHA256}"
	verify_file "${MOUTH_PROBE}" "${EXPECTED_MOUTH_PROBE_SHA256}"
	verify_file "${MOUTH_HARNESS}" "${EXPECTED_MOUTH_HARNESS_SHA256}"
	node "${PROVENANCE_TOOL}" verify \
		--provenance "${PROVENANCE}" \
		--public-key "${PUBLIC_KEY}" \
		--image-server local \
		--image-fingerprint "${EXPECTED_IMAGE_FINGERPRINT}" \
		--guest-package-manifest-sha256 "${EXPECTED_PACKAGE_MANIFEST_SHA256}" \
		--runner-image "${EXPECTED_RUNNER_IMAGE}" \
		--runner-image-archive-sha256 "${EXPECTED_RUNNER_ARCHIVE_SHA256}" \
		--runner-image-cosign-bundle-sha256 "${EXPECTED_RUNNER_COSIGN_SHA256}"
}

import_image() {
	if ! lxc image info "${EXPECTED_IMAGE_FINGERPRINT}" --project default >/dev/null 2>&1; then
		lxc image import "${IMAGE_ARCHIVE}" --alias "${IMAGE_ALIAS}" --project default
	fi
	local image_info
	image_info=$(lxc image info "${EXPECTED_IMAGE_FINGERPRINT}" --project default)
	[[ $(awk '/^Fingerprint:/ { print $2 }' <<<"${image_info}") == "${EXPECTED_IMAGE_FINGERPRINT}" ]]
	[[ $(awk '$1 == "user.qorpera.schema:" { print $2 }' <<<"${image_info}") == qorpera.lxd-runner-image/v1 ]]
	[[ $(awk '$1 == "user.qorpera.guest_package_manifest_sha256:" { print $2 }' <<<"${image_info}") == "${EXPECTED_PACKAGE_MANIFEST_SHA256}" ]]
	[[ $(awk '$1 == "user.qorpera.runner_image:" { print $2 }' <<<"${image_info}") == "${EXPECTED_RUNNER_IMAGE}" ]]
	if ! lxc image alias list --project default --format csv | cut -d, -f1 | grep -Fxq "${IMAGE_ALIAS}"; then
		lxc image alias create "${IMAGE_ALIAS}" "${EXPECTED_IMAGE_FINGERPRINT}" --project default
	fi
}

wait_for_guest() {
	local ready=false
	for _attempt in $(seq 1 180); do
		if lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- true >/dev/null 2>&1; then
			ready=true
			break
		fi
		sleep 2
	done
	[[ ${ready} == true ]] || {
		echo "The signed pilot guest agent did not become ready." >&2
		exit 1
	}
	lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- timeout 300 cloud-init status --wait
}

verify_guest_contract() {
	local instance_json instance_type secure_boot contract
	instance_json=$(lxc query "/1.0/instances/${INSTANCE}?project=${LXD_PROJECT}")
	instance_type=$(INSTANCE_JSON="${instance_json}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["INSTANCE_JSON"])
print(payload.get("metadata", payload)["type"])
PY
)
	[[ ${instance_type} == virtual-machine ]]
	[[ $(lxc config get "${INSTANCE}" boot.mode --project "${LXD_PROJECT}") == uefi-secureboot ]]
	secure_boot=$(lxc config uefi get "${INSTANCE}" SecureBootEnable-f0a30bc7-af08-4556-99c4-001009c93a44 --project "${LXD_PROJECT}")
	[[ ${secure_boot} == 01 ]]
	[[ $(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- systemd-detect-virt) == kvm ]]
	contract=$(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- cat /etc/qorpera/lxd-runner-image.json)
	CONTRACT="${contract}" EXPECTED_MANIFEST="${EXPECTED_PACKAGE_MANIFEST_SHA256}" EXPECTED_RUNNER_IMAGE="${EXPECTED_RUNNER_IMAGE}" python3 - <<'PY'
import json
import os

contract = json.loads(os.environ["CONTRACT"])
expected = {
    "schema": "qorpera.lxd-runner-image/v1",
    "ubuntu_version": "26.04",
    "architecture": "x86_64",
    "guest_package_manifest_sha256": os.environ["EXPECTED_MANIFEST"],
    "codex_version": "0.147.0",
    "claude_code_version": "2.1.231",
    "runner_image": os.environ["EXPECTED_RUNNER_IMAGE"],
    "native_execution_gid": 42041,
}
for key, value in expected.items():
    if contract.get(key) != value:
        raise SystemExit(f"signed guest contract mismatch: {key}")
if set(contract) != set(expected) | {"node_version", "podman_version"}:
    raise SystemExit("signed guest contract contains unexpected fields")
PY
	lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- env \
		EXPECTED_RUNNER_IMAGE="${EXPECTED_RUNNER_IMAGE}" \
		EXPECTED_NATIVE_CODEX_SHA256="${EXPECTED_NATIVE_CODEX_SHA256}" \
		EXPECTED_NATIVE_HELPER_SHA256="${EXPECTED_NATIVE_HELPER_SHA256}" \
		bash -euo pipefail -c '
		[[ $(id -g qorpera-native-provider) == 42041 ]]
		id -G qorpera-runner | tr " " "\n" | grep -Fxq 42041
		[[ $(sha256sum /opt/qorpera-harnesses/native-company/codex | cut -d " " -f 1) == "${EXPECTED_NATIVE_CODEX_SHA256}" ]]
		[[ $(sha256sum /opt/qorpera-runner/qorpera-native-isolation-child.mjs | cut -d " " -f 1) == "${EXPECTED_NATIVE_HELPER_SHA256}" ]]
		[[ $(stat -c "%u:%g:%a:%h" /opt/qorpera-harnesses/native-company/codex) == 0:0:555:1 ]]
		for unit in qorpera-company-runner.service qorpera-native-company-host.service qorpera-ephemeral-runner.service qorpera-native-provider-host.service; do
			[[ $(systemctl is-enabled "${unit}") == disabled ]]
			[[ $(systemctl is-active "${unit}") == inactive ]]
		done
		[[ ! -e /var/lib/qorpera-bootstrap/bootstrap.json ]]
		[[ ! -e /var/lib/qorpera-bootstrap/login-bootstrap.json ]]
		[[ ! -e /var/lib/qorpera-bootstrap/runner-config.json ]]
		[[ ! -e /var/lib/qorpera-bootstrap/native-provider.env ]]
		[[ ! -e /var/lib/qorpera-bootstrap/native-company.json ]]
		! mountpoint -q /var/lib/qorpera/identity
		! mountpoint -q /var/lib/qorpera-runner
		[[ ! -e /qorpera/company-live ]]
		! find /var/lib/qorpera-bootstrap/credentials -mindepth 1 -print -quit | grep -q .
		! ss -lnt | awk "NR > 1 { print \$4 }" | grep -Eq "(^|:)(7443|8083)$"
		cd /var/lib/qorpera-runner
		install -d -o qorpera-runner -g qorpera-runner -m 0700 /run/qorpera-runner
		runuser -u qorpera-runner -- env HOME=/var/lib/qorpera-runner XDG_RUNTIME_DIR=/run/qorpera-runner /usr/bin/podman image exists "${EXPECTED_RUNNER_IMAGE}"
		[[ ! -e /var/lib/qorpera-runner/.config/containers/auth.json ]]'
	echo "AZURE_STEP2_SIGNED_GUEST_CONTRACT_VERIFIED"
}

run_synthetic_probes() {
	local secret_tmp
	secret_tmp=$(mktemp)
	printf '%s\n' SYNTHETIC_SYSTEMD_SECRET >"${secret_tmp}"
	lxc file push "${ISOLATION_PROBE}" "${INSTANCE}/usr/local/lib/qorpera-native-isolation-probe.mjs" --project "${LXD_PROJECT}" --mode 0555 --uid 0 --gid 0
	lxc file push "${ISOLATION_SERVICE}" "${INSTANCE}/etc/systemd/system/qorpera-step2-phase-a-isolation.service" --project "${LXD_PROJECT}" --mode 0444 --uid 0 --gid 0
	lxc file push "${MOUTH_PROBE}" "${INSTANCE}/usr/local/lib/azure-step2-synthetic-mouth.mjs" --project "${LXD_PROJECT}" --mode 0555 --uid 0 --gid 0
	lxc file push "${MOUTH_HARNESS}" "${INSTANCE}/usr/local/lib/cloud-mouth-harness.cjs" --project "${LXD_PROJECT}" --mode 0444 --uid 0 --gid 0
	lxc file push "${secret_tmp}" "${INSTANCE}/opt/qorpera-runner/synthetic-host-secret" --project "${LXD_PROJECT}" --mode 0400 --uid 0 --gid 0
	rm -f -- "${secret_tmp}"
	lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- systemctl daemon-reload
	lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- systemctl start qorpera-step2-phase-a-isolation.service
	local state
	for _attempt in $(seq 1 120); do
		state=$(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- systemctl show -p ActiveState --value qorpera-step2-phase-a-isolation.service)
		[[ ${state} == inactive || ${state} == failed ]] && break
		sleep 1
	done
	[[ ${state} == inactive ]]
	[[ $(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- systemctl show -p Result --value qorpera-step2-phase-a-isolation.service) == success ]]
	local isolation_log
	isolation_log=$(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- journalctl -u qorpera-step2-phase-a-isolation.service --no-pager)
	grep -Fq PRODUCTION_SERVICE_CGROUP_LIMITS_CONFIRMED <<<"${isolation_log}"
	grep -Fq PRIVATE_RESULT_FENCE_AND_REVOCATION_CONFIRMED <<<"${isolation_log}"
	grep -Fq NATIVE_ISOLATION_PROBE_PASSED <<<"${isolation_log}"
	printf '%s\n' "${isolation_log}"
	lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- runuser -u qorpera-native-company -- /usr/bin/node /usr/local/lib/azure-step2-synthetic-mouth.mjs
	echo "AZURE_STEP2_SYNTHETIC_BOUNDARIES_VERIFIED"
}

verify_host
verify_inputs
import_image

if [[ ${mode} == --initial ]]; then
	cleanup_instance
	lxc init "${EXPECTED_IMAGE_FINGERPRINT}" "${INSTANCE}" \
		--project "${LXD_PROJECT}" \
		--profile "${LXD_PROFILE}" \
		--storage "${LXD_POOL}" \
		--config boot.mode=uefi-secureboot \
		--config limits.cpu=2 \
		--config limits.memory=4GiB \
		--config user.qorpera.acceptance_test="${EXPECTED_INSTANCE_MARKER}" \
		--device root,size=80GiB
	lxc start "${INSTANCE}" --project "${LXD_PROJECT}"
	wait_for_guest
	verify_guest_contract
	run_synthetic_probes
	lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- sh -c "printf '%s\\n' '${PERSISTENCE_TEXT}' > '${PERSISTENCE_MARKER}' && chmod 0400 '${PERSISTENCE_MARKER}' && sync -f '${PERSISTENCE_MARKER}'"
	guest_boot_id=$(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- cat /proc/sys/kernel/random/boot_id)
	marker_sha=$(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- sha256sum "${PERSISTENCE_MARKER}" | awk '{ print $1 }')
	state_tmp=$(mktemp)
	{
		echo "outer_boot_id=$(cat /proc/sys/kernel/random/boot_id)"
		echo "guest_boot_id=${guest_boot_id}"
		echo "marker_sha256=${marker_sha}"
	} >"${state_tmp}"
	install -o root -g root -m 0400 "${state_tmp}" "${INITIAL_STATE}"
	rm -f -- "${state_tmp}"
	stop_instance_durably
	echo "AZURE_STEP2_SIGNED_GUEST_INITIAL_ACCEPTANCE_PASSED"
	echo "guest_state=stopped_for_outer_host_reboot"
	exit 0
fi

[[ -f ${INITIAL_STATE} ]]
source "${INITIAL_STATE}"
[[ ${outer_boot_id:-} =~ ^[0-9a-f-]{36}$ ]]
[[ ${guest_boot_id:-} =~ ^[0-9a-f-]{36}$ ]]
[[ ${marker_sha256:-} =~ ^[0-9a-f]{64}$ ]]
[[ $(cat /proc/sys/kernel/random/boot_id) != "${outer_boot_id}" ]]
lxc info "${INSTANCE}" --project "${LXD_PROJECT}" >/dev/null
instance_is_recognized
[[ $(lxc info "${INSTANCE}" --project "${LXD_PROJECT}" | awk '/^Status:/ { print $2 }') == STOPPED ]]
lxc start "${INSTANCE}" --project "${LXD_PROJECT}"
wait_for_guest
new_guest_boot_id=$(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- cat /proc/sys/kernel/random/boot_id)
[[ ${new_guest_boot_id} != "${guest_boot_id}" ]]
[[ $(lxc exec "${INSTANCE}" --project "${LXD_PROJECT}" -- sha256sum "${PERSISTENCE_MARKER}" | awk '{ print $1 }') == "${marker_sha256}" ]]
verify_guest_contract
run_synthetic_probes
stop_instance_durably
echo "AZURE_STEP2_SIGNED_GUEST_REBOOT_REPLAY_PASSED"
echo "retained_disk_marker_sha256=${marker_sha256}"
echo "guest_state=stopped"
