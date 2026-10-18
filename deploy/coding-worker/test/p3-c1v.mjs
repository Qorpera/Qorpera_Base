// C1-V on P3's test database (p3-driver.mjs runs it after phase B's last turn when P3_C1V=1): C1's idle rule on the VM,
// as the C8 acceptance brief has it. A machine is busy while any session on it is busy, and only that session is: an
// idle session's machine stays awake beside a busy one, and sleeps once that one is archived.
//   1. the proof's session S leaves `sleep 86400` running and ends its turn; a second session S2 of the same member, on
//      the same machine, commits an edit, starts a loop that keeps a core busy, and ends its turn;
//   2. the machine's idle clocks move back: its last use 11 minutes, and its last busy check-in 570 s, so the next
//      housekeeping (every 30 s) cannot find it due before the next keeps (every 10 s) have looked (the brief's
//      quietElevenMinutes would race them); then the executor's list is read for 75 s;
//   3. the keeps moved the machine's busy clock and S2's, not S's; S was not put to sleep, its attachment was renewed
//      with only the sleeper running, the list never had the machine due, and the VM runs;
//   4. a quiet day for S (its last change and busy check-in 25 hours back), then the check-ins drain: the agent is asked
//      about it, "with 1 command still running on its machine";
//   5. S2 is archived, which names and stops its loop and leaves S attached; once the machine is quiet with both its idle
//      clocks 11 minutes back, the next housekeeping pass puts it to sleep, and S's SLEEP detach names the sleeper.
// Each step's judgment is a pure function of what the step read (p3-c1v.test.mjs breaks each record, and each break
// must fail it).
import { randomBytes } from "node:crypto";
import * as c2 from "./p3-c2.mjs";
import * as database from "./p3-database.mjs";
import * as order9 from "./p3-order9.mjs";

const { quote, sleep } = database;
const LOOP = "timeout 30m sh -c 'while :; do :; done'";
// The loop's processes on the machine, as pgrep -f finds them.
const LOOP_SEEN = "while :; do :; done";
// S2's edit and commit in its own worktree, and the new head.
const EDIT = "printf 'P3 C1-V\\n' >P3-C1V.md && git add P3-C1V.md && " +
	"git -c user.name='P3 proof' -c user.email=p3@qorpera.invalid commit -q -m 'P3 C1-V: an edit' && git rev-parse HEAD";
const QUESTION = ", with 1 command still running on its machine";
// One housekeeping pass: a pass under way when the clocks move back may have read the list already (with nothing to do
// it ends in seconds), then the loop's 30 s wait, then the pass that sleeps the machine within its budget
// (CODING_VM_STOP_BUDGET_MS × 2 + CODING_SESSION_QUIESCE_MS × 2, 100 s) and records the detach.
const SLEEP_WITHIN_S = 160;

/** One JSON value of `select`, as postgres. */
async function one(db, select) {
	const marker = `@@c1v${randomBytes(6).toString("hex")}@@`;
	const [value] = await db.marked(`select ${quote(marker)} || coalesce((${select})::text, 'null');`, marker);
	return value ?? null;
}

/** Once a keep 40 s after a look began (past the idle rule's 30 s) has left the attached session's own busy clock alone:
 * the turn just ended would still count it busy. Looks again until `timeoutMs`; answers what the quiet keep saw. */
export async function awaitSessionQuiet(db, workerId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	for (;;) {
		const since = `${quote(await one(db, "select to_jsonb(clock_timestamp())"))}::timestamptz`;
		let seen = null;
		while (!seen) {
			if (Date.now() > deadline)
				throw new Error(`the session was not quiet for 40 s within ${Math.round(timeoutMs / 1000)} s: ${JSON.stringify(last)}`);
			await sleep(2000);
			seen = await one(db, `select jsonb_build_object('since', ${since}, 'observedAt', s.observed_at, 'running', s.running_commands,
					'busyAt', s.busy_at, 'busy', coalesce(s.busy_at > ${since} + interval '30 seconds', false))
				from public.qorpera_coding_sessions s
				where s.worker_id = ${quote(workerId)}::uuid and s.attachment_until > clock_timestamp()
					and s.observed_at > ${since} + interval '40 seconds'`);
		}
		if (!seen.busy) return seen;
		last = seen;
	}
}

