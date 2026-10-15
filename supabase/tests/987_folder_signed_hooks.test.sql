-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company folder core C4, E3b-1 (migration 20260930160000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.7):
-- GitHub and HMAC hooks whose signing secret the company's secret broker makes, and the vault's read for typing it into
-- the sender's site. On 924's folder-v2 company, with Alice's leased run (a real claim, runner, assignment and native
-- lease), the company's broker authority and its computer (Alice's screen lease and the current boot's fill key):
-- 0. before an owed acknowledgement the broker's describe and open are refused, and write nothing;
-- A. the broker describes an opening, opens a GitHub hook (the hook, its event_hook secret, version 1 and the audit row, in
--    one step) and an HMAC hook; a replay answers from the receipt and stores nothing; the host opens an address hook;
-- B. every refusal writes nothing: the request (a site; a Stripe hook, which opens with a capture key: test 419), the
--    envelope, the broker's authority, a company that is not on the company folder, a signed proof on the host's path,
--    Postgres' own session, and a requester who is no longer an owner or admin;
-- C. the fill: bound to the executing computer_browser receipt of exactly that vault_fill call, the run's screen lease on
--    the company's computer, a live signed hook of the run's company and its secret sealed for this authority; A1's fill
--    refuses a hook's call; a removal revokes the secret;
-- D. the browser action's hook variant, the grants, the marker, and the bodies' order.
-- The races (a retried opening, a taken name, a held hook, a held secret) are 948's, on this fixture committed.

-- The company's broker authority, no public URL (the answer's hook then has no url), and A1's switch off (the fill of a
-- hook's secret is not the accounts').
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('98700000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
update public.qorpera_event_intake_settings set public_url = null;
update public.qorpera_company_account_settings set enabled = false;

-- The company's computer, generation 1, with Alice's screen lease on it and its current boot's fill key (written directly,
-- as 925 does: the fill only reads them).
select set_config('qorpera_test.e3b_fill_key',
	rtrim(translate(encode(extensions.digest('a 987 computer key', 'sha256'), 'base64'), '+/', '-_'), '='), true);
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_runtime_offices(id, profile_id, environment_id, logical_computer_id, client_computer_id,
	image_sha256, bootstrap_sha256, state, generation, max_screens, created_by_user_id)
values ('98700000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'98700000-0000-4000-8000-0000000000a2', '98700000-0000-4000-8000-0000000000a3', repeat('a', 64), repeat('b', 64), 'active', 1, 2,
	'92400000-0000-4000-8000-000000000001');
insert into public.qorpera_runtime_office_screens(office_id, id, ordinal, staff_agent_id, generation, epoch, power,
	lease_id, run_id, lease_expires_at, grant_version, native_binding)
select '98700000-0000-4000-8000-0000000000a1', '98700000-0000-4000-8000-0000000000a4', 1, '92400000-0000-4000-8000-000000000030',
	1, 1, 'open', '98700000-0000-4000-8000-0000000000a5', (binding ->> 'runId')::uuid, clock_timestamp() + interval '1 hour', 1, binding
from (select current_setting('qorpera_test.base_binding')::jsonb as binding) as run;
insert into public.qorpera_runtime_office_activations(intent_id, activation_id, office_id, computer_generation,
	allocation_id, provider_id, provider_policy_sha256, provider_binding_sha256, instance_sha256, image_sha256,
	bootstrap_sha256, attestation, mappings, state, service_invocation_id, ready_at, activated_at, fill_public_key)
values ('98700000-0000-4000-8000-0000000000a6', '98700000-0000-4000-8000-0000000000a7', '98700000-0000-4000-8000-0000000000a1', 1,
	'98700000-0000-4000-8000-0000000000a8', '98700000-0000-4000-8000-0000000000a9', repeat('1', 64), repeat('2', 64), repeat('3', 64),
	repeat('a', 64), repeat('b', 64), '{}', '[]', 'active', repeat('a', 32), clock_timestamp(), clock_timestamp(),
	current_setting('qorpera_test.e3b_fill_key'));
select set_config('session_replication_role', 'origin', true);

-- A snapshot-v1 company (as every company inserted without the folder is) with its owner, environment, broker authority,
-- a job of its own and a GitHub hook (written directly, as replica).
insert into auth.users(id, email) values ('98700000-0000-4000-8000-000000000001', 'hooks-old-core@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('98700000-0000-4000-8000-000000000010', 'Old core', '98700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('98700000-0000-4000-8000-000000000010', '98700000-0000-4000-8000-000000000001', 'hooks-old-core@example.test', 'Owner',
	'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('98700000-0000-4000-8000-000000000020', '98700000-0000-4000-8000-000000000010', 'Environment', 1,
	'98700000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('98700000-0000-4000-8000-000000000041', '98700000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'old-kek-1', repeat('8', 64));
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
	job_type, payload, created_by_user_id, status)
values ('98700000-0000-4000-8000-0000000000e2', '98700000-0000-4000-8000-000000000010', '98700000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '98700000-0000-4000-8000-000000000001',
	'queued');
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address, secret_site)
values ('98700000-0000-4000-8000-000000000095', '98700000-0000-4000-8000-000000000010', '98700000-0000-4000-8000-000000000020',
	'b-pushes', 'Pushes.', 'github', repeat('B', 43), 'github.com');
