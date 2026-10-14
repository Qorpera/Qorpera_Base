-- @fixture 970_memory_branches.test.sql until "-- The checks start here."
-- M1b-4b-2: real run-actor uploads and commits to a new and an existing conversation tree; refusals outside the exact
-- scope and a generation change discarding the whole batch. Bounded raw events and count-only compaction records:
-- authoritative payer, per-assignment batches, exact replay, malformed inputs and run-check precedence.
-- A tree written by a run with no folder grant, and a run that may write there refused by the run rule alone.
-- M1b-4b-3: the admission split. v3 admits before any provider work and launches nothing; the memory calls work on
-- the admission and the context view does not; the bind binds the composed context once, through v2.

create function pg_temp.writer_actor(p_who text) returns jsonb language sql as $$
	select public.qorpera_folder_tool_run(pg_temp.b(p_who), '[]'::jsonb) -> 'actor'
$$;
create function pg_temp.writer_stage(p_who text, p_text text, p_media text) returns jsonb language plpgsql as $$
declare a jsonb := pg_temp.writer_actor(p_who); m text := pg_temp.manifest(array[p_text], p_media, false);
	o jsonb; object_ text; s jsonb;
begin
	o := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', a, m);
	foreach object_ in array array[p_text, m] loop
		if not (o -> 'present') ? pg_temp.hash(object_) then
			perform public.qorpera_folder_confirm_object('63400000-0000-4000-8000-000000000020', a,
				(o ->> 'intentId')::uuid, pg_temp.hash(object_), octet_length(convert_to(object_, 'utf8'))); end if;
	end loop;
	s := public.qorpera_folder_seal_upload('63400000-0000-4000-8000-000000000020', a, (o ->> 'intentId')::uuid);
	if s ->> 'state' <> 'sealed' then raise exception 'Writer upload did not seal: %', s; end if;
	return s -> 'file';
end $$;
create function pg_temp.writer_file(p_who text, p_path text, p_text text, p_version uuid default null)
returns jsonb language sql as $$
	select jsonb_build_object('op', 'write', 'path', p_path,
		'file', pg_temp.writer_stage(p_who, p_text, case when x.kind = 'memory-tree' then 'application/toml' else 'application/jsonl' end),
		'structured', jsonb_build_array(pg_temp.entry(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind))))
		|| case when p_version is null then '{}'::jsonb else jsonb_build_object('expectedVersion', p_version) end
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
create function pg_temp.generations(p_session uuid, p_generation bigint default 0) returns jsonb language sql as $$
	select jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', p_session, 'generation', p_generation)))
$$;
create function pg_temp.writer_commit(p_who text, p_key text, p_units jsonb, p_preconditions jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', pg_temp.writer_actor(p_who),
		p_key, p_units, p_preconditions)
$$;
create function pg_temp.writer_refused(p_answer jsonb) returns void language plpgsql as $$
begin
	if jsonb_array_length(p_answer -> 'units') = 0 or exists (select 1 from jsonb_array_elements(p_answer -> 'units') u
		where u ->> 'outcome' = 'saved') then raise exception 'A refused change saved something: %', p_answer; end if;
end $$;

-- 1. A new tree is derived from the live owner even before a tree index exists. Real staged TOML has the exact media
-- type and executable bit; normal parsing, generation checks and the index run in the same folder route as production.
do $$
declare env constant uuid := '63400000-0000-4000-8000-000000000020'; root constant text := 'agents/nora/memory/thread';
	s uuid := pg_temp.thread('nora'); u jsonb; r jsonb; i integer; before_ uuid;