/** The machine last used 11 minutes ago and last busy 570 s ago: due to sleep in 30 s unless a keep finds it busy.
 * Answers the database's clock then. */
export async function busyWindow(db, machine) {
	const marker = `@@c1v${randomBytes(6).toString("hex")}@@`;
	const [since] = await db.marked(`with t as (select clock_timestamp() as at),
		backdated as (update public.qorpera_coding_machines m set last_used_at = t.at - interval '11 minutes',
			busy_at = t.at - interval '570 seconds' from t where m.id = ${quote(machine.machineId)}::uuid returning t.at)
		select ${quote(marker)} || to_jsonb(at)::text from backdated;`, marker);
	if (!since) throw new Error(`the machine ${machine.machineId} is not in the database`);
	return since;
}

/** The machine's two idle clocks, in seconds after `since`. */
export function machineSince(db, machine, since) {
	return one(db, `select jsonb_build_object('busyAfter', extract(epoch from m.busy_at - ${quote(since)}::timestamptz),
			'lastUsedAfter', extract(epoch from m.last_used_at - ${quote(since)}::timestamptz))
		from public.qorpera_coding_machines m where m.id = ${quote(machine.machineId)}::uuid`);
}

/** The session's attachment: its machine, its lease's end, last keep observation and last busy check-in in seconds after
 * `since`, and the commands SQL last saw running. */
export function sessionSince(db, workerId, since) {
	const at = `${quote(since)}::timestamptz`;
	return one(db, `select jsonb_build_object('machineId', s.attached_machine_id,
			'leaseAfter', extract(epoch from s.attachment_until - ${at}), 'observedAfter', extract(epoch from s.observed_at - ${at}),
			'busyAfter', extract(epoch from s.busy_at - ${at}),
			'running', coalesce((select jsonb_agg(c.value ->> 'commandId' order by c.ord)
				from jsonb_array_elements(s.running_commands) with ordinality c(value, ord)), '[]'::jsonb))
		from public.qorpera_coding_sessions s where s.worker_id = ${quote(workerId)}::uuid`);
}

/** The list's entry as the judgment reads it (not its tokens). */
function shown(entry) {
	return entry && { live: entry.live, reserved: entry.reserved, superseded: entry.superseded, sleepDue: entry.sleepDue,
		attached: (entry.attached ?? []).map((attached) => attached.workerId) };
}

/** A quiet day for the session with a command still running: its last change and its last busy check-in 25 hours back
 * (one value), then the folder core's check-ins drain as order9.quietDay runs it. Answers the key the question of this
 * quiet day has (Order 9's question for an earlier quiet day has another), the drain's answers, and the session's newest
 * coding-quiet wake. */
export async function quietDayBusy(db, workerId) {
	const worker = quote(workerId);
	const marker = `@@c1v${randomBytes(6).toString("hex")}@@`;
	const [expected] = await db.marked(`with t as (select clock_timestamp() - interval '25 hours' as at),
		quieted as (update public.qorpera_coding_sessions s set updated_at = t.at, busy_at = t.at, quiet_asked_days = null,
			quiet_asked_for = null from t where s.worker_id = ${worker}::uuid returning s.updated_at, s.busy_at)
		select ${quote(marker)} || to_jsonb('coding-quiet:' || ${worker} || ':'
			|| (extract(epoch from greatest(updated_at, coalesce(busy_at, updated_at))) * 1000)::bigint::text || ':1')::text from quieted;`, marker);
	const due = await db.rpc("qorpera_folder_coding_checkins_due", { p_after_environment: null, p_limit: 100 });
	const steps = [];
	for (const { environment_id } of due.items)
		steps.push(await db.rpc("qorpera_folder_coding_checkins_company", { p_environment_id: environment_id, p_limit: 8 }));
	const wake = await one(db, `select jsonb_build_object('occurrenceKey', o.occurrence_key, 'status', o.status,
			'summary', o.payload #>> '{completions,0,summary}')
		from public.qorpera_wake_occurrences o
		where o.source_id = ${worker}::uuid and o.occurrence_key like 'coding-quiet:' || ${worker} || ':%'
		order by o.created_at desc limit 1`);
	return { expected: expected ?? null, due, steps, wake };
}

