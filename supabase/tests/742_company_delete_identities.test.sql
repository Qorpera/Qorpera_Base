-- @fixture 715_company_delete_after_runs.test.sql until "-- 5. A machine still on a node keeps the deletion waiting"
-- 20260928269450: a deleted company's sign-in (Compute Identity) volumes leave the nodes before the
-- purge. The fixture company's deletion is requested (715's: the folder-v2 base company, after its runs; ported from
-- snapshot-v1 in the legacy sweep). One of its identities (the owner's, of the base login) signed in on a node and ran
-- on another; a second (Vault By Default) never had a sign-in machine. Each node's LXD provider is asked
-- for the identity only once none of the company's machines was released in the last ten minutes; the
-- finisher purges once both nodes confirmed it gone, and the receipts outlive the purge.
reset role;
create function pg_temp.identity_refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;
create function pg_temp.identity_finish() returns jsonb language sql as $$
	select public.qorpera_finish_company_deletion('92400000-0000-4000-8000-000000000010')
$$;
create function pg_temp.identity_due(p_provider text, p_machine text) returns jsonb language sql as $$
	select public.qorpera_runtime_identity_retirements_due(p_provider, p_machine) -> 'computeIdentityIds'
$$;
create function pg_temp.identity_evidence(p_volume text, p_device text) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.identity-retirement-evidence/v1', 'volume', p_volume, 'device', p_device)
$$;
create function pg_temp.identity_confirm(p_provider text, p_machine text, p_identity uuid, p_evidence jsonb)
returns jsonb language sql as $$
	select public.qorpera_confirm_runtime_identity_retirement(p_provider, p_machine, p_identity, p_evidence)
$$;
create function pg_temp.identity_confirm_refused(p_provider text, p_machine text, p_identity uuid, p_evidence jsonb,
	p_state text) returns void language sql as $$
	select pg_temp.identity_refused(format('select pg_temp.identity_confirm(%L, %L, %L, %L)', p_provider, p_machine,
		p_identity, p_evidence), p_state)
$$;
select set_config('qorpera_test.signed_in', current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id', false);

-- A second, company-owned identity that never had a sign-in machine (as a Vault By Default one), and
-- one of a living company.
insert into public.qorpera_member_compute_identities(profile_id, ownership_kind, client_identity_id, display_name)
values ('92400000-0000-4000-8000-000000000010', 'company', extensions.gen_random_uuid(), 'Vault sign-in'),
	(current_setting('qorpera_test.delete_neighbour')::uuid, 'company', extensions.gen_random_uuid(), 'Neighbour sign-in');
select set_config('qorpera_test.vault_identity', (select id::text from public.qorpera_member_compute_identities
	where profile_id = '92400000-0000-4000-8000-000000000010' and display_name = 'Vault sign-in'), false);
select set_config('qorpera_test.neighbour_identity', (select id::text from public.qorpera_member_compute_identities
	where profile_id = current_setting('qorpera_test.delete_neighbour')::uuid), false);

-- Two nodes, each with its LXD provider (runs and sign-ins share the provider id), and a third that
-- never had a reserved machine of the company.
insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes,
	headroom_cpu_millis, headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
values ('74200000-0000-4000-8000-000000000190', repeat('9', 64), 'sign-in-node', 1, 8000, 17179869184, 1000,
		1073741824, 4000, 8589934592, true),
	('74200000-0000-4000-8000-000000000191', repeat('8', 64), 'run-node', 1, 8000, 17179869184, 1000,
		1073741824, 4000, 8589934592, true),
	('74200000-0000-4000-8000-000000000194', repeat('7', 64), 'other-node', 1, 8000, 17179869184, 1000,
		1073741824, 4000, 8589934592, true);
insert into public.qorpera_runtime_node_providers(provider_kind, provider_id, node_id, policy_sha256, cpu_millis, memory_bytes)
values ('native', 'lxd-sign-in', '74200000-0000-4000-8000-000000000190', repeat('1', 64), 2000, 4294967296),
	('login', 'lxd-sign-in', '74200000-0000-4000-8000-000000000190', repeat('2', 64), 2000, 4294967296),
	('native', 'lxd-run', '74200000-0000-4000-8000-000000000191', repeat('3', 64), 2000, 4294967296),
	('native', 'lxd-other', '74200000-0000-4000-8000-000000000194', repeat('4', 64), 2000, 4294967296),
	-- Another run provider on the sign-in node, and a coding executor there (not an LXD provider).
	('native', 'lxd-alt', '74200000-0000-4000-8000-000000000190', repeat('6', 64), 2000, 4294967296),
	('coding', 'lxd-coding', '74200000-0000-4000-8000-000000000190', repeat('7', 64), 2000, 4294967296);
-- The sign-in node has a shared execution host that mounts identity volumes (as node 2).
insert into public.qorpera_runtime_node_inventory_policies(node_id, policy, policy_sha256)
values ('74200000-0000-4000-8000-000000000190',
	'{"infrastructure":[{"project":"qn25b2","name":"qorpera-exec-node02","identityVolumes":{"pool":"qorpera-vm","sourcePrefix":"identity-"}}]}',
	repeat('a', 64));

-- The sign-in machine placed on the first node; a run placed on the second (it made the identity's volume
-- there too); a run whose node demand was never reserved (it made nothing). All released.
insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
	provider_adapter, instance_sha256, released_at)
values ('74200000-0000-4000-8000-000000000192', '92400000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.base_login')::jsonb ->> 'login_id')::uuid,
	current_setting('qorpera_test.signed_in')::uuid, 'lxd-sign-in', repeat('4', 64), clock_timestamp());
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256,
	released_at)
