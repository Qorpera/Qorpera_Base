-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- Company folder core C4, E3c-1 (migration 20260930344000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.8): Stripe
-- hooks, whose signing secret the vault takes from Stripe's dashboard on the company's computer. On 405's office fixture
-- (924's folder-v2 company; Alice's live run holds a native screen lease on the company's computer), with the company's
-- broker authority:
-- 1. the broker opens a Stripe hook with its capture key (the hook and the key, no secret); a replay answers from the
--    receipt; a GitHub hook opens as before; every refusal writes nothing;
-- 2. the broker describes the capture key, and replaces it while nothing was taken under it;
-- 3. the office's read refuses a call that is not a vault_capture of a live Stripe hook of the run's company;
-- 4. the first capture: the office's read, the broker's read, the store (the secret, version 1 and the audit row) and its
--    replay; 5. a second capture stores version 2, and only as the next version;
-- 6. a new broker key: the old capture key is refused until it is replaced, and a key that took a secret stays;
-- 7. while the hook is paused, every refusal of the reads and the store writes nothing: the call, the lease, the
--    authority, the company, the receipt, the envelope, the version, Postgres' own session, a requester who is no longer
--    an owner, a revoked secret; then a fourth capture; 8. the descriptor: the secret's version, when it was taken, and
--    the newest refusal under it; 9. the vault's fill types no Stripe secret; 10. a removed hook is captured no more;
-- 11. the grants, the dropped nine-argument effect, the browser action's capture variant and the marker.
-- The races (two stores of one version, a replace beside a store) are left to a committed fixture, as 948 is 987's.

-- The company's broker authority, no public URL (the answer's hook then has no url), and A1's switch off.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('41900000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
update public.qorpera_event_intake_settings set public_url = null;
update public.qorpera_company_account_settings set enabled = false;

-- Two capture keys, as the broker makes them (the public half of an X25519 key, base64url without padding).
select set_config('qorpera_test.e3c_key1',
	rtrim(translate(encode(extensions.digest('a 419 capture key', 'sha256'), 'base64'), '+/', '-_'), '='), true);
select set_config('qorpera_test.e3c_key2',
	rtrim(translate(encode(extensions.digest('a 419 capture key 2', 'sha256'), 'base64'), '+/', '-_'), '='), true);

-- A snapshot-v1 company (as every company inserted without the folder is) with its owner, environment, broker authority,
-- a job of its own and a Stripe hook with its capture key (written directly, as replica).
insert into auth.users(id, email) values ('41900000-0000-4000-8000-000000000001', 'stripe-old-core@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('41900000-0000-4000-8000-000000000010', 'Old core', '41900000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('41900000-0000-4000-8000-000000000010', '41900000-0000-4000-8000-000000000001', 'stripe-old-core@example.test', 'Owner',
	'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('41900000-0000-4000-8000-000000000020', '41900000-0000-4000-8000-000000000010', 'Environment', 1,
	'41900000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('41900000-0000-4000-8000-000000000041', '41900000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'old-kek-1', repeat('8', 64));
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
	job_type, payload, created_by_user_id, status)
values ('41900000-0000-4000-8000-0000000000e2', '41900000-0000-4000-8000-000000000010', '41900000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '41900000-0000-4000-8000-000000000001',
	'queued');
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address, secret_site)
values ('41900000-0000-4000-8000-000000000095', '41900000-0000-4000-8000-000000000010', '41900000-0000-4000-8000-000000000020',
	'b-pays', 'Pays.', 'stripe', repeat('B', 43), 'dashboard.stripe.com');
insert into public.qorpera_event_hook_capture_keys(hook_id, secret_id, broker_authority_id, key_id, public_key)
values ('41900000-0000-4000-8000-000000000095', '41900000-0000-4000-8000-0000000000f5', '41900000-0000-4000-8000-000000000041',
	'old-kek-1', current_setting('qorpera_test.e3c_key1'));
select set_config('session_replication_role', 'origin', true);
-- Its run's binding: the job is the old company's, every other id as Alice's.
select set_config('qorpera_test.b_binding', jsonb_set(current_setting('qorpera_test.base_binding')::jsonb, '{jobId}',
	'"41900000-0000-4000-8000-0000000000e2"')::text, true);

-- Alice's run acknowledges first, as a member's wake requires before any tool (405 §2), and her screen has the browser.
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'e3c-ack') is not null;
select pg_temp.base_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb)
	-> 'capabilities' ? 'browser', 'Alice''s screen has the browser');
reset role;

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.e3c_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.e3c_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- A broker call on a run binding (Alice's by default), with the company's authority by default.
create function pg_temp.e3c_call(p_function text, p_rest text default null, p_binding text default null,
	p_authority text default '41900000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '', true);
	return pg_temp.e3c_try(format('select public.%s(%L, %L, %L::jsonb%s)', p_function, p_authority, p_capability,
		coalesce(p_binding, current_setting('qorpera_test.base_binding')), coalesce(', ' || p_rest, '')));
end $$;
-- A Stripe opening's arguments after the request: the secret's id, the company, the key's id and the capture key ('key1'
-- and 'key2' are the two above).
create function pg_temp.e3c_open_args(p_request jsonb, p_secret text, p_key text default 'key1',
	p_company text default '92400000-0000-4000-8000-000000000010', p_environment text default '92400000-0000-4000-8000-000000000020',
	p_key_id text default 'company-kek-1')
returns text language sql security definer as $$
	select format('%L::jsonb, %L, %L, %L, %L, %L', p_request, '41900000-0000-4000-8000-000000000' || p_secret, p_company,
		p_environment, p_key_id, case when p_key in ('key1', 'key2') then current_setting('qorpera_test.e3c_' || p_key) else p_key end)
$$;
-- A GitHub or HMAC opening's arguments, as 987's.
create function pg_temp.e3c_signed_args(p_request jsonb, p_secret text, p_envelope bytea default '\x0201',
	p_key text default 'company-kek-1')
returns text language sql security definer as $$
	select format('%L::jsonb, %L, %L, %L, %L, %L::bytea, %L', p_request, '41900000-0000-4000-8000-000000000' || p_secret,
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_key, p_envelope,
		encode(extensions.digest(p_envelope, 'sha256'), 'hex'))
$$;
create function pg_temp.e3c_create(p_key text, p_name text, p_more jsonb default '{"proof": "stripe"}') returns jsonb
language sql as $$
	select jsonb_build_object('action', 'create', 'kind', 'hook', 'operationKey', p_key, 'name', p_name,
		'purpose', 'Paid invoices wake the Bookkeeper.') || p_more
$$;
-- The host's manage_hook on Alice's run.
create function pg_temp.e3c_host(p_request jsonb) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.e3c_try(format('select public.qorpera_folder_manage_hook(%L::jsonb, %L::jsonb)',
		current_setting('qorpera_test.base_binding'), p_request));
	reset role;
	return v;
end $$;
-- One vault_capture call's operation envelope, as the computer tool writes it (968's shape), with changes: the call's
-- arguments are for the Stripe hook opened below unless changed.
create function pg_temp.e3c_envelope(p_key text, p_args jsonb default '{}', p_binding jsonb default '{}') returns text
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb) -> 'identity')
			- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'computer_browser', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('kind', 'browser', 'action', 'vault_capture', 'role', 'button', 'name', 'Reveal',
				'hook', current_setting('qorpera_test.e3c_hook', true), 'field', 'signing_secret') || p_args,
			'target', jsonb_build_object('realm', 'company_computer',
				'binding', (current_setting('qorpera_test.office_lease')::jsonb -> 'binding') || p_binding,
				'resources', public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb) -> 'resources')))::text;
