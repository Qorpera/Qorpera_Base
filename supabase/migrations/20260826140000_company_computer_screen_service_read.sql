-- Step 3 screens: service-plane read for the guest screen agent. The agent
-- reconciles the machine's live per-screen desktop sessions against this
-- registry, so the control plane stays the single writer for which screens
-- exist while the guest only converges to it.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create function public.qorpera_list_company_computer_screens(p_company_computer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer screen listing requires provider authority' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(public.qorpera_company_computer_screen_json(screen) order by screen.screen_ordinal)
		from public.qorpera_company_computer_screens as screen
		where screen.company_computer_id = p_company_computer_id
	), '[]'::jsonb);
end
$$;

revoke all on function public.qorpera_list_company_computer_screens(uuid) from public;
grant execute on function public.qorpera_list_company_computer_screens(uuid) to service_role;
