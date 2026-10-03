-- @fixture 794_runtime_company_accounts.test.sql until "-- 4. Use, a new version, state changes."
-- Company accounts, A1-4a: the agent's read (its company's accounts and mailboxes, and its todo's id by key) and
-- the rule that an agent's account signs up with a tagged address of one of the company's mailboxes. The 794
-- fixture switches accounts on, gives company 29…10 / environment 29…20 the mailbox agents@nordlys.example, and
-- opens agents+vercel.com@… and then agents+2@… on vercel.com for the agent's open todo 'website-online'.

-- The agent's read, as the native host makes it (service role, the run's binding): 'ok:<answer>' or the refusal.
create function pg_temp.fa_find(p_request text)
returns text language plpgsql as $$
declare v_result text;
begin
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_result := pg_temp.ca_try(format('select public.qorpera_find_company_accounts('
		'current_setting(''qorpera_test.path_binding'')::jsonb, %s)', p_request));
	reset role;
	return v_result;
end
$$;
create function pg_temp.fa_answer(p_result text)
returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- What the agent can act on is answered as `refused`, never raised: 'code:message', or null.
create function pg_temp.fa_refused(p_request text)
returns text language sql as $$
	select (answer -> 'refused' ->> 'code') || ':' || (answer -> 'refused' ->> 'message')
	from (select pg_temp.fa_answer(pg_temp.fa_find(p_request)) as answer) as found
$$;

