-- An agent never waits for a seat: when the company's machines are full, it
-- starts another one (Jonas, 28 September 2026: "if a machine is full, the
-- agent always should start a new one, not wait").
--
-- 20260928237200 added at most one new machine at a time. Every agent that
-- found the running machines full was placed on the one machine that was
-- starting, however many agents there were, and those that did not fit on it
-- waited again for the next. A sleeping machine was woken even when its node
-- had no room for it, while another node had room for a new one. A machine in
-- maintenance for an update or reset, or with a cancelled start, stopped any
-- new machine from being added.
--
-- Now, with the scale-out switch on:
--   * Held seats. An agent waiting for a machine holds a seat on it: its start
--     waiter on the machine's current generation, while it waits (its request's
--     run did not fail) and, once woken, until its woken run ends (the two
--     clauses has_demand uses to keep the machine awake). Only for an employed
--     agent with active access, once per agent, and not while the agent has a
--     screen in use on a running machine. A machine whose start has waited 30
--     minutes for a host that never offered it holds no waiting seats, so a
--     broken setup does not add machine after machine.
--   * A machine is full when its screens in use and the seats other agents
--     hold reach max_screens. Seats go first come: an agent holding a seat
--     counts only the seats held before its own, so a machine asked for by
--     more agents than it has seats (starts in flight at the same moment) seats
--     the earliest, and the others are placed again.
--   * Placement, after the agent's own screen, returns the machine its start in
--     progress names (native start passes it), so a start never moves under
--     the agent: authorize, begin and the check after completion all see the
--     same machine. Then a running machine where it holds a seat (it was woken
--     for it); then free seats on running machines; then a machine not up yet
--     where it holds a seat (a free seat elsewhere comes first: its wake still
--     comes when that machine is up); then sleeping, waking and starting
--     machines, each only while it has a seat nobody holds; then a new machine.
--     A burst adds one machine for each max_screens agents without a seat.
--   * A sleeping machine is woken only when its node would admit it now (the
--     node ledger's admission rule; its demand is still suspended). If its node
--     is full but some node has room for a new machine, a new machine is added
--     instead; if no node has room, the sleeping machine is still woken and its
--     wake waits for room, as before. (Waking a sleeping machine on another
--     node is later work of the identical-nodes plan.)
--   * A machine in maintenance for an update or reset, or with a cancelled
--     start, is passed over, never waited for and never replaced: it is used
--     again once it is back.
-- The runtime asks for the machine to start when the agent calls
-- computer_start, not when the run began (packages/runtime), so the start
-- names the machine placement picks at that moment, a new one included.
-- Switched off, nothing changes: the company has one machine, seats are taken
-- first come as before, and held seats are not counted.

-- Each rewrite below replaces a definition from 20260928237200 exactly; a
-- changed definition stops the migration instead of being overwritten.
do $guard$
begin
	if encode(sha256(convert_to((select prosrc from pg_proc
			where oid = 'public.qorpera_runtime_office_placement(uuid,uuid,uuid)'::regprocedure), 'UTF8')), 'hex')
			<> '13c00099554e8a82c93db807a6f6565fbf661edb75a483b71b128602a6d17598'
		or encode(sha256(convert_to((select prosrc from pg_proc
			where oid = 'public.qorpera_runtime_office_seats_taken(uuid,uuid)'::regprocedure), 'UTF8')), 'hex')
			<> 'c4caa6d3e6ffdb3feff9b8f0f2a394af33ed0101860dd87852b7151ad6fb5c62' then
		raise exception 'Office placement differs from 20260928237200';
	end if;
end
$guard$;

-- A started machine that no host has offered for 30 minutes.
create function public.qorpera_runtime_office_start_stuck(p_office public.qorpera_runtime_offices)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
	select p_office.state in ('provisioning', 'recovering')
		and public.qorpera_runtime_office_start_wait(p_office) = 'setup'
		and exists(select 1 from public.qorpera_runtime_office_start_intents i where i.office_id = p_office.id
			and i.computer_generation = p_office.generation and i.state <> 'cancelled'
			and i.created_at < clock_timestamp() - interval '30 minutes')
$$;

-- With p_own, whether the agent holds a seat on the machine (0 or 1). Otherwise
-- how many other agents hold one there before it: all of them when it holds none.
create function public.qorpera_runtime_office_seat_claims(p_office_id uuid, p_staff_agent_id uuid, p_own boolean)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
	with holds as (
		select r.staff_agent_id as agent, min(w.created_at) as since
		from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_start_intents i on i.office_id = o.id
			and i.computer_generation = o.generation and i.state <> 'cancelled'
		join public.qorpera_runtime_office_start_waiters w on w.intent_id = i.id
			and (w.state = 'waiting'
				or (w.state = 'delivered' and greatest(w.created_at, w.scanned_at) > clock_timestamp() - interval '1 day'))
		join public.qorpera_execution_runs r on r.id = w.parent_run_id
		join public.qorpera_runner_jobs j on j.id = r.job_id
		join public.qorpera_profile_staff st on st.profile_id = o.profile_id and st.staff_agent_id = r.staff_agent_id
			and st.employment_status = 'active'
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = r.staff_agent_id
			and a.state = 'active'
		left join public.qorpera_wake_occurrences k on k.id = w.occurrence_id
		left join public.qorpera_execution_runs kr on kr.id = k.run_id
		left join public.qorpera_runner_jobs kj on kj.id = kr.job_id
		where o.id = p_office_id
			and ((w.state = 'waiting' and j.status not in ('failed', 'cancelled')
					and not public.qorpera_runtime_office_start_stuck(o))
				or (w.state = 'delivered' and (k.status = 'queued' or kj.status in ('queued', 'leased', 'running'))))
			and not exists(select 1 from public.qorpera_runtime_offices so
				join public.qorpera_runtime_office_screens s on s.office_id = so.id
				join public.qorpera_runtime_office_access sa on sa.office_id = so.id and sa.staff_agent_id = s.staff_agent_id
					and sa.state = 'active'
				where so.environment_id = o.environment_id and so.profile_id = o.profile_id and so.state = 'active'
					and s.staff_agent_id = r.staff_agent_id and public.qorpera_runtime_office_screen_in_use(s))
		group by r.staff_agent_id
	)
	select case when p_own then (select count(*) from holds where agent = p_staff_agent_id)
		else (select count(*) from holds h where h.agent <> p_staff_agent_id
			and (h.since, h.agent) < (coalesce((select m.since from holds m where m.agent = p_staff_agent_id),
				'infinity'::timestamptz), p_staff_agent_id)) end::integer
$$;

-- A sleeping machine can wake now: its node slot is still held, or its node
-- would admit it again under qorpera_reserve_runtime_node_machine's rule (as
-- qorpera_runtime_node_placement_candidates restates it), counting sleeping
-- machines on the node whose wake is already requested. A machine with no node
-- demand on record wakes as before.
create function public.qorpera_runtime_office_can_wake(p_office public.qorpera_runtime_offices)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
	select coalesce((
		select d.suspended_at is null or coalesce(n.enabled
			and ob.observed_at > clock_timestamp() - interval '60 seconds'
			and ob.observed_at <= clock_timestamp() + interval '2 seconds'
			and ob.observation ->> 'state' = 'ready'
			and public.qorpera_runtime_node_inventory_ready(n.id, ob.observation_id, n.version)
			and (ob.observation ->> 'cpuMillis')::bigint >= n.cpu_millis
			and (ob.observation ->> 'memoryBytes')::bigint >= n.memory_bytes
			and d.cpu_millis + u.cpu <= public.qorpera_runtime_node_cpu_budget(n)
			and d.memory_bytes + u.memory <= n.memory_bytes - n.headroom_memory_bytes, false)
		from public.qorpera_runtime_machine_allocations a
		join public.qorpera_runtime_node_demands d on d.allocation_id = a.id and d.released_at is null
		join public.qorpera_runtime_nodes n on n.id = d.node_id
		left join public.qorpera_runtime_node_observations ob on ob.node_id = n.id
		cross join lateral (
			select coalesce(sum(x.cpu_millis), 0)::bigint as cpu, coalesce(sum(x.memory_bytes), 0)::bigint as memory
			from public.qorpera_runtime_node_demands x
			where x.node_id = n.id and x.reserved_at is not null and x.released_at is null
				and (x.suspended_at is null or (x.allocation_id <> d.allocation_id and exists(
					select 1 from public.qorpera_runtime_machine_allocations xa
					join public.qorpera_runtime_office_idle_cycles c on c.office_id = xa.office_id
						and c.computer_generation = xa.computer_generation
					where xa.id = x.allocation_id and c.wake_requested_at is not null and c.activated_at is null
						and c.superseded_at is null)))
		) u
		where a.office_id = p_office.id and a.computer_generation = p_office.generation and a.released_at is null
		order by a.reserved_at desc
		limit 1), true)
