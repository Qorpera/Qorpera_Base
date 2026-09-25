-- @fixture 370_runtime_agent_routines.test.sql until "-- Runtime v95: an agent keeps any number"
-- Review 2026-09-25, finding 1: a finite routine's last permitted occurrence
-- expired the routine the moment it was admitted, and admission then refused it
-- ("Wake recipient or source authority is unavailable", no run). A one-time
-- routine never ran; every finite routine lost its last run. Expiry closes
-- FUTURE scheduling only: an occurrence admitted before it still creates a run,
-- and that run reads its wake and completes through the real boundaries.
-- A pause or a removal still stops pending work.

-- The fixture's human run is still open; a routine run is claimed after it.
create function pg_temp.routine_run(p_wake uuid) returns uuid language sql as $$
	select run_id from public.qorpera_wake_occurrences where id = p_wake and status = 'materialized'
$$;
-- Starts the run on a real runner, reads its wake, begins the native turn and
-- completes it silently with the governed v6 completion.
create function pg_temp.complete_routine_run(p_run uuid,p_intent text) returns jsonb language plpgsql as $$
declare v_binding jsonb; v_identity jsonb; v_job public.qorpera_runner_jobs%rowtype; v_wake jsonb;
begin
	v_binding := pg_temp.wake_start(p_run);
	v_wake := public.qorpera_read_native_wake(v_binding);
	perform pg_temp.wake_assert(v_wake #>> '{routine,intent}' = p_intent,'The run reads its routine intent');
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c',64),10);
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid;
	return public.qorpera_complete_runner_job_v6((v_binding ->> 'runnerId')::uuid,repeat('2',64),v_job.id,repeat('3',64),
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),null,
		jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
			'native_lease_id',v_binding ->> 'leaseId','substrate_version_id',v_job.substrate_version_id,
			'output_count',0,'output_bytes',0,'publication',null,
			'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',p_run,
				'message_count',0,'final_message_id',null,'provider_session_id','finite-routine-fixture'),
			'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
end
$$;

-- Stands in for the clock reaching a queued occurrence's time; not_before is otherwise immutable.
create function pg_temp.dyn_due_371(p_wake uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set not_before = clock_timestamp() - interval '1 second' where id = p_wake;
	set local session_replication_role = origin;
end
$$;

-- A one-time routine: its only occurrence expires the routine and still runs to completion.
do $$
declare v_row public.qorpera_cloud_routines; v_wake uuid; v_run uuid; v_done jsonb;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"last-1","routineKey":"once-only","title":"One check","intent":"Check once.",
		"maxOccurrences":1,"trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('once-only');
	v_wake := pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'once-only-a');
	perform pg_temp.wake_assert((pg_temp.routine_row('once-only')).status = 'expired','The only occurrence closes the routine');
	perform pg_temp.wake_error(format('select pg_temp.wake_schedule(%L::jsonb,%L)',
		jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'once-only-b'),'PGRST');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake);
	perform pg_temp.wake_assert(v_run is not null,'The admitted last occurrence creates a run: '
		|| coalesce((select status || ' / ' || coalesce(blocked_reason,'') from public.qorpera_wake_occurrences where id = v_wake),'missing'));
	v_done := pg_temp.complete_routine_run(v_run,'Check once.');
	perform pg_temp.wake_assert(v_done ->> 'status' = 'completed'
		and (select status from public.qorpera_runner_jobs where run_id = v_run) = 'completed',
		'The last run completes');
	perform pg_temp.wake_assert((pg_temp.routine_row('once-only')).status = 'expired','The routine stays expired after its last run');
end $$;

-- A finite routine of three: the third occurrence closes it and still runs; nothing is lost.
do $$
declare v_row public.qorpera_cloud_routines; v_routine jsonb; v_wakes uuid[] := '{}'; v_index integer; v_run uuid;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"last-3","routineKey":"three-times","title":"Three checks","intent":"Check three times.",
		"maxOccurrences":3,"trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('three-times');
	v_routine := jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version);
	for v_index in 1..3 loop
		v_wakes := v_wakes || pg_temp.wake_schedule(v_routine,'three-' || v_index,
			statement_timestamp() - make_interval(mins => 20 - 5 * v_index));
		perform pg_temp.wake_assert((pg_temp.routine_row('three-times')).status = case when v_index < 3 then 'active' else 'expired' end,
			'Only the third occurrence closes the routine');
		perform public.qorpera_materialize_wake_execution_runs(8);
		v_run := pg_temp.routine_run(v_wakes[v_index]);
		perform pg_temp.wake_assert(v_run is not null,'Occurrence ' || v_index || ' of 3 creates a run');
		perform pg_temp.wake_assert(pg_temp.complete_routine_run(v_run,'Check three times.') ->> 'status' = 'completed',
			'Occurrence ' || v_index || ' of 3 completes');
	end loop;
