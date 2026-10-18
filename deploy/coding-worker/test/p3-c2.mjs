// C2's steps on P3's test database (p3-driver.mjs runs them after turn 4, on the folder model): what each step moves
// there and what it reads back.
//   a long turn whose guest stays quiet keeps its machine awake (SQL test 537's case, on the node): once a keep finds
//     the guest quiet, the machine's last use and its last busy check-in move back 11 minutes, past the sleep delay,
//     under the leased turn; the executor's list must not say it is due to sleep, and neither clock may move back up;
//   the folder service crashes mid-session: the machine restarts for the company folder before a view opens on it again
//     (20260930501000, its records in qorpera_coding_machine_folder_restarts), each session attached there gets a
//     FOLDER_RESTART event, and what a command printed from a read the crash left unreleased is kept nowhere: not in
//     the core's tables, not on the NAS.
import { randomBytes } from "node:crypto";
import { quote } from "./p3-database.mjs";

/** One JSON value of `select`, as postgres. */
async function one(db, select) {
	const marker = `@@c2${randomBytes(6).toString("hex")}@@`;
	const [value] = await db.marked(`select ${quote(marker)} || coalesce((${select})::text, 'null');`, marker);
	return value ?? null;
}

/** Once a keep 40 s after a look began (past the idle rule's 30 s) has left the machine's busy clock alone: a guest
 * still busy from its boot would move the clock step 0 moves back, and prove nothing. Looks again until `timeoutMs`;
 * answers what the quiet keep saw. */
export async function awaitQuiet(db, workerId, machine, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const since = `${quote(await one(db, "select to_jsonb(clock_timestamp())"))}::timestamptz`;
		let seen = null;
		while (!seen) {
			if (Date.now() > deadline) throw new Error(`the machine was not quiet for 40 s within ${Math.round(timeoutMs / 1000)} s`);
			await new Promise((settle) => setTimeout(settle, 2000));
			seen = await one(db, `select jsonb_build_object('since', ${since}, 'observedAt', s.observed_at, 'running', s.running_commands,
					'machineBusyAt', m.busy_at, 'busy', coalesce(m.busy_at > ${since} + interval '30 seconds', false))
				from public.qorpera_coding_sessions s join public.qorpera_coding_machines m on m.id = s.attached_machine_id
				where s.worker_id = ${quote(workerId)}::uuid and m.id = ${quote(machine.machineId)}::uuid
					and s.observed_at > ${since} + interval '40 seconds'`);
		}
		if (!seen.busy) return seen;
	}
}

/** Both idle clocks 11 minutes ago: the machine last used, and last busy, past the sleep delay. */
export async function quietElevenMinutes(db, machine) {
	await db.psql(`update public.qorpera_coding_machines set last_used_at = clock_timestamp() - interval '11 minutes',
		busy_at = clock_timestamp() - interval '11 minutes' where id = ${quote(machine.machineId)}::uuid;`);
}

/** The machine last used now: with both clocks 11 minutes back, the housekeeping pass after the turn's lease ends would
 * find it due to sleep. */
export async function usedNow(db, machine) {
	await db.psql(`update public.qorpera_coding_machines set last_used_at = clock_timestamp() where id = ${quote(machine.machineId)}::uuid;`);
}

/** The machine's two idle clocks, and how many seconds ago each was. */
export function clocks(db, machine) {
	return one(db, `select jsonb_build_object('lastUsedAt', last_used_at, 'busyAt', busy_at,
			'lastUsedAgo', extract(epoch from clock_timestamp() - last_used_at), 'busyAgo', extract(epoch from clock_timestamp() - busy_at))
		from public.qorpera_coding_machines where id = ${quote(machine.machineId)}::uuid`);
}

/** The machine's entry in its executor's list, as the executor's keeper and housekeeping read it (service_role). */
export async function listed(db, owner, machineIdSha256, machine) {
	const entries = await db.rpc("qorpera_list_coding_machines", { p_owner: owner, p_machine_id_sha256: machineIdSha256 });
	return (Array.isArray(entries) ? entries : []).find((entry) => entry?.machineId === machine.machineId) ?? null;
}

/** Where the session and its machine stand now: its attachment, the machine's node demand, both folder marks, the
 * session's newest event, and the database's clock. */
export function standing(db, workerId, machine) {
	return one(db, `select jsonb_build_object('attachedMachineId', s.attached_machine_id,
			'attached', coalesce(s.attachment_until > clock_timestamp(), false),
			'demand', exists (select from public.qorpera_runtime_node_demands d where d.allocation_id = m.id and d.released_at is null),
			'suspendedAt', (select d.suspended_at from public.qorpera_runtime_node_demands d where d.allocation_id = m.id and d.released_at is null),
			'folderRestartAt', m.folder_restart_at, 'newDiskAt', m.new_disk_at,
			'lastEventId', (select max(e.id) from public.qorpera_coding_session_events e where e.worker_id = s.worker_id),
			'now', clock_timestamp())
		from public.qorpera_coding_sessions s, public.qorpera_coding_machines m
		where s.worker_id = ${quote(workerId)}::uuid and m.id = ${quote(machine.machineId)}::uuid`);
}

/** The session's events after the event `afterId` (null: all of them), oldest first. */
export async function eventsAfter(db, workerId, afterId) {
	return (await one(db, `select coalesce(jsonb_agg(to_jsonb(e) - 'worker_id' order by e.id), '[]'::jsonb)
		from public.qorpera_coding_session_events e
		where e.worker_id = ${quote(workerId)}::uuid and e.id > ${afterId === null || afterId === undefined ? "0" : quote(String(afterId))}::bigint`)) ?? [];
}

/** The machine's folder restart records made after `since` (the database's clock), oldest first. */
export async function restartsSince(db, machine, since) {
	return (await one(db, `select coalesce(jsonb_agg(jsonb_build_object('operationId', r.operation_id, 'state', r.state,
			'detached', r.detached, 'recordedAt', r.recorded_at) order by r.recorded_at), '[]'::jsonb)
		from public.qorpera_coding_machine_folder_restarts r
		where r.machine_id = ${quote(machine.machineId)}::uuid and r.recorded_at > ${quote(since)}::timestamptz`)) ?? [];
}

/** The core's tables with a row that holds `text`, as text or as its UTF-8 bytes in hex (a bytea column), and the
 * tables it could not read. */
export async function holding(db, text) {
	const marker = `@@c2${randomBytes(6).toString("hex")}@@`;
	const [value] = await db.marked(`create or replace function pg_temp.c2_holding(p_text text) returns jsonb language plpgsql as $c2$
declare v_table text; v_hex text := encode(convert_to(p_text, 'UTF8'), 'hex'); v_found boolean;
	v_holding jsonb := '[]'::jsonb; v_unread jsonb := '[]'::jsonb;
begin
	for v_table in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind = 'r' order by c.relname loop
		begin
			execute format('select exists (select from public.%I x where strpos(x::text, $1) > 0 or strpos(x::text, $2) > 0)', v_table)
				into v_found using p_text, v_hex;
			if v_found then v_holding := v_holding || to_jsonb(v_table); end if;
		exception when others then v_unread := v_unread || to_jsonb(v_table || ': ' || sqlerrm);
		end;
	end loop;
	return jsonb_build_object('holding', v_holding, 'unread', v_unread);
end $c2$;
select ${quote(marker)} || pg_temp.c2_holding(${quote(text)})::text;`, marker);
	return value;
}