begin
	perform pg_temp.same(to_jsonb(public.qorpera_memory_session_tree_root(env, s)), null, 'No indexed tree before its first write');
	u := jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root),
		pg_temp.writer_file('nora', root || '/tree.toml', pg_temp.toml(s)),
		jsonb_build_object('op', 'mkdir', 'path', root || '/t0'),
		pg_temp.writer_file('nora', root || '/t0/00000000.jsonl', pg_temp.line0(0, 10) || E'\n'));
	perform pg_temp.same(u #> '{1,file,mediaType}', '"application/toml"', 'The TOML media type');
	perform pg_temp.same(u #> '{1,file,executable}', 'false', 'The TOML is not executable');
	r := pg_temp.writer_commit('nora', 'writer-new-tree', u, pg_temp.generations(s));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.same(to_jsonb(public.qorpera_memory_session_tree_root(env, s)), to_jsonb(root), 'The new tree is indexed');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(n.l, n.k, n.seq, n.event_hash)) from public.qorpera_memory_tree_nodes n
		where n.environment_id = env and n.session_id = s), jsonb_build_array(jsonb_build_array(0, 0, 10, pg_temp.ehash(10))),
		'The level-zero line is indexed with its original event');
	-- Existing tree: a normal version-checked replacement extends a block without changing its source numbering.
	before_ := (pg_temp.read(root || '/t0/00000000.jsonl') #>> '{entry,version}')::uuid;
	u := jsonb_build_array(pg_temp.writer_file('nora', root || '/t0/00000000.jsonl',
		pg_temp.line0(0, 10) || E'\n' || pg_temp.line0(1, 11) || E'\n', before_));
	perform pg_temp.expect(pg_temp.writer_commit('nora', 'writer-existing-tree', u, pg_temp.generations(s)), 1, 'saved');
	perform pg_temp.same((select to_jsonb(count(*)) from public.qorpera_memory_tree_nodes where environment_id = env and session_id = s),
		'2', 'The existing block now has both lines');
	if (pg_temp.read(root || '/t0/00000000.jsonl') #>> '{entry,version}')::uuid = before_ then
		raise exception 'The block replacement has a new version'; end if;
end $$;

-- 2. Other conversations, logs without runLog, paths outside the tree, deletes/moves/copies/new_folder, and an absent,
-- foreign or extra session generation never save. Ordinary run writes still cannot bypass the memory route.
do $$
declare root constant text := 'agents/nora/memory/thread'; s uuid := pg_temp.thread('nora'); units_ jsonb; p jsonb;
	i integer := 0; before_ jsonb := pg_temp.read(root || '/t0/00000000.jsonl');
begin
	foreach units_ in array array[
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'agents/otto/memory/thread/t1')),
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/runs')),
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/runs/' || pg_temp.run_id('nora'))),
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'writer-outside')),
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/t15')),
		jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', root || '/t1', 'contents', '[]'::jsonb)),
		jsonb_build_array(jsonb_build_object('op', 'delete', 'path', root || '/t0/00000000.jsonl',
			'expectedVersion', before_ #>> '{entry,version}')),
		jsonb_build_array(jsonb_build_object('op', 'move', 'from', root || '/t0/00000000.jsonl', 'to', root || '/t0/00000001.jsonl',
			'expectedVersion', before_ #>> '{entry,version}')),
		jsonb_build_array(jsonb_build_object('op', 'copy', 'from', root || '/t0/00000000.jsonl', 'to', root || '/t0/00000001.jsonl',
			'expectedVersion', before_ #>> '{entry,version}'))
	] loop
		i := i + 1;
		perform pg_temp.writer_refused(pg_temp.writer_commit('nora', 'writer-path-denied-' || i, units_, pg_temp.generations(s)));
	end loop;
	foreach p in array array['{}'::jsonb, '{"sessionGenerations":[]}'::jsonb, pg_temp.generations(pg_temp.thread('otto')),
		jsonb_build_object('sessionGenerations', (pg_temp.generations(s) -> 'sessionGenerations')
			|| (pg_temp.generations(pg_temp.thread('otto')) -> 'sessionGenerations'))] loop
		i := i + 1;
		perform pg_temp.writer_refused(pg_temp.writer_commit('nora', 'writer-generation-denied-' || i,
			jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/t1')), p));
	end loop;
	perform pg_temp.writer_refused(pg_temp.commit(pg_temp.writer_actor('nora'), 'writer-no-memory-route',
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/t1'))));
	perform pg_temp.same(pg_temp.read(root || '/t0/00000000.jsonl') #> '{entry,version}', before_ #> '{entry,version}',
		'Refused moves and deletes preserve the source');
	perform pg_temp.same(pg_temp.read(root || '/t1') -> 'found', 'false', 'No refused tier exists');
end $$;

-- 3. A generation raise after the read discards every unit of the batch, including a new folder. Rebuilding with
-- the fresh generation then succeeds. No stale block version or index line is partly adopted.
do $$
declare root constant text := 'agents/nora/memory/thread'; s uuid := pg_temp.thread('nora'); r jsonb; u jsonb;
	before_ uuid := (pg_temp.read(root || '/t0/00000000.jsonl') #>> '{entry,version}')::uuid;
begin
	u := jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/t1'),
		pg_temp.writer_file('nora', root || '/t0/00000000.jsonl', pg_temp.line0(0, 10) || E'\n', before_));
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set memory_generation = memory_generation + 1 where id = %L', s));
	r := pg_temp.writer_commit('nora', 'writer-stale-batch', u, pg_temp.generations(s));
	perform pg_temp.expect(r, 1, 'refused', 'memory_generation_stale');
	perform pg_temp.expect(r, 2, 'refused', 'memory_generation_stale');
	perform pg_temp.same(pg_temp.read(root || '/t1') -> 'found', 'false', 'No stale folder landed');
	perform pg_temp.same(pg_temp.read(root || '/t0/00000000.jsonl') #> '{entry,version}', to_jsonb(before_), 'No stale block landed');
	perform pg_temp.same((select to_jsonb(count(*)) from public.qorpera_memory_tree_nodes where session_id = s), '2', 'No stale index landed');
	r := pg_temp.writer_commit('nora', 'writer-fresh-batch', u, pg_temp.generations(s, 1));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
end $$;

-- 4. Raw events retain original numbering, sequence and eventHash, skip non-included events, page and bound exactly;
-- each page names the conversation's tree root.
do $$
declare s uuid := pg_temp.thread('nora'); r jsonb; request_ jsonb; i integer;
	base jsonb := jsonb_build_object('session', pg_temp.thread('nora'), 'start', 0, 'count', 128);
begin
	perform pg_temp.event(s, 9, 'session_info');
	r := public.qorpera_memory_events_run(pg_temp.b('nora'), base);
	perform pg_temp.same(r - 'events', '{"schema":"qorpera.memory-events/v1","root":"agents/nora/memory/thread"}', 'The page and its root');
	perform pg_temp.same(r -> 'events', public.qorpera_memory_events(s, 0, 128), 'The existing event renderer is unchanged');
	perform pg_temp.same(jsonb_build_array(r #> '{events,0,sequence}', r #> '{events,0,eventHash}', r #> '{events,1,sequence}'),
		jsonb_build_array(10, pg_temp.ehash(10), 11), 'Original sequence and hash, with non-included event skipped');
	perform pg_temp.same(public.qorpera_memory_events_run(pg_temp.b('nora'), base || '{"start":1,"count":1}') -> 'events',
		jsonb_build_array(r #> '{events,1}'), 'A single paged event');
	perform pg_temp.same(public.qorpera_memory_events_run(pg_temp.b('nora'), base || '{"start":9007199254740991}'),
		(r - 'events') || '{"events":[]}', 'Past the end');
	for i in 50..178 loop perform pg_temp.event(s, i); end loop;
	perform pg_temp.same(to_jsonb(jsonb_array_length(public.qorpera_memory_events_run(pg_temp.b('nora'), base) -> 'events')), '128',
		'Bounded at 128');
	perform pg_temp.raises(format('select public.qorpera_memory_events_run(%L,%L)', pg_temp.b('nora'),
		base || jsonb_build_object('session', pg_temp.thread('otto'))), '42501');
	foreach request_ in array array['[]'::jsonb, '{}'::jsonb, base - 'count', base || '{"more":true}', base || '{"session":null}',
		base || '{"session":"not-a-uuid"}', base || '{"start":-1}', base || '{"start":1.5}', base || '{"start":"0"}',
		base || '{"start":9007199254740992}', base || '{"count":0}', base || '{"count":129}', base || '{"count":1.5}',
		base || '{"count":null}'] loop
		perform pg_temp.raises(format('select public.qorpera_memory_events_run(%L,%L)', pg_temp.b('nora'), request_), '22023');
	end loop;
	perform pg_temp.raises(format('select public.qorpera_memory_events_run(%L,null)', pg_temp.b('nora')), '22023');
end $$;

create function pg_temp.compaction(p_batch integer, p_kind text default 'conversation') returns jsonb language sql as $$
	select jsonb_build_object('batch', p_batch, 'kind', p_kind, 'calls', 3, 'free', 2, 'input', 5000, 'cached', 4000,
		'output', 300, 'overshoots', 1, 'failures', 1, 'stopped', null)
$$;

-- 5. Real binding-derived payer, multiple batches, exact replay despite later records, all stop reasons; a new
-- assignment can record its own batch zero while an old binding no longer has authority.
do $$
declare b jsonb := pg_temp.b('otto'); run_ uuid := pg_temp.run_id('otto'); payer uuid; r jsonb; stop_ text;
	assignment uuid := extensions.gen_random_uuid(); row_ jsonb; i integer := 1;
begin
	select s.provider_connection_id into payer from public.qorpera_execution_runs r
	join public.qorpera_execution_sponsor_versions s on s.binding_id = r.sponsor_binding_id and s.version = r.sponsor_version
	where r.id = run_;
	if payer is null then raise exception 'Fixture has a pinned payer'; end if;
	r := public.qorpera_memory_compaction_record(b, pg_temp.compaction(0));
	perform pg_temp.same(r, jsonb_build_object('schema', 'qorpera.memory-compaction-record/v1', 'batch', 0, 'payerConnectionId', payer),
		'The authoritative payer');
	select to_jsonb(c) - 'recorded_at' into row_ from public.qorpera_memory_compactions c where c.run_id = run_ and c.batch = 0;
	perform pg_temp.same(row_, pg_temp.compaction(0) || jsonb_build_object('run_id', run_, 'assignment_id', b ->> 'assignmentId',
		'profile_id', '63400000-0000-4000-8000-000000000010', 'environment_id', '63400000-0000-4000-8000-000000000020',
		'staff_agent_id', pg_temp.id('otto'), 'session_id', pg_temp.thread('otto'), 'payer_connection_id', payer), 'All recorded counts');
	foreach stop_ in array array['usage-limit','rate-limit','outage'] loop
		perform public.qorpera_memory_compaction_record(b, pg_temp.compaction(i, 'run') || jsonb_build_object('stopped', stop_));
		i := i + 1;
	end loop;
	perform pg_temp.same(public.qorpera_memory_compaction_record(b, pg_temp.compaction(0)), r, 'Replay survives later batches');
	perform pg_temp.raises(format('select public.qorpera_memory_compaction_record(%L,%L)', b, pg_temp.compaction(0) || '{"calls":4}'), '23505');
	perform pg_temp.raises(format('select public.qorpera_memory_compaction_record(%L,%L)', b, pg_temp.compaction(0, 'run')), '23505');
	perform pg_temp.same((select to_jsonb(count(*)) from public.qorpera_memory_compactions where run_id = run_), '4', 'No duplicate records');
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set client_lease_id = %L where client_lease_id = %L', assignment, b ->> 'assignmentId'));
	perform pg_temp.fx(format('update public.qorpera_native_provider_connection_leases set assignment_id = %L where assignment_id = %L',
		assignment, b ->> 'assignmentId'));
	perform pg_temp.fx(format('update public.qorpera_runner_assignments set id = %L where id = %L', assignment, b ->> 'assignmentId'));
	perform set_config('qorpera_test.binding_otto', (b || jsonb_build_object('assignmentId', assignment))::text, true);
	perform public.qorpera_memory_compaction_record(pg_temp.b('otto'), pg_temp.compaction(0) || '{"calls":4}');
	perform pg_temp.same((select to_jsonb(count(*)) from public.qorpera_memory_compactions where run_id = run_), '5', 'A new assignment records afresh');
	perform pg_temp.raises(format('select public.qorpera_memory_compaction_record(%L,%L)', b, pg_temp.compaction(0)), '42501');
end $$;

-- 6. Closed inputs, numeric and enum bounds, no caller-selected payer. Lost run authority precedes every schema error.
do $$
declare r jsonb := pg_temp.compaction(10); request_ jsonb; key_ text;
begin
	foreach request_ in array array['[]'::jsonb, '{}'::jsonb, r - 'stopped', r || '{"more":0}', r || '{"kind":null}',
		r || '{"kind":"agent"}', r || '{"stopped":false}', r || '{"stopped":"cancelled"}',
		r || jsonb_build_object('payerConnectionId', extensions.gen_random_uuid())] loop
		perform pg_temp.raises(format('select public.qorpera_memory_compaction_record(%L,%L)', pg_temp.b('otto'), request_), '22023');
	end loop;
	foreach key_ in array array['batch','calls','free','input','cached','output','overshoots','failures'] loop
		foreach request_ in array array[r - key_, r || jsonb_build_object(key_, null), r || jsonb_build_object(key_, '0'),
			r || jsonb_build_object(key_, -1), r || jsonb_build_object(key_, 1.5), r || jsonb_build_object(key_, 1000000000)] loop
			perform pg_temp.raises(format('select public.qorpera_memory_compaction_record(%L,%L)', pg_temp.b('otto'), request_), '22023');
		end loop;
	end loop;
	perform pg_temp.raises(format('select public.qorpera_memory_compaction_record(%L,null)', pg_temp.b('otto')), '22023');
	begin
		perform pg_temp.fx(format('delete from public.qorpera_execution_run_budgets where run_id = %L', pg_temp.run_id('otto')));
		perform pg_temp.raises(format('select public.qorpera_memory_events_run(%L,%L)', pg_temp.b('otto'), '[]'), '42501');
		perform pg_temp.raises(format('select public.qorpera_memory_compaction_record(%L,%L)', pg_temp.b('otto'), '[]'), '42501');
		raise exception 'Restore the fixture' using errcode = 'QTF02';
	exception when sqlstate 'QTF02' then null;
	end;
	if not exists (select 1 from public.qorpera_execution_run_budgets where run_id = pg_temp.run_id('otto')) then
		raise exception 'The binding fixture was restored'; end if;
end $$;

-- 7. Native host registration and least grants; no overloaded binding-call name, no exposed internal reader or rule.
do $$
declare bad text;
begin
	select string_agg(f || ' ' || r, ', ') into bad
	from unnest(array['public.qorpera_memory_events_run(jsonb,jsonb)', 'public.qorpera_memory_compaction_record(jsonb,jsonb)',
		'public.qorpera_memory_events(uuid,bigint,integer)', 'public.qorpera_memory_run_tree_problem(uuid,jsonb,text,text)',
		'public.qorpera_memory_run_log_admits(uuid,text,jsonb,text,text,jsonb)']) f,
		unnest(array['anon','authenticated','service_role']) r
	where has_function_privilege(r, f, 'execute') is distinct from (r = 'service_role'
		and f in ('public.qorpera_memory_events_run(jsonb,jsonb)', 'public.qorpera_memory_compaction_record(jsonb,jsonb)'));
	if bad is not null then raise exception 'Wrong function grants: %', bad; end if;
	select string_agg(r || ' ' || p, ', ') into bad from unnest(array['anon','authenticated','service_role']) r,
		unnest(array['select','insert','update','delete']) p
	where has_table_privilege(r, 'public.qorpera_memory_compactions', p) is distinct from (r = 'service_role' and p = 'select');
	if bad is not null then raise exception 'Wrong table grants: %', bad; end if;
	if not (select relrowsecurity from pg_class where oid = 'public.qorpera_memory_compactions'::regclass) then
		raise exception 'Compaction records have row security'; end if;
	perform pg_temp.same((select jsonb_object_agg(name, jsonb_build_array(scope, budget)) from public.qorpera_native_host_calls
		where name in ('qorpera_memory_events_run','qorpera_memory_compaction_record')),
		'{"qorpera_memory_events_run":["binding","standard"],"qorpera_memory_compaction_record":["binding","standard"]}', 'The host call list');
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in
		('qorpera_memory_events_run','qorpera_memory_compaction_record')) <> 2 then raise exception 'No overload ambiguity'; end if;
end $$;

-- 8. The tree is the platform's (§4.3): a run whose agent holds only a read grant still writes its own conversation's
-- tree, before it is indexed and after, while that run's ordinary write is denied.
do $$
declare env constant uuid := '63400000-0000-4000-8000-000000000020'; vera constant uuid := '97000000-0000-4000-8000-0000000000a5';
	root constant text := 'agents/vera/memory/thread'; x jsonb; r jsonb; s uuid; i integer;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'writer-hire-vera',
		jsonb_build_array(pg_temp.hire('vera', vera, 'Vera'))), 1, 'saved');
	perform public.qorpera_folder_grant(env, pg_temp.member(1), (public.qorpera_folder_path_resource(env, root)).id,
		'staff_agent', vera, array['read']);
	x := pg_temp.agent_run(vera);
	perform set_config('qorpera_test.binding_vera', (x -> 'binding')::text, true);
	s := (select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = vera);
	if s is null or (select session_id from public.qorpera_execution_runs where id = (x -> 'actor' ->> 'runId')::uuid)
		is distinct from s then raise exception 'Vera''s run is in Vera''s thread'; end if;
	perform pg_temp.same(to_jsonb(public.qorpera_memory_conversation_root(env, '63400000-0000-4000-8000-000000000010', s)),
		'"agents/vera/memory/thread"', 'The owner gives the root''s key');
	perform pg_temp.same(public.qorpera_memory_events_run(pg_temp.b('vera'), jsonb_build_object('session', s, 'start', 0, 'count', 1))
		-> 'root', to_jsonb(root), 'The events call gives the root before any tree');
	if public.qorpera_folder_actor_allowed(env, '63400000-0000-4000-8000-000000000010',
		public.qorpera_folder_tool_run(pg_temp.b('vera'), '[]'::jsonb) -> 'resolved', root || '/t0', 'write') then
		raise exception 'Vera''s run holds no write grant'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.writer_actor('vera'), 'writer-vera-plain',
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'agents/vera/notes'))), 1, 'denied', 'denied');
	perform pg_temp.event(s, 200);
	r := pg_temp.writer_commit('vera', 'writer-vera-new-tree', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root),
		pg_temp.writer_file('vera', root || '/tree.toml', pg_temp.toml(s)), jsonb_build_object('op', 'mkdir', 'path', root || '/t0'),
		pg_temp.writer_file('vera', root || '/t0/00000000.jsonl', pg_temp.line0(0, 200) || E'\n')), pg_temp.generations(s));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.same(to_jsonb(public.qorpera_memory_session_tree_root(env, s)), to_jsonb(root), 'The tree is indexed');
	r := pg_temp.writer_commit('vera', 'writer-vera-indexed-tree',
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/t1')), pg_temp.generations(s));
	perform pg_temp.expect(r, 1, 'saved');
end $$;

-- 9. A run whose agent and member may write the trees' folders (as a live agent's default grant on the shared root
-- gives) passes the commit's authority check, so the run rule alone refuses: a block's delete, a run log's folder,
-- another conversation's tree under that conversation's generation, and a second session's generation. (A tier folder
-- past t14 never reaches the run rule: M1a's tree check refuses it first, block 2.)
do $$
declare env constant uuid := '63400000-0000-4000-8000-000000000020'; root constant text := 'agents/nora/memory/thread';
	other constant text := 'agents/otto/memory/thread'; s uuid := pg_temp.thread('nora'); a jsonb; p text; r jsonb; u jsonb;
	i integer := 0;
	outside constant text := 'a run writes only its own conversation tree folders, tree.toml and blocks';
	scope constant text := 'a run tree change names exactly its own conversation and generation';
begin
	foreach p in array array[root, other] loop
		perform public.qorpera_folder_grant(env, pg_temp.member(1), (public.qorpera_folder_path_resource(env, p)).id,
			'staff_agent', pg_temp.id('nora'), array['read','write']);
		perform public.qorpera_folder_grant(env, pg_temp.member(1), (public.qorpera_folder_path_resource(env, p)).id,
			'member', '63400000-0000-4000-8000-000000000002', array['read','write']);
	end loop;
	a := public.qorpera_folder_tool_run(pg_temp.b('nora'), '[]'::jsonb) -> 'resolved';
	foreach p in array array[root || '/t0/00000000.jsonl', root || '/runs', other || '/t1', root || '/t2'] loop
		if not public.qorpera_folder_actor_allowed(env, '63400000-0000-4000-8000-000000000010', a, p, 'write') then
			raise exception 'Nora''s run may write %', p; end if;
	end loop;
	foreach u in array array[
		jsonb_build_object('op', 'delete', 'path', root || '/t0/00000000.jsonl',
			'expectedVersion', pg_temp.read(root || '/t0/00000000.jsonl') #>> '{entry,version}'),
		jsonb_build_object('op', 'mkdir', 'path', root || '/runs')] loop
		i := i + 1;
		r := pg_temp.writer_commit('nora', 'writer-granted-' || i, jsonb_build_array(u), pg_temp.generations(s, 1));
		perform pg_temp.same(pg_temp.expect(r, 1, 'refused', 'structured_rule') #> '{problems,0,message}', to_jsonb(outside),
			'The run rule refuses ' || (u ->> 'op') || ' ' || (u ->> 'path'));
	end loop;
	r := pg_temp.writer_commit('nora', 'writer-granted-other', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', other || '/t1')),
		pg_temp.generations(pg_temp.thread('otto')));
	perform pg_temp.same(pg_temp.expect(r, 1, 'refused', 'structured_rule') #> '{problems,0,message}', to_jsonb(scope),
		'The run rule refuses another conversation''s tree');
	r := pg_temp.writer_commit('nora', 'writer-granted-both', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/t2')),
		jsonb_build_object('sessionGenerations', (pg_temp.generations(s, 1) -> 'sessionGenerations')
			|| (pg_temp.generations(pg_temp.thread('otto')) -> 'sessionGenerations')));
	perform pg_temp.same(pg_temp.expect(r, 1, 'refused', 'structured_rule') #> '{problems,0,message}', to_jsonb(scope),
		'The run rule refuses a second session''s generation');
	perform pg_temp.same(pg_temp.read(root || '/t0/00000000.jsonl') -> 'found', 'true', 'The refused delete kept the block');
	foreach p in array array[root || '/runs', other || '/t1', root || '/t2'] loop
		perform pg_temp.same(pg_temp.read(p) -> 'found', 'false', 'No refused folder ' || p);
	end loop;
end $$;

-- 10. The admission split (contract §6, §7: admitted, composing, running). Nora's run carries the active bundle. v3
-- refuses another binary, bundle or policy and a malformed catalog; it admits with every v2 check but the context's,
-- again for the same lease, and writes no launch and no start. On the admission the memory calls work and the context
-- view is refused (it needs the launch). The bind refuses another lease's admission and a bad context and keeps the
-- admission, then binds once through v2: the launch and the start record, with the last admitted catalog. A second
-- bind, a later v3 and a run never admitted are refused.
create function pg_temp.admit_sql(p_binding jsonb, p_binary text, p_bundle text, p_policy text, p_catalog text)
returns text language sql as $$
	select format('select public.qorpera_begin_native_company_execution_v3(%L,%L,%L,%L,%L)', p_binding, p_binary, p_bundle,
		p_policy, p_catalog)
$$;
create function pg_temp.bind_sql(p_binding jsonb, p_sha256 text, p_bytes integer) returns text language sql as $$
	select format('select public.qorpera_bind_native_company_context(%L,%L,%L)', p_binding, p_sha256, p_bytes)
$$;
do $$
declare env constant uuid := '63400000-0000-4000-8000-000000000020'; root constant text := 'agents/nora/memory/thread';
	b jsonb := pg_temp.b('nora'); run_ uuid := pg_temp.run_id('nora'); s uuid := pg_temp.thread('nora');
	bundle_ public.qorpera_active_runtime_bundle%rowtype; manifest_ jsonb; bin text; sha text; policy text; tool jsonb;
	cat jsonb; cat2 jsonb; bad text; contexts text[] := array[null, repeat('C', 64), repeat('c', 63), repeat('c', 64), repeat('c', 64)];
	sizes integer[] := array[10, 10, 10, 0, 1048577]; a jsonb; started jsonb; i integer;
begin
	select * into strict bundle_ from public.qorpera_active_runtime_bundle where singleton;
	select manifest into strict manifest_ from public.qorpera_runtime_bundles
	where id = bundle_.runtime_bundle_id and sha256 = bundle_.runtime_bundle_sha256;
	bin := manifest_ ->> 'nativeBinarySha256'; sha := bundle_.runtime_bundle_sha256;
	policy := encode(extensions.digest(convert_to((manifest_ -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex');
	perform pg_temp.fx(format('update public.qorpera_execution_runs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L,
		reasoning_effort = %L, reasoning_policy_sha256 = %L, service_tier = ''standard'' where id = %L', bundle_.runtime_bundle_id,
		sha, manifest_ #>> '{modelPolicy,effort}', policy, run_));
	perform pg_temp.fx(format('update public.qorpera_session_inputs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L
		where execution_run_id = %L', bundle_.runtime_bundle_id, sha, run_));
	tool := '{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}';
	cat := jsonb_build_object('type', 'namespace', 'name', 'qorpera', 'description', 'Synthetic native fixture', 'tools', jsonb_build_array(tool));
	cat2 := cat || jsonb_build_object('tools', jsonb_build_array(tool, tool || '{"name":"read_memory"}'));
	if exists (select 1 from public.qorpera_native_execution_launches where run_id = run_)
		or exists (select 1 from public.qorpera_execution_run_events where run_id = run_ and event_type = 'runner_started') then
		raise exception 'Nora''s run has not launched'; end if;

	foreach bad in array array[pg_temp.admit_sql(b, repeat('0', 64), sha, policy, cat::text),
		pg_temp.admit_sql(b, bin, repeat('0', 64), policy, cat::text), pg_temp.admit_sql(b, bin, sha, repeat('0', 64), cat::text)] loop
		perform pg_temp.raises_like(bad, '42501', 'Native executable policy differs from the admitted run');
	end loop;
	foreach bad in array array['', '[]', '{"type":"namespace"}', (cat || '{"tools":[]}')::text, (cat || '{"more":1}')::text,
		(cat || '{"name":"other"}')::text, (cat || jsonb_build_object('tools', jsonb_build_array(tool || '{"name":"Read"}')))::text,
		(cat || jsonb_build_object('tools', jsonb_build_array(tool, tool)))::text,
		(cat || jsonb_build_object('tools', jsonb_build_array(tool - 'description')))::text,
		(cat || jsonb_build_object('tools', jsonb_build_array(tool || '{"more":1}')))::text,
		(cat || jsonb_build_object('tools', jsonb_build_array(jsonb_set(tool, '{inputSchema,additionalProperties}', 'true'))))::text,
		repeat(' ', 1048577)] loop
		perform pg_temp.raises(pg_temp.admit_sql(b, bin, sha, policy, bad), '22023');
	end loop;
	perform pg_temp.raises(pg_temp.admit_sql(b, bin, sha, policy, null), '22023');
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.raises_like(pg_temp.admit_sql(b, bin, sha, policy, cat::text), '42501', 'Native execution admission is unavailable');
	perform pg_temp.raises_like(pg_temp.bind_sql(b, repeat('c', 64), 10), '42501', 'Native execution admission is unavailable');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if exists (select 1 from public.qorpera_native_execution_admissions where run_id = run_) then
		raise exception 'A refused admission is not kept'; end if;

	perform public.qorpera_begin_native_company_execution_v3(b, bin, sha, policy, cat::text);
	a := public.qorpera_begin_native_company_execution_v3(b, bin, sha, policy, cat2::text);
	perform pg_temp.same(a, jsonb_build_object('schema', 'qorpera.native-company-execution-admission/v1', 'runId', run_,
		'jobId', b ->> 'jobId', 'leaseId', b ->> 'leaseId', 'binarySha256', bin, 'runtimeBundleSha256', sha,
		'reasoningEffort', manifest_ #>> '{modelPolicy,effort}', 'reasoningPolicySha256', policy,
		'toolCatalogSha256', encode(extensions.digest(cat2::text, 'sha256'), 'hex')), 'The admission');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(lease_id, tool_catalog_text)) from public.qorpera_native_execution_admissions
		where run_id = run_), jsonb_build_array(jsonb_build_array(b ->> 'leaseId', cat2::text)), 'One admission, the last one');
	if exists (select 1 from public.qorpera_native_execution_launches where run_id = run_)
		or exists (select 1 from public.qorpera_execution_run_events where run_id = run_ and event_type = 'runner_started') then
		raise exception 'The admission launches nothing'; end if;

	-- Composing: the settle's calls run on the admission; the context view waits for the launch.
	perform pg_temp.same(public.qorpera_memory_events_run(b, jsonb_build_object('session', s, 'start', 0, 'count', 1)) -> 'root',
		to_jsonb(root), 'The events call on the admission');
	perform pg_temp.same(public.qorpera_memory_compaction_record(b, pg_temp.compaction(0)) -> 'batch', '0', 'The record on the admission');
	perform pg_temp.expect(pg_temp.writer_commit('nora', 'writer-admitted-commit',
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', root || '/t2')), pg_temp.generations(s, 1)), 1, 'saved');
	perform pg_temp.raises_like(format('select public.qorpera_folder_record_context_view(%L,%L,%L)', env, b, '{}'), '42501',
		'Native launch provenance is unavailable');

	-- The bind: another lease's admission, then bad contexts; each keeps the admission.
	perform pg_temp.fx(format('update public.qorpera_native_execution_admissions set lease_id = %L where run_id = %L',
		extensions.gen_random_uuid(), run_));
	perform pg_temp.raises_like(pg_temp.bind_sql(b, repeat('c', 64), 10), '55000', 'Native execution is not admitted');
	perform pg_temp.fx(format('update public.qorpera_native_execution_admissions set lease_id = %L where run_id = %L', b ->> 'leaseId', run_));
	for i in 1..5 loop
		perform pg_temp.raises_like(pg_temp.bind_sql(b, contexts[i], sizes[i]), '22023', 'Native launch provenance is invalid');
	end loop;
	if not exists (select 1 from public.qorpera_native_execution_admissions where run_id = run_) then
		raise exception 'A refused bind keeps the admission'; end if;
	started := public.qorpera_bind_native_company_context(b, repeat('c', 64), 10);
	perform pg_temp.same(started, (a - 'schema') || jsonb_build_object('schema', 'qorpera.native-company-execution-start/v1',
		'contextSha256', repeat('c', 64), 'contextBytes', 10), 'The start record is the admission with its context');
	perform pg_temp.same((select jsonb_agg(payload) from public.qorpera_execution_run_events where run_id = run_
		and event_type = 'runner_started'), jsonb_build_array(started), 'One start, recorded');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(tool_catalog_text, context_sha256, context_bytes))
		from public.qorpera_native_execution_launches where run_id = run_),
		jsonb_build_array(jsonb_build_array(cat2::text, repeat('c', 64), 10)), 'The launch');
	if exists (select 1 from public.qorpera_native_execution_admissions where run_id = run_) then
		raise exception 'The bind takes the admission'; end if;
	perform pg_temp.raises_like(format('select public.qorpera_folder_record_context_view(%L,%L,%L)', env, b, '{}'), '22023',
		'Context view is invalid');
	perform pg_temp.raises_like(pg_temp.bind_sql(b, repeat('d', 64), 20), '55000', 'Native execution is not admitted');
	perform pg_temp.raises_like(pg_temp.admit_sql(b, bin, sha, policy, cat::text), '55000',
		'Earlier native execution requires reconciliation');
	perform pg_temp.raises_like(pg_temp.bind_sql(pg_temp.b('vera'), repeat('c', 64), 10), '55000', 'Native execution is not admitted');
end $$;

-- 11. Least grants: only the service role calls v3 and the bind (v2 stays, for the coding wrapper); nobody reads the
-- admissions; both are listed binding calls with the standard budget, without overloads.
do $$
declare bad text;
begin
	select string_agg(f || ' ' || r, ', ') into bad
	from unnest(array['public.qorpera_begin_native_company_execution_v3(jsonb,text,text,text,text)',
		'public.qorpera_bind_native_company_context(jsonb,text,integer)',
		'public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)']) f,
		unnest(array['anon','authenticated','service_role']) r
	where has_function_privilege(r, f, 'execute') is distinct from (r = 'service_role');
	if bad is not null then raise exception 'Wrong function grants: %', bad; end if;
	select string_agg(r || ' ' || p, ', ') into bad from unnest(array['anon','authenticated','service_role']) r,
		unnest(array['select','insert','update','delete']) p
	where has_table_privilege(r, 'public.qorpera_native_execution_admissions', p);
	if bad is not null then raise exception 'Wrong table grants: %', bad; end if;
	if not (select relrowsecurity from pg_class where oid = 'public.qorpera_native_execution_admissions'::regclass) then
		raise exception 'Admissions have row security'; end if;
	perform pg_temp.same((select jsonb_object_agg(name, jsonb_build_array(scope, budget)) from public.qorpera_native_host_calls
		where name in ('qorpera_begin_native_company_execution_v3','qorpera_bind_native_company_context')),
		'{"qorpera_begin_native_company_execution_v3":["binding","standard"],"qorpera_bind_native_company_context":["binding","standard"]}',
		'The host call list');
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in
		('qorpera_begin_native_company_execution_v3','qorpera_bind_native_company_context')) <> 2 then
		raise exception 'No overload ambiguity'; end if;
end $$;

rollback;
