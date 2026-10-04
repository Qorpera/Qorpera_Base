-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company accounts on the company folder (A1-7, migration 20260930072000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md
-- §6.23). On 924's folder-v2 company, with Alice's leased run (a real claim, runner, assignment and native lease):
-- A. every account function end to end: describe an opening, open (Alice's open todo, the company's live mailbox), find,
--    use, a new version, the states (connected, needs_person, closed), a fill into the company's computer, the members'
--    list, and an owner's removal; the vault marks each account's connection file;
-- B. a company that is not on the company folder is refused by every ported function (0A000), before anything is
--    written: a real snapshot-v1 company with its own broker authority and job;
-- C. a 23505 on either unique index answers the duplicate's refusal. A single session forces the race state with a
--    BEFORE INSERT trigger that writes the conflicting row after the plain check: the login's index, the vault name's,
--    and (a control) the secret's primary key, which stays a broker fault in Postgres' words;
-- D. the bodies: each replaced function names the migration; the core is read before any lock; vault rows come before
--    the receipt; the claim comes before the receipt and the inserts; the removal enters before its vault rows;
-- E. a removal on a paused company is refused, and leaves the account as it was.
-- The races (a held secret, a held claim, a writer's uncommitted row) are 797's, on 648's committed fixture.

-- The company's broker authority, accounts switched on, the mail domain, the company's mailbox 'agents' (written
-- directly, as replica: the mailbox's hook is not this test's), Alice's open todo, and the run's acknowledgement.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('92500000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
update public.qorpera_company_account_settings set enabled = true;
update public.qorpera_mail_settings set domain = 'nordlys.example';
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_mailboxes(hook_id, profile_id, environment_id, local_part)
values ('92500000-0000-4000-8000-000000000090', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'agents');
select set_config('session_replication_role', 'origin', true);
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
	requested_by_user_id, created_by_run_id, updated_by_run_id)
select '92500000-0000-4000-8000-000000000060', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000030', 'site-signup', 'Sign up for hosting', 'open', '92400000-0000-4000-8000-000000000001',
	run.id, run.id
from (select (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid as id) as run;
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'accounts-ack') \g /dev/null

-- The company's computer, generation 1, with Alice's screen lease on it and its current boot's fill key (written directly,
-- as 807 does: the fill only reads them).
select set_config('qorpera_test.acct_fill_key',
	rtrim(translate(encode(extensions.digest('a 925 computer key', 'sha256'), 'base64'), '+/', '-_'), '='), true);
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_runtime_offices(id, profile_id, environment_id, logical_computer_id, client_computer_id,
	image_sha256, bootstrap_sha256, state, generation, max_screens, created_by_user_id)
values ('92500000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92500000-0000-4000-8000-0000000000a2', '92500000-0000-4000-8000-0000000000a3', repeat('a', 64), repeat('b', 64), 'active', 1, 2,
	'92400000-0000-4000-8000-000000000001');
insert into public.qorpera_runtime_office_screens(office_id, id, ordinal, staff_agent_id, generation, epoch, power,
	lease_id, run_id, lease_expires_at, grant_version, native_binding)
select '92500000-0000-4000-8000-0000000000a1', '92500000-0000-4000-8000-0000000000a4', 1, '92400000-0000-4000-8000-000000000030',
	1, 1, 'open', '92500000-0000-4000-8000-0000000000a5', (binding ->> 'runId')::uuid, clock_timestamp() + interval '1 hour', 1, binding
from (select current_setting('qorpera_test.base_binding')::jsonb as binding) as run;
insert into public.qorpera_runtime_office_activations(intent_id, activation_id, office_id, computer_generation,
	allocation_id, provider_id, provider_policy_sha256, provider_binding_sha256, instance_sha256, image_sha256,
	bootstrap_sha256, attestation, mappings, state, service_invocation_id, ready_at, activated_at, fill_public_key)
values ('92500000-0000-4000-8000-0000000000a6', '92500000-0000-4000-8000-0000000000a7', '92500000-0000-4000-8000-0000000000a1', 1,
	'92500000-0000-4000-8000-0000000000a8', '92500000-0000-4000-8000-0000000000a9', repeat('1', 64), repeat('2', 64), repeat('3', 64),
	repeat('a', 64), repeat('b', 64), '{}', '[]', 'active', repeat('a', 32), clock_timestamp(), clock_timestamp(),
	current_setting('qorpera_test.acct_fill_key'));
