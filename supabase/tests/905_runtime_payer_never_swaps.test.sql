-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Work moves to the member's own login with room (20260930575000, founder decision 2026-11-05; it reverses the 4 October
-- rule of 20260930059000 for a member's own logins). The base's owner (…001) pays with login A, on which Alice's run is
-- leased. Their conversation (Alice's thread) starts on A; they connect login B with room left; then A reaches its usage
-- limit. The conversation and work that follows a run move to B, and the usage-limit notice names B; new work (Bob's
-- thread) starts on B. With no login of theirs with room, work stays (and waits) on its login; a company account never
-- stands in for a member's login, and a member never pays with another member's login. A login that cannot pay now
-- (disabled, disconnected, without consent) gives way to the member's other login with room too. A usage limit's wall
-- ends at the provider's reset, and at the latest a day after the limit.
select set_config('qorpera_test.p905_conversation', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000030')), true);
select set_config('qorpera_test.p905_second', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031')), true);
create function pg_temp.p905_session(p_key text) returns uuid language sql as $$
	select current_setting('qorpera_test.p905_' || p_key)::uuid
$$;
select pg_temp.base_assert(pg_temp.p905_session('conversation') is not null and pg_temp.p905_session('second') is not null
	and pg_temp.p905_session('conversation') <> pg_temp.p905_session('second'), 'Alice''s and Bob''s threads have their sessions');

-- 1. The old handoff stays gone; the new helpers are internal.
do $$
begin
	if to_regprocedure('public.qorpera_handoff_run_sponsor(uuid,text)') is not null
		or to_regprocedure('public.qorpera_connection_at_limit(uuid)') is not null
		or to_regprocedure('public.qorpera_member_plan_connection_usable(uuid,uuid,uuid)') is not null then
		raise exception 'A way to move work to another login remains'; end if;
	if has_function_privilege('anon', 'public.qorpera_member_live_accounts(uuid,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_member_live_accounts(uuid,uuid)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_member_live_accounts(uuid,uuid)', 'EXECUTE') then
		raise exception 'API clients can read a member''s logins'; end if;
	if position('20260930575000' in pg_get_functiondef('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure)) = 0
		or position('20260930575000' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) = 0
		or position('20260930059000' in pg_get_functiondef('public.qorpera_eligible_member_accounts(uuid,uuid)'::regprocedure)) = 0 then
		raise exception 'A payer function lacks its 20260930575000 or 20260930059000 body'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_member_work_logins(uuid,uuid,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_member_session_login_with_room(uuid,uuid,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_routine_wake_payer(uuid,uuid,uuid,uuid,bigint)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_usage_limit_moved_to(uuid,uuid,uuid)', 'EXECUTE') then
		raise exception 'API clients can read which login work moves to'; end if;
end $$;

-- 2. The owner's conversation starts on A, their only login.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid,
	'the conversation starts on the owner''s only login');
-- The owner connects login B, for work while away too, with room left.
select set_config('qorpera_test.p905_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000051','90500000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true);
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.p905_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.p905_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'90500000-0000-4000-8000-000000000060',
	'object://native-capsules/90500000-0000-4000-8000-000000000060',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true);
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.p905_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p905_sponsor',public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.p905_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true);
reset role;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values ((current_setting('qorpera_test.p905_connection')::jsonb ->> 'connection_id')::uuid,2,
	jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',jsonb_build_array(
		jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));
-- A reaches its usage limit during the fixture's run.
select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_record_provider_usage_signal(current_setting('qorpera_test.base_binding')::jsonb,'usage_limit');
reset role;
create function pg_temp.p905(p_key text) returns uuid language sql as $$
	select case p_key
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.p905_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.p905_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'company' then (current_setting('qorpera_test.p905_company_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'companyY' then (current_setting('qorpera_test.p905_company_sponsor_y')::jsonb ->> 'binding_id')::uuid end
$$;
create function pg_temp.p905_payer(p_requester text, p_prefer uuid) returns uuid language sql as $$
	select binding_id from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		('92400000-0000-4000-8000-00000000000' || p_requester)::uuid,'92400000-0000-4000-8000-000000000031',p_prefer)
$$;
select pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.p905('a'),2) = 0
	and public.qorpera_native_account_remaining(pg_temp.p905('b'),2) = 80, 'A is at its limit and B has room');
-- The owner is told, in one notice: A reached its limit, and work moves to B.
select pg_temp.base_assert((select count(*) from public.qorpera_member_notifications notice
	where notice.user_id = '92400000-0000-4000-8000-000000000001' and notice.kind = 'provider_usage_limit'
		and notice.acknowledged_at is null and notice.subject -> 'movedTo' ->> 'connectionId' = pg_temp.p905('b')::text
		and notice.subject ->> 'connectionId' = pg_temp.p905('a')::text and notice.subject ? 'accountEmail') = 1,
	'the usage-limit notice does not name the login work moves to');

-- 3. The conversation moves from A at its limit to B; a new conversation takes B.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = pg_temp.p905('b'), 'the conversation stayed on its login at its limit');
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('second')) = pg_temp.p905('b'), 'a new conversation did not start on the login with room');
-- Another member never gets the owner's login: the contributor has none of their own, so their conversation has none.
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('second')) is null, 'a member''s conversation took another member''s login');
reset role;
select pg_temp.base_assert((select connection_id from public.qorpera_member_session_accounts
	where session_id = pg_temp.p905_session('conversation') and user_id = '92400000-0000-4000-8000-000000000001')
	= pg_temp.p905('b'), 'the conversation''s saved login is not B');

