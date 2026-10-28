-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- C5 (20260930508000) with the beta off, on the real path. Test 924's company never chose Shared context, so a run the
-- materializer makes is recorded with Agent notebooks. Alice's next run writes, forgets and reads back her own
-- notebook (QorperaOS/agents/alice/memory, as the runtime's update_memory and forget write it: one commit as the run), and its
-- context still carries her thread's history. The run has no run log place and no view, and after it the company has no
-- tree, run log, view or other tree data at all. The row's trigger decides a new run's mode, not the inserter: an insert
-- that asks for the beta in this company gets notebooks, and one that asks for notebooks while the company uses the beta
-- gets the beta.
select pg_temp.base_claims('service_role');

-- A started run as the folder commit's actor (924's wb_actor).
create function pg_temp.nb_actor(p_binding jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', p_binding -> 'runId', 'jobId', p_binding -> 'jobId',
		'runnerId', p_binding -> 'runnerId', 'assignmentId', p_binding -> 'assignmentId')
$$;
-- The owner's post in an agent's thread, materialized and started: the delivery's binding (924's wb_posted).
create function pg_temp.nb_posted(p_staff uuid, p_text text) returns jsonb language plpgsql as $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, p_text);
	v_pass jsonb := pg_temp.base_materialize();
	v_run uuid := (select run_id from public.qorpera_wake_occurrences where id = (v_wakes ->> 0)::uuid);
begin
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' ? v_run::text, 'the post is delivered: ' || v_pass::text);
	return pg_temp.base_start(v_run);
end
$$;
create function pg_temp.nb_mode(p_run uuid) returns text language sql as $$
	select memory_mode from public.qorpera_execution_runs where id = p_run
$$;
-- The run reads p_path back, as the runtime's read does: found, with p_text's hash, at the folder's version.
create function pg_temp.nb_reads(p_binding jsonb, p_path text, p_text text) returns void language plpgsql as $$
declare r jsonb := public.qorpera_folder_read('92400000-0000-4000-8000-000000000020', pg_temp.nb_actor(p_binding), p_path);
begin
	perform pg_temp.base_assert((r ->> 'found')::boolean
		and r #>> '{entry,fileSha256}' = encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
		and r #>> '{entry,version}' = pg_temp.base_version(p_path)::text, 'the run reads back ' || p_path || ': ' || r::text);
end
$$;
-- A post in an agent's thread, made into a run by the next pass; answers the run's recorded mode (686's mm_run).
create function pg_temp.nb_new_mode(p_staff uuid) returns text language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, 'Look at the numbers.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the run: ' || v_pass::text);
	return pg_temp.nb_mode((v_pass -> 'run_ids' ->> 0)::uuid);
end
$$;

-- 1. Alice's base run reports and ends; the owner's next post makes her next run. Both are recorded with notebooks, and
--    the new run has no run log place and no view: the shared context's calls refuse it.
do $$
declare v_base jsonb := current_setting('qorpera_test.base_binding')::jsonb; b jsonb; v_run uuid;
begin
	perform pg_temp.base_public_send(v_base, 'progress', 'nb-progress');
	perform pg_temp.base_public_send(v_base, 'final', 'nb-final');
	update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where run_id = (v_base ->> 'runId')::uuid;
	b := pg_temp.nb_posted('92400000-0000-4000-8000-000000000030', 'What did we decide about the rent?');
	v_run := (b ->> 'runId')::uuid;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.nb_mode((v_base ->> 'runId')::uuid) = 'notebooks' and pg_temp.nb_mode(v_run) = 'notebooks',
		'both runs are recorded with notebooks: ' || coalesce(pg_temp.nb_mode(v_run), 'no mode'));
	perform pg_temp.base_assert(public.qorpera_memory_run_log_place('92400000-0000-4000-8000-000000000020', v_run) = '{"off":true}'::jsonb,
		'the run has no run log place');
	perform pg_temp.base_assert(public.qorpera_memory_view(b) is null and public.qorpera_memory_view_of(v_run) is null, 'the run has no view');
	perform pg_temp.base_error(format('select public.qorpera_memory_branches(%L, %L)', b, '{}'), '42501', 'A notebook run has no shared context');
	perform set_config('qorpera_test.nb_binding', b::text, true);
end
$$;

-- 2. The run writes two facts into Alice's profile and a note into this month's log (one fact per line, as
--    update_memory writes them), and reads each back. It forgets one fact of the profile and the log's only note: each
--    file is rewritten at the version it read, with the lines kept, or empty. It reads back what it kept.
do $$
declare b jsonb := current_setting('qorpera_test.nb_binding')::jsonb; a jsonb := pg_temp.nb_actor(b);
	d text := to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD');
	p constant text := 'QorperaOS/agents/alice/memory/profile.md';
	l text := 'QorperaOS/agents/alice/memory/log/' || to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM') || '.md';
	v_profile text := '- (' || d || E') Prefers short answers.\n- (' || d || E') Pays the rent on the first.\n';
	v_kept text := '- (' || d || E') Prefers short answers.\n';
	v_note text := '- (' || d || E') [note] The landlord asked for the receipt.\n';
