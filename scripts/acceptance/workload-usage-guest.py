"""Bounded, offline guest exercise for disposable physical usage acceptance."""

import hashlib
import json
import os
import pathlib
import signal
import sys
import tempfile
import time


signal.alarm(30)
marker = pathlib.Path(sys.argv[1])
assert marker.parent == pathlib.Path("/var/tmp")
assert marker.name.startswith("qorpera-usage-") and not marker.exists()
started = time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000
cpu_started = time.process_time_ns()
memory = bytearray(64 * 1024 * 1024)
for offset in range(0, len(memory), 4096):
    memory[offset] = 91
block = b"q" * (8 * 1024 * 1024)
disk_bytes = 0
with tempfile.TemporaryFile(dir="/var/tmp") as disk:
    for _ in range(4):
        disk.seek(0)
        assert disk.write(block) == len(block)
        disk.flush()
        os.fsync(disk.fileno())
        disk_bytes += len(block)
    disk.seek(0)
    assert disk.read() == block
hashes = 0
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    digest = hashlib.sha256(memory).hexdigest()
    hashes += 1
finished = time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000
result = {
    "schema": "qorpera.guest-workload-completion/v1",
    "startedGuestUptimeMs": started,
    "finishedGuestUptimeMs": finished,
    "cpuTimeMs": (time.process_time_ns() - cpu_started) // 1_000_000,
    "touchedMemoryBytes": len(memory),
    "writtenDiskBytes": disk_bytes,
    "hashIterations": hashes,
    "sha256": digest,
    "completed": True,
}
with marker.open("x", encoding="utf8") as output:
    json.dump(result, output)
signal.alarm(0)
