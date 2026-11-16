#!/bin/bash
# C2i proof: the execution host image's recipe (deploy/lxd-runner-guest/install-image-contract.sh) on a STOCK Ubuntu
# 26.04 VM, then the Claude Code box on it. A throwaway nested VM `c2i-host` from the test VM's cached 26.04 minimal
# image; nothing is put on it by hand but what the recipe cannot have outside the real image build (image-package.py
# says which lines and prints them). As root on the test VM through run-on-node --sudo (with install).
# Usage: image.sh build            the guest package of this commit, c2i-host, the recipe, a reboot, what it holds
#        image.sh checks           the recipe's box checks as installed, then with each part taken away
#        image.sh prove LABEL MODE...   the proof kit's modes on c2i-host as the slot's host account, under the real
#                                  qorpera-shared-run-host@.service's hardening, every part at the runtime's own path
#        image.sh signin           the helper's Claude sign-in with the image's own Claude Code (made-up code)
#        image.sh cleanup          c2i-host and this proof's folders, by exact names
set -uo pipefail
STEP=$1
shift
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
L=/home/tester/lanes/agent-box-C2i
P=/opt/qorpera-c2-proof
S=c2i-host
export C2_HOME=qorpera-machine-c2e000000000400080000000000000d2
SLOT=qorpera-shared-host-0
SX() { lxc exec $S -- "$@" </dev/null; }
say() { echo "$(date -u +%H:%M:%S) $*"; }
up() {
	for _ in $(seq 1 300); do SX systemctl is-active --quiet basic.target 2>/dev/null && break; sleep 1; done
	SX systemctl is-system-running --wait >/dev/null 2>&1
	say "c2i-host: $(SX systemctl is-system-running 2>&1)"
}
checks_script() {
	# The recipe's own check block, byte for byte between its markers, with the three names it uses.
	{
		echo 'set -euo pipefail'
		echo 'CLAUDE_DIR=/opt/qorpera-harnesses/native-claude'
		echo 'CLAUDE_BOX_GROUP=qorpera-claude-box'
		echo 'claude_version=$(node -p '"'"'require("/opt/qorpera-harnesses/native-claude/artifact.json").source.version'"'"')'
		sed -n "/^# --- the Claude Code box's checks: begin$/,/^# --- the Claude Code box's checks: end$/p" \
			"$REPO/deploy/lxd-runner-guest/install-image-contract.sh"
		echo 'echo CLAUDE_BOX_CHECKS_PASSED'
	} | lxc exec $S -- sh -c 'cat >/root/box-checks.sh'
}

