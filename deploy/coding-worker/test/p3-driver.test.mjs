// What node --check cannot see in the P3 driver: that its imports link, and that no top-level binding is declared below
// the main flow's start (the flow's callbacks would find it uninitialized: a run's ReferenceError at its first core call,
// 38 minutes in). And that its stand-in PostgREST fails a call as PostgREST does, for the executor's control, which is
// production's own, as for the folder service. And that the archive's judgment (49's archive row), turn 9's of the new
// disk and of the keep on it, and turn 10's of the rebuilt instance, pass a real run's records and fail each of them
// broken. And for the custody proof (P3_CUSTODY=1): the forms it searches, the guard on the driver's output, the
// executor's reasons it reads, the refusals it lets a turn's boundaries give (a way out's commands' deletes of published
// objects among them), the executor composition's broker and save check, its search of the company folder's git
// objects, the pack it writes whose value is whole only in a resolved delta, and the refusal's way out it takes, with the
// check after it. The run-on-node plan's deploy-node step runs it, and prove-coding-session-vm.sh before it builds
// anything.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { identityOf, judgeIdentity, judgeKeep, judgeNewDisk, keptPass } from "./p3-c2.mjs";
import {
	CARRIES, countSearch, custodyForms, DELTA_PACK, fileSearch, GIT_OBJECT_DELETE, GIT_WAY_OUT, gitObjectSearch, goneScript, SAVE_REFUSED, turnRefusals,
	WAITS_FOR_REFUSED, wayOutScript, withhold,
} from "./p3-custody.mjs";
import { detachDone, judgeArchive } from "./p3-order9.mjs";
import { postgrestError, postgrestStatus } from "./p3-postgrest-errors.mjs";

const driver = fileURLToPath(new URL("./p3-driver.mjs", import.meta.url));
const executor = fileURLToPath(new URL("./p3-executor.ts", import.meta.url));
const codingExecutor = fileURLToPath(new URL("../../../packages/runner-orchestrator/src/coding-executor.ts", import.meta.url));
const secretScan = fileURLToPath(new URL("../../../packages/object-gateway/src/folder-service/secret-scan.ts", import.meta.url));
const plan = fileURLToPath(new URL("../../../packages/object-gateway/src/folder-service/plan.ts", import.meta.url));
const folderGit = fileURLToPath(new URL("../../../packages/object-gateway/src/folder-service/git.ts", import.meta.url));
const gitRules = fileURLToPath(new URL("../../../supabase/migrations/20260930446200_folder_git_rules.sql", import.meta.url));

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

// The archive's row (49's), on evidence run 3's executor lines after its archive (node02 20261018T031524-61288-88f952c7,
// its machine and worker): its first take-off failed CODING_FOLDER_VIEW_UNSAVED, as master's does today, and a later one
// recorded the detach.
// The keep passes are as p3-executor.ts logs them now (run 3 logged none), and the core's copy and the store's bytes
// are made up: run 3's command wrote nothing. With 49's fix the first take-off saves the line and reports it done.
const MACHINE3 = "3c8c07b4-5211-41ba-8458-896548b57a24", WORKER3 = "dafac108-7649-47fc-b4e7-af33e346674f";
const UNSAVED = { machineId: MACHINE3, workerId: WORKER3, step: "detach", state: "failed", code: "CODING_FOLDER_VIEW_UNSAVED" };
const DETACHED = { machineId: MACHINE3, workerId: WORKER3, step: "detach", state: "done", code: "ARCHIVED" };
const MOUNT4 = { event: "coding-folder-mount", workerId: WORKER3, machineId: MACHINE3, viewId: "98134fbb-e8bb-4186-bf18-282cb64c2e41" };
const STOPPED = "stopped\n";
const ARCHIVED = {
	lines: [{ event: "coding-keep-pass", outcomes: [DETACHED] }],
	workerId: WORKER3,
	entry: {
		version: "01a14d10-0000-7000-8000-000000000001", fileSha256: "f247a76b2893208aae7751dbf51f4c495efacfb6d9e743802870300f31ac45c8", bytes: 8,
		commitId: "01a14d10-0000-7000-8000-000000000002",
	},
	stored: STOPPED,
	text: STOPPED,
};

test("the archive judges a take-off that saved what the stopped command wrote", () => {
	assert.deepEqual(judgeArchive(ARCHIVED), { failures: [], done: DETACHED });
	// Another session's failed detach is not this one's; a pass that skipped the take-off is waited past.
	const elsewhere = { ...UNSAVED, workerId: "dafac108-0000-4000-8000-000000000000" };
	const busy = { ...DETACHED, state: "not-now", code: "MACHINE_IN_USE" };
	const lines = [{ event: "coding-session-error", ...elsewhere }, { event: "coding-keep-pass", outcomes: [elsewhere, busy] }, ...ARCHIVED.lines];
	assert.deepEqual(judgeArchive({ ...ARCHIVED, lines }), { failures: [], done: DETACHED });
	assert.equal(detachDone(lines.slice(0, 2), WORKER3), undefined);
});

