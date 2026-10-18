#!/usr/bin/env python3
"""Disposable nested-VM proof for MC3c: do the office's folder mounts keep their caches on the machine's disk, each in
its own private folder, and does a closed view end its mount within the bound?

Master's folder helper (bundled from packages/runtime) mounts and drops; master's office mount unit runs the real
qorpera-folder program, with only its program and a synthetic protocol-4 node on a Unix socket put in. The proof runs
twice in one VM: `first`, then `second` after the VM restarted, when /run is gone and the disk is not. This is not the
office application: no plumber, credentials, vsock identity, SQL or model is claimed.
"""
import errno
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import uuid

HERE = Path(__file__).resolve().parent
# The remount proof's synthetic node, mount readers and unit rewrite, unchanged; it brings the substrate's wire.
_spec = importlib.util.spec_from_file_location("office_folder_remount", HERE / "office-folder-remount.py")
rm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rm)
base = rm.base

ROOT = rm.ROOT
UNIT = "qorpera-caches-folder-mount@{}.service"
UNIT_FILE = Path("/run/systemd/system/qorpera-caches-folder-mount@.service")
FOLDER_LIB = Path("/var/lib/qorpera-folder")
CACHE = FOLDER_LIB / "cache"
OFFICE_UNIT = "qorpera-company-computer.service"
WORKTREE = "code/o/n/worktrees/w"
# Where the program keeps a worktree's node_modules under its --cache-dir (85's layout, also --local-dir's).
ROOM = "caches/d/code/d/o/d/n/d/worktrees/d/w/t/node_modules"
# The bound from the node's closure: a command's mount ends at once, a desktop's after the program's 60 s grace. The
# product's bound adds the service's 40 s renewal; this node pushes the closure itself, so the proof starts there.
BOUND = {"command": 10, "desktop": 75}
# Read through a mount at the closure: none of these may reach the node.
NODE_READS = ("published.txt", "docs/guide.md")
# Held across the closure by a descriptor that never reads it, while another process on the mount reads it before.
UNREAD = f"{WORKTREE}/package.json"
FOLDERS = ("", "code", "code/o", "code/o/n", "code/o/n/repo.git", "code/o/n/worktrees", WORKTREE, "docs")
FILES = {
    "published.txt": b"published, never read before the close",
    "docs/guide.md": b"# Guide\n",
    f"{WORKTREE}/README.md": b"# w\n",
    f"{WORKTREE}/package.json": b'{"name": "w"}\n',
}


def parent(path):
    return path.rpartition("/")[0]


class CacheNode(rm.RemountNode):
    """The remount node with nested folders, desktops that may switch, and a closed view refused on every request,
    as the core refuses it."""
    def __init__(self, path, heartbeat=10):
        self.switchable = set()
        self.refused = []
        super().__init__(path, heartbeat)
        with self.lock:
            self.files.update(FILES)

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
                        for handle in [handle for handle, owner in self.owners.items() if owner == view]:
                            self.handles.pop(handle, None)
                            self.owners.pop(handle)
                with self.sending:
                    # The program reads `switchable` from every hello, as the service sends it for a desktop.
                    base.send(conn, "h", {"protocol": base.PROTOCOL, "viewId": view, "asOfSeq": 0, "readOnly": False, **({"switchable": True} if view in self.switchable else {})})
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

    def listing(self, path):
        if path not in FOLDERS:
            return None
        folders = [{"name": name.rpartition("/")[2], "kind": "folder", "size": 0, "mtimeMs": 1700000000000, "executable": False, "version": rm.version(name.encode())} for name in FOLDERS if name and parent(name) == path]
        files = [{"name": name.rpartition("/")[2], "kind": "file", "size": len(value), "mtimeMs": 1700000000000, "executable": False, "version": rm.version(value)} for name, value in self.files.items() if parent(name) == path]
        return sorted(folders + files, key=lambda entry: entry["name"])

    def operate(self, view, kind, body):
        if view in self.closed_views:
            # The core refuses every read and write of a closed view, not only new hellos.
            self.refused.append({"at": time.monotonic(), "viewId": view, "kind": kind})
            return "e", {"code": "VIEW_CLOSED", "message": "the view is closed"}
        if kind in ("L", "R", "M", "U", "D", "N"):
            request = json.loads(body)
            self.ops.append({"at": time.monotonic(), "op": kind, "viewId": view, "path": request.get("path"), "to": request.get("to")})
            if kind == "L":
                entries = self.listing(request["path"])
                return ("l", {"entries": entries, "next": None}) if entries is not None else ("e", {"code": "NOT_FOUND", "message": ""})
            if kind == "R":
                if request["path"] not in self.files:
                    return "e", {"code": "NOT_FOUND", "message": ""}
                value = self.files[request["path"]]
                return "d", value[request["offset"]:request["offset"] + request["length"]]
            # A cache is the machine's: a change in one never reaches the node; record any that does.
            return "k", {}
        return super().operate(view, kind, body)


# An office process: each request is one JSON line, each answer the result or the errno.
CLIENT = r'''
import errno, json, mmap, os, resource, select, signal, sys, time
held, maps = {}, {}
def mapread(key):
    # In a child: a page the kernel can no longer fill raises SIGBUS, which would end this process.
    if key not in maps:
        raise OSError(errno.EBADF, "not mapped")
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            os.write(w, maps[key][:])
        except BaseException:
            os._exit(1)
        os._exit(0)
    os.close(w)
    chunks, chunk, deadline = [], None, time.monotonic() + 2
    while time.monotonic() < deadline and select.select([r], [], [], max(0, deadline - time.monotonic()))[0]:
        chunk = os.read(r, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(r)
    if chunk != b"":
        os.kill(pid, signal.SIGKILL)
    done = 0
    for _ in range(30):
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        time.sleep(0.1)
    data = b"".join(chunks)
    if chunk != b"" or not done:
        return {"ok": False, "hung": 2, "bytes": len(data)}
    if os.WIFSIGNALED(status):
        return {"ok": False, "signal": signal.Signals(os.WTERMSIG(status)).name, "bytes": len(data)}
    if os.WEXITSTATUS(status):
        return {"ok": False, "exit": os.WEXITSTATUS(status), "bytes": len(data)}
    return {"text": data.decode(errors="replace")}
def handle(request):
    op = request["op"]
    if op == "read":
        with open(request["path"], "rb") as file:
            return {"text": file.read().decode(errors="replace")}
    if op == "write":
        with open(request["path"], "xb") as file:
            file.write(request["text"].encode())
        return {}
    if op == "mkdir":
        os.mkdir(request["path"], 0o755)
        return {}
    if op == "list":
        return {"names": sorted(os.listdir(request["path"]))}
    if op == "hold":
        held[request["key"]] = os.open(request["path"], os.O_RDONLY | (os.O_DIRECTORY if request.get("folder") else 0))
        return {}
    if op == "pread":
        return {"text": os.pread(held[request["key"]], 65536, 0).decode(errors="replace")}
    if op == "map":
        fd = os.open(request["path"], os.O_RDONLY)
        try:
            maps[request["key"]] = mmap.mmap(fd, 0, mmap.MAP_SHARED, mmap.PROT_READ)
        finally:
            os.close(fd)
        return {}
    if op == "mapread":
        return mapread(request["key"])
    if op == "openat":
        fd = os.open(request["name"], os.O_RDONLY, dir_fd=held[request["key"]])
        try:
            return {"text": os.read(fd, 65536).decode(errors="replace")}
        finally:
            os.close(fd)
    raise ValueError(op)
for line in sys.stdin:
    try:
        reply = {"ok": True, **handle(json.loads(line))}
    except OSError as error:
        reply = {"ok": False, "errno": error.errno, "code": errno.errorcode.get(error.errno)}
    print(json.dumps(reply), flush=True)
'''


