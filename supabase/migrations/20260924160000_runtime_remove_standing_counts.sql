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
-- Worker reports are still handed back four at a time; each later pass takes
-- the next four, so a batch of any size is delivered in full.

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
