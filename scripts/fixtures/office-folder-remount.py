#!/usr/bin/env python3
"""Disposable nested-VM proof for Q3: do running office namespaces follow a company folder mount systemd restarts?

The real qorpera-folder program runs under master's mount unit, with only its paths moved to #1047's /run layout and a
synthetic protocol-3 node on a Unix socket. Office namespaces are started by the runtime's own process gate with the
runtime's bubblewrap arguments, from a relay that carries every confinement line of master's office unit. This is not
the office helper or the office application: no plumber, credentials, vsock identity, SQL or model is claimed.
"""
import difflib
import errno
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
# The substrate proof's wire helpers and synthetic node, unchanged.
_spec = importlib.util.spec_from_file_location("office_folder_substrate", HERE / "office-folder-substrate.py")
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)

ROOT = Path("/run/qorpera-folder")
# Not master's unit name, so nothing the image itself carries is shadowed or started.
UNIT = "qorpera-office-folder-mount@{}.service"
UNIT_FILE = Path("/run/systemd/system/qorpera-office-folder-mount@.service")
OFFICE_UNIT = "qorpera-company-computer.service"
# The mountpoint's mode while nothing is mounted over it, in the order tried: the main run uses the first one the
# unit's own mount user (root holding only CAP_SYS_ADMIN) serves over.
MODES = ("0000", "0700", "0755")
CONFINEMENT = {"User", "Group", "UMask", "LimitCORE", "PrivateTmp", "PrivateDevices", "ProtectSystem", "ProtectHome", "ProtectProc", "ProcSubset", "ProtectHostname", "ProtectClock", "ProtectKernelTunables", "ProtectKernelLogs", "ProtectKernelModules", "ProtectControlGroups", "NoNewPrivileges", "CapabilityBoundingSet", "AmbientCapabilities", "RestrictNamespaces", "RestrictAddressFamilies", "RestrictSUIDSGID", "LockPersonality", "MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuota", "InaccessiblePaths"}
# What the office service needs to run the application, not to confine it: recorded as left out.
OPERATIONAL = {"Type", "StateDirectory", "StateDirectoryMode", "WorkingDirectory", "Environment", "LoadCredential", "ExecStart", "Restart", "RestartSec", "KillMode", "KillSignal", "SendSIGKILL", "TimeoutStopSec", "ReadWritePaths"}
# Master's mount unit lines that name /etc and /srv, and what they become in #1047's layout (None: dropped).
MOUNT_LINES = {
    "ConditionPathExists=/etc/qorpera-folder/mounts/%i.json": "ConditionPathExists=/run/qorpera-folder/views/%i.json",
    "ExecStartPre=/usr/bin/install -d -o root -g root -m 0700 /srv/qorpera-folder": None,
    "ExecStartPre=/usr/bin/install -d -o root -g root -m 0755 /srv/qorpera-folder/%i": None,
    "ExecStart=/opt/qorpera-folder/qorpera-folder mount --view-file /etc/qorpera-folder/mounts/%i.json --mountpoint /srv/qorpera-folder/%i": "ExecStart={program} mount --connect unix:{socket} --view-file /run/qorpera-folder/views/%i.json --mountpoint /run/qorpera-folder/mounts/%i/company --state-dir /run/qorpera-folder/state/%i --allow-other yes --owner-uid {uid} --owner-gid {gid}",
    "ExecStopPost=-/usr/bin/umount -l /srv/qorpera-folder/%i": "ExecStopPost=-/usr/bin/umount -l /run/qorpera-folder/mounts/%i/company",
    # Started by the proof only, never at boot.
    "[Install]": None,
    "WantedBy=multi-user.target": None,
}
SHOWN = ("MainPID", "NRestarts", "ExecMainStatus", "ExecMainCode", "ActiveState", "SubState", "Result")


def proof_unit(text, program, node_socket, uid, gid):
    """Master's mount unit with its paths moved to #1047's layout, the synthetic node's socket, and no [Install]."""
    if any(type(value) is not int or not 0 < value < 4294967295 for value in (uid, gid)):
        raise ValueError("Invalid mount owner")
    lines = text.splitlines()
    for old in MOUNT_LINES:
        if lines.count(old) != 1:
            raise ValueError(f"master's mount unit no longer has exactly one line {old!r}")
    out = []
    for line in lines:
        if line not in MOUNT_LINES:
            out.append(line)
        elif MOUNT_LINES[line] is not None:
            out.append(MOUNT_LINES[line].format(program=program, socket=node_socket, uid=uid, gid=gid))
    for line in out:
        if not line.startswith("#") and ("/srv/" in line or "/etc/qorpera-folder" in line):
            raise ValueError(f"an unmoved path is left: {line!r}")
    return "\n".join(out) + "\n"


