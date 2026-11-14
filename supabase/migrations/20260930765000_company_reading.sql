-- 20260930765000: the company's reading of itself (Jonas, 14 November 2026: "I think the company's stage is more fluent
-- than a set value, but I also do think there needs to be some form of awareness about the state/stage of the company.
-- It should feel like the company is conscious almost.").
--
-- Companies stop hiring after the first team and feel flat: the code has no notion of where a company stands. Now each
-- company keeps one short reading of itself next to the vision, which every agent gets at every run (the runtime's
-- step), and the platform gives the Co-Founder plain facts to write it from.
--
-- 1. A structured kind, 'reading', at QorperaOS/vision/reading.md (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
--    §2): the shared parser reads it (packages/cloud-client/src/company-state-files.ts) and the database checks the
--    parse's shape again, as for every other kind. No index table, no lock target and no review rule: the file is
--    stored with its checked parse, and saving it is plain, the company's own bookkeeping. It is not seeded (the
--    Co-Founder writes the first one) and anyone who may write vision/ may delete it.
-- 2. qorpera_describe_company_senses(binding): what the Co-Founder's company run reads to write the reading: per agent
--    its open, blocked and lately done todos, its runs, its routines and its wakes that wait; who was hired and whose
--    role ended since the reading was saved; the question cards nobody has answered yet; each member's login; and when
--    the reading was saved. A host call of the Co-Founder's company run only, at most 8,192 bytes: past that it leaves
--    out the newest of the oldest cards, then the ended and the hired, then agents from the end, never the Co-Founder's.
-- 3. qorpera_read_company_standing(company): a member's read of whether the company can run. A company whose routines
--    stand still cannot write its own reading, so the platform says it: since when, and whose login holds it. Stopped
--    means the routines stand still: a routine wake has waited more than 30 minutes and no routine wake was given a run
--    in the last 30 minutes. A member's own turn, a room delivery or a worker's run does not count: at Brooks routine
--    wakes waited from 9 November while members' turns ran on 10, 11 and 14 November (the lead, 14 November 2026).
--
-- Every patched or new body carries the marker 20260930765000.

set local lock_timeout = '3s';

create function pg_temp.reading765_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930765000' in v_definition) > 0 then
		raise exception '20260930765000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930765000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The kind ------------------------------------------------------------------------------------------------------------

