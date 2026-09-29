-- @fixture 715_company_delete_after_runs.test.sql until "-- 5. A machine still on a node keeps the deletion waiting"
-- 20260929480000: the finisher records a deleted company's Storage objects that no other record names
-- (credential capsules, the identity recovery prefix) right before the purge, in the same step; the
-- artifact GC worker claims and completes them, and the record outlives the company.
reset role;
create function pg_temp.storage_refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;
create function pg_temp.storage_finish() returns jsonb language sql as $$
	select public.qorpera_finish_company_deletion('30000000-0000-4000-8000-000000000010')
$$;
create function pg_temp.storage_entries(p_profile uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'path', object_path) order by bucket, object_path), '[]')
	from public.qorpera_company_storage_deletions where profile_id = p_profile
$$;

-- The company has a node capsule, a revoked one (still in Storage), a vault sign-in (no Storage object),
-- a row whose reference names another capsule (never trusted) and a recovery authority.
insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
	provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id, status, revoked_at)
select capsule.id, capsule.profile_id, identity.id, 'member', identity.owner_user_id, 'openai', 'codex-cli',
	capsule.reference, repeat('a', 64), identity.owner_user_id, capsule.status,
	case when capsule.status = 'revoked' then clock_timestamp() end
from (values
		('30000000-0000-4000-8000-0000000001a1'::uuid, '30000000-0000-4000-8000-000000000010'::uuid,
			'native-capsule/30000000-0000-4000-8000-0000000001a1', 'active'),
		('30000000-0000-4000-8000-0000000001a6'::uuid, '30000000-0000-4000-8000-000000000010'::uuid,
			'native-capsule/30000000-0000-4000-8000-0000000001a6', 'revoked'),
		('30000000-0000-4000-8000-0000000001a2'::uuid, '30000000-0000-4000-8000-000000000010'::uuid,
			'model-login/30000000-0000-4000-8000-0000000001a2', 'revoked'),
		('30000000-0000-4000-8000-0000000001a7'::uuid, '30000000-0000-4000-8000-000000000010'::uuid,
			'native-capsule/30000000-0000-4000-8000-0000000001a8', 'revoked'))
	as capsule(id, profile_id, reference, status)
cross join lateral (select id, owner_user_id from public.qorpera_member_compute_identities
	where id = (current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid) as identity;
insert into public.qorpera_identity_recovery_authorities(id, profile_id, signing_public_key, wrapping_public_key,
	service_origin, capability_sha256)
values ('30000000-0000-4000-8000-0000000001a3', '30000000-0000-4000-8000-000000000010', repeat('S', 60), repeat('W', 450),
	'https://recovery.example.test:10000', repeat('b', 64));

-- A deletion that waits (a machine still on a node) records nothing yet; a purge that fails records nothing.
savepoint waiting;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
select '30000000-0000-4000-8000-0000000001a4', '30000000-0000-4000-8000-000000000010',
	(binding ->> 'runId')::uuid, (binding ->> 'runnerId')::uuid, 'lxd', repeat('7', 64)
from (select current_setting('qorpera_test.delete_working')::jsonb as binding) as working;
select pg_temp.wake_assert(pg_temp.storage_finish() ->> 'state' = 'waiting'
	and pg_temp.storage_entries('30000000-0000-4000-8000-000000000010') = '[]', 'A waiting deletion records nothing');
rollback to waiting;
savepoint failing;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256,
	released_at)
select '30000000-0000-4000-8000-0000000001a5', current_setting('qorpera_test.delete_neighbour')::uuid,
	(binding ->> 'runId')::uuid, (binding ->> 'runnerId')::uuid, 'lxd', repeat('6', 64), clock_timestamp()
from (select current_setting('qorpera_test.wake_binding')::jsonb as binding) as first_run;
select pg_temp.wake_assert(pg_temp.storage_finish() ->> 'state' = 'failed'
	and pg_temp.storage_entries('30000000-0000-4000-8000-000000000010') = '[]', 'A failed purge records nothing');
rollback to failing;

