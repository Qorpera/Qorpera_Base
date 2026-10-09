-- @fixture 993_memory_worker_view_reference.test.sql until "-- 1. The check's answers"
-- Context tree W4a-2 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §12, §14 W4): the parent step a dispatch or a
-- follow-up names is that call's own step in the sending run's log. manage_worker names the step with its call id
-- (`parentCall`); qorpera_folder_worker_commit takes them only as a pair, and only for a pending manage_worker step with
-- that call id in the sending run's live log. 993's fixture leaves Ada's run with an open todo, plan-the-trip, that has
-- no folder yet, and Ben's run with his own todo, ben-only. Their log rows are made by hand (993's w4_step).

-- A dispatch of a new worker under one of the run's todos, named by its key, under the review of the call.
create function pg_temp.w5_dispatch(p_run jsonb, p_name text, p_extra jsonb, p_call text,
	p_todo text default 'agents/ada/todos/plan-the-trip') returns jsonb language plpgsql as $$
declare f text := p_todo || '/' || p_name; b jsonb := pg_temp.brief(md5(p_name)::uuid);
	u jsonb := pg_temp.dispatch_units(p_run -> 'actor', f, b);
begin
	return pg_temp.wc(p_run -> 'actor', 'w5-dispatch-' || p_name, u, pg_temp.dispatch_request(f, b) || p_extra,
		pg_temp.reviewed(p_run, p_call, u));
end $$;
-- The same dispatch, which must stop at the parent step's check (under a review of its own, which goes with it).
create function pg_temp.w5_refused(p_run jsonb, p_name text, p_extra jsonb, p_todo text default 'agents/ada/todos/plan-the-trip')
returns void language sql as $$
	select pg_temp.raises_like(format('select pg_temp.w5_dispatch(%L, %L, %L, %L, %L)', p_run, p_name, p_extra, 'w5-review-' || p_name,
		p_todo), '22023', 'The parent step is not this call''s pending step%')
$$;
create function pg_temp.w5_parent(p_name text, p_sequence integer default 1) returns public.qorpera_runtime_worker_parents
language sql as $$
	select * from public.qorpera_runtime_worker_parents where worker_id = md5(p_name)::uuid and sequence = p_sequence
$$;
-- Every step row, to show a commit leaves them as they were.
create function pg_temp.w5_steps() returns jsonb language sql as $$
	select coalesce(jsonb_agg(to_jsonb(s) order by s.run_id, s.j), '[]') from public.qorpera_memory_run_steps s
$$;

-- 1. A pending manage_worker step with its call id: the dispatch lands and the row keeps the step ------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; ben jsonb := current_setting('qorpera_test.ben')::jsonb;
	r jsonb; w public.qorpera_runtime_worker_parents%rowtype; before jsonb;
begin
	perform pg_temp.w4_step(ada, 20, 'w5-call-0020');
	perform pg_temp.w4_step(ada, 0, repeat('c', 256));
	perform pg_temp.w4_step(ada, 21, 'w5-call-0021', p_narrow => true);
	before := pg_temp.w5_steps();
	r := pg_temp.w5_dispatch(ada, 'one', '{"parentStep":20,"parentCall":"w5-call-0020"}', 'w5-call-0020');
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	w := pg_temp.w5_parent('one');
	if w.parent_run_id is distinct from (ada -> 'actor' ->> 'runId')::uuid or w.parent_step is distinct from 20
		or w.parent_view is not null then
		raise exception 'The dispatch''s parent: %', to_jsonb(w); end if;
	-- Step 0, with a call id of 256 characters.
	perform pg_temp.expect(pg_temp.w5_dispatch(ada, 'zero', jsonb_build_object('parentStep', 0, 'parentCall', repeat('c', 256)),
		'w5-call-0000'), 1, 'saved');
	if (pg_temp.w5_parent('zero')).parent_step is distinct from 0 then raise exception 'Step 0 was not kept'; end if;
	-- A narrow step keeps its tool and call (§7.6), so it is named as any other.
	perform pg_temp.expect(pg_temp.w5_dispatch(ada, 'narrow', '{"parentStep":21,"parentCall":"w5-call-0021"}', 'w5-call-0021'),
		1, 'saved');
	if (pg_temp.w5_parent('narrow')).parent_step is distinct from 21 then raise exception 'The narrow step was not kept'; end if;
	-- A run that writes its log may still name no step: no row, as before.
	perform pg_temp.expect(pg_temp.w5_dispatch(ada, 'plain', '{}', 'w5-call-0030'), 1, 'saved');
	if exists (select 1 from public.qorpera_runtime_worker_parents where worker_id = md5('plain')::uuid) then
		raise exception 'A dispatch that named no step kept a parent'; end if;
	-- The steps stay as they were: the call returns later, and its line is finished then.
	if pg_temp.w5_steps() is distinct from before then raise exception 'A dispatch changed the log''s steps'; end if;
	-- Ben's run has no log: refused. Once his step is in his log, the same dispatch lands.
	perform pg_temp.w5_refused(ben, 'scout', '{"parentStep":4,"parentCall":"w5-call-ben4"}', 'agents/ben/todos/ben-only');
	perform pg_temp.w4_step(ben, 4, 'w5-call-ben4', p_tree => 'agents/ben/memory/thread');
	r := pg_temp.w5_dispatch(ben, 'scout', '{"parentStep":4,"parentCall":"w5-call-ben4"}', 'w5-call-ben4', 'agents/ben/todos/ben-only');
	-- (840 may have made Ben's todo folder already: the last unit is the worker's.)
	perform pg_temp.expect(r, jsonb_array_length(r -> 'units'), 'saved');
	if (pg_temp.w5_parent('scout')).parent_run_id is distinct from (ben -> 'actor' ->> 'runId')::uuid
		or (pg_temp.w5_parent('scout')).parent_step is distinct from 4 then
		raise exception 'Ben''s dispatch''s parent: %', to_jsonb(pg_temp.w5_parent('scout')); end if;
