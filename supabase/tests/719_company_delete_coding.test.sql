-- @fixture 600_runtime_coding_member_machines.test.sql until "-- 1. The turn has ended"
-- 20260928249150: deleting a company archives its coding sessions, switches its coding executors off and
-- asks its coding machines to retire. The executor then removes each machine through the existing custody
-- (stop, sleep, delete, release), and once the last one is released the deletion finishes.
reset role;
select public.qorpera_request_company_deletion('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
do $$
declare v_machine uuid := pg_temp.vm();
begin
	perform pg_temp.wake_assert((pg_temp.machine(v_machine)).retire_requested_at is not null
		and pg_temp.listed(v_machine) ->> 'superseded' = 'true','The company''s coding machine is retiring');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_coding_sessions session
		join public.qorpera_runtime_workers worker on worker.id = session.worker_id
		where worker.profile_id = '30000000-0000-4000-8000-000000000010' and session.archived_at is null),
		'Every coding session of the company is archived');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_coding_executors executor
		join public.qorpera_company_environments environment on environment.id = executor.environment_id
		where environment.profile_id = '30000000-0000-4000-8000-000000000010' and executor.enabled),
		'The company''s coding executors are off');
end $$;

reset role;
do $$
declare v_result jsonb := public.qorpera_finish_company_deletion('30000000-0000-4000-8000-000000000010');
begin
	perform pg_temp.wake_assert(v_result ->> 'state' = 'waiting' and (v_result #>> '{holdings,machines}')::integer >= 1,
		'The deletion waits for the coding machine');
end $$;

-- The executor's housekeeping removes the machine as it does any superseded one.
select pg_temp.path_claims('service_role');
do $$
declare v_machine uuid := pg_temp.vm(); v_binding text := current_setting('qorpera_test.coding_binding');
begin
	perform pg_temp.wake_assert(pg_temp.listed(v_machine) ->> 'removeDue' = 'true','The idle retiring machine is due for removal');
	perform pg_temp.custody(v_machine,v_binding,'stop');
	perform public.qorpera_suspend_coding_machine(v_machine,'exec-test',v_binding,repeat('c',64));
	perform pg_temp.wake_assert(pg_temp.custody(v_machine,v_binding,'delete') ->> 'intent' = 'delete','Delete custody is granted');
	perform pg_temp.wake_assert(public.qorpera_release_coding_machine(v_machine,'exec-test',v_binding,repeat('c',64)) ->> 'state'
		= 'released','The deletion proof releases the machine');
end $$;

reset role;
do $$
declare v_result jsonb := public.qorpera_finish_company_deletion('30000000-0000-4000-8000-000000000010');
begin
	perform pg_temp.wake_assert(v_result ->> 'state' = 'purged'
		and not exists(select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010')
		and not exists(select 1 from public.qorpera_coding_machines where profile_id = '30000000-0000-4000-8000-000000000010'),
		'With the machine released the company is purged: ' || v_result::text);
end $$;

rollback;
