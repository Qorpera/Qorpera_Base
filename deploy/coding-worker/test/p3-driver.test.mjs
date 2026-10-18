// What node --check cannot see in the P3 driver: that its imports link, and that no top-level binding is declared below
// the main flow's start (the flow's callbacks would find it uninitialized: a run's ReferenceError at its first core call,
// 38 minutes in). And that its stand-in PostgREST fails a call as PostgREST does, for the executor's control, which is
// production's own, as for the folder service. And that turn 9's judgment of the new disk passes a real run's records
// and fails each of them broken. The run-on-node plan's deploy-node step runs it, and prove-coding-session-vm.sh before it
// builds anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judgeNewDisk } from "./p3-c2.mjs";
import { postgrestError, postgrestStatus } from "./p3-postgrest-errors.mjs";

const driver = fileURLToPath(new URL("./p3-driver.mjs", import.meta.url));
const executor = fileURLToPath(new URL("./p3-executor.ts", import.meta.url));

test("the driver's imports link and it stops at its usage line", () => {
	const run = spawnSync(process.execPath, [driver], { encoding: "utf8" });
	assert.match(run.stderr, /usage: p3-driver\.mjs/, run.stderr);
});

test("no top-level binding is declared below the main flow's start", () => {
	const lines = readFileSync(driver, "utf8").split("\n");
	const start = lines.findIndex((line) => line.startsWith("const db = await "));
	assert.ok(start > 0, "the driver's main flow starts at `const db = await …`");
	const late = lines
		.map((line, index) => `${index + 1}: ${line}`)
		.slice(start + 1)
		.filter((line) => /^\d+: (const|let|var|class) /.test(line))
		.filter((line) => !/^\d+: let (executor|stopping|postgrest);$/.test(line));
	assert.deepEqual(late, []);
});

test("the stand-in answers a failed call with PostgREST's status", () => {
	const cases = [
		// Busy: production's control calls 55P03 busy only in a 500 (review r1 F2: it was 400 here).
		["55P03", 500], ["40001", 500], ["40P01", 500],
		// The folder view refusals the control keeps: 42501 (a role is always set here) and 22023.
		["42501", 403], ["22023", 400], ["P0001", 400],
		["P0002", 500], ["XX000", 500], ["23505", 409], ["23503", 409], ["25006", 405], ["25001", 500],
		["08006", 503], ["53100", 503], ["53400", 500], ["42883", 404], ["42P01", 404], ["42P17", 500],
		["PGRST202", 404], ["PT402", 402], ["PT100", 400], [null, 500], ["", 500],
	];
	assert.deepEqual(cases.map(([code]) => [code, postgrestStatus(code)]), cases);
});

test("the stand-in's error body is PostgREST's, exactly", () => {
	const answer = postgrestError(Object.assign(new Error("Folder view is unavailable"), { sqlState: "42501" }));
	assert.equal(answer.status, 403);
	const body = JSON.parse(answer.body);
	assert.deepEqual(Object.keys(body).sort(), ["code", "details", "hint", "message"]);
	assert.deepEqual(body, { code: "42501", message: "Folder view is unavailable", details: null, hint: null });
	const detail = "qorpera.test-machine/new-disk";
	assert.equal(JSON.parse(postgrestError({ sqlState: "42501", message: "m", detail }).body).details, detail);
	// The stand-in's own failure, without a SQLSTATE: a 500 that no caller reads as busy or refused.
	assert.deepEqual(postgrestError(new Error("psql exited")), {
		status: 500, body: JSON.stringify({ code: null, message: "psql exited", details: null, hint: null }),
	});
});

// Turn 9's judgment of the new disk (C2 step 2), on evidence run 2's records (node02 20261018T021854-39829-59b06489):
// its journal (without the hash chain) and custody answers since the narrowing, and SQL's two records (what the judgment
// reads of them). Then each record broken, the rebuild dropped or the new disk skipped among them, must fail it.
const STOP = "01a14cf9-10e5-70d6-92ec-d69e4b50f33c", REBUILD = "01a14cf9-13eb-73db-80e6-250b89406588", START = "01a14cf9-89d9-7e1d-8c3d-383e18838275";
const effect = (sequence, action, operationId) => [
	{ sequence, action, kind: "dispatch", operationId: null, state: null },
	{ sequence: sequence + 1, action, kind: "accepted", operationId, state: null },
	{ sequence: sequence + 2, action, kind: "settled", operationId, state: "succeeded" },
];
const RUN2 = {
	restarts: [{ operationId: STOP, state: "new-disk" }, { operationId: REBUILD, state: "replaced" }],
	custody: [
		{ intent: "rebuild", answer: "refused MACHINE_IN_USE" }, { intent: "rebuild", answer: "granted" }, { intent: "stop", answer: "granted" },
		{ intent: "stop", answer: "granted" }, { intent: "stop", answer: "granted" }, { intent: "rebuild", answer: "granted" },
		{ intent: "rebuild", answer: "refused MACHINE_IN_USE" },
	],
	journal: {
		disk: { schema: "qorpera.coding-machine-disk/v1", operationId: REBUILD },
		events: [...effect(15, "start", "01a14cf3-cff2-7baa-a0cd-66ba8ac18589"), ...effect(18, "stop", STOP), ...effect(21, "rebuild", REBUILD), ...effect(24, "start", START)],
	},
};

