-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Order 8, part 1: an agent sets up, changes, pauses and removes its own
-- routines through its run binding, with no member approval, and the scheduler
-- enforces expiry, finite watches, quiet hours and authorization suspension.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.routine_binding',current_setting('qorpera_test.wake_binding'),true);

create function pg_temp.routine(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_routine(current_setting('qorpera_test.routine_binding')::jsonb,p_request)
$$;
create function pg_temp.routine_row(p_key text) returns public.qorpera_cloud_routines language sql as $$
	select routine from public.qorpera_cloud_routines routine where routine.routine_key = p_key and routine.origin = 'agent'
$$;

-- A human wake still owes its acknowledgement before any work, routines included.
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"list"}')$q$,'55000','Wake requires an acknowledgement before work');
select pg_temp.wake_public_send(current_setting('qorpera_test.routine_binding')::jsonb,'progress','routine-ack');

do $$
declare v_first jsonb; v_replay jsonb; v_second jsonb; v_row public.qorpera_cloud_routines; v_run public.qorpera_execution_runs;
	v_request jsonb := '{"action":"upsert","operationKey":"morning-queue-1","routineKey":"morning-queue","title":"Morning queue check",
		"intent":"Read support/queue.json. Tell the founder only if more than 10 tickets wait.",
		"trigger":{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday","tuesday","wednesday","thursday","friday"],
			"localTime":"08:00","timeZone":"Europe/Copenhagen","replyPolicy":"optional"}}';
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId')::uuid;
	v_first := pg_temp.routine(v_request);
	v_row := pg_temp.routine_row('morning-queue');
	perform pg_temp.wake_assert(v_first #>> '{routine,status}' = 'active' and v_row.status = 'active'
		and v_row.origin = 'agent' and v_row.owner_staff_agent_id = v_run.staff_agent_id
		and v_row.created_by_user_id = v_run.requested_by_user_id and v_row.current_version = 1,
		'An agent routine is active at once, owned by the calling agent, with no member step');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_cloud_routine_schedule_cursors
		where routine_id = v_row.id and routine_version = 1 and trigger_id = 'agent') = 1,'Schedule cursor is compiled');
	perform pg_temp.wake_assert((select staff_agent_id = v_run.staff_agent_id and sponsor_binding_id = v_run.sponsor_binding_id
		from public.qorpera_cloud_routine_versions where routine_id = v_row.id and version = 1),
		'The routine wakes the same agent on the account that already runs it');
	v_replay := pg_temp.routine(v_request);
	perform pg_temp.wake_assert(v_replay = v_first and (pg_temp.routine_row('morning-queue')).current_version = 1,
		'Replaying one operation key returns the same receipt and creates nothing');
	v_second := pg_temp.routine(jsonb_set(jsonb_set(v_request,'{operationKey}','"morning-queue-2"'),
		'{intent}','"Read support/queue.json. Report when more than 5 tickets wait."'));
	perform pg_temp.wake_assert((v_second #>> '{routine,version}')::int = 2 and
		(select count(*) from public.qorpera_cloud_routines where routine_key = 'morning-queue') = 1,
		'A changed intent is a new version of the same routine');
	perform pg_temp.wake_assert(jsonb_array_length(pg_temp.routine('{"action":"list"}') -> 'routines') = 1,'List shows own routines');
end $$;

-- Closed request, own agent only, control-plane only.
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"x1","routineKey":"x","title":"t","intent":"i",
	"staffAgentId":"30000000-0000-4000-8000-000000000031","trigger":{"kind":"schedule","intervalMinutes":60}}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"x2","routineKey":"x","title":"t","intent":"i",
	"trigger":{"kind":"schedule","intervalMinutes":1}}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"x3","routineKey":"x","title":"t","intent":"i",
	"trigger":{"kind":"listener","source":"company-file","path":"notes","match":"subtree","timeZone":"UTC","id":"mine"}}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"pause","operationKey":"x4","routineKey":"absent"}')$q$,'P0002');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_manage_agent_routine(current_setting('qorpera_test.routine_binding')::jsonb,'{"action":"list"}')$q$,'42501');
select pg_temp.path_claims('service_role');

