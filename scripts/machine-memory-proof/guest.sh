#!/bin/bash
# The in-machine half of scripts/prove-machine-memory.sh. It runs as root inside a throwaway machine, through LXD's
# agent as the executor's own calls do, and prints `CHECK ok ...` / `CHECK FAIL ...` lines (what the proof passes or
# fails on) and `M ...` lines (measures for a person).
#
#   guest.sh browser                      the desktop and its Chromium, started for the legs below, and the guest
#                                         prepared as the executor prepares one
#   guest.sh boot                         compressed memory after a boot, its unit run again, the guard, who is protected
#   guest.sh quiet                        the idle rule's own measure on the quiet machine, over 30 s
#   guest.sh pointer                      the desktop's start time; clicks, a double, a move and drags on one spot
#   guest.sh hide | hidden | unhide       the module hidden for the next boot; that boot checked; the module back
#   guest.sh mix LABEL [busy]             the size tests' mixed desktop leg, with every processor busy or not
#   guest.sh load JOB_MB stop|past TABS   heavy web apps, a job of JOB_MB as a real machine command, then tabs
#   guest.sh job [MB] [RANDOM%]           an agent's job that outgrows the machine: it is ended, and how its command ends
#   guest.sh after [stop]                 after a load: what was ended, what the agent's command says, who is alive.
#                                         Past the edge something must have been ended; with `stop` (the load stopped
#                                         before the edge) nothing has to be, and all the rest is asked the same
#   guest.sh look                         one look of the guest helper, as the executor takes one each pass
#   guest.sh phase SECONDS WORDS...       one phase of the browser's work alone (pages.cjs WORDS), judged as in a leg
#   guest.sh kinds                        command lines on its input, one a line: what each is to the guard's choice
#
# A leg that ran to its end exits 0 whatever its checks said: its CHECK FAIL lines fail the proof. Nothing here passes
# on an answer that never came: a helper that failed, an empty answer, a journal that could not be read and a browser
# phase that did not end well are each a failed check. `look` alone answers by its exit code, since the host throws
# its output away: 0 only when the helper itself ended well and what it answered is an observation.
set -u
export LC_ALL=C.UTF-8 DISPLAY=:1 NODE_PATH=/opt/node/lib/node_modules HOME=/root
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The tests' own (scripts/prove-machine-memory.test.mjs, which runs `look` and `phase` against stand-ins): where the
# proof's notes, the helper and its replies are, the node that runs them, how long the helper may take, and the
# browser's program.
STATE=${MEMORY_PROOF_STATE:-/run/memory-proof}
GUEST=${MEMORY_PROOF_GUEST:-/opt/qorpera-machine/cloud-machine-guest.mjs}
REPLIES=${MEMORY_PROOF_REPLIES:-/run/qorpera-machine/replies}
NODE=${MEMORY_PROOF_NODE:-/usr/bin/node}
HELPER_SECONDS=${MEMORY_PROOF_HELPER_SECONDS:-30}
PAGES=${MEMORY_PROOF_PAGES:-$HERE/pages.cjs}
MEMORY=/opt/qorpera-machine/machine-memory
SWAP_UNIT=qorpera-machine-memory.service
GUARD_UNIT=qorpera-machine-memory-guard.service
HIDE=/etc/modprobe.d/qorpera-memory-proof.conf
OBSERVATION=qorpera.machine-observation/v2
# The debugging port of the Chromium this proof starts on the desktop: its main process serves it.
PORT=http://127.0.0.1:9222/json/version
mkdir -p "$STATE" || exit 1

