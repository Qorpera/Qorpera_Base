begin;

-- Real relational/transition fixtures; no provider calls or runner processes.
do $$
declare
	v_owner uuid := '28000000-0000-4000-8000-000000000001';
	v_member uuid := '28000000-0000-4000-8000-000000000002';
	v_profile uuid := '28000000-0000-4000-8000-000000000010';
	v_environment uuid := '28000000-0000-4000-8000-000000000020';
	v_workspace uuid := '28000000-0000-4000-8000-000000000030';
	v_snapshot uuid := '28000000-0000-4000-8000-000000000040';
	v_substrate uuid := '28000000-0000-4000-8000-000000000050';
	v_session uuid;
	v_staff uuid;
	v_job uuid;
	v_run uuid;
	v_provider uuid;
	v_sponsor uuid;
	v_index integer;
begin
	for v_index in 1..5 loop
		insert into auth.users (id, email) values (
			('28000000-0000-4000-8000-' || lpad(v_index::text, 12, '0'))::uuid,
			'run-control-' || v_index || '@example.test'
		);
	end loop;
	insert into public.qorpera_profiles (id, name, created_by_user_id)
	values (v_profile, 'Run control fixture', v_owner);
	for v_index in 1..4 loop
		insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
		values (v_profile, ('28000000-0000-4000-8000-' || lpad(v_index::text, 12, '0'))::uuid,
			'run-control-' || v_index || '@example.test', 'Member ' || v_index,
			(case when v_index = 1 then 'owner' when v_index = 4 then 'viewer' else 'contributor' end)::public.qorpera_profile_role);
	end loop;
	perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_environment, v_profile, 'Run control', 1, v_owner);
	insert into public.qorpera_company_workspaces (id, profile_id, environment_id, client_workspace_id, name, created_by_user_id)
	values (v_workspace, v_profile, v_environment, v_workspace, 'Run control', v_owner);
	insert into public.qorpera_company_snapshots (
		id, profile_id, environment_id, workspace_id, client_snapshot_id, tree_manifest_sha256,
		tree_manifest_bytes, tree_contract_version, file_count, total_bytes, created_by_user_id
	) values (v_snapshot, v_profile, v_environment, v_workspace, v_snapshot, repeat('a', 64), 2, 3, 0, 0, v_owner);
	insert into public.qorpera_company_substrate_versions (
		id, profile_id, environment_id, company_snapshot_id, client_version_id, contract_version,
		operation_sequence, operation_count, content_sha256, created_by_user_id
	) values (v_substrate, v_profile, v_environment, v_snapshot, v_substrate, 1, 0, 0, repeat('b', 64), v_owner);
	for v_index in 0..1 loop
		v_staff := ('28000000-0000-4000-8000-' || lpad((54 + v_index * 10)::text, 12, '0'))::uuid;
		v_session := ('28000000-0000-4000-8000-' || lpad((55 + v_index * 10)::text, 12, '0'))::uuid;
		insert into public.qorpera_profile_staff (
			profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
			employment_status, lifecycle_state, model_provider, model_id, created_at, updated_at, updated_by_user_id
		) values (v_profile, v_staff, 'Agent ' || v_index, 'Operations', 'Run fixture', 'blue', 'round',
			'active', 'active', 'openai', 'gpt-test', statement_timestamp(), statement_timestamp(), v_owner);
		insert into public.qorpera_shared_sessions (
			id, client_session_id, profile_id, environment_id, title, status, created_by_user_id,
			company_snapshot_id, staff_agent_id, staff_version, execution_scope
		) values (v_session, v_session, v_profile, v_environment, 'Session ' || v_index, 'open', v_owner,
			v_snapshot, v_staff, 1, '{}');
	end loop;
	v_provider := (public.qorpera_register_provider_connection(
		v_profile, '28000000-0000-4000-8000-000000000060', null, 'openai', 'api_key', 'openai-responses',
		'vault://company/provider/openai', 'acct_test', 'run-control-fixture', 'qorpera-provider-consent/v1', null,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}'
	) ->> 'connection_id')::uuid;
	v_sponsor := (public.qorpera_create_execution_sponsor_binding(
		v_profile, '28000000-0000-4000-8000-000000000061', 'company_api_billing', v_provider, 1, false
	) ->> 'binding_id')::uuid;
	insert into public.qorpera_member_compute_identities (id, profile_id, ownership_kind, client_identity_id, display_name)
	values ('28000000-0000-4000-8000-000000000906', v_profile, 'company',
		'28000000-0000-4000-8000-000000000906', 'Lease cleanup fixture');
	for v_index in 1..5 loop
		v_job := ('28000000-0000-4000-8000-' || lpad((70 + v_index)::text, 12, '0'))::uuid;
		v_run := ('28000000-0000-4000-8000-' || lpad((80 + v_index)::text, 12, '0'))::uuid;
		v_session := case when v_index = 5 then '28000000-0000-4000-8000-000000000065'::uuid
			else '28000000-0000-4000-8000-000000000055'::uuid end;
		v_staff := case when v_index = 5 then '28000000-0000-4000-8000-000000000064'::uuid
			else '28000000-0000-4000-8000-000000000054'::uuid end;
		insert into public.qorpera_runner_jobs (
			id, profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id, status, finished_at, result, created_at
		) values (v_job, v_profile, v_environment, v_session, v_substrate, v_job,
			'agent_turn', 'agent_turn', '{}', v_member,
			case when v_index = 1 then 'failed' when v_index = 4 then 'completed' else 'queued' end,
			case when v_index in (1, 4) then statement_timestamp() else null end,
			case when v_index = 4 then '{}'::jsonb else null end,
			statement_timestamp() - (10 - v_index) * interval '1 minute');
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id, substrate_version_id,
			company_snapshot_id, staff_agent_id, staff_version, input_ids, sponsor_binding_id, sponsor_version,
			required_capability, job_type, payload_sha256, transcript_start_sequence, created_by_user_id, compute_identity_id
		) values (v_run, v_profile, v_environment, 'session_turn', v_run, v_session, v_job, v_substrate,
			v_snapshot, v_staff, 1, array[v_run], v_sponsor, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_member,
			case when v_index = 5 then '28000000-0000-4000-8000-000000000906'::uuid else null end);
		update public.qorpera_runner_jobs set run_id = v_run where id = v_job;
	end loop;
