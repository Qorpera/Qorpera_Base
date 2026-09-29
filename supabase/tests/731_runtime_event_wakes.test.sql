-- @fixture 371_runtime_finite_routine_last_run.test.sql until "-- A one-time routine: its only occurrence"
-- Event wakes, step W2a (20260929290000): an agent's routine listens to a hook; verified
-- deliveries wake it once per burst through the real boundaries (the routine tool, the drain in
-- the materializer, admission, a runner lease and the wake reader); the run reads a whole event;
-- pauses, filters, removed hooks and company pauses hold.

-- Work other tests left committed (360 commits through dblink) never competes with this test's
-- runs for the fixture's runner, however long after it this test runs.
set local session_replication_role = replica;
update public.qorpera_runner_jobs set dispatch_deferred_until = 'infinity', dispatch_refused_by = null
where profile_id <> '30000000-0000-4000-8000-000000000010' and status = 'queued';
set local session_replication_role = origin;

-- Starts a routine run and reads its wake (the binding is kept for the run's tools).
create function pg_temp.event_start(p_run uuid) returns jsonb language plpgsql as $$
declare v_binding jsonb; v_identity jsonb; v_wake jsonb;
begin
	v_binding := pg_temp.wake_start(p_run);
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
	select * from public.qorpera_wake_occurrences where routine_id = p_routine and source_kind = 'event' order by created_at, id
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
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_list_agent_event_hooks(
		current_setting('qorpera_test.event_binding')::jsonb) -> 'hooks') = 1
		and public.qorpera_list_agent_event_hooks(current_setting('qorpera_test.event_binding')::jsonb) #>> '{hooks,0,address}' = repeat('E', 43),
		'Agents list their own company''s hooks with addresses');
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
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) offset 3;
	v_wake := pg_temp.event_run(v_occurrence.run_id);
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,events}') = 20
		and v_wake #>> '{payload,events,0,text}' = '{"n":1}'
		and (v_wake #>> '{payload,more}')::integer = 2, 'A wake takes at most 20 and says how many wait');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) offset 4;
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

-- A removed hook cancels its queued wake at admission; the materializer keeps working.
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.routine_row('form-reply'); v_occurrence public.qorpera_wake_occurrences;
begin
	update public.qorpera_event_hooks set status = 'removed', removed_at = statement_timestamp()
	where id = '30000000-0000-4000-8000-0000000007b1';
	perform public.qorpera_materialize_wake_execution_runs(8);
	select * into strict v_occurrence from pg_temp.event_wakes(v_row.id) where blocked_reason is not null;
	perform pg_temp.wake_assert(v_occurrence.status = 'cancelled'
		and v_occurrence.blocked_reason = 'Wake recipient or source authority is unavailable',
		'A wake from a removed hook is cancelled');
	perform pg_temp.wake_error($q$select pg_temp.routine('{"action":"upsert","operationKey":"ev-3","routineKey":"after-removal","title":"t",
		"intent":"i","trigger":{"kind":"listener","source":"event","hookId":"30000000-0000-4000-8000-0000000007b1",
		"timeZone":"UTC","replyPolicy":"silent"}}')$q$, '42501');
end $$;

-- Privileges: the new tables are closed; the drain, the reader and the tools belong to service_role.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_event_listener_cursors', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_event_wake_deliveries', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Event wake tables are exposed to %', v_role; end if;
		if has_function_privilege(v_role, 'public.qorpera_event_wake_payload(public.qorpera_wake_occurrences)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_event_body_view(bytea,integer)', 'EXECUTE') then
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
