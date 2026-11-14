#!/usr/bin/env python3
"""P4 host side of the home's channels (stands in for the run host + the coding executor's LXD exec stream).

Runs as root on the test VM, in the slot's private mount namespace. It opens, on the home (nested VM `p4-home`), as the
agent's account in the machines' slice (the shape of the home build's channel, run-4.log):

  1. the FILE channel: OpenSSH's sftp-server, wired to sshfs (passive mode, its stdin/stdout) mounted at MNT. The slot
     binds a few of MNT's folders at the same paths the home has (/company, the agent's home folder, /tmp).
  2. the SHELL channel for Claude Code: ONE `codex exec-server --listen stdio` (the binary the home already holds for
     Codex). Claude Code's CLAUDE_CODE_SHELL_PREFIX client (home-shell.py) connects to SOCKDIR/cc-exec.sock; each
     connection is one command: process/start on the home, output and exit code back; a dropped client is
     process/terminate (SIGKILL of the command's process group on the home).
  3. the Codex channel: SOCKDIR/cx-exec.sock, raw: each connection gets its own exec-server on the home, bytes passed
     unchanged both ways (what Codex's environments.toml + `stdio-to-uds` expects).

Every byte on every channel is scanned for the canary prefix (built at run time, never typed whole here) and counted.
Usage: hostrelay.py HOME MNT SOCKDIR LOGDIR [--follow-symlinks] [--no-tap] [--no-cx]
Prints READY when the mount and the sockets are up. SIGTERM: unmount, close channels, write LOGDIR/relay-summary.json.
"""
import asyncio, base64, re, json, os, secrets, signal, subprocess, sys, threading, time, urllib.parse

HOME, MNT, SOCKDIR, LOGDIR = sys.argv[1:5]
FOLLOW = "--follow-symlinks" in sys.argv
TAP = "--no-tap" not in sys.argv
CX = "--no-cx" not in sys.argv
SSHFS = "/home/tester/lanes/agent-box-P4/sshfs/usr/bin/sshfs"
PAT = re.compile(("P4CAN" + "ARY-F(?:D|ILE|CX)-[0-9a-f]{16}").encode())  # a real token only (its hex is never typed)
AGENT_ENV = {"HOME": "/var/lib/qorpera-agent", "USER": "qorpera-agent", "LOGNAME": "qorpera-agent", "SHELL": "/bin/bash",
             "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "TZ": "UTC"}
T0 = time.time()
stats = {"sftp": {"up": 0, "down": 0, "hits": 0}, "cc": {"up": 0, "down": 0, "hits": 0, "commands": 0, "terminated": 0,
         "request_hits": 0}, "cx": {"up": 0, "down": 0, "hits": 0, "channels": 0}, "follow_symlinks": FOLLOW, "tap": TAP}
lock = threading.Lock()
logf = open(os.path.join(LOGDIR, "relay.jsonl"), "a", buffering=1)


def log(**rec):
    rec["t"] = round(time.time() - T0, 4)
    with lock:
        logf.write(json.dumps(rec) + "\n")


def home_cmd(unit, argv, cwd="/company"):
    """The home build's channel: one LXD exec stream into a transient unit of the machines' slice, as the agent."""
    env = [f"--setenv={k}={v}" for k, v in AGENT_ENV.items()] + ["--setenv=CODEX_HOME=/var/lib/qorpera-agent/.codex",
                                                                 "--setenv=NO_COLOR=1"]
    return ["lxc", "exec", HOME, "--", "/usr/bin/systemd-run", "--quiet", "--pipe", "--wait", "--collect",
            "--service-type=exec", "--expand-environment=no", f"--unit={unit}", "--slice=qorpera-machine.slice",
            "--uid=2000", "--gid=2000", f"--working-directory={cwd}", "--property=KillMode=control-group",
            "--property=TimeoutStopSec=10", *env, *argv]


class Scan:
    def __init__(self, key):
        self.key, self.tail = key, b""

    def feed(self, direction, b):
        with lock:
            stats[self.key][direction] += len(b)
        if TAP:
            buf = self.tail + b
            n = len(PAT.findall(buf))
            if n:
                with lock:
                    stats[self.key]["hits"] += n
                log(ev="CANARY-ON-CHANNEL", channel=self.key, direction=direction, count=n)
            self.tail = buf[-64:]


def pump(src, dst, scan, direction):
    try:
        while True:
            b = os.read(src, 65536)
            if not b:
                break
            scan.feed(direction, b)
            os.write(dst, b)
    except OSError:
        pass
    finally:
        try:
            os.close(dst)
        except OSError:
            pass


# ---------------------------------------------------------------- 1. the file channel
procs = []
sftp = subprocess.Popen(home_cmd(f"p4-cc-sftp-{secrets.token_hex(4)}", ["/usr/lib/openssh/sftp-server"]),
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(LOGDIR, "sftp.err"), "ab"))
procs.append(sftp)
os.makedirs(MNT, exist_ok=True)
opts = "passive,allow_other,nosuid,nodev,noexec"
if FOLLOW:
    opts += ",follow_symlinks"
