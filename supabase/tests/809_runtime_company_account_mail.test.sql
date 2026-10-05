-- Company accounts, A1-5a: the lookup that marks a company account's mail. A plain read of the account rows, so the
-- test writes them by hand on its own folder-v2 company (company 80…c1, environment 80…e1): two accounts on vercel.com
-- with tagged addresses of the company's mailbox agents@nordlys.example, agents+vercel.com@nordlys.example and
-- agents+2@nordlys.example, as an agent opens them.
begin;

insert into auth.users(id, email) values ('80900000-0000-4000-8000-0000000000a1', 'account-mail-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('80900000-0000-4000-8000-0000000000c1', 'Nordlys', '80900000-0000-4000-8000-0000000000a1');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('80900000-0000-4000-8000-0000000000c1', '80900000-0000-4000-8000-0000000000a1', 'account-mail-owner@example.test',
	'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('80900000-0000-4000-8000-0000000000e1', '80900000-0000-4000-8000-0000000000c1', 'Nordlys', 1,
	'80900000-0000-4000-8000-0000000000a1');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('80900000-0000-4000-8000-0000000000e1') \g /dev/null
select set_config('request.jwt.claims', '', true) \g /dev/null
do $$
begin
	if not public.qorpera_company_is_folder_v2('80900000-0000-4000-8000-0000000000c1') then
		raise exception 'The account mail company is not a folder-v2 company';
	end if;
end $$;

-- The two vercel.com accounts; an older closed account and a newer open one on the same login, stored in mixed case
-- (only the newest answers, though the older one was used last);
-- an account of another environment of the same company (never answers here); two accounts opened at the same
-- moment on one login (the lower id answers); an older open account and a newer closed one on one login (the
-- newest answers, closed or not); and a login on the bare mailbox address (never marks).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status,
	opened_by_user_id, created_at, closed_at, last_used_at, last_used_by_staff_agent_id, connected_at)