test("turn 9 judges run 2's records a stop for a new disk and one rebuild", () => {
	assert.deepEqual(judgeNewDisk(RUN2), {
		failures: [],
		granted: ["rebuild", "stop", "stop", "stop", "rebuild"],
		ran: [`stop ${STOP}`, `rebuild ${REBUILD}`, `start ${START}`],
	});
});

test("turn 9 fails each broken record of the new disk", () => {
	const custody = /^the executor's custody did not grant a stop, then a rebuild: /;
	const journal = /^the machine's journal does not run a stop, the rebuild and a start/;
	const restarts = /^the machine was not stopped for a new disk and then rebuilt once: /;
	const settledOf = (run, action) => run.journal.events.findLast((event) => event.kind === "settled" && event.action === action);
	const cases = [
		["the rebuild dropped", (run) => {
			run.restarts = run.restarts.filter((row) => row.state !== "replaced");
			run.custody = run.custody.filter((entry) => entry.intent !== "rebuild");
			run.journal = { disk: null, events: run.journal.events.filter((event) => event.action !== "rebuild") };
		}, [restarts, custody, journal]],
		["the new disk skipped", (run) => {
			run.restarts = [];
			run.custody = run.custody.slice(0, 1);
			run.journal = { disk: null, events: run.journal.events.slice(0, 3) };
		}, [restarts, custody, journal]],
		["no rebuild granted at all", (run) => { run.custody = run.custody.filter((entry) => entry.intent !== "rebuild"); }, [custody]],
		["the rebuild granted only as the probe before the stop", (run) => { run.custody = run.custody.slice(0, 5); }, [custody]],
		["no stop granted", (run) => { run.custody = run.custody.filter((entry) => entry.intent !== "stop"); }, [custody]],
		["every custody refused", (run) => { for (const entry of run.custody) entry.answer = "refused MACHINE_IN_USE"; }, [custody]],
		["the rebuild dropped from the journal", (run) => { run.journal.events = run.journal.events.filter((event) => event.action !== "rebuild"); }, [journal]],
		["the rebuild settled failed", (run) => { settledOf(run, "rebuild").state = "failed"; }, [journal]],
		["the stop settled failed", (run) => { settledOf(run, "stop").state = "failed"; }, [journal]],
		["the start after the rebuild settled failed", (run) => { settledOf(run, "start").state = "failed"; }, [journal]],
		["no start after the rebuild", (run) => { run.journal.events = run.journal.events.slice(0, -3); }, [journal]],
		["no stop before the rebuild", (run) => { run.journal.events = run.journal.events.filter((event) => event.action !== "stop"); }, [journal]],
		["the rebuild before the stop", (run) => {
			const [stop, rebuild] = [settledOf(run, "stop"), settledOf(run, "rebuild")];
			[stop.action, stop.operationId, rebuild.action, rebuild.operationId] = ["rebuild", REBUILD, "stop", STOP];
		}, [journal]],
		["the disk record names another operation", (run) => { run.journal.disk.operationId = START; }, [journal]],
		["no disk record", (run) => { run.journal.disk = null; }, [journal]],
		["the new disk skipped in SQL", (run) => { run.restarts = run.restarts.filter((row) => row.state !== "new-disk"); }, [restarts]],
		["no 'replaced' record", (run) => { run.restarts = run.restarts.filter((row) => row.state !== "replaced"); }, [restarts, journal]],
		["two 'replaced' records", (run) => { run.restarts.push({ ...run.restarts[1] }); }, [restarts]],
		["'replaced' before 'new-disk'", (run) => { run.restarts.reverse(); }, [restarts]],
		["SQL's 'replaced' names another operation", (run) => { run.restarts[1].operationId = START; }, [journal]],
	];
	for (const [name, broken, expected] of cases) {
		const run = structuredClone(RUN2);
		broken(run);
		const { failures } = judgeNewDisk(run);
		assert.equal(failures.length, expected.length, `${name}: ${JSON.stringify(failures)}`);
		expected.forEach((pattern, index) => assert.match(failures[index], pattern, name));
	}
});

test("the executor's control is production's, and the driver answers its requests as the stand-in's", () => {
	const source = readFileSync(executor, "utf8");
	assert.match(source, /^import \{ CodingExecutorHttpControl \} from "\.\.\/control\.ts";$/m);
	assert.match(source, /new CodingExecutorHttpControl\(\{[^}]*fetch: rest\.fetch,\s*\}\)/);
	// Review r1 F1: a copy of the control's refusal mapping here got CodingControlRefused's arguments wrong.
	assert.doesNotMatch(source, /CodingControlRefused|CodingControlBusy|VIEW_REFUSALS|t: "rpc"/);
	const driven = readFileSync(driver, "utf8");
	assert.match(driven, /if \(message\.t === "rest"\) \{\n[^\n]*\n\t*void timed\("rpc", name, restAnswer\(/);
	assert.match(driven, /return \{ name: rpc\?\.\[1\], \.\.\.postgrestError\(error\) \};/);
});
