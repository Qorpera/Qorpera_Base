-- @fixture 602_runtime_coding_lock_order.test.sql until "-- 1. The owner answers"
-- Readers of a company share its profile fence (20260929380000_company_fence_shared_readers). A call that
-- entered through a reader RPC (PostgREST's request.path) takes the company's profile row, wake admission row
-- and Company File row FOR SHARE; every other call takes them as before. Two agents of 602's path gateway
-- company, each with its own run, show it with real calls on separate connections: a third connection holds
-- one call's transaction open while another call runs. Readers no longer wait for readers; a writer, object GC
-- and the founder's stop still wait for a reader, and a reader for them; writers still exclude each other; a
-- reader nested in a writer keeps the writer's exclusive fence. Then the lock budgets: a reader's wait for the
-- fence ends at 1500 ms, the Company File write path's at 2 s (under the lease validator's own 25 s), with
-- lock_not_available.

-- A second agent of the company with its own run and native binding (scripts/load-company-fence-pool.sql makes
-- its load agents the same way).
create function pg_temp.fence_agent(p_staff uuid, p_name text) returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_session uuid := extensions.gen_random_uuid();
	v_input uuid := extensions.gen_random_uuid(); v_run uuid := extensions.gen_random_uuid(); v_job uuid;
	v_resource public.qorpera_company_path_resources%rowtype; v_binding jsonb;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('service_role');
	insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
		employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
	select profile_id,p_staff,p_name,role,charter,appearance_color,appearance_shape,employment_status,lifecycle_state,
		model_provider,model_id,created_at,updated_at,updated_by_user_id from public.qorpera_profile_staff
	where profile_id = v_base.profile_id and staff_agent_id = '30000000-0000-4000-8000-000000000030';
	update public.qorpera_shared_sessions set status = 'closed'
	where profile_id = v_base.profile_id and staff_agent_id = p_staff::text and status = 'open';
	insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
		created_by_user_id,staff_agent_id,staff_version,execution_scope)
	select v_session,extensions.gen_random_uuid(),v_base.profile_id,v_base.environment_id,p_name,'open',
		'30000000-0000-4000-8000-000000000001',p_staff::text,staff.version,'{}'
	from public.qorpera_profile_staff staff
	where staff.profile_id = v_base.profile_id and staff.staff_agent_id = p_staff;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	select * into strict v_resource from public.qorpera_company_path_resources where environment_id = v_base.environment_id and path = '';
	perform public.qorpera_grant_company_path(v_resource.id,v_resource.version,'staff_agent',p_staff,array['read','write']);
	perform public.qorpera_configure_session_execution(v_session,v_base.sponsor_binding_id,1,null,'agent_turn','agent_turn');
	perform pg_temp.path_claims('service_role');
	insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
	values (v_input,v_session,extensions.gen_random_uuid(),'kickoff','30000000-0000-4000-8000-000000000001',
		'{"schema":"qorpera.staff-kickoff/v1"}');
	insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
		required_capability,job_type,payload,created_by_user_id)
	values(v_base.profile_id,v_base.environment_id,v_session,v_base.substrate_version_id,
		v_run,'agent_turn','agent_turn','{}',v_base.requested_by_user_id) returning id into v_job;
	insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
		substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
		required_capability,job_type,payload_sha256,compute_identity_id,transcript_start_sequence,created_by_user_id)
	select v_run,v_base.profile_id,v_base.environment_id,'session_turn',v_run,v_session,v_job,
		v_base.substrate_version_id,v_base.company_snapshot_id,p_staff,staff.version,array[v_input],
		v_base.sponsor_binding_id,v_base.sponsor_version,'agent_turn','agent_turn',repeat('e',64),v_base.compute_identity_id,0,
		v_base.requested_by_user_id
	from public.qorpera_profile_staff staff where staff.profile_id = v_base.profile_id and staff.staff_agent_id = p_staff;
	update public.qorpera_runner_jobs set run_id = v_run where id = v_job;
	if not public.qorpera_reserve_execution_sponsor_authority(v_run) then
		raise exception 'Fixture: the sponsor refused a run for %', p_name; end if;
	update public.qorpera_session_inputs set execution_run_id = v_run where id = v_input and execution_run_id is null;
	perform public.qorpera_append_execution_input_events(v_session,array[v_input]);
	insert into public.qorpera_execution_run_events(run_id,event_type) values(v_run,'queued');
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_public_send(v_binding,'progress','ack-' || p_staff);
	perform public.qorpera_assert_wake_work_allowed(v_run);
	return v_binding;
