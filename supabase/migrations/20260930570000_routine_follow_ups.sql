-- Routine follow-ups (deploy/first-node/RUNTIME-COMPANY-PACE.md; 5 November 2026: in four test companies every agent
-- set its next look for 09:00 the next morning, so all work stopped at 17:16 and nothing ran for 16 hours). Folder-v2
-- only.
--
-- When an agent's own open work moved and nothing else will wake it soon, its next dynamic routine run comes early:
-- * Open work: the agent's open todos (not blocked, so no person to wait for) that changed since the routine last ran
--   (or was set up), with no worker still at them (its report wakes the agent) and none a member stopped, and not last
--   saved by a run a member stopped.
-- * Soon: once those todos have been quiet for the wait, while the agent runs nothing and has nothing else queued before
--   that routine's chosen run. The wait is 30 minutes plus the agent's own offset (1 to 20 minutes, as the runtime
--   spreads round start times: qorpera_routine_agent_offset_minutes); after a run brought forward, the next one waits
--   twice as long (1 hour, 2, 4, ...), and a run the agent's own time brought resets it. So a todo that keeps changing
--   comes back less and less often, and a run that changes nothing ends the follow-ups.
-- * Which routine: the agent's dynamic routine (no `after`) whose queued run is its earliest wake, only when that run is
--   further away than the wait. Routines that are paused, concluded or expired, a paused company, an archived agent, a
--   member's Stop of the routine's latest run, quiet hours and the routine's end keep their rules: the tick's existing
--   checks run first, and the insert's lifecycle trigger holds a run in quiet hours.
-- * How: the folder tick (qorpera_folder_dynamic_routines_due, then qorpera_folder_restore_dynamic_routine_run, every
--   30 s) lists such a routine, and the restore cancels the queued run ('Brought forward: ...') and inserts the next
--   attempt of the same version now, in one subtransaction with the admission (undone together if the kernel refuses
--   it). Its payload says `followUp`: the step and up to 5 todo paths. The run decides next as any dynamic run does.
-- * Reads only, by the indexes the tick already uses: the routine's occurrences, the agent's open todos
--   (qorpera_runtime_agent_todos_open), their workers and commits, the company's queued jobs and wakes.
-- The pre-check refuses unless both bodies are exactly the ones they replace, by md5 (the tick of 20260930009500 with
-- the changes of 20260930027000 and 20260930565000), and each anchor must occur once. The catalog check refuses unless
-- exactly these two public functions changed, only in their bodies, each by its replacements, and the two new functions
-- are the only ones that came.
-- Deploy order: either. The runtime's prompt explains wake.payload.followUp; an older runtime reads it as data.
-- Every inserted text names this migration (20260930570000), for the deploy guard.

do $$
declare v record;
begin
	if to_regprocedure('public.qorpera_routine_follow_up(public.qorpera_cloud_routines,jsonb)') is not null then
		raise exception '20260930570000 (routine follow-ups) is already applied'; end if;
	if to_regprocedure('public.qorpera_routine_listening(public.qorpera_cloud_routines,jsonb)') is null then
		raise exception '20260930570000 (routine follow-ups) needs L1 (20260930565000)'; end if;
	-- The bodies it replaces, by their md5: anything else refuses this migration.
	for v in select * from (values
		('public.qorpera_folder_dynamic_routines_due(uuid,integer)', 'b4887f977c2bbf677a6d0268d2fa1e3e'),
		('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)', '32ec70a82800695e1849a098cd637ac5'))
		as pinned(signature, source)
	loop
		if md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure(v.signature)), '')) <> v.source then
			raise exception '20260930570000 (routine follow-ups): % differs from its pinned body', v.signature; end if;
	end loop;
end $$;

set local lock_timeout = '3s';

