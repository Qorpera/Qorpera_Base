#!/usr/bin/env python3
"""Disposable nested-VM proof of option (c') for F3 4d, "Who makes the namespaces".

A command's shell (a stand-in for the office's bwrap sandbox, under the office unit's own confinement) holds its
namespaces. The folder helper's per-command child A, root in the initial user namespace under the helper unit's own
confinement, pins the command's company tree, moves itself into the shell's cgroup, joins the shell's mount, pid, uts,
ipc and cgroup namespaces (and its network namespace for a networked command) with setns, and forks B into the shell's
pid namespace. B chroots into the shell's root, unshares a mount namespace (and a network namespace for an offline
command; both owned by the initial user namespace), brings lo up for an offline command, attaches the company tree at
/run/qorpera-company with fd-based mounts, and closes every fd but stdio and the shell's user-namespace fd. Still root
in the initial user namespace, it drops to the office account with no capabilities; then it joins the shell's user
namespace (the office account owns it, so an unprivileged setns is allowed), where it is a member and not the parent,
so the owner rule gives it nothing. There it drops the bounding set to the shell's, locks SECBIT_NOROOT, sets its
capabilities to zero, sets no-new-privs, adds a seccomp filter (no CLONE_NEWUSER, no clone3, no setns, the office's
address families only), starts in /company and execs the command. A is the only process that joins the shell's
namespaces as root, and it never joins the user namespace; B joins the user namespace only after it is unprivileged.

Each mode runs twice. Kind "fixture" runs this file's A and B, which report B's state at each step. Kind "launcher"
runs the real launcher in their place, `qorpera-folder command`, started as the folder helper starts it (the command's
stdio on fds 0 to 2, its reports on fd 3), and checks the same command from outside and from inside.

This closes the owner-rule gap round 1 found (c' amendment, coordinator 15 Oct): under plain (c) the command ran as the
office account in the initial user namespace, the *parent* of the shell's, so user_namespaces(7) rule 3 gave it every
capability over the namespaces the shell's user namespace owns -- zero cap sets notwithstanding. (c') makes it a member
of the shell's user namespace instead, like the shell's own commands, so no rule applies.

State only, no attack code (coordinator, 14 Oct), and no live attempt to change the filter or to join a namespace
from the command (15 Oct): the setns refusal is shown on the installed program, and live with setns(-1, 0), which
names no namespace (the filter answers EPERM; without it the kernel answers EBADF). A synthetic protocol-3 node backs a
real qorpera-folder mount. The shell and the starter run under keys copied from the real office and helper unit
files, and a networked command's namespace gets the real plumb's veth, address, route and filter. No SQL, model,
vsock provenance or production request authorization is claimed.
"""
import os
import sys

# A command's fds as it came across exec, listed before the imports below run: ctypes and the others may open fds of
# their own. The listing's own is the fourth. Each one's target too, so a check that fails says what was left open.
if sys.argv[1:2] == ["command"]:
    EXEC_FDS = sorted(int(name) for name in os.listdir("/proc/self/fd"))
    EXEC_FD_TARGETS = {}
    for _fd in EXEC_FDS:
        try:
            EXEC_FD_TARGETS[str(_fd)] = os.readlink(f"/proc/self/fd/{_fd}")
        except OSError:
            EXEC_FD_TARGETS[str(_fd)] = "closed"

import ctypes
import errno
import fcntl
import hashlib
import json
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time

LIBC = ctypes.CDLL(None, use_errno=True)

# prctl, namespace, mount and syscall numbers (x86_64; the seccomp filter refuses any other architecture).
PR_SET_DUMPABLE = 4
PR_SET_KEEPCAPS = 8
PR_CAPBSET_DROP = 24
PR_GET_SECUREBITS = 27
PR_SET_SECUREBITS = 28
PR_SET_NO_NEW_PRIVS = 38
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_CLEAR_ALL = 4
# SECBIT_NOROOT | SECBIT_NOROOT_LOCKED: a uid-0 exec gains no capabilities, and the bit can't be cleared. Setting it
# needs CAP_SETPCAP, so B sets it while it still holds that capability, before capset to zero (the coordinator's (c')
# order says the NOROOT bits then capset; the kernel forces this sub-order).
SECBIT_NOROOT = 1 << 0
SECBIT_NOROOT_LOCKED = 1 << 1
SECUREBITS_LOCKED_NOROOT = SECBIT_NOROOT | SECBIT_NOROOT_LOCKED
CLONE_NEWNS = 0x00020000
CLONE_NEWUSER = 0x10000000
CLONE_NEWNET = 0x40000000
NR = {"socket": 41, "clone": 56, "unshare": 272, "setns": 308, "seccomp": 317, "open_tree": 428, "move_mount": 429,
      "clone3": 435, "close_range": 436, "mount_setattr": 442}
OPEN_TREE_CLONE = 1
AT_FDCWD = -100
AT_EMPTY_PATH = 0x1000
AT_RECURSIVE = 0x8000
MOVE_MOUNT_F_EMPTY_PATH = 0x04
MOVE_MOUNT_T_EMPTY_PATH = 0x40
MS_REC = 0x4000
MS_PRIVATE = 0x40000
MS_SLAVE = 0x80000
NS_GET_USERNS = 0xB701
NS_GET_PARENT = 0xB702
NS_GET_OWNER_UID = 0xB704
SIOCGIFFLAGS = 0x8913
SIOCSIFFLAGS = 0x8914
IFF_UP = 0x1
CAPSET_V3 = 0x20080522
AUDIT_ARCH_X86_64 = 0xC000003E
X32_SYSCALL_BIT = 0x40000000
# The office account's own families (qorpera-company-computer.service RestrictAddressFamilies); a command keeps these.
AF_UNIX, AF_INET, AF_INET6, AF_PACKET, AF_NETLINK, AF_VSOCK = 1, 2, 10, 17, 16, 40  # Linux numbers
OFFICE_FAMILIES = (AF_UNIX, AF_INET, AF_INET6, AF_NETLINK)
# The folder protocol of crates/qorpera-folder/src/proto.rs; the program refuses a hello answered with another.
PROTOCOL = 3
# The paths inside the shell's root: the company mount's parent (as a desktop binds it), the share the shell and the
# command write their records to, and the fixture itself.
COMPANY_PARENT = "/run/qorpera-company"
SHARE = "/qorpera-share"
PROBE = "/qorpera-probe.py"


def checked(result, label):
    if result != 0:
        err = ctypes.get_errno()
        raise OSError(err, f"{label}: {os.strerror(err)}")
    return result


def syscall(name, *args):
    ctypes.set_errno(0)
    result = LIBC.syscall(ctypes.c_long(NR[name]), *args)
    if result < 0:
        err = ctypes.get_errno()
        raise OSError(err, f"{name}: {os.strerror(err)}")
    return result


def run(*args, check=True, timeout=20):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout).stdout.strip()


def eventually(check, seconds=15):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError) as error:
            last = error
        time.sleep(0.05)
    raise TimeoutError(f"condition did not settle ({last!r})")


def emit(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value))
    temp.replace(path)


def await_record(folder, name, phase, seconds=25):
    def check():
        target = folder / f"{name}-{phase}.json"
        if target.exists():
            return json.loads(target.read_text())
        done = folder / f"{name}-done.json"
        if done.exists():
            raise RuntimeError(f"{name} ended before {phase}: {json.loads(done.read_text()).get('error')}")
        return None
    return eventually(check, seconds)


