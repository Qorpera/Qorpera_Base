-- Computer hours, build step 2: measure machine time per company. Nothing is charged or stopped.
-- Contract: section 19, 2026-09-28 amendment "computer hours", items 1-3.
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Measuring").
--
-- Every input is central and on the database clock. No node keeps billing state.
-- * Machines (company, coding and agent machines): a trigger on qorpera_runtime_node_demands appends
--   every change of a machine's awake state to qorpera_computer_hour_log. Today suspended_at is
--   overwritten on every wake, so this log is the only sleep and wake history.
-- * Runs: a trigger on qorpera_runner_assignments appends each accepted assignment and its end. A run
--   counts at the standard size wherever it runs; run allocations and native node demands are never
--   read, so a fresh-VM run and a run on the shared execution host cost the same.
-- * Node inventory receipts are a check, never a clock: a report that shows a machine stopped, failed
--   or gone pauses its count, a report that shows it running resumes it, and a node silent for more
--   than five minutes pauses the machines on it.
-- qorpera_meter_computer_hours() turns these into per-company usage rows. An operator schedules it
-- once a minute with pg_cron; it is idempotent and serialised by an advisory lock. Per node, the
-- meter walks transitions and reports in time order, so a stop or a silence between two passes
-- is never billed.
--
-- Billing records outlive the company (bookkeeping), so none of these tables has a foreign key to
-- qorpera_profiles: qorpera_delete_hosted_profile hard-deletes that row with cascades.

-- One computer hour is one hour of a standard machine of 4 vCPU and 8 GiB. A machine counts by the
-- larger of its CPU and memory relative to the standard.
create function public.qorpera_computer_hour_size_factor(p_cpu_millis bigint, p_memory_bytes bigint)
returns numeric
language sql
immutable
set search_path = ''
as $$
	select round(greatest(p_cpu_millis::numeric / 4000, p_memory_bytes::numeric / 8589934592), 6)
$$;
revoke all on function public.qorpera_computer_hour_size_factor(bigint, bigint) from public, anon, authenticated, service_role;

create table public.qorpera_computer_hour_log (
	id bigint generated always as identity primary key,
	profile_id uuid not null,
	subject_kind text not null check (subject_kind in ('company_machine', 'agent_machine', 'coding_machine', 'run')),
	-- The machine allocation for machines, the runner assignment for runs.
	subject_id uuid not null,
	node_id uuid,
	state text not null check (state in ('awake', 'asleep', 'gone')),
	size_factor numeric(12, 6) check (size_factor is null or size_factor > 0),
	at timestamptz not null default clock_timestamp(),
	check ((state = 'awake') = (size_factor is not null)),
	check ((subject_kind = 'run') = (node_id is null))
);
create index qorpera_computer_hour_log_subject on public.qorpera_computer_hour_log (subject_id, id);

-- The meter's working set: one row per machine or run whose time is not fully counted yet.
create table public.qorpera_computer_hour_subjects (
	subject_id uuid primary key,
	subject_kind text not null check (subject_kind in ('company_machine', 'agent_machine', 'coding_machine', 'run')),
	profile_id uuid not null,
	node_id uuid,
	size_factor numeric(12, 6) not null check (size_factor > 0),
	awake_since timestamptz not null,
	-- Time up to which this stretch has been counted.
	counted_until timestamptz not null,
	-- Set by an asleep or gone log row.
	ended_at timestamptz,
	-- Set while a node report shows the machine not running, or its node is silent.
	paused_at timestamptz,
	pause_reason text check (pause_reason in ('observed_stopped', 'node_silent')),
	check ((paused_at is null) = (pause_reason is null)),
	check (subject_kind <> 'run' or (node_id is null and paused_at is null))
);
create index qorpera_computer_hour_subjects_node on public.qorpera_computer_hour_subjects (node_id)
	where node_id is not null;
create index qorpera_computer_hour_subjects_profile on public.qorpera_computer_hour_subjects (profile_id);

-- Per node: how far its inventory receipts have been read.
create table public.qorpera_computer_hour_nodes (
	node_id uuid primary key,
	-- Reports are read in the node's own order (observed_at only increases per node) ...
	cursor_observed_at timestamptz not null,
	cursor_observation_id uuid not null,
	-- ... and acted on at the database's receipt time.
	last_inventory_at timestamptz not null
);

