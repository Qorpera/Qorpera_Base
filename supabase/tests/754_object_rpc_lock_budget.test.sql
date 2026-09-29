-- @fixture 602_runtime_coding_lock_order.test.sql until "-- 1. The owner answers"
-- Object gateway RPCs wait at most 2 s for a lock (20260929630000_object_rpc_lock_budget). The gateway gives each
-- call 5 s and, when one runs out, refuses every company for its cooldown; so one company's held fence must end its
-- own calls first, with lock_not_available (55P03), which the gateway answers as that company's conflict. A third
-- connection holds company A's profile fence (602's path gateway company) while one call runs to its end:
-- - A's replication and member object calls, entered as PostgREST enters them, end at 2 s with 55P03;
-- - company B's replication calls land at once meanwhile;
-- - the same replication call entered any other way (Supabase Storage's replica insert guard, a direct SQL caller)
--   keeps its own budget;
-- - a native object call first takes the fence inside the lease validator (lock_timeout 25s): it ends at 2 s once
--   the fence honours qorpera.company_fence_wait (20260929380000), and keeps the validator's budget before that.
-- The calling connection's own budgets stand in for the role's 8 s: lock_timeout 3500ms, statement_timeout 4500ms.

-- Company B, with one stored object each for A and B (fixture bytes only, as in 270 and 608).
insert into auth.users(id,email) values ('75400000-0000-4000-8000-000000000001','budget-owner@example.test');
do $$
declare v_company jsonb;
begin
	perform set_config('request.jwt.claims','{"role":"authenticated","sub":"75400000-0000-4000-8000-000000000001","email":"budget-owner@example.test"}',true);
	v_company := public.qorpera_create_cloud_company('75400000-0000-4000-8000-000000000010','Budget company',2);
	perform set_config('qorpera_test.budget_b',v_company ->> 'profile_id',false);
end $$;
select set_config('qorpera_test.budget_a','30000000-0000-4000-8000-000000000010',false);
insert into storage.objects(bucket_id,name,metadata)
select 'qorpera-profile-objects',profile_id || '/' || repeat('7',64),'{"size":"5"}'
from unnest(array[current_setting('qorpera_test.budget_a'),current_setting('qorpera_test.budget_b')]) profile_id;
-- Both companies' fence rows exist before a holder takes one.
select public.qorpera_lock_profile_gc_fence(profile_id::uuid)
from unnest(array[current_setting('qorpera_test.budget_a'),current_setting('qorpera_test.budget_b')]) profile_id;

-- The holder keeps company A's fence while one call runs to its own end: its outcome and how long it took.
-- p_path is request.path as PostgREST (or Storage) sets it; null leaves it unset, as for a direct SQL caller.
create function pg_temp.budget_wait_out(p_path text, p_call text, p_claims jsonb) returns jsonb language plpgsql as $$
declare v_started timestamptz; v_elapsed double precision; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', 'reset role');
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', format('select 1 from (select public.qorpera_lock_profile_gc_fence(%L)) held',
		current_setting('qorpera_test.budget_a'))) as held(held integer);
	perform pg_temp.lock_as('lock_first', p_claims);
	perform dblink_exec('lock_first', 'set lock_timeout = ''3500ms''');
	perform dblink_exec('lock_first', 'set statement_timeout = ''4500ms''');
	if p_path is null then perform dblink_exec('lock_first', 'reset request.path');
	else perform dblink_exec('lock_first', format('set request.path = %L', p_path)); end if;
	v_started := clock_timestamp();
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..400 loop
		exit when dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	v_elapsed := extract(epoch from clock_timestamp() - v_started) * 1000;
	perform dblink_exec('lock_holder', 'rollback');
	v_outcome := pg_temp.lock_collect('lock_first');
	perform dblink_exec('lock_first', 'reset request.path');
	perform dblink_exec('lock_first', 'reset lock_timeout');
	perform dblink_exec('lock_first', 'reset statement_timeout');
	return v_outcome || jsonb_build_object('elapsedMs', round(v_elapsed));
end
$$;
-- The holder keeps company A's fence for p_ms while one call runs, then lets go: whether the call was still waiting
-- for it then, and its outcome after.
create function pg_temp.budget_released_after(p_path text, p_call text, p_claims jsonb, p_ms integer) returns jsonb language plpgsql as $$
declare v_waiting boolean; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', 'reset role');
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', format('select 1 from (select public.qorpera_lock_profile_gc_fence(%L)) held',
		current_setting('qorpera_test.budget_a'))) as held(held integer);
	perform pg_temp.lock_as('lock_first', p_claims);
	perform dblink_exec('lock_first', 'set lock_timeout = ''3500ms''');
	perform dblink_exec('lock_first', 'set statement_timeout = ''4500ms''');
	perform dblink_exec('lock_first', format('set request.path = %L', p_path));
	perform dblink_send_query('lock_first', p_call);
	perform pg_sleep(p_ms / 1000.0);
	v_waiting := dblink_is_busy('lock_first') = 1
		and cardinality(pg_blocking_pids(current_setting('qorpera_test.lock_first_pid')::integer)) > 0;
	perform dblink_exec('lock_holder', 'rollback');
	v_outcome := pg_temp.lock_collect('lock_first');
	perform dblink_exec('lock_first', 'reset request.path');
	perform dblink_exec('lock_first', 'reset lock_timeout');
	perform dblink_exec('lock_first', 'reset statement_timeout');
	return v_outcome || jsonb_build_object('waitingAfterMs', case when v_waiting then p_ms end);
