-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member withdraws unattended-work consent on their login while an agent's work is admitted on it (20260906000700;
-- ported from snapshot-v1's production-review rehearsal in the legacy sweep, whose consent races ran on fixture 300):
-- the admission check holds the login row until it commits, so a withdrawal waits for an effect already admitted, a
-- check that waits behind a withdrawal sees it, and a repeatable-read snapshot from before a withdrawal can't use the
-- old consent. Test 924's fixture gives the owner's login a consented version 2.

-- Row locks show only across connections, so 924's fixture is committed here and removed again at the end (the
-- harness of 746): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.r969_connection', current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id', false);
select set_config('qorpera_test.r969_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r969_member', 'dbname=' || current_database());
select dblink_connect('r969_admission', 'dbname=' || current_database());
select set_config('qorpera_test.r969_' || name || '_pid', pid::text, false)
from unnest(array['member','admission']) name, lateral dblink('r969_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r969_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r969_member_pid'),
			current_setting('qorpera_test.r969_admission_pid'))) then
		raise exception 'Consent race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r969_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r969_counts as select * from dblink('r969_member', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r969_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r969_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r969_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r969_rows select v_table, kept.row_value
			from dblink('r969_member', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r969_collect(p_connection text) returns jsonb language plpgsql as $$
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
create function pg_temp.r969_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r969_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r969_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;

-- At the end: remove what the test committed, as 746 does.
create function pg_temp.r969_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r969_first_xid')::xid;
begin
	perform pg_temp.r969_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r969_member','r969_admission']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r969_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r969_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r969_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r969_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Consent race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- The owner's consent call on their login, in an open transaction on the member connection: sent and left running
-- when p_send, else run and its result returned.
create function pg_temp.r969_consent(p_allow boolean, p_send boolean default false) returns jsonb language plpgsql as $$
declare v_call text := format('select public.qorpera_consent_provider_connection_autonomous(%L, %L, %L)',
	'92400000-0000-4000-8000-000000000010', current_setting('qorpera_test.r969_connection'), p_allow);
	v_result jsonb;
begin
	perform dblink_exec('r969_member', 'begin');
	perform * from dblink('r969_member', $q$select set_config('request.jwt.claims',
		'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}', true)$q$) as claims(claims text);
	perform dblink_exec('r969_member', 'set local role authenticated');
	if p_send then perform dblink_send_query('r969_member', v_call); return null; end if;
	select result into strict v_result from dblink('r969_member', v_call) as call(result jsonb);
	return v_result;
end $$;
-- The admission check for a version of the login, as a run's sponsor asks it (qorpera_run_autonomous_authority).
create function pg_temp.r969_authority_sql(p_version bigint) returns text language sql as $$
	select format('select to_jsonb(public.qorpera_provider_autonomous_authority(%L, %s))',
		current_setting('qorpera_test.r969_connection'), p_version)
$$;
-- The same check run and committed on its own on the admission connection, so this session holds no lock on the login.
create function pg_temp.r969_authority(p_version bigint) returns jsonb language sql as $$
	select result from dblink('r969_admission', pg_temp.r969_authority_sql(p_version)) as call(result jsonb)
$$;

-- 1. An effect admitted on version 2 holds the login until it commits: the withdrawal waits for it, then fences
--    version 2.
do $$
declare v_admitted jsonb; v_withdrawal jsonb;
begin
	perform dblink_exec('r969_admission', 'begin');
	select result into strict v_admitted from dblink('r969_admission', pg_temp.r969_authority_sql(2)) as call(result jsonb);
	if v_admitted is distinct from 'true'::jsonb then
		perform dblink_exec('r969_admission', 'rollback');
		raise exception 'Consent race: version 2 is not consented before the race: %', v_admitted; end if;
	perform pg_temp.r969_consent(false, true);
	if not pg_temp.r969_waited_for('member', current_setting('qorpera_test.r969_admission_pid')::integer) then
		perform dblink_exec('r969_admission', 'rollback');
		raise exception 'Consent race: the withdrawal did not wait for the admitted effect: %', pg_temp.r969_collect('r969_member'); end if;
	perform dblink_exec('r969_admission', 'commit');
	v_withdrawal := pg_temp.r969_collect('r969_member');
	perform dblink_exec('r969_member', 'commit');
	if v_withdrawal ? 'error' or (v_withdrawal #>> '{result,allow_autonomous}')::boolean
		or pg_temp.r969_authority(2) is distinct from 'false'::jsonb then
		raise exception 'Consent race: the withdrawal after the admitted effect did not fence version 2: %', v_withdrawal; end if;
end $$;

-- 2. A check that waits behind an uncommitted withdrawal sees it once it commits: the renewed version is fenced.
do $$
declare v_renewed bigint := (pg_temp.r969_consent(true) ->> 'version')::bigint; v_checked jsonb;
begin
	perform dblink_exec('r969_member', 'commit');
	if pg_temp.r969_authority(v_renewed) is distinct from 'true'::jsonb then raise exception 'Consent race: the renewed version % is not consented', v_renewed; end if;
	perform pg_temp.r969_consent(false);
	perform dblink_send_query('r969_admission', pg_temp.r969_authority_sql(v_renewed));
	if not pg_temp.r969_waited_for('admission', current_setting('qorpera_test.r969_member_pid')::integer) then
		perform dblink_exec('r969_member', 'rollback');
		raise exception 'Consent race: the check did not wait for the withdrawal: %', pg_temp.r969_collect('r969_admission'); end if;
	perform dblink_exec('r969_member', 'commit');
	v_checked := pg_temp.r969_collect('r969_admission');
	if v_checked is distinct from '{"result": false}'::jsonb then
		raise exception 'Consent race: the check behind the withdrawal admitted version %: %', v_renewed, v_checked; end if;
end $$;

-- 3. A repeatable-read snapshot taken before a withdrawal can't admit work on the old consent: the check fails with a
--    serialization error (40001).
do $$
declare v_renewed bigint := (pg_temp.r969_consent(true) ->> 'version')::bigint; v_checked jsonb;
begin
	perform dblink_exec('r969_member', 'commit');
	perform dblink_exec('r969_admission', 'begin isolation level repeatable read');
	perform * from dblink('r969_admission', 'select count(*) from public.qorpera_provider_connection_versions') as counted(n bigint);
	perform pg_temp.r969_consent(false);
	perform dblink_exec('r969_member', 'commit');
	perform dblink_send_query('r969_admission', pg_temp.r969_authority_sql(v_renewed));
	v_checked := pg_temp.r969_collect('r969_admission');
	perform dblink_exec('r969_admission', 'rollback');
	if v_checked ->> 'state' is distinct from '40001' then
		raise exception 'Consent race: a snapshot from before the withdrawal admitted version %: %', v_renewed, v_checked; end if;
end $$;

select pg_temp.r969_cleanup();
