"""One program inside a sandboxed office namespace, for the Q3 remount proof (office-folder-remount.py).

The office relay starts it with the runtime's own process gate and bubblewrap arguments. It answers one JSON request
per line with one JSON line. An OSError comes back as its errno: the proof records errors, it does not hide them.
"""
import json
import os
import sys
import threading
import time

NAME = sys.argv[1]
# Proves an answer after a restart comes from the same process, whatever PID the namespace gives it.
TOKEN = os.urandom(8).hex()
FLAGS = {
    "create-excl": os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    "truncate": os.O_WRONLY | os.O_TRUNC,
    "keep": os.O_WRONLY,
    "read": os.O_RDONLY,
}
descriptors = {}
watching = {"thread": None, "stop": None, "events": []}


def company(name=""):
    return "/company/" + name if name else "/company"


def status():
    fields = dict(line.split(":", 1) for line in open("/proc/self/status").read().splitlines() if ":" in line)
    return {
        "name": NAME,
        "token": TOKEN,
        "pid": os.getpid(),
        "uid": os.getuid(),
        "mountNamespace": os.readlink("/proc/self/ns/mnt"),
        "pidNamespace": os.readlink("/proc/self/ns/pid"),
        "capEff": fields["CapEff"].strip(),
        "noNewPrivs": fields["NoNewPrivs"].strip(),
        "cwd": os.getcwd(),
    }


def look():
    """What /company is right now: a served folder, a dead mount, or the bare mountpoint under it."""
    seen = {}
    try:
        info = os.stat(company())
        seen.update(dev=info.st_dev, mode=oct(info.st_mode & 0o7777), uid=info.st_uid)
    except OSError as error:
        seen["statErrno"] = error.errno
        return seen
    try:
        seen["names"] = sorted(os.listdir(company()))
    except OSError as error:
        seen["listErrno"] = error.errno
    return seen


def watch(stop, events):
    last = None
    while not stop.is_set():
        seen = look()
        if seen != last:
            events.append({"at": time.monotonic(), **seen})
            last = seen
        stop.wait(0.02)


def handle(request):
    op = request["op"]
    if op == "status":
        return status()
    if op == "read":
        with open(company(request["path"])) as file:
            return {"text": file.read()}
    if op == "list":
        return {"names": sorted(os.listdir(company()))}
    if op == "look":
        return look()
    if op == "write":
        stage = "open"
        try:
            fd = os.open(company(request["path"]), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
            try:
                stage = "write"
                os.write(fd, request["text"].encode())
            finally:
                stage = "close"
                os.close(fd)
            return {"written": True}
        except OSError as error:
            return {"errno": error.errno, "stage": stage}
    if op == "open":
        descriptors[request["key"]] = os.open(company(request["path"]), FLAGS[request["mode"]], 0o644)
        return {"opened": True}
    if op == "pwrite":
        return {"bytes": os.pwrite(descriptors[request["key"]], request["text"].encode(), request.get("offset", 0))}
    if op == "fsync":
        os.fsync(descriptors[request["key"]])
        return {"synced": True}
    if op == "pread":
        return {"text": os.pread(descriptors[request["key"]], request.get("length", 64), request.get("offset", 0)).decode()}
    if op == "close":
        # Forgotten first: a failed close still releases the descriptor.
        os.close(descriptors.pop(request["key"]))
        return {"closed": True}
    if op == "chdir":
        os.chdir(company())
        return {"cwd": os.getcwd()}
    if op == "listcwd":
        return {"names": sorted(os.listdir("."))}
    if op == "mountinfo":
        return {"lines": [line for line in open("/proc/self/mountinfo").read().splitlines() if "/company" in line or "/run/qorpera-company" in line]}
    if op == "watch-start":
        stop = threading.Event()
        watching.update(stop=stop, events=[])
        watching["thread"] = threading.Thread(target=watch, args=(stop, watching["events"]), daemon=True)
        watching["thread"].start()
        return {"watching": True}
    if op == "watch-stop":
        watching["stop"].set()
        watching["thread"].join(5)
        return {"events": watching["events"]}
    if op == "exit":
        return {"exiting": True}
    raise ValueError(f"unknown client operation {op}")


def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        request = json.loads(line)
        try:
            reply = handle(request)
        except OSError as error:
            reply = {"errno": error.errno}
        except Exception as error:
            reply = {"failure": repr(error)}
        print(json.dumps(reply), flush=True)
        if request["op"] == "exit":
            return


main()
