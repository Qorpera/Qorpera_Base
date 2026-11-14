-- 20260930770000 (Claude Code on the agent's home, slice C4a; lanes/agent-box-20261113/C4-WORKER-DESIGN.md as the lane's
-- lead ruled it, 14 Nov 2026): a plain worker that Claude Code does, on a member's word, on that member's own Claude plan.
--
-- 1. A plain worker's brief may name `harness: claude-code` (Codex stays the unsaid default; a coding session's harness is
--    unchanged). The brief's keys take it, and manage_worker's dispatch request carries it.
-- 2. Admission stays as it is: such a worker is checked, started and admitted exactly as a plain worker is today (the
--    run's own payer, its ordinary binding). What is new is checked at the dispatch, in words the dispatching agent can
--    act on (qorpera_claude_worker_problem): a member behind the ask (the run's requester, and no routine at the root of
--    its chain), that member on the Claude sign-in list with the sign-in open here (#1428,
--    20260930564000), an active Claude login of that member, and this agent's own machine running for that member's
--    work (the home, 20260930752000 and 20260930754000): without the home there is nowhere to run it.
-- 3. The payer is that member, fixed at the dispatch as a coding session's owner is: the worker row records the member's
--    Claude login (claude_login_id), taken again under the index's commit, so nothing later picks another. A follow-up is
--    the same member's word again, and records that member's login as it is then. #1428 makes no provider connection on
--    purpose, so nothing here reads the coding owner's login.
-- 4. The worker's wake carries `harness`, so the runtime diverts it (and an older runtime refuses the payload's unknown
--    key: a Claude Code worker never runs on Codex by accident).
-- 5. One Claude Code run per member at a time (qorpera_claude_worker_leases): F2's drain takes the member's lease when it
--    starts the worker, under the id its wake gets, and a worker whose member holds a live lease waits, due, until that
--    run has ended (the drain's skipped count, as for a busy lock). A lease is live until its wake ends or the job of the
--    wake's run ends (completed, failed or cancelled): a run whose host died is failed by the job's reaper, and its lease
--    ends with it. Nothing releases a lease by hand.
--
-- Locks: the lease row is the last lock the drain takes, after admission (core §3); nothing else locks it. The worker
-- row's two new columns are written under the index's rank-5 lock, as the rest of the row.
--
-- Exact-text patches: each fails unless the function has the text given exactly once. Every new or patched body names
-- this migration (20260930770000).

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_claude_worker_leases') is not null then
		raise exception 'Claude Code workers (20260930770000) are already applied'; end if;
	if to_regclass('public.qorpera_claude_logins') is null
		or to_regprocedure('public.qorpera_company_home_allowed(uuid)') is null
		or to_regprocedure('public.qorpera_folder_home_shared(public.qorpera_company_machines, uuid, uuid, uuid)') is null then
		raise exception 'Claude Code workers (20260930770000) need 20260930564000, 20260930752000 and 20260930754000 first'; end if;
end $$;

create function pg_temp.c4a_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C4a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The worker's harness and payer, and the member's lease ------------------------------------------------------------

alter table public.qorpera_runtime_workers
	add column harness text check (harness is null or harness = 'claude-code'),
	-- The asking member's Claude login that pays, recorded at the dispatch (and at each follow-up).
	add column claude_login_id uuid references public.qorpera_claude_logins(id) on delete set null,
	add constraint qorpera_runtime_workers_claude_code check (harness is null or species = 'in-house'),
	add constraint qorpera_runtime_workers_claude_login check (claude_login_id is null or harness = 'claude-code');

-- One Claude Code run per member at a time: the member's last lease, live while its wake and its run go on.
create table public.qorpera_claude_worker_leases (
	owner_user_id uuid primary key references auth.users(id) on delete cascade,
	worker_id uuid not null references public.qorpera_runtime_workers(id) on delete cascade,
	-- Taken just before the drain inserts the wake under this id, in the same transaction.
	wake_id uuid not null references public.qorpera_wake_occurrences(id) on delete cascade deferrable initially deferred,
	taken_at timestamptz not null default clock_timestamp()
);
create index qorpera_claude_worker_leases_wake on public.qorpera_claude_worker_leases(wake_id);
create index qorpera_claude_worker_leases_worker on public.qorpera_claude_worker_leases(worker_id);
alter table public.qorpera_claude_worker_leases enable row level security;
revoke all on public.qorpera_claude_worker_leases from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether a lease still holds: until its wake ended, or the job of its wake's run ended. A wake this statement cannot see
-- (taken by a transaction that committed after it began) holds.
create function public.qorpera_claude_worker_lease_live(p_lease public.qorpera_claude_worker_leases)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930770000.
	select p_lease.wake_id is not null and not exists (select 1 from public.qorpera_wake_occurrences wake
		where wake.id = p_lease.wake_id
			and (wake.status in ('completed','failed','cancelled','requires_review')
				or exists (select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
					where run.id = wake.run_id and job.status in ('completed','failed','cancelled'))))
$$;
revoke all on function public.qorpera_claude_worker_lease_live(public.qorpera_claude_worker_leases)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Takes the worker's member's lease for the wake about to be inserted under p_wake_id; false while another of that
-- member's leases is live (the worker waits). Concurrent takes queue on the member's row, and the later one sees the
-- earlier one's lease as live.
create function public.qorpera_claude_worker_lease_take(p_worker public.qorpera_runtime_workers, p_wake_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_taken uuid;
begin
	-- 20260930770000.
	if p_worker.harness is distinct from 'claude-code' or p_worker.requested_by_user_id is null or p_wake_id is null then
		raise exception 'Only a Claude Code worker takes a Claude Code lease' using errcode = '22023'; end if;
	insert into public.qorpera_claude_worker_leases as lease (owner_user_id, worker_id, wake_id)
	values (p_worker.requested_by_user_id, p_worker.id, p_wake_id)
	on conflict (owner_user_id) do update set worker_id = excluded.worker_id, wake_id = excluded.wake_id,
		taken_at = clock_timestamp()
	where not public.qorpera_claude_worker_lease_live(lease)
	returning lease.wake_id into v_taken;
	return v_taken is not distinct from p_wake_id;
end $$;
revoke all on function public.qorpera_claude_worker_lease_take(public.qorpera_runtime_workers, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The checks at the dispatch ---------------------------------------------------------------------------------------

-- A member's name as the agent knows them in this company; never an id.
create function public.qorpera_claude_worker_member_name(p_profile_id uuid, p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930770000.
	select coalesce((select nullif(btrim(member.display_name), '') from public.qorpera_profile_members member
		where member.profile_id = p_profile_id and member.user_id = p_user_id), 'the member who asked')
$$;
revoke all on function public.qorpera_claude_worker_member_name(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether this agent's own machine is running for the member's work now, as the home's offer
-- (qorpera_company_home_available) finds it for p_run_id: the switch, the machines, and a machine of this agent that
-- this run may share, running and reserved.
create function public.qorpera_claude_worker_home(p_profile_id uuid, p_staff_agent_id uuid, p_member_user_id uuid,
	p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930770000.
	select public.qorpera_company_home_allowed(p_profile_id) and public.qorpera_company_machines_available()
		and exists (select 1 from public.qorpera_company_machines machine
			where machine.profile_id = p_profile_id and machine.started_by_staff_agent_id = p_staff_agent_id
				and public.qorpera_folder_home_shared(machine, p_staff_agent_id, p_member_user_id, p_run_id)
				and machine.removed_at is null and machine.desired_state = 'running'
				and (public.qorpera_company_machine_placement(machine.id)).running_at is not null
				and public.qorpera_company_machine_reserved(machine))
$$;
revoke all on function public.qorpera_claude_worker_home(uuid, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Why the run p_run_id of agent p_staff_agent_id cannot hand work to Claude Code, in words the agent can act on; null
-- when it can. The member is the run's requester, and only when no routine stands at the root of the run's chain: a
-- routine's own run, or work that came from one, has no member's word behind it.
create function public.qorpera_claude_worker_problem(p_profile_id uuid, p_staff_agent_id uuid, p_run_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_member uuid; v_name text;
begin
	-- 20260930770000.
	select run.* into v_run from public.qorpera_execution_runs run where run.id = p_run_id and run.profile_id = p_profile_id;
	v_member := v_run.requested_by_user_id;
	if v_run.id is null or v_member is null
		or not exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.user_id = v_member)
		-- The run's wakes: at least one whose chain a member started (a run with no wake is a member's turn).
		or (exists (select 1 from public.qorpera_wake_occurrences wake where wake.run_id = v_run.id)
			and not exists (select 1 from public.qorpera_wake_occurrences wake
				join public.qorpera_wake_occurrences root on root.id = wake.causal_root_id
				where wake.run_id = v_run.id and root.wake_kind <> 'routine')) then
		return 'Claude Code works on a member''s word, and no member asked for this work: dispatch this worker without Claude Code';
	end if;
	v_name := public.qorpera_claude_worker_member_name(p_profile_id, v_member);
	if not exists (select 1 from public.qorpera_claude_sign_in_members allowed where allowed.user_id = v_member) then
		return format('Claude Code is not open for %s yet: dispatch this worker without Claude Code', v_name); end if;
	if not public.qorpera_claude_sign_in_open(p_profile_id, v_member) then
		return 'Claude Code is not open in this company yet: dispatch this worker without Claude Code'; end if;
	if not exists (select 1 from public.qorpera_claude_logins login where login.owner_user_id = v_member
		and login.status = 'active') then
		return format('Claude Code needs %1$s''s own Claude sign-in. Ask %1$s to sign in to Claude in Settings, Model accounts, '
			|| 'or dispatch this worker without Claude Code.', v_name); end if;
	if not public.qorpera_claude_worker_home(p_profile_id, p_staff_agent_id, v_member, v_run.id) then
		return format('Claude Code works on your own machine, and none is running for %s''s work now: start your machine, '
			|| 'or dispatch this worker without Claude Code', v_name); end if;
	return null;
end $$;
revoke all on function public.qorpera_claude_worker_problem(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The member's Claude login that pays for their Claude Code worker, read under the index's commit; with the words of the
-- check above when there is none (the commit then fails whole).
create function public.qorpera_claude_worker_login(p_profile_id uuid, p_member_user_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_login uuid;
begin
	-- 20260930770000.
	select login.id into v_login from public.qorpera_claude_logins login
	where login.owner_user_id = p_member_user_id and login.status = 'active'
		and public.qorpera_claude_sign_in_open(p_profile_id, p_member_user_id);
	if v_login is null then
		raise exception 'Claude Code needs %''s own Claude sign-in. Ask them to sign in to Claude in Settings, Model accounts, or dispatch this worker without Claude Code.',
			public.qorpera_claude_worker_member_name(p_profile_id, p_member_user_id) using errcode = '55000'; end if;
	return v_login;
end $$;
revoke all on function public.qorpera_claude_worker_login(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. The brief: a plain worker's may name claude-code -------------------------------------------------------------------

select pg_temp.c4a_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$			else array['access','authority','cancellation','completion','context','dispatchedAt','doneWhen','followUp','followUps',
				'followedUpAt','goal','id','kind','output','revival','sources','species','title'] end) then
			v_bad := array_append(v_bad, 'keys'); end if;$old$,
	$new$			-- 20260930770000: a plain worker's brief may name its harness, claude-code (Codex is the unsaid default).
			when p_parse ? 'harness' then
				array['access','authority','cancellation','completion','context','dispatchedAt','doneWhen','followUp','followUps',
					'followedUpAt','goal','harness','id','kind','output','revival','sources','species','title']
			else array['access','authority','cancellation','completion','context','dispatchedAt','doneWhen','followUp','followUps',
				'followedUpAt','goal','id','kind','output','revival','sources','species','title'] end) then
			v_bad := array_append(v_bad, 'keys'); end if;
		if p_parse ->> 'species' is distinct from 'coding' and p_parse ? 'harness'
			and p_parse -> 'harness' is distinct from '"claude-code"'::jsonb then
			v_bad := array_append(v_bad, 'harness'); end if;$new$);

-- 4. The rules ---------------------------------------------------------------------------------------------------------

select pg_temp.c4a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$			elsif v_species not in ('in-house','coding')
				or (v_species = 'in-house' and v_request ?| array['harness','repository','owner']) then
				v_problem := 'Worker species is invalid';$old$,
	$new$			elsif v_species not in ('in-house','coding')
				-- 20260930770000: a plain worker may name one harness, claude-code; Codex is the unsaid default.
				or (v_species = 'in-house' and (v_request ?| array['repository','owner']
					or (v_request ? 'harness' and v_request -> 'harness' is distinct from '"claude-code"'::jsonb))) then
				v_problem := 'Worker species is invalid';
			-- 20260930770000: Claude Code works on a member's word, on that member's own Claude sign-in and on this agent's
			-- own machine; the run's own payer (above) is checked as for any plain worker.
			elsif v_species = 'in-house' and v_request ? 'harness'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then
				v_problem := public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id);$new$);

select pg_temp.c4a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$				v_problem := 'This coding session runs for another member';$old$,
	$new$				v_problem := 'This coding session runs for another member';
			-- 20260930770000: a Claude Code worker is paid by the member who asked for it; a follow-up is that member's word
			-- again, checked as its dispatch was.
			elsif v_worker.harness = 'claude-code'
				and v_worker.requested_by_user_id is distinct from (p_actor ->> 'requesterUserId')::uuid then
				v_problem := 'This worker runs on another member''s Claude plan: dispatch a new worker for this work';
			elsif v_worker.harness = 'claude-code'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then
				v_problem := public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id);$new$);

-- 5. The index: the payer recorded ------------------------------------------------------------------------------------

select pg_temp.c4a_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$			case when p_parse ->> 'species' = 'coding' then v_commit.requester_id end, v_binding, v_version)
		returning * into v_worker;$old$,
	$new$			case when p_parse ->> 'species' = 'coding' then v_commit.requester_id end, v_binding, v_version)
		returning * into v_worker;
		-- 20260930770000: a plain worker on Claude Code is paid by the asking member's own Claude login, taken again here
		-- (the rules read it before this commit's lock) and recorded, so nothing later picks another.
		if p_parse ->> 'species' = 'in-house' and p_parse ->> 'harness' = 'claude-code' then
			update public.qorpera_runtime_workers set harness = 'claude-code',
				claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_commit.requester_id)
			where id = v_worker.id returning * into v_worker;
		end if;$new$);

