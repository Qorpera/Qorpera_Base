-- @fixture 396_runtime_coding_executor.test.sql until "-- END DISPATCH FIXTURE"
-- A committed fixture for tests that make real calls meet across connections: 396's dispatch, committed here and
-- removed again at the end, with three more connections, the exclusive-database guard and the exact cleanup. Its
-- coding lock-order races are gone since C1c-3i (20260930026000): coding sessions serve folder-v2 only, and this
-- fixture is snapshot-v1. The test refuses to run beside other connections to this database, whose rows the cleanup
-- could not tell from its own.

-- What the dependents need outlives this transaction.
reset role;
select set_config(name, current_setting(name), false) from unnest(array['qorpera_test.parent_binding']) name;
select set_config('qorpera_test.lock_order_first_xid', xid(pg_current_xact_id())::text, false);
-- Three more connections to this same database, whatever the runner named it (a copy made from a
-- template has another name, and its calls would otherwise land in a database without the fixture).
select dblink_connect('lock_holder', 'dbname=' || current_database());
select dblink_connect('lock_first', 'dbname=' || current_database());
select dblink_connect('lock_second', 'dbname=' || current_database());
select set_config('qorpera_test.lock_' || name || '_pid', pid::text, false)
from unnest(array['holder','first','second']) name, lateral dblink('lock_' || name, 'select pg_backend_pid()') as backend(pid integer);
-- Only this connection and its three may use the database while the test runs.
create function pg_temp.lock_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.lock_holder_pid'),
			current_setting('qorpera_test.lock_first_pid'), current_setting('qorpera_test.lock_second_pid'))) then
		raise exception 'Lock order test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.lock_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table lock_order_counts as select * from dblink('lock_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table lock_order_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.lock_order_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.lock_order_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.lock_order_rows select v_table, kept.row_value
			from dblink('lock_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A call runs as the role PostgREST would use, with that role's claims.
create function pg_temp.lock_as(p_connection text, p_claims jsonb) returns void language plpgsql as $$
begin
	perform dblink_exec(p_connection, 'reset role');
	perform dblink_exec(p_connection, format('set request.jwt.claims = %L', p_claims));
	perform dblink_exec(p_connection, format('set role %I', p_claims ->> 'role'));
end
$$;
-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.lock_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- The holder locks one row; the first call starts and must wait, then the second (which may instead
-- finish at once when it needs nothing the first holds); the holder lets go. Each call's result, or its error.
create function pg_temp.lock_race(p_hold text, p_first text, p_first_claims jsonb, p_second text, p_second_claims jsonb,
	p_second_waits boolean default true)
returns jsonb language plpgsql as $$
declare v_name text; v_pid integer; v_early jsonb; v_outcome jsonb := '{}'::jsonb;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	foreach v_name in array array['first','second'] loop
		perform pg_temp.lock_as('lock_' || v_name, case v_name when 'first' then p_first_claims else p_second_claims end);
		perform dblink_send_query('lock_' || v_name, case v_name when 'first' then p_first else p_second end);
		v_pid := current_setting('qorpera_test.lock_' || v_name || '_pid')::integer;
		for attempt in 1..200 loop
			exit when cardinality(pg_blocking_pids(v_pid)) > 0 or dblink_is_busy('lock_' || v_name) = 0;
			perform pg_sleep(0.025);
		end loop;
		if cardinality(pg_blocking_pids(v_pid)) = 0 and (v_name = 'first' or p_second_waits) then
			perform dblink_exec('lock_holder', 'rollback');
			v_early := pg_temp.lock_collect('lock_' || v_name);
			if v_name = 'second' then v_early := jsonb_build_object('first', pg_temp.lock_collect('lock_first'), 'second', v_early); end if;
			raise exception 'Lock race: the % call did not wait for the held row: %', v_name, v_early; end if;
	end loop;
	perform dblink_exec('lock_holder', 'rollback');
	foreach v_name in array array['first','second'] loop
		v_outcome := v_outcome || jsonb_build_object(v_name, pg_temp.lock_collect('lock_' || v_name));
	end loop;
	return v_outcome;
end
$$;
-- The holder locks one row while a single call runs: its result, or its error, and whether it waited.
create function pg_temp.lock_single(p_hold text, p_call text, p_claims jsonb) returns jsonb language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.lock_first_pid')::integer; v_waited boolean := false;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	perform pg_temp.lock_as('lock_first', p_claims);
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..200 loop
		if cardinality(pg_blocking_pids(v_pid)) > 0 then v_waited := true; exit; end if;
		exit when dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('lock_holder', 'rollback');
	return pg_temp.lock_collect('lock_first') || jsonb_build_object('waited', v_waited);
end
$$;
create function pg_temp.lock_race_ok(p_outcome jsonb, p_message text) returns void language plpgsql as $$
begin
	if p_outcome #> '{first,error}' is not null or p_outcome #> '{second,error}' is not null then
		raise exception 'Lock race: %: %', p_message, p_outcome; end if;
end
$$;
create function pg_temp.lock_row(p_table text, p_column text, p_id uuid) returns text language sql as $$
	select format('select 1 from public.%I where %I = %L for update', p_table, p_column, p_id)
$$;
-- At the end: remove what the test committed. Every row written since the fixture's first write goes,
-- with triggers and foreign-key checks off, and the rows it changed come back as they were. Every table
-- must hold again exactly what other connections saw before.
create function pg_temp.lock_order_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.lock_order_first_xid')::xid;
begin
	perform pg_temp.lock_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['lock_holder','lock_first','lock_second']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.lock_order_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.lock_order_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.lock_order_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.lock_order_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Lock order cleanup left other row counts: %', v_wrong; end if;
end $$;

-- END COMMITTED FIXTURE (608, 745, 754, 797 and 800 cut here).

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
