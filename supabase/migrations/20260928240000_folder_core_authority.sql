-- Company folder core, C1b-2: authority through the clock, read sets, agent wakes
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md, section C1b-2).
--
-- Inert for today's companies: everything here runs only for folder-v2 companies. The shared resources and grants
-- tables gain one revision column each (a constant default: no rewrite), which snapshot-v1 never reads.
--
-- This slice:
-- * authority changes ordered through the company clock: revisions, authority journal rows, and a commit's check
--   for a narrowing after its start, made while it holds the clock (C1B-2 §1); commits no longer lock covering
--   resources;
-- * folder resource and grant mutators, with today's owner-only rules for private resources (§2);
-- * read receipts on run reads, releases that record them into read sets and read records, and the recheck (§3);
-- * agent wakes from coworker messages, worker dispatch and worker completion; coding and worker runs (§4).

-- 1. Revisions and the authority journal -------------------------------------------------------------------------

alter table public.qorpera_company_path_resources add column authority_revision bigint not null default 1
	check (authority_revision >= 1);
alter table public.qorpera_company_path_grants add column revision bigint not null default 1 check (revision >= 1);

-- An authority row names its actor, whether it narrows, and each change: {resourceId|grantId, revision, prefix}.
alter table public.qorpera_folder_journal add column authority jsonb;
alter table public.qorpera_folder_journal add constraint qorpera_folder_journal_authority
	check ((kind = 'authority') = (authority is not null) and (authority is null or jsonb_typeof(authority) = 'object'));

-- One row per change, beside its journal row, for the recheck's prefix lookup (C1B-2 §3).
create table public.qorpera_folder_authority_changes (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	seq bigint not null,
	ordinal integer not null,
	resource_id uuid,
	grant_id uuid,
	revision bigint not null,
	prefix text collate "C" not null,
	narrowing boolean not null,
	primary key (environment_id, seq, ordinal),
	check ((resource_id is null) <> (grant_id is null))
);
create index qorpera_folder_authority_changes_resource on public.qorpera_folder_authority_changes(environment_id, resource_id, revision)
	where resource_id is not null;
alter table public.qorpera_folder_authority_changes enable row level security;
revoke all on public.qorpera_folder_authority_changes from public, anon, authenticated, service_role;

-- The clock value a commit decided under: authority rows after it are checked while the commit holds the clock.
alter table public.qorpera_folder_commits add column as_of_seq bigint check (as_of_seq >= 0);

-- Takes the clock last and writes one authority row. Called by the mutators after every other lock.
create function public.qorpera_folder_authority_journal(p_environment_id uuid, p_actor jsonb, p_narrowing boolean, p_changes jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_seq bigint;
begin
	update public.qorpera_folder_clocks set last_seq = last_seq + 1 where environment_id = p_environment_id
	returning last_seq into v_seq;
	if v_seq is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_folder_journal(environment_id, seq, kind, authority)
	values (p_environment_id, v_seq, 'authority',
		jsonb_build_object('actor', p_actor, 'narrowing', p_narrowing, 'changes', coalesce(p_changes, '[]'::jsonb)));
	insert into public.qorpera_folder_authority_changes(environment_id, seq, ordinal, resource_id, grant_id, revision, prefix, narrowing)
	select p_environment_id, v_seq, c.ordinal::integer, (c.value ->> 'resourceId')::uuid, (c.value ->> 'grantId')::uuid,
		(c.value ->> 'revision')::bigint, c.value ->> 'prefix', p_narrowing
	from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) with ordinality c(value, ordinal);
	return v_seq;
end $$;

-- 2. Folder resource and grant mutators (C1B-2 §2) -----------------------------------------------------------------

-- The acting member for a mutator: its role, locked KEY SHARE (rank 1). The platform acts as no member.
create function public.qorpera_folder_mutator_role(p_profile_id uuid, p_actor jsonb)
returns public.qorpera_profile_role language plpgsql security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role;
begin
	if p_actor ->> 'kind' = 'platform' and p_actor - array['kind'] = '{}'::jsonb then return 'owner'; end if;
	if p_actor ->> 'kind' is distinct from 'member' or p_actor - array['kind','userId'] <> '{}'::jsonb
		or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	select role into v_role from public.qorpera_profile_members
	where profile_id = p_profile_id and user_id = (p_actor ->> 'userId')::uuid for key share;
	if v_role is null then raise exception 'Company membership is required' using errcode = '42501'; end if;
	return v_role;
end $$;

-- Whether the actor may change, grant on or revoke a resource. Private resources are their owner's alone (today's
-- rules, 20260828005000:601-680; contract 4.3: an owner or admin cannot supply a member's privacy consent). Any other
-- resource: owners and admins, or the platform.
create function public.qorpera_folder_may_manage(p_actor jsonb, p_role public.qorpera_profile_role,
	p_resource public.qorpera_company_path_resources)
returns boolean language sql immutable set search_path = '' as $$
	select case when p_resource.scope = 'member_private' then p_actor ->> 'kind' = 'member'
			and p_resource.owner_user_id::text = p_actor ->> 'userId'
		else p_role in ('owner','admin') end
$$;

