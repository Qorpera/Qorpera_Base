-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"

select pg_temp.base_claims('service_role');
select public.qorpera_set_provider_execution_policy('anthropic', 'native_subscription', 'claude-code', 'supported',
	'enabled', 32, null, 'several-claude-logins') \g /dev/null
insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select set_config('qorpera_test.sc_owner', pg_temp.c4_owner_id()::text, false) \g /dev/null
select set_config('qorpera_test.sc_identity',
	current_setting('qorpera_test.base_binding')::jsonb ->> 'computeIdentityId', false) \g /dev/null

create function pg_temp.sc_try(p_sql text) returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	perform set_config('qorpera_test.sc_last', coalesce(v_result, ''), true);
	return 'ok';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.sc_last() returns jsonb language sql as $$
	select nullif(current_setting('qorpera_test.sc_last', true), '')::jsonb
$$;
create function pg_temp.sc_owner() returns uuid language sql stable as $$
	select current_setting('qorpera_test.sc_owner')::uuid
$$;
create function pg_temp.sc_login(p_id uuid) returns public.qorpera_claude_logins language sql as $$
	select * from public.qorpera_claude_logins where id = p_id
$$;
create function pg_temp.sc_in_use(p_user uuid) returns uuid language sql as $$
	select id from public.qorpera_claude_logins where owner_user_id = p_user and status = 'active' and in_use
$$;
create function pg_temp.sc_begin(p_capability text) returns text language sql as $$
	select pg_temp.sc_try(format('select public.qorpera_begin_native_provider_login(%L, %L, %L, %L, %L, %L, %L, 900)::text',
		'92400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		current_setting('qorpera_test.sc_identity'), 'anthropic', 'claude-code', p_capability))
$$;
create function pg_temp.sc_complete(p_login text, p_capability text, p_claude_login uuid, p_email text)
returns text language sql as $$
	select pg_temp.sc_try(format($q$select public.qorpera_complete_claude_login_sign_in(
		'12680000-0000-4000-8000-000000000040', repeat('c', 64), %L, %L, %L, 'vault-root-1',
		encode(%L::bytea, 'base64'), encode(sha256(%L::bytea), 'hex'), null, %L)::text$q$,
		p_login, p_capability, p_claude_login, 'files-' || p_claude_login, 'files-' || p_claude_login, p_email))
$$;
create function pg_temp.sc_list() returns jsonb language sql as $$
	select public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010') -> 'logins'
$$;
create function pg_temp.sc_listed(p_id uuid) returns jsonb language sql as $$
	select item from jsonb_array_elements(pg_temp.sc_list()) as item where item ->> 'loginId' = p_id::text
$$;
grant execute on function pg_temp.sc_try(text), pg_temp.sc_last(), pg_temp.sc_owner(), pg_temp.sc_begin(text),
	pg_temp.sc_complete(text, text, uuid, text), pg_temp.sc_list(), pg_temp.sc_listed(uuid), pg_temp.base_assert(boolean, text)
	to qorpera_secret_broker, service_role, authenticated;

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_use_claude_login(uuid)', 'execute')
			and not has_function_privilege(v_role, 'public.qorpera_sign_out_claude_login(uuid,uuid)', 'execute')
			and not has_function_privilege(v_role, 'public.qorpera_sign_out_claude_login(uuid)', 'execute')
			and not has_function_privilege(v_role,
				'public.qorpera_begin_claude_login_read(uuid,uuid,uuid,text,boolean,text)', 'execute'),
			v_role || ' moves, signs out or reads a member''s Claude login');
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_claude_logins_listed(uuid)', 'execute')
			and not has_function_privilege(v_role,
				'public.qorpera_claude_login_used_up_until(public.qorpera_claude_logins)', 'execute')
			and not has_function_privilege(v_role, 'public.qorpera_claude_login_in_use_default()', 'execute')
			and not has_function_privilege(v_role, 'public.qorpera_claude_login_in_use_held()', 'execute'),
			v_role || ' calls the inner Claude login functions');
	end loop;
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_use_claude_login(uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_sign_out_claude_login(uuid,uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_sign_out_claude_login(uuid)', 'execute')
		and has_function_privilege('authenticated',
			'public.qorpera_begin_claude_login_read(uuid,uuid,uuid,text,boolean,text)', 'execute')
		and has_function_privilege('authenticated',
			'public.qorpera_begin_claude_login_read(uuid,uuid,text,boolean,text)', 'execute'),
		'a member calls the several-login functions');
	perform pg_temp.base_assert(to_regclass('public.qorpera_claude_logins_one_active') is null
		and to_regclass('public.qorpera_claude_logins_one_in_use') is not null, 'one In use per member, not one login');
end $$;

select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_begin(repeat('1', 64)) = 'ok', '2: sign-in 1 begins');
select set_config('qorpera_test.sc_in', pg_temp.sc_last() ->> 'login_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sc_complete(current_setting('qorpera_test.sc_in'), repeat('1', 64),
	'13000000-0000-4000-8000-0000000000a1', 'work@example.test') = 'ok', '2: the first sign-in completes');
