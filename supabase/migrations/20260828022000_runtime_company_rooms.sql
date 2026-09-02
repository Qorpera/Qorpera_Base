-- Runtime Step 3 (contract Order 3, 14.7, 8.1): rooms.
-- A room is an explicit member list with an audience and capability policy,
-- a canonical organization object (organization/rooms/<roomId>.json,
-- qorpera.company-room/v1) projected into qorpera_company_rooms and
-- qorpera_company_room_members. Each active room owns one group conversation
-- (a shared session with execution_scope.roomId and no single staff agent).
-- A member post creates one durable input in that conversation and one room
-- wake per active agent member; each agent acts for the room audience under
-- the closed room policy (optional/optional, at most three public sends,
-- silence allowed). Agent sends into the room do not fan out; addressed
-- coworker delivery remains the separate, causally fenced path.

create table public.qorpera_company_rooms (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	room_key text not null check (room_key ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
	name text not null check (char_length(btrim(name)) between 1 and 256),
	purpose text not null check (octet_length(convert_to(purpose,'utf8')) between 1 and 32768),
	status text not null check (status in ('active','archived')),
	project_id uuid,
	session_id uuid references public.qorpera_shared_sessions(id) on delete restrict,
	version bigint not null check (version > 0),
	source_path text not null check (public.qorpera_company_path_valid(source_path)),
	source_path_version uuid not null,
	source_snapshot_id uuid not null,
	source_file_sha256 text not null check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (profile_id, room_key),
	unique (session_id)
);
alter table public.qorpera_company_rooms enable row level security;
revoke all on public.qorpera_company_rooms from public, anon, authenticated, service_role;
grant select on public.qorpera_company_rooms to service_role;

create table public.qorpera_company_room_members (
	room_id uuid not null references public.qorpera_company_rooms(id) on delete cascade,
	principal_kind text not null check (principal_kind in ('member','staff_agent')),
	principal_id uuid not null,
	status text not null check (status in ('active','removed')),
	source_path_version uuid not null,
	added_at timestamptz not null default clock_timestamp(),
	removed_at timestamptz,
	primary key (room_id, principal_kind, principal_id)
);
alter table public.qorpera_company_room_members enable row level security;
revoke all on public.qorpera_company_room_members from public, anon, authenticated, service_role;
grant select on public.qorpera_company_room_members to service_role;

-- True when the session is the conversation of an active room whose active
-- agent members include the staff agent.
create function public.qorpera_company_room_session_staff(p_session_id uuid, p_staff_agent_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1 from public.qorpera_company_rooms as room
		join public.qorpera_company_room_members as member on member.room_id = room.id
		where room.session_id = p_session_id and room.status = 'active'
			and member.principal_kind = 'staff_agent' and member.principal_id = p_staff_agent_id and member.status = 'active')
$$;
revoke all on function public.qorpera_company_room_session_staff(uuid, uuid) from public, anon, authenticated, service_role;

-- Organization path kinds gain rooms (was 20260828019200_company_organization_projection.sql).
create or replace function public.qorpera_organization_path_kind(p_path text)
returns text language plpgsql immutable set search_path = '' as $$
declare v_path text := public.qorpera_company_path_key(p_path);
begin
	if v_path = 'organization/formation.json' then return 'formation'; end if;
	if v_path ~ '^organization/responsibilities/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return 'responsibility'; end if;
	if v_path ~ '^organization/projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return 'project'; end if;
	if v_path ~ '^organization/rooms/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return 'room'; end if;
	return null;
end
$$;

-- Room documents project into rooms, members and one group conversation (was 20260828019200_company_organization_projection.sql).
create or replace function public.qorpera_project_organization_document(
	p_actor jsonb,p_plan jsonb,p_document_text text,p_snapshot_id uuid,p_path_version uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_kind text := public.qorpera_organization_path_kind(p_plan ->> 'path');
	v_document jsonb; v_profile_id uuid := (p_actor ->> 'companyId')::uuid;
	v_environment_id uuid := (p_actor ->> 'environmentId')::uuid;
	v_user_id uuid := (p_actor ->> 'userId')::uuid; v_item jsonb; v_id uuid;
	v_role public.qorpera_profile_role;
	v_responsibility public.qorpera_company_responsibilities%rowtype;
	v_project public.qorpera_company_projects%rowtype;
	v_room public.qorpera_company_rooms%rowtype; v_room_session uuid;
	v_source jsonb; v_target jsonb; v_entry public.qorpera_company_path_entries%rowtype;
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

	if v_kind = 'responsibility' then
		if not (v_document ?& array['schema','responsibilityId','slug','name','outcome','accountableStaffAgentId',
			'accountableUserId','attentionCadence','escalationThreshold','escalationTarget','effortPolicy','budgetPolicy',
			'concurrencyPolicy','routineIds','listenerIds','externalOperationGrants','resources','status','version','measures'])
			or v_document - array['schema','responsibilityId','slug','name','outcome','accountableStaffAgentId',
				'accountableUserId','attentionCadence','escalationThreshold','escalationTarget','effortPolicy','budgetPolicy',
				'concurrencyPolicy','routineIds','listenerIds','externalOperationGrants','resources','status','version','measures'] <> '{}'::jsonb
			or v_document ->> 'schema' <> 'qorpera.responsibility/v1'
			or jsonb_typeof(v_document -> 'escalationThreshold') <> 'object'
			or jsonb_typeof(v_document -> 'escalationTarget') <> 'object'
			or jsonb_typeof(v_document -> 'effortPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'budgetPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'concurrencyPolicy') <> 'object'
			or jsonb_typeof(v_document -> 'routineIds') <> 'array'
			or jsonb_typeof(v_document -> 'listenerIds') <> 'array'
			or jsonb_typeof(v_document -> 'externalOperationGrants') <> 'array'
			or jsonb_typeof(v_document -> 'resources') <> 'array'
			or jsonb_typeof(v_document -> 'measures') <> 'array'
			or (v_document ->> 'version') !~ '^[1-9][0-9]*$'
			or (v_document ->> 'accountableStaffAgentId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or (v_document -> 'accountableUserId' <> 'null'::jsonb and (v_document ->> 'accountableUserId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
			or jsonb_array_length(v_document -> 'measures') not between 1 and 256
			or jsonb_array_length(v_document -> 'routineIds') > 128
			or jsonb_array_length(v_document -> 'listenerIds') > 128
			or jsonb_array_length(v_document -> 'externalOperationGrants') > 256
			or exists (select 1 from jsonb_array_elements((v_document -> 'routineIds') || (v_document -> 'listenerIds')) value
				where jsonb_typeof(value) <> 'string' or value #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
			raise exception 'Responsibility document is invalid' using errcode = '22023'; end if;
		v_id := (v_document ->> 'responsibilityId')::uuid;
		if public.qorpera_company_path_key(p_plan ->> 'path') <> 'organization/responsibilities/' || v_id::text || '.json' then
			raise exception 'Responsibility path does not match its identity' using errcode = '22023'; end if;
		select * into v_responsibility from public.qorpera_company_responsibilities where id = v_id for update;
		if found and (v_responsibility.profile_id <> v_profile_id or v_responsibility.environment_id <> v_environment_id) then
			raise exception 'Responsibility identity belongs to another company' using errcode = '42501'; end if;
		if (found and (v_document ->> 'version')::bigint <> v_responsibility.version + 1)
			or (not found and (v_document ->> 'version')::bigint <> 1) then
			raise exception 'Responsibility version is not monotonic' using errcode = '22023'; end if;
		if found and v_document ->> 'status' <> v_responsibility.status and not (case v_responsibility.status
			when 'proposed' then v_document ->> 'status' in ('active','retired')
			when 'active' then v_document ->> 'status' in ('degraded','paused','retired')
			when 'degraded' then v_document ->> 'status' in ('active','paused','retired')
			when 'paused' then v_document ->> 'status' in ('active','degraded','retired')
			else false end) then
			raise exception 'Responsibility lifecycle transition is invalid' using errcode = '22023'; end if;
		-- Exactly one accountable agent, currently employed. An optional
		-- accountable human member must be a writable current member.
		if not exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = v_profile_id and staff.staff_agent_id = (v_document ->> 'accountableStaffAgentId')::uuid
				and staff.employment_status = 'active' and staff.deleted_at is null) then
			raise exception 'Responsibility accountable agent is unavailable' using errcode = '42501'; end if;
		if v_document -> 'accountableUserId' <> 'null'::jsonb and not exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = v_profile_id and member.user_id = (v_document ->> 'accountableUserId')::uuid
				and member.role in ('owner','admin','contributor')) then
			raise exception 'Responsibility accountable member is unavailable' using errcode = '42501'; end if;
		v_target := v_document -> 'escalationTarget';
		if not (v_target ?& array['kind','id']) or v_target - array['kind','id'] <> '{}'::jsonb
			or v_target ->> 'kind' not in ('accountable_member','cofounder','member','staff_agent')
			or (v_target ->> 'kind' in ('accountable_member','cofounder') and v_target -> 'id' <> 'null'::jsonb)
			or (v_target ->> 'kind' = 'accountable_member' and v_document -> 'accountableUserId' = 'null'::jsonb)
			or (v_target ->> 'kind' in ('member','staff_agent') and (v_target ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
			or (v_target ->> 'kind' = 'member' and not exists (select 1 from public.qorpera_profile_members member
				where member.profile_id = v_profile_id and member.user_id = (v_target ->> 'id')::uuid
					and member.role in ('owner','admin','contributor')))
			or (v_target ->> 'kind' = 'staff_agent' and not exists (select 1 from public.qorpera_profile_staff staff
				where staff.profile_id = v_profile_id and staff.staff_agent_id = (v_target ->> 'id')::uuid
					and staff.employment_status = 'active' and staff.deleted_at is null)) then
			raise exception 'Responsibility escalation target is invalid' using errcode = '22023'; end if;
		if exists (select 1 from jsonb_array_elements_text(v_document -> 'routineIds') routine(id)
			left join public.qorpera_cloud_routines stored on stored.id = routine.id::uuid
			where stored.id is null or stored.profile_id <> v_profile_id)
			or exists (select 1 from jsonb_array_elements_text(v_document -> 'listenerIds') listener(id)
			left join public.qorpera_cloud_routines stored on stored.id = listener.id::uuid
			where stored.id is null or stored.profile_id <> v_profile_id)
			or exists (select 1 from jsonb_array_elements_text(v_document -> 'routineIds') routine(id)
				join jsonb_array_elements_text(v_document -> 'listenerIds') listener(id) on listener.id = routine.id) then
			raise exception 'Responsibility routine binding is invalid' using errcode = '22023'; end if;
		insert into public.qorpera_company_responsibilities(id,profile_id,environment_id,slug,name,outcome,
			accountable_staff_agent_id,accountable_user_id,attention_cadence,escalation_threshold,escalation_target,
			effort_policy,budget_policy,concurrency_policy,routine_ids,listener_ids,external_operation_grants,status,
			version,source_path,source_path_version,source_snapshot_id,source_file_sha256,created_by_user_id)
		values (v_id,v_profile_id,v_environment_id,v_document ->> 'slug',v_document ->> 'name',v_document ->> 'outcome',
			(v_document ->> 'accountableStaffAgentId')::uuid,nullif(v_document ->> 'accountableUserId','')::uuid,
			v_document ->> 'attentionCadence',v_document -> 'escalationThreshold',v_document -> 'escalationTarget',
			v_document -> 'effortPolicy',v_document -> 'budgetPolicy',v_document -> 'concurrencyPolicy',
			array(select value::uuid from jsonb_array_elements_text(v_document -> 'routineIds') value),
			array(select value::uuid from jsonb_array_elements_text(v_document -> 'listenerIds') value),
			v_document -> 'externalOperationGrants',v_document ->> 'status',(v_document ->> 'version')::bigint,
			p_plan ->> 'path',p_path_version,p_snapshot_id,p_plan #>> '{entry,file,fileSha256}',v_user_id)
		on conflict (id) do update set slug = excluded.slug,name = excluded.name,outcome = excluded.outcome,
			accountable_staff_agent_id = excluded.accountable_staff_agent_id,
			accountable_user_id = excluded.accountable_user_id,attention_cadence = excluded.attention_cadence,
			escalation_threshold = excluded.escalation_threshold,escalation_target = excluded.escalation_target,
			effort_policy = excluded.effort_policy,budget_policy = excluded.budget_policy,
			concurrency_policy = excluded.concurrency_policy,routine_ids = excluded.routine_ids,
			listener_ids = excluded.listener_ids,external_operation_grants = excluded.external_operation_grants,
			status = excluded.status,version = excluded.version,
			source_path = excluded.source_path,source_path_version = excluded.source_path_version,
			source_snapshot_id = excluded.source_snapshot_id,source_file_sha256 = excluded.source_file_sha256,
			updated_at = clock_timestamp();
		-- Measures and their live sources. Every measure names at least one
		-- current Company File path; the observed entry version and hash are
		-- recorded as provenance rather than trusted from the document.
		delete from public.qorpera_responsibility_measures where responsibility_id = v_id;
		for v_item in select value from jsonb_array_elements(v_document -> 'measures') loop
			if not (v_item ?& array['measureId','key','label','definition','direction','target','guardrails',
				'cadence','status','sources'])
				or v_item - array['measureId','key','label','definition','direction','target','guardrails',
					'cadence','status','sources'] <> '{}'::jsonb
				or jsonb_typeof(v_item -> 'guardrails') <> 'array'
				or jsonb_typeof(v_item -> 'sources') <> 'array'
				or jsonb_array_length(v_item -> 'sources') not between 1 and 16 then
				raise exception 'Responsibility measure is invalid' using errcode = '22023'; end if;
			insert into public.qorpera_responsibility_measures(id,profile_id,responsibility_id,measure_key,label,definition,
				direction,target,guardrails,cadence,status)
			values ((v_item ->> 'measureId')::uuid,v_profile_id,v_id,v_item ->> 'key',v_item ->> 'label',
				v_item ->> 'definition',v_item ->> 'direction',v_item -> 'target',v_item -> 'guardrails',
				v_item ->> 'cadence',v_item ->> 'status');
			for v_source in select value from jsonb_array_elements(v_item -> 'sources') loop
				if not (v_source ?& array['path','pathMatch']) or v_source - array['path','pathMatch'] <> '{}'::jsonb
					or v_source ->> 'pathMatch' not in ('exact','subtree')
					or not public.qorpera_company_path_valid(v_source ->> 'path')
					or starts_with(public.qorpera_company_path_key(v_source ->> 'path'),'members/') then
					raise exception 'Responsibility measure source is invalid' using errcode = '22023'; end if;
				select * into v_entry from public.qorpera_company_path_entries entry
				where entry.environment_id = v_environment_id and entry.path_key_sha256 =
					extensions.digest(public.qorpera_company_path_key(v_source ->> 'path'),'sha256');
				if not found or v_entry.entry is null
					or (v_source ->> 'pathMatch' = 'exact' and v_entry.entry ->> 'kind' <> 'file')
					or (v_source ->> 'pathMatch' = 'subtree' and v_entry.entry ->> 'kind' <> 'directory') then
					raise exception 'Responsibility measure source is unavailable' using errcode = '22023'; end if;
				insert into public.qorpera_responsibility_measure_sources(measure_id,profile_id,environment_id,
					source_path,path_match,source_path_version,source_snapshot_id,source_file_sha256)
				values ((v_item ->> 'measureId')::uuid,v_profile_id,v_environment_id,v_source ->> 'path',
					v_source ->> 'pathMatch',v_entry.version,p_snapshot_id,
					case when v_source ->> 'pathMatch' = 'exact' then v_entry.entry #>> '{file,fileSha256}' end);
			end loop;
		end loop;
		perform public.qorpera_project_scoped_path_resources(
			p_actor,'responsibility',v_id,v_document -> 'resources',p_path_version);
		delete from public.qorpera_responsibility_external_operation_grants where profile_id = v_profile_id
			and responsibility_id = v_id;
		for v_item in select value from jsonb_array_elements(v_document -> 'externalOperationGrants') loop
			if not (v_item ?& array['grantId','connectorKey','operationKey','status'])
				or v_item - array['grantId','connectorKey','operationKey','status'] <> '{}'::jsonb then
				raise exception 'Responsibility external operation grant is invalid' using errcode = '22023'; end if;
			insert into public.qorpera_responsibility_external_operation_grants(id,profile_id,responsibility_id,
				connector_key,operation_key,status,source_path_version)
			values ((v_item ->> 'grantId')::uuid,v_profile_id,v_id,v_item ->> 'connectorKey',
				v_item ->> 'operationKey',v_item ->> 'status',p_path_version);
		end loop;
		return;
	end if;

	if v_kind = 'room' then
		if not (v_document ?& array['schema','roomId','key','name','purpose','status','projectId','members','version'])
			or v_document - array['schema','roomId','key','name','purpose','status','projectId','members','version'] <> '{}'::jsonb
			or v_document ->> 'schema' <> 'qorpera.company-room/v1'
			or coalesce(v_document ->> 'roomId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or v_document ->> 'status' not in ('active','archived')
			or jsonb_typeof(v_document -> 'members') <> 'array' or jsonb_array_length(v_document -> 'members') > 256
			or jsonb_typeof(v_document -> 'version') <> 'number' or (v_document ->> 'version') !~ '^[1-9][0-9]*$'
			or coalesce(v_document ->> 'key','') !~ '^[a-z0-9][a-z0-9._-]{0,95}$'
			or char_length(btrim(coalesce(v_document ->> 'name',''))) not between 1 and 256
			or octet_length(convert_to(coalesce(v_document ->> 'purpose',''),'utf8')) not between 1 and 32768
			or (v_document -> 'projectId' <> 'null'::jsonb and coalesce(v_document ->> 'projectId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
			raise exception 'Room document is invalid' using errcode = '22023'; end if;
		v_id := (v_document ->> 'roomId')::uuid;
		if public.qorpera_company_path_key(p_plan ->> 'path') <> 'organization/rooms/' || v_id::text || '.json' then
			raise exception 'Room path does not match its identity' using errcode = '22023'; end if;
		select * into v_room from public.qorpera_company_rooms where id = v_id for update;
		if found and (v_room.profile_id <> v_profile_id or v_room.environment_id <> v_environment_id) then
			raise exception 'Room identity belongs to another company' using errcode = '42501'; end if;
		if (found and (v_document ->> 'version')::bigint <> v_room.version + 1)
			or (not found and (v_document ->> 'version')::bigint <> 1) then
			raise exception 'Room version is not monotonic' using errcode = '22023'; end if;
		if v_document -> 'projectId' <> 'null'::jsonb and not exists (select 1 from public.qorpera_company_projects project
			where project.id = (v_document ->> 'projectId')::uuid and project.profile_id = v_profile_id) then
			raise exception 'Room project is unavailable' using errcode = '22023'; end if;
		for v_item in select value from jsonb_array_elements(v_document -> 'members') loop
			if not (v_item ?& array['kind','id']) or v_item - array['kind','id'] <> '{}'::jsonb
				or v_item ->> 'kind' not in ('member','staff_agent') or coalesce(v_item ->> 'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
				raise exception 'Room member is invalid' using errcode = '22023'; end if;
			if v_item ->> 'kind' = 'member' and not exists (select 1 from public.qorpera_profile_members member
				where member.profile_id = v_profile_id and member.user_id = (v_item ->> 'id')::uuid) then
				raise exception 'Room member is unavailable' using errcode = '42501'; end if;
			if v_item ->> 'kind' = 'staff_agent' and not exists (select 1 from public.qorpera_profile_staff staff
				where staff.profile_id = v_profile_id and staff.staff_agent_id = (v_item ->> 'id')::uuid
					and staff.employment_status = 'active' and staff.deleted_at is null) then
				raise exception 'Room agent is unavailable' using errcode = '42501'; end if;
		end loop;
		insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,purpose,status,project_id,version,
			source_path,source_path_version,source_snapshot_id,source_file_sha256,created_by_user_id)
		values (v_id,v_profile_id,v_environment_id,v_document ->> 'key',btrim(v_document ->> 'name'),v_document ->> 'purpose',
			v_document ->> 'status',nullif(v_document ->> 'projectId','')::uuid,(v_document ->> 'version')::bigint,
			p_plan ->> 'path',p_path_version,p_snapshot_id,p_plan #>> '{entry,file,fileSha256}',v_user_id)
		on conflict (id) do update set room_key = excluded.room_key,name = excluded.name,purpose = excluded.purpose,
			status = excluded.status,project_id = excluded.project_id,version = excluded.version,
			source_path = excluded.source_path,source_path_version = excluded.source_path_version,
			source_snapshot_id = excluded.source_snapshot_id,source_file_sha256 = excluded.source_file_sha256,
			updated_at = clock_timestamp()
		returning * into v_room;
		update public.qorpera_company_room_members set status = 'removed',removed_at = clock_timestamp(),
			source_path_version = p_path_version
		where room_id = v_id and status = 'active' and not exists (select 1 from jsonb_array_elements(v_document -> 'members') value
			where value ->> 'kind' = principal_kind and (value ->> 'id')::uuid = principal_id);
		insert into public.qorpera_company_room_members(room_id,principal_kind,principal_id,status,source_path_version)
		select v_id,value ->> 'kind',(value ->> 'id')::uuid,'active',p_path_version
		from jsonb_array_elements(v_document -> 'members') value
		on conflict (room_id,principal_kind,principal_id) do update set status = 'active',removed_at = null,
			source_path_version = excluded.source_path_version;
		if v_room.status = 'active' and v_room.session_id is null then
			insert into public.qorpera_shared_sessions(profile_id,environment_id,title,staff_agent_id,created_by_user_id,
				audience_kind,audience_user_id,execution_scope,company_snapshot_id)
			values (v_profile_id,v_environment_id,v_room.name,null,v_user_id,'company',null,
				jsonb_build_object('roomId',v_id),p_snapshot_id) returning id into v_room_session;
			update public.qorpera_company_rooms set session_id = v_room_session where id = v_id;
		elsif v_room.session_id is not null then
			update public.qorpera_shared_sessions set status = case when v_room.status = 'active' then 'open' else 'closed' end::public.qorpera_session_status,
				title = v_room.name,updated_at = statement_timestamp() where id = v_room.session_id;
		end if;
		return;
	end if;

	if not (v_document ?& array['schema','projectId','key','name','objective','definitionOfDone','scopeKind',
		'sponsoringResponsibilityId','leadStaffAgentId','roomId','status','sourceResources','outputResources',
		'dependencies','reasoningPolicy','workerPolicy','executionPolicy','outcome','version','staff'])
		or v_document - array['schema','projectId','key','name','objective','definitionOfDone','scopeKind',
			'sponsoringResponsibilityId','leadStaffAgentId','roomId','status','sourceResources','outputResources',
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
		scope_kind,sponsoring_responsibility_id,lead_staff_agent_id,room_id,status,authorized_source_paths,
		authorized_output_paths,dependencies,reasoning_policy,worker_policy,execution_policy,outcome,version,
		source_path,source_path_version,source_snapshot_id,
		source_file_sha256,created_by_user_id)
	values (v_id,v_profile_id,v_environment_id,v_document ->> 'key',v_document ->> 'name',v_document ->> 'objective',
		v_document ->> 'definitionOfDone',v_document ->> 'scopeKind',nullif(v_document ->> 'sponsoringResponsibilityId','')::uuid,
		(v_document ->> 'leadStaffAgentId')::uuid,nullif(v_document ->> 'roomId','')::uuid,v_document ->> 'status',
		array(select value ->> 'path' from jsonb_array_elements(v_document -> 'sourceResources') value),
		array(select value ->> 'path' from jsonb_array_elements(v_document -> 'outputResources') value),
		v_document -> 'dependencies',v_document -> 'reasoningPolicy',v_document -> 'workerPolicy',
		v_document -> 'executionPolicy',nullif(v_document -> 'outcome','null'::jsonb),(v_document ->> 'version')::bigint,
		p_plan ->> 'path',p_path_version,p_snapshot_id,p_plan #>> '{entry,file,fileSha256}',v_user_id)
	on conflict (id) do update set project_key = excluded.project_key,name = excluded.name,objective = excluded.objective,
		definition_of_done = excluded.definition_of_done,scope_kind = excluded.scope_kind,
		sponsoring_responsibility_id = excluded.sponsoring_responsibility_id,lead_staff_agent_id = excluded.lead_staff_agent_id,
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

-- A member posts into a room: one durable input in the room conversation and
-- one room wake per active agent member, sponsored by the posting member's
-- own binding. Replays return the same durable result.
create function public.qorpera_post_company_room_message(
	p_room_id uuid, p_client_input_id uuid, p_body jsonb, p_sponsor_binding_id uuid, p_sponsor_version bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_room public.qorpera_company_rooms%rowtype; v_user uuid := auth.uid();
	v_input public.qorpera_session_inputs%rowtype; v_staff uuid; v_ids uuid[] := '{}'::uuid[]; v_id uuid; v_text text;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Room posting requires a member' using errcode = '42501'; end if;
	select * into v_room from public.qorpera_company_rooms where id = p_room_id for share;
	if not found or v_room.status <> 'active' or v_room.session_id is null
		or not exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = v_room.profile_id and member.user_id = v_user)
		or not exists (select 1 from public.qorpera_company_room_members member
			where member.room_id = v_room.id and member.principal_kind = 'member' and member.principal_id = v_user
				and member.status = 'active') then
		raise exception 'Room is unavailable' using errcode = '42501'; end if;
	if p_client_input_id is null or jsonb_typeof(p_body) is distinct from 'object'
		or p_body ->> 'schema' is distinct from 'qorpera.session-prompt/v1'
		or p_body - array['schema','text','images'] <> '{}'::jsonb
		or jsonb_typeof(p_body -> 'text') <> 'string'
		or (p_body ? 'images' and (jsonb_typeof(p_body -> 'images') <> 'array' or jsonb_array_length(p_body -> 'images') > 0)) then
		raise exception 'Room message is invalid' using errcode = '22023'; end if;
	v_text := p_body ->> 'text';
	if v_text !~ '[^[:space:]]' or octet_length(convert_to(v_text,'utf8')) > 65536 then
		raise exception 'Room message is invalid' using errcode = '22023'; end if;
	if p_sponsor_binding_id is null or p_sponsor_version is null or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings binding
			join public.qorpera_execution_sponsor_versions version on version.binding_id = binding.id and version.version = p_sponsor_version
			where binding.id = p_sponsor_binding_id and binding.profile_id = v_room.profile_id and binding.status = 'active'
				and binding.created_by_user_id = v_user) then
		raise exception 'Room sponsor is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_shared_sessions where id = v_room.session_id and status = 'open' for update;
	if not found then raise exception 'Room conversation is unavailable' using errcode = '42501'; end if;
	select * into v_input from public.qorpera_session_inputs
	where session_id = v_room.session_id and client_input_id = p_client_input_id;
	if found then
		if v_input.author_user_id <> v_user or v_input.body <> p_body then
			raise exception 'Room input id is bound to different content' using errcode = '23505'; end if;
		select coalesce(array_agg(id order by staff_agent_id),'{}'::uuid[]) into v_ids from public.qorpera_wake_occurrences
		where wake_kind = 'room' and source_kind = 'room' and source_id = v_input.id;
	else
		insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body,completed_at)
		values (v_room.session_id,p_client_input_id,'user_message',v_user,p_body,clock_timestamp()) returning * into v_input;
		for v_staff in
			select member.principal_id from public.qorpera_company_room_members member
			join public.qorpera_profile_staff staff on staff.profile_id = v_room.profile_id
				and staff.staff_agent_id = member.principal_id and staff.employment_status = 'active'
			where member.room_id = v_room.id and member.principal_kind = 'staff_agent' and member.status = 'active'
			order by member.principal_id
		loop
			v_id := extensions.gen_random_uuid();
			insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,
				staff_agent_id,requested_by_user_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,
				scheduled_for,not_before,payload)
			values (v_id,v_room.profile_id,v_room.environment_id,'room','room',v_input.id,v_staff,v_user,
				p_sponsor_binding_id,p_sponsor_version,v_room.session_id,'room',
				'room:' || v_room.id::text || ':' || v_input.id::text || ':' || v_staff::text,
				clock_timestamp(),clock_timestamp(),
				jsonb_build_object('roomId',v_room.id,'inputIds',jsonb_build_array(v_input.id),'recipientStaffId',v_staff));
			v_ids := array_append(v_ids,v_id);
		end loop;
	end if;
	return jsonb_build_object('schema','qorpera.company-room-post/v1','roomId',v_room.id,'sessionId',v_room.session_id,
		'inputId',v_input.id,'occurrenceIds',to_jsonb(v_ids));
end
$$;
revoke all on function public.qorpera_post_company_room_message(uuid, uuid, jsonb, uuid, bigint) from public, anon;
grant execute on function public.qorpera_post_company_room_message(uuid, uuid, jsonb, uuid, bigint) to authenticated;

create function public.qorpera_list_company_rooms(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Company rooms access denied' using errcode = '42501'; end if;
	return coalesce((select jsonb_agg(jsonb_build_object('roomId',room.id,'key',room.room_key,'name',room.name,
			'purpose',room.purpose,'status',room.status,'projectId',room.project_id,'sessionId',room.session_id,
			'version',room.version,'environmentId',room.environment_id,'members',(
				select coalesce(jsonb_agg(jsonb_build_object('kind',member.principal_kind,'id',member.principal_id)
					order by member.principal_kind,member.principal_id),'[]'::jsonb)
				from public.qorpera_company_room_members member where member.room_id = room.id and member.status = 'active'))
			order by room.status,room.name,room.id)
		from public.qorpera_company_rooms room where room.profile_id = p_profile_id),'[]'::jsonb);
end
$$;
revoke all on function public.qorpera_list_company_rooms(uuid) from public, anon;
grant execute on function public.qorpera_list_company_rooms(uuid) to authenticated;

-- Room wakes are admitted with their room, input, member and sponsor identity (was 20260828021000_runtime_wake_enforcement.sql).
create or replace function public.qorpera_pin_wake_occurrence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_version public.qorpera_cloud_routine_versions%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_trigger jsonb; v_ancestry jsonb; v_actor uuid; v_room public.qorpera_company_rooms%rowtype;
begin
	if new.wake_schema <> 'qorpera.wake-envelope/v1' then
		raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
	if new.wake_kind = 'routine' then
		select * into strict v_version from public.qorpera_cloud_routine_versions
		where routine_id = new.routine_id and version = new.routine_version
			and profile_id = new.profile_id and environment_id = new.environment_id;
		select value into v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = new.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger)
			or (new.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')
			or (new.source_kind = 'company-file' and (v_trigger ->> 'kind' <> 'listener' or new.file_event_id is null))
			or new.source_kind not in ('schedule','company-file') then
			raise exception 'Wake source does not match its routine' using errcode = '22023'; end if;
		new.staff_agent_id := v_version.staff_agent_id; new.requested_by_user_id := v_version.created_by_user_id;
		new.sponsor_binding_id := v_version.sponsor_binding_id; new.sponsor_version := v_version.sponsor_version;
		new.logical_computer_id := v_version.logical_computer_id;
		new.time_zone := coalesce(v_trigger ->> 'timeZone','UTC');
		new.source_id := coalesce(new.file_event_id,new.routine_id);
		if new.source_kind = 'company-file' then
			select run_id,actor_staff_id into new.parent_run_id,v_actor from public.qorpera_company_path_revisions
			where snapshot_id = new.file_event_id and environment_id = new.environment_id;
			if not found then raise exception 'Wake event is unavailable' using errcode = '42501'; end if;
		else
			if new.parent_run_id is not null or new.file_event_id is not null then
				raise exception 'Scheduled wake cannot replace causal identity' using errcode = '42501'; end if;
		end if;
	elsif new.wake_kind in ('human','first-run') then
		select * into strict v_run from public.qorpera_execution_runs where id = new.run_id and source_kind = 'session_turn';
		if new.source_kind <> 'input' or new.profile_id <> v_run.profile_id or new.environment_id <> v_run.environment_id
			or not exists(select 1 from public.qorpera_session_inputs where id = new.source_id and id = any(v_run.input_ids)
				and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id
				and kind = case when new.wake_kind = 'first-run' then 'kickoff' else 'user_message' end) then
			raise exception 'Wake input identity is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := v_run.staff_agent_id; new.requested_by_user_id := v_run.requested_by_user_id;
		new.sponsor_binding_id := v_run.sponsor_binding_id; new.sponsor_version := v_run.sponsor_version;
		new.logical_computer_id := v_run.logical_computer_id;
		new.session_id := v_run.session_id;
		if new.parent_run_id is not null or new.file_event_id is not null then
			raise exception 'Input wake cannot replace causal identity' using errcode = '42501'; end if;
	elsif new.wake_kind = 'agent' then
		select * into strict v_run from public.qorpera_execution_runs where id = new.parent_run_id
			and profile_id = new.profile_id and environment_id = new.environment_id;
		if new.source_kind <> 'coworker' then raise exception 'Coworker source is invalid' using errcode = '22023'; end if;
		v_actor := v_run.staff_agent_id; new.source_id := new.id; new.requested_by_user_id := v_run.requested_by_user_id;
		select * into strict v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id for share;
		new.sponsor_binding_id := v_authority.sponsor_binding_id; new.sponsor_version := v_authority.sponsor_version;
		new.logical_computer_id := v_authority.logical_computer_id; new.session_id := null;
		if new.file_event_id is not null then raise exception 'Coworker event identity is invalid' using errcode = '42501'; end if;
	elsif new.wake_kind = 'room' then
		if new.source_kind <> 'room' or new.parent_run_id is not null or new.file_event_id is not null or new.run_id is not null
			or new.session_id is null or new.source_id is null or new.staff_agent_id is null or new.requested_by_user_id is null
			or new.sponsor_binding_id is null or new.sponsor_version is null then
			raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
		select * into v_room from public.qorpera_company_rooms where session_id = new.session_id
			and profile_id = new.profile_id and environment_id = new.environment_id and status = 'active';
		if not found
			or not exists (select 1 from public.qorpera_session_inputs input where input.id = new.source_id
				and input.session_id = new.session_id and input.author_user_id = new.requested_by_user_id and input.kind = 'user_message')
			or not exists (select 1 from public.qorpera_company_room_members member where member.room_id = v_room.id
				and member.principal_kind = 'member' and member.principal_id = new.requested_by_user_id and member.status = 'active')
			or not exists (select 1 from public.qorpera_company_room_members member where member.room_id = v_room.id
				and member.principal_kind = 'staff_agent' and member.principal_id = new.staff_agent_id and member.status = 'active')
			or not exists (select 1 from public.qorpera_execution_sponsor_bindings binding
				join public.qorpera_execution_sponsor_versions version on version.binding_id = binding.id
					and version.version = new.sponsor_version
				where binding.id = new.sponsor_binding_id and binding.profile_id = new.profile_id and binding.status = 'active') then
			raise exception 'Room wake authority is unavailable' using errcode = '42501'; end if;
		v_actor := null; new.logical_computer_id := null;
	else raise exception 'Wake admission is unsupported' using errcode = '42501';
	end if;
	if new.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
		where id = new.parent_run_id and profile_id = new.profile_id and environment_id = new.environment_id) then
		raise exception 'Wake parent belongs to another company' using errcode = '42501'; end if;
	select * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id
		and staff_agent_id = new.staff_agent_id and employment_status = 'active' for share;
	if not found or not exists(select 1 from public.qorpera_profile_members
		where profile_id = new.profile_id and user_id = new.requested_by_user_id) then
		raise exception 'Wake recipient authority is unavailable' using errcode = '42501'; end if;
	new.staff_version := coalesce(v_run.staff_version,v_staff.version);
	if new.wake_kind = 'agent' then new.staff_version := v_staff.version; end if;
	if new.wake_kind = 'routine' then
		new.session_id := public.qorpera_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id,new.requested_by_user_id);
		if coalesce(v_trigger ->> 'replyPolicy','required') = 'required' and new.session_id is null then
			raise exception 'Wake public audience is unavailable' using errcode = '42501';
		end if;
	end if;
	v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id));
	if v_ancestry is null then raise exception 'Wake causal ancestry is fenced' using errcode = '55000'; end if;
	new.causal_root_id := (v_ancestry ->> 'rootId')::uuid;
	new.causal_agent_ids := array(select jsonb_array_elements_text(v_ancestry -> 'agentIds')::uuid);
	return new;
end
$$;

-- Delivery-time authorization rechecks room membership and the post (was 20260828020500_runtime_wake_policy_admission.sql).
create or replace function public.qorpera_wake_authorized(p_wake public.qorpera_wake_occurrences)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ancestry jsonb; v_actor uuid; v_revision public.qorpera_company_path_revisions%rowtype; v_path text;
begin
	if p_wake.wake_schema <> 'qorpera.wake-envelope/v1'
		or (p_wake.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
			where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id))
		or not exists(select 1 from public.qorpera_profile_members where profile_id = p_wake.profile_id
			and user_id = p_wake.requested_by_user_id)
		or not exists(select 1 from public.qorpera_profile_staff where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and version = p_wake.staff_version and employment_status = 'active')
		or (p_wake.session_id is not null and not exists(select 1 from public.qorpera_shared_sessions
			where id = p_wake.session_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id
				and (staff_agent_id = p_wake.staff_agent_id::text or (p_wake.wake_kind = 'room' and staff_agent_id is null
					and execution_scope ->> 'roomId' is not null)) and status = 'open'
				and (p_wake.wake_kind <> 'routine' or (staff_version = p_wake.staff_version and not
					(execution_scope ?| array['autonomousLabel','roomId','group','parentSession']))))) then return false; end if;
	-- An older occurrence may have been pinned without a public audience.
	-- Do not attach a later session or reserve compute for an unsatisfiable
	-- final obligation. Only explicit optional/silent reporting allows none.
	if p_wake.wake_kind = 'routine' and p_wake.session_id is null and not exists(
		select 1 from public.qorpera_cloud_routine_versions v,
			lateral jsonb_array_elements(v.triggers) t(value)
		where v.routine_id = p_wake.routine_id and v.version = p_wake.routine_version
			and t.value ->> 'id' = p_wake.trigger_id
			and public.qorpera_cloud_routine_trigger_valid(t.value)
			and t.value ->> 'replyPolicy' in ('optional','silent')
	) then return false; end if;
	if p_wake.wake_kind = 'routine' and not exists(
		select 1 from public.qorpera_cloud_routines r join public.qorpera_cloud_routine_versions v
			on v.routine_id = r.id and v.version = r.current_version
		where r.id = p_wake.routine_id and r.status = 'active' and v.version = p_wake.routine_version
			and v.created_by_user_id = p_wake.requested_by_user_id and v.staff_agent_id = p_wake.staff_agent_id
			and v.sponsor_binding_id = p_wake.sponsor_binding_id and v.sponsor_version = p_wake.sponsor_version
	) then return false; end if;
	if p_wake.wake_kind = 'room' then
		if p_wake.source_kind <> 'room' or p_wake.session_id is null or not exists (
			select 1 from public.qorpera_company_rooms room
			join public.qorpera_company_room_members agent on agent.room_id = room.id and agent.principal_kind = 'staff_agent'
				and agent.principal_id = p_wake.staff_agent_id and agent.status = 'active'
			join public.qorpera_company_room_members poster on poster.room_id = room.id and poster.principal_kind = 'member'
				and poster.principal_id = p_wake.requested_by_user_id and poster.status = 'active'
			join public.qorpera_session_inputs input on input.id = p_wake.source_id and input.session_id = room.session_id
			where room.session_id = p_wake.session_id and room.profile_id = p_wake.profile_id and room.status = 'active') then
			return false; end if;
	end if;
	if p_wake.source_kind = 'company-file' then
		select * into v_revision from public.qorpera_company_path_revisions
		where snapshot_id = p_wake.file_event_id and environment_id = p_wake.environment_id;
		if not found or v_revision.run_id is distinct from p_wake.parent_run_id
			or not coalesce(public.qorpera_wake_path_authorized(p_wake.environment_id,p_wake.requested_by_user_id,
				p_wake.staff_agent_id,v_revision.change #>> '{plan,path}'),false) then return false; end if;
		v_actor := v_revision.actor_staff_id;
	elsif p_wake.wake_kind = 'agent' then
		if not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and sponsor_binding_id = p_wake.sponsor_binding_id
			and sponsor_version = p_wake.sponsor_version
			and logical_computer_id is not distinct from p_wake.logical_computer_id) then return false; end if;
		select staff_agent_id into v_actor from public.qorpera_execution_runs
		where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id;
		if not found then return false; end if;
		-- Coworker content cannot wash an already-read path's authority away.
		-- Use the existing durable read set, not another taint or memory store.
		for v_path in select path from public.qorpera_company_run_read_paths where run_id = p_wake.parent_run_id loop
			if not coalesce(public.qorpera_wake_path_authorized(p_wake.environment_id,p_wake.requested_by_user_id,
				p_wake.staff_agent_id,v_path),false) then return false; end if;
		end loop;
	end if;
	v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,v_actor,p_wake.staff_agent_id,
		coalesce(p_wake.file_event_id,p_wake.id));
	return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
		and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids),false);
end
$$;

-- Room wakes materialize as room deliveries in the room conversation (was 20260828020000_runtime_wake_bus.sql).
create or replace function public.qorpera_materialize_wake_execution_runs(p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_wake public.qorpera_wake_occurrences%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_file public.qorpera_company_files%rowtype; v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_id uuid; v_payload jsonb; v_digest text; v_capability text; v_job_type text;
	v_publication text; v_review text; v_reviewers uuid[]; v_sequence bigint; v_runs jsonb := '[]';
	v_compute uuid; v_mode text; v_worker_class text; v_now timestamptz;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Wake materialization authority or bound is invalid' using errcode = '42501'; end if;
	perform public.qorpera_drain_company_file_wakes(p_limit);
	v_now := clock_timestamp();
	for v_wake in select * from public.qorpera_wake_occurrences
		where status = 'queued' and not_before <= v_now
		order by not_before,created_at,id for update skip locked limit p_limit
	loop
		perform public.qorpera_lock_profile_gc_fence(v_wake.profile_id);
		select * into v_file from public.qorpera_company_files
		where environment_id = v_wake.environment_id and profile_id = v_wake.profile_id for update;
		perform 1 from public.qorpera_profile_members
		where profile_id = v_wake.profile_id and user_id = v_wake.requested_by_user_id for share;
		perform 1 from public.qorpera_profile_staff
		where profile_id = v_wake.profile_id and staff_agent_id = v_wake.staff_agent_id for share;
		if v_wake.wake_kind not in ('routine','agent','room') or not public.qorpera_wake_authorized(v_wake) then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake recipient or source authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		v_capability := 'agent_turn'; v_job_type := 'agent_turn';
		v_publication := 'automatic'; v_review := null; v_reviewers := '{}';
		if v_wake.wake_kind = 'routine' then
			select * into strict v_version from public.qorpera_cloud_routine_versions
			where routine_id = v_wake.routine_id and version = v_wake.routine_version;
			v_capability := v_version.required_capability; v_job_type := v_version.job_type;
			v_publication := v_version.publication_mode; v_review := v_version.review_policy_key;
			v_reviewers := v_version.reviewer_staff_ids;
		end if;
		perform 1 from public.qorpera_execution_sponsor_bindings b
		join public.qorpera_execution_sponsor_versions s on s.binding_id = b.id and s.version = v_wake.sponsor_version
		join public.qorpera_provider_connections c on c.id = s.provider_connection_id
		where b.id = v_wake.sponsor_binding_id and b.profile_id = v_wake.profile_id and b.status = 'active'
			and (s.allow_autonomous or v_wake.wake_kind = 'room') and c.profile_id = v_wake.profile_id and c.status = 'active' for share of b,c;
		if not found then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake execution authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		select * into v_substrate from public.qorpera_company_substrate_versions
		where profile_id = v_wake.profile_id and environment_id = v_wake.environment_id
			and company_snapshot_id = v_file.head_snapshot_id order by created_at desc,id desc limit 1;
		if v_file.head_snapshot_id is null or v_substrate.id is null or (v_wake.logical_computer_id is not null
			and not exists(select 1 from public.qorpera_logical_computers where id = v_wake.logical_computer_id
				and profile_id = v_wake.profile_id and status = 'active' and capabilities ? v_capability)) then
			update public.qorpera_wake_occurrences set blocked_reason = 'Pinned Company File or computer is unavailable'
			where id = v_wake.id;
			continue;
		end if;
		-- Resolve compute from the already authorized immutable sponsor/capsule,
		-- then let the existing native provenance trigger verify ownership.
		select c.compute_identity_id,v.authentication_mode into v_compute,v_mode
		from public.qorpera_execution_sponsor_versions s join public.qorpera_provider_connection_versions v
			on v.connection_id = s.provider_connection_id and v.version = s.provider_connection_version
		left join public.qorpera_native_credential_capsules c on c.id = v.credential_capsule_id and c.status = 'active'
		where s.binding_id = v_wake.sponsor_binding_id and s.version = v_wake.sponsor_version;
		v_worker_class := 'managed_sandbox';
		if v_wake.logical_computer_id is not null then
			select computer_class into v_worker_class from public.qorpera_logical_computers where id = v_wake.logical_computer_id
				and (v_compute is null or compute_identity_id = v_compute);
			if v_compute is null then
				select compute_identity_id into v_compute from public.qorpera_logical_computers where id = v_wake.logical_computer_id;
			end if;
		end if;
		if (v_mode = 'native_subscription' and v_compute is null) or v_worker_class is null then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake compute authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		v_id := extensions.gen_random_uuid();
		v_payload := jsonb_build_object('schema','qorpera.wake-run/v1','occurrenceId',v_wake.id);
		v_digest := encode(extensions.digest(convert_to(v_payload::text,'utf8'),'sha256'),'hex');
		-- A room post enters the room conversation once, before any agent's run.
		if v_wake.wake_kind = 'room' then
			perform public.qorpera_append_execution_input_events(v_wake.session_id,array[v_wake.source_id]);
		end if;
		select coalesce(max(sequence),0) into v_sequence from public.qorpera_session_events where session_id = v_wake.session_id;
		insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
			required_capability,job_type,payload,created_by_user_id)
		values(v_wake.profile_id,v_wake.environment_id,v_wake.session_id,v_substrate.id,v_id,
			v_capability,v_job_type,v_payload,v_wake.requested_by_user_id) returning * into v_job;
		insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
			substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
			required_capability,job_type,payload_sha256,publication_mode,review_policy_key,reviewer_staff_ids,logical_computer_id,
			compute_identity_id,worker_class,transcript_start_sequence,created_by_user_id)
		values(v_id,v_wake.profile_id,v_wake.environment_id,case when v_wake.wake_kind = 'room' then 'room_delivery' else 'wake' end,
			v_wake.id,v_wake.session_id,v_job.id,
			v_substrate.id,v_file.head_snapshot_id,v_wake.staff_agent_id,v_wake.staff_version,'{}',
			v_wake.sponsor_binding_id,v_wake.sponsor_version,v_capability,v_job_type,v_digest,
			v_publication,v_review,v_reviewers,v_wake.logical_computer_id,v_compute,v_worker_class,v_sequence,v_wake.requested_by_user_id)
		returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_wake_occurrences set blocked_reason = 'Execution sponsor authority or quota is unavailable'
			where id = v_wake.id;
			continue;
		end if;
		update public.qorpera_wake_occurrences set status = 'materialized',run_id = v_run.id,blocked_reason = null where id = v_wake.id;
		insert into public.qorpera_execution_run_events(run_id,event_type) values(v_run.id,'queued');
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$$;

-- Room deliveries carry the room policy (was 20260828020500_runtime_wake_policy_admission.sql).
create or replace function public.qorpera_runtime_wake_policy(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_trigger jsonb; v_reporting text := 'optional'; v_count integer; v_human integer; v_kickoff integer; v_kind text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Wake policy authority is required' using errcode = '42501'; end if;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run_id;
	if v_run.id is null or v_wake.id is null or v_wake.wake_schema <> 'qorpera.wake-envelope/v1'
		or v_wake.source_id is null or v_wake.causal_root_id is null
		or cardinality(v_wake.causal_agent_ids) not between 1 and 16
		or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_wake.staff_agent_id
		or v_wake.staff_agent_id is distinct from v_run.staff_agent_id
		or v_wake.staff_version is distinct from v_run.staff_version
		or v_wake.requested_by_user_id is distinct from v_run.requested_by_user_id
		or v_wake.profile_id is distinct from v_run.profile_id
		or v_wake.environment_id is distinct from v_run.environment_id
		or v_wake.sponsor_binding_id is distinct from v_run.sponsor_binding_id
		or v_wake.sponsor_version is distinct from v_run.sponsor_version
		or v_wake.logical_computer_id is distinct from v_run.logical_computer_id
		or v_wake.session_id is distinct from v_run.session_id
		or (v_run.source_kind = 'wake' and (v_run.source_id is distinct from v_wake.id
			or cardinality(v_run.input_ids) <> 0
			or (v_wake.source_kind = 'schedule' and v_wake.source_id is distinct from v_wake.routine_id)
			or (v_wake.source_kind = 'company-file' and v_wake.source_id is distinct from v_wake.file_event_id)
			or (v_wake.source_kind = 'coworker' and v_wake.source_id is distinct from v_wake.id)
			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file'))
				or (v_wake.wake_kind = 'agent' and v_wake.source_kind = 'coworker'))))
		or (v_run.source_kind = 'session_turn' and (v_wake.source_kind <> 'input'
			or v_run.job_type <> 'agent_turn'
			or v_wake.wake_kind not in ('human','first-run') or not coalesce(v_wake.source_id = any(v_run.input_ids),false)
			or v_wake.payload -> 'inputIds' is distinct from to_jsonb(v_run.input_ids)))
		or (v_run.source_kind = 'room_delivery' and (v_wake.wake_kind <> 'room' or v_wake.source_kind <> 'room'
			or v_run.source_id is distinct from v_wake.id or cardinality(v_run.input_ids) <> 0 or v_run.job_type <> 'agent_turn'))
		or v_run.source_kind not in ('session_turn','wake','room_delivery') then
		return public.qorpera_wake_policy_value(null); end if;
	if v_run.source_kind = 'session_turn' then
		select count(*),count(*) filter(where kind = 'user_message'),count(*) filter(where kind = 'kickoff')
		into v_count,v_human,v_kickoff from public.qorpera_session_inputs
		where id = any(v_run.input_ids) and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id
			and execution_run_id = v_run.id;
		v_kind := case when v_count = cardinality(v_run.input_ids) and v_count = v_human + v_kickoff
			then case when v_human > 0 then 'human' when v_kickoff = 1 then 'first-run' end end;
		if v_kind is null or v_kind <> v_wake.wake_kind
			or not public.qorpera_uuid_array_is_unique(v_run.input_ids) then return public.qorpera_wake_policy_value(null); end if;
	end if;
	if v_wake.wake_kind = 'routine' then
		select t.value into v_trigger from public.qorpera_cloud_routine_versions v,
			lateral jsonb_array_elements(v.triggers) t(value)
		where v.routine_id = v_wake.routine_id and v.version = v_wake.routine_version
			and v.profile_id = v_run.profile_id and v.environment_id = v_run.environment_id
			and v.created_by_user_id = v_run.requested_by_user_id and v.staff_agent_id = v_run.staff_agent_id
			and v.sponsor_binding_id = v_run.sponsor_binding_id and v.sponsor_version = v_run.sponsor_version
			and v.required_capability = v_run.required_capability and v.job_type = v_run.job_type
			and t.value ->> 'id' = v_wake.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger) then
			return public.qorpera_wake_policy_value(null); end if;
		if (v_wake.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')
			or (v_wake.source_kind = 'company-file' and v_trigger ->> 'kind' <> 'listener') then
			return public.qorpera_wake_policy_value(null); end if;
		v_reporting := coalesce(v_trigger ->> 'replyPolicy','required');
	end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);
