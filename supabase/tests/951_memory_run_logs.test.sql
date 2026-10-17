-- @fixture 970_memory_branches.test.sql until "-- The checks start here."
-- Run logs W1b-1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §8; 20260930231000): the three file kinds and their
-- parsers; where a run's log goes (origin and place); run.toml, log blocks and run tree blocks with every refusal; the
-- paths a memory commit with runLog writes, and a run naming another run; the index (logs, steps, needles from `paths`,
-- the args and the receipt, cut args); what a run writes as itself (admits); step hashes and narrow paths; a stale run
-- generation and an open erase; a log that moves with its group, a log deleted and erased; a run whose machine went
-- narrow; the grants and host calls.
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
	-- The company is on the memory tree's list, so its runs keep logs (20260930352000).
	insert into public.qorpera_memory_tree_companies(profile_id) values ('63400000-0000-4000-8000-000000000010');
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
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, extensions.gen_random_uuid()), '{"off": true}',
		'an unknown run''s place (no conversation tree, so no log)');
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
			pg_temp.step(1, '{}', null, '["contracts/b.md"]')]), a)), log);
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

-- 4. Log blocks: nora's log holds step 0 (finished) and step 1 (pending, naming contracts/b.md) in log/00000000.jsonl ----
do $$
declare
	log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora'); a constant jsonb := pg_temp.actor('nora');
	b0 constant text := log || '/log/00000000.jsonl'; s0 constant text := pg_temp.step(0, '{"path":"contracts/a.md"}');
	otto constant text := 'agents/otto/memory/thread/runs/' || pg_temp.run_id('otto'); r jsonb;