end
$$;
create function pg_temp.budget_replication(p_function text, p_company text) returns text language sql as $$
	select format('select to_jsonb(public.%I(%L, %L, 5))', p_function, current_setting('qorpera_test.budget_' || p_company), repeat('7', 64))
$$;
create function pg_temp.budget_ended_at_2s(p_outcome jsonb, p_message text) returns void language plpgsql as $$
begin
	perform pg_temp.wake_assert(p_outcome ->> 'state' = '55P03' and p_outcome ->> 'error' like '%lock timeout%'
		and (p_outcome ->> 'elapsedMs')::integer between 1900 and 3300, p_message || ' ends at 2 s: ' || p_outcome::text);
end
$$;

-- 0. The entry point decides: the seven object RPCs' paths, with or without the API prefix; nothing else. Each of
--    them sets the budget first. The helper is internal.
do $$
declare v_path text; v_function text;
begin
	foreach v_path in array array['/rpc/qorpera_confirm_profile_object_replica', '/rest/v1/rpc/qorpera_authorize_native_company_object_upload',
		'/rpc/qorpera_authorize_member_company_snapshot_object'] loop
		perform set_config('request.path', v_path, true);
		perform set_config('lock_timeout', '8s', true);
		perform set_config('qorpera.company_fence_wait', '', true);
		perform public.qorpera_object_rpc_lock_budget();
		perform pg_temp.wake_assert(current_setting('lock_timeout') = '2s' and current_setting('qorpera.company_fence_wait') = '2s',
			'An object RPC sets its 2 s budget: ' || v_path);
	end loop;
	foreach v_path in array array['', '/rpc/qorpera_native_office_capture', '/rpc/qorpera_authorize_profile_object_download',
		'/storage/v1/object/qorpera-profile-objects/' || current_setting('qorpera_test.budget_a') || '/' || repeat('7', 64),
		'/rpc/qorpera_confirm_profile_object_replica?x=1', '/other/rpc/qorpera_confirm_profile_object_replica'] loop
		perform set_config('request.path', v_path, true);
		perform set_config('lock_timeout', '8s', true);
		perform set_config('qorpera.company_fence_wait', '', true);
		perform public.qorpera_object_rpc_lock_budget();
		perform pg_temp.wake_assert(current_setting('lock_timeout') = '8s' and current_setting('qorpera.company_fence_wait') = '',
			'Any other entry keeps its own budget: ' || v_path);
	end loop;
	perform set_config('request.path', '', true);
	foreach v_function in array array['qorpera_authorize_native_company_object_upload(jsonb,uuid,text,bigint)',
		'qorpera_confirm_native_company_object_upload(jsonb,uuid,text,bigint)', 'qorpera_authorize_native_company_object_download(jsonb,uuid,text)',
		'qorpera_authorize_member_company_path_object(uuid,text,uuid,text)', 'qorpera_authorize_member_company_snapshot_object(uuid,text,uuid,text)',
		'qorpera_authorize_profile_object_replication(uuid,text,bigint)', 'qorpera_confirm_profile_object_replica(uuid,text,bigint)'] loop
		perform pg_temp.wake_assert(pg_get_functiondef(('public.' || v_function)::regprocedure)
			~ '\nbegin\n(\tif public\.qorpera_company_is_folder_v2\([^\n]*\n)?\tperform public\.qorpera_object_rpc_lock_budget\(\);\n',
			v_function || ' sets the budget before its first lock');
	end loop;
	perform pg_temp.wake_assert(not has_function_privilege(role_name, 'public.qorpera_object_rpc_lock_budget()', 'EXECUTE'),
		'Only the object RPCs set their budget: ' || role_name)
	from unnest(array['anon','authenticated','service_role']) role_name;
end
$$;

