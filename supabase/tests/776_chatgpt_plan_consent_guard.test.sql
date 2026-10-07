-- @fixture 764_chatgpt_plan_login.test.sql until "-- The plan login's own checks start here"
-- A ChatGPT plan's consent guard on folder-v2 (ported from snapshot-v1 in the legacy sweep; Sign in with ChatGPT,
-- 20260928369980): a plan pays for work while its member is away only by the member's own choice. The consent call
-- alone refuses to turn a plan on, and a choice counts only for the connection it names and only for its own call;
-- qorpera_set_chatgpt_plan_work_while_away, the member's switch, is for the member's own plan only, and turns it on
-- and off. Test 764's fixture leaves the owner with a plan login and a Codex vault login.
reset role;
do $$
declare v_plan uuid; v_codex uuid;
begin
	select version.connection_id into strict v_plan from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' and version.version = 1;
	select version.connection_id into strict v_codex from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000250' and version.version = 1;
	perform set_config('qorpera_test.r776', jsonb_build_object('plan', v_plan, 'codex', v_codex)::text, false);
	if has_function_privilege('anon', 'public.qorpera_set_chatgpt_plan_work_while_away(uuid,uuid,boolean)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_set_chatgpt_plan_work_while_away(uuid,uuid,boolean)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_set_chatgpt_plan_work_while_away(uuid,uuid,boolean)', 'execute') then
		raise exception 'the switch has the wrong callers'; end if;
end $$;
create function pg_temp.r776(p_key text) returns uuid language sql as $$
	select (current_setting('qorpera_test.r776')::jsonb ->> p_key)::uuid
$$;
create function pg_temp.r776_allow(p_connection uuid) returns text language sql as $$
	select allow_autonomous::text from public.qorpera_provider_connection_versions
	where connection_id = p_connection order by version desc limit 1
$$;
create function pg_temp.r776_call(p_user text, p_function text, p_connection uuid, p_on boolean) returns text
language plpgsql as $$
begin
	perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, false);
	set local role authenticated;
	return pg_temp.plan764_try(format('select public.%I(%L,%L,%L)::text', p_function,
		'92400000-0000-4000-8000-000000000010', p_connection, p_on));
end $$;

-- 1. The consent call alone never turns a plan on, even with a choice the member made for another connection.
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000001',
	'qorpera_consent_provider_connection_autonomous', pg_temp.r776('plan'), true),
	'55000:Turn on work while you''re away for this ChatGPT plan in Settings', 'the consent call on a plan');
reset role;
select pg_temp.plan764_expect(pg_temp.r776_allow(pg_temp.r776('plan')), 'false', 'the plan stays off');
select set_config('qorpera.chatgpt_plan_member_choice', pg_temp.r776('codex')::text, true);
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000001',
	'qorpera_consent_provider_connection_autonomous', pg_temp.r776('plan'), true),
	'55000:Turn on work while you''re away for this ChatGPT plan in Settings', 'a choice made for another connection');
reset role;
select set_config('qorpera.chatgpt_plan_member_choice', '', true);
select pg_temp.plan764_expect(pg_temp.r776_allow(pg_temp.r776('plan')), 'false', 'the plan stays off');

-- 2. The switch is for its member's own ChatGPT plan only: not a Codex login, and not another member's plan (which
--    would make the owner's subscription pay for work while the owner is away).
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000001',
	'qorpera_set_chatgpt_plan_work_while_away', pg_temp.r776('codex'), true),
	'42501:ChatGPT plan login is unavailable', 'the switch on a Codex login');
reset role;
select pg_temp.plan764_expect(pg_temp.r776_allow(pg_temp.r776('codex')), 'false', 'the Codex login stays off');
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000002',
	'qorpera_set_chatgpt_plan_work_while_away', pg_temp.r776('plan'), true),
	'42501:ChatGPT plan login is unavailable', 'another member''s plan');
reset role;
select pg_temp.plan764_expect(pg_temp.r776_allow(pg_temp.r776('plan')), 'false', 'the plan stays off');

-- 3. The member's switch turns the plan on, and its mark lasts for that call only; the consent call and the switch
--    each turn it off.
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000001',
	'qorpera_set_chatgpt_plan_work_while_away', pg_temp.r776('plan'), true), 'ok', 'the member turns their plan on');
reset role;
do $$
begin
	if current_setting('qorpera_test.plan764_last')::jsonb ->> 'allow_autonomous' is distinct from 'true'
		or current_setting('qorpera_test.plan764_last')::jsonb ->> 'changed' is distinct from 'true' then
		raise exception 'the switch did not turn the plan on: %', current_setting('qorpera_test.plan764_last'); end if;
	if coalesce(current_setting('qorpera.chatgpt_plan_member_choice', true), '') <> '' then
		raise exception 'the member''s choice outlived its call'; end if;
end $$;
select pg_temp.plan764_expect(pg_temp.r776_allow(pg_temp.r776('plan')), 'true', 'the plan is on');
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000001',
	'qorpera_consent_provider_connection_autonomous', pg_temp.r776('plan'), false), 'ok', 'the consent call turns a plan off');
reset role;
select pg_temp.plan764_expect(pg_temp.r776_allow(pg_temp.r776('plan')), 'false', 'the plan is off');
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000001',
	'qorpera_set_chatgpt_plan_work_while_away', pg_temp.r776('plan'), true), 'ok', 'and the switch on again');
reset role;
select pg_temp.plan764_expect(pg_temp.r776_call('92400000-0000-4000-8000-000000000001',
	'qorpera_set_chatgpt_plan_work_while_away', pg_temp.r776('plan'), false), 'ok', 'and off');
reset role;
select pg_temp.plan764_expect(pg_temp.r776_allow(pg_temp.r776('plan')), 'false', 'the plan is off again');

rollback;
