#!/usr/bin/env bash
# The code host image, checked from inside a code host made from it (5e), as root. test/prove-code-host.ts makes that
# code host as the coding executor does (code-host.ts) on a test machine and pushes this in; never run it anywhere
# else. It checks that the code host has no network and no /dev/lxd, boots to running without cloud-init, grew its
# root to the disk, has the pinned git (with the work 5e's jobs do with it), the recorded folder program with FUSE and
# vsock under it, the places the jobs use and the commands they run, the policy's processors, and none of what the
# build removed. Prints PASS lines, then ALL PASSED.
set -euo pipefail

GIT_VERSION=${QORPERA_PROOF_GIT:?the pinned git version}
FOLDER_SHA256=${QORPERA_PROOF_FOLDER_SHA256:?the folder program's sha-256}
CPUS=${QORPERA_PROOF_CPUS:?the policy's processors}
FOLDER=/opt/qorpera-folder/qorpera-folder

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }
# A version line; sed reads to the end, so the tool never writes into a closed pipe.
first() { "$@" 2>&1 | sed -n 1p; }

# --- No network, no /dev/lxd, and a clean boot ------------------------------------------------------------------------
LINKS=$(ls /sys/class/net)
[[ $LINKS == lo ]] || fail "network links: $LINKS"
[[ ! -e /dev/lxd ]] || fail "/dev/lxd is there"
pass "only the loopback link, and no /dev/lxd"
STATE=$(timeout 300 systemctl is-system-running --wait || true)
[[ $STATE == running ]] || { systemctl --failed --no-pager || true; fail "the code host is $STATE after boot"; }
pass "booted to running without cloud-init"

# --- The machine ---------------------------------------------------------------------------------------------------
[[ $(systemctl show -P Result qorpera-grow-root.service) == success ]] || fail "qorpera-grow-root did not succeed"
ROOT=$(findmnt -bno SIZE /)
((ROOT > 11274289152)) || fail "the root file system is $ROOT bytes: it did not grow to the 12 GiB disk"
pass "the root file system grew to the disk ($ROOT bytes)"
[[ $(hostname) == qorpera-code-host ]] || fail "the hostname is $(hostname)"
[[ $(cat /etc/machine-id) =~ ^[0-9a-f]{32}$ ]] || fail "no machine id of its own"
[[ $(nproc) == "$CPUS" ]] || fail "$(nproc) processors, not the policy's $CPUS"
pass "named qorpera-code-host, its own machine id, the policy's $CPUS processors"
[[ -d /company && -z $(ls -A /company) ]] || fail "/company is not an empty directory"
[[ $(stat -c "%a %u %g" /var/lib/qorpera-code-host) == "700 0 0" ]] || fail "/var/lib/qorpera-code-host is not root's 0700"
pass "/company (empty) and /var/lib/qorpera-code-host (root's, 0700) for 5e's jobs"

# --- git ----------------------------------------------------------------------------------------------------------------
[[ $(command -v git) == /usr/local/bin/git && $(git --version) == "git version $GIT_VERSION" ]] || fail "git is not $GIT_VERSION"
[[ ! -e /usr/bin/git ]] || fail "a second git is there"
# What 5e's jobs do with git: a bundle in, a locked worktree, a ref transaction, gc and fsck. Any failure in the
# subshell ends the proof.
(
	export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null HOME=/nonexistent
	export GIT_AUTHOR_NAME=q GIT_AUTHOR_EMAIL=q@q GIT_COMMITTER_NAME=q GIT_COMMITTER_EMAIL=q@q
	T=$(mktemp -d -p /var/lib/qorpera-code-host)
	git init -q -b main "$T/a"
	git -C "$T/a" commit -q --allow-empty -m one
	git -C "$T/a" bundle create -q "$T/a.bundle" main
	git init -q --bare "$T/b.git"
	git -C "$T/b.git" fetch -q "$T/a.bundle" "refs/heads/*:refs/heads/*"
	git -C "$T/b.git" worktree add -q --lock --detach "$T/w" main
	ONE=$(git -C "$T/b.git" rev-parse main)
	git -C "$T/w" commit -q --allow-empty -m two
	TWO=$(git -C "$T/w" rev-parse HEAD)
	printf "start\nupdate refs/heads/main %s %s\nprepare\ncommit\n" "$TWO" "$ONE" | git -C "$T/b.git" update-ref --stdin
	[[ $(git -C "$T/b.git" rev-parse main) == "$TWO" ]]
	git -C "$T/b.git" gc -q
	git -C "$T/b.git" fsck --strict --no-progress
	rm -rf "$T"
)
pass "git $GIT_VERSION takes a bundle, a locked worktree and a ref transaction, and gc and fsck pass"

# --- The folder program, FUSE and vsock -------------------------------------------------------------------------------
[[ $(sha256sum "$FOLDER" | cut -d" " -f1) == "$FOLDER_SHA256" ]] || fail "the folder program differs"
[[ $(stat -c "%a %u %g" "$FOLDER") == "555 0 0" ]] || fail "the folder program is not root's 0555"
VERSION=$("$FOLDER" version)
PATTERN="^qorpera-folder [^ ]+ [(]protocol [0-9]+[)]$"
[[ $VERSION =~ $PATTERN ]] || fail "the folder program does not run: $VERSION"
grep -qw fuse /proc/filesystems || fail "the kernel has no FUSE"
exec 9<>/dev/fuse || fail "/dev/fuse does not open"
exec 9>&-
first fusermount3 --version >/dev/null || fail "no fusermount3"
[[ -c /dev/vsock ]] || fail "no /dev/vsock"
pass "the recorded folder program ($VERSION), FUSE (/dev/fuse, fusermount3) and /dev/vsock"

# --- What the build removed, and what 5e's jobs run -------------------------------------------------------------------
! command -v cloud-init >/dev/null && [[ ! -e /etc/cloud ]] || fail "cloud-init is there"
for tool in gcc cc cargo rustc; do ! command -v "$tool" >/dev/null || fail "the build's $tool stayed"; done
for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service \
	unattended-upgrades.service systemd-networkd-wait-online.service; do
	[[ $(systemctl is-enabled "$unit" 2>/dev/null || true) == masked ]] || fail "$unit is not masked"
done
! systemctl is-active --quiet apt-daily.timer || fail "apt-daily.timer is active"
pass "no cloud-init and no compilers; apt's self-updates and the network wait masked"
for tool in /usr/bin/mkdir /usr/bin/rm /usr/bin/find /usr/bin/cat /bin/sh /bin/false; do
	[[ -x $tool ]] || fail "$tool is not executable"
done
for tool in mkfifo cmp head mv; do command -v "$tool" >/dev/null || fail "no $tool"; done
pass "the commands 5e's jobs run"
echo "ALL PASSED"
