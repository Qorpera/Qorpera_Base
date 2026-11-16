-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
create function pg_temp.sw_reading(p_connection uuid, p_used numeric) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
	values (p_connection, 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
		'windows', jsonb_build_array(jsonb_build_object('id','primary','label','Week','usedPercent',p_used,
			'resetAt',to_char((statement_timestamp() + interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;

select pg_temp.sw_reading((current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid, 100);
select pg_temp.base_commit(pg_temp.base_owner(), 'sw-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
select pg_temp.base_materialize() \g /dev/null

select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.sw_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','12810000-0000-4000-8000-000000000051','12810000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.sw_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.sw_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'12810000-0000-4000-8000-000000000060',
	'object://native-capsules/12810000-0000-4000-8000-000000000060',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.sw_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.sw_sponsor',public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010','12810000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.sw_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
select pg_temp.sw_reading((current_setting('qorpera_test.sw_connection')::jsonb ->> 'connection_id')::uuid, 20);

select set_config('qorpera_test.sw_' || thread.key, (select room.session_id::text from public.qorpera_company_rooms as room
	where room.id = pg_temp.base_thread(thread.staff)), false)
from (values ('alice', '92400000-0000-4000-8000-000000000030'::uuid), ('bob', '92400000-0000-4000-8000-000000000031'::uuid),
	('carol', '92400000-0000-4000-8000-000000000032'::uuid), ('dana', '92400000-0000-4000-8000-000000000034'::uuid))
	as thread(key, staff);
select set_config('qorpera_test.sw_dana_input', (select first_run.input_id::text from public.qorpera_agent_first_runs as first_run
	where first_run.profile_id = '92400000-0000-4000-8000-000000000010'
		and first_run.staff_agent_id = '92400000-0000-4000-8000-000000000034'), false);

create function pg_temp.sw(p_key text) returns uuid language sql as $$
	select case p_key
		when 'profile' then '92400000-0000-4000-8000-000000000010'::uuid
		when 'owner' then '92400000-0000-4000-8000-000000000001'::uuid
		when 'member' then '92400000-0000-4000-8000-000000000002'::uuid
		when 'viewer' then '92400000-0000-4000-8000-000000000003'::uuid
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.sw_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.sw_sponsor')::jsonb ->> 'binding_id')::uuid
		else current_setting('qorpera_test.sw_' || p_key)::uuid end
$$;
create function pg_temp.sw_saved(p_user text, p_session text) returns jsonb language sql as $$
	select jsonb_build_object('connection', saved.connection_id, 'binding', saved.sponsor_binding_id, 'place', saved.ctid::text)
	from public.qorpera_member_session_accounts as saved
	where saved.profile_id = pg_temp.sw('profile') and saved.session_id = pg_temp.sw(p_session) and saved.user_id = pg_temp.sw(p_user)
$$;
create function pg_temp.sw_on(p_user text, p_session text, p_login text) returns boolean language sql as $$
	select (pg_temp.sw_saved(p_user, p_session) ->> 'connection')::uuid = pg_temp.sw(p_login)
		and (pg_temp.sw_saved(p_user, p_session) ->> 'binding')::uuid = pg_temp.sw(p_login || 'Binding')
$$;
create function pg_temp.sw_kickoff() returns public.qorpera_session_turn_requests language sql as $$
	select * from public.qorpera_session_turn_requests where input_id = pg_temp.sw('dana_input')
		order by created_at desc, id desc limit 1
$$;
create function pg_temp.sw_call(p_role text, p_user text, p_sql text) returns text language plpgsql as $$
declare v_answer text;
begin
	perform pg_temp.base_claims(p_role, case when p_user is null then null else pg_temp.sw(p_user) end);
	execute p_sql into v_answer;
	perform pg_temp.base_claims('service_role');
	return v_answer;
exception when others then
	perform pg_temp.base_claims('service_role');
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.sw_count(p_user text, p_login text) returns text language sql as $$
	select pg_temp.sw_call('authenticated', p_user, format('select public.qorpera_count_member_sessions_on_account(%L,%L)::text',
		pg_temp.sw('profile'), pg_temp.sw(p_login)))
$$;
create function pg_temp.sw_move_sql(p_from uuid, p_to uuid) returns text language sql as $$
	select format('select public.qorpera_choose_member_sessions_account(%L,%L,%L)::text', pg_temp.sw('profile'), p_from, p_to)
$$;

insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
select pg_temp.sw('profile'), pg_temp.sw(wanted.session), pg_temp.sw(wanted.member), pg_temp.sw(wanted.login),
	pg_temp.sw(wanted.login || 'Binding')
from (values ('alice', 'owner', 'a'), ('bob', 'owner', 'a'), ('carol', 'owner', 'a'), ('bob', 'member', 'a'))
	as wanted(session, member, login);
set local session_replication_role = replica;
update public.qorpera_shared_sessions set status = 'closed' where id = pg_temp.sw('alice');
set local session_replication_role = origin;

do $$
declare v_request public.qorpera_session_turn_requests := pg_temp.sw_kickoff();
begin
	perform pg_temp.base_assert(v_request.status = 'queued' and v_request.sponsor_binding_id = pg_temp.sw('aBinding')
		and public.qorpera_sponsor_waits_for_usage_limit(v_request.sponsor_binding_id, v_request.sponsor_version),
		'Dana''s kickoff does not wait on A: ' || to_jsonb(v_request)::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_member_session_accounts
		where session_id = pg_temp.sw('dana')), 'Dana''s thread has a saved login before any pick');
end $$;

reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.base_connection','qorpera_test.base_sponsor','qorpera_test.sw_connection','qorpera_test.sw_sponsor']) name;
select set_config('qorpera_test.sw_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('sw_holder', 'dbname=' || current_database());
select dblink_connect('sw_poll', 'dbname=' || current_database());
select set_config('qorpera_test.sw_' || name || '_pid', pid::text, false)
from unnest(array['holder','poll']) name, lateral dblink('sw_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.sw_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.sw_holder_pid'), current_setting('qorpera_test.sw_poll_pid'))) then
		raise exception 'The move race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.sw_alone_in_database();
create temporary table sw_counts as select * from dblink('sw_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
create temporary table sw_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.sw_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.sw_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.sw_rows select v_table, kept.row_value
			from dblink('sw_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

select dblink_exec(name, 'set role authenticated') from unnest(array['sw_holder','sw_poll']) name;
select dblink_exec(name, format('set request.jwt.claims = %L',
	jsonb_build_object('role', 'authenticated', 'sub', pg_temp.sw('owner'))::text)) from unnest(array['sw_holder','sw_poll']) name;

create function pg_temp.sw_race(p_holder_sql text, p_poll_sql text, p_place_session text default null)
returns jsonb language plpgsql as $$
declare v_holder integer := current_setting('qorpera_test.sw_holder_pid')::integer;
	v_poll integer := current_setting('qorpera_test.sw_poll_pid')::integer;
	v_waited boolean := false; v_held text; v_answer text; v_place text;
begin
	perform dblink_exec('sw_holder', 'begin');
	select answer into v_held from dblink('sw_holder', p_holder_sql) as call(answer text);
	if p_place_session is not null then
		select place into v_place from dblink('sw_holder', format($sql$
			reset role;
			select saved.ctid::text from public.qorpera_member_session_accounts as saved
			where saved.profile_id = %L and saved.session_id = %L and saved.user_id = %L
		$sql$, pg_temp.sw('profile'), pg_temp.sw(p_place_session), pg_temp.sw('owner'))) as held(place text);
		perform dblink_exec('sw_holder', 'set role authenticated');
	end if;
	perform dblink_send_query('sw_poll', p_poll_sql);
	for attempt in 1..400 loop
		v_waited := v_holder = any(pg_blocking_pids(v_poll));
		exit when v_waited or dblink_is_busy('sw_poll') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('sw_holder', 'commit');
	select answer into v_answer from dblink_get_result('sw_poll') as call(answer text);
	perform * from dblink_get_result('sw_poll', false) as call(answer text);
	return jsonb_build_object('held', v_held, 'answer', v_answer, 'waited', v_waited, 'place', v_place);
end $$;
create function pg_temp.sw_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.sw_first_xid')::xid;
begin
	perform pg_temp.sw_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['sw_holder','sw_poll']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.sw_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.sw_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.sw_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.sw_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Move race test cleanup left other row counts: %', v_wrong; end if;
end $$;

select set_config('qorpera_test.sw_member_place', pg_temp.sw_saved('member', 'bob') ->> 'place', false);
select set_config('qorpera_test.sw_alice_place', pg_temp.sw_saved('owner', 'alice') ->> 'place', false);

do $$
begin
	perform pg_temp.base_assert(pg_temp.sw_count('owner', 'a') = '3',
		'the owner''s open chats on A are not Bob''s, Carol''s and Dana''s waiting kickoff: ' || pg_temp.sw_count('owner', 'a'));
	perform pg_temp.base_assert(pg_temp.sw_count('owner', 'b') = '0', 'the owner''s chats on B: ' || pg_temp.sw_count('owner', 'b'));
	perform pg_temp.base_assert(pg_temp.sw_count('member', 'a') = '0',
		'another member''s chat counts on the owner''s login: ' || pg_temp.sw_count('member', 'a'));
	perform pg_temp.base_assert(pg_temp.sw_call('authenticated', 'owner', pg_temp.sw_move_sql(pg_temp.sw('a'),
			'12810000-0000-4000-8000-000000000099')) = '22023 This login cannot pay for your conversation',
		'a move to a login that is no login of the owner''s was not refused');
	perform pg_temp.base_assert(pg_temp.sw_call('authenticated', 'member', pg_temp.sw_move_sql(pg_temp.sw('a'), pg_temp.sw('b')))
		= '22023 This login cannot pay for your conversation', 'a member moved chats to the owner''s login');
	perform pg_temp.base_assert(pg_temp.sw_call('authenticated', 'viewer', pg_temp.sw_move_sql(pg_temp.sw('a'), pg_temp.sw('b')))
		= '22023 This login cannot pay for your conversation', 'a viewer moved chats to the owner''s login');
	perform pg_temp.base_assert(pg_temp.sw_call('anon', null, pg_temp.sw_move_sql(pg_temp.sw('a'), pg_temp.sw('b')))
		= '42501 Conversation accounts unavailable', 'a move without a signed-in member was not refused');
	perform pg_temp.base_assert(pg_temp.sw_call('anon', null, format('select public.qorpera_count_member_sessions_on_account(%L,%L)::text',
		pg_temp.sw('profile'), pg_temp.sw('a'))) = '42501 Conversation accounts unavailable', 'a count without a signed-in member');
	perform pg_temp.base_assert(pg_temp.sw_call('authenticated', 'owner', pg_temp.sw_move_sql(pg_temp.sw('a'), pg_temp.sw('a'))) = '0',
		'a move onto the login the chats already have answered a move');
	perform pg_temp.base_assert(pg_temp.sw_on('owner', 'bob', 'a') and pg_temp.sw_on('owner', 'carol', 'a')
		and (pg_temp.sw_kickoff()).sponsor_binding_id = pg_temp.sw('aBinding'), 'a refused move changed a chat');
end $$;

do $$
declare v_race jsonb := pg_temp.sw_race(
	format('select public.qorpera_choose_member_session_account(%L,%L,%L)::text', pg_temp.sw('profile'), pg_temp.sw('carol'), pg_temp.sw('b')),
	pg_temp.sw_move_sql(pg_temp.sw('a'), pg_temp.sw('b')), 'carol');
	v_kickoff public.qorpera_session_turn_requests := pg_temp.sw_kickoff();
begin
	perform pg_temp.base_assert((v_race ->> 'held')::uuid = pg_temp.sw('b'), 'the single pick of Carol''s chat failed: ' || v_race::text);
	perform pg_temp.base_assert((v_race ->> 'waited')::boolean, 'the move of all chats did not wait for a chat another tab held: ' || v_race::text);
	perform pg_temp.base_assert(v_race ->> 'answer' = '2',
		'the move did not decide again under the lock (Carol''s chat was picked meanwhile): ' || v_race::text);
	perform pg_temp.base_assert(pg_temp.sw_on('owner', 'carol', 'b') and pg_temp.sw_saved('owner', 'carol') ->> 'place' = v_race ->> 'place',
		'the move wrote over the pick made in the other tab: ' || v_race::text || ' ' || pg_temp.sw_saved('owner', 'carol')::text);
	perform pg_temp.base_assert(pg_temp.sw_on('owner', 'bob', 'b'), 'Bob''s chat did not move to B');
	perform pg_temp.base_assert(pg_temp.sw_on('owner', 'dana', 'b'), 'Dana''s chat did not keep B');
	perform pg_temp.base_assert(v_kickoff.status = 'queued' and v_kickoff.sponsor_binding_id = pg_temp.sw('bBinding')
		and not public.qorpera_sponsor_waits_for_usage_limit(v_kickoff.sponsor_binding_id, v_kickoff.sponsor_version),
		'Dana''s waiting kickoff did not go on with B: ' || to_jsonb(v_kickoff)::text);
	perform pg_temp.base_assert(pg_temp.sw_on('owner', 'alice', 'a')
		and pg_temp.sw_saved('owner', 'alice') ->> 'place' = current_setting('qorpera_test.sw_alice_place'),
		'a closed chat moved');
	perform pg_temp.base_assert(pg_temp.sw_on('member', 'bob', 'a')
		and pg_temp.sw_saved('member', 'bob') ->> 'place' = current_setting('qorpera_test.sw_member_place'),
		'another member''s chat moved');
	perform pg_temp.base_assert(pg_temp.sw_count('owner', 'a') = '0' and pg_temp.sw_count('owner', 'b') = '3',
		'the counts after the move: A ' || pg_temp.sw_count('owner', 'a') || ', B ' || pg_temp.sw_count('owner', 'b'));
end $$;

do $$
declare v_race jsonb := pg_temp.sw_race(pg_temp.sw_move_sql(pg_temp.sw('b'), pg_temp.sw('a')),
	pg_temp.sw_move_sql(pg_temp.sw('b'), pg_temp.sw('a')));
begin
	perform pg_temp.base_assert(v_race ->> 'held' = '3', 'the first move back to A: ' || v_race::text);
	perform pg_temp.base_assert((v_race ->> 'waited')::boolean, 'the second move did not wait for the first: ' || v_race::text);
	perform pg_temp.base_assert(v_race ->> 'answer' = '0', 'two moves at once moved a chat twice: ' || v_race::text);
	perform pg_temp.base_assert(pg_temp.sw_on('owner', 'bob', 'a') and pg_temp.sw_on('owner', 'carol', 'a')
		and pg_temp.sw_on('owner', 'dana', 'a'), 'the owner''s chats are not all on A');
	perform pg_temp.base_assert(pg_temp.sw_count('owner', 'a') = '3' and pg_temp.sw_count('owner', 'b') = '0',
		'the counts after the move back: A ' || pg_temp.sw_count('owner', 'a') || ', B ' || pg_temp.sw_count('owner', 'b'));
	perform pg_temp.base_assert(pg_temp.sw_saved('member', 'bob') ->> 'place' = current_setting('qorpera_test.sw_member_place')
		and pg_temp.sw_saved('owner', 'alice') ->> 'place' = current_setting('qorpera_test.sw_alice_place'),
		'a move back touched another member''s chat or a closed one');
end $$;

select pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_choose_member_sessions_account(uuid,uuid,uuid)', 'execute')
	and not has_function_privilege('anon', 'public.qorpera_count_member_sessions_on_account(uuid,uuid)', 'execute')
	and has_function_privilege('authenticated', 'public.qorpera_choose_member_sessions_account(uuid,uuid,uuid)', 'execute')
	and has_function_privilege('authenticated', 'public.qorpera_count_member_sessions_on_account(uuid,uuid)', 'execute')
	and not has_function_privilege('authenticated', 'public.qorpera_member_sessions_on_login(uuid,uuid,uuid)', 'execute')
	and not has_function_privilege('service_role', 'public.qorpera_member_sessions_on_login(uuid,uuid,uuid)', 'execute')
	and not has_function_privilege('authenticated', 'public.qorpera_member_session_login(uuid,uuid,uuid,uuid[])', 'execute')
	and not has_function_privilege('service_role', 'public.qorpera_member_session_login(uuid,uuid,uuid,uuid[])', 'execute'),
	'the move''s privileges are not the member''s alone');

select pg_temp.sw_cleanup();