def office_lines(text):
    """The [Service] lines of master's office unit: confinement for the relay, the rest recorded as left out."""
    taken, skipped, section = [], [], None
    for line in (raw.strip() for raw in text.splitlines()):
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            section = line
            continue
        if section != "[Service]":
            continue
        key = line.split("=", 1)[0]
        if key in CONFINEMENT:
            taken.append(line)
        elif key in OPERATIONAL:
            skipped.append(line)
        else:
            raise ValueError(f"unclassified office unit line {line!r}")
    missing = CONFINEMENT - {line.split("=", 1)[0] for line in taken}
    if missing:
        raise ValueError(f"office unit lacks confinement {sorted(missing)}")
    return taken, skipped


def decode(field):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), field)


def mountinfo(text=None):
    """Parsed like #1047's parseCompanyComputerMountinfo: mountpoint, optional fields, type and source."""
    entries = []
    for line in (Path("/proc/self/mountinfo").read_text() if text is None else text).splitlines():
        fields = line.split(" ")
        if "-" not in fields[6:]:
            continue
        dash = fields.index("-", 6)
        entries.append({"mountpoint": decode(fields[4]), "options": fields[5], "optional": fields[6:dash], "fstype": fields[dash + 1], "source": decode(fields[dash + 2])})
    return entries


def at(path, entries):
    return [entry for entry in entries if entry["mountpoint"] == str(path)]


def served(path, entries=None):
    """#1047's test: the top mount at the path is the folder program's."""
    top = at(path, mountinfo() if entries is None else entries)
    return bool(top) and top[-1]["fstype"] == "fuse.qorpera" and top[-1]["source"] == "qorpera-company"


def shared(path, entries=None):
    top = at(path, mountinfo() if entries is None else entries)
    return bool(top) and any(field.startswith("shared:") for field in top[-1]["optional"])


def count(path, entries=None):
    """Folder mounts stacked at the path: a dead one left under a live one counts too."""
    return sum(1 for entry in at(path, mountinfo() if entries is None else entries) if entry["fstype"] == "fuse.qorpera")


def show(unit):
    values = dict(line.split("=", 1) for line in base.run("systemctl", "show", "-p", ",".join(SHOWN), unit).splitlines() if "=" in line)
    for key in ("MainPID", "NRestarts", "ExecMainStatus", "ExecMainCode"):
        if re.fullmatch(r"-?[0-9]+", values.get(key, "")):
            values[key] = int(values[key])
    return values


def version(value):
    return "v-" + hashlib.sha256(value).hexdigest()[:16]


