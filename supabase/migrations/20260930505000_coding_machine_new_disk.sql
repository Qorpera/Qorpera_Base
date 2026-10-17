-- 20260930505000: F3 step 5g-5, part 3 (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, rule 4b: "A new disk").
-- A coding machine whose read set holds a read the turn taking it in can no longer place (a file narrowed since the
-- machine's programs read it) can't hand that turn the machine as it is: the read is on the machine's disk, which every
-- session there shares. A restart does not take it off the disk. So the machine gets a new disk from its image: only the
-- company folder is kept. Until now that take-in refused, and the turn failed.
-- 1. qorpera_coding_machines.new_disk_at: the mark. It implies folder_restart_at (a check), so everything that mark does
--    holds here too: no coding view opens on the machine, its open coding views close at their next renewal, and its
--    stop custody is granted under a leased turn.
-- 2. The take-in at a turn's lease (qorpera_folder_read_wake, qorpera_authorize_coding_machine_run): a refusal with
--    'A released read is no longer readable' marks the machine instead (both marks), and the turn takes nothing in. Only
--    that refusal: any other raises, 'A read is no longer readable' (the run's own reads) too. Each caller holds the
--    machine before the take-in, outside the sub-block.
-- 3. qorpera_mark_coding_machine_new_disk: the executor marks a machine of its own (a read it can't place).
-- 4. qorpera_record_coding_machine_folder_restart, replaced: on a machine marked for a new disk it detaches every session
--    attached there, each with one MACHINE_NEW_DISK event, keeps both marks and answers 'new-disk': the executor rebuilds
--    the machine before it starts it. Otherwise as before ('unmarked', 'restarted'). Its session and mark now are read
--    under the locks: the sessions in worker order, then the machine.
-- 5. qorpera_authorize_coding_machine_custody grants intent 'rebuild' for a machine marked for a new disk, under a leased
--    turn too ('MACHINE_NO_NEW_DISK' otherwise). It changes nothing on the machine.
-- 6. qorpera_record_coding_machine_new_disk: the executor, after the rebuild and before the start, empties the machine's
--    read set (its disk is new), detaches any session attached there with MACHINE_NEW_DISK, and clears both marks. It is
--    named by the rebuild's LXD operation and kept in qorpera_coding_machine_folder_restarts, as a start's record is: a
--    second record of the same rebuild answers what the first did and changes nothing. A machine not marked for a new
--    disk is refused.
-- 7. qorpera_coding_stopped_event names MACHINE_NEW_DISK: "The machine got a new disk; only the company folder was kept".
-- Not patched: qorpera_replace_coding_machine_disk (no caller) leaves the marks as they are; a mark it leaves costs one
-- more rebuild, never a read.
-- Rollout: the runtime first (its turn context knows the reason), then this migration, then the coding worker. Until the
-- worker knows 'new-disk', a machine so marked does not start (the old worker refuses the answer): the turn that marked it
-- would have failed at its take-in before this migration anyway.
-- Exact-text patches: each fails unless its function has the text given exactly once. Each new, patched or replaced
-- function names this migration (20260930505000); the earlier markers stay.
-- Locks: the take-in's callers hold the machine (FOR NO KEY UPDATE, FOR UPDATE) before it, so the mark adds no lock.
-- Both records take their own row, then the sessions in worker order, then the machine (NO KEY UPDATE); the disk's
-- record then takes the machine's pairs in a commit's recheck order, as qorpera_replace_coding_machine_disk does.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_record_coding_machine_folder_restart(uuid,uuid,text,text,text)'::regprocedure),
		'20260930505000') > 0 then raise exception 'The coding machine''s new disk (20260930505000) is already applied'; end if;
end $$;

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.coding_machine_new_disk_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
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

-- 1. Since when the machine must get a new disk before a coding view opens on it: its read set holds a read a turn can
-- no longer place. The executor clears it after the rebuild, before the start.
alter table public.qorpera_coding_machines add column new_disk_at timestamptz,
	add constraint qorpera_coding_machines_new_disk_restarts check (new_disk_at is null or folder_restart_at is not null);

-- A start's record (4) answers 'new-disk' too, and a rebuild's (6) 'replaced'.
alter table public.qorpera_coding_machine_folder_restarts drop constraint qorpera_coding_machine_folder_restarts_state_check,
	add constraint qorpera_coding_machine_folder_restarts_state_check check (state in ('unmarked', 'restarted', 'new-disk', 'replaced'));

-- 2. The take-in at a turn's lease.
select pg_temp.coding_machine_new_disk_patch('public.qorpera_folder_read_wake(jsonb)', array[
	$old$			perform public.qorpera_coding_machine_take_in(v_run.environment_id, v_run.profile_id, v_machine, v_run.id, v_tool -> 'resolved');
$old$,
	$new$			-- 20260930505000 (F3 5g-5): a read the turn can no longer place is on the machine's disk, which a restart
			-- keeps: the machine gets a new disk, and the turn takes in nothing. Only that refusal; any other raises.
			begin
				perform public.qorpera_coding_machine_take_in(v_run.environment_id, v_run.profile_id, v_machine, v_run.id, v_tool -> 'resolved');
			exception when insufficient_privilege then
				if sqlerrm <> 'A released read is no longer readable' then raise; end if;
				update public.qorpera_coding_machines set new_disk_at = coalesce(new_disk_at, clock_timestamp()),
					folder_restart_at = coalesce(folder_restart_at, clock_timestamp()) where id = v_machine;
			end;
$new$]);
select pg_temp.coding_machine_new_disk_patch('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)', array[
	$old$		perform public.qorpera_coding_machine_take_in(v_worker.environment_id, v_worker.profile_id, v_machine.id, turn.run_id,
			public.qorpera_folder_run_reader(v_worker.profile_id, turn.run_id))
		from public.qorpera_coding_machine_turns(v_machine.id) turn where turn.worker_id = v_worker.id order by turn.run_id;
$old$,
	$new$		-- 20260930505000 (F3 5g-5): a read the turn can no longer place is on the machine's disk, which a restart keeps:
		-- the machine gets a new disk, and the turn takes in nothing. Only that refusal; any other raises.
		begin
			perform public.qorpera_coding_machine_take_in(v_worker.environment_id, v_worker.profile_id, v_machine.id, turn.run_id,
				public.qorpera_folder_run_reader(v_worker.profile_id, turn.run_id))
			from public.qorpera_coding_machine_turns(v_machine.id) turn where turn.worker_id = v_worker.id order by turn.run_id;
		exception when insufficient_privilege then
			if sqlerrm <> 'A released read is no longer readable' then raise; end if;
			update public.qorpera_coding_machines set new_disk_at = coalesce(new_disk_at, clock_timestamp()),
				folder_restart_at = coalesce(folder_restart_at, clock_timestamp()) where id = v_machine.id;
		end;
$new$]);

-- The patched functions may have private owners in production: they mark their machine.
do $$ declare v_caller text; v_owner name; begin
	foreach v_caller in array array['public.qorpera_folder_read_wake(jsonb)',
		'public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)'] loop
		select pg_get_userbyid(proowner) into v_owner from pg_proc where oid = v_caller::regprocedure;
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '% has an API owner', v_caller; end if;
		if v_owner is distinct from current_user then
			execute format('grant update (new_disk_at, folder_restart_at) on public.qorpera_coding_machines to %I', v_owner); end if;
		if not has_column_privilege(v_owner, 'public.qorpera_coding_machines', 'new_disk_at', 'update')
			or not has_column_privilege(v_owner, 'public.qorpera_coding_machines', 'folder_restart_at', 'update') then
			raise exception '% owner cannot mark its machine', v_caller; end if;
	end loop;
end $$;

-- 3. The executor marks a machine of its own that must get a new disk: both marks, each kept if already set. Locks: the
-- machine (NO KEY UPDATE) only.
create function public.qorpera_mark_coding_machine_new_disk(p_machine_id uuid, p_owner text, p_binding_text text,
	p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930505000
declare v_machine public.qorpera_coding_machines%rowtype;
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	update public.qorpera_coding_machines set new_disk_at = coalesce(new_disk_at, clock_timestamp()),
		folder_restart_at = coalesce(folder_restart_at, clock_timestamp())
	where id = v_machine.id returning * into v_machine;
	return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state','marked');
end
$$;

-- 4. A start's record (20260930501000), now with the new disk. The machine stopped and has not started again: on a
-- machine marked for a new disk every session attached to it is detached, each with one MACHINE_NEW_DISK event, and
-- both marks stay: the answer 'new-disk' tells the executor to rebuild before it starts (6 clears them). On a machine
-- only marked to restart it is as before ('restarted', each with one FOLDER_RESTART event, the mark cleared); on an
-- unmarked one 'unmarked'. A second record of the same start answers what the first did and changes nothing, 'replaced'
-- too when the start was named by a rebuild that was recorded (6). Locks: its own row; then the sessions, in worker
-- order; then the machine (NO KEY UPDATE), whose marks are read again under it. The machine is read first without a
-- lock, so the record never holds the machine while it waits for a session.
create or replace function public.qorpera_record_coding_machine_folder_restart(p_machine_id uuid, p_operation_id uuid, p_owner text,
	p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930501000
-- 20260930505000: 'new-disk'
declare v_machine public.qorpera_coding_machines%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_detached jsonb := '[]'::jsonb; v_first boolean; v_state text;
	v_workers uuid[];
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
	select coalesce(array_agg(locked.worker_id order by locked.worker_id), '{}') into v_workers
	from (select s.worker_id from public.qorpera_coding_sessions s where s.attached_machine_id = v_machine.id
		order by s.worker_id for update) locked;
	select * into strict v_machine from public.qorpera_coding_machines where id = v_machine.id for no key update;
	if v_machine.folder_restart_at is null then
		return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state','unmarked',
			'detached',v_detached); end if;
	v_state := case when v_machine.new_disk_at is null then 'restarted' else 'new-disk' end;
	for v_session in select * from public.qorpera_coding_sessions where worker_id = any(v_workers) order by worker_id loop
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
			attachment_turn = null, attached_at = null, running_commands = '[]'::jsonb, observed_at = clock_timestamp()
		where worker_id = v_session.worker_id;
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'executor',
			public.qorpera_coding_stopped_event(case v_state when 'new-disk' then 'MACHINE_NEW_DISK' else 'FOLDER_RESTART' end,
				v_session.running_commands));
		v_detached := v_detached || jsonb_build_array(jsonb_build_object('workerId', v_session.worker_id,
			'attachmentToken', v_session.attachment_token));
	end loop;
	if v_state = 'restarted' then
		update public.qorpera_coding_machines set folder_restart_at = null where id = v_machine.id; end if;
	update public.qorpera_coding_machine_folder_restarts set state = v_state, detached = v_detached
	where machine_id = v_machine.id and operation_id = p_operation_id;
	return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state',v_state,
		'detached',v_detached);
end
$$;

-- 5. Rebuild custody for a machine marked for a new disk, under a leased turn too.
select pg_temp.coding_machine_new_disk_patch(
	'public.qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)', array[
	$old$	if p_intent is null or p_intent not in ('stop','detach','delete') or$old$,
	$new$	if p_intent is null or p_intent not in ('stop','detach','delete','rebuild') or$new$,
	$old$	-- 20260930501000 (F3 5g-5): a machine that must restart for the folder stops under a leased turn too.
	elsif public.qorpera_coding_machine_live(v_machine) and not (p_intent = 'stop' and v_machine.folder_restart_at is not null) then
$old$,
	$new$	-- 20260930501000 (F3 5g-5): a machine that must restart for the folder stops under a leased turn too.
	-- 20260930505000 (F3 5g-5): and one that must get a new disk is rebuilt under it.
	elsif public.qorpera_coding_machine_live(v_machine) and not ((p_intent = 'stop' and v_machine.folder_restart_at is not null)
		or (p_intent = 'rebuild' and v_machine.new_disk_at is not null)) then
$new$,
	$old$	elsif p_intent = 'stop' then
$old$,
	$new$	-- 20260930505000 (F3 5g-5): a new disk from the machine's image, only for a machine marked for one. The executor
	-- rebuilds the stopped machine; nothing changes here.
	elsif p_intent = 'rebuild' then
		if v_machine.new_disk_at is null then return '{"state":"refused","reason":"MACHINE_NO_NEW_DISK"}'::jsonb; end if;
	elsif p_intent = 'stop' then
$new$]);

-- 6. The machine was rebuilt from its image and has not started again. Its disk is new: its read set goes, every
-- session attached to it is detached, each with one MACHINE_NEW_DISK event, and both marks are cleared. p_operation_id
-- names the rebuild: its LXD operation. A second record of the same rebuild answers what the first did and changes
-- nothing; an operation a start's record (4) used is refused. So is a machine not marked for a new disk: only a marked
-- one is rebuilt (5), and a record with no rebuild behind it would drop reads its disk still holds. The mark is read
-- first without a lock, and again under the machine's. Locks: its own row; then the sessions, in worker order; then the
-- machine (NO KEY UPDATE); then its pairs in a commit's recheck order. Answers the sessions it detached, with the
-- attachment each had.
create function public.qorpera_record_coding_machine_new_disk(p_machine_id uuid, p_operation_id uuid, p_owner text,
	p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930505000
declare v_machine public.qorpera_coding_machines%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_detached jsonb := '[]'::jsonb; v_first boolean; v_state text;
	v_workers uuid[];
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if p_operation_id is null then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	insert into public.qorpera_coding_machine_folder_restarts(machine_id, operation_id)
	values (v_machine.id, p_operation_id) on conflict do nothing returning true into v_first;
	if v_first is null then
		select r.state, r.detached into strict v_state, v_detached from public.qorpera_coding_machine_folder_restarts r
		where r.machine_id = v_machine.id and r.operation_id = p_operation_id;
		if v_state <> 'replaced' then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state',v_state,
			'detached',v_detached);
	end if;
	if v_machine.new_disk_at is null then
		raise exception 'Coding machine is not marked for a new disk' using errcode = '55000'; end if;
	select coalesce(array_agg(locked.worker_id order by locked.worker_id), '{}') into v_workers
	from (select s.worker_id from public.qorpera_coding_sessions s where s.attached_machine_id = v_machine.id
		order by s.worker_id for update) locked;
	select * into strict v_machine from public.qorpera_coding_machines where id = v_machine.id for no key update;
	if v_machine.new_disk_at is null then
		raise exception 'Coding machine is not marked for a new disk' using errcode = '55000'; end if;
	for v_session in select * from public.qorpera_coding_sessions where worker_id = any(v_workers) order by worker_id loop
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
			attachment_turn = null, attached_at = null, running_commands = '[]'::jsonb, observed_at = clock_timestamp()
		where worker_id = v_session.worker_id;
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'executor',
			public.qorpera_coding_stopped_event('MACHINE_NEW_DISK', v_session.running_commands));
		v_detached := v_detached || jsonb_build_array(jsonb_build_object('workerId', v_session.worker_id,
			'attachmentToken', v_session.attachment_token));
	end loop;
	perform 1 from public.qorpera_coding_machine_reads where coding_machine_id = v_machine.id
	order by resource_id, grant_id nulls first for update;
	delete from public.qorpera_coding_machine_reads where coding_machine_id = v_machine.id;
	delete from public.qorpera_coding_machine_read_records where coding_machine_id = v_machine.id;
	update public.qorpera_coding_machines set new_disk_at = null, folder_restart_at = null where id = v_machine.id;
	update public.qorpera_coding_machine_folder_restarts set state = 'replaced', detached = v_detached
	where machine_id = v_machine.id and operation_id = p_operation_id;
	return jsonb_build_object('schema','qorpera.coding-machine-folder-restart/v1','machineId',v_machine.id,'state','replaced',
		'detached',v_detached);
