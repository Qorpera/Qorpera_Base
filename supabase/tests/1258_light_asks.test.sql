-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"
-- Light asks (migration 20260930761000; deploy/first-node/RUNTIME-LIGHT-ASK.md): one small question a member's own
-- action raises, answered by one call to the small model, with nothing shown in a conversation. On 856's company after
-- a real creation (Anna the owner and Bo, each with a login of their own; the Co-Founder; Anna's queued first run).
-- 1. Who may call what; the ask's refusals.
-- 2. Anna asks: the ask, its wake as the pin trigger made it (the Co-Founder, Anna's own login, no parent, no
--    conversation, the payload from the ask), authorized; a repeat answers the same ask.
-- 3. The materializer makes its run, on a login that does not allow unattended use too; the run's authority and its
--    policy (no send).
-- 4. The run reads its wake (the kind, the input, no held coworker messages), is admitted with no tool and only with
--    none, and stores the answer, once; Anna reads it, and nobody else does. The run ends silent. Any other run needs
--    a tool and stores no answer.
-- 5. No answer; an answer after the ask's time; an ask past its time before its run; eight waiting asks; day-old asks
--    go when their member asks again; no login of one's own; a paused company keeps no ask.

-- Each pass as its own transaction would start it (874's).
create function pg_temp.materialize(p_profile uuid, p_limit integer default 16) returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;
create function pg_temp.input(p_first text default 'Bank', p_second text default 'Company finances') returns jsonb language sql as $$
	select jsonb_build_object('apps', jsonb_build_array(jsonb_build_object('name', p_first),
		jsonb_build_object('name', p_second, 'about', 'What the company earns and spends.')), 'language', 'en')
$$;
-- A member asks, as the web does.
create function pg_temp.ask(p_user uuid, p_client uuid, p_input jsonb default null, p_kind text default 'name-app-group')
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.as_user(p_user);
	perform set_config('qorpera.folder_wake_admission', '', true);
	set local role authenticated;
	v_result := public.qorpera_request_light_ask(current_setting('qorpera_test.table')::uuid, p_client, p_kind,
		coalesce(p_input, pg_temp.input()));
	reset role;
	return v_result;
end $$;
create function pg_temp.read(p_user uuid, p_ask uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v_result := public.qorpera_read_light_ask(current_setting('qorpera_test.table')::uuid, p_ask);
	reset role;
	return v_result;
end $$;
create function pg_temp.ask_row(p_ask uuid) returns public.qorpera_light_asks language sql as $$
	select * from public.qorpera_light_asks where id = p_ask
$$;
create function pg_temp.wake_of(p_ask uuid) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where source_kind = 'light-ask' and source_id = p_ask
$$;
-- A light wake's run, leased, with the native rows its binding needs (915's, on the run the materializer made: its
-- reservation, budget and model policy are the materializer's own).
create function pg_temp.leased_run(p_run uuid) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_capsule uuid; v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_lease uuid := extensions.gen_random_uuid();
begin
	select * into strict v_run from public.qorpera_execution_runs where id = p_run;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	select credential_capsule_id into strict v_capsule from public.qorpera_provider_connection_versions
	where connection_id = v_sponsor.provider_connection_id and version = v_sponsor.provider_connection_version;
	set local session_replication_role = replica;
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values (v_runner, v_run.profile_id, v_runner, 'Light runner', '["agent_turn"]', 'active', repeat('e', 64),
		clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour',
		v_run.created_by_user_id, v_run.compute_identity_id);
	update public.qorpera_runner_jobs set status = 'leased', runner_id = v_runner, client_lease_id = v_assignment,
		lease_token_sha256 = repeat('a', 64), lease_expires_at = clock_timestamp() + interval '1 hour' where id = v_run.job_id;
	-- A real orchestrator and claim: this file is one transaction, so a later update of the assignment checks its keys.
	insert into public.qorpera_runner_orchestrators(id, display_name, provider_adapter, control_token_sha256, control_token_expires_at)
	values (v_runner, 'Light orchestrator', 'fixture', encode(extensions.digest(v_runner::text, 'sha256'), 'hex'),
		clock_timestamp() + interval '1 hour');
	insert into public.qorpera_runner_job_claims(id, orchestrator_id, client_claim_id, job_id, run_id, status, lease_expires_at)
	values (v_lease, v_runner, v_lease, v_run.job_id, v_run.id, 'accepted', clock_timestamp() + interval '1 hour');
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values (v_assignment, v_lease, v_run.job_id, v_run.id, v_runner, repeat('e', 64), 'accepted',
		clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run.id, v_run.job_id, v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, v_capsule,
		v_run.compute_identity_id, v_runner, v_assignment, repeat('d', 64), clock_timestamp() + interval '1 hour');
	set local session_replication_role = origin;
	return jsonb_build_object('leaseId', v_lease, 'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', v_runner,
		'assignmentId', v_assignment, 'credentialCapsuleId', v_capsule, 'computeIdentityId', v_run.compute_identity_id,
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', v_run.model_id);
end $$;
create function pg_temp.leased(p_wake uuid) returns jsonb language sql as $$
	select pg_temp.leased_run((select id from public.qorpera_execution_runs where source_kind = 'wake' and source_id = p_wake))
$$;
-- A run's admission with a tool catalog of `p_tools` tools (the manifest's binary, the run's bundle and policy).
create function pg_temp.admit(p_binding jsonb, p_tools integer) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	perform pg_temp.as_service();
	select * into strict v_run from public.qorpera_execution_runs where id = (p_binding ->> 'runId')::uuid;
	return public.qorpera_begin_native_company_execution_v3(p_binding,
		public.qorpera_execution_runtime_manifest(v_run) ->> 'nativeBinarySha256', v_run.runtime_bundle_sha256,
		v_run.reasoning_policy_sha256,
		jsonb_build_object('type', 'namespace', 'name', 'qorpera', 'description', 'Fixture catalog', 'tools',
			(select coalesce(jsonb_agg(jsonb_build_object('type', 'function', 'name', 'tool_' || n, 'description', 'Fixture tool',
				'inputSchema', '{"type":"object","additionalProperties":false}'::jsonb)), '[]'::jsonb)
			from generate_series(1, p_tools) n))::text);
end $$;
-- The runtime's completion of a run that sent nothing (658's).
create function pg_temp.complete(p_binding jsonb) returns jsonb language sql as $$
	select public.qorpera_complete_runner_job_v6((p_binding ->> 'runnerId')::uuid, repeat('f', 64), (p_binding ->> 'jobId')::uuid,
		repeat('a', 64), '12580000-0000-4000-8000-0000000000a1', '12580000-0000-4000-8000-0000000000a2', null,
		jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
			'native_lease_id', p_binding ->> 'leaseId',
			'substrate_version_id', (select substrate_version_id from public.qorpera_runner_jobs where id = (p_binding ->> 'jobId')::uuid),
			'output_count',0,'output_bytes',0,'publication',null,
			'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',p_binding ->> 'runId',
				'message_count',0,'final_message_id',null,'provider_session_id','light-thread-' || (p_binding ->> 'runId')),
			'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb))
$$;
create function pg_temp.answer(p_binding jsonb, p_answer text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.as_service();
	set local role service_role;
	v_result := public.qorpera_native_light_ask_answer(p_binding, p_answer);
	reset role;
	return v_result;
end $$;

-- 1. Who may call what; the refusals ------------------------------------------------------------------------------------

do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_request_light_ask(uuid,uuid,text,jsonb)',
		'public.qorpera_read_light_ask(uuid,uuid)'] loop
		if has_function_privilege('anon', v_function, 'EXECUTE') or not has_function_privilege('authenticated', v_function, 'EXECUTE')
			or has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% is not the members'' call alone', v_function; end if;
	end loop;
	if has_function_privilege('anon', 'public.qorpera_native_light_ask_answer(jsonb,text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_native_light_ask_answer(jsonb,text)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_native_light_ask_answer(jsonb,text)', 'EXECUTE') then
		raise exception 'The answer is not the native host''s call alone'; end if;
	foreach v_function in array array['public.qorpera_light_ask_sponsor(uuid,uuid)', 'public.qorpera_run_answers_light_ask(uuid)',
		'public.qorpera_light_ask_input_valid(text,jsonb)', 'public.qorpera_light_ask_json(public.qorpera_light_asks)',
		'public.qorpera_light_ask_expires_at(timestamptz)'] loop
		if has_function_privilege('anon', v_function, 'EXECUTE') or has_function_privilege('authenticated', v_function, 'EXECUTE')
			or has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% is callable through the API', v_function; end if;
	end loop;
	if has_table_privilege('anon', 'public.qorpera_light_asks', 'SELECT')
		or has_table_privilege('authenticated', 'public.qorpera_light_asks', 'SELECT')
		or has_table_privilege('service_role', 'public.qorpera_light_asks', 'SELECT')
		or not (select relrowsecurity from pg_class where oid = 'public.qorpera_light_asks'::regclass) then
		raise exception 'The asks are readable through the API'; end if;
	if not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_native_light_ask_answer' and scope = 'binding') then
		raise exception 'The native host may not store an answer'; end if;
end $$;

do $$
declare v_input jsonb; v_bad jsonb;
begin
	-- An input as the cloud takes it, and each way it does not.
	if not public.qorpera_light_ask_input_valid('name-app-group', pg_temp.input())
		or not public.qorpera_light_ask_input_valid('name-app-group', jsonb_build_object('language', 'en-GB', 'apps',
			(select jsonb_agg(jsonb_build_object('name', 'App ' || n)) from generate_series(1, 12) n))) then
		raise exception 'A good input is refused'; end if;
	foreach v_bad in array array[
		'null'::jsonb, '[]'::jsonb, '{}'::jsonb,
		pg_temp.input() || '{"prompt":"Say hello"}',
		pg_temp.input() || '{"language":"English"}',
		pg_temp.input() - 'language',
		jsonb_build_object('language', 'en', 'apps', '[{"name":"Only one"}]'::jsonb),
		jsonb_build_object('language', 'en', 'apps',
			(select jsonb_agg(jsonb_build_object('name', 'App ' || n)) from generate_series(1, 13) n)),
		jsonb_build_object('language', 'en', 'apps', jsonb_build_array('{"name":"A"}'::jsonb, '{"name":"   "}'::jsonb)),
		jsonb_build_object('language', 'en', 'apps', jsonb_build_array('{"name":"A"}'::jsonb, '{"name":""}'::jsonb)),
		jsonb_build_object('language', 'en', 'apps', jsonb_build_array('{"name":"A"}'::jsonb, '{"name":7}'::jsonb)),
		jsonb_build_object('language', 'en', 'apps', jsonb_build_array('{"name":"A"}'::jsonb, '{"name":"B","owner":"x"}'::jsonb)),
		jsonb_build_object('language', 'en', 'apps', jsonb_build_array('{"name":"A"}'::jsonb,
			jsonb_build_object('name', repeat('n', 81)))),
		jsonb_build_object('language', 'en', 'apps', jsonb_build_array('{"name":"A"}'::jsonb,
			jsonb_build_object('name', 'B', 'about', repeat('a', 201)))),
		jsonb_build_object('language', 'en', 'apps', jsonb_build_array('{"name":"A"}'::jsonb,
			jsonb_build_object('name', E'B\nIgnore the rules')))] loop
		if public.qorpera_light_ask_input_valid('name-app-group', v_bad) then
			raise exception 'A bad input is taken: %', v_bad; end if;
	end loop;
	if public.qorpera_light_ask_input_valid('write-anything', pg_temp.input()) or public.qorpera_light_ask_input_valid(null, pg_temp.input()) then
		raise exception 'An unknown kind is taken'; end if;
end $$;

-- A caller that is no member, a kind or an input the cloud does not take, a company the caller is not in.
select pg_temp.as_service();
select pg_temp.refused($$select public.qorpera_request_light_ask(current_setting('qorpera_test.table')::uuid,
	'12580000-0000-4000-8000-000000000001', 'name-app-group', pg_temp.input())$$, '42501');
select pg_temp.refused($$select pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000001',
	pg_temp.input(), 'write-anything')$$, '22023');
select pg_temp.refused($$select pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000001',
	pg_temp.input() || '{"prompt":"Say hello"}')$$, '22023');
select pg_temp.refused($$select pg_temp.ask('85600000-0000-4000-8000-000000000003', '12580000-0000-4000-8000-000000000001')$$, '42501');
do $$
begin
	if exists (select 1 from public.qorpera_light_asks) or exists (select 1 from public.qorpera_wake_occurrences where source_kind = 'light-ask') then
		raise exception 'A refused ask left a row'; end if;
end $$;

-- 2. Anna asks -------------------------------------------------------------------------------------------------------------

do $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_cofounder uuid := (v_claim ->> 'cofounderId')::uuid; v_result jsonb; v_again jsonb;
	v_ask public.qorpera_light_asks; v_wake public.qorpera_wake_occurrences; v_binding uuid;
begin
	v_result := pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000001');
	if v_result ->> 'schema' is distinct from 'qorpera.light-ask/v1' or v_result ->> 'state' is distinct from 'waiting'
		or v_result ->> 'kind' is distinct from 'name-app-group' or v_result -> 'answer' <> 'null'::jsonb
		or v_result -> 'problem' <> 'null'::jsonb
		or (select array_agg(k order by k) from jsonb_object_keys(v_result) k) is distinct from array['answer','id','kind','problem','schema','state'] then
		raise exception 'The ask does not wait: %', v_result; end if;
	perform set_config('qorpera_test.ask', v_result ->> 'id', true);
	v_ask := pg_temp.ask_row((v_result ->> 'id')::uuid);
	v_wake := pg_temp.wake_of(v_ask.id);
	-- Anna's own binding: the one her queued first run names.
	select sponsor_binding_id into strict v_binding from public.qorpera_session_turn_requests where profile_id = v_profile;
	if v_ask.state <> 'woken' or v_ask.wake_id is distinct from v_wake.id or v_ask.profile_id <> v_profile
		or v_ask.requested_by_user_id <> '85600000-0000-4000-8000-000000000001' or v_ask.input <> pg_temp.input() then
		raise exception 'The ask is not as asked: %', to_jsonb(v_ask); end if;
	if v_wake.wake_kind <> 'agent' or v_wake.status <> 'queued' or v_wake.staff_agent_id is distinct from v_cofounder
		or v_wake.requested_by_user_id is distinct from '85600000-0000-4000-8000-000000000001'
		or v_wake.sponsor_binding_id is distinct from v_binding or v_wake.sponsor_version is null
		or v_wake.session_id is not null or v_wake.parent_run_id is not null or v_wake.logical_computer_id is not null
		or v_wake.routine_id is not null or v_wake.run_id is not null or v_wake.origin_run_id is not null
		or v_wake.trigger_id <> 'light-ask' or v_wake.occurrence_key <> 'light-ask:' || v_ask.id::text
		or v_wake.causal_root_id is distinct from v_wake.id or v_wake.causal_agent_ids is distinct from array[v_cofounder]
		or v_wake.payload - 'expiresAt' is distinct from jsonb_build_object('schema', 'qorpera.light-ask-wake/v1', 'askId', v_ask.id,
			'kind', 'name-app-group', 'input', pg_temp.input())
		or (v_wake.payload ->> 'expiresAt')::timestamptz is distinct from v_ask.created_at + interval '10 minutes' then
		raise exception 'The wake is not as the ask gives it: %', to_jsonb(v_wake); end if;
	perform pg_temp.as_service();
	if not public.qorpera_wake_authorized(v_wake) then raise exception 'The wake is not authorized'; end if;
	-- The same call again answers the same ask: no second ask and no second wake.
	v_again := pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000001');
	if v_again is distinct from v_result or (select count(*) from public.qorpera_light_asks) <> 1
		or (select count(*) from public.qorpera_wake_occurrences where source_kind = 'light-ask') <> 1 then
		raise exception 'A repeated ask made another: %', v_again; end if;
end $$;
-- The same id with other content is refused.
select pg_temp.refused($$select pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000001',
	pg_temp.input('Mailbox', 'Members'))$$, '23505');
