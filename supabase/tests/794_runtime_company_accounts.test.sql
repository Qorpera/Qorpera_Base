-- @fixture 290_company_file_path_gateway.test.sql until "create function pg_temp.path_plan("
-- Company accounts, A1-1: the vault's records for a company's website
-- accounts. Real admission, assignment and native lease from the 290 fixture;
-- every account call is the broker's, bound to an executing company_account
-- effect receipt of that run. An account is opened only for an open todo of
-- the run's own agent. Members read the facts and never a value; an owner or
-- admin removes an account and its envelopes go at once.

insert into auth.users(id,email) values
	('79400000-0000-4000-8000-000000000001','accounts-other-owner@example.test'),
	('79400000-0000-4000-8000-000000000003','accounts-admin@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('79400000-0000-4000-8000-000000000010','Other company','79400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('79400000-0000-4000-8000-000000000010','79400000-0000-4000-8000-000000000001',
		'accounts-other-owner@example.test','Other owner','owner'),
	('29000000-0000-4000-8000-000000000010','79400000-0000-4000-8000-000000000003',
		'accounts-admin@example.test','Admin','admin');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('79400000-0000-4000-8000-000000000040','29000000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','company-kek-1',repeat('c',64)),
	('79400000-0000-4000-8000-000000000041','79400000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','other-kek-1',repeat('e',64));

-- The run acknowledges its wake, as every run does before effects.
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','accounts-ack','Putting the website online.','progress');
end $$;
reset role;

-- The agent's own open todo, one it finished, and another agent's.
insert into public.qorpera_runtime_agent_todos(id,profile_id,environment_id,staff_agent_id,todo_key,title,state,
	requested_by_user_id,created_by_run_id,updated_by_run_id)
select todo.id,'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000020',todo.staff,todo.key,
	todo.title,todo.state,'29000000-0000-4000-8000-000000000001',run.id,run.id
from (values
	('79400000-0000-4000-8000-000000000060'::uuid,'29000000-0000-4000-8000-000000000030'::uuid,'website-online',
		'Put the website online','open'),
	('79400000-0000-4000-8000-000000000061'::uuid,'29000000-0000-4000-8000-000000000030'::uuid,'old-task',
		'An old task','done'),
	('79400000-0000-4000-8000-000000000062'::uuid,'79400000-0000-4000-8000-000000000039'::uuid,'not-mine',
		'Another agent''s task','open')
) as todo(id,staff,key,title,state)
cross join (select (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid as id) as run;

-- The agent's tool call begins and finishes its effect receipt, as the runtime
-- does (a run holds one unresolved receipt at a time). Owner-run helpers, so
-- the broker's session can bracket its own calls with them.
create function pg_temp.ca_receipt(p_n text,p_key text)
returns void language plpgsql security definer as $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.path_binding')::jsonb,
		('79400000-0000-4000-8000-0000000001' || p_n)::uuid,p_key,repeat('a',64),repeat('b',64),false);
end
$$;
create function pg_temp.ca_done(p_n text)
returns void language plpgsql security definer as $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.path_binding')::jsonb,
		('79400000-0000-4000-8000-0000000001' || p_n)::uuid,repeat('a',64),'{}'::jsonb);
end
$$;

-- The broker computes envelope digests itself; the test spells them out.
create function pg_temp.ca_sha(p_envelope text)
returns text language sql security definer as $$
	select encode(extensions.digest(p_envelope::bytea,'sha256'),'hex')
$$;

-- Every broker call answers 'ok:<descriptor>' or '<sqlstate>:<message>'.
create function pg_temp.ca_try(p_sql text)
returns text language plpgsql as $$
declare v_result jsonb;
begin
	execute p_sql into v_result;
	return 'ok:' || v_result::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end
$$;
create function pg_temp.ca_open(p_receipt text,p_login text,p_todo text,
	p_authority text default '79400000-0000-4000-8000-000000000040',p_capability text default repeat('c',64),
	p_site text default 'vercel.com')