reset session authorization;
select pg_temp.base_assert((pg_temp.sc_login('13000000-0000-4000-8000-0000000000a1')).in_use,
	'2: the first login is In use');
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_begin(repeat('2', 64)) = 'ok', '2: sign-in 2 begins');
select set_config('qorpera_test.sc_in', pg_temp.sc_last() ->> 'login_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sc_complete(current_setting('qorpera_test.sc_in'), repeat('2', 64),
	'13000000-0000-4000-8000-0000000000a2', 'home@example.test') = 'ok', '2: another account signs in');
reset session authorization;
do $$
begin
	perform pg_temp.base_assert((pg_temp.sc_login('13000000-0000-4000-8000-0000000000a1')).status = 'active'
		and (pg_temp.sc_login('13000000-0000-4000-8000-0000000000a1')).in_use
		and (pg_temp.sc_login('13000000-0000-4000-8000-0000000000a2')).status = 'active'
		and not (pg_temp.sc_login('13000000-0000-4000-8000-0000000000a2')).in_use,
		'2: another account is one more login, Not in use; the first stays In use');
end $$;
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_begin(repeat('3', 64)) = 'ok', '2: sign-in 3 begins');
select set_config('qorpera_test.sc_in', pg_temp.sc_last() ->> 'login_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sc_complete(current_setting('qorpera_test.sc_in'), repeat('3', 64),
	'13000000-0000-4000-8000-0000000000a3', 'Work@Example.test') = 'ok', '2: the same account signs in again');
reset session authorization;
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_begin(repeat('4', 64)) = 'ok', '2: sign-in 4 begins');
select set_config('qorpera_test.sc_in', pg_temp.sc_last() ->> 'login_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sc_complete(current_setting('qorpera_test.sc_in'), repeat('4', 64),
	'13000000-0000-4000-8000-0000000000a4', 'home@example.test') = 'ok', '2: the other account signs in again');
reset session authorization;
do $$
declare v_old public.qorpera_claude_logins := pg_temp.sc_login('13000000-0000-4000-8000-0000000000a1');
begin
	perform pg_temp.base_assert(v_old.status = 'revoked' and v_old.encrypted_envelope is null and not v_old.in_use
		and (pg_temp.sc_login('13000000-0000-4000-8000-0000000000a3')).in_use,
		'2: the same account replaces its row and keeps In use: ' || to_jsonb(v_old)::text);
	perform pg_temp.base_assert((pg_temp.sc_login('13000000-0000-4000-8000-0000000000a2')).status = 'revoked'
		and (pg_temp.sc_login('13000000-0000-4000-8000-0000000000a4')).status = 'active'
		and not (pg_temp.sc_login('13000000-0000-4000-8000-0000000000a4')).in_use,
		'2: the Not-in-use account replaced stays Not in use');
	perform pg_temp.base_assert((select count(*) from public.qorpera_claude_logins
		where owner_user_id = pg_temp.sc_owner() and status = 'active') = 2, '2: two active logins');
end $$;

savepoint sc_held;
set constraints public.qorpera_claude_logins_in_use_held immediate;
select pg_temp.base_assert(pg_temp.sc_try($q$update public.qorpera_claude_logins set in_use = false
	where id = '13000000-0000-4000-8000-0000000000a3'$q$) like '23514:%', '3: none In use is refused');
rollback to savepoint sc_held;
select pg_temp.base_assert(pg_temp.sc_try($q$update public.qorpera_claude_logins set in_use = true
	where id = '13000000-0000-4000-8000-0000000000a4'$q$) like '23505:%', '3: two In use are refused');
