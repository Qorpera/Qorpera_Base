-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930499000 on 924's real native run of Alice's: the company-context describe (qorpera_describe_company_run_context
-- as the entry point) reads its run without the run mutex, through qorpera_folder_native_run_plain, and its nested
-- describe reads plain too; it keeps the context check's actor test and leaves out its reads check, a writer of the
-- run's read set. Its answer (apart from its clock) and its refusals are the locked path's. With the fixture committed
-- (the harness of 793), another connection holds the run's budget row: the context describe through the host, and
-- directly with request.path set to it by hand, answer at once, while a direct call with no request.path, describe
-- under the context's request.path, the context describe under describe's, the wake read and a function that calls the
-- context describe still wait for the row. The timing is printed, not checked.
reset role;
select set_config('qorpera_test.c_token', 'c672-lease-token-0123456789abcdef', false);

-- A started run's job takes the known lease token, as 793 and 674 do.
create function pg_temp.c_token(p_binding jsonb) returns void language sql as $$
	update public.qorpera_runner_jobs
	set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.c_token'), 'utf8'), 'sha256'), 'hex')
	where id = (p_binding ->> 'jobId')::uuid
$$;
select pg_temp.c_token(current_setting('qorpera_test.base_binding')::jsonb);
-- A call's answer, or its refusal.
create function pg_temp.c_try(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	execute p_sql into v_result;
	return jsonb_build_object('result', v_result);
exception when others then
	return jsonb_build_object('state', sqlstate, 'error', sqlerrm);
end $$;
-- The context describe through the native host (its entry point, the job's token), and the context describe, describe
-- and the wake read called directly.
create function pg_temp.c_host_sql(p_binding jsonb, p_name text default 'qorpera_describe_company_run_context')
returns text language sql as $$
	select format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)', p_binding ->> 'jobId',
		current_setting('qorpera_test.c_token'), p_name, jsonb_build_object('p_binding', p_binding))
$$;
create function pg_temp.c_context_sql(p_binding jsonb) returns text language sql as $$
	select format('select public.qorpera_describe_company_run_context(%L::jsonb)', p_binding)
$$;
create function pg_temp.c_describe_sql(p_binding jsonb) returns text language sql as $$
	select format('select public.qorpera_describe_native_tool_authority(%L::jsonb)', p_binding)
$$;
create function pg_temp.c_wake_sql(p_binding jsonb) returns text language sql as $$
	select format('select public.qorpera_read_native_wake(%L::jsonb)', p_binding)
