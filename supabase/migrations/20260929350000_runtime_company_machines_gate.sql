-- Company machines are offered to agents only once a node can serve them
-- (2026-09-29). Until an operator enables a machine executor
-- (qorpera_configure_machine_executor, deploy/machine/README.md), no machine
-- could ever start, so an agent carrying the machine tools would only meet
-- refusals. The runtime asks this at the start of a company run and offers the
-- tools only when it answers true; any other answer, or none, keeps them away.
create function public.qorpera_company_machines_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_machine_executors where enabled and policy is not null)
$$;
revoke all on function public.qorpera_company_machines_available() from public, anon, authenticated, service_role;
grant execute on function public.qorpera_company_machines_available() to service_role;