select set_config('session_replication_role', 'origin', true);
-- Its run's binding: the job is the old company's, every other id as Alice's.
select set_config('qorpera_test.b_binding', jsonb_set(current_setting('qorpera_test.base_binding')::jsonb, '{jobId}',
	'"98700000-0000-4000-8000-0000000000e2"')::text, true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.e3b_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.e3b_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
-- A broker call: the function and the arguments after the three shared ones; another binding or authority for B.
create function pg_temp.e3b_call(p_function text, p_rest text default null, p_binding text default null,
	p_authority text default '98700000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language plpgsql as $$
begin
	-- The broker's session carries no JWT claims, as in production.
	perform set_config('request.jwt.claims', '', true);
	return pg_temp.e3b_try(format('select public.%s(%L, %L, %L::jsonb%s)', p_function, p_authority, p_capability,
		coalesce(p_binding, current_setting('qorpera_test.base_binding')), coalesce(', ' || p_rest, '')));
end $$;
-- An opening's own arguments: the request, the id the broker chose, the run's company and environment, the key, the
-- envelope and its digest. The digest runs as the owner (the broker reads no extension).
create function pg_temp.e3b_open_args(p_request jsonb, p_secret text, p_envelope bytea default '\x0201',
	p_company text default '92400000-0000-4000-8000-000000000010', p_environment text default '92400000-0000-4000-8000-000000000020',
	p_key text default 'company-kek-1', p_sha text default null)
returns text language sql security definer as $$
	select format('%L::jsonb, %L, %L, %L, %L, %L::bytea, %L', p_request, '98700000-0000-4000-8000-000000000' || p_secret,
		p_company, p_environment, p_key, p_envelope, coalesce(p_sha, encode(extensions.digest(p_envelope, 'sha256'), 'hex')))
$$;
create function pg_temp.e3b_create(p_key text, p_name text, p_more jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('action', 'create', 'kind', 'hook', 'operationKey', p_key, 'name', p_name,
		'purpose', 'Pushes to the main repository wake the Builder.') || p_more
$$;
-- The host's manage_hook (the native host's service role, the run's binding).
create function pg_temp.e3b_host(p_request jsonb) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.e3b_try(format('select public.qorpera_folder_manage_hook(%L::jsonb, %L::jsonb)',
		current_setting('qorpera_test.base_binding'), p_request));
	reset role;
	return v;
end $$;
-- The runtime begins and finishes the agent's tool call receipt (one unresolved receipt per run), as the database owner.
create function pg_temp.e3b_begin(p_n text, p_key text, p_input text default repeat('a', 64)) returns void
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('98700000-0000-4000-8000-0000000001' || p_n)::uuid, p_key, p_input, repeat('b', 64), false);
end $$;
create function pg_temp.e3b_end(p_n text, p_input text default repeat('a', 64)) returns void
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('98700000-0000-4000-8000-0000000001' || p_n)::uuid, p_input, '{}'::jsonb);
end $$;
-- One vault_fill call's operation envelope for a hook's secret, as the computer tool writes it, with changes.
create function pg_temp.e3b_fill_envelope(p_key text, p_hook text, p_arguments jsonb default '{}', p_binding jsonb default '{}')
returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2', 'principals', '{}'::jsonb,
		'operation', jsonb_build_object('tool', 'computer_browser', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('kind', 'browser', 'action', 'vault_fill', 'role', 'textbox', 'name', 'Signing secret',
				'field', 'signing_secret', 'hook', p_hook) || p_arguments,
			'target', jsonb_build_object('realm', 'company_computer', 'resources', '{}'::jsonb,
				'binding', jsonb_build_object('companyId', '92400000-0000-4000-8000-000000000010',
					'environmentId', '92400000-0000-4000-8000-000000000020',
					'companyComputerId', '98700000-0000-4000-8000-0000000000a1',
					'logicalComputerId', '98700000-0000-4000-8000-0000000000a2', 'computerGeneration', 1,
					'screenId', '98700000-0000-4000-8000-0000000000a4', 'screenOrdinal', 1, 'screenGeneration', 1,
					'staffAgentId', '92400000-0000-4000-8000-000000000030') || p_binding)))
$$;
create function pg_temp.e3b_sha(p_text text) returns text language sql security definer as $$
	select encode(extensions.digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex')
$$;
-- A fill: the receipt's number and the call's envelope; another binding, authority, digest or function when named.
create function pg_temp.e3b_fill(p_n text, p_envelope text, p_binding text default null,
	p_authority text default '98700000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64),
	p_downstream text default repeat('b', 64), p_function text default 'qorpera_fill_event_hook_secret')
returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '', true);
	return pg_temp.e3b_try(format('select public.%s(%L, %L, %L::jsonb, %L, %L, %L)', p_function, p_authority, p_capability,
		coalesce(p_binding, current_setting('qorpera_test.base_binding')), '98700000-0000-4000-8000-0000000001' || p_n,
		p_envelope, p_downstream));
end $$;
-- What a call may write: hooks (all, and live), active secrets, versions, audit rows, receipts and connection file marks.
create function pg_temp.e3b_counts() returns jsonb language sql security definer as $$
	select jsonb_build_object('hooks', (select count(*) from public.qorpera_event_hooks),
		'live', (select count(*) from public.qorpera_event_hooks where status <> 'removed'),
		'secrets', (select count(*) from public.qorpera_cloud_secrets where status = 'active'),
		'versions', (select count(*) from public.qorpera_cloud_secret_versions),
		'events', (select count(*) from public.qorpera_cloud_secret_audit_events),
		'receipts', (select count(*) from public.qorpera_run_operation_receipts),
		'marks', (select count(*) from public.qorpera_folder_connection_file_marks))
$$;
-- The counts that changed, by how much.
create function pg_temp.e3b_delta(p_after jsonb, p_before jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(a.key, a.value::text::bigint - (p_before ->> a.key)::bigint)
		filter (where a.value::text::bigint <> (p_before ->> a.key)::bigint), '{}'::jsonb)
	from jsonb_each(p_after) as a
$$;
grant execute on function pg_temp.e3b_try(text), pg_temp.e3b_answer(text), pg_temp.e3b_call(text,text,text,text,text),
	pg_temp.e3b_open_args(jsonb,text,bytea,text,text,text,text), pg_temp.e3b_create(text,text,jsonb),
	pg_temp.e3b_begin(text,text,text), pg_temp.e3b_end(text,text), pg_temp.e3b_fill_envelope(text,text,jsonb,jsonb),
	pg_temp.e3b_sha(text), pg_temp.e3b_fill(text,text,text,text,text,text,text), pg_temp.e3b_counts(),
	pg_temp.e3b_delta(jsonb,jsonb) to qorpera_secret_broker;
grant execute on function pg_temp.e3b_try(text) to service_role;

-- 0. Before the wake's acknowledgement ------------------------------------------------------------------------------------
-- The base run answers a room post, which may work before it speaks. A first run owes the acknowledgement before any
-- work (924 §7): the owner hires Dana, and the broker's calls on her leased first run are refused. All of it is undone.

savepoint e3b_first_run;
select pg_temp.base_commit(pg_temp.base_owner(), 'e3b-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run uuid;
begin
	select w.run_id into strict v_run from public.qorpera_wake_occurrences w
	where w.wake_kind = 'first-run' and w.staff_agent_id = '92400000-0000-4000-8000-000000000034'
		and w.run_id::text in (select jsonb_array_elements_text(v_pass -> 'run_ids'));
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy_internal(v_run) ->> 'initial' = 'required',
		'0: Dana''s first run needs an acknowledgement before work');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy_internal(
		(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid) ->> 'initial' = 'optional',
		'0: the base run may work before it speaks');
	perform set_config('qorpera_test.e3b_dana', pg_temp.base_start(v_run)::text, true);
end $$;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_0_before', pg_temp.e3b_counts()::text, true);
select set_config('qorpera_test.e3b_0_describe', pg_temp.e3b_call('qorpera_folder_describe_signed_hook', null,
	current_setting('qorpera_test.e3b_dana')), true);
select set_config('qorpera_test.e3b_0_open', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
	pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-open-github', 'github-pushes', '{"proof": "github"}'), '201'),
	current_setting('qorpera_test.e3b_dana')), true);
select set_config('qorpera_test.e3b_0_after', pg_temp.e3b_counts()::text, true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_0_describe') = '55000:Wake requires an acknowledgement before work'
		and current_setting('qorpera_test.e3b_0_open') = '55000:Wake requires an acknowledgement before work',
		'0: before the acknowledgement: ' || current_setting('qorpera_test.e3b_0_describe') || ' / '
			|| current_setting('qorpera_test.e3b_0_open'));
	perform pg_temp.base_assert(pg_temp.e3b_delta(current_setting('qorpera_test.e3b_0_after')::jsonb,
		current_setting('qorpera_test.e3b_0_before')::jsonb) = '{}'::jsonb, '0: a refused call wrote something');
