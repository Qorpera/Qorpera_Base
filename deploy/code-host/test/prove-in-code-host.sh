#!/usr/bin/env bash
# The code host image, checked from inside a code host made from it (5e), as root. test/prove-code-host.ts makes that
# code host as the coding executor does (code-host.ts) on a test machine and pushes this in; never run it anywhere
# else. It checks that the code host has no network and no /dev/lxd, boots to running without cloud-init, grew its
# root to the disk, has the pinned git (with the work 5e's jobs do with it), the recorded folder program with FUSE and
# vsock under it, the places the jobs use and the commands they run, the policy's processors, and none of what the
# build removed. Prints PASS lines, then ALL PASSED.
set -euo pipefail

GIT_VERSION=${QORPERA_PROOF_GIT:?the pinned git version}
FOLDER_SHA256=${QORPERA_PROOF_FOLDER_SHA256:?the sha-256 of the folder program}
CPUS=${QORPERA_PROOF_CPUS:?the processors of the policy}
DISK_BYTES=${QORPERA_PROOF_DISK_BYTES:?the root disk bytes of the policy}
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
# The image's /boot and EFI partitions and ext4's own tables take their share of the disk, so the root's size alone
# says little: the disk is the policy's, the root partition reaches its end, and the file system fills the partition.
PART=$(basename "$(readlink -f "$(findmnt -no SOURCE /)")")
DISK=$(lsblk -no PKNAME "/dev/$PART")
# Sizes in /sys/class/block are in 512-byte sectors.
read -r DISK_SECTORS <"/sys/class/block/$DISK/size"
read -r START_SECTOR <"/sys/class/block/$PART/start"
read -r PART_SECTORS <"/sys/class/block/$PART/size"
DISK_SIZE=$((DISK_SECTORS * 512))
START=$((START_SECTOR * 512))
PART_SIZE=$((PART_SECTORS * 512))
((DISK_SIZE == DISK_BYTES)) || fail "the disk is $DISK_SIZE bytes, not the policy's $DISK_BYTES"
# growpart leaves the backup GPT at the disk's end (33 sectors), and aligns.
GAP=$((DISK_SIZE - START - PART_SIZE))
((GAP < 1024 ** 2)) || fail "the root partition ends $GAP bytes before the disk's end: it did not grow"
SUPER=$(dumpe2fs -h "/dev/$PART" 2>/dev/null)
BLOCKS=$(awk -F: '/^Block count:/ {print $2 + 0}' <<<"$SUPER")
BLOCK=$(awk -F: '/^Block size:/ {print $2 + 0}' <<<"$SUPER")
((BLOCKS > 0 && BLOCK > 0 && PART_SIZE - BLOCKS * BLOCK < BLOCK)) ||
	fail "the root file system is $BLOCKS blocks of $BLOCK bytes on a $PART_SIZE-byte partition: it did not grow"
