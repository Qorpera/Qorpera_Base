-- 20260930714000: a member turns an agent's desktop computer's screen on (Jonas, 11 November 2026: "I would want the
-- computer to start despite the agent being awake or driving a desktop. when it woke, it's desktop would simply already
-- be on"). The window's "Wake it" wakes the MACHINE; its desktop (the image's `desktop start`) started only when the agent
-- used machine_screen, so a member could never get a picture on their own. One member action now ends with the desktop
-- running, whatever the agent does: no run of the agent's, no hold, and never refused for an agent's run or a busy
-- desktop. It builds on 20260930713000 (take-over).
-- * qorpera_member_machine_desktop_start_begin(profile, machine) (authenticated; the node's executor makes it with the
--   member's own token, as a member's action): under the machine's lock, an owner, admin or contributor of the company
--   (as qorpera_member_manage_company_machine 'start'); the machine the company's, not removed, wanted running on its
--   placement with a known boot (else MACHINE_NOT_RUNNING), and big enough for a desktop (2 processors and 4 GiB, else
--   DESKTOP_MACHINE_TOO_SMALL). Then exactly what an agent's first use of the screen gets from
--   qorpera_authorize_machine_screen, with the agent the machine was started by: a disk that has had a company folder
--   view needs that agent and this member to read the folder's root (else MACHINE_NEEDS_COMPANY_VIEW); without that read,
--   a disk that never had a view is marked (folder_unchecked_at), as by an action, since starting the desktop runs
--   programs on it; the machine's last use moves (at most every 30 seconds); and the screen is stamped as that agent's
--   (screen_staff_agent_id, screen_used_at), so every rule about a machine with a screen holds as it is. A desktop a
--   member holds (a live lease of 20260930713000, theirs or another member's) is running: the start is answered `held`
--   and records, marks and runs nothing. Otherwise starts of one machine are at least 5 seconds apart (else
--   DESKTOP_START_TOO_SOON). It records the start (id, member, machine, time) and answers its single-use id.
-- * qorpera_member_machine_desktop_start_authority(start, owner, provider), the executor's read (service_role): the
--   start begun in the last 15 seconds and not served, its member still an owner, admin or contributor of a company not
--   being deleted; everything the begin checked again, live under the machine's lock (a hold that began since answers
--   `held`); served by the machine's own executor only, once. The host then runs the image's own `desktop start`.
-- * The machine's idle rule under a member (the brief's point 5): a member's look never moved the machine's last use,
--   so a task machine whose only use was a member watching its desktop slept after its quiet window
--   (qorpera_machine_executors.sleep_after_seconds, an hour by default) under the member; and a hold's heartbeat moved
--   it neither. Now the executor's read of a look the member confirmed in the last 30 minutes (keepDesktop: the watch
--   that also keeps the desktop on) and a hold's renewed heartbeat move the last use, at most every 30 seconds, as an
--   agent's screen read does. Nothing else of the idle rule changes.
-- Every new or patched body names this migration (20260930714000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_machine_desktop_start_begin(uuid,uuid)') is not null then
		raise exception '20260930714000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_desktop_act_authority(uuid,text,text)') is null then
		raise exception '20260930714000 needs take-over (20260930713000)'; end if;
end $$;

set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_member_start_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930714000' in v_definition) > 0 then
		raise exception '20260930714000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930714000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930714000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The record of a start --------------------------------------------------------------------------------------------------

-- One row per start a member began: who, which machine, when, and when its executor served it. Nothing else. A machine's
-- rows older than an hour go at its next begin (the floor and the authority look back 15 seconds at most).
create table public.qorpera_company_machine_desktop_starts (
	id uuid primary key,
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	user_id uuid not null,
	begun_at timestamptz not null,
	served_at timestamptz
);
create index qorpera_company_machine_desktop_starts_machine
	on public.qorpera_company_machine_desktop_starts (machine_id, begun_at desc);
alter table public.qorpera_company_machine_desktop_starts enable row level security;
revoke all on public.qorpera_company_machine_desktop_starts from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The begin, as the member -----------------------------------------------------------------------------------------------