end $$;
-- Receipt n ('41900000-0000-4000-8000-0000000001' || n) begins as the computer_browser call of an envelope, and the
-- office admits it; e3c_native begins one under any key and input; e3c_end drains and completes it.
create function pg_temp.e3c_begin(p_n text, p_envelope text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('41900000-0000-4000-8000-0000000001' || p_n)::uuid, 'computer_browser:' || (p_envelope::jsonb #>> '{operation,logicalOperationKey}'),
		encode(extensions.digest(p_envelope, 'sha256'), 'hex'), repeat('e', 64), false);
	perform pg_temp.base_assert(public.qorpera_native_office_operation(current_setting('qorpera_test.base_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb, current_setting('qorpera_test.office_lease')::jsonb, p_envelope, 'begin',
		('41900000-0000-4000-8000-0000000001' || p_n)::uuid, repeat('e', 64)) ->> 'state' = 'admitted',
		'the office admits receipt ' || p_n);
end $$;
create function pg_temp.e3c_native(p_n text, p_key text, p_input text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('41900000-0000-4000-8000-0000000001' || p_n)::uuid, p_key, p_input, repeat('e', 64), false);
end $$;
create function pg_temp.e3c_end(p_n text, p_envelope text, p_office boolean default true) returns void
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	if p_office then
		perform public.qorpera_native_office_operation(current_setting('qorpera_test.base_binding')::jsonb,
			current_setting('qorpera_test.office_scope')::jsonb, current_setting('qorpera_test.office_lease')::jsonb, p_envelope, 'finish',
			('41900000-0000-4000-8000-0000000001' || p_n)::uuid, repeat('e', 64));
	end if;
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('41900000-0000-4000-8000-0000000001' || p_n)::uuid, encode(extensions.digest(p_envelope, 'sha256'), 'hex'), '{}'::jsonb);
end $$;
-- The office's read of receipt n's call, as the service role.
create function pg_temp.e3c_office(p_n text, p_envelope text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.e3c_try(format('select public.qorpera_native_office_hook_capture(%L::jsonb, %L::jsonb, %L::jsonb, %L, %L, %L)',
		current_setting('qorpera_test.base_binding'), current_setting('qorpera_test.office_scope'),
		current_setting('qorpera_test.office_lease'), p_envelope, '41900000-0000-4000-8000-0000000001' || p_n, repeat('e', 64)));
	reset role;
	return v;
end $$;
-- The broker's read (or, with the store's arguments, its store) of receipt n's call.
create function pg_temp.e3c_capture(p_n text, p_envelope text, p_rest text default null,
	p_function text default 'qorpera_folder_read_hook_capture', p_binding text default null,
	p_authority text default '41900000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64),
	p_downstream text default repeat('e', 64))
returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '', true);
	return pg_temp.e3c_try(format('select public.%s(%L, %L, %L::jsonb, %L, %L, %L%s)', p_function, p_authority, p_capability,
		coalesce(p_binding, current_setting('qorpera_test.base_binding')), '41900000-0000-4000-8000-0000000001' || p_n, p_envelope,
		p_downstream, coalesce(', ' || p_rest, '')));
end $$;
-- A store's arguments after the call: the secret, the version, the company, the key's id (the authority's current one by
-- default), the sealed box and its sha-256.
create function pg_temp.e3c_store_args(p_version bigint, p_box bytea default '\x0301', p_secret text default '201',
	p_company text default '92400000-0000-4000-8000-000000000010', p_environment text default '92400000-0000-4000-8000-000000000020',
	p_key_id text default null, p_sha text default null)
returns text language sql security definer as $$
	select format('%L, %L::bigint, %L, %L, %L, %L::bytea, %L', '41900000-0000-4000-8000-000000000' || p_secret, p_version, p_company,
		p_environment, coalesce(p_key_id, (select authority.key_id from public.qorpera_cloud_secret_broker_authorities as authority
			where authority.id = '41900000-0000-4000-8000-000000000040')), p_box,
		coalesce(p_sha, encode(extensions.digest(p_box, 'sha256'), 'hex')))
$$;
create function pg_temp.e3c_counts() returns jsonb language sql security definer as $$
	select jsonb_build_object('hooks', (select count(*) from public.qorpera_event_hooks),
		'live', (select count(*) from public.qorpera_event_hooks where status <> 'removed'),
		'keys', (select count(*) from public.qorpera_event_hook_capture_keys),
		'secrets', (select count(*) from public.qorpera_cloud_secrets where status = 'active'),
		'versions', (select count(*) from public.qorpera_cloud_secret_versions),
		'events', (select count(*) from public.qorpera_cloud_secret_audit_events),
		'receipts', (select count(*) from public.qorpera_run_operation_receipts),
		'marks', (select count(*) from public.qorpera_folder_connection_file_marks))
$$;
create function pg_temp.e3c_delta(p_after jsonb, p_before jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(a.key, a.value::text::bigint - (p_before ->> a.key)::bigint)
		filter (where a.value::text::bigint <> (p_before ->> a.key)::bigint), '{}'::jsonb)
	from jsonb_each(p_after) as a
$$;
grant execute on function pg_temp.e3c_try(text), pg_temp.e3c_answer(text), pg_temp.e3c_call(text, text, text, text, text),
	pg_temp.e3c_open_args(jsonb, text, text, text, text, text), pg_temp.e3c_signed_args(jsonb, text, bytea, text),
	pg_temp.e3c_create(text, text, jsonb), pg_temp.e3c_capture(text, text, text, text, text, text, text, text),
	pg_temp.e3c_store_args(bigint, bytea, text, text, text, text, text), pg_temp.e3c_counts(), pg_temp.e3c_delta(jsonb, jsonb)
	to qorpera_secret_broker;
grant execute on function pg_temp.e3c_try(text) to service_role;

-- 1. The broker opens a Stripe hook with its capture key, and a GitHub hook as before --------------------------------------

set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_c0', pg_temp.e3c_counts()::text, true);
select set_config('qorpera_test.e3c_stripe', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
	pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-open-stripe', 'stripe-pays'), '201')), true);
select set_config('qorpera_test.e3c_c1', pg_temp.e3c_counts()::text, true);
-- The same call again (Stripe's site named, another id and key): the first answer, and nothing stored.
select set_config('qorpera_test.e3c_replay', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
	pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-open-stripe', 'stripe-pays', '{"proof": "stripe", "site": "dashboard.stripe.com"}'),
		'202', 'key2')), true);
select set_config('qorpera_test.e3c_c2', pg_temp.e3c_counts()::text, true);
select set_config('qorpera_test.e3c_github', pg_temp.e3c_call('qorpera_folder_open_signed_hook',
	pg_temp.e3c_signed_args(pg_temp.e3c_create('e3c-open-github', 'repo-pushes', '{"proof": "github"}'), '203')), true);
