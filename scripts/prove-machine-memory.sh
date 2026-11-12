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
#             (the bar is at `probed` below), something was ended and named in the journal, and the desktop, the
#             helper and the machine's own services are alive after. Then an agent's job that outgrows the machine (twice its memory): it is the
#             one ended, the clicks still answer, and its command ends in a way an agent can read.
#   numbers   2 processors / 4 GiB, for a person: the mixed desktop leg with nothing else running and with every
#             processor busy, then heavy apps, the 1.5 GB job and 24 tabs, stopping before the edge.
#   small     2 processors / 2 GiB with the desktop's size check lowered FOR THE TEST ONLY: heavy apps, a 600 MB job
#             and tabs, stopping before the edge.
#   small-past  only when named: that small machine past the edge, with the clicks asked and judged as in checks.
#   edge      only when named: the checks part's past-the-edge leg alone, on a fresh 2 processors / 4 GiB machine (name
#             it several times to run it several times).
#
# It ends with PROOF PASSED and exit 0 only if no check failed and every part it was asked for ran to its end.
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
for file in guest.sh pages.cjs job.cjs app.html video.html pointer.html; do [[ -f $here/$file ]] || fail "missing $here/$file"; done
lx() { lxc --project "$PROJECT" "$@" </dev/null; }
# Inside the machine, never for longer than two minutes: a machine that stopped answering must not hold the proof.
inside() { timeout 120 lxc --project "$PROJECT" exec "$MACHINE" -- "$@" </dev/null; }
lx image info "$IMAGE" >/dev/null 2>&1 || fail "the project $PROJECT does not see the image $IMAGE"
[[ -z $(lx list -f csv -c n) ]] || fail "the build space $PROJECT is in use: prove when it is empty"

MACHINE="qorpera-machine-build-memory-proof-$$"
work=$(mktemp -d /tmp/qorpera-machine-memory-proof.XXXXXXXX)
cleanup() {
	local status=$?
	trap - EXIT
	set +e
	touch "$work/stop"
	wait 2>/dev/null
	for _ in 1 2 3; do
		lx delete --force "$MACHINE" >/dev/null 2>&1
		[[ -z $(lx list -f csv -c n | grep -x "$MACHINE") ]] && break
		sleep 3
	done
	[[ -z $(lx list -f csv -c n | grep -x "$MACHINE") ]] || { echo "the machine $MACHINE is still there: delete it by hand" >&2; status=1; }
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
	inside timeout 60 systemctl is-system-running --wait >/dev/null 2>&1 || true
	inside systemctl stop qorpera-machine-watchdog.timer qorpera-machine-watchdog.service
	inside mkdir -p /srv/memory-proof
	local file
	for file in guest.sh pages.cjs job.cjs app.html video.html pointer.html; do
		lx file push "$here/$file" "$MACHINE/srv/memory-proof/$file" --uid 0 --gid 0 --mode 0755
	done
}
machine() { # cpus memory
	local started
	started=$(date +%s)
	lx init "$IMAGE" "$MACHINE" --vm --no-profiles --storage "$POOL" -d root,size=10GiB -n "$NETWORK" \
		-d eth0,security.mac_filtering=true -d eth0,security.ipv4_filtering=true -d eth0,security.ipv6_filtering=true \
		-d eth0,security.port_isolation=true -c limits.cpu="$1" -c limits.memory="$2" -c boot.mode=uefi-secureboot \
		-c boot.autostart=false -c user.qorpera.image_builder=true -c user.qorpera.purpose=machine-image
	lx start "$MACHINE"
	usable || fail "the machine did not become usable"
	echo "M machine cpus=$1 memory=$2 usable_s=$(( $(date +%s) - started ))"
	settle
}
restart() {
	local started
	started=$(date +%s)
	lx restart "$MACHINE"
	usable || fail "the machine did not become usable after a restart"
	echo "M restart usable_s=$(( $(date +%s) - started ))"
	settle
}
gone() { lx delete --force "$MACHINE" >/dev/null; }
guest() { # seconds, then the leg's words
	local seconds=$1 status=0
	shift
	timeout "$seconds" lxc --project "$PROJECT" exec "$MACHINE" -- bash /srv/memory-proof/guest.sh "$@" </dev/null || status=$?
	echo "M leg [$*] rc=$status"
	# A leg that did not run to its end is a failed check, whatever it printed before.
	[[ $status == 0 ]] || echo "CHECK FAIL the leg [$*] ran to its end (rc $status)"
}
seconds() { awk -v a="$1" -v b="$EPOCHREALTIME" 'BEGIN{printf "%.2f", b-a}'; }
# Asked from this host, through LXD's agent as the executor asks: one `desktop click` a second on a spot of the panel
# where a click does nothing, each timed; every tenth round also a look of the guest helper.
probe() {
	local round=0 started status
	while [[ -d $work && ! -e $work/stop ]]; do
		started=$EPOCHREALTIME
		status=0
		timeout 30 lxc --project "$PROJECT" exec "$MACHINE" -- desktop click 800 12 </dev/null >/dev/null 2>&1 || status=$?
		echo "P $(date -u +%T) click_s=$(seconds "$started") rc=$status $(timeout 20 lxc --project "$PROJECT" exec "$MACHINE" -- \
			awk '/^(MemAvailable|AnonPages|SwapFree):/ {printf "%s%d ", $1, $2 / 1024}' /proc/meminfo </dev/null 2>/dev/null || true)"
		round=$(( round + 1 ))
		if (( round % 10 == 0 )); then
			started=$EPOCHREALTIME
			status=0
			timeout 40 lxc --project "$PROJECT" exec "$MACHINE" -- bash /srv/memory-proof/guest.sh look </dev/null >/dev/null 2>&1 || status=$?
			echo "P $(date -u +%T) look_s=$(seconds "$started") rc=$status"
		fi
		sleep 1
	done
}

