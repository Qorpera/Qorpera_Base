-- Agent threads are shared channels bound by rooms (contract amendment 2026-09-17).
-- Every active agent has one shared thread with the company's members: a
-- company-audience session bound to a room whose members are all active,
-- non-viewer company members and that agent. Rooms remain the backend binding
-- (who may post, whom a post wakes); clients present agents and threads. A post
-- runs the agent on the posting member's own account; a post into an agent
-- thread requires a reply. Member-private conversations are withdrawn.

alter table public.qorpera_company_rooms add column bound_staff_agent_id uuid;
create unique index qorpera_company_rooms_bound_agent on public.qorpera_company_rooms (profile_id, bound_staff_agent_id)
	where bound_staff_agent_id is not null;
alter table public.qorpera_company_rooms alter column source_path_version drop not null;
alter table public.qorpera_company_rooms alter column source_snapshot_id drop not null;
alter table public.qorpera_company_rooms alter column source_file_sha256 drop not null;
alter table public.qorpera_company_rooms add constraint qorpera_company_rooms_source_or_binding check (
	bound_staff_agent_id is not null
	or (source_path_version is not null and source_snapshot_id is not null and source_file_sha256 is not null));

-- The one thread of one agent: room, members and session, created or refreshed idempotently.
create or replace function public.qorpera_ensure_agent_thread_internal(
	p_profile_id uuid, p_environment_id uuid, p_staff_agent_id uuid, p_actor_user_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_room public.qorpera_company_rooms%rowtype; v_staff public.qorpera_profile_staff%rowtype;
	v_session uuid; v_version uuid := extensions.gen_random_uuid(); v_active boolean;
begin
	select * into v_staff from public.qorpera_profile_staff where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	if not found then raise exception 'Agent is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_company_environments where id = p_environment_id and profile_id = p_profile_id) then
		raise exception 'Environment is unavailable' using errcode = '42501'; end if;
	v_active := v_staff.employment_status = 'active' and v_staff.deleted_at is null;
	select * into v_room from public.qorpera_company_rooms where profile_id = p_profile_id and bound_staff_agent_id = p_staff_agent_id for update;
	if not found then
		insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,purpose,status,project_id,version,
			source_path,source_path_version,source_snapshot_id,source_file_sha256,created_by_user_id,bound_staff_agent_id)
		values (extensions.gen_random_uuid(),p_profile_id,p_environment_id,'agent-' || p_staff_agent_id::text,v_staff.display_name,
			'The company''s shared thread with this agent. Every member reads the same thread; each post runs the agent on the posting member''s own account. Answer every post.',
			case when v_active then 'active' else 'archived' end,null,1,
			'organization/agents/' || p_staff_agent_id::text || '.json',null,null,null,p_actor_user_id,p_staff_agent_id)
		returning * into v_room;
	else
		update public.qorpera_company_rooms set status = case when v_active then 'active' else 'archived' end,
			name = v_staff.display_name, updated_at = clock_timestamp() where id = v_room.id returning * into v_room;
	end if;
	insert into public.qorpera_company_room_members(room_id,principal_kind,principal_id,status,source_path_version)
	select v_room.id,'member',member.user_id,'active',v_version from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.role <> 'viewer'
	on conflict (room_id,principal_kind,principal_id) do update set status = 'active', removed_at = null,
		source_path_version = excluded.source_path_version where public.qorpera_company_room_members.status <> 'active';
	insert into public.qorpera_company_room_members(room_id,principal_kind,principal_id,status,source_path_version)
	values (v_room.id,'staff_agent',p_staff_agent_id,'active',v_version)
	on conflict (room_id,principal_kind,principal_id) do update set status = 'active', removed_at = null,
		source_path_version = excluded.source_path_version where public.qorpera_company_room_members.status <> 'active';
	update public.qorpera_company_room_members set status = 'removed', removed_at = clock_timestamp(), source_path_version = v_version
	where room_id = v_room.id and principal_kind = 'member' and status = 'active' and not exists (
		select 1 from public.qorpera_profile_members member where member.profile_id = p_profile_id
			and member.user_id = principal_id and member.role <> 'viewer');
	if v_room.session_id is null then
		insert into public.qorpera_shared_sessions(profile_id,environment_id,title,staff_agent_id,created_by_user_id,
			audience_kind,audience_user_id,execution_scope)
		values (p_profile_id,p_environment_id,v_staff.display_name,p_staff_agent_id::text,p_actor_user_id,'company',null,
			jsonb_build_object('roomId',v_room.id,'agentThread',true)) returning id into v_session;
		update public.qorpera_company_rooms set session_id = v_session where id = v_room.id;
	else
		v_session := v_room.session_id;
		update public.qorpera_shared_sessions set status = case when v_active then 'open' else 'closed' end::public.qorpera_session_status,
			title = v_staff.display_name, updated_at = statement_timestamp() where id = v_session;
	end if;
	return v_session;