end $$;

-- Quiet hours defer the last occurrence past its admission. It waits, queued and
-- still authorized, while the routine is expired and the expiry sweep runs, then
-- runs when it comes due. The fixture stands in for the clock reaching the end of
-- the window: an occurrence's not_before is otherwise immutable.
do $$
declare v_row public.qorpera_cloud_routines; v_wake uuid; v_run uuid; v_not_before timestamptz;
	v_start text := to_char((statement_timestamp() at time zone 'UTC') - interval '1 hour','HH24:MI');
	v_end text := to_char((statement_timestamp() at time zone 'UTC') + interval '2 hours','HH24:MI');
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','last-q','routineKey','quiet-once','title','Quiet once',
		'intent','Report once after the quiet hours.','maxOccurrences',1,
		'quietHours',jsonb_build_object('start',v_start,'end',v_end,'timeZone','UTC'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','silent')));
	v_row := pg_temp.routine_row('quiet-once');
	v_wake := pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'quiet-once-a');
	select not_before into strict v_not_before from public.qorpera_wake_occurrences where id = v_wake;
	perform pg_temp.wake_assert(v_not_before > statement_timestamp() and (pg_temp.routine_row('quiet-once')).status = 'expired',
		'The last occurrence waits for the end of the quiet hours; the routine is closed');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform public.qorpera_drain_company_file_wakes(8);
	perform pg_temp.wake_assert((select status = 'queued' and run_id is null from public.qorpera_wake_occurrences where id = v_wake)
		and public.qorpera_wake_authorized((select wake from public.qorpera_wake_occurrences wake where id = v_wake)),
		'While it waits the occurrence stays queued and authorized');
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set not_before = clock_timestamp() - interval '1 second' where id = v_wake;
	set local session_replication_role = origin;
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake);
	perform pg_temp.wake_assert(v_run is not null,'The deferred last occurrence creates a run once it is due');
	perform pg_temp.wake_assert(pg_temp.complete_routine_run(v_run,'Report once after the quiet hours.') ->> 'status' = 'completed',
		'The deferred last run completes');
end $$;

-- A run already working when its routine is paused loses its authority, and the
-- routine's later expiry (swept below) must not give it back.
do $$
declare v_row public.qorpera_cloud_routines;
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','pm-1','routineKey','paused-mid-run','title','Pause mid',
		'intent','Work.','expiresAt',to_char(clock_timestamp() + interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','silent')));
	v_row := pg_temp.routine_row('paused-mid-run');
	perform pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'pm-a');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform set_config('qorpera_test.paused_mid_run',pg_temp.wake_start(pg_temp.routine_run(
		(select id from public.qorpera_wake_occurrences where occurrence_key = 'pm-a')))::text,true);
	perform public.qorpera_read_native_wake(current_setting('qorpera_test.paused_mid_run')::jsonb);
	perform pg_temp.routine('{"action":"pause","operationKey":"pm-2","routineKey":"paused-mid-run"}');
	perform pg_temp.wake_error(format('select public.qorpera_read_native_wake(%L::jsonb)',current_setting('qorpera_test.paused_mid_run')),'42501');
end $$;