-- The catalog check's baseline: every public function's catalog row apart from its body, and its body's md5.
create temporary table fu_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source, null::text as expected
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.fu_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930570000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	-- What the catalog check expects: the body with this replacement and the ones before it.
	update pg_temp.fu_before as prior set expected = md5(replace(
		(select p.prosrc from pg_proc as p where p.oid = p_function), p_old, p_new)) where prior.oid = p_function;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The agent's offset and the follow-up ----------------------------------------------------------------------------

-- The agent's offset in minutes, 1 to 20, as the runtime's cloudRoutineAgentOffsetMinutes (cloud-routine-pace.ts): the
-- first 32 bits of the md5 of its lowercase id, modulo 20, plus 1.
create function public.qorpera_routine_agent_offset_minutes(p_staff_agent_id uuid)
returns integer language sql immutable set search_path = '' as $$
	-- 20260930570000.
	select (('x' || lpad(left(md5(lower(p_staff_agent_id::text)), 8), 16, '0'))::bit(64)::bigint % 20 + 1)::integer
$$;
revoke all on function public.qorpera_routine_agent_offset_minutes(uuid) from public, anon, authenticated, service_role;

-- Whether this dynamic routine's queued next run is brought forward now, and why: {step, todos}, else null.
create function public.qorpera_routine_follow_up(p_routine public.qorpera_cloud_routines, p_trigger jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_pending public.qorpera_wake_occurrences%rowtype; v_last public.qorpera_wake_occurrences%rowtype;
	v_step integer; v_wait interval; v_since timestamptz; v_changed timestamptz; v_todos jsonb;
begin
	-- 20260930570000.
	if p_routine.status is distinct from 'active' or p_routine.origin is distinct from 'agent'
		or p_routine.owner_staff_agent_id is null or p_trigger ->> 'kind' is distinct from 'once' or p_trigger ? 'after' then
		return null; end if;
	-- The run the agent chose: queued for the current version.
	select * into v_pending from public.qorpera_wake_occurrences as wake
	where wake.routine_id = p_routine.id and wake.routine_version = p_routine.current_version and wake.status = 'queued'
	order by wake.created_at desc, wake.id desc limit 1;
	if not found then return null; end if;
	-- The routine's latest run: a member's Stop of it ends the follow-ups; one brought forward doubles the wait.
	select * into v_last from public.qorpera_wake_occurrences as wake
	where wake.routine_id = p_routine.id and wake.run_id is not null
	order by wake.created_at desc, wake.id desc limit 1;
	if v_last.run_id is not null and exists (select 1 from public.qorpera_runner_jobs as job
		where job.run_id = v_last.run_id and job.cancelled_by_user_id is not null) then return null; end if;
	v_step := case when jsonb_typeof(v_last.payload -> 'followUp' -> 'step') = 'number'
		then (v_last.payload -> 'followUp' ->> 'step')::integer + 1 else 1 end;
	v_wait := interval '30 minutes' * power(2, least(v_step - 1, 8))
		+ interval '1 minute' * public.qorpera_routine_agent_offset_minutes(p_routine.owner_staff_agent_id);
	-- Not when the chosen run comes within the wait anyway.
	if v_pending.not_before <= statement_timestamp() + v_wait then return null; end if;
	-- The open work that moved: newest first, at most 5 named.
	v_since := coalesce((select run.created_at from public.qorpera_execution_runs as run where run.id = v_last.run_id),
		p_routine.created_at);
	select max(todo.updated_at), jsonb_agg(left(todo.folder_path, 400) order by todo.updated_at desc)
	into v_changed, v_todos
	from (select t.folder_path, t.updated_at from public.qorpera_runtime_agent_todos as t
		where t.profile_id = p_routine.profile_id and t.staff_agent_id = p_routine.owner_staff_agent_id
			and t.state = 'open' and t.updated_at > v_since and t.folder_path is not null and t.folder_retired_at is null
			and not exists (select 1 from public.qorpera_runtime_workers as worker where worker.todo_id = t.id
				and (worker.state = 'active' or worker.result ->> 'reason' = 'member_stopped'))
			and not exists (select 1 from public.qorpera_folder_commits as c
				join public.qorpera_runner_jobs as job on job.run_id = c.run_id
				where c.id = t.folder_commit_id and job.cancelled_by_user_id is not null)
		order by t.updated_at desc limit 5) as todo;
	-- Quiet for the wait since the last change.
	if v_changed is null or v_changed + v_wait > statement_timestamp() then return null; end if;
	-- The agent is idle: no run of its own queued or working, nothing else of its own queued before this run.
	if exists (select 1 from public.qorpera_runner_jobs as job join public.qorpera_execution_runs as run on run.job_id = job.id
			where job.profile_id = p_routine.profile_id and job.status in ('queued', 'leased')
				and run.staff_agent_id = p_routine.owner_staff_agent_id)
		or exists (select 1 from public.qorpera_wake_occurrences as wake
			where wake.profile_id = p_routine.profile_id and wake.status = 'queued'
				and wake.staff_agent_id = p_routine.owner_staff_agent_id and wake.id <> v_pending.id
				and (wake.not_before < v_pending.not_before
					or (wake.not_before = v_pending.not_before and wake.id < v_pending.id))) then
		return null; end if;
	return jsonb_build_object('step', v_step, 'todos', v_todos);
end $$;
revoke all on function public.qorpera_routine_follow_up(public.qorpera_cloud_routines, jsonb)
	from public, anon, authenticated, service_role;

-- 2. The tick lists it, and the restore brings it forward --------------------------------------------------------------

select pg_temp.fu_replace('public.qorpera_folder_dynamic_routines_due(uuid,integer)'::regprocedure,
	$old$			and not public.qorpera_company_deleting(routine.profile_id)
	), page as ($old$,
	$new$			and not public.qorpera_company_deleting(routine.profile_id)
		union
		-- 20260930570000: a dynamic routine whose queued next run a follow-up brings forward (the restore does).
		select routine.id, routine.current_version from public.qorpera_cloud_routines as routine
		join public.qorpera_cloud_routine_versions as version
			on version.routine_id = routine.id and version.version = routine.current_version
		where routine.status = 'active' and routine.origin = 'agent' and version.triggers -> 0 ->> 'kind' = 'once'
			and (p_after_routine_id is null or routine.id > p_after_routine_id)
			and public.qorpera_company_is_folder_v2(routine.profile_id)
			and not public.qorpera_company_execution_paused(routine.profile_id)
			and public.qorpera_routine_follow_up(routine, version.triggers -> 0) is not null
	), page as ($new$);

select pg_temp.fu_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$	v_session uuid; v_occurrence public.qorpera_wake_occurrences%rowtype; v_owner uuid; v_error text;$old$,
	$new$	v_session uuid; v_occurrence public.qorpera_wake_occurrences%rowtype; v_owner uuid; v_error text;
	-- 20260930570000: the queued run a follow-up brings forward, and why.
	v_queued uuid; v_follow jsonb;$new$);
