// C2's steps on P3's test database (p3-driver.mjs runs them after turn 4, on the folder model): what each step moves
// there and what it reads back.
//   a long turn whose guest stays quiet keeps its machine awake (SQL test 537's case, on the node): once a keep finds
//     the guest quiet, the machine's last use and its last busy check-in move back 11 minutes, past the sleep delay,
//     under the leased turn; the executor's list must not say it is due to sleep, and neither clock may move back up;
//   the folder service crashes mid-session: the machine restarts for the company folder before a view opens on it again
//     (20260930501000, its records in qorpera_coding_machine_folder_restarts), each session attached there gets a
//     FOLDER_RESTART event, and what a command printed from a read the crash left unreleased is kept nowhere: not in
//     the core's tables, not on the NAS;
//   a read the session's turn can no longer place gets its machine a new disk (20260930505000): the machine's read set
//     (20260928549470) holds a file a turn read, the owner narrows its folder, the next turn's lease marks the machine,
//     and the executor stops it (its 'new-disk' record and the session's MACHINE_NEW_DISK event) and rebuilds it from
//     its image (its 'replaced' record, which empties the read set); the turn after says so in its context
//     (20260930515000), and the one after that no longer does.
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

/** Where the session and its machine stand now: its attachment, the machine's node demand, both folder marks, its last
 * error, the session's newest event, and the database's clock. */