-- What a wake's inserter sends is not trusted: a second wake for an ask that has one, and a wake for no ask, are refused.
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_wake public.qorpera_wake_occurrences;
begin
	v_wake := pg_temp.wake_of(current_setting('qorpera_test.ask')::uuid);
	perform pg_temp.as_service();
	perform public.qorpera_folder_admit_wakes(v_profile);
	begin
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
			requested_by_user_id, trigger_id, occurrence_key, scheduled_for, not_before)
		values (extensions.gen_random_uuid(), v_profile, v_wake.environment_id, 'agent', 'light-ask', v_wake.source_id,
			v_wake.staff_agent_id, '85600000-0000-4000-8000-000000000002', 'light-ask', 'light-ask:again', clock_timestamp(), clock_timestamp());
		raise exception 'An ask took a second wake';
	exception when insufficient_privilege then null;
	end;
	begin
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
			requested_by_user_id, trigger_id, occurrence_key, scheduled_for, not_before)
		values (extensions.gen_random_uuid(), v_profile, v_wake.environment_id, 'agent', 'light-ask', extensions.gen_random_uuid(),
			v_wake.staff_agent_id, '85600000-0000-4000-8000-000000000001', 'light-ask', 'light-ask:none', clock_timestamp(), clock_timestamp());
		raise exception 'A wake was made for no ask';
	exception when insufficient_privilege then null;
	end;
	perform set_config('qorpera.folder_wake_admission', '', true);
