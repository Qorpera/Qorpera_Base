// deploy/agent-exit: the installer pins, the connection logger's parsers and pause, the logs' tender and counts, their
// shipper to the NAS and the lookup, the agent plug's client map and reconciler (against a stand-in for LXD), and (on
// Linux with Docker) the root proof in
// test/proof.sh, run inside a privileged,
// network-less throwaway container that plays a node. Every namespace, bridge, link and rule it makes lives inside the
// container's own network namespaces. It never loads or unloads a kernel module itself (the kernel loads nftables'
// and the bridge's modules on demand and keeps them) and changes no sysctl of the machine's own namespace; the test
// checks that the machine's bridges are all still there afterwards. The one thing a proof must never do on a shared
// test machine is unload a module: `modprobe -r br_netfilter` also unloads `bridge`, which destroys every bridge on
// the machine (3 October, an E2b draft run bare on a test machine did that, not this proof).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logger = join(here, "qorpera-agent-exit-log.py");
const plugTool = join(here, "qorpera-agent-plug.py");
const logsTool = join(here, "qorpera-agent-exit-logs.py");
const namesTool = join(here, "qorpera-agent-exit-names.py");
// The deletion records of a log folder (lost/<name>.json), in the order they were written.
const lostRecords = (folder) =>
	(existsSync(join(folder, "lost")) ? readdirSync(join(folder, "lost")) : [])
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.map((name) => JSON.parse(readFileSync(join(folder, "lost", name), "utf8")))
		.sort((a, b) => a.recordedAt - b.recordedAt);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("the installer pins the files in this folder", () => {
	const installer = readFileSync(join(here, "install-agent-exit.sh"), "utf8");
	for (const [name, file] of [
		["TOOL", "qorpera-agent-exit.sh"],
		["EXIT_RULES", "qorpera-agent-exit.nft"],
		["HOST_RULES", "qorpera-agent-exit-host.nft"],
		["LOGGER", "qorpera-agent-exit-log.py"],
		["UNIT", "qorpera-agent-exit.service"],
		["DNS_UNIT", "qorpera-agent-exit-dns.service"],
		["LOG_UNIT", "qorpera-agent-exit-log.service"],
		["PLUG", "qorpera-agent-plug.py"],
		["PLUG_UNIT", "qorpera-agent-plug.service"],
		["BRIDGE_RULES", "qorpera-agent-exit-bridge.nft"],
		["HEALTH_UNIT", "qorpera-agent-exit-health.service"],
		["HEALTH_TIMER", "qorpera-agent-exit-health.timer"],
		["LOGS", "qorpera-agent-exit-logs.py"],
		["LOGS_UNIT", "qorpera-agent-exit-logs.service"],
		["LOGS_TIMER", "qorpera-agent-exit-logs.timer"],
		["SHIP_UNIT", "qorpera-agent-exit-ship.service"],
		["SHIP_TIMER", "qorpera-agent-exit-ship.timer"],
		["RULES_UNIT", "qorpera-agent-exit-rules.service"],
		["NAMES", "qorpera-agent-exit-names.py"],
		["NAMES_UNIT", "qorpera-agent-exit-names.service"],
		["RESOLVER_UNIT", "qorpera-agent-exit-resolver@.service"],
		["RULES_CA", "../cloud-secret-broker/supabase-prod-ca-2021.crt"],
	]) {
		assert.match(installer, new RegExp(`EXPECTED_${name}_SHA256="${sha256(readFileSync(join(here, file)))}"`), `${file} pin`);
	}
});