-- Creates or changes a resource. A new narrower resource bumps its covering parent's revision; a change bumps its own.
create function public.qorpera_folder_set_resource(p_environment_id uuid, p_actor jsonb, p_path text, p_match text, p_scope text,
	p_policy text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_role public.qorpera_profile_role; v_key text; v_user uuid;
	v_parent public.qorpera_company_path_resources%rowtype; v_current public.qorpera_company_path_resources%rowtype;
	v_changes jsonb := '[]'::jsonb; v_narrowing boolean := false; v_seq bigint;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder authority changes run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if not public.qorpera_company_path_valid(p_path, true) or p_match not in ('exact','subtree')
		or p_scope not in ('company_shared','member_private') or p_policy not in ('normal','protected')
		or (p_path = '' and (p_match <> 'subtree' or p_scope <> 'company_shared')) then
		raise exception 'Company folder resource is invalid' using errcode = '22023'; end if;
	v_role := public.qorpera_folder_mutator_role(v_file.profile_id, p_actor);
	v_user := (p_actor ->> 'userId')::uuid;
	v_key := public.qorpera_folder_key(p_path);
	-- A member's private folder is theirs: only they make or change resources in it, and only private ones.
	-- At or under members/<id>/private: member_private owned by that member, made by that member only. member_private
	-- nowhere else. Every other resource: owners and admins.
	if (split_part(v_key, '/', 1) = 'members' and split_part(v_key, '/', 3) = 'private'
			and (p_scope <> 'member_private' or split_part(v_key, '/', 2) is distinct from v_user::text))
		or (p_scope = 'member_private' and not (split_part(v_key, '/', 1) = 'members' and split_part(v_key, '/', 3) = 'private'))
		or (p_scope = 'company_shared' and v_role not in ('owner','admin')) then
		raise exception 'Company folder resource authorization is required' using errcode = '42501'; end if;

	-- Rank 6, ancestors first: the covering parent (a new resource narrows it), then the resource itself.
	v_parent := public.qorpera_folder_path_resource(p_environment_id, p_path);
	select * into v_current from public.qorpera_company_path_resources r
	where r.environment_id = p_environment_id and public.qorpera_folder_key(r.path) = v_key;
	if v_parent.id is not null and v_parent.id is distinct from v_current.id then
		perform 1 from public.qorpera_company_path_resources where id = v_parent.id for no key update;
	end if;
	if v_current.id is not null then
		select * into v_current from public.qorpera_company_path_resources where id = v_current.id for no key update;
		if not public.qorpera_folder_may_manage(p_actor, v_role, v_current) then
			raise exception 'Company folder resource authorization is required' using errcode = '42501'; end if;
	elsif v_parent.scope = 'member_private' and v_parent.owner_user_id is distinct from v_user then
		raise exception 'Company folder resource authorization is required' using errcode = '42501';
	end if;
	-- The tie check, in a new statement after the parent lock: no two resources share a folder key. A resource made
	-- under the same parent while this call waited for it is a tie too (the first one wins).
	if (select count(*) from public.qorpera_company_path_resources r
		where r.environment_id = p_environment_id and public.qorpera_folder_key(r.path) = v_key)
		> (v_current.id is not null)::integer then
		raise exception 'Company folder resources tie on this path' using errcode = '23505'; end if;
	-- The parent again: a narrower resource made over this path while this call waited is the one a new resource would
	-- narrow, and it is not locked. Refused; the caller retries with fresh authority.
	if v_current.id is null and (public.qorpera_folder_path_resource(p_environment_id, p_path)).id is distinct from v_parent.id then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company folder authority changed',
			'details', 'folder_authority_changed', 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;

	if v_current.id is null then
		insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy, created_by_user_id)
		values (p_environment_id, p_path, p_match, p_scope, case when p_scope = 'member_private' then v_user end, p_policy,
			coalesce(v_user, v_file.created_by_user_id))
		returning * into v_current;
		if v_parent.id is not null then
			update public.qorpera_company_path_resources set authority_revision = authority_revision + 1 where id = v_parent.id;
			v_narrowing := true;
			v_changes := jsonb_build_array(jsonb_build_object('resourceId', v_parent.id,
				'revision', (select authority_revision from public.qorpera_company_path_resources where id = v_parent.id), 'prefix', v_key));
		end if;
	elsif (v_current.path_match, v_current.scope, v_current.owner_user_id, v_current.policy, v_current.revoked_at is not null)
		is distinct from (p_match, p_scope, case when p_scope = 'member_private' then v_user end, p_policy, false) then
		-- A change of match, scope, owner or policy narrows; setting a revoked resource again alone widens. The key
		-- prefix is the resource's own.
		v_narrowing := (v_current.path_match, v_current.scope, v_current.owner_user_id, v_current.policy)
			is distinct from (p_match, p_scope, case when p_scope = 'member_private' then v_user end, p_policy);
		update public.qorpera_company_path_resources set path = p_path, path_match = p_match, scope = p_scope,
			owner_user_id = case when p_scope = 'member_private' then v_user end, policy = p_policy, revoked_at = null,
			authority_revision = authority_revision + 1
		where id = v_current.id returning * into v_current;
		v_changes := jsonb_build_array(jsonb_build_object('resourceId', v_current.id, 'revision', v_current.authority_revision,
			'prefix', v_key));
	end if;
	if v_changes <> '[]'::jsonb then
		v_seq := public.qorpera_folder_authority_journal(p_environment_id, p_actor, v_narrowing, v_changes);
	end if;
	return jsonb_build_object('schema','qorpera.folder-resource/v1','resourceId',v_current.id,
		'authorityRevision',v_current.authority_revision,'seq',v_seq);
end $$;