pass "the root partition and its file system grew to the $DISK_SIZE-byte disk ($(findmnt -bno SIZE /) bytes free and used)"
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
	# What nightly care's jobs do with git (code-host-jobs.ts): refs packed but for the sessions' branches, a gc that
	# deletes nothing, the check that reads no file content under a time limit, and a bundle of every ref that is
	# measured, verified and fetched whole into an empty repository.
	git -C "$T/b.git" pack-refs --all --exclude "refs/heads/qorpera/coding/*"
	git -C "$T/b.git" gc --quiet --no-prune
	timeout -k 10 60 git --no-replace-objects --git-dir="$T/b.git" fsck --connectivity-only --no-dangling --no-progress
	[[ $(git -C "$T/b.git" count-objects -v) == *"size-pack: "* ]]
	git -C "$T/w" status --porcelain >/dev/null
	git -C "$T/w" ls-files -v >/dev/null
	git -C "$T/b.git" bundle create --quiet "$T/all.bundle" --all
	BYTES=$(wc -c <"$T/all.bundle")
	[[ $(dd if="$T/all.bundle" bs=16777216 skip=0 count=1 iflag=fullblock status=none | sha256sum) == "$(sha256sum <"$T/all.bundle")" ]]
	[[ $(head -c "$BYTES" "$T/all.bundle" | wc -c) == "$BYTES" ]]
	git init --quiet --bare --template= --ref-format=files "$T/p.git"
	git -C "$T/p.git" bundle verify --quiet "$T/all.bundle"
	git -C "$T/p.git" fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head "$T/all.bundle" "+refs/*:refs/*"
	[[ $(git -C "$T/p.git" rev-parse refs/heads/main) == "$TWO" ]]
	[[ $(find "$T/w" -mindepth 1 -maxdepth 1 -printf "%y\0%s\0%P\0" | tr -d "\0" | wc -c) -gt 0 ]]
	# What the change record's, the undo's and the download's jobs do with git (code-host-jobs.ts): the paths a change
	# touched, the commits between two with their parents, a picture's first bytes and its copy out of git, an undo's
	# merge from the change itself as the base (clean, and with a conflict that names its path), the undo's commit found
	# again by its request line, main's files as a zip (the same bytes each time), and main with its history as a bundle
	# of HEAD and the branch, which a clone without files and a plain clone both take for main.
	git -C "$T/b.git" symbolic-ref HEAD refs/heads/main
	printf 'a\nb\nc\n' >"$T/w/f.txt"
	git -C "$T/w" add f.txt
	git -C "$T/w" commit -q -m three
	THREE=$(git -C "$T/w" rev-parse HEAD)
	printf 'a\nB\nc\n' >"$T/w/f.txt"
	printf '\211PNG\r\n\032\n' >"$T/w/p.png"
	git -C "$T/w" add f.txt p.png
	git -C "$T/w" commit -q -m four
	FOUR=$(git -C "$T/w" rev-parse HEAD)
	echo more >"$T/w/g.txt"
	git -C "$T/w" add g.txt
	git -C "$T/w" commit -q -m five
	FIVE=$(git -C "$T/w" rev-parse HEAD)
	git -C "$T/b.git" update-ref refs/heads/main "$FIVE" "$TWO"
	[[ $(git -C "$T/b.git" diff-tree -r -z --no-renames --name-status "$THREE" "$FIVE" | tr "\0" " ") == "M f.txt A g.txt A p.png " ]]
	[[ $(git -C "$T/b.git" rev-list --ancestry-path --parents "$THREE..$FIVE" | tail -n 1) == "$FOUR $THREE" ]]
	PICTURE=$(git -C "$T/b.git" ls-tree -l -z --full-tree "$FIVE" -- p.png | tr "\0" "\n" | awk '{print $3}')
	[[ $(git -C "$T/b.git" cat-file blob "$PICTURE" | /usr/bin/head -c 4 | tail -c 3) == PNG ]]
	[[ $(echo "$PICTURE" | git -C "$T/b.git" cat-file --batch-check) == "$PICTURE blob 8" ]]
	git -C "$T/b.git" cat-file blob "$PICTURE" >"$T/p.copy"
	[[ $(git -C "$T/b.git" hash-object --no-filters -- "$T/p.copy") == "$PICTURE" ]]
	UNDONE=$(git -C "$T/b.git" merge-tree --write-tree -z --name-only --no-messages --merge-base="$FOUR" "$FIVE" "$THREE" | tr -d "\0")
	[[ $(git -C "$T/b.git" ls-tree -r --name-only "$UNDONE" | tr "\n" " ") == "f.txt g.txt " ]]
	[[ $(git -C "$T/b.git" cat-file blob "$UNDONE:f.txt" | tr "\n" " ") == "a b c " ]]
	printf 'a\nB2\nc\n' >"$T/w/f.txt"
	git -C "$T/w" commit -q -a -m six
	SIX=$(git -C "$T/w" rev-parse HEAD)
	STATUS=0
	CONFLICT=$(git -C "$T/b.git" merge-tree --write-tree -z --name-only --no-messages --merge-base="$FOUR" "$SIX" "$THREE" | tr "\0" "\n") || STATUS=$?
	[[ $STATUS == 1 && $(sed -n 2p <<<"$CONFLICT") == f.txt ]]
	REQUEST="Qorpera-Request: 00000000-0000-4000-8000-000000000000"
	UNDO=$(git -C "$T/b.git" -c user.name=Qorpera -c user.email=code@qorpera.com commit-tree "$UNDONE" -p "$FIVE" -m "Undo change 4: four" -m "$REQUEST")
	git -C "$T/b.git" update-ref refs/heads/main "$UNDO" "$FIVE"
	[[ $(git -C "$T/b.git" rev-list --first-parent --fixed-strings --grep="$REQUEST" --max-count=1 --no-commit-header --format="%H %P" "$FOUR..$UNDO") == "$UNDO $FIVE" ]]
	[[ $(git -C "$T/b.git" rev-parse --verify "$UNDO^{tree}") == "$UNDONE" ]]
	git -C "$T/b.git" archive --format=zip --prefix=code/ -o "$T/code.zip" "$UNDO"
	git -C "$T/b.git" archive --format=zip --prefix=code/ -o "$T/again.zip" "$UNDO"
	[[ $(/usr/bin/head -c 2 "$T/code.zip") == PK && $(sha256sum <"$T/code.zip") == "$(sha256sum <"$T/again.zip")" ]]
	git -C "$T/b.git" bundle create --quiet "$T/main.bundle" HEAD refs/heads/main
	git -C "$T/b.git" bundle verify --quiet "$T/main.bundle"
	git clone --quiet --no-checkout --template= "$T/main.bundle" "$T/c"
	[[ $(git -C "$T/c" symbolic-ref HEAD) == refs/heads/main && $(git -C "$T/c" rev-parse --verify "HEAD^{commit}") == "$UNDO" ]]
	git clone --quiet "$T/main.bundle" "$T/plain"
	[[ $(cat "$T/plain/g.txt") == more && ! -e "$T/plain/p.png" ]]
	rm -rf "$T"
)
pass "git $GIT_VERSION takes a bundle, a locked worktree and a ref transaction, and gc and fsck pass"
pass "git $GIT_VERSION does nightly care's work: packed refs, a gc that deletes nothing, the timed check, a whole bundle that restores"
pass "git $GIT_VERSION does the change record's work: a change's paths, an undo's merge and its conflict, the zip of main, the bundle a clone checks out"

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
for tool in /usr/bin/mkdir /usr/bin/rm /usr/bin/find /usr/bin/cat /bin/sh /usr/bin/sh /bin/false /usr/bin/systemd-run; do
	[[ -x $tool ]] || fail "$tool is not executable"
