-- Runtime Order 0 company-agent adapter. Agent identity and lifecycle are
-- canonical Company File state; the hosted roster, session, first-run input,
-- grants and deletion cascade are synchronized projections of one path
-- transaction. Generic path publication cannot bypass this adapter because a
-- deferred projection constraint rejects an unprojected agent document.

alter table public.qorpera_profile_staff
	add column source_path text,
	add column source_environment_id uuid,
	add column source_path_key_sha256 bytea generated always as (
		case when source_path is null then null
		else extensions.digest(public.qorpera_company_path_key(source_path),'sha256') end
	) stored,
	add column source_path_version uuid,
	add column source_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	add column source_file_sha256 text check (source_file_sha256 is null or source_file_sha256 ~ '^[0-9a-f]{64}$'),
	add column hire_overlay jsonb,
	add column reasoning_policy jsonb,
	add column startup_instructions text,
	add constraint qorpera_profile_staff_source_complete check (
		(source_path is null) = (source_environment_id is null)
		and (source_path is null) = (source_path_version is null)
		and (source_path is null) = (source_snapshot_id is null)
		and (source_path is null) = (hire_overlay is null)
		and (source_path is null) = (reasoning_policy is null)
		and (source_path is null) = (startup_instructions is null)
		and (source_path is not null or source_file_sha256 is null)
		and (source_path is null or deleted_at is not null or source_file_sha256 is not null)
	),
	add constraint qorpera_profile_staff_source_entry foreign key (
		source_environment_id,source_path_key_sha256,source_path_version
	) references public.qorpera_company_path_entries(environment_id,path_key_sha256,version)
		deferrable initially deferred;

create unique index qorpera_profile_staff_source_path
	on public.qorpera_profile_staff(profile_id,source_path_key_sha256)
	where source_path is not null;

