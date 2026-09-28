-- Company folder core, C1b-1: agents on the folder core (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md).
--
-- Inert for today's companies: everything here runs only for folder-v2 companies, which only an operator makes
-- (qorpera_folder_enable). snapshot-v1 tables, functions and lock text are unchanged; the shared resources table
-- gains one scope value and one expression index.
--
-- This slice:
-- * run actors in commit, read and list, with the folder-v2 run check in the core lock order (C1B §2);
-- * agent authority, ported from today's audience rule, and the rules/ base (C1B §3);
-- * the indexed folder resource resolver (C1B §3);
-- * operation keys per run, with a digest that leaves the lease binding out (C1B §4);
-- * attribution columns (C1B §5);
-- * folder review records and their enforcement (C1B §6);
-- * the two-phase folder pause (C1B §7);
-- * the structured-file hook's call sites and inert stubs, with F2's signatures (C1B §8).

-- 1. The indexed folder resource resolver ----------------------------------------------------------------

-- One index probe per path level: the key and each of its ancestors, against the resources' folder keys.
create index qorpera_company_path_resources_folder_key
	on public.qorpera_company_path_resources (environment_id, public.qorpera_folder_key(path));

-- As C1a's resolver (longest match; credentials and secrets never; a members/<id>/private path only under that
-- member's own private resource; a tie between two resources sharing one folder key covers nothing), but by an
-- index probe per level instead of a scan of the company's resources.
create or replace function public.qorpera_folder_path_resource(p_environment_id uuid, p_path text)
returns public.qorpera_company_path_resources language plpgsql stable security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_key text; v_prefixes text[];
begin
	if not public.qorpera_company_path_valid(p_path, true) then return null; end if;
	v_key := public.qorpera_folder_key(p_path);
	if split_part(v_key, '/', 1) in ('credentials','secrets') then return null; end if;
	v_prefixes := array[''] || public.qorpera_folder_ancestors(v_key) || case when v_key = '' then '{}'::text[] else array[v_key] end;
	select r.* into v_resource from public.qorpera_company_path_resources r
	where r.environment_id = p_environment_id and public.qorpera_folder_key(r.path) = any (v_prefixes)
		and (public.qorpera_folder_key(r.path) = v_key or r.path_match = 'subtree')
	order by length(public.qorpera_folder_key(r.path)) desc, r.id limit 1;
	if v_resource.id is not null and exists (select 1 from public.qorpera_company_path_resources r
		where r.environment_id = p_environment_id and r.id <> v_resource.id
			and public.qorpera_folder_key(r.path) = public.qorpera_folder_key(v_resource.path)) then
		return null; end if;
	if split_part(v_key, '/', 1) = 'members' and split_part(v_key, '/', 3) = 'private'
		and (v_resource.scope is distinct from 'member_private'
			or v_resource.owner_user_id::text is distinct from split_part(v_key, '/', 2)) then return null; end if;
	return v_resource;
end $$;

-- 2. The rules/ base ------------------------------------------------------------------------------------

-- rules/ is written by owners and admins only (founder decision 2026-09-27); every member and every active agent
-- reads it. A folder-v2 scope that snapshot-v1 never uses.
alter table public.qorpera_company_path_resources drop constraint qorpera_company_path_resources_scope_check;
alter table public.qorpera_company_path_resources add constraint qorpera_company_path_resources_scope_check
	check (scope = any (array['company_shared','member_private','responsibility_scoped','project_scoped','company_rules']));

