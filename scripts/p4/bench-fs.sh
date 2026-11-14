#!/bin/bash
# P4: the file operations timed three ways: on the home itself (native), in the slot over the home's mount (sshfs over
# the LXD exec channel to sftp-server; with and without the canary tap; with and without follow_symlinks), and on the
# test VM's own disk (the local comparison). Run as root.
set -uo pipefail
P=/home/tester/lanes/agent-box-P4
HERE=$(cd "$(dirname "$0")" && pwd)
[[ -d $P/local/company/tree ]] || bash "$HERE/local-up.sh"
lxc file push "$HERE/fsbench.py" p4-home/tmp/fsbench.py --mode 0644 >/dev/null
echo "load $(cut -d' ' -f1-3 /proc/loadavg)"
lxc exec p4-home -- runuser -u qorpera-agent -- python3 /tmp/fsbench.py /company home-native 5 </dev/null
lxc exec p4-home -- rm -f /tmp/fsbench.py </dev/null
python3 "$HERE/fsbench.py" "$P/local/company" local-disk 5
for v in "--no-tap --no-cx" "--no-cx" "--no-tap --no-cx --follow-symlinks"; do
	L=fsb-$RANDOM; O=$P/out/$L; mkdir -p $O; MNT=/run/p4m-$L
	unshare -m --propagation private -- bash -c "
		mkdir -p $MNT
		python3 $HERE/hostrelay.py p4-home $MNT $P/run/sock-$L $O $v >$O/relay.out 2>&1 & RP=\$!
		for _ in \$(seq 1 200); do grep -q READY $O/relay.out 2>/dev/null && break; sleep 0.1; done
		python3 $HERE/fsbench.py $MNT/company 'mount($v)' 5
		python3 $HERE/fsbench.py $MNT/company 'mount($v)-again' 5
		kill -TERM \$RP; wait \$RP"
	rm -rf $O $P/run/sock-$L
done
