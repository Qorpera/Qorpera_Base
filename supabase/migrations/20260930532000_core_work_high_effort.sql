-- Core work runs deep (founder, 22 October 2026: "core work can happen through high effort levels, while the lightchat
-- is the quick gate into the company"; contract 17, the 2026-10-22 amendment "core work runs deep").
--
-- Until now two kinds of run chose their reasoning effort: a member's turn in a conversation took that conversation's
-- Model menu effort (20260924120000), and a routine's run its routine version's (20260922151000). Every other run took
-- the bundle's default effort, low: a worker's own run, an agent's first run, a coworker's message, and the work that
-- carries on from these, although no member waits on any of them. The `effort` of an agent's agent.md reached no run
-- (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md, "the file's effort reaching runs").
--
-- A bundle's model policy may now declare `unattended`: low, medium or high (the runtime declares high). Under such a
-- bundle the kernel resolves a run's effort in this order and pins it on the run as before:
-- 1. A routine's wake: its routine version's effort (unchanged).
-- 2. A member's turn (a room delivery, or a session turn with a member's message): its conversation's Model menu effort,
--    else the default (unchanged).
-- 3. A run that carries on the agent's own chain (a worker's report, a machine event or check-in, an office start: a
--    wake with an origin run, 20260930497000): the effort its chain's first run was pinned with. A chain a member's turn
--    started keeps that conversation's effort, a routine's chain its routine's, and any other chain the effort below.
-- 4. Every other wake, and an agent's first run (a session turn whose only input is a hire's kickoff): the `effort` of
--    the agent's agent.md, as the checked parse of the version the roster points at holds it, else the policy's
--    `unattended`. These are the runs no member waits on: a worker's own run, a first run, a coworker's message, a
--    member's finished task, a chain whose first run is unknown.
-- Runs of the other source kinds (manual, proposal review, system) keep the default, and under a bundle without
-- `unattended` nothing changes. The service tier is untouched: it follows the run's source kind (20260927161500).
--
-- * qorpera_execution_runtime_manifest accepts `unattended` in the model policy: a string, low, medium or high.
-- * qorpera_manifest_allows_reasoning_effort allows the policy's `unattended` effort.
-- * qorpera_resolve_run_reasoning_effort(run, manifest): the order above, for the pin trigger.
-- * qorpera_pin_execution_reasoning_policy calls it; the immutability check and the policy hash are unchanged.
--
-- Deploy: apply before a bundle whose model policy declares `unattended` activates (its activation needs a guard on
-- qorpera_resolve_run_reasoning_effort). An older kernel refuses that manifest, so no run of it could start.

set local lock_timeout = '3s';