-- 4. Work that follows the run moves to B; new work starts on B. A coworker message from the run wakes its recipient on B.
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) = pg_temp.p905('bBinding'),
	'follow-up work stayed on its run''s login at its limit');
select pg_temp.base_assert(pg_temp.p905_payer('1', null) = pg_temp.p905('bBinding'), 'new work did not start on the login with room');
select pg_temp.base_assert((public.qorpera_member_first_run_sponsor('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000001') ->> 'sponsorBindingId')::uuid = pg_temp.p905('bBinding'),
	'a first run did not start on the login with room');
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress');
do $$
declare v_send jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	v_send := public.qorpera_send_coworker_message(current_setting('qorpera_test.base_binding')::jsonb,
		'92400000-0000-4000-8000-000000000031','p905-hello','Can you check the numbers?');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid;
	if v_wake.sponsor_binding_id is distinct from pg_temp.p905('bBinding') or v_wake.status <> 'queued' then
		raise exception 'the coworker wake of a run at its limit did not move to the login with room: %', to_jsonb(v_wake); end if;
end $$;

-- Unknown usage on B still ranks before A at its limit.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.p905('b');
select pg_temp.base_assert(pg_temp.p905_payer('1', null) = pg_temp.p905('bBinding'),
	'new work took a login at its limit before one of unknown usage');
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) = pg_temp.p905('bBinding'),
	'follow-up work did not move to a login of unknown usage');
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.p905('b'),2,jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',
	jsonb_build_array(jsonb_build_object('id','primary','label','5 hours','usedPercent',100))));

-- 5. With both logins at their limit, new work stays on the member's own login, never the company account, which pays
-- only for a member with no login of their own. Work that follows a run stays on its login (and waits for it), and work
-- that follows a company-paid run stays on the company account.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p905_company_connection',public.qorpera_register_provider_connection(
	'92400000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000070',null,
	'openai','api_key','codex-cli','vault://company/openai','org-fixture','company-api-billing','qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text,true);
select set_config('qorpera_test.p905_company_sponsor',public.qorpera_create_execution_sponsor_binding(
	'92400000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000071','company_api_billing',
	(current_setting('qorpera_test.p905_company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_set_provider_execution_policy('openai','api_key','codex-cli','supported','enabled',64,null,null);
reset role;
select pg_temp.base_assert(pg_temp.p905_payer('1', null) in (pg_temp.p905('aBinding'), pg_temp.p905('bBinding')),
	'new work of a member whose logins are at their limit moved to the company account');
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) = pg_temp.p905('aBinding'),
	'follow-up work moved while no login had room, or to the company account');
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = pg_temp.p905('b'), 'a conversation moved while no login had room');
reset role;
select pg_temp.base_assert(pg_temp.p905_payer('3', null) = pg_temp.p905('company'),
	'the company account did not pay for a member without a login');
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('company')) = pg_temp.p905('company'),
	'follow-up work of a company-paid run moved to the member''s login');
-- Another member's login pays for none of the owner's work: their work starts anew, on the owner's own login.
select pg_temp.base_assert(pg_temp.p905_payer('3', pg_temp.p905('aBinding')) = pg_temp.p905('company'),
	'a member''s work followed another member''s login');
-- A second company account Y: work that follows a run on either account stays on it, whichever account an owner names
-- as the agent's own (the one new work would take).
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p905_company_connection_y',public.qorpera_register_provider_connection(
	'92400000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000072',null,
	'openai','api_key','codex-cli','vault://company/openai-y','org-fixture-y','company-api-billing','qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text,true);
select set_config('qorpera_test.p905_company_sponsor_y',public.qorpera_create_execution_sponsor_binding(
	'92400000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000073','company_api_billing',
	(current_setting('qorpera_test.p905_company_connection_y')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
select public.qorpera_configure_staff_execution_authority('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000031',pg_temp.p905('companyY'),1,null);
reset role;
select pg_temp.base_assert((select binding_id from public.qorpera_company_account_sponsor('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000031')) = pg_temp.p905('companyY'), 'the agent''s company account is Y');
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('company')) = pg_temp.p905('company'),
	'follow-up work of a run on company account X moved to the agent''s account Y');
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('companyY')) = pg_temp.p905('companyY'),
	'follow-up work of a run on company account Y moved');
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_configure_staff_execution_authority('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000031',pg_temp.p905('company'),1,null);
reset role;
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('companyY')) = pg_temp.p905('companyY'),
	'follow-up work of a run on company account Y moved to the agent''s account X');
