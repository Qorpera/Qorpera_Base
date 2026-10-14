-- @fixture 970_memory_branches.test.sql until "-- The checks start here."
-- Run logs W1b-1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §8; 20260930231000): the three file kinds and their
-- parsers; where a run's log goes (origin and place); run.toml, log blocks and run tree blocks with every refusal; the
-- paths a memory commit with runLog writes, and a run naming another run; the index (logs, steps, needles from `paths`,
-- the args and the receipt, cut args); what a run writes as itself (admits); step hashes and narrow paths; a stale run
-- generation and an open erase; a log that moves with its group, a log deleted and erased; the grants and host calls.
-- Runs are 970's (nora and otto, each in its own thread) and a room run of otto's in launch. Races are in 952.

-- A run's actor, as its binding names it.
create function pg_temp.actor(p_who text) returns jsonb language sql as $$
	select jsonb_build_object('kind','run','runId',b ->> 'runId','jobId',b ->> 'jobId','runnerId',b ->> 'runnerId',
		'assignmentId',b ->> 'assignmentId')
	from (select pg_temp.b(p_who) as b) x
$$;
-- A run of p_staff on a message in a group chat, leased.
create function pg_temp.room_run(p_staff uuid, p_group text) returns jsonb language plpgsql as $$
declare
	v_profile uuid := '63400000-0000-4000-8000-000000000010'; v_env uuid := '63400000-0000-4000-8000-000000000020';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_session uuid := pg_temp.chat(p_group); v_input uuid := extensions.gen_random_uuid();
	v_owner uuid := '63400000-0000-4000-8000-000000000001'; v_sponsor uuid := '63400000-0000-4000-8000-0000000000b1';
	v_bundle uuid := '63400000-0000-4000-8000-0000000000b2';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256)
	values (v_input, v_session, extensions.gen_random_uuid(), v_owner, 'human', 'user_message', v_bundle, repeat('b', 64));
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_owner, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, audience_user_id, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'room_delivery', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		p_staff, 1, v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_owner, v_owner, 'openai', 'gpt-test',
		'provider_default', 'company', null, v_bundle, repeat('b', 64), v_session, '{}'::uuid[]);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'room', v_wake::text, clock_timestamp(), clock_timestamp(), 'room', 'room', v_input,
		v_run, 'materialized', p_staff, 1, v_owner, v_sponsor, 1, v_session, v_wake, array[p_staff], '{}'::jsonb);
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;
-- A unit refused with one problem.
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
-- A block's text from its lines, and what the run tree block parser says of it.
create function pg_temp.block(p_lines text[]) returns text language sql as $$
	select array_to_string(p_lines, E'\n') || E'\n'
$$;
create function pg_temp.block_result(p_key text, p_text text) returns text language sql as $$
	select case when r ? 'lines' then 'lines ' || jsonb_array_length(r -> 'lines')
		else coalesce(r ->> 'line', '-') || ' ' || (r ->> 'problem') end
	from (select public.qorpera_memory_run_block_parse(p_key, p_text) as r) x
$$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020' and key_text = p_key
		and kind is distinct from 'claim'
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020'
$$;
-- A run log file as the TS parser sends it, staged by the actor who commits it; a rewrite names the version it replaces.
create function pg_temp.rfile(p_path text, p_text text, p_actor jsonb default '{"kind":"platform"}') returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text, p_actor),
		'structured', jsonb_build_array(pg_temp.entry(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind))))
		|| case when pg_temp.version(p_path) is null then '{}'::jsonb else jsonb_build_object('expectedVersion', pg_temp.version(p_path)) end
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
-- A run.toml.
create function pg_temp.rtoml(p_run uuid, p_conversation uuid, p_parent uuid default null, p_step integer default null,
	p_continues uuid default null, p_narrow boolean default false) returns text language sql as $$
	select format(E'format = 1\nrun = "%s"\nconversation = "%s"\n', p_run, p_conversation)
		|| case when p_parent is null then '' else format(E'parent = "%s"\nstep = %s\n', p_parent, p_step) end
		|| case when p_continues is null then '' else format(E'continues = "%s"\n', p_continues) end
		|| case when p_narrow then E'narrow = true\n' else '' end
