-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

-- The company's broker authority; another company's, with its own running machine of the same name.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('12790000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12790000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12790000-0000-4000-8000-000000000012', '12790000-0000-4000-8000-000000000011', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
select set_config('session_replication_role', 'origin', true);
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('12790000-0000-4000-8000-000000000041', '12790000-0000-4000-8000-000000000011', 'https://broker.example.test',
	'other-kek-1', repeat('8', 64));

-- Accounts switched on, the mail domain, the company's mailbox 'agents' (written directly, as 925 does), Alice's open todo,
-- and the run's acknowledgement (a member's wake requires it before any tool).
update public.qorpera_company_account_settings set enabled = true;
update public.qorpera_mail_settings set domain = 'nordlys.example';
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_mailboxes(hook_id, profile_id, environment_id, local_part)
values ('12790000-0000-4000-8000-000000000090', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'agents');
select set_config('session_replication_role', 'origin', true);
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
	requested_by_user_id, created_by_run_id, updated_by_run_id)
select '12790000-0000-4000-8000-000000000060', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000030', 'npm-publish', 'Publish the SDK to npm', 'open', '92400000-0000-4000-8000-000000000001',
	run.id, run.id
from (select (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid as id) as run;
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'af-ack') \g /dev/null

-- The company's task machine m-1196, started by Alice's run and running a boot on its placement (reserved on a node, as an
-- executor's custody leaves it) under executor mx-1196; a stopped one; and another company's machine of the same name.
select set_config('session_replication_role', 'replica', true);
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
	started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
	desired_state)
select machine.id, machine.profile_id, machine.environment_id, machine.name, 'Signs in.', run.staff_agent_id, run.id,
	machine.receipt_id, run.requested_by_user_id, 2, 4294967296, 21474836480, 'standard', 'task', machine.desired_state
from public.qorpera_execution_runs as run
cross join (values
	('12790000-0000-4000-8000-0000000007a1'::uuid, '92400000-0000-4000-8000-000000000010'::uuid,
		'92400000-0000-4000-8000-000000000020'::uuid, 'm-1196', '12790000-0000-4000-8000-0000000007a9'::uuid, 'running'),
	('12790000-0000-4000-8000-0000000007a2', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'm-1196-asleep', '12790000-0000-4000-8000-0000000007aa', 'stopped'),
	('12790000-0000-4000-8000-0000000007a3', '12790000-0000-4000-8000-000000000011', '12790000-0000-4000-8000-000000000012',
		'm-1196', '12790000-0000-4000-8000-0000000007ab', 'running')
) as machine(id, profile_id, environment_id, name, receipt_id, desired_state)
where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding,
	instance_sha256, running_at, boot_id)
values ('12790000-0000-4000-8000-0000000007b1', '12790000-0000-4000-8000-0000000007a1', '92400000-0000-4000-8000-000000000010',
		'mx-1196', repeat('8', 64), '{"providerId": "machine-1196"}', repeat('7', 64), clock_timestamp(),
		'12790000-0000-4000-8000-0000000007c1'),
	('12790000-0000-4000-8000-0000000007b3', '12790000-0000-4000-8000-0000000007a3', '12790000-0000-4000-8000-000000000011',
		'mx-1196', repeat('8', 64), '{"providerId": "machine-1196"}', repeat('6', 64), clock_timestamp(),
		'12790000-0000-4000-8000-0000000007c3');
insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter,
	instance_sha256, reserved_at)
select placement.id, placement.profile_id, placement.id, 'lxd', placement.instance_sha256, clock_timestamp()
from public.qorpera_company_machine_placements as placement
where placement.id in ('12790000-0000-4000-8000-0000000007b1', '12790000-0000-4000-8000-0000000007b3');
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
	memory_bytes, reserved_at)
select placement.id, '12790000-0000-4000-8000-0000000007d1', 'machine', 'machine-1196', repeat('4', 64), 2000, 4294967296,
	clock_timestamp()
from public.qorpera_company_machine_placements as placement
where placement.id in ('12790000-0000-4000-8000-0000000007b1', '12790000-0000-4000-8000-0000000007b3');
select set_config('session_replication_role', 'origin', true);