end
$$;
select set_config('qorpera_test.second_binding',
	pg_temp.fence_agent('74200000-0000-4000-8000-000000000031','Fence reader')::text,false);

-- request.path as PostgREST sets it on a connection, and as nothing sets it for a direct SQL caller.
create function pg_temp.fence_path(p_connection text, p_rpc text) returns void language plpgsql as $$
begin
	if p_rpc is null then perform dblink_exec(p_connection, 'reset request.path');
	else perform dblink_exec(p_connection, format('set request.path = %L', '/rpc/' || p_rpc)); end if;
end
$$;
-- The holder runs a whole call and keeps its transaction open: what that call locked stays locked.
create function pg_temp.fence_holder(p_rpc text) returns void language plpgsql as $$
begin
	perform dblink_exec('lock_holder', 'reset role');
	perform dblink_exec('lock_holder', format('set request.jwt.claims = %L', '{"role":"service_role"}'));
	perform pg_temp.fence_path('lock_holder', p_rpc);
end
$$;
-- Calls, each as one statement returning one jsonb value.
create function pg_temp.fence_describe(p_binding text) returns text language sql as $$
	select format('select public.qorpera_describe_native_tool_authority(%L::jsonb)', p_binding)
$$;
create function pg_temp.fence_read_set(p_binding text) returns text language sql as $$
	select format($q$select to_jsonb(true) from public.qorpera_assert_company_path_reads('30000000-0000-4000-8000-000000000020', %L::jsonb, '{}')$q$, p_binding)
$$;
create function pg_temp.fence_list(p_binding text) returns text language sql as $$
	select format($q$select public.qorpera_list_company_paths_v2('30000000-0000-4000-8000-000000000020', '', null, null, 10, %L::jsonb)$q$, p_binding)
$$;
-- An acting tool's receipt, begun and completed (a run holds one unresolved operation at most).
create function pg_temp.fence_receipt(p_binding text, p_key text) returns text language sql as $$
	select format($q$with begun as materialized (select public.qorpera_begin_native_tool_operation(%1$L::jsonb, %3$L, %2$L, repeat('a', 64),
		repeat('b', 64), false) as receipt) select public.qorpera_complete_native_tool_operation(%1$L::jsonb, %3$L, repeat('a', 64), '{}'::jsonb)
		from begun$q$, p_binding, p_key, extensions.gen_random_uuid())
$$;
-- The same calls as a holder's query, which returns one integer.
create function pg_temp.fence_hold(p_call text) returns text language sql as $$
	select format('select 1 from (%s) call', p_call)
$$;
-- The holder holds a call; the first connection sends another and it either waits (and lands after the holder
-- lets go) or does not. As pg_temp.lock_single, with each connection's request.path.
create function pg_temp.fence_single(p_hold_rpc text, p_hold text, p_rpc text, p_call text,
	p_claims jsonb default '{"role":"service_role"}') returns jsonb language plpgsql as $$
declare v_outcome jsonb;
begin
	perform pg_temp.fence_holder(p_hold_rpc);
	perform pg_temp.fence_path('lock_first', p_rpc);
	v_outcome := pg_temp.lock_single(pg_temp.fence_hold(p_hold), p_call, p_claims);
	perform pg_temp.fence_path('lock_holder', null);
	perform pg_temp.fence_path('lock_first', null);
	return v_outcome;