M() { echo "M $*"; }
check() { # what, then a command: ok when it succeeds
	local what=$1
	shift
	if "$@" >/dev/null 2>&1; then echo "CHECK ok   $what"; else echo "CHECK FAIL $what"; fi
}
dt() { awk -v a="$1" -v b="$EPOCHREALTIME" 'BEGIN{printf "%.2f", b-a}'; }
under() { awk -v s="$1" -v limit="$2" 'BEGIN{exit !(s < limit)}'; }
kb() { awk -v key="$1:" '$1 == key {print $2}' /proc/meminfo; }
avail() { echo $(( $(kb MemAvailable) / 1024 )); }
swapused() { echo $(( ($(kb SwapTotal) - $(kb SwapFree)) / 1024 )); }
adj() { cat "/proc/$1/oom_score_adj" 2>/dev/null; }
mainpid() { systemctl show "$1" -p MainPID --value; }
uuid() { cat /proc/sys/kernel/random/uuid; }
# When a process started (clock ticks since the boot): with its pid, it names one process and no later one.
started_at() { cut -d' ' -f22 "/proc/$1/stat" 2>/dev/null; }
# No unit failed, said by systemd itself: a systemctl that cannot answer is not "none".
none_failed() {
	local units
	units=$(systemctl --failed --no-legend) && [[ -z $units ]]
}
# The executor's own way to the guest helper: a nonce, then the reply file. It fails when the helper itself failed or
# was cut off at its time limit, and when it left no answer: an answer is only what a helper that ended well wrote.
helper() {
	local nonce status=0
	nonce=$(uuid) || return 1
	timeout "$HELPER_SECONDS" "$NODE" "$GUEST" "$nonce" "$@" >/dev/null 2>&1 || status=$?
	(( status == 0 )) || return "$status"
	[[ -s $REPLIES/$nonce.json ]] || return 1
	cat "$REPLIES/$nonce.json"
}
# Whether an answer of the helper is of the wanted kind. The word is compared: jq alone ends well on no input at all.
is() { # schema, the answer
	[[ $(jq -er .schema <<<"$2" 2>/dev/null) == "$1" ]]
}
# The guest as the executor prepares it for a boot: its machine (one id for the boot, as a real machine has: the
# helper refuses another) and its lease. Only a prepared guest answers a look with an observation.
prepared() {
	local answer
	[[ -s $STATE/machine ]] || uuid >"$STATE/machine" || return 1
	answer=$(helper prepare "$(cat "$STATE/machine")" 1) && is qorpera.machine-guest/v1 "$answer" || return 1
	answer=$(helper refresh-lease 900000) && is qorpera.machine-guest-lease-receipt/v1 "$answer"
}
# The desktop command; on a machine under a desktop's size, a copy with the size check lowered FOR THIS TEST ONLY.
D=desktop
total_kb=$(kb MemTotal 2>/dev/null)
if [[ $total_kb =~ ^[0-9]+$ && -r /usr/local/bin/desktop ]] && (( total_kb < 3500000 )); then
	# Made once and put in place whole: a leg and a look of the probe run this script at the same time.
	if [[ ! -x $STATE/desktop ]]; then
		sed 's/^MIN_MEMORY_KB=.*/MIN_MEMORY_KB=1500000/' /usr/local/bin/desktop >"$STATE/desktop.$$" && chmod 755 "$STATE/desktop.$$" &&
			mv -f "$STATE/desktop.$$" "$STATE/desktop"
	fi
	D=$STATE/desktop