-- The helper's public key, as it prints it (the public half of an X25519 key, base64url without padding).
select set_config('qorpera_test.af_key',
	rtrim(translate(encode(extensions.digest('a 1196 helper key', 'sha256'), 'base64'), '+/', '-_'), '='), true);

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.af_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.af_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
create function pg_temp.af_sha(p_text text) returns text language sql security definer as $$
	select encode(extensions.digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex')
$$;
create function pg_temp.af_begin(p_n text, p_key text, p_input text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('12790000-0000-4000-8000-0000000001' || p_n)::uuid, p_key, p_input, repeat('e', 64), false);
end $$;
create function pg_temp.af_end(p_n text, p_input text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		('12790000-0000-4000-8000-0000000001' || p_n)::uuid, p_input, '{}'::jsonb);
end $$;
-- One fill_company_account call's operation envelope, as the machine tools write it: the password of the account opened in
-- 1 into m-1196, unless the arguments (p_args), the operation (p_operation) or the target (p_target) change.
create function pg_temp.af_envelope(p_key text, p_args jsonb default '{}', p_operation jsonb default '{}',
	p_target jsonb default '{}') returns text
language plpgsql security definer as $$
begin
	perform pg_temp.base_claims('service_role');
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb) -> 'identity')
			- array['assignmentId', 'runnerId', 'leaseId', 'sponsorVersion', 'providerConnectionId', 'providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'fill_company_account', 'toolVersion', 'qorpera.machine-tools/v1',
			'logicalOperationKey', p_key, 'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('operationKey', p_key, 'machine', 'm-1196',
				'account', current_setting('qorpera_test.af_account'), 'field', 'password') || p_args,
			'target', jsonb_build_object('realm', 'company_machine', 'machineId', '12790000-0000-4000-8000-0000000007a1')
				|| p_target) || p_operation)::text;
