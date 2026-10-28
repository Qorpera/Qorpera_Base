-- @fixture 970_memory_branches.test.sql until "-- The checks start here."
-- C5 (20260930508000): every path into the shared context is gated by the run's memory mode, kept until an explicit
-- product decision. On 970's fixture the company chose the beta, so Nora's and Otto's runs were recorded in it; then
-- it goes back to Agent notebooks and Pia's next run is made: a notebook run. 1. Pia's run gets no view, no new log, no
-- tree write and no shared-context tool, and a run made before C5 (no mode) is one too. 2. The beta's runs keep theirs:
-- a run's mode never changes, so a switch takes effect at the run boundary. 3. The tree work no run is bound to: only
-- erasure and retention, which read no mode. 4. Erasure with the beta off: a block of a tree made in the beta still
-- goes, with its rows. Message erasure (960-966) and the prune (964, 965) run on a company that never chose the beta.

-- A run's actor, a run log's commit and an entry's version (as 951), a unit refused (as 951), and a run's own actor (as
-- 947).
create function pg_temp.actor(p_who text) returns jsonb language sql as $$
	select jsonb_build_object('kind','run','runId',b ->> 'runId','jobId',b ->> 'jobId','runnerId',b ->> 'runnerId',
		'assignmentId',b ->> 'assignmentId')
	from (select pg_temp.b(p_who) as b) x
$$;
create function pg_temp.logc(p_who text, p_key text, p_units jsonb, p_path text, p_more jsonb default '{}') returns jsonb
language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', pg_temp.actor(p_who), p_key, p_units,
		jsonb_build_object('runLog', jsonb_build_object('run', pg_temp.run_id(p_who), 'path', p_path)) || p_more)
$$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020'
		and key_text = public.qorpera_folder_key(p_key)
		and kind is distinct from 'claim'
$$;
create function pg_temp.refused(p_result jsonb, p_unit integer, p_reason text, p_message text, p_code text default 'value',
	p_line integer default null)
returns void language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from 'refused' or v ->> 'reason' is distinct from p_reason
		or jsonb_array_length(v -> 'problems') is distinct from 1 or v -> 'problems' -> 0 ->> 'code' is distinct from p_code
		or v -> 'problems' -> 0 ->> 'message' is distinct from p_message
		or (v -> 'problems' -> 0 ->> 'line')::integer is distinct from p_line then
		raise exception 'Unit % expected % (%, line %: %), got %', p_unit, p_reason, p_code, p_line, p_message, p_result
			using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.writer_actor(p_who text) returns jsonb language sql as $$
	select public.qorpera_folder_tool_run(pg_temp.b(p_who), '[]'::jsonb) -> 'actor'
$$;
-- A run's write to its own conversation's tree (no run log): the root's mkdir at the conversation's generation.
create function pg_temp.tree_root(p_who text, p_key text) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', pg_temp.writer_actor(p_who), p_key,
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'qorperaos/agents/' || p_who || '/memory/thread')),
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', pg_temp.thread(p_who),
			'generation', (select memory_generation from public.qorpera_shared_sessions where id = pg_temp.thread(p_who))))))
$$;
-- A shared-context tool refused for a notebook run, with its exact answer.
create function pg_temp.no_context(p_sql text) returns void language plpgsql as $$
declare v_state text; v_message text;
begin
	begin
		execute p_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
	end;
	if v_state is distinct from '42501' or v_message is distinct from 'A notebook run has no shared context' then
		raise exception 'Expected the notebook refusal from %, got %: %', p_sql, v_state, v_message using errcode = 'QTF03'; end if;
