-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930487000 on 924's real native run of Alice's: the native host's describe (qorpera_describe_native_tool_authority
-- as the entry point) reads its run without the run mutex, through qorpera_folder_native_run_plain. Its answer and its
-- refusals are the locked run check's; the helper is the database owner's only and locks nothing; only describe calls
-- it. With the fixture committed (the harness of 793), another connection holds the run's budget row: describe through
-- the host answers at once, while a direct describe, the writers and the context fence still wait for the row, also
-- with request.path set to describe by hand. The timing is printed, not checked.
reset role;
select set_config('qorpera_test.j_token', 'j674-lease-token-0123456789abcdef', false);

-- A started run's job takes the known lease token, as 793 does.
create function pg_temp.j_token(p_binding jsonb) returns void language sql as $$
	update public.qorpera_runner_jobs
	set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.j_token'), 'utf8'), 'sha256'), 'hex')
	where id = (p_binding ->> 'jobId')::uuid
$$;
select pg_temp.j_token(current_setting('qorpera_test.base_binding')::jsonb);
-- A call's answer, or its refusal.
create function pg_temp.j_try(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	execute p_sql into v_result;
	return jsonb_build_object('result', v_result);
exception when others then
	return jsonb_build_object('state', sqlstate, 'error', sqlerrm);
end $$;
-- describe through the native host (its entry point, the job's token), and describe called directly.
create function pg_temp.j_host_sql(p_binding jsonb, p_token text default null) returns text language sql as $$
	select format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)', p_binding ->> 'jobId',
		coalesce(p_token, current_setting('qorpera_test.j_token')), 'qorpera_describe_native_tool_authority',
		jsonb_build_object('p_binding', p_binding))
$$;
create function pg_temp.j_describe_sql(p_binding jsonb) returns text language sql as $$
	select format('select public.qorpera_describe_native_tool_authority(%L::jsonb)', p_binding)
$$;
-- describe three ways in this transaction: through the host (the publishable key's role on the host's RPC path), as the
-- entry point by request.path (the plain read the host reaches), and by direct SQL with no request.path (the locked run
-- check).
create function pg_temp.j_three(p_binding jsonb) returns jsonb language plpgsql as $$
declare v_host jsonb; v_plain jsonb; v_locked jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
	v_host := pg_temp.j_try(pg_temp.j_host_sql(p_binding));
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.path', '/rpc/qorpera_describe_native_tool_authority', true);
	v_plain := pg_temp.j_try(pg_temp.j_describe_sql(p_binding));
	perform set_config('request.path', '', true);
	v_locked := pg_temp.j_try(pg_temp.j_describe_sql(p_binding));
	return jsonb_build_object('host', v_host, 'plain', v_plain, 'locked', v_locked);
end $$;
-- A refusal: the plain read refuses as the locked check does (SQLSTATE and message); the host answers the same, or
-- (p_host_refused) its entry point refuses first, as before.
create function pg_temp.j_refused(p_name text, p_binding jsonb, p_state text, p_host_refused boolean default false)
returns text language plpgsql as $$
declare v jsonb := pg_temp.j_three(p_binding);
	v_host jsonb := v -> 'locked';
begin
	if p_host_refused then v_host := '{"state":"42501","error":"native host call is refused"}'; end if;
	if v -> 'locked' ? 'result' or v #>> '{locked,state}' is distinct from p_state or v -> 'plain' is distinct from v -> 'locked'
		or v -> 'host' is distinct from v_host then
		raise exception '674 %: the plain and the locked run check refuse differently: %', p_name, v; end if;
	return format('%s: %s %s (host: %s)', p_name, v #>> '{locked,state}', v #>> '{locked,error}', v #>> '{host,error}');
end $$;
-- This transaction's calls of the plain read and the locked run check.
create function pg_temp.j_calls() returns bigint[] language sql as $$
	select array_agg(coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = n.name), 0)::bigint order by n.ordinal)
	from unnest(array['qorpera_folder_native_run_plain', 'qorpera_folder_tool_run']) with ordinality as n(name, ordinal)
$$;

