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
#   calls, legs     what was asked: every call, and every leg of guest.sh with the size of the machine it ran on
#   clicks, readings  one line a `desktop click` asked, one a reading of the memory numbers
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
	"bash /srv/memory-proof/guest.sh look") stalled ;;
	"bash /srv/memory-proof/guest.sh "*)
		leg=${asked#bash /srv/memory-proof/guest.sh }
		echo "${gib}GiB $leg" >>"$STUB/legs"
		if [[ ($leg == load\ * || $leg == job*) && -s $STUB/leg-clicks ]]; then
			# The leg takes its time: until the probe beside it asked so many clicks more, or was ended.
			wanted=$(( $(wc -l <"$STUB/clicks") + $(cat "$STUB/leg-clicks") ))
			for _ in $(seq 1 1200); do
				[[ -e $STUB/probe-ended || $(wc -l <"$STUB/clicks") -ge $wanted ]] && break
				sleep 0.05
			done
			sleep 0.2
		fi
		echo "CHECK ok   a stand-in leg [$leg] on a machine of $gib GiB"
		;;
	"desktop click "*)
		echo click >>"$STUB/clicks"
		stalled
		# Who asked: `timeout` is this script's parent, and the clicks' loop (a shell of the proof's) is timeout's.
		read -r _ _ _ probe _ <"/proc/$PPID/stat"
		if [[ -s $STUB/kill-probe-at && $(wc -l <"$STUB/clicks") -eq $(cat "$STUB/kill-probe-at") ]]; then
			kill -KILL "$probe"
			: >"$STUB/probe-ended"
		fi
		if [[ -s $STUB/pause-probe-at ]]; then
			read -r at long <"$STUB/pause-probe-at"
			if [[ $(wc -l <"$STUB/clicks") -eq $at ]]; then
				# A helper of its own stops the loop while it pauses between two clicks: its `sleep` is there and no
				# click (`timeout`) is. A loop stopped inside a click would count the time to that click instead, so
				# a stop that came too late is taken back and tried again at the next pause.
				setsid bash -c '
					probe=$1 long=$2
					while kill -0 "$probe" 2>/dev/null; do
						if pgrep -P "$probe" -x sleep >/dev/null; then
							kill -STOP "$probe"
							pgrep -P "$probe" -x sleep >/dev/null && ! pgrep -P "$probe" -x timeout >/dev/null && break
							kill -CONT "$probe"
						fi
						sleep 0.02
					done
					sleep "$long"
					kill -CONT "$probe"
				' pause "$probe" "$long" </dev/null >/dev/null 2>&1 &
			fi
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
