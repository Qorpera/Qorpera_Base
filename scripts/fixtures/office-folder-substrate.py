#!/usr/bin/env python3
"""Disposable nested-VM substrate proof, not the office helper implementation.

Real qorpera-folder/FUSE and copied office confinement; a synthetic protocol-v2
node. This does not start the office application. Pathname recovery is tested separately from old descriptors. No SQL,
model, vsock provenance, read-release or helper request-auth proof is claimed.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

LIBC = ctypes.CDLL(None, use_errno=True)
PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4
PR_SET_NO_NEW_PRIVS = 38
PR_SET_PTRACER = 0x59616d61
CLONE_NEWNS = 0x00020000
CLONE_NEWUSER = 0x10000000
CLONE_NEWNET = 0x40000000


def checked(call, *args):
    if call(*args) != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=15).stdout.strip()


def answer(process, seconds=12):
    """Read one JSON line from a piped fixture child; raise on timeout, EOF or a reported error."""
    ready, _, _ = select.select([process.stdout], [], [], seconds)
    if not ready:
        raise TimeoutError("fixture child produced no reply")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("fixture child closed without a reply")
    value = json.loads(line)
    if "error" in value:
        raise RuntimeError(value["error"])
    return value


def init_ns_uids(pid):
    """The real [real, effective, saved, fs] uids of a pid, read from this (init-namespace) vantage point."""
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("Uid:"):
            return [int(part) for part in line.split()[1:]]
    return None


def eventually(check, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    raise TimeoutError("condition did not settle")


def emit(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value))
    temp.replace(path)


def await_record(control, name, phase, seconds=12):
    def check():
        target = control / f"{name}-{phase}.json"
        if target.exists():
            value = json.loads(target.read_text())
            if "error" in value:
                raise RuntimeError(f"{name} {phase}: {value['error']}")
            return value
        done = control / f"{name}-done.json"
        if done.exists():
            value = json.loads(done.read_text())
            raise RuntimeError(f"{name} ended before {phase}: {value.get('error', 'completed without the expected gate')}")
        return None
    return eventually(check, seconds)


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
    """Deliberately small writable stand-in, matching crates/.../tests/support."""
    def __init__(self, path):
        self.files = {"before.txt": b"before"}
        self.handles = {}
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
                assert kind == "H" and hello["protocol"] == 2 and hello["pass"] == "synthetic-pass"
                send(conn, "h", {"protocol": 2, "viewId": hello["viewId"], "asOfSeq": 0, "readOnly": False})
                while True:
                    kind, body = receive(conn)
                    if kind == "a":
                        continue
                    with self.lock:
                        if kind == "K":
                            n = struct.unpack(">I", body[:4])[0]
                            h = json.loads(body[4:4+n])
                            value = body[4+n:]
                            assert h["index"] == 0 and h["offset"] == 0 and len(value) == h["bytes"]
                            assert hashlib.sha256(value).hexdigest() == h["sha256"]
                            self.handles[h["handle"]][1] = value
                            send(conn, "k", {})
                            continue
                        q = json.loads(body)
                        if kind == "L":
                            assert q["path"] == ""
                            send(conn, "l", {"entries": [{"name": name, "kind": "file", "size": len(value), "mtimeMs": 1700000000000, "executable": False, "version": "v1"} for name, value in sorted(self.files.items())], "next": None})
                        elif kind == "R":
                            value = self.files[q["path"]]
                            send(conn, "d", value[q["offset"]:q["offset"]+q["length"]])
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
                            send(conn, "d", value[q["offset"]:q["offset"]+q["length"]])
                        elif kind == "P":
                            send(conn, "p", {"commitId": "synthetic", "seq": 0, "paths": []})
                        else:
                            raise ValueError(f"unsupported fixture operation {kind}")
        except (EOFError, BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.errors.append(repr(error))


def status():
    return {k: v.strip() for k, v in (line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)}


def security_label():
    """This process's LSM label, e.g. AppArmor's `bwrap//&unpriv_bwrap (enforce)`."""
    try:
        return {"securityLabel": Path("/proc/self/attr/current").read_text().strip()}
    except OSError as error:
        return {"securityLabelErrno": error.errno}


def client(control, name):
    """One process stays alive across daemon death; new lookups cannot be cache hits."""
    outcome = {"pid": os.getpid(), "mountNamespace": os.readlink("/proc/self/ns/mnt"), "status": {k: status()[k] for k in ("CapEff", "CapPrm", "NoNewPrivs")}}
    try:
        outcome["before"] = Path("/company/before.txt").read_text()
        try:
            Path(f"/company/{name}-write.txt").write_text("written before restart")
            outcome["writable"] = True
        except OSError as error:
            outcome["writable"] = False
            outcome["writeErrno"] = error.errno
        old = os.open("/company/before.txt", os.O_RDONLY)
        emit(control / f"{name}-ready.json", outcome)
        eventually(lambda: (control / "remounted").exists(), 45)
        try:
            outcome["after"] = Path("/company/after.txt").read_text()
        except OSError as error:
            outcome["afterErrno"] = error.errno
        try:
            Path(f"/company/{name}-after-write.txt").write_text("written after restart")
            outcome["writableAfter"] = True
        except OSError as error:
            outcome["writableAfter"] = False
            outcome["afterWriteErrno"] = error.errno
        try:
            outcome["oldDescriptor"] = os.pread(old, 32, 0).decode()
        except OSError as error:
            outcome["oldDescriptorErrno"] = error.errno
        try:
            os.close(old)
        except OSError as error:
            outcome["oldDescriptorCloseErrno"] = error.errno
        outcome["mountinfo"] = [line for line in Path("/proc/self/mountinfo").read_text().splitlines() if "/company" in line or "/folder-parent" in line]
    except Exception as error:
        outcome["error"] = repr(error)
    emit(control / f"{name}-done.json", outcome)


def shell(control):
    """Plan option (a): shell host has SYS_ADMIN but no NET_ADMIN in its user namespace."""
    start = {"status": status(), "user": os.readlink("/proc/self/ns/user"), "mount": os.readlink("/proc/self/ns/mnt"), "net": os.readlink("/proc/self/ns/net"), "uid": os.geteuid(), **security_label()}
    emit(control / "offline-start.json", start)
    child = os.fork()
    if child:
        os.waitpid(child, 0)
        return
    before_unshare = {}
    try:
        before_unshare = status()
        checked(LIBC.unshare, CLONE_NEWNS | CLONE_NEWNET)
        emit(control / "offline-ready.json", {"net": os.readlink("/proc/self/ns/net"), "user": os.readlink("/proc/self/ns/user"), "beforeUnshare": before_unshare, "status": status()})
        eventually(lambda: (control / "offline-go").exists(), 30)
        # The permitted/effective/inheritable sets become empty before arbitrary command code. NoNewPrivs prevents
        # gaining the remaining namespace bounding bit at exec; --disable-userns prevents a new user namespace.
        header = (ctypes.c_uint32 * 2)(0x20080522, 0)
        data = (ctypes.c_uint32 * 6)()
        checked(LIBC.capset, ctypes.byref(header), ctypes.byref(data))
        checked(LIBC.prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
        links = json.loads(run("ip", "-j", "link", "show"))
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            udp.connect(("192.0.2.1", 9))
            network = "unexpected route"
        except OSError as error:
            network = error.errno
        udp.close()
        # A real loopback connection proves lo was raised, not merely listed.
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen()
        peer = socket.create_connection(server.getsockname(), timeout=2)
        accepted, _ = server.accept()
        peer.close()
        accepted.close()
        server.close()
        attempt = subprocess.run(["ip", "link", "set", "lo", "down"], capture_output=True, timeout=5)
        s = status()
        emit(control / "offline-done.json", {"links": links, "networkErrno": network, "loopbackConnected": True, "netAdminDenied": attempt.returncode != 0, "status": {k: s[k] for k in ("CapEff", "CapPrm", "CapInh", "CapAmb", "NoNewPrivs")}})
    except Exception as error:
        emit(control / "offline-done.json", {"error": repr(error), "beforeUnshare": before_unshare, "status": status()})
    finally:
        os._exit(0)


def helper(control, target):
    """A root privilege primitive only. Production peer/process authorization is not implemented here."""
    checked(LIBC.prctl, PR_SET_DUMPABLE, 0, 0, 0, 0)
    # Remove Yama's relationship restriction as a reason for a passing negative control; credentials and user
    # namespace ownership must still refuse ptrace. This changes this helper only, never a sysctl.
    checked(LIBC.prctl, PR_SET_PTRACER, ctypes.c_ulong(-1), 0, 0, 0)
    before = os.readlink("/proc/self/ns/user")
    fd = os.open(f"/proc/{target}/ns/net", os.O_RDONLY)
    checked(LIBC.setns, fd, CLONE_NEWNET)
    os.close(fd)
    run("ip", "link", "set", "lo", "up")
    # Hold a real helper child at the request gate too, so the attack covers both parent and child.
    child = os.fork()
    if child == 0:
        try:
            checked(LIBC.prctl, PR_SET_PTRACER, ctypes.c_ulong(-1), 0, 0, 0)
            emit(control / "helper-child-ready.json", {"user": os.readlink("/proc/self/ns/user")})
            eventually(lambda: (control / "helper-stop").exists(), 30)
        finally:
            os._exit(0)
    eventually(lambda: (control / "helper-child-ready.json").exists())
    emit(control / "helper-ready.json", {"pid": os.getpid(), "childPid": child, "userBefore": before, "userAfter": os.readlink("/proc/self/ns/user"), "childUser": os.readlink(f"/proc/{child}/ns/user"), "net": os.readlink("/proc/self/ns/net"), **security_label()})
    eventually(lambda: (control / "helper-stop").exists(), 30)
    os.waitpid(child, 0)


def ptrace_control(attacker):
    """Positive control: root like the helper and under the same label, but dumpable and inside the attacker's user
    namespace, so the attacker's namespace SYS_PTRACE must reach it. If it cannot, the denials below prove nothing."""
    fd = os.open(f"/proc/{attacker}/ns/user", os.O_RDONLY)
    checked(LIBC.setns, fd, CLONE_NEWUSER)
    os.close(fd)
    # Changing credentials into a user namespace resets dumpability; set it again, after the switch.
    checked(LIBC.prctl, PR_SET_DUMPABLE, 1, 0, 0, 0)
    checked(LIBC.prctl, PR_SET_PTRACER, ctypes.c_ulong(-1), 0, 0, 0)
    print(json.dumps({"pid": os.getpid(), "user": os.readlink("/proc/self/ns/user"), "dumpable": LIBC.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0), **security_label()}), flush=True)
    sys.stdin.read()