done
# The view's mount and its clean (runner-orchestrator code-host-views.ts) run these with PATH=/usr/sbin:/usr/bin.
for tool in mkfifo cmp head mv tail findmnt mountpoint umount systemctl; do
	PATH=/usr/sbin:/usr/bin command -v "$tool" >/dev/null || fail "no $tool in /usr/sbin:/usr/bin"
done
# Nightly care's jobs (code-host-jobs.ts) run these with PATH=/usr/local/bin:/usr/bin:/bin.
[[ -x /usr/bin/dd ]] || fail "/usr/bin/dd is not executable"
for tool in timeout sha256sum wc head grep find; do
	PATH=/usr/local/bin:/usr/bin:/bin command -v "$tool" >/dev/null || fail "no $tool in /usr/local/bin:/usr/bin:/bin"
done
# The change record's, the undo's and the download's jobs (code-host-jobs.ts) run these as well, with the same PATH.
[[ -x /usr/bin/head ]] || fail "/usr/bin/head is not executable"
# The record writer takes each file's bytes off one stream: head takes exactly what it is told, and no more.
[[ $({ /usr/bin/head -c 70000 /dev/zero; printf rest; } | { /usr/bin/head -c 70000 >/dev/null; cat; }) == rest ]] ||
	fail "head -c reads past its bytes"
for tool in cat mv rm rmdir mkdir; do
	PATH=/usr/local/bin:/usr/bin:/bin command -v "$tool" >/dev/null || fail "no $tool in /usr/local/bin:/usr/bin:/bin"
done
pass "the commands 5e's jobs run"
echo "ALL PASSED"
