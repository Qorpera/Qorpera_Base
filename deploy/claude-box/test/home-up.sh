#!/bin/bash
# C2 (P4's home-up.sh): make the agent's home, a throwaway nested VM `c2-home` on the test VM (default project, cached Ubuntu 26.04
# minimal image), with the home's lines of deploy/machine/build-machine-image.sh that matter here: the agent account
# qorpera-agent (uid 2000, passwordless sudo, its own Codex home), the pinned Codex at /opt/qorpera-machine/codex,
# /company owned by the agent; plus the one new thing the home needs for Claude Code's file tools: OpenSSH's
# sftp-server (copied from the test VM's own package, same Ubuntu release). And a tree of 5,000 files to measure on.
# Run as root through run-on-node --sudo. Idempotent: an existing c2-home is reused.
set -euo pipefail
H=${C2_HOME:-qorpera-machine-c2e000000000400080000000000000d2}
HERE=$(cd "$(dirname "$0")" && pwd)
L() { lxc "$@" </dev/null; }
X() { lxc exec $H -- "$@" </dev/null; }
if ! L info $H >/dev/null 2>&1; then
	t0=$(date +%s.%N)
	L init nested-probe-image $H --vm -c limits.cpu=2 -c limits.memory=3GiB -d root,size=12GiB -c boot.autostart=false >/dev/null
	L start $H
	for _ in $(seq 1 300); do X systemctl is-active --quiet basic.target 2>/dev/null && break; sleep 1; done
	echo "home made and booted in $(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.1f", a-b}') s"
fi
X systemctl is-system-running --wait >/dev/null 2>&1 || true
echo "home: $(X sh -c 'echo $(hostname) $(uname -r) $(. /etc/os-release; echo $PRETTY_NAME); nproc; free -m | awk "/Mem/{print \$2\" MiB\"}"' | tr '\n' ' ')"
# The home's lines of build-machine-image.sh (the agent account, its sudo rule, its Codex home, the pinned Codex)
X sh -c 'getent group qorpera-agent >/dev/null || groupadd --gid 2000 qorpera-agent; id qorpera-agent >/dev/null 2>&1 || useradd --uid 2000 --gid 2000 --home-dir /var/lib/qorpera-agent --create-home --shell /bin/bash qorpera-agent; install -d -o qorpera-agent -g qorpera-agent -m 0700 /var/lib/qorpera-agent/.codex; install -d -o qorpera-agent -g qorpera-agent -m 0755 /company; install -d -m 0755 /opt/qorpera-machine'
L file push "$HERE/../../machine/qorpera-agent.sudoers" $H/etc/sudoers.d/qorpera-agent --uid 0 --gid 0 --mode 0440
if [[ "$(X sh -c 'sha256sum /opt/qorpera-machine/codex 2>/dev/null | cut -c1-16')" != 9d6a86ec6e280e43 ]]; then
	L file push /opt/qorpera-codex-fence/codex $H/opt/qorpera-machine/codex --uid 0 --gid 0 --mode 0555
fi
X sh -c 'command -v sudo >/dev/null' || echo "WARN: no sudo in the home image"
# The new piece for Claude Code's file tools: sftp-server (one binary, needs only libc)
X test -x /usr/lib/openssh/sftp-server || { X install -d -m 0755 /usr/lib/openssh; L file push /usr/lib/openssh/sftp-server $H/usr/lib/openssh/sftp-server --uid 0 --gid 0 --mode 0755; }
# ripgrep, as the machine image has it (Grep and Glob run it on the home through the box's rg bridge)
if ! X sh -c 'command -v rg >/dev/null'; then
	d=$(mktemp -d); (cd "$d" && apt-get download ripgrep >/dev/null 2>&1); L file push "$d"/ripgrep_*.deb $H/root/ripgrep.deb
	X sh -c 'dpkg -i /root/ripgrep.deb >/dev/null && rm -f /root/ripgrep.deb'; rm -rf "$d"
fi
echo "home holds: codex $(X sh -c 'sha256sum /opt/qorpera-machine/codex | cut -c1-16'), sftp-server $(X sh -c 'sha256sum /usr/lib/openssh/sftp-server | cut -c1-16; stat -c %s /usr/lib/openssh/sftp-server' | tr '\n' ' ')B, sudo rule: $(X runuser -u qorpera-agent -- sudo -n id -u)"
echo "home tools: $(X sh -c 'for b in python3 git rg grep find bash sudo systemd-run; do printf "%s=%s " $b $(command -v $b || echo -); done')"
# The 5,000-file tree: 50 folders x 100 files, about 2 KB each; 37 hold the needle
X runuser -u qorpera-agent -- python3 -c '
import os, random
random.seed(4)
root = "/company/tree"
if not os.path.exists(root + "/d49/f099.txt"):
    for d in range(50):
        os.makedirs(f"{root}/d{d:02d}", exist_ok=True)
        for f in range(100):
            lines = [" ".join(random.choice(["alpha","beta","gamma","delta","omega","pi","rho","sigma"]) for _ in range(12)) for _ in range(30)]
            if (d * 100 + f) % 135 == 7:
                lines[17] = "the P4NEEDLE is here"
            open(f"{root}/d{d:02d}/f{f:03d}.txt", "w").write("\n".join(lines) + "\n")
n = sum(len(fs) for _, _, fs in os.walk(root)); print("tree files", n)
'
X runuser -u qorpera-agent -- sh -c 'grep -rl P4NEEDLE /company/tree | wc -l; du -sh /company/tree'