-- The newest whole definition (20260930534000), with the reading's line after the vision's.
create or replace function public.qorpera_structured_path_kind(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930534000: every structured file is under qorperaos/; below it the kinds are as before.
	select case
		when r.k is null then null
		when r.k = 'vision/vision.md' then 'vision'
		-- 20260930765000: the company's reading of itself.
		when r.k = 'vision/reading.md' then 'reading'
		when r.k = 'agents/sections.md' then 'sections'
		-- 20260930060000 (E1): a hook's and a mailbox's files, before the vault's.
		when r.k ~ '^connections/hook-[^/]*\.md$' then 'hook'
		when r.k ~ '^connections/mailbox-[^/]*\.md$' then 'mailbox'
		when r.k ~ '^connections/[^/]*\.md$' then 'connection'
		-- 20260930230000 (E8a): the company's network rules.
		when r.k = 'rules/network.toml' then 'network-rules'
		when r.k ~ '^rules/[^/]*\.md$' then 'rule'
		-- 20260929999000 (H1): a human task and a contact.
		when r.k ~ '^human-tasks/[^/]*\.md$' then 'human-task'
		when r.k ~ '^contacts/[^/]*\.md$' then 'contact'
		-- 20260930016000 (P16): interfaces and tables.
		when r.k = 'interfaces/order.md' then 'interface-order'
		when r.k ~ '^interfaces/[^/]+/interface\.toml$' then 'interface'
		when r.k ~ '^tables/[^/]+/table\.toml$' then 'table'
		when r.k ~ '^tables/[^/]+/rows\.csv$' then 'table-rows'
		when r.k ~ '^agents/groups/[^/]+/group\.md$' then 'group'
		-- 20260930111000 (M1a): a group chat's summary tree.
		when r.k ~ '^agents/groups/[^/]+/memory/tree\.toml$' then 'memory-tree'
		when r.k ~ '^agents/groups/[^/]+/memory/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
		-- 20260930231000 (W1b): a group chat's run logs.
		when r.k ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/run\.toml$'
			then 'memory-run'
		when r.k ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log/[0-9]{8}\.jsonl$'
			then 'memory-steps'
		when r.k ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$'
			then 'memory-run-block'
		when r.k ~ '^agents/(groups|sections\.md)(/|$)' then null
		when r.k ~ '^agents/[^/]+/agent\.md$' then 'agent'
		-- 20260930111000 (M1a): an agent's thread's summary tree.
		when r.k ~ '^agents/[^/]+/memory/thread/tree\.toml$' then 'memory-tree'
		when r.k ~ '^agents/[^/]+/memory/thread/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
		-- 20260930231000 (W1b): an agent's thread's run logs.
		when r.k ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/run\.toml$'
			then 'memory-run'
		when r.k ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log/[0-9]{8}\.jsonl$'
			then 'memory-steps'
		when r.k ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$'
			then 'memory-run-block'
		when r.k ~ '^agents/[^/]+/routines/[^/]*\.md$' then 'routine'
		when r.k ~ '^agents/[^/]+/todos/[^/]*\.md$' then 'todo'
		when r.k ~ '^agents/[^/]+/todos/[^/]+/[^/]+/brief\.md$' then 'worker-brief'
		when r.k ~ '^agents/[^/]+/todos/[^/]+/[^/]+/results\.md$' then 'worker-results'
	end
	from (select public.qorpera_os_relative(p_key) as k) r
$$;

-- The parse of a reading is checked by its shape, as the parser's own: the sentence and its line, attention naming one
-- of the things, three to seven things with their keys once each, at most six changes and five notes, each text one
-- line within its bytes, agents by their folder names and waits_for by member ids or the word founders alone.
select pg_temp.reading765_replace('public.qorpera_company_state_checked(jsonb,text,text,jsonb)'::regprocedure,
	$old$'network-rules' /* 20260930230000 (E8a) */) then$old$,
	$new$'network-rules' /* 20260930230000 (E8a) */, 'reading' /* 20260930765000 */) then$new$);

