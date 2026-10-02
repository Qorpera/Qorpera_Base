-- @fixture 794_runtime_company_accounts.test.sql until "-- 4. Use, a new version, state changes."
-- Company accounts, A1-3: the vault's read for one fill of the Company Computer's browser. The 794 fixture
-- gives a real admitted run, the company's broker authority and an opened account. The computer, the run's
-- screen lease on it and the boot reported ready with a fill key are written directly (as 628 writes its
-- computers); the function only reads them. Every call is the broker's, bound to an executing
-- computer_browser receipt whose input digest is the call's own operation envelope.

-- The fill key's form: 32 bytes in one base64url spelling, never a low-order point.
do $$
declare
	v_key text := rtrim(translate(encode(extensions.digest('a computer key', 'sha256'), 'base64'), '+/', '-_'), '=');
	v_point bytea;
begin
	if not public.qorpera_company_computer_fill_key_valid(v_key) then
		raise exception 'A well-formed fill key was refused: %', v_key;
	end if;
	foreach v_point in array array[
		'\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
		'\x0100000000000000000000000000000000000000000000000000000000000000'::bytea,
		'\xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800'::bytea,
		'\x5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157'::bytea,
		'\xecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'::bytea,
		'\xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'::bytea,
		'\xeeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'::bytea,
		-- The same points with the unused top bit set.
		'\x0000000000000000000000000000000000000000000000000000000000000080'::bytea,
		'\xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880'::bytea,
		'\xeeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'::bytea
	] loop
		if public.qorpera_company_computer_fill_key_valid(
			rtrim(translate(encode(v_point, 'base64'), '+/', '-_'), '=')) then
			raise exception 'A low-order fill key was accepted: %', encode(v_point, 'hex');
		end if;
	end loop;
	if public.qorpera_company_computer_fill_key_valid(null)
		or public.qorpera_company_computer_fill_key_valid(left(v_key, 42))
		or public.qorpera_company_computer_fill_key_valid(v_key || 'A')
		or public.qorpera_company_computer_fill_key_valid(v_key || '=')
		-- The same 32 bytes spelt with a last character whose unused bits are set.
		or public.qorpera_company_computer_fill_key_valid(left(v_key, 42) || 'B')
		or public.qorpera_company_computer_fill_key_valid(translate(v_key, '-_', '+/'))
			and v_key ~ '[-_]' then
		raise exception 'A malformed fill key was accepted';
	end if;
	if (select count(*) from public.qorpera_runtime_office_activations) <> 0 then
		raise exception 'The fixture already has a computer';
	end if;
	perform set_config('qorpera_test.fill_key', v_key, true);
end $$;

-- The company's computer, generation 1, with the run's screen lease on it and its current boot.
do $$
declare
	v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_staff uuid := (select run.staff_agent_id from public.qorpera_execution_runs as run
		where run.id = (v_binding ->> 'runId')::uuid);
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_offices(id, profile_id, environment_id, logical_computer_id, client_computer_id,
		image_sha256, bootstrap_sha256, state, generation, max_screens, created_by_user_id)
	values ('80700000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020', '80700000-0000-4000-8000-000000000002',
		'80700000-0000-4000-8000-000000000003', repeat('a', 64), repeat('b', 64), 'active', 1, 2,
		'29000000-0000-4000-8000-000000000001');
	insert into public.qorpera_runtime_office_screens(office_id, id, ordinal, staff_agent_id, generation, epoch, power,
		lease_id, run_id, lease_expires_at, grant_version, native_binding)
	values ('80700000-0000-4000-8000-000000000001', '80700000-0000-4000-8000-000000000010', 1, v_staff, 1, 1, 'open',
		'80700000-0000-4000-8000-000000000011', (v_binding ->> 'runId')::uuid, clock_timestamp() + interval '1 hour', 1,
		v_binding);
	insert into public.qorpera_runtime_office_activations(intent_id, activation_id, office_id, computer_generation,
		allocation_id, provider_id, provider_policy_sha256, provider_binding_sha256, instance_sha256, image_sha256,
		bootstrap_sha256, attestation, mappings, state, service_invocation_id, ready_at, activated_at, fill_public_key)
	values ('80700000-0000-4000-8000-000000000020', '80700000-0000-4000-8000-000000000021',
		'80700000-0000-4000-8000-000000000001', 1, '80700000-0000-4000-8000-000000000022',
		'80700000-0000-4000-8000-000000000023', repeat('1', 64), repeat('2', 64), repeat('3', 64), repeat('a', 64),
		repeat('b', 64), '{}', '[]', 'active', repeat('a', 32), clock_timestamp(), clock_timestamp(),
		current_setting('qorpera_test.fill_key'));
	perform set_config('session_replication_role', 'origin', true);