-- Grants a principal on a resource. Grants add up, so a grant replaces the principal's live grant on the resource:
-- the old one is revoked and its revision bumped. The change narrows when the new grant allows less or ends sooner.
create function public.qorpera_folder_grant(p_environment_id uuid, p_actor jsonb, p_resource_id uuid, p_principal_kind text,
	p_principal_id uuid, p_permissions text[], p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_role public.qorpera_profile_role; v_resource public.qorpera_company_path_resources%rowtype;
	v_old public.qorpera_company_path_grants%rowtype; v_new uuid; v_narrowing boolean := false; v_changes jsonb := '[]'::jsonb;
	v_seq bigint;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder authority changes run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if p_principal_kind not in ('member','staff_agent') or p_principal_id is null
		or p_permissions is distinct from array['read'] and p_permissions is distinct from array['read','write'] then
		raise exception 'Company folder grant is invalid' using errcode = '22023'; end if;
	v_role := public.qorpera_folder_mutator_role(v_file.profile_id, p_actor);
	-- The principal, KEY SHARE: a member at rank 1, an agent at rank 2.
	if p_principal_kind = 'member' then
		perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = p_principal_id for key share;
	else
		perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id and staff_agent_id = p_principal_id
			and employment_status = 'active' for key share;
	end if;
	if not found then raise exception 'Company folder grant principal is unavailable' using errcode = '42501'; end if;
	-- Rank 6: the resource, FOR NO KEY UPDATE, so that grant changes on it take turns: a replacement then sees the grant
	-- a concurrent one made (commits and reads do not lock resources).
	select * into v_resource from public.qorpera_company_path_resources
	where id = p_resource_id and environment_id = p_environment_id and revoked_at is null for no key update;
	if not found or not public.qorpera_folder_may_manage(p_actor, v_role, v_resource)
		-- A private folder is shared with agents only, never with another member (C1B-2 §2).
		or (v_resource.scope = 'member_private' and p_principal_kind = 'member') then
		raise exception 'Company folder grant authorization is required' using errcode = '42501'; end if;
	-- Rank 7, in a new statement after the resource lock: the principal's live grant on this resource version, replaced.
	select * into v_old from public.qorpera_company_path_grants
	where resource_id = v_resource.id and resource_version = v_resource.version and principal_kind = p_principal_kind
		and principal_id = p_principal_id and revoked_at is null
	order by id limit 1 for no key update;
	if v_old.id is not null then
		update public.qorpera_company_path_grants set revoked_at = clock_timestamp(), revision = revision + 1 where id = v_old.id;
		v_narrowing := not (p_permissions @> v_old.permissions)
			or (p_expires_at is not null and (v_old.expires_at is null or p_expires_at < v_old.expires_at));
		v_changes := v_changes || jsonb_build_array(jsonb_build_object('grantId', v_old.id, 'revision', v_old.revision + 1,
			'prefix', public.qorpera_folder_key(v_resource.path)));
	end if;
	insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id, permissions,
		expires_at, created_by_user_id)
	values (v_resource.id, v_resource.version, p_principal_kind, p_principal_id, p_permissions, p_expires_at,
		coalesce((p_actor ->> 'userId')::uuid, v_file.created_by_user_id))
	returning id into v_new;
	v_changes := v_changes || jsonb_build_array(jsonb_build_object('grantId', v_new, 'revision', 1,
		'prefix', public.qorpera_folder_key(v_resource.path)));
	v_seq := public.qorpera_folder_authority_journal(p_environment_id, p_actor, v_narrowing, v_changes);
	return jsonb_build_object('schema','qorpera.folder-grant/v1','grantId',v_new,'replaced',v_old.id,'seq',v_seq);
end $$;

-- Revokes a resource or one grant, and bumps its revision. Always narrowing.
create function public.qorpera_folder_revoke(p_environment_id uuid, p_actor jsonb, p_resource_id uuid, p_grant_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_role public.qorpera_profile_role; v_resource public.qorpera_company_path_resources%rowtype;
	v_change jsonb; v_seq bigint; v_revision bigint;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder authority changes run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	v_role := public.qorpera_folder_mutator_role(v_file.profile_id, p_actor);
	-- Rank 6: the resource, FOR NO KEY UPDATE: changes to it and to its grants take turns.
	select * into v_resource from public.qorpera_company_path_resources
	where id = p_resource_id and environment_id = p_environment_id for no key update;
	if not found or not public.qorpera_folder_may_manage(p_actor, v_role, v_resource) then
		raise exception 'Company folder revocation authorization is required' using errcode = '42501'; end if;
	if p_grant_id is null then
		if v_resource.path = '' then raise exception 'The root resource is never revoked' using errcode = '42501'; end if;
		update public.qorpera_company_path_resources set revoked_at = coalesce(revoked_at, clock_timestamp()),
			authority_revision = authority_revision + 1 where id = v_resource.id returning authority_revision into v_revision;
		v_change := jsonb_build_object('resourceId', v_resource.id, 'revision', v_revision, 'prefix', public.qorpera_folder_key(v_resource.path));
	else
		-- Rank 7: the grant.
		update public.qorpera_company_path_grants set revoked_at = coalesce(revoked_at, clock_timestamp()), revision = revision + 1
		where id = p_grant_id and resource_id = v_resource.id returning revision into v_revision;
		if v_revision is null then raise exception 'Company folder grant is unavailable' using errcode = '42501'; end if;
		v_change := jsonb_build_object('grantId', p_grant_id, 'revision', v_revision, 'prefix', public.qorpera_folder_key(v_resource.path));
	end if;
	v_seq := public.qorpera_folder_authority_journal(p_environment_id, p_actor, true, jsonb_build_array(v_change));
	return jsonb_build_object('schema','qorpera.folder-revoke/v1','seq',v_seq);
end $$;

-- 3. Read receipts, read sets and read records (C1B-2 §3) -----------------------------------------------------------

-- The run's read set: a few rows per run, one per (covering resource, agent grant), with the oldest unchecked
-- revisions. No foreign key to runs, like the operation keys.
create table public.qorpera_folder_run_reads (
	run_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	resource_id uuid not null,
	grant_id uuid,
	resource_revision bigint not null,
	grant_revision bigint,
	updated_at timestamptz not null default clock_timestamp(),
	check ((grant_id is null) = (grant_revision is null))
);
create unique index qorpera_folder_run_reads_key on public.qorpera_folder_run_reads(run_id, resource_id, grant_id) nulls not distinct;

-- One row per (release, resource), written once: the sorted reads with their receipts, and the output digest.
create table public.qorpera_folder_run_read_records (
	run_id uuid not null,
	release_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	resource_id uuid not null,
	reads jsonb not null check (jsonb_typeof(reads) = 'array'),
	output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	primary key (run_id, release_id, resource_id)
);

-- One row per release: its content digest (a replay with other content is refused) and its result.
create table public.qorpera_folder_run_releases (
	run_id uuid not null,
	release_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	result jsonb not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (run_id, release_id)
);
alter table public.qorpera_folder_run_reads enable row level security;
alter table public.qorpera_folder_run_read_records enable row level security;
alter table public.qorpera_folder_run_releases enable row level security;
revoke all on public.qorpera_folder_run_reads, public.qorpera_folder_run_read_records, public.qorpera_folder_run_releases
	from public, anon, authenticated, service_role;

-- The agent's live grant that lets it read or write under a resource, if its permission comes from a grant (not from
-- a scope rule such as rules/). The lowest id wins among several.
create function public.qorpera_folder_agent_grant(p_resource public.qorpera_company_path_resources, p_staff uuid, p_permission text)
returns public.qorpera_company_path_grants language sql stable security definer set search_path = '' as $$
	select g.* from public.qorpera_company_path_grants g
	where g.resource_id = p_resource.id and g.resource_version = p_resource.version and g.principal_kind = 'staff_agent'
		and g.principal_id = p_staff and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp())
		and p_permission = any (g.permissions)
	order by g.id limit 1
