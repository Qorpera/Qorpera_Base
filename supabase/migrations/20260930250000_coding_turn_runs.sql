-- Agent memory tree, W6a: a coding session's turns as runs of their own, in SQL (the W6 note, agreed 9 Oct by
-- OptChat, W4 and W1; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §10.1 and §12). Stacked on W1b-1
-- (20260930231000), whose run logs it feeds.
-- * Each turn keeps the wake occurrence its begin made (qorpera_begin_coding_turn), so the turn row leads to the
--   turn's run, and the turn's report names that run (runId), as an in-house worker's report does. The `reported`
--   worker event carries it in its body; its run_id column stays null, as for every coding report.
-- * A turn is narrow once its session's view holds a path outside the every-agent part. Its begin marks it when the
--   session's coding view has read one (qorpera_coding_view_narrow: the open view carries its predecessor's read set),
--   and F3 step 5's view refresh calls qorpera_coding_turn_mark_narrow while it is open; its settle marks it when the
--   view is narrow by then. The flag only goes from false to true and is frozen once the turn ended. A session is
--   narrow while any of its turns or its view is, or any turn's run is narrow by its log or its place (the step that
--   dispatched it, or the run it continues) (qorpera_coding_session_narrow): each turn resumes the session's
--   conversation.
-- * The run log's side: qorpera_memory_run_machine_narrow (W1b-1's, false until now) is true for a coding turn's run
--   when that turn or an earlier one of its session is narrow, or, while the turn is open, when its session's view is.
--   qorpera_memory_run_origin already ORs it in for the run itself, and qorpera_run_log_narrow for the run a later
--   turn continues, so neither changes.
-- * A narrow session's busy check-in names neither its title, repository nor branch, and each running command only by
--   its commandId and turn: what is left is ids, ages and counts (the note's §2).
-- * P18 notes a session's turn runs (each that began before the erasure's newest cutoff) wherever it notes the session
--   (the note's §4): a version or conflict copy its view's commit wrote (phase 1), a change set of its view (phase 2),
--   and a read record of its view (phase 3, after the runs' read records, in the same budget). Last in phase 3, a
--   noted turn run (its own read records, a commit or wake of its run) notes its session's other turn runs.
-- Every new or patched body carries the marker 20260930250000 for the deploy guard (section 6).

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if exists (select 1 from pg_attribute where attrelid = 'public.qorpera_coding_session_turns'::regclass
			and attname = 'occurrence_id' and not attisdropped) then
		raise exception 'W6a (20260930250000) is already applied'; end if;
	if to_regclass('public.qorpera_memory_run_logs') is null then
		raise exception 'W6a (20260930250000) needs W1b (20260930231000)'; end if;
end $$;

create function pg_temp.w6a_replace(p_function regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'W6a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The turn row: its run and whether it is narrow ------------------------------------------------------------------

alter table public.qorpera_coding_session_turns
	add column occurrence_id uuid references public.qorpera_wake_occurrences(id) on delete restrict,
	add column narrow boolean not null default false;
comment on column public.qorpera_coding_session_turns.occurrence_id is
	'The wake occurrence the turn''s begin made (W6a): its run is the turn''s run. Set once.';
comment on column public.qorpera_coding_session_turns.narrow is
	'Whether the session''s view held a path outside the every-agent part while the turn was open (W6a). Only ever goes '
	'from false to true; frozen once the turn ended.';
create index qorpera_coding_session_turns_occurrence on public.qorpera_coding_session_turns(occurrence_id)
	where occurrence_id is not null;

-- The turn is recorded once; its occurrence too, once set, and its narrow flag never goes back.
create or replace function public.qorpera_coding_session_turn_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if tg_op = 'DELETE' and public.qorpera_company_purge_active() then return old; end if;
	if tg_op = 'DELETE' then raise exception 'A coding turn is history and cannot be removed' using errcode = '55000'; end if;
	if (new.worker_id, new.sequence, new.input_from, new.input_text, new.input_user_id, new.input_run_id, new.created_at)
			is distinct from (old.worker_id, old.sequence, old.input_from, old.input_text, old.input_user_id, old.input_run_id, old.created_at)
		or (old.submission is not null and (new.submission, new.submission_receipt_id, new.submitted_at)
			is distinct from (old.submission, old.submission_receipt_id, old.submitted_at))
		or (old.outcome is not null and ((new.outcome, new.settled_at) is distinct from (old.outcome, old.settled_at)
			or new.submission is distinct from old.submission))
		-- 20260930250000 (W6a).
		or (old.occurrence_id is not null and new.occurrence_id is distinct from old.occurrence_id)
		or (old.narrow and not new.narrow)
		or (old.outcome is not null and (new.occurrence_id, new.narrow) is distinct from (old.occurrence_id, old.narrow)) then
		raise exception 'A coding turn is recorded once' using errcode = '55000'; end if;
	return new;
end
$$;

-- 2. Narrow turns ----------------------------------------------------------------------------------------------------

-- Whether a coding session's view has read a path outside the every-agent part: a read of any of its coding views, open
-- or closed (each open one carries its predecessor's read set on the same machine, and the conversation keeps what an
-- earlier one read), names a resource that not every agent reads, or one that is gone. Plain reads.
create function public.qorpera_coding_view_narrow(p_worker_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930250000 (W6a).
	select exists (select 1 from public.qorpera_folder_views fv
		join public.qorpera_folder_view_reads vr on vr.view_id = fv.id
		left join public.qorpera_company_path_resources r on r.id = vr.resource_id and r.environment_id = vr.environment_id
		where fv.worker_id = p_worker_id and fv.kind = 'coding_session'
			and case when r.id is null then true
				else not coalesce(public.qorpera_folder_path_every_agent(vr.environment_id, r.path), false) end)
$$;
revoke all on function public.qorpera_coding_view_narrow(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- F3 step 5's view refresh calls this whenever a coding session's new view holds a path outside the every-agent part:
-- the session's open turn is narrow from then on. Returns whether the session now has an open narrow turn. False means
-- no turn is open: between turns (the next begin then reads the view), or the turn ended first, and it stays as it
-- ended. Takes only the open turn's row lock (the caller's own locks come first; a settle takes the session, then the
-- turn).
create function public.qorpera_coding_turn_mark_narrow(p_worker_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930250000 (W6a).
	update public.qorpera_coding_session_turns set narrow = true where worker_id = p_worker_id and outcome is null and not narrow;
	return exists (select 1 from public.qorpera_coding_session_turns where worker_id = p_worker_id and outcome is null and narrow);
end $$;
revoke all on function public.qorpera_coding_turn_mark_narrow(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether a coding session read files only some agents may read, given that each turn resumes the session's
-- conversation: one of its turns is narrow, or its view is (between turns no turn is open to mark), or one of its turns'
-- runs is narrow by its log or by its place (§4.5: the step that dispatched it, its parent's log from that step, or the
-- run it continues). The steering run a check-in goes to need not be narrow itself: a later follow-up may come from
-- another run.
create function public.qorpera_coding_session_narrow(p_worker_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930250000 (W6a).
	select exists (select 1 from public.qorpera_coding_session_turns turn where turn.worker_id = p_worker_id and turn.narrow)
		or public.qorpera_coding_view_narrow(p_worker_id)
		or exists (select 1 from public.qorpera_coding_session_turns turn
			join public.qorpera_wake_occurrences o on o.id = turn.occurrence_id
			where turn.worker_id = p_worker_id and o.run_id is not null
				and (public.qorpera_run_log_narrow(o.run_id)
					or coalesce((public.qorpera_memory_run_origin(o.environment_id, o.run_id) ->> 'narrow')::boolean, false)))
$$;
revoke all on function public.qorpera_coding_session_narrow(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The runs of a coding session's turns whose occurrence was made before p_before (P18's newest cutoff), ended or not.
create function public.qorpera_coding_turn_runs(p_worker_id uuid, p_before timestamptz)
returns setof uuid language sql stable security definer set search_path = '' as $$
	-- 20260930250000 (W6a).
	select o.run_id from public.qorpera_coding_session_turns turn
	join public.qorpera_wake_occurrences o on o.id = turn.occurrence_id
	where turn.worker_id = p_worker_id and o.run_id is not null and o.created_at < p_before
$$;
revoke all on function public.qorpera_coding_turn_runs(uuid, timestamptz) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. The turn's run: its begin and its report ------------------------------------------------------------------------

-- The begin holds the worker (rank 5), then the session, then the turn row, as a settle takes the session, then the turn.
select pg_temp.w6a_replace('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
	$old$	update public.qorpera_coding_sessions set phase = 'running', claim_after = null, updated_at = clock_timestamp() where worker_id = v_worker.id;
$old$,
	$new$	update public.qorpera_coding_sessions set phase = 'running', claim_after = null, updated_at = clock_timestamp() where worker_id = v_worker.id;
	-- 20260930250000 (W6a): the turn keeps its run's occurrence, and is narrow from its start when the session's view is.
	update public.qorpera_coding_session_turns set occurrence_id = v_occurrence,
		narrow = narrow or public.qorpera_coding_view_narrow(v_worker.id)
	where worker_id = v_worker.id and sequence = v_worker.sequence;
$new$);

-- Whatever ends a turn settles it here: a turn that ends while its session's view is narrow ends narrow, so its frozen
-- flag holds what its run's machine answered while it was open.
select pg_temp.w6a_replace('public.qorpera_settle_coding_turn()'::regprocedure,
	$old$		settled_at = clock_timestamp()
	where worker_id = new.id and sequence = old.sequence and outcome is null;$old$,
	$new$		settled_at = clock_timestamp(),
		-- 20260930250000 (W6a).
		narrow = narrow or public.qorpera_coding_view_narrow(new.id)
	where worker_id = new.id and sequence = old.sequence and outcome is null;$new$);

select pg_temp.w6a_replace('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	$old$		'pullRequest', coalesce(p_pull_request, v_session.pull_request), 'runId', null, 'sequence', v_worker.sequence)
$old$,
	$new$		'pullRequest', coalesce(p_pull_request, v_session.pull_request),
		-- 20260930250000 (W6a): the turn's run (null until its wake started one).
		'runId', (select o.run_id from public.qorpera_wake_occurrences o where o.id = v_worker.occurrence_id), 'sequence', v_worker.sequence)
$new$);

-- Whether a run's machine made it narrow (§4.5): a coding turn's run when that turn or an earlier one of its session is
-- narrow, or, while the turn is open, when its session's view is. The settle folds the view into the turn's flag, and
-- once the turn ended its flags are frozen, so the answer never changes after the turn ended. That is not the run's
-- end: the executor finishes the run's job, then publishes, then completes the turn, so a view read released while it
-- publishes can still make the answer true after the run ended (only ever more cautious). False for other runs.
-- qorpera_memory_run_origin ORs it in for the run, and qorpera_run_log_narrow for the run a later turn continues.
create or replace function public.qorpera_memory_run_machine_narrow(p_environment_id uuid, p_run_id uuid)
returns boolean language sql stable set search_path = '' as $$
	-- 20260930231000 (W1b)
	-- 20260930250000 (W6a): a coding turn's run.
	select coalesce((select exists (select 1 from public.qorpera_coding_session_turns earlier
				where earlier.worker_id = turn.worker_id and earlier.sequence <= turn.sequence and earlier.narrow)
			or (turn.outcome is null and public.qorpera_coding_view_narrow(turn.worker_id))
		from public.qorpera_wake_occurrences o
		join public.qorpera_coding_session_turns turn on turn.occurrence_id = o.id
		where o.run_id = p_run_id and o.environment_id = p_environment_id), false)
$$;

-- 4. A narrow session's busy check-in --------------------------------------------------------------------------------

select pg_temp.w6a_replace('public.qorpera_ask_busy_coding_sessions(uuid,integer)'::regprocedure,
	$old$v_todo_key text; v_running jsonb;$old$,
	$new$v_todo_key text; v_narrow boolean; v_running jsonb;$new$);
select pg_temp.w6a_replace('public.qorpera_ask_busy_coding_sessions(uuid,integer)'::regprocedure,
	$old$			select todo_key into v_todo_key from public.qorpera_runtime_agent_todos where id = v_worker.todo_id;
$old$,
	$new$			select todo_key into v_todo_key from public.qorpera_runtime_agent_todos where id = v_worker.todo_id;
			-- 20260930250000 (W6a): a narrow session is named by its keys alone, and its commands by commandId and turn.
			v_narrow := public.qorpera_coding_session_narrow(v_worker.id);
$new$);
select pg_temp.w6a_replace('public.qorpera_ask_busy_coding_sessions(uuid,integer)'::regprocedure,
	$old$						jsonb_build_object('command', left(running.value ->> 'command', 200), 'turn', (running.value ->> 'turn')::integer) as item
$old$,
	$new$						case when v_narrow then jsonb_build_object('commandId', running.value -> 'commandId', 'turn', (running.value ->> 'turn')::integer)
							else jsonb_build_object('command', left(running.value ->> 'command', 200), 'turn', (running.value ->> 'turn')::integer) end as item
$new$);
select pg_temp.w6a_replace('public.qorpera_ask_busy_coding_sessions(uuid,integer)'::regprocedure,
	$old$						and coalesce(running.value ->> 'turn', '') ~ '^[1-9][0-9]{0,8}$') listed) ordered;
$old$,
	$new$						and coalesce(running.value ->> 'turn', '') ~ '^[1-9][0-9]{0,8}$'
						and (not v_narrow or coalesce(running.value ->> 'commandId', '')
							~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) listed) ordered;
$new$);
select pg_temp.w6a_replace('public.qorpera_ask_busy_coding_sessions(uuid,integer)'::regprocedure,
	$old$			v_body := jsonb_build_object('machine', format('the coding session %s (repository %s/%s, branch %s)',
					to_json(left(regexp_replace(v_worker.title, '[[:cntrl:]]+', ' ', 'g'), 100))::text,
					v_session.repository ->> 'owner', v_session.repository ->> 'name',
					left(regexp_replace(v_session.branch, '[[:cntrl:]]+', ' ', 'g'), 100)),
$old$,
	$new$			v_body := jsonb_build_object('machine', case when v_narrow then 'a coding session that read files only some agents may read'
				else format('the coding session %s (repository %s/%s, branch %s)',
					to_json(left(regexp_replace(v_worker.title, '[[:cntrl:]]+', ' ', 'g'), 100))::text,
					v_session.repository ->> 'owner', v_session.repository ->> 'name',
					left(regexp_replace(v_session.branch, '[[:cntrl:]]+', ' ', 'g'), 100)) end,
$new$);

-- 5. P18 notes a session's turn runs ---------------------------------------------------------------------------------

select pg_temp.w6a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$v_record record;$old$,
	$new$v_record record; v_view_read record;$new$);

-- Phase 1: a version, then a conflict copy, a coding view's commit wrote.
select pg_temp.w6a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$			insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
			select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_batch) b
			join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid
			where c.run_id is not null and v_erasure.block_history is null
			on conflict do nothing;
$old$,
	$new$			insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
			select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_batch) b
			join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid
			where c.run_id is not null and v_erasure.block_history is null
			on conflict do nothing;
			-- 20260930250000 (W6a): a coding view's commit notes its session's turn runs.
			insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
			select distinct v_erasure.id, t.run_id from (select distinct fv.worker_id from jsonb_array_elements(v_batch) b
				join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid and c.view_kind = 'coding_session'
				join public.qorpera_folder_views fv on fv.id = c.view_id) coding
			cross join lateral public.qorpera_coding_turn_runs(coding.worker_id, v_max_at) t(run_id)
			where v_erasure.block_history is null
			on conflict do nothing;
$new$);
select pg_temp.w6a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$				insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
				select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_copy_batch) b
				join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid
				where c.run_id is not null and v_erasure.block_history is null
				on conflict do nothing;
