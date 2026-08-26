-- Step 3 screens registry (transport ratified 2026-08-26, see
-- deploy/first-node/STEP-3-SCREENS-DECISION.md): each staff agent attaches to
-- its own screen on the shared Company Computer; screens are parallel work
-- surfaces, never security boundaries. This registry holds which screens
-- exist, which staff agent each is attached to, and which run currently
-- occupies it — the one-task-per-screen fence the execution path claims and
-- releases. The per-screen VNC desktops, viewer paths, and keyframe capture
-- live in the guest image and broker, not here. Dispatch is unchanged: the
-- claim RPC is the runtime fence, and work admission keeps flowing through
-- qorpera_execution_compute_available exactly as deployed.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create table public.qorpera_company_computer_screens (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	company_computer_id uuid not null references public.qorpera_company_computers(id) on delete restrict,
	screen_ordinal integer not null check (screen_ordinal between 1 and 32),
	display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
	status text not null default 'active' check (status in ('active', 'retired')),
	-- Attachment names a roster staff agent; validated against
	-- qorpera_profile_staff in the RPCs rather than by foreign key because
	-- roster rows archive instead of deleting.
	attached_staff_agent_id uuid,
	attached_by_user_id uuid references auth.users(id) on delete restrict,
	attached_at timestamptz,
	occupying_run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	occupancy_expires_at timestamptz,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	unique (company_computer_id, screen_ordinal),
	unique (id, profile_id),
	check ((attached_staff_agent_id is null) = (attached_at is null)),
	check ((attached_staff_agent_id is null) = (attached_by_user_id is null)),
	check ((occupying_run_id is null) = (occupancy_expires_at is null)),
	check (attached_staff_agent_id is not null or occupying_run_id is null),
	check (status = 'active' or (attached_staff_agent_id is null and occupying_run_id is null))
);

-- One screen per staff agent per computer: an agent's screen IS its work
-- surface, so a second attachment is a contradiction, not a queue.
create unique index qorpera_company_computer_screens_staff
	on public.qorpera_company_computer_screens (company_computer_id, attached_staff_agent_id)
	where attached_staff_agent_id is not null;

alter table public.qorpera_company_computer_screens enable row level security;
revoke all on table public.qorpera_company_computer_screens from anon, authenticated;

create policy qorpera_company_computer_screens_member_read
	on public.qorpera_company_computer_screens for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

grant select on public.qorpera_company_computer_screens to authenticated;

alter table public.qorpera_company_computer_events
	drop constraint qorpera_company_computer_events_event_type_check;
alter table public.qorpera_company_computer_events
	add constraint qorpera_company_computer_events_event_type_check check (event_type in (
		'company_computer_registered', 'company_computer_lifecycle',
		'company_computer_screen_registered', 'company_computer_screen_attached',
		'company_computer_screen_detached', 'company_computer_screen_retired',
		'company_computer_screen_claimed', 'company_computer_screen_released'
	));

create function public.qorpera_company_computer_screen_json(
	p_screen public.qorpera_company_computer_screens
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'screen_id', p_screen.id,
		'profile_id', p_screen.profile_id,
		'company_computer_id', p_screen.company_computer_id,
		'screen_ordinal', p_screen.screen_ordinal,
		'display_name', p_screen.display_name,
		'status', p_screen.status,
		'attached_staff_agent_id', p_screen.attached_staff_agent_id,
		'attached_at', p_screen.attached_at,
		'occupying_run_id', p_screen.occupying_run_id,
		'occupancy_expires_at', p_screen.occupancy_expires_at,
		'created_at', p_screen.created_at,
		'updated_at', p_screen.updated_at
	)
$$;

revoke all on function public.qorpera_company_computer_screen_json(
	public.qorpera_company_computer_screens
) from public;

