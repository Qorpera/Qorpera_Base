-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- 20260930695000: an agent takes a coding value off its service's website into the vault (computer_browser vault_capture
-- with a codingValue), as E3c takes a Stripe hook's secret. On 405's office fixture (924's folder-v2 company; Alice's
-- live run, for the owner, holds a native screen lease on the company's computer), with the company's broker authority:
-- 1. the first capture: no key until the broker prepares it; the prepare makes the key and keeps it; the office's read,
--    the broker's read, the store (the secret, version 1, the repository grant issued by the owner, two audit rows) and
--    its replay; the grant serves as qorpera_authorize_coding_environment serves one, and the member's list shows it;
-- 2. a second capture for another repository: version 2 only as the next version, and a second grant;
-- 3. a value a member saved already: the prepare answers its id, refuses one another secret holds, and the capture adds
--    a version to it;
-- 4. the company's key turns: the key must be made again, is replaced (audited), and the next version is sealed under
--    the new key, with no second grant for a repository that has one;
-- 5. every refusal writes nothing: the call (the service, the variable, the repository, the purpose, both forms), the
--    lease, the authority, the receipt, the envelope, the version, the key, Postgres' own session; a contributor's run,
--    a worker's run, a company being deleted, a removed secret (the prepare makes the key again for a new id);
-- 6. the grants, the closed tables, the seeded services, the browser action, the audit types and the marker.
-- 20260930698000 (step 2) adds the broker's description of what a capture key is derived from: before and after the
-- prepare (1), after the company's key turned (4), refused for another receipt (1) and outside the broker's session (5),
-- and its grant (6). It writes nothing.

-- The company's broker authority; another company's, for 5.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('11810000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('11810000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
select set_config('session_replication_role', 'origin', true);
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('11810000-0000-4000-8000-000000000041', '11810000-0000-4000-8000-000000000011', 'https://broker.example.test',
	'other-kek-1', repeat('8', 64));

-- A company coding value a member saved (version 1 sealed by the broker), for 3.
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
	connector_id, secret_name, purpose, current_version, created_by_user_id)
values ('11810000-0000-4000-8000-000000000301', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'11810000-0000-4000-8000-000000000040', 'company', null, 'environment', 'resend_api_key', 'Sends mail from the app.', 1,
	'92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
	envelope_sha256, created_by_user_id)
values ('11810000-0000-4000-8000-000000000301', 1, '11810000-0000-4000-8000-000000000040', 'company-kek-1', '\x0101',
	encode(extensions.digest('\x0101'::bytea, 'sha256'), 'hex'), '92400000-0000-4000-8000-000000000001');

-- Two capture keys, as the broker makes them (the public half of an X25519 key, base64url without padding).
select set_config('qorpera_test.cv_key1',
	rtrim(translate(encode(extensions.digest('a 1181 capture key', 'sha256'), 'base64'), '+/', '-_'), '='), true);
select set_config('qorpera_test.cv_key2',
	rtrim(translate(encode(extensions.digest('a 1181 capture key 2', 'sha256'), 'base64'), '+/', '-_'), '='), true);
-- Another value's capture key, its id reserved and no secret made yet, for 5.
insert into public.qorpera_coding_value_capture_keys(environment_id, secret_name, secret_id, broker_authority_id, key_id,
	public_key)
values ('92400000-0000-4000-8000-000000000020', 'stripe_secret_key', '11810000-0000-4000-8000-000000000205',
	'11810000-0000-4000-8000-000000000040', 'company-kek-1', current_setting('qorpera_test.cv_key1'));

-- Alice's run acknowledges first, as a member's wake requires before any tool (405 §2).
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'cv-ack') is not null;
reset role;

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.cv_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.cv_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- One vault_capture call's operation envelope, as the computer tool writes it (419's shape): npm_token for
-- qorpera/qorpera_base unless the coding value (p_value) or the arguments (p_args) change.
create function pg_temp.cv_envelope(p_key text, p_value jsonb default '{}', p_args jsonb default '{}',
	p_binding jsonb default '{}') returns text
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb) -> 'identity')
			- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'computer_browser', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('kind', 'browser', 'action', 'vault_capture', 'role', 'button', 'name', 'Copy token',
				'codingValue', jsonb_build_object('service', 'npm', 'variable', 'npm_token', 'repository', 'qorpera/qorpera_base',
					'purpose', 'Publishes the SDK to npm.') || p_value) || p_args,
			'target', jsonb_build_object('realm', 'company_computer',
				'binding', (current_setting('qorpera_test.office_lease')::jsonb -> 'binding') || p_binding,
				'resources', public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb) -> 'resources')))::text;