-- Pause, resume, remove.
do $$
begin
	perform pg_temp.wake_assert(pg_temp.routine('{"action":"pause","operationKey":"p1","routineKey":"morning-queue"}')
		#>> '{routine,pauseReason}' = 'agent','Pause records who paused');
	perform pg_temp.wake_assert(pg_temp.routine('{"action":"resume","operationKey":"p2","routineKey":"morning-queue"}')
		#>> '{routine,status}' = 'active','Resume reactivates');
	perform pg_temp.wake_assert(pg_temp.routine('{"action":"remove","operationKey":"p3","routineKey":"morning-queue"}')
		#>> '{routine,status}' = 'retired','Remove retires');
	perform pg_temp.wake_assert(jsonb_array_length(pg_temp.routine('{"action":"list"}') -> 'routines') = 0,'Removed routines leave the list');
end $$;

-- Finite watch: one occurrence, then expired; a second slot is refused.
do $$
declare v_saved jsonb; v_row public.qorpera_cloud_routines; v_routine jsonb;
begin
	v_saved := pg_temp.routine('{"action":"upsert","operationKey":"once-1","routineKey":"watch-once","title":"One check","intent":"Check once.",
		"maxOccurrences":1,"trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('watch-once');
	v_routine := jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version);
	perform pg_temp.wake_schedule(v_routine,'once-a');
	perform pg_temp.wake_assert((pg_temp.routine_row('watch-once')).status = 'expired','The last permitted occurrence expires the watch');
	perform pg_temp.wake_error(format('select pg_temp.wake_schedule(%L::jsonb,%L)',v_routine,'once-b'),'PGRST');
end $$;

-- Effort: the agent chooses the thinking depth of its routine runs; medium unless it says otherwise.
-- The materialized run carries the routine version's effort when the active bundle allows routine
-- overrides (contract 17), and the bundle default otherwise.
do $$
declare v_row public.qorpera_cloud_routines; v_routine jsonb; v_run public.qorpera_execution_runs; v_manifest jsonb;
	v_expected text;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"eff-1","routineKey":"deep-check","title":"Deep check","intent":"Think hard.",
		"effort":"high","trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('deep-check');
	perform pg_temp.wake_assert((select effort from public.qorpera_cloud_routine_versions where routine_id = v_row.id and version = 1) = 'high'
		and (select routine ->> 'effort' from jsonb_array_elements(pg_temp.routine('{"action":"list"}') -> 'routines') routine
			where routine ->> 'routineKey' = 'deep-check') = 'high','A routine stores and lists the effort its agent chose');
	perform pg_temp.routine('{"action":"upsert","operationKey":"eff-2","routineKey":"plain-check","title":"Plain check","intent":"Look.",
		"trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	perform pg_temp.wake_assert((select effort from public.qorpera_cloud_routine_versions
		where routine_id = (pg_temp.routine_row('plain-check')).id and version = 1) = 'medium','Effort defaults to medium');
	v_routine := jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version);
	perform pg_temp.wake_schedule(v_routine,'eff-a');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run.* into v_run from public.qorpera_execution_runs run
	join public.qorpera_wake_occurrences wake on wake.id = run.source_id
	where run.source_kind = 'wake' and wake.routine_id = v_row.id order by run.created_at desc limit 1;
	perform pg_temp.wake_assert(v_run.id is not null,'The routine occurrence materialized a run');
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	v_expected := case when v_manifest #>> '{modelPolicy,overrides}' = 'routine' and (v_manifest #> '{modelPolicy,allowed}') ? 'high'
		then 'high' else v_manifest #>> '{modelPolicy,effort}' end;
	perform pg_temp.wake_assert(v_run.reasoning_effort = v_expected
		and public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort),
		'The routine run is pinned to the routine effort the bundle allows');
end $$;
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"eff-3","routineKey":"bad-check","title":"Bad","intent":"x",
	"effort":"max","trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}')$q$,'22023','Routine effort is invalid');
do $$
declare v_row public.qorpera_cloud_routines; v_first public.qorpera_cloud_routine_schedule_cursors;
	v_second public.qorpera_cloud_routine_schedule_cursors;
begin
	v_row := pg_temp.routine_row('deep-check');
	select * into v_first from public.qorpera_cloud_routine_schedule_cursors
	where routine_id = v_row.id and routine_version = v_row.current_version and trigger_id = 'agent';
	perform pg_temp.routine('{"action":"upsert","operationKey":"eff-4","routineKey":"deep-check","title":"Deep check","intent":"Think harder.",
		"trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('deep-check');
	select * into v_second from public.qorpera_cloud_routine_schedule_cursors
	where routine_id = v_row.id and routine_version = v_row.current_version and trigger_id = 'agent';
	perform pg_temp.wake_assert(v_row.current_version = 2
		and (select effort from public.qorpera_cloud_routine_versions where routine_id = v_row.id and version = 2) = 'high',
		'A save that does not mention effort keeps the effort the routine has');
	perform pg_temp.wake_assert(v_first.last_scheduled_for is not null and v_second.last_scheduled_for = v_first.last_scheduled_for
		and v_second.next_due_at = v_first.next_due_at,'A new version keeps the schedule position its routine reached');
end $$;

-- Expiry by time: the control-plane tick retires it and the scheduler stops listing it.
do $$
declare v_row public.qorpera_cloud_routines;
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','exp-1','routineKey','until-then','title','Short watch',
		'intent','Watch briefly.','expiresAt',to_char(clock_timestamp() + interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','silent')));
	perform pg_sleep(1.2);
end $$;
select public.qorpera_drain_company_file_wakes(1);
select pg_temp.wake_assert((pg_temp.routine_row('until-then')).status = 'expired','A routine past its expiry is expired by the tick');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"resume","operationKey":"exp-2","routineKey":"until-then"}')$q$,'55000');

-- Quiet hours defer an occurrence to the end of the window.
do $$
declare v_row public.qorpera_cloud_routines; v_id uuid; v_not_before timestamptz;
	v_start text := to_char((statement_timestamp() at time zone 'UTC') - interval '1 hour','HH24:MI');
	v_end text := to_char((statement_timestamp() at time zone 'UTC') + interval '2 hours','HH24:MI');
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','quiet-1','routineKey','quiet','title','Quiet','intent','Report.',
		'quietHours',jsonb_build_object('start',v_start,'end',v_end,'timeZone','UTC'),
		'trigger',jsonb_build_object('kind','schedule','intervalMinutes',5,'replyPolicy','optional')));
	v_row := pg_temp.routine_row('quiet');
	v_id := pg_temp.wake_schedule(jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version),'quiet-a');
	select not_before into v_not_before from public.qorpera_wake_occurrences where id = v_id;
	perform pg_temp.wake_assert(to_char(v_not_before at time zone 'UTC','HH24:MI') = v_end and v_not_before > statement_timestamp(),
		'An occurrence inside quiet hours waits for the end of the window');
