-- One lock order for a coding session's rows (runtime v117).
--
-- Order 5 locks a todo, then its worker (20260920 review fixes). A coding
-- session is a species of that worker, so its row comes after the worker's,
-- and what belongs to the session comes after it: its turn (v113) or its
-- machine. The executor's claim and the agent's worker tool already take the
-- rows in that order. These did not:
--   - the owner's answer locked the worker, then the session, then the todo;
--   - the executor's begin and completion locked the session, then the todo,
--     then the worker;
--   - the executor's machine admission locked the session, then the worker,
--     then the machine;
--   - a machine's detach locked the machine, then the session.
-- Two of these at once on one session could deadlock: the owner answering
-- while the executor finishes or admits the turn's machine, the agent
-- cancelling while the executor begins or finishes, or a detach while the
-- next turn is admitted to the same machine.
--
-- The order, everywhere: the company's profile fence and Company File (every
-- agent tool call takes them first), todo, worker, coding session, then the
-- session's turn or its machine. A call may start later in the list (a
-- heartbeat locks only the session), but it never goes back. Machine
-- admission starts at the worker: it never writes the todo, and its node
-- reservation takes the profile fence late (a known gap, see PR #318), so
-- holding the todo there would deadlock with every agent tool on that todo.

-- Internal: a worker, locked after its todo. A worker's todo never changes.
create function public.qorpera_lock_coding_worker(p_worker_id uuid)
returns public.qorpera_runtime_workers language plpgsql volatile security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype;
begin
	perform 1 from public.qorpera_runtime_agent_todos
	where id = (select worker.todo_id from public.qorpera_runtime_workers worker where worker.id = p_worker_id) for update;
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id for update;
	return v_worker;
end
$$;

create function pg_temp.lock_order_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding lock order integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- The owner's answer and delegation: the authority check reads the worker
-- without a lock, so only its owner locks anything.
select pg_temp.lock_order_patch('public.qorpera_coding_session_owner_row(uuid)',
	$old$	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id and species = 'coding' for update;$old$,
	$new$	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id and species = 'coding';$new$);
select pg_temp.lock_order_patch('public.qorpera_coding_session_owner_row(uuid)',
	$old$	return v_worker;$old$,
	$new$	return public.qorpera_lock_coding_worker(v_worker.id);$new$);
-- The answer's todo is locked with its worker now, before the session.
select pg_temp.lock_order_patch('public.qorpera_answer_coding_session(uuid,text,uuid)',
	$old$	perform 1 from public.qorpera_runtime_agent_todos where id = v_worker.todo_id for update;
$old$,
	$new$$new$);

-- The executor's begin and completion change the worker and touch its todo:
-- they lock the todo and the worker before their leased session.
select pg_temp.lock_order_patch('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
	$old$	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$old$,
	$new$	perform public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$new$);
select pg_temp.lock_order_patch('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
	$old$	perform 1 from public.qorpera_runtime_agent_todos where id = (select todo_id from public.qorpera_runtime_workers where id = v_session.worker_id) for update;
$old$,
	$new$$new$);
select pg_temp.lock_order_patch('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
	$old$	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$old$,
	$new$	perform public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$new$);
select pg_temp.lock_order_patch('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
	$old$	perform 1 from public.qorpera_runtime_agent_todos where id = (select todo_id from public.qorpera_runtime_workers where id = v_session.worker_id) for update;
$old$,
	$new$$new$);
-- Machine admission locks the worker, not its todo, before the leased session.
select pg_temp.lock_order_patch('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)',
	$old$	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update;$old$,
	$new$	-- The worker, not its todo: the node reservation below waits for the company's profile fence,
	-- which every agent tool call holds while it locks a todo.
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id for update;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$new$);

-- A detach locks the session before the machine, as the admission does.
select pg_temp.lock_order_patch('public.qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)',
	$old$	v_machine := public.qorpera_coding_machine_custody(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);$old$,
	$new$	if p_intent = 'detach' then
		perform 1 from public.qorpera_coding_sessions where worker_id = p_worker_id for update; end if;
	v_machine := public.qorpera_coding_machine_custody(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);$new$);

revoke all on function public.qorpera_lock_coding_worker(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
