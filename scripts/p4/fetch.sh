#!/bin/bash
# P4: fetch Claude Code (unmodified, from npm) and sshfs (a .deb, unpacked, not installed) into the lane's own folder
# on the test VM. Run as root through run-on-node --sudo.
set -euo pipefail
P=/home/tester/lanes/agent-box-P4
install -d -m 0755 $P $P/cc $P/pkg
cd $P/pkg
for v in 2.1.325 2.1.311; do
	if [[ ! -x $P/cc/$v/claude ]]; then
		rm -rf "$P/pkg/cc-$v"; mkdir -p "$P/pkg/cc-$v"; cd "$P/pkg/cc-$v"
		npm pack --silent "@anthropic-ai/claude-code-linux-x64@$v" >/dev/null
		tar xzf ./*.tgz
		install -d -m 0755 $P/cc/$v
		f=$(find package -type f -name claude | head -1)
		install -m 0555 "$f" $P/cc/$v/claude
		cd $P/pkg
	fi
	echo "cc $v: $(sha256sum $P/cc/$v/claude | cut -c1-16) $(stat -c %s $P/cc/$v/claude) B; $($P/cc/$v/claude --version 2>&1 | head -1)"
	ls "$P/pkg/cc-$v/package" 2>/dev/null | tr '\n' ' '; echo
	npm view "@anthropic-ai/claude-code-linux-x64@$v" dist.integrity 2>/dev/null
done
if [[ ! -x $P/sshfs/usr/bin/sshfs ]]; then
	cd $P/pkg; rm -f sshfs_*.deb; apt-get download sshfs >/dev/null 2>&1; dpkg -x sshfs_*.deb $P/sshfs
fi
echo "sshfs: $($P/sshfs/usr/bin/sshfs --version 2>&1 | head -2 | tr '\n' ' ')"; ldd $P/sshfs/usr/bin/sshfs | grep -c "not found" || true
command -v strace bpftrace perf || true
file /usr/lib/openssh/sftp-server; ldd /usr/lib/openssh/sftp-server
echo "--- env names in 2.1.325"
strings -n 8 $P/cc/2.1.325/claude | grep -oE '\b(CLAUDE_CODE|CLAUDE|ANTHROPIC)_[A-Z0-9_]+' | sort -u > $P/envnames-2.1.325.txt
wc -l < $P/envnames-2.1.325.txt
grep -E 'SHELL|TMP|TEMP|GIT|RIPGREP|FILE_DESC|SANDBOX|REMOTE|CWD|SNAPSHOT|SCRUB|BASH' $P/envnames-2.1.325.txt | tr '\n' ' '; echo
strings -n 8 $P/cc/2.1.311/claude | grep -oE '\b(CLAUDE_CODE|CLAUDE|ANTHROPIC)_[A-Z0-9_]+' | sort -u > $P/envnames-2.1.311.txt
echo "only in 325: $(comm -13 $P/envnames-2.1.311.txt $P/envnames-2.1.325.txt | tr '\n' ' ')"
echo "only in 311: $(comm -23 $P/envnames-2.1.311.txt $P/envnames-2.1.325.txt | tr '\n' ' ')"
strings -n 6 $P/cc/2.1.325/claude | grep -E 'USE_BUILTIN_RIPGREP|vendor/ripgrep|shell-snapshots|claude-[a-z0-9]*-cwd|-cwd"' | head -10
