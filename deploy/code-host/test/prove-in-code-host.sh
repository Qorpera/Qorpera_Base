#!/usr/bin/env bash
# The code host image, checked from inside a code host made from it (5e), as root. test/prove-code-host.ts makes that
# code host as the coding executor does (code-host.ts) on a test machine and pushes this in; never run it anywhere
# else. It checks that the code host has no network and no /dev/lxd, boots to running without cloud-init, grew its
# root to the disk, has the pinned git (with the work 5e's jobs and an import's do with it, and the import's key scan
# over planted values), the recorded folder program with FUSE and vsock under it, the places the jobs use and the
# commands they run, the policy's processors, and none of what the build removed. Prints PASS lines, then ALL PASSED.
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
	# What a restore's jobs do with git (code-host-restore.ts). A bundle of every ref also names each worktree's HEAD,
	# outside refs/, and says which commit HEAD is at, never which branch: only refs/* is taken from it. It is proven
	# in a new bare repository (verified, fetched whole, checked by fsck --full under a time limit) and repacked with
	# one thread, which gives the same pack each time. The repository is made again from that pack through index-pack
	# (once more over a repo.git that lost its HEAD, which keeps its refs and objects, and with the pack it already
	# holds), every ref but main in one transaction, each from nothing, then main and its worktree. Then the two looks
	# that say what a restore kept: an object that is not there, and whether main reaches a commit.
	git -C "$T/b.git" update-ref refs/qorpera/kept-here "$ONE"
	git -C "$T/b.git" update-ref refs/heads/qorpera/coding/00000000-0000-4000-8000-000000000000 "$FOUR"
	git -C "$T/b.git" bundle create --quiet "$T/every.bundle" --all
	[[ $(git -C "$T/b.git" bundle list-heads "$T/every.bundle" | grep -c " HEAD$") -ge 1 ]]
	for proof in proof again; do
		git init --quiet --bare --template= --ref-format=files "$T/$proof.git"
		git --git-dir="$T/$proof.git" bundle verify --quiet "$T/every.bundle"
		git --git-dir="$T/$proof.git" fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head "$T/every.bundle" "+refs/*:refs/*"
		[[ ! -e $T/$proof.git/worktrees && $(git --git-dir="$T/$proof.git" for-each-ref) == "$(git -C "$T/b.git" for-each-ref)" ]]
		timeout -k 10 60 git --no-replace-objects --git-dir="$T/$proof.git" fsck --full --no-dangling --no-progress
		git --git-dir="$T/$proof.git" -c pack.threads=1 repack -a -d -q
	done
	PACKS=$(find "$T/proof.git/objects/pack" -maxdepth 1 -type f -name "pack-*.pack" -printf "%s %p\n")
	[[ $(wc -l <<<"$PACKS") == 1 && $(ls "$T/again.git/objects/pack") == "$(ls "$T/proof.git/objects/pack")" ]]
	PACK=${PACKS#* }
	MAIN=$(git --git-dir="$T/proof.git" rev-parse --verify "refs/heads/main^{commit}")
	[[ $MAIN == "$UNDO" ]]
	git init --quiet --bare --template= --ref-format=files --initial-branch=main "$T/r.git"
	git --git-dir="$T/r.git" index-pack --stdin <"$PACK" >/dev/null
	rm "$T/r.git/HEAD"
	git init --quiet --bare --template= --ref-format=files --initial-branch=main "$T/r.git"
	[[ $(cat "$T/r.git/HEAD") == "ref: refs/heads/main" ]]
	git --git-dir="$T/r.git" index-pack --stdin <"$PACK" >/dev/null
	[[ $(find "$T/r.git/objects/pack" -name "pack-*.pack" | wc -l) == 1 ]]
	{
		echo start
		git --git-dir="$T/proof.git" for-each-ref --format="create %(refname) %(objectname)" | grep -v "^create refs/heads/main "
		echo prepare
		echo commit
	} | git --git-dir="$T/r.git" update-ref --no-deref --stdin >/dev/null
	printf "start\nupdate refs/heads/main %s %s\nprepare\ncommit\n" "$MAIN" 0000000000000000000000000000000000000000 |
		git --git-dir="$T/r.git" update-ref --no-deref --stdin >/dev/null
	git --git-dir="$T/r.git" worktree add --quiet --lock --detach "$T/rmain" "$MAIN"
	[[ $(git --git-dir="$T/r.git" for-each-ref) == "$(git --git-dir="$T/proof.git" for-each-ref)" ]]
	[[ $(cat "$T/rmain/g.txt") == more && ! -e "$T/rmain/p.png" ]]
	git --git-dir="$T/r.git" fsck --full --strict --no-dangling --no-progress
	GONE=1111111111111111111111111111111111111111
	[[ $(printf "%s\n%s\n" "$MAIN" "$GONE" | git --git-dir="$T/r.git" cat-file --batch-check | cut -d" " -f1,2 | tr "\n" " ") == "$MAIN commit $GONE missing " ]]
	git --git-dir="$T/r.git" merge-base --is-ancestor "$FOUR" "$MAIN"
	STATUS=0
	git --git-dir="$T/r.git" merge-base --is-ancestor "$MAIN" "$FOUR" || STATUS=$?
	[[ $STATUS == 1 ]]
	rm -rf "$T"
)
pass "git $GIT_VERSION takes a bundle, a locked worktree and a ref transaction, and gc and fsck pass"
pass "git $GIT_VERSION does nightly care's work: packed refs, a gc that deletes nothing, the timed check, a whole bundle that restores"
pass "git $GIT_VERSION does the change record's work: a change's paths, an undo's merge and its conflict, the zip of main, the bundle a clone checks out"
pass "git $GIT_VERSION does a restore's work: a bundle of every ref proven and repacked the same twice, a repository made again from its pack, its refs and main"