create table public.qorpera_agent_first_runs (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	session_id uuid not null unique references public.qorpera_shared_sessions(id) on delete restrict,
	input_id uuid not null unique references public.qorpera_session_inputs(id) on delete restrict,
	source_path_version uuid not null,
	startup_assignment jsonb not null check (
		jsonb_typeof(startup_assignment) = 'object' and pg_column_size(startup_assignment) <= 32768
	),
	created_at timestamptz not null default statement_timestamp(),
	primary key (profile_id,staff_agent_id),
	foreign key (profile_id,environment_id)
		references public.qorpera_company_files(profile_id,environment_id) on delete cascade,
	foreign key (profile_id,staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict
);
alter table public.qorpera_agent_first_runs enable row level security;
revoke all on public.qorpera_agent_first_runs from public,anon,authenticated,service_role;

-- Responsibility grants live with the organization projection (19200); this
-- adapter writes them from exact agent-document versions.
create table public.qorpera_agent_project_grants (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	staff_agent_id uuid not null,
	project_id uuid not null,
	source_path_version uuid not null,
	primary key (profile_id,staff_agent_id,project_id),
	foreign key (profile_id,staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete cascade,
	foreign key (profile_id,project_id)
		references public.qorpera_company_projects(profile_id,id) on delete cascade
);
create table public.qorpera_agent_room_grants (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	staff_agent_id uuid not null,
	room_id uuid not null,
	source_path_version uuid not null,
	primary key (profile_id,staff_agent_id,room_id),
	foreign key (profile_id,staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete cascade
);
alter table public.qorpera_company_path_grants
	add column source_agent_profile_id uuid,
	add column source_staff_agent_id uuid,
	add column source_agent_path_version uuid,
	add constraint qorpera_company_path_grants_agent_source_complete check (
		(source_agent_profile_id is null) = (source_staff_agent_id is null)
		and (source_agent_profile_id is null) = (source_agent_path_version is null)
	),
	add constraint qorpera_company_path_grants_agent_source foreign key (
		source_agent_profile_id,source_staff_agent_id
	) references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete cascade;
create unique index qorpera_company_path_grants_agent_source
	on public.qorpera_company_path_grants(source_agent_profile_id,source_staff_agent_id,resource_id)
	where source_agent_profile_id is not null;
alter table public.qorpera_agent_project_grants enable row level security;
alter table public.qorpera_agent_room_grants enable row level security;
revoke all on public.qorpera_agent_project_grants,
	public.qorpera_agent_room_grants from public,anon,authenticated,service_role;

-- Once the canonical bootstrap has completed, authenticated roster RPCs are
-- no longer a writer. Staff identity is a projection of the Company File and
-- must advance in the same transaction as its source path. Service-owned
-- projectors and pre-bootstrap adoption remain available.
create function public.qorpera_guard_company_file_staff_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if coalesce(auth.role(),'') = 'authenticated' and exists (
		select 1 from public.qorpera_company_bootstrap_jobs job
		where job.profile_id = new.profile_id and job.state = 'completed'
	) then
		raise exception 'Company File-backed staff must be changed through its lifecycle operation'
			using errcode = '42501';
	end if;
	return new;
end
$$;
create trigger qorpera_profile_staff_company_file_writer
before insert or update on public.qorpera_profile_staff
for each row execute function public.qorpera_guard_company_file_staff_write();

-- Restoring an archived agent may create a new open conversation, but it may
-- never fabricate another first-run wake. Legacy staff without an admitted
-- first-run ledger retain the old one-kickoff behavior.
create or replace function public.qorpera_ensure_staff_session(
	p_environment_id uuid,p_staff_agent_id text,p_client_session_id uuid,p_title text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype; v_created boolean := false;
	v_staff_uuid uuid;
begin
	select environment.profile_id into v_profile_id from public.qorpera_company_environments environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501'; end if;
	if p_client_session_id is null then raise exception 'client session id is required' using errcode = '22023'; end if;
	if p_staff_agent_id is null or char_length(btrim(p_staff_agent_id)) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023'; end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023'; end if;
	if btrim(p_staff_agent_id) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		v_staff_uuid := btrim(p_staff_agent_id)::uuid;
	end if;
	insert into public.qorpera_shared_sessions(profile_id,environment_id,client_session_id,title,staff_agent_id,
		audience_kind,audience_user_id,created_by_user_id)
	values (v_profile_id,p_environment_id,p_client_session_id,btrim(p_title),btrim(p_staff_agent_id),
		'company',null,v_user_id)
	on conflict (profile_id,staff_agent_id) where status = 'open' and staff_agent_id is not null
		and audience_kind = 'company'
		and not (execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])
	do nothing returning * into v_session;
	v_created := found;
	if v_created then
		if v_staff_uuid is null or not exists (
			select 1 from public.qorpera_agent_first_runs first_run
			where first_run.profile_id = v_profile_id and first_run.staff_agent_id = v_staff_uuid
		) then
			insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id)
			values (v_session.id,v_session.id,'kickoff',v_user_id);
		end if;
	else
		select session.* into v_session from public.qorpera_shared_sessions session
		where session.profile_id = v_profile_id and session.staff_agent_id = btrim(p_staff_agent_id)
			and session.status = 'open' and session.audience_kind = 'company'
			and not (session.execution_scope ?| array['autonomousLabel','roomId','group','parentSession']);
		if not found then raise exception 'staff session could not be adopted' using errcode = '40001'; end if;
	end if;
	return jsonb_build_object('session_id',v_session.id,'client_session_id',v_session.client_session_id,
		'environment_id',v_session.environment_id,'title',v_session.title,
		'company_snapshot_id',v_session.company_snapshot_id,'staff_version',v_session.staff_version,
		'audience_kind',v_session.audience_kind,'audience_user_id',v_session.audience_user_id,
		'created',v_created,'created_by_user_id',v_session.created_by_user_id,'created_at',v_session.created_at);
end
$$;

create function public.qorpera_company_agent_path_id(p_path text)
returns uuid language plpgsql immutable set search_path = '' as $$
declare v_path text := public.qorpera_company_path_key(p_path);
begin
	if v_path ~ '^organization/agents/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return substring(split_part(v_path,'/',3) from 1 for 36)::uuid;
	end if;
	return null;
end
$$;

create function public.qorpera_project_company_agent_grants(
	p_actor jsonb,p_staff_agent_id uuid,p_grants jsonb,p_source_path_version uuid,p_active boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_profile_id uuid := (p_actor ->> 'companyId')::uuid;
	v_environment_id uuid := (p_actor ->> 'environmentId')::uuid;
	v_user_id uuid := (p_actor ->> 'userId')::uuid;
	v_actor_staff_id uuid := nullif(p_actor ->> 'staffAgentId','')::uuid;
	v_role public.qorpera_profile_role; v_responsibility_id uuid; v_project_id uuid; v_room_id uuid;
	v_item jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_permissions text[];
	v_responsibility_ids uuid[] := '{}'::uuid[]; v_project_ids uuid[] := '{}'::uuid[]; v_room_ids uuid[] := '{}'::uuid[];
	v_resource_ids uuid[] := '{}'::uuid[];
begin
	if jsonb_typeof(p_grants) <> 'object'
		or not (p_grants ?& array['responsibilities','projects','rooms','resources'])
		or p_grants - array['responsibilities','projects','rooms','resources'] <> '{}'::jsonb
		or jsonb_typeof(p_grants -> 'responsibilities') <> 'array'
		or jsonb_typeof(p_grants -> 'projects') <> 'array'
		or jsonb_typeof(p_grants -> 'rooms') <> 'array'
		or jsonb_typeof(p_grants -> 'resources') <> 'array'
		or jsonb_array_length(p_grants -> 'responsibilities') > 128
		or jsonb_array_length(p_grants -> 'projects') > 128
		or jsonb_array_length(p_grants -> 'rooms') > 128
		or jsonb_array_length(p_grants -> 'resources') > 256 then
		raise exception 'Agent grants are invalid' using errcode = '22023'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = v_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role = 'viewer' then
		raise exception 'Agent grant authority is unavailable' using errcode = '42501'; end if;
	if v_actor_staff_id is not null and not exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = v_profile_id and staff.staff_agent_id = v_actor_staff_id
			and staff.employment_status = 'active' and staff.deleted_at is null) then
		raise exception 'Creating agent is unavailable' using errcode = '42501'; end if;
	for v_item in select value from jsonb_array_elements(p_grants -> 'responsibilities') loop
		if jsonb_typeof(v_item) <> 'string' or v_item #>> '{}' !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Agent responsibility grant is invalid' using errcode = '22023'; end if;
		v_responsibility_id := (v_item #>> '{}')::uuid;
		if v_responsibility_id = any(v_responsibility_ids)
			or not exists (select 1 from public.qorpera_company_responsibilities responsibility
				where responsibility.profile_id = v_profile_id and responsibility.id = v_responsibility_id
					and responsibility.status <> 'retired') then
			raise exception 'Agent responsibility grant is unavailable' using errcode = '42501'; end if;
		-- A creating agent may delegate only a responsibility it is
		-- accountable for or already holds a grant within.
		if v_actor_staff_id is not null and not (
			exists (select 1 from public.qorpera_company_responsibilities responsibility
				where responsibility.profile_id = v_profile_id and responsibility.id = v_responsibility_id
					and responsibility.accountable_staff_agent_id = v_actor_staff_id)
			or exists (select 1 from public.qorpera_agent_responsibility_grants grant_row
				where grant_row.profile_id = v_profile_id and grant_row.staff_agent_id = v_actor_staff_id
					and grant_row.responsibility_id = v_responsibility_id)
		) then raise exception 'Creating agent cannot delegate that responsibility' using errcode = '42501'; end if;
		v_responsibility_ids := array_append(v_responsibility_ids,v_responsibility_id);
	end loop;
	for v_item in select value from jsonb_array_elements(p_grants -> 'projects') loop
		if jsonb_typeof(v_item) <> 'string' or v_item #>> '{}' !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Agent project grant is invalid' using errcode = '22023'; end if;
		v_project_id := (v_item #>> '{}')::uuid;
		if v_project_id = any(v_project_ids) or not exists (select 1 from public.qorpera_company_projects project
			where project.profile_id = v_profile_id and project.id = v_project_id
				and project.status not in ('completed','cancelled')) then
			raise exception 'Agent project grant is unavailable' using errcode = '42501'; end if;
		if v_actor_staff_id is not null and not (
			exists (select 1 from public.qorpera_agent_project_grants grant_row
				where grant_row.profile_id = v_profile_id and grant_row.staff_agent_id = v_actor_staff_id
					and grant_row.project_id = v_project_id)
			or exists (select 1 from public.qorpera_project_staff_memberships membership
				where membership.profile_id = v_profile_id and membership.staff_agent_id = v_actor_staff_id
					and membership.project_id = v_project_id and membership.status = 'active')
		) then raise exception 'Creating agent cannot delegate that project' using errcode = '42501'; end if;
		v_project_ids := array_append(v_project_ids,v_project_id);
	end loop;
	for v_item in select value from jsonb_array_elements(p_grants -> 'rooms') loop
		if jsonb_typeof(v_item) <> 'string' or v_item #>> '{}' !~
			'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Agent room grant is invalid' using errcode = '22023'; end if;
		v_room_id := (v_item #>> '{}')::uuid;
		if v_room_id = any(v_room_ids) then
			raise exception 'Agent room grant is duplicated' using errcode = '22023'; end if;
		if v_actor_staff_id is not null and not exists (select 1 from public.qorpera_agent_room_grants grant_row
			where grant_row.profile_id = v_profile_id and grant_row.staff_agent_id = v_actor_staff_id
				and grant_row.room_id = v_room_id) then
			raise exception 'Creating agent cannot delegate that room' using errcode = '42501'; end if;
		v_room_ids := array_append(v_room_ids,v_room_id);
	end loop;
	if v_actor_staff_id is null and v_role not in ('owner','admin') and (
		cardinality(v_responsibility_ids) > 0 or cardinality(v_project_ids) > 0 or cardinality(v_room_ids) > 0
		or jsonb_array_length(p_grants -> 'resources') > 0
	) then raise exception 'Agent grants require founder authority' using errcode = '42501'; end if;
	delete from public.qorpera_agent_responsibility_grants
	where profile_id = v_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_agent_project_grants
	where profile_id = v_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_agent_room_grants
	where profile_id = v_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_company_path_grants
	where source_agent_profile_id = v_profile_id and source_staff_agent_id = p_staff_agent_id;
	insert into public.qorpera_agent_responsibility_grants(profile_id,staff_agent_id,responsibility_id,source_path_version)
	select v_profile_id,p_staff_agent_id,id,p_source_path_version from unnest(v_responsibility_ids) id;
	insert into public.qorpera_agent_project_grants(profile_id,staff_agent_id,project_id,source_path_version)
	select v_profile_id,p_staff_agent_id,id,p_source_path_version from unnest(v_project_ids) id;
	insert into public.qorpera_agent_room_grants(profile_id,staff_agent_id,room_id,source_path_version)
	select v_profile_id,p_staff_agent_id,id,p_source_path_version from unnest(v_room_ids) id;
	for v_item in select value from jsonb_array_elements(p_grants -> 'resources') loop
		if jsonb_typeof(v_item) <> 'object'
			or not (v_item ?& array['resourceId','resourceVersion','permissions'])
			or v_item - array['resourceId','resourceVersion','permissions'] <> '{}'::jsonb
			or v_item ->> 'resourceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or v_item ->> 'resourceVersion' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or v_item -> 'permissions' not in ('["read"]'::jsonb,'["read","write"]'::jsonb) then
			raise exception 'Agent resource grant is invalid' using errcode = '22023'; end if;
		select resource.* into v_resource from public.qorpera_company_path_resources resource
		where resource.id = (v_item ->> 'resourceId')::uuid and resource.environment_id = v_environment_id
			and resource.version = (v_item ->> 'resourceVersion')::uuid and resource.revoked_at is null for share;
		if not found or v_resource.id = any(v_resource_ids) then
			raise exception 'Agent resource grant is unavailable' using errcode = '42501'; end if;
		v_permissions := array(select value #>> '{}' from jsonb_array_elements(v_item -> 'permissions') value);
		if v_actor_staff_id is not null and (
			not public.qorpera_company_path_principal_allowed(
				v_profile_id,v_resource,'staff_agent',v_actor_staff_id,'read'
			) or ('write' = any(v_permissions) and not public.qorpera_company_path_principal_allowed(
				v_profile_id,v_resource,'staff_agent',v_actor_staff_id,'write'
			))
		) then raise exception 'Creating agent cannot delegate that resource' using errcode = '42501'; end if;
		if p_active then
			insert into public.qorpera_company_path_grants(resource_id,resource_version,principal_kind,principal_id,
				permissions,created_by_user_id,source_agent_profile_id,source_staff_agent_id,source_agent_path_version)
			values (v_resource.id,v_resource.version,'staff_agent',p_staff_agent_id,v_permissions,v_user_id,
				v_profile_id,p_staff_agent_id,p_source_path_version);
		end if;
		v_resource_ids := array_append(v_resource_ids,v_resource.id);
	end loop;
exception when invalid_text_representation or array_subscript_error or not_null_violation
	or check_violation or foreign_key_violation or unique_violation then
	raise exception 'Agent grants are invalid' using errcode = '22023';
end
$$;

create or replace function public.qorpera_company_path_protected(
	p_resource public.qorpera_company_path_resources,p_plan jsonb
)
returns boolean language sql immutable set search_path = '' as $$
	select p_resource.policy = 'protected' or p_plan -> 'entry' = 'null'::jsonb
		or public.qorpera_company_path_key(p_plan ->> 'path') in ('authority.toml','agents.md','claude.md')
		or split_part(public.qorpera_company_path_key(p_plan ->> 'path'),'/',1)
			in ('finance','money','identity','membership','production')
		or public.qorpera_organization_path_kind(p_plan ->> 'path') is not null
		or public.qorpera_company_agent_path_id(p_plan ->> 'path') is not null
$$;

create function public.qorpera_tombstone_profile_staff(
	p_profile_id uuid,p_staff_agent_id uuid,p_expected_version bigint,p_actor uuid,
	p_source_path_version uuid default null,p_source_snapshot_id uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_staff public.qorpera_profile_staff%rowtype; v_now timestamptz := statement_timestamp();
begin
	select * into v_staff from public.qorpera_profile_staff staff
	where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id for update;
	if not found or v_staff.deleted_at is not null then return; end if;
	if v_staff.version <> p_expected_version then
		raise exception 'staff version conflict' using errcode = '40001'; end if;
	if exists (select 1 from public.qorpera_company_cofounders cofounder
		where cofounder.profile_id = p_profile_id and cofounder.staff_agent_id = p_staff_agent_id) then
		raise exception 'the company Co-Founder cannot be permanently deleted' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_company_responsibilities responsibility
		where responsibility.profile_id = p_profile_id
			and responsibility.accountable_staff_agent_id = p_staff_agent_id
			and responsibility.status <> 'retired')
		or exists (select 1 from public.qorpera_company_projects project
			where project.profile_id = p_profile_id and project.lead_staff_agent_id = p_staff_agent_id
				and project.status not in ('completed','cancelled')) then
		raise exception 'reassign active organizational responsibilities before deleting this agent' using errcode = '55000';
	end if;
	update public.qorpera_project_staff_memberships set status = 'ended',ended_at = coalesce(ended_at,v_now)
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id and status = 'active';
	update public.qorpera_cloud_routines routine set status = 'retired',updated_at = v_now
	where routine.profile_id = p_profile_id and routine.status <> 'retired' and exists (
		select 1 from public.qorpera_cloud_routine_versions version
		where version.routine_id = routine.id and version.version = routine.current_version
			and version.staff_agent_id = p_staff_agent_id
	);
	update public.qorpera_cloud_secret_operation_grants set status = 'revoked',revoked_at = v_now,
		revoked_by_user_id = p_actor
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id and status = 'active';
	delete from public.qorpera_company_path_grants
	where principal_kind = 'staff_agent' and principal_id = p_staff_agent_id;
	delete from public.qorpera_agent_responsibility_grants
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_agent_project_grants
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_agent_room_grants
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_staff_execution_authorities
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_staff_provider_models
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_session_execution_bindings binding using public.qorpera_shared_sessions session
	where binding.session_id = session.id and session.profile_id = p_profile_id
		and session.staff_agent_id = p_staff_agent_id::text;
	update public.qorpera_shared_sessions set status = 'closed',updated_at = v_now
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id::text and status = 'open';
	update public.qorpera_artifacts set deleted_at = v_now,deleted_by_user_id = p_actor
	where profile_id = p_profile_id and owner_staff_agent_id = p_staff_agent_id and deleted_at is null;
	update public.qorpera_profile_staff set display_name = 'Deleted agent',role = 'Deleted agent',
		charter = 'Deleted staff identity retained only for immutable operation history.',
		template_id = null,department_id = null,appearance_color = 'deleted',appearance_shape = 'round',
		appearance_creature = null,model_provider = null,model_id = null,employment_status = 'archived',
		version = version + 1,updated_at = v_now,updated_by_user_id = p_actor,
		deleted_at = v_now,deleted_by_user_id = p_actor,
		source_path_version = coalesce(p_source_path_version,source_path_version),
		source_snapshot_id = coalesce(p_source_snapshot_id,source_snapshot_id),source_file_sha256 = null,
		hire_overlay = case when p_source_path_version is null then hire_overlay else
			jsonb_build_object('charter','Deleted staff identity retained only for immutable operation history.','templateId',null) end,
		reasoning_policy = case when p_source_path_version is null then reasoning_policy else '{"effort":"low"}'::jsonb end,
		startup_instructions = case when p_source_path_version is null then startup_instructions else
			'Deleted staff identity retained only for immutable operation history.' end
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
end
$$;

create or replace function public.qorpera_delete_profile_staff(
	p_profile_id uuid,p_staff_agent_id uuid,p_expected_version bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_role public.qorpera_profile_role;
	v_staff public.qorpera_profile_staff%rowtype;
begin
	if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_actor;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'deleting staff requires full profile access' using errcode = '42501'; end if;
	if p_staff_agent_id is null or p_expected_version is null or p_expected_version < 1 then
		raise exception 'staff deletion input is invalid' using errcode = '22023'; end if;
	select * into v_staff from public.qorpera_profile_staff staff
	where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id for update;
	if not found or v_staff.deleted_at is not null then return 'true'::jsonb; end if;
	if v_staff.source_path is not null then
		raise exception 'Company File-backed staff must be deleted through its lifecycle operation' using errcode = '42501';
	end if;
	perform public.qorpera_tombstone_profile_staff(p_profile_id,p_staff_agent_id,p_expected_version,v_actor);
	return 'true'::jsonb;
end
$$;

create function public.qorpera_project_company_agent_document(
	p_actor jsonb,p_plan jsonb,p_document_text text,p_snapshot_id uuid,p_path_version uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_id uuid := public.qorpera_company_agent_path_id(p_plan ->> 'path'); v_document jsonb;
	v_profile_id uuid := (p_actor ->> 'companyId')::uuid; v_environment_id uuid := (p_actor ->> 'environmentId')::uuid;
	v_user_id uuid := (p_actor ->> 'userId')::uuid; v_role public.qorpera_profile_role;
	v_staff public.qorpera_profile_staff%rowtype; v_session public.qorpera_shared_sessions%rowtype;
	v_input uuid; v_assignment jsonb; v_created_at timestamptz; v_model jsonb; v_hire jsonb;
	v_reasoning jsonb; v_appearance jsonb; v_grants jsonb; v_was_active boolean;
begin
	if v_id is null then
		if p_document_text is not null and public.qorpera_organization_path_kind(p_plan ->> 'path') is null then
			raise exception 'Agent document supplied for an ordinary path' using errcode = '22023'; end if;
		return;
	end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = v_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role = 'viewer' then
		raise exception 'Agent lifecycle requires company write authority' using errcode = '42501'; end if;
	select * into v_staff from public.qorpera_profile_staff staff
	where staff.profile_id = v_profile_id and staff.staff_agent_id = v_id for update;
	if p_plan -> 'entry' = 'null'::jsonb then
		if p_document_text is not null or not found or v_staff.source_path is null
			or p_actor ->> 'staffAgentId' is not null or v_role not in ('owner','admin') then
			raise exception 'Agent deletion authority is unavailable' using errcode = '42501'; end if;
		perform public.qorpera_tombstone_profile_staff(
			v_profile_id,v_id,v_staff.version,v_user_id,p_path_version,p_snapshot_id
		);
		return;
	end if;
	if p_plan #>> '{entry,kind}' is distinct from 'file' or p_document_text is null
		or octet_length(convert_to(p_document_text,'utf8')) not between 2 and 32768
		or encode(extensions.digest(convert_to(p_document_text,'utf8'),'sha256'),'hex')
			is distinct from p_plan #>> '{entry,file,fileSha256}' then
		raise exception 'Agent document bytes do not match the Company File mutation' using errcode = '22023'; end if;
	v_document := p_document_text::jsonb;
	if jsonb_typeof(v_document) <> 'object'
		or not (v_document ?& array['schema','agentId','revision','displayName','role','hireOverlay','appearance',
			'modelPolicy','reasoningPolicy','grants','startupInstructions','employmentStatus','lifecycleState','createdAt'])
		or v_document - array['schema','agentId','revision','displayName','role','hireOverlay','appearance',
			'modelPolicy','reasoningPolicy','grants','startupInstructions','employmentStatus','lifecycleState','createdAt'] <> '{}'::jsonb
		or v_document ->> 'schema' <> 'qorpera.company-agent/v1'
		or (v_document ->> 'agentId')::uuid <> v_id
		or (v_document ->> 'revision') !~ '^[1-9][0-9]*$'
		or char_length(btrim(v_document ->> 'displayName')) not between 1 and 160
		or v_document ->> 'displayName' <> btrim(v_document ->> 'displayName')
		or char_length(btrim(v_document ->> 'role')) not between 1 and 320
		or v_document ->> 'role' <> btrim(v_document ->> 'role')
		or octet_length(convert_to(v_document ->> 'startupInstructions','utf8')) not between 1 and 16384
		or v_document ->> 'startupInstructions' <> btrim(v_document ->> 'startupInstructions')
		or v_document ->> 'employmentStatus' not in ('active','archived')
		or v_document ->> 'lifecycleState' not in ('setup','active') then
		raise exception 'Agent document is invalid' using errcode = '22023'; end if;
	v_hire := v_document -> 'hireOverlay'; v_appearance := v_document -> 'appearance';
	v_model := v_document -> 'modelPolicy'; v_reasoning := v_document -> 'reasoningPolicy';
	v_grants := v_document -> 'grants';
	if jsonb_typeof(v_hire) <> 'object' or v_hire - array['charter','templateId'] <> '{}'::jsonb
		or not (v_hire ?& array['charter','templateId'])
		or octet_length(convert_to(v_hire ->> 'charter','utf8')) not between 1 and 32768
		or v_hire ->> 'charter' <> btrim(v_hire ->> 'charter')
		or (v_hire -> 'templateId' <> 'null'::jsonb and (jsonb_typeof(v_hire -> 'templateId') <> 'string'
			or char_length(v_hire ->> 'templateId') not between 1 and 256 or v_hire ->> 'templateId' <> btrim(v_hire ->> 'templateId')))
		or jsonb_typeof(v_appearance) <> 'object' or v_appearance - array['color','shape','creature'] <> '{}'::jsonb
		or not (v_appearance ?& array['color','shape','creature'])
		or char_length(v_appearance ->> 'color') not between 1 and 64
		or char_length(v_appearance ->> 'shape') not between 1 and 64
		or (v_appearance -> 'creature' <> 'null'::jsonb and char_length(v_appearance ->> 'creature') not between 1 and 64)
		or jsonb_typeof(v_model) <> 'object' or v_model - array['provider','modelId'] <> '{}'::jsonb
		or not (v_model ?& array['provider','modelId'])
		or ((v_model -> 'provider' = 'null'::jsonb) <> (v_model -> 'modelId' = 'null'::jsonb))
		or (v_model -> 'provider' <> 'null'::jsonb and (char_length(v_model ->> 'provider') not between 1 and 128
			or char_length(v_model ->> 'modelId') not between 1 and 256))
		or v_reasoning <> '{"effort":"low"}'::jsonb
		or jsonb_typeof(v_grants) <> 'object' then
		raise exception 'Agent policy or grants are invalid' using errcode = '22023'; end if;
	v_created_at := (v_document ->> 'createdAt')::timestamptz;
	if v_staff.profile_id is not null and v_staff.source_path is null and exists (
		select 1 from public.qorpera_company_cofounders cofounder
		join public.qorpera_company_bootstrap_jobs job on job.profile_id = cofounder.profile_id
		where cofounder.profile_id = v_profile_id and cofounder.staff_agent_id = v_id
			and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
			and job.cofounder_agent_document::jsonb = v_document
	) then
		if (v_document ->> 'revision')::bigint <> v_staff.version
			or v_document ->> 'employmentStatus' <> 'active' or v_document ->> 'lifecycleState' <> 'setup'
			or v_created_at <> v_staff.created_at or v_document ->> 'displayName' <> v_staff.display_name
			or v_document ->> 'role' <> v_staff.role or v_hire ->> 'charter' <> v_staff.charter
			or nullif(v_hire ->> 'templateId','') is distinct from v_staff.template_id
			or v_appearance ->> 'color' <> v_staff.appearance_color
			or v_appearance ->> 'shape' <> v_staff.appearance_shape
			or nullif(v_appearance ->> 'creature','') is distinct from v_staff.appearance_creature
			or nullif(v_model ->> 'provider','') is distinct from v_staff.model_provider
			or nullif(v_model ->> 'modelId','') is distinct from v_staff.model_id then
			raise exception 'Co-Founder agent document differs from its bootstrap identity' using errcode = '42501'; end if;
		update public.qorpera_profile_staff set source_path = p_plan ->> 'path',source_path_version = p_path_version,
			source_environment_id = v_environment_id,source_snapshot_id = p_snapshot_id,
			source_file_sha256 = p_plan #>> '{entry,file,fileSha256}',hire_overlay = v_hire,
			reasoning_policy = v_reasoning,startup_instructions = v_document ->> 'startupInstructions',
			updated_at = statement_timestamp(),updated_by_user_id = v_user_id
		where profile_id = v_profile_id and staff_agent_id = v_id;
		perform public.qorpera_project_company_agent_grants(
			p_actor,v_id,v_grants,p_path_version,true
		);
		return;
	end if;
	if v_staff.profile_id is null then
		if (v_document ->> 'revision')::bigint <> 1 or v_document ->> 'employmentStatus' <> 'active'
			or exists (select 1 from public.qorpera_company_cofounders cofounder
				where cofounder.profile_id = v_profile_id and cofounder.staff_agent_id = v_id) then
			raise exception 'Initial agent revision is invalid' using errcode = '22023'; end if;
		insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,template_id,
			appearance_color,appearance_shape,appearance_creature,model_provider,model_id,employment_status,
			lifecycle_state,version,created_at,updated_at,updated_by_user_id,source_path,source_path_version,
			source_environment_id,source_snapshot_id,source_file_sha256,hire_overlay,reasoning_policy,startup_instructions)
		values (v_profile_id,v_id,v_document ->> 'displayName',v_document ->> 'role',v_hire ->> 'charter',
			nullif(v_hire ->> 'templateId',''),v_appearance ->> 'color',v_appearance ->> 'shape',
			nullif(v_appearance ->> 'creature',''),nullif(v_model ->> 'provider',''),nullif(v_model ->> 'modelId',''),
			'active',v_document ->> 'lifecycleState',1,v_created_at,v_created_at,v_user_id,p_plan ->> 'path',
			p_path_version,v_environment_id,p_snapshot_id,p_plan #>> '{entry,file,fileSha256}',v_hire,v_reasoning,
			v_document ->> 'startupInstructions');
		insert into public.qorpera_shared_sessions(profile_id,environment_id,client_session_id,title,staff_agent_id,
			audience_kind,audience_user_id,created_by_user_id)
		values (v_profile_id,v_environment_id,p_path_version,v_document ->> 'displayName',v_id::text,
			'company',null,v_user_id)
		returning * into v_session;
		v_assignment := jsonb_build_object('schema','qorpera.agent-first-run/v1','assignment',jsonb_build_object(
			'kind','staff_startup','companyId',v_profile_id,'staffAgentId',v_id,
			'sourcePath',p_plan ->> 'path','sourcePathVersion',p_path_version,
			'startupInstructions',v_document ->> 'startupInstructions'));
		insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
		values (v_session.id,p_path_version,'kickoff',v_user_id,v_assignment) returning id into v_input;
		insert into public.qorpera_agent_first_runs(profile_id,environment_id,staff_agent_id,session_id,input_id,
			source_path_version,startup_assignment)
		values (v_profile_id,v_environment_id,v_id,v_session.id,v_input,p_path_version,v_assignment);
		perform public.qorpera_project_company_agent_grants(
			p_actor,v_id,v_grants,p_path_version,true
		);
	else
		if v_staff.deleted_at is not null or v_staff.source_path is null
			or v_staff.source_path <> p_plan ->> 'path'
			or (v_document ->> 'revision')::bigint <> v_staff.version + 1
			or v_created_at <> v_staff.created_at then
			raise exception 'Agent revision is invalid' using errcode = '22023'; end if;
		if exists (select 1 from public.qorpera_company_cofounders cofounder
			where cofounder.profile_id = v_profile_id and cofounder.staff_agent_id = v_id)
			and v_document ->> 'employmentStatus' <> 'active' then
			raise exception 'the company Co-Founder cannot be archived' using errcode = '42501'; end if;
		v_was_active := v_staff.employment_status = 'active';
		update public.qorpera_profile_staff set display_name = v_document ->> 'displayName',
			role = v_document ->> 'role',charter = v_hire ->> 'charter',template_id = nullif(v_hire ->> 'templateId',''),
			appearance_color = v_appearance ->> 'color',appearance_shape = v_appearance ->> 'shape',
			appearance_creature = nullif(v_appearance ->> 'creature',''),model_provider = nullif(v_model ->> 'provider',''),
			model_id = nullif(v_model ->> 'modelId',''),employment_status = v_document ->> 'employmentStatus',
			lifecycle_state = v_document ->> 'lifecycleState',version = version + 1,updated_at = statement_timestamp(),
			updated_by_user_id = v_user_id,source_path_version = p_path_version,source_snapshot_id = p_snapshot_id,
			source_file_sha256 = p_plan #>> '{entry,file,fileSha256}',hire_overlay = v_hire,
			reasoning_policy = v_reasoning,startup_instructions = v_document ->> 'startupInstructions'
		where profile_id = v_profile_id and staff_agent_id = v_id;
		perform public.qorpera_project_company_agent_grants(
			p_actor,v_id,v_grants,p_path_version,v_document ->> 'employmentStatus' = 'active'
		);
		if v_was_active and v_document ->> 'employmentStatus' = 'archived' then
			update public.qorpera_cloud_routines routine set status = 'paused',updated_at = statement_timestamp()
			where routine.profile_id = v_profile_id and routine.status = 'active' and exists (
				select 1 from public.qorpera_cloud_routine_versions version
				where version.routine_id = routine.id and version.version = routine.current_version
					and version.staff_agent_id = v_id
			);
			update public.qorpera_cloud_secret_operation_grants set status = 'revoked',revoked_at = statement_timestamp(),
				revoked_by_user_id = v_user_id
			where profile_id = v_profile_id and staff_agent_id = v_id and status = 'active';
			delete from public.qorpera_staff_execution_authorities
			where profile_id = v_profile_id and staff_agent_id = v_id;
			delete from public.qorpera_session_execution_bindings binding using public.qorpera_shared_sessions session
			where binding.session_id = session.id and session.profile_id = v_profile_id and session.staff_agent_id = v_id::text;
			update public.qorpera_shared_sessions set status = 'closed',updated_at = statement_timestamp()
			where profile_id = v_profile_id and staff_agent_id = v_id::text and status = 'open';
		end if;
	end if;
exception when invalid_text_representation or datetime_field_overflow or not_null_violation or check_violation
	or foreign_key_violation or unique_violation then
	raise exception 'Agent document is invalid' using errcode = '22023';
end
$$;

-- Company bootstrap imports formation, responsibility, project and agent documents
-- from one verified immutable tree. Every recognized document is projected
-- before the deferred path constraints can expose the new head.
create function public.qorpera_enable_company_path_gateway_v3(
	p_environment_id uuid,p_snapshot_id uuid,p_authorized_user_id uuid,p_company_documents jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_entry public.qorpera_company_path_entries%rowtype;
	v_document record; v_text text; v_actor jsonb;
begin
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_company_documents) <> 'object'
		or octet_length(convert_to(p_company_documents::text,'utf8')) > 8388608 then
		raise exception 'Company File projected cutover is invalid' using errcode = '22023'; end if;
	for v_document in select key,value from jsonb_each(p_company_documents) loop
		if v_document.key <> public.qorpera_company_path_key(v_document.key)
			or (public.qorpera_organization_path_kind(v_document.key) is null
				and public.qorpera_company_agent_path_id(v_document.key) is null)
			or jsonb_typeof(v_document.value) <> 'string'
			or octet_length(convert_to(v_document.value #>> '{}','utf8')) not between 2 and 32768 then
			raise exception 'Company File projected cutover is invalid' using errcode = '22023'; end if;
	end loop;
	perform public.qorpera_enable_company_path_gateway(p_environment_id,p_snapshot_id,p_authorized_user_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id;
	v_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',p_environment_id,
		'userId',p_authorized_user_id,'audience','human');
	for v_entry in select entry.* from public.qorpera_company_path_entries entry
		where entry.environment_id = p_environment_id and (
			public.qorpera_organization_path_kind(entry.path) is not null
			or public.qorpera_company_agent_path_id(entry.path) is not null
		) order by entry.path loop
		v_text := p_company_documents ->> public.qorpera_company_path_key(v_entry.path);
		if v_text is null then
			raise exception 'Company File projected document is missing at cutover' using errcode = '22023'; end if;
		if public.qorpera_organization_path_kind(v_entry.path) is not null then
			perform public.qorpera_project_organization_document(v_actor,
				jsonb_build_object('path',v_entry.path,'entry',v_entry.entry),v_text,p_snapshot_id,v_entry.version);
		else
			perform public.qorpera_project_company_agent_document(v_actor,
				jsonb_build_object('path',v_entry.path,'entry',v_entry.entry),v_text,p_snapshot_id,v_entry.version);
		end if;
	end loop;
	if (select count(*) from jsonb_object_keys(p_company_documents)) is distinct from (
		select count(*) from public.qorpera_company_path_entries entry
		where entry.environment_id = p_environment_id and (
			public.qorpera_organization_path_kind(entry.path) is not null
			or public.qorpera_company_agent_path_id(entry.path) is not null
		)
	) then raise exception 'Company File projected cutover is invalid' using errcode = '22023'; end if;
end
$$;

create function public.qorpera_assert_company_agent_projection()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public.qorpera_company_agent_path_id(new.path); v_head uuid;
begin
	if v_id is null then return new; end if;
	select file.head_snapshot_id into v_head from public.qorpera_company_files file
	where file.environment_id = new.environment_id;
	if new.entry is null then
		if not exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = (select profile_id from public.qorpera_company_files where environment_id = new.environment_id)
				and staff.staff_agent_id = v_id and staff.deleted_at is not null
				and staff.source_path_key_sha256 = new.path_key_sha256 and staff.source_path_version = new.version
				and staff.source_snapshot_id = v_head and staff.source_file_sha256 is null) then
			raise exception 'Agent tombstone did not advance with the Company File' using errcode = '23514'; end if;
	elsif not exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = (select profile_id from public.qorpera_company_files where environment_id = new.environment_id)
			and staff.staff_agent_id = v_id and staff.deleted_at is null
			and staff.source_path_key_sha256 = new.path_key_sha256 and staff.source_path_version = new.version
			and staff.source_snapshot_id = v_head and staff.source_file_sha256 = new.entry #>> '{file,fileSha256}') then
		raise exception 'Agent projection did not advance with the Company File' using errcode = '23514';
	end if;
	return new;
end
$$;
create constraint trigger qorpera_company_path_agent_projection
after insert or update of path,version,entry on public.qorpera_company_path_entries
deferrable initially deferred for each row execute function public.qorpera_assert_company_agent_projection();

create function public.qorpera_apply_member_company_path_command_v3(
	p_command_id uuid,p_plan_sha256 text,p_expected_head uuid,p_tree_sha256 text,p_document_text text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_command public.qorpera_member_company_path_commands%rowtype; v_result jsonb;
begin
	v_actor := public.qorpera_member_company_path_command_actor(p_command_id,p_plan_sha256,true);
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	if v_command.status = 'applied' then return public.qorpera_member_company_path_command_value(v_command); end if;
	v_result := public.qorpera_publish_company_path(v_actor,null,v_command.plan,p_expected_head,p_tree_sha256,null,null);
	if public.qorpera_organization_path_kind(v_command.plan ->> 'path') is not null then
		perform public.qorpera_project_organization_document(v_actor,v_command.plan,p_document_text,
			(v_result ->> 'snapshotId')::uuid,(v_result ->> 'version')::uuid);
	elsif public.qorpera_company_agent_path_id(v_command.plan ->> 'path') is not null then
		perform public.qorpera_project_company_agent_document(v_actor,v_command.plan,p_document_text,
			(v_result ->> 'snapshotId')::uuid,(v_result ->> 'version')::uuid);
	elsif p_document_text is not null then
		raise exception 'Projected document supplied for an ordinary path' using errcode = '22023';
	end if;
	if v_command.expires_at <= clock_timestamp() then
		raise exception 'Company File edit expired' using errcode = '42501'; end if;
	update public.qorpera_member_company_path_commands set status = 'applied',result = v_result
	where id = p_command_id returning * into v_command;
	return public.qorpera_member_company_path_command_value(v_command);
end
$$;

create function public.qorpera_apply_company_path_approval_v3(
	p_proposal_id uuid,p_plan_sha256 text,p_expected_head uuid,p_tree_sha256 text,p_document_text text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_proposal public.qorpera_company_path_proposals%rowtype; v_result jsonb;
begin
	v_actor := public.qorpera_company_path_approved_actor(p_proposal_id,p_plan_sha256);
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	if v_proposal.status = 'applied' then
		return jsonb_build_object('state','applied','proposalId',p_proposal_id,'snapshotId',v_proposal.output_snapshot_id); end if;
	v_result := public.qorpera_publish_company_path(v_actor,null,v_proposal.plan,p_expected_head,p_tree_sha256,
		v_proposal.receipt_id,p_proposal_id);
	if public.qorpera_organization_path_kind(v_proposal.plan ->> 'path') is not null then
		perform public.qorpera_project_organization_document(v_actor,v_proposal.plan,p_document_text,
			(v_result ->> 'snapshotId')::uuid,(v_result ->> 'version')::uuid);
	elsif public.qorpera_company_agent_path_id(v_proposal.plan ->> 'path') is not null then
		perform public.qorpera_project_company_agent_document(v_actor,v_proposal.plan,p_document_text,
			(v_result ->> 'snapshotId')::uuid,(v_result ->> 'version')::uuid);
	elsif p_document_text is not null then
		raise exception 'Projected document supplied for an ordinary path' using errcode = '22023';
	end if;
	update public.qorpera_company_path_proposals set status = 'applied',resolved_by_user_id = approved_by_user_id,
		resolved_at = clock_timestamp(),output_snapshot_id = (v_result ->> 'snapshotId')::uuid where id = p_proposal_id;
	return jsonb_build_object('state','applied','proposalId',p_proposal_id,'snapshotId',v_result ->> 'snapshotId');
end
$$;

revoke all on function public.qorpera_company_agent_path_id(text),
	public.qorpera_project_company_agent_grants(jsonb,uuid,jsonb,uuid,boolean),
	public.qorpera_guard_company_file_staff_write(),
	public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid),
	public.qorpera_project_company_agent_document(jsonb,jsonb,text,uuid,uuid),
	public.qorpera_enable_company_path_gateway_v3(uuid,uuid,uuid,jsonb),
	public.qorpera_assert_company_agent_projection(),
	public.qorpera_apply_member_company_path_command_v3(uuid,text,uuid,text,text),
	public.qorpera_apply_company_path_approval_v3(uuid,text,uuid,text,text)
	from public,anon,authenticated,service_role;

-- The hosted roster writer predates the Company File path projection and can
-- be owned by a different deployment role. PostgreSQL validates EXECUTE on a
-- stored generated-column expression even when its CASE branch is null, so
-- that exact existing owner needs the private path canonicalizer. Never grant
-- the helper to an API role.
do $$
declare v_staff_writer_owner name; v_staff_delete_owner name;
begin
	select role.rolname into strict v_staff_writer_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_put_profile_staff(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,bigint)'::regprocedure;
	if v_staff_writer_owner in ('anon','authenticated','service_role') then
		raise exception 'Hosted roster writer is owned by an API role';
	end if;
	execute format(
		'grant execute on function public.qorpera_company_path_key(text) to %I',
		v_staff_writer_owner
	);
	select role.rolname into strict v_staff_delete_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_delete_profile_staff(uuid,uuid,bigint)'::regprocedure;
	if v_staff_delete_owner in ('anon','authenticated','service_role') then
		raise exception 'Hosted staff deletion is owned by an API role';
	end if;
	execute format(
		'grant execute on function public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid) to %I',
		v_staff_delete_owner
	);
end
$$;

grant execute on function public.qorpera_apply_member_company_path_command_v3(uuid,text,uuid,text,text),
	public.qorpera_apply_company_path_approval_v3(uuid,text,uuid,text,text),
	public.qorpera_enable_company_path_gateway_v3(uuid,uuid,uuid,jsonb) to service_role;
