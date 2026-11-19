#!/usr/bin/env python3
import json, os, subprocess, sys, threading, time

D = sys.argv[1]
SOCK = "/run/qorpera-model-login-helper/helper.sock"
TOKEN = "/etc/qorpera-model-login-helper/vault-token"
CG = "/sys/fs/cgroup/system.slice/qorpera-model-login-helper.service"
SCEN = os.path.join(D, "scenario.json")
SLOG = os.path.join(D, "stub.log")
ORG = "00000000-0000-4000-8000-0000000000c3"
FLAGS = {"tengu_cedar_ember": {"enabled": True}}


def grant(gid, kind, left, clears, usable_now=True, requires_limit=False):
    return {"id": gid, "label": "", "resets_total": left, "resets_left": left, "starts_at": None, "ends_at": "@ends",
            "clears": clears, "paused": False, "usable_now": usable_now, "use_requires_limit": requires_limit,
            "percent_used": {"five_hour": 28, "seven_day": 87}, "blocking": [], "type": kind,
            "gives_back_weekly": False, "unavailable_reason": None}


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
RESET_OK = {"result": "reset", "reason": None, "resets_left": 2, "cleared": ["five_hour", "seven_day"],
            "weekly_resets_at": "@week"}


def sc(**over):
    out = json.loads(json.dumps(BASE))
    out.update(over)
    return out


def creds(path, minutes_left):
    tok = "sk-ant-oat01-C2CAN" + "ARY-V1-" + os.urandom(8).hex()
    ref = "sk-ant-ort01-C2CAN" + "ARY-V1R-" + os.urandom(8).hex()
    with open(path, "w") as f:
        json.dump({"claudeAiOauth": {"accessToken": tok, "refreshToken": ref,
                                     "expiresAt": int((time.time() + minutes_left * 60) * 1000),
                                     "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
                                     "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"}}, f)
    os.chmod(path, 0o600)


def read(path):
    with open(path) as f:
        return f.read().strip()


class Sampler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.stop = False
        self.peak = 0
        self.tasks = 0
        self.base = int(read(f"{CG}/memory.current"))

    def run(self):
        while not self.stop:
            try:
                self.peak = max(self.peak, int(read(f"{CG}/memory.current")))
                self.tasks = max(self.tasks, int(read(f"{CG}/pids.current")))
            except Exception:
                pass
            time.sleep(0.02)


def cpu_usec():
    for line in open(f"{CG}/cpu.stat"):
        k, v = line.split()
        if k == "usage_usec":
            return int(v)
    return 0


def throttled():
    out = {}
    for line in open(f"{CG}/cpu.stat"):
        k, v = line.split()
        if k in ("nr_throttled", "throttled_usec"):
            out[k] = int(v)
    return out


