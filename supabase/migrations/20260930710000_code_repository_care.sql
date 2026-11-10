-- 20260930710000: nightly care of the repositories kept in Qorpera: their registry, the care lease and the last outcome
-- (own code storage, step 2a "nightly care"; 10 Nov 2026).
--
-- A repository kept in Qorpera lives only in the company folder, at code/<owner>/<name>/ (20260930670000). Until now
-- nothing looked after it between sessions: nobody checked main/ against the default branch, ran git's own check, kept
-- a copy outside the folder, packed its objects or took away the worktrees of sessions archived long ago. The coding
-- executor now does, each night, one repository at a time and only while the company's coding sessions are quiet. This
-- migration is that work's bookkeeping. It is inert until an executor calls it, and it patches no existing function.
--
-- 1. qorpera_code_repositories: one row per repository kept in Qorpera, written when its first coding session is (a
--    trigger on qorpera_coding_sessions, with the record 20260930707000 reads: a session whose repository's host is
--    qorpera), and for the sessions that exist by qorpera_code_repositories_backfill, run once here. The row holds
--    the switches (care on; packing and retiring off until each is proven on the real folder), when care is next due,
--    the lease of the run in progress and what the last run found. No API role reads or writes it. The company's purge
--    takes it with the company (20260928248920 follows its two foreign keys).
-- 2. qorpera_code_care_due(owner, machine, limit): the repositories an executor may care for now, oldest first. Care is
--    on and due, no run holds the lease, the caller is the environment's only enabled executor, the company is not
--    being deleted, and none of its coding sessions is queued, input_ready, preparing, running or publishing. It
--    writes nothing.
-- 3. qorpera_code_care_step(owner, machine, environment, repository owner, name, token, step): asked before each job
--    of a run. 'begin' (no token) starts a run: a new token, a lease of two hours, one more start counted. Every other
--    step names the run's token and renews the lease. Each call repeats every check of (2), so a run stops at its next
--    job when a session of the company starts ('busy'), when it is no longer due there ('not-due'), or when the token
--    is not the run's or its lease ended ('lost'). 'go' carries the two switches and what the last run recorded; for
--    step 'retire' also the sessions whose worktrees may go: archived for 7 days, not attached, their worker not
--    active and none of their turns unsettled, at most 20 a call and only while retiring is switched on.
--    A third start with no finish since is not followed by a fourth that night: the repository gets the problem
--    CARE_DID_NOT_FINISH and waits for the next night.
-- 4. qorpera_code_care_finish(owner, machine, environment, repository owner, name, token, outcome): the run's
--    outcome, qorpera.code-care-outcome/v1, with exactly its keys (22023 otherwise). It records what each part did
--    (a part that was skipped or found nothing new leaves its columns), ends the lease and sets the next care: after
--    a run put off as busy, 30 minutes on while that is before 05:00 UTC; otherwise the next night, between 01:00 and
--    04:00 UTC at a time a hash of the owner and name picks.
--
-- Three rules of the record that keep a later run safe:
-- * refs_sha256 moves only with a clean fsck (fsck.state ok). It is what the next run compares tonight's refs with to
--   skip the fsck, so it must never name refs no fsck has passed: a run put off after its check, or one whose fsck
--   timed out or found problems, leaves it, and the next run checks again.
-- * A pack the check after it found damaged (gc.state damaged) switches the repository's packing off, until an operator
--   has looked and switches it on again.
-- * The sessions named for retiring go round: each call starts after the last session the call before it named
--   (retire_cursor). A session's worktree that is gone stays a candidate (the kernel does not know the folder), so the
--   oldest 20 named every night would keep every later one waiting for ever.
--
-- Who may call: the service role only, as the coding executor that holds the company (the custody check of
-- qorpera_code_hosts_deleting, 20260928569100: owner and machine id well formed, 42501 otherwise). An executor that is
-- not the environment's one enabled executor on that machine gets no repository, 'not-due' or 'lost'; it is never told
-- more. Locks: step and finish take the repository's registry row and nothing else; sessions, workers and turns are
-- read with no lock, by environment.

set local lock_timeout = '3s';

-- 1. The registry -------------------------------------------------------------------------------------------------------