end $$;
-- Receipt n ('11810000-0000-4000-8000-0000000001' || n) begins as the computer_browser call of an envelope, and the
-- office admits it; cv_end drains and completes it.
create function pg_temp.cv_begin(p_n text, p_envelope text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('11810000-0000-4000-8000-0000000001' || p_n)::uuid, 'computer_browser:' || (p_envelope::jsonb #>> '{operation,logicalOperationKey}'),
		encode(extensions.digest(p_envelope, 'sha256'), 'hex'), repeat('e', 64), false);
	perform pg_temp.base_assert(public.qorpera_native_office_operation(current_setting('qorpera_test.base_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb, current_setting('qorpera_test.office_lease')::jsonb, p_envelope, 'begin',
		('11810000-0000-4000-8000-0000000001' || p_n)::uuid, repeat('e', 64)) ->> 'state' = 'admitted',
		'the office admits receipt ' || p_n);
end $$;
create function pg_temp.cv_end(p_n text, p_envelope text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_native_office_operation(current_setting('qorpera_test.base_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb, current_setting('qorpera_test.office_lease')::jsonb, p_envelope, 'finish',
		('11810000-0000-4000-8000-0000000001' || p_n)::uuid, repeat('e', 64));
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('11810000-0000-4000-8000-0000000001' || p_n)::uuid, encode(extensions.digest(p_envelope, 'sha256'), 'hex'), '{}'::jsonb);
end $$;
-- The office's read of receipt n's call, as the service role.
create function pg_temp.cv_office(p_n text, p_envelope text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.cv_try(format('select public.qorpera_native_office_coding_value_capture(%L::jsonb, %L::jsonb, %L::jsonb, %L, %L, %L)',
		current_setting('qorpera_test.base_binding'), current_setting('qorpera_test.office_scope'),
		current_setting('qorpera_test.office_lease'), p_envelope, '11810000-0000-4000-8000-0000000001' || p_n, repeat('e', 64)));
	reset role;
	return v;
end $$;
-- A broker call for receipt n's call (the read by default; the prepare and the store take their arguments after it), on
-- Alice's binding with the company's authority by default.
create function pg_temp.cv_call(p_n text, p_envelope text, p_rest text default null,
	p_function text default 'qorpera_folder_read_coding_value_capture', p_binding text default null,
	p_authority text default '11810000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64),
	p_downstream text default repeat('e', 64))
returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '', true);
	return pg_temp.cv_try(format('select public.%s(%L, %L, %L::jsonb, %L, %L, %L%s)', p_function, p_authority, p_capability,
		coalesce(p_binding, current_setting('qorpera_test.base_binding')), '11810000-0000-4000-8000-0000000001' || p_n, p_envelope,
		p_downstream, coalesce(', ' || p_rest, '')));
end $$;
-- A prepare's arguments: the id the broker derived for, the key's id (the authority's current one by default) and the
-- capture key ('key1' and 'key2' are the two above).
create function pg_temp.cv_prepare_args(p_secret text, p_key text default 'key1', p_key_id text default null)
returns text language sql security definer as $$
	select format('%L, %L, %L', case when p_secret is not null then '11810000-0000-4000-8000-000000000' || p_secret end,
		coalesce(p_key_id, (select authority.key_id from public.qorpera_cloud_secret_broker_authorities as authority
			where authority.id = '11810000-0000-4000-8000-000000000040')),
		case when p_key in ('key1', 'key2') then current_setting('qorpera_test.cv_' || p_key) else p_key end)
$$;
-- A store's arguments: the secret, the version, the company, the environment, the key's id (the authority's current one
-- by default), the sealed box and its sha-256.
create function pg_temp.cv_store_args(p_version bigint, p_box bytea default '\x0301', p_secret text default '201',
	p_company text default '92400000-0000-4000-8000-000000000010', p_environment text default '92400000-0000-4000-8000-000000000020',
	p_key_id text default null, p_sha text default null)
returns text language sql security definer as $$
	select format('%L, %L::bigint, %L, %L, %L, %L::bytea, %L', '11810000-0000-4000-8000-000000000' || p_secret, p_version, p_company,
		p_environment, coalesce(p_key_id, (select authority.key_id from public.qorpera_cloud_secret_broker_authorities as authority
			where authority.id = '11810000-0000-4000-8000-000000000040')), p_box,
		coalesce(p_sha, encode(extensions.digest(p_box, 'sha256'), 'hex')))
$$;
create function pg_temp.cv_counts() returns jsonb language sql security definer as $$
	select jsonb_build_object('keys', (select count(*) from public.qorpera_coding_value_capture_keys),
		'secrets', (select count(*) from public.qorpera_cloud_secrets where status = 'active'),
		'versions', (select count(*) from public.qorpera_cloud_secret_versions),
		'events', (select count(*) from public.qorpera_cloud_secret_audit_events),
		'grants', (select count(*) from public.qorpera_coding_environment_grants where status = 'active'),
		'receipts', (select count(*) from public.qorpera_run_operation_receipts))
$$;
create function pg_temp.cv_delta(p_after jsonb, p_before jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(a.key, a.value::text::bigint - (p_before ->> a.key)::bigint)
		filter (where a.value::text::bigint <> (p_before ->> a.key)::bigint), '{}'::jsonb)
	from jsonb_each(p_after) as a
$$;
-- The test's refusals that differ from what they expect, one per line.
create function pg_temp.cv_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;
grant execute on function pg_temp.cv_try(text), pg_temp.cv_answer(text),
	pg_temp.cv_call(text, text, text, text, text, text, text, text), pg_temp.cv_prepare_args(text, text, text),
	pg_temp.cv_store_args(bigint, bytea, text, text, text, text, text), pg_temp.cv_counts(), pg_temp.cv_delta(jsonb, jsonb),
	pg_temp.cv_differ(jsonb)
	to qorpera_secret_broker;
grant execute on function pg_temp.cv_try(text) to service_role;

-- 1. The first capture -----------------------------------------------------------------------------------------------------

select set_config('qorpera_test.cv_env11', pg_temp.cv_envelope('cv-11'), true);
select pg_temp.cv_begin('11', current_setting('qorpera_test.cv_env11'));
select set_config('qorpera_test.cv_office11a', pg_temp.cv_office('11', current_setting('qorpera_test.cv_env11')), true);
select set_config('qorpera_test.cv_c10', pg_temp.cv_counts()::text, true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_read11a', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11')), true);
select set_config('qorpera_test.cv_desc11a', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11'), null,
	'qorpera_folder_describe_coding_value_capture'), true);
-- Another receipt than the call's: refused.
select set_config('qorpera_test.cv_desc11x', pg_temp.cv_call('99', current_setting('qorpera_test.cv_env11'), null,
	'qorpera_folder_describe_coding_value_capture'), true);
select set_config('qorpera_test.cv_prep11', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11'),
	pg_temp.cv_prepare_args('201'), 'qorpera_folder_prepare_coding_value_capture'), true);
select set_config('qorpera_test.cv_c11', pg_temp.cv_counts()::text, true);
-- Prepared again with another reservation and key: the key made first stays.
select set_config('qorpera_test.cv_prep11b', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11'),
	pg_temp.cv_prepare_args('202', 'key2'), 'qorpera_folder_prepare_coding_value_capture'), true);
select set_config('qorpera_test.cv_c12', pg_temp.cv_counts()::text, true);
reset session authorization;
select set_config('qorpera_test.cv_office11', pg_temp.cv_office('11', current_setting('qorpera_test.cv_env11')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_read11', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11')), true);
select set_config('qorpera_test.cv_desc11', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11'), null,
	'qorpera_folder_describe_coding_value_capture'), true);
select set_config('qorpera_test.cv_store11', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11'),
	pg_temp.cv_store_args(1), 'qorpera_folder_store_coding_value_capture'), true);
select set_config('qorpera_test.cv_c13', pg_temp.cv_counts()::text, true);
-- The same store again answers from the audit row and stores nothing.
select set_config('qorpera_test.cv_again11', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11'),
	pg_temp.cv_store_args(1), 'qorpera_folder_store_coding_value_capture'), true);
