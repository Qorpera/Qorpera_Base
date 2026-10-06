-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member's native login on folder-v2 lends its run nothing beyond the run's own binding: the native tool authority
-- answers only the service role (never a token of another role behind it), describes the run as a closed projection
-- with no secret in it, and refuses a binding with any field of another run, as it refuses an expired assignment or a
-- lease that expired while a tool waited. A send or card for another run or assignment is refused; an expired lease
-- replays no send; a job the owner cancelled neither replays nor delivers a final send. The owner's Disconnect revokes
-- the login's connection, versions, capsules and leases and fails the next queued run it would pay for. A contributor
-- cannot make a company-scoped compute identity, and a viewer or an outsider cannot change an agent thread's model or
-- speed (an outsider cannot read it either). The run is 924's run of Alice's on the owner's login (ported from
-- snapshot-v1 in the legacy sweep: 160's surviving checks, and 580's and 584's role checks).

-- 1. A contributor cannot make a company-scoped compute identity.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.base_error($q$select public.qorpera_upsert_scoped_compute_identity('92400000-0000-4000-8000-000000000010',
	'98400000-0000-4000-8000-000000000056', 'company', null, 'Unauthorized company identity', 'qorpera-company-linux', 'v1',
	'["agent_turn"]', '{}')$q$, '22023');
reset role;
select pg_temp.base_claims('service_role');

-- 2. The native tool authority answers the service role only, never another role's token behind it, and describes the
-- run's own binding with no secret in it.
set local role service_role;
do $$
declare
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_role text;
	v_authority jsonb;
	v_identity jsonb;
begin
	foreach v_role in array array['anon', 'authenticated', ''] loop
		begin
			perform set_config('request.jwt.claims', case when v_role = '' then '{}' else jsonb_build_object('role', v_role)::text end, true);
			begin
				perform public.qorpera_describe_native_tool_authority(v_binding);
				raise exception 'non-service JWT acquired native tool authority';
			exception when insufficient_privilege then null;
			end;
			raise exception using errcode = 'QTP01';
		exception when sqlstate 'QTP01' then null;
		end;
	end loop;
	v_authority := public.qorpera_describe_native_tool_authority(v_binding);
	v_identity := v_authority -> 'identity';
	if v_authority ->> 'schema' <> 'qorpera.native-tool-authority/v1'
		or (v_authority ->> 'validForMs')::integer not between 1 and 30000
		or v_identity ->> 'companyId' <> '92400000-0000-4000-8000-000000000010'
		or v_identity ->> 'runId' is distinct from v_binding ->> 'runId'
		or v_identity ->> 'jobId' is distinct from v_binding ->> 'jobId'
		or v_identity ->> 'runnerId' is distinct from v_binding ->> 'runnerId'
		or v_identity ->> 'assignmentId' is distinct from v_binding ->> 'assignmentId'
		or v_identity ->> 'leaseId' is distinct from v_binding ->> 'leaseId'
		or v_identity ->> 'computeIdentityId' is distinct from v_binding ->> 'computeIdentityId'
		or v_authority::text ~* '(token|secret|capsule|credential)' then
		raise exception 'native tool identity is not the closed cloud projection: %', v_authority;
	end if;
end $$;
reset role;

-- 3. Any field of another run is refused.
set local role service_role;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_patch jsonb;
begin
	for v_patch in select value from jsonb_array_elements('[
		{"runId":"92400000-0000-4000-8000-000000000010"},
		{"jobId":"92400000-0000-4000-8000-000000000010"},
		{"assignmentId":"92400000-0000-4000-8000-000000000010"},
		{"runnerId":"92400000-0000-4000-8000-000000000010"},
		{"leaseId":"92400000-0000-4000-8000-000000000010"},
		{"credentialCapsuleId":"92400000-0000-4000-8000-000000000010"},
		{"computeIdentityId":"92400000-0000-4000-8000-000000000010"},
		{"model":"not-the-pinned-model"}
	]'::jsonb) loop
		begin
			perform public.qorpera_describe_native_tool_authority(v_binding || v_patch);
			raise exception 'native tools accepted another run binding: %', v_patch;
		exception when insufficient_privilege then null;
		end;
	end loop;
end $$;
reset role;

-- 4. An expired assignment is refused (rolled back).
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	begin
		update public.qorpera_runner_assignments set expires_at = statement_timestamp() - interval '1 second'
		where id = (v_binding ->> 'assignmentId')::uuid;
		set local role service_role;
		begin
			perform public.qorpera_describe_native_tool_authority(v_binding);
			raise exception 'native tools ignored an expired assignment';
		exception when insufficient_privilege then null;
		end;
		raise exception using errcode = 'QTP01';
	exception when sqlstate 'QTP01' then null;
	end;