select set_config('session_replication_role', 'origin', true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.acct_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.acct_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- The runtime begins and finishes the agent's tool call receipt (one unresolved receipt per run), as the database owner.
create function pg_temp.acct_begin(p_n text, p_key text, p_input text default repeat('a', 64)) returns void
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('92500000-0000-4000-8000-0000000001' || p_n)::uuid, p_key, p_input, repeat('b', 64), false);
end $$;
create function pg_temp.acct_end(p_n text, p_input text default repeat('a', 64)) returns void
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('92500000-0000-4000-8000-0000000001' || p_n)::uuid, p_input, '{}'::jsonb);
end $$;
-- A broker call: the function, the receipt's number and the arguments after the six shared ones; another binding or
-- authority for B.
create function pg_temp.acct_call(p_function text, p_n text, p_rest text default null, p_binding text default null,
	p_authority text default '92500000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language plpgsql as $$
begin
	return pg_temp.acct_try(format('select public.%s(%L, %L, %L::jsonb, %L, repeat(''a'', 64), repeat(''b'', 64)%s)',
		p_function, p_authority, p_capability, coalesce(p_binding, current_setting('qorpera_test.base_binding')),
		'92500000-0000-4000-8000-0000000001' || p_n, coalesce(', ' || p_rest, '')));
end $$;
-- An opening's own arguments: the id the broker chose, the run's company and environment, the website, the login,
-- Alice's todo, the key and a dummy envelope. The digest helpers run as the owner (the broker reads no extension).
create function pg_temp.acct_open_args(p_secret text, p_site text, p_login text,
	p_company text default '92400000-0000-4000-8000-000000000010', p_environment text default '92400000-0000-4000-8000-000000000020')
returns text language sql security definer as $$
	select format('%L, %L, %L, %L, ''{}''::text[], %L, ''Hosting'', %L, ''company-kek-1'', ''\x0102''::bytea, %L',
		'92500000-0000-4000-8000-0000000002' || p_secret, p_company, p_environment, p_site, p_login,
		'92500000-0000-4000-8000-000000000060', encode(extensions.digest('\x0102'::bytea, 'sha256'), 'hex'))
$$;
-- A version save's own arguments: the account, its base version, two-step, the key and an envelope.
create function pg_temp.acct_version_args(p_account text, p_base integer, p_envelope text) returns text language sql security definer as $$
	select format('%L, %s, ''authenticator'', ''company-kek-1'', %L::bytea, %L', p_account, p_base, p_envelope,
		encode(extensions.digest(p_envelope::bytea, 'sha256'), 'hex'))
$$;
-- One vault_fill call's operation envelope, as the computer tool writes it, and its digest.
create function pg_temp.acct_fill_envelope(p_key text, p_account text) returns text language sql as $$
	select jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2', 'principals', '{}'::jsonb,
		'operation', jsonb_build_object('tool', 'computer_browser', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('kind', 'browser', 'action', 'vault_fill', 'role', 'textbox', 'name', 'Password',
				'field', 'password', 'account', p_account),
			'target', jsonb_build_object('realm', 'company_computer', 'resources', '{}'::jsonb,
				'binding', jsonb_build_object('companyId', '92400000-0000-4000-8000-000000000010',
					'environmentId', '92400000-0000-4000-8000-000000000020',
					'companyComputerId', '92500000-0000-4000-8000-0000000000a1',
					'logicalComputerId', '92500000-0000-4000-8000-0000000000a2', 'computerGeneration', 1,
					'screenId', '92500000-0000-4000-8000-0000000000a4', 'screenOrdinal', 1, 'screenGeneration', 1,
					'staffAgentId', '92400000-0000-4000-8000-000000000030'))))::text
$$;
create function pg_temp.acct_sha(p_text text) returns text language sql security definer as $$
	select encode(extensions.digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex')
$$;
create function pg_temp.acct_fill(p_n text, p_envelope text, p_binding text default null,
	p_authority text default '92500000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language plpgsql as $$
begin
	return pg_temp.acct_try(format('select public.qorpera_fill_company_account(%L, %L, %L::jsonb, %L, %L, repeat(''b'', 64))',
		p_authority, p_capability, coalesce(p_binding, current_setting('qorpera_test.base_binding')),
		'92500000-0000-4000-8000-0000000001' || p_n, p_envelope));
end $$;
-- The native host's read (service role, the run's binding), and a member's call (PostgREST's role and claims).
create function pg_temp.acct_find(p_request jsonb, p_binding text default null) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.acct_try(format('select public.qorpera_find_company_accounts(%L::jsonb, %L::jsonb)',
		coalesce(p_binding, current_setting('qorpera_test.base_binding')), p_request));
	reset role;
	return v;
