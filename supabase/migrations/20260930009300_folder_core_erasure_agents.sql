-- Company folder core, slice P18b: erasure of deleted agent folders and rules (deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md
-- §5 "P18b", §11; contract 5.6 and 14.1). The coordinator's decisions of 3 October 2026: an erased agent, group chat, todo,
-- routine or rule keeps its row with fixed placeholders that meet its checks, loses its path and environment (so the id
-- never comes back: each kind's rule refuses an id whose row is outside the folder) and keeps bare ids; its earlier
-- names, charters and chat titles in the operations log are scrubbed, each row's hash recomputed (rows are not chained);
-- speaker names on past messages stay, like transcripts. Contract 14.1: an erased agent's execution authority and
-- connector grants go, its path grants are revoked through the authority journal, its office and browser grants are
-- revoked. The request replaces P18a's (agents/ and rules/ are no longer refused; tables/ is, until I6) and the drain
-- gains phase 6 (the operations log, then office and browser grants); phase 7 is the old phase 6.
--
-- Lock order (core §3 step 4), as the commit's: rank 0 company KEY SHARE, 1 member, 2 agents NO KEY UPDATE, 3 their
-- execution authorities, 4 group chats and the agents' threads, 5 routines (FOR UPDATE: the tombstone key changes), then
-- P18a's task and contact rows, 6 the agents' grant resources, 7 the grants (each folder-v2 environment of the company,
-- in environment order), 8 their connector grants, 11 the chats', threads' and agent pairs' sessions, then paths; todos,
-- rules and routine versions after the paths, where the commit's apply takes them; the writes (the sessions' rename takes
-- the operation clock); the authority journal last, one per environment in environment order (the folder clocks). Inert
-- until the member route (C4) calls the request.

set local lock_timeout = '3s';

-- 1. An erased row: folder_erased_at, its path and environment gone, its version, commit and retire time kept --------------

alter table public.qorpera_profile_staff add column folder_erased_at timestamptz;
alter table public.qorpera_company_rooms add column folder_erased_at timestamptz;
alter table public.qorpera_runtime_agent_todos add column folder_erased_at timestamptz;
alter table public.qorpera_cloud_routines add column folder_erased_at timestamptz;
alter table public.qorpera_review_rules add column folder_erased_at timestamptz;

-- Each check an erased row meets gains its own branch; every other row meets the old one, which is kept as it was.
alter table public.qorpera_profile_staff drop constraint qorpera_profile_staff_folder_complete,
	add constraint qorpera_profile_staff_folder_complete check (
		(folder_erased_at is not null and folder_path is null and folder_environment_id is null and folder_path_version is not null
			and folder_commit_id is not null and folder_retired_at is not null and source_path is null)
		or (folder_erased_at is null
			and (folder_path is null) = (folder_environment_id is null)
			and (folder_path is null) = (folder_path_version is null)
			and (folder_path is null) = (folder_commit_id is null)
			and (folder_path is null or source_path is null)
			and (folder_retired_at is null or folder_path is not null)));
alter table public.qorpera_company_rooms drop constraint qorpera_company_rooms_folder_complete,
	add constraint qorpera_company_rooms_folder_complete check (
		(folder_erased_at is not null and folder_path is null and folder_environment_id is null and folder_path_version is not null
			and folder_commit_id is not null and folder_retired_at is not null and bound_staff_agent_id is null
			and source_path_version is null)
		or (folder_erased_at is null
			and (folder_path is null) = (folder_environment_id is null)
			and (folder_path is null) = (folder_path_version is null)
			and (folder_path is null) = (folder_commit_id is null)
			and (folder_path is null or (bound_staff_agent_id is null and source_path_version is null))
			and (folder_retired_at is null or folder_path is not null))),
	drop constraint qorpera_company_rooms_source_or_binding,
	add constraint qorpera_company_rooms_source_or_binding check (bound_staff_agent_id is not null
		or (source_path_version is not null and source_snapshot_id is not null and source_file_sha256 is not null)
		or folder_path is not null or folder_erased_at is not null);
alter table public.qorpera_runtime_agent_todos drop constraint qorpera_runtime_agent_todos_source,
	add constraint qorpera_runtime_agent_todos_source check (folder_path is not null or folder_erased_at is not null
		or (requested_by_user_id is not null and created_by_run_id is not null and updated_by_run_id is not null)),
	drop constraint qorpera_runtime_agent_todos_folder_complete,
	add constraint qorpera_runtime_agent_todos_folder_complete check (
		(folder_erased_at is not null and folder_path is null and folder_environment_id is null and folder_path_version is not null
			and folder_commit_id is not null and folder_retired_at is not null)
		or (folder_erased_at is null
			and (folder_path is null) = (folder_environment_id is null)
			and (folder_path is null) = (folder_path_version is null)
			and (folder_path is null) = (folder_commit_id is null)
			and (folder_retired_at is null or folder_path is not null)));
alter table public.qorpera_cloud_routines drop constraint qorpera_cloud_routines_agent_identity,
	add constraint qorpera_cloud_routines_agent_identity check (
		(origin = 'member' and folder_path is null and folder_erased_at is null and owner_staff_agent_id is null and routine_key is null)
		or ((origin <> 'member' or folder_path is not null or folder_erased_at is not null)
			and owner_staff_agent_id is not null and routine_key is not null)),
	drop constraint qorpera_cloud_routines_folder_complete,
	add constraint qorpera_cloud_routines_folder_complete check (
		(folder_erased_at is not null and folder_path is null and folder_environment_id is null and folder_path_version is not null
			and folder_commit_id is not null and folder_retired_at is not null)
		or (folder_erased_at is null
			and (folder_path is null) = (folder_environment_id is null)
			and (folder_path is null) = (folder_path_version is null)
			and (folder_path is null) = (folder_commit_id is null)
			and (folder_retired_at is null or folder_path is not null)));
alter table public.qorpera_review_rules drop constraint qorpera_review_rules_folder_complete,
	add constraint qorpera_review_rules_folder_complete check (
		(folder_erased_at is not null and folder_path is null and folder_environment_id is null and folder_path_version is not null
			and folder_commit_id is not null and archived_at is not null and scope = 'company' and created_via = 'folder')
		or (folder_erased_at is null
			and (folder_path is null) = (folder_environment_id is null)
			and (folder_path is null) = (folder_path_version is null)
			and (folder_path is null) = (folder_commit_id is null)
			and (folder_path is null or (scope = 'company' and created_via = 'folder'))));
-- The erasure's agents (ids and the chats' placeholder titles) and how far phase 6 walked the operations log; phase 7.
alter table public.qorpera_folder_erasures add column agents jsonb check (agents is null or jsonb_typeof(agents) = 'object'),
	drop constraint qorpera_folder_erasures_phase_check,
	add constraint qorpera_folder_erasures_phase_check check (phase between 1 and 7);

-- Indexes for the request's reads: each kind's rows by folded path, so the rows under a root are a range (as P18a's
-- versions); an agent's connector grants (archiving revokes them, so the active-grant index never serves them). Agent
-- pairs' conversations are found through their key's own unique index (20260922220000).
create index qorpera_profile_staff_folder_key on public.qorpera_profile_staff(folder_environment_id,
	(public.qorpera_folder_key(folder_path)) collate "C") where folder_path is not null;
create index qorpera_company_rooms_folder_key on public.qorpera_company_rooms(folder_environment_id,
	(public.qorpera_folder_key(folder_path)) collate "C") where folder_path is not null;
create index qorpera_runtime_agent_todos_folder_key on public.qorpera_runtime_agent_todos(folder_environment_id,
	(public.qorpera_folder_key(folder_path)) collate "C") where folder_path is not null;
create index qorpera_cloud_routines_folder_key on public.qorpera_cloud_routines(folder_environment_id,
	(public.qorpera_folder_key(folder_path)) collate "C") where folder_path is not null;
create index qorpera_review_rules_folder_key on public.qorpera_review_rules(folder_environment_id,
	(public.qorpera_folder_key(folder_path)) collate "C") where folder_path is not null;
create index qorpera_cloud_secret_operation_grants_staff on public.qorpera_cloud_secret_operation_grants(profile_id, staff_agent_id);

-- Whether an index row built from a file under a root lies before the root's cutoff (§5): its retire commit comes before
-- the cutoff's commit, or is that commit and the row's last written version lies before the cutoff position. A row made
-- and removed inside the change set that starts a live root's current life belongs to that life, and stays.
create function public.qorpera_folder_erasure_row_before(p_root jsonb, p_commit uuid, p_version uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select c.seq < (p_root ->> 'cutoffSeq')::bigint
		or (c.seq = (p_root ->> 'cutoffSeq')::bigint and exists (select 1 from public.qorpera_folder_path_versions v
			join public.qorpera_folder_commits vc on vc.id = v.commit_id
			where v.version = p_version and public.qorpera_folder_erasure_before(p_root, vc.seq, v.unit_no)))
		from public.qorpera_folder_commits c where c.id = p_commit), false)
