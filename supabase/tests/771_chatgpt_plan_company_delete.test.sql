-- @fixture 764_chatgpt_plan_login.test.sql until "-- A plan login is never listed for the account record the node switch-off reads; the Codex login is."
-- Sign in with ChatGPT, slice 1c (20260929900000): deleting a company ends its members' ChatGPT plan logins
-- at OpenAI before the purge. Test 764's fixture leaves the company with a member's plan login and a
-- Codex vault login, and the company's broker.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
do $$
declare v_plan uuid; v_codex uuid;
begin
	select version.connection_id into strict v_plan from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' and version.version = 1;
	select version.connection_id into strict v_codex from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000250' and version.version = 1;
	perform set_config('qorpera_test.r771', jsonb_build_object('plan', v_plan, 'codex', v_codex)::text, false);
	-- Nobody but the kernel calls the two new functions.
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) as role(name)
		cross join unnest(array['public.qorpera_revoke_company_chatgpt_plan_logins(uuid)',
			'public.qorpera_company_chatgpt_plan_logins_open(uuid)']) as fn(signature)
		where has_function_privilege(role.name, fn.signature, 'execute')) then
		raise exception 'a plan deletion helper is callable from the API'; end if;
end $$;

-- The company is being deleted. The finisher revokes the plan login's connection (the Codex login's stays,
-- for the purge), and waits for the vault to end the login.
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001');
do $$
declare v_result jsonb := public.qorpera_finish_company_deletion('16000000-0000-4000-8000-000000000010');
begin
	if v_result ->> 'state' <> 'waiting' or v_result #>> '{holdings,chatgpt_plan_logins}' <> '1' then
		raise exception 'the finisher does not wait for the plan login: %', v_result; end if;
	if (select status from public.qorpera_provider_connections
		where id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid) <> 'revoked' then
		raise exception 'the plan login''s connection was not revoked'; end if;
	if (select status from public.qorpera_provider_connections
		where id = (current_setting('qorpera_test.r771')::jsonb ->> 'codex')::uuid) <> 'active' then
		raise exception 'the Codex login''s connection changed'; end if;
end $$;
-- After 6 hours the finisher stops waiting for it (the login is then deleted with the company).
update public.qorpera_company_deletions set requested_at = requested_at - interval '7 hours'
where profile_id = '16000000-0000-4000-8000-000000000010';
do $$
begin
	if public.qorpera_company_chatgpt_plan_logins_open('16000000-0000-4000-8000-000000000010') <> 0 then
		raise exception 'the finisher waits for a plan login past 6 hours'; end if;
end $$;
update public.qorpera_company_deletions set requested_at = requested_at + interval '7 hours'
where profile_id = '16000000-0000-4000-8000-000000000010';

-- The vault's upkeep takes the login (its connection is revoked) and ends it at OpenAI.
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_chatgpt_plan_revocation(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040', repeat('c',64))), 'ok', 'the vault takes the plan login');
reset session authorization;
do $$
begin
	if current_setting('qorpera_test.plan764_last')::jsonb ->> 'loginId' <> '76400000-0000-4000-8000-000000000150' then
		raise exception 'the vault did not take the deleting company''s plan login: %', current_setting('qorpera_test.plan764_last'); end if;
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_finish_chatgpt_plan_revocation(%L,%L,%L,%L,%s)::text',
	'76400000-0000-4000-8000-000000000040', repeat('c',64), '76400000-0000-4000-8000-000000000150',
	current_setting('qorpera_test.plan764_last')::jsonb #>> '{revocation,token}',
	current_setting('qorpera_test.plan764_last')::jsonb #>> '{revocation,baseVersion}')), 'ok', 'the vault ends it');
reset session authorization;
do $$
declare v_result jsonb := public.qorpera_finish_company_deletion('16000000-0000-4000-8000-000000000010');
begin
	if (select status from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000150') <> 'revoked' then
		raise exception 'the plan login was not marked revoked'; end if;
	if coalesce(v_result #>> '{holdings,chatgpt_plan_logins}', '0') <> '0' then
		raise exception 'the finisher still waits for an ended plan login: %', v_result; end if;
end $$;

rollback;
