#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="qorpera-step2-compat-01"
EXPECTED_OS_VERSION="26.04"
EXPECTED_DATA_BYTES=$((256 * 1024 * 1024 * 1024))

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this verifier through Azure Run Command as root." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to verify an unexpected host: $(hostname)" >&2
	exit 1
fi
if ! grep -q "^VERSION_ID=\"${EXPECTED_OS_VERSION}\"$" /etc/os-release; then
	echo "The pilot is not running the pinned Ubuntu release." >&2
	exit 1
fi
if [[ ! -d /sys/firmware/efi/efivars ]]; then
	echo "The pilot did not boot through UEFI." >&2
	exit 1
fi

secure_boot_var=$(find /sys/firmware/efi/efivars -maxdepth 1 -type f -name 'SecureBoot-*' -print -quit)
if [[ -z ${secure_boot_var} ]]; then
	echo "The UEFI Secure Boot variable is unavailable." >&2
	exit 1
fi
secure_boot_enabled=$(od -An -t u1 -j 4 -N 1 "${secure_boot_var}" | tr -d ' ')
if [[ ${secure_boot_enabled} != 1 ]]; then
	echo "UEFI Secure Boot is not enabled inside the pilot." >&2
	exit 1
fi
if [[ ! -c /dev/tpmrm0 && ! -c /dev/tpm0 ]]; then
	echo "The Azure vTPM device is unavailable." >&2
	exit 1
fi
if [[ ! -c /dev/kvm ]]; then
	echo "/dev/kvm is unavailable; nested full-VM execution cannot be enforced." >&2
	exit 1
fi
if ! grep -Eq '(^| )(vmx|svm)( |$)' /proc/cpuinfo; then
	echo "The host CPU does not expose nested-virtualization flags." >&2
	exit 1
fi
if ! grep -q '^kvm ' /proc/modules; then
	echo "The KVM kernel module is not loaded." >&2
	exit 1
fi

python3 - <<'PY'
import fcntl
import os

KVM_GET_API_VERSION = 0xAE00
KVM_CREATE_VM = 0xAE01

kvm_fd = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
try:
    api_version = fcntl.ioctl(kvm_fd, KVM_GET_API_VERSION, 0)
    if api_version != 12:
        raise SystemExit(f"unexpected KVM API version: {api_version}")
    vm_fd = fcntl.ioctl(kvm_fd, KVM_CREATE_VM, 0)
    os.close(vm_fd)
finally:
    os.close(kvm_fd)
print("kvm_api_version=12")
print("kvm_create_vm=verified")
PY

data_disk=$(EXPECTED_DATA_BYTES="${EXPECTED_DATA_BYTES}" python3 - <<'PY'
import json
import os
import subprocess

expected_size = int(os.environ["EXPECTED_DATA_BYTES"])
payload = json.loads(
    subprocess.check_output(
        [
            "lsblk",
            "--bytes",
            "--json",
            "--output",
            "NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINTS",
        ],
        text=True,
    )
)

candidates = []
for device in payload.get("blockdevices", []):
    if device.get("type") != "disk" or device.get("size") != expected_size:
        continue
    if device.get("children"):
        continue
    if device.get("fstype"):
        continue
    if any(device.get("mountpoints") or []):
        continue
    path = device.get("path")
    if isinstance(path, str) and path.startswith("/dev/"):
        candidates.append(path)

if len(candidates) != 1:
    raise SystemExit(
        f"expected exactly one empty 256-GiB whole disk, found {len(candidates)}"
    )
print(candidates[0])
PY
)

if [[ -n $(wipefs --no-act --noheadings --output TYPE,UUID,LABEL "${data_disk}" 2>/dev/null) ]]; then
	echo "The synthetic data disk already contains a filesystem signature." >&2
	exit 1
fi
if findmnt --raw --noheadings --source "${data_disk}" | grep -q .; then
	echo "The synthetic data disk is unexpectedly mounted." >&2
	exit 1
fi

echo "AZURE_STEP2_KVM_GATE_VERIFIED"
echo "hostname=$(hostname)"
echo "os_version=${EXPECTED_OS_VERSION}"
echo "kernel=$(uname -r)"
echo "outer_virtualization=$(systemd-detect-virt)"
echo "secure_boot=enabled"
echo "vtpm=present"
echo "data_disk=${data_disk}"
echo "data_disk_bytes=${EXPECTED_DATA_BYTES}"
echo "data_disk_state=unformatted-unmounted"
