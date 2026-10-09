-- C3d: a coding turn's results.md on folder-v2 (RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (C3)").
--
-- A coding turn reports through its executor (qorpera_complete_coding_turn) or fails when its executor stops
-- (qorpera_claim_coding_session), never through a run's report_work, so until now no results.md was written and its agent
-- could not decide on it ("without a report there is none"). The platform writes it now, as the gateway writes a
-- connection's file (P22b): the turn's report marks the worker due, the gateway claims it, renders results.md from the
-- claim, commits it as the platform under the claim's operation key and finishes the claim.
-- * qorpera_coding_results_files: one due row per coding worker, at the sequence whose report it writes. Its operation key
--   is coding-results:<worker>:<sequence>:<generation>; each claim takes a new generation, and a sequence reports once.
-- * qorpera_complete_coding_turn and qorpera_claim_coding_session's lease-expired failure mark the worker due, under the
--   worker's lock (rank 5), as they write its report.
-- * qorpera_claim_coding_results_file / qorpera_finish_coding_results_file (service role): the gateway's pair, as
--   qorpera_claim_connection_file / qorpera_finish_connection_file. A claim locks only due rows, SKIP LOCKED, and reads the
--   worker again in its own statement; a problem backs the row off.
-- * qorpera_company_state_worker_rules: without a worker request, a platform commit under the due row's exact operation
--   key writes a live coding worker's results.md, as its turn reported it (outcome, reported_at, no decision, no note, no
--   files). A decision waits while the row is due.
-- * qorpera_company_state_index_worker: that write points the worker at its results and removes the due row.
-- * qorpera_coding_results_held, in qorpera_folder_worker_due and qorpera_folder_workers_company: the agent's revival
--   waits for the results file, at most a minute and not after a writing problem. A batch sibling waits with it, and a
--   revival another worker starts leaves it out.
-- Every patched or new body carries the marker 20260930108000.

set local lock_timeout = '3s';

create function pg_temp.c3d_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C3d anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The due rows --------------------------------------------------------------------------------------------------------

-- A coding worker whose report at `sequence` has no results.md yet. The row goes with the commit that writes it; a row of
-- an earlier sequence (a follow-up came first) is read by nothing and replaced by the next report. The company's purge
-- removes it with its worker.
create table public.qorpera_coding_results_files (
	worker_id uuid primary key references public.qorpera_runtime_workers(id) on delete cascade,
	profile_id uuid not null,
	environment_id uuid not null,
	sequence integer not null,
	generation bigint not null default 0 check (generation >= 0),
	lease_owner uuid,
	lease_until timestamptz,
	attempts integer not null default 0 check (attempts >= 0),
	not_before timestamptz,
	last_problem text check (last_problem ~ '^[a-z][a-z0-9_]{0,63}$'),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	check ((lease_owner is null) = (lease_until is null)));

alter table public.qorpera_coding_results_files enable row level security;
revoke all on table public.qorpera_coding_results_files from public, anon, authenticated, service_role;

-- Marks a folder-v2 coding worker's report at p_sequence due. The caller holds the worker (rank 5). A generation never
-- goes back, so a claim's operation key is never one an earlier claim of this row used.
create function public.qorpera_coding_results_due(p_worker_id uuid, p_sequence integer)
returns void language sql security definer set search_path = '' as $$
	-- 20260930108000 (C3d).
	insert into public.qorpera_coding_results_files as due (worker_id, profile_id, environment_id, sequence)
	select w.id, w.profile_id, w.folder_environment_id, p_sequence from public.qorpera_runtime_workers w
	where w.id = p_worker_id and w.folder_environment_id is not null
	on conflict (worker_id) do update set sequence = excluded.sequence, generation = due.generation + 1,
		lease_owner = null, lease_until = null, attempts = 0, not_before = null, last_problem = null,
		created_at = clock_timestamp(), updated_at = clock_timestamp();
$$;

revoke all on function public.qorpera_coding_results_due(uuid, integer) from public, anon, authenticated, service_role;