def case(name, scen, mode, kind="", minutes_left=600):
    with open(SCEN, "w") as f:
        json.dump(scen, f)
    open(SLOG, "w").close()
    cpath = os.path.join(D, "creds.json")
    creds(cpath, minutes_left)
    peak_fd = os.open(f"{CG}/memory.peak", os.O_RDWR)
    try:
        os.write(peak_fd, b"reset\n")
        peak_reset = True
    except OSError:
        peak_reset = False
    before_cpu, before_thr = cpu_usec(), throttled()
    s = Sampler()
    s.start()
    t0 = time.time()
    r = subprocess.run(["/usr/bin/node", os.path.join(D, "client.mjs"), mode, SOCK, TOKEN, cpath, kind],
                       capture_output=True, text=True, timeout=200)
    secs = round(time.time() - t0, 2)
    s.stop = True
    s.join()
    os.lseek(peak_fd, 0, 0)
    peak = int(os.read(peak_fd, 64).decode().strip())
    os.close(peak_fd)
    after_thr = throttled()
    line = next((x for x in r.stdout.splitlines() if x.startswith("CLIENT-RESULT ")), None)
    stub = [json.loads(x) for x in open(SLOG)] if os.path.getsize(SLOG) else []
    left = [n for n in os.listdir("/run/qorpera-model-login-helper") if n.startswith("qorpera-claude-read-")]
    out = {
        "case": name, "mode": mode, "kind": kind, "secs": secs,
        "result": json.loads(line[len("CLIENT-RESULT "):]) if line else None,
        "clientStderr": r.stderr[-800:],
        "unitMemory": {"peakIsPerCase": peak_reset, "baselineMiB": round(s.base / 2**20, 1), "peakMiB": round(peak / 2**20, 1),
                       "sampledPeakMiB": round(s.peak / 2**20, 1), "maxTasks": s.tasks},
        "cpuSecs": round((cpu_usec() - before_cpu) / 1e6, 2),
        "throttled": {k: after_thr.get(k, 0) - before_thr.get(k, 0) for k in after_thr},
        "stub": [{k: x.get(k) for k in ("t", "kind", "method", "path", "host", "auth", "grant", "program", "model",
                                        "maxTokens") if x.get(k) is not None} for x in stub],
        "screenLaunches": sum(1 for x in stub if x.get("kind") == "flags"),
        "resetChecks": sum(1 for x in stub if "cedar_ember" in (x.get("path") or "")),
        "renewalsAtStub": sum(1 for x in stub if x.get("kind") == "renewal"),
        "claimsAtStub": sum(1 for x in stub if x.get("kind") == "claim"),
        "leftInHelperRoot": left,
    }
    print(f"\n######## {name}")
    print(json.dumps(out, indent=1)[:12000])
    sys.stdout.flush()
    return out


ONLY = sys.argv[2:]
CASES = [
    ("read-none", lambda: case("read-none", sc(cedar_ember=NONE), "read")),
    ("read-one", lambda: case("read-one", sc(cedar_ember=ONE_FULL), "read")),
    ("read-two", lambda: case("read-two", sc(cedar_ember=TWO_KINDS), "read")),
    ("read-limitonly", lambda: case("read-limitonly", sc(cedar_ember=AT_LIMIT_ONLY), "read")),
    ("read-atwall", lambda: case("read-atwall", sc(cedar_ember=AT_WALL), "read")),
    ("read-expired", lambda: case("read-expired", sc(cedar_ember=ONE_FULL), "read", minutes_left=-30)),
    ("reset-ok", lambda: case("reset-ok", sc(cedar_ember=ONE_FULL, claim=RESET_OK), "reset", "full")),
    ("reset-http500", lambda: case("reset-http500", sc(cedar_ember=ONE_FULL, claim={"http": 500}), "reset", "full")),
    ("read-two-again", lambda: case("read-two-again", sc(cedar_ember=TWO_KINDS), "read")),
]
results = []
for name, fn in CASES:
    if not ONLY or name in ONLY:
        try:
            results.append(fn())
        except Exception as e:
            print(f"\n######## {name}\nDRIVER-ERROR {type(e).__name__}: {e}")
print("\n######## SUMMARY")
for r in results:
    res = r["result"] or {}
    body = res.get("result")
    if r["mode"] == "read" and body:
        u = body.get("usage")
        rs = body.get("resets")
        what = (f"usage={'%d windows' % len(u['windows']) if u else None} "
                f"resets={[(e['kind'], e['left'], e['usable']) for e in rs['entries']] if rs else None}")
    else:
        what = json.dumps(body if body is not None else res.get("error"))
    print(f"{r['case']:16} {r['secs']:6.2f}s peak {r['unitMemory']['peakMiB']:7.1f} MiB (base "
          f"{r['unitMemory']['baselineMiB']}) cpu {r['cpuSecs']:5.2f}s throttled {r['throttled'].get('throttled_usec', 0) / 1e6:.1f}s "
          f"tasks {r['unitMemory']['maxTasks']:3} screens {r['screenLaunches']} checks {r['resetChecks']} renewals@stub {r['renewalsAtStub']} claims@stub {r['claimsAtStub']} "
          f"left {len(r['leftInHelperRoot'])} | {what}")