def ptrace_attach(pid):
    ctypes.set_errno(0)
    result = LIBC.ptrace(16, pid, 0, 0)
    error = ctypes.get_errno()
    if result == 0:
        # Collect the attach stop (__WALL) before detaching, so the target runs on.
        os.waitpid(pid, 0x40000000)
        LIBC.ptrace(17, pid, 0, 0)
    return {"attached": result == 0, "denied": result == -1 and error == errno.EPERM, "errno": error}


def attack(helper, child):
    """One attacker process tries the control first, then the helper and its child."""
    print(json.dumps({"pid": os.getpid(), "user": os.readlink("/proc/self/ns/user"), "caps": status()["CapEff"], **security_label()}), flush=True)
    control = int(sys.stdin.readline())
    print(json.dumps({name: ptrace_attach(pid) for name, pid in (("control", control), ("helper", helper), ("child", child))}), flush=True)


def ptrace_checks(attacker, results, control, helper):
    """The denials count only together with the control: the same attacker, holding SYS_PTRACE in its own user
    namespace, attached to a root process under the helper's label that is dumpable and inside that namespace."""
    capable = int(attacker.get("caps", "0"), 16) & (1 << 19) != 0 and attacker.get("user") not in (None, helper.get("userBefore"))
    return {
        "ptracePositiveControl": capable and results.get("control", {}).get("attached") is True and control.get("uids") == [0, 0, 0, 0] and control.get("user") == attacker["user"] and control.get("dumpable") == 1 and control.get("securityLabel") == helper.get("securityLabel"),
        "helperAndChildPtraceDenied": capable and all(results.get(name, {}).get("denied") is True for name in ("helper", "child")),
    }


