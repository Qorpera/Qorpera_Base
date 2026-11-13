-- 20260930757000 (agent-box, slice 5 "an agent's home is kept", 13 Nov 2026): a sleeping machine keeps its disk unless
-- its server is really short of disk, and never loses it silently.
--
-- Read on production 13 Nov: node 2's executor gave away 25 sleeping machines' disks in 7 days (9 on the 13th), across
-- three companies, one after 2.6 hours asleep, and nothing told the agent. The trigger was a number on paper: the
-- executor's disk budget (qorpera_machine_executors.disk_bytes) counts every placement's whole disk, asleep too, so
-- 15 machines of 40 GiB filled 600 GiB while the pool (1.45 TiB) held 539.5 GiB in all and those 15 disks 1.07 GiB of
-- their own (LXD's own figures, read on node 2 at 17:50Z).
--
-- * The executor reports its LXD pool's real use (qorpera_report_executor_disk, at most every 30 s): the pool's total and
--   used bytes, and what each of its machines' disks holds of its own. A report counts for 2 minutes.
-- * The room for a new disk (qorpera_machine_executor_disk_room, used by every placement check: the executor's pass, the
--   candidates, the placement itself) is, with a fresh report: the pool's real free space less a reserve of a fifth of
--   the pool (for what shares it and whose growth the executor cannot see: db-standby, the exec and code hosts, the test
--   machine, the images; ZFS also stays under 80 % full) and less what the awake machines here could still grow into
--   (each one's disk size less what it already holds; a new one counts whole). A sleeping machine cannot grow: it counts
--   only what it holds, which the pool's used figure has. Without a fresh report it is the paper budget, as before.
-- * A sleeping disk is given away only for a machine in line that fits nowhere and that giving away sleeping disks here
--   makes fit. On real figures a disk frees what it really holds (nothing when that is not known: such a disk is never
--   given away for room), on paper its whole size as before; when all of them together would not make the room, none
--   goes and the machine waits in line. A disk deleted after the report, or less than 30 s before it (ZFS frees a
--   deleted disk's space in the background), still counts as coming free, so one shortage never takes a second disk. Which goes: never one used in the last 24 hours while an older one can go (one skipped
--   because its company was busy holds the newer ones back for this pass); then the asking company's own before
--   another's; then the longest asleep; only as many as needed. The placement keeps what its give-away was counted to
--   free (disk_frees_bytes), since a report after the deletion no longer names the disk.
-- * Nothing is lost silently: the machine's row keeps when its disk was freed (disk_freed_at: a give-away, or a wake
--   that had to move it to a new disk after it slept on the old one), and its view says so in plain words (`diskFreed`)
--   while it has no disk and on its first new disk until it sleeps or is woken again; machine_start, status and list
--   carry the view. The agent's own free machine taken again (20260930747000) is first one that still holds its disk,
--   and `reused` says when the one given starts empty.
-- Every new or patched body names this migration (20260930757000), for the deploy guards.
set local lock_timeout = '3s';

do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_admit_executor_machines(text,text,integer)'::regprocedure),
		'20260930757000') > 0 then
		raise exception '20260930757000 is already applied'; end if;
end $$;

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.disk_kept_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930757000' in v_definition) > 0 then
		raise exception '20260930757000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930757000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930757000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. What the rows keep ---------------------------------------------------------------------------------------------------

alter table public.qorpera_company_machines add column disk_freed_at timestamptz;
comment on column public.qorpera_company_machines.disk_freed_at is
	'20260930757000: when this machine last lost its disk after it slept on it: given to a machine in line, or moved to a new disk at a wake.';

alter table public.qorpera_company_machine_placements add column disk_frees_bytes bigint
	check (disk_frees_bytes is null or disk_frees_bytes >= 0);
comment on column public.qorpera_company_machine_placements.disk_frees_bytes is
	'20260930757000: what giving this sleeping disk away was counted to free (its own use on the report, or its whole size on paper); counted as coming free until a report shows it freed.';

