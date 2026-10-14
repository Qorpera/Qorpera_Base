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