begin
	perform pg_temp.base_commit(a, 'nb-profile', jsonb_build_array(jsonb_build_object('op', 'write', 'path', p,
		'file', pg_temp.base_stage(v_profile))));
	perform pg_temp.base_commit(a, 'nb-log-note', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/alice/memory/log'),
		jsonb_build_object('op', 'write', 'path', l, 'file', pg_temp.base_stage(v_note))));
	perform pg_temp.nb_reads(b, p, v_profile);
	perform pg_temp.nb_reads(b, l, v_note);
	perform pg_temp.base_commit(a, 'nb-forget-profile', jsonb_build_array(jsonb_build_object('op', 'write', 'path', p,
		'file', pg_temp.base_stage(v_kept), 'expectedVersion', pg_temp.base_version(p))));
	perform pg_temp.base_commit(a, 'nb-forget-log', jsonb_build_array(jsonb_build_object('op', 'write', 'path', l,
		'file', pg_temp.base_stage(''), 'expectedVersion', pg_temp.base_version(l))));
	perform pg_temp.nb_reads(b, p, v_kept);
	perform pg_temp.nb_reads(b, l, '');
end
$$;

-- 3. The run's context carries the thread's history: the owner's first post, which woke the base run, is in it.
do $$
declare b jsonb := current_setting('qorpera_test.nb_binding')::jsonb; v_context jsonb; v_first uuid;
begin
	select source_id into strict v_first from public.qorpera_wake_occurrences
	where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_context := public.qorpera_describe_company_run_context(b);
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v_context -> 'history') h
		where h ->> 'id' = v_first::text and h ->> 'kind' = 'historical_human_message'
			and h ->> 'authorUserId' = '92400000-0000-4000-8000-000000000001'),
		'the first post is in the history: ' || coalesce((v_context -> 'history')::text, 'none'));
end
$$;

-- 4. The company keeps no tree data: no tree, node, read receipt, run log, step, generation, step hash key, view
--    record, compaction, resume, erasure or held prune; every conversation is at generation 0; no tree file.
do $$
declare v_table text; v_count bigint;
begin
	foreach v_table in array array['qorpera_memory_trees', 'qorpera_memory_tree_nodes', 'qorpera_memory_read_receipts',
		'qorpera_memory_run_logs', 'qorpera_memory_run_steps', 'qorpera_memory_run_generations', 'qorpera_memory_step_hash_keys',
		'qorpera_memory_views', 'qorpera_memory_compactions', 'qorpera_memory_run_resumes', 'qorpera_memory_message_erases',
		'qorpera_memory_tree_prune_held'] loop
		execute format('select count(*) from public.%I where environment_id = %L', v_table, '92400000-0000-4000-8000-000000000020')
			into v_count;
		perform pg_temp.base_assert(v_count = 0, v_table || ' has ' || v_count || ' rows');
	end loop;
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_shared_sessions
		where environment_id = '92400000-0000-4000-8000-000000000020' and memory_generation <> 0), 'every conversation is at generation 0');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_folder_entries
		where environment_id = '92400000-0000-4000-8000-000000000020' and kind <> 'claim'
			and (key_text ~ '^qorperaos/agents/[^/]+/memory/thread(/|$)' or key_text ~ '^qorperaos/agents/groups/[^/]+/memory(/|$)')), 'no tree file');
end
$$;

-- 5. The trigger decides, not the inserter. The materializer's insert names no mode, so the column's default is what
--    it asks for. Asking for the beta in this company gets notebooks; so does a hand-made insert that names the beta
--    (only this trigger on). Asking for notebooks while the company is on the test list and chose Shared context gets
--    the beta. Each part is undone by its error.
do $$
declare v_mode text;
begin
	begin
		alter table public.qorpera_execution_runs alter column memory_mode set default 'tree';
		v_mode := pg_temp.nb_new_mode('92400000-0000-4000-8000-000000000031');
		perform pg_temp.base_assert(v_mode = 'notebooks', 'asked for the beta, got ' || coalesce(v_mode, 'no mode'));
		raise exception 'undo' using errcode = 'QG618';
	exception when sqlstate 'QG618' then null;
	end;
	begin
		set local session_replication_role = replica;
		alter table public.qorpera_execution_runs enable always trigger qorpera_execution_run_memory_mode;
		insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
			company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
			payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
			audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, memory_mode)
		values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'wake',
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
			'92400000-0000-4000-8000-000000000030', 1, extensions.gen_random_uuid(), 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
			'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000001', 'openai', 'gpt-test', 'provider_default',
			'company', extensions.gen_random_uuid(), repeat('b', 64), null, '{}'::uuid[], 'tree')
		returning memory_mode into v_mode;
		perform pg_temp.base_assert(v_mode = 'notebooks', 'named the beta, got ' || coalesce(v_mode, 'no mode'));
		raise exception 'undo' using errcode = 'QG618';
	exception when sqlstate 'QG618' then null;
	end;
	begin
		insert into public.qorpera_memory_tree_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
		insert into public.qorpera_company_memory_modes(profile_id, mode) values ('92400000-0000-4000-8000-000000000010', 'tree');
		alter table public.qorpera_execution_runs alter column memory_mode set default 'notebooks';
		v_mode := pg_temp.nb_new_mode('92400000-0000-4000-8000-000000000032');
		perform pg_temp.base_assert(v_mode = 'tree', 'asked for notebooks while the company uses the beta, got ' || coalesce(v_mode, 'no mode'));
		raise exception 'undo' using errcode = 'QG618';
	exception when sqlstate 'QG618' then null;
	end;
	perform pg_temp.base_assert(public.qorpera_company_memory_mode_effective('92400000-0000-4000-8000-000000000010') = 'notebooks'
		and (select column_default from information_schema.columns where table_schema = 'public'
			and table_name = 'qorpera_execution_runs' and column_name = 'memory_mode') is null, 'each part is undone');
end
$$;

rollback;