select pg_temp.fu_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$	if v_id is not null then return jsonb_build_object('status', 'pending', 'occurrence_id', v_id); end if;$old$,
	$new$	-- 20260930570000: a queued run a follow-up brings forward goes on through the checks below, then gives way to a run
	-- now; any other is pending.
	if v_id is not null then
		v_follow := public.qorpera_routine_follow_up(v_routine, v_trigger);
		if v_follow is null then return jsonb_build_object('status', 'pending', 'occurrence_id', v_id); end if;
		v_queued := v_id;
	end if;$new$);
select pg_temp.fu_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$		else statement_timestamp() + least(interval '15 minutes' * power(2, least(v_ended - 4, 12)), interval '1 day') end;$old$,
	$new$		else statement_timestamp() + least(interval '15 minutes' * power(2, least(v_ended - 4, 12)), interval '1 day') end;
	-- 20260930570000: a run brought forward starts now.
	if v_follow is not null then v_at := statement_timestamp(); end if;$new$);
select pg_temp.fu_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$		perform public.qorpera_folder_admit_wakes(v_routine.profile_id);$old$,
	$new$		perform public.qorpera_folder_admit_wakes(v_routine.profile_id);
		-- 20260930570000: the queued run gives way, undone with the new one if the kernel refuses it.
		if v_follow is not null then
			update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
				blocked_reason = 'Brought forward: open todos of the agent changed and are still open'
			where id = v_queued and status = 'queued';
			if not found then return jsonb_build_object('status', 'busy'); end if;
		end if;$new$);