end
$$;
-- The holder keeps holding until the call ends on its own: its outcome and how long it waited.
create function pg_temp.fence_wait_out(p_hold_rpc text, p_hold text, p_rpc text, p_call text) returns jsonb language plpgsql as $$
declare v_started timestamptz; v_elapsed double precision; v_outcome jsonb;
begin
	perform pg_temp.fence_holder(p_hold_rpc);
	perform pg_temp.fence_path('lock_first', p_rpc);
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', pg_temp.fence_hold(p_hold)) as held(held integer);
	perform pg_temp.lock_as('lock_first', '{"role":"service_role"}');
	v_started := clock_timestamp();
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..400 loop
		exit when dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	v_elapsed := extract(epoch from clock_timestamp() - v_started) * 1000;
	perform dblink_exec('lock_holder', 'rollback');
	v_outcome := pg_temp.lock_collect('lock_first');
	perform pg_temp.fence_path('lock_holder', null);
	perform pg_temp.fence_path('lock_first', null);
	return v_outcome || jsonb_build_object('elapsedMs', round(v_elapsed));
end
$$;

-- 0. The entry point decides: a reader RPC's path, with or without the API prefix; nothing else.
do $$
declare v_path text;
begin
	perform pg_temp.wake_assert(not public.qorpera_company_fence_shared(), 'A direct SQL call is not a reader');
	perform set_config('request.path', '/rpc/qorpera_describe_native_tool_authority', true);
	perform pg_temp.wake_assert(public.qorpera_company_fence_shared(), 'The tool authority is a reader');
	perform set_config('request.path', '/rest/v1/rpc/qorpera_assert_company_path_reads', true);
	perform pg_temp.wake_assert(public.qorpera_company_fence_shared(), 'The read-set check is a reader');
	-- The one-call context fence (20260929400000) makes the first three readers' calls in one transaction.
	perform set_config('request.path', '/rpc/qorpera_fence_native_context', true);
	perform pg_temp.wake_assert(public.qorpera_company_fence_shared(), 'The one-call context fence is a reader');
	perform set_config('request.path', '/rest/v1/rpc/qorpera_fence_native_context', true);
	perform pg_temp.wake_assert(public.qorpera_company_fence_shared(), 'The one-call context fence is a reader under /rest/v1');
	foreach v_path in array array['/rpc/qorpera_commit_company_path_mutation', '/rpc/qorpera_begin_native_tool_operation',
		'/rpc/qorpera_validate_native_provider_execution_lease',
		-- Supabase Storage sets request.path to its own URL, query string included.
		'/object/qorpera-profile-objects/30000000-0000-4000-8000-000000000010/abc?x=/rpc/qorpera_read_company_path',
		'/object/some-bucket/folder/rpc/qorpera_list_company_paths',
		'/upload/resumable/abc?cb=/rpc/qorpera_describe_native_tool_authority',
		'/storage/v1/object/rpc/qorpera_read_company_path_v2', 'rpc/qorpera_read_company_path_v2',
		'/rpc/qorpera_describe_native_tool_authority_x', '/rpc/qorpera_describe_native_tool_authority/', '/qorpera_read_company_path_v2',
		'/rpc/qorpera_fence_native_context_x', '/object/b/abc?x=/rpc/qorpera_fence_native_context', ''] loop
		perform set_config('request.path', v_path, true);
		perform pg_temp.wake_assert(not public.qorpera_company_fence_shared(), 'Not a reader: ' || v_path);
	end loop;
	perform set_config('request.path', '', true);
