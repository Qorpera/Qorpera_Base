-- No standing counts (Jonas, 2026-09-24, after bundle v92 removed the run,
-- machine and send caps): "remove all of them"; machine capacity is the only
-- real limit.
-- * An agent may keep any number of routines (was 32 active or paused), open
--   todos (was 64) and active workers (was 4 at once).
-- * A company may have any number of rail sections (was 40).
-- * A Company File change may wake an agent already earlier in its causal
--   chain; that agent moves to the end of the chain, as a coworker message
--   already does (was fenced). An agent's own write still never wakes its own
--   watch routine: that is what the write was, not a count.
-- Worker reports are still handed back four at a time, one revival after
-- another, so a batch of any size is delivered in full and never to two
-- continuations at once.

create function pg_temp.count_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Count removal differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.count_patch('public.qorpera_manage_agent_routine(jsonb,jsonb)'::regprocedure,
	$old$			if (select count(*) from public.qorpera_cloud_routines routine
				where routine.profile_id = v_run.profile_id and routine.origin = 'agent'
					and routine.owner_staff_agent_id = v_run.staff_agent_id
					and routine.status in ('active','paused')) >= 32 then
				raise exception 'Agent routine limit reached' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.count_patch('public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure,
	$old$			if (select count(*) from public.qorpera_runtime_agent_todos todo where todo.profile_id = v_run.profile_id
				and todo.staff_agent_id = v_run.staff_agent_id and todo.state in ('open','blocked')) >= 64 then
				raise exception 'Too many open todos; finish or cancel some first' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.count_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$		if (select count(*) from public.qorpera_runtime_workers worker where worker.profile_id = v_run.profile_id
			and worker.staff_agent_id = v_run.staff_agent_id and worker.state = 'active') >= 4 then
			raise exception 'Four workers are already active; wait for one or cancel one' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.count_patch('public.qorpera_sidebar_create_section(uuid,uuid,text,uuid,uuid)'::regprocedure,
	$old$	if (select count(*) from public.qorpera_company_sidebar_sections where profile_id = p_profile_id) >= 40 then
		raise exception 'A company can have at most 40 sections' using errcode = '54000'; end if;
$old$,
	'');

-- Whether a person stopped one of this parent's revivals (a continuation of its
-- own work): that stops the rest of the parent's workers, as stopping the parent does.
create function public.qorpera_worker_revival_stopped(p_steering_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_wake_occurrences revival
		join public.qorpera_execution_runs revival_run on revival_run.id = revival.run_id
		join public.qorpera_runner_jobs revival_job on revival_job.id = revival_run.job_id
		where revival.parent_run_id = p_steering_run_id and revival.source_kind = 'worker-completion'
			and revival_job.status = 'cancelled')
$$;
revoke all on function public.qorpera_worker_revival_stopped(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;
select pg_temp.count_patch('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$				if v_status = 'cancelled' then
					-- The parent was stopped by a person: its workers stop with it.$old$,
	$new$				if v_status = 'cancelled' or public.qorpera_worker_revival_stopped(v_worker.steering_run_id) then
					-- The parent, or a continuation of it, was stopped by a person: its workers stop with it.$new$);
-- With no count on active workers a batch can hold more than four. Reports are
-- still handed back four per revival, but one revival at a time: the next four
-- wait until the previous revival's run has ended, and stillActive counts the
-- results that have not reached the agent yet. The status and todo listings are
-- pages; what they leave out is counted (moreWorkers, moreTodos).
select pg_temp.count_patch('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
$old$,
	$new$			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
			-- A person who stops a revival holds back the rest of that parent's reports (its running
			-- workers are cancelled above), as stopping the parent does; results stay readable through status.
			if public.qorpera_worker_revival_stopped(v_worker.steering_run_id) then
				update public.qorpera_runtime_workers set completion_state = 'suppressed' where id = v_worker.id; continue;
			end if;
			-- One revival at a time for a parent (runtime v95: a batch may exceed four): the next four reports
			-- wait until the previous revival's run has ended, so two continuations never run side by side.
			-- The company's wake admission lock first, so two drains cannot both pass this check.
			perform public.qorpera_serialize_wake_admission(v_worker.profile_id);
			if exists (select 1 from public.qorpera_wake_occurrences pending
				left join public.qorpera_execution_runs pending_run on pending_run.id = pending.run_id
				left join public.qorpera_runner_jobs pending_job on pending_job.id = pending_run.job_id
				where pending.parent_run_id = v_worker.steering_run_id and pending.source_kind = 'worker-completion'
					and (pending.status = 'queued' or (pending.status = 'materialized'
						and (pending_job.id is null or pending_job.status in ('queued','leased'))))) then continue; end if;
$new$);
select pg_temp.count_patch('public.qorpera_worker_completion_payload(uuid,uuid[])'::regprocedure,
	$old$			where worker.steering_run_id = p_steering_run_id and worker.state = 'active'))$old$,
	$new$			-- Results that have not reached the agent yet: still working, or waiting for this continuation to end.
			where worker.steering_run_id = p_steering_run_id and (worker.state = 'active'
				or (worker.completion_state = 'waiting' and not (worker.id = any(p_worker_ids))))))$new$);