-- The shared principal check, plus the company_rules scope.
create function public.qorpera_folder_principal_allowed(p_profile_id uuid, p_resource public.qorpera_company_path_resources,
	p_kind text, p_id uuid, p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	if p_resource.id is null or p_resource.revoked_at is not null or p_permission is null or p_permission not in ('read','write') then
		return false; end if;
	if p_resource.scope = 'company_rules' then
		if p_kind = 'member' then
			return exists (select 1 from public.qorpera_profile_members m where m.profile_id = p_profile_id and m.user_id = p_id
				and (p_permission = 'read' or m.role in ('owner','admin')));
		elsif p_kind = 'staff_agent' then
			return p_permission = 'read' and exists (select 1 from public.qorpera_profile_staff s
				where s.profile_id = p_profile_id and s.staff_agent_id = p_id and s.employment_status = 'active');
		end if;
		return false;
	end if;
	return public.qorpera_company_path_principal_allowed(p_profile_id, p_resource, p_kind, p_id, p_permission);
end $$;

create or replace function public.qorpera_folder_member_allowed(p_environment_id uuid, p_profile_id uuid, p_user_id uuid,
	p_path text, p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype;
begin
	v_resource := public.qorpera_folder_path_resource(p_environment_id, p_path);
	if v_resource.id is null then return false; end if;
	return public.qorpera_folder_principal_allowed(p_profile_id, v_resource, 'member', p_user_id, p_permission);
end $$;

-- Enabling now also seeds the rules/ resource.
create or replace function public.qorpera_folder_enable(p_environment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2') then
		return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',false);
	end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	if not found then raise exception 'Company File is unavailable' using errcode = '42501'; end if;
	if v_file.core = 'folder-v2' then
		return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',false);
	end if;
	if v_file.state <> 'provisioning' or v_file.head_snapshot_id is not null or v_file.path_gateway_version is not null
		or exists (select 1 from public.qorpera_company_snapshots where environment_id = p_environment_id) then
		raise exception 'Only an untouched company can use the folder core' using errcode = '55000'; end if;
	perform set_config('qorpera.folder_enable', 'on', true);
	update public.qorpera_company_files set core = 'folder-v2', state = 'ready', updated_at = statement_timestamp()
	where environment_id = p_environment_id;
	perform set_config('qorpera.folder_enable', '', true);
	insert into public.qorpera_folder_clocks(environment_id) values (p_environment_id);
	insert into public.qorpera_folder_fences(profile_id) values (v_file.profile_id) on conflict (profile_id) do nothing;
	insert into public.qorpera_folder_admissions(profile_id) values (v_file.profile_id) on conflict (profile_id) do nothing;
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	values (p_environment_id, '', 'subtree', 'company_shared', 'normal', v_file.created_by_user_id),
		(p_environment_id, 'rules', 'subtree', 'company_rules', 'normal', v_file.created_by_user_id)
	on conflict (environment_id, path_key_sha256) do nothing;
	return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',true);
end $$;

-- Companies enabled before C1b get the rules/ resource too.
insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
select f.environment_id, 'rules', 'subtree', 'company_rules', 'normal', f.created_by_user_id
from public.qorpera_company_files f where f.core = 'folder-v2'
on conflict (environment_id, path_key_sha256) do nothing;

-- 3. Operation keys per run ------------------------------------------------------------------------------

-- A run's receipts are its own: its keys are scoped to the run, and members and the platform share the nil scope.
-- The request digest leaves the lease binding out (see the commit), so a replay after a lease re-claim matches.
alter table public.qorpera_folder_operation_keys
	add column scope_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table public.qorpera_folder_operation_keys drop constraint qorpera_folder_operation_keys_pkey;
alter table public.qorpera_folder_operation_keys add primary key (environment_id, scope_id, operation_key);

-- 4. Attribution -------------------------------------------------------------------------------------------

alter table public.qorpera_folder_commits
	add column session_kind text check (session_kind in ('in_house','coding')),
	add column routine_id uuid,
	add column routine_version bigint,
	add column review_id uuid,
	add column sponsor_binding_id uuid,
	add column sponsor_version bigint,
	add constraint qorpera_folder_commits_run_attribution check (
		(actor_kind = 'staff_agent') = (run_id is not null)
		and (actor_kind = 'staff_agent') = (session_kind is not null)
		and (routine_id is null) = (routine_version is null));

-- 5. The structured-file hook (F2, RUNTIME-COMPANY-STATE-FILES.md §7; signatures agreed on #408) ------------
--
-- Inert stubs, except the lock: it really locks the targets it is given, in (rank, table, key) order and in each
-- target's mode, for the tables the run check needs. The commit passes its own staff, room and routine rows
-- through it, so each table is locked in one key order. F2's version keeps locking every target it is passed.

create function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language sql stable set search_path = '' as $$
	select null::smallint, null::text, null::text, null::text where false
$$;

-- Lock modes by name; the clause comes from this closed list, never from input.
create function public.qorpera_folder_lock_clause(p_mode text)
returns text language sql immutable set search_path = '' as $$
	select case p_mode when 'keyshare' then ' for key share' when 'share' then ' for share'
		when 'nokeyupdate' then ' for no key update' when 'update' then ' for update' end
$$;

create function public.qorpera_folder_structured_lock(p_environment_id uuid, p_targets jsonb, p_from_rank smallint, p_to_rank smallint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_target record; v_clause text; v_count bigint;
begin
	-- Rows merge by (table, key) and the strongest mode wins, so no row is locked twice or upgraded. Within a
	-- rank, tables go in a fixed order (rooms before room members), then rows in key order.
	for v_target in
		select min((t ->> 'rank')::smallint) as rank, t ->> 'tbl' as tbl, lower(t ->> 'key') as key,
			max(array_position(array['keyshare','share','nokeyupdate','update'], t ->> 'mode')) as strength,
			bool_or(coalesce((t ->> 'required')::boolean, false)) as required
		from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) t
		group by 2, 3
		having min((t ->> 'rank')::smallint) between p_from_rank and p_to_rank
		order by 1, array_position(array['qorpera_profile_staff','qorpera_company_rooms','qorpera_company_room_members',
			'qorpera_cloud_routines'], t ->> 'tbl'), lower(t ->> 'key') collate "C"
	loop
		v_clause := public.qorpera_folder_lock_clause((array['keyshare','share','nokeyupdate','update'])[v_target.strength]);
		if v_clause is null then raise exception 'Folder lock mode is unknown' using errcode = 'XX000'; end if;
		if v_target.tbl = 'qorpera_profile_staff' then
			-- key: 'profile_id:staff_agent_id'.
			execute 'select 1 from public.qorpera_profile_staff where profile_id = $1 and staff_agent_id = $2' || v_clause
			using split_part(v_target.key, ':', 1)::uuid, split_part(v_target.key, ':', 2)::uuid;
		elsif v_target.tbl = 'qorpera_company_rooms' then
			execute 'select 1 from public.qorpera_company_rooms where id = $1' || v_clause using v_target.key::uuid;
		elsif v_target.tbl = 'qorpera_company_room_members' then
			-- key: 'room_id:principal_kind:principal_id'.
			execute 'select 1 from public.qorpera_company_room_members where room_id = $1 and principal_kind = $2 and principal_id = $3'
				|| v_clause using split_part(v_target.key, ':', 1)::uuid, split_part(v_target.key, ':', 2), split_part(v_target.key, ':', 3)::uuid;
		elsif v_target.tbl = 'qorpera_cloud_routines' then
			execute 'select 1 from public.qorpera_cloud_routines where id = $1' || v_clause using v_target.key::uuid;
		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';
		end if;
		get diagnostics v_count = row_count;
		if v_count = 0 and v_target.required then
			raise exception 'A row this change set relies on is unavailable' using errcode = '42501'; end if;
	end loop;
end $$;

-- The commit's own ranks: 1 members (key 'profile_id:user_id'), 3 execution authorities ('profile_id:staff_agent_id'),
-- 6 resources (key: id; locked ancestors first, by folder key), 7 grants (key: id; this company's only). Rows merge by
-- (table, lowercase key) into their strongest mode; a row marked required must exist. A target of another table at
-- these ranks is a defect.
create function public.qorpera_folder_lock_commit_rank(p_environment_id uuid, p_targets jsonb, p_rank smallint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_target record; v_clause text; v_count bigint;
begin
	for v_target in
		select g.tbl, g.key, g.strength, g.required
		from (select t ->> 'tbl' as tbl, lower(t ->> 'key') as key,
				max(array_position(array['keyshare','share','nokeyupdate','update'], t ->> 'mode')) as strength,
				bool_or(coalesce((t ->> 'required')::boolean, false)) as required
			from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) t
			where (t ->> 'rank')::smallint = p_rank
			group by 1, 2) g
		left join lateral (select public.qorpera_folder_key(r.path) as folder_key from public.qorpera_company_path_resources r
			where r.id = case when g.tbl = 'qorpera_company_path_resources' then g.key::uuid end) res on true
		order by g.tbl, res.folder_key collate "C", g.key collate "C"
	loop
		v_clause := public.qorpera_folder_lock_clause((array['keyshare','share','nokeyupdate','update'])[v_target.strength]);
		if v_clause is null then raise exception 'Folder lock mode is unknown' using errcode = 'XX000'; end if;
		if p_rank = 1 and v_target.tbl = 'qorpera_profile_members' then
			execute 'select 1 from public.qorpera_profile_members where profile_id = $1 and user_id = $2' || v_clause
			using split_part(v_target.key, ':', 1)::uuid, split_part(v_target.key, ':', 2)::uuid;
		elsif p_rank = 3 and v_target.tbl = 'qorpera_staff_execution_authorities' then
			execute 'select 1 from public.qorpera_staff_execution_authorities where profile_id = $1 and staff_agent_id = $2' || v_clause
			using split_part(v_target.key, ':', 1)::uuid, split_part(v_target.key, ':', 2)::uuid;
		elsif p_rank = 6 and v_target.tbl = 'qorpera_company_path_resources' then
			execute 'select 1 from public.qorpera_company_path_resources where id = $1 and environment_id = $2' || v_clause
			using v_target.key::uuid, p_environment_id;
		elsif p_rank = 7 and v_target.tbl = 'qorpera_company_path_grants' then
			execute 'select 1 from public.qorpera_company_path_grants g join public.qorpera_company_path_resources r on r.id = g.resource_id
				where g.id = $1 and r.environment_id = $2' || v_clause || ' of g' using v_target.key::uuid, p_environment_id;
		else
			raise exception 'Folder lock target table % at rank % is unknown', v_target.tbl, p_rank using errcode = 'XX000';
		end if;
		get diagnostics v_count = row_count;
		if v_count = 0 and v_target.required then
			raise exception 'A row this change set relies on is unavailable' using errcode = '42501'; end if;
	end loop;
end $$;

create function public.qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language sql stable set search_path = '' as $$ select '{"ok":true}'::jsonb $$;

create function public.qorpera_folder_structured_review_class(p_environment_id uuid, p_actor jsonb, p_unit jsonb,
	p_eff_path text, p_eff_to text)
returns text language sql stable set search_path = '' as $$ select 'plain'::text $$;

create function public.qorpera_folder_structured_apply(p_environment_id uuid, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns void language sql set search_path = '' as $$ select $$;

create function public.qorpera_folder_structured_verify(p_environment_id uuid, p_commit_id uuid)
returns void language sql set search_path = '' as $$ select $$;

-- 6. Folder review records (C1B §6) ------------------------------------------------------------------------

-- One row per reviewed change set of a run. Recording them (with the kernel's layering, cards, member answers
-- and parked proposals) is C2; C1b-1 has the table and the commit's enforcement.
create table public.qorpera_folder_reviews (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	run_id uuid not null,
	change_set_sha256 text not null check (change_set_sha256 ~ '^[0-9a-f]{64}$'),
	units integer[] not null check (cardinality(units) between 1 and 1000),
	decision text not null check (decision in ('allow','ask','deny')),
	answer text check (answer in ('allow','deny')),
	answered_by_user_id uuid,
	answered_at timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	check ((answer is null) = (answered_at is null) and (answer is null) = (answered_by_user_id is null)),
	check (answer is null or decision = 'ask')
);
create index qorpera_folder_reviews_run on public.qorpera_folder_reviews(run_id);
alter table public.qorpera_folder_reviews enable row level security;
revoke all on public.qorpera_folder_reviews from public, anon, authenticated, service_role;

-- The digest a review binds: the canonical units, without any actor binding. jsonb's text form is canonical.
create function public.qorpera_folder_change_set_sha256(p_units jsonb)
returns text language sql immutable set search_path = '' as $$
	select encode(extensions.digest(convert_to(p_units::text, 'utf8'), 'sha256'), 'hex')
$$;

-- 7. The folder pause (C1B §7) --------------------------------------------------------------------------------

-- Phase 1: commit the pause. New effects refuse at their first plain read of it, before any lock.
create function public.qorpera_folder_pause(p_profile_id uuid, p_paused_by_user_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if not exists (select 1 from public.qorpera_company_files where profile_id = p_profile_id and core = 'folder-v2') then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values (p_profile_id, p_paused_by_user_id, p_reason)
	on conflict (profile_id) do nothing;
	return jsonb_build_object('schema','qorpera.folder-pause/v1','profileId',p_profile_id,'phase','paused');
end $$;

-- Phase 2, its own transaction: the fence FOR UPDATE waits out the effects already past their first pause read.
-- A plain UPDATE would take only FOR NO KEY UPDATE, which does not conflict with the effects' KEY SHARE. An effect
-- that takes the fence meanwhile re-reads the pause after its lock and refuses, so the wait is bounded.
create function public.qorpera_folder_pause_drain(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_revision bigint;
begin
	if not exists (select 1 from public.qorpera_company_execution_pauses where profile_id = p_profile_id) then
		raise exception 'The company is not paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for update;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	update public.qorpera_folder_fences set revision = revision + 1 where profile_id = p_profile_id returning revision into v_revision;
	return jsonb_build_object('schema','qorpera.folder-pause/v1','profileId',p_profile_id,'phase','drained','fenceRevision',v_revision);
end $$;

create function public.qorpera_folder_resume(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_revision bigint;
begin
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for update;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	delete from public.qorpera_company_execution_pauses where profile_id = p_profile_id;
	update public.qorpera_folder_fences set revision = revision + 1 where profile_id = p_profile_id returning revision into v_revision;
	return jsonb_build_object('schema','qorpera.folder-pause/v1','profileId',p_profile_id,'phase','resumed','fenceRevision',v_revision);
end $$;

-- 8. Agent authority (C1B §3) -----------------------------------------------------------------------------------

-- agents/ and rules/, and everything below them: read-only to a coding session (contract 5.6).
create function public.qorpera_folder_coding_protected(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	select p_key in ('agents','rules') or p_key like 'agents/%' or p_key like 'rules/%'
$$;

-- An actor's permission on one resolved resource. A member as C1a (through the wrapper, so owners and admins
-- write rules/). A run's agent, ported from qorpera_company_path_allowed (20260828019850:77-95): the requester is
-- allowed, and by audience the agent is too; a read-access worker writes nothing (20260922170000:180-199). The
-- coding rule is path-based and checked by the callers below.
create function public.qorpera_folder_actor_resource_allowed(p_profile_id uuid, p_actor jsonb,
	p_resource public.qorpera_company_path_resources, p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_requester uuid; v_staff uuid;
begin
	if p_resource.id is null then return false; end if;
	if p_actor ->> 'kind' = 'platform' then return true; end if;
	if p_actor ->> 'kind' = 'member' then
		return public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'member', (p_actor ->> 'userId')::uuid, p_permission);
	end if;
	if p_actor ->> 'kind' is distinct from 'staff_agent' then return false; end if;
	-- An in-house worker with read access writes nothing. A coding worker's access is always 'read' (dispatch forces
	-- it, 20260922230000:376-378); there it names the dispatch's sources, not folder writes.
	if p_permission = 'write' and p_actor ->> 'sessionKind' = 'in_house' and p_actor ->> 'workerAccess' = 'read' then
		return false; end if;
	v_requester := (p_actor ->> 'requesterUserId')::uuid; v_staff := (p_actor ->> 'staffAgentId')::uuid;
	if not public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'member', v_requester, p_permission) then
		return false; end if;
	if p_actor -> 'audience' ->> 'kind' = 'company' then
		return p_resource.scope <> 'member_private'
			and public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'staff_agent', v_staff, p_permission);
	elsif p_actor -> 'audience' ->> 'kind' = 'member_private' then
		return (p_actor -> 'audience' ->> 'userId')::uuid is not distinct from v_requester
			and (p_resource.scope <> 'member_private' or p_resource.owner_user_id = v_requester)
			and public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'staff_agent', v_staff, p_permission);
	end if;
	return false;
end $$;

-- An actor's permission on one path.
create function public.qorpera_folder_actor_allowed(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_path text, p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	if p_permission = 'write' and p_actor ->> 'sessionKind' = 'coding'
		and public.qorpera_folder_coding_protected(public.qorpera_folder_key(p_path)) then return false; end if;
	return public.qorpera_folder_actor_resource_allowed(p_profile_id, p_actor,
		public.qorpera_folder_path_resource(p_environment_id, p_path), p_permission);
end $$;

-- An actor's permission on a root path and the keys below it: C1a's boundaries (the root's own resource; the
-- nearest subtree resource at or above it; narrower resources inside that cover a key; implicit
-- members/<id>/private folders), each checked once, for every principal the actor carries. The coding rule is
-- checked on the root and on every key.
create function public.qorpera_folder_actor_keys_allowed(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_root_path text, p_keys text[], p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_root_key text := public.qorpera_folder_key(p_root_path);
begin
	if not public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, p_root_path, p_permission) then
		return false; end if;
	if cardinality(p_keys) = 0 then return true; end if;
	if p_permission = 'write' and p_actor ->> 'sessionKind' = 'coding'
		and exists (select 1 from unnest(p_keys) k(key) where public.qorpera_folder_coding_protected(k.key)) then return false; end if;
	return not exists (
		with res as materialized (
			select r.path_match, public.qorpera_folder_key(r.path) as key from public.qorpera_company_path_resources r
			where r.environment_id = p_environment_id
		), inside as materialized (
			select res.path_match, res.key from res where res.key like public.qorpera_folder_under(v_root_key)
		), boundaries as (
			(select res.key from res
			where res.path_match = 'subtree' and (res.key = '' or res.key = v_root_key or left(v_root_key, length(res.key) + 1) = res.key || '/')
			order by length(res.key) desc limit 1)
			union
			select i.key from inside i
			where exists (select 1 from unnest(p_keys) k(key) where k.key = i.key
				or (i.path_match = 'subtree' and k.key like public.qorpera_folder_under(i.key)))
			union
			select distinct substring(k.key from '^(members/[^/]+/private)(?:/|$)') from unnest(p_keys) k(key)
			where k.key like 'members/%/private' or k.key like 'members/%/private/%'
		)
		select 1 from boundaries b
		where b.key is not null
			and not public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, b.key, p_permission));
end $$;

-- A whole subtree, mapped from p_from_key onto p_to_path (p_to_path = the subtree's own path when nothing moves).
create function public.qorpera_folder_actor_subtree_allowed(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_from_key text, p_to_path text, p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_folder_actor_keys_allowed(p_environment_id, p_profile_id, p_actor, p_to_path,
		array(select public.qorpera_folder_key(p_to_path) || substr(e.key_text, char_length(p_from_key) + 1)
			from public.qorpera_folder_entries e
			where e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(p_from_key)),
		p_permission)
$$;

-- C1a's member helpers now go through the actor functions, and so through the rules/ wrapper.
create or replace function public.qorpera_folder_member_keys_allowed(p_environment_id uuid, p_profile_id uuid, p_user_id uuid,
	p_root_path text, p_keys text[], p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_folder_actor_keys_allowed(p_environment_id, p_profile_id,
		jsonb_build_object('kind','member','userId',p_user_id), p_root_path, p_keys, p_permission)
$$;
create or replace function public.qorpera_folder_member_subtree_allowed(p_environment_id uuid, p_profile_id uuid, p_user_id uuid,
	p_from_key text, p_to_path text, p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_folder_actor_subtree_allowed(p_environment_id, p_profile_id,
		jsonb_build_object('kind','member','userId',p_user_id), p_from_key, p_to_path, p_permission)
$$;

-- 9. The run check (C1B §2) -------------------------------------------------------------------------------------

-- qorpera_wake_authorized (20260920030500:29 and its patches) for the wake kinds C1b-1 accepts (human, first-run,
-- routine from a schedule, room), without its locks: it took the per-kind row FOR SHARE NOWAIT before members and
-- staff. The commit takes those rows FOR KEY SHARE at their ranks instead. Plain reads only. The worker-completion
-- session variant (20260922170000:277-280) comes with agent wakes in C1b-2.
create function public.qorpera_folder_wake_authorized(p_wake public.qorpera_wake_occurrences)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_ancestry jsonb; v_standing_version bigint := public.qorpera_wake_standing_sponsor_version(p_wake);
begin
	if v_standing_version is null or p_wake.wake_kind not in ('human','first-run','routine','room')
		or p_wake.source_kind = 'company-file' then return false; end if;
	if p_wake.wake_schema <> 'qorpera.wake-envelope/v1'
		or (p_wake.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
			where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id))
		or not exists(select 1 from public.qorpera_profile_members where profile_id = p_wake.profile_id
			and user_id = p_wake.requested_by_user_id)
		or not exists(select 1 from public.qorpera_profile_staff where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and version >= p_wake.staff_version and employment_status = 'active')
		or (p_wake.session_id is not null and not exists(select 1 from public.qorpera_shared_sessions
			where id = p_wake.session_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id
				and (staff_agent_id = p_wake.staff_agent_id::text or (p_wake.wake_kind = 'room' and staff_agent_id is null
					and execution_scope ->> 'roomId' is not null)) and status = 'open'
				and (p_wake.wake_kind <> 'routine' or (staff_version <= p_wake.staff_version and not
					(coalesce(execution_scope ->> 'agentThread','') <> 'true'
						and execution_scope ?| array['autonomousLabel','roomId','group','parentSession']))))) then return false; end if;
	if p_wake.wake_kind = 'routine' and p_wake.session_id is null and not exists(
		select 1 from public.qorpera_cloud_routine_versions v, lateral jsonb_array_elements(v.triggers) t(value)
		where v.routine_id = p_wake.routine_id and v.version = p_wake.routine_version
			and t.value ->> 'id' = p_wake.trigger_id and public.qorpera_cloud_routine_trigger_valid(t.value)
			and t.value ->> 'replyPolicy' in ('optional','silent')) then return false; end if;
	if p_wake.wake_kind = 'routine' and not exists(
		select 1 from public.qorpera_cloud_routines r join public.qorpera_cloud_routine_versions v
			on v.routine_id = r.id and (v.version = r.current_version or (public.qorpera_wake_run_live(p_wake.run_id)
				and exists (select 1 from public.qorpera_cloud_routine_versions cur where cur.routine_id = r.id
					and cur.version = r.current_version and cur.staff_agent_id = v.staff_agent_id)))
		where r.id = p_wake.routine_id and (r.status = 'active' or (r.status = 'expired' and r.expired_while_active)
			or (r.status = 'concluded' and r.concluded_by_run_id = p_wake.run_id))
			and v.version = p_wake.routine_version
			and v.created_by_user_id = p_wake.requested_by_user_id and v.staff_agent_id = p_wake.staff_agent_id
			and v.sponsor_binding_id = p_wake.sponsor_binding_id and v.sponsor_version = v_standing_version) then return false; end if;
	if p_wake.wake_kind = 'room' and (p_wake.source_kind <> 'room' or p_wake.session_id is null or not exists (
		select 1 from public.qorpera_company_rooms room
		join public.qorpera_company_room_members agent on agent.room_id = room.id and agent.principal_kind = 'staff_agent'
			and agent.principal_id = p_wake.staff_agent_id and agent.status = 'active'
		join public.qorpera_company_room_members poster on poster.room_id = room.id and poster.principal_kind = 'member'
			and poster.principal_id = p_wake.requested_by_user_id and poster.status = 'active'
		join public.qorpera_session_inputs input on input.id = p_wake.source_id and input.session_id = room.session_id
		where room.session_id = p_wake.session_id and room.profile_id = p_wake.profile_id and room.status = 'active')) then
		return false; end if;
	v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id, null, p_wake.staff_agent_id, coalesce(p_wake.file_event_id, p_wake.id));
	return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
		and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids), false);
end $$;

-- Resolves a run actor with plain reads: the commit takes the job and the fence before calling it, and the rows it
-- returns as lockTargets after it; read and list call it with no locks at all. Raises 42501 for a run that may not
-- act, and 0A000 for a wake kind that arrives with C1b-2. Returns the resolved actor of C1B §1, plus lockTargets
-- (ranks 2, 4 and 5) and attribution.
create function public.qorpera_folder_run_resolve(p_environment_id uuid, p_profile_id uuid, p_actor jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_staff public.qorpera_profile_staff%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_room uuid; v_connection uuid;
	v_targets jsonb := '[]'::jsonb; v_session_kind text := 'in_house';
begin
	select * into v_job from public.qorpera_runner_jobs
	where id = (p_actor ->> 'jobId')::uuid and run_id = (p_actor ->> 'runId')::uuid;
	if not found or v_job.environment_id <> p_environment_id or v_job.status <> 'leased'
		or v_job.runner_id is distinct from (p_actor ->> 'runnerId')::uuid
		or v_job.client_lease_id is distinct from (p_actor ->> 'assignmentId')::uuid
		or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
		raise exception 'Run is unavailable' using errcode = '42501'; end if;
	select * into v_run from public.qorpera_execution_runs where id = v_job.run_id;
	if not found or v_run.environment_id <> p_environment_id or v_run.profile_id <> p_profile_id or v_run.job_id <> v_job.id
		or v_run.job_type <> 'agent_turn' or v_run.source_kind not in ('session_turn','wake','room_delivery')
		or v_run.deadline_at <= clock_timestamp() or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'Run is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_run.requested_by_user_id) then
		raise exception 'Run requester is unavailable' using errcode = '42501'; end if;
	select * into v_staff from public.qorpera_profile_staff where profile_id = p_profile_id and staff_agent_id = v_run.staff_agent_id;
	if not found or v_staff.employment_status <> 'active' or v_staff.version < v_run.staff_version then
		raise exception 'Run agent is unavailable' using errcode = '42501'; end if;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	if not found then raise exception 'Run wake is unavailable' using errcode = '42501'; end if;
	if v_wake.wake_kind = 'agent' or v_wake.source_kind = 'company-file' then
		raise exception 'Folder writes by this kind of run arrive with C1b-2' using errcode = '0A000'; end if;
	if v_wake.staff_agent_id is distinct from v_run.staff_agent_id or not public.qorpera_folder_wake_authorized(v_wake)
		or public.qorpera_runtime_wake_policy_internal(v_run.id) ->> 'kind' is distinct from v_wake.wake_kind then
		raise exception 'Admitted wake authority is unavailable' using errcode = '42501'; end if;
	-- The run's session and inputs are still the ones it was admitted for (today's actor, 20260920030500:384-401).
	if v_run.session_id is not null and not exists (select 1 from public.qorpera_shared_sessions session
		where session.id = v_run.session_id and session.audience_kind = v_run.audience_kind
			and session.audience_user_id is not distinct from v_run.audience_user_id) then
		raise exception 'Run session is unavailable' using errcode = '42501'; end if;
	if cardinality(v_run.input_ids) > 0 and exists (select 1 from unnest(v_run.input_ids) i(id)
		where not exists (select 1 from public.qorpera_session_inputs input where input.id = i.id and input.session_id = v_run.session_id
			and input.execution_run_id = v_run.id and input.author_user_id = v_run.requested_by_user_id
			and input.runtime_bundle_id = v_run.runtime_bundle_id and input.runtime_bundle_sha256 = v_run.runtime_bundle_sha256)) then
		raise exception 'Run inputs are unavailable' using errcode = '42501'; end if;
	v_worker := public.qorpera_run_worker(v_run.id);
	if v_worker.id is not null and v_worker.species = 'coding' then v_session_kind := 'coding'; end if;
	select provider_connection_id into v_connection from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;

	v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
		'key', p_profile_id::text || ':' || v_run.staff_agent_id::text, 'mode', 'keyshare', 'required', true));
	if v_wake.wake_kind = 'routine' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines',
			'key', v_wake.routine_id::text, 'mode', 'keyshare', 'required', true));
	elsif v_wake.wake_kind = 'room' then
		select id into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id;
		v_targets := v_targets || jsonb_build_array(
			jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', v_room::text, 'mode', 'keyshare', 'required', true),
			jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members',
				'key', v_room::text || ':member:' || v_run.requested_by_user_id::text, 'mode', 'keyshare', 'required', true),
			jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members',
				'key', v_room::text || ':staff_agent:' || v_run.staff_agent_id::text, 'mode', 'keyshare', 'required', true));
	end if;

	return jsonb_build_object('kind', 'staff_agent', 'staffAgentId', v_run.staff_agent_id, 'staffVersion', v_staff.version,
		'runId', v_run.id, 'jobId', v_job.id, 'requesterUserId', v_run.requested_by_user_id,
		'audience', jsonb_build_object('kind', v_run.audience_kind, 'userId', v_run.audience_user_id),
		'sessionKind', v_session_kind, 'workerAccess', v_worker.access, 'causalWakeId', v_wake.id, 'wakeKind', v_wake.wake_kind,
		'routineId', v_wake.routine_id, 'routineVersion', v_wake.routine_version,
		'lockTargets', v_targets,
		'attribution', jsonb_build_object('sponsorBindingId', v_run.sponsor_binding_id, 'sponsorVersion', v_run.sponsor_version,
			'providerConnectionId', v_connection, 'runtimeBundleId', v_run.runtime_bundle_id));
