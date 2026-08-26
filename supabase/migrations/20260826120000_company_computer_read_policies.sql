-- Step 3 Company Computers: member read access to the registry.
--
-- Shared visibility is the charter's default (every member of the company
-- sees the same machine and its lifecycle), so members may read their own
-- company's computer row and its audit trail. All writes stay behind the
-- registration and lifecycle RPCs. The node registry remains service-plane
-- only: members address their Company Computer, never nodes, and cluster
-- topology is operator state.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create policy qorpera_company_computers_member_read
	on public.qorpera_company_computers for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

grant select on public.qorpera_company_computers to authenticated;

create policy qorpera_company_computer_events_member_read
	on public.qorpera_company_computer_events for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

grant select on public.qorpera_company_computer_events to authenticated;