-- 1. The company's open accounts, newest first; its mailboxes; nothing secret.
do $$
declare v_answer jsonb := pg_temp.fa_answer(pg_temp.fa_find('''{}''::jsonb'));
begin
	if v_answer is distinct from jsonb_build_object('schema', 'qorpera.agent-company-accounts/v1',
		'runId', current_setting('qorpera_test.path_binding')::jsonb ->> 'runId',
		'mailboxes', jsonb_build_array('agents@nordlys.example'),
		'accounts', jsonb_build_array(
			jsonb_build_object('accountId', current_setting('qorpera_test.ca_account2'), 'site', 'vercel.com',
				'signInHosts', '[]'::jsonb, 'login', 'agents+2@nordlys.example', 'twoStep', 'none', 'status', 'pending',
				'openedByYou', true),
			jsonb_build_object('accountId', current_setting('qorpera_test.ca_account'), 'site', 'vercel.com',
				'signInHosts', '[]'::jsonb, 'login', 'agents+vercel.com@nordlys.example', 'twoStep', 'none',
				'status', 'pending', 'openedByYou', true)),
		'more', false) then
		raise exception 'The agent''s read differs: %', v_answer;
	end if;
end $$;

-- 2. The todo's id by its key: only the agent's own open or blocked todo, of this company and environment, not
--    retired with its folder. Todos with other keys, as the agent's own elsewhere: another environment's, another
--    company's, and a retired one.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
	requested_by_user_id, created_by_run_id, updated_by_run_id, folder_environment_id, folder_path, folder_path_version,
	folder_commit_id, folder_retired_at)
select todo.id, todo.company, todo.environment, '29000000-0000-4000-8000-000000000030', todo.key, 'Elsewhere', 'open',
	'29000000-0000-4000-8000-000000000001', run.id, run.id,
	case when todo.retired is not null then todo.environment end,
	case when todo.retired is not null then 'work/todos/retired.md' end,
	case when todo.retired is not null then '81300000-0000-4000-8000-0000000000c1'::uuid end,
	case when todo.retired is not null then '81300000-0000-4000-8000-0000000000c2'::uuid end, todo.retired
from (values
	('81300000-0000-4000-8000-000000000061'::uuid, '29000000-0000-4000-8000-000000000010'::uuid,
		'81300000-0000-4000-8000-000000000099'::uuid, 'other-environment', null::timestamptz),
	('81300000-0000-4000-8000-000000000062'::uuid, '79400000-0000-4000-8000-000000000010'::uuid,
		'29000000-0000-4000-8000-000000000020'::uuid, 'other-company', null::timestamptz),
	('81300000-0000-4000-8000-000000000063'::uuid, '29000000-0000-4000-8000-000000000010'::uuid,
		'29000000-0000-4000-8000-000000000020'::uuid, 'retired', '2026-09-01T00:00:00Z'::timestamptz)
) as todo(id, company, environment, key, retired)
cross join (select (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid as id) as run;
select set_config('session_replication_role', 'origin', true);
do $$
declare v_key text;
begin
	foreach v_key in array array['other-environment', 'other-company', 'retired'] loop
		if coalesce(pg_temp.fa_refused(format('''{"todo": "%s"}''::jsonb', v_key)), '')
			not like '22023:No open todo of yours%' then
			raise exception 'The todo % was found', v_key;
		end if;
	end loop;
end $$;
do $$
begin
	if pg_temp.fa_answer(pg_temp.fa_find('''{"todo": "website-online"}''::jsonb')) -> 'todo'
		is distinct from '{"key": "website-online", "id": "79400000-0000-4000-8000-000000000060"}'::jsonb then
		raise exception 'The open todo''s id was not found';
	end if;
	if pg_temp.fa_refused('''{"todo": "old-task"}''::jsonb')
			is distinct from '22023:No open todo of yours has that key: an account is opened only for one'
		or coalesce(pg_temp.fa_refused('''{"todo": "not-mine"}''::jsonb'), '') not like '22023:No open todo of yours%'
		or coalesce(pg_temp.fa_refused('''{"todo": "nothing-here"}''::jsonb'), '') not like '22023:No open todo of yours%'
		or pg_temp.fa_answer(pg_temp.fa_find('''{"todo": "old-task"}''::jsonb')) ?| array['accounts', 'mailboxes', 'todo'] then
		raise exception 'A done, another agent''s or a missing todo was found';
	end if;
	update public.qorpera_runtime_agent_todos set state = 'blocked' where id = '79400000-0000-4000-8000-000000000060';
	if pg_temp.fa_answer(pg_temp.fa_find('''{"todo": "website-online"}''::jsonb')) #>> '{todo,id}'
		is distinct from '79400000-0000-4000-8000-000000000060' then
		raise exception 'A blocked todo was not found';
	end if;
	update public.qorpera_runtime_agent_todos set state = 'open' where id = '79400000-0000-4000-8000-000000000060';
end $$;

-- A binding that is not the run's raises, as every native host call does.
do $$
declare v_result text;
begin
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_result := pg_temp.ca_try('select public.qorpera_find_company_accounts(null, ''{}''::jsonb)');
	if v_result is distinct from '22023:company account run binding is malformed' then
		raise exception 'A missing binding was answered: %', v_result;
	end if;
	v_result := pg_temp.ca_try('select public.qorpera_find_company_accounts(jsonb_set(current_setting('
		'''qorpera_test.path_binding'')::jsonb, ''{runId}'', to_jsonb(gen_random_uuid()::text)), ''{}''::jsonb)');
	if v_result not like '42501:%' then
		raise exception 'Another run''s binding was answered: %', v_result;
	end if;
	-- The run's own id with another lease: the lease is checked too, not only the run.
	v_result := pg_temp.ca_try('select public.qorpera_find_company_accounts(jsonb_set(current_setting('
		'''qorpera_test.path_binding'')::jsonb, ''{leaseId}'', to_jsonb(gen_random_uuid()::text)), ''{}''::jsonb)');
	if v_result not like '42501:%' then
		raise exception 'Another lease''s binding was answered: %', v_result;
	end if;
	reset role;
end $$;

-- 3. A malformed request is refused, never read as "everything".
do $$
declare v_request text;
begin
	foreach v_request in array array['''{"other": "x"}''::jsonb', '''{"todo": 1}''::jsonb', '''{"todo": "Bad Key"}''::jsonb',
		'''{"site": "not a host"}''::jsonb', '''{"site": ""}''::jsonb', '''[]''::jsonb', 'null::jsonb'] loop
		if coalesce(pg_temp.fa_refused(v_request), '') not like '22023:Account search is invalid%'
			or pg_temp.fa_answer(pg_temp.fa_find(v_request)) ?| array['accounts', 'mailboxes', 'todo'] then
			raise exception 'A malformed request was answered: % -> %', v_request, pg_temp.fa_find(v_request);
		end if;
	end loop;
end $$;

-- 4. Other rows: closed, another environment, another company, one with a sign-in host, and enough to page.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, sign_in_hosts, login, status,
	opened_by_user_id, created_at, closed_at)
values
	('81300000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', 'old.example', '{}', 'agents+old.example@nordlys.example', 'closed',
		'29000000-0000-4000-8000-000000000001', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'),
	('81300000-0000-4000-8000-000000000002', '29000000-0000-4000-8000-000000000010',
		'81300000-0000-4000-8000-000000000099', 'vercel.com', '{}', 'staging+vercel.com@nordlys.example', 'pending',
		'29000000-0000-4000-8000-000000000001', '2026-09-01T00:00:00Z', null),
	('81300000-0000-4000-8000-000000000003', '79400000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', 'vercel.com', '{}', 'team+vercel.com@nordlys.example', 'pending',
		'79400000-0000-4000-8000-000000000001', '2026-09-01T00:00:00Z', null),
	('81300000-0000-4000-8000-000000000004', '29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', 'fly.io', '{auth.fly.io}', 'agents+fly.io@nordlys.example', 'pending',
		'29000000-0000-4000-8000-000000000001', '2026-08-01T00:00:00Z', null);
update public.qorpera_company_accounts
set status = 'connected', connected_at = '2026-08-01T00:00:00Z', last_used_at = '2026-08-02T00:00:00Z'
where secret_id = '81300000-0000-4000-8000-000000000004';
select set_config('session_replication_role', 'origin', true);

do $$
declare v_answer jsonb;
begin
	-- A website by its own host or a sign-in host, in any letter case; a member's account is not "opened by you".
	v_answer := pg_temp.fa_answer(pg_temp.fa_find('''{"site": "Auth.Fly.IO"}''::jsonb'));
	if v_answer -> 'accounts' is distinct from jsonb_build_array(jsonb_build_object(
		'accountId', '81300000-0000-4000-8000-000000000004', 'site', 'fly.io', 'signInHosts', '["auth.fly.io"]'::jsonb,
		'login', 'agents+fly.io@nordlys.example', 'twoStep', 'none', 'status', 'connected', 'openedByYou', false,
		'lastUsedAt', '2026-08-02T00:00:00+00:00'::timestamptz)) then
		raise exception 'The sign-in host did not find its account: %', v_answer;
	end if;
	if jsonb_array_length(pg_temp.fa_answer(pg_temp.fa_find('''{"site": "vercel.com"}''::jsonb')) -> 'accounts') <> 2
		or pg_temp.fa_answer(pg_temp.fa_find('''{"site": "netlify.com"}''::jsonb')) -> 'accounts' <> '[]'::jsonb then
		raise exception 'The site filter differs';
	end if;
	-- Never a closed account, another environment's or another company's.
	v_answer := pg_temp.fa_answer(pg_temp.fa_find('''{}''::jsonb'));
	if (select array_agg(account ->> 'accountId' order by account ->> 'accountId')
			from jsonb_array_elements(v_answer -> 'accounts') as account)
		is distinct from array[current_setting('qorpera_test.ca_account'), current_setting('qorpera_test.ca_account2'),
			'81300000-0000-4000-8000-000000000004']::text[] then
		raise exception 'Accounts of another kind were listed: %', v_answer;
	end if;
end $$;

-- Twenty accounts are shown, newest first, and `more` says there are others.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, opened_by_user_id,
	created_at)
select ('81300000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, '29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020', 'site' || n || '.example', 'agents+site' || n || '@nordlys.example',
	'29000000-0000-4000-8000-000000000001', '2026-07-01T00:00:00Z'::timestamptz + n * interval '1 hour'
from generate_series(1, 20) as n;
select set_config('session_replication_role', 'origin', true);
do $$
declare v_answer jsonb := pg_temp.fa_answer(pg_temp.fa_find('''{}''::jsonb'));
begin
	if jsonb_array_length(v_answer -> 'accounts') <> 20 or v_answer -> 'more' is distinct from 'true'::jsonb
		or v_answer #>> '{accounts,0,accountId}' is distinct from current_setting('qorpera_test.ca_account2')
		or v_answer #>> '{accounts,19,accountId}' is distinct from '81300000-0000-4000-8000-000000000104' then
		raise exception 'The page of accounts differs: %', v_answer;
	end if;
end $$;

-- 5. Switched off, and folder companies (accounts come with their connection file): refused.
update public.qorpera_company_account_settings set enabled = false;
do $$
begin
	if pg_temp.fa_find('''{}''::jsonb') is distinct from
		'ok:{"schema": "qorpera.agent-company-accounts/v1", "refused": {"code": "0A000", "message": "Company accounts are switched off"}}' then
		raise exception 'The read answered while accounts are switched off';
	end if;
end $$;
update public.qorpera_company_account_settings set enabled = true;
select set_config('qorpera_test.fa_job_v2', pg_get_functiondef('public.qorpera_job_is_folder_v2(uuid)'::regprocedure), true);
create or replace function public.qorpera_job_is_folder_v2(p_job_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$ select true $$;
select set_config('qorpera_test.fa_folder', coalesce(pg_temp.fa_refused('''{}''::jsonb'), ''), true);
do $$ begin execute current_setting('qorpera_test.fa_job_v2'); end $$;
do $$
begin
	if current_setting('qorpera_test.fa_folder') not like '0A000:Accounts for folder companies%' then
		raise exception 'A folder company''s run read accounts: %', current_setting('qorpera_test.fa_folder');
	end if;
end $$;

-- 6. An agent's opening needs a tagged address of one of the company's live mailboxes on the mail domain, in any
--    letter case, ASCII only; a member's hand-over keeps any login. Mailboxes that are not this company's in this
--    environment: another company's in another environment ('sales'), another company's in this environment
--    ('billing'), this company's in another environment ('ops').
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_mailboxes(hook_id, profile_id, environment_id, local_part)
values ('81300000-0000-4000-8000-000000000091', '79400000-0000-4000-8000-000000000010',
		'81300000-0000-4000-8000-000000000098', 'sales'),
	('81300000-0000-4000-8000-000000000092', '79400000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', 'billing'),
	('81300000-0000-4000-8000-000000000093', '29000000-0000-4000-8000-000000000010',
		'81300000-0000-4000-8000-000000000099', 'ops');
select set_config('session_replication_role', 'origin', true);
-- What an opening leaves behind, counted before the attempts.
select set_config('qorpera_test.fa_before', (select jsonb_build_object(
	'secrets', (select count(*) from public.qorpera_cloud_secrets),
	'versions', (select count(*) from public.qorpera_cloud_secret_versions),
	'events', (select count(*) from public.qorpera_cloud_secret_audit_events),
	'accounts', (select count(*) from public.qorpera_company_accounts)))::text, true);
do $$
begin
	if pg_temp.fa_answer(pg_temp.fa_find('''{}''::jsonb')) -> 'mailboxes' is distinct from '["agents@nordlys.example"]' then
		raise exception 'Another company''s or environment''s mailbox was listed';
	end if;
end $$;
select pg_temp.ca_receipt('81', 'company_account:open:r81');
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.fa_bare', pg_temp.ca_open('81', 'agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_outside', pg_temp.ca_open('81', 'someone+netlify.com@gmail.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_other_domain', pg_temp.ca_open('81', 'agents+netlify.com@gmail.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_other_box', pg_temp.ca_open('81', 'sales+netlify.com@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_other_company_box', pg_temp.ca_open('81', 'billing+netlify.com@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_other_environment_box', pg_temp.ca_open('81', 'ops+netlify.com@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
-- A look-alike letter (U+0130, the Kelvin sign) in the tag is refused before any lowering: under a Unicode
-- collation lower() makes it netlify.com or key.example, which every later check would take (on a C-locale
-- cluster the tag rule refuses it as well).
select set_config('qorpera_test.fa_lookalike', pg_temp.ca_open('81', 'agents+netl' || chr(304) || 'fy.com@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_kelvin', pg_temp.ca_open('81', 'agents+' || chr(8490) || 'ey.example@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_bad_tag', pg_temp.ca_open('81', 'agents+netlify com@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_long_tag', pg_temp.ca_open('81', 'agents+' || repeat('a', 65) || '@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_two_tags', pg_temp.ca_open('81', 'agents+a+b@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
select set_config('qorpera_test.fa_mixed_case', pg_temp.ca_open('81', 'Agents+Netlify.com@Nordlys.Example',
	'79400000-0000-4000-8000-000000000060', p_site => 'netlify.com'), true);
reset session authorization;
select pg_temp.ca_done('81');
-- A removed mailbox gives no new accounts.
-- (Its row came in with replication off, so the hook it names is never checked.)
select set_config('session_replication_role', 'replica', true);
update public.qorpera_company_mailboxes set removed_at = clock_timestamp() where local_part = 'agents';
select set_config('session_replication_role', 'origin', true);
do $$
begin
	if pg_temp.fa_answer(pg_temp.fa_find('''{}''::jsonb')) -> 'mailboxes' is distinct from '[]' then
		raise exception 'A removed mailbox was listed';
	end if;
end $$;
select pg_temp.ca_receipt('82', 'company_account:open:r82');
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.fa_removed_box', pg_temp.ca_open('82', 'agents+render.com@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'render.com'), true);
reset session authorization;
select pg_temp.ca_done('82');
-- Without a mail domain no agent opens an account, and no mailbox is listed.
select set_config('session_replication_role', 'replica', true);
update public.qorpera_company_mailboxes set removed_at = null where local_part = 'agents';
select set_config('session_replication_role', 'origin', true);
update public.qorpera_mail_settings set domain = null;
select pg_temp.ca_receipt('83', 'company_account:open:r83');
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.fa_no_domain', pg_temp.ca_open('83', 'agents+fly.example@nordlys.example',
	'79400000-0000-4000-8000-000000000060', p_site => 'fly.example'), true);
reset session authorization;
select pg_temp.ca_done('83');
do $$
begin
	if pg_temp.fa_answer(pg_temp.fa_find('''{}''::jsonb')) -> 'mailboxes' is distinct from '[]' then
		raise exception 'A mailbox was listed without a mail domain';
	end if;
end $$;
update public.qorpera_mail_settings set domain = 'nordlys.example';
-- The refused attempts left nothing: one secret, version, audit event and account more, the mixed-case opening's.
do $$
declare v_before jsonb := current_setting('qorpera_test.fa_before')::jsonb;
begin
	if (select count(*) from public.qorpera_cloud_secrets) <> (v_before ->> 'secrets')::bigint + 1
		or (select count(*) from public.qorpera_cloud_secret_versions) <> (v_before ->> 'versions')::bigint + 1
		or (select count(*) from public.qorpera_cloud_secret_audit_events) <> (v_before ->> 'events')::bigint + 1
		or (select count(*) from public.qorpera_company_accounts) <> (v_before ->> 'accounts')::bigint + 1 then
		raise exception 'A refused opening left rows behind: % then %', v_before, jsonb_build_object(
			'secrets', (select count(*) from public.qorpera_cloud_secrets),
			'versions', (select count(*) from public.qorpera_cloud_secret_versions),
			'events', (select count(*) from public.qorpera_cloud_secret_audit_events),
			'accounts', (select count(*) from public.qorpera_company_accounts));
	end if;
end $$;
-- A member's hand-over (no agent, no todo) keeps the login it has.
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, current_version, created_by_user_id)
values ('81300000-0000-4000-8000-000000000050', '29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020', '79400000-0000-4000-8000-000000000040', 'company', null, 'website',
	'stripe-com', 'Payments', 1, '29000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
	envelope_sha256, created_by_user_id)
values ('81300000-0000-4000-8000-000000000050', 1, '79400000-0000-4000-8000-000000000040', 'company-kek-1',
	'\x0c'::bytea, pg_temp.ca_sha('\x0c'), '29000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, opened_by_user_id)
values ('81300000-0000-4000-8000-000000000050', '29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020', 'stripe.com', 'finance@nordlys.example',
	'29000000-0000-4000-8000-000000000001');

do $$
declare
	v_refusal constant text := '22023:An agent''s account signs up with a tagged address of one of the company''s mailboxes: <mailbox>+<tag>@<mail domain>, the tag 1 to 64 of a-z, 0-9, dot, dash and underscore';
	v_name text;
begin
	foreach v_name in array array['fa_bare', 'fa_outside', 'fa_other_domain', 'fa_other_box', 'fa_other_company_box',
		'fa_other_environment_box', 'fa_lookalike', 'fa_kelvin', 'fa_bad_tag', 'fa_long_tag', 'fa_two_tags',
		'fa_removed_box', 'fa_no_domain'] loop
		if current_setting('qorpera_test.' || v_name) is distinct from v_refusal then
			raise exception 'An agent opened an account on % : %', v_name, current_setting('qorpera_test.' || v_name);
		end if;
	end loop;
	if (select account.login from public.qorpera_company_accounts as account
			where account.secret_id::text = pg_temp.ca_id(current_setting('qorpera_test.fa_mixed_case')))
			is distinct from 'Agents+Netlify.com@Nordlys.Example' then
		raise exception 'A tagged address in another letter case was refused: %', current_setting('qorpera_test.fa_mixed_case');
	end if;
	-- Nothing of a refused opening stays: no secret, no account.
	if exists (select 1 from public.qorpera_company_accounts as account
		where account.site in ('netlify.com', 'render.com') and account.login <> 'Agents+Netlify.com@Nordlys.Example') then
		raise exception 'A refused opening left an account';
	end if;
end $$;

-- 7. Reached only as the native host's call bound to the run; the rule's function by no one; observations name the
--    tool.
do $$
begin
	if not has_function_privilege('service_role', 'public.qorpera_find_company_accounts(jsonb,jsonb)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_find_company_accounts(jsonb,jsonb)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_find_company_accounts(jsonb,jsonb)', 'EXECUTE')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_find_company_accounts(jsonb,jsonb)', 'EXECUTE')
		or (select scope from public.qorpera_native_host_calls where name = 'qorpera_find_company_accounts')
			is distinct from 'binding'
		or (select not prosecdef or provolatile <> 'v' or proconfig is distinct from array['search_path=""']
			from pg_proc where oid = 'public.qorpera_find_company_accounts(jsonb,jsonb)'::regprocedure) then
		raise exception 'The agent''s read is reachable or shaped differently';
	end if;
	if has_function_privilege('service_role', 'public.qorpera_company_account_agent_login()', 'EXECUTE')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_company_account_agent_login()', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_company_account_agent_login()', 'EXECUTE') then
		raise exception 'The login rule''s function is reachable';
	end if;
	if pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)
		not like '%''company_account''%' then
		raise exception 'Observations do not name company_account';
	end if;
end $$;
