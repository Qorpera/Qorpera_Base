#!/usr/bin/env bash
# Every machine's memory at the edge, and the click on the spot the pointer is on (deploy/machine/README.md, "Memory"),
# proven on throwaway machines made from a built machine image.
#
#   prove-machine-memory.sh <image-fingerprint> <build-project> <build-network> <storage-pool> [part...]
#
# It runs as root on an LXD host that has the image, in its image build space (on node 2: qorpera-build qorpera0
# qorpera-vm). Each machine is made the way build-machine-image.sh makes its builder (no profiles, its own 10 GiB root,
# the isolation NIC, never autostarting, the builder marker), so a node's observer counts it against the build space
# and the node stays ready. It refuses while the space holds anything, makes one machine at a time, and deletes it on
# every exit path, by its exact name. The machines reach the internet through the build network, as a builder does:
# the load is real sites. No executor renews their lease, so the watchdog timer is stopped inside. It changes nothing
# else on its host and reads nothing of production.
#
# Parts (all three unless named):
#   checks    2 processors / 4 GiB. What must hold, as CHECK lines: compressed memory after a boot and its unit run
#             again; the guard and who is protected; the idle rule's measure on the quiet machine; two clicks, a
#             double-click, a move and drags on one spot, each under a second; a boot with the zram module hidden;
#             and past the edge of its memory (heavy web apps, a 1.5 GB job run as a machine command, tabs until three
#             were ended): `desktop click` asked from this host every second keeps being answered the whole time
#             (the bar is at `probed` below), and so does a look of the guest helper every tenth round; every phase
#             of the browser's work ends well; something was ended and named in the journal, and only what may be
#             (browser tabs first, Chromium's helper processes, the agent's job: never the browser itself); and the
#             browser, the desktop, the helper and the machine's own services are alive after. Then an agent's job
#             that outgrows the machine (twice its memory): it is the one ended, the clicks still answer, and its
#             command ends in a way an agent can read.
#   numbers   2 processors / 4 GiB, for a person: the mixed desktop leg with nothing else running and with every
#             processor busy, then heavy apps, the 1.5 GB job and 24 tabs, stopping before the edge. Its phases must
#             end well too, and after it the journal says what was ended (nothing has to be), by the same checks.
#   small     2 processors / 2 GiB with the desktop's size check lowered FOR THE TEST ONLY: heavy apps, a 600 MB job
#             and tabs, stopping before the edge; judged as numbers.
#   small-past  only when named: that small machine past the edge, with the clicks asked and judged as in checks.
#   edge      only when named: the checks part's past-the-edge leg alone, on a fresh 2 processors / 4 GiB machine (name
#             it several times to run it several times).
#
# It ends with PROOF PASSED and exit 0 only if no check failed, at least one check was made, and every part it was
# asked for ran to its end. Nothing passes on an answer that never came: the in-machine half (guest.sh) decides each
# check on what was really answered, and a leg, a look or a browser phase that did not end well is a failed check.
set -euo pipefail

