-- @fixture 371_runtime_finite_routine_last_run.test.sql until "-- A one-time routine: its only occurrence"
-- Dynamic routines (2026-09-25 amendment to contract 16.3). A dynamic routine
-- has exactly one next run; each run decides the next one (maybe with changed
-- instructions, a new version) or concludes the routine. Every step here goes
-- through the real boundaries: the agent's routine tool, admission, a runner
-- lease, the native start, the mouth and the governed v6 completion.

create function pg_temp.dyn_start(p_run uuid) returns jsonb language plpgsql as $$
declare v_binding jsonb; v_identity jsonb;
begin
	v_binding := pg_temp.wake_start(p_run);
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c',64),10);
	return v_binding;
end
$$;
create function pg_temp.dyn_complete(p_binding jsonb) returns jsonb language plpgsql as $$
declare v_job public.qorpera_runner_jobs%rowtype; v_count integer; v_final text;
begin
	select * into strict v_job from public.qorpera_runner_jobs where id = (p_binding ->> 'jobId')::uuid;
	select count(*),max(delivery.event_id::text) filter(where delivery.phase = 'final') into v_count,v_final
	from public.qorpera_agent_sends delivery join public.qorpera_session_events event on event.event_id = delivery.event_id
	where delivery.run_id = (p_binding ->> 'runId')::uuid and delivery.assignment_id = v_job.client_lease_id;
	return public.qorpera_complete_runner_job_v6((p_binding ->> 'runnerId')::uuid,repeat('2',64),v_job.id,repeat('3',64),
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),null,
		jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
			'native_lease_id',p_binding ->> 'leaseId','substrate_version_id',v_job.substrate_version_id,
			'output_count',0,'output_bytes',0,'publication',null,
			'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',p_binding ->> 'runId',
				'message_count',v_count,'final_message_id',v_final,'provider_session_id','dynamic-routine-fixture'),
			'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
end
$$;
create function pg_temp.dyn_decide(p_binding jsonb,p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_decide_agent_routine(p_binding,p_request)
$$;
create function pg_temp.dyn_pending(p_key text) returns public.qorpera_wake_occurrences language sql as $$
	select wake from public.qorpera_wake_occurrences wake join public.qorpera_cloud_routines routine on routine.id = wake.routine_id
	where routine.routine_key = p_key and wake.status = 'queued' order by wake.created_at desc limit 1
$$;
-- Stands in for the clock reaching a queued occurrence's time; not_before is otherwise immutable.
create function pg_temp.dyn_due(p_wake uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set not_before = clock_timestamp() - interval '1 second' where id = p_wake;
	set local session_replication_role = origin;
end
$$;
create function pg_temp.iso(p_at timestamptz) returns text language sql as $$
	select to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Set-up: a dynamic routine is saved with its one first run, and nothing else.
do $$
declare v_saved jsonb; v_row public.qorpera_cloud_routines; v_wake public.qorpera_wake_occurrences;
begin
	v_saved := pg_temp.routine(jsonb_build_object('action','upsert','operationKey','dyn-1','routineKey','invoice-watch',
		'title','Invoice follow-up','intent','Check whether invoice 42 was paid.',
		'trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp()),'timeZone','Europe/Copenhagen',
			'replyPolicy','optional')));
	v_row := pg_temp.routine_row('invoice-watch');
	v_wake := pg_temp.dyn_pending('invoice-watch');
	perform pg_temp.wake_assert(v_row.status = 'active' and v_row.current_version = 1
		and v_wake.id is not null and v_wake.routine_version = 1 and v_wake.occurrence_key = 'once:1:1'
		and v_wake.source_kind = 'schedule' and v_wake.not_before <= clock_timestamp()
		and v_saved #>> '{routine,nextRunAt}' is not null,
		'A dynamic routine is saved with exactly one next run, due at its chosen time');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_row.id),
		'A dynamic routine has no cadence for the orchestrator');
	perform pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"dyn-x","routineKey":"dyn-limited",
		"title":"t","intent":"i","maxOccurrences":3,"trigger":{"kind":"once","at":"2026-10-01T08:00:00.000Z","timeZone":"UTC"}}')$q$,
		'22023','A dynamic routine takes no occurrence limit');
	perform pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"dyn-y","routineKey":"dyn-bad",
		"title":"t","intent":"i","trigger":{"kind":"once","at":"now","timeZone":"UTC"}}')$q$,'22023');
	-- The human run is not a dynamic routine run: it cannot decide one.
	perform pg_temp.wake_error(format('select pg_temp.dyn_decide(%L::jsonb,%L::jsonb)',current_setting('qorpera_test.routine_binding'),
		'{"action":"conclude","operationKey":"c0","summary":"x"}'),'42501');
