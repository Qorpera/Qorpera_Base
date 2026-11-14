#!/usr/bin/env python3
"""C2 (P4's hunt): hunt for the member's sign-in on the home, as root, by every route (run inside c2-home). Prints one JSON line.
The pattern is built at run time so this file never holds it whole. hunt.py LABEL [--disk]"""
import json, os, re, socket, subprocess, sys, time

PAT = re.compile(("C2CAN" + "ARY-(?:FD|FILE|RFR|FD2)-[0-9a-f]{16}").encode())  # only a real token: the hex is never typed
label = sys.argv[1]
t0 = time.time()
out = {"label": label, "uid": os.getuid(), "file_hits": [], "proc_env_hits": [], "proc_cmdline_hits": [],
       "proc_mem_hits": [], "files_scanned": 0, "bytes_scanned": 0, "procs": 0, "mem_bytes": 0}
me = str(os.getpid())
for root, dirs, files in os.walk("/", topdown=True):
    if root == "/":
        dirs[:] = [d for d in dirs if d not in ("proc", "sys", "dev")]
    for fn in files:
        p = os.path.join(root, fn)
        try:
            if not os.path.isfile(p) or os.path.islink(p):
                continue
            with open(p, "rb") as f:
                tail = b""
                while True:
                    b = f.read(1 << 20)
                    if not b:
                        break
                    out["bytes_scanned"] += len(b)
                    if PAT.search(tail + b):
                        out["file_hits"].append(p)
                        break
                    tail = b[-64:]
            out["files_scanned"] += 1
        except OSError:
            pass
for pid in os.listdir("/proc"):
    if not pid.isdigit() or pid == me:
        continue
    out["procs"] += 1
    for kind in ("environ", "cmdline"):
        try:
            if PAT.search(open(f"/proc/{pid}/{kind}", "rb").read()):
                out[f"proc_{'env' if kind == 'environ' else 'cmdline'}_hits"].append(pid)
        except OSError:
            pass
    try:
        maps = open(f"/proc/{pid}/maps").read().splitlines()
        with open(f"/proc/{pid}/mem", "rb", 0) as m:
            for ln in maps:
                a, perms = ln.split()[0], ln.split()[1]
                if "r" not in perms or "w" not in perms:
                    continue
                lo, hi = (int(x, 16) for x in a.split("-"))
                if hi - lo > 512 << 20:
                    continue
                try:
                    m.seek(lo)
                    b = m.read(hi - lo)
                    out["mem_bytes"] += len(b)
                    if PAT.search(b):
                        out["proc_mem_hits"].append(f"{pid}:{open(f'/proc/{pid}/comm').read().strip()}")
                        break
                except OSError:
                    pass
    except OSError:
        pass
if "--disk" in sys.argv:
    dev = subprocess.run(["findmnt", "-n", "-o", "SOURCE", "/"], capture_output=True, text=True).stdout.strip()
    n, tail, hits = 0, b"", 0
    with open(dev, "rb") as f:
        while True:
            b = f.read(16 << 20)
            if not b:
                break
            n += len(b)
            hits += len(PAT.findall(tail + b))
            tail = b[-64:]
    out["raw_disk"] = {"device": dev, "bytes": n, "hits": hits}
gw = subprocess.run(["sh", "-c", "ip route | awk '/^default/{print $3; exit}'"], capture_output=True, text=True).stdout.strip()
reach = {}
for host in filter(None, [gw, "10.201.0.2"]):
    for port in (18443,):
        s = socket.socket()
        s.settimeout(2)
        try:
            s.connect((host, port))
            reach[f"{host}:{port}"] = "OPEN"
        except OSError as e:
            reach[f"{host}:{port}"] = type(e).__name__
        finally:
            s.close()
out["reach_stub_from_home"] = reach
if os.path.exists("/dev/lxd/sock"):
    r = subprocess.run(["curl", "-s", "--unix-socket", "/dev/lxd/sock", "http://lxd/1.0/config"], capture_output=True)
    out["devlxd_config_hits"] = len(PAT.findall(r.stdout))
out["seconds"] = round(time.time() - t0, 1)
print("HUNT " + json.dumps(out))