select set_config('qorpera_test.cv_reread11', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11')), true);
select set_config('qorpera_test.cv_c14', pg_temp.cv_counts()::text, true);
reset session authorization;
select pg_temp.cv_end('11', current_setting('qorpera_test.cv_env11'));
-- The member's list of the environment's coding values, as the owner.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.cv_list11', public.qorpera_list_coding_environment('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020')::text, true);
reset role;

do $$
declare
	v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_office uuid := (current_setting('qorpera_test.office_lease')::jsonb #>> '{binding,companyComputerId}')::uuid;
	v_generation bigint;
	v_key jsonb;
	v_read jsonb;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_grant public.qorpera_coding_environment_grants%rowtype;
	v_again text := '55000:The coding value''s capture key must be made again';
begin
	select generation into v_generation from public.qorpera_runtime_offices where id = v_office;
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_office11a') = v_again
			and current_setting('qorpera_test.cv_read11a') = v_again,
		'1: no key before the prepare: ' || current_setting('qorpera_test.cv_office11a') || ' / '
			|| current_setting('qorpera_test.cv_read11a'));
	-- The description: the company, the environment, the value and the authority's key; no id the value keeps and no
	-- current key before the prepare (which wrote only the key: the counts below), the key's id and public half after.
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_desc11a')) = jsonb_build_object(
			'schema', 'qorpera.coding-value-capture-description/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
			'environmentId', '92400000-0000-4000-8000-000000000020', 'variable', 'npm_token', 'keyId', 'company-kek-1',
			'current', false),
		'1: the description before the prepare: ' || current_setting('qorpera_test.cv_desc11a'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_desc11')) = jsonb_build_object(
			'schema', 'qorpera.coding-value-capture-description/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
			'environmentId', '92400000-0000-4000-8000-000000000020', 'variable', 'npm_token', 'keyId', 'company-kek-1',
			'secretId', '11810000-0000-4000-8000-000000000201', 'current', true,
			'capturePublicKey', current_setting('qorpera_test.cv_key1')),
		'1: the description after the prepare: ' || current_setting('qorpera_test.cv_desc11'));
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_desc11x') = '42501:coding value capture receipt is unavailable',
		'1: the description for another receipt: ' || current_setting('qorpera_test.cv_desc11x'));
	v_key := jsonb_build_object('schema', 'qorpera.coding-value-capture-key/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', '92400000-0000-4000-8000-000000000020', 'variable', 'npm_token', 'keyId', 'company-kek-1',
		'secretId', '11810000-0000-4000-8000-000000000201', 'current', true, 'replaced', false,
		'capturePublicKey', current_setting('qorpera_test.cv_key1'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_prep11')) = v_key
			and pg_temp.cv_delta(current_setting('qorpera_test.cv_c11')::jsonb, current_setting('qorpera_test.cv_c10')::jsonb)
				= '{"keys": 1}'
			and exists (select 1 from public.qorpera_coding_value_capture_keys
				where environment_id = '92400000-0000-4000-8000-000000000020' and secret_name = 'npm_token'
					and secret_id = '11810000-0000-4000-8000-000000000201'
					and broker_authority_id = '11810000-0000-4000-8000-000000000040' and key_id = 'company-kek-1'
					and public_key = current_setting('qorpera_test.cv_key1')),
		'1: the prepare makes the key: ' || current_setting('qorpera_test.cv_prep11'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_prep11b')) = v_key
			and current_setting('qorpera_test.cv_c12') = current_setting('qorpera_test.cv_c11'),
		'1: a second prepare keeps the key: ' || current_setting('qorpera_test.cv_prep11b'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_office11')) = jsonb_build_object(
			'schema', 'qorpera.coding-value-capture-target/v1', 'service', 'npm', 'site', 'www.npmjs.com',
			'valuePattern', '^npm_[A-Za-z0-9]{36}$', 'variable', 'npm_token', 'companyId', '92400000-0000-4000-8000-000000000010',
			'companyComputerId', v_office, 'computerGeneration', v_generation, 'receiptId', '11810000-0000-4000-8000-000000000111',
			'capturePublicKey', current_setting('qorpera_test.cv_key1')),
		'1: the office''s read: ' || current_setting('qorpera_test.cv_office11'));
	v_read := jsonb_build_object('schema', 'qorpera.coding-value-capture-context/v1',
		'secretId', '11810000-0000-4000-8000-000000000201', 'version', 1, 'service', 'npm', 'site', 'www.npmjs.com',
		'valuePattern', '^npm_[A-Za-z0-9]{36}$', 'variable', 'npm_token', 'repository', 'qorpera/qorpera_base',
		'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', '92400000-0000-4000-8000-000000000020',
		'keyId', 'company-kek-1', 'capturePublicKey', current_setting('qorpera_test.cv_key1'),
		'receiptId', '11810000-0000-4000-8000-000000000111', 'companyComputerId', v_office, 'computerGeneration', v_generation);
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_read11')) = v_read,
		'1: the broker''s read: ' || current_setting('qorpera_test.cv_read11'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_store11')) = jsonb_build_object(
			'schema', 'qorpera.coding-value-capture-stored/v1', 'variable', 'npm_token', 'repository', 'qorpera/qorpera_base',
			'secretId', '11810000-0000-4000-8000-000000000201', 'version', 1, 'replayed', false)
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_again11')) = jsonb_build_object(
			'schema', 'qorpera.coding-value-capture-stored/v1', 'variable', 'npm_token', 'repository', 'qorpera/qorpera_base',
			'secretId', '11810000-0000-4000-8000-000000000201', 'version', 1, 'replayed', true),
		'1: the store and its replay: ' || current_setting('qorpera_test.cv_store11') || ' / '
			|| current_setting('qorpera_test.cv_again11'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_reread11')) = v_read
			|| jsonb_build_object('version', 2, 'current', jsonb_build_object('version', 1, 'keyId', 'company-kek-1',
				'encryptedEnvelopeBase64', 'AwE=', 'envelopeSha256', encode(extensions.digest('\x0301'::bytea, 'sha256'), 'hex')),
				'captured', jsonb_build_object('version', 1)),
		'1: the read after the store: ' || current_setting('qorpera_test.cv_reread11'));
	-- The secret: the company's coding value, named for the variable, made by the run's requester; version 1 the box
	-- under this authority's key.
	select * into v_secret from public.qorpera_cloud_secrets where id = '11810000-0000-4000-8000-000000000201';
	perform pg_temp.base_assert(v_secret.profile_id = '92400000-0000-4000-8000-000000000010'
			and v_secret.environment_id = '92400000-0000-4000-8000-000000000020'
			and v_secret.broker_authority_id = '11810000-0000-4000-8000-000000000040' and v_secret.owner_kind = 'company'
			and v_secret.owner_user_id is null and v_secret.connector_id = 'environment' and v_secret.secret_name = 'npm_token'
			and v_secret.purpose = 'Publishes the SDK to npm.' and v_secret.current_version = 1 and v_secret.status = 'active'
			and v_secret.created_by_user_id = '92400000-0000-4000-8000-000000000001',
		'1: the secret');
	select * into v_version from public.qorpera_cloud_secret_versions where secret_id = v_secret.id;
	perform pg_temp.base_assert(v_version.version = 1 and v_version.broker_authority_id = '11810000-0000-4000-8000-000000000040'
			and v_version.key_id = 'company-kek-1' and v_version.encrypted_envelope = '\x0301'::bytea
			and v_version.envelope_sha256 = encode(extensions.digest('\x0301'::bytea, 'sha256'), 'hex')
			and v_version.created_by_user_id = '92400000-0000-4000-8000-000000000001',
		'1: the version');
	-- The grant: the call's repository, issued by the owner who asked.
	select * into v_grant from public.qorpera_coding_environment_grants where secret_id = v_secret.id;
	perform pg_temp.base_assert(v_grant.profile_id = v_secret.profile_id and v_grant.environment_id = v_secret.environment_id
			and v_grant.repository = 'qorpera/qorpera_base' and v_grant.status = 'active'
			and v_grant.issued_by_user_id = '92400000-0000-4000-8000-000000000001',
		'1: the grant');
	perform pg_temp.base_assert((select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
				where secret_id = v_secret.id) = array['coding_value_captured', 'environment_grant_issued']
			and exists (select 1 from public.qorpera_cloud_secret_audit_events where secret_id = v_secret.id
				and event_type = 'coding_value_captured' and secret_version = 1
				and receipt_id = '11810000-0000-4000-8000-000000000111' and run_id = v_run
				and actor_user_id = '92400000-0000-4000-8000-000000000001' and connector_id = 'environment' and grant_id is null)
			and exists (select 1 from public.qorpera_cloud_secret_audit_events where secret_id = v_secret.id
				and event_type = 'environment_grant_issued' and secret_version = 1 and grant_id = v_grant.id
				and receipt_id = '11810000-0000-4000-8000-000000000111' and run_id = v_run
				and actor_user_id = '92400000-0000-4000-8000-000000000001' and connector_id = 'environment'),
		'1: the audit rows');
	perform pg_temp.base_assert(pg_temp.cv_delta(current_setting('qorpera_test.cv_c13')::jsonb,
			current_setting('qorpera_test.cv_c12')::jsonb) = '{"secrets": 1, "versions": 1, "events": 2, "grants": 1}'
			and current_setting('qorpera_test.cv_c14') = current_setting('qorpera_test.cv_c13'),
		'1: the store stores ' || pg_temp.cv_delta(current_setting('qorpera_test.cv_c13')::jsonb,
			current_setting('qorpera_test.cv_c12')::jsonb)::text);
	-- What qorpera_authorize_coding_environment serves for a session on qorpera/qorpera_base (5j-1's predicate): a company
	-- environment secret of this authority, under a name still allowed, with a live grant there from a current owner or
	-- admin, its current version sealed under the authority's key.
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_cloud_secrets as secret
			join public.qorpera_cloud_secret_versions as version
				on version.secret_id = secret.id and version.version = secret.current_version
			join public.qorpera_cloud_secret_broker_authorities as authority on authority.id = secret.broker_authority_id
			where secret.id = v_secret.id and secret.connector_id = 'environment' and secret.owner_kind = 'company'
				and secret.status = 'active' and public.qorpera_coding_environment_name_allowed(secret.secret_name)
				and version.broker_authority_id = authority.id and version.key_id = authority.key_id
				and exists (select 1 from public.qorpera_coding_environment_grants as environment_grant
					join public.qorpera_profile_members as issuer on issuer.profile_id = environment_grant.profile_id
						and issuer.user_id = environment_grant.issued_by_user_id and issuer.role in ('owner', 'admin')
					where environment_grant.secret_id = secret.id and environment_grant.repository = 'qorpera/qorpera_base'
						and environment_grant.status = 'active')),
		'1: the coding session of qorpera/qorpera_base is served the value');
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_list11')::jsonb @> jsonb_build_array(jsonb_build_object(
			'secretId', v_secret.id, 'name', 'NPM_TOKEN', 'ownerKind', 'company', 'version', 1,
			'grants', jsonb_build_array(jsonb_build_object('grantId', v_grant.id, 'repository', 'qorpera/qorpera_base')))),
		'1: the member''s list: ' || current_setting('qorpera_test.cv_list11'));
