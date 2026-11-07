import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expandTestFixture } from "./test-hosted-db.mjs";
import {
	answeredUnit,
	deadlocksIn,
	findSecrets,
	fixtureSql,
	judge,
	keepHandover,
	literal,
	loopFileSha256,
	msFromNanoseconds,
	NEW_DISK,
	nicStandIn,
	NOW_MS,
	parseArgs,
	parseSocketUnits,
	parseVsockListener,
	postgrestFailure,
	postgrestStatus,
	replaceCounted,
	sqlError,
	V2,
	WORDS,
} from "./test-test-machine-folder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = "a".repeat(64);
const argv = [
	"--project", "qtm-0123abcd", "--pool", "qtm-0123abcd", "--image", digest, "--bootstrap-sha256", "b".repeat(64),
	"--helper-sha256", "c".repeat(64), "--folder-binary", "/opt/p4/folder", "--work", "/var/tmp/p4", "--record",
	"/var/tmp/p4/record.json", "--execute",
];

test("preflight is the default; execution names the claimed project, the image's digests and absolute paths", () => {
	assert.deepEqual(parseArgs([]), { execute: false });
	const options = parseArgs(argv);
	assert.equal(options.execute, true);
	assert.equal(options.project, "qtm-0123abcd");
	assert.equal(options.record, "/var/tmp/p4/record.json");
	for (const extra of [["--execute"], ["--project", "qtm-0123abcd"], ["--unexpected", "x"], ["--record"]])
		assert.throws(() => parseArgs([...argv, ...extra]), extra[0]);
	for (const [flag, value] of [
		["--project", "machines"], ["--project", "qtm-0123ABCD"], ["--pool", "qtm-ffffffff"], ["--image", "short"],
		["--bootstrap-sha256", "B".repeat(64)], ["--helper-sha256", "c".repeat(63)], ["--folder-binary", "folder"],
		["--work", "/var/tmp/p4/../p4"], ["--record", "/var/tmp/other/record.json"],
	]) {
		const changed = [...argv];
		changed[changed.indexOf(flag) + 1] = value;
		if (flag === "--project") changed[changed.indexOf("--pool") + 1] = value;
		assert.throws(() => parseArgs(changed), `${flag} ${value}`);
	}
	assert.throws(() => parseArgs(argv.filter((arg, index) => arg !== "--image" && argv[index - 1] !== "--image")));
});

test("SQL literals quote text and JSON, and leave numbers, booleans and null bare", () => {
	assert.equal(literal(null), "null");
	assert.equal(literal(undefined), "null");
	assert.equal(literal(5), "5");
	assert.equal(literal(false), "false");
	assert.equal(literal("it's"), "'it''s'");
	assert.equal(literal({ name: "o'p" }), `'{"name":"o''p"}'::jsonb`);
	assert.equal(literal(["a"]), `'["a"]'::jsonb`);
});

test("database errors answer as PostgREST does, with the SQLSTATE and the DETAIL the executor reads", () => {
	assert.equal(postgrestStatus("42501"), 403);
	assert.equal(postgrestStatus("23505"), 409);
	assert.equal(postgrestStatus("P0001"), 400);
	assert.equal(postgrestStatus("42883"), 404);
	assert.equal(postgrestStatus("08006"), 503);
	assert.equal(postgrestStatus("40001"), 500);
	assert.equal(postgrestStatus("22023"), 400);
	const failed = postgrestFailure(
		'psql:<stdin>:4: ERROR:  42501: Folder view open refused\nDETAIL:  {"refusal":"wrong_machine"}\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n',
	);
	assert.deepEqual(failed, {
		status: 403,
		value: { code: "42501", details: '{"refusal":"wrong_machine"}', hint: null, message: "Folder view open refused" },
	});
	assert.equal(postgrestFailure("psql:<stdin>:3: ERROR:  P0001: Base assertion: x\n").value.details, null);
	assert.equal(postgrestFailure("docker: not found"), null);
});

test("a deadlock is kept with its SQLSTATE, both waits, the row lock and the functions it was raised in", () => {
	const text = [
		"psql:<stdin>:4: ERROR:  40P01: deadlock detected",
		"DETAIL:  Process 44251 waits for ShareLock on transaction 13953; blocked by process 44252.",
		"Process 44252 waits for ShareLock on transaction 13952; blocked by process 44251.",
		"HINT:  See server log for query details.",
		'CONTEXT:  while locking tuple (0,8) in relation "qorpera_runtime_machine_allocations"',
		'SQL statement "SELECT 1 from public.qorpera_runtime_machine_allocations',
		'  where id = any(v_ids) order by id for update"',
		"PL/pgSQL function qorpera_lock_machine_allocations(uuid[]) line 4 at PERFORM",
		"PL/pgSQL function public.qorpera_authorize_executor_machine(jsonb) line 31 at PERFORM",
		"LOCATION:  DeadLockReport, deadlock.c:1135",
		"",
	].join("\n");
	assert.deepEqual(sqlError(text), {
		code: "40P01",
		message: "deadlock detected",
		details:
			"Process 44251 waits for ShareLock on transaction 13953; blocked by process 44252.\n" +
			"Process 44252 waits for ShareLock on transaction 13952; blocked by process 44251.",
		lock: { relation: "qorpera_runtime_machine_allocations", tuple: "(0,8)", while: "locking" },
		functions: ["qorpera_lock_machine_allocations", "public.qorpera_authorize_executor_machine"],
	});
	assert.equal(postgrestFailure(text).value.details, "Process 44251 waits for ShareLock on transaction 13953; blocked by process 44252.");
	assert.deepEqual(sqlError("psql:<stdin>:3: ERROR:  P0001: Base assertion: x\n"), {
		code: "P0001", message: "Base assertion: x", details: null, lock: null, functions: [],
	});
	assert.equal(sqlError("ERROR:  deadlock detected\nDETAIL:  Process 1 waits"), null, "psql's terse error has no SQLSTATE");
	assert.equal(sqlError("docker: not found"), null);
	const found = deadlocksIn({
		service: { rpcFailures: [
			{ t: 9, method: "qorpera_folder_view_open", code: "42501", details: null, message: "x", in: [], lock: null },
			{ t: 2911.4, method: "qorpera_authorize_executor_machine", code: "40P01", details: "Process 1 waits", in: ["f"],
				lock: { relation: "r", tuple: "(0,8)", while: "locking" }, waits: "Process 1 waits\nProcess 2 waits" },
		] },
		keeper: { errors: [{ t: 2005.6, function: "p4.mc_observe", code: "40P01", waits: "w", lock: null, in: [] }, { t: 3, function: "x", error: "boom" }] },
	});
	assert.deepEqual(found, [
		{ t: 2005.6, function: "p4.mc_observe", code: "40P01", in: [], lock: null, waits: "w" },
		{ t: 2911.4, function: "qorpera_authorize_executor_machine", code: "40P01", in: ["f"],
			lock: { relation: "r", tuple: "(0,8)", while: "locking" }, waits: "Process 1 waits\nProcess 2 waits" },
	]);
});

test("the fixture's text is replaced exactly as often as expected, or the proof stops", () => {
	assert.equal(replaceCounted("a b a", "a", "c", 2), "c b c");
	assert.equal(replaceCounted("a b a", "a", "c", null), "c b c");
	assert.throws(() => replaceCounted("a b a", "a", "c", 1), /P4_FIXTURE_CHANGED/);
	assert.throws(() => replaceCounted("b", "a", "c", null), /P4_FIXTURE_CHANGED/);
});

