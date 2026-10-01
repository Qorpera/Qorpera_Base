-- Computer hours, build step 6b part 4: coding at zero (built switched off, with its own switch).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero": nothing new starts;
-- running work may finish for at most 1 hour, then it is stopped). Design: deploy/first-node/
-- RUNTIME-COMPUTER-HOURS.md ("Zero": "A new coding turn waits like other new work").
--
-- Its own switch: `qorpera_computer_hour_billing.coding_zero_rule_since` (null until switched on). A
-- coding executor that does not know COMPUTER_HOURS_EXHAUSTED fails a turn on it, and production's
-- executor (v6 on 2026-10-01) does not, so coding is switched on only once an executor with this
-- change runs on every coding node. While it is off, part 1's node refusal no longer covers coding
-- machines (6a still holds a coding turn's run at zero, as before; see the design's known limits).
-- With it on:
-- 1. The node refusal covers coding machines (kind 'coding') again.
-- 2. `qorpera_authorize_coding_machine_run` (the machine step every turn passes before begin) refuses a
--    turn not yet begun with COMPUTER_HOURS_EXHAUSTED; the executor already waits it out (part 1) and
--    defers the session to the queue. A turn already running finishes its hour.
-- 3. `qorpera_begin_coding_turn` answers {"state":"refused","reason":"COMPUTER_HOURS_EXHAUSTED"} instead of
--    beginning, for a company that reached zero after the machine step; the executor defers it.
-- 4. `qorpera_defer_coding_session` says "Waiting for computer hours" for that reason (one step in the
--    thread per wait; a new reason posts its own step).
-- 5. `qorpera_list_coding_machines` puts a member's coding machine to sleep once the finishing window
--    is over and no turn holds it (the turn's run was ended by the finishing window), busy commands
--    notwithstanding.
-- While the zero rule is off nothing changes. While only coding's switch is off, coding is as it was
-- before part 1: its machines are not refused, and 6a still holds a coding turn's run.

set local lock_timeout = '3s';

alter table public.qorpera_computer_hour_billing add column coding_zero_rule_since timestamptz;

-- Coding is held at zero from this time on.
create function public.qorpera_computer_hour_coding_on(p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (select 1 from public.qorpera_computer_hour_billing billing
		where billing.coding_zero_rule_since is not null and billing.coding_zero_rule_since <= p_at)
$$;

-- The company is at zero and its coding is held.
create function public.qorpera_company_coding_at_zero(p_profile_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_computer_hour_coding_on(p_at) and public.qorpera_company_at_zero(p_profile_id, p_at)
$$;

-- The company's hour at zero is over and its coding is held.
create function public.qorpera_computer_hour_coding_finish_window_over(p_profile_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_computer_hour_coding_on(p_at) and public.qorpera_computer_hour_finish_window_over(p_profile_id, p_at)
$$;

revoke all on function public.qorpera_computer_hour_coding_on(timestamptz),
	public.qorpera_company_coding_at_zero(uuid, timestamptz),
	public.qorpera_computer_hour_coding_finish_window_over(uuid, timestamptz)
	from public, anon, authenticated, service_role;

do $patch$
declare
	v_definition text;
	v_old text;
	v_new text;
	v_target regprocedure;
	v_patches constant text[][] := array[
		array['public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', $o$  and public.qorpera_company_at_zero(v_profile, clock_timestamp()) then v_reason:='COMPUTER_HOURS_EXHAUSTED';$o$, $n$  and public.qorpera_company_at_zero(v_profile, clock_timestamp())
  and (p_provider_kind<>'coding' or public.qorpera_computer_hour_coding_on(clock_timestamp())) then v_reason:='COMPUTER_HOURS_EXHAUSTED';$n$],
		array['public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)', $o$	-- A turn not yet begun waits for a machine whose policy moved on; a turn already running there finishes there.
	if v_machine.retire_requested_at is not null and v_worker.occurrence_id is null then
		return '{"state":"refused","reason":"MACHINE_RETIRING"}'::jsonb; end if;
$o$, $n$	-- A turn not yet begun waits for a machine whose policy moved on; a turn already running there finishes there.
	if v_machine.retire_requested_at is not null and v_worker.occurrence_id is null then
		return '{"state":"refused","reason":"MACHINE_RETIRING"}'::jsonb; end if;
	-- Computer hours (20260929760000): with coding held, a turn not yet begun waits while its company is at
	-- zero (the executor defers it); a turn already running finishes its hour.
	if v_worker.occurrence_id is null and public.qorpera_company_coding_at_zero(v_worker.profile_id, clock_timestamp()) then
		return '{"state":"refused","reason":"COMPUTER_HOURS_EXHAUSTED"}'::jsonb; end if;
$n$],
		array['public.qorpera_begin_coding_turn(uuid,uuid,jsonb)', $o$	if v_worker.state <> 'active' or v_worker.occurrence_id is not null then
		raise exception 'Coding turn is already admitted or the worker is not active' using errcode = '55000'; end if;
$o$, $n$	if v_worker.state <> 'active' or v_worker.occurrence_id is not null then
		raise exception 'Coding turn is already admitted or the worker is not active' using errcode = '55000'; end if;
	-- Computer hours (20260929760000): with coding held, a turn whose company reached zero after its machine
	-- step does not begin. An answer, not an error, so the executor can defer it; nothing is written.
	if public.qorpera_company_coding_at_zero(v_worker.profile_id, clock_timestamp()) then
		return '{"state":"refused","reason":"COMPUTER_HOURS_EXHAUSTED"}'::jsonb; end if;
$n$],
		array['public.qorpera_defer_coding_session(uuid,uuid,text)', $o$	v_step constant text := 'Waiting for a coding machine'; v_waiting boolean;
$o$, $n$	v_step constant text := case when p_reason = 'COMPUTER_HOURS_EXHAUSTED' then 'Waiting for computer hours'
		else 'Waiting for a coding machine' end; v_waiting boolean;
$n$],
		array['public.qorpera_defer_coding_session(uuid,uuid,text)', $o$	v_waiting := v_session.claim_after is not null;
$o$, $n$	-- A new reason (computer hours, 20260929760000) posts its own step.
	v_waiting := v_session.claim_after is not null and v_session.last_step is not distinct from v_step;
$n$],
		array['public.qorpera_list_coding_machines(text,text)', $o$				and greatest(machine.last_used_at, coalesce(machine.busy_at, machine.last_used_at))
					<= clock_timestamp() - make_interval(secs => executor.machine_sleep_after_seconds),
$o$, $n$				and (greatest(machine.last_used_at, coalesce(machine.busy_at, machine.last_used_at))
					<= clock_timestamp() - make_interval(secs => executor.machine_sleep_after_seconds)
					-- Computer hours (20260929760000): with coding held, an hour after the company ran out its machine
					-- sleeps once no turn holds it, busy commands notwithstanding.
					or public.qorpera_computer_hour_coding_finish_window_over(machine.profile_id, clock_timestamp())),
$n$]
];
	v_index integer;
begin
	for v_index in 1 .. array_length(v_patches, 1) loop
		v_target := v_patches[v_index][1]::regprocedure;
		v_old := v_patches[v_index][2];
		v_new := v_patches[v_index][3];
		v_definition := pg_get_functiondef(v_target);
		if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
			raise exception 'Computer hours: % differs (patch %)', v_target, v_index;
		end if;
		execute replace(v_definition, v_old, v_new);
	end loop;
end
$patch$;