-- 1. The helper is the database owner's only, names no budget row and takes no row lock; only describe calls it (this
--    test's own pg_temp functions aside).
do $$
declare v_helper pg_proc;
begin
	select * into strict v_helper from pg_proc where oid = 'public.qorpera_folder_native_run_plain(jsonb)'::regprocedure;
	if v_helper.proacl is null or exists (select 1 from aclexplode(v_helper.proacl) a where a.grantee <> v_helper.proowner)
		or exists (select 1 from unnest(array['public','anon','authenticated','service_role','qorpera_secret_broker']) r(name)
			where has_function_privilege(r.name, v_helper.oid, 'execute'))
		or not v_helper.prosecdef or v_helper.proconfig is distinct from array['search_path=""'] then
		raise exception 'The plain run check is not the owner''s only: % %', v_helper.proacl, v_helper.proconfig; end if;
	if v_helper.prosrc ~* 'qorpera_execution_run_budgets|for\s+(update|share|no\s+key\s+update|key\s+share)|nowait|skip\s+locked' then
		raise exception 'The plain run check names the budget row or locks a row'; end if;
	if (select array_agg(p.oid) from pg_proc p where p.prosrc like '%qorpera_folder_native_run_plain%' and p.oid <> v_helper.oid and p.pronamespace <> pg_my_temp_schema())
			is distinct from array['public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure::oid] then
		raise exception 'A function other than describe calls the plain run check: %', (select array_agg(p.oid::regprocedure)
			from pg_proc p where p.prosrc like '%qorpera_folder_native_run_plain%' and p.oid <> v_helper.oid and p.pronamespace <> pg_my_temp_schema()); end if;
end $$;

-- 2. With nothing holding the row, the three answers are one (jsonb =): through the host and as the entry point by
--    request.path describe reads plain, directly it takes the locked run check.
set local track_functions = 'all';
do $$
declare v_at bigint[] := pg_temp.j_calls(); v jsonb := pg_temp.j_three(current_setting('qorpera_test.base_binding')::jsonb);
	v_after bigint[] := pg_temp.j_calls();
begin
	if not (v -> 'locked' ? 'result') or v #>> '{locked,result,schema}' is distinct from 'qorpera.native-tool-authority/v1'
		or v -> 'host' is distinct from v -> 'locked' or v -> 'plain' is distinct from v -> 'locked' then
		raise exception 'describe answers differently through the host, plain and locked: %', v; end if;
	if array[v_after[1] - v_at[1], v_after[2] - v_at[2]] is distinct from array[2, 1]::bigint[] then
		raise exception 'describe did not read plain twice and lock once: % then %', v_at, v_after; end if;
end $$;
reset track_functions;

-- 3. The refusals, each undone after: the company's stop (55000); a finished job, a binding with another lease, a
--    company with no folder-v2 Company File, a removed room membership and a removed routine (42501); a wrong lease
--    token, which the host's entry point refuses before describe.
savepoint j_refusal;
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'j674');
select pg_temp.j_refused('paused', current_setting('qorpera_test.base_binding')::jsonb, '55000') as j_out \gset
\echo 674 refusal :j_out
rollback to savepoint j_refusal;

set local session_replication_role = replica;
update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
set local session_replication_role = origin;
select pg_temp.j_refused('finished job', current_setting('qorpera_test.base_binding')::jsonb, '42501', true) as j_out \gset
\echo 674 refusal :j_out
rollback to savepoint j_refusal;

select pg_temp.j_refused('another lease', current_setting('qorpera_test.base_binding')::jsonb
	|| jsonb_build_object('leaseId', extensions.gen_random_uuid()), '42501') as j_out \gset
\echo 674 refusal :j_out
rollback to savepoint j_refusal;

select pg_temp.base_assert(pg_temp.j_try(pg_temp.j_host_sql(current_setting('qorpera_test.base_binding')::jsonb,
	'a-wrong-token-0123456789abcdef')) = '{"state":"42501","error":"native host call is refused"}', 'A wrong token was not refused');
rollback to savepoint j_refusal;

set local session_replication_role = replica;
delete from public.qorpera_company_files where environment_id = '92400000-0000-4000-8000-000000000020';
set local session_replication_role = origin;
select pg_temp.j_refused('legacy environment', current_setting('qorpera_test.base_binding')::jsonb, '42501') as j_out \gset
\echo 674 refusal :j_out
rollback to savepoint j_refusal;

set local session_replication_role = replica;
delete from public.qorpera_company_room_members member using public.qorpera_execution_runs run
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
	and member.principal_kind = 'staff_agent' and member.principal_id = run.staff_agent_id
	and member.room_id in (select room.id from public.qorpera_company_rooms room where room.session_id = run.session_id);