-- The executor's latest reading of its LXD storage pool: one row per executor, replaced by each report.
create table public.qorpera_machine_executor_disks (
	owner text primary key references public.qorpera_machine_executors(owner) on delete cascade,
	pool text not null check (pool ~ '^[a-z][a-z0-9-]{0,62}$'),
	total_bytes bigint not null check (total_bytes > 0),
	used_bytes bigint not null check (used_bytes >= 0 and used_bytes <= total_bytes),
	-- Each placement's disk, by placement id: what it holds of its own (what deleting it frees).
	placement_used jsonb not null check (jsonb_typeof(placement_used) = 'object' and pg_column_size(placement_used) <= 131072),
	reported_at timestamptz not null default clock_timestamp()
);
comment on table public.qorpera_machine_executor_disks is
	'20260930757000: the executor''s latest reading of its LXD storage pool (qorpera_report_executor_disk); fresh for 2 minutes.';
alter table public.qorpera_machine_executor_disks enable row level security;
revoke all on public.qorpera_machine_executor_disks from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The report and the room -------------------------------------------------------------------------------------------

-- The executor's reading of its pool, as LXD gave it: {schema, pool, totalBytes, usedBytes, placements: {placementId:
-- bytes}}. The pool is the executor's own (its policy's storagePool). Recorded whole, or refused (22023) whole.
create function public.qorpera_report_executor_disk(p_owner text, p_machine_id_sha256 text, p_report jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_executor public.qorpera_machine_executors%rowtype;
begin
	-- 20260930757000
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Machine custody required' using errcode = '42501'; end if;
	select * into v_executor from public.qorpera_machine_executors where owner = p_owner and machine_id_sha256 = p_machine_id_sha256;
	if v_executor.owner is null then raise exception 'Machine custody required' using errcode = '42501'; end if;
	if jsonb_typeof(p_report) is distinct from 'object' then
		raise exception 'Machine executor disk report invalid' using errcode = '22023'; end if;
	if (select array_agg(k order by k) from jsonb_object_keys(p_report) k)
			is distinct from array['placements','pool','schema','totalBytes','usedBytes']
		or p_report ->> 'schema' is distinct from 'qorpera.machine-executor-disk/v1'
		or p_report ->> 'pool' is distinct from v_executor.policy ->> 'storagePool'
		or jsonb_typeof(p_report -> 'totalBytes') is distinct from 'number'
		or jsonb_typeof(p_report -> 'usedBytes') is distinct from 'number'
		or jsonb_typeof(p_report -> 'placements') is distinct from 'object' then
		raise exception 'Machine executor disk report invalid' using errcode = '22023'; end if;
	if (p_report ->> 'totalBytes') !~ '^[0-9]{1,16}$' or (p_report ->> 'usedBytes') !~ '^[0-9]{1,16}$'
		or (p_report ->> 'totalBytes')::numeric not between 1 and 9007199254740991
		or (p_report ->> 'usedBytes')::numeric > (p_report ->> 'totalBytes')::numeric
		or (select count(*) from jsonb_object_keys(p_report -> 'placements')) > 1024
		or exists (select 1 from jsonb_each(p_report -> 'placements') entry
			where entry.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				or case when jsonb_typeof(entry.value) = 'number' and entry.value::text ~ '^[0-9]{1,16}$'
					then entry.value::text::numeric > (p_report ->> 'totalBytes')::numeric else true end) then
		raise exception 'Machine executor disk report invalid' using errcode = '22023'; end if;
	insert into public.qorpera_machine_executor_disks(owner, pool, total_bytes, used_bytes, placement_used, reported_at)
	values (p_owner, p_report ->> 'pool', (p_report ->> 'totalBytes')::bigint, (p_report ->> 'usedBytes')::bigint,
		p_report -> 'placements', clock_timestamp())
	on conflict (owner) do update set pool = excluded.pool, total_bytes = excluded.total_bytes, used_bytes = excluded.used_bytes,
		placement_used = excluded.placement_used, reported_at = excluded.reported_at;
	return jsonb_build_object('state', 'recorded', 'roomBytes', public.qorpera_machine_executor_disk_room(p_owner));
end $$;

-- The executor's report if it is fresh: read less than 2 minutes before this transaction began, of its pool now. Else
-- none, and the paper budget decides.
create function public.qorpera_machine_executor_disk_report(p_owner text) returns public.qorpera_machine_executor_disks
language sql stable security definer set search_path = '' as $$
	-- 20260930757000
	select disk from public.qorpera_machine_executor_disks disk
	join public.qorpera_machine_executors executor on executor.owner = disk.owner
	where disk.owner = p_owner and disk.reported_at > now() - interval '2 minutes'
		and disk.pool = executor.policy ->> 'storagePool'
$$;

-- What giving up a placement's disk frees: on real figures (p_report) what it holds of its own, nothing when unknown;
-- on paper its whole size.
create function public.qorpera_machine_executor_disk_frees(p_report public.qorpera_machine_executor_disks, p_placement_id uuid,
	p_disk_bytes bigint) returns bigint
language sql stable security definer set search_path = '' as $$
	-- 20260930757000
	select case when p_report.owner is null then p_disk_bytes
		else coalesce((p_report.placement_used ->> p_placement_id::text)::bigint, 0) end
$$;

-- The disk a new machine may take on this executor now (one may be placed when its whole disk is at most this). On a
-- fresh report: the pool's real free space, less a fifth of the pool, less what each awake placement here (not asleep;
-- p_except_placement_id, one being replaced, aside) could still grow into: its disk size less what it holds (all of it
-- when unknown, as a new one). Without one: the paper budget less every placement's whole disk, as before.
create function public.qorpera_machine_executor_disk_room(p_owner text, p_except_placement_id uuid default null) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare v_report public.qorpera_machine_executor_disks := public.qorpera_machine_executor_disk_report(p_owner);
	v_budget bigint; v_growth bigint;