$old$,
	$new$				insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
				select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_copy_batch) b
				join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid
				where c.run_id is not null and v_erasure.block_history is null
				on conflict do nothing;
				-- 20260930250000 (W6a): as for versions.
				insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
				select distinct v_erasure.id, t.run_id from (select distinct fv.worker_id from jsonb_array_elements(v_copy_batch) b
					join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid and c.view_kind = 'coding_session'
					join public.qorpera_folder_views fv on fv.id = c.view_id) coding
				cross join lateral public.qorpera_coding_turn_runs(coding.worker_id, v_max_at) t(run_id)
				where v_erasure.block_history is null
				on conflict do nothing;
$new$);

-- Phase 2: a coding view's change set, saved or not.
select pg_temp.w6a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$select c.id, c.seq, c.created_at, c.units, c.run_id from public.qorpera_folder_commits c$old$,
	$new$select c.id, c.seq, c.created_at, c.units, c.run_id, c.view_id, c.view_kind from public.qorpera_folder_commits c$new$);
select pg_temp.w6a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$select c.id, c.created_at, c.units, c.run_id from public.qorpera_folder_commits c$old$,
	$new$select c.id, c.created_at, c.units, c.run_id, c.view_id, c.view_kind from public.qorpera_folder_commits c$new$);
