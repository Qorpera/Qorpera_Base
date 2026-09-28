-- Stateless Compute step 1, change 3: a run whose login is in the vault is not pinned to a node.
--
-- An identity's login is in the vault when it has an active vault login and no active capsule
-- that still needs a node's master key. For such an identity the identity-home rule no longer
-- applies: any orchestrator may claim its runs, and placement chooses the least loaded eligible
-- node like any other work. Nodes ask qorpera_compute_identity_login_in_vault (service role) and
-- then skip the identity volume, master key and key backup entirely. The identity runtime state's
-- shape is left alone: nodes still running older code parse it with an exact field list.
-- Identities whose logins are still on a node keep today's rule unchanged.

create index qorpera_native_credential_capsules_identity_active
	on public.qorpera_native_credential_capsules(compute_identity_id) where status = 'active';

create function public.qorpera_compute_identity_login_in_vault(p_compute_identity_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select p_compute_identity_id is not null
		and exists (
			select 1 from public.qorpera_model_logins as login
			join public.qorpera_native_credential_capsules as capsule on capsule.id = login.credential_capsule_id
			where login.compute_identity_id = p_compute_identity_id and login.status = 'active'
				and capsule.status = 'active'
				and capsule.encrypted_capsule_reference = 'model-login/' || login.id::text
		)
		and not exists (
			select 1 from public.qorpera_native_credential_capsules as capsule
			where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference !~ '^model-login/[0-9a-f-]{36}$'
		)
$$;
revoke all on function public.qorpera_compute_identity_login_in_vault(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_compute_identity_login_in_vault(uuid) to service_role;

do $$
declare
	v_target regprocedure;
	v_definition text;
	v_count integer;
begin
	-- Claim: a vault identity's run may be claimed by any orchestrator. The check is the last arm of
	-- the identity-home rule, so the claim asks it only for a run whose home is elsewhere.
	v_target := 'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('qorpera_compute_identity_login_in_vault' in v_definition) = 0 then
		select count(*) into v_count
		from regexp_matches(v_definition,
			'(and home\.provider_adapter = v_adapter\s+\))\)(\s+order by job\.created_at)', 'g');
		if v_count <> 1 then raise exception 'Claim identity home source differs (% matches)', v_count; end if;
		execute regexp_replace(v_definition,
			'(and home\.provider_adapter = v_adapter\s+\))\)(\s+order by job\.created_at)',
			E'\\1\n\t\t\tor public.qorpera_compute_identity_login_in_vault(run.compute_identity_id))\\2');
	end if;

	-- Placement: a vault identity falls through to the least-loaded branch.
	v_target := 'public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('qorpera_compute_identity_login_in_vault' in v_definition) = 0 then
		v_count := (length(v_definition) - length(replace(v_definition,
			'elsif p_provider_kind=''native'' and p_compute_identity_id is not null then', ''))) /
			length('elsif p_provider_kind=''native'' and p_compute_identity_id is not null then');
		if v_count <> 1 then raise exception 'Placement identity home source differs (% matches)', v_count; end if;
		execute replace(v_definition,
			'elsif p_provider_kind=''native'' and p_compute_identity_id is not null then',
			'elsif p_provider_kind=''native'' and p_compute_identity_id is not null'
				|| ' and not public.qorpera_compute_identity_login_in_vault(p_compute_identity_id) then');
	end if;

end
$$;
