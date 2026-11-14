#!/usr/bin/env python3
"""P4: Claude Code's CLAUDE_CODE_SHELL_PREFIX in the slot. Claude Code runs `home-shell.py '<the full shell invocation>'`;
this sends the invocation, the working folder and a few named variables to the home's channel, writes the home's
stdout/stderr to its own, and exits with the home's exit code. If Claude Code stops it (any signal, or its pipes
close), the socket drops and the host terminates the command's process group on the home.
Each call is logged (names of variables only) to /slot/out/prefix.jsonl."""
import base64, json, os, signal, socket, sys, time

t0 = time.time()
FDS = {}
for _fd in os.listdir("/proc/self/fd"):
    try:
        FDS[_fd] = os.readlink(f"/proc/self/fd/{_fd}")
    except OSError:
        pass
cmd = sys.argv[1] if len(sys.argv) > 1 else ""
FWD = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "GIT_EDITOR", "TMPDIR", "CLAUDE_CODE_SESSION_ID", "TERM", "COLUMNS")
env = {k: os.environ[k] for k in FWD if k in os.environ}
try:
    cwd = os.getcwd()
except OSError:
    cwd = "/company"
try:
    with open("/slot/out/prefix.jsonl", "a") as f:
        f.write(json.dumps({"t": round(t0, 3), "argc": len(sys.argv), "cmd": cmd[:4000], "cmd_len": len(cmd), "cwd": cwd,
                            "env_names": sorted(os.environ), "ppid": os.getppid(),
                            "stdin_tty": os.isatty(0), "fds": FDS}) + "\n")
except OSError:
    pass


def w(fd, b):
    while b:
        n = os.write(fd, b)
        b = b[n:]


def bye(sig, _f):
    os._exit(128 + sig)


for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGPIPE):
    signal.signal(s, bye)
so = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
so.connect("/run/qorpera-home/exec.sock")
so.sendall((json.dumps({"cmd": cmd, "cwd": cwd, "env": env}) + "\n").encode())
f = so.makefile("rb")
code = 255
for line in f:
    m = json.loads(line)
    if "o" in m:
        w(1, base64.b64decode(m["o"]))
    elif "e" in m:
        w(2, base64.b64decode(m["e"]))
    elif "x" in m:
        code = m["x"]
        break
sys.exit(code if isinstance(code, int) and 0 <= code < 256 else 255)