end $$;
-- Pia's run as if it was made in another mode (a run's mode never changes): with triggers off.
create function pg_temp.pia_mode(p_mode text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set memory_mode = p_mode where id = pg_temp.run_id('pia');
	set local session_replication_role = origin;
end $$;

-- The company goes back to Agent notebooks, and Pia's next run is a notebook run. Nora's and Otto's keep the beta.
update public.qorpera_company_memory_modes set mode = 'notebooks' where profile_id = '63400000-0000-4000-8000-000000000010';
do $$
declare x jsonb;
begin
	if public.qorpera_company_memory_mode_effective('63400000-0000-4000-8000-000000000010') is distinct from 'notebooks' then
		raise exception 'The company is back on Agent notebooks'; end if;
	x := pg_temp.agent_run(pg_temp.id('pia'));
	perform set_config('qorpera_test.binding_pia', (x -> 'binding')::text, true);
	perform set_config('qorpera_test.run_pia', x -> 'actor' ->> 'runId', true);
	if (select session_id from public.qorpera_execution_runs where id = pg_temp.run_id('pia')) is distinct from pg_temp.thread('pia') then
		raise exception 'Pia''s run is in her thread'; end if;
	perform pg_temp.same((select jsonb_object_agg(w, r.memory_mode) from unnest(array['nora', 'otto', 'pia']) w
		join public.qorpera_execution_runs r on r.id = pg_temp.run_id(w)),
		'{"nora":"tree","otto":"tree","pia":"notebooks"}', 'Each run''s mode');
end $$;

-- 1. A notebook run gets no view, no new log (whoever writes it), no tree write and no shared-context tool; a run made
--    before C5 (no mode) is a notebook run too. Nothing is written.
do $$
declare env constant uuid := '63400000-0000-4000-8000-000000000020'; pia constant uuid := pg_temp.run_id('pia');
	root constant text := 'qorperaos/agents/pia/memory/thread'; v_mode text; v_name text; r jsonb;
begin
	foreach v_mode in array array['notebooks', null] loop
		perform pg_temp.pia_mode(v_mode);
		if public.qorpera_memory_view(pg_temp.b('pia')) is not null or public.qorpera_memory_view_of(pia) is not null then
			raise exception 'A notebook run (%) has no view', coalesce(v_mode, 'no mode'); end if;
		perform pg_temp.same(public.qorpera_memory_run_log_place(env, pia), '{"off":true}', 'A notebook run''s log is off');
		foreach v_name in array array['qorpera_memory_branches', 'qorpera_memory_zoom', 'qorpera_memory_release',
			'qorpera_memory_view_record', 'qorpera_memory_events_run'] loop
			perform pg_temp.no_context(format('select public.%I(%L, %L)', v_name, pg_temp.b('pia'), '{}'));
		end loop;
		perform pg_temp.same(to_jsonb(public.qorpera_memory_view_reference_check_run(pg_temp.b('pia'), '{}')),
			'"a notebook run has no shared context"', 'A notebook run''s view reference');
		r := pg_temp.logc('pia', 'c5-pia-log', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root),
			jsonb_build_object('op', 'mkdir', 'path', root || '/runs')), root || '/runs/' || pia);
		perform pg_temp.refused(r, 1, 'structured_rule', 'a notebook run keeps no run log');
		r := public.qorpera_folder_memory_commit(env, '{"kind":"platform"}', 'c5-pia-log-platform',
			jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root)),
			jsonb_build_object('runLog', jsonb_build_object('run', pia, 'path', root || '/runs/' || pia)));
		perform pg_temp.refused(r, 1, 'structured_rule', 'a notebook run keeps no run log');
		r := pg_temp.tree_root('pia', 'c5-pia-tree');
		perform pg_temp.refused(r, 1, 'structured_rule', 'a notebook run writes no conversation tree');
	end loop;
	perform pg_temp.pia_mode('notebooks');
	if pg_temp.version(root) is not null or exists (select 1 from public.qorpera_memory_run_logs where run_id = pia)
		or exists (select 1 from public.qorpera_memory_trees where session_id = pg_temp.thread('pia')) then
		raise exception 'A notebook run wrote nothing'; end if;
end $$;

-- 2. The beta's runs keep theirs after the switch: their views, tools, logs and tree writes.
do $$
declare env constant uuid := '63400000-0000-4000-8000-000000000020'; otto constant uuid := pg_temp.run_id('otto');
	root constant text := 'QorperaOS/agents/otto/memory/thread'; v_who text;
