-- 20260930501000: F3 step 5g-5, part 2 (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, rule 4: "A crashed
-- service"). A coding machine whose reads can't be proven released must restart before it opens a coding view again.
-- When a crashed folder service's view closes (service_crashed), its reads may still be in the machine, and the next
-- service run knows nothing of them: a session that held no view at the crash could open a fresh view on the same boot
-- and have it served as proven. So the machine is marked, durably, until the executor has restarted it.
-- 1. qorpera_coding_machines.folder_restart_at: the mark.
-- 2. qorpera_folder_view_renew: a renewal that closes a coding view as service_crashed marks the view's coding machine
--    and closes the machine's other open coding views ('ended'). A renewal of a coding view on a marked machine closes
--    it too ('ended'): a view another renewal held at the marking was skipped, not waited for.
-- 3. qorpera_folder_view_open refuses a coding view on a marked machine: 'Coding machine must restart first' (42501,
--    detail qorpera.coding-machine/folder-restart). The machine is held FOR SHARE first, so a renewal that marks it
--    either commits before (the mark is seen) or waits, and then closes the view this opens.
-- 4. qorpera_authorize_coding_machine_custody grants a marked machine's stop under a leased turn. Its removal still waits.
-- 5. qorpera_coding_stopped_event names the reason FOLDER_RESTART: "The machine restarted for the company folder".
-- 6. qorpera_mark_coding_machine_folder_restart: the executor marks a machine it is about to restart for the folder
--    (a view it held closed, a boundary or a publication it can't prove).
-- 7. qorpera_record_coding_machine_folder_restart: the executor, after the machine stopped and before it starts, detaches
--    every session attached to it (leased turns too), each with one FOLDER_RESTART event, and clears the mark. Not an
--    outside stop: nothing goes into qorpera_coding_machine_outside_stops. Each record is named by the start it comes
--    before (the LXD operation of the effect that start follows) and kept in qorpera_coding_machine_folder_restarts: a
--    second record of the same start, however late, answers what the first did and changes nothing, so a delayed one
--    never clears a later mark or detaches a later boot's sessions.
-- Exact-text patches: each fails unless its function has the text given exactly once. Each new, patched or replaced
-- function names this migration (20260930501000); the earlier markers stay.
-- Locks: renew holds its view, then the machine (NO KEY UPDATE), then takes the machine's other open views SKIP LOCKED,
-- so it never waits for a view. view_open takes its views, then its session, then the machine (FOR SHARE). The record
-- takes its own row, then the sessions in worker order, and the machine last, as the outside stop's record does.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure), '20260930501000') > 0
		then raise exception 'The coding machine''s folder restart (20260930501000) is already applied'; end if;
end $$;

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.coding_machine_folder_restart_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '% does not have the text this migration expects (% times): %', p_target, v_found,
				left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. Since when the machine must restart before a coding view opens on it: its reads can't be proven released (a
-- crashed folder service's view, or the executor found so). The executor clears it after the stop, before the start.
-- The renewal that marks finds the machine's open coding views by machine.
alter table public.qorpera_coding_machines add column folder_restart_at timestamptz;
create index qorpera_folder_views_open_coding_machine on public.qorpera_folder_views (machine_id)
	where state = 'open' and kind = 'coding_session';

-- Internal: what each start's record answered (7), named by the LXD operation of the effect the start follows. The
-- key check on the machine is deferred, as the outside stops' is, so the record takes the machine only after its
-- sessions.
create table public.qorpera_coding_machine_folder_restarts (
	machine_id uuid not null references public.qorpera_coding_machines(id) on delete cascade deferrable initially deferred,
	operation_id uuid not null,
	state text not null default 'unmarked' check (state in ('unmarked', 'restarted')),
	detached jsonb not null default '[]'::jsonb check (jsonb_typeof(detached) = 'array'),
	recorded_at timestamptz not null default clock_timestamp(),
	primary key (machine_id, operation_id)
);
alter table public.qorpera_coding_machine_folder_restarts enable row level security;
revoke all on public.qorpera_coding_machine_folder_restarts from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The renewal.
select pg_temp.coding_machine_folder_restart_patch('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', array[
	$old$		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'service_crashed'
		where id = v_view.id returning * into v_view;
$old$,
	$new$		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'service_crashed'
		where id = v_view.id returning * into v_view;
		-- 20260930501000 (F3 5g-5): a coding view's reads may still be in its machine, and the next service knows nothing
		-- of them. The machine must restart before a coding view opens on it again, and its other open coding views close.
		-- One another renewal holds now is skipped, not waited for: its own renewal closes it (below).
		if v_view.kind = 'coding_session' and v_view.machine_id is not null then
			update public.qorpera_coding_machines set folder_restart_at = coalesce(folder_restart_at, clock_timestamp())
			where id = v_view.machine_id;
			update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'ended'
			where id in (select other.id from public.qorpera_folder_views other where other.kind = 'coding_session'
				and other.machine_id = v_view.machine_id and other.state = 'open' order by other.id for no key update skip locked);
		end if;
$new$,
	$old$	v_ok := public.qorpera_folder_view_valid(v_view)
$old$,
	$new$	-- 20260930501000 (F3 5g-5): a coding view on a machine that must restart closes.
	if v_view.kind = 'coding_session' and exists (select 1 from public.qorpera_coding_machines
		where id = v_view.machine_id and folder_restart_at is not null) then
		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'ended'
		where id = v_view.id returning * into v_view;
		return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','closed','reason',v_view.close_reason);
	end if;
	v_ok := public.qorpera_folder_view_valid(v_view)
$new$]);

-- 3. The open.
select pg_temp.coding_machine_folder_restart_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', array[
	$old$			raise exception 'Folder view attachment is not current' using errcode = '42501'; end if;
$old$,
	$new$			raise exception 'Folder view attachment is not current' using errcode = '42501'; end if;
		-- 20260930501000 (F3 5g-5): not on a machine that must restart. The machine is held first: a renewal that marks it
		-- either committed before (seen here) or waits, and then closes the view this opens.
		perform 1 from public.qorpera_coding_machines where id = v_session.attached_machine_id for share;
		if exists (select 1 from public.qorpera_coding_machines where id = v_session.attached_machine_id
			and folder_restart_at is not null) then
			raise exception 'Coding machine must restart first' using errcode = '42501',
				detail = 'qorpera.coding-machine/folder-restart'; end if;
$new$]);

