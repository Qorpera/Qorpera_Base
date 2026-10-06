-- @fixture 371_runtime_finite_routine_last_run.test.sql until "-- A one-time routine: its only occurrence"
-- Event wakes, step W2a (20260928269290): an agent's routine listens to a hook; verified
-- deliveries wake it once per burst through the real boundaries (the routine tool, the drain in
-- the materializer, admission, a runner lease and the wake reader); the run reads a whole event;
-- the batch fits the wake whatever the bodies; failed wakes back off and give up; pauses, filters,
-- unverified and old deliveries, removed hooks and company pauses hold.

-- Work other tests or the fixture left queued (a session turn, for one) never becomes a job this
-- test's materializer calls create beside its own, where the fixture's runner could claim it first.
set local session_replication_role = replica;
update public.qorpera_runner_jobs set dispatch_deferred_until = 'infinity', dispatch_refused_by = null
where status = 'queued';
update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
	blocked_reason = 'Set aside by test 731'
where profile_id <> '30000000-0000-4000-8000-000000000010' and status = 'queued';
set local session_replication_role = origin;

-- Starts a routine run and reads its wake (the binding is kept for the run's tools).
create function pg_temp.event_start(p_run uuid, p_binding jsonb default null) returns jsonb language plpgsql as $$
declare v_binding jsonb; v_identity jsonb; v_wake jsonb;
begin
	v_binding := coalesce(p_binding, pg_temp.wake_start(p_run));
	v_wake := public.qorpera_read_native_wake(v_binding);
	perform set_config('qorpera_test.event_binding', v_binding::text, true);
	perform set_config('qorpera_test.event_run', v_binding ->> 'runId', true);
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c',64),10);
	-- The same wake read again is the same batch.
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_binding) -> 'payload' = v_wake -> 'payload',
		'A second read of the wake returns the same batch');
	return v_wake;
end
$$;
-- Completes the started run silently.
create function pg_temp.event_finish() returns void language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.event_binding')::jsonb; v_job public.qorpera_runner_jobs%rowtype;
begin
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid;
	perform public.qorpera_complete_runner_job_v6((v_binding ->> 'runnerId')::uuid,repeat('2',64),v_job.id,repeat('3',64),
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),null,
		jsonb_build_object('schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
			'native_lease_id',v_binding ->> 'leaseId','substrate_version_id',v_job.substrate_version_id,
			'output_count',0,'output_bytes',0,'publication',null,
			'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2',
				'run_id',current_setting('qorpera_test.event_run')::uuid,
				'message_count',0,'final_message_id',null,'provider_session_id','event-wake-fixture'),
			'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
end
$$;
create function pg_temp.event_run(p_run uuid) returns jsonb language plpgsql as $$
declare v_wake jsonb;
begin
	v_wake := pg_temp.event_start(p_run);
	perform pg_temp.event_finish();
	return v_wake;
end
$$;
create function pg_temp.post(p_body text, p_type text default null, p_address text default repeat('E', 43)) returns text language sql as $$
	select public.qorpera_receive_event(p_address, 'application/json',
		jsonb_strip_nulls(jsonb_build_object('x-qorpera-event', p_type)), encode(convert_to(p_body, 'UTF8'), 'base64')) ->> 'outcome'
$$;
create function pg_temp.event_wakes(p_routine uuid) returns setof public.qorpera_wake_occurrences language sql as $$
	-- scheduled_for is the first delivery's arrival: distinct and in order, unlike created_at within one statement.
	select * from public.qorpera_wake_occurrences where routine_id = p_routine and source_kind = 'event' order by scheduled_for, id
$$;

-- Hooks: one of this company, one of another company.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('30000000-0000-4000-8000-0000000007a0', 'Other hook company', '30000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('30000000-0000-4000-8000-0000000007a1', '30000000-0000-4000-8000-0000000007a0', 'Environment', 1, '30000000-0000-4000-8000-000000000001');
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address) values
	('30000000-0000-4000-8000-0000000007b1', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000020',
		'forms', 'Website form', 'address', repeat('E', 43)),
	('30000000-0000-4000-8000-0000000007b2', '30000000-0000-4000-8000-0000000007a0', '30000000-0000-4000-8000-0000000007a1',
		'elsewhere', 'Another company', 'address', repeat('F', 43));
update public.qorpera_event_intake_settings set enabled = true;