class Office:
    """A process of the office's account, as an office program sees the mounts. A request that hangs ends it. With no
    account (the selftest), a process of this one."""
    def __init__(self, office):
        account = {"user": office.pw_uid, "group": office.pw_gid, "extra_groups": []} if office else {}
        self.process = subprocess.Popen([sys.executable if not office else "/usr/bin/python3", "-c", CLIENT], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd="/", env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, **account)

    def ask(self, seconds=10, **request):
        started = time.monotonic()
        try:
            self.process.stdin.write(json.dumps(request) + "\n")
            self.process.stdin.flush()
            ready, _, _ = select.select([self.process.stdout], [], [], seconds)
            if not ready:
                self.close()
                return {"ok": False, "hung": seconds}
            line = self.process.stdout.readline()
        except (OSError, ValueError):
            line = ""
        if not line:
            return {"ok": False, "ended": True}
        return {**json.loads(line), "seconds": round(time.monotonic() - started, 3)}

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            # Stuck in the kernel on a dead mount: the proof's unit takes it away with its control group.
            pass
        # A request after the end is answered "ended", and nothing is left to flush into a pipe no one reads.
        for pipe in (self.process.stdin, self.process.stdout):
            try:
                pipe.close()
            except OSError:
                pass


def once(office, seconds=10, **request):
    """One request from a new office process: nothing it opened earlier helps it."""
    client = Office(office)
    try:
        return client.ask(seconds, **request)
    finally:
        client.close()


def helper(directory, mode, request, seconds=120):
    """One request to a new helper process, as the office's helper socket hands it over (`line`) or past its parser
    (`direct`)."""
    text = request if isinstance(request, str) else json.dumps(request)
    try:
        done = subprocess.run(["node", str(directory / "helper.mjs"), mode, text], capture_output=True, text=True, timeout=seconds)
    except subprocess.TimeoutExpired as error:
        return {"answer": None, "timeout": seconds, "stderr": str(error.stderr or "")[-2000:]}
    try:
        reply = json.loads(done.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        reply = {}
    return {"code": done.returncode, "answer": (reply.get("answer") or {}).get("answer"), "parsed": reply.get("parsed"), "log": reply.get("log"), "stderr": done.stderr[-2000:]}


def private(path, uid=0):
    """A real folder of `uid` that no one else may use."""
    try:
        seen = os.lstat(path)
    except OSError as error:
        return {"path": str(path), "errno": error.errno}
    return {"path": str(path), "folder": (seen.st_mode & 0o170000) == 0o040000, "uid": seen.st_uid, "mode": oct(seen.st_mode & 0o7777), "private": (seen.st_mode & 0o170000) == 0o040000 and seen.st_uid == uid and seen.st_mode & 0o7777 == 0o700}


def holding(top, name):
    """Every file called `name` below `top`."""
    return sorted(str(Path(folder) / name) for folder, _, names in os.walk(top) if name in names) if Path(top).exists() else []


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def ended(track, bound):
    """Row 2: the program exited 3, unrestarted, and its mount is gone, both no later than `bound` seconds from the
    closure. A mount that outlives the bound, or a program that never exits, fails."""
    final = track.get("final") or {}
    return all((
        track.get("exited") is not None and track["exited"] <= bound,
        track.get("unmounted") is not None and track["unmounted"] <= bound,
        final.get("ExecMainStatus") == 3 and final.get("NRestarts") == 0 and final.get("ActiveState") in ("failed", "inactive"),
        track.get("served") is False and track.get("copies") == 0,
    ))


def require_disposable_guest(directory):
    if os.geteuid() != 0 or base.run("systemd-detect-virt", "--vm", check=False) != "kvm":
        raise RuntimeError("A root process inside a nested KVM guest is required")
    if Path("/etc/qorpera-test-machine-versions").exists():
        raise RuntimeError("Never run this fixture on the shared test VM")
    if not re.fullmatch(r"/run/qorpera-caches-[a-f0-9-]{36}", str(directory)):
        raise RuntimeError("Refusing a path outside the UUID-scoped proof directory")


def home_of(directory):
    """The program's home and, between the phases, what the first left for the second: /run may be mounted noexec,
    and the second phase finds /run empty."""
    return Path("/var/lib") / directory.name


def preflight(directory, fuse, phase):
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
        "node": base.run(node, "--version") if node else None,
        "python": sys.version.split()[0],
    }
    missing = [path for path in ("/usr/bin/python3", "/usr/bin/mount", "/usr/bin/umount") if not os.access(path, os.X_OK)]
    missing += [name for name in ("node", "systemctl", "journalctl") if not shutil.which(name)]
    if missing:
        raise RuntimeError(f"The image lacks {missing}")
    if not Path("/dev/fuse").is_char_device():
        raise RuntimeError("/dev/fuse is missing")
    seen["fuse"] = fuse
    office_unit = dict(line.split("=", 1) for line in base.run("systemctl", "show", "-p", "ActiveState,SubState,Result", OFFICE_UNIT).splitlines() if "=" in line)
    if office_unit.get("ActiveState") in ("active", "activating", "reloading", "deactivating"):
        raise RuntimeError(f"The office service is {office_unit['ActiveState']}; this proof needs it stopped")
    seen["officeService"] = office_unit
    office = pwd.getpwnam("qorpera-office")
    if office.pw_uid == 0:
        raise RuntimeError("The office account must be unprivileged")
    seen["office"] = {"uid": office.pw_uid, "gid": office.pw_gid}
    # The helper makes its root anew on every boot; a root that is there was not made by this proof.
    for path in (ROOT, UNIT_FILE):
        if path.exists():
            raise RuntimeError(f"{path} already exists")
    home = home_of(directory)
    seen["folderLibBefore"] = private(FOLDER_LIB)
    if phase == "first" and (home.exists() or CACHE.exists() or CACHE.is_symlink()):
        raise RuntimeError(f"{home} or {CACHE} already exists")
    if phase == "second" and not ((home / "kept.json").is_file() and CACHE.is_dir()):
        raise RuntimeError("The first phase's caches and record are not on the disk")
    return seen, office