end $$;

-- 2. A second capture, for another repository: only the next version stores, and it is granted there too --------------

select set_config('qorpera_test.cv_env12', pg_temp.cv_envelope('cv-12', '{"repository": "qorpera/qorpera-web"}'), true);
select pg_temp.cv_begin('12', current_setting('qorpera_test.cv_env12'));
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_2x', pg_temp.cv_differ(jsonb_build_array(
	jsonb_build_array('store: the version taken', pg_temp.cv_call('12', current_setting('qorpera_test.cv_env12'),
		pg_temp.cv_store_args(1, '\x0302'), 'qorpera_folder_store_coding_value_capture'),
		'40003:coding value capture outcome is unconfirmed'),
	jsonb_build_array('store: a version skipped', pg_temp.cv_call('12', current_setting('qorpera_test.cv_env12'),
		pg_temp.cv_store_args(3, '\x0302'), 'qorpera_folder_store_coding_value_capture'),
		'40003:coding value capture outcome is unconfirmed'),
	jsonb_build_array('read: a finished receipt', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11')),
		'42501:coding value capture receipt is unavailable'),
	jsonb_build_array('store: a finished receipt', pg_temp.cv_call('11', current_setting('qorpera_test.cv_env11'),
		pg_temp.cv_store_args(2, '\x0302'), 'qorpera_folder_store_coding_value_capture'),
		'42501:coding value capture receipt is unavailable'))), true);
select set_config('qorpera_test.cv_store12', pg_temp.cv_call('12', current_setting('qorpera_test.cv_env12'),
	pg_temp.cv_store_args(2, '\x0302'), 'qorpera_folder_store_coding_value_capture'), true);
select set_config('qorpera_test.cv_reread12', pg_temp.cv_call('12', current_setting('qorpera_test.cv_env12')), true);
reset session authorization;
select pg_temp.cv_end('12', current_setting('qorpera_test.cv_env12'));

do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_2x') = '',
		E'2: refusals that differ:\n' || current_setting('qorpera_test.cv_2x'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_store12')) #>> '{version}' = '2'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_store12')) #>> '{repository}' = 'qorpera/qorpera-web'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_reread12')) #> '{current}' = jsonb_build_object('version', 2,
				'keyId', 'company-kek-1', 'encryptedEnvelopeBase64', 'AwI=',
				'envelopeSha256', encode(extensions.digest('\x0302'::bytea, 'sha256'), 'hex'))
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_reread12')) #> '{captured}' = '{"version": 2}'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_reread12')) #>> '{version}' = '3',
		'2: the second capture: ' || current_setting('qorpera_test.cv_store12') || ' / ' || current_setting('qorpera_test.cv_reread12'));
	perform pg_temp.base_assert((select current_version from public.qorpera_cloud_secrets
				where id = '11810000-0000-4000-8000-000000000201') = 2
			and (select array_agg(version order by version) from public.qorpera_cloud_secret_versions
				where secret_id = '11810000-0000-4000-8000-000000000201') = array[1, 2]::bigint[]
			and (select array_agg(repository order by repository collate "C") from public.qorpera_coding_environment_grants
				where secret_id = '11810000-0000-4000-8000-000000000201' and status = 'active')
				= array['qorpera/qorpera-web', 'qorpera/qorpera_base']
			and (select count(*) from public.qorpera_cloud_secrets where secret_name = 'npm_token') = 1,
		'2: one secret at version 2, granted on both repositories');
end $$;

-- 3. A value a member saved already: the capture adds a version to it --------------------------------------------------

select set_config('qorpera_test.cv_env13', pg_temp.cv_envelope('cv-13', '{"service": "resend", "variable": "resend_api_key",
	"purpose": "Sends the sign-in mails."}'), true);
select pg_temp.cv_begin('13', current_setting('qorpera_test.cv_env13'));
select set_config('qorpera_test.cv_c30', pg_temp.cv_counts()::text, true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_prep13a', pg_temp.cv_call('13', current_setting('qorpera_test.cv_env13'),
	pg_temp.cv_prepare_args('302'), 'qorpera_folder_prepare_coding_value_capture'), true);
select set_config('qorpera_test.cv_prep13t', pg_temp.cv_call('13', current_setting('qorpera_test.cv_env13'),
	pg_temp.cv_prepare_args('201'), 'qorpera_folder_prepare_coding_value_capture'), true);
select set_config('qorpera_test.cv_c31', pg_temp.cv_counts()::text, true);
select set_config('qorpera_test.cv_prep13', pg_temp.cv_call('13', current_setting('qorpera_test.cv_env13'),
	pg_temp.cv_prepare_args('301', 'key2'), 'qorpera_folder_prepare_coding_value_capture'), true);
select set_config('qorpera_test.cv_store13x', pg_temp.cv_call('13', current_setting('qorpera_test.cv_env13'),
	pg_temp.cv_store_args(1, '\x0303', '301'), 'qorpera_folder_store_coding_value_capture'), true);
select set_config('qorpera_test.cv_store13y', pg_temp.cv_call('13', current_setting('qorpera_test.cv_env13'),
	pg_temp.cv_store_args(2, '\x0303', '302'), 'qorpera_folder_store_coding_value_capture'), true);
select set_config('qorpera_test.cv_store13', pg_temp.cv_call('13', current_setting('qorpera_test.cv_env13'),
	pg_temp.cv_store_args(2, '\x0303', '301'), 'qorpera_folder_store_coding_value_capture'), true);
reset session authorization;
select pg_temp.cv_end('13', current_setting('qorpera_test.cv_env13'));

