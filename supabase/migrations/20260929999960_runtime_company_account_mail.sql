-- Company accounts A1-5a: which mail is a company account's own (sign-up codes, reset links), so the company
-- Mailbox shows it only as "GitHub · sign-in mail · used by …" and never its text (the Interfaces design, I5b;
-- members never see an account's secrets). A company account's login is its own tagged address,
-- `<handle>+<tag>@<mail domain>` (find_mail's tags); A1-4's account tool must make it (the agent never picks it).
-- A delivery is account mail when one of its delivered-to addresses is the tagged login of one of the company's
-- accounts, closed ones included (a closed account's late mail is still a code or a link). Only a tagged login
-- marks: a bare mailbox address or a username never does, so no account can hide a whole mailbox. A lookup, not a
-- mark kept at receive time: A1-4 must open the account row before the address is typed into any form, so the
-- first code already matches.

set local lock_timeout = '3s';

-- Every account by login, closed ones too (the open-login unique index leaves closed ones out).
create index qorpera_company_accounts_login
	on public.qorpera_company_accounts(profile_id, environment_id, lower(login));

-- The newest of the company's accounts whose login carries a tag and is one of `p_addresses` (whole addresses,
-- tags included, any letter case, spaces around them ignored): its id, site, and the agent that last used it and
-- when; SQL NULL when none is. A plain read.
create function public.qorpera_company_account_mail(p_profile_id uuid, p_environment_id uuid, p_addresses text[])
returns jsonb
language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('accountId', account.secret_id, 'site', account.site,
		'lastUsedBy', account.last_used_by_staff_agent_id, 'lastUsedAt', account.last_used_at)
	from public.qorpera_company_accounts as account
	where account.profile_id = p_profile_id and account.environment_id = p_environment_id
		and strpos(split_part(account.login, '@', 1), '+') > 0
		and lower(account.login) in (select lower(btrim(address)) from unnest(p_addresses) as address)
	order by account.created_at desc, account.secret_id
	limit 1
$$;
revoke all on function public.qorpera_company_account_mail(uuid,uuid,text[])
	from public, anon, authenticated, service_role;
