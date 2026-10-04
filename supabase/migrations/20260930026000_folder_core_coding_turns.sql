-- Company folder core, C1c-3i part a (P07 part 2; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.12): a coding
-- session's rows on the folder fence. Folder-v2 only (founder decision, 3 Oct 2026: production is wiped and the
-- snapshot-v1 path is dropped), so nothing here keeps a snapshot-v1 branch.
--
-- Before: a coding turn's begin, completion, the owner's answer and a delegation locked the todo and then the worker
-- FOR UPDATE with no company lock, and the begin's wake admission took the company row FOR UPDATE NOWAIT (the 55P03 the
-- executor retries). On folder-v2 the begin could not run at all: its wake had no folder admission. A stop's drain did
-- not wait for any of them. The executor's claim locked several companies' rows in one transaction.
--
-- * qorpera_lock_coding_worker, which the begin, the completion and the answer call first, is the company's entry (core
--   §3): the folder fence KEY SHARE and rank 0; the session's owner (rank 1), the agent and its execution authority
--   (ranks 2, 3) KEY SHARE; the todo and then the worker FOR NO KEY UPDATE (rank 5, F2's table order). A stop's second
--   phase waits these out. The coding session comes after, at the sessions step (after rank 10; core §3 amended).
-- * The begin reads the pause again after the fence (it inserts a wake) and admits on the folder admission row (step
--   10) before its wake: no NOWAIT, no 55P03.
-- * The claim enters one company per call. A candidate it does not take rolls its locks back (the subtransaction
--   ends in an exception), and failing an expired lease ends the call, so no transaction holds two companies. Its
--   candidates are folder-v2 sessions only, and it waits at most 1 s for any one lock (then skips the candidate), so a
--   held company never makes every claim run into PostgREST's 8 s statement timeout.
-- * The executor's quiet-session archive takes one company per call too. The quiet check-ins it asks after the archive
--   (qorpera_ask_quiet_coding_sessions, a legacy wake inserter without the fence) skip folder-v2 sessions until C1c-3i
--   part b asks them per company: in the archive's transaction they would lock its worker and company row more strongly.
-- * The owner's answer, a delegation and the owner's archive check the owner again once the entry holds the owner's
--   member row, so a removal that committed while they waited is seen.
-- Inert until C3 lets a folder-v2 coding session exist (the worker tool refuses coding dispatch on folder-v2) and C4
-- materializes its wake. Every patched body carries the marker 20260930026000.

create function pg_temp.c1c3i_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C1c-3i anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The coding worker's entry --------------------------------------------------------------------------------------------

create or replace function public.qorpera_lock_coding_worker(p_worker_id uuid)
returns public.qorpera_runtime_workers language plpgsql volatile security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype;
begin
	-- C1c-3i (20260930026000): an unlocked read names the company and the rows, then the company's entry takes them in
	-- core §3's order. Folder-v2 only.
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	if v_worker.id is null then return v_worker; end if;
	if not public.qorpera_company_is_folder_v2(v_worker.profile_id) then
		raise exception 'Coding sessions serve folder-v2 companies only' using errcode = '0A000'; end if;
	perform public.qorpera_folder_company_enter(v_worker.environment_id, v_worker.profile_id,
		jsonb_build_array(
			jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_worker.profile_id::text || ':' || v_worker.staff_agent_id::text,
				'mode', 'keyshare', 'required', false),
			jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', v_worker.profile_id::text || ':' || v_worker.staff_agent_id::text, 'mode', 'keyshare', 'required', false),
			jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_agent_todos', 'key', v_worker.todo_id::text, 'mode', 'nokeyupdate',
				'required', false),
			jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers', 'key', v_worker.id::text, 'mode', 'nokeyupdate',
				'required', true))
		-- The coding session acts for the worker's owner (F3).
		|| case when v_worker.owner_user_id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('rank', 1,
			'tbl', 'qorpera_profile_members', 'key', v_worker.profile_id::text || ':' || v_worker.owner_user_id::text, 'mode', 'keyshare',
			'required', false)) end,
		false);
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	return v_worker;
end
$$;
revoke all on function public.qorpera_lock_coding_worker(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The begin: the pause after the fence, then the folder admission before the wake -----------------------------------

select pg_temp.c1c3i_replace('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
	$old$	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);$old$,
	$new$	-- C1c-3i (20260930026000): the company's entry and the rank-5 rows, then the session; a wake inserter reads the
	-- pause again after the fence.
	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if public.qorpera_company_execution_paused(v_worker.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;$new$);
select pg_temp.c1c3i_replace('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
	$old$	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,$old$,
	$new$	-- C1c-3i (20260930026000): admission (core §3 step 10), last before the wake.
	perform public.qorpera_folder_admit_wakes(v_worker.profile_id);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,$new$);

-- 3. The claim: one company per call ----------------------------------------------------------------------------------------

select pg_temp.c1c3i_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$			and session.harness = any(executor.harnesses)$old$,
	$new$			and session.harness = any(executor.harnesses)
			-- C1c-3i (20260930026000): folder-v2 companies only.
			and public.qorpera_company_is_folder_v2(session.profile_id)$new$);

select pg_temp.c1c3i_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$			select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
			perform 1 from public.qorpera_runtime_agent_todos where id = v_worker.todo_id for update nowait;
			select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update nowait;
			select * into v_session from public.qorpera_coding_sessions where worker_id = v_session.worker_id for update nowait;
			if v_worker.state <> 'active' then continue; end if;$old$,
	$new$			-- C1c-3i (20260930026000): the company's entry and the rank-5 rows, then the session. A candidate not taken
			-- raises QSK01 so its subtransaction, and every lock it took, rolls back: one company per transaction.
			v_worker := public.qorpera_lock_coding_worker(v_session.worker_id);
			select * into v_session from public.qorpera_coding_sessions where worker_id = v_session.worker_id for update nowait;
			if v_worker.state <> 'active' then raise exception 'Coding candidate skipped' using errcode = 'QSK01'; end if;$new$);
