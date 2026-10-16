#!/usr/bin/env python3
"""Disposable nested-VM proof for Q3: do running office namespaces follow a company folder mount systemd restarts?

The real qorpera-folder program runs under master's office mount unit, rendered as the image installer renders it, with
only its program and a synthetic protocol-4 node on a Unix socket put in. Office namespaces are started by the runtime's
own process gate with the runtime's bubblewrap arguments, from a relay that carries every confinement line of master's
office unit. This is not the office helper or the office application: no plumber, credentials, vsock identity, SQL or
model is claimed.
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
import traceback

HERE = Path(__file__).resolve().parent
# The substrate proof's wire helpers and synthetic node, unchanged.
_spec = importlib.util.spec_from_file_location("office_folder_substrate", HERE / "office-folder-substrate.py")
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)

ROOT = Path("/run/qorpera-folder")
# Not the office unit's name: an image's own unit in /etc would shadow one of that name in /run, and nothing the image
# carries is started.
UNIT = "qorpera-remount-folder-mount@{}.service"
UNIT_FILE = Path("/run/systemd/system/qorpera-remount-folder-mount@.service")
IMAGE_UNIT = Path("/etc/systemd/system/qorpera-office-folder-mount@.service")
OFFICE_UNIT = "qorpera-company-computer.service"
# The mountpoint's mode while nothing is mounted over it, each measured in its own view; 0700 is #1047's.
MODES = ("0000", "0700", "0755")
# The main run's mode: the candidate 0000 if the unit's own mount user (root holding only CAP_SYS_ADMIN) serves over
# it, else 0755, the plan's fallback.
CHOSEN = ("0000", "0755")
CONFINEMENT = {"User", "Group", "UMask", "LimitCORE", "PrivateTmp", "PrivateDevices", "ProtectSystem", "ProtectHome", "ProtectProc", "ProcSubset", "ProtectHostname", "ProtectClock", "ProtectKernelTunables", "ProtectKernelLogs", "ProtectKernelModules", "ProtectControlGroups", "NoNewPrivileges", "CapabilityBoundingSet", "AmbientCapabilities", "RestrictNamespaces", "RestrictAddressFamilies", "RestrictSUIDSGID", "LockPersonality", "MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuota", "InaccessiblePaths"}
# What the office service needs to run the application, not to confine it: recorded as left out.
OPERATIONAL = {"Type", "StateDirectory", "StateDirectoryMode", "WorkingDirectory", "Environment", "LoadCredential", "ExecStart", "Restart", "RestartSec", "KillMode", "KillSignal", "SendSIGKILL", "TimeoutStopSec", "ReadWritePaths"}
# Master's office mount unit's ExecStart, rendered, and what it becomes: the proof's program and the synthetic node.
MOUNT_START = "ExecStart=/opt/qorpera-folder/qorpera-folder mount --view-file /run/qorpera-folder/views/%i.json --mountpoint /run/qorpera-folder/mounts/%i/company --state-dir /run/qorpera-folder/state/%i --allow-other yes --owner-uid {uid} --owner-gid {gid}"
PROOF_START = "ExecStart={program} mount --connect unix:{socket} --view-file /run/qorpera-folder/views/%i.json --mountpoint /run/qorpera-folder/mounts/%i/company --state-dir /run/qorpera-folder/state/%i --allow-other yes --owner-uid {uid} --owner-gid {gid}"
SHOWN = ("MainPID", "NRestarts", "ExecMainStatus", "ExecMainCode", "ActiveState", "SubState", "Result")


def rendered_unit(template, uid, gid):
    """Master's office mount unit as the image installer writes it: each id placeholder once, replaced."""
    if any(type(value) is not int or not 0 < value < 4294967295 for value in (uid, gid)):
        raise ValueError("Invalid mount owner")
    if template.count("@OFFICE_UID@") != 1 or template.count("@OFFICE_GID@") != 1:
        raise ValueError("master's office mount unit no longer names each office id once")
    return template.replace("@OFFICE_UID@", str(uid)).replace("@OFFICE_GID@", str(gid))


def proof_unit(template, program, node_socket, uid, gid):
    """Master's office mount unit, rendered, with only its ExecStart's program and node changed. Started by the proof
    only, never at boot."""
    lines = rendered_unit(template, uid, gid).splitlines()
    start = MOUNT_START.format(uid=uid, gid=gid)
    if lines.count(start) != 1 or sum(line.startswith("ExecStart=") for line in lines) != 1:
        raise ValueError(f"master's office mount unit no longer starts with exactly {start!r}")
    if "[Install]" in lines:
        raise ValueError("master's office mount unit has an [Install] section")
    proof = PROOF_START.format(program=program, socket=node_socket, uid=uid, gid=gid)
    return "\n".join(proof if line == start else line for line in lines) + "\n"


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
    """Parsed like #1047's parseCompanyComputerMountinfo (mountpoint, optional fields, type and source), with the
    mount's and its parent's ids."""
    entries = []
    for line in (Path("/proc/self/mountinfo").read_text() if text is None else text).splitlines():
        fields = line.split(" ")
        if "-" not in fields[6:]:
            continue
        dash = fields.index("-", 6)
        entries.append({"id": int(fields[0]), "parent": int(fields[1]), "mountpoint": decode(fields[4]), "options": fields[5], "optional": fields[6:dash], "fstype": fields[dash + 1], "source": decode(fields[dash + 2])})
    return entries