# Starts the probe, runs one leg under it, and judges the clicks. The machine keeps answering: no click failed, none
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
	local what=$1 least=$2 clicks failed one two three allowed
	shift 2
	rm -f "$work/stop"
	probe >"$work/probe" &
	guest "$@"
	touch "$work/stop"
	wait
	# What the probe saw around every click that failed or took a second or more: the three rounds before and the one after.
	awk '{ line[NR] = $0 }
		/ click_s=/ { split($3, a, "="); if (a[2] >= 1 || $4 != "rc=0") for (i = NR - 3; i <= NR + 1; i++) near[i] = 1 }
		END { for (i = 1; i <= NR; i++) if (near[i]) print "near a slow or failed click: " line[i] }' "$work/probe"
	clicks=$(grep -c ' click_s=' "$work/probe" || true)
	failed=$(grep ' click_s=' "$work/probe" | grep -vc ' rc=0 ' || true)
	one=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] >= 1) n++} END {print n + 0}' "$work/probe")
	two=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] >= 2) n++} END {print n + 0}' "$work/probe")
	three=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] >= 3) n++} END {print n + 0}' "$work/probe")
	allowed=$(( clicks / 100 ))
	(( allowed >= 1 )) || allowed=1
	echo "M $what clicks=$clicks failed=$failed at_or_over_1s=$one at_or_over_2s=$two at_or_over_3s=$three slowest_s=$(awk '/ click_s=/ {split($3, a, "="); if (a[2] > m) m = a[2]} END {print m + 0}' "$work/probe") slowest_look_s=$(awk '/ look_s=/ {split($3, a, "="); if (a[2] > m) m = a[2]} END {print m + 0}' "$work/probe") least_available_MB=$(sed -n 's/.*MemAvailable:\([0-9]*\).*/\1/p' "$work/probe" | sort -n | head -1)"
	if (( clicks >= least && failed == 0 && three == 0 && two <= allowed )); then
		echo "CHECK ok   $what the machine kept answering desktop clicks ($clicks clicks, one a second: none failed, none took 3 s or more, $two took 2 s or more)"
	else
		echo "CHECK FAIL $what the machine kept answering desktop clicks ($clicks clicks, at least $least wanted: $failed failed, $three took 3 s or more, $two took 2 s or more where $allowed may)"
	fi
	if grep ' look_s=' "$work/probe" | grep -qv ' rc=0$'; then
		echo "CHECK FAIL $what the guest helper answered every look"
	else
		echo "CHECK ok   $what the guest helper answered every look ($(grep -c ' look_s=' "$work/probe" || true) looks)"
	fi
}

echo "PROOF-START $(date -u +%FT%TZ) image $IMAGE parts ${PARTS[*]} host load $(cut -d' ' -f1-3 /proc/loadavg)"
{
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
			gone
			;;
		small)
			machine 2 2GiB
			guest 1500 load 600 stop 24
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
} 2>&1 | tee "$work/out"
ended=$(grep -c '^PART-END ' "$work/out" || true)
failed=$(grep -c '^CHECK FAIL' "$work/out" || true)
passed=$(grep -c '^CHECK ok' "$work/out" || true)
echo "checks: $passed ok, $failed failed; parts ended: $ended of ${#PARTS[@]}; host load $(cut -d' ' -f1-3 /proc/loadavg)"
if (( failed == 0 && ended == ${#PARTS[@]} )); then echo "PROOF PASSED"; else echo "PROOF FAILED"; exit 1; fi
