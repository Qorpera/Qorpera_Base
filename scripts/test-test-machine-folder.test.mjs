import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expandTestFixture } from "./test-hosted-db.mjs";
import {
	findSecrets,
	fixtureSql,
	judge,
	literal,
	nicStandIn,
	parseArgs,
	postgrestFailure,
	postgrestStatus,
	replaceCounted,
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

test("the stand-in client makes machines without their NIC, answers with it, and keeps each folder hand-over", async () => {
	const client = fakeClient();
	const nics = new Map();
	const handovers = [];
	const proxied = nicStandIn(client, nics, handovers);
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
	assert.equal(client.calls.filter((call) => call[0] === "stream").length, 2);
	assert.equal(proxied.describe(), "kept", "other methods keep their client");
	assert.equal(proxied.secret, "kept");
});

test("the record's secrets are found by value, and short values are not secrets", () => {
	const secrets = { "holder:alice": "x".repeat(43), viewPass: "y".repeat(43), short: "abc" };
	assert.deepEqual(findSecrets(`{"a":"${"y".repeat(43)}","b":"abc"}`, secrets), ["viewPass"]);
	assert.deepEqual(findSecrets("nothing here", secrets), []);
});

const STAFF = { alice: "92400000-0000-4000-8000-000000000030", bob: "92400000-0000-4000-8000-000000000031", carol: "92400000-0000-4000-8000-000000000032" };
const OWNER = "92400000-0000-4000-8000-000000000001";
const ids = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000001", c: "cccccccc-0000-4000-8000-000000000001", m: "dddddddd-0000-4000-8000-000000000001", k: "eeeeeeee-0000-4000-8000-000000000001" };
const commit = (actor, credits, units) => ({
	actorKind: "staff_agent", actorId: STAFF[actor], requesterId: OWNER, runId: `run-${actor}`, viewKind: "test_machine", credits,
	units: units.map(([path, unitCredits]) => ({ op: "write", path, credits: unitCredits })),
});

/** Evidence every check passes. */
function passing() {
	return {
		steps: {
			boot: {
				mounted: true, view: { kind: "test_machine", state: "open" },
				receipt: { state: "succeeded", exitCode: 0, output: "# P4\n\nThe company folder, as a test machine reads it.\n" },
			},
			credit: {
				commandId: ids.a, runId: "run-alice", heldRead: { state: "running", output: "", exitCode: null }, heldBoundaries: 3,
				released: { state: "succeeded", exitCode: 0, output: "wrote-alice\n" }, releasedFirst: true,
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
				viewId: "view-1", viewReads: ["p4/seed.md"], aliceRunReads: ["p4/seed.md"], bobBefore: [], bobAfter: ["p4/seed.md"],
				bob: { schema: "qorpera.folder-inherit/v1", viewId: "view-1", reads: 2, replay: false },
				alice: { schema: "qorpera.folder-inherit/v1", viewId: "view-1", reads: 2, replay: false },
			},
			refusals: {
				m: { commandId: ids.m, entries: 1 },
				k: { row: { state: "lost", endedAt: "t" }, resend: "MACHINE_COMMAND_ENDED", report: { path: "p4/k.txt", outcome: "refused", reason: "command_ended" }, entries: 0 },
				commits: [commit("carol", [ids.m], [["p4/m.txt", [ids.m]]])],
				intruder: { mount: "refused", opens: [{ ok: false }] },
				stillReads: { exitCode: 0, output: "a\n" },
			},
			stop: {
				viewId: "view-1", bootId: "boot-1", outcome: { state: "done" }, finalBoundary: { final: ["view-1"] }, restarted: true,
				view: { state: "closed", closedAt: "t" }, instanceStatus: "Stopped",
				wake: { mounted: true, bootId: "boot-2", view: { id: "view-2", state: "open" }, receipt: { exitCode: 0, output: "a\nc\n" } },
			},
		},
		cleanupErrors: [],
		service: { bridgeExit: null },
	};
}

const failing = {
	bootMounted: (e) => {
		e.steps.boot.receipt.output = "";
	},
	heldUntilReleased: (e) => {
		e.steps.credit.heldRead.output = "wrote-alice\n";
	},
	creditedToCommand: (e) => {
		e.steps.credit.commits[0].actorId = STAFF.bob;
	},
	overlapCredited: (e) => {
		e.steps.overlap.commits[1].units[0].credits = [ids.b];
	},
	readsTakenIn: (e) => {
		e.steps.reads.bobAfter = [];
	},
	endedRefused: (e) => {
		e.steps.refusals.k.entries = 1;
	},
	otherMachineRefused: (e) => {
		e.steps.refusals.intruder.opens = [{ ok: true }];
	},
	stopClosed: (e) => {
		e.steps.stop.view.state = "open";
	},
	secondBoot: (e) => {
		e.steps.stop.wake.bootId = "boot-1";
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
	assert.deepEqual(Object.entries(judge(passing(), ["viewPass"])).filter(([, c]) => !c.ok).map(([n]) => n), ["noSecretsInEvidence"]);
	assert.equal(judge({}).bootMounted.ok, false);
	const errored = passing();
	errored.error = "P4_TIMEOUT: the machine stops";
	assert.equal(judge(errored).serviceClean.ok, false);
});

test("another agent's run either takes the machine's reads in or is refused as a run without the company-wide view", () => {
	const refused = passing();
	refused.steps.reads.bob = { error: "psql:<stdin>:4: ERROR:  42501: A run inherits a test machine's reads only with the company-wide view" };
	refused.steps.reads.bobAfter = [];
	assert.equal(judge(refused).readsTakenIn.ok, true);
	refused.steps.reads.bobAfter = ["p4/seed.md"];
	assert.equal(judge(refused).readsTakenIn.ok, false, "a refused take-in leaves the run's reads as they were");
	const otherError = passing();
	otherError.steps.reads.bob = { error: "psql:<stdin>:4: ERROR:  42501: A run inherits only its own agent's and member's views" };
	otherError.steps.reads.bobAfter = [];
	assert.equal(judge(otherError).readsTakenIn.ok, false);
	const aliceRefused = passing();
	aliceRefused.steps.reads.alice = { error: "refused" };
	assert.equal(judge(aliceRefused).readsTakenIn.ok, false);
	const otherView = passing();
	otherView.steps.reads.alice.viewId = "view-2";
	assert.equal(judge(otherView).readsTakenIn.ok, false);
});

test("a change credited for the whole commit counts when its unit carries none", () => {
	const evidence = passing();
	for (const c of evidence.steps.overlap.commits) for (const unit of c.units) delete unit.credits;
	assert.equal(judge(evidence).overlapCredited.ok, true);
	evidence.steps.overlap.commits[1].credits = [ids.b];
	assert.equal(judge(evidence).overlapCredited.ok, false);
});