values
	('80900000-0000-4000-8000-000000000011', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'vercel.com', 'agents+vercel.com@nordlys.example', 'pending',
		'80900000-0000-4000-8000-0000000000a1', '2026-09-20T00:00:00Z', null, null, null, null),
	('80900000-0000-4000-8000-000000000012', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'vercel.com', 'agents+2@nordlys.example', 'pending',
		'80900000-0000-4000-8000-0000000000a1', '2026-09-20T00:00:01Z', null, null, null, null),
	('80900000-0000-4000-8000-000000000001', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'stripe.com', 'Nordlys+Stripe.com@Inbox.Qorpera.com', 'closed',
		'80900000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-05T00:00:00Z',
		'80900000-0000-4000-8000-0000000000d1', null),
	('80900000-0000-4000-8000-000000000002', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'stripe.com', 'Nordlys+Stripe.com@Inbox.Qorpera.com', 'connected',
		'80900000-0000-4000-8000-0000000000a1', '2026-09-03T00:00:00Z', null, '2026-09-04T14:52:00Z',
		'80900000-0000-4000-8000-0000000000d1', '2026-09-03T00:00:00Z'),
	('80900000-0000-4000-8000-000000000003', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-000000000099', 'netlify.com', 'nordlys+netlify.com@inbox.qorpera.com', 'connected',
		'80900000-0000-4000-8000-0000000000a1', '2026-09-03T00:00:00Z', null, null, null, '2026-09-03T00:00:00Z'),
	('80900000-0000-4000-8000-000000000004', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'old.example', 'nordlys+old.example@inbox.qorpera.com', 'closed',
		'80900000-0000-4000-8000-0000000000a1', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', null, null, null),
	('80900000-0000-4000-8000-000000000006', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'fly.io', 'nordlys+fly.io@inbox.qorpera.com', 'closed',
		'80900000-0000-4000-8000-0000000000a1', '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z', null, null, null),
	('80900000-0000-4000-8000-000000000005', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'fly.io', 'nordlys+fly.io@inbox.qorpera.com', 'closed',
		'80900000-0000-4000-8000-0000000000a1', '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z', null, null, null),
	('80900000-0000-4000-8000-000000000007', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'render.com', 'nordlys+render.com@inbox.qorpera.com', 'connected',
		'80900000-0000-4000-8000-0000000000a1', '2026-08-07T00:00:00Z', null, null, null, '2026-08-07T00:00:00Z'),
	('80900000-0000-4000-8000-000000000008', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'render.com', 'nordlys+render.com@inbox.qorpera.com', 'closed',
		'80900000-0000-4000-8000-0000000000a1', '2026-08-08T00:00:00Z', '2026-08-09T00:00:00Z', null, null, null),
	('80900000-0000-4000-8000-000000000009', '80900000-0000-4000-8000-0000000000c1',
		'80900000-0000-4000-8000-0000000000e1', 'bare.example', 'nordlys@inbox.qorpera.com', 'closed',
		'80900000-0000-4000-8000-0000000000a1', '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z', null, null, null);
select set_config('session_replication_role', 'origin', true);

do $$
declare
	v_company constant uuid := '80900000-0000-4000-8000-0000000000c1';
	v_environment constant uuid := '80900000-0000-4000-8000-0000000000e1';
	v_answer jsonb;
begin
	-- The whole address in any letter case, tag included; one of several delivered-to addresses is enough.
	v_answer := public.qorpera_company_account_mail(v_company, v_environment,
		array['ceo@elsewhere.example', 'AGENTS+2@Nordlys.Example']);
	if v_answer is distinct from jsonb_build_object('accountId', '80900000-0000-4000-8000-000000000012',
		'site', 'vercel.com', 'lastUsedBy', null, 'lastUsedAt', null) then
		raise exception 'A tagged address did not find its account: %', v_answer;
	end if;
	-- Only a tagged login marks: the bare mailbox address and an untagged login never do, so no account hides a
	-- whole mailbox.
	if public.qorpera_company_account_mail(v_company, v_environment, array['agents@nordlys.example']) is not null
		or public.qorpera_company_account_mail(v_company, v_environment, array['nordlys@inbox.qorpera.com'])
			is not null then
		raise exception 'An untagged login marked mail';
	end if;
	-- The newest account on a login answers, with the agent that last used it, matched in any letter case and with
	-- spaces around the address; a closed one still answers alone.
	v_answer := public.qorpera_company_account_mail(v_company, v_environment,
		array[' nordlys+stripe.com@inbox.qorpera.com ']);
	if v_answer is distinct from jsonb_build_object('accountId', '80900000-0000-4000-8000-000000000002',
		'site', 'stripe.com', 'lastUsedBy', '80900000-0000-4000-8000-0000000000d1',
		'lastUsedAt', '2026-09-04T14:52:00+00:00'::timestamptz) then
		raise exception 'The newest account on a login did not answer: %', v_answer;
	end if;
	if public.qorpera_company_account_mail(v_company, v_environment, array['nordlys+old.example@inbox.qorpera.com'])
		->> 'accountId' is distinct from '80900000-0000-4000-8000-000000000004' then
		raise exception 'A closed account''s mail was not marked';
	end if;
	-- Opened at the same moment: the lower id; an older open account and a newer closed one: the newer.
	if public.qorpera_company_account_mail(v_company, v_environment, array['nordlys+fly.io@inbox.qorpera.com'])
			->> 'accountId' is distinct from '80900000-0000-4000-8000-000000000005'
		or public.qorpera_company_account_mail(v_company, v_environment, array['nordlys+render.com@inbox.qorpera.com'])
			->> 'accountId' is distinct from '80900000-0000-4000-8000-000000000008' then
		raise exception 'The tie-break between accounts on one login changed';
	end if;
	-- Not a whole address (a part of one, or one that holds a login), another environment, another company,
	-- nothing: no account.
	if public.qorpera_company_account_mail(v_company, v_environment, array['agents+2@nordlys']) is not null
		or public.qorpera_company_account_mail(v_company, v_environment,
			array['xagents+2@nordlys.example', 'agents+2@nordlys.example.org']) is not null
		or public.qorpera_company_account_mail(v_company, v_environment,
			array['nordlys+netlify.com@inbox.qorpera.com']) is not null
		or public.qorpera_company_account_mail('79400000-0000-4000-8000-000000000010', v_environment,
			array['agents+2@nordlys.example']) is not null
		or public.qorpera_company_account_mail(v_company, v_environment, array[]::text[]) is not null
		or public.qorpera_company_account_mail(v_company, v_environment, array[null]::text[]) is not null
		or public.qorpera_company_account_mail(null, v_environment, array['agents+2@nordlys.example']) is not null
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

rollback;
