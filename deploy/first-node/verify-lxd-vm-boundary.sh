#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
LXD_PROJECT="qorpera-runners"
LXD_POOL="qorpera-vm"
LXD_PROFILE="qorpera-job-v1"
GUEST_IMAGE="ubuntu:26.04"
SMOKE_NAME="qorpera-vm-smoke"
SMOKE_MARKER="qorpera.first-node-vm-smoke/v1"
VERIFY_LOG="/var/log/qorpera-lxd-vm-boundary.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to run on unexpected host $(hostname)." >&2
	exit 1
fi
if ! lxc query /1.0 >/dev/null 2>&1; then
	echo "The local LXD API is unavailable." >&2
	exit 1
fi

cleanup_smoke_vm() {
	if ! lxc info "${SMOKE_NAME}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
		return
	fi
	if [[ $(lxc config get "${SMOKE_NAME}" user.qorpera.smoke_test --project "${LXD_PROJECT}") != "${SMOKE_MARKER}" ]]; then
		echo "Refusing to remove an unrecognized instance named ${SMOKE_NAME}." >&2
		return 1
	fi
	lxc delete "${SMOKE_NAME}" --project "${LXD_PROJECT}" --force
}

if lxc info "${SMOKE_NAME}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
	if [[ $(lxc config get "${SMOKE_NAME}" user.qorpera.smoke_test --project "${LXD_PROJECT}") != "${SMOKE_MARKER}" ]]; then
		echo "An unrelated instance already uses the smoke-test name." >&2
		exit 1
	fi
	cleanup_smoke_vm
fi
trap cleanup_smoke_vm EXIT

echo "Creating a disposable Ubuntu 26.04 full VM. The first run downloads the official cloud image."
lxc init "${GUEST_IMAGE}" "${SMOKE_NAME}" \
	--vm \
	--project "${LXD_PROJECT}" \
	--profile "${LXD_PROFILE}" \
	--storage "${LXD_POOL}" \
	--config boot.mode=uefi-secureboot \
	--config limits.cpu=2 \
	--config limits.memory=2GiB \
	--config user.qorpera.smoke_test="${SMOKE_MARKER}" \
	--device root,size=16GiB
lxc start "${SMOKE_NAME}" --project "${LXD_PROJECT}"

agent_ready=false
for _attempt in $(seq 1 180); do
	if lxc exec "${SMOKE_NAME}" --project "${LXD_PROJECT}" -- true >/dev/null 2>&1; then
		agent_ready=true
		break
	fi
	sleep 2
done
if [[ ${agent_ready} != true ]]; then
	echo "The LXD VM agent did not become ready." >&2
	exit 1
fi

lxc exec "${SMOKE_NAME}" --project "${LXD_PROJECT}" -- timeout 300 cloud-init status --wait
instance_json=$(lxc query "/1.0/instances/${SMOKE_NAME}?project=${LXD_PROJECT}")
instance_type=$(INSTANCE_JSON="${instance_json}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["INSTANCE_JSON"])
metadata = payload.get("metadata", payload)
print(metadata["type"])
PY
)
if [[ ${instance_type} != virtual-machine ]]; then
	echo "The smoke instance is not a full virtual machine." >&2
	exit 1
fi
if [[ $(lxc config get "${SMOKE_NAME}" boot.mode --project "${LXD_PROJECT}") != uefi-secureboot ]]; then
	echo "The smoke VM is not pinned to Secure Boot mode." >&2
	exit 1
fi
secure_boot=$(lxc config uefi get "${SMOKE_NAME}" SecureBootEnable-f0a30bc7-af08-4556-99c4-001009c93a44 \
	--project "${LXD_PROJECT}")
if [[ ${secure_boot} != 01 ]]; then
	echo "The smoke VM did not report enabled UEFI Secure Boot." >&2
	exit 1
fi
guest_virt=$(lxc exec "${SMOKE_NAME}" --project "${LXD_PROJECT}" -- systemd-detect-virt)
if [[ ${guest_virt} != kvm ]]; then
	echo "The guest did not detect the KVM boundary." >&2
	exit 1
fi
lxc exec "${SMOKE_NAME}" --project "${LXD_PROJECT}" -- test -d /sys/firmware/efi
guest_ipv4=$(lxc exec "${SMOKE_NAME}" --project "${LXD_PROJECT}" -- sh -c \
	"ip -4 -o address show scope global | awk '\$4 ~ /^10[.]41[.]0[.]/ { sub(\"/.*\", \"\", \$4); print \$4; exit }'")
if [[ ! ${guest_ipv4} =~ ^10[.]41[.]0[.][0-9]+$ ]]; then
	echo "The guest did not receive an address on the private runner subnet." >&2
	exit 1
fi
lxc exec "${SMOKE_NAME}" --project "${LXD_PROJECT}" -- getent ahostsv4 cloud-images.ubuntu.com >/dev/null

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "instance_type=${instance_type}"
	echo "virtualization=${guest_virt}"
	echo "boot_mode=uefi-secureboot"
	echo "secure_boot_variable=${secure_boot}"
	echo "guest_ipv4=${guest_ipv4}"
	echo "image_fingerprint=$(lxc config get "${SMOKE_NAME}" volatile.base_image --project "${LXD_PROJECT}")"
	echo "project=${LXD_PROJECT}"
	echo "profile=${LXD_PROFILE}"
	echo "storage_pool=${LXD_POOL}"
	echo "dns_egress=verified"
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${VERIFY_LOG}"
rm -f "${state_tmp}"

cleanup_smoke_vm
trap - EXIT
echo "LXD_VM_BOUNDARY_VERIFIED"