fi
titles() { wmctrl -l 2>/dev/null | awk '{ $1=$2=$3=""; sub(/^ +/,""); print }'; }
# Starts a command as the executor starts an agent's: through the guest helper, as a unit in the machine's slice.
# Its id is kept in $STATE/job. Prints the start's answer; fails unless the command is running.
command_start() { # the command line
	local command answer
	prepared || return 1
	command=$(uuid) || return 1
	jq -cn --arg machine "$(cat "$STATE/machine")" --arg command "$command" --arg sha "$(printf %064d 0)" --arg run "$1" \
		'{schema: "qorpera.machine-command-request/v1", machineId: $machine, commandId: $command, inputSha256: $sha, command: $run, timeoutMs: null}' \
		>"/var/lib/qorpera-machine/inbox/$command.json" || return 1
	chmod 400 "/var/lib/qorpera-machine/inbox/$command.json"
	echo "$command" >"$STATE/job"
	answer=$(helper start "$command") || return 1
	jq -c '{state, exitCode}' <<<"$answer"
	[[ $(jq -er .state <<<"$answer" 2>/dev/null) == running ]]
}
# Whether the browser's debugging port answers: three tries of 5 s (at the edge it may be slow, never silent).
port_answers() {
	local try
	for try in 1 2 3; do
		curl -s -o /dev/null --max-time 5 "$PORT" && return 0
		sleep 1
	done
	return 1
}
# What a program is to the guard's choice, by its command line: reads command lines, one a line, and prints one word
# for each. A Chromium process says what it is with --type=: a `tab` is --type=renderer, a `helper` any other (the
# graphics and network processes, the zygotes: Chromium starts them again), and the `browser` itself has none. The
# agent's `job` is this proof's job.cjs; anything else is `other`. The lines are as /proc and the guard's journal show
# them: Chromium rewrites its command line into one string with spaces between its words, for its main process too,
# and earlyoom writes a command line the same way, with a quote after it.
kinds() {
	awk '
		{ sub(/"$/, "") }
		$1 ~ /\/chrome$/ && / --type=renderer( |$)/ { print "tab"; next }
		$1 ~ /\/chrome$/ && / --type=/ { print "helper"; next }
		$1 ~ /\/chrome$/ { print "browser"; next }
		/job\.cjs/ { print "job"; next }
		{ print "other" }'
}
# The main process of the Chromium this proof starts: the one Chromium process that is the browser itself and has
# the proof's debugging port. Prints its pid.
browser_main() {
	local pid line
	for pid in $(pgrep -u desktop -x chrome); do
		line=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || continue
		[[ $(kinds <<<"$line") == browser && " $line " == *" --remote-debugging-port=9222 "* ]] || continue
		echo "$pid"
		return 0
	done
	return 1
}
# The desktop, a page server for the proof's own pages, and the desktop's Chromium with its debugging port open,
# started if they do not run. It fails unless all three are there. The browser's main process is noted the first
# time, with when it started: `after` asks whether that same process lived through the edge.
browser() {
	local pid
	timeout 60 "$D" start >/dev/null 2>&1
	if ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:8700/app.html; then
		(cd "$HERE" && exec python3 -m http.server 8700 --bind 127.0.0.1 >/dev/null 2>&1) &
		for _ in $(seq 1 40); do curl -s -o /dev/null --max-time 1 http://127.0.0.1:8700/app.html && break; sleep 0.25; done
	fi
	if ! curl -s -o /dev/null --max-time 1 "$PORT"; then
		timeout 30 "$D" run /usr/lib/qorpera-chromium/chrome --start-maximized --no-first-run --no-default-browser-check \
			--password-store=basic --disable-infobars --enable-unsafe-swiftshader --remote-debugging-port=9222 \
			--user-data-dir=/home/desktop/proof-profile about:blank >/dev/null 2>&1
		for _ in $(seq 1 80); do curl -s -o /dev/null --max-time 1 "$PORT" && break; sleep 0.25; done
		rm -f "$STATE/browser-main"
	fi
	"$D" status 2>/dev/null | grep -q '^running' || return 1
	curl -s -o /dev/null --max-time 2 http://127.0.0.1:8700/app.html || return 1
	port_answers || return 1
	if [[ ! -s $STATE/browser-main ]]; then
		pid=$(browser_main) || return 1
		echo "$pid $(started_at "$pid")" >"$STATE/browser-main"
	fi
}
# What a browser leg stands on: the desktop, the browser with its port, and a prepared guest.
ready() { browser && prepared; }
# One phase of the browser's work (pages.cjs). It must end well: pages.cjs exits 0 only when the phase did what it is
# for, 3 when the browser is gone, and timeout answers 124 for a phase cut off at its limit. A tab the guard ended is
# no failure of a phase: pages.cjs tells it from a browser that is gone.
phase() { # seconds, then pages.cjs's words
	local seconds=$1 status=0
	shift
	(cd "$HERE" && timeout "$seconds" "$NODE" "$PAGES" "$@") || status=$?
	case $status in
	0) echo "CHECK ok   the browser's phase [$*] ended well" ;;
	3) echo "CHECK FAIL the browser's phase [$*] ended well: the browser is gone (tabs may be ended, the browser may not)" ;;
	124) echo "CHECK FAIL the browser's phase [$*] ended well: it was cut off after $seconds s" ;;
	*) echo "CHECK FAIL the browser's phase [$*] ended well: exit $status, its reason is in the line before" ;;
	esac
}
clicks() { # label: four clicks on four spots and a screenshot after each, timed; each must end well
	local i t c bad=0
	for i in 1 2 3 4; do
		t=$EPOCHREALTIME
		timeout 30 "$D" click $(( 500 + i * 60 )) $(( 400 + i * 40 )) >/dev/null 2>&1 || bad=$(( bad + 1 ))
		c=$(dt "$t")
		t=$EPOCHREALTIME
		timeout 30 scrot --pointer --overwrite --silent "$STATE/look.png" || bad=$(( bad + 1 ))
		M "$1 click_s=$c look_s=$(dt "$t") load=$(cut -d' ' -f1 /proc/loadavg)"
	done
	check "four clicks and four screenshots ($1) each ended well" test "$bad" = 0
}

case ${1:-} in
browser)
	check "the desktop runs, its browser's debugging port answers and the guest is prepared" ready
	"$D" status 2>&1 | head -1
	;;