-- The purge records both node capsules and the recovery prefix, not the vault sign-in nor the
-- mismatched reference.
select pg_temp.wake_assert(pg_temp.storage_finish() ->> 'state' = 'purged', 'The company is purged');
select pg_temp.wake_assert(pg_temp.storage_entries('30000000-0000-4000-8000-000000000010') = jsonb_build_array(
		jsonb_build_object('bucket', 'qorpera-identity-recovery', 'path', '30000000-0000-4000-8000-000000000010/'),
		jsonb_build_object('bucket', 'qorpera-native-compute-capsules',
			'path', '30000000-0000-4000-8000-0000000001a1.capsule'),
		jsonb_build_object('bucket', 'qorpera-native-compute-capsules',
			'path', '30000000-0000-4000-8000-0000000001a6.capsule'))
	and not exists (select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010')
	and not exists (select 1 from public.qorpera_native_credential_capsules
		where profile_id = '30000000-0000-4000-8000-000000000010'),
	'The purge records the company''s Storage objects');

-- The worker claims, completes; a failure is recorded and the entry offered again after its lease.
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_claimed jsonb := public.qorpera_claim_company_storage_deletions(100);
begin
	if jsonb_array_length(v_claimed) <> 3 or not (v_claimed @> jsonb_build_array(
			jsonb_build_object('bucket', 'qorpera-identity-recovery', 'path', '30000000-0000-4000-8000-000000000010/'),
			jsonb_build_object('bucket', 'qorpera-native-compute-capsules', 'path', '30000000-0000-4000-8000-0000000001a1.capsule')))
		or public.qorpera_claim_company_storage_deletions(100) <> '[]'::jsonb then
		raise exception 'The worker did not claim each entry once: %', v_claimed;
	end if;
	perform public.qorpera_complete_company_storage_deletion('qorpera-native-compute-capsules',
		'30000000-0000-4000-8000-0000000001a1.capsule');
	perform set_config('qorpera_test.before_repeat', clock_timestamp()::text, true);
	-- A second completion and a late error leave a removed entry as it is.
	perform public.qorpera_complete_company_storage_deletion('qorpera-native-compute-capsules',
		'30000000-0000-4000-8000-0000000001a1.capsule');
	perform public.qorpera_complete_company_storage_deletion('qorpera-native-compute-capsules',
		'30000000-0000-4000-8000-0000000001a1.capsule', 'late failure');
	perform public.qorpera_complete_company_storage_deletion('qorpera-native-compute-capsules',
		'30000000-0000-4000-8000-0000000001a6.capsule');
	perform public.qorpera_complete_company_storage_deletion('qorpera-identity-recovery',
		'30000000-0000-4000-8000-000000000010/', 'Storage list failed');
	perform pg_temp.storage_refused($q$select public.qorpera_complete_company_storage_deletion('qorpera-identity-recovery', 'other/')$q$,
		'P0002');
	perform pg_temp.storage_refused($q$select public.qorpera_claim_company_storage_deletions(0)$q$, '22023');
	perform pg_temp.storage_refused($q$select public.qorpera_claim_company_storage_deletions(101)$q$, '22023');
	-- A failed entry is offered again (its lease was cleared), a removed one never.
	if public.qorpera_claim_company_storage_deletions(100) <> jsonb_build_array(
			jsonb_build_object('bucket', 'qorpera-identity-recovery', 'path', '30000000-0000-4000-8000-000000000010/')) then
		raise exception 'A failed entry was not offered again, or a removed one was';
	end if;
end
$$;
reset role;
select pg_temp.wake_assert((select removed_at < current_setting('qorpera_test.before_repeat')::timestamptz and last_error is null
		and attempts = 1
		from public.qorpera_company_storage_deletions where object_path = '30000000-0000-4000-8000-0000000001a1.capsule')
	and (select removed_at is null and last_error = 'Storage list failed' and attempts = 2
		from public.qorpera_company_storage_deletions where object_path = '30000000-0000-4000-8000-000000000010/')
	and pg_temp.storage_entries(current_setting('qorpera_test.delete_neighbour')::uuid) = '[]',
	'Completion and failure are recorded; the living company has no entry');
-- Members cannot call the worker's functions.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.storage_refused($q$select public.qorpera_claim_company_storage_deletions(10)$q$, '42501');
select pg_temp.storage_refused($q$select public.qorpera_complete_company_storage_deletion('qorpera-identity-recovery', '30000000-0000-4000-8000-000000000010/')$q$, '42501');
reset role;
rollback;