def at(path, entries):
    return [entry for entry in entries if entry["mountpoint"] == str(path)]


# fuser 0.18's direct mount always passes type `fuse` and uses Subtype only as a fallback source, so a real folder
# mount reads `fuse qorpera-company`, not #1047's `fuse.qorpera` (run 20261014T221714-41263-9a93d28c).
FOLDER_TYPES = ("fuse", "fuse.qorpera")


def folder(entry):
    return entry["fstype"] in FOLDER_TYPES and entry["source"] == "qorpera-company"


def stack(path, entries=None):
    """The mounts at the path that path resolution passes through, bottom first. Walking down from /, each mountpoint
    on the way takes only the mounts on top of the one reached so far. The parent bound onto itself joins /run's peer
    group, so a folder mount is also propagated to /run under that bind, where nothing reaches it: it is left out."""
    entries = mountinfo() if entries is None else entries
    parts = Path(path).parts
    reached, chain = None, []
    for depth in range(1, len(parts) + 1):
        here = [entry for entry in entries if entry["mountpoint"] == str(Path(*parts[:depth]))]
        chain = []
        while True:
            if reached is None:
                # Nothing reached yet: the bottom mount here is the one whose parent is not mounted here too.
                ids = {entry["id"] for entry in here}
                above = [entry for entry in here if entry["parent"] not in ids]
            else:
                above = [entry for entry in here if entry["parent"] == reached["id"]]
            if not above:
                break
            reached = above[-1]
            chain.append(reached)
    return chain


def served(path, entries=None):
    """#1047's test, with the type a real mount has: the mount path resolution reaches is the folder program's."""
    chain = stack(path, entries)
    return bool(chain) and folder(chain[-1])


def shared(path, entries=None):
    chain = stack(path, entries)
    return bool(chain) and any(field.startswith("shared:") for field in chain[-1]["optional"])


def count(path, entries=None):
    """Folder mounts stacked where path resolution reaches the path: a dead one left under a live one counts too."""
    return sum(1 for entry in stack(path, entries) if folder(entry))


def copies(path, entries=None):
    """Folder mounts at the path anywhere, the propagated copies under covering mounts too."""
    return sum(1 for entry in at(path, mountinfo() if entries is None else entries) if folder(entry))


def held(path):
    """What the record keeps of each mount at the path."""
    return [{key: entry[key] for key in ("id", "parent", "optional", "fstype", "source")} for entry in at(path, mountinfo())]


def stat_errno(path):
    try:
        os.stat(path)
        return 0
    except OSError as error:
        return error.errno


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


def quiet(*args, seconds=30, keep=2000):
    """A cleanup command: its outcome is recorded, never raised. The output keeps its last `keep` characters."""
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=seconds)
        return {"command": list(args), "code": done.returncode, "output": (done.stdout + done.stderr).strip()[-keep:]}
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
        "units": sorted(str(path) for folder in ("/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system") for name in ("qorpera-folder*", "qorpera-office-folder*") for path in Path(folder).glob(name)),
    }
    for path in (ROOT, UNIT_FILE):
        if path.exists():
            raise RuntimeError(f"{path} already exists")
    office = pwd.getpwnam("qorpera-office")
    if office.pw_uid == 0:
        raise RuntimeError("The office account must be unprivileged")
    seen["office"] = {"uid": office.pw_uid, "gid": office.pw_gid}
    # An image with the folder carries the office mount unit: the proof runs that very unit, under its own name, with
    # only the program and the node changed.
    seen["imageMountUnitSha256"] = None
    if IMAGE_UNIT.exists():
        installed = IMAGE_UNIT.read_text()
        seen["imageMountUnitSha256"] = hashlib.sha256(installed.encode()).hexdigest()
        if installed != rendered_unit((directory / "mount.service").read_text(), office.pw_uid, office.pw_gid):
            raise RuntimeError(f"The image's {IMAGE_UNIT} is not master's office mount unit as the installer renders it")
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


def seed_text(path):
    """The file's text read through the host's mount, or None while no live mount serves it."""
    try:
        return path.read_text()
    except OSError:
        return None


def restarted(before, now, host, again):
    """Whether one restart serves again: a new running process, one live mount that served the file seeded at the kill, and still that process after the read."""
    unit = ("MainPID", "NRestarts", "ActiveState")
    once = now["NRestarts"] == before["NRestarts"] + 1 and now["MainPID"] not in (0, before["MainPID"]) and now["ActiveState"] == "active"
    live = host["served"] and host["count"] == 1 and host["statErrno"] == 0 and host["seedRead"]
    return once and live and {key: again[key] for key in unit} == {key: now[key] for key in unit}