$$;

-- A run's receipt for one read path: the covering resource and the agent's grant, with their revisions.
create function public.qorpera_folder_read_receipt(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_path text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_grant public.qorpera_company_path_grants%rowtype;
begin
	v_resource := public.qorpera_folder_path_resource(p_environment_id, p_path);
	if v_resource.id is null then return null; end if;
	v_grant := public.qorpera_folder_agent_grant(v_resource, (p_actor ->> 'staffAgentId')::uuid, 'read');
	return jsonb_build_object('resourceId', v_resource.id, 'resourceRevision', v_resource.authority_revision,
		'grantId', v_grant.id, 'grantRevision', v_grant.revision);
end $$;

-- Reads and listings for a run return each entry's receipt (C1B-2 §3). They stay pure: no write, no lock.
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
				e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at)
				|| case when v_auth ->> 'kind' = 'staff_agent' then jsonb_build_object('authority',
					public.qorpera_folder_read_receipt(f.environment_id, f.profile_id, v_auth, e.path)) else '{}'::jsonb end end)
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
			p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
			|| case when v_auth ->> 'kind' = 'staff_agent' then jsonb_build_object('authority',
				public.qorpera_folder_read_receipt(p_environment_id, f.profile_id, v_auth, p.path)) else '{}'::jsonb end
			order by p.key_text) from page p), '[]'::jsonb),
		'next', case when (select count(*) from page) = p_limit
			then (select p.path from page p order by p.key_text desc limit 1) end)
	into v_result
	from public.qorpera_folder_clocks k join public.qorpera_company_files f on f.environment_id = k.environment_id
	where k.environment_id = p_environment_id and f.core = 'folder-v2';
	if v_result is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	return v_result;
end $$;


-- The full run check for an effect that is not a commit (a release): the pause, the job KEY SHARE, the fence and the
-- pause again, the resolve, then the run's own rows at their ranks (the requester 1, the agent 2, the wake's room or
-- routine 4-5). Returns the resolved actor with the fence revision.
create function public.qorpera_folder_run_enter(p_environment_id uuid, p_profile_id uuid, p_actor jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resolved jsonb; v_fence bigint; v_targets jsonb;
begin
	if p_actor ->> 'kind' is distinct from 'run' or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
			where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = p_profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_runner_jobs where id = (p_actor ->> 'jobId')::uuid and run_id = (p_actor ->> 'runId')::uuid
	for key share;
	if not found then raise exception 'Run is unavailable' using errcode = '42501'; end if;
	select revision into v_fence from public.qorpera_folder_fences where profile_id = p_profile_id for key share;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = p_profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	v_resolved := public.qorpera_folder_run_resolve(p_environment_id, p_profile_id, p_actor);
	v_targets := coalesce(v_resolved -> 'lockTargets', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('rank', 1,
		'tbl', 'qorpera_profile_members', 'key', p_profile_id::text || ':' || (v_resolved ->> 'requesterUserId'),
		'mode', 'keyshare', 'required', true));
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 1::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 2::smallint, 2::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 3::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 4::smallint, 5::smallint);
	return (v_resolved - 'lockTargets' - 'attribution') || jsonb_build_object('fenceRevision', v_fence);
end $$;

-- Whether a read path is at or under a key prefix ('' covers everything).
create function public.qorpera_folder_key_under(p_key text, p_prefix text)
returns boolean language sql immutable set search_path = '' as $$
	select p_prefix = '' or p_key = p_prefix or p_key like public.qorpera_folder_under(p_prefix)
$$;

-- Rank 10: writes a run's read-set changes in (resource, grant) order, so a run's parallel effects never deadlock
-- on them. p_upserts: pairs to add, keeping least(recorded, observed). p_restamps and p_deletes: compare-and-set on
-- the values the caller read (recorded) with the values it captured (current).
create function public.qorpera_folder_write_read_set(p_environment_id uuid, p_run_id uuid, p_upserts jsonb, p_restamps jsonb,
	p_deletes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item record;
begin
	for v_item in
		select 'upsert' as op, (u ->> 'resourceId')::uuid as resource_id, (u ->> 'grantId')::uuid as grant_id,
			min((u ->> 'resourceRevision')::bigint) as rrev, min((u ->> 'grantRevision')::bigint) as grev, null::bigint as old_rrev,
			null::bigint as old_grev
		from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) u group by 2, 3
		union all
		select 'restamp', (u ->> 'resourceId')::uuid, (u ->> 'grantId')::uuid, (u ->> 'resourceRevision')::bigint,
			(u ->> 'grantRevision')::bigint, (u ->> 'recordedResourceRevision')::bigint, (u ->> 'recordedGrantRevision')::bigint
		from jsonb_array_elements(coalesce(p_restamps, '[]'::jsonb)) u
		union all
		select 'delete', (u ->> 'resourceId')::uuid, (u ->> 'grantId')::uuid, null, null,
			(u ->> 'recordedResourceRevision')::bigint, (u ->> 'recordedGrantRevision')::bigint
		from jsonb_array_elements(coalesce(p_deletes, '[]'::jsonb)) u
		order by 2, 3 nulls first, 1 desc
	loop
		if v_item.op = 'upsert' then
			insert into public.qorpera_folder_run_reads(run_id, environment_id, resource_id, grant_id, resource_revision, grant_revision)
			values (p_run_id, p_environment_id, v_item.resource_id, v_item.grant_id, v_item.rrev, v_item.grev)
			on conflict (run_id, resource_id, grant_id) do update set
				resource_revision = least(public.qorpera_folder_run_reads.resource_revision, excluded.resource_revision),
				grant_revision = least(public.qorpera_folder_run_reads.grant_revision, excluded.grant_revision),
				updated_at = clock_timestamp();
		elsif v_item.op = 'restamp' then
			update public.qorpera_folder_run_reads set resource_revision = v_item.rrev, grant_revision = v_item.grev, updated_at = clock_timestamp()
			where run_id = p_run_id and resource_id = v_item.resource_id and grant_id is not distinct from v_item.grant_id
				and resource_revision = v_item.old_rrev and grant_revision is not distinct from v_item.old_grev;
		else
			delete from public.qorpera_folder_run_reads
			where run_id = p_run_id and resource_id = v_item.resource_id and grant_id is not distinct from v_item.grant_id
				and resource_revision = v_item.old_rrev and grant_revision is not distinct from v_item.old_grev;
		end if;
	end loop;
