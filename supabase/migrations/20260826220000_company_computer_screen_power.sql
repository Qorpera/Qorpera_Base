-- Screen power (founder model 2026-08-26): agents and members power their own
-- screens on and off, never the shared machine — the Company Computer's power
-- is derived: it runs while any screen is open and powers off when none are.
-- Ordinary turns stay headless over the live company file; opening a screen
-- is the deliberate act that summons the desktop (and, through the provider's
-- power reconciliation, the machine itself). Closing never loses anything:
-- the row, the attachment, and the identity persist for the next open.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create function public.qorpera_open_company_computer_screen(p_screen_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_screen public.qorpera_company_computer_screens%rowtype;
begin
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = p_screen_id
	for update;
	if not found or v_user_id is null or not public.qorpera_can_write_profile(v_screen.profile_id) then
		raise exception 'company computer screen power requires write access' using errcode = '42501';
	end if;
	if v_screen.status <> 'active' then
		raise exception 'company computer screen is retired' using errcode = '55000';
	end if;
	if v_screen.power_state = 'open' then
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	update public.qorpera_company_computer_screens
	set power_state = 'open',
		power_changed_at = statement_timestamp(),
		updated_at = statement_timestamp()
	where id = v_screen.id
	returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_opened',
		jsonb_build_object('screen_id', v_screen.id, 'screen_ordinal', v_screen.screen_ordinal),
		v_user_id
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_open_company_computer_screen(uuid) from public;
grant execute on function public.qorpera_open_company_computer_screen(uuid) to authenticated;

create function public.qorpera_close_company_computer_screen(p_screen_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_screen public.qorpera_company_computer_screens%rowtype;
begin
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = p_screen_id
	for update;
	if not found or v_user_id is null or not public.qorpera_can_write_profile(v_screen.profile_id) then
		raise exception 'company computer screen power requires write access' using errcode = '42501';
	end if;
	if v_screen.power_state = 'closed' then
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	if v_screen.occupying_run_id is not null and v_screen.occupancy_expires_at > statement_timestamp() then
		raise exception 'company computer screen is occupied by a live task' using errcode = '55000';
	end if;
	update public.qorpera_company_computer_screens
	set power_state = 'closed',
		power_changed_at = statement_timestamp(),
		occupying_run_id = null,
		occupancy_expires_at = null,
		updated_at = statement_timestamp()
	where id = v_screen.id
	returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_closed',
		jsonb_build_object('screen_id', v_screen.id, 'screen_ordinal', v_screen.screen_ordinal),
		v_user_id
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_close_company_computer_screen(uuid) from public;
grant execute on function public.qorpera_close_company_computer_screen(uuid) to authenticated;

-- The guest screen agent sweeps each poll tick: a screen nobody has touched
-- for the machine's idle window closes itself, and when the last one closes
-- the provider powers the machine off. Any occupancy activity bumps
-- updated_at (claims renew through the fence RPC), so "idle" is simply a
-- stale updated_at with no live occupancy.
create function public.qorpera_sweep_idle_company_computer_screens(
	p_company_computer_id uuid,
	p_idle_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_screen public.qorpera_company_computer_screens%rowtype;
	v_closed jsonb := '[]'::jsonb;
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer screen sweep requires execution authority' using errcode = '42501';
	end if;
	if p_idle_seconds is null or p_idle_seconds not between 60 and 86400 then
		raise exception 'company computer screen sweep is invalid' using errcode = '22023';
	end if;
	for v_screen in
		with closed as (
			update public.qorpera_company_computer_screens as screen
			set power_state = 'closed',
				power_changed_at = statement_timestamp(),
				occupying_run_id = null,
				occupancy_expires_at = null,
				updated_at = statement_timestamp()
			where screen.company_computer_id = p_company_computer_id
				and screen.status = 'active'
				and screen.power_state = 'open'
				and (screen.occupying_run_id is null or screen.occupancy_expires_at <= statement_timestamp())
				and screen.updated_at < statement_timestamp() - make_interval(secs => p_idle_seconds)
			returning screen.*
		)
		select closed.* from closed order by closed.screen_ordinal
	loop
		perform public.qorpera_append_company_computer_event(
			v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_closed',
			jsonb_build_object(
				'screen_id', v_screen.id,
				'screen_ordinal', v_screen.screen_ordinal,
				'source', 'idle'
			)
		);
		v_closed := v_closed || public.qorpera_company_computer_screen_json(v_screen);
	end loop;
	return v_closed;
end
$$;

revoke all on function public.qorpera_sweep_idle_company_computer_screens(uuid, integer) from public;
grant execute on function public.qorpera_sweep_idle_company_computer_screens(uuid, integer) to service_role;