rollback to savepoint sc_held;
select pg_temp.base_assert(pg_temp.sc_try($q$update public.qorpera_claude_logins set in_use = true
	where id = '13000000-0000-4000-8000-0000000000a1'$q$) like '23514:%', '3: a signed-out login is never In use');
rollback to savepoint sc_held;

select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
do $$
begin
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.sc_list()) = 2
		and (pg_temp.sc_listed('13000000-0000-4000-8000-0000000000a3') ->> 'inUse')::boolean
		and not (pg_temp.sc_listed('13000000-0000-4000-8000-0000000000a4') ->> 'inUse')::boolean
		and pg_temp.sc_listed('13000000-0000-4000-8000-0000000000a3') -> 'usedUpUntil' = 'null'::jsonb,
		'4: the list marks In use: ' || pg_temp.sc_list()::text);
end $$;
reset role;
update public.qorpera_claude_logins set usage = jsonb_build_object('observedAt', '2026-11-18T10:00:00Z',
	'limitResetAt', to_char((statement_timestamp() + interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	'windows', jsonb_build_array(jsonb_build_object('id', 'five_hour', 'label', '5 hours', 'usedPercent', 100,
		'resetAt', to_char((statement_timestamp() + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
where id = '13000000-0000-4000-8000-0000000000a3';
update public.qorpera_claude_logins set usage = jsonb_build_object('observedAt', '2026-11-18T10:00:00Z',
	'limitResetAt', '2026-01-01T00:00:00Z', 'windows', jsonb_build_array(
		jsonb_build_object('id', 'five_hour', 'label', '5 hours', 'usedPercent', 40,
			'resetAt', to_char((statement_timestamp() + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
		jsonb_build_object('id', 'seven_day_model', 'label', 'Weekly · Fable', 'usedPercent', 100,
			'resetAt', to_char((statement_timestamp() + interval '3 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
where id = '13000000-0000-4000-8000-0000000000a4';
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
do $$
declare v_until timestamptz := (pg_temp.sc_listed('13000000-0000-4000-8000-0000000000a3') ->> 'usedUpUntil')::timestamptz;
begin
	perform pg_temp.base_assert(v_until between statement_timestamp() + interval '119 minutes'
		and statement_timestamp() + interval '2 hours', '4: used up until the limit a run hit, the later end: ' || v_until);
	perform pg_temp.base_assert(pg_temp.sc_listed('13000000-0000-4000-8000-0000000000a4') -> 'usedUpUntil' = 'null'::jsonb,
		'4: a past limit and a full per-model week leave room');
end $$;
reset role;
update public.qorpera_claude_logins set usage = jsonb_set(usage, '{limitResetAt}', '"2026-01-01T00:00:00Z"')
where id = '13000000-0000-4000-8000-0000000000a3';
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert((pg_temp.sc_listed('13000000-0000-4000-8000-0000000000a3') ->> 'usedUpUntil')::timestamptz
	between statement_timestamp() + interval '59 minutes' and statement_timestamp() + interval '1 hour',
	'4: a full 5-hour window is used up until it resets');
reset role;

select pg_temp.base_claims('service_role');
select pg_temp.c4_login('13000000-0000-4000-8000-0000000000b9', '92400000-0000-4000-8000-000000000002', 'canary-other')
	\g /dev/null
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_use_claude_login(
	'13000000-0000-4000-8000-0000000000b9')::text$q$) = '42501:Claude login is unavailable', '5: not another member''s login');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_use_claude_login(
	'13000000-0000-4000-8000-0000000000a1')::text$q$) = '42501:Claude login is unavailable', '5: not a signed-out login');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_use_claude_login(
	'13000000-0000-4000-8000-0000000000a4')::text$q$) = 'ok', '5: the member picks their other login');
do $$
declare v_answer jsonb := pg_temp.sc_last();
begin
	perform pg_temp.base_assert(v_answer ->> 'schema' = 'qorpera.claude-login-use/v1'
		and v_answer ->> 'loginId' = '13000000-0000-4000-8000-0000000000a4'
		and (select bool_and((item ->> 'inUse')::boolean = (item ->> 'loginId' = '13000000-0000-4000-8000-0000000000a4'))
			from jsonb_array_elements(v_answer -> 'logins') as item)
		and jsonb_array_length(v_answer -> 'logins') = 2, '5: it answers the list with the pick In use: ' || v_answer::text);
end $$;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_use_claude_login(
	'13000000-0000-4000-8000-0000000000a4')::text$q$) = 'ok', '5: picking it again changes nothing');
reset role;
select pg_temp.base_assert(pg_temp.sc_in_use(pg_temp.sc_owner()) = '13000000-0000-4000-8000-0000000000a4'
	and pg_temp.sc_in_use('92400000-0000-4000-8000-000000000002') = '13000000-0000-4000-8000-0000000000b9',
	'5: one In use each, the other member''s untouched');
select pg_temp.base_claims('anon');
set local role anon;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_use_claude_login(
	'13000000-0000-4000-8000-0000000000a3')::text$q$) like '42501:%', '5: anon picks nothing');
reset role;

select pg_temp.base_claims('service_role');
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_result jsonb; w public.qorpera_runtime_workers%rowtype;
	v_folder text := 'QorperaOS/agents/alice/todos/onboarding/pdf';
begin
	v_result := pg_temp.c4_dispatch(v_alice, 'sc-dispatch-1', v_folder, pg_temp.c4_brief('13000000-0000-4000-8000-0000000000d1'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '6: the dispatch: ' || v_result::text);
	w := pg_temp.c4_worker('13000000-0000-4000-8000-0000000000d1');
	perform pg_temp.base_assert(w.claude_login_id = '13000000-0000-4000-8000-0000000000a4',
		'6: the dispatch takes the login In use: ' || to_jsonb(w)::text);
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', pg_temp.sc_owner())::text, true);
	perform public.qorpera_use_claude_login('13000000-0000-4000-8000-0000000000a3');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert((pg_temp.c4_worker(w.id)).claude_login_id = '13000000-0000-4000-8000-0000000000a4',
		'6: a dispatched worker keeps its login when the member picks another');
	update public.qorpera_wake_occurrences set status = 'failed', finished_at = coalesce(finished_at, clock_timestamp())
	where id = (pg_temp.c4_worker(w.id)).occurrence_id and status = 'materialized';
	perform pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker(w.id)).state <> 'active', '6: the first run has ended');
	v_result := pg_temp.c4_followup(v_alice, 'sc-followup-1', v_folder, 'Use the new logo.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '6: the follow-up: ' || v_result::text);
	perform pg_temp.base_assert((pg_temp.c4_worker(w.id)).claude_login_id = '13000000-0000-4000-8000-0000000000a3',
		'6: the follow-up takes the login In use now: ' || to_jsonb(pg_temp.c4_worker(w.id))::text);
	perform pg_temp.base_assert(public.qorpera_claude_worker_login('92400000-0000-4000-8000-000000000010', pg_temp.sc_owner())
		= '13000000-0000-4000-8000-0000000000a3'
		and position('login.in_use' in pg_get_functiondef('public.qorpera_claude_worker_login(uuid,uuid)'::regprocedure)) > 0,
		'6: the Claude Code picker reads In use');
	if to_regprocedure('public.qorpera_claude_worker_default_login(uuid,uuid,uuid,uuid)') is not null then
		perform pg_temp.base_assert(public.qorpera_claude_worker_default_login('92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000030', (v_alice ->> 'runId')::uuid, pg_temp.sc_owner())
			= '13000000-0000-4000-8000-0000000000a3'
			and position('login.in_use' in pg_get_functiondef(
				'public.qorpera_claude_worker_default_login(uuid,uuid,uuid,uuid)'::regprocedure)) > 0,
			'6: the Claude-first picker reads In use');
	end if;
	perform pg_temp.base_assert(public.qorpera_member_may_pick_claude('92400000-0000-4000-8000-000000000010',
		pg_temp.sc_owner()) is not distinct from public.qorpera_company_home_allowed('92400000-0000-4000-8000-000000000010'),
		'6: the model menu''s Claude check still means an active login');
end $$;

select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_begin_claude_login_read(
	'92400000-0000-4000-8000-000000000010', '13000000-0000-4000-8000-0000000000a4', extensions.gen_random_uuid(),
	repeat('5', 64), true, null)::text$q$) = 'ok', '7: a read of the login Not in use');
reset role;
select pg_temp.base_assert((select claude_login_id from public.qorpera_native_account_refresh_requests
	where capability_sha256 = repeat('5', 64)) = '13000000-0000-4000-8000-0000000000a4', '7: the read is bound to that login');
update public.qorpera_native_account_refresh_requests set status = 'expired' where capability_sha256 = repeat('5', 64);
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_begin_claude_login_read(
	'92400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), repeat('6', 64), true, null)::text$q$) = 'ok',
	'7: a read that names no login');
reset role;
select pg_temp.base_assert((select claude_login_id from public.qorpera_native_account_refresh_requests
	where capability_sha256 = repeat('6', 64)) = '13000000-0000-4000-8000-0000000000a3', '7: it reads the login In use');
update public.qorpera_native_account_refresh_requests set status = 'expired' where capability_sha256 = repeat('6', 64);
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_begin_claude_login_read(
	'92400000-0000-4000-8000-000000000010', '13000000-0000-4000-8000-0000000000b9', extensions.gen_random_uuid(),
	repeat('7', 64), true, null)::text$q$) = '55000:No Claude login to read here', '7: never another member''s login');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_begin_claude_login_read(
	'92400000-0000-4000-8000-000000000010', '13000000-0000-4000-8000-0000000000a1', extensions.gen_random_uuid(),
	repeat('7', 64), true, null)::text$q$) = '55000:No Claude login to read here', '7: never a signed-out login');
