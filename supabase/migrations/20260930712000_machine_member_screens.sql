-- 20260930712000: a member watches an agent's desktop computer in the web's computer window (Jonas, 10 November 2026: "Yes,
-- build it"; lanes/desktop-computers-20261110/LIVE-VIEW-PLAN.md, stage 1a: watch). The window shows a picture of the
-- machine's screen that refreshes about once a second, through the coding executor of the machine's node, picture by
-- picture: each one is released as an agent's machine_screen picture is (the company folder's boundary), and then checked
-- against what the watching member may read. Nothing of a picture is stored. Every member who reads the company may
-- watch (viewers too); owners, admins and contributors may wake a sleeping machine (qorpera_member_manage_company_machine,
-- as before). There is no take-over here (stage 1b, 20260930713000).
--
-- * Which machines are an agent's computer: the company's machines that are not removed or being deleted, that the agent
--   started or whose screen it drove last (screen_staff_agent_id, new, stamped with screen_used_at by the patched
--   qorpera_authorize_machine_screen whenever the agent changes or 30 seconds passed).
-- * qorpera_list_agent_machines(profile, agent), a member's read (authenticated): at most 20 such machines, running ones
--   first, then the ones this agent drove last, then the newest; whether the member may wake one; per machine its name,
--   purpose, state, lifetime, whether it is big enough for a desktop, who started it and drove it last, and why a waiting
--   one waits ('hours' or 'room'). No placement, boot, executor or node, and no command line.
-- * qorpera_member_machine_screen_begin(profile, machine, watch), the member's own call for one look (authenticated; the
--   node's executor makes it with the member's own token, so auth.uid() is the member): a member who reads the company; a
--   machine of it, not removed; running on its placement with a known boot (else MACHINE_NOT_RUNNING); the disk's rule as
--   for an agent's look (on a disk that has had a company folder view, a member who does not read the folder's root sees
--   no screen: MACHINE_NEEDS_COMPANY_VIEW); at most one look per 400 ms per member and machine (SCREEN_TOO_SOON). It
--   records the look (qorpera_company_machine_screen_watches: first and last look, how many, when the member last said
--   they still watch) and answers a single-use id, nothing else.
-- * qorpera_member_machine_screen_authority(use, owner, provider), the executor's read (service_role): the use, begun in
--   the last 15 seconds and not served yet, of a member who still reads the company; everything above checked again live;
--   where the machine runs, and whether the desktop's own idle stop is to be put off (keepDesktop: the member said they
--   still watch within the last 30 minutes). The use is served only by the machine's own executor (owner and provider), and
--   only once: the executor that forwards it reads it without serving it. It never moves the machine's last use: a member
--   who watches never keeps a machine awake by SQL (the machine's own idle measure may still count the desktop's work).
-- * qorpera_folder_member_machine_reads(placement, boot, member), the executor's check after the boundary (service_role):
--   every read the machine's newest test-machine view holds is one the member may read now (qorpera_folder_paths_authority,
--   each path by the resource that covers it, as a run's take-in decides), or 42501 with detail
--   qorpera.test-machine/member-unreadable. It files nothing,
--   and its refusal is the member's alone: the machine and its boot are not marked (an agent's take-in refusal marks them).
-- * The `machines` hint: at commit, to every member's live hint topic of the company (20260930653000), when a machine is
--   made, wanted on or off, removed, fails, or another agent drives its screen (or one drives it again after 10 minutes),
--   and when a placement is made, starts, gets a boot, retires or goes. Never for the machine's last use alone, and never
--   for a company being deleted (its members get no hints).
-- Every new or patched body names this migration (20260930712000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)') is not null then
		raise exception '20260930712000 is already applied'; end if;
	if to_regprocedure('public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)') is null
		or to_regprocedure('public.qorpera_live_hint_send(text,text[],text)') is null
		or to_regprocedure('public.qorpera_live_hint_profile_topics(uuid)') is null
		or to_regprocedure('public.qorpera_folder_paths_authority(uuid,uuid,jsonb,text[])') is null then
		raise exception '20260930712000 needs machine_screen (20260930708000) and the live hints (20260930653000)'; end if;
