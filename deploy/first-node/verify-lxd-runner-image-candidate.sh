#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_PACKAGE_MANIFEST_SHA256="19348a0efa77df090ff98781ce33ca585705290fe52e9bb72bc3f5a5dead4274"
EXPECTED_RUNNER_IMAGE="localhost/qorpera/sandbox-probe:96c2e17ec75cc0a1d5ed7a4e7c582ecd53ce2954@sha256:bc4b4543cd7c3a048188458eeab11bfa4b183aa1686b9c89fc012fc3e2c8987e"
LXD_PROJECT="qorpera-runners"
LXD_IMAGE_PROJECT="default"
LXD_POOL="qorpera-vm"
LXD_PROFILE="qorpera-job-v1"
IMAGE_ALIAS="qorpera-runner-ubuntu-26.04-v13-unsigned"
ACCEPTANCE_INSTANCE="qorpera-runner-image-acceptance-v13"
ACCEPTANCE_MARKER="qorpera.lxd-runner-image-acceptance/v1"
STATE_LOG="/var/log/qorpera-lxd-runner-image-acceptance.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to verify on unexpected host $(hostname)." >&2
	exit 1
fi
if [[ $(lxc config get core.https_address) != "" ]]; then
	echo "The LXD daemon unexpectedly exposes a remote listener." >&2
	exit 1
fi

image_info=$(lxc image info "${IMAGE_ALIAS}" --project "${LXD_IMAGE_PROJECT}")
image_fingerprint=$(awk '/^Fingerprint:/ { print $2 }' <<<"${image_info}")
if [[ ! ${image_fingerprint} =~ ^[0-9a-f]{64}$ ]]; then
	echo "The unsigned candidate alias does not resolve to an immutable image fingerprint." >&2
	exit 1
fi
if [[ $(awk '$1 == "user.qorpera.schema:" { print $2 }' <<<"${image_info}") != qorpera.lxd-runner-image/v1 ]] ||
	[[ $(awk '$1 == "user.qorpera.provenance:" { print $2 }' <<<"${image_info}") != unsigned-candidate ]] ||
	[[ $(awk '$1 == "user.qorpera.guest_package_manifest_sha256:" { print $2 }' <<<"${image_info}") != "${EXPECTED_PACKAGE_MANIFEST_SHA256}" ]] ||
	[[ $(awk '$1 == "user.qorpera.runner_image:" { print $2 }' <<<"${image_info}") != "${EXPECTED_RUNNER_IMAGE}" ]]; then
	echo "The local candidate image properties do not match the acceptance recipe." >&2
	exit 1
fi

cleanup_acceptance_vm() {
	if ! lxc info "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
		return
	fi
	if [[ $(lxc config get "${ACCEPTANCE_INSTANCE}" user.qorpera.acceptance_test --project "${LXD_PROJECT}" 2>/dev/null || true) != "${ACCEPTANCE_MARKER}" ]]; then
		echo "Refusing to remove an unrecognized instance named ${ACCEPTANCE_INSTANCE}." >&2
		return 1
	fi
	lxc delete "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" --force
}

if lxc info "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
	if [[ $(lxc config get "${ACCEPTANCE_INSTANCE}" user.qorpera.acceptance_test --project "${LXD_PROJECT}" 2>/dev/null || true) != "${ACCEPTANCE_MARKER}" ]]; then
		echo "An unrelated instance already uses the acceptance-test name." >&2
		exit 1
	fi
	cleanup_acceptance_vm
fi
trap cleanup_acceptance_vm EXIT HUP INT TERM

echo "Booting the unsigned runner candidate without credentials or an identity volume."
lxc init "${image_fingerprint}" "${ACCEPTANCE_INSTANCE}" \
	--project "${LXD_PROJECT}" \
	--profile "${LXD_PROFILE}" \
	--storage "${LXD_POOL}" \
	--config boot.mode=uefi-secureboot \
	--config limits.cpu=2 \
	--config limits.memory=4GiB \
	--config user.qorpera.acceptance_test="${ACCEPTANCE_MARKER}" \
	--device root,size=80GiB
lxc start "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}"

agent_ready=false
for _attempt in $(seq 1 180); do
	if lxc exec "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" -- true >/dev/null 2>&1; then
		agent_ready=true
		break
	fi
	sleep 2
done
if [[ ${agent_ready} != true ]]; then
	echo "The candidate VM agent did not become ready." >&2
	exit 1
fi
lxc exec "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" -- timeout 300 cloud-init status --wait

