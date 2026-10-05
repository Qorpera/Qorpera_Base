-- The folder-v2 worker drain, F2-5b-3 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md "Plan (F2-5b)" §6), as the
-- drain `workers` of the shared folder drains (RUNTIME-COMPANY-FOLDER-LISTENER.md §9). Folder-v2 only: the legacy drain
-- (qorpera_drain_worker_wakes) keeps its text. Every new body carries the marker 20260930003100.
--
-- A dispatch or a follow-up commits its files with no wake (a refused wake must never roll back the files), so its worker
-- stays active with no occurrence until this drain starts it. One company per call, in its own transaction:
-- 1. plain reads: the due workers (to start; whose wake ended without a report; whose parent stopped or whose todo was
--    cancelled; with results waiting for a parent whose job has ended) and, for a revival, up to four waiting workers of
--    each parent;
-- 2. the fence KEY SHARE (the pause read again), rank 0, the requesters (rank 1), the agents and their execution
--    authorities (ranks 2 and 3) KEY SHARE, and at rank 5 the todos FOR SHARE and the workers FOR UPDATE (rows the drain
--    updates inside a savepoint are never left for others to key-share);
-- 3. the parents' conversations KEY SHARE (a revival's), then wake admission, last;
-- 4. one block per due worker, as the legacy drain's rules go: start it (the dispatch wake; one cancelled at insert or
--    refused makes the worker failed, not_started, so it never stays active without a wake); fail one whose wake ended
--    without a report; cancel one whose parent stopped (parent_stopped) or whose todo was cancelled (todo_cancelled), its
--    queued wake taken NOWAIT (one the materializer holds keeps the worker for the next pass); revive a parent with up to
--    four results (each or batch, one revival of a parent at a time). Results of an erased worker are suppressed (their
--    text is gone). The drain never touches a todo row.
-- Coding workers are started by their coding turns (C1c-3i) and are only revived here.

-- 1. The dispatch wake's payload: legacy's closed shape, with the folder's paths (the todo's file, the worker's folder).
create function public.qorpera_folder_worker_dispatch_payload(p_worker public.qorpera_runtime_workers,
	p_todo public.qorpera_runtime_agent_todos)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930003100 (F2-5b-3).
	select jsonb_build_object('schema','qorpera.worker-dispatch/v1','workerId',p_worker.id,'workerKey',p_worker.worker_key,
		'sequence',p_worker.sequence,'species',p_worker.species,'title',p_worker.title,
		'todo',jsonb_build_object('todoKey',p_todo.todo_key,'title',p_todo.title,'path',p_todo.folder_path),
		'parentRunId',p_worker.steering_run_id,'access',p_worker.access,'outputFolder',p_worker.folder_path,
		'dispatch',p_worker.dispatch)
$$;

