-- 20260930747000 (agent-box B1, 13 Nov 2026): an agent's machine is ready and used again.
--
-- Measured 8-13 Nov: a conversation agent's first command came p50 89.8 s after machine_start, because it had to end
-- its run and be woken in a new one, against 36.5 s for a worker, which waits in its run; and agents made a new machine
-- for almost every task (59 of 122 boots), a new disk costing about 7 s more than a woken one.
--
-- * A run that saw its machine running is not woken to be told. A conversation's run may now wait in place for its
--   machine (the runtime's machine_start waitSeconds, up to 60 s; a worker's up to 300 s as before). It stays on the
--   machine's list of runs to tell, so a wait that ends first (the time passed, the machine waits in line, the run was
--   stopped or ended) is still woken through the durable machine event, as before. When it ran, the kernel left a
--   'running' event for each run on that list; the status look (qorpera_native_machine_manage, action status, the look
--   a waiting run makes) now suppresses the looking run's own waiting 'running' events of that machine once it sees the
--   machine running: it writes only those rows of that run (never the machine row, so still no machine lock).
-- * A new task machine is the agent's own free machine of the same size, woken if it sleeps. machine_start asking for a
--   new task machine (a name, a purpose and a size) first takes, as a wake by name does, the agent's own machine that
--   fits and is free (qorpera_company_machine_reusable): of the same company and environment, started for the same agent
--   and the same member by the same kind of run (a worker's access, or none), a task machine (an always-on ask makes a
--   new machine), the same cpus and memory and at least the disk asked; and free: running, stopping or stopped (not in
--   line or starting for someone), no run waiting for it, no command running, no busy program for 90 s, no member
--   holding or sharing its desktop, and no run still going that started it, asked for it by machine_start (a wake by
--   name or a start that took it again: taken_by_run_id, the latest, and every such completed start's receipt), ran a
--   command on it or acted on its screen. The one of the asked name comes first, then a running one, then the latest
--   used. It is locked, then looked at again in a statement of its own (a command's authority locks the machine, not the
--   company's machines, so one authorized meanwhile is seen). It keeps its name and its starter (the folder mount and its
--   read checks stay its starter's, which this rule makes the asker's own); its purpose becomes the new one;
--   reused_by_receipt_id holds the start's receipt, so a replay answers that machine; the answer says `reused`. The idle
--   rule decides as before when it sleeps (an hour unused) and when it is removed (30 days asleep). Desktops, coding
--   machines, always-on machines and a member's start are as they were.
-- Every new or patched body names this migration (20260930747000), for the deploy guards.
set local lock_timeout = '3s';

do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure),
		'20260930747000') > 0 then
		raise exception '20260930747000 is already applied'; end if;
end $$;

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_ready_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930747000' in v_definition) > 0 then
		raise exception '20260930747000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930747000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930747000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The start that took a machine again --------------------------------------------------------------------------------

alter table public.qorpera_company_machines add column reused_by_receipt_id uuid, add column taken_by_run_id uuid;
comment on column public.qorpera_company_machines.reused_by_receipt_id is
	'20260930747000: the latest machine_start that took this machine again as the agent''s own free machine; a replay answers it.';
comment on column public.qorpera_company_machines.taken_by_run_id is
	'20260930747000: the run of the latest machine_start that asked for this machine (a wake by name, or taken again).';
create unique index qorpera_company_machines_reused_by_receipt on public.qorpera_company_machines (reused_by_receipt_id)
	where reused_by_receipt_id is not null;

-- 2. The agent's own free machine of the asked size -----------------------------------------------------------------------

