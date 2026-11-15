-- 20260930735000: what a restore leaves behind, and the GitHub copies in Storage (own code storage, step 6, the
-- follow-ups; 12 Nov 2026).
--
-- Two things the live proofs showed. After an operator put a repository back to an earlier copy, the coding sessions
-- whose work the restore took away stayed open: their branch and their base commit are gone from the place, so their
-- next turn cannot start, and nothing archived them. And Storage shows the copy of a GitHub project (a folder under
-- code/ that GitHub-host coding sessions made, with no registry row) with nothing that says what it is.
--
-- 1. qorpera_code_restore_strand(executor, machine, request, stranded): the coding executor archives the sessions a
--    restore stranded, the way the kernel archives a quiet session (qorpera_archive_quiet_coding_sessions,
--    20260928479150): their coding workers entered once together (qorpera_lock_coding_workers), then each session
--    whose worker is not active is archived by the kernel (qorpera_archive_coding_worker). A session whose worker is
--    active (a turn began after the place opened) is counted and left: its turn fails at its start, visibly, and the
--    executor asks again once the restore is finished. The executor finds the stranded sessions itself, in the job
--    that opens the place (openCodeArea: the claim's sessions whose branch and base commit the restored repository
--    does not hold), and the finish keeps them in the outcome (`stranded`, at most 200). Only a restore of the place
--    that has recorded what it restored (`recorded` in its progress) may strand, and only sessions the restore's claim
--    names: of that repository, with a base; once the request is finished restored, only those its outcome names.
--    Answers {"schema":"qorpera.code-restore-strand/v1","state":"done","archived":<n>,"active":<n>}: of the sessions
--    asked, archived counts those archived now (by this call or before it), active those left open. Asked again, it
--    archives what became quiet since, and answers the same of what did not change. `lost` (with 0 and 0): the caller
--    no longer holds the company, the company is being deleted, or the request is not there. Refused, with nothing
--    written: 22023 for a request that is no restore of the place and for any session it does not name (the whole
--    call), 55000 before the restore is recorded, and, as the company's entry refuses them, 0A000 for a company that
--    is not on the company folder (folder-v2: every company since 3 Oct 2026) and 42501 when its folder is not there.
-- 2. qorpera_list_code_repositories answers githubCopies: [{owner, name, github}], the places under code/ of the
--    company's GitHub-host coding sessions (archived ones too: their copy stays in the folder) where no repository is
--    kept in Qorpera. owner and name are the place's (lower case, code/<owner>/<name>/), github the GitHub repository
--    as its newest session there names it ("Owner/Name"). At most 100, in the order of their places: a company has a
--    GitHub copy only where an operator granted an agent a GitHub repository (one in production now), and the web
--    reads the one entry of the folder it shows; 100 entries keep the answer under about 30 KiB whatever the sessions
--    table holds. No table changes.
-- Every changed body carries the marker 20260930735000.
--
-- Who may call: (1) the service role only, as the coding executor that holds the company (the custody check of
-- qorpera_code_hosts_deleting, 42501 otherwise, and care's holder rule: an executor that is not the environment's one
-- enabled executor on that machine gets `lost`). (2) role authenticated, as a member of the company (viewers too).
-- Locks: (1) the company's entry and the stranded sessions' coding workers (qorpera_lock_coding_workers: the fence and
-- the company's row key share, the owners, the agents and their authorities, then the todos and the workers), then
-- each session's row as it is archived, in worker order: the order every coding session's call takes. It takes no
-- registry row and no request row (it reads them unlocked: a restore's `recorded` is never taken back), so it never
-- waits for the restore's own calls, and a restore's calls, which take the registry row and then requests only,
-- never wait for it. (2) none.

set local lock_timeout = '3s';

-- 1. The executor archives what a restore stranded --------------------------------------------------------------------

create function public.qorpera_code_restore_strand(p_owner text, p_machine_id_sha256 text, p_request_id uuid,
	p_stranded uuid[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_request public.qorpera_code_requests%rowtype; v_open uuid[]; v_id uuid;
	v_worker public.qorpera_runtime_workers%rowtype; v_active integer := 0;
	c_lost constant jsonb := '{"schema":"qorpera.code-restore-strand/v1","state":"lost","archived":0,"active":0}';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	-- At most 200 sessions (as many as the claim hands out and the outcome keeps), each once (a null is none).
	if p_stranded is null or cardinality(p_stranded) > 200
		or cardinality(p_stranded) <> (select count(distinct stranded) from unnest(p_stranded) stranded) then
		raise exception 'Code restore strand invalid' using errcode = '22023'; end if;
	-- Unlocked: what a restore recorded stays in its progress, and its finish may come meanwhile. (A request that is not
	-- there has no executor that holds it.)
	select * into v_request from public.qorpera_code_requests where id = p_request_id;
	if not public.qorpera_code_care_holder(v_request.environment_id, p_owner, p_machine_id_sha256)
		or exists (select 1 from public.qorpera_company_deletions deletion
			where deletion.profile_id = v_request.profile_id) then
		return c_lost; end if;
	if v_request.kind <> 'restore' or v_request.input ->> 'mode' is distinct from 'restore' then
		raise exception 'Code restore strand invalid' using errcode = '22023'; end if;
	-- The restored repository is in the record: its place holds what the restore put there.
	if not coalesce(v_request.progress ? 'recorded', false) then
		raise exception 'Code restore is not recorded' using errcode = '55000'; end if;
	-- Each one a session the restore's claim names (of that repository, with a base), and once the restore is
	-- finished, one its outcome names.
	if exists (select 1 from unnest(p_stranded) stranded
		where not exists (select 1 from public.qorpera_coding_sessions session
				where session.worker_id = stranded and session.environment_id = v_request.environment_id
					and session.repository ->> 'host' = 'qorpera' and session.repository ->> 'owner' = v_request.owner
					and session.repository ->> 'name' = v_request.name and session.base_sha is not null)
			or (v_request.outcome ? 'stranded' and not ((v_request.outcome -> 'stranded') ? stranded::text))) then
		raise exception 'Code restore strand invalid' using errcode = '22023'; end if;
	-- The open ones: their coding workers entered once together, then each session in worker order, as the quiet
	-- archive does. A worker that is active once held keeps its session open. (Every id is of the request's environment,
	-- so the entry never meets two; a company that is not on the company folder is refused by it, 0A000, or 42501 when
	-- its folder is not there, before anything is written.)
	select array_agg(session.worker_id order by session.worker_id) into v_open
	from public.qorpera_coding_sessions session
	where session.worker_id = any (p_stranded) and session.archived_at is null;
	if v_open is not null then
		perform public.qorpera_lock_coding_workers(v_open);
		foreach v_id in array v_open loop
			select * into v_worker from public.qorpera_runtime_workers where id = v_id;
			if v_worker.state = 'active' then
				v_active := v_active + 1;
			else
				perform public.qorpera_archive_coding_worker(v_worker, 'kernel', null, null);
			end if;
		end loop;
	end if;
	return jsonb_build_object('schema', 'qorpera.code-restore-strand/v1', 'state', 'done',
		'archived', cardinality(p_stranded) - v_active, 'active', v_active);
end $$;

-- 2. Existing functions -----------------------------------------------------------------------------------------------

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.code_follow_ups_patch(p_target regprocedure, p_edits text[]) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930735000' in v_definition) > 0 then
		raise exception '20260930735000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930735000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- The repositories' list names the GitHub copies too.
select pg_temp.code_follow_ups_patch('public.qorpera_list_code_repositories(uuid)'::regprocedure, array[
	$old$			where repository.profile_id = p_profile_id), '[]'::jsonb));$old$,
	$new$			where repository.profile_id = p_profile_id), '[]'::jsonb),
		-- 20260930735000: the places of the company's GitHub-host coding sessions, archived ones too, where no repository
		-- is kept in Qorpera: each a copy of a GitHub project (code/<owner>/<name>/, lower case), with the GitHub
		-- repository as its newest session there names it. At most 100, in the order of their places.
		'githubCopies', coalesce((select jsonb_agg(jsonb_build_object('owner', copy.owner, 'name', copy.name,
				'github', copy.github) order by copy.owner collate "C", copy.name collate "C")
			from (select lower(session.repository ->> 'owner') as owner, lower(session.repository ->> 'name') as name,
					(array_agg((session.repository ->> 'owner') || '/' || (session.repository ->> 'name')
						order by session.created_at desc, session.worker_id desc))[1] as github
				from public.qorpera_coding_sessions session
				join public.qorpera_company_files file on file.environment_id = session.environment_id
					and file.profile_id = p_profile_id and file.core = 'folder-v2'
				where session.repository ->> 'host' = 'github.com'
					and not exists (select 1 from public.qorpera_code_repositories repository
						where repository.environment_id = session.environment_id
							and repository.owner = lower(session.repository ->> 'owner')
							and repository.name = lower(session.repository ->> 'name'))
				group by 1, 2
				order by lower(session.repository ->> 'owner') collate "C", lower(session.repository ->> 'name') collate "C"
				limit 100) copy), '[]'::jsonb));$new$]);

-- 3. Grants, and the deploy guard -------------------------------------------------------------------------------------

revoke all on function public.qorpera_code_restore_strand(text, text, uuid, uuid[])
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_code_restore_strand(text, text, uuid, uuid[]) to service_role;
comment on function public.qorpera_code_restore_strand(text, text, uuid, uuid[]) is
	'The coding executor archives the sessions a recorded restore of a repository''s place stranded (their branch and '
	'base commit are gone): each whose worker is not active, as the kernel archives a quiet session; an active one is '
	'counted and left. Only sessions of that repository with a base, and once the restore is finished only those its '
	'outcome names (20260930735000).';
comment on function public.qorpera_list_code_repositories(uuid) is
	'The company''s repositories kept in Qorpera, for any member: each with its number of changes and its downloads that '
	'are open or ready; canDownload says whether the caller (owner or admin) may ask for one (20260930720000); '
	'githubCopies, the places under code/ that hold a copy of a GitHub project, at most 100 (20260930735000).';

-- Every changed body carries the marker.
do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_list_code_repositories(uuid)'::regprocedure),
			'20260930735000') = 0 then
		raise exception '20260930735000 is missing from qorpera_list_code_repositories'; end if;
end $guard$;
