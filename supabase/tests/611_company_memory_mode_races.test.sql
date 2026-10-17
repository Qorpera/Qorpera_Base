-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- C5 (20260930508000, review r1 of #1273): the company's memory choice against a demotion of the member making it,
-- across connections. The choice takes the company row KEY SHARE, then its maker's member row shared, before it waits
-- for the choice's row, and checks the role it read there:
-- 1. An administrator's choice waiting for another choice holds their member row: the owner's demotion of them waits
--    for it, the choice lands as an administrator's, and the demotion lands after it.
-- 2. A choice waiting behind an open demotion of its maker reads it once it commits: refused, and nothing is written.
-- Test 924's company is put on the operator's test list, so its administrator may choose Shared context — Beta.

-- Row locks show only across connections, so 924's fixture is committed here and removed again at the end (969's
-- harness): the test refuses to run beside other connections to this database, whose rows the cleanup could not tell
-- from its own.
reset role;
select set_config('qorpera_test.r611_first_xid', xid(pg_current_xact_id())::text, false);
insert into public.qorpera_memory_tree_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
select dblink_connect('r611_' || name, 'dbname=' || current_database()) from unnest(array['hold','setter','owner']) name;
select set_config('qorpera_test.r611_' || name || '_pid', pid::text, false)
from unnest(array['hold','setter','owner']) name, lateral dblink('r611_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r611_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r611_hold_pid'),
			current_setting('qorpera_test.r611_setter_pid'), current_setting('qorpera_test.r611_owner_pid'))) then
		raise exception 'Memory mode race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r611_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r611_counts as select * from dblink('r611_hold', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r611_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r611_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r611_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r611_rows select v_table, kept.row_value
			from dblink('r611_hold', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r611_collect(p_connection text) returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result('r611_' || p_connection) as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result('r611_' || p_connection, false) as call(result jsonb);
	return v_outcome;
end
$$;
-- Whether the connection's call waits for a lock p_by holds before it finishes (10 s at most).
create function pg_temp.r611_waited_for(p_connection text, p_by text) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r611_' || p_connection || '_pid')::integer;
	v_by integer := current_setting('qorpera_test.r611_' || p_by || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r611_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;

-- At the end: remove what the test committed, as 969 does.
create function pg_temp.r611_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r611_first_xid')::xid;
begin
	perform pg_temp.r611_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r611_hold','r611_setter','r611_owner']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r611_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r611_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r611_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r611_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Memory mode race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- A member's call on a connection, sent and left running in an open transaction there, signed in as PostgREST does.
create function pg_temp.r611_send(p_connection text, p_user uuid, p_call text) returns void language plpgsql as $$
begin
	perform dblink_exec('r611_' || p_connection, 'begin');
	perform * from dblink('r611_' || p_connection, format('select set_config(''request.jwt.claims'', %L, true)',
		jsonb_build_object('sub', p_user, 'role', 'authenticated')::text)) as claims(claims text);
	perform dblink_exec('r611_' || p_connection, 'set local role authenticated');
	perform dblink_send_query('r611_' || p_connection, p_call);
end $$;
-- A choice of the company's memory, and the administrator's (…04) role changed by the owner (…01).
create function pg_temp.r611_choose(p_mode text) returns text language sql as $$
	select format('select public.qorpera_set_company_memory_mode(%L, %L)', '92400000-0000-4000-8000-000000000010', p_mode)
$$;
create function pg_temp.r611_make(p_role text) returns text language sql as $$
	select format('select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', p_role)
$$;
-- What is committed: the company's choice ('-' for none) and the administrator's role.
create function pg_temp.r611_choice() returns text language sql as $$
	select coalesce((select mode from public.qorpera_company_memory_modes where profile_id = '92400000-0000-4000-8000-000000000010'), '-')
$$;
create function pg_temp.r611_role() returns text language sql as $$
	select role::text from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'
		and user_id = '92400000-0000-4000-8000-000000000004'
$$;

-- 1. The holder writes a choice and keeps it open (as the platform; the table is closed to the API roles). The
--    administrator's choice waits for it at the choice's row, holding their member row, so the owner's demotion of them
--    waits for that choice. The holder commits: the choice lands, then the demotion.
do $$
declare v_choice jsonb; v_demotion jsonb;
begin
	if pg_temp.r611_choice() <> '-' or pg_temp.r611_role() <> 'admin' then
		raise exception 'Memory race 1: the fixture has a choice or no administrator: %, %', pg_temp.r611_choice(), pg_temp.r611_role(); end if;
	perform dblink_exec('r611_hold', 'begin');
	perform dblink_exec('r611_hold', $q$insert into public.qorpera_company_memory_modes(profile_id, mode)
		values ('92400000-0000-4000-8000-000000000010', 'notebooks')$q$);
	perform pg_temp.r611_send('setter', '92400000-0000-4000-8000-000000000004', pg_temp.r611_choose('tree'));
	if not pg_temp.r611_waited_for('setter', 'hold') then
		perform dblink_exec('r611_hold', 'rollback');
		raise exception 'Memory race 1: the choice did not wait for the open one: %', pg_temp.r611_collect('setter'); end if;
	perform pg_temp.r611_send('owner', '92400000-0000-4000-8000-000000000001', pg_temp.r611_make('contributor'));
	if not pg_temp.r611_waited_for('owner', 'setter') then
		perform dblink_exec('r611_hold', 'rollback');
		raise exception 'Memory race 1: the demotion did not wait for the waiting choice: %', pg_temp.r611_collect('owner'); end if;
	perform dblink_exec('r611_hold', 'commit');
	v_choice := pg_temp.r611_collect('setter');
	perform dblink_exec('r611_setter', 'commit');
	v_demotion := pg_temp.r611_collect('owner');
	perform dblink_exec('r611_owner', 'commit');
	if v_choice #>> '{result,mode}' is distinct from 'tree' or v_choice #>> '{result,effective}' is distinct from 'tree' then
		raise exception 'Memory race 1: the administrator''s choice: %', v_choice; end if;
	if v_demotion #>> '{result,role}' is distinct from 'contributor' or pg_temp.r611_role() <> 'contributor'
		or pg_temp.r611_choice() <> 'tree' then
		raise exception 'Memory race 1: the demotion after the choice: %, %, %', v_demotion, pg_temp.r611_role(), pg_temp.r611_choice(); end if;
end $$;

-- Between the cases: the owner makes them an administrator again, and the choice goes.
do $$
declare v_promotion jsonb;
begin
	perform pg_temp.r611_send('owner', '92400000-0000-4000-8000-000000000001', pg_temp.r611_make('admin'));
	v_promotion := pg_temp.r611_collect('owner');
	perform dblink_exec('r611_owner', 'commit');
	if v_promotion #>> '{result,role}' is distinct from 'admin' then
		raise exception 'Memory race: the administrator made one again: %', v_promotion; end if;
end $$;
delete from public.qorpera_company_memory_modes where profile_id = '92400000-0000-4000-8000-000000000010';

-- 2. The owner's demotion of the administrator is open. The administrator's choice passes the check before its locks,
--    then waits for the demotion at their member row; the demotion commits, and the choice reads it there: refused.
do $$
declare v_demotion jsonb; v_choice jsonb;
begin
	if pg_temp.r611_choice() <> '-' or pg_temp.r611_role() <> 'admin' then
		raise exception 'Memory race 2: a choice is left or no administrator: %, %', pg_temp.r611_choice(), pg_temp.r611_role(); end if;
	perform pg_temp.r611_send('owner', '92400000-0000-4000-8000-000000000001', pg_temp.r611_make('contributor'));
	v_demotion := pg_temp.r611_collect('owner');
	if v_demotion #>> '{result,role}' is distinct from 'contributor' then
		perform dblink_exec('r611_owner', 'rollback');
		raise exception 'Memory race 2: the open demotion: %', v_demotion; end if;
	perform pg_temp.r611_send('setter', '92400000-0000-4000-8000-000000000004', pg_temp.r611_choose('tree'));
	if not pg_temp.r611_waited_for('setter', 'owner') then
		perform dblink_exec('r611_owner', 'rollback');
		raise exception 'Memory race 2: the choice did not wait for the open demotion: %', pg_temp.r611_collect('setter'); end if;
	perform dblink_exec('r611_owner', 'commit');
	v_choice := pg_temp.r611_collect('setter');
	perform dblink_exec('r611_setter', 'rollback');
	if v_choice ->> 'state' is distinct from '42501'
		or v_choice ->> 'error' is distinct from 'Only owners and admins change the company''s memory' then
		raise exception 'Memory race 2: the choice behind the demotion: %', v_choice; end if;
	if pg_temp.r611_choice() <> '-' or pg_temp.r611_role() <> 'contributor' then
		raise exception 'Memory race 2: after the refusal: %, %', pg_temp.r611_choice(), pg_temp.r611_role(); end if;
end $$;

select pg_temp.r611_cleanup();
