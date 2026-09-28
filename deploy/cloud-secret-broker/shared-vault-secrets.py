#!/usr/bin/env python3
"""shared-vault-secrets.py: the shared vault's private files (Vault By Default), made and moved on the vault
hosts only. Run as root on a node, through the root helper; nothing here ever prints a secret, and nothing
secret passes through the operator's machine: only hashes and "match"/"mismatch" leave a host.

  generate --key-id ID   node 1: make the principal secret and the master key (32 random bytes each) as
                         root-only files, never over existing ones; print the principal's capability hash
                         (for its database row), the key id and the fingerprints.
  fingerprint            any node: print the fingerprints of the files it holds, and their one digest.
  helper-token           each node: make the shared vault's own login helper token, as the helper's credential
                         and as the vault's helper client file, both root-only; print nothing secret. The
                         company brokers on the host keep the helper's other token and never see the
                         vault's members' sign-ins.
  ticket                 node 2: make a one-time ticket as a root-only file (replacing an unused one); print
                         only its sha256.
  serve --bind IP --peer IP --port P --ticket-sha256 H [--ttl S]
                         node 1: hand the standby everything it needs, once, over the hosts' private
                         (WireGuard) network, to the peer that presents the ticket: both secrets and the
                         vault's database login, runtime token, connector clients and coding executor token
                         (copied on node 1 from the company brokers' own files); then stop, or stop at the
                         deadline. It reads the files as root and serves as nobody.
  fetch --source IP --port P --expect DIGEST
                         node 2: fetch with its ticket (used up either way), check the files against node 1's
                         digest before writing anything, and only then write them as root-only files.

Every write is staged under a temporary name and renamed into place only when all of it is written, so a
failed step leaves nothing behind and can simply be run again.

A fingerprint is HMAC-SHA256 of a fixed label under the file's content: it names a secret without revealing
it. The principal's capability is base64url(HMAC-SHA256(principal secret, "qorpera.broker-principal/v1")),
exactly as the broker derives it; only its sha256 leaves the host.
"""
import argparse
import base64
import hashlib
import hmac
import http.client
import http.server
import json
import os
import pathlib
import re
import sys
import time

DEFAULT_ROOT = "/etc/qorpera-shared-vault"
PRINCIPAL = "principal-secret"
MASTER_KEYS = "master-keys.json"
TICKET = "fetch-ticket"
HELPER_CLIENT = "login-helper.json"
DEFAULT_HELPER_ROOT = "/etc/qorpera-model-login-helper"
HELPER_TOKEN = "vault-token"
DEFAULT_HELPER_SOCKET = "/run/qorpera-model-login-helper/helper.sock"
# A connection gets this long to send its request; the hand-over answers node 2's address only.
REQUEST_TIMEOUT_S = 5
# The other private files the shared vault's unit loads, the same on both hosts (the login helper's client
# file is each host's own and never moves).
PASSED_ON = ("database-url", "runtime", "connectors.json", "coding-executor")
MAX_FILE_BYTES = 16384
KEY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SECRET = re.compile(r"^[A-Za-z0-9_-]{43}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
ROUTE = "/shared-vault-secrets"
NOBODY = 65534


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64url(text: str) -> bytes:
    if not isinstance(text, str) or not SECRET.fullmatch(text):
        raise SystemExit("A shared vault secret is malformed")
    data = base64.urlsafe_b64decode(text + "=")
    if len(data) != 32 or b64url(data) != text:
        raise SystemExit("A shared vault secret is malformed")
    return data


def fingerprint(secret: bytes) -> str:
    return hmac.new(secret, b"qorpera.shared-vault-fingerprint/v1", hashlib.sha256).hexdigest()


def principal_capability_sha256(secret: bytes) -> str:
    capability = b64url(hmac.new(secret, b"qorpera.broker-principal/v1", hashlib.sha256).digest())
    return hashlib.sha256(capability.encode("ascii")).hexdigest()


def root_of(value: str) -> pathlib.Path:
    root = pathlib.Path(value)
    if not root.is_absolute() or str(root.resolve()) != str(root):
        raise SystemExit("The shared vault root must be an absolute, resolved path")
    if str(root) == DEFAULT_ROOT and os.geteuid() != 0:
        raise SystemExit("The shared vault's secrets are made and read by root only")
    return root


def make_root(root: pathlib.Path) -> None:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)


