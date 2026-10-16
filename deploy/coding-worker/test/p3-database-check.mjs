// P3's database half, checked on its own (no VM, no LXD): this script plays the real coding executor's control calls
// through p3-database.mjs's rpc (what PostgREST would carry), and the identity host and the command gateway through
// the module's turn calls. It shows Order 9's acceptance in the database: turn 2 of a session reads a command turn 1
// started.
//   node scripts/run-on-node.mjs --no-install --no-status -- node deploy/coding-worker/test/p3-database-check.mjs </dev/null
import { createHash } from "node:crypto";
import * as database from "./p3-database.mjs";

const { sha256, sleep } = database;
const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const RETRYABLE = new Set(["55P03", "40001", "40P01"]);
// CODING_SESSION_UID_BASE (packages/runner-orchestrator): a session's guest user is never a system or node uid.
const UID_BASE = 200000;
// lxdCodingMachinePlan's one key order: SQL hashes this text into the machine's instance digest.
const MACHINE_KEYS = [
	"schema", "machineId", "companyId", "environmentId", "memberUserId", "providerId", "providerPolicySha256", "project",
	"imageFingerprint", "bootstrapSha256", "storagePool", "network", "cpus", "memoryBytes", "rootDiskBytes",
];

const machineIdSha256 = sha256("p3-check-machine");
const nasPolicy = {
	schema: "qorpera.coding-nas-policy/v1", mountPoint: "/mnt/qorpera-nas", source: "127.0.0.1:/srv/nas",
	serverAddress: "127.0.0.1", rootPath: "/mnt/qorpera-nas/coding",
};
const vmPolicy = {
	bootstrapSha256: sha256("p3 coding machine bootstrap"), cpus: 2, imageFingerprint: sha256("p3 check image"),
	memoryBytes: 2 * 1024 ** 3, network: "qagent0", project: "default", providerId: "p3-coding",
	providerPolicySha256: sha256("p3 coding provider policy"), rootDiskBytes: 12 * 1024 ** 3, storagePool: "default",
};
const repository = { owner: "qorpera-p3", name: "proof", baseBranch: "main" };
const BASE_SHA = sha1("p3 check base");
const SLEEPER = "sleep 86400";