set local session_replication_role = origin;
select pg_temp.j_refused('removed room membership', current_setting('qorpera_test.base_binding')::jsonb, '42501') as j_out \gset
\echo 674 refusal :j_out
rollback to savepoint j_refusal;

-- A routine of Bob's (as 924's section 9 makes one), started; then its routine row is removed.
create function pg_temp.j_rparse(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', p_id, 'title', 'Tick', 'status', 'active',
		'trigger', jsonb_build_object('when', 'every', 'minutes', 5, 'starts', null), 'timezone', null, 'ends', null,
		'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'optional', 'conclusion', null,
		'instructions', 'Examine the authorized change.')
$$;
select pg_temp.base_commit(pg_temp.base_owner(), 'j674-routine-tick', jsonb_build_array(
	pg_temp.base_write('agents/bob/routines/tick.md', 'routine',
		E'---\n' || pg_temp.j_rparse('92400000-0000-4000-8000-0000000006e1')::text || E'\n---\n',
		pg_temp.j_rparse('92400000-0000-4000-8000-0000000006e1'), pg_temp.base_version('agents/bob/routines/tick.md')))) \g /dev/null
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors; v_wake uuid := extensions.gen_random_uuid();
	v_at timestamptz := statement_timestamp() - interval '5 minutes'; v_run uuid; v_binding jsonb; v_three jsonb;
begin
	select c.* into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors c
	join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version
	where r.id = '92400000-0000-4000-8000-0000000006e1';
	perform public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, v_wake, 'j674-tick-1',
		v_cursor.trigger_id, v_at, v_cursor.last_scheduled_for, v_at + interval '5 minutes', '{}');
	perform pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake;
	v_binding := pg_temp.base_start(v_run);
	perform pg_temp.j_token(v_binding);
	perform set_config('qorpera_test.j_routine_binding', v_binding::text, true);
	v_three := pg_temp.j_three(v_binding);
	if not (v_three -> 'locked' ? 'result') or v_three -> 'host' is distinct from v_three -> 'locked'
		or v_three -> 'plain' is distinct from v_three -> 'locked' then
		raise exception 'The routine run''s describe answers differently: %', v_three; end if;
end $$;
set local session_replication_role = replica;
delete from public.qorpera_cloud_routines where id = '92400000-0000-4000-8000-0000000006e1';
set local session_replication_role = origin;
select pg_temp.j_refused('removed routine', current_setting('qorpera_test.j_routine_binding')::jsonb, '42501') as j_out \gset
\echo 674 refusal :j_out
rollback to savepoint j_refusal;
release savepoint j_refusal;

-- 4. The timing, on this machine with nothing else running (printed only): the run check locked (describe's run check
--    before this change) and plain, and describe through the host now and directly (locked), 40 times each. Describe
--    through the host before this change took about host - plain + locked.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_sql text; v_start timestamptz;
	v_locked double precision := 0; v_plain double precision := 0; v_host double precision := 0; v_direct double precision := 0;
	c_rounds constant integer := 40;
begin
	v_sql := pg_temp.j_host_sql(v_binding);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.path', '', true);
	for i in 1 .. c_rounds loop
		v_start := clock_timestamp();
		perform public.qorpera_native_tool_locked_run(v_binding);
		v_locked := v_locked + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		perform public.qorpera_folder_native_run_plain(v_binding);
		v_plain := v_plain + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		execute v_sql;
		v_host := v_host + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		perform public.qorpera_describe_native_tool_authority(v_binding);
		v_direct := v_direct + extract(epoch from clock_timestamp() - v_start);
	end loop;
	perform set_config('qorpera_test.j_ms', format('run check locked %s ms, plain %s ms; describe through the host %s ms '
		|| '(before this change about %s ms), directly (locked) %s ms; mean of %s', round((v_locked * 1000 / c_rounds)::numeric, 2),
		round((v_plain * 1000 / c_rounds)::numeric, 2), round((v_host * 1000 / c_rounds)::numeric, 2),
		round(((v_host - v_plain + v_locked) * 1000 / c_rounds)::numeric, 2), round((v_direct * 1000 / c_rounds)::numeric, 2),
		c_rounds), false);
end $$;
select current_setting('qorpera_test.j_ms') as j_ms \gset
\echo 674 timing: :j_ms

