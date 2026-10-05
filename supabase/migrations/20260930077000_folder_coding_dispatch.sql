-- C3a: coding workers on folder-v2 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (C3)"). A coding session is
-- a worker like an in-house one: `manage_worker` dispatches it by writing its `brief.md` through
-- qorpera_folder_worker_commit, and the worker row is the brief's index. Every patched body carries the marker
-- 20260930077000.
--
-- 1. A coding brief names its harness and repository (`harness`, `repository` with `base_branch`); an in-house brief
--    names neither. The parse gives `harness` and `repository` ({host, owner, name, baseBranch}) for coding only.
-- 2. A dispatch's request may carry `species`, `harness`, `repository` and `owner`. The worker rules check a coding
--    dispatch as qorpera_manage_agent_worker did, in its order and with its words, as rule refusals: the species, then
--    the harness, repository and read access, then the owner (the member who asked), then an enabled executor for the
--    harness, then the agent's grant for the repository, then the owner's own login for the harness (allowed to work
--    while they are away, and a ChatGPT plan only for work started on it). A coding session is paid by that login,
--    never by the starter's sponsor; the index takes it again and holds it to the plan rule (qorpera_coding_owner_payer).
-- 3. The index writes, for an accepted coding dispatch: the worker row (`coding`, active, no wake, the owner and the
--    owner's sponsor), its session (`queued`, the harness and repository, branch `qorpera/coding/<worker id>`, no
--    lease) and its first turn and event (qorpera_coding_session_queue). No wake: the executor's claim starts the
--    session and its turn's begin admits the worker's wake (C1c-3i). A coding follow-up queues the session's next turn
--    the same way; a coding session keeps its branch through a cancel, so a cancelled one may be followed up, and only
--    by the member it runs for. Its brief counts the agent's follow-ups alone (a member's answer turns it too). A
--    worker whose folder was deleted continues only after a restore: the member's answer, the claim and the begin
--    refuse it (a todo's file goes only after its workers' folders). (A coding session's turn ends through coding_finish: its run never writes agents/**, so the folder
--    core denies it report_work before any worker rule.)
-- 4. A coding turn's wake carries the folder-v2 dispatch payload (the worker's folder and the todo's file), not the
--    snapshot-v1 one.
-- 5. F2's worker drain stops an active coding worker whose parent was stopped or whose todo was cancelled, as it stops
--    an in-house one; it never starts one (its turns do), and it revives the parent as before (a batch waits for an
--    active coding sibling as for any, as the legacy drain did: a coding worker is active only while a turn of it is
--    queued or running). It takes the coding sessions it may stop FOR UPDATE after the parents' conversations and
--    before admission (core §3), and a stop that fails is skipped, not a failed start.
--
-- Locks: the session row a dispatch inserts is new; its insert key-shares its worker (this commit's own new row), the
-- company and the run's conversation. A follow-up's session update comes after the worker's rank-5 lock, as every
-- coding-session writer takes it (3i-a's claim, begin and complete, the cancel, the drain). The owner's sponsor is
-- read in the index step; when the owner's login has no sponsor version yet, qorpera_coding_owner_sponsor makes one
-- after the rank-5 rows, as the legacy dispatch did after its todo and worker.

set local lock_timeout = '3s';

create function pg_temp.c3a_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C3a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The brief ---------------------------------------------------------------------------------------------------------

select pg_temp.c3a_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$		if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_parse) k) is distinct from
			array['access','authority','cancellation','completion','context','dispatchedAt','doneWhen','followUp','followUps',
				'followedUpAt','goal','id','kind','output','revival','sources','species','title'] then
			v_bad := array_append(v_bad, 'keys'); end if;$old$,
	$new$		-- 20260930077000 (C3a): a coding brief also names its harness and repository, an in-house one neither.
		if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_parse) k) is distinct from
			(case when p_parse ->> 'species' = 'coding' then
				array['access','authority','cancellation','completion','context','dispatchedAt','doneWhen','followUp','followUps',
					'followedUpAt','goal','harness','id','kind','output','repository','revival','sources','species','title']
			else array['access','authority','cancellation','completion','context','dispatchedAt','doneWhen','followUp','followUps',
				'followedUpAt','goal','id','kind','output','revival','sources','species','title'] end) then
			v_bad := array_append(v_bad, 'keys'); end if;
		if p_parse ->> 'species' = 'coding' and (coalesce(p_parse ->> 'harness', '') not in ('codex','claude-code')
			or not public.qorpera_coding_repository_valid(p_parse -> 'repository')) then
			v_bad := array_append(v_bad, 'coding'); end if;$new$);