-- Screen capacity is a deliberate act: the number of screens is the shared
-- machine's parallel-work capacity and must match the desktops the guest
-- image serves. Idempotent on (computer, ordinal).
create function public.qorpera_register_company_computer_screen(
	p_company_computer_id uuid,
	p_screen_ordinal integer,
	p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_registry public.qorpera_company_computers%rowtype;
	v_screen public.qorpera_company_computer_screens%rowtype;
begin
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.id = p_company_computer_id
	for update;
	-- Unknown ids and missing authority answer identically so member RPCs
	-- are not an existence oracle for foreign registry rows.
	if not found or v_user_id is null or not public.qorpera_can_authorize_profile(v_registry.profile_id) then
		raise exception 'company computer screen registration requires authorize access' using errcode = '42501';
	end if;
	if p_screen_ordinal is null or p_screen_ordinal not between 1 and 32
		or char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120 then
		raise exception 'company computer screen registration is invalid' using errcode = '22023';
	end if;
	if v_registry.lifecycle_state = 'retired' then
		raise exception 'company computer is retired' using errcode = '55000';
	end if;
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.company_computer_id = v_registry.id and screen.screen_ordinal = p_screen_ordinal
	for update;
	if found then
		if v_screen.status <> 'active' or v_screen.display_name <> btrim(p_display_name) then
			raise exception 'company computer screen ordinal is already bound to other authority'
				using errcode = '23505';
		end if;
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	insert into public.qorpera_company_computer_screens (
		profile_id, company_computer_id, screen_ordinal, display_name, created_by_user_id
	) values (
		v_registry.profile_id, v_registry.id, p_screen_ordinal, btrim(p_display_name), v_user_id
	) returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_registry.profile_id, v_registry.id, 'company_computer_screen_registered',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'display_name', v_screen.display_name
		), v_user_id
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_register_company_computer_screen(uuid, integer, text) from public;
grant execute on function public.qorpera_register_company_computer_screen(uuid, integer, text) to authenticated;

create function public.qorpera_attach_company_computer_screen(
	p_screen_id uuid,
	p_staff_agent_id uuid
)
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
		raise exception 'company computer screen attachment requires write access' using errcode = '42501';
	end if;
	if p_staff_agent_id is null then
		raise exception 'company computer screen attachment is invalid' using errcode = '22023';
	end if;
	if v_screen.status <> 'active' then
		raise exception 'company computer screen is retired' using errcode = '55000';
	end if;
	if v_screen.attached_staff_agent_id = p_staff_agent_id then
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	if v_screen.attached_staff_agent_id is not null then
		raise exception 'company computer screen is attached to another staff agent' using errcode = '55000';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_staff as staff
		where staff.profile_id = v_screen.profile_id
			and staff.staff_agent_id = p_staff_agent_id
			and staff.employment_status = 'active'
	) then
		raise exception 'company computer screen requires an active staff agent' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_company_computer_screens as other
		where other.company_computer_id = v_screen.company_computer_id
			and other.attached_staff_agent_id = p_staff_agent_id
			and other.id <> v_screen.id
	) then
		raise exception 'staff agent is already attached to another screen' using errcode = '55000';
	end if;
	update public.qorpera_company_computer_screens
	set attached_staff_agent_id = p_staff_agent_id,
		attached_by_user_id = v_user_id,
		attached_at = statement_timestamp(),
		updated_at = statement_timestamp()
	where id = v_screen.id
	returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_attached',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'staff_agent_id', p_staff_agent_id
		), v_user_id
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_attach_company_computer_screen(uuid, uuid) from public;
grant execute on function public.qorpera_attach_company_computer_screen(uuid, uuid) to authenticated;

create function public.qorpera_detach_company_computer_screen(p_screen_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_screen public.qorpera_company_computer_screens%rowtype;
	v_previous_staff uuid;
begin
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = p_screen_id
	for update;
	if not found or v_user_id is null or not public.qorpera_can_write_profile(v_screen.profile_id) then
		raise exception 'company computer screen detachment requires write access' using errcode = '42501';
	end if;
	if v_screen.attached_staff_agent_id is null then
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	if v_screen.occupying_run_id is not null and v_screen.occupancy_expires_at > statement_timestamp() then
		raise exception 'company computer screen is occupied by a live task' using errcode = '55000';
	end if;
	v_previous_staff := v_screen.attached_staff_agent_id;
	update public.qorpera_company_computer_screens
	set attached_staff_agent_id = null,
		attached_by_user_id = null,
		attached_at = null,
		occupying_run_id = null,
		occupancy_expires_at = null,
		updated_at = statement_timestamp()
	where id = v_screen.id
	returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_detached',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'staff_agent_id', v_previous_staff
		), v_user_id
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_detach_company_computer_screen(uuid) from public;
grant execute on function public.qorpera_detach_company_computer_screen(uuid) to authenticated;

create function public.qorpera_retire_company_computer_screen(p_screen_id uuid)
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
	if not found or v_user_id is null or not public.qorpera_can_authorize_profile(v_screen.profile_id) then
		raise exception 'company computer screen retirement requires authorize access' using errcode = '42501';
	end if;
	if v_screen.status = 'retired' then
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	if v_screen.occupying_run_id is not null and v_screen.occupancy_expires_at > statement_timestamp() then
		raise exception 'company computer screen is occupied by a live task' using errcode = '55000';
	end if;
	update public.qorpera_company_computer_screens
	set status = 'retired',
		attached_staff_agent_id = null,
		attached_by_user_id = null,
		attached_at = null,
		occupying_run_id = null,
		occupancy_expires_at = null,
		updated_at = statement_timestamp()
	where id = v_screen.id
	returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_retired',
		jsonb_build_object('screen_id', v_screen.id, 'screen_ordinal', v_screen.screen_ordinal),
		v_user_id
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_retire_company_computer_screen(uuid) from public;
grant execute on function public.qorpera_retire_company_computer_screen(uuid) to authenticated;

