-- Step 3 screens: the guest screen agent needs enough of the attached staff
-- agent's identity to dress the screen — the desktop wallpaper carries the
-- owning agent's creature, derived exactly as the shell derives it
-- (template mapping, else a stable identity hash). The service listing
-- therefore carries the roster's template id and display name alongside
-- each attachment; the shared screen json helper stays unchanged for the
-- member surfaces.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create or replace function public.qorpera_list_company_computer_screens(p_company_computer_id uuid)
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
		select jsonb_agg(
			public.qorpera_company_computer_screen_json(screen) || jsonb_build_object(
				'attached_staff_template_id', staff.template_id,
				'attached_staff_display_name', staff.display_name
			)
			order by screen.screen_ordinal
		)
		from public.qorpera_company_computer_screens as screen
		left join public.qorpera_profile_staff as staff
			on staff.profile_id = screen.profile_id
			and staff.staff_agent_id = screen.attached_staff_agent_id
		where screen.company_computer_id = p_company_computer_id
	), '[]'::jsonb);
end
$$;