IMAGE=${1:?image fingerprint}
PROJECT=${2:?the build space project, for example qorpera-build}
NETWORK=${3:?the build space network, for example qorpera0}
POOL=${4:?the storage pool, for example qorpera-vm}
shift 4
PARTS=("$@")
(( ${#PARTS[@]} )) || PARTS=(checks numbers small)
fail() { echo "FAIL: $*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail "run as root"
[[ $IMAGE =~ ^[0-9a-f]{64}$ ]] || fail "an image is named by its whole fingerprint"
for part in "${PARTS[@]}"; do [[ $part =~ ^(checks|numbers|small|small-past|edge)$ ]] || fail "no such part: $part"; done
[[ $PROJECT != default && $PROJECT != machines ]] || fail "the proof runs in the node's build space, not in $PROJECT"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/machine-memory-proof
# The proof's pieces that go into the machine.
PIECES=(guest.sh pages.cjs verdicts.cjs job.cjs app.html video.html pointer.html)
for file in "${PIECES[@]}"; do [[ -f $here/$file ]] || fail "missing $here/$file"; done
lx() { lxc --project "$PROJECT" "$@" </dev/null; }
# Inside the machine, never for longer than two minutes: a machine that stopped answering must not hold the proof.
inside() { timeout 120 lxc --project "$PROJECT" exec "$MACHINE" -- "$@" </dev/null; }
# The names in the build space, one a line. A list that could not be read is no empty build space: whoever asks ends
# with it (`|| exit 1` where it is asked, so that holds wherever errexit does not reach).
names() { lx list -f csv -c n || fail "the build space $PROJECT could not be listed"; }
lx image info "$IMAGE" >/dev/null 2>&1 || fail "the project $PROJECT does not see the image $IMAGE"
held=$(names) || exit 1
[[ -z $held ]] || fail "the build space $PROJECT is in use: prove when it is empty"

MACHINE="qorpera-machine-build-memory-proof-$$"
work=$(mktemp -d /tmp/qorpera-machine-memory-proof.XXXXXXXX)
cleanup() {
	local status=$?
	trap - EXIT
	set +e
	touch "$work/stop"
	wait 2>/dev/null
	# Gone means: a list that could be read no longer names it.
	local left=unknown listed
	for _ in 1 2 3; do
		lx delete --force "$MACHINE" >/dev/null 2>&1
		if listed=$(lx list -f csv -c n 2>/dev/null); then
			if grep -qx -- "$MACHINE" <<<"$listed"; then left=yes; else left=no; fi
		else
			left=unknown
		fi
		[[ $left == no ]] && break
		sleep 3
	done
	[[ $left == no ]] || { echo "the machine $MACHINE may still be there (seen: $left): look, and delete it by hand" >&2; status=1; }
	rm -rf -- "$work"
	echo "cleanup done (status $status); the build space now holds: [$(lx list -f csv -c n | tr '\n' ' ')]"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

usable() { # waits until the boot is usable, as the executor judges it
	for _ in $(seq 1 240); do
		[[ $(inside systemctl is-active basic.target network-online.target 2>/dev/null | tr '\n' ' ') == "active active " ]] && return 0
		sleep 0.5
	done
	return 1
}
settle() { # the boot's last jobs are done (or 60 s passed), the watchdog timer stopped, the proof's pieces in place
	# Only a wait: what it answers (running, degraded, cut off) is not judged here. `no unit failed` is a check inside.
	inside timeout 60 systemctl is-system-running --wait >/dev/null 2>&1 || true
	inside systemctl stop qorpera-machine-watchdog.timer qorpera-machine-watchdog.service || fail "the machine's watchdog could not be stopped"
	inside mkdir -p /srv/memory-proof || fail "the proof's folder could not be made in the machine"
	local file
	for file in "${PIECES[@]}"; do
		lx file push "$here/$file" "$MACHINE/srv/memory-proof/$file" --uid 0 --gid 0 --mode 0755 || fail "$file could not be put into the machine"
	done
}
# Every step that makes, starts, restarts or deletes the machine, or puts a file into it, ends the part when it fails
# (`|| fail`): a part must never go on with a machine it did not make. Review round 2 of #1692: with those steps
# unjudged, a delete that failed after one part let the next part's checks run on the machine left behind.
machine() { # cpus memory (whole GiB): a NEW machine of that size, running, with the proof's pieces in it
	local started held cpus kb asked
	started=$(date +%s)
	held=$(names) || exit 1
	[[ -z $held ]] || fail "the build space holds [$(tr '\n' ' ' <<<"$held")] where a part's new machine is to be made"
	lx init "$IMAGE" "$MACHINE" --vm --no-profiles --storage "$POOL" -d root,size=10GiB -n "$NETWORK" \
		-d eth0,security.mac_filtering=true -d eth0,security.ipv4_filtering=true -d eth0,security.ipv6_filtering=true \
		-d eth0,security.port_isolation=true -c limits.cpu="$1" -c limits.memory="$2" -c boot.mode=uefi-secureboot \
		-c boot.autostart=false -c user.qorpera.image_builder=true -c user.qorpera.purpose=machine-image ||
		fail "the machine could not be made"
	lx start "$MACHINE" || fail "the machine could not be started"
	usable || fail "the machine did not become usable"
	echo "M machine cpus=$1 memory=$2 usable_s=$(( $(date +%s) - started ))"
	# It is the machine this part asked for: its processors, and its memory as the machine itself counts it (a little
	# under what it was given, never over, never the size of another part's machine).
	[[ $2 =~ ^[1-9][0-9]*GiB$ ]] || fail "a machine's memory is asked in whole GiB, not as $2"
	asked=$(( ${2%GiB} * 1048576 ))
	cpus=$(inside nproc) || fail "the machine did not say how many processors it has"
	kb=$(inside awk '/^MemTotal:/ {print $2}' /proc/meminfo) || fail "the machine did not say how much memory it has"
	if [[ $cpus == "$1" && $kb =~ ^[1-9][0-9]*$ ]] && (( kb <= asked && kb * 100 >= asked * 85 )); then
		echo "CHECK ok   the part's machine is the one it asked for: $1 processors, $2 (it has $cpus, $(( kb / 1024 )) MiB)"
	else
		echo "CHECK FAIL the part's machine is the one it asked for: $1 processors, $2 (it has [$cpus] processors, [$kb] kB)"
		fail "the part's machine is not the one it asked for"
	fi
	settle
}
restart() {
	local started
	started=$(date +%s)
	lx restart "$MACHINE" || fail "the machine could not be restarted"
	usable || fail "the machine did not become usable after a restart"
	echo "M restart usable_s=$(( $(date +%s) - started ))"
	settle
}
gone() { # deleted, and seen to be gone: the next part makes its own
	local held
	lx delete --force "$MACHINE" >/dev/null || fail "the machine $MACHINE could not be deleted"
	held=$(names) || exit 1
	[[ -z $held ]] || fail "the build space still holds [$(tr '\n' ' ' <<<"$held")] after the part's machine was deleted"
}
guest() { # seconds, then the leg's words
	local seconds=$1 status=0
	shift
	timeout "$seconds" lxc --project "$PROJECT" exec "$MACHINE" -- bash /srv/memory-proof/guest.sh "$@" </dev/null || status=$?
	echo "M leg [$*] rc=$status"
	# A leg that did not run to its end is a failed check, whatever it printed before.
	[[ $status == 0 ]] || echo "CHECK FAIL the leg [$*] ran to its end (rc $status)"
}
seconds() { awk -v a="$1" -v b="$EPOCHREALTIME" 'BEGIN{printf "%.2f", b-a}'; }
# Asked from this host, through LXD's agent as the executor asks, by two loops beside a leg, each a shell of its own:
#   probe    one `desktop click` a second on a spot of the panel where a click does nothing, each timed, and nothing
#            else. Only the click and the pause are in this loop, so a machine that stops answering always meets a
#            click: the one in flight, or the next one a pause later. (Review round 4 of #1692: the memory numbers
#            were read in this loop, after each click, for up to 20 s; a stall that fell into that reading was
#            neither a slow click nor a look that was not answered.)
#   beside   what a person wants beside the clicks: the machine's memory numbers every round and, every tenth round,
#            a look of the guest helper. A look's exit code is its answer (`guest.sh look`): 0 only when the helper
#            itself ended well and answered an observation. A reading that does not come is a line without numbers
#            and holds up no click.
# Both write one short line at a time to the end of one file. Each ends only when it is told to (the stop file) and
# says so in a last line of its own (`P-END clicks`, `P-END beside`): a loop that ended any other way, at any moment,
# saw only a part of the leg, and `probed` fails the proof on it.
PROBE_PAUSE=${MEMORY_PROOF_PROBE_PAUSE:-1} # a second between two clicks; the script's own test asks faster
probe() {
	local round=0 started status
	while [[ -d $work && ! -e $work/stop ]]; do
		started=$EPOCHREALTIME
		status=0
		timeout 30 lxc --project "$PROJECT" exec "$MACHINE" -- desktop click 800 12 </dev/null >/dev/null 2>&1 || status=$?
		echo "P $(date -u +%T) click_s=$(seconds "$started") rc=$status at=$started"
		round=$(( round + 1 ))
		sleep "$PROBE_PAUSE"
	done
	[[ -e $work/stop ]] || return 1
	echo "P-END clicks $(date -u +%T) rounds=$round"
}
beside() {
	local round=0 started status
	while [[ -d $work && ! -e $work/stop ]]; do
		echo "C $(date -u +%T) $(timeout 20 lxc --project "$PROJECT" exec "$MACHINE" -- \
			awk '/^(MemAvailable|AnonPages|SwapFree):/ {printf "%s%d ", $1, $2 / 1024}' /proc/meminfo </dev/null 2>/dev/null || true)"
		round=$(( round + 1 ))
		if (( round % 10 == 0 )); then
			started=$EPOCHREALTIME
			status=0
			timeout 40 lxc --project "$PROJECT" exec "$MACHINE" -- bash /srv/memory-proof/guest.sh look </dev/null >/dev/null 2>&1 || status=$?
			echo "P $(date -u +%T) look_s=$(seconds "$started") rc=$status"
		fi
		sleep "$PROBE_PAUSE"
	done
	[[ -e $work/stop ]] || return 1
	echo "P-END beside $(date -u +%T) rounds=$round"
}

# Starts the two loops, runs one leg under them, and judges the clicks. The machine keeps answering: no click failed, none
# took 3 s or more, and at most 1 in 100 took 2 s or more (one, when there are fewer than 200).
#
# The lead set this bar on the measured runs (12 Nov 2026). The aim is that the machine keeps answering, where it froze
# before (no answer in 20 to 30 s, the executor's call lost). The first bar, every click under 2 s, flapped on one
# click of 2.02 s, and a check that flaps is worth nothing. The four runs of the past-the-edge leg on one candidate
# image (2 processors, 4 GiB), as clicks, failed, 1 s or more, 2 s or more, the slowest:
#   104, 0, 1, 1, 2.02 s        101, 0, 1, 0, 1.28 s        100, 0, 0, 0, 0.64 s        99, 0, 1, 0, 1.63 s
# The slowest click fell at the same step in three of them: not at a tab's end, but half a minute later, when the leg
# starts a new program and a heavy page at once and about 360 MiB go into the compressed reserve within 3 s.
probed() { # what, the least number of clicks, seconds, then the leg's words
	local what=$1 least=$2 clicks failed one two three allowed looks unanswered hole
	local probe_pid beside_pid probe_status=0 beside_status=0
	shift 2
	rm -f "$work/stop"
	: >"$work/probe"
	probe >>"$work/probe" &
	probe_pid=$!
	beside >>"$work/probe" &
	beside_pid=$!
	guest "$@"
	touch "$work/stop"
	# Each loop's own end is asked, by its pid: a bare `wait` answers 0 whatever became of them (review round 3 of
	# #1692: a probe ended half way through the leg left enough good clicks behind for the checks below to pass).
	wait "$probe_pid" || probe_status=$?
	wait "$beside_pid" || beside_status=$?
	if (( probe_status == 0 && beside_status == 0 )) && grep -q '^P-END clicks ' "$work/probe" && grep -q '^P-END beside ' "$work/probe"; then
		echo "CHECK ok   $what the clicks' loop and the loop beside it ran from the leg's start to its end ($(grep '^P-END ' "$work/probe" | cut -d' ' -f2,4 | tr '\n' ' ' | sed 's/ $//'))"
	else
		echo "CHECK FAIL $what the clicks' loop and the loop beside it ran from the leg's start to its end (the clicks' loop ended with $probe_status, the one beside it with $beside_status; the last lines they left: [$(grep '^P-END ' "$work/probe" | tr '\n' '|')])"
	fi
	# What the loops saw around every click that failed or took a second or more, and every look that was not answered:
	# the lines before and after it (the clicks' and the other loop's lines lie mixed, in the order they were written).
	awk '{ line[NR] = $0 }
		/ click_s=/ { split($3, a, "="); if (a[2] >= 1 || $4 != "rc=0") for (i = NR - 6; i <= NR + 3; i++) near[i] = 1 }
		/ look_s=/ { if ($4 != "rc=0") for (i = NR - 6; i <= NR + 3; i++) near[i] = 1 }
		END { for (i = 1; i <= NR; i++) if (near[i]) print "near a slow or failed click, or a look not answered: " line[i] }' "$work/probe"
	clicks=$(grep -c ' click_s=' "$work/probe" || true)
	failed=$(grep ' click_s=' "$work/probe" | grep -vc ' rc=0 ' || true)
	one=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] >= 1) n++} END {print n + 0}' "$work/probe")
	two=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] >= 2) n++} END {print n + 0}' "$work/probe")
	three=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] >= 3) n++} END {print n + 0}' "$work/probe")
	allowed=$(( clicks / 100 ))
	(( allowed >= 1 )) || allowed=1
	# The longest time with no click in flight: from the end of one click to the start of the next.
	hole=$(awk '/ click_s=/ { split($3, s, "="); split($5, a, "="); if (seen && a[2] - ended > worst) worst = a[2] - ended; ended = a[2] + s[2]; seen = 1 }
		END { printf "%.2f", worst + 0 }' "$work/probe")
	echo "M $what clicks=$clicks failed=$failed at_or_over_1s=$one at_or_over_2s=$two at_or_over_3s=$three longest_without_a_click_s=$hole slowest_s=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] > m) m = a[2]} END {print m + 0}' "$work/probe") slowest_look_s=$(awk '/ look_s=/ {split($3, a, "="); if (a[2] > m) m = a[2]} END {print m + 0}' "$work/probe") least_available_MB=$(sed -n 's/.*MemAvailable:\([0-9]*\).*/\1/p' "$work/probe" | sort -n | head -1)"
	if (( clicks >= least && failed == 0 && three == 0 && two <= allowed )); then
		echo "CHECK ok   $what the machine kept answering desktop clicks ($clicks clicks, one a second: none failed, none took 3 s or more, $two took 2 s or more)"
	else
		echo "CHECK FAIL $what the machine kept answering desktop clicks ($clicks clicks, at least $least wanted: $failed failed, $three took 3 s or more, $two took 2 s or more where $allowed may)"
	fi
	# No hole between two clicks: between the end of one and the start of the next there is the pause and nothing else.
	# With the loops' own ends above, every moment of the leg lies inside a timed click or inside a pause no longer
	# than this, so nothing the machine did went unasked (a clicks' loop that stood still is a hole too).
	if awk -v hole="$hole" -v pause="$PROBE_PAUSE" 'BEGIN { exit !(hole < pause + 1) }'; then
		echo "CHECK ok   $what there was no hole between two clicks (the longest time with no click in flight: $hole s; the pause is $PROBE_PAUSE s, and a second more is allowed)"
	else
		echo "CHECK FAIL $what there was no hole between two clicks (the longest time with no click in flight: $hole s; the pause is $PROBE_PAUSE s, and a second more is allowed)"
	fi
	# Every look was answered, and there was one: no looks at all is not "every look answered".
	looks=$(grep -c ' look_s=' "$work/probe" || true)
	unanswered=$(grep ' look_s=' "$work/probe" | grep -vc ' rc=0$' || true)
	if (( looks >= 1 && unanswered == 0 )); then
		echo "CHECK ok   $what the guest helper answered every look with an observation ($looks looks)"
	else
		echo "CHECK FAIL $what the guest helper answered every look with an observation ($looks looks, at least one wanted: $unanswered not answered)"
	fi
}