case $STEP in
build)
	install -d -m 0755 $L
	NODE_OPTIONS="--import=$REPO/scripts/fixtures/committed-runtime-bundle/register.mjs" \
		node "$REPO/scripts/package-lxd-runner-guest.mjs" --out $L/pkg --contract-only || { echo "PACKAGING FAILED"; exit 1; }
	python3 "$HERE/image-package.py" $L/pkg $L/proofpkg || exit 1
	if ! lxc info $S >/dev/null 2>&1; then
		lxc init nested-probe-image $S --vm -c limits.cpu=2 -c limits.memory=4GiB -d root,size=20GiB -c boot.autostart=false </dev/null >/dev/null
		lxc start $S </dev/null
	fi
	up
	say "stock host before: $(SX sh -c '. /etc/os-release; echo $PRETTY_NAME $(uname -r); echo restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns); for b in bwrap sshfs node npm podman unshare apparmor_parser; do printf "%s=%s " $b $(command -v $b || echo -); done' | tr '\n' ' ')"
	SX rm -rf /root/proofpkg
	tar -C $L -cf - proofpkg | lxc exec $S -- tar -C /root --no-same-owner -xf -
	# The nested VM reaches no network of its own: Ubuntu's and npm's hosts through proxy.py on the bridge, by the
	# environment alone (apt, npm and node's fetch read it); the real builder reaches them directly.
	BR=$(lxc network get lxdbr0 ipv4.address </dev/null | cut -d/ -f1)
	python3 "$HERE/proxy.py" "$BR" 18557 >$L/proxy.out 2>&1 &
	PROXY=$!
	for _ in $(seq 1 50); do grep -q READY $L/proxy.out 2>/dev/null && break; sleep 0.1; done
	via="http://$BR:18557"
	say "RECIPE start (proxy $via: $(head -1 $L/proxy.out))"
	SX env http_proxy=$via https_proxy=$via HTTP_PROXY=$via HTTPS_PROXY=$via NODE_USE_ENV_PROXY=1 \
		bash /root/proofpkg/install-image-contract.sh /root/proofpkg 2>&1 | grep -vE '^(Get|Hit|Ign|Preparing to unpack|Unpacking|Setting up|Selecting previously|Processing triggers|\(Reading database)'
	say "RECIPE end rc=${PIPESTATUS[0]}"
	kill $PROXY
	echo "proxy: $(grep -c . $L/proxy.out) lines; refused: $(grep -c '^refused' $L/proxy.out); errors: $(grep -c '^error' $L/proxy.out)"
	grep -E '^(refused|error)' $L/proxy.out | sort | uniq -c | head -5
	# The real build removes its package and publishes; here the VM restarts, as a published image boots.
	SX rm -rf /root/proofpkg
	lxc restart $S </dev/null
	up
	say "after the reboot: profile $(SX grep -Fx 'qorpera-claude-box-ns (unconfined)' /sys/kernel/security/apparmor/profiles || echo 'NOT LOADED'), apparmor.service $(SX systemctl is-active apparmor.service), restrict_unprivileged_userns=$(SX sysctl -n kernel.apparmor_restrict_unprivileged_userns)"
	echo "=== what the image holds"
	SX sh -c 'stat -c "%U:%G %a %h %s %n" /opt/qorpera-harnesses/native-claude/claude /opt/qorpera-harnesses/native-claude/artifact.json /opt/qorpera-runner/qorpera-claude-box-ns /opt/qorpera-runner/qorpera-claude-box-stage.sh /opt/qorpera-runner/qorpera-claude-home-shell.mjs /opt/qorpera-runner/qorpera-native-isolation-child.mjs /etc/apparmor.d/qorpera-claude-box-ns /usr/bin/sshfs /usr/bin/bwrap /usr/bin/node /dev/fuse'
	SX sh -c 'echo "sha256 $(sha256sum /opt/qorpera-harnesses/native-claude/claude | cut -c1-16) /usr/local/bin/claude -> $(readlink -f /usr/local/bin/claude); claude --version: $(env -i HOME=/tmp/v CLAUDE_CONFIG_DIR=/tmp/v DISABLE_AUTOUPDATER=1 /usr/local/bin/claude --version); codex: $(/usr/local/bin/codex --version)"; rm -rf /tmp/v'
	SX sh -c 'dpkg -l sshfs fuse3 bubblewrap nodejs apparmor | awk "/^ii/{print \$2,\$3}" | tr "\n" " "; echo; getent group qorpera-claude-box; cat /etc/qorpera/lxd-runner-image.json'
	echo "=== every Claude Code on the image (files named claude, or an @anthropic-ai package)"
	SX sh -c 'find / -xdev \( -path /proc -o -path /sys \) -prune -o \( -name claude -o -name "claude-code*" -o -path "*/@anthropic-ai" \) -print 2>/dev/null; ls /root /tmp'
	;;
checks)
	checks_script
	run_checks() {
		say "CHECKS $1"
		SX bash /root/box-checks.sh 2>&1 | grep -vE '^$' | tail -4 | cut -c1-300
		echo "  rc=${PIPESTATUS[0]}"
	}
	run_checks "as installed"
	SX apparmor_parser --remove /etc/apparmor.d/qorpera-claude-box-ns
	run_checks "the profile unloaded"
	say "the box's own namespace start with the profile unloaded (the check's mount, by hand):"
	SX systemd-run --quiet --pipe --wait --collect --uid=nobody --gid=qorpera-claude-box -p NoNewPrivileges=yes \
		/opt/qorpera-runner/qorpera-claude-box-ns --user --map-root-user --mount -- /bin/sh -c 'mount -t tmpfs x /mnt && echo MOUNTED' 2>&1 | sed 's/^/  /'
	SX apparmor_parser --replace /etc/apparmor.d/qorpera-claude-box-ns
	SX mv /etc/apparmor.d/qorpera-claude-box-ns /root/profile.away
	run_checks "the profile's file gone (still loaded)"
	SX mv /root/profile.away /etc/apparmor.d/qorpera-claude-box-ns
	SX mv /opt/qorpera-runner/qorpera-claude-box-ns /root/helper.away
	run_checks "the helper gone"
	SX install -o root -g qorpera-claude-box -m 0750 /usr/bin/true /opt/qorpera-runner/qorpera-claude-box-ns
	run_checks "the helper another program"
	SX install -o root -g qorpera-claude-box -m 0755 /root/helper.away /opt/qorpera-runner/qorpera-claude-box-ns
	run_checks "the helper anyone's to run (0755)"
	SX install -o root -g qorpera-claude-box -m 0750 /root/helper.away /opt/qorpera-runner/qorpera-claude-box-ns
	SX rm -f /root/helper.away
	SX mv /opt/qorpera-harnesses/native-claude/claude /root/claude.away
	SX sh -c 'cp /root/claude.away /opt/qorpera-harnesses/native-claude/claude && printf x >>/opt/qorpera-harnesses/native-claude/claude && chmod 0555 /opt/qorpera-harnesses/native-claude/claude'
	run_checks "Claude Code not the pin (one byte more)"
	SX mv -f /root/claude.away /opt/qorpera-harnesses/native-claude/claude
	SX sh -c 'mkdir -p /opt/qorpera-harnesses/node_modules/@anthropic-ai'
	run_checks "a second Claude Code package beside it"
	SX rmdir /opt/qorpera-harnesses/node_modules/@anthropic-ai
	run_checks "everything restored"
	SX rm -f /root/box-checks.sh
	;;
