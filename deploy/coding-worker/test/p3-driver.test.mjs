// What node --check cannot see in the P3 driver: that its imports link, and that no top-level binding is declared below
// the main flow's start (the flow's callbacks would find it uninitialized: a run's ReferenceError at its first core call,
// 38 minutes in). And that its stand-in PostgREST fails a call as PostgREST does, for the executor's control, which is
// production's own, as for the folder service. And that turn 9's judgments of the new disk and of the keep on it, and
// turn 10's of the rebuilt instance, pass a real run's records and fail each of them broken. The run-on-node plan's deploy-node step runs it, and prove-coding-session-vm.sh before it
// builds anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { identityOf, judgeIdentity, judgeKeep, judgeNewDisk, keptPass } from "./p3-c2.mjs";
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

// Turn 9's keep on the new boot (49's check): run 2's executor lines since turn 8 ended, as they were (the keeper's
// error during the rebuild, then turn 9's mount), then a keep pass that ended, as p3-executor.ts logs it, and an
// attachment shaped as SQL's with made-up times (run 2 failed before it was read, and logged no pass).
const MACHINE = "c80a26ba-d3ab-488e-b15c-ecdbcab20f25", WORKER = "2ff0dc3d-d146-4b9d-b732-36a0dc3f8c61";
const OTHER = "c80a26ba-0000-4000-8000-000000000000";
const MACHINE_DEADLINE = { machineId: MACHINE, workerId: null, step: "keep", state: "failed", code: "CODING_HOST_KEEP_DEADLINE" };
const KEEP_DEADLINE = { event: "coding-session-error", ...MACHINE_DEADLINE };
const MOUNT9 = { event: "coding-folder-mount", workerId: WORKER, machineId: MACHINE, viewId: "8791c73e-8b2b-4617-a857-f418c53f8429" };
const PASS9 = { event: "coding-keep-pass", outcomes: [{ machineId: MACHINE, workerId: WORKER, step: "keep", state: "done" }] };
const KEPT9 = {
	lines: [KEEP_DEADLINE, MOUNT9, PASS9],
	machineId: MACHINE,
	workerId: WORKER,
	attachment: { machineId: MACHINE, attachedAt: "2026-10-18T03:09:20.104218+00:00", until: "2026-10-18T03:10:31.523811+00:00", lease: 71.419593 },
};

test("turn 9 judges the keeper kept its attachment on the new boot", () => {
	assert.deepEqual(judgeKeep(KEPT9), { failures: [], before: [KEEP_DEADLINE], pass: PASS9 });
	assert.equal(keptPass(KEPT9.lines, MACHINE, WORKER), PASS9);
	// Another machine's error after the mount is not this machine's, nor its pass's failure.
	const elsewhere = { ...MACHINE_DEADLINE, machineId: OTHER };
	const other = { event: "coding-keep-pass", outcomes: [...PASS9.outcomes, elsewhere] };
	assert.deepEqual(judgeKeep({ ...KEPT9, lines: [KEEP_DEADLINE, MOUNT9, { event: "coding-session-error", ...elsewhere }, other] }).failures, []);
	// A pass that skipped the session (a turn attached it during the pass) is waited past, to the next that kept it.
	const skipped = { event: "coding-keep-pass", outcomes: [{ ...PASS9.outcomes[0], state: "not-now", code: "TURN_ATTACHED" }] };
	assert.equal(judgeKeep({ ...KEPT9, lines: [KEEP_DEADLINE, MOUNT9, skipped, PASS9] }).pass, PASS9);
	assert.equal(keptPass([KEEP_DEADLINE, MOUNT9, skipped], MACHINE, WORKER), undefined);
});