end
$$;

-- A group conversation admits every active agent member of its room (was 20260828019400_runtime_step0_audience_context.sql).
create or replace function public.qorpera_company_path_actor(p_environment_id uuid,p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_user uuid; v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	if p_binding is not null then
		v_run := public.qorpera_native_tool_locked_run(p_binding);
		if v_run.environment_id <> p_environment_id or v_run.source_kind = 'proposal_review' then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		if v_run.session_id is not null then
			perform 1 from public.qorpera_shared_sessions session where session.id = v_run.session_id
				and session.profile_id = v_run.profile_id and session.environment_id = v_run.environment_id
				and (session.staff_agent_id = v_run.staff_agent_id::text
					or (session.staff_agent_id is null and public.qorpera_company_room_session_staff(session.id,v_run.staff_agent_id)))
				and session.status = 'open'
				and session.audience_kind = v_run.audience_kind
				and session.audience_user_id is not distinct from v_run.audience_user_id for share;
			if not found then raise exception 'Company File audience is unavailable' using errcode = '42501'; end if;
		end if;
		if exists (select 1 from unnest(v_run.input_ids) requested(id)
			left join public.qorpera_session_inputs input on input.id = requested.id
			where input.id is null or input.session_id is distinct from v_run.session_id
				or input.execution_run_id is distinct from v_run.id
				or input.author_user_id is distinct from v_run.requested_by_user_id
				or input.runtime_bundle_id <> v_run.runtime_bundle_id
				or input.runtime_bundle_sha256 <> v_run.runtime_bundle_sha256) then
			raise exception 'Company File requesting input changed' using errcode = '42501'; end if;
		v_user := v_run.requested_by_user_id;
	else
		v_user := auth.uid();
		if auth.role() is distinct from 'authenticated' or v_user is null then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	if v_file.path_gateway_version is distinct from 1 or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = v_user for share;
	if not found then raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	if p_binding is not null then
		perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id
			and staff_agent_id = v_run.staff_agent_id and version = v_run.staff_version
			and employment_status = 'active' for share;
		if not found then raise exception 'Company File staff version changed' using errcode = '42501'; end if;
		perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id
			and user_id = v_run.sponsored_by_user_id for share;
		perform 1 from public.qorpera_execution_sponsor_bindings where id = v_run.sponsor_binding_id for share;
		perform 1 from public.qorpera_provider_connections connection
		join public.qorpera_execution_sponsor_versions sponsor on sponsor.provider_connection_id = connection.id
		where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version for share of connection;
		perform 1 from public.qorpera_runner_assignments where id = (p_binding ->> 'assignmentId')::uuid for share;
		perform 1 from public.qorpera_runners where id = (p_binding ->> 'runnerId')::uuid for share;
		perform 1 from public.qorpera_member_compute_identities where id = v_run.compute_identity_id for share;
		perform 1 from public.qorpera_native_credential_capsules where id = (p_binding ->> 'credentialCapsuleId')::uuid for share;
		perform public.qorpera_native_tool_locked_run(p_binding);
	end if;
	if public.qorpera_profile_gc_deletion_active(v_file.profile_id) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	return jsonb_build_object('companyId',v_file.profile_id,'environmentId',p_environment_id,'userId',v_user,
		'staffAgentId',v_run.staff_agent_id,'runId',v_run.id,'jobId',v_run.job_id,
		'assignmentId',p_binding ->> 'assignmentId','sponsorBindingId',v_run.sponsor_binding_id,
		'sponsorVersion',v_run.sponsor_version,
		'audience',case when p_binding is null then 'human' else v_run.audience_kind end,
		'audienceUserId',case when p_binding is null then v_user else v_run.audience_user_id end,
		'runtimeBundleId',coalesce(v_run.runtime_bundle_id,v_bundle.runtime_bundle_id),
		'runtimeBundleSha256',coalesce(v_run.runtime_bundle_sha256,v_bundle.runtime_bundle_sha256));
end
$$;

-- Context composition accepts the room conversation (was 20260828019400_runtime_step0_audience_context.sql).
create or replace function public.qorpera_describe_company_run_context(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_authority jsonb; v_actor jsonb;
	v_staff public.qorpera_profile_staff%rowtype; v_company_name text; v_input_id uuid; v_event record;
	v_source jsonb; v_inputs jsonb := '[]'; v_history jsonb := '[]'; v_coworkers jsonb; v_job jsonb; v_spec jsonb;
	v_history_count bigint; v_coworker_count bigint; v_result jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	if v_run.session_id is not null then
		perform 1 from public.qorpera_shared_sessions session where session.id = v_run.session_id
			and session.profile_id = v_run.profile_id and session.environment_id = v_run.environment_id
			and (session.staff_agent_id = v_run.staff_agent_id::text
				or (session.staff_agent_id is null and public.qorpera_company_room_session_staff(session.id,v_run.staff_agent_id)))
			and session.status = 'open'
			and session.audience_kind = v_run.audience_kind
			and session.audience_user_id is not distinct from v_run.audience_user_id for share;
		if not found then raise exception 'Cloud context audience is unavailable' using errcode = '42501'; end if;
	end if;
	select * into strict v_staff from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and staff_agent_id = v_run.staff_agent_id;
	select name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;
	foreach v_input_id in array v_run.input_ids loop
		v_source := public.qorpera_company_context_source(v_run,'input',v_input_id);
		v_inputs := v_inputs || jsonb_build_array((v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024)));
	end loop;
	for v_event in select event_id,sequence from public.qorpera_session_events where session_id = v_run.session_id
		and sequence <= v_run.transcript_start_sequence and event_type = 'message'
		and not (event_id = any(v_run.input_ids)) order by sequence desc limit 32 loop
		v_source := public.qorpera_company_context_source(v_run,'history',v_event.event_id);
		v_history := jsonb_build_array((v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,512))) || v_history;
	end loop;
	select count(*) into v_history_count from public.qorpera_session_events where session_id = v_run.session_id
		and sequence <= v_run.transcript_start_sequence and event_type = 'message' and not (event_id = any(v_run.input_ids));
	v_source := public.qorpera_company_context_source(v_run,'job',v_run.id);
	v_job := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024));
	v_source := public.qorpera_company_context_source(v_run,'job_spec',v_run.staff_agent_id);
	v_spec := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));
	select coalesce(jsonb_agg(jsonb_build_object('id',staff_agent_id,'version',version,'name',display_name,'role',role)
		order by staff_agent_id),'[]') into v_coworkers from (select staff_agent_id,version,display_name,role
		from public.qorpera_profile_staff where profile_id = v_run.profile_id and employment_status = 'active'
			and staff_agent_id <> v_run.staff_agent_id order by staff_agent_id limit 50) coworker;
	select count(*) into v_coworker_count from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and employment_status = 'active' and staff_agent_id <> v_run.staff_agent_id;
	v_result := jsonb_build_object('schema','qorpera.native-company-context/v1','identity',v_authority -> 'identity',
		'observedAt',clock_timestamp(),'company',jsonb_build_object('id',v_run.profile_id,'name',v_company_name),
		'agent',jsonb_build_object('id',v_staff.staff_agent_id,'version',v_staff.version,'name',v_staff.display_name,'role',v_staff.role),
		'audience',jsonb_build_object('kind',v_run.audience_kind,'userId',v_run.audience_user_id),
		'runtimeBundle',jsonb_build_object('id',v_run.runtime_bundle_id,'sha256',v_run.runtime_bundle_sha256),
		'sourceKind',v_run.source_kind,'sourceId',v_run.source_id,'currentInputs',v_inputs,'history',v_history,
		'historyTruncated',v_history_count > jsonb_array_length(v_history),'coworkers',v_coworkers,
		'coworkersTruncated',v_coworker_count > jsonb_array_length(v_coworkers),'job',v_job,'jobSpecification',v_spec);
	if octet_length(v_result::text) > 1048576 then raise exception 'Cloud context exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$$;