end
$$;

create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin
	if value is distinct from true then raise exception '%', message; end if;
end
$$;

create function pg_temp.denied(session_id uuid, run_id uuid) returns void language plpgsql as $$
begin
	begin
		perform public.qorpera_cancel_session_run(session_id, run_id);
	exception when insufficient_privilege then return;
	end;
	raise exception 'unauthorized or rebound cancellation was accepted';
end
$$;

select pg_temp.assert_true(not has_function_privilege('anon', 'public.qorpera_cancel_session_run(uuid,uuid)', 'execute'), 'anonymous cancellation exposed');
select pg_temp.assert_true(not has_function_privilege('anon', 'public.qorpera_get_session_run_control(uuid)', 'execute'), 'anonymous run state exposed');
select pg_temp.assert_true(has_function_privilege('authenticated', 'public.qorpera_cancel_session_run(uuid,uuid)', 'execute'), 'member cancellation missing');

set role authenticated;
-- Older failed/completed runs do not mask current work. Only closed, public
-- control fields are returned, never job payloads, tokens or provider output.
select pg_temp.assert_true(
	public.qorpera_get_session_run_control('28000000-0000-4000-8000-000000000055') =
	'{"session_id":"28000000-0000-4000-8000-000000000055","staff_agent_id":"28000000-0000-4000-8000-000000000054","run":{"run_id":"28000000-0000-4000-8000-000000000082","status":"queued","can_cancel":true}}'::jsonb,
	'active run was masked or leaked extra state'
);

