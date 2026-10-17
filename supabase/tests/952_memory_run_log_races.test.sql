-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Run logs W1b-1 under concurrency (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §8; 20260930231000): two first
-- batches of one run's log; a batch against a stale run generation and against an open erase; a batch against its
-- agent's rename and against its group's delete. In each race one connection holds its transaction open, the batch on
-- another waits for it, and then saves, conflicts or is refused. On 648's committed company, with leased runs of Ada's in her
-- thread and in a group chat (648's own run has no conversation a log lives in); the fixture goes at the end.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}'::jsonb
$$;
create or replace function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020' and key_text = p_key
		and kind is distinct from 'claim'
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '64800000-0000-4000-8000-000000000020'
$$;
-- Ada's thread, and the launch group's chat.
create function pg_temp.thread() returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000a1'
$$;
create function pg_temp.chat() returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = '95200000-0000-4000-8000-0000000000b1'
$$;
-- A leased run of Ada's on a message in a conversation, committed (as 951's room runs); its actor is kept by name.
create function pg_temp.run(p_name text, p_session uuid) returns void language plpgsql as $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_staff uuid := '64800000-0000-4000-8000-0000000000a1'; v_owner uuid := '64800000-0000-4000-8000-000000000001';
	v_sponsor uuid := '64800000-0000-4000-8000-0000000000b1'; v_bundle uuid := '64800000-0000-4000-8000-0000000000f9';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_input uuid := extensions.gen_random_uuid();
begin
	if p_session is null then raise exception 'Run %: no conversation', p_name; end if;
	set local session_replication_role = replica;
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256)
	values (v_input, p_session, extensions.gen_random_uuid(), v_owner, 'human', 'user_message', v_bundle, repeat('b', 64));
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_owner, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, audience_user_id, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'room_delivery', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_owner, v_owner, 'openai', 'gpt-test',
		'provider_default', 'company', null, v_bundle, repeat('b', 64), p_session, '{}'::uuid[]);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'room', v_wake::text, clock_timestamp(), clock_timestamp(), 'room', 'room', v_input,
		v_run, 'materialized', v_staff, 1, v_owner, v_sponsor, 1, p_session, v_wake, array[v_staff], '{}'::jsonb);
	set local session_replication_role = origin;
	perform set_config('qorpera_test.run_' || p_name, jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,
		'assignmentId',v_assignment)::text, false);
end $$;
create function pg_temp.actor(p_name text) returns jsonb language sql as $$ select current_setting('qorpera_test.run_' || p_name)::jsonb $$;
create function pg_temp.run_id(p_name text) returns uuid language sql as $$ select (pg_temp.actor(p_name) ->> 'runId')::uuid $$;

-- A run log's files as the TS parser sends them; a rewrite names the version it replaces.
create function pg_temp.rfile(p_path text, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind))))
		|| case when pg_temp.version(p_path) is null then '{}'::jsonb else jsonb_build_object('expectedVersion', pg_temp.version(p_path)) end
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
create function pg_temp.rtoml(p_run uuid, p_conversation uuid) returns text language sql as $$
	select format(E'format = 1\nrun = "%s"\nconversation = "%s"\n', p_run, p_conversation)
$$;
-- Step j's block in the log, with that one finished step.
create function pg_temp.step(p_log text, p_j integer) returns jsonb language sql as $$
	select pg_temp.rfile(p_log || '/log/' || lpad(p_j::text, 8, '0') || '.jsonl', jsonb_build_object('j', p_j, 'tool', 'read_file',
		'call', 'c' || p_j, 'args', '{}', 'args_bytes', 2, 'args_hash', encode(extensions.digest('{}', 'sha256'), 'hex'),
		'result', '{"ok":true}'::jsonb, 'reads', '[]'::jsonb, 'releases', '[]'::jsonb, 'paths', '[]'::jsonb, 'text', 'Did it.',
		'at', '2026-10-14T10:00:00Z')::text || E'\n')