test("628's fixture is cut before its checks and keeps three leased runs, the helpers and the executor", () => {
	const expanded = expandTestFixture("628_runtime_company_machines.test.sql", (name) =>
		readFileSync(join(root, "supabase", "tests", name), "utf8"),
	);
	const policy = { providerId: "machine-fixture", project: "qtm-0123abcd", storagePool: "qtm-0123abcd" };
	const sql = fixtureSql(expanded, {
		project: "qtm-0123abcd",
		nodeSha: "d".repeat(64),
		policy,
		leaseSha: { alice: "1".repeat(64), bob: "2".repeat(64), carol: "3".repeat(64) },
	});
	assert.ok(!sql.includes("-- 1. Without a machine executor"));
	assert.ok(!sql.includes("pg_temp.mc_"));
	assert.ok(sql.includes("create function p4.mc_start("), "628's helpers live in schema p4");
	// The keeper's observation in two transactions: 628's mc_observe, made to take the context it read before.
	const observeWith = /^create function p4\.mc_observe_with\(p_id uuid,p_sha text,p_cpu bigint,p_memory bigint,p_context jsonb\) returns void language plpgsql as \$\$\n[\s\S]*?^\$\$;$/m.exec(sql)?.[0];
	assert.ok(observeWith, "the keeper's observation helper lives in schema p4");
	assert.ok(!observeWith.includes("qorpera_runtime_node_inventory_context") && !observeWith.includes("v_context"));
	assert.ok(observeWith.includes("p_context ->> 'contextSha256'") && observeWith.includes("jsonb_array_elements(p_context -> 'allocations')"));
	assert.ok(observeWith.includes("public.qorpera_observe_runtime_node_inventory(") && observeWith.includes("'project','qtm-0123abcd','name'"));
	assert.ok(sql.includes("create function p4.mc_observe(p_id uuid"), "628's own mc_observe stays for mc_node");
	// The digest's function: its definition, and the three runs' lease digests it stands in for.
	assert.equal(sql.split("pg_temp.p4_lease_sha()").length - 1, 4);
	assert.ok(!sql.includes("repeat('3', 64)"));
	assert.ok(sql.includes("'project','qtm-0123abcd','name'"));
	assert.ok(!sql.includes("'project','machines','name'"));
	for (const [name, sha] of [["alice", "1"], ["bob", "2"], ["carol", "3"]])
		assert.ok(sql.includes(`select set_config('p4.lease_sha', '${sha.repeat(64)}', false) \\g /dev/null`), name);
	assert.ok(sql.indexOf("'p4.lease_sha', '1") < sql.indexOf("pg_temp.p4_lease_sha()"), "Alice's digest is set before her run starts");
	assert.ok(sql.includes(`qorpera_configure_machine_executor('p4-executor', '${"d".repeat(64)}', true, ${literal(policy)},`));
	assert.ok(sql.indexOf("begin;") < sql.indexOf("insert into p4.setup values ('alice'"));
	assert.match(sql, /select '@@p4-' \|\| name \|\| ' ' \|\| value::text from p4\.setup order by name;\ncommit;\n$/);
	assert.throws(() => fixtureSql(expanded.replace("-- 1. Without a machine executor", "-- 1."), { project: "qtm-0123abcd" }), /no cut/);
});

/** A fake LXD client: what it was asked, and an instance as LXD answers it. */
function fakeClient() {
	const calls = [];
	return {
		calls,
		secret: "kept",
		async submitInstanceOperation(project, operation) {
			calls.push(["submit", project, operation]);
			return { id: "op" };
		},
		async getInstance(project, name) {
			calls.push(["get", project, name]);
			return { name, devices: { root: { type: "disk" } }, expandedDevices: { root: { type: "disk" } }, config: {} };
		},
		async execInstanceStream(project, name, request) {
			calls.push(["stream", project, name, request.command]);
			return { exitCode: 0 };
		},
		describe() {
			return this.secret;
		},
	};
}

test("the stand-in client makes machines without their NIC, answers with it, and hands over each folder hand-over", async () => {
	const client = fakeClient();
	const nics = new Map();
	const handovers = [];
	const proxied = nicStandIn(client, nics, (handover) => handovers.push({ ...handover, callsBefore: client.calls.length }));
	const nic = { type: "nic", network: "qagent0", hwaddr: "0e:51:0a:d2:01:0a" };
	const request = { name: "qorpera-machine-1", devices: { root: { type: "disk" }, network: nic }, config: {} };
	await proxied.submitInstanceOperation("qtm-0123abcd", { action: "create", request });
	assert.deepEqual(client.calls[0][2].request.devices, { root: { type: "disk" } });
	assert.deepEqual(request.devices.network, nic, "the host's own request is not changed");
	assert.deepEqual(nics.get("qorpera-machine-1"), nic);
	await proxied.submitInstanceOperation("qtm-0123abcd", { action: "start", name: "qorpera-machine-1" });
	assert.deepEqual(client.calls[1][2], { action: "start", name: "qorpera-machine-1" });

	const made = await proxied.getInstance("qtm-0123abcd", "qorpera-machine-1");
	assert.deepEqual(made.devices, { root: { type: "disk" }, network: nic });
	assert.deepEqual(made.expandedDevices, { root: { type: "disk" }, network: nic });
	assert.equal("expanded_devices" in made, false);
	const other = await proxied.getInstance("qtm-0123abcd", "qorpera-machine-2");
	assert.deepEqual(other.devices, { root: { type: "disk" } });

	const stdin = Buffer.from('{"viewId":"v"}');
	await proxied.execInstanceStream("qtm-0123abcd", "qorpera-machine-1", {
		command: ["/usr/bin/node", "/opt/qorpera-machine/cloud-machine-guest.mjs", "n", "folder-mount"], stdin,
	});
	await proxied.execInstanceStream("qtm-0123abcd", "qorpera-machine-1", { command: ["true"], stdin: Buffer.alloc(0) });
	assert.equal(handovers.length, 1);
	assert.equal(handovers[0].name, "qorpera-machine-1");
	assert.equal(handovers[0].stdin.toString(), '{"viewId":"v"}');
	assert.equal(handovers[0].callsBefore, 4, "the hand-over is taken before the guest is asked");
	assert.equal(client.calls.filter((call) => call[0] === "stream").length, 2);
	assert.equal(proxied.describe(), "kept", "other methods keep their client");
	assert.equal(proxied.secret, "kept");
});

test("every boot's view pass is a secret the moment its hand-over is seen, a run that fails early too", async () => {
	const client = fakeClient();
	const handovers = [];
	const secrets = { objectsToken: "o".repeat(43) };
	const proxied = nicStandIn(client, new Map(), keepHandover(handovers, secrets));
	const mount = (stdin) =>
		proxied.execInstanceStream("qtm-0123abcd", "qorpera-machine-1", {
			command: ["/usr/bin/node", "/opt/qorpera-machine/cloud-machine-guest.mjs", "n", "folder-mount"], stdin: Buffer.from(stdin),
		});
	const handover = (viewId, pass) => JSON.stringify({ environmentId: "env", viewId, pass });
	await mount(handover("view-1", "p".repeat(43)));
	// The second boot's view: a pass of its own.
	await mount(handover("view-2", "q".repeat(43)));
	assert.deepEqual(handovers.map((h) => [h.name, h.viewId]), [["qorpera-machine-1", "view-1"], ["qorpera-machine-1", "view-2"]]);
	assert.deepEqual(secrets, { objectsToken: "o".repeat(43), viewPass1: "p".repeat(43), viewPass2: "q".repeat(43) });
	assert.deepEqual(findSecrets(JSON.stringify({ first: "p".repeat(43), second: "q".repeat(43) }), secrets), ["viewPass1", "viewPass2"]);
	assert.deepEqual(findSecrets(`{"wake":"${"q".repeat(43)}"}`, secrets), ["viewPass2"], "the second boot's pass is looked for too");
	// The guest is never asked (the run fails there): the pass is a secret already.
	client.execInstanceStream = async () => {
		throw new Error("LXD_UNAVAILABLE");
	};
	await assert.rejects(mount(handover("view-3", "r".repeat(43))), /LXD_UNAVAILABLE/);
	assert.equal(secrets.viewPass3, "r".repeat(43));
	// A hand-over that is not the JSON expected is a secret whole.
	await assert.rejects(mount("a hand-over that is not JSON at all"), /LXD_UNAVAILABLE/);
	assert.equal(secrets.viewPass4, "a hand-over that is not JSON at all");
	assert.equal(handovers[3].viewId, null);
	assert.equal(handovers.length, 4);
});

test("the record's secrets are found by value, and short values are not secrets", () => {
	const secrets = { "holder:alice": "x".repeat(43), viewPass1: "y".repeat(43), short: "abc" };
	assert.deepEqual(findSecrets(`{"a":"${"y".repeat(43)}","b":"abc"}`, secrets), ["viewPass1"]);
	assert.deepEqual(findSecrets("nothing here", secrets), []);
});

const STAFF = { alice: "92400000-0000-4000-8000-000000000030", bob: "92400000-0000-4000-8000-000000000031", carol: "92400000-0000-4000-8000-000000000032" };
const OWNER = "92400000-0000-4000-8000-000000000001";
const ids = {
	a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000001", c: "cccccccc-0000-4000-8000-000000000001",
	m: "dddddddd-0000-4000-8000-000000000001", k: "eeeeeeee-0000-4000-8000-000000000001", d: "ffffffff-0000-4000-8000-000000000001",
	l: "11111111-0000-4000-8000-000000000001", s: "22222222-0000-4000-8000-000000000001", aLong: "33333333-0000-4000-8000-000000000001",
	c0: "44444444-0000-4000-8000-000000000001",
};
const commit = (actor, credits, units) => ({
	actorKind: "staff_agent", actorId: STAFF[actor], requesterId: OWNER, runId: `run-${actor}`, viewKind: "test_machine", credits,
	units: units.map(([path, unitCredits]) => ({ op: "write", path, credits: unitCredits })),
});
const SEED_OUT = "# P4\n\nThe company folder, as a test machine reads it.\n";
const mounted = () => ({ company: "mounted" });
const held = (heldBack) => ({ company: "mounted", heldBack });
const authorizeRefused = () => ({ t: 1, message: "Machine command gateway unavailable", code: null, folderLost: null, lost: null });
const companyWide = () => ({ t: 1, method: "qorpera_authorize_machine_command", code: "42501", details: null,
	message: "Machine needs the company-wide view" });
