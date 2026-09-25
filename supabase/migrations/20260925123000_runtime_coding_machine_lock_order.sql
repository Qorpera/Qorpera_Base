-- The company's profile row first, for every coding machine call (runtime v123).
--
-- v117 gave a coding session's rows one order: the company's profile fence and
-- Company File (every agent tool call takes them first), todo, worker, coding
-- session, then the session's turn or machine. The machine calls still went back
-- to the company's profile row after they held later rows:
--   - machine admission held the worker, session, machine, storage volume and
--     allocation, then its node reservation waited for the profile fence;
--   - a plan held the session and the member's machine, then inserted the new
--     machine row, whose key check waits for any profile lock;
--   - a machine's sleep and its release held the machine, then waited for the fence;
--   - the secret broker held the session (shared), then inserted the credential's
--     audit event, whose key check waits for any profile lock.
-- An agent tool call holds the fence while it locks the todo, worker and session,
-- so an agent cancelling the session while any of these ran could deadlock, and the
-- coding executor never retries: the turn was lost.
--
-- The order, everywhere: the company's profile row, then Company File, todo,
-- worker, coding session, machine, storage volume, allocation, node, demand. A
-- call that needs the profile row at all takes it first, in the strongest mode it
-- will take: the fence for admission, sleep and release (the node's slot changes
-- under it), a key-share lock for a plan and the broker (their inserts only need
-- the company to exist). Calls that never wait for it keep starting later in the
-- list (stop, detach, delete, heartbeat, progress, completion, the owner's answer;
-- begin takes it NOWAIT and fails fast). Holding the fence while waiting for a
-- worker or session is what every agent tool call already does. Those rows, and
-- the machine, volume, allocation, node and demand after them, are held only by
-- calls that never wait for the profile row, so the wait ends with one such call.
-- The exception is the Company File row, which a session's first admission reads
-- for its new storage volume: a writer that locks it before the fence
-- (qorpera_prepare_company_file_revision) can meet admission as it meets every
-- agent tool call.

create function pg_temp.machine_lock_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding machine lock order integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- Admission: the fence before the worker. The node reservation takes it again, already held.
select pg_temp.machine_lock_patch('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)',
	$old$	-- The worker, not its todo: the node reservation below waits for the company's profile fence,
	-- which every agent tool call holds while it locks a todo.
$old$,
	$new$	-- The company's profile fence first: the node reservation below takes it, and every agent tool call
	-- holds it while it locks this worker and session. Then the worker; admission never writes its todo.
	perform public.qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
$new$);

-- A plan: the profile row before the session, for the new machine row's key check.
select pg_temp.machine_lock_patch('public.qorpera_plan_coding_machine(uuid,uuid,text)',
	$old$	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$old$,
	$new$	perform 1 from public.qorpera_profiles profile where profile.id = (select worker.profile_id
		from public.qorpera_runtime_workers worker where worker.id = p_worker_id) for key share;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$new$);

-- Sleep and release: the fence before the machine, then allocation, node and demand as before.
select pg_temp.machine_lock_patch('public.qorpera_suspend_coding_machine(uuid,text,text,text)',
	$old$	v_machine := public.qorpera_coding_machine_custody(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);$old$,
	$new$	perform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
	v_machine := public.qorpera_coding_machine_custody(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);$new$);
select pg_temp.machine_lock_patch('public.qorpera_suspend_coding_machine(uuid,text,text,text)',
	$old$	-- Lock order as in reservation: profile fence -> company allocation -> node -> demand.
	perform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);
$old$,
	$new$	-- Lock order as in reservation: profile fence (taken first) -> company allocation -> node -> demand.
$new$);
select pg_temp.machine_lock_patch('public.qorpera_release_coding_machine(uuid,text,text,text)',
	$old$	select * into v_machine from public.qorpera_coding_machines where id = p_machine_id for update;$old$,
	$new$	perform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
	select * into v_machine from public.qorpera_coding_machines where id = p_machine_id for update;$new$);
select pg_temp.machine_lock_patch('public.qorpera_release_coding_machine(uuid,text,text,text)',
	$old$			perform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);
$old$,
	$new$$new$);

-- The broker: the profile row before the session, for the audit event's key check.
select pg_temp.machine_lock_patch('public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)',
	$old$	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority$old$,
	$new$	perform 1 from public.qorpera_profiles as profile where profile.id = (select authority.profile_id
		from public.qorpera_cloud_secret_broker_authorities as authority where authority.id = p_broker_authority_id) for key share;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority$new$);