create function pg_temp.ce_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930532000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- A bundle may declare the effort of runs no member waits on; any other value is refused.
select pg_temp.ce_replace('public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode'] <> '{}'::jsonb
		or coalesce(v_manifest #>> '{modelPolicy,fastMode}','thread') <> 'thread'$old$,
	$new$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode','unattended'] <> '{}'::jsonb
		or coalesce(v_manifest #>> '{modelPolicy,fastMode}','thread') <> 'thread'
		-- 20260930532000: the effort of runs no member waits on, when the policy names one.
		or ((v_manifest -> 'modelPolicy') ? 'unattended'
			and coalesce(v_manifest #>> '{modelPolicy,unattended}','') not in ('low','medium','high'))$new$);

create or replace function public.qorpera_manifest_allows_reasoning_effort(p_manifest jsonb, p_effort text)
returns boolean language sql immutable set search_path = '' as $$
	select p_effort is not null and (
		p_effort = p_manifest #>> '{modelPolicy,effort}'
		-- 20260930532000: the effort of runs no member waits on. Never null, so a policy without it still answers false.
		or p_effort = coalesce(p_manifest #>> '{modelPolicy,unattended}', '')
		or (p_manifest #>> '{modelPolicy,overrides}' in ('routine','routine-and-thread')
			and jsonb_typeof(p_manifest #> '{modelPolicy,allowed}') = 'array'
			and (p_manifest #> '{modelPolicy,allowed}') ? p_effort))
$$;
revoke all on function public.qorpera_manifest_allows_reasoning_effort(jsonb, text) from public, anon, authenticated, service_role;

-- The run's effort under its admitted bundle's manifest, as the pin trigger sets it (the order in this file's header).
-- Caller hints and job flags never reach it: it reads only the run's own kind and source and the company's state.
create function public.qorpera_resolve_run_reasoning_effort(p_run public.qorpera_execution_runs, p_manifest jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_policy jsonb := p_manifest -> 'modelPolicy'; v_wake public.qorpera_wake_occurrences%rowtype;
	v_first_run boolean := false; v_chosen text;
begin
	if p_run.source_kind = 'wake' then
		select * into v_wake from public.qorpera_wake_occurrences where id = p_run.source_id;
	elsif p_run.source_kind = 'session_turn' and (v_policy ? 'unattended') then
		-- A hire's kickoff is the agent's first run; a member's message makes the turn theirs.
		v_first_run := exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind = 'kickoff')
			and not exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind is distinct from 'kickoff');
	end if;
	-- 1. A routine's wake takes the effort its routine version declares (contract 17).
	if v_wake.wake_kind = 'routine' then
		if v_policy ->> 'overrides' in ('routine','routine-and-thread') then
			select version.effort into v_chosen from public.qorpera_cloud_routine_versions version
			where version.routine_id = v_wake.routine_id and version.version = v_wake.routine_version;
		end if;
		return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then v_chosen
			else v_policy ->> 'effort' end;
	end if;
	-- 2. A member's turn in a conversation takes that conversation's choice.
	if p_run.source_kind = 'room_delivery' or (p_run.source_kind = 'session_turn' and not v_first_run) then
		if v_policy ->> 'overrides' = 'routine-and-thread' then
			select choice.reasoning_effort into v_chosen
			from public.qorpera_session_models choice where choice.session_id = p_run.session_id;
		end if;
		return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then v_chosen
			else v_policy ->> 'effort' end;
	end if;
	if not (v_policy ? 'unattended') or p_run.source_kind not in ('wake','session_turn') then
		return v_policy ->> 'effort'; end if;
	-- 3. Work that carries on the agent's own chain keeps the effort of the chain's first run. A worker's own run is the
	--    worker's, so it takes its own effort below.
	if v_wake.origin_run_id is not null and v_wake.source_kind is distinct from 'worker-dispatch' then
		select origin.reasoning_effort into v_chosen from public.qorpera_execution_runs origin
		where origin.id = v_wake.origin_run_id and origin.profile_id = p_run.profile_id
			and origin.environment_id = p_run.environment_id and origin.staff_agent_id = p_run.staff_agent_id
			and origin.requested_by_user_id = p_run.requested_by_user_id;
		if public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then return v_chosen; end if;
	end if;
	-- 4. A run no member waits on: the agent's agent.md effort, else the policy's.
	select version.structured #>> '{parse,effort}' into v_chosen
	from public.qorpera_profile_staff staff
	join public.qorpera_folder_path_versions version on version.version = staff.folder_path_version
	where staff.profile_id = p_run.profile_id and staff.staff_agent_id = p_run.staff_agent_id
		and version.structured ->> 'kind' = 'agent';
	return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then v_chosen
		else v_policy ->> 'unattended' end;
end
$$;
revoke all on function public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_pin_execution_reasoning_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_manifest jsonb;
begin
	if tg_op = 'UPDATE' then
		if (new.reasoning_effort,new.reasoning_policy_sha256) is distinct from
			(old.reasoning_effort,old.reasoning_policy_sha256) then
			raise exception 'Execution reasoning policy is immutable' using errcode = '42501'; end if;
	else
		v_manifest := public.qorpera_execution_runtime_manifest(new);
		-- Caller hints and job flags cannot override the admitted bundle. A routine wake takes its routine version's
		-- effort and a member's turn its conversation's choice (contract 17); under a bundle that declares `unattended`,
		-- work that carries on a chain keeps its first run's effort and any other run no member waits on takes its
		-- agent's agent.md effort, else that one (20260930532000); anything else runs at the bundle default.
		new.reasoning_effort := public.qorpera_resolve_run_reasoning_effort(new, v_manifest);
		new.reasoning_policy_sha256 := encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex');
	end if;
	return new;
end
$$;

do $guard$
begin
	if strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure),
		'20260930532000') = 0 then
		raise exception '20260930532000: the manifest did not change as expected'; end if;
end $guard$;
