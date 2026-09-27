-- An identity's home is where it is usable now. A recovery moves a member's model
-- identity to one node and raises its recovery epoch; the copy left on any other
-- node is stale, and a guest that mounts it fails at bootstrap (it requires the
-- recovery marker of the current epoch). The home rule counted every node where a
-- login or refresh had ever completed, so after a node outage and a recovery on
-- the other node, placement returned to the stale node and every account refresh
-- and run of that member failed there (found live 2026-09-19: recovery to node 1
-- at epoch 1 during a node 2 outage; node 2 kept its epoch 0 copy and stayed a
-- home). Only a completion at the identity's current epoch establishes a home.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runtime_identity_home_allocation(public.qorpera_runtime_machine_allocations)'::regprocedure), 'sha256'), 'hex') <> '3517390d57d84364333eb2b40c34c5b5e45e08314814164e13f7dc2bee010a27' then
		raise exception 'Reviewed function definition changed: qorpera_runtime_identity_home_allocation';
	end if;
end $guard$;

create or replace function public.qorpera_runtime_identity_home_allocation(p_allocation public.qorpera_runtime_machine_allocations)
returns boolean language sql stable security definer set search_path='' as $$
    select exists(select 1 from public.qorpera_native_provider_login_sessions login
        join public.qorpera_member_compute_identities identity on identity.id=login.compute_identity_id
        where login.id=p_allocation.login_session_id and login.status='completed'
          and login.compute_recovery_epoch=identity.recovery_epoch)
      or exists(select 1 from public.qorpera_native_account_refresh_requests refresh
        join public.qorpera_member_compute_identities identity on identity.id=refresh.compute_identity_id
        where refresh.id=p_allocation.account_refresh_request_id and refresh.status='completed'
          and refresh.compute_recovery_epoch=identity.recovery_epoch)
$$;
