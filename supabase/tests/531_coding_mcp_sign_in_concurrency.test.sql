-- @fixture 530_coding_mcp_sign_ins.test.sql until "-- 1. The origin, the header and the name ---"
-- F3 step 5j-6a (migration 20260930440000, review r1 of #1159): the broker's relay reads against a demotion of the
-- session's member, on 530's fixture with 529's harness. The reads take the session member's row at rank 1 (shared)
-- before they wait for anything else, so the member's step-down to viewer (that row FOR UPDATE at rank 1) cannot commit
-- while one serves, and one that commits while a read waits is read:
-- 1. A sign-in read waiting for a rotation of the company's sign-in holds the member's row: the owner's step-down
--    waits for the read there, the read serves the rotated version, then the step-down lands and the next read is
--    refused.
-- 2. A sign-in read waiting behind an open step-down sees it once it commits: refused.
-- 3. The same for 5j-1's environment read (qorpera_authorize_coding_environment, patched by 20260930440000).
-- Alice (the owner, …01) holds the session; the administrator (…04) is made a founder first, so Alice may step down,
-- and makes her a founder again between the cases.

-- The company's sign-in for Linear (the administrator's), and the administrator made a founder.
do $$
declare v_result text; v_completed text;
begin
	v_result := pg_temp.mcp_begin('92400000-0000-4000-8000-000000000004', 'company', 'https://mcp.linear.app');
	perform pg_temp.base_assert(v_result like 'ok:%', 'the company''s begin: ' || v_result);
	v_completed := pg_temp.mcp_complete(v_result, 'company-1');
	perform pg_temp.base_assert(v_completed like 'ok:%', 'the company''s completion: ' || v_completed);
	perform set_config('qorpera_test.r531_secret', substring(v_result from 4)::jsonb #>> '{scope,secretId}', false);
	v_result := pg_temp.mcp_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'owner'));
	perform pg_temp.base_assert(substring(v_result from 4)::jsonb ->> 'role' = 'owner',
		'the administrator made a founder: ' || v_result);
end $$;

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (529's
-- harness): the test refuses to run beside other connections to this database, whose rows the cleanup could not tell
-- from its own. The claimed session's worker and lease are kept past the commit.
reset role;
select set_config('qorpera_test.r531_worker', current_setting('qorpera_test.mcp_worker'), false);
select set_config('qorpera_test.r531_lease', current_setting('qorpera_test.mcp_lease'), false);
select set_config('qorpera_test.r531_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r531_' || name, 'dbname=' || current_database())
from unnest(array['hold','broker','member']) name \g /dev/null
select set_config('qorpera_test.r531_' || name || '_pid', pid::text, false)
from unnest(array['hold','broker','member']) name,
	lateral dblink('r531_' || name, 'select pg_backend_pid()') as backend(pid integer) \g /dev/null
create function pg_temp.r531_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r531_hold_pid'),
			current_setting('qorpera_test.r531_broker_pid'), current_setting('qorpera_test.r531_member_pid'))) then
		raise exception 'Broker race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r531_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r531_counts as select * from dblink('r531_hold', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname,
			class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema')
		and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r531_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint;
	v_first xid := current_setting('qorpera_test.r531_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r531_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r531_rows select v_table, kept.row_value
			from dblink('r531_hold', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- The broker connection is the broker's own login; the member connection is Alice's, as PostgREST gives it.
select dblink_exec('r531_broker', $q$set request.jwt.claims = '{}'$q$) \g /dev/null
select dblink_exec('r531_broker', 'set session authorization qorpera_secret_broker') \g /dev/null
select dblink_exec('r531_member', $q$set request.jwt.claims =
	'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000001"}'$q$) \g /dev/null
select dblink_exec('r531_member', 'set role authenticated') \g /dev/null

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r531_collect(p_connection text) returns jsonb language plpgsql as $$
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
create function pg_temp.r531_waits(p_waiter text, p_holder text, p_table regclass) returns boolean
language plpgsql as $$
declare
	v_pid integer := current_setting('qorpera_test.r531_' || p_waiter || '_pid')::integer;
	v_holder integer := current_setting('qorpera_test.r531_' || p_holder || '_pid')::integer;
	v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if v_holder = any(pg_blocking_pids(v_pid)) and exists (select 1 from pg_catalog.pg_locks as held
			where held.pid = v_pid and held.locktype = 'tuple' and held.relation = p_table) then return true; end if;
		exit when dblink_is_busy('r531_' || p_waiter) = 0 or clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;

-- At the end: remove what the test committed, as 529 does.
create function pg_temp.r531_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}';
	v_first xid := current_setting('qorpera_test.r531_first_xid')::xid;
begin
	perform pg_temp.r531_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r531_hold','r531_broker','r531_member']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema')
			and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r531_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s
			from (select (jsonb_populate_record(null::%1$s, kept.row_value)).* from pg_temp.r531_rows kept
				where kept.table_name = %3$L
					and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored',
			v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r531_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table)
		into v_count;
		if v_count > 0 then
			v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r531_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Broker race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- The broker's sign-in read for Linear, and its environment read, for the claimed session as the executor's lease