returns text language plpgsql as $$
begin
	return pg_temp.ca_try(format('select public.qorpera_open_company_account(%L,%L,'
		'current_setting(''qorpera_test.path_binding'')::jsonb,%L,repeat(''a'',64),repeat(''b'',64),%L,'
		'''{}''::text[],%L,''Hosting for the website'',%L,''company-kek-1'',%L::bytea,%L)',
		p_authority,p_capability,'79400000-0000-4000-8000-0000000001' || p_receipt,p_site,p_login,p_todo,
		'\x0102',pg_temp.ca_sha('\x0102')));
end
$$;
create function pg_temp.ca_call(p_function text,p_receipt text,p_rest text)
returns text language plpgsql as $$
begin
	return pg_temp.ca_try(format('select public.%s(''79400000-0000-4000-8000-000000000040'',repeat(''c'',64),'
		'current_setting(''qorpera_test.path_binding'')::jsonb,%L,repeat(''a'',64),repeat(''b'',64),%s)',
		p_function,'79400000-0000-4000-8000-0000000001' || p_receipt,p_rest));
end
$$;
-- The arguments of a version save: the account, its base version, two-step, the key and an envelope.
create function pg_temp.ca_version_args(p_base text,p_two_step text,p_envelope text)
returns text language sql as $$
	select format('%L,%s,%s,''company-kek-1'',%L::bytea,%L',
		current_setting('qorpera_test.ca_account'),p_base,p_two_step,p_envelope,pg_temp.ca_sha(p_envelope))
$$;
grant execute on function pg_temp.ca_receipt(text,text), pg_temp.ca_done(text), pg_temp.ca_sha(text), pg_temp.ca_try(text),
	pg_temp.ca_open(text,text,text,text,text,text), pg_temp.ca_call(text,text,text),
	pg_temp.ca_version_args(text,text,text) to qorpera_secret_broker;

-- 1. Switched off, and only the broker may call.
select pg_temp.ca_receipt('01','company_account:open:r1');
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.ca_off',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
reset session authorization;
update public.qorpera_company_account_settings set enabled = true;
select set_config('qorpera_test.ca_not_broker',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);

set local session authorization qorpera_secret_broker;
-- 2. Refusals before anything is written.
select set_config('qorpera_test.ca_other_broker',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060','79400000-0000-4000-8000-000000000041',repeat('e',64)),true);
select set_config('qorpera_test.ca_capability',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060','79400000-0000-4000-8000-000000000040',repeat('d',64)),true);
select set_config('qorpera_test.ca_no_todo',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000069'),true);
select set_config('qorpera_test.ca_done_todo',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000061'),true);
select set_config('qorpera_test.ca_other_todo',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000062'),true);
select set_config('qorpera_test.ca_bad_site',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060',p_site => 'Vercel.com'),true);
-- 3. Opened, then a repeat of the same call, a duplicate and a second account on the same website.
select set_config('qorpera_test.ca_opened',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
select set_config('qorpera_test.ca_repeat',pg_temp.ca_open('01','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
select pg_temp.ca_done('01');
-- A finished receipt opens nothing, nor does one begun for another action.
select set_config('qorpera_test.ca_finished',pg_temp.ca_open('01','agents+9@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
select pg_temp.ca_receipt('02','company_account:use:r2');
select set_config('qorpera_test.ca_wrong_action',pg_temp.ca_open('02','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
select pg_temp.ca_done('02');
select pg_temp.ca_receipt('03','company_account:open:r3');
select set_config('qorpera_test.ca_duplicate',pg_temp.ca_open('03','Agents@Nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
select pg_temp.ca_done('03');
select pg_temp.ca_receipt('04','company_account:open:r4');
select set_config('qorpera_test.ca_second',pg_temp.ca_open('04','agents+2@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
select pg_temp.ca_done('04');
reset session authorization;
create function pg_temp.ca_id(p_answer text)
returns text language sql as $$
	select case when p_answer like 'ok:%' then substring(p_answer from 4)::jsonb ->> 'accountId' else '' end
$$;
select set_config('qorpera_test.ca_account',pg_temp.ca_id(current_setting('qorpera_test.ca_opened')),true);
select set_config('qorpera_test.ca_account2',pg_temp.ca_id(current_setting('qorpera_test.ca_second')),true);

do $$
declare v_account uuid; v_secret public.qorpera_cloud_secrets%rowtype; v_row public.qorpera_company_accounts%rowtype;
begin
	if current_setting('qorpera_test.ca_opened') not like 'ok:%' then
		raise exception 'The account did not open: %',current_setting('qorpera_test.ca_opened');
	end if;
	if current_setting('qorpera_test.ca_off') <> '0A000:Company accounts are switched off' then
		raise exception 'A switched-off vault opened an account: %',current_setting('qorpera_test.ca_off');
	end if;
	if current_setting('qorpera_test.ca_not_broker') <> '42501:cloud secret broker authority is required' then
		raise exception 'A caller other than the broker was not refused: %',current_setting('qorpera_test.ca_not_broker');
	end if;
	if current_setting('qorpera_test.ca_other_broker') <> '42501:cloud secret broker does not serve this company' then
		raise exception 'Another company''s broker was not refused: %',current_setting('qorpera_test.ca_other_broker');
	end if;
	if current_setting('qorpera_test.ca_capability') <> '42501:cloud secret broker authority is unavailable' then
		raise exception 'A wrong broker capability was not refused: %',current_setting('qorpera_test.ca_capability');
	end if;
	if current_setting('qorpera_test.ca_wrong_action') <> '42501:company account effect receipt is unavailable'
		or current_setting('qorpera_test.ca_finished') <> '42501:company account effect receipt is unavailable' then
		raise exception 'A receipt for another action, or a finished one, opened an account: % / %',
			current_setting('qorpera_test.ca_wrong_action'),current_setting('qorpera_test.ca_finished');
	end if;
	-- Never unprompted: no todo, a finished one, or another agent's.
	if current_setting('qorpera_test.ca_no_todo') <> '22023:An account is opened only for an open todo of this agent'
		or current_setting('qorpera_test.ca_done_todo') is distinct from current_setting('qorpera_test.ca_no_todo')
		or current_setting('qorpera_test.ca_other_todo') is distinct from current_setting('qorpera_test.ca_no_todo') then
		raise exception 'An account opened without an open todo of the agent: % / % / %',
			current_setting('qorpera_test.ca_no_todo'),current_setting('qorpera_test.ca_done_todo'),
			current_setting('qorpera_test.ca_other_todo');
	end if;
	if current_setting('qorpera_test.ca_bad_site') not like '22023:%' then
		raise exception 'A malformed website was accepted: %',current_setting('qorpera_test.ca_bad_site');
	end if;

	v_account := current_setting('qorpera_test.ca_account')::uuid;
	if (substring(current_setting('qorpera_test.ca_opened') from 4)::jsonb - 'accountId') is distinct from jsonb_build_object(
		'schema','qorpera.company-account/v1','site','vercel.com','signInHosts','[]'::jsonb,
		'login','agents@nordlys.example','twoStep','none','status','pending','version',1) then
		raise exception 'Wrong opened account: %',current_setting('qorpera_test.ca_opened');
	end if;
	if current_setting('qorpera_test.ca_repeat') is distinct from current_setting('qorpera_test.ca_opened') then
		raise exception 'A repeat after a lost answer did not find its account: %',current_setting('qorpera_test.ca_repeat');
	end if;
	if current_setting('qorpera_test.ca_duplicate') <> '23505:The company already has this account; use it' then
		raise exception 'The same login opened twice: %',current_setting('qorpera_test.ca_duplicate');
	end if;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret where secret.id = v_account;
	select account.* into strict v_row from public.qorpera_company_accounts as account where account.secret_id = v_account;
	if v_secret.connector_id <> 'website' or v_secret.owner_kind <> 'company' or v_secret.owner_user_id is not null
		or v_secret.secret_name <> 'vercel-com' or v_secret.current_version <> 1 or v_secret.status <> 'active'
		or v_secret.broker_authority_id <> '79400000-0000-4000-8000-000000000040'
		or v_secret.created_by_user_id <> '29000000-0000-4000-8000-000000000001' then
		raise exception 'Wrong vault secret: %',row_to_json(v_secret);
	end if;
	if v_row.opened_for_todo_id <> '79400000-0000-4000-8000-000000000060'
		or v_row.opened_by_staff_agent_id <> '29000000-0000-4000-8000-000000000030'
		or v_row.opened_receipt_id <> '79400000-0000-4000-8000-000000000101'
		or v_row.opened_by_user_id <> '29000000-0000-4000-8000-000000000001' or v_row.status <> 'pending' then
		raise exception 'Wrong account row: %',row_to_json(v_row);
	end if;
	if (select count(*) from public.qorpera_company_accounts) <> 2
		or (select count(*) from public.qorpera_cloud_secret_versions where secret_id = v_account) <> 1 then
		raise exception 'The repeat or the duplicate wrote rows';
	end if;
	if (select secret_name from public.qorpera_cloud_secrets where id = current_setting('qorpera_test.ca_account2')::uuid)
		<> 'vercel-com-2' then
		raise exception 'A second account on the same website did not get its own vault name';
	end if;
end
$$;

-- 4. Use, a new version, state changes.
set local session authorization qorpera_secret_broker;
select pg_temp.ca_receipt('05','company_account:use:r5');
select set_config('qorpera_test.ca_use',pg_temp.ca_call('qorpera_use_company_account','05',
	quote_literal(current_setting('qorpera_test.ca_account'))),true);
select pg_temp.ca_done('05');
select pg_temp.ca_receipt('06','company_account:version:r6');
select set_config('qorpera_test.ca_version',pg_temp.ca_call('qorpera_add_company_account_version','06',
	pg_temp.ca_version_args('1','''authenticator''','\x0304')),true);
select set_config('qorpera_test.ca_version_repeat',pg_temp.ca_call('qorpera_add_company_account_version','06',
	pg_temp.ca_version_args('1','''authenticator''','\x0304')),true);
select pg_temp.ca_done('06');
select pg_temp.ca_receipt('07','company_account:version:r7');
select set_config('qorpera_test.ca_version_stale',pg_temp.ca_call('qorpera_add_company_account_version','07',
	pg_temp.ca_version_args('1','null','\x0506')),true);
select pg_temp.ca_done('07');
select pg_temp.ca_receipt('08','company_account:state:r8');
select set_config('qorpera_test.ca_connected',pg_temp.ca_call('qorpera_set_company_account_state','08',
	quote_literal(current_setting('qorpera_test.ca_account')) || ',''connected'''),true);
