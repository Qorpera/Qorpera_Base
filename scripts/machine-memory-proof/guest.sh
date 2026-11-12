#!/bin/bash
# The in-machine half of scripts/prove-machine-memory.sh. It runs as root inside a throwaway machine, through LXD's
# agent as the executor's own calls do, and prints `CHECK ok ...` / `CHECK FAIL ...` lines (what the proof passes or
# fails on) and `M ...` lines (measures for a person).
#
#   guest.sh browser                      the desktop and its Chromium, started for the legs below
#   guest.sh boot                         compressed memory after a boot, its unit run again, the guard, who is protected
#   guest.sh quiet                        the idle rule's own measure on the quiet machine, over 30 s
#   guest.sh pointer                      the desktop's start time; clicks, a double, a move and drags on one spot
#   guest.sh hide | hidden | unhide       the module hidden for the next boot; that boot checked; the module back
#   guest.sh mix LABEL [busy]             the size tests' mixed desktop leg, with every processor busy or not
#   guest.sh load JOB_MB stop|past TABS   heavy web apps, a job of JOB_MB as a real machine command, then tabs
#   guest.sh job [MB] [RANDOM%]           an agent's job that outgrows the machine: it is ended, and how its command ends
#   guest.sh after                        after the edge: what was ended, what the agent's command says, who is alive
set -u
export LC_ALL=C.UTF-8 DISPLAY=:1 NODE_PATH=/opt/node/lib/node_modules HOME=/root
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE=/run/memory-proof
GUEST=/opt/qorpera-machine/cloud-machine-guest.mjs
MEMORY=/opt/qorpera-machine/machine-memory
SWAP_UNIT=qorpera-machine-memory.service
GUARD_UNIT=qorpera-machine-memory-guard.service
HIDE=/etc/modprobe.d/qorpera-memory-proof.conf
mkdir -p "$STATE"

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
# The executor's own way to the guest helper: a nonce, then the reply file.
helper() {
	local nonce
	nonce=$(uuid)
	timeout 30 /usr/bin/node "$GUEST" "$nonce" "$@" >/dev/null 2>&1
	cat "/run/qorpera-machine/replies/$nonce.json" 2>/dev/null
}
# The desktop command; on a machine under a desktop's size, a copy with the size check lowered FOR THIS TEST ONLY.
D=desktop
if (( $(kb MemTotal) < 3500000 )); then
	sed 's/^MIN_MEMORY_KB=.*/MIN_MEMORY_KB=1500000/' /usr/local/bin/desktop >"$STATE/desktop" && chmod 755 "$STATE/desktop"
	D=$STATE/desktop