$$;
-- A plain step line (finished when it has a result), a narrow one and an erased one.
create function pg_temp.step(p_j integer, p_args text default '{}', p_result jsonb default '{"ok":true}',
	p_paths jsonb default '[]', p_reads jsonb default '[]', p_tool text default 'read_file') returns text language sql as $$
	select jsonb_build_object('j', p_j, 'tool', p_tool, 'call', 'c' || p_j, 'args', p_args, 'args_bytes', octet_length(p_args),
		'args_hash', encode(extensions.digest(p_args, 'sha256'), 'hex'), 'result', p_result, 'reads', p_reads,
		'releases', '[]'::jsonb, 'paths', p_paths, 'text', 'Did it.', 'at', '2026-10-14T10:00:00Z')::text
$$;
create function pg_temp.nstep(p_j integer, p_finished boolean default true) returns text language sql as $$
	select (jsonb_build_object('j', p_j, 'tool', 'read_file', 'call', 'c' || p_j, 'args_hash', repeat('a', 64), 'narrow', true,
		'finished', p_finished, 'releases', '[]'::jsonb, 'at', '2026-10-14T10:00:00Z')
		|| case when p_finished then jsonb_build_object('result_hash', repeat('b', 64)) else '{}'::jsonb end)::text
$$;
create function pg_temp.erased_step(p_j integer) returns text language sql as $$
	select jsonb_build_object('j', p_j, 'tool', 'read_file', 'call', 'c' || p_j, 'args_hash', repeat('a', 64), 'erased', true,
		'args_bytes', 2)::text
$$;

-- A room run of otto's in launch: a group chat's log.
do $$
declare room jsonb;
begin
	room := pg_temp.room_run(pg_temp.id('otto'), 'launch');
	perform set_config('qorpera_test.binding_room', pg_temp.native(room)::text, true);
	perform set_config('qorpera_test.run_room', room ->> 'runId', true);
end $$;

-- 1. The parsers --------------------------------------------------------------------------------------------------------
do $$
declare
	r constant uuid := '95100000-0000-4000-8000-000000000001'; c constant uuid := '95100000-0000-4000-8000-000000000002';
	p constant uuid := '95100000-0000-4000-8000-000000000003'; k constant uuid := '95100000-0000-4000-8000-000000000004';
	t0 constant text := 'agents/nora/memory/thread/runs/95100000-0000-4000-8000-000000000001/t0/00000000.jsonl';
	x jsonb; v text;