-- Whether p_machine is one a new task machine of p_args (machine_start's arguments: name, purpose, cpus, memoryGiB,
-- diskGiB, lifetime) may be, for a run of p_identity (its tool authority's identity) whose worker access is p_access (null
-- for a run that is no worker): it fits, and it is free. Stable: it sees what the statement that calls it sees.
create function public.qorpera_company_machine_takeable(p_machine public.qorpera_company_machines, p_identity jsonb, p_args jsonb,
	p_access text)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930747000
	select p_args ->> 'lifetime' = 'task' and p_args ? 'name'
		and p_machine.profile_id = (p_identity ->> 'companyId')::uuid and p_machine.environment_id = (p_identity ->> 'environmentId')::uuid
		and p_machine.removed_at is null and p_machine.desired_state <> 'deleted' and p_machine.lifetime = 'task'
		and p_machine.started_by_staff_agent_id = (p_identity ->> 'staffAgentId')::uuid
		and p_machine.requested_by_user_id = (p_identity ->> 'requesterUserId')::uuid
		and (public.qorpera_run_worker(p_machine.started_by_run_id)).access is not distinct from p_access
		and p_machine.cpus = (p_args ->> 'cpus')::integer and p_machine.memory_bytes = (p_args ->> 'memoryGiB')::bigint * 1073741824
		and p_machine.disk_bytes >= (p_args ->> 'diskGiB')::bigint * 1073741824
		-- Free: nobody is starting it or waiting for it, nothing runs or keeps it busy, no member is at its desktop.
		and public.qorpera_company_machine_state(p_machine) in ('running', 'stopping', 'stopped')
		and cardinality(p_machine.notify_run_ids) = 0
		and not coalesce(p_machine.busy_at > clock_timestamp() - interval '90 seconds', false)
		and not coalesce(p_machine.desktop_member_until > clock_timestamp(), false)
		and not coalesce(p_machine.desktop_shared_at > clock_timestamp() - interval '10 minutes', false)
		and not exists (select 1 from public.qorpera_company_machine_commands command
			where command.machine_id = p_machine.id and command.ended_at is null)
		-- No run that still goes (its job queued or leased, the asking run too) started it, asked for it by machine_start, ran
		-- a command on it or acted on its screen: that run may come back to it.
		and not exists (select 1 from (
				select p_machine.started_by_run_id as run_id
				union all
				select p_machine.taken_by_run_id
				union all
				select receipt.run_id from public.qorpera_run_operation_receipts receipt where receipt.id = p_machine.reused_by_receipt_id
				union all
				select command.run_id from public.qorpera_company_machine_commands command where command.machine_id = p_machine.id
				union all
				select screen.run_id from public.qorpera_company_machine_screen_runs screen
				join public.qorpera_company_machine_placements placement on placement.id = screen.placement_id
				where placement.machine_id = p_machine.id) used
			join public.qorpera_execution_runs run on run.id = used.run_id
			join public.qorpera_runner_jobs job on job.id = run.job_id
			where job.status in ('queued', 'leased'))
		-- Nor any completed machine_start of a run that still goes that answered this machine (an earlier asker's, when a
		-- later one is taken_by_run_id).
		and not exists (select 1 from public.qorpera_runner_jobs job
			join public.qorpera_execution_runs run on run.job_id = job.id
			join public.qorpera_run_operation_receipts receipt on receipt.run_id = run.id
			where job.status in ('queued', 'leased') and run.profile_id = p_machine.profile_id
				and receipt.logical_operation_key like 'machine_start:%' and receipt.status = 'completed'
				and receipt.result #>> '{machine,machineId}' = p_machine.id::text)
$$;
revoke all on function public.qorpera_company_machine_takeable(public.qorpera_company_machines, jsonb, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The agent's own machine a new task machine of p_args is, for the run p_run_id of p_identity, locked; or none. Internal:
-- the caller holds the company's machines lock (one start or wake at a time), so no other start takes the same machine.
-- A command's authority, a member's hold of the desktop and the executor lock a machine without that lock: each candidate
-- is locked first and looked at again in a statement of its own, which sees what such a transaction committed.
create function public.qorpera_company_machine_reusable(p_identity jsonb, p_run_id uuid, p_args jsonb)
returns public.qorpera_company_machines language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype; v_id uuid;
	v_access text := (public.qorpera_run_worker(p_run_id)).access;
begin
	-- 20260930747000
	if p_args ->> 'lifetime' is distinct from 'task' or not p_args ? 'name' then return null; end if;
	for v_id in select machine.id from public.qorpera_company_machines machine
		where machine.profile_id = (p_identity ->> 'companyId')::uuid and machine.removed_at is null
			and public.qorpera_company_machine_takeable(machine, p_identity, p_args, v_access)
		order by machine.name = p_args ->> 'name' desc, public.qorpera_company_machine_state(machine) = 'running' desc,
			machine.last_used_at desc, machine.id loop
		select * into v_machine from public.qorpera_company_machines where id = v_id for update;
		if (select public.qorpera_company_machine_takeable(machine, p_identity, p_args, v_access)
			from public.qorpera_company_machines machine where machine.id = v_id) then
			return v_machine; end if;
	end loop;
	return null;
end $$;
revoke all on function public.qorpera_company_machine_reusable(jsonb, uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. machine_start: the replay of a start that took a machine again, and taking one --------------------------------------

do $$ begin execute pg_temp.machine_ready_patched(
	'public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	array[$old$	v_admission jsonb; v_keys text;$old$,
	$new$	v_admission jsonb; v_keys text;
	v_reused boolean := false; -- 20260930747000: this start took the agent's own free machine again$new$,
	$old$	select * into v_machine from public.qorpera_company_machines where started_by_receipt_id = v_receipt.id for update;
	if v_machine.id is null and v_args ? 'machine' then
		v_machine := public.qorpera_company_machine_named((v_identity ->> 'companyId')::uuid, v_args ->> 'machine');$old$,
	$new$	select * into v_machine from public.qorpera_company_machines where started_by_receipt_id = v_receipt.id for update;
	-- 20260930747000: a start that took the agent's own machine again answers that machine on a replay; a new task machine
	-- is first the agent's own free machine of the same size (qorpera_company_machine_reusable), woken as a wake by name.
	if v_machine.id is null then
		select * into v_machine from public.qorpera_company_machines where reused_by_receipt_id = v_receipt.id for update;
		v_reused := v_machine.id is not null;
	end if;
	if v_machine.id is null and v_args ? 'name' then
		v_machine := public.qorpera_company_machine_reusable(v_identity, v_receipt.run_id, v_args);
		if v_machine.id is not null then
			v_reused := true;
			update public.qorpera_company_machines set reused_by_receipt_id = v_receipt.id, purpose = btrim(v_args ->> 'purpose'),
				updated_at = clock_timestamp()
			where id = v_machine.id returning * into v_machine;
		end if;
	end if;
	if (v_machine.id is null and v_args ? 'machine') or v_reused then
		if not v_reused then
			v_machine := public.qorpera_company_machine_named((v_identity ->> 'companyId')::uuid, v_args ->> 'machine'); end if;$new$,
	$old$			last_used_at = clock_timestamp() where id = v_machine.id returning * into v_machine;$old$,
	$new$			last_used_at = clock_timestamp(),
			-- 20260930747000: the run asked for it (a wake by name, or taken again): it is that run's while the run goes.
			taken_by_run_id = v_receipt.run_id
		where id = v_machine.id returning * into v_machine;$new$,
	$old$	return jsonb_build_object('schema','qorpera.machine-start/v1','machine',public.qorpera_company_machine_view(v_machine));$old$,
	$new$	return jsonb_build_object('schema','qorpera.machine-start/v1','machine',public.qorpera_company_machine_view(v_machine))
		-- 20260930747000: what the agent is told when it got its own machine again, in place of a new one.
		|| case when v_reused then jsonb_build_object('reused', format(
			'your own free machine %s of this size was given to you again instead of a new one: use the name %s', v_machine.name,
			v_machine.name)) else '{}'::jsonb end;$new$]); end $$;

-- 4. The status look: a run that sees its machine running is not woken to be told -----------------------------------------

do $$ begin execute pg_temp.machine_ready_patched(
	'public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure,
	array[$old$		if not found then return jsonb_build_object('schema','qorpera.machine-status/v1','machine',null); end if;$old$,
	$new$		if not found then return jsonb_build_object('schema','qorpera.machine-status/v1','machine',null); end if;
		-- 20260930747000: a run that waited for its machine in place and sees it running knows it runs: the 'running' event the
		-- kernel left for it is not delivered after the run. Only that run's own waiting rows of this machine are written.
		if public.qorpera_company_machine_state(v_machine) = 'running' then
			update public.qorpera_company_machine_events set delivery = 'suppressed', scanned_at = clock_timestamp()
			where environment_id = v_machine.environment_id and parent_run_id = (p_binding ->> 'runId')::uuid
				and machine_id = v_machine.id and kind = 'running' and delivery = 'waiting';
		end if;$new$]); end $$;