// L's ticks on the host's clock (the guest's offset 0): the quiet window has three, a read takes the fourth. A save of
// tick `n` (written at `t`) is a commit with a seq whose loop.txt unit was saved as a version with that tick's bytes.
const loopCommit = (seq, createdAtMs, n, t, last = false) => ({ seq, createdAtMs, credits: [ids.l], actorId: STAFF.alice,
	outcome: "saved", reason: null, version: `version-${seq}`, fileSha256: loopFileSha256(n, t, last) });
// The vsock listeners node01's test machine (a KVM guest) showed in run 1, with this run's bridge on 5250.
const BRIDGE_PID = 2537059;
const listener = (cid, port, name, pid, exe, unit = null) => ({ cid, port, processes: [{ name, pid, exe }], unit });
const vsockListenersSeen = () => [
	listener("*", 22, "systemd", 1, "/usr/lib/systemd/systemd", "sshd-vsock.socket"),
	listener("2", 7114, "lxd", 15088, "/snap/lxd/40424/sbin/lxd"),
	listener("*", 8443, "lxd-agent", 1027, "/run/lxd_agent/lxd-agent"),
	listener("*", 5250, "qorpera-folder", BRIDGE_PID, "/tmp/qorpera-p4.OI0AYHO5/qorpera-folder"),
];

/** Evidence every check passes. */
function passing() {
	return {
		steps: {
			boot: {
				mounted: true, placementId: "placement-1",
				view: { id: "view-1", kind: "test_machine", state: "open", staffAgentId: STAFF.alice, runId: null },
				placement: { id: "placement-1", schema: V2, repositoryWorkerId: false },
				devices: [{ name: "root", type: "disk", path: "/" }],
				startReceipt: { state: "running", exitCode: null, output: "", totalBytes: 0, companyFolder: held(WORDS.heldStart) },
				receipt: { state: "succeeded", exitCode: 0, output: `p4\nalice.txt\nseed.md\n${SEED_OUT}no-repository\n`, companyFolder: mounted() },
			},
			credit: {
				commandId: ids.a, runId: "run-alice",
				start: { state: "running", exitCode: null, output: "", totalBytes: 0, companyFolder: held(WORDS.heldStart) },
				heldRead: { state: "running", exitCode: null, output: "", totalBytes: 0, companyFolder: held(WORDS.heldUnanswered) },
				heldBoundaries: 3,
				released: { state: "succeeded", exitCode: 0, output: "wrote-alice\n", totalBytes: 12, companyFolder: mounted() },
				releasedFirst: true,
				commits: [commit("alice", [ids.a], [["p4/alice.txt", [ids.a]]])],
			},
			overlap: {
				b: ids.b, c: ids.c, receipts: { b: { exitCode: 0 }, c: { exitCode: 0 } },
				commits: [
					commit("bob", [ids.b], [["p4/bob-only.txt", [ids.b]]]),
					commit("bob", [ids.b, ids.c], [["p4/shared.txt", [ids.c, ids.b]]]),
					commit("carol", [ids.c], [["p4/carol-after.txt", [ids.c]]]),
				],
			},
			reads: {
				viewId: "view-1", viewReads: ["p4", "p4/alice.txt", "p4/seed.md"], aliceRunReads: ["p4", "p4/alice.txt", "p4/seed.md"],
				bobBefore: [], bobAfter: ["p4/seed.md", "p4", "p4/alice.txt"],
				bobAuthority: { audience: "company", staffAgentId: STAFF.bob, requesterUserId: OWNER, readsRoot: true },
				bob: { schema: "qorpera.folder-inherit/v1", viewId: "view-1", reads: 3, replay: false },
				alice: { schema: "qorpera.folder-inherit/v1", viewId: "view-1", reads: 3, replay: false },
			},
			vsockPorts: {
				receipt: { exitCode: 0 },
				probe: { scanned: 65535, answered: [22, 5250, 7114, 8443], timeoutCount: 0, errnos: { ECONNRESET: 65531 } },
				bridgePid: BRIDGE_PID,
				virt: "kvm",
				listeners: vsockListenersSeen(),
				ports: [22, 5250, 7114, 8443].map((port) => ({ port })),
			},
			detached: {
				receipt: { exitCode: 0, output: "started\n" }, endedAtMs: 1000, closedAt: 1500, goAt: 2000, go: 0, running: [], unclosed: [],
				commits: [{ ...commit("alice", null, [["p4/detached.txt", null]]), viewId: "view-1", createdAtMs: 4100 }],
			},
			loop: {
				commandId: ids.l, clock: { offsetMs: 0, uncertaintyMs: 5 }, quiet: { fromAt: 100000, toAt: 136000, boundaries: 0 },
				ticks: [110000, 120000, 130000, 140000, 150000].map((at, i) => ({ n: i + 1, t: at, at })),
				commits: [
					loopCommit(11, 112050, 1, 110000), loopCommit(12, 122030, 2, 120000), loopCommit(13, 132040, 3, 130000),
					loopCommit(14, 140700, 4, 140000), loopCommit(15, 152000, 5, 150000), loopCommit(16, 155100, 6, 155000, true),
				],
				boundarySeqs: [9, 14, 16],
				reads: [{ at: 140600, hit: { by: "read", byCommand: ids.l, outcome: "saved", seq: 14 } }],
				cancel: { report: { outcome: "saved", seq: 16 } }, final: { state: "cancelled" }, last: { n: 6, t: 155000, last: true },
			},
			refusals: {
				m: { commandId: ids.m, entries: 1 },
				k: {
					row: { state: "lost", endedAt: "t" }, resend: "MACHINE_COMMAND_ENDED", report: { path: "p4/k.txt", outcome: "refused", reason: "command_ended" }, entries: 0,
					resent: { code: "MACHINE_COMMAND_ENDED", folderLost: null, lost: null }, read: { receipt: { companyFolder: mounted() } },
				},
				commits: [commit("carol", [ids.m], [["p4/m.txt", [ids.m]]])],
				intruder: {
					name: "qorpera-machine-2", viewId: "view-2", mount: "closed",
					answer: { schema: "qorpera.machine-guest-folder/v1", viewId: "view-2", mount: "closed" },
					opens: [
						{ viewId: "view-2", role: "feed", lookup: "found", machine: "qorpera-machine-2", ok: false, code: "VIEW_REFUSED" },
						{ viewId: "view-2", role: "feed", lookup: "found", machine: "qorpera-machine-2", ok: false, code: "VIEW_REFUSED" },
					],
				},
				stillReads: { exitCode: 0, output: "a\n", companyFolder: mounted() },
			},
			stop: {
				viewId: "view-1", bootId: "boot-1", outcome: { state: "done" }, finalBoundary: { final: ["view-1"] }, restarted: true,
				view: { state: "closed", closedAt: "t" }, instanceStatus: "Stopped",
				loop: {
					commandId: ids.s, clock: { offsetMs: 0, uncertaintyMs: 5 }, last: { n: 30, t: 200000, last: true },
					reports: [{ at: 200020, answeredAt: 200300, final: ["view-1"], seq: 20, outcome: "saved" }], powerOffAt: 201000,
				},
				wake: {
					mounted: true, bootId: "boot-2", view: { id: "view-2", state: "open" },
					receipt: { exitCode: 0, output: "a\nc\n", companyFolder: mounted() },
				},
			},
			noRootRead: {
				revoked: { count: 3 }, readsRoot: false, outcome: { folder: "FOLDER_NONE:REFUSED", placementId: "placement-2" },
				look: {
					start: { state: "running", companyFolder: { company: "none", why: WORDS.refused } },
					receipt: {
						exitCode: 0, output: "no-company\nentries 0\nno-unit\nno-marker\n",
						companyFolder: { company: "none", why: `${WORDS.refused}: Folder view needs the company-wide view` },
					},
				},
				placement: { id: "placement-2", folderUncheckedAt: "t" }, views: [],
				openFailures: [{ t: 1, method: "qorpera_folder_view_open", code: "42501", details: null, message: "Folder view needs the company-wide view" }],
			},
			reverse: {
				install: { exitCode: 0, output: "marker\ninstalled\n" }, restored: 3, readsRoot: true, stopped: { state: "done" },
				retired: { folder: "FOLDER_RETIRED:UNCHECKED", placementId: "placement-2" },
				old: { id: "placement-2", retiredAt: "t", folderRetireReason: "unchecked" },
				openFailures: [{ t: 1, method: "qorpera_folder_view_open", code: "42501", details: NEW_DISK,
					message: "Test machine disk was used without the folder check" }],
				mounted: { folder: "FOLDER_MOUNTED", placementId: "placement-3" }, placement: { id: "placement-3", schema: V2 },
				look: {
					receipt: { exitCode: 0, output: `company-mounted\nentries 2\nno-unit\nno-marker\n${SEED_OUT}`, companyFolder: mounted() },
				},
			},
			narrowed: {
				mounted: { folder: "FOLDER_MOUNTED", placementId: "placement-4" }, aliceBefore: { receipt: { companyFolder: mounted() } },
				revoked: { count: 2 }, readsRoot: false,
				carol: { run: { refused: authorizeRefused() }, read: { refused: authorizeRefused() }, cancel: { refused: authorizeRefused() } },
				carolFailures: [companyWide(), companyWide(), companyWide()],
				aliceDuring: { receipt: { state: "running", companyFolder: mounted() } },
				viewClosed: { folder: "FOLDER_RESTART:VIEW_CLOSED", placementId: "placement-4" },
				ended: { receipt: { state: "running", companyFolder: { company: "none", why: WORDS.endedViewClosed, heldBack: WORDS.heldEnded } } },
				retired: { folder: "FOLDER_RETIRED:STARTER", placementId: "placement-4" }, restored: 2, readsRootAgain: true,
				old: { id: "placement-4", retiredAt: "t", folderRetireReason: "starter" },
				openFailures: [{ t: 1, method: "qorpera_folder_view_open", code: "42501", details: NEW_DISK,
					message: "Folder view needs the company-wide view" }],
				newMounted: { folder: "FOLDER_MOUNTED", placementId: "placement-5" },
				aLongRow: { id: ids.aLong, state: "lost", folderLostReason: "restart_view_closed" },
				aliceAfter: { refused: { code: "MACHINE_COMMAND_ENDED", folderLost: "restart_view_closed", lost: WORDS.lostViewClosed } },
				look: { receipt: { exitCode: 0, output: "company-mounted\nentries 2\nno-unit\nno-marker\n", companyFolder: mounted() } },
			},
		},
		cleanupErrors: [],
		service: { bridgeExit: null },
	};
}

