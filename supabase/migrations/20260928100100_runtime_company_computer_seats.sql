-- Screens are seats, and an agent's screen goes to whichever of the company's
-- computers has room (contract section 12; 2026-09-16 amendment "six desktop
-- screens per Company Computer ... an additional Company Computer for the same
-- company starts when all screens are occupied").
--
-- 1. Seats. Until now an agent that had ever used a computer kept a screen row
--    on it for good, and rows were limited to max_screens, so a computer was
--    "full" after six different agents had used it, even with nobody on it.
--    Now a screen is in use while an agent holds its lease, a member watches
--    or drives it, a drain or takeover is pending, agent resources on it have
--    not drained, or it was opened or touched in the last two minutes (the
--    moment between a member opening it and the viewer connecting). A computer
--    is full when max_screens of its screens are in use. Rows are no longer
--    limited to max_screens: an agent gets a row on the lowest free display
--    number up to 32, and past that the screen unused for longest changes
--    hands. An agent works on one computer at a time.
--
-- 2. Placement. qorpera_runtime_office_placement picks, for one agent:
--    screen    its screen in use on a running computer;
--    room      a running computer with a free screen: the one the agent used
--              last, then the lowest number, so extra computers can idle off;
--    starting  a computer that is already starting, waking or coming back from
--              a host reboot (never start a second one for the same burst);
--    stopped   a computer that is off after its idle time;
--    unstarted a computer that was added but never started;
--    new       every computer is running and full: add one;
--    none      no computer the agent can use (none registered, or one is in
--              maintenance for another reason).
--    The native tool descriptor offers screen tools on 'screen' and 'room';
--    the start descriptor offers computer_start on the rest and adds the next
--    computer on 'new'. Adding a computer only records demand: the host is
--    prepared for it separately (deploy/office-fleet), and until then its start
--    waits like any start.
--
-- 3. Idle. A computer other than the company's first stays on for the runs of
--    agents that are placed on it, not for every run of the company. The first
--    computer keeps today's rule.
--
-- Lock order: company GC fence, then the environment's seat lock, then computer
-- rows. Taking a seat (native acquire, a member opening a screen) takes the
-- seat lock before the computer row; adding a computer takes the fence first.

create function public.qorpera_lock_runtime_office_seats(p_environment_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
	select pg_advisory_xact_lock(hashtextextended('qorpera.runtime-office-seats:' || p_environment_id::text, 0))
$$;

create function public.qorpera_runtime_office_screen_in_use(p_screen public.qorpera_runtime_office_screens)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
	select p_screen.lease_id is not null or p_screen.drain_pending or p_screen.takeover_user_id is not null
		or p_screen.touched_at > clock_timestamp() - interval '2 minutes'
		or exists(select 1 from public.qorpera_runtime_office_viewers v where v.screen_id = p_screen.id
			and v.state <> 'ended' and (v.expires_at > clock_timestamp() or v.mode = 'control' or v.state = 'draining'))
		or exists(select 1 from public.qorpera_runtime_office_resources r where r.screen_id = p_screen.id and r.state <> 'drained')
$$;

-- Screens in use on one computer by agents other than the given one.
create function public.qorpera_runtime_office_seats_taken(p_office_id uuid, p_staff_agent_id uuid)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
	select count(*)::integer from public.qorpera_runtime_office_screens s
	where s.office_id = p_office_id and s.staff_agent_id <> p_staff_agent_id
		and public.qorpera_runtime_office_screen_in_use(s)
$$;

-- The agent's own screen in use, or a free seat for it.
create function public.qorpera_runtime_office_has_seat(p_office public.qorpera_runtime_offices, p_staff_agent_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
	select exists(select 1 from public.qorpera_runtime_office_screens s where s.office_id = p_office.id
			and s.staff_agent_id = p_staff_agent_id and public.qorpera_runtime_office_screen_in_use(s))
		or public.qorpera_runtime_office_seats_taken(p_office.id, p_staff_agent_id) < p_office.max_screens
$$;

-- The agent has a screen in use on another running computer of the company.
create function public.qorpera_runtime_office_agent_elsewhere(p_office public.qorpera_runtime_offices, p_staff_agent_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
	select exists(select 1 from public.qorpera_runtime_office_screens s
		join public.qorpera_runtime_offices o on o.id = s.office_id
		where o.environment_id = p_office.environment_id and o.id <> p_office.id and o.state = 'active'
			and s.staff_agent_id = p_staff_agent_id and public.qorpera_runtime_office_screen_in_use(s))
$$;

-- Internal. The caller holds the seat lock and the computer row, has checked
-- the agent's access and qorpera_runtime_office_has_seat, and found no row for
-- the agent on this computer.
create function public.qorpera_runtime_office_take_seat(p_office public.qorpera_runtime_offices, p_staff_agent_id uuid)
returns public.qorpera_runtime_office_screens
language plpgsql
security definer
set search_path = ''
as $$
declare v_screen public.qorpera_runtime_office_screens%rowtype; v_ordinal integer;
begin
	select slot into v_ordinal from generate_series(1, 32) slot
		where not exists(select 1 from public.qorpera_runtime_office_screens where office_id = p_office.id and ordinal = slot)
		order by slot limit 1;
	if v_ordinal is not null then
		insert into public.qorpera_runtime_office_screens(office_id, ordinal, staff_agent_id)
			values (p_office.id, v_ordinal, p_staff_agent_id) returning * into v_screen;
		return v_screen;
	end if;
	-- Every display number has a row: the screen unused for longest changes hands.
	-- A new generation and epoch fence everything bound to its previous agent.
	select s.* into v_screen from public.qorpera_runtime_office_screens s
		where s.office_id = p_office.id and not public.qorpera_runtime_office_screen_in_use(s)
		order by s.touched_at, s.ordinal limit 1 for update;
	if not found then return null; end if;
	update public.qorpera_runtime_office_screens
		set staff_agent_id = p_staff_agent_id, power = 'closed', generation = generation + 1, epoch = epoch + 1,
			touched_at = clock_timestamp()
		where id = v_screen.id returning * into v_screen;
	update public.qorpera_runtime_offices set revision = revision + 1 where id = p_office.id;
	return v_screen;
end
$$;

create function public.qorpera_runtime_office_placement(p_profile_id uuid, p_environment_id uuid, p_staff_agent_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_office public.qorpera_runtime_offices%rowtype;
begin
	-- screen
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_screens s on s.office_id = o.id and s.staff_agent_id = p_staff_agent_id
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state = 'active'
			and public.qorpera_runtime_office_screen_in_use(s)
		order by s.touched_at desc, o.computer_number limit 1;
	if found then return jsonb_build_object('decision', 'screen', 'officeId', v_office.id); end if;
	-- room
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state = 'active'
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
		order by (select max(s.touched_at) from public.qorpera_runtime_office_screens s
				where s.office_id = o.id and s.staff_agent_id = p_staff_agent_id) desc nulls last,
			o.computer_number
		limit 1;
	if found then return jsonb_build_object('decision', 'room', 'officeId', v_office.id); end if;
	-- starting
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id
			and ((o.state in ('provisioning', 'recovering') and exists(select 1 from public.qorpera_runtime_office_start_intents i
					where i.office_id = o.id and i.computer_generation = o.generation and i.state <> 'cancelled'))
				or (o.state = 'maintenance' and public.qorpera_runtime_office_maintenance(o) ->> 'reason' = 'idle'
					and public.qorpera_runtime_office_maintenance(o) ->> 'state' = 'resumed')
				or (o.state = 'maintenance' and public.qorpera_runtime_office_maintenance(o) ->> 'reason' is distinct from 'idle'
					and public.qorpera_runtime_office_maintenance(o) is not null))
		order by o.computer_number limit 1;
	if found then return jsonb_build_object('decision', 'starting', 'officeId', v_office.id); end if;
	-- stopped
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id
			and public.qorpera_runtime_office_idle_pending(o)
			and not exists(select 1 from public.qorpera_runtime_office_start_intents i
				where i.office_id = o.id and i.computer_generation = o.generation and i.state = 'cancelled')
		order by (select max(s.touched_at) from public.qorpera_runtime_office_screens s
				where s.office_id = o.id and s.staff_agent_id = p_staff_agent_id) desc nulls last,
			o.computer_number
		limit 1;
	if found then return jsonb_build_object('decision', 'stopped', 'officeId', v_office.id); end if;
	-- unstarted
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state = 'provisioning'
			and not exists(select 1 from public.qorpera_runtime_office_start_intents i
				where i.office_id = o.id and i.computer_generation = o.generation)
		order by o.computer_number limit 1;
	if found then return jsonb_build_object('decision', 'unstarted', 'officeId', v_office.id); end if;
	-- new: only when every computer is running (and, having got here, full).
	-- Any other state (maintenance for an update or reset, a cancelled start)
	-- waits for its owner, exactly as a company with one computer does.
	if exists(select 1 from public.qorpera_runtime_offices where environment_id = p_environment_id
			and profile_id = p_profile_id and state = 'active')
		and not exists(select 1 from public.qorpera_runtime_offices where environment_id = p_environment_id
			and profile_id = p_profile_id and state not in ('active', 'retired')) then
		return '{"decision":"new"}'::jsonb;
	end if;
	return '{"decision":"none"}'::jsonb;
end
$$;

-- Why a started computer is not up yet: its host is not prepared for it
-- ('setup'), or prepared hosts have no room ('room'). Null otherwise.
create function public.qorpera_runtime_office_start_wait(p_office public.qorpera_runtime_offices)
returns text
language sql
stable
security definer
set search_path = ''
as $$
	select case
		when p_office.state not in ('provisioning', 'recovering') then null
		when not exists(select 1 from public.qorpera_runtime_office_start_intents i where i.office_id = p_office.id
			and i.computer_generation = p_office.generation and i.state <> 'cancelled') then null
		when exists(select 1 from public.qorpera_runtime_office_providers p where p.office_id = p_office.id
			and p.computer_generation = p_office.generation) then null
		when exists(select 1 from public.qorpera_runtime_office_fleet_offers f where f.office_id = p_office.id
			and f.computer_generation = p_office.generation and f.ready_at > clock_timestamp() - interval '60 seconds') then 'room'
		else 'setup' end
$$;

revoke all on function public.qorpera_lock_runtime_office_seats(uuid),
	public.qorpera_runtime_office_screen_in_use(public.qorpera_runtime_office_screens),
	public.qorpera_runtime_office_seats_taken(uuid, uuid),
	public.qorpera_runtime_office_has_seat(public.qorpera_runtime_offices, uuid),
	public.qorpera_runtime_office_agent_elsewhere(public.qorpera_runtime_offices, uuid),
	public.qorpera_runtime_office_take_seat(public.qorpera_runtime_offices, uuid),
	public.qorpera_runtime_office_placement(uuid, uuid, uuid),
	public.qorpera_runtime_office_start_wait(public.qorpera_runtime_offices)
	from public, anon, authenticated, service_role;

-- The native screen: a seat is taken under the seat lock, before the computer row.
do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb)'::regprocedure), 'sha256'), 'hex')
		<> '24af5c4c0eeef7d4a0387b35b95cb6321958f8cfad085b7063f01d9d57d1e87d' then
		raise exception 'Reviewed function definition changed: qorpera_native_office_screen';
	end if;
end $guard$;

create or replace function public.qorpera_native_office_screen(p_binding jsonb, p_scope jsonb, p_action text, p_lease jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_authority jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office runtime required' using errcode='42501'; end if;
	if p_action is distinct from 'release' then
		v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
		if p_action='acquire' then
			perform public.qorpera_lock_runtime_office_seats((v_authority#>>'{identity,environmentId}')::uuid);
		end if;
		select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
		if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.privacy_state<>'shared' then
			raise exception 'Office is private' using errcode='42501'; end if;
	end if;
	return public.qorpera_native_office_screen_v2(p_binding,p_scope,p_action,p_lease);
end
$$;

-- The native acquire: seats instead of a lifetime row per agent.
do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_native_office_screen_v1(jsonb,jsonb,text,jsonb)'::regprocedure);
	v_old text;
	v_new text;
begin
	v_old := $old$		if v_screen.id is null then
			select slot into v_ordinal from generate_series(1,v_office.max_screens) slot
				where not exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and ordinal=slot)
				order by slot limit 1;
			if v_ordinal is null then return jsonb_build_object('state','refused','reason','SCREEN_CAPACITY_EXHAUSTED'); end if;
			insert into public.qorpera_runtime_office_screens(office_id,ordinal,staff_agent_id)
			values(v_office.id,v_ordinal,v_staff) returning * into v_screen;
		end if;$old$;
	v_new := $new$		-- Screens are seats (20260928100100): one computer per agent at a time, and a
		-- computer is full when max_screens of its screens are in use.
		if public.qorpera_runtime_office_agent_elsewhere(v_office,v_staff) then
			return jsonb_build_object('state','refused','reason','SCREEN_OCCUPIED'); end if;
		if not public.qorpera_runtime_office_has_seat(v_office,v_staff) then
			return jsonb_build_object('state','refused','reason','SCREEN_CAPACITY_EXHAUSTED'); end if;
		if v_screen.id is null then
			v_screen:=public.qorpera_runtime_office_take_seat(v_office,v_staff);
			if v_screen.id is null then return jsonb_build_object('state','refused','reason','SCREEN_CAPACITY_EXHAUSTED'); end if;
		end if;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office screen acquire differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$patch$;

-- A member opening an agent's screen takes a seat the same way.
do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_open_runtime_office_screen(jsonb,uuid)'::regprocedure), 'sha256'), 'hex')
		<> '4a181870c4a8850065433c18832df589cccafdbe06fdccbb663ac6fc3ee131a8' then
		raise exception 'Reviewed function definition changed: qorpera_open_runtime_office_screen';
	end if;
end $guard$;

create or replace function public.qorpera_open_runtime_office_screen(p_scope jsonb, p_staff_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_office public.qorpera_runtime_offices%rowtype;
	v_access public.qorpera_runtime_office_access%rowtype;
	v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_scope is null or p_staff_agent_id is null then
		raise exception 'Office member required' using errcode = '42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id = (p_scope ->> 'companyComputerId')::uuid;
	if not found then raise exception 'Office member unavailable' using errcode = '42501'; end if;
	perform public.qorpera_lock_runtime_office_seats(v_office.environment_id);
	select * into v_office from public.qorpera_runtime_offices where id = v_office.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
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
	if public.qorpera_runtime_office_agent_elsewhere(v_office, p_staff_agent_id) then
		return jsonb_build_object('state', 'refused', 'reason', 'AGENT_ON_OTHER_COMPUTER'); end if;
	if not public.qorpera_runtime_office_has_seat(v_office, p_staff_agent_id) then
		return jsonb_build_object('state', 'refused', 'reason', 'SCREEN_CAPACITY_EXHAUSTED'); end if;
	if v_screen.id is null then
		v_screen := public.qorpera_runtime_office_take_seat(v_office, p_staff_agent_id);
		if v_screen.id is null then
			return jsonb_build_object('state', 'refused', 'reason', 'SCREEN_CAPACITY_EXHAUSTED'); end if;
	end if;
	if v_screen.drain_pending then
		return jsonb_build_object('state', 'refused', 'reason', 'SCREEN_OCCUPIED'); end if;
	if v_screen.power <> 'open' then
		update public.qorpera_runtime_office_screens
			set power = 'open', generation = generation + 1, epoch = epoch + 1, touched_at = clock_timestamp()
			where id = v_screen.id returning * into v_screen;
		update public.qorpera_runtime_offices set revision = revision + 1 where id = v_office.id;
	else
		-- Hold the seat while the viewer connects.
		update public.qorpera_runtime_office_screens set touched_at = clock_timestamp() where id = v_screen.id;
	end if;
	return jsonb_build_object('state', 'open', 'screenId', v_screen.id, 'screenOrdinal', v_screen.ordinal);
end
$$;
revoke all on function public.qorpera_open_runtime_office_screen(jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_open_runtime_office_screen(jsonb, uuid) to authenticated;

-- Screen tools are offered on the computer the agent is placed on.
do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_native_office_descriptor(jsonb)'::regprocedure);
	v_old text;
	v_new text;
begin
	v_old := $old$	v_grant public.qorpera_runtime_browser_grants%rowtype; v_resources jsonb; v_caps jsonb;$old$;
	v_new := $new$	v_grant public.qorpera_runtime_browser_grants%rowtype; v_resources jsonb; v_caps jsonb; v_place jsonb;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office descriptor declaration differs'; end if;
	v_definition := replace(v_definition, v_old, v_new);
	v_old := $old$	select * into v_office from public.qorpera_runtime_offices where environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and profile_id=(v_authority#>>'{identity,companyId}')::uuid and state='active' for share;$old$;
	v_new := $new$	-- The computer this agent is placed on: its screen in use, or a running
	-- computer with a free screen (20260928100100).
	v_place:=public.qorpera_runtime_office_placement((v_authority#>>'{identity,companyId}')::uuid,
		(v_authority#>>'{identity,environmentId}')::uuid,(v_authority#>>'{identity,staffAgentId}')::uuid);
	select * into v_office from public.qorpera_runtime_offices where id=(v_place->>'officeId')::uuid
		and v_place->>'decision' in ('screen','room') and state='active' for share;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office descriptor lookup differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$patch$;

-- computer_start is offered for the computer to start, wake or wait for, and
-- the next computer is added when every one is running and full.
do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_native_office_start_descriptor(jsonb,boolean)'::regprocedure), 'sha256'), 'hex')
		<> 'f27d70f27e0a194286935d735b753939391389a101820fe33fa321ecbe5c567a' then
		raise exception 'Reviewed function definition changed: qorpera_native_office_start_descriptor';
	end if;
end $guard$;

create or replace function public.qorpera_native_office_start_descriptor(p_binding jsonb, p_allow_active boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_authority jsonb; v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
	v_company uuid; v_environment uuid; v_staff uuid; v_place jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Native office authority required' using errcode='42501'; end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	if v_authority#>>'{identity,audienceKind}' is distinct from 'company' then
		raise exception 'Shared office start requires company audience' using errcode='42501'; end if;
	v_company:=(v_authority#>>'{identity,companyId}')::uuid;
	v_environment:=(v_authority#>>'{identity,environmentId}')::uuid;
	v_staff:=(v_authority#>>'{identity,staffAgentId}')::uuid;
	v_place:=public.qorpera_runtime_office_placement(v_company,v_environment,v_staff);
	if v_place->>'decision'='new' and not public.qorpera_company_execution_paused(v_company) then
		-- Decide again under the company fence and the seat lock before adding.
		perform public.qorpera_lock_profile_gc_fence(v_company);
		perform public.qorpera_lock_runtime_office_seats(v_environment);
		v_place:=public.qorpera_runtime_office_placement(v_company,v_environment,v_staff);
		if v_place->>'decision'='new' then
			v_office:=public.qorpera_add_runtime_office_computer(v_environment,'agent',v_staff,
				(v_authority#>>'{identity,runId}')::uuid,null);
			v_place:=jsonb_build_object('decision','unstarted','officeId',v_office.id);
		end if;
	end if;
	select * into v_office from public.qorpera_runtime_offices o where o.id=(v_place->>'officeId')::uuid
		and (v_place->>'decision' in ('starting','stopped','unstarted')
			or (p_allow_active is true and v_place->>'decision' in ('screen','room')))
		and (o.state in ('provisioning','recovering') or (p_allow_active is true and o.state='active')
			or (o.state='maintenance' and (public.qorpera_runtime_office_maintenance(o) is not null or public.qorpera_runtime_office_idle_pending(o)))) for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	if public.qorpera_company_execution_paused(v_office.profile_id)
		or not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
			and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
		or not exists(select 1 from public.qorpera_logical_computers computer where computer.id=v_office.logical_computer_id
			and computer.status='active' and public.qorpera_runtime_office_matches(computer)) then
		return '{"state":"unavailable"}'::jsonb; end if;
	select * into v_access from public.qorpera_runtime_office_access where office_id=v_office.id
		and staff_agent_id=v_staff and profile_id=v_office.profile_id and state='active' for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	if exists(select 1 from public.qorpera_runtime_office_start_intents where office_id=v_office.id
		and computer_generation=v_office.generation and state='cancelled') then return '{"state":"unavailable"}'::jsonb; end if;
	if v_office.state='active' and not exists(select 1 from public.qorpera_runtime_office_start_intents intent
		join public.qorpera_runtime_machine_allocations allocation on allocation.id=intent.allocation_id
		where intent.office_id=v_office.id and intent.computer_generation=v_office.generation and intent.state='reserved'
		and intent.image_sha256=v_office.image_sha256 and intent.bootstrap_sha256=v_office.bootstrap_sha256
		and allocation.office_id=v_office.id and allocation.computer_generation=v_office.generation
		and allocation.instance_sha256=intent.instance_sha256 and allocation.released_at is null) then
		return '{"state":"unavailable"}'::jsonb; end if;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','available','scope',public.qorpera_runtime_office_scope(v_office),
		'computerGeneration',v_office.generation,'resources',jsonb_build_object('officeGrantId',v_access.grant_id,'officeGrantVersion',v_access.version));
end
$$;
revoke all on function public.qorpera_native_office_start_descriptor(jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_native_office_start_descriptor(jsonb, boolean) to service_role;

-- computer_start locks the whole company's computers in one order, then starts
-- the computer its descriptor names.
do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure);
	v_old text;
	v_new text;
begin
	v_old := $old$	-- Take the exclusive office lock before descriptor reads acquire a shared
	-- lock, so simultaneous native starts never race a share-to-update upgrade.
	select * into v_office from public.qorpera_runtime_offices
		where environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and profile_id=(v_authority#>>'{identity,companyId}')::uuid for update;
	if not found then raise exception 'Native office start unavailable' using errcode='42501'; end if;
	-- Match the exact native input and receipt before recording durable demand.
	v_descriptor:=public.qorpera_native_office_start_descriptor(p_binding,p_action='authorize');$old$;
	v_new := $new$	-- Take the company fence, the seat lock and every computer of the company
	-- exclusively, in one order, before descriptor reads acquire shared locks, so
	-- simultaneous native starts never race a share-to-update upgrade and never
	-- both add a computer (20260928100100).
	perform public.qorpera_lock_profile_gc_fence((v_authority#>>'{identity,companyId}')::uuid);
	perform public.qorpera_lock_runtime_office_seats((v_authority#>>'{identity,environmentId}')::uuid);
	perform 1 from public.qorpera_runtime_offices
		where environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and profile_id=(v_authority#>>'{identity,companyId}')::uuid order by id for update;
	if not found then raise exception 'Native office start unavailable' using errcode='42501'; end if;
	-- Match the exact native input and receipt before recording durable demand.
	v_descriptor:=public.qorpera_native_office_start_descriptor(p_binding,p_action='authorize');
	select * into v_office from public.qorpera_runtime_offices
		where id=(v_descriptor#>>'{scope,companyComputerId}')::uuid for update;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office start lookup differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$patch$;

-- Idle: the company's first computer keeps today's rule (every authorized
-- run of the company is demand). Another computer counts only the runs of
-- agents placed on it, so an extra computer really turns off.
do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure), 'sha256'), 'hex')
		<> 'f3839d5eedd23d30a6d1c01d0c87e1c935b381b6b51b1a65fcb865383a43fccb' then
		raise exception 'Reviewed function definition changed: qorpera_runtime_office_has_demand';
	end if;
end $guard$;

create or replace function public.qorpera_runtime_office_has_demand(p_office public.qorpera_runtime_offices)
returns boolean
language sql
security definer
set search_path = ''
as $$
	select p_office.privacy_state<>'shared'
		or exists(select 1 from public.qorpera_runtime_office_screens s where s.office_id=p_office.id
			and (s.drain_pending or s.takeover_user_id is not null or s.lease_id is not null))
		or exists(select 1 from public.qorpera_runtime_office_resources r where r.office_id=p_office.id and r.state<>'drained')
		or exists(select 1 from public.qorpera_runtime_office_viewers v where v.office_id=p_office.id
			and v.state<>'ended' and (v.expires_at>clock_timestamp() or v.mode='control' or v.state='draining'))
		-- Tool discovery precedes the first guest lease. Retain a warm office for
		-- its currently authorized turns, including routines while members are away.
		or exists(select 1 from public.qorpera_execution_runs e join public.qorpera_runner_jobs j on j.id=e.job_id
			join public.qorpera_runtime_office_access g on g.office_id=p_office.id and g.profile_id=e.profile_id and g.staff_agent_id=e.staff_agent_id
			join public.qorpera_profile_staff s on s.profile_id=e.profile_id and s.staff_agent_id=e.staff_agent_id
			where e.profile_id=p_office.profile_id and e.environment_id=p_office.environment_id
			and e.audience_kind='company' and e.audience_user_id is null and j.status in ('queued','leased')
			and e.deadline_at>clock_timestamp() and g.state='active' and s.employment_status='active' and s.version=e.staff_version
			and (p_office.computer_number=(select min(o.computer_number) from public.qorpera_runtime_offices o
					where o.environment_id=p_office.environment_id and o.state<>'retired')
				or public.qorpera_runtime_office_placement(e.profile_id,e.environment_id,e.staff_agent_id)->>'officeId'=p_office.id::text))
		or exists(select 1 from public.qorpera_runtime_office_start_waiters w
			join public.qorpera_runtime_office_start_intents i on i.id=w.intent_id
			join public.qorpera_execution_runs e on e.id=w.parent_run_id
			join public.qorpera_runner_jobs j on j.id=e.job_id
			where i.office_id=p_office.id and i.computer_generation=p_office.generation
			and w.state='waiting' and j.status not in ('failed','cancelled'))
		or exists(select 1 from public.qorpera_wake_occurrences w
			left join public.qorpera_execution_runs e on e.id=w.run_id
			left join public.qorpera_runner_jobs j on j.id=e.job_id
			where w.source_kind='office-activation' and w.payload->>'companyComputerId'=p_office.id::text
			and (w.status='queued' or j.status in ('queued','leased','running')))
$$;

-- Members: the computer an agent's panel shows. Owners and admins may add the
-- next computer when every one is running and full, as an agent can.
create function public.qorpera_member_agent_office(p_environment_id uuid, p_staff_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_company uuid; v_role text; v_place jsonb; v_office public.qorpera_runtime_offices%rowtype; v_count integer;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_staff_agent_id is null then
		raise exception 'Company member required' using errcode='42501'; end if;
	select profile_id into v_company from public.qorpera_company_environments where id=p_environment_id;
	if not found then raise exception 'Company unavailable' using errcode='42501'; end if;
	-- A plain read: the panel asks again while it waits. Only adding a computer
	-- takes the company fence (and then the seat lock), and checks the role again.
	select role into v_role from public.qorpera_profile_members where profile_id=v_company and user_id=auth.uid();
	if not found or public.qorpera_profile_gc_deletion_active(v_company) then
		raise exception 'Company unavailable' using errcode='42501'; end if;
	if not exists(select 1 from public.qorpera_profile_staff where profile_id=v_company and staff_agent_id=p_staff_agent_id
		and employment_status='active') then raise exception 'Agent unavailable' using errcode='42501'; end if;
	v_place:=public.qorpera_runtime_office_placement(v_company,p_environment_id,p_staff_agent_id);
	if v_place->>'decision'='new' and v_role in ('owner','admin') and not public.qorpera_company_execution_paused(v_company) then
		perform public.qorpera_lock_profile_gc_fence(v_company);
		select role into v_role from public.qorpera_profile_members where profile_id=v_company and user_id=auth.uid() for share;
		perform public.qorpera_lock_runtime_office_seats(p_environment_id);
		v_place:=public.qorpera_runtime_office_placement(v_company,p_environment_id,p_staff_agent_id);
		if v_place->>'decision'='new' and v_role in ('owner','admin') then
			v_office:=public.qorpera_add_runtime_office_computer(p_environment_id,'member',p_staff_agent_id,null,auth.uid());
			v_place:=jsonb_build_object('decision','unstarted','officeId',v_office.id);
		end if;
	end if;
	select * into v_office from public.qorpera_runtime_offices where id=(v_place->>'officeId')::uuid;
	select count(*)::integer into v_count from public.qorpera_runtime_offices
		where environment_id=p_environment_id and profile_id=v_company and state<>'retired';
	return jsonb_build_object('companyId',v_company,'environmentId',p_environment_id,'staffAgentId',p_staff_agent_id,
		'canManage',v_role in ('owner','admin'),'computers',v_count,'placement',v_place->>'decision',
		'computer',case when v_office.id is null then null else jsonb_build_object(
			'scope',public.qorpera_runtime_office_scope(v_office),'number',v_office.computer_number,
			'waiting',public.qorpera_runtime_office_start_wait(v_office)) end);
end
$$;
revoke all on function public.qorpera_member_agent_office(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_agent_office(uuid, uuid) to authenticated;
