-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- The payer never changes without the member (20260930048000, founder decision 2026-10-04). The fixture's owner (…001)
-- pays with login A, on which the fixture's run is leased. Their conversation starts on A; they connect login B with
-- room left; then A reaches its usage limit. A conversation, and work that follows a run, stay on A; only new work
-- starts on B; a company account never stands in for a login at its limit; and work that follows a run on a login that
-- can no longer pay does not start on another one.
reset role;

-- 1. Nothing can move work to another login any more.
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
	if position('20260930048000' in pg_get_functiondef('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure)) = 0
		or position('20260930048000' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) = 0
		or position('20260930048000' in pg_get_functiondef('public.qorpera_eligible_member_accounts(uuid,uuid)'::regprocedure)) = 0 then
		raise exception 'A payer function lacks the 20260930048000 body'; end if;
end $$;

-- 2. The owner's conversation starts on A, their only login.
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
	created_by_user_id,staff_agent_id,staff_version,execution_scope,audience_kind,audience_user_id)
values ('90500000-0000-4000-8000-000000000040','90500000-0000-4000-8000-000000000041',
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020','Second conversation','open',
	'30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000030',1,'{}','member_private',
	'30000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_select_member_session_account('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000040') = (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid,
	'the conversation starts on the owner''s only login');
-- The owner connects login B, for work while away too, with room left.
select set_config('qorpera_test.p905_login',public.qorpera_begin_native_provider_login(
	'30000000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000051','90500000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
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
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p905_sponsor',public.qorpera_create_member_execution_sponsor(
	'30000000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.p905_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true);
reset role;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values ((current_setting('qorpera_test.p905_connection')::jsonb ->> 'connection_id')::uuid,2,
	jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',jsonb_build_array(
		jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));
-- A reaches its usage limit during the fixture's run.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_record_provider_usage_signal(current_setting('qorpera_test.wake_binding')::jsonb,'usage_limit');
reset role;
create function pg_temp.p905(p_key text) returns uuid language sql as $$
	select case p_key
		when 'a' then (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.p905_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.p905_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'company' then (current_setting('qorpera_test.p905_company_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'companyY' then (current_setting('qorpera_test.p905_company_sponsor_y')::jsonb ->> 'binding_id')::uuid end
$$;
create function pg_temp.p905_payer(p_requester text, p_prefer uuid) returns uuid language sql as $$
	select binding_id from public.qorpera_starter_sponsor('30000000-0000-4000-8000-000000000010',
		('30000000-0000-4000-8000-00000000000' || p_requester)::uuid,'30000000-0000-4000-8000-000000000031',p_prefer)
$$;
select pg_temp.wake_assert(public.qorpera_native_account_remaining(pg_temp.p905('a'),2) = 0
	and public.qorpera_native_account_remaining(pg_temp.p905('b'),2) = 80, 'A is at its limit and B has room');

-- 3. The conversation keeps A at its limit; a new conversation takes B.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_select_member_session_account('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000040') = pg_temp.p905('a'), 'the conversation moved off its login at its limit');
select pg_temp.wake_assert(public.qorpera_select_member_session_account('30000000-0000-4000-8000-000000000010',
	'90500000-0000-4000-8000-000000000040') = pg_temp.p905('b'), 'a new conversation did not start on the login with room');
reset role;

-- 4. Work that follows the run stays on A; new work starts on B. A coworker message from the run wakes its recipient on A.
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) = pg_temp.p905('aBinding'),
	'follow-up work moved off its run''s login at its limit');
select pg_temp.wake_assert(pg_temp.p905_payer('1', null) = pg_temp.p905('bBinding'), 'new work did not start on the login with room');
select pg_temp.wake_assert((public.qorpera_member_first_run_sponsor('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000001') ->> 'sponsorBindingId')::uuid = pg_temp.p905('bBinding'),
	'a first run did not start on the login with room');
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
do $$
declare v_send jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	v_send := public.qorpera_send_coworker_message(current_setting('qorpera_test.wake_binding')::jsonb,
		'30000000-0000-4000-8000-000000000031','p905-hello','Can you check the numbers?');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_send ->> 'occurrenceId')::uuid;
	if v_wake.sponsor_binding_id is distinct from pg_temp.p905('aBinding') or v_wake.status <> 'queued' then
		raise exception 'the coworker wake of a run at its limit moved to another login: %', to_jsonb(v_wake); end if;
end $$;

-- Unknown usage on B still ranks before A at its limit.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.p905('b');
select pg_temp.wake_assert(pg_temp.p905_payer('1', null) = pg_temp.p905('bBinding'),
	'new work took a login at its limit before one of unknown usage');
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.p905('b'),2,jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',
	jsonb_build_array(jsonb_build_object('id','primary','label','5 hours','usedPercent',100))));