select set_config('qorpera_test.e3c_c3', pg_temp.e3c_counts()::text, true);
-- Every refusal, each a new operation key: the site, the capture key, the proof on the other path, a taken secret id, a
-- taken name, the envelope's company, a company that is not on the company folder, another company's authority.
select set_config('qorpera_test.e3c_1x', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from expected), ''), true)
from (values
	('site', pg_temp.e3c_call('qorpera_folder_open_stripe_hook', pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-site', 'stripe-r',
		'{"proof": "stripe", "site": "stripe.com"}'), '202')), '22023:A Stripe hook''s secret is taken from dashboard.stripe.com'),
	('key: no secret id', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-key', 'stripe-r'), null)), '42501:hook capture key is unavailable'),
	('key: none', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-key', 'stripe-r'), '202', null)), '42501:hook capture key is unavailable'),
	('key: text', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-key', 'stripe-r'), '202', 'not a key')), '42501:hook capture key is unavailable'),
	('key: zero', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-key', 'stripe-r'), '202', repeat('A', 43))),
		'42501:hook capture key is unavailable'),
	('key: another key id', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-key', 'stripe-r'), '202', 'key1', '92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000020', 'company-kek-2')), '42501:hook capture key is unavailable'),
	('path: Stripe with an envelope', pg_temp.e3c_call('qorpera_folder_open_signed_hook',
		pg_temp.e3c_signed_args(pg_temp.e3c_create('e3c-r-key', 'stripe-r'), '202')), '42501:hook capture key is unavailable'),
	('path: GitHub with a capture key', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-github', 'repo-r', '{"proof": "github"}'), '202')),
		'42501:hook secret envelope is unavailable'),
	('taken: GitHub on the Stripe hook''s id', pg_temp.e3c_call('qorpera_folder_open_signed_hook',
		pg_temp.e3c_signed_args(pg_temp.e3c_create('e3c-r-github', 'repo-r', '{"proof": "github"}'), '201')),
		'42501:hook secret id is taken'),
	('taken: Stripe on the Stripe hook''s id', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-taken', 'stripe-r'), '201')), '42501:hook secret id is taken'),
	('taken: Stripe on the GitHub secret', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-taken', 'stripe-r'), '203')), '42501:hook secret id is taken'),
	('taken: the name', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-name', 'stripe-pays'), '202')), '23505:A hook with this name already exists'),
	('envelope: another company', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-company', 'stripe-r'), '202', 'key1', '41900000-0000-4000-8000-000000000010')),
		'42501:hook secret envelope is unavailable'),
	('envelope: another environment', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-company', 'stripe-r'), '202', 'key1', '92400000-0000-4000-8000-000000000010',
			'41900000-0000-4000-8000-000000000020')), '42501:hook secret envelope is unavailable'),
	('old core', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-old', 'stripe-r'), '202', 'key1', '41900000-0000-4000-8000-000000000010',
			'41900000-0000-4000-8000-000000000020', 'old-kek-1'), current_setting('qorpera_test.b_binding'),
		'41900000-0000-4000-8000-000000000041', repeat('8', 64)), '0A000:Hooks need a company on the company folder'),
	('another company''s authority', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-r-other', 'stripe-r'), '202'), null, '41900000-0000-4000-8000-000000000041',
		repeat('8', 64)), '42501:cloud secret broker does not serve this company')
) as call(name, got, expected);
reset session authorization;
select set_config('qorpera_test.e3c_host_stripe', pg_temp.e3c_host(pg_temp.e3c_create('e3c-r-host', 'stripe-host')), true);
select set_config('qorpera_test.e3c_c4', pg_temp.e3c_counts()::text, true);

do $$
declare
	v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_stripe jsonb := pg_temp.e3c_answer(current_setting('qorpera_test.e3c_stripe'));
	v_github jsonb := pg_temp.e3c_answer(current_setting('qorpera_test.e3c_github'));
	h public.qorpera_event_hooks%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_key public.qorpera_event_hook_capture_keys%rowtype;
begin
	-- The Stripe hook: the answer (no URL is set), the receipt, the row, its capture key, and no secret yet.
	select * into h from public.qorpera_event_hooks where id = (v_stripe #>> '{hook,id}')::uuid;
	select * into v_receipt from public.qorpera_run_operation_receipts
	where run_id = v_run and logical_operation_key = 'hook:e3c-open-stripe';
	perform pg_temp.base_assert(h.id is not null and v_stripe = jsonb_build_object('schema', 'qorpera.agent-hook-receipt/v1',
			'runId', v_run, 'receiptId', v_receipt.id, 'action', 'create', 'hook', public.qorpera_event_hook_descriptor(h, true),
			'secretSite', 'dashboard.stripe.com'),
		'1: the Stripe hook''s answer: ' || current_setting('qorpera_test.e3c_stripe'));
	perform pg_temp.base_assert(v_receipt.status = 'completed'
			and v_receipt.result = v_stripe || jsonb_build_object('hook', public.qorpera_event_hook_descriptor(h, false)),
		'1: the receipt keeps the answer without the address: ' || coalesce(v_receipt.result::text, 'none'));
	perform pg_temp.base_assert(v_stripe #> '{hook,signingSecret}' = jsonb_build_object('connectorId', 'event_hook',
			'secretName', 'h' || replace(h.id::text, '-', ''), 'ready', false),
		'1: nothing is taken yet: ' || coalesce(v_stripe #>> '{hook,signingSecret}', 'none'));
	perform pg_temp.base_assert(h.name = 'stripe-pays' and h.proof = 'stripe' and h.secret_site = 'dashboard.stripe.com'
			and h.created_by_staff_agent_id = '92400000-0000-4000-8000-000000000030' and h.created_by_user_id is null
			and h.max_body_bytes = 65536 and h.per_minute = 60 and h.status = 'active'
			and h.purpose = 'Paid invoices wake the Bookkeeper.',
		'1: the Stripe hook''s row');
	select * into v_key from public.qorpera_event_hook_capture_keys where hook_id = h.id;
	perform pg_temp.base_assert(v_key.secret_id = '41900000-0000-4000-8000-000000000201'
			and v_key.broker_authority_id = '41900000-0000-4000-8000-000000000040' and v_key.key_id = 'company-kek-1'
			and v_key.public_key = current_setting('qorpera_test.e3c_key1'),
		'1: the hook''s capture key');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_cloud_secrets
				where id = '41900000-0000-4000-8000-000000000201')
			and not exists (select 1 from public.qorpera_cloud_secret_audit_events
				where secret_id = '41900000-0000-4000-8000-000000000201'),
		'1: a Stripe hook has no secret before a capture');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_connection_file_marks
			where subject_kind = 'hook' and secret_id = h.id), '1: the hook''s connection file is marked');
	perform pg_temp.base_assert(pg_temp.e3c_delta(current_setting('qorpera_test.e3c_c1')::jsonb,
			current_setting('qorpera_test.e3c_c0')::jsonb) = '{"hooks": 1, "live": 1, "keys": 1, "receipts": 1, "marks": 1}',
		'1: the opening stores ' || pg_temp.e3c_delta(current_setting('qorpera_test.e3c_c1')::jsonb,
			current_setting('qorpera_test.e3c_c0')::jsonb)::text);
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_replay') = current_setting('qorpera_test.e3c_stripe')
			and current_setting('qorpera_test.e3c_c2') = current_setting('qorpera_test.e3c_c1'),
		'1: a replay answers from the receipt and stores nothing: ' || current_setting('qorpera_test.e3c_replay'));
	-- The GitHub hook opens as before, its secret made in the same step.
	perform pg_temp.base_assert(v_github #>> '{hook,signingSecret,ready}' = 'true'
			and pg_temp.e3c_delta(current_setting('qorpera_test.e3c_c3')::jsonb, current_setting('qorpera_test.e3c_c2')::jsonb)
				= '{"hooks": 1, "live": 1, "secrets": 1, "versions": 1, "events": 1, "receipts": 1, "marks": 1}',
		'1: a GitHub hook opens as before: ' || current_setting('qorpera_test.e3c_github'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_1x') = '',
		E'1: refusals that differ:\n' || current_setting('qorpera_test.e3c_1x'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_host_stripe') = '0A000:A signed hook is opened through the vault',
		'1: the host opens no Stripe hook: ' || current_setting('qorpera_test.e3c_host_stripe'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_c4') = current_setting('qorpera_test.e3c_c3'),
		'1: a refusal stored ' || pg_temp.e3c_delta(current_setting('qorpera_test.e3c_c4')::jsonb,
			current_setting('qorpera_test.e3c_c3')::jsonb)::text);
	perform set_config('qorpera_test.e3c_hook', h.id::text, true);
	perform set_config('qorpera_test.e3c_github_hook', v_github #>> '{hook,id}', true);
end $$;

-- 2. The broker describes the capture key, and replaces it while nothing was taken under it -------------------------------

set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_key', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
	quote_literal(current_setting('qorpera_test.e3c_hook'))), true);
select set_config('qorpera_test.e3c_2x', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from expected), ''), true)
from (values
	('describe: a GitHub hook', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
		quote_literal(current_setting('qorpera_test.e3c_github_hook'))), '0A000:This hook takes no secret from a page'),
	('describe: no hook', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
		quote_literal('41900000-0000-4000-8000-000000000999')), 'P0002:No hook has this id'),
	('describe: another company''s hook', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
		quote_literal('41900000-0000-4000-8000-000000000095')), 'P0002:No hook has this id'),
	('describe: old core', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
		quote_literal('41900000-0000-4000-8000-000000000095'), current_setting('qorpera_test.b_binding'),
		'41900000-0000-4000-8000-000000000041', repeat('8', 64)), '0A000:Hooks need a company on the company folder'),
	('describe: another company''s authority', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
		quote_literal(current_setting('qorpera_test.e3c_hook')), null, '41900000-0000-4000-8000-000000000041', repeat('8', 64)),
		'42501:cloud secret broker does not serve this company'),
	('describe: a malformed binding', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
		quote_literal(current_setting('qorpera_test.e3c_hook')), '[]'), '22023:hook run binding is malformed'),
	('replace: another key id', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
		format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-2', current_setting('qorpera_test.e3c_key2'))),
		'42501:hook capture key is unavailable'),
	('replace: no key', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
		format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-1', 'not a key')),
		'42501:hook capture key is unavailable'),
	('replace: a GitHub hook', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
		format('%L, %L, %L', current_setting('qorpera_test.e3c_github_hook'), 'company-kek-1', current_setting('qorpera_test.e3c_key2'))),
		'0A000:This hook takes no secret from a page'),
	('replace: another company''s hook', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
		format('%L, %L, %L', '41900000-0000-4000-8000-000000000095', 'company-kek-1', current_setting('qorpera_test.e3c_key2'))),
		'P0002:No hook has this id')
) as call(name, got, expected);
select set_config('qorpera_test.e3c_same', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-1', current_setting('qorpera_test.e3c_key1'))), true);
reset session authorization;

do $$
declare v_key jsonb := jsonb_build_object('schema', 'qorpera.event-hook-capture-key/v1',
	'hookId', current_setting('qorpera_test.e3c_hook'), 'secretId', '41900000-0000-4000-8000-000000000201',
	'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', '92400000-0000-4000-8000-000000000020',
	'keyId', 'company-kek-1');
begin
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_key')) = v_key || '{"current": true}',
		'2: the capture key is current: ' || current_setting('qorpera_test.e3c_key'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_2x') = '',
		E'2: refusals that differ:\n' || current_setting('qorpera_test.e3c_2x'));
	-- The same key again is no change.
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_same'))
			= v_key || '{"current": true, "replaced": false}'
			and not exists (select 1 from public.qorpera_cloud_secret_audit_events where event_type = 'hook_capture_key_replaced'),
		'2: the same key is not replaced: ' || current_setting('qorpera_test.e3c_same'));
