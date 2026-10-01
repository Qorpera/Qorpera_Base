-- Company machines are offered to agents only once a node can serve them
-- (2026-09-29). Until an operator enables a machine executor
-- (qorpera_configure_machine_executor, deploy/machine/README.md), no machine
-- could ever start, so an agent carrying the machine tools would only meet
-- refusals. The runtime asks this at the start of a company run and offers the
-- tools only when it answers true; any other answer, or none, keeps them away.
-- The same test machine_start's admission makes before it refuses with
-- MACHINES_UNAVAILABLE: an enabled executor whose policy an enrolled machine
-- provider matches.
create function public.qorpera_company_machines_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_machine_executors executor
		join public.qorpera_runtime_node_providers provider on provider.provider_kind = 'machine'
			and provider.provider_id = executor.policy ->> 'providerId'
			and provider.policy_sha256 = executor.policy ->> 'providerPolicySha256'
		where executor.enabled and executor.policy is not null)
$$;
revoke all on function public.qorpera_company_machines_available() from public, anon, authenticated, service_role;
grant execute on function public.qorpera_company_machines_available() to service_role;
