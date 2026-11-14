#!/bin/bash
# C2 proof cleanup on the test VM, as root, by exact names: the nested home, the driver's parts, the runs' folder, the
# gateway's socket folder, the lane folder (Claude Code and sshfs as fetched). Nothing was installed with apt.
set -u
for H in qorpera-machine-c2e000000000400080000000000000d2 c2-host c2-home; do
	lxc delete --force $H </dev/null 2>/dev/null && echo "deleted $H"
	lxc list -f csv -c n </dev/null | grep -x $H || echo "$H gone"
done
rm -rf /opt/qorpera-c2-proof /var/lib/c2-proof /run/c2-gw /home/tester/lanes/agent-box-C2
ls -d /opt/qorpera-c2-proof /var/lib/c2-proof /run/c2-gw /home/tester/lanes/agent-box-C2 2>&1 | sed 's/^/left: /'