boot)
	total=$(kb MemTotal)
	line=$(grep '^/dev/zram0 ' /proc/swaps || true)
	size=$(awk '{print $3}' <<<"$line")
	M "boot cpus=$(nproc) memTotalKB=$total kernel=$(uname -r) swaps=[$(tr -s ' \t' ' ' <<<"$line")] $($MEMORY status | tr '\n' ' ')"
	check "the swap is compressed memory (zram) of the machine's size: ${size:-none} of $total KiB" \
		test -n "$size" -a "$(( total - ${size:-0} ))" -ge 0 -a "$(( total - ${size:-0} ))" -le 64
	check "its priority is 100" test "$(awk '{print $5}' <<<"$line")" = 100
	check "it compresses with zstd" grep -q '\[zstd\]' /sys/block/zram0/comp_algorithm
	check "vm.swappiness is 150 and vm.page-cluster 0" test "$(cat /proc/sys/vm/swappiness) $(cat /proc/sys/vm/page-cluster)" = "150 0"
	check "the unit is active and said so in the journal" bash -c "systemctl is-active --quiet $SWAP_UNIT && journalctl -b -t qorpera-machine-memory -o cat | grep -q '^compressed memory is on: zstd'"
	check "it was on before basic.target (before anything of an agent runs)" \
		test "$(systemctl show $SWAP_UNIT -p ActiveEnterTimestampMonotonic --value)" -le "$(systemctl show basic.target -p ActiveEnterTimestampMonotonic --value)"
	M "boot unit_ms=$(( ($(systemctl show $SWAP_UNIT -p ActiveEnterTimestampMonotonic --value) - $(systemctl show $SWAP_UNIT -p InactiveExitTimestampMonotonic --value)) / 1000 )) $(systemd-analyze 2>/dev/null | head -1)"
	# Run again, it changes nothing.
	now() { echo "$(awk '$1 == "/dev/zram0" {print $1, $2, $3, $5}' /proc/swaps) $(cat /sys/block/zram0/disksize /sys/block/zram0/comp_algorithm /proc/sys/vm/swappiness /proc/sys/vm/page-cluster | tr '\n' ' ')"; }
	before=$(now)
	systemctl restart $SWAP_UNIT
	check "the unit run again changes nothing ($before)" test "$before" = "$(now)"
	check "and says it was already on" bash -c "journalctl -b -t qorpera-machine-memory -o cat | tail -1 | grep -q '^compressed memory is already on'"
	# The guard, and who is protected from it and from the kernel's own killer.
	# It was started again with the swap unit just now: its script takes a moment to become earlyoom.
	for _ in $(seq 1 50); do
		guard=$(mainpid $GUARD_UNIT)
		[[ $(cat "/proc/$guard/comm" 2>/dev/null) == earlyoom ]] && break
		sleep 0.1
	done
	M "boot guard=[$(tr '\0' ' ' <"/proc/$guard/cmdline" 2>/dev/null)] $(journalctl -b -t qorpera-machine-memory-guard -o cat | grep -A1 'sending SIGTERM' | tr -s ' \n' ' ')"
	check "the guard runs earlyoom" bash -c "systemctl is-active --quiet $GUARD_UNIT && [[ \$(cat /proc/$guard/comm) == earlyoom ]]"
	check "the guard is in the machine's control slice (never counted as the machine being busy)" grep -q '/qorpera-control.slice/' "/proc/$guard/cgroup"
	check "the guard is never ended (oom_score_adj -1000)" test "$(adj "$guard")" = -1000
	check "the LXD agent is protected (-900)" test "$(adj "$(mainpid lxd-agent.service)")" = -900
	check "what the executor runs through the agent inherits it (-900)" test "$(adj $$)" = -900
	check "the folder program, the watchdog and the desktop are protected (-900)" \
		test "$(for unit in qorpera-machine-folder qorpera-machine-watchdog qorpera-machine-desktop; do systemctl show $unit.service -p OOMScoreAdjust --value; done | tr '\n' ' ')" = "-900 -900 -900 "
	check "systemd-oomd does not run, nor the packaged earlyoom unit" \
		bash -c '! systemctl is-active --quiet systemd-oomd.service && [[ $(systemctl is-enabled earlyoom.service 2>/dev/null) == masked ]]'
	check "no unit failed" none_failed
	;;
quiet)
	# The idle rule's measure, as the executor takes it: two looks of the guest helper, 30 s apart. Under 5 % of one
	# processor and 512 KiB, the machine may sleep.
	check "the guest is prepared as the executor prepares one" prepared
	number() { jq -er "$1 | select(type == \"number\") | floor" <<<"$2" 2>/dev/null; }
	first=$(helper observe -) && is "$OBSERVATION" "$first" || first=
	sleep 30
	second=$(helper observe -) && is "$OBSERVATION" "$second" || second=
	if cpu1=$(number .cpuUsec "$first") && cpu2=$(number .cpuUsec "$second") && io1=$(number .ioBytes "$first") && io2=$(number .ioBytes "$second"); then
		cpu=$(( (cpu2 - cpu1) / 1000 )) io=$(( io2 - io1 ))
		M "quiet cpu_ms=$cpu of 30000 (the rule: 1500) io_bytes=$io (the rule: 524288) swapUsedMB=$(swapused)"
		# The bytes are summed over the processes that live: one that had moved bytes and ended between the looks
		# makes the sum fall, which the rule reads as not busy. Then only the processor's half says something here.
		(( io >= 0 )) || M "quiet the bytes fell between the two looks (a process that had moved bytes ended): only the processor's half says something in this run"
		check "a quiet machine with compressed memory and the guard is not busy by the idle rule ($cpu ms, $io bytes in 30 s)" \
			test "$cpu" -lt 1500 -a "$io" -lt 524288
	else
		echo "CHECK FAIL the guest helper answered two looks with an observation's numbers"
	fi
	;;