select pg_temp.fu_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$				else '{}'::jsonb end)
		returning * into v_occurrence;$old$,
	$new$				else '{}'::jsonb end
			-- 20260930570000: a run brought forward says so: its step and the todos that changed.
			|| case when v_follow is not null then jsonb_build_object('followUp', v_follow) else '{}'::jsonb end)
		returning * into v_occurrence;$new$);

drop function pg_temp.fu_replace(regprocedure, text, text);

-- 3. The guard ---------------------------------------------------------------------------------------------------------

do $guard$
declare v record; v_source text; v_at integer; v_next integer;
begin
	for v in select * from (values
		('public.qorpera_folder_dynamic_routines_due(uuid,integer)', 1, array['qorpera_company_deleting', 'union',
			'20260930570000', 'qorpera_routine_follow_up', 'page as']),
		('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)', 5, array['v_error text', '20260930570000',
			'v_queued uuid; v_follow jsonb', 'qorpera_dynamic_routine_pending_occurrence', '20260930570000', 'qorpera_routine_follow_up',
			'''pending''', 'v_queued := v_id', 'Runs of one routine never overlap', 'A member''s Stop', 'interval ''1 day'') end',
			'20260930570000', 'v_at := statement_timestamp()', 'qorpera_folder_admit_wakes', '20260930570000',
			'Brought forward', 'where id = v_queued', 'insert into public.qorpera_wake_occurrences', '20260930565000', '20260930570000',
			'''followUp''', 'returning * into v_occurrence'])) as guard(signature, markers, texts)
	loop
		v_source := (select prosrc from pg_proc where oid = v.signature::regprocedure);
		if (length(v_source) - length(replace(v_source, '20260930570000', ''))) / length('20260930570000') <> v.markers then
			raise exception '20260930570000 marker is not % times in %', v.markers, v.signature; end if;
		v_at := 0;
		for i in 1 .. cardinality(v.texts) loop
			v_next := strpos(substr(v_source, v_at + 1), v.texts[i]);
			if v_next = 0 then
				raise exception '20260930570000 check is out of place in %: %', v.signature, v.texts[i]; end if;
			v_at := v_at + v_next;
		end loop;
	end loop;
end $guard$;

-- The catalog check ---------------------------------------------------------------------------------------------------

-- Exactly the two functions changed, each only in its body and by its replacements; every other public function is as
-- it was, none went, and the two new ones are the only ones that came.
do $$ begin
	if (select count(*) from pg_temp.fu_before where expected is not null) <> 2
		or exists (select 1 from pg_temp.fu_before as prior where prior.expected is not null and prior.oid not in (
			'public.qorpera_folder_dynamic_routines_due(uuid,integer)'::regprocedure,
			'public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure))
		or exists (select 1 from pg_temp.fu_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or md5(patched.prosrc) is distinct from coalesce(prior.expected, prior.source)
				or prior.expected = prior.source)
		or (select array_agg(p.oid order by p.oid) from pg_proc as p
			where p.pronamespace = 'public'::regnamespace and p.oid not in (select prior.oid from pg_temp.fu_before as prior))
			is distinct from (select array_agg(added order by added) from unnest(array[
				to_regprocedure('public.qorpera_routine_agent_offset_minutes(uuid)'),
				to_regprocedure('public.qorpera_routine_follow_up(public.qorpera_cloud_routines,jsonb)')]::oid[]) as added) then
		raise exception '20260930570000: the catalog did not change as expected'; end if;
end $$;

drop table pg_temp.fu_before;
