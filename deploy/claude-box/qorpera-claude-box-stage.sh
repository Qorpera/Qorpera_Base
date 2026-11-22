#!/bin/bash
# The mount stage of a Claude Code box (lanes/agent-box-20261113/CLAUDE-HOME-BUILD.md, slice C2).
#
# The run's host starts this as its own unprivileged account inside a user, mount and PID namespace of the run's own
# (qorpera-claude-box-ns, a root-owned util-linux `unshare` that its AppArmor profile lets make a user namespace with
# its capabilities; Ubuntu's own profile denies every capability to anything bwrap starts, and to `unshare`):
#
#   qorpera-claude-box-ns --user --map-current-user --keep-caps --mount --pid --fork --kill-child --mount-proc -- \
#     /bin/bash <this file> <mount point> <sshfs> <sshfs options> -- /usr/bin/bwrap <the box's arguments>
#
# Descriptors: 4 is the home's SFTP stream towards sshfs, 5 is sshfs's towards the home (the run's host carries both
# over the home's file channel), 3 is the made-up or real sign-in for Claude Code when the run has a token (absent
# otherwise). This stage never reads 3; sshfs never gets it.
#
# It mounts the home's whole file system with sshfs (passive mode: the SFTP stream is its stdin and stdout) at the
# mount point, in this namespace only: the run host's own namespace never sees it, nor does any other run. Then it
# drops every capability and starts the box, which binds the home's /company, the agent's home folder and /tmp at
# the same paths. When the box ends, the mount and sshfs end; when the run's host kills this namespace, everything in
# it ends with its first process, and the mount with the namespace.
set -uo pipefail
mnt=${1:?} sshfs=${2:?} options=${3:?}
shift 3
[[ ${1:-} == -- ]] || exit 64
shift
[[ -d $mnt && -x $sshfs && $options =~ ^[a-z_,=0-9]+$ ]] || exit 64
"$sshfs" -f -o "$options" x:/ "$mnt" <&4 >&5 3<&- &
fs=$!
exec 4<&- 5>&-
for _ in $(seq 1 200); do
	mountpoint -q "$mnt" && break
	kill -0 "$fs" 2>/dev/null || break
	sleep 0.05
done
if ! mountpoint -q "$mnt"; then
	echo "qorpera-claude-box: the home's folders did not mount" >&2
	kill "$fs" 2>/dev/null
	exit 70
fi
# What Claude Code's file tools make on the home is the agent's as a local run would make it (0644 / 0755), whatever
# the run host's own service mask is (the company host's is 0077, which made every new file 0600: files1.log).
umask 022
# The prompt is this stage's stdin: given on explicitly, since bash gives a background command /dev/null otherwise.
exec 6<&0
setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "$@" <&6 6<&- &
box=$!
exec 3<&- 6<&- 0</dev/null
wait "$box"
rc=$?
umount -l "$mnt" 2>/dev/null
kill "$fs" 2>/dev/null
# WHY: Bound sshfs teardown wait and fall back to SIGKILL so a wedged SFTP/FUSE process cannot hang a completed run.
for _ in $(seq 1 20); do
	kill -0 "$fs" 2>/dev/null || break
	sleep 0.05
done
kill -9 "$fs" 2>/dev/null
wait "$fs" 2>/dev/null
exit "$rc"