end $$;

-- Run 1: the decision comes before the final message and before completion. The
-- run chooses its next run with changed instructions: a new version.
do $$
declare v_wake public.qorpera_wake_occurrences := pg_temp.dyn_pending('invoice-watch'); v_run uuid; v_binding jsonb;
	v_next jsonb; v_replay jsonb; v_row public.qorpera_cloud_routines; v_later public.qorpera_wake_occurrences;
	v_at text := pg_temp.iso(statement_timestamp() + interval '2 hours');
begin
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake.id);
	perform pg_temp.wake_assert(v_run is not null,'The first run is admitted');
	v_binding := pg_temp.dyn_start(v_run);
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_binding) -> 'routine' @> '{"dynamic":true,"version":1}'
		and public.qorpera_read_native_wake(v_binding) #>> '{routine,intent}' = 'Check whether invoice 42 was paid.',
		'The run learns that its routine is dynamic');
	perform pg_temp.wake_public_send(v_binding,'progress','dyn-progress');
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L::jsonb,%L,%L)',v_binding,'final','dyn-final-early'),
		'55000','Decide this routine''s next run or conclude it before the final message');
	perform pg_temp.wake_error(format('select pg_temp.dyn_complete(%L::jsonb)',v_binding),
		'55000','Dynamic routine run ended without deciding its next run');
	v_next := pg_temp.dyn_decide(v_binding,jsonb_build_object('action','next','operationKey','next-1','at',v_at,
		'intent','Invoice 42 is still open. Check again and remind finance if it is still open tomorrow.'));
	v_row := pg_temp.routine_row('invoice-watch');
	v_later := pg_temp.dyn_pending('invoice-watch');
	perform pg_temp.wake_assert(v_next ->> 'schema' = 'qorpera.agent-routine-receipt/v1' and v_next ->> 'action' = 'upsert'
		and (v_next #>> '{routine,version}')::int = 2 and v_row.current_version = 2 and v_row.status = 'active'
		and v_later.routine_version = 2 and v_later.occurrence_key = 'once:2:1'
		and v_later.not_before = v_at::timestamptz and (v_next #>> '{routine,nextRunAt}')::timestamptz = v_at::timestamptz,
		'Next: a new version whose one run is at the chosen time');
	perform pg_temp.wake_assert((select prompt from public.qorpera_cloud_routine_versions where routine_id = v_row.id and version = 1)
		= 'Check whether invoice 42 was paid.' and (select prompt from public.qorpera_cloud_routine_versions
			where routine_id = v_row.id and version = 2) like 'Invoice 42 is still open.%'
		and (select effort from public.qorpera_cloud_routine_versions where routine_id = v_row.id and version = 2) = 'medium',
		'Changed instructions are a new version; the history stays');
	v_replay := pg_temp.dyn_decide(v_binding,jsonb_build_object('action','next','operationKey','next-1','at',v_at,
		'intent','Invoice 42 is still open. Check again and remind finance if it is still open tomorrow.'));
	perform pg_temp.wake_assert(v_replay = v_next,'Replaying the same decision returns the same receipt');
	perform pg_temp.wake_assert(pg_temp.dyn_decide(v_binding,'{"action":"conclude","operationKey":"late","summary":"No."}')
		->> 'state' = 'settled' and (pg_temp.routine_row('invoice-watch')).status = 'active',
		'A second decision by the same run changes nothing');
	perform pg_temp.wake_public_send(v_binding,'final','dyn-final');
	perform pg_temp.wake_assert(pg_temp.dyn_complete(v_binding) ->> 'status' = 'completed','The deciding run completes');
end $$;

-- Run 2 reads the new instructions and concludes the routine with its reason.
-- A concluded routine keeps its history, is not resumed, and a new save restarts it.
do $$
declare v_wake public.qorpera_wake_occurrences := pg_temp.dyn_pending('invoice-watch'); v_run uuid; v_binding jsonb;
	v_done jsonb; v_row public.qorpera_cloud_routines; v_list jsonb; v_restart jsonb;
begin
	perform pg_temp.dyn_due(v_wake.id);
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake.id);
	v_binding := pg_temp.dyn_start(v_run);
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_binding) #>> '{routine,intent}' like 'Invoice 42 is still open.%',
		'The next run carries the changed instructions');
	v_done := pg_temp.dyn_decide(v_binding,'{"action":"conclude","operationKey":"done-1","summary":"Invoice 42 was paid on 26 September."}');
	v_row := pg_temp.routine_row('invoice-watch');
	perform pg_temp.wake_assert(v_done ->> 'action' = 'conclude' and v_done #>> '{routine,status}' = 'concluded'
		and v_row.status = 'concluded' and v_row.conclusion = 'Invoice 42 was paid on 26 September.'
		and v_row.concluded_at is not null and v_done #>> '{routine,nextRunAt}' is null
		and pg_temp.dyn_pending('invoice-watch') is null,
		'Conclude ends the routine with its reason and leaves no next run');
	perform pg_temp.wake_assert(pg_temp.dyn_complete(v_binding) ->> 'status' = 'completed','The concluding run completes silently');
	perform public.qorpera_drain_company_file_wakes(8);
	perform pg_temp.wake_assert(pg_temp.dyn_pending('invoice-watch') is null,'Nothing restores a concluded routine');
	perform pg_temp.wake_error($q$select pg_temp.routine('{"action":"resume","operationKey":"dyn-r","routineKey":"invoice-watch"}')$q$,
		'55000','Routine was concluded; save it again to restart it');
	-- A member sees the next run and how the routine ended.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	select item into v_list from jsonb_array_elements(public.qorpera_list_cloud_routines('30000000-0000-4000-8000-000000000020')) item
	where item ->> 'routine_id' = v_row.id::text;
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(v_list ->> 'status' = 'concluded' and v_list ->> 'conclusion' = 'Invoice 42 was paid on 26 September.'
		and v_list ? 'next_run_at' and v_list -> 'next_run_at' = 'null'::jsonb,'The member list shows the conclusion');
	v_restart := pg_temp.routine(jsonb_build_object('action','upsert','operationKey','dyn-restart','routineKey','invoice-watch',
		'title','Invoice follow-up','intent','Watch invoice 43 instead.',
		'trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp() + interval '1 day'),'timeZone','Europe/Copenhagen')));
	v_row := pg_temp.routine_row('invoice-watch');
	perform pg_temp.wake_assert(v_row.status = 'active' and v_row.conclusion is null and v_row.concluded_at is null
		and v_row.current_version = 3 and (pg_temp.dyn_pending('invoice-watch')).routine_version = 3,
		'A new save restarts a concluded routine with one next run');
end $$;

-- A run that ends without deciding (it failed, crashed or was refused) does not
-- lose the routine: the tick retries it at once three times, then waits longer
-- each time, at most a day. Nothing gives up by count.
do $$
declare v_row public.qorpera_cloud_routines; v_wake public.qorpera_wake_occurrences; v_run uuid; v_binding jsonb;
	v_attempt integer; v_waits interval[] := '{}';
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','retry-1','routineKey','retry-watch',
		'title','Retry watch','intent','Look.','trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp()),
			'timeZone','UTC','replyPolicy','silent')));
	v_wake := pg_temp.dyn_pending('retry-watch');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake.id);
	v_binding := pg_temp.dyn_start(v_run);
	-- The turn ends without a decision: the kernel refuses completion, the job fails.
	perform pg_temp.wake_error(format('select pg_temp.dyn_complete(%L::jsonb)',v_binding),'55000');
	perform public.qorpera_terminalize_runner_attempt((v_binding ->> 'jobId')::uuid,'failed','Turn ended without a decision',false);
	perform pg_temp.wake_assert((select status from public.qorpera_wake_occurrences where id = v_wake.id) in ('failed','requires_review'),
		'Fixture: the undecided run ended');
	for v_attempt in 2..6 loop
		perform public.qorpera_drain_company_file_wakes(8);
		v_wake := pg_temp.dyn_pending('retry-watch');
		perform pg_temp.wake_assert(v_wake.occurrence_key = 'once:1:' || v_attempt,'Attempt ' || v_attempt || ' is restored');
		v_waits := v_waits || date_trunc('minute',v_wake.not_before - statement_timestamp() + interval '30 seconds');
		-- Each later attempt ends too, refused at admission for an unrelated reason.
		update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
			blocked_reason = 'Fixture refusal' where id = v_wake.id;
	end loop;
	perform pg_temp.wake_assert(v_waits = array[interval '0',interval '0',interval '0',interval '15 minutes',interval '30 minutes'],
		'Three retries at once, then 15 and 30 minutes: ' || v_waits::text);
	perform public.qorpera_drain_company_file_wakes(8);
	v_wake := pg_temp.dyn_pending('retry-watch');
	perform pg_temp.wake_assert(v_wake.occurrence_key = 'once:1:7' and v_wake.not_before > statement_timestamp() + interval '59 minutes',
		'It keeps trying, an hour later');
	-- Ten more ends: the wait stops growing at a day.
	for v_attempt in 8..17 loop
		update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
			blocked_reason = 'Fixture refusal' where id = v_wake.id;
		perform public.qorpera_drain_company_file_wakes(8);
		v_wake := pg_temp.dyn_pending('retry-watch');
	end loop;
	perform pg_temp.wake_assert(v_wake.occurrence_key = 'once:1:17'
		and v_wake.not_before between statement_timestamp() + interval '23 hours 59 minutes' and statement_timestamp() + interval '1 day 1 minute',
		'The wait tops out at a day and the routine never gives up');