$$;
-- A run log's folder made with its run.toml, as a log's first batch makes it.
create function pg_temp.log_folder(p_path text, p_toml text) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path',p_path,
		'contents', jsonb_build_array(jsonb_build_object('path','run.toml','kind','file','file',pg_temp.stage(p_toml)),
			jsonb_build_object('path','log','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry(p_path || '/run.toml', 'memory-run', p_toml, '{"kind":"memory-run"}')))
$$;
-- A memory commit by a run, naming its log (and p_more preconditions), in this connection.
create function pg_temp.logc(p_name text, p_key text, p_units jsonb, p_path text, p_more jsonb default '{}') returns jsonb
language plpgsql as $$
begin
	perform pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.actor(p_name), p_units);
	return public.qorpera_folder_memory_commit('64800000-0000-4000-8000-000000000020', pg_temp.actor(p_name), p_key, p_units,
		jsonb_build_object('runLog', jsonb_build_object('run', pg_temp.run_id(p_name), 'path', p_path)) || p_more);
end $$;
-- The same commit's SQL for another connection, kept by name. The run takes possession of its files here, in a statement
-- of its own: staging inside the batch's transaction would lock the company row, and the others see only what is committed.
create function pg_temp.sql_log(p_sql text, p_name text, p_key text, p_units jsonb, p_path text, p_more jsonb default '{}')
returns void language plpgsql as $$
begin
	perform pg_temp.possess('64800000-0000-4000-8000-000000000020', pg_temp.actor(p_name), p_units);
	perform set_config('qorpera_test.sql_' || p_sql, format('select public.qorpera_folder_memory_commit(%L, %L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', pg_temp.actor(p_name), p_key, p_units,
		jsonb_build_object('runLog', jsonb_build_object('run', pg_temp.run_id(p_name), 'path', p_path)) || p_more), false);
end $$;
-- A sent statement's one text column as jsonb; the connection is drained.
create function pg_temp.answer(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select x::jsonb into v from dblink_get_result(p_conn) as t(x text);
	begin
		perform * from dblink_get_result(p_conn) as t(x text);
	exception when others then null;
	end;
	return v;
end $$;
-- A race: p_hold runs on fence_one in an open transaction; the batch (kept SQL p_sql) is sent on fence_two and must wait
-- for fence_one; fence_one then ends with p_end. What p_hold returned, the table whose row the batch queued on, and the
-- batch's result.
create function pg_temp.race(p_hold text, p_sql text, p_end text, p_what text) returns jsonb language plpgsql as $$
declare v_hold jsonb; v_queued text; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	perform dblink_exec('fence_one', 'begin');
	select x::jsonb into v_hold from dblink('fence_one', p_hold) as t(x text);
	perform dblink_send_query('fence_two', current_setting('qorpera_test.sql_' || p_sql));
	loop
		exit when current_setting('qorpera_test.pid_fence_one')::integer
			= any (pg_blocking_pids(current_setting('qorpera_test.pid_fence_two')::integer));
		if dblink_is_busy('fence_two') = 0 then
			perform dblink_exec('fence_one', 'rollback');
			raise exception '%: the batch did not wait: %', p_what, pg_temp.answer('fence_two'); end if;
		if clock_timestamp() > v_until then
			perform dblink_exec('fence_one', 'rollback');
			raise exception '%: the batch waits on %, not on fence_one', p_what,
				pg_blocking_pids(current_setting('qorpera_test.pid_fence_two')::integer); end if;
		perform pg_sleep(0.02);
	end loop;
	v_queued := coalesce(pg_temp.queued_on('fence_two')::text, (select l.locktype || coalesce(' ' || l.relation::regclass::text, '')
		from pg_locks l where l.pid = current_setting('qorpera_test.pid_fence_two')::integer and not l.granted limit 1));
	perform dblink_exec('fence_one', p_end);
	return jsonb_build_object('hold', v_hold, 'queued', v_queued, 'batch', pg_temp.answer('fence_two'));
end $$;
-- A result's first unit: its outcome and reason.
create function pg_temp.unit(p_result jsonb) returns jsonb language sql as $$
	select jsonb_build_array(p_result -> 'units' -> 0 ->> 'outcome', p_result -> 'units' -> 0 ->> 'reason')
$$;

-- The launch group with Ada and Bo in it (a group chat has at least two agents), and Ada's runs: one and two in her
-- thread, g in the group's chat.
do $$
declare v_text constant text := E'---\nid: 95200000-0000-4000-8000-0000000000b1\nname: Launch\nagents:\n'
	|| E'  - 64800000-0000-4000-8000-0000000000a1\n  - 95200000-0000-4000-8000-0000000000a2\npeople:\n'
	|| E'  - 64800000-0000-4000-8000-000000000001\n---\nPlan the launch.\n';
begin
	perform pg_temp.same(pg_temp.unit(pg_temp.commit(pg_temp.owner(), 'w1b-race:hire', jsonb_build_array(
		pg_temp.hire('bo', '95200000-0000-4000-8000-0000000000a2', 'Bo')))), '["saved", null]', 'Bo''s hire');
	perform pg_temp.same(pg_temp.unit(pg_temp.commit(pg_temp.owner(), 'w1b-race:group', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','agents/groups'),
		jsonb_build_object('op','new_folder','path','agents/groups/launch',
			'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file','file',pg_temp.stage(v_text))),
			'structured', jsonb_build_array(pg_temp.entry('agents/groups/launch/group.md', 'group', v_text,
				jsonb_build_object('kind','group','id','95200000-0000-4000-8000-0000000000b1','name','Launch','subtitle',null,
					'agents','["64800000-0000-4000-8000-0000000000a1", "95200000-0000-4000-8000-0000000000a2"]'::jsonb,
					'people','["64800000-0000-4000-8000-000000000001"]'::jsonb,'purpose','Plan the launch.'))))))),
		'["saved", null]', 'the launch group');