/** The session's first SLEEP event after the event `afterId`, once it is off its machine: the event, its time in seconds
 * after `since`, and the machine's node demand. */
export function sleptSince(db, workerId, machine, afterId, since) {
	return one(db, `select jsonb_build_object('event', to_jsonb(e) - 'worker_id',
			'after', extract(epoch from e.created_at - ${quote(since)}::timestamptz),
			'suspendedAt', (select d.suspended_at from public.qorpera_runtime_node_demands d
				where d.allocation_id = ${quote(machine.machineId)}::uuid and d.released_at is null))
		from public.qorpera_coding_session_events e join public.qorpera_coding_sessions s on s.worker_id = e.worker_id
		where e.worker_id = ${quote(workerId)}::uuid and e.id > ${quote(String(afterId ?? 0))}::bigint
			and e.body ->> 'reason' = 'SLEEP' and s.attached_machine_id is null
		order by e.id limit 1`);
}

const names = (event, commandId) => (event?.body?.stopped ?? []).some((stopped) => stopped?.commandId === commandId);

/** Steps 1 to 3: S2 shares S's machine and keeps it busy, and the keeps count the machine and S2 busy, never S. */
export function judgeBusy(record) {
	const { machineId, workerId, s2Id, sleeper, loop, busy } = record;
	const failures = [];
	if (record.s2MachineId !== machineId) failures.push(`S2 does not share S's machine: ${JSON.stringify({ machineId, s2: record.s2MachineId })}`);
	if (!(busy?.machine?.busyAfter > 0)) failures.push(`the machine's busy clock did not move after the backdate: ${JSON.stringify(busy?.machine)}`);
	const s2 = busy?.s2;
	if (s2?.machineId !== machineId || !(s2.busyAfter > 0) || !s2.running?.includes(loop))
		failures.push(`S2's loop did not keep S2 busy on the machine: ${JSON.stringify(s2)}`);
	if (busy?.sleepEvents?.length !== 0) failures.push(`S was put to sleep in the busy window: ${JSON.stringify(busy?.sleepEvents)}`);
	const s = busy?.s;
	if (s?.machineId !== machineId || !(s.leaseAfter > 60) || !(s.observedAfter > 0))
		failures.push(`no keep after the backdate renewed S's attachment: ${JSON.stringify(s)}`);
	if (JSON.stringify(s?.running) !== JSON.stringify([sleeper])) failures.push(`S's running commands are not its sleeper alone: ${JSON.stringify(s?.running)}`);
	if (s?.busyAfter !== null && !(s?.busyAfter <= 0)) failures.push(`S's own busy clock moved in the busy window: ${JSON.stringify(s)}`);
	const entries = busy?.entries ?? [];
	if (!entries.length || entries.some((entry) => entry?.live !== false || entry.reserved !== true || entry.superseded !== false ||
		entry.sleepDue !== false || !entry.attached?.includes(workerId) || !entry.attached.includes(s2Id)))
		failures.push(`the executor's list did not show the machine reserved, with both sessions, no turn and not due to sleep: ${JSON.stringify(entries)}`);
	if (busy?.sleeps?.length !== 0) failures.push(`the executor's housekeeping tried to sleep the machine in the busy window: ${JSON.stringify(busy?.sleeps)}`);
	if (!(busy?.keeps >= 2) || !(busy.lists >= 4))
		failures.push(`the executor looked too seldom in 75 s: ${busy?.keeps} keeps, ${busy?.lists} list reads`);
	if (busy?.vm !== "RUNNING") failures.push(`the VM is ${busy?.vm} after the busy window, not RUNNING`);
	return failures;
}