end $$;

-- One vault_fill call's operation envelope, as the computer tool writes it.
create function pg_temp.fill_envelope(p_key text, p_field text default 'password', p_account text default null,
	p_generation integer default 1, p_action text default 'vault_fill')
returns text language sql as $$
	select jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2', 'principals', '{}'::jsonb,
		'operation', jsonb_build_object('tool', 'computer_browser', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', case when p_action = 'vault_fill' then jsonb_build_object('kind', 'browser', 'action', 'vault_fill',
					'role', 'textbox', 'name', 'Password', 'field', p_field,
					'account', coalesce(p_account, current_setting('qorpera_test.ca_account')))
				else jsonb_build_object('kind', 'browser', 'action', 'fill', 'role', 'textbox', 'name', 'Password',
					'text', 'typed by the agent') end,
			'target', jsonb_build_object('realm', 'company_computer', 'resources', '{}'::jsonb,
				'binding', jsonb_build_object('companyId', '29000000-0000-4000-8000-000000000010',
					'environmentId', '29000000-0000-4000-8000-000000000020',
					'companyComputerId', '80700000-0000-4000-8000-000000000001',
					'logicalComputerId', '80700000-0000-4000-8000-000000000002',
					'computerGeneration', p_generation, 'screenId', '80700000-0000-4000-8000-000000000010',
					'screenOrdinal', 1, 'screenGeneration', 1,
					'staffAgentId', '29000000-0000-4000-8000-000000000030'))))::text
$$;
-- The runtime begins and finishes the tool call's receipt (one unresolved receipt per run).
create function pg_temp.fill_receipt(p_n text, p_envelope text, p_key text)
returns void language plpgsql security definer as $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.path_binding')::jsonb,
		('80700000-0000-4000-8000-0000000001' || p_n)::uuid, 'computer_browser:' || p_key,
		encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex'), repeat('b', 64), false);
end
$$;
create function pg_temp.fill_done(p_n text, p_envelope text)
returns void language plpgsql security definer as $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.path_binding')::jsonb,
		('80700000-0000-4000-8000-0000000001' || p_n)::uuid,
		encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex'), '{}'::jsonb);
end
$$;
-- The broker's call: 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.fill(p_n text, p_envelope text, p_capability text default repeat('c', 64),
	p_downstream text default repeat('b', 64), p_authority text default '79400000-0000-4000-8000-000000000040')
returns text language plpgsql as $$
begin
	return pg_temp.ca_try(format('select public.qorpera_fill_company_account(%L,%L,'
		'current_setting(''qorpera_test.path_binding'')::jsonb,%L,%L,%L)', p_authority, p_capability,
		'80700000-0000-4000-8000-0000000001' || p_n, p_envelope, p_downstream));
end
$$;
grant execute on function pg_temp.fill_envelope(text,text,text,integer,text), pg_temp.fill_receipt(text,text,text),
	pg_temp.fill_done(text,text), pg_temp.fill(text,text,text,text,text) to qorpera_secret_broker;
-- A swap of one computer row's column inside this transaction, as the owner (the broker writes none of them).
create function pg_temp.fill_set(p_sql text) returns void language plpgsql security definer as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	execute p_sql;
	perform set_config('session_replication_role', 'origin', true);
end
$$;
grant execute on function pg_temp.fill_set(text) to qorpera_secret_broker;

-- 1. The fill, and every refusal before anything is read.
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.fill_env1', pg_temp.fill_envelope('fill-1'), true);
select pg_temp.fill_receipt('01', current_setting('qorpera_test.fill_env1'), 'fill-1');
select set_config('qorpera_test.fill_null_capability', pg_temp.fill('01', current_setting('qorpera_test.fill_env1'),
	p_capability => null), true);
select set_config('qorpera_test.fill_null_downstream', pg_temp.fill('01', current_setting('qorpera_test.fill_env1'),
	p_downstream => null), true);
