-- 20260930758000: a member opens one of the company's apps, or a file or folder of its folder, on an agent's desktop
-- computer (Jonas, 14 Nov 2026: "Build it now"; of 11 Nov: "later to have manually started desktops open with a selected
-- interface or file so you could test it though a remote desktop"). The member's start (20260930714000) said a later
-- stage would add what to open: this is that stage. It builds on 20260930714000 (a member's start) and 20260930734000
-- (shared control).
-- * qorpera_member_machine_desktop_start_begin(profile, machine, open) (authenticated; the node's executor makes it with
--   the member's own token): a start that also opens `open`, a path of the company folder relative to its root, as the
--   web names it. A new function beside the two-argument begin, which stays as it was (a plain start, `{}`, byte for
--   byte): PostgREST tells them apart by their arguments' names, as it tells the shared begins of 20260930734000 and
--   20260930738000 apart. Under the machine's lock, in this order: an owner, admin or contributor of a company not being
--   deleted (as a shared action: 42501 otherwise); a path the company folder's own rule takes
--   (qorpera_company_path_valid: one or more pieces, no empty piece, no `.` or `..`, none ending in a dot or a space, no
--   leading `/`, no control character, no backslash, no `%` or `:` outside code/, no device names, NFC) and of at most 500
--   bytes, else DESKTOP_OPEN_PATH_INVALID (500 and not 512: the member bridge takes a start body of at most 1 KiB, and
--   `{"open": "…"}` of 500 bytes is at most 1,011 bytes even when every byte is a quote JSON escapes); a path the member
--   reads in the company folder (qorpera_folder_actor_allowed, as the member's own folder read decides it), else
--   DESKTOP_OPEN_NOT_FOUND, which is also what the machine answers for a path it does not have: a path one may not read is
--   told apart from none that is not there; while ANOTHER member types privately (a live lease of someone else's), refused
--   DESKTOP_MEMBER_IN_CONTROL, as that member's click would be (the member's own private hold does not stop it). Then the
--   plain begin, unchanged, does the start: its refusals, its marks, its 5 s floor. A start it records keeps the path
--   (`open_path`), and the agent is told at its next look that a member used its desktop, as a shared action tells it
--   (desktop_shared_user_id, desktop_shared_at: who and when, never what). No hold, and nothing of the agent's pauses.
--   Whether the path is there is not asked here: the machine's own view of the folder says so.
-- * qorpera_member_machine_desktop_start_authority, the executor's read: for a start that opens something, its member
--   still reads the path (else DESKTOP_OPEN_NOT_FOUND) and no other member types privately now (else
--   DESKTOP_MEMBER_IN_CONTROL), both decided under the machine's lock with everything the read decided before; and the
--   answer then carries `open`, the path. A plain start's answer is exactly as before.
-- Every new or patched body names this migration (20260930758000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_machine_desktop_start_begin(uuid,uuid,text)') is not null then
		raise exception '20260930758000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_desktop_start_begin(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)') is null then
		raise exception '20260930758000 needs a member''s start (20260930714000) and shared control (20260930734000)'; end if;
end $$;

-- The column and the patch lock the starts and a function: never queue behind a long transaction.
set local lock_timeout = '3s';

-- 1. A start keeps what it opens ---------------------------------------------------------------------------------------------

alter table public.qorpera_company_machine_desktop_starts add column open_path text
	constraint qorpera_company_machine_desktop_starts_open_path check (open_path is null
		or (octet_length(open_path) between 1 and 500 and public.qorpera_company_path_valid(open_path)));

-- 2. The begin of a start that opens something, as the member ----------------------------------------------------------------

create function public.qorpera_member_machine_desktop_start_begin(p_profile_id uuid, p_machine_id uuid, p_open text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_machine public.qorpera_company_machines%rowtype;
	v_answer jsonb;
begin
	-- 20260930758000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_machine_id is null
		or p_open is null then
		raise exception 'Machine desktop request is malformed' using errcode = '22023'; end if;
	-- Owners, admins and contributors of a company not being deleted, as for a shared action.
	if not public.qorpera_can_write_profile(p_profile_id) or public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- Locked as the plain begin locks it (which takes the same lock again below, in this transaction).
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = p_machine_id and machine.profile_id = p_profile_id and machine.removed_at is null
	for no key update;
	if not found then
		raise exception 'Machine desktop is unavailable' using errcode = '42501'; end if;
	-- A path of the company folder, as the folder's own rule takes one.
	if octet_length(p_open) > 500 or not public.qorpera_company_path_valid(p_open) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'refused',
			'reason', 'DESKTOP_OPEN_PATH_INVALID'); end if;
	-- One the member reads: a path they may not read is answered as one that is not there.
	if not coalesce(public.qorpera_folder_actor_allowed(v_machine.environment_id, v_machine.profile_id,
			jsonb_build_object('kind', 'member', 'userId', v_user), p_open, 'read'), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'refused',
			'reason', 'DESKTOP_OPEN_NOT_FOUND'); end if;
	-- Another member types privately: nothing opens on the screen they type on, as their click would be refused.
	if coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
		and v_machine.desktop_member_user_id is distinct from v_user then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start/v1', 'state', 'refused',
			'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
	-- The start itself, exactly as a plain one: its refusals, its marks and its floor.
	v_answer := public.qorpera_member_machine_desktop_start_begin(p_profile_id, p_machine_id);
	if v_answer ->> 'state' = 'ok' then
		update public.qorpera_company_machine_desktop_starts set open_path = p_open
		where id = (v_answer ->> 'startId')::uuid;
		-- The agent is told at its next look that a member used its desktop (who and when, never what).
		update public.qorpera_company_machines set desktop_shared_user_id = v_user, desktop_shared_at = clock_timestamp()
		where id = v_machine.id;
	end if;
	return v_answer;
end
$$;
revoke all on function public.qorpera_member_machine_desktop_start_begin(uuid, uuid, text)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_start_begin(uuid, uuid, text) to authenticated;

-- 3. The executor's read: the path again, and its answer ---------------------------------------------------------------------

-- (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs left it,
-- and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_member_open_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930758000' in v_definition) > 0 then
		raise exception '20260930758000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930758000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930758000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

do $$ begin execute pg_temp.machine_member_open_patched(
	'public.qorpera_member_machine_desktop_start_authority(uuid,text,text)'::regprocedure,
	array[$old$	-- The start runs: the disk's mark is decided again here, under this lock, as an action's read decides it (a root$old$,
	$new$	-- 20260930758000: a start that opens something: its member still reads the path, and no other member types
	-- privately now (the begin's checks, again under the machine's lock).
	if v_start.open_path is not null then
		if not coalesce(public.qorpera_folder_actor_allowed(v_machine.environment_id, v_machine.profile_id,
				jsonb_build_object('kind', 'member', 'userId', v_start.user_id), v_start.open_path, 'read'), false) then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start-authority/v1', 'state', 'refused',
				'reason', 'DESKTOP_OPEN_NOT_FOUND'); end if;
		if coalesce(v_machine.desktop_member_until > clock_timestamp(), false)
			and v_machine.desktop_member_user_id is distinct from v_start.user_id then
			return jsonb_build_object('schema', 'qorpera.member-machine-desktop-start-authority/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
	end if;
	-- The start runs: the disk's mark is decided again here, under this lock, as an action's read decides it (a root$new$,
	$old$		'served', v_served);$old$,
	$new$		'served', v_served)
		-- 20260930758000: what the start opens, when it opens something; a plain start's answer is as before.
		|| case when v_start.open_path is not null then jsonb_build_object('open', v_start.open_path) else '{}'::jsonb end;$new$
	]); end $$;

-- 4. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_member_machine_desktop_start_begin(uuid,uuid,text)',
		'public.qorpera_member_machine_desktop_start_authority(uuid,text,text)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930758000') = 0 then
			raise exception '20260930758000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_desktop_start_authority(uuid,text,text)'::regprocedure), '20260930714000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_desktop_start_begin(uuid,uuid)'::regprocedure), '20260930758000') > 0 then
		raise exception '20260930758000: the read lost its 20260930714000 marker, or the plain begin was touched'; end if;
end $guard$;

drop function pg_temp.machine_member_open_patched(regprocedure, text[]);