def bwrap(directory, mode):
    control = directory / "control"
    args = ["bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
    if mode == "offline":
        args += ["--cap-add", "CAP_SYS_ADMIN"]
    args += ["--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", str(control), "/control", "--ro-bind", str(directory / "probe.py"), "/probe.py", "--setenv", "PATH", "/usr/bin:/bin"]
    if mode == "direct":
        args += ["--bind", str(directory / "parent/company"), "/company"]
    elif mode == "propagated":
        args += ["--bind", str(directory / "parent"), "/folder-parent", "--symlink", "/folder-parent/company", "/company"]
    args += ["--remount-ro", "/", "--", "python3", "/probe.py"]
    return args + (["shell", "/control"] if mode == "offline" else ["client", "/control", mode])


def require_disposable_guest(directory):
    if os.geteuid() != 0 or run("systemd-detect-virt", "--vm") != "kvm":
        raise RuntimeError("A root process inside a nested KVM guest is required")
    if Path("/etc/qorpera-test-machine-versions").exists():
        raise RuntimeError("Never run this fixture on the shared test VM")
    if not re.fullmatch(r"/run/qorpera-substrate-[a-f0-9-]{36}", str(directory)):
        raise RuntimeError("Refusing a path outside the UUID-scoped probe directory")


def cleanup(directory):
    require_disposable_guest(directory)
    for mode in ("probe", "direct", "propagated", "offline"):
        run("systemctl", "stop", f"{directory.name}-{mode}.service", check=False)
    run("umount", "-l", str(directory / "parent/company"), check=False)
    run("umount", "-l", str(directory / "parent"), check=False)
    shutil.rmtree(directory)


def owner_arguments(mode, uid, gid):
    if mode == "root-default":
        return []
    if mode != "office-account":
        raise ValueError("Unknown owner mode")
    if any(type(value) is not int or not 0 <= value < 4294967295 for value in (uid, gid)):
        raise ValueError("Invalid mount owner")
    return ["--owner-uid", str(uid), "--owner-gid", str(gid)]


def probe(directory, owner_mode):
    require_disposable_guest(directory)
    started = int(time.time())
    if not Path("/dev/fuse").exists():
        raise RuntimeError("Image must already provide /dev/fuse; no modprobe here")
    office = pwd.getpwnam("qorpera-office")
    if office.pw_uid == 0:
        raise RuntimeError("The office account must be unprivileged")
    owner_args = owner_arguments(owner_mode, office.pw_uid, office.pw_gid)
    control = directory / "control"
    control.mkdir(mode=0o700)
    os.chown(control, office.pw_uid, office.pw_gid)
    (directory / "parent/company").mkdir(parents=True)
    (directory / "state").mkdir(mode=0o700)
    view = directory / "view.json"
    view.write_text(json.dumps({"environmentId": "synthetic", "viewId": "synthetic", "pass": "synthetic-pass"}))
    view.chmod(0o600)
    run("mount", "--bind", str(directory / "parent"), str(directory / "parent"))
    run("mount", "--make-rshared", str(directory / "parent"))
    node = FolderNode(directory / "node.sock")
    children = []
    record = {"result": "failed", "ownerMode": owner_mode, "daemonUid": os.geteuid(), "daemonGid": os.getegid(), "requestedOwner": {"uid": office.pw_uid, "gid": office.pw_gid} if owner_args else None, "mountOwners": [], "limitations": ["Synthetic Unix-socket folder service, no database or vsock identity proof", "Copied office confinement, not a running office application or desktop", "Candidate parent-bind alias, not implemented office integration", "Offline helper primitive only; no production request authorization or command mount attachment", "Existing descriptors do not migrate to a new FUSE connection"]}
    # Reuse every confinement setting, not operational credentials, startup bindings or production cgroups.
    properties = []
    keys = {"User", "Group", "UMask", "LimitCORE", "PrivateTmp", "PrivateDevices", "ProtectSystem", "ProtectHome", "ProtectProc", "ProcSubset", "ProtectHostname", "ProtectClock", "ProtectKernelTunables", "ProtectKernelLogs", "ProtectKernelModules", "ProtectControlGroups", "NoNewPrivileges", "CapabilityBoundingSet", "AmbientCapabilities", "RestrictNamespaces", "RestrictAddressFamilies", "RestrictSUIDSGID", "LockPersonality", "MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuota", "InaccessiblePaths"}
    for line in (directory / "office.service").read_text().splitlines():
        if line.split("=", 1)[0] in keys:
            properties += ["--property", line]
    properties += ["--property", f"ReadWritePaths={directory}", "--property", "RuntimeMaxSec=120", "--property", "KillMode=control-group"]
    record["confinementProperties"] = properties

    def start_mount():
        log = open(directory / f"mount-{len(children)}.log", "w")
        child = subprocess.Popen([str(directory / "qorpera-folder"), "mount", "--connect", f"unix:{directory}/node.sock", "--view-file", str(view), "--mountpoint", str(directory / "parent/company"), "--state-dir", str(directory / "state"), "--allow-other", "yes", *owner_args], stdout=log, stderr=log)
        log.close()
        children.append(child)
        eventually(lambda: "before" == (directory / "parent/company/before.txt").read_text())
        attrs = (directory / "parent/company").stat()
        record["mountOwners"].append({"uid": attrs.st_uid, "gid": attrs.st_gid, "permissions": oct(attrs.st_mode & 0o777)})
        return child

    def piped(name, *command):
        log = open(directory / f"{name}.log", "w")
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, bufsize=0)
        log.close()
        children.append(child)
        return child

    try:
        daemon = start_mount()
        for mode in ("direct", "propagated", "offline"):
            run("systemd-run", "--quiet", "--collect", "--unit", f"{directory.name}-{mode}", *properties, "--", *bwrap(directory, mode))
        for mode in ("direct", "propagated"):
            record[f"{mode}Before"] = await_record(control, mode, "ready")
        daemon.kill()
        daemon.wait(timeout=5)
        run("umount", "-l", str(directory / "parent/company"))
        with node.lock:
            node.files["after.txt"] = b"after remount"
        start_mount()
        (control / "remounted").touch()
        for mode in ("direct", "propagated"):
            record[mode] = await_record(control, mode, "done")
        p, d = record["propagated"], record["direct"]
        expected_uid, expected_gid = (office.pw_uid, office.pw_gid) if owner_args else (os.geteuid(), os.getegid())
        record["checks"] = {
            "mountOwnershipApplied": len(record["mountOwners"]) == 2 and all(m["uid"] == expected_uid and m["gid"] == expected_gid and m["permissions"] == "0o755" for m in record["mountOwners"]),
            "directBindNegativeControl": d.get("afterErrno") == errno.ENOTCONN,
            "runningNamespaceRecovered": p.get("after") == "after remount" and p["pid"] == record["propagatedBefore"]["pid"],
            "officeCanWrite": p.get("writable") is True and node.files.get("propagated-write.txt") == b"written before restart",
            "officeCanWriteAfterRemount": p.get("writableAfter") is True and node.files.get("propagated-after-write.txt") == b"written after restart",
        }
        offline = await_record(control, "offline", "ready")
        def find_target():
            for p in Path("/proc").iterdir():
                try:
                    if p.name.isdigit() and os.readlink(p / "ns/net") == offline["net"]:
                        uid = next(line.split()[1] for line in (p / "status").read_text().splitlines() if line.startswith("Uid:"))
                        if int(uid) == office.pw_uid:
                            return int(p.name)
                except OSError:
                    continue
            return None
        target = eventually(find_target)
        privileged = subprocess.Popen(["python3", str(directory / "probe.py"), "helper", str(control), str(target)])
        children.append(privileged)
        info = await_record(control, "helper", "ready")
        record["helper"] = info
        # The attacking office user has all capabilities in a user namespace it owns, including SYS_PTRACE,
        # while seeing the helper's real PID. No PID-namespace invisibility or Yama relationship hides it.
        attacker = piped("ptrace-attacker", "setpriv", f"--reuid={office.pw_uid}", f"--regid={office.pw_gid}", "--clear-groups", "bwrap", "--unshare-user", "--die-with-parent", "--cap-add", "ALL", "--ro-bind", "/", "/", "--", "python3", str(directory / "probe.py"), "attack", str(info["pid"]), str(info["childPid"]))
        record["ptraceAttacker"] = answer(attacker)
        positive = piped("ptrace-control", "python3", str(directory / "probe.py"), "ptrace-control", str(record["ptraceAttacker"]["pid"]))
        reply = answer(positive)
        record["ptraceControl"] = {**reply, "uids": init_ns_uids(reply["pid"])}
        attacker.stdin.write(f"{reply['pid']}\n".encode())
        record["ptrace"] = answer(attacker)
        positive.stdin.close()
        (control / "offline-go").touch()
        record["offline"] = await_record(control, "offline", "done")
        (control / "helper-stop").touch()
        o = record["offline"]
        record["checks"].update({
            "helperNeverEnteredUserNamespace": info["userBefore"] == info["userAfter"] == info["childUser"] == os.readlink("/proc/self/ns/user"),
            **ptrace_checks(record["ptraceAttacker"], record["ptrace"], record["ptraceControl"], info),
            "offlineOnlyLoopback": [link["ifname"] for link in o.get("links", [])] == ["lo"] and o.get("loopbackConnected") is True and o.get("networkErrno") == errno.ENETUNREACH,
            "commandHasNoCapabilities": all(int(o.get("status", {}).get(k, "1"), 16) == 0 for k in ("CapEff", "CapPrm", "CapInh", "CapAmb")) and o.get("status", {}).get("NoNewPrivs") == "1" and o.get("netAdminDenied") is True,
            "fixtureProtocolClean": not node.errors,
        })
        record["result"] = "passed" if all(record["checks"].values()) else "failed"
    except Exception as error:
        record["error"] = repr(error)
    finally:
        for mode in ("direct", "propagated", "offline"):
            run("systemctl", "stop", f"{directory.name}-{mode}.service", check=False)
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        record["protocolErrors"] = node.errors
        record["controlRecords"] = {}
        for path in control.glob("*.json"):
            try:
                record["controlRecords"][path.name] = json.loads(path.read_text())
            except (OSError, ValueError) as error:
                record["controlRecords"][path.name] = {"unreadable": repr(error)}
        record["mountLogs"] = [p.read_text() for p in directory.glob("mount-*.log")]
        record["ptraceLogs"] = {p.stem: p.read_text() for p in directory.glob("ptrace-*.log")}
        kernel = run("journalctl", "-k", "--no-pager", "--since", f"@{started}", "-n", "100", check=False)
        record["kernelDenials"] = [line for line in kernel.splitlines() if "DENIED" in line or "apparmor=" in line or "SECCOMP" in line]
        record["units"] = {mode: run("journalctl", "--no-pager", "-n", "30", "-u", f"{directory.name}-{mode}.service", check=False) for mode in ("direct", "propagated", "offline")}
        print(json.dumps(record))


