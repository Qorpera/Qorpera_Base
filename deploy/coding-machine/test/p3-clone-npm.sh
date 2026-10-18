#!/usr/bin/env bash
# P3's git and npm proof on the company folder (contract amendment #1020 items 4 and 8; RUNTIME-FOLDER-CODING-MACHINES.md
# "Links" and "The cache list"), run as root on a test machine by the P3 proof run once a coding session's VM is up:
#
#   P3_PROJECT=<LXD project> P3_VM=<instance> P3_WORKTREE=<.../code/<owner>/<name>/worktrees/<worker> in the VM> \
#     P3_REMOTE=<a throwaway repository's URL> P3_USER=<the session's uid> \
#     bash deploy/coding-machine/test/p3-clone-npm.sh </dev/null
#
# In the VM, as the session's account (root without P3_USER), in a scratch folder <worktree>/p3-<time>-<n>: git clone
# P3_REMOTE; add a small npm app (a lock file, node_modules ignored, a symbolic link) and commit it; push it as the
# branch p3-<time>-<n>; clone that branch again (the same commit, the link checked out as a link); clone the first clone
# by its path (git hard-links objects, the mount answers EXDEV in an object store and git copies); npm ci, offline, from
# tarballs packed on the VM's disk (a dependency with a bin and a bundled dependency of its own, and a postinstall
# script). Then node_modules must be on the VM's disk: in the mount program's caches (in its --cache-dir, or its local
# folder without one), with every entry under it a local inode, git seeing no change. If the worktree is a git worktree, one file is committed there too and pushed as
# p3-<time>-<n>-session (the shared repo.git's objects and ref locks). Last, the mount's pending changes are published,
# as a turn's end does: the boundary must not be refused, and of this run's paths in its report every one must be saved
# and none under node_modules. The mount also publishes on its own (about 2 s after the last change), so that report
# may hold little of the clone: what the node holds is checked here with P3_NODE_LIST. Everything in the scratch
# folder is removed at the end, and the removal published (unless P3_PUBLISH=0).
#
# Options:
#   P3_PUBLISH=0     no publish (the turn's own publish comes later; check again with P3_CHECK).
#   P3_KEEP=1        keep the scratch folder and the VM's work folder /var/tmp/p3-<time>-<n>.
#   P3_CHECK=<scratch folder in the VM>
#                    only check a kept run's node_modules again (and publish, unless P3_PUBLISH=0), then remove it
#                    (unless P3_KEEP=1). P3_WORKTREE and P3_REMOTE are not needed.
#   P3_NODE_LIST=<command>
#                    run here after the publish with the scratch folder's path in the folder as $1; it prints the
#                    node's paths under it, one per line. Fails on any node_modules, or without the clone's package.json
#                    (in both modes). Without it, nothing checks that the node holds the clone.
#   P3_STATE_DIR, P3_VIEW_FILE, P3_LOCAL_DIR, P3_CACHE_DIR, P3_PROGRAM
#                    the mount program's, when they can't be read from its command line in the VM.
#
# Prints one JSON object on stdout (each check with its seconds; folderPath is the scratch folder's path in the folder,
# for a check of the core's entries) and exits 1 if any check failed. Diagnostics go to stderr.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

