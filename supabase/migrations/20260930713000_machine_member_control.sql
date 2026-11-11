-- 20260930713000: a member takes over an agent's desktop computer in the web's computer window and hands it back (Jonas,
-- 10 November 2026: "Yes, build take-over"; lanes/desktop-computers-20261110/LIVE-VIEW-PLAN.md, stage 1b). The member's
-- clicks, drags, scrolls, keys and text go to the machine's desktop through the coding executor of its node and the
-- image's own screen helper, one action at a time, as an agent's machine_screen actions do. While a member holds the
-- desktop, the agent gets no picture of that machine and neither acts on it, starts a command there nor saves a coding
-- value off it; other members see who holds it, not the screen. What the member types is never sent here: SQL keeps its
-- length alone.
--
-- * Who holds a desktop: a lease on the machine (desktop_member_user_id, _since, _until and _input_at). It runs 5 minutes
--   from the member's last word (taking, an action, or the window's heartbeat every 60 seconds) and never past 30 minutes
--   after their last input (taking or an action); it ends at once when they hand it back. It ends by itself by time
--   alone: every check here compares _until with the clock, so no job ends it.
-- * qorpera_member_take_machine_desktop(profile, machine, attempt) (authenticated): an owner, admin or contributor of the
--   company; a machine of it big enough for a desktop (else DESKTOP_MACHINE_TOO_SMALL), running on its placement with a
--   known boot (else MACHINE_NOT_RUNNING), whose disk the member may see (MACHINE_NEEDS_COMPANY_VIEW, as for a look); held
--   by no other member now (else DESKTOP_MEMBER_IN_CONTROL with that member's name). The member's own lease is renewed.
--   `attempt` is a uuid the member's page makes for each take-over it asks, of version 7: its first 48 bits are the
--   milliseconds since the epoch it was made at; the lease remembers the attempt that made it (or took it again). An
--   attempt the member called off (below) is refused (TAKE_CALLED_OFF) whenever it arrives, and so is one whose time is
--   more than 2 minutes from the database's clock either way (TAKE_EXPIRED): both before it holds, renews or moves
--   anything (reviews r3 and r4 of #1661). So an attempt can take only within 2 minutes of its making.
-- * qorpera_member_keep_machine_desktop(profile, machine, attempt) (authenticated): the window's heartbeat; it renews the
--   member's own lease only when that attempt holds it, or says it ended.
-- * qorpera_member_hand_back_machine_desktop(profile, machine, reason, attempts) (authenticated): calls off every attempt
--   named (at most 32), for good, under the machine's lock, and gives back the member's lease when the attempt that holds
--   it is one of them ('handed_back', or 'closed' when their window closed or they left the company's page); no other
--   lease of theirs ends, so a hand-back that arrives late never ends a newer take-over's lease (review r4 F9). Its
--   answer is the confirmation that none of those attempts holds the machine or ever will, whatever the network did to
--   them, and says whether the member still holds it by an attempt it did not name (heldElsewhere: another tab of
--   theirs, or an earlier page). The called-off attempts are rows of qorpera_company_machine_desktop_called_off, kept an
--   hour and tidied by age alone by the hand-back itself; an attempt whose time is already outside the 2 minutes is
--   recorded by none (it can never take).
-- * qorpera_member_machine_desktop_act_begin(profile, machine, action) (authenticated; the node's executor makes it with
--   the member's own token): one action of the member who holds the desktop, of a closed shape per verb as an agent's
--   (qorpera_valid_machine_screen_call: positions in screen pixels, no key an xdotool command word) but never `open`, and
--   a typed text by its length alone (qorpera_valid_member_desktop_action). It records the action without any text,
--   renews the lease, moves the machine's last use (at most every 30 seconds: a member at the desktop is a use) and marks a
--   disk that never had a view when the member does not read the folder's root, as an agent's action does. It answers a
--   single-use action id, nothing else.
-- * qorpera_member_machine_desktop_act_authority(action, owner, provider), the executor's read (service_role): the
--   action, begun in the last 15 seconds and not served, of a member who still may take over and still holds the desktop
--   under the same lease; everything above checked again live; where the machine runs, and the action as recorded. It is
--   served only by the machine's own executor, once, which runs the helper with the action id as its receipt.
-- * Each lease is a row of qorpera_company_machine_desktop_controls (begun, ended and how, how many actions) and each
--   action one of qorpera_company_machine_desktop_actions (the verb, its positions, key names and a text's length). Both
--   are the company's record of who drove its computer: they go with the machine, not with a member's account.
-- * The agent's reads refuse while a member holds the desktop (DESKTOP_MEMBER_IN_CONTROL): qorpera_authorize_machine_screen
--   (a look and an action), the start of a new command in qorpera_authorize_machine_command (a start sent again of a
--   command that started before goes on, as do reads and cancels), and qorpera_authorize_machine_coding_value.
-- * Another member's look is refused while one member holds the desktop (DESKTOP_MEMBER_IN_CONTROL), at the begin and at
--   the executor's read; the member who holds it keeps looking.
-- * Every picture is fenced by the lease's generation (review r1 F1): desktop_member_generation moves in the statement
--   that begins a lease and in the one that gives it back. Both look reads (the agent's qorpera_authorize_machine_screen,
--   a member's qorpera_member_machine_screen_authority) answer the generation they saw, and after the capture, before any
--   picture or title leaves, the executor asks qorpera_machine_desktop_picture_check (service_role): the same generation,
--   and no live hold by anyone but the one who looks. Otherwise the picture is dropped, so a look authorized before a
--   take-over never shows what the member did after it, however the steps interleave.
-- * The member's list (qorpera_list_agent_machines) says whether they may take over (canTakeOver) and, per machine, who
--   holds its desktop (control: null, or {mine, name, until, attempt}: the attempt that holds it, to its own member
--   alone), and the database's time (serverNow), by which the page makes its attempts' times; the `machines` hint also
--   goes when a lease begins or ends by a word (never on an action's renewal).
-- Every new or patched body names this migration (20260930713000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_take_machine_desktop(uuid,uuid,uuid)') is not null then
		raise exception '20260930713000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)') is null
		or to_regprocedure('public.qorpera_review_member_name(uuid,uuid)') is null then
		raise exception '20260930713000 needs the members'' looks (20260930712000) and save_coding_value (20260930705000)'; end if;
end $$;

-- The columns, the tables and the trigger lock the machines: never queue behind a long transaction.
set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_member_control_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930713000' in v_definition) > 0 then
		raise exception '20260930713000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930713000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930713000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. Who holds a desktop, and the record of it ----------------------------------------------------------------------------

-- The member who holds the machine's desktop: since when, until when (5 minutes from their last word, never more than 30
-- minutes from their last input) and their last input. A lease whose _until has passed holds nothing.
alter table public.qorpera_company_machines
	add column desktop_member_user_id uuid,
	add column desktop_member_since timestamptz,
	add column desktop_member_until timestamptz,
	add column desktop_member_input_at timestamptz,
	-- The take-over attempt (the member's page's uuid) that made the lease or took it again last (review r3): only it
	-- renews the lease, and the member's own list says which it is.
	add column desktop_member_attempt_id uuid,
	-- Moves when a lease begins and when one is given back (review r1 F1): a picture is let out only when it has not moved
	-- since its look was authorized.
	add column desktop_member_generation bigint not null default 0;

-- One row per lease: who, when it began and ended, and how ('handed_back' by the member's word, 'closed' with their window
-- or page, 'lapsed' when the window's heartbeat stopped, 'idle' after 30 minutes without input), and how many actions.
-- A lease that ended by time is closed here when the next one begins or the member hands back.
create table public.qorpera_company_machine_desktop_controls (
	id uuid primary key default pg_catalog.gen_random_uuid(),
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null,
	began_at timestamptz not null,
	ended_at timestamptz,
	ended_by text check (ended_by in ('handed_back', 'closed', 'lapsed', 'idle')),
	actions bigint not null default 0 check (actions >= 0),
	check ((ended_at is null) = (ended_by is null)),
	unique (machine_id, began_at)
);
alter table public.qorpera_company_machine_desktop_controls enable row level security;
revoke all on public.qorpera_company_machine_desktop_controls from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One row per member action, its id the helper's receipt: the action as qorpera_valid_member_desktop_action takes it (a
-- typed text by its length alone), when it was begun and when its executor took it. Never a text, never a picture.
create table public.qorpera_company_machine_desktop_actions (
	id uuid primary key,
	control_id uuid not null references public.qorpera_company_machine_desktop_controls(id) on delete cascade,
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	user_id uuid not null,
	action jsonb not null check (jsonb_typeof(action) = 'object' and not action ? 'text' and action ->> 'type' <> 'open'),
	begun_at timestamptz not null,
	served_at timestamptz
);
create index qorpera_company_machine_desktop_actions_control on public.qorpera_company_machine_desktop_actions (control_id);
create index qorpera_company_machine_desktop_actions_machine on public.qorpera_company_machine_desktop_actions (machine_id);
alter table public.qorpera_company_machine_desktop_actions enable row level security;
revoke all on public.qorpera_company_machine_desktop_actions from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The take-over attempts a member called off on a machine (reviews r3 and r4 of #1661): a take naming one is refused
-- whenever it arrives. Written and tidied only by the hand-back, under the machine's lock, by age alone: a row goes after
-- an hour, long after its attempt expired (an attempt takes only within 2 minutes of its time, and only attempts within
-- those 2 minutes are written). Bounded by that hour and by 32 rows a call: the worst case is a member who hands back 32
-- fresh attempts in every call, which leaves at most 32 rows per hand-back of the last hour (the machine's lock lets
-- one hand-back of a machine run at a time).
create table public.qorpera_company_machine_desktop_called_off (
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	user_id uuid not null,
	attempt_id uuid not null,
	called_off_at timestamptz not null,
	primary key (machine_id, user_id, attempt_id)
);
alter table public.qorpera_company_machine_desktop_called_off enable row level security;
revoke all on public.qorpera_company_machine_desktop_called_off from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. A member's action, as SQL takes it -----------------------------------------------------------------------------------

-- One of an agent's machine_screen actions (qorpera_valid_machine_screen_call checks each verb's shape: positions in
-- whole screen pixels, keys that are no xdotool command word in any case, a scroll's direction and steps), except that
-- `open` is never a member's, and a `type` carries its text's length (1 to 500 characters) instead of the text:
-- {type: type, length}. It reads no table; STABLE as the other call checks.
create function public.qorpera_valid_member_desktop_action(p_action jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
begin
	-- 20260930713000
	if jsonb_typeof(p_action) is distinct from 'object' or jsonb_typeof(p_action -> 'type') is distinct from 'string'
		or p_action ->> 'type' not in ('click', 'double', 'move', 'drag', 'type', 'key', 'scroll') or p_action ? 'text' then
		return false; end if;
	if p_action ->> 'type' = 'type' then
		return p_action - array['type', 'length'] = '{}'::jsonb and jsonb_typeof(p_action -> 'length') = 'number'
			and (p_action ->> 'length')::numeric between 1 and 500
			and (p_action ->> 'length')::numeric = trunc((p_action ->> 'length')::numeric);
	end if;
	return coalesce(public.qorpera_valid_machine_screen_call(jsonb_build_object('operationKey', 'member', 'machine', 'member',
		'action', p_action, 'intent', 'A member''s own action.')), false);
end
$$;
revoke all on function public.qorpera_valid_member_desktop_action(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. Take, keep and hand back --------------------------------------------------------------------------------------------

-- The machine is locked as a member's look locks it (FOR NO KEY UPDATE): the agent's screen read (FOR UPDATE) waits for
-- it and it for that, so an agent's look or action is authorized either before the lease or not at all.
create function public.qorpera_member_take_machine_desktop(p_profile_id uuid, p_machine_id uuid, p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_attempt_id is null or substr(p_attempt_id::text, 15, 1) <> '7' then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) or public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- An attempt the member called off holds nothing, whenever it arrives (review r3): the hand-back that named it writes
	-- its row under this same lock, so the two are ordered, and nothing below runs for it.
	if exists (select 1 from public.qorpera_company_machine_desktop_called_off as called_off
		where called_off.machine_id = v_machine.id and called_off.user_id = v_user and called_off.attempt_id = p_attempt_id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'refused',
			'reason', 'TAKE_CALLED_OFF'); end if;
	-- Nor one made more than 2 minutes from now either way (review r4 F5): an attempt takes only within 2 minutes of its
	-- time, whatever became of its call-off record.
	if abs(('x' || substr(replace(p_attempt_id::text, '-', ''), 1, 12))::bit(48)::bigint
			- (extract(epoch from v_now) * 1000)::bigint) > 120000 then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'refused',
			'reason', 'TAKE_EXPIRED'); end if;
	-- deploy/machine/desktop: MIN_CPUS 2, MIN_MEMORY_KB 4 GiB.
	if v_machine.cpus < 2 or v_machine.memory_bytes < 4294967296 then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'refused',
			'reason', 'DESKTOP_MACHINE_TOO_SMALL'); end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	if not coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', v_user, 'read'), false)
		and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	if coalesce(v_machine.desktop_member_until > v_now, false) then
		if v_machine.desktop_member_user_id is distinct from v_user then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL',
				'memberName', public.qorpera_review_member_name(v_machine.profile_id, v_machine.desktop_member_user_id)); end if;
		-- Their own lease: taking again is an input, and the lease is this attempt's from now on (the newest take-over of
		-- theirs renews it).
		update public.qorpera_company_machines set desktop_member_input_at = v_now,
			desktop_member_until = v_now + interval '5 minutes', desktop_member_attempt_id = p_attempt_id
		where id = v_machine.id;
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok',
			'until', v_now + interval '5 minutes');
	end if;
	-- A lease that ended by time is closed now: its heartbeat stopped, or 30 minutes passed without input.
	if v_machine.desktop_member_user_id is not null then
		update public.qorpera_company_machine_desktop_controls set ended_at = v_machine.desktop_member_until,
			ended_by = case when v_machine.desktop_member_until >= v_machine.desktop_member_input_at + interval '30 minutes'
				then 'idle' else 'lapsed' end
		where machine_id = v_machine.id and began_at = v_machine.desktop_member_since and ended_at is null;
	end if;
	insert into public.qorpera_company_machine_desktop_controls(machine_id, profile_id, user_id, began_at)
	values (v_machine.id, v_machine.profile_id, v_user, v_now);
	-- A member at the desktop uses the machine: its last use moves, at most every 30 seconds.
	update public.qorpera_company_machines set desktop_member_user_id = v_user, desktop_member_since = v_now,
		desktop_member_until = v_now + interval '5 minutes', desktop_member_input_at = v_now,
		desktop_member_attempt_id = p_attempt_id, desktop_member_generation = desktop_member_generation + 1,
		last_used_at = case when last_used_at < v_now - interval '30 seconds' then v_now else last_used_at end
	where id = v_machine.id;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok',
		'until', v_now + interval '5 minutes');
end
$$;
revoke all on function public.qorpera_member_take_machine_desktop(uuid, uuid, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_take_machine_desktop(uuid, uuid, uuid) to authenticated;

-- The window's heartbeat: the member's own lease, renewed 5 minutes from now and never past 30 minutes after their last
-- input, only when the attempt named made it or took it again last (a stale window renews neither another's lease nor a
-- newer one); `ended` when it holds it no more (handed back, lapsed, idle, taken again by a newer attempt, or another
-- member's now).
create function public.qorpera_member_keep_machine_desktop(p_profile_id uuid, p_machine_id uuid, p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_now timestamptz := clock_timestamp();
	v_until timestamptz;
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_attempt_id is null then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	v_until := least(v_now + interval '5 minutes', v_machine.desktop_member_input_at + interval '30 minutes');
	if v_machine.desktop_member_user_id is distinct from v_user or v_machine.desktop_member_attempt_id is distinct from p_attempt_id
		or not coalesce(v_machine.desktop_member_until > v_now, false) or not coalesce(v_until > v_now, false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ended'); end if;
	update public.qorpera_company_machines set desktop_member_until = v_until where id = v_machine.id;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok', 'until', v_until);
end
$$;
revoke all on function public.qorpera_member_keep_machine_desktop(uuid, uuid, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_keep_machine_desktop(uuid, uuid, uuid) to authenticated;

-- Every take-over attempt named is called off for good (review r3), whatever it did or will do: one that holds the
-- member's lease gives it back here ('handed_back': their word or their take-over card's "I'm done"; 'closed': their
-- window closed or they left the company's page; a lease that already ended by time is closed as it ended), one still on
-- its way is refused when it arrives. Only a lease held by an attempt named ends (review r4 F9): a hand-back that comes
-- late never ends a newer take-over's lease. So the answer confirms that none of those attempts holds the machine or
-- ever will, and says whether the member still holds it by an attempt it did not name (heldElsewhere). Any member gives
-- back only their own; naming an attempt again answers the same.
create function public.qorpera_member_hand_back_machine_desktop(p_profile_id uuid, p_machine_id uuid, p_reason text,
	p_attempt_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_now timestamptz := clock_timestamp();
	v_live boolean;
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_reason is null or p_reason not in ('handed_back', 'closed') or p_attempt_ids is null
		or coalesce(array_ndims(p_attempt_ids), 1) <> 1 or coalesce(cardinality(p_attempt_ids), 0) > 32
		or array_position(p_attempt_ids, null) is not null then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- The attempts named that could still take (version 7, made within 2 minutes of now either way) are called off under
	-- the machine's lock; one outside those 2 minutes never takes, so nothing is written for it. The member's rows for the
	-- machine an hour old go, by age alone.
	insert into public.qorpera_company_machine_desktop_called_off(machine_id, user_id, attempt_id, called_off_at)
	select v_machine.id, v_user, named.attempt, v_now from (select distinct attempt from unnest(p_attempt_ids) as attempt) as named
	where substr(named.attempt::text, 15, 1) = '7'
		and abs(('x' || substr(replace(named.attempt::text, '-', ''), 1, 12))::bit(48)::bigint
			- (extract(epoch from v_now) * 1000)::bigint) <= 120000
	on conflict (machine_id, user_id, attempt_id) do nothing;
	delete from public.qorpera_company_machine_desktop_called_off as called_off
	where called_off.machine_id = v_machine.id and called_off.user_id = v_user
		and called_off.called_off_at < v_now - interval '1 hour';
	v_live := coalesce(v_machine.desktop_member_until > v_now, false);
	if v_machine.desktop_member_user_id is distinct from v_user then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok', 'handedBack', false,
			'heldElsewhere', false); end if;
	-- Held by an attempt this hand-back does not name: it stays (review r4 F9).
	if not coalesce(v_machine.desktop_member_attempt_id = any(p_attempt_ids), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok', 'handedBack', false,
			'heldElsewhere', v_live); end if;
	update public.qorpera_company_machine_desktop_controls
	set ended_at = case when v_live then v_now else v_machine.desktop_member_until end,
		ended_by = case when v_live then p_reason
			when v_machine.desktop_member_until >= v_machine.desktop_member_input_at + interval '30 minutes' then 'idle'
			else 'lapsed' end
	where machine_id = v_machine.id and began_at = v_machine.desktop_member_since and ended_at is null;
	update public.qorpera_company_machines set desktop_member_user_id = null, desktop_member_since = null,
		desktop_member_until = null, desktop_member_input_at = null, desktop_member_attempt_id = null,
		desktop_member_generation = desktop_member_generation + 1
	where id = v_machine.id;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok', 'handedBack', v_live,
		'heldElsewhere', false);
end
$$;
revoke all on function public.qorpera_member_hand_back_machine_desktop(uuid, uuid, text, uuid[])
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_hand_back_machine_desktop(uuid, uuid, text, uuid[]) to authenticated;

-- 4. A member's action: begun as the member ------------------------------------------------------------------------------

-- The executor sends the member's action here without its text (a `type` by its length), as the member, before it runs
-- anything; it compares the action this answers it later (the authority below) with the one it holds.
create function public.qorpera_member_machine_desktop_act_begin(p_profile_id uuid, p_machine_id uuid, p_action jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_reads_root boolean;
	v_control uuid;
	v_action uuid := pg_catalog.gen_random_uuid();
	v_now timestamptz := clock_timestamp();
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or not coalesce(public.qorpera_valid_member_desktop_action(p_action), false) then
		raise exception 'Machine desktop action is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) or public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
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
	if not coalesce(v_machine.desktop_member_until > v_now, false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'DESKTOP_CONTROL_ENDED'); end if;
	if v_machine.desktop_member_user_id is distinct from v_user then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
	update public.qorpera_company_machine_desktop_controls set actions = actions + 1
	where machine_id = v_machine.id and began_at = v_machine.desktop_member_since and ended_at is null
	returning id into v_control;
	if v_control is null then
		raise exception 'Machine desktop lease is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, begun_at)
	values (v_action, v_control, v_machine.id, v_user, p_action, v_now);
	-- The member's input renews the lease; their use moves the machine's last use, at most every 30 seconds.
	update public.qorpera_company_machines set desktop_member_input_at = v_now,
		desktop_member_until = v_now + interval '5 minutes',
		last_used_at = case when last_used_at < v_now - interval '30 seconds' then v_now else last_used_at end
	where id = v_machine.id;
	-- An action of a member who does not read the root, on a disk that never had a view, marks it as an agent's does
	-- (20260930424000): what it did there was not checked, so no view opens on that disk after.
	if not v_reads_root then
		update public.qorpera_company_machine_placements set folder_unchecked_at = v_now
		where id = v_placement.id and folder_unchecked_at is null
			and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
	end if;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'ok', 'actionId', v_action);
end
$$;
revoke all on function public.qorpera_member_machine_desktop_act_begin(uuid, uuid, jsonb)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_act_begin(uuid, uuid, jsonb) to authenticated;

-- 5. The executor's read of a member's action ----------------------------------------------------------------------------

-- Everything the begin checked, again and live, under the machine's lock: the action begun within 15 seconds and not
-- served, its member still an owner, admin or contributor of a company not being deleted, and still holding the desktop
-- under the lease the action was begun in. Served by the placement's own executor only, once. The disk's mark is decided
-- again here, as the action is let run (a root read taken away since the begin).
create function public.qorpera_member_machine_desktop_act_authority(p_action_id uuid, p_owner text, p_provider_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_act public.qorpera_company_machine_desktop_actions%rowtype;
	v_control public.qorpera_company_machine_desktop_controls%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_reads_root boolean;
	v_served boolean;
begin
	-- 20260930713000
	if auth.role() is distinct from 'service_role' or p_action_id is null
		or coalesce(p_owner !~ '^[A-Za-z0-9_.:-]{1,120}$', true) or coalesce(p_provider_id !~ '^[a-z][a-z0-9_-]{0,63}$', true) then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	select act.* into v_act from public.qorpera_company_machine_desktop_actions as act where act.id = p_action_id;
	if not found then
		raise exception 'Machine desktop action is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = v_act.machine_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop action is unavailable' using errcode = '42501'; end if;
	-- Read again under the machine's lock: a second executor's read of the same action takes the lock first.
	select act.* into v_act from public.qorpera_company_machine_desktop_actions as act where act.id = p_action_id;
	select control.* into v_control from public.qorpera_company_machine_desktop_controls as control where control.id = v_act.control_id;
	if v_act.served_at is not null or v_act.begun_at < clock_timestamp() - interval '15 seconds'
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_machine.profile_id and member.user_id = v_act.user_id
				and member.role::text in ('owner', 'admin', 'contributor'))
		or public.qorpera_company_deleting(v_machine.profile_id) then
		raise exception 'Machine desktop action is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	v_reads_root := coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', v_act.user_id,
		'read'), false);
	if not v_reads_root and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	if not coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
		or v_machine.desktop_member_user_id is distinct from v_act.user_id
		or v_machine.desktop_member_since is distinct from v_control.began_at or v_control.ended_at is not null then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_CONTROL_ENDED'); end if;
	-- The action runs: a member who does not read the root now (it may have been taken away since the begin, which marked
	-- nothing then) marks a disk that never had a view, under this lock, as the begin does (review r1 F2).
	if not v_reads_root then
		update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp()
		where id = v_placement.id and folder_unchecked_at is null
			and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
	end if;
	v_served := v_placement.owner = p_owner and v_placement.binding ->> 'providerId' = p_provider_id;
	if v_served then
		update public.qorpera_company_machine_desktop_actions set served_at = clock_timestamp() where id = v_act.id;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.member-machine-desktop-act-authority/v1',
		'state', 'authorized',
		'actionId', v_act.id,
		'machineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'executorOwner', v_placement.owner,
		'providerId', v_placement.binding ->> 'providerId',
		'userId', v_act.user_id,
		'action', v_act.action,
		'served', v_served);
end
$$;
revoke all on function public.qorpera_member_machine_desktop_act_authority(uuid, text, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_act_authority(uuid, text, text) to service_role;

-- 5b. The fence after a capture (review r1 F1) -------------------------------------------------------------------------------

-- Asked by the executor after a look's capture and before its picture or titles leave: the placement's machine, not
-- removed, still at the lease generation the look's read answered, and held live by no one, or by the member who looks
-- (p_user_id; null for an agent's look, which no hold lets through). Any lease begun or given back since the read moved
-- the generation, so what the picture may show of a member's input after it never leaves. Plain reads; writes nothing.
create function public.qorpera_machine_desktop_picture_check(p_placement_id uuid, p_generation bigint, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_machine public.qorpera_company_machines%rowtype;
begin
	-- 20260930713000
	if auth.role() is distinct from 'service_role' or p_placement_id is null or p_generation is null or p_generation < 0 then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = (select placement.machine_id from public.qorpera_company_machine_placements as placement
		where placement.id = p_placement_id) and machine.removed_at is null;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	if v_machine.desktop_member_generation is distinct from p_generation
		or (coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
			and v_machine.desktop_member_user_id is distinct from p_user_id) then
		return jsonb_build_object('schema', 'qorpera.machine-desktop-picture/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
	return jsonb_build_object('schema', 'qorpera.machine-desktop-picture/v1', 'state', 'ok');
end
$$;
revoke all on function public.qorpera_machine_desktop_picture_check(uuid, bigint, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_machine_desktop_picture_check(uuid, bigint, uuid) to service_role;

-- 6. While a member holds the desktop, the agent waits -------------------------------------------------------------------

-- The agent's screen read: no look and no action (no picture of that machine reaches an agent), and the lease generation
-- it saw, which the executor's fence after the capture checks (review r1 F1).
do $$ begin execute pg_temp.machine_member_control_patched('public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure,
	array[$old$		return jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', v_machine.name); end if;$old$,
	$new$		return jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', v_machine.name); end if;
	-- 20260930713000: a member holds the desktop: the agent neither sees nor drives it until they hand it back.
	if coalesce(v_machine.desktop_member_until > clock_timestamp(), false) then
		return jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL', 'machine', v_machine.name); end if;$new$,
	$old$		'look', case when v_args is null then null else coalesce((v_args ->> 'look')::boolean, true) end);$old$,
	$new$		'look', case when v_args is null then null else coalesce((v_args ->> 'look')::boolean, true) end,
		-- 20260930713000: the lease generation this read saw; the picture leaves only while it stands.
		'desktopGeneration', v_machine.desktop_member_generation);$new$]); end $$;

-- The command read: no new command starts. A start sent again of a command that started before goes on (its guest has
-- it, or has not: the executor's send again is the same command), and so do reads and cancels.
do $$ begin execute pg_temp.machine_member_control_patched('public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	array[$old$		return jsonb_build_object('schema','qorpera.machine-command-authority/v1','state','refused','reason','MACHINE_NOT_RUNNING',
			'machine',v_machine.name,'machineState',public.qorpera_company_machine_state(v_machine)); end if;$old$,
	$new$		return jsonb_build_object('schema','qorpera.machine-command-authority/v1','state','refused','reason','MACHINE_NOT_RUNNING',
			'machine',v_machine.name,'machineState',public.qorpera_company_machine_state(v_machine)); end if;
	-- 20260930713000: a member holds the desktop: no new command starts on the machine until they hand it back.
	if p_action = 'start' and coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
		and not exists (select 1 from public.qorpera_company_machine_commands c where c.id = p_command_id) then
		return jsonb_build_object('schema','qorpera.machine-command-authority/v1','state','refused','reason','DESKTOP_MEMBER_IN_CONTROL',
			'machine',v_machine.name,'machineState',public.qorpera_company_machine_state(v_machine)); end if;$new$]); end $$;

-- The coding value read: nothing is read off the clipboard of a desktop a member holds.
do $$ begin execute pg_temp.machine_member_control_patched('public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)'::regprocedure,
	array[$old$		return jsonb_build_object('schema', 'qorpera.machine-coding-value-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', v_machine.name); end if;$old$,
	$new$		return jsonb_build_object('schema', 'qorpera.machine-coding-value-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', v_machine.name); end if;
	-- 20260930713000: a member holds the desktop: nothing is read off its clipboard until they hand it back.
	if coalesce(v_machine.desktop_member_until > clock_timestamp(), false) then
		return jsonb_build_object('schema', 'qorpera.machine-coding-value-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL', 'machine', v_machine.name); end if;$new$]); end $$;

-- 7. While a member holds the desktop, other members see who, not the screen ---------------------------------------------

do $$ begin execute pg_temp.machine_member_control_patched('public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)'::regprocedure,
	array[$old$		return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;$old$,
	$new$		return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	-- 20260930713000: another member holds the desktop: the screen is theirs alone until they hand it back.
	if coalesce(v_machine.desktop_member_until > v_now, false) and v_machine.desktop_member_user_id is distinct from v_user then
		return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;$new$]); end $$;

do $$ begin execute pg_temp.machine_member_control_patched('public.qorpera_member_machine_screen_authority(uuid,text,text)'::regprocedure,
	array[$old$		'keepDesktop', coalesce(v_watch.confirmed_at > clock_timestamp() - interval '30 minutes', false));$old$,
	$new$		'keepDesktop', coalesce(v_watch.confirmed_at > clock_timestamp() - interval '30 minutes', false),
		-- 20260930713000: the lease generation this read saw; the picture leaves only while it stands (review r1 F1).
		'desktopGeneration', v_machine.desktop_member_generation);$new$,
	$old$		return jsonb_build_object('schema', 'qorpera.member-machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;$old$,
	$new$		return jsonb_build_object('schema', 'qorpera.member-machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	-- 20260930713000: another member took the desktop since the begin.
	if coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
		and v_machine.desktop_member_user_id is distinct from v_watch.user_id then
		return jsonb_build_object('schema', 'qorpera.member-machine-screen-authority/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;$new$]); end $$;

-- The list: whether the member may take over, and who holds each machine's desktop now.
do $$ begin execute pg_temp.machine_member_control_patched('public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure,
	array[$old$		'canWake', public.qorpera_can_write_profile(p_profile_id),$old$,
	$new$		'canWake', public.qorpera_can_write_profile(p_profile_id),
		-- 20260930713000: owners, admins and contributors take over a desktop; viewers watch. The database's time: the page
		-- makes its take-over attempts' times by it (review r4).
		'canTakeOver', public.qorpera_can_write_profile(p_profile_id),
		'serverNow', clock_timestamp(),$new$,
	$old$					'waitingFor', case when listed.state = 'waiting' then$old$,
	$new$					-- 20260930713000: who holds the desktop now, by name, and until when (null: no one).
					'control', case when listed.desktop_member_until > clock_timestamp() then jsonb_build_object(
						'mine', listed.desktop_member_user_id = auth.uid(),
						'name', public.qorpera_review_member_name(p_profile_id, listed.desktop_member_user_id),
						'until', listed.desktop_member_until)
						-- The take-over attempt that holds it, to the member who holds it alone (review r3).
						|| case when listed.desktop_member_user_id = auth.uid()
							then jsonb_build_object('attempt', listed.desktop_member_attempt_id) else '{}'::jsonb end end,
					'waitingFor', case when listed.state = 'waiting' then$new$]); end $$;

-- 8. The `machines` hint, when a lease begins or ends by a word ----------------------------------------------------------

-- As 20260930712000's, and when the member who holds the desktop changes or a new lease begins (an action's renewal
-- moves only _until and _input_at, which send none; a lease that ends by time sends none either: the window that shows it
-- reads the list again at its end).
drop trigger qorpera_machine_hint_change on public.qorpera_company_machines;
create constraint trigger qorpera_machine_hint_change
	after update of desired_state, removed_at, last_error, screen_staff_agent_id, screen_used_at, desktop_member_user_id,
		desktop_member_since on public.qorpera_company_machines
	deferrable initially deferred for each row
	when (old.desired_state is distinct from new.desired_state or old.removed_at is distinct from new.removed_at
		or old.last_error is distinct from new.last_error or old.screen_staff_agent_id is distinct from new.screen_staff_agent_id
		or (new.screen_used_at is not null
			and (old.screen_used_at is null or old.screen_used_at < new.screen_used_at - interval '10 minutes'))
		or old.desktop_member_user_id is distinct from new.desktop_member_user_id
		or old.desktop_member_since is distinct from new.desktop_member_since)
	execute function public.qorpera_machine_hint();

-- 9. The deploy guard: every new or patched body carries the marker -----------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_valid_member_desktop_action(jsonb)',
		'public.qorpera_member_take_machine_desktop(uuid,uuid,uuid)',
		'public.qorpera_member_keep_machine_desktop(uuid,uuid,uuid)',
		'public.qorpera_member_hand_back_machine_desktop(uuid,uuid,text,uuid[])',
		'public.qorpera_member_machine_desktop_act_begin(uuid,uuid,jsonb)',
		'public.qorpera_member_machine_desktop_act_authority(uuid,text,text)',
		'public.qorpera_machine_desktop_picture_check(uuid,bigint,uuid)',
		'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)',
		'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)',
		'public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)',
		'public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)',
		'public.qorpera_member_machine_screen_authority(uuid,text,text)',
		'public.qorpera_list_agent_machines(uuid,uuid)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930713000') = 0 then
			raise exception '20260930713000 marker is missing in %', v_function; end if;
	end loop;
	-- The patched bodies keep the markers they had.
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure),
			'20260930712000') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)'::regprocedure),
			'20260930705000') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure),
			'20260930712000') = 0 then
		raise exception '20260930713000: a patched body lost an earlier marker'; end if;
	if (select provolatile from pg_proc where oid = 'public.qorpera_valid_member_desktop_action(jsonb)'::regprocedure) <> 's' then
		raise exception '20260930713000: the action check is not STABLE'; end if;
end $guard$;

drop function pg_temp.machine_member_control_patched(regprocedure, text[]);