def ask(relay, name, request, troubles, seconds=45):
    """One client request. An errno is an answer; a client failure or a client that stopped answering is trouble."""
    reply = relay.client(name, request, seconds)
    if "failure" in reply or "callError" in reply:
        troubles.append({"client": name, "request": request, "reply": reply})
    return reply


def journal(unit, lines=40):
    return quiet("journalctl", "--no-pager", "-o", "short-monotonic", "-n", str(lines), "-u", unit, keep=400 * lines).get("output", "").splitlines()


def cursor():
    """The journal's position now, so a later read can start after it."""
    shown = base.run("journalctl", "--no-pager", "-q", "-n", "1", "--show-cursor").splitlines()
    return shown[-1].removeprefix("-- cursor: ") if shown and shown[-1].startswith("-- cursor: ") else None


def journal_since(unit, position):
    if position is None:
        return journal(unit, 200)
    return quiet("journalctl", "--no-pager", "-o", "short-monotonic", f"--after-cursor={position}", "-u", unit, keep=200000).get("output", "").splitlines()


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
    """The first mode, in CHOSEN order, that the unit's mount user served over."""
    served = {trial["mode"] for trial in trials if trial["served"]}
    return next((mode for mode in CHOSEN if mode in served), None)


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
    "A synthetic protocol-4 node on a Unix socket: no database, vsock identity, switchable views or plumber",
    "Office namespaces come from the runtime's process gate and mirrored bubblewrap arguments in a relay with the office unit's confinement, not from the office application",
    "Stand-in private surfaces in the proof directory, not the office state directory",
    "Every namespace's program reads requests on a stdin pipe; the command shape is used without display or capture",
    "systemd-run takes the office unit's InaccessiblePaths lines as transient properties, where unit specifiers are not expanded",
    "The folder program is pushed in from this tree, and the mount unit is master's office unit under the proof's own name: an image's own unit is compared byte for byte, never started",
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
        self.first_copies = None
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
        self.record["guestImage"] = seen
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
            raise RuntimeError("The mount came up over neither 0000 nor 0755")

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
        self.note("firstMount", {"servedAfterSeconds": round(time.monotonic() - began, 3), "unit": show(self.unit), "hostCount": count(self.point), "hostCopies": copies(self.point), "hostAt": held(self.point), "parentShared": shared(self.point.parent)})
        self.first_copies = copies(self.point)
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

    def kill(self, how, seed, text):
        """Kills the mount's daemon, then waits for systemd's restart to serve one mount again."""
        self.ask(self.relay1, "desktop", {"op": "watch-start"})
        before = show(self.unit)
        # systemd logs its control processes (the ExecStopPost umount) only at debug, so the kill runs under debug.
        level = base.run("systemd-analyze", "log-level")
        base.run("systemd-analyze", "log-level", "debug")
        position = cursor()
        killed = time.monotonic()
        if how == "pid":
            os.kill(before["MainPID"], signal.SIGKILL)
        else:
            base.run("systemctl", "kill", "-s", "KILL", self.unit)
        # Only the new mount can know this file.
        with self.node.lock:
            self.node.files[seed] = text.encode()

        # Each distinct state the host passes through: the mounts at the path, what a stat there gets, whether the seed reads, the unit's state.
        timeline = []

        def back():
            now = show(self.unit)
            # systemd reports the new process running before it mounts, so only a read of the new seed shows a live mount.
            state = {"mounts": [[entry["id"], entry["parent"]] for entry in at(self.point, mountinfo())], "statErrno": stat_errno(self.point), "seedRead": seed_text(self.point / seed) == text, "unit": f"{now['ActiveState']}/{now['SubState']}", "NRestarts": now["NRestarts"]}
            if not timeline or {key: timeline[-1][key] for key in state} != state:
                timeline.append({"at": round(time.monotonic() - killed, 3), **state})
            host = {"served": served(self.point), "count": count(self.point), "statErrno": state["statErrno"], "seedRead": state["seedRead"]}
            return now if restarted(before, now, host, show(self.unit)) else None

        try:
            after = base.eventually(back, 30)
            seconds = round(time.monotonic() - killed, 3)
        except TimeoutError:
            after, seconds = show(self.unit), None
        finally:
            base.run("systemd-analyze", "log-level", level)
        time.sleep(0.5)
        events = self.ask(self.relay1, "desktop", {"op": "watch-stop"}).get("events", [])
        return {
            "how": how,
            "before": before,
            "after": after,
            "hostServedAfterSeconds": seconds,
            "hostCount": count(self.point),
            "hostCopies": copies(self.point),
            "hostAt": held(self.point),
            "hostTimeline": timeline,
            "logLevel": level,
            "namespaceServedAfterSeconds": restart_seconds(events, killed),
            "namespaceSawMeanwhile": gone(events, killed),
            # systemd's debug log for the unit from the kill until it served again.
            "journal": journal_since(self.unit, position),
        }

    def after_restart(self, tag, seed, text):
        """The namespaces started before the first mount: same process and namespace, reading and writing the new mount."""
        seen = {}
        for name, _ in CANDIDATES:
            status = self.ask(self.relay1, name, {"op": "status"})
            lines = self.ask(self.relay1, name, {"op": "mountinfo"}).get("lines", [])
            seen[name] = {
                "sameProcess": status.get("token") == self.before[name]["status"].get("token"),
                "sameNamespace": status.get("mountNamespace") == self.before[name]["status"].get("mountNamespace"),
                "read": self.ask(self.relay1, name, {"op": "read", "path": seed}),
                "write": self.ask(self.relay1, name, {"op": "write", "path": f"{name}-{tag}.txt", "text": tag}),
                "namespaceCount": count("/run/qorpera-company/company", mountinfo("\n".join(lines))),
                "mountinfo": lines,
            }
        with self.node.lock:
            stored = {name: self.node.files.get(f"{name}-{tag}.txt") for name in seen}
        recovered = all(entry["sameProcess"] and entry["sameNamespace"] and entry["read"].get("text") == text and entry["write"].get("written") and stored[name] == tag.encode() for name, entry in seen.items())
        return seen, recovered, all(entry["namespaceCount"] == 1 for entry in seen.values())

    def first_kill(self):
        restart = self.kill("pid", "after.txt", "after restart")
        self.note("kill1", restart)
        self.check("restartedBySystemd", restart["hostServedAfterSeconds"] is not None, {"before": restart["before"], "after": restart["after"]})
        seen, recovered, one = self.after_restart("after", "after.txt", "after restart")
        self.check("runningNamespacesRecovered", recovered, seen)
        self.check("oneMountAfterRestart", restart["hostCount"] == 1 and restart["hostCopies"] == self.first_copies and one, {"kill": 1, "hostCount": restart["hostCount"], "hostCopies": restart["hostCopies"], "firstMountCopies": self.first_copies, "namespaceCounts": {name: entry["namespaceCount"] for name, entry in seen.items()}})
        direct = self.ask(self.relay1, "direct", {"op": "read", "path": "before.txt"})
        self.check("directBindNegativeControl", self.direct_before["read"].get("text") == "before" and direct.get("errno") == errno.ENOTCONN, {"before": self.direct_before, "after": direct})
        self.cwd["listcwdAfterKill"] = self.ask(self.relay1, "command", {"op": "listcwd"})
        self.cwd["chdirAgain"] = self.ask(self.relay1, "command", {"op": "chdir"})
        self.cwd["listcwdAgain"] = self.ask(self.relay1, "command", {"op": "listcwd"})
        self.note("staleCwd", self.cwd)
        self.old_fd["preadAfterKill"] = self.ask(self.relay1, "desktop", {"op": "pread", "key": "old"})
        self.old_fd["closeAfterKill"] = self.ask(self.relay1, "desktop", {"op": "close", "key": "old"})
        self.note("oldDescriptor", self.old_fd)
        closes = {key: self.ask(self.relay1, "command", {"op": "close", "key": key}) for key in ("new-unsent", "new-fsynced", "truncate", "keep")}
        with self.node.lock:
            kept = {key: self.node.files.get(path, b"").decode() for key, (path, _) in LOSS.items()}
            abandoned = [op for op in self.node.ops if op["op"] == "abandoned" and op["viewId"] == VIEW]
        self.loss.update(closesAfterKill=closes, nodeAfterRestart=kept, abandoned=abandoned, expected={key: text for key, (_, text) in LOSS.items()})
        self.loss["asExpected"] = kept == self.loss["expected"]
        self.note("loss", self.loss)
        state = ROOT / "state" / VIEW
        now = {"inode": state.stat().st_ino, "names": sorted(os.listdir(state))}
        self.check("stateFolderKept", now["inode"] == self.state_before["inode"] and set(self.state_before["names"]) <= set(now["names"]), {"before": self.state_before, "after": now})

    def use(self, relay, name, seed, tag):
        return {
            "status": self.ask(relay, name, {"op": "status"}),
            "read": self.ask(relay, name, {"op": "read", "path": seed}),
            "write": self.ask(relay, name, {"op": "write", "path": f"{name}-{tag}.txt", "text": tag}),
            "mountinfo": self.ask(relay, name, {"op": "mountinfo"}),
            "look": self.ask(relay, name, {"op": "look"}),
        }

    def over_mount(self):
        """Office services started while the folder is mounted: ProtectSystem=strict makes what exists at start
        read-only, so the plain unit is measured beside one that names the folder mounts writable."""
        self.over = {}
        for number, name, writable in ((2, "over-plain", False), (3, "over-rw", True)):
            relay = self.relay(number, writable)
            entry = {"relay": relay.call("info"), "start": relay.call("start", name=name, shape="command", folder="candidate", view=VIEW)}
            if entry["start"]["started"]:
                entry["over"] = self.use(relay, name, "before.txt", "over")
            self.over[name] = (relay, entry)

    def second_kill(self):
        restart = self.kill("systemctl", "after2.txt", "after second restart")
        self.note("kill2", restart)
        seen, recovered, one = self.after_restart("after2", "after2.txt", "after second restart")
        self.check("secondRestartRecovered", restart["hostServedAfterSeconds"] is not None and recovered, {"before": restart["before"], "after": restart["after"], "namespaces": seen})
        self.check("oneMountAfterRestart", restart["hostCount"] == 1 and restart["hostCopies"] == self.first_copies and one, {"kill": 2, "hostCount": restart["hostCount"], "hostCopies": restart["hostCopies"], "firstMountCopies": self.first_copies, "namespaceCounts": {name: entry["namespaceCount"] for name, entry in seen.items()}})
        for name, (relay, entry) in self.over.items():
            if entry["start"]["started"]:
                entry["afterKill2"] = self.use(relay, name, "after2.txt", "after2")
        self.note("officeStartedOverMount", {name: entry for name, (_, entry) in self.over.items()})
        self.note("directAfterKill2", self.ask(self.relay1, "direct", {"op": "read", "path": "before.txt"}))

    def exit_three(self):
        """The node closes the view: the program exits 3, which the unit must not restart."""
        before = show(self.unit)
        self.node.close_view(VIEW)

        def ended():
            now = show(self.unit)
            return now if now.get("ExecMainStatus") == 3 and now["ActiveState"] in ("failed", "inactive") else None

        try:
            stopped = base.eventually(ended, 20)
        except TimeoutError:
            stopped = None
        # Past RestartSec=5s: a restart would have begun by now.
        time.sleep(9)
        now = show(self.unit)
        passed = stopped is not None and now["NRestarts"] == before["NRestarts"] and now["ActiveState"] in ("failed", "inactive") and not served(self.point) and copies(self.point) == 0
        self.check("exitThreeNotRestarted", passed, {"before": before, "ended": stopped, "nineSecondsLater": now, "hostCopies": copies(self.point), "hostAt": held(self.point), "journal": journal(self.unit, 20)})
        self.note("afterExitThree", {name: self.ask(self.relay1, name, {"op": "look"}) for name, _ in CANDIDATES})

    def tear_down(self):
        steps = {"relays": [], "views": {}}
        for relay in self.relays:
            steps["relays"].append(relay.close())
        for view in self.views:
            try:
                steps["views"][view] = tear_view(view)
            except OSError as error:
                steps["views"][view] = repr(error)
        if self.node:
            self.node.close()
        if self.claimed.get("unit"):
            UNIT_FILE.unlink(missing_ok=True)
            steps["daemonReload"] = quiet("systemctl", "daemon-reload")
        if self.claimed.get("root"):
            # Never through a mount: what is left mounted under the root stays for the cleanup's lazy unmounts.
            left = [entry["mountpoint"] for entry in mountinfo() if entry["mountpoint"].startswith(str(ROOT) + "/")]
            steps["mountsLeft"] = left
            if not left:
                shutil.rmtree(ROOT, ignore_errors=True)
        if self.claimed.get("program"):
            shutil.rmtree(self.claimed["program"], ignore_errors=True)
        return steps

    def evidence(self):
        units = [UNIT.format(f"gap-{mode}") for mode in MODES] + [self.unit]
        self.record["journals"] = {unit: journal(unit, 60) for unit in units + [relay.unit for relay in self.relays]}
        self.record["relayLogs"] = {relay.unit: relay.log.read_text()[-4000:] for relay in self.relays if relay.log.exists()}
        kernel = quiet("journalctl", "-k", "--no-pager", "-o", "cat", "--since", f"@{self.started}").get("output", "")
        self.record["kernelDenials"] = [line for line in kernel.splitlines() if "denied" in line.lower()]

    def run(self):
        self.started = int(time.time())
        try:
            self.set_up()
            self.first_mount()
            self.prepare_loss()
            self.first_kill()
            self.over_mount()
            self.second_kill()
            self.exit_three()
        except Exception as error:
            self.record["error"] = repr(error)
            self.record["traceback"] = traceback.format_exc().splitlines()[-12:]
        finally:
            self.record["teardown"] = self.tear_down()
            self.evidence()
        errors = list(self.node.errors) if self.node else ["the node never started"]
        self.check("fixtureProtocolClean", not errors and not self.troubles, {"nodeErrors": errors, "troubles": self.troubles})
        if self.node:
            self.record["nodeHellos"] = self.node.hellos
            self.record["nodeOps"] = self.node.ops
        self.record["missingChecks"] = [name for name in CHECKS if name not in self.record["checks"]]
        clean = "error" not in self.record and not self.record["missingChecks"]
        self.record["result"] = "passed" if clean and all(entry["passed"] for entry in self.record["checks"].values()) else "failed"
        return self.record