end $$;
reset role;

-- The run's durable acknowledgement comes before any tool operation.
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'progress-1') \g /dev/null

-- 5. Clock time, not statement start, refuses a lease that expires while a tool waits (rolled back).
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	begin
		update public.qorpera_native_provider_connection_leases set expires_at = clock_timestamp() + interval '20 milliseconds'
		where id = (v_binding ->> 'leaseId')::uuid;
		perform pg_sleep(0.03);
		set local role service_role;
		begin
			perform public.qorpera_begin_native_tool_operation(v_binding, '98400000-0000-4000-8000-0000000000b1',
				'expired-at-effect', repeat('a', 64), repeat('b', 64), false);
			raise exception 'operation used statement time after authority expired';
		exception when insufficient_privilege then null;
		end;
		raise exception using errcode = 'QTP01';
	exception when sqlstate 'QTP01' then null;
	end;
end $$;
reset role;

-- The owner's next post (to Bob) waits in the queue on the same login.
do $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'Check the numbers later.');
	v_pass := pg_temp.base_materialize();
	if jsonb_array_length(v_pass -> 'run_ids') <> 1 then
		raise exception 'the post to Bob was not materialized: %', v_pass; end if;
	perform set_config('qorpera_test.nl_queued', v_pass -> 'run_ids' ->> 0, true);
	if (select job.status from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = current_setting('qorpera_test.nl_queued')::uuid) <> 'queued' then
		raise exception 'Bob''s run is not queued';
	end if;
end $$;
select pg_temp.base_claims('service_role');

-- 6. A send or a card for another run (Bob's), and a send for another assignment, are refused.
set local role service_role;
do $$
declare
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	begin
		perform pg_temp.base_public_send(v_binding || jsonb_build_object('runId', current_setting('qorpera_test.nl_queued')),
			'progress', 'wrong-audience');
		raise exception 'send accepted another run audience';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_append_native_interaction_request((v_binding ->> 'leaseId')::uuid,
			current_setting('qorpera_test.nl_queued')::uuid, (v_binding ->> 'jobId')::uuid, (v_binding ->> 'runnerId')::uuid,
			(v_binding ->> 'assignmentId')::uuid, (v_binding ->> 'credentialCapsuleId')::uuid,
			(v_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', '98400000-0000-4000-8000-0000000000c1',
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'takeover', 'title', 'Computer',
				'payload', jsonb_build_object('instruction', 'Finish the sign-in.', 'reason', 'sign_in')));
		raise exception 'card accepted another run audience';
	exception when insufficient_privilege then null;
	end;
	begin
		perform pg_temp.base_public_send(v_binding || '{"assignmentId":"92400000-0000-4000-8000-000000000010"}', 'progress',
			'wrong-assignment');
		raise exception 'send accepted another assignment';
	exception when insufficient_privilege then null;
	end;
end $$;
reset role;

-- 7. An expired lease replays no send.
update public.qorpera_native_provider_connection_leases
set created_at = statement_timestamp() - interval '2 seconds', expires_at = statement_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'leaseId')::uuid;
set local role service_role;
select pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L, %L)',
	current_setting('qorpera_test.base_binding'), 'progress', 'progress-1'), '42501');
reset role;
update public.qorpera_native_provider_connection_leases set expires_at = statement_timestamp() + interval '120 seconds'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'leaseId')::uuid;

-- 8. A job the owner cancelled while its lease is live replays no send and delivers no final send; the delivered
-- conversation is unchanged (rolled back).
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	begin
		perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
		set local role authenticated;
		perform public.qorpera_cancel_runner_job((v_binding ->> 'jobId')::uuid);
		perform pg_temp.base_claims('service_role');
		set local role service_role;
		begin
			perform pg_temp.base_public_send(v_binding, 'progress', 'progress-1');
			raise exception 'cancelled native authority replayed an earlier send';
		exception when insufficient_privilege then null;
		end;
		begin
			perform pg_temp.base_public_send(v_binding, 'final', 'cancelled-final');
			raise exception 'cancelled native authority delivered a new final send';
		exception when insufficient_privilege then null;
		end;
		if (select count(*) from public.qorpera_session_events where execution_id = (v_binding ->> 'runId')::uuid) <> 1 then
			raise exception 'cancellation mutated the already delivered conversation';
		end if;
		raise exception using errcode = 'QTP01';
	exception when sqlstate 'QTP01' then null;
	end;
end $$;
reset role;
select pg_temp.base_claims('service_role');