-- Log rows the meter has not read yet. A queue, not a cursor: a transition that commits late (a
-- lower id after a higher one) is still read by the next pass. Per machine or run, transitions
-- commit in order, because each comes from an update of that machine's demand or that run's
-- assignment row.
create table public.qorpera_computer_hour_inbox (
	log_id bigint primary key references public.qorpera_computer_hour_log(id) on delete restrict
);

create table public.qorpera_computer_hour_meter (
	id boolean primary key default true check (id),
	metered_until timestamptz not null
);

-- One row per company per meter pass that counted anything, written once at the end of the pass.
-- Seconds are standard seconds (seconds times the size factor), exact per kind; standard_seconds is
-- what the pass adds after rounding up the company's running total once.
create table public.qorpera_computer_hour_usage (
	id bigint generated always as identity primary key,
	profile_id uuid not null,
	metered_at timestamptz not null,
	company_machine_seconds numeric(20, 6) not null default 0 check (company_machine_seconds >= 0),
	agent_machine_seconds numeric(20, 6) not null default 0 check (agent_machine_seconds >= 0),
	coding_machine_seconds numeric(20, 6) not null default 0 check (coding_machine_seconds >= 0),
	run_seconds numeric(20, 6) not null default 0 check (run_seconds >= 0),
	standard_seconds bigint not null default 0 check (standard_seconds >= 0),
	unique (profile_id, metered_at)
);

create table public.qorpera_computer_hour_totals (
	profile_id uuid primary key,
	exact_standard_seconds numeric(24, 6) not null check (exact_standard_seconds >= 0),
	charged_standard_seconds bigint not null check (charged_standard_seconds >= 0)
);

-- The log and the usage rows are append-only records; nothing updates or deletes them.
create function public.qorpera_computer_hour_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	raise exception 'Computer hour records are append-only' using errcode = '42501';
end
$$;
revoke all on function public.qorpera_computer_hour_append_only() from public, anon, authenticated, service_role;
create trigger qorpera_computer_hour_log_append_only
	before update or delete on public.qorpera_computer_hour_log
	for each row execute function public.qorpera_computer_hour_append_only();
create trigger qorpera_computer_hour_usage_append_only
	before update or delete on public.qorpera_computer_hour_usage
	for each row execute function public.qorpera_computer_hour_append_only();

alter table public.qorpera_computer_hour_log enable row level security;
alter table public.qorpera_computer_hour_subjects enable row level security;
alter table public.qorpera_computer_hour_nodes enable row level security;
alter table public.qorpera_computer_hour_meter enable row level security;
alter table public.qorpera_computer_hour_inbox enable row level security;
alter table public.qorpera_computer_hour_usage enable row level security;
alter table public.qorpera_computer_hour_totals enable row level security;
revoke all on public.qorpera_computer_hour_log, public.qorpera_computer_hour_subjects,
	public.qorpera_computer_hour_nodes, public.qorpera_computer_hour_meter, public.qorpera_computer_hour_inbox,
	public.qorpera_computer_hour_usage, public.qorpera_computer_hour_totals
	from public, anon, authenticated, service_role;
grant select on public.qorpera_computer_hour_log, public.qorpera_computer_hour_subjects,
	public.qorpera_computer_hour_nodes, public.qorpera_computer_hour_meter, public.qorpera_computer_hour_inbox,
	public.qorpera_computer_hour_usage, public.qorpera_computer_hour_totals
	to service_role;
revoke all on sequence public.qorpera_computer_hour_log_id_seq, public.qorpera_computer_hour_usage_id_seq
	from public, anon, authenticated, service_role;