begin
	-- 20260930757000
	if v_report.owner is null then
		select disk_bytes into v_budget from public.qorpera_machine_executors where owner = p_owner;
		return v_budget - public.qorpera_machine_executor_disk_used(p_owner, p_except_placement_id);
	end if;
	select coalesce(sum(greatest(machine.disk_bytes - coalesce((v_report.placement_used ->> placement.id::text)::bigint, 0), 0)), 0)
		into v_growth
	from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where placement.owner = p_owner and placement.retired_at is null and placement.removed_at is null
		and placement.id is distinct from p_except_placement_id
		and not exists (select 1 from public.qorpera_runtime_node_demands demand where demand.allocation_id = placement.id
			and demand.suspended_at is not null and demand.released_at is null);
	return v_report.total_bytes - v_report.used_bytes - v_report.total_bytes / 5 - v_growth;
end $$;

-- What a machine whose disk was freed tells whoever looks at it, while that matters: it has no disk now (asleep without
-- one, or in line for a new one), or it is on its first new disk (made after the freeing, for the wake asked before it)
-- and has not slept on it since. Else null.
create function public.qorpera_company_machine_disk_freed(p_machine public.qorpera_company_machines) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype := public.qorpera_company_machine_placement(p_machine.id);
begin
	-- 20260930757000
	if p_machine.disk_freed_at is null or p_machine.removed_at is not null or p_machine.desired_state = 'deleted' then
		return null; end if;
	if v_placement.id is not null and (v_placement.created_at < p_machine.disk_freed_at
		or p_machine.wanted_at > v_placement.created_at
		or exists (select 1 from public.qorpera_runtime_node_demands demand where demand.allocation_id = v_placement.id
			and demand.suspended_at is not null)) then
		return null; end if;
	return format('its disk was freed while it slept (%s UTC): it comes back with an empty disk, so what was on it before is gone; '
		'the company''s files are kept', to_char(p_machine.disk_freed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'));
end $$;

-- 3. Placement decides on the room ---------------------------------------------------------------------------------------

do $$ begin execute pg_temp.disk_kept_patched(
	'public.qorpera_admit_executor_machines(text,text,integer)'::regprocedure,
	array[$old$	v_shape record; v_room record; v_disk bigint; v_freeing bigint; v_asleep_disk bigint; v_need bigint; v_asleep record;$old$,
	$new$	v_shape record; v_room record; v_disk bigint; v_freeing bigint; v_asleep_disk bigint; v_need bigint; v_asleep record;
	v_report public.qorpera_machine_executor_disks; v_skipped boolean := false; -- 20260930757000$new$,
	$old$	v_disk := v_executor.disk_bytes - public.qorpera_machine_executor_disk_used(p_owner);$old$,
	$new$	-- 20260930757000: the room for a new disk, on the pool's real figures the executor reported (its free space less a
	-- fifth of the pool and what its awake machines could still grow into), or on paper without a fresh report.
	v_report := public.qorpera_machine_executor_disk_report(p_owner);
	v_disk := public.qorpera_machine_executor_disk_room(p_owner);$new$,
	$old$		select coalesce(sum(machine.disk_bytes), 0) into v_freeing from public.qorpera_company_machine_placements placement
		join public.qorpera_company_machines machine on machine.id = placement.machine_id
		where placement.owner = p_owner and placement.retired_at is not null and placement.removed_at is null;$old$,
	$new$		-- 20260930757000: on real figures a disk frees what it holds of its own, and one deleted after the report, or less
		-- than 30 s before it (ZFS frees a deleted disk's space in the background, so LXD's figures show it late), still
		-- counts as coming free, so one shortage never takes a second disk.
		-- A disk given away is counted as what its give-away counted (a report after its deletion no longer names it).
		select coalesce(sum(case when v_report.owner is null then machine.disk_bytes else coalesce(placement.disk_frees_bytes,
				public.qorpera_machine_executor_disk_frees(v_report, placement.id, machine.disk_bytes)) end), 0) into v_freeing
		from public.qorpera_company_machine_placements placement
		join public.qorpera_company_machines machine on machine.id = placement.machine_id
		where placement.owner = p_owner and placement.retired_at is not null
			and (placement.removed_at is null
				or (v_report.owner is not null and placement.removed_at > v_report.reported_at - interval '30 seconds'));$new$,
	$old$		select coalesce(sum(machine.disk_bytes), 0) into v_asleep_disk from public.qorpera_company_machine_placements placement$old$,
	$new$		select coalesce(sum(public.qorpera_machine_executor_disk_frees(v_report, placement.id, machine.disk_bytes)), 0)
			into v_asleep_disk from public.qorpera_company_machine_placements placement$new$,
	$old$			for v_asleep in select placement.id, placement.profile_id, machine.id as machine_id, machine.disk_bytes$old$,
	$new$			for v_asleep in select placement.id, placement.profile_id, machine.id as machine_id, machine.disk_bytes,
				public.qorpera_machine_executor_disk_frees(v_report, placement.id, machine.disk_bytes) as frees,
				machine.last_used_at > clock_timestamp() - interval '24 hours' as recent$new$,
	$old$				order by demand.suspended_at, placement.id loop
				exit when v_need <= 0;$old$,
	$new$				-- 20260930757000: never one used in the last 24 hours while an older one can go (one passed over because its
				-- company was busy holds the newer ones back this pass); then the asking company's own before another's; then
				-- the longest asleep. One that frees nothing (its use unknown) is not given up for room.
				order by machine.last_used_at > clock_timestamp() - interval '24 hours',
					placement.profile_id is distinct from v_machine.profile_id, demand.suspended_at, placement.id loop
				exit when v_need <= 0;
				exit when v_skipped and v_asleep.recent;
				continue when v_asleep.frees <= 0;$new$,
	$old$					update public.qorpera_company_machine_placements set retired_at = clock_timestamp()
					where id = v_asleep.id and retired_at is null and removed_at is null;
					if found then v_need := v_need - v_asleep.disk_bytes; end if;
				exception when lock_not_available or sqlstate 'P0F04' then continue;$old$,
	$new$					update public.qorpera_company_machine_placements set retired_at = clock_timestamp(),
						disk_frees_bytes = v_asleep.frees -- 20260930757000
					where id = v_asleep.id and retired_at is null and removed_at is null;
					if found then
						v_need := v_need - v_asleep.frees;
						-- 20260930757000: the machine keeps when its disk was freed; its view tells whoever wakes it.
						update public.qorpera_company_machines set disk_freed_at = clock_timestamp() where id = v_asleep.machine_id;
					end if;
				exception when lock_not_available or sqlstate 'P0F04' then v_skipped := true; continue;$new$]); end $$;

do $$ begin execute pg_temp.disk_kept_patched(
	'public.qorpera_company_machine_candidates(bigint,bigint,bigint,text,uuid)'::regprocedure,
	array[$old$		and public.qorpera_machine_executor_disk_used(executor.owner, p_replacing_placement_id) + p_disk_bytes <= executor.disk_bytes$old$,
	$new$		-- 20260930757000: the room on the pool's real figures, or on paper without a fresh report.
		and p_disk_bytes <= public.qorpera_machine_executor_disk_room(executor.owner, p_replacing_placement_id)$new$]); end $$;

do $$ begin execute pg_temp.disk_kept_patched(
	'public.qorpera_place_company_machine(uuid,text,uuid)'::regprocedure,
	array[$old$	if public.qorpera_machine_executor_disk_used(v_executor.owner, p_replacing_placement_id) + v_machine.disk_bytes > v_executor.disk_bytes then$old$,
	$new$	-- 20260930757000: the room on the pool's real figures, or on paper without a fresh report.
	if v_machine.disk_bytes > coalesce(public.qorpera_machine_executor_disk_room(v_executor.owner, p_replacing_placement_id), -1) then$new$]);
end $$;

-- A wake that moves a machine to a new disk after it slept on the old one: it is told too.
do $$ begin execute pg_temp.disk_kept_patched(
	'public.qorpera_admit_company_machine(uuid,text)'::regprocedure,
	array[$old$				update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = v_placement.id;$old$,
	$new$				update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = v_placement.id;
				-- 20260930757000: a machine that slept on that disk comes back on a new one, and is told (its view).
				update public.qorpera_company_machines set disk_freed_at = clock_timestamp()
				where id = v_machine.id and exists (select 1 from public.qorpera_runtime_node_demands demand
					where demand.allocation_id = v_placement.id and demand.suspended_at is not null);$new$]); end $$;

-- 4. Nothing lost silently -----------------------------------------------------------------------------------------------

do $$ begin execute pg_temp.disk_kept_patched(
	'public.qorpera_company_machine_view(public.qorpera_company_machines)'::regprocedure,
	array[$old$		'lastError', p_machine.last_error, 'createdAt', p_machine.created_at, 'updatedAt', p_machine.updated_at);$old$,
	$new$		'lastError', p_machine.last_error, 'createdAt', p_machine.created_at, 'updatedAt', p_machine.updated_at,
		-- 20260930757000: that it comes back with an empty disk, while that matters.
		'diskFreed', public.qorpera_company_machine_disk_freed(p_machine));$new$]); end $$;

