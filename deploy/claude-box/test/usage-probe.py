#!/usr/bin/env python3
"""Claude login usage and resets, step 2: what the pinned, unmodified Claude Code 2.1.325 says and does for a plan's
usage and its limit resets, read against usage-stub.py behind usage-proxy.py (api.anthropic.com only, as the vault
helper's egress for these reads). No real sign-in: every token is a made-up canary. Claude Code runs as nobody, its
config folder a private copy. As root (usage-probe.sh makes the binary, the CA and the folder).
Usage: usage-probe.py ROOT CLAUDE CA CERT KEY [PASS...]   (no PASS: all of them)"""
import errno, fcntl, json, os, pty, re, select, shutil, signal, socket, struct, subprocess, sys, termios, time

ROOT, CLAUDE, CA, CERT, KEY = sys.argv[1:6]
ONLY = sys.argv[6:]
HERE = os.path.dirname(os.path.abspath(__file__))
NOBODY = 65534
ORG = "00000000-0000-4000-8000-0000000000c3"
ACCOUNT = {"accountUuid": "00000000-0000-4000-8000-0000000000c2", "emailAddress": "c2@example.invalid",
           "organizationUuid": ORG, "organizationName": "Probe", "organizationRole": "admin", "displayName": "Probe",
           "hasExtraUsageEnabled": False, "billingType": "stripe_subscription"}
FLAGS = {"tengu_cedar_ember": {"enabled": True}}
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]")


def grant(gid, kind, left, clears, usable_now=True, requires_limit=False, total=None):
    return {"id": gid, "label": "", "resets_total": total if total is not None else left, "resets_left": left,
            "starts_at": None, "ends_at": "@ends", "clears": clears, "paused": False, "usable_now": usable_now,
            "use_requires_limit": requires_limit, "percent_used": {"five_hour": 28, "seven_day": 87}, "blocking": [],
            "type": kind, "gives_back_weekly": False, "unavailable_reason": None}


def status(grants, at_limit=False, exhausted=()):
    return {"eligible": True, "ineligible_reason": None, "at_limit": at_limit, "exhausted": list(exhausted),
            "grants": grants, "next_grant_id": grants[0]["id"] if grants else None, "weekly_resets_at": "@week",
            "cooldown_until": None}


BASE = {"usage": {"five_hour": [28.0, 9660], "seven_day": [87.0, 360000], "seven_day_opus": None,
                  "seven_day_sonnet": None, "models": [["Fable", 9.0, 360000]]},
        "flags": FLAGS, "headers": {}, "cedar_ember": None, "claim": {"result": "unavailable"}}
ONE_FULL = status([grant("g_full", "full", 3, ["five_hour", "seven_day"])])
TWO_KINDS = status([grant("g_session", "session", 2, ["five_hour"]), grant("g_week", "weekly", 1, ["seven_day"])])
AT_LIMIT_ONLY = status([grant("g_session", "session", 1, ["five_hour"], usable_now=False, requires_limit=True)])
AT_WALL = status([grant("g_session", "session", 1, ["five_hour"], usable_now=True, requires_limit=True)],
                 at_limit=True, exhausted=["five_hour"])
NONE = {"eligible": False, "ineligible_reason": "no_grant", "grants": []}


def sc(**over):
    out = json.loads(json.dumps(BASE))
    out.update(over)
    return out


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def write_owned(path, text, mode=0o600):
    with open(path, "w") as f:
        f.write(text)
    os.chown(path, NOBODY, NOBODY)
    os.chmod(path, mode)


def creds(minutes_left):
    tok = "sk-ant-oat01-C2CAN" + "ARY-V1-" + os.urandom(8).hex()
    ref = "sk-ant-ort01-C2CAN" + "ARY-V1R-" + os.urandom(8).hex()
    return json.dumps({"claudeAiOauth": {"accessToken": tok, "refreshToken": ref,
                                         "expiresAt": int((time.time() + minutes_left * 60) * 1000),
                                         "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
                                         "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"}})


