-- 20260930759000: a machine that is awake only because a member woke it sleeps 10 minutes after that member is gone
-- (Jonas, 14 November 2026: "if a person has an idle tab in qorpera open, we should be able to close the machines when
-- the user clearly isn't actually online"; "im referring to machines that start due to a users laptop being open on the
-- platform ... not the always on machines"; and to "Sleep a member-woken machine 5 minutes after the member leaves, not
-- an hour?": "let's go with 10 minutes"). lanes/member-machine-sleep-20261114/DESIGN.md.
--
-- Until now one clock decided a task machine's sleep: its last use (last_used_at), which an agent's use, a member's and
-- a busy program all move, against the node's quiet window (qorpera_machine_executors.sleep_after_seconds, an hour). So a
-- member who opened an agent's computer and left cost an hour of a machine, a tab nobody touched up to an hour and a
-- half (the window looks for 30 minutes), and a busy page on the desktop of a machine a run started held it for as long
-- as it was busy. That test stays exactly as it is. Beside it (old OR new):
--
-- * Awake only for a member (qorpera_company_machine_member_only): a task machine wanted running whose start that
--   stands was a member's (desired_by 'member': the window's wake, or a computer a member made from it), with since that
--   start (wanted_at) no agent's command on it (none that still runs, none started since; a worker's and a coding
--   conversation's are commands too), no agent at its screen (screen_agent_used_at, a look or an action), and no run
--   that still goes (its job queued or leased) that started it, asked for it by machine_start (taken_by_run_id) or took
--   it again (reused_by_receipt_id): that run may come back to it, as qorpera_company_machine_takeable reads it. Once an
--   agent uses the machine it is the agent's until it has slept and a member wakes it again. An always-on machine is
--   never one.
-- * The member's last sign (qorpera_company_machine_member_seen_at), read from the rows the member's own paths write, so
--   none of them is patched: the wake (wanted_at); a look, for as long as the member's word that they watch is at most
--   the window old (the watch's last_look_at, no later than its confirmed_at plus the window: a tab nobody touches stops
--   counting); private typing (desktop_member_input_at: the take-over and each input, never its heartbeat, which goes on
--   in a tab nobody touches); an action on the desktop shared with the agent (desktop_shared_at); the pointer over the
--   desktop (a pass, renewed while it moves); the screen turned on (a desktop start). A busy program is no sign: a page
--   left open on the desktop does not hold the machine.
-- * Due (qorpera_company_machine_member_sleep_due): such a machine that has come up, once the newer of its boot and the
--   member's last sign is the node's member_sleep_after_seconds old (new, 600 by default, beside sleep_after_seconds;
--   qorpera_configure_machine_member_sleep sets it). The node's list says sleepDue for it, and the stop's custody agrees
--   on the same terms; the stop is the kernel's own, as an idle sleep is (cause 'slept'), and what ran is ended and told
--   by the rules that stand.
-- * The members' list of an agent's machines names the seconds for such a machine (memberSleepSeconds, null for every
--   other), so the window pauses after as long without a touch; a client that does not know the key ignores it.
-- * Not changed: the hour and what moves it, the busy record and its check-ins, every member and agent path that writes
--   a machine, always-on machines, and the executor (it stops what the list says is due, and SQL agrees first).
-- Every new or patched body names this migration (20260930759000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_company_machine_member_only(public.qorpera_company_machines)') is not null then
		raise exception '20260930759000 is already applied'; end if;
	if to_regprocedure('public.qorpera_company_machine_takeable(public.qorpera_company_machines,jsonb,jsonb,text)') is null
		or to_regclass('public.qorpera_company_machine_desktop_pointers') is null
		or to_regclass('public.qorpera_company_machine_desktop_starts') is null
		or to_regclass('public.qorpera_company_machine_screen_watches') is null then
		raise exception '20260930759000 needs the member''s watch, start and pointer (20260930712000, 714000, 744000) and a machine taken again (20260930747000)';
	end if;
end $$;

-- The column and the patches lock the executors and three functions: never queue behind a long transaction.
set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_member_sleep_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930759000' in v_definition) > 0 then
		raise exception '20260930759000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930759000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930759000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The number, beside the node's quiet window ----------------------------------------------------------------------------

alter table public.qorpera_machine_executors add column member_sleep_after_seconds integer not null default 600
	constraint qorpera_machine_executors_member_sleep check (member_sleep_after_seconds between 60 and 604800);
comment on column public.qorpera_machine_executors.member_sleep_after_seconds is
	'20260930759000: how long after a member''s last sign a machine that is awake only for a member sleeps (sleep_after_seconds decides every other task machine).';

-- The operator's setting of it for one node's executor, as qorpera_configure_machine_lifecycle sets the quiet window.
create function public.qorpera_configure_machine_member_sleep(p_owner text, p_seconds integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930759000
	if auth.role() is distinct from 'service_role' then
		raise exception 'Machine operator authority required' using errcode = '42501'; end if;
	if p_seconds is null or p_seconds not between 60 and 604800 then
		raise exception 'Machine member sleep is invalid' using errcode = '22023'; end if;
	update public.qorpera_machine_executors set member_sleep_after_seconds = p_seconds, updated_at = clock_timestamp()
	where owner = p_owner;
	if not found then raise exception 'Machine executor unavailable' using errcode = '42501'; end if;
end $$;

-- 2. Awake only for a member -----------------------------------------------------------------------------------------------

create function public.qorpera_company_machine_member_only(p_machine public.qorpera_company_machines) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
	-- 20260930759000
	-- A task machine wanted running, whose start that stands was a member's.
	if p_machine.id is null or p_machine.removed_at is not null or p_machine.lifetime is distinct from 'task'
		or p_machine.desired_state is distinct from 'running' or p_machine.desired_by is distinct from 'member' then
		return false; end if;
	-- An agent at its screen since that start (a look or an action).
	if p_machine.screen_agent_used_at >= p_machine.wanted_at then return false; end if;
	-- An agent's command on it: one that still runs, or one started since that start.
	if exists (select 1 from public.qorpera_company_machine_commands command
		where command.machine_id = p_machine.id
			and (command.ended_at is null or command.started_at >= p_machine.wanted_at)) then
		return false; end if;
	-- A run that still goes started it, asked for it by machine_start or took it again: it may come back to it.
	if exists (select 1 from (
			select p_machine.started_by_run_id as run_id
			union all
			select p_machine.taken_by_run_id
			union all
			select receipt.run_id from public.qorpera_run_operation_receipts receipt
			where receipt.id = p_machine.reused_by_receipt_id) asked
		join public.qorpera_execution_runs run on run.id = asked.run_id
		join public.qorpera_runner_jobs job on job.id = run.job_id
		where job.status in ('queued', 'leased')) then
		return false; end if;
	return true;
end $$;

-- 3. The member's last sign ------------------------------------------------------------------------------------------------

-- Null only for a machine that has none (greatest skips what is null). p_window bounds how long a watch's looks count
-- after the member's word that they watch.
create function public.qorpera_company_machine_member_seen_at(p_machine public.qorpera_company_machines, p_window interval)
returns timestamptz language sql stable security definer set search_path = '' as $$
	-- 20260930759000
	select greatest(
		-- The wake.
		p_machine.wanted_at,
		-- A member watching: each look, while their word that they watch is at most the window old (a watch that never
		-- said it is no sign: least skips what is null).
		(select max(least(watch.last_look_at, watch.confirmed_at + p_window))
			from public.qorpera_company_machine_screen_watches watch
			where watch.machine_id = p_machine.id and watch.confirmed_at is not null),
		-- Private typing: the take-over and each input. Never its heartbeat.
		p_machine.desktop_member_input_at,
		-- An action on the desktop shared with the agent.
		p_machine.desktop_shared_at,
		-- The pointer over the desktop.
		(select max(pass.begun_at) from public.qorpera_company_machine_desktop_pointers pass where pass.machine_id = p_machine.id),
		-- The screen turned on.
		(select max(start.begun_at) from public.qorpera_company_machine_desktop_starts start where start.machine_id = p_machine.id))
$$;

-- 4. Due to sleep ----------------------------------------------------------------------------------------------------------

-- p_running_at: when the machine's placement came up (null: not yet, and the hour alone decides, so one that never comes
-- up still gives its room back). p_seconds: its node's member_sleep_after_seconds.
create function public.qorpera_company_machine_member_sleep_due(p_machine public.qorpera_company_machines,
	p_running_at timestamptz, p_seconds integer) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
	-- 20260930759000
	if p_running_at is null or p_seconds is null or not public.qorpera_company_machine_member_only(p_machine) then
		return false; end if;
	return greatest(p_running_at, public.qorpera_company_machine_member_seen_at(p_machine, make_interval(secs => p_seconds)))
		<= clock_timestamp() - make_interval(secs => p_seconds);
end $$;

-- The seconds for a machine that is awake only for a member and has a place on a node, for the members' list; null for
-- every other machine.
create function public.qorpera_company_machine_member_sleep_seconds(p_machine_id uuid) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype; v_seconds integer;
begin
	-- 20260930759000
	select * into v_machine from public.qorpera_company_machines where id = p_machine_id;
	if not public.qorpera_company_machine_member_only(v_machine) then return null; end if;
	select executor.member_sleep_after_seconds into v_seconds
	from public.qorpera_machine_executors executor
	where executor.owner = (public.qorpera_company_machine_placement(v_machine.id)).owner;
	return v_seconds;
end $$;

-- 5. The two places that decide a sleep ------------------------------------------------------------------------------------

-- The executor's list.
do $$ begin execute pg_temp.machine_member_sleep_patched(
	'public.qorpera_list_executor_machines(text,text)'::regprocedure,
	array[$old$and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds))$old$,
	$new$and (machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds)
					-- 20260930759000: one awake only for a member sleeps once that member is gone, whatever is busy on it.
					or public.qorpera_company_machine_member_sleep_due(machine, placement.running_at,
						executor.member_sleep_after_seconds)))$new$]); end $$;

