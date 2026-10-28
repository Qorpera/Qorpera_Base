-- @fixture 970_memory_branches.test.sql until "-- The checks start here."
-- Summary trees M1b-4a (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §5.3, §13; 20260930204000): the primary view and
-- its record, native host calls. The gate (a beta run, a conversation of the run's environment); T, the included
-- events before the inputs that woke the run (the run's own, or those its wake names, as a room post's), or up to the
-- transcript start with no such event; the tree. A record per step of an attempt, with the folder clock as the view
-- reference's asOfSeq: replays, a different request, a new attempt, malformed requests; the run check first; the grants
-- and the call list. On 970's fixture: Nora's thread has a message at 10 and a card at 11, Otto's tree one line.

-- A view call by Nora's or Otto's run, a record call, and a record request.
create function pg_temp.view(p_who text) returns jsonb language sql as $$
	select public.qorpera_memory_view(pg_temp.b(p_who))
$$;
create function pg_temp.record_view(p_who text, p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_memory_view_record(pg_temp.b(p_who), p_request)
$$;
create function pg_temp.request(p_step integer, p_placeholders integer default 1) returns jsonb language sql as $$
	select jsonb_build_object('step', p_step, 'messages', 1, 'headBytes', 2048, 'viewBytes', 512, 'branchesBytes', 128,
		'runViewBytes', 0, 'rawSteps', 0, 'placeholders', p_placeholders, 'waitMs', 40, 'waitedLines', 1, 'folded', false,
		'stablePrefixSha256', repeat('ab', 32))
$$;
-- The id of the fixture's event at a sequence number.
create function pg_temp.event_id(p_seq bigint) returns uuid language sql immutable as $$
	select ('97000000-0000-4000-8000-e' || lpad(p_seq::text, 11, '0'))::uuid
$$;
-- T and the last sequence of Nora's view, past the run check (which refuses a wake that names other inputs than its
-- run, so a room post's are tried on Nora's run).
create function pg_temp.t(p_who text default 'nora') returns jsonb language sql as $$
	select jsonb_build_array(v -> 'messages', v -> 'lastSequence')
	from (select public.qorpera_memory_view_of(pg_temp.run_id(p_who)) as v) x
$$;

-- 1. The gate: a run recorded in the beta (C5), a conversation of the run's environment -------------------------------

do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora uuid := pg_temp.thread('nora'); mode text;
begin
	-- A notebook run has no view, nor has a run made before C5 (no mode): the run's mode decides, not the company's choice.
	foreach mode in array array['notebooks', null] loop
		perform pg_temp.fx(format('update public.qorpera_execution_runs set memory_mode = %L where id = %L', mode, pg_temp.run_id('nora')));
		perform pg_temp.same(pg_temp.view('nora'), null, format('A run in mode %s', coalesce(mode, 'none')));
	end loop;
	perform pg_temp.fx(format('update public.qorpera_execution_runs set memory_mode = %L where id = %L', 'tree', pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.view('nora'), jsonb_build_object('schema', 'qorpera.memory-view/v1',
		'conversation', jsonb_build_object('sessionId', nora, 'kind', 'thread', 'name', 'Nora'), 'messages', 0, 'lastSequence', null,
		'tree', public.qorpera_memory_tree_read(env, nora)), 'A beta run: Nora''s view, at transcript start 0');
	perform pg_temp.same(pg_temp.view('nora') #> '{tree,root}', 'null', 'No tree yet');

	-- A conversation of another environment has no view; the run check refuses it first.
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set environment_id = %L where id = %L', extensions.gen_random_uuid(),
		nora));
	perform pg_temp.same(public.qorpera_memory_view_of(pg_temp.run_id('nora')), null, 'Another environment''s conversation');
	perform pg_temp.raises(format('select public.qorpera_memory_view(%L)', pg_temp.b('nora')), '42501');
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set environment_id = %L where id = %L', env, nora));

	-- Otto's view holds his tree, with its line past T.
	perform pg_temp.same(pg_temp.view('otto') - 'tree', jsonb_build_object('schema', 'qorpera.memory-view/v1',
		'conversation', jsonb_build_object('sessionId', pg_temp.thread('otto'), 'kind', 'thread', 'name', 'Otto'), 'messages', 0,
		'lastSequence', null), 'Otto''s view');
	perform pg_temp.same(pg_temp.view('otto') -> 'tree', public.qorpera_memory_tree_read(env, pg_temp.thread('otto')), 'Otto''s tree');
	perform pg_temp.same(jsonb_build_array(pg_temp.view('otto') #> '{tree,root}', jsonb_array_length(pg_temp.view('otto') #> '{tree,lines}')),
		'["QorperaOS/agents/otto/memory/thread", 1]', 'Otto''s tree has its line');
end $$;

-- 2. T: the included events before the inputs that woke the run; with none of them in the transcript, those up to the
-- transcript start. A session_info (not an included event) is never counted -------------------------------------------

do $$
declare
	nora uuid := pg_temp.thread('nora'); wake jsonb := (select payload from public.qorpera_wake_occurrences where run_id = pg_temp.run_id('nora'));
	input uuid := (select input_ids[1] from public.qorpera_execution_runs where id = pg_temp.run_id('nora'));
begin
	perform pg_temp.event(nora, 9, 'session_info');
	-- A room wake: its run has no inputs of its own, its wake names the post (the card at 11). Ids that are no uuid are
	-- left out.
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L',
		jsonb_build_object('inputIds', jsonb_build_array(pg_temp.event_id(11), 'x', 5)), pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t(), '[1, 10]', 'The view ends before the wake''s input');
	-- A wake naming no inputs: up to the transcript start (0).
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L', '{"inputIds":"x"}',
		pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t(), '[0, null]', 'No inputs: up to the transcript start');
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L', wake, pg_temp.run_id('nora')));

	-- The run's input is in no event yet: up to the transcript start.
	perform pg_temp.fx(format('update public.qorpera_execution_runs set transcript_start_sequence = 10 where id = %L', pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t(), '[1, 10]', 'Up to the transcript start, 10');
	perform pg_temp.fx(format('update public.qorpera_execution_runs set transcript_start_sequence = 11 where id = %L', pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t(), '[2, 11]', 'Up to the transcript start, 11');

	-- The run's input appended at 12, and the transcript start after it: the view ends before the input.
	perform pg_temp.fx(format('insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body,
		event_hash, created_at) values (%L, 12, %L, %L, %L, %L, %L, %L)', nora, input, 'message', '63400000-0000-4000-8000-000000000001',
		'{"entry":{"message":{"role":"user","content":"Ship it"}}}', pg_temp.ehash(12), timestamptz '2026-10-04 09:12:00+00'));
	perform pg_temp.fx(format('update public.qorpera_execution_runs set transcript_start_sequence = 12 where id = %L', pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t(), '[2, 11]', 'The view ends before the run''s input');
	-- The earliest of the run's and the wake's inputs.
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L',
		jsonb_build_object('inputIds', jsonb_build_array(pg_temp.event_id(11))), pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t(), '[1, 10]', 'The earliest input');
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L', wake, pg_temp.run_id('nora')));
end $$;

-- 3. The record: one row per step of an attempt, with the folder clock as asOfSeq; a replay answers the same, a
-- different request refuses (23505), a new attempt records afresh. The reference it makes stands ----------------------

do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; otto uuid := pg_temp.thread('otto');
	clock bigint := (select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020');
	answer jsonb; tree jsonb := pg_temp.view('otto') -> 'tree'; claims text := current_setting('request.jwt.claims', true);
	first jsonb := pg_temp.b('otto'); assignment uuid := extensions.gen_random_uuid();
begin
	if coalesce(clock, 0) = 0 then raise exception 'The fixture has commits'; end if;
	answer := pg_temp.record_view('otto', pg_temp.request(0));
	perform pg_temp.same(answer, jsonb_build_object('schema', 'qorpera.memory-view-record/v1', 'step', 0, 'asOfSeq', clock),
		'The record, at the folder clock');
	perform pg_temp.same((select to_jsonb(v) - 'recorded_at' from public.qorpera_memory_views v where v.run_id = pg_temp.run_id('otto')),
		jsonb_build_object('run_id', pg_temp.run_id('otto'), 'assignment_id', first ->> 'assignmentId', 'step', 0,
			'profile_id', '63400000-0000-4000-8000-000000000010', 'environment_id', env, 'staff_agent_id', pg_temp.id('otto'),
			'session_id', otto, 'messages', 1, 'head_bytes', 2048, 'view_bytes', 512, 'branches_bytes', 128, 'run_view_bytes', 0,
			'raw_steps', 0, 'placeholders', 1, 'wait_ms', 40, 'waited_lines', 1, 'folded', false,
			'stable_prefix_sha256', repeat('ab', 32), 'as_of_seq', clock), 'The row');

	-- The clock moves on: a replay keeps its asOfSeq, the next step records the new one.
	perform pg_temp.fx(format('update public.qorpera_folder_clocks set last_seq = last_seq + 1 where environment_id = %L', env));
	perform pg_temp.same(pg_temp.record_view('otto', pg_temp.request(0)), answer, 'A replay');
	perform pg_temp.same(pg_temp.record_view('otto', pg_temp.request(1)) -> 'asOfSeq', to_jsonb(clock + 1), 'The next step');
	perform pg_temp.raises(format('select public.qorpera_memory_view_record(%L, %L)', pg_temp.b('otto'), pg_temp.request(0, 2)), '23505');
	perform pg_temp.same((select count(*)::text::jsonb from public.qorpera_memory_views), '2', 'Two rows');

	-- The view reference of step 0 stands (W4a-1): its blocks were saved by its asOfSeq.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform pg_temp.same(to_jsonb(public.qorpera_memory_view_reference_check(env, jsonb_build_object('asOfSeq', answer -> 'asOfSeq',
		'conversations', jsonb_build_array(jsonb_build_object('sessionId', otto, 'generation', tree -> 'generation', 'through', 0,
			'blocks', tree -> 'blocks'))))), '"ok"', 'The reference stands');
	perform set_config('request.jwt.claims', coalesce(claims, ''), true);
	if jsonb_array_length(tree -> 'blocks') <> 1 then raise exception 'Otto''s tree has one block'; end if;

	-- A pristine retry or a resume of the run is a new attempt (its lease's assignment): it records step 0 afresh, at
	-- the clock now, though its request differs. The old attempt's binding is refused.
	perform pg_temp.fx(format('update public.qorpera_folder_clocks set last_seq = last_seq + 1 where environment_id = %L', env));
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set client_lease_id = %L where client_lease_id = %L', assignment,
		first ->> 'assignmentId'));
	perform pg_temp.fx(format('update public.qorpera_native_provider_connection_leases set assignment_id = %L where assignment_id = %L',
		assignment, first ->> 'assignmentId'));
	perform pg_temp.fx(format('update public.qorpera_runner_assignments set id = %L where id = %L', assignment,
		first ->> 'assignmentId'));
	perform set_config('qorpera_test.binding_otto', (first || jsonb_build_object('assignmentId', assignment))::text, true);
	perform pg_temp.same(pg_temp.record_view('otto', pg_temp.request(0, 2)),
		jsonb_build_object('schema', 'qorpera.memory-view-record/v1', 'step', 0, 'asOfSeq', clock + 2), 'A new attempt');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(v.assignment_id, v.step, v.placeholders, v.as_of_seq)
		order by v.as_of_seq) from public.qorpera_memory_views v), jsonb_build_array(
		jsonb_build_array(first ->> 'assignmentId', 0, 1, clock), jsonb_build_array(first ->> 'assignmentId', 1, 1, clock + 1),
		jsonb_build_array(assignment, 0, 2, clock + 2)), 'Three rows, two attempts');
	perform pg_temp.raises(format('select public.qorpera_memory_view_record(%L, %L)', first, pg_temp.request(2)), '42501');