test("the archive fails master's take-off and each broken record of it", () => {
	const errors = /^the executor logged session errors for the archive's detach: /;
	const done = /^no keep pass reported the archive's detach done: /;
	const copy = /^the folder's copy of the file is not "stopped\\n": /;
	const store = /^the node's store does not hold the file's bytes: /;
	const master = [{ event: "coding-session-error", ...UNSAVED }, { event: "coding-keep-pass", outcomes: [UNSAVED] }, MOUNT4, ...ARCHIVED.lines];
	const cases = [
		// Master today (run 3's lines): the line lost with the session's state, and the error logged.
		["master's take-off", (run) => { run.lines = master; run.entry = null; run.stored = null; }, [errors, copy]],
		["the take-off failed, though the line was saved", (run) => { run.lines = master; }, [errors]],
		["no pass reported the take-off", (run) => { run.lines = []; }, [done]],
		["only the failed take-off reported", (run) => { run.lines = master.slice(0, 2); }, [errors, done]],
		["the pass reported another session's take-off", (run) => { run.lines[0].outcomes[0].workerId = "dafac108-0000-4000-8000-000000000000"; }, [done]],
		["the pass skipped the take-off", (run) => { Object.assign(run.lines[0].outcomes[0], { state: "not-now", code: "MACHINE_IN_USE" }); }, [done]],
		["the session detached for another reason", (run) => { run.lines[0].outcomes[0].code = "REVOKED"; }, [done]],
		["the folder has no such file", (run) => { run.entry = null; }, [copy]],
		["the command wrote nothing", (run) => {
			Object.assign(run.entry, { fileSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", bytes: 0 });
		}, [copy]],
		["the folder's copy has the line's sha256 but another size", (run) => { run.entry.bytes = 9; }, [copy]],
		["the store has no bytes for it", (run) => { run.stored = null; }, [store]],
		["the store's bytes are another file's", (run) => { run.stored = "stop\n"; }, [store]],
	];
	for (const [name, broken, expected] of cases) {
		const run = structuredClone(ARCHIVED);
		broken(run);
		const { failures } = judgeArchive(run);
		assert.equal(failures.length, expected.length, `${name}: ${JSON.stringify(failures)}`);
		expected.forEach((pattern, index) => assert.match(failures[index], pattern, name));
	}
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

test("the custody proof reads the executor's own reason for a refused save, and the folder's for a path that carries a value or waits for one", () => {
	// The refusal, then its way out of a git commit that carried the value: a string on master, and with #1299 a
	// template that gives GIT_WAY_OUT's text.
	const source = readFileSync(codingExecutor, "utf8");
	const wayOutText = /const GIT_WAY_OUT =\n\t"([^"]*)";/.exec(source)?.[1];
	const template = /^const SAVE_REFUSAL = `((?:[^`\\]|\\.)*)`;$/m.exec(source)?.[1]?.replace(/\\(.)/g, "$1");
	const refusal = template?.replaceAll("${GIT_WAY_OUT}", wayOutText ?? "(no GIT_WAY_OUT)") ??
		/const SAVE_REFUSAL =\n\t"([^"]*)";/.exec(source)?.[1];
	assert.ok(refusal?.startsWith(SAVE_REFUSED), refusal);
	assert.doesNotMatch(refusal, /\$\{/);
	// Past its start, the refusal gives each step of the way out in backticks, in order, as the driver checks.
	if (refusal.length > SAVE_REFUSED.length) {
		const at = GIT_WAY_OUT.map((step) => refusal.indexOf(`\`${step}\``, SAVE_REFUSED.length));
		assert.ok(at.every((index, n) => index > (at[n - 1] ?? 0)), refusal);
	}
	assert.match(readFileSync(secretScan, "utf8"), new RegExp(`^export const CARRIES = ${JSON.stringify(CARRIES)};$`, "m"));
	assert.match(readFileSync(plan, "utf8"), new RegExp(`^export const WAITS_FOR_REFUSED = ${JSON.stringify(WAITS_FOR_REFUSED)};$`, "m"));
});

