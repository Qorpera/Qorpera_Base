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
-- * qorpera_member_take_machine_desktop(profile, machine, epoch, press) (authenticated): an owner, admin or contributor
--   of the company; a machine of it big enough for a desktop (else DESKTOP_MACHINE_TOO_SMALL), running on its placement
--   with a known boot (else MACHINE_NOT_RUNNING), whose disk the member may see (MACHINE_NEEDS_COMPANY_VIEW, as for a
--   look); held by no other member now (else DESKTOP_MEMBER_IN_CONTROL with that member's name). The member's own lease
--   is renewed. `epoch` is the member's hand-back epoch for the machine as their page knows it (review r5 of #1661): a
--   counter only the database moves, one per member and machine (qorpera_company_machine_desktop_epochs; 0 while there
--   is no row). A take-over is accepted only at the current epoch, under the machine's lock; at any other it is refused
--   (TAKE_CALLED_OFF, with the current epoch) before it holds, renews, moves or records anything. The lease remembers
--   the epoch it was taken under.
-- * Every seating of a member on a desktop gets a seat (release review r1 of #1667, F26 of #1661): the lease generation
--   (desktop_member_generation), which moves at a take-over that starts a lease (after one ran out too), at one that
--   takes the member's own live lease over from another press (another tab, a page loaded again, a late copy of a
--   press), and at a hand-back that ends a lease. The take-over answers it. The epoch orders take-overs against
--   hand-backs; the seat names a hold: two holds of one member can live under one epoch (after a lease ran out and was
--   taken again, or another tab took the member's own lease over), and everything a page does as holder names both.
--   `press` is an id the page mints for each take-over request: the lease remembers the press that seated it, and the
--   list shows it to the caller beside their hold's seat, so a page whose take-over answer was lost knows the hold is
--   its own press's; it is for recognition only, never authority. A late copy of an old press is refused by the epoch,
--   or seats anew with a new seat (the page's hold of another seat then ends at its next heartbeat).
-- * qorpera_member_keep_machine_desktop(profile, machine, epoch, seat) (authenticated): the window's heartbeat; it
--   renews the member's own lease only when it was taken under that epoch and is that seat, or says it ended.
-- * qorpera_member_hand_back_machine_desktop(profile, machine, reason, epoch, seat, press) (authenticated): under the
--   machine's lock it gives back the member's lease taken under `epoch` that is the hold named, by its seat or, for a
--   take-over whose answer was lost, by its press ('handed_back', or 'closed' when their window closed or they left the
--   company's page). The epoch moves on by one when `epoch` is the current one and no live lease of the member's is
--   left that this hand-back did not name (F26): a stale tab's hand-back never ends another tab's live hold of the
--   member's, and an epoch above e still means that nothing taken under e or earlier holds the desktop, and nothing
--   sent under e or earlier ever can, whenever it arrives: no clock is read for any of it. At an older epoch nothing
--   moves. It answers the current epoch, whether the member holds the machine now and, if so, that hold's seat.
-- * qorpera_member_machine_desktop_act_begin(profile, machine, action, epoch, seat) (authenticated; the node's executor
--   makes it with the member's own token): one action of the member who holds the desktop, of a closed shape per verb
--   as an agent's (qorpera_valid_machine_screen_call: positions in screen pixels, no key an xdotool command word) but
--   never `open`, and a typed text by its length alone (qorpera_valid_member_desktop_action). `epoch` and `seat` name
--   the hold the member's page captured the input under (release review r1 of #1667, F24 and F26 of #1661): under the
--   machine's lock the action is taken only from the member whose live lease was taken under exactly that epoch and is
--   exactly that seat; otherwise that hold has ended (DESKTOP_CONTROL_ENDED) and nothing is recorded, so input delayed
--   across a hand-back and a new take-over, a lease that ran out and was taken again, or another tab's take-over never
--   runs under the new hold. It records the action without any text, renews the lease, moves the machine's last use (at
--   most every 30 seconds: a member at the desktop is a use) and marks a disk that never had a view when the member
--   does not read the folder's root, as an agent's action does. It answers a single-use action id, nothing else.
-- * qorpera_member_machine_desktop_act_authority(action, owner, provider), the executor's read (service_role): the
--   action, begun in the last 15 seconds and not served, of a member who still may take over and still holds the
--   desktop under the same seat (the seat the begin recorded, and the lease row it counted the action on, not ended: a
--   hand-back, a new take-over, or another press's take-over of the same lease between the begin and this read moves
--   the seat, so the action is refused); everything above checked again live under the machine's lock; where the
--   machine runs, and the action as recorded. It is served only by the machine's own executor, once, which runs the
--   helper with the action id as its receipt.
-- * Each lease is a row of qorpera_company_machine_desktop_controls (begun, ended and how, how many actions) and each
--   action one of qorpera_company_machine_desktop_actions (the verb, its positions, key names and a text's length). Both
--   are the company's record of who drove its computer: they go with the machine, not with a member's account.
-- * The agent's reads refuse while a member holds the desktop (DESKTOP_MEMBER_IN_CONTROL): qorpera_authorize_machine_screen
--   (a look and an action), the start of a new command in qorpera_authorize_machine_command (a start sent again of a
--   command that started before goes on, as do reads and cancels), and qorpera_authorize_machine_coding_value.
-- * Another member's look is refused while one member holds the desktop (DESKTOP_MEMBER_IN_CONTROL), at the begin and at
--   the executor's read; the member who holds it keeps looking.
-- * Every picture is fenced by the lease's generation (review r1 F1): desktop_member_generation moves in the statement
--   that begins a lease, in one that seats the member anew on their own live lease (F26: it is the seat), and in the
--   one that gives a lease back. Both look reads (the agent's qorpera_authorize_machine_screen, a member's
--   qorpera_member_machine_screen_authority) answer the generation they saw, and after the capture, before any picture
--   or title leaves, the executor asks qorpera_machine_desktop_picture_check (service_role): the same generation, and
--   no live hold by anyone but the one who looks. Otherwise the picture is dropped, so a look authorized before a
--   take-over never shows what the member did after it, however the steps interleave.
-- * The member's list (qorpera_list_agent_machines) says whether they may take over (canTakeOver) and, per machine, who
--   holds its desktop (control: null, or {mine, name, until}, and for the caller's own hold the epoch it was taken
--   under, its seat and the press that seated it), and the caller's own current hand-back epoch per machine (epoch);
--   the `machines` hint also goes when a lease begins or ends by a word (never on an action's renewal).
-- Every new or patched body names this migration (20260930713000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_take_machine_desktop(uuid,uuid,bigint,uuid)') is not null then
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
	-- The member's hand-back epoch the lease was taken under (review r5): a hand-back at that epoch ends it, and only a
	-- heartbeat at it renews it.
	add column desktop_member_epoch bigint,
	-- Moves when a lease begins, when the member is seated anew on their own live lease, and when one is given back
	-- (review r1 F1): a picture is let out only when it has not moved since its look was authorized. It is the hold's
	-- seat (F26).
	add column desktop_member_generation bigint not null default 0,
	-- The press that seated the hold (F26): the id the page minted for that take-over request; recognition only.
	add column desktop_member_press uuid;

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
	-- The seat it was begun under (F26): the executor's read serves it only while that seat stands.
	seat bigint not null check (seat > 0),
	begun_at timestamptz not null,
	served_at timestamptz
);
create index qorpera_company_machine_desktop_actions_control on public.qorpera_company_machine_desktop_actions (control_id);
create index qorpera_company_machine_desktop_actions_machine on public.qorpera_company_machine_desktop_actions (machine_id);
alter table public.qorpera_company_machine_desktop_actions enable row level security;
revoke all on public.qorpera_company_machine_desktop_actions from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Each member's hand-back epoch per machine (review r5 of #1661): moved on by one only by a hand-back at it, under the
-- machine's lock; a take-over is accepted only at it. No row means 0. One row per member and machine that was ever
-- handed back; it goes with the machine.
create table public.qorpera_company_machine_desktop_epochs (
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	user_id uuid not null,
	epoch bigint not null check (epoch > 0),
	primary key (machine_id, user_id)
);
alter table public.qorpera_company_machine_desktop_epochs enable row level security;
revoke all on public.qorpera_company_machine_desktop_epochs from public, anon, authenticated, service_role, qorpera_secret_broker;

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
create function public.qorpera_member_take_machine_desktop(p_profile_id uuid, p_machine_id uuid, p_epoch bigint,
	p_press uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_now timestamptz;
	v_epoch bigint;
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_epoch is null or p_epoch < 0 or p_press is null then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) or public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	v_now := clock_timestamp();
	-- Accepted only at the member's current hand-back epoch (review r5): a hand-back moves it under this same lock, so a
	-- take-over sent before a hand-back that was answered is refused whenever it arrives, and nothing below runs for it.
	v_epoch := coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = v_machine.id and epochs.user_id = v_user), 0);
	if p_epoch <> v_epoch then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'refused',
			'reason', 'TAKE_CALLED_OFF', 'epoch', v_epoch); end if;
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
		-- Their own lease (taken under this epoch: a hand-back at an epoch ends the lease taken under it): taking it
		-- again is an input, from another press (another tab, a page loaded again, a late copy): a new seat (F26), so
		-- the hold seated before ends for its page at its next heartbeat or action.
		update public.qorpera_company_machines set desktop_member_input_at = v_now,
			desktop_member_until = v_now + interval '5 minutes', desktop_member_epoch = v_epoch,
			desktop_member_generation = desktop_member_generation + 1, desktop_member_press = p_press
		where id = v_machine.id;
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok',
			'until', v_now + interval '5 minutes', 'seat', v_machine.desktop_member_generation + 1);
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
		desktop_member_epoch = v_epoch, desktop_member_generation = desktop_member_generation + 1,
		desktop_member_press = p_press,
		last_used_at = case when last_used_at < v_now - interval '30 seconds' then v_now else last_used_at end
	where id = v_machine.id;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok',
		'until', v_now + interval '5 minutes', 'seat', v_machine.desktop_member_generation + 1);
end
$$;
revoke all on function public.qorpera_member_take_machine_desktop(uuid, uuid, bigint, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_take_machine_desktop(uuid, uuid, bigint, uuid) to authenticated;

-- The window's heartbeat: the member's own lease, renewed 5 minutes from now and never past 30 minutes after their last
-- input, only when it was taken under the epoch named and is the seat named (a stale window renews no newer take-over's
-- lease, nor another tab's: F26); `ended` when it is not (handed back, lapsed, idle, seated anew, or another member's).
create function public.qorpera_member_keep_machine_desktop(p_profile_id uuid, p_machine_id uuid, p_epoch bigint,
	p_seat bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_now timestamptz;
	v_until timestamptz;
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_epoch is null or p_epoch < 0 or p_seat is null or p_seat < 0 then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	v_now := clock_timestamp();
	v_until := least(v_now + interval '5 minutes', v_machine.desktop_member_input_at + interval '30 minutes');
	if v_machine.desktop_member_user_id is distinct from v_user or v_machine.desktop_member_epoch is distinct from p_epoch
		or v_machine.desktop_member_generation is distinct from p_seat
		or not coalesce(v_machine.desktop_member_until > v_now, false) or not coalesce(v_until > v_now, false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ended'); end if;
	update public.qorpera_company_machines set desktop_member_until = v_until where id = v_machine.id;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok', 'until', v_until);
end
$$;
revoke all on function public.qorpera_member_keep_machine_desktop(uuid, uuid, bigint, bigint)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_keep_machine_desktop(uuid, uuid, bigint, bigint) to authenticated;

-- The member's lease, given back at their hand-back epoch ('handed_back': their word or their take-over card's "I'm
-- done"; 'closed': their window closed or they left the company's page; a lease that already ended by time is closed as
-- it ended). It names the hold it gives back (F26): by its seat, or, for a take-over whose answer was lost, by the
-- press that may have seated it (at least one; both must match when both are named). The member's lease taken under
-- `p_epoch` that is the hold named ends. The epoch moves on by one when `p_epoch` is the current one and no live lease
-- of the member's is left that this hand-back did not name: a stale tab's hand-back (or its window closing) never ends
-- another tab's live hold of the member's, and the epoch stays where it is while that hold lives, so a live lease of
-- the member's is always taken under the current epoch and an epoch above e still means that nothing taken under e
-- holds. A lapsed lease of the member's is closed as it ended when the epoch moves. At an older epoch nothing moves: a
-- hand-back that arrives late or again never ends a newer take-over's lease (review r4 F9, r5). Either way the answer
-- says the current epoch, whether the member holds the machine now and, if so, that hold's seat. Any member gives back
-- only their own.
create function public.qorpera_member_hand_back_machine_desktop(p_profile_id uuid, p_machine_id uuid, p_reason text,
	p_epoch bigint, p_seat bigint, p_press uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_now timestamptz;
	v_epoch bigint;
	v_mine boolean;
	v_live boolean;
	v_named boolean;
	v_moves boolean;
	v_handed boolean := false;
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_reason is null or p_reason not in ('handed_back', 'closed') or p_epoch is null or p_epoch < 0
		or (p_seat is null and p_press is null) or p_seat < 0 then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	v_now := clock_timestamp();
	v_epoch := coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
		where epochs.machine_id = v_machine.id and epochs.user_id = v_user), 0);
	v_mine := coalesce(v_machine.desktop_member_user_id = v_user, false);
	v_live := v_mine and coalesce(v_machine.desktop_member_until > v_now, false);
	v_named := v_mine and v_machine.desktop_member_epoch is not distinct from p_epoch
		and (p_seat is null or v_machine.desktop_member_generation = p_seat)
		and (p_press is null or v_machine.desktop_member_press is not distinct from p_press);
	v_moves := p_epoch = v_epoch and not (v_live and not v_named);
	if v_named or (v_moves and v_mine and v_machine.desktop_member_epoch is not distinct from p_epoch) then
		v_handed := v_live;
		update public.qorpera_company_machine_desktop_controls
		set ended_at = case when v_live then v_now else v_machine.desktop_member_until end,
			ended_by = case when v_live then p_reason
				when v_machine.desktop_member_until >= v_machine.desktop_member_input_at + interval '30 minutes' then 'idle'
				else 'lapsed' end
		where machine_id = v_machine.id and began_at = v_machine.desktop_member_since and ended_at is null;
		update public.qorpera_company_machines set desktop_member_user_id = null, desktop_member_since = null,
			desktop_member_until = null, desktop_member_input_at = null, desktop_member_epoch = null,
			desktop_member_press = null, desktop_member_generation = desktop_member_generation + 1
		where id = v_machine.id;
		v_machine.desktop_member_user_id := null;
		v_live := false;
	end if;
	if v_moves then
		v_epoch := v_epoch + 1;
		insert into public.qorpera_company_machine_desktop_epochs(machine_id, user_id, epoch)
		values (v_machine.id, v_user, v_epoch)
		on conflict (machine_id, user_id) do update set epoch = excluded.epoch;
	end if;
	return jsonb_build_object('schema', 'qorpera.member-machine-desktop/v1', 'state', 'ok', 'handedBack', v_handed,
		'epoch', v_epoch, 'holding', v_live,
		'seat', case when v_live then v_machine.desktop_member_generation end);
end
$$;
revoke all on function public.qorpera_member_hand_back_machine_desktop(uuid, uuid, text, bigint, bigint, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_hand_back_machine_desktop(uuid, uuid, text, bigint, bigint, uuid)
	to authenticated;

-- 4. A member's action: begun as the member ------------------------------------------------------------------------------

-- The executor sends the member's action here without its text (a `type` by its length), as the member, before it runs
-- anything; it compares the action this answers it later (the authority below) with the one it holds. `p_epoch` and
-- `p_seat` name the hold the page captured the input under (F24, F26): only that hold may run it.
create function public.qorpera_member_machine_desktop_act_begin(p_profile_id uuid, p_machine_id uuid, p_action jsonb,
	p_epoch bigint, p_seat bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_reads_root boolean;
	v_control uuid;
	v_action uuid := pg_catalog.gen_random_uuid();
	v_now timestamptz;
begin
	-- 20260930713000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_epoch is null or p_epoch < 0 or p_seat is null or p_seat < 0
		or not coalesce(public.qorpera_valid_member_desktop_action(p_action), false) then
		raise exception 'Machine desktop action is malformed' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) or public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- The clock is read under the lock (review r7 F14): an action that waited for it across the lease's end finds it
	-- ended, and renews nothing.
	v_now := clock_timestamp();
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
	-- The hold the input was captured under (F24, F26): a lease taken under another epoch is a newer take-over (the
	-- epoch moves only by a hand-back, which ends the lease taken under the old one), and another seat under the same
	-- epoch is a newer seating (the lease ran out and was taken again, or another press took it over): this input's
	-- hold has ended. Nothing recorded.
	if v_machine.desktop_member_epoch is distinct from p_epoch
		or v_machine.desktop_member_generation is distinct from p_seat then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'DESKTOP_CONTROL_ENDED'); end if;
	update public.qorpera_company_machine_desktop_controls set actions = actions + 1
	where machine_id = v_machine.id and began_at = v_machine.desktop_member_since and ended_at is null
	returning id into v_control;
	if v_control is null then
		raise exception 'Machine desktop lease is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_company_machine_desktop_actions(id, control_id, machine_id, user_id, action, seat, begun_at)
	values (v_action, v_control, v_machine.id, v_user, p_action, p_seat, v_now);
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
revoke all on function public.qorpera_member_machine_desktop_act_begin(uuid, uuid, jsonb, bigint, bigint)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_act_begin(uuid, uuid, jsonb, bigint, bigint) to authenticated;

-- 5. The executor's read of a member's action ----------------------------------------------------------------------------

-- Everything the begin checked, again and live, under the machine's lock: the action begun within 15 seconds and not
-- served, its member still an owner, admin or contributor of a company not being deleted, and still holding the desktop
-- under the seat the action was begun in (F26: a hand-back, a new take-over and another press's take-over of the
-- member's own lease all move it), on the lease row the begin counted it on (control_id), not ended, the machine's
-- lease started when that row did. So an action begun under one hold never gets authority under the next (F24, F26).
-- Served by the placement's own executor only, once. The disk's mark is decided again here, as the action is let run (a
-- root read taken away since the begin).
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
		or v_machine.desktop_member_since is distinct from v_control.began_at or v_control.ended_at is not null
		or v_machine.desktop_member_generation is distinct from v_act.seat then
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
-- (p_user_id; null for an agent's look, which no hold lets through). Any lease begun, seated anew (F26) or given back
-- since the read moved the generation, so what the picture may show of a member's input after it never leaves. Plain
-- reads; writes nothing.
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

-- The look's begin read its clock before the machine's lock (20260930712000); it is read under the lock now (review r7
-- F14), so the hold below, the 400 ms throttle and the times it writes are all of the moment the lock was had.
do $$ begin execute pg_temp.machine_member_control_patched('public.qorpera_member_machine_screen_begin(uuid,uuid,jsonb)'::regprocedure,
	array[$old$	v_now timestamptz := clock_timestamp();$old$,
	$new$	v_now timestamptz;$new$,
	$old$	for no key update;
	if not found then
		raise exception 'Machine screen is unavailable' using errcode = '42501'; end if;$old$,
	$new$	for no key update;
	if not found then
		raise exception 'Machine screen is unavailable' using errcode = '42501'; end if;
	-- 20260930713000: the clock, read under the lock.
	v_now := clock_timestamp();$new$,
	$old$		return jsonb_build_object('schema', 'qorpera.member-machine-screen/v1', 'state', 'refused',
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
		-- 20260930713000: owners, admins and contributors take over a desktop; viewers watch.
		'canTakeOver', public.qorpera_can_write_profile(p_profile_id),$new$,
	$old$					'waitingFor', case when listed.state = 'waiting' then$old$,
	$new$					-- 20260930713000: who holds the desktop now, by name, and until when (null: no one).
					'control', case when listed.desktop_member_until > clock_timestamp() then jsonb_build_object(
						'mine', listed.desktop_member_user_id = auth.uid(),
						'name', public.qorpera_review_member_name(p_profile_id, listed.desktop_member_user_id),
						'until', listed.desktop_member_until)
						-- The epoch the caller's own hold was taken under, its seat and the press that seated it, to
						-- the caller alone (review r5, F26).
						|| case when listed.desktop_member_user_id = auth.uid()
							then jsonb_build_object('epoch', listed.desktop_member_epoch, 'seat', listed.desktop_member_generation,
								'press', listed.desktop_member_press) else '{}'::jsonb end end,
					-- The caller's own hand-back epoch for the machine (review r5): a take-over is accepted only at it.
					'epoch', coalesce((select epochs.epoch from public.qorpera_company_machine_desktop_epochs as epochs
						where epochs.machine_id = listed.id and epochs.user_id = auth.uid()), 0),
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
		'public.qorpera_member_take_machine_desktop(uuid,uuid,bigint,uuid)',
		'public.qorpera_member_keep_machine_desktop(uuid,uuid,bigint,bigint)',
		'public.qorpera_member_hand_back_machine_desktop(uuid,uuid,text,bigint,bigint,uuid)',
		'public.qorpera_member_machine_desktop_act_begin(uuid,uuid,jsonb,bigint,bigint)',
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
