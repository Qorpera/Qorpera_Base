-- 2026-09-17 amendment: a member opens an agent's screen.
--
-- The contract names "opening an agent's screen" as a cloud operation, but a
-- screen only came to exist when an agent's run leased one, so a member who
-- opened an agent's computer found nothing to look at. A member who may write
-- in the company can now open the screen of an agent that has access to the
-- Company Computer: the agent's screen row is created on the lowest free
-- ordinal (or reopened), with no lease. The office guest already starts the
-- desktop for an open screen when a viewer connects, and an agent's later run
-- leases the same screen. Capacity refusals are the run path's own.

create function public.qorpera_open_runtime_office_screen(p_scope jsonb, p_staff_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_office public.qorpera_runtime_offices%rowtype;
	v_access public.qorpera_runtime_office_access%rowtype;
	v_screen public.qorpera_runtime_office_screens%rowtype;
	v_ordinal integer;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_scope is null or p_staff_agent_id is null then
		raise exception 'Office member required' using errcode = '42501'; end if;
	select * into v_office from public.qorpera_runtime_offices
		where id = (p_scope ->> 'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or not public.qorpera_can_write_profile(v_office.profile_id) then
		raise exception 'Office member unavailable' using errcode = '42501'; end if;
	if v_office.state <> 'active' then
		return jsonb_build_object('state', 'refused', 'reason', 'COMPUTER_NOT_ACTIVE'); end if;
	select * into v_access from public.qorpera_runtime_office_access
		where office_id = v_office.id and staff_agent_id = p_staff_agent_id and profile_id = v_office.profile_id for share;
	if not found or v_access.state <> 'active' then
		return jsonb_build_object('state', 'refused', 'reason', 'AGENT_HAS_NO_COMPUTER_ACCESS'); end if;
	select * into v_screen from public.qorpera_runtime_office_screens
		where office_id = v_office.id and staff_agent_id = p_staff_agent_id for update;
	if not found then
		select slot into v_ordinal from generate_series(1, v_office.max_screens) slot
			where not exists(select 1 from public.qorpera_runtime_office_screens where office_id = v_office.id and ordinal = slot)
			order by slot limit 1;
		if v_ordinal is null then
			return jsonb_build_object('state', 'refused', 'reason', 'SCREEN_CAPACITY_EXHAUSTED'); end if;
		insert into public.qorpera_runtime_office_screens(office_id, ordinal, staff_agent_id)
			values(v_office.id, v_ordinal, p_staff_agent_id) returning * into v_screen;
	end if;
	if v_screen.drain_pending then
		return jsonb_build_object('state', 'refused', 'reason', 'SCREEN_OCCUPIED'); end if;
	if v_screen.power <> 'open' then
		update public.qorpera_runtime_office_screens
			set power = 'open', generation = generation + 1, epoch = epoch + 1, touched_at = clock_timestamp()
			where id = v_screen.id returning * into v_screen;
		update public.qorpera_runtime_offices set revision = revision + 1 where id = v_office.id;
	end if;
	return jsonb_build_object('state', 'open', 'screenId', v_screen.id, 'screenOrdinal', v_screen.ordinal);
end
$$;
revoke all on function public.qorpera_open_runtime_office_screen(jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_open_runtime_office_screen(jsonb, uuid) to authenticated;