select pg_temp.reading765_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$old$,
	$new$-- 20260930765000: the company's reading of itself.
	if p_kind = 'reading' then
		if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_parse) k) is distinct from
			array['attention','changes','kind','line','notes','sentence','things'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'sentence', 1, 200, true) then
			v_bad := array_append(v_bad, 'sentence'); end if;
		if jsonb_typeof(p_parse -> 'line') is distinct from 'null'
			and not public.qorpera_company_state_one_line(p_parse -> 'line', 1, 200, true) then
			v_bad := array_append(v_bad, 'line'); end if;
		if jsonb_typeof(p_parse -> 'things') is distinct from 'array' or jsonb_array_length(p_parse -> 'things') not between 3 and 7
			or exists (select 1 from jsonb_array_elements(p_parse -> 'things') t
				where jsonb_typeof(t) <> 'object'
					or (select array_agg(k order by k collate "C") from jsonb_object_keys(t) k) is distinct from
						array['agents','full','key','name','shape','state','waitsFor']
					or jsonb_typeof(t -> 'key') <> 'string' or (t ->> 'key') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
					or octet_length(t ->> 'key') > 32
					or not public.qorpera_company_state_one_line(t -> 'name', 1, 40, true)
					or coalesce(t ->> 'shape', '') not in ('board','box','screen','phone','gear','code','person','people','heart',
						'pin','globe','chart','coin','bank','drop','megaphone','cart','handshake','truck','factory','scale',
						'document','chat','wrench','blob')
					or jsonb_typeof(t -> 'full') <> 'number' or (t ->> 'full') !~ '^(0|[1-9][0-9]?|100)$'
					or not public.qorpera_company_state_one_line(t -> 'state', 1, 40, true)
					or jsonb_typeof(t -> 'agents') <> 'array' or jsonb_array_length(t -> 'agents') > 8
					or exists (select 1 from jsonb_array_elements(t -> 'agents') a
						where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
							or char_length(a #>> '{}') > 64)
					or (select count(distinct a) from jsonb_array_elements(t -> 'agents') a) <> jsonb_array_length(t -> 'agents')
					or jsonb_typeof(t -> 'waitsFor') <> 'array' or jsonb_array_length(t -> 'waitsFor') > 4
					or exists (select 1 from jsonb_array_elements(t -> 'waitsFor') w
						where jsonb_typeof(w) <> 'string' or ((w #>> '{}') !~ c_uuid and (w #>> '{}') <> 'founders'))
					or (select count(distinct w) from jsonb_array_elements(t -> 'waitsFor') w) <> jsonb_array_length(t -> 'waitsFor')
					or ((t -> 'waitsFor') @> '["founders"]' and jsonb_array_length(t -> 'waitsFor') > 1))
			or (select count(distinct t ->> 'key') from jsonb_array_elements(p_parse -> 'things') t)
				<> jsonb_array_length(p_parse -> 'things') then
			v_bad := array_append(v_bad, 'things');
		elsif jsonb_typeof(p_parse -> 'attention') is distinct from 'string'
			or not exists (select 1 from jsonb_array_elements(p_parse -> 'things') t where t ->> 'key' = p_parse ->> 'attention') then
			v_bad := array_append(v_bad, 'attention');
		end if;
		if jsonb_typeof(p_parse -> 'changes') is distinct from 'array' or jsonb_array_length(p_parse -> 'changes') > 6
			or exists (select 1 from jsonb_array_elements(p_parse -> 'changes') c
				where jsonb_typeof(c) <> 'object'
					or (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['agent','line','what']
					or jsonb_typeof(c -> 'agent') <> 'string' or (c ->> 'agent') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
					or char_length(c ->> 'agent') > 64
					or coalesce(c ->> 'what', '') not in ('joined','ended','changed')
					or not public.qorpera_company_state_one_line(c -> 'line', 1, 120, true)) then
			v_bad := array_append(v_bad, 'changes'); end if;
		if jsonb_typeof(p_parse -> 'notes') is distinct from 'array' or jsonb_array_length(p_parse -> 'notes') > 5
			or exists (select 1 from jsonb_array_elements(p_parse -> 'notes') n
				where not public.qorpera_company_state_one_line(n, 1, 160, true)) then
			v_bad := array_append(v_bad, 'notes'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$new$);

-- 2. The Co-Founder's senses -------------------------------------------------------------------------------------------

-- Plain facts for the Co-Founder's company run, next to its open work (qorpera_describe_agent_open_work): the run check
-- of that read, and the Co-Founder check of qorpera_cofounder_crew. Lists are capped and say so, and the answer is at
-- most 8,192 bytes: while it would pass that, it leaves out the last of questions.oldest, then of team.ended, then of
-- team.hired (each setting its truncated flag), and only then agents from the end (agentsTruncated), never the
-- Co-Founder's row, which comes first. What no cut reaches stays well inside the bound: the Co-Founder's row (a name of
-- at most 160 characters), at most 20 members (an id, a role and a login state) and the fixed keys, about 5 KiB at most.
-- * agents: the active agents, the Co-Founder first, then by hire: todos open and blocked, and done in the last 7 days;
--   runs in the last 7 days and the last one; routines active, paused (and the distinct reasons), concluded, and the
--   next run of an active one; the wakes queued for it that are due, and the oldest one's time.
-- * team: who was hired and whose role ended since the reading was saved, or in the last 14 days without one.
-- * questions: the question cards nobody has answered, by qorpera_list_member_open_questions' rule for any member, and
--   the oldest ten.
-- * members: each member's login state (qorpera_works_for_login_state).
-- * reading: when the reading was saved and the thing it attends to, or null.
create function public.qorpera_describe_company_senses(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb;
	v_saved_at timestamptz; v_attention text; v_since timestamptz; v_now timestamptz := statement_timestamp();
	v_active integer; v_answer jsonb;
begin
	-- 20260930765000
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_run_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if v_run.staff_agent_id is null or v_run.audience_kind is distinct from 'company'
		or (public.qorpera_run_worker(v_run.id)).id is not null
		or not exists (select 1 from public.qorpera_company_cofounders as cofounder
			where cofounder.profile_id = v_run.profile_id and cofounder.staff_agent_id = v_run.staff_agent_id) then
		raise exception 'Only the Co-Founder''s company run reads the company''s senses' using errcode = '42501'; end if;
	-- The reading as the folder holds it now.
	select version.created_at, version.structured -> 'parse' ->> 'attention' into v_saved_at, v_attention
	from public.qorpera_folder_entries as entry
	join public.qorpera_folder_path_versions as version on version.version = entry.version
	where entry.environment_id = v_run.environment_id and entry.kind = 'file'
		and entry.key_sha256 = extensions.digest('qorperaos/vision/reading.md', 'sha256');
	v_since := coalesce(v_saved_at, v_now - interval '14 days');
	select count(*) into v_active from public.qorpera_profile_staff as staff
	where staff.profile_id = v_run.profile_id and staff.employment_status = 'active' and staff.deleted_at is null
		and staff.folder_retired_at is null;
	with staff as (
		select staff.staff_agent_id, staff.display_name, staff.created_at, staff.folder_path,
			exists (select 1 from public.qorpera_company_cofounders as cofounder
				where cofounder.profile_id = v_run.profile_id and cofounder.staff_agent_id = staff.staff_agent_id) as cofounder
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_run.profile_id and staff.employment_status = 'active' and staff.deleted_at is null
			and staff.folder_retired_at is null
		order by cofounder desc, staff.created_at, staff.staff_agent_id
		limit 50
	),
	runs as (
		select run.staff_agent_id, count(*) filter (where run.created_at > v_now - interval '7 days') as recent,
			max(run.created_at) as last_at
		from public.qorpera_execution_runs as run
		where run.profile_id = v_run.profile_id and run.staff_agent_id in (select staff.staff_agent_id from staff)
		group by run.staff_agent_id
	),
	waiting as (
		select coalesce(wake.staff_agent_id, version.staff_agent_id) as staff_agent_id, count(*) as waiting,
			min(greatest(wake.created_at, wake.not_before)) as oldest
		from public.qorpera_wake_occurrences as wake
		left join public.qorpera_cloud_routine_versions as version
			on version.routine_id = wake.routine_id and version.version = wake.routine_version
		where wake.profile_id = v_run.profile_id and wake.status = 'queued' and wake.not_before <= v_now
		group by 1
	)
	select jsonb_build_object('schema', 'qorpera.company-senses/v1', 'runId', v_run.id, 'at', v_now,
		'agents', coalesce((select jsonb_agg(jsonb_build_object(
				'id', staff.staff_agent_id,
				'handle', split_part(staff.folder_path, '/', 3),
				'name', staff.display_name,
				'cofounder', staff.cofounder,
				'hiredAt', staff.created_at,
				'todos', (select jsonb_build_object(
						'open', count(*) filter (where todo.state = 'open'),
						'blocked', count(*) filter (where todo.state = 'blocked'),
						'doneLast7d', count(*) filter (where todo.state = 'done'))
					from public.qorpera_runtime_agent_todos as todo
					where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
						and todo.staff_agent_id = staff.staff_agent_id
						and (todo.state in ('open','blocked') or (todo.state = 'done' and todo.updated_at > v_now - interval '7 days'))),
				'runsLast7d', coalesce(runs.recent, 0),
				'lastRunAt', runs.last_at,
				'routines', (select jsonb_build_object(
						'active', count(*) filter (where routine.status = 'active'),
						'paused', count(*) filter (where routine.status = 'paused'),
						'pausedWhy', coalesce(jsonb_agg(distinct routine.pause_reason)
							filter (where routine.status = 'paused' and routine.pause_reason is not null), '[]'::jsonb),
						'concluded', count(*) filter (where routine.status = 'concluded'),
						'nextAt', min((public.qorpera_agent_routine_view(routine) ->> 'nextRunAt')::timestamptz)
							filter (where routine.status = 'active'))
					from public.qorpera_cloud_routines as routine
					where routine.profile_id = v_run.profile_id and routine.environment_id = v_run.environment_id
						and routine.owner_staff_agent_id = staff.staff_agent_id
						and routine.folder_path is not null and routine.folder_retired_at is null),
				'waitingWakes', coalesce(waiting.waiting, 0),
				'oldestWaitingWakeAt', waiting.oldest)
			order by staff.cofounder desc, staff.created_at, staff.staff_agent_id)
			from staff
			left join runs on runs.staff_agent_id = staff.staff_agent_id
			left join waiting on waiting.staff_agent_id = staff.staff_agent_id), '[]'::jsonb),
		'agentsTruncated', v_active > 50,
		'team', (select jsonb_build_object('since', v_since,
				'hired', coalesce((select jsonb_agg(jsonb_build_object('name', left(hired.display_name, 60),
						'handle', split_part(hired.folder_path, '/', 3), 'at', hired.created_at) order by hired.created_at, hired.staff_agent_id)
					from (select * from public.qorpera_profile_staff as staff
						where staff.profile_id = v_run.profile_id and staff.created_at > v_since
						order by staff.created_at, staff.staff_agent_id limit 10) as hired), '[]'::jsonb),
				'ended', coalesce((select jsonb_agg(jsonb_build_object('name', left(ended.display_name, 60),
						'handle', split_part(ended.folder_path, '/', 3), 'at', ended.ended_at) order by ended.ended_at, ended.staff_agent_id)
					from (select staff.*, coalesce(staff.folder_retired_at, staff.deleted_at, staff.updated_at) as ended_at
						from public.qorpera_profile_staff as staff
						where staff.profile_id = v_run.profile_id
							and (staff.employment_status <> 'active' or staff.folder_retired_at is not null or staff.deleted_at is not null)
							and coalesce(staff.folder_retired_at, staff.deleted_at, staff.updated_at) > v_since
						order by ended_at, staff.staff_agent_id limit 10) as ended), '[]'::jsonb),
				'truncated', (select count(*) > 10 from public.qorpera_profile_staff as staff
						where staff.profile_id = v_run.profile_id and staff.created_at > v_since)
					or (select count(*) > 10 from public.qorpera_profile_staff as staff
						where staff.profile_id = v_run.profile_id
							and (staff.employment_status <> 'active' or staff.folder_retired_at is not null or staff.deleted_at is not null)
							and coalesce(staff.folder_retired_at, staff.deleted_at, staff.updated_at) > v_since))),
		'questions', (with cards as (
				select card.created_at, card.event_id, card.actor_user_id, room.bound_staff_agent_id
				from public.qorpera_company_rooms as room
				join public.qorpera_shared_sessions as session
					on session.id = room.session_id and session.profile_id = v_run.profile_id and session.status = 'open'
						and session.audience_kind = 'company'
				cross join lateral (
					-- qorpera_list_member_open_questions' rule (20260930706000), for any member.
					select request.*
					from public.qorpera_session_events as request
					where request.session_id = room.session_id
						and request.event_type = 'interaction_request'
						and request.body #>> '{entry,data,schema}' = 'qorpera.interaction/v1'
						and request.body #>> '{entry,data,surface}' = 'question'
						and case
							when not (request.body #> '{entry,data}' ? 'expiresAt') then true
							when pg_input_is_valid(request.body #>> '{entry,data,expiresAt}', 'timestamptz')
								then (request.body #>> '{entry,data,expiresAt}')::timestamptz > v_now
							else false
						end
						and not exists (
							select 1 from public.qorpera_session_events as answer
							where answer.session_id = request.session_id
								and answer.event_type in ('interaction_answer', 'authorization_decision')
								and answer.body #>> '{entry,data,interactionId}' = request.event_id::text)
						and not exists (
							select 1 from public.qorpera_session_inputs as input
							where input.session_id = request.session_id and input.kind = 'user_message'
								and input.body ->> 'schema' = 'qorpera.interaction-answer/v1'
								and input.body ->> 'interactionId' = request.event_id::text
								and input.failed_at is null)
				) as card
				where room.profile_id = v_run.profile_id and room.bound_staff_agent_id is not null and room.status = 'active')
			select jsonb_build_object('count', (select count(*) from cards), 'truncated', (select count(*) > 10 from cards),
				'oldest', coalesce((select jsonb_agg(jsonb_build_object('agent', split_part(staff.folder_path, '/', 3),
						'member', oldest.actor_user_id, 'askedAt', oldest.created_at) order by oldest.created_at, oldest.event_id)
					from (select * from cards order by cards.created_at, cards.event_id limit 10) as oldest
					left join public.qorpera_profile_staff as staff
						on staff.profile_id = v_run.profile_id and staff.staff_agent_id = oldest.bound_staff_agent_id), '[]'::jsonb))),
		'members', coalesce((select jsonb_agg(jsonb_build_object('userId', member.user_id, 'role', member.role,
				'login', public.qorpera_works_for_login_state(v_run.profile_id, member.user_id) - 'user_id')
				order by member.joined_at, member.user_id)
			from (select * from public.qorpera_profile_members as member where member.profile_id = v_run.profile_id
				order by member.joined_at, member.user_id limit 20) as member), '[]'::jsonb),
		'membersTruncated', (select count(*) > 20 from public.qorpera_profile_members as member
			where member.profile_id = v_run.profile_id),
		'reading', case when v_saved_at is null then null
			else jsonb_build_object('savedAt', v_saved_at, 'attention', v_attention) end)
	into v_answer;
	-- At most 8,192 bytes: the cards, then the ended and the hired, then the agents from the end; never the Co-Founder's
	-- row, first in the order.
	while octet_length(v_answer::text) > 8192 loop
		if jsonb_array_length(v_answer #> '{questions,oldest}') > 0 then
			v_answer := jsonb_set(jsonb_set(v_answer, '{questions,oldest}', (v_answer #> '{questions,oldest}') - -1),
				'{questions,truncated}', 'true');
		elsif jsonb_array_length(v_answer #> '{team,ended}') > 0 then
			v_answer := jsonb_set(jsonb_set(v_answer, '{team,ended}', (v_answer #> '{team,ended}') - -1), '{team,truncated}', 'true');
		elsif jsonb_array_length(v_answer #> '{team,hired}') > 0 then
			v_answer := jsonb_set(jsonb_set(v_answer, '{team,hired}', (v_answer #> '{team,hired}') - -1), '{team,truncated}', 'true');
		elsif jsonb_array_length(v_answer -> 'agents') > 1 then
			v_answer := jsonb_set(v_answer, '{agents}', (v_answer -> 'agents') - -1) || jsonb_build_object('agentsTruncated', true);
		else
			exit;
		end if;
	end loop;
	return v_answer;
end $$;
revoke all on function public.qorpera_describe_company_senses(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_describe_company_senses(jsonb) to service_role;
comment on function public.qorpera_describe_company_senses(jsonb) is
	'The plain facts the Co-Founder''s company run writes the company''s reading from (QorperaOS/vision/reading.md): '
	'agents with their work, routines and waiting wakes, the team''s changes, unanswered cards, members'' logins '
	'(20260930765000). The Co-Founder''s run only; at most 8,192 bytes, the agents cut last.';

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_describe_company_senses', 'binding');

-- 3. The company's standing ------------------------------------------------------------------------------------------

-- Whether the company can run, for its members: the routine wakes that are due and still queued; stopped when the
-- oldest has waited more than 30 minutes and no routine wake of the company was given a run in the last 30 minutes (a
-- wake with wake_kind routine whose run_id is a run created since; a member's turn, a room delivery or a worker's run
-- is not the routines running); why, from the login of the member
-- each waiting wake would be paid by (its routine's payer, else the member its agent works for), the first that is not
-- ready in the order the wakes wait: login_full (with resetsAt), sign_in, no_login. Null when every one is ready.
create function public.qorpera_read_company_standing(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_role public.qorpera_profile_role; v_now timestamptz := statement_timestamp();
	v_waiting bigint; v_oldest timestamptz; v_stopped boolean; v_member uuid; v_login jsonb;
begin
	-- 20260930765000
	v_role := public.qorpera_member_role(p_profile_id);
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null then
		raise exception 'Standing unavailable' using errcode = '42501';
	end if;
	select count(*), min(greatest(wake.created_at, wake.not_before)) into v_waiting, v_oldest
	from public.qorpera_wake_occurrences as wake
	where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.wake_kind = 'routine' and wake.not_before <= v_now;
	v_stopped := v_oldest is not null and v_oldest < v_now - interval '30 minutes'
		and not exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_wake_occurrences as ran on ran.run_id = run.id
			where run.profile_id = p_profile_id and run.created_at > v_now - interval '30 minutes'
				and ran.profile_id = p_profile_id and ran.wake_kind = 'routine');
	select payer.user_id, payer.login into v_member, v_login
	from (
		select earliest.user_id, earliest.waits_from, public.qorpera_works_for_login_state(p_profile_id, earliest.user_id) as login
		from (
			select distinct on (paid.user_id) paid.user_id, paid.waits_from
			from (
				select coalesce(connection.owner_user_id,
						public.qorpera_agent_works_for_user(p_profile_id, version.staff_agent_id)) as user_id,
					greatest(wake.created_at, wake.not_before) as waits_from
				from public.qorpera_wake_occurrences as wake
				join public.qorpera_cloud_routine_versions as version
					on version.routine_id = wake.routine_id and version.version = wake.routine_version
				left join public.qorpera_provider_connections as connection
					on connection.id = public.qorpera_sponsor_binding_connection(version.sponsor_binding_id)
				where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.wake_kind = 'routine'
					and wake.not_before <= v_now
			) as paid
			where paid.user_id is not null
			order by paid.user_id, paid.waits_from
		) as earliest
	) as payer
	where payer.login ->> 'state' is distinct from 'ready'
	order by payer.waits_from, payer.user_id
	limit 1;
	return jsonb_build_object('schema', 'qorpera.company-standing/v1',
		'stopped', v_stopped,
		'since', v_oldest,
		'why', case v_login ->> 'state' when 'full' then 'login_full' when 'sign_in' then 'sign_in'
			when 'none' then 'no_login' end,
		'member', v_member,
		'resetsAt', case when v_login ->> 'state' = 'full' then v_login -> 'resets_at' end,
		'waiting', v_waiting);
end $$;
revoke all on function public.qorpera_read_company_standing(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_read_company_standing(uuid) to authenticated;
comment on function public.qorpera_read_company_standing(uuid) is
	'Whether the company''s routines stand still, since when and whose login holds them, for its members '
	'(20260930765000). A company that stands still cannot write its own reading.';

-- 4. The deploy guard: every patched and new body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_structured_path_kind(text)', 'public.qorpera_company_state_checked(jsonb,text,text,jsonb)',
		'public.qorpera_company_state_parse_problems(text,jsonb)', 'public.qorpera_describe_company_senses(jsonb)',
		'public.qorpera_read_company_standing(uuid)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930765000') = 0 then
			raise exception '20260930765000 is missing from %', v_function; end if;
	end loop;
end $guard$;

drop function pg_temp.reading765_replace(regprocedure, text, text);
