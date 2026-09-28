-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 20260928060000: a command still running in a Company Computer shell keeps
-- the computer on. The office reports the screens whose shells are busy; a
-- report is demand for 90 seconds, for the office's current generation only,
-- and a screen missing from the next report has nothing running. Only the
-- office's service role may report, and only screens of that office.

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.office',public.qorpera_register_runtime_office(
	'30000000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)::text,true);
select set_config('qorpera_test.office_scope',(current_setting('qorpera_test.office')::jsonb-'state')::text,true);
reset role;
create function pg_temp.office_call(p_action text,p_lease jsonb default null)
returns jsonb language sql as $$
	select public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,p_action,p_lease)
$$;
-- Synthetic guest readiness only. This is not a provider or Linux test.
update public.qorpera_runtime_offices set state='active'
where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid;
-- The agent's screen: acquired, then let go, as a run that ended.
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb);
reset role;
select set_config('qorpera_test.screen',current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}',true);

create function pg_temp.office() returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid
$$;
create function pg_temp.demand() returns boolean language sql as $$
	select public.qorpera_runtime_office_has_demand(pg_temp.office())
$$;
select set_config('qorpera_test.generation',(pg_temp.office()).generation::text,true);
-- As the office reports: its scope, generation and busy screens, nothing read from the table.
create function pg_temp.report(p_screens uuid[],p_generation bigint default null) returns jsonb language sql as $$
	select public.qorpera_report_runtime_office_shell_activity(current_setting('qorpera_test.office_scope')::jsonb,
		coalesce(p_generation,current_setting('qorpera_test.generation')::bigint),p_screens)
$$;
create function pg_temp.busy() returns uuid[] language sql as $$
	select array[current_setting('qorpera_test.screen')::uuid]
$$;

-- The wake fixture leaves one of the company's turns waiting for an agent with
-- computer access, which is demand of its own. Without that access, this test
-- starts from an office with nothing to do.
update public.qorpera_runtime_office_access set state='revoked' where office_id=(pg_temp.office()).id;
select pg_temp.wake_assert(not pg_temp.demand(),'an active office with nothing to do has no demand');

-- Members and agents cannot report; only the office's service role.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error('select pg_temp.report(pg_temp.busy())','42501');
reset role;

select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.report(pg_temp.busy())->'screens'=to_jsonb(pg_temp.busy()),'a busy shell is reported');
select pg_temp.wake_error(format('select pg_temp.report(pg_temp.busy(),%s)',current_setting('qorpera_test.generation')::bigint+1),
	'42501','Office shell activity binding differs');
select pg_temp.wake_error('select pg_temp.report(array[''30000000-0000-4000-8000-000000000099''::uuid])','42501',
	'Office shell activity screen differs');
select pg_temp.wake_error('select pg_temp.report(null)','22023');
select pg_temp.wake_error('select pg_temp.report(array[null::uuid])','22023');
select pg_temp.wake_error('select pg_temp.report(array(select (pg_temp.busy())[1] from generate_series(1,65)))','22023');
reset role;
select pg_temp.wake_assert(pg_temp.demand(),'a fresh report keeps the computer on');
select pg_temp.wake_assert((select busy_until between clock_timestamp()+interval '80 seconds' and clock_timestamp()+interval '100 seconds'
	from public.qorpera_runtime_office_shell_activity where screen_id=current_setting('qorpera_test.screen')::uuid),
	'a report is fresh for 90 seconds');

-- A report that stopped coming, or one from an older generation, is no demand.
update public.qorpera_runtime_office_shell_activity set busy_until=clock_timestamp()-interval '1 second'
where office_id=(pg_temp.office()).id;
select pg_temp.wake_assert(not pg_temp.demand(),'a stale report is no demand');
update public.qorpera_runtime_office_shell_activity set busy_until=clock_timestamp()+interval '60 seconds',
	computer_generation=computer_generation-1 where office_id=(pg_temp.office()).id;
select pg_temp.wake_assert(not pg_temp.demand(),'a report from an older generation is no demand');

-- A new report refreshes it; a screen missing from the next one has nothing running.
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.report(pg_temp.busy());
reset role;
select pg_temp.wake_assert(pg_temp.demand(),'a new report counts again');
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.report('{}')->'screens'='[]'::jsonb,'nothing running is reported');
reset role;
select pg_temp.wake_assert(not pg_temp.demand(),'nothing running is no demand');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_shell_activity),'the report rows are gone');

rollback;
