#!/bin/bash
# C2 proof on a STOCK Ubuntu 26.04 run host (review round 1, D): a throwaway nested VM `c2-host` from the test VM's
# cached 26.04 minimal image, with its own defaults (kernel.apparmor_restrict_unprivileged_userns = 1, Ubuntu's
# bwrap-userns-restrict profile) and only what the execution host image would add for the box: bubblewrap, sshfs
# (fuse3), node, the profiled namespace helper (/opt/qorpera-runner/qorpera-claude-box-ns, a root-owned copy of
# unshare, 0750 root:nogroup) with deploy/claude-box/qorpera-claude-box-ns.apparmor loaded, and the box's parts.
# The driver runs there as nobody in a unit with the company host's hardening (NoNewPrivileges, PrivateDevices with
# /dev/fuse let in, RestrictNamespaces as the unit has it). The home is the same nested VM as prove.sh's; its channels
# come from gateway.py on the test VM over TCP on the LXD bridge. As root through run-on-node --sudo (with install).
# Usage: stock.sh LABEL MODE...
set -uo pipefail
LABEL=$1
shift
MODES=("$@")
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
P=/opt/qorpera-c2-proof
L=/home/tester/lanes/agent-box-C2
S=c2-host
export C2_HOME=qorpera-machine-c2e000000000400080000000000000d2
SX() { lxc exec $S -- "$@" </dev/null; }
say() { echo "$(date -u +%H:%M:%S) $*"; }

# The box's parts and the home, as prove.sh makes them.
bash "$HERE/prove.sh" prepare "$LABEL" --prepare | tail -2
install -d -m 0755 $L/hostdebs
(cd $L/hostdebs && for p in bubblewrap sshfs fuse3 libfuse3-4; do ls ${p}_*.deb >/dev/null 2>&1 || apt-get download $p >/dev/null 2>&1; done)

if ! lxc info $S >/dev/null 2>&1; then
	lxc init nested-probe-image $S --vm -c limits.cpu=2 -c limits.memory=4GiB -d root,size=16GiB -c boot.autostart=false </dev/null >/dev/null
	lxc start $S </dev/null
	for _ in $(seq 1 300); do SX systemctl is-active --quiet basic.target 2>/dev/null && break; sleep 1; done