select pg_temp.w6a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$						if v_commit.run_id is not null and v_erasure.block_history is null then
							insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_commit.run_id)
							on conflict do nothing;
						end if;
$old$,
	$new$						if v_commit.run_id is not null and v_erasure.block_history is null then
							insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_commit.run_id)
							on conflict do nothing;
						end if;
						-- 20260930250000 (W6a): a coding view's change set notes its session's turn runs.
						if v_commit.view_kind = 'coding_session' and v_erasure.block_history is null then
							insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
							select v_erasure.id, t.run_id from public.qorpera_folder_views fv
							cross join lateral public.qorpera_coding_turn_runs(fv.worker_id, v_max_at) t(run_id)
							where fv.id = v_commit.view_id
							on conflict do nothing;
						end if;
$new$, 2);

-- Phase 3: the runs' read records, then (the cursor's views) the coding views' read records, then the noted turn runs'
-- sessions. An empty views pass ends the phase in the same step, as before.
select pg_temp.w6a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$		elsif v_erasure.phase = 3 then
			-- The runs that read an erased version: read records from the first erased version's time to the cutoff's.
			for v_record in select rr.run_id, rr.release_id, rr.resource_id, rr.created_at, rr.reads
				from public.qorpera_folder_run_read_records rr
				where v_erasure.first_erased_at is not null and v_erasure.block_history is null
					and rr.environment_id = v_erasure.environment_id
					and rr.created_at >= v_erasure.first_erased_at and rr.created_at < v_max_at
					and (rr.created_at, rr.run_id, rr.release_id, rr.resource_id) >
						(coalesce((v_cursor ->> 'at')::timestamptz, '-infinity'::timestamptz), coalesce((v_cursor ->> 'run')::uuid, c_zero),
						 coalesce((v_cursor ->> 'release')::uuid, c_zero), coalesce((v_cursor ->> 'resource')::uuid, c_zero))
				order by rr.created_at, rr.run_id, rr.release_id, rr.resource_id
				limit p_commits
			loop
				if exists (select 1 from jsonb_array_elements(v_record.reads) rd join jsonb_array_elements(v_erasure.roots) r
						on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(rd ->> 'path'))
						and v_record.created_at < (r ->> 'cutoffAt')::timestamptz) then
					insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_record.run_id)
					on conflict do nothing;
				end if;
				v_count := v_count + 1;
				v_bytes := v_bytes + octet_length(v_record.reads::text);
				v_cursor := jsonb_build_object('at', v_record.created_at, 'run', v_record.run_id, 'release', v_record.release_id,
					'resource', v_record.resource_id);
				if v_bytes > c_bytes or clock_timestamp() - v_started > c_budget then v_out := true; exit; end if;
			end loop;
			update public.qorpera_folder_erasures set
				phase = case when v_count < p_commits and not v_out then 4 else 3 end,
				cursor = case when v_count < p_commits and not v_out then '{}'::jsonb else v_cursor end
			where id = v_erasure.id;
