-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Stateless Compute step 1 (change 3): an identity whose login is kept by the vault has no
-- node home. Only service_role asks; the answer is true only when every active login of the
-- identity is a vault pointer to an active vault login. The claim and the placement chooser
-- consult it (their two-node behaviour is proven by scripts/test-runtime-node-placement.mjs).
reset role;

create function pg_temp.expect(p_actual boolean, p_expected boolean, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;

do $$
declare v_function regprocedure := 'public.qorpera_compute_identity_login_in_vault(uuid)'::regprocedure;
	v_role text;
begin
	foreach v_role in array array['anon','authenticated','qorpera_secret_broker'] loop
		if has_function_privilege(v_role, v_function, 'EXECUTE') then
			raise exception 'Vault custody check is exposed to %', v_role; end if;
	end loop;
	if not has_function_privilege('service_role', v_function, 'EXECUTE') then
		raise exception 'Nodes cannot ask for vault custody'; end if;
	if (select provolatile from pg_proc where oid = v_function) <> 's' then
		raise exception 'Vault custody check must be stable'; end if;
end $$;

-- The claim and the chooser each carry the check exactly once, at the identity-home rule (the
-- claim asks it last, only for a run whose home is elsewhere).
do $$
declare v_claim text := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	-- Since 20260928249240 the chooser takes a fifth argument (a node to rank last), and since 20260929996000
	-- its body is the six-argument form (the run's bundle too); the shorter forms only pass none.
	v_decide text := pg_get_functiondef('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid,text)'::regprocedure);
	v_decide_five text := pg_get_functiondef('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid,uuid)'::regprocedure);
	v_decide_four text := pg_get_functiondef('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure);
begin
	if position('public.qorpera_runtime_node_placement_decide(p_allocation_id,p_provider_kind,p_provider_id,p_compute_identity_id,null::uuid)' in v_decide_four) = 0
		or position('public.qorpera_runtime_node_placement_decide(p_allocation_id,p_provider_kind,p_provider_id,p_compute_identity_id,p_last_node_id,null::text)' in v_decide_five) = 0 then
		raise exception 'The shorter choosers do not pass through'; end if;
	if (select count(*) from regexp_matches(v_claim,
		'and home\.provider_adapter = v_adapter\s+\)\s+or public\.qorpera_compute_identity_login_in_vault\(run\.compute_identity_id\)\)\s+order by job\.created_at', 'g')) <> 1
		or (select count(*) from regexp_matches(v_claim, 'qorpera_compute_identity_login_in_vault', 'g')) <> 1 then
		raise exception 'Claim does not skip the home rule for vault logins exactly once'; end if;
	if (select count(*) from regexp_matches(v_decide,
		'elsif p_provider_kind=''native'' and p_compute_identity_id is not null and not public\.qorpera_compute_identity_login_in_vault\(p_compute_identity_id\) then', 'g')) <> 1
		or (select count(*) from regexp_matches(v_decide, 'qorpera_compute_identity_login_in_vault', 'g')) <> 1 then
		raise exception 'Placement does not skip the home rule for vault logins exactly once'; end if;
end $$;

-- The fixture's identity signed in on a node: its capsule needs that node's key.
select set_config('qorpera_test.vault_identity', capsule.compute_identity_id::text, false)
from public.qorpera_native_credential_capsules capsule
where capsule.compute_identity_id = (current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid
	and capsule.status = 'active'
limit 1;
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(null), false, 'no identity');
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.vault_identity')::uuid),
	false, 'a node login only');

-- The vault's login for the same identity, behind its pointer capsule.
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
select '69100000-0000-4000-8000-000000000040', identity.profile_id, 'https://secrets.qorpera.test', 'company-kek-1', repeat('c',64)
from public.qorpera_member_compute_identities identity
where identity.id = current_setting('qorpera_test.vault_identity')::uuid;
insert into public.qorpera_native_credential_capsules(id,profile_id,compute_identity_id,ownership_kind,owner_user_id,
	owner_scope_key,provider,native_harness,encrypted_capsule_reference,attestation_policy_sha256,created_by_user_id)
select '69100000-0000-4000-8000-000000000060', capsule.profile_id, capsule.compute_identity_id, capsule.ownership_kind,
	capsule.owner_user_id, capsule.owner_scope_key, 'openai', 'codex-cli',
	'model-login/69100000-0000-4000-8000-000000000050', capsule.attestation_policy_sha256, capsule.created_by_user_id
from public.qorpera_native_credential_capsules capsule
where capsule.compute_identity_id = current_setting('qorpera_test.vault_identity')::uuid and capsule.status = 'active'
order by capsule.created_at limit 1;
insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
	provider,native_harness,current_version,access_issued_at,access_expires_at)
select '69100000-0000-4000-8000-000000000050', capsule.profile_id, capsule.compute_identity_id, capsule.id,
	'69100000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '10 days'
from public.qorpera_native_credential_capsules capsule where capsule.id = '69100000-0000-4000-8000-000000000060';

select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.vault_identity')::uuid),
	false, 'a node login is still active beside the vault login');
update public.qorpera_native_credential_capsules set status = 'disabled'
where compute_identity_id = current_setting('qorpera_test.vault_identity')::uuid
	and status = 'active' and encrypted_capsule_reference not like 'model-login/%';
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.vault_identity')::uuid),
	true, 'only the vault login is active');

-- A login that must sign in again, a disabled pointer, or a pointer to another login is no vault custody.
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '69100000-0000-4000-8000-000000000050';
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.vault_identity')::uuid),
	false, 'the vault login needs a new sign-in');
update public.qorpera_model_logins set status = 'active' where id = '69100000-0000-4000-8000-000000000050';
update public.qorpera_native_credential_capsules set status = 'disabled' where id = '69100000-0000-4000-8000-000000000060';
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.vault_identity')::uuid),
	false, 'the pointer capsule is disabled');
update public.qorpera_native_credential_capsules
set status = 'active', encrypted_capsule_reference = 'model-login/69100000-0000-4000-8000-000000000051'
where id = '69100000-0000-4000-8000-000000000060';
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.vault_identity')::uuid),
	false, 'the pointer names another login');
update public.qorpera_native_credential_capsules
set encrypted_capsule_reference = 'model-login/69100000-0000-4000-8000-000000000050'
where id = '69100000-0000-4000-8000-000000000060';
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(current_setting('qorpera_test.vault_identity')::uuid),
	true, 'the pointer is restored');

-- Another identity of the company keeps its own node login and its home.
select pg_temp.expect(public.qorpera_compute_identity_login_in_vault(
	(current_setting('qorpera_test.company_identity')::jsonb ->> 'compute_identity_id')::uuid), false, 'another identity');