-- 9. The owner disconnects the login while Bob's run waits on it: its connection, versions and capsules are revoked, no
-- lease stays active, and the queued run fails.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.nl_revocation', public.qorpera_revoke_native_provider_connection(
	'92400000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
do $$
declare v_connection_id uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
begin
	if current_setting('qorpera_test.nl_revocation')::jsonb ->> 'status' <> 'revoked'
		or exists (select 1 from public.qorpera_provider_connection_versions as version
			where version.connection_id = v_connection_id and version.authorization_state <> 'revoked')
		or exists (select 1 from public.qorpera_native_credential_capsules as capsule
			join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = capsule.id
			where version.connection_id = v_connection_id and (capsule.status <> 'revoked' or capsule.revoked_at is null))
		or exists (select 1 from public.qorpera_native_provider_connection_leases as lease
			where lease.provider_connection_id = v_connection_id and lease.status = 'active') then
		raise exception 'the owner''s Disconnect did not fence every native execution authority';
	end if;
	if not exists (select 1 from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		where run.id = current_setting('qorpera_test.nl_queued')::uuid and job.status = 'failed') then
		raise exception 'the owner''s Disconnect did not fail the next queued run it would pay for';
	end if;
end $$;

-- 10. An agent's thread conversation (Carol's) takes its model and speed from the company's writers only: a contributor
-- changes both; a viewer may read the choice but change neither; an outsider can neither read nor change it; the choice
-- is unchanged after the refusals (580's and 584's role checks, on folder-v2).
create function pg_temp.nl_choice() returns text language sql as $$
	select coalesce((select format('%s/%s/%s/%s', choice.model_id, choice.service_tier, choice.version, choice.updated_by_user_id)
		from public.qorpera_session_models as choice where choice.session_id = current_setting('qorpera_test.nl_session')::uuid), 'none')
$$;
select set_config('qorpera_test.nl_session', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000032')), true) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
declare v_session uuid := current_setting('qorpera_test.nl_session')::uuid; v_version bigint; v_result jsonb;
begin
	v_version := (public.qorpera_get_session_model(v_session) ->> 'version')::bigint;
	v_result := public.qorpera_set_session_model(v_session, 'gpt-6-astra', v_version);
	if v_result ->> 'model_id' <> 'gpt-6-astra' then raise exception 'a contributor could not choose the model: %', v_result; end if;
	v_result := public.qorpera_set_session_service_tier(v_session, 'standard', v_version + 1);
	if (v_result ->> 'version')::bigint <> v_version + 2 then
		raise exception 'a contributor could not choose the speed: %', v_result; end if;
	perform set_config('qorpera_test.nl_version', (v_version + 2)::text, true);
end $$;
reset role;
select set_config('qorpera_test.nl_choice', pg_temp.nl_choice(), true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.nl_choice') = format('gpt-6-astra/standard/%s/%s',
	current_setting('qorpera_test.nl_version'), '92400000-0000-4000-8000-000000000002'),
	'the contributor''s choice is stored: ' || current_setting('qorpera_test.nl_choice'));
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_get_session_model(current_setting('qorpera_test.nl_session')::uuid) ->> 'model_id'
	= 'gpt-6-astra', 'a viewer reads the conversation''s model');
select pg_temp.base_error(format('select public.qorpera_set_session_model(%L, %L, %s)', current_setting('qorpera_test.nl_session'),
	'gpt-6-sol', current_setting('qorpera_test.nl_version')), '42501', 'Conversation model unavailable');
select pg_temp.base_error(format('select public.qorpera_set_session_service_tier(%L, %L, %s)', current_setting('qorpera_test.nl_session'),
	'fast', current_setting('qorpera_test.nl_version')), '42501', 'Conversation model unavailable');
reset role;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.base_error(format('select public.qorpera_get_session_model(%L)', current_setting('qorpera_test.nl_session')),
	'42501', 'Conversation model unavailable');
select pg_temp.base_error(format('select public.qorpera_set_session_model(%L, %L, %s)', current_setting('qorpera_test.nl_session'),
	'gpt-6-sol', current_setting('qorpera_test.nl_version')), '42501', 'Conversation model unavailable');
select pg_temp.base_error(format('select public.qorpera_set_session_service_tier(%L, %L, %s)', current_setting('qorpera_test.nl_session'),
	'fast', current_setting('qorpera_test.nl_version')), '42501', 'Conversation model unavailable');
reset role;
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.nl_choice() = current_setting('qorpera_test.nl_choice'),
	'the refusals changed the conversation''s choice: ' || pg_temp.nl_choice());

rollback;
