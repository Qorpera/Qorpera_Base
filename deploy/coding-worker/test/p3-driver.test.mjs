// What node --check cannot see in the P3 driver: that its imports link, and that no top-level binding is declared below
// the main flow's start (the flow's callbacks would find it uninitialized: a run's ReferenceError at its first core call,
// 38 minutes in). And that its stand-in PostgREST fails a call as PostgREST does, for the executor's control, which is
// production's own, as for the folder service. The run-on-node plan's deploy-node step runs it, and
// prove-coding-session-vm.sh before it builds anything. And for the custody proof (P3_CUSTODY=1): the forms it searches,
// the guard on the driver's output, the executor's reasons it reads, and the executor composition's broker and save check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { custodyForms, SAVE_REFUSED, withhold } from "./p3-custody.mjs";
import { postgrestError, postgrestStatus } from "./p3-postgrest-errors.mjs";

const driver = fileURLToPath(new URL("./p3-driver.mjs", import.meta.url));
const executor = fileURLToPath(new URL("./p3-executor.ts", import.meta.url));
const codingExecutor = fileURLToPath(new URL("../../../packages/runner-orchestrator/src/coding-executor.ts", import.meta.url));

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

test("the custody proof searches the value, its hex, its base64 at each offset and its URL encoding", () => {
	const value = "p3probe-Zm9vYmFy_baz-0123456789abcdefABCDEF";
	const forms = custodyForms(value);
	assert.ok(forms.includes(value));
	assert.ok(forms.includes(Buffer.from(value).toString("hex")));
	// Whatever bytes come before and after it, its base64 in either alphabet holds one of the forms.
	for (const encoding of ["base64", "base64url"])
		for (let before = 0; before < 6; before += 1)
			for (let after = 0; after < 3; after += 1) {
				const text = Buffer.concat([Buffer.alloc(before, 0xa7), Buffer.from(value), Buffer.alloc(after, 0x5c)]).toString(encoding);
				assert.ok(forms.some((form) => form !== value && text.includes(form)), `${encoding}, ${before} bytes before, ${after} after`);
			}
	// No URL form for a value URL encoding leaves alone; one for a value it changes.
	assert.ok(!forms.some((form) => form.includes("%")));
	assert.ok(custodyForms("p3 probe/value+1").includes("p3%20probe%2Fvalue%2B1"));
	// The driver's probe: every form is long enough to match nothing by chance.
	assert.ok(custodyForms(`p3probe-${"A".repeat(32)}`).every((form) => form.length >= 40));
});

test("the driver's output withholds a line that carries a form, and counts it by source", () => {
	const forms = custodyForms("p3probe-withheld-0123456789");
	const written = [];
	const stream = { write: (chunk, ...rest) => written.push([String(chunk), rest.length]) };
	const counts = {};
	withhold(stream, forms, counts);
	stream.write("PASS: nothing here\n");
	stream.write(`executor: {"event":"x","value":"${forms[0]}"}\np3: rpc ok\n`, "utf8", () => undefined);
	stream.write(Buffer.from(`p3: rpc answered ${forms[1]}\n`));
	stream.write(`something ${forms.at(-1)}\n`);
	assert.equal(written[0][0], "PASS: nothing here\n");
	assert.match(written[1][0], /^withheld: a line \(executor\) that carried a custody form \(\d+ characters\)\np3: rpc ok\n$/);
	assert.equal(written[1][1], 1, "the encoding is dropped with the text; the callback stays");
	assert.match(written[2][0], /^withheld: a line \(rpc\) /);
	assert.match(written[3][0], /^withheld: a line \(driver\) /);
	assert.ok(written.every(([text]) => !forms.some((form) => text.includes(form))));
	assert.deepEqual(counts, { executor: 1, rpc: 1, driver: 1 });
});

test("the custody proof reads the executor's own reasons for a refused save and a refused push", () => {
	const source = readFileSync(codingExecutor, "utf8");
	assert.equal(/const SAVE_REFUSAL =\n\t"([^"]*)";/.exec(source)?.[1], SAVE_REFUSED);
	assert.match(source, /return `The push was refused: \$\{where\} carries one of the session's secret values\. Remove it from the history and finish again\.`;/);
	const driven = readFileSync(driver, "utf8");
	assert.ok(driven.includes(String.raw`/^The push was refused: (.*) carries one of the session's secret values\. Remove it from the history and finish again\.$/`));
});

test("the executor composition asks the broker as production's client, and gives the save check the machine's values", () => {
	const source = readFileSync(executor, "utf8");
	assert.match(source, /new CodingMachineCommandSecrets\(new BrokerCodingEnvironment\(\{[^}]*fetch: broker\.fetch \}\)\)/);
	assert.match(source, /\.\.\.\(commandSecrets \? \{ commandSecrets \} : \{\}\),/);
	// The host reads the boundaries' secrets at a session's attach: without it, the attach fails on a TypeError.
	assert.match(source, /const boundaries: Pick<CodingFolderControl, "boundary" \| "restarted" \| "secrets"> = \{/);
	assert.match(source, /new CodingFolderControl\(\{ \.\.\.\(config\.folder\.controlSocket \? \{ path: config\.folder\.controlSocket \} : \{\}\), secrets \}\)/);
	assert.match(source, /else if \(message\.t === "broker"\) broker\.answer\(message\);/);
});