select set_config('qorpera_test.fill_null_envelope', pg_temp.fill('01', null), true);
-- Another call's envelope (a different key) does not match this receipt's digest.
select set_config('qorpera_test.fill_other_envelope', pg_temp.fill('01', pg_temp.fill_envelope('fill-1', 'code')), true);
select set_config('qorpera_test.fill_ok', pg_temp.fill('01', current_setting('qorpera_test.fill_env1')), true);
select set_config('qorpera_test.fill_repeat', pg_temp.fill('01', current_setting('qorpera_test.fill_env1')), true);
select pg_temp.fill_done('01', current_setting('qorpera_test.fill_env1'));
-- A finished receipt fills nothing.
select set_config('qorpera_test.fill_finished', pg_temp.fill('01', current_setting('qorpera_test.fill_env1')), true);
-- A typed fill, a field the vault does not fill yet, a generation the computer no longer has.
select set_config('qorpera_test.fill_env2', pg_temp.fill_envelope('fill-2', p_action => 'fill'), true);
select pg_temp.fill_receipt('02', current_setting('qorpera_test.fill_env2'), 'fill-2');
select set_config('qorpera_test.fill_typed', pg_temp.fill('02', current_setting('qorpera_test.fill_env2')), true);
select pg_temp.fill_done('02', current_setting('qorpera_test.fill_env2'));
select set_config('qorpera_test.fill_env3', pg_temp.fill_envelope('fill-3', 'new_password'), true);
select pg_temp.fill_receipt('03', current_setting('qorpera_test.fill_env3'), 'fill-3');
select set_config('qorpera_test.fill_new_password', pg_temp.fill('03', current_setting('qorpera_test.fill_env3')), true);
select pg_temp.fill_done('03', current_setting('qorpera_test.fill_env3'));
select set_config('qorpera_test.fill_env4', pg_temp.fill_envelope('fill-4', p_generation => 2), true);
select pg_temp.fill_receipt('04', current_setting('qorpera_test.fill_env4'), 'fill-4');
select set_config('qorpera_test.fill_old_generation', pg_temp.fill('04', current_setting('qorpera_test.fill_env4')), true);
select pg_temp.fill_done('04', current_setting('qorpera_test.fill_env4'));
-- A receipt begun under another key for the same envelope.
select set_config('qorpera_test.fill_env5', pg_temp.fill_envelope('fill-5', 'code'), true);
select pg_temp.fill_receipt('05', current_setting('qorpera_test.fill_env5'), 'fill-5-other');
select set_config('qorpera_test.fill_other_key', pg_temp.fill('05', current_setting('qorpera_test.fill_env5')), true);
select pg_temp.fill_done('05', current_setting('qorpera_test.fill_env5'));

-- 2. The computer: a lease that ran out or belongs to nobody, and boots without a usable key.
create function pg_temp.fill_case(p_n text, p_change text, p_undo text)
returns text language plpgsql as $$
declare v_envelope text := pg_temp.fill_envelope('fill-' || p_n, 'code'); v_result text;
begin
	perform pg_temp.fill_receipt(p_n, v_envelope, 'fill-' || p_n);
	perform pg_temp.fill_set(p_change);
	v_result := pg_temp.fill(p_n, v_envelope);
	perform pg_temp.fill_set(p_undo);
	perform pg_temp.fill_done(p_n, v_envelope);
	return v_result;
end
$$;
grant execute on function pg_temp.fill_case(text,text,text) to qorpera_secret_broker;
select set_config('qorpera_test.fill_expired', pg_temp.fill_case('10',
	'update public.qorpera_runtime_office_screens set lease_expires_at = clock_timestamp() - interval ''1 second''',
	'update public.qorpera_runtime_office_screens set lease_expires_at = clock_timestamp() + interval ''1 hour'''), true);
select set_config('qorpera_test.fill_released', pg_temp.fill_case('11',
	'update public.qorpera_runtime_office_screens set lease_id = null, run_id = null, lease_expires_at = null,
		grant_version = null, native_binding = null',
	format('update public.qorpera_runtime_office_screens set lease_id = ''80700000-0000-4000-8000-000000000011'',
		run_id = %L, lease_expires_at = clock_timestamp() + interval ''1 hour'', grant_version = 1, native_binding = %L',
		current_setting('qorpera_test.path_binding')::jsonb ->> 'runId', current_setting('qorpera_test.path_binding'))), true);