-- 2. A turn's report marks its results due -------------------------------------------------------------------------------

select pg_temp.c3d_replace('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
	$old$	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'reported', null, v_report);$old$,
	$new$	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'reported', null, v_report);
	perform public.qorpera_coding_results_due(v_worker.id, v_worker.sequence); -- 20260930108000 (C3d)$new$);

select pg_temp.c3d_replace('public.qorpera_claim_coding_session(text,integer)',
	$old$				perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'failed', 'kernel', jsonb_build_object('reason','executor-lease-expired'));$old$,
	$new$				perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'failed', 'kernel', jsonb_build_object('reason','executor-lease-expired'));
				perform public.qorpera_coding_results_due(v_worker.id, v_worker.sequence); -- 20260930108000 (C3d)$new$);

-- 3. The gateway's claim and finish --------------------------------------------------------------------------------------

-- The oldest due row whose worker's report is still the one to write, leased to p_worker under a new generation, with
-- everything the gateway renders results.md from; null when there is none. It locks only the due row (SKIP LOCKED) and
-- reads the worker plainly, again in its own statement (the candidate's join is not read again under the lock).
create function public.qorpera_claim_coding_results_file(p_worker uuid, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_due public.qorpera_coding_results_files%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_pull_request text;
begin
	-- 20260930108000 (C3d).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
		raise exception 'Coding results claim is invalid' using errcode = '22023'; end if;
	select due.* into v_due from public.qorpera_coding_results_files due
	join public.qorpera_runtime_workers w on w.id = due.worker_id
	where due.sequence = w.sequence and w.species = 'coding' and w.state in ('succeeded','blocked','failed')
		and w.reported_at is not null and w.folder_environment_id is not null and w.folder_erased_at is null
		and not public.qorpera_coding_worker_retired(w)
		and (due.lease_until is null or due.lease_until < clock_timestamp())
		and (due.not_before is null or due.not_before <= clock_timestamp())
		and not public.qorpera_company_deleting(w.profile_id)
	order by due.created_at, due.worker_id
	limit 1
	for update of due skip locked;
	if v_due.worker_id is null then return null; end if;
	select * into v_worker from public.qorpera_runtime_workers where id = v_due.worker_id;
	if v_worker.id is null or v_due.sequence <> v_worker.sequence or v_worker.species <> 'coding'
		or v_worker.state not in ('succeeded','blocked','failed') or v_worker.reported_at is null
		or v_worker.folder_environment_id is null or v_worker.folder_erased_at is not null
		or public.qorpera_coding_worker_retired(v_worker) then
		return null; end if;
	update public.qorpera_coding_results_files
	set generation = generation + 1, lease_owner = p_worker,
		lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), attempts = attempts + 1,
		updated_at = clock_timestamp()
	where worker_id = v_due.worker_id
	returning * into v_due;
	v_pull_request := v_worker.result #>> '{pullRequest,url}';
	return jsonb_build_object('schema', 'qorpera.coding-results-claim/v1', 'codingWorkerId', v_worker.id,
		'environmentId', v_worker.folder_environment_id, 'sequence', v_due.sequence, 'generation', v_due.generation,
		'attempt', v_due.attempts,
		'operationKey', 'coding-results:' || v_worker.id::text || ':' || v_due.sequence::text || ':' || v_due.generation::text,
		'path', v_worker.folder_path || '/results.md',
		'currentVersion', (select e.version from public.qorpera_folder_entries e
			where e.environment_id = v_worker.folder_environment_id and e.kind = 'file'
				and e.key_sha256 = extensions.digest(v_worker.folder_key || '/results.md', 'sha256')),
		'outcome', v_worker.state, 'reportedAt', public.qorpera_company_state_instant_text(v_worker.reported_at),
		'summary', v_worker.result ->> 'summary', 'needs', v_worker.result ->> 'needs',
		'pullRequest', case when v_pull_request ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]{0,9}$'
			then v_pull_request end,
		'options', case when jsonb_typeof(v_worker.result -> 'options') = 'array' then v_worker.result -> 'options' end,
		'leaseUntil', v_due.lease_until);