end $$;
create function pg_temp.acct_member(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.acct_try(p_sql);
	reset role;
	return v;
end $$;
grant execute on function pg_temp.acct_try(text), pg_temp.acct_answer(text), pg_temp.acct_begin(text,text,text),
	pg_temp.acct_end(text,text), pg_temp.acct_call(text,text,text,text,text,text), pg_temp.acct_open_args(text,text,text,text,text),
	pg_temp.acct_version_args(text,integer,text), pg_temp.acct_fill_envelope(text,text), pg_temp.acct_sha(text),
	pg_temp.acct_fill(text,text,text,text,text) to qorpera_secret_broker;
grant execute on function pg_temp.acct_try(text) to authenticated, service_role;

-- A. Every function, end to end, on the company folder ---------------------------------------------------------------------

set local session authorization qorpera_secret_broker;
select pg_temp.acct_begin('01', 'company_account:open:a1');
select set_config('qorpera_test.a_describe', pg_temp.acct_call('qorpera_describe_company_account_open', '01'), true);
select set_config('qorpera_test.a_open', pg_temp.acct_call('qorpera_open_company_account', '01',
	pg_temp.acct_open_args('01', 'vercel.com', 'agents+vercel.com@nordlys.example')), true);
select pg_temp.acct_end('01');
select set_config('qorpera_test.a_account', pg_temp.acct_answer(current_setting('qorpera_test.a_open')) ->> 'accountId', true);
select pg_temp.acct_begin('02', 'company_account:use:' || current_setting('qorpera_test.a_account') || ':a2');
select set_config('qorpera_test.a_use', pg_temp.acct_call('qorpera_use_company_account', '02',
	quote_literal(current_setting('qorpera_test.a_account'))), true);
select pg_temp.acct_end('02');
select pg_temp.acct_begin('03', 'company_account:version:' || current_setting('qorpera_test.a_account') || ':a3');
select set_config('qorpera_test.a_version', pg_temp.acct_call('qorpera_add_company_account_version', '03',
	pg_temp.acct_version_args(current_setting('qorpera_test.a_account'), 1, '\x0304')), true);
select pg_temp.acct_end('03');
select pg_temp.acct_begin('04', 'company_account:state:' || current_setting('qorpera_test.a_account') || ':a4');
select set_config('qorpera_test.a_connected', pg_temp.acct_call('qorpera_set_company_account_state', '04',
	quote_literal(current_setting('qorpera_test.a_account')) || ', ''connected'''), true);
select pg_temp.acct_end('04');
select pg_temp.acct_begin('05', 'company_account:state:' || current_setting('qorpera_test.a_account') || ':a5');
select set_config('qorpera_test.a_needs_person', pg_temp.acct_call('qorpera_set_company_account_state', '05',
	quote_literal(current_setting('qorpera_test.a_account')) || ', ''needs_person'''), true);
select pg_temp.acct_end('05');
select set_config('qorpera_test.a_fill_envelope', pg_temp.acct_fill_envelope('a6', current_setting('qorpera_test.a_account')), true);
select pg_temp.acct_begin('06', 'computer_browser:a6', pg_temp.acct_sha(current_setting('qorpera_test.a_fill_envelope')));
select set_config('qorpera_test.a_fill', pg_temp.acct_fill('06', current_setting('qorpera_test.a_fill_envelope')), true);
select pg_temp.acct_end('06', pg_temp.acct_sha(current_setting('qorpera_test.a_fill_envelope')));
-- A second account, which an owner removes below.
select pg_temp.acct_begin('07', 'company_account:open:a7');
select set_config('qorpera_test.a_open2', pg_temp.acct_call('qorpera_open_company_account', '07',
	pg_temp.acct_open_args('07', 'netlify.com', 'agents+netlify.com@nordlys.example')), true);
select pg_temp.acct_end('07');
reset session authorization;
select set_config('qorpera_test.a_find', pg_temp.acct_find('{"todo": "site-signup", "site": "vercel.com"}'), true);
select set_config('qorpera_test.a_list', pg_temp.acct_member('92400000-0000-4000-8000-000000000003',
	'select public.qorpera_list_company_accounts(''92400000-0000-4000-8000-000000000010'', ''92400000-0000-4000-8000-000000000020'')'),
	true);
set local session authorization qorpera_secret_broker;
select pg_temp.acct_begin('08', 'company_account:state:' || current_setting('qorpera_test.a_account') || ':a8');
select set_config('qorpera_test.a_closed', pg_temp.acct_call('qorpera_set_company_account_state', '08',
	quote_literal(current_setting('qorpera_test.a_account')) || ', ''closed'''), true);
-- A repeated close answers the closed account (no vault row is locked for it), but only for its executing receipt.
select set_config('qorpera_test.a_close_repeat', pg_temp.acct_call('qorpera_set_company_account_state', '08',
	quote_literal(current_setting('qorpera_test.a_account')) || ', ''closed'''), true);
select pg_temp.acct_end('08');
select set_config('qorpera_test.a_close_finished', pg_temp.acct_call('qorpera_set_company_account_state', '08',
	quote_literal(current_setting('qorpera_test.a_account')) || ', ''closed'''), true);
reset session authorization;
select set_config('qorpera_test.a_remove', pg_temp.acct_member('92400000-0000-4000-8000-000000000001',
	format('select public.qorpera_remove_company_account(''92400000-0000-4000-8000-000000000010'', %L)',
		pg_temp.acct_answer(current_setting('qorpera_test.a_open2')) ->> 'accountId')), true);

do $$
declare
	v_account uuid := current_setting('qorpera_test.a_account')::uuid;
	v_account2 uuid := pg_temp.acct_answer(current_setting('qorpera_test.a_open2')) ->> 'accountId';
	v_find jsonb := pg_temp.acct_answer(current_setting('qorpera_test.a_find'));
	v_fill jsonb := pg_temp.acct_answer(current_setting('qorpera_test.a_fill'));
	v_listed jsonb;
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.a_describe') = 'ok:' || jsonb_build_object(
		'schema', 'qorpera.company-account-context/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', '92400000-0000-4000-8000-000000000020', 'keyId', 'company-kek-1')::text,
		'A: the opening''s context: ' || current_setting('qorpera_test.a_describe'));
	perform pg_temp.base_assert(v_account = '92500000-0000-4000-8000-000000000201'
		and pg_temp.acct_answer(current_setting('qorpera_test.a_open')) - 'accountId' = jsonb_build_object(
			'schema', 'qorpera.company-account/v1', 'site', 'vercel.com', 'signInHosts', '[]'::jsonb,
			'login', 'agents+vercel.com@nordlys.example', 'twoStep', 'none', 'status', 'pending', 'version', 1),
		'A: the opening: ' || current_setting('qorpera_test.a_open'));
	perform pg_temp.base_assert(v_find -> 'todo' = jsonb_build_object('key', 'site-signup', 'id', '92500000-0000-4000-8000-000000000060')
		and v_find -> 'mailboxes' = '["agents@nordlys.example"]'::jsonb
		and jsonb_array_length(v_find -> 'accounts') = 1 and v_find #>> '{accounts,0,accountId}' = v_account::text
		and v_find #>> '{accounts,0,status}' = 'needs_person' and (v_find #>> '{accounts,0,openedByYou}')::boolean,
		'A: the agent''s read: ' || current_setting('qorpera_test.a_find'));
	perform pg_temp.base_assert(pg_temp.acct_answer(current_setting('qorpera_test.a_use')) ->> 'encryptedEnvelopeBase64'
			= encode('\x0102'::bytea, 'base64')
		and pg_temp.acct_answer(current_setting('qorpera_test.a_use')) ->> 'receiptId' = '92500000-0000-4000-8000-000000000102',
		'A: the use: ' || current_setting('qorpera_test.a_use'));
	perform pg_temp.base_assert(pg_temp.acct_answer(current_setting('qorpera_test.a_version')) ->> 'version' = '2'
		and pg_temp.acct_answer(current_setting('qorpera_test.a_version')) ->> 'twoStep' = 'authenticator',
		'A: the new version: ' || current_setting('qorpera_test.a_version'));
	perform pg_temp.base_assert(pg_temp.acct_answer(current_setting('qorpera_test.a_connected')) ->> 'status' = 'connected'
		and pg_temp.acct_answer(current_setting('qorpera_test.a_needs_person')) ->> 'status' = 'needs_person'
		and pg_temp.acct_answer(current_setting('qorpera_test.a_closed')) ->> 'status' = 'closed',
		'A: the states: ' || current_setting('qorpera_test.a_connected') || ' / ' || current_setting('qorpera_test.a_needs_person')
			|| ' / ' || current_setting('qorpera_test.a_closed'));
	perform pg_temp.base_assert(current_setting('qorpera_test.a_close_repeat') = current_setting('qorpera_test.a_closed')
		and current_setting('qorpera_test.a_close_finished') = '42501:company account effect receipt is unavailable',
		'A: a repeated close: ' || current_setting('qorpera_test.a_close_repeat') || ' / '
			|| current_setting('qorpera_test.a_close_finished'));
	perform pg_temp.base_assert(v_fill ->> 'schema' = 'qorpera.company-account-fill-context/v1' and v_fill ->> 'version' = '2'
		and v_fill ->> 'encryptedEnvelopeBase64' = encode('\x0304'::bytea, 'base64') and v_fill ->> 'field' = 'password'
		and v_fill ->> 'fillPublicKey' = current_setting('qorpera_test.acct_fill_key')
		and v_fill ->> 'receiptId' = '92500000-0000-4000-8000-000000000106',
		'A: the fill: ' || current_setting('qorpera_test.a_fill'));
	-- The viewer reads the facts, never a value.
	select item into v_listed from jsonb_array_elements(pg_temp.acct_answer(current_setting('qorpera_test.a_list'))) as item
	where item ->> 'accountId' = v_account::text;
	perform pg_temp.base_assert(v_listed ->> 'status' = 'needs_person' and v_listed #>> '{openedBy,name}' = 'Alice'
		and v_listed #>> '{lastUsedBy,name}' = 'Alice' and current_setting('qorpera_test.a_list') !~* 'envelope|keyId',
		'A: the members'' list: ' || current_setting('qorpera_test.a_list'));
	-- Closing revoked the vault row at once (the trigger wiped both versions); removing revoked the second account's.
	perform pg_temp.base_assert((select status from public.qorpera_cloud_secrets where id = v_account) = 'revoked'
		and not exists (select 1 from public.qorpera_cloud_secret_versions where secret_id = v_account)
		and (select status from public.qorpera_company_accounts where secret_id = v_account) = 'closed',
		'A: the close revokes and wipes');
	perform pg_temp.base_assert(current_setting('qorpera_test.a_remove') like 'ok:%"removed": true%'
		and (select status from public.qorpera_cloud_secrets where id = v_account2) = 'revoked'
		and not exists (select 1 from public.qorpera_cloud_secret_versions where secret_id = v_account2)
		and (select removed_by_user_id from public.qorpera_company_accounts where secret_id = v_account2)
			= '92400000-0000-4000-8000-000000000001',
		'A: the removal: ' || current_setting('qorpera_test.a_remove'));
	perform pg_temp.base_assert((select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
			where secret_id in (v_account, v_account2))
		= array['account_opened', 'account_used', 'account_version_added', 'account_state_changed', 'account_state_changed',
			'account_used', 'account_opened', 'account_state_changed', 'account_removed'],
		'A: the audit: ' || (select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
			where secret_id in (v_account, v_account2))::text);
	-- On the company folder each change marks the account's connection file due, for the platform's writer (P22).
	perform pg_temp.base_assert((select count(distinct secret_id) from public.qorpera_folder_connection_file_marks
		where secret_id in (v_account, v_account2) and profile_id = '92400000-0000-4000-8000-000000000010') = 2,
		'A: the connection files are marked');