select pg_temp.count_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$		return jsonb_build_object('schema','qorpera.agent-workers/v1','runId',v_run.id,'workers',coalesce((
			-- One named worker is shown in full; a listing keeps summaries short so many fit one result.
			select jsonb_agg(public.qorpera_worker_view(listed.worker, p_request ? 'workerKey') || jsonb_build_object('todoKey', listed.todo_key)
				|| coalesce((select jsonb_build_object('coding', public.qorpera_coding_session_view(session, listed.worker))
					from public.qorpera_coding_sessions session where session.worker_id = (listed.worker).id), '{}'::jsonb)
				order by (listed.worker).updated_at desc, (listed.worker).id) from (
				select worker, todo.todo_key from public.qorpera_runtime_workers worker
				join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
				where worker.profile_id = v_run.profile_id and worker.environment_id = v_run.environment_id
					and worker.staff_agent_id = v_run.staff_agent_id
					and (p_request ->> 'todoKey' is null or todo.todo_key = p_request ->> 'todoKey')
					and (p_request ->> 'workerKey' is null or worker.worker_key = p_request ->> 'workerKey')
					and (p_request ->> 'todoKey' is not null or todo.state in ('open','blocked')
						or worker.updated_at > clock_timestamp() - interval '7 days')
				order by worker.updated_at desc, worker.id limit 16) listed), '[]'::jsonb));$old$,
	$new$		-- A page of sixteen, active and blocked workers first; the rest are counted in moreWorkers, never silently
		-- dropped (runtime v95: an agent may run any number of workers).
		return (select jsonb_build_object('schema','qorpera.agent-workers/v1','runId',v_run.id,'workers',coalesce(
			-- One named worker is shown in full; a listing keeps summaries short so many fit one result.
			jsonb_agg(public.qorpera_worker_view(listed.worker, p_request ? 'workerKey') || jsonb_build_object('todoKey', listed.todo_key)
				|| coalesce((select jsonb_build_object('coding', public.qorpera_coding_session_view(session, listed.worker))
					from public.qorpera_coding_sessions session where session.worker_id = (listed.worker).id), '{}'::jsonb)
				order by (listed.worker).state in ('active','blocked') desc, (listed.worker).updated_at desc, (listed.worker).id), '[]'::jsonb),
			'moreWorkers', coalesce(max(listed.total), 0) - count(*))
		from (
				select worker, todo.todo_key, count(*) over () as total from public.qorpera_runtime_workers worker
				join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
				where worker.profile_id = v_run.profile_id and worker.environment_id = v_run.environment_id
					and worker.staff_agent_id = v_run.staff_agent_id
					and (p_request ->> 'todoKey' is null or todo.todo_key = p_request ->> 'todoKey')
					and (p_request ->> 'workerKey' is null or worker.worker_key = p_request ->> 'workerKey')
					and (p_request ->> 'todoKey' is not null or todo.state in ('open','blocked')
						or worker.updated_at > clock_timestamp() - interval '7 days')
				order by worker.state in ('active','blocked') desc, worker.updated_at desc, worker.id limit 16) listed);$new$);
select pg_temp.count_patch('public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure,
	$old$		return jsonb_build_object('schema','qorpera.agent-todos/v1','runId',v_run.id,'todos',coalesce((
			select jsonb_agg(public.qorpera_agent_todo_view(todo) order by todo.updated_at desc, todo.id) from (
				select * from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id
					and (todo.state in ('open','blocked') or coalesce((p_request ->> 'includeClosed')::boolean, false))
				order by todo.updated_at desc, todo.id limit 32) todo), '[]'::jsonb),$old$,
	$new$		-- A page of thirty-two, open todos first; the rest are counted in moreTodos (runtime v95).
		return jsonb_build_object('schema','qorpera.agent-todos/v1','runId',v_run.id,'todos',coalesce((
			select jsonb_agg(public.qorpera_agent_todo_view(todo) order by todo.state in ('open','blocked') desc, todo.updated_at desc, todo.id) from (
				select * from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id
					and (todo.state in ('open','blocked') or coalesce((p_request ->> 'includeClosed')::boolean, false))
				order by todo.state in ('open','blocked') desc, todo.updated_at desc, todo.id limit 32) todo), '[]'::jsonb),
			'moreTodos',greatest((select count(*) from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id
					and (todo.state in ('open','blocked') or coalesce((p_request ->> 'includeClosed')::boolean, false))) - 32, 0),$new$);

-- A chain that already holds the recipient continues with it at the end. For
-- every occurrence admitted before this migration the recipient was not in its
-- parent's chain, so re-deriving its ancestry gives the same result.
select pg_temp.count_patch('public.qorpera_wake_ancestry(uuid,uuid,uuid,uuid)'::regprocedure,
	$old$	if p_recipient is null or p_recipient = any(v_agents) then return null; end if;
	return jsonb_build_object('rootId',v_root,'agentIds',to_jsonb(v_agents || p_recipient));$old$,
	$new$	-- The last agent of the chain is the one whose run caused this wake: its own write never wakes it.
	if p_recipient is null or p_recipient = v_agents[cardinality(v_agents)] then return null; end if;
	return jsonb_build_object('rootId',v_root,'agentIds',to_jsonb(array_remove(v_agents,p_recipient) || p_recipient));$new$);
-- The same for a coworker occurrence admitted before hops were counted (v70).
select pg_temp.count_patch('public.qorpera_coworker_wake_ancestry(public.qorpera_wake_occurrences)'::regprocedure,
	$old$		if p_wake.staff_agent_id = any(v_agents) then return null; end if;
		v_agents := v_agents || p_wake.staff_agent_id;$old$,
	$new$		v_agents := array_remove(v_agents,p_wake.staff_agent_id) || p_wake.staff_agent_id;$new$);

-- Nothing that runs may still hold one of these counts.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and (procedure.prosrc like '%Agent routine limit reached%'
				or procedure.prosrc like '%Too many open todos%'
				or procedure.prosrc like '%workers are already active%'
				or procedure.prosrc like '%at most 40 sections%'
				or procedure.prosrc like '%p_recipient = any(v_agents)%')
	loop
		raise exception 'Function % still holds a removed standing count', v_name;
	end loop;
end
$$;