def status(pid="self"):
    return dict(line.split(":\t", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines() if ":\t" in line)


CAP_KEYS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")


def caps_of(pid="self"):
    s = status(pid)
    return {**{key: s[key] for key in CAP_KEYS}, "NoNewPrivs": s["NoNewPrivs"]}


def ns_links(pid="self"):
    return {name: os.readlink(f"/proc/{pid}/ns/{name}") for name in ("user", "mnt", "pid", "net", "uts", "ipc", "cgroup")}


def ns_owner(pid, name):
    """Who owns a process's namespace: the owning user namespace (NS_GET_USERNS) and that user namespace's owner uid
    (NS_GET_OWNER_UID, valid only on a user-namespace fd). NS_GET_USERNS answers EPERM when the owner is neither the
    caller's own user namespace nor a descendant of it, so from inside a nested user namespace this records the errno
    instead; the owner reads that back (c') are all made from the guest's initial user namespace, where they resolve."""
    fd = os.open(f"/proc/{pid}/ns/{name}", os.O_RDONLY)
    try:
        try:
            owner = fcntl.ioctl(fd, NS_GET_USERNS)
        except OSError as error:
            return {"error": errno.errorcode.get(error.errno, error.errno)}
        try:
            uid = struct.unpack("I", fcntl.ioctl(owner, NS_GET_OWNER_UID, bytes(4)))[0]
            return {"userns": f"user:[{os.fstat(owner).st_ino}]", "uid": uid}
        finally:
            os.close(owner)
    finally:
        os.close(fd)


def ns_owners(pid="self"):
    return {name: ns_owner(pid, name) for name in ("mnt", "pid", "net", "uts", "ipc", "cgroup")}


def userns_chain(pid):
    """A process's own user namespace and every ancestor up to the caller's, as `user:[inode]` strings, by walking
    NS_GET_PARENT until it answers EPERM (the caller's own user namespace is the top it may see). Outside only: the
    owner rule holds when the user namespace that owns one of the command's namespaces is in this chain -- the command
    is a member of it or a descendant, never its parent (where rule 3 would hand the command every capability)."""
    fd = os.open(f"/proc/{pid}/ns/user", os.O_RDONLY)
    chain = []
    try:
        while True:
            chain.append(f"user:[{os.fstat(fd).st_ino}]")
            try:
                parent = fcntl.ioctl(fd, NS_GET_PARENT)
            except OSError as error:
                if error.errno in (errno.EPERM, errno.ENOENT):
                    break
                raise
            os.close(fd)
            fd = parent
    finally:
        os.close(fd)
    return chain


def get_securebits():
    ctypes.set_errno(0)
    value = LIBC.prctl(PR_GET_SECUREBITS, 0, 0, 0, 0)
    if value < 0:
        err = ctypes.get_errno()
        raise OSError(err, f"PR_GET_SECUREBITS: {os.strerror(err)}")
    return value


def propagation(mountinfo, point):
    """The optional fields (shared:N, master:N) of the mount at `point` in a mountinfo text; the last one wins."""
    found = None
    for line in mountinfo.splitlines():
        fields = line.split(" ")
        if fields[4] == point:
            found = [field for field in fields[6:fields.index("-")] if ":" in field]
    return found


def receive(conn):
    def exact(n):
        result = bytearray()
        while len(result) < n:
            part = conn.recv(n - len(result))
            if not part:
                raise EOFError()
            result.extend(part)
        return bytes(result)
    size = struct.unpack(">I", exact(4))[0]
    if not 1 <= size <= 2 * 1024 * 1024 + 1:
        raise ValueError("invalid folder frame")
    data = exact(size)
    return chr(data[0]), data[1:]


def send(conn, kind, value):
    body = value if isinstance(value, bytes) else json.dumps(value).encode()
    conn.sendall(struct.pack(">I", len(body) + 1) + kind.encode() + body)


class FolderNode:
    """A deliberately small writable stand-in, matching crates/.../tests/support, enough for a command to read /company
    and write back. A write hands over its reads as a consecutive prefix, as the operator view does."""
    def __init__(self, path):
        self.files = {"before.txt": b"before"}
        self.handles = {}
        self.logs = {}
        self.lock = threading.Lock()
        self.errors = []
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path))
        self.listener.listen()
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn):
        try:
            with conn:
                kind, body = receive(conn)
                hello = json.loads(body)
                assert kind == "H" and hello["protocol"] == PROTOCOL and hello["pass"] == "synthetic-pass"
                send(conn, "h", {"protocol": PROTOCOL, "viewId": hello["viewId"], "asOfSeq": 0, "readOnly": False})
                while True:
                    kind, body = receive(conn)
                    if kind == "a":
                        continue
                    with self.lock:
                        if kind == "K":
                            n = struct.unpack(">I", body[:4])[0]
                            h = json.loads(body[4:4 + n])
                            value = body[4 + n:]
                            assert h["index"] == 0 and h["offset"] == 0 and len(value) == h["bytes"]
                            self.handles[h["handle"]][1] = value
                            send(conn, "k", {})
                            continue
                        q = json.loads(body)
                        if kind == "I":
                            reads = q["reads"]
                            taken = self.logs.get(q["log"], reads[0]["seq"] - 1 if reads else 0)
                            for read in reads:
                                if read["seq"] <= taken:
                                    continue
                                assert read["seq"] == taken + 1
                                taken = read["seq"]
                            self.logs[q["log"]] = taken
                            send(conn, "i", {"log": q["log"], "taken": taken, "released": taken})
                        elif kind == "L":
                            assert q["path"] == ""
                            send(conn, "l", {"entries": [{"name": name, "kind": "file", "size": len(value), "mtimeMs": 1700000000000, "executable": False, "version": "v1"} for name, value in sorted(self.files.items())], "next": None})
                        elif kind == "R":
                            value = self.files[q["path"]]
                            send(conn, "d", value[q["offset"]:q["offset"] + q["length"]])
                        elif kind == "O":
                            name = q["path"]
                            if q["exclusive"] and name in self.files:
                                send(conn, "e", {"code": "EXISTS", "message": ""})
                                continue
                            value = b"" if q["truncate"] else self.files.get(name, b"")
                            handle = max(self.handles, default=0) + 1
                            self.handles[handle] = [name, value]
                            self.files.setdefault(name, b"")
                            send(conn, "o", {"handle": handle, "size": len(value), "version": "v1"})
                        elif kind == "C":
                            name, value = self.handles.pop(q["handle"])
                            assert len(value) == q["size"]
                            self.files[name] = value
                            send(conn, "k", {"version": "v2"})
                        elif kind == "G":
                            value = self.handles[q["handle"]][1]
                            send(conn, "d", value[q["offset"]:q["offset"] + q["length"]])
                        elif kind == "P":
                            send(conn, "p", {"commitId": "synthetic", "seq": 0, "paths": []})
                        else:
                            raise ValueError(f"unsupported fixture operation {kind}")
        except (EOFError, BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.errors.append(repr(error))


SCOPE = re.compile(r"/run/qorpera-cmdns-[a-f0-9-]{36}")


def require_disposable_guest(directory):
    if os.geteuid() != 0 or run("systemd-detect-virt", "--vm", check=False) != "kvm":
        raise RuntimeError("A root process inside a nested KVM guest is required")
    if Path("/etc/qorpera-test-machine-versions").exists():
        raise RuntimeError("Never run this fixture on the shared test VM")
    if not SCOPE.fullmatch(str(directory)):
        raise RuntimeError("Refusing a path outside the UUID-scoped probe directory")


# companyComputerLinuxSandboxArgs (cloud-company-computer-linux-host.ts); office-command-namespaces.test.mjs keeps the
# two equal.
def sandbox_args(tmp_bytes):
    return [
        "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
        "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session",
        "--cap-drop", "ALL", "--clearenv",
        "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--size", str(tmp_bytes), "--tmpfs", "/tmp",
    ]


# The confinement keys copied from each real unit file by name: #1007's set for the office (plus how it stops), and the
# helper's own. Operational keys (ExecStart, Requires, Environment) are not copied.
OFFICE_KEYS = {"User", "Group", "UMask", "LimitCORE", "PrivateTmp", "PrivateDevices", "ProtectSystem", "ProtectHome",
               "ProtectProc", "ProcSubset", "ProtectHostname", "ProtectClock", "ProtectKernelTunables",
               "ProtectKernelLogs", "ProtectKernelModules", "ProtectControlGroups", "NoNewPrivileges",
               "CapabilityBoundingSet", "AmbientCapabilities", "RestrictNamespaces", "RestrictAddressFamilies",
               "RestrictSUIDSGID", "LockPersonality", "MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuota",
               "InaccessiblePaths", "KillMode", "TimeoutStopSec"}
HELPER_KEYS = {"UMask", "LimitCORE", "NoNewPrivileges", "CapabilityBoundingSet", "DevicePolicy", "DeviceAllow",
               "RestrictAddressFamilies", "RestrictSUIDSGID", "RestrictRealtime", "LockPersonality",
               "SystemCallArchitectures"}


def unit_properties(text, keys):
    return [line for line in text.splitlines() if line.split("=", 1)[0] in keys]


# The computer filter qorpera-computer-plumb loads into a networked namespace; office-command-namespaces.test.mjs keeps
# it equal to the plumb's heredoc.
PLUMB_TABLE = """table inet qorpera_computer {
	set blocked {
		type ipv4_addr
		flags interval
		elements = {
			0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
			192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15,
			198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4
		}
	}
	chain output {
		type filter hook output priority filter; policy accept;
		oifname "lo" accept
		meta nfproto ipv6 drop
		ip daddr 10.210.0.1 udp dport 53 accept
		ip daddr 10.210.0.1 tcp dport 53 accept
		ip daddr @blocked drop
	}
}
"""
HOST_IP = "10.253.9.1"
PEER_IP = "10.253.9.2"
DNS_IP = "10.210.0.1"


def office_ids():
    record = pwd.getpwnam("qorpera-office")
    return record.pw_uid, record.pw_gid


def start_unit(unit, properties, argv):
    """Start argv as its own transient service under the given unit keys, as the real units run, and return its main
    pid. Each actor gets its own cgroup."""
    command = ["systemd-run", "--quiet", "--collect", "--unit", unit, "--property", "Type=exec"]
    for prop in properties:
        command += ["--property", prop]
    subprocess.run([*command, "--", *argv], check=True, timeout=30)
    return eventually(lambda: int(run("systemctl", "show", "--value", "--property", "MainPID", unit)) or None, 20)


def unit_gone(unit):
    return run("systemctl", "show", "--value", "--property", "ActiveState", unit, check=False) in ("inactive", "failed", "")


# --- The shell: a stand-in for the office's sandbox, holding its namespaces, with the company mount's parent laid out
# as a desktop lays it out (cloud-company-computer-linux-desktop.ts: the parent dir, and /company a symlink into it). ---
SHELL_SCRIPT = r"""
set -eu
printf 'shell\n' > /tmp/shell-marker
/usr/bin/python3 /qorpera-probe.py shell-state
printf '{"ready": true}\n' > /qorpera-share/shell-ready.json.tmp
mv /qorpera-share/shell-ready.json.tmp /qorpera-share/shell-ready.json
while :; do /usr/bin/sleep 1; done
"""


def shell_state_main():
    """One of the shell's own commands records what such a command is: the target a command the helper starts must
    equal (its user namespace, ids, maps, capabilities and securebits)."""
    emit(Path(SHARE) / "shell-state.json", {
        "uid": list(os.getresuid()), "gid": list(os.getresgid()), "groups": os.getgroups(),
        "uidMap": Path("/proc/self/uid_map").read_text().split("\n")[:-1],
        "gidMap": Path("/proc/self/gid_map").read_text().split("\n")[:-1],
        "ns": ns_links(), "caps": caps_of(), "securebits": get_securebits()})


def start_shell(directory, share, office_unit):
    args = ["/usr/bin/bwrap", "--as-pid-1", *sandbox_args(512 * 1024 * 1024),
            "--dir", COMPANY_PARENT, "--dir", f"{COMPANY_PARENT}/company", "--symlink", f"{COMPANY_PARENT}/company", "/company",
            "--bind", str(share), SHARE, "--ro-bind", str(directory / "probe.py"), PROBE,
            "--chdir", "/", "--remount-ro", "/",
            # As the shell host starts it (cloud-company-computer-linux-process.ts): tini is the namespace's pid 1.
            "--", "/usr/bin/tini", "-p", "SIGKILL", "--",
            "/usr/bin/bash", "--noprofile", "--norc", "-c", SHELL_SCRIPT, "qorpera-office-shell"]
    properties = unit_properties(office_unit, OFFICE_KEYS) + [f"ReadWritePaths={directory}", "RuntimeMaxSec=170"]
    leader = start_unit("qorpera-cmdns-shell", properties, args)
    eventually(lambda: (share / "shell-ready.json").exists(), 25)

    # bwrap (the unit's main pid) execs nothing; its one child is tini, pid 1 of the shell's pid namespace, the pid the
    # shell host hands the helper.
    def shell_init():
        for entry in Path("/proc").iterdir():
            if entry.name.isdigit():
                try:
                    if int(status(entry.name)["PPid"]) == leader and b"qorpera-office-shell" in Path(entry, "cmdline").read_bytes():
                        return int(entry.name)
                except (OSError, KeyError):
                    continue
        return None
    return {"unit": "qorpera-cmdns-shell", "leader": leader, "pid": eventually(shell_init, 15), "properties": properties,
            "state": json.loads((share / "shell-state.json").read_text())}


def plumb_networked(shell_pid):
    """What qorpera-computer-plumb does to a shell's namespace, inside this guest: a veth pair with eth0 in the shell's
    namespace, the real filter first, then IPv6 off, the address, the route and ping. No NIC of the guest is touched."""
    host = "qcmp9s"
    run("ip", "link", "add", host, "type", "veth", "peer", "name", "eth0", "netns", str(shell_pid))
    run("ip", "addr", "add", f"{HOST_IP}/30", "dev", host)
    run("ip", "link", "set", host, "up")
    nft = subprocess.run(["nsenter", "-t", str(shell_pid), "-n", "nft", "-f", "-"], input=PLUMB_TABLE, text=True, capture_output=True, timeout=20)
    if nft.returncode != 0:
        raise RuntimeError(f"loading the computer filter failed: {nft.stderr.strip()}")
    for args in (["sysctl", "-q", "-w", "net.ipv6.conf.eth0.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1"],
                 ["ip", "addr", "add", f"{PEER_IP}/30", "dev", "eth0"],
                 ["ip", "link", "set", "eth0", "up"],
                 ["ip", "route", "add", "default", "via", HOST_IP],
                 ["sysctl", "-q", "-w", "net.ipv4.ping_group_range=0 2147483647"]):
        run("nsenter", "-t", str(shell_pid), "-n", *args)


# --- The command: it records its own state, then holds until a stop ends it. No attack on any process. ---
def command_main(mode):
    share = Path(SHARE)
    child = os.fork()
    if child == 0:
        # A setsid child: its own session and process group, so only the cgroup or the pid namespace can reach it.
        os.setsid()
        while True:
            time.sleep(1)
    s = status()
    record = {"execFds": EXEC_FDS, "execFdTargets": EXEC_FD_TARGETS, "pid": os.getpid(), "setsidChild": child,
              "uid": list(os.getresuid()), "gid": list(os.getresgid()), "groups": os.getgroups(),
              "uidMap": Path("/proc/self/uid_map").read_text().split("\n")[:-1],
              "gidMap": Path("/proc/self/gid_map").read_text().split("\n")[:-1],
              "caps": caps_of(), "securebits": get_securebits(),
              "seccomp": s["Seccomp"], "seccompFilters": s.get("Seccomp_filters"),
              # Read from inside, the owners answer EPERM: none of them is the command's user namespace or one below
              # it. The owner rule is checked on the probe's reading from the initial user namespace.
              "ns": ns_links(), "nsOwner": ns_owners(),
              "lsm": Path("/proc/self/attr/current").read_text().strip(),
              "cwd": os.readlink("/proc/self/cwd"),
              "propagation": {point: propagation(Path("/proc/self/mountinfo").read_text(), point) for point in (COMPANY_PARENT, f"{COMPANY_PARENT}/company")}}
    with open("/company/from-command.txt", "wb") as handle:
        handle.write(b"written-by-command")
    record["companyRead"] = Path("/company/from-command.txt").read_bytes().decode()
    record["companyList"] = sorted(os.listdir("/company"))
    record["tmpMarker"] = Path("/tmp/shell-marker").read_text().strip()
    record["tmpDevIno"] = list(os.stat("/tmp")[1:3][::-1])
    record["unshareNewUser"] = errno_of(lambda: syscall("unshare", CLONE_NEWUSER))
    record["clone3"] = errno_of(lambda: syscall("clone3", 0, 0))
    # No namespace is named: the filter answers EPERM by the call's number, and the kernel would answer EBADF.
    record["setnsBadFd"] = errno_of(lambda: syscall("setns", ctypes.c_long(-1), 0))
    record["vsock"] = errno_of(lambda: socket.socket(AF_VSOCK, socket.SOCK_STREAM))
    record["interfaces"] = sorted(name for _, name in socket.if_nameindex())
    record["loopback"] = loopback_works()
    if mode == "networked":
        record["blocked"] = errno_of(lambda: udp_send("10.0.0.1", 9))
        record["dns"] = errno_of(lambda: udp_send(DNS_IP, 53))
    else:
        record["outside"] = errno_of(lambda: udp_send("192.0.2.1", 9))
    emit(share / "command-report.json", record)
    # Hold. A remount in the helper's namespace must reach /company here; both stops are measured on this process.
    remounted = False
    while True:
        if not remounted and (share / "remounted").exists():
            try:
                emit(share / "command-remount.json", {"list": sorted(os.listdir("/company"))})
            except OSError as error:
                emit(share / "command-remount.json", {"list": [], "failure": repr(error)})
            remounted = True
        time.sleep(0.2)


def errno_of(call):
    try:
        result = call()
        if hasattr(result, "close"):
            result.close()
        return 0
    except OSError as error:
        return error.errno


def loopback_works():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind(("127.0.0.1", 0))
        server.listen()
        with socket.create_connection(server.getsockname(), timeout=2):
            return True
    except OSError:
        return False
    finally:
        server.close()


def udp_send(address, port):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((address, port))
        sock.send(b"x")


# --- The (c') starter: the helper's per-command child A and its child B. ---
def cap_masks(pid):
    s = status(pid)
    return {key: int(s[key], 16) for key in CAP_KEYS}


def capset_v3(effective, permitted, inheritable):
    header = struct.pack("II", CAPSET_V3, 0)
    data = struct.pack("IIIIII", effective & 0xFFFFFFFF, permitted & 0xFFFFFFFF, inheritable & 0xFFFFFFFF,
                       effective >> 32, permitted >> 32, inheritable >> 32)
    ctypes.set_errno(0)
    checked(LIBC.capset(header, data), "capset")


def set_bounding_set(mask):
    """Drop every bounding-set bit not in mask. Needs CAP_SETPCAP effective in the current user namespace, which the
    drop itself doesn't remove."""
    for cap in range(64):
        if not (mask >> cap) & 1:
            ctypes.set_errno(0)
            if LIBC.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 and ctypes.get_errno() != errno.EINVAL:
                raise OSError(ctypes.get_errno(), f"capbset drop {cap}")


def clear_ambient():
    checked(LIBC.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0), "ambient clear")


