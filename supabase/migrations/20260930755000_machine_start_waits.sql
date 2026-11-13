-- 20260930755000 (agent-box B1 follow-up, 13 Nov 2026): every wait for a machine is kept where a release can count it.
--
-- v244 let a conversation's run wait in place for its machine (machine_start's waitSeconds, 20260930747000). Its first
-- live start (Wristband, 13 Nov 16:41Z) did not wait: the start answered `waiting` (NODE_CAPACITY_EXHAUSTED, place 1)
-- because node 2's machine disk budget was full (600 of 600 GiB, 15 placements, 1 running), so no new disk fitted until
-- the executor's next pass gave a sleeping machine's disk away, 2.1 s later; 22 of 36 new agent machines in 7 days were
-- placed that way, after the start, at p50 2.2 s. The runtime waited only on `starting`, and only when the model asked;
-- and nothing was kept of whether it waited, so the release's read could not tell which happened. Now the runtime waits
-- by default, also through such a `waiting`, and reports each wait here once it ends.
--
-- * qorpera_company_machine_start_waits: one row per machine_start whose machine was not running yet when it answered:
--   the run, the machine, whether the model asked for the wait (`asked`) and its limit, the state the start answered
--   (`waiting` or `starting`) and why it waited (`waiting_for`), how long it waited, how it ended (`outcome`: running,
--   limit: the time passed, hours: it waits for computer hours and was not waited on, not_asked: waitSeconds 0, stopped,
--   gone, work_stopped) and the state it was left in. Rows older than 30 days go, at most 50 a time, as each is added.
-- * qorpera_native_machine_manage takes action `waited` (machine, machineId, wait): the run's runtime reports its wait.
--   It writes only that row; it takes no lock and checks no work authority (a run told its work stopped reports that
--   too). The machine is the one the start answered, by its id, of the run's company and of that name, a removed one
--   too (a wait that ended `gone`); never a later machine of the same name (review r1 F1 of #1771).
-- An old runtime never calls it; a new runtime over the old kernel is refused (22023) and goes on without the row.
-- Every new or patched body names this migration (20260930755000), for the deploy guards.
set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_company_machine_start_waits') is not null then
		raise exception '20260930755000 is already applied'; end if;
	if strpos(pg_get_functiondef('public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure), '20260930747000') = 0 then
		raise exception '20260930755000 needs the machine ready and reused (20260930747000)'; end if;
end $$;

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_start_waits_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930755000' in v_definition) > 0 then
		raise exception '20260930755000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930755000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930755000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The waits ------------------------------------------------------------------------------------------------------------

create table public.qorpera_company_machine_start_waits (
	id uuid primary key default extensions.gen_random_uuid(),
	machine_id uuid not null references public.qorpera_company_machines(id) on delete restrict,
	profile_id uuid not null,
	environment_id uuid not null,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	staff_agent_id uuid not null,
	-- A worker's run (nothing wakes it) or a conversation's.
	worker boolean not null,
	-- The model asked for this wait (waitSeconds), or it was the default.
	asked boolean not null,
	limit_seconds integer not null check (limit_seconds between 0 and 300),
	-- What machine_start answered, and why a machine in line waited (its waitingFor).
	state_before text not null check (state_before in ('waiting', 'starting')),
	waiting_for text check (waiting_for ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	waited_ms integer not null check (waited_ms between 0 and 600000),
	outcome text not null check (outcome in ('running', 'limit', 'hours', 'not_asked', 'stopped', 'gone', 'work_stopped')),
	state_after text not null check (state_after ~ '^[a-z]{1,16}$'),
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_company_machine_start_waits_created on public.qorpera_company_machine_start_waits (created_at, id);
create index qorpera_company_machine_start_waits_machine on public.qorpera_company_machine_start_waits (machine_id, created_at);
alter table public.qorpera_company_machine_start_waits enable row level security;
revoke all on public.qorpera_company_machine_start_waits from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_company_machine_start_waits is
	'20260930755000: how each machine_start whose machine was not running yet waited for it (the runtime reports it).';

-- The runtime's report of one wait, as machine_start sends it (cloud-machine-tools.ts, `waited`). Internal.
create function public.qorpera_valid_machine_start_wait(p_wait jsonb) returns boolean
language plpgsql immutable security definer set search_path = '' as $$
begin
	-- 20260930755000. Each value's shape is checked before it is cast.
	if jsonb_typeof(p_wait) is distinct from 'object' then return false; end if;
	if (select string_agg(key, ',' order by key collate "C") from jsonb_object_keys(p_wait) key)
			is distinct from 'asked,limitSeconds,outcome,stateAfter,stateBefore,waitedMs,waitingFor'
		or jsonb_typeof(p_wait -> 'asked') is distinct from 'boolean'
		or jsonb_typeof(p_wait -> 'limitSeconds') is distinct from 'number' or p_wait ->> 'limitSeconds' !~ '^[0-9]{1,3}$'
		or jsonb_typeof(p_wait -> 'waitedMs') is distinct from 'number' or p_wait ->> 'waitedMs' !~ '^[0-9]{1,6}$'
		or p_wait ->> 'stateBefore' is null or p_wait ->> 'stateBefore' not in ('waiting', 'starting')
		or (jsonb_typeof(p_wait -> 'waitingFor') is distinct from 'null' and (jsonb_typeof(p_wait -> 'waitingFor') is distinct from 'string'
			or p_wait ->> 'waitingFor' !~ '^[A-Z][A-Z0-9_]{0,63}$'))
		or p_wait ->> 'outcome' is null
		or p_wait ->> 'outcome' not in ('running', 'limit', 'hours', 'not_asked', 'stopped', 'gone', 'work_stopped')
		or jsonb_typeof(p_wait -> 'stateAfter') is distinct from 'string' or p_wait ->> 'stateAfter' !~ '^[a-z]{1,16}$' then
		return false; end if;
	return (p_wait ->> 'limitSeconds')::integer <= 300 and (p_wait ->> 'waitedMs')::integer <= 600000;
end $$;
revoke all on function public.qorpera_valid_machine_start_wait(jsonb) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. machine_start's report: qorpera_native_machine_manage, action `waited` -------------------------------------------------

do $$ begin execute pg_temp.machine_start_waits_patched(
	'public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure,
	array[$old$		or v_action is null or v_action not in ('list','stop','delete','status')$old$,
	$new$		or v_action is null or v_action not in ('list','stop','delete','status','waited') -- 20260930755000$new$,
	$old$		or (v_action <> 'list' and (p_request - case when v_action = 'status' then array['action','machine','commandId']$old$,
	$new$		or (v_action <> 'list' and (p_request - case when v_action = 'status' then array['action','machine','commandId']
					when v_action = 'waited' then array['action','machine','machineId','wait']$new$,
	$old$	perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid);
	perform pg_advisory_xact_lock($old$,
	$new$	-- 20260930755000: the run's runtime says how its machine_start waited for the machine (the time it waited, how it
	-- ended). Only that row is written: no lock, and no work check, since a run told its work stopped says so too.
	if v_action = 'waited' then
		if coalesce(p_request ->> 'machineId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or not public.qorpera_valid_machine_start_wait(p_request -> 'wait') then
			raise exception 'Invalid machine request' using errcode = '22023'; end if;
		select * into v_machine from public.qorpera_company_machines machine
		where machine.id = (p_request ->> 'machineId')::uuid and machine.profile_id = (v_identity ->> 'companyId')::uuid
			and machine.name = p_request ->> 'machine';
		if not found then return jsonb_build_object('schema','qorpera.machine-wait/v1','recorded',false); end if;
		insert into public.qorpera_company_machine_start_waits(machine_id, profile_id, environment_id, run_id, staff_agent_id, worker,
			asked, limit_seconds, state_before, waiting_for, waited_ms, outcome, state_after)
		values (v_machine.id, v_machine.profile_id, v_machine.environment_id, (p_binding ->> 'runId')::uuid,
			(v_identity ->> 'staffAgentId')::uuid, (public.qorpera_run_worker((p_binding ->> 'runId')::uuid)).id is not null,
			(p_request #>> '{wait,asked}')::boolean, (p_request #>> '{wait,limitSeconds}')::integer, p_request #>> '{wait,stateBefore}',
			p_request #>> '{wait,waitingFor}', (p_request #>> '{wait,waitedMs}')::integer, p_request #>> '{wait,outcome}',
			p_request #>> '{wait,stateAfter}');
		delete from public.qorpera_company_machine_start_waits where id in (select expired.id
			from public.qorpera_company_machine_start_waits expired where expired.created_at < clock_timestamp() - interval '30 days'
			order by expired.created_at limit 50 for update skip locked);
		return jsonb_build_object('schema','qorpera.machine-wait/v1','recorded',true);
	end if;
	perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid);
	perform pg_advisory_xact_lock($new$]); end $$;