create table public.qorpera_code_repositories (
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	owner text not null,
	name text not null,
	created_at timestamptz not null default clock_timestamp(),
	-- The switches: care itself, and its two parts that change what the folder holds.
	care_enabled boolean not null default true,
	gc_enabled boolean not null default false,
	retire_enabled boolean not null default false,
	next_care_at timestamptz not null default clock_timestamp(),
	-- The run in progress: its token, the executor that began it and its lease; and the starts since the last finish.
	care_token uuid,
	care_owner text,
	care_until timestamptz,
	care_attempts integer not null default 0 check (care_attempts >= 0),
	-- What the runs so far recorded.
	last_care_at timestamptz,
	last_ok_at timestamptz,
	deep_at timestamptz,
	problem text check (problem is null or problem ~ '^[A-Z0-9_:]{1,120}$'),
	problem_since timestamptz,
	main_sha text,
	-- The refs the last clean fsck passed (see the header).
	refs_sha256 text,
	fsck_state text,
	fsck_at timestamptz,
	bundle_at timestamptz,
	bundle_name text,
	bundle_sha256 text,
	bundle_bytes bigint,
	bundle_refs_sha256 text,
	gc_at timestamptz,
	worktrees integer,
	retired integer not null default 0 check (retired >= 0),
	-- The last session named for retiring; the next call starts after it.
	retire_cursor uuid,
	outcome jsonb check (outcome is null or pg_column_size(outcome) <= 16384),
	primary key (environment_id, owner, name),
	check ((care_token is null) = (care_until is null) and (care_token is null) = (care_owner is null)),
	check ((problem is null) = (problem_since is null))
);
create index qorpera_code_repositories_profile on public.qorpera_code_repositories(profile_id);
create index qorpera_code_repositories_due on public.qorpera_code_repositories(next_care_at) where care_enabled;
alter table public.qorpera_code_repositories enable row level security;
revoke all on public.qorpera_code_repositories from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_code_repositories is
	'20260930710000: the repositories kept in Qorpera, each with its nightly care: the switches, the lease of the run in '
	'progress and what the last run found. Its functions write it; the three switches are an operator''s to set.';

-- A coding session on a repository kept in Qorpera registers the repository; one that is registered stays as it is.
create function public.qorpera_code_repository_register()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values (new.environment_id, new.profile_id, new.repository ->> 'owner', new.repository ->> 'name')
	on conflict (environment_id, owner, name) do nothing;
	return null;
end $$;
create trigger qorpera_coding_sessions_register_repository after insert on public.qorpera_coding_sessions
	for each row when (new.repository ->> 'host' = 'qorpera')
	execute function public.qorpera_code_repository_register();

-- The repositories of the sessions that exist, each once, by its first session; answers how many it registered. One
-- that is registered stays as it is, so a second call registers nothing.
create function public.qorpera_code_repositories_backfill()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	select distinct on (session.environment_id, session.repository ->> 'owner', session.repository ->> 'name')
		session.environment_id, session.profile_id, session.repository ->> 'owner', session.repository ->> 'name'
	from public.qorpera_coding_sessions session
	where session.repository ->> 'host' = 'qorpera'
	order by session.environment_id, session.repository ->> 'owner', session.repository ->> 'name', session.created_at,
		session.worker_id
	on conflict (environment_id, owner, name) do nothing;
	get diagnostics v_count = row_count;
	return v_count;
end $$;
select public.qorpera_code_repositories_backfill();

-- 2. What the three calls share -----------------------------------------------------------------------------------------

-- Whether this owner on this machine is the environment's coding executor and its only enabled one: care runs only
-- where one executor alone works on the company's code.
create function public.qorpera_code_care_holder(p_environment_id uuid, p_owner text, p_machine_id_sha256 text)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce(bool_and(executor.owner = p_owner
		and coalesce(executor.nas_machine_id_sha256 = p_machine_id_sha256, false)), false)
	from public.qorpera_coding_executors executor
	where executor.environment_id = p_environment_id and executor.enabled
$$;