end $$;
-- Receipt n begins as the call of an envelope (as fill_company_account's receipt unless another tool's key is named).
create function pg_temp.af_mbegin(p_n text, p_envelope text, p_tool text default 'fill_company_account') returns void
language plpgsql security definer as $$
begin
	perform pg_temp.af_begin(p_n, p_tool || ':' || (p_envelope::jsonb #>> '{operation,logicalOperationKey}'), pg_temp.af_sha(p_envelope));
end $$;
create function pg_temp.af_mend(p_n text, p_envelope text) returns void language plpgsql security definer as $$
begin
	perform pg_temp.af_end(p_n, pg_temp.af_sha(p_envelope));
end $$;
-- The coding executor's read of receipt n's call, as the service role, for m-1196 unless another machine is named.
create function pg_temp.af_exec(p_n text, p_envelope text, p_machine text default '12790000-0000-4000-8000-0000000007a1')
returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := pg_temp.af_try(format('select public.qorpera_authorize_machine_account_fill(%L::jsonb, %L::jsonb, %L, %L)',
		current_setting('qorpera_test.base_binding'), jsonb_build_object('machineId', p_machine),
		'12790000-0000-4000-8000-0000000001' || p_n, p_envelope));
	reset role;
	return v;
end $$;
-- The broker's read of receipt n's call, with what the executor names: its owner, the placement, the boot and the helper's
-- key (m-1196's by default), on Alice's binding with the company's authority.
create function pg_temp.af_call(p_n text, p_envelope text, p_owner text default 'mx-1196',
	p_placement text default '12790000-0000-4000-8000-0000000007b1', p_boot text default '12790000-0000-4000-8000-0000000007c1',
	p_key text default null, p_downstream text default repeat('e', 64),
	p_authority text default '12790000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '', true);
	return pg_temp.af_try(format('select public.qorpera_fill_company_account_on_machine(%L, %L, %L::jsonb, %L, %L, %L, %L, %L, %L, %L)',
		p_authority, p_capability, current_setting('qorpera_test.base_binding'), '12790000-0000-4000-8000-0000000001' || p_n,
		p_envelope, p_downstream, p_owner, p_placement, p_boot, coalesce(p_key, current_setting('qorpera_test.af_key'))));
end $$;
create function pg_temp.af_counts() returns jsonb language sql security definer as $$
	select jsonb_build_object('events', (select count(*) from public.qorpera_cloud_secret_audit_events),
		'used', (select count(*) from public.qorpera_company_accounts where last_used_at is not null),
		'receipts', (select count(*) from public.qorpera_run_operation_receipts))
$$;
-- The test's refusals that differ from what they expect, one per line.
create function pg_temp.af_differ(p_calls jsonb) returns text language sql as $$
	select coalesce(string_agg(format('%s: %s', c ->> 0, c ->> 1), E'\n' order by c ->> 0)
		filter (where c ->> 1 is distinct from c ->> 2), '')
	from jsonb_array_elements(p_calls) as c
$$;
grant execute on function pg_temp.af_try(text), pg_temp.af_answer(text), pg_temp.af_sha(text), pg_temp.af_begin(text, text, text),
	pg_temp.af_end(text, text), pg_temp.af_mbegin(text, text, text), pg_temp.af_mend(text, text),
	pg_temp.af_call(text, text, text, text, text, text, text, text, text), pg_temp.af_counts(), pg_temp.af_differ(jsonb)
	to qorpera_secret_broker;
grant execute on function pg_temp.af_try(text) to service_role;

-- 1. The account, opened as A1 opens one, and a full fill -------------------------------------------------------------------

-- The vault's own opening (the company has no computer): Alice's todo, the tagged login, a dummy envelope under the key
-- (its digest taken here: the broker reads no extension).
select set_config('qorpera_test.af_envelope_sha', encode(extensions.digest('\x0196'::bytea, 'sha256'), 'hex'), true);
set local session authorization qorpera_secret_broker;
select pg_temp.af_begin('01', 'company_account:open:af-open', repeat('a', 64));
select set_config('qorpera_test.af_open', pg_temp.af_try(format(
	'select public.qorpera_open_company_account(%L, %L, %L::jsonb, %L, repeat(''a'', 64), repeat(''e'', 64), %L, %L, %L, '
		|| '''npmjs.com'', ''{www.npmjs.com}''::text[], ''agents+npmjs.com@nordlys.example'', ''Publishes the SDK.'', %L, '
		|| '''company-kek-1'', ''\x0196''::bytea, %L)',
	'12790000-0000-4000-8000-000000000040', repeat('9', 64), current_setting('qorpera_test.base_binding'),
	'12790000-0000-4000-8000-000000000101', '12790000-0000-4000-8000-000000000201', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '12790000-0000-4000-8000-000000000060',
	current_setting('qorpera_test.af_envelope_sha'))), true);
select pg_temp.af_end('01', repeat('a', 64));
reset session authorization;
select set_config('qorpera_test.af_account', coalesce(pg_temp.af_answer(current_setting('qorpera_test.af_open')) ->> 'accountId',
	'no account'), true);

select set_config('qorpera_test.af_env11', pg_temp.af_envelope('af-11'), true);
select pg_temp.af_mbegin('11', current_setting('qorpera_test.af_env11'));
select set_config('qorpera_test.af_exec11', pg_temp.af_exec('11', current_setting('qorpera_test.af_env11')), true);
select set_config('qorpera_test.af_c10', pg_temp.af_counts()::text, true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.af_read11', pg_temp.af_call('11', current_setting('qorpera_test.af_env11')), true);
select set_config('qorpera_test.af_c11', pg_temp.af_counts()::text, true);
reset session authorization;
select pg_temp.af_mend('11', current_setting('qorpera_test.af_env11'));

do $$
declare
	v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_open jsonb := pg_temp.af_answer(current_setting('qorpera_test.af_open'));
	v_exec jsonb := pg_temp.af_answer(current_setting('qorpera_test.af_exec11'));
	v_read jsonb := pg_temp.af_answer(current_setting('qorpera_test.af_read11'));
	v_account uuid := current_setting('qorpera_test.af_account')::uuid;
begin
	perform pg_temp.base_assert(v_open = jsonb_build_object('schema', 'qorpera.company-account/v1',
			'accountId', '12790000-0000-4000-8000-000000000201', 'site', 'npmjs.com', 'signInHosts', jsonb_build_array('www.npmjs.com'),
			'login', 'agents+npmjs.com@nordlys.example', 'twoStep', 'none', 'status', 'pending', 'version', 1)
			and not exists (select 1 from public.qorpera_runtime_offices where profile_id = '92400000-0000-4000-8000-000000000010'),
		'1: the account opens on a company with a machine and no computer: ' || current_setting('qorpera_test.af_open'));
	-- The executor's read: where m-1196 runs, and what the helper binds the box to and checks the page against.
	perform pg_temp.base_assert(v_exec = jsonb_build_object('schema', 'qorpera.machine-account-fill-authority/v1',
			'state', 'authorized', 'machineId', '12790000-0000-4000-8000-0000000007a1',
			'placementId', '12790000-0000-4000-8000-0000000007b1', 'bootId', '12790000-0000-4000-8000-0000000007c1',
			'executorOwner', 'mx-1196', 'providerId', 'machine-1196', 'receiptId', '12790000-0000-4000-8000-000000000111',
			'companyId', '92400000-0000-4000-8000-000000000010', 'desktopGeneration', 0,
			'target', jsonb_build_object('schema', 'qorpera.machine-account-fill-target/v1',
				'companyId', '92400000-0000-4000-8000-000000000010', 'companyMachineId', '12790000-0000-4000-8000-0000000007a1',
				'placementId', '12790000-0000-4000-8000-0000000007b1', 'bootId', '12790000-0000-4000-8000-0000000007c1',
				'receiptId', '12790000-0000-4000-8000-000000000111', 'accountId', v_account, 'field', 'password',
				'hosts', jsonb_build_array('npmjs.com', 'www.npmjs.com'))),
		'1: the executor''s read: ' || current_setting('qorpera_test.af_exec11'));
	-- The broker's read: the account's facts, the envelope with its associated data, and what the box is bound to.
	perform pg_temp.base_assert(v_read = jsonb_build_object('schema', 'qorpera.company-account-machine-fill-context/v1',
			'accountId', v_account, 'site', 'npmjs.com', 'signInHosts', jsonb_build_array('www.npmjs.com'),
			'login', 'agents+npmjs.com@nordlys.example', 'twoStep', 'none', 'status', 'pending', 'version', 1,
			'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', '92400000-0000-4000-8000-000000000020',
			'keyId', 'company-kek-1', 'encryptedEnvelopeBase64', encode('\x0196'::bytea, 'base64'),
			'envelopeSha256', encode(extensions.digest('\x0196'::bytea, 'sha256'), 'hex'),
			'receiptId', '12790000-0000-4000-8000-000000000111', 'field', 'password',
			'companyMachineId', '12790000-0000-4000-8000-0000000007a1', 'placementId', '12790000-0000-4000-8000-0000000007b1',
			'bootId', '12790000-0000-4000-8000-0000000007c1', 'fillPublicKey', current_setting('qorpera_test.af_key')),
		'1: the broker''s read: ' || current_setting('qorpera_test.af_read11'));
	-- The use is recorded once, on this receipt; the executor's read wrote nothing.
	perform pg_temp.base_assert((current_setting('qorpera_test.af_c11')::jsonb ->> 'events')::bigint
				= (current_setting('qorpera_test.af_c10')::jsonb ->> 'events')::bigint + 1
			and (select array_agg(event_type order by id) from public.qorpera_cloud_secret_audit_events
				where receipt_id = '12790000-0000-4000-8000-000000000111' and run_id = v_run) = array['account_used']
			and exists (select 1 from public.qorpera_company_accounts where secret_id = v_account and last_used_at is not null
				and last_used_by_staff_agent_id = '92400000-0000-4000-8000-000000000030'),
		'1: the use is recorded: ' || current_setting('qorpera_test.af_c11'));
end $$;

-- 2. What the agent can act on: answered by the executor's read, refused by the broker's; nothing written ------------------

select set_config('qorpera_test.af_env21', pg_temp.af_envelope('af-21'), true);
select pg_temp.af_mbegin('21', current_setting('qorpera_test.af_env21'));
select set_config('qorpera_test.af_c20', pg_temp.af_counts()::text, true);
-- Accounts switched off (each case is asserted inside its savepoint: a rollback to it undoes the settings too).
savepoint af_off;
update public.qorpera_company_account_settings set enabled = false;
select set_config('qorpera_test.af_2a', pg_temp.af_exec('21', current_setting('qorpera_test.af_env21')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.af_2b', pg_temp.af_call('21', current_setting('qorpera_test.af_env21')), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(pg_temp.af_answer(current_setting('qorpera_test.af_2a')) = jsonb_build_object(
			'schema', 'qorpera.machine-account-fill-authority/v1', 'state', 'refused', 'reason', 'ACCOUNTS_SWITCHED_OFF')
			and current_setting('qorpera_test.af_2b') = '0A000:Company accounts are switched off',
		'2: switched off: ' || current_setting('qorpera_test.af_2a') || ' / ' || current_setting('qorpera_test.af_2b'));
end $$;
rollback to savepoint af_off;
-- A requester who is a contributor: accounts are the company's (as for the office's fill and an opening), so the
-- executor's read authorizes the fill and the broker's read answers the account, recording its use.
savepoint af_contributor;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.af_2a', pg_temp.af_exec('21', current_setting('qorpera_test.af_env21')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.af_2b', pg_temp.af_call('21', current_setting('qorpera_test.af_env21')), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(pg_temp.af_answer(current_setting('qorpera_test.af_2a')) ->> 'state' = 'authorized'
			and pg_temp.af_answer(current_setting('qorpera_test.af_2b')) ->> 'schema'
				= 'qorpera.company-account-machine-fill-context/v1'
			and pg_temp.af_answer(current_setting('qorpera_test.af_2b')) ->> 'receiptId' = '12790000-0000-4000-8000-000000000121',
		'2: a contributor requester fills: ' || current_setting('qorpera_test.af_2a') || ' / ' || current_setting('qorpera_test.af_2b'));
end $$;
rollback to savepoint af_contributor;
-- A requester who is no longer a member: the run check (its member row, required at rank 1) refuses the broker's read.
savepoint af_left;
select set_config('session_replication_role', 'replica', true);
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.af_2a', pg_temp.af_exec('21', current_setting('qorpera_test.af_env21')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.af_2b', pg_temp.af_call('21', current_setting('qorpera_test.af_env21')), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.af_2b') like '42501:%'
			and coalesce(pg_temp.af_answer(current_setting('qorpera_test.af_2a')) ->> 'state', 'raised') <> 'authorized',
		'2: a requester no longer a member: ' || current_setting('qorpera_test.af_2a') || ' / '
			|| current_setting('qorpera_test.af_2b'));
end $$;
rollback to savepoint af_left;
-- A closed account: its vault row revoked, as a close or a member's removal revokes it (the trigger closes the account).
savepoint af_closed;
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(), updated_at = statement_timestamp()
where id = current_setting('qorpera_test.af_account')::uuid;
select set_config('qorpera_test.af_2a', pg_temp.af_exec('21', current_setting('qorpera_test.af_env21')), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.af_2b', pg_temp.af_call('21', current_setting('qorpera_test.af_env21')), true);
reset session authorization;
do $$
begin
	perform pg_temp.base_assert(pg_temp.af_answer(current_setting('qorpera_test.af_2a')) = jsonb_build_object(
			'schema', 'qorpera.machine-account-fill-authority/v1', 'state', 'refused', 'reason', 'ACCOUNT_NOT_OPEN')
			and current_setting('qorpera_test.af_2b') = '22023:The company has no such open account'
			and (select status from public.qorpera_company_accounts
				where secret_id = current_setting('qorpera_test.af_account')::uuid) = 'closed',
		'2: a closed account: ' || current_setting('qorpera_test.af_2a') || ' / ' || current_setting('qorpera_test.af_2b'));
end $$;
rollback to savepoint af_closed;
savepoint af_member_holds;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_company_machines set desktop_member_user_id = '92400000-0000-4000-8000-000000000001',
	desktop_member_since = clock_timestamp(), desktop_member_until = clock_timestamp() + interval '5 minutes'
where id = '12790000-0000-4000-8000-0000000007a1';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.af_2a', pg_temp.af_exec('21', current_setting('qorpera_test.af_env21')), true);
do $$
begin
	perform pg_temp.base_assert(pg_temp.af_answer(current_setting('qorpera_test.af_2a')) = jsonb_build_object(
			'schema', 'qorpera.machine-account-fill-authority/v1', 'state', 'refused', 'reason', 'DESKTOP_MEMBER_IN_CONTROL',
			'machine', 'm-1196'),
		'2: a member holds the desktop: ' || current_setting('qorpera_test.af_2a'));
end $$;
rollback to savepoint af_member_holds;
savepoint af_generation;
select set_config('session_replication_role', 'replica', true);
update public.qorpera_company_machines set desktop_member_generation = 7 where id = '12790000-0000-4000-8000-0000000007a1';
select set_config('session_replication_role', 'origin', true);
select set_config('qorpera_test.af_2a', pg_temp.af_exec('21', current_setting('qorpera_test.af_env21')), true);
do $$
begin
	perform pg_temp.base_assert(pg_temp.af_answer(current_setting('qorpera_test.af_2a')) ->> 'state' = 'authorized'
			and pg_temp.af_answer(current_setting('qorpera_test.af_2a')) -> 'desktopGeneration' = '7'::jsonb,
		'2: the fill answers the desktop generation it saw: ' || current_setting('qorpera_test.af_2a'));
end $$;
rollback to savepoint af_generation;
select set_config('qorpera_test.af_c21', pg_temp.af_counts()::text, true);
select pg_temp.af_mend('21', current_setting('qorpera_test.af_env21'));
-- The company's stopped machine: its own receipt.
select set_config('qorpera_test.af_env22', pg_temp.af_envelope('af-22', '{"machine": "m-1196-asleep"}', '{}',
	'{"machineId": "12790000-0000-4000-8000-0000000007a2"}'), true);
select pg_temp.af_mbegin('22', current_setting('qorpera_test.af_env22'));
select set_config('qorpera_test.af_2stop', pg_temp.af_exec('22', current_setting('qorpera_test.af_env22'),
	'12790000-0000-4000-8000-0000000007a2'), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.af_2stopb', pg_temp.af_call('22', current_setting('qorpera_test.af_env22')), true);
reset session authorization;
select pg_temp.af_mend('22', current_setting('qorpera_test.af_env22'));
select set_config('qorpera_test.af_c22', pg_temp.af_counts()::text, true);

do $$
begin
	perform pg_temp.base_assert(pg_temp.af_answer(current_setting('qorpera_test.af_2stop')) = jsonb_build_object(
			'schema', 'qorpera.machine-account-fill-authority/v1', 'state', 'refused', 'reason', 'MACHINE_NOT_RUNNING',
			'machine', 'm-1196-asleep')
			and current_setting('qorpera_test.af_2stopb') = '42501:company machine is not running',
		E'2: a stopped machine: ' || current_setting('qorpera_test.af_2stop') || ' / ' || current_setting('qorpera_test.af_2stopb'));
	perform pg_temp.base_assert(current_setting('qorpera_test.af_c21') = current_setting('qorpera_test.af_c20')
			and (current_setting('qorpera_test.af_c22')::jsonb - 'receipts') = (current_setting('qorpera_test.af_c20')::jsonb - 'receipts'),
		'2: a refusal wrote ' || current_setting('qorpera_test.af_c20') || ' -> ' || current_setting('qorpera_test.af_c22'));
end $$;

-- 3. Every other refusal writes nothing ----------------------------------------------------------------------------------------

select set_config('qorpera_test.af_env31', pg_temp.af_envelope('af-31'), true);
select pg_temp.af_mbegin('31', current_setting('qorpera_test.af_env31'));
create function pg_temp.af_env31(p_path text[], p_value jsonb) returns text language sql as $$
	select jsonb_set(current_setting('qorpera_test.af_env31')::jsonb, p_path, p_value)::text
$$;
grant execute on function pg_temp.af_env31(text[], jsonb) to qorpera_secret_broker;
select set_config('qorpera_test.af_c30', pg_temp.af_counts()::text, true);
select set_config('qorpera_test.af_3e', pg_temp.af_differ(jsonb_build_array(
	jsonb_build_array('executor: a receipt never begun', pg_temp.af_exec('39', current_setting('qorpera_test.af_env31')),
		'42501:Machine account fill receipt is unavailable'),
	jsonb_build_array('executor: another call''s receipt', pg_temp.af_exec('11', current_setting('qorpera_test.af_env31')),
		'42501:Machine account fill receipt is unavailable'),
	jsonb_build_array('executor: another machine than the call''s', pg_temp.af_exec('31', current_setting('qorpera_test.af_env31'),
		'12790000-0000-4000-8000-0000000007a2'), '22023:Machine account fill request is malformed'),
	jsonb_build_array('executor: machine_run', pg_temp.af_exec('31', pg_temp.af_env31('{operation,tool}', '"machine_run"')),
		'22023:Machine account fill request is malformed'),
	jsonb_build_array('executor: new_password', pg_temp.af_exec('31',
		pg_temp.af_env31('{operation,arguments,field}', '"new_password"')), '22023:Machine account fill request is malformed'),
	jsonb_build_array('executor: a value too', pg_temp.af_exec('31',
		pg_temp.af_env31('{operation,arguments,value}', '"hunter2"')), '22023:Machine account fill request is malformed'),
	jsonb_build_array('executor: not json', pg_temp.af_exec('31', 'not json'), '22023:Machine account fill request is malformed'),
	jsonb_build_array('executor: an account that is no id', pg_temp.af_exec('31', pg_temp.af_env31('{operation,arguments,account}',
		'"npmjs.com"')), '22023:Machine account fill request is malformed'),
	jsonb_build_array('executor: an id in capitals', pg_temp.af_exec('31', pg_temp.af_env31('{operation,arguments,account}',
		'"12790000-0000-4000-8000-0000000002AB"')), '22023:Machine account fill request is malformed'),
	-- The call's own shape, but not the call its receipt was begun for (another account): the digest differs.
	jsonb_build_array('executor: another account than the receipt''s', pg_temp.af_exec('31', pg_temp.af_env31(
		'{operation,arguments,account}', '"12790000-0000-4000-8000-0000000002ab"')), '42501:Machine account fill receipt is unavailable')
)), true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.af_3x', pg_temp.af_differ(jsonb_build_array(
	jsonb_build_array('call: machine_run', pg_temp.af_call('31', pg_temp.af_env31('{operation,tool}', '"machine_run"')),
		'22023:company account fill call is malformed'),
	jsonb_build_array('call: another version', pg_temp.af_call('31',
		pg_temp.af_env31('{operation,toolVersion}', '"qorpera.machine-tools/v2"')), '22023:company account fill call is malformed'),
	jsonb_build_array('call: another schema', pg_temp.af_call('31', pg_temp.af_env31('{schema}', '"qorpera.cloud-tool-operation/v1"')),
		'22023:company account fill call is malformed'),
	jsonb_build_array('call: another key', pg_temp.af_call('31', pg_temp.af_env31('{operation,arguments,operationKey}', '"af-3x"')),
		'22023:company account fill call is malformed'),
	jsonb_build_array('call: a value too', pg_temp.af_call('31', pg_temp.af_env31('{operation,arguments,value}', '"hunter2"')),
		'22023:company account fill call is malformed'),
	jsonb_build_array('call: new_password', pg_temp.af_call('31', pg_temp.af_env31('{operation,arguments,field}', '"new_password"')),
		'22023:company account fill call is malformed'),
	-- Another account than the receipt's: its digest differs, and that account is not one (refused at its vault rows).
	jsonb_build_array('call: another account than the receipt''s', pg_temp.af_call('31', pg_temp.af_env31(
		'{operation,arguments,account}', '"12790000-0000-4000-8000-0000000002ab"')), '22023:The company has no such open account'),
	jsonb_build_array('call: no machine', pg_temp.af_call('31', (current_setting('qorpera_test.af_env31')::jsonb
		#- '{operation,arguments,machine}')::text), '22023:company account fill call is malformed'),
	jsonb_build_array('call: a computer''s realm', pg_temp.af_call('31', pg_temp.af_env31('{operation,target,realm}',
		'"company_computer"')), '22023:company account fill call is malformed'),
	jsonb_build_array('call: a screen too', pg_temp.af_call('31',
		pg_temp.af_env31('{operation,target,screenId}', '"12790000-0000-4000-8000-000000000999"')),
		'22023:company account fill call is malformed'),
	jsonb_build_array('call: a company revision', pg_temp.af_call('31', pg_temp.af_env31('{operation,requiresCompanyRevision}', 'true')),
		'22023:company account fill call is malformed'),
	jsonb_build_array('receipt: another call''s', pg_temp.af_call('11', current_setting('qorpera_test.af_env31')),
		'42501:company account fill receipt is unavailable'),
	jsonb_build_array('receipt: never begun', pg_temp.af_call('39', current_setting('qorpera_test.af_env31')),
		'42501:company account fill receipt is unavailable'),
	jsonb_build_array('receipt: another downstream key', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'),
		p_downstream => repeat('f', 64)), '42501:company account fill receipt is unavailable'),
	jsonb_build_array('machine: another placement', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'),
		p_placement => '12790000-0000-4000-8000-0000000007b3'), '42501:company machine is not running'),
	jsonb_build_array('machine: another boot', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'),
		p_boot => '12790000-0000-4000-8000-0000000007c3'), '42501:company machine is not running'),
	jsonb_build_array('machine: another executor', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'),
		p_owner => 'mx-other'), '42501:company machine is not running'),
	jsonb_build_array('key: not one', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'), p_key => 'not-a-key'),
		'42501:company machine fill key is unavailable'),
	jsonb_build_array('key: a low-order point', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'),
		p_key => repeat('A', 43)), '42501:company machine fill key is unavailable'),
	jsonb_build_array('broker: another company''s', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'),
		p_authority => '12790000-0000-4000-8000-000000000041', p_capability => repeat('8', 64)),
		'42501:cloud secret broker does not serve this company'),
	jsonb_build_array('broker: another capability', pg_temp.af_call('31', current_setting('qorpera_test.af_env31'),
		p_capability => repeat('8', 64)), '42501:cloud secret broker authority is unavailable')
)), true);
reset session authorization;
-- Outside the broker's session.
select set_config('qorpera_test.af_3s', pg_temp.af_call('31', current_setting('qorpera_test.af_env31')), true);
select set_config('qorpera_test.af_c31', pg_temp.af_counts()::text, true);
select pg_temp.af_mend('31', current_setting('qorpera_test.af_env31'));

