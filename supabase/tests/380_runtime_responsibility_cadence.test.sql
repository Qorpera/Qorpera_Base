-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- @fixture fixtures/runtime-responsibility-escalations.sql until "-- END RESPONSIBILITY ROUTING FIXTURE"
-- Order 8, part 2: an active responsibility owns one cadence routine for its
-- accountable agent; it follows the responsibility; routines waiting for a
-- model account start when a member allows unattended use.
reset role;
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(public.qorpera_responsibility_cadence_minutes('Weekly') = 10080
	and public.qorpera_responsibility_cadence_minutes('daily') = 1440
	and public.qorpera_responsibility_cadence_minutes('every 3 days') = 4320
	and public.qorpera_responsibility_cadence_minutes('every 2 weeks') is null
	and public.qorpera_responsibility_cadence_minutes('when the founder asks') is null,'Cadence vocabulary');

do $$
declare v_routine public.qorpera_cloud_routines; v_version public.qorpera_cloud_routine_versions; v_id uuid := '32000000-0000-4000-8000-000000000001';
begin
	select * into strict v_routine from public.qorpera_cloud_routines where responsibility_id = v_id;
	select * into strict v_version from public.qorpera_cloud_routine_versions where routine_id = v_routine.id and version = v_routine.current_version;
	perform pg_temp.wake_assert(v_routine.status = 'active' and v_routine.origin = 'responsibility'
		and v_version.staff_agent_id = '30000000-0000-4000-8000-000000000030'
		and (v_version.triggers #>> '{0,intervalMinutes}')::int = 10080 and v_version.triggers #>> '{0,replyPolicy}' = 'optional'
		and (v_version.triggers #>> '{0,startAt}')::timestamptz > statement_timestamp()
		and v_version.prompt like '%organization/responsibilities/' || v_id || '.json%',
		'An active weekly responsibility wakes its accountable agent weekly, first one interval from now, silent when nothing changed');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_cloud_routine_schedule_cursors
		where routine_id = v_routine.id and routine_version = v_routine.current_version) = 1,'The cadence is compiled into one schedule cursor');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_cloud_routines where origin = 'responsibility') =
		(select count(*) from public.qorpera_company_responsibilities where status = 'active'),'One routine per active responsibility');

	-- The agent sees its cadence, so it does not duplicate it, but cannot edit or remove it.
	perform pg_temp.wake_assert(exists (select 1 from jsonb_array_elements(public.qorpera_manage_agent_routine(
		current_setting('qorpera_test.wake_binding')::jsonb,'{"action":"list"}') -> 'routines') item
		where item ->> 'origin' = 'responsibility'),'A cadence routine is visible to its agent');
	perform pg_temp.wake_error(format($q$select public.qorpera_manage_agent_routine(current_setting('qorpera_test.wake_binding')::jsonb,
		'{"action":"remove","operationKey":"rm-cadence","routineKey":"responsibility.%s"}')$q$,'32000000-0000-4000-8000-000000000003'),'P0002');

	-- It follows the responsibility.
	update public.qorpera_company_responsibilities set attention_cadence = 'daily' where id = v_id;
	select * into strict v_routine from public.qorpera_cloud_routines where responsibility_id = v_id;
	perform pg_temp.wake_assert(v_routine.current_version = 2 and (select (triggers #>> '{0,intervalMinutes}')::int = 1440
		from public.qorpera_cloud_routine_versions where routine_id = v_routine.id and version = 2),'A new cadence is a new version');
	update public.qorpera_company_responsibilities set accountable_staff_agent_id = '30000000-0000-4000-8000-000000000031' where id = v_id;
	perform pg_temp.wake_assert((select staff_agent_id = '30000000-0000-4000-8000-000000000031'
		from public.qorpera_cloud_routine_versions version join public.qorpera_cloud_routines routine
			on routine.id = version.routine_id and routine.current_version = version.version
		where routine.responsibility_id = v_id),'A new owner is woken instead of the old one');
	update public.qorpera_company_responsibilities set status = 'paused' where id = v_id;
	perform pg_temp.wake_assert((select status = 'paused' from public.qorpera_cloud_routines where responsibility_id = v_id),'Pausing the responsibility pauses its cadence');
	update public.qorpera_company_responsibilities set status = 'active', attention_cadence = 'when the founder asks' where id = v_id;
	perform pg_temp.wake_assert((select status = 'paused' from public.qorpera_cloud_routines where responsibility_id = v_id),'A free-text cadence schedules nothing');
	update public.qorpera_company_responsibilities set attention_cadence = 'weekly' where id = v_id;
	perform pg_temp.wake_assert((select status = 'active' from public.qorpera_cloud_routines where responsibility_id = v_id),'A recognised cadence resumes it');
	update public.qorpera_company_responsibilities set status = 'retired' where id = v_id;
	perform pg_temp.wake_assert((select status = 'retired' from public.qorpera_cloud_routines where responsibility_id = v_id),'Retiring the responsibility retires its cadence');
end $$;

-- A routine waiting for a model account starts when a member allows unattended use.
do $$
declare v_saved jsonb; v_run public.qorpera_execution_runs; v_new uuid;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	alter table public.qorpera_execution_sponsor_versions disable trigger user;
	update public.qorpera_execution_sponsor_versions set allow_autonomous = false where binding_id = v_run.sponsor_binding_id;
	alter table public.qorpera_execution_sponsor_versions enable trigger user;
	v_saved := public.qorpera_manage_agent_routine(current_setting('qorpera_test.wake_binding')::jsonb,
		'{"action":"upsert","operationKey":"wait-1","routineKey":"waiting","title":"Weekly review","intent":"Review the week.",
		"trigger":{"kind":"schedule","intervalMinutes":10080,"replyPolicy":"optional"}}');
	perform pg_temp.wake_assert(v_saved #>> '{routine,pauseReason}' = 'needs_model_account','The routine waits for an account');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_new := (public.qorpera_create_member_execution_sponsor(v_run.profile_id,extensions.gen_random_uuid(),
		(current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid,2,true) ->> 'binding_id')::uuid;
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((select routine.status = 'active' and routine.pause_reason is null and version.sponsor_binding_id = v_new
		from public.qorpera_cloud_routines routine join public.qorpera_cloud_routine_versions version
			on version.routine_id = routine.id and version.version = routine.current_version
		where routine.routine_key = 'waiting'),'Allowing unattended use starts the waiting routine on that account, with no resume step');
end $$;

rollback;