-- 2. A parent's revival still pending: queued, or materialized and its run not ended (the legacy drain's rule).
create function public.qorpera_folder_worker_revival_pending(p_parent_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930003100 (F2-5b-3).
	select exists (select 1 from public.qorpera_wake_occurrences pending
		left join public.qorpera_execution_runs pending_run on pending_run.id = pending.run_id
		left join public.qorpera_runner_jobs pending_job on pending_job.id = pending_run.job_id
		where pending.parent_run_id = p_parent_run_id and pending.source_kind = 'worker-completion'
			and (pending.status = 'queued' or (pending.status = 'materialized'
				and (pending_job.id is null or pending_job.status in ('queued','leased')))))
$$;

-- 3. Whether a worker has work for the drain now (plain reads, so the due list leaves out companies it would only answer
-- idle for): an in-house worker with no wake yet, whose wake ended without a report, or whose parent stopped or todo was
-- cancelled; or results waiting for a parent whose job has ended (or that has none), unless its batch still runs or a
-- revival of it is pending. An erased worker's waiting results are due (to be suppressed).
create function public.qorpera_folder_worker_due(p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930003100 (F2-5b-3).
	select case
		when p_worker.state = 'active' then p_worker.species = 'in-house' and (p_worker.occurrence_id is null
			or exists (select 1 from public.qorpera_wake_occurrences w where w.id = p_worker.occurrence_id
				and w.status in ('completed','failed','cancelled','requires_review'))
			or exists (select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
				where r.id = p_worker.steering_run_id and j.status = 'cancelled')
			or public.qorpera_worker_revival_stopped(p_worker.steering_run_id)
			or exists (select 1 from public.qorpera_runtime_agent_todos t where t.id = p_worker.todo_id and t.state = 'cancelled'))
		when p_worker.completion_state = 'waiting' then p_worker.folder_erased_at is not null
			or (not exists (select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
					where r.id = p_worker.steering_run_id and j.status in ('queued','leased'))
				and not (p_worker.revival = 'batch' and p_worker.state <> 'blocked' and exists (select 1
					from public.qorpera_runtime_workers s where s.steering_run_id = p_worker.steering_run_id and s.state = 'active'))
				and not public.qorpera_folder_worker_revival_pending(p_worker.steering_run_id))
		else false end
$$;

-- 4. A worker that ended, or never started, without a report: a failure its parent hears about (the legacy reasons).
create function public.qorpera_folder_worker_ended(p_worker public.qorpera_runtime_workers, p_occurrence_id uuid,
	p_occurrence_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_reason text;
begin
	-- 20260930003100 (F2-5b-3).
	v_reason := case when p_occurrence_id is not null and public.qorpera_worker_run_member_stopped(p_occurrence_id) then 'member_stopped'
		when p_occurrence_status is distinct from 'completed' and p_occurrence_status is distinct from 'failed'
			and p_occurrence_status is distinct from 'requires_review' then 'not_started'
		when public.qorpera_computer_hour_wake_ended_out_of_hours(p_occurrence_id) then 'out_of_computer_hours'
		else 'ended_without_report' end;
	update public.qorpera_runtime_workers set state = 'failed', reported_at = clock_timestamp(), completion_state = 'waiting',
		occurrence_id = coalesce(p_occurrence_id, occurrence_id), updated_at = clock_timestamp(),
		result = jsonb_build_object('outcome', 'failed', 'outputs', '[]'::jsonb, 'sequence', p_worker.sequence, 'reason', v_reason,
			'summary', case v_reason when 'member_stopped' then 'A member stopped the background work.'
				when 'not_started' then 'The background work could not start.'
				when 'out_of_computer_hours' then 'The background work was stopped because the company is out of computer hours.'
				else 'The background work ended without reporting a result.' end)
	where id = p_worker.id and state = 'active';
	if not found then return; end if;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, body)
	values (p_worker.id, p_worker.sequence, 'ended', jsonb_build_object('occurrenceStatus', coalesce(p_occurrence_status, 'refused')));
end $$;

-- 5. The due list (LISTENER §9): folder-v2 environments with a due worker, not paused and not being deleted (the drain
-- does nothing while paused), in environment order after the cursor.
create function public.qorpera_folder_workers_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_environments uuid[];
begin
	-- 20260930003100 (F2-5b-3).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder worker drain limit is invalid' using errcode = '22023'; end if;
	select coalesce(array_agg(x.environment_id order by x.environment_id), '{}') into v_environments from (
		select distinct f.environment_id from public.qorpera_runtime_workers w
		join public.qorpera_company_files f on f.profile_id = w.profile_id and f.core = 'folder-v2'
		where (w.state = 'active' or w.completion_state = 'waiting')
			and (p_after_environment is null or f.environment_id > p_after_environment)
			and public.qorpera_folder_worker_due(w)
			and not public.qorpera_company_execution_paused(f.profile_id)
		order by f.environment_id limit p_limit) x;
	return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('environment_id', e) order by e)
			from unnest(v_environments) e), '[]'::jsonb),
		'has_more', cardinality(v_environments) = p_limit,
		'next_after_environment_id', case when cardinality(v_environments) = p_limit
			then v_environments[cardinality(v_environments)] end);