-- The same call's digest under another tool's receipt key; another company's machine of the same name; a machine of
-- another name than the call's: each with its own receipt, refused, then completed.
create function pg_temp.af_refused(p_n text, p_envelope text, p_tool text, p_machine text, p_executor text, p_broker text)
returns text language plpgsql as $$
declare v_found text;
begin
	perform pg_temp.af_mbegin(p_n, p_envelope, p_tool);
	v_found := pg_temp.af_differ(jsonb_build_array(jsonb_build_array('executor ' || p_n, pg_temp.af_exec(p_n, p_envelope, p_machine),
		p_executor)));
	execute 'set local session authorization qorpera_secret_broker';
	v_found := v_found || pg_temp.af_differ(jsonb_build_array(jsonb_build_array('broker ' || p_n, pg_temp.af_call(p_n, p_envelope),
		p_broker)));
	execute 'reset session authorization';
	perform pg_temp.af_mend(p_n, p_envelope);
	return v_found;
end $$;
select set_config('qorpera_test.af_c32', pg_temp.af_counts()::text, true);
select set_config('qorpera_test.af_3y', concat(
	pg_temp.af_refused('32', pg_temp.af_envelope('af-32'), 'machine_run', '12790000-0000-4000-8000-0000000007a1',
		'42501:Machine account fill receipt is unavailable', '42501:company account fill receipt is unavailable'),
	pg_temp.af_refused('33', pg_temp.af_envelope('af-33', '{}', '{}', '{"machineId": "12790000-0000-4000-8000-0000000007a3"}'),
		'fill_company_account', '12790000-0000-4000-8000-0000000007a3', '42501:Machine account fill authority is unavailable',
		'42501:company machine is not running'),
	pg_temp.af_refused('34', pg_temp.af_envelope('af-34', '{"machine": "m-1196-asleep"}'), 'fill_company_account',
		'12790000-0000-4000-8000-0000000007a1', '42501:Machine account fill authority is unavailable',
		'42501:company machine is not running')), true);
