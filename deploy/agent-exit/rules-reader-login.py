#!/usr/bin/env python3
"""Qorpera agent exit (E8b): the rules reader's database login, made and placed in one go. The coordinator runs it on
the Mac, from a checkout of what the nodes run; nobody handles the login by hand.

  python3 deploy/agent-exit/rules-reader-login.py --check   checks everything below, changes nothing
  python3 deploy/agent-exit/rules-reader-login.py           makes a new login and places it
  python3 deploy/agent-exit/rules-reader-login.py [--check] --direct-host HOST --direct-port PORT
      --direct-ca FILE --direct-ca-sha256 SHA256 --direct-admin ROLE
                                                            the same against a self-hosted database (direct mode)

Checks first: the project's pooler, the role qorpera_agent_exit as migration 20260930230000 makes it (no elevated
attribute, a member of no role, may call the one read function), and on each node the root helper, the exit's tool,
the reader's unit and CA as this checkout's, its program and the exit's client map. Then:
1. a new password (256 random bits) and the login URL for the pooler;
2. each node writes the URL into its root-only file (qorpera-agent-exit.sh database-url, 0400 root:root), which the
   reader gets through LoadCredential; the script compares each file's size and sha256 with the URL's;
3. the role gets the login: a SCRAM-SHA-256 verifier made here, never the password, so the password never reaches
   the Supabase API, the database or its logs (the one commit point: until it, the readers run on the old login);
4. each node restarts its reader and waits for a pass that read the database with the new login.
Run again at any step that fails: each run makes a new password.

How the login travels: this script's memory, then the ssh connection's stdin (a JSON request for the node's root
helper, which keeps only an HMAC of it), the helper's memfd as the tool's stdin (bash reads it, never an argument),
the root-only file, and systemd's credential copy for the reader. It is never printed, logged, in an argument, in an
environment variable or in a file on this Mac. The Supabase CLI's token comes from the keychain the same way: read by
this script, sent only to api.supabase.com. The script prints file names, sizes, the hash comparison and ok; from a
node only the exit's tool's own lines or the helper's failure class, never anything holding the password.

Direct mode (opt-in, for a self-hosted database; without its flags nothing above changes): all five flags or none.
The SQL runs through psql over a direct admin connection, not the Supabase API, and nothing reads the keychain. The
script takes the CA file only when its sha256 is --direct-ca-sha256, and gives psql a copy of those bytes with
sslmode=verify-full, so psql checks the host's certificate and name against that CA alone; there is no mode without
that check. The admin role's password is psql's own to find (PGPASSWORD, PGPASSFILE or ~/.pgpass; never a prompt):
this script never reads it, and psql gets no other libpq setting from the environment. The login is
postgresql://qorpera_agent_exit:<password>@HOST:PORT/postgres?sslmode=verify-full, and each node's reader CA must
already be the pinned CA (installing that CA and the reader's own pin is not this script's).
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
import urllib.error
import urllib.request

REF = "phqlfrkcvstmxlebljcj"
API = "https://api.supabase.com/v1/projects/" + REF
ROLE = "qorpera_agent_exit"
# The pooler's transaction port, as the secret broker uses it: the direct host has IPv6 only, the nodes IPv4.
PORT = 6543
# Each node: its name here, its ssh host and its root helper (coordinator-live/root-helper-p1).
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
# What the nodes must run, as in this checkout (install-agent-exit.sh installs them): node path, checkout path.
INSTALLED = (
    (TOOL, os.path.join(HERE, "qorpera-agent-exit.sh")),
    ("/etc/systemd/system/qorpera-agent-exit-rules.service", os.path.join(HERE, "qorpera-agent-exit-rules.service")),
    (LIBEXEC + "/supabase-prod-ca-2021.crt", os.path.join(HERE, "../cloud-secret-broker/supabase-prod-ca-2021.crt")),
)
# The one form of login the exit's tool takes (qorpera-agent-exit.sh database_url); a test keeps the two the same.
LOGIN_PATTERN = (
    r"^postgresql://qorpera_agent_exit(\.[a-z0-9]{20})?:[A-Za-z0-9_-]{20,128}"
    r"@[a-z0-9.-]{1,253}:[0-9]{1,5}/postgres\?sslmode=verify-full$"
)
POOLER_HOST = re.compile(r"aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com")
ROLE_QUERY = f"""select r.rolcanlogin as login,
  r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls as elevated,
  not exists (select 1 from pg_auth_members m where m.member = r.oid) as alone,
  coalesce(has_function_privilege(r.oid, to_regprocedure('public.qorpera_agent_exit_network_rules(uuid[])'),
    'execute'), false) as reads,
  r.rolvaliduntil is null as lasting