$$;

-- Some node could take a new company machine now.
create function public.qorpera_runtime_office_new_machine_room()
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
	select exists(select 1 from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates('office')) c
		where (c ->> 'eligible')::boolean and (c ->> 'fits')::boolean)
$$;

-- What placing an agent on the machine means now; null when it cannot be used
-- or started (maintenance for an update or reset, a cancelled start, retired).
create function public.qorpera_runtime_office_start_decision(p_office public.qorpera_runtime_offices)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
	select case
		when p_office.state = 'active' then 'room'
		when exists(select 1 from public.qorpera_runtime_office_start_intents i where i.office_id = p_office.id
			and i.computer_generation = p_office.generation and i.state = 'cancelled') then null
		when p_office.state in ('provisioning', 'recovering') and exists(select 1 from public.qorpera_runtime_office_start_intents i
			where i.office_id = p_office.id and i.computer_generation = p_office.generation) then 'starting'
		when p_office.state in ('provisioning', 'recovering') then 'unstarted'
		when public.qorpera_runtime_office_idle_pending(p_office) then
			case when public.qorpera_runtime_office_maintenance(p_office) ->> 'state' = 'resumed' then 'starting' else 'stopped' end
		when p_office.state = 'maintenance' and public.qorpera_runtime_office_maintenance(p_office) is not null then 'starting'
		else null end