if TAP:
    a_r, a_w = os.pipe()  # sshfs -> home
    b_r, b_w = os.pipe()  # home -> sshfs
    fs = subprocess.Popen([SSHFS, "-f", "-o", opts, "p4-home:/", MNT], stdin=b_r, stdout=a_w,
                          stderr=open(os.path.join(LOGDIR, "sshfs.err"), "ab"))
    os.close(a_w); os.close(b_r)
    sc = Scan("sftp")
    threading.Thread(target=pump, args=(a_r, os.dup(sftp.stdin.fileno()), sc, "up"), daemon=True).start()
    threading.Thread(target=pump, args=(os.dup(sftp.stdout.fileno()), b_w, sc, "down"), daemon=True).start()
    sftp.stdin.close(); sftp.stdout.close()
else:
    fs = subprocess.Popen([SSHFS, "-f", "-o", opts, "p4-home:/", MNT], stdin=sftp.stdout, stdout=sftp.stdin,
                          stderr=open(os.path.join(LOGDIR, "sshfs.err"), "ab"))
procs.append(fs)
for _ in range(200):
    if os.path.ismount(MNT) and os.path.isdir(os.path.join(MNT, "company")):
        break
    time.sleep(0.05)
log(ev="mount", ok=os.path.ismount(MNT), opts=opts, ms=round((time.time() - T0) * 1000))


# ---------------------------------------------------------------- 2. Claude Code's shell channel (one exec-server)
class Exec:
    def __init__(self):
        self.n = 0
        self.pending = {}
        self.procs = {}  # processId -> asyncio.Queue

    async def start(self):
        self.p = await asyncio.create_subprocess_exec(
            *home_cmd(f"p4-cc-exec-{secrets.token_hex(4)}", ["/opt/qorpera-machine/codex", "exec-server", "--listen",
                                                             "stdio"], cwd="/"),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=open(os.path.join(LOGDIR, "cc-exec.err"), "ab"), limit=64 * 1024 * 1024)
        self.scan = Scan("cc")
        asyncio.get_running_loop().create_task(self.reader())
        t = time.time()
        r = await self.call("initialize", {"clientName": "p4-claude-code-bridge"})
        self.send({"method": "initialized", "params": {}})
        log(ev="exec-init", ms=round((time.time() - t) * 1000), result=r)

    def send(self, msg):
        b = (json.dumps(msg) + "\n").encode()
        self.scan.feed("up", b)
        self.p.stdin.write(b)

    async def call(self, method, params):
        self.n += 1
        i = self.n
        fut = asyncio.get_running_loop().create_future()
        self.pending[i] = fut
        self.send({"id": i, "method": method, "params": params})
        return await fut

    async def reader(self):
        while True:
            line = await self.p.stdout.readline()
            if not line:
                log(ev="exec-channel-closed")
                for q in self.procs.values():
                    q.put_nowait({"closed": True, "exitCode": 255})
                return
            self.scan.feed("down", line)
            try:
                m = json.loads(line)
            except Exception:
                continue
            if "id" in m and m["id"] in self.pending:
                f = self.pending.pop(m["id"])
                if not f.done():
                    f.set_result(m)
            elif m.get("method", "").startswith("process/"):
                q = self.procs.get((m.get("params") or {}).get("processId"))
                if q:
                    q.put_nowait(m)


