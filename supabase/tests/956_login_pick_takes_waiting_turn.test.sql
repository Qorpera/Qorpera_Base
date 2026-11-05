-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The member's own pick of a login takes their turn waiting at another login's usage limit (20260930580000). Found live
-- on 5 Nov 2026: a company's Co-Founder first run waited on the founder's used-up login; the founder connected a second
-- login with room, opening the thread saved it as the thread's login, and nothing showed the waiting run or offered to
-- move it. Here the owner's login A is at its limit when Dana is hired: her kickoff waits on A. The owner connects B with
-- room. Dana's thread says A (the waiting turn's), also over a saved B; picking a login at its limit moves nothing;
-- picking B with room moves the kickoff to B, and it runs there.

create function pg_temp.p956_row(p_key text) returns uuid language plpgsql as $$
begin
	if p_key = 'session' then
		return (select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000034'));
	end if;
	return (select input_id from public.qorpera_agent_first_runs
		where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '92400000-0000-4000-8000-000000000034');
end $$;
create function pg_temp.p956(p_key text) returns uuid language sql as $$
	select case p_key
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.p956_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.p956_sponsor')::jsonb ->> 'binding_id')::uuid
		-- Read as the database owner only (an API role reads neither table).
		when 'session' then pg_temp.p956_row('session')
		when 'input' then pg_temp.p956_row('input') end
$$;
-- A usage reading of a login's version 2 taken a second ago: its window is p_used percent used and resets in two days.
create function pg_temp.p956_reading(p_connection uuid, p_used numeric) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
	values (p_connection, 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
		'windows', jsonb_build_array(jsonb_build_object('id','primary','label','Week','usedPercent',p_used,
			'resetAt',to_char((statement_timestamp() + interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;
create function pg_temp.p956_request() returns public.qorpera_session_turn_requests language sql as $$
	select * from public.qorpera_session_turn_requests where input_id = pg_temp.p956('input')
		order by created_at desc, id desc limit 1
$$;
create function pg_temp.p956_as_owner(p_sql text) returns text language plpgsql as $$
declare v_result text;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	execute p_sql into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;

-- The checks start here.
-- 1. A is at its limit; Dana's kickoff is queued on A and waits there.
select pg_temp.p956_reading(pg_temp.p956('a'), 100);
select pg_temp.base_commit(pg_temp.base_owner(), 'p956-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
select pg_temp.base_materialize() \g /dev/null
do $$
declare v_request public.qorpera_session_turn_requests := pg_temp.p956_request();
begin
	perform pg_temp.base_assert(v_request.status = 'queued' and v_request.sponsor_binding_id = pg_temp.p956('aBinding')
		and public.qorpera_sponsor_waits_for_usage_limit(v_request.sponsor_binding_id, v_request.sponsor_version),
		'the kickoff does not wait on A: ' || to_jsonb(v_request)::text);
end $$;

-- The owner connects login B, for work while away too, with room left.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p956_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','95600000-0000-4000-8000-000000000051','95600000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.p956_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.p956_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'95600000-0000-4000-8000-000000000060',
	'object://native-capsules/95600000-0000-4000-8000-000000000060',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = pg_temp.p956('b') and version = 1;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p956_sponsor', public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010',
	'95600000-0000-4000-8000-000000000061',pg_temp.p956('b'),2,true)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
select pg_temp.p956_reading(pg_temp.p956('b'), 20);

-- 2. Nothing moves by itself: B having room leaves the kickoff on A.
select pg_temp.base_materialize() \g /dev/null
select pg_temp.base_assert((pg_temp.p956_request()).sponsor_binding_id = pg_temp.p956('aBinding')
	and (pg_temp.p956_request()).status = 'queued', 'the kickoff moved by itself');

-- 3. Dana's thread says A, the waiting turn's login, also over a saved B (as opening the thread saved it live).
insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
values ('92400000-0000-4000-8000-000000000010', pg_temp.p956('session'), '92400000-0000-4000-8000-000000000001',
	pg_temp.p956('b'), pg_temp.p956('bBinding'));
select pg_temp.base_assert(pg_temp.p956_as_owner(format(
		'select public.qorpera_select_member_session_account(%L,%L)::text', '92400000-0000-4000-8000-000000000010',
		pg_temp.p956('session'))) = pg_temp.p956('a')::text, 'the thread does not say the waiting turn''s login');
select pg_temp.base_assert((select connection_id from public.qorpera_member_session_accounts
	where session_id = pg_temp.p956('session') and user_id = '92400000-0000-4000-8000-000000000001') = pg_temp.p956('a'),
	'the thread does not keep the waiting turn''s login');

-- 4. A pick of B while B is at its limit too moves nothing.
select pg_temp.p956_reading(pg_temp.p956('b'), 100);
select pg_temp.base_assert(pg_temp.p956_as_owner(format(
		'select public.qorpera_choose_member_session_account(%L,%L,%L)::text', '92400000-0000-4000-8000-000000000010',
		pg_temp.p956('session'), pg_temp.p956('b'))) = pg_temp.p956('b')::text, 'the owner could not pick B at its limit');
select pg_temp.base_assert((pg_temp.p956_request()).sponsor_binding_id = pg_temp.p956('aBinding'),
	'a pick of a used-up login moved the kickoff');

-- 5. The owner's pick of B with room moves the kickoff to B, and it runs there.
select pg_temp.p956_reading(pg_temp.p956('b'), 20);
select pg_temp.base_assert(pg_temp.p956_as_owner(format(
		'select public.qorpera_choose_member_session_account(%L,%L,%L)::text', '92400000-0000-4000-8000-000000000010',
		pg_temp.p956('session'), pg_temp.p956('b'))) = pg_temp.p956('b')::text, 'the owner could not pick B');
do $$
declare v_request public.qorpera_session_turn_requests := pg_temp.p956_request(); v_pass jsonb; v_run public.qorpera_execution_runs;
begin
	perform pg_temp.base_assert(v_request.status = 'queued' and v_request.sponsor_binding_id = pg_temp.p956('bBinding')
		and v_request.sponsor_version = 1 and not public.qorpera_sponsor_waits_for_usage_limit(v_request.sponsor_binding_id, 1),
		'the pick did not move the kickoff to B: ' || to_jsonb(v_request)::text);
	perform pg_temp.base_assert(pg_temp.p956_as_owner(format(
			'select public.qorpera_select_member_session_account(%L,%L)::text', '92400000-0000-4000-8000-000000000010',
			pg_temp.p956('session'))) = pg_temp.p956('b')::text, 'the thread does not say B after the pick');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'the kickoff did not go on: ' || v_pass::text);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_assert(v_run.sponsor_binding_id = pg_temp.p956('bBinding'), 'the kickoff did not run on B');
end $$;

-- The new helper is the database's own.
select pg_temp.base_assert(not has_function_privilege('anon','public.qorpera_member_session_waiting_turns(uuid,uuid,uuid)','execute')
	and not has_function_privilege('authenticated','public.qorpera_member_session_waiting_turns(uuid,uuid,uuid)','execute')
	and not has_function_privilege('service_role','public.qorpera_member_session_waiting_turns(uuid,uuid,uuid)','execute'),
	'API clients can call qorpera_member_session_waiting_turns');

rollback;