# What an import's jobs do in the code host (code-host-import.ts). The look's sweep of dead scratch; a history the
# strict fetch refuses by git's message id, that a fetch without the check and an fsck that is not strict take (old
# objects git only warns about); the refs plan as one update-ref session of two transactions (deletes, then creates);
# the formats the facts are read in; the lists of the key scan kept in files, picked by line and by name; and C1's
# key scan itself (code-import.ts's CODE_IMPORT_SCAN, word for word: runner-orchestrator's code-host-import test pins
# the text below) over planted values. Only offsets and kinds come out of it, never a value, each offset is the
# value's place in git's batch output, and git's end, a stop after its time and the output's bound are told apart.
SCAN_SCRIPT=$(
	cat <<'SCAN'
status=$1 list=$2 seconds=$3
shift 3
export LC_ALL=C
{ timeout -k 10 "$seconds" "$@" <"$list"; echo "git $?" >>"$status"; } |
	{ grep -a -b -o -E -e '(\b(AKIA|ASIA)[0-9A-Z]{16}\b)|(\b(gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z]{22}_[0-9A-Za-z]{59}))|(\b[rs]k_live_[0-9A-Za-z]{24,})|(\bxox[abeoprs]-[0-9A-Za-z-]{10,}|\bxapp-[0-9]-[0-9A-Za-z-]{10,}|hooks\.slack\.com/services/T[0-9A-Z]{8,12}/B[0-9A-Z]{8,12}/[0-9A-Za-z]{24})|(\bAIza[0-9A-Za-z_-]{35})|(-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----)|(\bre_[0-9A-Za-z]{8,12}_[0-9A-Za-z]{20,40}\b)|(\bsk-(proj|svcacct|admin)-[0-9A-Za-z_-]{20,}|\bsk-[0-9A-Za-z]{20}T3BlbkFJ[0-9A-Za-z]{20}\b)|(\bsk-ant-[0-9A-Za-z_-]{20,})'; echo "grep $?" >>"$status"; } |
	{ sed -n -E -e 's#^([0-9]+):(\b(AKIA|ASIA)[0-9A-Z]{16}\b)$#\1 aws#p' -e 's#^([0-9]+):(\b(gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z]{22}_[0-9A-Za-z]{59}))$#\1 github#p' -e 's#^([0-9]+):(\b[rs]k_live_[0-9A-Za-z]{24,})$#\1 stripe#p' -e 's#^([0-9]+):(\bxox[abeoprs]-[0-9A-Za-z-]{10,}|\bxapp-[0-9]-[0-9A-Za-z-]{10,}|hooks\.slack\.com/services/T[0-9A-Z]{8,12}/B[0-9A-Z]{8,12}/[0-9A-Za-z]{24})$#\1 slack#p' -e 's#^([0-9]+):(\bAIza[0-9A-Za-z_-]{35})$#\1 google#p' -e 's#^([0-9]+):(-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----)$#\1 private-key#p' -e 's#^([0-9]+):(\bre_[0-9A-Za-z]{8,12}_[0-9A-Za-z]{20,40}\b)$#\1 resend#p' -e 's#^([0-9]+):(\bsk-(proj|svcacct|admin)-[0-9A-Za-z_-]{20,}|\bsk-[0-9A-Za-z]{20}T3BlbkFJ[0-9A-Za-z]{20}\b)$#\1 openai#p' -e 's#^([0-9]+):(\bsk-ant-[0-9A-Za-z_-]{20,})$#\1 anthropic#p'; echo "sed $?" >>"$status"; } |
	head -c 65536
SCAN
)
(
	export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null HOME=/nonexistent LC_ALL=C
	export GIT_AUTHOR_NAME=q GIT_AUTHOR_EMAIL=q@q GIT_COMMITTER_NAME=q GIT_COMMITTER_EMAIL=q@q
	T=$(mktemp -d -p /var/lib/qorpera-code-host)
	# The sweep: every other entry of the scratch root goes, the job's own stays.
	mkdir -p "$T/root/keep" "$T/root/dead/proof.git/objects"
	: >"$T/root/file"
	find "$T/root" -mindepth 1 -maxdepth 1 ! -name keep -exec rm -rf -- {} +
	[[ $(ls -A "$T/root") == keep ]]
	[[ $(stat -c %s -- "$T/root/keep") =~ ^[0-9]+$ ]]
	# A zero-padded file mode: the strict fetch refuses it naming zeroPaddedFilemode; without the check it comes in, and
	# fsck only warns.
	Z="$T/z.git"
	git init -q --bare "$Z"
	BLOB=$(printf 'x\n' | git --git-dir="$Z" hash-object -w --stdin)
	SUB=$(printf '100644 blob %s\tf\n' "$BLOB" | git --git-dir="$Z" mktree)
	BIN=$(sed -e 's/../\\x&/g' <<<"$SUB")
	TREE=$({ printf '040000 d\0'; printf '%b' "$BIN"; } | git --git-dir="$Z" hash-object -t tree --literally -w --stdin)
	OLD=$(git --git-dir="$Z" commit-tree "$TREE" -m old)
	git --git-dir="$Z" update-ref refs/heads/master "$OLD"
	git --git-dir="$Z" bundle create --quiet "$T/z.bundle" --all
	git init --quiet --bare --template= --ref-format=files "$T/zp.git"
	STATUS=0
	SAID=$(git --no-replace-objects --git-dir="$T/zp.git" -c transfer.fsckObjects=true -c fetch.fsckObjects=true fetch --quiet \
		--no-tags --no-recurse-submodules --no-write-fetch-head "$T/z.bundle" "+refs/*:refs/*" 2>&1) || STATUS=$?
	[[ $STATUS != 0 && $SAID == *": zeroPaddedFilemode: "* ]]
	git init --quiet --bare --template= --ref-format=files "$T/zl.git"
	git --no-replace-objects --git-dir="$T/zl.git" -c transfer.fsckObjects=false -c fetch.fsckObjects=false fetch --quiet \
		--no-tags --no-recurse-submodules --no-write-fetch-head "$T/z.bundle" "+refs/*:refs/*"
	timeout -k 10 60 git --no-replace-objects --git-dir="$T/zl.git" fsck --full --no-dangling --no-progress >/dev/null 2>&1
	# The refs plan's session: a branch main/x deleted, then main and the mark made, each with its old value.
	W="$T/w"
	git init -q -b master "$W"
	mkdir -p "$W/old"
	echo "token=ASIAZXCVBNMLKJHGFDSA" >"$W/old/leak.txt"
	git -C "$W" add -A
	GIT_COMMITTER_DATE="@1700000000 +0000" git -C "$W" commit -q -m one
	ONE=$(git -C "$W" rev-parse HEAD)
	git -C "$W" rm -q old/leak.txt
	mkdir -p "$W/config" "$W/src" "$W/pay" "$W/chat" "$W/maps" "$W/keys" "$W/mail" "$W/ai"
	AWS=AKIAQWERTYUIOPASDFGH
	GH=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ
	STRIPE=sk_live_abcdefghijklmnopqrstuvwx
	SLACK=xoxb-abcdefghijklmnop
	GOOGLE=AIzaabcdefghijklmnopqrstuvwxyzABCDEFGHI
	PK="-----BEGIN OPENSSH PRIVATE KEY-----"
	RESEND=re_abcdefghij_abcdefghijklmnopqrstuvwx
	OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz
	ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwxyz
	echo "key = $AWS" >"$W/config/aws.txt"
	echo "const t = \"$GH\";" >"$W/src/github.ts"
	echo "$STRIPE" >"$W/pay/stripe.js"
	echo "$SLACK" >"$W/chat/slack.txt"
	printf 'k="%s"' "$GOOGLE" >"$W/maps/google.js"
	printf '%s\nb3BlbnNzaA\n' "$PK" >"$W/keys/id"
	echo "'$RESEND';" >"$W/mail/resend.ts"
	echo "$OPENAI" >"$W/ai/openai.py"
	echo "$ANTHROPIC" >"$W/ai/anthropic.py"
	printf 'x\nversion https://git-lfs.github.com/spec/v1\n' >"$W/lfs.md"
	git -C "$W" add -A
	GIT_COMMITTER_DATE="@1700000600 +0000" git -C "$W" commit -q -m two
	TWO=$(git -C "$W" rev-parse HEAD)
	git -C "$W" tag -a -m "a tag" v1 "$ONE"
	G="$W/.git"
	git --git-dir="$G" update-ref refs/heads/main/x "$ONE"
	printf 'start\0delete refs/heads/main/x\0%s\0prepare\0commit\0start\0create refs/heads/main\0%s\0create refs/qorpera/kept-here\0%s\0prepare\0commit\0' \
		"$ONE" "$TWO" "$TWO" | git --no-replace-objects --git-dir="$G" update-ref --no-deref -z --stdin >/dev/null
	git --git-dir="$G" symbolic-ref HEAD refs/heads/main
	[[ $(git --git-dir="$G" for-each-ref --format="%(refname) %(objectname)" | tr "\n" " ") == "refs/heads/main $TWO refs/heads/master $TWO refs/qorpera/kept-here $TWO refs/tags/v1 $(git --git-dir="$G" rev-parse v1) " ]]
	# The plan's input: name, object, type, the tag's target's type, the creator's date, NUL between.
	[[ $(git --git-dir="$G" for-each-ref --format="%(refname)%00%(objectname)%00%(objecttype)%00%(*objecttype)%00%(creatordate:unix)" refs/tags/v1 | tr "\0" " ") =~ ^refs/tags/v1\ [0-9a-f]{40}\ tag\ commit\ [0-9]+$ ]]
	[[ $(git --git-dir="$G" for-each-ref --format="%(objecttype)%00%(*objecttype)%00%(creatordate:unix)" refs/heads/main | tr "\0" " ") == "commit  1700000600" ]]
	# The facts: commits, the oldest root's and the last commit's times, who changed it lately (no mailmap).
	[[ $(git --no-replace-objects --git-dir="$G" rev-list --count "$TWO") == 2 ]]
	[[ $(git --no-replace-objects --git-dir="$G" log --no-use-mailmap --max-parents=0 --format=%ct "$TWO") == 1700000000 ]]
	[[ $(git --no-replace-objects --git-dir="$G" log --no-use-mailmap -1 --format=%ct "$TWO") == 1700000600 ]]
	[[ $(git --no-replace-objects --git-dir="$G" log --no-use-mailmap --max-age=1700000300 --format=%ct%x00%ae "$TWO" | tr "\0" " ") == "1700000600 q@q" ]]
	# The scan's lists, in files: every object the kept refs reach (NUL between records, each path whole in a record of
	# its own), their types and sizes, the blobs under 1 MiB.
	printf '%s\n' "$TWO" "$(git --git-dir="$G" rev-parse v1)" |
		git --no-replace-objects --git-dir="$G" rev-list --objects -z --stdin >"$T/objects"
	grep -z -v -e '^path=' -- "$T/objects" >"$T/ids.z"
	tr '\0' '\n' <"$T/ids.z" >"$T/ids"
	git --no-replace-objects --git-dir="$G" cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)' <"$T/ids" >"$T/checked"
	grep -E -e '^[0-9a-f]{40} blob (0|[1-9][0-9]{0,5}|10[0-3][0-9]{4}|104[0-7][0-9]{3}|1048[0-4][0-9]{2}|10485[0-6][0-9]{1}|104857[0-5])$' -- "$T/checked" >"$T/small"
	sed -e 's/ .*//' -- "$T/small" >"$T/list"
	sed -e 's/.* //' -- "$T/small" >"$T/sizes"
	[[ $(grep -c -E -e '^[0-9a-f]{40} blob ' -- "$T/checked") == 11 && $(wc -l <"$T/small") =~ ^\ *11$ ]]
	[[ $(head -n 3 -- "$T/sizes" | wc -l) =~ ^\ *3$ ]]
	# A blob by its line, and its first path by its name.
	LINE=$(grep -n -e '' -- "$T/list" | sed -e 's/^/:/' | grep -F -f <(printf ':4:\n'))
	[[ $LINE =~ ^:4:[0-9a-f]{40}$ ]]
	LEAK=$(git --git-dir="$G" rev-parse "$ONE:old/leak.txt")
	[[ $(grep -z -x -F --no-group-separator -A 1 -f <(printf '%s\n' "$LEAK") -- "$T/objects" | tr '\0' ' ') == "$LEAK path=old/leak.txt " ]]
	# A path with a line feed comes whole, where the plain listing cuts it.
	NLTREE=$(printf '100644 blob %s\ta\nb.txt\0' "$BLOB" | git --git-dir="$Z" mktree -z)
	NL=$(git --git-dir="$Z" commit-tree "$NLTREE" -m nl)
	echo "$NL" | git --no-replace-objects --git-dir="$Z" rev-list --objects -z --stdin >"$T/nl.objects"
	[[ $(grep -z -x -F --no-group-separator -A 1 -f <(printf '%s\n' "$BLOB") -- "$T/nl.objects" | tr '\0\n' '|~') == "$BLOB|path=a~b.txt|" ]]
	# The LFS check: where the version line starts, and the line, nothing more.
	LFS=$(git --git-dir="$G" rev-parse "$TWO:lfs.md")
	[[ $(echo "$LFS" | git --no-replace-objects --git-dir="$G" cat-file --batch | grep -a -b -o -F -e 'version https://git-lfs.github.com/spec/') == "$((47 + 2 + 2)):version https://git-lfs.github.com/spec/" ]]
	# The scan: an offset and a kind a line, every kind found, each offset where its value stands in git's batch output.
	git --no-replace-objects --git-dir="$G" cat-file --batch <"$T/list" >"$T/batch"
	/bin/sh -c "$SCAN_SCRIPT" sh "$T/status" "$T/list" 600 git --no-replace-objects --git-dir="$G" cat-file --batch >"$T/out"
	[[ $(sort "$T/status" | tr "\n" " ") == "git 0 grep 0 sed 0 " ]]
	if grep -q -v -E '^[0-9]+ (aws|github|stripe|slack|google|private-key|resend|openai|anthropic)$' "$T/out"; then exit 1; fi
	for pair in "aws $AWS" "aws ASIAZXCVBNMLKJHGFDSA" "github $GH" "stripe $STRIPE" "slack $SLACK" "google $GOOGLE" \
		"private-key $PK" "resend $RESEND" "openai $OPENAI" "anthropic $ANTHROPIC"; do
		KIND=${pair%% *} VALUE=${pair#* }
		FOUND=0
		while read -r OFFSET K; do
			[[ $K == "$KIND" && $(tail -c "+$((OFFSET + 1))" "$T/batch" | head -c "${#VALUE}") == "$VALUE" ]] && FOUND=1
		done <"$T/out"
		[[ $FOUND == 1 ]]
		# No value, and no part of one, is in what the scan said.
		for ((at = 0; at + 8 <= ${#VALUE}; at++)); do
			if grep -q -F -e "${VALUE:at:8}" "$T/out"; then exit 1; fi
		done
	done
	[[ $(wc -l <"$T/out") =~ ^\ *10$ ]]
	# A scan that does not end is stopped after its time, and says so.
	/bin/sh -c "$SCAN_SCRIPT" sh "$T/status2" "$T/list" 1 sleep 30 >"$T/out2"
	[[ $(sort "$T/status2" | tr "\n" " ") == "git 124 grep 1 sed 0 " && ! -s $T/out2 ]]
	# Past 64 KiB of offsets the output is cut at its bound.
	for i in $(seq 1 20000); do printf 'AKIA%016d\n' "$i"; done >"$T/many.txt"
	git --git-dir="$G" hash-object -w -- "$T/many.txt" >"$T/list3"
	/bin/sh -c "$SCAN_SCRIPT" sh "$T/status3" "$T/list3" 600 git --no-replace-objects --git-dir="$G" cat-file --batch >"$T/out3"
	[[ $(wc -c <"$T/out3") =~ ^\ *65536$ && $(head -n 1 "$T/out3") =~ ^[0-9]+\ aws$ ]]
	rm -rf "$T"
)
pass "an import's jobs: the sweep, the strict check's message id and what it only warns of, the refs plan's two transactions, the facts' formats, the scan's lists"
pass "C1's key scan in this image: offsets and kinds alone, each offset its value's place, every kind found, a stop after its time, the 64 KiB bound"
# The import's tidy (code-host-import.ts, its two scripts word for word: runner-orchestrator's code-host-import test pins
# them), run by dash as the job runs them: the file the import read goes through a rename aside in its own folder and is
# removed there; another file at its name is left untouched by the check that only reads; one taken aside that is not the
# file read is put back where it was; a file that is gone moves nothing.
{ IFS= read -r -d '' TIDY_SAME || true; } <<'TIDY_SAME'
[ -f "$1" ] && [ ! -L "$1" ] || exit 3
hash=$(sha256sum <"$1") || exit 3
case $hash in "$2 "*) exit 0 ;; *) exit 3 ;; esac
TIDY_SAME
{ IFS= read -r -d '' TIDY_TAKE || true; } <<'TIDY_TAKE'
file=$1 aside=$2 want=$3
mv --no-copy -T -- "$file" "$aside" 2>/dev/null || exit 3
if [ -f "$aside" ] && [ ! -L "$aside" ] && hash=$(sha256sum <"$aside"); then
	case $hash in "$want "*) rm -f -- "$aside" || exit 1; exit 0 ;; esac