end $$;
select pg_temp.run('one', pg_temp.thread()), pg_temp.run('two', pg_temp.thread()), pg_temp.run('g', pg_temp.chat()) \g /dev/null
-- The company is on the memory tree's list, so its runs keep logs (20260930352000); the fixture's removal takes the row.
insert into public.qorpera_memory_tree_companies(profile_id) values ('64800000-0000-4000-8000-000000000010');

-- The folders on the way to the logs, made by runs one and g; g's log with step 0.
do $$
declare
	env constant uuid := '64800000-0000-4000-8000-000000000020'; one constant uuid := pg_temp.run_id('one');
	g constant uuid := pg_temp.run_id('g'); glog constant text := 'agents/groups/launch/memory/runs/' || pg_temp.run_id('g');
	x jsonb; r jsonb;
begin
	x := public.qorpera_memory_run_log_place(env, one);
	perform pg_temp.same(jsonb_build_array(x -> 'path', x -> 'missing'), jsonb_build_array('agents/ada/memory/thread/runs/' || one,
		'["agents/ada/memory/thread", "agents/ada/memory/thread/runs"]'::jsonb), 'one''s place');
	x := public.qorpera_memory_run_log_place(env, g);
	perform pg_temp.same(jsonb_build_array(x -> 'path', x -> 'missing'), jsonb_build_array(glog,
		'["agents/groups/launch/memory", "agents/groups/launch/memory/runs"]'::jsonb), 'g''s place');
	r := pg_temp.logc('one', 'w1b-race:mk:1', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/ada/memory/thread'),
		jsonb_build_object('op','mkdir','path','agents/ada/memory/thread/runs')), 'agents/ada/memory/thread/runs/' || one);
	perform pg_temp.same(jsonb_build_array(r -> 'units' -> 0 ->> 'outcome', r -> 'units' -> 1 ->> 'outcome'), '["saved", "saved"]',
		'one makes the thread''s runs folder');
	r := pg_temp.logc('g', 'w1b-race:mk:2', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/groups/launch/memory'),
		jsonb_build_object('op','mkdir','path','agents/groups/launch/memory/runs')), glog);
	perform pg_temp.same(jsonb_build_array(r -> 'units' -> 0 ->> 'outcome', r -> 'units' -> 1 ->> 'outcome'), '["saved", "saved"]',
		'g makes the chat''s runs folder');
	r := pg_temp.logc('g', 'w1b-race:mk:3', jsonb_build_array(pg_temp.log_folder(glog, pg_temp.rtoml(g, pg_temp.chat())),
		pg_temp.step(glog, 0)), glog);
	perform pg_temp.same(jsonb_build_array(r -> 'units' -> 0 ->> 'outcome', r -> 'units' -> 1 ->> 'outcome'), '["saved", "saved"]',
		'g''s log with step 0');