instance_json=$(lxc query "/1.0/instances/${ACCEPTANCE_INSTANCE}?project=${LXD_PROJECT}")
instance_type=$(INSTANCE_JSON="${instance_json}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["INSTANCE_JSON"])
metadata = payload.get("metadata", payload)
print(metadata["type"])
PY
)
if [[ ${instance_type} != virtual-machine ]] ||
	[[ $(lxc config get "${ACCEPTANCE_INSTANCE}" boot.mode --project "${LXD_PROJECT}") != uefi-secureboot ]]; then
	echo "The candidate did not boot at the required full-VM Secure Boot boundary." >&2
	exit 1
fi
secure_boot=$(lxc config uefi get "${ACCEPTANCE_INSTANCE}" SecureBootEnable-f0a30bc7-af08-4556-99c4-001009c93a44 \
	--project "${LXD_PROJECT}")
if [[ ${secure_boot} != 01 ]] ||
	[[ $(lxc exec "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" -- systemd-detect-virt) != kvm ]]; then
	echo "The candidate did not prove KVM and UEFI Secure Boot inside the guest." >&2
	exit 1
fi

contract=$(lxc exec "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" -- cat /etc/qorpera/lxd-runner-image.json)
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
        raise SystemExit(f"candidate image contract mismatch: {key}")
if set(contract) != set(expected) | {"node_version", "podman_version"}:
    raise SystemExit("candidate image contract contains unexpected fields")
PY

lxc exec "${ACCEPTANCE_INSTANCE}" --project "${LXD_PROJECT}" -- \
	env EXPECTED_RUNNER_IMAGE="${EXPECTED_RUNNER_IMAGE}" bash -euo pipefail -c '
	[[ $(id -g qorpera-native-provider) == 42041 ]]
	id -G qorpera-runner | tr " " "\n" | grep -Fxq 42041
	[[ -x /usr/bin/crun ]]
	[[ $(DISABLE_AUTOUPDATER=1 /usr/local/bin/codex --version) == *0.147.0* ]]
	[[ $(DISABLE_AUTOUPDATER=1 /usr/local/bin/claude --version) == 2.1.231* ]]
	install -d -o qorpera-runner -g qorpera-runner -m 0700 /run/qorpera-runner
	cd /var/lib/qorpera-runner
	runuser -u qorpera-runner -- env HOME=/var/lib/qorpera-runner XDG_RUNTIME_DIR=/run/qorpera-runner \
		/usr/bin/podman image exists "${EXPECTED_RUNNER_IMAGE}"
	[[ ! -e /var/lib/qorpera-runner/.config/containers/auth.json ]]
	[[ $(systemctl is-enabled qorpera-lxd-runner-bootstrap.service) == enabled ]]
	[[ $(systemctl is-enabled qorpera-lxd-native-login-bootstrap.service) == disabled ]]
	[[ $(systemctl is-enabled qorpera-ephemeral-runner.service) == disabled ]]
	[[ $(systemctl is-enabled qorpera-native-provider-host.service) == disabled ]]
	[[ $(systemctl is-active qorpera-lxd-runner-bootstrap.service) == inactive ]]
	[[ $(systemctl is-active qorpera-lxd-native-login-bootstrap.service) == inactive ]]
	[[ $(systemctl is-active qorpera-ephemeral-runner.service) == inactive ]]
	[[ $(systemctl is-active qorpera-native-provider-host.service) == inactive ]]
	[[ ! -e /var/lib/qorpera-bootstrap/bootstrap.json ]]
	[[ ! -e /var/lib/qorpera-bootstrap/login-bootstrap.json ]]
	[[ ! -e /var/lib/qorpera-bootstrap/runner-config.json ]]
	[[ ! -e /var/lib/qorpera-bootstrap/native-provider.env ]]
	! find /var/lib/qorpera-bootstrap/credentials -mindepth 1 -print -quit | grep -q .
	! ss -lnt | awk "NR > 1 { print \$4 }" | grep -Eq "(^|:)(7443|8083)$"
'

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "image_alias=${IMAGE_ALIAS}"
	echo "image_fingerprint=${image_fingerprint}"
	echo "guest_package_manifest_sha256=${EXPECTED_PACKAGE_MANIFEST_SHA256}"
	echo "runner_image=${EXPECTED_RUNNER_IMAGE}"
	echo "instance_type=${instance_type}"
	echo "virtualization=kvm"
	echo "boot_mode=uefi-secureboot"
	echo "secure_boot_variable=${secure_boot}"
	echo "no_job_boot=fail_closed"
	echo "provenance=unsigned-candidate"
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${STATE_LOG}"
rm -f -- "${state_tmp}"

cleanup_acceptance_vm
trap - EXIT HUP INT TERM
echo "LXD_RUNNER_IMAGE_CANDIDATE_ACCEPTED_UNSIGNED"
echo "fingerprint=${image_fingerprint}"
echo "The provider must remain disabled until this exact fingerprint receives signed provenance."
