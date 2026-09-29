-- Computer hours, build step 6d part 2: members see that the company waits for computer hours.
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero": work that cannot
-- start waits with a stated reason). Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero").
--
-- A cheap read for any member of the company, asked by the web with its other periodic reads: true
-- while the company is at zero (build step 6a's `qorpera_company_at_zero`), so new work waits. False
-- while the zero rule is off, before live payments, for a complimentary company, and during a
-- founder's renewal grace. `waitingForHours` in qorpera_read_company_computer_hours says the same,
-- beside the month's use; this read skips the month.

set local lock_timeout = '3s';

create function public.qorpera_company_waiting_for_hours(p_profile_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	return public.qorpera_company_at_zero(p_profile_id, clock_timestamp());
end
$$;
revoke all on function public.qorpera_company_waiting_for_hours(uuid) from public, anon, service_role;
grant execute on function public.qorpera_company_waiting_for_hours(uuid) to authenticated;