-- The one-task-per-screen fence, claimed by the execution path when a
-- desktop task starts. A task runs on the attached agent's own screen and on
-- no other: the claiming run must belong to that staff agent and target the
-- screen's computer. Re-claim by the same run renews the expiry; an expired
-- fence is replaceable without an explicit release, mirroring assignment
-- fencing on the provider.
create function public.qorpera_claim_company_computer_screen(
	p_screen_id uuid,
	p_run_id uuid,
	p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_screen public.qorpera_company_computer_screens%rowtype;
	v_registry public.qorpera_company_computers%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_was_occupying uuid;
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer screen claim requires execution authority' using errcode = '42501';
	end if;
	if p_run_id is null or p_expires_at is null
		or p_expires_at <= statement_timestamp()
		or p_expires_at > statement_timestamp() + interval '24 hours' then
		raise exception 'company computer screen claim is invalid' using errcode = '22023';
	end if;
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = p_screen_id
	for update;
	if not found then
		raise exception 'company computer screen is unknown' using errcode = '55000';
	end if;
	if v_screen.status <> 'active' or v_screen.attached_staff_agent_id is null then
		raise exception 'company computer screen is not attached' using errcode = '55000';
	end if;
	select registry.* into strict v_registry
	from public.qorpera_company_computers as registry
	where registry.id = v_screen.company_computer_id;
	select run.* into v_run
	from public.qorpera_execution_runs as run
	where run.id = p_run_id;
	if not found
		or v_run.profile_id <> v_screen.profile_id
		or v_run.staff_agent_id <> v_screen.attached_staff_agent_id
		or v_run.logical_computer_id is distinct from v_registry.logical_computer_id then
		raise exception 'company computer screen claim does not match the attached staff agent'
			using errcode = '55000';
	end if;
	if v_screen.occupying_run_id is not null
		and v_screen.occupying_run_id <> p_run_id
		and v_screen.occupancy_expires_at > statement_timestamp() then
		raise exception 'company computer screen is occupied by another live task' using errcode = '55000';
	end if;
	v_was_occupying := v_screen.occupying_run_id;
	update public.qorpera_company_computer_screens
	set occupying_run_id = p_run_id,
		occupancy_expires_at = p_expires_at,
		updated_at = statement_timestamp()
	where id = v_screen.id
	returning * into v_screen;
	-- Expiry renewals by the holder are routine heartbeats; only a change of
	-- occupant is an auditable fact.
	if v_was_occupying is distinct from p_run_id then
		perform public.qorpera_append_company_computer_event(
			v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_claimed',
			jsonb_build_object(
				'screen_id', v_screen.id,
				'screen_ordinal', v_screen.screen_ordinal,
				'run_id', p_run_id,
				'expires_at', p_expires_at
			)
		);
	end if;
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_claim_company_computer_screen(uuid, uuid, timestamptz) from public;
grant execute on function public.qorpera_claim_company_computer_screen(uuid, uuid, timestamptz) to service_role;

create function public.qorpera_release_company_computer_screen(
	p_screen_id uuid,
	p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_screen public.qorpera_company_computer_screens%rowtype;
begin
	if auth.role() <> 'service_role' or p_run_id is null then
		raise exception 'company computer screen release requires execution authority' using errcode = '42501';
	end if;
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = p_screen_id
	for update;
	if not found then
		raise exception 'company computer screen is unknown' using errcode = '55000';
	end if;
	if v_screen.occupying_run_id is null or v_screen.occupying_run_id <> p_run_id then
		-- Goal-state release: if this run no longer holds the fence (already
		-- released, or lost to a newer claim after its expiry), the goal is
		-- met and cleanup must not fail.
		return public.qorpera_company_computer_screen_json(v_screen);
	end if;
	update public.qorpera_company_computer_screens
	set occupying_run_id = null,
		occupancy_expires_at = null,
		updated_at = statement_timestamp()
	where id = v_screen.id
	returning * into v_screen;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_screen.company_computer_id, 'company_computer_screen_released',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'run_id', p_run_id
		)
	);
	return public.qorpera_company_computer_screen_json(v_screen);
end
$$;

revoke all on function public.qorpera_release_company_computer_screen(uuid, uuid) from public;
grant execute on function public.qorpera_release_company_computer_screen(uuid, uuid) to service_role;