select runs.id, '92400000-0000-4000-8000-000000000010', (run.binding ->> 'runId')::uuid, (run.binding ->> 'runnerId')::uuid,
	runs.adapter, runs.sha, clock_timestamp()
from (values ('74200000-0000-4000-8000-000000000193'::uuid, 'qorpera_test.base_binding', 'lxd-run', repeat('5', 64)),
		('74200000-0000-4000-8000-000000000195'::uuid, 'qorpera_test.delete_working', 'lxd-other', repeat('6', 64)))
	as runs(id, setting, adapter, sha)
cross join lateral (select current_setting(runs.setting)::jsonb as binding) as run;
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256,
	cpu_millis, memory_bytes, reserved_at, released_at)
values ('74200000-0000-4000-8000-000000000192', '74200000-0000-4000-8000-000000000190', 'login', 'lxd-sign-in',
		repeat('2', 64), 2000, 4294967296, clock_timestamp(), clock_timestamp()),
	('74200000-0000-4000-8000-000000000193', '74200000-0000-4000-8000-000000000191', 'native', 'lxd-run',
		repeat('3', 64), 2000, 4294967296, clock_timestamp(), clock_timestamp());
insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256,
	cpu_millis, memory_bytes)
values ('74200000-0000-4000-8000-000000000195', '74200000-0000-4000-8000-000000000194', 'native', 'lxd-other',
	repeat('4', 64), 2000, 4294967296);

-- The signed-in identity may have left a volume on both nodes; the vault identity nowhere.
do $$
declare v_result jsonb := pg_temp.identity_finish();
begin
	if v_result ->> 'state' <> 'waiting' or (v_result #>> '{holdings,identities}')::integer is distinct from 2
		or (select array_agg(node_id order by node_id) from public.qorpera_company_identity_placements(
				'92400000-0000-4000-8000-000000000010')
			where compute_identity_id = current_setting('qorpera_test.signed_in')::uuid)
			<> array['74200000-0000-4000-8000-000000000190', '74200000-0000-4000-8000-000000000191']::uuid[]
		or exists (select 1 from public.qorpera_company_identity_placements('92400000-0000-4000-8000-000000000010')
			where compute_identity_id <> current_setting('qorpera_test.signed_in')::uuid) then
		raise exception 'The company''s node identities do not keep the deletion waiting: %', v_result;
	end if;
end
$$;

select pg_temp.base_claims('service_role');
set local role service_role;
-- Not yet: a machine was released less than ten minutes ago (an execution-host slot may still hold it).
select pg_temp.base_assert(pg_temp.identity_due('lxd-sign-in', repeat('9', 64)) = '[]'::jsonb,
	'Identities are not due right after a machine was released');
select pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64), current_setting('qorpera_test.signed_in')::uuid,
	pg_temp.identity_evidence('deleted', 'detached'), '55000');