end $$;

-- 3. Its run, on a login that does not allow unattended use ----------------------------------------------------------------

-- Anna's login no longer allows unattended use, as a ChatGPT plan's does not: her own ask still runs on it.
set local session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set allow_autonomous = false
where binding_id = (select sponsor_binding_id from public.qorpera_wake_occurrences where source_kind = 'light-ask');
set local session_replication_role = origin;
do $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_cofounder uuid := (v_claim ->> 'cofounderId')::uuid; v_result jsonb; v_wake public.qorpera_wake_occurrences;
	v_run public.qorpera_execution_runs; v_job public.qorpera_runner_jobs; v_policy jsonb;
begin
	v_result := pg_temp.materialize(v_profile);
	v_wake := pg_temp.wake_of(current_setting('qorpera_test.ask')::uuid);
	if v_result ->> 'state' is distinct from 'done' or v_wake.status <> 'materialized' or v_wake.run_id is null
		or not (v_result -> 'run_ids') @> to_jsonb(v_wake.run_id) or (v_result ->> 'cancelled')::integer <> 0
		or (v_result ->> 'blocked')::integer <> 0 then
		raise exception 'The light wake was not materialized: % %', v_result, to_jsonb(v_wake); end if;
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	if v_run.source_kind <> 'wake' or v_run.source_id <> v_wake.id or v_run.session_id is not null
		or v_run.staff_agent_id <> v_cofounder or v_run.requested_by_user_id <> '85600000-0000-4000-8000-000000000001'
		or v_run.sponsor_binding_id <> v_wake.sponsor_binding_id or v_run.sponsor_version <> v_wake.sponsor_version
		or v_run.job_type <> 'agent_turn' or v_run.required_capability <> 'agent_turn' or v_run.logical_computer_id is not null
		or v_run.worker_class <> 'managed_sandbox' or v_run.audience_kind <> 'company' or cardinality(v_run.input_ids) <> 0
		or v_job.status <> 'queued' or v_job.payload ->> 'schema' <> 'qorpera.wake-run/v1' then
		raise exception 'The light run is not as agreed: % %', to_jsonb(v_run), to_jsonb(v_job); end if;
	if not exists (select 1 from public.qorpera_execution_sponsor_reservations where run_id = v_run.id and status = 'reserved')
		or not exists (select 1 from public.qorpera_runner_model_policies where job_id = v_job.id) then
		raise exception 'The light run has no reservation or model policy'; end if;
	-- Its login may be used: for the light wake's run, and for no other wake's run on that login.
	if not public.qorpera_run_autonomous_authority(v_run) or not public.qorpera_execution_sponsor_available(v_run) then
		raise exception 'The light run may not use its login'; end if;
	if public.qorpera_run_autonomous_authority(jsonb_populate_record(v_run, jsonb_build_object('source_id', extensions.gen_random_uuid())))
		or public.qorpera_run_autonomous_authority(jsonb_populate_record(v_run,
			jsonb_build_object('requested_by_user_id', '85600000-0000-4000-8000-000000000002'))) then
		raise exception 'Another wake''s run may use a login that allows no unattended use'; end if;
	if not public.qorpera_wake_authorized(v_wake) or not public.qorpera_run_wake_authorized(v_run.id) then
		raise exception 'The run''s wake is not authorized'; end if;
	-- An agent wake's own policy: nothing is sent.
	v_policy := public.qorpera_runtime_wake_policy_internal(v_run.id);
	if v_policy is distinct from public.qorpera_wake_policy_value('agent', 'optional') or v_policy ->> 'final' <> 'forbidden'
		or (v_policy ->> 'maxPublicSends')::integer <> 0 then
		raise exception 'The light run may speak: %', v_policy; end if;
