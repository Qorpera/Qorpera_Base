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
#   calls, legs     what was asked: every call, and every leg of guest.sh with the size of the machine it ran on
set -u
[[ ${1-} == --project ]] && shift 2
verb=${1-}
shift
if [[ $verb == image || $verb == file ]]; then
	verb=$verb-${1-}
	shift
fi
mkdir -p "$STUB/machines"
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
	awk*) echo "MemAvailable:1000 AnonPages:10 SwapFree:1000 " ;;
	"bash /srv/memory-proof/guest.sh look") ;;
	"bash /srv/memory-proof/guest.sh "*)
		leg=${asked#bash /srv/memory-proof/guest.sh }
		echo "${gib}GiB $leg" >>"$STUB/legs"
		echo "CHECK ok   a stand-in leg [$leg] on a machine of $gib GiB"
		;;
	*) ;; # systemctl stop, is-system-running, mkdir, desktop click
	esac
	;;
*)
	echo "stand-in lxc: no such verb: $verb" >&2
	exit 2
	;;
esac
exit 0