def cleanup(directory):
    """After the proof, or after a proof that was stopped: removes only what this directory's claim names."""
    require_disposable_guest(directory)
    steps = [quiet("systemctl", "stop", f"{directory.name}-{name}.service") for name in ("proof", "relay1", "relay2", "relay3")]
    units = quiet("systemctl", "list-units", "--all", "--plain", "--no-legend", UNIT.format("*")).get("output", "")
    for unit in (line.split()[0] for line in units.splitlines() if line.strip()):
        steps += [quiet("systemctl", "stop", unit), quiet("systemctl", "reset-failed", unit)]
    claimed = json.loads((directory / "claimed.json").read_text()) if (directory / "claimed.json").exists() else {}
    if claimed.get("root") and (ROOT / "mounts").is_dir():
        for view in sorted(os.listdir(ROOT / "mounts")):
            steps += tear_view(view)
    if claimed.get("root"):
        left = [entry["mountpoint"] for entry in mountinfo() if entry["mountpoint"] == str(ROOT) or entry["mountpoint"].startswith(str(ROOT) + "/")]
        if left:
            raise RuntimeError(f"Mounts are left under {ROOT}: {left}")
        shutil.rmtree(ROOT, ignore_errors=True)
    if claimed.get("unit"):
        UNIT_FILE.unlink(missing_ok=True)
        steps.append(quiet("systemctl", "daemon-reload"))
    if claimed.get("program"):
        shutil.rmtree(claimed["program"], ignore_errors=True)
    shutil.rmtree(directory)
    print(json.dumps({"cleanup": "done", "claimed": claimed, "steps": steps}))


