#!/usr/bin/env python3
"""How the pinned Claude Code renews its sign-in, against renewal-stub.py behind renewal-proxy.py (no real sign-in).
Usage (as root, renewal-probe.sh makes the folder): renewal-probe.py ROOT CLAUDE CA CERT KEY start|midrun BUFFER_S|inside|vault"""
import json, os, shutil, signal, socket, subprocess, sys, threading, time

ROOT, CLAUDE, CA, CERT, KEY, PASS = sys.argv[1:7]
BUFFER_S = float(sys.argv[7]) if len(sys.argv) > 7 else 300.0
HERE = os.path.dirname(os.path.abspath(__file__))
NOBODY = 65534
ONBOARDED = json.dumps({"hasCompletedOnboarding": True, "bypassPermissionsModeAccepted": True})
BOTH = ["api.anthropic.com", "platform.claude.com"]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def creds(tagname, expires_in_s):
    tok = "sk-ant-oat01-C2CAN" + f"ARY-{tagname}-" + os.urandom(8).hex()
    ref = "sk-ant-ort01-C2CAN" + f"ARY-{tagname}-" + os.urandom(8).hex()
    return json.dumps({"claudeAiOauth": {"accessToken": tok, "refreshToken": ref,
                                         "expiresAt": int((time.time() + expires_in_s) * 1000),
                                         "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
                                         "subscriptionType": "max"}})


def write_owned(path, text, mode=0o600):
    tmp = path + ".probe-tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chown(tmp, NOBODY, NOBODY)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def file_facts(cfg):
    p = os.path.join(cfg, ".credentials.json")
    if not os.path.exists(p):
        return {"exists": False}
    st = os.stat(p)
    try:
        o = json.load(open(p)).get("claudeAiOauth", {})
    except Exception as e:
        return {"exists": True, "unreadable": type(e).__name__, "size": st.st_size}
    import re
    t = lambda s: (re.search(r"C2CANARY-([A-Z0-9]+)-", s or "") or [None, None])[1]
    return {"exists": True, "ino": st.st_ino, "keys": sorted(o.keys()), "access": t(o.get("accessToken")),
            "refresh": t(o.get("refreshToken")),
            "leftMin": round((o.get("expiresAt", 0) / 1000 - time.time()) / 60, 1) if o.get("expiresAt") else None}


def redact(s):
    import re
    return re.sub(r"sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]+", "<token>", s)