test("turn 9 fails each broken record of the keep", () => {
	const errors = /^the executor logged session errors for the machine after turn 9's view mounted: /;
	const ended = /^no keep pass ended after turn 9's view mounted with its session kept and no failure for the machine: /;
	const renewed = /^no keep renewed turn 9's attachment past its attach's 60 s: /;
	const mount = /^turn 9's view did not mount on the machine: /;
	const secrets = { machineId: MACHINE, workerId: null, step: "secrets", state: "failed", code: "CODING_FOLDER_SECRETS_FAILED" };
	const cases = [
		// The review's case: the keep RPC renewed SQL's lease, then the pass's secrets request (or its attachment step)
		// stalls to the machine's deadline. Read then, the lease alone would pass.
		["the lease renewed, its pass not ended", (run) => { run.lines.pop(); }, [ended]],
		["the lease renewed, its pass ended at the deadline", (run) => {
			run.lines.splice(2, 1, KEEP_DEADLINE, { event: "coding-keep-pass", outcomes: [MACHINE_DEADLINE] });
		}, [errors, ended]],
		["the session kept, the pass's secrets failed", (run) => {
			run.lines.splice(2, 1, { event: "coding-session-error", ...secrets }, { event: "coding-keep-pass", outcomes: [...PASS9.outcomes, secrets] });
		}, [errors, ended]],
		["the pass ended before the mount", (run) => { run.lines = [KEEP_DEADLINE, PASS9, MOUNT9]; }, [ended]],
		["the pass kept another session", (run) => { run.lines[2] = { ...PASS9, outcomes: [{ ...PASS9.outcomes[0], workerId: "2ff0dc3d-0000-4000-8000-000000000000" }] }; }, [ended]],
		["the pass kept the session on another machine", (run) => { run.lines[2] = { ...PASS9, outcomes: [{ ...PASS9.outcomes[0], machineId: OTHER }] }; }, [ended]],
		["the pass skipped the session", (run) => { run.lines[2] = { ...PASS9, outcomes: [{ ...PASS9.outcomes[0], state: "not-now", code: "TURN_ATTACHED" }] }; }, [ended]],
		["the pass took the session off", (run) => { run.lines[2] = { ...PASS9, outcomes: [{ ...PASS9.outcomes[0], step: "detach", code: "EXPIRED" }] }; }, [ended]],
		// The keeper off, or its keep RPC skipped: the attach's own 60 s, either way round its two readings of the clock.
		["no keep after the attach", (run) => { run.attachment.lease = 59.999996; }, [renewed]],
		["no keep after the attach, the clock read the other way", (run) => { run.attachment.lease = 60.000004; }, [renewed]],
		["a keep refused (the attachment cut to now)", (run) => { run.attachment.lease = 12.3; }, [renewed]],
		["the session detached", (run) => { run.attachment = { machineId: null, attachedAt: null, until: null, lease: null }; }, [renewed]],
		["no session", (run) => { run.attachment = null; }, [renewed]],
		["attached to another machine", (run) => { run.attachment.machineId = "c80a26ba-0000-4000-8000-000000000000"; }, [renewed]],
		["the keeper's deadline after the mount", (run) => { run.lines.push(KEEP_DEADLINE); }, [errors]],
		["a whole keep pass failed after the mount", (run) => { run.lines.push({ event: "coding-session-error", code: "CODING_CONTROL_BUSY" }); }, [errors]],
		["no mount on the machine", (run) => { run.lines = [KEEP_DEADLINE]; }, [mount]],
		["the mount was another machine's", (run) => { run.lines[1].machineId = "c80a26ba-0000-4000-8000-000000000000"; }, [mount]],
		["no keep and an error after the mount", (run) => { run.attachment.lease = 60; run.lines.push(KEEP_DEADLINE); }, [errors, renewed]],
	];
	for (const [name, broken, expected] of cases) {
		const run = structuredClone(KEPT9);
		broken(run);
		const { failures } = judgeKeep(run);
		assert.equal(failures.length, expected.length, `${name}: ${JSON.stringify(failures)}`);
		expected.forEach((pattern, index) => assert.match(failures[index], pattern, name));
	}
});