begin
	-- run.toml: its lines in order, the optional ones only when they apply.
	perform pg_temp.same(public.qorpera_memory_run_toml(pg_temp.rtoml(r, c)), jsonb_build_object('run', r, 'conversation', c,
		'parent', null, 'step', null, 'continues', null, 'narrow', false), 'run.toml, the least');
	perform pg_temp.same(public.qorpera_memory_run_toml(pg_temp.rtoml(r, c, p, 3, k, true)), jsonb_build_object('run', r,
		'conversation', c, 'parent', p, 'step', 3, 'continues', k, 'narrow', true), 'run.toml, the most');
	perform pg_temp.same(to_jsonb(array[public.qorpera_memory_run_toml(left(pg_temp.rtoml(r, c), -1)) is null,
		public.qorpera_memory_run_toml(pg_temp.rtoml(r, c) || E'narrow = false\n') is null,
		public.qorpera_memory_run_toml(replace(pg_temp.rtoml(r, c, p, 3), 'step = 3', 'step = 03')) is null,
		public.qorpera_memory_run_toml(upper(pg_temp.rtoml(r, c))) is null,
		public.qorpera_memory_run_toml(format(E'format = 1\nrun = "%s"\nconversation = "%s"\ncontinues = "%s"\nparent = "%s"\nstep = 1\n',
			r, c, k, p)) is null,
		public.qorpera_memory_run_toml(format(E'format = 1\nrun = "%s"\nconversation = "%s"\nparent = "%s"\n', r, c, p)) is null,
		public.qorpera_memory_run_toml(null) is null]),
		to_jsonb(array[true, true, true, true, true, true, true]), 'run.toml refusals');

	-- A run tree's block: its name, size and lines.
	perform pg_temp.same(to_jsonb(array[
		pg_temp.block_result(t0, pg_temp.block(array[pg_temp.line(0, 0, 'a'), pg_temp.line(0, 15, 'b'), pg_temp.line(1, 7, 'c'),
			pg_temp.line(3, 1, 'd')])),
		pg_temp.block_result(replace(t0, '/t0/', '/t1/'), pg_temp.block(array[pg_temp.line(4, 0, 'a'), pg_temp.line(7, 0, 'b')])),
		pg_temp.block_result(replace(t0, '/t0/', '/t15/'), pg_temp.block(array[pg_temp.line(0, 0, 'a')])),
		pg_temp.block_result(replace(t0, '00000000.jsonl', '0.jsonl'), pg_temp.block(array[pg_temp.line(0, 0, 'a')])),
		pg_temp.block_result(t0, pg_temp.line(0, 0, 'a')),
		pg_temp.block_result(t0, ''),
		pg_temp.block_result(t0, pg_temp.block(array_fill(pg_temp.line(0, 0, 'a'), array[31]))),
		pg_temp.block_result(t0, pg_temp.block(array[pg_temp.line(0, 0, 'a'), pg_temp.line(0, 1, repeat('a', 2100))])),
		pg_temp.block_result(t0, pg_temp.block(array[pg_temp.line(0, 0, 'a'), pg_temp.line0(1, 5)])),
		pg_temp.block_result(t0, pg_temp.block(array['{"l":0,"k":0,"free":false,"text":"a"}'])),
		pg_temp.block_result(t0, pg_temp.block(array['{"l":0,"k":0,"free":true,"tries":1,"text":"a"}'])),
		pg_temp.block_result(t0, pg_temp.block(array[jsonb_build_object('l', 0, 'k', 0, 'free', true, 'text', E'a\tb')::text])),
		pg_temp.block_result(t0, pg_temp.block(array['{"l":0,"k":0,"k":0,"free":true,"text":"a"}'])),
		pg_temp.block_result(t0, pg_temp.block(array[pg_temp.line(4, 0, 'a')])),
		pg_temp.block_result(t0, pg_temp.block(array[pg_temp.line(0, 16, 'a')])),
		pg_temp.block_result(t0, pg_temp.block(array[pg_temp.line(1, 0, 'a'), pg_temp.line(0, 1, 'b')])),
		pg_temp.block_result(t0, pg_temp.block(array[pg_temp.line(0, 2, 'a'), pg_temp.line(0, 2, 'b')]))]),
		to_jsonb(array['lines 4', 'lines 2',
			'- a block''s name is t<tier>/<8 digits>.jsonl', '- a block''s name is t<tier>/<8 digits>.jsonl',
			'- a block is 1 to 30 lines, each ending in a newline, at most 65,004 bytes',
			'- a block is 1 to 30 lines, each ending in a newline, at most 65,004 bytes',
			'- a block is 1 to 30 lines, each ending in a newline, at most 65,004 bytes',
			'2 this line is longer than a summary line can be', '2 this line is not a summary line',
			'1 this line is not a summary line', '1 this line is not a summary line', '1 this line is not a summary line',
			'1 this line is not a summary line', '1 this line does not belong in this block',
			'1 this line does not belong in this block', '2 the lines go by level, then by number, each once',
			'2 the lines go by level, then by number, each once']), 'run tree blocks');

	-- A step line: the three shapes.
	x := public.qorpera_memory_run_step_line(pg_temp.step(0, '{"path":"contracts/a.md"}'));
	perform pg_temp.same(x - 'line_sha256' - 'fixed_sha256', jsonb_build_object('j', 0, 'tool', 'read_file', 'call', 'c0',
		'args_hash', encode(extensions.digest('{"path":"contracts/a.md"}', 'sha256'), 'hex'), 'narrow', false, 'erased', false,
		'finished', true, 'releases', '[]'::jsonb, 'paths', '["contracts/a.md"]'::jsonb), 'a plain line');
	perform pg_temp.same(to_jsonb(array[x ->> 'line_sha256', x ->> 'fixed_sha256']),
		to_jsonb(array[encode(extensions.digest(pg_temp.step(0, '{"path":"contracts/a.md"}'), 'sha256'), 'hex'),
			encode(extensions.digest(jsonb_build_object('j', 0, 'tool', 'read_file', 'call', 'c0',
				'args_hash', encode(extensions.digest('{"path":"contracts/a.md"}', 'sha256'), 'hex'), 'at', '2026-10-14T10:00:00Z')::text,
				'sha256'), 'hex')]), 'a line''s hashes');
	perform pg_temp.same(to_jsonb(array[
		(public.qorpera_memory_run_step_line(pg_temp.step(1, '{}', null)) ->> 'finished')::boolean,
		(public.qorpera_memory_run_step_line(pg_temp.nstep(2)) ->> 'narrow')::boolean,
		(public.qorpera_memory_run_step_line(pg_temp.nstep(2)) ->> 'finished')::boolean,
		(public.qorpera_memory_run_step_line(pg_temp.nstep(3, false)) ->> 'finished')::boolean,
		(public.qorpera_memory_run_step_line(pg_temp.erased_step(4)) ->> 'erased')::boolean,
		(public.qorpera_memory_run_step_line(pg_temp.erased_step(4)) ->> 'finished')::boolean]),
		to_jsonb(array[false, true, true, false, true, true]), 'pending, narrow and erased lines');
	perform pg_temp.same(public.qorpera_memory_run_step_line(pg_temp.erased_step(4)) -> 'releases', '[]'::jsonb, 'an erased line''s releases');

	-- A step's paths: its paths key, the args, the receipt and its json text, the reads; spelled as company paths.
	v := pg_temp.step(5, '{"from":"Notes/A.md","to":"/company/notes/b.md"}',
		jsonb_build_object('paths', jsonb_build_array('notes/c.md', 'notes//bad'),
			'content', jsonb_build_object('kind', 'json', 'text', '{"items":[{"path":"deals/d.md"}]}')),
		'["/company/plans/e.md", "plans"]', '[{"path":"reads/f.md","version":null}]');
	perform pg_temp.same(public.qorpera_memory_run_step_line(v) -> 'paths',
		'["deals/d.md", "notes/a.md", "notes/b.md", "notes/c.md", "plans", "plans/e.md", "reads/f.md"]', 'a line''s paths');
	-- Args cut short name nothing; a text that is not json, or not of kind json, names nothing.
	perform pg_temp.same(public.qorpera_memory_run_step_line(pg_temp.step(6, '{"path":"contracts/cu',
		jsonb_build_object('content', jsonb_build_object('kind', 'json', 'text', '{"path":"x')), '["contracts/cut.md"]')) -> 'paths',
		'["contracts/cut.md"]', 'cut args and a broken json text');
	perform pg_temp.same(public.qorpera_memory_run_step_line(pg_temp.step(6, '{}',
		jsonb_build_object('content', jsonb_build_object('kind', 'text', 'text', '{"path":"x.md"}')))) -> 'paths',
		'[]', 'a text receipt');

	-- Lines that are not step lines.
	perform pg_temp.same(to_jsonb(array[
		public.qorpera_memory_run_step_line(pg_temp.step(0)::jsonb - 'paths' #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{paths}', '"notes/a.md"') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{paths}', to_jsonb(array_fill('a'::text, array[1025])))
			#>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{paths}', jsonb_build_array(repeat('a', 4097)))
			#>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{paths}', '[1]') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{j}', '2147483648') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{j}', '-1') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{tool}', '""') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{args_hash}', '"xyz"') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{at}', '"2026-10-14 10:00"') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{extra}', 'true') #>> '{}') is null,
		public.qorpera_memory_run_step_line('{"j": 0, ' || substr(pg_temp.step(0), 2)) is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0, '{}', null)::jsonb, '{reads_cut}', 'true') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{reads_cut}', 'false') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0, '{}', null)::jsonb, '{reads}',
			'[{"path":"a.md","version":null}]') #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.nstep(0)::jsonb, '{narrow}', 'false') #>> '{}') is null,
		public.qorpera_memory_run_step_line(pg_temp.nstep(0)::jsonb - 'result_hash' #>> '{}') is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.erased_step(0)::jsonb, '{erased}', 'false') #>> '{}') is null,
		public.qorpera_memory_run_step_line('not json') is null,
		public.qorpera_memory_run_step_line(null) is null,
		public.qorpera_memory_run_step_line(jsonb_set(pg_temp.step(0)::jsonb, '{reads_cut}', 'true') #>> '{}') is not null]),
		to_jsonb(array_fill(true, array[21])), 'not step lines');

	-- Needles: each path and the folders above it.
	perform pg_temp.same(to_jsonb(public.qorpera_memory_run_step_needles('["notes/deals/a.md", "notes/b.md"]')),
		'["notes", "notes/b.md", "notes/deals", "notes/deals/a.md"]', 'needles');

	-- The kinds, the folder of a log and what a memory commit may do under a tree root.
	perform pg_temp.same(to_jsonb(array[
		public.qorpera_structured_path_kind('agents/nora/memory/thread/runs/' || r || '/run.toml'),
		public.qorpera_structured_path_kind('agents/nora/memory/thread/runs/' || r || '/log/00000000.jsonl'),
		public.qorpera_structured_path_kind(t0),
		public.qorpera_structured_path_kind('agents/groups/launch/memory/runs/' || r || '/run.toml'),
		public.qorpera_structured_path_kind('agents/groups/launch/memory/runs/' || r || '/log/00000003.jsonl'),
		public.qorpera_structured_path_kind('agents/groups/launch/memory/runs/' || r || '/t2/00000000.jsonl'),
		coalesce(public.qorpera_structured_path_kind('agents/nora/memory/runs/' || r || '/run.toml'), '-'),
		coalesce(public.qorpera_structured_path_kind('agents/nora/memory/thread/runs/' || r || '/log/0.jsonl'), '-'),
		coalesce(public.qorpera_memory_run_folder_key(t0), '-'),
		coalesce(public.qorpera_memory_run_folder_key('agents/nora/memory/thread/runs'), '-'),
		coalesce(public.qorpera_memory_run_folder_key('agents/nora/memory/thread/runs/x'), '-')]),
		to_jsonb(array['memory-run', 'memory-steps', 'memory-run-block', 'memory-run', 'memory-steps', 'memory-run-block', '-', '-',
			'agents/nora/memory/thread/runs/' || r, '-', '-']), 'kinds and log folders');
	perform pg_temp.same(to_jsonb(array[
		public.qorpera_memory_tree_path_allowed('runs', 'folder', 'mkdir'), public.qorpera_memory_tree_path_allowed('runs', 'folder', 'delete'),
		public.qorpera_memory_tree_path_allowed('runs/' || r, 'folder', 'new_folder'),
		public.qorpera_memory_tree_path_allowed('runs/' || r, 'folder', 'delete'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/log', 'folder', 'mkdir'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/t14', 'folder', 'mkdir'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/t15', 'folder', 'mkdir'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/run.toml', 'file', 'write'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/run.toml', 'file', 'delete'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/log/00000000.jsonl', 'file', 'write'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/log/00000000.jsonl', 'file', 'delete'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/t1/00000000.jsonl', 'file', 'delete'),
		public.qorpera_memory_tree_path_allowed('runs/' || r || '/notes.md', 'file', 'write'),
		public.qorpera_memory_tree_path_allowed('runs/' || replace(r::text, '-', ''), 'folder', 'mkdir'),
		public.qorpera_memory_tree_path_allowed('tree.toml', 'file', 'write')]),
		to_jsonb(array[true, false, true, true, true, true, false, true, false, true, false, true, false, false, true]), 'tree paths');
end $$;

-- 2. Where a run's log goes --------------------------------------------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	room constant uuid := pg_temp.run_id('room'); wc jsonb; x jsonb;
begin
	-- A run in its agent's thread: the thread's tree, and the folders on the way that are not there yet. Otto's tree is.
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, nora), jsonb_build_object('path',
		'agents/nora/memory/thread/runs/' || nora, 'exists', false, 'missing', jsonb_build_array('agents/nora/memory/thread',
		'agents/nora/memory/thread/runs'), 'last', null, 'generation', 0, 'gone', false, 'origin', jsonb_build_object(
		'conversation', pg_temp.thread('nora'), 'parent', null, 'step', null, 'continues', null, 'narrow', false)),
		'nora''s place');
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, pg_temp.run_id('otto')) -> 'missing',
		'["agents/otto/memory/thread/runs"]', 'otto''s place');
	-- A room run: the group chat's tree.
	x := public.qorpera_memory_run_log_place(env, room);
	perform pg_temp.same(jsonb_build_array(x -> 'path', x -> 'missing', x -> 'origin' -> 'conversation'), jsonb_build_array(
		'agents/groups/launch/memory/runs/' || room, jsonb_build_array('agents/groups/launch/memory',
		'agents/groups/launch/memory/runs'), pg_temp.chat('launch')), 'the room run''s place');
	-- A worker's completion continues the run that started the worker, in its conversation.
	wc := pg_temp.run(pg_temp.id('otto'), 'agent', '63400000-0000-4000-8000-000000000002', 'worker-completion', pg_temp.actor('otto'),
		extensions.gen_random_uuid());
	perform pg_temp.same(public.qorpera_memory_run_origin(env, (wc ->> 'runId')::uuid), jsonb_build_object('conversation',
		pg_temp.thread('otto'), 'parent', null, 'step', null, 'continues', pg_temp.run_id('otto'), 'narrow', false),
		'a worker completion''s origin');
	-- A run the company does not have.
	perform pg_temp.same(to_jsonb(array[public.qorpera_memory_run_origin(env, extensions.gen_random_uuid())]), '[null]',
		'an unknown run''s origin');
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, extensions.gen_random_uuid()), '{"gone": true}',
		'an unknown run''s place');
	-- Only the folder core's caller places a log, hashes and narrows steps, and commits memory.
	perform pg_temp.path_claims('authenticated');
	perform pg_temp.raises_like(format('select public.qorpera_memory_run_log_place(%L, %L)', env, nora), '42501',
		'Folder core authority is required');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_hashes(%L, %L, %L, %L)', env,
		pg_temp.actor('nora') ->> 'jobId', nora, '[]'), '42501', 'Folder core authority is required');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_narrow(%L, %L, %L, %L)', env,
		pg_temp.actor('nora') ->> 'jobId', nora, '[]'), '42501', 'Folder core authority is required');
	perform pg_temp.raises_like(format('select public.qorpera_folder_memory_commit(%L, %L, %L, %L)', env, '{"kind":"platform"}',
		'w1b:authority', '[]'), '42501', 'Folder core authority is required');
	perform pg_temp.path_claims('service_role');