$$;
-- An answer without its clock: observedAt (clock_timestamp(), checked to be a time) reads true. Nothing else in the
-- context is a clock: its identity is describe's 'identity', which names the run, its lease, sponsor and bundle and no
-- time (describe's time-dependent validForMs sits beside it, at describe's top level, and is not in the context;
-- section 2 checks the identity against describe's own).
create function pg_temp.c_clockless(p_outcome jsonb) returns jsonb language sql as $$
	select case when p_outcome #> '{result,observedAt}' is null then p_outcome
		else jsonb_set(p_outcome, '{result,observedAt}', to_jsonb((p_outcome #>> '{result,observedAt}')::timestamptz is not null)) end
$$;
-- This transaction's calls of the plain read, the locked run check (the budget row FOR UPDATE) and the context check's
-- reads check (the read set's writer).
create function pg_temp.c_calls() returns bigint[] language sql as $$
	select array_agg(coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = n.name), 0)::bigint order by n.ordinal)
	from unnest(array['qorpera_folder_native_run_plain', 'qorpera_folder_tool_run', 'qorpera_folder_run_reads_current'])
		with ordinality as n(name, ordinal)
$$;
-- The context describe one way in this transaction, without its clock: through the host (the publishable key's role on
-- the host's RPC path), as the entry point by request.path (the plain read the host reaches), or by direct SQL with no
-- request.path (the locked run check and the whole context check).
create function pg_temp.c_way(p_binding jsonb, p_way text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	if p_way = 'host' then
		perform set_config('request.jwt.claims', '{"role":"anon"}', true);
		perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
		v := pg_temp.c_try(pg_temp.c_host_sql(p_binding));
	else
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		perform set_config('request.path', case p_way when 'plain' then '/rpc/qorpera_describe_company_run_context' else '' end, true);
		v := pg_temp.c_try(pg_temp.c_context_sql(p_binding));
	end if;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.path', '', true);
	return pg_temp.c_clockless(v);
end $$;
-- The three ways, with each one's calls of [plain read, locked run check, reads check].
create function pg_temp.c_three(p_binding jsonb) returns jsonb language plpgsql as $$
declare v_answers jsonb := '{}'; v_calls jsonb := '{}'; v_at bigint[]; v_after bigint[]; v_way text;
begin
	foreach v_way in array array['host', 'plain', 'locked'] loop
		v_at := pg_temp.c_calls();
		v_answers := v_answers || jsonb_build_object(v_way, pg_temp.c_way(p_binding, v_way));
		v_after := pg_temp.c_calls();
		v_calls := v_calls || jsonb_build_object(v_way, to_jsonb(array[v_after[1] - v_at[1], v_after[2] - v_at[2], v_after[3] - v_at[3]]));
	end loop;
	return v_answers || jsonb_build_object('calls', v_calls);
end $$;
-- A refusal: the plain path refuses as the locked path does (SQLSTATE and message); the host answers the same, or
-- (p_host_refused) its entry point refuses first, as before.
create function pg_temp.c_refused(p_name text, p_binding jsonb, p_state text, p_host_refused boolean default false)
returns text language plpgsql as $$
declare v jsonb := pg_temp.c_three(p_binding) - 'calls';
	v_host jsonb := v -> 'locked';
begin
	if p_host_refused then v_host := '{"state":"42501","error":"native host call is refused"}'; end if;
	if v -> 'locked' ? 'result' or v #>> '{locked,state}' is distinct from p_state or v -> 'plain' is distinct from v -> 'locked'
		or v -> 'host' is distinct from v_host then
		raise exception '672 %: the plain and the locked context describe refuse differently: %', p_name, v; end if;
	return format('%s: %s %s (host: %s)', p_name, v #>> '{locked,state}', v #>> '{locked,error}', v #>> '{host,error}');
end $$;

-- 1. The context describe's source: the plain read and the locked run check once each, the whole context check only off
--    the plain path and the actor test on it, and 20260930497000's origin kept; security definer with an empty
--    search_path, volatile, and not the API roles' (anon, authenticated). describe carries 20260930499000's rule.
do $$
declare v pg_proc; v_describe pg_proc; v_text text;
begin
	select * into strict v from pg_proc where oid = 'public.qorpera_describe_company_run_context(jsonb)'::regprocedure;
	select * into strict v_describe from pg_proc where oid = 'public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure;
	foreach v_text in array array['v_run := public.qorpera_folder_native_run_plain(p_binding);',
		'v_run := public.qorpera_native_tool_locked_run(p_binding);', 'perform public.qorpera_company_path_assert_context(v_actor);',
		'v_authority := public.qorpera_describe_native_tool_authority(p_binding);',
		'raise exception ''Company File authority is unavailable'' using errcode = ''42501'';',
		'-- 20260930497000: the request that started the agent''s own chain, for the action review only.',
		'from public.qorpera_run_review_origin(v_run) as origin where origin is not null'] loop
		if (length(v.prosrc) - length(replace(v.prosrc, v_text, ''))) / length(v_text) <> 1 then
			raise exception 'The context describe does not say once: %', v_text; end if;
	end loop;
	if position('20260930499000' in v.prosrc) = 0
		or v.prosrc !~ 'if v_plain then\s+v_run := public\.qorpera_folder_native_run_plain\(p_binding\);\s+else\s+v_run := public\.qorpera_native_tool_locked_run\(p_binding\);'
		or v.prosrc !~ 'if not v_plain then\s+perform public\.qorpera_company_path_assert_context\(v_actor\);'
		or not v.prosecdef or v.proconfig is distinct from array['search_path=""'] or v.provolatile <> 'v'
		or has_function_privilege('anon', v.oid, 'execute') or has_function_privilege('authenticated', v.oid, 'execute') then
		raise exception 'The context describe is not as expected: % % % %', v.prosecdef, v.proconfig, v.provolatile, v.proacl; end if;
	if position('20260930499000' in v_describe.prosrc) = 0
		or position('v_entry is not distinct from ''qorpera_describe_company_run_context''' in v_describe.prosrc) = 0 then
		raise exception 'describe does not carry 20260930499000''s rule'; end if;
end $$;

-- 2. With nothing holding the row, the three answers are one apart from observedAt (jsonb =): through the host and as
--    the entry point by request.path the context describe and its nested describe read plain, with no reads check;
--    directly both take the locked run check, and the context check runs its reads check. The identity is describe's.
set local track_functions = 'all';
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v jsonb := pg_temp.c_three(v_binding);
	v_identity jsonb;
begin
	if not (v -> 'locked' ? 'result') or v #>> '{locked,result,schema}' is distinct from 'qorpera.native-company-context/v2'
		or v #>> '{locked,result,observedAt}' is distinct from 'true'
		or v -> 'host' is distinct from v -> 'locked' or v -> 'plain' is distinct from v -> 'locked' then
		raise exception 'The context describe answers differently through the host, plain and locked: %', v; end if;
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	if v_identity is null or v #> '{locked,result,identity}' is distinct from v_identity then
		raise exception 'The context''s identity is not describe''s: % against %', v #> '{locked,result,identity}', v_identity; end if;
	if v -> 'calls' is distinct from '{"host":[2,0,0],"plain":[2,0,0],"locked":[0,2,1]}'::jsonb then
		raise exception 'The context describe''s calls of [plain read, locked run check, reads check] are not as expected: %',
			v -> 'calls'; end if;
end $$;
reset track_functions;

-- 3. The refusals, each undone after: the company's stop (55000); a finished job, a binding with another lease, a
--    company with no folder-v2 Company File and a removed room membership (42501). The actor test's own 42501 is not
--    reached here: the run check before it refuses every binding whose resolved actor is not its own run's agent.
savepoint c_refusal;
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'c672');
select pg_temp.c_refused('paused', current_setting('qorpera_test.base_binding')::jsonb, '55000') as c_out \gset
\echo 672 refusal :c_out
rollback to savepoint c_refusal;

set local session_replication_role = replica;
update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
set local session_replication_role = origin;
select pg_temp.c_refused('finished job', current_setting('qorpera_test.base_binding')::jsonb, '42501', true) as c_out \gset
\echo 672 refusal :c_out
rollback to savepoint c_refusal;

select pg_temp.c_refused('another lease', current_setting('qorpera_test.base_binding')::jsonb
	|| jsonb_build_object('leaseId', extensions.gen_random_uuid()), '42501') as c_out \gset
\echo 672 refusal :c_out
rollback to savepoint c_refusal;

set local session_replication_role = replica;
delete from public.qorpera_company_files where environment_id = '92400000-0000-4000-8000-000000000020';
set local session_replication_role = origin;
select pg_temp.c_refused('legacy environment', current_setting('qorpera_test.base_binding')::jsonb, '42501') as c_out \gset
\echo 672 refusal :c_out
rollback to savepoint c_refusal;

set local session_replication_role = replica;
delete from public.qorpera_company_room_members member using public.qorpera_execution_runs run
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
	and member.principal_kind = 'staff_agent' and member.principal_id = run.staff_agent_id
	and member.room_id in (select room.id from public.qorpera_company_rooms room where room.session_id = run.session_id);
set local session_replication_role = origin;
select pg_temp.c_refused('removed room membership', current_setting('qorpera_test.base_binding')::jsonb, '42501') as c_out \gset
\echo 672 refusal :c_out
rollback to savepoint c_refusal;
release savepoint c_refusal;

-- 4. The plain path leaves the run's read set alone: a read set row whose resource is gone stays as it was through the
--    host and by request.path, and the locked path's reads check retires it. Undone after.
savepoint c_reads;
insert into public.qorpera_folder_run_reads(run_id, environment_id, resource_id, grant_id, resource_revision, grant_revision, updated_at)
values ((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, '92400000-0000-4000-8000-000000000020',
	'67200000-0000-4000-8000-0000000000e1', null, 1, null, '2026-10-16 19:41:43+00');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_before jsonb; v_way text; v jsonb;
	v_after jsonb;
begin
	select to_jsonb(r) into strict v_before from public.qorpera_folder_run_reads r
	where r.run_id = (v_binding ->> 'runId')::uuid and r.resource_id = '67200000-0000-4000-8000-0000000000e1';
	foreach v_way in array array['host', 'plain', 'locked'] loop
		v := pg_temp.c_way(v_binding, v_way);
		if v #>> '{result,schema}' is distinct from 'qorpera.native-company-context/v2' then
			raise exception 'The context describe (%) did not answer beside a read set row: %', v_way, v; end if;
		v_after := (select to_jsonb(r) from public.qorpera_folder_run_reads r
			where r.run_id = (v_binding ->> 'runId')::uuid and r.resource_id = '67200000-0000-4000-8000-0000000000e1');
		if (v_way = 'locked') <> (v_after is null) or (v_way <> 'locked' and v_after is distinct from v_before) then
			raise exception 'The context describe (%) left the read set row as %, from %', v_way, v_after, v_before; end if;
	end loop;
end $$;
rollback to savepoint c_reads;
release savepoint c_reads;

-- 5. The timing, on this machine with nothing else running (printed only): the context describe through the host, as
--    the entry point by request.path, and directly (locked, as through the host before this change), 20 times each.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_sql text := pg_temp.c_host_sql(v_binding);
	v_start timestamptz; v_host double precision := 0; v_plain double precision := 0; v_locked double precision := 0;
	v_rounds constant integer := 20;
begin
	for i in 1 .. v_rounds loop
		perform set_config('request.jwt.claims', '{"role":"anon"}', true);
		perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
		v_start := clock_timestamp();
		execute v_sql;
		v_host := v_host + extract(epoch from clock_timestamp() - v_start);
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		perform set_config('request.path', '/rpc/qorpera_describe_company_run_context', true);
		v_start := clock_timestamp();
		perform public.qorpera_describe_company_run_context(v_binding);
		v_plain := v_plain + extract(epoch from clock_timestamp() - v_start);
		perform set_config('request.path', '', true);
		v_start := clock_timestamp();
		perform public.qorpera_describe_company_run_context(v_binding);
		v_locked := v_locked + extract(epoch from clock_timestamp() - v_start);
	end loop;
	perform set_config('qorpera_test.c_ms', format('through the host %s ms, by request.path %s ms, directly (locked) %s ms; '
		|| 'mean of %s', round((v_host * 1000 / v_rounds)::numeric, 2), round((v_plain * 1000 / v_rounds)::numeric, 2),
		round((v_locked * 1000 / v_rounds)::numeric, 2), v_rounds), false);
end $$;
select current_setting('qorpera_test.c_ms') as c_ms \gset
\echo 672 timing: :c_ms

-- Row locks show only across connections, so 924's fixture is committed here and removed again at the end (the
-- harness of 793, as 674 has it): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.base_binding','qorpera_test.c_token']) name;
select set_config('qorpera_test.c_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('c_holder', 'dbname=' || current_database());
select dblink_connect('c_caller', 'dbname=' || current_database());
select set_config('qorpera_test.c_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('c_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.c_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.c_holder_pid'), current_setting('qorpera_test.c_caller_pid'))) then
		raise exception 'The context mutex test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.c_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table c_counts as select * from dblink('c_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table c_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.c_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.c_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.c_rows select v_table, kept.row_value
			from dblink('c_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.c_collect(p_connection text) returns jsonb language plpgsql as $$
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
create function pg_temp.c_waited() returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.c_caller_pid')::integer;
begin
	for attempt in 1..400 loop
		if current_setting('qorpera_test.c_holder_pid')::integer = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('c_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
-- At the end: remove what the test committed, as 793 does.
create function pg_temp.c_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.c_first_xid')::xid;
begin
	perform pg_temp.c_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['c_holder','c_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.c_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.c_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.c_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.c_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Context mutex test cleanup left other row counts: %', v_wrong; end if;
end $$;
-- One call on the caller connection, in its own transaction, as the platform's service caller on p_path with a 500 ms
-- lock_timeout, after p_setup: its answer or its error, and how long it took.
create function pg_temp.c_remote(p_path text, p_sql text, p_setup text default null) returns jsonb language plpgsql as $$
declare v_start timestamptz; v_outcome jsonb;
begin
	perform dblink_exec('c_caller', 'begin');
	perform * from dblink('c_caller', format($q$select set_config('request.jwt.claims', '{"role":"service_role"}', true),
		set_config('request.path', %L, true), set_config('lock_timeout', '500ms', true)$q$, p_path)) as s(claims text, path text, timeout text);
	if p_setup is not null then perform dblink_exec('c_caller', p_setup); end if;
	v_start := clock_timestamp();
	perform dblink_send_query('c_caller', p_sql);
	v_outcome := pg_temp.c_collect('c_caller');
	perform dblink_exec('c_caller', 'rollback');
	return v_outcome || jsonb_build_object('ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric));
end $$;

-- 6. Another transaction holds the run's budget row (the run mutex), as a slow tool step or wake read does. The context
--    describe through the host (the publishable key's role on the host's RPC path) answers without waiting for it.
select dblink_exec('c_holder', 'begin');
select * from dblink('c_holder', format('select 1 from public.qorpera_execution_run_budgets where run_id = %L for update',
	current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')) as held(one integer);
do $$
declare v_start timestamptz; v_outcome jsonb;
begin
	perform dblink_exec('c_caller', 'begin');
	perform * from dblink('c_caller', $q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', '/rpc/qorpera_native_host_call', true)$q$) as c(claims text, path text);
	perform dblink_exec('c_caller', 'set local role anon');
	v_start := clock_timestamp();
	perform dblink_send_query('c_caller', pg_temp.c_host_sql(current_setting('qorpera_test.base_binding')::jsonb));
	if pg_temp.c_waited() then
		perform dblink_exec('c_holder', 'rollback');
		raise exception 'The context describe through the host waited for the run mutex: %', pg_temp.c_collect('c_caller'); end if;
	v_outcome := pg_temp.c_collect('c_caller');
	perform set_config('qorpera_test.c_held_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric)::text, false);
	perform dblink_exec('c_caller', 'rollback');
	if v_outcome #>> '{result,schema}' is distinct from 'qorpera.native-company-context/v2' then
		perform dblink_exec('c_holder', 'rollback');
		raise exception 'The context describe through the host did not answer: %', v_outcome; end if;
	perform set_config('qorpera_test.c_held_answer', pg_temp.c_clockless(v_outcome)::text, false);
end $$;

-- 7. Still held: with request.path set to the context describe by hand (both PostgREST forms) a direct call answers
--    the same. Everything else waits (55P03 under a 500 ms lock_timeout): a direct call with no request.path, describe
--    called directly under the context's request.path, the context describe under describe's request.path, the wake
--    read (which keeps the mutex and runs the reads check) and a function that calls the context describe.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_path text := '/rpc/qorpera_describe_company_run_context';
	v_held jsonb := current_setting('qorpera_test.c_held_answer')::jsonb; v_hand jsonb; v_rest jsonb; v_direct jsonb;
	v_describe jsonb; v_other jsonb; v_wake jsonb; v_nested jsonb;
begin
	v_hand := pg_temp.c_remote(v_path, pg_temp.c_context_sql(v_binding));
	v_rest := pg_temp.c_remote('/rest/v1' || v_path, pg_temp.c_context_sql(v_binding));
	v_direct := pg_temp.c_remote('', pg_temp.c_context_sql(v_binding));
	v_describe := pg_temp.c_remote(v_path, pg_temp.c_describe_sql(v_binding));
	v_other := pg_temp.c_remote('/rpc/qorpera_describe_native_tool_authority', pg_temp.c_context_sql(v_binding));
	v_wake := pg_temp.c_remote('/rpc/qorpera_read_native_wake', pg_temp.c_wake_sql(v_binding));
	v_nested := pg_temp.c_remote(v_path, format('select public.c672_nested(%L::jsonb)', v_binding),
		$f$create function public.c672_nested(p_binding jsonb) returns jsonb language plpgsql security definer set search_path = ''
			as $b$ begin return public.qorpera_describe_company_run_context(p_binding); end $b$ $f$);
	perform set_config('qorpera_test.c_hand_ms', coalesce(v_hand ->> 'ms', '?'), false);
	perform set_config('qorpera_test.c_direct_ms', coalesce(v_direct ->> 'ms', '?'), false);
	if pg_temp.c_clockless(v_hand - 'ms') is distinct from v_held or pg_temp.c_clockless(v_rest - 'ms') is distinct from v_held
		or v_direct ->> 'state' is distinct from '55P03' or v_describe ->> 'state' is distinct from '55P03'
		or v_other ->> 'state' is distinct from '55P03' or v_wake ->> 'state' is distinct from '55P03'
		or v_nested ->> 'state' is distinct from '55P03' then
		perform dblink_exec('c_holder', 'rollback');
		raise exception 'The run mutex is not as expected: by hand %, /rest/v1 %, direct %, describe %, under describe''s path %, wake %, nested %',
			v_hand, v_rest, v_direct, v_describe, v_other, v_wake, v_nested; end if;
end $$;

-- 8. Once the row is released, the direct call (locked) answers the same, and the wake read answers.
select dblink_exec('c_holder', 'rollback');
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_direct jsonb; v_wake jsonb;
begin
	v_direct := pg_temp.c_remote('', pg_temp.c_context_sql(v_binding));
	v_wake := pg_temp.c_remote('/rpc/qorpera_read_native_wake', pg_temp.c_wake_sql(v_binding));
	if pg_temp.c_clockless(v_direct - 'ms') is distinct from current_setting('qorpera_test.c_held_answer')::jsonb
		or v_wake -> 'result' is null or jsonb_typeof(v_wake -> 'result') is distinct from 'object' then
		raise exception 'After the release: direct %, wake %', v_direct, v_wake; end if;
end $$;
select current_setting('qorpera_test.c_held_ms') as c_held_ms, current_setting('qorpera_test.c_hand_ms') as c_hand_ms,
	current_setting('qorpera_test.c_direct_ms') as c_direct_ms \gset
\echo 672 while the row is held: the context through the host answered in :c_held_ms ms and by request.path in :c_hand_ms ms; directly it gave up after :c_direct_ms ms (55P03), as did describe, the context under describe's path, the wake read and a nested call

select pg_temp.c_cleanup();