end $$;

-- 2. Any other step: refused before the commit, and nothing changes ------------------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; ben jsonb := current_setting('qorpera_test.ben')::jsonb;
	before jsonb; seq bigint; e text;
begin
	perform pg_temp.w4_step(ada, 22, 'w5-call-0022', p_finished => true);
	-- A line W1b parses as erased is also finished; a row erased alone is refused as well.
	perform pg_temp.w4_step(ada, 23, 'w5-call-0023', p_finished => true, p_erased => true);
	perform pg_temp.w4_step(ada, 24, 'w5-call-0024', p_erased => true);
	perform pg_temp.w4_step(ada, 25, 'w5-call-0025', 'read_file');
	perform pg_temp.w4_step(ada, 26, 'w5-call-0026');
	perform pg_temp.w4_step(ada, 27, 'w5-call-0027');
	before := pg_temp.w5_steps();
	seq := (select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020');
	-- No step at that index; a finished one; an erased one; another tool's.
	perform pg_temp.w5_refused(ada, 'missing', '{"parentStep":99,"parentCall":"w5-call-0099"}');
	perform pg_temp.w5_refused(ada, 'finished', '{"parentStep":22,"parentCall":"w5-call-0022"}');
	perform pg_temp.w5_refused(ada, 'erased', '{"parentStep":23,"parentCall":"w5-call-0023"}');
	perform pg_temp.w5_refused(ada, 'erased-only', '{"parentStep":24,"parentCall":"w5-call-0024"}');
	perform pg_temp.w5_refused(ada, 'other-tool', '{"parentStep":25,"parentCall":"w5-call-0025"}');
	-- A pending step with another call id: another call's, or this one's in another case.
	perform pg_temp.w5_refused(ada, 'other-call', '{"parentStep":20,"parentCall":"w5-call-0021"}');
	perform pg_temp.w5_refused(ada, 'other-case', '{"parentStep":20,"parentCall":"W5-CALL-0020"}');
	-- Ben's pending step, named by Ada's run.
	perform pg_temp.w5_refused(ada, 'other-run', '{"parentStep":4,"parentCall":"w5-call-ben4"}');
	-- A retired log; Ada's log and steps in another company.
	perform pg_temp.fx(format('update public.qorpera_memory_run_logs set retired_at = clock_timestamp() where run_id = %L',
		ada -> 'actor' ->> 'runId'));
	perform pg_temp.w5_refused(ada, 'again', '{"parentStep":26,"parentCall":"w5-call-0026"}');
	perform pg_temp.fx(format('update public.qorpera_memory_run_logs set retired_at = null where run_id = %L',
		ada -> 'actor' ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_memory_run_logs set environment_id = %L where run_id = %L',
		'63400000-0000-4000-8000-0000000000ff', ada -> 'actor' ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_memory_run_steps set environment_id = %L where run_id = %L',
		'63400000-0000-4000-8000-0000000000ff', ada -> 'actor' ->> 'runId'));
	perform pg_temp.w5_refused(ada, 'home', '{"parentStep":27,"parentCall":"w5-call-0027"}');
	perform pg_temp.fx(format('update public.qorpera_memory_run_logs set environment_id = %L where run_id = %L',
		'63400000-0000-4000-8000-000000000020', ada -> 'actor' ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_memory_run_steps set environment_id = %L where run_id = %L',
		'63400000-0000-4000-8000-000000000020', ada -> 'actor' ->> 'runId'));
	-- Nothing of a refused dispatch is kept: no commit, worker or parent row, and the steps are as they were.
	if (select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020') <> seq then
		raise exception 'A refused dispatch moved the folder clock'; end if;
	foreach e in array array['missing','finished','erased','erased-only','other-tool','other-call','other-case','other-run','again',
			'home'] loop
		if exists (select 1 from public.qorpera_runtime_workers where id = md5(e)::uuid)
			or exists (select 1 from public.qorpera_runtime_worker_parents where worker_id = md5(e)::uuid) then
			raise exception 'A refused dispatch (%) kept a worker', e; end if;
	end loop;
	if pg_temp.w5_steps() is distinct from before then raise exception 'A refused dispatch changed the log''s steps'; end if;
	-- The log live again and in its company: the same dispatches land.
	perform pg_temp.expect(pg_temp.w5_dispatch(ada, 'again', '{"parentStep":26,"parentCall":"w5-call-0026"}', 'w5-call-0026'),
		1, 'saved');
	perform pg_temp.expect(pg_temp.w5_dispatch(ada, 'home', '{"parentStep":27,"parentCall":"w5-call-0027"}', 'w5-call-0027'),
		1, 'saved');
	if (pg_temp.w5_parent('again')).parent_step is distinct from 26 or (pg_temp.w5_parent('home')).parent_step is distinct from 27 then
		raise exception 'The dispatches after the refusals kept other steps'; end if;
end $$;

-- 3. A follow-up names its own step the same way ------------------------------------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; f text := 'agents/ada/todos/plan-the-trip/one';
	x jsonb := pg_temp.worker_run(ada, md5('one')::uuid); base jsonb; next jsonb; u jsonb; q jsonb; r jsonb;
	w public.qorpera_runtime_worker_parents%rowtype;
begin
	perform pg_temp.expect(pg_temp.wc(x -> 'actor', 'w5-report-0001', jsonb_build_array(pg_temp.f2_write(x -> 'actor', f || '/results.md',
		pg_temp.results('blocked'))), jsonb_build_object('action','report','folder',f)), 1, 'saved');
	perform pg_temp.w4_step(ada, 28, 'w5-call-0028', p_finished => true);
	perform pg_temp.w4_step(ada, 29, 'w5-call-0029');
	base := (select pv.structured -> 'parse' from public.qorpera_folder_path_versions pv where pv.version = pg_temp.f2_version(f || '/brief.md'));
	next := base || jsonb_build_object('followUps', 1, 'followedUpAt', to_char(clock_timestamp() at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Look again.');
	u := jsonb_build_array(pg_temp.f2_write(ada -> 'actor', f || '/brief.md', next),
		jsonb_build_object('op','delete','path',f || '/results.md','expectedVersion',pg_temp.f2_version(f || '/results.md')));
	q := jsonb_build_object('action','followup','folder',f,'text','Look again.','resultsVersion',pg_temp.f2_version(f || '/results.md'));
	-- A finished step: refused, and the worker still waits on its report.
	perform pg_temp.raises_like(format('select pg_temp.wc(%L, %L, %L, %L, pg_temp.reviewed(%L, %L, %L))', ada -> 'actor',
		'w5-followup-0001', u, q || '{"parentStep":28,"parentCall":"w5-call-0028"}', ada, 'w5-call-0028', u),
		'22023', 'The parent step is not this call''s pending step%');
	if (pg_temp.worker_row(f)).sequence is distinct from 1 or pg_temp.f2_version(f || '/results.md') is null
		or (pg_temp.w5_parent('one', 2)).worker_id is not null then
		raise exception 'A refused follow-up changed the worker'; end if;
	-- Its own pending step: the follow-up lands and the row keeps the step for sequence 2.
	r := pg_temp.wc(ada -> 'actor', 'w5-followup-0002', u, q || '{"parentStep":29,"parentCall":"w5-call-0029"}',
		pg_temp.reviewed(ada, 'w5-call-0029', u));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	w := pg_temp.w5_parent('one', 2);
	if w.parent_run_id is distinct from (ada -> 'actor' ->> 'runId')::uuid or w.parent_step is distinct from 29
		or (pg_temp.worker_row(f)).sequence is distinct from 2 or (pg_temp.w5_parent('one')).parent_step is distinct from 20 then
		raise exception 'The follow-up''s parent: %', to_jsonb(w); end if;
end $$;

-- 4. The request: the step's call id comes with the step and only with it; it is a call id as a step line's is --------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; p jsonb := ada -> 'actor';
	f text := 'agents/ada/todos/plan-the-trip/shape'; b jsonb := pg_temp.brief(md5('shape')::uuid);
	u jsonb := pg_temp.dispatch_units(p, f, b); q jsonb := pg_temp.dispatch_request(f, b);
	fu jsonb := jsonb_build_object('action','followup','folder','agents/ada/todos/plan-the-trip/one','text','More.','resultsVersion',null);
	s jsonb := '{"parentStep":20}'; x jsonb; i integer := 0;
begin
	foreach x in array array[
		-- One without the other.
		q || '{"parentCall":"w5-call-0020"}'::jsonb, q || s, fu || '{"parentCall":"w5-call-0020"}'::jsonb, fu || s,
		q || jsonb_build_object('parentCall', 'w5-call-0020', 'view', pg_temp.w4_view(current_setting('qorpera_test.w4_seq')::bigint, 0,
			jsonb_build_array(pg_temp.w4_block(1)))),
		-- Not a call id: a number, null, an array, an object, empty, 257 characters, a control character.
		q || s || '{"parentCall":20}'::jsonb, q || s || '{"parentCall":null}'::jsonb, q || s || '{"parentCall":["w5-call-0020"]}'::jsonb,
		q || s || '{"parentCall":{}}'::jsonb, q || s || '{"parentCall":""}'::jsonb, q || s || jsonb_build_object('parentCall', repeat('c', 257)),
		q || s || jsonb_build_object('parentCall', 'w5-call' || chr(1)), q || s || jsonb_build_object('parentCall', 'w5-call' || chr(31)),
		q || s || jsonb_build_object('parentCall', 'w5-call' || chr(127)), q || s || jsonb_build_object('parentCall', 'w5-call' || chr(133)),
		q || s || jsonb_build_object('parentCall', 'w5-call' || chr(159)), q || s || jsonb_build_object('parentCall', E'w5-call\n0020'),
		fu || s || '{"parentCall":""}'::jsonb,
		-- Only a dispatch or a follow-up names a step.
		jsonb_build_object('action','decide','folder','agents/ada/todos/plan-the-trip/one','decision','accepted','note',null,
			'parentCall','w5-call-0020'),
		jsonb_build_object('action','report','folder','agents/ada/todos/plan-the-trip/one','parentCall','w5-call-0020')
	] loop
		i := i + 1;
		perform pg_temp.raises_like(format('select pg_temp.wc(%L, %L, %L, %L)', p, 'w5-bad-' || lpad(i::text, 4, '0'), u, x), '22023',
			'Worker request is invalid');
	end loop;
	-- The last character before the excluded ranges, and the first after: a call id.
	perform pg_temp.w4_step(ada, 30, 'w5-call ' || chr(160) || '~');
	perform pg_temp.expect(pg_temp.w5_dispatch(ada, 'shape', jsonb_build_object('parentStep', 30, 'parentCall', 'w5-call ' || chr(160) || '~'),
		'w5-call-0031'), 1, 'saved');
end $$;

-- 5. Every refused request kept nothing; the deploy guard's markers ---------------------------------------------------------
do $$
begin
	if (select count(*) from public.qorpera_runtime_worker_parents
			where worker_id in (select md5(n)::uuid from unnest(array['one','zero','narrow','scout','again','home','shape']) n))
			<> 8 then
		raise exception 'The kept parents: %', (select jsonb_agg(to_jsonb(w)) from public.qorpera_runtime_worker_parents w); end if;
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure),
			'20260930271000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure),
			'20260930171000') = 0 then
		raise exception 'The worker commit lost a marker'; end if;
end $$;