end $$;

-- Records a release: the reads a run's output was made from (C1B-2 §3). Called by whoever releases output to the model.
create function public.qorpera_folder_record_release(p_environment_id uuid, p_actor jsonb, p_release_id uuid, p_reads jsonb,
	p_output_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_run uuid; v_content text; v_existing public.qorpera_folder_run_releases%rowtype;
	v_actor jsonb; v_group record; v_read jsonb; v_receipt jsonb; v_pass boolean; v_upserts jsonb := '[]'::jsonb;
	v_filed jsonb := '[]'::jsonb; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder releases run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if p_release_id is null or coalesce(p_output_sha256, '') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_reads) is distinct from 'array'
		or jsonb_array_length(p_reads) > 10000
		or exists (select 1 from jsonb_array_elements(p_reads) r
			where jsonb_typeof(r) <> 'object' or not public.qorpera_company_path_valid(coalesce(r ->> 'path', ''))
				or jsonb_typeof(r -> 'authority') is distinct from 'object'
				or coalesce(r -> 'authority' ->> 'resourceId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				or coalesce(r -> 'authority' ->> 'resourceRevision', '') !~ '^[0-9]{1,18}$') then
		raise exception 'Folder release is invalid' using errcode = '22023'; end if;
	v_run := (p_actor ->> 'runId')::uuid;
	v_content := encode(extensions.digest(convert_to(jsonb_build_array(p_reads, p_output_sha256)::text, 'utf8'), 'sha256'), 'hex');
	-- A release id is used once: the same content replays, other content is refused.
	select * into v_existing from public.qorpera_folder_run_releases where run_id = v_run and release_id = p_release_id;
	if found then
		if v_existing.content_sha256 <> v_content then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		return v_existing.result || jsonb_build_object('replay', true);
	end if;
	v_actor := public.qorpera_folder_run_enter(p_environment_id, v_file.profile_id, p_actor);

	-- Per (resource, grant) on the receipts: the pair passes when its revisions are unchanged, its grant is live, and
	-- its resource still covers each path by key prefix (the parent bump guarantees nothing narrower was inserted).
	-- Otherwise each of its paths is re-resolved now, and the release refuses if one is no longer readable.
	for v_group in
		select (r -> 'authority' ->> 'resourceId')::uuid as resource_id, (r -> 'authority' ->> 'grantId')::uuid as grant_id,
			(r -> 'authority' ->> 'resourceRevision')::bigint as rrev, (r -> 'authority' ->> 'grantRevision')::bigint as grev,
			jsonb_agg(r) as reads
		from jsonb_array_elements(p_reads) r group by 1, 2, 3, 4
	loop
		select exists (select 1 from public.qorpera_company_path_resources res
				where res.id = v_group.resource_id and res.environment_id = p_environment_id and res.authority_revision = v_group.rrev
					and not exists (select 1 from jsonb_array_elements(v_group.reads) x
						where not (public.qorpera_folder_key(x ->> 'path') = public.qorpera_folder_key(res.path)
							or (res.path_match = 'subtree' and public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'),
								public.qorpera_folder_key(res.path))))))
			and (v_group.grant_id is null or exists (select 1 from public.qorpera_company_path_grants g
				where g.id = v_group.grant_id and g.revision = v_group.grev and g.revoked_at is null
					and (g.expires_at is null or g.expires_at > clock_timestamp())))
		into v_pass;
		if v_pass then
			v_upserts := v_upserts || jsonb_build_array(jsonb_build_object('resourceId', v_group.resource_id, 'grantId', v_group.grant_id,
				'resourceRevision', v_group.rrev, 'grantRevision', v_group.grev));
			v_filed := v_filed || v_group.reads;
		else
			for v_read in select value from jsonb_array_elements(v_group.reads) loop
				if not public.qorpera_folder_actor_allowed(p_environment_id, v_file.profile_id, v_actor, v_read ->> 'path', 'read') then
					raise exception 'A released read is no longer readable' using errcode = '42501'; end if;
				v_receipt := public.qorpera_folder_read_receipt(p_environment_id, v_file.profile_id, v_actor, v_read ->> 'path');
				v_upserts := v_upserts || jsonb_build_array(v_receipt);
				v_filed := v_filed || jsonb_build_array(v_read || jsonb_build_object('authority', v_receipt));
			end loop;
		end if;
	end loop;

	perform public.qorpera_folder_write_read_set(p_environment_id, v_run, v_upserts, null, null);
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	select v_run, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
		jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
	from jsonb_array_elements(v_filed) f group by 4;
	v_result := jsonb_build_object('schema','qorpera.folder-release/v1','releaseId',p_release_id,
		'reads',jsonb_array_length(p_reads),'replay',false);
	insert into public.qorpera_folder_run_releases(run_id, release_id, environment_id, content_sha256, result)
	values (v_run, p_release_id, p_environment_id, v_content, v_result);
	return v_result;
end $$;

-- The recheck for effects (C1B-2 §3): does every read the run released still hold under current authority? Plain
-- reads, then one rank-10 write of the read-set changes. Raises 42501 when a read is no longer readable.
create function public.qorpera_folder_run_reads_current(p_environment_id uuid, p_profile_id uuid, p_actor jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
	v_run uuid := (p_actor ->> 'runId')::uuid; v_row record; v_prefixes text[]; v_path text; v_receipt jsonb;
	v_upserts jsonb := '[]'::jsonb; v_restamps jsonb := '[]'::jsonb; v_deletes jsonb := '[]'::jsonb; v_changed integer := 0;
begin
	for v_row in
		select rr.resource_id, rr.grant_id, rr.resource_revision, rr.grant_revision,
			r.id is not null as resource_exists, r.authority_revision as current_rrev, r.path as resource_path,
			g.revision as current_grev,
			(g.id is not null and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp())) as grant_live
		from public.qorpera_folder_run_reads rr
		left join public.qorpera_company_path_resources r on r.id = rr.resource_id
		left join public.qorpera_company_path_grants g on g.id = rr.grant_id
		where rr.run_id = v_run
		order by rr.resource_id, rr.grant_id nulls first
	loop
		-- Captured now: current_rrev, current_grev, grant_live. A row passes when nothing moved and its grant lives.
		if v_row.resource_exists and v_row.current_rrev = v_row.resource_revision
			and (v_row.grant_id is null or (v_row.grant_live and v_row.current_grev = v_row.grant_revision)) then continue; end if;
		v_changed := v_changed + 1;
		-- Which paths to re-resolve: a changed or dead grant, or a vanished resource, covers everything under the
		-- resource; a changed resource revision only the prefixes its changes name.
		if not v_row.resource_exists then
			v_prefixes := null;
		elsif v_row.grant_id is not null and (not v_row.grant_live or v_row.current_grev is distinct from v_row.grant_revision) then
			v_prefixes := array[public.qorpera_folder_key(v_row.resource_path)];
		else
			select array_agg(distinct c.prefix) into v_prefixes from public.qorpera_folder_authority_changes c
			where c.environment_id = p_environment_id and c.resource_id = v_row.resource_id and c.revision > v_row.resource_revision;
			v_prefixes := coalesce(v_prefixes, array[public.qorpera_folder_key(v_row.resource_path)]);
		end if;
		-- The paths, looked up by key across all of the run's records (not by the resource they were filed under).
		for v_path in
			select distinct x ->> 'path' from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = v_run and (
				(v_prefixes is null and rec.resource_id = v_row.resource_id)
				or exists (select 1 from unnest(v_prefixes) p(prefix)
					where public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), p.prefix)))
		loop
			if not public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_path, 'read') then
				raise exception 'A read is no longer readable' using errcode = '42501'; end if;
			v_receipt := public.qorpera_folder_read_receipt(p_environment_id, p_profile_id, p_actor, v_path);
			if v_receipt is not null then v_upserts := v_upserts || jsonb_build_array(v_receipt); end if;
		end loop;
		-- Re-stamp with the captured values, or retire a dead-grant or vanished row; both compare-and-set.
		if not v_row.resource_exists or (v_row.grant_id is not null and not v_row.grant_live) then
			v_deletes := v_deletes || jsonb_build_array(jsonb_build_object('resourceId', v_row.resource_id, 'grantId', v_row.grant_id,
				'recordedResourceRevision', v_row.resource_revision, 'recordedGrantRevision', v_row.grant_revision));
		else
			v_restamps := v_restamps || jsonb_build_array(jsonb_build_object('resourceId', v_row.resource_id, 'grantId', v_row.grant_id,
				'resourceRevision', v_row.current_rrev, 'grantRevision', v_row.current_grev,
				'recordedResourceRevision', v_row.resource_revision, 'recordedGrantRevision', v_row.grant_revision));
		end if;
	end loop;
	if v_changed > 0 then
		perform public.qorpera_folder_write_read_set(p_environment_id, v_run, v_upserts, v_restamps, v_deletes);
	end if;
	return v_changed;