-- A group conversation pins no single staff version (was 20260828021000_runtime_wake_enforcement.sql).
create or replace function public.qorpera_append_runner_transcript_event(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_event_id uuid,
	p_event_type text,
	p_body jsonb,
	p_expected_sequence bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.id is null or v_run.session_id is null or p_event_id is null
		or p_event_type not in (
			'message', 'run_receipt', 'artifact_receipt',
			'authorization_request', 'authorization_decision'
		) or p_body is null or octet_length(convert_to(p_body::text, 'utf8')) > 262144
		or coalesce(p_body ->> 'schema', '') <> 'qorpera.runner-transcript-entry/v1'
		or coalesce(jsonb_typeof(p_body -> 'entry'), '') <> 'object'
		or coalesce(p_body #>> '{entry,id}', '') <> p_event_id::text
		or not public.qorpera_runner_transcript_entry_valid(p_event_type, p_body)
		or coalesce(p_body #>> '{entry,execution,kind}', '') <> 'run'
		or coalesce(p_body #>> '{entry,execution,id}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,claimantId}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,runnerAssignmentId}', '') <> p_assignment_id::text
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.job_id = p_job_id
				and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted'
		) then
		raise exception 'runner transcript authority is invalid' using errcode = '42501';
	end if;
	select event.* into v_existing
	from public.qorpera_session_events as event where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> v_run.session_id or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body or v_existing.execution_kind <> 'run'
			or v_existing.execution_id <> v_run.id
			or v_existing.execution_claimant_id <> v_run.id then
			raise exception 'runner event id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id, 'sequence', v_existing.sequence,
			'event_id', v_existing.event_id, 'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id, 'body', v_existing.body,
			'previous_hash', v_existing.previous_hash, 'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind, 'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'runner_assignment_id', v_existing.runner_assignment_id,
			'created_at', v_existing.created_at
		);
	end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = v_run.session_id for update;
	if not found or v_session.status <> 'open'
		or v_session.profile_id <> v_run.profile_id or v_session.environment_id <> v_run.environment_id
		or not public.qorpera_run_head_follows_session_pin(v_run, v_session.company_snapshot_id)
		or (v_session.staff_agent_id is not null and v_session.staff_version <> v_run.staff_version) then
		raise exception 'runner transcript session pins changed' using errcode = '40001';
	end if;
	if jsonb_typeof(p_body #> '{entry,parentId}') = 'string'
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body #>> '{entry,id}' = p_body #>> '{entry,parentId}'
		)
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
				and parent.body ->> 'entryId' = p_body #>> '{entry,parentId}'
				and jsonb_typeof(parent.body -> 'partIndex') = 'number'
				and jsonb_typeof(parent.body -> 'partCount') = 'number'
			group by parent.body ->> 'entryId', parent.body ->> 'partCount',
				parent.execution_kind, parent.execution_id, parent.execution_claimant_id
			having count(distinct (parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer
				and min((parent.body ->> 'partIndex')::integer) = 0
				and max((parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer - 1
		) then
		raise exception 'runner transcript parent is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_execution_run_budgets
	set transcript_event_count = transcript_event_count + 1,
		transcript_bytes = transcript_bytes + octet_length(convert_to(p_body::text, 'utf8'))
	where run_id = v_run.id and transcript_event_count < 2000
		and transcript_bytes + octet_length(convert_to(p_body::text, 'utf8')) <= 67108864;
	if not found then
		raise exception 'runner transcript budget is exhausted' using errcode = '55000';
	end if;
	select event.sequence, event.event_hash into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = v_session.id order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise exception 'session event sequence changed' using errcode = '40001';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(extensions.digest(convert_to(
		coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
			'session_id', v_session.id,
			'sequence', v_sequence,
			'event_id', p_event_id,
			'event_type', p_event_type,
			'actor_user_id', v_run.created_by_user_id,
			'body', p_body,
			'execution_kind', 'run',
			'execution_id', v_run.id,
			'execution_claimant_id', v_run.id,
			'runner_assignment_id', p_assignment_id,
			'created_at', v_created_at
		)::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, runner_assignment_id, created_at
	) values (
		v_session.id, v_sequence, p_event_id, p_event_type, v_run.created_by_user_id, p_body,
		v_previous_hash, v_event_hash, 'run', v_run.id, v_run.id, p_assignment_id, v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = v_session.id;
	return jsonb_build_object(
		'session_id', v_session.id, 'sequence', v_sequence,
		'event_id', p_event_id, 'event_type', p_event_type,
		'actor_user_id', v_run.created_by_user_id, 'body', p_body,
		'previous_hash', v_previous_hash, 'event_hash', v_event_hash,
		'execution_kind', 'run', 'execution_id', v_run.id,
		'execution_claimant_id', v_run.id, 'runner_assignment_id', p_assignment_id,
		'created_at', v_created_at
	);
end
$$;

-- The room post's author is the wake actor (was 20260828021000_runtime_wake_enforcement.sql).
create or replace function public.qorpera_read_native_wake(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_actor jsonb; v_path text; v_payload jsonb; v_routine jsonb := null; v_sender uuid; v_actor_user uuid;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	if not found or not public.qorpera_wake_authorized(v_wake)
		or public.qorpera_runtime_wake_policy(v_run.id) ->> 'kind' is distinct from v_wake.wake_kind then
		raise exception 'Admitted wake is unavailable' using errcode = '42501'; end if;
	if v_wake.source_kind = 'company-file' then
		select change #>> '{plan,path}' into strict v_path from public.qorpera_company_path_revisions
		where snapshot_id = v_wake.file_event_id;
		perform public.qorpera_company_path_remember_read(v_actor,v_path);
	elsif v_wake.wake_kind = 'agent' then
		for v_path in select path from public.qorpera_company_run_read_paths where run_id = v_wake.parent_run_id loop
			perform public.qorpera_company_path_remember_read(v_actor,v_path);
		end loop;
	end if;
	perform public.qorpera_company_path_assert_context(v_actor);
	if v_wake.wake_kind = 'routine' then
		select jsonb_build_object('id',routine_id,'version',version,'intent',prompt) into v_routine
		from public.qorpera_cloud_routine_versions where routine_id = v_wake.routine_id and version = v_wake.routine_version;
	end if;
	if v_wake.parent_run_id is not null then
		select staff_agent_id,requested_by_user_id into v_sender,v_actor_user
		from public.qorpera_execution_runs where id = v_wake.parent_run_id;
	elsif v_wake.source_kind in ('input','room') then v_actor_user := v_run.requested_by_user_id;
	end if;
	if v_wake.source_kind = 'company-file' then
		select actor_staff_id,actor_user_id into v_sender,v_actor_user
		from public.qorpera_company_path_revisions where snapshot_id = v_wake.file_event_id;
	end if;
	v_payload := jsonb_build_object('schema','qorpera.wake-envelope/v1','id',v_wake.id,'runId',v_run.id,
		'kind',v_wake.wake_kind,'companyId',v_run.profile_id,'environmentId',v_run.environment_id,
		'staffAgentId',v_run.staff_agent_id,'requesterUserId',v_run.requested_by_user_id,
		'actorStaffId',v_sender,'actorUserId',v_actor_user,
		'audience',jsonb_build_object('kind',v_run.audience_kind,'userId',v_run.audience_user_id,'sessionId',v_run.session_id),
		'source',jsonb_build_object('kind',v_wake.source_kind,'id',v_wake.source_id,'occurrenceKey',v_wake.occurrence_key),
		'policy',public.qorpera_runtime_wake_policy(v_run.id),
		'time',jsonb_build_object('utc',to_char(v_wake.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			'local',to_char(v_wake.scheduled_for at time zone v_wake.time_zone,'YYYY-MM-DD"T"HH24:MI:SS.US'),'timeZone',v_wake.time_zone),
		'pins',jsonb_build_object('companySnapshotId',v_run.company_snapshot_id,'staffVersion',v_run.staff_version,
			'wakeSchema','qorpera.wake-envelope/v1','runtimeBundleVersion',null),
		'routine',v_routine,'payload',v_wake.payload,'parentRunId',v_wake.parent_run_id,
		'causal',jsonb_build_object('rootId',v_wake.causal_root_id,'agentIds',to_jsonb(v_wake.causal_agent_ids)));
	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;
	return v_payload;
end
$$;

-- The deferred projection assertion covers rooms (was 20260828019200_company_organization_projection.sql).
create or replace function public.qorpera_assert_organization_projection()
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
	if v_kind = 'responsibility' then
		v_id := substring(split_part(public.qorpera_company_path_key(new.path),'/',3) from 1 for 36)::uuid;
		if not exists (select 1 from public.qorpera_company_responsibilities responsibility where responsibility.id = v_id
			and responsibility.environment_id = new.environment_id and responsibility.source_path_version = new.version
			and responsibility.source_snapshot_id = (select file.head_snapshot_id from public.qorpera_company_files file
				where file.environment_id = new.environment_id)
			and responsibility.source_file_sha256 = new.entry #>> '{file,fileSha256}') then
			raise exception 'Responsibility projection did not advance with the Company File' using errcode = '23514'; end if;
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
	if v_kind = 'room' then
		v_id := substring(split_part(public.qorpera_company_path_key(new.path),'/',3) from 1 for 36)::uuid;
		if not exists (select 1 from public.qorpera_company_rooms room where room.id = v_id
			and room.environment_id = new.environment_id and room.source_path_version = new.version
			and room.source_snapshot_id = (select file.head_snapshot_id from public.qorpera_company_files file
				where file.environment_id = new.environment_id)
			and room.source_file_sha256 = new.entry #>> '{file,fileSha256}') then
			raise exception 'Room projection did not advance with the Company File' using errcode = '23514'; end if;
	end if;
	return new;
end
$$;

-- A run in a room conversation carries the room's company audience (was 20260828019300_runtime_step0_bootstrap_provenance.sql).
create or replace function public.qorpera_pin_execution_run_audience()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_bundle public.qorpera_active_runtime_bundle%rowtype;
	v_input record;
begin
	if tg_op = 'UPDATE' and (new.audience_kind,new.audience_user_id,new.runtime_bundle_id,new.runtime_bundle_sha256)
		is distinct from (old.audience_kind,old.audience_user_id,old.runtime_bundle_id,old.runtime_bundle_sha256) then
		raise exception 'Execution audience provenance is immutable' using errcode = '42501'; end if;
	if tg_op = 'INSERT' then
		select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
		if new.session_id is null then
			new.audience_kind := 'company'; new.audience_user_id := null;
		else
			select * into v_session from public.qorpera_shared_sessions where id = new.session_id;
			if not found or v_session.profile_id <> new.profile_id or v_session.environment_id <> new.environment_id
				or (v_session.staff_agent_id is distinct from new.staff_agent_id::text and not (v_session.staff_agent_id is null
					and public.qorpera_company_room_session_staff(v_session.id,new.staff_agent_id))) then
				raise exception 'Execution session audience is unavailable' using errcode = '42501'; end if;
			new.audience_kind := v_session.audience_kind; new.audience_user_id := v_session.audience_user_id;
			if new.audience_kind = 'member_private' and new.requested_by_user_id <> new.audience_user_id then
				raise exception 'Execution requester differs from private audience' using errcode = '42501'; end if;
		end if;
		select min(input.runtime_bundle_id::text) bundle_id,min(input.runtime_bundle_sha256) bundle_sha,
			count(distinct (input.runtime_bundle_id::text || ':' || input.runtime_bundle_sha256)) variants
		into v_input from public.qorpera_session_inputs input where input.id = any(new.input_ids);
		if coalesce(v_input.variants,0) > 1 then
			raise exception 'Execution inputs use different runtime bundles' using errcode = '42501'; end if;
		new.runtime_bundle_id := coalesce(v_input.bundle_id::uuid,v_bundle.runtime_bundle_id);
		new.runtime_bundle_sha256 := coalesce(v_input.bundle_sha,v_bundle.runtime_bundle_sha256);
	end if;
	return new;
end
$$;