/** Step 4: the question of this quiet day (its key from the backdate's mark, one day) counts the sleeper. */
export function judgeAsked(record) {
	const { expected, wake } = record.asked ?? {};
	if (!expected || wake?.occurrenceKey !== expected) return [`no question for S's quiet day ${expected}: the newest is ${JSON.stringify(wake)}`];
	if (!(wake.summary ?? "").includes(QUESTION)) return [`the quiet day's question does not say S has 1 command running: ${JSON.stringify(wake.summary)}`];
	return [];
}

/** Step 5's archive: S2's ARCHIVED event names its loop, which stops; S's sleeper runs on, and S stays attached. */
export function judgeArchived(record) {
	const { machineId, loop, archived } = record;
	const failures = [];
	if (!names(archived?.event, loop)) failures.push(`S2's ARCHIVED event does not name its loop: ${JSON.stringify(archived?.event)}`);
	if (archived?.left !== null) failures.push(`S2's loop still runs after its archive: ${archived?.left}`);
	if (!archived?.sleeperLeft) failures.push("S's sleeper does not run after S2's archive");
	if (archived?.s?.machineId !== machineId || archived.s.attached !== true) failures.push(`S2's archive detached S: ${JSON.stringify(archived?.s)}`);
	return failures;
}

/** Step 5's sleep: within one housekeeping pass of the backdate, S's SLEEP detach names the sleeper, and the VM stops. */
export function judgeSlept(record) {
	const { sleeper, slept } = record;
	const failures = [];
	if (!slept?.event) failures.push("no SLEEP detach of S after S2's archive");
	else {
		if (!names(slept.event, sleeper)) failures.push(`S's SLEEP does not name its sleeper: ${JSON.stringify(slept.event)}`);
		if (!(slept.after >= 0 && slept.after <= SLEEP_WITHIN_S))
			failures.push(`S's SLEEP came ${slept.after} s after the backdate, not within one housekeeping pass (${SLEEP_WITHIN_S} s)`);
	}
	if (slept?.vm !== "STOPPED" || !slept.suspendedAt) failures.push(`the machine is not asleep: ${slept?.vm}, node demand suspended at ${slept?.suspendedAt}`);
	return failures;
}

/** Every step's judgment of a whole run's record. */
export function judgeC1V(record) {
	return { failures: [...judgeBusy(record), ...judgeAsked(record), ...judgeArchived(record), ...judgeSlept(record)] };
}