pointer)
	t=$EPOCHREALTIME
	status=0
	timeout 60 "$D" start >"$STATE/start.out" 2>&1 || status=$?
	M "desktop_start rc=$status s=$(dt "$t") [$(head -1 "$STATE/start.out")]"
	check "the desktop starts ($(dt "$t") s)" test "$status" = 0
	"$D" open "file://$HERE/pointer.html" >/dev/null
	for _ in $(seq 1 120); do titles | grep -qF 'POINTER[down' && break; sleep 0.25; done
	check "the proof's pointer page is open on it" bash -c "wmctrl -l | grep -qF 'POINTER[down'"
	# The window is drawn and has the keyboard and pointer a moment after its title shows.
	sleep 1.5
	state() { sleep 0.4; titles | grep -F 'POINTER[' | head -1 | sed 's/.*\(POINTER\[[^]]*\]\).*/\1/'; }
	ended_under() { [[ $1 == 0 ]] && under "$2" "$3"; }
	# Every action below is on the spot the pointer is already on, where a move was waited for 15 s before.
	run() { # label, limit, then the desktop words: timed; it must end well, within the limit
		local label=$1 limit=$2 t s status=0
		shift 2
		# Apart in time, so two clicks are never taken for a double-click.
		sleep 0.7
		t=$EPOCHREALTIME
		timeout 40 "$D" "$@" >/dev/null 2>&1 || status=$?
		s=$(dt "$t")
		M "pointer $label s=$s rc=$status"
		check "$label ends well and takes under $limit s ($s s, exit $status)" ended_under "$status" "$s" "$limit"
	}
	"$D" click 640 400 >/dev/null 2>&1
	run "a second click on one spot" 1 click 640 400
	run "a third click on it" 1 click 640 400
	check "all three landed on 640,400 ($(state))" test "$(state)" = "POINTER[down=640,400 up=640,400 clicks=3 doubles=0]"
	run "a double-click on that spot" 1 double 640 400
	check "the double-click arrived there ($(state))" test "$(state)" = "POINTER[down=640,400 up=640,400 clicks=5 doubles=1]"
	run "a move to that spot" 1 move 640 400
	run "a drag that starts and ends on that spot" 1 drag 640 400 640 400
	check "it pressed and released there ($(state))" bash -c "[[ '$(state)' == 'POINTER[down=640,400 up=640,400 clicks='* ]]"
	run "a drag that starts on that spot" 1 drag 640 400 900 600
	check "it pressed at 640,400 and released at 900,600 ($(state))" bash -c "[[ '$(state)' == 'POINTER[down=640,400 up=900,600 clicks='* ]]"
	run "a drag that ends where it starts, from elsewhere" 1 drag 700 500 700 500
	check "it pressed and released at 700,500 ($(state))" bash -c "[[ '$(state)' == 'POINTER[down=700,500 up=700,500 clicks='* ]]"
	# Past the screen's edge the pointer ends at the edge, and is there already the second time.
	"$D" move 5000 5000 >/dev/null 2>&1
	run "a move past the screen's edge, a second time" 1 move 5000 5000
	check "the pointer is at the edge ($(xdotool getmouselocation 2>/dev/null | cut -d' ' -f1-2))" \
		test "$(xdotool getmouselocation 2>/dev/null | cut -d' ' -f1-2)" = "x:$(( $(xdotool getdisplaygeometry | cut -d' ' -f1) - 1 )) y:$(( $(xdotool getdisplaygeometry | cut -d' ' -f2) - 1 ))"
	# And a move that does move the pointer is still waited for, as before.
	run "a click on another spot" 1 click 300 300
	check "it landed on 300,300 ($(state))" bash -c "[[ '$(state)' == 'POINTER[down=300,300 up=300,300 clicks='* ]]"
	"$D" stop >/dev/null 2>&1
	;;
hide)
	# The next boot finds no zram module: modprobe is told to run /bin/false for it.
	echo "install zram /bin/false" >"$HIDE" || exit 1
	echo "hidden for the next boot"
	;;