end $$;

-- B. A company that is not on the company folder is refused by every ported function --------------------------------------

-- A snapshot-v1 company (as every company inserted without the folder is) with its owner, environment, broker authority,
-- a job of its own, and a website account.
insert into auth.users(id, email) values ('92500000-0000-4000-8000-000000000001', 'accounts-old-core@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('92500000-0000-4000-8000-000000000010', 'Old core', '92500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('92500000-0000-4000-8000-000000000010', '92500000-0000-4000-8000-000000000001', 'accounts-old-core@example.test', 'Owner',
	'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('92500000-0000-4000-8000-000000000020', '92500000-0000-4000-8000-000000000010', 'Environment', 1,
	'92500000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('92500000-0000-4000-8000-000000000041', '92500000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'old-kek-1', repeat('8', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
	secret_name, purpose, current_version, created_by_user_id)
values ('92500000-0000-4000-8000-000000000070', '92500000-0000-4000-8000-000000000010', '92500000-0000-4000-8000-000000000020',
	'92500000-0000-4000-8000-000000000041', 'company', 'website', 'vercel-com', 'Hosting', 1, '92500000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
	envelope_sha256, created_by_user_id)
values ('92500000-0000-4000-8000-000000000070', 1, '92500000-0000-4000-8000-000000000041', 'old-kek-1', '\x0102'::bytea,
	encode(extensions.digest('\x0102'::bytea, 'sha256'), 'hex'), '92500000-0000-4000-8000-000000000001');
insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, opened_by_user_id)
values ('92500000-0000-4000-8000-000000000070', '92500000-0000-4000-8000-000000000010', '92500000-0000-4000-8000-000000000020',
	'vercel.com', 'team@old.example', '92500000-0000-4000-8000-000000000001');
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
	job_type, payload, created_by_user_id, status)