-- A company account that can no longer pay stops the work that follows its runs; Y, which could, never stands in.
update public.qorpera_provider_connections set status = 'disabled'
where id = (current_setting('qorpera_test.p905_company_connection')::jsonb ->> 'connection_id')::uuid;
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('company')) is null,
	'follow-up work of a disabled company account moved to another account');
update public.qorpera_provider_connections set status = 'active'
where id = (current_setting('qorpera_test.p905_company_connection')::jsonb ->> 'connection_id')::uuid;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":false}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.p905_company_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('company')) is null,
	'follow-up work of a company account without consent moved to another account');
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('companyY')) = pg_temp.p905('companyY'),
	'follow-up work of a run on company account Y stopped');
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','20')
where connection_id = pg_temp.p905('b');

-- 6. The wall of a usage limit ends at the provider's reset, and at the latest a day after the limit. A's reset is
-- three days ahead: a day after its limit, A has room again.
update public.qorpera_provider_connection_usage_signals set resets_at = statement_timestamp() + interval '3 days',
	observed_at = statement_timestamp() - interval '1 hour'
where provider_connection_id = pg_temp.p905('a') and signal_kind = 'usage_limit';
select pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.p905('a'),2) = 0,
	'a known reset ahead did not hold the wall within the day');
update public.qorpera_provider_connection_usage_signals set observed_at = statement_timestamp() - interval '25 hours'
where provider_connection_id = pg_temp.p905('a') and signal_kind = 'usage_limit';
select pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.p905('a'),2) <> 0
	and public.qorpera_native_account_usage_limit_reset(pg_temp.p905('a')) is null,
	'a usage limit''s wall held for more than a day');

-- 7. The conversation's login B cannot pay now: an owner or admin disabled it. A has room again, so the conversation
-- and work that follows B's runs move to A. Once B can pay again, the conversation stays on A (a login with room is kept).
update public.qorpera_provider_connections set status = 'disabled' where id = pg_temp.p905('b');
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = pg_temp.p905('a'), 'a conversation stayed on a disabled login');
reset role;
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('bBinding')) = pg_temp.p905('aBinding'),
	'follow-up work of a disabled login did not move to the login with room');
update public.qorpera_provider_connections set status = 'active' where id = pg_temp.p905('b');
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','20')
where connection_id = pg_temp.p905('b');
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = pg_temp.p905('a'), 'a conversation left a login with room');
reset role;
-- While the member's computer is recovering, none of their logins can pay: the conversation keeps A and waits.
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set recovery_pending_id = extensions.gen_random_uuid()
where id = (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
set local session_replication_role = origin;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = pg_temp.p905('a'), 'a conversation left its login while its computer recovered');
reset role;
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set recovery_pending_id = null
where id = (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
set local session_replication_role = origin;

-- 8. A switches off work while away: work that follows its run moves to B. The conversation needs no consent and keeps A.
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":3,"allow_autonomous":false}'::jsonb)).*
from public.qorpera_provider_connection_versions v where connection_id = pg_temp.p905('a') and version = 2;
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) = pg_temp.p905('bBinding'),
	'follow-up work of a login without consent did not move to the login with room');

-- 9. The owner disconnects A: the conversation moves to B, and so does work that follows A's run. The owner's pick by
-- hand still works, never with a disconnected login, and another member cannot pick the owner's login.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_native_provider_connection('92400000-0000-4000-8000-000000000010',pg_temp.p905('a'));
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = pg_temp.p905('b'), 'a conversation stayed on a disconnected login');
select pg_temp.base_error($q$select public.qorpera_choose_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation'),(current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid)$q$,
	'22023','This login cannot pay for your conversation');
select pg_temp.base_assert(public.qorpera_choose_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation'),pg_temp.p905('b')) = pg_temp.p905('b'), 'the owner could not pick B by hand');
select pg_temp.base_assert(public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('conversation')) = pg_temp.p905('b'), 'the conversation did not keep the login picked by hand');
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.base_error($q$select public.qorpera_choose_member_session_account('92400000-0000-4000-8000-000000000010',
	pg_temp.p905_session('second'),'$q$ || pg_temp.p905('b') || $q$')$q$,'22023','This login cannot pay for your conversation');
reset role;
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) = pg_temp.p905('bBinding'),
	'follow-up work of a disconnected login did not move to the login with room');
-- With B at its limit too, follow-up work of the disconnected A has no login to pay with: it does not start.
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','100')
where connection_id = pg_temp.p905('b');
select pg_temp.base_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) is null,
	'follow-up work of a disconnected login started on a login at its limit');

rollback;