class RemountNode(base.FolderNode):
    """The substrate's synthetic node with what a restart needs: per-view hellos, an abandon that drops the earlier
    mount's open handles, feed heartbeats, a closed view, and versions that change with content."""
    def __init__(self, path, heartbeat=10):
        self.hellos = []
        self.ops = []
        self.feeds = []
        self.closed_views = set()
        self.owners = {}
        self.parts = {}
        self.numbers = itertools.count(1)
        self.sending = threading.Lock()
        self.stopped = threading.Event()
        self.heartbeat = heartbeat
        super().__init__(path)
        with self.lock:
            # Files an earlier mount opens and loses: one truncated at open, one rewritten in place.
            self.files["loss-truncate.txt"] = b"saved before"
            self.files["loss-keep.txt"] = b"saved before"
        threading.Thread(target=self.beat, daemon=True).start()

    def beat(self):
        """The node's feed heartbeat: a change with no paths, so the program's 45 s feed timeout never fires."""
        while not self.stopped.wait(self.heartbeat):
            with self.sending:
                for feed in list(self.feeds):
                    try:
                        base.send(feed[1], "c", {"seq": 0, "resync": False, "paths": []})
                    except OSError:
                        self.feeds.remove(feed)

    def close_view(self, view):
        """What the node does when a view ends: the mount hears VIEW_CLOSED on its feed and exits 3."""
        with self.sending:
            self.closed_views.add(view)
            for feed in [feed for feed in self.feeds if feed[0] == view]:
                try:
                    base.send(feed[1], "e", {"code": "VIEW_CLOSED", "message": "the view is closed"})
                except OSError:
                    pass

    def close(self):
        self.stopped.set()
        self.listener.close()

    def serve(self, conn):
        feed = None
        try:
            with conn:
                kind, body = base.receive(conn)
                hello = json.loads(body)
                assert kind == "H" and hello["protocol"] == base.PROTOCOL and hello["pass"] == "synthetic-pass"
                assert hello["role"] in ("io", "feed")
                view = hello["viewId"]
                with self.lock:
                    self.hellos.append({"at": time.monotonic(), "viewId": view, "role": hello["role"], "abandon": bool(hello.get("abandon"))})
                    if view in self.closed_views:
                        base.send(conn, "e", {"code": "VIEW_CLOSED", "message": "the view is closed"})
                        return
                    if hello.get("abandon"):
                        # The earlier mount's open handles go; nothing it never committed is kept.
                        dropped = sorted(self.handles[handle][0] for handle, owner in self.owners.items() if owner == view)
                        for handle in [handle for handle, owner in self.owners.items() if owner == view]:
                            self.handles.pop(handle, None)
                            self.owners.pop(handle)
                        self.ops.append({"at": time.monotonic(), "op": "abandoned", "viewId": view, "names": dropped})
                with self.sending:
                    base.send(conn, "h", {"protocol": base.PROTOCOL, "viewId": view, "asOfSeq": 0, "readOnly": False})
                    if hello["role"] == "feed":
                        feed = (view, conn)
                        self.feeds.append(feed)
                while True:
                    kind, body = base.receive(conn)
                    if feed:
                        assert kind == "a", f"feed sent {kind}"
                        continue
                    with self.lock:
                        reply = self.operate(view, kind, body)
                    base.send(conn, *reply)
        except (EOFError, BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.errors.append(repr(error))
        finally:
            if feed:
                with self.sending:
                    if feed in self.feeds:
                        self.feeds.remove(feed)

    def operate(self, view, kind, body):
        if kind == "K":
            size = struct.unpack(">I", body[:4])[0]
            part = json.loads(body[4:4 + size])
            data = body[4 + size:]
            assert part["index"] == 0 and part["handle"] in self.handles
            key = (part["handle"], part["index"])
            if part["offset"] == 0:
                self.parts[key] = b""
            assert part["offset"] == len(self.parts[key])
            self.parts[key] += data
            if len(self.parts[key]) == part["bytes"]:
                chunk = self.parts.pop(key)
                assert hashlib.sha256(chunk).hexdigest() == part["sha256"]
                self.handles[part["handle"]][1] = chunk
            return "k", {}
        request = json.loads(body)
        if kind == "I":
            # The substrate's rule: the reads a write hands over are taken only as a consecutive prefix.
            reads = request["reads"]
            taken = self.logs.get(request["log"], reads[0]["seq"] - 1 if reads else 0)
            for read in reads:
                if read["seq"] <= taken:
                    continue
                assert read["seq"] == taken + 1
                taken = read["seq"]
            self.logs[request["log"]] = taken
            return "i", {"log": request["log"], "taken": taken, "released": taken}
        if kind == "L":
            assert request["path"] == ""
            return "l", {"entries": [{"name": name, "kind": "file", "size": len(value), "mtimeMs": 1700000000000, "executable": False, "version": version(value)} for name, value in sorted(self.files.items())], "next": None}
        if kind == "R":
            value = self.files[request["path"]]
            return "d", value[request["offset"]:request["offset"] + request["length"]]
        if kind == "O":
            name = request["path"]
            if request["exclusive"] and name in self.files:
                return "e", {"code": "EXISTS", "message": ""}
            assert request["create"] or name in self.files, f"open of a missing {name}"
            if request["truncate"] or name not in self.files:
                # A truncating open empties the file at once; a new one exists, empty, from its open.
                self.files[name] = b""
            handle = next(self.numbers)
            self.handles[handle] = [name, self.files[name]]
            self.owners[handle] = view
            self.ops.append({"at": time.monotonic(), "op": "open", "viewId": view, "name": name, "handle": handle, "create": request["create"], "truncate": request["truncate"]})
            return "o", {"handle": handle, "size": len(self.files[name]), "version": version(self.files[name])}
        if kind == "C":
            name, value = self.handles.pop(request["handle"])
            self.owners.pop(request["handle"], None)
            assert len(value) == request["size"]
            self.files[name] = value
            self.ops.append({"at": time.monotonic(), "op": "commit", "viewId": view, "name": name})
            return "k", {"version": version(value)}
        if kind == "G":
            value = self.handles[request["handle"]][1]
            return "d", value[request["offset"]:request["offset"] + request["length"]]
        if kind == "P":
            return "p", {"commitId": "synthetic", "seq": 0, "paths": []}
        raise ValueError(f"unsupported fixture operation {kind}")


def quiet(*args, seconds=30):
    """A cleanup command: its outcome is recorded, never raised."""
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=seconds)
        return {"command": list(args), "code": done.returncode, "output": (done.stdout + done.stderr).strip()[-2000:]}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"command": list(args), "failure": repr(error)}