values ('92500000-0000-4000-8000-0000000000e2', '92500000-0000-4000-8000-000000000010', '92500000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '92500000-0000-4000-8000-000000000001',
	'queued');
select set_config('session_replication_role', 'origin', true);
-- Its run's binding: the job is the old company's, every other id as Alice's.
select set_config('qorpera_test.b_binding', jsonb_set(current_setting('qorpera_test.base_binding')::jsonb, '{jobId}',
	'"92500000-0000-4000-8000-0000000000e2"')::text, true);
select set_config('qorpera_test.b_before', jsonb_build_object(
	'secrets', (select count(*) from public.qorpera_cloud_secrets), 'versions', (select count(*) from public.qorpera_cloud_secret_versions),
	'accounts', (select count(*) from public.qorpera_company_accounts), 'events', (select count(*) from public.qorpera_cloud_secret_audit_events),
	'used', (select last_used_at from public.qorpera_company_accounts where secret_id = '92500000-0000-4000-8000-000000000070'))::text,
	true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.b_' || name, pg_temp.acct_call(fn, '90', rest, current_setting('qorpera_test.b_binding'),
	'92500000-0000-4000-8000-000000000041', repeat('8', 64)), true)
from (values
	('describe', 'qorpera_describe_company_account_open', null),
	('open', 'qorpera_open_company_account', pg_temp.acct_open_args('90', 'vercel.com', 'agents+old@nordlys.example',
		'92500000-0000-4000-8000-000000000010', '92500000-0000-4000-8000-000000000020')),
	('use', 'qorpera_use_company_account', quote_literal('92500000-0000-4000-8000-000000000070')),
	('version', 'qorpera_add_company_account_version', pg_temp.acct_version_args('92500000-0000-4000-8000-000000000070', 1, '\x0304')),
	('state', 'qorpera_set_company_account_state', quote_literal('92500000-0000-4000-8000-000000000070') || ', ''closed''')
) as call(name, fn, rest);
select set_config('qorpera_test.b_fill', pg_temp.acct_fill('90', pg_temp.acct_fill_envelope('b9', '92500000-0000-4000-8000-000000000070'),
	current_setting('qorpera_test.b_binding'), '92500000-0000-4000-8000-000000000041', repeat('8', 64)), true);
reset session authorization;
select set_config('qorpera_test.b_find', pg_temp.acct_find('{}', current_setting('qorpera_test.b_binding')), true);
select set_config('qorpera_test.b_remove', pg_temp.acct_member('92500000-0000-4000-8000-000000000001',
	'select public.qorpera_remove_company_account(''92500000-0000-4000-8000-000000000010'', ''92500000-0000-4000-8000-000000000070'')'),
	true);
do $$
declare v_name text; v_before jsonb := current_setting('qorpera_test.b_before')::jsonb;
begin
	perform pg_temp.base_assert(not public.qorpera_company_is_folder_v2('92500000-0000-4000-8000-000000000010')
		and exists (select 1 from public.qorpera_company_files where environment_id = '92500000-0000-4000-8000-000000000020'),
		'B: the old company is on the old core, with its Company File row');
	foreach v_name in array array['describe', 'open', 'use', 'version', 'state', 'fill', 'remove'] loop
		perform pg_temp.base_assert(current_setting('qorpera_test.b_' || v_name) = '0A000:Accounts need a company on the company folder',
			format('B: %s on the old core: %s', v_name, current_setting('qorpera_test.b_' || v_name)));
	end loop;
	perform pg_temp.base_assert(current_setting('qorpera_test.b_find') = 'ok:' || jsonb_build_object('schema', 'qorpera.agent-company-accounts/v1',
		'refused', jsonb_build_object('code', '0A000', 'message', 'Accounts need a company on the company folder'))::text,
		'B: find on the old core: ' || current_setting('qorpera_test.b_find'));
	-- Nothing was written: no secret, version, account or event, and the old company's account is as it was.
	perform pg_temp.base_assert(jsonb_build_object(
		'secrets', (select count(*) from public.qorpera_cloud_secrets), 'versions', (select count(*) from public.qorpera_cloud_secret_versions),
		'accounts', (select count(*) from public.qorpera_company_accounts), 'events', (select count(*) from public.qorpera_cloud_secret_audit_events),
		'used', (select last_used_at from public.qorpera_company_accounts where secret_id = '92500000-0000-4000-8000-000000000070'))
			= v_before
		and (select status from public.qorpera_cloud_secrets where id = '92500000-0000-4000-8000-000000000070') = 'active',
		'B: a refused call wrote something');