-- The trigger: valid shapes only, hooks of the agent's own company only.
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-x1","routineKey":"ev-x","title":"t","intent":"i",
	"trigger":{"kind":"listener","source":"event","hookId":"not-a-uuid","timeZone":"UTC","replyPolicy":"silent"}}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-x2","routineKey":"ev-x","title":"t","intent":"i",
	"trigger":{"kind":"listener","source":"event","hookId":"30000000-0000-4000-8000-0000000007b1","only":[],"timeZone":"UTC"}}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-x3","routineKey":"ev-x","title":"t","intent":"i",
	"trigger":{"kind":"listener","source":"event","hookId":"30000000-0000-4000-8000-0000000007b1","path":"x","timeZone":"UTC"}}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-x4","routineKey":"ev-x","title":"t","intent":"i",
	"trigger":{"kind":"listener","source":"event","hookId":"30000000-0000-4000-8000-0000000007b2","timeZone":"UTC","replyPolicy":"silent"}}')$q$,'42501');
-- One spelling of a hook id, and each event type once.
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-x5","routineKey":"ev-x","title":"t","intent":"i",
	"trigger":{"kind":"listener","source":"event","hookId":"30000000-0000-4000-8000-0000000007B1","timeZone":"UTC"}}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-x6","routineKey":"ev-x","title":"t","intent":"i",
	"trigger":{"kind":"listener","source":"event","hookId":"30000000-0000-4000-8000-0000000007b1","only":["a.b","a.b"],"timeZone":"UTC"}}')$q$,'22023');

-- A routine on the form hook; nothing wakes it before a delivery.
do $$
declare v_row public.qorpera_cloud_routines;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"ev-1","routineKey":"form-reply","title":"Answer the form",
		"intent":"Answer each form submission.","trigger":{"kind":"listener","source":"event",
		"hookId":"30000000-0000-4000-8000-0000000007b1","timeZone":"UTC","replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('form-reply');
	perform pg_temp.wake_assert(v_row.status = 'active' and (select active and hook_id = '30000000-0000-4000-8000-0000000007b1'
		from public.qorpera_event_listener_cursors where routine_id = v_row.id and routine_version = v_row.current_version),
		'The listener has an active cursor on its hook');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert(not exists (select 1 from pg_temp.event_wakes(v_row.id)), 'Nothing wakes before a delivery');
end $$;

-- A burst of three deliveries wakes the routine once; the run reads all three as outside content.
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.routine_row('form-reply'); v_wake jsonb; v_occurrence public.qorpera_wake_occurrences;
begin
	perform pg_temp.wake_assert(pg_temp.post('{"name":"Ada"}', 'contact.submitted') = 'accepted'
		and pg_temp.post('{"name":"Grace"}', 'newsletter.joined') = 'accepted'
		and pg_temp.post('{"name":"Linus"}', 'contact.submitted') = 'accepted', 'The deliveries are accepted');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = 1, 'A burst wakes the routine once');
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id);
	perform pg_temp.wake_assert(v_occurrence.status = 'materialized' and v_occurrence.wake_kind = 'routine'
		and v_occurrence.source_id = '30000000-0000-4000-8000-0000000007b1'
		and v_occurrence.occurrence_key like 'event:' || v_row.current_version || ':agent:%:1'
		and v_occurrence.payload ->> 'hookId' = '30000000-0000-4000-8000-0000000007b1',
		'The occurrence is a routine wake from the hook');
	v_wake := pg_temp.event_start(v_occurrence.run_id);
	perform pg_temp.wake_assert(v_wake #>> '{source,kind}' = 'event' and v_wake #>> '{routine,intent}' = 'Answer each form submission.'
		and v_wake #>> '{payload,hook,name}' = 'forms' and jsonb_array_length(v_wake #> '{payload,events}') = 3
		and v_wake #>> '{payload,events,0,text}' = '{"name":"Ada"}' and v_wake #>> '{payload,events,0,type}' = 'contact.submitted'
		and v_wake #>> '{payload,events,0,encoding}' = 'utf8' and (v_wake #>> '{payload,events,0,truncated}')::boolean = false
		and v_wake #>> '{payload,events,2,text}' = '{"name":"Linus"}' and (v_wake #>> '{payload,more}')::integer = 0,
		'The run reads the three events in order: ' || (v_wake -> 'payload')::text);
	-- read_event gives the whole body; it serves only this company's verified deliveries.
	perform pg_temp.wake_assert(public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
		jsonb_build_object('deliveryId', v_wake #>> '{payload,events,1,deliveryId}')) ->> 'text' = '{"name":"Grace"}',
		'read_event returns the body');
	perform pg_temp.wake_assert(public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
		jsonb_build_object('deliveryId', v_wake #>> '{payload,events,1,deliveryId}', 'offset', 3)) ->> 'text' = 'ame":"Grace"}',
		'read_event reads from an offset');
	-- Live hooks of the agent's own company; addresses because an owner requested the run, and the
	-- full URL once the intake's public origin is set.
	insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address, status, removed_at)
	values ('30000000-0000-4000-8000-0000000007b3', '30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020', 'gone', 'Removed', 'address', repeat('G', 43), 'removed', clock_timestamp());
	update public.qorpera_event_intake_settings set public_url = 'https://intake.example.test';
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_list_agent_event_hooks(
		current_setting('qorpera_test.event_binding')::jsonb) -> 'hooks') = 1
		and public.qorpera_list_agent_event_hooks(current_setting('qorpera_test.event_binding')::jsonb) #>> '{hooks,0,address}' = repeat('E', 43)
		and public.qorpera_list_agent_event_hooks(current_setting('qorpera_test.event_binding')::jsonb) #>> '{hooks,0,url}'
			= 'https://intake.example.test/functions/v1/event-intake/' || repeat('E', 43),
		'Agents list their own company''s live hooks with addresses');
	-- A run a contributor requested lists the hooks without addresses (the founder guard set aside).
	set local session_replication_role = replica;
	update public.qorpera_profile_members set role = 'contributor'
	where profile_id = '30000000-0000-4000-8000-000000000010'
		and user_id = (select requested_by_user_id from public.qorpera_execution_runs
			where id = current_setting('qorpera_test.event_run')::uuid);
	perform pg_temp.wake_assert(not (public.qorpera_list_agent_event_hooks(current_setting('qorpera_test.event_binding')::jsonb)
		-> 'hooks' -> 0 ?| array['address', 'path', 'url']), 'A contributor''s run lists hooks without addresses');
	update public.qorpera_profile_members set role = 'owner'
	where profile_id = '30000000-0000-4000-8000-000000000010'
		and user_id = (select requested_by_user_id from public.qorpera_execution_runs
			where id = current_setting('qorpera_test.event_run')::uuid);
	set local session_replication_role = origin;