end $$;

-- An account that cannot run unattended still suspends the routine after three
-- refusals and tells the member once; the tick then stops restoring it.
do $$
declare v_wake public.qorpera_wake_occurrences; v_row public.qorpera_cloud_routines; v_index integer;
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','auth-d1','routineKey','auth-dynamic',
		'title','Auth dynamic','intent','Look.','trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp()),
			'timeZone','UTC','replyPolicy','silent')));
	for v_index in 1..3 loop
		v_wake := pg_temp.dyn_pending('auth-dynamic');
		update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
			blocked_reason = 'Wake execution authority is unavailable' where id = v_wake.id;
		perform public.qorpera_drain_company_file_wakes(8);
	end loop;
	v_row := pg_temp.routine_row('auth-dynamic');
	perform pg_temp.wake_assert(v_row.status = 'paused' and v_row.pause_reason = 'authorization_failed'
		and pg_temp.dyn_pending('auth-dynamic') is null
		and (select count(*) from public.qorpera_member_notifications where kind = 'routine_suspended'
			and subject ->> 'routineId' = v_row.id::text) = 1,
		'Three authorization refusals suspend a dynamic routine and notify once');
end $$;

-- A change made elsewhere while a dynamic run works settles its decision: the
-- agent, in a member's conversation, moved the next run. A pause instead stops
-- the started run, as for any routine, and the tick does not restore a paused
-- routine. A new version cancels the older one's queued run at once.
do $$
declare v_wake public.qorpera_wake_occurrences; v_run uuid; v_binding jsonb; v_old public.qorpera_wake_occurrences;
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','moved-d1','routineKey','moved-elsewhere',
		'title','Moved elsewhere','intent','Look.','trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp()),
			'timeZone','UTC','replyPolicy','silent')));
	v_wake := pg_temp.dyn_pending('moved-elsewhere');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake.id);
	v_binding := pg_temp.dyn_start(v_run);
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','moved-d2','routineKey','moved-elsewhere',
		'title','Moved elsewhere','intent','Look on Monday.','trigger',jsonb_build_object('kind','once',
			'at',pg_temp.iso(statement_timestamp() + interval '3 days'),'timeZone','UTC','replyPolicy','silent')));
	perform pg_temp.wake_assert(pg_temp.dyn_decide(v_binding,'{"action":"next","operationKey":"n","at":"2030-01-01T00:00:00.000Z"}')
		->> 'state' = 'settled' and (pg_temp.dyn_pending('moved-elsewhere')).routine_version = 2,
		'A routine moved on elsewhere owes no decision, and keeps the next run set there');
	perform pg_temp.wake_assert(pg_temp.dyn_complete(v_binding) ->> 'status' = 'completed','The run completes without one');

	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','pause-d1','routineKey','paused-dynamic',
		'title','Paused dynamic','intent','Look.','trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp()),
			'timeZone','UTC','replyPolicy','silent')));
	v_wake := pg_temp.dyn_pending('paused-dynamic');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake.id);
	v_binding := pg_temp.dyn_start(v_run);
	perform pg_temp.routine('{"action":"pause","operationKey":"pause-d2","routineKey":"paused-dynamic"}');
	perform pg_temp.wake_error(format('select pg_temp.dyn_decide(%L::jsonb,%L::jsonb)',v_binding,
		'{"action":"conclude","operationKey":"c","summary":"x"}'),'42501');
	perform public.qorpera_terminalize_runner_attempt((v_binding ->> 'jobId')::uuid,'failed','Paused mid-run',false);
	perform public.qorpera_drain_company_file_wakes(8);
	perform pg_temp.wake_assert(pg_temp.dyn_pending('paused-dynamic') is null,'A paused routine is not restored');

	-- Supersession: moving the next run cancels the old one at once.
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','move-1','routineKey','moved-dynamic',
		'title','Moved','intent','Look.','trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp() + interval '3 days'),
			'timeZone','UTC')));
	v_old := pg_temp.dyn_pending('moved-dynamic');
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','move-2','routineKey','moved-dynamic',
		'title','Moved','intent','Look.','trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp() + interval '1 day'),
			'timeZone','UTC')));
	perform pg_temp.wake_assert((select status = 'cancelled' and blocked_reason = 'Superseded by a newer version'
		from public.qorpera_wake_occurrences where id = v_old.id)
		and (select count(*) from public.qorpera_wake_occurrences wake join public.qorpera_cloud_routines routine on routine.id = wake.routine_id
			where routine.routine_key = 'moved-dynamic' and wake.status = 'queued') = 1,
		'Moving the next run leaves exactly one');