$old$,
	$new$		elsif v_erasure.phase = 3 then
			-- 20260930250000 (W6a): the runs' read records, then the coding views' (the cursor's views), in one budget.
			if not v_cursor ? 'views' then
				-- The runs that read an erased version: read records from the first erased version's time to the cutoff's.
				for v_record in select rr.run_id, rr.release_id, rr.resource_id, rr.created_at, rr.reads
					from public.qorpera_folder_run_read_records rr
					where v_erasure.first_erased_at is not null and v_erasure.block_history is null
						and rr.environment_id = v_erasure.environment_id
						and rr.created_at >= v_erasure.first_erased_at and rr.created_at < v_max_at
						and (rr.created_at, rr.run_id, rr.release_id, rr.resource_id) >
							(coalesce((v_cursor ->> 'at')::timestamptz, '-infinity'::timestamptz), coalesce((v_cursor ->> 'run')::uuid, c_zero),
							 coalesce((v_cursor ->> 'release')::uuid, c_zero), coalesce((v_cursor ->> 'resource')::uuid, c_zero))
					order by rr.created_at, rr.run_id, rr.release_id, rr.resource_id
					limit p_commits
				loop
					if exists (select 1 from jsonb_array_elements(v_record.reads) rd join jsonb_array_elements(v_erasure.roots) r
							on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(rd ->> 'path'))
							and v_record.created_at < (r ->> 'cutoffAt')::timestamptz) then
						insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_record.run_id)
						on conflict do nothing;
					end if;
					v_count := v_count + 1;
					v_bytes := v_bytes + octet_length(v_record.reads::text);
					v_cursor := jsonb_build_object('at', v_record.created_at, 'run', v_record.run_id, 'release', v_record.release_id,
						'resource', v_record.resource_id);
					if v_bytes > c_bytes or clock_timestamp() - v_started > c_budget then v_out := true; exit; end if;
				end loop;
				if v_count < p_commits and not v_out then v_cursor := '{"views": true}'::jsonb; end if;
			end if;
			if v_cursor ? 'views' then
				-- A coding view records the reads of its session's machine, not of a run: one that read an erased version
				-- before its root's cutoff notes the session's turn runs. The limit leaves v_count below p_commits only when
				-- the pass is done.
				for v_view_read in select vr.view_id, vr.release_id, vr.resource_id, vr.created_at, vr.reads, fv.worker_id
					from public.qorpera_folder_view_read_records vr
					join public.qorpera_folder_views fv on fv.id = vr.view_id and fv.kind = 'coding_session'
					where v_erasure.first_erased_at is not null and v_erasure.block_history is null
						and vr.environment_id = v_erasure.environment_id
						and vr.created_at >= v_erasure.first_erased_at and vr.created_at < v_max_at
						and (vr.created_at, vr.view_id, vr.release_id, vr.resource_id) >
							(coalesce((v_cursor ->> 'at')::timestamptz, '-infinity'::timestamptz), coalesce((v_cursor ->> 'view')::uuid, c_zero),
							 coalesce((v_cursor ->> 'release')::uuid, c_zero), coalesce((v_cursor ->> 'resource')::uuid, c_zero))
					order by vr.created_at, vr.view_id, vr.release_id, vr.resource_id
					limit p_commits - v_count
				loop
					if exists (select 1 from jsonb_array_elements(v_view_read.reads) rd join jsonb_array_elements(v_erasure.roots) r
							on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(rd ->> 'path'))
							and v_view_read.created_at < (r ->> 'cutoffAt')::timestamptz) then
						insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
						select v_erasure.id, t.run_id from public.qorpera_coding_turn_runs(v_view_read.worker_id, v_max_at) t(run_id)
						on conflict do nothing;
					end if;
					v_count := v_count + 1;
					v_bytes := v_bytes + octet_length(v_view_read.reads::text);
					v_cursor := jsonb_build_object('views', true, 'at', v_view_read.created_at, 'view', v_view_read.view_id,
						'release', v_view_read.release_id, 'resource', v_view_read.resource_id);
					if v_bytes > c_bytes or clock_timestamp() - v_started > c_budget then v_out := true; exit; end if;
				end loop;
				-- Then each noted turn run (its run's read records, commits or wakes) notes its session's other turn runs:
				-- each turn resumes the session's conversation.
				if v_count < p_commits and not v_out and v_erasure.block_history is null then
					insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
					select distinct v_erasure.id, t.run_id from (
						select distinct turn.worker_id from public.qorpera_folder_erasure_runs er
						join public.qorpera_wake_occurrences o on o.run_id = er.run_id
						join public.qorpera_coding_session_turns turn on turn.occurrence_id = o.id
						where er.erasure_id = v_erasure.id) noted
					cross join lateral public.qorpera_coding_turn_runs(noted.worker_id, v_max_at) t(run_id)
					on conflict do nothing;
				end if;
			end if;
			update public.qorpera_folder_erasures set
				phase = case when v_cursor ? 'views' and v_count < p_commits and not v_out then 4 else 3 end,
				cursor = case when v_cursor ? 'views' and v_count < p_commits and not v_out then '{}'::jsonb else v_cursor end
			where id = v_erasure.id;
$new$);

-- The coding views' read records by time, as the runs' (20260928469190).
create index qorpera_folder_view_read_records_time on public.qorpera_folder_view_read_records(environment_id, created_at);

-- 6. The deploy guard ---------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_coding_session_turn_guard()', 'public.qorpera_coding_view_narrow(uuid)',
		'public.qorpera_coding_turn_mark_narrow(uuid)', 'public.qorpera_coding_session_narrow(uuid)',
		'public.qorpera_coding_turn_runs(uuid,timestamp with time zone)', 'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
		'public.qorpera_settle_coding_turn()', 'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_memory_run_machine_narrow(uuid,uuid)', 'public.qorpera_ask_busy_coding_sessions(uuid,integer)',
		'public.qorpera_folder_erasure_step(integer,integer,integer)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930250000') = 0 then
			raise exception 'W6a marker is missing in %', v_function; end if;
	end loop;
	-- W1b's guard reads its own marker in the function W6a fills in.
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_memory_run_machine_narrow(uuid,uuid)'::regprocedure),
			'20260930231000') = 0 then
		raise exception 'W1b marker is missing in qorpera_memory_run_machine_narrow'; end if;
end $guard$;