-- 1. Replication. While another connection holds company A's fence, A's replication calls end at 2 s; company B's
--    land at once; the same call entered through Storage (the replica insert guard) or directly waits out the
--    connection's own 3.5 s.
do $$
declare v_outcome jsonb; v_service jsonb := '{"role":"service_role"}';
begin
	v_outcome := pg_temp.budget_wait_out('/rest/v1/rpc/qorpera_authorize_profile_object_replication',
		pg_temp.budget_replication('qorpera_authorize_profile_object_replication', 'a'), v_service);
	perform pg_temp.budget_ended_at_2s(v_outcome, 'A''s replication authorization');
	v_outcome := pg_temp.budget_wait_out('/rpc/qorpera_confirm_profile_object_replica',
		pg_temp.budget_replication('qorpera_confirm_profile_object_replica', 'a'), v_service);
	perform pg_temp.budget_ended_at_2s(v_outcome, 'A''s replica confirmation');
	v_outcome := pg_temp.budget_wait_out('/rest/v1/rpc/qorpera_authorize_profile_object_replication',
		pg_temp.budget_replication('qorpera_authorize_profile_object_replication', 'b'), v_service);
	perform pg_temp.wake_assert(v_outcome -> 'result' = 'true'::jsonb and (v_outcome ->> 'elapsedMs')::integer < 1000,
		'B''s replication lands while A''s fence is held: ' || v_outcome::text);
	v_outcome := pg_temp.budget_wait_out('/rpc/qorpera_confirm_profile_object_replica',
		pg_temp.budget_replication('qorpera_confirm_profile_object_replica', 'b'), v_service);
	perform pg_temp.wake_assert(v_outcome -> 'result' = 'true'::jsonb and (v_outcome ->> 'elapsedMs')::integer < 1000,
		'B''s replica confirmation lands while A''s fence is held: ' || v_outcome::text);
	v_outcome := pg_temp.budget_wait_out('/storage/v1/object/qorpera-profile-objects/' || current_setting('qorpera_test.budget_a') || '/' || repeat('7', 64),
		pg_temp.budget_replication('qorpera_authorize_profile_object_replication', 'a'), v_service);
	perform pg_temp.wake_assert(v_outcome ->> 'state' = '55P03' and (v_outcome ->> 'elapsedMs')::integer >= 3400,
		'Entered through Storage, the replication check keeps its own budget: ' || v_outcome::text);
	v_outcome := pg_temp.budget_wait_out(null, pg_temp.budget_replication('qorpera_authorize_profile_object_replication', 'a'), v_service);
	perform pg_temp.wake_assert(v_outcome ->> 'state' = '55P03' and (v_outcome ->> 'elapsedMs')::integer >= 3400,
		'A direct SQL caller keeps its own budget: ' || v_outcome::text);
end
$$;

-- 2. A member's object reads: the path actor takes the fence before it reads the path, so A's reads end at 2 s.
do $$
declare v_outcome jsonb; v_owner jsonb := '{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}';
begin
	v_outcome := pg_temp.budget_wait_out('/rest/v1/rpc/qorpera_authorize_member_company_path_object',
		format($q$select public.qorpera_authorize_member_company_path_object('30000000-0000-4000-8000-000000000020', 'budget.md', %L, %L)$q$,
			extensions.gen_random_uuid(), repeat('7', 64)), v_owner);
	perform pg_temp.budget_ended_at_2s(v_outcome, 'A member''s path object read');
	v_outcome := pg_temp.budget_wait_out('/rpc/qorpera_authorize_member_company_snapshot_object',
		format($q$select public.qorpera_authorize_member_company_snapshot_object('30000000-0000-4000-8000-000000000020', 'budget.md', %L, %L)$q$,
			extensions.gen_random_uuid(), repeat('7', 64)), v_owner);
	perform pg_temp.budget_ended_at_2s(v_outcome, 'A member''s snapshot object read');
end
$$;

-- 3. An agent's object staging takes the fence first inside the lease validator (lock_timeout 25s). With the fence
--    honouring qorpera.company_fence_wait it ends at 2 s; before that it keeps the validator's budget: still waiting
--    after 3 s, and it lands once the holder lets go. (It must not run into a statement timeout here: PL/pgSQL's
--    OTHERS does not catch 57014, so pg_temp.lock_collect could not report it.)
do $$
declare v_outcome jsonb;
	v_call text := format($q$select to_jsonb(public.qorpera_authorize_native_company_object_upload(%L::jsonb, %L, %L, 5))$q$,
		current_setting('qorpera_test.parent_binding'), current_setting('qorpera_test.budget_a'), repeat('7', 64));
begin
	if pg_get_functiondef('public.qorpera_lock_profile_gc_fence(uuid)'::regprocedure) like '%qorpera.company_fence_wait%' then
		v_outcome := pg_temp.budget_wait_out('/rest/v1/rpc/qorpera_authorize_native_company_object_upload', v_call, '{"role":"service_role"}');
		perform pg_temp.budget_ended_at_2s(v_outcome, 'An agent''s object staging');
	else
		v_outcome := pg_temp.budget_released_after('/rest/v1/rpc/qorpera_authorize_native_company_object_upload', v_call,
			'{"role":"service_role"}', 3000);
		perform pg_temp.wake_assert(v_outcome ->> 'waitingAfterMs' = '3000' and v_outcome -> 'result' = 'true'::jsonb,
			'Before the fence honours its wait, an agent''s object staging keeps the validator''s budget: ' || v_outcome::text);
	end if;
	-- Without a held fence the same call lands at once.
	perform dblink_exec('lock_first', 'set request.path = ''/rpc/qorpera_authorize_native_company_object_upload''');
	perform pg_temp.lock_as('lock_first', '{"role":"service_role"}');
	v_outcome := (select result from dblink('lock_first', v_call) as call(result jsonb));
	perform dblink_exec('lock_first', 'reset request.path');
	perform pg_temp.wake_assert(v_outcome = 'true'::jsonb, 'An agent''s object staging lands once the fence is free: ' || v_outcome::text);
end
$$;

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