end $$;

-- A run log's folder made with its run.toml, as a log's first batch makes it.
create function pg_temp.log_folder(p_path text, p_toml text, p_actor jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path',p_path,
		'contents', jsonb_build_array(jsonb_build_object('path','run.toml','kind','file','file',pg_temp.stage(p_toml, p_actor)),
			jsonb_build_object('path','log','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry(p_path || '/run.toml', 'memory-run', p_toml, '{"kind":"memory-run"}')))
$$;
-- A memory commit by a run, naming its log (and p_more preconditions).
create function pg_temp.logc(p_who text, p_key text, p_units jsonb, p_path text, p_more jsonb default '{}') returns jsonb
language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', pg_temp.actor(p_who), p_key, p_units,
		jsonb_build_object('runLog', jsonb_build_object('run', pg_temp.run_id(p_who), 'path', p_path)) || p_more)
$$;

-- 3. run.toml and the first batch ---------------------------------------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	a constant jsonb := pg_temp.actor('nora'); log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora');
	conv constant uuid := pg_temp.thread('nora'); r jsonb; l public.qorpera_memory_run_logs;
begin
	-- The folders on the way, as the run (each unit stands alone).
	r := pg_temp.logc('nora', 'w1b:toml:mk', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/nora/memory/thread'),
		jsonb_build_object('op','mkdir','path','agents/nora/memory/thread/runs')), log);
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, nora) -> 'missing', '[]', 'the folders on the way are there');
	-- A run.toml that is not one, names another run, or names an origin that is not the run's; a parse the platform did not make.
	r := pg_temp.logc('nora', 'w1b:toml:1', jsonb_build_array(pg_temp.log_folder(log, E'format = 1\n', a)), log);
	perform pg_temp.refused(r, 1, 'structured_invalid', 'run.toml is format = 1, run, conversation, then parent and step, '
		'continues and narrow = true when they apply, one per line');
	r := pg_temp.logc('nora', 'w1b:toml:2', jsonb_build_array(pg_temp.log_folder(log, pg_temp.rtoml(pg_temp.run_id('otto'), conv), a)),
		log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'run is this log''s own run, ' || nora);
	r := pg_temp.logc('nora', 'w1b:toml:3', jsonb_build_array(pg_temp.log_folder(log,
		pg_temp.rtoml(nora, conv, null, null, null, true), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule',
		'run.toml names the run''s conversation, parent step, the run it continues and whether it is narrow');
	r := pg_temp.logc('nora', 'w1b:toml:4', jsonb_build_array(pg_temp.log_folder(log, pg_temp.rtoml(nora, pg_temp.chat('launch')),
		a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule',
		'run.toml names the run''s conversation, parent step, the run it continues and whether it is narrow');
	r := pg_temp.logc('nora', 'w1b:toml:5', jsonb_build_array(jsonb_set(pg_temp.log_folder(log, pg_temp.rtoml(nora, conv), a),
		'{structured,0,parse}', '{"kind":"memory-run","run":"x"}')), log);
	perform pg_temp.refused(r, 1, 'structured_invalid', 'the platform could not read this file; save it again', 'front_matter');
	perform pg_temp.same(to_jsonb(array[(select count(*) from public.qorpera_memory_run_logs where environment_id = env and run_id = nora)]),
		'[0]', 'no log yet');

	-- The first batch: the log's folder with its run.toml and log/, and its first block, as the run.
	r := pg_temp.logc('nora', 'w1b:toml:ok', jsonb_build_array(pg_temp.log_folder(log, pg_temp.rtoml(nora, conv), a),
		pg_temp.rfile(log || '/log/00000000.jsonl', pg_temp.block(array[pg_temp.step(0, '{"path":"contracts/a.md"}'),
			pg_temp.step(1, '{}', null)]), a)), log);
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	select * into l from public.qorpera_memory_run_logs where environment_id = env and run_id = nora;
	perform pg_temp.same(jsonb_build_array(l.session_id, l.parent_run_id, l.parent_step, l.continues_run_id, l.narrow, l.run_path,
		l.run_key, l.toml_path_version, l.commit_id, l.step_count, l.narrow_from, l.retired_at), jsonb_build_array(conv, null, null,
		null, false, log, log, pg_temp.version(log || '/run.toml'), r ->> 'commitId', 2, null, null), 'nora''s log');
	perform pg_temp.same(to_jsonb(array[(select log_created_at is not null from public.qorpera_memory_run_generations
		where environment_id = env and run_id = nora)]), '[true]', 'the log is made');
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, nora), jsonb_build_object('path', log, 'exists', true,
		'missing', '[]'::jsonb, 'last', 0, 'generation', 0, 'gone', false), 'nora''s place, made');

	-- run.toml does not change.
	r := pg_temp.logc('nora', 'w1b:toml:6', jsonb_build_array(pg_temp.rfile(log || '/run.toml',
		pg_temp.rtoml(nora, conv, null, null, null, true), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run log''s run.toml does not change');
end $$;

rollback;