select set_config('qorpera_test.af_c33', pg_temp.af_counts()::text, true);

do $$
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.af_3e') = '',
		E'3: executor reads that differ:\n' || current_setting('qorpera_test.af_3e'));
	perform pg_temp.base_assert(current_setting('qorpera_test.af_3x') = '',
		E'3: broker refusals that differ:\n' || current_setting('qorpera_test.af_3x'));
	perform pg_temp.base_assert(current_setting('qorpera_test.af_3s') = '42501:cloud secret broker authority is required',
		'3: outside the broker''s session: ' || current_setting('qorpera_test.af_3s'));
	perform pg_temp.base_assert(current_setting('qorpera_test.af_3y') = '',
		E'3: other calls'' refusals that differ:\n' || current_setting('qorpera_test.af_3y'));
	perform pg_temp.base_assert(current_setting('qorpera_test.af_c31') = current_setting('qorpera_test.af_c30')
			and (current_setting('qorpera_test.af_c33')::jsonb - 'receipts') = (current_setting('qorpera_test.af_c32')::jsonb - 'receipts')
			and (current_setting('qorpera_test.af_c33')::jsonb ->> 'receipts')::bigint
				= (current_setting('qorpera_test.af_c32')::jsonb ->> 'receipts')::bigint + 3,
		'3: a refusal wrote ' || current_setting('qorpera_test.af_c30') || ' -> ' || current_setting('qorpera_test.af_c31')
			|| ' / ' || current_setting('qorpera_test.af_c32') || ' -> ' || current_setting('qorpera_test.af_c33'));
