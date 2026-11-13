-- 20260930744000: the member's pointer is the desktop's pointer (POINTER-BRIEF.md, step 1). In the large view the
-- member's own pointer moves the desktop's pointer as it moves, so hover works, without a row, a receipt or a log line
-- per move: SQL gives the member a short POINTER PASS (10 seconds, renewed while the pointer moves) and the executor
-- lets moves through on it, checking nothing per move but the pass in its own memory.
--
-- * qorpera_member_machine_desktop_pointer_begin(profile, machine, generation, epoch, seat), for authenticated (the
--   executor calls it with the member's own token): a pass for the desktop the member shares with the agent (`generation`:
--   the lease generation the member's window knows, as each shared action carries it, 20260930738000) or the one they
--   type on privately (`epoch` and `seat` of their own hold, as each of its actions carries them, 20260930713000).
--   Owners, admins and contributors of a company not being deleted; the machine of the company, big enough for a
--   desktop, running on its placement; the disk's root-read rule as a look's. Shared: refused while anyone holds the
--   desktop privately (DESKTOP_MEMBER_IN_CONTROL, the caller's own hold in another window too) and once the generation
--   moved (DESKTOP_HELD_SINCE). Private: only the caller's own live hold under that epoch and in that seat
--   (DESKTOP_CONTROL_ENDED, DESKTOP_MEMBER_IN_CONTROL). A move is never an action: the pass records no action, renews
--   no lease, marks no disk and is never counted in the 25 shared actions per 5 seconds. One row per member and machine
--   (qorpera_company_machine_desktop_pointers) holds the newest pass; a new pass replaces it.
-- * qorpera_member_machine_desktop_pointer_authority(pass, owner, provider), the executor's read (service_role): the pass,
--   at most 10 seconds old, of a member who still may act, read again live under the machine's lock with every check
--   above, and where the machine runs. Its answer names the generation that stands now, so the host refuses the pass's
--   moves once a private hold began (it learns each newer generation from every look, action and pass it serves). The
--   read moves the machine's last use at most every 30 seconds: a member moving the pointer is a member at the desktop.
-- * qorpera_list_agent_machines: `others` names at most 50 members, the most recent first (release review of v239, #1723
--   r1 F1: 734000's list had no limit, and the client refuses more than 50).
-- * Not changed: taking over, keeping, handing back, the shared and private actions, the picture fence, every seat,
--   generation and epoch fence, the agent's reads and memberTouched (a move alone never says a member used the screen).
-- Every new or patched body names this migration (20260930744000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_machine_desktop_pointer_begin(uuid,uuid,bigint,bigint,bigint)') is not null then
		raise exception '20260930744000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)') is null then
		raise exception '20260930744000 needs the shared input''s generation (20260930738000)'; end if;
end $$;

-- The table and its check lock nothing anyone else waits on; the list's patch takes the function's lock only.
set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_desktop_pointer_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930744000' in v_definition) > 0 then
		raise exception '20260930744000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930744000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930744000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The newest pointer pass of each member on each machine ---------------------------------------------------------------

-- Shared (the generation its input is made under) or private (the epoch and the seat of the member's own hold).
create table public.qorpera_company_machine_desktop_pointers (
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	user_id uuid not null,
	pass_id uuid not null unique,
	begun_at timestamptz not null,
	generation bigint check (generation >= 0),
	epoch bigint check (epoch >= 0),
	seat bigint check (seat >= 0),
	primary key (machine_id, user_id),
	check ((generation is not null and epoch is null and seat is null)
		or (generation is null and epoch is not null and seat is not null))
);
alter table public.qorpera_company_machine_desktop_pointers enable row level security;
revoke all on public.qorpera_company_machine_desktop_pointers from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. A member's pointer pass, as SQL gives it ---------------------------------------------------------------------------------

create function public.qorpera_member_machine_desktop_pointer_begin(p_profile_id uuid, p_machine_id uuid, p_generation bigint,
	p_epoch bigint, p_seat bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_pass uuid := pg_catalog.gen_random_uuid();
	v_now timestamptz;
begin
	-- 20260930744000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or not coalesce((p_generation >= 0 and p_epoch is null and p_seat is null)
			or (p_generation is null and p_epoch >= 0 and p_seat >= 0), false) then
		raise exception 'Machine desktop pointer is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) or public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- Locked as an action locks it, so a take-over and this pass are ordered.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	v_now := clock_timestamp();
	if v_machine.cpus < 2 or v_machine.memory_bytes < 4294967296 then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
			'reason', 'DESKTOP_MACHINE_TOO_SMALL'); end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	if not coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', v_user, 'read'), false)
		and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	if p_generation is not null then
		-- Shared: no one holds the desktop privately (the caller's own hold in another window too), and no one did since
		-- the window last knew it.
		if coalesce(v_machine.desktop_member_until > v_now, false) then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
		if v_machine.desktop_member_generation is distinct from p_generation then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
				'reason', 'DESKTOP_HELD_SINCE'); end if;
	else
		-- Private: the caller's own live hold, taken under exactly that epoch and in exactly that seat.
		if not coalesce(v_machine.desktop_member_until > v_now, false) then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
				'reason', 'DESKTOP_CONTROL_ENDED'); end if;
		if v_machine.desktop_member_user_id is distinct from v_user then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
		if v_machine.desktop_member_epoch is distinct from p_epoch or v_machine.desktop_member_generation is distinct from p_seat then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'refused',
				'reason', 'DESKTOP_CONTROL_ENDED'); end if;
	end if;
	insert into public.qorpera_company_machine_desktop_pointers(machine_id, user_id, pass_id, begun_at, generation, epoch, seat)
	values (v_machine.id, v_user, v_pass, v_now, p_generation, p_epoch, p_seat)
	on conflict (machine_id, user_id) do update set pass_id = excluded.pass_id, begun_at = excluded.begun_at,
		generation = excluded.generation, epoch = excluded.epoch, seat = excluded.seat;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer/v1', 'state', 'ok', 'passId', v_pass,
		'seconds', 10);
end
$$;
revoke all on function public.qorpera_member_machine_desktop_pointer_begin(uuid, uuid, bigint, bigint, bigint)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_pointer_begin(uuid, uuid, bigint, bigint, bigint) to authenticated;

-- 3. The executor's read of a pointer pass -------------------------------------------------------------------------------------

create function public.qorpera_member_machine_desktop_pointer_authority(p_pass_id uuid, p_owner text, p_provider_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_pass public.qorpera_company_machine_desktop_pointers%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_now timestamptz;
begin
	-- 20260930744000
	if auth.role() is distinct from 'service_role' or p_pass_id is null
		or coalesce(p_owner !~ '^[A-Za-z0-9_.:-]{1,120}$', true) or coalesce(p_provider_id !~ '^[a-z][a-z0-9_-]{0,63}$', true) then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	select pass.* into v_pass from public.qorpera_company_machine_desktop_pointers as pass where pass.pass_id = p_pass_id;
	if not found then
		raise exception 'Machine desktop pointer is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = v_pass.machine_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop pointer is unavailable' using errcode = '42501'; end if;
	v_now := clock_timestamp();
	-- Read again under the machine's lock: a newer pass of the member's replaced this one.
	select pass.* into v_pass from public.qorpera_company_machine_desktop_pointers as pass where pass.pass_id = p_pass_id;
	if not found or v_pass.begun_at < v_now - interval '10 seconds'
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_machine.profile_id and member.user_id = v_pass.user_id
				and member.role::text in ('owner', 'admin', 'contributor'))
		or public.qorpera_company_deleting(v_machine.profile_id) then
		raise exception 'Machine desktop pointer is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	if not coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', v_pass.user_id, 'read'), false)
		and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	if v_pass.generation is not null then
		if coalesce(v_machine.desktop_member_until > v_now, false) then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer-authority/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
		if v_machine.desktop_member_generation is distinct from v_pass.generation then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer-authority/v1', 'state', 'refused',
				'reason', 'DESKTOP_HELD_SINCE'); end if;
	elsif not coalesce(v_machine.desktop_member_until > v_now, false)
		or v_machine.desktop_member_user_id is distinct from v_pass.user_id
		or v_machine.desktop_member_epoch is distinct from v_pass.epoch
		or v_machine.desktop_member_generation is distinct from v_pass.seat then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-pointer-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_CONTROL_ENDED'); end if;
	-- A member moving the pointer is a member at the desktop: the machine's last use, at most every 30 seconds.
	update public.qorpera_company_machines set last_used_at = v_now
	where id = v_machine.id and last_used_at < v_now - interval '30 seconds';
	return jsonb_build_object(
		'schema', 'qorpera.member-machine-desktop-pointer-authority/v1',
		'state', 'authorized',
		'passId', v_pass.pass_id,
		'machineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'executorOwner', v_placement.owner,
		'providerId', v_placement.binding ->> 'providerId',
		'userId', v_pass.user_id,
		-- The lease generation that stands now: the host refuses the pass's moves once it sees a newer one.
		'generation', v_machine.desktop_member_generation,
		'private', v_pass.generation is null,
		-- What is left of the pass's 10 seconds, in milliseconds.
		'milliseconds', greatest(0, floor(extract(epoch from v_pass.begun_at + interval '10 seconds' - v_now) * 1000))::integer,
		'served', v_placement.owner = p_owner and v_placement.binding ->> 'providerId' = p_provider_id);