fi
if [ -e "$file" ] || [ -L "$file" ]; then exit 5; fi
mv --no-copy -T -- "$aside" "$file" || exit 1
exit 4
TIDY_TAKE
(
	T=$(mktemp -d -p /var/lib/qorpera-code-host)
	mkdir -p "$T/drop"
	printf 'bundle A' >"$T/drop/a.bundle"
	A=$(printf 'bundle A' | sha256sum | cut -d" " -f1)
	/bin/sh -c "$TIDY_SAME" sh "$T/drop/a.bundle" "$A"
	/bin/sh -c "$TIDY_TAKE" sh "$T/drop/a.bundle" "$T/drop/.tidy-1" "$A"
	[[ ! -e $T/drop/a.bundle && -z $(ls -A "$T/drop") ]]
	printf 'bundle B' >"$T/drop/a.bundle"
	S=0
	/bin/sh -c "$TIDY_SAME" sh "$T/drop/a.bundle" "$A" || S=$?
	[[ $S == 3 ]]
	S=0
	/bin/sh -c "$TIDY_TAKE" sh "$T/drop/a.bundle" "$T/drop/.tidy-2" "$A" || S=$?
	[[ $S == 4 && $(cat "$T/drop/a.bundle") == "bundle B" && $(ls -A "$T/drop") == a.bundle ]]
	S=0
	/bin/sh -c "$TIDY_SAME" sh "$T/drop/gone.bundle" "$A" || S=$?
	[[ $S == 3 ]]
	S=0
	/bin/sh -c "$TIDY_TAKE" sh "$T/drop/gone.bundle" "$T/drop/.tidy-3" "$A" || S=$?
	[[ $S == 3 && $(ls -A "$T/drop") == a.bundle ]]
	rm -rf "$T"
)
pass "the import's tidy: the file read removed through a rename aside, another file left as it is, one taken aside put back"

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
# A restore's jobs (code-host-restore.ts) run these as well, with the same PATH. What a damaged repository holds is
# moved aside by a rename or not at all: mv must know --no-copy, or it would copy and delete where a rename is refused.
PATH=/usr/local/bin:/usr/bin:/bin command -v stat >/dev/null || fail "no stat in /usr/local/bin:/usr/bin:/bin"
[[ $(stat -f -c "%a %S" -- /var/lib/qorpera-code-host) =~ ^[0-9]+\ [0-9]+$ ]] || fail "stat -f does not give the free blocks and their size"
mv --no-copy --version >/dev/null 2>&1 || fail "mv does not know --no-copy"
# An import's jobs (code-host-import.ts) run sed as well, with the same PATH.
PATH=/usr/local/bin:/usr/bin:/bin command -v sed >/dev/null || fail "no sed in /usr/local/bin:/usr/bin:/bin"
D=$(mktemp -d -p /var/lib/qorpera-code-host)
mkdir -p "$D/from/repo.git/refs" "$D/to"
mv --no-copy -T -- "$D/from/repo.git" "$D/to/repo.git" || fail "mv --no-copy -T does not rename a folder"
[[ -d $D/to/repo.git/refs && ! -e $D/from/repo.git && $(find "$D/to" -mindepth 1 -maxdepth 1 -printf "%f\0" | tr "\0" " ") == "repo.git " ]] ||
	fail "the folder was not moved whole"
rm -rf "$D"
pass "the commands 5e's jobs run"
echo "ALL PASSED"
