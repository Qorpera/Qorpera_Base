-- @fixture 528_coding_environment_broker.test.sql until "-- 1. What serves ---"
-- F3 step 5j-1 (migration 20260930438000): the secret broker's read of a coding session's environment
-- (qorpera_authorize_coding_environment) against other connections, on 528's fixture. The read shares the
-- repository's live grants before it takes the secrets, so a grant it serves can't end under it, and one that ends
-- while it waits is read as ended:
-- 1. A read waiting for a rotation of a granted secret holds that secret's grant: the owner's withdrawal waits for the
--    read at the grant, the read serves the rotated version, then the withdrawal lands.
-- 2. A read waiting behind an open withdrawal sees it once it commits: the member's own shared_name (74) serves
--    instead.
-- 3. The same behind the administrator's demotion: admin_key (78) no longer serves.

-- Row locks show only across connections, so 528's fixture is committed here and removed again at the end (969's
-- harness): the test refuses to run beside other connections to this database, whose rows the cleanup could not tell
-- from its own. The claimed session's worker and lease are kept past the commit.
reset role;
select set_config('qorpera_test.r529_worker', current_setting('qorpera_test.env_worker'), false);
select set_config('qorpera_test.r529_lease', current_setting('qorpera_test.env_lease'), false);
select set_config('qorpera_test.r529_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r529_' || name, 'dbname=' || current_database())
from unnest(array['hold','broker','member']) name \g /dev/null
select set_config('qorpera_test.r529_' || name || '_pid', pid::text, false)
from unnest(array['hold','broker','member']) name,
	lateral dblink('r529_' || name, 'select pg_backend_pid()') as backend(pid integer) \g /dev/null
create function pg_temp.r529_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r529_hold_pid'),
			current_setting('qorpera_test.r529_broker_pid'), current_setting('qorpera_test.r529_member_pid'))) then
		raise exception 'Broker race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r529_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r529_counts as select * from dblink('r529_hold', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname,
			class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema')
		and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r529_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint;
	v_first xid := current_setting('qorpera_test.r529_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r529_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r529_rows select v_table, kept.row_value
			from dblink('r529_hold', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- The broker connection is the broker's own login; the member connection is the owner's, as PostgREST gives it.
select dblink_exec('r529_broker', $q$set request.jwt.claims = '{}'$q$) \g /dev/null
select dblink_exec('r529_broker', 'set session authorization qorpera_secret_broker') \g /dev/null
select dblink_exec('r529_member', $q$set request.jwt.claims =
	'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000001"}'$q$) \g /dev/null
select dblink_exec('r529_member', 'set role authenticated') \g /dev/null

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r529_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- Whether the waiter's sent call comes to wait for the holder at a row of p_table (60 s at most): it holds or queues
-- for that row's tuple lock while blocked (800's). False as soon as the call finishes without waiting.
create function pg_temp.r529_waits(p_waiter text, p_holder text, p_table regclass) returns boolean
language plpgsql as $$
declare
	v_pid integer := current_setting('qorpera_test.r529_' || p_waiter || '_pid')::integer;
	v_holder integer := current_setting('qorpera_test.r529_' || p_holder || '_pid')::integer;
	v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if v_holder = any(pg_blocking_pids(v_pid)) and exists (select 1 from pg_catalog.pg_locks as held
			where held.pid = v_pid and held.locktype = 'tuple' and held.relation = p_table) then return true; end if;
		exit when dblink_is_busy('r529_' || p_waiter) = 0 or clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;

-- At the end: remove what the test committed, as 969 does.
create function pg_temp.r529_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}';
	v_first xid := current_setting('qorpera_test.r529_first_xid')::xid;
begin
	perform pg_temp.r529_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r529_hold','r529_broker','r529_member']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema')
			and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r529_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s
			from (select (jsonb_populate_record(null::%1$s, kept.row_value)).* from pg_temp.r529_rows kept
				where kept.table_name = %3$L
					and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored',
			v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r529_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table)
		into v_count;
		if v_count > 0 then
			v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r529_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Broker race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- The broker's read for the claimed session, as the executor's lease gives it.
create function pg_temp.r529_read() returns text language sql as $$
	select format('select public.qorpera_authorize_coding_environment(%L, %L, %L, %L, %L)',
		'52800000-0000-4000-8000-000000000040', repeat('9', 64), current_setting('qorpera_test.r529_worker'),
		current_setting('qorpera_test.r529_lease'), 'exec-528')
