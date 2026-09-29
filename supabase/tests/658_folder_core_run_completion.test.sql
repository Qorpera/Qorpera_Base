-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C1c-2c part 2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6): a folder-v2 run's
-- completion, sponsor handoff and receipt recovery. v6's folder lane completes a run with the disposition its commits
-- give (unchanged, published, review_pending), after its receipts are matched to the commits that carry them; it closes
-- the run's run box views and never reads a source substrate. The handoff accepts receipts satisfied by commits;
-- recovery confirms a receipt with the commit that carries it. Runs are 647's hand-built runs. Races are in 659.

-- Repairs to a hand-built run so completion's writes pass their foreign-key checks (rows this transaction built with
-- them off are checked again when updated): the run names a real substrate and snapshot (another company's, which
-- today's v2 would refuse as inconsistent; the folder lane never reads them), the run and its inputs a real runtime
-- bundle, and the assignment's claim exists. Then the native start is recorded.
create function pg_temp.prepare(b jsonb) returns void language plpgsql as $$
declare v_substrate uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_company_substrate_versions(id, profile_id, environment_id, company_snapshot_id,
		client_version_id, contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id)
		values (%L, '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021', extensions.gen_random_uuid(),
			extensions.gen_random_uuid(), 1, 0, 0, repeat('f', 64), '63400000-0000-4000-8000-000000000001')$f$, v_substrate));
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set substrate_version_id = %L where id = %L', v_substrate, b ->> 'jobId'));
	perform pg_temp.fx(format('update public.qorpera_execution_runs set substrate_version_id = %L where id = %L', v_substrate, b ->> 'runId'));
	perform pg_temp.fx(format($f$insert into public.qorpera_company_snapshots(id, profile_id, environment_id, workspace_id, client_snapshot_id,
		tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count, total_bytes, created_by_user_id)
		select company_snapshot_id, '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021',
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('f', 64), 1, 1, 0, 0, '63400000-0000-4000-8000-000000000001'
		from public.qorpera_execution_runs where id = %L$f$, b ->> 'runId'));
	perform pg_temp.fx(format($f$update public.qorpera_execution_runs set runtime_bundle_id = bundle.id, runtime_bundle_sha256 = bundle.sha256
		from (select id, sha256 from public.qorpera_runtime_bundles order by version desc, id limit 1) bundle
		where qorpera_execution_runs.id = %L$f$, b ->> 'runId'));
	perform pg_temp.fx(format($f$update public.qorpera_session_inputs set runtime_bundle_id = run.runtime_bundle_id,
		runtime_bundle_sha256 = run.runtime_bundle_sha256 from public.qorpera_execution_runs run
		where run.id = %L and qorpera_session_inputs.execution_run_id = run.id$f$, b ->> 'runId'));
	perform pg_temp.fx(format($f$insert into public.qorpera_runner_job_claims(id, orchestrator_id, client_claim_id, job_id, run_id,
		lease_expires_at, status) select claim_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), job_id, run_id,
		clock_timestamp() + interval '1 hour', 'accepted' from public.qorpera_runner_assignments where id = %L$f$, b ->> 'assignmentId'));
	perform pg_temp.fx(format($f$insert into public.qorpera_execution_run_events(run_id, event_type, payload)
		values (%L, 'runner_started', %L)$f$, b ->> 'runId', jsonb_build_object('schema', 'qorpera.native-company-execution-start/v1',
			'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'leaseId', b ->> 'leaseId', 'binarySha256', repeat('9', 64))));
end $$;
-- A human run that has acknowledged, with its native start recorded. Returns the actor and binding.
create function pg_temp.human() returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	b jsonb := pg_temp.native(p);
begin
	perform pg_temp.prepare(b);
	perform pg_temp.send(b, 'ack', 'On it.', 'progress');
	return jsonb_build_object('actor', p, 'binding', b);
end $$;
-- A routine run of agent A (a silent routine: no conversation, no reply owed), with its native start recorded.
create function pg_temp.routine_run() returns jsonb language plpgsql as $$
declare
	v_profile uuid := '63400000-0000-4000-8000-000000000010'; v_env uuid := '63400000-0000-4000-8000-000000000020';
	v_staff uuid := '63400000-0000-4000-8000-0000000000a1'; v_member uuid := '63400000-0000-4000-8000-000000000002';
	v_routine uuid := extensions.gen_random_uuid(); v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid();
	v_wake uuid := extensions.gen_random_uuid(); v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	p jsonb; b jsonb;
begin
	set local session_replication_role = replica;
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		created_by_user_id, origin)
	values (v_routine, v_profile, v_env, extensions.gen_random_uuid(), 1, 'active', v_member, 'member');
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values (v_routine, 1, extensions.gen_random_uuid(), v_profile, v_env, v_staff, 'Quiet check', 'Check the numbers quietly.',
		'[{"id":"s1","kind":"schedule","intervalMinutes":60,"replyPolicy":"silent"}]', 'medium',
		'63400000-0000-4000-8000-0000000000b1', 1, repeat('e', 64), v_member);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_member, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'wake', v_wake, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, '63400000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_member, v_member,
		'openai', 'gpt-test', 'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), null, '{}');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, trigger_id, occurrence_key,
		scheduled_for, not_before, wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id,
		sponsor_binding_id, sponsor_version, causal_root_id, causal_agent_ids, causal_hop_count, payload)
	values (v_wake, v_profile, v_env, v_routine, 1, 's1', v_wake::text, clock_timestamp(), clock_timestamp(), 'routine', 'schedule',
		v_routine, v_run, 'materialized', v_staff, 1, v_member, '63400000-0000-4000-8000-0000000000b1', 1, v_wake, array[v_staff], 0, '{}');
	set local session_replication_role = origin;
	p := jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
	b := pg_temp.native(p);
	perform pg_temp.prepare(b);
	return jsonb_build_object('actor', p, 'binding', b, 'routine', v_routine);
end $$;
create function pg_temp.send(p_binding jsonb, p_key text, p_text text, p_phase text) returns jsonb language sql as $$
	select public.qorpera_send_native_agent_message((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_key, p_text, p_phase)
$$;
-- The runtime's completion result for this run: every public send of its assignment, and its final message.
create function pg_temp.result(p_binding jsonb) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
		'native_lease_id', p_binding ->> 'leaseId',
		'substrate_version_id', (select substrate_version_id from public.qorpera_runner_jobs where id = (p_binding ->> 'jobId')::uuid),
		'output_count',0,'output_bytes',0,'publication',null,
		'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',p_binding ->> 'runId',
			'message_count',(select count(*) from public.qorpera_agent_sends where run_id = (p_binding ->> 'runId')::uuid),
			'final_message_id',(select event_id from public.qorpera_agent_sends where run_id = (p_binding ->> 'runId')::uuid and phase = 'final'),
			'provider_session_id','folder-completion-' || (p_binding ->> 'runId')),
		'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
			"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
				"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb)
$$;
create function pg_temp.complete(p_binding jsonb, p_result jsonb default null, p_snapshot uuid default null) returns jsonb language sql as $$
	select public.qorpera_complete_runner_job_v6((p_binding ->> 'runnerId')::uuid, repeat('f', 64), (p_binding ->> 'jobId')::uuid,
		repeat('a', 64), '65800000-0000-4000-8000-0000000000a1', '65800000-0000-4000-8000-0000000000a2', p_snapshot,
		coalesce(p_result, pg_temp.result(p_binding)))
$$;
create function pg_temp.outcome(p_run text) returns public.qorpera_execution_run_results language sql as $$
	select * from public.qorpera_execution_run_results where run_id = p_run::uuid
$$;
create function pg_temp.begin(p_binding jsonb, p_receipt uuid, p_key text) returns jsonb language sql as $$
	select public.qorpera_begin_native_tool_operation(p_binding, p_receipt, p_key, repeat('1', 64), repeat('2', 64), true)
$$;
create function pg_temp.without_guard(p_definition text) returns text language plpgsql as $$
declare v_body integer := position('$function$' in p_definition); v_at integer; v_end integer;
begin
	v_at := v_body + position(E'\nbegin\n' in substr(p_definition, v_body)) - 1 + length(E'\nbegin\n');
	v_end := v_at + position(E'\n' in substr(p_definition, v_at));
	return substr(p_definition, 1, v_at - 1) || substr(p_definition, v_end);
end $$;

-- 1. Snapshot-v1 keeps its text: each patch reversed, and the recovery body without its first line, is the definition
-- before this migration.
do $$
declare v_def text;
begin
	if md5(replace(pg_get_functiondef('public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure),
			'if public.qorpera_job_is_folder_v2(p_job_id) then return public.qorpera_folder_complete_run_job(p_runner_id, '
			|| 'p_session_token_sha256, p_job_id, p_lease_token_sha256, p_client_artifact_index_id, p_client_substrate_version_id, '
			|| 'p_output_snapshot_id, p_result); end if;',
			'if public.qorpera_job_is_folder_v2(p_job_id) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;'))
			<> 'b14a29d8e7afc543038de525b955571b' then raise exception 'v6''s snapshot-v1 text changed'; end if;
	if md5(replace(pg_get_functiondef('public.qorpera_complete_runner_job_v2(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure),
			E'\tif public.qorpera_job_is_folder_v2(v_job.id) then\n'
			|| E'\t\tif exists (select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then\n'
			|| E'\t\t\traise exception ''runner source substrate is inconsistent'' using errcode = ''55000''; end if;\n'
			|| E'\telse\n', '')) is null then raise exception 'unreachable'; end if;
	v_def := replace(pg_get_functiondef('public.qorpera_complete_runner_job_v2(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure),
		E'\tif public.qorpera_job_is_folder_v2(v_job.id) then\n'
		|| E'\t\tif exists (select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then\n'
		|| E'\t\t\traise exception ''runner source substrate is inconsistent'' using errcode = ''55000''; end if;\n'
		|| E'\telse\n', '');
	v_def := replace(v_def, E'\t\traise exception ''runner source substrate is inconsistent'' using errcode = ''55000'';\n'
		|| E'\tend if;\n\tend if;\n', E'\t\traise exception ''runner source substrate is inconsistent'' using errcode = ''55000'';\n'
		|| E'\tend if;\n');
	if md5(v_def) <> '9e1bda8d68110049d48788c9bda47abc' then raise exception 'v2''s snapshot-v1 text changed'; end if;
	if md5(replace(pg_get_functiondef('public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure),
			' and folder_commit_id is null)))', ')))')) <> 'c5311dfbd68b708e188a82c0a07d45bb' then
		raise exception 'The handoff''s snapshot-v1 text changed'; end if;
	v_def := pg_get_functiondef('public.qorpera_resolve_run_operation_receipt(uuid,text,jsonb,uuid,uuid)'::regprocedure);
	if position(E'\nbegin\n\tif public.qorpera_environment_is_folder_v2((select run.environment_id from public.qorpera_run_operation_receipts receipt' in v_def) = 0
		or md5(pg_temp.without_guard(v_def)) <> '0afb464666ebda7f30acab5ff3a7a288' then
		raise exception 'The recovery''s snapshot-v1 body changed'; end if;
end $$;

-- 2. A run with no commit completes unchanged: the job completes, the inputs are done, the native lease ends, the result
-- names the folder lane. A replay returns the job; a different result refuses. No source substrate is read (the fixture
-- job's substrate is another company's, which today's v2 would refuse).
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; v jsonb; r public.qorpera_execution_run_results;
begin
	if (select profile_id from public.qorpera_company_substrate_versions
		where id = (select substrate_version_id from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid))
		is distinct from '64700000-0000-4000-8000-000000000011' then raise exception 'The fixture job''s substrate is another company''s'; end if;
	-- The reply obligation first: a human wake owes a final message.
	perform pg_temp.raises_like(format('select pg_temp.complete(%L)', b), '55000', 'Wake reply obligation is not satisfied');
	perform pg_temp.send(b, 'final', 'Done.', 'final');
	-- Neither a snapshot nor artifacts: the path lane's result, publishing nothing.
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, null, %L)', b, extensions.gen_random_uuid()), '22023',
		'Governed completion cannot publish a whole Company File or artifacts');
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, %L)', b, pg_temp.result(b) || '{"output_count":1}'), '22023',
		'Governed completion cannot publish a whole Company File or artifacts');
	v := pg_temp.complete(b);
	r := pg_temp.outcome(b ->> 'runId');
	if r.company_disposition is distinct from 'unchanged' or r.folder_commit_id is not null or r.output_snapshot_id is not null
		or (select status from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid) is distinct from 'completed'
		or (select result -> 'company_file' from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid)
			is distinct from jsonb_build_object('runtime', 'folder-v2', 'disposition', 'unchanged', 'folder_commit_id', null,
				'native_binary_sha256', repeat('9', 64), 'applied_receipt_ids', '[]'::jsonb)
		or exists (select 1 from public.qorpera_session_inputs where execution_run_id = (b ->> 'runId')::uuid and completed_at is null)
		or exists (select 1 from public.qorpera_native_provider_connection_leases where id = (b ->> 'leaseId')::uuid and status = 'active') then
		raise exception 'An unchanged completion: % %', to_jsonb(r), v; end if;
	if pg_temp.complete(b) ->> 'status' is distinct from 'completed' then raise exception 'A replayed completion returns the job'; end if;
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, %L)', b,
		jsonb_set(pg_temp.result(b), '{usage,execution_ms}', '51')), '23505', 'Runner completion replay differs from its receipt');