end $$;

-- C. A 23505 on either unique index answers the duplicate's refusal -------------------------------------------------------

-- Each trigger writes the conflicting row inside the opening's own insert, after its plain checks read: the race state a
-- writer without the company's claim would leave. Created inside this rolled-back transaction.
-- (One function per table: a trigger function reads only its own table's fields.)
create function public.qorpera_test_925_login_conflict() returns trigger language plpgsql as $$
begin
	if new.login = 'agents+race.example@nordlys.example' and new.secret_id <> '92500000-0000-4000-8000-000000000081' then
		insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
			secret_name, purpose, current_version, created_by_user_id)
		values ('92500000-0000-4000-8000-000000000081', new.profile_id, new.environment_id, '92500000-0000-4000-8000-000000000040',
			'company', 'website', 'held-race', 'Held', 1, '92400000-0000-4000-8000-000000000001');
		insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, opened_by_user_id)
		values ('92500000-0000-4000-8000-000000000081', new.profile_id, new.environment_id, new.site, new.login,
			'92400000-0000-4000-8000-000000000001');
	end if;
	return new;
end $$;
create function public.qorpera_test_925_secret_conflict() returns trigger language plpgsql as $$
begin
	if new.secret_name in ('name-race-example', 'id-race-example')
		and new.id not in ('92500000-0000-4000-8000-000000000082', '92500000-0000-4000-8000-000000000083') then
		insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
			secret_name, purpose, current_version, created_by_user_id)
		values (case when new.secret_name = 'name-race-example' then '92500000-0000-4000-8000-000000000082' else new.id end,
			new.profile_id, new.environment_id, '92500000-0000-4000-8000-000000000040', 'company', 'website',
			case when new.secret_name = 'name-race-example' then new.secret_name else 'id-race-held' end, 'Held', 1,
			'92400000-0000-4000-8000-000000000001');
	end if;
	return new;
end $$;
create trigger qorpera_test_925_conflict before insert on public.qorpera_company_accounts
	for each row execute function public.qorpera_test_925_login_conflict();
create trigger qorpera_test_925_conflict before insert on public.qorpera_cloud_secrets
	for each row execute function public.qorpera_test_925_secret_conflict();
set local session authorization qorpera_secret_broker;
select pg_temp.acct_begin('11', 'company_account:open:c1');
select set_config('qorpera_test.c_login', pg_temp.acct_call('qorpera_open_company_account', '11',
	pg_temp.acct_open_args('11', 'race.example', 'agents+race.example@nordlys.example')), true);
select set_config('qorpera_test.c_name', pg_temp.acct_call('qorpera_open_company_account', '11',
	pg_temp.acct_open_args('12', 'name-race.example', 'agents+name-race.example@nordlys.example')), true);
select set_config('qorpera_test.c_id', pg_temp.acct_call('qorpera_open_company_account', '11',
	pg_temp.acct_open_args('13', 'id-race.example', 'agents+id-race.example@nordlys.example')), true);
select pg_temp.acct_end('11');
reset session authorization;
drop trigger qorpera_test_925_conflict on public.qorpera_company_accounts;
drop trigger qorpera_test_925_conflict on public.qorpera_cloud_secrets;
drop function public.qorpera_test_925_login_conflict(), public.qorpera_test_925_secret_conflict();
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.c_login') = '23505:The company already has this account; use it',
		'C: the login''s index: ' || current_setting('qorpera_test.c_login'));
	perform pg_temp.base_assert(current_setting('qorpera_test.c_name') = '23505:The company already has this account; use it',
		'C: the vault name''s index: ' || current_setting('qorpera_test.c_name'));
	-- Any other conflict stays the broker's fault, in Postgres' words (the id is the broker's choice).
	perform pg_temp.base_assert(current_setting('qorpera_test.c_id') like '23505:duplicate key value violates unique constraint "qorpera_cloud_secrets_pkey"%',
		'C: another conflict: ' || current_setting('qorpera_test.c_id'));
	-- Each refused opening left nothing, the trigger's rows included (the opening's inserts went back together).
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_cloud_secrets where id in ('92500000-0000-4000-8000-000000000211',
			'92500000-0000-4000-8000-000000000212', '92500000-0000-4000-8000-000000000213', '92500000-0000-4000-8000-000000000081',
			'92500000-0000-4000-8000-000000000082'))
		and not exists (select 1 from public.qorpera_company_accounts where site in ('race.example', 'name-race.example', 'id-race.example')),
		'C: a refused opening left rows');
end $$;

-- D. The bodies --------------------------------------------------------------------------------------------------------

-- Each function's text without comments, so a comment never counts as code.
create temporary table acct_code on commit drop as
select p.proname::text as name, regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'gs'), '--[^\n]*', '', 'g') as src
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('qorpera_company_account_call',
	'qorpera_company_account_receipt', 'qorpera_open_company_account', 'qorpera_describe_company_account_open',
	'qorpera_use_company_account', 'qorpera_add_company_account_version', 'qorpera_set_company_account_state',
	'qorpera_fill_company_account', 'qorpera_find_company_accounts', 'qorpera_remove_company_account');
