-- Runtime Order 0 staff lifecycle. Permanent deletion is a cloud-authorized
-- tombstone, not an unsafe hard delete of immutable execution history. Live
-- authority and owned active state are retired in the same transaction while
-- historical rows keep their referential identity for audit and replay.

alter table public.qorpera_profile_staff
	add column deleted_at timestamptz,
	add column deleted_by_user_id uuid references auth.users(id) on delete restrict,
	add constraint qorpera_profile_staff_deleted_pair check (
		(deleted_at is null) = (deleted_by_user_id is null)
	);

alter table public.qorpera_artifacts
	add column owner_staff_agent_id uuid,
	add column deleted_at timestamptz,
	add column deleted_by_user_id uuid references auth.users(id) on delete restrict,
	add constraint qorpera_artifacts_deleted_pair check (
		(deleted_at is null) = (deleted_by_user_id is null)
	),
	add constraint qorpera_artifacts_owner_staff_fkey
		foreign key (profile_id,owner_staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict;

create index qorpera_artifacts_owner_active
	on public.qorpera_artifacts(profile_id,owner_staff_agent_id,created_at)
	where owner_staff_agent_id is not null and deleted_at is null;

create function public.qorpera_pin_artifact_staff_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_staff text;
begin
	if new.owner_staff_agent_id is not null or new.session_id is null then return new; end if;
	select session.staff_agent_id into v_staff from public.qorpera_shared_sessions session
	where session.id = new.session_id and session.profile_id = new.profile_id;
	if v_staff ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		and exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = new.profile_id and staff.staff_agent_id = v_staff::uuid) then
		new.owner_staff_agent_id := v_staff::uuid;
	end if;
	return new;
end
$$;

create trigger qorpera_artifacts_pin_staff_owner
before insert on public.qorpera_artifacts
for each row execute function public.qorpera_pin_artifact_staff_owner();

update public.qorpera_artifacts artifact set owner_staff_agent_id = session.staff_agent_id::uuid
from public.qorpera_shared_sessions session
where artifact.session_id = session.id and artifact.profile_id = session.profile_id
	and artifact.owner_staff_agent_id is null
	and session.staff_agent_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
	and exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = artifact.profile_id and staff.staff_agent_id = session.staff_agent_id::uuid);

create function public.qorpera_protect_deleted_staff()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if old.deleted_at is not null and new is distinct from old then
		raise exception 'permanently deleted staff cannot be restored or changed' using errcode = '55000';
	end if;
	if old.employment_status = 'active' and new.employment_status <> 'active' and exists (
		select 1 from public.qorpera_company_cofounders cofounder
		where cofounder.profile_id = old.profile_id and cofounder.staff_agent_id = old.staff_agent_id
	) then
		raise exception 'the company Co-Founder cannot be archived' using errcode = '42501';
	end if;
	return new;
end
$$;
create trigger qorpera_profile_staff_protect_deleted
before update on public.qorpera_profile_staff
for each row execute function public.qorpera_protect_deleted_staff();

drop policy if exists qorpera_profile_staff_member_read on public.qorpera_profile_staff;
create policy qorpera_profile_staff_member_read
	on public.qorpera_profile_staff for select to authenticated
	using (deleted_at is null and exists (
		select 1 from public.qorpera_profile_members member
		where member.profile_id = qorpera_profile_staff.profile_id and member.user_id = auth.uid()
	));

create or replace function public.qorpera_list_profile_staff(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'profile access denied' using errcode = '42501'; end if;
	return coalesce((select jsonb_agg(jsonb_build_object(
		'profile_id',staff.profile_id,'staff_agent_id',staff.staff_agent_id,
		'display_name',staff.display_name,'role',staff.role,'charter',staff.charter,
		'template_id',staff.template_id,'department_id',staff.department_id,
		'appearance_color',staff.appearance_color,'appearance_shape',staff.appearance_shape,
		'appearance_creature',staff.appearance_creature,'model_provider',staff.model_provider,
		'model_id',staff.model_id,'employment_status',staff.employment_status,
		'lifecycle_state',staff.lifecycle_state,'version',staff.version,
		'created_at',staff.created_at,'updated_at',staff.updated_at,
		'updated_by_user_id',staff.updated_by_user_id
	) order by staff.created_at,staff.staff_agent_id)
	from public.qorpera_profile_staff staff
	where staff.profile_id = p_profile_id and staff.deleted_at is null),'[]'::jsonb);
end
$$;

create or replace function public.qorpera_artifact_json(p_artifact public.qorpera_artifacts)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'artifact_id',p_artifact.id,'profile_id',p_artifact.profile_id,
		'environment_id',p_artifact.environment_id,'client_artifact_id',p_artifact.client_artifact_id,
		'session_id',p_artifact.session_id,'owner_staff_agent_id',p_artifact.owner_staff_agent_id,
		'artifact_type',p_artifact.artifact_type,'name',p_artifact.name,
		'root_object_sha256',p_artifact.root_object_sha256,'content_sha256',p_artifact.content_sha256,
		'root_contract',p_artifact.root_contract,'bytes',p_artifact.bytes,'media_type',p_artifact.media_type,
		'created_by_user_id',p_artifact.created_by_user_id,'created_at',p_artifact.created_at,
		'eligible_for_gc_at',p_artifact.eligible_for_gc_at,'gc_completed_at',p_artifact.gc_completed_at,
		'deleted_at',p_artifact.deleted_at
	)
$$;

create or replace function public.qorpera_delete_profile_staff(
	p_profile_id uuid,p_staff_agent_id uuid,p_expected_version bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_role public.qorpera_profile_role;
	v_staff public.qorpera_profile_staff%rowtype; v_now timestamptz := statement_timestamp();
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
		revoked_by_user_id = v_actor
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id and status = 'active';
	delete from public.qorpera_staff_execution_authorities
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_staff_provider_models
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	delete from public.qorpera_session_execution_bindings binding using public.qorpera_shared_sessions session
	where binding.session_id = session.id and session.profile_id = p_profile_id
		and session.staff_agent_id = p_staff_agent_id::text;
	update public.qorpera_shared_sessions set status = 'closed',updated_at = v_now
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id::text and status = 'open';
	update public.qorpera_artifacts set deleted_at = v_now,deleted_by_user_id = v_actor
	where profile_id = p_profile_id and owner_staff_agent_id = p_staff_agent_id and deleted_at is null;
	update public.qorpera_profile_staff set display_name = 'Deleted agent',role = 'Deleted agent',
		charter = 'Deleted staff identity retained only for immutable operation history.',
		template_id = null,department_id = null,appearance_color = 'deleted',appearance_shape = 'round',
		appearance_creature = null,model_provider = null,model_id = null,employment_status = 'archived',
		version = version + 1,updated_at = v_now,updated_by_user_id = v_actor,
		deleted_at = v_now,deleted_by_user_id = v_actor
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	return 'true'::jsonb;
end
$$;

revoke all on function public.qorpera_pin_artifact_staff_owner() from public,anon,authenticated,service_role;
revoke all on function public.qorpera_protect_deleted_staff() from public,anon,authenticated,service_role;
revoke all on function public.qorpera_delete_profile_staff(uuid,uuid,bigint) from public,anon;
grant execute on function public.qorpera_delete_profile_staff(uuid,uuid,bigint) to authenticated;