$$;
revoke all on function public.qorpera_folder_erasure_row_before(jsonb, uuid, uuid) from public, anon, authenticated, service_role;

-- 2. An erased agent's thread is renamed by the erasure itself: the thread trigger leaves it (its own rename would re-add
-- every member to the archived thread and append a title the drain then scrubs).

create or replace function public.qorpera_agent_thread_on_staff() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_environment uuid := public.qorpera_profile_environment(new.profile_id);
begin
	if v_environment is null then return new; end if;
	-- 20260930009300 (P18b): an erased agent's thread is the erasure's.
	if new.folder_erased_at is not null then return new; end if;
	if tg_op = 'INSERT' and not (new.employment_status = 'active' and new.deleted_at is null) then return new; end if;
	perform public.qorpera_ensure_agent_thread_internal(new.profile_id,v_environment,new.staff_agent_id,new.updated_by_user_id);
	if not (new.employment_status = 'active' and new.deleted_at is null) then
		update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp()
		where profile_id = new.profile_id and status = 'open' and execution_scope -> 'agentPair' ? new.staff_agent_id::text;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_agent_thread_on_staff() from public,anon,authenticated,service_role;

-- 3. The request (ERASURE.md §3 with §5's P18b rows) -------------------------------------------------------------------

create or replace function public.qorpera_folder_erase(p_environment_id uuid, p_actor jsonb, p_paths jsonb, p_operation_key text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_key_bound constant integer := 2600;
	v_profile uuid; v_user uuid; v_role public.qorpera_profile_role;
	v_keys text[] := '{}'; v_spellings jsonb := '{}'::jsonb; v_path text; v_key text; v_other text;
	v_digest text; v_existing public.qorpera_folder_erasures%rowtype;
	v_tasks uuid[]; v_contacts uuid[]; v_connections uuid[];
	v_locks jsonb := '{}'::jsonb; v_lock record; v_claims text[] := '{}'; v_ancestor text;
	v_as_of bigint; v_as_of_at timestamptz; v_roots jsonb := '[]'::jsonb; v_root jsonb;
	v_work jsonb; v_added jsonb; v_live jsonb; v_open record; v_start record; v_grew boolean;
	v_counts jsonb := '[]'::jsonb; v_versions bigint; v_copies jsonb; v_reply jsonb; v_id uuid := extensions.gen_random_uuid();
	v_staff_ids uuid[]; v_rooms uuid[]; v_threads uuid[]; v_routines uuid[]; v_todos uuid[]; v_rules uuid[]; v_sessions uuid[];
	v_targets jsonb; v_changes jsonb; v_erased jsonb; v_env uuid; v_journal jsonb := '{}'::jsonb; v_pairs uuid[];
begin
	-- 1. Checks, before any lock (ERASURE.md §3).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder erasure runs at read committed' using errcode = '25000'; end if;
	if coalesce(p_operation_key, '') !~ '^[A-Za-z0-9._:-]{8,200}$' then
		raise exception 'Operation key is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '22023'; end if;
	if p_actor ->> 'kind' is distinct from 'member' or p_actor - array['kind','userId'] <> '{}'::jsonb
		or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Only a member erases' using errcode = '22023'; end if;
	v_user := (p_actor ->> 'userId')::uuid;
	if jsonb_typeof(p_paths) is distinct from 'array' or jsonb_array_length(p_paths) not between 1 and 20 then
		raise exception 'Erasure paths are invalid' using errcode = '22023'; end if;
	for v_path in select value #>> '{}' from jsonb_array_elements(p_paths) loop
		if v_path is null or v_path = '' or not public.qorpera_company_path_valid(v_path) then
			raise exception 'Erasure path is invalid' using errcode = '22023'; end if;
		v_key := public.qorpera_folder_key(v_path);
		if octet_length(v_key) > c_key_bound then raise exception 'Erasure path is too long' using errcode = '22023'; end if;
		if split_part(v_key, '/', 1) = 'tables' then
			raise exception 'Erasing tables/ is not available yet' using errcode = '0A000'; end if;
		-- Another member's private paths are theirs alone (contract 4.3): a root at, under or above members/<id>/private.
		if split_part(v_key, '/', 1) = 'members' and split_part(v_key, '/', 2) is distinct from v_user::text
				and split_part(v_key, '/', 3) in ('', 'private') then
			raise exception 'Another member''s private paths are theirs alone' using errcode = '42501'; end if;
		foreach v_other in array v_keys loop
			if public.qorpera_folder_erasure_covers(v_other, v_key) or public.qorpera_folder_erasure_covers(v_key, v_other) then
				raise exception 'An erasure path lies inside another' using errcode = '22023'; end if;
		end loop;
		v_keys := v_keys || v_key;
		v_spellings := v_spellings || jsonb_build_object(v_key, v_path);
	end loop;
	v_keys := array(select k from unnest(v_keys) k order by k collate "C");
	-- Owners and admins erase: refused by a plain read before any lock (and before a replay answers), and checked again
	-- under the member row's lock at rank 1.
	select role into v_role from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'Only owners and admins erase' using errcode = '42501'; end if;
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('userId', v_user, 'roots', to_jsonb(v_keys))::text, 'utf8'),
		'sha256'), 'hex');
	-- A replay answers what the first request answered; the same key with other paths is refused, as the commit's.
	select * into v_existing from public.qorpera_folder_erasures where environment_id = p_environment_id and operation_key = p_operation_key;
	if found then
		if v_existing.request_sha256 is not null and v_existing.request_sha256 <> v_digest then
			raise exception 'Operation key was used for another erasure' using errcode = '22023'; end if;
		return v_existing.reply;
	end if;
	-- The retired human-task and contact rows under the roots, for rank 5 (a plain read; read again after the paths).
	select coalesce(array_agg(i.id order by i.environment_id::text || ':' || i.id::text collate "C"), '{}') into v_tasks
	from unnest(v_keys) k join public.qorpera_folder_human_task_index i on i.environment_id = p_environment_id
		and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
	where i.retired_at is not null;
	select coalesce(array_agg(i.id order by i.environment_id::text || ':' || i.id::text collate "C"), '{}') into v_contacts
	from unnest(v_keys) k join public.qorpera_folder_contact_index i on i.environment_id = p_environment_id
		and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
	where i.retired_at is not null;
	-- P18b: the retired agents, group chats and routines built from files under the roots, for ranks 2, 4 and 5 (a plain
	-- read; read again after the paths). An environment holds few of each.
	select coalesce(array_agg(s.staff_agent_id order by s.staff_agent_id), '{}') into v_staff_ids
	from unnest(v_keys) k join public.qorpera_profile_staff s on s.folder_environment_id = p_environment_id and s.folder_path is not null
		and public.qorpera_folder_key(s.folder_path) collate "C" >= k collate "C"
			and public.qorpera_folder_key(s.folder_path) collate "C" < (k || '0') collate "C"
		and public.qorpera_folder_erasure_covers(k, public.qorpera_folder_key(s.folder_path))
	where s.folder_retired_at is not null and s.profile_id = v_profile;
	select coalesce(array_agg(r.id order by r.id), '{}') into v_rooms
	from unnest(v_keys) k join public.qorpera_company_rooms r on r.folder_environment_id = p_environment_id and r.folder_path is not null
		and public.qorpera_folder_key(r.folder_path) collate "C" >= k collate "C"
			and public.qorpera_folder_key(r.folder_path) collate "C" < (k || '0') collate "C"
		and public.qorpera_folder_erasure_covers(k, public.qorpera_folder_key(r.folder_path))
	where r.folder_retired_at is not null;
	select coalesce(array_agg(r.id order by r.id), '{}') into v_routines
	from unnest(v_keys) k join public.qorpera_cloud_routines r on r.folder_environment_id = p_environment_id and r.folder_path is not null
		and public.qorpera_folder_key(r.folder_path) collate "C" >= k collate "C"
			and public.qorpera_folder_key(r.folder_path) collate "C" < (k || '0') collate "C"
		and public.qorpera_folder_erasure_covers(k, public.qorpera_folder_key(r.folder_path))
	where r.folder_retired_at is not null;
	v_threads := array(select r.id from public.qorpera_company_rooms r
		where r.profile_id = v_profile and r.bound_staff_agent_id = any(v_staff_ids) order by r.id);

	-- 2. Rank 0: the company row KEY SHARE; a company being deleted is purged whole.
	perform 1 from public.qorpera_profiles where id = v_profile for key share;
	if public.qorpera_company_deleting(v_profile) then
		raise exception 'The company is being deleted' using errcode = '55000'; end if;
	-- 3. Rank 1: owners and admins erase.
	v_role := public.qorpera_folder_mutator_role(v_profile, p_actor);
	if v_role not in ('owner','admin') then raise exception 'Only owners and admins erase' using errcode = '42501'; end if;
	-- 4. Ranks 2 to 5 through the commit's own locks, in its table and key order: the agents (rank 2, NO KEY UPDATE),
	-- their execution authorities (rank 3, deleted), the group chats and the agents' threads (rank 4), the routines (rank 5,
	-- FOR UPDATE: their tombstone key changes), then the human-task and contact rows to delete.
	select coalesce(jsonb_agg(x.t), '[]'::jsonb) into v_targets from (
		select jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || s::text,
			'mode', 'nokeyupdate') as t from unnest(v_staff_ids) s
		union all select jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', v_profile::text || ':' || s::text, 'mode', 'update') from unnest(v_staff_ids) s
		union all select jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', r::text, 'mode', 'nokeyupdate')
		from unnest(v_rooms || v_threads) r
		union all select jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', r::text, 'mode', 'update')
		from unnest(v_routines) r) x;
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 2::smallint, 2::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 3::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 4::smallint, 5::smallint);
	perform 1 from public.qorpera_folder_human_task_index i where i.environment_id = p_environment_id and i.id = any(v_tasks)
	order by i.environment_id::text || ':' || i.id::text collate "C" for update;
	perform 1 from public.qorpera_folder_contact_index i where i.environment_id = p_environment_id and i.id = any(v_contacts)
	order by i.environment_id::text || ':' || i.id::text collate "C" for update;
	-- Ranks 6 and 7, in each folder-v2 environment of the company in environment order: the live resources of the agents'
	-- live path grants (NO KEY UPDATE, in folder key order), then the grants, revoked through each environment's authority
	-- journal at the end. Rank 8: their connector grants (vault rows), deleted. Rank 11: the sessions of the group chats,
	-- the threads and the agents' pair conversations, renamed.
	for v_env in select f.environment_id from public.qorpera_company_files f where f.profile_id = v_profile and f.core = 'folder-v2'
		order by f.environment_id loop
		select coalesce(jsonb_agg(x.t), '[]'::jsonb) into v_targets from (
			select distinct jsonb_build_object('rank', 6, 'tbl', 'qorpera_company_path_resources', 'key', g.resource_id::text,
				'mode', 'nokeyupdate') as t
			from public.qorpera_company_path_grants g join public.qorpera_company_path_resources res on res.id = g.resource_id
			where res.environment_id = v_env and res.revoked_at is null and g.principal_kind = 'staff_agent'
				and g.principal_id = any(v_staff_ids) and g.revoked_at is null
			union all select jsonb_build_object('rank', 7, 'tbl', 'qorpera_company_path_grants', 'key', g.id::text, 'mode', 'update')
			from public.qorpera_company_path_grants g join public.qorpera_company_path_resources res on res.id = g.resource_id
			where res.environment_id = v_env and res.revoked_at is null and g.principal_kind = 'staff_agent'
				and g.principal_id = any(v_staff_ids) and g.revoked_at is null) x;
		perform public.qorpera_folder_lock_commit_rank(v_env, v_targets, 6::smallint);
		perform public.qorpera_folder_lock_commit_rank(v_env, v_targets, 7::smallint);
	end loop;
	perform 1 from public.qorpera_cloud_secret_operation_grants g where g.profile_id = v_profile and g.staff_agent_id = any(v_staff_ids)
	order by g.id for update;
	v_pairs := array(select ss.id from public.qorpera_profile_staff o
		cross join unnest(v_staff_ids) s
		join public.qorpera_shared_sessions ss on ss.profile_id = v_profile and ss.execution_scope ? 'agentPairKey'
			and ss.execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key(s, o.staff_agent_id)
		where o.profile_id = v_profile and o.staff_agent_id <> s);
	v_sessions := array(select x.id from (select r.session_id as id from public.qorpera_company_rooms r
		where r.id = any(v_rooms || v_threads) and r.session_id is not null union select unnest(v_pairs)) x order by x.id);
	perform 1 from public.qorpera_shared_sessions where id = any(v_sessions) order by id for update;
	-- 5. Paths: every root FOR UPDATE and every ancestor KEY SHARE, claiming absent keys, in one key order.
	foreach v_key in array v_keys loop
		v_path := v_spellings ->> v_key;
		foreach v_ancestor in array public.qorpera_folder_ancestors(v_path) loop
			if not v_locks ? public.qorpera_folder_key(v_ancestor) then
				v_locks := v_locks || jsonb_build_object(public.qorpera_folder_key(v_ancestor),
					jsonb_build_object('path', v_ancestor, 'mode', 'keyshare'));
			end if;
		end loop;
		v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_path, 'mode', 'update'));
	end loop;
	for v_lock in select l.key collate "C" as key, l.value ->> 'path' as path, l.value ->> 'mode' as mode
		from jsonb_each(v_locks) l order by l.key collate "C" loop
		if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_lock.mode) then v_claims := v_claims || v_lock.key; end if;
	end loop;

	-- 6. As of: every change under a held root has committed, and each root's cutoff.
	select last_seq into v_as_of from public.qorpera_folder_clocks where environment_id = p_environment_id;
	v_as_of_at := clock_timestamp();
	foreach v_key in array v_keys loop
		v_roots := v_roots || jsonb_build_array(public.qorpera_folder_erasure_cutoff(p_environment_id, v_key, v_as_of, v_as_of_at));
	end loop;
	-- A rank-5 row that became retired under a root since the plain read (a delete between step 1 and step 5) was not
	-- locked at its rank: the member route asks again.
	if exists (select 1 from unnest(v_keys) k join public.qorpera_folder_human_task_index i on i.environment_id = p_environment_id
			and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
			where i.retired_at is not null and not i.id = any(v_tasks))
		or exists (select 1 from unnest(v_keys) k join public.qorpera_folder_contact_index i on i.environment_id = p_environment_id
			and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
			where i.retired_at is not null and not i.id = any(v_contacts))
		or exists (select 1 from unnest(v_keys) k join public.qorpera_profile_staff s on s.folder_environment_id = p_environment_id
			and s.folder_path is not null and public.qorpera_folder_key(s.folder_path) collate "C" >= k collate "C"
			and public.qorpera_folder_key(s.folder_path) collate "C" < (k || '0') collate "C"
			and public.qorpera_folder_erasure_covers(k, public.qorpera_folder_key(s.folder_path))
			where s.folder_retired_at is not null and s.profile_id = v_profile and not s.staff_agent_id = any(v_staff_ids))
		or exists (select 1 from unnest(v_keys) k join public.qorpera_company_rooms r on r.folder_environment_id = p_environment_id
			and r.folder_path is not null and public.qorpera_folder_key(r.folder_path) collate "C" >= k collate "C"
			and public.qorpera_folder_key(r.folder_path) collate "C" < (k || '0') collate "C"
			and public.qorpera_folder_erasure_covers(k, public.qorpera_folder_key(r.folder_path))
			where r.folder_retired_at is not null and not r.id = any(v_rooms))
		or exists (select 1 from unnest(v_keys) k join public.qorpera_cloud_routines r on r.folder_environment_id = p_environment_id
			and r.folder_path is not null and public.qorpera_folder_key(r.folder_path) collate "C" >= k collate "C"
			and public.qorpera_folder_key(r.folder_path) collate "C" < (k || '0') collate "C"
			and public.qorpera_folder_erasure_covers(k, public.qorpera_folder_key(r.folder_path))
			where r.folder_retired_at is not null and not r.id = any(v_routines)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message',
			'Company folder changed while the erasure began; retry', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}';
	end if;
	-- A live root with no earlier life has nothing to erase.
	for v_root in select value from jsonb_array_elements(v_roots) loop
		select count(*) into v_versions from public.qorpera_folder_path_versions v
		join public.qorpera_folder_commits c on c.id = v.commit_id
		where v.environment_id = p_environment_id
			and public.qorpera_folder_key(v.path) collate "C" >= (v_root ->> 'key') collate "C"
			and public.qorpera_folder_key(v.path) collate "C" < ((v_root ->> 'key') || '0') collate "C"
			and public.qorpera_folder_erasure_covers(v_root ->> 'key', public.qorpera_folder_key(v.path))
			and public.qorpera_folder_erasure_before(v_root, c.seq, v.unit_no);
		if (v_root ->> 'live')::boolean and v_versions = 0 then
			raise exception 'Nothing to erase at %', v_spellings ->> (v_root ->> 'key') using errcode = '22023'; end if;
		v_counts := v_counts || jsonb_build_array(jsonb_build_object('path', v_spellings ->> (v_root ->> 'key'),
			'cutoffSeq', (v_root ->> 'cutoffSeq')::bigint, 'cutoffUnit', (v_root ->> 'cutoffUnit')::integer, 'versions', v_versions));
	end loop;
	-- §2.4: an unrevoked path resource at or under a deleted root is revoked first (a live root's governs its current file).
	if exists (select 1 from public.qorpera_company_path_resources r join jsonb_array_elements(v_roots) x on not (x ->> 'live')::boolean
			where r.environment_id = p_environment_id and r.revoked_at is null and r.path <> ''
				and public.qorpera_folder_erasure_covers(x ->> 'key', public.qorpera_folder_key(r.path))) then
		raise exception 'A path permission covers what would be erased; revoke it first' using errcode = '22023'; end if;
	-- §2.3: closed under moves. The chain is followed here; if it reaches paths not named, the request is refused with
	-- them (topmost first), and with any live file a history was moved into.
	v_work := v_roots; v_added := '[]'::jsonb; v_live := '[]'::jsonb;
	loop
		v_grew := false;
		for v_open in select * from public.qorpera_folder_erasure_open_moves(p_environment_id, v_work) loop
			if v_open.op = 'move_out' then
				-- The file went on to a live key: moved, not deleted, when that key's current life began with this move
				-- (or the key is a root whose current life holds it).
				select * into v_start from public.qorpera_folder_erasure_life_start(p_environment_id, v_open.partner_key);
				if exists (select 1 from public.qorpera_folder_entries where environment_id = p_environment_id
						and key_sha256 = extensions.digest(v_open.partner_key, 'sha256') and kind <> 'claim')
					and (v_start.version = v_open.partner_version
						or exists (select 1 from jsonb_array_elements(v_work) w where w ->> 'key' = v_open.partner_key)) then
					if not v_live @> jsonb_build_array(v_open.partner_path) then
						v_live := v_live || jsonb_build_array(v_open.partner_path); end if;
					continue;
				end if;
			end if;
			-- A root added this round may cover the partner before its cutoff: closed.
			if exists (select 1 from jsonb_array_elements(v_work) w
					where public.qorpera_folder_erasure_covers(w ->> 'key', v_open.partner_key)
						and public.qorpera_folder_erasure_before(w, v_open.seq, v_open.unit_no)) then
				continue;
			end if;
			-- A partner at or under a root, not before its cutoff, is in that root's current life: the history goes on in a
			-- live file, which naming it would not change.
			if exists (select 1 from jsonb_array_elements(v_work) w
					where public.qorpera_folder_erasure_covers(w ->> 'key', v_open.partner_key)) then
				if not v_live @> jsonb_build_array(v_open.partner_path) then
					v_live := v_live || jsonb_build_array(v_open.partner_path); end if;
				continue;
			end if;
			v_work := v_work || jsonb_build_array(public.qorpera_folder_erasure_cutoff(p_environment_id, v_open.partner_key,
				v_as_of, v_as_of_at));
			v_added := v_added || jsonb_build_array(v_open.partner_path);
			v_grew := true;
		end loop;
		exit when not v_grew or jsonb_array_length(v_added) >= 50;
	end loop;
	if jsonb_array_length(v_added) > 0 or jsonb_array_length(v_live) > 0 then
		raise exception 'This history continues at other paths' using errcode = '22023',
			detail = jsonb_build_object('add', (select coalesce(jsonb_agg(a order by a), '[]'::jsonb) from (
					select a.value #>> '{}' as a from jsonb_array_elements(v_added) a
					where not exists (select 1 from jsonb_array_elements(v_added) b
						where b.value <> a.value and public.qorpera_folder_erasure_covers(public.qorpera_folder_key(b.value #>> '{}'),
							public.qorpera_folder_key(a.value #>> '{}')))
					limit 20) t),
				'live', v_live)::text;
	end if;
	-- Copies (§2.3): other paths, live or deleted, in any folder-v2 environment of the company, whose versions hold an
	-- erased manifest (the empty file left out): their history keeps those bytes, so the member may name them too. The
	-- erased versions through the key range, then the others through the manifest index; up to 20 paths.
	select coalesce(jsonb_agg(jsonb_build_object('environmentId', t.environment_id, 'path', t.path, 'live', t.live)
			order by t.environment_id, t.path), '[]'::jsonb) into v_copies
	from (
		select d.environment_id, d.path, exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = d.environment_id and e.key_sha256 = extensions.digest(d.key, 'sha256') and e.kind <> 'claim') as live
		from (
			select distinct on (o.environment_id, public.qorpera_folder_key(o.path)) o.environment_id, o.path,
				public.qorpera_folder_key(o.path) as key
			from (
				select distinct v.manifest_sha256 from jsonb_array_elements(v_roots) r
				join public.qorpera_folder_path_versions v on v.environment_id = p_environment_id
					and public.qorpera_folder_key(v.path) collate "C" >= (r ->> 'key') collate "C"
					and public.qorpera_folder_key(v.path) collate "C" < ((r ->> 'key') || '0') collate "C"
					and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v.path))
				join public.qorpera_folder_commits c on c.id = v.commit_id
				where v.manifest_sha256 is not null and v.bytes > 0 and public.qorpera_folder_erasure_before(r, c.seq, v.unit_no)) m
			join public.qorpera_company_files f on f.profile_id = v_profile and f.core = 'folder-v2'
			join public.qorpera_folder_path_versions o on o.environment_id = f.environment_id and o.manifest_sha256 = m.manifest_sha256
			where not (o.environment_id = p_environment_id and exists (select 1 from jsonb_array_elements(v_roots) r2
				where public.qorpera_folder_erasure_covers(r2 ->> 'key', public.qorpera_folder_key(o.path))))
			order by o.environment_id, public.qorpera_folder_key(o.path), o.created_at desc) d
		order by d.environment_id, d.path
		limit 20) t;
	-- 7. Connection rows, where the commit's apply takes them (after its paths): read, locked in id order, then read
	-- again under the lock with the same three conditions (a row moved or restored meanwhile stays).
	select coalesce(array_agg(i.secret_id order by i.secret_id), '{}') into v_connections
	from public.qorpera_folder_connection_index i
	join jsonb_array_elements(v_roots) r on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(i.folder_path))
	where i.environment_id = p_environment_id and i.retired_at is not null
		and public.qorpera_folder_erasure_row_before(r, i.commit_id, i.folder_path_version);
	perform 1 from public.qorpera_folder_connection_index where secret_id = any(v_connections) order by secret_id for update;
	select coalesce(array_agg(i.secret_id order by i.secret_id), '{}') into v_connections
	from public.qorpera_folder_connection_index i
	join jsonb_array_elements(v_roots) r on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(i.folder_path))
	where i.secret_id = any(v_connections) and i.environment_id = p_environment_id and i.retired_at is not null
		and public.qorpera_folder_erasure_row_before(r, i.commit_id, i.folder_path_version);
	-- P18b: of the rows locked at their ranks, those that lie before their root's cutoff (qorpera_folder_erasure_row_before);
	-- the threads, pair conversations and sessions of those; then, after the paths as the commit's apply takes them, the
	-- retired todos and rules under the roots (through the folded-key index) and the erased routines' versions.
	v_staff_ids := array(select s.staff_agent_id from public.qorpera_profile_staff s
		join jsonb_array_elements(v_roots) r on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(s.folder_path))
		where s.profile_id = v_profile and s.staff_agent_id = any(v_staff_ids) and s.folder_retired_at is not null
			and public.qorpera_folder_erasure_row_before(r, s.folder_commit_id, s.folder_path_version) order by s.staff_agent_id);
	v_rooms := array(select m.id from public.qorpera_company_rooms m
		join jsonb_array_elements(v_roots) r on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(m.folder_path))
		where m.id = any(v_rooms) and m.folder_retired_at is not null
			and public.qorpera_folder_erasure_row_before(r, m.folder_commit_id, m.folder_path_version) order by m.id);
	v_routines := array(select t.id from public.qorpera_cloud_routines t
		join jsonb_array_elements(v_roots) r on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(t.folder_path))
		where t.id = any(v_routines) and t.folder_retired_at is not null
			and public.qorpera_folder_erasure_row_before(r, t.folder_commit_id, t.folder_path_version) order by t.id);
	v_threads := array(select m.id from public.qorpera_company_rooms m
		where m.id = any(v_threads) and m.bound_staff_agent_id = any(v_staff_ids) order by m.id);
	v_pairs := array(select ss.id from public.qorpera_shared_sessions ss where ss.id = any(v_pairs)
		and ((ss.execution_scope -> 'agentPair' ->> 0)::uuid = any(v_staff_ids)
			or (ss.execution_scope -> 'agentPair' ->> 1)::uuid = any(v_staff_ids))
		order by ss.id);
	v_sessions := array(select x.id from (select m.session_id as id from public.qorpera_company_rooms m
		where m.id = any(v_rooms || v_threads) and m.session_id is not null union select unnest(v_pairs)) x order by x.id);
	v_todos := array(select t.id from jsonb_array_elements(v_roots) r
		join public.qorpera_runtime_agent_todos t on t.folder_environment_id = p_environment_id and t.folder_path is not null
			and public.qorpera_folder_key(t.folder_path) collate "C" >= (r ->> 'key') collate "C"
			and public.qorpera_folder_key(t.folder_path) collate "C" < ((r ->> 'key') || '0') collate "C"
			and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(t.folder_path))
		where t.profile_id = v_profile and t.folder_retired_at is not null
			and public.qorpera_folder_erasure_row_before(r, t.folder_commit_id, t.folder_path_version) order by t.id);
	perform 1 from public.qorpera_runtime_agent_todos where id = any(v_todos) order by id for update;
	v_rules := array(select u.id from jsonb_array_elements(v_roots) r
		join public.qorpera_review_rules u on u.folder_environment_id = p_environment_id and u.folder_path is not null
			and public.qorpera_folder_key(u.folder_path) collate "C" >= (r ->> 'key') collate "C"
			and public.qorpera_folder_key(u.folder_path) collate "C" < ((r ->> 'key') || '0') collate "C"
			and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(u.folder_path))
		where u.profile_id = v_profile and u.archived_at is not null
			and public.qorpera_folder_erasure_row_before(r, u.folder_commit_id, u.folder_path_version) order by u.id);
	perform 1 from public.qorpera_review_rules where id = any(v_rules) order by id for update;
	perform 1 from public.qorpera_cloud_routine_versions where routine_id = any(v_routines) order by routine_id, version for no key update;
	v_erased := jsonb_build_object('agents', cardinality(v_staff_ids), 'groupChats', cardinality(v_rooms),
		'todos', cardinality(v_todos), 'routines', cardinality(v_routines), 'rules', cardinality(v_rules));

	-- 8. Writes: the erasure and its needles, then the index rows, then the claims go.
	v_reply := jsonb_build_object('schema', 'qorpera.folder-erasure/v1', 'erasureId', v_id, 'asOfSeq', v_as_of,
		'roots', v_counts, 'copies', v_copies, 'erased', v_erased);
	insert into public.qorpera_folder_erasures(id, environment_id, profile_id, operation_key, request_sha256,
		requested_by_user_id, as_of_seq, as_of_at, roots, reply)
	values (v_id, p_environment_id, v_profile, p_operation_key, v_digest, v_user, v_as_of, v_as_of_at,
		(select jsonb_agg(r - 'live') from jsonb_array_elements(v_roots) r), v_reply)
	on conflict (environment_id, operation_key) do nothing;
	if not found then
		-- A request with this key committed while this one waited on the roots: its reply answers (other paths are
		-- refused), and this one's claims go.
		delete from public.qorpera_folder_entries e
		where e.environment_id = p_environment_id and e.kind = 'claim'
			and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));
		select * into v_existing from public.qorpera_folder_erasures
		where environment_id = p_environment_id and operation_key = p_operation_key;
		if v_existing.request_sha256 is not null and v_existing.request_sha256 <> v_digest then
			raise exception 'Operation key was used for another erasure' using errcode = '22023'; end if;
		return v_existing.reply;
	end if;
	insert into public.qorpera_folder_erasure_needles(erasure_id, needle, cutoff_seq, cutoff_unit, cutoff_at)
	select v_id, n.needle, (r ->> 'cutoffSeq')::bigint, (r ->> 'cutoffUnit')::integer, (r ->> 'cutoffAt')::timestamptz
	from jsonb_array_elements(v_roots) r
	cross join lateral (values (v_spellings ->> (r ->> 'key')), (left(v_spellings ->> (r ->> 'key'), 100))) n(needle)
	on conflict do nothing;
	delete from public.qorpera_folder_human_task_index i using jsonb_array_elements(v_roots) r
	where i.environment_id = p_environment_id and i.id = any(v_tasks) and i.retired_at is not null
		and public.qorpera_folder_erasure_covers(r ->> 'key', i.folder_key)
		and public.qorpera_folder_erasure_row_before(r, i.commit_id, i.folder_path_version);
	delete from public.qorpera_folder_contact_index i using jsonb_array_elements(v_roots) r
	where i.environment_id = p_environment_id and i.id = any(v_contacts) and i.retired_at is not null
		and public.qorpera_folder_erasure_covers(r ->> 'key', i.folder_key)
		and public.qorpera_folder_erasure_row_before(r, i.commit_id, i.folder_path_version);
	delete from public.qorpera_folder_connection_index where secret_id = any(v_connections);
	-- P18b (§5): the rows take fixed placeholders that meet their checks, lose their path and environment (an erased id
	-- never comes back: each kind's rule refuses an id whose row is outside the folder) and keep bare ids. Contract 14.1:
	-- an erased agent's execution authority and connector grants go, its path grants are revoked; its office and browser
	-- grants are revoked by the drain. The sessions' rename takes the operation clock (as the commit's apply); the rest
	-- touches rows already locked.
	update public.qorpera_company_rooms set name = 'Erased group chat', subtitle = null, purpose = 'Erased.', folder_path = null,
		folder_environment_id = null, folder_erased_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
	where id = any(v_rooms);
	update public.qorpera_company_rooms set name = 'Erased agent', updated_at = clock_timestamp() where id = any(v_threads);
	-- A pair conversation is titled as the pair function titles it, with the erased side's placeholder name.
	update public.qorpera_shared_sessions s set title = case
			when exists (select 1 from public.qorpera_company_rooms m where m.session_id = s.id and m.id = any(v_rooms))
				then 'Erased group chat'
			when s.id = any(v_pairs) then (select least(n.a, n.b) || ' & ' || greatest(n.a, n.b) from (select
				coalesce((select case when o.staff_agent_id = any(v_staff_ids) then 'Erased agent' else o.display_name end
					from public.qorpera_profile_staff o where o.profile_id = v_profile
						and o.staff_agent_id = (s.execution_scope -> 'agentPair' ->> 0)::uuid), 'Erased agent') as a,
				coalesce((select case when o.staff_agent_id = any(v_staff_ids) then 'Erased agent' else o.display_name end
					from public.qorpera_profile_staff o where o.profile_id = v_profile
						and o.staff_agent_id = (s.execution_scope -> 'agentPair' ->> 1)::uuid), 'Erased agent') as b) n)
			else 'Erased agent' end,
		updated_at = statement_timestamp()
	where s.id = any(v_sessions);
	update public.qorpera_runtime_agent_todos set title = 'Erased', detail = '', todo_key = 'erased.' || replace(id::text, '-', ''),
		folder_path = null, folder_environment_id = null, folder_erased_at = clock_timestamp(), revision = revision + 1,
		updated_at = clock_timestamp()
	where id = any(v_todos);
	update public.qorpera_cloud_routines set routine_key = 'erased.' || replace(id::text, '-', ''), folder_path = null,
		folder_environment_id = null, folder_erased_at = clock_timestamp(), updated_at = statement_timestamp()
	where id = any(v_routines);
	update public.qorpera_cloud_routine_versions set title = 'Erased', prompt = 'Erased.',
		content_sha256 = public.qorpera_company_state_routine_sha(staff_agent_id, 'Erased', 'Erased.', triggers, effort,
			sponsor_binding_id, sponsor_version)
	where routine_id = any(v_routines);
	update public.qorpera_review_rules set when_text = 'Erased.', folder_path = null, folder_environment_id = null,
		folder_erased_at = clock_timestamp(), updated_at = clock_timestamp()
	where id = any(v_rules);
	delete from public.qorpera_staff_execution_authorities where profile_id = v_profile and staff_agent_id = any(v_staff_ids);
	for v_env in select f.environment_id from public.qorpera_company_files f where f.profile_id = v_profile and f.core = 'folder-v2'
		order by f.environment_id loop
		with revoked as (
			update public.qorpera_company_path_grants g set revoked_at = clock_timestamp(), revision = g.revision + 1
			from public.qorpera_company_path_resources res
			where res.id = g.resource_id and res.environment_id = v_env and res.revoked_at is null and g.principal_kind = 'staff_agent'
				and g.principal_id = any(v_staff_ids) and g.revoked_at is null
			returning g.id, g.revision, public.qorpera_folder_key(res.path) as prefix)
		select coalesce(jsonb_agg(jsonb_build_object('grantId', id, 'revision', revision, 'prefix', prefix) order by id), '[]'::jsonb)
		into v_changes from revoked;
		if jsonb_array_length(v_changes) > 0 then v_journal := v_journal || jsonb_build_object(v_env::text, v_changes); end if;
	end loop;
	delete from public.qorpera_cloud_secret_operation_grants where profile_id = v_profile and staff_agent_id = any(v_staff_ids);
	update public.qorpera_profile_staff set display_name = 'Erased agent', role = 'Erased', charter = 'Erased.', folder_path = null,
		folder_environment_id = null, folder_erased_at = clock_timestamp(), version = version + 1,
		updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
	where profile_id = v_profile and staff_agent_id = any(v_staff_ids);
	-- What the drain scrubs from the operations log (their earlier names, charters and chat titles), up to now.
	if cardinality(v_staff_ids) > 0 or cardinality(v_sessions) > 0 then
		update public.qorpera_folder_erasures set agents = jsonb_build_object('staff', to_jsonb(v_staff_ids),
			'sessions', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title) order by s.id), '[]'::jsonb)
				from public.qorpera_shared_sessions s where s.id = any(v_sessions)),
			'opsFrom', 0, 'opsUntil', coalesce((select last_sequence from public.qorpera_profile_operation_clocks
				where profile_id = v_profile), 0))
		where id = v_id;
	end if;
	delete from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.kind = 'claim'
		and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));
	-- The revoked grants, through each environment's authority journal in environment order: the folder clocks, last
	-- (live runs' rechecks see them go).
	for v_env, v_changes in select j.key::uuid, j.value from jsonb_each(v_journal) j order by j.key collate "C" loop
		perform public.qorpera_folder_authority_journal(v_env, p_actor, true, v_changes);
	end loop;
	return v_reply;
end $$;

-- 4. The drain (ERASURE.md §4.3; phase 6 for P18b) ----------------------------------------------------------------

create or replace function public.qorpera_folder_erasure_step(p_versions integer default 1000, p_commits integer default 1000,
	p_hashes integer default 2000)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_budget constant interval := interval '1 second';
	c_bytes constant bigint := 4194304;
	c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
	v_started timestamptz := clock_timestamp();
	v_candidate record; v_erasure public.qorpera_folder_erasures%rowtype; v_got boolean := false; v_revisit boolean := false;
	v_batch jsonb; v_rows integer := 0; v_count integer := 0; v_hashes text[]; v_needles jsonb; v_commit record;
	v_units jsonb; v_cursor jsonb; v_record record; v_run record; v_receipt record; v_card record; v_ended boolean;
	v_left integer; v_bytes bigint := 0; v_out boolean := false; v_raw text[]; v_escaped text[]; v_cut timestamptz[];
	v_applies text[]; v_applies_raw text[]; v_after_at timestamptz; v_after_id uuid; v_gc boolean; v_max_seq bigint;
	v_max_at timestamptz; v_state text; v_message text; v_part text; v_op record; v_payload jsonb; v_from bigint; v_until bigint;
	v_office_left boolean := false; v_agent record; v_offices uuid[]; v_browsers uuid[]; v_ops integer := 0;
begin
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder erasure runs at read committed' using errcode = '25000'; end if;
	-- Candidates: working erasures, then waiting ones due a revisit; none of a company being deleted (its purge removes
	-- them). The company row KEY SHARE first (the purge holds it FOR UPDATE: skip), then the erasure row.
	for v_candidate in select e.id, e.profile_id from public.qorpera_folder_erasures e
		where e.done_at is null and (e.state = 'working' or (e.state = 'waiting' and e.revisit_at <= clock_timestamp()))
			and not exists (select 1 from public.qorpera_company_deletions d where d.profile_id = e.profile_id)
		order by e.state = 'waiting', e.requested_at, e.id
		limit 20
	loop
		perform 1 from public.qorpera_profiles where id = v_candidate.profile_id for key share skip locked;
		if not found then continue; end if;
		select * into v_erasure from public.qorpera_folder_erasures where id = v_candidate.id for update skip locked;
		if not found or v_erasure.done_at is not null then continue; end if;
		v_got := true;
		exit;
	end loop;
	if not v_got then return jsonb_build_object('schema', 'qorpera.folder-erasure-step/v1', 'erasureId', null); end if;
	-- A revisit works until the step decides to wait again.
	if v_erasure.state = 'waiting' then
		v_revisit := true;
		update public.qorpera_folder_erasures set state = 'working', revisit_at = null where id = v_erasure.id
		returning * into v_erasure;
	end if;
	v_cursor := v_erasure.cursor;

	begin
		select max((r ->> 'cutoffSeq')::bigint), max((r ->> 'cutoffAt')::timestamptz) into v_max_seq, v_max_at
		from jsonb_array_elements(v_erasure.roots) r;
		if v_erasure.phase = 1 then
			-- Versions under each root before its cutoff, through the key range: their hashes, their root's spellings and
			-- their runs kept, then the rows deleted.
			select coalesce(jsonb_agg(jsonb_build_object('version', b.version, 'path', b.path, 'commitId', b.commit_id,
					'manifest', b.manifest_sha256, 'at', b.created_at, 'root', b.root)), '[]'::jsonb)
			into v_batch from (
				select v.version, v.path, v.commit_id, v.manifest_sha256, v.created_at, r as root
				from jsonb_array_elements(v_erasure.roots) r
				join public.qorpera_folder_path_versions v on v.environment_id = v_erasure.environment_id
					and public.qorpera_folder_key(v.path) collate "C" >= (r ->> 'key') collate "C"
					and public.qorpera_folder_key(v.path) collate "C" < ((r ->> 'key') || '0') collate "C"
					and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v.path))
				join public.qorpera_folder_commits c on c.id = v.commit_id
				where public.qorpera_folder_erasure_before(r, c.seq, v.unit_no)
				limit p_versions) b;
			v_rows := jsonb_array_length(v_batch);
			insert into public.qorpera_folder_erasure_hashes(erasure_id, sha256)
			select distinct v_erasure.id, h from (
				select b ->> 'manifest' as h from jsonb_array_elements(v_batch) b where b ->> 'manifest' is not null
				union
				select ch.chunk_sha256 from jsonb_array_elements(v_batch) b
				join public.qorpera_folder_file_chunks ch on ch.profile_id = v_erasure.profile_id and ch.manifest_sha256 = b ->> 'manifest'
			) x
			on conflict do nothing;
			-- How each version spells its root (the path's first components, as many as the root has; the whole path if
			-- folding changed the count), and its first 100 characters.
			insert into public.qorpera_folder_erasure_needles(erasure_id, needle, cutoff_seq, cutoff_unit, cutoff_at)
			select distinct on (n.needle) v_erasure.id, n.needle, (b -> 'root' ->> 'cutoffSeq')::bigint,
				(b -> 'root' ->> 'cutoffUnit')::integer, (b -> 'root' ->> 'cutoffAt')::timestamptz
			from jsonb_array_elements(v_batch) b
			cross join lateral (select array_to_string((string_to_array(b ->> 'path', '/'))
				[1:array_length(string_to_array(b -> 'root' ->> 'key', '/'), 1)], '/') as prefix) p
			cross join lateral (select case when public.qorpera_folder_key(p.prefix) = b -> 'root' ->> 'key' then p.prefix
				else b ->> 'path' end as spelling) w
			cross join lateral (values (w.spelling), (left(w.spelling, 100))) n(needle)
			order by n.needle
			on conflict do nothing;
			insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
			select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_batch) b
			join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid where c.run_id is not null
			on conflict do nothing;
			delete from public.qorpera_folder_path_versions v
			where v.version in (select (b ->> 'version')::uuid from jsonb_array_elements(v_batch) b);
			update public.qorpera_folder_erasures set
				first_erased_at = least(coalesce(first_erased_at, 'infinity'::timestamptz),
					coalesce((select min((b ->> 'at')::timestamptz) from jsonb_array_elements(v_batch) b), 'infinity'::timestamptz)),
				phase = case when v_rows < p_versions then 2 else 1 end,
				counts = jsonb_set(counts, '{versions}', to_jsonb(coalesce((counts ->> 'versions')::bigint, 0) + v_rows))
			where id = v_erasure.id;
			update public.qorpera_folder_erasures set first_erased_at = null
			where id = v_erasure.id and first_erased_at = 'infinity'::timestamptz;

		elsif v_erasure.phase = 2 then
			-- Change sets before each root's cutoff: saved ones by seq, then unsaved ones by time (§4.3 phase 2).
			select coalesce(jsonb_agg(jsonb_build_object('needle', n.needle, 'cutoffSeq', n.cutoff_seq, 'cutoffUnit', n.cutoff_unit,
				'cutoffAt', n.cutoff_at)), '[]'::jsonb) into v_needles
			from public.qorpera_folder_erasure_needles n where n.erasure_id = v_erasure.id;
			if not v_cursor ? 'unsaved' then
				for v_commit in select c.id, c.seq, c.created_at, c.units, c.run_id from public.qorpera_folder_commits c
					where c.environment_id = v_erasure.environment_id and c.seq is not null
						and c.seq > coalesce((v_cursor ->> 'seq')::bigint, 0) and c.seq <= v_max_seq
					order by c.seq limit p_commits
				loop
					v_units := public.qorpera_folder_erasure_units(v_commit.units, v_commit.seq, v_commit.created_at,
						v_erasure.roots, v_needles);
					if v_units is not null then
						update public.qorpera_folder_commits set units = v_units where id = v_commit.id;
						if v_commit.run_id is not null then
							insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_commit.run_id)
							on conflict do nothing;
						end if;
						v_rows := v_rows + 1;
					end if;
					v_count := v_count + 1;
					v_cursor := jsonb_build_object('seq', v_commit.seq);
					if clock_timestamp() - v_started > c_budget then v_out := true; exit; end if;
				end loop;
				if v_count < p_commits and not v_out then v_cursor := jsonb_build_object('unsaved', true); end if;
			else
				for v_commit in select c.id, c.created_at, c.units, c.run_id from public.qorpera_folder_commits c
					where c.environment_id = v_erasure.environment_id and c.seq is null and c.created_at < v_max_at
						and (c.created_at, c.id) > (coalesce((v_cursor ->> 'at')::timestamptz, '-infinity'::timestamptz),
							coalesce((v_cursor ->> 'id')::uuid, c_zero))
					order by c.created_at, c.id limit p_commits
				loop
					v_units := public.qorpera_folder_erasure_units(v_commit.units, null, v_commit.created_at, v_erasure.roots, v_needles);
					if v_units is not null then
						update public.qorpera_folder_commits set units = v_units where id = v_commit.id;
						if v_commit.run_id is not null then
							insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_commit.run_id)
							on conflict do nothing;
						end if;
						v_rows := v_rows + 1;
					end if;
					v_count := v_count + 1;
					v_cursor := jsonb_build_object('unsaved', true, 'at', v_commit.created_at, 'id', v_commit.id);
					if clock_timestamp() - v_started > c_budget then v_out := true; exit; end if;
				end loop;
			end if;
			update public.qorpera_folder_erasures set
				phase = case when v_erasure.cursor ? 'unsaved' and v_count < p_commits and not v_out then 3 else 2 end,
				cursor = case when v_erasure.cursor ? 'unsaved' and v_count < p_commits and not v_out then '{}'::jsonb
					else v_cursor end,
				counts = jsonb_set(counts, '{commits}', to_jsonb(coalesce((counts ->> 'commits')::bigint, 0) + v_rows))
			where id = v_erasure.id;

		elsif v_erasure.phase = 3 then
			-- The runs that read an erased version: read records from the first erased version's time to the cutoff's.
			for v_record in select rr.run_id, rr.release_id, rr.resource_id, rr.created_at, rr.reads
				from public.qorpera_folder_run_read_records rr
				where v_erasure.first_erased_at is not null and rr.environment_id = v_erasure.environment_id
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
		end if;

		if v_erasure.phase = 4 or (v_erasure.phase >= 5 and (v_revisit or v_cursor ? 'run' or v_cursor ? 'after')) then
			-- The noted runs' receipts and reviewed cards (§6), in run order: in phase 4 the noted runs, on a revisit the
			-- pending ones too. A text counts against a needle only when it was made before that needle's cutoff (a live
			-- root's current life keeps its own). A run still live, a row locked meanwhile (run-owned rows: SKIP LOCKED) or
			-- a card still open leaves the run pending, revisited hourly. The cursor holds the run in progress, the part
			-- (receipts, then cards) and where it stopped and what it left, or the last run done.
			select coalesce(array_agg(n.needle order by n.needle_md5), '{}'),
				coalesce(array_agg(substr(to_jsonb(n.needle)::text, 2, char_length(to_jsonb(n.needle)::text) - 2) order by n.needle_md5), '{}'),
				coalesce(array_agg(n.cutoff_at order by n.needle_md5), '{}')
			into v_raw, v_escaped, v_cut from public.qorpera_folder_erasure_needles n where n.erasure_id = v_erasure.id;
			for v_run in select er.run_id from public.qorpera_folder_erasure_runs er
				where er.erasure_id = v_erasure.id and (er.state = 'noted' or (er.state = 'pending' and v_erasure.phase >= 5))
					and er.run_id > coalesce((v_cursor ->> 'after')::uuid, c_zero)
					and er.run_id >= coalesce((v_cursor ->> 'run')::uuid, c_zero)
				order by er.run_id
			loop
				v_ended := exists (select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
					where r.id = v_run.run_id and j.status not in ('queued','leased'));
				if v_run.run_id = (v_cursor ->> 'run')::uuid then
					v_part := coalesce(v_cursor ->> 'part', 'receipts');
					v_after_at := (v_cursor ->> 'at')::timestamptz; v_after_id := (v_cursor ->> 'id')::uuid;
					v_left := coalesce((v_cursor ->> 'left')::integer, 0);
				else
					v_part := 'receipts'; v_after_at := '-infinity'; v_after_id := c_zero; v_left := 0;
				end if;
				if v_ended and v_part = 'receipts' then
					for v_receipt in select o.id, o.created_at, o.result -> 'content' as content
						from public.qorpera_run_operation_receipts o
						where o.run_id = v_run.run_id and o.status = 'completed' and (o.created_at, o.id) > (v_after_at, v_after_id)
						order by o.created_at, o.id
					loop
						v_bytes := v_bytes + coalesce(octet_length(v_receipt.content::text), 0);
						v_applies := array(select x.e from unnest(v_escaped, v_cut) x(e, c) where v_receipt.created_at < x.c);
						if v_receipt.content is distinct from '{"kind":"text","value":"[erased]"}'::jsonb
							and public.qorpera_folder_erasure_hit(v_receipt.content::text, v_applies) then
							perform 1 from public.qorpera_run_operation_receipts where id = v_receipt.id for no key update skip locked;
							if found then
								update public.qorpera_run_operation_receipts
								set result = jsonb_set(result, '{content}', '{"kind":"text","value":"[erased]"}'::jsonb)
								where id = v_receipt.id;
								v_count := v_count + 1;
							else
								v_left := v_left + 1;
							end if;
						end if;
						if v_bytes > c_bytes or clock_timestamp() - v_started > c_budget then
							v_cursor := jsonb_build_object('run', v_run.run_id, 'part', 'receipts', 'at', v_receipt.created_at,
								'id', v_receipt.id, 'left', v_left);
							v_out := true;
							exit;
						end if;
					end loop;
					exit when v_out;
					v_after_at := '-infinity'; v_after_id := c_zero;
				end if;
				if v_ended then
					-- An open card (or an allow not yet used) is what a member or a woken agent still reads: left pending.
					-- An answered one loses each field that names an erased path, keeping its JSON type.
					for v_card in select a.id, a.created_at, a.action, a.reason,
							not (a.decision <> 'ask' or a.answer is not distinct from 'deny' or a.consumed_at is not null) as open
						from public.qorpera_action_reviews a where a.run_id = v_run.run_id and (a.created_at, a.id) > (v_after_at, v_after_id)
						order by a.created_at, a.id
					loop
						v_bytes := v_bytes + octet_length(v_card.action::text) + coalesce(octet_length(v_card.reason), 0);
						v_applies := array(select x.e from unnest(v_escaped, v_cut) x(e, c) where v_card.created_at < x.c);
						v_applies_raw := array(select x.n from unnest(v_raw, v_cut) x(n, c) where v_card.created_at < x.c);
						if public.qorpera_folder_erasure_hit(v_card.action::text, v_applies)
							or public.qorpera_folder_erasure_hit(v_card.reason, v_applies_raw) then
							if v_card.open then
								v_left := v_left + 1;
							else
								perform 1 from public.qorpera_action_reviews where id = v_card.id for no key update skip locked;
								if found then
									update public.qorpera_action_reviews a
									set action = a.action || coalesce((select jsonb_object_agg(k, public.qorpera_folder_erasure_blank(a.action -> k))
											from unnest(array['title','target','details','arguments']) k
											where a.action ? k and public.qorpera_folder_erasure_hit((a.action -> k)::text, v_applies)), '{}'::jsonb),
										reason = case when public.qorpera_folder_erasure_hit(a.reason, v_applies_raw) then 'Erased.' else a.reason end
									where a.id = v_card.id;
									v_count := v_count + 1;
								else
									v_left := v_left + 1;
								end if;
							end if;
						end if;
						if v_bytes > c_bytes or clock_timestamp() - v_started > c_budget then
							v_cursor := jsonb_build_object('run', v_run.run_id, 'part', 'cards', 'at', v_card.created_at, 'id', v_card.id,
								'left', v_left);
							v_out := true;
							exit;
						end if;
					end loop;
					exit when v_out;
				end if;
				update public.qorpera_folder_erasure_runs set state = case when v_ended and v_left = 0 then 'done' else 'pending' end
				where erasure_id = v_erasure.id and run_id = v_run.run_id;
				v_cursor := jsonb_build_object('after', v_run.run_id);
				if v_bytes > c_bytes or clock_timestamp() - v_started > c_budget then v_out := true; exit; end if;
			end loop;
			update public.qorpera_folder_erasures set
				phase = case when phase = 4 and not v_out and not exists (select 1 from public.qorpera_folder_erasure_runs
					where erasure_id = v_erasure.id and state = 'noted') then 5 else phase end,
				cursor = case when v_out then v_cursor else '{}'::jsonb end,
				counts = jsonb_set(counts, '{scrubbed}', to_jsonb(coalesce((counts ->> 'scrubbed')::bigint, 0) + v_count))
			where id = v_erasure.id;
		end if;

		select * into v_erasure from public.qorpera_folder_erasures where id = v_erasure.id;
		if v_erasure.phase = 5 and not v_out then
			-- Bytes (C1D §9.4), in a statement after the deletes: side rows for hashes nothing roots now, where a catalog row
			-- exists, when folder GC serves the company; otherwise they wait (bytes_pending).
			v_gc := public.qorpera_folder_gc_company(v_erasure.profile_id);
			if v_gc then
				select coalesce(array_agg(h.sha256 order by h.sha256 collate "C"), '{}') into v_hashes from (
					select sha256 from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id
					order by sha256 collate "C" limit p_hashes) h;
				insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
				select v_erasure.profile_id, h, clock_timestamp() from unnest(v_hashes) h
				where exists (select 1 from public.qorpera_profile_objects o where o.profile_id = v_erasure.profile_id and o.sha256 = h)
					and not public.qorpera_folder_object_rooted(v_erasure.profile_id, h)
				order by h collate "C"
				on conflict (profile_id, sha256) do update
				set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);
				delete from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id and sha256 = any(v_hashes);
			end if;
			update public.qorpera_folder_erasures set
				phase = case when not exists (select 1 from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id)
					then 6 else 5 end,
				bytes_pending = not v_gc and exists (select 1 from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id)
			where id = v_erasure.id;
		end if;

		select * into v_erasure from public.qorpera_folder_erasures where id = v_erasure.id;
		if v_erasure.phase = 6 and not v_out then
			-- Erased agents and chats (P18b). First their office access and browser grants are revoked, an agent at a time and
			-- only with every one of its rows in hand (SKIP LOCKED: a row in use leaves that agent for the hourly revisit, and
			-- the company-wide office trigger then finds nothing left to change). Then their earlier names, roles, charters
			-- and conversation titles in the company's operations log become the placeholders, each changed row's hash
			-- recomputed from its own fields (rows are not chained: the hash covers the row's type, entity, version and
			-- payload): a walk by sequence, up to 5,000 a step and within the step's budget, to where the log stood at the
			-- request.
			if v_erasure.agents is not null then
				if not coalesce((v_erasure.agents ->> 'officeDone')::boolean, false) then
					for v_agent in select (a #>> '{}')::uuid as id from jsonb_array_elements(v_erasure.agents -> 'staff') a loop
						v_offices := array(select x.office_id from public.qorpera_runtime_office_access x
							where x.profile_id = v_erasure.profile_id and x.staff_agent_id = v_agent.id and x.state = 'active'
							order by x.office_id for no key update skip locked);
						v_browsers := array(select x.id from public.qorpera_runtime_browser_grants x
							join public.qorpera_runtime_office_access a on a.office_id = x.office_id and a.staff_agent_id = x.staff_agent_id
							where a.profile_id = v_erasure.profile_id and x.staff_agent_id = v_agent.id and x.state = 'active'
							order by x.id for update of x skip locked);
						if cardinality(v_offices) = (select count(*) from public.qorpera_runtime_office_access x
								where x.profile_id = v_erasure.profile_id and x.staff_agent_id = v_agent.id and x.state = 'active')
							and cardinality(v_browsers) = (select count(*) from public.qorpera_runtime_browser_grants x
								join public.qorpera_runtime_office_access a on a.office_id = x.office_id and a.staff_agent_id = x.staff_agent_id
								where a.profile_id = v_erasure.profile_id and x.staff_agent_id = v_agent.id and x.state = 'active') then
							-- A browser grant names its browser profile and office; the company's are its office accesses'.
							update public.qorpera_runtime_browser_grants set state = 'revoked', version = version + 1 where id = any(v_browsers);
							update public.qorpera_runtime_office_access set state = 'revoked', version = version + 1
							where staff_agent_id = v_agent.id and office_id = any(v_offices);
						else
							v_office_left := true;
						end if;
					end loop;
					if not v_office_left then
						update public.qorpera_folder_erasures set agents = agents || '{"officeDone":true}'::jsonb where id = v_erasure.id;
					end if;
				end if;
				v_from := (v_erasure.agents ->> 'opsFrom')::bigint;
				v_until := least(v_from + 5000, (v_erasure.agents ->> 'opsUntil')::bigint);
				for v_op in select o.sequence, o.operation_type, o.entity_id, o.entity_version, o.payload
					from public.qorpera_company_operations o
					where o.profile_id = v_erasure.profile_id and o.sequence > v_from and o.sequence <= v_until
						and ((o.operation_type = 'staff_state' and o.entity_id in (select (s #>> '{}')::uuid
								from jsonb_array_elements(v_erasure.agents -> 'staff') s))
							or (o.operation_type = 'session_state' and o.entity_id in (select (s ->> 'id')::uuid
								from jsonb_array_elements(v_erasure.agents -> 'sessions') s)))
					order by o.sequence
				loop
					v_bytes := v_bytes + octet_length(v_op.payload::text);
					v_payload := case when v_op.operation_type = 'staff_state'
						then v_op.payload || jsonb_build_object('display_name', 'Erased agent', 'role', 'Erased', 'charter', 'Erased.')
						else v_op.payload || jsonb_build_object('title', (select s ->> 'title'
							from jsonb_array_elements(v_erasure.agents -> 'sessions') s where (s ->> 'id')::uuid = v_op.entity_id)) end;
					if v_payload is distinct from v_op.payload then
						update public.qorpera_company_operations set payload = v_payload,
							content_sha256 = encode(extensions.digest(convert_to(jsonb_build_object('operation_type', v_op.operation_type,
								'entity_id', v_op.entity_id, 'entity_version', v_op.entity_version, 'payload', v_payload)::text, 'utf8'),
								'sha256'), 'hex')
						where profile_id = v_erasure.profile_id and sequence = v_op.sequence;
						v_ops := v_ops + 1;
					end if;
					if v_bytes > c_bytes or clock_timestamp() - v_started > c_budget then
						v_until := v_op.sequence;
						exit;
					end if;
				end loop;
				update public.qorpera_folder_erasures set
					agents = jsonb_set(agents, '{opsFrom}', to_jsonb(v_until)),
					phase = case when v_until >= (v_erasure.agents ->> 'opsUntil')::bigint and not v_office_left then 7 else 6 end,
					counts = jsonb_set(counts, '{operations}', to_jsonb(coalesce((counts ->> 'operations')::bigint, 0) + v_ops))
				where id = v_erasure.id;
			else
				update public.qorpera_folder_erasures set phase = 7 where id = v_erasure.id;
			end if;
		end if;

		select * into v_erasure from public.qorpera_folder_erasures where id = v_erasure.id;
		if v_erasure.phase = 7 and v_erasure.cursor = '{}'::jsonb and not exists (select 1 from public.qorpera_folder_erasure_runs
				where erasure_id = v_erasure.id and state <> 'done') then
			-- Done: the roots, the needles and the request digest go; the counts stay.
			delete from public.qorpera_folder_erasure_needles where erasure_id = v_erasure.id;
			delete from public.qorpera_folder_erasure_runs where erasure_id = v_erasure.id;
			update public.qorpera_folder_erasures set state = 'done', done_at = clock_timestamp(), revisit_at = null,
				roots = null, request_sha256 = null, cursor = '{}'::jsonb, agents = null, reply = reply - 'roots' - 'copies'
			where id = v_erasure.id;
		elsif v_erasure.cursor = '{}'::jsonb and ((v_erasure.phase = 7 and exists (select 1 from public.qorpera_folder_erasure_runs
				where erasure_id = v_erasure.id and state = 'pending')) or (v_erasure.phase = 5 and v_erasure.bytes_pending)
				or (v_erasure.phase = 6 and v_office_left and v_erasure.agents ->> 'opsFrom' = v_erasure.agents ->> 'opsUntil')) then
			-- Only pending runs, bytes GC does not take yet, or office grants in use are left: revisited once an hour, so it
			-- never holds up the others. Bytes GC does take keep it working.
			update public.qorpera_folder_erasures set state = 'waiting', revisit_at = clock_timestamp() + interval '1 hour'
			where id = v_erasure.id;
		end if;
		update public.qorpera_folder_erasures set last_error = null where id = v_erasure.id and last_error is not null;
	exception
		when lock_not_available then
			-- A row someone else holds: this step's work is undone, and the next tick goes on.
			return jsonb_build_object('schema', 'qorpera.folder-erasure-step/v1', 'erasureId', v_erasure.id, 'contended', true);
		when others then
			get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
			raise warning 'Folder erasure % failed (%): %; it waits an hour', v_erasure.id, v_state, v_message;
			update public.qorpera_folder_erasures set state = 'waiting', revisit_at = clock_timestamp() + interval '1 hour',
				last_error = left(v_state || ': ' || v_message, 1000)
			where id = v_erasure.id;
			return jsonb_build_object('schema', 'qorpera.folder-erasure-step/v1', 'erasureId', v_erasure.id, 'error', v_state);
	end;
	select * into v_erasure from public.qorpera_folder_erasures where id = v_erasure.id;
	return jsonb_build_object('schema', 'qorpera.folder-erasure-step/v1', 'erasureId', v_erasure.id, 'state', v_erasure.state,
		'phase', v_erasure.phase);
end $$;
