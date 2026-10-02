-- Company accounts A1-4a: the database side of the agent's account tool (deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md,
-- "A1-4"). Inert until the tool is offered (A1-4b) and accounts are switched on.
--
-- 1. qorpera_find_company_accounts(p_binding, p_request): one read for the running agent, bound to its run (the
--    native host's 'binding' scope, G2-1). It answers the company's open accounts (reuse first: never a second
--    account where one serves), the company's mailboxes (an account signs up with a tagged address of one), and,
--    when asked by key, the id of the agent's own open todo the account is for (agents know a todo by its key; the
--    opening names it by id). No value, envelope or key id. Refusals the agent can act on are answered as
--    `refused`, since the native host's transport keeps no database message.
-- 2. An agent's account signs up with a tagged address of one of the company's mailboxes,
--    `<mailbox>+<tag>@<mail domain>` (find_mail's tags), so its codes and links are marked as the account's own
--    mail (A1-5a) and its wait finds them. A trigger refuses any other login for an agent's opening (22023, which
--    the vault passes to the agent as a refusal it can act on); a member's hand-over (no agent) keeps any login.
-- 3. Observations name the tool `company_account`.

set local lock_timeout = '3s';

create function pg_temp.account_tool_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company account tool integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The agent's read
-- ---------------------------------------------------------------------------
-- p_request: {todo?: the agent's todo key, site?: a website host}. The company's accounts that are not closed
-- (on that site when one is named: as the account's site or one of its sign-in hosts), newest first, at most 20,
-- with `more` when there are others; the company's mailbox addresses; and the todo's id when one is named, which
-- must be this agent's own open or blocked todo. What the agent can act on is answered, not raised (the native
-- host's transport keeps no database message): `refused` {code, message} while accounts are switched off or the
-- company is a folder company (0A000), and for a malformed request or a todo that is not the agent's open one
-- (22023). A binding that is not this job's run raises, as every native host call does.
create function public.qorpera_find_company_accounts(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_domain text;
	v_site text;
	v_todo_key text;
	v_todo_id uuid;
	v_accounts jsonb;
	v_more boolean;
	v_mailboxes jsonb;
	v_schema constant text := 'qorpera.agent-company-accounts/v1';
begin
	if not coalesce((select settings.enabled from public.qorpera_company_account_settings as settings), false) then
		return jsonb_build_object('schema', v_schema, 'refused',
			jsonb_build_object('code', '0A000', 'message', 'Company accounts are switched off'));
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'company account run binding is malformed' using errcode = '22023';
	end if;
	if public.qorpera_binding_is_folder_v2(p_binding) then
		return jsonb_build_object('schema', v_schema, 'refused', jsonb_build_object('code', '0A000',
			'message', 'Accounts for folder companies come with their connection file'));
	end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['todo', 'site'] <> '{}'::jsonb
		or exists (select 1 from jsonb_each(p_request) as field where jsonb_typeof(field.value) <> 'string')
		or coalesce((p_request ->> 'todo') !~ '^[a-z0-9][a-z0-9._-]{0,63}$', false)
		or (p_request ? 'site' and not public.qorpera_company_account_host_valid(lower(p_request ->> 'site'))) then
		return jsonb_build_object('schema', v_schema, 'runId', v_run.id, 'refused', jsonb_build_object('code', '22023',
			'message', 'Account search is invalid: todo is your todo''s key, site a website''s host name'));
	end if;
	v_site := lower(p_request ->> 'site');
	v_todo_key := p_request ->> 'todo';
	if v_todo_key is not null then
		select todo.id into v_todo_id from public.qorpera_runtime_agent_todos as todo
		where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
			and todo.staff_agent_id = v_run.staff_agent_id and todo.todo_key = v_todo_key
			and todo.state in ('open', 'blocked') and todo.folder_retired_at is null;
		if v_todo_id is null then
			return jsonb_build_object('schema', v_schema, 'runId', v_run.id, 'refused', jsonb_build_object('code', '22023',
				'message', 'No open todo of yours has that key: an account is opened only for one'));
		end if;
	end if;
	with found as (
		select account.* from public.qorpera_company_accounts as account
		where account.profile_id = v_run.profile_id and account.environment_id = v_run.environment_id
			and account.status <> 'closed'
			and (v_site is null or account.site = v_site or v_site = any(account.sign_in_hosts))
		order by account.created_at desc, account.secret_id
		limit 21
	), numbered as (
		select found.*, row_number() over (order by found.created_at desc, found.secret_id) as position from found
	)
	select coalesce(jsonb_agg(jsonb_build_object(
			'accountId', numbered.secret_id,
			'site', numbered.site,
			'signInHosts', to_jsonb(numbered.sign_in_hosts),
			'login', numbered.login,
			'twoStep', numbered.two_step,
			'status', numbered.status,
			'openedByYou', numbered.opened_by_staff_agent_id is not distinct from v_run.staff_agent_id,
			'lastUsedAt', numbered.last_used_at
		) order by numbered.position) filter (where numbered.position <= 20), '[]'::jsonb),
		coalesce(max(numbered.position) > 20, false)
	into v_accounts, v_more
	from numbered;
	select lower(settings.domain) into v_domain from public.qorpera_mail_settings as settings;
	select coalesce(jsonb_agg(mailbox.local_part || '@' || v_domain order by mailbox.local_part), '[]'::jsonb)
	into v_mailboxes
	from public.qorpera_company_mailboxes as mailbox
	where v_domain is not null and mailbox.profile_id = v_run.profile_id
		and mailbox.environment_id = v_run.environment_id and mailbox.removed_at is null;
	return jsonb_strip_nulls(jsonb_build_object('schema', v_schema, 'runId', v_run.id,
		'todo', case when v_todo_id is not null then jsonb_build_object('key', v_todo_key, 'id', v_todo_id) end,
		'mailboxes', v_mailboxes, 'accounts', v_accounts, 'more', v_more));
end
$$;
revoke all on function public.qorpera_find_company_accounts(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_find_company_accounts(jsonb, jsonb) to service_role;
-- The guest's native host reaches it as it reaches find_mail: through the publishable-key entry point, bound to
-- its job's run (G2-1, 20260928409985), and its dispatch lists it (G2-2, cloud-native-host-dispatch.ts).
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_find_company_accounts', 'binding');

-- ---------------------------------------------------------------------------
-- 2. An agent's account signs up with a tagged company address
-- ---------------------------------------------------------------------------
-- `<mailbox>+<tag>@<mail domain>`: the mailbox one of the company's (paused ones included, removed ones not), the
-- tag one find_mail takes ([a-z0-9._-], 1 to 64), the domain the platform's mail domain; any letter case.
create function public.qorpera_company_account_agent_login()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_domain text;
	v_login text := lower(new.login);
	v_mailbox text := public.qorpera_mail_box_part(new.login);
begin
	select lower(settings.domain) into v_domain from public.qorpera_mail_settings as settings;
	if v_domain is null or v_mailbox is null
		or coalesce(v_login !~ '^[^@+]+\+[a-z0-9._-]{1,64}@[^@]+$', true)
		or split_part(v_login, '@', 2) is distinct from v_domain
		or not exists (select 1 from public.qorpera_company_mailboxes as mailbox
			where mailbox.profile_id = new.profile_id and mailbox.environment_id = new.environment_id
				and mailbox.removed_at is null and mailbox.local_part = v_mailbox) then
		raise exception 'An agent''s account signs up with a tagged address of one of the company''s mailboxes: <mailbox>+<tag>@<mail domain>, the tag 1 to 64 of a-z, 0-9, dot, dash and underscore'
			using errcode = '22023';
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_company_account_agent_login() from public, anon, authenticated, service_role,
	qorpera_secret_broker;
create trigger qorpera_company_account_agent_login
	before insert on public.qorpera_company_accounts
	for each row when (new.opened_by_staff_agent_id is not null)
	execute function public.qorpera_company_account_agent_login();

-- ---------------------------------------------------------------------------
-- 3. Observations name the new tool
-- ---------------------------------------------------------------------------
select pg_temp.account_tool_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'send_mail','find_mail',$old$,
	$new$'send_mail','find_mail','company_account',$new$);

drop function pg_temp.account_tool_patch(regprocedure, text, text);
