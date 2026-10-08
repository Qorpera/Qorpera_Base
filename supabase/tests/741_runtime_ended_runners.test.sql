-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260928259220, on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): providers ask which waiting
-- runners belong to a job that ended at least two minutes ago, and retire those guests. The fixture's runner holds the
-- lease of Alice's run (a post in her thread, materialized, claimed and leased through the real contracts); its machine
-- allocation stands in for the provider's reservation.
reset role;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
select '74100000-0000-4000-8000-000000000720', '92400000-0000-4000-8000-000000000010',
	(binding ->> 'runId')::uuid, (binding ->> 'runnerId')::uuid, 'lxd', repeat('7', 64)
from (select current_setting('qorpera_test.base_binding')::jsonb as binding) as fixture;

create function pg_temp.er_ended(p_runner_ids uuid[]) returns jsonb language sql as $$
	select public.qorpera_runtime_ended_runners(p_runner_ids)
$$;
create function pg_temp.er_runner() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_binding')::jsonb ->> 'runnerId')::uuid
$$;

do $$
begin
	if has_function_privilege('anon', 'public.qorpera_runtime_ended_runners(uuid[])', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_runtime_ended_runners(uuid[])', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_runtime_ended_runners(uuid[])', 'EXECUTE') then
		raise exception 'ended runners are not service-only';
	end if;
	-- A leased job goes on; an unknown runner is never reported.
	perform pg_temp.base_assert((select status from public.qorpera_runner_jobs
		where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid) = 'leased', 'The fixture job is leased');
	perform pg_temp.base_assert(pg_temp.er_ended(array[pg_temp.er_runner(), '74100000-0000-4000-8000-000000000799'::uuid])
		= '[]'::jsonb, 'A runner whose job goes on is not ended');
	begin
		perform pg_temp.er_ended(array(select extensions.gen_random_uuid() from generate_series(1, 513)));
		raise exception 'An oversized query was answered';
	exception when invalid_parameter_value then null;
	end;
	begin
		perform pg_temp.er_ended(null);
		raise exception 'A null query was answered';
	exception when invalid_parameter_value then null;
	end;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	begin
		perform pg_temp.er_ended(array[pg_temp.er_runner()]);
		raise exception 'A member asked about runners';
	exception when insufficient_privilege then null;
	end;
	perform pg_temp.base_claims('service_role');
end
$$;

-- A member's Stop cancels the job: reported two minutes after its cancellation.
savepoint cancelled;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid,
	'cancelled', 'Stopped by the member', false) \g /dev/null
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.er_ended(array[pg_temp.er_runner()]) = '[]'::jsonb, 'A job just cancelled waits two minutes');
update public.qorpera_runner_jobs set cancelled_at = statement_timestamp() - interval '3 minutes'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
select pg_temp.base_assert(pg_temp.er_ended(array[pg_temp.er_runner()]) = jsonb_build_array(pg_temp.er_runner()),
	'A runner whose job was cancelled two minutes ago is reported');
rollback to cancelled;

-- The job ends: not yet reported within two minutes, then reported.
select public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid,
	'failed', 'Company deleted', false) \g /dev/null
select pg_temp.base_assert(pg_temp.er_ended(array[pg_temp.er_runner()]) = '[]'::jsonb, 'A job that just ended waits two minutes');
update public.qorpera_runner_jobs set finished_at = statement_timestamp() - interval '3 minutes'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
select pg_temp.base_assert(pg_temp.er_ended(array[pg_temp.er_runner()]) = jsonb_build_array(pg_temp.er_runner()),
	'A runner whose job ended two minutes ago is reported');

rollback;