from pg_roles r where r.rolname = '{ROLE}'"""
NODE_LINE = re.compile(r"qorpera-agent-exit: [ -~]{0,300}")
HELPER_FAILURE = re.compile(r'\{"passed": ?false, ?"failureClass": ?"[A-Za-z]{1,64}"\}')
# Direct mode's inputs: all of them or none (none: the Supabase project above, as before).
DIRECT_FLAGS = ("--direct-host", "--direct-port", "--direct-ca", "--direct-ca-sha256", "--direct-admin")
DIRECT_HOST = re.compile(r"(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*")
ADMIN_ROLE = re.compile(r"[a-z_][a-z0-9_]{0,62}")
PEM_CERTIFICATES = re.compile(
    rb"(-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]{1,16384}-----END CERTIFICATE-----\r?\n?)+")
# The reader's CA on the nodes; in direct mode it must be the pinned CA, not this checkout's Supabase CA.
(READER_CA,) = [path for path, _ in INSTALLED if path.endswith(".crt")]
PSQL_LINE = re.compile(r"psql: error: [ -~]{0,300}")


class Stop(Exception):
    """A failure, with a message that holds no secret."""


class Usage(Exception):
    """A command line this script does not take; its message (may be empty) says why."""


def cli_token(raw):
    """The Supabase CLI's token from the keychain item's text. The CLI keeps it through go-keyring, which may store
    it encoded."""
    text = raw.decode("utf-8").strip()
    if text.startswith("go-keyring-base64:"):
        text = base64.b64decode(text[len("go-keyring-base64:"):], validate=True).decode("utf-8")
    elif text.startswith("go-keyring-encoded:"):
        text = bytes.fromhex(text[len("go-keyring-encoded:"):]).decode("utf-8")
    if not re.fullmatch(r"sbp_[A-Za-z0-9_-]{20,200}", text):
        raise Stop("the keychain's Supabase CLI item holds no token as the CLI writes it")
    return text


def keychain_token():
    try:
        found = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", "Supabase CLI", "-w"],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Stop("the keychain could not be read") from None
    if found.returncode != 0:
        raise Stop("the Supabase CLI login is not in the keychain (supabase login)")
    try:
        return cli_token(found.stdout)
    except (UnicodeDecodeError, ValueError):
        raise Stop("the keychain's Supabase CLI item holds no token as the CLI writes it") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def api(token, method, path, what, body=None):
    request = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "qorpera-rules-reader-login",
        },
    )
    try:
        with OPENER.open(request, timeout=60) as response:
            return json.loads(response.read(4 * 1024 * 1024 + 1))
    except urllib.error.HTTPError as error:
        # Only the status: the answer's body may repeat the request.
        raise Stop(f"the Supabase API answered HTTP {error.code} ({what})") from None
    except (OSError, ValueError):
        raise Stop(f"the Supabase API could not be reached or read ({what})") from None


def sql(token, query, what, write=False):
    body = {"query": query} if write else {"query": query, "read_only": True}
    rows = api(token, "POST", "/database/query", what, body)
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise Stop(f"the Supabase API's answer is not rows ({what})")
    return rows


def parse_args(argv):
    """(check, direct): direct is None without direct mode's flags, else each of them with its value. A flag twice, one
    without a value, an unknown one or only some of direct mode's is a usage error."""
    check, given, rest = False, {}, list(argv)
    while rest:
        flag = rest.pop(0)
        if flag == "--check" and not check:
            check = True
        elif flag in DIRECT_FLAGS and flag not in given and rest:
            given[flag] = rest.pop(0)
        else:
            raise Usage("")
    if not given:
        return check, None
    missing = [flag for flag in DIRECT_FLAGS if flag not in given]
    if missing:
        raise Usage("direct mode needs all of its flags; missing " + ", ".join(missing))
    return check, given


def direct_target(given):
    """Direct mode's database, each input checked: a host name, a port, an admin role and the CA, taken only when its
    sha256 is the pin."""
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
    """psql's environment: this one without libpq's settings, so none overrides what the connection names. Only where
    psql finds the admin's password stays (PGPASSWORD, PGPASSFILE), for psql alone to read."""
    return {key: value for key, value in os.environ.items()
            if not key.startswith("PG") or key in ("PGPASSWORD", "PGPASSFILE")}


