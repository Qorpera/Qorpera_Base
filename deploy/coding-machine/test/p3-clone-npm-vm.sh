#!/usr/bin/env bash
# The VM half of p3-clone-npm.sh (read its header): run as root inside a coding session's VM, in two phases.
#
#   run     the checks, stopping at the first that fails. Prints folder=<the scratch folder's path in the folder>, and
#           published=1 and passed=1 when it got that far; everything else goes to stderr.
#   finish  removes what run made (unless P3_KEEP=1), then prints the JSON report on stdout and exits 1 if a check
#           failed or run did not finish.
#
# P3_ID names the scratch folder <worktree>/<P3_ID> and the branches. The work folder /var/tmp/<P3_ID> is on the VM's
# own disk, never on the mount: this script, the npm tarballs, a home for git's and npm's settings and npm's cache, and
# the records of the checks. With P3_CHECK=<scratch folder> run only checks an earlier run's node_modules (that run
# kept with P3_KEEP=1) and publishes, so a run can check again after a turn's own publish.
set -euo pipefail
shopt -s inherit_errexit
export LC_ALL=C

phase=${1:?run or finish}
check=${P3_CHECK:-}
if [[ -n $check ]]; then
	check=${check%/}
	id=${check##*/}
	worktree=${check%/*}
else
	id=${P3_ID:?}
	worktree=${P3_WORKTREE:?}
	worktree=${worktree%/}
fi
remote=${P3_REMOTE:-}
# The work and scratch folders are removed at the end: only ever this script's own names.
[[ $id =~ ^p3-[0-9]{14}-[0-9]+$ ]] || {
	echo "not a P3 scratch folder: $id (p3-<UTC time>-<n>)" >&2
	exit 2
}
work=/var/tmp/$id
steps=$work/steps.jsonl
facts=$work/facts.tsv
home=$work/home
scratch=$worktree/$id
export GIT_AUTHOR_NAME="P3 proof" GIT_AUTHOR_EMAIL=p3-proof@qorpera.invalid
export GIT_COMMITTER_NAME="P3 proof" GIT_COMMITTER_EMAIL=p3-proof@qorpera.invalid GIT_TERMINAL_PROMPT=0
uid=
gid=
if [[ -n ${P3_USER:-} ]]; then
	uid=${P3_USER%%:*}
	if [[ $P3_USER == *:* ]]; then gid=${P3_USER#*:}; else gid=$(id -g "$uid" 2>/dev/null || echo "$uid"); fi
	[[ $uid =~ ^[0-9]+$ && $gid =~ ^[0-9]+$ ]] || {
		echo "P3_USER is not <uid>[:<gid>]: $P3_USER" >&2
		exit 2
	}
else
	# Root in the session's worktree, which is the session's: git refuses a repository another account owns.
	export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
fi

fail() {
	echo "$*" >&2
	exit 1
}
# A fact for the report: fact <key> <value> (a string), count <key> <value> (a number).
fact() { printf '%s\t%s\ts\n' "$1" "$2" >>"$facts"; }
count() { printf '%s\t%s\tn\n' "$1" "$2" >>"$facts"; }
# A command as the session's account (root without P3_USER), with this run's home.
as() {
	if [[ -n $uid ]]; then
		setpriv --reuid="$uid" --regid="$gid" --clear-groups -- env HOME="$home" npm_config_cache="$home/.npm" "$@"
	else
		env HOME="$home" npm_config_cache="$home/.npm" "$@"
	fi
}
# A file written as the session's account, from stdin.
put() { as tee "$1" >/dev/null; }
# 5d's mount gives a file it keeps on the VM's disk that file's inode with the top bit set (local.rs LOCAL); the
# node's files never have it. Compared as strings: 2^63 needs 19 digits, and bash's numbers are signed.
local_inode() { [[ ${#1} -eq 20 || (${#1} -eq 19 && ! $1 < 9223372036854775808) ]]; }

# Runs one check in a subshell of its own, so its first failing command ends it, and records it; ok says whether it
# passed. Never call it in a condition (if, && or ||): bash ignores set -e in all that runs there, the subshell too.
ok=0
step() {
	local name=$1 t0 t1 rc
	shift
	t0=$EPOCHREALTIME
	set +e
	(
		set -euo pipefail
		"$@"
	) >"$work/out" 2>&1 </dev/null
	rc=$?
	set -e
	t1=$EPOCHREALTIME
	jq -cn --arg step "$name" --argjson rc "$rc" --argjson t0 "$t0" --argjson t1 "$t1" --rawfile out "$work/out" \
		'{step: $step, ok: ($rc == 0), seconds: ((($t1 - $t0) * 1000 | round) / 1000)}
		+ if $rc == 0 then {} else {exit: $rc, output: ($out | split("\n") | .[-40:] | join("\n"))} end' >>"$steps"
	if [[ $rc -ne 0 ]]; then
		echo "p3: $name failed:" >&2
		cat "$work/out" >&2
	fi
	ok=$((rc == 0))
}
skip() { jq -cn --arg step "$1" --arg why "$2" '{step: $step, ok: true, skipped: $why}' >>"$steps"; }

# The mount the worktree is on, and its program's view file, state folder and local folder.
find_mount() {
	local tool
	for tool in git node npm jq setpriv stat find findmnt; do
		command -v "$tool" >/dev/null || fail "no $tool in the VM"
	done
	[[ -d $worktree ]] || fail "no folder $worktree"
	[[ $worktree =~ (^|/)(code/[^/]+/[^/]+/worktrees/[^/]+)$ ]] ||
		fail "$worktree is not a worker's worktree (.../code/<owner>/<name>/worktrees/<worker>): 5d keeps caches on the disk only there"
	local rel=${BASH_REMATCH[2]} dev p i m v s l c found=0
	local -a argv
	local mountpoint="" view_file=${P3_VIEW_FILE:-} state_dir=${P3_STATE_DIR:-} local_dir=${P3_LOCAL_DIR:-} connect=""
	local program=${P3_PROGRAM:-}
	[[ $(findmnt -n -o FSTYPE --target "$worktree") == fuse* ]] || fail "$worktree is not on a FUSE mount"
	dev=$(stat -c %d "$worktree")
	# The mount program whose mountpoint is the same file system as the worktree (the session may see it elsewhere
	# through a bind mount).
	for p in /proc/[0-9]*; do
		mapfile -d '' -t argv <"$p/cmdline" 2>/dev/null || continue
		[[ ${argv[0]:-} == *qorpera-folder && ${argv[1]:-} == mount ]] || continue
		m="" v="" s="" l="" c=""
		for ((i = 2; i + 1 < ${#argv[@]}; i++)); do
			case ${argv[i]} in
			--mountpoint) m=${argv[i + 1]} ;;
			--view-file) v=${argv[i + 1]} ;;
			--state-dir) s=${argv[i + 1]} ;;
			--local-dir) l=${argv[i + 1]} ;;
			--connect) c=${argv[i + 1]} ;;
			esac
		done
		[[ -n $m && $(stat -c %d "$m" 2>/dev/null) == "$dev" ]] || continue
		found=$((found + 1))
		mountpoint=$m connect=$c
		view_file=${P3_VIEW_FILE:-$v} state_dir=${P3_STATE_DIR:-$s} local_dir=${P3_LOCAL_DIR:-$l}
		[[ -n $program ]] || program=$(readlink -f "$p/exe")
	done
	((found <= 1)) || fail "$found qorpera-folder mounts serve $worktree"
	if ((found == 1)); then
		[[ $(stat -c %d:%i "$mountpoint/$rel") == "$(stat -c %d:%i "$worktree")" ]] ||
			fail "$mountpoint/$rel is not $worktree: the mount's root is not the folder's root"
	fi
	[[ -n $state_dir ]] || fail "no mount program found with --state-dir for $worktree (give P3_STATE_DIR)"
	local_dir=${local_dir:-$state_dir/local}
	program=${program:-/opt/qorpera-folder/qorpera-folder}
	[[ -d $local_dir ]] || fail "no local folder $local_dir (the mount's --local-dir)"
	printf 'mountpoint=%q\nview_file=%q\nstate_dir=%q\nlocal_dir=%q\nconnect=%q\nprogram=%q\nfolder=%q\n' \
		"$mountpoint" "$view_file" "$state_dir" "$local_dir" "$connect" "$program" "$rel/$id" >"$work/found"
	fact mountpoint "$mountpoint"
	fact stateDir "$state_dir"
	fact localDir "$local_dir"
}

# Two packages packed on the VM's disk: p3-dep has a bin and bundles p3-leaf (a nested node_modules).
fixtures() {
	local pkgs=$work/pkgs
	as mkdir -p "$pkgs/p3-leaf" "$pkgs/p3-dep/bin" "$pkgs/p3-dep/node_modules"
	put "$pkgs/p3-leaf/package.json" <<'EOF'
{ "name": "p3-leaf", "version": "1.0.0", "main": "index.js" }
EOF
	put "$pkgs/p3-leaf/index.js" <<'EOF'
module.exports = () => "p3-leaf 1.0.0";
EOF
	put "$pkgs/p3-dep/package.json" <<'EOF'
{
	"name": "p3-dep",
	"version": "1.0.0",
	"main": "index.js",
	"bin": { "p3-hello": "bin/hello.js" },
	"dependencies": { "p3-leaf": "1.0.0" },
	"bundleDependencies": ["p3-leaf"]
}
EOF
	put "$pkgs/p3-dep/index.js" <<'EOF'
module.exports = () => `${require("p3-leaf")()} via p3-dep`;
EOF
	put "$pkgs/p3-dep/bin/hello.js" <<'EOF'
#!/usr/bin/env node
console.log(`hello from ${require("..")()}`);
EOF
	as cp -R "$pkgs/p3-leaf" "$pkgs/p3-dep/node_modules/p3-leaf"
	as env -C "$pkgs" npm pack --offline --silent ./p3-dep >/dev/null
	[[ -f $pkgs/p3-dep-1.0.0.tgz ]] || fail "npm pack made no p3-dep-1.0.0.tgz"
}

clone() {
	as mkdir "$scratch"
	as git clone --quiet "$remote" "$scratch/repo"
	if as git -C "$scratch/repo" rev-parse -q --verify HEAD >/dev/null; then
		fact remoteWasEmpty false
	else
		fact remoteWasEmpty true
	fi
}

# A small npm app in p3-app/, beside whatever the remote holds: a lock file, node_modules ignored, a symbolic link.
edit() {
	local app=$scratch/repo/p3-app
	as mkdir "$app"
	put "$app/package.json" <<EOF
{
	"name": "p3-app",
	"version": "1.0.0",
	"private": true,
	"scripts": { "postinstall": "node -e \"require('fs').writeFileSync('node_modules/.p3-postinstall', 'ran')\"" },
	"dependencies": { "p3-dep": "file:$work/pkgs/p3-dep-1.0.0.tgz" }
}
EOF
	put "$app/index.js" <<'EOF'
console.log(require("p3-dep")());
EOF
	printf 'node_modules/\n' | put "$app/.gitignore"
	as ln -s index.js "$app/main.js"
	# The lock file only: npm would run the app's own postinstall even so, before there is a node_modules.
	as env -C "$app" npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund --silent
	[[ -f $app/package-lock.json ]] || fail "npm wrote no package-lock.json"
}

commit() {
	local repo=$scratch/repo
	as git -C "$repo" add -A
	as git -C "$repo" commit --quiet -m "P3 proof $id: a small npm app"
	[[ $(as git -C "$repo" ls-files -s p3-app/main.js | cut -d' ' -f1) == 120000 ]] ||
		fail "p3-app/main.js was not committed as a symbolic link"
	fact commit "$(as git -C "$repo" rev-parse HEAD)"
}

push() {
	local repo=$scratch/repo head
	head=$(as git -C "$repo" rev-parse HEAD)
	as git -C "$repo" push --quiet origin "HEAD:refs/heads/$id"
	[[ $(as git -C "$repo" ls-remote origin "refs/heads/$id" | cut -f1) == "$head" ]] ||
		fail "the remote's $id is not $head"
	fact branch "$id"
}

# The pushed branch, cloned again: the same commit, the link checked out as a link, nothing changed.
clone_branch() {
	local again=$scratch/again changes
	as git clone --quiet --branch "$id" "$remote" "$again"
	[[ $(as git -C "$again" rev-parse HEAD) == "$(as git -C "$scratch/repo" rev-parse HEAD)" ]] ||
		fail "the second clone's HEAD is not the pushed commit"
	[[ -L $again/p3-app/main.js && $(readlink "$again/p3-app/main.js") == index.js ]] ||
		fail "p3-app/main.js did not check out as a symbolic link to index.js"
	changes=$(as git -C "$again" status --porcelain)
	[[ -z $changes ]] || fail "the fresh clone shows changes: $changes"
}

# A clone by path, without --local (which refuses to copy): git hard-links each object, the mount answers EXDEV in an
# object store (LK4), and git copies instead.
clone_path() {
	local copy=$scratch/copy
	as git clone --quiet "$scratch/repo" "$copy"
	[[ $(as git -C "$copy" rev-parse HEAD) == "$(as git -C "$scratch/repo" rev-parse HEAD)" ]] ||
		fail "the clone by path's HEAD is not the first clone's"
	as git -C "$copy" fsck --no-progress
}

npm_ci() {
	local app=$scratch/again/p3-app changes
	as env -C "$app" npm ci --offline --no-audit --no-fund --silent
	[[ $(as env -C "$app" node index.js) == "p3-leaf 1.0.0 via p3-dep" ]] ||
		fail "index.js did not print what its dependencies return"
	[[ -L $app/node_modules/.bin/p3-hello ]] || fail "node_modules/.bin/p3-hello is not a symbolic link"
	[[ $(as env -C "$app" node_modules/.bin/p3-hello) == "hello from p3-leaf 1.0.0 via p3-dep" ]] ||
		fail "the p3-hello bin did not run"
	[[ -f $app/node_modules/p3-dep/node_modules/p3-leaf/index.js ]] || fail "no nested node_modules/p3-leaf in p3-dep"
	[[ $(cat "$app/node_modules/.p3-postinstall") == ran ]] || fail "the postinstall script did not run"
	changes=$(as git -C "$scratch/again" status --porcelain)
	[[ -z $changes ]] || fail "npm ci left changes git sees: $changes"
}

# node_modules is on the VM's disk: the local folder holds what the mount shows there, and the mount serves every
# entry under it from the disk (a local inode), while the app's own files are the folder's.
on_disk() {
	local app=$scratch/again/p3-app through on n ino bad=0
	local disk=$local_dir/cache/$folder/again/p3-app/node_modules
	[[ -d $app/node_modules ]] || fail "no $app/node_modules"
	[[ -d $disk ]] || fail "node_modules is not in the local folder: no $disk"
	through=$(cd "$app/node_modules" && find . -printf '%P %y\n' | sort)
	on=$(cd "$disk" && find . -printf '%P %y\n' | sort)
	[[ $through == "$on" ]] ||
		fail "the mount's node_modules and the local folder's differ: $(diff <(echo "$through") <(echo "$on") | head -20)"
	n=$(grep -c . <<<"$through")
	((n >= 10)) || fail "only $n entries in node_modules"
	while read -r ino; do
		local_inode "$ino" || bad=$((bad + 1))
	done < <(find "$app/node_modules" -printf '%i\n')
	((bad == 0)) || fail "$bad entries under node_modules are the node's (no local inode)"
	if local_inode "$(stat -c %i "$app/package.json")"; then
		fail "p3-app/package.json has a local inode; it should be the folder's"
	fi
	count nodeModulesEntries "$n"
	fact nodeModulesOnDisk "$disk"
}

# One file committed in the session's own worktree (the shared repo.git: its object store and ref locks) and pushed.
session_commit() {
	local name=$id-session.txt head
	printf 'P3 proof %s\n' "$id" | put "$worktree/$name"
	as git -C "$worktree" add -- "$name"
	as git -C "$worktree" commit --quiet -m "P3 proof $id: a commit in the session's worktree" -- "$name"
	head=$(as git -C "$worktree" rev-parse HEAD)
	as git -C "$worktree" push --quiet "$remote" "HEAD:refs/heads/$id-session"
	[[ $(as git -C "$worktree" ls-remote "$remote" "refs/heads/$id-session" | cut -f1) == "$head" ]] ||
		fail "the remote's $id-session is not $head"
	fact sessionBranch "$id-session"
	fact sessionCommit "$head"
}

# publish <report file>: the mount's pending changes published (a boundary), as a turn's end does.
publish_to() {
	local rc=0
	[[ -n $view_file ]] || fail "the mount program has no --view-file (give P3_VIEW_FILE)"
	"$program" publish --view-file "$view_file" --state-dir "$state_dir" ${connect:+--connect "$connect"} --json \
		>"$1" 2>"$1.err" || rc=$?
	# 4: a path was not saved; which ones is in the report, and only this run's are checked.
	[[ $rc -eq 0 || $rc -eq 4 ]] || fail "publish exited $rc: $(tail -5 "$1.err")"
	[[ -s $1 ]] || fail "publish printed no report: $(tail -5 "$1.err")"
	echo "$rc"
}

# Nothing under node_modules is in what the mount published, and every path of this run's was saved (a full run's
# app among them).
publish() {
	local report=$work/publish.json rc mine
	rc=$(publish_to "$report")
	mine=$(jq -c --arg p "$folder/" '[.paths[] | .path |= ltrimstr("/") | select(.path | startswith($p))]' "$report")
	jq -e '.refused == null' "$report" >/dev/null || fail "the boundary was refused: $(jq -c .refused "$report")"
	jq -e 'all(.[]; .path | test("(^|/)node_modules(/|$)") | not)' <<<"$mine" >/dev/null ||
		fail "node_modules reached the node: $(jq -c '[.[] | select(.path | test("(^|/)node_modules(/|$)")) | .path] | .[:10]' <<<"$mine")"
	jq -e 'all(.[]; .outcome == "saved")' <<<"$mine" >/dev/null ||
		fail "not saved: $(jq -c '[.[] | select(.outcome != "saved")] | .[:10]' <<<"$mine")"
	if [[ -z $check ]]; then
		jq -e --arg app "$folder/again/p3-app/package.json" 'any(.[]; .path == $app)' <<<"$mine" >/dev/null ||
			fail "the report has no $folder/again/p3-app/package.json: the clone was not published"
	fi
	count publishExit "$rc"
	count publishedPaths "$(jq length <<<"$mine")"
	count publishedOtherPaths "$(jq --arg p "$folder/" '[.paths[] | select(.path | ltrimstr("/") | startswith($p) | not)] | length' "$report")"
	fact publishCommit "$(jq -r '.commitId // ""' "$report")"
	touch "$work/published"
}

# The scratch folder removed through the mount (its node_modules leaves the local folder with it), and the removal
# published when run published.
cleanup() {
	local report=$work/publish-cleanup.json
	if [[ -e $scratch ]]; then as rm -rf "$scratch"; fi
	[[ ! -e $scratch ]] || fail "$scratch is still there"
	if [[ -n ${local_dir:-} && -n ${folder:-} ]]; then
		[[ ! -e $local_dir/cache/$folder/again/p3-app/node_modules ]] ||
			fail "the local folder still holds $local_dir/cache/$folder/again/p3-app/node_modules"
	fi
	if [[ -f $work/published ]]; then
		publish_to "$report" >/dev/null
		jq -e --arg p "$folder/" '.refused == null and all(.paths[] | select(.path | ltrimstr("/") | startswith($p)); .outcome == "saved")' \
			"$report" >/dev/null || fail "the removal was not published: $(jq -c '{refused, paths: .paths[:10]}' "$report")"
	fi
}

run() {
	: >"$steps"
	: >"$facts"
	rm -f "$work/found" "$work/published" "$work/passed"
	if [[ -n $uid ]]; then install -d -m 0700 -o "$uid" -g "$gid" "$home"; else install -d -m 0700 "$home"; fi
	if [[ -n $uid ]]; then install -d -m 0755 -o "$uid" -g "$gid" "$work/pkgs"; else install -d -m 0755 "$work/pkgs"; fi
	step preflight find_mount
	((ok)) || return 0
	# shellcheck source=/dev/null
	source "$work/found"
	echo "folder=$folder"
	local each
	if [[ -z $check ]]; then
		for each in fixtures clone edit commit push clone-branch:clone_branch clone-path:clone_path npm-ci:npm_ci; do
			step "${each%%:*}" "${each#*:}"
			((ok)) || return 0
		done
	fi
	step node-modules-on-disk on_disk
	((ok)) || return 0
	if [[ -n $check ]]; then
		skip session-commit "P3_CHECK: checks only"
	elif [[ -e $worktree/.git ]]; then
		step session-commit session_commit
		((ok)) || return 0
	else
		skip session-commit "$worktree is not a git worktree"
	fi
	if [[ ${P3_PUBLISH:-1} == 0 ]]; then
		skip publish "P3_PUBLISH=0"
	else
		step publish publish
		((ok)) || return 0
		echo published=1
	fi
	touch "$work/passed"
	echo passed=1
}

finish() {
	local report complete=false rc=1
	touch "$steps" "$facts"
	if [[ -f $work/found ]]; then
		# shellcheck source=/dev/null
		source "$work/found"
	fi
	# The outer half's check of the node's paths, when it ran one.
	case ${P3_HOST_CHECK:-} in
	passed | failed)
		jq -cn --arg ok "$P3_HOST_CHECK" --arg detail "${P3_HOST_DETAIL:-}" --argjson s "${P3_HOST_SECONDS:-0}" \
			'{step: "node-list", ok: ($ok == "passed"), seconds: $s} + if $ok == "passed" then {detail: $detail} else {output: $detail} end' \
			>>"$steps"
		;;
	skipped) skip node-list "${P3_HOST_DETAIL:-}" ;;
	esac
	if [[ -f $work/passed ]]; then complete=true; fi
	if [[ ${P3_KEEP:-0} == 1 ]]; then
		skip cleanup "P3_KEEP=1: $scratch and $work stay"
	else
		step cleanup cleanup
	fi
	report=$(jq -n --slurpfile steps "$steps" --rawfile facts "$facts" --argjson complete "$complete" \
		--arg mode "$([[ -n $check ]] && echo check || echo full)" --arg id "$id" --arg worktree "$worktree" \
		--arg scratch "$scratch" --arg folder "${folder:-}" --arg remote "$remote" --arg user "${uid:-root}" '
		($facts | split("\n") | map(select(length > 0) | split("\t")
			| {key: .[0], value: (if .[2] == "n" then (.[1] | tonumber) else .[1] end)}) | from_entries) as $f
		| {ok: ($complete and ($steps | all(.ok))), complete: $complete, mode: $mode, id: $id, user: $user,
			worktree: $worktree, scratch: $scratch, folderPath: $folder, remote: $remote}
		+ $f + {steps: $steps}')
	if [[ ${P3_KEEP:-0} != 1 ]]; then rm -rf "$work"; fi
	echo "$report"
	if jq -e .ok <<<"$report" >/dev/null; then rc=0; fi
	return "$rc"
}

case $phase in
run) run ;;
finish) finish ;;
*) fail "unknown phase $phase (run or finish)" ;;
esac
