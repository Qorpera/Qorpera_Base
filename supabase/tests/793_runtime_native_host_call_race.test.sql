-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-1 (20260929999500): the native host's entry point checks the runner job's lease token before any lock, so a
-- refused call never waits for a transaction that holds the job row (the authorization-before-lock pattern of
-- tests 755-757), and a company reader through it keeps its shared lock on the company. Test 300's fixture leases a
-- run's job; its lease token's hash is set to a known token's.
reset role;
select set_config('qorpera_test.g2_token', 'g2-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.g2_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid;

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (the
-- harness of 602 and 746): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.wake_binding','qorpera_test.g2_token']) name;
select set_config('qorpera_test.r793_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r793_holder', 'dbname=' || current_database());
select dblink_connect('r793_caller', 'dbname=' || current_database());
select set_config('qorpera_test.r793_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('r793_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r793_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r793_holder_pid'),
			current_setting('qorpera_test.r793_caller_pid'))) then
		raise exception 'Native host call race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r793_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r793_counts as select * from dblink('r793_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r793_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r793_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r793_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r793_rows select v_table, kept.row_value
			from dblink('r793_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r793_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- Whether the connection's call waited for a lock held by p_by before it finished (10 s at most).
create function pg_temp.r793_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r793_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r793_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;

-- At the end: remove what the test committed, as 602 and 746 do.
create function pg_temp.r793_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r793_first_xid')::xid;
begin
	perform pg_temp.r793_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r793_holder','r793_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r793_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r793_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r793_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r793_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Native host call race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- A native host call (the run's tool authority, a company reader) from the caller connection.
create function pg_temp.r793_call_sql(p_token text) returns text language sql as $$
	select format($q$select to_jsonb(public.qorpera_native_host_call(%L, %L, %L, %L))$q$,
		current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId', p_token, 'qorpera_describe_native_tool_authority',
		jsonb_build_object('p_binding', current_setting('qorpera_test.wake_binding')::jsonb)::text)
$$;
create function pg_temp.r793_send(p_token text) returns void language sql as $$
	select dblink_send_query('r793_caller', pg_temp.r793_call_sql(p_token))
$$;
-- The caller connection as PostgREST runs the entry point: the publishable key's role on its RPC path.
create function pg_temp.r793_caller_begin() returns void language plpgsql as $$
begin
	perform dblink_exec('r793_caller', 'begin');
	perform * from dblink('r793_caller', $q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', '/rpc/qorpera_native_host_call', true)$q$) as c(claims text, path text);
	perform dblink_exec('r793_caller', 'set local role anon');
end $$;

-- 1. Another transaction holds the job row. A wrong token is refused at once, without waiting for it.
do $$
declare v_outcome jsonb;
begin
	perform dblink_exec('r793_holder', 'begin');
	perform * from dblink('r793_holder', format('select 1 from public.qorpera_runner_jobs where id = %L for update',
		current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')) as held(one integer);
	perform pg_temp.r793_caller_begin();
	perform pg_temp.r793_send('a-wrong-token-0123456789abcdef');
	if pg_temp.r793_waited_for('caller', current_setting('qorpera_test.r793_holder_pid')::integer) then
		perform dblink_exec('r793_holder', 'rollback');
		raise exception 'A refused native host call waited for the job row: %', pg_temp.r793_collect('r793_caller'); end if;
	v_outcome := pg_temp.r793_collect('r793_caller');
	perform dblink_exec('r793_caller', 'rollback');
	perform dblink_exec('r793_holder', 'rollback');
	if v_outcome ->> 'state' is distinct from '42501' or v_outcome ->> 'error' is distinct from 'native host call is refused' then
		raise exception 'A wrong token was not refused: %', v_outcome; end if;
end $$;

-- 2. The right token, with nobody holding the job: the call runs.
do $$
declare v_outcome jsonb;
begin
	perform pg_temp.r793_caller_begin();
	perform pg_temp.r793_send(current_setting('qorpera_test.g2_token'));
	v_outcome := pg_temp.r793_collect('r793_caller');
	perform dblink_exec('r793_caller', 'rollback');
	if v_outcome ? 'error' then raise exception 'The right token was refused: %', v_outcome; end if;
end $$;

-- 3. A company reader through the entry point keeps its shared lock on the company (qorpera_company_fence_shared reads
--    the called function's RPC path): while the call's transaction is open, another connection still takes the
--    company row FOR SHARE at once, but not FOR UPDATE.
do $$
declare v_profile uuid := (select profile_id from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid);
	v_share text; v_update text;
begin
	perform pg_temp.r793_caller_begin();
	perform * from dblink('r793_caller', pg_temp.r793_call_sql(current_setting('qorpera_test.g2_token')), false) as r(result jsonb);
	if dblink_error_message('r793_caller') <> 'OK' then
		perform dblink_exec('r793_caller', 'rollback');
		raise exception 'The reader call failed: %', dblink_error_message('r793_caller'); end if;
	perform * from dblink('r793_holder', format('select 1 from public.qorpera_profiles where id = %L for share nowait', v_profile),
		false) as held(one integer);
	v_share := dblink_error_message('r793_holder');
	perform * from dblink('r793_holder', format('select 1 from public.qorpera_profiles where id = %L for update nowait', v_profile),
		false) as held(one integer);
	v_update := dblink_error_message('r793_holder');
	perform dblink_exec('r793_caller', 'rollback');
	if v_share <> 'OK' then raise exception 'A reader through the entry point locked the company exclusively: %', v_share; end if;
	if v_update = 'OK' then raise exception 'The reader held no lock on the company to test'; end if;
end $$;

select pg_temp.r793_cleanup();
