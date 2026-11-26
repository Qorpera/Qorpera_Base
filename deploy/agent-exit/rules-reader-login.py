#!/usr/bin/env python3
"""Qorpera agent exit (E8b): the rules reader's database login, made and placed in one go.

  python3 deploy/agent-exit/rules-reader-login.py [--check] --direct-host HOST --direct-port PORT
      --direct-ca FILE --direct-ca-sha256 SHA256 --direct-admin ROLE

Runs SQL through psql with sslmode=verify-full against the pinned CA bytes, sets a new
SCRAM-SHA-256 login for qorpera_agent_exit, places it on each node, and restarts the reader.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

ROLE = "qorpera_agent_exit"
NODES = (
    ("node01", "company41-node-01", "/usr/local/sbin/qorpera-task-admin-20260913"),
    ("node02", "company41-node-02", "/usr/local/sbin/qorpera-task-admin-20260916-node02"),
)
LIBEXEC = "/usr/local/libexec/qorpera-agent-exit"
TOOL = LIBEXEC + "/qorpera-agent-exit.sh"
PROGRAM = LIBEXEC + "/qorpera-agent-exit-rules.mjs"
LOGIN_FILE = "/etc/qorpera-agent-exit/database-url"
CLIENTS = "/var/lib/qorpera-agent-exit/clients"
HERE = os.path.dirname(os.path.abspath(__file__))
INSTALLED = (
    (TOOL, os.path.join(HERE, "qorpera-agent-exit.sh")),
    ("/etc/systemd/system/qorpera-agent-exit-rules.service", os.path.join(HERE, "qorpera-agent-exit-rules.service")),
)
LOGIN_PATTERN = (
    r"^postgresql://qorpera_agent_exit(\.[a-z0-9]{20})?:[A-Za-z0-9_-]{20,128}"
    r"@[a-z0-9.-]{1,253}:[0-9]{1,5}/postgres\?sslmode=verify-full$"
)
ROLE_QUERY = f"""select r.rolcanlogin as login,
  r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls as elevated,
  not exists (select 1 from pg_auth_members m where m.member = r.oid) as alone,
  coalesce(has_function_privilege(r.oid, to_regprocedure('public.qorpera_agent_exit_network_rules(uuid[])'),
    'execute'), false) as reads,
  r.rolvaliduntil is null as lasting