select set_config('qorpera_test.fill_next_generation', pg_temp.fill_case('12',
	'update public.qorpera_runtime_offices set generation = 2', 'update public.qorpera_runtime_offices set generation = 1'), true);
select set_config('qorpera_test.fill_no_key', pg_temp.fill_case('13',
	'update public.qorpera_runtime_office_activations set fill_public_key = null',
	format('update public.qorpera_runtime_office_activations set fill_public_key = %L',
		current_setting('qorpera_test.fill_key'))), true);
select set_config('qorpera_test.fill_superseded', pg_temp.fill_case('14',
	'update public.qorpera_runtime_office_activations set superseded_at = clock_timestamp()',
	'update public.qorpera_runtime_office_activations set superseded_at = null'), true);
select set_config('qorpera_test.fill_not_active', pg_temp.fill_case('15',
	'update public.qorpera_runtime_office_activations set state = ''ready'', activated_at = null',
	'update public.qorpera_runtime_office_activations set state = ''active'', activated_at = clock_timestamp()'), true);
select set_config('qorpera_test.fill_other_company_computer', pg_temp.fill_case('16',
	'update public.qorpera_runtime_offices set profile_id = ''79400000-0000-4000-8000-000000000010''',
	'update public.qorpera_runtime_offices set profile_id = ''29000000-0000-4000-8000-000000000010'''), true);