-- The stop's custody agrees on the same terms.
do $$ begin execute pg_temp.machine_member_sleep_patched(
	'public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure,
	array[$old$or v_machine.last_used_at > clock_timestamp() - make_interval(secs => v_executor.sleep_after_seconds) then$old$,
	$new$or (v_machine.last_used_at > clock_timestamp() - make_interval(secs => v_executor.sleep_after_seconds)
					-- 20260930759000: unless it is awake only for a member, and that member is gone.
					and not public.qorpera_company_machine_member_sleep_due(v_machine, v_placement.running_at,
						v_executor.member_sleep_after_seconds)) then$new$]); end $$;

-- 6. The members' list says it ---------------------------------------------------------------------------------------------

do $$ begin execute pg_temp.machine_member_sleep_patched(
	'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure,
	array[$old$case when public.qorpera_company_at_zero(p_profile_id, clock_timestamp()) then 'hours' else 'room' end end)$old$,
	$new$case when public.qorpera_company_at_zero(p_profile_id, clock_timestamp()) then 'hours' else 'room' end end,
					-- 20260930759000: awake only for a member: it sleeps this many seconds after their last sign (null: not so).
					'memberSleepSeconds', public.qorpera_company_machine_member_sleep_seconds(listed.id))$new$]); end $$;