do $$
begin
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_prep13a')) = jsonb_build_object(
			'schema', 'qorpera.coding-value-capture-key/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
			'environmentId', '92400000-0000-4000-8000-000000000020', 'variable', 'resend_api_key', 'keyId', 'company-kek-1',
			'secretId', '11810000-0000-4000-8000-000000000301', 'current', false)
			and current_setting('qorpera_test.cv_prep13t') = '42501:coding value secret id is taken'
			and current_setting('qorpera_test.cv_c31') = current_setting('qorpera_test.cv_c30'),
		'3: the prepare names the value''s id, and refuses another secret''s: ' || current_setting('qorpera_test.cv_prep13a')
			|| ' / ' || current_setting('qorpera_test.cv_prep13t'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_prep13')) #>> '{current}' = 'true'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_prep13')) #>> '{replaced}' = 'false'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_prep13')) #>> '{capturePublicKey}'
				= current_setting('qorpera_test.cv_key2')
			and (select secret_id from public.qorpera_coding_value_capture_keys where secret_name = 'resend_api_key')
				= '11810000-0000-4000-8000-000000000301',
		'3: the key for the value''s id: ' || current_setting('qorpera_test.cv_prep13'));
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_store13x') = '40003:coding value capture outcome is unconfirmed'
			and current_setting('qorpera_test.cv_store13y') = '42501:coding value envelope is unavailable',
		'3: the store''s refusals: ' || current_setting('qorpera_test.cv_store13x') || ' / '
			|| current_setting('qorpera_test.cv_store13y'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_store13')) #>> '{version}' = '2'
			and (select current_version = 2 and purpose = 'Sends mail from the app.' from public.qorpera_cloud_secrets
				where id = '11810000-0000-4000-8000-000000000301')
			and (select count(*) from public.qorpera_cloud_secrets where secret_name = 'resend_api_key') = 1
			and exists (select 1 from public.qorpera_coding_environment_grants
				where secret_id = '11810000-0000-4000-8000-000000000301' and repository = 'qorpera/qorpera_base'
					and status = 'active' and issued_by_user_id = '92400000-0000-4000-8000-000000000001'),
		'3: the capture adds version 2 to the saved value and grants it: ' || current_setting('qorpera_test.cv_store13'));
end $$;

-- 4. The company's key turns: the key must be made again, and is ----------------------------------------------------------

select set_config('session_replication_role', 'replica', true);
update public.qorpera_cloud_secret_broker_authorities set key_id = 'company-kek-2'
where id = '11810000-0000-4000-8000-000000000040';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.cv_env14', pg_temp.cv_envelope('cv-14'), true);
select pg_temp.cv_begin('14', current_setting('qorpera_test.cv_env14'));
select set_config('qorpera_test.cv_office14a', pg_temp.cv_office('14', current_setting('qorpera_test.cv_env14')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_4x', pg_temp.cv_differ(jsonb_build_array(
	jsonb_build_array('read', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14')),
		'55000:The coding value''s capture key must be made again'),
	jsonb_build_array('store', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14'), pg_temp.cv_store_args(3, '\x0304'),
		'qorpera_folder_store_coding_value_capture'), '55000:The coding value''s capture key must be made again'),
	jsonb_build_array('prepare: the old key', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14'),
		pg_temp.cv_prepare_args('201', 'key2', 'company-kek-1'), 'qorpera_folder_prepare_coding_value_capture'),
		'42501:coding value capture key is unavailable'),
	-- The description names the new key, the id the value keeps, and a key that is not current.
	jsonb_build_array('describe', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14'), null,
		'qorpera_folder_describe_coding_value_capture'), 'ok:' || jsonb_build_object(
		'schema', 'qorpera.coding-value-capture-description/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', '92400000-0000-4000-8000-000000000020', 'variable', 'npm_token', 'keyId', 'company-kek-2',
		'secretId', '11810000-0000-4000-8000-000000000201', 'current', false)::text))), true);
select set_config('qorpera_test.cv_c40', pg_temp.cv_counts()::text, true);
select set_config('qorpera_test.cv_prep14a', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14'),
	pg_temp.cv_prepare_args('203', 'key2'), 'qorpera_folder_prepare_coding_value_capture'), true);
select set_config('qorpera_test.cv_c41', pg_temp.cv_counts()::text, true);
select set_config('qorpera_test.cv_prep14', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14'),
	pg_temp.cv_prepare_args('201', 'key2'), 'qorpera_folder_prepare_coding_value_capture'), true);
reset session authorization;
select set_config('qorpera_test.cv_office14', pg_temp.cv_office('14', current_setting('qorpera_test.cv_env14')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_read14', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14')), true);
select set_config('qorpera_test.cv_c42', pg_temp.cv_counts()::text, true);
select set_config('qorpera_test.cv_store14', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env14'),
	pg_temp.cv_store_args(3, '\x0304'), 'qorpera_folder_store_coding_value_capture'), true);
select set_config('qorpera_test.cv_c43', pg_temp.cv_counts()::text, true);
reset session authorization;
select pg_temp.cv_end('14', current_setting('qorpera_test.cv_env14'));

do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_office14a') = '55000:The coding value''s capture key must be made again'
			and current_setting('qorpera_test.cv_4x') = '',
		E'4: a turned key: ' || current_setting('qorpera_test.cv_office14a') || E'\n' || current_setting('qorpera_test.cv_4x'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_prep14a')) #>> '{current}' = 'false'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_prep14a')) #>> '{secretId}' = '11810000-0000-4000-8000-000000000201'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_prep14a')) #>> '{keyId}' = 'company-kek-2'
			and current_setting('qorpera_test.cv_c41') = current_setting('qorpera_test.cv_c40'),
		'4: a key for another id is not stored: ' || current_setting('qorpera_test.cv_prep14a'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_prep14')) #>> '{current}' = 'true'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_prep14')) #>> '{replaced}' = 'true'
			and (select key_id = 'company-kek-2' and public_key = current_setting('qorpera_test.cv_key2')
				from public.qorpera_coding_value_capture_keys where secret_name = 'npm_token')
			and (select count(*) from public.qorpera_cloud_secret_audit_events
				where event_type = 'coding_value_capture_key_replaced' and secret_id = '11810000-0000-4000-8000-000000000201'
					and secret_version is null and receipt_id = '11810000-0000-4000-8000-000000000114'
					and run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
					and actor_user_id = '92400000-0000-4000-8000-000000000001' and connector_id = 'environment') = 1
			and pg_temp.cv_delta(current_setting('qorpera_test.cv_c42')::jsonb, current_setting('qorpera_test.cv_c41')::jsonb)
				= '{"events": 1}',
		'4: the key is made again: ' || current_setting('qorpera_test.cv_prep14'));
	-- The current version is under the old key: the broker is not given it.
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_office14')) #>> '{capturePublicKey}'
				= current_setting('qorpera_test.cv_key2')
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_read14')) #>> '{version}' = '3'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_read14')) #>> '{keyId}' = 'company-kek-2'
			and not pg_temp.cv_answer(current_setting('qorpera_test.cv_read14')) ?| array['current', 'captured'],
		'4: the reads under the new key: ' || current_setting('qorpera_test.cv_office14') || ' / '
			|| current_setting('qorpera_test.cv_read14'));
	-- Version 3 under the new key; the repository has its grant already.
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_store14')) #>> '{version}' = '3'
			and (select key_id from public.qorpera_cloud_secret_versions
				where secret_id = '11810000-0000-4000-8000-000000000201' and version = 3) = 'company-kek-2'
			and pg_temp.cv_delta(current_setting('qorpera_test.cv_c43')::jsonb, current_setting('qorpera_test.cv_c42')::jsonb)
				= '{"versions": 1, "events": 1}',
		'4: the store under the new key: ' || current_setting('qorpera_test.cv_store14') || ' '
			|| pg_temp.cv_delta(current_setting('qorpera_test.cv_c43')::jsonb, current_setting('qorpera_test.cv_c42')::jsonb)::text);
end $$;

-- 5. Every refusal writes nothing -------------------------------------------------------------------------------------------