def install_unit(directory, claimed, program, office):
    """Master's office mount unit under the proof's name, with only its program and node put in."""
    if UNIT_FILE.exists():
        raise RuntimeError(f"{UNIT_FILE} already exists")
    text = rm.proof_unit((directory / "mount.service").read_text(), program, directory / "node.sock", office.pw_uid, office.pw_gid)
    rm.claim(directory, claimed, "unit", str(UNIT_FILE))
    UNIT_FILE.write_text(text)
    UNIT_FILE.chmod(0o644)
    base.run("systemctl", "daemon-reload")
    return text


def failed_with(reply, code):
    return reply.get("ok") is False and reply.get("errno") == code


def failed(reply):
    """Refused with an errno, at once: a request that hung or a process that died is not a refusal."""
    return reply.get("ok") is False and "errno" in reply


def faulted(reply):
    """A read through a mapping that gave no byte: its page faulted (the child that touched it ended on SIGBUS or
    SIGSEGV), or the read was refused. A read that hung is neither."""
    return reply.get("ok") is False and (reply.get("signal") in ("SIGBUS", "SIGSEGV") or "errno" in reply) and not reply.get("bytes")


CHECKS = {
    "first": ("cacheFlagPassed", "cacheOnMachineDisk", "ownerIsolation", "sameOwnerFindsCache", "cacheDirsPrivate", "mismatchRefused", "badCacheDirRefused", "directControlMounted", "helperRefusesForeignCacheDir", "closedViewReadsFail", "mountEndsWithinBound", "heldFilesEndWithMount", "boundCatchesLiveMount", "fixtureProtocolClean"),
    "second": ("machineRestarted", "restartFindsCaches", "ownerIsolationAfterRestart", "cacheDirsPrivate", "fixtureProtocolClean"),
}
LIMITATIONS = [
    "The node is synthetic: it pushes a view's closure itself, so the bound is measured from the push; the service's 40 s renewal comes before it in the product.",
    "Each helper request is a new helper process, as after a helper restart; the helper's socket, the office application and its namespaces are not part of this proof.",
    "A longer grace cannot be built without the program's Rust: that must-fail is the selftest's; the live one is a closure the node never pushes.",
]