-- 4. Stop custody for a marked machine, under a leased turn too (the executor restarts it for the folder).
select pg_temp.coding_machine_folder_restart_patch(
	'public.qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)', array[
	$old$	elsif public.qorpera_coding_machine_live(v_machine) then
$old$,
	$new$	-- 20260930501000 (F3 5g-5): a machine that must restart for the folder stops under a leased turn too.
	elsif public.qorpera_coding_machine_live(v_machine) and not (p_intent = 'stop' and v_machine.folder_restart_at is not null) then
$new$]);

-- 5. Internal: the words for the reason FOLDER_RESTART. The others keep theirs.
create or replace function public.qorpera_coding_stopped_event(p_reason text, p_stopped jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	-- 20260930431000: MACHINE_STOPPED, the machine stopped from outside.
	-- 20260930501000: FOLDER_RESTART, the executor restarted the machine for the company folder.
	select jsonb_build_object('text', case p_reason when 'SLEEP' then 'The machine went to sleep'
			when 'RETIRED' then 'The machine was replaced by a newer one'
			when 'ARCHIVED' then 'Archived'
			when 'EXPIRED' then 'The session lost its machine'
			when 'OWNER_LEFT' then 'The owner is no longer a member'
			when 'REPOSITORY_WITHDRAWN' then 'The agent no longer has the repository'
			when 'MACHINE_STOPPED' then 'The machine stopped'
			when 'FOLDER_RESTART' then 'The machine restarted for the company folder'
			else 'Coding is not enabled here any more' end
			|| case jsonb_array_length(p_stopped) when 0 then '' when 1 then '; 1 command was stopped'
				else '; ' || jsonb_array_length(p_stopped) || ' commands were stopped' end,
		'reason', p_reason,
		'stopped', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements(p_stopped) with ordinality as item(value, ordinal)
			where ordinal <= 32), '[]'::jsonb),
		'moreStopped', greatest(jsonb_array_length(p_stopped) - 32, 0))
