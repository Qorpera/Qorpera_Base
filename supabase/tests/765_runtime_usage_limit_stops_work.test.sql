-- @fixture 300_runtime_wake_bus.test.sql until "create function pg_temp.path_plan"
-- A usage limit stops the work (20260929840000, founder decision 2026-10-01). The fixture's run is leased on
-- the member's login A; the same member also has login B with room left, which the old sponsor handoff would
-- have moved the run to (test 583 shows the handoff would choose it). Now the runner's failure report fails
-- the run: it stays on A, keeps its binding version, gets no handoff event, and is not queued again.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
do $$
declare login jsonb; connection jsonb; sponsor jsonb;
begin
	login := public.qorpera_begin_native_provider_login('30000000-0000-4000-8000-000000000010',
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),
		(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,
		'openai','codex-cli',repeat('c',64),900);
	perform pg_temp.path_claims('service_role');
	connection := public.qorpera_complete_native_provider_login((login ->> 'login_id')::uuid,repeat('c',64),
		extensions.gen_random_uuid(),'object://usage-limit-stop/account-b',repeat('d',64),'account-b','personal-subscription',
		'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	sponsor := public.qorpera_create_member_execution_sponsor('30000000-0000-4000-8000-000000000010',
		extensions.gen_random_uuid(),(connection ->> 'connection_id')::uuid,1,false);
	perform set_config('qorpera_test.stop765_connection',connection::text,true);
end $$;
-- B has room left.
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values ((current_setting('qorpera_test.stop765_connection')::jsonb ->> 'connection_id')::uuid,1,
	jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',jsonb_build_array(
		jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));

-- The failure report no longer asks the handoff.
do $$
begin
	if position('qorpera_handoff_run_sponsor(' in
		pg_get_functiondef('public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)'::regprocedure)) > 0 then
		raise exception 'The runner failure report still hands runs off'; end if;
end $$;

-- A reaches its usage limit during the run, and the runner reports the run failed.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_record_provider_usage_signal(current_setting('qorpera_test.wake_binding')::jsonb,'usage_limit');
select public.qorpera_fail_runner_job((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runnerId')::uuid,
	repeat('2',64),(current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid,repeat('3',64),
	'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]',false);
reset role;
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid;
	if v_job.status <> 'failed' then
		raise exception 'A run at its usage limit was not stopped: job %', v_job.status; end if;
	if v_run.sponsor_version <> 1 or exists (select 1 from public.qorpera_execution_sponsor_versions version
		where version.binding_id = v_run.sponsor_binding_id and version.version > 1) then
		raise exception 'A run at its usage limit moved to another login'; end if;
	if exists (select 1 from public.qorpera_execution_run_events where run_id = v_run.id and event_type = 'sponsor_handoff')
		or exists (select 1 from public.qorpera_execution_sponsor_handoffs where run_id = v_run.id) then
		raise exception 'A run at its usage limit was handed off'; end if;
	-- The member is still told about the limit, for this run.
	if not exists (select 1 from public.qorpera_member_notifications
		where kind = 'provider_usage_limit' and user_id = '30000000-0000-4000-8000-000000000001'
			and subject ->> 'runId' = v_run.id::text) then
		raise exception 'The member was not told about the usage limit'; end if;
end $$;

-- The thread learns why the work stopped: the run's recovery read says the usage limit was reached, which the
-- bridge's saved refusal cannot tell from a full context window.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
begin
	if (public.qorpera_get_execution_run_recovery((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid)
		->> 'usage_limit')::boolean is not true then
		raise exception 'The recovery read does not say the usage limit stopped the run'; end if;
end $$;
reset role;
-- A signal on another sponsor version of the run says nothing about how it ended: a run an earlier handoff
-- moved to another login keeps its first login's signal. (Foreign keys are skipped for this one row move;
-- the transaction rolls back.)
set local session_replication_role = replica;
update public.qorpera_provider_connection_usage_signals set sponsor_version = sponsor_version + 1
where run_id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
set local session_replication_role = origin;
set local role authenticated;
do $$
begin
	if (public.qorpera_get_execution_run_recovery((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid)
		->> 'usage_limit')::boolean is not false then
		raise exception 'The recovery read names a usage limit from another login of the run'; end if;
end $$;
reset role;
-- Without a usage-limit signal the read says false.
delete from public.qorpera_provider_connection_usage_signals
where run_id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
set local role authenticated;
do $$
begin
	if (public.qorpera_get_execution_run_recovery((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid)
		->> 'usage_limit')::boolean is not false then
		raise exception 'The recovery read names a usage limit the run never reached'; end if;
end $$;
reset role;
set constraints all immediate;
rollback;