$$;
-- What a read served, as NAME=nn.v (the secret's last two digits and its version) in the answer's order; an error as
-- it is.
create function pg_temp.r529_served(p_outcome jsonb) returns text language sql as $$
	select case when p_outcome ? 'result' then coalesce((
		select string_agg((e ->> 'name') || '=' || right(e ->> 'secretId', 2) || '.' || (e ->> 'secretVersion'), ','
			order by n)
		from jsonb_array_elements(p_outcome -> 'result' -> 'secrets') with ordinality as s(e, n)), '')
		else p_outcome::text end
$$;
-- The owner's withdrawal of a secret's live grant on the session's repository.
create function pg_temp.r529_withdraw(p_secret uuid) returns text language sql as $$
	select format('select public.qorpera_revoke_coding_environment_grant(%L, %L)',
		'92400000-0000-4000-8000-000000000010', (
			select environment_grant.id from public.qorpera_coding_environment_grants as environment_grant
			where environment_grant.secret_id = p_secret and environment_grant.repository = 'qorpera/qorpera_base'
				and environment_grant.status = 'active'))
$$;

-- 1. The holder rotates npm_token (71) to version 2 and keeps it. The read waits for it at the secret, holding the
--    repository's grants; the owner's withdrawal of npm_token's grant waits for the read there. The holder commits: the
--    read serves version 2, then the withdrawal lands, and the next read leaves npm_token out.
do $$
declare v_read jsonb; v_withdrawal jsonb; v_next text;
begin
	perform dblink_exec('r529_hold', 'begin');
	perform dblink_exec('r529_hold', 'set local session_replication_role = replica');
	perform dblink_exec('r529_hold', $q$insert into public.qorpera_cloud_secret_versions(secret_id, version,
		broker_authority_id, key_id, encrypted_envelope, envelope_sha256, created_by_user_id)
		values ('52800000-0000-4000-8000-000000000071', 2, '52800000-0000-4000-8000-000000000040', 'company-kek-1',
			convert_to('envelope 71 v2', 'UTF8'),
			encode(extensions.digest(convert_to('envelope 71 v2', 'UTF8'), 'sha256'), 'hex'),
			'92400000-0000-4000-8000-000000000001')$q$);
	perform dblink_exec('r529_hold', $q$update public.qorpera_cloud_secrets set current_version = 2
		where id = '52800000-0000-4000-8000-000000000071'$q$);
	perform dblink_send_query('r529_broker', pg_temp.r529_read());
	if not pg_temp.r529_waits('broker', 'hold', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('r529_hold', 'rollback');
		raise exception '1: the read must wait for the rotation at the secret: %', pg_temp.r529_collect('r529_broker');
	end if;
	perform dblink_send_query('r529_member', pg_temp.r529_withdraw('52800000-0000-4000-8000-000000000071'));
	if not pg_temp.r529_waits('member', 'broker', 'public.qorpera_coding_environment_grants') then
		perform dblink_exec('r529_hold', 'rollback');
		raise exception '1: the withdrawal must wait for the read at the grant: %, %',
			pg_temp.r529_collect('r529_broker'), pg_temp.r529_collect('r529_member');
	end if;
	perform dblink_exec('r529_hold', 'commit');
	v_read := pg_temp.r529_collect('r529_broker');
	v_withdrawal := pg_temp.r529_collect('r529_member');
	select pg_temp.r529_served(jsonb_build_object('result', result)) into strict v_next
	from dblink('r529_broker', pg_temp.r529_read()) as call(result jsonb);
	perform pg_temp.base_assert(
		pg_temp.r529_served(v_read) = 'ADMIN_KEY=78.1,NPM_TOKEN=71.2,PERSONAL_KEY=75.1,SHARED_NAME=73.1'
			and v_withdrawal #>> '{result,status}' = 'revoked'
			and v_next = 'ADMIN_KEY=78.1,PERSONAL_KEY=75.1,SHARED_NAME=73.1',
		format('1: the read during the rotation and the withdrawal did not both land in turn: %s, %s, %s',
			pg_temp.r529_served(v_read), v_withdrawal, v_next));
end $$;

-- 2. The owner's withdrawal of shared_name's grant (73) is open; the read waits for it at the grant. It commits: the
--    read serves the owner's own shared_name (74).
do $$
declare v_withdrawal jsonb; v_read jsonb;
begin
	perform dblink_exec('r529_member', 'begin');
	select result into strict v_withdrawal
	from dblink('r529_member', pg_temp.r529_withdraw('52800000-0000-4000-8000-000000000073')) as call(result jsonb);
	perform dblink_send_query('r529_broker', pg_temp.r529_read());
	if not pg_temp.r529_waits('broker', 'member', 'public.qorpera_coding_environment_grants') then
		perform dblink_exec('r529_member', 'rollback');
		raise exception '2: the read must wait for the open withdrawal at the grant: %, %', v_withdrawal,
			pg_temp.r529_collect('r529_broker');
	end if;
	perform dblink_exec('r529_member', 'commit');
	v_read := pg_temp.r529_collect('r529_broker');
	perform pg_temp.base_assert(v_withdrawal ->> 'status' = 'revoked'
		and pg_temp.r529_served(v_read) = 'ADMIN_KEY=78.1,PERSONAL_KEY=75.1,SHARED_NAME=74.1',
		format('2: the read behind the withdrawal served its grant: %s, %s', v_withdrawal,
			pg_temp.r529_served(v_read)));
end $$;

-- 3. The owner makes the administrator a contributor, in an open transaction; the read waits for it at the
--    administrator's grant (admin_key, 78). It commits: admin_key no longer serves.
do $$
declare v_member jsonb; v_read jsonb;
begin
	perform dblink_exec('r529_member', 'begin');
	select member into strict v_member from dblink('r529_member', format(
		'select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'contributor')) as changed(member jsonb);
	perform dblink_send_query('r529_broker', pg_temp.r529_read());
	if not pg_temp.r529_waits('broker', 'member', 'public.qorpera_coding_environment_grants') then
		perform dblink_exec('r529_member', 'rollback');
		raise exception '3: the read must wait for the open demotion at the grant: %, %', v_member,
			pg_temp.r529_collect('r529_broker');
	end if;
	perform dblink_exec('r529_member', 'commit');
	v_read := pg_temp.r529_collect('r529_broker');
	perform pg_temp.base_assert(pg_temp.r529_served(v_read) = 'PERSONAL_KEY=75.1,SHARED_NAME=74.1',
		format('3: the read behind the demotion served the administrator''s grant: %s', pg_temp.r529_served(v_read)));
end $$;

select pg_temp.r529_cleanup();