begin
	foreach v_who in array array['nora', 'otto'] loop
		if public.qorpera_memory_view(pg_temp.b(v_who)) is null then raise exception '%''s beta run has its view', v_who; end if;
		if pg_temp.branches(v_who) is null then raise exception '%''s beta run lists its branches', v_who; end if;
	end loop;
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, otto) -> 'path', to_jsonb(root || '/runs/' || otto),
		'A beta run''s log is placed in its tree');
	perform pg_temp.expect(pg_temp.logc('otto', 'c5-otto-log', jsonb_build_array(jsonb_build_object('op', 'mkdir',
		'path', root || '/runs')), root || '/runs/' || otto), 1, 'saved');
	perform pg_temp.expect(pg_temp.tree_root('nora', 'c5-nora-tree'), 1, 'saved');
end $$;

-- 3. The tree work no run is bound to. Every memory call a run's host makes is gated by the run's mode or has nothing
--    to gate: the compaction record only counts compactor calls (a notebook run makes none); the step hashes and the
--    narrow step only serve a log a run already writes; a resume needs a live log, or reads a notebook run's own
--    receipts (it has no log, 20260930539000: cut off, it resumes from them; at its usage limit, it fails). Nothing
--    folds or composes outside a run: the only tree crons are the prune's, and erasure and retention read no mode, so
--    they run in either.
do $$
declare v_got text[]; v_name text; v_jobs text[];
begin
	select array_agg(x.name order by x.name collate "C") into v_got
	from (select distinct name::text as name from public.qorpera_native_host_calls where name like 'qorpera\_memory\_%') x;
	if v_got is distinct from array['qorpera_memory_branches', 'qorpera_memory_compaction_record', 'qorpera_memory_events_run',
		'qorpera_memory_release', 'qorpera_memory_run_log_place', 'qorpera_memory_run_resume', 'qorpera_memory_run_resume_receipts',
		'qorpera_memory_run_resume_record', 'qorpera_memory_step_hashes', 'qorpera_memory_step_narrow', 'qorpera_memory_view',
		'qorpera_memory_view_record', 'qorpera_memory_view_reference_check_run', 'qorpera_memory_zoom'] then
		raise exception 'The memory host calls changed: %', v_got; end if;
	foreach v_name in array array['qorpera_memory_branches', 'qorpera_memory_events_run', 'qorpera_memory_release',
		'qorpera_memory_run_log_place', 'qorpera_memory_view_record', 'qorpera_memory_view_reference_check_run',
		'qorpera_memory_zoom', 'qorpera_memory_view_of', 'qorpera_memory_run_log_paths', 'qorpera_memory_run_tree_problem'] loop
		if not (select bool_and(strpos(prosrc, '20260930508000') > 0) from pg_proc
			where pronamespace = 'public'::regnamespace and proname = v_name) then
			raise exception 'The gate is missing in %', v_name; end if;
	end loop;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_memory_view(jsonb)'::regprocedure),
		'qorpera_memory_view_of(') = 0 then raise exception 'The view is the gated view_of''s'; end if;
	-- Who reads a run's mode: the gates, the run row's trigger, the company's read and the receipts resume's check.
	select array_agg(proname::text order by proname::text collate "C") into v_got from pg_proc
	where pronamespace = 'public'::regnamespace and prosrc ~ '\mmemory_mode\M';
	if v_got is distinct from array['qorpera_company_memory_mode', 'qorpera_memory_branches', 'qorpera_memory_events_run',
		'qorpera_memory_release', 'qorpera_memory_run_log_paths', 'qorpera_memory_run_log_place',
		'qorpera_memory_run_tree_problem', 'qorpera_memory_view_of', 'qorpera_memory_view_record',
		'qorpera_memory_view_reference_check_run', 'qorpera_memory_zoom', 'qorpera_pin_execution_memory_mode',
		'qorpera_run_resumes_from_receipts'] then
		raise exception 'The mode''s readers changed: %', v_got; end if;
	-- The crons: only the prune's (where pg_cron is installed), and only its schedule names memory.
	if to_regclass('cron.job') is not null then
		execute 'select array_agg(jobname::text) from cron.job where jobname ~* ''memory|tree'' or command ~* ''memory|tree'''
			into v_jobs;
		if not coalesce(v_jobs, '{}') <@ array['qorpera-memory-tree-prune', 'qorpera-memory-tree-prune-log'] then
			raise exception 'A tree cron other than the prune: %', v_jobs; end if;
	end if;
	select array_agg(proname::text order by proname::text collate "C") into v_got from pg_proc
	where pronamespace = 'public'::regnamespace and proname like 'qorpera\_schedule\_%' and prosrc ~* 'memory|tree';
	if v_got is distinct from array['qorpera_schedule_memory_tree_prune'] then
		raise exception 'A tree schedule other than the prune: %', v_got; end if;
	-- Erasure and retention read no mode and no offer.
	select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text collate "C") into v_got from pg_proc p
	where p.pronamespace = 'public'::regnamespace and (p.proname like 'qorpera\_memory\_message\_erase%'
		or p.proname in ('qorpera_memory_tree_prune', 'qorpera_schedule_memory_tree_prune', 'qorpera_memory_tree_version_held',
			'qorpera_memory_tree_deleted', 'qorpera_memory_run_log_deleted'))
		and (p.prosrc ~ '\mmemory_mode\M' or p.prosrc ~ 'qorpera_company_memory_|qorpera_memory_tree_companies');
	if v_got is not null then raise exception 'Erasure or retention reads the memory mode: %', v_got; end if;
	foreach v_name in array array['public.qorpera_memory_tree_prune(integer)', 'public.qorpera_schedule_memory_tree_prune()',
		'public.qorpera_memory_tree_deleted(uuid,uuid,text)', 'public.qorpera_memory_run_log_deleted(uuid,uuid,text)',
		'public.qorpera_memory_message_erase_open(uuid,uuid)', 'public.qorpera_memory_message_erase_rewrite(uuid,uuid,text,jsonb)',
		'public.qorpera_memory_message_erase_scrub(uuid,uuid)'] loop
		if to_regprocedure(v_name) is null then raise exception 'Erasure or retention lost %', v_name; end if;
	end loop;
	-- The next activation's check for 20260928549230 reads the test list's comment (#1273 review r1).
	if coalesce(obj_description(to_regclass('public.qorpera_memory_tree_companies'), 'pg_class'), '') not like '%group chat%' then
		raise exception 'The test list''s comment lost the activation''s marker for 20260928549230'; end if;
end $$;

-- 4. Erasure with the beta off (the company off the test list, no choice left): the platform deletes a block of Otto's
--    tree, made in the beta, and its rows go with it.
delete from public.qorpera_company_memory_modes where profile_id = '63400000-0000-4000-8000-000000000010';
delete from public.qorpera_memory_tree_companies where profile_id = '63400000-0000-4000-8000-000000000010';
do $$
declare root constant text := 'qorperaos/agents/otto/memory/thread'; s uuid := pg_temp.thread('otto'); r jsonb;
begin
	if public.qorpera_company_memory_mode_effective('63400000-0000-4000-8000-000000000010') is distinct from 'notebooks'
		or public.qorpera_company_memory_beta_offered('63400000-0000-4000-8000-000000000010') then
		raise exception 'The company is off the beta'; end if;
	if not exists (select 1 from public.qorpera_memory_tree_nodes where session_id = s) then
		raise exception 'Otto''s tree has its line'; end if;
	r := pg_temp.memory('c5-erase-block', jsonb_build_array(jsonb_build_object('op', 'delete', 'path', root || '/t0/00000000.jsonl',
		'expectedVersion', pg_temp.version(root || '/t0/00000000.jsonl'))), s);
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.version(root || '/t0/00000000.jsonl') is not null
		or exists (select 1 from public.qorpera_memory_tree_nodes where session_id = s) then
		raise exception 'The block and its rows are gone: %', r; end if;
end $$;

rollback;