create function public.qorpera_member_machine_desktop_start_begin(p_profile_id uuid, p_machine_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_reads_root boolean;
	v_start uuid := pg_catalog.gen_random_uuid();
	v_now timestamptz;
begin
	-- 20260930714000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	-- Owners, admins and contributors, as for waking the machine.
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- Locked as a member's look or action locks it: a view's open (FOR SHARE) waits for it, so the disk's rule below stands
	-- until this commits; a second start of the machine counts after this one.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	v_now := clock_timestamp();
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	-- deploy/machine/desktop: MIN_CPUS 2, MIN_MEMORY_KB 4 GiB (as a take-over's check).
	if v_machine.cpus < 2 or v_machine.memory_bytes < 4294967296 then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'refused',
			'reason', 'DESKTOP_MACHINE_TOO_SMALL'); end if;
	-- The disk's rule, as for an agent's first screen use: the agent the machine was started by, and this member.
	v_reads_root := public.qorpera_folder_reads_root(v_machine.environment_id, v_machine.profile_id,
		v_machine.started_by_staff_agent_id, v_user);
	if not v_reads_root and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	-- A member holds the desktop (take-over): it runs. Nothing is recorded, marked or run.
	if coalesce(v_machine.desktop_member_until > v_now, false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'held'); end if;
	-- A floor between starts of one machine: a button cannot hammer a node.
	if exists (select 1 from public.qorpera_company_machine_desktop_starts as start
		where start.machine_id = v_machine.id and start.begun_at > v_now - interval '5 seconds') then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'refused',
			'reason', 'DESKTOP_START_TOO_SOON'); end if;
	-- What an agent's first screen use marks (qorpera_authorize_machine_screen, as an action: the desktop runs programs).
	if not v_reads_root then
		update public.qorpera_company_machine_placements set folder_unchecked_at = v_now
		where id = v_placement.id and folder_unchecked_at is null
			and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
	end if;
	update public.qorpera_company_machines set last_used_at = v_now
	where id = v_machine.id and last_used_at < v_now - interval '30 seconds';
	update public.qorpera_company_machines set screen_staff_agent_id = v_machine.started_by_staff_agent_id,
		screen_used_at = v_now
	where id = v_machine.id and (screen_staff_agent_id is distinct from v_machine.started_by_staff_agent_id
		or screen_used_at is null or screen_used_at < v_now - interval '30 seconds');
	delete from public.qorpera_company_machine_desktop_starts as start
	where start.machine_id = v_machine.id and start.begun_at < v_now - interval '1 hour';
	insert into public.qorpera_company_machine_desktop_starts(id, machine_id, user_id, begun_at)
	values (v_start, v_machine.id, v_user, v_now);
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'ok', 'startId', v_start);
end
$$;
revoke all on function public.qorpera_member_machine_desktop_start_begin(uuid, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_start_begin(uuid, uuid) to authenticated;

-- 3. The executor's read ----------------------------------------------------------------------------------------------------

create function public.qorpera_member_machine_desktop_start_authority(p_start_id uuid, p_owner text, p_provider_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_start public.qorpera_company_machine_desktop_starts%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_reads_root boolean;
	v_served boolean;
begin
	-- 20260930714000
	if auth.role() is distinct from 'service_role' or p_start_id is null
		or coalesce(p_owner !~ '^[A-Za-z0-9_.:-]{1,120}$', true) or coalesce(p_provider_id !~ '^[a-z][a-z0-9_-]{0,63}$', true) then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	select start.* into v_start from public.qorpera_company_machine_desktop_starts as start where start.id = p_start_id;
	if not found then
		raise exception 'Machine desktop start is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = v_start.machine_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop start is unavailable' using errcode = '42501'; end if;
	-- Read again under the machine's lock: a second executor's read of the same start takes the lock first.
	select start.* into v_start from public.qorpera_company_machine_desktop_starts as start where start.id = p_start_id;
	if not found or v_start.served_at is not null or v_start.begun_at < clock_timestamp() - interval '15 seconds'
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_machine.profile_id and member.user_id = v_start.user_id
				and member.role::text in ('owner', 'admin', 'contributor'))
		or public.qorpera_company_deleting(v_machine.profile_id) then
		raise exception 'Machine desktop start is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	if v_machine.cpus < 2 or v_machine.memory_bytes < 4294967296 then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_MACHINE_TOO_SMALL'); end if;
	v_reads_root := public.qorpera_folder_reads_root(v_machine.environment_id, v_machine.profile_id,
		v_machine.started_by_staff_agent_id, v_start.user_id);
	if not v_reads_root and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	-- The start runs: the disk's mark is decided again here, under this lock, as an action's read decides it (a root
	-- read taken away since the begin). A hold that began since the begin: the desktop runs; nothing is run.
	if not coalesce(v_machine.desktop_member_until > clock_timestamp(), false) and not v_reads_root then
		update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp()
		where id = v_placement.id and folder_unchecked_at is null
			and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
	end if;
	v_served := v_placement.owner = p_owner and v_placement.binding ->> 'providerId' = p_provider_id;
	if v_served then
		update public.qorpera_company_machine_desktop_starts set served_at = clock_timestamp() where id = v_start.id;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.member-machine-desktop-start-authority/v1',
		'state', 'authorized',
		'startId', v_start.id,
		'machineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'executorOwner', v_placement.owner,
		'providerId', v_placement.binding ->> 'providerId',
		'userId', v_start.user_id,
		'served', v_served,
		'held', coalesce(v_machine.desktop_member_until > clock_timestamp(), false));