prove)
	LABEL=$1
	shift
	MODES=("$@")
	# The proof kit's parts (the stub, its CA, the scenarios, the bundled prove.ts) and the home, as prove.sh makes them.
	bash "$HERE/prove.sh" prepare "$LABEL" --prepare | tail -2
	SX rm -rf $P
	tar -C /opt -cf - qorpera-c2-proof | lxc exec $S -- tar -C /opt --no-same-owner -xf -
	# Only the image's own parts run the box: the kit's copies of Claude Code, sshfs, the stage and the sources go.
	SX sh -c "rm -rf $P/claude $P/sshfs $P/src $P/qorpera-claude-box-stage.sh && chown -R root:root $P && chmod -R go-w $P && ls $P"
	lxc file push "$HERE/report.sh" $S/root/report.sh --mode 0700 </dev/null
	# The slot's host account and the folders its unit names, as install-shared-execution-guest.sh makes them.
	SX sh -c "id $SLOT >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/qorpera-shared-execution/slots/0 --shell /usr/sbin/nologin $SLOT; usermod -aG qorpera-claude-box $SLOT; id $SLOT"
	SX sh -c "install -d -o root -g root -m 0711 /var/lib/qorpera-shared-execution /var/lib/qorpera-shared-execution/slots /var/lib/qorpera-shared-execution/slots/0 && install -d -o $SLOT -g $SLOT -m 0700 /var/lib/qorpera-shared-execution/slots/0/host && install -d -o root -g root -m 0700 /var/lib/qorpera-shared-execution/journals /var/lib/qorpera/identities /run/qorpera-shared-execution /etc/qorpera-folder /srv/qorpera-folder"
	mapfile -t props < <(python3 "$HERE/unit-props.py" "$REPO/deploy/shared-execution/qorpera-shared-run-host@.service" 0)
	unit=()
	for prop in "${props[@]}"; do unit+=(-p "$prop"); done
	echo "=== qorpera-shared-run-host@0.service's hardening, as the runs below have it: ${props[*]}"
	BR=$(lxc network get lxdbr0 ipv4.address </dev/null | cut -d/ -f1)
	G=/var/lib/c2i-gw
	rm -rf $G
	install -d -m 0700 $G
	python3 $P/test/gateway.py $C2_HOME "$BR:18556" $G >$G/gateway.out 2>&1 &
	GW=$!
	for _ in $(seq 1 100); do grep -q READY $G/gateway.out 2>/dev/null && break; sleep 0.1; done
	say "gateway on $BR:18556: $(cat $G/gateway.out)"
	for MODE in "${MODES[@]}"; do
		SX rm -rf /var/lib/c2-proof
		SX install -d -o $SLOT -g $SLOT -m 0700 /var/lib/c2-proof
		printf '{"channel": {"kind": "gateway", "host": "%s", "port": 18556}, "image": true}\n' "$BR" |
			lxc exec $S -- sh -c "cat >/var/lib/c2-proof/proof.json && chown $SLOT:$SLOT /var/lib/c2-proof/proof.json"
		bash "$HERE/plant.sh" "$MODE"
		lxc exec $C2_HOME -- rm -rf /company/c2-stop /company/c2-alias-link /company/c2-alias-dir </dev/null
		say "IMAGE $MODE start"
		SX systemd-run --quiet --pipe --wait --collect --uid=$SLOT --gid=$SLOT --working-directory=/var/lib/c2-proof \
			"${unit[@]}" -p ReadWritePaths=/var/lib/qorpera-shared-execution/slots/0/host -p ReadWritePaths=/var/lib/c2-proof \
			/usr/bin/node $P/prove.bundle.mjs "$MODE" "$LABEL-$MODE" 2>&1
		say "IMAGE $MODE end rc=$?"
		sleep 2
		SX bash /root/report.sh /var/lib/c2-proof "$LABEL-$MODE" "$MODE"
		echo "=== c2i-host after $MODE: sshfs mounts and the slot account's processes"
		SX sh -c "n=0; for f in /proc/[0-9]*/mountinfo; do grep -q fuse.sshfs \$f 2>/dev/null && n=\$((n+1)); done; echo \"namespaces with an sshfs mount: \$n\"; pgrep -u $SLOT -a || echo 'no process of the slot account'"
		lxc exec $C2_HOME -- sh -c 'systemctl list-units --all --no-legend --plain "qorpera-machine-home-*" | cut -d" " -f1,3,4 | head; pgrep -af "time.sleep.600|sleep 8" | grep -v pgrep || echo "no long command left on the home"' </dev/null
		if [[ $MODE == a6 || $MODE == a5 ]]; then
			echo "=== hunt on the home, as root"
			lxc file push $P/test/hunt.py $C2_HOME/root/hunt.py --mode 0700 </dev/null >/dev/null
			lxc exec $C2_HOME -- python3 /root/hunt.py "$LABEL-$MODE" </dev/null
			lxc exec $C2_HOME -- rm -f /root/hunt.py </dev/null
		fi
		echo "=== c2i-host's AppArmor refusals during $MODE"
		SX sh -c 'dmesg | grep "apparmor=\"DENIED\"" | grep -v systemd-detect-virt | tail -5 | cut -c1-260'
	done
	kill -TERM $GW
	wait $GW
	echo "=== gateway (both channels)"
	tr -d '\n ' <$G/gateway-summary.json
	echo
	grep -hE '"ev": "(CANARY|error|bad-line)' $G/gateway.jsonl | head -10
	rm -rf $G
	say "IMAGE PROVE DONE $LABEL"
	;;
