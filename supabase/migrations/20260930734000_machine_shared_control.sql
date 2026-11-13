-- 20260930734000: a member and the agent share the agent's desktop computer again (Jonas, 12 Nov 2026: "i no longer
-- share control with the agent but need this take over/hand back thing? why did we regress so much since the "office"
-- computers"; then "Yes, shared control"). A member who may take the desktop over acts on it at once, beside the agent,
-- without a lease; taking it over stays as the private mode for typing a password, with every fence of 20260930713000 as
-- it is.
--
-- * qorpera_member_machine_desktop_share_begin(profile, machine, action), for authenticated: one shared action, as the
--   private begin takes it (owners, admins and contributors of a company not being deleted, the machine of the company
--   big enough for a desktop and running on its placement, the disk's root-read rule and mark, the action without its
--   text: a `type` by its length; the same locks in the same order, the machine's alone),
--   but with no hold of the member's. While anyone holds the desktop privately (a live lease, the caller's own in another
--   window too: that is that window's private input), it is refused DESKTOP_MEMBER_IN_CONTROL. At most 25 of one
--   member's shared actions on one machine in 5 seconds (DESKTOP_ACTIONS_TOO_FAST): the lease no longer bounds who acts.
--   The row it records (qorpera_company_machine_desktop_actions, `shared`) has no control row and holds, as its `seat`,
--   the lease generation it was begun at; it moves the machine's last use (at most every 30 seconds) and names the
--   member and the time on the machine (desktop_shared_user_id, desktop_shared_at). Shared rows older than 30 days go at
--   the machine's next shared begin (the lease's rows go with their machine, as before).
-- * qorpera_member_machine_desktop_act_authority, the executor's read: a shared action is served only while no one holds
--   the desktop privately and none took it since it was begun (the lease generation it was begun at stands, else
--   DESKTOP_MEMBER_IN_CONTROL); the answer then says `shared`, and the host asks the picture fence after it holds the
--   desktop with no member (as for an agent's action: no live hold by anyone), so a private hold that began meanwhile
--   stops it before it runs. A private action is read exactly as before, and its answer is unchanged.
-- * qorpera_authorize_machine_screen, the agent's read: when a member acted on the shared desktop since an agent was last
--   told, its answer says who and how long ago (memberTouched: the member's name, or "A member" for one no longer in the
--   company, the seconds, and the time of that action; never what was done or typed). The read marks nothing (review r1
--   F4 of #1701): the executor marks it told once an answer that carries it is ready for the agent
--   (qorpera_machine_desktop_shared_told, with that time), so a call that is refused or fails after the read (the desktop
--   busy, a restarted machine, an executor that did not answer) leaves it for the agent's next call. The runtime shows it
--   to the agent in one line, so it looks again before it acts on an older picture.
-- * qorpera_machine_desktop_shared_told(machine, at), for the service role: the agent was told of the shared actions up
--   to `at` (desktop_shared_told_at moves forward to it, never back, never past the newest action).
-- * qorpera_list_agent_machines, the computer window's list: each machine on which other members of the company acted in
--   shared mode in the last 60 seconds names them (`others`), so the window says who else is using it; one who has left
--   the company since is not named (review r1 F3 of #1701).
-- * Not changed: taking over, keeping, handing back, the picture fence, the clipboard clear and every seat, generation and
--   epoch fence of 20260930713000; the private begin; a member's look and start.
-- Every new or patched body names this migration (20260930734000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)') is not null then
		raise exception '20260930734000 is already applied'; end if;
	if to_regclass('public.qorpera_company_machine_screen_runs') is null
		or to_regprocedure('public.qorpera_member_machine_desktop_act_authority(uuid,text,text)') is null then
		raise exception '20260930734000 needs take-over (20260930713000) and a member''s computer for an agent (20260930730000)';
	end if;
end $$;

-- The columns and the check lock the machines and the actions: never queue behind a long transaction.
set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_shared_control_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930734000' in v_definition) > 0 then
		raise exception '20260930734000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930734000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930734000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. Who last acted on the shared desktop, and the shared actions ----------------------------------------------------------

alter table public.qorpera_company_machines
	-- The member whose shared action came last, and when; and up to when an agent was told of them (memberTouched).
	add column desktop_shared_user_id uuid,
	add column desktop_shared_at timestamptz,
	add column desktop_shared_told_at timestamptz;

-- A shared action has no lease row; its `seat` is the lease generation it was begun at (0 on a desktop no one ever held).
alter table public.qorpera_company_machine_desktop_actions
	alter column control_id drop not null,
	add column shared boolean not null default false,
	drop constraint qorpera_company_machine_desktop_actions_seat_check,
	add constraint qorpera_company_machine_desktop_actions_seat_check check (case when shared
		then control_id is null and seat >= 0 else control_id is not null and seat > 0 end);
create index qorpera_company_machine_desktop_actions_shared on public.qorpera_company_machine_desktop_actions
	(machine_id, begun_at) where shared;

-- 2. A member's shared action, as SQL takes it ------------------------------------------------------------------------------

-- The executor sends the member's action here without its text (a `type` by its length), as the member, before it runs
-- anything; it compares the action the executor's read answers later with the one it holds, as for a private one.
create function public.qorpera_member_machine_desktop_share_begin(p_profile_id uuid, p_machine_id uuid, p_action jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_reads_root boolean;
	v_action uuid := pg_catalog.gen_random_uuid();
	v_now timestamptz;
begin
	-- 20260930734000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or not coalesce(public.qorpera_valid_member_desktop_action(p_action), false) then
		raise exception 'Machine desktop action is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) or public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- Locked as a private action locks it: a take-over (FOR NO KEY UPDATE) and the agent's screen read (FOR UPDATE) are
	-- ordered with it.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	v_now := clock_timestamp();
	-- As a take-over (deploy/machine/desktop: MIN_CPUS 2, MIN_MEMORY_KB 4 GiB): a machine with a desktop.
	if v_machine.cpus < 2 or v_machine.memory_bytes < 4294967296 then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'DESKTOP_MACHINE_TOO_SMALL'); end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	v_reads_root := coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', v_user, 'read'), false);
	if not v_reads_root and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	-- Someone types privately (a live lease, the caller's own in another window too): no shared input until it ends.
	if coalesce(v_machine.desktop_member_until > v_now, false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
	-- The lease no longer bounds who acts: one member's shared actions on one machine, at most 25 in 5 seconds.
	if (select count(*) from public.qorpera_company_machine_desktop_actions as act
		where act.machine_id = v_machine.id and act.shared and act.user_id = v_user and act.begun_at > v_now - interval '5 seconds')
		>= 25 then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'DESKTOP_ACTIONS_TOO_FAST'); end if;
	-- The machine's shared actions are kept 30 days.
	delete from public.qorpera_company_machine_desktop_actions as act
	where act.machine_id = v_machine.id and act.shared and act.begun_at < v_now - interval '30 days';
	insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, seat, shared, begun_at)
	values (v_action, null, v_machine.id, v_user, p_action, v_machine.desktop_member_generation, true, v_now);
	-- The member's input is the machine's use (at most every 30 seconds), and the agent is told of it at its next look.
	update public.qorpera_company_machines set desktop_shared_user_id = v_user, desktop_shared_at = v_now,
		last_used_at = case when last_used_at < v_now - interval '30 seconds' then v_now else last_used_at end
	where id = v_machine.id;
	-- As a private action: a member who does not read the root, on a disk that never had a view, marks it.
	if not v_reads_root then
		update public.qorpera_company_machine_placements set folder_unchecked_at = v_now
		where id = v_placement.id and folder_unchecked_at is null
			and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
	end if;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'ok', 'actionId', v_action);
end
$$;
revoke all on function public.qorpera_member_machine_desktop_share_begin(uuid, uuid, jsonb)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_share_begin(uuid, uuid, jsonb) to authenticated;

-- 3. The executor's read of a shared action ----------------------------------------------------------------------------------

do $$ begin execute pg_temp.machine_shared_control_patched(
	'public.qorpera_member_machine_desktop_act_authority(uuid,text,text)'::regprocedure,
	array[$old$	if not coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
		or v_machine.desktop_member_user_id is distinct from v_act.user_id
		or v_machine.desktop_member_since is distinct from v_control.began_at or v_control.ended_at is not null
		or v_machine.desktop_member_generation is distinct from v_act.seat then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_CONTROL_ENDED'); end if;$old$,
	$new$	-- 20260930734000: a shared action runs only while no one holds the desktop privately and no one took it since it was
	-- begun (the lease generation it was begun at, its `seat`, stands); a private one only under its hold, as before.
	if v_act.shared then
		if coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
			or v_machine.desktop_member_generation is distinct from v_act.seat then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
	elsif not coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
		or v_machine.desktop_member_user_id is distinct from v_act.user_id
		or v_machine.desktop_member_since is distinct from v_control.began_at or v_control.ended_at is not null
		or v_machine.desktop_member_generation is distinct from v_act.seat then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_CONTROL_ENDED'); end if;$new$,
	$old$		'served', v_served);$old$,
	$new$		'served', v_served)
		-- 20260930734000: a shared action says so (the host's fence then names no member); a private one's answer is as before.
		|| case when v_act.shared then jsonb_build_object('shared', true) else '{}'::jsonb end;$new$]); end $$;

-- 4. The agent is told that a member touched the shared screen, until an answer that says so is ready ---------------------

do $$ begin execute pg_temp.machine_shared_control_patched(
	'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure,
	array[$old$	v_reads_root boolean;
$old$,
	$new$	v_reads_root boolean;
	v_touched jsonb; -- 20260930734000
$new$,
	$old$		values (v_placement.id, v_run.id, clock_timestamp()) on conflict do nothing;
	end if;
$old$,
	$new$		values (v_placement.id, v_run.id, clock_timestamp()) on conflict do nothing;
	end if;
	-- 20260930734000: a member acted on the shared desktop since an agent was last told: this answer says who and how
	-- long ago (never what), so the agent looks again before it acts on an older picture. The read marks nothing (review r1
	-- F4 of #1701): the executor marks it told with `at` once an answer that carries it is ready
	-- (qorpera_machine_desktop_shared_told), so a call refused or failed after this read tells it at the next.
	if v_machine.desktop_shared_at > coalesce(v_machine.desktop_shared_told_at, '-infinity'::timestamptz) then
		v_touched := jsonb_build_object('name', coalesce(nullif(btrim(public.qorpera_review_member_name(v_machine.profile_id,
				v_machine.desktop_shared_user_id)), ''), 'A member'),
			'secondsAgo', greatest(0, floor(extract(epoch from clock_timestamp() - v_machine.desktop_shared_at)))::integer,
			'at', v_machine.desktop_shared_at);
	end if;
$new$,
	$old$		'clipboardClear', v_machine.desktop_clipboard_generation is distinct from v_machine.desktop_member_generation);$old$,
	$new$		'clipboardClear', v_machine.desktop_clipboard_generation is distinct from v_machine.desktop_member_generation)
		|| case when v_touched is not null then jsonb_build_object('memberTouched', v_touched) else '{}'::jsonb end;$new$]); end $$;