export function standing(db, workerId, machine) {
	return one(db, `select jsonb_build_object('attachedMachineId', s.attached_machine_id,
			'attached', coalesce(s.attachment_until > clock_timestamp(), false),
			'demand', exists (select from public.qorpera_runtime_node_demands d where d.allocation_id = m.id and d.released_at is null),
			'suspendedAt', (select d.suspended_at from public.qorpera_runtime_node_demands d where d.allocation_id = m.id and d.released_at is null),
			'folderRestartAt', m.folder_restart_at, 'newDiskAt', m.new_disk_at, 'lastError', m.last_error,
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

/** The machine's read set, as its views' releases wrote it at each turn's boundary: its pairs, its records of released
 * reads, whether a record names `path`, and the first 20 paths they name. */
export function readSet(db, machine, path) {
	const id = `${quote(machine.machineId)}::uuid`;
	return one(db, `select jsonb_build_object(
			'pairs', (select count(*) from public.qorpera_coding_machine_reads r where r.coding_machine_id = ${id}),
			'records', (select count(*) from public.qorpera_coding_machine_read_records r where r.coding_machine_id = ${id}),
			'holds', exists (select from public.qorpera_coding_machine_read_records r where r.coding_machine_id = ${id}
				and r.reads @> jsonb_build_array(jsonb_build_object('path', ${quote(path)}::text))),
			'paths', (select coalesce(jsonb_agg(p.path order by p.path), '[]'::jsonb) from (select distinct x ->> 'path' as path
				from public.qorpera_coding_machine_read_records r, jsonb_array_elements(r.reads) x
				where r.coding_machine_id = ${id} order by 1 limit 20) p))`);
}

/** When the session's turn began, as 20260930515000 counts it: when its wake occurrence was made, or, never begun, when
 * it opened. */
const began = (workerId, sequence) => `(select coalesce(o.created_at, t.created_at) from public.qorpera_coding_session_turns t
	left join public.qorpera_wake_occurrences o on o.id = t.occurrence_id
	where t.worker_id = ${quote(workerId)}::uuid and t.sequence = ${Number(sequence)})`;

/** Whether `at` (the database's clock) falls in turn `sequence`'s time: at or after it began, before the next turn
 * began. */
export function inTurn(db, workerId, sequence, at) {
	return one(db, `select jsonb_build_object('began', b.began, 'nextBegan', b.next,
			'inTurn', coalesce(${quote(at)}::timestamptz >= b.began and ${quote(at)}::timestamptz < b.next, false))
		from (select ${began(workerId, sequence)} as began, ${began(workerId, sequence + 1)} as next) b`);
}

/** Whether the executor stopped the machine for a new disk and rebuilt it once, judged from what was recorded after
 * the narrowing: SQL's folder restart records (`restarts`, oldest first), the custody SQL answered for the machine
 * (`custody`: intent and answer, in answer order), and the machine's journal on the NAS with the disk record next to
 * it (`journal`: its events in order, and `disk`).
 * - SQL has a 'new-disk' record, then exactly one 'replaced' record.
 * - Custody granted a stop, and a rebuild after it. Grants count nothing that ran: rebuild custody is also how the
 *   executor asks whether SQL marked the machine for a new disk (#newDiskDue, granted for a marked one and changing
 *   nothing), and a pending stop is authorized again on each pass.
 * - So the journal shows what ran: a stop, the rebuild and a start, each settled succeeded, the rebuild's LXD
 *   operation named by the disk record and by SQL's 'replaced' record.
 * Answers each failure (none: so it was), the intents granted, and the journal's stop, rebuild and start. */
export function judgeNewDisk({ restarts, custody, journal }) {
	const failures = [];
	const stoppedFor = restarts.findIndex((row) => row.state === "new-disk");
	const replaced = restarts.filter((row) => row.state === "replaced");
	if (stoppedFor < 0 || replaced.length !== 1 || restarts.indexOf(replaced[0]) < stoppedFor)
		failures.push(`the machine was not stopped for a new disk and then rebuilt once: ${JSON.stringify(restarts)}`);
	const granted = custody.filter((entry) => entry.answer === "granted").map((entry) => entry.intent);
	const stopAt = granted.indexOf("stop");
	if (stopAt < 0 || !granted.slice(stopAt + 1).includes("rebuild"))
		failures.push(`the executor's custody did not grant a stop, then a rebuild: ${JSON.stringify(custody)}`);
	const settled = journal.events.filter((event) => event.kind === "settled");
	const rebuilt = settled.findLastIndex((event) => event.action === "rebuild");
	const ran = rebuilt < 1 ? [] : settled.slice(rebuilt - 1, rebuilt + 2);
	if (ran.length !== 3 || ran.map((event) => `${event.action} ${event.state}`).join(", ") !== "stop succeeded, rebuild succeeded, start succeeded" ||
		ran[1].operationId !== replaced[0]?.operationId || journal.disk?.schema !== "qorpera.coding-machine-disk/v1" ||
		journal.disk.operationId !== ran[1].operationId)
		failures.push(`the machine's journal does not run a stop, the rebuild and a start, the rebuild named by its disk record and SQL's: ` +
			`${JSON.stringify({ disk: journal.disk, replaced, settled: settled.slice(-6) })}`);
	return { failures, granted, ran: ran.map((event) => `${event.action} ${event.operationId}`) };
}

/** The session's attachment as SQL holds it: its machine, when it attached and until when, and the lease between the
 * two in seconds. An attach leases 60 s from its attached_at (20260928187000:227); only a keep moves attachment_until
 * past that (187000:341) until the next attach, which resets both. */
export function attachment(db, workerId) {
	return one(db, `select jsonb_build_object('machineId', s.attached_machine_id, 'attachedAt', s.attached_at, 'until', s.attachment_until,
			'lease', extract(epoch from s.attachment_until - s.attached_at), 'now', clock_timestamp())
		from public.qorpera_coding_sessions s where s.worker_id = ${quote(workerId)}::uuid`);
}

/** Whether the executor's keeper kept turn 9's attachment on the machine's new boot (49's check), judged from the
 * executor's mount and session-error lines since turn 8 ended (`lines`, in order) and the session's `attachment`.
 * - Turn 9's view mounted on the machine: its first mount in `lines`, right after its session attached.
 * - No session error for the machine, or for a whole keep pass, after that mount. Those before it are the rebuild's and
 *   expected: the keeper cuts a machine's step at 15 s while guest.status hangs in the shutdown (ceh:353-356), and it
 *   skips the machine from the start's detach to turn 9's attach.
 * - A keep renewed the attachment: its lease is past 61 s. An attach alone gives 60 s, give or take the microseconds
 *   between its two readings of the clock.
 * Answers each failure (none: so it was) and the session errors before the mount. */
export function judgeKeep({ lines, machineId, attachment }) {
	const failures = [];
	const mounted = lines.findIndex((line) => line.event === "coding-folder-mount" && line.machineId === machineId);
	const errors = (from, to) => lines.slice(from, to)
		.filter((line) => line.event === "coding-session-error" && (line.machineId === machineId || line.machineId === undefined));
	if (mounted < 0) failures.push(`turn 9's view did not mount on the machine: ${JSON.stringify(lines)}`);
	else if (errors(mounted + 1).length)
		failures.push(`the executor logged session errors for the machine after turn 9's view mounted: ${JSON.stringify(errors(mounted + 1))}`);
	if (attachment?.machineId !== machineId || !(attachment.lease > 61))
		failures.push(`no keep renewed turn 9's attachment past its attach's 60 s: ${JSON.stringify(attachment)}`);
	return { failures, before: mounted < 0 ? [] : errors(0, mounted) };
}

/** The machine's instance as LXD answers it (`/1.0/instances/<name>`): its UUID, its vsock id, the image its disk came
 * from, and each network card's MAC. The agent plug writes the card's MAC into the card itself (agent-plug.ts), and LXD
 * then keeps no volatile.<card>.hwaddr for it; a card LXD gave a MAC has it only there. */
export function identityOf({ config, expanded_devices: devices }) {
	const cards = Object.entries(devices ?? {}).filter(([, device]) => device.type === "nic").sort(([a], [b]) => (a < b ? -1 : 1));
	return {
		uuid: config["volatile.uuid"] ?? null, vsockId: config["volatile.vsock_id"] ?? null, baseImage: config["volatile.base_image"] ?? null,
		hwaddrs: Object.fromEntries(cards.map(([name, device]) => [name, device.hwaddr ?? config[`volatile.${name}.hwaddr`] ?? null])),
	};
}

/** Whether LXD's rebuild gave the instance a new root disk from its image and kept the instance itself, judged from its
 * identity before the rebuild (`before`, turn 7's) and after it (`after`, turn 9's): the same UUID, vsock id and cards'
 * MACs, and its disk from `image`. Answers each difference, with both values (none: so it was). */
export function judgeIdentity({ before, after, image }) {
	const macs = Object.values(before.hwaddrs);
	return [
		(!before.uuid || !before.vsockId || !macs.length || !macs.every(Boolean)) && `LXD showed no full identity before the rebuild (${JSON.stringify(before)})`,
		after.baseImage !== image && `volatile.base_image is ${after.baseImage}, not the image ${image}`,
		after.uuid !== before.uuid && `volatile.uuid ${before.uuid} → ${after.uuid}`,
		after.vsockId !== before.vsockId && `volatile.vsock_id ${before.vsockId} → ${after.vsockId}`,
		JSON.stringify(after.hwaddrs) !== JSON.stringify(before.hwaddrs) && `MAC addresses ${JSON.stringify(before.hwaddrs)} → ${JSON.stringify(after.hwaddrs)}`,
	].filter(Boolean);
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