signin)
	# The image's own Claude Code and isolation child, as the vault helper would run them (its unit's hardening).
	install -d -m 0755 /opt/qorpera-c2i-proof
	npx esbuild "$HERE/signin.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
		--alias:@qorpera/contracts=./packages/contracts/src/index.ts \
		"--banner:js=import { createRequire as __c2i_require } from \"node:module\"; const require = __c2i_require(import.meta.url);" \
		--outfile=/opt/qorpera-c2i-proof/signin.bundle.mjs || { echo "BUNDLE FAILED"; exit 1; }
	SX install -d -o root -g root -m 0755 /opt/qorpera-c2i-proof
	lxc file push /opt/qorpera-c2i-proof/signin.bundle.mjs $S/opt/qorpera-c2i-proof/signin.bundle.mjs --uid 0 --gid 0 --mode 0444 </dev/null
	mapfile -t props < <(python3 "$HERE/unit-props.py" "$REPO/deploy/cloud-secret-broker/qorpera-model-login-helper.service")
	unit=()
	for prop in "${props[@]}"; do unit+=(-p "$prop"); done
	SX sh -c 'rm -rf /var/lib/c2i-proof && install -d -o 65534 -g 65534 -m 0700 /var/lib/c2i-proof /var/lib/c2i-proof/root'
	for what in raw helper; do
		say "IMAGE SIGNIN $what start"
		if [[ $what == raw ]]; then cmd=(raw /opt/qorpera-harnesses/native-claude/claude /var/lib/c2i-proof/root); else cmd=(helper /opt/qorpera-harnesses/native-claude/claude /opt/qorpera-runner/qorpera-native-isolation-child.mjs /var/lib/c2i-proof/root); fi
		SX systemd-run --quiet --pipe --wait --collect --uid=65534 --gid=65534 --working-directory=/var/lib/c2i-proof "${unit[@]}" \
			-p ReadWritePaths=/var/lib/c2i-proof /usr/bin/node /opt/qorpera-c2i-proof/signin.bundle.mjs "${cmd[@]}" 2>&1
		say "IMAGE SIGNIN $what end rc=$?"
	done
	SX sh -c 'echo "left in the sign-in root: $(find /var/lib/c2i-proof/root -mindepth 1 | wc -l) entries"; rm -rf /var/lib/c2i-proof /opt/qorpera-c2i-proof'
	rm -rf /opt/qorpera-c2i-proof
	;;
cleanup)
	for H in $S $C2_HOME; do
		lxc delete --force $H </dev/null 2>/dev/null && echo "deleted $H"
		lxc list -f csv -c n </dev/null | grep -x $H || echo "$H gone"
	done
	rm -rf /opt/qorpera-c2-proof /var/lib/c2-proof /run/c2-gw /var/lib/c2i-gw /opt/qorpera-c2i-proof /var/lib/c2i-proof $L /home/tester/lanes/agent-box-C2
	ls -d /opt/qorpera-c2-proof /var/lib/c2-proof /run/c2-gw /var/lib/c2i-gw /opt/qorpera-c2i-proof /var/lib/c2i-proof $L /home/tester/lanes/agent-box-C2 2>&1 | sed 's/^/left: /'
	;;
*)
	echo "unknown step $STEP"
	exit 2
	;;
esac