$$;

create or replace function public.qorpera_runtime_office_seats_taken(p_office_id uuid, p_staff_agent_id uuid)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
	select (select count(*)::integer from public.qorpera_runtime_office_screens s
		where s.office_id = p_office_id and s.staff_agent_id <> p_staff_agent_id
			and public.qorpera_runtime_office_screen_in_use(s))
		+ case when public.qorpera_runtime_office_scale_out_enabled()
			then public.qorpera_runtime_office_seat_claims(p_office_id, p_staff_agent_id, false) else 0 end
$$;

create or replace function public.qorpera_runtime_office_placement(p_profile_id uuid, p_environment_id uuid, p_staff_agent_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_target uuid; v_setting text;
begin
	-- denied: a revoked grant stays revoked, and no computer is added around it.
	if exists(select 1 from public.qorpera_runtime_offices where environment_id = p_environment_id
			and profile_id = p_profile_id and state <> 'retired')
		and not exists(select 1 from public.qorpera_runtime_offices o
			join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id
				and a.state = 'active'
			where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state <> 'retired') then
		return '{"decision":"denied"}'::jsonb;
	end if;
	if not public.qorpera_runtime_office_scale_out_enabled() then
		-- Only the company's first computer, as before several computers: screen
		-- tools while it runs (a full computer refuses at the seat), otherwise start it.
		select o.* into v_office from public.qorpera_runtime_offices o
			where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state <> 'retired'
			order by o.computer_number limit 1;
		if not found then return '{"decision":"none"}'::jsonb; end if;
		return jsonb_build_object('officeId', v_office.id, 'decision', case
			when v_office.state = 'active' then
				case when exists(select 1 from public.qorpera_runtime_office_screens s where s.office_id = v_office.id
					and s.staff_agent_id = p_staff_agent_id and public.qorpera_runtime_office_screen_in_use(s)) then 'screen' else 'room' end
			when v_office.state in ('provisioning', 'recovering') and exists(select 1 from public.qorpera_runtime_office_start_intents i
				where i.office_id = v_office.id and i.computer_generation = v_office.generation and i.state <> 'cancelled') then 'starting'
			when v_office.state in ('provisioning', 'recovering') then 'unstarted'
			when public.qorpera_runtime_office_idle_pending(v_office) then
				case when public.qorpera_runtime_office_maintenance(v_office) ->> 'state' = 'resumed' then 'starting' else 'stopped' end
			when v_office.state = 'maintenance' and public.qorpera_runtime_office_maintenance(v_office) is not null then 'starting'
			else 'none' end);
	end if;
	-- screen
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_screens s on s.office_id = o.id and s.staff_agent_id = p_staff_agent_id
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state = 'active'
			and public.qorpera_runtime_office_screen_in_use(s)
		order by s.touched_at desc, o.computer_number limit 1;
	if found then return jsonb_build_object('decision', 'screen', 'officeId', v_office.id); end if;
	-- held: the machine the agent's start in progress names (set by
	-- qorpera_native_office_start for its own agent), then a running machine where
	-- the agent holds a seat (it was woken for it). The start's machine stays while
	-- it can be started, even if other agents' starts in flight took its seats.
	v_setting := current_setting('qorpera.office_start_target', true);
	if v_setting ~ ('^' || p_staff_agent_id::text || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		v_target := split_part(v_setting, ':', 2)::uuid;
	end if;
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state <> 'retired'
			and public.qorpera_runtime_office_start_decision(o) is not null
			and (o.id = v_target
				or (o.state = 'active' and public.qorpera_runtime_office_seat_claims(o.id, p_staff_agent_id, true) > 0
					and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens))
		order by o.id = v_target desc nulls last, o.computer_number
		limit 1;
	if found then
		return jsonb_build_object('decision', public.qorpera_runtime_office_start_decision(v_office), 'officeId', v_office.id);
	end if;
	-- room: a free seat nobody holds.
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state = 'active'
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
		order by (select max(s.touched_at) from public.qorpera_runtime_office_screens s
				where s.office_id = o.id and s.staff_agent_id = p_staff_agent_id) desc nulls last,
			o.computer_number
		limit 1;
	if found then return jsonb_build_object('decision', 'room', 'officeId', v_office.id); end if;
	-- waited for: a machine that is not up yet where the agent holds a seat. A free
	-- seat on a running machine comes first; the wait's wake still comes when this
	-- machine is up.
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state not in ('active', 'retired')
			and public.qorpera_runtime_office_start_decision(o) is not null
			and public.qorpera_runtime_office_seat_claims(o.id, p_staff_agent_id, true) > 0
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
			and case when public.qorpera_runtime_office_idle_pending(o) and not public.qorpera_runtime_office_can_wake(o)
				then not public.qorpera_runtime_office_new_machine_room() else true end
		order by o.computer_number
		limit 1;
	if found then
		return jsonb_build_object('decision', public.qorpera_runtime_office_start_decision(v_office), 'officeId', v_office.id);
	end if;
	-- stopped: a sleeping machine with a seat nobody holds, whose node would admit it now.
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id
			and public.qorpera_runtime_office_idle_pending(o)
			and not exists(select 1 from public.qorpera_runtime_office_start_intents i
				where i.office_id = o.id and i.computer_generation = o.generation and i.state = 'cancelled')
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
			and public.qorpera_runtime_office_can_wake(o)
		-- One already waking comes first, so repeated asks wake no second machine.
		order by public.qorpera_runtime_office_maintenance(o) ->> 'state' = 'resumed' desc,
			(select max(s.touched_at) from public.qorpera_runtime_office_screens s
				where s.office_id = o.id and s.staff_agent_id = p_staff_agent_id) desc nulls last,
			o.computer_number
		limit 1;
	if found then
		return jsonb_build_object('officeId', v_office.id, 'decision',
			case when public.qorpera_runtime_office_maintenance(v_office) ->> 'state' = 'resumed' then 'starting' else 'stopped' end);
	end if;
	-- starting: a machine that is starting, waking or back from a host reboot, with
	-- a seat nobody holds; a waking one only if its node takes it or no node has
	-- room for a new machine.
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id
			and ((o.state in ('provisioning', 'recovering') and exists(select 1 from public.qorpera_runtime_office_start_intents i
					where i.office_id = o.id and i.computer_generation = o.generation and i.state <> 'cancelled'))
				or (o.state = 'maintenance' and public.qorpera_runtime_office_maintenance(o) ->> 'reason' = 'idle'
					and public.qorpera_runtime_office_maintenance(o) ->> 'state' = 'resumed'
					and case when public.qorpera_runtime_office_can_wake(o) then true
						else not public.qorpera_runtime_office_new_machine_room() end)
				or (o.state = 'maintenance' and public.qorpera_runtime_office_maintenance(o) ->> 'reason' is distinct from 'idle'
					and public.qorpera_runtime_office_maintenance(o) is not null))
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
		order by o.computer_number limit 1;
	if found then return jsonb_build_object('decision', 'starting', 'officeId', v_office.id); end if;
	-- unstarted
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state in ('provisioning', 'recovering')
			and not exists(select 1 from public.qorpera_runtime_office_start_intents i
				where i.office_id = o.id and i.computer_generation = o.generation)
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
		order by o.computer_number limit 1;
	if found then return jsonb_build_object('decision', 'unstarted', 'officeId', v_office.id); end if;
	-- A sleeping machine whose node is full is still woken when no node has room
	-- for a new machine either: its wake waits for room, as before. (Node room is
	-- read only when such a machine exists.)
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id
			and public.qorpera_runtime_office_idle_pending(o)
			and not exists(select 1 from public.qorpera_runtime_office_start_intents i
				where i.office_id = o.id and i.computer_generation = o.generation and i.state = 'cancelled')
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
		order by public.qorpera_runtime_office_maintenance(o) ->> 'state' = 'resumed' desc, o.computer_number
		limit 1;
	if found and not public.qorpera_runtime_office_new_machine_room() then
		return jsonb_build_object('officeId', v_office.id, 'decision',
			case when public.qorpera_runtime_office_maintenance(v_office) ->> 'state' = 'resumed' then 'starting' else 'stopped' end);
	end if;
	-- new: no machine has a seat for the agent now or when it is up, and the agent
	-- may use the company's machines. A machine in maintenance for an update or
	-- reset, or with a cancelled start, is passed over: never waited for.
	if exists(select 1 from public.qorpera_runtime_offices o
			join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id
				and a.state = 'active'
			where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state <> 'retired') then
		return '{"decision":"new"}'::jsonb;
	end if;
	return '{"decision":"none"}'::jsonb;
end
$$;

-- computer_start names the machine it starts; placement keeps that machine for
-- the start's own agent while it reads the descriptor (authorize, begin and the
-- check after completion), so the start does not move under it.
do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure);
	v_old text;
	v_new text;