-- Alice's run records its native start and acknowledges its wake (as 998 does), so the fence below can answer.
select pg_temp.base_claims('service_role');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_identity jsonb;
begin
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	perform pg_temp.base_public_send(v_binding, 'progress', 'j674-ack');
end $$;

-- Row locks show only across connections, so 924's fixture is committed here and removed again at the end (the
-- harness of 793): the test refuses to run beside other connections to this database, whose rows the cleanup could
-- not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.base_binding','qorpera_test.j_token']) name;
select set_config('qorpera_test.j_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('j_holder', 'dbname=' || current_database());
select dblink_connect('j_caller', 'dbname=' || current_database());
select set_config('qorpera_test.j_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('j_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.j_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.j_holder_pid'), current_setting('qorpera_test.j_caller_pid'))) then
		raise exception 'The describe mutex test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.j_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table j_counts as select * from dblink('j_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table j_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.j_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.j_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.j_rows select v_table, kept.row_value
			from dblink('j_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.j_collect(p_connection text) returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result(p_connection) as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result(p_connection, false) as call(result jsonb);
	return v_outcome;
end
$$;
-- Whether the caller's call waited for a lock the holder holds before it finished (10 s at most).
create function pg_temp.j_waited() returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.j_caller_pid')::integer;
begin
	for attempt in 1..400 loop
		if current_setting('qorpera_test.j_holder_pid')::integer = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('j_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
-- At the end: remove what the test committed, as 793 does.
create function pg_temp.j_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.j_first_xid')::xid;
begin
	perform pg_temp.j_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['j_holder','j_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.j_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.j_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.j_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.j_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Describe mutex test cleanup left other row counts: %', v_wrong; end if;
end $$;
-- One call on the caller connection, in its own transaction, as the platform's service caller on p_path with a 1 s
-- lock_timeout, after p_setup: its answer or its error, and how long it took.
create function pg_temp.j_remote(p_path text, p_sql text, p_setup text default null) returns jsonb language plpgsql as $$
declare v_start timestamptz; v_outcome jsonb;
begin
	perform dblink_exec('j_caller', 'begin');
	perform * from dblink('j_caller', format($q$select set_config('request.jwt.claims', '{"role":"service_role"}', true),
		set_config('request.path', %L, true), set_config('lock_timeout', '1s', true)$q$, p_path)) as s(claims text, path text, timeout text);
	if p_setup is not null then perform dblink_exec('j_caller', p_setup); end if;
	v_start := clock_timestamp();
	perform dblink_send_query('j_caller', p_sql);
	v_outcome := pg_temp.j_collect('j_caller');
	perform dblink_exec('j_caller', 'rollback');
	return v_outcome || jsonb_build_object('ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric));
end $$;

-- 5. Another transaction holds the run's budget row (the run mutex), as a slow tool step does. describe through the
--    host (the publishable key's role on the host's RPC path) answers without waiting for it.
select dblink_exec('j_holder', 'begin');
select * from dblink('j_holder', format('select 1 from public.qorpera_execution_run_budgets where run_id = %L for update',
	current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')) as held(one integer);
do $$
declare v_start timestamptz; v_outcome jsonb;
begin
	perform dblink_exec('j_caller', 'begin');
	perform * from dblink('j_caller', $q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', '/rpc/qorpera_native_host_call', true)$q$) as c(claims text, path text);
	perform dblink_exec('j_caller', 'set local role anon');
	v_start := clock_timestamp();
	perform dblink_send_query('j_caller', pg_temp.j_host_sql(current_setting('qorpera_test.base_binding')::jsonb));
	if pg_temp.j_waited() then
		perform dblink_exec('j_holder', 'rollback');
		raise exception 'describe through the host waited for the run mutex: %', pg_temp.j_collect('j_caller'); end if;
	v_outcome := pg_temp.j_collect('j_caller');
	perform set_config('qorpera_test.j_held_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric)::text, false);
	perform dblink_exec('j_caller', 'rollback');
	if v_outcome #>> '{result,schema}' is distinct from 'qorpera.native-tool-authority/v1' then
		perform dblink_exec('j_holder', 'rollback');
		raise exception 'describe through the host did not answer: %', v_outcome; end if;
end $$;

-- 6. Still held: describe by direct SQL waits (55P03 under a 1 s lock_timeout). With request.path set to describe by
--    hand, describe itself reads plain, but nothing else does: a receipt, a context view and a function that calls
--    describe as its run check all still wait.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_path text := '/rpc/qorpera_describe_native_tool_authority';
	v_direct jsonb; v_plain jsonb; v_receipt jsonb; v_view jsonb; v_nested jsonb;
begin
	v_direct := pg_temp.j_remote('', pg_temp.j_describe_sql(v_binding));
	v_plain := pg_temp.j_remote(v_path, pg_temp.j_describe_sql(v_binding));
	v_receipt := pg_temp.j_remote(v_path, format('select to_jsonb(public.qorpera_begin_native_tool_operation(%L::jsonb, %L::uuid, %L, %L, %L, false))',
		v_binding, extensions.gen_random_uuid(), 'j674-operation', repeat('a', 64), repeat('b', 64)));
	v_view := pg_temp.j_remote(v_path, format('select to_jsonb(public.qorpera_record_native_context_view(%L::uuid, %L::jsonb, %L::jsonb))',
		'92400000-0000-4000-8000-000000000020', v_binding, jsonb_build_object('schema', 'qorpera.native-context-view/v1',
			'requestId', 'j674-view', 'threadId', 'thread-1', 'turnId', 'turn-1', 'purpose', 'turn', 'outputs', '[]'::jsonb)));
	v_nested := pg_temp.j_remote(v_path, format('select public.j674_nested(%L::jsonb)', v_binding),
		$f$create function public.j674_nested(p_binding jsonb) returns jsonb language plpgsql security definer set search_path = ''
			as $b$ begin return public.qorpera_describe_native_tool_authority(p_binding); end $b$ $f$);
	perform set_config('qorpera_test.j_direct_ms', coalesce(v_direct ->> 'ms', '?'), false);
	if v_direct ->> 'state' is distinct from '55P03' or v_plain #>> '{result,schema}' is distinct from 'qorpera.native-tool-authority/v1'
		or v_receipt ->> 'state' is distinct from '55P03' or v_view ->> 'state' is distinct from '55P03'
		or v_nested ->> 'state' is distinct from '55P03' then
		perform dblink_exec('j_holder', 'rollback');
		raise exception 'The run mutex is not as expected: direct %, by hand %, receipt %, view %, nested %',
			v_direct, v_plain, v_receipt, v_view, v_nested; end if;
end $$;

-- 7. Still held: the context fence through the host's long entry point waits for the row (that entry point sets its own
--    8 s lock_timeout, so the wait is read from pg_blocking_pids), and goes on once the row is released.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_waited boolean; v_outcome jsonb;
begin
	perform dblink_exec('j_caller', 'begin');
	perform * from dblink('j_caller', $q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', '/rpc/qorpera_native_host_call_long', true)$q$) as c(claims text, path text);
	perform dblink_exec('j_caller', 'set local role anon');
	perform dblink_send_query('j_caller', format('select public.qorpera_native_host_call_long(%L::uuid, %L, %L, %L::jsonb)',
		v_binding ->> 'jobId', current_setting('qorpera_test.j_token'), 'qorpera_fence_native_context',
		jsonb_build_object('p_environment_id', '92400000-0000-4000-8000-000000000020', 'p_binding', v_binding, 'p_paths', '[]'::jsonb,
			'p_view', jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 'j674-fence', 'threadId', 'thread-1',
				'turnId', 'turn-1', 'purpose', 'turn', 'outputs', '[]'::jsonb))));
	v_waited := pg_temp.j_waited();
	perform dblink_exec('j_holder', 'rollback');
	v_outcome := pg_temp.j_collect('j_caller');
	perform dblink_exec('j_caller', 'rollback');
	if not v_waited then raise exception 'The context fence did not wait for the run mutex: %', v_outcome; end if;
	if v_outcome #>> '{result,schema}' is distinct from 'qorpera.native-context-fence/v1' then
		raise exception 'The context fence did not answer once the row was released: %', v_outcome; end if;
	perform set_config('qorpera_test.j_fence', v_outcome #>> '{result,schema}', false);
end $$;
select current_setting('qorpera_test.j_held_ms') as j_held_ms, current_setting('qorpera_test.j_direct_ms') as j_direct_ms,
	current_setting('qorpera_test.j_fence') as j_fence \gset
\echo 674 while the row is held: describe through the host answered in :j_held_ms ms; directly it gave up after :j_direct_ms ms (55P03); the fence waited, then answered :j_fence

select pg_temp.j_cleanup();