reset role;

select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_begin(repeat('8', 64)) = 'ok', '2: sign-in 5 begins');
select set_config('qorpera_test.sc_in', pg_temp.sc_last() ->> 'login_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sc_complete(current_setting('qorpera_test.sc_in'), repeat('8', 64),
	'13000000-0000-4000-8000-0000000000a5', 'third@example.test') = 'ok', '2: a third account joins');
reset session authorization;
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a3')::text$q$)
	= '55000:This Claude login is in use. Choose the Claude login that new Claude work moves to, then sign out.',
	'8: the In-use login with others left is not signed out without the next');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a3', '13000000-0000-4000-8000-0000000000a3')::text$q$) like '55000:%',
	'8: nor with itself as the next');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a3', '13000000-0000-4000-8000-0000000000b9')::text$q$) like '55000:%',
	'8: nor with another member''s');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a3', '13000000-0000-4000-8000-0000000000a1')::text$q$) like '55000:%',
	'8: nor with a signed-out one');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a4', '13000000-0000-4000-8000-0000000000a5')::text$q$) like '22023:%',
	'8: a login Not in use names no next');
reset role;
select pg_temp.base_assert((select count(*) from public.qorpera_claude_logins
	where owner_user_id = pg_temp.sc_owner() and status = 'active') = 3
	and pg_temp.sc_in_use(pg_temp.sc_owner()) = '13000000-0000-4000-8000-0000000000a3', '8: the refusals changed nothing');
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a3', '13000000-0000-4000-8000-0000000000a5')::text$q$) = 'ok',
	'8: signing out the In-use login, naming the next of two');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a3', '13000000-0000-4000-8000-0000000000a4')::text$q$) = 'ok'
	and pg_temp.sc_last() ->> 'status' = 'revoked', '8: a repeat after a lost answer answers revoked');