hidden)
	M "hidden swaps=[$(tail -n +2 /proc/swaps | tr -s ' \t\n' ' ')] state=$(systemctl is-system-running 2>/dev/null) line=[$(journalctl -b -t qorpera-machine-memory -o cat | tr '\n' '|')]"
	check "the boot is usable without the module (basic.target and network-online.target are active)" \
		systemctl is-active --quiet basic.target network-online.target
	check "the module was hidden for this boot, and the machine has no swap, as machines had before" \
		test -s "$HIDE" -a -r /proc/swaps -a -z "$(tail -n +2 /proc/swaps)"
	check "the unit did not fail" systemctl is-active --quiet $SWAP_UNIT
	check "no unit failed" none_failed
	check "the journal says so in one clear line" \
		test "$(journalctl -b -t qorpera-machine-memory -o cat | grep -c '^compressed memory is OFF on this machine, which runs without it as machines did before: ')" = 1
	check "the guard still runs, on memory alone" systemctl is-active --quiet $GUARD_UNIT
	t=$EPOCHREALTIME
	timeout 60 "$D" start >/dev/null 2>&1
	check "the desktop starts all the same ($(dt "$t") s)" bash -c "$D status | grep -q '^running'"
	"$D" stop >/dev/null 2>&1
	;;
unhide)
	rm -f -- "$HIDE"
	# With the module back, the unit run again sets it up without a boot.
	systemctl restart $SWAP_UNIT
	check "with the module back, the unit run again switches compressed memory on" grep -q '^/dev/zram0 ' /proc/swaps
	;;