test("a turn's save is judged by its end's last boundary, and a refusal for another reason fails it wherever it comes", () => {
	const UNCHECKED = /^export const UNCHECKED = "([^"]*)";$/m.exec(readFileSync(secretScan, "utf8"))?.[1];
	assert.ok(UNCHECKED);
	const repoGit = "code/qorpera/proof/repo.git/";
	const carrier = `${repoGit}objects/ab/cdef0123`;
	const pack = `${repoGit}objects/pack/pack-0123.pack`;
	const held = `${repoGit}logs/HEAD`;
	const refused = (path, reason = CARRIES) => ({ path, reason });
	const judged = (answers, end) => {
		const { refused: last, odd, unread, ends } = turnRefusals(answers, end, repoGit);
		return { refused: [...last], odd, unread, ends };
	};
	// Review r1 F2: a cleanup's command shows output while the carrier it removes is still there, so that boundary refuses
	// it; the turn's end refuses nothing, and saves.
	assert.deepEqual(judged([[], [refused(carrier)], [refused(carrier), refused(held, WAITS_FOR_REFUSED)], []], 3),
		{ refused: [], odd: [], unread: 0, ends: 1 });
	// Turn 6: a boundary refuses the loose blob before the repack; the end refuses only the pack, and holds back the rest.
	assert.deepEqual(judged([[refused(carrier)], [refused(pack), refused(held, WAITS_FOR_REFUSED)]], 1),
		{ refused: [[pack, CARRIES], [held, WAITS_FOR_REFUSED]], odd: [], unread: 0, ends: 1 });
	// An end asked again while a check runs: its last answer decides.
	assert.deepEqual(judged([[], [], [refused(pack)]], 1), { refused: [[pack, CARRIES]], odd: [], unread: 0, ends: 2 });
	// Review r1 F3: a refusal for another reason is odd, though a later answer says the path carries the value; so is a
	// hold outside a repo.git. Each is named once.
	assert.deepEqual(judged([[refused(carrier, UNCHECKED)], [refused(carrier, UNCHECKED)], [refused(carrier)]], 2),
		{ refused: [[carrier, CARRIES]], odd: [[carrier, UNCHECKED]], unread: 0, ends: 1 });
	const file = "code/qorpera/proof/worktrees/w1/p3-probe.txt";
	assert.deepEqual(judged([[refused(file, WAITS_FOR_REFUSED)], []], 1).odd, [[file, WAITS_FOR_REFUSED]]);
	// An answer that cannot be read is counted; an end that got no answer has none, and refuses nothing.
	assert.deepEqual(judged([null, [refused(carrier)]], 2), { refused: [], odd: [], unread: 1, ends: 0 });
	// The driver takes the end's mark before it finishes the turn, and both judgments ask each of these.
	const driven = readFileSync(driver, "utf8");
	assert.match(driven, /const end = executor\.boundaries\.length;\n(?:[^\n]*\n)?\t*await database\.finishTurn\(/);
	assert.ok(driven.includes("...turnRefusals(executor.boundaries.slice(mark), end - mark, `${code}/repo.git/`, out !== null),"));
	assert.equal(driven.split("end.odd.length || !end.ends || end.unread").length, 3, "refusedTurn and savedTurn");
	assert.ok(!driven.includes("refusalsSince"));
});