// E8b: the rollout script that makes the rules reader's login, against stand-ins for the Supabase API and the nodes'
// root helpers. No network, keychain or ssh.
describe("the rules reader's login (rules-reader-login.py)", () => {
	const loginTool = join(here, "rules-reader-login.py");
	const script = String.raw`
import base64, contextlib, hashlib, hmac, importlib.util, io, json, re, secrets, sys
spec = importlib.util.spec_from_file_location("login", sys.argv[1])
login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(login)
out = {"pattern": login.LOGIN_PATTERN}

def raises(f, *args):
    try:
        f(*args)
    except login.Stop:
        return True
    return False

def keys(verifier):
    m = re.fullmatch(r"SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)", verifier)
    return [base64.b64decode(part) for part in m.groups()]

# RFC 7677's example exchange (user "user", password "pencil"): a client with the password proves itself against the
# StoredKey, and the ServerKey signs as the server did.
salt, stored, server = keys(login.scram_verifier("pencil", base64.b64decode("W22ZaJ0SNY7soEsUEjb6gQ==")))
nonce = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
auth = ("n=user,r=rOprNGfwEbeRWgbNEkqO,r=" + nonce + ",s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=" + nonce).encode()
proof = base64.b64decode("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=")
client_key = bytes(a ^ b for a, b in zip(proof, hmac.new(stored, auth, hashlib.sha256).digest()))
signature = base64.b64decode("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
out["rfc"] = [hashlib.sha256(client_key).digest() == stored, hmac.new(server, auth, hashlib.sha256).digest() == signature]
out["set_login"] = [
    login.set_login(login.scram_verifier("p" * 43, secrets.token_bytes(16))).startswith(
        "alter role qorpera_agent_exit with login password 'SCRAM-SHA-256$4096:"),
    raises(login.set_login, "SCRAM-SHA-256$4096:x$y:z'; drop role postgres; --"),
]

host = "aws-0-eu-central-1.pooler.supabase.com"
urls = [login.login_url(host, secrets.token_urlsafe(32)) for _ in range(200)]
out["urls"] = urls[:3]
out["bad_host"] = raises(login.login_url, "pooler.example/x?", "p" * 43)

token = "sbp_" + "0123456789abcdef" * 2 + "01234567"
out["tokens"] = [
    login.cli_token(token.encode() + b"\n") == token,
    login.cli_token(b"go-keyring-base64:" + base64.b64encode(token.encode())) == token,
    login.cli_token(b"go-keyring-encoded:" + token.encode().hex().encode()) == token,
    raises(login.cli_token, b"not a token"),
    raises(login.cli_token, b"go-keyring-base64:" + base64.b64encode(b"sbp_short")),
]

entry = {"database_type": "PRIMARY", "db_host": host, "is_using_scram_auth": True, "db_port": 6543}
other = "aws-0-us-east-1.pooler.supabase.com"
out["pooler"] = [
    login.pooler_host([entry, dict(entry, database_type="READ_REPLICA", db_host=other)]) == host,
    login.pooler_host([entry, dict(entry, db_port=5432, pool_mode="session")]) == host,
    raises(login.pooler_host, []),
    raises(login.pooler_host, {"db_host": host}),
    raises(login.pooler_host, [entry, dict(entry, db_host=other)]),
    raises(login.pooler_host, [dict(entry, db_host=["x"])]),
    raises(login.pooler_host, [dict(entry, db_host="db." + login.REF + ".supabase.co")]),
    raises(login.pooler_host, [dict(entry, is_using_scram_auth=False)]),
]

good = {"login": False, "elevated": False, "alone": True, "reads": True, "lasting": True}
out["role"] = [
    login.role_state([good]) is False,
    login.role_state([dict(good, login=True)]) is True,
] + [raises(login.role_state, rows) for rows in (
    [], [good, good], [dict(good, elevated=True)], [dict(good, alone=False)], [dict(good, reads=False)],
    [dict(good, lasting=False)], [dict(good, login=None)], [dict(good, extra=1)],
)]

out["shown"] = login.shown(
    "qorpera-agent-exit: database-url: refused\nWarning: Permanently added\n"
    + '{"passed": false, "failureClass": "TimeoutError"}\nqorpera-agent-exit: s3cret\n\n', "s3cret")

def rollout(argv=(), fail=None):
    """The script's run against stand-in nodes and API; fail: (node, how) makes one step fail on one node."""
    calls, files, queries, state = [], {}, [], {"login": False}
    def helper(node, request, secret=None):
        argv = request.get("argv", [])
        how = fail[1] if fail and fail[0] == node[0] else None
        calls.append([node[0], request["action"]] + (argv[1:] if argv[:1] == [login.TOOL] else argv[:1]))
        if request["action"] == "status":
            return 0, json.dumps({"installed": True}), []
        if argv[0] == "/usr/bin/sha256sum":
            lines = [login.sha256_file(local) + "  " + path for path, local in login.INSTALLED]
            if how == "stale":
                lines[0] = "0" * 64 + "  " + login.TOOL
            return 0, "\n".join(lines + ["1" * 64 + "  " + login.PROGRAM]) + "\n", []
        if argv[0] == "/usr/bin/test":
            return 0, "", []
        if argv == [login.TOOL, "database-url"]:
            if how == "refused":
                return 1, "", login.shown("qorpera-agent-exit: database-url: refused\n" + request["stdin"] + "\n", secret)
            files[node[0]] = request["stdin"]
            data = (request["stdin"] + ("x" if how == "other" else "")).encode()
            return 0, "%s mode=400 owner=root:root bytes=%d sha256=%s\n" % (
                login.LOGIN_FILE, len(request["stdin"]), hashlib.sha256(data).hexdigest()), []
        if argv == [login.TOOL, "rules-start"]:
            if how == "unread":
                return 1, "", ["qorpera-agent-exit: the rules reader has not read the database in 30 s (problem 28P01)"]
            return 0, "qorpera-agent-exit: the rules reader read the database: ok\n", []
        raise AssertionError(argv)
    def api(token_, method, path, what, body=None):
        assert token_ == token
        if path == "/config/database/pooler":
            calls.append(["api", "pooler"])
            return [entry]
        queries.append(body)
        if body["query"] == login.ROLE_QUERY:
            calls.append(["api", "role"])
            return [dict(good, login=state["login"])]
        calls.append(["api", "set login"])
        state["login"] = True
        return []
    login.helper, login.api, login.keychain_token = helper, api, lambda: token
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        try:
            result = login.main(list(argv))
        except login.Stop as stop:
            result = str(stop)
    password = files["node01"].split(":")[2].split("@")[0] if "node01" in files else None
    said = printed.getvalue() + str(result) + json.dumps(calls) + json.dumps([q for q in queries if q["query"] != login.ROLE_QUERY])
    run = {"result": result, "printed": printed.getvalue().splitlines(), "calls": calls, "leaks": bool(password) and password in said}
    if files:
        run["urls"] = sorted(set(files.values()))
    if len(queries) > 1:
        salted = keys(re.fullmatch(r"alter role qorpera_agent_exit with login password '(.+)'", queries[1]["query"]).group(1))
        derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salted[0], 4096)
        run["verifies"] = hashlib.sha256(hmac.new(derived, b"Client Key", hashlib.sha256).digest()).digest() == salted[1]
        run["read_only"] = [q.get("read_only") for q in queries]
    return run

out["runs"] = {"check": rollout(["--check"]), "full": rollout()}
for name, how in (("node02", "stale"), ("node02", "refused"), ("node02", "other"), ("node01", "unread")):
    out["runs"][name + " " + how] = rollout(fail=(name, how))
print(json.dumps(out))
`;
	let out;
	before(() => {
		const r = spawnSync("python3", ["-c", script, loginTool], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		out = JSON.parse(r.stdout);
	});
	const checks = (node) => [
		[node, "status"],
		[node, "exec", "/usr/bin/sha256sum"],
		[node, "exec", "/usr/bin/test"],
	];

	test("its logins are the one form the exit's tool takes; its verifier is the one RFC 7677's exchange proves", () => {
		const tool = readFileSync(join(here, "qorpera-agent-exit.sh"), "utf8");
		const toolPattern = [...tool.matchAll(/^\tpattern\+?='([^']*)'$/gm)].map((match) => match[1]).join("");
		assert.equal(out.pattern, toolPattern);
		for (const url of out.urls) {
			assert.match(url, /^postgresql:\/\/qorpera_agent_exit\.phqlfrkcvstmxlebljcj:[A-Za-z0-9_-]{43}@/);
			assert.ok(url.endsWith("@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=verify-full"), url);
			const bash = spawnSync("bash", ["-c", `pattern='${toolPattern}'; [[ $1 =~ $pattern ]]`, "bash", url]);
			assert.equal(bash.status, 0, `the tool's pattern in bash refuses ${url}`);
		}
		assert.equal(out.bad_host, true);
		assert.deepEqual(out.rfc, [true, true]);
		assert.deepEqual(out.set_login, [true, true]);
	});

	test("the keychain's token, the pooler and the role are taken only as Supabase and migration 230000 make them", () => {
		assert.deepEqual(out.tokens, [true, true, true, true, true]);
		assert.deepEqual(out.pooler, Array(8).fill(true));
		assert.deepEqual(out.role, Array(10).fill(true));
		assert.deepEqual(out.shown, [
			"qorpera-agent-exit: database-url: refused",
			'{"passed": false, "failureClass": "TimeoutError"}',
			"(2 other lines not shown)",
		]);
	});

	test("a run checks, places the same new login on both nodes, sets its verifier, then starts the readers", () => {
		const check = out.runs.check;
		assert.equal(check.result, 0);
		assert.deepEqual(check.calls, [["api", "pooler"], ["api", "role"], ...checks("node01"), ...checks("node02")]);
		assert.deepEqual(check.printed, [
			"checked: the pooler, role qorpera_agent_exit (no login yet), node01, node02",
			"ok (nothing changed)",
		]);
		const full = out.runs.full;
		assert.equal(full.result, 0);
		assert.deepEqual(full.calls, [
			["api", "pooler"],
			["api", "role"],
			...checks("node01"),
			...checks("node02"),
			["node01", "exec", "database-url"],
			["node02", "exec", "database-url"],
			["api", "set login"],
			["api", "role"],
			["node01", "exec", "rules-start"],
			["node02", "exec", "rules-start"],
		]);
		assert.equal(full.urls.length, 1, "both nodes get the same login");
		const bytes = full.urls[0].length;
		assert.deepEqual(full.printed, [
			"checked: the pooler, role qorpera_agent_exit (no login yet), node01, node02",
			`node01: /etc/qorpera-agent-exit/database-url mode=400 owner=root:root bytes=${bytes}, sha256 matches`,
			`node02: /etc/qorpera-agent-exit/database-url mode=400 owner=root:root bytes=${bytes}, sha256 matches`,
			"node01: the rules reader read the database: ok",
			"node02: the rules reader read the database: ok",
			"ok",
		]);
		assert.equal(full.verifies, true, "the role gets the placed password's verifier");
		assert.deepEqual(full.read_only, [true, null, true], "only the login is set with a query that may write");
		assert.equal(full.leaks, false, "the password is in nothing printed and not in the query that sets the login");
	});

	test("a node not as this checkout, or a login not written as sent, stops the run before the role changes", () => {
		const stale = out.runs["node02 stale"];
		assert.equal(
			stale.result,
			"node02: /usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh is not this checkout's: install the exit from it first",
		);
		assert.deepEqual(stale.calls.at(-1), ["node02", "exec", "/usr/bin/sha256sum"]);
		assert.equal(stale.urls, undefined, "no login is made");
		const refused = out.runs["node02 refused"];
		assert.equal(
			refused.result,
			"node02: the login file was not written\nnode02:   qorpera-agent-exit: database-url: refused\nnode02:   (1 other lines not shown)",
		);
		assert.deepEqual(refused.calls.at(-1), ["node02", "exec", "database-url"]);
		assert.equal(refused.leaks, false, "a line holding the login is never shown");
		const other = out.runs["node02 other"];
		assert.equal(other.result, "node02: /etc/qorpera-agent-exit/database-url is not the login sent");
		assert.ok(!other.calls.some((call) => call[1] === "set login"));
		const unread = out.runs["node01 unread"];
		assert.equal(
			unread.result,
			"node01: the rules reader did not read the database with the new login\nnode01:   qorpera-agent-exit: the rules reader has not read the database in 30 s (problem 28P01)",
		);
		assert.equal(unread.leaks, false);
	});

	test("anything but --check or nothing prints the usage and exits 64, before the keychain", () => {
		const r = spawnSync("python3", [loginTool, "--now"], { encoding: "utf8" });
		assert.equal(r.status, 64);
		assert.match(r.stderr, /rules-reader-login\.py --check/);
		assert.equal(r.stdout, "");
	});
});

describe("the connection logger", () => {
	const run = (flag, input) => {
		const r = spawnSync("python3", [logger, flag], { input, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return r.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	};

	test("conntrack lines become records for agent connections only, with bytes each way", () => {
		const lines = [
			"[1790990000.123456]\t    [NEW] ipv4     2 tcp      6 120 SYN_SENT src=10.210.0.10 dst=1.1.1.1 sport=40000 dport=443 [UNREPLIED] src=1.1.1.1 dst=10.209.255.2 sport=443 dport=40000 id=77",
			"[1790990005.500000]\t[DESTROY] ipv4     2 tcp      6 src=10.210.0.10 dst=1.1.1.1 sport=40000 dport=443 packets=6 bytes=380 src=1.1.1.1 dst=10.209.255.2 sport=443 dport=40000 packets=4 bytes=232 [ASSURED] id=77",
			"[1790990006.000000]\t[DESTROY] ipv4     2 udp      17 src=10.209.255.2 dst=9.9.9.9 sport=5353 dport=53 packets=1 bytes=60 src=9.9.9.9 dst=10.209.255.2 sport=53 dport=5353 packets=1 bytes=76 id=78",
			"[1790990006.500000]\t    [NEW] ipv4     2 udp      17 30 src=10.210.0.1 dst=10.210.0.10 sport=67 dport=68 [UNREPLIED] src=10.210.0.10 dst=10.210.0.1 sport=68 dport=67 id=80",
			"[1790990007.000000]\t[DESTROY] ipv4     2 icmp     1 src=10.210.0.10 dst=1.1.1.1 type=8 code=0 id=4321 packets=1 bytes=84 src=1.1.1.1 dst=10.209.255.2 type=0 code=0 id=4321 packets=1 bytes=84 id=79",
			"conntrack v1.4.8 (conntrack-tools): 4 flow events have been shown.",
		].join("\n");
		assert.deepEqual(run("--parse-conntrack", lines), [
			{ ts: 1790990000.123456, event: "new", proto: "tcp", src: "10.210.0.10", dst: "1.1.1.1", sport: 40000, dport: 443, id: 77 },
			{
				ts: 1790990005.5,
				event: "destroy",
				proto: "tcp",
				src: "10.210.0.10",
				dst: "1.1.1.1",
				sport: 40000,
				dport: 443,
				packets_out: 6,
				bytes_out: 380,
				packets_in: 4,
				bytes_in: 232,
				id: 77,
			},
			{
				ts: 1790990007,
				event: "destroy",
				proto: "icmp",
				src: "10.210.0.10",
				dst: "1.1.1.1",
				packets_out: 1,
				bytes_out: 84,
				packets_in: 1,
				bytes_in: 84,
				id: 79,
			},
		]);
	});

	test("the refused-flow sets become one key per element, with the mark it was refused with, any protocol as text", () => {
		const set = (name, elem) => ({ set: { family: "inet", name, table: "qorpera_agent_exit", elem } });
		const flows = (elem) => JSON.stringify({ nftables: [{ metainfo: { version: "1.1.6" } }, set("refused_flows", elem)] });
		const other = (elem) => JSON.stringify({ nftables: [{ metainfo: { version: "1.1.6" } }, set("refused_other", elem)] });
		assert.deepEqual(
			run(
				"--parse-set",
				flows([
					{ elem: { val: { concat: ["10.210.0.10", "192.168.1.40", "tcp", 2049, 0] }, timeout: 3600, expires: 3590 } },
					{ concat: ["10.210.0.11", "1.1.1.1", "tcp", 443, 2147483652] },
					{ concat: ["10.210.0.11", "1.1.1.1", "udp", 443, "0x80000003"] },
					// A set from before E8c kept no mark.
					{ concat: ["10.210.0.11", "1.1.1.1", "tcp", 25] },
				]),
			),
			[
				[["10.210.0.10", "192.168.1.40", "tcp", 2049, 0], 3590],
				[["10.210.0.11", "1.1.1.1", "tcp", 443, 0x80000004], null],
				[["10.210.0.11", "1.1.1.1", "udp", 443, 0x80000003], null],
				[["10.210.0.11", "1.1.1.1", "tcp", 25, 0], null],
			],
		);
		assert.deepEqual(
			run(
				"--parse-set",
				other([
					{ elem: { val: { concat: ["10.210.0.10", "192.168.1.40", 253, 0] }, timeout: 3600, expires: 3500 } },
					{ concat: ["10.210.0.11", "1.1.1.1", "icmp", 2147483652] },
					{ concat: ["10.210.0.11", "1.1.1.1", "icmp"] },
				]),
			),
			[
				[["10.210.0.10", "192.168.1.40", "253", null, 0], 3500],
				[["10.210.0.11", "1.1.1.1", "icmp", null, 0x80000004], null],
				[["10.210.0.11", "1.1.1.1", "icmp", null, 0], null],
			],
		);
	});

	test("a refused flow is logged when new or added again, with the rule that refused it", () => {
		const nas = ["10.210.0.10", "192.168.1.40", "tcp", 2049, 0];
		const mail = ["10.210.0.10", "1.1.1.1", "tcp", 25, 0];
		const other = ["10.210.0.10", "192.168.1.40", "253", null, 0];
		const busy = ["10.210.0.11", "8.8.4.4", "tcp", 443, 0];
		const diff = run(
			"--diff-sets",
			JSON.stringify({
				previous: [
					[nas, 1200],
					[busy, 900],
				],
				current: [
					[nas, 1195],
					[mail, 3600],
					[other, 3600],
					[busy, 3599],
				],
			}),
		);
		assert.deepEqual(diff, [
			[mail, "mail"],
			[other, "our_networks"],
			[busy, "open_limit"],
		]);
	});

	// The logger reads no rules: a refusal is logged with the rule its mark says, also when the rules changed between the
	// refusal and the logger's read (the machine's company known since, or the address listed since).
	test("with E8c, a refusal says the rule it was refused by from its mark: rules not known, not listed", () => {
		const unknown = 0x80000003;
		const notListed = 0x80000004;
		const keys = [
			["10.210.1.1", "8.8.4.4", "tcp", 443, 0],
			["10.210.1.9", "8.8.4.4", "tcp", 443, unknown],
			["10.210.1.9", "8.8.4.4", "1", null, unknown],
			["10.210.1.2", "203.0.113.6", "tcp", 443, notListed],
			["10.210.1.2", "203.0.113.6", "tcp", 443, unknown],
			["10.210.1.2", "203.0.113.5", "udp", 443, notListed],
			["10.210.1.2", "203.0.113.5", "1", null, notListed],
			["10.210.1.2", "203.0.113.5", "tcp", 25, 0],
			["10.210.1.2", "192.168.1.40", "tcp", 443, 0],
		];
		const diff = run("--diff-sets", JSON.stringify({ previous: [], current: keys.map((key) => [key, 3600]) }));
		const rules = new Map(diff.map(([key, rule]) => [JSON.stringify(key), rule]));
		assert.deepEqual(
			keys.map((key) => rules.get(JSON.stringify(key))),
			// The same flow refused by two rules is two refusals.
			[
				"open_limit",
				"rules_unknown",
				"rules_unknown",
				"not_listed",
				"rules_unknown",
				"not_listed",
				"not_listed",
				"mail",
				"our_networks",
			],
		);
	});
});

test("the logger pauses past the logs' cap or under the disk's floor, and goes on only with room again", () => {
	const cap = 1000;
	const decide = (paused, freePercent, bytes) => {
		const r = spawnSync("python3", [logger, "--should-pause"], {
			input: JSON.stringify({ paused, freePercent, bytes, cap, floor: 10 }),
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	assert.equal(decide(false, 50, 999), false, "under both lines");
	assert.equal(decide(false, 50, 1001), true, "over the cap");
	assert.equal(decide(false, 9.9, 10), true, "under the floor");
	assert.equal(decide(true, 11, 10), true, "still within 2 points of the floor");
	assert.equal(decide(true, 50, 960), true, "still over 95% of the cap");
	assert.equal(decide(true, 12.5, 940), false, "room again");
});

test("the logger names refusals with the same private ranges the exit refuses", () => {
	const nft = readFileSync(join(here, "qorpera-agent-exit.nft"), "utf8");
	const set = /set internal4 \{[\s\S]*?elements = \{([\s\S]*?)\}/.exec(nft)[1];
	const exitRanges = set
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((range) => (range.includes("/") ? range : `${range}/32`))
		.sort();
	const py = readFileSync(logger, "utf8");
	const loggerRanges = [...py.slice(py.indexOf("INTERNAL = ["), py.indexOf("]\n", py.indexOf("INTERNAL = ["))).matchAll(/"([0-9./]+)"/g)]
		.map((m) => m[1])
		.sort();
	assert.deepEqual(loggerRanges, exitRanges);
});

const pythonUsable =
	spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"]).status === 0;

describe("the brake", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	const t0 = 1790990000;
	const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
	let dir;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-exit-brake-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const levels = (raw) => {
		const r = spawnSync("python3", [logger, "--brake-levels"], { input: JSON.stringify(raw), encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	// A state folder as the agent plug keeps it: each machine's entry, and verified/ for those it matched with LXD.
	const stateDir = (machines) => {
		const state = mkdtempSync(join(dir, "state-"));
		mkdirSync(join(state, "seen"));
		mkdirSync(join(state, "verified"));
		for (const [address, company, verified = true] of machines) {
			writeFileSync(join(state, "seen", address), JSON.stringify({ address, company }));
			if (verified) writeFileSync(join(state, "verified", address), "");
		}
		return state;
	};
	// The guard on a stand-in for the exit's rules; one answer per step with `step: true`.
	const guard = (state, raw, steps) => {
		const r = spawnSync("python3", [logger, "--guard-test", "--state-dir", state], {
			input: JSON.stringify({ levels: raw, steps }),
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		return r.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	};
	const opened = (src, n) => Array.from({ length: n }, (_, i) => ({ event: "new", src, dst: "1.1.1.1", proto: "tcp", sport: 40000 + i, dport: 443 }));
	const failed = (src, dst, extra = {}) => ({ event: "destroy", src, dst, proto: "tcp", packets_out: 1, bytes_out: 60, packets_in: 0, bytes_in: 0, ...extra });
	const off = { new10s: 0, failed60s: 0, slow10s: 50, minutes: 10, on: false };

	test("the levels: off until set, and any problem turns the brake off", () => {
		assert.deepEqual(levels({}), [off, []]);
		assert.deepEqual(levels({ new10s: "", failed60s: null }), [off, []]);
		assert.deepEqual(levels({ new10s: " 200 " }), [{ ...off, new10s: 200, on: true }, []]);
		assert.deepEqual(
			levels({ failed60s: "30", slow10s: "80", minutes: "5" }),
			[{ new10s: 0, failed60s: 30, slow10s: 80, minutes: 5, on: true }, []],
			"with no level for new connections the share may be anything",
		);
		assert.deepEqual(levels({ new10s: "100", slow10s: "100" }), [
			{ ...off, new10s: 100, slow10s: 100 },
			["QORPERA_AGENT_EXIT_BRAKE_SLOW_10S=100 is not under QORPERA_AGENT_EXIT_BRAKE_NEW_10S=100"],
		]);
		assert.deepEqual(levels({ new10s: "1e3", failed60s: "-1", slow10s: "0", minutes: "1441" }), [
			off,
			[
				"QORPERA_AGENT_EXIT_BRAKE_NEW_10S='1e3' is not a whole number from 0 to 1000000000",
				"QORPERA_AGENT_EXIT_BRAKE_FAILED_60S='-1' is not a whole number from 0 to 1000000000",
				"QORPERA_AGENT_EXIT_BRAKE_SLOW_10S='0' is not a whole number from 1 to 1000000000",
				"QORPERA_AGENT_EXIT_BRAKE_MINUTES='1441' is not a whole number from 1 to 1440",
			],
		]);
	});

	test("the braked map, the share chain and the counted sets read as nft -j lists them", () => {
		const table = { family: "inet", table: "qorpera_agent_exit" };
		const r = spawnSync("python3", [logger, "--parse-brake"], {
			input: JSON.stringify({
				map: {
					nftables: [
						{ metainfo: { version: "1.1.6" } },
						{
							map: {
								...table,
								name: "braked",
								type: "ipv4_addr",
								map: "mark",
								flags: ["timeout"],
								elem: [
									[{ elem: { val: "10.210.1.10", timeout: 62, expires: 58 } }, 1234567],
									[{ elem: { val: "10.210.1.11", timeout: 62, expires: 58 } }, "0x12d687"],
									["10.210.1.12", "77"],
								],
							},
						},
					],
				},
				chain: {
					nftables: [
						{ chain: { ...table, name: "share", handle: 9 } },
						{ rule: { ...table, chain: "share", handle: 40, comment: "slow 5", expr: [] } },
					],
				},
				set: {
					nftables: [
						{
							set: {
								...table,
								name: "dropped",
								type: "mark",
								elem: [
									{ elem: { val: 1234567, timeout: 3600, expires: 3500, counter: { packets: 40, bytes: 2400 } } },
									{ elem: { val: "0x4d", timeout: 3600, expires: 3000, counter: { packets: 3, bytes: 180 } } },
								],
							},
						},
					],
				},
			}),
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), {
			machines: { "10.210.1.10": 1234567, "10.210.1.11": 1234567, "10.210.1.12": 77 },
			share: ["slow 5"],
			counters: { 1234567: 40, 77: 3 },
		});
	});

	test("a company past the level for new connections is braked, longer while it goes on, and let go after", () => {
		const state = stateDir([
			["10.210.1.10", "c1"],
			["10.210.1.11", "c1"],
			["10.210.1.20", "c2", false],
			["10.210.1.30", "c3"],
		]);
		const reason = "6 new connections in 10 seconds (level 5)";
		const [started, held, ended] = guard(state, { new10s: "5", slow10s: "2", minutes: "1" }, [
			// Six new connections from one of c1's machines; nine from a machine the plug has not matched; three from c3.
			{ at: t0, see: [...opened("10.210.1.10", 6), ...opened("10.210.1.20", 9), ...opened("10.210.1.30", 3)], step: true },
			// Ten new connections dropped, three of them let through later on a resend: seven more, past the level again.
			{ at: t0 + 30, dropped: { c1: 10 }, resent: { c1: 3 }, step: true },
			{ at: t0 + 95, step: true },
		]);
		assert.deepEqual(started.lines, [{ ts: t0, event: "braked", company: "c1", reason, until: t0 + 60, slow10s: 2 }]);
		assert.deepEqual(started.share, ["slow 2"]);
		assert.deepEqual(started.braked, { "10.210.1.10": "c1", "10.210.1.11": "c1" }, "every machine of c1, and no other");
		assert.deepEqual(started.ends, { "10.210.1.10": 62, "10.210.1.11": 62 }, "the brake ends in the exit also without the guard");
		assert.deepEqual(started.status, {
			schema: "qorpera.agent-exit-brake/v1",
			at: iso(t0),
			on: true,
			levels: { new10s: 5, failed60s: 0, slow10s: 2, minutes: 1 },
			braked: [{ company: "c1", number: "c1", since: t0, until: t0 + 60, reason, dropped: 0, machines: 2 }],
			problems: [],
		});
		assert.deepEqual(held.lines, [], "a brake that goes on writes no second line");
		assert.deepEqual([held.status.braked[0].until, held.status.braked[0].dropped], [t0 + 90, 7]);
		assert.deepEqual(held.ends, { "10.210.1.10": 62, "10.210.1.11": 62 }, "the exit's timeouts move with it");
		assert.deepEqual(ended.lines, [{ ts: t0 + 95, event: "unbraked", company: "c1", since: t0, dropped: 7 }]);
		assert.deepEqual([ended.braked, ended.ends, ended.status.braked], [{}, {}, []]);
		assert.deepEqual(ended.share, ["slow 2"], "the share rule stays while the brake is on");
	});

	test("a company past the level for failed destinations in a minute is braked", () => {
		const state = stateDir([["10.210.1.30", "c3"]]);
		const [under, past] = guard(state, { failed60s: "3" }, [
			{
				at: t0 + 120,
				see: [
					failed("10.210.1.30", "1.1.1.1"),
					failed("10.210.1.30", "1.1.1.1"),
					failed("10.210.1.30", "3.3.3.3", { packets_in: 5, bytes_in: 900 }),
					{ event: "refused", src: "10.210.1.30", dst: "2.2.2.2", proto: "tcp", dport: 25, rule: "mail" },
					failed("10.210.1.30", "4.4.4.4"),
				],
				step: true,
			},
			{ at: t0 + 125, see: [{ event: "refused", src: "10.210.1.30", dst: "5.5.5.5", proto: "tcp", dport: 25, rule: "mail" }], step: true },
		]);
		assert.deepEqual(under.lines, [], "three failed destinations: one counted once, an answered one not at all");
		assert.deepEqual(under.share, ["slow 50"]);
		assert.deepEqual(past.lines, [
			{ ts: t0 + 125, event: "braked", company: "c3", reason: "more than 3 failed destinations in a minute", until: t0 + 725, slow10s: 50 },
		]);
		assert.deepEqual(past.braked, { "10.210.1.30": "c3" });
	});

	test("a failed write or read is a problem in the status; the rules are written again, and a restart keeps the brake", () => {
		const state = stateDir([["10.210.1.10", "c1"]]);
		const reason = "6 new connections in 10 seconds (level 5)";
		const [started, unwritten, rewritten, unread, restarted] = guard(state, { new10s: "5", slow10s: "2", minutes: "1" }, [
			{ at: t0, see: opened("10.210.1.10", 6), step: true },
			// The rules loaded again (empty), and the guard's write fails.
			{ at: t0 + 2, reload: true, fail: "write", step: true },
			{ at: t0 + 4, fail: null, step: true },
			{ at: t0 + 6, fail: "read", step: true },
			{ at: t0 + 8, fail: null, restart: true, step: true },
		]);
		assert.equal(started.lines.length, 1);
		assert.deepEqual(unwritten.status.problems, ["cannot write the brake's rules: Error: Could not process rule"]);
		assert.deepEqual([unwritten.share, unwritten.braked], [[], {}]);
		assert.deepEqual([rewritten.share, rewritten.braked, rewritten.ends], [["slow 2"], { "10.210.1.10": "c1" }, { "10.210.1.10": 58 }]);
		assert.deepEqual(rewritten.status.problems, []);
		assert.deepEqual(unread.status.problems, ["cannot read the brake's rules: Error: No such file or directory"]);
		assert.equal(unread.status.braked.length, 1, "a brake goes on while the rules cannot be read");
		assert.deepEqual(restarted.lines, [], "a new logger takes the brake over from its status file, with no new line");
		assert.deepEqual(restarted.status.braked, [{ company: "c1", number: "c1", since: t0, until: t0 + 60, reason, dropped: 0, machines: 1 }]);
		assert.deepEqual([restarted.braked, restarted.ends], [{ "10.210.1.10": "c1" }, { "10.210.1.10": 54 }]);

		// The brake turned off (here a level that is not a number) ends every brake at once, and counts nothing.
		const [stopped] = guard(state, { new10s: "x" }, [{ at: t0 + 10, see: opened("10.210.1.10", 20), step: true }]);
		assert.deepEqual(stopped.lines, [{ ts: t0 + 10, event: "unbraked", company: "c1", since: t0, dropped: 0 }]);
		assert.deepEqual([stopped.share, stopped.braked, stopped.status.on, stopped.status.braked], [[], {}, false, []]);
		assert.deepEqual(stopped.status.problems, ["QORPERA_AGENT_EXIT_BRAKE_NEW_10S='x' is not a whole number from 0 to 1000000000"]);
	});
});

describe("the agent plug", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	let dir;
	let state;
	let run;
	let log;
	let lxd;
	let flushes;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-plug-"));
		state = join(dir, "state");
		run = join(dir, "run");
		log = join(dir, "log");
		for (const sub of ["clients", "dhcp-hosts", "quarantine", "seen", "verified"]) mkdirSync(join(state, sub), { recursive: true });
		mkdirSync(run);
		lxd = join(dir, "lxd.json");
		flushes = join(dir, "flushes");
		writeFileSync(lxd, "[]");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const dirs = () => ["--state-dir", state, "--run-dir", run, "--log-dir", log];
	// Creators run with UMask=0077; plug must still leave files dnsmasq can read.
	const plug = (...args) =>
		spawnSync("sh", ["-c", 'umask 077; exec python3 "$@"', "sh", plugTool, "plug", ...dirs(), ...args], { encoding: "utf8" });
	const plugged = (...args) => {
		const r = plug(...args);
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	const reconcile = () => {
		const r = spawnSync(
			"python3",
			[plugTool, "reconcile", "--once", ...dirs(), "--lxd-fixture", lxd, "--reload-dns", "true", "--flush-log", flushes],
			{ encoding: "utf8", env: { ...process.env, QORPERA_AGENT_PLUG_NFT: "0" } },
		);
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(readFileSync(join(run, "plug.json"), "utf8"));
	};
	const entry = (address) => JSON.parse(readFileSync(join(state, "clients", `${address}.json`), "utf8"));
	const has = (sub, name) => existsSync(join(state, sub, name));
	const machine = (e, { status = "Running", company = e.company, nic = {} } = {}) => ({
		name: e.instance,
		project: e.project,
		status,
		expanded_config: {
			"user.qorpera.company_id": company,
			[e.kind === "office" ? "user.qorpera.office_id" : "user.qorpera.machine_id"]: e.machine,
			...(e.member ? { "user.qorpera.member_user_id": e.member } : {}),
		},
		expanded_devices: {
			agent: {
				type: "nic",
				nictype: "bridged",
				parent: "qagent0",
				name: "eth1",
				hwaddr: e.hwaddr,
				"ipv6.address": "none",
				"security.mac_filtering": "true",
				"security.ipv6_filtering": "true",
				"security.port_isolation": "true",
				...nic,
			},
		},
	});
	const lxdHas = (...machines) => writeFileSync(lxd, JSON.stringify(machines));
	const history = () =>
		readdirSync(log)
			.filter((name) => name.startsWith("clients-"))
			.flatMap((name) => readFileSync(join(log, name), "utf8").trim().split("\n"))
			.map((line) => JSON.parse(line));
	const flushed = () => (existsSync(flushes) ? readFileSync(flushes, "utf8").trim().split("\n") : []);
	const vm1 = ["--kind", "coding", "--company", "c1", "--machine", "m1", "--member", "u1", "--project", "qp", "--instance", "vm1"];

	test("plug gives the lowest free address outside the exit's /24, with its MAC and a lease dnsmasq can read", () => {
		const first = plugged(...vm1);
		assert.deepEqual(first, { address: "10.210.1.1", hwaddr: "0e:51:0a:d2:01:01" });
		assert.deepEqual(plugged(...vm1), first, "the same again for the same machine");
		const lease = join(state, "dhcp-hosts", "10.210.1.1");
		assert.equal(readFileSync(lease, "utf8"), "0e:51:0a:d2:01:01,10.210.1.1\n");
		assert.equal(statSync(lease).mode & 0o777, 0o644, "readable by dnsmasq under the creator's umask 077");
		assert.equal(statSync(join(state, "clients", "10.210.1.1.json")).mode & 0o777, 0o644);
		const e = entry("10.210.1.1");
		assert.deepEqual(
			{ ...e, since: undefined },
			{
				schema: "qorpera.agent-plug/v1",
				address: "10.210.1.1",
				hwaddr: "0e:51:0a:d2:01:01",
				kind: "coding",
				company: "c1",
				machine: "m1",
				member: "u1",
				project: "qp",
				instance: "vm1",
				since: undefined,
			},
		);
		assert.match(e.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		const other = plug("--kind", "machine", "--company", "c2", "--machine", "m2", "--project", "qp", "--instance", "vm1");
		assert.equal(other.status, 1);
		assert.match(other.stderr, /qp\/vm1 is already plugged in for another machine \(10\.210\.1\.1\)/);
		assert.deepEqual(readdirSync(join(state, "dhcp-hosts")), ["10.210.1.1"], "no temporary file left behind");
	});

	test("plug refuses unknown kinds, a member on anything but a coding machine, and names that are not ids", () => {
		for (const [args, message] of [
			[["--kind", "laptop", "--company", "c", "--machine", "m", "--project", "qp", "--instance", "x"], /kind must be/],
			[["--kind", "coding", "--company", "c", "--machine", "m", "--project", "qp", "--instance", "x"], /names its member/],
			[["--kind", "machine", "--company", "c", "--machine", "m", "--member", "u", "--project", "qp", "--instance", "x"], /names its member/],
			[["--kind", "machine", "--company", "c/1", "--machine", "m", "--project", "qp", "--instance", "x"], /company is not an id/],
			[["--kind", "machine", "--company", "c", "--machine", "m", "--project", "qp", "--instance", "a_b"], /instance is not an LXD name/],
		]) {
			const r = plug(...args);
			assert.notEqual(r.status, 0, args.join(" "));
			assert.match(r.stderr, message);
		}
	});

	test("plugs at once never share an address, and a quarantined address is skipped until it expires", async () => {
		const results = await Promise.all(
			Array.from(
				{ length: 12 },
				(_, i) =>
					new Promise((resolve) => {
						const child = spawn("python3", [
							plugTool,
							"plug",
							...dirs(),
							...["--kind", "machine", "--company", "c", "--machine", `race${i}`, "--project", "qp", "--instance", `race${i}`],
						]);
						let out = "";
						child.stdout.on("data", (chunk) => {
							out += chunk;
						});
						child.on("close", (code) => resolve({ code, out }));
					}),
			),
		);
		assert.ok(results.every((r) => r.code === 0));
		assert.equal(new Set(results.map((r) => JSON.parse(r.out).address)).size, 12);
		const until = (seconds) => JSON.stringify({ until: Date.now() / 1000 + seconds });
		writeFileSync(join(state, "quarantine", "10.210.1.14"), until(900));
		writeFileSync(join(state, "quarantine", "10.210.1.15"), until(-1));
		const office = ["--kind", "office", "--company", "c3", "--machine", "o3", "--project", "qp", "--instance", "vm3"];
		assert.equal(plugged(...office).address, "10.210.1.15");
	});

	test("an entry is attributed only once LXD backs it; a forged one is a problem and a mismatch line, never plugged", () => {
		const e = entry("10.210.1.1");
		const office = entry("10.210.1.15");
		// vm1's entry says company c1, LXD says c9: a forged (or wrong) claim.
		lxdHas(
			machine(e, { company: "c9" }),
			machine(office, { nic: { "security.ipv4_filtering": "true" } }),
			{ name: "stray", project: "qp", status: "Stopped", expanded_config: {}, expanded_devices: { eth0: { type: "nic", parent: "qagent0", hwaddr: "0e:51:0a:d2:09:09" } } },
			{ name: "other", project: "qp", status: "Running", expanded_config: {}, expanded_devices: { eth0: { type: "nic", network: "qorpera0" } } },
		);
		const status = reconcile();
		assert.deepEqual(
			status.problems.filter((p) => !p.includes("is running, but its network card")),
			[
				"qp/stray is on qagent0 without a client map entry",
				"qp/vm1 (10.210.1.1): user.qorpera.company_id is 'c9', not 'c1'",
				"qp/vm3 (10.210.1.15): its card has LXD's IPv4 filter on, which drops its DHCP requests",
			],
		);
		assert.equal(status.problems.filter((p) => p.includes("is not a port of qagent0")).length, 2, "running, no such port");
		reconcile();
		const lines = history();
		assert.deepEqual(
			lines.map((r) => [r.event, r.address ?? r.instance]),
			[
				["unattributed", "stray"],
				["mismatch", "10.210.1.1"],
				["mismatch", "10.210.1.15"],
			],
			"each finding once, nothing plugged",
		);
		const forged = lines.find((r) => r.event === "mismatch" && r.address === "10.210.1.1");
		assert.equal(forged.company, "c1");
		assert.equal(forged.lxd["user.qorpera.company_id"], "c9");
		assert.deepEqual(lines[0].cards, [{ hwaddr: "0e:51:0a:d2:09:09", "ipv4.address": null }]);
		assert.ok(!has("verified", "10.210.1.1"));
	});

	test("a sleeping machine keeps its address and is flushed once; a machine missing twice is quarantined, then unplugged", () => {
		const e = entry("10.210.1.1");
		const office = entry("10.210.1.15");
		lxdHas(machine(e, { status: "Stopped" }), machine(office, { status: "Stopped" }));
		assert.deepEqual(reconcile().problems, []);
		reconcile();
		assert.deepEqual(flushed().sort(), ["10.210.1.1", "10.210.1.15"], "flushed once per sleep");
		const plugs = history().filter((r) => r.event === "plugged");
		assert.deepEqual(plugs.map((r) => r.address).sort(), ["10.210.1.1", "10.210.1.15"], "attributed once it matches");
		assert.equal(plugs.find((r) => r.address === "10.210.1.1").ts, Date.parse(e.since) / 1000, "from the entry's time");
		lxdHas(machine(office, { status: "Stopped" }));
		reconcile();
		assert.ok(has("clients", "10.210.1.1.json"), "one read without the machine unplugs nothing");
		reconcile();
		assert.ok(!has("clients", "10.210.1.1.json"));
		assert.ok(!has("dhcp-hosts", "10.210.1.1"));
		assert.ok(!has("seen", "10.210.1.1"));
		const quarantine = JSON.parse(readFileSync(join(state, "quarantine", "10.210.1.1"), "utf8"));
		assert.equal(quarantine.reason, "the machine is gone");
		assert.ok(quarantine.until > Date.now() / 1000 + 890);
		assert.equal(flushed().filter((a) => a === "10.210.1.1").length, 2, "flushed again when unplugged");
		const gone = history().filter((r) => r.address === "10.210.1.1");
		assert.deepEqual(gone.map((r) => r.event), ["mismatch", "plugged", "unplugged"]);
		assert.notEqual(plugged(...vm1).address, "10.210.1.1", "a quarantined address is not given out again");
	});

	test("a machine made again gets its entry back with a new time and is not unplugged in between", () => {
		const office = entry("10.210.1.15");
		lxdHas(machine(office));
		reconcile();
		const office3 = ["--kind", "office", "--company", "c3", "--machine", "o3", "--project", "qp", "--instance", "vm3"];
		// The creator deletes vm3 and plugs it again before it makes it again.
		lxdHas();
		const again = plugged(...office3);
		assert.equal(again.address, "10.210.1.15");
		assert.notEqual(entry("10.210.1.15").since, office.since);
		reconcile();
		reconcile();
		assert.ok(has("clients", "10.210.1.15.json"), "the new machine's entry stays while it is being made");
		lxdHas(machine(entry("10.210.1.15")));
		assert.deepEqual(reconcile().problems.filter((p) => !p.includes("is not a port")), []);
		assert.equal(JSON.parse(readFileSync(join(state, "seen", "10.210.1.15"), "utf8")).since, entry("10.210.1.15").since);
	});

	test("an entry removed by hand is unplugged from the reconciler's copy; its address stays held until then", () => {
		lxdHas(machine(entry("10.210.1.15")));
		reconcile();
		rmSync(join(state, "clients", "10.210.1.15.json"));
		const held = plugged("--kind", "machine", "--company", "c4", "--machine", "m4", "--project", "qp", "--instance", "vm4");
		assert.notEqual(held.address, "10.210.1.15", "a seen address is never given to another machine");
		reconcile();
		assert.ok(!has("seen", "10.210.1.15"));
		assert.ok(has("quarantine", "10.210.1.15"));
		const last = history().filter((r) => r.address === "10.210.1.15").at(-1);
		assert.equal(last.event, "unplugged");
		assert.equal(last.reason, "its entry was removed by hand");
	});

	test("a plug repeated for a machine never seen gives it a new hour: a create retried late is not dropped", () => {
		lxdHas();
		const late = ["--kind", "machine", "--company", "c9", "--machine", "m9", "--project", "qp", "--instance", "late"];
		const first = plugged(...late);
		const path = join(state, "clients", `${first.address}.json`);
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), since: "2000-01-01T00:00:00Z" }));
		assert.deepEqual(plugged(...late), first, "the same address and MAC");
		assert.ok(Date.now() / 1000 - Date.parse(entry(first.address).since) / 1000 < 60, "a new time");
		reconcile();
		assert.ok(existsSync(path), "not given up: its hour starts again");
	});

	test("a plug whose machine never appears is given up after an hour as dropped; expired quarantines are cleared", () => {
		lxdHas();
		const pending = readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json"));
		assert.ok(pending.length > 0);
		reconcile();
		assert.equal(readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json")).length, pending.length, "not yet an hour");
		for (const name of pending) {
			const path = join(state, "clients", name);
			writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), since: "2000-01-01T00:00:00Z" }));
		}
		writeFileSync(join(state, "quarantine", "10.210.1.200"), JSON.stringify({ until: 1 }));
		reconcile();
		assert.deepEqual(readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json")), []);
		assert.ok(!has("quarantine", "10.210.1.200"));
		const lines = history().filter((r) => pending.includes(`${r.address}.json`) && r.event !== "mismatch");
		assert.ok(lines.length >= pending.length);
		for (const name of pending) {
			const mine = lines.filter((r) => `${r.address}.json` === name);
			assert.equal(mine.at(-1).event, "dropped", `${name}: never matched, never attributed`);
			assert.equal(mine.at(-1).reason, "the machine was never created");
		}
	});

	test("unusable entries and links are problems, never followed; LXD unreadable changes nothing", () => {
		const forgedKind = { schema: "qorpera.agent-plug/v1", address: "10.210.1.99", hwaddr: "0e:51:0a:d2:01:63" };
		writeFileSync(join(state, "clients", "10.210.1.99.json"), JSON.stringify({ ...forgedKind, kind: "laptop" }));
		writeFileSync(join(state, "clients", "10.210.1.98.json"), JSON.stringify({ ...forgedKind, address: "10.210.1.98" }));
		writeFileSync(join(state, "clients", "10.210.0.7.json"), "{}");
		const later = { ...forgedKind, address: "10.210.1.96", hwaddr: "0e:51:0a:d2:01:60", kind: "machine" };
		writeFileSync(join(state, "clients", "10.210.1.96.json"), JSON.stringify({ ...later, company: "c", machine: "m", project: "qp", instance: "x", since: "2100-01-01T00:00:00Z" }));
		writeFileSync(join(state, "clients", "10.210.1.255.json"), JSON.stringify({ ...forgedKind, address: "10.210.1.255", hwaddr: "0e:51:0a:d2:01:ff" }));
		writeFileSync(join(state, "clients", "10.210.1.95.json"), `${"[".repeat(30000)}${"]".repeat(30000)}`);
		symlinkSync("/etc/passwd", join(state, "clients", "10.210.1.97.json"));
		symlinkSync("/etc/passwd", join(state, "dhcp-hosts", "10.210.1.97"));
		writeFileSync(lxd, "not json");
		const before = readdirSync(join(state, "clients")).sort();
		const status = reconcile();
		assert.match(status.problems[0], /^cannot read LXD/);
		assert.deepEqual(readdirSync(join(state, "clients")).sort(), before);
		lxdHas();
		const problems = reconcile().problems.join("\n");
		assert.match(problems, /unreadable client map entry 10\.210\.1\.99\.json: unknown kind/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.98\.json: the MAC is not the address's/);
		assert.match(problems, /unreadable client map entry 10\.210\.0\.7\.json: unknown schema/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.97\.json: .*(Too many levels|symbolic link)/i);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.96\.json: since is in the future/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.255\.json: the address is a \.0 or \.255 host/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.95\.json:/, "a deep nesting is a problem, not a crash");
		for (const name of ["10.210.1.99.json", "10.210.1.98.json", "10.210.0.7.json", "10.210.1.97.json", "10.210.1.96.json", "10.210.1.255.json", "10.210.1.95.json"]) {
			rmSync(join(state, "clients", name));
		}
		rmSync(join(state, "dhcp-hosts", "10.210.1.97"));
	});

	test("the bridge rules hold only entries LXD backed: the pairs, and one DHCP rule per machine naming its own MAC", () => {
		const fresh = plugged("--kind", "machine", "--company", "c5", "--machine", "m5", "--project", "qp", "--instance", "vm5");
		const statements = () => {
			const r = spawnSync("python3", [plugTool, "elements", ...dirs()], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
			return r.stdout.trim().split("\n").filter(Boolean);
		};
		assert.deepEqual(statements(), [], "a plug LXD has not backed yet gets nothing");
		lxdHas(machine(entry(fresh.address)));
		reconcile();
		const hex = fresh.hwaddr.replaceAll(":", "");
		assert.deepEqual(statements(), [
			`add element bridge qorpera_agent_exit_bridge clients { ${fresh.hwaddr} . ${fresh.address} }`,
			`insert rule bridge qorpera_agent_exit_bridge dhcp ether saddr ${fresh.hwaddr} ip saddr { 0.0.0.0, ${fresh.address} } @th,256,32 0 @th,288,48 0x${hex} accept comment "${fresh.address}"`,
		]);
	});

	test("ports: a machine's own while LXD has its card (not stopped), never the exit's links; a missed read keeps it once", () => {
		const script = String.raw`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("plug", sys.argv[1])
plug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plug)
root = sys.argv[2]
paths = plug.Paths(os.path.join(root, "state"), os.path.join(root, "run"), os.path.join(root, "log"))
for d in (paths.clients, paths.dhcp, *paths.root_dirs()):
    os.makedirs(d, exist_ok=True)
def card(port, status="Running", **nic):
    device = dict(plug.PLUG_NIC, hwaddr="0e:51:0a:d2:02:01", **nic)
    config = {"user.qorpera.company_id": "c", "user.qorpera.machine_id": "m", "volatile.eth0.host_name": port}
    return {"name": "m", "project": "qp", "status": status, "expanded_config": config, "expanded_devices": {"eth0": device}}
out = {"statuses": {s: plug.host_port(card("tap1a2b", s)) for s in ("Running", "Ready", "Frozen", "Error", "Stopped")},
       "names": {n: plug.host_port(card(n)) for n in ("qx-br", "qx-up", "qagent0", "bad name!", "veth9f8e7d6c")}}
entry = {"schema": "qorpera.agent-plug/v1", "address": "10.210.2.1", "hwaddr": "0e:51:0a:d2:02:01", "kind": "machine",
         "company": "c", "machine": "m", "member": None, "project": "qp", "instance": "m", "since": "2026-10-03T00:00:00Z"}
entries = {"10.210.2.1": entry}
loaded = {("tapold", "0e:51:0a:d2:02:01")}
open(os.path.join(paths.verified, "10.210.2.1"), "w").write("x")
out["running"] = sorted(plug.backed(paths, entries, [card("tapnew")], loaded)[1])
out["mismatch"] = sorted(plug.backed(paths, entries, [card("tapnew", **{"security.port_isolation": "false"})], loaded)[0])
out["absent"] = sorted(plug.backed(paths, entries, [], loaded)[1])
open(os.path.join(paths.missing, "10.210.2.1"), "w").write("x")
open(os.path.join(paths.seen, "10.210.2.1"), "w").write(json.dumps(entry))
out["first_miss"] = sorted(plug.backed(paths, entries, [], loaded)[1])
open(os.path.join(paths.seen, "10.210.2.1"), "w").write(json.dumps(dict(entry, since="2026-10-02T00:00:00Z")))
out["made_again"] = sorted(plug.backed(paths, entries, [], loaded)[1])
print(json.dumps(out))
`;
		const root = mkdtempSync(join(tmpdir(), "agent-plug-ports-"));
		const r = spawnSync("python3", ["-c", script, plugTool, root], { encoding: "utf8" });
		rmSync(root, { recursive: true, force: true });
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out.statuses, { Running: "tap1a2b", Ready: "tap1a2b", Frozen: "tap1a2b", Error: "tap1a2b", Stopped: null });
		assert.deepEqual(out.names, { "qx-br": null, "qx-up": null, qagent0: null, "bad name!": null, veth9f8e7d6c: "veth9f8e7d6c" });
		assert.deepEqual(out.running, [["tapnew", "0e:51:0a:d2:02:01"]], "a running machine's own port, never the loaded one");
		assert.deepEqual(out.mismatch, [], "a machine LXD no longer backs gets nothing");
		assert.deepEqual(out.absent, [], "missing, and not yet once: no port");
		assert.deepEqual(out.first_miss, [["tapold", "0e:51:0a:d2:02:01"]], "the first missed read keeps the loaded port");
		assert.deepEqual(out.made_again, [], "a machine being made again does not keep the old one's port");
	});

	test("a stale temporary folder in a creators' folder is a problem, never a crash", () => {
		const folder = join(state, "clients", ".tmp-left");
		mkdirSync(folder);
		const old = new Date(Date.now() - 3600_000);
		utimesSync(folder, old, old);
		lxdHas();
		assert.ok(reconcile().problems.some((p) => p.includes("clients/.tmp-left is a folder")));
		rmSync(folder, { recursive: true });
	});

	test("conntrack lines from the exit become the node's twins: masqueraded TCP, UDP and ICMP only", () => {
		const lines = [
			"tcp      6 431999 ESTABLISHED src=10.210.1.2 dst=1.1.1.1 sport=40000 dport=443 src=1.1.1.1 dst=10.209.255.2 sport=443 dport=61000 [ASSURED] mark=0 use=1",
			"udp      17 25 src=10.210.1.2 dst=9.9.9.9 sport=5353 dport=53 src=10.210.0.1 dst=10.210.1.2 sport=53 dport=5353 mark=0 use=1",
			"udp      17 25 src=10.210.1.2 dst=8.8.4.4 sport=5000 dport=3478 src=8.8.4.4 dst=10.209.255.2 sport=3478 dport=5001 mark=0 use=1",
			"icmp     1 29 src=10.210.1.2 dst=1.1.1.1 type=8 code=0 id=7 src=1.1.1.1 dst=10.209.255.2 type=0 code=0 id=9 mark=0 use=1",
			"unknown  253 599 src=10.210.1.2 dst=1.1.1.1 src=1.1.1.1 dst=10.209.255.2 mark=0 use=1",
		].join("\n");
		const r = spawnSync("python3", [plugTool, "--parse-conntrack"], { input: lines, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(
			r.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
			[
				["tcp", "1.1.1.1", "443", "61000"],
				["udp", "8.8.4.4", "3478", "5001"],
				["icmp", "1.1.1.1", null, "9"],
			],
		);
	});
});

// E8b: each company's names. The reconciler runs in this process against a stand-in for systemd, ss, nft and conntrack in
// the exit, with a clock of its own. The proof (test/proof.sh) runs it against the real ones.
describe("each company's names", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	const prelude = String.raw`
import importlib.util, json, os, sys, types
root = sys.argv[2]
spec = importlib.util.spec_from_file_location("names", sys.argv[1])
names = importlib.util.module_from_spec(spec)
spec.loader.exec_module(names)
plug = names.plug
clock = [1790000000.0]
names.time = types.SimpleNamespace(time=lambda: clock[0], sleep=lambda _: None)
state, run = os.path.join(root, "state"), os.path.join(root, "run")
for d in ("seen", "verified", "rules"):
    os.makedirs(os.path.join(state, d), exist_ok=True)
os.makedirs(run, exist_ok=True)
rules_path, status_path = os.path.join(state, "rules", "rules.json"), os.path.join(root, "rules-status.json")
args = types.SimpleNamespace(state_dir=state, run_dir=run, rules=rules_path, rules_status=status_path, netns="qexit",
                             upstreams="9.9.9.9 1.1.1.1#5353")
world = {"units": {}, "listening": set(), "map": {}, "set": set(), "table": 1, "calls": [], "flushed": [], "wrote": 0,
         "fail": set(), "reach": {}, "only": set(), "cut": []}
reader = {"ok": True, "problem": None, "lag": 0}

def answer(code=0, stdout="", stderr=""):
    return types.SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)

def fake_run(command, input=None, capture_output=True, text=True):
    if command[0] == "systemctl":
        verb = command[1]
        if verb in world["fail"]:
            return answer(1, stderr=f"{verb} failed")
        if verb == "list-units":
            return answer(stdout="".join(
                f"{'● ' if s == 'failed' else ''}qorpera-agent-exit-resolver@{p}.service loaded {s} {s} resolver {p}\n"
                for p, s in sorted(world["units"].items())))
        port = int(command[-1].split("@")[1].split(".")[0])
        world["calls"].append(" ".join([*command[1:-1], str(port)]))
        if verb in ("start", "restart"):
            world["units"][port] = "active"
        elif verb == "stop":
            world["units"].pop(port, None)
            world["listening"].discard(port)
        elif verb == "reset-failed" and world["units"].get(port) == "failed":
            del world["units"][port]
        return answer()
    assert command[:4] == ["ip", "netns", "exec", "qexit"], command
    command = command[4:]
    if command[0] == "ss":
        return answer(stdout="".join(f"{kind} {how} 0 0 10.210.0.1:{port} 0.0.0.0:*\n" for port in sorted(world["listening"])
                                     for kind, how in (("udp", "UNCONN"), ("tcp", "LISTEN"))))
    if command[:3] == ["nft", "-j", "list"]:
        if "list" in world["fail"]:
            return answer(1, stderr="Error: No such file or directory")
        if command[3] == "tables":
            return answer(stdout=json.dumps({"nftables": [{"metainfo": {}}, {"table": {
                "family": "inet", "name": "qorpera_agent_exit", "handle": world["table"]}}]}))
        if command[3] == "chains":
            return answer(stdout=json.dumps({"nftables": [{"metainfo": {}}, *({"chain": {
                "family": "inet", "table": "qorpera_agent_exit", "name": name}} for name in
                ["agent_out", "open", *(f"only_{p}" for p in sorted(world["only"]))])]}))
        if command[3] == "map" and command[6] == "reach":
            return answer(stdout=json.dumps({"nftables": [{"metainfo": {}}, {"map": {"name": "reach", "elem": [
                [a, {"goto": {"target": c}}] for a, c in world["reach"].items()]}}]}))
        if command[3] == "map":
            return answer(stdout=json.dumps({"nftables": [{"metainfo": {}}, {"map": {"name": "dns_port", "elem": [
                [a, p] for a, p in world["map"].items()]}}]}))
        return answer(stdout=json.dumps({"nftables": [{"metainfo": {}}, {"set": {"name": "dns_allowed", "elem": [
            {"concat": [a, p]} for a, p in world["set"]]}}]}))
    if command[:3] == ["nft", "flush", "set"]:
        world["calls"].append(f"empty {command[5]}")
        return answer()
    if command[:2] == ["nft", "-f"]:
        if "nft -f" in world["fail"]:
            return answer(1, stderr="Error: Could not process rule: No such file or directory")
        world["wrote"] += any(" reach" in line or " dns_" in line for line in input.splitlines())
        for line in input.splitlines():
            port = line.split(" only_")[1].split(" ")[0] if " only_" in line else None
            if line.startswith("add chain"):
                world["only"].add(int(port))
            elif line.startswith("delete chain"):
                world["only"].discard(int(port))
            elif line.startswith(("add set", "flush chain", "add rule", "destroy set")):
                continue
            elif line.startswith("flush map") and line.endswith(" reach"):
                world["reach"] = {}
            elif line.startswith("flush map"):
                world["map"] = {}
            elif line.startswith("flush set"):
                world["set"] = set()
            else:
                pairs = line.split("{ ")[1].removesuffix(" }").split(", ")
                if " reach " in line:
                    world["reach"].update(pair.split(" : goto ") for pair in pairs)
                elif " dns_port " in line:
                    world["map"].update({a: int(p) for a, p in (pair.split(" : ") for pair in pairs)})
                else:
                    world["set"].update((a, int(p)) for a, p in (pair.split(" . ") for pair in pairs))
        return answer()
    if command[0] == "conntrack":
        if "conntrack" in world["fail"]:
            return answer(1, stderr="conntrack v1.4.8 (conntrack-tools): Operation failed: Device or resource busy")
        if len(command) == 4:
            world["cut"].append(command[3])
        elif command[3] not in world["flushed"]:
            world["flushed"].append(command[3])
        return answer(1, stderr="conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.")
    raise AssertionError(command)

names.subprocess = types.SimpleNamespace(run=fake_run)

def machine(address, company, verified=True):
    entry = {"schema": "qorpera.agent-plug/v1", "address": address, "hwaddr": plug.hwaddr_for(address), "kind": "machine",
             "company": company, "machine": "m" + address.rsplit(".", 1)[1], "member": None, "project": "qp",
             "instance": "m" + address.rsplit(".", 1)[1], "since": "2026-10-01T00:00:00Z"}
    plug.write_replace(os.path.join(state, "seen", address), json.dumps(entry))
    if verified:
        open(os.path.join(state, "verified", address), "w").close()

def unverify(address):
    os.unlink(os.path.join(state, "verified", address))

version = [0]
def ruled(mode="open", block=(), allow=()):
    version[0] += 1
    return {"version": f"00000000-0000-4000-8000-{version[0]:012d}", "mode": mode, "block": list(block), "allow": list(allow)}

def rules(**companies):
    plug.write_replace(rules_path, json.dumps({"schema": "qorpera.agent-exit-rules/v1", "companies": companies}), 0o600)

def servers(kinds=(".servers", ".owed")):
    folder = os.path.join(run, "names")
    return {name: open(os.path.join(folder, name)).read() for name in sorted(os.listdir(folder))
            if name.endswith(kinds)} if os.path.isdir(folder) else {}

def ports():
    path = os.path.join(state, "names", "ports.json")
    return json.load(open(path)) if os.path.exists(path) else None

def write_reader():
    if reader is None:
        return
    at = clock[0] - reader["lag"]
    plug.write_replace(status_path, json.dumps({"schema": "qorpera.agent-exit-rules-status/v1", "ok": reader["ok"],
                       "problem": reader["problem"], "checkedAt": plug.now_iso(at).removesuffix("Z") + ".250Z"}))

steps = {}
reconciler = [None]
def step(label, advance=2):
    clock[0] += advance
    write_reader()
    world["calls"], world["flushed"], world["wrote"], world["cut"] = [], [], 0, []
    reconciler[0] = reconciler[0] or names.Names(args)
    status = reconciler[0].pass_once()
    steps[label] = {"problems": status["problems"], "resolvers": status["resolvers"], "mapped": status["mapped"],
                    "map": dict(sorted(world["map"].items())), "allowed": sorted(map(list, world["set"])),
                    "calls": world["calls"], "flushed": world["flushed"], "wrote": world["wrote"], "servers": servers(),
                    "ports": ports(), "written": json.load(open(os.path.join(run, "names.json")))["problems"],
                    "reach": dict(sorted(world["reach"].items())), "reached": status["reach"], "only": sorted(world["only"]),
                    "cut": world["cut"], "modes": servers((".mode",))}
`;
	let dir;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-exit-names-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	// Runs a scenario after the prelude; returns its steps by label.
	const scenario = (body) => {
		const root = mkdtempSync(join(dir, "s-"));
		const r = spawnSync("python3", ["-c", `${prelude}\n${body}\nprint(json.dumps(steps))`, namesTool, root], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	const main = { "10.210.1.1": 53, "10.210.1.2": 53 };

	test("a company with rules gets a resolver of its own, its blocked names in a servers file, and its machines once it answers", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
machine("10.210.1.2", "c2")
machine("10.210.1.3", "c1", verified=False)
rules(c1=None, c2=None)
step("none")
rules(c1=ruled(block=["b.test", "*.w.test"]), c2=None)
step("ruled")
mode = oct(os.stat(os.path.join(run, "names", "10001.servers")).st_mode & 0o777)
world["listening"].add(10001)
step("answers")
step("same")
rules(c1=ruled(block=["b.test"]), c2=None)
step("changed")
unverify("10.210.1.1")
step("gone")
steps["mode"] = mode
`);
		assert.deepEqual(s.none, { ...s.none, problems: [], resolvers: {}, mapped: main, map: main, calls: [], servers: {}, ports: null });
		assert.deepEqual(s.none.allowed, [["10.210.1.1", 53], ["10.210.1.2", 53]]);
		// The new resolver is started, not answering yet: its machine keeps the main dnsmasq meanwhile.
		assert.deepEqual(s.ruled.resolvers, { c1: 10001 });
		assert.deepEqual(s.ruled.ports, { c1: 10001 });
		assert.deepEqual(s.ruled.calls, ["reset-failed 10001", "start --no-block 10001"]);
		assert.deepEqual(s.ruled.servers, { "10001.servers": "server=/*.w.test/\nserver=/b.test/\n" });
		assert.equal(s.mode, "0o644", "dnsmasq reads it as nobody");
		assert.deepEqual([s.ruled.mapped, s.ruled.map, s.ruled.wrote, s.ruled.problems], [main, main, 0, []]);
		// It answers: the machine moves to it, and its DNS connections to the main dnsmasq are ended.
		assert.deepEqual(s.answers.map, { "10.210.1.1": 10001, "10.210.1.2": 53 });
		assert.deepEqual(s.answers.allowed, [["10.210.1.1", 10001], ["10.210.1.2", 53]]);
		assert.deepEqual([s.answers.flushed, s.answers.calls, s.answers.problems], [["10.210.1.1"], [], []]);
		assert.deepEqual([s.same.wrote, s.same.flushed, s.same.calls], [0, [], []], "nothing to do: nothing done");
		// A new version rewrites the file and reloads the resolver; the machine stays where it is.
		assert.deepEqual(s.changed.servers, { "10001.servers": "server=/b.test/\n" });
		assert.deepEqual([s.changed.calls, s.changed.wrote, s.changed.flushed], [["reload 10001"], 0, []]);
		// Its last machine is gone: the resolver is stopped, its file removed and its port given back.
		assert.deepEqual(s.gone.calls, ["stop 10001", "reset-failed 10001"]);
		assert.deepEqual([s.gone.servers, s.gone.ports, s.gone.resolvers], [{}, {}, {}]);
		assert.deepEqual([s.gone.map, s.gone.flushed, s.gone.problems], [{ "10.210.1.2": 53 }, ["10.210.1.1"], []]);
	});

	test("a resolver that does not answer: its machines keep the main dnsmasq for 10 s, then have no DNS; restarted at most every 10 s", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
rules(c1=None)
step("before")
rules(c1=ruled(block=["b.test"]))
step("started", 0)
step("grace", 10)
step("late", 1)
step("throttled", 5)
step("again", 6)
world["units"][10001] = "failed"
step("failed", 1)
machine("10.210.1.2", "c2")
rules(c1=ruled(block=["b.test"]), c2=ruled())
step("new", 1)
world["listening"].update({10001, 10002})
step("answers", 1)
`);
		const late = "the resolver of c1 (port 10001) is not answering";
		assert.deepEqual([s.started.calls, s.started.map, s.started.problems], [["reset-failed 10001", "start --no-block 10001"], { "10.210.1.1": 53 }, []]);
		assert.deepEqual([s.grace.calls, s.grace.map, s.grace.problems], [[], { "10.210.1.1": 53 }, []]);
		// Past the grace: a problem; its machine goes to it (no DNS until it answers); the running unit is restarted once.
		assert.deepEqual(s.late.problems, [late]);
		assert.deepEqual(s.late.written, [late]);
		assert.deepEqual([s.late.map, s.late.flushed], [{ "10.210.1.1": 10001 }, ["10.210.1.1"]]);
		assert.deepEqual(s.late.calls, ["reset-failed 10001", "restart --no-block 10001"]);
		assert.deepEqual([s.throttled.problems, s.throttled.calls], [[late], []]);
		assert.deepEqual([s.again.problems, s.again.calls], [[late], ["reset-failed 10001", "restart --no-block 10001"]]);
		// A unit that failed is started again (and not restarted on top); the wait is not given again.
		assert.deepEqual([s.failed.problems, s.failed.calls], [[late], ["reset-failed 10001", "start --no-block 10001"]]);
		// A machine with no element yet gets none while its new resolver is waited on.
		assert.deepEqual(s.new.resolvers, { c1: 10001, c2: 10002 });
		assert.deepEqual([s.new.map, s.new.problems], [{ "10.210.1.1": 10001 }, [late]]);
		assert.deepEqual(s.new.calls, ["reset-failed 10002", "start --no-block 10002"]);
		assert.deepEqual([s.answers.map, s.answers.problems, s.answers.calls], [{ "10.210.1.1": 10001, "10.210.1.2": 10002 }, [], []]);
	});

	test("fails closed: no rules file, a company not known yet or with rules that are not usable has no DNS", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
machine("10.210.1.2", "c9")
step("nofile")
rules(c1=None)
step("unknown")
step("long", 31)
rules(c1=None, c9=None)
step("known")
for n, bad in enumerate(({"version": "v1", "mode": "open", "block": [], "allow": []},
            dict(ruled(), mode="closed"), dict(ruled(), extra=1),
            ruled(block=["Upper.test"]), ruled(block=["10.0.0.1"]), ruled(block=["a..test"]), ruled(block=["*.*.test"]),
            ruled(block=["x" * 64 + ".test"]), ruled(block=["a.test", "a.test"]), ruled(block=["a.test"], allow=["a.test"]),
            ruled(block=[f"n{i}.test" for i in range(1001)]))):
    rules(c1=None, c9=bad)
    step("bad", 1)
    assert steps["bad"]["problems"] == ["c9: its rules are not as the rules reader writes them; its machines get no DNS and no way out"], (bad, steps["bad"])
    assert steps["bad"]["map"] == {"10.210.1.1": 53}, (bad, steps["bad"])
    assert steps["bad"]["reach"] == {"10.210.1.1": "open"}, (bad, steps["bad"])
    # Its element went the first time: the connections it made before are ended (the exit lets established ones go on).
    assert steps["bad"]["cut"] == (["10.210.1.2"] if n == 0 else []), (bad, steps["bad"])
rules(c1=None, c9=None)
step("fixed")
plug.write_replace(rules_path, "{", 0o600)
step("garbled")
plug.write_replace(rules_path, json.dumps({"schema": "qorpera.agent-exit-rules/v1", "companies": {"c/1": None}}), 0o600)
step("not_an_id")
os.unlink(rules_path)
step("removed")
`);
		// The first table seen: every machine without a reach element has its connections ended (what a reconciler before
		// this one owed is not known).
		assert.deepEqual([s.nofile.map, s.nofile.resolvers, s.nofile.cut], [{}, {}, ["10.210.1.1", "10.210.1.2"]]);
		assert.deepEqual([s.unknown.cut, s.known.cut], [[], []]);
		assert.deepEqual(s.nofile.problems, ["no rules file yet: every machine's DNS is dropped until the rules reader writes it"]);
		assert.deepEqual([s.unknown.map, s.unknown.problems], [{ "10.210.1.1": 53 }, []], "not listed yet: no DNS, and no problem at first");
		assert.deepEqual(s.long.problems, ["c9: not in the rules file for 31s; its machines get no DNS and no way out"]);
		assert.deepEqual([s.known.map, s.known.problems], [main, []]);
		assert.deepEqual([s.bad.flushed, s.fixed.map], [[], main]);
		// A file that cannot be used keeps the rules last read; a missing one drops every machine.
		assert.equal(s.garbled.problems.length, 1);
		assert.match(s.garbled.problems[0], /^cannot use the rules file: .*; the rules last read stay$/);
		assert.deepEqual(s.garbled.map, main);
		assert.deepEqual(s.not_an_id.problems, ["cannot use the rules file: a company that is not an id; the rules last read stay"]);
		assert.deepEqual([s.removed.map, s.removed.allowed, s.removed.flushed], [{}, [], ["10.210.1.1", "10.210.1.2"]]);
		assert.deepEqual([s.removed.reach, s.removed.cut], [{}, ["10.210.1.1", "10.210.1.2"]]);
	});

	test("the rules reader: silent for 30 s, or failing for 2 minutes, is a problem; its last rules stay meanwhile", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
rules(c1=None)
step("fine")
reader["lag"] = 31
step("silent")
reader.update(lag=0, ok=False, problem="DB_UNREACHABLE")
step("failing")
step("failing_long", 121)
reader["problem"] = "not a code"
step("failing_odd")
reader.update(ok=True, problem=None)
step("back")
reader = None
os.unlink(status_path)
step("no_status")
`);
		assert.deepEqual(s.fine.problems, []);
		assert.deepEqual(s.silent.problems, ["the rules reader silent for 31s"]);
		assert.deepEqual([s.failing.problems, s.failing.map], [[], { "10.210.1.1": 53 }]);
		assert.deepEqual(s.failing_long.problems, ["the rules reader failing for 121s (DB_UNREACHABLE)"]);
		assert.deepEqual(s.failing_odd.problems, ["the rules reader failing for 123s (unknown)"]);
		assert.deepEqual([s.failing_long.map, s.back.problems], [{ "10.210.1.1": 53 }, []]);
		assert.deepEqual([s.no_status.problems, s.no_status.map], [["the rules reader is not running (no status)"], { "10.210.1.1": 53 }]);
	});

	test("ports: kept across restarts, the lowest free one for a new company, never one a unit still holds", () => {
		const s = scenario(String.raw`
for i, company in enumerate(("c1", "c2", "c3", "c4", "c5"), 1):
    machine(f"10.210.1.{i}", company, verified=i <= 2)
companies = {c: ruled() for c in ("c1", "c2", "c3", "c4", "c5")}
rules(**companies)
step("two")
world["listening"].update({10001, 10002})
reconciler[0] = None
step("restarted")
unverify("10.210.1.1")
open(os.path.join(state, "verified", "10.210.1.3"), "w").close()
step("swapped")
open(os.path.join(state, "verified", "10.210.1.4"), "w").close()
step("given_back")
world["units"][10005] = "active"
open(os.path.join(state, "verified", "10.210.1.5"), "w").close()
step("held")
world["units"][10006] = "failed"
plug.write_replace(os.path.join(run, "names", "10006.servers"), "server=/x.test/\n")
step("stray_failed")
plug.write_replace(os.path.join(state, "names", "ports.json"), json.dumps(
    {"c1": 10001, "c2": 10001, "c3": 5, "c4": "10004", "c/5": 10005, "c6": 19999, "c7": 20000}))
steps["read"] = names.read_ports(os.path.join(state, "names", "ports.json"))
`);
		assert.deepEqual([s.two.resolvers, s.two.ports], [{ c1: 10001, c2: 10002 }, { c1: 10001, c2: 10002 }]);
		// A new reconciler keeps the ports, starts nothing again, and reloads what runs (it cannot know what the one
		// before it owed).
		assert.deepEqual([s.restarted.resolvers, s.restarted.calls], [{ c1: 10001, c2: 10002 }, ["reload 10001", "reload 10002"]]);
		// c1 gives 10001 back in the pass c3 comes in: c3 does not get it.
		assert.deepEqual(s.swapped.resolvers, { c2: 10002, c3: 10003 });
		assert.deepEqual(s.swapped.calls, ["reset-failed 10003", "start --no-block 10003", "stop 10001", "reset-failed 10001"]);
		assert.deepEqual(Object.keys(s.swapped.servers), ["10002.servers", "10003.servers"]);
		assert.deepEqual(s.given_back.resolvers, { c2: 10002, c3: 10003, c4: 10001 });
		// A unit no company has (its port is still held) is stopped, and its port is not given out in the same pass.
		assert.deepEqual(s.held.resolvers, { c2: 10002, c3: 10003, c4: 10001, c5: 10004 });
		assert.ok(s.held.calls.includes("stop 10005"), s.held.calls.join(", "));
		assert.deepEqual(s.stray_failed.calls.filter((c) => c.endsWith(" 10006")), ["reset-failed 10006"]);
		assert.ok(!("10006.servers" in s.stray_failed.servers), "its file goes with it");
		assert.deepEqual(s.read, { c1: 10001, c6: 19999 }, "out of range, held twice, not a number, not an id: left out");
	});

	test("without systemd's view nothing is started or stopped; a failed reload is tried again; a changed map is set right", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
machine("10.210.1.2", "c2")
rules(c1=ruled(block=["b.test"]), c2=None)
world["listening"].add(10001)
step("up")
world["fail"].add("list-units")
unverify("10.210.1.1")
step("blind")
world["fail"] = {"reload"}
open(os.path.join(state, "verified", "10.210.1.1"), "w").close()
rules(c1=ruled(block=["c.test"]), c2=None)
step("reload_fails")
world["fail"] = set()
step("reloaded")
del world["map"]["10.210.1.2"]
world["map"]["10.210.1.1"] = 53
step("drifted")
world["set"].add(("10.210.1.9", 10001))
step("extra")
plug.write_replace(os.path.join(state, "names", "ports.json"), "{")
sys.argv = ["names", "reconcile", "--once", "--state-dir", state, "--run-dir", run, "--rules", rules_path,
            "--rules-status", status_path]
world["calls"] = []
names.main()
steps["crashed"] = {"status": json.load(open(os.path.join(run, "names.json"))), "calls": world["calls"],
                    "map": dict(sorted(world["map"].items()))}
`);
		assert.deepEqual([s.up.map, s.up.problems], [{ "10.210.1.1": 10001, "10.210.1.2": 53 }, []]);
		assert.equal(s.blind.problems.length, 1);
		assert.match(s.blind.problems[0], /^cannot list the resolvers: list-units failed$/);
		assert.deepEqual([s.blind.calls, s.blind.resolvers, s.blind.map], [[], {}, { "10.210.1.2": 53 }]);
		assert.deepEqual(s.blind.servers, { "10001.servers": "server=/b.test/\n" }, "nothing removed while blind");
		assert.deepEqual(s.reload_fails.problems, ["cannot reload the resolver on port 10001: reload failed"]);
		assert.deepEqual(s.reload_fails.servers, { "10001.servers": "server=/c.test/\n" });
		assert.deepEqual([s.reloaded.calls, s.reloaded.problems], [["reload 10001"], []]);
		// Set by hand: put back, and the machine moved off its resolver has its DNS connections ended.
		assert.deepEqual([s.drifted.map, s.drifted.flushed], [{ "10.210.1.1": 10001, "10.210.1.2": 53 }, ["10.210.1.1"]]);
		assert.deepEqual([s.extra.wrote, s.extra.allowed], [1, [["10.210.1.1", 10001], ["10.210.1.2", 53]]]);
		// A pass that fails as a whole is a problem, and touches nothing.
		assert.deepEqual([s.crashed.calls, s.crashed.map], [[], { "10.210.1.1": 10001, "10.210.1.2": 53 }]);
		assert.match(s.crashed.status.problems.join(" | "), /^JSONDecodeError: /);
	});

	test("what a reconciler owed is done by the next: every resolver that runs reloaded, every machine's DNS connections ended once per table", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
machine("10.210.1.2", "c2")
rules(c1=ruled(block=["b.test"]), c2=None)
world["listening"].add(10001)
step("first")
step("settled")
world["table"] += 1
step("rebuilt")
step("after")
world["fail"] = {"reload"}
rules(c1=ruled(block=["c.test"]), c2=None)
step("reload_fails")
world["fail"] = set()
reconciler[0] = None
step("restarted")
world["fail"] = {"conntrack"}
rules(c1=None, c2=None)
step("flush_fails")
world["fail"] = set()
reconciler[0] = None
step("again")
`);
		assert.deepEqual([s.first.flushed, s.settled.flushed, s.settled.calls], [["10.210.1.1", "10.210.1.2"], [], []]);
		// A table up made again, filled from the files: its map is right, but connections made before it may still go
		// where an older map sent them (to the main dnsmasq, on an exit upgraded to E8b-2).
		assert.deepEqual([s.rebuilt.wrote, s.rebuilt.flushed, s.after.flushed], [0, ["10.210.1.1", "10.210.1.2"], []]);
		assert.deepEqual([s.reload_fails.calls, s.reload_fails.problems], [[], ["cannot reload the resolver on port 10001: reload failed"]]);
		assert.deepEqual(s.reload_fails.servers, { "10001.servers": "server=/c.test/\n" });
		// Stopped after replacing the file and before its reload: the next reconciler finds the file as it wants it.
		assert.deepEqual([s.restarted.calls, s.restarted.flushed, s.restarted.problems], [["reload 10001"], ["10.210.1.1", "10.210.1.2"], []]);
		// Stopped after changing the map and before ending the connections the change left behind.
		assert.deepEqual([s.flush_fails.map, s.flush_fails.flushed], [main, []]);
		assert.deepEqual(s.flush_fails.problems, ["the DNS connections of 10.210.1.1 could not be ended yet"]);
		assert.deepEqual([s.again.wrote, s.again.flushed, s.again.problems], [0, ["10.210.1.1", "10.210.1.2"], []]);
	});

	test("only listed (E8c): a blocked name covers the names under it; the servers file answers every other name itself", () => {
		const s = scenario(String.raw`
steps["covers"] = [names.covers(b, n) for b, n in (("b.test", "b.test"), ("b.test", "x.b.test"), ("b.test", "*.b.test"),
    ("*.b.test", "x.b.test"), ("*.b.test", "*.b.test"), ("*.b.test", "b.test"), ("b.test", "ab.test"), ("x.b.test", "b.test"))]
up = ["9.9.9.9", "1.1.1.1#5353"]
steps["open"] = names.servers_text({"mode": "open", "block": ["b.test"], "allow": ["a.test"]}, up)
steps["only"] = names.servers_text({"mode": "only-listed", "block": ["b.test"],
                                     "allow": ["a.test", "x.b.test", "*.b.test", "*.w.test"]}, up)
steps["none"] = names.servers_text({"mode": "only-listed", "block": [], "allow": []}, up)
both = "server=/#/\nserver=/a.test/9.9.9.9\nserver=/c.test/9.9.9.9\n"
steps["narrower"] = [names.narrower(both, "server=/#/\nserver=/a.test/9.9.9.9\n"), names.narrower("server=/#/\nserver=/a.test/9.9.9.9\n", both),
    names.narrower(both, both + "server=/x.a.test/\n"), names.narrower(both + "server=/x.a.test/\n", both)]
`);
		assert.deepEqual(s.covers, [true, true, true, true, true, false, false, false]);
		assert.equal(s.open, "server=/b.test/\n", "open: the allow list does nothing");
		// Every name "no such name" (server=/#/ with no address), each allowed name not blocked asked of each upstream,
		// each blocked name answered here (a line for a name under it would win over it otherwise).
		assert.equal(s.only, "server=/#/\nserver=/*.w.test/9.9.9.9\nserver=/*.w.test/1.1.1.1#5353\nserver=/a.test/9.9.9.9\n" +
			"server=/a.test/1.1.1.1#5353\nserver=/b.test/\n");
		assert.equal(s.none, "server=/#/\n");
		assert.deepEqual(s.narrower, [true, false, true, false], "an allowed name gone or a name blocked: narrower");
	});

	test("only listed (E8c): the machines reach only the addresses their resolver gave out; a narrower list or a mode switch restarts it and ends their connections", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
machine("10.210.1.2", "c2")
rules(c1=ruled(block=["b.test"]), c2=None)
world["listening"].add(10001)
step("open")
listed = dict(mode="only-listed", block=["b.test"])
rules(c1=ruled(allow=["a.test", "c.test"], **listed), c2=None)
step("switched")
world["listening"].add(10001)
step("answers")
world["table"] += 1
step("rebuilt")
rules(c1=ruled(allow=["a.test", "c.test", "d.test"], **listed), c2=None)
step("wider")
rules(c1=ruled(allow=["a.test", "d.test"], **listed), c2=None)
step("narrower")
world["listening"].add(10001)
world["fail"] = {"conntrack"}
rules(c1=ruled(allow=["a.test"], **listed), c2=None)
step("cut_fails")
world["fail"] = set()
reconciler[0] = None
world["listening"].add(10001)
step("cut_again")
world["listening"].add(10001)
world["fail"] = {"list"}
rules(c1=ruled(allow=["a.test"], mode="only-listed", block=["b.test", "x.a.test"]), c2=None)
step("unread")
world["fail"] = set()
world["listening"].add(10001)
step("read_again")
rules(c1=ruled(block=["b.test"]), c2=None)
step("reopened")
world["listening"].add(10001)
rules(c1=ruled(block=["b.test"]), c2=ruled(mode="only-listed", allow=["a.test"]))
step("new_only")
unverify("10.210.1.2")
step("unplugged")
`);
		const restart = (port) => [`stop ${port}`, `empty allow_${port}`, `reset-failed ${port}`, `start --no-block ${port}`];
		assert.deepEqual([s.open.reach, s.open.only, s.open.modes], [{ "10.210.1.1": "open", "10.210.1.2": "open" }, [], { "10001.mode": "open\n" }]);
		// The switch: the mode file says so (the resolver starts with --nftset), the resolver is stopped, its set emptied,
		// started again; the machine goes to only_10001 and its connections are ended. It keeps its resolver meanwhile.
		assert.deepEqual(s.switched.servers, {
			"10001.servers": "server=/#/\nserver=/a.test/9.9.9.9\nserver=/a.test/1.1.1.1#5353\nserver=/c.test/9.9.9.9\nserver=/c.test/1.1.1.1#5353\nserver=/b.test/\n",
		});
		assert.deepEqual([s.switched.modes, s.switched.calls, s.switched.only], [{ "10001.mode": "only-listed\n" }, restart(10001), [10001]]);
		assert.deepEqual([s.switched.reach, s.switched.reached, s.switched.cut], [
			{ "10.210.1.1": "only_10001", "10.210.1.2": "open" },
			{ "10.210.1.1": "only_10001", "10.210.1.2": "open" },
			["10.210.1.1"],
		]);
		assert.deepEqual([s.switched.map, s.switched.wrote, s.switched.problems], [{ "10.210.1.1": 10001, "10.210.1.2": 53 }, 1, []]);
		assert.deepEqual([s.answers.calls, s.answers.cut, s.answers.wrote], [[], [], 0]);
		// A table up made again starts with its sets empty: the only-listed resolver is reloaded, so it asks again.
		assert.deepEqual([s.rebuilt.calls, s.rebuilt.cut], [["reload 10001"], []]);
		assert.deepEqual([s.wider.calls, s.wider.cut, s.wider.problems], [["reload 10001"], [], []], "a wider list only reloads");
		assert.deepEqual([s.narrower.calls, s.narrower.cut, s.narrower.problems], [restart(10001), ["10.210.1.1"], []]);
		// Stopped before the connections were ended: the marker stays, and the next reconciler does it all again.
		assert.deepEqual([s.cut_fails.calls, s.cut_fails.cut], [restart(10001), []]);
		assert.deepEqual(s.cut_fails.problems, ["the connections of the machines on port 10001 could not be ended yet"]);
		assert.equal(s.cut_fails.servers["10001.owed"], "cut\n");
		assert.deepEqual([s.cut_again.calls, s.cut_again.cut, s.cut_again.problems], [restart(10001), ["10.210.1.1"], []]);
		assert.ok(!("10001.owed" in s.cut_again.servers));
		// Narrower while the exit's table cannot be read: which sets there are is not known, so the restart stays owed (and
		// the resolver goes on with its set) until it can be.
		assert.deepEqual([s.unread.calls, s.unread.cut, s.unread.servers["10001.owed"]], [[], [], "cut\n"]);
		assert.deepEqual(s.unread.problems, [
			"cannot read the exit's chains: Error: No such file or directory",
			"cannot read the exit's DNS map: Error: No such file or directory",
		]);
		assert.deepEqual([s.read_again.calls, s.read_again.cut, s.read_again.problems], [restart(10001), ["10.210.1.1"], []]);
		// Back to open: restarted without --nftset, its set and chain removed once no element goes to it; nothing cut.
		assert.deepEqual([s.reopened.calls, s.reopened.cut, s.reopened.only, s.reopened.modes], [restart(10001), [], [], { "10001.mode": "open\n" }]);
		assert.deepEqual([s.reopened.reach, s.reopened.servers], [{ "10.210.1.1": "open", "10.210.1.2": "open" }, { "10001.servers": "server=/b.test/\n" }]);
		// A company new to "only listed": its set made and emptied before its resolver first starts; its machine keeps
		// the main dnsmasq until the resolver answers, but reaches only what that resolver gives out.
		assert.deepEqual([s.new_only.calls, s.new_only.only, s.new_only.cut], [["empty allow_10002", "reset-failed 10002", "start --no-block 10002"], [10002], ["10.210.1.2"]]);
		assert.deepEqual([s.new_only.reach, s.new_only.map], [{ "10.210.1.1": "open", "10.210.1.2": "only_10002" }, { "10.210.1.1": 10001, "10.210.1.2": 53 }]);
		assert.deepEqual([s.unplugged.calls, s.unplugged.only, s.unplugged.reach], [["stop 10002", "reset-failed 10002"], [], { "10.210.1.1": "open" }]);
		assert.deepEqual([Object.keys(s.unplugged.servers), s.unplugged.modes], [["10001.servers"], { "10001.mode": "open\n" }]);
	});

	test("only listed (E8c): a company not known yet, with rules not usable or with no chain yet is refused everything", () => {
		const s = scenario(String.raw`
machine("10.210.1.1", "c1")
machine("10.210.1.2", "c2")
machine("10.210.1.3", "c3")
world["listening"].update({10001, 10002})
rules(c1=ruled(mode="only-listed", allow=["a.test"]), c2=dict(ruled(), mode="closed"))
step("mixed")
world["fail"] = {"nft -f"}
world["only"], world["reach"] = set(), {}
world["table"] += 1
step("no_chain")
world["fail"] = set()
step("chain_back")
os.unlink(rules_path)
step("no_rules")
`);
		assert.deepEqual(s.mixed.reach, { "10.210.1.1": "only_10001" }, "c2's rules are not usable, c3 is not known yet");
		// A table up made again without its chain (say up failed half way), and the chain cannot be made: no element.
		assert.ok(s.no_chain.problems.includes("cannot make the only-listed chains: Error: Could not process rule: No such file or directory"));
		assert.deepEqual([s.no_chain.reach, s.no_chain.reached], [{}, {}]);
		// Made at last: the element, and the resolver reloaded (its answers since the table was made filled no set).
		assert.deepEqual([s.chain_back.reach, s.chain_back.only, s.chain_back.calls], [{ "10.210.1.1": "only_10001" }, [10001], ["reload 10001"]]);
		assert.deepEqual([s.no_rules.reach, s.no_rules.map], [{}, {}]);
	});

	test("elements: the maps, sets and chains as the files say, for up; nothing without rules", () => {
		const root = mkdtempSync(join(dir, "elements-"));
		const setup = spawnSync(
			"python3",
			[
				"-c",
				`${prelude}
for address, company in (("10.210.1.2", "c2"), ("10.210.1.10", "c1"), ("10.210.1.3", "c3"), ("10.210.1.4", "c9")):
    machine(address, company)
machine("10.210.1.5", "c1", verified=False)
os.makedirs(os.path.join(state, "names"))
machine("10.210.1.6", "c4")
plug.write_replace(os.path.join(state, "names", "ports.json"), json.dumps({"c1": 10001, "c4": 10004}))
rules(c1=ruled(block=["b.test"]), c2=None, c3=ruled(), c4=ruled(mode="only-listed", allow=["a.test"]))
`,
				namesTool,
				root,
			],
			{ encoding: "utf8" },
		);
		assert.equal(setup.status, 0, setup.stderr);
		const elements = () =>
			spawnSync("python3", [namesTool, "elements", "--state-dir", join(root, "state")], { encoding: "utf8" });
		const r = elements();
		assert.equal(r.status, 0, r.stderr);
		// c3 has no port yet and c9 is not known: neither has a DNS element; c3 is "open", so it reaches out, c9 does
		// not. c4's set and chain come before the element that goes to it. In address order, not text order.
		assert.deepEqual(r.stdout.trim().split("\n"), [
			"add set inet qorpera_agent_exit allow_10004 { type ipv4_addr; size 65536; }",
			"add chain inet qorpera_agent_exit only_10004",
			"flush chain inet qorpera_agent_exit only_10004",
			"add rule inet qorpera_agent_exit only_10004 tcp dport 443 ip daddr @allow_10004 goto open",
			'add rule inet qorpera_agent_exit only_10004 meta mark set 0x80000004 counter name "refused_not_listed" goto refuse',
			"add element inet qorpera_agent_exit dns_port { 10.210.1.2 : 53, 10.210.1.6 : 10004, 10.210.1.10 : 10001 }",
			"add element inet qorpera_agent_exit dns_allowed { 10.210.1.2 . 53, 10.210.1.6 . 10004, 10.210.1.10 . 10001 }",
			"add element inet qorpera_agent_exit reach { 10.210.1.2 : goto open, 10.210.1.3 : goto open, 10.210.1.6 : goto only_10004, 10.210.1.10 : goto open }",
		]);
		rmSync(join(root, "state", "rules", "rules.json"));
		assert.deepEqual([elements().status, elements().stdout], [0, ""]);
	});
});

describe("the logs on the node", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	const DAY = 86400;
	const day = "2026-09-01";
	const t0 = Date.UTC(2026, 8, 1) / 1000;
	const next = "2026-09-02";
	const third = "2026-09-03";
	let dir;
	let log;
	let status;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-exit-logs-"));
		log = join(dir, "log");
		status = join(dir, "logs.json");
		mkdirSync(log);
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const lines = (records) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const append = (name, records, raw = "") => writeFileSync(join(log, name), lines(records) + raw, { flag: "a" });
	const files = () => readdirSync(log).sort();
	// The disk's free share is set (50%) so the result never depends on the machine running the test.
	const tend = (now, ...extra) => {
		const r = spawnSync(
			"python3",
			[logsTool, "tend", "--log-dir", log, "--status", status, "--now", String(now), "--settle", "0", "--free-percent", "50", ...extra],
			{ encoding: "utf8" },
		);
		return { status: r.status, result: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
	};
	const counts = (d) => JSON.parse(readFileSync(join(log, `counts-${d}.json`), "utf8"));
	const machine = (address, company, machineId, ts, event = "plugged") => ({ event, address, company, machine: machineId, kind: "machine", ts });
	const opened = (src, ts, proto = "tcp") => ({ event: "new", src, dst: "1.1.1.1", proto, sport: 40000, dport: 443, ts });

	test("a day is sealed, compressed and counted only once it is closed, two hours after it ends", () => {
		append(`clients-${day}.jsonl`, [
			machine("10.210.1.1", "cA", "mA", t0 + 100),
			machine("10.210.1.2", "cB", "mB", t0 + 200),
			machine("10.210.1.9", "cZ", "mZ", t0 + 300, "dropped"),
			machine("10.210.1.2", "cB", "mB", t0 + 5000, "unplugged"),
			{ ...machine("10.210.1.2", "cC", "mC", t0 + 6000), kind: "coding", member: "u1" },
		]);
		append(
			`flows-${day}.jsonl`,
			[
				{ event: "gap", reason: "logger started", ts: t0 + 50 },
				opened("10.210.1.1", t0 + 150),
				// A burst: twelve new connections in one 10-second step.
				...Array.from({ length: 12 }, (_, i) => opened("10.210.1.1", t0 + 1000 + i / 2)),
				opened("10.210.1.2", t0 + 300, "udp"),
				opened("10.210.1.2", t0 + 7000),
				opened("10.210.1.7", t0 + 400, "icmp"),
				// Unanswered connections to five addresses and a refusal, in one minute: six failed destinations.
				...Array.from({ length: 5 }, (_, i) => ({ event: "destroy", src: "10.210.1.1", dst: `203.0.113.${i}`, proto: "tcp", packets_out: 1, bytes_out: 60, packets_in: 0, bytes_in: 0, ts: t0 + 1985 + i })),
				{ event: "destroy", src: "10.210.1.1", dst: "1.1.1.1", proto: "tcp", packets_out: 5, bytes_out: 500, packets_in: 4, bytes_in: 900, ts: t0 + 1989 },
				{ event: "refused", src: "10.210.1.1", dst: "192.168.1.40", proto: "tcp", dport: 2049, rule: "our_networks", ts: t0 + 1990 },
				// The brake's lines: counted per company, never as connections; an unbraked line says what it dropped.
				{ event: "braked", company: "cA", reason: "12 new connections in 10 seconds (level 10)", until: t0 + 1601, slow10s: 5, ts: t0 + 1001 },
				{ event: "unbraked", company: "cA", since: t0 + 1001, dropped: 40, ts: t0 + 1602 },
			],
			"not json\n",
		);
		writeFileSync(join(log, "dns.log"), "line1\n");
		const early = tend(t0 + DAY + 3600);
		assert.equal(early.status, 0, early.stderr);
		assert.deepEqual(early.result.problems, []);
		assert.equal(early.result.sealed, 0, "not closed an hour after the day ends");
		assert.ok(files().includes(`flows-${day}.jsonl`) && !files().includes(`counts-${day}.json`));
		assert.equal(readFileSync(join(log, "dns.log"), "utf8"), "line1\n", "the first pass only notes the day");
		const closed = tend(t0 + DAY + 3 * 3600);
		assert.equal(closed.status, 0, closed.stderr);
		assert.equal(closed.result.sealed, 2);
		assert.equal(closed.result.daysCounted, 1);
		assert.ok(!files().includes(`flows-${day}.jsonl`) && !files().includes(`clients-${day}.jsonl`));
		const part = gunzipSync(readFileSync(join(log, `flows-${day}.p001.jsonl.gz`))).toString("utf8");
		assert.equal(part.split("\n").filter(Boolean).length, 27, "every line, the unreadable one too");
		assert.equal(statSync(join(log, `flows-${day}.p001.jsonl.gz`)).mode & 0o777, 0o640);
		const c = counts(day);
		assert.deepEqual(c.companies.cA, {
			machines: 1,
			connections: 13,
			byProto: { tcp: 13 },
			peakNew10s: 12,
			peakNew10sAt: "2026-09-01T00:16:40Z",
			peakNew10sOneMachine: 12,
			refused: 1,
			refusedByRule: { our_networks: 1 },
			unanswered: 5,
			failedDestinations: 6,
			failedDestinationsAtLeast: false,
			peakFailedDestinations60s: 6,
			peakFailedDestinations60sAt: "2026-09-01T00:33:00Z",
			brakes: 1,
			droppedByBrake: 40,
		});
		// The address goes from cB to cC the moment it is plugged in again; one never matched (dropped) has no company.
		assert.equal(c.companies.cB.connections, 1);
		assert.equal(c.companies.cC.connections, 1);
		assert.equal(c.companies.unattributed.connections, 1);
		assert.equal(c.companies.unattributed.machines, 0);
		assert.equal(c.companies.cZ, undefined);
		assert.deepEqual([c.companies.cB.brakes, c.companies.cB.droppedByBrake], [0, 0]);
		assert.deepEqual(c.node, { records: 26, gaps: 1, gapReasons: { "logger started": 1 }, unreadableLines: 1 });
		assert.deepEqual(c.parts, [`clients-${day}.p001.jsonl.gz`, `flows-${day}.p001.jsonl.gz`]);
		assert.deepEqual(c.late, []);
		assert.equal(c.pluggedInAtEnd["10.210.1.2"].company, "cC");
		const carried = JSON.parse(readFileSync(join(log, "attribution.json"), "utf8"));
		assert.equal(carried.through, day);
		assert.deepEqual(Object.keys(carried.open).sort(), ["10.210.1.1", "10.210.1.2"]);
		assert.equal(carried.open["10.210.1.2"].company, "cC");
	});

	test("a machine plugged in on an earlier day keeps its company, and dns.log is cut once a day", () => {
		append(`flows-${next}.jsonl`, [opened("10.210.1.1", t0 + DAY + 10)]);
		const r = tend(t0 + 2 * DAY + 3 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.result.daysCounted, 1);
		assert.equal(counts(next).companies.cA.connections, 1, "its plugged line is a day back, in a sealed part");
		assert.equal(r.result.dnsRotated, true);
		assert.equal(readFileSync(join(log, "dns.log"), "utf8"), "");
		const rotated = files().filter((name) => /^dns-2026-09-03T030000Z\.log\.gz$/.test(name));
		assert.equal(rotated.length, 1, files().join(" "));
		assert.equal(gunzipSync(readFileSync(join(log, rotated[0]))).toString("utf8"), "line1\n");
	});

	test("an open file is sealed in parts once it holds a part's size, and a day's count reads every part", () => {
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 10), opened("10.210.1.1", t0 + 2 * DAY + 20)]);
		assert.equal(tend(t0 + 2 * DAY + 3600 * 5, "--part-bytes", "10").result.sealed, 1);
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 30)]);
		assert.equal(tend(t0 + 2 * DAY + 3600 * 6, "--part-bytes", "10").result.sealed, 1);
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 40)]);
		assert.ok(files().includes(`flows-${third}.p001.jsonl.gz`) && files().includes(`flows-${third}.p002.jsonl.gz`));
		const r = spawnSync("python3", [logsTool, "count", "--log-dir", log, "--day", third], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const today = JSON.parse(r.stdout);
		assert.equal(today.companies.cA.connections, 4, "both parts and the open file");
		assert.equal(today.attributionPartial, false);
		// A late line for a counted day (the reconciler was down: its "plugged" line is days back) becomes that day's
		// next part; the counted day never changes.
		const counted = readFileSync(join(log, `counts-${day}.json`), "utf8");
		append(`clients-${day}.jsonl`, [machine("10.210.1.7", "cE", "mE", t0 + 350)]);
		const again = tend(t0 + 2 * DAY + 3600 * 7);
		assert.equal(again.status, 0, again.stderr);
		assert.ok(files().includes(`clients-${day}.p002.jsonl.gz`), files().join(" "));
		assert.equal(again.result.daysCounted, 0, "no day closed since");
		assert.equal(readFileSync(join(log, `counts-${day}.json`), "utf8"), counted);
	});

	test("the report adds the days up per company", () => {
		const r = spawnSync("python3", [logsTool, "report", "--log-dir", log, "--json"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const report = JSON.parse(r.stdout);
		assert.equal(report.node.days, 2);
		assert.deepEqual(
			{
				days: report.companies.cA.days,
				connections: report.companies.cA.connections,
				peak: report.companies.cA.peakNew10s,
				brakes: report.companies.cA.brakes,
				dropped: report.companies.cA.droppedByBrake,
			},
			{ days: 2, connections: 14, peak: 12, brakes: 1, dropped: 40 },
		);
		const text = spawnSync("python3", [logsTool, "report", "--log-dir", log], { encoding: "utf8" });
		assert.equal(text.status, 0, text.stderr);
		assert.match(text.stdout, /^cA\s+2\s+14\s+13\s+1\s+12\s+12\s+1\s+5\s+6\s+1\s+40$/m);
	});

	test("over the cap the oldest counted parts go first, the client history last; never an uncounted part", () => {
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 50)]);
		const r = tend(t0 + 2 * DAY + 3600 * 9, "--cap-bytes", "1");
		assert.equal(r.status, 1, "still over a 1-byte cap: a problem");
		assert.match(r.result.problems[0], /over their cap, or the disk under its floor/);
		const lost = lostRecords(log);
		const order = lost.map((entry) => entry.file);
		assert.deepEqual(order, [
			`flows-${day}.p001.jsonl.gz`,
			`flows-${next}.p001.jsonl.gz`,
			"dns-2026-09-03T030000Z.log.gz",
			`clients-${day}.p001.jsonl.gz`,
		]);
		assert.ok(lost.every((entry) => entry.reason === "over the cap" && entry.bytes > 0));
		assert.equal(lost.find((entry) => entry.file === `flows-${day}.p001.jsonl.gz`).day, day);
		// The third day is not counted yet, and the late part for the first day is counted nowhere yet: both stay.
		for (const kept of [`flows-${third}.p001.jsonl.gz`, `flows-${third}.p002.jsonl.gz`, `clients-${day}.p002.jsonl.gz`,
			`counts-${day}.json`, `counts-${next}.json`, `flows-${third}.jsonl`, "attribution.json", "dns.log"])
			assert.ok(files().includes(kept), kept);
		assert.equal(JSON.parse(readFileSync(status, "utf8")).problems.length, 1);
		// The report says how many files went before their time, from the ledger as it is now.
		const report = JSON.parse(spawnSync("python3", [logsTool, "report", "--log-dir", log, "--json"], { encoding: "utf8" }).stdout);
		assert.equal(report.node.deletedEarly, 3, "the DNS part's day is the third, not counted yet");
	});

	test("a late part is counted with the next day counted, under its own day; the day it belongs to never changes", () => {
		const first = readFileSync(join(log, `counts-${day}.json`), "utf8");
		const second = readFileSync(join(log, `counts-${next}.json`), "utf8");
		// A late connection line for the second day, from the address the late plug (first day) gives to cE.
		append(`flows-${next}.jsonl`, [opened("10.210.1.7", t0 + DAY + 500), { event: "gap", reason: "logger started", ts: t0 + DAY + 501 }]);
		const r = tend(t0 + 3 * DAY + 3 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.result.daysCounted, 1);
		assert.equal(readFileSync(join(log, `counts-${day}.json`), "utf8"), first);
		assert.equal(readFileSync(join(log, `counts-${next}.json`), "utf8"), second);
		const c = counts(third);
		assert.deepEqual(c.parts, [`flows-${third}.p001.jsonl.gz`, `flows-${third}.p002.jsonl.gz`, `flows-${third}.p003.jsonl.gz`]);
		assert.equal(c.companies.cA.connections, 5);
		assert.deepEqual(
			c.late.map((late) => [late.day, late.parts, late.companies.cE?.connections ?? 0]),
			[
				[day, [`clients-${day}.p002.jsonl.gz`], 0],
				[next, [`flows-${next}.p002.jsonl.gz`], 1],
			],
		);
		assert.equal(c.pluggedInAtEnd["10.210.1.7"].company, "cE");
		const report = JSON.parse(spawnSync("python3", [logsTool, "report", "--log-dir", log, "--json"], { encoding: "utf8" }).stdout);
		assert.deepEqual([report.companies.cE.connections, report.companies.cE.days], [1, 0], "the report adds the late numbers");
		assert.equal(report.node.gaps, 2, "and the late part's gap lines");
		assert.equal(tend(t0 + 3 * DAY + 4 * 3600).result.daysCounted, 0, "counted once");
	});

	test("the counts file is the one commit point: a pass cut short after it never counts a day twice", () => {
		const cut = mkdtempSync(join(dir, "cut-"));
		const second = t0 + DAY;
		writeFileSync(join(cut, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(cut, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(
			join(cut, `clients-${next}.jsonl`),
			lines([machine("10.210.1.1", "cA", "mA", second + 100, "unplugged"), machine("10.210.1.1", "cB", "mB", second + 200)]),
		);
		writeFileSync(join(cut, `flows-${next}.jsonl`), lines([opened("10.210.1.1", second + 300)]));
		const run = (now, ...extra) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", cut, "--status", join(cut, "s.json"), "--now", String(now), "--settle", "0", "--free-percent", "50", ...extra], { encoding: "utf8" });
		// attribution.json cannot be written: the counts files are.
		mkdirSync(join(cut, ".attribution.json.tmp"));
		const r = run(t0 + 2 * DAY + 3 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).daysCounted, 2);
		assert.ok(!readdirSync(cut).includes("attribution.json"));
		const both = [day, next].map((d) => readFileSync(join(cut, `counts-${d}.json`), "utf8"));
		rmSync(join(cut, ".attribution.json.tmp"), { recursive: true });
		assert.equal(JSON.parse(run(t0 + 2 * DAY + 4 * 3600).stdout).daysCounted, 0, "never counted twice");
		assert.deepEqual([day, next].map((d) => readFileSync(join(cut, `counts-${d}.json`), "utf8")), both);
		// The next day starts from the newest counts file: 10.210.1.1 is cB's.
		writeFileSync(join(cut, `flows-${third}.jsonl`), lines([opened("10.210.1.1", t0 + 2 * DAY + 300)]));
		assert.equal(JSON.parse(run(t0 + 3 * DAY + 3 * 3600).stdout).daysCounted, 1);
		assert.equal(JSON.parse(readFileSync(join(cut, `counts-${third}.json`), "utf8")).companies.cB.connections, 1);
		assert.equal(JSON.parse(readFileSync(join(cut, "attribution.json"), "utf8")).through, third);
	});

	test("a closed day that cannot be counted is a problem, and its parts stay, past 90 days and over the cap", () => {
		const stuck = mkdtempSync(join(dir, "stuck-"));
		writeFileSync(join(stuck, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(stuck, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(join(stuck, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 200)]));
		const run = (...extra) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", stuck, "--status", join(stuck, "s.json"), "--now", String(t0 + 100 * DAY), "--settle", "0", "--free-percent", "50", ...extra], { encoding: "utf8" });
		// The second day's connection log cannot be sealed (compressing it fails), and the checkpoint's copy cannot be
		// written either.
		mkdirSync(join(stuck, `.flows-${next}.p001.jsonl.gz.tmp`));
		mkdirSync(join(stuck, ".attribution.json.tmp"));
		const failed = run("--cap-bytes", "1");
		assert.equal(failed.status, 1);
		const problems = JSON.parse(failed.stdout).problems.join(" | ");
		assert.match(problems, /sealed: /);
		assert.match(problems, new RegExp(`${next} is closed but not counted: flows-${next}\\.p001\\.sealing not sealed`));
		assert.equal(JSON.parse(failed.stdout).daysCounted, 1, "the first day, which could be sealed");
		// The first day's parts are counted, so they go (past 90 days); the second day's stay, whatever the cap.
		const left = readdirSync(stuck);
		assert.ok(!left.includes(`flows-${day}.p001.jsonl.gz`) && left.includes(`flows-${next}.p001.sealing`), left.join(" "));
		// The first day's counts are the newest, the checkpoint (its copy cannot be written): they stay past 90 days.
		assert.ok(left.includes(`counts-${day}.json`) && !left.includes("attribution.json"), left.join(" "));
		rmSync(join(stuck, `.flows-${next}.p001.jsonl.gz.tmp`), { recursive: true });
		rmSync(join(stuck, ".attribution.json.tmp"), { recursive: true });
		const recovered = run();
		assert.equal(recovered.status, 0, recovered.stderr);
		assert.ok(!readdirSync(stuck).some((name) => name.startsWith("flows-") || name.startsWith("clients-")), "counted, then past 90 days");
		assert.equal(JSON.parse(readFileSync(join(stuck, "attribution.json"), "utf8")).open["10.210.1.1"].company, "cA");
		assert.ok(!readdirSync(stuck).includes(`counts-${day}.json`), "gone once newer counts came and its parts went");
	});

	test("expiry takes the parts before the counts that name them, so a pass cut short never counts a part twice", () => {
		const expiring = mkdtempSync(join(dir, "expiring-"));
		writeFileSync(join(expiring, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(expiring, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(join(expiring, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 200)]));
		const run = (now) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", expiring, "--status", join(dir, "expiring.json"), "--now", String(now), "--settle", "0", "--free-percent", "50"], { encoding: "utf8" });
		assert.equal(run(t0 + 2 * DAY + 3 * 3600).status, 0);
		// 92 days on, the first two days expire. The first pass cannot delete or write anything (a read-only folder):
		// cut short before any expiry.
		const later = t0 + 92 * DAY + 3 * 3600;
		chmodSync(expiring, 0o555);
		try {
			assert.equal(run(later).status, 1);
		} finally {
			chmodSync(expiring, 0o755);
		}
		assert.equal(run(later).status, 0);
		const left = readdirSync(expiring);
		assert.ok(!left.some((name) => name.startsWith("flows-") || name.startsWith("clients-")), left.join(" "));
		const counted = left.filter((name) => name.startsWith("counts-"));
		assert.ok(counted.length > 80);
		for (const name of counted)
			assert.deepEqual(JSON.parse(readFileSync(join(expiring, name), "utf8")).late, [], `${name}: nothing counted twice`);
		const lost = lostRecords(expiring).map((record) => record.file);
		for (const [part, counts] of [[`flows-${day}.p001.jsonl.gz`, `counts-${day}.json`], [`clients-${day}.p001.jsonl.gz`, `counts-${day}.json`], [`flows-${next}.p001.jsonl.gz`, `counts-${next}.json`]])
			assert.ok(lost.indexOf(part) >= 0 && lost.indexOf(part) < lost.indexOf(counts), lost.join(" "));
	});

	test("a deletion is never unrecorded: its record comes first, whole, and a deleted name is never used again", () => {
		const ledger = mkdtempSync(join(dir, "ledger-"));
		writeFileSync(join(ledger, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(ledger, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(join(ledger, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 200)]));
		const run = (now) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", ledger, "--status", join(dir, "ledger.json"), "--now", String(now), "--settle", "0", "--free-percent", "50"], { encoding: "utf8" });
		const counted = t0 + 2 * DAY + 3 * 3600;
		assert.equal(run(counted).status, 0);
		// A pass cut short under pressure, after the second day's record and before its unlink. The pressure is gone
		// now: the recorded deletion is finished all the same, first, and not recorded twice.
		const pending = `flows-${next}.p001.jsonl.gz`;
		mkdirSync(join(ledger, "lost"));
		writeFileSync(join(ledger, "lost", `${pending}.json`), JSON.stringify({ ts: counted, recordedAt: 1, file: pending, bytes: 1, day: next, reason: "over the cap" }));
		assert.equal(run(counted + 3600).status, 0);
		assert.ok(!readdirSync(ledger).includes(pending));
		assert.ok(readdirSync(ledger).includes(`flows-${day}.p001.jsonl.gz`), "no pressure, no expiry: the rest stays");
		assert.equal(lostRecords(ledger).length, 1);
		// 92 days on, the first day expires. A record that cannot be written (a folder where its temporary file goes):
		// that file is not deleted.
		const later = t0 + 92 * DAY + 3 * 3600;
		const blocked = join(ledger, "lost", `.flows-${day}.p001.jsonl.gz.json.tmp`);
		mkdirSync(blocked);
		assert.equal(run(later).status, 1);
		assert.ok(readdirSync(ledger).includes(`flows-${day}.p001.jsonl.gz`), "kept without its record");
		assert.ok(!lostRecords(ledger).some((record) => record.file === `flows-${day}.p001.jsonl.gz`));
		rmSync(blocked, { recursive: true });
		// Then each deletion with its own record.
		assert.equal(run(later).status, 0);
		assert.deepEqual(
			lostRecords(ledger).map((record) => record.file).sort(),
			[`clients-${day}.p001.jsonl.gz`, `counts-${day}.json`, `counts-${next}.json`, `flows-${day}.p001.jsonl.gz`, pending].sort(),
		);
		assert.ok(!readdirSync(ledger).some((name) => name.startsWith("flows-") || name.startsWith("clients-")));
		// The first day's counts are gone too; a late part for it gets a name never used before, and is counted late.
		writeFileSync(join(ledger, `clients-${day}.jsonl`), lines([machine("10.210.1.2", "cC", "mC", t0 + 300)]));
		assert.equal(run(later + DAY).status, 0);
		const newest = readdirSync(ledger).filter((name) => name.startsWith("counts-")).sort().at(-1);
		assert.deepEqual(JSON.parse(readFileSync(join(ledger, newest), "utf8")).late.map((late) => late.parts), [[`clients-${day}.p002.jsonl.gz`]]);
	});

	test("nothing goes until its record is synced: a failed sync of lost/ keeps the part, also when a later pass finishes it", () => {
		const unsynced = mkdtempSync(join(dir, "unsynced-"));
		writeFileSync(join(unsynced, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		const part = `flows-${day}.p001.jsonl.gz`;
		// The tender in this process, 92 days on (the part expires), every folder sync and unlink noted. In the first two
		// passes syncing lost/ fails (a disk error), after the record's rename.
		const script = String.raw`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("logs", sys.argv[1])
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)
log_dir, now, part = sys.argv[2], float(sys.argv[3]), sys.argv[4]
events, failing = [], [True]
sync, unlink = logs.sync_folder, os.unlink
def noted_sync(path):
    events.append(["sync", os.path.relpath(path, log_dir)])
    if failing[0] and os.path.basename(path) == "lost":
        raise OSError(5, "Input/output error")
    sync(path)
def noted_unlink(path, *args, **kwargs):
    events.append(["unlink", os.path.relpath(path, log_dir)])
    unlink(path, *args, **kwargs)
logs.sync_folder = noted_sync
os.unlink = noted_unlink
passes = []
for fail in (True, True, False):
    failing[0] = fail
    events.clear()
    result = logs.tend(log_dir, os.path.join(log_dir, "s.json"), 1 << 30, 10.0, now=now, settle=0, free=lambda _: 50.0)
    record = os.path.join(log_dir, "lost", part + ".json")
    passes.append({"problems": result["problems"], "events": list(events), "files": sorted(os.listdir(log_dir)),
                   "records": sorted(os.listdir(os.path.join(log_dir, "lost"))),
                   "record": open(record).read() if os.path.exists(record) else None})
print(json.dumps(passes))
`;
		const r = spawnSync("python3", ["-c", script, logsTool, unsynced, String(t0 + 92 * DAY + 3 * 3600), part], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const [first, second, third] = JSON.parse(r.stdout);
		const unlinked = (pass) => pass.events.some(([what, name]) => what === "unlink" && name === part);
		// The record is renamed into place, then its sync fails: the part stays. lost/ was made, and the log folder synced.
		assert.match(first.problems.join(" | "), /tidy: .*Input\/output error/);
		assert.ok(first.files.includes(part) && !unlinked(first));
		assert.deepEqual(first.records, [`${part}.json`]);
		assert.deepEqual(first.events.filter(([what]) => what === "sync"), [["sync", "."], ["sync", "lost"]]);
		// The next pass finds the recorded deletion; its sync fails too: the part still stays, the record unchanged.
		assert.match(second.problems.join(" | "), /tidy: .*Input\/output error/);
		assert.ok(second.files.includes(part) && !unlinked(second));
		assert.equal(second.record, first.record);
		// Then the sync works: lost/ and the log folder are synced, and only then does the part go. Its counts go after.
		assert.deepEqual(third.problems, []);
		assert.ok(!third.files.includes(part));
		const at = third.events.findIndex(([what, name]) => what === "unlink" && name === part);
		assert.deepEqual(third.events.slice(0, at), [["sync", "lost"], ["sync", "."]]);
		assert.equal(third.record, first.record, "not written again");
		assert.deepEqual(third.records, [`counts-${day}.json.json`, `counts-${next}.json.json`, `${part}.json`]);
	});

	test("the deletion records count toward the cap, for the tender and the logger, though they never go", () => {
		const full = mkdtempSync(join(dir, "records-"));
		writeFileSync(join(full, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		const part = `flows-${day}.p001.jsonl.gz`;
		const run = (cap) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", full, "--status", join(dir, "records.json"), "--now", String(t0 + DAY + 3 * 3600), "--settle", "0", "--free-percent", "50", "--cap-bytes", String(cap)], { encoding: "utf8" });
		const bytes = (folder) =>
			readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).reduce((sum, entry) => sum + statSync(join(folder, entry.name)).size, 0);
		assert.equal(run(2 ** 30).status, 0);
		// A cap the logs alone are well under: nothing goes.
		const cap = Math.ceil(bytes(full) / 0.8) + 100;
		const quiet = run(cap);
		assert.equal(quiet.status, 0, quiet.stderr);
		assert.equal(JSON.parse(quiet.stdout).deleted, 0);
		// Records of earlier deletions that hold more than the cap by themselves: the counted part goes, and the logs are
		// still over their cap. The records all stay.
		const old = "flows-2026-06-01.p001.jsonl.gz";
		mkdirSync(join(full, "lost"));
		writeFileSync(join(full, "lost", `${old}.json`), JSON.stringify({ ts: t0, recordedAt: 1, file: old, bytes: 1, day: "2026-06-01", reason: "kept 90 days", pad: "x".repeat(cap) }));
		const over = run(cap);
		assert.equal(over.status, 1);
		const result = JSON.parse(over.stdout);
		assert.match(result.problems.join(" | "), /over their cap, or the disk under its floor/);
		assert.ok(!readdirSync(full).includes(part));
		assert.deepEqual(lostRecords(full).map((record) => [record.file, record.reason]), [[old, "kept 90 days"], [part, "over the cap"]]);
		assert.equal(result.bytes, bytes(full) + bytes(join(full, "lost")), "logs.json counts the records");
		// The logger's pressure check counts them too: it pauses.
		const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("logger", sys.argv[1])
logger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logger)
free, size = logger.disk_state(sys.argv[2])
print(json.dumps({"size": size, "pause": logger.should_pause(False, 50.0, size, int(sys.argv[3]), 10.0)}))
`;
		const r = spawnSync("python3", ["-c", script, logger, full, String(cap)], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), { size: result.bytes, pause: true });
	});

	test("a pass cut short never seals a line twice, and a DNS copy left plain is compressed", () => {
		const crashed = mkdtempSync(join(dir, "crashed-"));
		const line = lines([opened("10.210.1.1", t0 + 10)]);
		// Cut short after publishing the part, before removing its source.
		writeFileSync(join(crashed, `flows-${day}.p001.jsonl.gz`), gzipSync(line));
		writeFileSync(join(crashed, `flows-${day}.p001.sealing`), line);
		// Cut short before publishing: the source alone.
		writeFileSync(join(crashed, `clients-${day}.p001.sealing`), lines([machine("10.210.1.1", "cA", "mA", t0 + 5)]));
		writeFileSync(join(crashed, "dns-2026-09-01T030000Z.log"), "q\n");
		const r = spawnSync(
			"python3",
			[logsTool, "tend", "--log-dir", crashed, "--status", join(crashed, "s.json"), "--now", String(t0 + DAY + 3 * 3600), "--settle", "0", "--free-percent", "50"],
			{ encoding: "utf8" },
		);
		assert.equal(r.status, 0, r.stderr);
		const left = readdirSync(crashed).filter((name) => !name.startsWith("."));
		assert.deepEqual(left.filter((name) => name.endsWith(".sealing") || name.endsWith(".log")), []);
		assert.ok(!left.includes(`flows-${day}.p002.jsonl.gz`), left.join(" "));
		assert.equal(gunzipSync(readFileSync(join(crashed, `flows-${day}.p001.jsonl.gz`))).toString("utf8"), line);
		assert.equal(gunzipSync(readFileSync(join(crashed, "dns-2026-09-01T030000Z.log.gz"))).toString("utf8"), "q\n");
		const c = JSON.parse(readFileSync(join(crashed, `counts-${day}.json`), "utf8"));
		assert.equal(c.companies.cA.connections, 1, "counted once");
	});

	test("under the disk's floor the connection log and DNS parts go, and the pass says so; after 90 days all goes", () => {
		const fresh = mkdtempSync(join(dir, "fresh-"));
		const now = t0 + 100 * DAY;
		// 90 days before the clock is 2026-09-11.
		const old = "2026-09-01";
		const kept = "2026-11-01";
		for (const name of [`flows-${old}.p001.jsonl.gz`, `counts-${old}.json`, `dns-${old}T000000Z.log.gz`, `flows-${kept}.p001.jsonl.gz`, `counts-${kept}.json`])
			writeFileSync(join(fresh, name), "x");
		const run = (free) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", fresh, "--status", join(fresh, "s.json"), "--now", String(now), "--settle", "0", "--free-percent", free], { encoding: "utf8" });
		const first = run("50");
		assert.equal(first.status, 0, first.stderr);
		const left = readdirSync(fresh).filter((name) => !name.startsWith("."));
		assert.deepEqual(left.filter((name) => name.includes(old)), [], "older than 90 days");
		assert.ok(left.includes(`flows-${kept}.p001.jsonl.gz`) && left.includes(`counts-${kept}.json`));
		const low = run("9");
		assert.equal(low.status, 1);
		assert.ok(!readdirSync(fresh).includes(`flows-${kept}.p001.jsonl.gz`), "the disk is low");
		assert.ok(readdirSync(fresh).includes(`counts-${kept}.json`), "counts stay");
		const reasons = lostRecords(fresh).map((record) => record.reason);
		assert.deepEqual([...new Set(reasons)], ["kept 90 days", "the disk is low"]);
	});
});

