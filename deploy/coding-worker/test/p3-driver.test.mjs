// What node --check cannot see in the P3 driver: that its imports link, and that no top-level binding is declared below
// the main flow's start (the flow's callbacks would find it uninitialized: a run's ReferenceError at its first core call,
// 38 minutes in). And that its stand-in PostgREST fails a call as PostgREST does, for the executor's control, which is
// production's own, as for the folder service. The run-on-node plan's deploy-node step runs it, and
// prove-coding-session-vm.sh before it builds anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