test("a way out's commands may be refused the deletes of published objects, by design, and no other refusal with them", () => {
	const UNCHECKED = /^export const UNCHECKED = "([^"]*)";$/m.exec(readFileSync(secretScan, "utf8"))?.[1];
	assert.ok(UNCHECKED);
	const repoGit = "code/qorpera/proof/repo.git/";
	const sha1 = "0123456789abcdef0123456789abcdef01234567";
	const sha256 = `${sha1}${"89abcdef".repeat(3)}`;
	const deleted = (rest, reason = GIT_OBJECT_DELETE) => ({ path: `${repoGit}${rest}`, reason });
	const judged = (answers, end, wayOut) => {
		const { refused, odd, deletes } = turnRefusals(answers, end, repoGit, wayOut);
		return { refused: [...refused], odd, deletes };
	};
	// After-run 2's turn 3 (20261018T155118-20773-222213a3): the boundary after the way out's repack and prune was refused
	// the deletes of the published pack's three files, of three loose objects and of their three folders. A way out's
	// command boundary may be refused them, each path counted once; the end refuses nothing, and saves.
	const published = [
		...["pack", "idx", "rev"].map((kind) => `objects/pack/pack-${sha1}.${kind}`),
		...["08", "4d", "c5"].flatMap((folder) => [`objects/${folder}`, `objects/${folder}/${sha1.slice(2)}`]),
	];
	assert.deepEqual(judged([[], published.map((rest) => deleted(rest)), published.map((rest) => deleted(rest)), []], 3, true),
		{ refused: [], odd: [], deletes: 9 });
	// At the end they are odd, though the way out ran; and in a turn without the way out, at a command's boundary too.
	const odd = published.map((rest) => [`${repoGit}${rest}`, GIT_OBJECT_DELETE]);
	assert.deepEqual(judged([[], published.map((rest) => deleted(rest))], 1, true),
		{ refused: published.map((rest) => [`${repoGit}${rest}`, GIT_OBJECT_DELETE]), odd, deletes: 0 });
	assert.deepEqual(judged([published.map((rest) => deleted(rest)), []], 1, false), { refused: [], odd, deletes: 0 });
	assert.deepEqual(turnRefusals([published.map((rest) => deleted(rest)), []], 1, repoGit).odd, odd, "no way out unless the driver says so");
	// Only a published object's path, as folder-service/git.ts gitPublishedObject takes it, or a loose object's folder:
	// refs, packed-refs, git's own indexes, a pack's .keep, a temporary pack, the objects and pack folders are odd.
	const others = ["refs/heads/main", "packed-refs", "logs/HEAD", "objects/info/packs", "objects/info/commit-graph",
		"objects/pack/multi-pack-index", `objects/pack/pack-${sha1}.keep`, `objects/pack/tmp_pack_${sha1}`, "objects/pack", "objects",
		"objects/ab/cdef", "objects/AB", `objects/incoming-Q1/pack/pack-${sha1}.pack`];
	for (const rest of others)
		assert.deepEqual(judged([[deleted(rest)], []], 1, true), { refused: [], odd: [[`${repoGit}${rest}`, GIT_OBJECT_DELETE]], deletes: 0 }, rest);
	const shapes = [...published, `objects/${sha256.slice(0, 2)}/${sha256.slice(2)}`, `objects/pack/pack-${sha256}.pack`,
		...["bitmap", "mtimes", "promisor"].map((kind) => `objects/pack/pack-${sha1}.${kind}`)];
	for (const rest of shapes) assert.equal(judged([[deleted(rest)], []], 1, true).deletes, 1, rest);
	const objectShape = /^\t\t\/(\^objects\\\/[^\n]*\$)\/\.test\($/m.exec(readFileSync(folderGit, "utf8"))?.[1];
	assert.ok(objectShape, "gitPublishedObject's pattern");
	for (const rest of [...shapes, ...others])
		assert.equal(new RegExp(objectShape).test(rest) || /^objects\/[0-9a-f]{2}$/.test(rest), shapes.includes(rest), rest);
	// Under the turn's repo.git only: another area's, or a worktree's path, is odd.
	for (const path of [`code/qorpera/other/repo.git/objects/pack/pack-${sha1}.pack`, `code/qorpera/proof/worktrees/w1/objects/pack/pack-${sha1}.pack`])
		assert.deepEqual(judged([[{ path, reason: GIT_OBJECT_DELETE }], []], 1, true).odd, [[path, GIT_OBJECT_DELETE]], path);
	// Another reason on a published object's path is odd, at a way out's command boundary too.
	for (const reason of ["git_platform_only", "git_keep_file", UNCHECKED])
		assert.deepEqual(judged([[deleted(published[0], reason)], []], 1, true).odd, [[`${repoGit}${published[0]}`, reason]], reason);
	// The reason is the core's for a session's delete under repo.git/objects (RUNTIME-COMPANY-FOLDER.md §6).
	assert.match(readFileSync(gitRules, "utf8"), /^\t\tif p_op in \('delete','rmdir'\) then return 'git_object_delete'; end if;$/m);
	assert.equal(GIT_OBJECT_DELETE, "git_object_delete");
	// The driver lets them through only in the turns that take the way out (3, 7 and 9), each with its own.
	const driven = readFileSync(driver, "utf8");
	const ends = [...driven.matchAll(/await endTurn\(turn(\d), \1, mark\1, [^\n]*?, head9?, "(?:failed|completed)"(, out\1)?\)/g)];
	assert.equal(ends.length, driven.split("await endTurn(").length - 1, "every turn's end");
	assert.deepEqual(ends.filter((call) => call[2]).map((call) => call[1]), ["3", "7", "9"]);
	for (const n of ["3", "7", "9"]) assert.match(driven, new RegExp(`const out${n} = await wayOut\\(turn${n}, gateway${n}, ${n}, `));
	assert.equal(driven.split("${deleted(end").length - 1, 3, "each way out's pass line counts them");
});