end $$;

-- 3. Published: the run's commits saved units; the result names the last saving commit (the highest seq), not a later
-- commit that saved nothing. A revision receipt carried by a commit is matched; one that names no commit refuses, and
-- so does unresolved work. The run's run box view ends with the run.
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; p jsonb := h -> 'actor'; c1 jsonb; c2 jsonb; c3 jsonb;
	v_receipt uuid := extensions.gen_random_uuid(); v_view uuid := extensions.gen_random_uuid(); r public.qorpera_execution_run_results;
begin
	perform pg_temp.begin(b, v_receipt, 'write-notes');
	-- Unresolved work refuses: the receipt is still executing.
	perform pg_temp.send(b, 'final', 'Saved.', 'final');
	perform pg_temp.raises_like(format('select pg_temp.complete(%L)', b), '55000', 'Governed execution has unresolved or ungoverned work');
	c1 := public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', p, 'completion-save-1',
		jsonb_build_array(jsonb_build_object('op','mkdir','path','completion')), null, v_receipt);
	perform public.qorpera_folder_complete_run_receipt(b, v_receipt, repeat('1', 64), '{"ok":true}'::jsonb, (c1 ->> 'commitId')::uuid);
	c2 := pg_temp.commit(p, 'completion-save-2', jsonb_build_array(jsonb_build_object('op','write','path','completion/a.txt',
		'file',pg_temp.stage('a'))));
	-- A later commit that saves nothing (the folder exists already) is not the run's saving commit.
	c3 := pg_temp.commit(p, 'completion-save-3', jsonb_build_array(jsonb_build_object('op','mkdir','path','completion')));
	if c3 ->> 'seq' is not null or c2 ->> 'seq' is null then raise exception 'The fixture commits: % %', c2, c3; end if;
	-- A completed revision receipt that names no commit refuses.
	perform pg_temp.fx(format('update public.qorpera_run_operation_receipts set folder_commit_id = null where id = %L', v_receipt));
	perform pg_temp.raises_like(format('select pg_temp.complete(%L)', b), '55000', 'Governed completion omitted a folder commit receipt');
	perform pg_temp.fx(format('update public.qorpera_run_operation_receipts set folder_commit_id = %L where id = %L', c1 ->> 'commitId', v_receipt));
	perform pg_temp.fx(format($f$insert into public.qorpera_folder_views(id, environment_id, profile_id, kind, staff_agent_id, member_user_id,
		worker_access, run_id, job_id, runner_id, client_lease_id, pass_sha256, state, lease_until)
		values (%L, '63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', 'run_box',
			'63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000002', 'write', %L, %L, %L, %L,
			extensions.digest('pass', 'sha256'), 'open', clock_timestamp() + interval '10 minutes')$f$,
		v_view, b ->> 'runId', b ->> 'jobId', b ->> 'runnerId', b ->> 'assignmentId'));
	perform pg_temp.complete(b);
	r := pg_temp.outcome(b ->> 'runId');
	if r.company_disposition is distinct from 'published' or r.folder_commit_id::text is distinct from c2 ->> 'commitId' or r.output_snapshot_id is not null
		or (select result -> 'company_file' -> 'applied_receipt_ids' from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid)
			is distinct from jsonb_build_array(v_receipt) then
		raise exception 'A published completion: %', to_jsonb(r); end if;
	if (select state || ':' || close_reason from public.qorpera_folder_views where id = v_view) is distinct from 'closed:ended' then
		raise exception 'The run''s run box view ends with the run'; end if;