class Proof:
    def __init__(self, directory, fuse, phase):
        self.directory = directory
        self.fuse = fuse
        self.phase = phase
        self.claimed = {}
        self.node = None
        self.office = None
        self.holder = None
        self.program = None
        self.mounts = {}
        self.texts = {}
        self.owners = {}
        self.kept = None
        self.troubles = []
        self.directs = []
        self.record = {"schema": "qorpera.office-folder-caches.guest/v1", "phase": phase, "fuse": fuse, "limitations": LIMITATIONS, "checks": {}, "notes": {}}

    def check(self, name, passed, evidence):
        """A check holds only when every measurement it names holds."""
        self.record["checks"][name] = {"passed": bool(passed), "evidence": evidence}

    def note(self, name, value):
        self.record["notes"][name] = value

    def set_up(self):
        require_disposable_guest(self.directory)
        self.record["boot"] = boot_id()
        seen, self.office = preflight(self.directory, self.fuse, self.phase)
        self.record["preflight"] = seen
        home = home_of(self.directory)
        if self.phase == "first":
            # A folder the image already has is not this proof's; only the caches under it are.
            rm.claim(self.directory, self.claimed, "folderLib", str(CACHE if FOLDER_LIB.exists() else FOLDER_LIB))
            self.program = rm.install_program(self.directory, self.claimed)
        else:
            self.kept = json.loads((home / "kept.json").read_text())
            rm.claim(self.directory, self.claimed, "program", str(home))
            rm.claim(self.directory, self.claimed, "folderLib", self.kept["folderLib"])
            self.texts, self.owners = self.kept["texts"], self.kept["owners"]
            self.program = home / "qorpera-folder"
            self.program.unlink(missing_ok=True)
            shutil.copyfile(self.directory / "qorpera-folder", self.program)
            self.program.chmod(0o555)
        # The helper makes the root on its first request.
        rm.claim(self.directory, self.claimed, "root")
        self.node = CacheNode(self.directory / "node.sock")
        self.record["unit"] = install_unit(self.directory, self.claimed, self.program, self.office)

    def mount(self, tag, kind, cache):
        name = f"{kind}-{uuid.uuid4()}"
        view = {"environmentId": "synthetic", "viewId": f"{tag}-{uuid.uuid4().hex[:12]}", "pass": "synthetic-pass"}
        if kind == "desktop":
            self.node.switchable.add(view["viewId"])
        entry = {"tag": tag, "name": name, "cache": cache, "view": view, "unit": UNIT.format(name), "point": str(ROOT / "mounts" / name / "company")}
        self.mounts[tag] = entry
        entry["mount"] = helper(self.directory, "line", {"op": "mount", "name": name, "view": view, "cache": cache})
        entry["state"] = rm.show(entry["unit"])
        if entry["mount"]["answer"] != "mounted":
            raise RuntimeError(f"{tag} answered {entry['mount']}")
        return entry

    def drop(self, entry):
        entry["drop"] = helper(self.directory, "line", {"op": "drop", "name": entry["name"]})
        entry["dropped"] = entry["drop"]["answer"] in ("dropped", "unknown")
        if not entry["dropped"]:
            self.troubles.append({"drop": entry["tag"], "answer": entry["drop"]})

    def office_does(self, entry, op, rel, **fields):
        return once(self.office, op=op, path=f"{entry['point']}/{rel}", **fields)

    def room(self, name=""):
        return f"{WORKTREE}/node_modules" + (f"/{name}" if name else "")

    def fill(self, entry, key):
        """The office makes a worktree's node_modules and writes one file into it."""
        self.texts[key] = f"{entry['tag']} cache {uuid.uuid4().hex}"
        return {
            "listed": self.office_does(entry, "list", WORKTREE),
            "mkdir": self.office_does(entry, "mkdir", self.room()),
            "write": self.office_does(entry, "write", self.room(key), text=self.texts[key]),
            "read": self.office_does(entry, "read", self.room(key)),
        }

    def filled(self, steps, key):
        return steps["listed"].get("ok") and "node_modules" not in steps["listed"].get("names", []) and steps["mkdir"].get("ok") and steps["write"].get("ok") and steps["read"].get("text") == self.texts[key]

    def on_disk(self, cache, key):
        path = CACHE / cache / ROOM / key
        return path.read_text() if path.is_file() and not path.is_symlink() else None

    def desktop_cache(self):
        """R1, R2: the helper hands the desktop's cache folder to the unit, and a desktop's node_modules lives there."""
        d1 = self.mount("d1", "desktop", "desktop")
        args = [part.decode() for part in Path(f"/proc/{d1['state']['MainPID']}/cmdline").read_bytes().split(b"\0")]
        flag = args[args.index("--cache-dir") + 1] if "--cache-dir" in args else None
        env = ROOT / "units" / f"{d1['name']}.env"
        seen = os.lstat(env)
        env_text = env.read_text()
        self.check("cacheFlagPassed", flag == str(CACHE / "desktop") and env_text == f"QORPERA_FOLDER_CACHE_DIR={CACHE / 'desktop'}\n" and seen.st_uid == 0 and seen.st_mode & 0o7777 == 0o600, {"programArgs": args, "envFile": env_text, "envMode": oct(seen.st_mode & 0o7777), "envUid": seen.st_uid})
        self.note("kernelCache", [line for line in rm.journal(d1["unit"], 80) if "kernel cache" in line])
        steps = self.fill(d1, "x")
        touched = [op for op in self.node.ops if "node_modules" in f"{op.get('path')} {op.get('to')} {op.get('name')}"]
        self.check("cacheOnMachineDisk", self.filled(steps, "x") and self.on_disk("desktop", "x") == self.texts["x"] and not holding(ROOT / "state", "x") and not touched, {"steps": steps, "expected": str(CACHE / "desktop" / ROOM / "x"), "found": holding(CACHE, "x"), "inState": holding(ROOT / "state", "x"), "nodeOpsNamingIt": touched})

    def owners_apart(self):
        """R4: a command's cache is its owner's: another owner and the desktops never see it, and the owner's next
        command finds it."""
        self.owners = {"a": f"agent-{uuid.uuid4()}", "b": f"agent-{uuid.uuid4()}"}
        d1 = self.mounts["d1"]
        ca1 = self.mount("ca1", "command", self.owners["a"])
        apart = {"ca1": {"desktopFile": self.office_does(ca1, "read", self.room("x"))}}
        filled = {"a": self.fill(ca1, "a")}
        cb = self.mount("cb", "command", self.owners["b"])
        apart["cb"] = {"listed": self.office_does(cb, "list", WORKTREE), "ownerAFile": self.office_does(cb, "read", self.room("a")), "desktopFile": self.office_does(cb, "read", self.room("x"))}
        filled["b"] = self.fill(cb, "b")
        apart["d1"] = {key: self.office_does(d1, "read", self.room(key)) for key in ("a", "b")}
        self.drop(ca1)
        self.drop(cb)
        ca2 = self.mount("ca2", "command", self.owners["a"])
        again = {"own": self.office_does(ca2, "read", self.room("a")), "ownerBFile": self.office_does(ca2, "read", self.room("b")), "desktopFile": self.office_does(ca2, "read", self.room("x"))}
        disk = {"a": self.on_disk(self.owners["a"], "a"), "b": self.on_disk(self.owners["b"], "b"), "found": {key: holding(CACHE, key) for key in ("x", "a", "b")}}
        refusals = [apart["ca1"]["desktopFile"], apart["cb"]["ownerAFile"], apart["cb"]["desktopFile"], apart["d1"]["a"], apart["d1"]["b"]]
        placed = disk["a"] == self.texts["a"] and disk["b"] == self.texts["b"] and all(len(disk["found"][key]) == 1 for key in disk["found"])
        self.check("ownerIsolation", all(self.filled(filled[key], key) for key in filled) and all(failed_with(reply, errno.ENOENT) for reply in refusals) and "node_modules" not in apart["cb"]["listed"].get("names", ["node_modules"]) and placed, {"apart": apart, "filled": filled, "disk": disk})
        self.check("sameOwnerFindsCache", ca1["dropped"] and again["own"].get("text") == self.texts["a"] and failed_with(again["ownerBFile"], errno.ENOENT) and failed_with(again["desktopFile"], errno.ENOENT), {"ca1Drop": ca1["drop"], "ca2": again})
        self.dirs_private()

    def dirs_private(self):
        """Every cache folder is root's alone: 0700, a real folder, from the machine's folder down to each owner's."""
        folders = [FOLDER_LIB, CACHE, CACHE / "desktop"] + [CACHE / owner for owner in self.owners.values()]
        seen = [private(path) for path in folders]
        self.check("cacheDirsPrivate", all(entry.get("private") for entry in seen), {"folders": seen, "cacheRoot": sorted(os.listdir(CACHE))})

    def mismatch(self):
        """R5: a desktop never takes an owner's cache and a command never the desktops'; as the helper's socket reads
        the line, and past its parser."""
        cases = []
        for mode in ("line", "direct"):
            for kind, cache in (("desktop", f"agent-{uuid.uuid4()}"), ("command", "desktop"), ("command", "../desktop"), ("command", "")):
                name = f"{kind}-{uuid.uuid4()}"
                view = {"environmentId": "synthetic", "viewId": f"mismatch-{uuid.uuid4().hex[:12]}", "pass": "synthetic-pass"}
                reply = helper(self.directory, mode, {"op": "mount", "name": name, "view": view, "cache": cache})
                left = [str(path) for path in (ROOT / "views" / f"{name}.json", ROOT / "units" / f"{name}.env", ROOT / "mounts" / name, ROOT / "state" / name) if path.exists()]
                if cache.startswith("agent-") and (CACHE / cache).exists():
                    left.append(str(CACHE / cache))
                cases.append({"mode": mode, "kind": kind, "cache": cache, "answer": reply["answer"], "parsed": reply["parsed"], "left": left, "unit": rm.show(UNIT.format(name)).get("ActiveState")})
        # The line's parser refuses it before the helper; the helper refuses it again when handed it.
        self.check("mismatchRefused", all(case["answer"] == "invalid" and case["parsed"] == (case["mode"] == "direct") and not case["left"] and case["unit"] == "inactive" for case in cases), {"cases": cases})

    def direct(self, tag, make, close=False):
        """The program as the unit runs it, by hand, with the cache folder `make(work, state)` returns (or the cache
        folder and a `--local-dir`); cwd is `work`. `work`'s name is short: the program refuses a cache folder over 80
        bytes before it looks at anything else. The state folder is left empty: the program refuses one it did not
        make before it looks at the cache folder."""
        work = self.directory / "d" / str(len(self.directs))
        self.directs.append(tag)
        point, state = work / "company", work / "state"
        for path in (work, point, state):
            path.mkdir(mode=0o700, parents=True)
        made = make(work, state)
        cache_dir, local_dir = made if isinstance(made, tuple) else (made, None)
        view = {"environmentId": "synthetic", "viewId": f"direct-{tag}-{uuid.uuid4().hex[:12]}", "pass": "synthetic-pass"}
        (work / "view.json").write_text(json.dumps(view))
        (work / "view.json").chmod(0o600)
        args = [str(self.program), "mount", "--connect", f"unix:{self.directory / 'node.sock'}", "--view-file", str(work / "view.json"), "--mountpoint", str(point), "--state-dir", str(state), "--cache-dir", str(cache_dir), "--allow-other", "yes", "--owner-uid", str(self.office.pw_uid), "--owner-gid", str(self.office.pw_gid)]
        args += ["--local-dir", str(local_dir)] if local_dir else []
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=work)
        run = {"cacheDir": str(cache_dir), "bytes": len(os.fsencode(str(cache_dir))), "localDir": str(local_dir) if local_dir else None}
        if close:
            try:
                run["servedAfter"] = base.eventually(lambda: rm.served(str(point)), 20) and True
            except TimeoutError:
                run["servedAfter"] = False
            self.node.close_view(view["viewId"])
        try:
            out, err = process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            out, err = process.communicate()
            run["killed"] = True
        run.update({"code": process.returncode, "stderr": err[-2000:], "stdout": out[-500:], "mountedAfter": rm.count(str(point))})
        if run["mountedAfter"]:
            run["unmount"] = rm.quiet("umount", "-l", str(point))
        return run

    def bad_cache_dirs(self):
        """R6: the program refuses a cache folder that is not root's alone, and mounts with one that is."""
        office = self.office

        def folder(name, mode=0o700, owner=None):
            def make(work, state):
                path = work / name
                path.mkdir(mode=mode)
                path.chmod(mode)
                if owner:
                    os.chown(path, owner.pw_uid, owner.pw_gid)
                return path
            return make

        def link(work, state):
            (work / "real").mkdir(mode=0o700)
            (work / "link").symlink_to(work / "real")
            return work / "link"

        def inside(work, state):
            # The local folder is given outside the state folder, which must hold nothing the program did not make.
            local = work / "local"
            (local / "inner").mkdir(mode=0o700, parents=True)
            for path in (local, local / "inner"):
                path.chmod(0o700)
            return local / "inner", local

        absolute = "must be an absolute path of at most 80 bytes"
        alone = "must be a folder (not a link) only this account can use"
        nested = "must not be inside the local folder, nor hold it"
        cases = {
            "groupAndOthers": (folder("open", 0o755), alone),
            "link": (link, alone),
            "officeOwned": (folder("office", owner=office), alone),
            "relative": (lambda work, state: folder("rel")(work, state).relative_to(work), absolute),
            "missing": (lambda work, state: work / "absent", None),
            "tooLong": (folder("l" * 60), absolute),
            "holdsLocal": (lambda work, state: state, nested),
            "insideLocal": (inside, nested),
        }
        runs = {}
        for tag, (make, why) in cases.items():
            run = self.direct(tag, make)
            run["why"] = why
            run["refused"] = run["code"] == 1 and f"FOLDER_CACHE_DIR_UNUSABLE: {run['cacheDir']}:" in run["stderr"] and (why is None or why in run["stderr"]) and not run["mountedAfter"] and not run.get("killed")
            runs[tag] = run
        self.check("badCacheDirRefused", all(run["refused"] for run in runs.values()), runs)
        good = self.direct("good", folder("good"), close=True)
        self.check("directControlMounted", good["servedAfter"] and good["code"] == 3 and not good["mountedAfter"], good)

    def foreign_cache_dir(self):
        """R6: the helper refuses to hand over an owner's cache folder that is a link, or that the office owns, and
        leaves no mount, unit or view behind."""
        target = self.directory / "foreign"
        target.mkdir(mode=0o700)
        linked, owned = f"agent-{uuid.uuid4()}", f"agent-{uuid.uuid4()}"
        (CACHE / linked).symlink_to(target)
        (CACHE / owned).mkdir(mode=0o700)
        os.chown(CACHE / owned, self.office.pw_uid, self.office.pw_gid)
        cases = {}
        for tag, owner in (("link", linked), ("officeOwned", owned)):
            name = f"command-{uuid.uuid4()}"
            view = {"environmentId": "synthetic", "viewId": f"foreign-{uuid.uuid4().hex[:12]}", "pass": "synthetic-pass"}
            reply = helper(self.directory, "line", {"op": "mount", "name": name, "view": view, "cache": owner})
            left = [str(path) for path in (ROOT / "views" / f"{name}.json", ROOT / "units" / f"{name}.env", ROOT / "mounts" / name, ROOT / "state" / name) if path.exists()]
            cases[tag] = {"answer": reply["answer"], "log": reply["log"], "left": left, "unit": rm.show(UNIT.format(name)).get("ActiveState"), "hellos": [hello for hello in self.node.hellos if hello["viewId"] == view["viewId"]]}
        seen = os.lstat(CACHE / owned)
        kept = (CACHE / linked).is_symlink() and os.listdir(target) == [] and seen.st_uid == self.office.pw_uid
        self.check("helperRefusesForeignCacheDir", kept and all(case["answer"] == "failed" and not case["left"] and case["unit"] in ("inactive", "failed") and not case["hellos"] for case in cases.values()), {"cases": cases, "linkKept": (CACHE / linked).is_symlink(), "targetEntries": os.listdir(target), "ownedUid": seen.st_uid})
        (CACHE / linked).unlink()
        (CACHE / owned).rmdir()

    def held_reads(self, tag, key, unread=False):
        """What the holder's descriptors and mapping read now; with `unread`, also the descriptor that read nothing
        before (only another process read its file)."""
        reads = {
            "file": self.holder.ask(5, op="pread", key=f"{tag}-file"),
            "node": self.holder.ask(5, op="pread", key=f"{tag}-node"),
            "openat": self.holder.ask(5, op="openat", key=f"{tag}-room", name=key),
            "map": self.holder.ask(10, op="mapread", key=f"{tag}-map"),
        }
        if unread:
            reads["unread"] = self.holder.ask(5, op="pread", key=f"{tag}-unread")
        return reads

    def observe(self, track, entry, now):
        state = rm.show(entry["unit"])
        if track["exited"] is None and state.get("ExecMainStatus") == 3 and state.get("ActiveState") in ("failed", "inactive"):
            track["exited"] = round(now, 2)
        if track["unmounted"] is None and rm.copies(entry["point"]) == 0:
            track["unmounted"] = round(now, 2)

    def final(self, track, entry):
        return {**track, "final": rm.show(entry["unit"]), "served": rm.served(entry["point"]), "copies": rm.copies(entry["point"]), "statErrno": rm.stat_errno(entry["point"])}

    def revocation(self):
        """R7: from the closure no read reaches the node; by the bound the mount is gone, and the cached files with it;
        a file held open across the closure reads nothing after the end, from the kernel's cache either: not through
        a descriptor that read it, one that never read it (another process did), or a mapping. The live must-fail is a
        closure the node never pushes, as if the program had no exit: the bound's check must catch the mount that is
        still there."""
        d1, ca2 = self.mounts["d1"], self.mounts["ca2"]
        closing = {"d1": (d1, "x", BOUND["desktop"]), "ca2": (ca2, "a", BOUND["command"])}
        self.holder = Office(self.office)
        before, others = {}, {}
        for tag, (entry, key, _) in closing.items():
            for name, rel, folder in (("file", self.room(key), False), ("node", f"{WORKTREE}/README.md", False), ("room", self.room(), True), ("unread", UNREAD, False)):
                reply = self.holder.ask(op="hold", key=f"{tag}-{name}", path=f"{entry['point']}/{rel}", folder=folder)
                if not reply.get("ok"):
                    raise RuntimeError(f"{tag} could not hold {rel}: {reply}")
            # The holder never reads `unread`; another office process reads its file, so the kernel caches it.
            others[tag] = self.office_does(entry, "read", UNREAD)
            mapped = self.holder.ask(op="map", key=f"{tag}-map", path=f"{entry['point']}/{self.room(key)}")
            before[tag] = {**self.held_reads(tag, key), "mapped": mapped}
            if [before[tag][name].get("text") for name in ("file", "node", "openat")] != [self.texts[key], FILES[f"{WORKTREE}/README.md"].decode(), self.texts[key]] or others[tag].get("text") != FILES[UNREAD].decode():
                raise RuntimeError(f"{tag}'s held files did not read: {before[tag]}, {others[tag]}")
        cw = self.mount("cw", "command", f"agent-{uuid.uuid4()}")
        self.owners["w"] = cw["cache"]
        start = time.monotonic()
        for entry, _, _ in closing.values():
            self.node.close_view(entry["view"]["viewId"])
        reads = {tag: {rel: {**self.office_does(entry, "read", rel, seconds=5), "at": round(time.monotonic() - start, 2)} for rel in NODE_READS} for tag, (entry, _, _) in closing.items()}
        # What the grace may still serve: only what is already on the machine. Recorded, not required.
        self.note("duringGrace", {tag: {"at": round(time.monotonic() - start, 2), "held": self.held_reads(tag, key), "newOpenOfCached": self.office_does(entry, "read", self.room(key), seconds=5), "newOpenOfReadNodeFile": self.office_does(entry, "read", f"{WORKTREE}/README.md", seconds=5)} for tag, (entry, key, _) in closing.items()})
        tracks = {tag: {"exited": None, "unmounted": None} for tag in closing}
        live, again = {"exited": None, "unmounted": None}, {"exited": None, "unmounted": None}
        withheld, closed = None, None
        deadline = start + BOUND["desktop"] + 12
        while time.monotonic() < deadline:
            now = time.monotonic() - start
            for tag, (entry, _, _) in closing.items():
                self.observe(tracks[tag], entry, now)
            if closed is None:
                self.observe(live, cw, now)
                if now >= BOUND["command"] + 0.5:
                    withheld = self.final(live, cw)
                    self.node.close_view(cw["view"]["viewId"])
                    closed = time.monotonic()
            else:
                self.observe(again, cw, time.monotonic() - closed)
            settled = [(track, now) for track in tracks.values()] + ([(again, time.monotonic() - closed)] if closed else [])
            # Past RestartSec=5s after each exit: a restart would have begun by then.
            if closed and all(track["exited"] is not None and track["unmounted"] is not None and at >= track["exited"] + 9 for track, at in settled):
                break
            time.sleep(0.25)
        finals = {tag: self.final(tracks[tag], entry) for tag, (entry, _, _) in closing.items()}
        through = {tag: self.office_does(entry, "read", self.room(key), seconds=5) for tag, (entry, key, _) in closing.items()}
        kept = {tag: self.on_disk(entry["cache"], key) == self.texts[key] for tag, (entry, key, _) in closing.items()}
        after = {tag: self.held_reads(tag, key, unread=True) for tag, (entry, key, _) in closing.items()}
        self.holder.close()
        released = self.final(again, cw)
        refusals = {}
        for refusal in self.node.refused:
            refusals.setdefault(refusal["viewId"], []).append(refusal["kind"])
        bounds = {tag: bound for tag, (_, _, bound) in closing.items()}
        self.check("closedViewReadsFail", all(failed(reply) for tag in reads for reply in reads[tag].values()), {"reads": reads, "refusedByNode": {view: "".join(kinds) for view, kinds in refusals.items()}})
        self.check("mountEndsWithinBound", all(ended(finals[tag], bounds[tag]) and failed(through[tag]) and kept[tag] for tag in closing), {"boundsFromClosure": bounds, "tracks": finals, "cachedReadThroughMount": through, "cacheKeptOnDisk": kept})
        self.note("desktopExitSeconds", finals["d1"]["exited"])
        # Until the end a held file may read what the kernel cached; after it, nothing does.
        mapped = {tag: before[tag]["mapped"].get("ok") is True and before[tag]["map"].get("text") == self.texts[key] for tag, (_, key, _) in closing.items()}
        self.check("heldFilesEndWithMount", all(mapped.values()) and all(faulted(reply) if name == "map" else failed(reply) for tag in after for name, reply in after[tag].items()), {"before": before, "otherProcessRead": others, "mappedBefore": mapped, "afterTheEnd": after})
        self.check("boundCatchesLiveMount", withheld is not None and not ended(withheld, BOUND["command"]) and withheld["served"] and ended(released, BOUND["command"]), {"withheldAtBound": withheld, "afterItsClosure": released})
        for entry in (d1, ca2, cw):
            self.drop(entry)

    def keep(self):
        """What the second phase needs after the restart, beside the caches on the disk."""
        (home_of(self.directory) / "kept.json").write_text(json.dumps({"folderLib": self.claimed["folderLib"], "boot": self.record["boot"], "texts": self.texts, "owners": self.owners}))

    def after_restart(self):
        """R3: the machine restarted; each mount finds its own cache on the disk, and only its own."""
        self.check("machineRestarted", self.kept["boot"] != self.record["boot"], {"firstBoot": self.kept["boot"], "boot": self.record["boot"], "folderLibBefore": self.record["preflight"]["folderLibBefore"]})
        mounts = {"d3": (self.mount("d3", "desktop", "desktop"), "x"), "ca3": (self.mount("ca3", "command", self.owners["a"]), "a"), "cb2": (self.mount("cb2", "command", self.owners["b"]), "b")}
        found = {tag: {"read": self.office_does(entry, "read", self.room(key)), "listed": self.office_does(entry, "list", self.room())} for tag, (entry, key) in mounts.items()}
        self.check("restartFindsCaches", all(found[tag]["read"].get("text") == self.texts[key] and found[tag]["listed"].get("names") == [key] for tag, (_, key) in mounts.items()), found)
        apart = {tag: {other: self.office_does(entry, "read", self.room(other)) for other in ("x", "a", "b") if other != key} for tag, (entry, key) in mounts.items()}
        self.check("ownerIsolationAfterRestart", all(failed_with(reply, errno.ENOENT) for replies in apart.values() for reply in replies.values()), apart)
        self.dirs_private()
        for entry, _ in mounts.values():
            self.drop(entry)

    def tear_down(self):
        """The proof takes away every mount it made; pause or cleanup takes away the rest."""
        steps = {}
        if self.holder:
            self.holder.close()
        for tag, entry in self.mounts.items():
            if "dropped" not in entry:
                self.drop(entry)
                steps[tag] = entry["drop"]["answer"]
        if self.node:
            self.node.close()
        return steps

    def evidence(self):
        self.record["mounts"] = {tag: {key: entry.get(key) for key in ("name", "cache", "unit", "point", "mount", "state", "drop")} for tag, entry in self.mounts.items()}
        self.record["journals"] = {entry["unit"]: rm.journal(entry["unit"], 60) for entry in self.mounts.values()}
        kernel = rm.quiet("journalctl", "-k", "--no-pager", "-o", "cat", "--since", f"@{self.started}").get("output", "")
        self.record["kernelDenials"] = [line for line in kernel.splitlines() if "denied" in line.lower()]

    def run(self):
        self.started = int(time.time())
        steps = {"first": (self.desktop_cache, self.owners_apart, self.mismatch, self.bad_cache_dirs, self.foreign_cache_dir, self.revocation, self.keep), "second": (self.after_restart,)}
        try:
            self.set_up()
            for step in steps[self.phase]:
                step()
        except Exception as error:
            self.record["error"] = repr(error)
            self.record["traceback"] = traceback.format_exc().splitlines()[-12:]
        finally:
            self.record["teardown"] = self.tear_down()
            self.evidence()
        errors = list(self.node.errors) if self.node else ["the node never started"]
        self.check("fixtureProtocolClean", not errors and not self.troubles, {"nodeErrors": errors, "troubles": self.troubles})
        if self.node:
            self.record["nodeHellos"] = len(self.node.hellos)
            self.record["nodeOps"] = self.node.ops[-300:]
        self.record["missingChecks"] = [name for name in CHECKS[self.phase] if name not in self.record["checks"]]
        clean = "error" not in self.record and not self.record["missingChecks"]
        self.record["result"] = "passed" if clean and all(entry["passed"] for entry in self.record["checks"].values()) else "failed"
        return self.record