-- 5. With both logins at their limit, new work stays on the member's own login, never the company account, which pays
-- only for a member with no login of their own. Work that follows a company-paid run stays on the company account.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p905_company_connection',public.qorpera_register_provider_connection(
	'30000000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000070',null,
	'openai','api_key','codex-cli','vault://company/openai','org-fixture','company-api-billing','qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text,true);
select set_config('qorpera_test.p905_company_sponsor',public.qorpera_create_execution_sponsor_binding(
	'30000000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000071','company_api_billing',
	(current_setting('qorpera_test.p905_company_connection')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_set_provider_execution_policy('openai','api_key','codex-cli','supported','enabled',64,null,null);
reset role;
select pg_temp.wake_assert(pg_temp.p905_payer('1', null) in (pg_temp.p905('aBinding'), pg_temp.p905('bBinding')),
	'new work of a member whose logins are at their limit moved to the company account');
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) = pg_temp.p905('aBinding'),
	'follow-up work moved to the company account');
select pg_temp.wake_assert(pg_temp.p905_payer('3', null) = pg_temp.p905('company'),
	'the company account did not pay for a member without a login');
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('company')) = pg_temp.p905('company'),
	'follow-up work of a company-paid run moved to the member''s login');
-- Another member's login pays for none of the owner's work: their work starts anew, on the owner's own login.
select pg_temp.wake_assert(pg_temp.p905_payer('3', pg_temp.p905('aBinding')) = pg_temp.p905('company'),
	'a member''s work followed another member''s login');
-- A second company account Y: work that follows a run on either account stays on it, whichever account an owner names
-- as the agent's own (the one new work would take).
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p905_company_connection_y',public.qorpera_register_provider_connection(
	'30000000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000072',null,
	'openai','api_key','codex-cli','vault://company/openai-y','org-fixture-y','company-api-billing','qorpera-provider-consent/v1',null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text,true);
select set_config('qorpera_test.p905_company_sponsor_y',public.qorpera_create_execution_sponsor_binding(
	'30000000-0000-4000-8000-000000000010','90500000-0000-4000-8000-000000000073','company_api_billing',
	(current_setting('qorpera_test.p905_company_connection_y')::jsonb ->> 'connection_id')::uuid,1,true)::text,true);
select public.qorpera_configure_staff_execution_authority('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000031',pg_temp.p905('companyY'),1,null);
reset role;
select pg_temp.wake_assert((select binding_id from public.qorpera_company_account_sponsor('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000031')) = pg_temp.p905('companyY'), 'the agent''s company account is Y');
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('company')) = pg_temp.p905('company'),
	'follow-up work of a run on company account X moved to the agent''s account Y');
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('companyY')) = pg_temp.p905('companyY'),
	'follow-up work of a run on company account Y moved');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_configure_staff_execution_authority('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000031',pg_temp.p905('company'),1,null);
reset role;
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('companyY')) = pg_temp.p905('companyY'),
	'follow-up work of a run on company account Y moved to the agent''s account X');
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','20')
where connection_id = pg_temp.p905('b');

-- 6. A switches off work while away: work that follows its run does not start, on B or the company account. The
-- conversation keeps A, which cannot pay right now.
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":3,"allow_autonomous":false}'::jsonb)).*
from public.qorpera_provider_connection_versions v where connection_id = pg_temp.p905('a') and version = 2;
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) is null,
	'follow-up work of a login without consent started on another login');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_select_member_session_account('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000040') = pg_temp.p905('a'), 'a conversation left a login that cannot pay right now');
reset role;
-- Nor while the member's computer is recovering, or while an owner or admin has A disabled: neither is the member's
-- choice. (The recovery mark stands in for a recovery request; its row is not needed here.)
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set recovery_pending_id = extensions.gen_random_uuid()
where id = (current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid;
set local session_replication_role = origin;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_select_member_session_account('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000040') = pg_temp.p905('a'), 'a conversation left its login while its computer recovered');
reset role;
set local session_replication_role = replica;
update public.qorpera_member_compute_identities set recovery_pending_id = null
where id = (current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid;
set local session_replication_role = origin;
update public.qorpera_provider_connections set status = 'disabled' where id = pg_temp.p905('a');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_select_member_session_account('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000040') = pg_temp.p905('a'), 'an admin''s disable moved a member''s conversation');
reset role;
update public.qorpera_provider_connections set status = 'active' where id = pg_temp.p905('a');

-- 7. The owner disconnects A: work that follows its run does not start; the conversation takes the owner's first choice.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_native_provider_connection('30000000-0000-4000-8000-000000000010',pg_temp.p905('a'));
select pg_temp.wake_assert(public.qorpera_select_member_session_account('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000040') = pg_temp.p905('b'), 'a conversation kept a disconnected login');
reset role;
select pg_temp.wake_assert(pg_temp.p905_payer('1', pg_temp.p905('aBinding')) is null,
	'follow-up work of a disconnected login started on another login');

rollback;