fi
SX systemctl is-system-running --wait >/dev/null 2>&1
say "stock host before: $(SX sh -c '. /etc/os-release; echo $PRETTY_NAME $(uname -r); echo restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns); aa-status 2>/dev/null | grep -cE "^   (bwrap|unpriv_bwrap|unprivileged_userns)$"; for b in bwrap sshfs node fusermount3; do printf "%s=%s " $b $(command -v $b || echo -); done' | tr '\n' ' ')"
# What the execution host image adds for the box (and nothing else):
SX install -d /root/debs
for f in $L/hostdebs/*.deb; do lxc file push "$f" $S/root/debs/ </dev/null; done
SX sh -c 'dpkg -i /root/debs/*.deb >/dev/null 2>&1; rm -rf /root/debs; dpkg -l bubblewrap sshfs fuse3 | awk "/^ii/{print \$2,\$3}" | tr "\n" " "'
echo
lxc file push "$(command -v node)" $S/usr/bin/node --uid 0 --gid 0 --mode 0755 </dev/null
say "node in the stock host: $(SX /usr/bin/node --version) (missing libraries: $(SX sh -c 'ldd /usr/bin/node | grep -c "not found"'))"
SX rm -rf $P
tar -C /opt -cf - qorpera-c2-proof | lxc exec $S -- tar -C /opt --no-same-owner -xf -
SX sh -c "chown -R root:root $P && chmod -R go-w $P"
SX install -d -o root -g root -m 0755 /opt/qorpera-runner
SX install -o root -g nogroup -m 0750 /usr/bin/unshare /opt/qorpera-runner/qorpera-claude-box-ns
lxc file push "$REPO/deploy/claude-box/qorpera-claude-box-ns.apparmor" $S/etc/apparmor.d/qorpera-claude-box-ns --uid 0 --gid 0 --mode 0644 </dev/null
SX apparmor_parser -r /etc/apparmor.d/qorpera-claude-box-ns
say "stock host after: restrict_unprivileged_userns=$(SX sysctl -n kernel.apparmor_restrict_unprivileged_userns); profile loaded: $(SX sh -c 'aa-status | grep -c qorpera-claude-box-ns'); /dev/fuse: $(SX sh -c 'ls -l /dev/fuse 2>&1')"
lxc file push "$HERE/report.sh" $S/root/report.sh --mode 0700 </dev/null

BR=$(lxc network get lxdbr0 ipv4.address </dev/null | cut -d/ -f1)
G=/var/lib/c2-stock-gw
rm -rf $G
install -d -m 0700 $G
python3 $P/test/gateway.py $C2_HOME "$BR:18555" $G >$G/gateway.out 2>&1 &
GW=$!
for _ in $(seq 1 100); do grep -q READY $G/gateway.out 2>/dev/null && break; sleep 0.1; done
say "gateway on $BR:18555: $(cat $G/gateway.out)"

for MODE in "${MODES[@]}"; do
	SX rm -rf /var/lib/c2-proof
	SX install -d -o 65534 -g 65534 -m 0700 /var/lib/c2-proof
	printf '{"channel": {"kind": "gateway", "host": "%s", "port": 18555}, "namespaceHelper": "/opt/qorpera-runner/qorpera-claude-box-ns", "node": "/usr/bin/node"}\n' "$BR" |
		lxc exec $S -- sh -c 'cat >/var/lib/c2-proof/proof.json && chown 65534:65534 /var/lib/c2-proof/proof.json'
	bash "$HERE/plant.sh" "$MODE"
	lxc exec $C2_HOME -- rm -rf /company/c2-stop /company/c2-alias-link /company/c2-alias-dir </dev/null
	say "STOCK $MODE start"
	SX systemd-run --quiet --pipe --wait --collect --uid=65534 --gid=65534 --working-directory=$P \
		-p NoNewPrivileges=yes -p PrivateDevices=yes -p "DeviceAllow=/dev/fuse rw" -p BindPaths=/dev/fuse \
		-p CapabilityBoundingSet= -p AmbientCapabilities= -p "RestrictNamespaces=user mnt pid net ipc uts cgroup" \
		-p ProtectSystem=strict -p ProtectHome=yes -p ProtectProc=invisible -p ProcSubset=all -p ProtectKernelTunables=no \
		-p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes -p PrivateTmp=yes \
		-p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK" -p TasksMax=512 -p ReadWritePaths=/var/lib/c2-proof \
		-p UMask=0077 /usr/bin/node $P/prove.bundle.mjs "$MODE" "$LABEL-$MODE" 2>&1
	say "STOCK $MODE end rc=$?"
	sleep 2
	SX bash /root/report.sh /var/lib/c2-proof "$LABEL-$MODE" "$MODE"
	echo "=== the stock host after $MODE: sshfs mounts and processes of the proof's account"
	SX sh -c 'n=0; for f in /proc/[0-9]*/mountinfo; do grep -q fuse.sshfs $f 2>/dev/null && n=$((n+1)); done; echo "namespaces with an sshfs mount: $n"; pgrep -u 65534 -a || echo "no process of the proof account"'
	lxc exec $C2_HOME -- sh -c 'systemctl list-units --all --no-legend --plain "qorpera-machine-home-*" | cut -d" " -f1,3,4 | head; pgrep -af "time.sleep.600|sleep 8" | grep -v pgrep || echo "no long command left on the home"' </dev/null
	if [[ $MODE == a6 || $MODE == alias ]]; then
		echo "=== hunt on the home, as root"
		lxc file push $P/test/hunt.py $C2_HOME/root/hunt.py --mode 0700 </dev/null >/dev/null
		lxc exec $C2_HOME -- python3 /root/hunt.py "$LABEL-$MODE" </dev/null
		lxc exec $C2_HOME -- rm -f /root/hunt.py </dev/null
	fi
	echo "=== the stock host's AppArmor refusals during $MODE"
	SX sh -c 'dmesg | grep "apparmor=\"DENIED\"" | grep -v systemd-detect-virt | tail -5 | cut -c1-260'
done
kill -TERM $GW
wait $GW
echo "=== gateway"
tr -d '\n ' <$G/gateway-summary.json
echo
grep -hE '"ev": "(CANARY|error|bad-line)' $G/gateway.jsonl | head -10
rm -rf $G
say "STOCK DONE $LABEL"
