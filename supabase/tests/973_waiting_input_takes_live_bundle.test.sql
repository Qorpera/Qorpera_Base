-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Work that waited across a release runs on the release that runs it (20260930581000). Found live on 5 Nov 2026: a
-- Co-Founder's first run waited at a usage limit while v206 replaced v205, and its run, pinned to 205 by its kickoff
-- input, was refused by the node (NATIVE_BUNDLE_COMPATIBILITY). Here the owner's login A is at its limit when Dana is
-- hired: her kickoff waits under the active bundle X. (a) A run of it made under X fails that way after a release to Y:
-- it is tried again once, on the same payer, and its next run is pinned to Y. (b) Still waiting when Y is activated,
-- the kickoff's run is made under Y. An input's bundle stays immutable otherwise.

create function pg_temp.p973_input() returns uuid language sql as $$
	select input_id from public.qorpera_agent_first_runs
	where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '92400000-0000-4000-8000-000000000034'
$$;
create function pg_temp.p973_reading(p_used numeric) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
	values ((current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid, 2,
		jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
		'windows', jsonb_build_array(jsonb_build_object('id','primary','label','Week','usedPercent',p_used,
			'resetAt',to_char((statement_timestamp() + interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;
-- The next bundle, activated as a release would.
create function pg_temp.p973_release() returns text language plpgsql as $$
declare v_sha text;
begin
	with bundle as (
		insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
		select b.bundle_key, (select max(v.version) + 1 from public.qorpera_runtime_bundles v where v.bundle_key = b.bundle_key),
			m.manifest, encode(extensions.digest(convert_to(m.manifest::text, 'utf8'), 'sha256'), 'hex')
		from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id
		cross join lateral (select b.manifest || '{"fixtureRelease973":true}'::jsonb as manifest) m
		where a.singleton
		returning id, sha256)
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = bundle.id, runtime_bundle_sha256 = bundle.sha256
	from bundle where singleton returning bundle.sha256 into v_sha;
	return v_sha;
end $$;

-- The checks start here.
-- A is at its limit; Dana's kickoff waits under X.
select pg_temp.p973_reading(100);
select pg_temp.base_commit(pg_temp.base_owner(), 'p973-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
select pg_temp.base_materialize() \g /dev/null
select set_config('qorpera_test.p973_x', (select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle where singleton), true);
select pg_temp.base_assert((select runtime_bundle_sha256 = current_setting('qorpera_test.p973_x') and execution_run_id is null
	from public.qorpera_session_inputs where id = pg_temp.p973_input()), 'the kickoff does not wait under X');

-- (a) A has room; the kickoff's run is made under X; it fails as the node refuses it after the release to Y.
savepoint refused;
select pg_temp.p973_reading(30);
select set_config('qorpera_test.p973_run', (pg_temp.base_materialize() -> 'run_ids' ->> 0), true);
select pg_temp.base_assert((select runtime_bundle_sha256 = current_setting('qorpera_test.p973_x')
	from public.qorpera_execution_runs where id = current_setting('qorpera_test.p973_run')::uuid), 'the run is not under X');
update public.qorpera_runner_jobs set status = 'failed', finished_at = statement_timestamp(),
	last_error = 'Native provider bridge request failed (422) [code=NATIVE_BUNDLE_COMPATIBILITY:UNKNOWN]'
	where run_id = current_setting('qorpera_test.p973_run')::uuid;
update public.qorpera_session_inputs set failed_at = statement_timestamp(), failure_reason = 'Native provider bridge request failed'
	where id = pg_temp.p973_input();
insert into public.qorpera_execution_run_events(run_id, event_type, payload)
values (current_setting('qorpera_test.p973_run')::uuid, 'failed',
	'{"error":"Native provider bridge request failed (422) [code=NATIVE_BUNDLE_COMPATIBILITY:UNKNOWN]","attempt_count":1}');
-- Under X itself it is not retried: X is still the active bundle.
select pg_temp.base_assert(public.qorpera_retry_runs_refused_for_retired_bundle() = 0, 'a refusal under the active bundle was retried');
select set_config('qorpera_test.p973_y', pg_temp.p973_release(), true);
select pg_temp.base_assert(public.qorpera_retry_runs_refused_for_retired_bundle() = 1, 'the refused run was not tried again');
select pg_temp.base_assert(public.qorpera_retry_runs_refused_for_retired_bundle() = 0, 'the refused run was tried again twice');
do $$
declare v_retry public.qorpera_session_turn_requests%rowtype; v_input public.qorpera_session_inputs%rowtype;
	v_pass jsonb; v_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_retry from public.qorpera_session_turn_requests where input_id = pg_temp.p973_input() and status = 'queued';
	perform pg_temp.base_assert(v_retry.retry_of_request_id is not null
		and v_retry.sponsor_binding_id = (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid,
		'the retry is not a follow-up request on the same payer: ' || to_jsonb(v_retry)::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_execution_run_events
		where run_id = current_setting('qorpera_test.p973_run')::uuid and event_type = 'recovery_released'
			and payload ->> 'reason' = 'runtime_bundle_retired'), 'the refused run is not released');
	v_pass := pg_temp.base_materialize();
	select * into strict v_input from public.qorpera_session_inputs where id = pg_temp.p973_input();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1
		and v_input.runtime_bundle_sha256 = current_setting('qorpera_test.p973_y'), 'the retry is not pinned to Y: ' || v_pass::text);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.runtime_bundle_sha256 = current_setting('qorpera_test.p973_y')
		and v_input.execution_run_id = v_run.id, 'the retry''s run is not under Y');
end $$;
rollback to savepoint refused;

-- (b) Still waiting when Y is activated: the kickoff's run is made under Y.
select set_config('qorpera_test.p973_y', pg_temp.p973_release(), true);
select pg_temp.p973_reading(30);
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run public.qorpera_execution_runs%rowtype;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'the kickoff did not go on: ' || v_pass::text);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.runtime_bundle_sha256 = current_setting('qorpera_test.p973_y')
		and (select runtime_bundle_sha256 from public.qorpera_session_inputs where id = pg_temp.p973_input())
			= current_setting('qorpera_test.p973_y'), 'the waiting kickoff''s run is not under Y');
end $$;

-- An input's bundle stays immutable otherwise: outside the re-pin, and within it to any bundle but the active one.
select pg_temp.base_error(format($sql$update public.qorpera_session_inputs set runtime_bundle_sha256 = %L where id = %L$sql$,
	current_setting('qorpera_test.p973_x'), pg_temp.p973_input()), '42501', 'Session input provenance is immutable');
select pg_temp.base_error(format($sql$update public.qorpera_session_inputs set runtime_bundle_sha256 = %L
	where id = %L and set_config('qorpera.input_bundle_repin','on',true) = 'on'$sql$,
	current_setting('qorpera_test.p973_x'), pg_temp.p973_input()), '42501', 'Session input provenance is immutable');

-- The new helpers are the database's own.
select pg_temp.base_assert(not has_function_privilege('authenticated','public.qorpera_repin_waiting_inputs(uuid)','execute')
	and not has_function_privilege('service_role','public.qorpera_repin_waiting_inputs(uuid)','execute')
	and not has_function_privilege('authenticated','public.qorpera_retry_runs_refused_for_retired_bundle()','execute')
	and not has_function_privilege('service_role','public.qorpera_retry_runs_refused_for_retired_bundle()','execute'),
	'API clients can call the re-pin helpers');

rollback;