select pg_temp.c1c3i_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$				if v_session.lease_until > clock_timestamp() then continue; end if;$old$,
	$new$				if v_session.lease_until > clock_timestamp() then
					raise exception 'Coding candidate skipped' using errcode = 'QSK01'; end if;$new$);
select pg_temp.c1c3i_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$				perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
				continue;$old$,
	$new$				perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
				-- C1c-3i (20260930026000): the failure holds this company's rows; the next claim takes the next candidate.
				return null;$new$);
select pg_temp.c1c3i_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$				and public.qorpera_coding_executor_pick(v_worker.id) is distinct from p_owner then continue; end if;$old$,
	$new$				and public.qorpera_coding_executor_pick(v_worker.id) is distinct from p_owner then
				raise exception 'Coding candidate skipped' using errcode = 'QSK01'; end if; -- C1c-3i (20260930026000)$new$);
select pg_temp.c1c3i_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$				continue;
			end if;
			update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = p_owner,$old$,
	$new$				raise exception 'Coding candidate skipped' using errcode = 'QSK01'; -- C1c-3i (20260930026000)
			end if;
			update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = p_owner,$new$);
select pg_temp.c1c3i_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$		exception when lock_not_available then continue;$old$,
	$new$		-- C1c-3i (20260930026000): a candidate not taken (or one whose lock it waited for 1 s) is skipped, with its locks.
		exception when lock_not_available or sqlstate 'QSK01' then continue;$new$);
alter function public.qorpera_claim_coding_session(text, integer) set lock_timeout = '1s';

-- 4. The owner's calls: the same entry, then the owner checked again under it ---------------------------------------------

select pg_temp.c1c3i_replace('public.qorpera_delegate_coding_session(uuid,uuid)',
	$old$	select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id for update;$old$,
	$new$	v_worker := public.qorpera_lock_coding_worker(v_worker.id); -- C1c-3i (20260930026000)
	-- C1c-3i (20260930026000): the owner again, now that the entry holds the owner's member row.
	perform public.qorpera_coding_session_owner_row(v_worker.id);$new$);
select pg_temp.c1c3i_replace('public.qorpera_answer_coding_session(uuid,text,uuid)',
	$old$	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	v_worker := public.qorpera_lock_coding_worker(v_worker.id);$old$,
	$new$	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	v_worker := public.qorpera_lock_coding_worker(v_worker.id);
	-- C1c-3i (20260930026000): the owner again, now that the entry holds the owner's member row.
	perform public.qorpera_coding_session_owner_row(v_worker.id);$new$);
select pg_temp.c1c3i_replace('public.qorpera_archive_coding_session(uuid,uuid)',
	$old$	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	v_worker := public.qorpera_lock_coding_worker(v_worker.id);$old$,
	$new$	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	v_worker := public.qorpera_lock_coding_worker(v_worker.id);
	-- C1c-3i (20260930026000): the owner again, now that the entry holds the owner's member row.
	perform public.qorpera_coding_session_owner_row(v_worker.id);$new$);

-- 5. The executor's quiet-session archive: one company per call; the legacy check-ins skip folder-v2 -----------------------

select pg_temp.c1c3i_replace('public.qorpera_archive_quiet_coding_sessions(text)',
	$old$declare v_candidate record; v_worker public.qorpera_runtime_workers%rowtype; v_count integer := 0;$old$,
	$new$declare v_candidate record; v_worker public.qorpera_runtime_workers%rowtype; v_count integer := 0; v_profile uuid;$new$);
select pg_temp.c1c3i_replace('public.qorpera_archive_quiet_coding_sessions(text)',
	$old$		select session.worker_id from public.qorpera_coding_sessions session$old$,
	$new$		select session.worker_id, session.profile_id from public.qorpera_coding_sessions session$new$);
select pg_temp.c1c3i_replace('public.qorpera_archive_quiet_coding_sessions(text)',
	$old$		where session.archived_at is null and worker.state <> 'active'
$old$,
	$new$		where session.archived_at is null and worker.state <> 'active'
			-- C1c-3i (20260930026000): folder-v2 companies only.
			and public.qorpera_company_is_folder_v2(session.profile_id)
$new$);
select pg_temp.c1c3i_replace('public.qorpera_archive_quiet_coding_sessions(text)',
	$old$		-- In todo order, so two executors of one environment lock todos the same way round.
		order by worker.todo_id, worker.id limit 8
	loop$old$,
	$new$		-- C1c-3i (20260930026000): by company, then in todo order, so two executors of one environment lock todos the
		-- same way round; one company per call (the next call takes the next).
		order by session.profile_id, worker.todo_id, worker.id limit 8
	loop
		exit when v_profile is not null and v_candidate.profile_id <> v_profile;
		v_profile := v_candidate.profile_id;$new$);
select pg_temp.c1c3i_replace('public.qorpera_ask_quiet_coding_sessions(text)',
	$old$		where session.archived_at is null and worker.state <> 'active' and worker.completion_state <> 'waiting'
$old$,
	$new$		where session.archived_at is null and worker.state <> 'active' and worker.completion_state <> 'waiting'
			-- C1c-3i (20260930026000): folder-v2 sessions are asked by C1c-3i part b's per-company loop, not here.
			and not public.qorpera_company_is_folder_v2(session.profile_id)
$new$);
