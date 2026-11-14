#!/bin/bash
# P4 last run: the hunt on the home once more, now with its raw disk (deleted temp files included), then the cleanup by
# exact names: the nested VM p4-home, the lane folder, the empty mount points this proof made under /run.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
P=/home/tester/lanes/agent-box-P4
lxc file push "$HERE/hunt.py" p4-home/root/hunt.py --mode 0700 >/dev/null
lxc exec p4-home -- python3 /root/hunt.py final --disk </dev/null
echo "git as Claude Code ran it in the box: $(grep -ho 'execve("/usr/bin/git", \[[^]]*\]' $P/out/*/out/strace.txt 2>/dev/null | head -1)"
lxc delete --force p4-home </dev/null && echo "deleted p4-home"
lxc list -f csv -c n </dev/null | grep -x p4-home || echo "p4-home gone"
for l in r1 r2 s1 s2 f1 b1 b1local b2 b2local a1 a1b a2 a3 both1 both2 both3 v311s v311f v311a pd-21325-deny pd-21325-min pd-21311-deny pd-21311-min; do
	[[ -d /run/p4m-$l ]] && rmdir /run/p4m-$l 2>/dev/null
done
ls -d /run/p4m-* 2>/dev/null | while read -r d; do rmdir "$d" 2>/dev/null && echo "removed $d"; done
rm -rf /home/tester/lanes/agent-box-P4 && echo "removed /home/tester/lanes/agent-box-P4"
ls -d /run/p4m-* /home/tester/lanes/agent-box-P4 2>&1 | head
