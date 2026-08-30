-- Bind organizational enforcement projections to exact live Company File
-- path versions. Canonical organization documents can advance only through a
-- dedicated adapter that validates their exact UTF-8 bytes in the same SQL
-- transaction as the Company File head.

create unique index qorpera_company_path_entries_version_identity
	on public.qorpera_company_path_entries(environment_id,path_key_sha256,version);

alter table public.qorpera_company_formations
	add column source_path_key_sha256 bytea generated always as (
		case when source_path is null then null
		else extensions.digest(public.qorpera_company_path_key(source_path),'sha256') end
	) stored,
	add constraint qorpera_company_formations_source_entry foreign key (
		environment_id,source_path_key_sha256,source_path_version
	) references public.qorpera_company_path_entries(environment_id,path_key_sha256,version)
		deferrable initially deferred,
	add constraint qorpera_company_formations_source_path
		check (source_path is null or public.qorpera_company_path_key(source_path) = 'organization/formation.json');

alter table public.qorpera_company_departments
	add column source_path_key_sha256 bytea generated always as (
		extensions.digest(public.qorpera_company_path_key(source_path),'sha256')
	) stored,
	add constraint qorpera_company_departments_source_entry foreign key (
		environment_id,source_path_key_sha256,source_path_version
	) references public.qorpera_company_path_entries(environment_id,path_key_sha256,version)
		deferrable initially deferred,
	add constraint qorpera_company_departments_source_path check (
		public.qorpera_company_path_key(source_path) = 'organization/departments/' || id::text || '.json'
	);

alter table public.qorpera_company_projects
	add column source_path_key_sha256 bytea generated always as (
		extensions.digest(public.qorpera_company_path_key(source_path),'sha256')
	) stored,
	add constraint qorpera_company_projects_source_entry foreign key (
		environment_id,source_path_key_sha256,source_path_version
	) references public.qorpera_company_path_entries(environment_id,path_key_sha256,version)
		deferrable initially deferred,
	add constraint qorpera_company_projects_source_path check (
		public.qorpera_company_path_key(source_path) = 'organization/projects/' || id::text || '.json'
	);

create function public.qorpera_organization_path_kind(p_path text)
returns text language plpgsql immutable set search_path = '' as $$
declare v_path text := public.qorpera_company_path_key(p_path);
begin
	if v_path = 'organization/formation.json' then return 'formation'; end if;
	if v_path ~ '^organization/departments/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return 'department'; end if;
	if v_path ~ '^organization/projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return 'project'; end if;
	return null;
end
$$;

alter table public.qorpera_company_path_resources
	drop constraint qorpera_company_path_resources_scope_check,
	drop constraint qorpera_company_path_resources_check,
	add constraint qorpera_company_path_resources_scope_check
		check (scope in ('company_shared','member_private','department_scoped','project_scoped')),
	add constraint qorpera_company_path_resources_owner_check check (
		(scope = 'member_private') = (owner_user_id is not null)
	);

