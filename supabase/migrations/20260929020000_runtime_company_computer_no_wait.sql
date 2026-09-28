-- An agent never waits for a seat: when the company's machines are full, it
-- starts another one (Jonas, 28 September 2026: "if a machine is full, the
-- agent always should start a new one, not wait").
--
-- 20260929010100 added at most one new machine at a time. Every agent that
-- found the running machines full was placed on the one machine that was
-- starting, however many agents there were, and those that did not fit on it
-- waited again for the next. A sleeping machine was woken even when its node
-- had no room for it, so the agent waited for room that another node had. A
-- machine in maintenance for an update or reset, or with a cancelled start,
-- stopped any new machine from being added.
--
-- Now, with the scale-out switch on:
--   * Held seats. An agent waiting for a machine holds a seat on it: its start
--     waiter on the machine's current generation, while it waits and for two
--     minutes after it is woken (the moment between the wake and its run
--     opening the screen). A machine is full when its screens in use and the
--     seats other agents hold reach max_screens. A seat is held once per agent,
--     and not while the agent has a screen in use on any machine of the company.
--   * Placement joins a sleeping, waking or starting machine only while it has
--     a seat nobody holds; otherwise it goes on down the list and a new machine
--     is added. A burst of demand adds as many machines as it needs: one for
--     each max_screens agents without a seat. Native starts record the waiter
--     under the seat lock (20260929010100), so two starts never hold the same
--     last seat.
--   * An agent is placed first on the machine where it holds a seat, so the
--     descriptors and has_demand agree with its waiter.
--   * A sleeping machine is woken only when its node would admit it now: the
--     node is switched on and observed ready, and the machine's CPU and memory
--     fit what is left (the node ledger's admission rule; its demand is still
--     suspended). Otherwise the agent starts a new machine, which is placed on
--     any node with room. (A sleeping machine waking on another node is later
--     work of the identical-nodes plan.)
--   * A machine in maintenance for an update or reset, or with a cancelled
--     start, is passed over, never waited for and never replaced: it is used
--     again once it is back.
-- Switched off, nothing changes: the company has one machine, seats are taken
-- first come as before, and held seats are not counted.

-- Each rewrite below replaces a definition from 20260929010100 exactly; a
-- changed definition stops the migration instead of being overwritten.
do $guard$
begin
	if encode(sha256(convert_to((select prosrc from pg_proc
			where oid = 'public.qorpera_runtime_office_placement(uuid,uuid,uuid)'::regprocedure), 'UTF8')), 'hex')
			<> '13c00099554e8a82c93db807a6f6565fbf661edb75a483b71b128602a6d17598'
		or encode(sha256(convert_to((select prosrc from pg_proc
			where oid = 'public.qorpera_runtime_office_seats_taken(uuid,uuid)'::regprocedure), 'UTF8')), 'hex')
			<> 'c4caa6d3e6ffdb3feff9b8f0f2a394af33ed0101860dd87852b7151ad6fb5c62' then
		raise exception 'Office placement differs from 20260929010100';
	end if;
end
$guard$;

-- Agents other than p_staff_agent_id (or, with p_own, that agent itself) holding
-- a seat on the machine.
create function public.qorpera_runtime_office_seat_claims(p_office_id uuid, p_staff_agent_id uuid, p_own boolean)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
	select count(distinct r.staff_agent_id)::integer
	from public.qorpera_runtime_offices o
	join public.qorpera_runtime_office_start_intents i on i.office_id = o.id
		and i.computer_generation = o.generation and i.state <> 'cancelled'
	join public.qorpera_runtime_office_start_waiters w on w.intent_id = i.id
	join public.qorpera_execution_runs r on r.id = w.parent_run_id
	left join public.qorpera_wake_occurrences k on k.id = w.occurrence_id
	where o.id = p_office_id
		and (r.staff_agent_id = p_staff_agent_id) = p_own
		and (w.state = 'waiting'
			or (w.state = 'delivered' and k.created_at > clock_timestamp() - interval '2 minutes'))
		and not exists(select 1 from public.qorpera_runtime_offices so
			join public.qorpera_runtime_office_screens s on s.office_id = so.id
			where so.environment_id = o.environment_id and so.profile_id = o.profile_id
				and s.staff_agent_id = r.staff_agent_id and public.qorpera_runtime_office_screen_in_use(s))
$$;

-- A sleeping machine can wake now: its node slot is still held, or its node
-- would admit it again (qorpera_reserve_runtime_node_machine's rule, as
-- qorpera_runtime_node_placement_candidates restates it). A machine with no
-- node demand on record wakes as before.
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
			and (ob.observation ->> 'cpuMillis')::bigint >= n.cpu_millis
			and (ob.observation ->> 'memoryBytes')::bigint >= n.memory_bytes
			and d.cpu_millis + u.cpu <= (n.cpu_millis - n.headroom_cpu_millis) * n.cpu_allocation_ratio
			and d.memory_bytes + u.memory <= n.memory_bytes - n.headroom_memory_bytes, false)
		from public.qorpera_runtime_machine_allocations a
		join public.qorpera_runtime_node_demands d on d.allocation_id = a.id and d.released_at is null
		join public.qorpera_runtime_nodes n on n.id = d.node_id
		left join public.qorpera_runtime_node_observations ob on ob.node_id = n.id
		cross join lateral (
			select coalesce(sum(x.cpu_millis), 0)::bigint as cpu, coalesce(sum(x.memory_bytes), 0)::bigint as memory
			from public.qorpera_runtime_node_demands x
			where x.node_id = n.id and x.reserved_at is not null and x.released_at is null and x.suspended_at is null
		) u
		where a.office_id = p_office.id and a.computer_generation = p_office.generation and a.released_at is null
		order by a.reserved_at desc
		limit 1), true)
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
declare v_office public.qorpera_runtime_offices%rowtype;
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
	-- room: a free seat nobody holds; the machine where the agent holds a seat first.
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id and o.state = 'active'
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
		order by public.qorpera_runtime_office_seat_claims(o.id, p_staff_agent_id, true) > 0 desc,
			(select max(s.touched_at) from public.qorpera_runtime_office_screens s
				where s.office_id = o.id and s.staff_agent_id = p_staff_agent_id) desc nulls last,
			o.computer_number
		limit 1;
	if found then return jsonb_build_object('decision', 'room', 'officeId', v_office.id); end if;
	-- stopped: a sleeping machine with a seat nobody holds, only if its node would admit it now.
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id
			and public.qorpera_runtime_office_idle_pending(o)
			and not exists(select 1 from public.qorpera_runtime_office_start_intents i
				where i.office_id = o.id and i.computer_generation = o.generation and i.state = 'cancelled')
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
			and public.qorpera_runtime_office_can_wake(o)
		-- One already waking comes first, so repeated asks wake no second machine.
		order by public.qorpera_runtime_office_seat_claims(o.id, p_staff_agent_id, true) > 0 desc,
			public.qorpera_runtime_office_maintenance(o) ->> 'state' = 'resumed' desc,
			(select max(s.touched_at) from public.qorpera_runtime_office_screens s
				where s.office_id = o.id and s.staff_agent_id = p_staff_agent_id) desc nulls last,
			o.computer_number
		limit 1;
	if found then
		return jsonb_build_object('officeId', v_office.id, 'decision',
			case when public.qorpera_runtime_office_maintenance(v_office) ->> 'state' = 'resumed' then 'starting' else 'stopped' end);
	end if;
	-- starting: a machine that is starting, waking or back from a host reboot, with a seat nobody holds.
	select o.* into v_office from public.qorpera_runtime_offices o
		join public.qorpera_runtime_office_access a on a.office_id = o.id and a.staff_agent_id = p_staff_agent_id and a.state = 'active'
		where o.environment_id = p_environment_id and o.profile_id = p_profile_id
			and ((o.state in ('provisioning', 'recovering') and exists(select 1 from public.qorpera_runtime_office_start_intents i
					where i.office_id = o.id and i.computer_generation = o.generation and i.state <> 'cancelled'))
				or (o.state = 'maintenance' and public.qorpera_runtime_office_maintenance(o) ->> 'reason' = 'idle'
					and public.qorpera_runtime_office_maintenance(o) ->> 'state' = 'resumed')
				or (o.state = 'maintenance' and public.qorpera_runtime_office_maintenance(o) ->> 'reason' is distinct from 'idle'
					and public.qorpera_runtime_office_maintenance(o) is not null))
			and public.qorpera_runtime_office_seats_taken(o.id, p_staff_agent_id) < o.max_screens
		order by public.qorpera_runtime_office_seat_claims(o.id, p_staff_agent_id, true) > 0 desc, o.computer_number
		limit 1;
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

revoke all on function public.qorpera_runtime_office_seat_claims(uuid, uuid, boolean),
	public.qorpera_runtime_office_can_wake(public.qorpera_runtime_offices)
	from public, anon, authenticated, service_role;

-- The runtime authority functions have private owners in production: the
-- owners of the functions that call the placement helpers must be able to run
-- the new ones too (as 20260929010100 grants the others).
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
		execute format('grant execute on function public.qorpera_runtime_office_seat_claims(uuid, uuid, boolean),
			public.qorpera_runtime_office_can_wake(public.qorpera_runtime_offices) to %I', v_owner);
	end loop;
end
$grant$;