def selftest():
    """Unprivileged wire fixture check; deliberately does not claim a FUSE/namespace proof."""
    assert owner_arguments("root-default", 1000, 1001) == []
    assert owner_arguments("office-account", 1000, 1001) == ["--owner-uid", "1000", "--owner-gid", "1001"]
    for mode, uid, gid in (("unknown", 1000, 1001), ("office-account", -1, 1001), ("office-account", 1000, 4294967295), ("office-account", "1000", 1001)):
        try:
            owner_arguments(mode, uid, gid)
            raise AssertionError("invalid owner mode or IDs accepted")
        except ValueError:
            pass
    helper = {"userBefore": "user:[1]", "securityLabel": "unconfined"}
    attacker = {"user": "user:[2]", "caps": "000001ffffffffff"}
    positive = {"uids": [0, 0, 0, 0], "user": "user:[2]", "dumpable": 1, "securityLabel": "unconfined"}
    attached = {"attached": True, "denied": False, "errno": 0}
    denied = {"attached": False, "denied": True, "errno": errno.EPERM}
    assert ptrace_checks(attacker, {"control": attached, "helper": denied, "child": denied}, positive, helper) == {"ptracePositiveControl": True, "helperAndChildPtraceDenied": True}
    # A denied control means AppArmor or Yama may have refused the attacker, not the helper's own state.
    assert ptrace_checks(attacker, {"control": denied, "helper": denied, "child": denied}, positive, helper) == {"ptracePositiveControl": False, "helperAndChildPtraceDenied": True}
    assert ptrace_checks(attacker, {"helper": denied, "child": denied}, {}, helper)["ptracePositiveControl"] is False
    for change in ({"uids": [1000, 1000, 1000, 1000]}, {"user": "user:[1]"}, {"dumpable": 2}, {"securityLabel": "bwrap//&unpriv_bwrap (enforce)"}):
        assert ptrace_checks(attacker, {"control": attached, "helper": denied, "child": denied}, {**positive, **change}, helper)["ptracePositiveControl"] is False
    for change in ({"caps": "0000000000000000"}, {"user": "user:[1]"}):
        assert ptrace_checks({**attacker, **change}, {"control": attached, "helper": denied, "child": denied}, positive, helper) == {"ptracePositiveControl": False, "helperAndChildPtraceDenied": False}
    assert ptrace_checks(attacker, {"control": attached, "helper": attached, "child": denied}, positive, helper)["helperAndChildPtraceDenied"] is False
    with tempfile.TemporaryDirectory(prefix="qorpera-substrate-wire-") as tmp:
        control = Path(tmp)
        emit(control / "early-done.json", {"error": "synthetic namespace failure", "status": {"CapEff": "0"}})
        try:
            await_record(control, "early", "ready", 0.5)
            raise AssertionError("early failure was hidden")
        except RuntimeError as error:
            assert "synthetic namespace failure" in str(error)
        emit(control / "ready-ready.json", {"pid": 123})
        assert await_record(control, "ready", "ready") == {"pid": 123}
        node = FolderNode(Path(tmp) / "node.sock")
        try:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2)
                client.connect(str(Path(tmp) / "node.sock"))
                # Byte-at-a-time framing catches reads that incorrectly assume recv returns a whole frame.
                hello = b'H{"protocol":2,"viewId":"wire-test","pass":"synthetic-pass"}'
                for byte in struct.pack(">I", len(hello)) + hello:
                    client.sendall(bytes([byte]))
                kind, body = receive(client)
                assert kind == "h" and json.loads(body)["readOnly"] is False
                send(client, "L", {"path": ""})
                kind, body = receive(client)
                assert kind == "l" and json.loads(body)["entries"][0]["name"] == "before.txt"
                send(client, "O", {"path": "written.txt", "exclusive": True, "truncate": True})
                kind, body = receive(client)
                assert kind == "o"
                handle = json.loads(body)["handle"]
                content = b"persistent bytes"
                header = json.dumps({"handle": handle, "index": 0, "offset": 0, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}).encode()
                send(client, "K", struct.pack(">I", len(header)) + header + content)
                assert receive(client)[0] == "k"
                send(client, "C", {"handle": handle, "size": len(content)})
                assert receive(client)[0] == "k"
                send(client, "R", {"path": "written.txt", "offset": 3, "length": 6})
                assert receive(client) == ("d", b"sisten")
                send(client, "O", {"path": "written.txt", "exclusive": True, "truncate": True})
                kind, body = receive(client)
                assert kind == "e" and json.loads(body)["code"] == "EXISTS"
                assert node.files["written.txt"] == content and not node.errors
            for size in (0, 2 * 1024 * 1024 + 2):
                a, b = socket.socketpair()
                try:
                    a.sendall(struct.pack(">I", size))
                    try:
                        receive(b)
                        raise AssertionError("invalid frame accepted")
                    except ValueError:
                        pass
                finally:
                    a.close()
                    b.close()
        finally:
            node.listener.close()
    print(json.dumps({"wireFixture": "passed", "privilegedProof": "not-run"}))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "probe":
        probe(Path(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "root-default")
    elif mode == "cleanup":
        cleanup(Path(sys.argv[2]))
    elif mode == "client":
        client(Path(sys.argv[2]), sys.argv[3])
    elif mode == "shell":
        shell(Path(sys.argv[2]))
    elif mode == "helper":
        try:
            helper(Path(sys.argv[2]), int(sys.argv[3]))
        except Exception as error:
            emit(Path(sys.argv[2]) / "helper-done.json", {"error": repr(error), "status": status()})
            raise
    elif mode in ("ptrace-control", "attack"):
        # These answer the probe on a pipe, so a failure reaches it as an answer too.
        try:
            if mode == "ptrace-control":
                ptrace_control(int(sys.argv[2]))
            else:
                attack(int(sys.argv[2]), int(sys.argv[3]))
        except Exception as error:
            print(json.dumps({"error": repr(error)}), flush=True)
            raise
    elif mode == "selftest":
        selftest()
    else:
        raise ValueError("unknown fixture mode")
