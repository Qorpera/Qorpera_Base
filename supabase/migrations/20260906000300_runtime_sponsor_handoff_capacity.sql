-- Handoff selection is not a capacity reservation. Skip connections which
-- cannot currently execute, then recheck under the connection lock when the
-- next attempt acquires its native lease. Preserve the existing function
-- ownership, grants, effect fence and immutable handoff history.
do $$
declare
	v_target regprocedure := 'public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_old text := $old$		and version.authentication_mode = v_mode
		and (v_mode <> 'native_subscription' or (capsule.id is not null and capsule.status = 'active'
			and capsule.compute_identity_id = v_run.compute_identity_id))$old$;
	v_new text := $new$		and version.authentication_mode = v_mode and version.authorization_state = 'active'
		and (v_mode <> 'native_subscription' or (capsule.id is not null and capsule.status = 'active'
			and capsule.compute_identity_id = v_run.compute_identity_id
			and exists (select 1 from public.qorpera_provider_execution_policies policy
				where policy.provider = connection.provider and policy.authentication_mode = 'native_subscription'
					and policy.native_harness = version.native_harness
					and policy.implementation_status = 'supported' and policy.enablement_status = 'enabled'
					and (select count(*) from public.qorpera_native_provider_connection_leases lease
						where lease.provider_connection_id = connection.id and lease.status = 'active'
							and lease.expires_at > statement_timestamp())
						< least(version.max_native_concurrency,policy.max_native_concurrency))))$new$;
begin
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Sponsor handoff selection differs from its approved upgrade source';
	end if;
	execute replace(v_definition,v_old,v_new);
end
$$;

do $$
declare
	v_target regprocedure := 'public.qorpera_acquire_native_provider_connection_lease(uuid,uuid,text,uuid,text,integer)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_old text := $old$		if v_lease.status <> 'active' and v_lease.job_id = v_job.id
			and public.qorpera_run_native_start_superseded(v_run.id) then
			insert into public.qorpera_native_provider_connection_lease_history$old$;
	v_new text := $new$		if v_lease.status <> 'active' and v_lease.job_id = v_job.id
			and public.qorpera_run_native_start_superseded(v_run.id) then
			-- The target connection is already locked FOR UPDATE above. A
			-- competing acquisition after selection must not overbook it.
			update public.qorpera_native_provider_connection_leases
			set status = 'expired', released_at = statement_timestamp()
			where provider_connection_id = v_connection.id and status = 'active'
				and expires_at <= statement_timestamp();
			select count(*) into v_active
			from public.qorpera_native_provider_connection_leases as lease
			where lease.provider_connection_id = v_connection.id and lease.status = 'active';
			if v_active >= least(v_version.max_native_concurrency, v_policy.max_native_concurrency) then
				raise exception 'native provider connection already has its allowed execution lease' using errcode = '55000';
			end if;
			insert into public.qorpera_native_provider_connection_lease_history$new$;
begin
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Sponsor handoff lease acquisition differs from its approved upgrade source';
	end if;
	execute replace(v_definition,v_old,v_new);
end
$$;