end
$$;
revoke all on function public.qorpera_ensure_agent_thread_internal(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;

create or replace function public.qorpera_profile_environment(p_profile_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
	select coalesce((select cofounder.environment_id from public.qorpera_company_cofounders cofounder where cofounder.profile_id = p_profile_id),
		(select environment.id from public.qorpera_company_environments environment where environment.profile_id = p_profile_id
			order by environment.created_at limit 1))
$$;
revoke all on function public.qorpera_profile_environment(uuid) from public, anon, authenticated, service_role;

-- Staff changes keep the thread in step: a new or reactivated agent gets its thread; an archived one closes it.
create or replace function public.qorpera_agent_thread_on_staff() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_environment uuid := public.qorpera_profile_environment(new.profile_id);
begin
	if v_environment is null then return new; end if;
	if tg_op = 'INSERT' and not (new.employment_status = 'active' and new.deleted_at is null) then return new; end if;
	perform public.qorpera_ensure_agent_thread_internal(new.profile_id,v_environment,new.staff_agent_id,new.updated_by_user_id);
	return new;
end
$$;
drop trigger if exists qorpera_profile_staff_agent_thread on public.qorpera_profile_staff;
create trigger qorpera_profile_staff_agent_thread after insert or update of employment_status, deleted_at, display_name
on public.qorpera_profile_staff for each row execute function public.qorpera_agent_thread_on_staff();

-- Company membership keeps every agent thread's member list in step (viewers read, they do not post).
create or replace function public.qorpera_agent_threads_on_member() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile uuid := coalesce(new.profile_id, old.profile_id); v_environment uuid; v_room record;
begin
	v_environment := public.qorpera_profile_environment(v_profile);
	if v_environment is null then return coalesce(new, old); end if;
	for v_room in select room.bound_staff_agent_id from public.qorpera_company_rooms room
		where room.profile_id = v_profile and room.bound_staff_agent_id is not null loop
		perform public.qorpera_ensure_agent_thread_internal(v_profile,v_environment,v_room.bound_staff_agent_id,
			coalesce(new.user_id, (select member.user_id from public.qorpera_profile_members member where member.profile_id = v_profile and member.role = 'owner')));
	end loop;
	return coalesce(new, old);
end
$$;
-- The member-private Co-Founder session seed (20260828019100) goes with its trigger.
drop trigger if exists qorpera_profile_members_seed_cofounder_session on public.qorpera_profile_members;
drop function if exists public.qorpera_seed_cofounder_member_session();
drop trigger if exists qorpera_profile_members_agent_threads on public.qorpera_profile_members;
create trigger qorpera_profile_members_agent_threads after insert or update of role or delete
on public.qorpera_profile_members for each row execute function public.qorpera_agent_threads_on_member();

-- Members read one agent's thread; writers may create it when the kernel has not yet.
create or replace function public.qorpera_agent_thread(p_environment_id uuid, p_staff_agent_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_room public.qorpera_company_rooms%rowtype;
begin
	select environment.profile_id into v_profile from public.qorpera_company_environments environment where environment.id = p_environment_id;
	if v_profile is null or not public.qorpera_can_read_profile(v_profile) then
		raise exception 'profile read access is required' using errcode = '42501'; end if;
	select * into v_room from public.qorpera_company_rooms where profile_id = v_profile and bound_staff_agent_id = p_staff_agent_id;
	if not found then
		if not public.qorpera_can_write_profile(v_profile) then
			raise exception 'Agent thread is unavailable' using errcode = '42501'; end if;
		perform public.qorpera_ensure_agent_thread_internal(v_profile,p_environment_id,p_staff_agent_id,auth.uid());
		select * into v_room from public.qorpera_company_rooms where profile_id = v_profile and bound_staff_agent_id = p_staff_agent_id;
	end if;
	return jsonb_build_object('schema','qorpera.agent-thread/v1','room_id',v_room.id,'session_id',v_room.session_id,
		'staff_agent_id',p_staff_agent_id,'status',v_room.status);
end
$$;
revoke all on function public.qorpera_agent_thread(uuid,uuid) from public, anon, service_role;
grant execute on function public.qorpera_agent_thread(uuid,uuid) to authenticated;

-- Agent threads accept the attachments an agent session did; team rooms stay text-only.
create or replace function public.qorpera_room_post_images_valid(p_body jsonb, p_agent_thread boolean) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_image jsonb; v_bytes bigint; v_total bigint := 0;
begin
	if not (p_body ? 'images') then return true; end if;
	if jsonb_typeof(p_body -> 'images') <> 'array' then return false; end if;
	if not p_agent_thread then return jsonb_array_length(p_body -> 'images') = 0; end if;
	if jsonb_array_length(p_body -> 'images') > 5 then return false; end if;
	for v_image in select value from jsonb_array_elements(p_body -> 'images') loop
		if jsonb_typeof(v_image) is distinct from 'object' or v_image - 'objectSha256' - 'bytes' - 'mediaType' <> '{}'::jsonb
			or coalesce(v_image ->> 'objectSha256','') !~ '^[0-9a-f]{64}$'
			or jsonb_typeof(v_image -> 'bytes') is distinct from 'number'
			or coalesce(v_image ->> 'mediaType','') not in ('image/png','image/jpeg','image/gif','image/webp') then return false; end if;
		begin v_bytes := (v_image ->> 'bytes')::bigint; exception when others then return false; end;
		if to_jsonb(v_bytes) <> v_image -> 'bytes' or v_bytes not between 1 and 8388608 then return false; end if;
		v_total := v_total + v_bytes;
		if v_total > 8388608 then return false; end if;
	end loop;
	return true;
end
$$;
revoke all on function public.qorpera_room_post_images_valid(jsonb,boolean) from public, anon, authenticated, service_role;

do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)'::regprocedure);
	v_old := $old$or (p_body ? 'images' and (jsonb_typeof(p_body -> 'images') <> 'array' or jsonb_array_length(p_body -> 'images') > 0)) then$old$;
	v_new := $new$or not public.qorpera_room_post_images_valid(p_body, v_room.bound_staff_agent_id is not null) then$new$;
	if strpos(v_definition, v_old) = 0 then raise exception 'Room post image rule differs'; end if;
	v_definition := replace(v_definition, v_old, v_new);
	execute v_definition;

	-- A post into an agent thread requires a reply; team rooms keep their optional policy.
	-- 20260907000100 wrapped the policy body in qorpera_runtime_wake_policy_internal.
	v_definition := pg_get_functiondef('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure);
	v_old := 'return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);';
	v_new := $new$if v_wake.wake_kind = 'room' and exists (select 1 from public.qorpera_company_rooms room
		where room.session_id = v_wake.session_id and room.bound_staff_agent_id = v_wake.staff_agent_id) then
		v_reporting := 'required'; end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Runtime wake policy return differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

create or replace function public.qorpera_wake_policy_value(p_kind text,p_reporting text default 'required')
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_initial text := 'required'; v_final text := 'required'; v_kind text; v_max integer := 64;
begin
	if p_kind in ('human','first-run','routine','agent','room')
		and p_reporting in ('optional','required','silent') then
		v_kind := p_kind;
		if p_kind = 'routine' then
			v_initial := case when p_reporting = 'silent' then 'forbidden' else 'optional' end;
			v_final := case p_reporting when 'required' then 'required' when 'silent' then 'forbidden' else 'optional' end;
			if p_reporting = 'silent' then v_max := 0; end if;
		elsif p_kind = 'agent' then
			v_initial := 'forbidden'; v_final := 'forbidden'; v_max := 0;
		elsif p_kind = 'room' then
			-- An agent thread (reporting required) answers every post; a team room may stay silent.
			v_initial := 'optional'; v_final := case when p_reporting = 'required' then 'required' else 'optional' end; v_max := 3;
		end if;
	end if;
	return jsonb_build_object('schema','qorpera.wake-policy/v1','kind',v_kind,
		'initial',v_initial,'final',v_final,'silenceAllowed',v_final <> 'required','maxPublicSends',v_max);
end
$$;

create or replace function public.qorpera_seed_company_cofounder(p_profile_id uuid,p_created_by_user_id uuid)
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
		return jsonb_build_object('staff_agent_id',v_cofounder.staff_agent_id,
			'formation_id',v_cofounder.formation_id,'member_session_id',
			public.qorpera_ensure_agent_thread_internal(p_profile_id,v_environment_id,v_cofounder.staff_agent_id,p_created_by_user_id));
	end if;
	select staff.staff_agent_id into v_staff_id from public.qorpera_profile_staff staff
	where staff.profile_id = p_profile_id and staff.template_id = 'co-founder';
	if v_staff_id is null then
		v_staff_id := extensions.gen_random_uuid();
		insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,template_id,
			appearance_color,appearance_shape,appearance_creature,employment_status,lifecycle_state,version,
			created_at,updated_at,updated_by_user_id)
		values (p_profile_id,v_staff_id,'Co-Founder','Company direction, the responsibility map, resourcing, and the founder relationship',
			$charter$Hold the company-level responsibilities: direction, the responsibility map, resourcing, and the founder relationship. Bring the founder decisions, blockers, and material risks with a recommended position; delegate bounded work through explicit agents, responsibilities, projects, rooms, and workers. Work by changing the Company File. Do not grant authority, approve your own gated changes, or make external commitments without the responsible human.$charter$,
			'co-founder','qorpera-blue','round','brain','active','setup',1,
			statement_timestamp(),statement_timestamp(),p_created_by_user_id);
	end if;
	insert into public.qorpera_company_formations(profile_id,environment_id,created_by_user_id)
	values (p_profile_id,v_environment_id,p_created_by_user_id) returning * into v_formation;
	insert into public.qorpera_company_cofounders(profile_id,environment_id,staff_agent_id,formation_id,created_by_user_id)
	values (p_profile_id,v_environment_id,v_staff_id,v_formation.id,p_created_by_user_id) returning * into v_cofounder;
	return jsonb_build_object('staff_agent_id',v_staff_id,'formation_id',v_formation.id,
		'member_session_id',public.qorpera_ensure_agent_thread_internal(p_profile_id,v_environment_id,v_staff_id,p_created_by_user_id));
end
$$;

create or replace function public.qorpera_company_organization_bootstrap(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cofounder public.qorpera_company_cofounders%rowtype;
	v_formation public.qorpera_company_formations%rowtype; v_session_id uuid;
begin
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'company organization write access is required' using errcode = '42501'; end if;
	select * into v_cofounder from public.qorpera_company_cofounders where profile_id = p_profile_id;
	select * into v_formation from public.qorpera_company_formations where profile_id = p_profile_id;
	select room.session_id into v_session_id from public.qorpera_company_rooms room
	where room.profile_id = p_profile_id and room.bound_staff_agent_id = v_cofounder.staff_agent_id;
	if v_cofounder.profile_id is null or v_formation.id is null or v_session_id is null
		or v_cofounder.formation_id <> v_formation.id then
		raise exception 'company organization bootstrap is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object('schema','qorpera.company-organization-bootstrap/v1',
		'cofounder',jsonb_build_object('staff_agent_id',v_cofounder.staff_agent_id,
			'formation_id',v_formation.id,'member_session_id',v_session_id),
		'formation_state',v_formation.state);
end
$$;

create or replace function public.qorpera_company_organization_json(p_profile_id uuid)
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
			'member_session_id',(select room.session_id from public.qorpera_company_rooms room
				where room.profile_id = p_profile_id and room.bound_staff_agent_id = v_cofounder.staff_agent_id)) end,
		'formation',case when v_formation.id is null then null else jsonb_build_object(
			'formation_id',v_formation.id,'state',v_formation.state,'status',v_formation.status,
			'revision',v_formation.revision,'projection_status',v_formation.projection_status,
			'source_path',v_formation.source_path,'source_path_version',v_formation.source_path_version,
			'source_snapshot_id',v_formation.source_snapshot_id,'source_file_sha256',v_formation.source_file_sha256) end,
		'responsibilities',coalesce((select jsonb_agg(jsonb_build_object(
			'responsibility_id',responsibility.id,'slug',responsibility.slug,'name',responsibility.name,
			'outcome',responsibility.outcome,
			'accountable_staff_agent_id',responsibility.accountable_staff_agent_id,
			'accountable_user_id',responsibility.accountable_user_id,
			'attention_cadence',responsibility.attention_cadence,
			'escalation_threshold',responsibility.escalation_threshold,'escalation_target',responsibility.escalation_target,
			'effort_policy',responsibility.effort_policy,'budget_policy',responsibility.budget_policy,
			'concurrency_policy',responsibility.concurrency_policy,
			'routine_ids',to_jsonb(responsibility.routine_ids),'listener_ids',to_jsonb(responsibility.listener_ids),
			'external_operation_grants',responsibility.external_operation_grants,
			'resources',public.qorpera_responsibility_resources_json(responsibility.id),
			'active_projects',coalesce((select jsonb_agg(jsonb_build_object(
				'project_id',project.id,'key',project.project_key,'name',project.name,'status',project.status,
				'lead_staff_agent_id',project.lead_staff_agent_id,'room_id',project.room_id
			) order by project.created_at,project.id) from public.qorpera_company_projects project
			where project.sponsoring_responsibility_id = responsibility.id
				and project.status in ('proposed','active','blocked')),'[]'::jsonb),
			'status',responsibility.status,'version',responsibility.version,
			'source_path',responsibility.source_path,'source_path_version',responsibility.source_path_version,
			'source_snapshot_id',responsibility.source_snapshot_id,'source_file_sha256',responsibility.source_file_sha256,
			'measures',coalesce((select jsonb_agg(jsonb_build_object('measure_id',measure.id,'key',measure.measure_key,
				'label',measure.label,'definition',measure.definition,'direction',measure.direction,
				'target',measure.target,'guardrails',measure.guardrails,'cadence',measure.cadence,'status',measure.status,
				'sources',coalesce((select jsonb_agg(jsonb_build_object('path',source.source_path,
					'path_match',source.path_match,'source_path_version',source.source_path_version,
					'source_snapshot_id',source.source_snapshot_id,'source_file_sha256',source.source_file_sha256)
					order by source.source_path) from public.qorpera_responsibility_measure_sources source
					where source.measure_id = measure.id),'[]'::jsonb)) order by measure.measure_key)
				from public.qorpera_responsibility_measures measure
				where measure.responsibility_id = responsibility.id),'[]'::jsonb)
		) order by responsibility.slug) from public.qorpera_company_responsibilities responsibility
		where responsibility.profile_id = p_profile_id),'[]'::jsonb),
		'projects',coalesce((select jsonb_agg(jsonb_build_object(
			'project_id',project.id,'key',project.project_key,'name',project.name,'objective',project.objective,
			'definition_of_done',project.definition_of_done,'scope_kind',project.scope_kind,
			'sponsoring_responsibility_id',project.sponsoring_responsibility_id,'lead_staff_agent_id',project.lead_staff_agent_id,
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

-- Every active agent gets its thread; member-private conversations close; their creation functions go.
do $$
declare v record;
begin
	for v in select staff.profile_id, staff.staff_agent_id, staff.updated_by_user_id, public.qorpera_profile_environment(staff.profile_id) as environment_id
		from public.qorpera_profile_staff staff where staff.employment_status = 'active' and staff.deleted_at is null loop
		if v.environment_id is not null then
			perform public.qorpera_ensure_agent_thread_internal(v.profile_id, v.environment_id, v.staff_agent_id, v.updated_by_user_id);
		end if;
	end loop;
	update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp()
	where audience_kind = 'member_private' and status = 'open';
end
$$;
drop function if exists public.qorpera_ensure_member_private_staff_session(uuid,uuid,uuid,uuid,text);
drop function if exists public.qorpera_ensure_member_private_staff_session_internal(uuid,uuid,uuid,uuid,text);