const failing = {
	bootMounted: (e) => {
		e.steps.boot.mounted = false;
	},
	v2Binding: (e) => {
		e.steps.boot.placement.schema = "qorpera.lxd-company-machine/v1";
	},
	reportOnReceipts: (e) => {
		e.steps.credit.released.companyFolder.heldBack = WORDS.heldUnanswered;
	},
	heldUntilReleased: (e) => {
		// The start answered with the output while every boundary was held.
		Object.assign(e.steps.credit.start, { output: "wrote-alice\n", totalBytes: 12 });
	},
	creditedToCommand: (e) => {
		e.steps.credit.commits[0].actorId = STAFF.bob;
	},
	overlapCredited: (e) => {
		e.steps.overlap.commits[1].units[0].credits = [ids.b];
	},
	readsTakenIn: (e) => {
		e.steps.reads.bob = { error: "psql:<stdin>:4: ERROR:  42501: A run inherits a test machine's reads only with the company-wide view" };
		e.steps.reads.bobAfter = [];
	},
	vsockPorts: (e) => {
		e.steps.vsockPorts.virt = "none";
	},
	detached: (e) => {
		e.steps.detached.commits[0].units[0].credits = [ids.d];
	},
	loop: (e) => {
		e.steps.loop.quiet.boundaries = 1;
	},
	stopClosed: (e) => {
		e.steps.stop.view.state = "open";
	},
	stopWhileRunning: (e) => {
		e.steps.stop.loop.powerOffAt = 200100;
	},
	secondBoot: (e) => {
		e.steps.stop.wake.bootId = "boot-1";
	},
	endedRefused: (e) => {
		e.steps.refusals.k.entries = 1;
	},
	otherMachineRefused: (e) => {
		e.steps.refusals.intruder.mount = "unanswered";
		e.steps.refusals.intruder.answer.mount = "unanswered";
	},
	noRootRead: (e) => {
		e.steps.noRootRead.outcome.folder = "FOLDER_MOUNTED";
	},
	reverse: (e) => {
		e.steps.reverse.look.receipt.output = e.steps.reverse.look.receipt.output.replace("no-unit", "unit-present");
	},
	narrowed: (e) => {
		e.steps.narrowed.carol.read = { receipt: { state: "running", companyFolder: mounted() } };
	},
	serviceClean: (e) => {
		e.service.bridgeExit = { status: 1, signal: null };
	},
};

test("the checks pass on complete evidence and each fails on its own when its evidence is wrong", () => {
	const checks = judge(passing());
	assert.deepEqual(
		Object.entries(checks).filter(([, c]) => !c.ok).map(([name]) => name),
		[],
	);
	assert.deepEqual(Object.keys(checks), [...Object.keys(failing), "noSecretsInEvidence"]);
	for (const [name, spoil] of Object.entries(failing)) {
		const evidence = passing();
		spoil(evidence);
		const failed = Object.entries(judge(evidence)).filter(([, c]) => !c.ok).map(([n]) => n);
		assert.deepEqual(failed, [name], name);
	}
	assert.deepEqual(Object.entries(judge(passing(), ["viewPass2"])).filter(([, c]) => !c.ok).map(([n]) => n), ["noSecretsInEvidence"]);
	assert.equal(judge({}).bootMounted.ok, false);
	const errored = passing();
	errored.error = "P4_TIMEOUT: the machine stops";
	assert.equal(judge(errored).serviceClean.ok, false);
	const passFailed = passing();
	passFailed.service.outcomes = [{ step: "start", state: "done" }, { step: "start", state: "failed", code: "CODING_CONTROL_UNCONFIRMED" }];
	assert.equal(judge(passFailed).serviceClean.ok, false, "a host pass that failed fails the run");
	const passThrew = passing();
	passThrew.service.passErrors = [{ t: 1, error: "LXD_UNAVAILABLE" }];
	assert.equal(judge(passThrew).serviceClean.ok, false, "a host pass that threw fails the run");
	const sqlDeadlocked = passing();
	sqlDeadlocked.service.rpcFailures = [{ t: 2911.4, method: "qorpera_authorize_executor_machine", code: "40P01", details: "Process 1 waits",
		message: "deadlock detected", in: ["public.qorpera_authorize_executor_machine"],
		lock: { relation: "qorpera_runtime_machine_allocations", tuple: "(0,8)", while: "locking" }, waits: "Process 1 waits" }];
	const deadlocked = judge(sqlDeadlocked).serviceClean;
	assert.equal(deadlocked.ok, false, "an executor call that deadlocked fails the run");
	assert.match(deadlocked.why, /deadlocks: t 2911\.4 qorpera_authorize_executor_machine \(public\.qorpera_authorize_executor_machine\) on qorpera_runtime_machine_allocations \(0,8\)$/);
	const keptDeadlocked = passing();
	keptDeadlocked.keeper = { renewals: 3, errors: [{ t: 2005.6, function: "p4.mc_observe", code: "40P01", waits: "w", lock: null, in: [] }] };
	assert.equal(judge(keptDeadlocked).serviceClean.ok, false, "the keeper's deadlock fails the run too");
	const refusedOnly = passing();
	refusedOnly.service.rpcFailures = [{ t: 9, method: "qorpera_folder_view_open", code: "42501", details: null, message: "x", in: [], lock: null }];
	assert.equal(judge(refusedOnly).serviceClean.ok, true, "a refusal a step asks for is not a deadlock");
});

/** Whether `check` fails on the evidence each spoiler makes, and only `check`. */
function failsOnly(check, spoilers) {
	for (const [name, spoil] of Object.entries(spoilers)) {
		const evidence = passing();
		spoil(evidence);
		const failed = Object.entries(judge(evidence)).filter(([, c]) => !c.ok).map(([n]) => n);
		assert.deepEqual(failed, [check], name);
	}
}

test("the start's receipt and a read while boundaries are held show nothing: no output, no end, an empty log", () => {
	const early = { state: "succeeded", exitCode: 0, output: "wrote-alice\n", totalBytes: 12 };
	failsOnly("heldUntilReleased", {
		"the start has the output": (e) => Object.assign(e.steps.credit.start, { output: "wrote-alice\n" }),
		"the start has an exit code": (e) => Object.assign(e.steps.credit.start, { exitCode: 0 }),
		"the start is finished": (e) => Object.assign(e.steps.credit.start, { state: "succeeded" }),
		"the start's log has bytes": (e) => Object.assign(e.steps.credit.start, { totalBytes: 12 }),
		"the start answered it all": (e) => Object.assign(e.steps.credit.start, early),
		"the start has no log size": (e) => delete e.steps.credit.start.totalBytes,
		"the held read has the output": (e) => Object.assign(e.steps.credit.heldRead, { output: "wrote-alice\n" }),
		"the held read's log has bytes": (e) => Object.assign(e.steps.credit.heldRead, { totalBytes: 12 }),
		"the held read has an exit code": (e) => Object.assign(e.steps.credit.heldRead, { exitCode: 0 }),
		"no boundary was held": (e) => Object.assign(e.steps.credit, { heldBoundaries: 0 }),
		"the released read has an empty log": (e) => Object.assign(e.steps.credit.released, { totalBytes: 0 }),
		"no boundary released before the output": (e) => Object.assign(e.steps.credit, { releasedFirst: false }),
	});
	const evidence = passing();
	delete evidence.steps.credit.start;
	assert.deepEqual(
		Object.entries(judge(evidence)).filter(([, c]) => !c.ok).map(([n]) => n),
		["reportOnReceipts", "heldUntilReleased"],
		"no start was recorded",
	);
});