end $$;
select pg_temp.wake_assert(pg_temp.post('{"name":"Elsewhere"}', null, repeat('F', 43)) = 'accepted', 'The other company takes a delivery');
select pg_temp.wake_error(format($q$select public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
	'{"deliveryId":"%s"}')$q$, (select id from public.qorpera_event_deliveries where hook_id = '30000000-0000-4000-8000-0000000007b2')), '42501');
select pg_temp.wake_error($q$select public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
	'{"deliveryId":"30000000-0000-4000-8000-0000000007ff"}')$q$, '42501');
select pg_temp.wake_error($q$select public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
	'{"deliveryId":"x"}')$q$, '22023');
select pg_temp.wake_error($q$select public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
	'{"deliveryId":"30000000-0000-4000-8000-0000000007ff","extra":1}')$q$, '22023');
select pg_temp.event_finish();

-- A later delivery wakes it again, with only that one; a filtered listener made now sees only new
-- events of its types.
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.routine_row('form-reply'); v_filtered public.qorpera_cloud_routines;
	v_wake jsonb; v_occurrence public.qorpera_wake_occurrences; v_index integer;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"ev-2","routineKey":"newsletter","title":"Welcome subscribers",
		"intent":"Welcome each new subscriber.","trigger":{"kind":"listener","source":"event",
		"hookId":"30000000-0000-4000-8000-0000000007b1","only":["newsletter.joined"],"timeZone":"UTC","replyPolicy":"silent"}}');
	v_filtered := pg_temp.routine_row('newsletter');
	perform pg_temp.wake_assert(pg_temp.post('{"name":"Margaret"}', 'contact.submitted') = 'accepted', 'A fourth delivery is accepted');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = 2
		and not exists (select 1 from pg_temp.event_wakes(v_filtered.id)),
		'The unfiltered listener wakes again; the filtered one ignores other types and earlier events');
	perform pg_temp.wake_assert((select taken_before > '-infinity' from public.qorpera_event_listener_cursors
		where routine_id = v_filtered.id), 'What a filtered listener skips moves its watermark');
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) offset 1;
	v_wake := pg_temp.event_run(v_occurrence.run_id);
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,events}') = 1
		and v_wake #>> '{payload,events,0,text}' = '{"name":"Margaret"}', 'The second wake carries only the new event');
	-- A subscriber wakes both routines; each run reads it once, in whichever order the queue gives.
	perform pg_temp.wake_assert(pg_temp.post('{"name":"Barbara"}', 'newsletter.joined') = 'accepted', 'A subscriber arrives');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_filtered.id)) = 1
		and (select count(*) from pg_temp.event_wakes(v_row.id)) = 3, 'The subscriber wakes both routines');
	for v_index in 1..2 loop
		v_wake := pg_temp.event_run(null);
		perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,events}') = 1
			and v_wake #>> '{payload,events,0,type}' = 'newsletter.joined'
			and v_wake #>> '{payload,events,0,text}' = '{"name":"Barbara"}'
			and v_wake #>> '{routine,id}' in (v_row.id::text, v_filtered.id::text),
			'Each routine reads the subscriber once');
	end loop;
