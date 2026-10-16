-- @fixture 704_folder_state_connections.test.sql until "-- 1. The company, and the platform writing its first connection file"
-- Company folder core C2, P15 (migration 20260930022000; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md "Plan (P15)"):
-- the follow-up queue's guards. Every patched body carries the slice's marker; the queue's tables and inner functions are
-- no API role's; the service-role kicks refuse anyone else; a commit that archives or retires an agent names its thread
-- session at rank 11; the company row is locked beyond KEY SHARE only by the name copy; the step is scheduled every
-- 2 seconds with a daily cleanup of its run log.

-- 1. The company and one hire ------------------------------------------------------------------------------------------

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit(pg_temp.platform(), 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Guards'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70400000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		pg_temp.hire('nora', '87900000-0000-4000-8000-0000000000a1', 'Nora')));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- 2. Every patched body carries the marker, and the pause reason is the index's --------------------------------------------

do $$
declare v_fn text; v_listener regprocedure;
begin
	foreach v_fn in array array[
		'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)',
		'public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)',
		'public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)',
		'public.qorpera_company_state_routine_resumes(public.qorpera_cloud_routines,jsonb,jsonb,text)',
		'public.qorpera_folder_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,jsonb)',
		'public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)',
		'public.qorpera_folder_company_first_run(uuid,uuid,uuid,uuid)',
		'public.qorpera_folder_company_ready(uuid)',
		'public.qorpera_list_hosted_profiles()',
		'public.qorpera_default_agent_read_on_staff()',
		'public.qorpera_grant_shared_connectors_to_staff()',
		'public.qorpera_revoke_secret_grants_for_inactive_staff()',
		'public.qorpera_agent_thread_on_staff()'] loop
		if position('20260930022000' in pg_get_functiondef(v_fn::regprocedure)) = 0 then
			raise exception '% does not carry P15''s marker', v_fn; end if;
	end loop;
	-- P29's listener, wherever it is installed, marks the agents it sets aside.
	select p.oid::regprocedure into v_listener from pg_proc p
	where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_folder_listen_company';
	if v_listener is not null and (position('20260930022000 (P15)' in pg_get_functiondef(v_listener)) = 0
		or position('qorpera_folder_follow_up_mark_firing' in pg_get_functiondef(v_listener)) = 0) then
		raise exception 'P29''s listener writes no follow-up mark'; end if;
	if position('agent_archived' in (select pg_get_constraintdef(c.oid) from pg_constraint c
		where c.conrelid = 'public.qorpera_cloud_routines'::regclass and c.conname = 'qorpera_cloud_routines_pause_reason_check')) = 0
		or not (select c.convalidated from pg_constraint c where c.conrelid = 'public.qorpera_cloud_routines'::regclass
			and c.conname = 'qorpera_cloud_routines_pause_reason_check') then
		raise exception 'The routine pause reasons lack agent_archived'; end if;
	-- The creation commit queues no turn: the queue does, after the Co-Founder's grant.
	if position('qorpera_queue_agent_first_run' in pg_get_functiondef('public.qorpera_folder_company_first_run(uuid,uuid,uuid,uuid)'::regprocedure)) > 0 then
		raise exception 'The creation commit still queues the Co-Founder''s turn'; end if;
end $$;

-- 3. The queue is the platform's: tables and inner functions belong to no API role; the kicks to the service role --------

do $$
declare v_role text; v_fn text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		if has_table_privilege(v_role, 'public.qorpera_folder_follow_up_marks', 'select,insert,update,delete')
			or has_table_privilege(v_role, 'public.qorpera_folder_follow_ups', 'select,insert,update,delete') then
			raise exception 'The queue''s tables are open to %', v_role; end if;
		foreach v_fn in array array[
			'public.qorpera_folder_converge_agent(uuid,uuid,uuid,boolean)', 'public.qorpera_folder_converge_company(uuid)',
			'public.qorpera_folder_follow_up_take(uuid,text,uuid)', 'public.qorpera_folder_follow_up_converge(public.qorpera_folder_follow_ups)',
			'public.qorpera_folder_follow_up_open(uuid)', 'public.qorpera_folder_follow_up_step()',
			'public.qorpera_folder_follow_up_kick(uuid,text,uuid)', 'public.qorpera_folder_follow_up_mark_firing(uuid,uuid)',
			'public.qorpera_folder_follow_up_sweep()', 'public.qorpera_folder_follow_up_mark_all(uuid)',
			'public.qorpera_schedule_folder_follow_ups()'] loop
			if has_function_privilege(v_role, v_fn, 'execute') then raise exception '% may run %', v_role, v_fn; end if;
		end loop;
	end loop;
	foreach v_fn in array array['public.qorpera_folder_follow_up_now(uuid,text,uuid)',
		'public.qorpera_folder_follow_up_commit(uuid,uuid)', 'public.qorpera_folder_follow_up_status(uuid)'] loop
		if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
			or not has_function_privilege('service_role', v_fn, 'execute') then
			raise exception '% is not the service role''s alone', v_fn; end if;
	end loop;
	if (select relrowsecurity from pg_class where oid = 'public.qorpera_folder_follow_up_marks'::regclass) is not true
		or (select relrowsecurity from pg_class where oid = 'public.qorpera_folder_follow_ups'::regclass) is not true then
		raise exception 'The queue''s tables have no row security'; end if;
	-- No foreign key on either table: nothing that holds the fence waits on them, and the purge never meets them.
	if exists (select 1 from pg_constraint where contype = 'f' and conrelid in ('public.qorpera_folder_follow_up_marks'::regclass,
		'public.qorpera_folder_follow_ups'::regclass)) then
		raise exception 'The queue''s tables have a foreign key'; end if;
end $$;

-- A member's JWT (even granted the function) is refused by the wrappers' own check; bad arguments are 22023.
do $$
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"70400000-0000-4000-8000-000000000001"}', true);
	begin
		perform public.qorpera_folder_follow_up_now('70400000-0000-4000-8000-000000000020', 'agent', '87900000-0000-4000-8000-0000000000a1');
		raise exception 'A member ran the kick' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_folder_follow_up_commit('70400000-0000-4000-8000-000000000020', '87900000-0000-4000-8000-0000000000a1');
		raise exception 'A member ran the commit kick' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_folder_follow_up_status('70400000-0000-4000-8000-000000000020');
		raise exception 'A member read the queue' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	begin
		perform public.qorpera_folder_follow_up_now('70400000-0000-4000-8000-000000000020', 'routine', '87900000-0000-4000-8000-0000000000a1');
		raise exception 'A subject of another kind was kicked' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform public.qorpera_folder_follow_up_commit('70400000-0000-4000-8000-000000000020', null);
		raise exception 'A commit kick without a commit' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
	-- A company that is not folder-v2 (or not there) is closed.
	if public.qorpera_folder_follow_up_now('70400000-0000-4000-8000-000000000021', 'agent', '87900000-0000-4000-8000-0000000000a1')
		->> 'result' is distinct from 'closed' then
		raise exception 'Another core''s company was kicked'; end if;