echo "PROOF-START $(date -u +%FT%TZ) image $IMAGE parts ${PARTS[*]} host load $(cut -d' ' -f1-3 /proc/loadavg)"
parts() {
	local part
	for part in "${PARTS[@]}"; do
		echo "PART $part $(date -u +%T)"
		case $part in
		checks)
			machine 2 4GiB
			guest 120 boot
			guest 120 quiet
			guest 300 pointer
			# A boot without the zram module.
			guest 30 hide
			restart
			guest 180 hidden
			guest 60 unhide
			# Past the edge, on a fresh boot.
			restart
			guest 180 browser
			probed "past the edge" 60 1500 load 1500 past 72
			guest 180 after
			# An agent's own job that outgrows the machine, on a fresh boot with the desktop and its browser up.
			restart
			guest 180 browser
			probed "while a job outgrew the machine" 10 600 job
			gone
			;;
		numbers)
			machine 2 4GiB
			guest 300 mix nothing-else-running
			guest 300 mix all-processors-busy busy
			guest 1500 load 1500 stop 24
			guest 180 after stop
			gone
			;;
		small)
			machine 2 2GiB
			guest 1500 load 600 stop 24
			guest 180 after stop
			gone
			;;
		edge)
			machine 2 4GiB
			guest 180 browser
			probed "past the edge" 60 1500 load 1500 past 72
			guest 180 after
			gone
			;;
		small-past)
			machine 2 2GiB
			guest 180 browser
			probed "past the edge of the small machine" 60 1500 load 600 past 72
			guest 180 after
			gone
			;;
		esac
		echo "PART-END $part $(date -u +%T)"
	done
}
# The parts run in a shell of their own that ends at the first step that fails outright (a machine that could not be
# made, started, restarted or deleted, one that never became usable, a file that could not be put in place): its
# status is kept and judged with the checks below.
#
# errexit must really be on in that shell. Bash switches it off inside everything on the left of `||` and inside an
# `if`'s question, in the functions called there too, so the parts are NOT run as `{ … } | tee … || status=$?`
# (review round 2 of #1692: in that shape a failed step was stepped over and the part went on). Here errexit is put
# aside in this shell for the one line, set anew in the parts' shell, and the parts' own status is read from the
# pipeline.
set +e
(
	set -e
	parts
) 2>&1 | tee "$work/out"
parts_status=${PIPESTATUS[0]}
set -e
ended=$(grep -c '^PART-END ' "$work/out" || true)
failed=$(grep -c '^CHECK FAIL' "$work/out" || true)
passed=$(grep -c '^CHECK ok' "$work/out" || true)
echo "checks: $passed ok, $failed failed; parts ended: $ended of ${#PARTS[@]}; the parts' own status: $parts_status; host load $(cut -d' ' -f1-3 /proc/loadavg)"
if (( parts_status == 0 && failed == 0 && passed >= 1 && ended == ${#PARTS[@]} )); then echo "PROOF PASSED"; else echo "PROOF FAILED"; exit 1; fi