end $$;

-- A new key while nothing was taken: the key is replaced, with one audit row of the reserved id and no version.
savepoint e3c_replace;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_replaced', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-1', current_setting('qorpera_test.e3c_key2'))), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_replaced')) #>> '{replaced}' = 'true'
			and (select public_key from public.qorpera_event_hook_capture_keys
				where hook_id = current_setting('qorpera_test.e3c_hook')::uuid) = current_setting('qorpera_test.e3c_key2')
			and (select count(*) from public.qorpera_cloud_secret_audit_events
				where event_type = 'hook_capture_key_replaced' and secret_id = '41900000-0000-4000-8000-000000000201'
					and secret_version is null and receipt_id is null and connector_id = 'event_hook'
					and run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
					and actor_user_id = '92400000-0000-4000-8000-000000000001') = 1,
		'2: a new key replaces the old: ' || current_setting('qorpera_test.e3c_replaced'));
end $$;
rollback to savepoint e3c_replace;


-- 3. The office's read refuses a call that is not a vault_capture of a live Stripe hook of the run's company --------------

select set_config('qorpera_test.e3c_env21', pg_temp.e3c_envelope('e3c-21',
	'{"action": "vault_fill", "role": "textbox", "name": "Signing secret"}'), true);
select pg_temp.e3c_begin('21', current_setting('qorpera_test.e3c_env21'));
select set_config('qorpera_test.e3c_office21', pg_temp.e3c_office('21', current_setting('qorpera_test.e3c_env21')), true);
select pg_temp.e3c_end('21', current_setting('qorpera_test.e3c_env21'));
select set_config('qorpera_test.e3c_env22', pg_temp.e3c_envelope('e3c-22',
	jsonb_build_object('hook', current_setting('qorpera_test.e3c_github_hook'))), true);
select pg_temp.e3c_begin('22', current_setting('qorpera_test.e3c_env22'));
select set_config('qorpera_test.e3c_office22', pg_temp.e3c_office('22', current_setting('qorpera_test.e3c_env22')), true);
select pg_temp.e3c_end('22', current_setting('qorpera_test.e3c_env22'));
select set_config('qorpera_test.e3c_env23', pg_temp.e3c_envelope('e3c-23',
	'{"hook": "41900000-0000-4000-8000-000000000999"}'), true);
select pg_temp.e3c_begin('23', current_setting('qorpera_test.e3c_env23'));
select set_config('qorpera_test.e3c_office23', pg_temp.e3c_office('23', current_setting('qorpera_test.e3c_env23')), true);
select pg_temp.e3c_end('23', current_setting('qorpera_test.e3c_env23'));
select set_config('qorpera_test.e3c_env24', pg_temp.e3c_envelope('e3c-24',
	'{"hook": "41900000-0000-4000-8000-000000000095"}'), true);
select pg_temp.e3c_begin('24', current_setting('qorpera_test.e3c_env24'));
select set_config('qorpera_test.e3c_office24', pg_temp.e3c_office('24', current_setting('qorpera_test.e3c_env24')), true);
select pg_temp.e3c_end('24', current_setting('qorpera_test.e3c_env24'));
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_office21') = '42501:Invalid office hook capture'
			and current_setting('qorpera_test.e3c_office22') = '0A000:This hook takes no secret from a page'
			and current_setting('qorpera_test.e3c_office23') = 'P0002:No hook has this id'
			and current_setting('qorpera_test.e3c_office24') = 'P0002:No hook has this id',
		'3: the office''s refusals: ' || concat_ws(' / ', current_setting('qorpera_test.e3c_office21'),
			current_setting('qorpera_test.e3c_office22'), current_setting('qorpera_test.e3c_office23'),
			current_setting('qorpera_test.e3c_office24')));
end $$;


-- 4. The first capture: the office's read, the broker's read, the store and its replay ------------------------------------

select set_config('qorpera_test.e3c_env11', pg_temp.e3c_envelope('e3c-11'), true);
select pg_temp.e3c_begin('11', current_setting('qorpera_test.e3c_env11'));
select set_config('qorpera_test.e3c_target11', pg_temp.e3c_office('11', current_setting('qorpera_test.e3c_env11')), true);
select set_config('qorpera_test.e3c_c10', pg_temp.e3c_counts()::text, true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_read11', pg_temp.e3c_capture('11', current_setting('qorpera_test.e3c_env11')), true);
select set_config('qorpera_test.e3c_store11', pg_temp.e3c_capture('11', current_setting('qorpera_test.e3c_env11'),
	pg_temp.e3c_store_args(1), 'qorpera_folder_store_hook_capture'), true);
select set_config('qorpera_test.e3c_c11', pg_temp.e3c_counts()::text, true);
-- The same store again answers from the audit row and stores nothing.
select set_config('qorpera_test.e3c_again11', pg_temp.e3c_capture('11', current_setting('qorpera_test.e3c_env11'),
	pg_temp.e3c_store_args(1), 'qorpera_folder_store_hook_capture'), true);
select set_config('qorpera_test.e3c_reread11', pg_temp.e3c_capture('11', current_setting('qorpera_test.e3c_env11')), true);
select set_config('qorpera_test.e3c_c12', pg_temp.e3c_counts()::text, true);
reset session authorization;
select pg_temp.e3c_end('11', current_setting('qorpera_test.e3c_env11'));

do $$
declare
	v_hook public.qorpera_event_hooks%rowtype;
	v_office uuid := (current_setting('qorpera_test.office_lease')::jsonb #>> '{binding,companyComputerId}')::uuid;
	v_generation bigint;
	v_read jsonb;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
begin
	select * into v_hook from public.qorpera_event_hooks where id = current_setting('qorpera_test.e3c_hook')::uuid;
	select generation into v_generation from public.qorpera_runtime_offices where id = v_office;
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_target11')) = jsonb_build_object(
			'schema', 'qorpera.event-hook-capture-target/v1', 'hookId', v_hook.id, 'address', v_hook.address,
			'site', 'dashboard.stripe.com', 'companyId', '92400000-0000-4000-8000-000000000010', 'companyComputerId', v_office,
			'computerGeneration', v_generation, 'receiptId', '41900000-0000-4000-8000-000000000111', 'field', 'signing_secret',
			'capturePublicKey', current_setting('qorpera_test.e3c_key1')),
		'4: the office''s read: ' || current_setting('qorpera_test.e3c_target11'));
	v_read := jsonb_build_object('schema', 'qorpera.event-hook-capture-context/v1', 'hookId', v_hook.id,
		'secretId', '41900000-0000-4000-8000-000000000201', 'version', 1, 'companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', '92400000-0000-4000-8000-000000000020', 'keyId', 'company-kek-1',
		'capturePublicKey', current_setting('qorpera_test.e3c_key1'), 'receiptId', '41900000-0000-4000-8000-000000000111',
		'field', 'signing_secret', 'companyComputerId', v_office, 'computerGeneration', v_generation);
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_read11')) = v_read,
		'4: the broker''s read: ' || current_setting('qorpera_test.e3c_read11'));
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_store11')) = jsonb_build_object(
			'schema', 'qorpera.event-hook-capture-stored/v1', 'hookId', v_hook.id,
			'secretId', '41900000-0000-4000-8000-000000000201', 'version', 1, 'replayed', false)
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_again11')) = jsonb_build_object(
			'schema', 'qorpera.event-hook-capture-stored/v1', 'hookId', v_hook.id,
			'secretId', '41900000-0000-4000-8000-000000000201', 'version', 1, 'replayed', true),
		'4: the store and its replay: ' || current_setting('qorpera_test.e3c_store11') || ' / '
			|| current_setting('qorpera_test.e3c_again11'));
	-- After the store the read names the next version, the current one and what this call stored.
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_reread11')) = v_read
			|| jsonb_build_object('version', 2, 'current', jsonb_build_object('version', 1, 'keyId', 'company-kek-1',
				'encryptedEnvelopeBase64', 'AwE=', 'envelopeSha256', encode(extensions.digest('\x0301'::bytea, 'sha256'), 'hex')),
				'captured', jsonb_build_object('version', 1)),
		'4: the read after the store: ' || current_setting('qorpera_test.e3c_reread11'));
	-- The secret: the company's, bound to the hook by name, made by the run's requester; version 1 the box under this
	-- authority's key; one audit row of the call's receipt.
	select * into v_secret from public.qorpera_cloud_secrets where id = '41900000-0000-4000-8000-000000000201';
	perform pg_temp.base_assert(v_secret.profile_id = '92400000-0000-4000-8000-000000000010'
			and v_secret.environment_id = '92400000-0000-4000-8000-000000000020'
			and v_secret.broker_authority_id = '41900000-0000-4000-8000-000000000040' and v_secret.owner_kind = 'company'
			and v_secret.owner_user_id is null and v_secret.connector_id = 'event_hook'
			and v_secret.secret_name = 'h' || replace(v_hook.id::text, '-', '') and v_secret.purpose = v_hook.purpose
			and v_secret.current_version = 1 and v_secret.status = 'active'
			and v_secret.created_by_user_id = '92400000-0000-4000-8000-000000000001'
			and (public.qorpera_event_hook_secret(v_hook)).id = v_secret.id,
		'4: the hook''s secret');
	select * into v_version from public.qorpera_cloud_secret_versions where secret_id = v_secret.id;
	perform pg_temp.base_assert(v_version.version = 1 and v_version.broker_authority_id = '41900000-0000-4000-8000-000000000040'
			and v_version.key_id = 'company-kek-1' and v_version.encrypted_envelope = '\x0301'::bytea
			and v_version.envelope_sha256 = encode(extensions.digest('\x0301'::bytea, 'sha256'), 'hex')
			and v_version.created_by_user_id = '92400000-0000-4000-8000-000000000001',
		'4: the secret''s version');
	perform pg_temp.base_assert((select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
				where secret_id = v_secret.id) = array['hook_secret_captured']
			and exists (select 1 from public.qorpera_cloud_secret_audit_events where secret_id = v_secret.id
				and secret_version = 1 and receipt_id = '41900000-0000-4000-8000-000000000111'
				and run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
				and actor_user_id = '92400000-0000-4000-8000-000000000001' and connector_id = 'event_hook'),
		'4: the secret''s audit row');
	perform pg_temp.base_assert(pg_temp.e3c_delta(current_setting('qorpera_test.e3c_c11')::jsonb,
			current_setting('qorpera_test.e3c_c10')::jsonb) = '{"secrets": 1, "versions": 1, "events": 1}'
			and current_setting('qorpera_test.e3c_c12') = current_setting('qorpera_test.e3c_c11'),
		'4: the store stores ' || pg_temp.e3c_delta(current_setting('qorpera_test.e3c_c11')::jsonb,
			current_setting('qorpera_test.e3c_c10')::jsonb)::text);