end
$$;
revoke all on function public.qorpera_member_machine_desktop_start_authority(uuid, text, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_start_authority(uuid, text, text) to service_role;

-- 4. The machine stays awake under a member who watches or holds it ----------------------------------------------------------

-- The executor's read of a look the member confirmed in the last 30 minutes (keepDesktop) moves the machine's last use,
-- at most every 30 seconds, as an agent's screen read does; an unconfirmed look moves nothing (the window pauses after 30
-- minutes without a touch).
do $$ begin execute pg_temp.machine_member_start_patched('public.qorpera_member_machine_screen_authority(uuid,text,text)'::regprocedure,
	array[$old$		update public.qorpera_company_machine_screen_watches set use_served_at = clock_timestamp()
		where machine_id = v_watch.machine_id and user_id = v_watch.user_id;$old$,
	$new$		update public.qorpera_company_machine_screen_watches set use_served_at = clock_timestamp()
		where machine_id = v_watch.machine_id and user_id = v_watch.user_id;
		-- 20260930714000: a member who watches uses the machine, while their watch stands.
		if coalesce(v_watch.confirmed_at > clock_timestamp() - interval '30 minutes', false) then
			update public.qorpera_company_machines set last_used_at = clock_timestamp()
			where id = v_machine.id and last_used_at < clock_timestamp() - interval '30 seconds';
		end if;$new$]); end $$;

-- A hold's renewed heartbeat moves it too (the hold ends 5 minutes after the last word, 30 after the last input).
do $$ begin execute pg_temp.machine_member_start_patched('public.qorpera_member_keep_machine_desktop(uuid,uuid,bigint,bigint)'::regprocedure,
	array[$old$	update public.qorpera_company_machines set desktop_member_until = v_until where id = v_machine.id;$old$,
	$new$	update public.qorpera_company_machines set desktop_member_until = v_until where id = v_machine.id;
	-- 20260930714000: a member who holds the desktop uses the machine.
	update public.qorpera_company_machines set last_used_at = v_now
	where id = v_machine.id and last_used_at < v_now - interval '30 seconds';$new$]); end $$;

-- 5. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_member_machine_desktop_start_begin(uuid,uuid)',
		'public.qorpera_member_machine_desktop_start_authority(uuid,text,text)',
		'public.qorpera_member_machine_screen_authority(uuid,text,text)',
		'public.qorpera_member_keep_machine_desktop(uuid,uuid,bigint,bigint)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930714000') = 0 then
			raise exception '20260930714000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_screen_authority(uuid,text,text)'::regprocedure), '20260930713000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_keep_machine_desktop(uuid,uuid,bigint,bigint)'::regprocedure), '20260930713000') = 0 then
		raise exception '20260930714000: a patched body lost its 20260930713000 marker'; end if;
end $guard$;

drop function pg_temp.machine_member_start_patched(regprocedure, text[]);