test("the custody proof's searches fail when what they read fails, though it printed the control first", (t) => {
	const root = mkdtempSync(join(tmpdir(), "p3-search-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const control = `p3-control-${randomBytes(16).toString("hex")}`;
	const needles = join(root, "control");
	writeFileSync(needles, `${control}\n`);
	const bash = (script, file = needles) => spawnSync("bash", ["--noprofile", "--norc", "-c", script, "p3", file], { encoding: "utf8" });
	// A producer that reads to its end: the count of lines with the control, or none.
	let run = bash(countSearch("printf 'a\\n%s\\nb\\n' \"$(cat \"$1\")\""));
	assert.deepEqual([run.status, run.stdout.trim()], [0, "1"], run.stderr);
	run = bash(countSearch("printf 'a\\nb\\n'"));
	assert.deepEqual([run.status, run.stdout.trim()], [0, "0"], run.stderr);
	// Review r1 F1: one that prints the control, then fails before the rest, is no answer. Nor is a grep with no lines.
	run = bash(countSearch("{ cat \"$1\"; exit 3; }"));
	assert.equal(run.status, 2, run.stdout);
	assert.match(run.stderr, /the search failed: its producer and grep ended 3 0/);
	assert.equal(bash(countSearch("printf 'a\\n'"), join(root, "missing")).status, 2);

	// The files under each place that exists (a pattern that matches none is skipped): each that holds the control.
	const places = join(root, "places");
	mkdirSync(join(places, "deep"), { recursive: true });
	writeFileSync(join(places, "deep", "holds"), `x ${control} y`);
	writeFileSync(join(places, "clean"), "nothing");
	run = bash(fileSearch([places, join(root, "absent"), join(root, "none-*")]));
	assert.deepEqual([run.status, run.stdout.trim()], [0, join(places, "deep", "holds")], run.stderr);
	// A file grep cannot read fails it (root reads every file).
	if (process.getuid?.() !== 0) {
		writeFileSync(join(places, "unread"), "anything", { mode: 0o000 });
		run = bash(fileSearch([places]));
		assert.equal(run.status, 2, run.stdout);
		assert.match(run.stderr, /^the file search failed: grep ended 2: grep: .*\/unread: Permission denied$/m);
	}
	// No lines to search for, or no place to search: no answer.
	assert.equal(bash(fileSearch([places]), join(root, "missing")).status, 2);
	assert.equal(bash(fileSearch([join(root, "absent")])).status, 2);
	// The driver's searches are these, and a search that fails fails the run.
	const driven = readFileSync(driver, "utf8");
	assert.ok(driven.includes('const PLACES = fileSearch(["/srv/nas", '));
	assert.ok(driven.includes('const GITHUB = countSearch("git --git-dir /srv/p3-github/qorpera-p3/proof.git cat-file --batch-all-objects --batch");'));
	assert.ok(driven.includes('const JOURNAL = countSearch("journalctl --no-pager -o cat");'));
	assert.match(driven, /const search = \(script, needles\) => \{\n\t*try \{\n\t*return lxc\("exec", vm, "--", "bash", "-c", script, "p3", needles\)\.trim\(\);\n\t*\} catch \(error\) \{\n\t*return fail\(/);
});

test("the executor composition asks the broker as production's client, and gives the save check the machine's values", () => {
	const source = readFileSync(executor, "utf8");
	assert.match(source, /new CodingMachineCommandSecrets\(new BrokerCodingEnvironment\(\{[^}]*fetch: broker\.fetch \}\)\)/);
	assert.match(source, /\.\.\.\(commandSecrets \? \{ commandSecrets \} : \{\}\),/);
	// The host reads the boundaries' secrets at a session's attach: without it, the attach fails on a TypeError.
	assert.match(source, /const boundaries: Pick<CodingFolderControl, "boundary" \| "restarted" \| "secrets"> = \{/);
	// The views' final boundaries go through the same control, so their save check gets the values too.
	assert.match(source, /new CodingFolderControl\(\{ path: await boundaryWitness\(config\.folder\.controlSocket \?\? CODING_FOLDER_CONTROL_SOCKET\), secrets \}\)/);
	assert.match(source, /new CodingFolderViews\(\{ control, folder: boundaries, /);
	assert.match(source, /else if \(message\.t === "broker"\) broker\.answer\(message\);/);
});

test("the custody proof finds a value in the folder's git objects: loose in the store, loose or packed in the saved repo.git, and " +
	"a refused object's every place there", (t) => {
	const root = mkdtempSync(join(tmpdir(), "p3-git-search-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const value = `p3probe-${randomBytes(16).toString("hex")}`;
	const control = `p3-control-${randomBytes(16).toString("hex")}`;
	const forms = custodyForms(value);
	writeFileSync(join(root, "forms"), forms.join("\n"));
	writeFileSync(join(root, "control"), control);
	const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
	const repository = (name) => {
		const work = join(root, name);
		execFileSync("git", ["init", "-q", work], { stdio: "pipe" });
		const git = (...args) => execFileSync("git", ["-C", work, "-c", "user.name=P3", "-c", "user.email=p3@qorpera.invalid", ...args],
			{ encoding: "utf8", stdio: "pipe" }).trim();
		const commit = (files, message) => {
			for (const [file, text] of Object.entries(files))
				if (text === null) rmSync(join(work, file));
				else writeFileSync(join(work, file), text);
			git("add", "-A");
			git("commit", "-q", "-m", message);
			return git("rev-parse", "HEAD");
		};
		const objects = join(work, ".git", "objects");
		const files = () => readdirSync(objects, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
			.map((entry) => relative(objects, join(entry.parentPath, entry.name)));
		return { git, commit, objects, files };
	};
	const blob = (text) => execFileSync("git", ["hash-object", "--stdin"], { input: text, encoding: "utf8" }).trim();
	const noise = randomBytes(6000).toString("hex").match(/.{1,64}/g).join("\n");

	// Loose, as a turn leaves them: a value committed and removed, a big file that starts with it, and a control.
	const loose = repository("loose");
	loose.commit({ "leak.txt": `P3 custody\n${value}\n`, "big.txt": `${value}\n${noise}\n` }, "a value");
	const headLoose = loose.commit({ "leak.txt": null, "big.txt": null, "control.txt": `${control}\n` }, "a control");
	// Packed: the value only in a blob the pack holds as a delta of a bigger one.
	const packed = repository("packed");
	const base = `${noise}\n${randomBytes(2000).toString("hex")}\n`;
	packed.commit({ "big.txt": base }, "base");
	packed.commit({ "big.txt": `${noise}\n${value}\n` }, "a value");
	const headPacked = packed.commit({ "big.txt": base, "control.txt": `${control}\n` }, "a control");
	packed.git("repack", "-a", "-d", "-f", "-q");
	const [pack] = packed.files().filter((file) => file.endsWith(".pack"));
	const deltified = blob(`${noise}\n${value}\n`);
	const verified = packed.git("verify-pack", "-v", join(packed.objects, pack.replace(/\.pack$/, ".idx"))).split("\n");
	assert.equal(verified.find((line) => line.startsWith(deltified))?.split(/\s+/).length, 7, "the value's blob is a delta in the pack");
	assert.ok(!packed.files().some((file) => /^[0-9a-f]{2}\//.test(file)), "no loose object is left");
	// Refused: a value in a pack, which one repository saves only the index of (git reads none of its objects) and another
	// only the pack of (the search indexes it, as git must).
	const refused = repository("refused");
	const headRefused = refused.commit({ "refused.txt": `P3 refused\n${value}\n` }, "a refused value");
	refused.git("repack", "-a", "-d", "-q");
	const refusedPack = refused.files().find((file) => file.endsWith(".pack"));
	const refusedIndex = refusedPack.replace(/\.pack$/, ".idx");
	const refusedObjects = refused.git("verify-pack", "-v", join(refused.objects, refusedIndex)).split("\n").filter((line) => /^[0-9a-f]{40} /.test(line)).length;
	assert.ok(!refused.files().some((file) => /^[0-9a-f]{2}\//.test(file)), "no loose object is left");

	// The store and the saved folder's path versions: a loose object in one chunk (the big one in two), a pack in three.
	const store = join(root, "store");
	const profile = join(store, "00000000-0000-4000-8000-000000000001");
	mkdirSync(profile, { recursive: true });
	const put = (bytes) => {
		writeFileSync(join(profile, sha256(bytes)), bytes);
		return sha256(bytes);
	};
	const bigLoose = blob(`${value}\n${noise}\n`);
	const save = (path, bytes, parts) => {
		const size = Math.ceil(bytes.length / parts);
		const chunks = Array.from({ length: parts }, (_, index) => bytes.subarray(index * size, (index + 1) * size));
		const manifest = JSON.stringify({ schema: "qorpera.cloud-file-manifest/v2", fileSha256: sha256(bytes), bytes: bytes.length,
			mediaType: "application/octet-stream", executable: false, chunks: chunks.map((chunk) => ({ sha256: put(chunk), bytes: chunk.length })) });
		return { path, manifest: put(Buffer.from(manifest)), file: sha256(bytes) };
	};
	const saved = [];
	for (const [name, at] of [["loose", loose], ["packed", packed]])
		for (const file of at.files())
			saved.push(save(`code/qorpera/${name}/repo.git/objects/${file}`, readFileSync(join(at.objects, file)),
				file === `${bigLoose.slice(0, 2)}/${bigLoose.slice(2)}` ? 2 : file.endsWith(".pack") ? 3 : 1));
	saved.push(save(`code/qorpera/refused/repo.git/objects/${refusedIndex}`, readFileSync(join(refused.objects, refusedIndex)), 1));
	saved.push(save(`code/qorpera/unindexed/repo.git/objects/${refusedPack}`, readFileSync(join(refused.objects, refusedPack)), 3));
	// The pack whole too, unnamed, as a refused save's bytes may wait in the store.
	put(readFileSync(join(packed.objects, pack)));
	// Alternates would have git read the packed repository's objects from the disk: not followed.
	saved.push(save("code/qorpera/loose/repo.git/objects/info/alternates", Buffer.from(`${packed.objects}\n`), 1));
	// A saved file whose bytes the store lacks is counted.
	saved.push({ path: `code/qorpera/loose/repo.git/objects/ff/${"0".repeat(38)}`, manifest: "e".repeat(64), file: "e".repeat(64) });

	const leak = blob(`P3 custody\n${value}\n`);
	const leakRefused = blob(`P3 refused\n${value}\n`);
	const found = gitObjectSearch(createRequire(import.meta.url), { store, saved, forms: join(root, "forms"), control: join(root, "control"),
		oids: [headLoose, headPacked, headRefused], refused: [leak, deltified, leakRefused, blob("never written\n")], scratch: root });
	const text = JSON.stringify(found);
	assert.ok(!forms.some((form) => text.includes(form)) && !text.includes(control), "only counts, ids and paths");
	assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("p3-git-")), [], "the rebuilt repositories are removed");
	const looseObjects = loose.files().filter((file) => /^[0-9a-f]{2}\//.test(file)).length;
	const kept = blob(`${control}\n`);
	// The store: each loose object inflates; the big one's first chunk holds its start, the value in it, and no id. The
	// whole pack is read, deltas resolved; the first of each pack's three chunks starts one, and cannot be read alone.
	assert.equal(found.store.git, looseObjects);
	assert.equal(found.store.packs, 1);
	assert.equal(found.store.unreadPacks, 2);
	const inStore = (list) => list.map(({ oid, type, pack: inPack }) => `${oid} ${type}${inPack ? " pack" : ""}`).sort();
	assert.deepEqual(inStore(found.store.forms), [`${leak} blob`, "null blob", `${deltified} blob pack`].sort());
	assert.deepEqual(inStore(found.store.control), [`${kept} blob`, `${kept} blob pack`].sort());
	assert.deepEqual(found.store.seen.sort(), [headLoose, headPacked].sort());
	// The saved folder: each repository whole, where each object is, the alternates not followed, the missing file; the
	// lone index read by no git, the lone pack indexed and read.
	const loosePath = (oid) => `loose code/qorpera/loose/repo.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
	const packPath = `pack code/qorpera/packed/repo.git/objects/${pack}`;
	const unindexedPath = `pack code/qorpera/unindexed/repo.git/objects/${refusedPack}`;
	assert.equal(found.saved.repositories, 4);
	assert.equal(found.saved.missing, 1);
	assert.equal(found.saved.files, saved.length);
	assert.equal(found.saved.objects, looseObjects + verified.filter((line) => /^[0-9a-f]{40} /.test(line)).length + refusedObjects);
	const where = (list) => list.map(({ oid, type, where: at }) => `${oid} ${type} ${at.join(" + ")}`).sort();
	assert.deepEqual(where(found.saved.forms), [`${leak} blob ${loosePath(leak)}`, `${bigLoose} blob ${loosePath(bigLoose)}`,
		`${deltified} blob ${packPath}`, `${leakRefused} blob ${unindexedPath}`].sort());
	assert.deepEqual(where(found.saved.control), [`${kept} blob ${loosePath(kept)}`, `${kept} blob ${packPath}`].sort());
	assert.deepEqual(found.saved.seen.sort(), [headLoose, headPacked, headRefused].sort());
	// Each refused object's every place: loose, in a saved pack (its index saved or built), and listed by a lone index.
	assert.deepEqual(found.saved.refused.map(({ oid, where: at }) => `${oid} ${at}`).sort(), [`${leak} ${loosePath(leak)}`, `${deltified} ${packPath}`,
		`${leakRefused} index code/qorpera/refused/repo.git/objects/${refusedIndex}`, `${leakRefused} ${unindexedPath}`].sort());
});

test("the driver runs the git object search in the node, after the file search, on the saved folder's git files", () => {
	const driven = readFileSync(driver, "utf8");
	const files = driven.indexOf('const fileHits = search(PLACES, "/root/p3-custody-forms")');
	const objects = driven.indexOf("`(${gitObjectSearch})(require, JSON.parse(require(\"node:fs\").readFileSync(process.argv[1], \"utf8\")))))`");
	assert.ok(files > 0 && objects > files, "the rebuilt repositories, in the node's /root, come after the file search");
	assert.ok(driven.includes("and path like 'code/%/repo.git/objects/%') as v\");"));
	assert.ok(driven.includes('oids: [head9], refused: refusedOids, scratch: "/root" }));'));
});

test("the custody proof's delta pack holds the value whole in no object as the pack stores it, only in the resolved delta", (t) => {
	const root = mkdtempSync(join(tmpdir(), "p3-delta-pack-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
	const value = `p3probe-${randomBytes(24).toString("base64url")}`;
	const output = execFileSync("bash", ["--noprofile", "--norc", "-c", DELTA_PACK], { cwd: root, env: { ...process.env, P3_PROBE: value }, encoding: "utf8" });
	assert.ok(!output.includes(value));
	const fields = Object.fromEntries(output.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
	assert.match(fields.pack, /^pack-[0-9a-f]{40}$/);
	assert.match(fields.base, /^[0-9a-f]{40}$/);
	assert.equal(fields.delta, `7 ${fields.base}`, "the target is a delta on the base");
	assert.deepEqual([fields["in-base"], fields["in-target"], fields["in-pack"], fields.loose], ["0", "1", "0", "0"]);
	// Each object inflated as the pack stores it (the target as its delta's instructions): none holds the value.
	const pack = join(root, ".git", "objects", "pack", fields.pack);
	const bytes = readFileSync(`${pack}.pack`);
	const entries = execFileSync("git", ["-C", root, "verify-pack", "-v", `${pack}.idx`], { encoding: "utf8" }).split("\n")
		.map((line) => line.split(/\s+/)).filter((parts) => /^[0-9a-f]{40}$/.test(parts[0]));
	assert.deepEqual(entries.map((parts) => parts[0]).sort(), [fields.base, fields.target].sort());
	const types = {};
	for (const [oid, , , stored, offset] of entries) {
		const entry = bytes.subarray(Number(offset), Number(offset) + Number(stored));
		// The entry's header: its type and size, then an offset delta's base offset or a ref delta's base id.
		let at = 0;
		while (entry[at] & 0x80) at += 1;
		at += 1;
		const type = (entry[0] >> 4) & 7;
		if (type === 6) {
			while (entry[at] & 0x80) at += 1;
			at += 1;
		} else if (type === 7) at += 20;
		types[oid] = type;
		assert.ok(!inflateSync(entry.subarray(at)).includes(value), `the pack's ${oid}`);
	}
	// The base whole (a blob, type 3), the target a delta on its id (type 7).
	assert.deepEqual(types, { [fields.base]: 3, [fields.target]: 7 });
});

test("the refusal's way out leaves git none of a refused commit's value, loose, packed or in a delta pack, and the check after it sees that", (t) => {
	const root = mkdtempSync(join(tmpdir(), "p3-way-out-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const value = `p3probe-${randomBytes(24).toString("base64url")}`;
	const ident = { GIT_AUTHOR_NAME: "P3", GIT_AUTHOR_EMAIL: "p3@qorpera.invalid", GIT_COMMITTER_NAME: "P3", GIT_COMMITTER_EMAIL: "p3@qorpera.invalid" };
	const bash = (script) => {
		const output = execFileSync("bash", ["--noprofile", "--norc", "-c", script], { cwd: root, env: { ...process.env, ...ident, P3_PROBE: value }, encoding: "utf8" });
		assert.ok(!output.includes(value));
		return Object.fromEntries(output.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
	};
	const ids = (field) => (field ?? "").split(" ").filter(Boolean).sort();
	execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
	writeFileSync(join(root, "control.txt"), "a control\n");
	bash("git add control.txt && git commit -q -m control");
	// A commit whose blob carries the value, refused at its ref update: the branch stays where it was, and only the index
	// and the worktree's HEAD log name the commit and its blob.
	const refuse = (file) => bash(`blob=$(printf '%s\\n%s\\n' '${file}' "$P3_PROBE" | git hash-object -w --stdin) && ` +
		`git update-index --add --cacheinfo "100644,$blob,${file}" && head=$(git rev-parse HEAD) && made=$(git commit-tree "$(git write-tree)" -p "$head" -m refused) && ` +
		`printf '%s %s P3 <p3@qorpera.invalid> %s +0000\\tcommit: refused\\n' "$head" "$made" "$(date +%s)" >>"$(git rev-parse --git-path logs/HEAD)" && ` +
		`echo "blob=$blob"; echo "made=$made"`);
	// Before the way out the check sees the value; after it, none of the refused objects, nothing git reads holds the value,
	// and no file of a refused pack is left.
	const wayOut = (carrier, oids, file, pack) => {
		const before = bash(goneScript(oids, pack));
		assert.deepEqual(ids(before.kept), [...oids].sort());
		assert.notEqual(before.readable, "0");
		if (pack) assert.ok(ids(before.left).includes(`${pack}.pack`));
		const out = bash(wayOutScript([carrier], file));
		assert.deepEqual(ids(out.before), [carrier]);
		assert.match(out["way-out"], /^0 \d+$/);
		const after = bash(goneScript(oids, pack));
		assert.deepEqual([after.kept, after.logged, after.readable, after.left], ["", "0", "0", pack ? "" : undefined]);
		assert.ok(Number(after.objects) > 0, "git reads the control's objects");
	};

	// Loose (turns 2 and 3).
	const loose = refuse("leak.txt");
	wayOut(loose.blob, [loose.blob, loose.made], "leak.txt");
	// Packed (turns 6 and 7): repacked while the index names the blob, then out of the index.
	const packed = refuse("pack.txt");
	bash("git repack -d -q && git rm -q --cached pack.txt");
	const [pack] = readdirSync(join(root, ".git", "objects", "pack")).filter((name) => name.endsWith(".idx"))
		.filter((name) => execFileSync("git", ["-C", root, "show-index"], { input: readFileSync(join(root, ".git", "objects", "pack", name)), encoding: "utf8" })
			.includes(` ${packed.blob} `)).map((name) => name.replace(/\.idx$/, ""));
	assert.match(pack ?? "", /^pack-[0-9a-f]{40}$/);
	wayOut(packed.blob, [packed.blob, packed.made], undefined, pack);
	// A delta pack (turns 8 and 9): no ref, index or log names its objects.
	const delta = bash(DELTA_PACK);
	wayOut(delta.target, [delta.base, delta.target], undefined, delta.pack);
	// Nothing left to clear (the folder cleared it first): the way out still succeeds.
	const again = bash(wayOutScript([delta.target]));
	assert.deepEqual([again.before, again["way-out"].split(" ")[0]], ["", "0"]);
	assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), "", "the worktree and index are the control's");
});