class Screen:
    """A small terminal: enough of VT100 for Claude Code's Ink frames (cursor moves, erases, CR/LF, wrap)."""

    CSI = re.compile(r"\x1b\[([?<>=]?)([0-9;]*)([ -/]*)([@-~])")

    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.saved = (0, 0)

    def scroll(self):
        self.grid.pop(0)
        self.grid.append([" "] * self.cols)

    def lf(self):
        if self.r == self.rows - 1:
            self.scroll()
        else:
            self.r += 1

    def put(self, ch):
        if self.c >= self.cols:
            self.c = 0
            self.lf()
        self.grid[self.r][self.c] = ch
        self.c += 1

    def feed(self, text):
        i, n = 0, len(text)
        while i < n:
            ch = text[i]
            if ch == "\x1b":
                m = self.CSI.match(text, i)
                if m:
                    self.csi(m.group(1), m.group(2), m.group(4))
                    i = m.end()
                    continue
                m = re.match(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", text[i:])
                if m:
                    i += m.end()
                    continue
                if i + 1 < n and text[i + 1] in "()":
                    i += 3
                    continue
                if i + 1 < n and text[i + 1] == "7":
                    self.saved = (self.r, self.c)
                elif i + 1 < n and text[i + 1] == "8":
                    self.r, self.c = self.saved
                i += 2
                continue
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self.lf()
            elif ch == "\b":
                self.c = max(0, self.c - 1)
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ord(ch) >= 32:
                self.put(ch)
            i += 1

    def csi(self, private, params, final):
        nums = [int(x) if x else 0 for x in params.split(";")] if params else []
        a = nums[0] if nums else 0
        if private:
            return
        if final == "A":
            self.r = max(0, self.r - max(a, 1))
        elif final == "B":
            self.r = min(self.rows - 1, self.r + max(a, 1))
        elif final == "C":
            self.c = min(self.cols - 1, self.c + max(a, 1))
        elif final == "D":
            self.c = max(0, self.c - max(a, 1))
        elif final == "E":
            self.r = min(self.rows - 1, self.r + max(a, 1)); self.c = 0
        elif final == "F":
            self.r = max(0, self.r - max(a, 1)); self.c = 0
        elif final == "G":
            self.c = min(self.cols - 1, max(a, 1) - 1)
        elif final in "Hf":
            self.r = min(self.rows - 1, max(nums[0] if nums else 1, 1) - 1)
            self.c = min(self.cols - 1, max(nums[1] if len(nums) > 1 else 1, 1) - 1)
        elif final == "J":
            if a == 0:
                self.grid[self.r][self.c:] = [" "] * (self.cols - self.c)
                for r in range(self.r + 1, self.rows):
                    self.grid[r] = [" "] * self.cols
            elif a == 1:
                for r in range(0, self.r):
                    self.grid[r] = [" "] * self.cols
                self.grid[self.r][: self.c + 1] = [" "] * (self.c + 1)
            else:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
        elif final == "K":
            if a == 0:
                self.grid[self.r][self.c:] = [" "] * (self.cols - self.c)
            elif a == 1:
                self.grid[self.r][: self.c + 1] = [" "] * (self.c + 1)
            else:
                self.grid[self.r] = [" "] * self.cols
        elif final == "d":
            self.r = min(self.rows - 1, max(a, 1) - 1)
        elif final == "S":
            for _ in range(max(a, 1)):
                self.scroll()

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.grid)