end $$;

-- 5. The second capture: only the next version stores, and a finished receipt reads nothing ----------------------------

select set_config('qorpera_test.e3c_env12', pg_temp.e3c_envelope('e3c-12'), true);
select pg_temp.e3c_begin('12', current_setting('qorpera_test.e3c_env12'));
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_5x', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from expected), ''), true)
from (values
	('store: the version taken', pg_temp.e3c_capture('12', current_setting('qorpera_test.e3c_env12'),
		pg_temp.e3c_store_args(1, '\x0302'), 'qorpera_folder_store_hook_capture'), '40003:hook secret capture outcome is unconfirmed'),
	('store: a version skipped', pg_temp.e3c_capture('12', current_setting('qorpera_test.e3c_env12'),
		pg_temp.e3c_store_args(3, '\x0302'), 'qorpera_folder_store_hook_capture'), '40003:hook secret capture outcome is unconfirmed'),
	('read: a finished receipt', pg_temp.e3c_capture('11', current_setting('qorpera_test.e3c_env11')),
		'42501:hook secret capture receipt is unavailable'),
	('store: a finished receipt', pg_temp.e3c_capture('11', current_setting('qorpera_test.e3c_env11'),
		pg_temp.e3c_store_args(2, '\x0302'), 'qorpera_folder_store_hook_capture'), '42501:hook secret capture receipt is unavailable')
) as call(name, got, expected);
select set_config('qorpera_test.e3c_store12', pg_temp.e3c_capture('12', current_setting('qorpera_test.e3c_env12'),
	pg_temp.e3c_store_args(2, '\x0302'), 'qorpera_folder_store_hook_capture'), true);
select set_config('qorpera_test.e3c_reread12', pg_temp.e3c_capture('12', current_setting('qorpera_test.e3c_env12')), true);
reset session authorization;
select pg_temp.e3c_end('12', current_setting('qorpera_test.e3c_env12'));

do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_5x') = '',
		E'5: refusals that differ:\n' || current_setting('qorpera_test.e3c_5x'));
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_store12')) #>> '{version}' = '2'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_store12')) #>> '{replayed}' = 'false'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_reread12')) #> '{current}' = jsonb_build_object('version', 2,
				'keyId', 'company-kek-1', 'encryptedEnvelopeBase64', 'AwI=',
				'envelopeSha256', encode(extensions.digest('\x0302'::bytea, 'sha256'), 'hex'))
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_reread12')) #> '{captured}' = '{"version": 2}'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_reread12')) #>> '{version}' = '3',
		'5: the second capture: ' || current_setting('qorpera_test.e3c_store12') || ' / ' || current_setting('qorpera_test.e3c_reread12'));
	perform pg_temp.base_assert((select current_version from public.qorpera_cloud_secrets
				where id = '41900000-0000-4000-8000-000000000201') = 2
			and (select array_agg(version order by version) from public.qorpera_cloud_secret_versions
				where secret_id = '41900000-0000-4000-8000-000000000201') = array[1, 2]::bigint[]
			and (select array_agg(receipt_id::text order by secret_version) from public.qorpera_cloud_secret_audit_events
				where secret_id = '41900000-0000-4000-8000-000000000201' and event_type = 'hook_secret_captured')
				= array['41900000-0000-4000-8000-000000000111', '41900000-0000-4000-8000-000000000112'],
		'5: the secret is at version 2');
end $$;

-- 6. The company's key turns: the capture key must be made again, and is replaced once per key --------------------------