-- A provider on another host, an unknown provider or a malformed id is refused.
select pg_temp.identity_refused(format('select pg_temp.identity_due(%L, %L)', 'lxd-sign-in', repeat('8', 64)), '42501');
select pg_temp.identity_refused(format('select pg_temp.identity_due(%L, %L)', 'lxd-missing', repeat('9', 64)), '42501');
select pg_temp.identity_refused(format('select pg_temp.identity_due(%L, %L)', 'LXD', repeat('9', 64)), '22023');
-- Only an LXD provider (run or sign-in) answers for its node.
select pg_temp.identity_refused(format('select pg_temp.identity_due(%L, %L)', 'lxd-coding', repeat('9', 64)), '42501');
reset role;
-- A living company is never retirable, however long ago its machines ended.
select pg_temp.base_assert(not public.qorpera_company_identities_retirable(current_setting('qorpera_test.delete_neighbour')::uuid)
	and not exists (select 1 from public.qorpera_runtime_machine_allocations
		where profile_id = current_setting('qorpera_test.delete_neighbour')::uuid and released_at is null),
	'A living company is not retirable');
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() - interval '11 minutes'
where profile_id = '92400000-0000-4000-8000-000000000010';

select pg_temp.base_claims('service_role');
set local role service_role;
do $$
declare
	v_signed_in uuid := current_setting('qorpera_test.signed_in')::uuid;
	v_first jsonb;
begin
	if pg_temp.identity_due('lxd-sign-in', repeat('9', 64)) <> jsonb_build_array(v_signed_in)
		or pg_temp.identity_due('lxd-run', repeat('8', 64)) <> jsonb_build_array(v_signed_in)
		or pg_temp.identity_due('lxd-other', repeat('7', 64)) <> '[]'::jsonb then
		raise exception 'The nodes were not asked for exactly the signed-in identity';
	end if;
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64), v_signed_in,
		'{"schema":"qorpera.identity-retirement-evidence/v1","volume":"kept","device":"detached"}', '22023');
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64), v_signed_in,
		pg_temp.identity_evidence('deleted', 'detached') || '{"extra":1}', '22023');
	-- Not a placement: the vault identity, an identity on a node it never reached, an unknown one.
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64),
		current_setting('qorpera_test.vault_identity')::uuid, pg_temp.identity_evidence('absent', 'absent'), '42501');
	perform pg_temp.identity_confirm_refused('lxd-other', repeat('7', 64), v_signed_in,
		pg_temp.identity_evidence('absent', 'none'), '42501');
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64), extensions.gen_random_uuid(),
		pg_temp.identity_evidence('absent', 'none'), '42501');
	-- A living company's identity.
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64),
		current_setting('qorpera_test.neighbour_identity')::uuid, pg_temp.identity_evidence('absent', 'none'), '42501');
	-- The node with an execution host cannot report that it has none.
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64), v_signed_in,
		pg_temp.identity_evidence('deleted', 'none'), '42501');
	v_first := pg_temp.identity_confirm('lxd-sign-in', repeat('9', 64), v_signed_in,
		pg_temp.identity_evidence('deleted', 'detached'));
	if v_first ->> 'schema' <> 'qorpera.identity-retirement/v1' or v_first ->> 'volume' <> 'deleted'
		or v_first ->> 'device' <> 'detached' or (v_first ->> 'computeIdentityId')::uuid <> v_signed_in
		or (v_first ->> 'nodeId')::uuid <> '74200000-0000-4000-8000-000000000190'
		or pg_temp.identity_confirm('lxd-sign-in', repeat('9', 64), v_signed_in,
			pg_temp.identity_evidence('deleted', 'detached')) <> v_first
		or pg_temp.identity_due('lxd-sign-in', repeat('9', 64)) <> '[]'::jsonb
		or pg_temp.identity_due('lxd-run', repeat('8', 64)) <> jsonb_build_array(v_signed_in) then
		raise exception 'A confirmed retirement did not answer one receipt, or was asked for again: %', v_first;
	end if;
	perform set_config('qorpera_test.identity_receipt', v_first::text, false);
	-- A provider that lost the reply finds both gone: the same receipt. Other evidence differs.
	if pg_temp.identity_confirm('lxd-sign-in', repeat('9', 64), v_signed_in,
			pg_temp.identity_evidence('absent', 'absent')) <> v_first then
		raise exception 'A replay after a lost reply did not answer the receipt';
	end if;
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64), v_signed_in,
		pg_temp.identity_evidence('deleted', 'none'), '42501');
	-- Another provider of the same node cannot replay it.
	perform pg_temp.identity_confirm_refused('lxd-alt', repeat('9', 64), v_signed_in,
		pg_temp.identity_evidence('deleted', 'detached'), '42501');