fi
titles() { wmctrl -l 2>/dev/null | awk '{ $1=$2=$3=""; sub(/^ +/,""); print }'; }
# Starts a command as the executor starts an agent's: through the guest helper, as a unit in the machine's slice.
# Its id is kept in $STATE/job.
command_start() { # the command line
	local machine command
	command=$(uuid)
	# One machine id for the boot, as a real machine has: the helper refuses another.
	[[ -s $STATE/machine ]] || uuid >"$STATE/machine"
	machine=$(cat "$STATE/machine")
	helper prepare "$machine" 1 >/dev/null
	helper refresh-lease 900000 >/dev/null
	jq -cn --arg machine "$machine" --arg command "$command" --arg sha "$(printf %064d 0)" --arg run "$1" \
		'{schema: "qorpera.machine-command-request/v1", machineId: $machine, commandId: $command, inputSha256: $sha, command: $run, timeoutMs: null}' \
		>"/var/lib/qorpera-machine/inbox/$command.json"
	chmod 400 "/var/lib/qorpera-machine/inbox/$command.json"
	echo "$command" >"$STATE/job"
	helper start "$command" | jq -c '{state, exitCode}'
}
# The desktop, a page server for the proof's own pages, and the desktop's Chromium with its debugging port open.
browser() {
	timeout 60 "$D" start >/dev/null 2>&1
	if ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:8700/app.html; then
		(cd "$HERE" && exec python3 -m http.server 8700 --bind 127.0.0.1 >/dev/null 2>&1) &
	fi
	if ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:9222/json/version; then
		timeout 30 "$D" run /usr/lib/qorpera-chromium/chrome --start-maximized --no-first-run --no-default-browser-check \
			--password-store=basic --disable-infobars --enable-unsafe-swiftshader --remote-debugging-port=9222 \
			--user-data-dir=/home/desktop/proof-profile about:blank >/dev/null 2>&1
		for _ in $(seq 1 80); do curl -s -o /dev/null --max-time 1 http://127.0.0.1:9222/json/version && break; sleep 0.25; done
	fi
}
clicks() { # label: four clicks on four spots, and a look after each
	local i t c
	for i in 1 2 3 4; do
		t=$EPOCHREALTIME
		timeout 30 "$D" click $(( 500 + i * 60 )) $(( 400 + i * 40 )) >/dev/null 2>&1
		c=$(dt "$t")
		t=$EPOCHREALTIME
		timeout 30 scrot --pointer --overwrite --silent "$STATE/look.png"
		M "$1 click_s=$c look_s=$(dt "$t") load=$(cut -d' ' -f1 /proc/loadavg)"
	done
}

case ${1:-} in
browser)
	browser
	"$D" status | head -1
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
	check "no unit failed" test -z "$(systemctl --failed --no-legend)"
	;;
quiet)
	# The idle rule's measure, as the executor takes it: two looks of the guest helper, 30 s apart. Under 5 % of one
	# processor and 512 KiB, the machine may sleep.
	[[ -s $STATE/machine ]] || uuid >"$STATE/machine"
	helper prepare "$(cat "$STATE/machine")" 1 >/dev/null
	helper refresh-lease 900000 >/dev/null
	first=$(helper observe -)
	sleep 30
	second=$(helper observe -)
	cpu=$(( ($(jq -r .cpuUsec <<<"$second") - $(jq -r .cpuUsec <<<"$first")) / 1000 ))
	io=$(( $(jq -r .ioBytes <<<"$second") - $(jq -r .ioBytes <<<"$first") ))
	M "quiet cpu_ms=$cpu of 30000 (the rule: 1500) io_bytes=$io (the rule: 524288) swapUsedMB=$(swapused)"
	check "a quiet machine with compressed memory and the guard is not busy by the idle rule ($cpu ms, $io bytes in 30 s)" \
		test "$cpu" -lt 1500 -a "$io" -lt 524288
	;;