end $$;

-- 4. A unit waiting for review makes the run review_pending, naming that commit, even beside a saving commit.
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; p jsonb := h -> 'actor'; c1 jsonb; c2 jsonb;
	r public.qorpera_execution_run_results;
begin
	c1 := pg_temp.commit(p, 'review-save-1', jsonb_build_array(jsonb_build_object('op','mkdir','path','reviewed')));
	c2 := pg_temp.commit(p, 'review-save-2', jsonb_build_array(jsonb_build_object('op','mkdir','path','reviewed')));
	-- A parked unit, as C2's review will leave it.
	perform pg_temp.fx(format($f$update public.qorpera_folder_commits set units = '[{"unit":1,"op":"mkdir","path":"reviewed","outcome":"waiting_for_review","reason":"waiting_for_review"}]'
		where id = %L$f$, c2 ->> 'commitId'));
	perform pg_temp.send(b, 'final', 'Asked for review.', 'final');
	perform pg_temp.complete(b);
	r := pg_temp.outcome(b ->> 'runId');
	if r.company_disposition is distinct from 'review_pending' or r.folder_commit_id::text is distinct from c2 ->> 'commitId' then
		raise exception 'A review_pending completion: %', to_jsonb(r); end if;
end $$;

-- 4b. The lane's own checks: the recheck at rank 10 (a revoked read refuses completion), the durable native start, and
-- the result matching the run's public sends.
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; p jsonb := h -> 'actor'; v_res uuid; v_grant uuid;
begin
	perform pg_temp.send(b, 'final', 'Read it.', 'final');
	perform pg_temp.raises_like(format('select pg_temp.complete(%L, %L)', b,
		jsonb_set(pg_temp.result(b), '{backend_result,message_count}', '1')), '55000', 'Native completion does not match durable public delivery');
	perform pg_temp.fx(format('delete from public.qorpera_execution_run_events where run_id = %L and event_type = %L', b ->> 'runId',
		'runner_started'));
	perform pg_temp.raises_like(format('select pg_temp.complete(%L)', b), '55000', 'Native execution has no matching durable admission');
	-- A revoked native lease refuses completion (the folder run check's plain lease check, as on the legacy lane).
	perform pg_temp.fx(format($f$update public.qorpera_native_provider_connection_leases set status = 'revoked', released_at = clock_timestamp()
		where id = %L$f$, b ->> 'leaseId'));
	perform pg_temp.raises(format('select pg_temp.complete(%L)', b), '42501');
	perform pg_temp.fx(format($f$update public.qorpera_native_provider_connection_leases set status = 'active', released_at = null
		where id = %L$f$, b ->> 'leaseId'));
	perform pg_temp.fx(format($f$insert into public.qorpera_execution_run_events(run_id, event_type, payload)
		values (%L, 'runner_started', %L)$f$, b ->> 'runId', jsonb_build_object('schema', 'qorpera.native-company-execution-start/v1',
			'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'leaseId', b ->> 'leaseId', 'binarySha256', repeat('9', 64))));
	v_res := public.qorpera_folder_set_resource('63400000-0000-4000-8000-000000000020', pg_temp.member(1), 'closing', 'subtree',
		'company_shared', 'normal') ->> 'resourceId';
	v_grant := public.qorpera_folder_grant('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_res, 'staff_agent',
		'63400000-0000-4000-8000-0000000000a1', array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'closing-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','closing'),
		jsonb_build_object('op','write','path','closing/c.txt','file',pg_temp.stage('c')))), 2, 'saved');
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('closing/c.txt', p) -> 'entry'));
	perform public.qorpera_folder_revoke('63400000-0000-4000-8000-000000000020', pg_temp.member(1), v_res, v_grant);
	perform pg_temp.raises_like(format('select pg_temp.complete(%L)', b), '42501', 'A read is no longer readable');