-- Appends one transition to the log and queues it for the meter.
create function public.qorpera_computer_hour_record(
	p_profile_id uuid,
	p_subject_kind text,
	p_subject_id uuid,
	p_node_id uuid,
	p_state text,
	p_size_factor numeric,
	p_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_id bigint;
begin
	insert into public.qorpera_computer_hour_log (profile_id, subject_kind, subject_id, node_id, state, size_factor, at)
	values (p_profile_id, p_subject_kind, p_subject_id, p_node_id, p_state, p_size_factor, coalesce(p_at, clock_timestamp()))
	returning id into v_id;
	insert into public.qorpera_computer_hour_inbox (log_id) values (v_id);
end
$$;
revoke all on function public.qorpera_computer_hour_record(uuid, text, uuid, uuid, text, numeric, timestamptz)
	from public, anon, authenticated, service_role;

-- A machine is awake while its node demand is reserved, not suspended and not released.
create function public.qorpera_computer_hour_log_demand()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_kind text;
	v_was boolean := false;
	v_is boolean;
	v_profile uuid;
begin
	v_kind := case new.provider_kind
		when 'office' then 'company_machine'
		when 'coding' then 'coding_machine'
		when 'machine' then 'agent_machine'
	end;
	-- Run boxes are metered from their runs; sign-in machines never count.
	if v_kind is null then
		return null;
	end if;
	v_is := new.reserved_at is not null and new.suspended_at is null and new.released_at is null;
	if tg_op = 'UPDATE' then
		v_was := old.reserved_at is not null and old.suspended_at is null and old.released_at is null;
		-- A new awake row also starts a new stretch when an awake machine changes size.
		if v_is = v_was and not (v_is and (new.cpu_millis <> old.cpu_millis or new.memory_bytes <> old.memory_bytes)) then
			return null;
		end if;
	elsif not v_is then
		return null;
	end if;
	select allocation.profile_id into v_profile
	from public.qorpera_runtime_machine_allocations allocation
	where allocation.id = new.allocation_id;
	if v_profile is null then
		return null;
	end if;
	perform public.qorpera_computer_hour_record(
		v_profile, v_kind, new.allocation_id, new.node_id,
		case when v_is then 'awake' when new.released_at is not null then 'gone' else 'asleep' end,
		case when v_is then public.qorpera_computer_hour_size_factor(new.cpu_millis, new.memory_bytes) end,
		null
	);
	return null;
end
$$;
revoke all on function public.qorpera_computer_hour_log_demand() from public, anon, authenticated, service_role;

-- A run counts from its runner's acceptance to the earlier of the assignment's end and its expiry.
create function public.qorpera_computer_hour_log_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_state text;
	v_at timestamptz;
	v_profile uuid;
begin
	if tg_op = 'INSERT' then
		if new.accepted_at is null then
			return null;
		end if;
		v_state := 'awake';
		v_at := new.accepted_at;
	elsif old.accepted_at is null and new.accepted_at is not null then
		v_state := 'awake';
		v_at := new.accepted_at;
	elsif old.status = 'accepted' and new.status <> 'accepted' then
		-- The assignment's expiry follows the job lease: a lost host counts only to its lapsed lease.
		v_state := 'gone';
		v_at := least(coalesce(new.finished_at, clock_timestamp()), new.expires_at);
	else
		return null;
	end if;
	select run.profile_id into v_profile from public.qorpera_execution_runs run where run.id = new.run_id;
	if v_profile is null then
		return null;
	end if;
	perform public.qorpera_computer_hour_record(
		v_profile, 'run', new.id, null, v_state, case when v_state = 'awake' then 1 end, v_at
	);
	return null;
end
$$;
revoke all on function public.qorpera_computer_hour_log_assignment() from public, anon, authenticated, service_role;

-- Adds the standard seconds of [p_from, p_to) of one subject to the pass's per-company totals.
create function public.qorpera_computer_hour_add(
	p_totals jsonb,
	p_subject public.qorpera_computer_hour_subjects,
	p_from timestamptz,
	p_to timestamptz
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_amount numeric;
	v_company text := p_subject.profile_id::text;
begin
	if p_to is null or p_from is null or p_to <= p_from then
		return p_totals;
	end if;
	v_amount := round(extract(epoch from (p_to - p_from)) * p_subject.size_factor, 6);
	return jsonb_set(p_totals, array[v_company], coalesce(p_totals -> v_company, '{}'::jsonb)
		|| jsonb_build_object(p_subject.subject_kind,
			coalesce((p_totals -> v_company ->> p_subject.subject_kind)::numeric, 0) + v_amount));
end
$$;
revoke all on function public.qorpera_computer_hour_add(jsonb, public.qorpera_computer_hour_subjects, timestamptz, timestamptz)
	from public, anon, authenticated, service_role;

-- Where a node's inventory receipts start being read: its newest one, never its history.
create function public.qorpera_computer_hour_track_node(p_node_id uuid, p_default timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_newest record;
begin
	if exists (select 1 from public.qorpera_computer_hour_nodes where node_id = p_node_id) then
		return;
	end if;
	select observation.observed_at, observation.observation_id, observation.received_at into v_newest
	from public.qorpera_runtime_node_observation_receipts observation
	join public.qorpera_runtime_node_inventory_receipts inventory
		on inventory.node_id = observation.node_id and inventory.observation_id = observation.observation_id
	where observation.node_id = p_node_id
	order by observation.observed_at desc, observation.observation_id desc
	limit 1;
	insert into public.qorpera_computer_hour_nodes (node_id, cursor_observed_at, cursor_observation_id, last_inventory_at)
	values (
		p_node_id,
		coalesce(v_newest.observed_at, p_default),
		coalesce(v_newest.observation_id, '00000000-0000-0000-0000-000000000000'::uuid),
		-- A node that has never reported starts its five minutes now.
		coalesce(v_newest.received_at, p_default)
	)
	on conflict (node_id) do nothing;
end
$$;
revoke all on function public.qorpera_computer_hour_track_node(uuid, timestamptz) from public, anon, authenticated, service_role;

-- One meter pass counting up to p_now minus 30 seconds. Internal: only the owner calls it (tests
-- pass a time; qorpera_meter_computer_hours() passes the clock).
create function public.qorpera_meter_computer_hours_at(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	-- Count up to 30 seconds ago, so node reports and late transitions of that time have arrived.
	v_until timestamptz := p_now - interval '30 seconds';
	v_meter public.qorpera_computer_hour_meter%rowtype;
	v_ids bigint[];
	v_totals jsonb := '{}'::jsonb;
	v_log public.qorpera_computer_hour_log%rowtype;
	v_subject public.qorpera_computer_hour_subjects%rowtype;
	v_node_id uuid;
	v_node public.qorpera_computer_hour_nodes%rowtype;
	v_last timestamptz;
	v_from timestamptz;
	v_event record;
	v_entry jsonb;
	v_physical uuid;
	v_running boolean;
	v_end timestamptz;
	v_expires timestamptz;
	v_status text;
	v_company text;
	v_exact numeric;
	v_old public.qorpera_computer_hour_totals%rowtype;
	v_charged bigint;
	v_profiles integer := 0;
begin
	if p_now is null then
		raise exception 'A meter pass needs a time' using errcode = '22023';
	end if;
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.computer-hour-meter', 0)) then
		return jsonb_build_object('schema', 'qorpera.computer-hour-meter/v1', 'state', 'busy');
	end if;
	select * into strict v_meter from public.qorpera_computer_hour_meter for update;
	if v_until <= v_meter.metered_until then
		return jsonb_build_object('schema', 'qorpera.computer-hour-meter/v1', 'state', 'current',
			'meteredUntil', v_meter.metered_until);
	end if;
	with taken as (delete from public.qorpera_computer_hour_inbox returning log_id)
	select coalesce(array_agg(log_id order by log_id), '{}'::bigint[]) into v_ids from taken;

	-- 1. Every transition, in time order: runs have no node reports; machines are walked per node
	-- below together with that node's reports.
	for v_event in
		select log.id as log_id, log.node_id
		from public.qorpera_computer_hour_log log
		where log.id = any(v_ids) and log.node_id is null
		order by log.at, log.id
	loop
		select * into strict v_log from public.qorpera_computer_hour_log where id = v_event.log_id;
		select * into v_subject from public.qorpera_computer_hour_subjects where subject_id = v_log.subject_id for update;
		if v_log.state = 'awake' then
			if found and v_subject.ended_at is null then
				v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_log.at);
			end if;
			insert into public.qorpera_computer_hour_subjects as subject (
				subject_id, subject_kind, profile_id, node_id, size_factor, awake_since, counted_until
			)
			values (v_log.subject_id, v_log.subject_kind, v_log.profile_id, null, v_log.size_factor, v_log.at, v_log.at)
			on conflict (subject_id) do update set
				size_factor = excluded.size_factor, awake_since = excluded.awake_since,
				counted_until = greatest(subject.counted_until, excluded.counted_until), ended_at = null;
		elsif found and v_subject.ended_at is null then
			v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_log.at);
			update public.qorpera_computer_hour_subjects
			set counted_until = greatest(counted_until, v_log.at), ended_at = v_log.at
			where subject_id = v_log.subject_id;
		end if;
	end loop;

	-- 2. Machines, node by node: transitions and reports in time order. A report that shows a
	-- machine stopped, failed or absent pauses it, one that shows it running resumes it, and a gap of
	-- more than five minutes between reports pauses every machine counted on the node.
	for v_node_id in
		select log.node_id from public.qorpera_computer_hour_log log where log.id = any(v_ids) and log.node_id is not null
		union
		select subject.node_id from public.qorpera_computer_hour_subjects subject where subject.node_id is not null
		order by 1
	loop
		perform public.qorpera_computer_hour_track_node(v_node_id, p_now);
		select * into strict v_node from public.qorpera_computer_hour_nodes where node_id = v_node_id for update;
		v_last := v_node.last_inventory_at;
		-- Reports older than every machine counted on the node are never read: the read position
		-- moves up to a minute before the oldest of them (observed_at is the node's clock, accepted
		-- at most a minute behind the database's).
		select least(
			(select min(subject.awake_since) from public.qorpera_computer_hour_subjects subject where subject.node_id = v_node_id),
			(select min(log.at) from public.qorpera_computer_hour_log log where log.id = any(v_ids) and log.node_id = v_node_id)
		) - interval '1 minute' into v_from;
		if v_node.cursor_observed_at < v_from then
			v_node.cursor_observed_at := v_from;
			v_node.cursor_observation_id := '00000000-0000-0000-0000-000000000000';
		end if;
		for v_event in
			select 0 as source, log.at as event_at, log.id as log_id,
				null::timestamptz as observed_at, null::uuid as observation_id, null::jsonb as entries
			from public.qorpera_computer_hour_log log
			where log.id = any(v_ids) and log.node_id = v_node_id
			union all
			-- Read in the node's own order (observed_at only increases per node) and acted on at the
			-- database's receipt time.
			select 1, observation.received_at, null, observation.observed_at, observation.observation_id,
				inventory.inventory -> 'entries'
			from public.qorpera_runtime_node_observation_receipts observation
			join public.qorpera_runtime_node_inventory_receipts inventory
				on inventory.node_id = observation.node_id and inventory.observation_id = observation.observation_id
			where observation.node_id = v_node_id
				and (observation.observed_at, observation.observation_id) > (v_node.cursor_observed_at, v_node.cursor_observation_id)
			order by 2, 1, 3
		loop
			if v_event.source = 0 then
				select * into strict v_log from public.qorpera_computer_hour_log where id = v_event.log_id;
				select * into v_subject from public.qorpera_computer_hour_subjects where subject_id = v_log.subject_id for update;
				if v_log.state = 'awake' and found and v_subject.ended_at is null then
					-- A size change: count the old size up to here; a pause stays.
					if v_subject.paused_at is null then
						v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_log.at);
					end if;
					update public.qorpera_computer_hour_subjects
					set size_factor = v_log.size_factor, node_id = v_log.node_id,
						counted_until = greatest(counted_until, v_log.at)
					where subject_id = v_log.subject_id;
				elsif v_log.state = 'awake' then
					insert into public.qorpera_computer_hour_subjects as subject (
						subject_id, subject_kind, profile_id, node_id, size_factor, awake_since, counted_until
					)
					values (v_log.subject_id, v_log.subject_kind, v_log.profile_id, v_log.node_id, v_log.size_factor, v_log.at, v_log.at)
					on conflict (subject_id) do update set
						node_id = excluded.node_id, size_factor = excluded.size_factor, awake_since = excluded.awake_since,
						counted_until = greatest(subject.counted_until, excluded.counted_until),
						ended_at = null, paused_at = null, pause_reason = null;
				elsif found and v_subject.ended_at is null then
					if v_subject.paused_at is null then
						v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_log.at);
					end if;
					update public.qorpera_computer_hour_subjects
					set counted_until = greatest(counted_until, v_log.at), ended_at = v_log.at
					where subject_id = v_log.subject_id;
				end if;
			else
				-- A silence of more than five minutes before this report.
				if v_event.event_at > v_last + interval '5 minutes' then
					for v_subject in
						select * from public.qorpera_computer_hour_subjects
						where node_id = v_node_id and ended_at is null and paused_at is null
							and awake_since <= v_event.event_at
						order by subject_id
						for update
					loop
						v_end := greatest(v_subject.counted_until, v_last + interval '5 minutes');
						v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_end);
						update public.qorpera_computer_hour_subjects
						set counted_until = v_end, paused_at = v_end, pause_reason = 'node_silent'
						where subject_id = v_subject.subject_id;
					end loop;
				end if;
				for v_subject in
					select * from public.qorpera_computer_hour_subjects
					where node_id = v_node_id and ended_at is null and awake_since <= v_event.event_at
					order by subject_id
					for update
				loop
					v_entry := null;
					v_physical := null;
					select entry into v_entry from jsonb_array_elements(v_event.entries) entry
					where entry -> 'allocation' ->> 'allocationId' = v_subject.subject_id::text;
					if v_entry is null then
						-- A running machine can be reported as unmanaged when its tags or limits differ.
						select binding.physical_id into v_physical
						from public.qorpera_runtime_node_instance_bindings binding
						where binding.allocation_id = v_subject.subject_id;
						if v_physical is not null then
							select entry into v_entry from jsonb_array_elements(v_event.entries) entry
							where entry ->> 'physicalId' = v_physical::text;
						end if;
					end if;
					-- Unknown ('unavailable') changes nothing.
					v_running := case
						when v_entry is null then false
						when v_entry ->> 'state' in ('running', 'starting', 'stopping') then true
						when v_entry ->> 'state' in ('suspended', 'failed') then false
					end;
					if v_running is false and v_subject.paused_at is null then
						v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_event.event_at);
						update public.qorpera_computer_hour_subjects
						set counted_until = greatest(counted_until, v_event.event_at),
							paused_at = v_event.event_at, pause_reason = 'observed_stopped'
						where subject_id = v_subject.subject_id;
					elsif v_running is true and v_subject.paused_at is not null then
						update public.qorpera_computer_hour_subjects
						set counted_until = greatest(counted_until, v_event.event_at), paused_at = null, pause_reason = null
						where subject_id = v_subject.subject_id;
					end if;
				end loop;
				v_last := greatest(v_last, v_event.event_at);
				update public.qorpera_computer_hour_nodes
				set cursor_observed_at = v_event.observed_at, cursor_observation_id = v_event.observation_id,
					last_inventory_at = v_last
				where node_id = v_node_id;
			end if;
		end loop;
		-- Silent until now: machines stop counting five minutes after the last report.
		if v_last + interval '5 minutes' < v_until then
			for v_subject in
				select * from public.qorpera_computer_hour_subjects
				where node_id = v_node_id and ended_at is null and paused_at is null
				order by subject_id
				for update
			loop
				v_end := greatest(v_subject.counted_until, v_last + interval '5 minutes');
				v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_end);
				update public.qorpera_computer_hour_subjects
				set counted_until = v_end, paused_at = v_end, pause_reason = 'node_silent'
				where subject_id = v_subject.subject_id;
			end loop;
		end if;
	end loop;

	-- 3. Count what is still awake up to now (a run no further than its assignment's expiry), and
	-- drop what has ended: its time was counted at its end.
	for v_subject in select * from public.qorpera_computer_hour_subjects order by subject_id for update loop
		if v_subject.ended_at is not null then
			delete from public.qorpera_computer_hour_subjects where subject_id = v_subject.subject_id;
			continue;
		end if;
		v_end := v_until;
		if v_subject.subject_kind = 'run' then
			v_status := null;
			select assignment.expires_at, assignment.status into v_expires, v_status
			from public.qorpera_runner_assignments assignment where assignment.id = v_subject.subject_id;
			if v_status is null then
				-- The assignment is gone: nothing more can be known about the run.
				delete from public.qorpera_computer_hour_subjects where subject_id = v_subject.subject_id;
				continue;
			end if;
			-- An assignment that has just ended counts on the next pass, from its end record.
			v_end := case when v_status = 'accepted' then least(v_end, v_expires) else v_subject.counted_until end;
		end if;
		if v_subject.paused_at is null and v_end > v_subject.counted_until then
			v_totals := public.qorpera_computer_hour_add(v_totals, v_subject, v_subject.counted_until, v_end);
			update public.qorpera_computer_hour_subjects set counted_until = v_end where subject_id = v_subject.subject_id;
		end if;
	end loop;

	-- 4. One usage row per company: exact seconds per kind, and what the pass adds once the
	-- company's running total is rounded up to whole seconds.
	for v_company in select key from jsonb_each(v_totals) order by key loop
		v_exact := coalesce((v_totals -> v_company ->> 'company_machine')::numeric, 0)
			+ coalesce((v_totals -> v_company ->> 'agent_machine')::numeric, 0)
			+ coalesce((v_totals -> v_company ->> 'coding_machine')::numeric, 0)
			+ coalesce((v_totals -> v_company ->> 'run')::numeric, 0);
		if v_exact <= 0 then
			continue;
		end if;
		v_old := null;
		select * into v_old from public.qorpera_computer_hour_totals where profile_id = v_company::uuid for update;
		v_charged := ceil(coalesce(v_old.exact_standard_seconds, 0) + v_exact)::bigint;
		insert into public.qorpera_computer_hour_totals as total (profile_id, exact_standard_seconds, charged_standard_seconds)
		values (v_company::uuid, coalesce(v_old.exact_standard_seconds, 0) + v_exact, v_charged)
		on conflict (profile_id) do update set
			exact_standard_seconds = excluded.exact_standard_seconds,
			charged_standard_seconds = excluded.charged_standard_seconds;
		insert into public.qorpera_computer_hour_usage (
			profile_id, metered_at, company_machine_seconds, agent_machine_seconds, coding_machine_seconds, run_seconds,
			standard_seconds
		)
		values (
			v_company::uuid, v_until,
			coalesce((v_totals -> v_company ->> 'company_machine')::numeric, 0),
			coalesce((v_totals -> v_company ->> 'agent_machine')::numeric, 0),
			coalesce((v_totals -> v_company ->> 'coding_machine')::numeric, 0),
			coalesce((v_totals -> v_company ->> 'run')::numeric, 0),
			v_charged - coalesce(v_old.charged_standard_seconds, 0)
		);
		v_profiles := v_profiles + 1;
	end loop;

	update public.qorpera_computer_hour_meter set metered_until = v_until;
	return jsonb_build_object('schema', 'qorpera.computer-hour-meter/v1', 'state', 'metered',
		'meteredUntil', v_until, 'companies', v_profiles,
		'subjects', (select count(*) from public.qorpera_computer_hour_subjects));
end
$$;
revoke all on function public.qorpera_meter_computer_hours_at(timestamptz) from public, anon, authenticated, service_role;

-- The pass pg_cron runs once a minute (as the owner). service_role may run it by hand; nobody can
-- choose its time.
create function public.qorpera_meter_computer_hours()
returns jsonb
language sql
security definer
set search_path = ''
as $$
	select public.qorpera_meter_computer_hours_at(clock_timestamp())
$$;
revoke all on function public.qorpera_meter_computer_hours() from public, anon, authenticated;
grant execute on function public.qorpera_meter_computer_hours() to service_role;

-- What a company used in one calendar month (Danish time). Any member may read it.
create function public.qorpera_read_company_computer_hours(p_profile_id uuid, p_month date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_month date;
	v_from timestamptz;
	v_to timestamptz;
	v_sum record;
	v_awake record;
begin
	if auth.uid() is null or p_profile_id is null or not exists (
		select 1 from public.qorpera_profile_members member
		where member.profile_id = p_profile_id and member.user_id = auth.uid()
	) then
		raise exception 'Company computer hours are not available' using errcode = '42501';
	end if;
	v_month := date_trunc('month', coalesce(p_month, (clock_timestamp() at time zone 'Europe/Copenhagen')::date))::date;
	v_from := v_month::timestamp at time zone 'Europe/Copenhagen';
	v_to := (v_month + interval '1 month')::timestamp at time zone 'Europe/Copenhagen';
	select coalesce(sum(usage.standard_seconds), 0) as used,
		coalesce(sum(usage.company_machine_seconds), 0) as company_machines,
		coalesce(sum(usage.agent_machine_seconds), 0) as agent_machines,
		coalesce(sum(usage.coding_machine_seconds), 0) as coding_machines,
		coalesce(sum(usage.run_seconds), 0) as runs
	into v_sum
	from public.qorpera_computer_hour_usage usage
	where usage.profile_id = p_profile_id and usage.metered_at >= v_from and usage.metered_at < v_to;
	select count(*) filter (where subject.subject_kind = 'company_machine') as company_machines,
		count(*) filter (where subject.subject_kind = 'agent_machine') as agent_machines,
		count(*) filter (where subject.subject_kind = 'coding_machine') as coding_machines,
		count(*) filter (where subject.subject_kind = 'run') as runs
	into v_awake
	from public.qorpera_computer_hour_subjects subject
	where subject.profile_id = p_profile_id and subject.ended_at is null and subject.paused_at is null;
	return jsonb_build_object(
		'schema', 'qorpera.company-computer-hours/v1',
		'profileId', p_profile_id,
		'month', to_char(v_month, 'YYYY-MM'),
		'timeZone', 'Europe/Copenhagen',
		'usedStandardSeconds', v_sum.used,
		'byKind', jsonb_build_object(
			'companyMachines', round(v_sum.company_machines)::bigint,
			'agentMachines', round(v_sum.agent_machines)::bigint,
			'codingMachines', round(v_sum.coding_machines)::bigint,
			'runs', round(v_sum.runs)::bigint
		),
		'awakeNow', jsonb_build_object(
			'companyMachines', v_awake.company_machines,
			'agentMachines', v_awake.agent_machines,
			'codingMachines', v_awake.coding_machines,
			'runs', v_awake.runs
		),
		'meteredUntil', (select meter.metered_until from public.qorpera_computer_hour_meter meter)
	);
end
$$;
revoke all on function public.qorpera_read_company_computer_hours(uuid, date) from public, anon;
grant execute on function public.qorpera_read_company_computer_hours(uuid, date) to authenticated;

-- Start counting now. Node read positions first, before anything locks a hot table.
do $$
begin
	perform public.qorpera_computer_hour_track_node(node.id, clock_timestamp()) from public.qorpera_runtime_nodes node;
end
$$;
insert into public.qorpera_computer_hour_meter (id, metered_until) values (true, clock_timestamp());

-- The triggers lock their tables until the migration commits; the backfill right after them sees
-- a state no transition can change meanwhile. What is awake now is logged awake from this moment.
set local lock_timeout = '10s';
create trigger qorpera_computer_hour_log_demand
	after insert or update of reserved_at, suspended_at, released_at, cpu_millis, memory_bytes
	on public.qorpera_runtime_node_demands
	for each row execute function public.qorpera_computer_hour_log_demand();
do $$
begin
	perform public.qorpera_computer_hour_record(allocation.profile_id,
		case demand.provider_kind when 'office' then 'company_machine' when 'coding' then 'coding_machine' else 'agent_machine' end,
		demand.allocation_id, demand.node_id, 'awake',
		public.qorpera_computer_hour_size_factor(demand.cpu_millis, demand.memory_bytes), null)
	from public.qorpera_runtime_node_demands demand
	join public.qorpera_runtime_machine_allocations allocation on allocation.id = demand.allocation_id
	where demand.provider_kind in ('office', 'coding', 'machine')
		and demand.reserved_at is not null and demand.suspended_at is null and demand.released_at is null;
end
$$;
create trigger qorpera_computer_hour_log_assignment
	after insert or update of status, accepted_at, finished_at
	on public.qorpera_runner_assignments
	for each row execute function public.qorpera_computer_hour_log_assignment();
do $$
begin
	perform public.qorpera_computer_hour_record(run.profile_id, 'run', assignment.id, null, 'awake', 1, null)
	from public.qorpera_runner_assignments assignment
	join public.qorpera_execution_runs run on run.id = assignment.run_id
	where assignment.status = 'accepted';
end
$$;
