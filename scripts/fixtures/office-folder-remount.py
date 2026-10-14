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