class Pass:
    def __init__(self, name, scen, claude_json=None, minutes_left=240, essential_only=True, allow=("api.anthropic.com",),
                 quiet=False):
        self.name = name
        self.d = os.path.join(ROOT, name)
        shutil.rmtree(self.d, ignore_errors=True)
        for sub in ("", "cfg", "home", "work"):
            os.makedirs(os.path.join(self.d, sub), exist_ok=True)
            os.chown(os.path.join(self.d, sub), NOBODY, NOBODY)
            os.chmod(os.path.join(self.d, sub), 0o700)
        os.chmod(self.d, 0o755)
        self.cfg = os.path.join(self.d, "cfg")
        write_owned(os.path.join(self.cfg, ".credentials.json"), creds(minutes_left))
        cj = {"hasCompletedOnboarding": True} if claude_json is None else claude_json
        write_owned(os.path.join(self.cfg, ".claude.json"), json.dumps(cj))
        self.scen = os.path.join(self.d, "scenario.json")
        json.dump(scen, open(self.scen, "w"))
        allowf = os.path.join(self.d, "allow")
        open(allowf, "w").write("\n".join(allow) + "\n")
        sp, pp = free_port(), free_port()
        self.slog, self.plog = os.path.join(self.d, "stub.jsonl"), os.path.join(self.d, "proxy.jsonl")
        self.stub = subprocess.Popen([sys.executable, os.path.join(HERE, "usage-stub.py"), str(sp), self.scen, self.slog,
                                      CERT, KEY], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.proxy = subprocess.Popen([sys.executable, os.path.join(HERE, "usage-proxy.py"), str(pp), str(sp), allowf,
                                       self.plog], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.stub.stdout.readline()
        self.proxy.stdout.readline()
        self.env = {"HOME": os.path.join(self.d, "home"), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC",
                    "CLAUDE_CONFIG_DIR": self.cfg, "HTTPS_PROXY": f"http://127.0.0.1:{pp}",
                    "https_proxy": f"http://127.0.0.1:{pp}", "NODE_EXTRA_CA_CERTS": CA, "DISABLE_AUTOUPDATER": "1",
                    "NO_COLOR": "1"}
        if essential_only:
            self.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        if quiet:
            self.env.update(DISABLE_TELEMETRY="1", DISABLE_ERROR_REPORTING="1")

    def close(self):
        self.stub.terminate()
        self.proxy.terminate()
        self.stub.wait()
        self.proxy.wait()

    def logs(self):
        def lines(p):
            return [json.loads(x) for x in open(p)] if os.path.exists(p) else []
        stub = lines(self.slog)
        return {"requests": [{k: r.get(k) for k in ("t", "kind", "method", "path", "auth", "grant", "program", "model", "maxTokens", "nmsgs", "tools", "first")
                              if r.get(k) is not None} for r in stub],
                "connects": sorted({(c["host"], c["passed"]) for c in lines(self.plog)}),
                "credentialsChanged": self.cred_changed()}

    def cred_changed(self):
        return os.stat(os.path.join(self.cfg, ".credentials.json")).st_mtime > os.stat(self.scen).st_mtime + 0.5

    def pipe(self, argv, stdin_lines=(), timeout=90, keep_open_s=0.0):
        child = subprocess.Popen(["setpriv", f"--reuid={NOBODY}", f"--regid={NOBODY}", "--clear-groups", CLAUDE, *argv],
                                 cwd=os.path.join(self.d, "work"), env={**self.env, "TERM": "dumb"},
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out = []
        t0 = time.time()
        for line in stdin_lines:
            child.stdin.write(json.dumps(line) + "\n")
            child.stdin.flush()
        deadline = t0 + timeout
        wanted = keep_open_s
        while time.time() < deadline:
            r, _, _ = select.select([child.stdout], [], [], 0.5)
            if r:
                line = child.stdout.readline()
                if not line:
                    break
                out.append(line.rstrip("\n"))
                if wanted and any('"control_response"' in x for x in out):
                    time.sleep(0.2)
                    break
            elif child.poll() is not None:
                break
        try:
            child.stdin.close()
        except Exception:
            pass
        try:
            rc = child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            child.kill()
            rc = "killed"
        rest = child.stdout.read() or ""
        out += [x for x in rest.split("\n") if x]
        err = child.stderr.read()
        return {"rc": rc, "secs": round(time.time() - t0, 1), "out": out, "stderr": err[-1500:]}

    def tty(self, argv, steps, timeout=60, rows=40, cols=160):
        """steps: list of (regex or seconds, keys). Waits for the regex on the screen text (or the seconds), then sends
        the keys. The screen text is the PTY's output with terminal codes removed."""
        pid, fd = pty.fork()
        if pid == 0:
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                os.chdir(os.path.join(self.d, "work"))
                os.setgroups([])
                os.setgid(NOBODY)
                os.setuid(NOBODY)
                os.execve(CLAUDE, [CLAUDE, *argv], {**self.env, "TERM": "xterm-256color", "COLUMNS": str(cols),
                                                    "LINES": str(rows), "CLAUDE_CODE_SANDBOXED": "1"})
            finally:
                os._exit(127)
        raw = bytearray()
        t0 = time.time()
        marks = []
        frames = []

        def pump(until):
            while time.time() < until:
                r, _, _ = select.select([fd], [], [], 0.1)
                if r:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError as e:
                        if e.errno == errno.EIO:
                            return False
                        raise
                    if not chunk:
                        return False
                    raw.extend(chunk)
            return True

        def text():
            screen = Screen(rows, cols)
            screen.feed(raw.decode("utf-8", "replace"))
            return screen.text()

        alive = True
        for wait, keys in steps:
            if isinstance(wait, (int, float)):
                alive = pump(time.time() + wait) and alive
                hit = True
            else:
                end = min(time.time() + 30, t0 + timeout)
                hit = False
                while time.time() < end and alive:
                    alive = pump(time.time() + 0.3)
                    if re.search(wait, text()):
                        hit = True
                        break
            marks.append({"t": round(time.time() - t0, 1), "wait": wait if isinstance(wait, str) else f"{wait}s",
                          "hit": hit, "sent": repr(keys)})
            frames.append("\n".join(line for line in text().split("\n") if line.strip()))
            if not hit or not alive:
                break
            if keys:
                for k in keys if isinstance(keys, list) else [keys]:
                    os.write(fd, k.encode())
                    time.sleep(0.15)
        pump(time.time() + 1.5)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        pump(time.time() + 1)
        try:
            _, st = os.waitpid(pid, 0)
        except ChildProcessError:
            st = None
        os.close(fd)
        open(os.path.join(self.d, "screen.raw"), "wb").write(bytes(raw))
        screen = "\n".join(line for line in text().split("\n") if line.strip())
        open(os.path.join(self.d, "screen.txt"), "w").write(screen)
        return {"secs": round(time.time() - t0, 1), "marks": marks, "status": st, "screenTail": screen[-5000:],
                "frames": frames}


def reader_pass(name, scen, mode, kind=""):
    p = Pass(name, scen, essential_only=False)
    try:
        bundle = os.environ["USAGE_READER_BUNDLE"]
        root = os.path.join(p.d, "reader")
        os.makedirs(root)
        os.chown(root, NOBODY, NOBODY)
        os.chmod(root, 0o700)
        argv = ["setpriv", f"--reuid={NOBODY}", f"--regid={NOBODY}", "--clear-groups", os.environ["USAGE_NODE"], bundle, mode,
                CLAUDE, root, os.path.join(p.cfg, ".credentials.json"), p.env["HTTPS_PROXY"], CA, kind]
        t0 = time.time()
        r = subprocess.run(argv, capture_output=True, text=True, timeout=200, env={"PATH": "/usr/bin:/bin"})
        line = next((x for x in r.stdout.splitlines() if x.startswith("READER-RESULT ")), None)
        left = os.listdir(root)
        report(name, {"rc": r.returncode, "secs": round(time.time() - t0, 1),
                      "result": json.loads(line[len("READER-RESULT "):]) if line else None,
                      "stderr": r.stderr[-1500:], "leftInRoot": left, **p.logs()})
    finally:
        p.close()


def report(name, data):
    print(f"\n######## {name}")
    print(json.dumps(data, indent=1)[:20000])
    sys.stdout.flush()


def wanted(name):
    return not ONLY or any(name.startswith(o) for o in ONLY)


READY = r"(for shortcuts|\? for|Try \"|>\s*$)"


def run_pass():
    p = Pass("run", sc(headers={"5h": 0.28, "7d": 0.5}))
    try:
        r = p.pipe(["-p", "hi", "--output-format", "stream-json", "--verbose", "--setting-sources", "user",
                    "--strict-mcp-config", "--tools", ""], timeout=120)
        events = [json.loads(x) for x in r["out"] if x.startswith("{")]
        report("run", {"rc": r["rc"], "secs": r["secs"], "types": [(e.get("type"), e.get("subtype")) for e in events],
                       "rateLimitEvents": [e for e in events if e.get("type") == "rate_limit_event"],
                       "stderr": r["stderr"], **p.logs()})
    finally:
        p.close()


def usage_pass(name="usage", extra=(), **kw):
    p = Pass(name, sc(), **kw)
    try:
        req = {"type": "control_request", "request_id": "u1", "request": {"subtype": "get_usage", "skip_behaviors": True}}
        r = p.pipe(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                    "--setting-sources", "user", "--strict-mcp-config", "--tools", "", *extra], stdin_lines=[req], timeout=60,
                   keep_open_s=1)
        events = [json.loads(x) for x in r["out"] if x.startswith("{")]
        report(name, {"rc": r["rc"], "secs": r["secs"], "types": [(e.get("type"), e.get("subtype")) for e in events],
                      "controlResponses": [e for e in events if e.get("type") == "control_response"],
                      "stderr": r["stderr"], **p.logs()})
    finally:
        p.close()


def screen_pass(name, scen, argv=("/limit-reset",), steps=None, **kw):
    p = Pass(name, scen, **kw)
    try:
        r = p.tty(list(argv), steps or [(8, "\x1b"), (2, None)], timeout=60)
        report(name, {**r, **p.logs()})
    finally:
        p.close()


def claim_pass(name, scen, kind, after_confirm=r"(Reset used|reset used|Limits reset|limit reset|Couldn't|Still couldn't|No .* to use|can't be used)"):
    steps = [(r"Use an? .*\?", None), (1.5, "\r"), (after_confirm, None), (3, None)]
    screen_pass(name, scen, argv=(f"/limit-reset {kind}",), steps=steps, essential_only=False)


RESET_OK = {"result": "reset", "reason": None, "resets_left": 2, "cleared": ["five_hour", "seven_day"],
            "weekly_resets_at": "@week"}
PASSES = [
    ("run", run_pass),
    ("usage", lambda: usage_pass()),
    ("usage-expired", lambda: usage_pass("usage-expired", minutes_left=-30)),
    ("usage-quiet", lambda: usage_pass("usage-quiet", essential_only=False, quiet=True)),
    ("usage-quiet-expired", lambda: usage_pass("usage-quiet-expired", essential_only=False, quiet=True,
                                               minutes_left=-30)),
    ("screen-none", lambda: screen_pass("screen-none", sc(cedar_ember=NONE), essential_only=False)),
    ("screen-noblock", lambda: screen_pass("screen-noblock", sc(), essential_only=False)),
    ("screen-one", lambda: screen_pass("screen-one", sc(cedar_ember=ONE_FULL), essential_only=False)),
    ("screen-two", lambda: screen_pass("screen-two", sc(cedar_ember=TWO_KINDS), essential_only=False)),
    ("screen-limitonly", lambda: screen_pass("screen-limitonly", sc(cedar_ember=AT_LIMIT_ONLY), essential_only=False)),
    ("screen-atwall", lambda: screen_pass("screen-atwall", sc(cedar_ember=AT_WALL, headers={"status": "rejected",
                                          "5hStatus": "rejected", "5h": 1.0}), essential_only=False)),
    ("screen-quiet", lambda: screen_pass("screen-quiet", sc(cedar_ember=ONE_FULL), essential_only=False, quiet=True)),
    ("reader-read-one", lambda: reader_pass("reader-read-one", sc(cedar_ember=ONE_FULL), "read")),
    ("reader-read-two", lambda: reader_pass("reader-read-two", sc(cedar_ember=TWO_KINDS), "read")),
    ("reader-read-none", lambda: reader_pass("reader-read-none", sc(cedar_ember=NONE), "read")),
    ("reader-read-limitonly", lambda: reader_pass("reader-read-limitonly", sc(cedar_ember=AT_LIMIT_ONLY), "read")),
    ("reader-read-atwall", lambda: reader_pass("reader-read-atwall", sc(cedar_ember=AT_WALL), "read")),
    ("reader-reset-ok", lambda: reader_pass("reader-reset-ok", sc(cedar_ember=ONE_FULL, claim=RESET_OK), "reset",
                                            "full")),
    ("reader-reset-unavailable", lambda: reader_pass("reader-reset-unavailable", sc(cedar_ember=ONE_FULL, claim={
        "result": "unavailable", "reason": "unavailable"}), "reset", "full")),
    ("reader-reset-http500", lambda: reader_pass("reader-reset-http500", sc(cedar_ember=ONE_FULL, claim={"http": 500}),
                                                 "reset", "full")),
    ("reader-reset-notoffered", lambda: reader_pass("reader-reset-notoffered", sc(cedar_ember=ONE_FULL, claim=RESET_OK),
                                                    "reset", "weekly")),
    ("reader-reset-atwall", lambda: reader_pass("reader-reset-atwall", sc(cedar_ember=AT_WALL, claim={
        "result": "reset", "resets_left": 0, "cleared": ["five_hour"], "weekly_resets_at": "@week"}), "reset",
                                                "session")),
    ("screen-arg-session", lambda: screen_pass("screen-arg-session", sc(cedar_ember=TWO_KINDS),
                                               argv=("/limit-reset 5-hour",), essential_only=False)),
    ("screen-arg-weekly", lambda: screen_pass("screen-arg-weekly", sc(cedar_ember=TWO_KINDS),
                                              argv=("/limit-reset weekly",), essential_only=False)),
    ("claim-reset", lambda: claim_pass("claim-reset", sc(cedar_ember=ONE_FULL, claim=RESET_OK), "full")),
    ("claim-unavailable", lambda: claim_pass("claim-unavailable", sc(cedar_ember=ONE_FULL, claim={
        "result": "unavailable", "reason": "unavailable"}), "full")),
    ("claim-http500", lambda: claim_pass("claim-http500", sc(cedar_ember=ONE_FULL, claim={"http": 500}), "full")),
    ("claim-wrongkind", lambda: claim_pass("claim-wrongkind", sc(cedar_ember=ONE_FULL, claim=RESET_OK), "weekly")),
]


for name, fn in PASSES:
    if wanted(name):
        try:
            fn()
        except Exception as e:
            report(name, {"probeError": f"{type(e).__name__}: {e}"})