end $$;

-- 4c. A routine run completes (a silent routine: no public send): its routine stays at the run check's KEY SHARE, and
-- nothing in completion writes it.
do $$
declare h jsonb := pg_temp.routine_run(); b jsonb := h -> 'binding'; r public.qorpera_execution_run_results;
	v_before public.qorpera_cloud_routines;
begin
	select * into v_before from public.qorpera_cloud_routines where id = (h ->> 'routine')::uuid;
	perform pg_temp.complete(b);
	r := pg_temp.outcome(b ->> 'runId');
	if r.company_disposition is distinct from 'unchanged'
		or (select status from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid) is distinct from 'completed'
		or (select to_jsonb(x) from public.qorpera_cloud_routines x where id = (h ->> 'routine')::uuid) is distinct from to_jsonb(v_before) then
		raise exception 'A routine run''s completion: %', to_jsonb(r); end if;
end $$;

-- 5. The run results check: a folder commit stands in for a snapshot, never beside one, and never for unchanged.
do $$
declare r public.qorpera_execution_run_results;
begin
	select * into strict r from public.qorpera_execution_run_results where company_disposition = 'published' and folder_commit_id is not null;
	perform pg_temp.raises(format('update public.qorpera_execution_run_results set output_snapshot_id = %L where run_id = %L',
		extensions.gen_random_uuid(), r.run_id), '23514');
	perform pg_temp.raises(format('update public.qorpera_execution_run_results set company_disposition = %L where run_id = %L',
		'unchanged', r.run_id), '23514');
	perform pg_temp.raises(format('update public.qorpera_execution_run_results set folder_commit_id = null where run_id = %L', r.run_id),
		'23514');