end
$$;
do $$
declare v_config text[]; v_function regprocedure;
begin
	foreach v_function in array array['public.qorpera_lock_profile_gc_fence_shared(uuid)'::regprocedure,
		'public.qorpera_lock_company_file_shared(uuid)'::regprocedure] loop
		select proconfig into v_config from pg_catalog.pg_proc where oid = v_function;
		perform pg_temp.wake_assert('lock_timeout=1500ms' = any (v_config), v_function || ' waits 1500 ms: ' || v_config::text);
	end loop;
	foreach v_function in array array['public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_prepare_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text)'::regprocedure,
		'public.qorpera_native_company_file_write_source(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_native_company_file_write(uuid,jsonb,jsonb,jsonb,text,uuid,text)'::regprocedure] loop
		select proconfig into v_config from pg_catalog.pg_proc where oid = v_function;
		perform pg_temp.wake_assert(v_config @> array['lock_timeout=2s','qorpera.company_fence_wait=2s'],
			v_function || ' waits 2 s, the fence included: ' || v_config::text);
	end loop;
	select proconfig into v_config from pg_catalog.pg_proc
	where oid = 'public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure;
	perform pg_temp.wake_assert('lock_timeout=25s' = any (v_config), 'The lease validator keeps its own budget: ' || v_config::text);
end
$$;
-- The helpers are internal: no API role may call them. (This database has no default privileges for functions,
-- 070 pins that; production's Supabase defaults grant EXECUTE to these roles, which the migration revokes.)
do $$
declare v_function regprocedure; v_role text;
begin
	foreach v_function in array array['public.qorpera_company_fence_shared()'::regprocedure,
		'public.qorpera_lock_profile_gc_fence_shared(uuid)'::regprocedure, 'public.qorpera_lock_company_file_shared(uuid)'::regprocedure] loop
		foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
			perform pg_temp.wake_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'), v_role || ' cannot call ' || v_function);
		end loop;
	end loop;
end
$$;

-- 1. A reader holds the three rows FOR SHARE: another connection can share them but not take them.
do $$
declare v_probe text; v_outcome jsonb;
begin
	foreach v_probe in array array[
		'select 1 from public.qorpera_profiles where id = ''30000000-0000-4000-8000-000000000010'' for %s nowait',
		'select 1 from public.qorpera_company_wake_admission_fences where profile_id = ''30000000-0000-4000-8000-000000000010'' for %s nowait',
		'select 1 from public.qorpera_company_files where environment_id = ''30000000-0000-4000-8000-000000000020'' for %s nowait'] loop
		v_outcome := pg_temp.fence_single('qorpera_list_company_paths_v2', pg_temp.fence_list(current_setting('qorpera_test.parent_binding')),
			null, format('select to_jsonb(held) from (' || v_probe || ') held(held)', 'share'), '{"role":"postgres"}');
		perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'result' = '1',
			'A reader''s row can be shared: ' || v_probe || ' ' || v_outcome::text);
		v_outcome := pg_temp.fence_single('qorpera_list_company_paths_v2', pg_temp.fence_list(current_setting('qorpera_test.parent_binding')),
			null, format('select to_jsonb(held) from (' || v_probe || ') held(held)', 'no key update'), '{"role":"postgres"}');
		perform pg_temp.wake_assert(v_outcome ->> 'state' = '55P03',
			'A reader''s row cannot be taken for an update: ' || v_probe || ' ' || v_outcome::text);
	end loop;
end
$$;

-- 2. Readers do not wait for readers: one agent lists the Company File while the other checks its authority,
--    its read set and lists too. The same calls without a reader's path (a direct SQL caller) still queue.
do $$
declare v_call text; v_outcome jsonb; v_second text := current_setting('qorpera_test.second_binding');
begin
	foreach v_call in array array['qorpera_describe_native_tool_authority', 'qorpera_assert_company_path_reads',
		'qorpera_list_company_paths_v2'] loop
		v_outcome := pg_temp.fence_single('qorpera_list_company_paths_v2', pg_temp.fence_list(current_setting('qorpera_test.parent_binding')),
			v_call, case v_call when 'qorpera_describe_native_tool_authority' then pg_temp.fence_describe(v_second)
				when 'qorpera_assert_company_path_reads' then pg_temp.fence_read_set(v_second) else pg_temp.fence_list(v_second) end);
		perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome -> 'error' is null,
			v_call || ' does not wait for another agent''s read: ' || v_outcome::text);
	end loop;
	v_outcome := pg_temp.fence_single(null, pg_temp.fence_list(current_setting('qorpera_test.parent_binding')),
		null, pg_temp.fence_describe(v_second));
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome -> 'error' is null,
		'Outside a reader RPC the fence is exclusive, as before: ' || v_outcome::text);