$$;

-- 6. The executor marks a machine of its own that it is about to restart for the folder. From then on no coding view
-- opens on it, its open coding views close at their next renewal, and its stop custody is granted under a leased turn,
-- until the record below. Marking a marked machine keeps the first mark. Locks: the machine (NO KEY UPDATE) only.
create function public.qorpera_mark_coding_machine_folder_restart(p_machine_id uuid, p_owner text, p_binding_text text,
	p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930501000
declare v_machine public.qorpera_coding_machines%rowtype;
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	update public.qorpera_coding_machines set folder_restart_at = coalesce(folder_restart_at, clock_timestamp())
	where id = v_machine.id returning * into v_machine;
	return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state','marked');
end
$$;

-- 7. The machine stopped and has not started again: every session attached to it is detached, each with the commands
-- last seen running there, and each gets one FOLDER_RESTART event, commands or not; then the mark is cleared. Only the
-- executor stops and starts the machine, and it records this after the stop and before the start, every start: an
-- unmarked machine answers 'unmarked' and nothing changes, so a record lost to a crash is made at the next start.
-- p_operation_id names the start: the LXD operation of the effect it follows, the same for each try of that start and
-- no other start's. The start's own row is taken first: a second record of the same start (at once, waiting for the
-- first, or after the machine started and was marked again) answers what the first did, 'unmarked' too, and touches no
-- session and no mark. Locks: that row, which no other call takes; then the sessions, in worker order as the keeper
-- takes them; then the machine (NO KEY UPDATE) last. The machine is read first without a lock, so the record never
-- holds the machine while it waits for a session. Answers the sessions it detached, with the attachment each had.
create function public.qorpera_record_coding_machine_folder_restart(p_machine_id uuid, p_operation_id uuid, p_owner text,
	p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930501000
declare v_machine public.qorpera_coding_machines%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_detached jsonb := '[]'::jsonb; v_first boolean; v_state text;
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if p_operation_id is null then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	insert into public.qorpera_coding_machine_folder_restarts(machine_id, operation_id)
	values (v_machine.id, p_operation_id) on conflict do nothing returning true into v_first;
	if v_first is null then
		select r.state, r.detached into strict v_state, v_detached from public.qorpera_coding_machine_folder_restarts r
		where r.machine_id = v_machine.id and r.operation_id = p_operation_id;
		return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state',v_state,
			'detached',v_detached);
	end if;
	if v_machine.folder_restart_at is null then
		return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state','unmarked',
			'detached',v_detached); end if;
	for v_session in select * from public.qorpera_coding_sessions where attached_machine_id = v_machine.id order by worker_id for update loop
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
			attachment_turn = null, attached_at = null, running_commands = '[]'::jsonb, observed_at = clock_timestamp()
		where worker_id = v_session.worker_id;
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'executor',
			public.qorpera_coding_stopped_event('FOLDER_RESTART', v_session.running_commands));
		v_detached := v_detached || jsonb_build_array(jsonb_build_object('workerId', v_session.worker_id,
			'attachmentToken', v_session.attachment_token));
	end loop;
	update public.qorpera_coding_machines set folder_restart_at = null where id = v_machine.id;
	update public.qorpera_coding_machine_folder_restarts set state = 'restarted', detached = v_detached
	where machine_id = v_machine.id and operation_id = p_operation_id;
	return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state','restarted',
		'detached',v_detached);
end
$$;

-- Grants: the executor (service_role) marks and records; the words stay internal.
revoke all on function public.qorpera_coding_stopped_event(text, jsonb),
	public.qorpera_mark_coding_machine_folder_restart(uuid, text, text, text),
	public.qorpera_record_coding_machine_folder_restart(uuid, uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_mark_coding_machine_folder_restart(uuid, text, text, text),
	public.qorpera_record_coding_machine_folder_restart(uuid, uuid, text, text, text) to service_role;
