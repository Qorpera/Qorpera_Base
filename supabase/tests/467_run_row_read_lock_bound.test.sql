-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930540000 (R1) on 924's real native run of Alice's, whose job's lease token hash is set here to a known token's
-- (as test 674 does). The two reads the runtime asks again that take the run's budget row (the run mutex) wait at most
-- 3 s for it: the context read check (qorpera_folder_assert_run_reads, through qorpera_assert_company_path_reads) and the
-- fence (qorpera_fence_native_context). With the fixture committed (674's harness), two connections take the run-row
-- path on the run: the holder makes the call and is then slowed with pg_sleep in the same transaction, and the caller
-- makes the same call through the native host's entry point. The caller gives up with 55P03 after about 3 s while the
-- holder still holds the row, and its transaction has ended by then. The bounds: statement_timeout set inside a
-- function does not cut the statement already running; lock_timeout set before the row lock (SET LOCAL, or a
-- function's own setting) does bound the wait. The timings are printed too.
reset role;
select set_config('qorpera_test.rr_token', 'rr467-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.rr_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;

-- 1. The two reads carry lock_timeout 3s beside their other settings (the fence keeps its statement_timeout of 25 s),
--    and their grants are as before: the context read check is the owner's only, the fence the platform service
--    caller's. The run check itself and the entry points keep theirs, so the tool steps still wait the entry point's 8 s
--    (a receipt's begin and finish wait 3 s, 20260930541000, test 468).
do $$
declare v_config text[]; v_expected text[]; v_fn regprocedure; v_wrong text[] := '{}';
begin
	for v_fn, v_expected in select * from (values
		('public.qorpera_folder_assert_run_reads(uuid,jsonb,text[])'::regprocedure, array['search_path=""', 'lock_timeout=3s']),
		('public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)'::regprocedure,
			array['search_path=""', 'statement_timeout=25s', 'lock_timeout=3s']),
		('public.qorpera_folder_tool_run(jsonb,jsonb)'::regprocedure, array['search_path=""']),
		('public.qorpera_native_host_call(uuid,text,text,jsonb)'::regprocedure,
			array['search_path=""', 'statement_timeout=8s', 'lock_timeout=8s']),
		('public.qorpera_native_host_call_long(uuid,text,text,jsonb)'::regprocedure,
			array['search_path=""', 'statement_timeout=25s', 'lock_timeout=8s'])) as setting(fn, expected) loop
		select p.proconfig into v_config from pg_catalog.pg_proc as p where p.oid = v_fn;
		if not (coalesce(v_config, '{}') @> v_expected and coalesce(v_config, '{}') <@ v_expected) then
			v_wrong := v_wrong || format('%s sets %s', v_fn, v_config); end if;
	end loop;
	if exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(name)
			where has_function_privilege(r.name, 'public.qorpera_folder_assert_run_reads(uuid,jsonb,text[])', 'execute'))
		or exists (select 1 from unnest(array['public', 'anon', 'authenticated']) as r(name)
			where has_function_privilege(r.name, 'public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)', 'execute'))
		or not has_function_privilege('service_role', 'public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)', 'execute') then
		v_wrong := v_wrong || 'the grants changed'::text; end if;
	if cardinality(v_wrong) > 0 then raise exception 'The run-row reads are not as expected: %', v_wrong; end if;
end $$;

-- Alice's run records its native start and acknowledges its wake (as 674 does), so the context read and the fence
-- answer.
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
	perform pg_temp.base_public_send(v_binding, 'progress', 'rr467-ack');
end $$;

-- A routine of Bob's (as 674 makes one), started, for section 5c: a wake run's describe takes its provider connection FOR
-- SHARE, which a session turn's does not. Its job's token is the same known token.
create function pg_temp.rr_rparse(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', p_id, 'title', 'Tick', 'status', 'active',
		'trigger', jsonb_build_object('when', 'every', 'minutes', 5, 'starts', null), 'timezone', null, 'ends', null,
		'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'optional', 'conclusion', null,
		'instructions', 'Examine the authorized change.')
$$;
select pg_temp.base_commit(pg_temp.base_owner(), 'rr467-routine-tick', jsonb_build_array(
	pg_temp.base_write('QorperaOS/agents/bob/routines/tick.md', 'routine',
		E'---\n' || pg_temp.rr_rparse('92400000-0000-4000-8000-000000000467')::text || E'\n---\n',
		pg_temp.rr_rparse('92400000-0000-4000-8000-000000000467'), pg_temp.base_version('QorperaOS/agents/bob/routines/tick.md')))) \g /dev/null
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors; v_wake uuid := extensions.gen_random_uuid();
	v_at timestamptz := statement_timestamp() - interval '5 minutes'; v_run public.qorpera_execution_runs; v_binding jsonb; v_identity jsonb;
	v_connection uuid;
begin
	select c.* into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors c
	join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version
	where r.id = '92400000-0000-4000-8000-000000000467';
	perform public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, v_wake, 'rr467-tick-1',
		v_cursor.trigger_id, v_at, v_cursor.last_scheduled_for, v_at + interval '5 minutes', '{}');
	perform pg_temp.base_materialize();
	select run.* into strict v_run from public.qorpera_execution_runs run
	where run.id = (select occurrence.run_id from public.qorpera_wake_occurrences occurrence where occurrence.id = v_wake);
	v_binding := pg_temp.base_start(v_run.id);
	update public.qorpera_runner_jobs
	set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.rr_token'), 'utf8'), 'sha256'), 'hex')
	where id = (v_binding ->> 'jobId')::uuid;
	select sponsor.provider_connection_id into strict v_connection from public.qorpera_execution_sponsor_versions sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	v_identity := public.qorpera_describe_native_tool_authority(v_binding) -> 'identity';
	perform public.qorpera_begin_native_company_execution_v2(v_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
	perform set_config('qorpera_test.rr_wake_binding', v_binding::text, false);
	perform set_config('qorpera_test.rr_wake_connection', v_connection::text, false);
end $$;

-- Row locks show only across connections, so 924's fixture is committed here and removed again at the end (674's
-- harness): the test refuses to run beside other connections to this database, whose rows the cleanup could not tell
-- from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.base_binding','qorpera_test.rr_token','qorpera_test.rr_wake_binding','qorpera_test.rr_wake_connection']) name;
select set_config('qorpera_test.rr_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('rr_holder', 'dbname=' || current_database());
select dblink_connect('rr_caller', 'dbname=' || current_database());
select set_config('qorpera_test.rr_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('rr_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.rr_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.rr_holder_pid'), current_setting('qorpera_test.rr_caller_pid'))) then
		raise exception 'The run-row read test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.rr_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table rr_counts as select * from dblink('rr_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table rr_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.rr_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.rr_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.rr_rows select v_table, kept.row_value
			from dblink('rr_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards (its error and its end both read). A
-- cancel or statement timeout over there (57014) is an outcome too, which OTHERS does not catch.
create function pg_temp.rr_collect(p_connection text) returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result(p_connection) as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when query_canceled or others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result(p_connection, false) as call(result jsonb);
	return v_outcome;
end
$$;
-- p_sql on the caller connection: its result or error, how long until it answered (ms, read every 25 ms, 10 s at
-- most before it is awaited), and whether it waited for the holder meanwhile.
create function pg_temp.rr_send(p_sql text) returns jsonb language plpgsql as $$
declare v_start timestamptz := clock_timestamp(); v_waited boolean := false; v_ms numeric;
	v_holder integer := current_setting('qorpera_test.rr_holder_pid')::integer;
	v_caller integer := current_setting('qorpera_test.rr_caller_pid')::integer;
begin
	perform dblink_send_query('rr_caller', p_sql);
	for attempt in 1..400 loop
		v_waited := v_waited or v_holder = any(pg_blocking_pids(v_caller));
		exit when dblink_is_busy('rr_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	v_ms := round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric);
	return pg_temp.rr_collect('rr_caller') || jsonb_build_object('ms', v_ms, 'waited', v_waited);
end $$;
-- A call through a native host entry point with the job's token.
create function pg_temp.rr_host_sql(p_entry text, p_name text, p_args jsonb) returns text language sql as $$
	select format('select public.%I(%L::uuid, %L, %L, %L::jsonb)', p_entry,
		current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId', current_setting('qorpera_test.rr_token'), p_name, p_args)
$$;
-- The caller's backend now: its state, whether a transaction is open, the locks it holds or waits for, and who blocks it.
create function pg_temp.rr_caller_state() returns jsonb language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.rr_caller_pid')::integer; v_state jsonb;
begin
	perform pg_catalog.pg_stat_clear_snapshot();
	select jsonb_build_object('state', activity.state,
		'transaction', activity.xact_start is not null or activity.backend_xid is not null,
		'locks', (select count(*) from pg_catalog.pg_locks lock where lock.pid = v_pid),
		'blockers', cardinality(pg_catalog.pg_blocking_pids(v_pid)))
	into strict v_state from pg_catalog.pg_stat_activity activity where activity.pid = v_pid;
	return v_state;
end $$;
-- The caller makes the call as the native host does, in a transaction of its own (as PostgREST's request is one): the
-- publishable key's role on the entry point's RPC path, with the entry point's statement budget armed before the call
-- (PostgREST applies a called function's statement_timeout to its request, db-hoisted-tx-settings). Its outcome, and
-- its backend's state right after the answer.
create function pg_temp.rr_host(p_entry text, p_name text, p_args jsonb) returns jsonb language plpgsql as $$
declare v_outcome jsonb;
begin
	perform * from dblink('rr_caller', format($q$select set_config('request.jwt.claims', '{"role":"anon"}', false),
		set_config('request.path', %L, false), set_config('statement_timeout', %L, false)$q$, '/rpc/' || p_entry,
		case p_entry when 'qorpera_native_host_call_long' then '25s' else '8s' end)) as c(claims text, path text, budget text);
	perform dblink_exec('rr_caller', 'set role anon');
	v_outcome := pg_temp.rr_send(pg_temp.rr_host_sql(p_entry, p_name, p_args));
	v_outcome := v_outcome || jsonb_build_object('after', pg_temp.rr_caller_state());
	perform dblink_exec('rr_caller', 'reset role');
	perform dblink_exec('rr_caller', 'reset all');
	return v_outcome;
end $$;
-- The holder makes the same call the same way and keeps its transaction, so it holds the run's row; then it is slowed
-- with pg_sleep(p_seconds) in that transaction (sent, not awaited). Returns its call's answer.
create function pg_temp.rr_hold(p_entry text, p_name text, p_args jsonb, p_seconds numeric) returns jsonb language plpgsql as $$
declare v_answer jsonb;
begin
	perform dblink_exec('rr_holder', 'begin');
	perform * from dblink('rr_holder', format($q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', %L, true)$q$, '/rpc/' || p_entry)) as c(claims text, path text);
	perform dblink_exec('rr_holder', 'set local role anon');
	select answer into v_answer from dblink('rr_holder', pg_temp.rr_host_sql(p_entry, p_name, p_args)) as call(answer jsonb);
	perform dblink_send_query('rr_holder', format('select jsonb_build_object(%L, true) from pg_sleep(%s)', 'slept', p_seconds));
	return jsonb_build_object('answer', v_answer);
end $$;
-- Whether the holder is still in its sleep (its transaction, and the run's row, still held); then it is stopped and
-- rolled back.
create function pg_temp.rr_release() returns boolean language plpgsql as $$
declare v_holding boolean := dblink_is_busy('rr_holder') = 1;
begin
	perform dblink_cancel_query('rr_holder');
	perform pg_temp.rr_collect('rr_holder');
	perform dblink_exec('rr_holder', 'rollback');
	return v_holding;
end $$;
create function pg_temp.rr_context_args() returns jsonb language sql as $$
	select jsonb_build_object('p_environment_id', '92400000-0000-4000-8000-000000000020',
		'p_binding', current_setting('qorpera_test.base_binding')::jsonb, 'p_paths', '[]'::jsonb)
$$;
create function pg_temp.rr_fence_args(p_request text) returns jsonb language sql as $$
	select pg_temp.rr_context_args() || jsonb_build_object('p_view', jsonb_build_object('schema', 'qorpera.native-context-view/v1',
		'requestId', p_request, 'threadId', 'thread-1', 'turnId', 'turn-1', 'purpose', 'turn', 'outputs', '[]'::jsonb))
$$;
-- At the end: remove what the test committed, as 674 does.
create function pg_temp.rr_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.rr_first_xid')::xid;
begin
	perform pg_temp.rr_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['rr_holder','rr_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.rr_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.rr_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.rr_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.rr_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Run-row read test cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 2. statement_timeout set inside a function does not cut the statement already running: the bound armed when the
--    statement started holds. With none armed, a function that sets 200 ms for itself sleeps its 600 ms; with 200 ms
--    armed, a function that sets 5 s for itself is cut at 200 ms (57014).
do $$
declare v_inside jsonb; v_armed jsonb;
begin
	perform dblink_exec('rr_caller', $f$create function pg_temp.rr_short() returns jsonb language plpgsql set statement_timeout = '200ms'
		as $b$ begin perform pg_sleep(0.6); return jsonb_build_object('statement_timeout', current_setting('statement_timeout')); end $b$ $f$);
	perform dblink_exec('rr_caller', $f$create function pg_temp.rr_long() returns jsonb language plpgsql set statement_timeout = '5s'
		as $b$ begin perform pg_sleep(0.6); return jsonb_build_object('statement_timeout', current_setting('statement_timeout')); end $b$ $f$);
	perform dblink_exec('rr_caller', 'set statement_timeout = 0');
	v_inside := pg_temp.rr_send('select pg_temp.rr_short()');
	perform dblink_exec('rr_caller', $q$set statement_timeout = '200ms'$q$);
	v_armed := pg_temp.rr_send('select pg_temp.rr_long()');
	perform dblink_exec('rr_caller', 'reset statement_timeout');
	perform set_config('qorpera_test.rr_statement', format('a 200 ms setting inside: %s after %s ms; 200 ms armed, 5 s inside: %s after %s ms',
		coalesce(v_inside ->> 'state', 'answered'), v_inside ->> 'ms', coalesce(v_armed ->> 'state', 'answered'), v_armed ->> 'ms'), false);
	if v_inside -> 'result' is distinct from '{"statement_timeout": "200ms"}'::jsonb or (v_inside ->> 'ms')::numeric < 600
		or v_armed ->> 'state' is distinct from '57014' or (v_armed ->> 'ms')::numeric >= 600 then
		raise exception 'statement_timeout inside a function is not as expected: inside %, armed %', v_inside, v_armed; end if;
end $$;

-- 3. A lock_timeout set with SET LOCAL before the row lock bounds the wait for it. The holder makes the context read
--    through the host and sleeps 4 s holding the row; the caller, under the entry point's 8 s statement budget and
--    SET LOCAL lock_timeout 1s, waits for the row FOR UPDATE and gives up with 55P03 after about 1 s.
do $$
declare v_held jsonb; v_outcome jsonb; v_holding boolean;
begin
	v_held := pg_temp.rr_hold('qorpera_native_host_call', 'qorpera_assert_company_path_reads', pg_temp.rr_context_args(), 4);
	perform dblink_exec('rr_caller', 'begin');
	perform dblink_exec('rr_caller', $q$set local statement_timeout = '8s'$q$);
	perform dblink_exec('rr_caller', $q$set local lock_timeout = '1s'$q$);
	v_outcome := pg_temp.rr_send(format('select to_jsonb(budget.run_id) from public.qorpera_execution_run_budgets budget where budget.run_id = %L for update',
		current_setting('qorpera_test.base_binding')::jsonb ->> 'runId'));
	perform dblink_exec('rr_caller', 'rollback');
	v_holding := pg_temp.rr_release();
	perform set_config('qorpera_test.rr_local', format('%s after %s ms', v_outcome ->> 'state', v_outcome ->> 'ms'), false);
	if v_held is distinct from '{"answer": null}'::jsonb or v_outcome ->> 'state' is distinct from '55P03'
		or not (v_outcome ->> 'waited')::boolean or (v_outcome ->> 'ms')::numeric not between 950 and 2500 or not v_holding then
		raise exception 'SET LOCAL lock_timeout did not bound the row wait: held %, caller %, holder still holding %',
			v_held, v_outcome, v_holding; end if;
end $$;

-- 4. The context read: the holder makes it through the host and sleeps 6 s holding the row; the caller makes it through
--    the same entry point (8 s statement budget, 8 s lock_timeout), waits for the holder, and gives up with 55P03 after
--    about 3 s (the function's own lock_timeout), while the holder still holds the row. By the answer the caller's
--    transaction has ended: it is idle, holds and waits for no lock, and no one blocks it.
do $$
declare v_held jsonb; v_outcome jsonb; v_holding boolean;
begin
	v_held := pg_temp.rr_hold('qorpera_native_host_call', 'qorpera_assert_company_path_reads', pg_temp.rr_context_args(), 6);
	v_outcome := pg_temp.rr_host('qorpera_native_host_call', 'qorpera_assert_company_path_reads', pg_temp.rr_context_args());
	v_holding := pg_temp.rr_release();
	perform set_config('qorpera_test.rr_read', format('%s after %s ms', v_outcome ->> 'state', v_outcome ->> 'ms'), false);
	if v_held is distinct from '{"answer": null}'::jsonb or v_outcome ->> 'state' is distinct from '55P03'
		or not (v_outcome ->> 'waited')::boolean or (v_outcome ->> 'ms')::numeric not between 2950 and 4500 or not v_holding
		or v_outcome -> 'after' is distinct from '{"state": "idle", "transaction": false, "locks": 0, "blockers": 0}'::jsonb then
		raise exception 'The context read did not give up on the held row within its bound: held %, caller %, holder still holding %',
			v_held, v_outcome, v_holding; end if;
end $$;

-- 5. The fence, the same way through the long entry point (25 s statement budget, 8 s lock_timeout): the holder's fence
--    records its view and sleeps 6 s holding the row; the caller's fence gives up with 55P03 after about 3 s and records
--    nothing, while the holder still holds the row, and its transaction has ended by the answer. The holder's view is
--    rolled back with it.
do $$
declare v_held jsonb; v_outcome jsonb; v_holding boolean;
begin
	v_held := pg_temp.rr_hold('qorpera_native_host_call_long', 'qorpera_fence_native_context', pg_temp.rr_fence_args('rr467-holder'), 6);
	v_outcome := pg_temp.rr_host('qorpera_native_host_call_long', 'qorpera_fence_native_context', pg_temp.rr_fence_args('rr467-caller'));
	v_holding := pg_temp.rr_release();
	perform set_config('qorpera_test.rr_fence', format('%s after %s ms', v_outcome ->> 'state', v_outcome ->> 'ms'), false);
	if v_held #>> '{answer,schema}' is distinct from 'qorpera.native-context-fence/v1' or v_outcome ->> 'state' is distinct from '55P03'
		or not (v_outcome ->> 'waited')::boolean or (v_outcome ->> 'ms')::numeric not between 2950 and 4500 or not v_holding
		or v_outcome -> 'after' is distinct from '{"state": "idle", "transaction": false, "locks": 0, "blockers": 0}'::jsonb
		or exists (select 1 from public.qorpera_native_context_views
			where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid and request_id like 'rr467-%') then
		raise exception 'The fence did not give up on the held row within its bound: held %, caller %, holder still holding %',
			v_held, v_outcome, v_holding; end if;
end $$;

-- 5b. The run's check around a tool call (20260930603000), the same way through the 8 s entry point: it asks what describe
--     and the context read ask, so it gives up with 55P03 after about 3 s too, and its transaction has ended by the answer.
do $$
declare v_held jsonb; v_outcome jsonb; v_holding boolean;
begin
	v_held := pg_temp.rr_hold('qorpera_native_host_call', 'qorpera_assert_company_path_reads', pg_temp.rr_context_args(), 6);
	v_outcome := pg_temp.rr_host('qorpera_native_host_call', 'qorpera_check_native_run', pg_temp.rr_context_args() - 'p_paths');
	v_holding := pg_temp.rr_release();
	perform set_config('qorpera_test.rr_check', format('%s after %s ms', v_outcome ->> 'state', v_outcome ->> 'ms'), false);
	if v_held is distinct from '{"answer": null}'::jsonb or v_outcome ->> 'state' is distinct from '55P03'
		or not (v_outcome ->> 'waited')::boolean or (v_outcome ->> 'ms')::numeric not between 2950 and 4500 or not v_holding
		or v_outcome -> 'after' is distinct from '{"state": "idle", "transaction": false, "locks": 0, "blockers": 0}'::jsonb then
		raise exception 'The run check did not give up on the held row within its bound: held %, caller %, holder still holding %',
			v_held, v_outcome, v_holding; end if;
end $$;

-- 5c. On a wake run, the call holds nothing of describe's while it waits for the run's row. The holder takes the row
--     through the host and stays idle in its transaction; the caller's run check waits for it. The holder, still holding
--     the row, then takes the run's provider connection FOR UPDATE, as qorpera_prepare_routine_login may and a withdrawal
--     of consent does: it gets it at once. With describe before the read-set check the call would hold the connection FOR
--     SHARE while it waited, the holder would wait for the call, and one of them would die with 40P01. When the holder
--     rolls back, the call answers.
do $$
declare v_binding jsonb := current_setting('qorpera_test.rr_wake_binding')::jsonb; v_args jsonb;
	v_job text := v_binding ->> 'jobId'; v_token text := current_setting('qorpera_test.rr_token');
	v_holder integer := current_setting('qorpera_test.rr_holder_pid')::integer;
	v_caller integer := current_setting('qorpera_test.rr_caller_pid')::integer;
	v_waiting boolean := false; v_start timestamptz; v_locked_ms numeric; v_locked jsonb; v_outcome jsonb;
begin
	v_args := jsonb_build_object('p_environment_id', '92400000-0000-4000-8000-000000000020', 'p_binding', v_binding);
	perform dblink_exec('rr_holder', 'begin');
	perform * from dblink('rr_holder', $q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', '/rpc/qorpera_native_host_call', true)$q$) as c(claims text, path text);
	perform dblink_exec('rr_holder', 'set local role anon');
	perform * from dblink('rr_holder', format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)', v_job, v_token,
		'qorpera_assert_company_path_reads', v_args || '{"p_paths": []}'::jsonb)) as call(answer jsonb);
	perform dblink_exec('rr_holder', 'reset role');

	perform * from dblink('rr_caller', $q$select set_config('request.jwt.claims', '{"role":"anon"}', false),
		set_config('request.path', '/rpc/qorpera_native_host_call', false), set_config('statement_timeout', '8s', false)$q$)
		as c(claims text, path text, budget text);
	perform dblink_exec('rr_caller', 'set role anon');
	perform dblink_send_query('rr_caller', format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)', v_job, v_token,
		'qorpera_check_native_run', v_args));
	for attempt in 1..80 loop
		v_waiting := v_holder = any(pg_blocking_pids(v_caller));
		exit when v_waiting;
		perform pg_sleep(0.025);
	end loop;
	if not v_waiting then raise exception 'The wake run''s check did not wait for the held row'; end if;

	v_start := clock_timestamp();
	perform dblink_send_query('rr_holder', format('select to_jsonb(connection.id) from public.qorpera_provider_connections connection where connection.id = %L for update',
		current_setting('qorpera_test.rr_wake_connection')));
	for attempt in 1..200 loop
		exit when dblink_is_busy('rr_holder') = 0;
		perform pg_sleep(0.025);
	end loop;
	v_locked_ms := round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric);
	v_locked := pg_temp.rr_collect('rr_holder');
	perform dblink_exec('rr_holder', 'rollback');
	for attempt in 1..200 loop
		exit when dblink_is_busy('rr_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	v_outcome := pg_temp.rr_collect('rr_caller');
	perform dblink_exec('rr_caller', 'reset role');
	perform dblink_exec('rr_caller', 'reset all');
	perform set_config('qorpera_test.rr_wake', format('the holder took the connection in %s ms; the check then %s', v_locked_ms,
		coalesce(v_outcome ->> 'state', 'answered')), false);
	if v_locked -> 'result' is null or v_locked_ms >= 500 or v_outcome #>> '{result,schema}' is distinct from 'qorpera.native-tool-authority/v1' then
		raise exception 'The wake run''s check held the connection while it waited: the holder %, after % ms; the check %', v_locked, v_locked_ms, v_outcome; end if;
end $$;

-- 6. With the row free, the caller's same three calls answer: the 55P03s above were the wait for the row.
do $$
declare v_read jsonb; v_fence jsonb; v_check jsonb;
begin
	v_read := pg_temp.rr_host('qorpera_native_host_call', 'qorpera_assert_company_path_reads', pg_temp.rr_context_args());
	v_fence := pg_temp.rr_host('qorpera_native_host_call_long', 'qorpera_fence_native_context', pg_temp.rr_fence_args('rr467-free'));
	v_check := pg_temp.rr_host('qorpera_native_host_call', 'qorpera_check_native_run', pg_temp.rr_context_args() - 'p_paths');
	if not (v_read ? 'result') or v_read -> 'result' is distinct from 'null'::jsonb or (v_read ->> 'waited')::boolean
		or v_fence #>> '{result,schema}' is distinct from 'qorpera.native-context-fence/v1' or (v_fence ->> 'waited')::boolean
		or v_check #>> '{result,schema}' is distinct from 'qorpera.native-tool-authority/v1' or (v_check ->> 'waited')::boolean then
		raise exception 'The run-row reads did not answer with the row free: read %, fence %, check %', v_read, v_fence, v_check; end if;
end $$;
select current_setting('qorpera_test.rr_statement') as rr_statement, current_setting('qorpera_test.rr_local') as rr_local,
	current_setting('qorpera_test.rr_read') as rr_read, current_setting('qorpera_test.rr_fence') as rr_fence,
	current_setting('qorpera_test.rr_check') as rr_check, current_setting('qorpera_test.rr_wake') as rr_wake \gset
\echo 467 statement_timeout: :rr_statement
\echo 467 while the row is held: SET LOCAL lock_timeout 1s gave :rr_local; the context read gave :rr_read; the fence gave :rr_fence; the run check gave :rr_check; on a wake run :rr_wake

select pg_temp.rr_cleanup();