test("another agent's company-audience run that reads the root takes in exactly the machine's reads; a refusal fails", () => {
	const refusal = "psql:<stdin>:4: ERROR:  42501: A run inherits a test machine's reads only with the company-wide view";
	failsOnly("readsTakenIn", {
		"Bob's run was refused, its reads as they were": (e) => Object.assign(e.steps.reads, { bob: { error: refusal }, bobAfter: [] }),
		"Bob's run was refused, with reads": (e) => Object.assign(e.steps.reads.bob, { schema: undefined, error: refusal }),
		"Bob's run was refused otherwise": (e) =>
			Object.assign(e.steps.reads, { bob: { error: "A run inherits only its own agent's and member's views" }, bobAfter: [] }),
		"Bob's take-in carried nothing": (e) => Object.assign(e.steps.reads.bob, { reads: 0 }),
		"Bob's take-in was a replay": (e) => Object.assign(e.steps.reads.bob, { replay: true }),
		"Bob's take-in was of another view": (e) => Object.assign(e.steps.reads.bob, { viewId: "view-2" }),
		"Bob's run has fewer reads than the view": (e) => Object.assign(e.steps.reads, { bobAfter: ["p4", "p4/seed.md"] }),
		"Bob's run has more reads than the view": (e) => e.steps.reads.bobAfter.push("p4/other.md"),
		"Bob's run had reads before": (e) => Object.assign(e.steps.reads, { bobBefore: ["p4/seed.md"] }),
		"Bob's run's reads before are unknown": (e) => delete e.steps.reads.bobBefore,
		"Bob's run is not of the company audience": (e) => Object.assign(e.steps.reads.bobAuthority, { audience: "member" }),
		"Bob's agent or member does not read the root": (e) => Object.assign(e.steps.reads.bobAuthority, { readsRoot: false }),
		"Bob's authority was not recorded": (e) => delete e.steps.reads.bobAuthority,
		"the run is the view's own agent's": (e) => Object.assign(e.steps.reads.bobAuthority, { staffAgentId: STAFF.alice }),
		"the view read nothing of the company's": (e) => Object.assign(e.steps.reads, { viewReads: ["p4"], bobAfter: ["p4"] }),
		"the reads are of another view": (e) => Object.assign(e.steps.reads, { viewId: "view-2" }),
		"Alice's run was refused": (e) => Object.assign(e.steps.reads, { alice: { error: "refused" } }),
		"Alice's take-in was of another view": (e) => Object.assign(e.steps.reads.alice, { viewId: "view-2" }),
	});
});

test("the second machine is refused the view for who it is; unavailable, busy or no answer is not a refusal", () => {
	const intruder = (e) => e.steps.refusals.intruder;
	const opens = (e, change) => {
		for (const open of intruder(e).opens) Object.assign(open, change);
	};
	const mount = (e, value) => {
		intruder(e).mount = value;
		intruder(e).answer.mount = value;
	};
	failsOnly("otherMachineRefused", {
		"the folder program is unanswered": (e) => mount(e, "unanswered"),
		"the folder program mounted": (e) => mount(e, "mounted"),
		"the folder program said nothing": (e) => mount(e, null),
		"the guest's exec failed": (e) => Object.assign(intruder(e), { answer: { exec: "LXD_UNAVAILABLE" }, mount: null }),
		"the guest's reply is unreadable": (e) => Object.assign(intruder(e), { answer: { reply: "not found" }, mount: null }),
		"the answer is for another view": (e) => Object.assign(intruder(e).answer, { viewId: "view-3" }),
		"the service was unavailable": (e) => opens(e, { code: "UNAVAILABLE" }),
		"the service was busy": (e) => opens(e, { code: "BUSY" }),
		"the view was closed": (e) => opens(e, { code: "VIEW_CLOSED" }),
		"one open was unavailable": (e) => Object.assign(intruder(e).opens[1], { code: "UNAVAILABLE" }),
		"one open was let in": (e) => Object.assign(intruder(e).opens[1], { ok: true, code: undefined }),
		"no open reached the service": (e) => Object.assign(intruder(e), { opens: [] }),
		"the opens were of another view": (e) => opens(e, { viewId: "view-3" }),
		"the bridge did not find the machine": (e) => opens(e, { lookup: "missing", machine: null }),
		"the opens were another machine's": (e) => opens(e, { machine: "qorpera-machine-1" }),
		"the hand-over was of another view": (e) => {
			Object.assign(intruder(e), { viewId: "view-3" });
			Object.assign(intruder(e).answer, { viewId: "view-3" });
			opens(e, { viewId: "view-3" });
		},
		"the hand-over is of the first boot": (e) => {
			Object.assign(intruder(e), { viewId: "view-1" });
			Object.assign(intruder(e).answer, { viewId: "view-1" });
			opens(e, { viewId: "view-1" });
		},
		"the hand-over's view is unknown": (e) => delete intruder(e).viewId,
		"the machine no longer reads": (e) => Object.assign(e.steps.refusals.stillReads, { exitCode: 1, output: "" }),
	});
});

test("a v2 binding: no repository worker, no repository disk, no /mnt/repository in the machine", () => {
	const boot = (e) => e.steps.boot;
	failsOnly("v2Binding", {
		"the binding is v1": (e) => Object.assign(boot(e).placement, { schema: "qorpera.lxd-company-machine/v1" }),
		"the binding names a repository worker": (e) => Object.assign(boot(e).placement, { repositoryWorkerId: true }),
		"the binding is another placement's": (e) => Object.assign(boot(e).placement, { id: "placement-9" }),
		"the VM has a repository disk": (e) => boot(e).devices.push({ name: "repository", type: "disk", path: "/srv" }),
		"a disk is at /mnt/repository": (e) => boot(e).devices.push({ name: "code", type: "disk", path: "/mnt/repository/x" }),
		"the VM's devices are unknown": (e) => Object.assign(boot(e), { devices: [] }),
		"the machine did not say no-repository": (e) =>
			Object.assign(boot(e).receipt, { output: boot(e).receipt.output.replace("no-repository\n", "") }),
		"the machine has /mnt/repository": (e) =>
			Object.assign(boot(e).receipt, { output: boot(e).receipt.output.replace("no-repository", "repository-present") }),
	});
});

test("the receipts say company mounted, held back with the host's words, and never lost where SQL ended the command", () => {
	failsOnly("reportOnReceipts", {
		"the boot's start was not held back": (e) => Object.assign(e.steps.boot.startReceipt, { companyFolder: mounted() }),
		"the boot's receipt is held back": (e) => Object.assign(e.steps.boot.receipt, { companyFolder: held(WORDS.heldStart) }),
		"the boot's receipt has no company folder": (e) => delete e.steps.boot.receipt.companyFolder,
		"A's start is held back in other words": (e) => Object.assign(e.steps.credit.start, { companyFolder: held("wait") }),
		"A's held read was not held back": (e) => Object.assign(e.steps.credit.heldRead, { companyFolder: mounted() }),
		"A's held read is held back as a start": (e) => Object.assign(e.steps.credit.heldRead, { companyFolder: held(WORDS.heldStart) }),
		"A's released read has a why": (e) => Object.assign(e.steps.credit.released.companyFolder, { why: "x" }),
		"A's released read says lost": (e) => Object.assign(e.steps.credit.released.companyFolder, { lost: "x" }),
		"K's resend was not refused ended": (e) => Object.assign(e.steps.refusals.k.resent, { code: "MACHINE_COMMAND_UNAVAILABLE" }),
		"K's resend says lost": (e) => Object.assign(e.steps.refusals.k.resent, { lost: WORDS.lostViewClosed }),
		"K's resend names a folder loss": (e) => Object.assign(e.steps.refusals.k.resent, { folderLost: "restart_view_closed" }),
		"K's read says lost": (e) => Object.assign(e.steps.refusals.k.read.receipt.companyFolder, { lost: "x" }),
		"K's read refusal says lost": (e) => Object.assign(e.steps.refusals.k, { read: { refused: { code: "MACHINE_COMMAND_ENDED", lost: "x" } } }),
		"K was not read": (e) => Object.assign(e.steps.refusals.k, { read: {} }),
		// Only SQL's end is the refusal the check asks for: a gateway that failed says nothing about the folder.
		"K's read got the gateway unavailable": (e) => Object.assign(e.steps.refusals.k, { read: { refused: authorizeRefused() } }),
		"K's read timed out": (e) => Object.assign(e.steps.refusals.k, {
			read: { refused: { t: 1, message: "The operation was aborted due to timeout", code: null, folderLost: null, lost: null } },
		}),
		"K's read was refused unavailable": (e) => Object.assign(e.steps.refusals.k, {
			read: { refused: { t: 1, message: "MACHINE_COMMAND_UNAVAILABLE", code: "MACHINE_COMMAND_UNAVAILABLE", folderLost: null, lost: null } },
		}),
		"K's read refusal names a folder loss": (e) => Object.assign(e.steps.refusals.k, {
			read: { refused: { code: "MACHINE_COMMAND_ENDED", folderLost: "restart_view_closed", lost: null } },
		}),
		"the still-reads command is not mounted": (e) => Object.assign(e.steps.refusals.stillReads, { companyFolder: { company: "none" } }),
		"the wake's command is held back": (e) => Object.assign(e.steps.stop.wake.receipt, { companyFolder: held(WORDS.heldStart) }),
	});
	const refusedRead = passing();
	refusedRead.steps.refusals.k.read = { refused: { code: "MACHINE_COMMAND_ENDED", folderLost: null, lost: null } };
	assert.equal(judge(refusedRead).reportOnReceipts.ok, true, "K's read may be refused ended, without lost");
});