select set_config('qorpera_test.cv_env15', pg_temp.cv_envelope('cv-15'), true);
select pg_temp.cv_begin('15', current_setting('qorpera_test.cv_env15'));
-- The call with one field set.
create function pg_temp.cv_env15(p_path text[], p_value jsonb) returns text language sql as $$
	select jsonb_set(current_setting('qorpera_test.cv_env15')::jsonb, p_path, p_value)::text
$$;
grant execute on function pg_temp.cv_env15(text[], jsonb) to qorpera_secret_broker;
select set_config('qorpera_test.cv_c50', pg_temp.cv_counts()::text, true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_read15', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15')), true);
select set_config('qorpera_test.cv_5x', pg_temp.cv_differ(jsonb_build_array(
	jsonb_build_array('call: none', pg_temp.cv_call('15', null), '22023:coding value capture call is malformed'),
	jsonb_build_array('call: not json', pg_temp.cv_call('15', 'not json'), '22023:coding value capture call is malformed'),
	jsonb_build_array('call: an array', pg_temp.cv_call('15', '[]'), '22023:coding value capture call is malformed'),
	jsonb_build_array('call: schema', pg_temp.cv_call('15', pg_temp.cv_env15('{schema}', '"qorpera.cloud-tool-operation/v1"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('call: tool', pg_temp.cv_call('15', pg_temp.cv_env15('{operation,tool}', '"computer_type"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('call: realm', pg_temp.cv_call('15', pg_temp.cv_env15('{operation,target,realm}', '"company"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('call: vault_fill', pg_temp.cv_call('15', pg_temp.cv_env15('{operation,arguments,action}', '"vault_fill"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('call: role', pg_temp.cv_call('15', pg_temp.cv_env15('{operation,arguments,role}', '"textbox"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('call: no name', pg_temp.cv_call('15', pg_temp.cv_env15('{operation,arguments,name}', '" "')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('call: a hook too', pg_temp.cv_call('15', jsonb_set(pg_temp.cv_env15('{operation,arguments,hook}',
			'"a1810000-0000-4000-8000-000000000abc"')::jsonb, '{operation,arguments,field}', '"signing_secret"')::text),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('value: not an object', pg_temp.cv_call('15', pg_temp.cv_env15('{operation,arguments,codingValue}', '"npm"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('value: another field', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,value}', '"npm_x"')), '22023:coding value capture call is malformed'),
	jsonb_build_array('value: no purpose', pg_temp.cv_call('15', (current_setting('qorpera_test.cv_env15')::jsonb
		#- '{operation,arguments,codingValue,purpose}')::text), '22023:coding value capture call is malformed'),
	jsonb_build_array('value: a number', pg_temp.cv_call('15', pg_temp.cv_env15('{operation,arguments,codingValue,purpose}', '3')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('value: another service', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,service}', '"pypi"')), '22023:coding value capture call is malformed'),
	jsonb_build_array('value: the service in capitals', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,service}', '"NPM"')), '22023:coding value capture call is malformed'),
	jsonb_build_array('variable: path', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,variable}', '"path"')), '22023:coding value capture call is malformed'),
	jsonb_build_array('variable: git_token', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,variable}', '"git_token"')), '22023:coding value capture call is malformed'),
	jsonb_build_array('variable: openai_api_key', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,variable}', '"openai_api_key"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('variable: in capitals', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,variable}', '"NPM_TOKEN"')), '22023:coding value capture call is malformed'),
	jsonb_build_array('repository: in capitals', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,repository}', '"Qorpera/Qorpera_Base"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('repository: no owner', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,repository}', '"qorpera_base"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('repository: a path', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,repository}', '"qorpera/qorpera_base/src"')),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('purpose: empty', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,purpose}', '""')), '22023:coding value capture call is malformed'),
	jsonb_build_array('purpose: untrimmed', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,purpose}', '" Publishes."')), '22023:coding value capture call is malformed'),
	jsonb_build_array('purpose: too long', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,purpose}', to_jsonb(repeat('x', 301)))),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('purpose: a line break', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,arguments,codingValue,purpose}', to_jsonb(E'Publishes\nthe SDK.'::text))),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('call: no computer', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,target,binding,companyComputerId}', 'null')), '22023:coding value capture call is malformed'),
	jsonb_build_array('call: too long', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15') || repeat(' ', 65536)),
		'22023:coding value capture call is malformed'),
	jsonb_build_array('lease: another generation', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,target,binding,computerGeneration}', '99')), '42501:company computer lease is unavailable'),
	jsonb_build_array('lease: another screen', pg_temp.cv_call('15',
		pg_temp.cv_env15('{operation,target,binding,screenId}', '"11810000-0000-4000-8000-000000000999"')),
		'42501:company computer lease is unavailable'),
	jsonb_build_array('binding: malformed', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), null,
		'qorpera_folder_read_coding_value_capture', '[]'), '22023:coding value run binding is malformed'),
	jsonb_build_array('authority: none', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), null,
		'qorpera_folder_read_coding_value_capture', null, '11810000-0000-4000-8000-000000000049'),
		'42501:cloud secret broker authority is unavailable'),
	jsonb_build_array('authority: another capability', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), null,
		'qorpera_folder_read_coding_value_capture', null, '11810000-0000-4000-8000-000000000040', repeat('8', 64)),
		'42501:cloud secret broker authority is unavailable'),
	jsonb_build_array('authority: another company''s', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), null,
		'qorpera_folder_read_coding_value_capture', null, '11810000-0000-4000-8000-000000000041', repeat('8', 64)),
		'42501:cloud secret broker does not serve this company'),
	jsonb_build_array('receipt: never begun', pg_temp.cv_call('19', current_setting('qorpera_test.cv_env15')),
		'42501:coding value capture receipt is unavailable'),
	jsonb_build_array('receipt: another call''s', pg_temp.cv_call('14', current_setting('qorpera_test.cv_env15')),
		'42501:coding value capture receipt is unavailable'),
	jsonb_build_array('receipt: another call', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env14')),
		'42501:coding value capture receipt is unavailable'),
	jsonb_build_array('receipt: another downstream key', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), null,
		'qorpera_folder_read_coding_value_capture', null, '11810000-0000-4000-8000-000000000040', repeat('9', 64), repeat('c', 64)),
		'42501:coding value capture receipt is unavailable'),
	jsonb_build_array('receipt: a downstream key in capitals', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), null,
		'qorpera_folder_read_coding_value_capture', null, '11810000-0000-4000-8000-000000000040', repeat('9', 64), repeat('E', 64)),
		'42501:coding value capture receipt is unavailable'),
	jsonb_build_array('store: another secret', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(4, '\x0305', '202'), 'qorpera_folder_store_coding_value_capture'),
		'42501:coding value envelope is unavailable'),
	jsonb_build_array('store: another company', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(4, '\x0305', '201', '11810000-0000-4000-8000-000000000011'),
		'qorpera_folder_store_coding_value_capture'), '42501:coding value envelope is unavailable'),
	jsonb_build_array('store: another environment', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(4, '\x0305', '201', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000021'),
		'qorpera_folder_store_coding_value_capture'), '42501:coding value envelope is unavailable'),
	jsonb_build_array('store: the old key', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(4, '\x0305', p_key_id => 'company-kek-1'), 'qorpera_folder_store_coding_value_capture'),
		'42501:coding value envelope is unavailable'),
	jsonb_build_array('store: an empty box', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(4, '\x'), 'qorpera_folder_store_coding_value_capture'), '42501:coding value envelope is unavailable'),
	jsonb_build_array('store: no box', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(4, null), 'qorpera_folder_store_coding_value_capture'), '42501:coding value envelope is unavailable'),
	jsonb_build_array('store: another digest', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(4, '\x0305', p_sha => repeat('f', 64)), 'qorpera_folder_store_coding_value_capture'),
		'42501:coding value envelope is unavailable'),
	jsonb_build_array('store: the version taken', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(3, '\x0305'), 'qorpera_folder_store_coding_value_capture'),
		'40003:coding value capture outcome is unconfirmed'),
	jsonb_build_array('store: a version skipped', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_store_args(5, '\x0305'), 'qorpera_folder_store_coding_value_capture'),
		'40003:coding value capture outcome is unconfirmed'),
	jsonb_build_array('prepare: no id', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_prepare_args(null), 'qorpera_folder_prepare_coding_value_capture'), '42501:coding value capture key is unavailable'),
	jsonb_build_array('prepare: not a key', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_prepare_args('204', 'not a key'), 'qorpera_folder_prepare_coding_value_capture'),
		'42501:coding value capture key is unavailable'),
	jsonb_build_array('prepare: a zero key', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_prepare_args('204', repeat('A', 43)), 'qorpera_folder_prepare_coding_value_capture'),
		'42501:coding value capture key is unavailable'),
	jsonb_build_array('prepare: another secret''s id', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_prepare_args('301', 'key2'), 'qorpera_folder_prepare_coding_value_capture'), '42501:coding value secret id is taken'),
	jsonb_build_array('prepare: another capture key''s id', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
		pg_temp.cv_prepare_args('205', 'key2'), 'qorpera_folder_prepare_coding_value_capture'), '42501:coding value secret id is taken')
)), true);
select set_config('qorpera_test.cv_c51', pg_temp.cv_counts()::text, true);
reset session authorization;
-- Only the broker's session calls the broker's functions.
select set_config('qorpera_test.cv_5y', pg_temp.cv_differ(jsonb_build_array(
	jsonb_build_array('prepare', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), pg_temp.cv_prepare_args('204', 'key2'),
		'qorpera_folder_prepare_coding_value_capture'), '42501:cloud secret broker authority is required'),
	jsonb_build_array('read', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15')),
		'42501:cloud secret broker authority is required'),
	jsonb_build_array('describe', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), null,
		'qorpera_folder_describe_coding_value_capture'), '42501:cloud secret broker authority is required'),
	jsonb_build_array('store', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), pg_temp.cv_store_args(4, '\x0305'),
		'qorpera_folder_store_coding_value_capture'), '42501:cloud secret broker authority is required'))), true);