end $$;

-- The columns, the table and the triggers lock the machines and their placements: never queue behind a long transaction.
set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_member_screens_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930712000' in v_definition) > 0 then
		raise exception '20260930712000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930712000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930712000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. Who drives a machine's screen, and who watches it -------------------------------------------------------------------

-- The agent whose run last looked at or acted on the machine's screen (machine_screen), and when: stamped by
-- qorpera_authorize_machine_screen when the agent changes, and otherwise at most every 30 seconds.
alter table public.qorpera_company_machines
	add column screen_staff_agent_id uuid,
	add column screen_used_at timestamptz;

-- One row per member and machine they watched: their first and last look, how many, when they last said they still watch
-- (the web asks after 30 minutes without a touch on the page), and their pending look's single-use id. No picture, no
-- etag and nothing of the screen is ever kept.
create table public.qorpera_company_machine_screen_watches (
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	first_look_at timestamptz not null,
	last_look_at timestamptz not null,
	looks bigint not null check (looks >= 1),
	confirmed_at timestamptz,
	use_id uuid not null,
	use_begun_at timestamptz not null,
	use_served_at timestamptz,
	primary key (machine_id, user_id)
);
create unique index qorpera_company_machine_screen_watches_use on public.qorpera_company_machine_screen_watches (use_id);
alter table public.qorpera_company_machine_screen_watches enable row level security;
revoke all on public.qorpera_company_machine_screen_watches from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. An agent's machines, as a member's window lists them ----------------------------------------------------------------