select set_config('qorpera_test.fill_other_run', pg_temp.fill_case('17',
	'update public.qorpera_runtime_office_screens set run_id = ''80700000-0000-4000-8000-000000000099''',
	format('update public.qorpera_runtime_office_screens set run_id = %L',
		current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')), true);
select set_config('qorpera_test.fill_other_environment', pg_temp.fill_case('18',
	'update public.qorpera_runtime_offices set environment_id = ''80700000-0000-4000-8000-000000000098''',
	'update public.qorpera_runtime_offices set environment_id = ''29000000-0000-4000-8000-000000000020'''), true);
-- The checks the fill makes itself, before any lock: a malformed call, the switch, a folder company, another
-- company's broker, another downstream digest.
select set_config('qorpera_test.fill_not_json', pg_temp.fill('30', '{not json'), true);
select set_config('qorpera_test.fill_array', pg_temp.fill('30', '[]'), true);
select set_config('qorpera_test.fill_switched_off', pg_temp.fill_case('31',
	'update public.qorpera_company_account_settings set enabled = false',
	'update public.qorpera_company_account_settings set enabled = true'), true);
select set_config('qorpera_test.fill_job_v2', pg_get_functiondef('public.qorpera_job_is_folder_v2(uuid)'::regprocedure), true);
select set_config('qorpera_test.fill_folder', pg_temp.fill_case('32',
	'create or replace function public.qorpera_job_is_folder_v2(p_job_id uuid) returns boolean language sql stable
		security definer set search_path = '''' as $f$ select true $f$',
	current_setting('qorpera_test.fill_job_v2')), true);
select set_config('qorpera_test.fill_env33', pg_temp.fill_envelope('fill-33', 'code'), true);
select pg_temp.fill_receipt('33', current_setting('qorpera_test.fill_env33'), 'fill-33');
select set_config('qorpera_test.fill_other_broker', pg_temp.fill('33', current_setting('qorpera_test.fill_env33'),
	p_capability => repeat('e', 64), p_authority => '79400000-0000-4000-8000-000000000041'), true);
select set_config('qorpera_test.fill_other_downstream', pg_temp.fill('33', current_setting('qorpera_test.fill_env33'),
	p_downstream => repeat('d', 64)), true);
select pg_temp.fill_done('33', current_setting('qorpera_test.fill_env33'));
-- 3. The account: an id that is none of the company's accounts.
select set_config('qorpera_test.fill_env20', pg_temp.fill_envelope('fill-20', 'code',
	'79400000-0000-4000-8000-000000000041'), true);
select pg_temp.fill_receipt('20', current_setting('qorpera_test.fill_env20'), 'fill-20');
select set_config('qorpera_test.fill_unknown_account', pg_temp.fill('20', current_setting('qorpera_test.fill_env20')), true);
select pg_temp.fill_done('20', current_setting('qorpera_test.fill_env20'));
-- 4. Closing the account revokes its vault row at once (its envelopes go with it); a repeat or a second close
--    answers the closed account; nothing is filled from it after.
select pg_temp.ca_receipt('50', 'company_account:state:' || current_setting('qorpera_test.ca_account') || ':r50');
select set_config('qorpera_test.close', pg_temp.ca_call('qorpera_set_company_account_state', '50',
	quote_literal(current_setting('qorpera_test.ca_account')) || ',''closed'''), true);
select set_config('qorpera_test.close_repeat', pg_temp.ca_call('qorpera_set_company_account_state', '50',
	quote_literal(current_setting('qorpera_test.ca_account')) || ',''closed'''), true);
select pg_temp.ca_done('50');
select pg_temp.ca_receipt('51', 'company_account:state:' || current_setting('qorpera_test.ca_account') || ':r51');
select set_config('qorpera_test.close_again', pg_temp.ca_call('qorpera_set_company_account_state', '51',
	quote_literal(current_setting('qorpera_test.ca_account')) || ',''closed'''), true);
select set_config('qorpera_test.reopen_closed', pg_temp.ca_call('qorpera_set_company_account_state', '51',
	quote_literal(current_setting('qorpera_test.ca_account')) || ',''connected'''), true);
select pg_temp.ca_done('51');
-- Another company's closed account: refused, never answered with its site and login.
select pg_temp.fill_set($$
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		connector_id, secret_name, purpose, status, current_version, created_by_user_id, revoked_at)
	values ('80700000-0000-4000-8000-000000000070', '79400000-0000-4000-8000-000000000010',
		'80700000-0000-4000-8000-000000000071', '79400000-0000-4000-8000-000000000041', 'company', 'website',
		'other-site', 'Theirs', 'revoked', 1, '79400000-0000-4000-8000-000000000001', clock_timestamp());
	insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status,
		opened_by_user_id, closed_at)
	values ('80700000-0000-4000-8000-000000000070', '79400000-0000-4000-8000-000000000010',
		'80700000-0000-4000-8000-000000000071', 'other.example', 'theirs@other.example', 'closed',
		'79400000-0000-4000-8000-000000000001', clock_timestamp())
$$);
select pg_temp.ca_receipt('53', 'company_account:state:80700000-0000-4000-8000-000000000070:r53');
select set_config('qorpera_test.close_theirs', pg_temp.ca_call('qorpera_set_company_account_state', '53',
	'''80700000-0000-4000-8000-000000000070'',''closed'''), true);
select pg_temp.ca_done('53');
select set_config('qorpera_test.fill_env52', pg_temp.fill_envelope('fill-52'), true);
select pg_temp.fill_receipt('52', current_setting('qorpera_test.fill_env52'), 'fill-52');
select set_config('qorpera_test.fill_closed', pg_temp.fill('52', current_setting('qorpera_test.fill_env52')), true);
select pg_temp.fill_done('52', current_setting('qorpera_test.fill_env52'));
reset session authorization;
-- Not the broker.
select set_config('qorpera_test.fill_not_broker', pg_temp.ca_try(format(
	'select public.qorpera_fill_company_account(''79400000-0000-4000-8000-000000000040'',repeat(''c'',64),'
	'current_setting(''qorpera_test.path_binding'')::jsonb,%L,%L,repeat(''b'',64))',
	'80700000-0000-4000-8000-000000000101', current_setting('qorpera_test.fill_env1'))), true);

do $$
declare
	v_ok jsonb;
	v_audit integer;
	v_lease_refused constant text := '42501:company computer lease is unavailable';
	v_no_key constant text :=
		'0A000:The computer cannot type account values right now: it is still starting, or it needs a restart on a newer version';
	v_receipt_refused constant text := '42501:company account fill receipt is unavailable';
	v_malformed constant text := '22023:company account fill call is malformed';
begin
	if current_setting('qorpera_test.fill_ok') not like 'ok:%' then
		raise exception 'The fill was refused: %', current_setting('qorpera_test.fill_ok');
	end if;
	v_ok := substring(current_setting('qorpera_test.fill_ok') from 4)::jsonb;
	if v_ok - 'encryptedEnvelopeBase64' is distinct from jsonb_build_object(
		'schema', 'qorpera.company-account-fill-context/v1', 'accountId', current_setting('qorpera_test.ca_account'),
		'site', 'vercel.com', 'signInHosts', '[]'::jsonb, 'login', 'agents@nordlys.example', 'twoStep', 'none',
		'status', 'pending', 'version', 1, 'companyId', '29000000-0000-4000-8000-000000000010',
		'environmentId', '29000000-0000-4000-8000-000000000020', 'keyId', 'company-kek-1',
		'envelopeSha256', encode(extensions.digest('\x0102'::bytea, 'sha256'), 'hex'),
		'receiptId', '80700000-0000-4000-8000-000000000101', 'field', 'password',
		'companyComputerId', '80700000-0000-4000-8000-000000000001', 'computerGeneration', 1,
		'fillPublicKey', current_setting('qorpera_test.fill_key'))
		or v_ok ->> 'encryptedEnvelopeBase64' is distinct from encode('\x0102'::bytea, 'base64') then
		raise exception 'Wrong fill context: %', v_ok;
	end if;
	-- A repeat of the same call reads it again (a code is made fresh each time).
	if current_setting('qorpera_test.fill_repeat') is distinct from current_setting('qorpera_test.fill_ok') then
		raise exception 'A repeated fill read differently: %', current_setting('qorpera_test.fill_repeat');
	end if;
	select count(*) into v_audit from public.qorpera_cloud_secret_audit_events
	where event_type = 'account_used' and receipt_id = '80700000-0000-4000-8000-000000000101';
	if v_audit <> 2 or not exists (select 1 from public.qorpera_company_accounts
		where secret_id = current_setting('qorpera_test.ca_account')::uuid and last_used_at is not null
			and last_used_by_staff_agent_id = '29000000-0000-4000-8000-000000000030') then
		raise exception 'The fill was not recorded as a use: % events', v_audit;
	end if;
	if current_setting('qorpera_test.fill_null_capability') is distinct from '42501:cloud secret broker authority is unavailable'
		or current_setting('qorpera_test.fill_null_downstream') is distinct from v_receipt_refused
		or current_setting('qorpera_test.fill_null_envelope') is distinct from v_malformed
		or current_setting('qorpera_test.fill_other_envelope') is distinct from v_receipt_refused
		or current_setting('qorpera_test.fill_finished') is distinct from v_receipt_refused
		or current_setting('qorpera_test.fill_other_key') is distinct from v_receipt_refused then
		raise exception 'A fill call that is not this receipt''s was not refused: % % % % % %',
			current_setting('qorpera_test.fill_null_capability'), current_setting('qorpera_test.fill_null_downstream'),
			current_setting('qorpera_test.fill_null_envelope'), current_setting('qorpera_test.fill_other_envelope'),
			current_setting('qorpera_test.fill_finished'), current_setting('qorpera_test.fill_other_key');
	end if;
	if current_setting('qorpera_test.fill_typed') is distinct from v_malformed
		or current_setting('qorpera_test.fill_new_password') is distinct from v_malformed then
		raise exception 'Not a vault fill, or a field not filled yet, was read: % %',
			current_setting('qorpera_test.fill_typed'), current_setting('qorpera_test.fill_new_password');
	end if;
	if current_setting('qorpera_test.fill_old_generation') is distinct from v_lease_refused
		or current_setting('qorpera_test.fill_expired') is distinct from v_lease_refused
		or current_setting('qorpera_test.fill_released') is distinct from v_lease_refused
		or current_setting('qorpera_test.fill_next_generation') is distinct from v_lease_refused
		or current_setting('qorpera_test.fill_other_company_computer') is distinct from v_lease_refused
		or current_setting('qorpera_test.fill_other_run') is distinct from v_lease_refused
		or current_setting('qorpera_test.fill_other_environment') is distinct from v_lease_refused then
		raise exception 'A computer the run does not hold now was filled: % % % % % % %',
			current_setting('qorpera_test.fill_old_generation'), current_setting('qorpera_test.fill_expired'),
			current_setting('qorpera_test.fill_released'), current_setting('qorpera_test.fill_next_generation'),
			current_setting('qorpera_test.fill_other_company_computer'), current_setting('qorpera_test.fill_other_run'),
			current_setting('qorpera_test.fill_other_environment');
	end if;
	if current_setting('qorpera_test.fill_not_json') is distinct from v_malformed
		or current_setting('qorpera_test.fill_array') is distinct from v_malformed
		or current_setting('qorpera_test.fill_switched_off') is distinct from '0A000:Company accounts are switched off'
		or current_setting('qorpera_test.fill_folder') is distinct from
			'0A000:Accounts for folder companies come with their connection file'
		or current_setting('qorpera_test.fill_other_broker') is distinct from
			'42501:cloud secret broker does not serve this company'
		or current_setting('qorpera_test.fill_other_downstream') is distinct from v_receipt_refused then
		raise exception 'A fill check before any lock failed: % % % % % %', current_setting('qorpera_test.fill_not_json'),
			current_setting('qorpera_test.fill_array'), current_setting('qorpera_test.fill_switched_off'),
			current_setting('qorpera_test.fill_folder'), current_setting('qorpera_test.fill_other_broker'),
			current_setting('qorpera_test.fill_other_downstream');
	end if;
	-- The close: revoked, wiped, closed, by no member; a repeat and a second close answer it; it never reopens.
	if current_setting('qorpera_test.close') not like 'ok:%'
		or substring(current_setting('qorpera_test.close') from 4)::jsonb ->> 'status' is distinct from 'closed'
		or current_setting('qorpera_test.close_repeat') is distinct from current_setting('qorpera_test.close')
		or current_setting('qorpera_test.close_again') is distinct from current_setting('qorpera_test.close')
		or current_setting('qorpera_test.reopen_closed') is distinct from '22023:The company has no such open account'
		or current_setting('qorpera_test.fill_closed') is distinct from '22023:The company has no such open account'
		or current_setting('qorpera_test.close_theirs') is distinct from '22023:The company has no such open account'
		or not exists (select 1 from public.qorpera_cloud_secrets where id = current_setting('qorpera_test.ca_account')::uuid
			and status = 'revoked' and revoked_by_user_id is null)
		or exists (select 1 from public.qorpera_cloud_secret_versions
			where secret_id = current_setting('qorpera_test.ca_account')::uuid)
		or not exists (select 1 from public.qorpera_company_accounts
			where secret_id = current_setting('qorpera_test.ca_account')::uuid and status = 'closed'
				and closed_at is not null and removed_by_user_id is null)
		or (select count(*) from public.qorpera_cloud_secret_audit_events
			where secret_id = current_setting('qorpera_test.ca_account')::uuid and event_type = 'account_state_changed'
				and operation_id = 'closed') <> 1 then
		raise exception 'A close did not revoke and wipe the account once: % % % % % %', current_setting('qorpera_test.close'),
			current_setting('qorpera_test.close_repeat'), current_setting('qorpera_test.close_again'),
			current_setting('qorpera_test.reopen_closed'), current_setting('qorpera_test.fill_closed'),
			current_setting('qorpera_test.close_theirs');
	end if;
	if current_setting('qorpera_test.fill_no_key') is distinct from v_no_key
		or current_setting('qorpera_test.fill_superseded') is distinct from v_no_key
		or current_setting('qorpera_test.fill_not_active') is distinct from v_no_key then
		raise exception 'A boot without a current key was filled: % % %', current_setting('qorpera_test.fill_no_key'),
			current_setting('qorpera_test.fill_superseded'), current_setting('qorpera_test.fill_not_active');
	end if;
	if current_setting('qorpera_test.fill_unknown_account') is distinct from '22023:The company has no such open account' then
		raise exception 'Another company''s account was filled: %', current_setting('qorpera_test.fill_unknown_account');
	end if;
	if current_setting('qorpera_test.fill_not_broker') is distinct from '42501:cloud secret broker authority is required' then
		raise exception 'A caller other than the broker filled: %', current_setting('qorpera_test.fill_not_broker');
	end if;
	-- Only the broker may call it; nothing on the native host's list reaches the fill or the ready report.
	if exists (select 1 from information_schema.routine_privileges
			where routine_name = 'qorpera_fill_company_account' and grantee <> 'qorpera_secret_broker' and grantee <> 'postgres')
		or not has_function_privilege('qorpera_secret_broker',
			'public.qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text)', 'EXECUTE')
		or has_function_privilege('service_role',
			'public.qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text)', 'EXECUTE')
		or has_function_privilege('qorpera_secret_broker',
			'public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer,text)', 'EXECUTE')
		or exists (select 1 from public.qorpera_native_host_calls as call
			where call.name in ('qorpera_fill_company_account', 'qorpera_report_runtime_office_ready')) then
		raise exception 'The fill or the ready report is reachable by a role that must not call it';
	end if;
end $$;