-- 2. The owner's login, read only --------------------------------------------------------------------------------------

-- The login qorpera_coding_owner_sponsor pays a coding session with: the owner's active connection for the harness with
-- an active version of its native harness; one allowed to work while its member is away first, then one that is not a
-- ChatGPT plan, then the newest. With its newest active version.
create function public.qorpera_coding_owner_login(p_profile_id uuid, p_owner_user_id uuid, p_harness text)
returns table(connection_id uuid, connection_version bigint, allow_autonomous boolean)
language sql stable security definer set search_path = '' as $$
	-- 20260930077000 (C3a).
	select connection.id, version.version, version.allow_autonomous
	from public.qorpera_provider_connections connection
	cross join lateral (select v.version, v.allow_autonomous from public.qorpera_provider_connection_versions v
		where v.connection_id = connection.id and v.authorization_state = 'active'
			and v.native_harness = case p_harness when 'codex' then 'codex-cli' when 'claude-code' then 'claude-code' end
		order by v.version desc limit 1) version
	where connection.profile_id = p_profile_id and connection.owner_user_id = p_owner_user_id
		and connection.provider = case p_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end
		and connection.status = 'active'
	order by not coalesce(version.allow_autonomous, false), public.qorpera_connection_is_chatgpt_plan(connection.id),
		connection.created_at desc
	limit 1
$$;
revoke all on function public.qorpera_coding_owner_login(uuid, uuid, text) from public, anon, authenticated, service_role;