select pg_temp.ca_done('08');
select pg_temp.ca_receipt('09','company_account:state:r9');
select set_config('qorpera_test.ca_closed',pg_temp.ca_call('qorpera_set_company_account_state','09',
	quote_literal(current_setting('qorpera_test.ca_account')) || ',''closed'''),true);
select pg_temp.ca_done('09');
select pg_temp.ca_receipt('10','company_account:use:r10');
select set_config('qorpera_test.ca_use_closed',pg_temp.ca_call('qorpera_use_company_account','10',
	quote_literal(current_setting('qorpera_test.ca_account'))),true);
select pg_temp.ca_done('10');
-- A closed account frees its login: the company may open it again.
select pg_temp.ca_receipt('11','company_account:open:r11');
select set_config('qorpera_test.ca_reopened',pg_temp.ca_open('11','agents@nordlys.example',
	'79400000-0000-4000-8000-000000000060'),true);
select pg_temp.ca_done('11');
reset session authorization;

do $$
declare v_account uuid := current_setting('qorpera_test.ca_account')::uuid; v_use jsonb;
	v_row public.qorpera_company_accounts%rowtype;
begin
	if current_setting('qorpera_test.ca_use') not like 'ok:%' then
		raise exception 'The broker could not use the account: %',current_setting('qorpera_test.ca_use');
	end if;
	v_use := substring(current_setting('qorpera_test.ca_use') from 4)::jsonb;
	if v_use ->> 'encryptedEnvelopeBase64' <> encode('\x0102'::bytea,'base64') or v_use ->> 'keyId' <> 'company-kek-1'
		or (v_use ->> 'version')::bigint <> 1 or v_use ->> 'receiptId' <> '79400000-0000-4000-8000-000000000105' then
		raise exception 'Wrong use answer: %',v_use;
	end if;
	if current_setting('qorpera_test.ca_version') not like 'ok:%'
		or (substring(current_setting('qorpera_test.ca_version') from 4)::jsonb ->> 'version')::bigint <> 2
		or substring(current_setting('qorpera_test.ca_version') from 4)::jsonb ->> 'twoStep' <> 'authenticator' then
		raise exception 'The new version was not saved: %',current_setting('qorpera_test.ca_version');
	end if;
	if current_setting('qorpera_test.ca_version_repeat') is distinct from current_setting('qorpera_test.ca_version') then
		raise exception 'A repeated version save did not find its version: %',current_setting('qorpera_test.ca_version_repeat');
	end if;
	if current_setting('qorpera_test.ca_version_stale') <> '55000:The account changed meanwhile; read it again' then
		raise exception 'A save over a stale version was not refused: %',current_setting('qorpera_test.ca_version_stale');
	end if;
	if (select current_version from public.qorpera_cloud_secrets where id = v_account) <> 2
		or (select count(*) from public.qorpera_cloud_secret_versions where secret_id = v_account) <> 2 then
		raise exception 'Wrong versions after the save';
	end if;
	if current_setting('qorpera_test.ca_connected') not like 'ok:%"status": "connected"%'
		or current_setting('qorpera_test.ca_closed') not like 'ok:%"status": "closed"%' then
		raise exception 'State changes failed: % / %',current_setting('qorpera_test.ca_connected'),
			current_setting('qorpera_test.ca_closed');
	end if;
	select account.* into strict v_row from public.qorpera_company_accounts as account where account.secret_id = v_account;
	if v_row.connected_at is null or v_row.closed_at is null or v_row.last_used_at is null
		or v_row.last_used_by_staff_agent_id <> '29000000-0000-4000-8000-000000000030' then
		raise exception 'Wrong account after use and state changes: %',row_to_json(v_row);
	end if;
	if current_setting('qorpera_test.ca_use_closed') <> '22023:The company has no such open account' then
		raise exception 'A closed account was used: %',current_setting('qorpera_test.ca_use_closed');
	end if;
	if current_setting('qorpera_test.ca_reopened') not like 'ok:%' then
		raise exception 'A closed account''s login could not be opened again: %',current_setting('qorpera_test.ca_reopened');
	end if;
	if (select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events where connector_id = 'website')
		is distinct from array['account_opened','account_opened','account_used','account_version_added',
			'account_state_changed','account_state_changed','account_opened'] then
		raise exception 'Wrong audit: %',(select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
			where connector_id = 'website');
	end if;