def take_away(directory, keep):
    """Removes only what this directory's claim names. With `keep`, the program's home and the caches stay on the disk
    for the second phase; all in /run goes, as the restart would take it anyway."""
    require_disposable_guest(directory)
    steps = [rm.quiet("systemctl", "stop", f"{directory.name}-proof.service")]
    units = rm.quiet("systemctl", "list-units", "--all", "--plain", "--no-legend", UNIT.format("*")).get("output", "")
    for unit in (line.split()[0] for line in units.splitlines() if line.strip()):
        steps += [rm.quiet("systemctl", "stop", unit), rm.quiet("systemctl", "reset-failed", unit)]
    claimed = json.loads((directory / "claimed.json").read_text()) if (directory / "claimed.json").exists() else {}
    tops = [str(directory)] + ([str(ROOT)] if claimed.get("root") else [])

    def left():
        # Deepest first; a propagated copy has the same path, so each round takes one layer.
        return sorted({entry["mountpoint"] for entry in rm.mountinfo() if any(entry["mountpoint"] == top or entry["mountpoint"].startswith(top + "/") for top in tops)}, key=len, reverse=True)

    for _ in range(6):
        if not left():
            break
        steps += [rm.quiet("umount", "-l", point) for point in left()]
    if left():
        raise RuntimeError(f"Mounts are left: {left()}")
    if claimed.get("root"):
        shutil.rmtree(ROOT, ignore_errors=True)
    if claimed.get("unit"):
        UNIT_FILE.unlink(missing_ok=True)
        steps.append(rm.quiet("systemctl", "daemon-reload"))
    if not keep:
        for key in ("program", "folderLib"):
            if claimed.get(key):
                shutil.rmtree(claimed[key], ignore_errors=True)
    shutil.rmtree(directory)
    return claimed, steps