end $$;

-- 10. The change-set commit, with run actors (C1B §2, §6, §8) ------------------------------------------------------

-- C1a's commit, plus: run actors (the job and the fence taken first, then the run's principals and wake at their
-- ranks); replays answered before the pause check; one merged lock list through the structured-file hook; the
-- review at rank 7b and its enforcement; the hook's decide, apply and verify; attribution. Every C1a rule stands.
drop function public.qorpera_folder_commit(uuid, jsonb, text, jsonb);
create function public.qorpera_folder_commit(p_environment_id uuid, p_actor jsonb, p_operation_key text, p_units jsonb,
	p_review_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype;
	v_actor_kind text; v_actor_id uuid; v_role public.qorpera_profile_role;
	c_nil constant uuid := '00000000-0000-0000-0000-000000000000';
	v_scope uuid := c_nil; v_digest_actor jsonb; v_resolved jsonb; v_auth_actor jsonb; v_hook_actor jsonb;
	v_fence_revision bigint; v_targets jsonb := '[]'::jsonb; v_review public.qorpera_folder_reviews%rowtype;
	v_class text; v_dec jsonb; v_problems jsonb; v_approver uuid; v_used_review uuid; v_change_set_sha text;
	v_attr jsonb := '{}'::jsonb;
	v_request_sha text; v_commit_id uuid := extensions.gen_random_uuid(); v_existing record;
	v_unit jsonb; v_no integer; v_op text; v_path text; v_to text; v_key text; v_to_key text; v_parent text;
	v_row public.qorpera_folder_entries%rowtype; v_target public.qorpera_folder_entries%rowtype;
	v_parent_row public.qorpera_folder_entries%rowtype;
	v_outcomes jsonb := '[]'::jsonb; v_saved integer := 0; v_seq bigint; v_version uuid;
	v_file_json jsonb; v_as_of bigint; v_ancestor text;
	v_ok boolean; v_reason text; v_eff_path text; v_eff_to text;
	v_locks jsonb := '{}'::jsonb; v_claims text[] := '{}'; v_lock record; v_invalid boolean;
	c_subtree_bound constant integer := 50000;
	-- key_text sits in two btree indexes, whose rows hold at most 2704 bytes: a longer key cannot be stored.
	c_key_bound constant integer := 2600;
	v_longest_path integer; v_longest_key integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder commits run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	v_actor_kind := p_actor ->> 'kind';
	if jsonb_typeof(p_actor) is distinct from 'object' or v_actor_kind is null then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if v_actor_kind = 'member' then
		if p_actor - array['kind','userId'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_actor_id := (p_actor ->> 'userId')::uuid;
	elsif v_actor_kind = 'platform' then
		if p_actor - array['kind'] <> '{}'::jsonb then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	elsif v_actor_kind = 'run' then
		if p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
			or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
				where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_scope := (p_actor ->> 'runId')::uuid;
	else
		raise exception 'Folder actor is invalid' using errcode = '22023';
	end if;
	-- Reviews bind a run's change set; members and the platform are never reviewed.
	if p_review_id is not null and v_actor_kind <> 'run' then
		raise exception 'Only a run carries a review' using errcode = '22023'; end if;
	if p_operation_key is null or p_operation_key !~ '^[A-Za-z0-9._:-]{8,200}$' then
		raise exception 'Operation key is invalid' using errcode = '22023'; end if;
	if jsonb_typeof(p_units) is distinct from 'array' or jsonb_array_length(p_units) not between 1 and 1000 then
		raise exception 'Change set is invalid' using errcode = '22023'; end if;

	-- The shape of each unit. Only malformed requests raise; everything else is an outcome.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop
		v_op := v_unit ->> 'op';
		if jsonb_typeof(v_unit) is distinct from 'object' or v_op is null
			or v_op not in ('write','mkdir','new_folder','delete','move','copy') then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		if v_path is null or not public.qorpera_company_path_valid(v_path)
			or (v_op in ('move','copy') and (v_to is null or not public.qorpera_company_path_valid(v_to)))
			or (v_op not in ('move','copy') and v_to is not null)
			or (v_op = 'write' and jsonb_typeof(v_unit -> 'file') is distinct from 'object')
			or (v_op = 'new_folder' and (jsonb_typeof(v_unit -> 'contents') is distinct from 'array'
				or jsonb_array_length(v_unit -> 'contents') > 10000
				or exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c
					where jsonb_typeof(c.value) is distinct from 'object' or c.value ->> 'path' is null
						or not public.qorpera_company_path_valid(v_path || '/' || (c.value ->> 'path'))))) then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
	end loop;

	-- The request digest leaves a run's lease binding out (C1B §4), so a replay after a lease re-claim matches. A
	-- review id is part of it: a retry with another review is another change set.
	v_digest_actor := case when v_actor_kind = 'run' then jsonb_build_object('kind','run','runId',p_actor ->> 'runId') else p_actor end;
	v_request_sha := encode(extensions.digest(convert_to((case when p_review_id is null then jsonb_build_array(v_digest_actor, p_units)
		else jsonb_build_array(v_digest_actor, p_units, p_review_id) end)::text, 'utf8'), 'sha256'), 'hex');

	-- Step 0. A replay is answered first, even while the company is paused. A key reused for a different change set
	-- is refused.
	select k.request_sha256, c.id, c.seq, c.units into v_existing
	from public.qorpera_folder_operation_keys k join public.qorpera_folder_commits c on c.id = k.commit_id
	where k.environment_id = p_environment_id and k.scope_id = v_scope and k.operation_key = p_operation_key;
	if found then
		if v_existing.request_sha256 is distinct from v_request_sha then
			raise exception 'Operation key was used for a different change set' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_existing.id,'seq',v_existing.seq,
			'replay',true,'units',v_existing.units);
	end if;
	-- Then the pause, for a run, before any lock: stop never queues behind new effects (C1B §7).
	if v_actor_kind = 'run' and exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_file.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;

	-- Step 1. The operation key. A concurrent claim that commits first makes this a replay.
	insert into public.qorpera_folder_operation_keys(environment_id, scope_id, operation_key, commit_id, request_sha256)
	values (p_environment_id, v_scope, p_operation_key, v_commit_id, v_request_sha) on conflict do nothing;
	if not found then
		select k.request_sha256, c.id, c.seq, c.units into v_existing
		from public.qorpera_folder_operation_keys k join public.qorpera_folder_commits c on c.id = k.commit_id
		where k.environment_id = p_environment_id and k.scope_id = v_scope and k.operation_key = p_operation_key;
		if v_existing.request_sha256 is distinct from v_request_sha then
			raise exception 'Operation key was used for a different change set' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_existing.id,'seq',v_existing.seq,
			'replay',true,'units',v_existing.units);
	end if;

	if v_actor_kind = 'run' then
		-- Step 2. The job FOR KEY SHARE: every change that ends its lease takes FOR UPDATE and so waits for this commit.
		perform 1 from public.qorpera_runner_jobs where id = (p_actor ->> 'jobId')::uuid and run_id = (p_actor ->> 'runId')::uuid
		for key share;
		if not found then raise exception 'Run is unavailable' using errcode = '42501'; end if;
		-- Step 3. The folder fence FOR KEY SHARE, then the pause again: an effect that read "not paused" and then
		-- waited behind a stop refuses.
		select revision into v_fence_revision from public.qorpera_folder_fences where profile_id = v_file.profile_id for key share;
		if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
		if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_file.profile_id) then
			raise exception 'Company execution is paused' using errcode = '55000'; end if;
		v_resolved := public.qorpera_folder_run_resolve(p_environment_id, v_file.profile_id, p_actor);
		v_actor_id := (v_resolved ->> 'staffAgentId')::uuid;
		v_attr := v_resolved -> 'attribution';
		v_targets := coalesce(v_resolved -> 'lockTargets', '[]'::jsonb);
		v_auth_actor := (v_resolved - 'lockTargets' - 'attribution') || jsonb_build_object('fenceRevision', v_fence_revision);
		v_hook_actor := v_auth_actor;
	elsif v_actor_kind = 'member' then
		v_auth_actor := p_actor; v_hook_actor := p_actor;
	else
		v_hook_actor := p_actor;
	end if;

	-- The lock set: each unit's targets and sources FOR UPDATE, and every ancestor of them FOR KEY SHARE. The
	-- stronger mode wins. A copy's source is held FOR UPDATE too, so its subtree cannot change between the
	-- checks and the copy (writers below it hold it KEY SHARE). A key past the bound is never claimed (it could
	-- not be stored); its unit is refused as too_long.
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		foreach v_ancestor in array public.qorpera_folder_ancestors(v_path) || coalesce(public.qorpera_folder_ancestors(v_to), '{}') loop
			v_key := public.qorpera_folder_key(v_ancestor);
			if octet_length(v_key) <= c_key_bound and not v_locks ? v_key then
				v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_ancestor, 'mode', 'keyshare'));
			end if;
		end loop;
		v_key := public.qorpera_folder_key(v_path);
		if octet_length(v_key) <= c_key_bound then
			v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_path, 'mode', 'update'));
		end if;
		v_key := public.qorpera_folder_key(v_to);
		if octet_length(v_key) <= c_key_bound then
			v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_to, 'mode', 'update'));
		end if;
	end loop;

	-- Step 4. One merged list of the rows to lock before the paths (C1B §8): the commit's own (the member actor or a
	-- run's requester at rank 1; a run's agent at 2 and its wake's room or routine at 4 or 5; the covering
	-- resources at 6) and the structured-file hook's targets, at any rank. Rows merge by (table, key), the stronger
	-- mode wins, and a row the commit relies on must exist. The commit locks ranks 1, 3, 6 and 7; the hook's lock
	-- takes 2, 4, 5, 8 and 9. Nothing is locked twice or upgraded.
	if v_actor_kind = 'member' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_file.profile_id::text || ':' || v_actor_id::text, 'mode', 'keyshare', 'required', true));
	elsif v_actor_kind = 'run' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_file.profile_id::text || ':' || (v_resolved ->> 'requesterUserId'), 'mode', 'keyshare', 'required', true));
	end if;
	v_targets := v_targets || coalesce((select jsonb_agg(jsonb_build_object('rank', 6, 'tbl', 'qorpera_company_path_resources',
			'key', s.resource_id::text, 'mode', 'share'))
		from (select distinct (public.qorpera_folder_path_resource(p_environment_id, l.value ->> 'path')).id as resource_id
			from jsonb_each(v_locks) l) s where s.resource_id is not null), '[]'::jsonb)
		|| coalesce((select jsonb_agg(to_jsonb(t))
			from public.qorpera_folder_structured_targets(p_environment_id, v_hook_actor, p_units) t), '[]'::jsonb);

	-- Every target names a rank 1-9, a table, a key and a known mode; anything else is a defect, never a silent skip.
	if exists (select 1 from jsonb_array_elements(v_targets) t
		where jsonb_typeof(t) <> 'object' or coalesce(t ->> 'rank', '') !~ '^[1-9]$' or t ->> 'tbl' is null or t ->> 'key' is null
			or coalesce(t ->> 'mode', '') not in ('keyshare','share','nokeyupdate','update')) then
		raise exception 'Folder lock targets are malformed' using errcode = 'XX000'; end if;
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 1::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 2::smallint, 2::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 3::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 4::smallint, 5::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 6::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 7::smallint);

	-- Rank 7b: the review, FOR SHARE, which an answer's FOR NO KEY UPDATE waits for (and the other way round).
	if p_review_id is not null then
		select * into v_review from public.qorpera_folder_reviews
		where id = p_review_id and environment_id = p_environment_id for share;
		if not found then v_review := null; end if;
	end if;
	v_change_set_sha := public.qorpera_folder_change_set_sha256(p_units);

	-- Ranks 8 and 9: vault rows and unique-key claims, the hook's.
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 8::smallint, 9::smallint);

	-- Step 5. Paths, in one increasing key order. Ancestors sort before descendants, so every transaction
	-- takes a parent before its children.
	for v_lock in select l.key collate "C" as key, l.value ->> 'path' as path, l.value ->> 'mode' as mode
		from jsonb_each(v_locks) l order by l.key collate "C" loop
		if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_lock.mode) then
			v_claims := v_claims || v_lock.key;
		end if;
	end loop;

	-- The commit row, before any unit is applied (units reference it); outcomes and seq are written at the end.
	insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id, requester_kind, requester_id,
		run_id, causal_wake_id, audience, session_kind, routine_id, routine_version, sponsor_binding_id, sponsor_version,
		provider_connection_id, runtime_bundle_id, units)
	values (v_commit_id, p_environment_id, p_operation_key,
		case when v_actor_kind = 'run' then 'staff_agent' else v_actor_kind end, v_actor_id,
		case when v_actor_kind = 'run' then 'member' else v_actor_kind end,
		case when v_actor_kind = 'run' then (v_resolved ->> 'requesterUserId')::uuid else v_actor_id end,
		(v_resolved ->> 'runId')::uuid, (v_resolved ->> 'causalWakeId')::uuid, v_resolved -> 'audience',
		v_resolved ->> 'sessionKind', (v_resolved ->> 'routineId')::uuid, (v_resolved ->> 'routineVersion')::bigint,
		(v_attr ->> 'sponsorBindingId')::uuid, (v_attr ->> 'sponsorVersion')::bigint,
		(v_attr ->> 'providerConnectionId')::uuid, (v_attr ->> 'runtimeBundleId')::uuid, '[]');

	-- Steps 7-8. Decide each unit from the locked rows, in order, and apply each clean one before the next is
	-- decided. Failures are outcomes, not exceptions.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop
		v_ok := true; v_reason := null; v_version := null; v_problems := null;
		v_op := v_unit ->> 'op';
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		v_key := public.qorpera_folder_key(v_path);
		v_to_key := case when v_to is not null then public.qorpera_folder_key(v_to) end;
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		if not found then v_row := null; end if;
		-- The path a new name takes: its existing parent's spelling plus its own name.
		v_parent := public.qorpera_folder_parent_path(coalesce(v_to, v_path));
		v_parent_row := null;
		if v_parent is not null then
			select * into v_parent_row from public.qorpera_folder_entries
			where environment_id = p_environment_id and kind = 'folder'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_parent), 'sha256');
			if not found then v_parent_row := null; end if;
		end if;
		v_eff_path := case when v_op in ('move','copy') then coalesce(v_row.path, v_path)
			when v_parent_row.path is not null then v_parent_row.path || '/' || regexp_replace(v_path, '^.*/', '')
			else v_path end;
		v_eff_to := case when v_to is null then null
			when v_parent_row.path is not null then v_parent_row.path || '/' || regexp_replace(v_to, '^.*/', '')
			else v_to end;

		-- A request key past the bound was never locked: refused before anything else is decided.
		if octet_length(v_key) > c_key_bound or octet_length(v_to_key) > c_key_bound then
			v_ok := false; v_reason := 'too_long';
		end if;

		-- Names the folder never holds, on every path the unit produces.
		if v_ok and (public.qorpera_folder_path_reserved(coalesce(v_to_key, v_key))
			or (v_op in ('move','copy') and exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.key_text like public.qorpera_folder_under(v_key)
					and public.qorpera_folder_path_reserved(v_to_key || substr(e.key_text, char_length(v_key) + 1))))
			or (v_op = 'new_folder' and exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c
				where public.qorpera_folder_path_reserved(public.qorpera_folder_key(v_path || '/' || (c.value ->> 'path')))))) then
			v_ok := false; v_reason := 'reserved';
		end if;

		-- Authority on every path the unit touches (a subtree's boundaries included): write on what changes,
		-- read on a copy's source. A member as C1a; a run's agent for its requester and audience (C1B §3).
		if v_ok and v_actor_kind in ('member','run') then
			if v_op in ('write','mkdir') then
				v_ok := public.qorpera_folder_actor_allowed(p_environment_id, v_file.profile_id, v_auth_actor, v_path, 'write');
			elsif v_op = 'new_folder' then
				v_ok := public.qorpera_folder_actor_keys_allowed(p_environment_id, v_file.profile_id, v_auth_actor, v_path,
					array(select public.qorpera_folder_key(v_path || '/' || (c.value ->> 'path'))
						from jsonb_array_elements(v_unit -> 'contents') c), 'write');
			elsif v_op = 'delete' then
				v_ok := public.qorpera_folder_actor_subtree_allowed(p_environment_id, v_file.profile_id, v_auth_actor,
					v_key, v_path, 'write');
			elsif v_op in ('move','copy') then
				v_ok := public.qorpera_folder_actor_subtree_allowed(p_environment_id, v_file.profile_id, v_auth_actor,
						v_key, v_path, case when v_op = 'copy' then 'read' else 'write' end)
					and public.qorpera_folder_actor_subtree_allowed(p_environment_id, v_file.profile_id, v_auth_actor,
						v_key, v_to, 'write');
			end if;
			if not v_ok then v_reason := 'denied'; end if;
		end if;

		if v_ok and v_op = 'write' then
			if v_unit ? 'expectedVersion' and v_unit -> 'expectedVersion' <> 'null'::jsonb then
				if v_row.kind is distinct from 'file' or v_row.version::text is distinct from v_unit ->> 'expectedVersion' then
					v_ok := false; v_reason := 'version_changed'; end if;
			elsif v_row.kind is not null then
				v_ok := false; v_reason := 'exists';
			end if;
		elsif v_ok and v_op = 'mkdir' then
			if v_row.kind is not null then v_ok := false; v_reason := 'exists'; end if;
		elsif v_ok and v_op = 'new_folder' then
			-- Contents: no duplicate keys, each parent a folder inside the unit, valid files, nothing already there.
			-- Keys are computed once and matched as sets (hash aggregate, EXCEPT), never per pair: the planner
			-- estimates jsonb_array_elements at 100 rows and would pick a nested loop for NOT EXISTS.
			with c as materialized (
				select value, value ->> 'kind' as kind, public.qorpera_folder_key(value ->> 'path') as key,
					public.qorpera_folder_key(public.qorpera_folder_parent_path(value ->> 'path')) as parent_key
				from jsonb_array_elements(v_unit -> 'contents')
			)
			select exists (select 1 from c group by key having count(*) > 1)
				or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file')
				or exists (select parent_key from c where parent_key is not null except select key from c where kind = 'folder')
				or exists (select 1 from c where kind = 'file'
					and (jsonb_typeof(value -> 'file') is distinct from 'object'
						or jsonb_typeof(value -> 'file' -> 'executable') is distinct from 'boolean'
						or coalesce(value -> 'file' ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
						or coalesce(value -> 'file' ->> 'bytes', '') !~ '^[0-9]{1,15}$'))
			into v_invalid;
			if v_row.kind is not null then v_ok := false; v_reason := 'exists';
			elsif v_invalid then
				v_ok := false; v_reason := 'invalid';
			elsif exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c where c.value ->> 'kind' = 'file'
				and not exists (select 1 from public.qorpera_verified_company_file_objects v
					where v.profile_id = v_file.profile_id and v.manifest_sha256 = c.value -> 'file' ->> 'manifestSha256'
						and v.file_sha256 = c.value -> 'file' ->> 'fileSha256'
						and v.bytes = (c.value -> 'file' ->> 'bytes')::bigint)) then
				v_ok := false; v_reason := 'bytes_unverified';
			elsif exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key)) then
				v_ok := false; v_reason := 'exists';
			end if;
		elsif v_ok and v_op in ('delete','move','copy') then
			if v_row.kind is null then
				v_ok := false; v_reason := 'missing';
			elsif (v_op <> 'copy' or v_unit ? 'expectedVersion') and v_row.version::text is distinct from v_unit ->> 'expectedVersion' then
				v_ok := false; v_reason := 'version_changed';
			elsif v_row.kind = 'folder' then
				-- A subtree delete or move refuses a change its writer did not see (core §3, units).
				v_as_of := case when v_unit ->> 'asOfSeq' ~ '^[0-9]{1,18}$' then (v_unit ->> 'asOfSeq')::bigint end;
				if v_op <> 'copy' and v_as_of is null then
					v_ok := false; v_reason := 'as_of_seq_required';
				elsif v_op <> 'copy' and exists (select 1 from public.qorpera_folder_entries e
					join public.qorpera_folder_commits c on c.id = e.commit_id
					where e.environment_id = p_environment_id and e.kind <> 'claim'
						and (e.key_sha256 = v_row.key_sha256 or e.key_text like public.qorpera_folder_under(v_key))
						and c.seq > v_as_of) then
					v_ok := false; v_reason := 'unseen_change';
				elsif (select count(*) from (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key) limit c_subtree_bound + 1) s) > c_subtree_bound then
					v_ok := false; v_reason := 'too_large';
				end if;
			end if;
		end if;
		if v_ok and v_to is not null then
			select * into v_target from public.qorpera_folder_entries
			where environment_id = p_environment_id and key_sha256 = extensions.digest(v_to_key, 'sha256') and kind <> 'claim';
			if found and (v_op = 'copy' or v_to_key <> v_key) then
				v_ok := false; v_reason := 'exists';
			elsif v_to_key like public.qorpera_folder_under(v_key) then
				v_ok := false; v_reason := 'into_itself';
			end if;
		end if;
		-- A missing parent is refused unless an earlier unit of this change set made it.
		if v_ok and v_op in ('write','mkdir','new_folder','move','copy') and v_parent is not null and v_parent_row.path is null then
			v_ok := false; v_reason := 'parent_missing';
		end if;
		-- Every path the unit produces stays within the path limit, spelled as it will be stored, and every key
		-- within the key bound. Descendants of a moved or copied folder carry their ancestors' stored bytes, and
		-- keys compose over '/', so the longest one below the source decides.
		v_longest_path := null; v_longest_key := null;
		if v_ok and v_op in ('move','copy') and v_row.kind = 'folder' then
			select max(octet_length(e.path)), max(octet_length(e.key_text)) into v_longest_path, v_longest_key
			from public.qorpera_folder_entries e
			where e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key);
		end if;
		if v_ok and (octet_length(coalesce(v_eff_to, v_eff_path)) > 4096
			or octet_length(v_eff_to) - octet_length(v_row.path) + v_longest_path > 4096
			or octet_length(v_to_key) - octet_length(v_key) + v_longest_key > c_key_bound
			or (v_op = 'new_folder' and exists (select 1 from public.qorpera_folder_spelled_contents(v_eff_path, v_unit -> 'contents') c
				where octet_length(c.path) > 4096 or octet_length(public.qorpera_folder_key(c.path)) > c_key_bound))) then
			v_ok := false; v_reason := 'too_long';
		end if;
		-- Bytes (step 6): a written file must be verified content of this company. Its manifest object is held
		-- KEY SHARE; the full reference invariants of core §8 arrive with C1d.
		if v_ok and v_op = 'write' then
			v_file_json := v_unit -> 'file';
			if jsonb_typeof(v_file_json -> 'executable') is distinct from 'boolean'
				or coalesce(v_file_json ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
				or coalesce(v_file_json ->> 'bytes', '') !~ '^[0-9]{1,15}$' then
				v_ok := false; v_reason := 'invalid';
			elsif not exists (select 1 from public.qorpera_verified_company_file_objects
				where profile_id = v_file.profile_id and manifest_sha256 = v_file_json ->> 'manifestSha256'
					and file_sha256 = v_file_json ->> 'fileSha256' and bytes = (v_file_json ->> 'bytes')::bigint) then
				v_ok := false; v_reason := 'bytes_unverified';
			else
				perform 1 from public.qorpera_profile_objects o where o.profile_id = v_file.profile_id
					and o.sha256 = v_file_json ->> 'manifestSha256' for key share;
				if not found then v_ok := false; v_reason := 'bytes_unverified'; end if;
			end if;
		end if;

		-- The structured-file hook's checks, after the generic ones (§5; a stub until C2).
		if v_ok then
			v_dec := public.qorpera_folder_structured_decide(p_environment_id, v_hook_actor, v_commit_id, v_no, v_unit, v_eff_path, v_eff_to);
			if coalesce((v_dec ->> 'ok')::boolean, false) is not true then
				v_ok := false; v_reason := coalesce(v_dec ->> 'reason', 'structured_invalid'); v_problems := v_dec -> 'problems';
			end if;
		end if;

		-- Review (C1B §6): an in-house run's delete or move is a deletion; any other unit takes the hook's class.
		-- Members, the platform and coding sessions are never reviewed.
		if v_ok and v_actor_kind = 'run' and v_auth_actor ->> 'sessionKind' = 'in_house' then
			v_class := case when v_op in ('delete','move') then 'deletion'
				else public.qorpera_folder_structured_review_class(p_environment_id, v_hook_actor, v_unit, v_eff_path, v_eff_to) end;
			if v_class is distinct from 'plain' then
				if v_review.id is null or v_review.run_id is distinct from (v_auth_actor ->> 'runId')::uuid
					or v_review.change_set_sha256 is distinct from v_change_set_sha or not (v_no = any (v_review.units)) then
					v_ok := false; v_reason := 'review_required';
				elsif v_review.decision = 'deny' or v_review.answer = 'deny' then
					v_ok := false; v_reason := 'review_denied';
				elsif v_review.decision = 'ask' and v_review.answer is null then
					v_ok := false; v_reason := 'waiting_for_review';
				else
					v_used_review := v_review.id;
					if v_review.answer = 'allow' then v_approver := v_review.answered_by_user_id; end if;
				end if;
			end if;
		end if;

		if v_ok then
			v_version := public.qorpera_folder_apply_unit(p_environment_id, v_commit_id, v_no, v_op, v_eff_path, v_eff_to, v_unit);
			perform public.qorpera_folder_structured_apply(p_environment_id, v_commit_id, v_no, v_unit, v_eff_path, v_eff_to);
			v_saved := v_saved + 1;
		end if;
		v_outcomes := v_outcomes || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('unit', v_no, 'op', v_op,
			'path', case when v_ok and v_op not in ('move','copy') then v_eff_path else v_path end,
			'to', case when v_ok then v_eff_to else v_to end, 'version', v_version,
			'outcome', case when v_ok then 'saved' when v_reason in ('denied','review_required','review_denied') then 'denied'
				when v_reason = 'waiting_for_review' then 'waiting_for_review'
				when v_reason in ('version_changed','exists','unseen_change','missing') then 'conflict' else 'refused' end,
			'reason', v_reason, 'problems', v_problems)));
	end loop;

	-- Claims that did not become live never outlive the transaction.
	delete from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.kind = 'claim'
		and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));

	if v_saved = 0 then
		update public.qorpera_folder_commits set units = v_outcomes where id = v_commit_id;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',null,'replay',false,
			'units',v_outcomes);
	end if;

	-- Step 9. The hook's check that every index row written points at its entry's current version.
	perform public.qorpera_folder_structured_verify(p_environment_id, v_commit_id);

	-- Step 11. The clock, last. Sequence order is commit order; an abort rolls the increment back.
	update public.qorpera_folder_clocks set last_seq = last_seq + 1 where environment_id = p_environment_id
	returning last_seq into v_seq;
	update public.qorpera_folder_commits set seq = v_seq, units = v_outcomes, review_id = v_used_review, approver_user_id = v_approver
	where id = v_commit_id;
	insert into public.qorpera_folder_journal(environment_id, seq, kind, commit_id)
	values (p_environment_id, v_seq, 'change_set', v_commit_id);
	return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',v_seq,'replay',false,
		'units',v_outcomes);