def program_digest(program):
    """The installed filter's identity: B reports it, and the check compares it with the program the selftest and the
    setns check interpret."""
    return hashlib.sha256(b"".join(struct.pack("<HBBI", *row) for row in program)).hexdigest()


def seccomp_command_program(families):
    """B's pre-exec classic-BPF filter: setns -> EPERM outright (defense in depth, c' amendment 15 Oct -- the command
    has no business joining a namespace by any fd, so the filter refuses every setns regardless of its fd's type or a
    pidfd), unshare/clone with CLONE_NEWUSER -> EPERM, clone3 -> ENOSYS (so callers fall back to clone, which the flag
    check covers), socket() outside `families` -> EAFNOSUPPORT, any other architecture or an x32 number -> ENOSYS,
    everything else allowed. Returns (code, jt, jf, k) rows, with jump offsets resolved from labels."""
    BPF_LD_W_ABS, BPF_JEQ_K, BPF_JGE_K, BPF_JSET_K, BPF_RET_K = 0x20, 0x15, 0x35, 0x45, 0x06
    ALLOW, ERRNO = 0x7FFF0000, 0x00050000
    ops = []

    def load(offset): ops.append(("op", BPF_LD_W_ABS, 0, 0, offset))
    def jump(code, k, jt, jf): ops.append(("jump", code, k, jt, jf))
    def ret(k): ops.append(("op", BPF_RET_K, 0, 0, k))
    def label(name): ops.append(("label", name))

    load(4)                                                   # arch
    jump(BPF_JEQ_K, AUDIT_ARCH_X86_64, None, "enosys")
    load(0)                                                   # syscall number
    jump(BPF_JGE_K, X32_SYSCALL_BIT, "enosys", None)          # x32 numbers would slip past the checks below
    jump(BPF_JEQ_K, NR["clone3"], "enosys", None)
    jump(BPF_JEQ_K, NR["setns"], "eperm", None)               # never join another namespace
    jump(BPF_JEQ_K, NR["unshare"], "flags", None)
    jump(BPF_JEQ_K, NR["clone"], "flags", None)
    jump(BPF_JEQ_K, NR["socket"], None, "allow")
    load(16)                                                  # socket: args[0] low, the family
    for family in sorted(int(f) for f in families):
        jump(BPF_JEQ_K, family, "allow", None)
    ret(ERRNO | errno.EAFNOSUPPORT)
    label("flags")
    load(16)                                                  # unshare/clone: args[0] low, the flags
    jump(BPF_JSET_K, CLONE_NEWUSER, "eperm", "allow")
    label("eperm")
    ret(ERRNO | errno.EPERM)
    label("enosys")
    ret(ERRNO | errno.ENOSYS)
    label("allow")
    ret(ALLOW)

    labels, index = {}, 0
    for op in ops:
        if op[0] == "label":
            labels[op[1]] = index
        else:
            index += 1
    program, index = [], 0
    for op in ops:
        if op[0] == "label":
            continue
        if op[0] == "op":
            program.append(op[1:])
        else:
            _, code, k, jt, jf = op
            offsets = [labels[target] - index - 1 if target else 0 for target in (jt, jf)]
            assert all(0 <= offset <= 255 for offset in offsets), "seccomp jump out of range"
            program.append((code, offsets[0], offsets[1], k))
        index += 1
    return program


