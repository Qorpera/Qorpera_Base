#!/bin/bash
# P4: the local comparison's copy of the home's 5,000-file tree, on the test VM's own disk (owned by the box's user).
set -euo pipefail
P=/home/tester/lanes/agent-box-P4
rm -rf $P/local; install -d -m 0755 $P/local; install -d -o nobody -g nogroup -m 0755 $P/local/company
lxc exec p4-home -- tar -C /company -cf - tree </dev/null | tar -C $P/local/company -xf -
chown -R nobody:nogroup $P/local/company
echo "local tree: $(find $P/local/company/tree -type f | wc -l) files, $(du -sh $P/local/company/tree | cut -f1)"