test("an ended command's write is answered by its first outcome that is not waiting, from a boundary or the quiet publish", () => {
	const view = (...paths) => ({ views: [{ viewId: "v", report: { paths } }] });
	const waiting = { path: "p4/k.txt", outcome: "waiting", reason: "its bytes are not saved yet", kept: true };
	const refused = { path: "p4/k.txt", outcome: "refused", reason: "command_ended", kept: true };
	// Run 3: a boundary ran while K's bytes were on their way (waiting), the next ones refused them.
	const ops = [
		{ op: "boundary", t: 460, at: 460000, answer: view({ ...refused }) },
		{ op: "boundary", t: 464.3, at: 464300, answer: view({ path: "p4/m.txt", outcome: "saved" }, { ...waiting }) },
		{ op: "openWindow", t: 465, at: 465000, answer: "ok" },
		{ op: "boundary", t: 467.1, at: 467100, answer: view({ ...refused }) },
	];
	assert.deepEqual(answeredUnit(ops, [], "p4/k.txt", 461000, 461), { op: "boundary", t: 467.1, ...refused },
		"the boundary before K ended and the waiting one are no answer");
	assert.equal(answeredUnit(ops.slice(0, 3), [], "p4/k.txt", 461000, 461), null, "waiting alone is no answer yet");
	const log = [
		"459.0 folder-service: view:v: p4/k.txt: refused (command_ended)",
		"464.3 folder-service: view:v: p4/k.txt: waiting (its bytes are not saved yet)",
		"466.4 folder-service: view:v: p4/kXtxt: saved",
		"466.4 folder-service: view:v: p4/k.txt: refused (command_ended)",
	];
	assert.deepEqual(answeredUnit(ops.slice(0, 3), log, "p4/k.txt", 461000, 461),
		{ op: "quiet", t: 466.4, path: "p4/k.txt", outcome: "refused", reason: "command_ended" },
		"the quiet publish answers when no boundary did; its path is matched exactly");
	failsOnly("endedRefused", {
		"K's write is answered waiting only": (e) => Object.assign(e.steps.refusals.k, { report: { op: "boundary", t: 464.3, ...waiting } }),
		"K's write was saved": (e) => Object.assign(e.steps.refusals.k, { report: { ...refused, outcome: "saved", reason: null } }),
		"K's write was never answered": (e) => Object.assign(e.steps.refusals.k, { report: { error: "k.txt's unit is answered: timed out" } }),
	});
});

test("ss's vsock lines and systemd's socket units are read for their CID, port, processes and unit", () => {
	assert.deepEqual(parseVsockListener('v_str LISTEN 0 0 2:7114 *:* users:(("lxd",pid=15088,fd=22))'), {
		cid: "2",
		port: 7114,
		processes: [{ name: "lxd", pid: 15088 }],
	});
	assert.deepEqual(parseVsockListener('v_str LISTEN 0 0 *:22 *:* users:(("systemd",pid=1,fd=188),("sshd",pid=7,fd=3))'), {
		cid: "*",
		port: 22,
		processes: [{ name: "systemd", pid: 1 }, { name: "sshd", pid: 7 }],
	});
	assert.deepEqual(parseVsockListener("v_str LISTEN 0 0 *:9999 *:*"), { cid: "*", port: 9999, processes: [] });
	assert.deepEqual(
		parseSocketUnits("vsock::22     sshd-vsock.socket     -\n/run/systemd/journal/stdout  systemd-journald.socket  x\n"),
		{ 22: "sshd-vsock.socket" },
	);
});