end $$;

-- 4. An archive and a retire name the agent's thread session at rank 11, after its room ------------------------------------

do $$
declare a1 constant uuid := '87900000-0000-4000-8000-0000000000a1'; t jsonb; v_room uuid; v_session uuid;
begin
	select id, session_id into v_room, v_session from public.qorpera_company_rooms
	where profile_id = '70400000-0000-4000-8000-000000000010' and bound_staff_agent_id = a1;
	if v_room is null or v_session is null then raise exception 'Fixture: Nora has no thread'; end if;
	select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into t
	from public.qorpera_folder_structured_targets('70400000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.write('agents/nora/agent.md', 'agent', pg_temp.agent_text(a1, 'Nora', 'agent', 'archived'),
			pg_temp.agent_parse(a1, 'Nora', 'agent', 'archived'), pg_temp.version('agents/nora/agent.md')))) x;
	if not t @> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', v_room::text, 'mode', 'update'),
			jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', v_session::text, 'mode', 'update')) then
		raise exception 'An archive names its thread session: %', t; end if;
	select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into t
	from public.qorpera_folder_structured_targets('70400000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		jsonb_build_object('op','delete','path','agents/nora','expectedVersion',pg_temp.version('agents/nora'),'asOfSeq',pg_temp.seq()))) x;
	if not t @> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', v_room::text, 'mode', 'update'),
			jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', v_session::text, 'mode', 'update')) then
		raise exception 'A retire names its thread session: %', t; end if;
	-- The commit holds both: its thread trigger closes the thread itself, before any converge.
	perform pg_temp.expect(pg_temp.commit_in('70400000-0000-4000-8000-000000000020', pg_temp.owner(), 'archive-nora',
		jsonb_build_array(pg_temp.write('agents/nora/agent.md', 'agent', pg_temp.agent_text(a1, 'Nora', 'agent', 'archived'),
			pg_temp.agent_parse(a1, 'Nora', 'agent', 'archived'), pg_temp.version('agents/nora/agent.md')))), 1, 'saved');
	if (select status from public.qorpera_shared_sessions where id = v_session) is distinct from 'closed'
		or not exists (select 1 from public.qorpera_folder_follow_up_marks where subject_id = a1) then
		raise exception 'The archive''s commit closes the thread and marks the agent'; end if;
	perform pg_temp.follow_ups('70400000-0000-4000-8000-000000000020');
end $$;

-- The staff triggers leave a folder-v2 agent to the queue: a hire gets no default grant or connector before it, and an
-- archive keeps its connectors and pair conversations until it. Reactivation, rename and restore name the thread too.
create function pg_temp.targets_name_thread(p_units jsonb, p_staff uuid) returns boolean language sql as $$
	select (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
		from public.qorpera_folder_structured_targets('70400000-0000-4000-8000-000000000020', pg_temp.owner(), p_units) x)
		@> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', r.id::text, 'mode', 'update'),
			jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', r.session_id::text, 'mode', 'update'))
	from public.qorpera_company_rooms r where r.profile_id = '70400000-0000-4000-8000-000000000010' and r.bound_staff_agent_id = p_staff
$$;
do $$
declare a1 constant uuid := '87900000-0000-4000-8000-0000000000a1'; a2 constant uuid := '87900000-0000-4000-8000-0000000000a2';
	v_pair uuid;
begin
	perform pg_temp.expect(pg_temp.commit_in('70400000-0000-4000-8000-000000000020', pg_temp.owner(), 'guards-hire-otto',
		jsonb_build_array(pg_temp.hire('otto', a2, 'Otto'))), 1, 'saved');
	if (pg_temp.staff(a2)).employment_status is distinct from 'active'
		or exists (select 1 from public.qorpera_company_path_grants where principal_kind = 'staff_agent' and principal_id = a2)
		or exists (select 1 from public.qorpera_cloud_secret_operation_grants where staff_agent_id = a2) then
		raise exception 'A staff trigger granted a folder-v2 hire before the queue'; end if;
	perform pg_temp.follow_ups('70400000-0000-4000-8000-000000000020');
	if not exists (select 1 from public.qorpera_cloud_secret_operation_grants where staff_agent_id = a2 and status = 'active') then
		raise exception 'Fixture: the queue gave Otto no connectors'; end if;
	v_pair := public.qorpera_agent_pair_session_internal('70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
		'70400000-0000-4000-8000-0000000000c0', a2, '70400000-0000-4000-8000-000000000001');
	perform pg_temp.expect(pg_temp.commit_in('70400000-0000-4000-8000-000000000020', pg_temp.owner(), 'guards-archive-otto',
		jsonb_build_array(pg_temp.write('agents/otto/agent.md', 'agent', pg_temp.agent_text(a2, 'Otto', 'agent', 'archived'),
			pg_temp.agent_parse(a2, 'Otto', 'agent', 'archived'), pg_temp.version('agents/otto/agent.md')))), 1, 'saved');
	if not exists (select 1 from public.qorpera_cloud_secret_operation_grants where staff_agent_id = a2 and status = 'active')
		or (select status from public.qorpera_shared_sessions where id = v_pair) is distinct from 'open' then
		raise exception 'A staff trigger did the archive''s converge'; end if;
	perform pg_temp.follow_ups('70400000-0000-4000-8000-000000000020');
	if exists (select 1 from public.qorpera_cloud_secret_operation_grants where staff_agent_id = a2 and status = 'active')
		or (select status from public.qorpera_shared_sessions where id = v_pair) is distinct from 'closed' then
		raise exception 'The queue did not converge the archive'; end if;
	-- Reactivation, a rename, and a restore of a retired agent name its thread session at rank 11.
	if not pg_temp.targets_name_thread(jsonb_build_array(pg_temp.write('agents/otto/agent.md', 'agent',
		pg_temp.agent_text(a2, 'Otto', 'agent', 'active'), pg_temp.agent_parse(a2, 'Otto', 'agent', 'active'),
		pg_temp.version('agents/otto/agent.md'))), a2) then raise exception 'A reactivation does not name the thread session'; end if;
	if not pg_temp.targets_name_thread(jsonb_build_array(pg_temp.write('agents/otto/agent.md', 'agent',
		pg_temp.agent_text(a2, 'Otto Berg', 'agent', 'archived'), pg_temp.agent_parse(a2, 'Otto Berg', 'agent', 'archived'),
		pg_temp.version('agents/otto/agent.md'))), a2) then raise exception 'A rename does not name the thread session'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'guards-retire-nora', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/nora','expectedVersion',pg_temp.version('agents/nora'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	if not pg_temp.targets_name_thread(jsonb_build_array(pg_temp.hire('nora-back', a1, 'Nora')), a1) then
		raise exception 'A restore does not name the thread session'; end if;
end $$;

-- Marking a whole company (the rebuild's, and the migration's for companies made before it): every agent and the company.
-- An agent with no first run and no member named gets one its owner authors and nobody's login pays for.
do $$
declare a3 constant uuid := '87900000-0000-4000-8000-0000000000a3'; v_marks bigint;
begin
	perform pg_temp.expect(pg_temp.commit_in('70400000-0000-4000-8000-000000000020', pg_temp.owner(), 'guards-hire-uma',
		jsonb_build_array(pg_temp.hire('uma', a3, 'Uma'))), 1, 'saved');
	-- As before this migration: no marks, no work row, no first run.
	delete from public.qorpera_folder_follow_up_marks where environment_id = '70400000-0000-4000-8000-000000000020';
	v_marks := public.qorpera_folder_follow_up_mark_all('70400000-0000-4000-8000-000000000020');
	if v_marks <> (select count(*) + 1 from public.qorpera_profile_staff where profile_id = '70400000-0000-4000-8000-000000000010'
			and folder_environment_id = '70400000-0000-4000-8000-000000000020' and deleted_at is null and folder_erased_at is null)
		or not exists (select 1 from public.qorpera_folder_follow_up_marks where subject_kind = 'company'
			and subject_id = '70400000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_follow_up_marks where environment_id = '70400000-0000-4000-8000-000000000020'
			and (commit_id is not null or by_user_id is not null)) then
		raise exception 'Marking the company: %', v_marks; end if;
	perform pg_temp.follow_ups('70400000-0000-4000-8000-000000000020');
	if (select last_problem from public.qorpera_folder_follow_ups where subject_id = a3) is distinct from 'no_hirer'
		or (select i.author_user_id from public.qorpera_session_inputs i join public.qorpera_agent_first_runs f on f.input_id = i.id
			where f.staff_agent_id = a3) is distinct from '70400000-0000-4000-8000-000000000001'
		or exists (select 1 from public.qorpera_session_turn_requests r join public.qorpera_agent_first_runs f on f.input_id = r.input_id
			where f.staff_agent_id = a3)
		or exists (select 1 from public.qorpera_folder_follow_ups where environment_id = '70400000-0000-4000-8000-000000000020' and dirty) then
		raise exception 'A marked company converges; its unhired agent gets an owner''s kickoff and no turn'; end if;
end $$;

-- 5. Only the name copy locks the company row beyond KEY SHARE (core §3 step 3), and it skips a held row ---------------------

do $$
declare v_fn record;
begin
	for v_fn in select p.oid::regprocedure as fn, pg_get_functiondef(p.oid) as body from pg_proc p
		where p.pronamespace = 'public'::regnamespace
			and (p.proname like 'qorpera_folder_follow_up%' or p.proname like 'qorpera_folder_converge_%')
	loop
		if v_fn.body ~* 'qorpera_profiles[^;]*for (no key )?update' and v_fn.fn <> 'public.qorpera_folder_converge_company(uuid)'::regprocedure then
			raise exception '% locks the company row', v_fn.fn; end if;
	end loop;
	if pg_get_functiondef('public.qorpera_folder_converge_company(uuid)'::regprocedure) !~* 'for no key update skip locked'
		or pg_get_functiondef('public.qorpera_folder_converge_company(uuid)'::regprocedure) ~* 'nowait' then
		raise exception 'The name copy takes the company row FOR NO KEY UPDATE SKIP LOCKED'; end if;
	-- No savepoint around it: the company subject converges outside the block.
	if pg_get_functiondef('public.qorpera_folder_follow_up_converge(public.qorpera_folder_follow_ups)'::regprocedure)
		!~ 'if p_work.subject_kind = ''company'' then\s+v_out := public.qorpera_folder_converge_company' then
		raise exception 'The name copy runs inside the agent''s block'; end if;
end $$;

-- 6. The schedule: the step every 10 seconds (20260930483000), and a daily cleanup of its run log ------------------------

do $$
declare v jsonb; v_command text;
begin
	if to_regnamespace('cron') is null then
		if public.qorpera_schedule_folder_follow_ups() ->> 'scheduled' is distinct from 'false' then
			raise exception 'The queue claimed a schedule without pg_cron'; end if;
		-- A stand-in with pg_cron's schedule-by-name contract (as 753).
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user, unique (jobname, username));
		create table cron.job_run_details(runid bigint generated always as identity primary key, jobid bigint, end_time timestamptz);
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v := public.qorpera_schedule_folder_follow_ups();
	if v ->> 'scheduled' is distinct from 'true' or jsonb_array_length(v -> 'jobs') <> 2
		or public.qorpera_schedule_folder_follow_ups() -> 'jobs' <> v -> 'jobs'
		or (select schedule from cron.job where jobname = 'qorpera-folder-follow-ups') is distinct from '10 seconds'
		or (select schedule from cron.job where jobname = 'qorpera-folder-follow-ups-log') is distinct from '23 3 * * *' then
		raise exception 'The queue is not scheduled once, every 10 seconds, with a daily cleanup: %', v; end if;
	select command into v_command from cron.job where jobname = 'qorpera-folder-follow-ups';
	if v_command is distinct from 'select public.qorpera_folder_follow_up_step()' then raise exception 'The step''s command: %', v_command; end if;
	-- The commands run as the job's owner, with no JWT.
	perform set_config('request.jwt.claims', '', true);
	execute v_command;
	execute (select command from cron.job where jobname = 'qorpera-folder-follow-ups-log');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

rollback;