end $$;

-- 6. Recovery: an attempt ends with a receipt in flight (ambiguous). A receipt a commit carries is confirmed completed
-- with that commit, never with a snapshot, and cannot be confirmed not run; one no commit carries cannot be confirmed
-- completed if it requires a revision, and can be confirmed not run.
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; p jsonb := h -> 'actor'; c jsonb;
	v_carried uuid := extensions.gen_random_uuid(); v jsonb;
begin
	perform pg_temp.begin(b, v_carried, 'recover-1');
	c := public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', p, 'recover-save-1',
		jsonb_build_array(jsonb_build_object('op','mkdir','path','recovered')), null, v_carried);
	perform public.qorpera_terminalize_runner_attempt_before_native_start((b ->> 'jobId')::uuid, 'failed', 'Runner lost', false);
	if (select status from public.qorpera_run_operation_receipts where id = v_carried) is distinct from 'ambiguous' then
		raise exception 'An attempt ending with a receipt in flight leaves it ambiguous'; end if;
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select public.qorpera_resolve_run_operation_receipt(%L, %L)', v_carried, 'confirmed_not_run'),
		'55000', 'A folder commit carries this operation: it ran');
	perform pg_temp.raises_like(format('select public.qorpera_resolve_run_operation_receipt(%L, %L, %L, %L)', v_carried,
		'confirmed_completed', '{"ok":true}', extensions.gen_random_uuid()), '22023', 'operation recovery result is invalid');
	v := public.qorpera_resolve_run_operation_receipt(v_carried, 'confirmed_completed', '{"ok":true}');
	if v ->> 'status' is distinct from 'completed' or v ->> 'folder_commit_id' is distinct from c ->> 'commitId'
		or (select folder_commit_id::text from public.qorpera_run_operation_receipts where id = v_carried) is distinct from c ->> 'commitId' then
		raise exception 'A carried receipt is confirmed completed with its commit: %', v; end if;
	-- A member without authorize access cannot resolve.
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000003');
	perform pg_temp.raises_like(format('select public.qorpera_resolve_run_operation_receipt(%L, %L)', v_carried, 'confirmed_not_run'),
		'42501', 'operation recovery requires authorize access');
	perform pg_temp.path_claims('service_role');