end
$$;

-- 5. Members read the facts, never a value; an outsider reads nothing.
create function pg_temp.ca_member(p_user uuid,p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	perform pg_temp.path_claims('authenticated',p_user);
	set local role authenticated;
	v_result := pg_temp.ca_try(p_sql);
	reset role;
	return v_result;
end
$$;
grant execute on function pg_temp.ca_try(text) to authenticated;
select set_config('qorpera_test.ca_list',pg_temp.ca_member('79400000-0000-4000-8000-000000000003',
	'select public.qorpera_list_company_accounts(''29000000-0000-4000-8000-000000000010'',''29000000-0000-4000-8000-000000000020'')'),
	true);
select set_config('qorpera_test.ca_list_outsider',pg_temp.ca_member('79400000-0000-4000-8000-000000000001',
	'select public.qorpera_list_company_accounts(''29000000-0000-4000-8000-000000000010'',''29000000-0000-4000-8000-000000000020'')'),
	true);
-- Removing: a contributor is refused before anything is locked; an admin removes, and a repeat changes nothing.
select set_config('qorpera_test.ca_remove_contributor',pg_temp.ca_member('29000000-0000-4000-8000-000000000002',
	format('select public.qorpera_remove_company_account(''29000000-0000-4000-8000-000000000010'',%L)',
		current_setting('qorpera_test.ca_account2'))),true);
select set_config('qorpera_test.ca_remove',pg_temp.ca_member('79400000-0000-4000-8000-000000000003',
	format('select public.qorpera_remove_company_account(''29000000-0000-4000-8000-000000000010'',%L)',
		current_setting('qorpera_test.ca_account2'))),true);
select set_config('qorpera_test.ca_remove_again',pg_temp.ca_member('79400000-0000-4000-8000-000000000003',
	format('select public.qorpera_remove_company_account(''29000000-0000-4000-8000-000000000010'',%L)',
		current_setting('qorpera_test.ca_account2'))),true);
select set_config('qorpera_test.ca_remove_outsider',pg_temp.ca_member('79400000-0000-4000-8000-000000000001',
	format('select public.qorpera_remove_company_account(''29000000-0000-4000-8000-000000000010'',%L)',
		current_setting('qorpera_test.ca_account'))),true);

do $$
declare v_list jsonb; v_first jsonb; v_account2 uuid := current_setting('qorpera_test.ca_account2')::uuid;
begin
	if current_setting('qorpera_test.ca_list') not like 'ok:%' then
		raise exception 'A member could not read the accounts: %',current_setting('qorpera_test.ca_list');
	end if;
	v_list := substring(current_setting('qorpera_test.ca_list') from 4)::jsonb;
	if jsonb_array_length(v_list) <> 3 or v_list::text ~* 'envelope|keyId|\\x0102|\\x0304' then
		raise exception 'Wrong member list: %',v_list;
	end if;
	select item into v_first from jsonb_array_elements(v_list) as item
	where item ->> 'accountId' = current_setting('qorpera_test.ca_account');
	if v_first ->> 'status' <> 'closed' or v_first ->> 'twoStep' <> 'authenticator'
		or v_first -> 'openedFor' is distinct from jsonb_build_object('todoId','79400000-0000-4000-8000-000000000060',
			'title','Put the website online')
		or v_first -> 'openedBy' is distinct from jsonb_build_object('kind','agent',
			'staffAgentId','29000000-0000-4000-8000-000000000030','name','Agent')
		or v_first #>> '{lastUsedBy,name}' <> 'Agent' or v_first ->> 'purpose' <> 'Hosting for the website' then
		raise exception 'Wrong listed account: %',v_first;
	end if;
	if current_setting('qorpera_test.ca_list_outsider') <> '42501:company accounts are unavailable' then
		raise exception 'An outsider read the accounts: %',current_setting('qorpera_test.ca_list_outsider');
	end if;
	if current_setting('qorpera_test.ca_remove_contributor') <> '42501:company account removal is unavailable'
		or current_setting('qorpera_test.ca_remove_outsider') <> '42501:company account removal is unavailable' then
		raise exception 'A removal without authority was not refused: % / %',
			current_setting('qorpera_test.ca_remove_contributor'),current_setting('qorpera_test.ca_remove_outsider');
	end if;
	if current_setting('qorpera_test.ca_remove') not like 'ok:%"removed": true%'
		or current_setting('qorpera_test.ca_remove_again') is distinct from current_setting('qorpera_test.ca_remove') then
		raise exception 'The admin''s removal failed or was not idempotent: % / %',current_setting('qorpera_test.ca_remove'),
			current_setting('qorpera_test.ca_remove_again');
	end if;
	if exists (select 1 from public.qorpera_cloud_secret_versions where secret_id = v_account2) then
		raise exception 'A removed account kept its envelopes';
	end if;
	if (select status from public.qorpera_cloud_secrets where id = v_account2) <> 'revoked'
		or (select status from public.qorpera_company_accounts where secret_id = v_account2) <> 'closed'
		or (select removed_by_user_id from public.qorpera_company_accounts where secret_id = v_account2)
			<> '79400000-0000-4000-8000-000000000003' then
		raise exception 'The removed account is not closed and revoked';
	end if;
	if (select count(*) from public.qorpera_cloud_secret_audit_events where event_type = 'account_removed'
		and actor_user_id = '79400000-0000-4000-8000-000000000003') <> 1 then
		raise exception 'The removal was not audited once';
	end if;
	-- The other accounts keep their envelopes.
	if not exists (select 1 from public.qorpera_cloud_secret_versions
		where secret_id = current_setting('qorpera_test.ca_account')::uuid) then
		raise exception 'Removing one account wiped another';
	end if;
end
$$;

rollback;