test("each vsock port the guest reaches on the host has its allowed owner; anything else fails", () => {
	const v = (e) => e.steps.vsockPorts;
	// A port that answers is one fewer refused, so the totals still add up and only the owner rule is tested.
	const answers = (e, port, ...listeners) => {
		v(e).probe.answered.push(port);
		v(e).probe.errnos.ECONNRESET -= 1;
		v(e).ports.push({ port });
		v(e).listeners.push(...listeners);
	};
	const on = (e, port) => v(e).listeners.find((l) => l.port === port);
	failsOnly("vsockPorts", {
		"on bare metal, sshd-vsock and lxd-agent are not allowed": (e) => Object.assign(v(e), { virt: "none" }),
		"systemd-detect-virt was not read": (e) => delete v(e).virt,
		"another port answered": (e) => answers(e, 9999, listener("*", 9999, "python3", 4242, "/usr/bin/python3.14")),
		"a port answered with no owner": (e) => answers(e, 9999),
		"a port's listener holds no process": (e) => answers(e, 9999, { cid: "*", port: 9999, processes: [], unit: null }),
		"22 is held by sshd, not systemd's socket": (e) => Object.assign(on(e, 22), listener("*", 22, "sshd", 900, "/usr/sbin/sshd")),
		"22 is another socket unit's": (e) => Object.assign(on(e, 22), { unit: "other-vsock.socket" }),
		"8443 is not lxd-agent's": (e) => Object.assign(on(e, 8443), listener("*", 8443, "python3", 4242, "/usr/bin/python3.14")),
		"5250 is not this run's bridge": (e) => Object.assign(v(e), { bridgePid: 4242 }),
		"the bridge's pid was not recorded": (e) => Object.assign(v(e), { bridgePid: null }),
		"the bridge did not answer": (e) => {
			v(e).probe.answered = [22, 7114, 8443];
			v(e).probe.errnos.ECONNRESET += 1;
			v(e).ports = v(e).ports.filter((p) => p.port !== 5250);
		},
		"a second LXD port": (e) => answers(e, 7115, listener("2", 7115, "lxd", 15088, "/snap/lxd/40424/sbin/lxd")),
		"LXD's listener is bound to any CID": (e) => Object.assign(on(e, 7114), { cid: "*" }),
		"LXD's port is another program called lxd": (e) => Object.assign(on(e, 7114).processes[0], { exe: "/tmp/lxd" }),
		"two listeners on one port": (e) => v(e).listeners.push(listener("2", 22, "systemd", 1, "/usr/lib/systemd/systemd")),
		"a port answered twice": (e) => {
			v(e).probe.answered.push(5250);
			v(e).probe.errnos.ECONNRESET -= 1;
		},
		"the evidence leaves an answering port out": (e) => v(e).ports.pop(),
		"not every port was scanned": (e) => Object.assign(v(e).probe, { scanned: 1024, errnos: { ECONNRESET: 1020 } }),
		"a port timed out": (e) => Object.assign(v(e).probe, { timeoutCount: 3, errnos: { ECONNRESET: 65528 } }),
		// A connect that failed for want of buffers or a retry proves nothing about the port.
		"a port ended in ENOBUFS": (e) => Object.assign(v(e).probe, { errnos: { ECONNRESET: 65530, ENOBUFS: 1 } }),
		"ports ended in EAGAIN": (e) => Object.assign(v(e).probe, { errnos: { ECONNRESET: 65031, EAGAIN: 500 } }),
		"a port ended in an errno with no name": (e) => Object.assign(v(e).probe, { errnos: { ECONNRESET: 65530, 524: 1 } }),
		"a refusal count is not a count": (e) => Object.assign(v(e).probe, { errnos: { ECONNRESET: "65531" } }),
		"the refusals and answers fall short of the ports scanned": (e) => Object.assign(v(e).probe, { errnos: { ECONNRESET: 65530 } }),
		"the refusals and answers pass the ports scanned": (e) => Object.assign(v(e).probe, { errnos: { ECONNRESET: 65531, ECONNREFUSED: 1 } }),
		"the errnos were not recorded": (e) => delete v(e).probe.errnos,
		"the errnos are a list": (e) => Object.assign(v(e).probe, { errnos: [["ECONNRESET", 65531]] }),
		"the probe failed": (e) => Object.assign(v(e).receipt, { exitCode: 1 }),
		"the probe said nothing": (e) => delete v(e).probe,
	});
	const refusedBothWays = passing();
	Object.assign(v(refusedBothWays).probe, { errnos: { ECONNRESET: 65000, ECONNREFUSED: 531 } });
	assert.equal(judge(refusedBothWays).vsockPorts.ok, true, "a refusal reset or refused is a refusal");
	const bare = passing();
	Object.assign(v(bare), { virt: "none", probe: { scanned: 65535, answered: [5250, 1497], timeoutCount: 0, errnos: { ECONNRESET: 65533 } } });
	v(bare).listeners = [on(bare, 5250), listener("2", 1497, "lxd", 3300, "/snap/lxd/40100/sbin/lxd")];
	v(bare).ports = [{ port: 5250 }, { port: 1497 }];
	assert.equal(judge(bare).vsockPorts.ok, true, "on bare metal: the bridge and LXD's own listener, whatever its port");
	const bridgeOnly = passing();
	Object.assign(v(bridgeOnly).probe, { answered: [5250], errnos: { ECONNRESET: 65534 } });
	v(bridgeOnly).ports = [{ port: 5250 }];
	assert.equal(judge(bridgeOnly).vsockPorts.ok, true, "the bridge alone");
	assert.match(judge(passing()).vsockPorts.why, /refused at once \(ECONNRESET 65531; 4 answered \+ 65531 refused of 65535 scanned;/);
});

test("a writer left running after its command ended commits as the starter, crediting no command", () => {
	const d = (e) => e.steps.detached;
	const c = (e) => d(e).commits[0];
	failsOnly("detached", {
		"the unit credits a command": (e) => Object.assign(c(e).units[0], { credits: [ids.d] }),
		"the commit credits a command": (e) => Object.assign(c(e), { credits: [ids.d] }),
		"another agent wrote": (e) => Object.assign(c(e), { actorId: STAFF.bob }),
		"another run wrote": (e) => Object.assign(c(e), { runId: "run-bob" }),
		"another view wrote": (e) => Object.assign(c(e), { viewId: "view-2" }),
		"another requester": (e) => Object.assign(c(e), { requesterId: STAFF.carol }),
		"it was written before the end was recorded": (e) => Object.assign(c(e), { createdAtMs: 900 }),
		"it was written before the windows closed": (e) => Object.assign(c(e), { createdAtMs: 1200 }),
		"it was written before the go": (e) => Object.assign(c(e), { createdAtMs: 1900 }),
		"the end was never recorded": (e) => Object.assign(d(e), { endedAtMs: null }),
		"a window stayed open": (e) => Object.assign(d(e), { unclosed: [ids.d] }),
		"the command still runs in SQL": (e) => Object.assign(d(e), { running: [ids.d] }),
		"the go failed": (e) => Object.assign(d(e), { go: 1 }),
		"the writer never started": (e) => Object.assign(d(e).receipt, { output: "" }),
		"nothing was committed": (e) => Object.assign(d(e), { commits: [] }),
	});
});

test("the guest clock and the loops take ms from %N: uutils date (Ubuntu 26.04) prints %3N unpadded", () => {
	assert.equal(msFromNanoseconds("1700000000012345678"), 1700000000012);
	// Shorter than a %s%N (as %s%3N can be on uutils), or not digits only.
	for (const text of ["", "170000000012345678", "17000000000123", "1700000000.012345678", "-1700000000012345678"])
		assert.ok(Number.isNaN(msFromNanoseconds(text)), text);
	for (const shell of ["bash", "sh"]) {
		const before = Date.now();
		const said = execFileSync(shell, ["-c", `${NOW_MS}\nnow`], { encoding: "utf8", timeout: 5000 }).trim();
		assert.match(said, /^[0-9]{13}$/, shell);
		assert.ok(Math.abs(Number(said) - before) < 5000, `${shell} ${said}`);
	}
});

test("a loop's changes are published by the quiet period, a read's boundary and the cancel, each crediting the loop", () => {
	const l = (e) => e.steps.loop;
	failsOnly("loop", {
		"a boundary was asked in the quiet window": (e) => Object.assign(l(e).quiet, { boundaries: 1 }),
		"a quiet change was committed at once": (e) => Object.assign(l(e).commits[0], { createdAtMs: 110200 }),
		"a quiet change waited past the quiet period": (e) => Object.assign(l(e).commits[1], { createdAtMs: 129000 }),
		"a change was never committed": (e) => l(e).commits.splice(0, 1),
		// SQL keeps an attempt that saved nothing, with no seq: every quiet publish refused is no save, whatever comes later.
		"every quiet publish was refused": (e) => {
			for (const c of l(e).commits.slice(0, 3)) Object.assign(c, { seq: null, outcome: "refused", reason: "command_ended", version: null, fileSha256: null });
		},
		"a quiet publish was refused, its tick's bytes named": (e) => Object.assign(l(e).commits[1], { seq: null, outcome: "refused", version: null }),
		"a quiet publish conflicted in a commit that took a seq": (e) => Object.assign(l(e).commits[2], { outcome: "conflict", reason: "version_changed" }),
		"a quiet save has no version": (e) => Object.assign(l(e).commits[0], { version: null }),
		"a quiet save holds another tick's bytes": (e) => Object.assign(l(e).commits[1], { fileSha256: loopFileSha256(1, 110000) }),
		// Matched by time alone, the cancel's save (5.1 s after tick 5) would stand in for tick 5's missing one.
		"a tick's save is missing and only a later save follows": (e) => l(e).commits.splice(4, 1),
		"a quiet tick was saved by a read's boundary": (e) => l(e).boundarySeqs.push(13),
		"the boundaries' seqs were not recorded": (e) => delete l(e).boundarySeqs,
		"a save is dated before its tick was written": (e) => Object.assign(l(e).commits[3], { createdAtMs: 139900 }),
		"the read's seq is no boundary's": (e) => Object.assign(l(e), { boundarySeqs: [9, 16] }),
		"the read's seq saved no tick first": (e) => {
			l(e).commits.splice(3, 0, loopCommit(10, 140300, 4, 140000));
			l(e).boundarySeqs.push(10);
		},
		"the read's commit saved nothing": (e) => {
			l(e).commits.splice(3, 1, { ...loopCommit(14, 140700, 4, 140000), seq: null, outcome: "refused", version: null });
		},
		"the cancel's save holds a tick's bytes, not L's last": (e) => Object.assign(l(e).commits[5], { fileSha256: loopFileSha256(5, 150000) }),
		"the cancel's seq is no boundary's": (e) => Object.assign(l(e), { boundarySeqs: [9, 14] }),
		"L's last change was saved by another commit": (e) => Object.assign(l(e).cancel.report, { seq: 15 }),
		"a commit credits another command": (e) => Object.assign(l(e).commits[2], { credits: [ids.a] }),
		"a commit credits nothing": (e) => Object.assign(l(e).commits[2], { credits: [] }),
		"the read's publish is not a commit": (e) => Object.assign(l(e).reads[0].hit, { seq: 99 }),
		"the read published nothing saved": (e) => Object.assign(l(e).reads[0].hit, { outcome: "refused" }),
		"no read hit a write": (e) => Object.assign(l(e), { reads: [{ at: 1 }] }),
		"the cancel published nothing": (e) => Object.assign(l(e).cancel, { report: null }),
		"the cancel's publish is not a commit": (e) => Object.assign(l(e).cancel.report, { seq: 99 }),
		"L was not cancelled": (e) => Object.assign(l(e).final, { state: "succeeded" }),
		"L's last change is missing": (e) => Object.assign(l(e), { last: { n: 5, last: false } }),
		"a tick is missing": (e) => l(e).ticks.splice(1, 1),
		"fewer than four ticks": (e) => Object.assign(l(e), { ticks: l(e).ticks.slice(0, 3), last: { n: 4, last: true } }),
		"only one tick was quiet": (e) => Object.assign(l(e).quiet, { toAt: 115000 }),
		"the guest's clock is unknown": (e) => delete l(e).clock,
	});
	// An attempt that saved nothing does not fail L when its tick is saved after it, in time.
	const retried = passing();
	retried.steps.loop.commits.splice(1, 0, { ...loopCommit(null, 121900, 2, 120000), outcome: "refused", reason: "busy", version: null, fileSha256: null });
	assert.equal(judge(retried).loop.ok, true, "a refused attempt, then its tick's save");
	assert.match(judge(passing()).loop.why, /\(tick 1 seq 11 \+2050 ms quiet, .*tick 4 seq 14 \+700 ms, tick 5 seq 15 \+2000 ms; last seq 16; 0 attempts not saved\)$/);
	assert.match(judge(retried).loop.why, /; 1 attempts not saved\)$/);
});

test("a change made just before a stop is saved by the final boundary before the power-off", () => {
	const s = (e) => e.steps.stop.loop;
	failsOnly("stopWhileRunning", {
		"the power-off came first": (e) => Object.assign(s(e), { powerOffAt: 200100 }),
		"the power-off is unknown": (e) => Object.assign(s(e), { powerOffAt: null }),
		"the final boundary refused it": (e) => Object.assign(s(e).reports[0], { outcome: "refused" }),
		"the save was not the final boundary": (e) => Object.assign(s(e).reports[0], { final: [] }),
		"the save came long after": (e) => Object.assign(s(e).reports[0], { at: 202100 }),
		"the save was of an earlier change": (e) => Object.assign(s(e).reports[0], { at: 199900 }),
		"the save has no commit": (e) => Object.assign(s(e).reports[0], { seq: null }),
		"S's last change is unknown": (e) => Object.assign(s(e), { last: { n: 30, t: 200000, last: false } }),
		"the guest's clock is unknown": (e) => delete s(e).clock,
	});
});