end $$;


-- 11. Reads and listings with run actors (C1B §2, "Reads") ---------------------------------------------------------

-- The actor a read or listing checks: a member as given; a run resolved with plain reads and no locks (a paused
-- company refuses run reads, as today's actor does); the platform sees everything (null). A malformed actor or a
-- company without the folder core raises.
create function public.qorpera_folder_read_actor(p_environment_id uuid, p_actor jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_profile uuid;
begin
	if p_actor ->> 'kind' = 'platform' and p_actor - array['kind'] = '{}'::jsonb then return null; end if;
	if p_actor ->> 'kind' = 'member' and p_actor - array['kind','userId'] = '{}'::jsonb
		and coalesce(p_actor ->> 'userId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return p_actor; end if;
	if p_actor ->> 'kind' is distinct from 'run' or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
			where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_profile) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	return public.qorpera_folder_run_resolve(p_environment_id, v_profile, p_actor) - 'lockTargets' - 'attribution';
end $$;

create or replace function public.qorpera_folder_read(p_environment_id uuid, p_actor jsonb, p_path text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_kind text := p_actor ->> 'kind'; v_auth jsonb; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if not public.qorpera_company_path_valid(p_path) then raise exception 'Path is invalid' using errcode = '22023'; end if;
	select jsonb_build_object('schema','qorpera.folder-read/v1','asOfSeq',k.last_seq,
			'found', e.path is not null,
			'entry', case when e.path is not null then public.qorpera_folder_entry_json(e.path, e.kind, e.version, c.seq,
				e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at) end)
	into v_result
	from public.qorpera_company_files f
	join public.qorpera_folder_clocks k on k.environment_id = f.environment_id
	left join public.qorpera_folder_entries e on e.environment_id = f.environment_id and e.kind <> 'claim'
		and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_path), 'sha256')
		and (v_kind = 'platform' or public.qorpera_folder_actor_allowed(f.environment_id, f.profile_id, v_auth, p_path, 'read'))
	left join public.qorpera_folder_commits c on c.id = e.commit_id
	where f.environment_id = p_environment_id and f.core = 'folder-v2';
	if v_result is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	return v_result;
end $$;

create or replace function public.qorpera_folder_list(p_environment_id uuid, p_actor jsonb, p_parent text, p_after text,
	p_limit integer, p_recursive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_kind text := p_actor ->> 'kind'; v_auth jsonb; v_parent_key text; v_under text; v_after text; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if p_limit is null or p_limit not between 1 and 1000 or not public.qorpera_company_path_valid(coalesce(p_parent, ''), true)
		or (p_after is not null and not public.qorpera_company_path_valid(p_after)) then
		raise exception 'Listing is invalid' using errcode = '22023'; end if;
	v_parent_key := public.qorpera_folder_key(coalesce(p_parent, ''));
	v_under := case when v_parent_key = '' then '%' else public.qorpera_folder_under(v_parent_key) end;
	v_after := case when p_after is not null then public.qorpera_folder_key(p_after) end;
	with page as (
		select e.*, c.seq as commit_seq from public.qorpera_folder_entries e
		join public.qorpera_folder_commits c on c.id = e.commit_id
		join public.qorpera_company_files f on f.environment_id = e.environment_id
		where e.environment_id = p_environment_id and f.core = 'folder-v2' and e.kind <> 'claim'
			and (p_recursive or e.parent_key_sha256 = extensions.digest(v_parent_key, 'sha256'))
			and (not p_recursive or e.key_text like v_under)
			and (v_after is null or e.key_text > v_after)
			and (v_kind = 'platform' or public.qorpera_folder_actor_allowed(p_environment_id, f.profile_id, v_auth, e.path, 'read'))
		order by e.key_text limit p_limit
	)
	select jsonb_build_object('schema','qorpera.folder-list/v1', 'asOfSeq', k.last_seq,
		'entries', coalesce((select jsonb_agg(public.qorpera_folder_entry_json(p.path, p.kind, p.version, p.commit_seq,
			p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at) order by p.key_text) from page p), '[]'::jsonb),
		'next', case when (select count(*) from page) = p_limit
			then (select p.path from page p order by p.key_text desc limit 1) end)
	into v_result
	from public.qorpera_folder_clocks k join public.qorpera_company_files f on f.environment_id = k.environment_id
	where k.environment_id = p_environment_id and f.core = 'folder-v2';
	if v_result is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	return v_result;
end $$;


-- 12. Grants ------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_principal_allowed(uuid, public.qorpera_company_path_resources, text, uuid, text),
	public.qorpera_folder_lock_clause(text),
	public.qorpera_folder_structured_targets(uuid, jsonb, jsonb),
	public.qorpera_folder_structured_lock(uuid, jsonb, smallint, smallint),
	public.qorpera_folder_lock_commit_rank(uuid, jsonb, smallint),
	public.qorpera_folder_structured_decide(uuid, jsonb, uuid, integer, jsonb, text, text),
	public.qorpera_folder_structured_review_class(uuid, jsonb, jsonb, text, text),
	public.qorpera_folder_structured_apply(uuid, uuid, integer, jsonb, text, text),
	public.qorpera_folder_structured_verify(uuid, uuid),
	public.qorpera_folder_coding_protected(text),
	public.qorpera_folder_actor_resource_allowed(uuid, jsonb, public.qorpera_company_path_resources, text),
	public.qorpera_folder_actor_allowed(uuid, uuid, jsonb, text, text),
	public.qorpera_folder_actor_keys_allowed(uuid, uuid, jsonb, text, text[], text),
	public.qorpera_folder_actor_subtree_allowed(uuid, uuid, jsonb, text, text, text),
	public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences),
	public.qorpera_folder_run_resolve(uuid, uuid, jsonb),
	public.qorpera_folder_read_actor(uuid, jsonb),
	-- Operator-only, like today's company pause.
	public.qorpera_folder_pause(uuid, uuid, text),
	public.qorpera_folder_pause_drain(uuid),
	public.qorpera_folder_resume(uuid)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_commit(uuid, jsonb, text, jsonb, uuid),
	public.qorpera_folder_change_set_sha256(jsonb)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_commit(uuid, jsonb, text, jsonb, uuid),
	public.qorpera_folder_change_set_sha256(jsonb)
	to service_role;