-- Where a text first (or last) appears in a function's code; null when it does not.
create function pg_temp.code_at(p_name text, p_text text) returns integer language sql as $$
	select nullif(position(lower(p_text) in lower(src)), 0) from acct_code where name = p_name
$$;
create function pg_temp.code_last_at(p_name text, p_text text) returns integer language sql as $$
	select length(src) - position(reverse(lower(p_text)) in reverse(lower(src))) - length(p_text) + 2
	from acct_code where name = p_name and position(lower(p_text) in lower(src)) > 0
$$;
-- Every occurrence of a text in a function's code.
create function pg_temp.code_all_at(p_name text, p_text text) returns integer[] language sql as $$
	select coalesce(array_agg(n order by n), '{}') from acct_code, generate_series(1, length(src)) n
	where name = p_name and lower(substr(src, n, length(p_text))) = lower(p_text)
$$;
-- The first row lock or advisory lock of a function's own code.
create function pg_temp.first_lock(p_name text) returns integer language sql as $$
	select min(nullif(position(m[1] in src), 0)) from acct_code, regexp_matches(src,
		'(\mfor\s+(?:update|share|no\s+key\s+update|key\s+share)\M|pg_advisory|qorpera_native_tool_locked_run\(|qorpera_folder_company_enter\(|qorpera_company_account_locked\(|qorpera_company_account_receipt\()', 'gi') m
	where name = p_name