create table public.qorpera_department_path_resources (
	resource_id uuid primary key references public.qorpera_company_path_resources(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	department_id uuid not null,
	member_permissions text[] not null check (
		member_permissions in (array[]::text[],array['read']::text[],array['read','write']::text[])
	),
	staff_permissions text[] not null check (
		staff_permissions in (array[]::text[],array['read']::text[],array['read','write']::text[])
	),
	source_path_version uuid not null,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	foreign key (profile_id,department_id)
		references public.qorpera_company_departments(profile_id,id) on delete cascade
);

create table public.qorpera_project_path_resources (
	resource_id uuid primary key references public.qorpera_company_path_resources(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	project_id uuid not null,
	member_permissions text[] not null check (
		member_permissions in (array[]::text[],array['read']::text[],array['read','write']::text[])
	),
	staff_permissions text[] not null check (
		staff_permissions in (array[]::text[],array['read']::text[],array['read','write']::text[])
	),
	source_path_version uuid not null,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	foreign key (profile_id,project_id)
		references public.qorpera_company_projects(profile_id,id) on delete cascade
);

create table public.qorpera_department_external_operation_grants (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	department_id uuid not null,
	connector_key text not null check (connector_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
	operation_key text not null check (operation_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
	status text not null check (status in ('proposed','active','paused','revoked')),
	source_path_version uuid not null,
	foreign key (profile_id,department_id)
		references public.qorpera_company_departments(profile_id,id) on delete cascade,
	unique (department_id,connector_key,operation_key)
);

alter table public.qorpera_department_path_resources enable row level security;
alter table public.qorpera_project_path_resources enable row level security;
alter table public.qorpera_department_external_operation_grants enable row level security;
revoke all on public.qorpera_department_path_resources,public.qorpera_project_path_resources,
	public.qorpera_department_external_operation_grants from public,anon,authenticated,service_role;

create or replace function public.qorpera_department_resources_json(p_department_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object(
		'resource_id',resource.id,'path',resource.path,'path_match',resource.path_match,
		'scope',resource.scope,'policy',resource.policy,'version',resource.version,
		'member_permissions',to_jsonb(mapping.member_permissions),
		'staff_permissions',to_jsonb(mapping.staff_permissions),
		'source_path_version',mapping.source_path_version,'revoked_at',resource.revoked_at
	) order by resource.path),'[]'::jsonb)
	from public.qorpera_department_path_resources mapping
	join public.qorpera_company_path_resources resource on resource.id = mapping.resource_id
	where mapping.department_id = p_department_id
$$;

create or replace function public.qorpera_project_resources_json(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object(
		'resource_id',resource.id,'path',resource.path,'path_match',resource.path_match,
		'scope',resource.scope,'policy',resource.policy,'version',resource.version,
		'member_permissions',to_jsonb(mapping.member_permissions),
		'staff_permissions',to_jsonb(mapping.staff_permissions),
		'source_path_version',mapping.source_path_version,'revoked_at',resource.revoked_at,
		'kind',case when resource.path = any(project.authorized_output_paths) then 'output' else 'source' end
	) order by resource.path),'[]'::jsonb)
	from public.qorpera_project_path_resources mapping
	join public.qorpera_company_path_resources resource on resource.id = mapping.resource_id
	join public.qorpera_company_projects project on project.id = mapping.project_id
	where mapping.project_id = p_project_id
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
$$;

create function public.qorpera_project_scoped_path_resources(
	p_actor jsonb,p_owner_kind text,p_owner_id uuid,p_resources jsonb,p_source_path_version uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid := (p_actor ->> 'companyId')::uuid;
	v_environment_id uuid := (p_actor ->> 'environmentId')::uuid;
	v_user_id uuid := (p_actor ->> 'userId')::uuid; v_scope text; v_item jsonb;
	v_resource public.qorpera_company_path_resources%rowtype; v_id uuid; v_ids uuid[] := '{}'::uuid[];
	v_member_permissions text[]; v_staff_permissions text[];
begin
	if p_owner_kind not in ('department','project') or jsonb_typeof(p_resources) <> 'array'
		or jsonb_array_length(p_resources) > 256 then
		raise exception 'Organization resource projection is invalid' using errcode = '22023'; end if;
	v_scope := p_owner_kind || '_scoped';
	for v_item in select value from jsonb_array_elements(p_resources) loop
		if not (v_item ?& array['resourceId','path','pathMatch','policy','memberPermissions','staffPermissions'])
			or v_item - array['resourceId','path','pathMatch','policy','memberPermissions','staffPermissions'] <> '{}'::jsonb
			or jsonb_typeof(v_item -> 'memberPermissions') <> 'array'
			or jsonb_typeof(v_item -> 'staffPermissions') <> 'array'
			or v_item -> 'memberPermissions' not in ('[]'::jsonb,'["read"]'::jsonb,'["read","write"]'::jsonb)
			or v_item -> 'staffPermissions' not in ('[]'::jsonb,'["read"]'::jsonb,'["read","write"]'::jsonb)
			or not public.qorpera_company_path_valid(v_item ->> 'path',true)
			or public.qorpera_company_path_key(v_item ->> 'path') = ''
			or v_item ->> 'pathMatch' not in ('exact','subtree')
			or v_item ->> 'policy' not in ('normal','protected')
			or starts_with(public.qorpera_company_path_key(v_item ->> 'path'),'members/') then
			raise exception 'Organization resource projection is invalid' using errcode = '22023'; end if;
		v_id := (v_item ->> 'resourceId')::uuid;
		v_member_permissions := array(select value #>> '{}' from jsonb_array_elements(v_item -> 'memberPermissions') value);
		v_staff_permissions := array(select value #>> '{}' from jsonb_array_elements(v_item -> 'staffPermissions') value);
		select * into v_resource from public.qorpera_company_path_resources where id = v_id
			or (environment_id = v_environment_id and path_key_sha256 = extensions.digest(
				public.qorpera_company_path_key(v_item ->> 'path'),'sha256')) for update;
		if found and (v_resource.id <> v_id or v_resource.environment_id <> v_environment_id
			or v_resource.scope <> v_scope) then
			raise exception 'Organization resource identity changed' using errcode = '42501'; end if;
		insert into public.qorpera_company_path_resources(id,environment_id,path,path_match,scope,policy,
			version,created_by_user_id)
		values (v_id,v_environment_id,v_item ->> 'path',v_item ->> 'pathMatch',v_scope,v_item ->> 'policy',
			extensions.gen_random_uuid(),v_user_id)
		on conflict (id) do update set path = excluded.path,path_match = excluded.path_match,
			policy = excluded.policy,version = extensions.gen_random_uuid(),revoked_at = null;
		if p_owner_kind = 'department' then
			insert into public.qorpera_department_path_resources(resource_id,profile_id,department_id,
				member_permissions,staff_permissions,source_path_version,created_by_user_id)
			values (v_id,v_profile_id,p_owner_id,v_member_permissions,v_staff_permissions,p_source_path_version,v_user_id)
			on conflict (resource_id) do update set member_permissions = excluded.member_permissions,
				staff_permissions = excluded.staff_permissions,source_path_version = excluded.source_path_version
			where qorpera_department_path_resources.profile_id = excluded.profile_id
				and qorpera_department_path_resources.department_id = excluded.department_id;
		else
			insert into public.qorpera_project_path_resources(resource_id,profile_id,project_id,
				member_permissions,staff_permissions,source_path_version,created_by_user_id)
			values (v_id,v_profile_id,p_owner_id,v_member_permissions,v_staff_permissions,p_source_path_version,v_user_id)
			on conflict (resource_id) do update set member_permissions = excluded.member_permissions,
				staff_permissions = excluded.staff_permissions,source_path_version = excluded.source_path_version
			where qorpera_project_path_resources.profile_id = excluded.profile_id
				and qorpera_project_path_resources.project_id = excluded.project_id;
		end if;
		if not found then raise exception 'Organization resource belongs to another object' using errcode = '42501'; end if;
		v_ids := array_append(v_ids,v_id);
	end loop;
	if cardinality(v_ids) <> (select count(distinct id) from unnest(v_ids) id) then
		raise exception 'Organization resource identity is duplicated' using errcode = '22023'; end if;
	if p_owner_kind = 'department' then
		update public.qorpera_company_path_resources resource set revoked_at = coalesce(resource.revoked_at,clock_timestamp()),
			version = extensions.gen_random_uuid()
		from public.qorpera_department_path_resources mapping where mapping.resource_id = resource.id
			and mapping.profile_id = v_profile_id and mapping.department_id = p_owner_id
			and not (mapping.resource_id = any(v_ids));
		delete from public.qorpera_department_path_resources where profile_id = v_profile_id
			and department_id = p_owner_id and not (resource_id = any(v_ids));
	else
		update public.qorpera_company_path_resources resource set revoked_at = coalesce(resource.revoked_at,clock_timestamp()),
			version = extensions.gen_random_uuid()
		from public.qorpera_project_path_resources mapping where mapping.resource_id = resource.id
			and mapping.profile_id = v_profile_id and mapping.project_id = p_owner_id
			and not (mapping.resource_id = any(v_ids));
		delete from public.qorpera_project_path_resources where profile_id = v_profile_id
			and project_id = p_owner_id and not (resource_id = any(v_ids));
	end if;
exception when invalid_text_representation or unique_violation or foreign_key_violation or check_violation then
	raise exception 'Organization resource projection is invalid' using errcode = '22023';
end
$$;

create function public.qorpera_project_organization_document(
	p_actor jsonb,p_plan jsonb,p_document_text text,p_snapshot_id uuid,p_path_version uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_kind text := public.qorpera_organization_path_kind(p_plan ->> 'path');
	v_document jsonb; v_profile_id uuid := (p_actor ->> 'companyId')::uuid;
	v_environment_id uuid := (p_actor ->> 'environmentId')::uuid;
	v_user_id uuid := (p_actor ->> 'userId')::uuid; v_item jsonb; v_id uuid;
	v_role public.qorpera_profile_role;
	v_department public.qorpera_company_departments%rowtype;
	v_project public.qorpera_company_projects%rowtype;
begin
	if v_kind is null then
		if p_document_text is not null then
			raise exception 'Organization document supplied for an ordinary path' using errcode = '22023'; end if;
		return;
	end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = v_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'Organization mutation requires founder authority' using errcode = '42501'; end if;
	if p_plan #>> '{entry,kind}' is distinct from 'file' or p_document_text is null
		or octet_length(convert_to(p_document_text,'utf8')) not between 2 and 32768
		or encode(extensions.digest(convert_to(p_document_text,'utf8'),'sha256'),'hex')
			is distinct from p_plan #>> '{entry,file,fileSha256}' then
		raise exception 'Organization document bytes do not match the Company File mutation' using errcode = '22023'; end if;
	v_document := p_document_text::jsonb;
	if jsonb_typeof(v_document) is distinct from 'object' then
		raise exception 'Organization document is invalid' using errcode = '22023'; end if;

	if v_kind = 'formation' then
		if not (v_document ?& array['schema','formationId','cofounderStaffAgentId','state','status','revision'])
			or v_document - array['schema','formationId','cofounderStaffAgentId','state','status','revision'] <> '{}'::jsonb
			or v_document ->> 'schema' <> 'qorpera.company-formation/v1'
			or jsonb_typeof(v_document -> 'revision') <> 'number'
			or (v_document ->> 'revision') !~ '^[1-9][0-9]*$'
			or (v_document ->> 'cofounderStaffAgentId') !~
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Company formation document is invalid' using errcode = '22023'; end if;
		perform 1 from public.qorpera_company_cofounders cofounder
		join public.qorpera_profile_staff staff on staff.profile_id = cofounder.profile_id
			and staff.staff_agent_id = cofounder.staff_agent_id
		where cofounder.profile_id = v_profile_id and cofounder.environment_id = v_environment_id
			and cofounder.staff_agent_id = (v_document ->> 'cofounderStaffAgentId')::uuid
			and staff.deleted_at is null;
		if not found then raise exception 'Company Co-Founder identity is unavailable' using errcode = '42501'; end if;
		perform 1 from public.qorpera_company_formations formation
		where formation.profile_id = v_profile_id and formation.environment_id = v_environment_id
			and formation.id = (v_document ->> 'formationId')::uuid
			and ((formation.projection_status = 'pending_company_file'
				and (v_document ->> 'revision')::bigint = formation.revision
				and v_document ->> 'state' = formation.state)
			or (formation.projection_status = 'verified'
				and (v_document ->> 'revision')::bigint = formation.revision + 1
				and (v_document ->> 'state' = formation.state or
					case formation.state
						when 'source_inventory' then v_document ->> 'state' = 'discovery'
						when 'discovery' then v_document ->> 'state' = 'research'
						when 'research' then v_document ->> 'state' = 'vision_proposal'
						when 'vision_proposal' then v_document ->> 'state' = 'goals_ratified'
						when 'goals_ratified' then v_document ->> 'state' = 'organization_formation'
						when 'organization_formation' then v_document ->> 'state' = 'operating'
						else false end)
				and (formation.status <> 'completed' or v_document ->> 'status' = 'completed')));
		if not found then
			raise exception 'Company formation transition is invalid' using errcode = '22023'; end if;
		update public.qorpera_company_formations formation set
			state = v_document ->> 'state',status = v_document ->> 'status',
			revision = (v_document ->> 'revision')::bigint,projection_status = 'verified',
			source_path = p_plan ->> 'path',source_path_version = p_path_version,
			source_snapshot_id = p_snapshot_id,source_file_sha256 = p_plan #>> '{entry,file,fileSha256}',
			updated_at = clock_timestamp()
		where formation.profile_id = v_profile_id and formation.environment_id = v_environment_id
			and formation.id = (v_document ->> 'formationId')::uuid
			and exists (select 1 from public.qorpera_company_cofounders cofounder
				where cofounder.profile_id = v_profile_id and cofounder.formation_id = formation.id
					and cofounder.staff_agent_id = (v_document ->> 'cofounderStaffAgentId')::uuid);
		if not found then raise exception 'Company formation identity changed' using errcode = '42501'; end if;
		return;
	end if;

	if v_kind = 'department' then
		if not (v_document ?& array['schema','departmentId','slug','name','charter','nonResponsibilities',
			'accountableUserId','leadStaffAgentId','defaultRoomId','status','intakePolicy','prioritizationPolicy',
			'budgetPolicy','effortPolicy','concurrencyPolicy','executionPolicy','projectCreationPolicy',
			'escalationPolicy','routineIds','listenerIds','externalOperationGrants','resources','version',
			'staff','responsibilities','measures'])
			or v_document - array['schema','departmentId','slug','name','charter','nonResponsibilities',
				'accountableUserId','leadStaffAgentId','defaultRoomId','status','intakePolicy','prioritizationPolicy',
				'budgetPolicy','effortPolicy','concurrencyPolicy','executionPolicy','projectCreationPolicy',
				'escalationPolicy','routineIds','listenerIds','externalOperationGrants','resources','version',
				'staff','responsibilities','measures'] <> '{}'::jsonb
			or v_document ->> 'schema' <> 'qorpera.department/v1'
			or jsonb_typeof(v_document -> 'nonResponsibilities') <> 'array'
			or jsonb_typeof(v_document -> 'staff') <> 'array'
			or jsonb_typeof(v_document -> 'responsibilities') <> 'array'
			or jsonb_typeof(v_document -> 'measures') <> 'array'
			or jsonb_typeof(v_document -> 'intakePolicy') <> 'object'
			or jsonb_typeof(v_document -> 'prioritizationPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'budgetPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'effortPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'concurrencyPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'executionPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'projectCreationPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'escalationPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'routineIds') <> 'array'
			or jsonb_typeof(v_document -> 'listenerIds') <> 'array'
			or jsonb_typeof(v_document -> 'externalOperationGrants') <> 'array'
			or jsonb_typeof(v_document -> 'resources') <> 'array'
			or (v_document ->> 'version') !~ '^[1-9][0-9]*$'
			or jsonb_array_length(v_document -> 'nonResponsibilities') > 64
			or jsonb_array_length(v_document -> 'staff') > 256
			or jsonb_array_length(v_document -> 'responsibilities') > 256
			or jsonb_array_length(v_document -> 'measures') > 256
			or jsonb_array_length(v_document -> 'routineIds') > 128
			or jsonb_array_length(v_document -> 'listenerIds') > 128
			or jsonb_array_length(v_document -> 'externalOperationGrants') > 256
			or exists (select 1 from jsonb_array_elements(v_document -> 'nonResponsibilities') value
				where jsonb_typeof(value) <> 'string' or char_length(value #>> '{}') not between 1 and 1024)
			or exists (select 1 from jsonb_array_elements((v_document -> 'routineIds') || (v_document -> 'listenerIds')) value
				where jsonb_typeof(value) <> 'string' or value #>> '{}' !~
					'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
			raise exception 'Department document is invalid' using errcode = '22023'; end if;
		v_id := (v_document ->> 'departmentId')::uuid;
		if public.qorpera_company_path_key(p_plan ->> 'path') <> 'organization/departments/' || v_id::text || '.json' then
			raise exception 'Department path does not match its identity' using errcode = '22023'; end if;
		select * into v_department from public.qorpera_company_departments where id = v_id for update;
		if found and (v_department.profile_id <> v_profile_id or v_department.environment_id <> v_environment_id) then
			raise exception 'Department identity belongs to another company' using errcode = '42501'; end if;
		if (found and (v_document ->> 'version')::bigint <> v_department.version + 1)
			or (not found and (v_document ->> 'version')::bigint <> 1) then
			raise exception 'Department version is not monotonic' using errcode = '22023'; end if;
		if found and v_document ->> 'status' <> v_department.status and not (case v_department.status
			when 'proposed' then v_document ->> 'status' in ('forming','retired')
			when 'forming' then v_document ->> 'status' in ('active','degraded','paused','retired')
			when 'active' then v_document ->> 'status' in ('degraded','paused','retired')
			when 'degraded' then v_document ->> 'status' in ('active','paused','retired')
			when 'paused' then v_document ->> 'status' in ('forming','active','degraded','retired')
			else false end) then
			raise exception 'Department lifecycle transition is invalid' using errcode = '22023'; end if;
		if exists (select 1 from jsonb_array_elements_text(v_document -> 'routineIds') routine(id)
			left join public.qorpera_cloud_routines stored on stored.id = routine.id::uuid
			where stored.id is null or stored.profile_id <> v_profile_id)
			or exists (select 1 from jsonb_array_elements_text(v_document -> 'listenerIds') listener(id)
			left join public.qorpera_cloud_routines stored on stored.id = listener.id::uuid
			where stored.id is null or stored.profile_id <> v_profile_id)
			or exists (select 1 from jsonb_array_elements_text(v_document -> 'routineIds') routine(id)
				join jsonb_array_elements_text(v_document -> 'listenerIds') listener(id) on listener.id = routine.id) then
			raise exception 'Department routine binding is invalid' using errcode = '22023'; end if;
		insert into public.qorpera_company_departments(id,profile_id,environment_id,slug,name,charter,
			non_responsibilities,accountable_user_id,lead_staff_agent_id,default_room_id,status,
			intake_policy,prioritization_policy,budget_policy,effort_policy,concurrency_policy,execution_policy,
			project_creation_policy,escalation_policy,routine_ids,listener_ids,external_operation_grants,
			version,source_path,source_path_version,
			source_snapshot_id,source_file_sha256,created_by_user_id)
		values (v_id,v_profile_id,v_environment_id,v_document ->> 'slug',v_document ->> 'name',v_document ->> 'charter',
			array(select value #>> '{}' from jsonb_array_elements(v_document -> 'nonResponsibilities') value),
			(v_document ->> 'accountableUserId')::uuid,nullif(v_document ->> 'leadStaffAgentId','')::uuid,
			nullif(v_document ->> 'defaultRoomId','')::uuid,v_document ->> 'status',v_document -> 'intakePolicy',
			v_document -> 'prioritizationPolicy',v_document -> 'budgetPolicy',v_document -> 'effortPolicy',
			v_document -> 'concurrencyPolicy',v_document -> 'executionPolicy',v_document -> 'projectCreationPolicy',
			v_document -> 'escalationPolicy',array(select value::uuid from jsonb_array_elements_text(v_document -> 'routineIds') value),
			array(select value::uuid from jsonb_array_elements_text(v_document -> 'listenerIds') value),
			v_document -> 'externalOperationGrants',(v_document ->> 'version')::bigint,
			p_plan ->> 'path',p_path_version,p_snapshot_id,p_plan #>> '{entry,file,fileSha256}',v_user_id)
		on conflict (id) do update set slug = excluded.slug,name = excluded.name,charter = excluded.charter,
			non_responsibilities = excluded.non_responsibilities,accountable_user_id = excluded.accountable_user_id,
			lead_staff_agent_id = excluded.lead_staff_agent_id,default_room_id = excluded.default_room_id,
			status = excluded.status,intake_policy = excluded.intake_policy,
			prioritization_policy = excluded.prioritization_policy,budget_policy = excluded.budget_policy,
			effort_policy = excluded.effort_policy,concurrency_policy = excluded.concurrency_policy,
			execution_policy = excluded.execution_policy,project_creation_policy = excluded.project_creation_policy,
			escalation_policy = excluded.escalation_policy,routine_ids = excluded.routine_ids,
			listener_ids = excluded.listener_ids,external_operation_grants = excluded.external_operation_grants,
			version = excluded.version,
			source_path = excluded.source_path,source_path_version = excluded.source_path_version,
			source_snapshot_id = excluded.source_snapshot_id,source_file_sha256 = excluded.source_file_sha256,
			updated_at = clock_timestamp();
		delete from public.qorpera_department_staff_memberships where department_id = v_id;
		delete from public.qorpera_department_responsibilities where department_id = v_id;
		delete from public.qorpera_department_measures where department_id = v_id;
		for v_item in select value from jsonb_array_elements(v_document -> 'staff') loop
			if v_item - array['staffAgentId','assignmentKind','role','status'] <> '{}'::jsonb
				or not (v_item ?& array['staffAgentId','assignmentKind','role','status']) then
				raise exception 'Department staff assignment is invalid' using errcode = '22023'; end if;
			insert into public.qorpera_department_staff_memberships(profile_id,department_id,staff_agent_id,
				assignment_kind,role,status,created_by_user_id,ended_at)
			values (v_profile_id,v_id,(v_item ->> 'staffAgentId')::uuid,v_item ->> 'assignmentKind',v_item ->> 'role',
				v_item ->> 'status',v_user_id,case when v_item ->> 'status' = 'ended' then clock_timestamp() end);
		end loop;
		for v_item in select value from jsonb_array_elements(v_document -> 'responsibilities') loop
			if v_item - array['responsibilityId','key','label','boundary','status'] <> '{}'::jsonb
				or not (v_item ?& array['responsibilityId','key','label','boundary','status']) then
				raise exception 'Department responsibility is invalid' using errcode = '22023'; end if;
			insert into public.qorpera_department_responsibilities(id,profile_id,department_id,responsibility_key,label,boundary,status)
			values ((v_item ->> 'responsibilityId')::uuid,v_profile_id,v_id,v_item ->> 'key',v_item ->> 'label',
				v_item ->> 'boundary',v_item ->> 'status');
		end loop;
		for v_item in select value from jsonb_array_elements(v_document -> 'measures') loop
			if v_item - array['measureId','key','label','definition','sourcePath','sourcePathVersion',
				'sourceSnapshotId','sourceFileSha256','direction','target','guardrails','cadence',
				'accountableStaffAgentId','status'] <> '{}'::jsonb
				or not (v_item ?& array['measureId','key','label','definition','sourcePath','sourcePathVersion',
					'sourceSnapshotId','sourceFileSha256','direction','target','guardrails','cadence',
					'accountableStaffAgentId','status'])
				or jsonb_typeof(v_item -> 'guardrails') <> 'array'
				or not exists (select 1 from public.qorpera_company_path_entries source
					where source.environment_id = v_environment_id
						and source.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(
							v_item ->> 'sourcePath'),'sha256')
						and source.version = (v_item ->> 'sourcePathVersion')::uuid
						and source.entry ->> 'kind' = 'file'
						and source.entry #>> '{file,fileSha256}' = v_item ->> 'sourceFileSha256')
				or not exists (select 1 from public.qorpera_company_snapshots candidate
					where candidate.id = p_snapshot_id and candidate.environment_id = v_environment_id
						and candidate.parent_snapshot_id = (v_item ->> 'sourceSnapshotId')::uuid) then
				raise exception 'Department measure is invalid' using errcode = '22023'; end if;
			insert into public.qorpera_department_measures(id,profile_id,department_id,measure_key,label,definition,
				source_path,source_path_version,source_snapshot_id,source_file_sha256,direction,target,guardrails,
				cadence,accountable_staff_agent_id,status)
			values ((v_item ->> 'measureId')::uuid,v_profile_id,v_id,v_item ->> 'key',v_item ->> 'label',
				v_item ->> 'definition',v_item ->> 'sourcePath',(v_item ->> 'sourcePathVersion')::uuid,
				(v_item ->> 'sourceSnapshotId')::uuid,v_item ->> 'sourceFileSha256',v_item ->> 'direction',v_item -> 'target',
				v_item -> 'guardrails',v_item ->> 'cadence',(v_item ->> 'accountableStaffAgentId')::uuid,
				v_item ->> 'status');
		end loop;
		perform public.qorpera_project_scoped_path_resources(
			p_actor,'department',v_id,v_document -> 'resources',p_path_version);
		delete from public.qorpera_department_external_operation_grants where profile_id = v_profile_id
			and department_id = v_id;
		for v_item in select value from jsonb_array_elements(v_document -> 'externalOperationGrants') loop
			if not (v_item ?& array['grantId','connectorKey','operationKey','status'])
				or v_item - array['grantId','connectorKey','operationKey','status'] <> '{}'::jsonb then
				raise exception 'Department external operation grant is invalid' using errcode = '22023'; end if;
			insert into public.qorpera_department_external_operation_grants(id,profile_id,department_id,
				connector_key,operation_key,status,source_path_version)
			values ((v_item ->> 'grantId')::uuid,v_profile_id,v_id,v_item ->> 'connectorKey',
				v_item ->> 'operationKey',v_item ->> 'status',p_path_version);
		end loop;
		if (select lead_staff_agent_id from public.qorpera_company_departments where id = v_id) is not null
			and not exists (select 1 from public.qorpera_department_staff_memberships membership
				where membership.department_id = v_id and membership.staff_agent_id = (
					select lead_staff_agent_id from public.qorpera_company_departments where id = v_id)
					and membership.status = 'active') then
			raise exception 'Department lead must be an active department member' using errcode = '22023'; end if;
		if exists (select 1 from public.qorpera_department_measures measure
			where measure.department_id = v_id and not exists (select 1 from public.qorpera_department_staff_memberships membership
				where membership.department_id = v_id and membership.staff_agent_id = measure.accountable_staff_agent_id
					and membership.status = 'active')) then
			raise exception 'Measure owner must be an active department member' using errcode = '22023'; end if;
		return;
	end if;

	if not (v_document ?& array['schema','projectId','key','name','objective','definitionOfDone','scopeKind',
		'sponsoringDepartmentId','leadStaffAgentId','roomId','status','sourceResources','outputResources',
		'dependencies','reasoningPolicy','workerPolicy','executionPolicy','outcome','version','staff'])
		or v_document - array['schema','projectId','key','name','objective','definitionOfDone','scopeKind',
			'sponsoringDepartmentId','leadStaffAgentId','roomId','status','sourceResources','outputResources',
			'dependencies','reasoningPolicy','workerPolicy','executionPolicy','outcome','version','staff'] <> '{}'::jsonb
		or v_document ->> 'schema' <> 'qorpera.company-project/v1'
		or jsonb_typeof(v_document -> 'sourceResources') <> 'array'
		or jsonb_typeof(v_document -> 'outputResources') <> 'array'
		or jsonb_typeof(v_document -> 'dependencies') <> 'array'
		or jsonb_typeof(v_document -> 'reasoningPolicy') <> 'object'
		or jsonb_typeof(v_document -> 'workerPolicy') <> 'object'
		or jsonb_typeof(v_document -> 'executionPolicy') <> 'object'
		or jsonb_typeof(v_document -> 'staff') <> 'array'
		or (v_document ->> 'version') !~ '^[1-9][0-9]*$'
		or jsonb_array_length(v_document -> 'sourceResources') > 256
		or jsonb_array_length(v_document -> 'outputResources') > 256
		or jsonb_array_length(v_document -> 'staff') > 256
		or exists (select 1 from jsonb_array_elements(v_document -> 'sourceResources') value
			where value -> 'staffPermissions' <> '["read"]'::jsonb)
		or exists (select 1 from jsonb_array_elements(v_document -> 'outputResources') value
			where value -> 'staffPermissions' <> '["read","write"]'::jsonb) then
		raise exception 'Project document is invalid' using errcode = '22023'; end if;
	v_id := (v_document ->> 'projectId')::uuid;
	if public.qorpera_company_path_key(p_plan ->> 'path') <> 'organization/projects/' || v_id::text || '.json' then
		raise exception 'Project path does not match its identity' using errcode = '22023'; end if;
	select * into v_project from public.qorpera_company_projects where id = v_id for update;
	if found and (v_project.profile_id <> v_profile_id or v_project.environment_id <> v_environment_id) then
		raise exception 'Project identity belongs to another company' using errcode = '42501'; end if;
	if (found and (v_document ->> 'version')::bigint <> v_project.version + 1)
		or (not found and (v_document ->> 'version')::bigint <> 1) then
		raise exception 'Project version is not monotonic' using errcode = '22023'; end if;
	if found and v_document ->> 'status' <> v_project.status and not (case v_project.status
		when 'proposed' then v_document ->> 'status' in ('active','cancelled')
		when 'active' then v_document ->> 'status' in ('blocked','completed','cancelled')
		when 'blocked' then v_document ->> 'status' in ('active','completed','cancelled')
		else false end) then
		raise exception 'Project lifecycle transition is invalid' using errcode = '22023'; end if;
	insert into public.qorpera_company_projects(id,profile_id,environment_id,project_key,name,objective,definition_of_done,
		scope_kind,sponsoring_department_id,lead_staff_agent_id,room_id,status,authorized_source_paths,
		authorized_output_paths,dependencies,reasoning_policy,worker_policy,execution_policy,outcome,version,
		source_path,source_path_version,source_snapshot_id,
		source_file_sha256,created_by_user_id)
	values (v_id,v_profile_id,v_environment_id,v_document ->> 'key',v_document ->> 'name',v_document ->> 'objective',
		v_document ->> 'definitionOfDone',v_document ->> 'scopeKind',nullif(v_document ->> 'sponsoringDepartmentId','')::uuid,
		(v_document ->> 'leadStaffAgentId')::uuid,nullif(v_document ->> 'roomId','')::uuid,v_document ->> 'status',
		array(select value ->> 'path' from jsonb_array_elements(v_document -> 'sourceResources') value),
		array(select value ->> 'path' from jsonb_array_elements(v_document -> 'outputResources') value),
		v_document -> 'dependencies',v_document -> 'reasoningPolicy',v_document -> 'workerPolicy',
		v_document -> 'executionPolicy',nullif(v_document -> 'outcome','null'::jsonb),(v_document ->> 'version')::bigint,
		p_plan ->> 'path',p_path_version,p_snapshot_id,p_plan #>> '{entry,file,fileSha256}',v_user_id)
	on conflict (id) do update set project_key = excluded.project_key,name = excluded.name,objective = excluded.objective,
		definition_of_done = excluded.definition_of_done,scope_kind = excluded.scope_kind,
		sponsoring_department_id = excluded.sponsoring_department_id,lead_staff_agent_id = excluded.lead_staff_agent_id,
		room_id = excluded.room_id,status = excluded.status,authorized_source_paths = excluded.authorized_source_paths,
		authorized_output_paths = excluded.authorized_output_paths,dependencies = excluded.dependencies,
		reasoning_policy = excluded.reasoning_policy,worker_policy = excluded.worker_policy,
		execution_policy = excluded.execution_policy,outcome = excluded.outcome,
		version = excluded.version,source_path = excluded.source_path,source_path_version = excluded.source_path_version,
		source_snapshot_id = excluded.source_snapshot_id,source_file_sha256 = excluded.source_file_sha256,
		updated_at = clock_timestamp();
	delete from public.qorpera_project_staff_memberships where project_id = v_id;
	for v_item in select value from jsonb_array_elements(v_document -> 'staff') loop
		if v_item - array['staffAgentId','role','status'] <> '{}'::jsonb
			or not (v_item ?& array['staffAgentId','role','status']) then
			raise exception 'Project staff assignment is invalid' using errcode = '22023'; end if;
		insert into public.qorpera_project_staff_memberships(profile_id,project_id,staff_agent_id,role,status,
			created_by_user_id,ended_at)
		values (v_profile_id,v_id,(v_item ->> 'staffAgentId')::uuid,v_item ->> 'role',v_item ->> 'status',v_user_id,
			case when v_item ->> 'status' = 'ended' then clock_timestamp() end);
	end loop;
	perform public.qorpera_project_scoped_path_resources(
		p_actor,'project',v_id,(v_document -> 'sourceResources') || (v_document -> 'outputResources'),p_path_version);
	if not exists (select 1 from public.qorpera_project_staff_memberships membership
		where membership.project_id = v_id and membership.staff_agent_id = (
			select lead_staff_agent_id from public.qorpera_company_projects where id = v_id)
			and membership.status = 'active') then
		raise exception 'Project lead must be an active project member' using errcode = '22023'; end if;
exception when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation
	or foreign_key_violation or unique_violation then
	raise exception 'Organization document is invalid' using errcode = '22023';
end
$$;

-- A Company File that already contains canonical organization documents must
-- import and project their exact bytes in the same cutover transaction. The
-- legacy cutover remains valid only for trees without organization documents.
create function public.qorpera_enable_company_path_gateway_v2(
	p_environment_id uuid,p_snapshot_id uuid,p_authorized_user_id uuid,p_organization_documents jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_entry public.qorpera_company_path_entries%rowtype;
	v_document record; v_text text; v_actor jsonb;
begin
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_organization_documents) <> 'object'
		or octet_length(convert_to(p_organization_documents::text,'utf8')) > 8388608 then
		raise exception 'Company File organization cutover is invalid' using errcode = '22023'; end if;
	for v_document in select key,value from jsonb_each(p_organization_documents) loop
		if v_document.key <> public.qorpera_company_path_key(v_document.key)
			or public.qorpera_organization_path_kind(v_document.key) is null
			or jsonb_typeof(v_document.value) <> 'string'
			or octet_length(convert_to(v_document.value #>> '{}','utf8')) not between 2 and 32768 then
			raise exception 'Company File organization cutover is invalid' using errcode = '22023'; end if;
	end loop;
	perform public.qorpera_enable_company_path_gateway(p_environment_id,p_snapshot_id,p_authorized_user_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id;
	v_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',p_environment_id,
		'userId',p_authorized_user_id,'audience','human');
	for v_entry in select entry.* from public.qorpera_company_path_entries entry
		where entry.environment_id = p_environment_id
			and public.qorpera_organization_path_kind(entry.path) is not null order by entry.path loop
		v_text := p_organization_documents ->> public.qorpera_company_path_key(v_entry.path);
		if v_text is null then
			raise exception 'Company File organization document is missing at cutover' using errcode = '22023'; end if;
		perform public.qorpera_project_organization_document(v_actor,
			jsonb_build_object('path',v_entry.path,'entry',v_entry.entry),v_text,p_snapshot_id,v_entry.version);
	end loop;
	if (select count(*) from jsonb_object_keys(p_organization_documents)) is distinct from (
		select count(*) from public.qorpera_company_path_entries entry
		where entry.environment_id = p_environment_id
			and public.qorpera_organization_path_kind(entry.path) is not null
	) then raise exception 'Company File organization cutover is invalid' using errcode = '22023'; end if;
end
$$;

create function public.qorpera_assert_organization_projection()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_kind text := public.qorpera_organization_path_kind(new.path); v_id uuid;
begin
	if v_kind is null then return new; end if;
	if new.entry is null then
		raise exception 'Canonical organization documents cannot be deleted' using errcode = '42501'; end if;
	if v_kind = 'formation' and not exists (select 1 from public.qorpera_company_formations formation
		where formation.environment_id = new.environment_id and formation.projection_status = 'verified'
			and formation.source_path_key_sha256 = new.path_key_sha256 and formation.source_path_version = new.version
			and formation.source_snapshot_id = (select file.head_snapshot_id from public.qorpera_company_files file
				where file.environment_id = new.environment_id)
			and formation.source_file_sha256 = new.entry #>> '{file,fileSha256}') then
		raise exception 'Company formation projection did not advance with the Company File' using errcode = '23514'; end if;
	if v_kind = 'department' then
		v_id := substring(split_part(public.qorpera_company_path_key(new.path),'/',3) from 1 for 36)::uuid;
		if not exists (select 1 from public.qorpera_company_departments department where department.id = v_id
			and department.environment_id = new.environment_id and department.source_path_version = new.version
			and department.source_snapshot_id = (select file.head_snapshot_id from public.qorpera_company_files file
				where file.environment_id = new.environment_id)
			and department.source_file_sha256 = new.entry #>> '{file,fileSha256}') then
			raise exception 'Department projection did not advance with the Company File' using errcode = '23514'; end if;
	end if;
	if v_kind = 'project' then
		v_id := substring(split_part(public.qorpera_company_path_key(new.path),'/',3) from 1 for 36)::uuid;
		if not exists (select 1 from public.qorpera_company_projects project where project.id = v_id
			and project.environment_id = new.environment_id and project.source_path_version = new.version
			and project.source_snapshot_id = (select file.head_snapshot_id from public.qorpera_company_files file
				where file.environment_id = new.environment_id)
			and project.source_file_sha256 = new.entry #>> '{file,fileSha256}') then
			raise exception 'Project projection did not advance with the Company File' using errcode = '23514'; end if;
	end if;
	return new;
end
$$;
create constraint trigger qorpera_company_path_organization_projection
after insert or update of path,version,entry on public.qorpera_company_path_entries
deferrable initially deferred for each row execute function public.qorpera_assert_organization_projection();

create function public.qorpera_apply_member_company_path_command_v2(
	p_command_id uuid,p_plan_sha256 text,p_expected_head uuid,p_tree_sha256 text,p_document_text text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_command public.qorpera_member_company_path_commands%rowtype; v_result jsonb;
begin
	v_actor := public.qorpera_member_company_path_command_actor(p_command_id,p_plan_sha256,true);
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	if v_command.status = 'applied' then return public.qorpera_member_company_path_command_value(v_command); end if;
	v_result := public.qorpera_publish_company_path(v_actor,null,v_command.plan,p_expected_head,p_tree_sha256,null,null);
	perform public.qorpera_project_organization_document(v_actor,v_command.plan,p_document_text,
		(v_result ->> 'snapshotId')::uuid,(v_result ->> 'version')::uuid);
	if v_command.expires_at <= clock_timestamp() then
		raise exception 'Company File edit expired' using errcode = '42501'; end if;
	update public.qorpera_member_company_path_commands set status = 'applied',result = v_result
	where id = p_command_id returning * into v_command;
	return public.qorpera_member_company_path_command_value(v_command);
end
$$;

create function public.qorpera_apply_company_path_approval_v2(
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
	perform public.qorpera_project_organization_document(v_actor,v_proposal.plan,p_document_text,
		(v_result ->> 'snapshotId')::uuid,(v_result ->> 'version')::uuid);
	update public.qorpera_company_path_proposals set status = 'applied',resolved_by_user_id = approved_by_user_id,
		resolved_at = clock_timestamp(),output_snapshot_id = (v_result ->> 'snapshotId')::uuid where id = p_proposal_id;
	return jsonb_build_object('state','applied','proposalId',p_proposal_id,'snapshotId',v_result ->> 'snapshotId');
end
$$;

create or replace function public.qorpera_company_path_principal_allowed(
	p_profile_id uuid,p_resource public.qorpera_company_path_resources,
	p_kind text,p_id uuid,p_permission text
)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role; v_department uuid; v_project uuid; v_permissions text[];
begin
	if p_resource.id is null or p_resource.revoked_at is not null or p_permission not in ('read','write') then return false; end if;
	if p_resource.scope = 'department_scoped' then
		select mapping.department_id,case when p_kind = 'member' then mapping.member_permissions
			else mapping.staff_permissions end into v_department,v_permissions
		from public.qorpera_department_path_resources mapping
		where mapping.resource_id = p_resource.id and mapping.profile_id = p_profile_id;
		if not exists (select 1 from public.qorpera_company_departments department
			where department.profile_id = p_profile_id and department.id = v_department
				and department.status not in ('paused','retired')) then return false; end if;
		if p_kind = 'member' then
			select role into v_role from public.qorpera_profile_members
			where profile_id = p_profile_id and user_id = p_id;
			if v_role is null then return false; end if;
			return v_role in ('owner','admin') or (p_permission = any(v_permissions) and exists (
				select 1 from public.qorpera_company_departments department
				where department.id = v_department and department.accountable_user_id = p_id));
		elsif p_kind = 'staff_agent' then
			if not exists (select 1 from public.qorpera_profile_staff staff
				join public.qorpera_department_staff_memberships membership on membership.profile_id = staff.profile_id
					and membership.staff_agent_id = staff.staff_agent_id
				where staff.profile_id = p_profile_id and staff.staff_agent_id = p_id
					and staff.employment_status = 'active' and membership.department_id = v_department
					and membership.status = 'active') then return false; end if;
			return p_permission = any(v_permissions);
		else return false; end if;
	end if;
	if p_resource.scope = 'project_scoped' then
		select mapping.project_id,case when p_kind = 'member' then mapping.member_permissions
			else mapping.staff_permissions end into v_project,v_permissions
		from public.qorpera_project_path_resources mapping
		where mapping.resource_id = p_resource.id and mapping.profile_id = p_profile_id;
		if not exists (select 1 from public.qorpera_company_projects project
			where project.profile_id = p_profile_id and project.id = v_project
				and project.status not in ('completed','cancelled')) then return false; end if;
		if p_kind = 'member' then
			select role into v_role from public.qorpera_profile_members
			where profile_id = p_profile_id and user_id = p_id;
			if v_role is null then return false; end if;
			return v_role in ('owner','admin') or (p_permission = any(v_permissions) and exists (
				select 1 from public.qorpera_company_projects project
				join public.qorpera_company_departments department on department.id = project.sponsoring_department_id
				where project.id = v_project and department.accountable_user_id = p_id));
		elsif p_kind = 'staff_agent' then
			return p_permission = any(v_permissions) and exists (
				select 1 from public.qorpera_profile_staff staff
				join public.qorpera_project_staff_memberships membership on membership.profile_id = staff.profile_id
					and membership.staff_agent_id = staff.staff_agent_id
				where staff.profile_id = p_profile_id and staff.staff_agent_id = p_id
					and staff.employment_status = 'active' and membership.project_id = v_project
					and membership.status = 'active');
		end if;
		return false;
	end if;
	if p_kind = 'member' then
		select role into v_role from public.qorpera_profile_members where profile_id = p_profile_id and user_id = p_id;
		if v_role is null then return false; end if;
		if p_resource.scope = 'company_shared' then return p_permission = 'read' or v_role in ('owner','admin','contributor'); end if;
		if p_resource.scope = 'member_private' and p_resource.owner_user_id = p_id then return true; end if;
	elsif p_kind = 'staff_agent' then
		if not exists (select 1 from public.qorpera_profile_staff where profile_id = p_profile_id
			and staff_agent_id = p_id and employment_status = 'active') then return false; end if;
	else return false; end if;
	return exists (select 1 from public.qorpera_company_path_grants grant_row
		where grant_row.resource_id = p_resource.id and grant_row.principal_kind = p_kind
			and grant_row.principal_id = p_id and grant_row.resource_version = p_resource.version
			and p_permission = any(grant_row.permissions) and grant_row.revoked_at is null
			and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp()));
end
$$;

revoke all on function public.qorpera_organization_path_kind(text),
	public.qorpera_project_scoped_path_resources(jsonb,text,uuid,jsonb,uuid),
	public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid),
	public.qorpera_enable_company_path_gateway_v2(uuid,uuid,uuid,jsonb),
	public.qorpera_assert_organization_projection(),
	public.qorpera_apply_member_company_path_command_v2(uuid,text,uuid,text,text),
	public.qorpera_apply_company_path_approval_v2(uuid,text,uuid,text,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_apply_member_company_path_command_v2(uuid,text,uuid,text,text),
	public.qorpera_apply_company_path_approval_v2(uuid,text,uuid,text,text) to service_role;
grant execute on function public.qorpera_enable_company_path_gateway_v2(uuid,uuid,uuid,jsonb) to service_role;
