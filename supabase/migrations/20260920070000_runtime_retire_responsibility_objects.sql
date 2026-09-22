-- Contract amendment 2026-09-20: what an agent is responsible for is its
-- description. The structured responsibility object is withdrawn, so its cloud
-- state is retired here.
--
-- The eight tables are dropped (founder decision 2026-09-20: no company holds
-- responsibility data worth keeping). They held projections of Company File
-- documents, which stay in the Company File as ordinary files, and the queue of
-- agent escalations. The drop is deliberately not CASCADE: anything that still
-- depends on these tables must fail this migration rather than vanish with them.
--
-- What changes for a company:
--   * organization/responsibilities/*.json stop being organization documents.
--     Existing files stay in the Company File as ordinary files that can be
--     read, edited or deleted like any other. Nothing projects them.
--   * a new company is born without the four Co-Founder responsibility
--     documents and without an organization/responsibilities folder;
--   * agents lose escalate_responsibility and its two companions;
--   * a path resource that was scoped to a responsibility stays closed to
--     everyone but owners and admins, who can move what is in it. It is never
--     widened;
--   * a project keeps its recorded sponsor id as history, without a target;
--     a member reaches a project-scoped resource as owner or admin only;
--   * grants.responsibilities stays in the agent document schema, so no stored
--     document becomes invalid, and is ignored;
--   * the organization read model still answers "responsibilities": [] and
--     reports every project as company-scoped, so every client keeps parsing.
--
-- No function in public may still name a retired table (checked at the end): a
-- PL/pgSQL %rowtype declaration of a missing table fails when the function is
-- compiled, even if the branch that used it can no longer run. The bootstrap
-- claim/stage functions keep their document branches, which name no table and
-- cannot run once no job carries documents.

-- 1. In-flight company creations stop carrying responsibility documents.
update public.qorpera_company_bootstrap_jobs
set cofounder_responsibility_documents = '{}'::jsonb, cofounder_responsibility_manifest_sha256 = '{}'::jsonb
where state <> 'completed' and cofounder_responsibility_documents <> '{}'::jsonb;

-- 2. Exact-once text edits of live functions. Every edit of one function is composed
-- first and executed once, because a function body is validated on each replace and the
-- intermediate states of a multi-part edit are not valid.
create function pg_temp.edit(p_definition text, p_old text, p_new text) returns text language plpgsql as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Retiring responsibilities: a function differs at "%"', left(p_old, 70); end if;
	return replace(p_definition, p_old, p_new);
end
$$;
-- Removes the text from the only occurrence of p_from up to (not including) the next p_to.
create function pg_temp.excise(p_definition text, p_from text, p_to text, p_new text) returns text language plpgsql as $$
declare v_start integer := position(p_from in p_definition); v_length integer;
begin
	if v_start = 0 or (length(p_definition) - length(replace(p_definition, p_from, ''))) / length(p_from) <> 1 then
		raise exception 'Retiring responsibilities: a function differs at "%"', left(p_from, 70); end if;
	v_length := position(p_to in substr(p_definition, v_start));
	if v_length = 0 then raise exception 'Retiring responsibilities: no "%" after the cut', left(p_to, 70); end if;
	return left(p_definition, v_start - 1) || p_new || substr(p_definition, v_start + v_length - 1);
end
$$;

-- 2a. New companies are not seeded with responsibility documents.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_enqueue_company_bootstrap(uuid,boolean)'::regprocedure);
begin
	v := pg_temp.edit(v, $old$public.qorpera_company_bootstrap_responsibility_documents(p_profile_id),p_hidden_until_ready,p_hidden_until_ready)$old$,
	$new$'{}'::jsonb,p_hidden_until_ready,p_hidden_until_ready)$new$);
	execute v;
end
$patch$;

-- 2b. A genesis tree no longer needs the responsibilities folder: five entries. An object
-- gateway that has not been updated yet still builds the empty folder; that tree is accepted
-- too, so the order in which the database and the gateway are rolled out cannot block a
-- company from being created.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_finalize_company_bootstrap(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);
begin
	v := pg_temp.edit(v, $old$		or not (v_entries @> jsonb_build_array(jsonb_build_object('path','organization/responsibilities','kind','directory')))
$old$, '');
	v := pg_temp.edit(v, $old$if jsonb_array_length(v_entries) <> 6 + (select count(*) from jsonb_object_keys(v_job.cofounder_responsibility_documents)) then$old$,
	$new$if jsonb_array_length(v_entries) <> 5 + (select count(*) from jsonb_object_keys(v_job.cofounder_responsibility_documents))
			+ (v_entries @> jsonb_build_array(jsonb_build_object('path','organization/responsibilities','kind','directory')))::integer then$new$);
	execute v;
end
$patch$;

-- 2c. The Co-Founder's seeded description, in the new model's words.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_seed_company_cofounder(uuid,uuid)'::regprocedure);
begin
	v := pg_temp.edit(v, $old$'Company direction, the responsibility map, resourcing, and the founder relationship',$old$,
	$new$'Company direction, ownership, resourcing, and the founder relationship',$new$);
	v := pg_temp.edit(v, $old$Hold the company-level responsibilities: direction, the responsibility map, resourcing, and the founder relationship. Bring the founder decisions, blockers, and material risks with a recommended position; delegate bounded work through explicit agents, responsibilities, projects, rooms, and workers.$old$,
	$new$Hold the company-level responsibilities: direction, making sure everything the company cares about has one owner, resourcing, and the founder relationship. Bring the founder decisions, blockers, and material risks with a recommended position; delegate bounded work through explicit agents, projects, rooms, and workers.$new$);
	execute v;
end
$patch$;

-- 2d. Deleting an agent no longer asks about responsibilities.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid)'::regprocedure);
begin
	v := pg_temp.edit(v, $old$	if exists (select 1 from public.qorpera_company_responsibilities responsibility
		where responsibility.profile_id = p_profile_id
			and responsibility.accountable_staff_agent_id = p_staff_agent_id
			and responsibility.status <> 'retired')
		or exists (select 1 from public.qorpera_company_projects project$old$,
	$new$	if exists (select 1 from public.qorpera_company_projects project$new$);
	v := pg_temp.edit(v, $old$raise exception 'reassign active organizational responsibilities before deleting this agent' using errcode = '55000';$old$,
	$new$raise exception 'hand over the projects this agent leads before deleting it' using errcode = '55000';$new$);
	v := pg_temp.edit(v, $old$	delete from public.qorpera_agent_responsibility_grants
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
$old$, '');
	execute v;
end
$patch$;

-- 2e. grants.responsibilities stays a well-formed array and is ignored.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_project_company_agent_grants(jsonb,uuid,jsonb,uuid,boolean)'::regprocedure);
begin
	v := pg_temp.excise(v, $from$		v_responsibility_id := (v_item #>> '{}')::uuid;
		if v_responsibility_id = any(v_responsibility_ids)$from$,
	$to$	end loop;$to$,
	$new$		-- Retired 2026-09-20: a recorded responsibility id is history and grants nothing.
$new$);
	v := pg_temp.edit(v, $old$	delete from public.qorpera_agent_responsibility_grants
	where profile_id = v_profile_id and staff_agent_id = p_staff_agent_id;
$old$, '');
	v := pg_temp.edit(v, $old$	insert into public.qorpera_agent_responsibility_grants(profile_id,staff_agent_id,responsibility_id,source_path_version)
	select v_profile_id,p_staff_agent_id,id,p_source_path_version from unnest(v_responsibility_ids) id;
$old$, '');
	execute v;
end
$patch$;

-- 2f. The organization projection loses its responsibility branch and declaration.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid)'::regprocedure);
begin
	v := pg_temp.excise(v, $from$	if v_kind = 'responsibility' then
		if not (v_document ?& array['schema','responsibilityId',$from$,
	$to$	if v_kind = 'room' then
		if not (v_document ?& array['schema','roomId',$to$, '');
	-- The declaration goes after the branch that used it: the body is validated on every replace.
	v := pg_temp.edit(v, $old$	v_responsibility public.qorpera_company_responsibilities%rowtype;
$old$, '');
	execute v;
end
$patch$;

-- 2g. Scoped path resources belong to projects only.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_project_scoped_path_resources(jsonb,text,uuid,jsonb,uuid)'::regprocedure);
begin
	v := pg_temp.edit(v, $old$if p_owner_kind not in ('responsibility','project') or$old$, $new$if p_owner_kind <> 'project' or$new$);
	v := pg_temp.excise(v, $from$		if p_owner_kind = 'responsibility' then
			insert into public.qorpera_responsibility_path_resources($from$,
		$to$			insert into public.qorpera_project_path_resources($to$, '');
	v := pg_temp.edit(v, $old$				and qorpera_project_path_resources.project_id = excluded.project_id;
		end if;
$old$, $new$				and qorpera_project_path_resources.project_id = excluded.project_id;
$new$);
	v := pg_temp.excise(v, $from$	if p_owner_kind = 'responsibility' then
		update public.qorpera_company_path_resources resource set revoked_at$from$,
		$to$		update public.qorpera_company_path_resources resource set revoked_at = coalesce(resource.revoked_at,clock_timestamp()),
			version = extensions.gen_random_uuid()
		from public.qorpera_project_path_resources mapping$to$, '');
	v := pg_temp.edit(v, $old$			and project_id = p_owner_id and not (resource_id = any(v_ids));
	end if;
$old$, $new$			and project_id = p_owner_id and not (resource_id = any(v_ids));
$new$);
	execute v;
end
$patch$;

-- 2h. The deferred projection assertion no longer knows the kind.
do $patch$
declare v text := pg_get_functiondef('public.qorpera_assert_organization_projection()'::regprocedure);
begin
	v := pg_temp.excise(v, $from$	if v_kind = 'responsibility' then$from$, $to$	if v_kind = 'project' then$to$, '');
	execute v;
end
$patch$;

-- 3. Functions rewritten whole.
create or replace function public.qorpera_organization_path_kind(p_path text)
returns text language plpgsql immutable set search_path = '' as $$
declare v_path text := public.qorpera_company_path_key(p_path);
begin
	if v_path = 'organization/formation.json' then return 'formation'; end if;
	if v_path ~ '^organization/projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return 'project'; end if;
	if v_path ~ '^organization/rooms/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$' then
		return 'room'; end if;
	return null;
end
$$;

create or replace function public.qorpera_company_path_principal_allowed(
	p_profile_id uuid, p_resource public.qorpera_company_path_resources, p_kind text, p_id uuid, p_permission text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role; v_project uuid; v_permissions text[];
begin
	if p_resource.id is null or p_resource.revoked_at is not null or p_permission not in ('read','write') then return false; end if;
	if p_resource.scope = 'responsibility_scoped' then
		-- Retired 2026-09-20. What was scoped to a responsibility is never widened:
		-- only an owner or admin reaches it, to move it somewhere that still has rules.
		return p_kind = 'member' and exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.user_id = p_id and member.role in ('owner','admin'));
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
			-- The accountable member of a sponsoring responsibility used to reach it too.
			select role into v_role from public.qorpera_profile_members
			where profile_id = p_profile_id and user_id = p_id;
			return coalesce(v_role in ('owner','admin'), false);
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

-- Open escalations no longer retain file objects; the layer below is unchanged.
create or replace function public.qorpera_company_pre_member_upload_retained_hashes(p_profile_id uuid)
returns table(object_sha256 text) language sql stable security definer set search_path = '' as $$
	select object_sha256 from public.qorpera_company_pre_escalation_retained_object_hashes(p_profile_id)
$$;

-- 3a. The read model keeps its shape: no responsibilities, every project company-scoped.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_company_organization_json(uuid)'::regprocedure);
	v_start integer := position($s$'responsibilities',coalesce((select jsonb_agg(jsonb_build_object($s$ in v_definition);
	v_end integer := position($e$		'projects',coalesce((select jsonb_agg(jsonb_build_object($e$ in v_definition);
begin
	if v_start = 0 or v_end <= v_start then raise exception 'Retiring responsibilities: organization read model differs'; end if;
	v_definition := left(v_definition, v_start - 1) || $n$'responsibilities','[]'::jsonb,
$n$ || substr(v_definition, v_end);
	if position($p$'definition_of_done',project.definition_of_done,'scope_kind',project.scope_kind,
			'sponsoring_responsibility_id',project.sponsoring_responsibility_id,$p$ in v_definition) = 0 then
		raise exception 'Retiring responsibilities: project read model differs'; end if;
	v_definition := replace(v_definition, $p$'definition_of_done',project.definition_of_done,'scope_kind',project.scope_kind,
			'sponsoring_responsibility_id',project.sponsoring_responsibility_id,$p$,
		$q$'definition_of_done',project.definition_of_done,'scope_kind','company',
			'sponsoring_responsibility_id',null,$q$);
	execute v_definition;
end
$$;

-- 4. Functions that existed only for responsibilities.
drop function public.qorpera_escalate_responsibility(jsonb, jsonb);
drop function public.qorpera_list_responsibility_escalations(uuid, jsonb, uuid, uuid, integer, bigint);
drop function public.qorpera_resolve_responsibility_escalation(uuid, jsonb, uuid, text, bigint);
drop function public.qorpera_escalation_recipient_allowed(jsonb, public.qorpera_responsibility_escalations);
drop function public.qorpera_current_escalation_responsibility(jsonb, uuid, bigint);
drop function public.qorpera_responsibility_resources_json(uuid);
drop function public.qorpera_company_bootstrap_responsibility_documents(uuid);

-- 5. The tables go. One statement, so their links to each other need no order.
alter table public.qorpera_company_projects
	drop constraint qorpera_company_projects_profile_id_sponsoring_responsibil_fkey;
drop table public.qorpera_responsibility_escalation_signals, public.qorpera_responsibility_escalations,
	public.qorpera_agent_responsibility_grants, public.qorpera_responsibility_external_operation_grants,
	public.qorpera_responsibility_path_resources, public.qorpera_responsibility_measure_sources,
	public.qorpera_responsibility_measures, public.qorpera_company_responsibilities;

-- 6. Nothing live may still name what is gone.
do $$
begin
	if exists (select 1 from pg_proc function_row where function_row.pronamespace = 'public'::regnamespace
		and function_row.prokind = 'f' and pg_get_functiondef(function_row.oid) ~
			'public\.qorpera_(company_responsibilities|responsibility_[a-z_]+|agent_responsibility_grants)') then
		raise exception 'A live function still names a retired responsibility table'; end if;
	if public.qorpera_organization_path_kind('organization/responsibilities/00000000-0000-4000-8000-000000000000.json') is not null then
		raise exception 'Responsibility documents are still organization documents'; end if;
end
$$;