end $$;

-- 4. The run reads its wake and stores the answer ------------------------------------------------------------------------

do $$
declare v_ask uuid := current_setting('qorpera_test.ask')::uuid; v_wake public.qorpera_wake_occurrences; v_binding jsonb;
	v_envelope jsonb; v_receipt jsonb; v_read jsonb;
begin
	v_wake := pg_temp.wake_of(v_ask);
	v_binding := pg_temp.leased(v_wake.id);
	perform set_config('qorpera_test.light_binding', v_binding::text, true);
	-- A coworker's message waits for the Co-Founder's next run: a light run is not that run, and leaves it waiting.
	set local session_replication_role = replica;
	insert into public.qorpera_pending_peer_messages(profile_id, environment_id, pair_session_id, event_id, sender_staff_id,
		recipient_staff_id, text)
	values (v_wake.profile_id, v_wake.environment_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), v_wake.staff_agent_id, 'The numbers are in.');
	set local session_replication_role = origin;
	perform pg_temp.as_service();
	v_envelope := public.qorpera_read_native_wake(v_binding);
	if v_envelope -> 'payload' ? 'heldMessages' or exists (select 1 from public.qorpera_pending_peer_messages
		where recipient_staff_id = v_wake.staff_agent_id and delivered_run_id is not null) then
		raise exception 'A light run took a coworker''s held message: %', v_envelope -> 'payload'; end if;
	if v_envelope ->> 'kind' is distinct from 'agent' or v_envelope -> 'source' ->> 'kind' is distinct from 'light-ask'
		or v_envelope -> 'source' ->> 'id' is distinct from v_ask::text or v_envelope ->> 'parentRunId' is not null
		or v_envelope -> 'audience' ->> 'sessionId' is not null or v_envelope -> 'policy' ->> 'final' is distinct from 'forbidden'
		or v_envelope ->> 'requesterUserId' is distinct from '85600000-0000-4000-8000-000000000001'
		or v_envelope ->> 'actorStaffId' is not null or v_envelope -> 'causal' ->> 'rootId' is distinct from v_wake.id::text
		or v_envelope -> 'payload' is distinct from v_wake.payload then
		raise exception 'The run''s wake: %', v_envelope; end if;
	-- Its admission: a light ask's run offers no tool. A catalog with one is refused, the empty one is taken, and the
	-- bound context writes the run's start.
	begin
		perform pg_temp.admit(v_binding, 1);
		raise exception 'A light run was admitted with a tool';
	exception when invalid_parameter_value then null;
	end;
	if pg_temp.admit(v_binding, 0) ->> 'schema' is distinct from 'qorpera.native-company-execution-admission/v1' then
		raise exception 'A light run was not admitted with no tool'; end if;
	v_receipt := public.qorpera_bind_native_company_context(v_binding, repeat('c', 64), 120);
	if v_receipt ->> 'schema' is distinct from 'qorpera.native-company-execution-start/v1'
		or not exists (select 1 from public.qorpera_execution_run_events where run_id = (v_binding ->> 'runId')::uuid
			and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1') then
		raise exception 'The light run''s start was not written: %', v_receipt; end if;
	-- Before the answer Anna reads it as waiting.
	if pg_temp.read('85600000-0000-4000-8000-000000000001', v_ask) ->> 'state' is distinct from 'waiting' then
		raise exception 'The ask does not read as waiting'; end if;
	v_receipt := pg_temp.answer(v_binding, E'  Money \n  matters ');
	if v_receipt is distinct from jsonb_build_object('schema', 'qorpera.light-ask-answer/v1', 'askId', v_ask, 'state', 'answered',
		'replayed', false) then raise exception 'The answer''s receipt: %', v_receipt; end if;
	-- The first answer stands.
	v_receipt := pg_temp.answer(v_binding, 'Something else');
	if v_receipt ->> 'state' is distinct from 'answered' or (v_receipt ->> 'replayed')::boolean is not true
		or (pg_temp.ask_row(v_ask)).answer is distinct from 'Money matters' then
		raise exception 'A second answer changed the first: % %', v_receipt, to_jsonb(pg_temp.ask_row(v_ask)); end if;
	v_read := pg_temp.read('85600000-0000-4000-8000-000000000001', v_ask);
	if v_read ->> 'state' is distinct from 'answered' or v_read ->> 'answer' is distinct from 'Money matters'
		or v_read -> 'problem' <> 'null'::jsonb then raise exception 'Anna reads: %', v_read; end if;
	-- Bo, a member of the same company, reads none of Anna's asks; nor does Anna under another company.
	if pg_temp.read('85600000-0000-4000-8000-000000000002', v_ask) is not null then raise exception 'Bo reads Anna''s ask'; end if;
	perform pg_temp.as_user('85600000-0000-4000-8000-000000000001');
	if public.qorpera_read_light_ask(current_setting('qorpera_test.old')::uuid, v_ask) is not null then
		raise exception 'An ask reads under another company'; end if;
end $$;
-- The run ends as a silent run ends: completed with no send and no conversation, its wake with it.
do $$
declare v_binding jsonb := current_setting('qorpera_test.light_binding')::jsonb; v_done jsonb;
	v_wake public.qorpera_wake_occurrences; v_run public.qorpera_execution_runs;
begin
	perform pg_temp.as_service();
	v_done := pg_temp.complete(v_binding);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	v_wake := pg_temp.wake_of(current_setting('qorpera_test.ask')::uuid);
	if v_done ->> 'status' is distinct from 'completed' or v_wake.status <> 'completed'
		or exists (select 1 from public.qorpera_agent_sends where run_id = v_run.id)
		or not exists (select 1 from public.qorpera_execution_run_results result where result.run_id = v_run.id
			and result.transcript_end_sequence = v_run.transcript_start_sequence and result.company_disposition = 'unchanged') then
		raise exception 'The light run did not end silent: % %', v_done, to_jsonb(v_wake); end if;
	-- The answer stands after the run.
	if (pg_temp.ask_row(current_setting('qorpera_test.ask')::uuid)).answer is distinct from 'Money matters' then
		raise exception 'The answer went with the run'; end if;
end $$;
-- Every other run offers at least one tool: Anna's first run, made in the same pass, is refused with none.
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.leased_run((select id from public.qorpera_execution_runs
		where profile_id = current_setting('qorpera_test.table')::uuid and source_kind = 'session_turn'));
	begin
		perform pg_temp.admit(v_binding, 0);
		raise exception 'A run that is no light ask''s was admitted with no tool';
	exception when invalid_parameter_value then null;
	end;
	if pg_temp.admit(v_binding, 1) ->> 'schema' is distinct from 'qorpera.native-company-execution-admission/v1' then
		raise exception 'A run with a tool was not admitted'; end if;
	-- And it stores no light answer.
	begin
		perform pg_temp.answer(v_binding, 'Mine');
		raise exception 'A run that is no light ask''s stored an answer';
	exception when insufficient_privilege then null;
	end;
end $$;
-- Only a member reads; only the native host answers, and only for a light ask's run.
select pg_temp.as_service();
select pg_temp.refused($$select public.qorpera_read_light_ask(current_setting('qorpera_test.table')::uuid,
	current_setting('qorpera_test.ask')::uuid)$$, '42501');
select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
select pg_temp.refused($$select public.qorpera_native_light_ask_answer(current_setting('qorpera_test.light_binding')::jsonb, 'Mine')$$, '42501');

-- 5. No answer; past its time; eight waiting; no login; paused ------------------------------------------------------------

do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_result jsonb; v_ask uuid; v_wake public.qorpera_wake_occurrences;
	v_binding jsonb; v_receipt jsonb; v_read jsonb; v_n integer;
begin
	-- The model gave nothing, or something that is no name: no answer, said as such.
	v_ask := (pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000002') ->> 'id')::uuid;
	perform pg_temp.materialize(v_profile);
	v_binding := pg_temp.leased((pg_temp.wake_of(v_ask)).id);
	v_receipt := pg_temp.answer(v_binding, null);
	v_read := pg_temp.read('85600000-0000-4000-8000-000000000001', v_ask);
	if v_receipt ->> 'state' is distinct from 'failed' or v_read ->> 'state' is distinct from 'failed'
		or v_read ->> 'problem' is distinct from 'no_answer' or v_read -> 'answer' <> 'null'::jsonb then
		raise exception 'No answer does not read as failed: % %', v_receipt, v_read; end if;
	v_ask := (pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000003') ->> 'id')::uuid;
	perform pg_temp.materialize(v_profile);
	v_binding := pg_temp.leased((pg_temp.wake_of(v_ask)).id);
	if pg_temp.answer(v_binding, repeat('x', 201)) ->> 'state' is distinct from 'failed' then
		raise exception 'An answer over 200 characters is kept'; end if;

	-- An answer that comes after the ask's ten minutes is not kept (review F1 on #1796): the asker has read the ask as
	-- failed since then, and that stands, for an answer and for none.
	v_ask := (pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000005') ->> 'id')::uuid;
	perform pg_temp.materialize(v_profile);
	v_binding := pg_temp.leased((pg_temp.wake_of(v_ask)).id);
	update public.qorpera_light_asks set created_at = created_at - interval '11 minutes' where id = v_ask;
	v_read := pg_temp.read('85600000-0000-4000-8000-000000000001', v_ask);
	if v_read ->> 'state' is distinct from 'failed' or v_read ->> 'problem' is distinct from 'expired' then
		raise exception 'A running ask past its time does not read as expired: %', v_read; end if;
	v_receipt := pg_temp.answer(v_binding, 'Too late');
	v_read := pg_temp.read('85600000-0000-4000-8000-000000000001', v_ask);
	if v_receipt ->> 'state' is distinct from 'failed' or v_read ->> 'state' is distinct from 'failed'
		or v_read ->> 'problem' is distinct from 'expired' or v_read -> 'answer' <> 'null'::jsonb
		or (pg_temp.ask_row(v_ask)).answer is not null or (pg_temp.ask_row(v_ask)).problem is distinct from 'expired' then
		raise exception 'A late answer was kept: % %', v_receipt, v_read; end if;
	v_ask := (pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000006') ->> 'id')::uuid;
	perform pg_temp.materialize(v_profile);
	v_binding := pg_temp.leased((pg_temp.wake_of(v_ask)).id);
	update public.qorpera_light_asks set created_at = created_at - interval '11 minutes' where id = v_ask;
	perform pg_temp.answer(v_binding, null);
	if pg_temp.read('85600000-0000-4000-8000-000000000001', v_ask) ->> 'problem' is distinct from 'expired' then
		raise exception 'No answer after its time changed why the ask failed'; end if;

	-- Past its time before its run: it reads as failed, its wake is no longer authorized, and the materializer ends it.
	v_ask := (pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000004') ->> 'id')::uuid;
	update public.qorpera_light_asks set created_at = created_at - interval '11 minutes' where id = v_ask;
	v_read := pg_temp.read('85600000-0000-4000-8000-000000000001', v_ask);
	v_wake := pg_temp.wake_of(v_ask);
	perform pg_temp.as_service();
	if v_read ->> 'state' is distinct from 'failed' or v_read ->> 'problem' is distinct from 'expired'
		or public.qorpera_wake_authorized(v_wake) then raise exception 'An ask past its time still waits: %', v_read; end if;
	v_result := pg_temp.materialize(v_profile);
	v_wake := pg_temp.wake_of(v_ask);
	if v_wake.status <> 'cancelled' or v_wake.run_id is not null or (v_result ->> 'cancelled')::integer <> 1 then
		raise exception 'An ask past its time ran: % %', v_result, to_jsonb(v_wake); end if;

	-- Eight wait; the ninth fails at once and wakes nobody.
	for v_n in 1 .. 8 loop
		v_result := pg_temp.ask('85600000-0000-4000-8000-000000000001', ('12580000-0000-4000-8000-0000000001' || lpad(v_n::text, 2, '0'))::uuid);
		if v_result ->> 'state' is distinct from 'waiting' then raise exception 'Ask % of eight does not wait: %', v_n, v_result; end if;
	end loop;
	v_result := pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000109');
	if v_result ->> 'state' is distinct from 'failed' or v_result ->> 'problem' is distinct from 'too_many'
		or (pg_temp.wake_of((v_result ->> 'id')::uuid)).id is not null then raise exception 'A ninth waiting ask: %', v_result; end if;
	-- Bo's asks are his own count.
	v_result := pg_temp.ask('85600000-0000-4000-8000-000000000002', '12580000-0000-4000-8000-000000000201');
	if v_result ->> 'state' is distinct from 'waiting'
		or (pg_temp.wake_of((v_result ->> 'id')::uuid)).requested_by_user_id is distinct from '85600000-0000-4000-8000-000000000002'
		or (pg_temp.wake_of((v_result ->> 'id')::uuid)).sponsor_binding_id = (pg_temp.wake_of(current_setting('qorpera_test.ask')::uuid)).sponsor_binding_id then
		raise exception 'Bo''s ask is not on Bo''s own login: %', v_result; end if;

	-- Asks a day old go when their member asks again, and only that member's (review F4 on #1796). Anna's first ask and
	-- Bo's are a day old; Anna asks.
	update public.qorpera_light_asks set created_at = created_at - interval '25 hours'
	where id in (current_setting('qorpera_test.ask')::uuid, (v_result ->> 'id')::uuid);
	v_ask := (v_result ->> 'id')::uuid;
	v_n := (select count(*) from public.qorpera_light_asks where requested_by_user_id = '85600000-0000-4000-8000-000000000001');
	v_result := pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000501');
	if (pg_temp.ask_row(current_setting('qorpera_test.ask')::uuid)).id is not null
		or (pg_temp.ask_row(v_ask)).id is null
		-- One went and one came: every other ask of Anna's, none of them a day old, is still there.
		or (select count(*) from public.qorpera_light_asks where requested_by_user_id = '85600000-0000-4000-8000-000000000001') <> v_n
		or pg_temp.read('85600000-0000-4000-8000-000000000001', current_setting('qorpera_test.ask')::uuid) is not null then
		raise exception 'A day-old ask stayed, or another member''s went: %', v_result; end if;
	-- Its client id is free again: the same id with other content is a new ask, not a refusal.
	v_result := pg_temp.ask('85600000-0000-4000-8000-000000000001', '12580000-0000-4000-8000-000000000001',
		pg_temp.input('Mailbox', 'Members'));
	if v_result ->> 'id' = current_setting('qorpera_test.ask') or (pg_temp.ask_row((v_result ->> 'id')::uuid)).input
		is distinct from pg_temp.input('Mailbox', 'Members') then
		raise exception 'A removed ask''s client id is still bound: %', v_result; end if;
end $$;

-- A member with no login of their own: nobody else's login and no company account pays.
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
	('12580000-0000-4000-8000-0000000000d1', 'dee@example.test', statement_timestamp(), '{"display_name":"Dee"}');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	(current_setting('qorpera_test.table')::uuid, '12580000-0000-4000-8000-0000000000d1', 'dee@example.test', 'Dee', 'contributor'),
	(current_setting('qorpera_test.table')::uuid, '85600000-0000-4000-8000-000000000003', 'cy@example.test', 'Cy', 'viewer');
do $$
declare v_result jsonb;
begin
	v_result := pg_temp.ask('12580000-0000-4000-8000-0000000000d1', '12580000-0000-4000-8000-000000000301');
	if v_result ->> 'state' is distinct from 'failed' or v_result ->> 'problem' is distinct from 'no_payer'
		or (pg_temp.wake_of((v_result ->> 'id')::uuid)).id is not null then raise exception 'An ask with no payer: %', v_result; end if;
end $$;
-- A member who may only look asks nothing.
select pg_temp.refused($$select pg_temp.ask('85600000-0000-4000-8000-000000000003', '12580000-0000-4000-8000-000000000302')$$, '42501');

-- A paused company keeps no ask: it is answered as failed under an id that names no row, and no wake is made.
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
values (current_setting('qorpera_test.table')::uuid, '85600000-0000-4000-8000-000000000001', 'Fixture: paused');
do $$
declare v_result jsonb; v_wake public.qorpera_wake_occurrences;
begin
	v_result := pg_temp.ask('85600000-0000-4000-8000-000000000002', '12580000-0000-4000-8000-000000000401');
	v_wake := pg_temp.wake_of((v_result ->> 'id')::uuid);
	if v_result ->> 'schema' is distinct from 'qorpera.light-ask/v1' or v_result ->> 'state' is distinct from 'failed'
		or v_result ->> 'problem' is distinct from 'unavailable' or v_result ->> 'kind' is distinct from 'name-app-group'
		or v_wake.id is not null or (pg_temp.ask_row((v_result ->> 'id')::uuid)).id is not null
		or exists (select 1 from public.qorpera_light_asks where client_ask_id = '12580000-0000-4000-8000-000000000401')
		or pg_temp.read('85600000-0000-4000-8000-000000000002', (v_result ->> 'id')::uuid) is not null then
		raise exception 'An ask in a paused company: % %', v_result, to_jsonb(v_wake); end if;
end $$;

rollback;
