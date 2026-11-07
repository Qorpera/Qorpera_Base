-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The selection decides again under the lock, so it never overwrites the member's pick (20260930606000, perf sprint 7 Nov
-- 2026, measure A6). It decides first without a lock, and takes the conversation's row only when it would write. Two tabs:
-- a poll in one decides to write and waits for the row, while the member's pick in the other holds it. When the pick
-- commits, the poll must answer the pick and leave its saved row alone, not write what it decided before. Single-session
-- worlds (the other 1106, 163, 559, 581, 905, 956) cannot see this: writing the first decision passed all of them. A poll with
-- nothing to change does not wait for the row at all, and answers what is committed.
-- Row locks show only across connections, so 924's fixture is committed here and removed again at the end (467's and 674's
-- harness): the test refuses to run beside other connections to this database, whose rows the cleanup could not tell from
-- its own.

-- The owner connects login B, for work while away too, with room left. Login A has no reading, so a first choice takes B.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.a6r_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','11060000-0000-4000-8000-000000000151','11060000-0000-4000-8000-000000000152',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.a6r_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.a6r_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'11060000-0000-4000-8000-000000000160',
	'object://native-capsules/11060000-0000-4000-8000-000000000160',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.a6r_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.a6r_sponsor',public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010','11060000-0000-4000-8000-000000000161',
	(current_setting('qorpera_test.a6r_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values ((current_setting('qorpera_test.a6r_connection')::jsonb ->> 'connection_id')::uuid, 2,
	jsonb_build_object('observedAt', statement_timestamp() - interval '1 second', 'windows', jsonb_build_array(
		jsonb_build_object('id','primary','label','Week','usedPercent',20))));
select set_config('qorpera_test.a6r_bob', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031')), false);
select set_config('qorpera_test.a6r_carol', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000032')), false);

create function pg_temp.a6r(p_key text) returns uuid language sql as $$
	select case p_key
		when 'profile' then '92400000-0000-4000-8000-000000000010'::uuid
		when 'owner' then '92400000-0000-4000-8000-000000000001'::uuid
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.a6r_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.a6r_sponsor')::jsonb ->> 'binding_id')::uuid
		else current_setting('qorpera_test.a6r_' || p_key)::uuid end
$$;
create function pg_temp.a6r_saved(p_session uuid) returns jsonb language sql as $$
	select jsonb_build_object('connection', saved.connection_id, 'binding', saved.sponsor_binding_id, 'place', saved.ctid::text)
	from public.qorpera_member_session_accounts as saved
	where saved.profile_id = pg_temp.a6r('profile') and saved.session_id = p_session and saved.user_id = pg_temp.a6r('owner')
$$;

-- Committed from here on, and removed at the end.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.base_connection','qorpera_test.base_sponsor','qorpera_test.a6r_connection','qorpera_test.a6r_sponsor']) name;
select set_config('qorpera_test.a6r_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('a6r_holder', 'dbname=' || current_database());
select dblink_connect('a6r_poll', 'dbname=' || current_database());
select set_config('qorpera_test.a6r_' || name || '_pid', pid::text, false)
from unnest(array['holder','poll']) name, lateral dblink('a6r_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.a6r_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.a6r_holder_pid'), current_setting('qorpera_test.a6r_poll_pid'))) then
		raise exception 'The pick race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.a6r_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table a6r_counts as select * from dblink('a6r_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table a6r_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.a6r_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.a6r_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.a6r_rows select v_table, kept.row_value
			from dblink('a6r_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- Both connections act as the owner, in the role a member's request has.
select dblink_exec(name, 'set role authenticated') from unnest(array['a6r_holder','a6r_poll']) name;
select dblink_exec(name, format('set request.jwt.claims = %L',
	jsonb_build_object('role', 'authenticated', 'sub', pg_temp.a6r('owner'))::text)) from unnest(array['a6r_holder','a6r_poll']) name;

-- The holder picks a login in an open transaction, which holds the conversation's row. Meanwhile the poll asks. The pick commits
-- once the poll waits for the holder, or once it has answered. Answers the poll's answer, whether it waited, and where
-- the pick left the saved row: a write by the poll moves it.
create function pg_temp.a6r_race(p_session uuid, p_pick uuid) returns jsonb language plpgsql as $$
declare v_holder integer := current_setting('qorpera_test.a6r_holder_pid')::integer;
	v_poll integer := current_setting('qorpera_test.a6r_poll_pid')::integer;
	v_waited boolean := false; v_answer text; v_place text;
begin
	perform dblink_exec('a6r_holder', 'begin');
	perform * from dblink('a6r_holder', format('select public.qorpera_choose_member_session_account(%L,%L,%L)::text',
		pg_temp.a6r('profile'), p_session, p_pick)) as picked(connection text);
	-- As the holder's own transaction sees it. A member's role may not read the table, so the holder leaves it for this read.
	select place into v_place from dblink('a6r_holder', format($sql$
		reset role;
		select saved.ctid::text from public.qorpera_member_session_accounts as saved
		where saved.profile_id = %L and saved.session_id = %L and saved.user_id = %L
	$sql$, pg_temp.a6r('profile'), p_session, pg_temp.a6r('owner'))) as held(place text);
	perform dblink_exec('a6r_holder', 'set role authenticated');
	perform dblink_send_query('a6r_poll', format('select public.qorpera_select_member_session_account(%L,%L)::text',
		pg_temp.a6r('profile'), p_session));
	for attempt in 1..400 loop
		v_waited := v_holder = any(pg_blocking_pids(v_poll));
		exit when v_waited or dblink_is_busy('a6r_poll') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('a6r_holder', 'commit');
	select answer into v_answer from dblink_get_result('a6r_poll') as call(answer text);
	perform * from dblink_get_result('a6r_poll', false) as call(answer text);
	return jsonb_build_object('answer', v_answer, 'waited', v_waited, 'place', v_place);
end $$;
create function pg_temp.a6r_poll(p_session uuid) returns uuid language sql as $$
	select answer::uuid from dblink('a6r_poll', format('select public.qorpera_select_member_session_account(%L,%L)::text',
		pg_temp.a6r('profile'), p_session)) as call(answer text)
$$;
-- At the end: remove what the test committed, as 467 and 674 do.
create function pg_temp.a6r_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.a6r_first_xid')::xid;
begin
	perform pg_temp.a6r_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['a6r_holder','a6r_poll']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.a6r_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.a6r_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.a6r_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.a6r_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Pick race test cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 1. A new conversation. The poll decides on a first choice, B, the login with room, and waits for the row. The member's pick of
-- A commits. The poll answers A and leaves the pick's row.
do $$
declare v_race jsonb := pg_temp.a6r_race(pg_temp.a6r('bob'), pg_temp.a6r('a')); v_saved jsonb := pg_temp.a6r_saved(pg_temp.a6r('bob'));
begin
	if (v_race ->> 'waited')::boolean is distinct from true then
		raise exception 'The first choice did not wait for the held row: %', v_race; end if;
	if (v_race ->> 'answer')::uuid is distinct from pg_temp.a6r('a') then
		raise exception 'The first choice overrode the member''s pick: %, saved %', v_race, v_saved; end if;
	if (v_saved ->> 'connection')::uuid is distinct from pg_temp.a6r('a')
		or (v_saved ->> 'binding')::uuid is distinct from pg_temp.a6r('aBinding') then
		raise exception 'The first choice overwrote the member''s pick: %, saved %', v_race, v_saved; end if;
	if v_saved ->> 'place' is distinct from v_race ->> 'place' then
		raise exception 'The poll wrote over the pick''s row: %, saved %', v_race, v_saved; end if;
end $$;

-- 2. A saved binding that pays with B now. The poll decides to follow it and waits for the row. The member's pick of A commits. The
-- poll answers A and leaves the pick's row: the thread's login does not flip with no member action.
insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
values (pg_temp.a6r('profile'), pg_temp.a6r('carol'), pg_temp.a6r('owner'), pg_temp.a6r('a'), pg_temp.a6r('bBinding'));
do $$
declare v_race jsonb := pg_temp.a6r_race(pg_temp.a6r('carol'), pg_temp.a6r('a')); v_saved jsonb := pg_temp.a6r_saved(pg_temp.a6r('carol'));
begin
	if (v_race ->> 'waited')::boolean is distinct from true then
		raise exception 'The replacement did not wait for the held row: %', v_race; end if;
	if (v_race ->> 'answer')::uuid is distinct from pg_temp.a6r('a')
		or (v_saved ->> 'connection')::uuid is distinct from pg_temp.a6r('a')
		or (v_saved ->> 'binding')::uuid is distinct from pg_temp.a6r('aBinding') then
		raise exception 'The replacement overwrote the member''s pick: %, saved %', v_race, v_saved; end if;
	if v_saved ->> 'place' is distinct from v_race ->> 'place' then
		raise exception 'The poll wrote over the pick''s row: %, saved %', v_race, v_saved; end if;
end $$;

-- 3. With the row right, a poll does not wait for a held row: it answers what is committed, as if it had come just before the
-- pick. The next poll answers the pick. Neither writes.
do $$
declare v_race jsonb := pg_temp.a6r_race(pg_temp.a6r('bob'), pg_temp.a6r('b')); v_saved jsonb := pg_temp.a6r_saved(pg_temp.a6r('bob'));
begin
	if (v_race ->> 'waited')::boolean is distinct from false then
		raise exception 'A poll with nothing to change waited for the held row: %', v_race; end if;
	if (v_race ->> 'answer')::uuid is distinct from pg_temp.a6r('a') then
		raise exception 'A poll beside an open pick did not answer what is committed: %', v_race; end if;
	if (v_saved ->> 'connection')::uuid is distinct from pg_temp.a6r('b')
		or (v_saved ->> 'binding')::uuid is distinct from pg_temp.a6r('bBinding') then
		raise exception 'The pick did not stand: %, saved %', v_race, v_saved; end if;
	if pg_temp.a6r_poll(pg_temp.a6r('bob')) is distinct from pg_temp.a6r('b') then
		raise exception 'The next poll did not answer the pick'; end if;
	if pg_temp.a6r_saved(pg_temp.a6r('bob')) ->> 'place' is distinct from v_race ->> 'place' then
		raise exception 'A poll with nothing to change wrote its row: %', v_race; end if;
end $$;

select pg_temp.a6r_cleanup();