/** The five steps, with the driver's session S after its last turn. */
export async function run(ctx) {
	const { db, ids, executor, calls, workerId, machine, head, machineIdSha256, gatewayFor, startSleeper, runToEnd, guestState,
		guestProcesses, pass, note, fail, elapsed } = ctx;
	const failing = (step, failures) => failures.length && fail(`C1-V step ${step}: ${failures.join("; ")}`);

	// --- 1. S leaves a command that only waits; S2, beside it, a loop that keeps a core busy ---------------------------
	const sequence = await one(db, `select (to_jsonb(w) ->> 'sequence')::integer + 1 from public.qorpera_runtime_workers w
		where w.id = ${quote(workerId)}::uuid`);
	await database.followUp(db, ids, { workerId, text: "P3 C1-V: leave a command that only waits, and end the turn." });
	const turnS = await database.awaitIdentityTurn(db, ids, { workerId, sequence, timeoutMs: 20 * 60000 });
	if ((await order9.machineOf(db, workerId)).machineId !== machine.machineId) fail(`C1-V step 1: S's turn ${sequence} runs on another machine`);
	const gatewayS = gatewayFor(turnS);
	// What S's earlier turns left running would be counted in the quiet day's question.
	for (const left of turnS.context.commands.running ?? []) await gatewayS.cancel(turnS.scope, left.commandId, AbortSignal.timeout(60000));
	const sleeper = await startSleeper(turnS, gatewayS, "p3-c1v-sleeper");
	await database.finishTurn(db, turnS, { operationKey: "p3-turn-c1v", summary: "Left a command that only waits.", headSha: head });
	await executor.turnSettled();
	const { workerId: s2Id } = await database.dispatchCodingTask(db, ids, {
		instructions: "P3 C1-V: keep a core busy beside the first session.", title: "P3 C1-V busy session",
	});
	const turnS2 = await database.awaitIdentityTurn(db, ids, { workerId: s2Id, sequence: 1, timeoutMs: 20 * 60000 });
	const record = { machineId: machine.machineId, workerId, s2Id, sleeper: sleeper.commandId, loop: null,
		s2MachineId: (await order9.machineOf(db, s2Id)).machineId };
	if (record.s2MachineId !== machine.machineId) fail(`C1-V step 1: S2 runs on ${record.s2MachineId}, not on S's machine ${machine.machineId}`);
	const gatewayS2 = gatewayFor(turnS2);
	const edited = await runToEnd(turnS2, gatewayS2, "p3-c1v-edit", EDIT);
	const committed = edited.output.trim().split("\n").at(-1);
	if (edited.state !== "succeeded" || !/^[0-9a-f]{40}$/.test(committed ?? "")) fail(`C1-V step 1: S2's edit and commit: ${JSON.stringify(edited)}`);
	const loop = await database.beginCommand(db, turnS2, { operationKey: "p3-c1v-loop", command: LOOP, timeoutMs: null });
	const looping = await gatewayS2.start(turnS2.scope, loop.input, AbortSignal.timeout(60000));
	await loop.complete(looping);
	if (looping.state !== "running") fail(`C1-V step 1: S2's loop is ${looping.state}, not running: ${JSON.stringify(looping)}`);
	record.loop = loop.commandId;
	await database.finishTurn(db, turnS2, { operationKey: "p3-turn-c1v-busy", summary: "Left a loop that keeps a core busy.", headSha: committed });
	await executor.turnSettled();
	await order9.awaitRunning(db, workerId, sleeper.commandId, 60000);
	await order9.awaitRunning(db, s2Id, loop.commandId, 60000);
	const quietS = await awaitSessionQuiet(db, workerId, 5 * 60000);
	pass(`C1-V step 1: S's turn ${sequence} left \`${sleeper.input.command}\` running, and S2 (${s2Id}) on the same machine ` +
		`committed ${committed} and left \`${LOOP}\` running; a keep 40 s on finds S quiet: ${JSON.stringify(quietS)} (${elapsed()})`);

	// --- 2. Both idle clocks back, then the list as the keeper and housekeeping read it, every 15 s for 75 s -------------
	const before = await c2.standing(db, workerId, machine);
	const lines = executor.machineLines.length;
	const lists = calls.rpc.get("qorpera_list_coding_machines") ?? 0;
	const keeps = calls.rpc.get("qorpera_keep_coding_attachments") ?? 0;
	const since = await busyWindow(db, machine);
	const entries = [];
	for (let waited = 0; waited <= 75000; waited += 15000) {
		if (waited) await sleep(15000);
		entries.push(shown(await c2.listed(db, ids.owner, machineIdSha256, machine)));
	}

	// --- 3. The machine and S2 busy, S not: S attached with its sleeper, and the VM running -----------------------------
	record.busy = {
		since,
		machine: await machineSince(db, machine, since),
		s: await sessionSince(db, workerId, since),
		s2: await sessionSince(db, s2Id, since),
		sleepEvents: (await c2.eventsAfter(db, workerId, before.lastEventId)).filter((event) => event.body?.reason === "SLEEP"),
		entries,
		sleeps: executor.machineLines.slice(lines).filter((line) => line.machineId === machine.machineId && line.step === "sleep"),
		keeps: (calls.rpc.get("qorpera_keep_coding_attachments") ?? 0) - keeps,
		lists: (calls.rpc.get("qorpera_list_coding_machines") ?? 0) - lists,
		vm: guestState(machine),
	};
	failing(3, judgeBusy(record));
	pass(`C1-V steps 2 and 3: 75 s after the machine's idle clocks moved back (${since}), ${record.busy.keeps} keeps moved its busy ` +
		`clock and S2's, not S's: ${JSON.stringify(record.busy)}; S stays attached with only its sleeper, nothing slept, and the ` +
		`VM is RUNNING (${elapsed()})`);

	// --- 4. A quiet day for S: the agent is asked, with the sleeper counted ---------------------------------------------
	const settled = await database.settleParent(db, ids, { workerId });
	note(`C1-V: S's parent, as the runner leaves it once the agent read the reports: ${JSON.stringify({ continuation: settled.continuation, checkin: settled.checkin })}`);
	const asked = await quietDayBusy(db, workerId);
	note(`C1-V: the check-ins drain: ${JSON.stringify(asked.due)} ${JSON.stringify(asked.steps)}`);
	record.asked = { expected: asked.expected, wake: asked.wake };
	failing(4, judgeAsked(record));
	pass(`C1-V step 4: a quiet day later the agent is asked about S: ${asked.wake.occurrenceKey} (${asked.wake.status}): ` +
		`${JSON.stringify(asked.wake.summary)} (${elapsed()})`);

	// --- 5. S2 archived; the quiet machine sleeps within one housekeeping pass ------------------------------------------
	if ((await order9.archive(db, s2Id)) !== true) fail("C1-V step 5: S2's archive archived nothing");
	const archived = await order9.awaitDetached(db, s2Id, machine, "ARCHIVED", 2 * 60000);
	const attached = await c2.standing(db, workerId, machine);
	record.archived = {
		event: archived.event,
		left: guestProcesses(machine, LOOP_SEEN),
		sleeperLeft: guestProcesses(machine, sleeper.input.command),
		s: { machineId: attached.attachedMachineId, attached: attached.attached },
	};
	failing(5, judgeArchived(record));
	pass(`C1-V step 5: archiving S2 stops its loop: ${JSON.stringify(archived.event.body)}; S stays attached with its sleeper ` +
		`(${record.archived.sleeperLeft}) (${elapsed()})`);
	const quiet = await c2.awaitQuiet(db, workerId, machine, 5 * 60000);
	note(`C1-V: with S2's loop gone the machine is quiet: ${JSON.stringify(quiet)}`);
	const mark = (await c2.standing(db, workerId, machine)).lastEventId;
	await c2.quietElevenMinutes(db, machine);
	const since2 = await one(db, "select to_jsonb(clock_timestamp())");
	let slept = null;
	for (const deadline = Date.now() + 5 * 60000; !slept && Date.now() < deadline; slept = await sleptSince(db, workerId, machine, mark, since2))
		await sleep(2000);
	record.slept = { since: since2, event: slept?.event ?? null, after: slept?.after ?? null, suspendedAt: slept?.suspendedAt ?? null, vm: guestState(machine) };
	failing(5, judgeSlept(record));
	note(`C1-V record: ${JSON.stringify(record)}`);
	failing("all", judgeC1V(record).failures);
	pass(`C1-V PASSED: with both idle clocks 11 minutes back (${since2}), the machine sleeps ${record.slept.after} s later, and S's ` +
		`SLEEP names its sleeper: ${JSON.stringify(record.slept.event.body)} (${elapsed()})`);
}