end $$;

-- Ends p_worker's claim of a coding worker's results at p_generation: with a problem, the row backs off and the agent's
-- revival stops waiting for it; without one, the claim's commit saved results.md and its index removed the row, so the
-- answer is finished false.
create function public.qorpera_finish_coding_results_file(p_worker uuid, p_coding_worker_id uuid, p_generation bigint,
	p_problem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_due public.qorpera_coding_results_files%rowtype;
begin
	-- 20260930108000 (C3d): only the due row is locked.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_coding_worker_id is null or p_generation is null
		or (p_problem is not null and p_problem !~ '^[a-z][a-z0-9_]{0,63}$') then
		raise exception 'Coding results finish is invalid' using errcode = '22023'; end if;
	select due.* into v_due from public.qorpera_coding_results_files due where due.worker_id = p_coding_worker_id for update;
	if v_due.worker_id is null or v_due.lease_owner is distinct from p_worker or v_due.generation <> p_generation then
		return jsonb_build_object('schema', 'qorpera.coding-results-finish/v1', 'finished', false);
	end if;
	if p_problem is not null then
		update public.qorpera_coding_results_files
		set lease_owner = null, lease_until = null, last_problem = p_problem,
			not_before = clock_timestamp() + least(make_interval(secs => power(2, least(attempts, 10))::integer),
				interval '10 minutes'),
			updated_at = clock_timestamp()
		where worker_id = p_coding_worker_id;
	else
		-- A saved commit's index removed the row. One still here was not written by this claim (its commit replayed
		-- another), so it is due again after the same pause, and no claim loops on it.
		update public.qorpera_coding_results_files
		set lease_owner = null, lease_until = null,
			not_before = clock_timestamp() + least(make_interval(secs => power(2, least(attempts, 10))::integer),
				interval '10 minutes'),
			updated_at = clock_timestamp()
		where worker_id = p_coding_worker_id;
	end if;
	return jsonb_build_object('schema', 'qorpera.coding-results-finish/v1', 'finished', true);
end $$;

revoke all on function public.qorpera_claim_coding_results_file(uuid, integer),
	public.qorpera_finish_coding_results_file(uuid, uuid, bigint, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_claim_coding_results_file(uuid, integer),
	public.qorpera_finish_coding_results_file(uuid, uuid, bigint, text) to service_role;

-- 4. The rules and the index ---------------------------------------------------------------------------------------------

select pg_temp.c3d_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)',
	$old$	if v_request is null then
		-- Only a restore of a retired worker's files, byte for byte as its row records them.
		if v_worker.id is null or v_worker.folder_retired_at is null$old$,
	$new$	if v_request is null then
		-- 20260930108000 (C3d): a coding turn's results, which the platform writes under its due row's claim, as the turn
		-- reported them.
		if p_actor ->> 'kind' = 'platform' and not v_brief and v_worker.species = 'coding'
			and v_worker.folder_retired_at is null and exists (select 1 from public.qorpera_coding_results_files due
				where due.worker_id = v_worker.id and due.sequence = v_worker.sequence
					and 'coding-results:' || due.worker_id::text || ':' || due.sequence::text || ':' || due.generation::text
						= (select c.operation_key from public.qorpera_folder_commits c where c.id = p_commit_id)) then
			if v_worker.state not in ('succeeded','blocked','failed') or v_worker.reported_at is null
				or p_parse ->> 'outcome' is distinct from v_worker.state
				or (p_parse ->> 'reportedAt')::timestamptz is distinct from v_worker.reported_at
				or jsonb_typeof(p_parse -> 'decision') is distinct from 'null' or jsonb_typeof(p_parse -> 'note') is distinct from 'null'
				or p_parse -> 'files' is distinct from '[]'::jsonb then
				v_problem := 'the platform writes a coding session''s results as its turn reported them';
			end if;
		-- Only a restore of a retired worker's files, byte for byte as its row records them.
		elsif v_worker.id is null or v_worker.folder_retired_at is null$new$);