select pg_temp.c4a_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		-- 20260930077000 (C3a): a coding session's next turn waits for its executor, as its first did.$old$,
	$new$		-- 20260930770000: a Claude Code worker's follow-up is paid by its member's Claude login as it is now.
		if v_worker.harness = 'claude-code' then
			update public.qorpera_runtime_workers
			set claude_login_id = public.qorpera_claude_worker_login(p_profile_id, v_worker.requested_by_user_id)
			where id = v_worker.id returning * into v_worker;
		end if;
		-- 20260930077000 (C3a): a coding session's next turn waits for its executor, as its first did.$new$);

-- 6. The wake carries the harness ---------------------------------------------------------------------------------------

create or replace function public.qorpera_folder_worker_dispatch_payload(p_worker public.qorpera_runtime_workers,
	p_todo public.qorpera_runtime_agent_todos)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930003100 (F2-5b-3); 20260930770000: a Claude Code worker's wake names its harness, so the runtime diverts it.
	select jsonb_build_object('schema','qorpera.worker-dispatch/v1','workerId',p_worker.id,'workerKey',p_worker.worker_key,
		'sequence',p_worker.sequence,'species',p_worker.species,'title',p_worker.title,
		'todo',jsonb_build_object('todoKey',p_todo.todo_key,'title',p_todo.title,'path',p_todo.folder_path),
		'parentRunId',p_worker.steering_run_id,'access',p_worker.access,'outputFolder',p_worker.folder_path,
		'dispatch',p_worker.dispatch)
		|| case when p_worker.harness is null then '{}'::jsonb else jsonb_build_object('harness', p_worker.harness) end