end $$;

-- 4. Agent wakes (C1B-2 §4) --------------------------------------------------------------------------------------

-- The parent's reads, for an agent wake: every row of the parent run's read set is readable by the wake's requester
-- and agent under the company-audience rule (not member_private; both principals read the resource). A row that
-- changed since the parent recorded it re-resolves its paths from the parent's records instead. A parent with no read
-- set passes: it read nothing through the folder core. Plain reads only.
create function public.qorpera_folder_parent_reads_allowed(p_wake public.qorpera_wake_occurrences)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
	v_row record; v_resource public.qorpera_company_path_resources%rowtype; v_path text;
	v_recipient jsonb := jsonb_build_object('kind','staff_agent','staffAgentId',p_wake.staff_agent_id,
		'requesterUserId',p_wake.requested_by_user_id,'audience',jsonb_build_object('kind','company'),'sessionKind','in_house');
begin
	for v_row in
		select rr.resource_id, rr.grant_id, rr.resource_revision,
			(rr.grant_id is null or exists (select 1 from public.qorpera_company_path_grants g where g.id = rr.grant_id
				and g.revision = rr.grant_revision and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp()))) as grant_same
		from public.qorpera_folder_run_reads rr where rr.run_id = p_wake.parent_run_id
	loop
		select * into v_resource from public.qorpera_company_path_resources where id = v_row.resource_id;
		if v_resource.id is not null and v_resource.authority_revision = v_row.resource_revision and v_row.grant_same then
			if v_resource.scope = 'member_private' or v_resource.revoked_at is not null
				or not public.qorpera_folder_principal_allowed(p_wake.profile_id, v_resource, 'member', p_wake.requested_by_user_id, 'read')
				or not public.qorpera_folder_principal_allowed(p_wake.profile_id, v_resource, 'staff_agent', p_wake.staff_agent_id, 'read') then
				return false; end if;
		else
			for v_path in
				select distinct x ->> 'path' from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
				where rec.run_id = p_wake.parent_run_id and (rec.resource_id = v_row.resource_id or (v_resource.id is not null
					and public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), public.qorpera_folder_key(v_resource.path))))
			loop
				if not public.qorpera_folder_actor_allowed(p_wake.environment_id, p_wake.profile_id, v_recipient, v_path, 'read') then
					return false; end if;
			end loop;
		end if;
	end loop;
	return true;