-- Expiry by time: an occurrence admitted before the expiry instant still runs.
-- The expiry sweep compares with its own statement's time, so it runs as a
-- separate statement after the sleep. A routine paused while its occurrence
-- waits and then expired keeps the pause: that occurrence never runs.
do $$
declare v_row public.qorpera_cloud_routines;
	v_start text := to_char((statement_timestamp() at time zone 'UTC') - interval '1 hour','HH24:MI');
	v_end text := to_char((statement_timestamp() at time zone 'UTC') + interval '2 hours','HH24:MI');
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','last-t','routineKey','until-soon','title','Short watch',
		'intent','Watch briefly.','expiresAt',to_char(clock_timestamp() + interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','silent')));
	v_row := pg_temp.routine_row('until-soon');
	perform pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'until-soon-a');
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','pe-1','routineKey','paused-expired','title','Paused',
		'intent','Hold on.','expiresAt',to_char(clock_timestamp() + interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'quietHours',jsonb_build_object('start',v_start,'end',v_end,'timeZone','UTC'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','silent')));
	v_row := pg_temp.routine_row('paused-expired');
	perform pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'paused-expired-a');
	perform pg_temp.routine('{"action":"pause","operationKey":"pe-2","routineKey":"paused-expired"}');
	perform pg_sleep(1.2);
end $$;
select public.qorpera_drain_company_file_wakes(8);
do $$
declare v_run uuid; v_wake uuid := (select id from public.qorpera_wake_occurrences where occurrence_key = 'until-soon-a');
	v_paused uuid := (select id from public.qorpera_wake_occurrences where occurrence_key = 'paused-expired-a');
begin
	perform pg_temp.wake_assert((pg_temp.routine_row('until-soon')).status = 'expired'
		and (pg_temp.routine_row('paused-expired')).status = 'expired'
		and (pg_temp.routine_row('paused-mid-run')).status = 'expired','The routines expired by time');
	perform pg_temp.wake_assert((pg_temp.routine_row('until-soon')).expired_while_active
		and not (pg_temp.routine_row('paused-expired')).expired_while_active,'Each routine remembers how it ended');
	perform pg_temp.wake_error(format('select public.qorpera_read_native_wake(%L::jsonb)',current_setting('qorpera_test.paused_mid_run')),'42501');
	perform pg_temp.wake_assert((select status = 'cancelled' and run_id is null and blocked_reason = 'Routine expired while paused'
		from public.qorpera_wake_occurrences where id = v_paused),
		'A routine paused before it expired cancels its pending occurrence');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake);
	perform pg_temp.wake_assert(v_run is not null,'An occurrence admitted before the expiry instant still runs');
	perform pg_temp.wake_assert(pg_temp.complete_routine_run(v_run,'Watch briefly.') ->> 'status' = 'completed',
		'That run completes');
end $$;

-- An edit applies to the next run. A routine run that saves its own routine (the
-- "start dense, then upsert the steady cadence" guidance) keeps its authority,
-- sees its receipt, reads its wake and completes; a queued occurrence of the
-- older version is still refused.
do $$
declare v_row public.qorpera_cloud_routines; v_routine jsonb; v_wake uuid; v_stale uuid; v_run uuid; v_binding jsonb;
	v_saved jsonb; v_identity jsonb; v_job public.qorpera_runner_jobs%rowtype; v_done jsonb;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"se-1","routineKey":"self-edit","title":"Learn the queue","intent":"Learn.",
		"trigger":{"kind":"schedule","intervalMinutes":60,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('self-edit');
	v_routine := jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version);
	v_wake := pg_temp.wake_schedule(v_routine,'se-a',statement_timestamp() - interval '70 minutes');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake);
	-- A later slot of the same version waits, admitted but not yet due.
	v_stale := pg_temp.wake_schedule(v_routine,'se-b',statement_timestamp() + interval '30 minutes');
	v_binding := pg_temp.wake_start(v_run);
	v_saved := public.qorpera_manage_agent_routine(v_binding,'{"action":"upsert","operationKey":"se-2","routineKey":"self-edit",
		"title":"Queue check","intent":"Steady now.","trigger":{"kind":"schedule","intervalMinutes":1440,"replyPolicy":"silent"}}');
	perform pg_temp.wake_assert((v_saved #>> '{routine,version}')::int = 2,'The routine run saved a new version of its own routine');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_manage_agent_routine(v_binding,'{"action":"list"}') -> 'routines') >= 1
		and public.qorpera_read_native_wake(v_binding) #>> '{routine,intent}' = 'Learn.',
		'The run keeps working on the version it started with');
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c',64),10);
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid;
	v_done := public.qorpera_complete_runner_job_v6((v_binding ->> 'runnerId')::uuid,repeat('2',64),v_job.id,repeat('3',64),
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),null,
		jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
			'native_lease_id',v_binding ->> 'leaseId','substrate_version_id',v_job.substrate_version_id,
			'output_count',0,'output_bytes',0,'publication',null,
			'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',v_run,
				'message_count',0,'final_message_id',null,'provider_session_id','self-edit-fixture'),
			'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
	perform pg_temp.wake_assert(v_done ->> 'status' = 'completed','The self-editing run completes');
	perform pg_temp.wake_assert(not public.qorpera_wake_authorized((select wake from public.qorpera_wake_occurrences wake where id = v_wake)),
		'Once its job ended, the run''s work follows the current version again (a later continuation is refused)');
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set not_before = clock_timestamp() - interval '1 second' where id = v_stale;
	set local session_replication_role = origin;
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select status = 'cancelled' and run_id is null from public.qorpera_wake_occurrences where id = v_stale),
		'A queued occurrence of the older version is not run');
end $$;

