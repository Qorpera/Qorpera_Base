-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
create function pg_temp.wp_reading(p_connection uuid, p_used numeric) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
	values (p_connection, 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
		'windows', jsonb_build_array(jsonb_build_object('id','primary','label','Week','usedPercent',p_used,
			'resetAt',to_char((statement_timestamp() + interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;

select pg_temp.wp_reading((current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid, 100);

select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.wp_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','13060000-0000-4000-8000-000000000051','13060000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.wp_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.wp_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'13060000-0000-4000-8000-000000000060',
	'object://native-capsules/13060000-0000-4000-8000-000000000060',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.wp_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.wp_sponsor',public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010','13060000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.wp_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
select pg_temp.wp_reading((current_setting('qorpera_test.wp_connection')::jsonb ->> 'connection_id')::uuid, 20);

select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.wp_login_c',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','13060000-0000-4000-8000-000000000071','13060000-0000-4000-8000-000000000072',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('e',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.wp_connection_c',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.wp_login_c')::jsonb ->> 'login_id')::uuid,repeat('e',64),'13060000-0000-4000-8000-000000000080',
	'object://native-capsules/13060000-0000-4000-8000-000000000080',repeat('f',64),'fixture-openai-account-c','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.wp_sponsor_c',public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010','13060000-0000-4000-8000-000000000081',
	(current_setting('qorpera_test.wp_connection_c')::jsonb ->> 'connection_id')::uuid,1,false)::text,true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

create function pg_temp.wp(p_key text) returns uuid language sql as $$
	select case p_key
		when 'profile' then '92400000-0000-4000-8000-000000000010'::uuid
		when 'owner' then '92400000-0000-4000-8000-000000000001'::uuid
		when 'bob' then (select room.session_id from public.qorpera_company_rooms as room
			where room.id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031'))
		when 'carol' then (select room.session_id from public.qorpera_company_rooms as room
			where room.id = pg_temp.base_thread('92400000-0000-4000-8000-000000000032'))
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.wp_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.wp_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'c' then (current_setting('qorpera_test.wp_connection_c')::jsonb ->> 'connection_id')::uuid
		when 'cBinding' then (current_setting('qorpera_test.wp_sponsor_c')::jsonb ->> 'binding_id')::uuid
		else current_setting('qorpera_test.wp_' || p_key)::uuid end
$$;
create function pg_temp.wp_wake(p_key text) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where id = pg_temp.wp(p_key)
$$;
create function pg_temp.wp_as_owner(p_sql text) returns text language plpgsql as $$
declare v_answer text;
begin
	perform pg_temp.base_claims('authenticated', pg_temp.wp('owner'));
	set local role authenticated;
	execute p_sql into v_answer;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_answer;
exception when others then
	reset role;
	perform pg_temp.base_claims('service_role');
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.wp_pick(p_session text, p_login text) returns text language sql as $$
	select pg_temp.wp_as_owner(format('select public.qorpera_choose_member_session_account(%L,%L,%L)::text',
		pg_temp.wp('profile'), pg_temp.wp(p_session), pg_temp.wp(p_login)))
$$;
create function pg_temp.wp_moves(p_key text) returns jsonb language sql as $$
	select coalesce(jsonb_agg(to_jsonb(move) order by move.created_at, move.id), '[]'::jsonb)
	from public.qorpera_wake_payer_moves as move where move.wake_id = pg_temp.wp(p_key)
$$;

select set_config('qorpera_test.wp_bob_wake', (pg_temp.base_post(pg_temp.wp('owner'), '92400000-0000-4000-8000-000000000031',
	'Draft the price list.') ->> 0), true);
select pg_temp.base_materialize() \g /dev/null

do $$
declare v_wake public.qorpera_wake_occurrences := pg_temp.wp_wake('bob_wake');
begin
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.run_id is null and v_wake.sponsor_binding_id = pg_temp.wp('aBinding')
		and public.qorpera_sponsor_waits_for_usage_limit(v_wake.sponsor_binding_id, v_wake.sponsor_version),
		'the owner''s post in Bob''s thread does not wait on A at its usage limit: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_error(format('update public.qorpera_wake_occurrences set sponsor_binding_id = %L where id = %L',
		pg_temp.wp('bBinding'), v_wake.id), '42501', 'Admitted wake identity is immutable');
	perform pg_temp.base_assert(not has_function_privilege('authenticated',
			'public.qorpera_member_session_waiting_posts(uuid,uuid,uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_member_session_waiting_posts(uuid,uuid,uuid)', 'execute')
		and not has_table_privilege('authenticated', 'public.qorpera_wake_payer_moves', 'insert')
		and not has_table_privilege('service_role', 'public.qorpera_wake_payer_moves', 'insert'),
		'the waiting posts and their moves are not the pick''s alone');
end $$;

do $$
declare v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_assert(pg_temp.wp_pick('bob', 'c') = pg_temp.wp('c')::text, 'the owner''s pick of C in Bob''s thread');
	v_wake := pg_temp.wp_wake('bob_wake');
	perform pg_temp.base_assert(v_wake.sponsor_binding_id = pg_temp.wp('aBinding') and pg_temp.wp_moves('bob_wake') = '[]'::jsonb,
		'the post, paid by a login that works while the owner is away, moved to one that may not: ' || to_jsonb(v_wake)::text);
end $$;

do $$
declare v_wake public.qorpera_wake_occurrences; v_moves jsonb; v_pass jsonb; v_run public.qorpera_execution_runs;
begin
	perform pg_temp.base_assert(pg_temp.wp_pick('bob', 'b') = pg_temp.wp('b')::text, 'the owner''s pick of B in Bob''s thread');
	v_wake := pg_temp.wp_wake('bob_wake');
	v_moves := pg_temp.wp_moves('bob_wake');
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.run_id is null and v_wake.sponsor_binding_id = pg_temp.wp('bBinding')
		and not public.qorpera_sponsor_waits_for_usage_limit(v_wake.sponsor_binding_id, v_wake.sponsor_version),
		'the waiting post did not go on with B: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(jsonb_array_length(v_moves) = 1 and v_moves -> 0 ->> 'from_connection_id' = pg_temp.wp('a')::text
		and v_moves -> 0 ->> 'to_connection_id' = pg_temp.wp('b')::text
		and v_moves -> 0 ->> 'moved_by_user_id' = pg_temp.wp('owner')::text, 'the move is not recorded: ' || v_moves::text);
	v_pass := pg_temp.base_materialize();
	v_wake := pg_temp.wp_wake('bob_wake');
	select * into v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.base_assert(v_wake.status <> 'queued' and v_run.id is not null and v_run.sponsor_binding_id = pg_temp.wp('bBinding'),
		'the moved post did not become a run on B: ' || v_pass::text || ' ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(pg_temp.wp_pick('bob', 'a') = pg_temp.wp('a')::text
		and jsonb_array_length(pg_temp.wp_moves('bob_wake')) = 1, 'a pick moved a post that is already a run');
end $$;

insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
values (pg_temp.wp('profile'), pg_temp.wp('carol'), pg_temp.wp('owner'), pg_temp.wp('a'), pg_temp.wp('aBinding'))
on conflict (profile_id, session_id, user_id) do update set connection_id = excluded.connection_id,
	sponsor_binding_id = excluded.sponsor_binding_id;
select set_config('qorpera_test.wp_carol_wake', (pg_temp.base_post(pg_temp.wp('owner'), '92400000-0000-4000-8000-000000000032',
	'Check the supplier list.') ->> 0), true);

do $$
declare v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_assert(pg_temp.wp_as_owner(format('select public.qorpera_choose_member_sessions_account(%L,%L,%L)::text',
		pg_temp.wp('profile'), pg_temp.wp('a'), pg_temp.wp('b'))) ~ '^[1-9][0-9]*$', 'the move of all chats on A to B');
	v_wake := pg_temp.wp_wake('carol_wake');
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.sponsor_binding_id = pg_temp.wp('bBinding')
		and jsonb_array_length(pg_temp.wp_moves('carol_wake')) = 1,
		'the post waiting in Carol''s thread did not move with all chats: ' || to_jsonb(v_wake)::text);
end $$;

rollback;
