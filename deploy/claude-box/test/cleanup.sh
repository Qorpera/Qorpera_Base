#!/bin/bash
# C2 proof cleanup on the test VM, as root, by exact names: the nested home, the driver's parts, the runs' folder, the
# gateway's socket folder, the lane folder (Claude Code and sshfs as fetched). Nothing was installed with apt.
set -u
lxc delete --force c2-home </dev/null 2>/dev/null && echo "deleted c2-home"
lxc list -f csv -c n </dev/null | grep -x c2-home || echo "c2-home gone"
rm -rf /opt/qorpera-c2-proof /var/lib/c2-proof /run/c2-gw /home/tester/lanes/agent-box-C2
ls -d /opt/qorpera-c2-proof /var/lib/c2-proof /run/c2-gw /home/tester/lanes/agent-box-C2 2>&1 | sed 's/^/left: /'
