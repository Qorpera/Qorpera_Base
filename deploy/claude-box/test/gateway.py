#!/usr/bin/env python3
"""C2 proof: the stand-in for the coding executor's home route (P4's hostrelay.py reshaped to C1's contract).

Runs as root on the test VM. Listens on a Unix socket the driver's account may reach. Each connection is one channel:
its first line is {"kind": "exec"|"sftp", "sessionId": <uuid>} (the parts of C1's handshake this stand-in needs), the
answer is {"ok": true, ...} and then lines both ways, exactly as C1's channel carries them:
  exec: JSON-RPC lines of `codex exec-server --listen stdio` on the home, unchanged;
  sftp: standard base64 of pieces of the SFTP stream of `/usr/lib/openssh/sftp-server` on the home.
Each channel is one transient unit on the home in qorpera-machine.slice as the agent (uid 2000), C1's unit shape.
Every byte each way is scanned for the canaries (the pattern needs their 16 random hex digits, never typed whole).
Usage: gateway.py HOME SOCKET LOGDIR. SIGTERM: close every channel, write LOGDIR/gateway-summary.json.
"""
import asyncio, base64, binascii, json, os, re, secrets, signal, sys, time

HOME, SOCKET, LOGDIR = sys.argv[1:4]
PAT = re.compile(("C2CAN" + "ARY-(?:FD|FILE|RFR|FD2)-[0-9a-f]{16}").encode())
AGENT_ENV = {"HOME": "/var/lib/qorpera-agent", "USER": "qorpera-agent", "LOGNAME": "qorpera-agent", "SHELL": "/bin/bash",
             "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "TZ": "UTC",
             "NO_COLOR": "1", "CODEX_HOME": "/var/lib/qorpera-agent/.codex"}
T0 = time.time()
stats = {"exec": {"channels": 0, "up": 0, "down": 0, "hits": 0}, "sftp": {"channels": 0, "up": 0, "down": 0, "hits": 0},
         "sessions": [], "refused": 0}
logf = open(os.path.join(LOGDIR, "gateway.jsonl"), "a", buffering=1)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def log(**rec):
    rec["t"] = round(time.time() - T0, 3)
    logf.write(json.dumps(rec) + "\n")


class Scan:
    def __init__(self, kind):
        self.kind, self.tail = kind, {"up": b"", "down": b""}

    def feed(self, direction, b):
        stats[self.kind][direction] += len(b)
        buf = self.tail[direction] + b
        n = len(PAT.findall(buf))
        if n:
            stats[self.kind]["hits"] += n
            log(ev="CANARY-ON-CHANNEL", channel=self.kind, direction=direction, count=n)
        self.tail[direction] = buf[-64:]


def home_cmd(unit, argv, cwd):
    env = [f"--setenv={k}={v}" for k, v in AGENT_ENV.items()]
    return ["lxc", "exec", HOME, "--", "/usr/bin/systemd-run", "--quiet", "--pipe", "--wait", "--collect",
            "--service-type=exec", "--expand-environment=no", f"--unit={unit}", "--slice=qorpera-machine.slice",
            "--uid=2000", "--gid=2000", f"--working-directory={cwd}", "--property=KillMode=control-group",
            "--property=TimeoutStopSec=10", *env, *argv]


async def channel(reader, writer):
    proc = None
    try:
        first = json.loads(await asyncio.wait_for(reader.readline(), 10))
        kind, session = first.get("kind"), first.get("sessionId", "")
        if kind not in ("exec", "sftp") or not UUID.match(session) or set(first) != {"kind", "sessionId"}:
            stats["refused"] += 1
            writer.write(b'{"ok":false,"reason":"unavailable"}\n')
            await writer.drain()
            return
        stats[kind]["channels"] += 1
        if session not in stats["sessions"]:
            stats["sessions"].append(session)
        unit = f"qorpera-machine-home-{session[:8]}-{kind}-{secrets.token_hex(8)}"
        argv = (["/opt/qorpera-machine/codex", "exec-server", "--listen", "stdio"] if kind == "exec"
                else ["/usr/lib/openssh/sftp-server"])
        proc = await asyncio.create_subprocess_exec(
            *home_cmd(unit, argv, "/" if kind == "exec" else "/company"), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=open(os.path.join(LOGDIR, f"{kind}.err"), "ab"),
            limit=16 * 1024 * 1024)
        log(ev="open", kind=kind, session=session[:8], unit=unit)
        writer.write((json.dumps({"ok": True, "sessionId": session, "machine": HOME}) + "\n").encode())
        await writer.drain()
        scan = Scan(kind)

        async def up():
            while True:
                line = await reader.readline()
                if not line:
                    break
                body = line.rstrip(b"\n")
                if kind == "sftp":
                    try:
                        body = base64.b64decode(body, validate=True)
                    except (binascii.Error, ValueError):
                        log(ev="bad-line", kind=kind)
                        break
                    scan.feed("up", body)
                    proc.stdin.write(body)
                else:
                    scan.feed("up", body)
                    proc.stdin.write(body + b"\n")
                await proc.stdin.drain()
            proc.stdin.close()

        async def down():
            while True:
                if kind == "sftp":
                    b = await proc.stdout.read(768 * 1024)
                    if not b:
                        break
                    scan.feed("down", b)
                    writer.write(base64.b64encode(b) + b"\n")
                else:
                    b = await proc.stdout.readline()
                    if not b:
                        break
                    scan.feed("down", b)
                    writer.write(b)
                await writer.drain()

        done, pending = await asyncio.wait({asyncio.create_task(up()), asyncio.create_task(down())},
                                           return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        log(ev="close", kind=kind, session=session[:8], unit=unit)
    except Exception as e:  # noqa: BLE001
        log(ev="error", error=repr(e)[:300])
    finally:
        if proc and proc.returncode is None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), 5)
            except Exception:  # noqa: BLE001
                proc.kill()
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def main():
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    # Lines of up to C1's 8 MiB (a base64 piece of the SFTP stream is about 1 MiB; asyncio's default is 64 KiB).
    server = await asyncio.start_unix_server(channel, SOCKET, limit=16 * 1024 * 1024)
    os.chmod(SOCKET, 0o666)
    print("READY", flush=True)
    stop = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    await stop.wait()
    server.close()


try:
    asyncio.run(main())
finally:
    stats["seconds"] = round(time.time() - T0, 1)
    with open(os.path.join(LOGDIR, "gateway-summary.json"), "w") as f:
        json.dump(stats, f, indent=1)