def write_new(path: pathlib.Path, content: bytes) -> None:
    """Root-only, never over an existing file, never through a link."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    with os.fdopen(fd, "wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def refuse_existing(root: pathlib.Path, names) -> None:
    for name in names:
        if (root / name).exists() or (root / name).is_symlink():
            raise SystemExit("The shared vault's files exist already; nothing was changed")


def write_all(root: pathlib.Path, files: dict) -> None:
    """Writes every file under a temporary name first and renames them into place only when all are
    written; on any failure it removes what it wrote, so the step can simply be run again."""
    refuse_existing(root, files)
    staged = []
    placed = []
    try:
        for name, content in files.items():
            temporary = root / (".incoming-" + name)
            if temporary.exists() or temporary.is_symlink():
                temporary.unlink()
            write_new(temporary, content)
            staged.append(temporary)
        for name in files:
            refuse_existing(root, [name])
            os.rename(root / (".incoming-" + name), root / name)
            placed.append(root / name)
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        for path in staged + placed:
            if path.exists() or path.is_symlink():
                path.unlink()
        raise


def remove(root: pathlib.Path, names) -> None:
    for name in names:
        if (root / name).exists() or (root / name).is_symlink():
            (root / name).unlink()


def read_file(path: pathlib.Path) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        return handle.read(MAX_FILE_BYTES + 1)


def master_keys(principal_key_id: str, master: bytes) -> bytes:
    document = {"schema": "qorpera.cloud-secret-master-keys/v1", "keys": [{"keyId": principal_key_id, "keyBase64url": b64url(master)}]}
    return (json.dumps(document) + "\n").encode("ascii")


def parse_master_keys(content: bytes) -> dict:
    document = json.loads(content)
    if (
        not isinstance(document, dict)
        or sorted(document) != ["keys", "schema"]
        or document["schema"] != "qorpera.cloud-secret-master-keys/v1"
        or not isinstance(document["keys"], list)
        or len(document["keys"]) != 1
    ):
        raise SystemExit("The shared vault master keys are malformed")
    entry = document["keys"][0]
    if not isinstance(entry, dict) or sorted(entry) != ["keyBase64url", "keyId"] or not isinstance(entry["keyId"], str) or not KEY_ID.fullmatch(entry["keyId"]):
        raise SystemExit("The shared vault master keys are malformed")
    return {"keyId": entry["keyId"], "key": unb64url(entry["keyBase64url"])}


def describe(files: dict) -> dict:
    """What may leave a host: the key id, the principal's capability hash and the files' fingerprints."""
    principal = unb64url(files[PRINCIPAL].decode("ascii").strip())
    master = parse_master_keys(files[MASTER_KEYS])
    fingerprints = {"principalSecret": fingerprint(principal), "masterKey": fingerprint(master["key"])}
    for name in PASSED_ON:
        if name in files:
            fingerprints[name] = fingerprint(files[name])
    return {
        "keyId": master["keyId"],
        "principalCapabilitySha256": principal_capability_sha256(principal),
        "fingerprints": fingerprints,
        "fingerprintsSha256": hashlib.sha256(json.dumps(fingerprints, sort_keys=True).encode("ascii")).hexdigest(),
    }


def held(root: pathlib.Path, complete: bool) -> dict:
    files = {PRINCIPAL: read_file(root / PRINCIPAL), MASTER_KEYS: read_file(root / MASTER_KEYS)}
    for name in PASSED_ON:
        path = root / name
        if path.exists() or path.is_symlink():
            files[name] = read_file(path)
        elif complete:
            raise SystemExit("A file the standby needs is missing: " + name)
    for name, content in files.items():
        if not 0 < len(content) <= MAX_FILE_BYTES:
            raise SystemExit("A shared vault file is empty or too large: " + name)
    return files


def generate(args: argparse.Namespace) -> dict:
    if not KEY_ID.fullmatch(args.key_id):
        raise SystemExit("The key id is malformed")
    root = root_of(args.root)
    make_root(root)
    write_all(root, {MASTER_KEYS: master_keys(args.key_id, os.urandom(32)), PRINCIPAL: (b64url(os.urandom(32)) + "\n").encode("ascii")})
    return {"passed": True, **describe(held(root, False))}


def helper_token(args: argparse.Namespace) -> dict:
    root = root_of(args.root)
    helper_root = root_of(args.helper_root)
    socket_path = pathlib.Path(args.socket_path)
    if not socket_path.is_absolute() or str(socket_path) != os.path.normpath(str(socket_path)):
        raise SystemExit("The helper socket path must be absolute")
    make_root(root)
    if not helper_root.is_dir():
        raise SystemExit("The login helper is not installed on this host")
    refuse_existing(root, [HELPER_CLIENT])
    refuse_existing(helper_root, [HELPER_TOKEN])
    value = b64url(os.urandom(32))
    client = {"schema": "qorpera.model-login-helper-client/v1", "socketPath": str(socket_path), "token": value}
    write_all(helper_root, {HELPER_TOKEN: (value + "\n").encode("ascii")})
    try:
        write_all(root, {HELPER_CLIENT: (json.dumps(client) + "\n").encode("ascii")})
    except BaseException:
        remove(helper_root, [HELPER_TOKEN])
        raise
    return {"passed": True, "helperToken": "written", "helperClient": "written"}


def ticket(args: argparse.Namespace) -> dict:
    root = root_of(args.root)
    make_root(root)
    # An unused ticket from a run that stopped early is node 2's own: replace it.
    remove(root, [TICKET])
    value = b64url(os.urandom(32))
    write_new(root / TICKET, value.encode("ascii"))
    return {"passed": True, "ticketSha256": hashlib.sha256(value.encode("ascii")).hexdigest()}


def serve(args: argparse.Namespace) -> dict:
    root = root_of(args.root)
    if not DIGEST.fullmatch(args.ticket_sha256):
        raise SystemExit("The ticket digest is malformed")
    files = held(root, True)
    summary = describe(files)
    body = json.dumps(
        {"schema": "qorpera.shared-vault-secrets/v2", "files": {name: b64url(content) for name, content in files.items()}}
    ).encode("ascii")
    state = {"served": False}

    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = REQUEST_TIMEOUT_S

        def do_GET(self) -> None:
            header = self.headers.get("Authorization", "")
            presented = header[len("Bearer ") :] if header.startswith("Bearer ") else ""
            if (
                state["served"]
                or self.client_address[0] != args.peer
                or self.path != ROUTE
                or not hmac.compare_digest(hashlib.sha256(presented.encode("ascii", "replace")).hexdigest(), args.ticket_sha256)
            ):
                self.send_error(404)
                return
            # Used up before anything is sent: a failed write does not leave the ticket working.
            state["served"] = True
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: object) -> None:
            pass

    class Server(http.server.HTTPServer):
        def verify_request(self, request, client_address) -> bool:
            # Any other address is closed before a byte of it is read.
            return client_address[0] == args.peer

    server = Server((args.bind, args.port), Handler)
    # Everything is read and the port is bound: serve as nobody.
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(NOBODY)
        os.setuid(NOBODY)
    server.timeout = 1
    deadline = time.monotonic() + args.ttl
    try:
        while not state["served"] and time.monotonic() < deadline:
            server.handle_request()
    finally:
        server.server_close()
    return {"passed": state["served"], "served": state["served"], "bind": args.bind, "peer": args.peer, "fingerprintsSha256": summary["fingerprintsSha256"]}


def fetch(args: argparse.Namespace) -> dict:
    root = root_of(args.root)
    ticket_path = root / TICKET
    try:
        presented = read_file(ticket_path).decode("ascii")
    finally:
        # One use, whatever happens next.
        if ticket_path.exists() or ticket_path.is_symlink():
            ticket_path.unlink()
    if not DIGEST.fullmatch(args.expect):
        raise SystemExit("The expected digest is malformed")
    names = (PRINCIPAL, MASTER_KEYS, *PASSED_ON)
    refuse_existing(root, names)
    if not SECRET.fullmatch(presented):
        raise SystemExit("The ticket is malformed")
    connection = http.client.HTTPConnection(args.source, args.port, timeout=15)
    connection.request("GET", ROUTE, headers={"Authorization": "Bearer " + presented})
    response = connection.getresponse()
    if response.status != 200:
        raise SystemExit("The shared vault's files were not handed over")
    raw = response.read(len(names) * MAX_FILE_BYTES * 2)
    connection.close()
    document = json.loads(raw)
    if (
        not isinstance(document, dict)
        or sorted(document) != ["files", "schema"]
        or document["schema"] != "qorpera.shared-vault-secrets/v2"
        or not isinstance(document["files"], dict)
        or sorted(document["files"]) != sorted(names)
    ):
        raise SystemExit("The shared vault's files are malformed")
    files = {}
    for name in names:
        encoded = document["files"][name]
        if not isinstance(encoded, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,22000}", encoded):
            raise SystemExit("The shared vault's files are malformed")
        files[name] = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if not 0 < len(files[name]) <= MAX_FILE_BYTES:
            raise SystemExit("The shared vault's files are malformed")
    summary = describe(files)
    if not hmac.compare_digest(summary["fingerprintsSha256"], args.expect):
        return {"passed": False, "match": "mismatch"}
    make_root(root)
    write_all(root, {name: files[name] for name in names})
    written = describe(held(root, True))
    if written["fingerprintsSha256"] != args.expect:
        # What arrived matched but what landed does not: take it all back.
        remove(root, names)
        return {"passed": False, "match": "mismatch"}
    return {"passed": True, "match": "match", **written}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=DEFAULT_ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("generate")
    make.add_argument("--key-id", required=True)
    commands.add_parser("fingerprint")
    commands.add_parser("ticket")
    helper = commands.add_parser("helper-token")
    helper.add_argument("--helper-root", default=DEFAULT_HELPER_ROOT)
    helper.add_argument("--socket-path", default=DEFAULT_HELPER_SOCKET)
    give = commands.add_parser("serve")
    give.add_argument("--bind", required=True)
    give.add_argument("--peer", required=True)
    give.add_argument("--port", type=int, required=True)
    give.add_argument("--ticket-sha256", required=True)
    give.add_argument("--ttl", type=int, default=120)
    take = commands.add_parser("fetch")
    take.add_argument("--source", required=True)
    take.add_argument("--port", type=int, required=True)
    take.add_argument("--expect", required=True)
    args = parser.parse_args()
    if args.command == "generate":
        result = generate(args)
    elif args.command == "fingerprint":
        result = {"passed": True, **describe(held(root_of(args.root), False))}
    elif args.command == "ticket":
        result = ticket(args)
    elif args.command == "helper-token":
        result = helper_token(args)
    elif args.command == "serve":
        result = serve(args)
    else:
        result = fetch(args)
    print(json.dumps(result))
    if not result["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
