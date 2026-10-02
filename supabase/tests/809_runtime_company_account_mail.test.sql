-- @fixture 794_runtime_company_accounts.test.sql until "-- 4. Use, a new version, state changes."
-- Company accounts, A1-5a: the lookup that marks a company account's mail. The 794 fixture opens two accounts
-- of company 29…10, environment 29…20: agents@nordlys.example and agents+2@nordlys.example on vercel.com.

-- An older closed account and a newer open one on the same login (only the newest answers), and an account of
-- another environment of the same company (never answers here).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status,
	opened_by_user_id, created_at, closed_at, last_used_at, last_used_by_staff_agent_id, connected_at)
values
	('80900000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', 'stripe.com', 'nordlys+stripe.com@inbox.qorpera.com', 'closed',
		'29000000-0000-4000-8000-000000000001', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', null, null, null),
	('80900000-0000-4000-8000-000000000002', '29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', 'stripe.com', 'nordlys+stripe.com@inbox.qorpera.com', 'connected',
		'29000000-0000-4000-8000-000000000001', '2026-09-03T00:00:00Z', null, '2026-09-04T14:52:00Z',
		'29000000-0000-4000-8000-000000000030', '2026-09-03T00:00:00Z'),
	('80900000-0000-4000-8000-000000000003', '29000000-0000-4000-8000-000000000010',
		'80900000-0000-4000-8000-000000000099', 'netlify.com', 'nordlys+netlify.com@inbox.qorpera.com', 'connected',
		'29000000-0000-4000-8000-000000000001', '2026-09-03T00:00:00Z', null, null, null, '2026-09-03T00:00:00Z'),
	('80900000-0000-4000-8000-000000000004', '29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', 'old.example', 'nordlys+old.example@inbox.qorpera.com', 'closed',
		'29000000-0000-4000-8000-000000000001', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', null, null, null);
select set_config('session_replication_role', 'origin', true);

do $$
declare
	v_company constant uuid := '29000000-0000-4000-8000-000000000010';
	v_environment constant uuid := '29000000-0000-4000-8000-000000000020';
	v_answer jsonb;
begin
	-- The whole address in any letter case, tag included; one of several delivered-to addresses is enough.
	v_answer := public.qorpera_company_account_mail(v_company, v_environment,
		array['ceo@elsewhere.example', 'AGENTS+2@Nordlys.Example']);
	if v_answer is distinct from jsonb_build_object('accountId', current_setting('qorpera_test.ca_account2'),
		'site', 'vercel.com', 'lastUsedBy', null, 'lastUsedAt', null) then
		raise exception 'A tagged address did not find its account: %', v_answer;
	end if;
	if public.qorpera_company_account_mail(v_company, v_environment, array['agents@nordlys.example']) ->> 'accountId'
		is distinct from current_setting('qorpera_test.ca_account') then
		raise exception 'The untagged login did not find its account';
	end if;
	-- The newest account on a login answers, with the agent that last used it; a closed one still answers alone.
	v_answer := public.qorpera_company_account_mail(v_company, v_environment,
		array['nordlys+stripe.com@inbox.qorpera.com']);
	if v_answer is distinct from jsonb_build_object('accountId', '80900000-0000-4000-8000-000000000002',
		'site', 'stripe.com', 'lastUsedBy', '29000000-0000-4000-8000-000000000030',
		'lastUsedAt', '2026-09-04T14:52:00+00:00'::timestamptz) then
		raise exception 'The newest account on a login did not answer: %', v_answer;
	end if;
	if public.qorpera_company_account_mail(v_company, v_environment, array['nordlys+old.example@inbox.qorpera.com'])
		->> 'accountId' is distinct from '80900000-0000-4000-8000-000000000004' then
		raise exception 'A closed account''s mail was not marked';
	end if;
	-- Not a whole address, another environment, another company, nothing: no account.
	if public.qorpera_company_account_mail(v_company, v_environment, array['agents@nordlys']) is not null
		or public.qorpera_company_account_mail(v_company, v_environment,
			array['nordlys+netlify.com@inbox.qorpera.com']) is not null
		or public.qorpera_company_account_mail('79400000-0000-4000-8000-000000000010', v_environment,
			array['agents@nordlys.example']) is not null
		or public.qorpera_company_account_mail(v_company, v_environment, array[]::text[]) is not null
		or public.qorpera_company_account_mail(v_company, v_environment, array[null]::text[]) is not null
		or public.qorpera_company_account_mail(null, v_environment, array['agents@nordlys.example']) is not null
		or public.qorpera_company_account_mail(v_company, v_environment, null) is not null then
		raise exception 'Mail that is no account''s of this company was marked';
	end if;
	-- Only definer-owned callers reach it: no API role, no broker; a plain read.
	if has_function_privilege('anon', 'public.qorpera_company_account_mail(uuid,uuid,text[])', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_company_account_mail(uuid,uuid,text[])', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_company_account_mail(uuid,uuid,text[])', 'EXECUTE')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_company_account_mail(uuid,uuid,text[])', 'EXECUTE')
		or (select not prosecdef or provolatile <> 's' or proconfig is distinct from array['search_path=""']
			from pg_proc where oid = 'public.qorpera_company_account_mail(uuid,uuid,text[])'::regprocedure) then
		raise exception 'The account mail lookup is reachable or shaped differently';
	end if;
end $$;