$$;

-- 7. The drain: one Claude Code run per member ------------------------------------------------------------------------

select pg_temp.c4a_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$	v_undeliverable integer := 0; v_skipped integer := 0;$old$,
	$new$	v_undeliverable integer := 0; v_skipped integer := 0;
	v_start uuid; -- 20260930770000: the id of the dispatch wake a start inserts$new$);

select pg_temp.c4a_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$					elsif v_worker.occurrence_id is null then
						-- Start it: the dispatch wake, admitted above. One the pin trigger cancels at insert fails the worker.$old$,
	$new$					elsif v_worker.occurrence_id is null then
						-- 20260930770000: a Claude Code worker first takes its member's lease, under the id its wake gets; while
						-- another Claude Code run of that member goes on it waits here, due, and starts on a later pass.
						v_start := extensions.gen_random_uuid();
						if v_worker.harness = 'claude-code' then
							if not public.qorpera_claude_worker_lease_take(v_worker, v_start) then
								v_skipped := v_skipped + 1;
								continue;
							end if;
						end if;
						-- Start it: the dispatch wake, admitted above. One the pin trigger cancels at insert fails the worker.$new$);

select pg_temp.c4a_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$						values (extensions.gen_random_uuid(), v_profile, p_environment_id, 'agent', 'worker-dispatch', v_worker.id,$old$,
	$new$						values (v_start, v_profile, p_environment_id, 'agent', 'worker-dispatch', v_worker.id,$new$);