def run(name, *, expires_in_s, steps=(), allow=BOTH, refuse=False, args=None, actions=(), stub_expires=28800,
        timeout=240, prompt="probe", share=None):
    d = os.path.join(ROOT, name)
    shutil.rmtree(d, ignore_errors=True)
    for sub in ("", "cfg", "home", "work"):
        os.makedirs(os.path.join(d, sub), exist_ok=True)
        os.chown(os.path.join(d, sub), NOBODY, NOBODY)
        os.chmod(os.path.join(d, sub), 0o700)
    os.chmod(d, 0o755)
    cfg = os.path.join(d, "cfg")
    if share:
        write_owned(os.path.join(cfg, ".credentials.json"), open(os.path.join(share, "orig.json")).read())
    elif expires_in_s is not None:
        write_owned(os.path.join(cfg, ".credentials.json"), creds("V1", expires_in_s))
    if os.path.exists(os.path.join(cfg, ".credentials.json")):
        shutil.copyfile(os.path.join(cfg, ".credentials.json"), os.path.join(d, "orig.json"))
        os.chmod(os.path.join(d, "orig.json"), 0o600)
    write_owned(os.path.join(cfg, ".claude.json"), ONBOARDED)
    state = os.path.join(d, "state.json")
    with open(state, "w") as f:
        json.dump({"valid": "V1", "n": 0, "refuse": refuse, "steps": list(steps), "revoked": [],
                   "expiresIn": stub_expires,
                   "exp": {"V1": time.time() + expires_in_s} if expires_in_s is not None else {}} if not share else json.load(open(os.path.join(share, "state.json"))), f)
    allowf = os.path.join(d, "allow")
    open(allowf, "w").write("\n".join(allow) + "\n")
    sp, pp = free_port(), free_port()
    slog, plog = os.path.join(d, "stub.jsonl"), os.path.join(d, "proxy.jsonl")
    stub = subprocess.Popen([sys.executable, os.path.join(HERE, "renewal-stub.py"), str(sp), state, slog, CERT, KEY],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    proxy = subprocess.Popen([sys.executable, os.path.join(HERE, "renewal-proxy.py"), str(pp), str(sp), allowf, plog],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    stub.stdout.readline(); proxy.stdout.readline()
    env = {"HOME": os.path.join(d, "home"), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC", "TERM": "dumb",
           "NO_COLOR": "1", "CLAUDE_CONFIG_DIR": cfg, "HTTPS_PROXY": f"http://127.0.0.1:{pp}",
           "https_proxy": f"http://127.0.0.1:{pp}", "NODE_EXTRA_CA_CERTS": CA, "DISABLE_AUTOUPDATER": "1",
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1"}
    argv = args or ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode",
                    "bypassPermissions", "--setting-sources", "user", "--strict-mcp-config", "--tools", "Bash"]
    t0 = time.time()
    out = open(os.path.join(d, "out.txt"), "w")
    err = open(os.path.join(d, "err.txt"), "w")
    child = subprocess.Popen(["setpriv", f"--reuid={NOBODY}", f"--regid={NOBODY}", "--clear-groups", CLAUDE, *argv],
                             cwd=os.path.join(d, "work"), env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
    timers = []
    events = []

    def act(kind, value):
        events.append({"t": round(time.time() - t0, 1), "act": kind, "value": value if kind != "replace" else value[0]})
        if kind == "replace":
            write_owned(os.path.join(cfg, ".credentials.json"), creds(value[0], value[1]))
            st = json.load(open(state)); st["valid"] = value[0]; st["exp"][value[0]] = time.time() + value[1]
            json.dump(st, open(state, "w"))
        elif kind == "revoke":
            st = json.load(open(state)); st["revoked"].append(value); json.dump(st, open(state, "w"))
        elif kind == "allow":
            open(allowf, "w").write("\n".join(value) + "\n")
        elif kind == "refuse":
            st = json.load(open(state)); st["refuse"] = value; json.dump(st, open(state, "w"))

    for at, kind, value in actions:
        tm = threading.Timer(at, act, (kind, value))
        tm.start()
        timers.append(tm)
    try:
        rc = child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.kill(); rc = "timeout"
    for tm in timers:
        tm.cancel()
    secs = round(time.time() - t0, 1)
    out.close(); err.close()
    stub.terminate(); proxy.terminate()
    stub.wait(); proxy.wait()
    result = None
    stream = open(os.path.join(d, "out.txt")).read()
    for line in stream.splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "result":
            result = {"subtype": o.get("subtype"), "is_error": o.get("is_error"), "text": redact(str(o.get("result")))[:300]}
        if o.get("type") == "system" and o.get("subtype") == "init":
            pass
    reqs = [json.loads(l) for l in open(slog)] if os.path.exists(slog) else []
    cons = [json.loads(l) for l in open(plog)] if os.path.exists(plog) else []
    print(f"\n### {name}: rc={rc} {secs}s result={json.dumps(result)}")
    for e in events:
        print(f"   ACT  t={e['t']:>6} {e['act']} {e['value']}")
    for r in sorted([dict(r, src="stub") for r in reqs] + [dict(c, src="proxy") for c in cons], key=lambda r: r["wall"]):
        t = round(r["wall"] - t0, 1)
        if r["src"] == "proxy":
            print(f"   CONN t={t:>6} {r['host']} {'passed' if r['passed'] else 'REFUSED'}")
        elif r["kind"] == "refresh":
            print(f"   RFR  t={t:>6} {r['host']} {r['path']} grant={r['grant']} sent={r['sent']} answer={r['answer']} form={r['form']} fields={r['fields']}")
        else:
            print(f"   REQ  t={t:>6} {r['method']} {r['host']}{r['path']} bearer={r['bearer']} step={r.get('step')} {('answer=' + str(r['answer'])) if 'answer' in r else ''}")
    if not result:
        print("   stdout(head): " + redact(stream)[:900].replace("\n", " | "))
    e = redact(open(os.path.join(d, "err.txt")).read())
    if e.strip():
        print("   stderr(head): " + e[:800].replace("\n", " | "))
    print(f"   FILE after: {json.dumps(file_facts(cfg))}")
    print(f"   CFG entries: {sorted(os.listdir(cfg))}")
    return d


def static():
    import re
    data = open(CLAUDE, "rb").read()
    print("### static: the binary's own text around its renewal")
    pats = [rb"oauth/token", rb"refresh_token", rb"\.credentials\.json", rb"expiresAt", rb"invalid_grant",
            rb"OAuth token has expired", rb"CLAUDE_CODE_OAUTH", rb"auth status"]
    for pat in pats:
        hits = [m.start() for m in re.finditer(pat, data)]
        print(f"--- {pat.decode()} : {len(hits)} hits")
        shown = 0
        last = -10_000
        for h in hits:
            if h - last < 600 or shown >= 6:
                continue
            last = h
            shown += 1
            chunk = data[max(0, h - 500):h + 500].decode("latin1")
            chunk = re.sub(r"[^\x20-\x7e]", ".", chunk)
            print(f"[{h}] {chunk}")


if PASS == "start":
    static()
    for a in (["--help"], ["auth", "--help"], ["auth", "status", "--help"]):
        r = subprocess.run(["setpriv", f"--reuid={NOBODY}", f"--regid={NOBODY}", "--clear-groups", CLAUDE, *a],
                           capture_output=True, text=True, env={"HOME": "/tmp", "PATH": "/usr/bin:/bin"}, timeout=60)
        print(f"### claude {' '.join(a)} rc={r.returncode}\n{(r.stdout + r.stderr)[:2500]}")
    for m in (-60, 1, 3, 4.5, 5.5, 7, 10, 31, 65):
        run(f"start{m:+g}m", expires_in_s=m * 60)
    run("start-valid-again", expires_in_s=8 * 3600)
    run("start-expired-refused400", expires_in_s=-3600, refuse=True)
    run("start-expired-platform-blocked", expires_in_s=-3600, allow=["api.anthropic.com"])
    run("vault-renew-api-blocked", expires_in_s=-3600, allow=["platform.claude.com"])
    run("vault-renew-api-blocked-valid", expires_in_s=3 * 3600, allow=["platform.claude.com"])
    run("auth-status-expired", expires_in_s=-3600, args=["auth", "status"])
    run("auth-status-expired-json", expires_in_s=-3600, args=["auth", "status", "--json"])
    run("auth-status-near", expires_in_s=120, args=["auth", "status"])
    run("auth-status-valid", expires_in_s=3 * 3600, args=["auth", "status"])
    first = run("rotation-copy-a", expires_in_s=-3600)
    run("rotation-copy-b", expires_in_s=None, share=first)
elif PASS == "midrun":
    B = BUFFER_S
    lead = B + 20
    run("mid-expiry-allowed", expires_in_s=lead, steps=["sleep 40", "echo two"])
    run("mid-expiry-blocked", expires_in_s=lead, steps=["sleep 40", "echo two"], allow=["api.anthropic.com"])
    run("mid-expiry-blocked-past", expires_in_s=B + 5, steps=["sleep 15", "sleep 300", "echo three"],
        allow=["api.anthropic.com"], timeout=480)
    run("mid-expired-then-replaced", expires_in_s=B + 5, steps=["sleep 15", "sleep 300", "echo three"],
        allow=["api.anthropic.com"], actions=[(318, "replace", ("V2", 8 * 3600))], timeout=480)
    run("mid-replaced-near-blocked", expires_in_s=lead, steps=["sleep 40", "echo two"], allow=["api.anthropic.com"],
        actions=[(10, "replace", ("V2", 8 * 3600))])
    run("mid-replaced-inside-blocked", expires_in_s=lead, steps=["sleep 40", "sleep 20", "echo three"],
        allow=["api.anthropic.com"], actions=[(48, "replace", ("V2", 8 * 3600))], timeout=300)
    run("mid-replaced-far", expires_in_s=8 * 3600, steps=["sleep 15", "echo two"], allow=["api.anthropic.com"],
        actions=[(5, "replace", ("V2", 8 * 3600))])
    run("mid-401-allowed", expires_in_s=8 * 3600, steps=["sleep 15", "echo two"],
        actions=[(5, "revoke", "V1")])
    run("mid-401-replaced-blocked", expires_in_s=8 * 3600, steps=["sleep 15", "echo two"],
        allow=["api.anthropic.com"], actions=[(3, "replace", ("V2", 8 * 3600)), (5, "revoke", "V1")])
    run("mid-401-blocked", expires_in_s=8 * 3600, steps=["sleep 15", "echo two"], allow=["api.anthropic.com"],
        actions=[(5, "revoke", "V1")])
elif PASS == "inside":
    # WHY: Claude Code refuses a long `sleep` as a Bash step, so these steps sleep 15 s.
    run("inside-replaced-before", expires_in_s=310, steps=["sleep 15", "echo two"], allow=["api.anthropic.com"],
        actions=[(5, "replace", ("V2", 8 * 3600))])
    run("inside-replaced-after-attempt", expires_in_s=310, steps=["sleep 15", "sleep 15", "echo three"],
        allow=["api.anthropic.com"], actions=[(20, "replace", ("V2", 8 * 3600))])
    run("inside-ends-blocked", expires_in_s=310, steps=["sleep 15", "echo two"], allow=["api.anthropic.com"],
        actions=[(12, "revoke", "V1")])
elif PASS == "vault":
    run("vault-status-refused", expires_in_s=-3600, refuse=True, args=["auth", "status", "--json"])
    run("vault-status-blocked", expires_in_s=-3600, allow=["api.anthropic.com"], args=["auth", "status", "--json"])
    run("vault-status-near-platform-only", expires_in_s=120, allow=["platform.claude.com"],
        args=["auth", "status", "--json"])
    run("vault-status-outside-window", expires_in_s=400, args=["auth", "status", "--json"])
    first = run("vault-status-copy-a", expires_in_s=120, args=["auth", "status", "--json"])
    run("vault-status-copy-b-stale", expires_in_s=None, share=first, args=["auth", "status", "--json"])
else:
    sys.exit("PASS is start, midrun, inside or vault")
