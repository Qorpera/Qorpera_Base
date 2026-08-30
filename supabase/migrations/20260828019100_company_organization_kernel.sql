-- Runtime Order 0 organization kernel. These rows are closed enforcement
-- projections for one company Co-Founder, formation, departments, measures,
-- responsibilities, projects, and their staff assignments. The Company File
-- source binding is recorded separately by the dedicated organization adapter.

create table public.qorpera_company_formations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null unique references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	state text not null default 'source_inventory' check (state in (
		'source_inventory','discovery','research','vision_proposal','goals_ratified','organization_formation','operating'
	)),
	status text not null default 'active' check (status in ('active','completed','paused')),
	revision bigint not null default 1 check (revision > 0),
	projection_status text not null default 'pending_company_file'
		check (projection_status in ('pending_company_file','verified')),
	source_path text,
	source_path_version uuid,
	source_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	source_file_sha256 text check (source_file_sha256 is null or source_file_sha256 ~ '^[0-9a-f]{64}$'),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	foreign key (profile_id,environment_id)
		references public.qorpera_company_files(profile_id,environment_id) on delete cascade,
	check ((projection_status = 'verified') = (
		source_path is not null and source_path_version is not null
		and source_snapshot_id is not null and source_file_sha256 is not null
	)),
	check (source_path is null or public.qorpera_company_path_valid(source_path))
);

create table public.qorpera_company_cofounders (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	formation_id uuid not null unique references public.qorpera_company_formations(id) on delete restrict,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	foreign key (profile_id,environment_id)
		references public.qorpera_company_files(profile_id,environment_id) on delete cascade,
	foreign key (profile_id,staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	unique (profile_id,staff_agent_id)
);

create unique index qorpera_profile_staff_one_company_cofounder
	on public.qorpera_profile_staff(profile_id)
	where template_id = 'co-founder';

create table public.qorpera_company_departments (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	name text not null check (char_length(btrim(name)) between 1 and 160),
	charter text not null check (octet_length(convert_to(charter,'utf8')) between 1 and 32768),
	non_responsibilities text[] not null default '{}'::text[] check (cardinality(non_responsibilities) <= 64),
	accountable_user_id uuid not null,
	lead_staff_agent_id uuid,
	default_room_id uuid,
	status text not null check (status in ('proposed','forming','active','degraded','paused','retired')),
	intake_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(intake_policy) = 'object' and pg_column_size(intake_policy) <= 16384),
	prioritization_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(prioritization_policy) = 'object' and pg_column_size(prioritization_policy) <= 16384),
	budget_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(budget_policy) = 'object' and pg_column_size(budget_policy) <= 16384),
	effort_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(effort_policy) = 'object' and pg_column_size(effort_policy) <= 16384),
	concurrency_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(concurrency_policy) = 'object' and pg_column_size(concurrency_policy) <= 16384),
	execution_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(execution_policy) = 'object' and pg_column_size(execution_policy) <= 16384),
	project_creation_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(project_creation_policy) = 'object' and pg_column_size(project_creation_policy) <= 16384),
	escalation_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(escalation_policy) = 'object' and pg_column_size(escalation_policy) <= 16384),
	routine_ids uuid[] not null default '{}'::uuid[] check (
		cardinality(routine_ids) <= 128 and public.qorpera_uuid_array_is_unique(routine_ids)
	),
	listener_ids uuid[] not null default '{}'::uuid[] check (
		cardinality(listener_ids) <= 128 and public.qorpera_uuid_array_is_unique(listener_ids)
	),
	external_operation_grants jsonb not null default '[]'::jsonb check (
		jsonb_typeof(external_operation_grants) = 'array' and pg_column_size(external_operation_grants) <= 32768
	),
	version bigint not null default 1 check (version > 0),
	source_path text not null check (public.qorpera_company_path_valid(source_path)),
	source_path_version uuid not null,
	source_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	source_file_sha256 text not null check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	foreign key (profile_id,environment_id)
		references public.qorpera_company_files(profile_id,environment_id) on delete cascade,
	foreign key (profile_id,accountable_user_id)
		references public.qorpera_profile_members(profile_id,user_id) on delete restrict,
	foreign key (profile_id,lead_staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	unique (profile_id,id),
	unique (profile_id,slug),
	unique (environment_id,source_path),
	check (status <> 'active' or lead_staff_agent_id is not null),
	check (not (routine_ids && listener_ids))
);