end
$$;

-- 7. Internal: the words for the reason MACHINE_NEW_DISK. The others keep theirs.
create or replace function public.qorpera_coding_stopped_event(p_reason text, p_stopped jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	-- 20260930431000: MACHINE_STOPPED, the machine stopped from outside.
	-- 20260930501000: FOLDER_RESTART, the executor restarted the machine for the company folder.
	-- 20260930505000: MACHINE_NEW_DISK, the executor gave the machine a new disk from its image.
	select jsonb_build_object('text', case p_reason when 'SLEEP' then 'The machine went to sleep'
			when 'RETIRED' then 'The machine was replaced by a newer one'
			when 'ARCHIVED' then 'Archived'
			when 'EXPIRED' then 'The session lost its machine'
			when 'OWNER_LEFT' then 'The owner is no longer a member'
			when 'REPOSITORY_WITHDRAWN' then 'The agent no longer has the repository'
			when 'MACHINE_STOPPED' then 'The machine stopped'
			when 'FOLDER_RESTART' then 'The machine restarted for the company folder'
			when 'MACHINE_NEW_DISK' then 'The machine got a new disk; only the company folder was kept'
			else 'Coding is not enabled here any more' end
			|| case jsonb_array_length(p_stopped) when 0 then '' when 1 then '; 1 command was stopped'
				else '; ' || jsonb_array_length(p_stopped) || ' commands were stopped' end,
		'reason', p_reason,
		'stopped', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements(p_stopped) with ordinality as item(value, ordinal)
			where ordinal <= 32), '[]'::jsonb),
		'moreStopped', greatest(jsonb_array_length(p_stopped) - 32, 0))
$$;

-- Grants: the executor (service_role) marks and records; the words stay internal.
revoke all on function public.qorpera_coding_stopped_event(text, jsonb),
	public.qorpera_mark_coding_machine_new_disk(uuid, text, text, text),
	public.qorpera_record_coding_machine_folder_restart(uuid, uuid, text, text, text),
	public.qorpera_record_coding_machine_new_disk(uuid, uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_mark_coding_machine_new_disk(uuid, text, text, text),
	public.qorpera_record_coding_machine_folder_restart(uuid, uuid, text, text, text),
	public.qorpera_record_coding_machine_new_disk(uuid, uuid, text, text, text) to service_role;
