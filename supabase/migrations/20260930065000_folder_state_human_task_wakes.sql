-- Human-task wakes on folder-v2, H2c = P31 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (P31)"; the
-- coordinator's decisions of 4 October). Folder-v2 only. Every new or patched body carries the marker 20260930065000.
--
-- 1. P29's commit hook writes a pending marker for each task change that should wake an agent: done and declined, an
--    accepted, returned or cancelled task, a new person, a hand-off and a new task someone else names the agent in. It
--    writes no wake, chooses no payer and locks nothing but its own new rows; it ignores a pause.
-- 2. A shared folder drain, `human_tasks`, after the listener in the orchestrator's pass, makes every wake: the change
--    markers, and an overdue wake once per (task, due). One company per call, in the core's lock order, admission last.
-- 3. The member who started the task pays, through qorpera_starter_sponsor with no preferred binding. If they have left,
--    or no login of theirs can pay, or it is a ChatGPT plan, the wake is not made: the marker stays `unpaid`, and only a
--    member who chooses to pay (qorpera_folder_human_task_wake_continue) re-arms it. Nobody else pays in their place.
-- 4. The wake is an `agent` wake with source kind `human-task`, no parent run, its source the task. The pin trigger and
--    the wake's authority take its agent, payer and acting agent from the marker and the task, never from the inserter.

set local lock_timeout = '3s';

create function pg_temp.p31_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P31 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The wake source kind, keeping whatever kinds master already has ---------------------------------------------------

