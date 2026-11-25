set local lock_timeout = '3s';

-- WHY: Keep manifest_head (~450 B) inline on heap pages so hot runtime callers and run-insert triggers avoid detoasting 300 KiB manifest blobs.
alter table public.qorpera_runtime_bundles
	add column manifest_head jsonb
		generated always as (manifest - 'implementation' - 'components') stored,
	add column components_is_object boolean
		generated always as (jsonb_typeof(manifest -> 'components') = 'object') stored;

do $$
declare
	v_def text := pg_get_functiondef('public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure);
	v_head text;
begin
	v_head := v_def;
	if position('public.qorpera_execution_runtime_manifest(' in v_head) = 0
		or position('declare v_manifest jsonb; v_impl_state text; v_components_valid boolean;' in v_head) = 0
		or position('select manifest #> ''{}''::text[], implementation_state, components_valid into v_manifest, v_impl_state, v_components_valid from public.qorpera_runtime_bundles' in v_head) = 0
		or position('or jsonb_typeof(v_manifest -> ''components'') is distinct from ''object''' in v_head) = 0 then
		raise exception '20260930894000: unexpected qorpera_execution_runtime_manifest definition';
	end if;
	v_head := replace(v_head, 'public.qorpera_execution_runtime_manifest(', 'public.qorpera_execution_runtime_manifest_head(');
	v_head := replace(
		v_head,
		'declare v_manifest jsonb; v_impl_state text; v_components_valid boolean;',
		'declare v_manifest jsonb; v_impl_state text; v_components_valid boolean; v_components_is_object boolean;'
	);
	v_head := replace(
		v_head,
		'select manifest #> ''{}''::text[], implementation_state, components_valid into v_manifest, v_impl_state, v_components_valid from public.qorpera_runtime_bundles',
		'select manifest_head, implementation_state, components_valid, components_is_object into v_manifest, v_impl_state, v_components_valid, v_components_is_object from public.qorpera_runtime_bundles'
	);
	v_head := replace(
		v_head,
		'or jsonb_typeof(v_manifest -> ''components'') is distinct from ''object''',
		'or not coalesce(v_components_is_object, false)'
	);
	execute v_head;
end $$;

revoke all on function public.qorpera_execution_runtime_manifest_head(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.hp_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930894000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.hp_replace(
	'public.qorpera_describe_native_tool_authority(jsonb)',
	'public.qorpera_execution_runtime_manifest(v_run)',
	'public.qorpera_execution_runtime_manifest_head(v_run)'
);
select pg_temp.hp_replace(
	'public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)',
	'public.qorpera_execution_runtime_manifest(v_run)',
	'public.qorpera_execution_runtime_manifest_head(v_run)'
);
select pg_temp.hp_replace(
	'public.qorpera_begin_native_company_execution_v3(jsonb,text,text,text,text)',
	'public.qorpera_execution_runtime_manifest(v_run)',
	'public.qorpera_execution_runtime_manifest_head(v_run)'
);
select pg_temp.hp_replace(
	'public.qorpera_pin_execution_reasoning_policy()',
	'public.qorpera_execution_runtime_manifest(new)',
	'public.qorpera_execution_runtime_manifest_head(new)'
);
select pg_temp.hp_replace(
	'public.qorpera_pin_execution_service_tier()',
	'public.qorpera_execution_runtime_manifest(new)',
	'public.qorpera_execution_runtime_manifest_head(new)'
);
select pg_temp.hp_replace(
	'public.qorpera_pin_execution_claude_choice()',
	'public.qorpera_execution_runtime_manifest(new)',
	'public.qorpera_execution_runtime_manifest_head(new)'
);
select pg_temp.hp_replace(
	'public.qorpera_pin_execution_gemini_choice()',
	'public.qorpera_execution_runtime_manifest(new)',
	'public.qorpera_execution_runtime_manifest_head(new)'
);

-- WHY: PG 17 does not cache plans for non-inlinable LANGUAGE sql SECURITY DEFINER helpers; converting hot helpers to PL/pgSQL caches plans per session without changing semantics.
create temporary table hp_before as
select p.oid, p.proname::text as name, l.lanname::text as language, p.provolatile, p.prosecdef, p.proisstrict,
	p.proleakproof, p.proparallel, p.procost, p.proconfig, p.proowner, p.proacl, p.prorettype
from pg_proc p join pg_language l on l.oid = p.prolang
where p.oid in (
	'public.qorpera_folder_actor_rules(uuid,uuid,jsonb,text)'::regprocedure,
	'public.qorpera_folder_agent_grant(public.qorpera_company_path_resources,uuid,text)'::regprocedure,
	'public.qorpera_environment_is_folder_v2(uuid)'::regprocedure,
	'public.qorpera_company_is_folder_v2(uuid)'::regprocedure,
	'public.qorpera_member_role(uuid)'::regprocedure,
	'public.qorpera_company_deleting(uuid)'::regprocedure,
	'public.qorpera_can_read_profile(uuid)'::regprocedure,
	'public.qorpera_can_authorize_profile(uuid)'::regprocedure,
	'public.qorpera_can_write_profile(uuid)'::regprocedure,
	'public.qorpera_can_read_session(uuid)'::regprocedure,
	'public.qorpera_company_machine_placement(uuid)'::regprocedure,
	'public.qorpera_provider_execution_enabled(text,text,text)'::regprocedure,
	'public.qorpera_company_at_zero(uuid,timestamptz)'::regprocedure
);

do $$
begin
	if (select count(*) from pg_temp.hp_before) <> 13 or exists (select 1 from pg_temp.hp_before where language <> 'sql') then
		raise exception '20260930894000: hot SQL helper inventory differs from expected 13 sql functions'; end if;
end $$;

create or replace function public.qorpera_folder_actor_rules(
	p_environment_id uuid,
	p_profile_id uuid,
	p_actor jsonb,
	p_permission text
)
returns table(
	rkey text,
	rkey_prefix text,
	rkey_len integer,
	resource_id uuid,
	path_match text,
	scope text,
	owner_user_id uuid,
	is_shared boolean,
	allowed boolean,
	receipt jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	return query
	with resources as materialized (
		select r,
			public.qorpera_folder_key(r.path) collate "C" as rkey,
			count(*) over (partition by public.qorpera_folder_key(r.path) collate "C") > 1 as is_shared
		from public.qorpera_company_path_resources r
		where r.environment_id = p_environment_id
	)
	select res.rkey,
		(res.rkey || '/') collate "C" as rkey_prefix,
		length(res.rkey)::integer as rkey_len,
		(res.r).id as resource_id,
		(res.r).path_match,
		(res.r).scope,
		(res.r).owner_user_id,
		res.is_shared,
		case when res.is_shared then false
			else coalesce(public.qorpera_folder_actor_resource_allowed(p_profile_id, p_actor, res.r, p_permission), false)
		end as allowed,
		case when p_permission = 'read' and not res.is_shared and p_actor ->> 'kind' = 'staff_agent' then
			jsonb_build_object(
				'resourceId', (res.r).id,
				'resourceRevision', (res.r).authority_revision,
				'grantId', (g.grant_row).id,
				'grantRevision', (g.grant_row).revision
			)
		end as receipt
	from resources res
	left join lateral (
		select public.qorpera_folder_agent_grant(res.r, (p_actor ->> 'staffAgentId')::uuid, 'read') as grant_row
		where p_permission = 'read' and not res.is_shared and p_actor ->> 'kind' = 'staff_agent'
	) g on true;
end $$;

create or replace function public.qorpera_folder_agent_grant(
	p_resource public.qorpera_company_path_resources,
	p_staff uuid,
	p_permission text
)
returns public.qorpera_company_path_grants
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_grant public.qorpera_company_path_grants%rowtype;
begin
	select g.* into v_grant from public.qorpera_company_path_grants g
	where g.resource_id = p_resource.id and g.resource_version = p_resource.version and g.principal_kind = 'staff_agent'
		and g.principal_id = p_staff and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp())
		and p_permission = any (g.permissions)
	order by g.id limit 1;
	if not found then return null; end if;
	return v_grant;
end $$;

create or replace function public.qorpera_environment_is_folder_v2(p_environment_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (select 1 from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2');
end $$;

create or replace function public.qorpera_company_is_folder_v2(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (select 1 from public.qorpera_company_files where profile_id = p_profile_id and core = 'folder-v2');
end $$;

create or replace function public.qorpera_member_role(p_profile_id uuid)
returns public.qorpera_profile_role language plpgsql stable security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role;
begin
	select member.role into v_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id
		and member.user_id = auth.uid()
		and not exists (select 1 from public.qorpera_company_deletions as deletion
			where deletion.profile_id = p_profile_id);
	return v_role;
end $$;

create or replace function public.qorpera_company_deleting(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (select 1 from public.qorpera_company_deletions where profile_id = p_profile_id);
end $$;

create or replace function public.qorpera_can_read_profile(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return public.qorpera_member_role(p_profile_id) is not null;
end $$;

create or replace function public.qorpera_can_authorize_profile(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return coalesce(public.qorpera_member_role(p_profile_id) in ('owner', 'admin'), false);
end $$;

create or replace function public.qorpera_can_write_profile(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return coalesce(public.qorpera_member_role(p_profile_id) in ('owner', 'admin', 'contributor'), false);
end $$;

create or replace function public.qorpera_can_read_session(p_session_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (
		select 1 from public.qorpera_shared_sessions session
		join public.qorpera_profile_members member on member.profile_id = session.profile_id
			and member.user_id = auth.uid()
		where session.id = p_session_id and (
			session.audience_kind = 'company'
			or (session.audience_kind = 'member_private' and session.audience_user_id = auth.uid())
		)
	);
end $$;

create or replace function public.qorpera_company_machine_placement(p_machine_id uuid)
returns public.qorpera_company_machine_placements language plpgsql stable security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype;
begin
	select placement.* into v_placement from public.qorpera_company_machine_placements placement
	where placement.machine_id = p_machine_id and placement.retired_at is null and placement.removed_at is null;
	if not found then return null; end if;
	return v_placement;
end $$;

create or replace function public.qorpera_provider_execution_enabled(
	p_provider text,
	p_authentication_mode text,
	p_native_harness text
)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (
		select 1
		from public.qorpera_provider_execution_policies as policy
		where policy.provider = p_provider
			and policy.authentication_mode = p_authentication_mode
			and policy.native_harness = p_native_harness
			and policy.implementation_status = 'supported'
			and policy.enablement_status = 'enabled'
	);
end $$;

create or replace function public.qorpera_company_at_zero(p_profile_id uuid, p_at timestamptz)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (
		select 1 from public.qorpera_computer_hour_zero_state zero where zero.profile_id = p_profile_id
	) and public.qorpera_company_at_zero_now(p_profile_id, p_at);
end $$;

do $$
begin
	if exists (select 1 from pg_temp.hp_before b join pg_proc p on p.oid = b.oid join pg_language l on l.oid = p.prolang
		where l.lanname <> 'plpgsql' or p.provolatile <> b.provolatile or p.prosecdef <> b.prosecdef or not p.prosecdef
			or p.proisstrict <> b.proisstrict or p.proleakproof <> b.proleakproof or p.proparallel <> b.proparallel
			or p.procost <> b.procost or p.proconfig is distinct from b.proconfig
			or p.proconfig is distinct from array['search_path=""'] or p.proowner <> b.proowner
			or p.proacl is distinct from b.proacl or p.prorettype <> b.prorettype) then
		raise exception '20260930894000: a converted helper changed more than its language'; end if;
end $$;

drop table pg_temp.hp_before;

-- WHY: Probe qorpera_company_run_read_paths by its primary key (run_id, path_key_sha256) instead of scanning all kept rows for the run.
select pg_temp.hp_replace(
	'public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)',
	$old$	where exists (select 1 from public.qorpera_company_run_read_paths kept
		where kept.run_id = (p_binding ->> 'runId')::uuid and kept.path = sent.path collate "C");$old$,
	$new$	where exists (select 1 from public.qorpera_company_run_read_paths kept
		where kept.run_id = (p_binding ->> 'runId')::uuid
			and kept.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(sent.path), 'sha256')
			and kept.path = sent.path collate "C");$new$
);

create or replace function public.qorpera_folder_path_resource(p_environment_id uuid, p_path text)
returns public.qorpera_company_path_resources language plpgsql stable security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_match record; v_key text; v_prefixes text[];
begin
	if not public.qorpera_company_path_valid(p_path, true) then return null; end if;
	v_key := public.qorpera_folder_key(p_path);
	if split_part(v_key, '/', 1) in ('credentials','secrets') then return null; end if;
	v_prefixes := array[''] || public.qorpera_folder_ancestors(v_key) || case when v_key = '' then '{}'::text[] else array[v_key] end;
	with matched as (
		select r,
			public.qorpera_folder_key(r.path) as rkey,
			count(*) over (partition by public.qorpera_folder_key(r.path)) as key_count
		from public.qorpera_company_path_resources r
		where r.environment_id = p_environment_id and public.qorpera_folder_key(r.path) = any (v_prefixes)
	)
	select m.r, m.key_count into v_match
	from matched m
	where m.rkey = v_key or (m.r).path_match = 'subtree'
	order by length(m.rkey) desc, (m.r).id limit 1;
	if not found or v_match.key_count > 1 then return null; end if;
	v_resource := v_match.r;
	if split_part(v_key, '/', 1) = 'members' and split_part(v_key, '/', 3) = 'private'
		and (v_resource.scope is distinct from 'member_private'
			or v_resource.owner_user_id::text is distinct from split_part(v_key, '/', 2)) then return null; end if;
	return v_resource;
end $$;

create or replace function public.qorpera_folder_read(p_environment_id uuid, p_actor jsonb, p_path text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_kind text := p_actor ->> 'kind';
	v_auth jsonb;
	v_profile_id uuid;
	v_last_seq bigint;
	v_resource public.qorpera_company_path_resources%rowtype;
	v_grant public.qorpera_company_path_grants%rowtype;
	v_allowed boolean;
	v_entry jsonb;
begin
	if not public.qorpera_folder_caller_allowed(p_actor) then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if not public.qorpera_company_path_valid(p_path) then raise exception 'Path is invalid' using errcode = '22023'; end if;
	select f.profile_id, k.last_seq into v_profile_id, v_last_seq
	from public.qorpera_company_files f
	join public.qorpera_folder_clocks k on k.environment_id = f.environment_id
	where f.environment_id = p_environment_id and f.core = 'folder-v2';
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if v_kind = 'platform' then
		v_allowed := true;
	else
		v_resource := public.qorpera_folder_path_resource(p_environment_id, p_path);
		v_allowed := public.qorpera_folder_actor_resource_allowed(v_profile_id, v_auth, v_resource, 'read');
	end if;
	if v_allowed then
		select public.qorpera_folder_entry_json(e.path, e.kind, e.version, c.seq,
				e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at)
			|| case when e.kind = 'symlink' then jsonb_build_object('target', e.target) else '{}'::jsonb end
		into v_entry
		from public.qorpera_folder_entries e
		left join public.qorpera_folder_commits c on c.id = e.commit_id
		where e.environment_id = p_environment_id and e.kind <> 'claim'
			and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_path), 'sha256');
		if v_entry is not null and v_auth ->> 'kind' = 'staff_agent' then
			if v_resource.id is not null then
				v_grant := public.qorpera_folder_agent_grant(v_resource, (v_auth ->> 'staffAgentId')::uuid, 'read');
				v_entry := v_entry || jsonb_build_object('authority', jsonb_build_object(
					'resourceId', v_resource.id, 'resourceRevision', v_resource.authority_revision,
					'grantId', v_grant.id, 'grantRevision', v_grant.revision));
			else
				v_entry := v_entry || jsonb_build_object('authority', null);
			end if;
		end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-read/v1', 'asOfSeq', v_last_seq,
		'found', v_entry is not null, 'entry', v_entry);
end $$;

alter policy qorpera_profile_staff_member_read on public.qorpera_profile_staff
	using (deleted_at is null and exists (
		select 1 from public.qorpera_profile_members member
		where member.profile_id = qorpera_profile_staff.profile_id and member.user_id = (select auth.uid())
	));

alter policy qorpera_profile_access_state_subject_or_member_read on public.qorpera_profile_access_state
	using (user_id = (select auth.uid()) or public.qorpera_can_read_profile(profile_id));

alter policy qorpera_member_pictures_insert on storage.objects
	with check (
		bucket_id = 'qorpera-member-pictures'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(webp|jpg|png)$'
				then (storage.foldername(name))[1] = (select auth.uid())::text
					and public.qorpera_member_picture_objects() < 4
			else false
		end
	);

alter policy qorpera_member_pictures_delete on storage.objects
	using (
		bucket_id = 'qorpera-member-pictures'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(webp|jpg|png)$'
				then (storage.foldername(name))[1] = (select auth.uid())::text
					and not public.qorpera_is_current_member_picture(name)
			else false
		end
	);

create index if not exists qorpera_profile_members_user_profile
	on public.qorpera_profile_members (user_id, profile_id);

create index if not exists qorpera_runner_jobs_leased_expires
	on public.qorpera_runner_jobs (lease_expires_at)
	where status = 'leased';

create index if not exists qorpera_company_path_grants_staff_active
	on public.qorpera_company_path_grants (resource_id, resource_version, principal_id, id)
	where principal_kind = 'staff_agent' and revoked_at is null;

drop index if exists
	public.qorpera_folder_object_gc_due,
	public.qorpera_surface_changes_session,
	public.qorpera_runner_model_requests_job,
	public.qorpera_agent_works_for_asks_profile,
	public.qorpera_coding_snapshots_node;
