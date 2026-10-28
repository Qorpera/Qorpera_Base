-- 20260930538000: One run at a time in a conversation, a wake's too (WB G5).
--
-- On folder-v2 a turn request waited only for a live session_turn run in its conversation, and a wake waited for
-- nothing (qorpera_folder_materialize_company and qorpera_folder_materialize_due, 20260928469310). A coworker's message
-- wakes the agent in its own thread, which is also the web's main chat, so a member's message there started a second
-- run beside the running wake (production, 28 Oct 2026: run 4256), and a wake could start beside a running turn.
--
-- 1. A turn request waits while its conversation has any queued or leased run: a turn's, a wake's or a room
--    delivery's. The due list, the materializer's scan and its check under the locks count them all.
-- 2. A wake waits, queued, the same way: it is not due, it is not in the scan, and a pass that made a run in its
--    conversation first skips it. In a group chat (a conversation with no agent) it waits only for its own agent's run
--    there, so the agents of one group chat still answer side by side. A wake with no conversation (a worker's
--    dispatch) never waits.
-- No rule across conversations is added: an agent may still run in two conversations at once.
--
-- The edited functions are patched in place through their current text, so each keeps its ACL. Deploy order: either.

set local lock_timeout = '3s';

create function pg_temp.g5_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'G5 patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- 1. A turn request waits for any live run in its conversation: in the due list, the scan and the check.
select pg_temp.g5_patch('public.qorpera_folder_materialize_due(uuid,integer)',
	$old$			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				where run.session_id = request.session_id and run.source_kind = 'session_turn' and job.status in ('queued', 'leased'))$old$,
	$new$			-- 20260930538000 (G5): any live run in the conversation, a wake's or a room delivery's too.
			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				where run.session_id = request.session_id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased'))$new$);
select pg_temp.g5_patch('public.qorpera_folder_materialize_company(uuid,integer)',
	$old$			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				where run.session_id = request.session_id and run.source_kind = 'session_turn' and job.status in ('queued', 'leased'))$old$,
	$new$			-- 20260930538000 (G5): any live run in the conversation, a wake's or a room delivery's too.
			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				where run.session_id = request.session_id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased'))$new$);
select pg_temp.g5_patch('public.qorpera_folder_materialize_company(uuid,integer)',
	$old$				or exists (select 1 from public.qorpera_execution_runs as run
					join public.qorpera_runner_jobs as job on job.id = run.job_id
					where run.session_id = v_session.id and run.source_kind = 'session_turn' and job.status in ('queued', 'leased'))$old$,
	$new$				-- 20260930538000 (G5): any live run in the conversation, a wake's or a room delivery's too.
				or exists (select 1 from public.qorpera_execution_runs as run
					join public.qorpera_runner_jobs as job on job.id = run.job_id
					where run.session_id = v_session.id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
						and job.status in ('queued', 'leased'))$new$);

-- 2. A wake waits the same way, queued; in a group chat, for its own agent's run there.
select pg_temp.g5_patch('public.qorpera_folder_materialize_due(uuid,integer)',
	$old$			and (wake.blocked_reason is null or wake.admission_scan_at <= v_now - interval '30 seconds')$old$,
	$new$			and (wake.blocked_reason is null or wake.admission_scan_at <= v_now - interval '30 seconds')
			-- 20260930538000 (G5): a wake waits while its conversation has a live run; in a group chat (no agent), while its
			-- own agent has one there.
			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				join public.qorpera_shared_sessions as session on session.id = run.session_id
				where run.session_id = wake.session_id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased')
					and (session.staff_agent_id is not null or run.staff_agent_id = wake.staff_agent_id))$new$);
select pg_temp.g5_patch('public.qorpera_folder_materialize_company(uuid,integer)',
	$old$		where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.not_before <= v_now$old$,
	$new$		where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.not_before <= v_now
			-- 20260930538000 (G5): a wake waits while its conversation has a live run; in a group chat (no agent), while its
			-- own agent has one there.
			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				join public.qorpera_shared_sessions as session on session.id = run.session_id
				where run.session_id = wake.session_id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased')
					and (session.staff_agent_id is not null or run.staff_agent_id = wake.staff_agent_id))$new$);
select pg_temp.g5_patch('public.qorpera_folder_materialize_company(uuid,integer)',
	$old$			if v_wake.wake_kind not in ('routine', 'agent', 'room') or not public.qorpera_wake_authorized(v_wake) then$old$,
	$new$			-- 20260930538000 (G5): under the conversation's lock, a run made since the scan (by a turn or a wake earlier in
			-- this pass) leaves the wake waiting, queued, as the scan would.
			if exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				join public.qorpera_shared_sessions as session on session.id = run.session_id
				where run.session_id = v_wake.session_id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased')
					and (session.staff_agent_id is not null or run.staff_agent_id = v_wake.staff_agent_id)) then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			if v_wake.wake_kind not in ('routine', 'agent', 'room') or not public.qorpera_wake_authorized(v_wake) then$new$);