end $$;

-- A. Two first batches of one run's log. The second waits for the first's transaction; once the first commits, the log is
-- made and the second conflicts with it (one); once the first rolls back, the second makes it (two).
do $$
declare
	one constant uuid := pg_temp.run_id('one'); two constant uuid := pg_temp.run_id('two');
	l1 constant text := 'agents/ada/memory/thread/runs/' || pg_temp.run_id('one');
	l2 constant text := 'agents/ada/memory/thread/runs/' || pg_temp.run_id('two');
begin
	perform pg_temp.sql_log('a1', 'one', 'w1b-race:a:1', jsonb_build_array(pg_temp.log_folder(l1, pg_temp.rtoml(one, pg_temp.thread()))), l1);
	perform pg_temp.sql_log('a2', 'one', 'w1b-race:a:2', jsonb_build_array(pg_temp.log_folder(l1, pg_temp.rtoml(one, pg_temp.thread()))), l1);
	perform pg_temp.sql_log('a3', 'two', 'w1b-race:a:3', jsonb_build_array(pg_temp.log_folder(l2, pg_temp.rtoml(two, pg_temp.thread()))), l2);
	perform pg_temp.sql_log('a4', 'two', 'w1b-race:a:4', jsonb_build_array(pg_temp.log_folder(l2, pg_temp.rtoml(two, pg_temp.thread()))), l2);
end $$;
do $$
declare
	env constant uuid := '64800000-0000-4000-8000-000000000020'; one constant uuid := pg_temp.run_id('one');
	two constant uuid := pg_temp.run_id('two'); x jsonb;
begin
	x := pg_temp.race(current_setting('qorpera_test.sql_a1'), 'a2', 'commit', 'A1');
	perform pg_temp.same(jsonb_build_array(pg_temp.unit(x -> 'hold'), x -> 'queued', pg_temp.unit(x -> 'batch')),
		'[["saved", null], "transactionid", ["conflict", "exists"]]', 'A1: the second first batch');
	perform pg_temp.same((select jsonb_build_array(count(*), bool_and(g.log_created_at is not null))
		from public.qorpera_memory_run_logs l join public.qorpera_memory_run_generations g using (environment_id, run_id)
		where l.environment_id = env and l.run_id = one), '[1, true]', 'A1: one log');
	x := pg_temp.race(current_setting('qorpera_test.sql_a3'), 'a4', 'rollback', 'A2');
	perform pg_temp.same(jsonb_build_array(pg_temp.unit(x -> 'hold'), x -> 'queued', pg_temp.unit(x -> 'batch')),
		'[["saved", null], "transactionid", ["saved", null]]', 'A2: the second first batch');
	perform pg_temp.same((select jsonb_build_array(count(*), bool_and(g.log_created_at is not null))
		from public.qorpera_memory_run_logs l join public.qorpera_memory_run_generations g using (environment_id, run_id)
		where l.environment_id = env and l.run_id = two), '[1, true]', 'A2: one log');
end $$;