select pg_temp.c3d_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)',
	$old$		elsif v_action = 'decide' then
			v_base := public.qorpera_company_state_base(p_environment_id, p_key);
			if v_brief or v_base is null then$old$,
	$new$		elsif v_action = 'decide' then
			v_base := public.qorpera_company_state_base(p_environment_id, p_key);
			if v_worker.species = 'coding' and exists (select 1 from public.qorpera_coding_results_files due
				where due.worker_id = v_worker.id and due.sequence = v_worker.sequence) then
				v_problem := 'this coding session''s results are still being written; try again in a moment'; -- 20260930108000 (C3d)
			elsif v_brief or v_base is null then$new$);

select pg_temp.c3d_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)',
	$old$	else
		-- A restore: the retired worker comes back, finished, at its folder.$old$,
	$new$	-- 20260930108000 (C3d): a coding turn's results, which the platform wrote under its due row's claim (the rules allow a
	-- live worker's results to no one else without a request); its due row goes with the claim's commit.
	elsif v_action is null and not v_brief and v_commit.actor_kind = 'platform' and v_worker.species = 'coding'
		and v_worker.folder_retired_at is null then
		update public.qorpera_runtime_workers set folder_results_version = p_version, folder_commit_id = p_commit_id,
			updated_at = clock_timestamp()
		where id = v_worker.id and folder_retired_at is null;
		get diagnostics v_count = row_count;
		if v_count <> 1 then raise exception 'A coding session''s results found no row' using errcode = 'XX000'; end if;
		delete from public.qorpera_coding_results_files due where due.worker_id = v_worker.id
			and 'coding-results:' || due.worker_id::text || ':' || due.sequence::text || ':' || due.generation::text
				= v_commit.operation_key;
	else
		-- A restore: the retired worker comes back, finished, at its folder.$new$);

-- 5. The agent's revival waits for the results ---------------------------------------------------------------------------

-- A coding worker whose report's results.md the platform is still writing: due at its sequence, for at most a minute
-- after the report, and not once its writing met a problem.
create function public.qorpera_coding_results_held(p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930108000 (C3d).
	select exists (select 1 from public.qorpera_coding_results_files due where due.worker_id = p_worker.id
		and due.sequence = p_worker.sequence and due.last_problem is null
		and due.created_at > clock_timestamp() - interval '1 minute')
$$;

revoke all on function public.qorpera_coding_results_held(public.qorpera_runtime_workers)
	from public, anon, authenticated, service_role;

-- A held worker is not due, nor is a batch sibling that waits with it, and no revival carries it.
select pg_temp.c3d_replace('public.qorpera_folder_worker_due(public.qorpera_runtime_workers)',
	$old$				and not public.qorpera_folder_worker_revival_pending(p_worker.steering_run_id))$old$,
	$new$				and not public.qorpera_folder_worker_revival_pending(p_worker.steering_run_id)
				-- 20260930108000 (C3d): a coding turn's results.md comes first, its own or a batch sibling's.
				and not public.qorpera_coding_results_held(p_worker)
				and not (p_worker.revival = 'batch' and p_worker.state <> 'blocked' and exists (select 1
					from public.qorpera_runtime_workers s where s.steering_run_id = p_worker.steering_run_id and s.id <> p_worker.id
						and public.qorpera_coding_results_held(s))))$new$);

select pg_temp.c3d_replace('public.qorpera_folder_workers_company(uuid,integer)',
	$old$							and s.folder_erased_at is null
						order by s.reported_at, s.id limit 4) s;$old$,
	$new$							and s.folder_erased_at is null
							and not public.qorpera_coding_results_held(s) -- 20260930108000 (C3d): its results.md first
						order by s.reported_at, s.id limit 4) s;$new$);