reset role;
do $$
declare v_gone public.qorpera_claude_logins := pg_temp.sc_login('13000000-0000-4000-8000-0000000000a3');
begin
	perform pg_temp.base_assert(v_gone.status = 'revoked' and v_gone.encrypted_envelope is null and not v_gone.in_use
		and pg_temp.sc_in_use(pg_temp.sc_owner()) = '13000000-0000-4000-8000-0000000000a5',
		'8: the next login is In use and the old one is wiped');
	perform pg_temp.base_assert((pg_temp.c4_worker('13000000-0000-4000-8000-0000000000d1')).claude_login_id
		= '13000000-0000-4000-8000-0000000000a3', '8: running work keeps the login it has');
end $$;
select pg_temp.base_claims('authenticated', pg_temp.sc_owner());
set local role authenticated;
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a4')::text$q$) = 'ok', '8: a login Not in use signs out plainly');
select pg_temp.base_assert(pg_temp.sc_try($q$select public.qorpera_sign_out_claude_login(
	'13000000-0000-4000-8000-0000000000a5')::text$q$) = 'ok', '8: the last login signs out plainly');
select pg_temp.base_assert(jsonb_array_length(pg_temp.sc_list()) = 0, '8: nothing is listed');
reset role;
set constraints public.qorpera_claude_logins_in_use_held immediate;
select pg_temp.base_assert(pg_temp.sc_in_use(pg_temp.sc_owner()) is null, '8: nothing is In use with no login');