-- E. A batch naming its run's generation, against a change of that generation: the batch waits for the change's
-- transaction at the run's generations row; once the change commits, the batch is stale (E1); once it rolls back, the
-- batch saves (E2).
do $$
declare
	one constant uuid := pg_temp.run_id('one'); l1 constant text := 'agents/ada/memory/thread/runs/' || pg_temp.run_id('one');
begin
	perform pg_temp.sql_log('e1', 'one', 'w1b-race:e:1', jsonb_build_array(pg_temp.step(l1, 0)), l1,
		jsonb_build_object('runGenerations', jsonb_build_array(jsonb_build_object('runId', one, 'generation', 0))));
	perform pg_temp.sql_log('e2', 'one', 'w1b-race:e:2', jsonb_build_array(pg_temp.step(l1, 0)), l1,
		jsonb_build_object('runGenerations', jsonb_build_array(jsonb_build_object('runId', one, 'generation', 1))));
end $$;
do $$
declare
	bump constant text := format('update public.qorpera_memory_run_generations set memory_generation = memory_generation + 1
		where environment_id = %L and run_id = %L returning memory_generation::text', '64800000-0000-4000-8000-000000000020',
		pg_temp.run_id('one'));
	x jsonb;
begin
	x := pg_temp.race(bump, 'e1', 'commit', 'E1');
	perform pg_temp.same(jsonb_build_array(x -> 'hold', x -> 'queued', pg_temp.unit(x -> 'batch')),
		'[1, "transactionid", ["refused", "memory_generation_stale"]]', 'E1: a stale generation');
	x := pg_temp.race(bump, 'e2', 'rollback', 'E2');
	perform pg_temp.same(jsonb_build_array(x -> 'hold', x -> 'queued', pg_temp.unit(x -> 'batch')),
		'[2, "transactionid", ["saved", null]]', 'E2: the generation stays');
	perform pg_temp.same((select to_jsonb(array[g.memory_generation, (select count(*) from public.qorpera_memory_run_steps s
		where s.environment_id = g.environment_id and s.run_id = g.run_id)]) from public.qorpera_memory_run_generations g
		where g.environment_id = '64800000-0000-4000-8000-000000000020' and g.run_id = pg_temp.run_id('one')), '[1, 1]',
		'E: one''s generation and step 0');
end $$;

-- D. A batch against an erase of its run: the erase takes the run's generations row FOR UPDATE and opens; the batch
-- waits, then is refused while the erase is open, and saves once it has closed.
do $$
declare l1 constant text := 'agents/ada/memory/thread/runs/' || pg_temp.run_id('one');
begin
	perform pg_temp.sql_log('d1', 'one', 'w1b-race:d:1', jsonb_build_array(pg_temp.step(l1, 1)), l1);
end $$;
do $$
declare
	env constant uuid := '64800000-0000-4000-8000-000000000020'; one constant uuid := pg_temp.run_id('one');
	l1 constant text := 'agents/ada/memory/thread/runs/' || pg_temp.run_id('one'); x jsonb;
begin
	x := pg_temp.race(format('with held as (select g.run_id from public.qorpera_memory_run_generations g
			where g.environment_id = %L and g.run_id = %L for update)
		update public.qorpera_memory_run_generations g set erase_open = extensions.gen_random_uuid() from held
		where g.environment_id = %L and g.run_id = held.run_id returning (g.erase_open is not null)::text', env, one, env),
		'd1', 'commit', 'D');
	perform pg_temp.same(jsonb_build_array(x -> 'hold', x -> 'queued', pg_temp.unit(x -> 'batch')),
		'[true, "transactionid", ["refused", "memory_erase_open"]]', 'D: an open erase');
	-- The erase closes; the run's next batch saves.
	update public.qorpera_memory_run_generations set erase_open = null where environment_id = env and run_id = one;
	perform pg_temp.same(pg_temp.unit(pg_temp.logc('one', 'w1b-race:d:2', jsonb_build_array(pg_temp.step(l1, 1)), l1)),
		'["saved", null]', 'D: after the erase');
