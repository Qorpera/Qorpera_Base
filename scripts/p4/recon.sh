#!/bin/bash
# P4 recon on the test VM (read only): tools, versions, LXD state, Claude Code in npm's cache.
set -u
echo "host=$(hostname) kernel=$(uname -r) load=$(cut -d' ' -f1-3 /proc/loadavg) memavail_gib=$(awk '/MemAvailable/{printf "%.1f", $2/1048576}' /proc/meminfo) nproc=$(nproc)"
df -h / /home | tail -2
for b in bwrap sshfs socat python3 node npm lxc fusermount3 fusermount rg git unshare nsenter setpriv; do printf '%s=%s\n' $b "$(command -v $b || echo -)"; done
ls -la /dev/fuse; dpkg -l | grep -E "fuse|sshfs|openssh-sftp|bubblewrap|socat|python3-fuse" | awk '{print $2,$3}'
ls /usr/lib/openssh/ 2>&1
sysctl kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone 2>&1
ls -la /opt/qorpera-codex-fence/ 2>&1 | head
sha256sum /opt/qorpera-codex-fence/codex 2>&1 | cut -c1-16
echo "--- lxc"
sudo -n lxc project list -f csv 2>&1 | head; sudo -n lxc list --all-projects -f csv -c n,s,t 2>&1 | head -20
sudo -n lxc image list --all-projects -f csv -c l,f,d,s 2>&1 | head -20
sudo -n lxc storage list -f csv 2>&1; sudo -n lxc network list -f csv 2>&1 | head
echo "--- npm cache for claude-code"
grep -rl '"name":"@anthropic-ai/claude-code' ~/.npm/_cacache/index-v5 2>/dev/null | head -3
ls ~/.npm/_cacache 2>&1 | head
timeout 30 npm view @anthropic-ai/claude-code dist-tags --json 2>&1 | head -20
timeout 30 npm view @anthropic-ai/claude-code@latest optionalDependencies --json 2>&1 | head -20
echo "--- pip"
python3 -c "import fuse" 2>&1; python3 -c "import pyfuse3" 2>&1
apt-cache policy sshfs openssh-sftp-server 2>&1 | head -12
