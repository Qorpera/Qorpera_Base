#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_SOURCE_COMMIT="3a4b8b5c229d725b8ce6d47b27f0349b521f3839"
EXPECTED_IMAGE_FINGERPRINT="e6f9e5046eb6909bbdb5ef861a030ce45e7a58ed53bb1bc157aa78792233e06d"
EXPECTED_PACKAGE_ARCHIVE_SHA256="86079a21785f1a60fc176a77c0b6a8f67dc940e455787b63d9d83e5dee0dc0e3"
EXPECTED_PACKAGE_MANIFEST_SHA256="5edcc95298dd82a6af203493c5610527498f03f907da6324bb69bb4fc6b18c5f"
EXPECTED_NATIVE_CODEX_SHA256="2f2c26cfdfacebbcce848fb50cfaaa4e8d0aa3c6ec3c1009123ecf766c8335f7"
EXPECTED_NATIVE_HELPER_SHA256="84bc4ab892cfe18a905a9dfcae9cd5a8206c054ae114af58feb73d63a7931df9"
EXPECTED_NATIVE_PROVIDER_HOST_SHA256="90e3cff0f6e595fb1c8b802d57be07793818f46d54dd8818f9a1ccf24b01d3d9"
EXPECTED_NATIVE_COMPANY_SERVICE_SHA256="23ec747b69de6eccf04c423a0d752a80585e7155318fbf7f6d0d199f453349d5"
EXPECTED_RUNNER_BOOTSTRAP_SHA256="6d5615c2daa931e5f80cdf91262a5f4cd7cd4c3db69f30901e26740686b3a372"
EXPECTED_RUNNER_IMAGE="localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1"
LXD_PROJECT="qorpera-runners"
LXD_IMAGE_PROJECT="default"
LXD_POOL="qorpera-vm"
LXD_PROFILE="qorpera-job-v1"
IMAGE_ALIAS="qorpera-runner-ubuntu-26.04-v55-secret-proof-unsigned"
ACCEPTANCE_INSTANCE="qorpera-runner-image-acceptance-v55"
ACCEPTANCE_MARKER="qorpera.lxd-runner-image-acceptance/v1-v55"
STATE_LOG="/var/log/qorpera-lxd-runner-image-acceptance-v55.txt"

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
if [[ ${image_fingerprint} != "${EXPECTED_IMAGE_FINGERPRINT}" ]]; then
	echo "The unsigned candidate alias does not resolve to the exact signed v55 input fingerprint." >&2
	exit 1