set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_6a', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-1', current_setting('qorpera_test.e3c_key1'))), true);
select set_config('qorpera_test.e3c_6b', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-1', current_setting('qorpera_test.e3c_key2'))), true);
reset session authorization;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_cloud_secret_broker_authorities set key_id = 'company-kek-2'
where id = '41900000-0000-4000-8000-000000000040';
select set_config('session_replication_role', 'origin', true);

select set_config('qorpera_test.e3c_env13', pg_temp.e3c_envelope('e3c-13'), true);
select pg_temp.e3c_begin('13', current_setting('qorpera_test.e3c_env13'));
select set_config('qorpera_test.e3c_office13a', pg_temp.e3c_office('13', current_setting('qorpera_test.e3c_env13')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_6c', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key',
	quote_literal(current_setting('qorpera_test.e3c_hook'))), true);
select set_config('qorpera_test.e3c_6d', pg_temp.e3c_capture('13', current_setting('qorpera_test.e3c_env13')), true);
select set_config('qorpera_test.e3c_6e', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-1', current_setting('qorpera_test.e3c_key2'))), true);
select set_config('qorpera_test.e3c_6f', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-2', current_setting('qorpera_test.e3c_key2'))), true);
reset session authorization;
select set_config('qorpera_test.e3c_office13b', pg_temp.e3c_office('13', current_setting('qorpera_test.e3c_env13')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_read13', pg_temp.e3c_capture('13', current_setting('qorpera_test.e3c_env13')), true);
select set_config('qorpera_test.e3c_store13', pg_temp.e3c_capture('13', current_setting('qorpera_test.e3c_env13'),
	pg_temp.e3c_store_args(3, '\x0303'), 'qorpera_folder_store_hook_capture'), true);
select set_config('qorpera_test.e3c_6g', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-2', current_setting('qorpera_test.e3c_key1'))), true);
select set_config('qorpera_test.e3c_6h', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
	format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-2', current_setting('qorpera_test.e3c_key2'))), true);
reset session authorization;
select pg_temp.e3c_end('13', current_setting('qorpera_test.e3c_env13'));

do $$
declare
	v_taken text := '55000:This hook''s secret was already taken under the current key';
	v_again text := '55000:The hook''s capture key must be made again';
begin
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_6a')) #>> '{replaced}' = 'false'
			and current_setting('qorpera_test.e3c_6b') = v_taken,
		'6: under the first key: ' || current_setting('qorpera_test.e3c_6a') || ' / ' || current_setting('qorpera_test.e3c_6b'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_office13a') = v_again
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_6c')) #>> '{current}' = 'false'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_6c')) #>> '{keyId}' = 'company-kek-2'
			and current_setting('qorpera_test.e3c_6d') = v_again
			and current_setting('qorpera_test.e3c_6e') = '42501:hook capture key is unavailable',
		'6: a turned key: ' || concat_ws(' / ', current_setting('qorpera_test.e3c_office13a'),
			current_setting('qorpera_test.e3c_6c'), current_setting('qorpera_test.e3c_6d'), current_setting('qorpera_test.e3c_6e')));
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_6f')) #>> '{replaced}' = 'true'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_6f')) #>> '{keyId}' = 'company-kek-2'
			and (select count(*) from public.qorpera_cloud_secret_audit_events
				where event_type = 'hook_capture_key_replaced' and secret_id = '41900000-0000-4000-8000-000000000201') = 1
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_office13b')) #>> '{capturePublicKey}'
				= current_setting('qorpera_test.e3c_key2'),
		'6: the new capture key: ' || current_setting('qorpera_test.e3c_6f') || ' / ' || current_setting('qorpera_test.e3c_office13b'));
	-- The current version is under the old key: the broker is not given it.
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_read13')) #>> '{version}' = '3'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_read13')) #>> '{keyId}' = 'company-kek-2'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_read13')) #>> '{capturePublicKey}'
				= current_setting('qorpera_test.e3c_key2')
			and not pg_temp.e3c_answer(current_setting('qorpera_test.e3c_read13')) ?| array['current', 'captured'],
		'6: the read under the new key: ' || current_setting('qorpera_test.e3c_read13'));
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_store13')) #>> '{version}' = '3'
			and (select key_id from public.qorpera_cloud_secret_versions
				where secret_id = '41900000-0000-4000-8000-000000000201' and version = 3) = 'company-kek-2'
			and current_setting('qorpera_test.e3c_6g') = v_taken
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_6h')) #>> '{replaced}' = 'false',
		'6: under the new key: ' || concat_ws(' / ', current_setting('qorpera_test.e3c_store13'),
			current_setting('qorpera_test.e3c_6g'), current_setting('qorpera_test.e3c_6h')));
end $$;

-- 7. A paused hook still takes its secret; every other call is refused, and refuses before it stores -----------------------

select set_config('qorpera_test.e3c_pause', pg_temp.e3c_host(
	'{"action": "pause", "hook": "stripe-pays", "operationKey": "e3c-pause"}'), true);
select set_config('qorpera_test.e3c_env14', pg_temp.e3c_envelope('e3c-14'), true);
select pg_temp.e3c_begin('14', current_setting('qorpera_test.e3c_env14'));
select set_config('qorpera_test.e3c_office14', pg_temp.e3c_office('14', current_setting('qorpera_test.e3c_env14')), true);
-- The call with one field set.
create function pg_temp.e3c_env14(p_path text[], p_value jsonb) returns text language sql as $$
	select jsonb_set(current_setting('qorpera_test.e3c_env14')::jsonb, p_path, p_value)::text
$$;
grant execute on function pg_temp.e3c_env14(text[], jsonb) to qorpera_secret_broker;
select set_config('qorpera_test.e3c_c13', pg_temp.e3c_counts()::text, true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_read14', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14')), true);
select set_config('qorpera_test.e3c_7x', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from expected), ''), true)
from (values
	('call: none', pg_temp.e3c_capture('14', null), '22023:hook secret capture call is malformed'),
	('call: not json', pg_temp.e3c_capture('14', 'not json'), '22023:hook secret capture call is malformed'),
	('call: an array', pg_temp.e3c_capture('14', '[]'), '22023:hook secret capture call is malformed'),
	('call: schema', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{schema}', '"qorpera.cloud-tool-operation/v1"')),
		'22023:hook secret capture call is malformed'),
	('call: tool', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,tool}', '"computer_type"')),
		'22023:hook secret capture call is malformed'),
	('call: tool version', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,toolVersion}',
		'"qorpera.company-computer-tools/v1"')), '22023:hook secret capture call is malformed'),
	('call: realm', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,target,realm}', '"company"')),
		'22023:hook secret capture call is malformed'),
	('call: field', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,field}', '"password"')),
		'22023:hook secret capture call is malformed'),
	('call: role', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,role}', '"spinbutton"')),
		'22023:hook secret capture call is malformed'),
	('call: another argument', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,text}', '"x"')),
		'22023:hook secret capture call is malformed'),
	('call: hook not an id', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,hook}', '"not-a-uuid"')),
		'22023:hook secret capture call is malformed'),
	('call: hook in capitals', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,hook}',
		to_jsonb(upper(current_setting('qorpera_test.e3c_hook'))))), '22023:hook secret capture call is malformed'),
	('call: no computer', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,target,binding,companyComputerId}', 'null')),
		'22023:hook secret capture call is malformed'),
	('call: generation 0', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,target,binding,computerGeneration}', '0')),
		'22023:hook secret capture call is malformed'),
	('call: too long', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14') || repeat(' ', 65536)),
		'22023:hook secret capture call is malformed'),
	('hook: GitHub', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,hook}',
		to_jsonb(current_setting('qorpera_test.e3c_github_hook')))), '0A000:This hook takes no secret from a page'),
	('hook: none', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,hook}',
		'"41900000-0000-4000-8000-000000000999"')), 'P0002:No hook has this id'),
	('hook: another company''s', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,arguments,hook}',
		'"41900000-0000-4000-8000-000000000095"')), 'P0002:No hook has this id'),
	('lease: another generation', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,target,binding,computerGeneration}',
		'99')), '42501:company computer lease is unavailable'),
	('lease: another screen', pg_temp.e3c_capture('14', pg_temp.e3c_env14('{operation,target,binding,screenId}',
		'"41900000-0000-4000-8000-000000000999"')), '42501:company computer lease is unavailable'),
	('run: old core', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), null,
		'qorpera_folder_read_hook_capture', current_setting('qorpera_test.b_binding'), '41900000-0000-4000-8000-000000000041',
		repeat('8', 64)), '0A000:Hooks need a company on the company folder'),
	('authority: none', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), null,
		'qorpera_folder_read_hook_capture', null, '41900000-0000-4000-8000-000000000049'),
		'42501:cloud secret broker authority is unavailable'),
	('authority: another capability', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), null,
		'qorpera_folder_read_hook_capture', null, '41900000-0000-4000-8000-000000000040', repeat('8', 64)),
		'42501:cloud secret broker authority is unavailable'),
	('authority: no capability', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), null,
		'qorpera_folder_read_hook_capture', null, '41900000-0000-4000-8000-000000000040', null),
		'42501:cloud secret broker authority is unavailable'),
	('authority: another company''s', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), null,
		'qorpera_folder_read_hook_capture', null, '41900000-0000-4000-8000-000000000041', repeat('8', 64)),
		'42501:cloud secret broker does not serve this company'),
	('receipt: never begun', pg_temp.e3c_capture('19', current_setting('qorpera_test.e3c_env14')),
		'42501:hook secret capture receipt is unavailable'),
	('receipt: another call''s', pg_temp.e3c_capture('11', current_setting('qorpera_test.e3c_env14')),
		'42501:hook secret capture receipt is unavailable'),
	('receipt: another downstream key', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), null,
		'qorpera_folder_read_hook_capture', null, '41900000-0000-4000-8000-000000000040', repeat('9', 64), repeat('c', 64)),
		'42501:hook secret capture receipt is unavailable'),
	('receipt: a downstream key in capitals', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), null,
		'qorpera_folder_read_hook_capture', null, '41900000-0000-4000-8000-000000000040', repeat('9', 64), repeat('E', 64)),
		'42501:hook secret capture receipt is unavailable'),
	('store: another secret', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(4, '\x0304', '202'), 'qorpera_folder_store_hook_capture'), '42501:hook secret envelope is unavailable'),
	('store: another company', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(4, '\x0304', '201', '92400000-0000-4000-8000-000000000011'), 'qorpera_folder_store_hook_capture'),
		'42501:hook secret envelope is unavailable'),
	('store: another environment', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(4, '\x0304', '201', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000021'),
		'qorpera_folder_store_hook_capture'), '42501:hook secret envelope is unavailable'),
	('store: the old key', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(4, '\x0304', p_key_id => 'company-kek-1'), 'qorpera_folder_store_hook_capture'),
		'42501:hook secret envelope is unavailable'),
	('store: an empty box', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(4, '\x'), 'qorpera_folder_store_hook_capture'), '42501:hook secret envelope is unavailable'),
	('store: no box', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(4, null), 'qorpera_folder_store_hook_capture'), '42501:hook secret envelope is unavailable'),
	('store: another digest', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(4, '\x0304', p_sha => repeat('f', 64)), 'qorpera_folder_store_hook_capture'),
		'42501:hook secret envelope is unavailable'),
	('store: the version taken', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(3, '\x0304'), 'qorpera_folder_store_hook_capture'), '40003:hook secret capture outcome is unconfirmed'),
	('store: a version skipped', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
		pg_temp.e3c_store_args(5, '\x0304'), 'qorpera_folder_store_hook_capture'), '40003:hook secret capture outcome is unconfirmed')
) as call(name, got, expected);
select set_config('qorpera_test.e3c_c14', pg_temp.e3c_counts()::text, true);
reset session authorization;
-- Only the broker's session calls the broker's functions.
select set_config('qorpera_test.e3c_7y', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from '42501:cloud secret broker authority is required'), ''), true)
from (values
	('open', pg_temp.e3c_call('qorpera_folder_open_stripe_hook',
		pg_temp.e3c_open_args(pg_temp.e3c_create('e3c-open-postgres', 'stripe-postgres'), '204'))),
	('describe', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key', quote_literal(current_setting('qorpera_test.e3c_hook')))),
	('replace', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
		format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-2', current_setting('qorpera_test.e3c_key1')))),
	('read', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'))),
	('store', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'), pg_temp.e3c_store_args(4, '\x0304'),
		'qorpera_folder_store_hook_capture'))
) as call(name, got);

do $$
begin
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_pause')) is not null
			and (select status from public.qorpera_event_hooks where id = current_setting('qorpera_test.e3c_hook')::uuid) = 'paused',
		'7: the pause: ' || current_setting('qorpera_test.e3c_pause'));
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_office14')) #>> '{receiptId}'
				= '41900000-0000-4000-8000-000000000114'
			and pg_temp.e3c_answer(current_setting('qorpera_test.e3c_read14')) #>> '{version}' = '4',
		'7: a paused hook''s reads: ' || current_setting('qorpera_test.e3c_office14') || ' / '
			|| current_setting('qorpera_test.e3c_read14'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_7x') = '',
		E'7: refusals that differ:\n' || current_setting('qorpera_test.e3c_7x'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_c14') = current_setting('qorpera_test.e3c_c13'),
		'7: a refusal stored ' || pg_temp.e3c_delta(current_setting('qorpera_test.e3c_c14')::jsonb,
			current_setting('qorpera_test.e3c_c13')::jsonb)::text);
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_7y') = '',
		E'7: calls outside the broker''s session that differ:\n' || current_setting('qorpera_test.e3c_7y'));
end $$;

-- A requester who is no longer an owner or admin takes nothing.
savepoint e3c_demoted;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.e3c_office14d', pg_temp.e3c_office('14', current_setting('qorpera_test.e3c_env14')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_read14d', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14')), true);
select set_config('qorpera_test.e3c_store14d', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
	pg_temp.e3c_store_args(4, '\x0304'), 'qorpera_folder_store_hook_capture'), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_office14d') like '42501:%'
			and current_setting('qorpera_test.e3c_read14d') = '42501:Only owners and admins can open hooks; ask one of them'
			and current_setting('qorpera_test.e3c_store14d') = '42501:Only owners and admins can open hooks; ask one of them',
		'7: a contributor''s run: ' || concat_ws(' / ', current_setting('qorpera_test.e3c_office14d'),
			current_setting('qorpera_test.e3c_read14d'), current_setting('qorpera_test.e3c_store14d')));
