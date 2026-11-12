#!/bin/bash
# A stand-in for `lxc`, for scripts/prove-machine-memory.test.mjs only: the proof's host half
# (scripts/prove-machine-memory.sh) run with no LXD and no machine. It is not a piece of the proof and never goes
# into a machine.
#
# Its state is the folder $STUB:
#   machines/NAME   one file a machine that exists: "<processors> <memory in GiB>"
#   fails           lines "<verb> <n>": the n-th call of that verb fails and changes nothing (verbs: list, init, start,
#                   restart, delete, exec, image-info, file-push)
#   says-kb         when there, what every machine answers as its MemTotal, whatever it was made with
#   leg-clicks      when there, a `load` or `job` leg lasts until the probe asked that many `desktop click`s more (or
#                   until the probe was ended, see below); without it a leg ends at once
#   kill-probe-at   when there, the n-th `desktop click` ends the probe that asked it (SIGKILL), half way through a leg
#   stall-at-reading  when there, "<n> <seconds>": at the n-th reading of the memory numbers the machine stalls for
#                   so long: every click, reading and look in flight, or asked before the stall is over, waits for
#                   its end
#   pause-probe-at  when there, "<n> <seconds>": after the n-th `desktop click` the clicks' loop is stopped (SIGSTOP)
#                   while it pauses between two clicks, and let go on (SIGCONT) so many seconds later: no click is
#                   slow, and none is asked meanwhile
#   pause-beside-at  when there, "<n> <seconds>": the same for the loop beside the clicks, after its n-th look
#   leg-ends-while-stopped  when there, "<seconds>": a `load` or `job` leg ends so long after a loop was stopped, so
#                   the loop stands still over the leg's end
#   calls, legs     what was asked: every call, and every leg of guest.sh with the size of the machine it ran on
#   clicks, readings, looks  one line a `desktop click` asked, one a reading of the memory numbers, one a look
set -u
[[ ${1-} == --project ]] && shift 2
verb=${1-}
shift
if [[ $verb == image || $verb == file ]]; then
	verb=$verb-${1-}
	shift
fi
mkdir -p "$STUB/machines"
touch "$STUB/clicks"
count=$(( $(cat "$STUB/count.$verb" 2>/dev/null || echo 0) + 1 ))
echo "$count" >"$STUB/count.$verb"
echo "$verb $*" >>"$STUB/calls"
if grep -qx -- "$verb $count" "$STUB/fails" 2>/dev/null; then
	echo "stand-in lxc: $verb fails (its call $count)" >&2
	exit 1
fi
missing() {
	echo "stand-in lxc: there is no machine $1" >&2
	exit 1
}
# Stops a loop of the proof's (a shell: the parent of the `timeout` that runs this script) while it pauses between two
# of its calls, and lets it go on later, from a helper of its own. Between two calls the loop's only child is its
# `sleep`. A loop stopped inside a call would count the time to that call instead, so a stop that came at another
# moment is taken back and tried again at the next pause.
stop_between_calls() { # the loop's pid, seconds
	setsid bash -c '
		loop=$1 long=$2 stopped=$3
		while kill -0 "$loop" 2>/dev/null; do
			if pgrep -P "$loop" -x sleep >/dev/null; then
				kill -STOP "$loop"
				[[ $(pgrep -P "$loop" | wc -l) == 1 ]] && pgrep -P "$loop" -x sleep >/dev/null && break
				kill -CONT "$loop"
			fi
			sleep 0.02
		done
		: >"$stopped"
		sleep "$long"
		kill -CONT "$loop"
	' stop "$1" "$2" "$STUB/loop-stopped" </dev/null >/dev/null 2>&1 &
}
# Who asked: `timeout` is this script's parent, and the loop that asked (a shell of the proof's) is timeout's.
asker() {
	local parent
	read -r _ _ _ parent _ <"/proc/$PPID/stat"
	echo "$parent"
}
# The machine stalls: whoever asks it before the stall is over waits for its end.
stalled() {
	local over now
	[[ -s $STUB/stall-until ]] || return 0
	over=$(cat "$STUB/stall-until")
	now=$(date +%s.%N)
	awk -v over="$over" -v now="$now" 'BEGIN { exit !(now < over) }' || return 0
	sleep "$(awk -v over="$over" -v now="$now" 'BEGIN { printf "%.3f", over - now }')"
}
case $verb in
image-info | file-push) ;;
list) ls "$STUB/machines" ;;
init) # IMAGE NAME … -c limits.cpu=N -c limits.memory=MGiB …
	name=$2
	[[ ! -e $STUB/machines/$name ]] || { echo "stand-in lxc: the machine $name exists" >&2; exit 1; }
	cpu='' memory=''
	for word in "$@"; do
		[[ $word == limits.cpu=* ]] && cpu=${word#limits.cpu=}
		[[ $word == limits.memory=* ]] && memory=${word#limits.memory=}
	done
	echo "$cpu ${memory%GiB}" >"$STUB/machines/$name"
	;;
start | restart) [[ -e $STUB/machines/$1 ]] || missing "$1" ;;
delete) # --force NAME
	[[ -e $STUB/machines/$2 ]] || missing "$2"
	rm -f -- "$STUB/machines/$2"
	;;