-- gives it.
create function pg_temp.r531_read() returns text language sql as $$
	select format('select public.qorpera_authorize_coding_mcp_sign_in(%L, %L, %L, %L, %L, %L)',
		'53000000-0000-4000-8000-000000000040', repeat('9', 64), current_setting('qorpera_test.r531_worker'),
		current_setting('qorpera_test.r531_lease'), 'exec-530', 'https://mcp.linear.app')
$$;
create function pg_temp.r531_environment() returns text language sql as $$
	select format('select public.qorpera_authorize_coding_environment(%L, %L, %L, %L, %L)',
		'53000000-0000-4000-8000-000000000040', repeat('9', 64), current_setting('qorpera_test.r531_worker'),
		current_setting('qorpera_test.r531_lease'), 'exec-530')
$$;
-- What a sign-in read served, as ownerKind.version:envelope tag; an environment read's secrets, as their count; an
-- error as state:message.
create function pg_temp.r531_served(p_outcome jsonb) returns text language sql as $$
	select case
		when p_outcome ? 'error' then (p_outcome ->> 'state') || ':' || (p_outcome ->> 'error')
		when p_outcome -> 'result' ? 'secrets' then 'secrets:' || jsonb_array_length(p_outcome -> 'result' -> 'secrets')
		when p_outcome -> 'result' -> 'signIn' = 'null'::jsonb then 'none'
		else (p_outcome #>> '{result,signIn,ownerKind}') || '.' || (p_outcome #>> '{result,signIn,secretVersion}') || ':'
			|| convert_from(decode(p_outcome #>> '{result,signIn,encryptedEnvelopeBase64}', 'base64'), 'UTF8') end
$$;
-- A read sent and collected on the broker connection.
create function pg_temp.r531_now(p_sql text) returns text language plpgsql as $$
begin
	perform dblink_send_query('r531_broker', p_sql);
	return pg_temp.r531_served(pg_temp.r531_collect('r531_broker'));
end $$;
-- Alice steps down to viewer.
create function pg_temp.r531_step_down() returns text language sql as $$
	select format('select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'viewer')
$$;
-- The administrator, a founder, makes Alice a founder again on the holder's connection (committed there, so the
-- broker reads it); her session's reads serve again.
create function pg_temp.r531_restore() returns void language plpgsql as $$
declare v_member jsonb;
begin
	perform dblink_exec('r531_hold', $q$set request.jwt.claims =
		'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000004"}'$q$);
	perform dblink_exec('r531_hold', 'set role authenticated');
	select member into strict v_member from dblink('r531_hold', format(
		'select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'owner')) as changed(member jsonb);
	perform dblink_exec('r531_hold', 'reset role');
	perform dblink_exec('r531_hold', 'reset request.jwt.claims');
	perform pg_temp.base_assert(v_member ->> 'role' = 'owner'
			and pg_temp.r531_now(pg_temp.r531_read()) = 'company.2:mcp envelope company-2'
			and pg_temp.r531_now(pg_temp.r531_environment()) = 'secrets:0',
		format('Alice restored, her session''s reads serve again: %s, %s, %s', v_member,
			pg_temp.r531_now(pg_temp.r531_read()), pg_temp.r531_now(pg_temp.r531_environment())));
end $$;

-- 0. Before any change both reads serve the session.
do $$
begin
	perform pg_temp.base_assert(pg_temp.r531_now(pg_temp.r531_read()) = 'company.1:mcp envelope company-1'
		and pg_temp.r531_now(pg_temp.r531_environment()) = 'secrets:0',
		format('0: the reads before any change: %s, %s', pg_temp.r531_now(pg_temp.r531_read()),
			pg_temp.r531_now(pg_temp.r531_environment())));
end $$;

-- 1. The holder rotates the company's sign-in to version 2 and keeps it. The sign-in read waits for it at the secret,
--    holding Alice's member row; her step-down waits for the read there. The holder commits: the read serves version 2,
--    then the step-down lands, and the next read is refused.
do $$
declare v_read jsonb; v_step_down jsonb; v_next text;
begin
	perform dblink_exec('r531_hold', 'begin');
	perform dblink_exec('r531_hold', 'set local session_replication_role = replica');
	perform dblink_exec('r531_hold', format($q$insert into public.qorpera_cloud_secret_versions(secret_id, version,
		broker_authority_id, key_id, encrypted_envelope, envelope_sha256, created_by_user_id)
		values (%L, 2, '53000000-0000-4000-8000-000000000040', 'company-kek-1',
			convert_to('mcp envelope company-2', 'UTF8'),
			encode(extensions.digest(convert_to('mcp envelope company-2', 'UTF8'), 'sha256'), 'hex'),
			'92400000-0000-4000-8000-000000000004')$q$, current_setting('qorpera_test.r531_secret')));
	perform dblink_exec('r531_hold', format('update public.qorpera_cloud_secrets set current_version = 2 where id = %L',
		current_setting('qorpera_test.r531_secret')));
	perform dblink_send_query('r531_broker', pg_temp.r531_read());
	if not pg_temp.r531_waits('broker', 'hold', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('r531_hold', 'rollback');
		raise exception '1: the read must wait for the rotation at the secret: %', pg_temp.r531_collect('r531_broker');
	end if;
	perform dblink_send_query('r531_member', pg_temp.r531_step_down());
	if not pg_temp.r531_waits('member', 'broker', 'public.qorpera_profile_members') then
		perform dblink_exec('r531_hold', 'rollback');
		raise exception '1: the step-down must wait for the read at the member row: %, %',
			pg_temp.r531_collect('r531_broker'), pg_temp.r531_collect('r531_member');
	end if;
	perform dblink_exec('r531_hold', 'commit');
	v_read := pg_temp.r531_collect('r531_broker');
	v_step_down := pg_temp.r531_collect('r531_member');
	v_next := pg_temp.r531_now(pg_temp.r531_read());
	perform pg_temp.base_assert(pg_temp.r531_served(v_read) = 'company.2:mcp envelope company-2'
			and v_step_down #>> '{result,role}' = 'viewer'
			and v_next = '42501:coding session member is unavailable',
		format('1: the read during the rotation and the step-down did not both land in turn: %s, %s, %s',
			pg_temp.r531_served(v_read), v_step_down, v_next));
end $$;

-- 2. Alice's step-down is open; the sign-in read waits for it at her member row. It commits: the read is refused.
select pg_temp.r531_restore();
do $$
declare v_step_down jsonb; v_read jsonb;
begin
	perform dblink_exec('r531_member', 'begin');
	select result into strict v_step_down from dblink('r531_member', pg_temp.r531_step_down()) as call(result jsonb);
	perform dblink_send_query('r531_broker', pg_temp.r531_read());
	if not pg_temp.r531_waits('broker', 'member', 'public.qorpera_profile_members') then
		perform dblink_exec('r531_member', 'rollback');
		raise exception '2: the read must wait for the open step-down at the member row: %, %', v_step_down,
			pg_temp.r531_collect('r531_broker');
	end if;
	perform dblink_exec('r531_member', 'commit');
	v_read := pg_temp.r531_collect('r531_broker');
	perform pg_temp.base_assert(v_step_down ->> 'role' = 'viewer'
			and pg_temp.r531_served(v_read) = '42501:coding session member is unavailable',
		format('2: the read behind the step-down served: %s, %s', v_step_down, pg_temp.r531_served(v_read)));
end $$;

-- 3. The same for the environment read.
select pg_temp.r531_restore();
do $$
declare v_step_down jsonb; v_read jsonb;
begin
	perform dblink_exec('r531_member', 'begin');
	select result into strict v_step_down from dblink('r531_member', pg_temp.r531_step_down()) as call(result jsonb);
	perform dblink_send_query('r531_broker', pg_temp.r531_environment());
	if not pg_temp.r531_waits('broker', 'member', 'public.qorpera_profile_members') then
		perform dblink_exec('r531_member', 'rollback');
		raise exception '3: the environment read must wait for the open step-down at the member row: %, %', v_step_down,
			pg_temp.r531_collect('r531_broker');
	end if;
	perform dblink_exec('r531_member', 'commit');
	v_read := pg_temp.r531_collect('r531_broker');
	perform pg_temp.base_assert(v_step_down ->> 'role' = 'viewer'
			and pg_temp.r531_served(v_read) = '42501:coding session member is unavailable',
		format('3: the environment read behind the step-down served: %s, %s', v_step_down, pg_temp.r531_served(v_read)));
end $$;

select pg_temp.r531_cleanup();