end $$;

-- Three authorization failures in a row suspend the routine and notify once.
do $$
declare v_row public.qorpera_cloud_routines; v_routine jsonb; v_id uuid; v_index int;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"auth-1","routineKey":"auth","title":"Auth","intent":"Report.",
		"trigger":{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('auth');
	v_routine := jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version);
	for v_index in 1..3 loop
		v_id := pg_temp.wake_schedule(v_routine,'auth-' || v_index,statement_timestamp() - make_interval(mins => 40 - 10 * v_index));
		update public.qorpera_wake_occurrences set status = 'cancelled',
			blocked_reason = 'Wake execution authority is unavailable', finished_at = statement_timestamp() where id = v_id;
	end loop;
	v_row := pg_temp.routine_row('auth');
	perform pg_temp.wake_assert(v_row.status = 'paused' and v_row.pause_reason = 'authorization_failed'
		and v_row.authorization_failures = 3,'Three authorization failures suspend the routine');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_member_notifications
		where kind = 'routine_suspended' and subject ->> 'routineId' = v_row.id::text) = 1,'The member is told once');
end $$;

-- Unattended use is not a setting. An account that never recorded consent is
-- consented and bound in its owner's name when the routine is saved.
do $$
declare v_saved jsonb; v_run public.qorpera_execution_runs; v_connection uuid; v_before bigint;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId')::uuid;
	v_connection := (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid;
	-- Withdraw consent the way a member could before today: a newer version without it.
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":3,"allow_autonomous":false}'::jsonb)).*
	from public.qorpera_provider_connection_versions v where connection_id = v_connection and version = 2;
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_agent_routine_sponsor(v_run)),'Fixture: no unattended sponsor remains');
	v_saved := pg_temp.routine('{"action":"upsert","operationKey":"acct-1","routineKey":"always-runs","title":"Weekly review",
		"intent":"Review the week.","trigger":{"kind":"schedule","intervalMinutes":10080,"replyPolicy":"optional"}}');
	perform pg_temp.wake_assert(v_saved #>> '{routine,status}' = 'active' and v_saved #>> '{routine,pauseReason}' is null,
		'A routine never waits for an unattended setting');
	perform pg_temp.wake_assert((select allow_autonomous and consented_by_user_id = v_run.requested_by_user_id
			and consent_version = 'qorpera-unattended-default/v1'
		from public.qorpera_provider_connection_versions where connection_id = v_connection order by version desc limit 1),
		'Consent is recorded as a new version in the account owner''s name');
	perform pg_temp.wake_assert((select sponsor.allow_autonomous and sponsor.provider_connection_id = v_connection
		from public.qorpera_cloud_routine_versions version join public.qorpera_cloud_routines routine
			on routine.id = version.routine_id and routine.current_version = version.version
		join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = version.sponsor_binding_id
			and sponsor.version = version.sponsor_version
		where routine.routine_key = 'always-runs'),'The routine is bound to that account');
	select count(*) into v_before from public.qorpera_execution_sponsor_bindings;
	perform pg_temp.routine('{"action":"upsert","operationKey":"acct-2","routineKey":"always-runs-2","title":"Second",
		"intent":"Review.","trigger":{"kind":"schedule","intervalMinutes":10080,"replyPolicy":"optional"}}');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_execution_sponsor_bindings) = v_before,
		'A second routine reuses the binding');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_member_notifications
		where kind = 'routine_needs_model_account'),'Nobody is asked for anything');
end $$;

rollback;
