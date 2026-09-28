-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 20260929070000: a command still running in a Company Computer shell keeps
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
reset role;
-- 20260929070200 through the real operation check, while the agent holds its
-- screen: every shell action the tool sends is authorized, a wrong one refused.
create function pg_temp.shell_authorize(p_arguments jsonb) returns jsonb language sql as $$
	select public.qorpera_native_office_operation(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,
		jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
			'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
				-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
			'operation',jsonb_build_object('tool','computer_shell','toolVersion','qorpera.company-computer-tools/v2',
				'logicalOperationKey','shell-'||coalesce(p_arguments->>'action','legacy'),'requiresCompanyRevision',false,'arguments',p_arguments,
				'target',jsonb_build_object('realm','company_computer','binding',current_setting('qorpera_test.office_lease')::jsonb->'binding',
					'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'resources')))::text,
		'authorize')
$$;
select pg_temp.path_claims('service_role');
set local role service_role;
-- A run works only after acknowledging its wake.
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select pg_temp.wake_assert(pg_temp.shell_authorize(arguments)='{"state":"authorized"}'::jsonb,'authorized: '||arguments::text)
from unnest(array[
	'{"kind":"shell","action":"start","command":"npm run build","waitMs":10000}',
	'{"kind":"shell","action":"read","sessionId":"00000000-0000-4000-8000-0000000000a1","waitMs":5000}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"y\n","endInput":true,"waitMs":1000}',
	'{"kind":"shell","action":"stop"}',
	'{"kind":"shell","action":"list"}',
	'{"kind":"shell","command":"ls","timeoutMs":1000}']::jsonb[]) as arguments;
select pg_temp.wake_error($q$select pg_temp.shell_authorize('{"kind":"shell","action":"start","command":"ls","waitMs":20000}')$q$,
	'22023','Invalid office shell operation');
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
select pg_temp.wake_assert(pg_temp.report(pg_temp.busy())@>jsonb_build_object('screens',to_jsonb(pg_temp.busy()),'paused',false),
	'a busy shell is reported');
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

-- 20260929070100: a running command also keeps the agent's seat.
create function pg_temp.seat() returns boolean language sql as $$
	select public.qorpera_runtime_office_screen_in_use(s) from public.qorpera_runtime_office_screens s
	where s.id=current_setting('qorpera_test.screen')::uuid
$$;
update public.qorpera_runtime_office_screens set touched_at=clock_timestamp()-interval '3 minutes'
where id=current_setting('qorpera_test.screen')::uuid;
select pg_temp.wake_assert(not pg_temp.seat(),'an idle screen is free');
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.report(pg_temp.busy());
reset role;
select pg_temp.wake_assert(pg_temp.seat(),'a running command keeps the seat');
update public.qorpera_runtime_office_shell_activity set busy_until=clock_timestamp()-interval '1 second';
select pg_temp.wake_assert(not pg_temp.seat(),'a stale report keeps no seat');

-- 20260929070200: the office's operation check takes every shell action the
-- tool sends, and the 15-second form of older bundles, and nothing else.
create function pg_temp.shell_ok(p_arguments text) returns boolean language sql as $$
	select public.qorpera_valid_office_shell_action(p_arguments::jsonb)
$$;
select pg_temp.wake_assert(pg_temp.shell_ok('{"kind":"shell","action":"start","command":"npm run build","waitMs":10000}')
	and pg_temp.shell_ok('{"kind":"shell","action":"start","command":"sleep 3600","waitMs":0}')
	and pg_temp.shell_ok('{"kind":"shell","action":"start","command":"x","waitMs":15000}')
	and pg_temp.shell_ok('{"kind":"shell","action":"read","sessionId":"00000000-0000-4000-8000-0000000000a1","waitMs":5000}')
	and pg_temp.shell_ok('{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"y\n","endInput":false,"waitMs":1000}')
	and pg_temp.shell_ok('{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"","endInput":true,"waitMs":1000}')
	and pg_temp.shell_ok('{"kind":"shell","action":"stop"}')
	and pg_temp.shell_ok('{"kind":"shell","action":"stop","sessionId":"00000000-0000-4000-8000-0000000000a1"}')
	and pg_temp.shell_ok('{"kind":"shell","action":"list"}')
	and pg_temp.shell_ok('{"kind":"shell","command":"ls","timeoutMs":15000}'),
	'every shell action the tool sends, and the older form, is valid');
select pg_temp.wake_assert(not pg_temp.shell_ok(bad),'invalid shell arguments: '||bad) from unnest(array[
	'{"kind":"shell","action":"start","command":"ls"}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":15001}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":1.5}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":"100"}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":-1}',
	'{"kind":"shell","action":"start","command":"   ","waitMs":0}',
	'{"kind":"shell","action":"start","command":"ls","waitMs":0,"timeoutMs":1000}',
	'{"kind":"shell","action":"read","sessionId":"not-a-command","waitMs":0}',
	'{"kind":"shell","action":"read","sessionId":"00000000-0000-4000-8000-0000000000a1"}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"","endInput":false,"waitMs":0}',
	'{"kind":"shell","action":"write","sessionId":"00000000-0000-4000-8000-0000000000a1","text":"y","endInput":"true","waitMs":0}',
	'{"kind":"shell","action":"stop","sessionId":"00000000-0000-4000-8000-0000000000a1","waitMs":0}',
	'{"kind":"shell","action":"list","waitMs":0}',
	'{"kind":"shell","action":"kill"}',
	'{"kind":"shell","command":"ls","timeoutMs":0}',
	'{"kind":"shell","command":"ls","timeoutMs":16000}',
	'{"kind":"shell","command":"ls","timeoutMs":1000,"waitMs":0}',
	'{"kind":"browser","action":"list"}']) as bad;
select pg_temp.wake_assert(not pg_temp.shell_ok(jsonb_build_object('kind','shell','action','start','command',repeat('x',16385),'waitMs',0)::text),
	'a command over 16 KiB is invalid');


-- The operator pauses the company: a report records nothing and tells the
-- office, which stops every shell.
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.report(pg_temp.busy());
reset role;
select pg_temp.wake_assert(pg_temp.demand(),'busy before the pause');
insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id)
values((pg_temp.office()).profile_id,'30000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.report(pg_temp.busy())='{"schema":"qorpera.office-shell-activity/v1","screens":[],"paused":true}'::jsonb,
	'a paused company is told so');
reset role;
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_office_shell_activity),
	'a paused company keeps no running command on record');


rollback;