end
$$;
reset role;
do $$
declare v_result jsonb := pg_temp.identity_finish();
begin
	if v_result ->> 'state' <> 'waiting' or (v_result #>> '{holdings,identities}')::integer is distinct from 1 then
		raise exception 'One node''s confirmation did not leave the other waiting: %', v_result;
	end if;
end
$$;

-- The run node confirms it too (that node has no execution host), and the finisher purges.
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.identity_confirm('lxd-run', repeat('8', 64), current_setting('qorpera_test.signed_in')::uuid,
	pg_temp.identity_evidence('absent', 'none'));
-- A replay may not report more than was confirmed: a volume found absent was not deleted.
select pg_temp.identity_confirm_refused('lxd-run', repeat('8', 64), current_setting('qorpera_test.signed_in')::uuid,
	pg_temp.identity_evidence('deleted', 'none'), '42501');
reset role;
do $$
declare v_result jsonb := pg_temp.identity_finish();
begin
	if v_result ->> 'state' <> 'purged'
		or exists (select 1 from public.qorpera_profiles where id = '92400000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_node_demands
			where allocation_id in ('74200000-0000-4000-8000-000000000192', '74200000-0000-4000-8000-000000000193')) then
		raise exception 'The finisher did not purge once every node retired the identity: %', v_result;
	end if;
end
$$;

-- After the purge the receipts still answer, nothing is due, and nothing new can be recorded.
select pg_temp.base_claims('service_role');
set local role service_role;
do $$
begin
	if pg_temp.identity_confirm('lxd-sign-in', repeat('9', 64), current_setting('qorpera_test.signed_in')::uuid,
			pg_temp.identity_evidence('deleted', 'detached')) <> current_setting('qorpera_test.identity_receipt')::jsonb
		or pg_temp.identity_due('lxd-sign-in', repeat('9', 64)) <> '[]'::jsonb
		or pg_temp.identity_due('lxd-run', repeat('8', 64)) <> '[]'::jsonb then
		raise exception 'The receipts did not outlive the purge';
	end if;
	perform pg_temp.identity_confirm_refused('lxd-sign-in', repeat('9', 64),
		current_setting('qorpera_test.vault_identity')::uuid, pg_temp.identity_evidence('absent', 'none'), '42501');
end
$$;
reset role;
select pg_temp.base_assert((select count(*) from public.qorpera_runtime_identity_retirements
	where compute_identity_id = current_setting('qorpera_test.signed_in')::uuid) = 2, 'Both retirements are kept after the purge');
-- Members cannot call either function.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.identity_refused(format('select public.qorpera_runtime_identity_retirements_due(%L, %L)', 'lxd-sign-in',
	repeat('9', 64)), '42501');
select pg_temp.identity_refused(format('select public.qorpera_confirm_runtime_identity_retirement(%L, %L, %L, %L)',
	'lxd-sign-in', repeat('9', 64), current_setting('qorpera_test.signed_in'), pg_temp.identity_evidence('absent', 'none')),
	'42501');
reset role;
rollback;