-- Why the owner's login cannot pay for a coding session of a run paid by p_run_binding_id, in
-- qorpera_coding_owner_sponsor's words and the legacy dispatch's plan rule; null when it can.
create function public.qorpera_coding_owner_problem(p_profile_id uuid, p_owner_user_id uuid, p_harness text,
	p_run_binding_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_provider text := case p_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end;
	v_connection uuid; v_allowed boolean;
begin
	-- 20260930077000 (C3a).
	if not exists (select 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = p_owner_user_id) then
		return 'The session owner is not a member of this company'; end if;
	select login.connection_id, login.allow_autonomous into v_connection, v_allowed
	from public.qorpera_coding_owner_login(p_profile_id, p_owner_user_id, p_harness) login;
	if v_connection is null then
		return format('The session owner has no active %s account connected for %s', v_provider, p_harness); end if;
	if not v_allowed then
		return format('The session owner has not allowed background work on their %s account', v_provider); end if;
	-- A member's ChatGPT plan pays for coding only when the asking run is paid by that plan (20260929950000).
	if public.qorpera_connection_is_chatgpt_plan(v_connection)
		and v_connection is distinct from public.qorpera_sponsor_binding_connection(p_run_binding_id) then
		return 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it'; end if;
	return null;
end $$;
revoke all on function public.qorpera_coding_owner_problem(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- The sponsor that pays a coding session of a run paid by p_run_binding_id: qorpera_coding_owner_sponsor's, held to the
-- plan rule itself. The index takes the payer here, after the rules read the owner's login: when that login changed in
-- between (its consent withdrawn, so another of the owner's logins comes first), the plan rule still holds for the one
-- that pays, or the commit fails whole.
create function public.qorpera_coding_owner_payer(p_profile_id uuid, p_owner_user_id uuid, p_harness text,
	p_run_binding_id uuid)
returns table(binding_id uuid, version bigint) language plpgsql security definer set search_path = '' as $$
declare v_connection uuid;
begin
	-- 20260930077000 (C3a).
	select sponsor.binding_id, sponsor.version, sponsor.connection_id into binding_id, version, v_connection
	from public.qorpera_coding_owner_sponsor(p_profile_id, p_owner_user_id, p_harness) sponsor;
	if public.qorpera_connection_is_chatgpt_plan(v_connection)
		and v_connection is distinct from public.qorpera_sponsor_binding_connection(p_run_binding_id) then
		raise exception 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it'
			using errcode = '55000'; end if;
	return next;
end $$;
revoke all on function public.qorpera_coding_owner_payer(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- The sponsor pays with exactly that login.
select pg_temp.c3a_replace('public.qorpera_coding_owner_sponsor(uuid,uuid,text)'::regprocedure,
	$old$	select connection.* into v_connection
	from public.qorpera_provider_connections connection
	where connection.profile_id = p_profile_id and connection.owner_user_id = p_owner_user_id
		and connection.provider = v_provider and connection.status = 'active'
		and exists (select 1 from public.qorpera_provider_connection_versions v where v.connection_id = connection.id
			and v.authorization_state = 'active' and v.native_harness = v_native)
	-- A login that may work while its member is away first (20260929992000): one that may not is refused below, even
	-- when another of the member's logins could pay. Then a login other than a ChatGPT plan (20260929950000): a
	-- plan pays for coding only of work started on it. Then the newest.
	order by not coalesce((select v.allow_autonomous from public.qorpera_provider_connection_versions v
			where v.connection_id = connection.id and v.authorization_state = 'active' and v.native_harness = v_native
			order by v.version desc limit 1), false),
		public.qorpera_connection_is_chatgpt_plan(connection.id), connection.created_at desc limit 1;$old$,
	$new$	-- A login that may work while its member is away first (20260929992000): one that may not is refused below, even
	-- when another of the member's logins could pay. Then a login other than a ChatGPT plan (20260929950000): a
	-- plan pays for coding only of work started on it. Then the newest. 20260930077000 (C3a): the selection is
	-- qorpera_coding_owner_login's, which the folder-v2 worker rules read too.
	select connection.* into v_connection from public.qorpera_provider_connections connection
	where connection.id = (select login.connection_id
		from public.qorpera_coding_owner_login(p_profile_id, p_owner_user_id, p_harness) login);$new$);

-- 3. The request -------------------------------------------------------------------------------------------------------

select pg_temp.c3a_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k)
			is distinct from (select array_agg(k order by k collate "C") from unnest(v_keys) k)$old$,
	$new$		-- 20260930077000 (C3a): a dispatch may also name a coding session's species, harness, repository and owner,
		-- which the worker rules check.
		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k
				where v_action <> 'dispatch' or k not in ('harness','owner','repository','species'))
			is distinct from (select array_agg(k order by k collate "C") from unnest(v_keys) k)
		or (v_action = 'dispatch' and (jsonb_typeof(coalesce(p_request -> 'species', '""')) <> 'string'
			or jsonb_typeof(coalesce(p_request -> 'harness', '""')) <> 'string'
			or jsonb_typeof(coalesce(p_request -> 'repository', '{}')) <> 'object'
			or jsonb_typeof(coalesce(p_request -> 'owner', '""')) <> 'string'))$new$);

-- 4. The rules ---------------------------------------------------------------------------------------------------------

select pg_temp.c3a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$	v_agent_folder text := array_to_string((string_to_array(v_folder, '/'))[1:2], '/'); v_file jsonb;$old$,
	$new$	v_agent_folder text := array_to_string((string_to_array(v_folder, '/'))[1:2], '/'); v_file jsonb;
	v_species text := coalesce(v_request ->> 'species', 'in-house'); -- 20260930077000 (C3a): a dispatch's$new$);

select pg_temp.c3a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$		elsif v_action in ('dispatch','followup') and not exists (select 1 from public.qorpera_starter_sponsor(p_profile_id,
				(p_actor ->> 'requesterUserId')::uuid, v_staff, v_run.sponsor_binding_id)) then$old$,
	$new$		-- 20260930077000 (C3a): a coding session is paid by its owner's own login, checked with its dispatch.
		elsif v_action in ('dispatch','followup')
			and (case when v_action = 'dispatch' then v_species else v_worker.species end) is distinct from 'coding'
			and not exists (select 1 from public.qorpera_starter_sponsor(p_profile_id,
				(p_actor ->> 'requesterUserId')::uuid, v_staff, v_run.sponsor_binding_id)) then$new$);