pointer)
	t=$EPOCHREALTIME
	timeout 60 "$D" start >"$STATE/start.out" 2>&1
	M "desktop_start rc=$? s=$(dt "$t") [$(head -1 "$STATE/start.out")]"
	"$D" open "file://$HERE/pointer.html" >/dev/null
	for _ in $(seq 1 120); do titles | grep -qF 'POINTER[down' && break; sleep 0.25; done
	# The window is drawn and has the keyboard and pointer a moment after its title shows.
	sleep 1.5
	state() { sleep 0.4; titles | grep -F 'POINTER[' | head -1 | sed 's/.*\(POINTER\[[^]]*\]\).*/\1/'; }
	# Every action below is on the spot the pointer is already on, where a move was waited for 15 s before.
	run() { # label, limit, then the desktop words: timed, checked against the limit
		local label=$1 limit=$2 t s
		shift 2
		# Apart in time, so two clicks are never taken for a double-click.
		sleep 0.7
		t=$EPOCHREALTIME
		timeout 40 "$D" "$@" >/dev/null 2>&1
		s=$(dt "$t")
		M "pointer $label s=$s"
		check "$label takes under $limit s ($s s)" under "$s" "$limit"
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
	echo "install zram /bin/false" >"$HIDE"
	echo "hidden for the next boot"
	;;
hidden)
	M "hidden swaps=[$(tail -n +2 /proc/swaps | tr -s ' \t\n' ' ')] state=$(systemctl is-system-running 2>/dev/null) line=[$(journalctl -b -t qorpera-machine-memory -o cat | tr '\n' '|')]"
	check "the boot is usable without the module (basic.target and network-online.target are active)" \
		systemctl is-active --quiet basic.target network-online.target
	check "the machine has no swap, as machines had before" test -z "$(tail -n +2 /proc/swaps)"
	check "the unit did not fail" bash -c "systemctl is-active --quiet $SWAP_UNIT && [[ -z \$(systemctl --failed --no-legend) ]]"
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
	browser
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
	cd "$HERE" && timeout 150 node pages.cjs mix "$label"
	clicks "$label"
	# Their end by this signal is not the leg's: it ran to its end.
	if (( ${#H[@]} )); then kill "${H[@]}" 2>/dev/null; wait "${H[@]}" 2>/dev/null || true; fi
	;;
load)
	job=${2:?job MB} edge=${3:?stop or past} tabs=${4:?tabs}
	M "env edge=$edge job=${job}MB cpus=$(nproc) memTotalMB=$(( $(kb MemTotal) / 1024 )) availMB=$(avail) kernel=$(uname -r) $($MEMORY status | tr '\n' ' ')"
	(( $(kb MemTotal) >= 3500000 )) || M "small machine: the desktop's size check is lowered for this test only"
	browser
	cd "$HERE" || exit 1
	timeout 240 node pages.cjs heavyapps
	M "after_heavy_apps availMB=$(avail) swapUsedMB=$(swapused)"
	if (( job > 0 )); then
		# The agent's own job, started as the executor starts a command (the guest helper, a unit in the machine's
		# slice): it holds JOB MB, half of it random (which does not compress), and touches a sixteenth every 5 s.
		M "job started as a machine command: $(command_start "node $HERE/job.cjs $job")"
		sleep 10
		M "with_${job}MB_job availMB=$(avail) swapUsedMB=$(swapused)"
	fi
	timeout 900 node pages.cjs tabs "$tabs" "$edge"
	M "tabs rc=$?"
	timeout 90 node pages.cjs anim 5000 everything-open
	M "anim rc=$?"
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
		local since started
		since=$(date +%s) started=$EPOCHREALTIME
		command_start "$2" >/dev/null
		receipt=
		for _ in $(seq 1 150); do
			sleep 2
			receipt=$(helper read "$(cat "$STATE/job")" tail 600)
			[[ $(jq -r .state <<<"$receipt") == running ]] || break
		done
		M "job ($1) ended after $(dt "$started") s: $(jq -c '{state, exitCode, output}' <<<"$receipt") availMB=$(avail) swapUsedMB=$(swapused)"
		journalctl -b --since "@$since" -t qorpera-machine-memory-guard -o cat | grep -E '^(sending SIG[A-Z]* to process|process [0-9]+ exited|mem avail)' | cut -c1-200 | sed 's/^/J guard: /'
		journalctl -b --since "@$since" -k -o cat | grep -E 'Out of memory|Killed process' | cut -c1-200 | sed 's/^/J kernel: /'
		check "the job ($1) was the one ended, and the journal names it" bash -c "journalctl -b --since @$since -t qorpera-machine-memory-guard -o cat | grep -q '^sending SIGKILL to process [0-9]* uid 0 .*cmdline \"node job.cjs ' || journalctl -b --since @$since -k -o cat | grep -Eq 'Killed process [0-9]+ \\((node|MainThread)\\)'"
		jq -r .output <<<"$receipt" >"$STATE/job-output"
	}
	outgrow "the program is the command" "cd $HERE && node job.cjs $size $share"
	check "its command ended as failed ($(jq -c '{state, exitCode}' <<<"$receipt"))" test "$(jq -r .state <<<"$receipt")" = failed
	sleep 3
	outgrow "a shell stays above the program" "cd $HERE && node job.cjs $size $share; echo \"the program ended with \$?\""
	check "its shell says the program was killed, with exit code 137" grep -q 'Killed.*node job.cjs' "$STATE/job-output"
	check "and went on" grep -qx 'the program ended with 137' "$STATE/job-output"
	check "the guest helper answers a look" bash -c "[[ \$(/bin/bash '$HERE/guest.sh' look) == qorpera.machine-observation/v2 ]]"
	;;
after)
	# What was ended, by the guard and by the kernel, as the journal names it.
	# With the time of each line (the machine's clock is UTC, as the probe's).
	journalctl -b -t qorpera-machine-memory-guard -o short-iso | sed -E 's/^[0-9-]+T([0-9:]+)[^ ]* [^ ]+ [^ ]+: /\1 /' |
		grep -E '^[0-9:]+ (sending SIG[A-Z]* to process|process [0-9]+ exited|kill failed|mem avail)' | cut -c1-200 | sed 's/^/J guard: /'
	journalctl -b -k -o cat | grep -E 'Out of memory|oom-kill|Killed process' | sed 's/^/J kernel: /'
	ended=$(journalctl -b -t qorpera-machine-memory-guard -o cat | grep -c '^sending SIG[A-Z]* to process')
	kernel=$(journalctl -b -k -o cat | grep -c 'Killed process')
	M "after guard_signals=$ended kernel_kills=$kernel ended=[$(journalctl -b -t qorpera-machine-memory-guard -o cat | sed -n 's/^sending \(SIG[A-Z]*\) to process [0-9]* uid [0-9]* "\([^"]*\)".*/\1:\2/p' | sort | uniq -c | tr -s ' \n' ' ')]"
	check "something was ended, and the journal names it ($ended by the guard, $kernel by the kernel)" test "$(( ended + kernel ))" -ge 1
	check "the guard acted before the kernel's own killer had to" test "$kernel" = 0
	# What the agent's command says.
	if [[ -s $STATE/job ]]; then
		receipt=$(helper read "$(cat "$STATE/job")" tail 600)
		M "job $(jq -c '{state, exitCode, output}' <<<"$receipt")"
	fi
	# Who is alive.
	for name in Xvnc xfwm4 xfce4-session xfce4-panel dbus-daemon; do
		check "the desktop's $name is alive" pgrep -u desktop -x "$name"
	done
	check "the desktop's unit is active" systemctl is-active --quiet qorpera-machine-desktop.service
	check "the desktop command answers: $("$D" status 2>&1 | head -1)" bash -c "$D status | grep -q '^running'"
	check "the LXD agent is alive" systemctl is-active --quiet lxd-agent.service
	check "the guard is alive" systemctl is-active --quiet $GUARD_UNIT
	check "the guest helper answers a look" bash -c "[[ \$(/bin/bash '$HERE/guest.sh' look) == qorpera.machine-observation/v2 ]]"
	check "a screenshot is taken" timeout 20 scrot --overwrite --silent "$STATE/after.png"
	M "after browser=$(curl -s -o /dev/null --max-time 3 http://127.0.0.1:9222/json/version && echo alive || echo gone) chromeProcs=$(pgrep -u desktop -c chrome) availMB=$(avail) swapUsedMB=$(swapused)"
	M "after protected: Xvnc=$(adj "$(pgrep -u desktop -x Xvnc | head -1)") xfwm4=$(adj "$(pgrep -u desktop -x xfwm4 | head -1)") browser=$(adj "$(pgrep -u desktop -o chrome)") tab=$(adj "$(pgrep -u desktop -f -- '--type=renderer' | head -1)")"
	;;
look)
	helper observe - | jq -r .schema
	;;
*)
	sed -n 2,15p "${BASH_SOURCE[0]}" >&2
	exit 2
	;;
esac