-- A member moving a routine to another agent stops the old agent's started run:
-- the version rule spares a run only while the routine stays with its agent.
do $$
declare v_routine jsonb; v_client uuid := extensions.gen_random_uuid(); v_wake uuid; v_binding jsonb;
begin
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"moved","kind":"schedule","intervalMinutes":60,"replyPolicy":"silent"}',v_client);
	v_wake := pg_temp.wake_schedule(v_routine,'moved-a',statement_timestamp() - interval '70 minutes');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_binding := pg_temp.wake_start(pg_temp.routine_run(v_wake));
	perform public.qorpera_read_native_wake(v_binding);
	-- Same agent, new version: the started run keeps working.
	perform pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"moved","kind":"schedule","intervalMinutes":120,"replyPolicy":"silent"}',v_client);
	perform public.qorpera_read_native_wake(v_binding);
	-- Another agent: the old agent's run stops.
	perform pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		'{"id":"moved","kind":"schedule","intervalMinutes":120,"replyPolicy":"silent"}',v_client);
	perform pg_temp.wake_error(format('select public.qorpera_read_native_wake(%L::jsonb)',v_binding),'42501');
end $$;

-- Removed after its last occurrence was admitted: the occurrence never runs.
do $$
declare v_row public.qorpera_cloud_routines; v_wake uuid;
	v_start text := to_char((statement_timestamp() at time zone 'UTC') - interval '1 hour','HH24:MI');
	v_end text := to_char((statement_timestamp() at time zone 'UTC') + interval '2 hours','HH24:MI');
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','rm-1','routineKey','removed-once','title','Removed',
		'intent','Never mind.','maxOccurrences',1,
		'quietHours',jsonb_build_object('start',v_start,'end',v_end,'timeZone','UTC'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','silent')));
	v_row := pg_temp.routine_row('removed-once');
	v_wake := pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'removed-once-a');
	perform pg_temp.wake_assert((pg_temp.routine_row('removed-once')).status = 'expired','Fixture: the routine closed');
	perform pg_temp.routine('{"action":"remove","operationKey":"rm-2","routineKey":"removed-once"}');
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set not_before = clock_timestamp() - interval '1 second' where id = v_wake;
	set local session_replication_role = origin;
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select status = 'cancelled' and run_id is null from public.qorpera_wake_occurrences where id = v_wake),
		'A removed routine''s pending occurrence is cancelled');
end $$;

-- Archiving an agent stops its ended routines as it pauses its live ones: after a
-- restore, neither a queued last run nor a started one regains authority.
do $$
declare v_row public.qorpera_cloud_routines; v_queued uuid; v_started uuid; v_binding jsonb; v_staff uuid;
	v_start text := to_char((statement_timestamp() at time zone 'UTC') - interval '1 hour','HH24:MI');
	v_end text := to_char((statement_timestamp() at time zone 'UTC') + interval '2 hours','HH24:MI');
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','ar-1','routineKey','archive-queued','title','Queued',
		'intent','Wait.','maxOccurrences',1,'quietHours',jsonb_build_object('start',v_start,'end',v_end,'timeZone','UTC'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','silent')));
	v_row := pg_temp.routine_row('archive-queued');
	v_queued := pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'ar-q');
	perform pg_temp.routine('{"action":"upsert","operationKey":"ar-2","routineKey":"archive-started","title":"Started","intent":"Work.",
		"maxOccurrences":1,"trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('archive-started');
	v_started := pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'ar-s');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_binding := pg_temp.wake_start(pg_temp.routine_run(v_started));
	perform pg_temp.wake_assert((pg_temp.routine_row('archive-queued')).expired_while_active
		and (pg_temp.routine_row('archive-started')).expired_while_active,'Fixture: both ended while active');
	v_staff := v_row.owner_staff_agent_id;
	update public.qorpera_profile_staff set employment_status = 'archived',version = version + 1 where staff_agent_id = v_staff;
	update public.qorpera_profile_staff set employment_status = 'active',version = version + 1 where staff_agent_id = v_staff;
	perform pg_temp.wake_assert(not (pg_temp.routine_row('archive-queued')).expired_while_active
		and not (pg_temp.routine_row('archive-started')).expired_while_active,'Archiving stopped both');
	perform pg_temp.wake_error(format('select public.qorpera_read_native_wake(%L::jsonb)',v_binding),'42501');
	perform pg_temp.dyn_due_371(v_queued);
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select status = 'cancelled' and run_id is null from public.qorpera_wake_occurrences where id = v_queued),
		'A restore does not revive an archived agent''s last run');
end $$;

rollback;