select pg_temp.c3a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$			elsif p_parse ->> 'species' is distinct from 'in-house' then
				v_problem := 'coding workers come to the company folder with coding machines';$old$,
	$new$			-- 20260930077000 (C3a): a coding session, checked as qorpera_manage_agent_worker checked it, in its order and
			-- with its words.
			elsif v_species not in ('in-house','coding')
				or (v_species = 'in-house' and v_request ?| array['harness','repository','owner']) then
				v_problem := 'Worker species is invalid';
			elsif v_species = 'coding' and (coalesce(v_request ->> 'harness', '') not in ('codex','claude-code')
				or not public.qorpera_coding_repository_valid(v_request -> 'repository')
				or v_request ->> 'access' is distinct from 'read'
				or (v_request ? 'owner' and coalesce(v_request ->> 'owner', '')
					!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) then
				v_problem := 'A coding session needs a harness, a repository and read access';
			-- The session runs for the member who asked, on their own account (20260928230000).
			elsif v_species = 'coding' and v_request ? 'owner'
				and (v_request ->> 'owner')::uuid is distinct from (p_actor ->> 'requesterUserId')::uuid then
				v_problem := 'A coding session runs for the member who asked for it';
			elsif v_species = 'coding' and not exists (select 1 from public.qorpera_coding_executors executor
				where executor.environment_id = p_environment_id and executor.enabled
					and (v_request ->> 'harness') = any(executor.harnesses)) then
				v_problem := 'No coding executor serves this company for ' || (v_request ->> 'harness');
			elsif v_species = 'coding' and not exists (select 1 from public.qorpera_coding_repository_grants grant_row
				where grant_row.environment_id = p_environment_id and grant_row.staff_agent_id = v_staff
					and grant_row.repository = v_request -> 'repository' and grant_row.enabled) then
				v_problem := 'This agent has no grant for that repository';
			elsif v_species = 'coding' and public.qorpera_coding_owner_problem(p_profile_id,
					(p_actor ->> 'requesterUserId')::uuid, v_request ->> 'harness', v_run.sponsor_binding_id) is not null then
				v_problem := public.qorpera_coding_owner_problem(p_profile_id, (p_actor ->> 'requesterUserId')::uuid,
					v_request ->> 'harness', v_run.sponsor_binding_id);$new$);

select pg_temp.c3a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$				or p_parse -> 'sources' is distinct from coalesce(v_request -> 'sources', '[]'::jsonb) then
				v_problem := 'the brief does not match the dispatch';$old$,
	$new$				or p_parse -> 'sources' is distinct from coalesce(v_request -> 'sources', '[]'::jsonb)
				-- 20260930077000 (C3a): the species, and a coding session's harness and repository.
				or p_parse ->> 'species' is distinct from v_species or p_parse -> 'harness' is distinct from v_request -> 'harness'
				or p_parse -> 'repository' is distinct from v_request -> 'repository' then
				v_problem := 'the brief does not match the dispatch';$new$);

select pg_temp.c3a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$				or (p_parse ->> 'followUps')::integer is distinct from v_worker.sequence$old$,
	$new$				-- 20260930077000 (C3a): a member's answer turns a coding session too (qorpera_answer_coding_session), so its
				-- brief counts the agent's follow-ups alone: one more than the brief it rewrites.
				or (p_parse ->> 'followUps')::integer is distinct from (case when v_worker.species = 'coding'
					then (v_base ->> 'followUps')::integer + 1 else v_worker.sequence end)$new$);

select pg_temp.c3a_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$			elsif v_worker.state = 'active' then
				v_problem := 'this worker is still working; wait for its report or cancel it';
			elsif v_worker.state = 'cancelled' then
				v_problem := 'this worker cannot continue; dispatch a new one';$old$,
	$new$			-- 20260930077000 (C3a): a coding session belongs to the member it runs for, and keeps its branch, workspace and
			-- pull request through a cancel.
			elsif v_worker.species = 'coding' and v_worker.owner_user_id is distinct from (p_actor ->> 'requesterUserId')::uuid then
				v_problem := 'This coding session runs for another member';
			elsif v_worker.state = 'active' then
				v_problem := 'this worker is still working; wait for its report or cancel it';
			elsif v_worker.state = 'cancelled' and v_worker.species = 'in-house' then
				v_problem := 'this worker cannot continue; dispatch a new one';$new$);

-- 5. The index ---------------------------------------------------------------------------------------------------------

select pg_temp.c3a_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$	v_todo uuid; v_count bigint; v_report jsonb;$old$,
	$new$	v_todo uuid; v_count bigint; v_report jsonb;
	v_binding uuid; v_version bigint; -- 20260930077000 (C3a): a coding owner's sponsor$new$);

