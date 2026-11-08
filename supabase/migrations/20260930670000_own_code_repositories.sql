-- 20260930670000: a company's own repositories, kept in Qorpera with no GitHub (own code storage, slice 1; 8 Nov 2026).
-- Jonas, 7 Nov: own code storage first; GitHub stays a connection for people who already have repositories. A founder
-- who does not know what GitHub is must never need it. Until now a coding session's repository was always on GitHub
-- (host github.com): it was seeded from there, pushed there as a draft pull request, and an operator had to write the
-- company's coding executor row and each agent's repository grant first.
--
-- A repository kept in Qorpera is {host: qorpera, owner, name, baseBranch}, owner and name in lower case: it lives only
-- in the company folder, at code/<owner>/<name>/ (repo.git, main/ and the sessions' worktrees). The session's first
-- turn makes it empty when it is not there yet (the code host's startCodeArea: one commit of no files on the default
-- branch, and main/ at it), and a finished turn lands its commit on the default branch (landCodeBranch: a fast-forward,
-- or git's merge when the default branch moved on; a conflict lands nothing and the turn fails saying where). There is
-- no token, no push and no pull request.
--
-- 1. qorpera_coding_repository_valid takes host qorpera too, with lower-case owner and name (a name never ends with a
--    dot): they name a folder, and the folder tells names apart without case. Its default branch is always main, so a
--    repository has one identity: one grant (an operator's turning off holds for it whole) and one main/. GitHub's
--    rules are unchanged.
-- 2. qorpera_company_state_worker_rules: a dispatch on a repository kept in Qorpera needs no repository grant first
--    (every agent of the company may work on the company's own code, as on its other files): the dispatch writes the
--    agent's grant (3), which the session's later steps check as they check a GitHub one; a grant an operator turned off
--    stays off and refuses. It is refused when the same
--    place under code/ already holds a copy of a GitHub repository this company has a grant for, and a dispatch on a
--    GitHub repository is refused when its place holds a repository kept in Qorpera: one folder never holds both.
--    With no executor row for the company, a dispatch on a repository kept in Qorpera passes when some coding executor
--    serves that harness for another company: the dispatch enrolls the company (3).
-- 3. qorpera_coding_executor_enroll(environment, harness): the company's first session on a repository kept in Qorpera
--    enrolls it with the enabled coding executor that serves the fewest companies for that harness (ties by owner),
--    with that node's own settings copied from its newest row (VM and NAS policy, NAS machine, idle times), so a normal
--    company codes with no operator step. A company with any row keeps its rows as they are (a disabled row stays
--    disabled, and the rules refuse). qorpera_company_state_index_worker calls it before the session is queued, and
--    writes the agent's grant of the repository (enabled), unless the agent has one.
-- 4. qorpera_complete_coding_turn: a session on a repository kept in Qorpera never reports a pull request. Its
--    succeeded turn may report where its commit landed, as its one artifact {kind: landed, state, branch, headSha,
--    mainSha}; the agent's report carries it as `landed`, and its summary ends with one line from the platform that
--    says so, which the results file the agent reads keeps: the session's own words are cut by bytes to leave room for
--    it within 4000 bytes.
-- Every changed body carries the marker 20260930670000.

set local lock_timeout = '3s';

-- 1. Which repositories a coding session may name --------------------------------------------------------------------

create or replace function public.qorpera_coding_repository_valid(p_repository jsonb)
returns boolean language sql immutable set search_path = '' as $$
	-- 20260930670000: a repository kept in Qorpera (host qorpera) has a lower-case owner and name, which name its folder.
	select coalesce(jsonb_typeof(p_repository) = 'object'
		and p_repository - array['host','owner','name','baseBranch'] = '{}'::jsonb
		and jsonb_typeof(p_repository -> 'owner') = 'string'
		and jsonb_typeof(p_repository -> 'name') = 'string'
		and case p_repository ->> 'host'
			when 'github.com' then p_repository ->> 'owner' ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
				and p_repository ->> 'name' ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$'
			when 'qorpera' then p_repository ->> 'owner' ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$'
				and p_repository ->> 'name' ~ '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$'
				-- One repository, one default branch: its identity, its grant and its main/ are one (review 1544 r1).
				and p_repository ->> 'baseBranch' = 'main'
			else false end
		and jsonb_typeof(p_repository -> 'baseBranch') = 'string'
		and p_repository ->> 'baseBranch' ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
		and p_repository ->> 'baseBranch' not like '%..%'
		and not exists (select 1 from unnest(string_to_array(p_repository ->> 'baseBranch','/')) part
			where part = '' or left(part,1) = '.' or right(part,1) = '.' or right(part,5) = '.lock'), false)
$$;

-- 3. The company's coding executor, enrolled by its first session on a repository kept in Qorpera ----------------------

create function public.qorpera_coding_executor_enroll(p_environment_id uuid, p_harness text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_owner text; v_like public.qorpera_coding_executors%rowtype;
begin
	-- 20260930670000: a company with any row keeps its rows as they are.
	if exists (select 1 from public.qorpera_coding_executors where environment_id = p_environment_id) then return; end if;
	-- The enabled executor that serves the fewest companies for this harness (ties by owner).
	select executor.owner into v_owner from public.qorpera_coding_executors executor
	where executor.enabled and p_harness = any(executor.harnesses)
	group by executor.owner order by count(*), executor.owner limit 1;
	if v_owner is null then return; end if;
	-- Its node's own settings, as an operator gave them for its other companies: its VM and NAS policy, the NAS
	-- machine it writes from, and its machines' and sessions' idle times (its newest row).
	select * into v_like from public.qorpera_coding_executors executor
	where executor.owner = v_owner and executor.enabled and p_harness = any(executor.harnesses)
	order by executor.updated_at desc, executor.environment_id limit 1;
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, vm_policy, nas_policy,
		nas_machine_id_sha256, machine_sleep_after_seconds, machine_remove_after_seconds, session_archive_after_seconds)
	values (p_environment_id, v_owner, true, array[p_harness], v_like.vm_policy, v_like.nas_policy,
		v_like.nas_machine_id_sha256, v_like.machine_sleep_after_seconds, v_like.machine_remove_after_seconds,
		v_like.session_archive_after_seconds)
	on conflict (environment_id, owner) do nothing;
end $$;
revoke all on function public.qorpera_coding_executor_enroll(uuid, text) from public, anon, authenticated, service_role;

-- 2 and 3. The dispatch's rules, and its session --------------------------------------------------------------------

do $do$
declare v_definition text := pg_get_functiondef(
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure);
	v_executor_old text := $old$			elsif v_species = 'coding' and not exists (select 1 from public.qorpera_coding_executors executor
				where executor.environment_id = p_environment_id and executor.enabled
					and (v_request ->> 'harness') = any(executor.harnesses)) then$old$;
	v_executor_new text := $new$			elsif v_species = 'coding' and not exists (select 1 from public.qorpera_coding_executors executor
				where executor.environment_id = p_environment_id and executor.enabled
					and (v_request ->> 'harness') = any(executor.harnesses))
				-- 20260930670000: a company with no executor row is enrolled by its first session on a repository kept in
				-- Qorpera (qorpera_coding_executor_enroll), when some executor serves that harness.
				and not (v_request -> 'repository' ->> 'host' = 'qorpera'
					and not exists (select 1 from public.qorpera_coding_executors own where own.environment_id = p_environment_id)
					and exists (select 1 from public.qorpera_coding_executors executor where executor.enabled
						and (v_request ->> 'harness') = any(executor.harnesses))) then$new$;
	v_grant_old text := $old$			elsif v_species = 'coding' and not exists (select 1 from public.qorpera_coding_repository_grants grant_row
				where grant_row.environment_id = p_environment_id and grant_row.staff_agent_id = v_staff
					and grant_row.repository = v_request -> 'repository' and grant_row.enabled) then$old$;
	v_grant_new text := $new$			-- 20260930670000: one place under code/ never holds both a GitHub copy and a repository kept in Qorpera.
			elsif v_species = 'coding' and v_request -> 'repository' ->> 'host' = 'qorpera'
				and exists (select 1 from public.qorpera_coding_repository_grants grant_row
					where grant_row.environment_id = p_environment_id and grant_row.repository ->> 'host' = 'github.com'
						and lower(grant_row.repository ->> 'owner') = v_request -> 'repository' ->> 'owner'
						and lower(grant_row.repository ->> 'name') = v_request -> 'repository' ->> 'name') then
				v_problem := 'The company''s code already holds a copy of a GitHub repository at code/'
					|| (v_request -> 'repository' ->> 'owner') || '/' || (v_request -> 'repository' ->> 'name')
					|| '; keep this repository in Qorpera under another owner or name';
			elsif v_species = 'coding' and v_request -> 'repository' ->> 'host' = 'github.com'
				and exists (select 1 from public.qorpera_coding_sessions kept
					where kept.environment_id = p_environment_id and kept.repository ->> 'host' = 'qorpera'
						and kept.repository ->> 'owner' = lower(v_request -> 'repository' ->> 'owner')
						and kept.repository ->> 'name' = lower(v_request -> 'repository' ->> 'name')) then
				v_problem := 'The company keeps a repository of its own in Qorpera at code/'
					|| lower(v_request -> 'repository' ->> 'owner') || '/' || lower(v_request -> 'repository' ->> 'name')
					|| '; use that one (host qorpera), or a GitHub repository with another owner or name';
			-- 20260930670000: the company's own code needs no grant first: its dispatch writes the agent's grant
			-- (qorpera_company_state_index_worker). One an operator turned off stays off.
			elsif v_species = 'coding' and v_request -> 'repository' ->> 'host' = 'qorpera'
				and exists (select 1 from public.qorpera_coding_repository_grants grant_row
					where grant_row.environment_id = p_environment_id and grant_row.staff_agent_id = v_staff
						and grant_row.repository = v_request -> 'repository' and not grant_row.enabled) then
				v_problem := 'This agent''s work on that repository was turned off';
			elsif v_species = 'coding' and v_request -> 'repository' ->> 'host' = 'github.com'
				and not exists (select 1 from public.qorpera_coding_repository_grants grant_row
				where grant_row.environment_id = p_environment_id and grant_row.staff_agent_id = v_staff
					and grant_row.repository = v_request -> 'repository' and grant_row.enabled) then$new$;
begin
	if position('20260930670000' in v_definition) > 0 then
		raise exception '20260930670000 is already in qorpera_company_state_worker_rules'; end if;
	if (length(v_definition) - length(replace(v_definition, v_executor_old, ''))) / length(v_executor_old) <> 1 then
		raise exception '20260930670000 executor anchor differs in qorpera_company_state_worker_rules'; end if;
	if (length(v_definition) - length(replace(v_definition, v_grant_old, ''))) / length(v_grant_old) <> 1 then
		raise exception '20260930670000 grant anchor differs in qorpera_company_state_worker_rules'; end if;
	execute replace(replace(v_definition, v_executor_old, v_executor_new), v_grant_old, v_grant_new);
end $do$;

do $do$
declare v_definition text := pg_get_functiondef(
		'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure);
	v_old text := $old$		if v_worker.species = 'coding' then
			-- Its session waits for an executor: the claim starts it, and its turn's begin admits the worker's wake.
$old$;
	v_new text := $new$		if v_worker.species = 'coding' then
			-- 20260930670000: a session on a repository kept in Qorpera enrolls the company with an executor when it has
			-- none, and grants the agent its company's repository (the grant every coding step checks), as a GitHub
			-- repository's operator does. One that is there stays as it is (the rules refused one turned off).
			if p_parse -> 'repository' ->> 'host' = 'qorpera' then
				perform public.qorpera_coding_executor_enroll(p_environment_id, p_parse ->> 'harness');
				insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
				values (p_environment_id, v_worker.staff_agent_id, p_parse -> 'repository', true)
				on conflict (environment_id, staff_agent_id, repository) do nothing;
			end if;
			-- Its session waits for an executor: the claim starts it, and its turn's begin admits the worker's wake.
$new$;
begin
	if position('20260930670000' in v_definition) > 0 then
		raise exception '20260930670000 is already in qorpera_company_state_index_worker'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930670000 anchor differs in qorpera_company_state_index_worker'; end if;
	execute replace(v_definition, v_old, v_new);
end $do$;

-- 4. The turn's completion: no pull request in Qorpera, and where the commit landed ----------------------------------

do $do$
declare v_definition text := pg_get_functiondef(
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure);
	v_declare_old text := $old$v_report jsonb; v_failure jsonb;$old$;
	v_declare_new text := $new$v_report jsonb; v_failure jsonb;
	v_landed text; -- 20260930670000$new$;
	v_check_old text := $old$		or (p_checks is not null and jsonb_typeof(p_checks) <> 'array') or (p_artifacts is not null and jsonb_typeof(p_artifacts) <> 'array')$old$;
	v_check_new text := $new$		or (p_checks is not null and jsonb_typeof(p_checks) <> 'array') or (p_artifacts is not null and jsonb_typeof(p_artifacts) <> 'array')
		-- 20260930670000: a repository kept in Qorpera has no pull request; its succeeded turn may say where it landed,
		-- and only it.
		or (p_pull_request is not null and v_session.repository ->> 'host' <> 'github.com')
		or (p_artifacts is not null and (v_session.repository ->> 'host' <> 'qorpera' or p_outcome <> 'succeeded'
			or jsonb_array_length(p_artifacts) <> 1 or jsonb_typeof(p_artifacts -> 0) <> 'object'
			or (p_artifacts -> 0) - array['kind','state','branch','headSha','mainSha'] <> '{}'::jsonb
			or p_artifacts -> 0 ->> 'kind' is distinct from 'landed'
			or coalesce(p_artifacts -> 0 ->> 'state', '') not in ('fast-forward','merged','unchanged')
			or p_artifacts -> 0 ->> 'branch' is distinct from v_session.repository ->> 'baseBranch'
			or coalesce(p_artifacts -> 0 ->> 'headSha', '') !~ '^[0-9a-f]{40}$'
			or coalesce(p_artifacts -> 0 ->> 'mainSha', '') !~ '^[0-9a-f]{40}$'))$new$;
	v_summary_old text := $old$	if v_worker.state <> 'active' then raise exception 'Worker was cancelled or has already reported' using errcode = '55000'; end if;$old$;
	v_summary_new text := $new$	if v_worker.state <> 'active' then raise exception 'Worker was cancelled or has already reported' using errcode = '55000'; end if;
	-- 20260930670000: the platform's own line on where the commit landed, after the session's summary (cut to fit).
	if p_artifacts is not null then
		v_landed := E'\n\n' || 'Qorpera landed this commit on ' || (p_artifacts -> 0 ->> 'branch')
			|| case p_artifacts -> 0 ->> 'state' when 'merged' then ', merged with what it got meanwhile'
				when 'unchanged' then ', which already held it' else '' end
			|| ': ' || (p_artifacts -> 0 ->> 'branch') || ' is at ' || left(p_artifacts -> 0 ->> 'mainSha', 12)
			|| ', and the files are in the company folder at code/' || (v_session.repository ->> 'owner') || '/'
			|| (v_session.repository ->> 'name') || '/main/.';
		-- The whole summary stays within the 4000 bytes the results file keeps (review 1544 r1 F3): the session's own
		-- words are cut by bytes, whole characters only, so the platform's line is always there.
		while octet_length(v_summary) > 4000 - octet_length(v_landed) loop
			v_summary := left(v_summary, length(v_summary)
				- greatest(1, (octet_length(v_summary) - (4000 - octet_length(v_landed))) / 4));
		end loop;
		v_summary := v_summary || v_landed;
	end if;$new$;
	v_report_old text := $old$		|| case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end
		-- 20260930551000: a failed turn's reason, which the settle trigger copies to the turn's outcome.$old$;
	v_report_new text := $new$		|| case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end
		-- 20260930670000: where a repository kept in Qorpera got the commit.
		|| case when p_artifacts is not null then jsonb_build_object('landed', p_artifacts -> 0) else '{}'::jsonb end
		-- 20260930551000: a failed turn's reason, which the settle trigger copies to the turn's outcome.$new$;
begin
	if position('20260930670000' in v_definition) > 0 then
		raise exception '20260930670000 is already in qorpera_complete_coding_turn'; end if;
	if (length(v_definition) - length(replace(v_definition, v_check_old, ''))) / length(v_check_old) <> 1
		or (length(v_definition) - length(replace(v_definition, v_summary_old, ''))) / length(v_summary_old) <> 1
		or (length(v_definition) - length(replace(v_definition, v_report_old, ''))) / length(v_report_old) <> 1
		or (length(v_definition) - length(replace(v_definition, v_declare_old, ''))) / length(v_declare_old) <> 1 then
		raise exception '20260930670000 anchor differs in qorpera_complete_coding_turn'; end if;
	execute replace(replace(replace(replace(v_definition, v_check_old, v_check_new), v_summary_old, v_summary_new),
		v_report_old, v_report_new), v_declare_old, v_declare_new);
end $do$;