from pg_roles r where r.rolname = '{ROLE}'"""
NODE_LINE = re.compile(r"qorpera-agent-exit: [ -~]{0,300}")
HELPER_FAILURE = re.compile(r'\{"passed": ?false, ?"failureClass": ?"[A-Za-z]{1,64}"\}')
DIRECT_FLAGS = ("--direct-host", "--direct-port", "--direct-ca", "--direct-ca-sha256", "--direct-admin")
DIRECT_HOST = re.compile(r"(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*")
ADMIN_ROLE = re.compile(r"[a-z_][a-z0-9_]{0,62}")
PEM_CERTIFICATES = re.compile(
    rb"(-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]{1,16384}-----END CERTIFICATE-----\r?\n?)+")
OWN_CA = LIBEXEC + "/database-own-ca.crt"
OWN_CA_SHA = LIBEXEC + "/database-own-ca.sha256"
PSQL_LINE = re.compile(r"psql: error: [ -~]{0,300}")


class Stop(Exception):
    pass


class Usage(Exception):
    pass


def parse_args(argv):
    check, given, rest = False, {}, list(argv)
    while rest:
        flag = rest.pop(0)
        if flag == "--check" and not check:
            check = True
        elif flag in DIRECT_FLAGS and flag not in given and rest:
            given[flag] = rest.pop(0)
        else:
            raise Usage("")
    missing = [flag for flag in DIRECT_FLAGS if flag not in given]
    if missing:
        raise Usage("missing required flags: " + ", ".join(missing))
    return check, given


def direct_target(given):
    host, port, admin, pin = (given[flag] for flag in ("--direct-host", "--direct-port", "--direct-admin",
                                                       "--direct-ca-sha256"))
    if not DIRECT_HOST.fullmatch(host):
        raise Stop("--direct-host is not a host name (lower case)")
    if not re.fullmatch(r"[1-9][0-9]{0,4}", port) or int(port) > 65535:
        raise Stop("--direct-port is not a port")
    if not ADMIN_ROLE.fullmatch(admin) or admin == ROLE:
        raise Stop(f"--direct-admin is not a role name, or is {ROLE} itself")
    if not re.fullmatch(r"[0-9a-f]{64}", pin):
        raise Stop("--direct-ca-sha256 is not a sha256 (64 lower-case hex digits)")
    try:
        with open(given["--direct-ca"], "rb") as f:
            ca = f.read(65537)
    except OSError:
        raise Stop("--direct-ca could not be read") from None
    if not hmac.compare_digest(hashlib.sha256(ca).hexdigest(), pin):
        raise Stop("--direct-ca's sha256 is not --direct-ca-sha256")
    if not PEM_CERTIFICATES.fullmatch(ca):
        raise Stop("--direct-ca is not PEM certificates")
    return {"host": host, "port": int(port), "admin": admin, "ca": ca, "ca_sha256": pin}


def psql_env():
    return {key: value for key, value in os.environ.items()
            if not key.startswith("PG") or key in ("PGPASSWORD", "PGPASSFILE")}


def psql(args, stdin, env):
    path = shutil.which("psql")
    if not path:
        raise Stop("psql is not on PATH; direct mode runs its SQL with it")
    try:
        done = subprocess.run([path] + args, input=stdin.encode(), capture_output=True, env=env, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None, b"", b""
    return done.returncode, done.stdout, done.stderr


def direct_sql(target, ca_file, query, what, write=False):
    def quoted(value):
        return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"

    connection = " ".join(f"{key}={quoted(value)}" for key, value in (
        ("host", target["host"]), ("port", target["port"]), ("dbname", "postgres"), ("user", target["admin"]),
        ("sslmode", "verify-full"), ("sslrootcert", ca_file), ("gssencmode", "disable"), ("connect_timeout", 15),
        ("application_name", "qorpera-rules-reader-login"),
    ))
    body = query + ";\n" if write else (
        f"begin transaction read only;\nselect coalesce(json_agg(q), '[]'::json) from ({query}) q;\ncommit;\n")
    code, out, err = psql(
        ["--no-psqlrc", "--no-password", "--quiet", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1",
         "--file", "-", "--dbname=" + connection],
        body, psql_env(),
    )
    if code != 0:
        said = [line for line in err.decode("utf-8", "replace").splitlines() if PSQL_LINE.fullmatch(line)]
        raise Stop("\n".join([f"psql failed ({what})"] + ["  " + line for line in said]))
    if write:
        return []
    try:
        rows = json.loads(out)
    except ValueError:
        rows = None
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise Stop(f"psql's answer is not rows ({what})")
    return rows


def role_state(rows):
    if len(rows) != 1 or set(rows[0]) != {"login", "elevated", "alone", "reads", "lasting"}:
        raise Stop(f"no role {ROLE}: apply migration 20260930230000 first")
    row = rows[0]
    if row["elevated"] is not False or row["alone"] is not True or row["lasting"] is not True:
        raise Stop(f"role {ROLE} is not as migration 20260930230000 makes it: an attribute, a membership or an expiry")
    if row["reads"] is not True:
        raise Stop(f"role {ROLE} may not call public.qorpera_agent_exit_network_rules: apply migration 20260930230000")
    if not isinstance(row["login"], bool):
        raise Stop(f"the database answer on role {ROLE} is not as asked")
    return row["login"]


def scram_verifier(password, salt, iterations=4096):
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()

    def b64(data):
        return base64.b64encode(data).decode("ascii")

    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def set_login(verifier):
    if not re.fullmatch(r"SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=", verifier):
        raise Stop("the verifier is not as made")
    return f"alter role {ROLE} with login password '{verifier}'"


def login_url(host, password, port, user=ROLE):
    url = f"postgresql://{user}:{password}@{host}:{port}/postgres?sslmode=verify-full"
    if not re.fullmatch(LOGIN_PATTERN, url):
        raise Stop("the login is not in the form the exit's tool takes")
    return url


def shown(text, secret=None):
    lines, hidden = [], 0
    for line in text.splitlines():
        if (NODE_LINE.fullmatch(line) or HELPER_FAILURE.fullmatch(line)) and (secret is None or secret not in line):
            lines.append(line)
        elif line.strip():
            hidden += 1
    if hidden:
        lines.append(f"({hidden} other lines not shown)")
    return lines


def helper(node, request, secret=None):
    _, host, path = node
    try:
        done = subprocess.run(
            ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "sudo -n -- " + path],
            input=json.dumps(request).encode(), capture_output=True, timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Stop(f"{node[0]}: ssh to {host} failed or took too long") from None
    err = shown(done.stderr.decode("utf-8", "replace"), secret)
    return done.returncode, done.stdout.decode("utf-8", "replace"), err


def run(node, argv, stdin=None, secret=None):
    request = {"action": "exec", "argv": argv}
    if stdin is not None:
        request["stdin"] = stdin
    return helper(node, request, secret)


def node_failed(node, what, lines):
    return Stop("\n".join([f"{node[0]}: {what}"] + [f"{node[0]}:   {line}" for line in lines]))


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def check_node(node, ca_sha256):
    code, out, err = helper(node, {"action": "status"})
    try:
        installed = code == 0 and json.loads(out).get("installed") is True
    except (ValueError, AttributeError):
        installed = False
    if not installed:
        raise node_failed(node, "its root helper does not answer", err)
    paths = [path for path, _ in INSTALLED] + [PROGRAM, OWN_CA, OWN_CA_SHA]
    code, out, err = run(node, ["/usr/bin/sha256sum", "--"] + paths)
    found = {}
    for line in out.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (/\S+)", line)
        if match:
            found[match.group(2)] = match.group(1)
    for path, local in INSTALLED:
        if found.get(path) != sha256_file(local):
            raise node_failed(node, f"{path} is not this checkout's: install the exit from it first", err)
    if found.get(OWN_CA) != ca_sha256:
        raise node_failed(
            node, f"{OWN_CA} is not the direct database's pinned CA: install the exit with that CA first", err)
    expected_sha_file = hashlib.sha256(f"{ca_sha256}\n".encode("ascii")).hexdigest()
    if found.get(OWN_CA_SHA) != expected_sha_file:
        raise node_failed(
            node, f"{OWN_CA_SHA} does not match the direct database's pinned CA: reinstall the exit with that CA", err)
    if PROGRAM not in found:
        raise node_failed(node, f"{PROGRAM} is missing: install the exit with its rules reader package first", err)
    code, _, err = run(node, ["/usr/bin/test", "-d", CLIENTS])
    if code != 0:
        raise node_failed(node, f"no {CLIENTS}: the exit is not set up on this node", err)


def place_login(node, url, password):
    code, out, err = run(node, [TOOL, "database-url"], stdin=url, secret=password)
    lines = out.splitlines()
    match = re.fullmatch(r"(/\S+) mode=400 owner=root:root bytes=([0-9]+) sha256=([0-9a-f]{64})", lines[-1]) \
        if code == 0 and lines else None
    if not match or match.group(1) != LOGIN_FILE:
        raise node_failed(node, "the login file was not written", err)
    expected = hashlib.sha256(url.encode("ascii")).hexdigest()
    if int(match.group(2)) != len(url) or not hmac.compare_digest(match.group(3), expected):
        raise node_failed(node, f"{LOGIN_FILE} is not the login sent", err)
    return f"{node[0]}: {LOGIN_FILE} mode=400 owner=root:root bytes={match.group(2)}, sha256 matches"


def start_reader(node):
    code, out, err = run(node, [TOOL, "rules-start"])
    said = [line for line in out.splitlines() if NODE_LINE.fullmatch(line)]
    ok = "qorpera-agent-exit: the rules reader read the database: ok"
    if code != 0 or not said or not said[-1].startswith(ok):
        raise node_failed(node, "the rules reader did not read the database with the new login", said + err)
    return f"{node[0]}: {said[-1][len('qorpera-agent-exit: '):]}"


def main(argv):
    try:
        check, given = parse_args(argv)
    except Usage as usage:
        print("\n".join(filter(None, [str(usage), __doc__.split("\n\n")[1]])), file=sys.stderr)
        return 64
    target = direct_target(given)
    with tempfile.TemporaryDirectory(prefix="qorpera-rules-reader-login-") as folder:
        ca_file = os.path.join(folder, "ca.crt")
        with open(ca_file, "xb") as f:
            f.write(target["ca"])
        return rollout(
            check, f"the database {target['host']}:{target['port']} (direct, CA as pinned)",
            lambda query, what, write=False: direct_sql(target, ca_file, query, what, write),
            lambda password: login_url(target["host"], password, target["port"], ROLE),
            target["ca_sha256"],
        )


def rollout(check, database, sql_run, make_url, ca_sha256):
    had_login = role_state(sql_run(ROLE_QUERY, f"role {ROLE}"))
    for node in NODES:
        check_node(node, ca_sha256)
    print(f"checked: {database}, role {ROLE}{'' if had_login else ' (no login yet)'}, "
          + ", ".join(node[0] for node in NODES))
    if check:
        print("ok (nothing changed)")
        return 0
    password = secrets.token_urlsafe(32)
    url = make_url(password)
    for node in NODES:
        print(place_login(node, url, password))
    verifier = scram_verifier(password, secrets.token_bytes(16))
    try:
        sql_run(set_login(verifier), f"the login of role {ROLE}", write=True)
    except Stop as stop:
        raise Stop(f"{stop}; the role's login may or may not have changed: run this again") from None
    if role_state(sql_run(ROLE_QUERY, f"role {ROLE}")) is not True:
        raise Stop(f"role {ROLE} has no login after it was set: run this again")
    for node in NODES:
        print(start_reader(node))
    print("ok")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Stop as stop:
        print(f"rules-reader-login: {stop}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("rules-reader-login: interrupted; run it again (each run makes a new login)", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(f"rules-reader-login: failed ({type(error).__name__}); run it again", file=sys.stderr)
        sys.exit(1)