exec) # NAME -- the command
	name=$1
	[[ -e $STUB/machines/$name ]] || missing "$name"
	read -r cpu gib <"$STUB/machines/$name"
	shift 2
	asked="$*"
	case $asked in
	"systemctl is-active basic.target network-online.target") printf 'active\nactive\n' ;;
	nproc) echo "$cpu" ;;
	awk*MemTotal*) cat "$STUB/says-kb" 2>/dev/null || echo $(( gib * 1048576 * 93 / 100 )) ;;
	awk*)
		echo reading >>"$STUB/readings"
		if [[ -s $STUB/stall-at-reading ]]; then
			read -r at long <"$STUB/stall-at-reading"
			if [[ $(wc -l <"$STUB/readings") -eq $at ]]; then
				awk -v long="$long" -v now="$(date +%s.%N)" 'BEGIN { printf "%.3f\n", now + long }' >"$STUB/stall-until.$$" &&
					mv -f "$STUB/stall-until.$$" "$STUB/stall-until"
			fi
		fi
		stalled
		echo "MemAvailable:1000 AnonPages:10 SwapFree:1000 "
		;;
	"bash /srv/memory-proof/guest.sh look")
		echo look >>"$STUB/looks"
		stalled
		if [[ -s $STUB/pause-beside-at ]]; then
			read -r at long <"$STUB/pause-beside-at"
			[[ $(wc -l <"$STUB/looks") -eq $at ]] && stop_between_calls "$(asker)" "$long"
		fi
		;;
	"bash /srv/memory-proof/guest.sh "*)
		leg=${asked#bash /srv/memory-proof/guest.sh }
		echo "${gib}GiB $leg" >>"$STUB/legs"
		if [[ ($leg == load\ * || $leg == job*) && -s $STUB/leg-clicks ]]; then
			# The leg takes its time: until the probe beside it asked so many clicks more, or was ended.
			wanted=$(( $(wc -l <"$STUB/clicks") + $(cat "$STUB/leg-clicks") ))
			for _ in $(seq 1 1200); do
				[[ -e $STUB/probe-ended || $(wc -l <"$STUB/clicks") -ge $wanted ]] && break
				if [[ -s $STUB/leg-ends-while-stopped && -e $STUB/loop-stopped ]]; then
					sleep "$(cat "$STUB/leg-ends-while-stopped")"
					break
				fi
				sleep 0.05
			done
			sleep 0.2
		fi
		echo "CHECK ok   a stand-in leg [$leg] on a machine of $gib GiB"
		;;
	"desktop click "*)
		echo click >>"$STUB/clicks"
		stalled
		if [[ -s $STUB/kill-probe-at && $(wc -l <"$STUB/clicks") -eq $(cat "$STUB/kill-probe-at") ]]; then
			kill -KILL "$(asker)"
			: >"$STUB/probe-ended"
		fi
		if [[ -s $STUB/pause-probe-at ]]; then
			read -r at long <"$STUB/pause-probe-at"
			[[ $(wc -l <"$STUB/clicks") -eq $at ]] && stop_between_calls "$(asker)" "$long"
		fi
		;;
	*) ;; # systemctl stop, is-system-running, mkdir
	esac
	;;
*)
	echo "stand-in lxc: no such verb: $verb" >&2
	exit 2
	;;
esac
exit 0