-- Neither another contributor nor a viewer may stop the sponsoring member's run.
select set_config('request.jwt.claims', '{"sub":"28000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select pg_temp.assert_true((public.qorpera_get_session_run_control('28000000-0000-4000-8000-000000000055') #>> '{run,can_cancel}')::boolean = false, 'coworker can stop another member');
select pg_temp.denied('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000082');
select set_config('request.jwt.claims', '{"sub":"28000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select pg_temp.denied('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000082');

-- An outsider cannot read the company's run state or cancel by remembered id.
select set_config('request.jwt.claims', '{"sub":"28000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select pg_temp.denied('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000082');
do $$
begin
	begin
		perform public.qorpera_get_session_run_control('28000000-0000-4000-8000-000000000055');
	exception when insufficient_privilege then return;
	end;
	raise exception 'outsider could read company run state';
end
$$;

-- Current membership is required, even for the creator, on both endpoints.
reset role;
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '28000000-0000-4000-8000-000000000010' and user_id = '28000000-0000-4000-8000-000000000002';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"28000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select pg_temp.denied('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000082');
do $$
begin
	begin
		perform public.qorpera_cancel_runner_job('28000000-0000-4000-8000-000000000072');
	exception when insufficient_privilege then return;
	end;
	raise exception 'downgraded creator bypassed session controls';
end
$$;
reset role;
delete from public.qorpera_profile_members
where profile_id = '28000000-0000-4000-8000-000000000010' and user_id = '28000000-0000-4000-8000-000000000002';
set role authenticated;
select pg_temp.denied('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000082');
do $$
begin
	begin
		perform public.qorpera_cancel_runner_job('28000000-0000-4000-8000-000000000072');
	exception when insufficient_privilege then return;
	end;
	raise exception 'removed creator bypassed session controls';
end
$$;
reset role;
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values ('28000000-0000-4000-8000-000000000010', '28000000-0000-4000-8000-000000000002', 'run-control-2@example.test', 'Member 2', 'contributor');
set role authenticated;

-- Exact-session binding is mandatory even when this member may control both.
select pg_temp.denied('28000000-0000-4000-8000-000000000065', '28000000-0000-4000-8000-000000000082');
select pg_temp.denied('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000085');

select pg_temp.assert_true(
	public.qorpera_cancel_session_run('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000082') =
	'{"session_id":"28000000-0000-4000-8000-000000000055","run_id":"28000000-0000-4000-8000-000000000082","status":"cancelled"}'::jsonb,
	'creator cancellation was not confirmed'
);
-- Lost receipt retry and late clicks never select the successor.
select public.qorpera_cancel_session_run('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000082');
select pg_temp.assert_true(public.qorpera_cancel_session_run('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000084') ->> 'status' = 'completed', 'late Stop changed a completed run');
select pg_temp.assert_true(public.qorpera_cancel_session_run('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000081') ->> 'status' = 'failed', 'late Stop changed a failed run');
select pg_temp.assert_true(public.qorpera_get_session_run_control('28000000-0000-4000-8000-000000000055') #>> '{run,run_id}' = '28000000-0000-4000-8000-000000000083', 'stale Stop cancelled a successor');

-- The owner can stop another member's exact run; an empty session is explicit.
select set_config('request.jwt.claims', '{"sub":"28000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.qorpera_cancel_session_run('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000083');
select pg_temp.assert_true(public.qorpera_get_session_run_control('28000000-0000-4000-8000-000000000055') -> 'run' = 'null'::jsonb, 'idle session retained a run');

reset role;
select pg_temp.assert_true((select count(*) = 1 from public.qorpera_runner_audit_receipts where job_id = '28000000-0000-4000-8000-000000000072' and event_type = 'job_cancelled'), 'retry duplicated cancellation effects');
select pg_temp.assert_true((select status = 'cancelled' and cancelled_at is not null and finished_at is null and cancelled_by_user_id = '28000000-0000-4000-8000-000000000002' and lease_token_sha256 is null and attempt_count = 0 from public.qorpera_runner_jobs where id = '28000000-0000-4000-8000-000000000072'), 'cancellation failed actor/terminal/lease contract');
select pg_temp.assert_true((select status = 'queued' from public.qorpera_runner_jobs where id = '28000000-0000-4000-8000-000000000075'), 'another session was affected');
select pg_temp.assert_true((select count(*) = 0 from public.qorpera_session_events where session_id in ('28000000-0000-4000-8000-000000000055', '28000000-0000-4000-8000-000000000065')), 'Stop manufactured public assistant output');

-- A leased run takes the same exact-run path and loses its execution token.
-- FK-complete lease metadata; the actual native model path is verified by the
-- separate live acceptance. This fixture contains no credentials or inference.
do $$
declare
	v_owner uuid := '28000000-0000-4000-8000-000000000001';
	v_profile uuid := '28000000-0000-4000-8000-000000000010';
	v_job uuid := '28000000-0000-4000-8000-000000000075';
	v_run uuid := '28000000-0000-4000-8000-000000000085';
	v_orchestrator uuid := '28000000-0000-4000-8000-000000000901';
	v_runner uuid := '28000000-0000-4000-8000-000000000902';
	v_claim uuid := '28000000-0000-4000-8000-000000000903';
	v_assignment uuid := '28000000-0000-4000-8000-000000000904';
	v_capsule uuid := '28000000-0000-4000-8000-000000000905';
	v_identity uuid := '28000000-0000-4000-8000-000000000906';
	v_provider uuid;
begin
	select sponsor.provider_connection_id into strict v_provider
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_execution_runs as run on run.sponsor_binding_id = sponsor.binding_id and run.sponsor_version = sponsor.version
	where run.id = v_run;
	insert into public.qorpera_native_credential_capsules (
		id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id
	) values (v_capsule, v_profile, v_identity, 'company', 'openai', 'codex-cli',
		'fixture://not-a-credential', repeat('e', 64), v_owner);
	insert into public.qorpera_runner_orchestrators (id, display_name, provider_adapter, control_token_sha256, control_token_expires_at)
	values (v_orchestrator, 'Lease cleanup fixture', 'managed', repeat('e', 64), statement_timestamp() + interval '1 hour');
	insert into public.qorpera_runners (
		id, profile_id, client_runner_id, display_name, capabilities, status,
		activation_token_sha256, activation_expires_at, activated_at, session_token_sha256,
		session_expires_at, registered_by_user_id, compute_identity_id
	) values (v_runner, v_profile, v_runner, 'Lease cleanup fixture', '["agent_turn"]', 'active',
		repeat('e', 64), statement_timestamp() + interval '1 hour', statement_timestamp(), repeat('f', 64),
		statement_timestamp() + interval '1 hour', v_owner, v_identity);
	update public.qorpera_runners runner set runner_kind='qorpera_computer',
		worker_class=run.worker_class,template_key=identity.template_key,template_version=identity.template_version,
		compute_policy_sha256=public.qorpera_compute_policy_sha256(identity.policy)
	from public.qorpera_execution_runs run,public.qorpera_member_compute_identities identity
	where runner.id=v_runner and run.id=v_run and identity.id=v_identity;
	insert into public.qorpera_runner_job_claims (id, orchestrator_id, client_claim_id, job_id, run_id, status, lease_expires_at)
	values (v_claim, v_orchestrator, v_claim, v_job, v_run, 'accepted', statement_timestamp() + interval '2 minutes');
	insert into public.qorpera_runner_assignments (id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values (v_assignment, v_claim, v_job, v_run, v_runner, repeat('e', 64), 'accepted', statement_timestamp() + interval '2 minutes', statement_timestamp());
	update public.qorpera_runner_jobs set runner_id = v_runner, client_lease_id = v_assignment where id = v_job;
	insert into public.qorpera_native_provider_connection_leases (
		id, run_id, job_id, provider_connection_id, provider_connection_version, credential_capsule_id,
		compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at
	) values ('28000000-0000-4000-8000-000000000907', v_run, v_job, v_provider, 1, v_capsule,
		v_identity, v_runner, v_assignment, repeat('d', 64), statement_timestamp() + interval '2 minutes');
end
$$;
update public.qorpera_runner_jobs set status = 'leased', attempt_count = 1,
	lease_token_sha256 = repeat('d', 64), lease_expires_at = statement_timestamp() + interval '2 minutes'
where id = '28000000-0000-4000-8000-000000000075';
savepoint native_terminal_transition;
-- Recovery epochs fence existing leases and runner credentials even when the
-- caller knows their original tokens. Only the fixture generation is advanced.
update public.qorpera_member_compute_identities set recovery_epoch=1
where id='28000000-0000-4000-8000-000000000906';
select pg_temp.assert_true(not (select public.qorpera_execution_compute_available(run)
  from public.qorpera_execution_runs run where id='28000000-0000-4000-8000-000000000085'),'Old run survived generation change');
do $$
begin
  begin
    update public.qorpera_native_provider_connection_leases set expires_at=clock_timestamp()+interval '3 minutes'
    where id='28000000-0000-4000-8000-000000000907';
    raise exception 'Old native lease renewed after recovery';
  exception when insufficient_privilege then
    if sqlerrm <> 'native lease generation is fenced for recovery' then raise; end if;
  end;
  begin
    update public.qorpera_runners set session_expires_at=clock_timestamp()+interval '1 hour'
    where id='28000000-0000-4000-8000-000000000902';
    raise exception 'Old runner renewed after recovery';
  exception when insufficient_privilege then
    if sqlerrm <> 'runner identity is fenced for recovery' then raise; end if;
  end;
end
$$;
rollback to savepoint native_terminal_transition;
set role authenticated;
select pg_temp.assert_true(public.qorpera_get_session_run_control('28000000-0000-4000-8000-000000000065') #>> '{run,status}' = 'leased', 'leased run not projected');
select public.qorpera_cancel_session_run('28000000-0000-4000-8000-000000000065', '28000000-0000-4000-8000-000000000085');
reset role;
select pg_temp.assert_true((select status = 'cancelled' and lease_token_sha256 is null and lease_expires_at is null and terminal_lease_token_sha256 = repeat('d', 64) and attempt_count = 1 from public.qorpera_runner_jobs where id = '28000000-0000-4000-8000-000000000075'), 'leased cancellation retained execution authority or reran work');
select pg_temp.assert_true((select status = 'revoked' and released_at is not null from public.qorpera_native_provider_connection_leases where id = '28000000-0000-4000-8000-000000000907'), 'cancelled job kept the native connection occupied');
select pg_temp.assert_true((select status = 'active' from public.qorpera_native_credential_capsules where id = '28000000-0000-4000-8000-000000000905'), 'cancellation revoked the saved connection instead of its run lease');
select pg_temp.assert_true(not has_function_privilege('authenticated', 'public.qorpera_terminalize_native_provider_lease()', 'execute'), 'internal native cleanup exposed to clients');

-- Completion and failure close the same run-scoped lease without touching the
-- saved connection. Roll back only the fixture transition between cases.
rollback to savepoint native_terminal_transition;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.assert_true(public.qorpera_reserve_execution_sponsor_authority('28000000-0000-4000-8000-000000000085'), 'completion fixture sponsor unavailable');
-- The current human-wake protocol requires acknowledgement before final
-- delivery, including when the fixture is only testing terminal lease cleanup.
select public.qorpera_send_runner_agent_message(
	'28000000-0000-4000-8000-000000000902', repeat('f', 64),
	'28000000-0000-4000-8000-000000000075', repeat('d', 64),
	'28000000-0000-4000-8000-000000000904', 'native-cleanup-ack', 'Checking the fixture.', 'progress'
);
select public.qorpera_send_runner_agent_message(
	'28000000-0000-4000-8000-000000000902', repeat('f', 64),
	'28000000-0000-4000-8000-000000000075', repeat('d', 64),
	'28000000-0000-4000-8000-000000000904', 'native-cleanup-final', 'Fixture complete.', 'final'
);
update public.qorpera_runner_jobs set status = 'completed', result = '{}',
	finished_at = statement_timestamp(), lease_token_sha256 = null, lease_expires_at = null
where id = '28000000-0000-4000-8000-000000000075';
select pg_temp.assert_true((select status = 'released' and released_at is not null from public.qorpera_native_provider_connection_leases where id = '28000000-0000-4000-8000-000000000907'), 'completed job kept the native connection occupied');
rollback to savepoint native_terminal_transition;
update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture failure',
	finished_at = statement_timestamp(), lease_token_sha256 = null, lease_expires_at = null
where id = '28000000-0000-4000-8000-000000000075';
select pg_temp.assert_true((select status = 'revoked' and released_at is not null from public.qorpera_native_provider_connection_leases where id = '28000000-0000-4000-8000-000000000907'), 'failed job kept the native connection occupied');
select pg_temp.assert_true((select status = 'active' from public.qorpera_native_credential_capsules where id = '28000000-0000-4000-8000-000000000905'), 'terminal cleanup revoked the saved connection');

rollback;