end $$;

-- 4. Malformed requests refuse (22023); the run check comes first -----------------------------------------------------

do $$
declare request jsonb; r jsonb := pg_temp.request(5);
begin
	foreach request in array array['[]', '1', '"x"', '{}', r - 'folded', r || '{"more":1}', r || '{"step":-1}', r || '{"step":1.5}',
		r || '{"step":"0"}', r || '{"step":null}', r || '{"step":1000000000}', r || '{"waitMs":true}', r || '{"folded":"false"}',
		r || '{"folded":0}', r || jsonb_build_object('stablePrefixSha256', repeat('AB', 32)),
		r || jsonb_build_object('stablePrefixSha256', repeat('a', 63)), r || '{"stablePrefixSha256":5}']::jsonb[] loop
		perform pg_temp.raises(format('select public.qorpera_memory_view_record(%L, %L)', pg_temp.b('otto'), request), '22023');
	end loop;
	perform pg_temp.raises(format('select public.qorpera_memory_view_record(%L, null)', pg_temp.b('otto')), '22023');
	perform pg_temp.same(pg_temp.record_view('otto', r || '{"step":999999999}') -> 'step', '999999999', 'The largest count');
	-- A run whose lease is gone refuses both calls, whatever the request (the block's rollback restores it).
	begin
		perform pg_temp.fx(format('delete from public.qorpera_execution_run_budgets where run_id = %L', pg_temp.run_id('otto')));
		begin
			perform pg_temp.view('otto');
			raise exception 'A view with no lease' using errcode = 'QTF02';
		exception when others then
			if sqlstate <> '42501' then raise; end if;
		end;
		perform pg_temp.record_view('otto', '[]');
		raise exception 'A record with no lease' using errcode = 'QTF02';
	exception when others then
		if sqlstate <> '42501' then raise; end if;
	end;
	if not exists (select 1 from public.qorpera_execution_run_budgets where run_id = pg_temp.run_id('otto')) then
		raise exception 'The run''s budget is back'; end if;
end $$;

-- 5. The grants and the call list -------------------------------------------------------------------------------------

do $$
declare v_bad text;
begin
	select string_agg(f || ' ' || r, ', ') into v_bad
	from unnest(array['public.qorpera_memory_view(jsonb)', 'public.qorpera_memory_view_record(jsonb,jsonb)',
		'public.qorpera_memory_view_of(uuid)']) f, unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, f, 'execute') is distinct from (r = 'service_role' and f <> 'public.qorpera_memory_view_of(uuid)');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	select string_agg(t || ' ' || r || ' ' || p, ', ') into v_bad
	from unnest(array['public.qorpera_memory_tree_companies', 'public.qorpera_memory_views']) t,
		unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete']) p
	where has_table_privilege(r, t, p) is distinct from (r = 'service_role' and p = 'select');
	if v_bad is not null then raise exception 'Wrong table grants: %', v_bad; end if;
	if exists (select 1 from pg_class c where c.oid in ('public.qorpera_memory_tree_companies'::regclass,
		'public.qorpera_memory_views'::regclass) and not c.relrowsecurity) then raise exception 'Row security is on'; end if;
	if exists (select 1 from pg_proc p where p.oid in ('public.qorpera_memory_view(jsonb)'::regprocedure,
		'public.qorpera_memory_view_record(jsonb,jsonb)'::regprocedure) and not p.prosecdef) then
		raise exception 'Both calls are definers'; end if;
	perform pg_temp.same((select jsonb_object_agg(c.name, to_jsonb(array[c.scope, c.budget])) from public.qorpera_native_host_calls c
		where c.name in ('qorpera_memory_view', 'qorpera_memory_view_record')),
		'{"qorpera_memory_view": ["binding", "standard"], "qorpera_memory_view_record": ["binding", "standard"]}', 'The call list');
end $$;

rollback;