end $$;

-- 22 deliveries at once: a wake takes at most 20 and says how many wait; the rest wake the
-- routine again.
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.routine_row('form-reply'); v_wake jsonb; v_occurrence public.qorpera_wake_occurrences;
begin
	perform pg_temp.post('{"n":' || n || '}', 'contact.submitted') from generate_series(1, 22) as n;
	-- They arrived ten minutes ago, so after the first read the watermark must stop at the first one
	-- still waiting, not a minute behind the clock.
	update public.qorpera_event_deliveries set received_at = received_at - interval '10 minutes',
		verified_at = verified_at - interval '10 minutes'
	where hook_id = '30000000-0000-4000-8000-0000000007b1' and convert_from(body, 'UTF8') ~ '^\{"n":[0-9]+\}$';
	update public.qorpera_event_listener_cursors set activated_at = activated_at - interval '20 minutes',
		taken_before = '-infinity' where routine_id = v_row.id;
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) where payload ->> 'firstDeliveryId' = (
		select id::text from public.qorpera_event_deliveries where body = convert_to('{"n":1}', 'UTF8'));
	v_wake := pg_temp.event_run(v_occurrence.run_id);
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,events}') = 20
		and v_wake #>> '{payload,events,0,text}' = '{"n":1}'
		and (v_wake #>> '{payload,more}')::integer = 2, 'A wake takes at most 20 and says how many wait');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) where payload ->> 'firstDeliveryId' = (
		select id::text from public.qorpera_event_deliveries where body = convert_to('{"n":21}', 'UTF8'));
	v_wake := pg_temp.event_run(v_occurrence.run_id);
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,events}') = 2
		and v_wake #>> '{payload,events,1,text}' = '{"n":22}'
		and (v_wake #>> '{payload,more}')::integer = 0, 'The leftovers wake the routine again');
end $$;

-- A paused routine takes no wake, and a resume starts from now; a paused company inserts nothing.
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.routine_row('form-reply'); v_before bigint;
begin
	select count(*) into v_before from pg_temp.event_wakes(v_row.id);
	perform pg_temp.routine('{"action":"pause","operationKey":"ev-p1","routineKey":"form-reply"}');
	perform pg_temp.wake_assert(pg_temp.post('{"during":"pause"}', 'contact.submitted') = 'accepted', 'A delivery during the pause');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.routine('{"action":"resume","operationKey":"ev-r1","routineKey":"form-reply"}');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = v_before,
		'A paused routine takes no wake, and its resume skips what arrived meanwhile');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_execution_pause(v_row.profile_id, true, 'test pause');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(pg_temp.post('{"during":"company pause"}', 'contact.submitted') = 'accepted', 'A delivery during the company pause');
	perform public.qorpera_drain_event_wakes(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = v_before,
		'A paused company inserts no event wake');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_execution_pause(v_row.profile_id, false, 'test resume');
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_drain_event_wakes(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id) where status = 'queued') = 1,
		'After the company pause the waiting delivery wakes the routine');
end $$;

-- A removed hook cancels its queued wake at admission and wakes nothing more; the materializer
-- keeps working.
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.routine_row('form-reply'); v_occurrence public.qorpera_wake_occurrences;
	v_count bigint;
begin
	update public.qorpera_event_hooks set status = 'removed', removed_at = statement_timestamp()
	where id = '30000000-0000-4000-8000-0000000007b1';
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) where blocked_reason is not null;
	perform pg_temp.wake_assert(v_occurrence.status = 'cancelled'
		and v_occurrence.blocked_reason = 'Wake recipient or source authority is unavailable',
		'A wake from a removed hook is cancelled');
	select count(*) into v_count from pg_temp.event_wakes(v_row.id);
	perform public.qorpera_materialize_wake_execution_runs(8);
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set created_at = created_at - interval '2 hours' where routine_id = v_row.id;
	set local session_replication_role = origin;
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = v_count,
		'A removed hook wakes nothing more');
	perform pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-3","routineKey":"after-removal","title":"t",
		"intent":"i","trigger":{"kind":"listener","source":"event","hookId":"30000000-0000-4000-8000-0000000007b1",
		"timeZone":"UTC","replyPolicy":"silent"}}')$q$, '42501');