do $$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition from pg_constraint
	where conname = 'qorpera_wake_occurrences_source_kind_check' and conrelid = 'public.qorpera_wake_occurrences'::regclass;
	if v_definition is null or v_definition !~ '^CHECK \(\(source_kind = ANY \(ARRAY\[' then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	select array_agg(match[1] order by ordinality) into v_kinds
	from regexp_matches(v_definition, '''([a-z0-9_-]+)''::text', 'g') with ordinality as found(match, ordinality);
	if not ('event' = any (v_kinds) and 'worker-completion' = any (v_kinds)) or 'human-task' = any (v_kinds)
		or cardinality(v_kinds) <> (length(v_definition) - length(replace(v_definition, '::text', ''))) / length('::text') then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
	execute format('alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
		check (source_kind = any (array[%s]))',
		(select string_agg(quote_literal(kind), ', ' order by ordinality) from unnest(v_kinds || array['human-task'])
			with ordinality as listed(kind, ordinality)));
end
$$;

-- 2. The markers ---------------------------------------------------------------------------------------------------------
-- One per wake an agent should get: a task change (keyed by the task and its change set) or an overdue task (keyed by the
-- task and its due). Ids only, no path. `expect`: what the change left in the task's index row, which must still hold
-- when the wake is made. The folder clock cascade: the deletion purge takes the fence first, and the hook and the drain
-- take marker rows only after it.
create table public.qorpera_folder_human_task_wakes (
	id bigint generated always as identity primary key,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	profile_id uuid not null,
	task_id uuid not null,
	reason text not null check (reason in ('done','declined','accepted','returned','cancelled','person','handoff','assigned',
		'overdue')),
	commit_id uuid,
	seq bigint,
	due_at timestamptz,
	expect jsonb not null default '{}'::jsonb check (jsonb_typeof(expect) = 'object'),
	actor_staff_agent_id uuid,
	actor_user_id uuid,
	occurrence_key text not null check (char_length(occurrence_key) between 1 and 160),
	state text not null default 'pending' check (state in ('pending','woken','skipped','unpaid')),
	problem text check (problem is null or char_length(problem) between 1 and 64),
	-- A member who chose to pay for this wake (qorpera_folder_human_task_wake_continue); otherwise the task's starter.
	payer_user_id uuid,
	wake_id uuid,
	attempts integer not null default 0 check (attempts >= 0),
	last_attempt_at timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (environment_id, occurrence_key),
	check ((reason = 'overdue') = (due_at is not null) and (reason = 'overdue') = (commit_id is null)),
	check ((state = 'woken') = (wake_id is not null))
);
create index qorpera_folder_human_task_wakes_pending on public.qorpera_folder_human_task_wakes(environment_id, id)
	where state = 'pending';
create index qorpera_folder_human_task_wakes_task on public.qorpera_folder_human_task_wakes(environment_id, task_id);
alter table public.qorpera_folder_human_task_wakes enable row level security;
revoke all on public.qorpera_folder_human_task_wakes from public, anon, authenticated, service_role;

-- The overdue scan's index: open and returned tasks by due (STATE §9).
create index qorpera_folder_human_task_index_due on public.qorpera_folder_human_task_index(environment_id, due_at)
	where retired_at is null and status in ('open','returned');

-- 3. Helpers -------------------------------------------------------------------------------------------------------------

-- An overdue wake's key: one per (task, due); a return or a new due is always later, so it re-arms the wake.
create function public.qorpera_folder_human_task_due_key(p_task_id uuid, p_due_at timestamptz)
returns text language sql immutable set search_path = '' as $$
	-- 20260930065000 (P31).
	select 'human-task-due:' || p_task_id::text || ':' || (extract(epoch from p_due_at) * 1000000)::bigint::text
$$;

-- The agent a task's wake goes to: its `from` while active in the environment, else the Co-Founder (which may hand the
-- task on, H2).
create function public.qorpera_folder_human_task_recipient(p_profile_id uuid, p_environment_id uuid, p_from uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	-- 20260930065000 (P31).
	select case when exists (select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id
			and s.staff_agent_id = p_from and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
			and s.deleted_at is null and s.employment_status = 'active') then p_from
		else (select c.staff_agent_id from public.qorpera_company_cofounders c where c.profile_id = p_profile_id) end
$$;

-- The login that pays for a task's wake: the payer member's own, as qorpera_starter_sponsor chooses it for new work, never
-- a ChatGPT plan (a person's change or the clock is not the plan owner's own request, 20260928359950). Null: none.
create function public.qorpera_folder_human_task_sponsor(p_profile_id uuid, p_payer uuid, p_staff_agent_id uuid)
returns table(binding_id uuid, version bigint) language sql stable security definer set search_path = '' as $$
	-- 20260930065000 (P31).
	select s.binding_id, s.version from public.qorpera_starter_sponsor(p_profile_id, p_payer, p_staff_agent_id, null) s
	where not public.qorpera_sponsor_version_is_chatgpt_plan(s.binding_id, s.version)
$$;

-- A wake's marker: the one its key names, for its task, that names this wake or (while it is made) no wake yet.
create function public.qorpera_folder_human_task_wake_marker(p_wake public.qorpera_wake_occurrences)
returns public.qorpera_folder_human_task_wakes language sql stable security definer set search_path = '' as $$
	-- 20260930065000 (P31).
	select m.* from public.qorpera_folder_human_task_wakes m
	where m.environment_id = p_wake.environment_id and m.occurrence_key = p_wake.occurrence_key
		and m.task_id = p_wake.source_id and m.profile_id = p_wake.profile_id and (m.wake_id is null or m.wake_id = p_wake.id)
$$;

-- Whether a wake that has not run yet still fits its task: the task is live, the agent is the task's recipient and the
-- requester its payer. Once its run is admitted, a later change of the task (the run's own hand-off, a deletion) no longer
-- takes its authority away, as a routine's run outlives the routine's change.
create function public.qorpera_folder_human_task_wake_fits(p_wake public.qorpera_wake_occurrences,
	p_mark public.qorpera_folder_human_task_wakes)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930065000 (P31).
	select exists (select 1 from public.qorpera_folder_human_task_index t
		where t.environment_id = p_wake.environment_id and t.id = p_mark.task_id and t.retired_at is null
			and p_wake.staff_agent_id = public.qorpera_folder_human_task_recipient(p_mark.profile_id, p_mark.environment_id,
				t.from_staff_agent_id)
			and p_wake.requested_by_user_id = coalesce(p_mark.payer_user_id, t.started_by_user_id))
$$;

-- The wake's payload as its run reads it: the stored ids, and the task's path, title, status and due when the run may read
-- the task's file (a wake row never holds a path, so erasure needs no scrub).
create function public.qorpera_folder_human_task_wake_payload(p_wake public.qorpera_wake_occurrences, p_actor jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_task public.qorpera_folder_human_task_index%rowtype; v_shown jsonb := null;
begin
	-- 20260930065000 (P31).
	select * into v_task from public.qorpera_folder_human_task_index
	where environment_id = p_wake.environment_id and id = p_wake.source_id and retired_at is null;
	if v_task.id is not null
		and public.qorpera_folder_actor_allowed(p_wake.environment_id, p_wake.profile_id, p_actor, v_task.folder_path, 'read') then
		v_shown := jsonb_build_object('path', v_task.folder_path, 'title', v_task.title, 'status', v_task.status,
			'due', to_char(v_task.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
	end if;
	return p_wake.payload || jsonb_build_object('task', v_shown);
end $$;

revoke all on function public.qorpera_folder_human_task_due_key(uuid, timestamptz),
	public.qorpera_folder_human_task_recipient(uuid, uuid, uuid),
	public.qorpera_folder_human_task_sponsor(uuid, uuid, uuid),
	public.qorpera_folder_human_task_wake_marker(public.qorpera_wake_occurrences),
	public.qorpera_folder_human_task_wake_fits(public.qorpera_wake_occurrences, public.qorpera_folder_human_task_wakes),
	public.qorpera_folder_human_task_wake_payload(public.qorpera_wake_occurrences, jsonb)
	from public, anon, authenticated, service_role;

-- 4. P29's commit hook: the markers (LISTENER §8) ------------------------------------------------------------------------
-- Called per change set in seq order, after the listener's admission (or none). It reads the change set's task files
-- through the commit-and-key index on path versions, compares each with the version it replaced, and inserts a marker per
-- change that should wake an agent, by anyone but that agent. No exception block, no lock but its own new rows (and the
-- folder clock's KEY SHARE for their foreign key), and the pause ignored: the drain waits for the resume. The targets hook
-- stays empty.
create or replace function public.qorpera_folder_listener_commit(p_environment_id uuid, p_commit jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_commit public.qorpera_folder_commits%rowtype; v_profile uuid; v_staff uuid; v_user uuid; v_row record;
	v_reason text; v_expect jsonb;
begin
	-- 20260930020000 (P29), 20260930065000 (P31): human-task wake markers.
	select * into v_commit from public.qorpera_folder_commits
	where id = (p_commit ->> 'commitId')::uuid and environment_id = p_environment_id and seq is not null;
	if not found then return; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return; end if;
	v_staff := case when v_commit.actor_kind = 'staff_agent' then v_commit.actor_id end;
	v_user := case when v_commit.actor_kind = 'member' then v_commit.actor_id end;
	-- Each task the change set wrote: the parse its last version left, and the one its first version replaced, when that
	-- was this task (a write's prior version is the path's, a move_in's is the moved file's; a path that held another
	-- task, or nothing, makes this a new task).
	for v_row in
		with task_version as (
			select v.structured -> 'parse' as parse, (v.structured -> 'parse' ->> 'id')::uuid as id, v.prior_version,
				row_number() over (partition by v.structured -> 'parse' ->> 'id' order by v.unit_no, v.created_at, v.version) as first,
				row_number() over (partition by v.structured -> 'parse' ->> 'id'
					order by v.unit_no desc, v.created_at desc, v.version desc) as last
			from public.qorpera_folder_path_versions v
			where v.commit_id = v_commit.id
				and public.qorpera_folder_key(v.path) collate "C" >= 'human-tasks/' collate "C"
				and public.qorpera_folder_key(v.path) collate "C" < 'human-tasks0' collate "C"
				and public.qorpera_folder_key(v.path) ~ '^human-tasks/[^/]+\.md$'
				and v.op in ('write', 'move_in') and v.structured ->> 'kind' = 'human-task')
		select now.id, now.parse as now, (select p.structured -> 'parse' from public.qorpera_folder_path_versions p
				where p.version = was.prior_version and (p.structured -> 'parse' ->> 'id')::uuid = now.id) as was
		from task_version now join task_version was on was.id = now.id and was.first = 1
		where now.last = 1 order by now.id
	loop
		v_reason := null;
		if v_row.was is null then
			-- A new task (a restored one is final: only final tasks are deleted) named after an agent by someone else.
			if v_row.now ->> 'status' = 'open' then
				v_reason := 'assigned';
				v_expect := jsonb_build_object('status', 'open', 'from_staff_agent_id', to_jsonb((v_row.now ->> 'from')::uuid));
			end if;
		elsif (v_row.now ->> 'from')::uuid is distinct from (v_row.was ->> 'from')::uuid then
			v_reason := 'handoff'; v_expect := jsonb_build_object('from_staff_agent_id', to_jsonb((v_row.now ->> 'from')::uuid));
		elsif v_row.now ->> 'status' is distinct from v_row.was ->> 'status'
			and v_row.now ->> 'status' in ('done','declined','accepted','returned','cancelled') then
			v_reason := v_row.now ->> 'status';
			v_expect := jsonb_build_object('status', v_row.now ->> 'status',
				'from_staff_agent_id', to_jsonb((v_row.now ->> 'from')::uuid));
		elsif (v_row.now ->> 'member')::uuid is distinct from (v_row.was ->> 'member')::uuid
			or (v_row.now ->> 'contact')::uuid is distinct from (v_row.was ->> 'contact')::uuid then
			v_reason := 'person';
			v_expect := jsonb_build_object('member_user_id', to_jsonb((v_row.now ->> 'member')::uuid),
				'contact_id', to_jsonb((v_row.now ->> 'contact')::uuid), 'from_staff_agent_id', to_jsonb((v_row.now ->> 'from')::uuid));
		end if;
		-- The agent's own change wakes nobody (the Co-Founder standing in is checked when the wake is made).
		continue when v_reason is null or (v_staff is not null and (v_row.now ->> 'from')::uuid = v_staff);
		insert into public.qorpera_folder_human_task_wakes(environment_id, profile_id, task_id, reason, commit_id, seq, expect,
			actor_staff_agent_id, actor_user_id, occurrence_key)
		values (p_environment_id, v_profile, v_row.id, v_reason, v_commit.id, v_commit.seq, v_expect, v_staff, v_user,
			'human-task:' || v_row.id::text || ':' || v_commit.id::text)
		on conflict (environment_id, occurrence_key) do nothing;
	end loop;
end $$;

-- 5. The drain (LISTENER §9: the shared folder drains' `human_tasks`) ------------------------------------------------------

-- Folder-v2 environments with a pending marker whose retry time has come, or an open or returned task past its due with
-- no marker for that due; not paused (the drain does nothing while paused) and not being deleted.
create function public.qorpera_folder_human_tasks_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_environments uuid[];
begin
	-- 20260930065000 (P31).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder human-task drain limit is invalid' using errcode = '22023'; end if;
	select coalesce(array_agg(x.environment_id order by x.environment_id), '{}') into v_environments from (
		select f.environment_id from public.qorpera_company_files f
		where f.core = 'folder-v2' and (p_after_environment is null or f.environment_id > p_after_environment)
			and (exists (select 1 from public.qorpera_folder_human_task_wakes m where m.environment_id = f.environment_id
					and m.state = 'pending' and (m.last_attempt_at is null
						or public.qorpera_folder_listener_retry_at(m.attempts, m.last_attempt_at) <= clock_timestamp()))
				or exists (select 1 from public.qorpera_folder_human_task_index t where t.environment_id = f.environment_id
					and t.retired_at is null and t.status in ('open','returned') and t.due_at <= clock_timestamp()
					and not exists (select 1 from public.qorpera_folder_human_task_wakes m where m.environment_id = t.environment_id
						and m.occurrence_key = public.qorpera_folder_human_task_due_key(t.id, t.due_at))))
			and not public.qorpera_company_execution_paused(f.profile_id)
		order by f.environment_id limit p_limit) x;
	return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('environment_id', e) order by e)
			from unnest(v_environments) e), '[]'::jsonb),
		'has_more', cardinality(v_environments) = p_limit,
		'next_after_environment_id', case when cardinality(v_environments) = p_limit
			then v_environments[cardinality(v_environments)] end);
end $$;

-- One company's task wakes, in its own transaction (never inside the materializer's). Answers {schema, state: done | idle
-- | paused | busy | deleting | not_folder, woken, skipped, unpaid, held}.
create function public.qorpera_folder_human_tasks_company(p_environment_id uuid, p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.folder-human-task-wakes/v1';
	-- Writing subtransactions a call, besides its own and the wake nudge's (core §3 step 7: under 64).
	c_blocks constant integer := 40;
	v_profile uuid; v_pending bigint[]; v_overdue uuid[]; v_held bigint[]; v_items jsonb; v_targets jsonb; v_sessions uuid[];
	v_agents uuid[]; v_payers uuid[];
	v_mark public.qorpera_folder_human_task_wakes%rowtype; v_task public.qorpera_folder_human_task_index%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_id bigint; v_recipient uuid; v_payer uuid; v_binding uuid; v_version bigint;
	v_state text; v_problem text; v_message text; v_blocks integer := 0;
	v_woken integer := 0; v_skipped integer := 0; v_unpaid integer := 0; v_busy integer := 0;
begin
	-- 20260930065000 (P31).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder human-task drains run at read committed' using errcode = '25000'; end if;
	if p_limit is null or p_limit not between 1 and 32 then
		raise exception 'Folder human-task drain limit is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('schema', c_schema, 'state', 'not_folder'); end if;
	if public.qorpera_company_deleting(v_profile) then return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
	if public.qorpera_company_execution_paused(v_profile) then return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;

	-- 1. Plain reads: pending markers whose retry time came, oldest first; then overdue tasks with no marker for their due.
	select coalesce(array_agg(m.id order by m.id), '{}') into v_pending from (
		select m.id from public.qorpera_folder_human_task_wakes m
		where m.environment_id = p_environment_id and m.state = 'pending'
			and (m.last_attempt_at is null or public.qorpera_folder_listener_retry_at(m.attempts, m.last_attempt_at) <= clock_timestamp())
		order by m.id limit p_limit) m;
	select coalesce(array_agg(t.id order by t.due_at, t.id), '{}') into v_overdue from (
		select t.id, t.due_at from public.qorpera_folder_human_task_index t
		where t.environment_id = p_environment_id and t.retired_at is null and t.status in ('open','returned')
			and t.due_at <= clock_timestamp()
			and not exists (select 1 from public.qorpera_folder_human_task_wakes m where m.environment_id = t.environment_id
				and m.occurrence_key = public.qorpera_folder_human_task_due_key(t.id, t.due_at))
		order by t.due_at, t.id limit p_limit - cardinality(v_pending)) t;
	if cardinality(v_pending) + cardinality(v_overdue) = 0 then
		return jsonb_build_object('schema', c_schema, 'state', 'idle'); end if;
	-- Who each wake would go to and who would pay, as read now. The drain key-shares their rows and the woken agents' threads,
	-- and takes each task FOR SHARE (a save of the task waits for the drain, and the drain for it); a wake whose agent or
	-- payer changed meanwhile waits for the next pass.
	select coalesce(jsonb_agg(jsonb_build_object('task_id', x.task_id, 'payer', x.payer, 'recipient',
			public.qorpera_folder_human_task_recipient(v_profile, p_environment_id, x.from_staff_agent_id))), '[]'::jsonb)
	into v_items
	from (select t.id as task_id, t.from_staff_agent_id, coalesce(m.payer_user_id, t.started_by_user_id) as payer
			from public.qorpera_folder_human_task_wakes m join public.qorpera_folder_human_task_index t
				on t.environment_id = m.environment_id and t.id = m.task_id
			where m.id = any (v_pending)
			union all
			select t.id, t.from_staff_agent_id, t.started_by_user_id from public.qorpera_folder_human_task_index t
			where t.environment_id = p_environment_id and t.id = any (v_overdue)) x;
	select coalesce(jsonb_agg(y.t), '[]'::jsonb) into v_targets from (
		select distinct x.t from jsonb_to_recordset(v_items) i(task_id uuid, recipient uuid, payer uuid), lateral (values
			(case when i.payer is not null then jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
				'key', v_profile::text || ':' || i.payer::text, 'mode', 'keyshare') end),
			(case when i.recipient is not null then jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
				'key', v_profile::text || ':' || i.recipient::text, 'mode', 'keyshare') end),
			(case when i.recipient is not null then jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', v_profile::text || ':' || i.recipient::text, 'mode', 'keyshare') end),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_folder_human_task_index',
				'key', p_environment_id::text || ':' || i.task_id::text, 'mode', 'share'))) x(t)
		where x.t is not null) y;
	select coalesce(array_agg(distinct i.recipient) filter (where i.recipient is not null), '{}'),
		coalesce(array_agg(distinct i.payer) filter (where i.payer is not null), '{}'),
		coalesce(array_agg(distinct s.id) filter (where s.id is not null), '{}')
	into v_agents, v_payers, v_sessions
	from jsonb_to_recordset(v_items) i(task_id uuid, recipient uuid, payer uuid),
		lateral (select public.qorpera_folder_wake_public_session(v_profile, p_environment_id, i.recipient, i.payer) as id) s;

	begin
		-- 2. The fence KEY SHARE (the pause read again below), rank 0, ranks 1 to 5.
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;
		-- 3. The woken agents' threads the wakes key-share, then admission, then the markers (LISTENER §8: after admission).
		perform 1 from public.qorpera_shared_sessions s where s.profile_id = v_profile and s.id = any (v_sessions)
		order by s.id for key share;
		perform public.qorpera_folder_admit_wakes(v_profile);
		select coalesce(array_agg(m.id order by m.id), '{}') into v_held from (
			select m.id from public.qorpera_folder_human_task_wakes m where m.id = any (v_pending) and m.state = 'pending'
			order by m.id for update skip locked) m;
		-- An overdue task's marker, for the due it has now (read again under the task's lock).
		with made as (
			insert into public.qorpera_folder_human_task_wakes(environment_id, profile_id, task_id, reason, due_at, occurrence_key)
			select t.environment_id, v_profile, t.id, 'overdue', t.due_at, public.qorpera_folder_human_task_due_key(t.id, t.due_at)
			from public.qorpera_folder_human_task_index t
			where t.environment_id = p_environment_id and t.id = any (v_overdue) and t.retired_at is null
				and t.status in ('open','returned') and t.due_at <= clock_timestamp()
			on conflict (environment_id, occurrence_key) do nothing
			returning id)
		select v_held || coalesce(array_agg(made.id order by made.id), '{}') into v_held from made;

		-- 4. One block per marker.
		foreach v_id in array v_held loop
			exit when v_blocks >= c_blocks;
			v_blocks := v_blocks + 1;
			select * into v_mark from public.qorpera_folder_human_task_wakes where id = v_id;
			select * into v_task from public.qorpera_folder_human_task_index
			where environment_id = p_environment_id and id = v_mark.task_id;
			v_state := null; v_problem := null; v_binding := null; v_version := null;
			v_recipient := public.qorpera_folder_human_task_recipient(v_profile, p_environment_id, v_task.from_staff_agent_id);
			v_payer := coalesce(v_mark.payer_user_id, v_task.started_by_user_id);
			-- The checks the wake's triggers make, first, so an insert does not raise.
			if v_task.id is null or v_task.retired_at is not null then
				v_state := 'skipped'; v_problem := 'task_gone';
			elsif v_mark.reason = 'overdue' and (v_task.status not in ('open','returned') or v_task.due_at <> v_mark.due_at) then
				v_state := 'skipped'; v_problem := 'changed';
			elsif exists (select 1 from jsonb_each(v_mark.expect) e
					where coalesce(to_jsonb(v_task) -> e.key, 'null'::jsonb) is distinct from e.value) then
				-- A late or retried change the task has moved on from.
				v_state := 'skipped'; v_problem := 'changed';
			elsif v_recipient is null or v_recipient is not distinct from v_mark.actor_staff_agent_id then
				v_state := 'skipped'; v_problem := 'own_change';
			elsif v_payer is null or not exists (select 1 from public.qorpera_profile_members m
					where m.profile_id = v_profile and m.user_id = v_payer) then
				-- The member who started the task has left: nobody else pays unless they choose to.
				v_state := 'unpaid'; v_problem := 'starter_left';
			elsif not (v_recipient = any (v_agents) and v_payer = any (v_payers)) then
				-- Its agent or payer changed after the plain read: the rows this call holds are not theirs. The next pass.
				update public.qorpera_folder_human_task_wakes set attempts = attempts + 1, last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp() where id = v_id;
				v_busy := v_busy + 1;
				continue;
			else
				select s.binding_id, s.version into v_binding, v_version
				from public.qorpera_starter_sponsor(v_profile, v_payer, v_recipient, null) s;
				if v_binding is null then
					v_state := 'unpaid'; v_problem := 'no_payer';
				elsif public.qorpera_sponsor_version_is_chatgpt_plan(v_binding, v_version) then
					v_state := 'unpaid'; v_problem := 'plan';
				end if;
			end if;
			if v_state is not null then
				update public.qorpera_folder_human_task_wakes set state = v_state, problem = v_problem,
					attempts = attempts + 1, last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
				where id = v_id;
				if v_state = 'unpaid' then v_unpaid := v_unpaid + 1; else v_skipped := v_skipped + 1; end if;
				continue;
			end if;
			begin
				-- The pin trigger takes the agent, the payer, the thread and the payload from the marker and the task.
				insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id,
					staff_agent_id, requested_by_user_id, trigger_id, occurrence_key, scheduled_for, not_before)
				values (extensions.gen_random_uuid(), v_profile, p_environment_id, 'agent', 'human-task', v_task.id, v_recipient,
					v_payer, 'human-task', v_mark.occurrence_key, clock_timestamp(), clock_timestamp())
				returning * into v_wake;
				if v_wake.status = 'queued' then
					update public.qorpera_folder_human_task_wakes set state = 'woken', wake_id = v_wake.id, problem = null,
						attempts = attempts + 1, last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = v_id;
					v_woken := v_woken + 1;
				else
					update public.qorpera_folder_human_task_wakes set state = 'skipped',
						problem = left(coalesce(v_wake.blocked_reason, 'refused'), 64), attempts = attempts + 1,
						last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = v_id;
					v_skipped := v_skipped + 1;
				end if;
			exception
				when lock_not_available or deadlock_detected then
					-- Tried again after its wait (the marker stays pending).
					update public.qorpera_folder_human_task_wakes set attempts = attempts + 1, last_attempt_at = clock_timestamp(),
						updated_at = clock_timestamp() where id = v_id;
					v_busy := v_busy + 1;
				when insufficient_privilege or no_data_found or object_not_in_prerequisite_state or unique_violation then
					get stacked diagnostics v_message = message_text;
					update public.qorpera_folder_human_task_wakes
					set state = case when v_message = 'No model account can pay for this work' then 'unpaid' else 'skipped' end,
						problem = case when v_message = 'No model account can pay for this work' then 'no_payer' else left(sqlstate, 64) end,
						attempts = attempts + 1, last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = v_id;
					if v_message = 'No model account can pay for this work' then v_unpaid := v_unpaid + 1;
					else v_skipped := v_skipped + 1; end if;
			end;
		end loop;
	exception when lock_not_available or deadlock_detected then
		return jsonb_build_object('schema', c_schema, 'state', 'busy');
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'woken', v_woken, 'skipped', v_skipped, 'unpaid', v_unpaid,
		'held', v_busy);
end $$;

-- 6. A member chooses to pay (4 October: nobody pays in someone else's place without choosing to) ----------------------

-- Re-arms a task's unpaid wakes with the calling member as their payer (an owner, admin or contributor). The drain tries
-- them again on its next pass; a login of theirs that cannot pay leaves them unpaid again. Locks only the markers.
create function public.qorpera_folder_human_task_wake_continue(p_environment_id uuid, p_task_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_user uuid := auth.uid(); v_profile uuid; v_count integer;
begin
	-- 20260930065000 (P31).
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Company membership is required' using errcode = '42501'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null or not exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_profile
			and m.user_id = v_user and m.role::text <> 'viewer') then
		raise exception 'Company membership is required' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_profile) then
		raise exception 'Company is being deleted' using errcode = '55000'; end if;
	update public.qorpera_folder_human_task_wakes set payer_user_id = v_user, state = 'pending', problem = null, attempts = 0,
		last_attempt_at = null, updated_at = clock_timestamp()
	where environment_id = p_environment_id and task_id = p_task_id and state = 'unpaid';
	get diagnostics v_count = row_count;
	return jsonb_build_object('schema', 'qorpera.human-task-wake-continue/v1', 'taskId', p_task_id, 'rearmed', v_count);
end $$;

-- The company's unpaid task wakes, for its members (the web shows them with "continue with my login"; Interfaces, later).
create function public.qorpera_member_folder_human_task_waits(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_profile uuid;
begin
	-- 20260930065000 (P31).
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Company membership is required' using errcode = '42501'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null or not exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_profile
			and m.user_id = v_user) then
		raise exception 'Company membership is required' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.human-task-waits/v1', 'waits', coalesce((select jsonb_agg(jsonb_build_object(
			'taskId', m.task_id, 'reason', m.reason, 'problem', m.problem,
			'at', to_char(m.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) order by m.id)
		from (select * from public.qorpera_folder_human_task_wakes m where m.environment_id = p_environment_id
			and m.state = 'unpaid' order by m.id limit 200) m), '[]'::jsonb));
end $$;

revoke all on function public.qorpera_folder_human_tasks_due(uuid, integer),
	public.qorpera_folder_human_tasks_company(uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_folder_human_tasks_due(uuid, integer),
	public.qorpera_folder_human_tasks_company(uuid, integer) to service_role;
revoke all on function public.qorpera_folder_human_task_wake_continue(uuid, uuid),
	public.qorpera_member_folder_human_task_waits(uuid) from public, anon, service_role;
grant execute on function public.qorpera_folder_human_task_wake_continue(uuid, uuid),
	public.qorpera_member_folder_human_task_waits(uuid) to authenticated;

-- 7. The wake's acceptance ------------------------------------------------------------------------------------------------

-- A ChatGPT plan pays for no human-task wake, nor for what follows one (20260928359950).
create or replace function public.qorpera_listener_source(p_source_kind text)
returns boolean language sql immutable set search_path = '' as $$
	-- 20260928359950, 20260930065000 (P31): human-task wakes come from someone else's change or the clock.
	select p_source_kind in ('company-file', 'event', 'human-task')
$$;

-- The pin trigger: a human-task branch before the parent run's read.
select pg_temp.p31_replace('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$	v_trigger jsonb; v_ancestry jsonb; v_actor uuid; v_room public.qorpera_company_rooms%rowtype;$old$,
	$new$	v_trigger jsonb; v_ancestry jsonb; v_actor uuid; v_room public.qorpera_company_rooms%rowtype;
	v_p31_mark public.qorpera_folder_human_task_wakes%rowtype; v_p31_task public.qorpera_folder_human_task_index%rowtype;$new$);
select pg_temp.p31_replace('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$	elsif new.wake_kind = 'agent' then
		select * into strict v_run from public.qorpera_execution_runs where id = new.parent_run_id$old$,
	$new$	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then
		-- 20260930065000 (P31): a human task's wake has no parent run. Its pending marker (named by the key) and its task give
		-- the woken agent, the payer, the payload and the agent whose change it is; nothing the inserter sends is trusted.
		select * into v_p31_mark from public.qorpera_folder_human_task_wakes m where m.environment_id = new.environment_id
			and m.occurrence_key = new.occurrence_key and m.task_id = new.source_id and m.profile_id = new.profile_id
			and m.state = 'pending' and m.wake_id is null;
		select * into v_p31_task from public.qorpera_folder_human_task_index t where t.environment_id = new.environment_id
			and t.id = new.source_id and t.retired_at is null;
		if not public.qorpera_company_is_folder_v2(new.profile_id) or v_p31_mark.id is null or v_p31_task.id is null
			or new.parent_run_id is not null or new.file_event_id is not null then
			raise exception 'Wake task is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := public.qorpera_folder_human_task_recipient(new.profile_id, new.environment_id,
			v_p31_task.from_staff_agent_id);
		new.requested_by_user_id := coalesce(v_p31_mark.payer_user_id, v_p31_task.started_by_user_id);
		new.trigger_id := 'human-task';
		new.payload := jsonb_build_object('schema', 'qorpera.human-task-wake/v1', 'taskId', v_p31_mark.task_id,
			'reason', v_p31_mark.reason, 'commitId', v_p31_mark.commit_id,
			'dueAt', to_char(v_p31_mark.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_folder_human_task_sponsor(new.profile_id, new.requested_by_user_id, new.staff_agent_id) as payer;
		if new.sponsor_binding_id is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;
		select * into v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id;
		new.logical_computer_id := case when v_authority.sponsor_binding_id = new.sponsor_binding_id
			then v_authority.logical_computer_id end;
		-- The woken agent's own thread for the payer: it may answer there (reply optional).
		new.session_id := public.qorpera_folder_wake_public_session(new.profile_id, new.environment_id, new.staff_agent_id,
			new.requested_by_user_id);
		v_actor := v_p31_mark.actor_staff_agent_id;
	elsif new.wake_kind = 'agent' then
		select * into strict v_run from public.qorpera_execution_runs where id = new.parent_run_id$new$);

-- The wake's authority: its marker always; before its run, also its task, agent and payer.
select pg_temp.p31_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$declare v_ancestry jsonb; v_standing_version bigint := public.qorpera_wake_standing_sponsor_version(p_wake);$old$,
	$new$declare v_ancestry jsonb; v_standing_version bigint := public.qorpera_wake_standing_sponsor_version(p_wake);
	v_p31_mark public.qorpera_folder_human_task_wakes%rowtype;$new$);
select pg_temp.p31_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$		if not exists (select 1 from public.qorpera_execution_runs where id = p_wake.parent_run_id and profile_id = p_wake.profile_id
			and environment_id = p_wake.environment_id) then return false; end if;$old$,
	$new$		-- 20260930065000 (P31): a human task's wake has no parent; its chain is the changing agent's (or none) and itself.
		if p_wake.source_kind = 'human-task' then
			v_p31_mark := public.qorpera_folder_human_task_wake_marker(p_wake);
			if p_wake.parent_run_id is not null or v_p31_mark.id is null
				or (p_wake.run_id is null and not public.qorpera_folder_human_task_wake_fits(p_wake, v_p31_mark)) then
				return false; end if;
			v_ancestry := public.qorpera_wake_ancestry(null, v_p31_mark.actor_staff_agent_id, p_wake.staff_agent_id, p_wake.id);
			return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
				and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids), false);
		end if;
		if not exists (select 1 from public.qorpera_execution_runs where id = p_wake.parent_run_id and profile_id = p_wake.profile_id
			and environment_id = p_wake.environment_id) then return false; end if;$new$);

-- The wake policy: an agent source whose run may answer in its thread.
select pg_temp.p31_replace('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$			or (v_wake.source_kind = 'event' and v_wake.file_event_id is not null)
			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file','event'))
				or (v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation','worker-dispatch','worker-completion','machine-event')))))$old$,
	$new$			or (v_wake.source_kind = 'event' and v_wake.file_event_id is not null)
			-- 20260930065000 (P31): a human task's wake has its marker and no parent.
			or (v_wake.source_kind = 'human-task' and (v_wake.parent_run_id is not null
				or (public.qorpera_folder_human_task_wake_marker(v_wake)).id is null))
			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file','event'))
				or (v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation','worker-dispatch','worker-completion','machine-event',
					'human-task')))))$new$);
select pg_temp.p31_replace('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$	if v_wake.source_kind = 'coworker' and v_wake.session_id is not null then v_reporting := 'pair'; end if;$old$,
	$new$	if v_wake.source_kind = 'coworker' and v_wake.session_id is not null then v_reporting := 'pair'; end if;
	-- 20260930065000 (P31): a human task's wake may answer in the agent's own thread.
	if v_wake.source_kind = 'human-task' and v_wake.session_id is not null then v_reporting := 'continuation'; end if;$new$);

-- The wake as its run reads it: the member whose change it is, and the task as the run may read it.
select pg_temp.p31_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$		from public.qorpera_folder_commits c where c.id = v_wake.source_id;
	end if;$old$,
	$new$		from public.qorpera_folder_commits c where c.id = v_wake.source_id;
	elsif v_wake.source_kind = 'human-task' then
		-- 20260930065000 (P31): the member or agent whose change woke the run (none for an overdue task).
		select m.actor_staff_agent_id, m.actor_user_id into v_sender, v_actor_user
		from public.qorpera_folder_human_task_wakes m
		where m.environment_id = v_wake.environment_id and m.occurrence_key = v_wake.occurrence_key;
	end if;$new$);
select pg_temp.p31_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$			then public.qorpera_folder_file_wake_changes(v_wake, v_tool -> 'resolved') else v_wake.payload end)$old$,
	$new$			then public.qorpera_folder_file_wake_changes(v_wake, v_tool -> 'resolved')
			when v_wake.source_kind = 'human-task' then public.qorpera_folder_human_task_wake_payload(v_wake, v_tool -> 'resolved')
			else v_wake.payload end)$new$);