-- 5. The computer window's list names the other members using the shared desktop ----------------------------------------------

do $$ begin execute pg_temp.machine_shared_control_patched(
	'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure,
	array[$old$						case when public.qorpera_company_at_zero(p_profile_id, clock_timestamp()) then 'hours' else 'room' end end)$old$,
	$new$						case when public.qorpera_company_at_zero(p_profile_id, clock_timestamp()) then 'hours' else 'room' end end)
					-- 20260930734000: the other members who acted on the shared desktop in the last 60 seconds, by name; one who has
					-- left the company since is not named (review r1 F3 of #1701).
					|| coalesce((select jsonb_build_object('others', jsonb_agg(named.name order by named.user_id))
						from (select recent.user_id, nullif(btrim(public.qorpera_review_member_name(p_profile_id, recent.user_id)), '')
								as name
							from (select distinct act.user_id from public.qorpera_company_machine_desktop_actions as act
								where act.machine_id = listed.id and act.shared and act.begun_at > clock_timestamp() - interval '60 seconds'
									and act.user_id is distinct from auth.uid()) as recent) as named
						where named.name is not null
						having count(*) > 0), '{}'::jsonb)$new$]); end $$;

-- 6. The agent was told: marked by the executor once an answer that carries memberTouched is ready ----------------------------