end $$;
rollback to savepoint e3c_demoted;

-- A secret revoked in the vault is gone: nothing takes it again.
savepoint e3c_revoked;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp()
where id = '41900000-0000-4000-8000-000000000201';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.e3c_office14r', pg_temp.e3c_office('14', current_setting('qorpera_test.e3c_env14')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_read14r', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14')), true);
select set_config('qorpera_test.e3c_store14r', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
	pg_temp.e3c_store_args(4, '\x0304'), 'qorpera_folder_store_hook_capture'), true);
reset session authorization;
do $$
declare v_gone text := '55000:This hook''s secret is gone from the vault';
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_office14r') = v_gone
			and current_setting('qorpera_test.e3c_read14r') = v_gone and current_setting('qorpera_test.e3c_store14r') = v_gone,
		'7: a revoked secret: ' || concat_ws(' / ', current_setting('qorpera_test.e3c_office14r'),
			current_setting('qorpera_test.e3c_read14r'), current_setting('qorpera_test.e3c_store14r')));
end $$;
rollback to savepoint e3c_revoked;

-- The paused hook's capture stores; another call's receipt with the same input reads nothing.
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_store14', pg_temp.e3c_capture('14', current_setting('qorpera_test.e3c_env14'),
	pg_temp.e3c_store_args(4, '\x0304'), 'qorpera_folder_store_hook_capture'), true);
reset session authorization;
select pg_temp.e3c_end('14', current_setting('qorpera_test.e3c_env14'));
select pg_temp.e3c_native('15', 'computer_browser:e3c-other',
	encode(extensions.digest(current_setting('qorpera_test.e3c_env14'), 'sha256'), 'hex'));
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_read15', pg_temp.e3c_capture('15', current_setting('qorpera_test.e3c_env14')), true);
reset session authorization;
select pg_temp.e3c_end('15', current_setting('qorpera_test.e3c_env14'), false);

do $$
begin
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_store14')) #>> '{version}' = '4'
			and (select current_version from public.qorpera_cloud_secrets where id = '41900000-0000-4000-8000-000000000201') = 4
			and (select key_id from public.qorpera_cloud_secret_versions
				where secret_id = '41900000-0000-4000-8000-000000000201' and version = 4) = 'company-kek-2',
		'7: the paused hook''s capture: ' || current_setting('qorpera_test.e3c_store14'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_read15') = '42501:hook secret capture receipt is unavailable',
		'7: another call''s receipt: ' || current_setting('qorpera_test.e3c_read15'));
end $$;

-- 8. A Stripe hook's descriptor names the captured version, when, and the last delivery refused under it ------------------

select set_config('qorpera_test.e3c_desc8a', public.qorpera_event_hook_descriptor(hook, false)::text, true)
from public.qorpera_event_hooks as hook where hook.id = current_setting('qorpera_test.e3c_hook')::uuid;
-- Refused deliveries: one under version 3, two under version 4 (the later one is the last).
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_event_deliveries(hook_id, profile_id, received_at, status, body_bytes, body_sha256, reason,
	verify_secret_id, verify_secret_version)
select current_setting('qorpera_test.e3c_hook')::uuid, '92400000-0000-4000-8000-000000000010', statement_timestamp() + refused.ago,
	'refused', 0, repeat('0', 64), refused.reason, '41900000-0000-4000-8000-000000000201', refused.version
from (values (interval '-1 minute', 'Under the version before', 3::bigint),
	(interval '-3 minutes', 'An earlier refusal', 4::bigint),
	(interval '-2 minutes', 'Stripe-Signature does not match', 4::bigint)) as refused(ago, reason, version);
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.e3c_desc8b', public.qorpera_event_hook_descriptor(hook, false)::text, true)
from public.qorpera_event_hooks as hook where hook.id = current_setting('qorpera_test.e3c_hook')::uuid;
select set_config('qorpera_test.e3c_desc8g', public.qorpera_event_hook_descriptor(hook, false)::text, true)
from public.qorpera_event_hooks as hook where hook.id = current_setting('qorpera_test.e3c_github_hook')::uuid;

do $$
declare
	v_secret jsonb;
	v_last jsonb;