end $$;

-- A second hook for what follows, so no earlier listener shares its deliveries.
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address) values
	('30000000-0000-4000-8000-0000000007b4', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000020',
		'large', 'Large and retried events', 'address', repeat('H', 43));

-- Bodies of any kind fit the wake beside a long intent: multibyte text, control characters that
-- JSON escapes six bytes each, and plain text. read_event serves the rest in pieces that fit a
-- tool result.
do $$
declare v_row public.qorpera_cloud_routines; v_wake jsonb; v_occurrence public.qorpera_wake_occurrences; v_piece jsonb;
	v_rest jsonb; v_control text;
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','ev-s1','routineKey','sizes',
		'title','Large events','intent',repeat('Handle large events carefully. ', 1050),
		'trigger',jsonb_build_object('kind','listener','source','event','hookId','30000000-0000-4000-8000-0000000007b4',
			'only',jsonb_build_array('size.test'),'timeZone','UTC','replyPolicy','silent')));
	v_row := pg_temp.routine_row('sizes');
	perform pg_temp.wake_assert(pg_temp.post(repeat(U&'\+01F600', 9000), 'size.test', repeat('H', 43)) = 'accepted'
		and pg_temp.post(repeat(chr(1), 9000) || 'end', 'size.test', repeat('H', 43)) = 'accepted'
		and pg_temp.post(repeat('a', 9000), 'size.test', repeat('H', 43)) = 'accepted', 'Three large deliveries are accepted');
	perform public.qorpera_materialize_wake_execution_runs(8);
	-- A wake whose job has not started is still pending, however long ago it was made.
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set created_at = created_at - interval '2 hours' where routine_id = v_row.id;
	set local session_replication_role = origin;
	perform public.qorpera_drain_event_wakes(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id);
	v_wake := pg_temp.event_start(v_occurrence.run_id);
	perform pg_temp.wake_assert(octet_length((v_wake -> 'payload')::text) <= 49152 and pg_column_size(v_wake) <= 49152
		and jsonb_array_length(v_wake #> '{payload,events}') = 3
		and (select bool_and((event ->> 'truncated')::boolean) from jsonb_array_elements(v_wake #> '{payload,events}') as e(event)),
		'The batch fits the wake, its bodies cut: ' || octet_length((v_wake -> 'payload')::text));
	v_control := (select id::text from public.qorpera_event_deliveries where hook_id = '30000000-0000-4000-8000-0000000007b4'
		and body = convert_to(repeat(chr(1), 9000) || 'end', 'UTF8'));
	v_piece := public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
		jsonb_build_object('deliveryId', v_control));
	perform pg_temp.wake_assert(octet_length(to_jsonb(v_piece ->> 'text')::text) <= 32768
		and (v_piece ->> 'done')::boolean = false and (v_piece ->> 'next')::integer between 1 and 9002
		and (v_piece ->> 'total')::integer = 9003, 'A piece of escaped text fits a tool result: ' || (v_piece - 'text' - 'headers')::text);
	v_rest := public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
		jsonb_build_object('deliveryId', v_control, 'offset', (v_piece ->> 'next')::integer));
	perform pg_temp.wake_assert((v_rest ->> 'done')::boolean and not v_rest ? 'next'
		and (v_piece ->> 'text') || (v_rest ->> 'text') = repeat(chr(1), 9000) || 'end', 'The next piece completes the body');
	perform pg_temp.event_finish();
end $$;

-- Only verified deliveries wake and can be read, and none older than 7 days.
do $$
declare v_row public.qorpera_cloud_routines; v_wake jsonb; v_occurrence public.qorpera_wake_occurrences;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"ev-v1","routineKey":"verified-only","title":"Verified only",
		"intent":"Handle verified events.","trigger":{"kind":"listener","source":"event",
		"hookId":"30000000-0000-4000-8000-0000000007b4","only":["v.test"],"timeZone":"UTC","replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('verified-only');
	update public.qorpera_event_listener_cursors set activated_at = clock_timestamp() - interval '9 days'
	where routine_id = v_row.id;
	insert into public.qorpera_event_deliveries(id, hook_id, profile_id, received_at, status, delivery_key, event_type,
		body, body_bytes, body_sha256, verified_at) values
		('30000000-0000-4000-8000-0000000007c1', '30000000-0000-4000-8000-0000000007b4', '30000000-0000-4000-8000-000000000010',
			clock_timestamp() - interval '8 days', 'verified', 'old-1', 'v.test', '\x7b7d', 2, repeat('0', 64),
			clock_timestamp() - interval '8 days'),
		('30000000-0000-4000-8000-0000000007c2', '30000000-0000-4000-8000-0000000007b4', '30000000-0000-4000-8000-000000000010',
			clock_timestamp(), 'received', null, 'v.test', '\x7b7d', 2, repeat('1', 64), null);
	perform pg_temp.wake_assert(pg_temp.post('{"v":1}', 'v.test', repeat('H', 43)) = 'accepted' and pg_temp.post('{"v":1}', 'v.test', repeat('H', 43)) = 'duplicate',
		'A delivery and its duplicate');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id);
	v_wake := pg_temp.event_start(v_occurrence.run_id);
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,events}') = 1
		and v_wake #>> '{payload,events,0,text}' = '{"v":1}' and (v_wake #>> '{payload,more}')::integer = 0,
		'Only the verified, recent delivery wakes the routine: ' || (v_wake -> 'payload')::text);
	perform pg_temp.wake_error(format($q$select public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
		'{"deliveryId":"%s"}')$q$, (select id from public.qorpera_event_deliveries
			where hook_id = '30000000-0000-4000-8000-0000000007b4' and status = 'duplicate' and event_type = 'v.test')), '42501');
	perform pg_temp.wake_error($q$select public.qorpera_read_agent_event(current_setting('qorpera_test.event_binding')::jsonb,
		'{"deliveryId":"30000000-0000-4000-8000-0000000007c2"}')$q$, '42501');
	-- Folder companies take event wakes with routine files since E2a (20260930061000); 913 covers their gate.
	perform pg_temp.event_finish();