do $$
begin
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_read15')) #>> '{version}' = '4',
		'5: the call reads: ' || current_setting('qorpera_test.cv_read15'));
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_5x') = '',
		E'5: refusals that differ:\n' || current_setting('qorpera_test.cv_5x'));
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_5y') = '',
		E'5: calls outside the broker''s session that differ:\n' || current_setting('qorpera_test.cv_5y'));
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_c51') = current_setting('qorpera_test.cv_c50'),
		'5: a refusal stored ' || pg_temp.cv_delta(current_setting('qorpera_test.cv_c51')::jsonb,
			current_setting('qorpera_test.cv_c50')::jsonb)::text);
end $$;

-- A requester who is no longer an owner or admin takes nothing.
savepoint cv_demoted;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.cv_office15d', pg_temp.cv_office('15', current_setting('qorpera_test.cv_env15')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_5d', pg_temp.cv_differ(jsonb_build_array(
	jsonb_build_array('prepare', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), pg_temp.cv_prepare_args('204', 'key2'),
		'qorpera_folder_prepare_coding_value_capture'), '42501:Only owners and admins can save coding values; ask one of them'),
	jsonb_build_array('read', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15')),
		'42501:Only owners and admins can save coding values; ask one of them'),
	jsonb_build_array('store', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'), pg_temp.cv_store_args(4, '\x0305'),
		'qorpera_folder_store_coding_value_capture'), '42501:Only owners and admins can save coding values; ask one of them'))),
	true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_office15d')
				= '42501:Only owners and admins can save coding values; ask one of them'
			and current_setting('qorpera_test.cv_5d') = '',
		E'5: a contributor''s run: ' || current_setting('qorpera_test.cv_office15d') || E'\n' || current_setting('qorpera_test.cv_5d'));
end $$;
rollback to savepoint cv_demoted;

-- A worker's run takes nothing, whoever asked: the run check's wake authority refuses it first (both the office's check
-- and the broker's), before the capture's own check.
savepoint cv_worker;
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id)
values ('11810000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000030', '11810000-0000-4000-8000-0000000000a2', 'cv-worker', 'A worker', 'write', 'each', '{}',
	'92400000-0000-4000-8000-000000000001', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid);
update public.qorpera_wake_occurrences set wake_kind = 'agent', source_kind = 'worker-dispatch',
	source_id = '11810000-0000-4000-8000-0000000000a1'
where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.cv_office15w', pg_temp.cv_office('15', current_setting('qorpera_test.cv_env15')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_read15w', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15')), true);
select set_config('qorpera_test.cv_store15w', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
	pg_temp.cv_store_args(4, '\x0305'), 'qorpera_folder_store_coding_value_capture'), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_office15w') = '42501:Admitted wake authority is unavailable'
			and current_setting('qorpera_test.cv_read15w') = '42501:Admitted wake authority is unavailable'
			and current_setting('qorpera_test.cv_store15w') = '42501:Admitted wake authority is unavailable',
		'5: a worker''s run: ' || concat_ws(' / ', current_setting('qorpera_test.cv_office15w'),
			current_setting('qorpera_test.cv_read15w'), current_setting('qorpera_test.cv_store15w')));
end $$;
rollback to savepoint cv_worker;

-- A company being deleted takes nothing: its execution stops (the run check and the office's check), before the
-- capture's own check.
savepoint cv_deleting;
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.cv_office15g', pg_temp.cv_office('15', current_setting('qorpera_test.cv_env15')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_read15g', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15')), true);
select set_config('qorpera_test.cv_store15g', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
	pg_temp.cv_store_args(4, '\x0305'), 'qorpera_folder_store_coding_value_capture'), true);
select set_config('qorpera_test.cv_prep15g', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
	pg_temp.cv_prepare_args('204', 'key2'), 'qorpera_folder_prepare_coding_value_capture'), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_office15g') = '55000:Company execution is paused'
			and current_setting('qorpera_test.cv_read15g') = '55000:Company execution is paused'
			and current_setting('qorpera_test.cv_store15g') = '55000:Company execution is paused'
			and current_setting('qorpera_test.cv_prep15g') = '55000:Company execution is paused',
		'5: a company being deleted: ' || concat_ws(' / ', current_setting('qorpera_test.cv_office15g'),
			current_setting('qorpera_test.cv_read15g'), current_setting('qorpera_test.cv_store15g'),
			current_setting('qorpera_test.cv_prep15g')));
end $$;
rollback to savepoint cv_deleting;

-- A value removed from the vault (Disconnect) is taken again only under a new id, which the prepare makes the key for.
savepoint cv_removed;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp()
where id = '11810000-0000-4000-8000-000000000201';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.cv_office15r', pg_temp.cv_office('15', current_setting('qorpera_test.cv_env15')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.cv_read15r', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15')), true);
select set_config('qorpera_test.cv_prep15r', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15'),
	pg_temp.cv_prepare_args('204', 'key1'), 'qorpera_folder_prepare_coding_value_capture'), true);