end $$;
rollback to savepoint e3b_first_run;

-- A. The broker opens GitHub and HMAC hooks; the host an address hook ------------------------------------------------------

set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_describe', pg_temp.e3b_call('qorpera_folder_describe_signed_hook'), true);
select set_config('qorpera_test.e3b_c0', pg_temp.e3b_counts()::text, true);
select set_config('qorpera_test.e3b_github', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
	pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-open-github', 'github-pushes', '{"proof": "github"}'), '201')), true);
select set_config('qorpera_test.e3b_c1', pg_temp.e3b_counts()::text, true);
-- The same call again (the default site named, a new id and envelope): the first answer, and nothing stored.
select set_config('qorpera_test.e3b_replay', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
	pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-open-github', 'github-pushes', '{"proof": "github", "site": "github.com"}'),
		'202', '\x0202')), true);
-- The same key for another site is other work.
select set_config('qorpera_test.e3b_rebound', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
	pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-open-github', 'github-pushes', '{"proof": "github", "site": "github.example.com"}'),
		'202', '\x0202')), true);
select set_config('qorpera_test.e3b_c2', pg_temp.e3b_counts()::text, true);
select set_config('qorpera_test.e3b_hmac', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
	pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-open-hmac', 'shop-orders',
		'{"proof": "hmac-sha256", "site": "hooks.example.com", "maxBodyBytes": 131072, "perMinute": 30}'), '203', '\x0203')), true);
reset session authorization;
select set_config('qorpera_test.e3b_plain', pg_temp.e3b_host(pg_temp.e3b_create('e3b-open-plain', 'plain-orders')), true);