// Run 3's machine as LXD answers it: its real UUID, vsock id and image, and its card as the agent plug makes it
// (agent-plug.ts, with a made-up MAC: run 3 did not print the card). Run 3 read MACs only from volatile.<card>.hwaddr,
// which LXD keeps for no card with its own MAC, and failed turn 10 with the identity it read then.
const IMAGE = "697bc20130208894a5e881a769cc324124e1fe43c290c85bb39d85d39f77e1ab";
const INSTANCE3 = {
	config: { "volatile.uuid": "43285b85-d72d-40e4-b42a-3c968852f20e", "volatile.vsock_id": "2837870664", "volatile.base_image": IMAGE, "volatile.eth0.host_name": "tap1a2b3c4d" },
	expanded_devices: {
		root: { type: "disk", path: "/", pool: "default" },
		eth0: { type: "nic", nictype: "bridged", parent: "qagent0", name: "eth0", hwaddr: "0e:51:0a:d2:01:01", "ipv6.address": "none" },
	},
};
const READ3 = { uuid: "43285b85-d72d-40e4-b42a-3c968852f20e", vsockId: "2837870664", baseImage: IMAGE, hwaddrs: {} };

test("turn 10 reads the machine's card's MAC from the card, and finds the rebuilt machine the same instance", () => {
	const identity = identityOf(INSTANCE3);
	assert.deepEqual(identity, { ...READ3, hwaddrs: { eth0: "0e:51:0a:d2:01:01" } });
	assert.deepEqual(judgeIdentity({ before: identity, after: identityOf(structuredClone(INSTANCE3)), image: IMAGE }), []);
	// A card LXD gave a MAC has it only in volatile.<card>.hwaddr.
	const given = structuredClone(INSTANCE3);
	delete given.expanded_devices.eth0.hwaddr;
	given.config["volatile.eth0.hwaddr"] = "00:16:3e:12:34:56";
	assert.deepEqual(identityOf(given).hwaddrs, { eth0: "00:16:3e:12:34:56" });
});

test("turn 10 fails each broken identity of the rebuilt machine", () => {
	const none = /^LXD showed no full identity before the rebuild /;
	const image = /^volatile\.base_image is /, uuid = /^volatile\.uuid /, vsock = /^volatile\.vsock_id /, macs = /^MAC addresses /;
	const card = (instance) => instance.expanded_devices.eth0;
	const cases = [
		// Run 3's own failure: the identity it read before the rebuild had no MAC.
		["run 3's reading, no MAC", (run) => { run.before = READ3; run.after = READ3; }, [none]],
		["no card", (run) => { delete run.before.expanded_devices.eth0; delete run.after.expanded_devices.eth0; }, [none]],
		["a card with no MAC anywhere", (run) => { delete card(run.before).hwaddr; delete card(run.after).hwaddr; }, [none]],
		["no UUID", (run) => { delete run.before.config["volatile.uuid"]; }, [none, uuid]],
		["no vsock id", (run) => { delete run.before.config["volatile.vsock_id"]; }, [none, vsock]],
		["the disk from another image", (run) => { run.after.config["volatile.base_image"] = "f".repeat(64); }, [image]],
		["a new UUID", (run) => { run.after.config["volatile.uuid"] = "43285b85-0000-4000-8000-000000000000"; }, [uuid]],
		["a new vsock id", (run) => { run.after.config["volatile.vsock_id"] = "2333929551"; }, [vsock]],
		["plugged in again with another MAC", (run) => { card(run.after).hwaddr = "0e:51:0a:d2:01:02"; }, [macs]],
		["the card gone after", (run) => { delete run.after.expanded_devices.eth0; }, [macs]],
		["a second card after", (run) => { run.after.expanded_devices.eth1 = { ...card(run.after), name: "eth1", hwaddr: "0e:51:0a:d2:01:03" }; }, [macs]],
		["made again: a new UUID, vsock id and MAC", (run) => {
			Object.assign(run.after.config, { "volatile.uuid": "43285b85-0000-4000-8000-000000000000", "volatile.vsock_id": "2333929551" });
			card(run.after).hwaddr = "0e:51:0a:d2:01:02";
		}, [uuid, vsock, macs]],
	];
	for (const [name, broken, expected] of cases) {
		const run = { before: structuredClone(INSTANCE3), after: structuredClone(INSTANCE3) };
		broken(run);
		const read = (instance) => (instance.config ? identityOf(instance) : instance);
		const failures = judgeIdentity({ before: read(run.before), after: read(run.after), image: IMAGE });
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