-- At most 20, running first, then by when this agent last drove the screen, then the newest. A machine is big enough for a
-- desktop at 2 processors and 4 GiB (deploy/machine/desktop: MIN_CPUS, MIN_MEMORY_KB). The answer names no node,
-- placement, boot or executor, and no command.
create function public.qorpera_list_agent_machines(p_profile_id uuid, p_staff_agent_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	-- 20260930712000
	if auth.uid() is null or p_profile_id is null or p_staff_agent_id is null
		or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_profile_staff as staff
		where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id) then
		raise exception 'Agent is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object(
		'schema', 'qorpera.agent-machines/v1',
		'profileId', p_profile_id,
		'staffAgentId', p_staff_agent_id,
		'canWake', public.qorpera_can_write_profile(p_profile_id),
		'machines', coalesce((
			select jsonb_agg(jsonb_build_object(
					'machineId', listed.id,
					'name', listed.name,
					'purpose', listed.purpose,
					'state', listed.state,
					'lifetime', listed.lifetime,
					'desktopCapable', listed.cpus >= 2 and listed.memory_bytes >= 4294967296,
					'startedByAgent', listed.started_by_staff_agent_id = p_staff_agent_id,
					'screenUsedAt', listed.screen_used_at,
					'screenAgentName', (select staff.display_name from public.qorpera_profile_staff as staff
						where staff.profile_id = p_profile_id and staff.staff_agent_id = listed.screen_staff_agent_id),
					-- Why a machine that wants to run is not placed yet: the company's computer hours, or room on the servers.
					'waitingFor', case when listed.state = 'waiting' then
						case when public.qorpera_company_at_zero(p_profile_id, clock_timestamp()) then 'hours' else 'room' end end)
				order by listed.state = 'running' desc,
					case when listed.screen_staff_agent_id = p_staff_agent_id then listed.screen_used_at end desc nulls last,
					listed.created_at desc, listed.id)
			from (
				select machine.*, now_in.state
				from public.qorpera_company_machines as machine
				cross join lateral (select public.qorpera_company_machine_state(machine) as state) as now_in
				where machine.profile_id = p_profile_id and machine.removed_at is null and machine.desired_state <> 'deleted'
					and (machine.started_by_staff_agent_id = p_staff_agent_id or machine.screen_staff_agent_id = p_staff_agent_id)
				order by now_in.state = 'running' desc,
					case when machine.screen_staff_agent_id = p_staff_agent_id then machine.screen_used_at end desc nulls last,
					machine.created_at desc, machine.id
				limit 20) as listed), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_list_agent_machines(uuid, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_agent_machines(uuid, uuid) to authenticated;

-- 3. A member's look: begun as the member ---------------------------------------------------------------------------------

-- p_watch is {"confirmed": boolean}: true when the member said they still watch (they opened the window, or touched it,
-- or answered "Still watching?"), which keeps the desktop on for 30 minutes from then (qorpera_member_machine_screen_authority).
-- The machine is locked as the agent's screen read locks it (FOR NO KEY UPDATE: a view's open, FOR SHARE, waits for it;
-- a command's insert, KEY SHARE, does not), so the disk's rule stands until this commits, and two looks of one member at
-- one machine are counted one after the other.
create function public.qorpera_member_machine_screen_begin(p_profile_id uuid, p_machine_id uuid, p_watch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_last timestamptz;
	v_use uuid := pg_catalog.gen_random_uuid();
	v_now timestamptz := clock_timestamp();
begin
	-- 20260930712000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or not coalesce(case when jsonb_typeof(p_watch) = 'object' then p_watch - 'confirmed' = '{}'::jsonb
			and jsonb_typeof(p_watch -> 'confirmed') = 'boolean' end, false) then
		raise exception 'Machine screen request is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Machine screen is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine screen is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused', 'reason', 'MACHINE_NOT_RUNNING');
	end if;
	-- The disk's rule, the member's side of it: what the disk's views read may be on its screen.
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	if not coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', v_user, 'read'), false)
		and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	select watch.last_look_at into v_last from public.qorpera_company_machine_screen_watches as watch
	where watch.machine_id = v_machine.id and watch.user_id = v_user;
	if v_last > v_now - interval '400 milliseconds' then
		return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused', 'reason', 'SCREEN_TOO_SOON');
	end if;
	insert into public.qorpera_company_machine_screen_watches as watch (machine_id, user_id, profile_id, first_look_at,
		last_look_at, looks, confirmed_at, use_id, use_begun_at, use_served_at)
	values (v_machine.id, v_user, v_machine.profile_id, v_now, v_now, 1,
		case when (p_watch ->> 'confirmed')::boolean then v_now end, v_use, v_now, null)
	on conflict (machine_id, user_id) do update set last_look_at = excluded.last_look_at, looks = watch.looks + 1,
		confirmed_at = coalesce(excluded.confirmed_at, watch.confirmed_at), use_id = excluded.use_id,
		use_begun_at = excluded.use_begun_at, use_served_at = null;
	return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'ok', 'useId', v_use);
end
$$;
revoke all on function public.qorpera_member_machine_screen_begin(uuid, uuid, jsonb)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_screen_begin(uuid, uuid, jsonb) to authenticated;

-- 4. The executor's read of a member's look -----------------------------------------------------------------------------

-- Everything the begin checked, again and live, under the machine's lock; then the use: the member's latest, begun within
-- 15 seconds, not served. Served by the placement's own executor only, once. A use that is not (another member's, an old
-- one, served, or a member who left) raises; a machine that no longer runs, or a disk the member may no longer see,
-- answers as the begin does.
create function public.qorpera_member_machine_screen_authority(p_use_id uuid, p_owner text, p_provider_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_watch public.qorpera_company_machine_screen_watches%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_served boolean;
begin
	-- 20260930712000
	if auth.role() is distinct from 'service_role' or p_use_id is null
		or coalesce(p_owner !~ '^[A-Za-z0-9_.:-]{1,120}$', true) or coalesce(p_provider_id !~ '^[a-z][a-z0-9_-]{0,63}$', true) then
		raise exception 'Machine screen request is malformed' using errcode = '22023'; end if;
	select watch.* into v_watch from public.qorpera_company_machine_screen_watches as watch where watch.use_id = p_use_id;
	if not found then
		raise exception 'Machine screen use is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = v_watch.machine_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine screen use is unavailable' using errcode = '42501'; end if;
	-- Read again under the machine's lock: a begin of the same member at this machine takes the lock first.
	select watch.* into v_watch from public.qorpera_company_machine_screen_watches as watch
	where watch.machine_id = v_machine.id and watch.user_id = v_watch.user_id;
	if v_watch.use_id is distinct from p_use_id or v_watch.use_served_at is not null
		or v_watch.use_begun_at < clock_timestamp() - interval '15 seconds'
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_machine.profile_id and member.user_id = v_watch.user_id)
		or exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = v_machine.profile_id) then
		raise exception 'Machine screen use is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	if not coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', v_watch.user_id, 'read'), false)
		and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	-- Served by its own executor, once. The machine's last use stays where it is.
	v_served := v_placement.owner = p_owner and v_placement.binding ->> 'providerId' = p_provider_id;
	if v_served then
		update public.qorpera_company_machine_screen_watches set use_served_at = clock_timestamp()
		where machine_id = v_watch.machine_id and user_id = v_watch.user_id;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.member-machine-screen-authority/v1',
		'state', 'authorized',
		'useId', p_use_id,
		'machineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'executorOwner', v_placement.owner,
		'providerId', v_placement.binding ->> 'providerId',
		'userId', v_watch.user_id,
		'served', v_served,
		'keepDesktop', coalesce(v_watch.confirmed_at > clock_timestamp() - interval '30 minutes', false));