-- The executor's word (service role) that an answer to an agent's screen call carries the shared actions up to `at` (the
-- memberTouched SQL's read gave it): the machine's desktop_shared_told_at moves forward to `at`, never back, and never
-- past the newest shared action (a later one is told at the next call). Until then every screen read says it again
-- (review r1 F4 of #1701: a call refused or failed after the read never loses it).
create function public.qorpera_machine_desktop_shared_told(p_machine_id uuid, p_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930734000
	if auth.role() is distinct from 'service_role' or p_machine_id is null or p_at is null then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	update public.qorpera_company_machines set desktop_shared_told_at = p_at
	where id = p_machine_id and removed_at is null and p_at <= desktop_shared_at
		and coalesce(desktop_shared_told_at, '-infinity'::timestamptz) < p_at;
	return jsonb_build_object('schema', 'qorpera.machine-desktop-shared-told/v1', 'state', 'ok');
end
$$;
revoke all on function public.qorpera_machine_desktop_shared_told(uuid, timestamptz)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_machine_desktop_shared_told(uuid, timestamptz) to service_role;

-- 7. The deploy guard: every new or patched body carries the marker, and the patched ones keep theirs ------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)',
		'public.qorpera_member_machine_desktop_act_authority(uuid,text,text)',
		'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)',
		'public.qorpera_list_agent_machines(uuid,uuid)',
		'public.qorpera_machine_desktop_shared_told(uuid,timestamptz)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930734000') = 0 then
			raise exception '20260930734000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_desktop_act_authority(uuid,text,text)'::regprocedure), '20260930713000') = 0
		or exists (select 1 from unnest(array['20260930708000', '20260930712000', '20260930713000', 'F35 of #1661',
				'20260930730000']) marker
			where strpos((select prosrc from pg_proc
				where oid = 'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure), marker) = 0)
		or exists (select 1 from unnest(array['20260930712000', '20260930713000', '20260930730000']) marker
			where strpos((select prosrc from pg_proc
				where oid = 'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure), marker) = 0) then
		raise exception '20260930734000: a patched body lost its earlier marker'; end if;
end $guard$;

drop function pg_temp.machine_shared_control_patched(regprocedure, text[]);