begin
	select jsonb_build_object('connectorId', 'event_hook',
			'secretName', public.qorpera_event_hook_secret_name(current_setting('qorpera_test.e3c_hook')::uuid),
			'ready', true, 'version', 4, 'capturedAt', version.created_at)
		into v_secret
	from public.qorpera_cloud_secret_versions as version
	where version.secret_id = '41900000-0000-4000-8000-000000000201' and version.version = 4;
	select jsonb_build_object('receivedAt', delivery.received_at, 'reason', delivery.reason) into v_last
	from public.qorpera_event_deliveries as delivery
	where delivery.hook_id = current_setting('qorpera_test.e3c_hook')::uuid and delivery.reason = 'Stripe-Signature does not match';
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_desc8a')::jsonb -> 'signingSecret' = v_secret,
		'8: the captured version: ' || current_setting('qorpera_test.e3c_desc8a'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_desc8b')::jsonb -> 'signingSecret'
			= v_secret || jsonb_build_object('lastRefusal', v_last),
		'8: the last refusal: ' || current_setting('qorpera_test.e3c_desc8b'));
	-- A GitHub hook's signingSecret keeps its three keys.
	perform pg_temp.base_assert((select array_agg(key order by key)
			from jsonb_object_keys(current_setting('qorpera_test.e3c_desc8g')::jsonb -> 'signingSecret') as key)
			= array['connectorId', 'ready', 'secretName'],
		'8: a GitHub hook''s secret: ' || current_setting('qorpera_test.e3c_desc8g'));
end $$;

-- 9. The vault never types a Stripe hook's secret ----------------------------------------------------------------------------

select set_config('qorpera_test.e3c_env19', pg_temp.e3c_envelope('e3c-19',
	'{"action": "vault_fill", "role": "textbox", "name": "Signing secret"}'), true);
select pg_temp.e3c_begin('19', current_setting('qorpera_test.e3c_env19'));
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_fill19', pg_temp.e3c_capture('19', current_setting('qorpera_test.e3c_env19'), null,
	'qorpera_fill_event_hook_secret'), true);
reset session authorization;
select pg_temp.e3c_end('19', current_setting('qorpera_test.e3c_env19'));
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_fill19') = '0A000:This hook has no secret the vault types',
		'9: a Stripe hook''s fill: ' || current_setting('qorpera_test.e3c_fill19'));
end $$;

-- 10. A removed hook's secret is revoked, and nothing takes it again -------------------------------------------------------

select set_config('qorpera_test.e3c_remove', pg_temp.e3c_host(
	'{"action": "remove", "hook": "stripe-pays", "operationKey": "e3c-remove"}'), true);
select set_config('qorpera_test.e3c_env16', pg_temp.e3c_envelope('e3c-16'), true);
select pg_temp.e3c_begin('16', current_setting('qorpera_test.e3c_env16'));
select set_config('qorpera_test.e3c_office16', pg_temp.e3c_office('16', current_setting('qorpera_test.e3c_env16')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3c_10x', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from '55000:This hook was removed'), ''), true)
from (values
	('office read', current_setting('qorpera_test.e3c_office16')),
	('describe', pg_temp.e3c_call('qorpera_folder_describe_hook_capture_key', quote_literal(current_setting('qorpera_test.e3c_hook')))),
	('replace', pg_temp.e3c_call('qorpera_folder_replace_hook_capture_key',
		format('%L, %L, %L', current_setting('qorpera_test.e3c_hook'), 'company-kek-2', current_setting('qorpera_test.e3c_key1')))),
	('read', pg_temp.e3c_capture('16', current_setting('qorpera_test.e3c_env16'))),
	('store', pg_temp.e3c_capture('16', current_setting('qorpera_test.e3c_env16'), pg_temp.e3c_store_args(5, '\x0305'),
		'qorpera_folder_store_hook_capture'))
) as call(name, got);
reset session authorization;
select pg_temp.e3c_end('16', current_setting('qorpera_test.e3c_env16'));

do $$
begin
	perform pg_temp.base_assert(pg_temp.e3c_answer(current_setting('qorpera_test.e3c_remove')) is not null
			and (select status from public.qorpera_event_hooks where id = current_setting('qorpera_test.e3c_hook')::uuid) = 'removed'
			and (select status from public.qorpera_cloud_secrets where id = '41900000-0000-4000-8000-000000000201') = 'revoked'
			and exists (select 1 from public.qorpera_cloud_secret_audit_events
				where secret_id = '41900000-0000-4000-8000-000000000201' and event_type = 'secret_revoked' and secret_version = 4),
		'10: the removal revokes the secret: ' || current_setting('qorpera_test.e3c_remove'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3c_10x') = '',
		E'10: calls on a removed hook that differ:\n' || current_setting('qorpera_test.e3c_10x'));
end $$;

-- 11. Grants, the effect's old form, the browser action and the deploy guard's marker -----------------------------------

do $$
declare
	v_function text;
	v_role text;
	v_granted text[];
	v_action jsonb := jsonb_build_object('kind', 'browser', 'action', 'vault_capture', 'role', 'link', 'name', 'Reveal',
		'hook', 'a1900000-0000-4000-8000-000000000abc', 'field', 'signing_secret');
begin
	-- Who may run each function: the broker its five, the host the office's read, nobody the rest.
	for v_function, v_granted in select call.fn, call.roles from (values
		('public.qorpera_folder_open_stripe_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,text)', array['qorpera_secret_broker']),
		('public.qorpera_folder_describe_hook_capture_key(uuid,text,jsonb,uuid)', array['qorpera_secret_broker']),
		('public.qorpera_folder_replace_hook_capture_key(uuid,text,jsonb,uuid,text,text)', array['qorpera_secret_broker']),
		('public.qorpera_folder_read_hook_capture(uuid,text,jsonb,uuid,text,text)', array['qorpera_secret_broker']),
		('public.qorpera_folder_store_hook_capture(uuid,text,jsonb,uuid,text,text,uuid,bigint,uuid,uuid,text,bytea,text)',
			array['qorpera_secret_broker']),
		('public.qorpera_native_office_hook_capture(jsonb,jsonb,jsonb,text,uuid,text)', array['service_role']),
		('public.qorpera_folder_hook_capture_context(public.qorpera_cloud_secret_broker_authorities,jsonb,uuid,text,text)',
			array[]::text[]),
		('public.qorpera_folder_manage_hook_effect(jsonb,jsonb,public.qorpera_cloud_secret_broker_authorities,uuid,uuid,uuid,text,'
			|| 'bytea,text,text)', array[]::text[])
	) as call(fn, roles) loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'execute') = (v_role = any(v_granted)),
				format('11: %s for %s', v_function, v_role));
		end loop;
	end loop;
	perform pg_temp.base_assert(to_regprocedure('public.qorpera_folder_manage_hook_effect(jsonb,jsonb,'
			|| 'public.qorpera_cloud_secret_broker_authorities,uuid,uuid,uuid,text,bytea,text)') is null,
		'11: the effect''s old form is dropped');
	-- The browser action: a click on a button or link that shows a hook's signing secret.
	perform pg_temp.base_assert(public.qorpera_valid_office_browser_action(v_action)
			and not public.qorpera_valid_office_browser_action(v_action || '{"role": "textbox"}')
			and not public.qorpera_valid_office_browser_action(v_action || '{"role": "spinbutton"}')
			and not public.qorpera_valid_office_browser_action(v_action - 'field')
			and not public.qorpera_valid_office_browser_action(v_action || '{"field": "password"}')
			and not public.qorpera_valid_office_browser_action(v_action || '{"text": "x"}')
			and not public.qorpera_valid_office_browser_action(v_action || '{"hook": "A1900000-0000-4000-8000-000000000ABC"}')
			and not public.qorpera_valid_office_browser_action(v_action || '{"name": "  "}'),
		'11: the vault_capture action');
	-- The deploy guard's marker is in these fourteen bodies, and in no other.
	perform pg_temp.base_assert((select array_agg(proc.proname::text order by proc.proname::text collate "C")
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930344000') > 0) = array[
			'qorpera_create_event_hook', 'qorpera_event_hook_descriptor', 'qorpera_fill_event_hook_secret',
			'qorpera_folder_describe_hook_capture_key', 'qorpera_folder_hook_capture_context', 'qorpera_folder_manage_hook',
			'qorpera_folder_manage_hook_effect', 'qorpera_folder_open_signed_hook', 'qorpera_folder_open_stripe_hook',
			'qorpera_folder_read_hook_capture', 'qorpera_folder_replace_hook_capture_key', 'qorpera_folder_store_hook_capture',
			'qorpera_native_office_hook_capture', 'qorpera_valid_office_browser_action'],
		'11: the marker''s bodies');
end $$;

rollback;