def pause(directory):
    """After a first phase that passed: the caches and what the second phase needs stay; everything else goes."""
    kept = home_of(directory) / "kept.json"
    if not kept.is_file():
        raise RuntimeError("The first phase kept nothing for the second")
    claimed, steps = take_away(directory, keep=True)
    print(json.dumps({"pause": "done", "claimed": claimed, "kept": str(kept), "steps": steps}))


def cleanup(directory):
    """After the second phase, a first that failed, or a proof that was stopped."""
    claimed, steps = take_away(directory, keep=False)
    print(json.dumps({"cleanup": "done", "claimed": claimed, "steps": steps}))


def selftest(mount_path):
    """Unprivileged checks of the bound, the synthetic node's wire, the office client and the unit's cache line.
    Deliberately claims no FUSE, helper or systemd proof."""
    unit = {"ExecMainStatus": 3, "NRestarts": 0, "ActiveState": "failed"}
    done = {"exited": 0.3, "unmounted": 0.4, "served": False, "copies": 0, "final": unit}
    assert ended(done, BOUND["command"]) and ended({**done, "exited": 60.4, "unmounted": 60.5}, BOUND["desktop"])
    assert ended({**done, "final": {**unit, "ActiveState": "inactive"}}, BOUND["command"])
    # Must-fail: a longer grace (90 s) outlives the desktop's bound, and a program with no exit never ends.
    assert not ended({**done, "exited": 90.2, "unmounted": 90.3}, BOUND["desktop"])
    assert not ended({**done, "exited": 10.6, "unmounted": 10.7}, BOUND["command"])
    assert not ended({**done, "exited": None, "unmounted": None, "served": True, "copies": 1, "final": {**unit, "ExecMainStatus": 0, "ActiveState": "active"}}, BOUND["command"])
    assert not ended({**done, "unmounted": None}, BOUND["command"]) and not ended({**done, "served": True}, BOUND["command"]) and not ended({**done, "copies": 1}, BOUND["command"])
    assert not ended({**done, "final": {**unit, "NRestarts": 1}}, BOUND["command"]) and not ended({**done, "final": {**unit, "ExecMainStatus": 1}}, BOUND["command"])
    assert failed({"ok": False, "errno": 5}) and not failed({"ok": False, "hung": 5}) and not failed({"ok": False, "ended": True}) and not failed({"ok": True, "text": ""})
    assert failed_with({"ok": False, "errno": errno.ENOENT}, errno.ENOENT) and not failed_with({"ok": False, "errno": errno.EIO}, errno.ENOENT)
    assert faulted({"ok": False, "signal": "SIGBUS", "bytes": 0}) and faulted({"ok": False, "errno": errno.ENOTCONN})
    # Must-fail: a mapping that still gave bytes, hung, or ended its child some other way.
    assert not faulted({"ok": True, "text": "cached"}) and not faulted({"ok": False, "signal": "SIGBUS", "bytes": 6}) and not faulted({"ok": False, "hung": 2, "bytes": 0})
    assert not faulted({"ok": False, "signal": "SIGKILL", "bytes": 0}) and not faulted({"ok": False, "exit": 1, "bytes": 0}) and not faulted({"ok": False, "ended": True})
    lines = rm.proof_unit(mount_path.read_text(), "/var/lib/qorpera-caches-x/qorpera-folder", "/run/qorpera-caches-x/node.sock", 1000, 1001).splitlines()
    # The helper's env file names the cache folder; the proof's unit keeps both lines as master's has them.
    assert "EnvironmentFile=/run/qorpera-folder/units/%i.env" in lines
    assert any(line.startswith("ExecStart=/var/lib/qorpera-caches-x/qorpera-folder mount --connect unix:/run/qorpera-caches-x/node.sock ") and " --cache-dir ${QORPERA_FOLDER_CACHE_DIR} " in line for line in lines)
    assert "RestartPreventExitStatus=3" in lines and "ExecStopPost=-/usr/bin/umount -l /run/qorpera-folder/mounts/%i/company" in lines
    with tempfile.TemporaryDirectory(prefix="qorpera-caches-self-") as tmp:
        top = Path(tmp)
        (top / "closed").mkdir(mode=0o700)
        (top / "open").mkdir(mode=0o755)
        (top / "open").chmod(0o755)
        (top / "link").symlink_to(top / "closed")
        me = os.geteuid()
        assert private(top / "closed", me)["private"] and not private(top / "open", me)["private"] and not private(top / "link", me)["private"]
        assert not private(top / "closed", me + 1)["private"] and private(top / "absent", me)["errno"] == errno.ENOENT
        (top / "closed" / "x").write_text("cached")
        (top / "open" / "deep").mkdir()
        (top / "open" / "deep" / "x").write_text("again")
        assert holding(top, "x") == sorted([str(top / "closed" / "x"), str(top / "open" / "deep" / "x")]) and holding(top / "absent", "x") == []
        client = Office(None)
        try:
            path = str(top / "closed" / "y")
            assert client.ask(op="write", path=path, text="hello")["ok"] and client.ask(op="read", path=path)["text"] == "hello"
            assert failed_with(client.ask(op="write", path=path, text="again"), errno.EEXIST)
            assert client.ask(op="mkdir", path=str(top / "closed" / "room"))["ok"]
            assert client.ask(op="list", path=str(top / "closed"))["names"] == ["room", "x", "y"]
            assert client.ask(op="hold", key="file", path=path)["ok"] and client.ask(op="hold", key="room", path=str(top / "closed"), folder=True)["ok"]
            assert client.ask(op="pread", key="file")["text"] == "hello" and client.ask(op="openat", key="room", name="x")["text"] == "cached"
            assert failed_with(client.ask(op="openat", key="room", name="absent"), errno.ENOENT)
            assert failed_with(client.ask(op="hold", key="file", path=path, folder=True), errno.ENOTDIR)
            mapped = top / "closed" / "m"
            mapped.write_text("mapped")
            assert client.ask(op="map", key="m", path=str(mapped))["ok"] and client.ask(op="mapread", key="m")["text"] == "mapped"
            # Must-fail: a mapped page the kernel can no longer fill ends the child that touches it, not the holder.
            os.truncate(mapped, 0)
            reply = client.ask(op="mapread", key="m")
            assert faulted(reply) and reply["signal"] == "SIGBUS" and client.ask(op="pread", key="file")["text"] == "hello"
            assert failed_with(client.ask(op="mapread", key="absent"), errno.EBADF)
        finally:
            client.close()
        assert failed_with(once(None, op="read", path=str(top / "absent")), errno.ENOENT)
        assert client.ask(op="read", path=path) == {"ok": False, "ended": True}
    with tempfile.TemporaryDirectory(prefix="qorpera-caches-wire-") as tmp:
        node = CacheNode(Path(tmp) / "node.sock", heartbeat=0.2)
        try:
            def hello(view, role):
                conn = socket.socket(socket.AF_UNIX)
                conn.settimeout(3)
                conn.connect(str(Path(tmp) / "node.sock"))
                base.send(conn, "H", {"protocol": 4, "environmentId": "synthetic", "viewId": view, "pass": "synthetic-pass", "role": role})
                kind, body = base.receive(conn)
                return conn, kind, json.loads(body)

            def call(conn, kind, value):
                base.send(conn, kind, value)
                kind, body = base.receive(conn)
                return kind, body if kind == "d" else json.loads(body)

            def names(conn, path):
                return [(entry["name"], entry["kind"]) for entry in call(conn, "L", {"path": path})[1]["entries"]]

            node.switchable.add("desk")
            feed, kind, ok = hello("desk", "feed")
            assert kind == "h" and ok == {"protocol": 4, "viewId": "desk", "asOfSeq": 0, "readOnly": False, "switchable": True}
            desk, kind, ok = hello("desk", "io")
            assert kind == "h" and ok["switchable"] is True
            command, kind, ok = hello("cmd", "io")
            assert kind == "h" and "switchable" not in ok
            top_names = names(command, "")
            assert {("code", "folder"), ("docs", "folder"), ("published.txt", "file")} <= set(top_names)
            assert names(command, "code/o/n") == [("repo.git", "folder"), ("worktrees", "folder")]
            assert names(command, WORKTREE) == [("README.md", "file"), ("package.json", "file")]
            # The program asks for the worktree's index under repo.git; none means an empty one.
            assert call(command, "L", {"path": "code/o/n/repo.git/worktrees/w"}) == ("e", {"code": "NOT_FOUND", "message": ""})
            readme = FILES[f"{WORKTREE}/README.md"]
            assert call(command, "R", {"path": f"{WORKTREE}/README.md", "version": rm.version(readme), "offset": 2, "length": 64}) == ("d", readme[2:])
            assert call(command, "R", {"path": "absent.txt", "version": "v-0", "offset": 0, "length": 1}) == ("e", {"code": "NOT_FOUND", "message": ""})
            assert call(command, "M", {"path": f"{WORKTREE}/node_modules"}) == ("k", {})
            assert {key: node.ops[-1][key] for key in ("op", "viewId", "path")} == {"op": "M", "viewId": "cmd", "path": f"{WORKTREE}/node_modules"}
            # A closed view: its feed hears VIEW_CLOSED, its open connection is refused every request, and so is a new hello.
            node.close_view("desk")
            kind = "c"
            while kind == "c":
                kind, body = base.receive(feed)
            assert kind == "e" and json.loads(body)["code"] == "VIEW_CLOSED"
            assert call(desk, "L", {"path": ""}) == ("e", {"code": "VIEW_CLOSED", "message": "the view is closed"})
            assert call(desk, "R", {"path": f"{WORKTREE}/README.md", "version": rm.version(readme), "offset": 0, "length": 1})[1]["code"] == "VIEW_CLOSED"
            assert [(entry["viewId"], entry["kind"]) for entry in node.refused] == [("desk", "L"), ("desk", "R")]
            late, kind, answer = hello("desk", "io")
            assert kind == "e" and answer["code"] == "VIEW_CLOSED"
            # Another view still answers.
            assert call(command, "L", {"path": "docs"}) == ("l", {"entries": [{"name": "guide.md", "kind": "file", "size": len(FILES["docs/guide.md"]), "mtimeMs": 1700000000000, "executable": False, "version": rm.version(FILES["docs/guide.md"])}], "next": None})
            for conn in (feed, desk, command, late):
                conn.close()
            time.sleep(0.3)
            assert not node.errors, node.errors
        finally:
            node.close()
    assert set(CHECKS["second"]) - set(CHECKS["first"]) == {"machineRestarted", "restartFindsCaches", "ownerIsolationAfterRestart"}
    print(json.dumps({"wireFixture": "passed", "privilegedProof": "not-run"}))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "proof":
        if sys.argv[3] not in ("present", "loaded") or sys.argv[4] not in ("first", "second"):
            raise SystemExit("usage: proof <dir> <present|loaded> <first|second>")
        # The record carries the result; the launcher reads it either way.
        print(json.dumps(Proof(Path(sys.argv[2]), sys.argv[3], sys.argv[4]).run()))
    elif mode == "pause":
        pause(Path(sys.argv[2]))
    elif mode == "cleanup":
        cleanup(Path(sys.argv[2]))
    elif mode == "selftest":
        selftest(Path(sys.argv[2]))
    else:
        raise SystemExit(f"unknown mode {mode}")