test("a machine whose starter does not read the root has no /company, and its receipts say why", () => {
	const b = (e) => e.steps.noRootRead;
	failsOnly("noRootRead", {
		"nothing was revoked": (e) => Object.assign(b(e).revoked, { count: 0 }),
		"the starter still reads the root": (e) => Object.assign(b(e), { readsRoot: true }),
		"the start says mounted": (e) => Object.assign(b(e).look.start, { companyFolder: mounted() }),
		"the receipt says another why": (e) => Object.assign(b(e).look.receipt.companyFolder, { why: "no folder" }),
		"the receipt has no why": (e) => delete b(e).look.receipt.companyFolder.why,
		"the machine has /company": (e) => Object.assign(b(e).look.receipt, { output: "company-mounted\nentries 0\n" }),
		"/company has entries": (e) => Object.assign(b(e).look.receipt, { output: "no-company\nentries 2\n" }),
		"the look failed": (e) => Object.assign(b(e).look.receipt, { exitCode: 1 }),
		"a view was opened": (e) => Object.assign(b(e), { views: [{ id: "view-9" }] }),
		"the placement is not marked unchecked": (e) => Object.assign(b(e).placement, { folderUncheckedAt: null }),
		"no open was refused": (e) => Object.assign(b(e), { openFailures: [] }),
		"the open was refused as a new disk": (e) => Object.assign(b(e).openFailures[0], { details: NEW_DISK }),
		"the open failed otherwise": (e) => Object.assign(b(e).openFailures[0], { code: "P0001" }),
	});
});

test("a boot-time unit installed without the root read is dropped with the unchecked disk once the root read is back", () => {
	const r = (e) => e.steps.reverse;
	const look = (e, from, to) => Object.assign(r(e).look.receipt, { output: r(e).look.receipt.output.replace(from, to) });
	failsOnly("reverse", {
		"the install failed": (e) => Object.assign(r(e).install, { exitCode: 1 }),
		"the unit was not installed": (e) => Object.assign(r(e).install, { output: "marker\n" }),
		"nothing was restored": (e) => Object.assign(r(e), { restored: 0 }),
		"the starter does not read the root": (e) => Object.assign(r(e), { readsRoot: false }),
		"the stop failed": (e) => Object.assign(r(e).stopped, { state: "failed" }),
		"the placement was retired for its starter": (e) => Object.assign(r(e).retired, { folder: "FOLDER_RETIRED:STARTER" }),
		"another placement was retired": (e) => Object.assign(r(e).retired, { placementId: "placement-9" }),
		"the old placement's reason is another": (e) => Object.assign(r(e).old, { folderRetireReason: "starter" }),
		"the old placement is not retired": (e) => Object.assign(r(e).old, { retiredAt: null }),
		"the open was not refused for the new disk": (e) => Object.assign(r(e).openFailures[0], { details: null }),
		"the open was refused otherwise": (e) => Object.assign(r(e).openFailures[0], { message: "Folder view needs the company-wide view" }),
		"the machine did not mount": (e) => Object.assign(r(e).mounted, { folder: "FOLDER_NONE:REFUSED" }),
		"it mounted on the old disk": (e) => {
			Object.assign(r(e).mounted, { placementId: "placement-2" });
			Object.assign(r(e).placement, { id: "placement-2" });
		},
		"the new placement is v1": (e) => Object.assign(r(e).placement, { schema: "qorpera.lxd-company-machine/v1" }),
		"the unit came along": (e) => look(e, "no-unit", "unit-present"),
		"the marker came along": (e) => look(e, "no-marker", "marker-present"),
		"no /company": (e) => look(e, "company-mounted", "no-company"),
		"the seed was not read": (e) => look(e, SEED_OUT, ""),
		"the receipt says none": (e) => Object.assign(r(e).look.receipt, { companyFolder: { company: "none" } }),
	});
});

test("a starter narrowed while its machine runs: refused commands, a restart, a retired placement and a new disk", () => {
	const n = (e) => e.steps.narrowed;
	failsOnly("narrowed", {
		"Carol's run was let in": (e) => Object.assign(n(e).carol, { run: { receipt: { state: "running" } } }),
		"Carol's run also has a receipt": (e) => Object.assign(n(e).carol.run, { receipt: { state: "running" } }),
		"Carol's cancel was let in": (e) => Object.assign(n(e).carol, { cancel: { receipt: { state: "cancelled" } } }),
		"only two refusals were the company-wide view's": (e) => n(e).carolFailures.pop(),
		"the refusals were for something else": (e) => {
			for (const f of n(e).carolFailures) f.message = "Machine command ended";
		},
		"nothing was revoked": (e) => Object.assign(n(e).revoked, { count: 0 }),
		"Carol still reads the root": (e) => Object.assign(n(e), { readsRoot: true }),
		"Alice's read before was not mounted": (e) => Object.assign(n(e).aliceBefore.receipt, { companyFolder: { company: "none" } }),
		"Alice's read during was refused": (e) => Object.assign(n(e), { aliceDuring: { refused: authorizeRefused() } }),
		"the host did not restart for the closed view": (e) => Object.assign(n(e).viewClosed, { folder: "FOLDER_MOUNTED" }),
		"the host restarted only once the view was gone": (e) => Object.assign(n(e).viewClosed, { folder: "FOLDER_RESTART:VIEW_GONE" }),
		"the ended boot still says mounted": (e) => Object.assign(n(e).ended.receipt.companyFolder, { company: "mounted" }),
		"the ended boot says another why": (e) => Object.assign(n(e).ended.receipt.companyFolder, { why: WORDS.refused }),
		"the ended boot's output is not held back": (e) => delete n(e).ended.receipt.companyFolder.heldBack,
		"the placement was retired unchecked": (e) => Object.assign(n(e).retired, { folder: "FOLDER_RETIRED:UNCHECKED" }),
		"another placement was retired": (e) => Object.assign(n(e).retired, { placementId: "placement-9" }),
		"the old placement's reason is another": (e) => Object.assign(n(e).old, { folderRetireReason: "unchecked" }),
		"the old placement is not retired": (e) => Object.assign(n(e).old, { retiredAt: null }),
		"the open was not refused as a new disk": (e) => Object.assign(n(e).openFailures[0], { details: null }),
		"nothing was restored": (e) => Object.assign(n(e), { restored: 0 }),
		"Carol does not read the root again": (e) => Object.assign(n(e), { readsRootAgain: false }),
		"the machine did not mount again": (e) => Object.assign(n(e).newMounted, { folder: "FOLDER_NONE:REFUSED" }),
		"it mounted on the old disk": (e) => Object.assign(n(e).newMounted, { placementId: "placement-4" }),
		"the boot's command was not lost": (e) => Object.assign(n(e).aLongRow, { state: "succeeded" }),
		"the boot's command was lost otherwise": (e) => Object.assign(n(e).aLongRow, { folderLostReason: "moved_unchecked" }),
		"Alice's read after was answered": (e) => Object.assign(n(e), { aliceAfter: { receipt: { state: "running" } } }),
		"the refusal names no folder loss": (e) => Object.assign(n(e).aliceAfter.refused, { folderLost: null }),
		"the refusal names another loss": (e) => Object.assign(n(e).aliceAfter.refused, { folderLost: "moved_starter" }),
		"the refusal has no lost": (e) => Object.assign(n(e).aliceAfter.refused, { lost: null }),
		"the refusal's lost is in other words": (e) => Object.assign(n(e).aliceAfter.refused, { lost: "lost" }),
		"the new disk has no /company": (e) => Object.assign(n(e).look.receipt, { output: "no-company\nentries 0\n" }),
		"the new disk's receipt says none": (e) => Object.assign(n(e).look.receipt, { companyFolder: { company: "none" } }),
	});
	const moved = passing();
	Object.assign(moved.steps.narrowed.aLongRow, { folderLostReason: "moved_starter" });
	Object.assign(moved.steps.narrowed.aliceAfter.refused, { folderLost: "moved_starter", lost: "the machine moved to a new disk" });
	assert.equal(judge(moved).narrowed.ok, true, "the boot's command may be lost to the move instead of the restart");
});

test("a change credited for the whole commit counts when its unit carries none", () => {
	const evidence = passing();
	for (const c of evidence.steps.overlap.commits) for (const unit of c.units) delete unit.credits;
	assert.equal(judge(evidence).overlapCredited.ok, true);
	evidence.steps.overlap.commits[1].credits = [ids.b];
	assert.equal(judge(evidence).overlapCredited.ok, false);
});
