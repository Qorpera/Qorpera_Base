-- Identity homes count completed logins only (16 Sep 2026). The first login of
-- an established identity on node 2 reserved a login machine and booted it,
-- then stopped in the guest (the identity needs the recovery flow there). The
-- home rule (20260916170000, 20260916183000) counted that unfinished login
-- allocation as a home, so native runs could be placed on a node whose
-- identity volume was never initialised. A node is a home only when a login
-- session of the identity completed on its adapter.

do $patch$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure);
	v_old := 'select coalesce(array_agg(distinct a.provider_adapter),''{}'') into v_homes from public.qorpera_runtime_machine_allocations a
			where a.login_compute_identity_id=p_compute_identity_id;';
	v_new := 'select coalesce(array_agg(distinct a.provider_adapter),''{}'') into v_homes from public.qorpera_runtime_machine_allocations a
			join public.qorpera_native_provider_login_sessions s on s.id=a.login_session_id and s.status=''completed''
			where a.login_compute_identity_id=p_compute_identity_id;';
	if position(v_old in v_def) = 0 then raise exception 'placement decide home query differs'; end if;
	execute replace(v_def, v_old, v_new);

	v_def := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	v_old := 'or not exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				where home.login_compute_identity_id = run.compute_identity_id
			)
			or exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				where home.login_compute_identity_id = run.compute_identity_id
					and home.provider_adapter = v_adapter
			))';
	v_new := 'or not exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				join public.qorpera_native_provider_login_sessions as login on login.id = home.login_session_id and login.status = ''completed''
				where home.login_compute_identity_id = run.compute_identity_id
			)
			or exists (
				select 1 from public.qorpera_runtime_machine_allocations as home
				join public.qorpera_native_provider_login_sessions as login on login.id = home.login_session_id and login.status = ''completed''
				where home.login_compute_identity_id = run.compute_identity_id
					and home.provider_adapter = v_adapter
			))';
	if position(v_old in v_def) = 0 then raise exception 'claim home query differs'; end if;
	execute replace(v_def, v_old, v_new);
end
$patch$;