-- When a repository's next care is. After a run put off as busy: 30 minutes on, while that is before 05:00 UTC. Otherwise
-- the next night: tomorrow (UTC) between 01:00 and 04:00, at the second a hash of its owner and name picks.
create function public.qorpera_code_care_next_at(p_owner text, p_name text, p_busy boolean, p_now timestamptz)
returns timestamptz language sql stable set search_path = '' as $$
	select case when p_busy and ((p_now + interval '30 minutes') at time zone 'UTC')::time < time '05:00'
		then p_now + interval '30 minutes'
		else (date_trunc('day', p_now at time zone 'UTC') + interval '25 hours' + make_interval(
			secs => ('x' || left(md5(p_owner || '/' || p_name), 8))::bit(32)::bigint % 10800)) at time zone 'UTC' end
$$;

-- An outcome's value that may be null: JSON null, or a string that matches the pattern.
create function public.qorpera_code_care_text_valid(p_value jsonb, p_pattern text)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_value) = 'null' or (jsonb_typeof(p_value) = 'string' and p_value #>> '{}' ~ p_pattern)
$$;

-- Whether p_outcome is a care run's outcome, qorpera.code-care-outcome/v1: exactly its keys, each of its kind. A stored
-- bundle names its file, hash, size and refs.
create function public.qorpera_code_care_outcome_valid(p_outcome jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_outcome) = 'object'
		and p_outcome ?& array['schema','state','problem','mainSha','refsSha256','repaired','deep','fsck','bundle','gc',
			'worktrees','retired']
		and p_outcome - array['schema','state','problem','mainSha','refsSha256','repaired','deep','fsck','bundle','gc',
			'worktrees','retired'] = '{}'::jsonb
		and p_outcome -> 'schema' = '"qorpera.code-care-outcome/v1"'::jsonb
		and p_outcome -> 'state' in ('"done"'::jsonb, '"busy"'::jsonb, '"failed"'::jsonb)
		and public.qorpera_code_care_text_valid(p_outcome -> 'problem', '^[A-Z0-9_:]{1,120}$')
		and public.qorpera_code_care_text_valid(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
		and public.qorpera_code_care_text_valid(p_outcome -> 'refsSha256', '^[0-9a-f]{64}$')
		and p_outcome -> 'repaired' in ('null'::jsonb, '"none"'::jsonb, '"head"'::jsonb, '"files"'::jsonb)
		and jsonb_typeof(p_outcome -> 'deep') = 'boolean'
		and jsonb_typeof(p_outcome -> 'fsck') = 'object'
		and p_outcome -> 'fsck' ?& array['state','detail']
		and (p_outcome -> 'fsck') - array['state','detail'] = '{}'::jsonb
		and p_outcome -> 'fsck' -> 'state' in ('"ok"'::jsonb, '"problems"'::jsonb, '"timeout"'::jsonb, '"skipped"'::jsonb)
		and (p_outcome -> 'fsck' -> 'detail' = 'null'::jsonb or (jsonb_typeof(p_outcome -> 'fsck' -> 'detail') = 'string'
			and char_length(p_outcome -> 'fsck' ->> 'detail') <= 2000))
		and jsonb_typeof(p_outcome -> 'bundle') = 'object'
		and p_outcome -> 'bundle' ?& array['state','name','sha256','bytes','refsSha256']
		and (p_outcome -> 'bundle') - array['state','name','sha256','bytes','refsSha256'] = '{}'::jsonb
		and p_outcome -> 'bundle' -> 'state' in ('"stored"'::jsonb, '"unchanged"'::jsonb, '"skipped"'::jsonb,
			'"failed"'::jsonb, '"too-large"'::jsonb)
		and public.qorpera_code_care_text_valid(p_outcome -> 'bundle' -> 'name', '^[A-Za-z0-9._-]{1,200}$')
		and public.qorpera_code_care_text_valid(p_outcome -> 'bundle' -> 'sha256', '^[0-9a-f]{64}$')
		and public.qorpera_code_care_text_valid(p_outcome -> 'bundle' -> 'refsSha256', '^[0-9a-f]{64}$')
		and (p_outcome -> 'bundle' -> 'bytes' = 'null'::jsonb or (jsonb_typeof(p_outcome -> 'bundle' -> 'bytes') = 'number'
			and p_outcome -> 'bundle' ->> 'bytes' ~ '^[0-9]{1,15}$'))
		and (p_outcome -> 'bundle' -> 'state' <> '"stored"'::jsonb or not (p_outcome -> 'bundle' -> 'name' = 'null'::jsonb
			or p_outcome -> 'bundle' -> 'sha256' = 'null'::jsonb or p_outcome -> 'bundle' -> 'bytes' = 'null'::jsonb
			or p_outcome -> 'bundle' -> 'refsSha256' = 'null'::jsonb))
		and jsonb_typeof(p_outcome -> 'gc') = 'object'
		and (p_outcome -> 'gc') - array['state'] = '{}'::jsonb
		and p_outcome -> 'gc' -> 'state' in ('"collected"'::jsonb, '"held"'::jsonb, '"skipped"'::jsonb, '"shallow"'::jsonb,
			'"failed"'::jsonb, '"damaged"'::jsonb)
		and (p_outcome -> 'worktrees' = 'null'::jsonb or (jsonb_typeof(p_outcome -> 'worktrees') = 'number'
			and p_outcome ->> 'worktrees' ~ '^[0-9]{1,9}$'))
		and jsonb_typeof(p_outcome -> 'retired') = 'number' and p_outcome ->> 'retired' ~ '^[0-9]{1,4}$'
		and pg_column_size(p_outcome) <= 16384, false)
$$;

-- 3. Due ------------------------------------------------------------------------------------------------------------------

-- The repositories this executor may care for now, oldest due first, at most p_limit (1 to 50). Read-only.
create function public.qorpera_code_care_due(p_owner text, p_machine_id_sha256 text, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_due jsonb;
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 50 then
		raise exception 'Code care limit invalid' using errcode = '22023'; end if;
	select coalesce(jsonb_agg(jsonb_build_object('companyId', due.profile_id, 'environmentId', due.environment_id,
			'owner', due.owner, 'name', due.name)
		order by due.next_care_at, due.environment_id, due.owner collate "C", due.name collate "C"), '[]'::jsonb) into v_due
	from (select repository.profile_id, repository.environment_id, repository.owner, repository.name, repository.next_care_at
		from public.qorpera_code_repositories repository
		where repository.care_enabled and repository.next_care_at <= v_now
			and (repository.care_until is null or repository.care_until <= v_now)
			and public.qorpera_code_care_holder(repository.environment_id, p_owner, p_machine_id_sha256)
			and not exists (select 1 from public.qorpera_company_deletions deletion
				where deletion.profile_id = repository.profile_id)
			-- The company's coding sessions are quiet: none waits for an executor or is in a turn.
			and not exists (select 1 from public.qorpera_coding_sessions session
				where session.environment_id = repository.environment_id
					and session.phase in ('queued','input_ready','preparing','running','publishing'))
		order by repository.next_care_at, repository.environment_id, repository.owner collate "C", repository.name collate "C"
		limit p_limit) due;
	return jsonb_build_object('schema', 'qorpera.code-care-due/v1', 'repositories', v_due);
end $$;

-- 4. Step -----------------------------------------------------------------------------------------------------------------

-- Asked before each job of a care run. 'begin' takes no token and starts a run; every other step names the run's token
-- and renews its lease. Answers go (with the token, the lease, the switches and the last record; for 'retire' the
-- sessions whose worktrees may go), busy, lost or not-due. It locks the repository's registry row only.
create function public.qorpera_code_care_step(p_owner text, p_machine_id_sha256 text, p_environment_id uuid,
	p_repository_owner text, p_name text, p_token uuid, p_step text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp(); v_row public.qorpera_code_repositories%rowtype; v_retire uuid[];
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	if p_environment_id is null or p_repository_owner is null or p_name is null
		or coalesce(p_step, '') not in ('begin','check','fsck','bundle','gc','verify','retire','retire-git')
		or (p_step = 'begin') <> (p_token is null) then
		raise exception 'Code care step invalid' using errcode = '22023'; end if;
	select * into v_row from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name for update;
	-- A run is its token's and its starter's, for as long as its lease.
	if p_token is not null and (v_row.environment_id is null or v_row.care_token is distinct from p_token
		or v_row.care_owner is distinct from p_owner or v_row.care_until <= v_now) then
		return jsonb_build_object('schema', 'qorpera.code-care-step/v1', 'state', 'lost'); end if;
	-- Every check of due, again; a start also needs the repository due and no run holding the lease.
	if v_row.environment_id is null or not v_row.care_enabled
		or not public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256)
		or exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = v_row.profile_id)
		or (p_token is null and (v_row.next_care_at > v_now or coalesce(v_row.care_until > v_now, false))) then
		return jsonb_build_object('schema', 'qorpera.code-care-step/v1', 'state', 'not-due'); end if;
	-- Three starts and no finish since: no fourth tonight. The repository says so and waits for the next night.
	if p_token is null and v_row.care_attempts >= 3 then
		update public.qorpera_code_repositories set problem = 'CARE_DID_NOT_FINISH',
			problem_since = case when problem = 'CARE_DID_NOT_FINISH' then problem_since else v_now end,
			care_token = null, care_owner = null, care_until = null, care_attempts = 0,
			next_care_at = public.qorpera_code_care_next_at(owner, name, false, v_now)
		where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
		return jsonb_build_object('schema', 'qorpera.code-care-step/v1', 'state', 'not-due');
	end if;
	if exists (select 1 from public.qorpera_coding_sessions session where session.environment_id = p_environment_id
		and session.phase in ('queued','input_ready','preparing','running','publishing')) then
		return jsonb_build_object('schema', 'qorpera.code-care-step/v1', 'state', 'busy'); end if;
	if p_step = 'retire' and v_row.retire_enabled then
		-- This repository's sessions archived for 7 days, off every machine, with no turn open or unsettled. Those after
		-- the last one named come first, then the list starts again from its beginning.
		select array_agg(candidate.worker_id order by candidate.later desc, candidate.worker_id) into v_retire
		from (select session.worker_id, coalesce(session.worker_id > v_row.retire_cursor, false) as later
			from public.qorpera_coding_sessions session
			join public.qorpera_runtime_workers worker on worker.id = session.worker_id
			where session.environment_id = p_environment_id and session.repository ->> 'host' = 'qorpera'
				and session.repository ->> 'owner' = p_repository_owner and session.repository ->> 'name' = p_name
				and session.archived_at <= v_now - interval '168 hours' and session.attached_machine_id is null
				and worker.state <> 'active'
				and not exists (select 1 from public.qorpera_coding_session_turns turn
					where turn.worker_id = session.worker_id and turn.outcome is null)
			order by 2 desc, 1 limit 20) candidate;
	end if;
	update public.qorpera_code_repositories set
		care_token = case when p_token is null then extensions.gen_random_uuid() else care_token end,
		care_owner = p_owner, care_until = v_now + interval '2 hours',
		care_attempts = care_attempts + case when p_token is null then 1 else 0 end,
		retire_cursor = coalesce(v_retire[cardinality(v_retire)], retire_cursor)
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name
	returning * into v_row;
	return jsonb_build_object('schema', 'qorpera.code-care-step/v1', 'state', 'go', 'token', v_row.care_token,
			'leaseUntil', v_row.care_until,
			'flags', jsonb_build_object('gc', v_row.gc_enabled, 'retire', v_row.retire_enabled),
			'last', jsonb_build_object('refsSha256', v_row.refs_sha256, 'fsckState', v_row.fsck_state, 'fsckAt', v_row.fsck_at,
				'bundleRefsSha256', v_row.bundle_refs_sha256, 'bundleName', v_row.bundle_name, 'deepAt', v_row.deep_at))
		|| case when p_step = 'retire' then jsonb_build_object('retire', to_jsonb(coalesce(v_retire, '{}'::uuid[])))
			else '{}'::jsonb end;
end $$;

-- 5. Finish ---------------------------------------------------------------------------------------------------------------

-- A run's outcome. Recorded: what each part did, the problem and since when, the whole outcome; the lease ends, the
-- starts count from none again, and the next care is set. Lost: there is no token or it is not the run's, its lease
-- ended, or the caller is no enabled executor of the environment on that machine; nothing is written then.
create function public.qorpera_code_care_finish(p_owner text, p_machine_id_sha256 text, p_environment_id uuid,
	p_repository_owner text, p_name text, p_token uuid, p_outcome jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp(); v_row public.qorpera_code_repositories%rowtype; v_problem text;
	v_fsck text; v_bundle jsonb; v_gc text; v_next timestamptz;
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	if p_environment_id is null or p_repository_owner is null or p_name is null
		or not public.qorpera_code_care_outcome_valid(p_outcome) then
		raise exception 'Code care outcome invalid' using errcode = '22023'; end if;
	select * into v_row from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name for update;
	-- No token is no run's: a start that was answered busy or not-due has none to finish.
	if p_token is null or v_row.environment_id is null or v_row.care_token is distinct from p_token
		or v_row.care_owner is distinct from p_owner or v_row.care_until <= v_now
		or not exists (select 1 from public.qorpera_coding_executors executor
			where executor.environment_id = p_environment_id and executor.owner = p_owner and executor.enabled
				and executor.nas_machine_id_sha256 = p_machine_id_sha256) then
		return jsonb_build_object('schema', 'qorpera.code-care-finish/v1', 'state', 'lost'); end if;
	v_problem := p_outcome ->> 'problem';
	v_fsck := p_outcome -> 'fsck' ->> 'state';
	v_bundle := p_outcome -> 'bundle';
	v_gc := p_outcome -> 'gc' ->> 'state';
	update public.qorpera_code_repositories set
		care_token = null, care_owner = null, care_until = null, care_attempts = 0,
		next_care_at = public.qorpera_code_care_next_at(owner, name, p_outcome ->> 'state' = 'busy', v_now),
		last_care_at = v_now,
		last_ok_at = case when p_outcome ->> 'state' = 'done' and v_problem is null then v_now else last_ok_at end,
		-- The same problem keeps the time it was first seen. A run put off as busy looked at nothing, or not at
		-- everything: when it names no problem, last night's stays until a run that finishes says otherwise.
		problem = case when p_outcome ->> 'state' = 'busy' and v_problem is null then problem else v_problem end,
		problem_since = case when p_outcome ->> 'state' = 'busy' and v_problem is null then problem_since
			when v_problem is null then null when v_problem = problem then problem_since else v_now end,
		main_sha = coalesce(p_outcome ->> 'mainSha', main_sha),
		-- Only a clean fsck moves the refs the next run compares with.
		refs_sha256 = case when v_fsck = 'ok' then coalesce(p_outcome ->> 'refsSha256', refs_sha256) else refs_sha256 end,
		fsck_state = case when v_fsck <> 'skipped' then v_fsck else fsck_state end,
		fsck_at = case when v_fsck <> 'skipped' then v_now else fsck_at end,
		deep_at = case when (p_outcome ->> 'deep')::boolean then v_now else deep_at end,
		bundle_at = case when v_bundle ->> 'state' = 'stored' then v_now else bundle_at end,
		bundle_name = case when v_bundle ->> 'state' = 'stored' then v_bundle ->> 'name' else bundle_name end,
		bundle_sha256 = case when v_bundle ->> 'state' = 'stored' then v_bundle ->> 'sha256' else bundle_sha256 end,
		bundle_bytes = case when v_bundle ->> 'state' = 'stored' then (v_bundle ->> 'bytes')::bigint else bundle_bytes end,
		bundle_refs_sha256 = case when v_bundle ->> 'state' = 'stored' then v_bundle ->> 'refsSha256'
			else bundle_refs_sha256 end,
		gc_at = case when v_gc = 'collected' then v_now else gc_at end,
		-- A pack found damaged is the last until an operator switches packing on again.
		gc_enabled = gc_enabled and v_gc <> 'damaged',
		worktrees = coalesce((p_outcome ->> 'worktrees')::integer, worktrees),
		retired = retired + (p_outcome ->> 'retired')::integer,
		outcome = p_outcome
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name
	returning next_care_at into v_next;
	return jsonb_build_object('schema', 'qorpera.code-care-finish/v1', 'state', 'recorded', 'nextCareAt', v_next);
end $$;

-- Grants ------------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_code_repository_register(),
	public.qorpera_code_repositories_backfill(),
	public.qorpera_code_care_holder(uuid, text, text),
	public.qorpera_code_care_next_at(text, text, boolean, timestamptz),
	public.qorpera_code_care_text_valid(jsonb, text),
	public.qorpera_code_care_outcome_valid(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_code_care_due(text, text, integer),
	public.qorpera_code_care_step(text, text, uuid, text, text, uuid, text),
	public.qorpera_code_care_finish(text, text, uuid, text, text, uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_code_care_due(text, text, integer),
	public.qorpera_code_care_step(text, text, uuid, text, text, uuid, text),
	public.qorpera_code_care_finish(text, text, uuid, text, text, uuid, jsonb)
	to service_role;