end $$;

-- A wake that ends without taking its deliveries is tried again after 1, 4, 16 and 64 minutes; after
-- five tries the first delivery is left behind and the next one wakes the routine.
do $$
declare v_row public.qorpera_cloud_routines; v_try integer; v_first uuid;
begin
	perform pg_temp.routine('{"action":"upsert","operationKey":"ev-t1","routineKey":"retry","title":"Retry",
		"intent":"Handle retried events.","trigger":{"kind":"listener","source":"event",
		"hookId":"30000000-0000-4000-8000-0000000007b4","only":["retry.test"],"timeZone":"UTC","replyPolicy":"silent"}}');
	v_row := pg_temp.routine_row('retry');
	perform pg_temp.wake_assert(pg_temp.post('{"try":1}', 'retry.test', repeat('H', 43)) = 'accepted', 'A delivery to retry');
	v_first := (select id from public.qorpera_event_deliveries where hook_id = '30000000-0000-4000-8000-0000000007b4'
		and event_type = 'retry.test');
	perform public.qorpera_drain_event_wakes(8);
	for v_try in 1..5 loop
		perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = v_try
			and exists (select 1 from pg_temp.event_wakes(v_row.id) where status = 'queued'
				and occurrence_key like '%:' || v_first || ':' || v_try),
			'Try ' || v_try || ' of the first delivery is queued');
		set local session_replication_role = replica;
		update public.qorpera_wake_occurrences set created_at = created_at - interval '2 hours' where routine_id = v_row.id;
		set local session_replication_role = origin;
		perform public.qorpera_drain_event_wakes(8);
		perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = v_try,
			'A queued try is pending');
		set local session_replication_role = replica;
		update public.qorpera_wake_occurrences set created_at = created_at + interval '2 hours' where routine_id = v_row.id;
		update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
			blocked_reason = 'Cancelled by test 731' where routine_id = v_row.id and status = 'queued';
		set local session_replication_role = origin;
		perform public.qorpera_drain_event_wakes(8);
		perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = v_try,
			'A failed try is not repeated at once');
		if v_try >= 2 then
			-- Two minutes are enough after the first failure only.
			set local session_replication_role = replica;
			update public.qorpera_wake_occurrences set created_at = created_at - interval '2 minutes' where routine_id = v_row.id;
			set local session_replication_role = origin;
			perform public.qorpera_drain_event_wakes(8);
			perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = v_try,
				'Try ' || v_try || ' waits longer than the one before');
		end if;
		set local session_replication_role = replica;
		update public.qorpera_wake_occurrences set created_at = created_at - interval '2 hours' where routine_id = v_row.id;
		set local session_replication_role = origin;
		perform public.qorpera_drain_event_wakes(8);
	end loop;
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = 5
		and exists (select 1 from public.qorpera_event_wake_deliveries as taken
			join public.qorpera_wake_occurrences as wake on wake.id = taken.occurrence_id
			where taken.routine_id = v_row.id and taken.delivery_id = v_first and wake.occurrence_key like '%:5'),
		'After five tries the first delivery is left behind');
	perform pg_temp.wake_assert(pg_temp.post('{"try":2}', 'retry.test', repeat('H', 43)) = 'accepted', 'A later delivery');
	perform public.qorpera_drain_event_wakes(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id) where status = 'queued'
		and occurrence_key like '%:1') = 1, 'The next delivery wakes the routine');
	-- Out of the way of the runs that follow.
	perform pg_temp.routine('{"action":"pause","operationKey":"ev-t2","routineKey":"retry"}');