end $$;

-- Quiet hours hold a dynamic run; a next run past the routine's expiry is refused
-- with its reason, and the run can still conclude.
do $$
declare v_wake public.qorpera_wake_occurrences; v_run uuid; v_binding jsonb; v_refused jsonb;
	v_start text := to_char((statement_timestamp() at time zone 'UTC') - interval '1 hour','HH24:MI');
	v_end text := to_char((statement_timestamp() at time zone 'UTC') + interval '2 hours','HH24:MI');
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','quiet-d1','routineKey','quiet-dynamic',
		'title','Quiet dynamic','intent','Report.','quietHours',jsonb_build_object('start',v_start,'end',v_end,'timeZone','UTC'),
		'trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp()),'timeZone','UTC','replyPolicy','silent')));
	v_wake := pg_temp.dyn_pending('quiet-dynamic');
	perform pg_temp.wake_assert(to_char(v_wake.not_before at time zone 'UTC','HH24:MI') = v_end,
		'A dynamic run inside quiet hours waits for the end of the window');
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','exp-d1','routineKey','ending-dynamic',
		'title','Ending','intent','Look.','expiresAt',pg_temp.iso(statement_timestamp() + interval '3 hours'),
		'trigger',jsonb_build_object('kind','once','at',pg_temp.iso(statement_timestamp()),'timeZone','UTC','replyPolicy','silent')));
	v_wake := pg_temp.dyn_pending('ending-dynamic');
	perform public.qorpera_materialize_wake_execution_runs(8);
	v_run := pg_temp.routine_run(v_wake.id);
	v_binding := pg_temp.dyn_start(v_run);
	v_refused := pg_temp.dyn_decide(v_binding,jsonb_build_object('action','next','operationKey','past-end',
		'at',pg_temp.iso(statement_timestamp() + interval '5 hours')));
	perform pg_temp.wake_assert(v_refused ->> 'state' = 'refused' and v_refused ->> 'reason' like 'The routine ends at %',
		'A next run past the expiry is refused with the reason');
	perform pg_temp.dyn_decide(v_binding,'{"action":"conclude","operationKey":"end-now","summary":"Nothing left before the end date."}');
	perform pg_temp.wake_assert(pg_temp.dyn_complete(v_binding) ->> 'status' = 'completed'
		and (pg_temp.routine_row('ending-dynamic')).status = 'concluded','The run concludes instead and completes');
end $$;

-- The observation vocabulary knows the new tool.
select pg_temp.wake_assert(prosrc like '%''manage_routine'',''decide_routine'',''report_work''%','decide_routine is an observed operation')
from pg_proc where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure;

rollback;