select set_config('qorpera_test.cv_read15n', pg_temp.cv_call('15', current_setting('qorpera_test.cv_env15')), true);
reset session authorization;
do $$
declare v_again text := '55000:The coding value''s capture key must be made again';
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.cv_office15r') = v_again
			and current_setting('qorpera_test.cv_read15r') = v_again,
		'5: a removed value: ' || current_setting('qorpera_test.cv_office15r') || ' / ' || current_setting('qorpera_test.cv_read15r'));
	perform pg_temp.base_assert(pg_temp.cv_answer(current_setting('qorpera_test.cv_prep15r')) #>> '{secretId}'
				= '11810000-0000-4000-8000-000000000204'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_prep15r')) #>> '{replaced}' = 'true'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_read15n')) #>> '{secretId}' = '11810000-0000-4000-8000-000000000204'
			and pg_temp.cv_answer(current_setting('qorpera_test.cv_read15n')) #>> '{version}' = '1',
		'5: the key is made again for a new id: ' || current_setting('qorpera_test.cv_prep15r') || ' / '
			|| current_setting('qorpera_test.cv_read15n'));
end $$;
rollback to savepoint cv_removed;
select pg_temp.cv_end('15', current_setting('qorpera_test.cv_env15'));

-- 6. Grants, tables, services, the browser action, the audit types and the marker -------------------------------------------

do $$
declare
	v_function text;
	v_role text;
	v_granted text[];
	v_action jsonb := jsonb_build_object('kind', 'browser', 'action', 'vault_capture', 'role', 'link', 'name', 'Reveal',
		'codingValue', jsonb_build_object('service', 'github', 'variable', 'gh_publish_token', 'repository', 'qorpera/qorpera_base',
			'purpose', 'Publishes releases.'));
	v_hook jsonb := jsonb_build_object('kind', 'browser', 'action', 'vault_capture', 'role', 'button', 'name', 'Reveal',
		'hook', 'a1810000-0000-4000-8000-000000000abc', 'field', 'signing_secret');
begin
	-- Who may run each function: the broker its four, the host the office's read, nobody the rest.
	for v_function, v_granted in select call.fn, call.roles from (values
		('public.qorpera_folder_prepare_coding_value_capture(uuid,text,jsonb,uuid,text,text,uuid,text,text)',
			array['qorpera_secret_broker']),
		('public.qorpera_folder_read_coding_value_capture(uuid,text,jsonb,uuid,text,text)', array['qorpera_secret_broker']),
		('public.qorpera_folder_describe_coding_value_capture(uuid,text,jsonb,uuid,text,text)', array['qorpera_secret_broker']),
		('public.qorpera_folder_store_coding_value_capture(uuid,text,jsonb,uuid,text,text,uuid,bigint,uuid,uuid,text,bytea,text)',
			array['qorpera_secret_broker']),
		('public.qorpera_native_office_coding_value_capture(jsonb,jsonb,jsonb,text,uuid,text)', array['service_role']),
		('public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,jsonb,uuid,text,text,'
			|| 'boolean)', array[]::text[]),
		('public.qorpera_folder_coding_value_authority(uuid,text,jsonb)', array[]::text[]),
		('public.qorpera_valid_office_browser_action(jsonb)', array[]::text[])
	) as call(fn, roles) loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'execute') = (v_role = any(v_granted)),
				format('6: %s for %s', v_function, v_role));
		end loop;
	end loop;
	-- No role reads or writes the two tables.
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_coding_value_services',
				'select, insert, update, delete, truncate, references, trigger')
			and not has_table_privilege(v_role, 'public.qorpera_coding_value_capture_keys',
				'select, insert, update, delete, truncate, references, trigger'),
			format('6: the tables for %s', v_role));
	end loop;
	perform pg_temp.base_assert((select jsonb_agg(jsonb_build_array(service, site, value_pattern) order by service)
			from public.qorpera_coding_value_services) = jsonb_build_array(
			jsonb_build_array('github', 'github.com', '^(github_pat_[A-Za-z0-9_]{82}|ghp_[A-Za-z0-9]{36})$'),
			jsonb_build_array('npm', 'www.npmjs.com', '^npm_[A-Za-z0-9]{36}$'),
			jsonb_build_array('resend', 'resend.com', '^re_[A-Za-z0-9_]{20,64}$'),
			jsonb_build_array('stripe', 'dashboard.stripe.com', '^(sk|rk)_(test|live)_[A-Za-z0-9]{24,247}$')),
		'6: the seeded services');
	-- The patterns, as the guest and the broker match them.
	perform pg_temp.base_assert(('npm_' || repeat('a1B', 12)) ~ (select value_pattern from public.qorpera_coding_value_services
				where service = 'npm')
			and ('github_pat_' || repeat('a_1', 27) || 'b') ~ (select value_pattern from public.qorpera_coding_value_services
				where service = 'github')
			and ('ghp_' || repeat('x', 36)) ~ (select value_pattern from public.qorpera_coding_value_services where service = 'github')
			and ('rk_live_' || repeat('Z', 24)) ~ (select value_pattern from public.qorpera_coding_value_services where service = 'stripe')
			and not ('pk_live_' || repeat('Z', 24)) ~ (select value_pattern from public.qorpera_coding_value_services
				where service = 'stripe')
			and ('re_' || repeat('k', 20)) ~ (select value_pattern from public.qorpera_coding_value_services where service = 'resend')
			and not ('npm_' || repeat('a', 35)) ~ (select value_pattern from public.qorpera_coding_value_services where service = 'npm'),
		'6: the patterns');
	-- The browser action: a coding value or a hook's secret, never both; STABLE, as it reads the services.
	perform pg_temp.base_assert(public.qorpera_valid_office_browser_action(v_action)
			and public.qorpera_valid_office_browser_action(v_hook)
			and not public.qorpera_valid_office_browser_action(v_action || (v_hook - 'role' - 'name'))
			and not public.qorpera_valid_office_browser_action(v_hook || '{"codingValue": {}}')
			and not public.qorpera_valid_office_browser_action(v_action || '{"role": "textbox"}')
			and not public.qorpera_valid_office_browser_action(v_action || '{"text": "x"}')
			and not public.qorpera_valid_office_browser_action(v_action #- '{codingValue,repository}')
			and not public.qorpera_valid_office_browser_action(jsonb_set(v_action, '{codingValue,variable}', '"ld_preload"'))
			and not public.qorpera_valid_office_browser_action(jsonb_set(v_action, '{codingValue,variable}', '"claude_code_token"'))
			and not public.qorpera_valid_office_browser_action(jsonb_set(v_action, '{codingValue,service}', 'null'))
			and (select provolatile from pg_proc where oid = 'public.qorpera_valid_office_browser_action(jsonb)'::regprocedure) = 's',
		'6: the vault_capture action');
	perform pg_temp.base_assert((select pg_get_constraintdef(oid) from pg_constraint
			where conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
				and conname = 'qorpera_cloud_secret_audit_events_event_type_check') like '%''coding_value_captured''%'
			and (select pg_get_constraintdef(oid) from pg_constraint
				where conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
					and conname = 'qorpera_cloud_secret_audit_events_event_type_check') like '%''coding_value_capture_key_replaced''%',
		'6: the audit event types');
	-- The deploy guard's marker is in these seven bodies, and in no other.
	perform pg_temp.base_assert((select array_agg(proc.proname::text order by proc.proname::text collate "C")
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930695000') > 0) = array[
			'qorpera_folder_coding_value_authority', 'qorpera_folder_coding_value_capture_context',
			'qorpera_folder_prepare_coding_value_capture', 'qorpera_folder_read_coding_value_capture',
			'qorpera_folder_store_coding_value_capture', 'qorpera_native_office_coding_value_capture',
			'qorpera_valid_office_browser_action'],
		'6: the marker''s bodies');
end $$;

rollback;
