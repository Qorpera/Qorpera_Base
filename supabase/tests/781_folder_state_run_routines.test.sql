-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine"
-- Company state files, thin writers W4c (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5 "Plan (W4c)";
-- RUNTIME-COMPANY-FOLDER-C2.md §5): a run's routine files, as manage_routine saves them. Each change set is saved with
-- the automatic review's approval of the call, recorded for exactly that change set: a new routine, a pause, a resume,
-- a conclusion and a removal; an unchanged save over the platform's pause resumes the routine. A new routine and a
-- removal are not saved without the review. A dynamic routine's run cannot pause it, even with the review (SQL leaves
-- a fixed routine's own run to the runtime, which refuses it before the receipt). Runs are 708's routine runs, with
-- 647's native rows so the runtime's binding stands.

-- The native rows a hand-built run needs before the runtime can call a tool with it: the company's compute identity
-- and saved login (connection b3, version 1, a native subscription), the run's runner, accepted assignment, native
-- lease, sponsor reservation, model policy and budget row. Returns the binding the runtime sends.
create function pg_temp.native(p_actor jsonb) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_identity uuid := '64700000-0000-4000-8000-0000000000d1';
	v_capsule uuid := '64700000-0000-4000-8000-0000000000d2'; v_lease uuid := extensions.gen_random_uuid();
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	set local session_replication_role = replica;
	insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
	values (v_identity, v_run.profile_id, 'company', v_identity, 'Run fence fixture') on conflict (id) do nothing;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values (v_capsule, v_run.profile_id, v_identity, 'company', 'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64),
		v_run.created_by_user_id) on conflict (id) do nothing;
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
		consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id, max_native_concurrency, quota_policy, allow_autonomous)
	values (v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, 'native_subscription', 'codex-cli', 'subscription',
		'fixture', v_run.created_by_user_id, v_run.created_by_user_id, v_capsule, 8,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
		true)
	on conflict (connection_id, version) do nothing;
	-- 708's logins name a capsule of their own: the run's login holds this one.
	update public.qorpera_provider_connection_versions set credential_capsule_id = v_capsule
	where connection_id = v_sponsor.provider_connection_id and version = v_sponsor.provider_connection_version;
	-- The company login pays for unattended work too, so a wake run's sponsor test passes (and takes the connection).
	update public.qorpera_execution_sponsor_versions set allow_autonomous = true
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values ((p_actor ->> 'runnerId')::uuid, v_run.profile_id, (p_actor ->> 'runnerId')::uuid, 'Run fence runner', '["agent_turn"]',
		'active', repeat('e', 64), clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour',
		v_run.created_by_user_id, v_identity);
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values ((p_actor ->> 'assignmentId')::uuid, extensions.gen_random_uuid(), v_run.job_id, v_run.id, (p_actor ->> 'runnerId')::uuid,
		repeat('e', 64), 'accepted', clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run.id, v_run.job_id, v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, v_capsule,
		v_identity, (p_actor ->> 'runnerId')::uuid, (p_actor ->> 'assignmentId')::uuid, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run.id, v_run.job_id, v_run.profile_id, v_run.sponsor_binding_id, v_run.sponsor_version, v_sponsor.provider_connection_id,
		v_sponsor.provider_connection_version, date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_run.job_id, v_run.profile_id, v_run.environment_id, '["gpt-test"]', 32, 1000, 1000, v_run.created_by_user_id);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run.id);
	update public.qorpera_execution_runs set compute_identity_id = v_identity where id = v_run.id;
	set local session_replication_role = origin;
	return jsonb_build_object('leaseId', v_lease, 'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', p_actor ->> 'runnerId',
		'assignmentId', p_actor ->> 'assignmentId', 'credentialCapsuleId', v_capsule, 'computeIdentityId', v_identity,
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-test');
end $$;

-- The kernel's record of one manage_routine call (an allow by the automatic review): its id.
create function pg_temp.action(p_binding jsonb, p_call text) returns uuid language sql as $$
	select (public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'manage_routine',
		'effect', 'delegation', 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Set up or change a routine', 'target', 'Digest', 'details', '{}'::jsonb),
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid
$$;
-- A run's call, as the writer makes it: the approval of the call, recorded for its change set, then the commit.
create function pg_temp.call(p_actor jsonb, p_binding jsonb, p_call text, p_units jsonb) returns jsonb language plpgsql as $$
declare v_action uuid := pg_temp.action(p_binding, p_call); v_review jsonb;
begin
	v_review := public.qorpera_folder_record_review(p_binding, jsonb_build_object('actionReviewId', v_action, 'tool', 'manage_routine',
		'argumentSha256', md5(p_call) || md5(p_call), 'units', p_units));
	-- The run possesses the bytes it commits, as 707's commit helper makes it once the fixtures stage version-2 bytes
	-- (C5 early); before that its helpers have no possession step.
	if to_regprocedure('pg_temp.possess(uuid,jsonb,jsonb)') is not null then
		execute 'select pg_temp.possess($1, $2, $3)' using '70700000-0000-4000-8000-000000000020'::uuid, p_actor, p_units;
	end if;
	return public.qorpera_folder_commit('70700000-0000-4000-8000-000000000020', p_actor, 'run-' || p_call, p_units,
		(v_review ->> 'reviewId')::uuid);
end $$;
create function pg_temp.digest(p_extra jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.routine('agents/nora/routines/digest.md', pg_temp.rparse('78100000-0000-4000-8000-0000000000e3', 'Digest',
		pg_temp.every(60), p_extra))
$$;

do $$
declare a jsonb; b jsonb; x public.qorpera_cloud_routines;
	e2 constant uuid := '78100000-0000-4000-8000-0000000000e2'; e3 constant uuid := '78100000-0000-4000-8000-0000000000e3';
begin
	-- Nora's run, woken by a routine the owner made: it acts for the owner, on the owner's login.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-own', jsonb_build_array(pg_temp.routine('agents/nora/routines/own.md',
		pg_temp.rparse(e2, 'Own', pg_temp.every())))), 1, 'saved');
	a := pg_temp.routine_run(e2);
	b := pg_temp.native(a);
	-- 1. A new routine is delegation: not saved without the review, saved with it, on the requester's login.
	perform pg_temp.expect(pg_temp.commit(a, 'run-digest-none', jsonb_build_array(pg_temp.digest())), 1, 'denied', 'review_required');
	if pg_temp.rt(e3) is not null then raise exception 'An unreviewed routine is not saved'; end if;
	perform pg_temp.expect(pg_temp.call(a, b, 'digest-0001', jsonb_build_array(pg_temp.digest())), 1, 'saved');
	x := pg_temp.rt(e3);
	if x.status is distinct from 'active' or x.owner_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a1'
		or x.routine_key is distinct from 'digest' or (pg_temp.rv(e3)).created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or (pg_temp.rv(e3)).sponsor_binding_id is distinct from '70800000-0000-4000-8000-0000000000b1' then
		raise exception 'The run''s routine is Nora''s, on the requester''s login: %', to_jsonb(x); end if;
	-- 2. A pause in the file.
	perform pg_temp.expect(pg_temp.call(a, b, 'digest-0002', jsonb_build_array(pg_temp.digest('{"status":"paused"}'))), 1, 'saved');
	if (pg_temp.rt(e3)).status is distinct from 'paused' or (pg_temp.rt(e3)).pause_reason is distinct from 'agent' then
		raise exception 'The run pauses its routine: %', to_jsonb(pg_temp.rt(e3)); end if;
	-- 3. A resume.
	perform pg_temp.expect(pg_temp.call(a, b, 'digest-0003', jsonb_build_array(pg_temp.digest())), 1, 'saved');
	if (pg_temp.rt(e3)).status is distinct from 'active' or (pg_temp.rt(e3)).pause_reason is not null then
		raise exception 'The run resumes its routine: %', to_jsonb(pg_temp.rt(e3)); end if;
	-- 4. An unchanged save over the platform's pause resumes it (the resume rule, through the recorder).
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, pause_reason = %L, authorization_failures = 3 where id = %L',
		'paused', 'authorization_failed', e3));
	perform pg_temp.expect(pg_temp.call(a, b, 'digest-0004', jsonb_build_array(pg_temp.digest())), 1, 'saved');
	if (pg_temp.rt(e3)).status is distinct from 'active' or (pg_temp.rt(e3)).authorization_failures is distinct from 0 then
		raise exception 'An unchanged save by the run ends the suspension: %', to_jsonb(pg_temp.rt(e3)); end if;
	-- 5. A conclusion.
	perform pg_temp.expect(pg_temp.call(a, b, 'digest-0005', jsonb_build_array(pg_temp.digest(
		'{"status":"concluded","conclusion":"The digest is no longer needed."}'))), 1, 'saved');
	if (pg_temp.rt(e3)).status is distinct from 'concluded' then
		raise exception 'The run concludes its routine: %', to_jsonb(pg_temp.rt(e3)); end if;
	-- 6. A removal is a deletion: not saved without the review; with it the routine retires and its name is free.
	perform pg_temp.expect(pg_temp.commit(a, 'run-digest-del-none', jsonb_build_array(pg_temp.del('agents/nora/routines/digest.md'))),
		1, 'denied', 'review_required');
	perform pg_temp.expect(pg_temp.call(a, b, 'digest-0006', jsonb_build_array(pg_temp.del('agents/nora/routines/digest.md'))), 1, 'saved');
	if (pg_temp.rt(e3)).folder_retired_at is null or pg_temp.version('agents/nora/routines/digest.md') is not null then
		raise exception 'The run removes its routine: %', to_jsonb(pg_temp.rt(e3)); end if;
	perform pg_temp.expect(pg_temp.call(a, b, 'digest-0007', jsonb_build_array(pg_temp.routine('agents/nora/routines/digest.md',
		pg_temp.rparse('78100000-0000-4000-8000-0000000000e4', 'Digest again', pg_temp.every(60))))), 1, 'saved');
end $$;

-- 7. A dynamic routine's run cannot pause it, even with the review.
do $$
declare a jsonb; b jsonb; d jsonb;
	e2 constant uuid := '78100000-0000-4000-8000-0000000000e2'; e5 constant uuid := '78100000-0000-4000-8000-0000000000e5';
	p constant text := 'agents/nora/routines/follow-up.md';
begin
	a := pg_temp.routine_run(e2);
	b := pg_temp.native(a);
	perform pg_temp.expect(pg_temp.call(a, b, 'follow-0001', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(e5, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'))))), 1, 'saved');
	d := pg_temp.routine_run(e5);
	b := pg_temp.native(d);
	if not public.qorpera_routine_decision_pending((d ->> 'runId')::uuid) then raise exception 'The run owes its decision'; end if;
	if pg_temp.problem(pg_temp.call(d, b, 'own-0001', jsonb_build_array(pg_temp.routine(p,
			pg_temp.rparse(e5, 'Follow up', pg_temp.once('2030-01-01T09:00:00Z'), '{"status":"paused"}')))))
			is distinct from 'this run cannot pause its own routine; conclude it instead' then
		raise exception 'A dynamic routine''s run cannot pause it, even with the review'; end if;
end $$;

rollback;
