"""Real KVM capability probe; opening a device alone is insufficient."""
import fcntl
import json
import os

fd = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
try:
    version = fcntl.ioctl(fd, 0xAE00, 0)  # KVM_GET_API_VERSION
    assert version == 12, "KVM API version must be 12"
    vm = fcntl.ioctl(fd, 0xAE01, 0)  # KVM_CREATE_VM exercises actual virtualization
    os.close(vm)
    print(json.dumps({"apiVersion": version, "createVm": True}))
finally:
    os.close(fd)