end $$;

-- The wake check of C1b-1 (as 20260928231000 left it) plus agent wakes from coworker messages, worker dispatch and
-- worker completion, and the payer check, ported from qorpera_wake_authorized as 20260928230000 and 20260928231000
-- left it, without its locks. Office activation and machine events still come with C1b-3, file-change routine wakes
-- with C4.
create or replace function public.qorpera_folder_wake_authorized(p_wake public.qorpera_wake_occurrences)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_ancestry jsonb; v_standing_version bigint := public.qorpera_wake_standing_sponsor_version(p_wake);
begin
	if v_standing_version is null or p_wake.wake_kind not in ('human','first-run','routine','room','agent')
		or p_wake.source_kind in ('company-file','office-activation','machine-event') then return false; end if;
	-- A member's login pays only for work that member started (20260928230000).
	if not public.qorpera_sponsor_serves_requester(p_wake.profile_id, p_wake.sponsor_binding_id, p_wake.sponsor_version,
		p_wake.requested_by_user_id) then return false; end if;
	if p_wake.wake_schema <> 'qorpera.wake-envelope/v1'
		or (p_wake.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
			where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id))
		or not exists(select 1 from public.qorpera_profile_members where profile_id = p_wake.profile_id
			and user_id = p_wake.requested_by_user_id)
		or not exists(select 1 from public.qorpera_profile_staff where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and version >= p_wake.staff_version and employment_status = 'active')
		or (p_wake.session_id is not null and not exists(select 1 from public.qorpera_shared_sessions
			where id = p_wake.session_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id
				and (staff_agent_id = p_wake.staff_agent_id::text or ((p_wake.wake_kind = 'room' or (p_wake.source_kind = 'worker-completion'
					and public.qorpera_company_room_session_staff(id, p_wake.staff_agent_id))) and staff_agent_id is null
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
			and v.sponsor_binding_id = p_wake.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v.sponsor_binding_id, v.sponsor_version, v_standing_version)) then return false; end if;
	if p_wake.wake_kind = 'room' and (p_wake.source_kind <> 'room' or p_wake.session_id is null or not exists (
		select 1 from public.qorpera_company_rooms room
		join public.qorpera_company_room_members agent on agent.room_id = room.id and agent.principal_kind = 'staff_agent'
			and agent.principal_id = p_wake.staff_agent_id and agent.status = 'active'
		join public.qorpera_company_room_members poster on poster.room_id = room.id and poster.principal_kind = 'member'
			and poster.principal_id = p_wake.requested_by_user_id and poster.status = 'active'
		join public.qorpera_session_inputs input on input.id = p_wake.source_id and input.session_id = room.session_id
		where room.session_id = p_wake.session_id and room.profile_id = p_wake.profile_id and room.status = 'active')) then
		return false; end if;
	if p_wake.wake_kind = 'agent' then
		-- An agent wake is paid by its starter (checked above), not by a standing authority. A coding worker's
		-- dispatch is paid by its owner's login, or the login that one follows to (20260928230000, 20260928231000).
		if p_wake.source_kind = 'worker-dispatch' and exists (select 1 from public.qorpera_runtime_workers w
				where w.id = p_wake.source_id and w.species = 'coding')
			and not exists (select 1 from public.qorpera_runtime_workers w
				where w.id = p_wake.source_id and w.species = 'coding' and w.profile_id = p_wake.profile_id
					and w.owner_sponsor_binding_id = p_wake.sponsor_binding_id
					and public.qorpera_sponsor_version_follows(w.owner_sponsor_binding_id, w.owner_sponsor_version, p_wake.sponsor_version)
					and exists (select 1 from public.qorpera_profile_members m where m.profile_id = w.profile_id and m.user_id = w.owner_user_id)) then
			return false; end if;
		if not exists (select 1 from public.qorpera_execution_runs where id = p_wake.parent_run_id and profile_id = p_wake.profile_id
			and environment_id = p_wake.environment_id) then return false; end if;
		-- The parent's reads, per read-set row, readable by this run's requester and agent (C1B-2 §4).
		if not public.qorpera_folder_parent_reads_allowed(p_wake) then return false; end if;
		if p_wake.source_kind = 'coworker' then v_ancestry := public.qorpera_coworker_wake_ancestry(p_wake);
		elsif p_wake.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(p_wake);
		else return false; end if;
	else
		v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id, null, p_wake.staff_agent_id, coalesce(p_wake.file_event_id, p_wake.id));
	end if;
	return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
		and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids), false);
end $$;


create or replace function public.qorpera_folder_run_resolve(p_environment_id uuid, p_profile_id uuid, p_actor jsonb)
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
	if v_wake.source_kind in ('company-file','office-activation','machine-event') then
		raise exception 'Folder writes by this kind of run are not available yet' using errcode = '0A000'; end if;
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
	if v_worker.id is not null and v_worker.species = 'coding' then
		v_session_kind := 'coding';
		-- A coding session acts for its owner (F3); until the owner and the requester are one member (S2), a coding
		-- run whose worker's owner is not its requester does not act at all.
		if v_worker.owner_user_id is distinct from v_run.requested_by_user_id then
			raise exception 'Coding run owner is unavailable' using errcode = '42501'; end if;
	end if;
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


-- 5. Commits (C1B-2 §1, §3) ---------------------------------------------------------------------------------------