end
$$;

-- 3. Writers still wait for readers, readers for writers, and writers for each other: an acting tool's receipt
--    (the exclusive fence) against the other agent's read.
do $$
declare v_outcome jsonb; v_first text := current_setting('qorpera_test.parent_binding'); v_second text := current_setting('qorpera_test.second_binding');
begin
	v_outcome := pg_temp.fence_single('qorpera_describe_native_tool_authority', pg_temp.fence_describe(v_first),
		'qorpera_begin_native_tool_operation', pg_temp.fence_receipt(v_second, 'fence-after-read'));
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome -> 'result' is not null and v_outcome -> 'error' is null,
		'A receipt waits for a reader, then lands: ' || v_outcome::text);
	v_outcome := pg_temp.fence_single('qorpera_begin_native_tool_operation', pg_temp.fence_receipt(v_first, 'fence-before-read'),
		'qorpera_describe_native_tool_authority', pg_temp.fence_describe(v_second));
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome -> 'error' is null,
		'A reader waits for a receipt, then lands: ' || v_outcome::text);
	v_outcome := pg_temp.fence_single('qorpera_begin_native_tool_operation', pg_temp.fence_receipt(v_first, 'fence-writer-1'),
		'qorpera_begin_native_tool_operation', pg_temp.fence_receipt(v_second, 'fence-writer-2'));
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome -> 'result' is not null and v_outcome -> 'error' is null,
		'Writers exclude each other: ' || v_outcome::text);
	-- The tool authority read inside a writer's transaction takes the writer's exclusive fence.
	v_outcome := pg_temp.fence_single('qorpera_begin_native_tool_operation', pg_temp.fence_describe(v_first),
		'qorpera_describe_native_tool_authority', pg_temp.fence_describe(v_second));
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome -> 'error' is null,
		'A reader nested in a writer keeps the exclusive fence: ' || v_outcome::text);
end
$$;

-- 4. Object GC still excludes readers. An object nothing references, a day old: GC's claim waits for a reader
--    and then leases it; while the lease lasts a read is refused (storage busy); after the deletion it reads.
do $$
declare v_sha text := repeat('7', 64);
begin
	perform pg_temp.path_claims('service_role');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/' || v_sha,'{"size":64}');
	perform set_config('session_replication_role','replica',true);
	update public.qorpera_profile_objects set created_at = created_at - interval '25 hours'
	where profile_id = '30000000-0000-4000-8000-000000000010' and sha256 = v_sha;
end
$$;
do $$
declare v_outcome jsonb; v_second text := current_setting('qorpera_test.second_binding');
begin
	v_outcome := pg_temp.fence_single('qorpera_list_company_paths_v2', pg_temp.fence_list(current_setting('qorpera_test.parent_binding')),
		'qorpera_claim_company_object_gc', 'select public.qorpera_claim_company_object_gc(1, ''74200000-0000-4000-8000-000000000010'')');
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome #>> '{result,objects,0,sha256}' = repeat('7', 64),
		'GC''s claim waits for a reader, then leases the object: ' || v_outcome::text);
	v_outcome := pg_temp.fence_single(null, 'select 1', 'qorpera_list_company_paths_v2', pg_temp.fence_list(v_second));
	perform pg_temp.wake_assert(v_outcome ->> 'error' like '%Company File storage is busy%',
		'A read during the GC lease is refused: ' || v_outcome::text);
	perform pg_temp.path_claims('service_role');
	delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name = '30000000-0000-4000-8000-000000000010/' || repeat('7', 64);
	perform public.qorpera_complete_company_object_gc('30000000-0000-4000-8000-000000000010','74200000-0000-4000-8000-000000000010',array[repeat('7', 64)]);