do $$ begin execute pg_temp.disk_kept_patched(
	'public.qorpera_company_machine_reusable(jsonb,uuid,jsonb)'::regprocedure,
	array[$old$		order by machine.name = p_args ->> 'name' desc, public.qorpera_company_machine_state(machine) = 'running' desc,$old$,
	$new$		-- 20260930757000: one that still holds its disk before one whose disk was freed (it would start empty).
		order by (public.qorpera_company_machine_placement(machine.id)).id is not null desc, machine.name = p_args ->> 'name' desc,
			public.qorpera_company_machine_state(machine) = 'running' desc,$new$]); end $$;

do $$ begin execute pg_temp.disk_kept_patched(
	'public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	array[$old$			'your own free machine %s of this size was given to you again instead of a new one: use the name %s', v_machine.name,
			v_machine.name)) else '{}'::jsonb end;$old$,
	$new$			'your own free machine %s of this size was given to you again instead of a new one: use the name %s', v_machine.name,
			v_machine.name)
			-- 20260930757000: one whose disk was freed while it slept is said to start empty.
			|| case when public.qorpera_company_machine_disk_freed(v_machine) is not null
				then '. Its disk was freed while it slept, so it starts with an empty disk: what you left on it is gone' else '' end)
			else '{}'::jsonb end;$new$]); end $$;

-- 5. Grants ----------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_report_executor_disk(text, text, jsonb),
	public.qorpera_machine_executor_disk_report(text),
	public.qorpera_machine_executor_disk_frees(public.qorpera_machine_executor_disks, uuid, bigint),
	public.qorpera_machine_executor_disk_room(text, uuid),
	public.qorpera_company_machine_disk_freed(public.qorpera_company_machines)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_report_executor_disk(text, text, jsonb) to service_role;