fi
if [[ $(awk '$1 == "user.qorpera.schema:" { print $2 }' <<<"${image_info}") != qorpera.lxd-runner-image/v1 ]] ||
	[[ $(awk '$1 == "user.qorpera.provenance:" { print $2 }' <<<"${image_info}") != unsigned-candidate ]] ||
	[[ $(awk '$1 == "user.qorpera.source_commit:" { print $2 }' <<<"${image_info}") != "${EXPECTED_SOURCE_COMMIT}" ]] ||
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
	env EXPECTED_RUNNER_IMAGE="${EXPECTED_RUNNER_IMAGE}" \
		EXPECTED_NATIVE_CODEX_SHA256="${EXPECTED_NATIVE_CODEX_SHA256}" \
		EXPECTED_NATIVE_HELPER_SHA256="${EXPECTED_NATIVE_HELPER_SHA256}" \
		EXPECTED_NATIVE_PROVIDER_HOST_SHA256="${EXPECTED_NATIVE_PROVIDER_HOST_SHA256}" \
		EXPECTED_NATIVE_COMPANY_SERVICE_SHA256="${EXPECTED_NATIVE_COMPANY_SERVICE_SHA256}" \
		EXPECTED_RUNNER_BOOTSTRAP_SHA256="${EXPECTED_RUNNER_BOOTSTRAP_SHA256}" bash -euo pipefail -c '
	[[ $(id -g qorpera-native-provider) == 42041 ]]
	id -G qorpera-runner | tr " " "\n" | grep -Fxq 42041
	[[ -x /usr/bin/crun ]]
	[[ $(DISABLE_AUTOUPDATER=1 /usr/local/bin/codex --version) == *0.147.0* ]]
	[[ $(DISABLE_AUTOUPDATER=1 /usr/local/bin/claude --version) == 2.1.231* ]]
	[[ $(/opt/qorpera-harnesses/native-company/codex --version) == *0.147.0* ]]
	[[ $(sha256sum /opt/qorpera-harnesses/native-company/codex | cut -d " " -f 1) == "${EXPECTED_NATIVE_CODEX_SHA256}" ]]
	[[ $(sha256sum /opt/qorpera-runner/qorpera-native-isolation-child.mjs | cut -d " " -f 1) == "${EXPECTED_NATIVE_HELPER_SHA256}" ]]
	[[ $(sha256sum /opt/qorpera-runner/qorpera-native-provider-host.mjs | cut -d " " -f 1) == "${EXPECTED_NATIVE_PROVIDER_HOST_SHA256}" ]]
	[[ $(sha256sum /etc/systemd/system/qorpera-native-company-host.service | cut -d " " -f 1) == "${EXPECTED_NATIVE_COMPANY_SERVICE_SHA256}" ]]
	[[ $(sha256sum /opt/qorpera-runner/qorpera-lxd-runner-bootstrap.mjs | cut -d " " -f 1) == "${EXPECTED_RUNNER_BOOTSTRAP_SHA256}" ]]
	[[ $(stat -c "%u:%g:%a:%h" /opt/qorpera-harnesses/native-company/codex) == 0:0:555:1 ]]
	[[ $(stat -c "%u:%g:%a:%h" /opt/qorpera-runner/qorpera-native-isolation-child.mjs) == 0:0:555:1 ]]
	[[ -x /usr/bin/bwrap ]]
	for account in qorpera-company-runner qorpera-native-company; do
		[[ $(id -Gn "${account}") == "${account}" ]]
	done
	for unit in qorpera-company-runner.service qorpera-native-company-host.service; do
		[[ $(systemctl is-enabled "${unit}") == disabled ]]
		[[ $(systemctl is-active "${unit}") == inactive ]]
	done
	install -d -o qorpera-runner -g qorpera-runner -m 0700 /run/qorpera-runner
	cd /var/lib/qorpera-runner
	runuser -u qorpera-runner -- env HOME=/var/lib/qorpera-runner XDG_RUNTIME_DIR=/run/qorpera-runner \
		/usr/bin/podman image exists "${EXPECTED_RUNNER_IMAGE}"
	[[ ! -e /var/lib/qorpera-runner/.config/containers/auth.json ]]
	[[ $(systemctl is-enabled qorpera-lxd-runner-bootstrap.service) == enabled ]]
	[[ $(systemctl is-enabled qorpera-lxd-native-login-bootstrap.service) == disabled ]]
	[[ $(systemctl is-enabled qorpera-ephemeral-runner.service) == disabled ]]
	[[ $(systemctl is-enabled qorpera-native-login-provider-host.service) == disabled ]]
	[[ $(systemctl is-enabled qorpera-native-provider-host.service) == disabled ]]
	[[ $(systemctl is-active qorpera-lxd-runner-bootstrap.service) == inactive ]]
	[[ $(systemctl is-active qorpera-lxd-native-login-bootstrap.service) == inactive ]]
	[[ $(systemctl is-active qorpera-ephemeral-runner.service) == inactive ]]
	[[ $(systemctl is-active qorpera-native-login-provider-host.service) == inactive ]]
	[[ $(systemctl is-active qorpera-native-provider-host.service) == inactive ]]
	grep -Fxq "LoadCredential=qorpera-identity-recovery-ca:/var/lib/qorpera-bootstrap/credentials/qorpera-identity-recovery-ca" /etc/systemd/system/qorpera-native-login-provider-host.service
	grep -Fxq "Environment=NODE_EXTRA_CA_CERTS=/run/credentials/qorpera-native-login-provider-host.service/qorpera-identity-recovery-ca" /etc/systemd/system/qorpera-native-login-provider-host.service
	grep -Fxq "LoadCredential=qorpera-cloud-secret-runtime:/var/lib/qorpera-bootstrap/credentials/qorpera-cloud-secret-runtime" /etc/systemd/system/qorpera-native-company-host.service
	grep -Fxq "LoadCredential=qorpera-cloud-secret-ca:/var/lib/qorpera-bootstrap/credentials/qorpera-cloud-secret-ca" /etc/systemd/system/qorpera-native-company-host.service
	grep -Fxq "Environment=NODE_EXTRA_CA_CERTS=/run/credentials/qorpera-native-company-host.service/qorpera-cloud-secret-ca" /etc/systemd/system/qorpera-native-company-host.service
	[[ ! -e /var/lib/qorpera-bootstrap/bootstrap.json ]]
	[[ ! -e /var/lib/qorpera-bootstrap/login-bootstrap.json ]]
	[[ ! -e /var/lib/qorpera-bootstrap/runner-config.json ]]
	[[ ! -e /var/lib/qorpera-bootstrap/native-provider.env ]]
	[[ ! -e /var/lib/qorpera-bootstrap/native-company.json ]]
	! mountpoint -q /var/lib/qorpera/identity
	! mountpoint -q /var/lib/qorpera-runner
	! find /var/lib/qorpera/identity -mindepth 1 -print -quit | grep -q .
	[[ ! -e /qorpera/company-live ]]
	! find /var/lib/qorpera-bootstrap/credentials -mindepth 1 -print -quit | grep -q .
	! ss -lnt | awk "NR > 1 { print \$4 }" | grep -Eq "(^|:)(7443|8083|8443|9080|9443)$"
	! curl --noproxy "*" --silent --show-error --fail --connect-timeout 2 --max-time 4 \
		-H Metadata:true -o /dev/null \
		"http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net"
'

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "image_alias=${IMAGE_ALIAS}"
	echo "image_fingerprint=${image_fingerprint}"
	echo "source_commit=${EXPECTED_SOURCE_COMMIT}"
	echo "package_archive_sha256=${EXPECTED_PACKAGE_ARCHIVE_SHA256}"
	echo "guest_package_manifest_sha256=${EXPECTED_PACKAGE_MANIFEST_SHA256}"
	echo "runner_image=${EXPECTED_RUNNER_IMAGE}"
	echo "native_codex_sha256=${EXPECTED_NATIVE_CODEX_SHA256}"
	echo "native_helper_sha256=${EXPECTED_NATIVE_HELPER_SHA256}"
	echo "native_provider_host_sha256=${EXPECTED_NATIVE_PROVIDER_HOST_SHA256}"
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