def install_seccomp(program):
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]

    class Prog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(Filter))]

    rows = (Filter * len(program))(*[Filter(*row) for row in program])
    prog = Prog(len(program), rows)
    syscall("seccomp", 1, 0, ctypes.byref(prog))  # SECCOMP_SET_MODE_FILTER; no-new-privs is already set


def start_starter(directory, shell, mode, helper_unit, kind):
    """kind "fixture" runs this file's A and B; kind "launcher" runs the real `qorpera-folder command` in their place."""
    control = directory / "control"
    argv = [sys.executable, str(directory / "probe.py"), "starter" if kind == "fixture" else "launcher", str(shell["pid"]),
            mode, str(control), str(directory / "mount")]
    if kind == "launcher":
        argv.append(str(directory / "qorpera-folder"))
    properties = unit_properties(helper_unit, HELPER_KEYS) + ["RuntimeMaxSec=170"]
    unit = f"qorpera-cmdns-starter-{mode}"
    start_unit(unit, properties, argv)
    return {"unit": unit, "properties": properties, **await_record(control, "starter", "ready")}


def launcher_main(shell, mode, control, tree, program):
    """The starter unit's top process stands in for the helper's long-running process, as in starter_main, but starts
    the real launcher as the helper does: `qorpera-folder command` with the command's stdio on fds 0 to 2 and the report
    pipe on fd 3. The launcher is A, and the B it forks execs this file's command. The top reads the first report and
    keeps the pipe's read end open, as the helper does while a run lasts."""
    control = Path(control)
    reader, writer = os.pipe()
    output = os.open(control / "launcher-output.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    argv = [program, "command", "--shell-pid", str(shell), "--tree", tree,
            "--network", "yes" if mode == "networked" else "no", "--", "/usr/bin/python3", PROBE, "command", mode]
    launcher = os.fork()
    if launcher == 0:
        try:
            null = os.open("/dev/null", os.O_RDONLY)
            # dup2 makes each target inheritable; every other fd here is close-on-exec (PEP 446).
            for source, target in ((null, 0), (output, 1), (output, 2)):
                os.dup2(source, target)
            if writer == 3:
                os.set_inheritable(3, True)
            else:
                os.dup2(writer, 3)
            os.execv(program, argv)
        finally:
            os._exit(127)
    os.close(writer)
    os.close(output)
    line = b""
    while b"\n" not in line and (chunk := os.read(reader, 4096)):
        line += chunk
    try:
        started = json.loads(line.split(b"\n")[0])
    except ValueError:
        started = {"t": "unreadable", "line": line.decode(errors="replace")}
    if started.get("t") != "started":
        emit(control / "starter-done.json", {"error": f"launcher: {started}",
                                             "output": (control / "launcher-output.log").read_text(errors="replace")})
        raise RuntimeError(f"launcher: {started}")
    emit(control / "starter-ready.json", {"kind": "launcher", "topPid": os.getpid(), "aPid": launcher, "started": started})
    while True:
        time.sleep(1)


def starter_main(shell, mode, control, tree):
    """The starter unit's top process stands in for the helper's own long-running process: it stays in this unit's
    cgroup and forks A. Killing this unit (a helper restart) kills only the top process: A and the command have moved
    to the shell's cgroup."""
    control = Path(control)
    reader, writer = os.pipe()
    a_pid = os.fork()
    if a_pid:
        os.close(writer)
        payload = b""
        while chunk := os.read(reader, 4096):
            payload += chunk
        info = json.loads(payload or b'{"error": "A closed without a report"}')
        if "error" in info:
            emit(control / "starter-done.json", info)
            raise RuntimeError(info["error"])
        emit(control / "starter-ready.json", {"kind": "fixture", "topPid": os.getpid(), "aPid": a_pid, **info})
        while True:
            time.sleep(1)

    # --- A: root in the initial user namespace, with the helper unit's capability set. ---
    os.close(reader)
    networked = mode == "networked"
    try:
        office_uid, office_gid = office_ids()
        # From the helper's own (initial) mount namespace: a recursive clone of the company mount's parent, which the
        # helper bound onto itself and shared (so a remount reaches every clone), and the shell's root and namespaces.
        tree_fd = syscall("open_tree", AT_FDCWD, tree.encode(), OPEN_TREE_CLONE | os.O_CLOEXEC | AT_RECURSIVE)
        root_fd = os.open(f"/proc/{shell}/root", os.O_PATH | os.O_DIRECTORY)
        names = ["mnt", "pid", "uts", "ipc", "cgroup"] + (["net"] if networked else [])
        ns_fds = {name: os.open(f"/proc/{shell}/ns/{name}", os.O_RDONLY) for name in names}
        # The shell's user namespace, for B to join once it is unprivileged. A never joins it.
        user_fd = os.open(f"/proc/{shell}/ns/user", os.O_RDONLY)
        shell_caps = cap_masks(shell)
        cgroup = _cgroup_path(shell)
        before = {"pid": os.getpid(), "user": os.readlink("/proc/self/ns/user"), "uid": list(os.getresuid()), "caps": caps_of()}
        checked(LIBC.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0), "dumpable")
        # Into the shell's cgroup first, so the office's stop reaches A, B and the command, and a helper restart doesn't.
        Path(f"/sys/fs/cgroup{cgroup}/cgroup.procs").write_text(f"{os.getpid()}\n")
        for name in names:
            checked(LIBC.setns(ns_fds[name], 0), f"setns {name}")
            os.close(ns_fds[name])
        # B is forked from a single-threaded A without CLONE_FS, so it has one thread and its own fs_struct, as
        # joining a user namespace requires (userns_install answers EINVAL otherwise).
        b_pid = os.fork()
        if b_pid:
            os.close(writer)
            os.close(tree_fd)
            os.close(root_fd)
            os.close(user_fd)
            os.waitpid(b_pid, 0)
            os._exit(0)
        run_b(networked, tree_fd, root_fd, user_fd, writer, office_uid, office_gid, shell_caps, before)
    except BaseException as error:
        try:
            os.write(writer, json.dumps({"error": f"A/B: {error!r}"}).encode())
        finally:
            os._exit(17)


def _cgroup_path(pid):
    for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines():
        if line.startswith("0::"):
            return line[3:]
    raise RuntimeError("no cgroup v2 path")


def lo_up():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        request = struct.pack("16sH22x", b"lo", 0)
        flags = struct.unpack("16sH22x", fcntl.ioctl(sock.fileno(), SIOCGIFFLAGS, request))[1]
        fcntl.ioctl(sock.fileno(), SIOCSIFFLAGS, struct.pack("16sH22x", b"lo", flags | IFF_UP))


def open_in_root(path, root="/"):
    """An O_PATH fd on a directory under the (chrooted) root, resolved one name at a time: no link followed, no `..`.
    This is what openat2 with RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS would do, but the helper unit's RestrictSUIDSGID
    filter answers openat2 with ENOSYS (it can't see openat2's mode), and the helper keeps that filter because a command
    inherits it, as the office's own commands do."""
    names = path.strip("/").split("/")
    assert all(name not in ("", ".", "..") for name in names), path
    fd = os.open(root, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for name in names:
            # O_NOFOLLOW with O_PATH opens a link itself, which O_DIRECTORY then refuses (ENOTDIR).
            fd, parent = os.open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd), fd
            os.close(parent)
    except BaseException:
        os.close(fd)
        raise
    return fd


def close_all_but(keep):
    """Close every fd from 3 up except those in keep."""
    low = 3
    for fd in sorted(keep):
        if fd > low:
            syscall("close_range", low, fd - 1, 0)
        low = max(low, fd + 1)
    syscall("close_range", low, ctypes.c_uint(0xFFFFFFFF), 0)