$$;
do $$
declare v_name text; v_at integer;
begin
	-- Exactly the replaced functions and the new receipt helper name the migration.
	perform pg_temp.base_assert((select array_agg(proname::text order by proname) from pg_proc
		where pronamespace = 'public'::regnamespace and prosrc ~ '20260930072000') = array['qorpera_add_company_account_version',
			'qorpera_company_account_call', 'qorpera_company_account_receipt', 'qorpera_describe_company_account_open',
			'qorpera_fill_company_account', 'qorpera_find_company_accounts', 'qorpera_open_company_account',
			'qorpera_remove_company_account', 'qorpera_set_company_account_state', 'qorpera_use_company_account'],
		'D: the functions naming 20260930072000: ' || (select array_agg(proname::text order by proname) from pg_proc
			where pronamespace = 'public'::regnamespace and prosrc ~ '20260930072000')::text);
	-- The core is read before any lock: through the run's job (the call, the fill, find) or the account's environment (the
	-- removal); the other broker calls make the call first. No function names the old core's gc fence.
	foreach v_name in array array['qorpera_company_account_call', 'qorpera_fill_company_account', 'qorpera_find_company_accounts'] loop
		perform pg_temp.base_assert(pg_temp.code_at(v_name, 'if not public.qorpera_binding_is_folder_v2(p_binding) then') < pg_temp.first_lock(v_name),
			'D: ' || v_name || ' reads the core before any lock');
	end loop;
	perform pg_temp.base_assert(pg_temp.code_at('qorpera_remove_company_account', 'if not public.qorpera_environment_is_folder_v2(')
		< pg_temp.first_lock('qorpera_remove_company_account'), 'D: the removal reads the core before any lock');
	foreach v_name in array array['qorpera_open_company_account', 'qorpera_describe_company_account_open', 'qorpera_use_company_account',
		'qorpera_add_company_account_version', 'qorpera_set_company_account_state'] loop
		perform pg_temp.base_assert(pg_temp.code_at(v_name, 'public.qorpera_company_account_call(') < coalesce(pg_temp.first_lock(v_name), 1000000)
			and (select count(*) from acct_code where name = v_name and src ~* 'for\s+(update|share|no\s+key\s+update|key\s+share)') = 0,
			'D: ' || v_name || ' makes the call first and locks only through the helpers');
	end loop;
	perform pg_temp.base_assert(not exists (select 1 from acct_code where src ~* 'qorpera_lock_profile_gc_fence|qorpera_profiles'),
		'D: an account function names the gc fence or the company row');
	-- The call reads no receipt; the receipt helper locks it.
	perform pg_temp.base_assert(pg_temp.code_at('qorpera_company_account_call', 'qorpera_run_operation_receipts') is null
		and pg_temp.code_at('qorpera_company_account_receipt', 'qorpera_run_operation_receipts') < pg_temp.code_at('qorpera_company_account_receipt', 'for update'),
		'D: the receipt is the helper''s, not the call''s');
	-- Vault rows (the secret, then the account: qorpera_company_account_locked) before the receipt. An early answer that
	-- checks the receipt before them (a close of a closed account) returns before the vault rows.
	foreach v_name in array array['qorpera_use_company_account', 'qorpera_add_company_account_version', 'qorpera_set_company_account_state'] loop
		v_at := pg_temp.code_at(v_name, 'public.qorpera_company_account_locked(');
		perform pg_temp.base_assert(v_at < pg_temp.code_last_at(v_name, 'public.qorpera_company_account_receipt('),
			'D: ' || v_name || ' locks the vault rows before the receipt');
		perform pg_temp.base_assert(not exists (select 1 from unnest(pg_temp.code_all_at(v_name, 'public.qorpera_company_account_receipt(')) r
			where r < v_at and position('return ' in lower(substr((select src from acct_code where name = v_name), r, v_at - r))) = 0),
			'D: ' || v_name || ' checks a receipt before the vault rows without returning');
	end loop;
	perform pg_temp.base_assert(cardinality(pg_temp.code_all_at('qorpera_use_company_account', 'public.qorpera_company_account_receipt(')) = 1
		and cardinality(pg_temp.code_all_at('qorpera_add_company_account_version', 'public.qorpera_company_account_receipt(')) = 1
		and cardinality(pg_temp.code_all_at('qorpera_set_company_account_state', 'public.qorpera_company_account_receipt(')) = 2,
		'D: the receipt calls');
	perform pg_temp.base_assert(pg_temp.code_at('qorpera_fill_company_account', 'public.qorpera_runtime_offices')
			< pg_temp.code_at('qorpera_fill_company_account', 'public.qorpera_company_account_locked(')
		and pg_temp.code_at('qorpera_fill_company_account', 'public.qorpera_company_account_locked(')
			< pg_temp.code_at('qorpera_fill_company_account', 'from public.qorpera_run_operation_receipts')
		and (select count(*) from acct_code where name = 'qorpera_fill_company_account'
			and src ~* 'qorpera_run_operation_receipts\M[^;]*\mfor\s+update') = 1,
		'D: the fill reads the computer, locks the account''s rows, then its receipt');
	perform pg_temp.base_assert(pg_temp.code_at('qorpera_describe_company_account_open', 'public.qorpera_company_account_call(')
			< pg_temp.code_at('qorpera_describe_company_account_open', 'public.qorpera_company_account_receipt(')
		and pg_temp.code_at('qorpera_describe_company_account_open', 'qorpera_company_account_locked') is null,
		'D: describing an opening: the call, then the receipt, no vault row');
	-- The opening: the call, the company's claim (rank 9, E1's key shape in its own namespace), every receipt after it, and
	-- the inserts after every receipt.
	perform pg_temp.base_assert(pg_temp.code_at('qorpera_open_company_account', 'public.qorpera_company_account_call(')
			< pg_temp.code_at('qorpera_open_company_account', 'perform pg_advisory_xact_lock(hashtextextended(''qorpera.company-accounts:'' || v_call.profile_id::text, 0));')
		and pg_temp.code_at('qorpera_open_company_account', 'pg_advisory_xact_lock(')
			< (select min(r) from unnest(pg_temp.code_all_at('qorpera_open_company_account', 'public.qorpera_company_account_receipt(')) r)
		and pg_temp.code_last_at('qorpera_open_company_account', 'public.qorpera_company_account_receipt(')
			< pg_temp.code_at('qorpera_open_company_account', 'insert into public.qorpera_cloud_secrets')
		and pg_temp.code_at('qorpera_open_company_account', 'from public.qorpera_company_accounts as account')
			> pg_temp.code_at('qorpera_open_company_account', 'pg_advisory_xact_lock(')
		and cardinality(pg_temp.code_all_at('qorpera_open_company_account', 'pg_advisory')) = 1,
		'D: the opening takes the claim, then the receipt, then inserts');
	-- The removal: the company entered (the pause refused), then the secret, then the account.
	perform pg_temp.base_assert(pg_temp.code_at('qorpera_remove_company_account', 'public.qorpera_folder_company_enter(')
			< pg_temp.code_at('qorpera_remove_company_account', 'from public.qorpera_cloud_secrets as secret')
		and pg_temp.code_at('qorpera_remove_company_account', 'from public.qorpera_cloud_secrets as secret')
			< pg_temp.code_last_at('qorpera_remove_company_account', 'from public.qorpera_company_accounts as account')
		and (select src ~ '''mode'', ''keyshare'', ''required'', true\)\), true\);' from acct_code where name = 'qorpera_remove_company_account'),
		'D: the removal enters the company, refusing a paused one, before its vault rows');
end $$;

-- E. A removal on a paused company is refused ----------------------------------------------------------------------------

set local session authorization qorpera_secret_broker;
select pg_temp.acct_begin('20', 'company_account:open:e1');
select set_config('qorpera_test.e_open', pg_temp.acct_call('qorpera_open_company_account', '20',
	pg_temp.acct_open_args('20', 'render.com', 'agents+render.com@nordlys.example')), true);
select pg_temp.acct_end('20');
reset session authorization;
select public.qorpera_folder_pause('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'accounts') \g /dev/null
select set_config('qorpera_test.e_remove', pg_temp.acct_member('92400000-0000-4000-8000-000000000001',
	format('select public.qorpera_remove_company_account(''92400000-0000-4000-8000-000000000010'', %L)',
		pg_temp.acct_answer(current_setting('qorpera_test.e_open')) ->> 'accountId')), true);
do $$
declare v_account uuid := pg_temp.acct_answer(current_setting('qorpera_test.e_open')) ->> 'accountId';
begin
	perform pg_temp.base_assert(v_account is not null, 'E: the account opened: ' || current_setting('qorpera_test.e_open'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e_remove') = '55000:Company execution is paused',
		'E: a removal on a paused company: ' || current_setting('qorpera_test.e_remove'));
	perform pg_temp.base_assert((select status from public.qorpera_cloud_secrets where id = v_account) = 'active'
		and exists (select 1 from public.qorpera_cloud_secret_versions where secret_id = v_account)
		and (select status from public.qorpera_company_accounts where secret_id = v_account) = 'pending'
		and not exists (select 1 from public.qorpera_cloud_secret_audit_events where secret_id = v_account and event_type = 'account_removed'),
		'E: the refused removal changed the account');
end $$;

rollback;
