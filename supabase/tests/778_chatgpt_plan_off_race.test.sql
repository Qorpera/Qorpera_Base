-- @fixture 764_chatgpt_plan_login.test.sql until "-- The plan login's own checks start here"
-- A member turns their ChatGPT plan off while an agent's routine save on folder-v2 runs
-- qorpera_ensure_unattended_sponsor (ported from snapshot-v1 in the legacy sweep; Sign in with ChatGPT, 20260928369980,
-- #628 review; 20260930095000): the save waits for the member's lock on the connection, then reads the newest version
-- again under the lock and leaves an "off" plan off, binding nothing; once the member turns it on again, the save binds
-- the plan as it is, with no version of its own. Test 764's fixture leaves the owner with a plan login.

-- The member has turned their plan on with their switch; their other logins are revoked, so an agent's
-- routine save for them picks the plan.
reset role;
do $$
declare v_plan uuid;
begin
	select version.connection_id into strict v_plan from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' and version.version = 1;
	perform set_config('qorpera_test.r778_plan', v_plan::text, false);
end $$;
select set_config('request.jwt.claims', '{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}', false);
set local role authenticated;
select set_config('qorpera_test.r778_on', public.qorpera_set_chatgpt_plan_work_while_away('92400000-0000-4000-8000-000000000010',
	current_setting('qorpera_test.r778_plan')::uuid, true)::text, false);
-- The agent's run is paid by the plan (a run of the member's conversation on it): since 20260930095000 its routine is
-- prepared only on the login its run pays with.
select set_config('qorpera_test.r778_binding', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', '77800000-0000-4000-8000-0000000000b1', current_setting('qorpera_test.r778_plan')::uuid,
	(current_setting('qorpera_test.r778_on')::jsonb ->> 'version')::bigint, false)::text, false);
reset role;
update public.qorpera_provider_connections set status = 'revoked'
where profile_id = '92400000-0000-4000-8000-000000000010' and owner_user_id = '92400000-0000-4000-8000-000000000001'
	and id <> current_setting('qorpera_test.r778_plan')::uuid and status = 'active';

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (the
-- harness of 746): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.r778_plan','qorpera_test.r778_binding']) name;
select set_config('qorpera_test.r778_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r778_member', 'dbname=' || current_database());
select dblink_connect('r778_agent', 'dbname=' || current_database());
select set_config('qorpera_test.r778_' || name || '_pid', pid::text, false)
from unnest(array['member','agent']) name, lateral dblink('r778_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r778_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r778_member_pid'),
			current_setting('qorpera_test.r778_agent_pid'))) then
		raise exception 'Plan off race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r778_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r778_counts as select * from dblink('r778_member', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r778_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r778_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r778_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r778_rows select v_table, kept.row_value
			from dblink('r778_member', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r778_collect(p_connection text) returns jsonb language plpgsql as $$
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
create function pg_temp.r778_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r778_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r778_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;

-- At the end: remove what the test committed, as 746 does.
create function pg_temp.r778_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r778_first_xid')::xid;
begin
	perform pg_temp.r778_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r778_member','r778_agent']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r778_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r778_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r778_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r778_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Plan off race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- What an agent's routine save for the member asks for: the sponsor it binds, or none.
create function pg_temp.r778_send_ensure() returns void language plpgsql as $$
begin
	perform dblink_send_query('r778_agent', format($q$select to_jsonb(coalesce((select string_agg(sponsor.binding_id::text, ',')
		from public.qorpera_ensure_unattended_sponsor(jsonb_populate_record(null::public.qorpera_execution_runs,
			jsonb_build_object('profile_id', '92400000-0000-4000-8000-000000000010',
				'requested_by_user_id', '92400000-0000-4000-8000-000000000001', 'source_kind', 'routine',
				'sponsor_binding_id', %L, 'sponsor_version', %s))) as sponsor), 'none'))$q$,
		current_setting('qorpera_test.r778_binding')::jsonb ->> 'binding_id',
		current_setting('qorpera_test.r778_binding')::jsonb ->> 'version'));
end $$;
-- The plan's versions, oldest first: whether each is on, and whose consent it records.
create function pg_temp.r778_versions() returns jsonb language sql as $$
	select jsonb_agg(jsonb_build_array(version.version, version.allow_autonomous, version.consent_version) order by version.version)
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = current_setting('qorpera_test.r778_plan')::uuid
$$;

-- 1. The member turns the plan off and has not committed yet. The routine save waits for them, then leaves
--    the plan off and binds nothing.
do $$
declare v_ensure jsonb; v_versions jsonb;
begin
	if pg_temp.r778_versions() -> -1 ->> 1 <> 'true' then
		raise exception 'Plan off race: the plan is not on before the race: %', pg_temp.r778_versions(); end if;
	perform dblink_exec('r778_member', 'begin');
	perform * from dblink('r778_member', $q$select set_config('request.jwt.claims',
		'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}', true)$q$) as claims(claims text);
	perform dblink_exec('r778_member', 'set local role authenticated');
	perform * from dblink('r778_member', format(
		'select public.qorpera_consent_provider_connection_autonomous(%L, %L, false)::text',
		'92400000-0000-4000-8000-000000000010', current_setting('qorpera_test.r778_plan'))) as turned(result text);
	perform pg_temp.r778_send_ensure();
	if not pg_temp.r778_waited_for('agent', current_setting('qorpera_test.r778_member_pid')::integer) then
		perform dblink_exec('r778_member', 'rollback');
		raise exception 'Plan off race: the routine save did not wait for the member: %', pg_temp.r778_collect('r778_agent'); end if;
	perform dblink_exec('r778_member', 'commit');
	v_ensure := pg_temp.r778_collect('r778_agent');
	v_versions := pg_temp.r778_versions();
	if v_ensure is distinct from '{"result": "none"}'::jsonb or v_versions -> -1 ->> 1 <> 'false'
		or v_versions -> -1 ->> 2 <> 'qorpera-native-provider-autonomous-consent/v1' then
		raise exception 'Plan off race: the routine save turned the plan back on: %, versions %', v_ensure, v_versions; end if;
end $$;

-- 2. Once the member turns it on again, the same routine save binds the plan as it is, with no version of its
--    own.
do $$
declare v_before jsonb; v_ensure jsonb;
begin
	perform dblink_exec('r778_member', 'begin');
	perform * from dblink('r778_member', $q$select set_config('request.jwt.claims',
		'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}', true)$q$) as claims(claims text);
	perform dblink_exec('r778_member', 'set local role authenticated');
	perform * from dblink('r778_member', format(
		'select public.qorpera_set_chatgpt_plan_work_while_away(%L, %L, true)::text',
		'92400000-0000-4000-8000-000000000010', current_setting('qorpera_test.r778_plan'))) as turned(result text);
	perform dblink_exec('r778_member', 'commit');
	v_before := pg_temp.r778_versions();
	perform pg_temp.r778_send_ensure();
	v_ensure := pg_temp.r778_collect('r778_agent');
	if v_ensure ? 'error' or v_ensure ->> 'result' = 'none' or pg_temp.r778_versions() is distinct from v_before
		or v_before -> -1 ->> 1 <> 'true' then
		raise exception 'Plan off race: a routine save on a plan that is on: %, versions %', v_ensure, pg_temp.r778_versions(); end if;
end $$;

select pg_temp.r778_cleanup();