-- 7. Grants ----------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_configure_machine_member_sleep(text, integer),
	public.qorpera_company_machine_member_only(public.qorpera_company_machines),
	public.qorpera_company_machine_member_seen_at(public.qorpera_company_machines, interval),
	public.qorpera_company_machine_member_sleep_due(public.qorpera_company_machines, timestamptz, integer),
	public.qorpera_company_machine_member_sleep_seconds(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_configure_machine_member_sleep(text, integer) to service_role;

-- 8. The deploy guard: every new or patched body carries the marker ----------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_configure_machine_member_sleep(text,integer)',
		'public.qorpera_company_machine_member_only(public.qorpera_company_machines)',
		'public.qorpera_company_machine_member_seen_at(public.qorpera_company_machines,interval)',
		'public.qorpera_company_machine_member_sleep_due(public.qorpera_company_machines,timestamptz,integer)',
		'public.qorpera_company_machine_member_sleep_seconds(uuid)',
		'public.qorpera_list_executor_machines(text,text)',
		'public.qorpera_authorize_executor_machine(uuid,text,text,text,text)',
		'public.qorpera_list_agent_machines(uuid,uuid)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930759000') = 0 then
			raise exception '20260930759000 marker is missing in %', v_function; end if;
	end loop;
	-- The patched bodies keep what they had: the hour, the stop's refusal and the list's own marker.
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_list_executor_machines(text,text)'::regprocedure),
			'machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds)') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure), 'MACHINE_IN_USE') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_list_agent_machines(uuid,uuid)'::regprocedure),
			'20260930712000') = 0 then
		raise exception '20260930759000: a patched body lost what it had'; end if;
end $guard$;

drop function pg_temp.machine_member_sleep_patched(regprocedure, text[]);