EX = Exec()
FWD_ALLOW = {"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "GIT_EDITOR", "TMPDIR", "CLAUDE_CODE_SESSION_ID", "TERM", "COLUMNS"}


async def cc_client(reader, writer):
    t0 = time.time()
    pid = None
    try:
        req = json.loads(await reader.readline())
        cmd, cwd = req["cmd"], req.get("cwd") or "/company"
        raw = json.dumps(req).encode()
        if PAT.search(raw):
            stats["cc"]["request_hits"] += 1
            log(ev="CANARY-IN-REQUEST")
        env = dict(AGENT_ENV)
        dropped = []
        for k, v in (req.get("env") or {}).items():
            if k in FWD_ALLOW:
                env[k] = v
            else:
                dropped.append(k)
        stats["cc"]["commands"] += 1
        pid = f"cc-{stats['cc']['commands']}-{secrets.token_hex(3)}"
        q = asyncio.Queue()
        EX.procs[pid] = q
        r = await EX.call("process/start", {"processId": pid, "argv": ["/bin/bash", "-c", cmd],
                                            "cwd": "file://" + urllib.parse.quote(cwd), "env": env, "tty": False,
                                            "pipeStdin": False, "arg0": None})
        if "error" in r:
            writer.write((json.dumps({"e": base64.b64encode(f"home bridge: {r['error']}\n".encode()).decode()}) + "\n"
                          + json.dumps({"x": 126}) + "\n").encode())
            await writer.drain()
            log(ev="start-error", pid=pid, error=r["error"])
            return
        t_start = time.time()
        code, first = None, None
        eof = asyncio.create_task(reader.read(1))
        while True:
            get = asyncio.create_task(q.get())
            done, _ = await asyncio.wait({get, eof}, return_when=asyncio.FIRST_COMPLETED)
            if eof in done and get not in done:
                get.cancel()
                await EX.call("process/terminate", {"processId": pid})
                stats["cc"]["terminated"] += 1
                log(ev="terminated-on-client-drop", pid=pid, after_ms=round((time.time() - t_start) * 1000))
                return
            m = get.result()
            meth, p = m.get("method"), m.get("params") or {}
            if meth == "process/output":
                if first is None:
                    first = time.time()
                key = "e" if p.get("stream") == "stderr" else "o"
                writer.write((json.dumps({key: p.get("chunk", "")}) + "\n").encode())
                await writer.drain()
            elif meth == "process/exited":
                code = p.get("exitCode")
            elif meth == "process/closed" or m.get("closed"):
                if code is None:
                    code = m.get("exitCode", 255)
                break
        eof.cancel()
        writer.write((json.dumps({"x": code if code is not None else 255}) + "\n").encode())
        await writer.drain()
        log(ev="command", pid=pid, cwd=cwd, cmd_len=len(cmd), exit=code, dropped_env=sorted(dropped),
            start_ms=round((t_start - t0) * 1000, 1), total_ms=round((time.time() - t0) * 1000, 1),
            first_output_ms=round((first - t0) * 1000, 1) if first else None)
    except Exception as e:  # noqa: BLE001
        log(ev="client-error", pid=pid, error=repr(e))
    finally:
        if pid:
            EX.procs.pop(pid, None)
        try:
            writer.close()
        except Exception:
            pass


# ---------------------------------------------------------------- 3. Codex's channel (raw, one exec-server each)
async def cx_client(reader, writer):
    stats["cx"]["channels"] += 1
    n = stats["cx"]["channels"]
    p = await asyncio.create_subprocess_exec(
        *home_cmd(f"p4-cx-exec-{n}-{secrets.token_hex(3)}", ["/opt/qorpera-machine/codex", "exec-server", "--listen",
                                                             "stdio"], cwd="/"),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=open(os.path.join(LOGDIR, f"cx-exec-{n}.err"), "ab"))
    sc = Scan("cx")
    log(ev="cx-channel-open", n=n)

    async def up():
        while True:
            b = await reader.read(65536)
            if not b:
                break
            sc.feed("up", b)
            p.stdin.write(b)
            await p.stdin.drain()
        p.stdin.close()

    async def down():
        while True:
            b = await p.stdout.read(65536)
            if not b:
                break
            sc.feed("down", b)
            writer.write(b)
            await writer.drain()
        writer.close()

    await asyncio.gather(up(), down(), return_exceptions=True)
    try:
        p.terminate()
    except ProcessLookupError:
        pass
    log(ev="cx-channel-closed", n=n, rc=await p.wait())


async def main():
    await EX.start()
    os.makedirs(SOCKDIR, exist_ok=True)
    s1 = await asyncio.start_unix_server(cc_client, os.path.join(SOCKDIR, "cc-exec.sock"))
    os.chmod(os.path.join(SOCKDIR, "cc-exec.sock"), 0o666)
    if CX:
        await asyncio.start_unix_server(cx_client, os.path.join(SOCKDIR, "cx-exec.sock"))
        os.chmod(os.path.join(SOCKDIR, "cx-exec.sock"), 0o666)
    print("READY", flush=True)
    stop = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    await stop.wait()
    s1.close()


try:
    asyncio.run(main())
finally:
    subprocess.run(["fusermount3", "-u", "-z", MNT], capture_output=True)
    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass
    stats["seconds"] = round(time.time() - T0, 1)
    with open(os.path.join(LOGDIR, "relay-summary.json"), "w") as f:
        json.dump(stats, f, indent=1)
    log(ev="end")