do $$
declare
	v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_github jsonb := pg_temp.e3b_answer(current_setting('qorpera_test.e3b_github'));
	v_hmac jsonb := pg_temp.e3b_answer(current_setting('qorpera_test.e3b_hmac'));
	v_plain jsonb := pg_temp.e3b_answer(current_setting('qorpera_test.e3b_plain'));
	h public.qorpera_event_hooks%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_describe') = 'ok:' || jsonb_build_object(
		'schema', 'qorpera.folder-signed-hook-context/v1', 'companyId', '92400000-0000-4000-8000-000000000010',
		'environmentId', '92400000-0000-4000-8000-000000000020', 'keyId', 'company-kek-1')::text,
		'A: the opening''s context: ' || current_setting('qorpera_test.e3b_describe'));
	-- The GitHub hook: the answer (the hook with its address and path; no URL is set), the receipt, the row.
	select * into h from public.qorpera_event_hooks where id = (v_github #>> '{hook,id}')::uuid;
	select * into v_receipt from public.qorpera_run_operation_receipts
	where run_id = v_run and logical_operation_key = 'hook:e3b-open-github';
	perform pg_temp.base_assert(h.id is not null and v_github = jsonb_build_object('schema', 'qorpera.agent-hook-receipt/v1',
			'runId', v_run, 'receiptId', v_receipt.id, 'action', 'create', 'hook', public.qorpera_event_hook_descriptor(h, true),
			'secretSite', 'github.com'),
		'A: the GitHub hook''s answer: ' || current_setting('qorpera_test.e3b_github'));
	perform pg_temp.base_assert(v_receipt.status = 'completed'
			and v_receipt.result = v_github || jsonb_build_object('hook', public.qorpera_event_hook_descriptor(h, false)),
		'A: the receipt keeps the answer without the address: ' || coalesce(v_receipt.result::text, 'none'));
	perform pg_temp.base_assert(v_github #> '{hook,signingSecret}' = jsonb_build_object('connectorId', 'event_hook',
			'secretName', 'h' || replace(h.id::text, '-', ''), 'ready', true),
		'A: the hook''s secret is ready: ' || coalesce(v_github #>> '{hook,signingSecret}', 'none'));
	perform pg_temp.base_assert(h.name = 'github-pushes' and h.proof = 'github' and h.secret_site = 'github.com'
			and h.created_by_staff_agent_id = '92400000-0000-4000-8000-000000000030' and h.created_by_user_id is null
			and h.max_body_bytes = 65536 and h.per_minute = 60 and h.status = 'active'
			and h.purpose = 'Pushes to the main repository wake the Builder.',
		'A: the GitHub hook''s row');
	-- Its secret: the company's, bound to the hook by name, created by the run's requester; version 1 the envelope under
	-- this authority's key; one audit row of the run's receipt.
	select * into v_secret from public.qorpera_cloud_secrets where id = '98700000-0000-4000-8000-000000000201';
	perform pg_temp.base_assert(v_secret.profile_id = '92400000-0000-4000-8000-000000000010'
			and v_secret.environment_id = '92400000-0000-4000-8000-000000000020'
			and v_secret.broker_authority_id = '98700000-0000-4000-8000-000000000040' and v_secret.owner_kind = 'company'
			and v_secret.owner_user_id is null and v_secret.connector_id = 'event_hook'
			and v_secret.secret_name = 'h' || replace(h.id::text, '-', '') and v_secret.purpose = h.purpose
			and v_secret.current_version = 1 and v_secret.status = 'active'
			and v_secret.created_by_user_id = '92400000-0000-4000-8000-000000000001'
			and (public.qorpera_event_hook_secret(h)).id = v_secret.id,
		'A: the GitHub hook''s secret');
	select * into v_version from public.qorpera_cloud_secret_versions where secret_id = v_secret.id;
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_versions where secret_id = v_secret.id) = 1
			and v_version.version = 1 and v_version.broker_authority_id = '98700000-0000-4000-8000-000000000040'
			and v_version.key_id = 'company-kek-1' and v_version.encrypted_envelope = '\x0201'::bytea
			and v_version.envelope_sha256 = encode(extensions.digest('\x0201'::bytea, 'sha256'), 'hex')
			and v_version.created_by_user_id = '92400000-0000-4000-8000-000000000001',
		'A: the secret''s version');
	perform pg_temp.base_assert((select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
				where secret_id = v_secret.id) = array['hook_secret_made']
			and exists (select 1 from public.qorpera_cloud_secret_audit_events where secret_id = v_secret.id
				and secret_version = 1 and run_id = v_run and receipt_id = v_receipt.id
				and actor_user_id = '92400000-0000-4000-8000-000000000001' and connector_id = 'event_hook'),
		'A: the secret''s audit row');
	-- The hook's connection file is marked; an event_hook secret has no file of its own.
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_folder_connection_file_marks
				where subject_kind = 'hook' and secret_id = h.id)
			and not exists (select 1 from public.qorpera_folder_connection_file_marks where secret_id = v_secret.id),
		'A: the marks');
	perform pg_temp.base_assert(pg_temp.e3b_delta(current_setting('qorpera_test.e3b_c1')::jsonb,
			current_setting('qorpera_test.e3b_c0')::jsonb)
			= '{"hooks": 1, "live": 1, "secrets": 1, "versions": 1, "events": 1, "receipts": 1, "marks": 1}'::jsonb,
		'A: the opening wrote: ' || pg_temp.e3b_delta(current_setting('qorpera_test.e3b_c1')::jsonb,
			current_setting('qorpera_test.e3b_c0')::jsonb)::text);
	-- A replay: the first answer, nothing stored; another site under the key is refused.
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_replay') = current_setting('qorpera_test.e3b_github')
			and not exists (select 1 from public.qorpera_cloud_secrets where id = '98700000-0000-4000-8000-000000000202'),
		'A: the replay: ' || current_setting('qorpera_test.e3b_replay'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_rebound') = '23505:logical operation key is already bound to other work',
		'A: the key for another site: ' || current_setting('qorpera_test.e3b_rebound'));
	perform pg_temp.base_assert(pg_temp.e3b_delta(current_setting('qorpera_test.e3b_c2')::jsonb,
			current_setting('qorpera_test.e3b_c1')::jsonb) = '{}'::jsonb,
		'A: the replay wrote something');
	perform set_config('qorpera_test.e3b_github_hook', h.id::text, true);
	-- The HMAC hook: the named site and limits, and its secret.
	select * into h from public.qorpera_event_hooks where id = (v_hmac #>> '{hook,id}')::uuid;
	perform pg_temp.base_assert(h.id is not null and v_hmac ->> 'secretSite' = 'hooks.example.com'
			and v_hmac #>> '{hook,proof}' = 'hmac-sha256' and h.secret_site = 'hooks.example.com' and h.max_body_bytes = 131072
			and h.per_minute = 30 and (v_hmac #> '{hook,signingSecret,ready}') = 'true'::jsonb
			and (public.qorpera_event_hook_secret(h)).id = '98700000-0000-4000-8000-000000000203',
		'A: the HMAC hook: ' || current_setting('qorpera_test.e3b_hmac'));
	perform set_config('qorpera_test.e3b_hmac_hook', h.id::text, true);
	-- The host's address hook: no site and no secret.
	select * into h from public.qorpera_event_hooks where id = (v_plain #>> '{hook,id}')::uuid;
	perform pg_temp.base_assert(h.id is not null and h.proof = 'address' and not v_plain ? 'secretSite'
			and not v_plain -> 'hook' ? 'signingSecret' and h.secret_site is null
			and (public.qorpera_event_hook_secret(h)).id is null,
		'A: the address hook: ' || current_setting('qorpera_test.e3b_plain'));
	perform set_config('qorpera_test.e3b_plain_hook', h.id::text, true);
end $$;

-- B. Every refusal writes nothing ----------------------------------------------------------------------------------------

select set_config('qorpera_test.e3b_b_before', pg_temp.e3b_counts()::text, true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_b_broker', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from expected), ''), true)
from (values
	-- The request. A Stripe hook brings its capture key, not an envelope (E3c-1, test 419).
	('stripe', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-1', 'stripe-pays', '{"proof": "stripe"}'), '204')),
		'42501:hook capture key is unavailable'),
	('hmac without a site', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-2', 'shop-pays', '{"proof": "hmac-sha256"}'), '204')),
		'22023:An HMAC hook names the site its secret is typed into'),
	('site GitHub.com', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-3', 'repo-pushes', '{"proof": "github", "site": "GitHub.com"}'), '204')),
		'22023:A site is a host name such as github.com'),
	('site localhost', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-4', 'repo-pushes', '{"proof": "github", "site": "localhost"}'), '204')),
		'22023:A site is a host name such as github.com'),
	('site a..b', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-5', 'repo-pushes', '{"proof": "hmac-sha256", "site": "a..b"}'), '204')),
		'22023:A site is a host name such as github.com'),
	('site a URL', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-6', 'repo-pushes', '{"proof": "github", "site": "https://github.com"}'), '204')),
		'22023:A site is a host name such as github.com'),
	('site too long', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-7', 'repo-pushes',
			jsonb_build_object('proof', 'hmac-sha256', 'site', repeat('a.', 127) || 'com')), '204')),
		'22023:A site is a host name such as github.com'),
	('site a number', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-8', 'repo-pushes', '{"proof": "github", "site": 5}'), '204')),
		'22023:Hook request is invalid'),
	('site on an address hook', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-9', 'repo-pushes', '{"site": "github.com"}'), '204')),
		'22023:Only a signed hook names the site its secret is typed into'),
	-- The vault opens only a signed hook.
	('vault address hook', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-10', 'repo-pushes'), '204')),
		'22023:The vault opens only a signed hook'),
	('vault mailbox', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args('{"action": "create", "kind": "mailbox", "operationKey": "e3b-b-11", "localPart": "sales", "purpose": "Sales mail."}',
			'204')),
		'22023:The vault opens only a signed hook'),
	('vault pause', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args('{"action": "pause", "hook": "github-pushes", "operationKey": "e3b-b-12"}', '204')),
		'22023:The vault opens only a signed hook'),
	-- The envelope: the broker's id, this authority's key, 1 byte to 128 KiB with its digest, the run's company and
	-- environment.
	('no secret id', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-13', 'repo-pushes', '{"proof": "github"}'), null)),
		'42501:hook secret envelope is unavailable'),
	('another key', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-14', 'repo-pushes', '{"proof": "github"}'), '204', p_key => 'company-kek-2')),
		'42501:hook secret envelope is unavailable'),
	('empty envelope', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-15', 'repo-pushes', '{"proof": "github"}'), '204', '\x'::bytea)),
		'42501:hook secret envelope is unavailable'),
	('envelope too long', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-16', 'repo-pushes', '{"proof": "github"}'), '204',
			decode(repeat('00', 131073), 'hex'))),
		'42501:hook secret envelope is unavailable'),
	('envelope digest', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-17', 'repo-pushes', '{"proof": "github"}'), '204', p_sha => repeat('0', 64))),
		'42501:hook secret envelope is unavailable'),
	('envelope company', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-18', 'repo-pushes', '{"proof": "github"}'), '204',
			p_company => '98700000-0000-4000-8000-000000000010')),
		'42501:hook secret envelope is unavailable'),
	('envelope environment', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-19', 'repo-pushes', '{"proof": "github"}'), '204',
			p_environment => '98700000-0000-4000-8000-000000000020')),
		'42501:hook secret envelope is unavailable'),
	-- The company's state, after the receipt: a taken id (a broker fault), a taken name.
	('secret id taken', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-20', 'repo-pushes', '{"proof": "github"}'), '201')),
		'42501:hook secret id is taken'),
	('name taken', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-21', 'github-pushes', '{"proof": "github"}'), '204')),
		'23505:A hook with this name already exists'),
	-- The broker's authority and capability, and the company the job is of.
	('describe: no such authority', pg_temp.e3b_call('qorpera_folder_describe_signed_hook', null, null,
		'98700000-0000-4000-8000-000000000049'), '42501:cloud secret broker authority is unavailable'),
	('describe: another capability', pg_temp.e3b_call('qorpera_folder_describe_signed_hook', null, null,
		'98700000-0000-4000-8000-000000000040', repeat('8', 64)), '42501:cloud secret broker authority is unavailable'),
	('describe: no capability', pg_temp.e3b_call('qorpera_folder_describe_signed_hook', null, null,
		'98700000-0000-4000-8000-000000000040', null), '42501:cloud secret broker authority is unavailable'),
	('open: no capability', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-22', 'repo-pushes', '{"proof": "github"}'), '204'), null,
		'98700000-0000-4000-8000-000000000040', null), '42501:cloud secret broker authority is unavailable'),
	('describe: a binding array', pg_temp.e3b_call('qorpera_folder_describe_signed_hook', null, '[]'),
		'22023:hook run binding is malformed'),
	('describe: another company''s broker', pg_temp.e3b_call('qorpera_folder_describe_signed_hook', null, null,
		'98700000-0000-4000-8000-000000000041', repeat('8', 64)), '42501:cloud secret broker does not serve this company'),
	('open: another company''s broker', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-23', 'repo-pushes', '{"proof": "github"}'), '204'), null,
		'98700000-0000-4000-8000-000000000041', repeat('8', 64)), '42501:cloud secret broker does not serve this company'),
	-- A company that is not on the company folder.
	('describe: old core', pg_temp.e3b_call('qorpera_folder_describe_signed_hook', null, current_setting('qorpera_test.b_binding'),
		'98700000-0000-4000-8000-000000000041', repeat('8', 64)), '0A000:Hooks need a company on the company folder'),
	('open: old core', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-24', 'repo-pushes', '{"proof": "github"}'), '204',
			p_company => '98700000-0000-4000-8000-000000000010', p_environment => '98700000-0000-4000-8000-000000000020',
			p_key => 'old-kek-1'),
		current_setting('qorpera_test.b_binding'), '98700000-0000-4000-8000-000000000041', repeat('8', 64)),
		'0A000:Hooks need a company on the company folder')
) as call(name, got, expected);
reset session authorization;
-- The host's path opens no signed hook, and keeps the request's rules.
select set_config('qorpera_test.e3b_b_host', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from expected), ''), true)
from (values
	('github', pg_temp.e3b_host(pg_temp.e3b_create('e3b-b-30', 'repo-pushes', '{"proof": "github"}')),
		'0A000:A signed hook is opened through the vault'),
	('hmac', pg_temp.e3b_host(pg_temp.e3b_create('e3b-b-31', 'repo-pushes', '{"proof": "hmac-sha256", "site": "hooks.example.com"}')),
		'0A000:A signed hook is opened through the vault'),
	('site on an address hook', pg_temp.e3b_host(pg_temp.e3b_create('e3b-b-32', 'repo-pushes', '{"site": "github.com"}')),
		'22023:Only a signed hook names the site its secret is typed into'),
	('stripe', pg_temp.e3b_host(pg_temp.e3b_create('e3b-b-33', 'repo-pushes', '{"proof": "stripe"}')),
		'0A000:A signed hook is opened through the vault'),
	('hmac without a site', pg_temp.e3b_host(pg_temp.e3b_create('e3b-b-34', 'repo-pushes', '{"proof": "hmac-sha256"}')),
		'22023:An HMAC hook names the site its secret is typed into')
) as call(name, got, expected);
-- Postgres' own session is not the broker's.
select set_config('qorpera_test.e3b_b_postgres', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from '42501:cloud secret broker authority is required'), ''), true)
from (values
	('describe', pg_temp.e3b_call('qorpera_folder_describe_signed_hook')),
	('open', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-40', 'repo-pushes', '{"proof": "github"}'), '204'))),
	('fill', pg_temp.e3b_fill('19', pg_temp.e3b_fill_envelope('e3b-b-41', current_setting('qorpera_test.e3b_github_hook'))::text))
) as call(name, got);
-- The run's requester is no longer an owner or admin (written directly, as replica).
select set_config('session_replication_role', 'replica', true);
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
select set_config('session_replication_role', 'origin', true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_b_demoted', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from '42501:Only owners and admins can open hooks; ask one of them'), ''), true)
from (values
	('describe', pg_temp.e3b_call('qorpera_folder_describe_signed_hook')),
	('open', pg_temp.e3b_call('qorpera_folder_open_signed_hook',
		pg_temp.e3b_open_args(pg_temp.e3b_create('e3b-b-50', 'demoted-pushes', '{"proof": "github"}'), '205'))),
	('fill', pg_temp.e3b_fill('19', pg_temp.e3b_fill_envelope('e3b-b-51', current_setting('qorpera_test.e3b_github_hook'))::text))
) as call(name, got);
reset session authorization;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_profile_members set role = 'owner'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
select set_config('session_replication_role', 'origin', true);

do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_b_broker') = '',
		E'B: the broker''s refusals differ:\n' || current_setting('qorpera_test.e3b_b_broker'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_b_host') = '',
		E'B: the host''s refusals differ:\n' || current_setting('qorpera_test.e3b_b_host'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_b_postgres') = '',
		E'B: Postgres'' own session:\n' || current_setting('qorpera_test.e3b_b_postgres'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_b_demoted') = '',
		E'B: a requester who is no longer an owner:\n' || current_setting('qorpera_test.e3b_b_demoted'));
	perform pg_temp.base_assert(pg_temp.e3b_delta(pg_temp.e3b_counts(), current_setting('qorpera_test.e3b_b_before')::jsonb) = '{}'::jsonb,
		'B: a refused call wrote: ' || pg_temp.e3b_delta(pg_temp.e3b_counts(), current_setting('qorpera_test.e3b_b_before')::jsonb)::text);
end $$;

-- C. The fill -------------------------------------------------------------------------------------------------------------

-- 1. The GitHub hook's secret, for the executing receipt of exactly this call; a finished receipt is refused.
select set_config('qorpera_test.e3b_env11',
	pg_temp.e3b_fill_envelope('e3b-fill-1', current_setting('qorpera_test.e3b_github_hook'))::text, true);
set local session authorization qorpera_secret_broker;
select pg_temp.e3b_begin('11', 'computer_browser:e3b-fill-1', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env11')));
select set_config('qorpera_test.e3b_fill11', pg_temp.e3b_fill('11', current_setting('qorpera_test.e3b_env11')), true);
select pg_temp.e3b_end('11', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env11')));
select set_config('qorpera_test.e3b_fill11_done', pg_temp.e3b_fill('11', current_setting('qorpera_test.e3b_env11')), true);
reset session authorization;
-- 2. A paused hook's secret is still typed.
select set_config('qorpera_test.e3b_pause', pg_temp.e3b_host('{"action": "pause", "hook": "github-pushes", "operationKey": "e3b-pause"}'),
	true);
select set_config('qorpera_test.e3b_env12',
	pg_temp.e3b_fill_envelope('e3b-fill-2', current_setting('qorpera_test.e3b_github_hook'))::text, true);
set local session authorization qorpera_secret_broker;
select pg_temp.e3b_begin('12', 'computer_browser:e3b-fill-2', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env12')));
select set_config('qorpera_test.e3b_fill12', pg_temp.e3b_fill('12', current_setting('qorpera_test.e3b_env12')), true);
select pg_temp.e3b_end('12', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env12')));
-- 3. The call, the hook, the computer and the company, on receipt 19 (never begun: each refusal comes before it).
select set_config('qorpera_test.e3b_c_calls', coalesce(string_agg(format('%s: %s', name, got), E'\n' order by name)
	filter (where got is distinct from expected), ''), true)
from (
	select name, expected, pg_temp.e3b_fill('19', envelope, binding, coalesce(authority, '98700000-0000-4000-8000-000000000040'),
		coalesce(capability, repeat('9', 64))) as got
	from (
		select pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook')) as github
	) as base,
	lateral (values
		('address hook', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_plain_hook'))::text, null, null, null,
			'0A000:This hook has no secret the vault types'),
		('no such hook', pg_temp.e3b_fill_envelope('e3b-fill-9', '98700000-0000-4000-8000-000000000999')::text, null, null, null,
			'P0002:No hook has this id'),
		('another company''s hook', pg_temp.e3b_fill_envelope('e3b-fill-9', '98700000-0000-4000-8000-000000000095')::text, null, null, null,
			'P0002:No hook has this id'),
		('no call', null, null, null, null, '22023:hook secret fill call is malformed'),
		('not JSON', 'not json', null, null, null, '22023:hook secret fill call is malformed'),
		('an array', '[]', null, null, null, '22023:hook secret fill call is malformed'),
		('schema v1', jsonb_set(base.github, '{schema}', '"qorpera.cloud-tool-operation/v1"')::text, null, null, null,
			'22023:hook secret fill call is malformed'),
		('another tool', jsonb_set(base.github, '{operation,tool}', '"computer_type"')::text, null, null, null,
			'22023:hook secret fill call is malformed'),
		('tool version v1', jsonb_set(base.github, '{operation,toolVersion}', '"qorpera.company-computer-tools/v1"')::text, null, null, null,
			'22023:hook secret fill call is malformed'),
		('another realm', jsonb_set(base.github, '{operation,target,realm}', '"company"')::text, null, null, null,
			'22023:hook secret fill call is malformed'),
		('a plain fill', jsonb_set(base.github, '{operation,arguments,action}', '"fill"')::text, null, null, null,
			'22023:hook secret fill call is malformed'),
		('field password', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'),
			'{"field": "password"}')::text, null, null, null, '22023:hook secret fill call is malformed'),
		('a spinbutton', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'),
			'{"role": "spinbutton"}')::text, null, null, null, '22023:hook secret fill call is malformed'),
		('an account too', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'),
			'{"account": "98700000-0000-4000-8000-000000000201"}')::text, null, null, null, '22023:hook secret fill call is malformed'),
		('hook not an id', pg_temp.e3b_fill_envelope('e3b-fill-9', 'not-a-uuid')::text, null, null, null,
			'22023:hook secret fill call is malformed'),
		('hook in capitals', pg_temp.e3b_fill_envelope('e3b-fill-9', upper(current_setting('qorpera_test.e3b_github_hook')))::text,
			null, null, null, '22023:hook secret fill call is malformed'),
		('no computer', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'), '{}',
			'{"companyComputerId": null}')::text, null, null, null, '22023:hook secret fill call is malformed'),
		('generation 0', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'), '{}',
			'{"computerGeneration": 0}')::text, null, null, null, '22023:hook secret fill call is malformed'),
		('call too long', base.github::text || repeat(' ', 65536), null, null, null, '22023:hook secret fill call is malformed'),
		('generation 2', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'), '{}',
			'{"computerGeneration": 2}')::text, null, null, null, '42501:company computer lease is unavailable'),
		('another screen', pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'), '{}',
			'{"screenId": "98700000-0000-4000-8000-0000000000b4"}')::text, null, null, null, '42501:company computer lease is unavailable'),
		('old core', pg_temp.e3b_fill_envelope('e3b-fill-9', '98700000-0000-4000-8000-000000000095')::text,
			current_setting('qorpera_test.b_binding'), '98700000-0000-4000-8000-000000000041', repeat('8', 64),
			'0A000:Hooks need a company on the company folder'),
		('no receipt', base.github::text, null, null, null, '42501:hook secret fill receipt is unavailable')
	) as call(name, envelope, binding, authority, capability, expected)
) as result;
-- 4. The receipt: another call's key, another input, another downstream key (or a malformed one).
select set_config('qorpera_test.e3b_env13',
	pg_temp.e3b_fill_envelope('e3b-fill-3', current_setting('qorpera_test.e3b_github_hook'))::text, true);
select pg_temp.e3b_begin('13', 'computer_browser:e3b-other', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env13')));
select set_config('qorpera_test.e3b_fill13', pg_temp.e3b_fill('13', current_setting('qorpera_test.e3b_env13')), true);
select pg_temp.e3b_end('13', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env13')));
select set_config('qorpera_test.e3b_env14',
	pg_temp.e3b_fill_envelope('e3b-fill-4', current_setting('qorpera_test.e3b_github_hook'))::text, true);
select pg_temp.e3b_begin('14', 'computer_browser:e3b-fill-4');
select set_config('qorpera_test.e3b_fill14', pg_temp.e3b_fill('14', current_setting('qorpera_test.e3b_env14')), true);
select pg_temp.e3b_end('14');
select set_config('qorpera_test.e3b_env15',
	pg_temp.e3b_fill_envelope('e3b-fill-5', current_setting('qorpera_test.e3b_github_hook'))::text, true);
select pg_temp.e3b_begin('15', 'computer_browser:e3b-fill-5', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env15')));
select set_config('qorpera_test.e3b_fill15', pg_temp.e3b_fill('15', current_setting('qorpera_test.e3b_env15'),
	p_downstream => repeat('c', 64)), true);
select set_config('qorpera_test.e3b_fill15_upper', pg_temp.e3b_fill('15', current_setting('qorpera_test.e3b_env15'),
	p_downstream => repeat('B', 64)), true);
select pg_temp.e3b_end('15', pg_temp.e3b_sha(current_setting('qorpera_test.e3b_env15')));
reset session authorization;
-- 5. A version sealed under another key (written directly, as replica).
select set_config('session_replication_role', 'replica', true);
update public.qorpera_cloud_secret_versions set key_id = 'company-kek-2' where secret_id = '98700000-0000-4000-8000-000000000201';
select set_config('session_replication_role', 'origin', true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_fill_key2', pg_temp.e3b_fill('19',
	pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'))::text), true);
reset session authorization;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_cloud_secret_versions set key_id = 'company-kek-1' where secret_id = '98700000-0000-4000-8000-000000000201';
select set_config('session_replication_role', 'origin', true);
-- 6. A1's fill refuses a hook's call: switched off, then as no such account.
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_a1_off', pg_temp.e3b_fill('19',
	pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'))::text,
	p_function => 'qorpera_fill_company_account'), true);
reset session authorization;
update public.qorpera_company_account_settings set enabled = true;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_a1_on', pg_temp.e3b_fill('19',
	pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'))::text,
	p_function => 'qorpera_fill_company_account'), true);
reset session authorization;
update public.qorpera_company_account_settings set enabled = false;
-- 7. A removed hook: refused, and its secret revoked with it.
select set_config('qorpera_test.e3b_remove', pg_temp.e3b_host('{"action": "remove", "hook": "shop-orders", "operationKey": "e3b-remove"}'),
	true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_fill_removed', pg_temp.e3b_fill('19',
	pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_hmac_hook'))::text), true);
reset session authorization;

do $$
declare
	v_github uuid := current_setting('qorpera_test.e3b_github_hook')::uuid;
	v_made uuid;
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_fill11') = 'ok:' || jsonb_build_object(
			'schema', 'qorpera.event-hook-fill-context/v1', 'hookId', v_github, 'proof', 'github', 'site', 'github.com',
			'secretId', '98700000-0000-4000-8000-000000000201', 'version', 1,
			'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', '92400000-0000-4000-8000-000000000020',
			'keyId', 'company-kek-1', 'encryptedEnvelopeBase64', 'AgE=',
			'envelopeSha256', encode(extensions.digest('\x0201'::bytea, 'sha256'), 'hex'),
			'receiptId', '98700000-0000-4000-8000-000000000111', 'field', 'signing_secret',
			'companyComputerId', '98700000-0000-4000-8000-0000000000a1', 'computerGeneration', 1,
			'fillPublicKey', current_setting('qorpera_test.e3b_fill_key'))::text,
		'C: the fill: ' || current_setting('qorpera_test.e3b_fill11'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_fill11_done') = '42501:hook secret fill receipt is unavailable',
		'C: a finished receipt: ' || current_setting('qorpera_test.e3b_fill11_done'));
	-- A signed hook's pause answers as E3a's do: no secretSite, which only a create's answer has.
	perform pg_temp.base_assert(pg_temp.e3b_answer(current_setting('qorpera_test.e3b_pause')) #>> '{hook,status}' = 'paused'
			and (select array_agg(k order by k) from jsonb_object_keys(pg_temp.e3b_answer(current_setting('qorpera_test.e3b_pause'))) k)
				= array['action', 'hook', 'receiptId', 'runId', 'schema']
			and pg_temp.e3b_answer(current_setting('qorpera_test.e3b_fill12')) ->> 'hookId' = v_github::text
			and pg_temp.e3b_answer(current_setting('qorpera_test.e3b_fill12')) ->> 'receiptId' = '98700000-0000-4000-8000-000000000112',
		'C: a paused hook''s fill: ' || current_setting('qorpera_test.e3b_pause') || ' / ' || current_setting('qorpera_test.e3b_fill12'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_c_calls') = '',
		E'C: the fill''s refusals differ:\n' || current_setting('qorpera_test.e3b_c_calls'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_fill13') = '42501:hook secret fill receipt is unavailable'
			and current_setting('qorpera_test.e3b_fill14') = '42501:hook secret fill receipt is unavailable'
			and current_setting('qorpera_test.e3b_fill15') = '42501:hook secret fill receipt is unavailable'
			and current_setting('qorpera_test.e3b_fill15_upper') = '42501:hook secret fill receipt is unavailable',
		'C: another receipt: ' || current_setting('qorpera_test.e3b_fill13') || ' / ' || current_setting('qorpera_test.e3b_fill14')
			|| ' / ' || current_setting('qorpera_test.e3b_fill15') || ' / ' || current_setting('qorpera_test.e3b_fill15_upper'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_fill_key2') = '42501:hook secret version is unavailable',
		'C: a version under another key: ' || current_setting('qorpera_test.e3b_fill_key2'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_a1_off') = '0A000:Company accounts are switched off'
			and current_setting('qorpera_test.e3b_a1_on') = '22023:The company has no such open account',
		'C: A1''s fill: ' || current_setting('qorpera_test.e3b_a1_off') || ' / ' || current_setting('qorpera_test.e3b_a1_on'));
	perform pg_temp.base_assert(pg_temp.e3b_answer(current_setting('qorpera_test.e3b_remove')) #>> '{hook,status}' = 'removed'
			and not pg_temp.e3b_answer(current_setting('qorpera_test.e3b_remove')) ? 'secretSite'
			and current_setting('qorpera_test.e3b_fill_removed') = '55000:This hook was removed',
		'C: a removed hook: ' || current_setting('qorpera_test.e3b_remove') || ' / ' || current_setting('qorpera_test.e3b_fill_removed'));
	perform pg_temp.base_assert((select status from public.qorpera_cloud_secrets where id = '98700000-0000-4000-8000-000000000203') = 'revoked'
			and (select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
				where secret_id = '98700000-0000-4000-8000-000000000203') = array['hook_secret_made', 'secret_revoked']
			and (select count(*) from public.qorpera_cloud_secret_versions where secret_id = '98700000-0000-4000-8000-000000000203') = 1,
		'C: the removal revokes the hook''s secret');
	-- Each fill typed once, under its own receipt, for the run's requester.
	select receipt_id into v_made from public.qorpera_cloud_secret_audit_events
	where secret_id = '98700000-0000-4000-8000-000000000201' and event_type = 'hook_secret_made';
	perform pg_temp.base_assert((select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
				where secret_id = '98700000-0000-4000-8000-000000000201') = array['hook_secret_made', 'hook_secret_used', 'hook_secret_used']
			and (select array_agg(receipt_id order by id) from public.qorpera_cloud_secret_audit_events
				where secret_id = '98700000-0000-4000-8000-000000000201')
				= array[v_made, '98700000-0000-4000-8000-000000000111', '98700000-0000-4000-8000-000000000112']::uuid[]
			and not exists (select 1 from public.qorpera_cloud_secret_audit_events where secret_id = '98700000-0000-4000-8000-000000000201'
				and (actor_user_id is distinct from '92400000-0000-4000-8000-000000000001' or connector_id <> 'event_hook')),
		'C: the GitHub hook''s audit: ' || (select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
			where secret_id = '98700000-0000-4000-8000-000000000201')::text);
end $$;

-- 8. A secret gone from the vault (revoked directly, as replica).
select set_config('session_replication_role', 'replica', true);
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(), updated_at = statement_timestamp()
where id = '98700000-0000-4000-8000-000000000201';
select set_config('session_replication_role', 'origin', true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3b_fill_gone', pg_temp.e3b_fill('19',
	pg_temp.e3b_fill_envelope('e3b-fill-9', current_setting('qorpera_test.e3b_github_hook'))::text), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.e3b_fill_gone') = '55000:This hook''s secret is gone from the vault',
		'C: a revoked secret: ' || current_setting('qorpera_test.e3b_fill_gone'));
end $$;

-- D. The browser action, the grants, the marker and the bodies ------------------------------------------------------------

do $$
declare
	v_hook jsonb := '{"kind": "browser", "action": "vault_fill", "role": "textbox", "name": "Signing secret",
		"field": "signing_secret", "hook": "98700000-0000-4000-8000-000000000201"}';
	v_function text;
	v_role text;
begin
	-- The hook variant of vault_fill: a text box, the signing secret, a hook's id; A1's variant is as it was.
	perform pg_temp.base_assert(public.qorpera_valid_office_browser_action(v_hook)
			and public.qorpera_valid_office_browser_action('{"kind": "browser", "action": "vault_fill", "role": "spinbutton",
				"name": "Code", "field": "code", "account": "98700000-0000-4000-8000-000000000201"}'),
		'D: the two variants of vault_fill');
	perform pg_temp.base_assert(not public.qorpera_valid_office_browser_action(v_hook || '{"role": "spinbutton"}')
			and not public.qorpera_valid_office_browser_action(v_hook || '{"field": "password"}')
			and not public.qorpera_valid_office_browser_action(v_hook || '{"account": "98700000-0000-4000-8000-000000000201"}')
			and not public.qorpera_valid_office_browser_action(v_hook || '{"hook": "98700000-0000-4000-A000-0000000002AB"}')
			and not public.qorpera_valid_office_browser_action(v_hook - 'field'),
		'D: a malformed hook variant is valid');
	-- The effect and the authority check are no role's; the broker calls three functions; the host manage_hook.
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array[
			'public.qorpera_folder_manage_hook_effect(jsonb,jsonb,public.qorpera_cloud_secret_broker_authorities,uuid,uuid,uuid,text,bytea,text,text)',
			'public.qorpera_folder_signed_hook_authority(uuid,text,jsonb)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'execute'), format('D: %s runs %s', v_role, v_function));
		end loop;
		foreach v_function in array array['public.qorpera_folder_describe_signed_hook(uuid,text,jsonb)',
			'public.qorpera_folder_open_signed_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,bytea,text)',
			'public.qorpera_fill_event_hook_secret(uuid,text,jsonb,uuid,text,text)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'execute') = (v_role = 'qorpera_secret_broker'),
				format('D: %s and %s', v_role, v_function));
		end loop;
		perform pg_temp.base_assert(has_function_privilege(v_role, 'public.qorpera_folder_manage_hook(jsonb,jsonb)', 'execute')
			= (v_role = 'service_role'), format('D: %s and manage_hook', v_role));
	end loop;
	perform pg_temp.base_assert((select array_agg(proname::text order by proname collate "C") from pg_proc
			where pronamespace = 'public'::regnamespace and prosrc like '%20260930160000%') = array['qorpera_fill_event_hook_secret',
			'qorpera_folder_describe_signed_hook', 'qorpera_folder_manage_hook', 'qorpera_folder_manage_hook_effect',
			'qorpera_folder_open_signed_hook', 'qorpera_folder_signed_hook_authority', 'qorpera_valid_office_browser_action'],
		'D: the functions naming 20260930160000: ' || (select array_agg(proname::text order by proname collate "C") from pg_proc
			where pronamespace = 'public'::regnamespace and prosrc like '%20260930160000%')::text);
end $$;

-- Each function's text without comments, so a comment never counts as code.
create temporary table e3b_code on commit drop as
select p.proname::text as name, lower(regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'gs'), '--[^\n]*', '', 'g')) as src
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('qorpera_folder_manage_hook_effect',
	'qorpera_folder_signed_hook_authority', 'qorpera_folder_describe_signed_hook', 'qorpera_folder_open_signed_hook',
	'qorpera_fill_event_hook_secret');
-- Where a text first appears in a function's code (null when it does not), and how often.
create function pg_temp.e3b_at(p_name text, p_text text) returns integer language sql as $$
	select nullif(position(lower(p_text) in src), 0) from e3b_code where name = p_name
$$;
create function pg_temp.e3b_times(p_name text, p_text text) returns integer language sql as $$
	select (length(src) - length(replace(src, lower(p_text), ''))) / length(p_text) from e3b_code where name = p_name
$$;
do $$
begin
	perform pg_temp.base_assert((select count(*) from e3b_code) = 5, 'D: the functions'' code');
	-- The broker's checks before the run's locks; the authority check takes no lock.
	perform pg_temp.base_assert(pg_temp.e3b_at('qorpera_folder_describe_signed_hook', 'qorpera_folder_signed_hook_authority(')
			< pg_temp.e3b_at('qorpera_folder_describe_signed_hook', 'qorpera_folder_tool_run(')
			and pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'qorpera_folder_signed_hook_authority(')
			< pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'qorpera_folder_tool_run(')
			and pg_temp.e3b_times('qorpera_folder_signed_hook_authority', 'for share') = 0
			and pg_temp.e3b_times('qorpera_folder_signed_hook_authority', 'for update') = 0
			and pg_temp.e3b_times('qorpera_folder_signed_hook_authority', 'pg_advisory') = 0,
		'D: the broker''s checks come before any lock');
	-- The effect checks the envelope before the run; it begins the receipt, then claims the company, then inserts.
	perform pg_temp.base_assert(pg_temp.e3b_at('qorpera_folder_manage_hook_effect', 'hook secret envelope is unavailable')
			< pg_temp.e3b_at('qorpera_folder_manage_hook_effect', 'qorpera_folder_tool_run(')
			and pg_temp.e3b_at('qorpera_folder_manage_hook_effect', 'qorpera_folder_begin_run_receipt(')
			< pg_temp.e3b_at('qorpera_folder_manage_hook_effect', 'pg_advisory_xact_lock(')
			and pg_temp.e3b_at('qorpera_folder_manage_hook_effect', 'pg_advisory_xact_lock(')
			< pg_temp.e3b_at('qorpera_folder_manage_hook_effect', 'insert into public.qorpera_cloud_secrets')
			and pg_temp.e3b_times('qorpera_folder_manage_hook_effect', 'pg_advisory') = 1,
		'D: the effect''s order');
	-- The fill: the hook through the run check, then its secret FOR SHARE, then the receipt FOR UPDATE.
	perform pg_temp.base_assert(pg_temp.e3b_times('qorpera_fill_event_hook_secret', 'for share') = 1
			and pg_temp.e3b_times('qorpera_fill_event_hook_secret', 'for update') = 1
			and pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'qorpera_folder_tool_run(')
			< pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'from public.qorpera_cloud_secrets as secret')
			and pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'from public.qorpera_cloud_secrets as secret')
			< pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'for share')
			and pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'for share')
			< pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'from public.qorpera_run_operation_receipts as receipt')
			and pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'from public.qorpera_run_operation_receipts as receipt')
			< pg_temp.e3b_at('qorpera_fill_event_hook_secret', 'for update'),
		'D: the fill''s lock order');
end $$;

rollback;