mix)
	label=${2:?label}
	check "the desktop runs, its browser's debugging port answers and the guest is prepared" ready
	[[ -s $HERE/v720.webm ]] || ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -t 14 -c:v libvpx-vp9 \
		-deadline realtime -cpu-used 8 -b:v 2500k -g 60 "$HERE/v720.webm"
	H=()
	if [[ ${3:-} == busy ]]; then
		# A job on EVERY processor, flat out (the worst a build or a test run does), as the size tests ran it.
		for _ in $(seq 1 "$(nproc)"); do
			timeout 150 node -e 'while(true){}' &
			H+=($!)
		done
		sleep 2
	fi
	phase 200 mix "$label"
	clicks "$label"
	if (( ${#H[@]} )); then
		# The numbers are "with every processor busy" only if the jobs ran to here: one that ended on the way (its own
		# time limit, the guard) left a processor free for a part of the leg.
		alive=0
		for pid in "${H[@]}"; do kill -0 "$pid" 2>/dev/null && alive=$(( alive + 1 )); done
		check "every processor was kept busy to the leg's end ($alive of ${#H[@]} jobs still ran)" test "$alive" = "${#H[@]}"
		# Their end by this signal is not the leg's: it ran to its end.
		kill "${H[@]}" 2>/dev/null
		wait "${H[@]}" 2>/dev/null || true
	fi
	;;
load)
	job=${2:?job MB} edge=${3:?stop or past} tabs=${4:?tabs}
	M "env edge=$edge job=${job}MB cpus=$(nproc) memTotalMB=$(( $(kb MemTotal) / 1024 )) availMB=$(avail) kernel=$(uname -r) $($MEMORY status | tr '\n' ' ')"
	(( $(kb MemTotal) >= 3500000 )) || M "small machine: the desktop's size check is lowered for this test only"
	check "the desktop runs, its browser's debugging port answers and the guest is prepared" ready
	phase 240 heavyapps
	M "after_heavy_apps availMB=$(avail) swapUsedMB=$(swapused)"
	if (( job > 0 )); then
		# The agent's own job, started as the executor starts a command (the guest helper, a unit in the machine's
		# slice): it holds JOB MB, half of it random (which does not compress), and touches a sixteenth every 5 s.
		status=0
		started=$(command_start "node $HERE/job.cjs $job") || status=$?
		M "job started as a machine command: ${started:-no answer}"
		check "the agent's job started as a machine command" test "$status" = 0
		# It says so once it holds its memory.
		holds=no
		for _ in $(seq 1 30); do
			receipt=$(helper read "$(cat "$STATE/job" 2>/dev/null)" tail 600) || receipt=
			[[ $(jq -er .state <<<"$receipt" 2>/dev/null) == running && $(jq -er .output <<<"$receipt" 2>/dev/null) == *"holding $job MB"* ]] && { holds=yes; break; }
			sleep 1
		done
		check "the job runs and holds its $job MB" test "$holds" = yes
		sleep 5
		M "with_${job}MB_job availMB=$(avail) swapUsedMB=$(swapused)"
	fi
	phase 900 tabs "$tabs" "$edge"
	phase 180 anim 5000 everything-open
	clicks everything-open
	M "end availMB=$(avail) swapUsedMB=$(swapused) chromeProcs=$(pgrep -u desktop -c chrome) pressure=[$(head -1 /proc/pressure/memory)]"
	M "zram $(zramctl --noheadings --bytes --output NAME,DISKSIZE,DATA,COMPR,TOTAL 2>/dev/null | tr -s ' ')"
	;;
job)
	# An agent's own job that outgrows the machine (twice its memory by default): it is the one that is ended, and its
	# command ends the way an agent reads it. Twice: as agents mostly write a command (a step, then the program, which
	# bash then runs in its own place), and with a shell that stays above the program and can say how it ended.
	size=${2:-$(( $(kb MemTotal) / 512 ))} share=${3:-50}
	M "job size=${size}MB random=${share}% availMB=$(avail) $($MEMORY status | tr '\n' ' ')"
	outgrow() { # label, the command line: prints how it ended; the receipt is left in $receipt
		local since started status=0
		since=$(date +%s) started=$EPOCHREALTIME
		command_start "$2" >/dev/null || status=$?
		check "the job ($1) started as a machine command" test "$status" = 0
		receipt=
		for _ in $(seq 1 150); do
			sleep 2
			receipt=$(helper read "$(cat "$STATE/job")" tail 600) || receipt=
			[[ $(jq -er .state <<<"$receipt" 2>/dev/null) == running ]] || break
		done
		M "job ($1) ended after $(dt "$started") s: $(jq -c '{state, exitCode, output}' <<<"$receipt" 2>/dev/null) availMB=$(avail) swapUsedMB=$(swapused)"
		journalctl -b --since "@$since" -t qorpera-machine-memory-guard -o cat | grep -E '^(sending SIG[A-Z]* to process|process [0-9]+ exited|mem avail)' | cut -c1-200 | sed 's/^/J guard: /'
		journalctl -b --since "@$since" -k -o cat | grep -E 'Out of memory|Killed process' | cut -c1-200 | sed 's/^/J kernel: /'
		check "the job ($1) was the one ended, and the journal names it" bash -c "journalctl -b --since @$since -t qorpera-machine-memory-guard -o cat | grep -q '^sending SIGKILL to process [0-9]* uid 0 .*cmdline \"node job.cjs ' || journalctl -b --since @$since -k -o cat | grep -Eq 'Killed process [0-9]+ \\((node|MainThread)\\)'"
		jq -er .output <<<"$receipt" >"$STATE/job-output" 2>/dev/null || : >"$STATE/job-output"
	}
	outgrow "the program is the command" "cd $HERE && node job.cjs $size $share"
	check "its command ended as failed ($(jq -c '{state, exitCode}' <<<"$receipt" 2>/dev/null))" test "$(jq -er .state <<<"$receipt" 2>/dev/null)" = failed
	sleep 3
	outgrow "a shell stays above the program" "cd $HERE && node job.cjs $size $share; echo \"the program ended with \$?\""
	check "its shell says the program was killed, with exit code 137" grep -q 'Killed.*node job.cjs' "$STATE/job-output"
	check "and went on" grep -qx 'the program ended with 137' "$STATE/job-output"
	check "the guest helper answers a look with an observation" bash "$HERE/guest.sh" look
	;;
after)
	edge=${2:-past}
	# This boot's journal, read once into files: the guard's lines with their time (the machine's clock is UTC, as the
	# probe's) and the kernel's. A journal that cannot be read fails the proof: nothing passes on lines never seen.
	guard_log=$STATE/after-guard kernel_log=$STATE/after-kernel
	guard_read=0 kernel_read=0
	journalctl -b -t qorpera-machine-memory-guard -o short-iso >"$guard_log.raw" 2>/dev/null || guard_read=$?
	journalctl -b -k -o cat >"$kernel_log" 2>/dev/null || kernel_read=$?
	# The guard's lines with only their time before them: every line that was read is there to be judged.
	sed -E 's/^[0-9-]+T([0-9:]+)[^ ]* [^ ]+ [^ ]+: /\1 /' "$guard_log.raw" >"$guard_log" || guard_read=1
	check "this boot's journal can be read: the guard's lines and the kernel's" \
		test "$guard_read" = 0 -a "$kernel_read" = 0 -a -s "$guard_log.raw" -a -s "$kernel_log" -a "$(wc -l <"$guard_log")" = "$(wc -l <"$guard_log.raw")"
	grep -E '^[0-9:]+ (sending SIG[A-Z]* to process|process [0-9]+ exited|kill failed|mem avail)' "$guard_log" | cut -c1-200 | sed 's/^/J guard: /'
	grep -E 'Out of memory|oom-kill|Killed process' "$kernel_log" | sed 's/^/J kernel: /'
	# What the guard ended, from the command line in each of its lines (`kinds`): a browser tab, one of Chromium's own
	# helper processes, the browser itself, the agent's job, or something else.
	kinds=$(sed -n 's/^[0-9:]* sending SIG[A-Z]* to process [0-9]* uid [0-9]* "[^"]*": .* cmdline "\(.*\)$/\1/p' "$guard_log" | kinds)
	count() { grep -cx "$1" <<<"$kinds" || true; }
	ended=$(grep -c '^[0-9:]* sending SIG[A-Z]* to process' "$guard_log" || true)
	kernel=$(grep -c 'Killed process' "$kernel_log" || true)
	tabs=$(count tab) helpers=$(count helper) browsers=$(count browser) jobs=$(count job) others=$(count other)
	M "after guard_signals=$ended kernel_kills=$kernel ended: tabs=$tabs browser_helpers=$helpers the_job=$jobs the_browser_itself=$browsers other=$others"
	if [[ $edge == past ]]; then
		check "something was ended, and the journal names it ($ended by the guard, $kernel by the kernel)" test "$(( ended + kernel ))" -ge 1
		check "the guard acted before the kernel's own killer had to" test "$kernel" = 0
	else
		# The load stopped before the edge: nothing has to be ended, and what was is said, and judged below.
		check "the kernel's own killer ended nothing" test "$kernel" = 0
	fi
	# What may be ended and what may not. Tabs are the guard's first choice, and Chromium shows "Aw, Snap!" in each;
	# Chromium starts its helper processes again; the agent's job is the biggest other program. Nothing else runs big
	# here, so anything else the guard ended, and the browser itself above all, fails the proof.
	check "the guard ended only what it may end: $tabs browser tab(s), $helpers of Chromium's helper processes, $jobs time(s) the agent's job; never the browser itself ($browsers) or anything else ($others), and each of its $ended lines was read" \
		test "$(( tabs + helpers + jobs + browsers + others ))" = "$ended" -a "$browsers" = 0 -a "$others" = 0
	# What the agent's command says: it still runs, or it was the one the guard ended.
	if [[ -s $STATE/job ]]; then
		receipt=$(helper read "$(cat "$STATE/job")" tail 600) || receipt=
		state=$(jq -er .state <<<"$receipt" 2>/dev/null) || state=
		M "job $(jq -c '{state, exitCode, output}' <<<"$receipt" 2>/dev/null)"
		check "the agent's job still runs, or was the one the guard ended (it says: ${state:-nothing}; the guard ended it $jobs time(s))" \
			test "$state" = running -o \( "$state" = failed -a "$jobs" -ge 1 \)
	fi
	# Who is alive.
	for name in Xvnc xfwm4 xfce4-session xfce4-panel dbus-daemon; do
		check "the desktop's $name is alive" pgrep -u desktop -x "$name"
	done
	check "the desktop's unit is active" systemctl is-active --quiet qorpera-machine-desktop.service
	check "the desktop command answers: $("$D" status 2>&1 | head -1)" bash -c "$D status | grep -q '^running'"
	check "the LXD agent is alive" systemctl is-active --quiet lxd-agent.service
	check "the guard is alive" systemctl is-active --quiet $GUARD_UNIT
	check "the guest helper answers a look with an observation" bash "$HERE/guest.sh" look
	check "a screenshot is taken" timeout 20 scrot --overwrite --silent "$STATE/after.png"
	# The browser itself. Tabs may be ended; the browser may not: with its main process every tab is gone. The process
	# asked about is the one noted before the edge, by its pid and when it started.
	main= main_started=
	if [[ -r $STATE/browser-main ]]; then read -r main main_started <"$STATE/browser-main" || true; fi
	check "the browser itself was not ended (tabs may be, the browser may not): its main process ${main:-unknown}, noted before the edge, is alive" \
		test -n "$main" -a -n "$main_started" -a "$(started_at "${main:-0}")" = "$main_started"
	check "the browser's debugging port answers" port_answers
	M "after chromeProcs=$(pgrep -u desktop -c chrome) availMB=$(avail) swapUsedMB=$(swapused)"
	M "after protected: Xvnc=$(adj "$(pgrep -u desktop -x Xvnc | head -1)") xfwm4=$(adj "$(pgrep -u desktop -x xfwm4 | head -1)") browser=$(adj "${main:-0}") tab=$(adj "$(pgrep -u desktop -f -- '--type=renderer' | head -1)")"
	;;
phase)
	shift
	phase "$@"
	;;
kinds)
	kinds
	;;
look)
	# One look, as the executor takes one each pass. Answered means that the helper itself ended well (not failed, not
	# cut off at its time limit) AND that what it wrote is an observation: a refusal, an empty answer and no answer at
	# all are each a look that was not answered. Decided here, so this exit code is the truth for whoever asks.
	answer=$(helper observe -) || { echo "look: the guest helper did not answer (exit $?)" >&2; exit 1; }
	is "$OBSERVATION" "$answer" ||
		{ echo "look: the guest helper answered $(jq -er .schema <<<"$answer" 2>/dev/null || echo nothing readable), not an observation" >&2; exit 1; }
	echo "$OBSERVATION"
	exit 0
	;;
*)
	sed -n 2,25p "${BASH_SOURCE[0]}" >&2
	exit 2
	;;
esac
exit 0