def run_b(networked, tree_fd, root_fd, user_fd, writer, office_uid, office_gid, shell_caps, before):
    """B: in the shell's pid namespace (A's setns applies to its children), root in the initial user namespace until
    it drops to the office account, and only then a member of the shell's user namespace."""
    os.fchdir(root_fd)
    os.chroot(".")
    os.chdir("/")
    os.close(root_fd)
    # The command's own mount namespace, and an offline command's own network namespace: both owned by the initial
    # user namespace, so the office account can change neither.
    syscall("unshare", CLONE_NEWNS | (0 if networked else CLONE_NEWNET))
    checked(LIBC.mount(None, b"/", None, ctypes.c_ulong(MS_REC | MS_PRIVATE), None), "make / private")
    if not networked:
        lo_up()
    # The shell's root belongs to the office account: resolve the target without following a link and without leaving
    # the root, then attach the pinned tree to it by fd. The attached copy only receives the helper's remounts.
    target = open_in_root(COMPANY_PARENT)
    syscall("move_mount", tree_fd, b"", target, b"", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH)
    attr = struct.pack("QQQQ", 0, 0, MS_SLAVE, 0)
    syscall("mount_setattr", tree_fd, b"", AT_EMPTY_PATH | AT_RECURSIVE, attr, ctypes.c_size_t(len(attr)))
    for fd in (tree_fd, target):
        os.close(fd)
    # Only stdio, the report pipe and the shell's user-namespace fd stay open; both close before exec.
    close_all_but({writer, user_fd})
    # Still root in the initial user namespace: the office account's ids with no capabilities. With the ambient set
    # and keep-caps cleared, the uid change empties the permitted and effective sets.
    clear_ambient()
    checked(LIBC.prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0), "keepcaps")
    os.setgroups([])
    os.setresgid(office_gid, office_gid, office_gid)
    os.setresuid(office_uid, office_uid, office_uid)
    after_drop = {"user": os.readlink("/proc/self/ns/user"), "uid": list(os.getresuid()), "gid": list(os.getresgid()),
                  "caps": caps_of()}
    # Join the shell's user namespace as a member. The office account owns bwrap's outer user namespace, whose parent
    # is ours, so the kernel allows the join with no capabilities. The join hands B a full set that counts only in the
    # shell's user namespace and below, where nothing of the command's is owned.
    checked(LIBC.setns(user_fd, CLONE_NEWUSER), "setns user")
    os.close(user_fd)
    inside = {"user": os.readlink("/proc/self/ns/user"), "uid": list(os.getresuid()), "gid": list(os.getresgid())}
    # The office account must not be root (or unmapped) in there: a later exec as uid 0 would get its capabilities back.
    if {*inside["uid"], *inside["gid"]} & {0, 65534}:
        raise RuntimeError(f"the office account is {inside['uid']}/{inside['gid']} in the shell's user namespace")
    # In there: the shell's bounding set, no ambient set, SECBIT_NOROOT locked (it needs CAP_SETPCAP, so it comes before
    # the capset), then no capabilities at all, no-new-privs and the filter.
    set_bounding_set(shell_caps["CapBnd"])
    clear_ambient()
    checked(LIBC.prctl(PR_SET_SECUREBITS, SECUREBITS_LOCKED_NOROOT, 0, 0, 0), "securebits")
    capset_v3(0, 0, 0)
    checked(LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")
    program = seccomp_command_program(OFFICE_FAMILIES)
    install_seccomp(program)
    os.write(writer, json.dumps({"bShellPid": os.getpid(), "shellCaps": {k: f"{v:016x}" for k, v in shell_caps.items()},
                                 "aBefore": before, "bAfterDrop": after_drop, "bInside": inside,
                                 "filterSha256": program_digest(program)}).encode())
    os.close(writer)
    os.chdir("/company")
    os.execve("/usr/bin/python3", ["/usr/bin/python3", PROBE, "command", "networked" if networked else "offline"],
              {"PATH": "/usr/bin", "LANG": "C.UTF-8"})


def find_command(office_uid):
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = Path(entry, "cmdline").read_bytes().split(b"\0")
            if argv[1:3] == [PROBE.encode(), b"command"] and int(status(entry.name)["Uid"].split()[0]) == office_uid:
                return int(entry.name)
        except (OSError, KeyError, IndexError):
            continue
    return None


def children_of(pid):
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                if int(status(entry.name)["PPid"]) == pid:
                    found.append(int(entry.name))
            except (OSError, KeyError):
                continue
    return found


def alive(pid):
    try:
        return status(pid)["State"][0] != "Z"
    except (OSError, KeyError):
        return False


def settled(check, seconds):
    try:
        return bool(eventually(check, seconds))
    except TimeoutError:
        return False


# --- The probe: root in the disposable guest, standing in for the office host and the node. ---
LIMITATIONS = {
    "fixture": ["The starter runs under the helper unit's keys as a stand-in for the helper's per-command child"],
    "launcher": [
        "The starter's top process runs under the helper unit's keys as a stand-in for the helper's own process; A and B "
        "are the real `qorpera-folder command`, started as the helper starts it",
        "B's state between the drop and its join of the shell's user namespace can't be seen from outside the launcher: "
        "the fixture kind shows that order, and the launcher stops if a capability is left after the drop",
        "The launcher's filter bytes are pinned by the crate's test the_filter_is_the_one_the_proof_installed to the "
        "program the fixture kind installs and checks; this kind shows the setns refusal live",
    ],
}


def probe(directory, mode, kind):
    require_disposable_guest(directory)
    if mode not in ("offline", "networked"):
        raise ValueError("Unknown mode")
    if kind not in ("fixture", "launcher"):
        raise ValueError("Unknown starter kind")
    started = int(time.time())
    if not Path("/dev/fuse").exists():
        raise RuntimeError("Image must already provide /dev/fuse")
    office_uid, office_gid = office_ids()
    if office_uid == 0:
        raise RuntimeError("The office account must be unprivileged")
    control = directory / "control"
    control.mkdir(mode=0o755)
    share = directory / "share"
    share.mkdir(mode=0o700)
    os.chown(share, office_uid, office_gid)
    mount = directory / "mount"
    (mount / "company").mkdir(parents=True)
    (directory / "state").mkdir(mode=0o700)
    view = directory / "view.json"
    view.write_text(json.dumps({"environmentId": "synthetic", "viewId": "synthetic", "pass": "synthetic-pass"}))
    view.chmod(0o600)
    # As the helper lays out a mount: the parent bound onto itself and shared, so a mount made again reaches every copy.
    run("mount", "--bind", str(mount), str(mount))
    run("mount", "--make-rshared", str(mount))
    node = FolderNode(directory / "node.sock")
    office_unit = (directory / "office.service").read_text()
    helper_unit = (directory / "helper.service").read_text()
    children = []
    units = ["qorpera-cmdns-shell", f"qorpera-cmdns-starter-{mode}"]
    record = {"result": "failed", "mode": mode, "kind": kind, "office": {"uid": office_uid, "gid": office_gid},
              "initialUser": os.readlink("/proc/self/ns/user"),
              "limitations": ["Synthetic Unix-socket folder service; no database, vsock identity or request authorization",
                              "The shell is the real bwrap sandbox under the office unit's keys, not a running office application",
                              *LIMITATIONS[kind]]}

    def start_folder():
        log = open(directory / f"mount-{len(children)}.log", "w")
        child = subprocess.Popen([str(directory / "qorpera-folder"), "mount", "--connect", f"unix:{directory}/node.sock",
                                  "--view-file", str(view), "--mountpoint", str(mount / "company"),
                                  "--state-dir", str(directory / "state"), "--allow-other", "yes",
                                  "--owner-uid", str(office_uid), "--owner-gid", str(office_gid)], stdout=log, stderr=log)
        log.close()
        children.append(child)
        eventually(lambda: (mount / "company/before.txt").read_text() == "before", 20)
        return child

    try:
        folder = start_folder()
        shell = start_shell(directory, share, office_unit)
        record["shell"] = shell
        s = shell["pid"]
        if mode == "networked":
            plumb_networked(s)
        tmp = os.stat(f"/proc/{s}/root/tmp")
        record["shellOutside"] = {"pid": s, "uid": status(s)["Uid"].split(), "caps": caps_of(s), "ns": ns_links(s),
                                  "nsOwner": ns_owners(s), "usernsChain": userns_chain(s), "cgroup": _cgroup_path(s),
                                  "tmpDevIno": [tmp.st_dev, tmp.st_ino],
                                  "lsm": Path(f"/proc/{s}/attr/current").read_text().strip()}
        record["helperPropagation"] = propagation(Path("/proc/self/mountinfo").read_text(), str(mount))

        starter = start_starter(directory, shell, mode, helper_unit, kind)
        record["starter"] = starter
        command = eventually(lambda: find_command(office_uid), 20)
        record["command"] = await_record(share, "command", "report")
        a_pid, top_pid = starter["aPid"], starter["topPid"]
        setsid = children_of(command)
        # From the initial user namespace, where every owner resolves (NS_GET_USERNS, NS_GET_OWNER_UID, NS_GET_PARENT).
        record["commandOutside"] = {"pid": command, "cgroup": _cgroup_path(command), "nspid": status(command)["NSpid"].split(),
                                    "ppid": int(status(command)["PPid"]), "setsidChildren": setsid,
                                    "user": os.readlink(f"/proc/{command}/ns/user"), "nsOwner": ns_owners(command),
                                    "usernsChain": userns_chain(command)}
        record["starterA"] = {"pid": a_pid, "user": os.readlink(f"/proc/{a_pid}/ns/user"), "uid": status(a_pid)["Uid"].split(),
                              "caps": caps_of(a_pid), "cgroup": _cgroup_path(a_pid), "ns": ns_links(a_pid)}
        record["starterTop"] = {"pid": top_pid, "cgroup": _cgroup_path(top_pid)}
        if mode == "networked":
            listed = subprocess.run(["nsenter", "-t", str(command), "-n", "nft", "list", "table", "inet", "qorpera_computer"],
                                    capture_output=True, text=True, timeout=20)
            record["filterInCommandNetns"] = listed.returncode == 0 and "10.0.0.0/8" in listed.stdout
        record["nodeHasCommandWrite"] = node.files.get("from-command.txt") == b"written-by-command"

        # The helper makes the mount again; the command's /company must follow it.
        folder.kill()
        folder.wait(timeout=5)
        run("umount", "-l", str(mount / "company"))
        with node.lock:
            node.files["after.txt"] = b"after remount"
        start_folder()
        (share / "remounted").touch()
        record["remount"] = await_record(share, "command", "remount")

        # A helper restart kills the starter unit's cgroup: only its top process is there.
        run("systemctl", "kill", "-s", "KILL", f"{starter['unit']}.service")
        eventually(lambda: unit_gone(starter["unit"]), 15)
        time.sleep(1)
        record["afterHelperRestart"] = {"command": alive(command), "setsidChild": bool(setsid) and all(alive(p) for p in setsid),
                                        "starterA": alive(a_pid), "top": alive(top_pid)}

        if kind == "launcher":
            # A run's stop, as the helper sends it: SIGTERM to A, which sends the command's process group SIGTERM, then
            # SIGKILL two seconds later, and ends. A is root and the command the office account, so this needs the helper
            # unit's CAP_KILL. The setsid child left the group: it lasts until the office's stop.
            os.kill(a_pid, signal.SIGTERM)
            settled(lambda: not alive(command) and not alive(a_pid), 10)
            record["afterLauncherStop"] = {"command": alive(command), "starterA": alive(a_pid),
                                           "setsidChild": bool(setsid) and all(alive(p) for p in setsid)}

        # The office's stop kills the shell's cgroup, now holding A, the command and its setsid child (with the launcher,
        # only the setsid child is left by then).
        begun = time.monotonic()
        run("systemctl", "stop", "qorpera-cmdns-shell.service", timeout=100)
        record["stopSeconds"] = round(time.monotonic() - begun, 2)
        settled(lambda: not any(alive(p) for p in (command, a_pid, *setsid)), 5)
        record["afterOfficeStop"] = {"command": alive(command), "setsidChild": any(alive(p) for p in setsid),
                                     "starterA": alive(a_pid)}
        record["checks"] = checks_for(record, node.errors)
        record["result"] = "passed" if all(record["checks"].values()) else "failed"
    except Exception as error:
        record["error"] = repr(error)
    finally:
        for unit in units:
            run("systemctl", "stop", f"{unit}.service", check=False)
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        node.listener.close()
        record["protocolErrors"] = node.errors
        record["records"] = {}
        for folder_path in (control, share):
            for path in folder_path.glob("*.json"):
                try:
                    record["records"][path.name] = json.loads(path.read_text())
                except (OSError, ValueError) as error:
                    record["records"][path.name] = {"unreadable": repr(error)}
        record["mountLogs"] = [p.read_text() for p in sorted(directory.glob("mount-*.log"))]
        if (control / "launcher-output.log").exists():
            record["launcherOutput"] = (control / "launcher-output.log").read_text(errors="replace")
        kernel = run("journalctl", "-k", "--no-pager", "--since", f"@{started}", "-n", "100", check=False)
        record["kernelDenials"] = [line for line in kernel.splitlines() if "DENIED" in line or "apparmor=" in line or "SECCOMP" in line]
        record["units"] = {unit: run("journalctl", "--no-pager", "-n", "30", "-u", f"{unit}.service", check=False) for unit in units}
        print(json.dumps(record))


COMMAND_NAMESPACES = ("mnt", "pid", "net", "uts", "ipc", "cgroup")


def checks_for(record, node_errors):
    c, so, co = record["command"], record["shellOutside"], record["commandOutside"]
    a, st, office = record["starterA"], record["starter"], record["office"]
    # One of the shell's own commands, as it recorded itself: what a command the helper starts must equal.
    ss = record["shell"]["state"]
    initial = record["initialUser"]
    initial_owner = {"userns": initial, "uid": 0}
    helper_shared = [f for f in record["helperPropagation"] or [] if f.startswith("shared:")]
    company = c["propagation"].get(COMPANY_PARENT) or []
    restart, stop = record["afterHelperRestart"], record["afterOfficeStop"]
    chain = co["usernsChain"]
    checks = {
        # The coordinator's four state checks (14 Oct): the shell's capabilities, the shell's cgroup and both stops,
        # no new user namespace and no clone3, and a working loopback (with the network checks below).
        "capsEqualShell": all(c["caps"][key] == ss["caps"][key] for key in ("CapBnd", "CapEff", "CapPrm", "CapAmb", "NoNewPrivs")),
        "cgroupEqualsShell": co["cgroup"] == so["cgroup"] == a["cgroup"],
        "officeStopKilledCommand": stop == {"command": False, "setsidChild": False, "starterA": False},
        "helperRestartLeftCommand": restart["command"] is True and restart["setsidChild"] is True and restart["top"] is False,
        "newUserRefused": c["unshareNewUser"] == errno.EPERM,
        "clone3Refused": c["clone3"] == errno.ENOSYS,
        "loopbackWorks": c["loopback"] is True,
        # The (c') checks (15 Oct). The command is in the shell's own user namespace, with the ids and maps of the
        # shell's commands, and the office account is not root there.
        "commandInShellUserns": c["ns"]["user"] == co["user"] == ss["ns"]["user"] == so["ns"]["user"] != initial,
        "idsEqualShellCommand": c["uid"] == ss["uid"] and c["gid"] == ss["gid"] and not {*c["uid"], *c["gid"]} & {0, 65534},
        "uidGidMapEqualShell": c["uidMap"] == ss["uidMap"] and c["gidMap"] == ss["gidMap"] and bool(c["uidMap"]),
        # A uid-0 exec gains nothing, and the bit can't be cleared.
        "securebitsNoRootLocked": c["securebits"] == SECUREBITS_LOCKED_NOROOT,
        # The filter is in the process that runs the command: its own setns(-1, 0), which names no namespace, gets the
        # filter's EPERM, not the kernel's EBADF.
        "setnsRefusedLive": c["setnsBadFd"] == errno.EPERM,
        # The owner rule (user_namespaces(7)): the command is a member of every user namespace that owns one of its
        # namespaces (or of one below it), never its parent. Read from the initial user namespace: the command's chain
        # runs from its own user namespace up to the initial one, and every owner is on it.
        "ownerRuleNeverParent": bool(chain) and chain[0] == co["user"] and chain[-1] == initial
                                and all(co["nsOwner"][name].get("userns") in chain for name in COMMAND_NAMESPACES),
        # Ids, namespace owners and the fds at exec.
        "capInhEqualShell": c["caps"]["CapInh"] == ss["caps"]["CapInh"],
        "seccompFiltered": c["seccomp"] == "2",
        "commandIsOffice": c["uid"] == [office["uid"]] * 3 and c["gid"] == [office["gid"]] * 3 and c["groups"] == [],
        "starterRootInInitialUserns": a["user"] == initial and a["uid"] == ["0"] * 4,
        "mountNsIsCommandsOwn": c["ns"]["mnt"] != so["ns"]["mnt"],
        "mountNsOwnedByInitialUserns": co["nsOwner"]["mnt"] == initial_owner,
        "sharesShellPidUtsIpcCgroup": all(c["ns"][name] == so["ns"][name] for name in ("pid", "uts", "ipc", "cgroup")),
        "inShellPidNs": len(co["nspid"]) == 2 and int(co["nspid"][-1]) == c["pid"],
        "parentIsStarterA": co["ppid"] == st["aPid"],
        "onlyStdioAtExec": c["execFds"] == [0, 1, 2, 3],
        # The company folder, /tmp and the start directory.
        "companyWritable": c["companyRead"] == "written-by-command" and record["nodeHasCommandWrite"] is True,
        "companyFollowsRemount": "after.txt" in record["remount"].get("list", []),
        "companyIsSlaveOfHelper": len(helper_shared) == 1 and f"master:{helper_shared[0][7:]}" in company and not any(f.startswith("shared:") for f in company),
        "tmpShared": c["tmpMarker"] == "shell" and c["tmpDevIno"] == so["tmpDevIno"],
        "startsInCompany": c["cwd"] == f"{COMPANY_PARENT}/company",
        "vsockRefused": c["vsock"] == errno.EAFNOSUPPORT,
        "fixtureProtocolClean": not node_errors,
    }
    if st["kind"] == "fixture":
        program, dropped = seccomp_command_program(OFFICE_FAMILIES), st["bAfterDrop"]
        checks.update({
            "bReportedCommandPid": c["pid"] == st["bShellPid"],
            # The installed filter is the program interpreted here, and it answers setns EPERM by its number alone,
            # before any argument: a namespace fd of any type (0 included) and a pidfd alike.
            "setnsRefusedByFilter": st["filterSha256"] == program_digest(program) and all(
                run_bpf(program, AUDIT_ARCH_X86_64, NR["setns"], arg) == 0x00050000 | errno.EPERM
                for arg in (0, 3, CLONE_NEWUSER, CLONE_NEWNET, CLONE_NEWNS)),
            # B held no capability when it joined: the office account's ids in the initial user namespace, nothing
            # permitted.
            "unprivilegedBeforeJoin": dropped["user"] == initial and dropped["uid"] == [office["uid"]] * 3
                                      and all(dropped["caps"][key] == "0" * 16 for key in ("CapPrm", "CapEff", "CapAmb")),
        })
    else:
        # The launcher's start report names the command it started: its pid in the initial pid namespace (the one the
        # helper sees), and the mount namespace it made for it.
        started = st["started"]
        checks["launcherReportedStart"] = started["pid"] == co["pid"] and f"mnt:[{started['mntns']}]" == c["ns"]["mnt"]
        # The launcher's own stop ends the command's group and then itself; a process that left the group stays.
        checks["launcherStopEndedGroup"] = record["afterLauncherStop"] == {"command": False, "starterA": False,
                                                                           "setsidChild": True}
    if record["mode"] == "networked":
        checks.update({
            "sharesComputerNetns": c["ns"]["net"] == so["ns"]["net"],
            "computerFilterLoaded": record["filterInCommandNetns"] is True,
            "computerInterfaces": c["interfaces"] == ["eth0", "lo"],
            "blockedRefused": c["blocked"] == errno.EPERM,
            "dnsAllowed": c["dns"] == 0,
        })
    else:
        checks.update({
            "netNsIsCommandsOwn": c["ns"]["net"] != so["ns"]["net"],
            "netNsOwnedByInitialUserns": co["nsOwner"]["net"] == initial_owner,
            "onlyLoopback": c["interfaces"] == ["lo"],
            "noRoute": c["outside"] == errno.ENETUNREACH,
        })
    return checks


def cleanup(directory):
    require_disposable_guest(directory)
    for unit in ("qorpera-cmdns-shell", "qorpera-cmdns-starter-offline", "qorpera-cmdns-starter-networked"):
        run("systemctl", "stop", f"{unit}.service", check=False)
    run("umount", "-l", str(directory / "mount/company"), check=False)
    run("umount", "-l", str(directory / "mount"), check=False)
    shutil.rmtree(directory)


# --- Selftest: unprivileged logic only; it claims no namespace proof. ---
def run_bpf(program, arch, nr, arg0):
    data = struct.pack("<iIQ6Q", nr, arch, 0, arg0, 0, 0, 0, 0, 0)
    acc, pc = 0, 0
    while True:
        code, jt, jf, k = program[pc]
        if code == 0x20:
            acc, pc = struct.unpack_from("<I", data, k)[0], pc + 1
        elif code == 0x06:
            return k
        elif code == 0x15:
            pc += 1 + (jt if acc == k else jf)
        elif code == 0x35:
            pc += 1 + (jt if acc >= k else jf)
        elif code == 0x45:
            pc += 1 + (jt if acc & k else jf)
        else:
            raise AssertionError(f"unknown BPF op {code:#x}")


def synthetic_record(mode, kind):
    # bwrap's --disable-userns makes two user namespaces: the outer one (owned by the office account, a child of the
    # initial one) owns the shell's other namespaces, and the shell itself runs in the inner one, mapped 990 -> 990.
    initial, outer, inner = "user:[4026531837]", "user:[4026532300]", "user:[4026532301]"
    outer_owner, initial_owner = {"userns": outer, "uid": 990}, {"userns": initial, "uid": 0}
    zero = "0" * 16
    caps = {"CapInh": zero, "CapPrm": zero, "CapEff": zero, "CapBnd": zero, "CapAmb": zero, "NoNewPrivs": "1"}
    shell_ns = {"user": inner, "mnt": "mnt:[4026532302]", "pid": "pid:[4026532303]", "net": "net:[4026532304]",
                "uts": "uts:[4026532305]", "ipc": "ipc:[4026532306]", "cgroup": "cgroup:[4026532307]"}
    owners = {name: outer_owner for name in COMMAND_NAMESPACES}
    command_ns = {**shell_ns, "mnt": "mnt:[4026532310]"}
    command_owners = {**owners, "mnt": initial_owner}
    maps = ["       990        990          1"]
    command = {"execFds": [0, 1, 2, 3], "pid": 7, "uid": [990] * 3, "gid": [990] * 3, "groups": [], "caps": dict(caps),
               "uidMap": maps, "gidMap": maps, "securebits": SECUREBITS_LOCKED_NOROOT,
               "seccomp": "2", "ns": command_ns, "nsOwner": {name: {"error": "EPERM"} for name in COMMAND_NAMESPACES},
               "cwd": f"{COMPANY_PARENT}/company",
               "propagation": {COMPANY_PARENT: ["master:41"], f"{COMPANY_PARENT}/company": ["master:42"]},
               "companyRead": "written-by-command", "tmpMarker": "shell", "tmpDevIno": [40, 1],
               "unshareNewUser": errno.EPERM, "clone3": errno.ENOSYS, "setnsBadFd": errno.EPERM, "vsock": errno.EAFNOSUPPORT,
               "loopback": True}
    if mode == "networked":
        command.update({"interfaces": ["eth0", "lo"], "blocked": errno.EPERM, "dns": 0})
    else:
        command_ns["net"] = "net:[4026532311]"
        command_owners["net"] = initial_owner
        command.update({"interfaces": ["lo"], "outside": errno.ENETUNREACH})
    cgroup = "/system.slice/qorpera-cmdns-shell.service"
    shell_state = {"uid": [990] * 3, "gid": [990] * 3, "groups": [65534], "uidMap": maps, "gidMap": maps,
                   "ns": dict(shell_ns), "caps": dict(caps), "securebits": 0}
    if kind == "fixture":
        dropped = {"user": initial, "uid": [990] * 3, "gid": [990] * 3, "caps": {**caps, "CapBnd": "00000000002010c3"}}
        starter = {"kind": kind, "aPid": 300, "topPid": 299, "bShellPid": 7, "bAfterDrop": dropped,
                   "bInside": {"user": inner, "uid": [990] * 3, "gid": [990] * 3},
                   "filterSha256": program_digest(seccomp_command_program(OFFICE_FAMILIES))}
    else:
        starter = {"kind": kind, "aPid": 300, "topPid": 299, "started": {"t": "started", "pid": 301, "mntns": 4026532310}}
    record = {"mode": mode, "kind": kind, "office": {"uid": 990, "gid": 990}, "initialUser": initial, "command": command,
              "shell": {"pid": 200, "state": shell_state},
              "shellOutside": {"caps": dict(caps), "ns": shell_ns, "nsOwner": owners, "usernsChain": [inner, outer, initial],
                               "cgroup": cgroup, "tmpDevIno": [40, 1]},
              "helperPropagation": ["shared:41"],
              "starter": starter,
              "commandOutside": {"pid": 301, "cgroup": cgroup, "nspid": ["301", "7"], "ppid": 300, "setsidChildren": [302],
                                 "user": inner, "nsOwner": command_owners, "usernsChain": [inner, outer, initial]},
              "starterA": {"user": initial, "uid": ["0"] * 4, "cgroup": cgroup},
              "remount": {"list": ["after.txt", "before.txt", "from-command.txt"]}, "nodeHasCommandWrite": True,
              "afterHelperRestart": {"command": True, "setsidChild": True, "starterA": True, "top": False},
              "afterOfficeStop": {"command": False, "setsidChild": False, "starterA": False}}
    if kind == "launcher":
        record["afterLauncherStop"] = {"command": False, "starterA": False, "setsidChild": True}
    if mode == "networked":
        record["filterInCommandNetns"] = True
    return record


def selftest():
    args = sandbox_args(123)
    assert args[:2] == ["--unshare-user", "--unshare-pid"] and args[-4:] == ["--size", "123", "--tmpfs", "/tmp"]
    unit = "[Service]\nUser=qorpera-office\n# a comment\nExecStart=/x\nKillMode=mixed\nCapabilityBoundingSet=\n"
    assert unit_properties(unit, OFFICE_KEYS) == ["User=qorpera-office", "KillMode=mixed", "CapabilityBoundingSet="]
    assert unit_properties(unit, HELPER_KEYS) == ["CapabilityBoundingSet="]

    allow, eperm = 0x7FFF0000, 0x00050000 | errno.EPERM
    enosys, eafnosupport = 0x00050000 | errno.ENOSYS, 0x00050000 | errno.EAFNOSUPPORT
    program = seccomp_command_program(OFFICE_FAMILIES)
    x86 = AUDIT_ARCH_X86_64
    assert run_bpf(program, 0x40000003, NR["unshare"], CLONE_NEWUSER) == enosys
    assert run_bpf(program, x86, NR["unshare"] | X32_SYSCALL_BIT, CLONE_NEWUSER) == enosys
    assert run_bpf(program, x86, NR["clone3"], 0) == enosys
    assert run_bpf(program, x86, NR["unshare"], CLONE_NEWUSER | CLONE_NEWNS) == eperm
    assert run_bpf(program, x86, NR["unshare"], CLONE_NEWNS) == allow
    assert run_bpf(program, x86, NR["clone"], CLONE_NEWUSER | 17) == eperm
    assert run_bpf(program, x86, NR["clone"], 17) == allow
    # setns by its number alone: whatever the fd (a namespace's of any type, or a pidfd) and flags.
    for arg in (0, 3, CLONE_NEWUSER, CLONE_NEWNET, CLONE_NEWNS):
        assert run_bpf(program, x86, NR["setns"], arg) == eperm
    assert run_bpf(program, x86, NR["setns"] | X32_SYSCALL_BIT, 0) == enosys
    for family in OFFICE_FAMILIES:
        assert run_bpf(program, x86, NR["socket"], int(family)) == allow
    for family in (AF_VSOCK, AF_PACKET, 0):
        assert run_bpf(program, x86, NR["socket"], int(family)) == eafnosupport
    assert run_bpf(program, x86, 0, 0) == allow

    for bad in ("/run/qorpera-cmdns-x", "/run/qorpera-cmdns-" + "a" * 36 + "/..", "/tmp/qorpera-cmdns-" + "a" * 36):
        assert not SCOPE.fullmatch(bad)
    assert SCOPE.fullmatch("/run/qorpera-cmdns-0123abcd-0123-4567-89ab-0123456789ab")
    mountinfo = ("30 1 0:5 / /run/x rw shared:41 - tmpfs tmpfs rw\n"
                 "31 30 0:6 / /run/x/company rw,nosuid master:42 propagate_from:40 - fuse fuse rw\n"
                 "32 30 0:7 / /run/x rw - tmpfs tmpfs rw\n")
    assert propagation(mountinfo, "/run/x") == []
    assert propagation(mountinfo, "/run/x/company") == ["master:42", "propagate_from:40"]
    assert propagation(mountinfo, "/run/y") is None

    # The mount point's walk: a link or a missing name is refused, and so is any empty, `.` or `..` name. O_PATH is
    # Linux's, where the proof runs; elsewhere only the names are checked.
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(f"{root}/run/qorpera-company/company")
        os.symlink("qorpera-company", f"{root}/run/linked")
        if hasattr(os, "O_PATH"):
            os.close(open_in_root("/run/qorpera-company", root))
            for bad, code in (("/run/linked", errno.ENOTDIR), ("/run/missing", errno.ENOENT)):
                try:
                    os.close(open_in_root(bad, root))
                    raise AssertionError(f"{bad} opened")
                except OSError as error:
                    assert error.errno == code, (bad, error)
        for bad in ("/run/../etc", "/run//x", "/run/./x", "/"):
            try:
                open_in_root(bad, root)
                raise AssertionError(f"{bad} opened")
            except AssertionError as error:
                assert str(error) == bad, error

    for mode, kind in ((mode, kind) for mode in ("offline", "networked") for kind in ("fixture", "launcher")):
        record = synthetic_record(mode, kind)
        checks = checks_for(record, [])
        assert all(checks.values()), [name for name, ok in checks.items() if not ok]
        flips = {
            "capsEqualShell": lambda r: r["command"]["caps"].update(CapBnd="0000000000200000"),
            "cgroupEqualsShell": lambda r: r["commandOutside"].update(cgroup="/system.slice/qorpera-cmdns-starter.service"),
            "officeStopKilledCommand": lambda r: r["afterOfficeStop"].update(setsidChild=True),
            "helperRestartLeftCommand": lambda r: r["afterHelperRestart"].update(command=False),
            "newUserRefused": lambda r: r["command"].update(unshareNewUser=0),
            "clone3Refused": lambda r: r["command"].update(clone3=errno.EPERM),
            "loopbackWorks": lambda r: r["command"].update(loopback=False),
            "commandInShellUserns": lambda r: r["command"]["ns"].update(user="user:[4026531837]"),
            # Equal to the shell's commands is not enough: never root in there.
            "idsEqualShellCommand": lambda r: (r["command"].update(uid=[0] * 3), r["shell"]["state"].update(uid=[0] * 3)),
            "uidGidMapEqualShell": lambda r: r["command"].update(gidMap=["         0        990          1"]),
            "securebitsNoRootLocked": lambda r: r["command"].update(securebits=SECBIT_NOROOT),
            "setnsRefusedLive": lambda r: r["command"].update(setnsBadFd=errno.EBADF),
            # Plain (c), the gap this check is for: the command in the initial user namespace, the parent of the user
            # namespace that owns the shell's pid, uts, ipc and cgroup namespaces.
            "ownerRuleNeverParent": lambda r: r["commandOutside"].update(user="user:[4026531837]", usernsChain=["user:[4026531837]"]),
            "capInhEqualShell": lambda r: r["command"]["caps"].update(CapInh="0000000000000001"),
            "seccompFiltered": lambda r: r["command"].update(seccomp="0"),
            "commandIsOffice": lambda r: r["command"].update(groups=[990]),
            "starterRootInInitialUserns": lambda r: r["starterA"].update(user="user:[4026532301]"),
            "mountNsIsCommandsOwn": lambda r: r["command"]["ns"].update(mnt="mnt:[4026532302]"),
            "mountNsOwnedByInitialUserns": lambda r: r["commandOutside"]["nsOwner"].update(mnt={"userns": "user:[4026532300]", "uid": 990}),
            "sharesShellPidUtsIpcCgroup": lambda r: r["command"]["ns"].update(ipc="ipc:[1]"),
            "inShellPidNs": lambda r: r["commandOutside"].update(nspid=["301"]),
            "parentIsStarterA": lambda r: r["commandOutside"].update(ppid=1),
            "onlyStdioAtExec": lambda r: r["command"].update(execFds=[0, 1, 2, 3, 4]),
            "companyWritable": lambda r: r.update(nodeHasCommandWrite=False),
            "companyFollowsRemount": lambda r: r["remount"].update(list=[]),
            "companyIsSlaveOfHelper": lambda r: r["command"]["propagation"].update({COMPANY_PARENT: ["shared:41"]}),
            "tmpShared": lambda r: r["command"].update(tmpDevIno=[40, 2]),
            "startsInCompany": lambda r: r["command"].update(cwd="/"),
            "vsockRefused": lambda r: r["command"].update(vsock=0),
        }
        if kind == "fixture":
            flips.update({
                "bReportedCommandPid": lambda r: r["starter"].update(bShellPid=8),
                "setnsRefusedByFilter": lambda r: r["starter"].update(filterSha256="0" * 64),
                "unprivilegedBeforeJoin": lambda r: r["starter"]["bAfterDrop"]["caps"].update(CapEff="0000000000200000"),
            })
        else:
            flips["launcherReportedStart"] = lambda r: r["starter"]["started"].update(mntns=4026532302)
            # A launcher without CAP_KILL: its SIGTERM and SIGKILL to the office account's group fail, and it waits on.
            flips["launcherStopEndedGroup"] = lambda r: r["afterLauncherStop"].update(command=True, starterA=True)
        if mode == "networked":
            flips.update({
                "sharesComputerNetns": lambda r: r["command"]["ns"].update(net="net:[1]"),
                "computerFilterLoaded": lambda r: r.update(filterInCommandNetns=False),
                "computerInterfaces": lambda r: r["command"].update(interfaces=["lo"]),
                "blockedRefused": lambda r: r["command"].update(blocked=0),
                "dnsAllowed": lambda r: r["command"].update(dns=errno.EPERM),
            })
        else:
            flips.update({
                "netNsIsCommandsOwn": lambda r: r["command"]["ns"].update(net="net:[4026532304]"),
                "netNsOwnedByInitialUserns": lambda r: r["commandOutside"]["nsOwner"].update(net={"userns": "user:[4026532300]", "uid": 990}),
                "onlyLoopback": lambda r: r["command"].update(interfaces=["eth0", "lo"]),
                "noRoute": lambda r: r["command"].update(outside=0),
            })
        assert set(flips) | {"fixtureProtocolClean"} == set(checks), set(checks) ^ (set(flips) | {"fixtureProtocolClean"})
        for name, flip in flips.items():
            changed = json.loads(json.dumps(record))
            flip(changed)
            assert checks_for(changed, [])[name] is False, name
        assert checks_for(record, ["synthetic error"])["fixtureProtocolClean"] is False

    with tempfile.TemporaryDirectory(prefix="qorpera-cmdns-wire-") as tmp:
        folder = Path(tmp)
        emit(folder / "early-done.json", {"error": "synthetic failure"})
        try:
            await_record(folder, "early", "ready", 0.5)
            raise AssertionError("an early failure was hidden")
        except RuntimeError as error:
            assert "synthetic failure" in str(error)
        node = FolderNode(folder / "node.sock")
        try:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2)
                client.connect(str(folder / "node.sock"))
                hello = b'H{"protocol":3,"environmentId":"synthetic","viewId":"wire-test","pass":"synthetic-pass","role":"io"}'
                for byte in struct.pack(">I", len(hello)) + hello:
                    client.sendall(bytes([byte]))
                kind, body = receive(client)
                assert kind == "h" and json.loads(body) == {"protocol": 3, "viewId": "wire-test", "asOfSeq": 0, "readOnly": False}
                send(client, "L", {"path": ""})
                kind, body = receive(client)
                assert kind == "l" and json.loads(body)["entries"][0]["name"] == "before.txt"
                send(client, "O", {"path": "from-command.txt", "exclusive": True, "truncate": True})
                kind, body = receive(client)
                handle = json.loads(body)["handle"]
                content = b"written-by-command"
                header = json.dumps({"handle": handle, "index": 0, "offset": 0, "bytes": len(content)}).encode()
                send(client, "K", struct.pack(">I", len(header)) + header + content)
                assert receive(client)[0] == "k"
                send(client, "C", {"handle": handle, "size": len(content)})
                assert receive(client)[0] == "k"
                send(client, "R", {"path": "from-command.txt", "offset": 0, "length": 64})
                assert receive(client) == ("d", content)
                assert node.files["from-command.txt"] == content and not node.errors
        finally:
            node.listener.close()
    print(json.dumps({"logicFixture": "passed", "privilegedProof": "not-run"}))


if __name__ == "__main__":
    action = sys.argv[1]
    if action == "probe":
        probe(Path(sys.argv[2]), sys.argv[3], sys.argv[4])
    elif action == "cleanup":
        cleanup(Path(sys.argv[2]))
    elif action in ("starter", "launcher"):
        try:
            if action == "starter":
                starter_main(int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5])
            else:
                launcher_main(int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
        except Exception as error:
            done = Path(sys.argv[4]) / "starter-done.json"
            if not done.exists():
                emit(done, {"error": repr(error)})
            raise
    elif action == "command":
        try:
            command_main(sys.argv[2])
        except Exception as error:
            emit(Path(SHARE) / "command-done.json", {"error": repr(error)})
            raise
    elif action == "shell-state":
        shell_state_main()
    elif action == "selftest":
        selftest()
    else:
        raise SystemExit(f"unknown action {action}")