end $$;

-- 4. Grants, the call checks, the observations' list and the marker ----------------------------------------------------------

do $$
declare
	v_role text;
	v_call jsonb := jsonb_build_object('operationKey', 'k-1', 'machine', 'm-1196',
		'account', '12790000-0000-4000-8000-000000000201', 'field', 'code');
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role,
				'public.qorpera_authorize_machine_account_fill(jsonb,jsonb,uuid,text)', 'execute') = (v_role = 'service_role')
				and has_function_privilege(v_role,
					'public.qorpera_fill_company_account_on_machine(uuid,text,jsonb,uuid,text,text,text,uuid,uuid,text)', 'execute')
					= (v_role = 'qorpera_secret_broker')
				and not has_function_privilege(v_role, 'public.qorpera_valid_machine_account_fill_call(jsonb)', 'execute')
				and not has_function_privilege(v_role, 'public.qorpera_machine_account_fill_operation(text)', 'execute'),
			format('4: the grants for %s', v_role));
	end loop;
	-- Neither is on the native host's call list: only the executor and the broker reach them.
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_native_host_calls
			where name in ('qorpera_authorize_machine_account_fill', 'qorpera_fill_company_account_on_machine')),
		'4: not native host calls');
	perform pg_temp.base_assert(public.qorpera_valid_machine_account_fill_call(v_call)
			and public.qorpera_valid_machine_account_fill_call(v_call || '{"field": "login"}')
			and public.qorpera_valid_machine_account_fill_call(v_call || '{"field": "password"}')
			and not public.qorpera_valid_machine_account_fill_call(v_call || '{"field": "new_password"}')
			and not public.qorpera_valid_machine_account_fill_call(v_call || '{"field": "signing_secret"}')
			and not public.qorpera_valid_machine_account_fill_call(v_call - 'machine')
			and not public.qorpera_valid_machine_account_fill_call(v_call || '{"value": "hunter2"}')
			and not public.qorpera_valid_machine_account_fill_call(v_call || '{"machine": "M-1196"}')
			and not public.qorpera_valid_machine_account_fill_call(v_call || '{"account": "12790000-0000-4000-8000-00000000020"}')
			and not public.qorpera_valid_machine_account_fill_call(v_call || '{"operationKey": ""}')
			and not public.qorpera_valid_machine_account_fill_call(v_call || '{"field": null}')
			and not public.qorpera_valid_machine_account_fill_call('[]'),
		'4: the call check');
	perform pg_temp.base_assert(strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
			'''save_coding_value'',/* 20260930781000 */''fill_company_account''') > 0,
		'4: the observations'' list');
end $$;

rollback;