end $$;

-- B. A batch against its agent's rename: the move of agents/ada holds its transaction; the batch at the log's old path
-- waits at the log's row, which the move rewrote, then the core refuses it (its folder is gone). The logs follow the
-- rename, and a batch at the new path saves.
do $$
declare l2 constant text := 'agents/ada/memory/thread/runs/' || pg_temp.run_id('two');
begin
	perform pg_temp.sql_log('b1', 'two', 'w1b-race:b:1', jsonb_build_array(pg_temp.step(l2, 0)), l2);
end $$;
do $$
declare
	env constant uuid := '64800000-0000-4000-8000-000000000020'; one constant uuid := pg_temp.run_id('one');
	two constant uuid := pg_temp.run_id('two'); l2 constant text := 'agents/ada-2/memory/thread/runs/' || pg_temp.run_id('two');
	x jsonb;
begin
	x := pg_temp.race(format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', env, pg_temp.owner(), 'w1b-race:b:2',
		jsonb_build_array(jsonb_build_object('op','move','from','agents/ada','to','agents/ada-2',
			'expectedVersion',pg_temp.version('agents/ada'),'asOfSeq',pg_temp.seq()))), 'b1', 'commit', 'B');
	perform pg_temp.same(jsonb_build_array(pg_temp.unit(x -> 'hold'), x -> 'queued', pg_temp.unit(x -> 'batch')),
		'[["saved", null], "qorpera_memory_run_logs", ["refused", "parent_missing"]]', 'B: a batch at the old path');
	perform pg_temp.same((select jsonb_build_array(count(*), bool_and(l.run_path = 'agents/ada-2/memory/thread/runs/' || l.run_id))
		from public.qorpera_memory_run_logs l where l.environment_id = env and l.run_id in (one, two)), '[2, true]',
		'B: the logs follow the rename');
	perform pg_temp.follow_ups(env);
	perform pg_temp.same(pg_temp.unit(pg_temp.logc('two', 'w1b-race:b:3', jsonb_build_array(pg_temp.step(l2, 0)), l2)),
		'["saved", null]', 'B: a batch at the new path');
end $$;

-- C. A batch against its group's delete: the delete of the launch group's folder holds its transaction; the batch in the
-- group chat's log waits at the log's row, which the delete retired, then the core refuses it. The log's steps are gone.
do $$
declare glog constant text := 'agents/groups/launch/memory/runs/' || pg_temp.run_id('g');
begin
	perform pg_temp.sql_log('c1', 'g', 'w1b-race:c:1', jsonb_build_array(pg_temp.step(glog, 1)), glog);
end $$;
do $$
declare env constant uuid := '64800000-0000-4000-8000-000000000020'; g constant uuid := pg_temp.run_id('g'); x jsonb;
begin
	x := pg_temp.race(format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', env, pg_temp.owner(), 'w1b-race:c:2',
		jsonb_build_array(jsonb_build_object('op','delete','path','agents/groups/launch',
			'expectedVersion',pg_temp.version('agents/groups/launch'),'asOfSeq',pg_temp.seq()))), 'c1', 'commit', 'C');
	perform pg_temp.same(jsonb_build_array(pg_temp.unit(x -> 'hold'), x -> 'queued', pg_temp.unit(x -> 'batch')),
		'[["saved", null], "qorpera_memory_run_logs", ["refused", "parent_missing"]]', 'C: a batch in a deleted group');
	perform pg_temp.same((select jsonb_build_array(l.retired_at is not null, (select count(*) from public.qorpera_memory_run_steps s
		where s.environment_id = env and s.run_id = g)) from public.qorpera_memory_run_logs l
		where l.environment_id = env and l.run_id = g), '[true, 0]', 'C: the log retires');
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 944 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_memory_run_logs where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_memory_run_generations where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_company_rooms where id = '95200000-0000-4000-8000-0000000000b1') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