end $$;
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; v_lost uuid := extensions.gen_random_uuid(); v jsonb;
begin
	perform pg_temp.begin(b, v_lost, 'recover-2');
	perform public.qorpera_terminalize_runner_attempt_before_native_start((b ->> 'jobId')::uuid, 'failed', 'Runner lost', false);
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select public.qorpera_resolve_run_operation_receipt(%L, %L, %L)', v_lost, 'confirmed_completed',
		'{"ok":true}'), '22023', 'operation recovery result is invalid');
	v := public.qorpera_resolve_run_operation_receipt(v_lost, 'confirmed_not_run');
	if v ->> 'status' is distinct from 'cancelled' or v ->> 'folder_commit_id' is not null then raise exception 'A lost receipt confirmed not run: %', v; end if;
	perform pg_temp.path_claims('service_role');
end $$;

-- 7. The sponsor handoff at a usage limit: a revision receipt that a folder commit satisfies may cross the attempt
-- boundary; the same receipt naming no commit may not (as a revision receipt with no snapshot today).
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; p jsonb := h -> 'actor'; c jsonb; v jsonb;
	v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.begin(b, v_receipt, 'handoff-save');
	c := public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', p, 'handoff-save-1',
		jsonb_build_array(jsonb_build_object('op','mkdir','path','handed')), null, v_receipt);
	perform public.qorpera_folder_complete_run_receipt(b, v_receipt, repeat('1', 64), '{"ok":true}'::jsonb, (c ->> 'commitId')::uuid);
	-- The company's other login on the run's computer identity, and a usage limit on the run's own.
	set local session_replication_role = replica;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values ('65800000-0000-4000-8000-0000000000d9', '63400000-0000-4000-8000-000000000010', '64700000-0000-4000-8000-0000000000d1',
		'company', 'openai', 'codex-cli', 'fixture://not-a-credential-either', repeat('e', 64), '63400000-0000-4000-8000-000000000001');
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
	values ('65800000-0000-4000-8000-0000000000b9', '63400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), null, 'openai',
		'63400000-0000-4000-8000-000000000001');
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
		consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id, max_native_concurrency, quota_policy, allow_autonomous)
	values ('65800000-0000-4000-8000-0000000000b9', 1, 'native_subscription', 'codex-cli', 'subscription', 'fixture',
		'63400000-0000-4000-8000-000000000001', '63400000-0000-4000-8000-000000000001', '65800000-0000-4000-8000-0000000000d9', 8,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
		true);
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source, observed_at)
	values ('63400000-0000-4000-8000-000000000010', (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid, '63400000-0000-4000-8000-0000000000b1', 1,
		'63400000-0000-4000-8000-0000000000b3', 1, 'openai', 'usage_limit', 'native_adapter', statement_timestamp());
	update public.qorpera_run_operation_receipts set folder_commit_id = null where id = v_receipt;
	set local session_replication_role = origin;
	if public.qorpera_handoff_run_sponsor((b ->> 'runId')::uuid, 'usage_limit') is not null then
		raise exception 'A revision receipt that names no commit must not cross the attempt boundary'; end if;
	perform pg_temp.fx(format('update public.qorpera_run_operation_receipts set folder_commit_id = %L where id = %L', c ->> 'commitId', v_receipt));
	v := public.qorpera_handoff_run_sponsor((b ->> 'runId')::uuid, 'usage_limit');
	if v is null or v ->> 'toConnectionId' is distinct from '65800000-0000-4000-8000-0000000000b9'
		or (select status from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid) is distinct from 'queued' then
		raise exception 'A receipt satisfied by a commit crosses the attempt boundary: %', v; end if;
end $$;

-- 8. Privileges: the new functions are postgres-only; the runtime reaches completion through v6 and a member reaches
-- recovery through its function.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_folder_complete_run_job(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)',
		'public.qorpera_folder_resolve_run_receipt(uuid,text,jsonb,uuid,uuid)'] loop
		if has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
			or has_function_privilege('anon', v_fn, 'execute') then
			raise exception '% must be postgres-only', v_fn; end if;
	end loop;
end $$;

rollback;