begin
	-- No log yet: a block waits for its run.toml (a log folder made without one stays empty).
	r := pg_temp.logc('otto', 'w1b:block:otto', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/otto/memory/thread/runs'),
		jsonb_build_object('op','mkdir','path',otto), jsonb_build_object('op','mkdir','path',otto || '/log'),
		pg_temp.rfile(otto || '/log/00000000.jsonl', pg_temp.block(array[pg_temp.step(0)]), pg_temp.actor('otto'))), otto);
	perform pg_temp.refused(r, 4, 'structured_rule', 'write this log''s run.toml first');

	-- A block's size, and lines that are not the block's step lines.
	r := pg_temp.logc('nora', 'w1b:block:1', jsonb_build_array(pg_temp.rfile(log || '/log/00000002.jsonl', pg_temp.step(2), a)), log);
	perform pg_temp.refused(r, 1, 'structured_invalid',
		'a log block is 1 to 16 step lines, each ending in a newline, at most 65,536 bytes');
	r := pg_temp.logc('nora', 'w1b:block:2', jsonb_build_array(pg_temp.rfile(log || '/log/00000002.jsonl',
		pg_temp.block(array(select pg_temp.step(j) from generate_series(2, 18) j)), a)), log);
	perform pg_temp.refused(r, 1, 'structured_invalid',
		'a log block is 1 to 16 step lines, each ending in a newline, at most 65,536 bytes');
	r := pg_temp.logc('nora', 'w1b:block:3', jsonb_build_array(pg_temp.rfile(log || '/log/00000002.jsonl',
		pg_temp.block(array[pg_temp.step(2, '{"t":"' || repeat('x', 50200) || '"}')]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_invalid', 'this line is longer than a step line can be', 'value', 1);
	r := pg_temp.logc('nora', 'w1b:block:4', jsonb_build_array(pg_temp.rfile(log || '/log/00000002.jsonl',
		pg_temp.block(array[pg_temp.step(2), '{"j":3}']), a)), log);
	perform pg_temp.refused(r, 1, 'structured_invalid', 'this line is not a step line', 'value', 2);
	r := pg_temp.logc('nora', 'w1b:block:5', jsonb_build_array(pg_temp.rfile(log || '/log/00000002.jsonl',
		pg_temp.block(array[pg_temp.step(2), pg_temp.step(4)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_invalid', 'the steps go by j from the block''s number, each once', 'value', 2);

	-- What a block's steps may become.
	r := pg_temp.logc('nora', 'w1b:block:6', jsonb_build_array(pg_temp.rfile(log || '/log/00000001.jsonl',
		pg_temp.block(array[pg_temp.step(1)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 1 is in another block', 'value', 1);
	r := pg_temp.logc('nora', 'w1b:block:7', jsonb_build_array(pg_temp.rfile(b0,
		pg_temp.block(array[pg_temp.step(0, '{"path":"contracts/b.md"}'), pg_temp.step(1, '{}', null)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 0 is finished and does not change', 'value', 1);
	r := pg_temp.logc('nora', 'w1b:block:8', jsonb_build_array(pg_temp.rfile(b0,
		pg_temp.block(array[s0, pg_temp.step(1, '{"x":1}', null)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 1 changes only to its finished form', 'value', 2);
	-- A finished form that drops a path its pending line named, which an erase would then miss.
	r := pg_temp.logc('nora', 'w1b:block:paths', jsonb_build_array(pg_temp.rfile(b0,
		pg_temp.block(array[s0, pg_temp.step(1)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 1 keeps every path it named while pending', 'value', 2);
	r := pg_temp.logc('nora', 'w1b:block:9', jsonb_build_array(pg_temp.rfile(log || '/log/00000002.jsonl',
		pg_temp.block(array[pg_temp.erased_step(2)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'only an erase writes an erased step', 'value', 1);
	r := pg_temp.logc('nora', 'w1b:block:10', jsonb_build_array(pg_temp.rfile(b0, pg_temp.block(array[s0]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a log block keeps every step it holds');
	r := pg_temp.logc('nora', 'w1b:block:11', jsonb_build_array(pg_temp.rfile(log || '/log/00000003.jsonl',
		pg_temp.block(array[pg_temp.step(3)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a log block starts at the log''s next step');

	-- Step 1 finishes with its paths; two blocks in one commit, the second starting where the first ends.
	r := pg_temp.logc('nora', 'w1b:block:ok1', jsonb_build_array(pg_temp.rfile(b0, pg_temp.block(array[s0,
			pg_temp.step(1, '{}', '{"ok":true}', '["contracts/b.md"]')]), a),
		pg_temp.rfile(log || '/log/00000002.jsonl', pg_temp.block(array[pg_temp.step(2)]), a),
		pg_temp.rfile(log || '/log/00000003.jsonl', pg_temp.block(array[pg_temp.step(3)]), a)), log);
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;

	-- A path not every agent reads makes its step narrow, and every step after a narrow one is narrow.
	perform pg_temp.fx($q$insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id,
		policy, created_by_user_id) values ('63400000-0000-4000-8000-000000000020', 'private', 'subtree', 'member_private',
		'63400000-0000-4000-8000-000000000001', 'normal', '63400000-0000-4000-8000-000000000001')$q$);
	r := pg_temp.logc('nora', 'w1b:block:13', jsonb_build_array(pg_temp.rfile(log || '/log/00000004.jsonl',
		pg_temp.block(array[pg_temp.step(4, '{"path":"private/x.md"}')]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 4 names a path not every agent reads and is written narrow', 'value', 1);
	r := pg_temp.logc('nora', 'w1b:block:ok2', jsonb_build_array(pg_temp.rfile(log || '/log/00000004.jsonl',
		pg_temp.block(array[pg_temp.nstep(4)]), a)), log);
	perform pg_temp.expect(r, 1, 'saved');
	r := pg_temp.logc('nora', 'w1b:block:14', jsonb_build_array(pg_temp.rfile(log || '/log/00000005.jsonl',
		pg_temp.block(array[pg_temp.step(5)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 5 comes after a narrow step and is written narrow', 'value', 1);
	r := pg_temp.logc('nora', 'w1b:block:ok3', jsonb_build_array(pg_temp.rfile(log || '/log/00000005.jsonl',
		pg_temp.block(array[pg_temp.nstep(5, false)]), a)), log);
	perform pg_temp.expect(r, 1, 'saved');
end $$;

-- The room run's first batch makes its log folder with two blocks at once.
create function pg_temp.log_with_blocks(p_path text, p_toml text, p_actor jsonb, p_blocks text[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path',p_path,
		'contents', jsonb_build_array(jsonb_build_object('path','run.toml','kind','file','file',pg_temp.stage(p_toml, p_actor)),
			jsonb_build_object('path','log','kind','folder')) || (select jsonb_agg(jsonb_build_object('path',
				format('log/%s.jsonl', split_part(b, ':', 1)),'kind','file','file',pg_temp.stage(substr(b, 10), p_actor))) from unnest(p_blocks) b),
		'structured', jsonb_build_array(pg_temp.entry(p_path || '/run.toml', 'memory-run', p_toml, '{"kind":"memory-run"}'))
			|| (select jsonb_agg(pg_temp.entry(format('%s/log/%s.jsonl', p_path, split_part(b, ':', 1)), 'memory-steps', substr(b, 10),
				'{"kind":"memory-steps"}')) from unnest(p_blocks) b))
$$;
do $$
declare
	room constant uuid := pg_temp.run_id('room'); log constant text := 'agents/groups/launch/memory/runs/' || pg_temp.run_id('room');
	toml constant text := pg_temp.rtoml(pg_temp.run_id('room'), pg_temp.chat('launch')); a constant jsonb := pg_temp.actor('room');
	r jsonb;
begin
	r := pg_temp.logc('room', 'w1b:room:mk', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/groups/launch/memory'),
		jsonb_build_object('op','mkdir','path','agents/groups/launch/memory/runs')), log);
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- Two blocks that hold the same step.
	r := pg_temp.logc('room', 'w1b:room:1', jsonb_build_array(pg_temp.log_with_blocks(log, toml, a, array[
		'00000000:' || pg_temp.block(array[pg_temp.step(0), pg_temp.step(1)]), '00000001:' || pg_temp.block(array[pg_temp.step(1)])])), log);
	perform pg_temp.same(jsonb_build_array(r -> 'units' -> 0 -> 'reason', (select jsonb_agg(distinct p ->> 'message')
		from jsonb_array_elements(r -> 'units' -> 0 -> 'problems') p)), '["structured_rule", ["two log blocks hold the same step"]]',
		'two blocks hold the same step');
	-- A second block that starts where the first ends.
	r := pg_temp.logc('room', 'w1b:room:ok', jsonb_build_array(pg_temp.log_with_blocks(log, toml, a, array[
		'00000000:' || pg_temp.block(array[pg_temp.step(0)]), '00000001:' || pg_temp.block(array[pg_temp.step(1), pg_temp.step(2)])])), log);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(to_jsonb(array[(select step_count from public.qorpera_memory_run_logs where run_id = room)]), '[3]',
		'the room log''s steps');
end $$;

-- 5. A run's own summary tree ------------------------------------------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora'); a constant jsonb := pg_temp.actor('nora');
	otto constant text := 'agents/otto/memory/thread/runs/' || pg_temp.run_id('otto'); t0 constant text := log || '/t0/00000000.jsonl';
	gen constant jsonb := jsonb_build_object('runGenerations', jsonb_build_array(jsonb_build_object('runId', nora, 'generation', 0)));
	r jsonb;
begin
	-- A change to a run tree names the run's generation.
	r := pg_temp.logc('nora', 'w1b:tree:1', jsonb_build_array(jsonb_build_object('op','mkdir','path',log || '/t0')), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run tree''s change names its run''s generation');
	-- A block waits for its log's run.toml (otto's log has none).
	r := pg_temp.logc('otto', 'w1b:tree:2', jsonb_build_array(jsonb_build_object('op','mkdir','path',otto || '/t0'),
		pg_temp.rfile(otto || '/t0/00000000.jsonl', pg_temp.block(array['{"l":0,"k":0,"free":true,"text":"x"}']), pg_temp.actor('otto'))),
		otto, jsonb_build_object('runGenerations', jsonb_build_array(jsonb_build_object('runId', pg_temp.run_id('otto'), 'generation', 0))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.refused(r, 2, 'structured_rule', 'write this log''s run.toml first');
	-- The parser's problem and its line.
	r := pg_temp.logc('nora', 'w1b:tree:3', jsonb_build_array(jsonb_build_object('op','mkdir','path',log || '/t0'),
		pg_temp.rfile(t0, pg_temp.block(array['{"l":0,"k":0,"free":true,"text":"x"}', '{"l":0,"k":16,"free":true,"text":"y"}']), a)),
		log, gen);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.refused(r, 2, 'structured_invalid', 'this line does not belong in this block', 'value', 2);

	-- A block's lines go in the tree's index under the run, and a rewrite replaces them.
	r := pg_temp.logc('nora', 'w1b:tree:ok1', jsonb_build_array(pg_temp.rfile(t0, pg_temp.block(array[
		'{"l":0,"k":0,"free":true,"text":"x"}', '{"l":0,"k":1,"free":true,"text":"y"}', pg_temp.line(1, 0, 'xy')]), a)), log, gen);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(n.session_id, n.l, n.k, n.text, n.free, n.tries, n.seq, n.block_key)
		order by n.l, n.k) from public.qorpera_memory_tree_nodes n where n.environment_id = env and n.run_id = nora), jsonb_build_array(
		jsonb_build_array(pg_temp.thread('nora'), 0, 0, 'x', true, null, null, t0),
		jsonb_build_array(pg_temp.thread('nora'), 0, 1, 'y', true, null, null, t0),
		jsonb_build_array(pg_temp.thread('nora'), 1, 0, 'xy', false, 1, null, t0)), 'the run tree''s lines');
	r := pg_temp.logc('nora', 'w1b:tree:ok2', jsonb_build_array(pg_temp.rfile(t0, pg_temp.block(array[
		'{"l":0,"k":0,"free":true,"text":"x"}', '{"l":0,"k":1,"free":true,"text":"z"}']), a)), log, gen);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(n.l, n.k, n.text) order by n.l, n.k) from public.qorpera_memory_tree_nodes n
		where n.environment_id = env and n.run_id = nora), '[[0, 0, "x"], [0, 1, "z"]]', 'the rewritten run tree''s lines');
end $$;

-- 6. Whose log a change is ---------------------------------------------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora'); a constant jsonb := pg_temp.actor('nora');
	t0 constant text := log || '/t0/00000000.jsonl'; ottos constant text := 'agents/otto/memory/thread/runs/';
	gen constant jsonb := jsonb_build_object('runGenerations', jsonb_build_array(jsonb_build_object('runId', nora, 'generation', 0)));
	r jsonb;
begin
	-- A run names its own log; nobody else writes it, and only the platform deletes from it. (Each staged text is new.)
	-- With no runLog, a run's change is its conversation tree's (M1b-4b-2, 20260930300000), which names no generation here.
	r := public.qorpera_folder_memory_commit(env, a, 'w1b:whose:1', jsonb_build_array(pg_temp.rfile(t0,
		pg_temp.block(array['{"l":0,"k":0,"free":true,"text":"w1"}']), a)));
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run tree change names exactly its own conversation and generation');
	r := public.qorpera_folder_memory_commit(env, pg_temp.member(1), 'w1b:whose:2', jsonb_build_array(pg_temp.rfile(t0,
		pg_temp.block(array['{"l":0,"k":0,"free":true,"text":"w2"}']), pg_temp.member(1))),
		jsonb_build_object('runLog', jsonb_build_object('run', nora, 'path', log)) || gen);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run writes only its own run log');
	r := public.qorpera_folder_memory_commit(env, '{"kind":"platform"}', 'w1b:whose:3', jsonb_build_array(pg_temp.rfile(t0,
		pg_temp.block(array['{"l":0,"k":0,"free":true,"text":"w3"}']))));
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run log''s change names its run (runLog)');
	r := pg_temp.logc('nora', 'w1b:whose:4', jsonb_build_array(pg_temp.rfile(t0,
		pg_temp.block(array['{"l":0,"k":0,"free":true,"text":"w4"}']), a)), log || '/t0', gen);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run log''s folder is <tree>/runs/<its run>');
	r := pg_temp.logc('nora', 'w1b:whose:5', jsonb_build_array(jsonb_build_object('op','delete','path',t0,
		'expectedVersion',pg_temp.version(t0))), log, gen);
	perform pg_temp.refused(r, 1, 'structured_rule', 'only the platform deletes a run log''s files');
	r := pg_temp.logc('nora', 'w1b:whose:6', jsonb_build_array(jsonb_build_object('op','mkdir','path',
		'agents/nora/memory/thread/runs/' || extensions.gen_random_uuid())), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run log''s change writes only its own log folder');
	r := pg_temp.logc('nora', 'w1b:whose:7', jsonb_build_array(jsonb_build_object('op','mkdir','path',ottos || pg_temp.run_id('otto')
		|| '/t1')), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'a run log''s change writes only its own log folder');
	-- A run names no other run (F3), in its log or its generations.
	perform pg_temp.raises_like(format('select public.qorpera_folder_memory_commit(%L, %L, %L, %L, %L)', env, pg_temp.actor('otto'),
		'w1b:whose:8', '[]', jsonb_build_object('runLog', jsonb_build_object('run', nora, 'path', log))), '42501',
		'A run writes only its own run log');
	perform pg_temp.raises_like(format('select public.qorpera_folder_memory_commit(%L, %L, %L, %L, %L)', env, a, 'w1b:whose:9', '[]',
		jsonb_build_object('runLog', jsonb_build_object('run', nora, 'path', log), 'runGenerations', jsonb_build_array(
			jsonb_build_object('runId', pg_temp.run_id('otto'), 'generation', 0)))), '42501', 'A run writes only its own run log');
	-- A log is where it was made, and goes where its run's conversation tree is.
	r := pg_temp.logc('nora', 'w1b:whose:10', jsonb_build_array(jsonb_build_object('op','mkdir','path',ottos || nora)), ottos || nora);
	perform pg_temp.expect(r, 1, 'refused', 'memory_run_log_moved');
	r := pg_temp.logc('otto', 'w1b:whose:11', jsonb_build_array(jsonb_build_object('op','mkdir','path',
		'agents/nora/memory/thread/runs/' || pg_temp.run_id('otto'))), 'agents/nora/memory/thread/runs/' || pg_temp.run_id('otto'));
	perform pg_temp.expect(r, 1, 'refused', 'memory_run_log_moved');
end $$;

-- 7. The index of a log's steps ----------------------------------------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora'); s jsonb; l public.qorpera_memory_run_logs;
begin
	-- Steps 0 to 3 are plain and finished, 4 narrow and finished, 5 narrow and pending: needles only for a plain step.
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(s.j, s.tool, s.call_id, s.needles, s.narrow, s.erased, s.finished,
		s.block_key) order by s.j) from public.qorpera_memory_run_steps s where s.environment_id = env and s.run_id = nora),
		jsonb_build_array(
			jsonb_build_array(0, 'read_file', 'c0', array['contracts', 'contracts/a.md'], false, false, true, log || '/log/00000000.jsonl'),
			jsonb_build_array(1, 'read_file', 'c1', array['contracts', 'contracts/b.md'], false, false, true, log || '/log/00000000.jsonl'),
			jsonb_build_array(2, 'read_file', 'c2', array[]::text[], false, false, true, log || '/log/00000002.jsonl'),
			jsonb_build_array(3, 'read_file', 'c3', array[]::text[], false, false, true, log || '/log/00000003.jsonl'),
			jsonb_build_array(4, 'read_file', 'c4', array[]::text[], true, false, true, log || '/log/00000004.jsonl'),
			jsonb_build_array(5, 'read_file', 'c5', array[]::text[], true, false, false, log || '/log/00000005.jsonl')),
		'nora''s steps');
	-- A row keeps the line's hashes and its block's version.
	s := public.qorpera_memory_run_step_line(pg_temp.step(0, '{"path":"contracts/a.md"}'));
	perform pg_temp.same((select jsonb_build_array(r.args_hash, r.line_sha256, r.fixed_sha256, r.block_path_version)
		from public.qorpera_memory_run_steps r where r.environment_id = env and r.run_id = nora and r.j = 0),
		jsonb_build_array(s -> 'args_hash', s -> 'line_sha256', s -> 'fixed_sha256', pg_temp.version(log || '/log/00000000.jsonl')),
		'step 0''s hashes');
	-- The log counts its steps and knows where it went narrow.
	select * into l from public.qorpera_memory_run_logs where environment_id = env and run_id = nora;
	perform pg_temp.same(jsonb_build_array(l.step_count, l.narrow_from, l.narrow), '[6, 4, false]', 'nora''s log, counted');
	perform pg_temp.same(public.qorpera_memory_run_log_place(env, nora) -> 'last', '5', 'the last step');
end $$;

-- 8. What a run writes as itself, without the folder's grants ----------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora');
	me constant jsonb := jsonb_build_object('kind', 'staff_agent', 'runId', pg_temp.run_id('nora'));
	room constant text := 'agents/groups/launch/memory/runs/' || pg_temp.run_id('room');
	nf constant jsonb := jsonb_build_object('contents', jsonb_build_array(jsonb_build_object('path','run.toml'),
		jsonb_build_object('path','log')));
begin
	-- No memory request: nothing.
	perform pg_temp.same(to_jsonb(array[public.qorpera_memory_run_log_admits(env, 'k', me, 'write', log || '/log/00000006.jsonl', '{}')]),
		'[false]', 'no memory request');
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', env::text, 'operationKey', 'k', 'preconditions',
		jsonb_build_object('runLog', jsonb_build_object('run', nora, 'path', log)))::text, true);
	-- Its own log folder, and the memory folders on the way to it; not what is beside them, not the agent's folder.
	perform pg_temp.same(to_jsonb(array[
		public.qorpera_memory_run_log_admits(env, 'k', me, 'write', log || '/log/00000006.jsonl', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'mkdir', log || '/t1', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'new_folder', log, nf),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'mkdir', 'agents/nora/memory/thread/runs', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'mkdir', 'agents/nora/memory', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'mkdir', 'agents/nora', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'write', 'agents/nora/memory/thread/tree.toml', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'mkdir', 'agents/nora/memory/thread/runs/' || gen_random_uuid(), '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'delete', log || '/log/00000005.jsonl', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', me, 'move', log || '/log/00000005.jsonl', '{}')]),
		'[true, true, true, true, true, false, false, false, false, false]', 'what the run writes');
	-- Only in its request, and only as the log's run.
	perform pg_temp.same(to_jsonb(array[
		public.qorpera_memory_run_log_admits(env, 'other', me, 'write', log || '/log/00000006.jsonl', '{}'),
		public.qorpera_memory_run_log_admits(gen_random_uuid(), 'k', me, 'write', log || '/log/00000006.jsonl', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', jsonb_build_object('kind', 'staff_agent', 'runId', pg_temp.run_id('otto')), 'write',
			log || '/log/00000006.jsonl', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', pg_temp.actor('nora'), 'write', log || '/log/00000006.jsonl', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', '{"kind":"platform"}', 'write', log || '/log/00000006.jsonl', '{}')]),
		'[false, false, false, false, false]', 'whose request');
	-- A request whose log is not a log folder admits nothing.
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', env::text, 'operationKey', 'k', 'preconditions',
		jsonb_build_object('runLog', jsonb_build_object('run', nora, 'path', log || '/log')))::text, true);
	perform pg_temp.same(to_jsonb(array[public.qorpera_memory_run_log_admits(env, 'k', me, 'write', log || '/log/00000006.jsonl', '{}')]),
		'[false]', 'not a log folder');
	-- A room run's log, in the group's memory.
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', env::text, 'operationKey', 'k', 'preconditions',
		jsonb_build_object('runLog', jsonb_build_object('run', pg_temp.run_id('room'), 'path', room)))::text, true);
	perform pg_temp.same(to_jsonb(array[
		public.qorpera_memory_run_log_admits(env, 'k', jsonb_build_object('kind', 'staff_agent', 'runId', pg_temp.run_id('room')), 'mkdir',
			'agents/groups/launch/memory', '{}'),
		public.qorpera_memory_run_log_admits(env, 'k', jsonb_build_object('kind', 'staff_agent', 'runId', pg_temp.run_id('room')), 'mkdir',
			'agents/groups/launch', '{}')]), '[true, false]', 'a room run''s log');
	-- A memory commit inside another one is refused.
	perform pg_temp.raises_like(format('select public.qorpera_folder_memory_commit(%L, %L, %L, %L)', env, '{"kind":"platform"}',
		'w1b:nested', '[]'), '55000', 'A memory request is already set in this transaction');
	perform set_config('qorpera.folder_memory', '', true);
end $$;

-- 9. Step hashes and narrow paths, while the run's job holds its lease --------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	otto constant uuid := pg_temp.run_id('otto'); job constant uuid := (pg_temp.actor('nora') ->> 'jobId')::uuid;
	ojob constant uuid := (pg_temp.actor('otto') ->> 'jobId')::uuid; d1 constant text := repeat('a', 64);
	d2 constant text := repeat('0', 63) || '1'; h jsonb; k bytea;
begin
	-- A keyed hash of each digest under the run, in order; the same digest under another run hashes apart.
	h := public.qorpera_memory_step_hashes(env, job, nora, jsonb_build_array(d1, d2));
	select key into k from public.qorpera_memory_step_hash_keys where environment_id = env;
	perform pg_temp.same(h, jsonb_build_array(
		encode(extensions.hmac(convert_to(nora::text || ':' || d1, 'utf8'), k, 'sha256'), 'hex'),
		encode(extensions.hmac(convert_to(nora::text || ':' || d2, 'utf8'), k, 'sha256'), 'hex')), 'step hashes');
	perform pg_temp.same(public.qorpera_memory_step_hashes(env, job, nora, jsonb_build_array(d1)), jsonb_build_array(h -> 0),
		'the same hash again');
	perform pg_temp.same(to_jsonb(array[public.qorpera_memory_step_hashes(env, ojob, otto, jsonb_build_array(d1)) -> 0 <> h -> 0]),
		'[true]', 'another run''s hash');
	perform pg_temp.same(public.qorpera_memory_step_hashes(env, job, nora, '[]'), '[]', 'no digests');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_hashes(%L, %L, %L, %L)', env, ojob, nora, '[]'), '42501',
		'The run''s lease is not held');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_hashes(%L, %L, %L, %L)', env, job, nora, '{}'), '22023',
		'Step digests are a list of sha256 digests');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_hashes(%L, %L, %L, %L)', env, job, nora,
		jsonb_build_array(upper(d1))), '22023', 'Step digests are a list of sha256 digests');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_hashes(%L, %L, %L, %L)', env, job, nora,
		(select jsonb_agg(d1) from generate_series(1, 129))), '22023', 'Step digests are a list of sha256 digests');

	-- Narrow: nora's log went narrow at step 4; otto has no log. The paths not every agent reads, as given.
	perform pg_temp.same(public.qorpera_memory_step_narrow(env, job, nora, '["contracts/a.md", "private/x.md", "/company/Private/y.md",
		"notes//bad", "/company/contracts/b.md"]'), '{"log": true, "machine": false, "restricted": ["private/x.md",
		"/company/Private/y.md"]}', 'nora''s narrow paths');
	perform pg_temp.same(public.qorpera_memory_step_narrow(env, ojob, otto, '["contracts/a.md"]'),
		'{"log": false, "machine": false, "restricted": []}', 'otto''s narrow paths');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_narrow(%L, %L, %L, %L)', env, job, otto, '[]'), '42501',
		'The run''s lease is not held');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_narrow(%L, %L, %L, %L)', env, job, nora, '"x"'), '22023',
		'Step paths are a list of at most 1,024 paths');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_narrow(%L, %L, %L, %L)', env, job, nora, '[1]'), '22023',
		'Step paths are a list of at most 1,024 paths');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_narrow(%L, %L, %L, %L)', env, job, nora,
		jsonb_build_array(repeat('a', 4097))), '22023', 'Step paths are a list of at most 1,024 paths');
	perform pg_temp.raises_like(format('select public.qorpera_memory_step_narrow(%L, %L, %L, %L)', env, job, nora,
		(select jsonb_agg('a.md'::text) from generate_series(1, 1025))), '22023', 'Step paths are a list of at most 1,024 paths');
end $$;

-- 10. A batch's generations and an open erase, at decide ------------------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora'); a constant jsonb := pg_temp.actor('nora');
	room constant text := 'agents/groups/launch/memory/runs/' || pg_temp.run_id('room'); b6 constant text := log || '/log/00000006.jsonl';
	sg constant bigint := (select s.memory_generation from public.qorpera_shared_sessions s where s.id = pg_temp.thread('nora'));
	r jsonb;
begin
	-- A stale run generation, or a stale session generation, refuses the batch.
	r := pg_temp.logc('nora', 'w1b:decide:1', jsonb_build_array(pg_temp.rfile(b6, pg_temp.block(array[pg_temp.nstep(6)]), a)), log,
		jsonb_build_object('runGenerations', jsonb_build_array(jsonb_build_object('runId', nora, 'generation', 1))));
	perform pg_temp.expect(r, 1, 'refused', 'memory_generation_stale');
	r := pg_temp.logc('nora', 'w1b:decide:2', jsonb_build_array(pg_temp.rfile(b6, pg_temp.block(array[pg_temp.nstep(6)]), a)), log,
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', pg_temp.thread('nora'),
			'generation', sg + 1))));
	perform pg_temp.expect(r, 1, 'refused', 'memory_generation_stale');

	-- An erase open on a run refuses its log's batches, and only its own.
	perform pg_temp.fx(format('update public.qorpera_memory_run_generations set erase_open = %L where environment_id = %L and run_id = %L',
		extensions.gen_random_uuid(), env, nora));
	r := pg_temp.logc('nora', 'w1b:decide:3', jsonb_build_array(pg_temp.rfile(b6, pg_temp.block(array[pg_temp.nstep(6)]), a)), log);
	perform pg_temp.expect(r, 1, 'refused', 'memory_erase_open');
	r := pg_temp.logc('room', 'w1b:decide:4', jsonb_build_array(pg_temp.rfile(room || '/log/00000003.jsonl',
		pg_temp.block(array[pg_temp.step(3)]), pg_temp.actor('room'))), room);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.fx(format('update public.qorpera_memory_run_generations set erase_open = null where environment_id = %L and run_id = %L',
		env, nora));

	-- With its generations current, the batch is saved.
	r := pg_temp.logc('nora', 'w1b:decide:5', jsonb_build_array(pg_temp.rfile(b6, pg_temp.block(array[pg_temp.nstep(6)]), a)), log,
		jsonb_build_object('runGenerations', jsonb_build_array(jsonb_build_object('runId', nora, 'generation', 0)),
			'sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', pg_temp.thread('nora'), 'generation', sg))));
	perform pg_temp.expect(r, 1, 'saved');

	-- A memory request that is not this change's.
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', env, 'operationKey', 'w1b:someone-else',
		'preconditions', '{}'::jsonb)::text, true);
	r := pg_temp.commit('{"kind":"platform"}', 'w1b:decide:6', jsonb_build_array(jsonb_build_object('op','mkdir',
		'path','agents/groups/launch/w1b-decide')));
	perform set_config('qorpera.folder_memory', '', true);
	perform pg_temp.refused(r, 1, 'structured_rule', 'the memory request does not belong to this change');
end $$;

-- 11. A log follows its group's rename ------------------------------------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; room constant uuid := pg_temp.run_id('room');
	was constant text := 'agents/groups/launch/memory/runs/' || pg_temp.run_id('room');
	log constant text := 'agents/groups/launch-team/memory/runs/' || pg_temp.run_id('room'); a constant jsonb := pg_temp.actor('room');
	l public.qorpera_memory_run_logs; x jsonb; r jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'w1b:move:1', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/groups/launch','to','agents/groups/launch-team','expectedVersion',pg_temp.version('agents/groups/launch'),
		'asOfSeq',pg_temp.seq()))), 1, 'saved');
	select * into l from public.qorpera_memory_run_logs where environment_id = env and run_id = room;
	perform pg_temp.same(jsonb_build_array(l.run_path, l.run_key, l.toml_path_version = pg_temp.version(log || '/run.toml')),
		jsonb_build_array(log, public.qorpera_folder_key(log), true), 'the room log follows the rename');
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(s.j, s.block_path, s.block_path_version = pg_temp.version(s.block_key))
		order by s.j) from public.qorpera_memory_run_steps s where s.environment_id = env and s.run_id = room), jsonb_build_array(
		jsonb_build_array(0, log || '/log/00000000.jsonl', true), jsonb_build_array(1, log || '/log/00000001.jsonl', true),
		jsonb_build_array(2, log || '/log/00000001.jsonl', true), jsonb_build_array(3, log || '/log/00000003.jsonl', true)),
		'the room log''s steps follow it');
	x := public.qorpera_memory_run_log_place(env, room);
	perform pg_temp.same(jsonb_build_array(x -> 'path', x -> 'exists', x -> 'missing', x -> 'last'),
		jsonb_build_array(log, true, '[]'::jsonb, 3), 'the room log''s place follows it');

	-- The old folder is gone (the core refuses a write there as parent_missing); a batch naming the new one is saved.
	r := pg_temp.logc('room', 'w1b:move:2', jsonb_build_array(pg_temp.rfile(was || '/log/00000004.jsonl',
		pg_temp.block(array[pg_temp.step(4)]), a)), was);
	perform pg_temp.expect(r, 1, 'refused', 'parent_missing');
	r := pg_temp.logc('room', 'w1b:move:3', jsonb_build_array(pg_temp.rfile(log || '/log/00000004.jsonl',
		pg_temp.block(array[pg_temp.step(4)]), a)), log);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(to_jsonb(array[(select step_count from public.qorpera_memory_run_logs where run_id = room)]), '[5]',
		'the moved room log''s steps');
end $$;

-- 12. Deletes retire a log and take its steps; an erase takes the retired rows under its roots -------------------------
create function pg_temp.pdelete(p_key text, p_path text, p_log jsonb default null) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key,
		jsonb_build_array(jsonb_build_object('op','delete','path',p_path,'expectedVersion',pg_temp.version(p_path),'asOfSeq',pg_temp.seq())),
		case when p_log is null then '{}'::jsonb else jsonb_build_object('runLog', p_log) end)
$$;
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; nora constant uuid := pg_temp.run_id('nora');
	room constant uuid := pg_temp.run_id('room'); log constant text := 'agents/nora/memory/thread/runs/' || pg_temp.run_id('nora');
	a constant jsonb := pg_temp.actor('nora'); nlog constant jsonb := jsonb_build_object('run', pg_temp.run_id('nora'), 'path', log);
	other constant uuid := extensions.gen_random_uuid(); r jsonb;
begin
	-- Only a log is deleted, whole: not one of its blocks.
	r := pg_temp.pdelete('w1b:delete:1', log || '/log/00000002.jsonl', nlog);
	perform pg_temp.refused(r, 1, 'structured_rule',
		'a summary tree holds only tree.toml, its blocks and its images; only blocks and images are deleted');
	-- A step row gone from under its block (only a fault leaves that) refuses the block's rewrite.
	perform pg_temp.fx(format('delete from public.qorpera_memory_run_steps where environment_id = %L and run_id = %L and j = 2',
		env, nora));
	r := pg_temp.logc('nora', 'w1b:delete:2', jsonb_build_array(pg_temp.rfile(log || '/log/00000002.jsonl',
		pg_temp.block(array[pg_temp.step(2)]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 2 is missing from its block', 'value', 1);

	-- A deleted log folder retires the log and takes every step; the run's log does not come back.
	perform pg_temp.expect(pg_temp.pdelete('w1b:delete:3', log, nlog), 1, 'saved');
	perform pg_temp.same((select jsonb_build_array(l.retired_at is not null, (select count(*) from public.qorpera_memory_run_steps s
		where s.environment_id = env and s.run_id = nora)) from public.qorpera_memory_run_logs l
		where l.environment_id = env and l.run_id = nora), '[true, 0]', 'a deleted log retires');
	r := pg_temp.logc('nora', 'w1b:delete:4', jsonb_build_array(pg_temp.log_folder(log, pg_temp.rtoml(nora, pg_temp.thread('nora')), a)),
		log);
	perform pg_temp.expect(r, 1, 'refused', 'memory_run_log_gone');
	-- A request for the log of a run the company does not have is not a memory request.
	perform pg_temp.raises_like(format('select public.qorpera_folder_memory_commit(%L, %L, %L, %L, %L)', env, '{"kind":"platform"}',
		'w1b:delete:5', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/nora/memory/thread/runs/' || other)),
		jsonb_build_object('runLog', jsonb_build_object('run', other, 'path', 'agents/nora/memory/thread/runs/' || other))),
		'22023', 'Memory request is invalid');

	-- A deleted group folder retires the logs in it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'w1b:delete:6', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/groups/launch-team','expectedVersion',pg_temp.version('agents/groups/launch-team'),'asOfSeq',pg_temp.seq()))),
		1, 'saved');
	perform pg_temp.same((select jsonb_build_array(l.retired_at is not null, (select count(*) from public.qorpera_memory_run_steps s
		where s.environment_id = env and s.run_id = room)) from public.qorpera_memory_run_logs l
		where l.environment_id = env and l.run_id = room), '[true, 0]', 'a deleted group''s log retires');

	-- An erase deletes the retired log rows under its roots, and only those.
	r := public.qorpera_folder_erase(env, pg_temp.member(1), '["agents/groups/launch-team", "agents/groups/launch"]', 'w1b:erase:1');
	perform pg_temp.same((select jsonb_agg(l.run_id order by l.run_id) from public.qorpera_memory_run_logs l
		where l.environment_id = env and l.run_id in (nora, room)), jsonb_build_array(nora), 'an erase takes the room''s log row');
	r := public.qorpera_folder_erase(env, pg_temp.member(1), jsonb_build_array(log), 'w1b:erase:2');
	perform pg_temp.same(to_jsonb(array[(select count(*) from public.qorpera_memory_run_logs l
		where l.environment_id = env and l.run_id = nora)]), '[0]', 'an erase of the log takes its row');
end $$;

-- 13. A run whose machine went narrow writes narrow lines only -----------------------------------------------------------
do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; otto constant uuid := pg_temp.run_id('otto');
	log constant text := 'agents/otto/memory/thread/runs/' || pg_temp.run_id('otto'); a constant jsonb := pg_temp.actor('otto');
	ojob constant uuid := (pg_temp.actor('otto') ->> 'jobId')::uuid; b0 constant text := log || '/log/00000000.jsonl'; r jsonb;
	-- Step 0 pending and plain, naming contracts/a.md; its narrow form has the same arguments and names nothing.
	n0 constant text := jsonb_set(pg_temp.nstep(0)::jsonb, '{args_hash}', pg_temp.step(0)::jsonb -> 'args_hash')::text;
begin
	-- Otto's log folder gets its run.toml and pending step 0 while otto is not narrow.
	perform pg_temp.same(to_jsonb(array[public.qorpera_run_log_narrow(otto)]), '[false]', 'otto is not narrow');
	r := pg_temp.logc('otto', 'w1b:machine:1', jsonb_build_array(pg_temp.rfile(log || '/run.toml',
		pg_temp.rtoml(otto, pg_temp.thread('otto')), a), pg_temp.rfile(b0, pg_temp.block(array[pg_temp.step(0, '{}', null,
		'["contracts/a.md"]')]), a)), log);
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;

	-- W6a says when a run's machine went narrow; until then no machine does. Here otto's has (rolled back with the test).
	execute format($f$create or replace function public.qorpera_memory_run_machine_narrow(p_environment_id uuid, p_run_id uuid)
		returns boolean language sql stable set search_path = '' as $b$ select p_run_id = %L::uuid $b$ $f$, otto);
	perform pg_temp.same(to_jsonb(array[public.qorpera_run_log_narrow(otto),
		(public.qorpera_memory_run_origin(env, otto) ->> 'narrow')::boolean]), '[true, true]', 'otto''s machine made otto narrow');
	perform pg_temp.same(public.qorpera_memory_step_narrow(env, ojob, otto, '[]'), '{"log": false, "machine": true, "restricted": []}',
		'otto''s machine went narrow');

	-- From then on a plain step is refused and a narrow one saved: the narrow form drops the paths its pending line named.
	r := pg_temp.logc('otto', 'w1b:machine:2', jsonb_build_array(pg_temp.rfile(b0, pg_temp.block(array[pg_temp.step(0, '{}',
		'{"ok":true}', '["contracts/a.md"]')]), a)), log);
	perform pg_temp.refused(r, 1, 'structured_rule', 'step 0 comes after its machine went narrow and is written narrow', 'value', 1);
	perform pg_temp.expect(pg_temp.logc('otto', 'w1b:machine:3', jsonb_build_array(pg_temp.rfile(b0,
		pg_temp.block(array[n0]), a)), log), 1, 'saved');
	perform pg_temp.same((select jsonb_build_array(s.needles, s.narrow, s.finished) from public.qorpera_memory_run_steps s
		where s.environment_id = env and s.run_id = otto and s.j = 0), jsonb_build_array(array[]::text[], true, true),
		'otto''s step 0 is narrow and names nothing');
	perform pg_temp.same(public.qorpera_memory_step_narrow(env, ojob, otto, '[]'), '{"log": true, "machine": true, "restricted": []}',
		'otto''s log is narrow from its first step');
end $$;

-- 14. Who may call and read ----------------------------------------------------------------------------------------------
do $$
begin
	-- The service role calls the four host calls and the memory commit and reads the run-log tables; it writes none of them.
	perform pg_temp.same(to_jsonb(array[
		has_function_privilege('service_role', 'public.qorpera_memory_run_origin(uuid,uuid)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_run_log_place(uuid,uuid)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_step_hashes(uuid,uuid,uuid,jsonb)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_memory_step_narrow(uuid,uuid,uuid,jsonb)', 'execute'),
		has_function_privilege('service_role', 'public.qorpera_folder_memory_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)', 'execute'),
		has_function_privilege('authenticated', 'public.qorpera_memory_run_log_place(uuid,uuid)', 'execute'),
		has_function_privilege('anon', 'public.qorpera_memory_step_narrow(uuid,uuid,uuid,jsonb)', 'execute'),
		has_function_privilege('authenticated', 'public.qorpera_memory_step_hashes(uuid,uuid,uuid,jsonb)', 'execute'),
		has_table_privilege('service_role', 'public.qorpera_memory_run_logs', 'select'),
		has_table_privilege('service_role', 'public.qorpera_memory_run_steps', 'select'),
		has_table_privilege('service_role', 'public.qorpera_memory_run_generations', 'select'),
		has_table_privilege('service_role', 'public.qorpera_memory_run_logs', 'update'),
		has_table_privilege('service_role', 'public.qorpera_memory_run_steps', 'insert'),
		has_table_privilege('service_role', 'public.qorpera_memory_run_generations', 'update'),
		has_table_privilege('service_role', 'public.qorpera_memory_step_hash_keys', 'select'),
		has_table_privilege('authenticated', 'public.qorpera_memory_run_logs', 'select'),
		has_table_privilege('anon', 'public.qorpera_memory_run_steps', 'select')]),
		'[true,true,true,true,true,false,false,false,true,true,true,false,false,false,false,false,false]', 'who calls and reads');
	-- Nothing else of W1b is anyone's to call.
	perform pg_temp.same(coalesce((select jsonb_agg(f order by f) from unnest(array[
		'public.qorpera_memory_run_folder_key(text)', 'public.qorpera_memory_run_toml(text)',
		'public.qorpera_memory_run_block_line(text)', 'public.qorpera_memory_run_block_parse(text,text)',
		'public.qorpera_memory_run_step_line(text)', 'public.qorpera_memory_run_step_needles(jsonb)',
		'public.qorpera_folder_path_every_agent(uuid,text)', 'public.qorpera_memory_run_machine_narrow(uuid,uuid)',
		'public.qorpera_run_log_narrow(uuid)', 'public.qorpera_memory_conversation_root(uuid,uuid,uuid)',
		'public.qorpera_memory_run_log_home(uuid,uuid)', 'public.qorpera_memory_run_generations_lock(uuid,text)',
		'public.qorpera_memory_run_log_paths(uuid,jsonb,text,text,jsonb,text)',
		'public.qorpera_memory_run_log_admits(uuid,text,jsonb,text,text,jsonb)',
		'public.qorpera_memory_run_log_file_rules(uuid,jsonb,text,text,jsonb,text)',
		'public.qorpera_memory_run_log_index(uuid,uuid,text,text,uuid,text,text)',
		'public.qorpera_memory_run_log_moved(uuid,uuid,text,text,text)', 'public.qorpera_memory_run_log_deleted(uuid,uuid,text)',
		'public.qorpera_memory_run_log_targets(uuid,jsonb)', 'public.qorpera_memory_tree_path_allowed(text,text,text)']) f
		where has_function_privilege('service_role', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
			or has_function_privilege('anon', f, 'execute')), '[]'::jsonb), '[]', 'nothing else is callable');
end $$;

rollback;