end
$$;
revoke all on function public.qorpera_member_machine_desktop_pointer_authority(uuid, text, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_pointer_authority(uuid, text, text) to service_role;

-- 4. The window's list names at most 50 others, the most recent first ---------------------------------------------------------

do $$ begin execute pg_temp.machine_desktop_pointer_patched(
	'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure,
	array[$old$					|| coalesce((select jsonb_build_object('others', jsonb_agg(named.name order by named.user_id))
						from (select recent.user_id, nullif(btrim(public.qorpera_review_member_name(p_profile_id, recent.user_id)), '')
								as name
							from (select distinct act.user_id from public.qorpera_company_machine_desktop_actions as act
								where act.machine_id = listed.id and act.shared and act.begun_at > clock_timestamp() - interval '60 seconds'
									and act.user_id is distinct from auth.uid()) as recent) as named
						where named.name is not null
						having count(*) > 0), '{}'::jsonb)$old$,
	$new$					-- 20260930744000: at most 50 names, the members who acted most recently first (#1723 r1 F1).
					|| coalesce((select jsonb_build_object('others', jsonb_agg(top.name order by top.last_at desc, top.user_id))
						from (select named.user_id, named.last_at, named.name
							from (select recent.user_id, recent.last_at,
									nullif(btrim(public.qorpera_review_member_name(p_profile_id, recent.user_id)), '') as name
								from (select act.user_id, max(act.begun_at) as last_at from public.qorpera_company_machine_desktop_actions as act
									where act.machine_id = listed.id and act.shared and act.begun_at > clock_timestamp() - interval '60 seconds'
										and act.user_id is distinct from auth.uid()
									group by act.user_id) as recent) as named
							where named.name is not null
							order by named.last_at desc, named.user_id
							limit 50) as top
						having count(*) > 0), '{}'::jsonb)$new$]); end $$;

-- 5. The deploy guard: every new or patched body carries the marker, and the patched one keeps its earlier ones ----------------

do $guard$
begin
	if exists (select 1 from unnest(array[
			'public.qorpera_member_machine_desktop_pointer_begin(uuid,uuid,bigint,bigint,bigint)',
			'public.qorpera_member_machine_desktop_pointer_authority(uuid,text,text)',
			'public.qorpera_list_agent_machines(uuid,uuid)']::regprocedure[]) f(oid)
		where strpos((select prosrc from pg_proc where oid = f.oid), '20260930744000') = 0) then
		raise exception '20260930744000 marker is missing'; end if;
	if exists (select 1 from unnest(array['20260930712000', '20260930713000', '20260930730000', '20260930734000',
			'20260930738000']) marker
			where strpos((select prosrc from pg_proc
				where oid = 'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure), marker) = 0) then
		raise exception '20260930744000: the list lost an earlier marker'; end if;
end $guard$;

drop function pg_temp.machine_desktop_pointer_patched(regprocedure, text[]);