describe("the logs on the NAS", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	const DAY = 86400;
	const day = "2026-09-01";
	const next = "2026-09-02";
	const third = "2026-09-03";
	const t0 = Date.UTC(2026, 8, 1) / 1000;
	const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
	let dir;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-exit-nas-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const lines = (records) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const machine = (address, company, machineId, ts) => ({ event: "plugged", address, company, machine: machineId, kind: "machine", ts });
	const opened = (src, ts) => ({ event: "new", src, dst: "1.1.1.1", proto: "tcp", sport: 40000, dport: 443, ts });
	const closed = (src, ts, bytes) => ({ event: "destroy", src, dst: "1.1.1.1", proto: "tcp", sport: 40000, dport: 443, packets_out: 5, bytes_out: bytes, packets_in: 4, bytes_in: 900, ts });
	const gap = (reason, ts, since) => ({ event: "gap", reason, ts, ...(since === undefined ? {} : { since }) });
	// The logger's alive lines, one a minute from `from` until before `to`.
	const alive = (from, to) => Array.from({ length: Math.ceil((to - from) / 60) }, (_, i) => ({ event: "alive", ts: from + 60 * i }));
	// A node: its log folder and status files, and the NAS (mounted: its marker is there), its own or another node's.
	// The NAS here is a plain folder, not a mount point: the helpers below say a folder will do (--nas-any-folder).
	const node = (name, nas) => {
		const root = mkdtempSync(join(dir, `${name}-`));
		mkdirSync(join(root, "log"));
		if (!nas) {
			mkdirSync(join(root, "nas"));
			writeFileSync(join(root, "nas", ".qorpera-agent-exit-logs"), "");
		}
		return { root, log: join(root, "log"), nas: nas ?? join(root, "nas") };
	};
	const python = (args) => {
		const r = spawnSync("python3", [logsTool, ...args], { encoding: "utf8" });
		return { status: r.status, result: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
	};
	const tend = (n, now, ...extra) =>
		python(["tend", "--log-dir", n.log, "--status", join(n.root, "logs.json"), "--now", String(now), "--settle", "0", "--free-percent", "50", ...extra]);
	const shipArgs = (n, now, host = "node-a", nas = n.nas) => ["ship", "--log-dir", n.log, "--nas-dir", nas, "--status", join(n.root, "ship.json"), "--host", host, "--now", String(now)];
	const ship = (...args) => python([...shipArgs(...args), "--nas-any-folder"]);
	const lookupArgs = (n, now, at) => ["lookup", "--log-dir", n.log, "--nas-dir", n.nas, "--host", "node-a", "--now", String(now), "--at", String(at), "--remote", "1.1.1.1", "--remote-port", "443", "--nas-any-folder"];
	const lookup = (n, now, at, ...extra) => {
		const r = python([...lookupArgs(n, now, at), "--json", ...extra]);
		assert.equal(r.status, 0, r.stderr);
		return r.result;
	};

	test("each sealed file goes to <nas>/<host>/<day>/ once, read back and compared; the node says what is not there yet", () => {
		const a = node("ship");
		writeFileSync(join(a.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		writeFileSync(join(a.log, "dns.log"), "q\n");
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 10)]));
		const first = ship(a, t0 + DAY + 4 * 3600);
		assert.equal(first.status, 0, first.stderr);
		assert.deepEqual([first.result.shipped, first.result.waiting, first.result.problems], [3, 0, []]);
		const sent = [`clients-${day}.p001.jsonl.gz`, `counts-${day}.json`, `flows-${day}.p001.jsonl.gz`];
		assert.deepEqual(readdirSync(join(a.nas, "node-a", day)).sort(), sent);
		for (const name of sent) {
			const record = JSON.parse(readFileSync(join(a.log, "shipped", `${name}.json`), "utf8"));
			assert.deepEqual(
				[record.file, record.day, record.to, record.sha256, record.bytes],
				[name, day, `node-a/${day}/${name}`, sha256(readFileSync(join(a.log, name))), statSync(join(a.log, name)).size],
			);
			assert.deepEqual(readFileSync(join(a.nas, "node-a", day, name)), readFileSync(join(a.log, name)));
			assert.equal(statSync(join(a.nas, "node-a", day, name)).mode & 0o007, 0, "no one else reads the logs");
		}
		// For the other nodes' lookups: the time it covers, and what is on this node only (the second day's open
		// connection log, and dns.log, not cut since the logs began).
		const shipped = JSON.parse(readFileSync(join(a.nas, "node-a", "status.json"), "utf8"));
		assert.deepEqual(
			[shipped.host, shipped.through, shipped.notShipped],
			["node-a", iso(t0 + DAY + 4 * 3600), { dns: [day, next], flows: [next] }],
		);
		assert.equal(ship(a, t0 + DAY + 4 * 3600 + 300).result.shipped, 0, "each file once");
		// The next day the second day is sealed and dns.log cut: a DNS part goes under the day of its cut.
		assert.equal(tend(a, t0 + 2 * DAY + 3 * 3600).status, 0);
		assert.equal(ship(a, t0 + 2 * DAY + 4 * 3600).result.shipped, 3);
		assert.deepEqual(readdirSync(join(a.nas, "node-a", third)), ["dns-2026-09-03T030000Z.log.gz"]);
		assert.deepEqual(JSON.parse(readFileSync(join(a.nas, "node-a", "status.json"), "utf8")).notShipped, {});
	});

	test("a file of its name with other content on the NAS is never overwritten; one waiting a day is a problem", () => {
		const a = node("conflict");
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		const part = `flows-${day}.p001.jsonl.gz`;
		mkdirSync(join(a.nas, "node-a", day), { recursive: true });
		writeFileSync(join(a.nas, "node-a", day, part), "theirs");
		const r = ship(a, t0 + DAY + 4 * 3600);
		assert.equal(r.status, 0, "not a problem before it has waited a day");
		assert.deepEqual([r.result.shipped, r.result.waiting], [1, 1]);
		assert.match(r.result.errors.join(" | "), /flows-2026-09-01\.p001\.jsonl\.gz is on the NAS with other content/);
		assert.equal(readFileSync(join(a.nas, "node-a", day, part), "utf8"), "theirs");
		assert.ok(!existsSync(join(a.log, "shipped", `${part}.json`)));
		// Sealed more than a day before the pass and still on the node only: the exit is unhealthy until it goes.
		utimesSync(join(a.log, part), t0 + DAY + 3 * 3600, t0 + DAY + 3 * 3600);
		const late = ship(a, t0 + 2 * DAY + 4 * 3600);
		assert.equal(late.status, 1);
		assert.match(
			late.result.problems[0],
			/^1 files have waited more than 24 hours to go to the NAS, the oldest since 2026-09-02T03:00:00Z; the last error: .*other content/,
		);
		assert.deepEqual(JSON.parse(readFileSync(join(a.nas, "node-a", "status.json"), "utf8")).notShipped, { flows: [day] });
		rmSync(join(a.nas, "node-a", day, part));
		const fixed = ship(a, t0 + 2 * DAY + 5 * 3600);
		assert.deepEqual([fixed.status, fixed.result.shipped, fixed.result.problems], [0, 1, []]);
	});

	test("a NAS folder that is not a mount point, or has no marker, is never written to; no NAS folder is a problem at once", () => {
		const a = node("unmounted");
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		// The bare folder under the mount point, a marker left in it by mistake: the share is not mounted there.
		const bare = python(shipArgs(a, t0 + DAY + 4 * 3600));
		assert.equal(bare.status, 0, bare.stderr);
		assert.deepEqual([bare.result.shipped, bare.result.waiting], [0, 2]);
		assert.match(bare.result.errors[0], /is not a mount point: the NAS is not mounted there$/);
		assert.deepEqual(readdirSync(a.nas), [".qorpera-agent-exit-logs"]);
		rmSync(join(a.nas, ".qorpera-agent-exit-logs"));
		// A pass cut short (the NAS stopped answering) left its status saying it was shipping.
		writeFileSync(join(a.root, "ship.json"), JSON.stringify({ shipping: true }));
		const r = ship(a, t0 + DAY + 4 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual([r.result.shipped, r.result.waiting], [0, 2]);
		assert.match(r.result.errors[0], /^the last pass did not finish/);
		assert.match(r.result.errors[1], /has no \.qorpera-agent-exit-logs: the NAS is not mounted there$/);
		assert.deepEqual(readdirSync(a.nas), []);
		const none = ship(a, t0 + DAY + 4 * 3600, "node-a", "");
		assert.equal(none.status, 1);
		assert.deepEqual(none.result.problems, ["no NAS folder is set (QORPERA_AGENT_EXIT_NAS_DIR in /etc/default/qorpera-agent-exit)"]);
		assert.equal(JSON.parse(readFileSync(join(a.root, "ship.json"), "utf8")).waiting, 2);
	});

	test("a copy that reads back wrong from the NAS is removed, not recorded, and goes again next pass", () => {
		const a = node("readback");
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		// The shipper in this process. In the first pass every read back from the NAS gives other bytes.
		const script = String.raw`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("logs", sys.argv[1])
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)
log_dir, nas_dir, status, now = sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
real, wrong = logs.file_sha256, [True]
def read_back(path, uncached=False, dir_fd=None):
    return "0" * 64 if uncached and wrong[0] else real(path, uncached, dir_fd)
logs.file_sha256 = read_back
passes = []
for each in (True, False):
    wrong[0] = each
    result = logs.ship(log_dir, nas_dir, status, "node-a", now, mount_check=False)
    passes.append({"shipped": result["shipped"], "errors": result["errors"],
                   "nas": sorted(os.listdir(os.path.join(nas_dir, "node-a", "2026-09-01"))),
                   "records": sorted(os.listdir(os.path.join(log_dir, "shipped")))})
print(json.dumps(passes))
`;
		const r = spawnSync("python3", ["-c", script, logsTool, a.log, a.nas, join(a.root, "ship.json"), String(t0 + DAY + 4 * 3600)], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const [wrong, right] = JSON.parse(r.stdout);
		assert.deepEqual([wrong.shipped, wrong.nas, wrong.records], [0, [], ["lost"]]);
		assert.equal(wrong.errors.length, 2);
		for (const error of wrong.errors) assert.match(error, / read back from the NAS is not what was written: removed, tried again next pass$/);
		assert.deepEqual(
			[right.shipped, right.nas, right.records],
			[2, [`counts-${day}.json`, `flows-${day}.p001.jsonl.gz`], [`counts-${day}.json.json`, `flows-${day}.p001.jsonl.gz.json`, "lost"]],
		);
	});

	test("the tender removes a part the NAS holds after a week, or first under pressure, with no deletion record", () => {
		const shippedNode = (name) => {
			const n = node(name);
			writeFileSync(join(n.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
			writeFileSync(join(n.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
			assert.equal(tend(n, t0 + DAY + 3 * 3600).status, 0);
			assert.equal(ship(n, t0 + DAY + 4 * 3600).result.shipped, 3);
			// The second day's part is sealed after the pass: not on the NAS.
			writeFileSync(join(n.log, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 150)]));
			assert.equal(tend(n, t0 + 2 * DAY + 3 * 3600).status, 0);
			return n;
		};
		const week = shippedNode("week");
		assert.equal(tend(week, t0 + 7 * DAY + 3 * 3600).result.removedShipped, 0, "not a week old yet");
		const old = tend(week, t0 + 8 * DAY + 3 * 3600);
		assert.equal(old.status, 0, old.stderr);
		assert.equal(old.result.removedShipped, 2);
		assert.deepEqual(readdirSync(week.log).filter((name) => name.endsWith(".gz")), [`flows-${next}.p001.jsonl.gz`]);
		assert.ok(existsSync(join(week.log, `counts-${day}.json`)), "counts stay");
		assert.deepEqual(lostRecords(week.log), []);
		// Over the cap the parts the NAS holds go first; then the oldest others, each with its deletion record.
		const pressed = shippedNode("pressure");
		const r = tend(pressed, t0 + 2 * DAY + 4 * 3600, "--cap-bytes", "1");
		assert.equal(r.status, 1);
		assert.deepEqual([r.result.removedShipped, r.result.deleted], [2, 1]);
		assert.deepEqual(lostRecords(pressed.log).map((record) => [record.file, record.reason]), [[`flows-${next}.p001.jsonl.gz`, "over the cap"]]);
		// The deletion record goes to the NAS too, so a lookup on any node knows that part is gone.
		const then = ship(pressed, t0 + 2 * DAY + 5 * 3600);
		assert.equal(then.result.shipped, 2, "the second day's counts and the record");
		const record = join(pressed.nas, "node-a", next, "lost", `flows-${next}.p001.jsonl.gz.json`);
		assert.equal(JSON.parse(readFileSync(record, "utf8")).reason, "over the cap");
		assert.ok(existsSync(join(pressed.log, "shipped", "lost", `flows-${next}.p001.jsonl.gz.json`)));
	});

	test("each node removes its own day folders on the NAS past 90 days, and its records of them", () => {
		const a = node("expire");
		for (const host of ["node-a", "node-b"]) {
			mkdirSync(join(a.nas, host, "2026-05-01"), { recursive: true });
			writeFileSync(join(a.nas, host, "2026-05-01", "flows-2026-05-01.p001.jsonl.gz"), "x");
		}
		mkdirSync(join(a.nas, "node-a", day));
		mkdirSync(join(a.log, "shipped"));
		for (const d of ["2026-05-01", day])
			writeFileSync(join(a.log, "shipped", `flows-${d}.p001.jsonl.gz.json`), JSON.stringify({ file: `flows-${d}.p001.jsonl.gz`, day: d }));
		const r = ship(a, t0 + 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.result.removedFromNas, 1);
		assert.deepEqual(readdirSync(join(a.nas, "node-a")).sort(), [day, "status.json"]);
		assert.ok(existsSync(join(a.nas, "node-b", "2026-05-01")), "another node's folder is its own to remove");
		assert.deepEqual(readdirSync(join(a.log, "shipped")).sort(), [`flows-${day}.p001.jsonl.gz.json`, "lost"]);
	});

	test("dns.log: the main dnsmasq and a company's resolver (E8b) may give one query the same serial; each keeps its name", () => {
		// One machine moved to its company's resolver while the main dnsmasq still answered it: two processes, one serial.
		const file = join(dir, "two-resolvers.log");
		writeFileSync(
			file,
			[
				"Sep  1 00:13:00 dnsmasq[12]: 7 10.210.1.1/5353 query[A] www.example.com from 10.210.1.1",
				"Sep  1 00:13:01 dnsmasq[40]: 7 10.210.1.1/5354 query[A] api.example.org from 10.210.1.1",
				"Sep  1 00:13:01 dnsmasq[40]: 7 10.210.1.1/5354 reply api.example.org is 2.2.2.2",
				"Sep  1 00:13:02 dnsmasq[12]: 7 10.210.1.1/5353 reply www.example.com is <CNAME>",
				"Sep  1 00:13:02 dnsmasq[12]: 7 10.210.1.1/5353 reply edge.example.net is 1.1.1.1",
				"",
			].join("\n"),
		);
		const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("logs", sys.argv[1])
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)
found, unreadable = logs.resolutions([(sys.argv[2], float(sys.argv[3]))], {"10.210.1.1"}, {"1.1.1.1", "2.2.2.2"})
print(json.dumps({"found": sorted([list(key), answers] for key, answers in found.items()), "unreadable": unreadable}))
`;
		const r = spawnSync("python3", ["-c", script, logsTool, file, String(t0 + 3600)], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), {
			found: [
				[["10.210.1.1", "1.1.1.1"], [[t0 + 782, "www.example.com"]]],
				[["10.210.1.1", "2.2.2.2"], [[t0 + 781, "api.example.org"]]],
			],
			unreadable: [],
		});
	});

	test("lookup: who used an address, on this node and every node on the NAS, with company, machine and name", () => {
		const a = node("lookup-a");
		const b = node("lookup-b", a.nas);
		// The same agent address on both nodes at the same time (each node has its own client map), for two companies.
		// Each machine looked its name up first; the answer came by a CNAME.
		const fill = (n, company, machineId, start, name, bytes, extra = []) => {
			writeFileSync(join(n.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", company, machineId, t0 + 100)]));
			writeFileSync(
				join(n.log, `flows-${day}.jsonl`),
				lines([gap("logger started", t0 + 50), ...extra, opened("10.210.1.1", start), closed("10.210.1.1", start + 100, bytes), ...alive(t0 + 55, t0 + DAY)]),
			);
			writeFileSync(
				join(n.log, "dns.log"),
				[
					`Sep  1 00:13:00 dnsmasq[12]: 7 10.210.1.1/5353 query[A] ${name} from 10.210.1.1`,
					`Sep  1 00:13:00 dnsmasq[12]: 7 10.210.1.1/5353 reply ${name} is <CNAME>`,
					"Sep  1 00:13:00 dnsmasq[12]: 7 10.210.1.1/5353 reply edge.example.net is 1.1.1.1",
					"",
				].join("\n"),
			);
			// The first pass notes the day; the next day's seals the first and cuts dns.log.
			assert.equal(tend(n, t0 + 3600).status, 0);
			assert.equal(tend(n, t0 + DAY + 3 * 3600).status, 0);
		};
		const refusal = { event: "refused", src: "10.210.1.1", dst: "1.1.1.1", proto: "udp", dport: 443, rule: "open_limit", ts: t0 + 700 };
		fill(a, "cA", "mA", t0 + 800, "www.example.com", 500, [refusal]);
		fill(b, "cB", "mB", t0 + 850, "api.example.org", 300);
		assert.equal(ship(a, t0 + DAY + 4 * 3600).result.shipped, 4);
		assert.equal(ship(b, t0 + DAY + 4 * 3600, "node-b").result.shipped, 4);
		// Node a's own copy of its connection log is gone (the tender removes it after a week): the NAS's is read. Node
		// b's own folder is never read.
		rmSync(join(a.log, `flows-${day}.p001.jsonl.gz`));
		rmSync(b.log, { recursive: true });
		const now = t0 + DAY + 5 * 3600;
		const result = lookup(a, now, t0 + 900);
		assert.deepEqual([result.nodes, result.read], [["node-a", "node-b"], { from: "2026-08-31", to: next }]);
		assert.deepEqual(
			result.connections.map((c) => [c.node, c.company, c.machine, c.src, c.sport, c.dst, c.dport, c.name, c.start, c.end, c.bytesOut]),
			[
				["node-a", "cA", "mA", "10.210.1.1", 40000, "1.1.1.1", 443, "www.example.com", iso(t0 + 800), iso(t0 + 900), 500],
				["node-b", "cB", "mB", "10.210.1.1", 40000, "1.1.1.1", 443, "api.example.org", iso(t0 + 850), iso(t0 + 950), 300],
			],
		);
		assert.deepEqual(result.refused, [
			{ node: "node-a", at: iso(t0 + 700), company: "cA", machine: "mA", kind: "machine", member: null, src: "10.210.1.1", dst: "1.1.1.1", dport: 443, proto: "udp", rule: "open_limit" },
		]);
		assert.deepEqual([result.unknown, result.complete], [[], true]);
		// With every log there, nothing in the window means no one.
		const quiet = lookup(a, now, t0 + 2000);
		assert.deepEqual([quiet.connections, quiet.unknown, quiet.complete], [[], [], true]);
		const text = spawnSync("python3", [logsTool, ...lookupArgs(a, now, "2026-09-01T00:15:00Z")], { encoding: "utf8" });
		assert.equal(text.status, 0, text.stderr);
		assert.match(
			text.stdout,
			/^ {2}2026-09-01T00:13:20Z to 2026-09-01T00:15:00Z on node-a: company cA, machine mA; 10\.210\.1\.1:40000 to 1\.1\.1\.1:443 tcp, looked up as www\.example\.com; 500 bytes out, 900 in$/m,
		);
		assert.match(text.stdout, /^The answer is complete\.$/m);
	});

	test("lookup lists what the logs cannot say as not known, never as no one", () => {
		const g = node("gaps");
		const now = t0 + 3600;
		writeFileSync(join(g.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		const unknownIn = (records, ...extra) => {
			writeFileSync(join(g.log, `flows-${day}.jsonl`), lines(records));
			const result = lookup(g, now, t0 + 900, ...extra);
			return [result.unknown.map((u) => [u.node, u.from, u.to, u.what, u.why]), result.complete];
		};
		// The logger's alive lines all along, besides what the records say.
		const unknownFor = (records, ...extra) => unknownIn([...alive(t0, now), ...records], ...extra);
		const seen = [opened("10.210.1.1", t0 + 800), closed("10.210.1.1", t0 + 900, 500)];
		assert.deepEqual(unknownFor(seen), [[], true]);
		// A stretch of more than 3 minutes with no alive line, and no gap line to say why (the logger was stopped, or
		// it stopped and has not started again): not known from its last line on.
		const silent = "the connection logger wrote no line then (it writes one every minute while it logs): it was down, paused or could not write";
		assert.deepEqual(unknownIn([...alive(t0, t0 + 700), ...seen, ...alive(t0 + 1000, now)]), [
			[["node-a", iso(t0 + 660), iso(t0 + 1000), "connections", silent]],
			false,
		]);
		assert.deepEqual(unknownIn(seen), [[["node-a", iso(t0), iso(now), "connections", silent]], false]);
		// A pause as the logger writes it (no alive lines while paused): its own lines say so, once.
		const paused = "paused: the logs hold 2147483648 bytes, past their cap";
		const resumed = "resumed: 3 lines not written while paused";
		assert.deepEqual(unknownIn([...alive(t0, t0 + 700), gap(paused, t0 + 700), gap(resumed, t0 + 1000, t0 + 700), ...alive(t0 + 1000, now)]), [
			[["node-a", iso(t0 + 700), iso(t0 + 1000), "connections", resumed]],
			false,
		]);
		// Events conntrack could not deliver: since the line before.
		assert.deepEqual(unknownFor([opened("10.210.1.1", t0 + 100), gap("conntrack lost events", t0 + 860)]), [
			[["node-a", iso(t0 + 100), iso(t0 + 860), "connections", "conntrack lost events"]],
			false,
		]);
		// A pause, from its line to the one that says what it missed.
		assert.deepEqual(unknownFor([gap(paused, t0 + 700), gap(resumed, t0 + 1000, t0 + 700)]), [
			[["node-a", iso(t0 + 700), iso(t0 + 1000), "connections", resumed]],
			false,
		]);
		// The logger stopped while it paused: its pause ends where the next logger starts.
		assert.deepEqual(unknownFor([gap(paused, t0 + 700), gap("logger started", t0 + 1000, t0 + 690)]), [
			[
				["node-a", iso(t0 + 700), iso(t0 + 1000), "connections", paused],
				["node-a", iso(t0 + 690), iso(t0 + 1000), "connections", "logger started"],
			],
			false,
		]);
		// A pause not resumed in what was read: until now.
		assert.deepEqual(unknownFor([gap(paused, t0 + 700)]), [
			[["node-a", iso(t0 + 700), null, "connections", `${paused} (and not resumed in what was read)`]],
			false,
		]);
		// While paused, the logger empties dns.log every 5 seconds: the names since the last cut are not known, once.
		writeFileSync(join(g.log, "dns-2026-09-01T000500Z.log.gz"), gzipSync(""));
		const dropped = "paused: 120 bytes of the DNS record not kept";
		const emptied = [0, 5, 10].map((s) => gap(dropped, t0 + 700 + s));
		assert.deepEqual(unknownFor([...seen, gap(paused, t0 + 690), ...emptied, gap(resumed, t0 + 1000, t0 + 690)]), [
			[
				["node-a", iso(t0 + 690), iso(t0 + 1000), "connections", resumed],
				["node-a", iso(t0 + 300), iso(t0 + 710), "names", `3 gap lines say the DNS record was not kept, the last: ${dropped}`],
			],
			false,
		]);
		// Those lines come only while the logger pauses: with no pause line before them, it paused before what was read.
		assert.deepEqual(unknownFor([...seen, ...emptied]), [
			[
				["node-a", null, null, "connections", `the logger paused before what was read, its line says: ${dropped} (and not resumed in what was read)`],
				["node-a", iso(t0 + 300), iso(t0 + 710), "names", `3 gap lines say the DNS record was not kept, the last: ${dropped}`],
			],
			false,
		]);
		rmSync(join(g.log, "dns-2026-09-01T000500Z.log.gz"));
		// A deleted part: its day, and the grace for late lines.
		mkdirSync(join(g.log, "lost"));
		writeFileSync(join(g.log, "lost", `flows-${day}.p001.jsonl.gz.json`), JSON.stringify({ file: `flows-${day}.p001.jsonl.gz`, day, reason: "over the cap" }));
		assert.deepEqual(unknownFor(seen), [
			[["node-a", iso(t0), iso(t0 + DAY + 2 * 3600), "connections", `flows-${day}.p001.jsonl.gz was deleted (over the cap)`]],
			false,
		]);
		rmSync(join(g.log, "lost"), { recursive: true });
		// Another node that has shipped nothing since before the window ends, and has open files of the day.
		mkdirSync(join(g.nas, "node-b"));
		writeFileSync(join(g.nas, "node-b", "status.json"), JSON.stringify({ through: iso(t0 + 600), notShipped: { dns: [day], flows: [day] } }));
		assert.deepEqual(unknownFor(seen), [
			[
				["node-b", iso(t0 + 600), null, "connections", `this node has shipped nothing since ${iso(t0 + 600)}`],
				["node-b", iso(t0), iso(t0 + DAY), "names", `its dns of ${day} are not on the NAS yet`],
				["node-b", iso(t0), iso(t0 + DAY), "connections", `its flows of ${day} are not on the NAS yet`],
			],
			false,
		]);
		rmSync(join(g.nas, "node-b"), { recursive: true });
		// Another node whose logger stopped, then shipped its day: no line on the NAS says so, its silence does, to
		// what it has shipped.
		mkdirSync(join(g.nas, "node-b", day), { recursive: true });
		writeFileSync(join(g.nas, "node-b", "status.json"), JSON.stringify({ through: iso(t0 + 3000), notShipped: {} }));
		writeFileSync(join(g.nas, "node-b", day, `flows-${day}.p001.jsonl.gz`), gzipSync(lines(alive(t0, t0 + 700))));
		assert.deepEqual(unknownFor(seen), [[["node-b", iso(t0 + 660), iso(t0 + 3000), "connections", silent]], false]);
		// A node whose logs begin after the days read did not log then.
		rmSync(join(g.nas, "node-b", day), { recursive: true });
		mkdirSync(join(g.nas, "node-b", "2026-09-05"));
		assert.deepEqual(unknownFor(seen), [[], true]);
		rmSync(join(g.nas, "node-b"), { recursive: true });
		// The logger paused, or unable to write, now: its marker file, written when that began, says since when. (Its
		// gap line comes only when that ends.)
		const marker = join(g.root, "logger.marker");
		const full = "the node's disk has 4.0% free (floor 10%) and the exit's logs hold 2147483648 bytes (cap 1073741824)";
		writeFileSync(marker, `${full}\n`);
		utimesSync(marker, t0 + 900, t0 + 900);
		assert.deepEqual(unknownFor(seen, "--pause-file", marker), [
			[["node-a", iso(t0 + 900), null, "connections", `the connection log is paused now: ${full}`]],
			false,
		]);
		writeFileSync(marker, "cannot write the connection log: No space left on device\n");
		utimesSync(marker, t0 + 1000, t0 + 1000);
		assert.deepEqual(unknownFor(seen, "--failing-file", marker), [
			[["node-a", iso(t0 + 1000), null, "connections", "the connection logger is failing now: cannot write the connection log: No space left on device"]],
			false,
		]);
		utimesSync(marker, t0 + 2000, t0 + 2000);
		assert.deepEqual(unknownFor(seen, "--failing-file", marker), [[], true], "begun after the window");
		rmSync(marker);
		assert.deepEqual(unknownFor(seen, "--pause-file", marker, "--failing-file", marker), [[], true]);
		// The logger not running now (no sign of life for a minute): from its last one on, here within the window.
		const beat = join(g.root, "logger.heartbeat");
		writeFileSync(beat, "");
		utimesSync(beat, now - 5, now - 5);
		assert.deepEqual(unknownFor(seen, "--heartbeat", beat), [[], true]);
		utimesSync(beat, t0 + 1000, t0 + 1000);
		assert.deepEqual(unknownFor(seen, "--heartbeat", beat), [
			[["node-a", iso(t0 + 1000), null, "connections", `the connection logger is not running now (its last sign of life: ${iso(t0 + 1000)})`]],
			false,
		]);
		rmSync(beat);
		assert.deepEqual(unknownFor(seen, "--heartbeat", beat), [[["node-a", null, null, "connections", "the connection logger is not running now"]], false]);
		// No NAS, or one not mounted (no mount point there, or no marker in it): the other nodes are not searched.
		const alone = lookup({ ...g, nas: "" }, now, t0 + 900);
		assert.equal(alone.connections.length, 1);
		assert.deepEqual(alone.unknown.map((u) => [u.node, u.from, u.to, u.what]), [["*", iso(t0 + 600), iso(t0 + 1200), "connections"]]);
		assert.match(alone.unknown[0].why, /^no NAS folder is set .*: the other nodes were not searched$/);
		const bare = python([...lookupArgs(g, now, t0 + 900).filter((arg) => arg !== "--nas-any-folder"), "--json"]);
		assert.equal(bare.status, 0, bare.stderr);
		assert.equal(bare.result.connections.length, 1);
		assert.deepEqual(bare.result.unknown.map((u) => [u.node, u.from, u.to, u.what]), [["*", iso(t0 + 600), iso(t0 + 1200), "connections"]]);
		assert.match(bare.result.unknown[0].why, /is not a mount point: the NAS is not mounted, so the other nodes and what this one shipped were not searched$/);
		rmSync(join(g.nas, ".qorpera-agent-exit-logs"));
		assert.match(lookup(g, now, t0 + 900).unknown[0].why, /has no \.qorpera-agent-exit-logs: the NAS is not mounted, so the other nodes/);
	});

	test("lookup judges a silence at its full length, also where it crosses the edge of the days read", () => {
		const a = node("midnight");
		const now = t0 + DAY + 3 * 3600;
		// Both loggers stop after their alive line of 23:57:10; this node's starts again at 00:02 the next day, which it
		// has not shipped yet. The other node's stop runs past what it has shipped of the next day.
		const stopped = t0 + DAY - 170;
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines(alive(t0 + 10, stopped + 1)));
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines([gap("logger started", t0 + DAY + 120, stopped), ...alive(t0 + DAY + 125, now)]));
		mkdirSync(join(a.nas, "node-b", day), { recursive: true });
		writeFileSync(join(a.nas, "node-b", day, `flows-${day}.p001.jsonl.gz`), gzipSync(lines(alive(t0 + 10, stopped + 1))));
		const through = iso(now - 300);
		writeFileSync(join(a.nas, "node-b", "status.json"), JSON.stringify({ through, notShipped: { flows: [next] } }));
		// Each day's counts say who was plugged in at its end, so a read from the next day on knows the companies.
		writeFileSync(join(a.log, `counts-${day}.json`), JSON.stringify({ pluggedInAtEnd: {} }));
		writeFileSync(join(a.nas, "node-b", day, `counts-${day}.json`), JSON.stringify({ pluggedInAtEnd: {} }));
		const silent = "the connection logger wrote no line then (it writes one every minute while it logs): it was down, paused or could not write";
		const unknownAt = (at, ...extra) => {
			const result = lookup(a, now, at, "--window", "60", ...extra);
			return [result.unknown.map((u) => [u.node, u.from, u.to, u.what, u.why]), result.complete];
		};
		// Asked about 23:58:30: 170 seconds of the stop fall in the day, the rest past midnight, which node-b has not
		// shipped (listed on its own, from midnight on).
		assert.deepEqual(unknownAt(t0 + DAY - 90), [
			[
				["node-a", iso(stopped), iso(t0 + DAY + 120), "connections", "logger started"],
				["node-b", iso(stopped), iso(t0 + DAY), "connections", silent],
			],
			false,
		]);
		// Only that day read: the line that ends this node's stop is in the next, read only for that.
		assert.deepEqual(unknownAt(t0 + DAY - 90, "--days", "0"), [
			[
				["node-a", iso(stopped), iso(t0 + DAY), "connections", silent],
				["node-b", iso(stopped), iso(t0 + DAY), "connections", silent],
			],
			false,
		]);
		// The start of the days read: node-b has shipped the next day, its first line there at 00:02. Its stop began in
		// the day before, read only for its last line.
		mkdirSync(join(a.nas, "node-b", next));
		writeFileSync(join(a.nas, "node-b", next, `flows-${next}.p001.jsonl.gz`), gzipSync(lines(alive(t0 + DAY + 120, now))));
		writeFileSync(join(a.nas, "node-b", "status.json"), JSON.stringify({ through, notShipped: {} }));
		assert.deepEqual(unknownAt(t0 + DAY + 60, "--days", "0"), [
			[
				["node-a", iso(stopped), iso(t0 + DAY + 120), "connections", "logger started"],
				["node-b", iso(t0 + DAY), iso(t0 + DAY + 120), "connections", silent],
			],
			false,
		]);
		// With every line there, a stop of under 3 minutes across midnight is no silence.
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines(alive(stopped + 170, now)));
		writeFileSync(join(a.nas, "node-b", next, `flows-${next}.p001.jsonl.gz`), gzipSync(lines(alive(stopped + 170, now))));
		assert.deepEqual(unknownAt(t0 + DAY - 90, "--days", "0"), [[], true]);
		assert.deepEqual(unknownAt(t0 + DAY + 60, "--days", "0"), [[], true]);
	});

	test("lookup counts only the lines a paused logger never writes as signs that it was logging", () => {
		const a = node("paused-gaps");
		const now = t0 + DAY + 6 * 3600;
		// The logger paused before the day and went on at 05:00 the next day. All the day long a machine went over its
		// share of refusals: a paused logger still writes that gap line, one a minute, the last at 23:58:20.
		const unlogged = (from, to) => Array.from({ length: Math.ceil((to - from) / 60) }, (_, i) => gap("12 refused packets of unlogged flows", from + 60 * i));
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines(unlogged(t0 + 20, t0 + DAY - 60)));
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines([...unlogged(t0 + DAY + 20, t0 + DAY + 5 * 3600), gap("resumed: 0 lines not written while paused", t0 + DAY + 5 * 3600), ...alive(t0 + DAY + 5 * 3600 + 5, now)]));
		const silent = "the connection logger wrote no line then (it writes one every minute while it logs): it was down, paused or could not write";
		const result = lookup(a, now, t0 + DAY - 60, "--window", "30", "--days", "0");
		assert.deepEqual(
			[result.unknown.map((u) => [u.node, u.from, u.to, u.what, u.why]), result.complete],
			[[["node-a", iso(t0 + DAY - 100), iso(t0 + DAY), "connections", silent]], false],
		);
	});
});

const DOCKERFILE = `FROM ubuntu:26.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
	nftables iproute2 dnsmasq-base conntrack python3 busybox procps && rm -rf /var/lib/apt/lists/*
`;
const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// Default-on again (E2a): #748 made it opt-in after docker0 vanished on node01's test machine; the cause was an E2b
// draft run's `modprobe -r br_netfilter` bare on that machine, not this proof (see the header).
describe("the exit on a stand-in node", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	test("the root proof passes inside a privileged, network-less container", () => {
		const image = `qorpera-agent-exit-test:${sha256(DOCKERFILE).slice(0, 12)}`;
		if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
			const build = spawnSync("docker", ["build", "-t", image, "-"], { input: DOCKERFILE, encoding: "utf8" });
			assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
		}
		// The proof must never change the machine it runs on: its bridges (docker0 above all) are all still there after.
		const bridges = () =>
			new Set(
				spawnSync("ip", ["-br", "link", "show", "type", "bridge"], { encoding: "utf8" })
					.stdout.split("\n")
					.map((line) => line.split(/\s+/)[0])
					.filter(Boolean),
			);
		const before = bridges();
		const proof = spawnSync(
			"docker",
			["run", "--rm", "--privileged", "--network", "none", "-v", `${here}:/w:ro`, image, "bash", "/w/test/proof.sh"],
			{ encoding: "utf8", timeout: 540_000 },
		);
		const after = bridges();
		assert.deepEqual(
			["docker0", "lxdbr0", "testmach0"].filter((name) => before.has(name) && !after.has(name)),
			[],
			"a bridge of the machine running the proof disappeared",
		);
		assert.equal(proof.status, 0, `${proof.stdout}\n${proof.stderr}`);
		assert.match(proof.stdout, /ALL PASSED/);
	});
});