end
$$;
revoke all on function public.qorpera_member_machine_screen_authority(uuid, text, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_screen_authority(uuid, text, text) to service_role;

-- 5. What the machine read, against the watching member ------------------------------------------------------------------

-- Shaped like qorpera_folder_test_machine_inherit_reads (20260930498000): the placement current on the boot the executor
-- looked on; the newest test-machine view of it, which holds every read the disk was served; every path of its read records
-- checked for the member in one statement (qorpera_folder_paths_authority, the check a run's take-in makes per path). A
-- placement that never had a view has nothing to check. Nothing is filed.
create function public.qorpera_folder_member_machine_reads(p_placement_id uuid, p_boot_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_view uuid;
	v_paths text[];
	v_reads bigint;
begin
	-- 20260930712000
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_placement_id is null or p_boot_id is null or p_user_id is null then
		raise exception 'Folder member read is invalid' using errcode = '22023'; end if;
	select * into v_placement from public.qorpera_company_machine_placements where id = p_placement_id;
	select * into v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	-- coalesce: a missing row must refuse, not compare to null.
	if not coalesce(v_machine.id is not null and v_placement.retired_at is null and v_placement.removed_at is null
			and v_placement.boot_id = p_boot_id, false) then
		raise exception 'Folder member read is not current' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_machine.profile_id and member.user_id = p_user_id)
		or exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = v_machine.profile_id) then
		raise exception 'Member is unavailable' using errcode = '42501'; end if;
	select v.id into v_view from public.qorpera_folder_views v
	where v.kind = 'test_machine' and v.placement_id = v_placement.id and v.environment_id = v_machine.environment_id
	order by v.created_at desc, v.id desc limit 1;
	if v_view is null then
		return jsonb_build_object('schema', 'qorpera.folder-member-reads/v1', 'viewId', null, 'reads', 0);
	end if;
	select coalesce(array_agg(distinct x ->> 'path') filter (where x ->> 'path' is not null), '{}'), count(x)
	into v_paths, v_reads
	from public.qorpera_folder_view_read_records r, jsonb_array_elements(r.reads) x
	where r.view_id = v_view;
	-- Each path by the resource that covers it now, as a run's take-in decides it (qorpera_folder_release_pairs): a path
	-- no resource covers is no one's to read.
	if exists (select 1 from public.qorpera_folder_paths_authority(v_machine.environment_id, v_machine.profile_id,
			jsonb_build_object('kind', 'member', 'userId', p_user_id), v_paths) as authority where not authority.ok) then
		raise exception 'A read is not readable to the member' using errcode = '42501',
			detail = 'qorpera.test-machine/member-unreadable'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-member-reads/v1', 'viewId', v_view, 'reads', v_reads);
end
$$;
revoke all on function public.qorpera_folder_member_machine_reads(uuid, uuid, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_folder_member_machine_reads(uuid, uuid, uuid) to service_role;

-- 6. The agent's screen read stamps who drives the screen ----------------------------------------------------------------

do $$ begin execute pg_temp.machine_member_screens_patched('public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure,
	array[$old$and last_used_at < clock_timestamp() - interval '30 seconds';$old$,
	$new$and last_used_at < clock_timestamp() - interval '30 seconds';
	-- 20260930712000: which agent drives the screen, for the members' computer window (qorpera_list_agent_machines):
	-- stamped when the agent changes, and otherwise at most every 30 seconds.
	update public.qorpera_company_machines set screen_staff_agent_id = v_run.staff_agent_id, screen_used_at = clock_timestamp()
	where id = v_machine.id and (screen_staff_agent_id is distinct from v_run.staff_agent_id or screen_used_at is null
		or screen_used_at < clock_timestamp() - interval '30 seconds');$new$]); end $$;

-- 7. The `machines` hint ------------------------------------------------------------------------------------------------

-- At commit, `machines` to the hint topics of every member of the machine's company (qorpera_list_agent_machines reads
-- with qorpera_can_read_profile, so viewers too), while the company is not being deleted. Built as
-- qorpera_live_hint_internal is: once per company per transaction, a 20 ms lock budget, and every error caught (a cancel
-- too), so a failing Realtime never fails or slows the write; the first error ends hinting for the rest of the
-- transaction. The triggers' columns and conditions keep it off the frequent writes: a machine's last use, busy check-ins,
-- its notify list and its place in line never send one.
create function public.qorpera_machine_hint()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_class text;
begin
	-- 20260930712000
	if current_setting('qorpera.live_hints_failed', true) = 'on' then return null; end if;
	begin
		v_class := new.profile_id || ' machines';
		if strpos(coalesce(current_setting('qorpera.live_hints_sent', true), ''), '|' || v_class || '|') > 0 then
			return null;
		end if;
		perform set_config('lock_timeout', '20ms', true);
		perform public.qorpera_live_hint_send('machines', public.qorpera_live_hint_profile_topics(new.profile_id), v_class);
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception
		when query_canceled then
			perform set_config('qorpera.live_hints_failed', 'on', true);
		when others then
			perform set_config('qorpera.live_hints_failed', 'on', true);
	end;
	return null;
end $$;
revoke all on function public.qorpera_machine_hint() from public, anon, authenticated, service_role, qorpera_secret_broker;

create constraint trigger qorpera_machine_hint after insert on public.qorpera_company_machines
	deferrable initially deferred for each row execute function public.qorpera_machine_hint();
create constraint trigger qorpera_machine_hint_change
	after update of desired_state, removed_at, last_error, screen_staff_agent_id, screen_used_at on public.qorpera_company_machines
	deferrable initially deferred for each row
	when (old.desired_state is distinct from new.desired_state or old.removed_at is distinct from new.removed_at
		or old.last_error is distinct from new.last_error or old.screen_staff_agent_id is distinct from new.screen_staff_agent_id
		or (new.screen_used_at is not null
			and (old.screen_used_at is null or old.screen_used_at < new.screen_used_at - interval '10 minutes')))
	execute function public.qorpera_machine_hint();
create constraint trigger qorpera_machine_hint after insert on public.qorpera_company_machine_placements
	deferrable initially deferred for each row execute function public.qorpera_machine_hint();
create constraint trigger qorpera_machine_hint_change
	after update of running_at, boot_id, retired_at, removed_at on public.qorpera_company_machine_placements
	deferrable initially deferred for each row
	when (old.running_at is distinct from new.running_at or old.boot_id is distinct from new.boot_id
		or old.retired_at is distinct from new.retired_at or old.removed_at is distinct from new.removed_at)
	execute function public.qorpera_machine_hint();

-- 8. The deploy guard: every new or patched body carries the marker -----------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_list_agent_machines(uuid,uuid)',
		'public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)',
		'public.qorpera_member_machine_screen_authority(uuid,text,text)',
		'public.qorpera_folder_member_machine_reads(uuid,uuid,uuid)',
		'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)',
		'public.qorpera_machine_hint()'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930712000') = 0 then
			raise exception '20260930712000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure),
			'20260930708000') = 0 then
		raise exception '20260930712000: the screen read lost its 20260930708000 marker'; end if;
end $guard$;

drop function pg_temp.machine_member_screens_patched(regprocedure, text[]);
