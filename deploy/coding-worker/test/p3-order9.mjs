// Order 9's later steps on P3's test database (p3-driver.mjs runs them after turn 2): each wait the contract names cut
// short in the database, and what each step left there to read.
//   the machine sleeps after 10 idle minutes: once a keep has found it idle with only a waiting command running, its
//     last use moved back 11 minutes, so the executor's next housekeeping (every 30 s) finds it due;
//   the agent is asked about archiving after a quiet day: once a keep has found the session idle the same way, its last
//     change moved back 25 hours, then the folder core's check-ins drain runs as the listener runs it (as service_role,
//     one company per call);
//   archiving: what manage_worker's archive does after its run's checks (qorpera_archive_coding_worker, by the agent);
//     the executor's keeper then releases the session.
import { randomBytes } from "node:crypto";
import { quote } from "./p3-database.mjs";

/** One JSON value of `select`, as postgres. */
async function one(db, select) {
	const marker = `@@o9${randomBytes(6).toString("hex")}@@`;
	const [value] = await db.marked(`select ${quote(marker)} || coalesce((${select})::text, 'null');`, marker);
	return value ?? null;
}

async function until(read, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`${what} did not happen within ${Math.round(timeoutMs / 1000)} s`);
		await new Promise((settle) => setTimeout(settle, 2000));
	}
}

/** The member's coding machine the session last ran on: its id, and its LXD project and instance in the node. */
export async function machineOf(db, workerId) {
	const machine = await one(db, `select jsonb_build_object('machineId', m.id, 'project', coalesce(m.binding ->> 'project', 'default'))
		from public.qorpera_coding_sessions s join public.qorpera_coding_machines m on m.id = coalesce(s.attached_machine_id, s.vm_allocation_id)
		where s.worker_id = ${quote(workerId)}::uuid`);
	if (!machine) throw new Error(`the session ${workerId} has no machine`);
	return { ...machine, name: `qorpera-coding-machine-${machine.machineId.replaceAll("-", "")}` };
}

/** Once the executor's keep (every few seconds) has seen `commandId` running in the attached session: the commands a
 * detach names when its own look finds none, and those the quiet-day question counts. */
export function awaitRunning(db, workerId, commandId, timeoutMs) {
	return until(() => one(db, `select true from public.qorpera_coding_sessions s
		where s.worker_id = ${quote(workerId)}::uuid and s.attachment_until > clock_timestamp()
			and s.running_commands @> jsonb_build_array(jsonb_build_object('commandId', ${quote(commandId)}))`),
		timeoutMs, `the executor seeing ${commandId} run`);
}

/** Once a turn has ended and only `sleep 86400` runs, which only waits: a keep 40 s on (past the idle rule's 30 s) has
 * not marked the session or its machine busy. Each keep (every 10 s) that does moves the idle clock to now, so no idle
 * minute passes, and a wait cut short in the database would only win a race with the next keep (runs 7 and 10 won it,
 * run 11 did not). Answers what that keep saw. */
export async function awaitIdle(db, workerId, machine) {
	const since = `${quote(await one(db, "select to_jsonb(clock_timestamp())"))}::timestamptz`;
	const seen = await until(() => one(db, `select jsonb_build_object('since', ${since}, 'observedAt', s.observed_at,
			'running', s.running_commands, 'sessionBusyAt', s.busy_at, 'machineBusyAt', m.busy_at,
			'busy', coalesce(s.busy_at > ${since} + interval '30 seconds', false) or coalesce(m.busy_at > ${since} + interval '30 seconds', false))
		from public.qorpera_coding_sessions s join public.qorpera_coding_machines m on m.id = s.attached_machine_id
		where s.worker_id = ${quote(workerId)}::uuid and m.id = ${quote(machine.machineId)}::uuid
			and s.observed_at > ${since} + interval '40 seconds'`), 120000, "a keep 40 s after the turn");
	if (seen.busy)
		throw new Error(`a command that only waits keeps the session busy, so its machine never sleeps and it is never quiet: ` +
			`a keep 40 s after the turn marked it busy (the folder model counts a session busy while any command runs, and ` +
			`applies no idle rule): ${JSON.stringify(seen)}`);
	return seen;
}

/** The 10 idle minutes: the machine last used, and last busy, 11 minutes ago. */
export async function idleTenMinutes(db, machine) {
	await db.psql(`update public.qorpera_coding_machines set last_used_at = clock_timestamp() - interval '11 minutes', busy_at = null
		where id = ${quote(machine.machineId)}::uuid;`);
}

/** The session's event of the detach for `reason` (SLEEP, ARCHIVED: what qorpera_record_coding_session_detached
 * writes), once the session is off its machine; with the machine's node demand. */
export function awaitDetached(db, workerId, machine, reason, timeoutMs) {
	return until(() => one(db, `select jsonb_build_object('event', to_jsonb(e) - 'worker_id',
			'suspendedAt', (select d.suspended_at from public.qorpera_runtime_node_demands d
				where d.allocation_id = ${quote(machine.machineId)}::uuid and d.released_at is null))
		from public.qorpera_coding_session_events e join public.qorpera_coding_sessions s on s.worker_id = e.worker_id
		where e.worker_id = ${quote(workerId)}::uuid and e.body ->> 'reason' = ${quote(reason)} and s.attached_machine_id is null
		order by e.id desc limit 1`), timeoutMs, `the session's ${reason} detach`);
}

/** A quiet day, then the folder core's check-ins drain. Answers the drain's answers and the question it queued (the
 * session's coding-quiet wake), or null. */
export async function quietDay(db, workerId) {
	await db.psql(`update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '25 hours', busy_at = null,
		quiet_asked_days = null, quiet_asked_for = null where worker_id = ${quote(workerId)}::uuid;`);
	const due = await db.rpc("qorpera_folder_coding_checkins_due", { p_after_environment: null, p_limit: 100 });
	const steps = [];
	for (const { environment_id } of due.items)
		steps.push(await db.rpc("qorpera_folder_coding_checkins_company", { p_environment_id: environment_id, p_limit: 8 }));
	const asked = await one(db, `select jsonb_build_object('occurrenceKey', o.occurrence_key, 'status', o.status,
			'summary', o.payload #>> '{completions,0,summary}', 'askedDays', s.quiet_asked_days)
		from public.qorpera_wake_occurrences o join public.qorpera_coding_sessions s on s.worker_id = o.source_id
		where o.source_id = ${quote(workerId)}::uuid and o.occurrence_key like 'coding-quiet:' || ${quote(workerId)} || ':%'
		order by o.created_at desc limit 1`);
	return { due, steps, asked };
}

/** The agent archives the session, as manage_worker's archive does once its run's checks pass. */
export async function archive(db, workerId) {
	return one(db, `select public.qorpera_archive_coding_worker(w, 'agent', w.steering_run_id, null, extensions.gen_random_uuid())
		from public.qorpera_runtime_workers w where w.id = ${quote(workerId)}::uuid`);
}

/** The session's newest event whose body has `key` true (archived, reopened). */
export function event(db, workerId, key) {
	return one(db, `select to_jsonb(e) - 'worker_id' from public.qorpera_coding_session_events e
		where e.worker_id = ${quote(workerId)}::uuid and (e.body -> ${quote(key)}) = 'true'::jsonb order by e.id desc limit 1`);
}