json_string() {
	local s=$1
	s=${s//\\/\\\\}
	s=${s//\"/\\\"}
	s=${s//$'\n'/\\n}
	s=${s//$'\r'/\\r}
	s=${s//$'\t'/\\t}
	printf '"%s"' "$s"
}
fail() {
	printf '{"ok":false,"error":%s}\n' "$(json_string "$*")"
	echo "FAIL: $*" >&2
	exit 1
}
lx() { lxc --project "$P3_PROJECT" "$@" </dev/null; }

for name in P3_PROJECT P3_VM; do [[ -n ${!name:-} ]] || fail "$name is required"; done
if [[ -n ${P3_CHECK:-} ]]; then
	id=${P3_CHECK%/}
	id=${id##*/}
else
	for name in P3_WORKTREE P3_REMOTE; do [[ -n ${!name:-} ]] || fail "$name is required"; done
	id=p3-$(date -u +%Y%m%d%H%M%S)-$RANDOM
fi
[[ $id =~ ^p3-[0-9]{14}-[0-9]+$ ]] || fail "P3_CHECK is not a P3 scratch folder: ${P3_CHECK:-}"
[[ $(id -u) -eq 0 ]] || fail "run as root (run-on-node.mjs --sudo)"
command -v lxc >/dev/null || fail "no LXD here"
lx exec "$P3_VM" -- true || fail "cannot run a command in $P3_VM (LXD project $P3_PROJECT)"

work=/var/tmp/$id
lx exec "$P3_VM" -- install -d -m 0755 "$work" || fail "cannot make $work in the VM"
lx file push --mode 0700 "$here/p3-clone-npm-vm.sh" "$P3_VM$work/vm.sh" >/dev/null || fail "cannot copy the VM half in"

# vm <phase> [lxc exec options]: the VM half, with this run's settings.
vm() {
	local phase=$1
	shift
	lx exec "$P3_VM" --env P3_ID="$id" --env P3_WORKTREE="${P3_WORKTREE:-}" --env P3_REMOTE="${P3_REMOTE:-}" \
		--env P3_CHECK="${P3_CHECK:-}" --env P3_USER="${P3_USER:-}" --env P3_PUBLISH="${P3_PUBLISH:-1}" \
		--env P3_KEEP="${P3_KEEP:-0}" --env P3_STATE_DIR="${P3_STATE_DIR:-}" --env P3_VIEW_FILE="${P3_VIEW_FILE:-}" \
		--env P3_LOCAL_DIR="${P3_LOCAL_DIR:-}" --env P3_CACHE_DIR="${P3_CACHE_DIR:-}" --env P3_PROGRAM="${P3_PROGRAM:-}" \
		"$@" -- bash "$work/vm.sh" "$phase"
}

# The node's paths under the scratch folder, from P3_NODE_LIST: none under node_modules, the clone's app among them.
node_list() {
	local listing rc=0 modules
	listing=$(bash -c "$P3_NODE_LIST" p3-node-list "$folder" </dev/null 2>&1) || rc=$?
	if ((rc != 0)); then
		echo "P3_NODE_LIST exited $rc: $(tail -5 <<<"$listing")"
		return 1
	fi
	modules=$(grep -E '(^|/)node_modules(/|$)' <<<"$listing" | head -5 || true)
	if [[ -n $modules ]]; then
		echo "the node holds node_modules: $modules"
		return 1
	fi
	# A kept run's scratch folder (P3_CHECK) holds the clone too.
	if ! grep -qxF -e "$folder/again/p3-app/package.json" -e "/$folder/again/p3-app/package.json" <<<"$listing"; then
		echo "the node's paths have no $folder/again/p3-app/package.json: not this run's folder, or the clone was not published"
		return 1
	fi
	echo "$(grep -c . <<<"$listing") paths, none under node_modules"
}

# The checks; their records stay in the VM for finish, which reports them whatever happens here.
ran=$(vm run) || true
folder=$(sed -n 's/^folder=//p' <<<"$ran")
host=()
if [[ -n ${P3_NODE_LIST:-} ]]; then
	if grep -qx 'published=1' <<<"$ran" && grep -qx 'passed=1' <<<"$ran"; then
		t0=$EPOCHREALTIME
		detail=$(node_list) && status=passed || status=failed
		seconds=$(awk -v a="$t0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.3f", b - a }')
		host=(--env P3_HOST_CHECK="$status" --env P3_HOST_DETAIL="$detail" --env P3_HOST_SECONDS="$seconds")
	elif grep -qx 'passed=1' <<<"$ran"; then
		host=(--env P3_HOST_CHECK=skipped --env "P3_HOST_DETAIL=nothing was published (P3_PUBLISH=0)")
	fi
else
	host=(--env P3_HOST_CHECK=skipped --env "P3_HOST_DETAIL=no P3_NODE_LIST: what the node holds was not checked")
fi

rc=0
report=$(vm finish "${host[@]}") || rc=$?
[[ -n $report ]] || fail "the VM half printed no report (exit $rc)"
printf '%s\n' "$report"
exit "$rc"