-- C1b-1's commit, now deciding under a recorded clock value: no rank-6 locks on covering resources, hook targets on
-- resources and grants in KEY SHARE only, a run's recheck at rank 10, and the authority check after the clock.
create or replace function public.qorpera_folder_commit(p_environment_id uuid, p_actor jsonb, p_operation_key text, p_units jsonb,
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
	v_file_json jsonb; v_as_of bigint; v_ancestor text; v_decided_as_of bigint;
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

	-- The clock value this commit decides under (C1B-2 §1): a plain read, before any authority decision. A narrowing
	-- journaled after it refuses the commit once the commit holds the clock.
	select last_seq into v_decided_as_of from public.qorpera_folder_clocks where environment_id = p_environment_id;
	if v_decided_as_of is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;

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
	-- run's requester at rank 1; a run's agent at 2 and its wake's room or routine at 4 or 5) and the structured-file
	-- hook's targets, at any rank. Covering resources are not locked: authority is ordered through the clock (C1B-2
	-- §1). Rows merge by (table, key), the stronger mode wins, and a row the commit relies on must exist. The commit
	-- locks ranks 1, 3, 6 and 7; the hook's lock takes 2, 4, 5, 8 and 9. Nothing is locked twice or upgraded.
	if v_actor_kind = 'member' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_file.profile_id::text || ':' || v_actor_id::text, 'mode', 'keyshare', 'required', true));
	elsif v_actor_kind = 'run' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_file.profile_id::text || ':' || (v_resolved ->> 'requesterUserId'), 'mode', 'keyshare', 'required', true));
	end if;
	v_targets := v_targets || coalesce((select jsonb_agg(to_jsonb(t))
			from public.qorpera_folder_structured_targets(p_environment_id, v_hook_actor, p_units) t), '[]'::jsonb);

	-- Every target names a rank 1-9, a table, a key and a known mode; anything else is a defect, never a silent skip.
	if exists (select 1 from jsonb_array_elements(v_targets) t
		where jsonb_typeof(t) <> 'object' or coalesce(t ->> 'rank', '') !~ '^[1-9]$' or t ->> 'tbl' is null or t ->> 'key' is null
			or coalesce(t ->> 'mode', '') not in ('keyshare','share','nokeyupdate','update')) then
		raise exception 'Folder lock targets are malformed' using errcode = 'XX000'; end if;
	-- Resources and grants are held KEY SHARE at most: a shared lock on the root would starve authority changes.
	if exists (select 1 from jsonb_array_elements(v_targets) t where t ->> 'rank' in ('6','7') and t ->> 'mode' <> 'keyshare') then
		raise exception 'Folder lock targets on resources and grants are key share only' using errcode = 'XX000'; end if;
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

	-- Rank 10: a run's released reads still hold (C1B-2 §3). A narrowing that commits after this is caught after the
	-- clock.
	if v_actor_kind = 'run' then
		perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id, v_auth_actor);
	end if;

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
		provider_connection_id, runtime_bundle_id, units, as_of_seq)
	values (v_commit_id, p_environment_id, p_operation_key,
		case when v_actor_kind = 'run' then 'staff_agent' else v_actor_kind end, v_actor_id,
		case when v_actor_kind = 'run' then 'member' else v_actor_kind end,
		case when v_actor_kind = 'run' then (v_resolved ->> 'requesterUserId')::uuid else v_actor_id end,
		(v_resolved ->> 'runId')::uuid, (v_resolved ->> 'causalWakeId')::uuid, v_resolved -> 'audience',
		v_resolved ->> 'sessionKind', (v_resolved ->> 'routineId')::uuid, (v_resolved ->> 'routineVersion')::bigint,
		(v_attr ->> 'sponsorBindingId')::uuid, (v_attr ->> 'sponsorVersion')::bigint,
		(v_attr ->> 'providerConnectionId')::uuid, (v_attr ->> 'runtimeBundleId')::uuid, '[]', v_decided_as_of);

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
	-- The authority check (C1B-2 §1): a narrowing journaled after this commit started deciding refuses it, and the
	-- caller retries with the same operation key. A change still in flight waits for the clock this commit holds, and
	-- so is ordered after it. The platform acts under no grant.
	if v_actor_kind <> 'platform' and exists (select 1 from public.qorpera_folder_journal j
		where j.environment_id = p_environment_id and j.seq > v_decided_as_of and j.seq < v_seq and j.kind = 'authority'
			and (j.authority ->> 'narrowing')::boolean) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company folder authority changed',
			'details', 'folder_authority_changed', 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_folder_commits set seq = v_seq, units = v_outcomes, review_id = v_used_review, approver_user_id = v_approver
	where id = v_commit_id;
	insert into public.qorpera_folder_journal(environment_id, seq, kind, commit_id)
	values (p_environment_id, v_seq, 'change_set', v_commit_id);
	return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',v_seq,'replay',false,
		'units',v_outcomes);
end $$;


-- 6. Grants -------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_authority_journal(uuid, jsonb, boolean, jsonb),
	public.qorpera_folder_mutator_role(uuid, jsonb),
	public.qorpera_folder_may_manage(jsonb, public.qorpera_profile_role, public.qorpera_company_path_resources),
	public.qorpera_folder_agent_grant(public.qorpera_company_path_resources, uuid, text),
	public.qorpera_folder_read_receipt(uuid, uuid, jsonb, text),
	public.qorpera_folder_run_enter(uuid, uuid, jsonb),
	public.qorpera_folder_key_under(text, text),
	public.qorpera_folder_write_read_set(uuid, uuid, jsonb, jsonb, jsonb),
	public.qorpera_folder_run_reads_current(uuid, uuid, jsonb),
	public.qorpera_folder_parent_reads_allowed(public.qorpera_wake_occurrences)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_set_resource(uuid, jsonb, text, text, text, text),
	public.qorpera_folder_grant(uuid, jsonb, uuid, text, uuid, text[], timestamptz),
	public.qorpera_folder_revoke(uuid, jsonb, uuid, uuid),
	public.qorpera_folder_record_release(uuid, jsonb, uuid, jsonb, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_set_resource(uuid, jsonb, text, text, text, text),
	public.qorpera_folder_grant(uuid, jsonb, uuid, text, uuid, text[], timestamptz),
	public.qorpera_folder_revoke(uuid, jsonb, uuid, uuid),
	public.qorpera_folder_record_release(uuid, jsonb, uuid, jsonb, text)
	to service_role;