const started = Date.now();
const pass = (text) => console.log(`PASS ${text} (+${Math.round((Date.now() - started) / 1000)} s)`);
const note = (text) => console.error(`--- ${text}`);
function check(ok, text, detail) {
	if (!ok) throw new Error(`${text}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

/** The executor's control.call: one RPC on the service-role key (retried as the executor's own retries would). */
async function call(db, method, args) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await database.rpc(db, method, args);
		} catch (error) {
			if (attempt >= 6 || !RETRYABLE.has(error.sqlState)) throw error;
			await sleep(250 * attempt);
		}
	}
}

/** What the executor runs beside its turns: the claim's heartbeat (every 15 s, as CloudCodingExecutor) and the keeper
 * (every 5 s, qorpera_keep_coding_attachments with what it saw run on the machine). */
function background(db, ids) {
	const state = { claim: null, machine: null, running: [], kept: null, errors: [] };
	let chain = Promise.resolve();
	const tick = (heartbeat) => (chain = chain.then(() => once(heartbeat)));
	const once = async (heartbeat) => {
		try {
			if (heartbeat && state.claim) {
				const until = await call(db, "qorpera_heartbeat_coding_session", {
					p_worker_id: state.claim.workerId, p_lease_token: state.claim.leaseToken, p_lease_seconds: 60,
				});
				if (typeof until === "string") state.claim.leaseUntil = until;
			}
			if (state.machine) {
				state.kept = await call(db, "qorpera_keep_coding_attachments", {
					p_machine_id: state.machine.machineId, p_owner: ids.owner, p_binding_text: state.machine.text,
					p_machine_id_sha256: machineIdSha256,
					p_observation: {
						schema: "qorpera.coding-machine-observation/v1",
						busy: false,
						sessions: state.machine.workerIds.map((workerId) => ({ workerId, busy: false, running: state.running })),
					},
				});
				const released = state.kept?.sessions?.filter((item) => item.state !== "kept") ?? [];
				if (released.length) state.errors.push(`keeper: ${JSON.stringify(released)}`);
			}
		} catch (error) {
			state.errors.push(`${heartbeat ? "heartbeat/keep" : "keep"}: ${error.message}`);
		}
	};
	let count = 0;
	const timer = setInterval(() => void tick(++count % 3 === 0), 5000);
	const refresh = setInterval(() => void database.refreshNode(db, ids).catch((error) => state.errors.push(`refresh: ${error.message}`)), 20000);
	return { state, keepNow: () => tick(false), stop: () => (clearInterval(timer), clearInterval(refresh)) };
}

/** The executor's turn up to the model turn (CloudCodingExecutor.#turn and prepareWorkspace's SQL calls): claim,
 * describe, plan the member's machine, run authority (its guest uid), attach (keeping the generation the guest holds),
 * progress, begin the turn. */
async function executorTurn(db, ids, bg, { workerId, sequence, generation }) {
	let claim = null;
	for (let i = 0; i < 30 && !claim; i++) {
		claim = await call(db, "qorpera_claim_coding_session", { p_owner: ids.owner, p_lease_seconds: 60 });
		if (!claim) await sleep(2000);
	}
	check(claim?.workerId === workerId && claim.sequence === sequence, `the executor claims turn ${sequence}`, claim);
	check(claim.profileId === ids.profileId && claim.environmentId === ids.environmentId, "the claim's company is the seed's", {
		claim: [claim.profileId, claim.environmentId], ids: [ids.profileId, ids.environmentId],
	});
	bg.state.claim = claim;
	const args = { p_worker_id: claim.workerId, p_lease_token: claim.leaseToken };
	const turn = await call(db, "qorpera_describe_coding_turn", args);
	check(turn?.phase === "preparing", `turn ${sequence} is preparing`, turn);
	const plan = await call(db, "qorpera_plan_coding_machine", { ...args, p_machine_id_sha256: machineIdSha256 });
	check(plan?.schema === "qorpera.coding-machine-plan/v1" && plan.state === "planned", `turn ${sequence}'s machine is planned`, plan);
	const binding = Object.fromEntries(MACHINE_KEYS.map((key) => [key, plan.binding[key]]));
	check(binding.companyId === claim.profileId && binding.environmentId === claim.environmentId &&
		binding.memberUserId === claim.ownerUserId && binding.machineId === plan.machineId, "the plan is the member's machine", plan);
	const text = JSON.stringify(binding);
	const root = `${nasPolicy.rootPath}/workers/${binding.companyId}/${binding.environmentId}/${workerId}`;
	const storage = {
		workerId, companyId: binding.companyId, environmentId: binding.environmentId, machineIdSha256, writerGeneration: 1,
		schema: "qorpera.coding-storage/v1", volumeId: workerId, policy: nasPolicy, dataSource: `${root}/data`,
		custodySource: `${root}/guest-state`, dataTarget: "/workspace", custodyTarget: "/var/lib/qorpera-coding",
	};
	const admission = await call(db, "qorpera_authorize_coding_machine_run", {
		...args, p_binding_text: text, p_storage: storage, p_machine_id_sha256: machineIdSha256,
	});
	check(admission?.schema === "qorpera.coding-machine-admission/v1" && admission.intent === "run" &&
		admission.machineId === binding.machineId && admission.workerId === workerId &&
		admission.instanceSha256 === sha256(text), `turn ${sequence}'s run authority`, admission);
	const attached = await call(db, "qorpera_attach_coding_session", {
		...args, p_binding_text: text, p_storage: storage, p_machine_id_sha256: machineIdSha256, p_guest_generation: generation ?? null,
	});
	check(attached?.state === "attached" && attached.machineId === binding.machineId && attached.turn?.sequence === sequence &&
		attached.turn.turnId === turn.turnId && attached.turn.open === true, `turn ${sequence}'s session is attached`, attached);
	bg.state.machine = { machineId: binding.machineId, text, workerIds: [workerId] };
	await call(db, "qorpera_record_coding_progress", {
		...args, p_last_step: "Workspace ready", p_vm_allocation_id: binding.machineId, p_base_sha: BASE_SHA,
		p_events: [{ kind: "step", actor: "executor", body: { text: `Prepared the repository at ${BASE_SHA.slice(0, 7)}` } }],
	});
	const begun = await call(db, "qorpera_begin_coding_turn", { ...args, p_coding: { vmId: binding.machineId, turnId: turn.turnId } });
	check(begun?.workerId === workerId && begun.sequence === sequence, `turn ${sequence} begins`, begun);
	return { claim, args, turnId: turn.turnId, machineId: binding.machineId, text, admission, attached };
}

/** The executor's end of the turn: describe until the run's job ended, then publishing and the completion with the
 * draft pull request. */
async function executorEnd(db, executor, { sequence, headSha }) {
	let turn;
	for (let i = 0; i < 60; i++) {
		turn = await call(db, "qorpera_describe_coding_turn", executor.args);
		if (turn?.jobStatus ? ["completed", "failed", "cancelled"].includes(turn.jobStatus) : false) break;
		await sleep(1000);
	}
	check(turn?.submission?.kind === "finish" && turn.submission.headSha === headSha && turn.jobStatus === "completed",
		`turn ${sequence} ended with its finish submission`, turn);
	await call(db, "qorpera_record_coding_progress", { ...executor.args, p_phase: "publishing", p_last_step: "Publishing the draft pull request" });
	const view = await call(db, "qorpera_complete_coding_turn", {
		...executor.args, p_outcome: "succeeded", p_summary: turn.submission.summary, p_needs: null,
		p_pull_request: { url: `https://github.com/${repository.owner}/${repository.name}/pull/7`, number: 7, headSha },
		p_checks: null, p_artifacts: null, p_harness_session_ref: executor.claim.harnessSessionRef ?? null, p_files_changed: null, p_options: null,
	});
	check(view?.workerId === executor.claim.workerId, `turn ${sequence} completes`, view);
	return view;
}

/** The command gateway's checks (deploy/coding-worker/command-authority.ts): the native binding proven by its holder,
 * then authorize_coding_command for the action. */
async function gateway(db, turn, action, commandId, inputSha256) {
	const proven = await call(db, "qorpera_native_binding_proven", { p_binding: turn.binding, p_holder: turn.holder });
	check(proven === true, `turn ${turn.scope.turn}'s binding is proven by its holder`, proven);
	return call(db, "qorpera_authorize_coding_command", {
		p_binding: turn.binding, p_scope: turn.scope, p_action: action, p_command_id: commandId, p_input_sha256: inputSha256 ?? null,
	});
}

const db = await database.openDatabase();
let ids = null;
let bg = null;
let failed = false;
try {
	ids = await database.seed(db, { vmPolicy, nasPolicy, machineIdSha256, repository });
	check(typeof ids.profileId === "string" && typeof ids.environmentId === "string", "ids carry profileId and environmentId", ids);
	pass(`seeded: owner ${ids.owner}, company ${ids.profileId}, environment ${ids.environmentId}`);
	bg = background(db, ids);

	// ---- turn 1: the agent dispatches a coding session; the turn starts a command that keeps running ----
	const { workerId } = await database.dispatchCodingTask(db, ids, { instructions: "P3 check: start a command that keeps printing." });
	pass(`dispatched coding session ${workerId}`);
	const executor1 = await executorTurn(db, ids, bg, { workerId, sequence: 1, generation: null });
	check(Number.isSafeInteger(executor1.admission.guestUid) && executor1.admission.guestUid >= UID_BASE,
		"the session's guest uid is at least 200000", executor1.admission);
	pass(`turn 1 attached on machine ${executor1.machineId}; guestUid ${executor1.admission.guestUid} >= ${UID_BASE}`);
	const turn1 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 1, timeoutMs: 5 * 60000 });
	check(typeof turn1.holder === "string" && turn1.scope?.turn === 1 && turn1.scope.vmId === executor1.machineId &&
		turn1.scope.requestId === executor1.turnId && turn1.scope.workerId === workerId, "turn 1's identity scope", turn1.scope);
	pass(`turn 1's identity turn: run ${turn1.runId}, scope ${JSON.stringify(turn1.scope)}`);

	const ticking = await database.beginCommand(db, turn1, { operationKey: "p3-ticking", command: SLEEPER, timeoutMs: null });
	check(ticking.input.commandId === ticking.commandId && ticking.input.timeoutMs === null && ticking.input.command === SLEEPER,
		"the start input", ticking.input);
	const startTicking = await gateway(db, turn1, "start", ticking.commandId, ticking.input.inputSha256);
	check(startTicking?.operationKey === "p3-ticking" && startTicking.inputSha256 === ticking.input.inputSha256,
		"turn 1 may start its command", startTicking);
	bg.state.running = [{ commandId: ticking.commandId, turn: 1, command: SLEEPER }];
	pass(`turn 1 started ${ticking.commandId} (${SLEEPER})`);

	const head1 = sha1("p3 check head 1");
	const edit = await database.beginCommand(db, turn1, { operationKey: "p3-edit", command: "git commit", timeoutMs: 120000 });
	const startEdit = await gateway(db, turn1, "start", edit.commandId, edit.input.inputSha256);
	check(startEdit?.operationKey === "p3-edit" && edit.input.timeoutMs === 120000, "turn 1 may start a second command", startEdit);
	await edit.complete({ commandId: edit.commandId, state: "exited", exitCode: 0, output: `${BASE_SHA}\n${head1}\n` });
	pass(`turn 1 ran a second command ${edit.commandId} (a commit, head ${head1.slice(0, 7)})`);

	await bg.keepNow();
	const seen = await database.turnContext(db, turn1);
	note(`turn 1's own context after the keeper's look: ${JSON.stringify(seen.commands)}`);
	const finished1 = await database.finishTurn(db, turn1, { operationKey: "p3-turn-1", summary: "Started a command that keeps printing; committed an edit.", headSha: head1 });
	pass(`turn 1 finished with head ${head1.slice(0, 7)} (not the base): ${JSON.stringify(finished1).slice(0, 200)}`);
	await executorEnd(db, executor1, { sequence: 1, headSha: head1 });
	bg.state.claim = null;
	pass("turn 1 completed by the executor; the session stays attached for the keeper");

	// ---- turn 2: the owner follows up; the next turn reads the command turn 1 started ----
	await database.followUp(db, ids, { workerId, text: "P3 check: read the command you started." });
	pass("the owner followed up");
	const executor2 = await executorTurn(db, ids, bg, { workerId, sequence: 2, generation: sha256(executor1.attached.attachmentToken) });
	check(executor2.attached.attachmentToken === executor1.attached.attachmentToken && executor2.machineId === executor1.machineId,
		"turn 2 keeps the attachment's generation", { first: executor1.attached, second: executor2.attached });
	if (executor2.admission.guestUid !== executor1.admission.guestUid)
		note(`turn 2's guest uid ${executor2.admission.guestUid} differs from turn 1's ${executor1.admission.guestUid}`);
	check(executor2.admission.guestUid >= UID_BASE, "turn 2's guest uid is at least 200000", executor2.admission);
	pass(`turn 2 attached under the same generation; guestUid ${executor2.admission.guestUid}`);
	await bg.keepNow();
	const turn2 = await database.awaitIdentityTurn(db, ids, { workerId, sequence: 2, timeoutMs: 5 * 60000 });
	check(turn2.scope?.turn === 2 && turn2.scope.requestId === executor2.turnId, "turn 2's identity scope", turn2.scope);
	const listed = (context) => [...(context.commands?.running ?? []), ...(context.commands?.stopped ?? [])]
		.some((command) => command.commandId === ticking.commandId);
	note(`turn 2's context as its run began ${listed(turn2.context) ? "lists" : "does NOT list"} turn 1's command: ${JSON.stringify(turn2.context.commands)}`);
	await bg.keepNow();
	const context2 = await database.turnContext(db, turn2);
	check(listed(context2), "turn 2's context lists turn 1's command", context2.commands);
	pass(`turn 2's context lists turn 1's command: ${JSON.stringify(context2.commands)}`);

	const read = await gateway(db, turn2, "read", ticking.commandId, null);
	check(read?.operationKey === "p3-ticking" && read.inputSha256 === ticking.input.inputSha256, "turn 2 may read turn 1's command", read);
	pass(`turn 2's authorize_coding_command 'read' of ${ticking.commandId} is allowed (operation ${read.operationKey})`);
	let startRefused = null;
	try {
		await gateway(db, turn2, "start", ticking.commandId, ticking.input.inputSha256);
	} catch (error) {
		startRefused = error;
	}
	check(startRefused?.sqlState === "42501", "turn 2 may not start turn 1's command again", startRefused?.message ?? "allowed");
	pass("turn 2 may not start turn 1's command (42501)");
	const cancel = await gateway(db, turn2, "cancel", ticking.commandId, null);
	check(cancel?.operationKey === "p3-ticking", "turn 2 may cancel turn 1's command", cancel);
	bg.state.running = [];
	await bg.keepNow();
	pass("turn 2's authorize_coding_command 'cancel' of turn 1's command is allowed");

	const head2 = sha1("p3 check head 2");
	await database.finishTurn(db, turn2, { operationKey: "p3-turn-2", summary: "Read and stopped the command from turn 1.", headSha: head2 });
	await executorEnd(db, executor2, { sequence: 2, headSha: head2 });
	bg.state.claim = null;
	pass("turn 2 finished and completed");

	// ---- the parent reads the session's reports ----
	const settled = await database.settleParent(db, ids, { workerId });
	console.log(`settleParent: ${JSON.stringify(settled)}`);
	check(settled.continuation === "ready", "the parent's continuation is ready", settled);
	check(settled.checkin?.workerConditions && Object.values(settled.checkin.workerConditions).every(Boolean),
		"checkin_due's worker conditions hold", settled.checkin);
	pass(`settleParent: continuation ${settled.continuation} after ${settled.rounds} round(s); worker ${JSON.stringify(settled.worker)}`);

	const described = await database.describe(db, ids);
	const sections = Object.entries(described).filter(([key]) => key !== "ids");
	const broken = sections.filter(([, value]) => value && !Array.isArray(value) && value.error);
	check(broken.length === 0, "describe reads every section", Object.fromEntries(broken));
	const plain = await database.describe(db);
	check(Array.isArray(plain.sessions) && plain.sessions.length === 1, "describe(db) without ids", plain.sessions);
	pass(`describe: ${sections.map(([key, value]) => `${key} ${Array.isArray(value) ? value.length : "?"}`).join(", ")}`);
	if (bg.state.errors.length) note(`background notes:\n${bg.state.errors.join("\n")}`);
	console.log("ALL PASSED");
} catch (error) {
	failed = true;
	console.log(`FAIL ${error.message}`);
	if (error.sqlState) console.log(`  sqlState ${error.sqlState}; detail ${error.detail ?? "-"}`);
	if (error.context) console.log(`  psql: ${error.context}`);
	if (error.stack) console.log(error.stack.split("\n").slice(1, 6).join("\n"));
	if (bg?.state.errors.length) console.log(`background notes:\n${bg.state.errors.slice(-20).join("\n")}`);
	try {
		console.log(`--- the database\n${JSON.stringify(await database.describe(db, ids))}`);
	} catch (describeError) {
		console.log(`describe failed too: ${describeError.message}`);
	}
} finally {
	bg?.stop();
	await db.close();
}
process.exit(failed ? 1 : 0);