end
$$;
do $$
declare v_outcome jsonb;
begin
	-- GC's exclusive fence (no reader path) against a reader.
	v_outcome := pg_temp.fence_single(null, 'select public.qorpera_lock_profile_gc_fence(''30000000-0000-4000-8000-000000000010'')',
		'qorpera_list_company_paths_v2', pg_temp.fence_list(current_setting('qorpera_test.second_binding')));
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome -> 'error' is null,
		'A reader waits for GC''s fence, then reads: ' || v_outcome::text);
end
$$;

-- 5. The founder's stop waits for a reader in flight and lands; a reader after it sees the stop.
do $$
declare v_outcome jsonb;
begin
	perform pg_temp.fence_holder('qorpera_describe_native_tool_authority');
	perform pg_temp.fence_path('lock_first', 'qorpera_set_company_execution_pause');
	v_outcome := pg_temp.lock_single(pg_temp.fence_hold(pg_temp.fence_describe(current_setting('qorpera_test.parent_binding'))),
		'select public.qorpera_set_company_execution_pause(''30000000-0000-4000-8000-000000000010'', true, ''fence test'')',
		-- Internal since 20260924080000 (no member grant): the owner's call as the database owner runs it.
		'{"role":"postgres","sub":"30000000-0000-4000-8000-000000000001"}');
	perform pg_temp.fence_path('lock_holder', null);
	perform pg_temp.fence_path('lock_first', null);
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome #>> '{result,paused}' = 'true',
		'The stop waits for the reader, then lands: ' || v_outcome::text);
	v_outcome := pg_temp.fence_single(null, 'select 1', 'qorpera_describe_native_tool_authority',
		pg_temp.fence_describe(current_setting('qorpera_test.second_binding')));
	perform pg_temp.wake_assert(v_outcome ->> 'error' = 'Company execution is paused',
		'A reader after the stop sees it: ' || v_outcome::text);
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_execution_pause('30000000-0000-4000-8000-000000000010', false, null);
end
$$;

-- 6. Lock budgets. A reader waits 1500 ms for the fence another call holds and ends with lock_not_available;
--    the Company File write path 2 s, although the fence is taken inside the lease validator (25 s); an acting
--    tool's receipt, which is not on that path, still waits until the holder lets go.
do $$
declare v_outcome jsonb; v_second text := current_setting('qorpera_test.second_binding');
	v_hold text := 'select public.qorpera_lock_profile_gc_fence(''30000000-0000-4000-8000-000000000010'')';
begin
	v_outcome := pg_temp.fence_wait_out(null, v_hold, 'qorpera_describe_native_tool_authority', pg_temp.fence_describe(v_second));
	perform pg_temp.wake_assert(v_outcome ->> 'state' = '55P03' and v_outcome ->> 'error' like '%lock timeout%'
		and (v_outcome ->> 'elapsedMs')::integer between 1400 and 3500,
		'A reader''s wait for the fence ends at 1500 ms: ' || v_outcome::text);
	v_outcome := pg_temp.fence_wait_out(null, v_hold, 'qorpera_check_company_path_mutation',
		format($q$select public.qorpera_check_company_path_mutation('30000000-0000-4000-8000-000000000020', %L::jsonb,
			'{"schema":"qorpera.company-path-mutation/v1","operationKey":"fence-budget","path":"fence-budget.txt","expectedVersion":null,"entry":null}'::jsonb)$q$,
			v_second));
	perform pg_temp.wake_assert(v_outcome ->> 'state' = '55P03' and v_outcome ->> 'error' like '%lock timeout%'
		and (v_outcome ->> 'elapsedMs')::integer between 1900 and 4500,
		'The write path''s wait for the fence ends at 2 s: ' || v_outcome::text);
	v_outcome := pg_temp.fence_single(null, v_hold, 'qorpera_begin_native_tool_operation', pg_temp.fence_receipt(v_second, 'fence-budget'));
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome -> 'result' is not null and v_outcome -> 'error' is null,
		'A receipt keeps waiting for the fence: ' || v_outcome::text);
end
$$;

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