def psql(args, stdin, env):
    """psql once: its exit code, stdout and stderr. None for the code if it could not run."""
    path = shutil.which("psql")
    if not path:
        raise Stop("psql is not on PATH; direct mode runs its SQL with it")
    try:
        done = subprocess.run([path] + args, input=stdin.encode(), capture_output=True, env=env, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None, b"", b""
    return done.returncode, done.stdout, done.stderr


def direct_sql(target, ca_file, query, what, write=False):
    """As sql, over a direct admin connection with psql: TLS verify-full against the pinned CA's copy, rows as JSON. A
    read runs in a read-only transaction."""

    def quoted(value):
        return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"

    connection = " ".join(f"{key}={quoted(value)}" for key, value in (
        ("host", target["host"]), ("port", target["port"]), ("dbname", "postgres"), ("user", target["admin"]),
        # TLS only: GSSAPI encryption, which libpq would otherwise try first, would stand in for verify-full.
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
        # Only psql's own connection errors: a statement's error may repeat the statement.
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


def pooler_host(entries):
    """The pooler's host for the primary database, as the API lists it."""
    primary = [entry for entry in entries if isinstance(entry, dict) and entry.get("database_type") == "PRIMARY"] \
        if isinstance(entries, list) else []
    hosts = {entry.get("db_host") if isinstance(entry.get("db_host"), str) else "" for entry in primary}
    if len(hosts) != 1:
        raise Stop("the project's pooler is not one primary pooler")
    host = hosts.pop()
    if not POOLER_HOST.fullmatch(host):
        raise Stop("the project's pooler is not on a host as Supabase names its poolers")
    if not all(entry.get("is_using_scram_auth") is True for entry in primary):
        raise Stop("the project's pooler does not use SCRAM; this script sets a SCRAM login")
    return host


def role_state(rows):
    """Whether the role has a login now; refuses a role not as migration 20260930230000 makes it."""
    if len(rows) != 1 or set(rows[0]) != {"login", "elevated", "alone", "reads", "lasting"}:
        raise Stop(f"no role {ROLE}: apply migration 20260930230000 first")
    row = rows[0]
    if row["elevated"] is not False or row["alone"] is not True or row["lasting"] is not True:
        raise Stop(f"role {ROLE} is not as migration 20260930230000 makes it: an attribute, a membership or an expiry")
    if row["reads"] is not True:
        raise Stop(f"role {ROLE} may not call public.qorpera_agent_exit_network_rules: apply migration 20260930230000")
    if not isinstance(row["login"], bool):
        raise Stop(f"the Supabase API's answer on role {ROLE} is not as asked")
    return row["login"]


def scram_verifier(password, salt, iterations=4096):
    """What Postgres keeps of a SCRAM-SHA-256 password (RFC 5802, RFC 7677): the salt, StoredKey and ServerKey."""
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


def login_url(host, password, port=PORT, user=ROLE + "." + REF):
    url = f"postgresql://{user}:{password}@{host}:{port}/postgres?sslmode=verify-full"
    if not re.fullmatch(LOGIN_PATTERN, url):
        raise Stop("the login is not in the form the exit's tool takes")
    return url


def shown(text, secret=None):
    """A node's lines fit to print: the exit's tool's own and the helper's failure class, never one holding the
    secret. The rest is counted, not shown."""
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
    """One request to a node's root helper over ssh: exit code, stdout, and its stderr's lines fit to print."""
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


def check_node(node, ca_sha256=None):
    code, out, err = helper(node, {"action": "status"})
    try:
        installed = code == 0 and json.loads(out).get("installed") is True
    except (ValueError, AttributeError):
        installed = False
    if not installed:
        raise node_failed(node, "its root helper does not answer", err)
    paths = [path for path, _ in INSTALLED] + [PROGRAM]
    code, out, err = run(node, ["/usr/bin/sha256sum", "--"] + paths)
    found = {}
    for line in out.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (/\S+)", line)
        if match:
            found[match.group(2)] = match.group(1)
    for path, local in INSTALLED:
        if ca_sha256 is not None and path == READER_CA:
            if found.get(path) != ca_sha256:
                raise node_failed(node, f"{path} is not the direct database's pinned CA: install that CA first", err)
        elif found.get(path) != sha256_file(local):
            raise node_failed(node, f"{path} is not this checkout's: install the exit from it first", err)
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
    if given is None:
        token = keychain_token()
        host = pooler_host(api(token, "GET", "/config/database/pooler", "the pooler"))
        return rollout(check, "the pooler", lambda query, what, write=False: sql(token, query, what, write),
                       lambda password: login_url(host, password))
    target = direct_target(given)
    with tempfile.TemporaryDirectory(prefix="qorpera-rules-reader-login-") as folder:
        # psql reads the CA from this copy of the bytes checked against the pin, never from the file named.
        ca_file = os.path.join(folder, "ca.crt")
        with open(ca_file, "xb") as f:
            f.write(target["ca"])
        return rollout(
            check, f"the database {target['host']}:{target['port']} (direct, CA as pinned)",
            lambda query, what, write=False: direct_sql(target, ca_file, query, what, write),
            lambda password: login_url(target["host"], password, target["port"], ROLE),
            target["ca_sha256"],
        )


def rollout(check, database, sql_run, make_url, ca_sha256=None):
    """The checks, then the login made, placed, set and read: against the Supabase project or direct mode's
    database, which sql_run and make_url reach."""
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
        # Only the failure's kind: its text could hold anything.
        print(f"rules-reader-login: failed ({type(error).__name__}); run it again", file=sys.stderr)
        sys.exit(1)