begin
	v_old := $old$	v_descriptor:=public.qorpera_native_office_start_descriptor(p_binding,p_action='authorize');
	select * into v_office from public.qorpera_runtime_offices
		where id=(v_descriptor#>>'{scope,companyComputerId}')::uuid for update;$old$;
	v_new := $new$	-- The machine this start names stays placed for its agent while it can be
	-- started (20260928238000).
	begin
		perform set_config('qorpera.office_start_target',(v_authority#>>'{identity,staffAgentId}')||':'||
			coalesce(p_envelope::jsonb#>>'{operation,target,scope,companyComputerId}',''),true);
	exception when invalid_text_representation then null;
	end;
	v_descriptor:=public.qorpera_native_office_start_descriptor(p_binding,p_action='authorize');
	perform set_config('qorpera.office_start_target','',true);
	select * into v_office from public.qorpera_runtime_offices
		where id=(v_descriptor#>>'{scope,companyComputerId}')::uuid for update;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office start descriptor call differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$patch$;

revoke all on function public.qorpera_runtime_office_start_stuck(public.qorpera_runtime_offices),
	public.qorpera_runtime_office_seat_claims(uuid, uuid, boolean),
	public.qorpera_runtime_office_can_wake(public.qorpera_runtime_offices),
	public.qorpera_runtime_office_new_machine_room(),
	public.qorpera_runtime_office_start_decision(public.qorpera_runtime_offices)
	from public, anon, authenticated, service_role;

-- The runtime authority functions have private owners in production: the
-- owners of the functions that call the placement helpers must be able to run
-- the new ones too (as 20260928237200 grants the others).
do $grant$
declare v_owner name;
begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_native_office_descriptor(jsonb)'::regprocedure,
		'public.qorpera_native_office_start_descriptor(jsonb,boolean)'::regprocedure,
		'public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure,
		'public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb)'::regprocedure,
		'public.qorpera_native_office_screen_v1(jsonb,jsonb,text,jsonb)'::regprocedure,
		'public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure,
		'public.qorpera_open_runtime_office_screen(jsonb,uuid)'::regprocedure,
		'public.qorpera_member_agent_office(uuid,uuid)'::regprocedure,
		'public.qorpera_runtime_office_setup_queue()'::regprocedure
	]) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Office seat function has an API owner'; end if;
		execute format('grant execute on function public.qorpera_runtime_office_start_stuck(public.qorpera_runtime_offices),
			public.qorpera_runtime_office_seat_claims(uuid, uuid, boolean),
			public.qorpera_runtime_office_can_wake(public.qorpera_runtime_offices),
			public.qorpera_runtime_office_new_machine_room(),
			public.qorpera_runtime_office_start_decision(public.qorpera_runtime_offices) to %I', v_owner);
	end loop;
end
$grant$;