def refused(call, *args):
    try:
        call(*args)
    except ValueError:
        return True
    return False


def selftest(office_path, mount_path):
    """Unprivileged checks of the unit rewrite, the office lines, mountinfo reading and the synthetic node's wire.
    Deliberately claims no FUSE, namespace or systemd proof."""
    mount_text = mount_path.read_text()
    rendered = rendered_unit(mount_text, 1000, 1001)
    assert "@OFFICE_" not in rendered and "--owner-uid 1000 --owner-gid 1001" in rendered
    lines = proof_unit(mount_text, "/var/lib/qorpera-remount-x/qorpera-folder", "/run/qorpera-remount-x/node.sock", 1000, 1001).splitlines()
    assert "ExecStart=/var/lib/qorpera-remount-x/qorpera-folder mount --connect unix:/run/qorpera-remount-x/node.sock --view-file /run/qorpera-folder/views/%i.json --mountpoint /run/qorpera-folder/mounts/%i/company --state-dir /run/qorpera-folder/state/%i --allow-other yes --owner-uid 1000 --owner-gid 1001" in lines
    # #1085's line: a dead mount is taken away before each start.
    assert "ExecStartPre=-/usr/bin/umount -l /run/qorpera-folder/mounts/%i/company" in lines and "ExecStopPost=-/usr/bin/umount -l /run/qorpera-folder/mounts/%i/company" in lines
    # Every other line of the rendered unit is kept as it is.
    assert [line for line in lines if not line.startswith("ExecStart=")] == [line for line in rendered.splitlines() if not line.startswith("ExecStart=")]
    for args in (("1000", 1001), (0, 1001), (1000, 4294967295)):
        assert refused(proof_unit, mount_text, "p", "s", *args)
    assert refused(proof_unit, mount_text.replace("@OFFICE_GID@", "@OFFICE_GID@ @OFFICE_GID@"), "p", "s", 1000, 1001)
    assert refused(proof_unit, mount_text.replace("--allow-other yes", "--allow-other no"), "p", "s", 1000, 1001)
    assert refused(proof_unit, mount_text + "ExecStart=/usr/bin/true\n", "p", "s", 1000, 1001)
    assert refused(proof_unit, mount_text + "\n[Install]\nWantedBy=multi-user.target\n", "p", "s", 1000, 1001)
    office_text = office_path.read_text()
    taken, skipped = office_lines(office_text)
    assert {line.split("=", 1)[0] for line in taken} == CONFINEMENT and {line.split("=", 1)[0] for line in skipped} <= OPERATIONAL
    assert refused(office_lines, office_text.replace("[Service]", "[Service]\nPrivateNetwork=yes", 1))
    assert refused(office_lines, office_text.replace("\nNoNewPrivileges=", "\n#NoNewPrivileges="))
    properties = relay_properties(office_text, Path("/run/qorpera-remount-x"))
    assert properties.count("--property") == len(taken) + 3 and properties[-6:] == ["--property", "ReadWritePaths=/run/qorpera-remount-x/standin", "--property", "RuntimeMaxSec=420", "--property", "KillMode=control-group"]
    assert relay_properties(office_text, Path("/run/qorpera-remount-x"), True)[-2:] == ["--property", "ReadWritePaths=-/run/qorpera-folder/mounts"]
    point = "/run/qorpera-folder/mounts/q3/company"
    # A real host after the first mount: the parent bound onto itself is in /run's peer group, so the folder mount is
    # propagated to /run under that bind too.
    real = mountinfo("\n".join([
        "1 0 252:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw",
        "25 1 0:25 / /run rw,nosuid,nodev shared:5 - tmpfs tmpfs rw,mode=755",
        "36 25 0:25 /qorpera-folder/mounts/q3 /run/qorpera-folder/mounts/q3 rw,nosuid,nodev shared:5 - tmpfs tmpfs rw,mode=755",
        f"41 36 0:42 / {point} rw,nosuid,nodev,noatime shared:14 - fuse qorpera-company rw,user_id=0,group_id=0,default_permissions,allow_other",
        f"42 25 0:42 / {point} rw,nosuid,nodev,noatime shared:14 - fuse qorpera-company rw,user_id=0,group_id=0,default_permissions,allow_other",
    ]))
    assert [entry["id"] for entry in stack(point, real)] == [41] and served(point, real) and shared("/run/qorpera-folder/mounts/q3", real)
    assert count(point, real) == 1 and copies(point, real) == 2 and [entry["id"] for entry in stack("/run", real)] == [25]
    sample = "\n".join([
        "36 25 0:30 / /run/qorpera-folder/mounts/q3 rw,nosuid,nodev shared:12 - tmpfs tmpfs rw",
        f"40 36 0:41 / {point} rw,nosuid,nodev shared:13 - fuse.qorpera qorpera-company rw,user_id=0,group_id=0,allow_other",
        # The line a real mount has.
        f"41 40 0:42 / {point} rw,nosuid,nodev,noatime shared:14 - fuse qorpera-company rw,user_id=0,group_id=0,default_permissions,allow_other",
        "50 25 0:43 / /a\\040b rw master:3 - tmpfs tmp\\011x rw",
        "not a mountinfo line",
    ])
    entries = mountinfo(sample)
    assert len(entries) == 4 and served(point, entries) and count(point, entries) == 2 and shared("/run/qorpera-folder/mounts/q3", entries)
    assert entries[0]["id"] == 36 and entries[0]["parent"] == 25 and copies(point, entries) == 2
    assert entries[3]["mountpoint"] == "/a b" and entries[3]["source"] == "tmp\tx" and not shared("/a b", entries) and not served("/a b", entries)
    covered = mountinfo(sample + f"\n60 41 0:44 / {point} rw - tmpfs tmpfs rw")
    assert not served(point, covered) and count(point, covered) == 2
    stranger = mountinfo(f"40 36 0:41 / {point} rw - fuse sshfs rw")
    assert not served(point, stranger) and count(point, stranger) == 0
    assert choose_mode([{"mode": "0000", "served": False}, {"mode": "0700", "served": True}, {"mode": "0755", "served": True}]) == "0755"
    assert choose_mode([{"mode": mode, "served": True} for mode in MODES]) == "0000"
    assert choose_mode([{"mode": mode, "served": mode == "0700"} for mode in MODES]) is None
    assert choose_mode([{"mode": mode, "served": False} for mode in MODES]) is None
    events = [{"at": 9.0, "names": ["before.txt"]}, {"at": 10.5, "listErrno": 107}, {"at": 10.6, "dev": 1, "names": []}, {"at": 10.7, "listErrno": 107}, {"at": 12.25, "names": ["after.txt", "before.txt"]}]
    assert restart_seconds(events, 10.0) == 2.25 and restart_seconds(events[:4], 10.0) is None
    assert gone(events, 10.0) == [{"listErrno": 107}, {"dev": 1, "names": []}]
    old, new = {"MainPID": 41, "NRestarts": 0, "ActiveState": "active"}, {"MainPID": 57, "NRestarts": 1, "ActiveState": "active"}
    live = {"served": True, "count": 1, "statErrno": 0, "seedRead": True}
    assert restarted(old, new, live, new)
    # A new running process over the dead mount it has not yet replaced: mountinfo still lists it, but it gets ENOTCONN and serves nothing.
    assert not restarted(old, new, {**live, "statErrno": 107, "seedRead": False}, new)
    assert not restarted(old, new, {**live, "seedRead": False}, new)
    assert not restarted(old, new, live, {**new, "MainPID": 63, "NRestarts": 2})
    assert not restarted(old, {**new, "NRestarts": 2}, live, {**new, "NRestarts": 2})
    assert seed_text(Path("/nonexistent-qorpera-remount/after1.txt")) is None
    with tempfile.TemporaryDirectory(prefix="qorpera-remount-wire-") as tmp:
        node = RemountNode(Path(tmp) / "node.sock", heartbeat=0.2)
        try:
            def hello(view, role, abandon=False):
                conn = socket.socket(socket.AF_UNIX)
                conn.settimeout(3)
                conn.connect(str(Path(tmp) / "node.sock"))
                base.send(conn, "H", {"protocol": 4, "environmentId": "synthetic", "viewId": view, "pass": "synthetic-pass", "role": role, **({"abandon": True} if abandon else {})})
                kind, body = base.receive(conn)
                return conn, kind, json.loads(body)

            def call(conn, kind, value):
                base.send(conn, kind, value)
                kind, body = base.receive(conn)
                return kind, body if kind == "d" else json.loads(body)

            def part(handle, offset, chunk, data):
                header = json.dumps({"handle": handle, "index": 0, "offset": offset, "bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()}).encode()
                return struct.pack(">I", len(header)) + header + data

            feed, kind, ok = hello("w", "feed")
            assert kind == "h" and ok == {"protocol": 4, "viewId": "w", "asOfSeq": 0, "readOnly": False}
            # A heartbeat is a change with no paths.
            kind, body = base.receive(feed)
            assert kind == "c" and json.loads(body) == {"seq": 0, "resync": False, "paths": []}
            base.send(feed, "a", {"seq": 0})
            io, kind, _ = hello("w", "io")
            kind, opened = call(io, "O", {"path": "new.txt", "create": True, "exclusive": True, "truncate": False})
            assert kind == "o" and opened["size"] == 0 and node.files["new.txt"] == b""
            for offset in (0, 3):
                assert call(io, "K", part(opened["handle"], offset, b"abcdef", b"abcdef"[offset:offset + 3]))[0] == "k"
            assert call(io, "G", {"handle": opened["handle"], "index": 0, "offset": 2, "length": 3}) == ("d", b"cde") and node.files["new.txt"] == b""
            # A truncating open empties at once; a kept one starts from the saved bytes.
            assert call(io, "O", {"path": "loss-truncate.txt", "create": False, "exclusive": False, "truncate": True})[0] == "o" and node.files["loss-truncate.txt"] == b""
            kind, kept = call(io, "O", {"path": "loss-keep.txt", "create": False, "exclusive": False, "truncate": False})
            assert kept["size"] == 12 and kept["version"] == version(b"saved before")
            assert call(io, "O", {"path": "loss-keep.txt", "create": True, "exclusive": True, "truncate": False}) == ("e", {"code": "EXISTS", "message": ""})
            # The next mount's abandon drops every handle the view held and commits none of them.
            again, kind, _ = hello("w", "io", abandon=True)
            assert kind == "h" and not node.handles and not node.owners
            assert {key: node.ops[-1][key] for key in ("op", "viewId", "names")} == {"op": "abandoned", "viewId": "w", "names": ["loss-keep.txt", "loss-truncate.txt", "new.txt"]}
            assert node.files["new.txt"] == b"" and node.files["loss-keep.txt"] == b"saved before"
            again.close()
            kind, opened = call(io, "O", {"path": "done.txt", "create": True, "exclusive": False, "truncate": True})
            assert call(io, "K", part(opened["handle"], 0, b"done", b"done"))[0] == "k"
            assert call(io, "C", {"handle": opened["handle"], "size": 4}) == ("k", {"version": version(b"done")})
            listing = {entry["name"]: entry["version"] for entry in call(io, "L", {"path": ""})[1]["entries"]}
            assert listing["done.txt"] == version(b"done") and listing["before.txt"] == version(b"before")
            assert call(io, "R", {"path": "done.txt", "version": version(b"done"), "offset": 1, "length": 2}) == ("d", b"on")
            # A closed view: its feed hears VIEW_CLOSED and a new hello is refused.
            node.close_view("w")
            kind = "c"
            while kind == "c":
                kind, body = base.receive(feed)
            assert kind == "e" and json.loads(body)["code"] == "VIEW_CLOSED"
            late, kind, answer = hello("w", "io")
            assert kind == "e" and answer["code"] == "VIEW_CLOSED"
            for conn in (feed, io, late):
                conn.close()
            time.sleep(0.3)
            assert not node.errors, node.errors
            assert [(entry["viewId"], entry["role"], entry["abandon"]) for entry in node.hellos] == [("w", "feed", False), ("w", "io", False), ("w", "io", True), ("w", "io", False)]
        finally:
            node.close()
    print(json.dumps({"wireFixture": "passed", "privilegedProof": "not-run"}))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "proof":
        if sys.argv[3] not in ("present", "loaded"):
            raise SystemExit("fuse must be present or loaded")
        # The record carries the result; the launcher reads it either way.
        print(json.dumps(Proof(Path(sys.argv[2]), sys.argv[3]).run()))
    elif mode == "cleanup":
        cleanup(Path(sys.argv[2]))
    elif mode == "selftest":
        selftest(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        raise SystemExit(f"unknown mode {mode}")
