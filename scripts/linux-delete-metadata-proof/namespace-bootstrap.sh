#!/bin/bash
set -euo pipefail
# Caller passes CI guard env plus FIXTURES OUTPUT NODE HOST_MNT_NS HOST_NET_NS HOST_PID_NS.
# sudo env GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted unshare --mount --net --pid --fork --mount-proc bash ...
# Only ephemeral CI runner; unshare creates separate namespace before mutation.
fixture_dir="$1"
output_dir="$2"
export QORPERA_PROOF_NODE="$3"
host_mount_namespace="$4"
host_network_namespace="$5"
host_pid_namespace="$6"
[ "${GITHUB_ACTIONS:-}" = true ]
[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]
[ "$(id -u)" = 0 ]
[ -x "$QORPERA_PROOF_NODE" ]
[[ "$host_mount_namespace" =~ ^mnt:\[[0-9]+\]$ ]]
[[ "$host_network_namespace" =~ ^net:\[[0-9]+\]$ ]]
[[ "$host_pid_namespace" =~ ^pid:\[[0-9]+\]$ ]]
[ "$(readlink /proc/self/ns/mnt)" != "$host_mount_namespace" ]
[ "$(readlink /proc/self/ns/net)" != "$host_network_namespace" ]
[ "$(readlink /proc/self/ns/pid)" != "$host_pid_namespace" ]
export PATH="$(dirname "$QORPERA_PROOF_NODE"):/usr/sbin:/usr/bin:/sbin:/bin"
mount --make-rprivate /
mount -t sysfs -o ro,nosuid,nodev,noexec sysfs /sys
mount -t tmpfs -o mode=755 tmpfs /etc
mount -t tmpfs -o mode=755 tmpfs /run
mount -t tmpfs -o mode=755 tmpfs /mnt
printf 'root:x:0:0:root:/root:/bin/bash\n' > /etc/passwd
printf 'root:x:0:\n' > /etc/group
printf 'passwd: files\ngroup: files\n' > /etc/nsswitch.conf
printf 'isolated ephemeral namespace only\n' > /run/qorpera-isolated-linux-proof
# A fresh owned ext4 image gives an actual filesystem root (/), as policy requires.
private_journal=$(mktemp -d /var/tmp/qorpera-linux-proof.XXXXXXXX)
chmod 755 "$private_journal"
mkdir /mnt/journal
truncate -s 64M "$private_journal/journal.ext4"
mkfs.ext4 -q -F "$private_journal/journal.ext4"
mount -o loop,nodev,nosuid "$private_journal/journal.ext4" /mnt/journal
# mount's auto-clear loop device is released by unmount/namespace teardown.
trap 'umount /mnt/journal && rm -f -- "$private_journal/journal.ext4" && rmdir -- "$private_journal"' EXIT
python3 "$fixture_dir/run-isolated.py" "$fixture_dir/probe.cjs" > "$output_dir/kernel-boundary-results.json"
python3 "$fixture_dir/full-driver.py" "$fixture_dir/full.cjs" "$output_dir"
