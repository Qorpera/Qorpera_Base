-- 20260930738000: a member's shared input carries the desktop's lease generation it was made under, and SQL refuses it
-- once that moved (the server's authority under the computer window's own checks of #1701). Input a member made before
-- someone's private hold, another member's or their own in another window, never runs after that hold, whatever their
-- window saw or did not see between two of its reads.
--
-- * qorpera_list_agent_machines, the computer window's list: each machine names its lease generation (`generation`,
--   desktop_member_generation, which moves at every seating of a member and at every hand-back that ends a lease) to a
--   caller who may act on the desktop (owners, admins, contributors: `canTakeOver`); never to a viewer, who sends no input.
--   The caller already sees it as their own hold's `seat`; between two of their holds it tells how many seatings and
--   hand-backs came, never by whom, when or what was typed (who holds it now is `control`, as before).
-- * qorpera_member_machine_desktop_share_begin(profile, machine, action, generation), for authenticated: 20260930734000's
--   shared begin, its body taken as it is and changed in two places only: `generation` must be a whole number, and while
--   it is not the machine's lease generation now (someone held the desktop privately since the input was made) the
--   action is refused DESKTOP_HELD_SINCE, after every check before it and before anything is recorded. The shared row
--   then records that generation as its seat, so the executor's read (unchanged) serves it only while it still stands.
-- * qorpera_member_machine_desktop_share_begin(profile, machine, action), 20260930734000's, stays as it is for a window
--   from before the web deploy, which sends no generation: it is served as today (the web goes last in the release; a
--   refusal there would break every open window at the switch). PostgREST tells the two apart by their argument names
--   (the new one has no default), so a call is never ambiguous.
-- * Not changed: the executor's read of a shared action, the agent's reads, taking over, keeping, handing back, the
--   picture fence and every seat, generation and epoch fence of 20260930713000.
-- Every new or patched body names this migration (20260930738000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)') is not null then
		raise exception '20260930738000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)') is null
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)'::regprocedure), '20260930734000') = 0 then
		raise exception '20260930738000 needs shared control (20260930734000)'; end if;
end $$;

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_shared_generation_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930738000' in v_definition) > 0 then
		raise exception '20260930738000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930738000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930738000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The shared begin with the generation the input was made under ---------------------------------------------------------

-- 20260930734000's body as it is now, under a fourth argument: the definition it executes creates a new function (the
-- signature differs) and leaves the three-argument one as it is.
do $$ begin execute pg_temp.machine_shared_generation_patched(
	'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)'::regprocedure,
	array[$old$public.qorpera_member_machine_desktop_share_begin(p_profile_id uuid, p_machine_id uuid, p_action jsonb)$old$,
	$new$public.qorpera_member_machine_desktop_share_begin(p_profile_id uuid, p_machine_id uuid, p_action jsonb, p_generation bigint)$new$,
	$old$		or not coalesce(public.qorpera_valid_member_desktop_action(p_action), false) then$old$,
	$new$		or not coalesce(public.qorpera_valid_member_desktop_action(p_action), false)
		-- 20260930738000: the lease generation the member's input was made under, as their window's list named it.
		or p_generation is null or p_generation < 0 then$new$,
	$old$	-- The lease no longer bounds who acts: one member's shared actions on one machine, at most 25 in 5 seconds.$old$,
	$new$	-- 20260930738000: someone held the desktop privately since the input was made (a seating and a hand-back each move
	-- the generation): it never runs after that hold, whatever the window saw. Nothing is recorded.
	if v_machine.desktop_member_generation is distinct from p_generation then
		return jsonb_build_object('schema', 'qorpera.member-machine-desktop-act/v1', 'state', 'refused',
			'reason', 'DESKTOP_HELD_SINCE'); end if;
	-- The lease no longer bounds who acts: one member's shared actions on one machine, at most 25 in 5 seconds.$new$]); end $$;
revoke all on function public.qorpera_member_machine_desktop_share_begin(uuid, uuid, jsonb, bigint)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_desktop_share_begin(uuid, uuid, jsonb, bigint) to authenticated;

-- 2. The computer window's list names each machine's lease generation, to a caller who may act ------------------------------

do $$ begin execute pg_temp.machine_shared_generation_patched(
	'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure,
	array[$old$						having count(*) > 0), '{}'::jsonb)$old$,
	$new$						having count(*) > 0), '{}'::jsonb)
					-- 20260930738000: the lease generation, which each shared action carries as the one its input was made
					-- under; to owners, admins and contributors alone (a viewer sends no input).
					|| case when public.qorpera_can_write_profile(p_profile_id)
						then jsonb_build_object('generation', listed.desktop_member_generation) else '{}'::jsonb end$new$]); end $$;

-- 3. The deploy guard: every new or patched body carries the marker, and keeps its earlier ones; the old begin is as it was

do $guard$
begin
	if exists (select 1 from unnest(array[
			'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)',
			'public.qorpera_list_agent_machines(uuid,uuid)']::regprocedure[]) f(oid)
		where strpos((select prosrc from pg_proc where oid = f.oid), '20260930738000') = 0
			or strpos((select prosrc from pg_proc where oid = f.oid), '20260930734000') = 0) then
		raise exception '20260930738000 marker is missing'; end if;
	if exists (select 1 from unnest(array['20260930712000', '20260930713000', '20260930730000']) marker
			where strpos((select prosrc from pg_proc
				where oid = 'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure), marker) = 0)
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb)'::regprocedure), '20260930738000') > 0 then
		raise exception '20260930738000: a patched body lost its earlier marker, or the old begin changed'; end if;
end $guard$;

drop function pg_temp.machine_shared_generation_patched(regprocedure, text[]);