end $$;

-- 6. One company's workers, in its own transaction, never inside the materializer's (its admission comes after the
-- materializer's ranks). Answers {schema, state: done | idle | paused | busy | deleting | not_folder, started, failed,
-- cancelled, revivals, suppressed, undeliverable, skipped}.
create function public.qorpera_folder_workers_company(p_environment_id uuid, p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.folder-workers/v1';
	-- Writing subtransactions a call, besides its own and the wake nudge's (core §3 step 7: under 64).
	c_blocks constant integer := 40;
	v_profile uuid; v_due uuid[]; v_ids uuid[]; v_targets jsonb; v_worker public.qorpera_runtime_workers%rowtype;
	v_todo public.qorpera_runtime_agent_todos%rowtype; v_parent uuid; v_job uuid; v_status text; v_wake_status text;
	v_wake public.qorpera_wake_occurrences%rowtype; v_first public.qorpera_runtime_workers%rowtype; v_set uuid[]; v_id uuid;
	v_handled uuid[] := '{}'; v_blocks integer := 0; v_was_active boolean;
	v_started integer := 0; v_failed integer := 0; v_cancelled integer := 0; v_revivals integer := 0; v_suppressed integer := 0;
	v_undeliverable integer := 0; v_skipped integer := 0;
begin
	-- 20260930003100 (F2-5b-3).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder worker drains run at read committed' using errcode = '25000'; end if;
	if p_limit is null or p_limit not between 1 and 32 then
		raise exception 'Folder worker drain limit is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('schema', c_schema, 'state', 'not_folder'); end if;
	if public.qorpera_company_deleting(v_profile) then return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
	if public.qorpera_company_execution_paused(v_profile) then return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;

	-- 1. Plain reads: the due workers, oldest first, and up to four waiting workers of each waiting one's parent.
	select coalesce(array_agg(w.id order by w.created_at, w.id), '{}') into v_due from (
		select w.id, w.created_at from public.qorpera_runtime_workers w
		where w.profile_id = v_profile and (w.state = 'active' or w.completion_state = 'waiting')
			and public.qorpera_folder_worker_due(w)
		order by w.created_at, w.id limit p_limit) w;
	if cardinality(v_due) = 0 then return jsonb_build_object('schema', c_schema, 'state', 'idle'); end if;
	select v_due || coalesce(array_agg(x.id) filter (where not (x.id = any(v_due))), '{}') into v_ids
	from (select distinct w.steering_run_id from public.qorpera_runtime_workers w
			where w.id = any(v_due) and w.completion_state = 'waiting' and w.steering_run_id is not null) p,
		lateral (select s.id from public.qorpera_runtime_workers s where s.steering_run_id = p.steering_run_id
			and s.completion_state = 'waiting' and s.folder_erased_at is null order by s.reported_at, s.id limit 4) x;
	v_ids := coalesce(v_ids, v_due);
	select coalesce(jsonb_agg(y.t), '[]'::jsonb) into v_targets from (
		select distinct x.t from public.qorpera_runtime_workers w, lateral (values
			(case when w.requested_by_user_id is not null then jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
				'key', v_profile::text || ':' || w.requested_by_user_id::text, 'mode', 'keyshare') end),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || w.staff_agent_id::text,
				'mode', 'keyshare')),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', v_profile::text || ':' || w.staff_agent_id::text, 'mode', 'keyshare')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_agent_todos', 'key', w.todo_id::text, 'mode', 'share')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers', 'key', w.id::text, 'mode', 'update'))) x(t)
		where w.id = any(v_ids) and x.t is not null) y;

	begin
		-- 2. The fence KEY SHARE (the pause read again by the drain below), rank 0, ranks 1 to 5.
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;
		-- 3. The parents' conversations a revival's wake key-shares, then admission, last.
		perform 1 from public.qorpera_shared_sessions s where s.profile_id = v_profile and s.id in (select r.session_id
			from public.qorpera_execution_runs r join public.qorpera_runtime_workers w on w.steering_run_id = r.id
			where w.id = any(v_ids) and w.completion_state = 'waiting') order by s.id for key share;
		perform public.qorpera_folder_admit_wakes(v_profile);

		-- 4. One block per due worker, read again under its lock.
		for v_id in select w.id from public.qorpera_runtime_workers w where w.id = any(v_due) order by w.created_at, w.id loop
			exit when v_blocks >= c_blocks;
			continue when v_id = any(v_handled);
			select * into v_worker from public.qorpera_runtime_workers where id = v_id;
			continue when not public.qorpera_folder_worker_due(v_worker);
			v_blocks := v_blocks + 1; v_was_active := v_worker.state = 'active'; v_set := null;
			begin
				select r.job_id, j.status into v_job, v_status from public.qorpera_execution_runs r
				left join public.qorpera_runner_jobs j on j.id = r.job_id where r.id = v_worker.steering_run_id;
				if v_worker.state = 'active' then
					select * into v_todo from public.qorpera_runtime_agent_todos where id = v_worker.todo_id;
					-- The parent was stopped, or its todo cancelled: the worker stops with it. Its queued wake NOWAIT.
					if v_status = 'cancelled' or public.qorpera_worker_revival_stopped(v_worker.steering_run_id)
						or v_todo.state = 'cancelled' then
						perform 1 from public.qorpera_wake_occurrences where id = v_worker.occurrence_id and status = 'queued'
						for update nowait;
						perform public.qorpera_cancel_worker(v_worker, null, case when v_status = 'cancelled'
							or public.qorpera_worker_revival_stopped(v_worker.steering_run_id) then 'parent_stopped' else 'todo_cancelled' end);
						v_cancelled := v_cancelled + 1;
					elsif v_worker.occurrence_id is null then
						-- Start it: the dispatch wake, admitted above. One the pin trigger cancels at insert fails the worker.
						insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id,
							staff_agent_id, parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
						values (extensions.gen_random_uuid(), v_profile, p_environment_id, 'agent', 'worker-dispatch', v_worker.id,
							v_worker.staff_agent_id, v_worker.steering_run_id, 'worker-dispatch',
							'worker-dispatch:' || v_worker.id::text || ':' || v_worker.sequence::text, clock_timestamp(), clock_timestamp(),
							public.qorpera_folder_worker_dispatch_payload(v_worker, v_todo))
						returning * into v_wake;
						if v_wake.status = 'queued' then
							update public.qorpera_runtime_workers set occurrence_id = v_wake.id, updated_at = clock_timestamp()
							where id = v_worker.id;
							v_started := v_started + 1;
						else
							perform public.qorpera_folder_worker_ended(v_worker, v_wake.id, v_wake.status);
							v_failed := v_failed + 1;
						end if;
					else
						-- Its wake ended without a report.
						select status into v_wake_status from public.qorpera_wake_occurrences where id = v_worker.occurrence_id;
						perform public.qorpera_folder_worker_ended(v_worker, v_worker.occurrence_id, v_wake_status);
						v_failed := v_failed + 1;
					end if;
				elsif v_worker.folder_erased_at is not null then
					-- Erased results have no text left to tell the parent.
					update public.qorpera_runtime_workers set completion_state = 'suppressed' where id = v_worker.id;
					v_suppressed := v_suppressed + 1;
				elsif v_job is null then
					-- A parent that never got a job cannot be revived in any conversation.
					update public.qorpera_runtime_workers set completion_state = 'undeliverable' where id = v_worker.id;
					insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, body)
					values (v_worker.id, v_worker.sequence, 'undeliverable', jsonb_build_object('reason', 'parent_without_job'));
					v_undeliverable := v_undeliverable + 1;
				elsif v_status = 'cancelled' or public.qorpera_worker_revival_stopped(v_worker.steering_run_id) then
					-- A parent a person stopped, or whose revival a person stopped, hears no more reports.
					update public.qorpera_runtime_workers set completion_state = 'suppressed'
					where steering_run_id = v_worker.steering_run_id and id = any(v_ids) and completion_state = 'waiting';
					v_suppressed := v_suppressed + 1;
					v_handled := v_handled || array(select w.id from public.qorpera_runtime_workers w
						where w.steering_run_id = v_worker.steering_run_id and w.id = any(v_ids));
				else
					-- Revive the parent with up to four results, oldest first, from the rows this call locked.
					select array_agg(s.id order by s.reported_at, s.id) into v_set from (
						select s.id, s.reported_at from public.qorpera_runtime_workers s
						where s.steering_run_id = v_worker.steering_run_id and s.completion_state = 'waiting' and s.id = any(v_ids)
							and s.folder_erased_at is null
						order by s.reported_at, s.id limit 4) s;
					continue when v_set is null;
					select * into v_first from public.qorpera_runtime_workers where id = v_set[1];
					insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id,
						staff_agent_id, parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
					values (extensions.gen_random_uuid(), v_profile, p_environment_id, 'agent', 'worker-completion', v_first.id,
						v_worker.staff_agent_id, v_worker.steering_run_id, 'worker-completion',
						'worker-completion:' || v_first.id::text || ':' || v_first.sequence::text, clock_timestamp(), clock_timestamp(),
						public.qorpera_worker_completion_payload(v_worker.steering_run_id, v_set))
					returning * into v_wake;
					if v_wake.status = 'queued' then
						update public.qorpera_runtime_workers set completion_state = 'delivered', completion_occurrence_id = v_wake.id
						where id = any(v_set);
						v_revivals := v_revivals + 1;
					else
						-- One the pin trigger cancels at insert cannot be tried again under the same key: the results stay in the
						-- todo's folder, and the reason is kept.
						update public.qorpera_runtime_workers set completion_state = 'undeliverable' where id = any(v_set);
						insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, body)
						select w.id, w.sequence, 'undeliverable', jsonb_build_object('reason', coalesce(v_wake.blocked_reason, 'refused'))
						from public.qorpera_runtime_workers w where w.id = any(v_set);
						v_undeliverable := v_undeliverable + 1;
					end if;
					v_handled := v_handled || v_set;
				end if;
			exception
				when lock_not_available or deadlock_detected then v_skipped := v_skipped + 1;
				when insufficient_privilege or no_data_found or object_not_in_prerequisite_state or unique_violation then
					if v_was_active then
						-- A dispatch wake its trigger refused (nobody pays, the agent or the requester gone, a fenced ancestry):
						-- the worker fails, never left active without a wake.
						perform public.qorpera_folder_worker_ended(v_worker, null, null);
						v_failed := v_failed + 1;
					else
						-- The agent, the requester or the conversation is gone: the results stay in the todo's folder.
						update public.qorpera_runtime_workers set completion_state = 'undeliverable'
						where id = any(coalesce(v_set, array[v_worker.id])) and completion_state = 'waiting';
						v_undeliverable := v_undeliverable + 1;
						v_handled := v_handled || coalesce(v_set, array[v_worker.id]);
					end if;
			end;
		end loop;
	exception when lock_not_available or deadlock_detected then
		return jsonb_build_object('schema', c_schema, 'state', 'busy');
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'started', v_started, 'failed', v_failed,
		'cancelled', v_cancelled, 'revivals', v_revivals, 'suppressed', v_suppressed, 'undeliverable', v_undeliverable,
		'skipped', v_skipped);
end $$;

revoke all on function public.qorpera_folder_worker_dispatch_payload(public.qorpera_runtime_workers, public.qorpera_runtime_agent_todos),
	public.qorpera_folder_worker_revival_pending(uuid), public.qorpera_folder_worker_due(public.qorpera_runtime_workers),
	public.qorpera_folder_worker_ended(public.qorpera_runtime_workers, uuid, text)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_workers_due(uuid, integer), public.qorpera_folder_workers_company(uuid, integer)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_workers_due(uuid, integer), public.qorpera_folder_workers_company(uuid, integer)
	to service_role;