def make_root():
    """#1047's layout root: views and state for root only, mounts for anyone to reach."""
    for path, mode in ((ROOT, 0o755), (ROOT / "views", 0o700), (ROOT / "state", 0o700), (ROOT / "mounts", 0o755)):
        path.mkdir(mode=mode)
        path.chmod(mode)


def lay_out(view, mode):
    """One view in #1047's layout, with the bare mountpoint at the given mode and its parent a shared mount."""
    state = ROOT / "state" / view
    state.mkdir(mode=0o700)
    state.chmod(0o700)
    parent = ROOT / "mounts" / view
    parent.mkdir()
    parent.chmod(0o755)
    point = parent / "company"
    point.mkdir()
    point.chmod(int(mode, 8))
    descriptor = os.open(ROOT / "views" / f"{view}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump({"environmentId": "synthetic", "viewId": view, "pass": "synthetic-pass"}, file)
    base.run("mount", "--bind", str(parent), str(parent))
    base.run("mount", "--make-rshared", str(parent))
    if not shared(parent):
        raise RuntimeError(f"{parent} is not a shared mount")
    return point


def tear_view(view):
    """Stops the view's mount unit and removes its mounts and files; returns what each step did."""
    unit = UNIT.format(view)
    steps = [quiet("systemctl", "stop", unit), quiet("systemctl", "reset-failed", unit)]
    parent = ROOT / "mounts" / view
    for path in (parent / "company", parent):
        for _ in range(5):
            if not at(path, mountinfo()):
                break
            steps.append(quiet("umount", "-l", str(path)))
    for path in (parent / "company", parent):
        if path.is_dir() and not at(path, mountinfo()):
            path.rmdir()
    shutil.rmtree(ROOT / "state" / view, ignore_errors=True)
    (ROOT / "views" / f"{view}.json").unlink(missing_ok=True)
    return steps


class Relay:
    """The office side: a transient unit with the office unit's confinement, running office-folder-remount-office.mjs
    as the office account. Each one is a new mount namespace that systemd set up when it started."""
    def __init__(self, directory, number, node, properties):
        self.unit = f"{directory.name}-relay{number}"
        self.log = directory / f"relay{number}.log"
        with open(self.log, "w") as log:
            self.process = subprocess.Popen(["systemd-run", "--quiet", "--pipe", "--wait", "--collect", "--unit", self.unit, *properties, "--", node, str(directory / "office.mjs"), str(directory)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, bufsize=0)
        self.ids = itertools.count(1)

    def call(self, op, seconds=45, **fields):
        number = next(self.ids)
        self.process.stdin.write((json.dumps({"id": number, "op": op, **fields}) + "\n").encode())
        reply = base.answer(self.process, seconds)
        if reply.get("id") != number:
            raise RuntimeError(f"relay answered {reply.get('id')} for {number}")
        reply.pop("id")
        return reply

    def client(self, name, request, seconds=45):
        """One request to one namespace's client; a client that stopped answering comes back as callError."""
        reply = self.call("call", seconds, name=name, request=request)
        return reply.get("reply", reply)

    def close(self):
        steps = []
        if self.process.poll() is None:
            try:
                steps.append(self.call("exit", 30))
            except (OSError, RuntimeError, TimeoutError, ValueError) as error:
                steps.append({"exitFailure": repr(error)})
        steps.append(quiet("systemctl", "stop", self.unit))
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            self.process.kill()
        return steps


def relay_properties(office_text, directory, writable_mounts=False):
    taken, _ = office_lines(office_text)
    properties = [part for line in taken for part in ("--property", line)]
    properties += ["--property", f"ReadWritePaths={directory / 'standin'}", "--property", "RuntimeMaxSec=420", "--property", "KillMode=control-group"]
    if writable_mounts:
        # The variant measured beside the plain one: the office unit naming the folder mounts writable.
        properties += ["--property", f"ReadWritePaths=-{ROOT / 'mounts'}"]
    return properties


def claim(directory, claimed, key, value=True):
    """What this run created, written before it is created, so cleanup removes only that."""
    claimed[key] = value
    (directory / "claimed.json").write_text(json.dumps(claimed))


def stand_in(directory, office, shapes):
    """The office's private surface stand-ins: what the runtime binds from its state directory and the image."""
    standin = directory / "standin"
    standin.mkdir(mode=0o755)
    standin.chmod(0o755)
    for name in ("workbench", "home", "screen", "x11", "session"):
        (standin / name).mkdir(mode=0o700)
        os.chown(standin / name, office.pw_uid, office.pw_gid)
    for name, text, mode, owner in (("machine-id", os.urandom(16).hex() + "\n", 0o400, office), ("hosts", shapes["standins"]["hosts"], 0o444, None), ("resolv.conf", shapes["standins"]["resolv.conf"], 0o444, None)):
        (standin / name).write_text(text)
        (standin / name).chmod(mode)
        if owner:
            os.chown(standin / name, owner.pw_uid, owner.pw_gid)
    return standin


def install_program(directory, claimed):
    """The folder program where the unit can run it: /run may be mounted noexec."""
    home = Path("/var/lib") / directory.name
    if home.exists():
        raise RuntimeError(f"{home} already exists")
    claim(directory, claimed, "program", str(home))
    home.mkdir(mode=0o755)
    home.chmod(0o755)
    program = home / "qorpera-folder"
    shutil.copyfile(directory / "qorpera-folder", program)
    program.chmod(0o555)
    return program


def install_unit(directory, claimed, program, office):
    text = proof_unit((directory / "mount.service").read_text(), program, directory / "node.sock", office.pw_uid, office.pw_gid)
    if UNIT_FILE.exists():
        raise RuntimeError(f"{UNIT_FILE} already exists")
    claim(directory, claimed, "unit", str(UNIT_FILE))
    UNIT_FILE.write_text(text)
    UNIT_FILE.chmod(0o644)
    base.run("systemctl", "daemon-reload")
    return text


def require_disposable_guest(directory):
    if os.geteuid() != 0 or base.run("systemd-detect-virt", "--vm", check=False) != "kvm":
        raise RuntimeError("A root process inside a nested KVM guest is required")
    if Path("/etc/qorpera-test-machine-versions").exists():
        raise RuntimeError("Never run this fixture on the shared test VM")
    if not re.fullmatch(r"/run/qorpera-remount-[a-f0-9-]{36}", str(directory)):
        raise RuntimeError("Refusing a path outside the UUID-scoped proof directory")


def preflight(directory, fuse):
    """What the image is, recorded before anything is created. Stops on an office image that holds credentials."""
    seen = {}
    names = {}
    for name in ("credentials", "boots"):
        path = Path("/etc/qorpera-office") / name
        names[name] = sorted(os.listdir(path)) if path.is_dir() else None
    seen["officeFileNames"] = names
    if any(names.values()):
        raise RuntimeError("The office image holds credentials or boots; this proof runs only on an empty one")
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    node = shutil.which("node")
    seen["versions"] = {
        "os": release.get("PRETTY_NAME", "").strip('"'),
        "kernel": os.uname().release,
        "systemd": base.run("systemctl", "--version").splitlines()[0],
        "bwrap": base.run("/usr/bin/bwrap", "--version"),
        "node": base.run(node, "--version") if node else None,
        "python": sys.version.split()[0],
    }
    missing = [path for path in ("/usr/bin/bwrap", "/usr/bin/tini", "/usr/bin/bash", "/usr/bin/python3") if not os.access(path, os.X_OK)]
    missing += [name for name in ("node", "systemd-run", "mount", "umount", "findmnt") if not shutil.which(name)]
    if missing:
        raise RuntimeError(f"The image lacks {missing}")
    seen["node"] = node
    seen["runMount"] = base.run("findmnt", "-no", "FSTYPE,OPTIONS", "/run")
    seen["fusermount"] = {name: shutil.which(name) for name in ("fusermount", "fusermount3")}
    if not Path("/dev/fuse").is_char_device():
        raise RuntimeError("/dev/fuse is missing")
    seen["fuse"] = fuse
    office_unit = dict(line.split("=", 1) for line in base.run("systemctl", "show", "-p", "FragmentPath,ActiveState,SubState,Result", OFFICE_UNIT).splitlines() if "=" in line)
    if office_unit.get("ActiveState") in ("active", "activating", "reloading", "deactivating"):
        raise RuntimeError(f"The office service is {office_unit['ActiveState']}; this proof needs it stopped")
    seen["officeService"] = office_unit
    if office_unit.get("FragmentPath"):
        installed = Path(office_unit["FragmentPath"]).read_text()
        seen["officeUnitSha256"] = hashlib.sha256(installed.encode()).hexdigest()
        seen["officeUnitAgainstMaster"] = list(difflib.unified_diff((directory / "office.service").read_text().splitlines(), installed.splitlines(), "master", office_unit["FragmentPath"], n=0, lineterm=""))
    seen["imageFolder"] = {
        "opt": sorted(os.listdir("/opt/qorpera-folder")) if Path("/opt/qorpera-folder").is_dir() else None,
        "units": sorted(str(path) for folder in ("/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system") for path in Path(folder).glob("qorpera-folder*")),
    }
    for path in (ROOT, UNIT_FILE):
        if path.exists():
            raise RuntimeError(f"{path} already exists")
    office = pwd.getpwnam("qorpera-office")
    if office.pw_uid == 0:
        raise RuntimeError("The office account must be unprivileged")
    seen["office"] = {"uid": office.pw_uid, "gid": office.pw_gid}
    return seen, office


def restart_seconds(events, killed):
    """From the kill to the first time a namespace saw the folder served again, by the watcher's monotonic clock."""
    for event in events:
        if event["at"] >= killed and "before.txt" in event.get("names", []):
            return round(event["at"] - killed, 3)
    return None


def gone(events, killed):
    """What a namespace saw between the kill and the folder coming back: each distinct state once."""
    seen = []
    for event in events:
        if event["at"] < killed:
            continue
        if "before.txt" in event.get("names", []):
            break
        state = {key: value for key, value in event.items() if key != "at"}
        if state not in seen:
            seen.append(state)
    return seen


def ask(relay, name, request, troubles, seconds=45):
    """One client request. An errno is an answer; a client failure or a client that stopped answering is trouble."""
    reply = relay.client(name, request, seconds)
    if "failure" in reply or "callError" in reply:
        troubles.append({"client": name, "request": request, "reply": reply})
    return reply


def journal(unit, lines=40):
    return quiet("journalctl", "--no-pager", "-o", "short-monotonic", "-n", str(lines), "-u", unit).get("output", "").splitlines()


def gap_trial(relay, mode, troubles):
    """Before the first mount: what an office namespace sees at /company, and whether the mount comes up over it."""
    view = f"gap-{mode}"
    unit = UNIT.format(view)
    trial = {"mode": mode, "served": False}
    started = []
    try:
        point = lay_out(view, mode)
        info = point.stat()
        trial["bare"] = {"mode": oct(info.st_mode & 0o7777), "uid": info.st_uid}
        command, shell = f"{view}-command", f"{view}-shell"
        trial["commandStart"] = relay.call("start", name=command, shape="command", folder="candidate", view=view)
        if trial["commandStart"]["started"]:
            started.append(command)
            trial["commandBefore"] = {"look": ask(relay, command, {"op": "look"}, troubles), "write": ask(relay, command, {"op": "write", "path": "gap.txt", "text": "gap"}, troubles)}
        # A shell that starts in /company, as shell.ts's comment says it will once the folder is mounted.
        trial["shellAtCompanyStart"] = relay.call("start", name=shell, shape="shell", folder="candidate", view=view, chdir="/company")
        if trial["shellAtCompanyStart"]["started"]:
            started.append(shell)
            trial["shellAtCompanyBefore"] = {"status": ask(relay, shell, {"op": "status"}, troubles), "listcwd": ask(relay, shell, {"op": "listcwd"}, troubles)}
        began = time.monotonic()
        trial["start"] = quiet("systemctl", "start", "--no-block", unit)
        try:
            base.eventually(lambda: served(point), 15)
            trial["served"] = True
            trial["servedAfterSeconds"] = round(time.monotonic() - began, 3)
        except TimeoutError:
            pass
        trial["unit"] = show(unit)
        trial["journal"] = journal(unit)
        if command in started:
            trial["commandAfter"] = {"look": ask(relay, command, {"op": "look"}, troubles), "write": ask(relay, command, {"op": "write", "path": "gap-after.txt", "text": "gap"}, troubles)}
        if shell in started:
            trial["shellAtCompanyAfter"] = {"listcwd": ask(relay, shell, {"op": "listcwd"}, troubles), "look": ask(relay, shell, {"op": "look"}, troubles)}
    finally:
        trial["stopped"] = [relay.call("stop", name=name) for name in started]
        trial["teardown"] = tear_view(view)
    return trial


def choose_mode(trials):
    """The first mode, in MODES order, that the unit's mount user served over."""
    return next((trial["mode"] for trial in trials if trial["served"]), None)


VIEW = "q3"
# Started before the first mount, through the candidate form: the folder's shared parent with `/company` a link.
CANDIDATES = (("desktop", "desktop"), ("shell", "shell"), ("command", "command"))
CHECKS = ("officeFirstPropagation", "restartedBySystemd", "oneMountAfterRestart", "runningNamespacesRecovered", "directBindNegativeControl", "stateFolderKept", "secondRestartRecovered", "exitThreeNotRestarted", "fixtureProtocolClean")
# What a writer in the killed mount holds, and what the node keeps after the new mount's abandon hello.
LOSS = {
    "new-unsent": ("loss-new-unsent.txt", ""),
    "new-fsynced": ("loss-new-fsynced.txt", ""),
    "truncate": ("loss-truncate.txt", ""),
    "keep": ("loss-keep.txt", "saved before"),
    "closed": ("loss-closed.txt", "closed"),
}
LIMITATIONS = [
    "A synthetic protocol-3 node on a Unix socket: no database, vsock identity, switchable views or plumber",
    "Office namespaces come from the runtime's process gate and mirrored bubblewrap arguments in a relay with the office unit's confinement, not from the office application",
    "Stand-in private surfaces in the proof directory, not the office state directory",
    "Every namespace's program reads requests on a stdin pipe; the command shape is used without display or capture",
    "systemd-run takes the office unit's InaccessiblePaths lines as transient properties, where unit specifiers are not expanded",
    "The A1 image predates folder-v2: the folder program and the mount unit's lines were pushed in from master",
]


class Proof:
    def __init__(self, directory, fuse):
        self.directory = directory
        self.fuse = fuse
        self.record = {"result": "failed", "checks": {}, "recorded": {}, "limitations": LIMITATIONS}
        self.troubles = []
        self.claimed = {}
        self.relays = []
        self.views = []
        self.node = None
        self.point = ROOT / "mounts" / VIEW / "company"
        self.unit = UNIT.format(VIEW)

    def check(self, name, passed, evidence):
        """A check holds only if every place it is measured holds."""
        entry = self.record["checks"].setdefault(name, {"passed": True, "evidence": []})
        entry["passed"] = entry["passed"] and bool(passed)
        entry["evidence"].append(evidence)

    def note(self, name, value):
        self.record["recorded"][name] = value

    def relay(self, number, writable_mounts=False):
        relay = Relay(self.directory, number, self.node_path, relay_properties(self.office_text, self.directory, writable_mounts))
        self.relays.append(relay)
        return relay

    def ask(self, relay, name, request):
        return ask(relay, name, request, self.troubles)

    def set_up(self):
        require_disposable_guest(self.directory)
        self.directory.chmod(0o755)
        seen, office = preflight(self.directory, self.fuse)
        self.record["image"] = seen
        self.node_path = seen["node"]
        self.office_text = (self.directory / "office.service").read_text()
        taken, skipped = office_lines(self.office_text)
        self.record["relayConfinement"] = taken
        self.record["officeLinesLeftOut"] = skipped
        stand_in(self.directory, office, json.loads((self.directory / "shapes.json").read_text()))
        program = install_program(self.directory, self.claimed)
        self.node = RemountNode(self.directory / "node.sock")
        self.record["mountUnit"] = install_unit(self.directory, self.claimed, program, office).splitlines()
        # The first office namespace starts before /run/qorpera-folder exists, as an office booted before any folder.
        self.relay1 = self.relay(1)
        self.note("relay1BeforeLayout", self.relay1.call("info"))
        claim(self.directory, self.claimed, "root", str(ROOT))
        make_root()
        trials = []
        self.note("gap", trials)
        for mode in MODES:
            trials.append(gap_trial(self.relay1, mode, self.troubles))
        self.mode = choose_mode(trials)
        self.note("mode", self.mode)
        if self.mode is None:
            raise RuntimeError("The mount came up over none of the modes")

    def first_mount(self):
        """Namespaces started before the mount, then the unit started: does the mount reach them?"""
        self.views.append(VIEW)
        lay_out(VIEW, self.mode)
        self.before = {}
        for name, shape in CANDIDATES:
            started = self.relay1.call("start", name=name, shape=shape, folder="candidate", view=VIEW)
            self.note(f"{name}Start", started)
            if not started["started"]:
                raise RuntimeError(f"{name} did not start before the mount: {started['gate']}")
            self.before[name] = {"status": self.ask(self.relay1, name, {"op": "status"}), "look": self.ask(self.relay1, name, {"op": "look"})}
        began = time.monotonic()
        base.run("systemctl", "start", self.unit)
        base.eventually(lambda: served(self.point), 20)
        self.note("firstMount", {"servedAfterSeconds": round(time.monotonic() - began, 3), "unit": show(self.unit), "hostCount": count(self.point), "parentShared": shared(self.point.parent)})
        # The negative control: a namespace that binds the folder's own root, started once it is served.
        started = self.relay1.call("start", name="direct", shape="command", folder="direct", view=VIEW)
        self.note("directStart", started)
        if not started["started"]:
            raise RuntimeError(f"direct did not start: {started['gate']}")
        first = {}
        for name in [name for name, _ in CANDIDATES] + ["direct"]:
            first[name] = {
                "read": self.ask(self.relay1, name, {"op": "read", "path": "before.txt"}),
                "write": self.ask(self.relay1, name, {"op": "write", "path": f"{name}-before.txt", "text": "before"}),
                "mountinfo": self.ask(self.relay1, name, {"op": "mountinfo"}),
            }
        with self.node.lock:
            stored = {name: self.node.files.get(f"{name}-before.txt") for name in first}
        self.direct_before = first.pop("direct")
        passed = all(first[name]["read"].get("text") == "before" and first[name]["write"].get("written") and stored[name] == b"before" for name in first)
        self.check("officeFirstPropagation", passed, {name: dict(first[name], startedBefore=self.before[name]) for name in first})

    def prepare_loss(self):
        """Writers and readers the killed mount leaves behind: unsent, fsynced and committed writes, an old read
        descriptor, a working directory inside the folder, and a watcher that times the gap."""
        relay = self.relay1
        plan = {
            "new-unsent": [{"op": "open", "mode": "create-excl"}, {"op": "pwrite", "text": "unsent"}],
            "new-fsynced": [{"op": "open", "mode": "create-excl"}, {"op": "pwrite", "text": "fsynced"}, {"op": "fsync"}],
            "truncate": [{"op": "open", "mode": "truncate"}, {"op": "pwrite", "text": "replaced"}, {"op": "fsync"}],
            "keep": [{"op": "open", "mode": "keep"}, {"op": "pwrite", "text": "XY", "offset": 0}, {"op": "fsync"}],
        }
        steps = {key: [self.ask(relay, "command", {**request, "key": key, "path": LOSS[key][0]}) for request in requests] for key, requests in plan.items()}
        steps["closed"] = [self.ask(relay, "command", {"op": "write", "path": LOSS["closed"][0], "text": "closed"})]
        with self.node.lock:
            held = {key: {"file": self.node.files.get(path, b"").decode(), "handles": [value.decode() for name, value in self.node.handles.values() if name == path]} for key, (path, _) in LOSS.items()}
        self.loss = {"steps": steps, "nodeBeforeKill": held}
        self.old_fd = {"open": self.ask(relay, "desktop", {"op": "open", "key": "old", "path": "before.txt", "mode": "read"})}
        self.old_fd["pread"] = self.ask(relay, "desktop", {"op": "pread", "key": "old"})
        self.cwd = {"chdir": self.ask(relay, "command", {"op": "chdir"})}
        self.cwd["listcwd"] = self.ask(relay, "command", {"op": "listcwd"})
        state = ROOT / "state" / VIEW
        self.state_before = {"inode": state.stat().st_ino, "names": sorted(os.listdir(state))}
