-- 20260930742000: the members see when an agent is using its desktop computer (Jonas, 13 November 2026: "when an agent IS
-- using a desktop computer, the computers window pops up in it's thread for you to see. and perhaps an animation the
-- avatar could do in the sidepanel to indicate it"). One truthful, cheap signal for the web: the agent itself looked at or
-- acted on the machine's screen (machine_screen) within the last 90 seconds, and the machine runs.
--
-- * qorpera_company_machines gains screen_agent_used_at (the agent's last screen call) and screen_agent_since (when this
--   stretch of use began). screen_used_at (20260930712000) is not that signal: a member's desktop start (20260930714000)
--   stamps it too, on a screen no agent drove yet.
-- * qorpera_authorize_machine_screen, the coding executor's read of an AGENT's machine_screen call (a look or an action),
--   stamps both inside the update that already stamps screen_used_at, where it allows the call (a refusal returns before
--   it), at most every 30 seconds as before: no write of its own. A stretch begins anew when the agent's previous stamp is
--   older than the window, or another agent drove the screen. A member's start, look, action, shared input and every
--   take-over write neither column: nothing but this read does.
-- * qorpera_machine_screen_in_use(): the window (90 seconds), its one place. The agents' screen calls come at most ~57
--   seconds apart within a stretch in production (11-12 Nov: 40 calls in 9 runs, gaps p50 9.6 s, p90 ~24 s, max 41 s
--   between ends, calls up to 16 s), so with the 30-second stamp the signal stays on through a stretch.
-- * The `machines` hint (20260930712000, 20260930713000) also fires when screen_agent_since moves: once per stretch per
--   machine, to every member, so the web learns of a new stretch within seconds without polling.
-- * qorpera_list_company_screens_in_use(profile), a member's read (authenticated; every member who reads the company,
--   viewers too): the company's machines whose agent used the screen within the window, that run, that no member holds
--   privately now, of an agent still on the company's staff: per machine its agent, the stretch's start, the agent's last
--   call and the end of the window (`until`, which the web keeps as the signal's end and reads again at), with the
--   database's time (`now`) for the web's clock. Nothing of where it runs, no picture, nothing the agent did.
-- Every new or patched body names this migration (20260930742000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_list_company_screens_in_use(uuid)') is not null then
		raise exception '20260930742000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_desktop_share_begin(uuid,uuid,jsonb,bigint)') is null
		or exists (select 1 from unnest(array['20260930712000', '20260930713000', '20260930730000', '20260930734000']) marker
			where strpos((select prosrc from pg_proc
				where oid = 'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure), marker) = 0) then
		raise exception '20260930742000 needs shared control and its generation (20260930734000, 20260930738000)'; end if;
end $$;

-- The columns and the trigger lock the machines: never queue behind a long transaction.
set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.agent_at_computer_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930742000' in v_definition) > 0 then
		raise exception '20260930742000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930742000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930742000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The agent's own use of the screen ------------------------------------------------------------------------------------

-- The agent's last machine_screen call that was allowed (a look or an action), at most every 30 seconds, and when its
-- stretch of use began. Written by qorpera_authorize_machine_screen alone.
alter table public.qorpera_company_machines
	add column screen_agent_used_at timestamptz,
	add column screen_agent_since timestamptz;

-- How long after the agent's last screen call it still counts as using the computer.
create function public.qorpera_machine_screen_in_use() returns interval
language sql immutable parallel safe set search_path = '' as $$
	-- 20260930742000
	select interval '90 seconds'
$$;
revoke all on function public.qorpera_machine_screen_in_use() from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The agent's screen read stamps it -------------------------------------------------------------------------------------

do $$ begin execute pg_temp.agent_at_computer_patched('public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure,
	array[$old$	update public.qorpera_company_machines set screen_staff_agent_id = v_run.staff_agent_id, screen_used_at = clock_timestamp()
	where id = v_machine.id and (screen_staff_agent_id is distinct from v_run.staff_agent_id or screen_used_at is null
		or screen_used_at < clock_timestamp() - interval '30 seconds');$old$,
	$new$	update public.qorpera_company_machines set screen_staff_agent_id = v_run.staff_agent_id, screen_used_at = clock_timestamp(),
		-- 20260930742000: the agent's own use, for the members' "using its computer" (qorpera_list_company_screens_in_use):
		-- a stretch begins anew after a pause longer than the window, or when another agent drives the screen.
		-- One instant for both (a new stretch begins at the call that stamps it).
		screen_agent_since = case when screen_agent_used_at is null
				or screen_agent_used_at < stamp.at - public.qorpera_machine_screen_in_use()
				or screen_staff_agent_id is distinct from v_run.staff_agent_id
			then stamp.at else screen_agent_since end,
		screen_agent_used_at = stamp.at
	from (select clock_timestamp() as at) as stamp
	where id = v_machine.id and (screen_staff_agent_id is distinct from v_run.staff_agent_id or screen_used_at is null
		or screen_used_at < clock_timestamp() - interval '30 seconds'
		-- 20260930742000: also when only the agent's own stamp is old (a member's desktop start stamped screen_used_at).
		or screen_agent_used_at is null or screen_agent_used_at < clock_timestamp() - interval '30 seconds');$new$]); end $$;

-- 3. The `machines` hint at each new stretch ---------------------------------------------------------------------------------

-- As 20260930713000's, and when a stretch of an agent's use begins (screen_agent_since moves; a stamp within a stretch
-- moves only screen_agent_used_at, which sends none: the web reads again at the window's end).
drop trigger qorpera_machine_hint_change on public.qorpera_company_machines;
create constraint trigger qorpera_machine_hint_change
	after update of desired_state, removed_at, last_error, screen_staff_agent_id, screen_used_at, desktop_member_user_id,
		desktop_member_since, screen_agent_since on public.qorpera_company_machines
	deferrable initially deferred for each row
	when (old.desired_state is distinct from new.desired_state or old.removed_at is distinct from new.removed_at
		or old.last_error is distinct from new.last_error or old.screen_staff_agent_id is distinct from new.screen_staff_agent_id
		or (new.screen_used_at is not null
			and (old.screen_used_at is null or old.screen_used_at < new.screen_used_at - interval '10 minutes'))
		or old.desktop_member_user_id is distinct from new.desktop_member_user_id
		or old.desktop_member_since is distinct from new.desktop_member_since
		or old.screen_agent_since is distinct from new.screen_agent_since)
	execute function public.qorpera_machine_hint();

-- 4. Which agents use their computers now ---------------------------------------------------------------------------------

create function public.qorpera_list_company_screens_in_use(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
	-- 20260930742000
	if auth.uid() is null or p_profile_id is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object(
		'schema', 'qorpera.company-screens-in-use/v1',
		'profileId', p_profile_id,
		'now', v_now,
		'screens', coalesce((
			select jsonb_agg(jsonb_build_object(
					'staffAgentId', used.screen_staff_agent_id,
					'machineId', used.id,
					'since', used.screen_agent_since,
					'usedAt', used.screen_agent_used_at,
					'until', used.screen_agent_used_at + public.qorpera_machine_screen_in_use())
				order by used.screen_agent_since, used.id)
			from (
				select machine.* from public.qorpera_company_machines as machine
				where machine.profile_id = p_profile_id and machine.removed_at is null and machine.desired_state <> 'deleted'
					and machine.screen_staff_agent_id is not null and machine.screen_agent_since is not null
					and machine.screen_agent_used_at > v_now - public.qorpera_machine_screen_in_use()
					-- A member who holds the desktop privately is the one using it (the agent is refused meanwhile).
					and not coalesce(machine.desktop_member_until > v_now, false)
					and public.qorpera_company_machine_state(machine) = 'running'
					and exists (select 1 from public.qorpera_profile_staff as staff
						where staff.profile_id = p_profile_id and staff.staff_agent_id = machine.screen_staff_agent_id)
				order by machine.screen_agent_since, machine.id
				limit 50) as used), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_list_company_screens_in_use(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_company_screens_in_use(uuid) to authenticated;

-- 5. The deploy guard: every new or patched body carries the marker, and the patched one keeps its earlier ones ------------

do $guard$
begin
	if exists (select 1 from unnest(array[
			'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)',
			'public.qorpera_list_company_screens_in_use(uuid)',
			'public.qorpera_machine_screen_in_use()']::regprocedure[]) f(oid)
		where strpos((select prosrc from pg_proc where oid = f.oid), '20260930742000') = 0) then
		raise exception '20260930742000 marker is missing'; end if;
	if exists (select 1 from unnest(array['20260930708000', '20260930712000', '20260930713000', '20260930730000',
			'20260930734000']) marker
			where strpos((select prosrc from pg_proc
				where oid = 'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)'::regprocedure), marker) = 0) then
		raise exception '20260930742000: the patched screen read lost an earlier marker'; end if;
end $guard$;

drop function pg_temp.agent_at_computer_patched(regprocedure, text[]);