create table public.qorpera_department_staff_memberships (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	department_id uuid not null,
	staff_agent_id uuid not null,
	assignment_kind text not null check (assignment_kind in ('primary','supporting')),
	role text not null check (char_length(btrim(role)) between 1 and 320),
	status text not null default 'active' check (status in ('active','ended')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	ended_at timestamptz,
	primary key (department_id,staff_agent_id),
	foreign key (profile_id,department_id)
		references public.qorpera_company_departments(profile_id,id) on delete cascade,
	foreign key (profile_id,staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	check ((status = 'ended') = (ended_at is not null))
);
create unique index qorpera_department_staff_one_active_primary
	on public.qorpera_department_staff_memberships(profile_id,staff_agent_id)
	where assignment_kind = 'primary' and status = 'active';

create table public.qorpera_department_responsibilities (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	department_id uuid not null,
	responsibility_key text not null check (responsibility_key ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
	label text not null check (char_length(btrim(label)) between 1 and 256),
	boundary text not null check (octet_length(convert_to(boundary,'utf8')) between 1 and 16384),
	status text not null default 'active' check (status in ('active','retired')),
	foreign key (profile_id,department_id)
		references public.qorpera_company_departments(profile_id,id) on delete cascade,
	unique (department_id,responsibility_key)
);

create table public.qorpera_department_measures (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	department_id uuid not null,
	measure_key text not null check (measure_key ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
	label text not null check (char_length(btrim(label)) between 1 and 256),
	definition text not null check (octet_length(convert_to(definition,'utf8')) between 1 and 16384),
	source_path text not null check (public.qorpera_company_path_valid(source_path)),
	source_path_version uuid not null,
	source_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	source_file_sha256 text not null check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
	direction text not null check (direction in ('higher_is_better','lower_is_better','target','observe')),
	target jsonb not null check (pg_column_size(target) <= 8192),
	guardrails jsonb not null default '[]'::jsonb check (jsonb_typeof(guardrails) = 'array' and pg_column_size(guardrails) <= 16384),
	cadence text not null check (char_length(btrim(cadence)) between 1 and 256),
	accountable_staff_agent_id uuid not null,
	status text not null default 'active' check (status in ('active','paused','retired')),
	foreign key (profile_id,department_id)
		references public.qorpera_company_departments(profile_id,id) on delete cascade,
	foreign key (profile_id,accountable_staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	unique (department_id,measure_key)
);

create table public.qorpera_company_projects (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	project_key text not null check (project_key ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
	name text not null check (char_length(btrim(name)) between 1 and 256),
	objective text not null check (octet_length(convert_to(objective,'utf8')) between 1 and 32768),
	definition_of_done text not null check (octet_length(convert_to(definition_of_done,'utf8')) between 1 and 32768),
	scope_kind text not null check (scope_kind in ('company','department')),
	sponsoring_department_id uuid,
	lead_staff_agent_id uuid not null,
	room_id uuid,
	status text not null check (status in ('proposed','active','blocked','completed','cancelled')),
	authorized_source_paths text[] not null default '{}'::text[] check (cardinality(authorized_source_paths) <= 256),
	authorized_output_paths text[] not null default '{}'::text[] check (cardinality(authorized_output_paths) <= 256),
	dependencies jsonb not null default '[]'::jsonb check (jsonb_typeof(dependencies) = 'array' and pg_column_size(dependencies) <= 32768),
	reasoning_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(reasoning_policy) = 'object' and pg_column_size(reasoning_policy) <= 16384),
	worker_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(worker_policy) = 'object' and pg_column_size(worker_policy) <= 16384),
	execution_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(execution_policy) = 'object' and pg_column_size(execution_policy) <= 16384),
	outcome jsonb check (outcome is null or (jsonb_typeof(outcome) = 'object' and pg_column_size(outcome) <= 32768)),
	version bigint not null default 1 check (version > 0),
	source_path text not null check (public.qorpera_company_path_valid(source_path)),
	source_path_version uuid not null,
	source_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	source_file_sha256 text not null check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	foreign key (profile_id,environment_id)
		references public.qorpera_company_files(profile_id,environment_id) on delete cascade,
	foreign key (profile_id,sponsoring_department_id)
		references public.qorpera_company_departments(profile_id,id) on delete restrict,
	foreign key (profile_id,lead_staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	unique (profile_id,id),
	unique (profile_id,project_key),
	unique (environment_id,source_path),
	check ((scope_kind = 'department') = (sponsoring_department_id is not null)),
	check ((status in ('completed','cancelled')) = (outcome is not null))
);

create table public.qorpera_project_staff_memberships (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	project_id uuid not null,
	staff_agent_id uuid not null,
	role text not null check (char_length(btrim(role)) between 1 and 320),
	status text not null default 'active' check (status in ('active','ended')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	ended_at timestamptz,
	primary key (project_id,staff_agent_id),
	foreign key (profile_id,project_id)
		references public.qorpera_company_projects(profile_id,id) on delete cascade,
	foreign key (profile_id,staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	check ((status = 'ended') = (ended_at is not null))
);

alter table public.qorpera_company_formations enable row level security;
alter table public.qorpera_company_cofounders enable row level security;
alter table public.qorpera_company_departments enable row level security;
alter table public.qorpera_department_staff_memberships enable row level security;
alter table public.qorpera_department_responsibilities enable row level security;
alter table public.qorpera_department_measures enable row level security;
alter table public.qorpera_company_projects enable row level security;
alter table public.qorpera_project_staff_memberships enable row level security;
revoke all on public.qorpera_company_formations,public.qorpera_company_cofounders,
	public.qorpera_company_departments,public.qorpera_department_staff_memberships,
	public.qorpera_department_responsibilities,public.qorpera_department_measures,
	public.qorpera_company_projects,public.qorpera_project_staff_memberships
	from public,anon,authenticated,service_role;

create function public.qorpera_seed_company_cofounder(p_profile_id uuid,p_created_by_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_environment_id uuid; v_staff_id uuid; v_formation public.qorpera_company_formations%rowtype;
	v_cofounder public.qorpera_company_cofounders%rowtype; v_session jsonb;
begin
	select environment.id into v_environment_id from public.qorpera_company_environments environment
	where environment.profile_id = p_profile_id order by environment.created_at,environment.id limit 1;
	perform 1 from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = p_created_by_user_id for share;
	if v_environment_id is null or not found then
		raise exception 'Co-Founder seed authority is unavailable' using errcode = '42501'; end if;
	select cofounder.* into v_cofounder from public.qorpera_company_cofounders cofounder
	where cofounder.profile_id = p_profile_id for update;
	if found then
		select public.qorpera_shared_session_json(session) into v_session
		from public.qorpera_shared_sessions session where session.profile_id = p_profile_id
			and session.staff_agent_id = v_cofounder.staff_agent_id::text
			and session.audience_kind = 'member_private' and session.audience_user_id = p_created_by_user_id
			and session.status = 'open';
		if v_session is null then
			v_session := public.qorpera_ensure_member_private_staff_session_internal(
				v_environment_id,v_cofounder.staff_agent_id,p_created_by_user_id,extensions.gen_random_uuid(),'Co-Founder');
		end if;
		return jsonb_build_object('staff_agent_id',v_cofounder.staff_agent_id,
			'formation_id',v_cofounder.formation_id,'member_session_id',v_session ->> 'session_id');
	end if;
	select staff.staff_agent_id into v_staff_id from public.qorpera_profile_staff staff
	where staff.profile_id = p_profile_id and staff.template_id = 'co-founder';
	if v_staff_id is null then
		v_staff_id := extensions.gen_random_uuid();
		insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,template_id,
			appearance_color,appearance_shape,appearance_creature,employment_status,lifecycle_state,version,
			created_at,updated_at,updated_by_user_id)
		values (p_profile_id,v_staff_id,'Co-Founder','Company direction, priority synthesis, and organizational routing',
			$charter$Own company direction, priority synthesis, and routing across departments. Bring the founder decisions, blockers, and material risks; delegate bounded work through explicit agents, projects, rooms, and workers. Work by changing the Company File. Do not grant authority, approve your own gated changes, or make external commitments without the responsible human.$charter$,
			'co-founder','qorpera-blue','round','brain','active','setup',1,
			statement_timestamp(),statement_timestamp(),p_created_by_user_id);
	end if;
	insert into public.qorpera_company_formations(profile_id,environment_id,created_by_user_id)
	values (p_profile_id,v_environment_id,p_created_by_user_id) returning * into v_formation;
	insert into public.qorpera_company_cofounders(profile_id,environment_id,staff_agent_id,formation_id,created_by_user_id)
	values (p_profile_id,v_environment_id,v_staff_id,v_formation.id,p_created_by_user_id) returning * into v_cofounder;
	v_session := public.qorpera_ensure_member_private_staff_session_internal(
		v_environment_id,v_staff_id,p_created_by_user_id,extensions.gen_random_uuid(),'Co-Founder');
	return jsonb_build_object('staff_agent_id',v_staff_id,'formation_id',v_formation.id,
		'member_session_id',v_session ->> 'session_id');
end
$$;

create function public.qorpera_seed_cofounder_member_session()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cofounder public.qorpera_company_cofounders%rowtype;
begin
	if new.role = 'viewer' then return new; end if;
	select * into v_cofounder from public.qorpera_company_cofounders where profile_id = new.profile_id;
	if found then
		perform public.qorpera_ensure_member_private_staff_session_internal(
			v_cofounder.environment_id,v_cofounder.staff_agent_id,new.user_id,extensions.gen_random_uuid(),'Co-Founder');
	end if;
	return new;
end
$$;
create trigger qorpera_profile_members_seed_cofounder_session
after insert or update of role on public.qorpera_profile_members
for each row when (new.role <> 'viewer') execute function public.qorpera_seed_cofounder_member_session();

create function public.qorpera_company_organization_bootstrap(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cofounder public.qorpera_company_cofounders%rowtype;
	v_formation public.qorpera_company_formations%rowtype; v_session_id uuid;
begin
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'company organization write access is required' using errcode = '42501'; end if;
	select * into v_cofounder from public.qorpera_company_cofounders where profile_id = p_profile_id;
	select * into v_formation from public.qorpera_company_formations where profile_id = p_profile_id;
	select session.id into v_session_id from public.qorpera_shared_sessions session
	where session.profile_id = p_profile_id and session.staff_agent_id = v_cofounder.staff_agent_id::text
		and session.audience_kind = 'member_private' and session.audience_user_id = auth.uid()
		and session.status = 'open' limit 1;
	if v_cofounder.profile_id is null or v_formation.id is null or v_session_id is null
		or v_cofounder.formation_id <> v_formation.id then
		raise exception 'company organization bootstrap is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object('schema','qorpera.company-organization-bootstrap/v1',
		'cofounder',jsonb_build_object('staff_agent_id',v_cofounder.staff_agent_id,
			'formation_id',v_formation.id,'member_session_id',v_session_id),
		'formation_state',v_formation.state);
end
$$;

create function public.qorpera_department_resources_json(p_department_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$ select '[]'::jsonb $$;
create function public.qorpera_project_resources_json(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$ select '[]'::jsonb $$;

create function public.qorpera_company_organization_json(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cofounder public.qorpera_company_cofounders%rowtype; v_formation public.qorpera_company_formations%rowtype;
begin
	if not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'company organization read access is required' using errcode = '42501'; end if;
	select * into v_cofounder from public.qorpera_company_cofounders where profile_id = p_profile_id;
	select * into v_formation from public.qorpera_company_formations where profile_id = p_profile_id;
	return jsonb_build_object(
		'schema','qorpera.company-organization/v1','profile_id',p_profile_id,
		'cofounder',case when v_cofounder.profile_id is null then null else jsonb_build_object(
			'staff_agent_id',v_cofounder.staff_agent_id,'formation_id',v_cofounder.formation_id,
			'member_session_id',(select session.id from public.qorpera_shared_sessions session
				where session.profile_id = p_profile_id and session.staff_agent_id = v_cofounder.staff_agent_id::text
					and session.audience_kind = 'member_private' and session.audience_user_id = auth.uid()
					and session.status = 'open' limit 1)) end,
		'formation',case when v_formation.id is null then null else jsonb_build_object(
			'formation_id',v_formation.id,'state',v_formation.state,'status',v_formation.status,
			'revision',v_formation.revision,'projection_status',v_formation.projection_status,
			'source_path',v_formation.source_path,'source_path_version',v_formation.source_path_version,
			'source_snapshot_id',v_formation.source_snapshot_id,'source_file_sha256',v_formation.source_file_sha256) end,
		'departments',coalesce((select jsonb_agg(jsonb_build_object(
			'department_id',department.id,'slug',department.slug,'name',department.name,'charter',department.charter,
			'non_responsibilities',to_jsonb(department.non_responsibilities),
			'accountable_user_id',department.accountable_user_id,'lead_staff_agent_id',department.lead_staff_agent_id,
			'default_room_id',department.default_room_id,'status',department.status,'version',department.version,
			'intake_policy',department.intake_policy,'prioritization_policy',department.prioritization_policy,
			'budget_policy',department.budget_policy,'effort_policy',department.effort_policy,
			'concurrency_policy',department.concurrency_policy,'execution_policy',department.execution_policy,
			'project_creation_policy',department.project_creation_policy,'escalation_policy',department.escalation_policy,
			'routine_ids',to_jsonb(department.routine_ids),'listener_ids',to_jsonb(department.listener_ids),
			'external_operation_grants',department.external_operation_grants,
			'resources',public.qorpera_department_resources_json(department.id),
			'active_projects',coalesce((select jsonb_agg(jsonb_build_object(
				'project_id',project.id,'key',project.project_key,'name',project.name,'status',project.status,
				'lead_staff_agent_id',project.lead_staff_agent_id,'room_id',project.room_id
			) order by project.created_at,project.id) from public.qorpera_company_projects project
			where project.sponsoring_department_id = department.id
				and project.status in ('proposed','active','blocked')),'[]'::jsonb),
			'source_path',department.source_path,'source_path_version',department.source_path_version,
			'source_snapshot_id',department.source_snapshot_id,'source_file_sha256',department.source_file_sha256,
			'staff',coalesce((select jsonb_agg(jsonb_build_object('staff_agent_id',membership.staff_agent_id,
				'assignment_kind',membership.assignment_kind,'role',membership.role,'status',membership.status)
				order by membership.staff_agent_id) from public.qorpera_department_staff_memberships membership
				where membership.department_id = department.id),'[]'::jsonb),
			'responsibilities',coalesce((select jsonb_agg(jsonb_build_object('responsibility_id',responsibility.id,
				'key',responsibility.responsibility_key,'label',responsibility.label,'boundary',responsibility.boundary,
				'status',responsibility.status) order by responsibility.responsibility_key)
				from public.qorpera_department_responsibilities responsibility
				where responsibility.department_id = department.id),'[]'::jsonb),
			'measures',coalesce((select jsonb_agg(jsonb_build_object('measure_id',measure.id,'key',measure.measure_key,
				'label',measure.label,'definition',measure.definition,'source_path',measure.source_path,
				'source_path_version',measure.source_path_version,'source_snapshot_id',measure.source_snapshot_id,
				'source_file_sha256',measure.source_file_sha256,
				'direction',measure.direction,'target',measure.target,'guardrails',measure.guardrails,
				'cadence',measure.cadence,'accountable_staff_agent_id',measure.accountable_staff_agent_id,
				'status',measure.status) order by measure.measure_key)
				from public.qorpera_department_measures measure where measure.department_id = department.id),'[]'::jsonb)
		) order by department.slug) from public.qorpera_company_departments department
		where department.profile_id = p_profile_id),'[]'::jsonb),
		'projects',coalesce((select jsonb_agg(jsonb_build_object(
			'project_id',project.id,'key',project.project_key,'name',project.name,'objective',project.objective,
			'definition_of_done',project.definition_of_done,'scope_kind',project.scope_kind,
			'sponsoring_department_id',project.sponsoring_department_id,'lead_staff_agent_id',project.lead_staff_agent_id,
			'room_id',project.room_id,'status',project.status,'authorized_source_paths',to_jsonb(project.authorized_source_paths),
			'authorized_output_paths',to_jsonb(project.authorized_output_paths),'dependencies',project.dependencies,
			'reasoning_policy',project.reasoning_policy,'worker_policy',project.worker_policy,
			'execution_policy',project.execution_policy,'resources',public.qorpera_project_resources_json(project.id),
			'outcome',project.outcome,'version',project.version,'source_path',project.source_path,
			'source_path_version',project.source_path_version,'source_snapshot_id',project.source_snapshot_id,
			'source_file_sha256',project.source_file_sha256,
			'staff',coalesce((select jsonb_agg(jsonb_build_object('staff_agent_id',membership.staff_agent_id,
				'role',membership.role,'status',membership.status) order by membership.staff_agent_id)
				from public.qorpera_project_staff_memberships membership where membership.project_id = project.id),'[]'::jsonb)
		) order by project.created_at,project.id) from public.qorpera_company_projects project
		where project.profile_id = p_profile_id),'[]'::jsonb)
	);
end
$$;

create or replace function public.qorpera_create_cloud_company(
	p_client_creation_id uuid,p_company_name text,p_contract_version integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_name text := btrim(p_company_name);
	v_request public.qorpera_company_creation_requests%rowtype; v_profile jsonb;
	v_file public.qorpera_company_files%rowtype; v_cofounder jsonb;
begin
	if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if p_client_creation_id is null or char_length(v_name) not between 1 and 120 or p_contract_version is distinct from 2 then
		raise exception 'company creation is invalid' using errcode = '22023'; end if;
	insert into public.qorpera_company_creation_requests(created_by_user_id,client_creation_id,profile_name,contract_version)
	values (v_user_id,p_client_creation_id,v_name,p_contract_version)
	on conflict (created_by_user_id,client_creation_id) do nothing returning * into v_request;
	if not found then
		select request.* into v_request from public.qorpera_company_creation_requests request
		where request.created_by_user_id = v_user_id and request.client_creation_id = p_client_creation_id for update;
		if v_request.profile_name <> v_name or v_request.contract_version <> p_contract_version then
			raise exception 'company creation id is already bound to another request' using errcode = '23505'; end if;
	end if;
	if v_request.profile_id is null then
		v_profile := public.qorpera_create_hosted_profile(v_name,v_name,p_contract_version);
		update public.qorpera_company_creation_requests set profile_id = (v_profile ->> 'profile_id')::uuid
		where created_by_user_id = v_user_id and client_creation_id = p_client_creation_id returning * into v_request;
	else
		select jsonb_build_object('profile_id',profile.id,'environment_id',environment.id,
			'profile_name',profile.name,'environment_name',environment.name,'role',member.role,
			'contract_version',environment.contract_version,'created_at',profile.created_at) into v_profile
		from public.qorpera_profiles profile join public.qorpera_profile_members member on member.profile_id = profile.id
		join public.qorpera_company_environments environment on environment.profile_id = profile.id
		where profile.id = v_request.profile_id and member.user_id = v_user_id;
	end if;
	v_cofounder := public.qorpera_seed_company_cofounder((v_profile ->> 'profile_id')::uuid,v_user_id);
	select * into strict v_file from public.qorpera_company_files file
	where file.profile_id = (v_profile ->> 'profile_id')::uuid and file.environment_id = (v_profile ->> 'environment_id')::uuid;
	return v_profile || jsonb_build_object('company_file',public.qorpera_company_file_json(v_file),
		'organization',jsonb_build_object('schema','qorpera.company-organization-bootstrap/v1',
			'cofounder',v_cofounder,'formation_state','source_inventory'));
end
$$;

-- Existing companies receive the same one-Co-Founder invariant. This is
-- idempotent and creates one private attended session for each writable member.
do $$
declare v_profile public.qorpera_profiles%rowtype; v_owner uuid; v_cofounder jsonb; v_member record;
begin
	for v_profile in select * from public.qorpera_profiles order by created_at,id loop
		select user_id into v_owner from public.qorpera_profile_members
		where profile_id = v_profile.id and role = 'owner';
		v_cofounder := public.qorpera_seed_company_cofounder(v_profile.id,v_owner);
		for v_member in select user_id from public.qorpera_profile_members
			where profile_id = v_profile.id and role in ('owner','admin','contributor') loop
			perform public.qorpera_ensure_member_private_staff_session_internal(
				(select environment_id from public.qorpera_company_cofounders where profile_id = v_profile.id),
				(v_cofounder ->> 'staff_agent_id')::uuid,v_member.user_id,extensions.gen_random_uuid(),'Co-Founder');
		end loop;
	end loop;
end
$$;

revoke all on function public.qorpera_seed_company_cofounder(uuid,uuid),
	public.qorpera_seed_cofounder_member_session(),public.qorpera_company_organization_bootstrap(uuid),
	public.qorpera_department_resources_json(uuid),public.qorpera_project_resources_json(uuid),
	public.qorpera_company_organization_json(uuid)
	from public,anon,authenticated,service_role;
-- CREATE OR REPLACE preserves the owner of a production function. A database
-- restored from production can therefore retain a different owner for the
-- public company-creation entry point than the role applying this migration.
-- Grant only that already-authoritative owner access to the private seed
-- helper; never expose the helper to an API role.
do $$
declare v_entry_owner name; v_retained_owner name;
begin
	select role.rolname into v_entry_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_create_cloud_company(uuid,text,integer)'::regprocedure;
	if v_entry_owner is null then
		raise exception 'Company creation function owner is unavailable' using errcode = '55000';
	end if;
	execute format(
		'grant execute on function public.qorpera_seed_company_cofounder(uuid,uuid) to %I',
		v_entry_owner
	);
	select role.rolname into v_retained_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_company_retained_object_hashes(uuid)'::regprocedure;
	if v_retained_owner is null then
		raise exception 'Company retention function owner is unavailable' using errcode = '55000';
	end if;
	execute format(
		'grant execute on function public.qorpera_company_additional_retained_object_hashes(uuid) to %I',
		v_retained_owner
	);
end
$$;
grant execute on function public.qorpera_company_organization_bootstrap(uuid) to authenticated;
grant execute on function public.qorpera_company_organization_json(uuid) to authenticated;
revoke all on function public.qorpera_create_cloud_company(uuid,text,integer) from public,anon;
grant execute on function public.qorpera_create_cloud_company(uuid,text,integer) to authenticated;