select pg_temp.c3a_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
			access, revival, dispatch, requested_by_user_id, steering_run_id, folder_environment_id, folder_path, folder_key,
			folder_brief_version, folder_commit_id)
		values ((p_parse ->> 'id')::uuid, p_profile_id, p_environment_id, v_commit.actor_id, v_todo, split_part(v_folder, '/', 5),
			'in-house', p_parse ->> 'title', p_parse ->> 'access', p_parse ->> 'revival', v_dispatch, v_commit.requester_id,
			v_commit.run_id, p_environment_id, v_folder_path, v_folder, p_version, p_commit_id)
		returning * into v_worker;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, 'dispatched', v_commit.run_id, v_dispatch);$old$,
	$new$		-- 20260930077000 (C3a): a coding session runs for the member who asked, paid by their own login, which the payer
		-- holds to the plan rule again (the rules checked it from a read before this one).
		if p_parse ->> 'species' = 'coding' then
			select payer.binding_id, payer.version into v_binding, v_version
			from public.qorpera_coding_owner_payer(p_profile_id, v_commit.requester_id, p_parse ->> 'harness',
				(select run.sponsor_binding_id from public.qorpera_execution_runs run where run.id = v_commit.run_id)) payer;
		end if;
		insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
			access, revival, dispatch, requested_by_user_id, steering_run_id, folder_environment_id, folder_path, folder_key,
			folder_brief_version, folder_commit_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
		values ((p_parse ->> 'id')::uuid, p_profile_id, p_environment_id, v_commit.actor_id, v_todo, split_part(v_folder, '/', 5),
			p_parse ->> 'species', p_parse ->> 'title', p_parse ->> 'access', p_parse ->> 'revival', v_dispatch, v_commit.requester_id,
			v_commit.run_id, p_environment_id, v_folder_path, v_folder, p_version, p_commit_id,
			case when p_parse ->> 'species' = 'coding' then v_commit.requester_id end, v_binding, v_version)
		returning * into v_worker;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, 'dispatched', v_commit.run_id, v_dispatch);
		if v_worker.species = 'coding' then
			-- Its session waits for an executor: the claim starts it, and its turn's begin admits the worker's wake.
			insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, session_id, harness, repository, branch)
			values (v_worker.id, p_profile_id, p_environment_id,
				(select run.session_id from public.qorpera_execution_runs run where run.id = v_commit.run_id),
				p_parse ->> 'harness', p_parse -> 'repository', 'qorpera/coding/' || v_worker.id::text);
			perform public.qorpera_coding_session_queue(v_worker, 'dispatch', v_commit.run_id, null);
		end if;$new$);

select pg_temp.c3a_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		values (v_worker.id, v_worker.sequence, 'followup', v_commit.run_id, jsonb_build_object('text', p_parse ->> 'followUp'));$old$,
	$new$		values (v_worker.id, v_worker.sequence, 'followup', v_commit.run_id, jsonb_build_object('text', p_parse ->> 'followUp'));
		-- 20260930077000 (C3a): a coding session's next turn waits for its executor, as its first did.
		if v_worker.species = 'coding' then
			perform public.qorpera_coding_session_queue(v_worker, 'followup', v_commit.run_id, p_parse ->> 'followUp'); end if;$new$);

-- 6. The turn's wake ---------------------------------------------------------------------------------------------------

