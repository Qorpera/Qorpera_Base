-- Screens on demand (founder direction 2026-08-26): any agent can use the
-- shared computer's screens as its work needs — a turn whose staff agent has
-- no screen must be able to get one, not silently run headless. The guest
-- screen agent calls this before claiming when its registry holds no screen
-- for the requesting agent: an existing attachment is returned as-is, a free
-- screen is attached, and otherwise a new screen is registered directly
-- attached — bounded by the machine's declared capacity. Attachments made
-- here carry no member actor (the execution plane acted), which the registry
-- models as null actor columns.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create function public.qorpera_ensure_company_computer_screen(
	p_company_computer_id uuid,
	p_staff_agent_id uuid,
	p_max_screens integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_registry public.qorpera_company_computers%rowtype;
	v_screen public.qorpera_company_computer_screens%rowtype;
	v_active_count integer;
	v_next_ordinal integer;
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer screen provisioning requires execution authority' using errcode = '42501';
	end if;
	if p_staff_agent_id is null or p_max_screens is null or p_max_screens not between 1 and 32 then
		raise exception 'company computer screen provisioning is invalid' using errcode = '22023';
	end if;
	-- The registry row lock serializes on-demand provisioning per computer,
	-- against both concurrent ensures and member screen registration.
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.id = p_company_computer_id
	for update;
	if not found then
		raise exception 'company computer is unknown' using errcode = '55000';
	end if;
	if v_registry.lifecycle_state = 'retired' then
		raise exception 'company computer is retired' using errcode = '55000';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_staff as staff
		where staff.profile_id = v_registry.profile_id
			and staff.staff_agent_id = p_staff_agent_id
			and staff.employment_status = 'active'
	) then
		raise exception 'company computer screen requires an active staff agent' using errcode = '55000';
	end if;
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.company_computer_id = v_registry.id
		and screen.attached_staff_agent_id = p_staff_agent_id
	for update;
	if found then
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.company_computer_id = v_registry.id
		and screen.status = 'active'
		and screen.attached_staff_agent_id is null
	order by screen.screen_ordinal
	limit 1
	for update;
	if found then
		update public.qorpera_company_computer_screens
		set attached_staff_agent_id = p_staff_agent_id,
			attached_at = statement_timestamp(),
			updated_at = statement_timestamp()
		where id = v_screen.id
		returning * into v_screen;
		perform public.qorpera_append_company_computer_event(
			v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_attached',
			jsonb_build_object(
				'screen_id', v_screen.id,
				'screen_ordinal', v_screen.screen_ordinal,
				'staff_agent_id', p_staff_agent_id,
				'source', 'on_demand'
			)
		);
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	select count(*) into v_active_count
	from public.qorpera_company_computer_screens as screen
	where screen.company_computer_id = v_registry.id and screen.status = 'active';
	-- Retired screens keep their ordinals (the display convention is bound to
	-- them forever), so the next ordinal is the lowest never used.
	select min(candidate.ordinal) into v_next_ordinal
	from generate_series(1, 32) as candidate(ordinal)
	where not exists (
		select 1 from public.qorpera_company_computer_screens as screen
		where screen.company_computer_id = v_registry.id and screen.screen_ordinal = candidate.ordinal
	);
	if v_active_count >= p_max_screens or v_next_ordinal is null then
		raise exception 'company computer screen capacity is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_company_computer_screens (
		profile_id, company_computer_id, screen_ordinal, display_name,
		attached_staff_agent_id, attached_at
	) values (
		v_registry.profile_id, v_registry.id, v_next_ordinal, format('Screen %s', v_next_ordinal),
		p_staff_agent_id, statement_timestamp()
	) returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_registered',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'display_name', v_screen.display_name,
			'source', 'on_demand'
		)
	);
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_attached',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'staff_agent_id', p_staff_agent_id,
			'source', 'on_demand'
		)
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_ensure_company_computer_screen(uuid, uuid, integer) from public;
grant execute on function public.qorpera_ensure_company_computer_screen(uuid, uuid, integer) to service_role;