end $$;

-- Long descriptions (types that JSON escapes, long content types) beside a long intent: the batch
-- takes only as many events as fit, its bodies share what the descriptions leave, and the rest wait.
do $$
declare v_row public.qorpera_cloud_routines; v_wake jsonb; v_occurrence public.qorpera_wake_occurrences; v_taken integer;
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','ev-d1','routineKey','descriptions',
		'title','Long descriptions','intent',repeat('Describe the events. ', 1500),
		'trigger',jsonb_build_object('kind','listener','source','event','hookId','30000000-0000-4000-8000-0000000007b4',
			'only',jsonb_build_array(repeat('"', 128)),'timeZone','UTC','replyPolicy','silent')));
	v_row := pg_temp.routine_row('descriptions');
	insert into public.qorpera_event_deliveries(hook_id, profile_id, status, delivery_key, event_type, content_type,
		body, body_bytes, body_sha256, verified_at)
	select '30000000-0000-4000-8000-0000000007b4', '30000000-0000-4000-8000-000000000010', 'verified', 'long-' || n,
		repeat('"', 128), repeat('c', 256), convert_to(repeat('b', 2000), 'UTF8'), 2000, repeat('0', 64), clock_timestamp()
	from generate_series(1, 20) as n;
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id);
	v_wake := pg_temp.event_start(v_occurrence.run_id);
	v_taken := jsonb_array_length(v_wake #> '{payload,events}');
	perform pg_temp.wake_assert(octet_length((v_wake -> 'payload')::text) <= 49152 and pg_column_size(v_wake) <= 49152
		and v_taken between 1 and 19 and (v_wake #>> '{payload,more}')::integer = 20 - v_taken,
		'The batch takes as many long descriptions as fit: ' || v_taken || ' of 20, '
			|| octet_length((v_wake -> 'payload')::text) || ' bytes');
	perform pg_temp.event_finish();
	-- The rest would wake it again; out of the way of the runs that follow.
	perform pg_temp.routine('{"action":"pause","operationKey":"ev-d2","routineKey":"descriptions"}');
end $$;

-- A binary body: base64 without line breaks, within the room the wake leaves, and read_event serves
-- it in pieces of 24 KiB that fit a tool result. A wake whose job is leased but not yet read stays
-- pending however long ago it was made.
do $$
declare v_row public.qorpera_cloud_routines; v_wake jsonb; v_occurrence public.qorpera_wake_occurrences; v_binding jsonb;
	v_piece jsonb; v_offset integer := 0; v_pieces integer := 0; v_data bytea := ''; v_body bytea := decode(repeat('ff00', 30000), 'hex');
begin
	perform pg_temp.routine(jsonb_build_object('action','upsert','operationKey','ev-b1','routineKey','binary',
		'title','Binary','intent',repeat('Handle it. ', 2000),
		'trigger',jsonb_build_object('kind','listener','source','event','hookId','30000000-0000-4000-8000-0000000007b4',
			'only',jsonb_build_array('bin.test'),'timeZone','UTC','replyPolicy','silent')));
	v_row := pg_temp.routine_row('binary');
	perform pg_temp.wake_assert(public.qorpera_receive_event(repeat('H', 43), 'application/octet-stream',
		'{"x-qorpera-event":"bin.test"}', encode(v_body, 'base64')) ->> 'outcome' = 'accepted', 'A binary delivery is accepted');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id);
	v_binding := pg_temp.wake_start(v_occurrence.run_id);
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set created_at = created_at - interval '2 hours' where routine_id = v_row.id;
	set local session_replication_role = origin;
	perform public.qorpera_drain_event_wakes(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = 1, 'A leased, unread wake is pending');
	v_wake := pg_temp.event_start(v_occurrence.run_id, v_binding);
	perform pg_temp.wake_assert(octet_length((v_wake -> 'payload')::text) <= 49152
		and v_wake #>> '{payload,events,0,encoding}' = 'base64' and (v_wake #>> '{payload,events,0,truncated}')::boolean
		and octet_length(v_wake #>> '{payload,events,0,data}') between 1 and 8192
		and position(chr(10) in v_wake #>> '{payload,events,0,data}') = 0,
		'The binary body is cut base64 without line breaks: ' || octet_length((v_wake -> 'payload')::text));
	loop
		v_piece := public.qorpera_read_agent_event(v_binding, jsonb_build_object('deliveryId',
			v_wake #>> '{payload,events,0,deliveryId}', 'offset', v_offset));
		v_pieces := v_pieces + 1;
		perform pg_temp.wake_assert(v_piece ->> 'encoding' = 'base64' and octet_length(v_piece ->> 'data') <= 32768
			and position(chr(10) in v_piece ->> 'data') = 0 and (v_piece ->> 'total')::integer = 60000
			and ((v_piece ->> 'done')::boolean or (v_piece ->> 'next')::integer = v_offset + 24576),
			'A binary piece fits a tool result: ' || (v_piece - 'data' - 'headers')::text);
		v_data := v_data || decode(v_piece ->> 'data', 'base64');
		exit when (v_piece ->> 'done')::boolean or v_pieces > 3;
		v_offset := (v_piece ->> 'next')::integer;
	end loop;
	perform pg_temp.wake_assert(v_pieces = 3 and v_data = v_body, 'Three pieces make the whole binary body');
	-- The run has read its batch, so a new delivery wakes the routine again while it works.
	perform pg_temp.wake_assert(public.qorpera_receive_event(repeat('H', 43), 'application/octet-stream',
		'{"x-qorpera-event":"bin.test"}', encode('\x0102'::bytea, 'base64')) ->> 'outcome' = 'accepted', 'A second binary delivery');
	perform public.qorpera_drain_event_wakes(8);
	perform pg_temp.wake_assert((select count(*) from pg_temp.event_wakes(v_row.id)) = 2,
		'A wake that read its batch does not hold back the next');
	-- However little room the rest of a wake leaves, its batch takes the first delivery.
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) where status = 'queued';
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_event_wake_payload(v_occurrence, 10) -> 'events') = 1,
		'A batch always takes its first delivery');
	perform pg_temp.event_finish();
	perform pg_temp.routine('{"action":"pause","operationKey":"ev-b2","routineKey":"binary"}');
end $$;

-- A routine version saved outside the agent's tool (a member's save) cannot listen to another
-- company's hook: its activation refuses it.
select pg_temp.wake_error($q$insert into public.qorpera_cloud_routine_versions
	select * from jsonb_populate_record(null::public.qorpera_cloud_routine_versions, (
		select to_jsonb(saved) || jsonb_build_object('version', saved.version + 1,
			'client_version_id', extensions.gen_random_uuid(), 'triggers', jsonb_build_array(jsonb_build_object(
				'id', 'agent', 'kind', 'listener', 'source', 'event', 'hookId', '30000000-0000-4000-8000-0000000007b2',
				'timeZone', 'UTC', 'replyPolicy', 'silent')))
		from public.qorpera_cloud_routine_versions as saved join public.qorpera_cloud_routines as routine
			on routine.id = saved.routine_id and routine.current_version = saved.version
		where routine.routine_key = 'retry' and routine.origin = 'agent'))$q$, '42501');

-- Privileges: the new tables are closed; the drain, the reader and the tools belong to service_role.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_event_listener_cursors', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_event_wake_deliveries', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Event wake tables are exposed to %', v_role; end if;
		if has_function_privilege(v_role, 'public.qorpera_event_wake_payload(public.qorpera_wake_occurrences,integer)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_event_body_view(bytea,integer)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_event_json_prefix(text,integer)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_event_wake_item(public.qorpera_event_deliveries)', 'EXECUTE') then
			raise exception 'A private event wake helper is exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_drain_event_wakes(integer)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_read_agent_event(jsonb,jsonb)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_list_agent_event_hooks(jsonb)', 'EXECUTE') then
			raise exception 'An event wake function is exposed to %', v_role; end if;
	end loop;
	if not has_function_privilege('service_role', 'public.qorpera_read_agent_event(jsonb,jsonb)', 'EXECUTE') then
		raise exception 'read_event lost its caller'; end if;
	if position('perform public.qorpera_drain_event_wakes(p_limit);' in
		pg_get_functiondef('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure)) = 0 then
		raise exception 'The materializer does not drain event wakes'; end if;
end
$$;

rollback;