select pg_temp.c3a_replace('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
	$old$		public.qorpera_worker_dispatch_payload(v_worker, v_todo) || jsonb_build_object('coding', p_coding || jsonb_build_object($old$,
	$new$		-- 20260930077000 (C3a): the folder-v2 payload (the worker's folder, the todo's file).
		public.qorpera_folder_worker_dispatch_payload(v_worker, v_todo) || jsonb_build_object('coding', p_coding || jsonb_build_object($new$);

-- 6b. A retired worker never continues: its folder was deleted, so it comes back only by a restore.
-- Only a finished worker's folder can be deleted, and the member's answer is the one path that turns a finished coding
-- session again; the claim and the begin refuse a retired worker too. Each reads the worker under its rank-5 lock, which
-- the delete takes as well. A retired todo has only retired workers: its file is neither deleted nor moved while a
-- worker folder of it lives, and its id never changes.

select pg_temp.c3a_replace('public.qorpera_answer_coding_session(uuid,text,uuid)'::regprocedure,
	$old$	if v_worker.state = 'active' then
		raise exception 'The session is still working; wait for its question or its result' using errcode = '55000'; end if;$old$,
	$new$	-- 20260930077000 (C3a): a session whose folder was deleted continues only after its restore.
	if v_worker.folder_retired_at is not null then
		raise exception 'This session''s folder was deleted; restore it to continue' using errcode = '55000'; end if;
	if v_worker.state = 'active' then
		raise exception 'The session is still working; wait for its question or its result' using errcode = '55000'; end if;$new$);

select pg_temp.c3a_replace('public.qorpera_claim_coding_session(text,integer)'::regprocedure,
	$old$			if v_worker.state <> 'active' then raise exception 'Coding candidate skipped' using errcode = 'QSK01'; end if;$old$,
	$new$			-- 20260930077000 (C3a): nor a retired worker.
			if v_worker.state <> 'active' or v_worker.folder_retired_at is not null then
				raise exception 'Coding candidate skipped' using errcode = 'QSK01'; end if;$new$);

select pg_temp.c3a_replace('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
	$old$	if v_worker.state <> 'active' or v_worker.occurrence_id is not null then$old$,
	$new$	-- 20260930077000 (C3a): nor a retired worker.
	if v_worker.state <> 'active' or v_worker.occurrence_id is not null or v_worker.folder_retired_at is not null then$new$);

-- 7. The drain ---------------------------------------------------------------------------------------------------------

create or replace function public.qorpera_folder_worker_due(p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930003100 (F2-5b-3); 20260930077000 (C3a): an active coding worker is due only to be stopped with its parent or
	-- its todo; its turns start it, never the drain.
	select case
		when p_worker.state = 'active' then exists (select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j
				on j.id = r.job_id where r.id = p_worker.steering_run_id and j.status = 'cancelled')
			or public.qorpera_worker_revival_stopped(p_worker.steering_run_id)
			or exists (select 1 from public.qorpera_runtime_agent_todos t where t.id = p_worker.todo_id and t.state = 'cancelled')
			or (p_worker.species = 'in-house' and (p_worker.occurrence_id is null
				or exists (select 1 from public.qorpera_wake_occurrences w where w.id = p_worker.occurrence_id
					and w.status in ('completed','failed','cancelled','requires_review'))))
		when p_worker.completion_state = 'waiting' then p_worker.folder_erased_at is not null
			or (not exists (select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
					where r.id = p_worker.steering_run_id and j.status in ('queued','leased'))
				and not (p_worker.revival = 'batch' and p_worker.state <> 'blocked' and exists (select 1
					from public.qorpera_runtime_workers s where s.steering_run_id = p_worker.steering_run_id and s.state = 'active'))
				and not public.qorpera_folder_worker_revival_pending(p_worker.steering_run_id))
		else false end
$$;

select pg_temp.c3a_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$		perform public.qorpera_folder_admit_wakes(v_profile);$old$,
	$new$		-- 20260930077000 (C3a): then the sessions of the coding workers a stop may cancel, FOR UPDATE by worker id (core §3:
		-- the conversations, then the coding sessions, then admission).
		perform 1 from public.qorpera_coding_sessions s where s.worker_id in (select w.id from public.qorpera_runtime_workers w
			where w.id = any(v_due) and w.species = 'coding' and w.state = 'active') order by s.worker_id for update;
		perform public.qorpera_folder_admit_wakes(v_profile);$new$);

select pg_temp.c3a_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$				when insufficient_privilege or no_data_found or object_not_in_prerequisite_state or unique_violation then
					if v_was_active then$old$,
	$new$				when insufficient_privilege or no_data_found or object_not_in_prerequisite_state or unique_violation then
					-- 20260930077000 (C3a): a coding worker's stop that fails is tried again next pass, never a failed start.
					if v_was_active and v_worker.species <> 'in-house' then
						v_skipped := v_skipped + 1;
					elsif v_was_active then$new$);

select pg_temp.c3a_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$					elsif v_worker.occurrence_id is null then$old$,
	$new$					elsif v_worker.species <> 'in-house' then
						-- 20260930077000 (C3a): a coding worker is due here only to be stopped; its turns start it.
						null;
					elsif v_worker.occurrence_id is null then$new$);
