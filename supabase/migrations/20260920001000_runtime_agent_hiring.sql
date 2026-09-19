-- Contract 14.1: "Authorized agents may create coworkers with startup
-- instructions through the same cloud operation. The creating agent cannot
-- grant authority it does not possess." 14.2: the Co-Founder can hire and
-- retire agents. 14.7: agents create rooms when the work needs them.
--
-- Founder decision 2026-09-20: hiring a coworker and opening a group chat need
-- no member approval. Both are organization documents, and an organization
-- document only becomes an agent or a room through the approval lane, where the
-- projection runs. So the lane stays and the approval is given by policy: the
-- run that proposed a NEW agent or a NEW room approves it in the name of the
-- requesting member when that member may approve, else of the company owner,
-- and applies it at once. Everything else about the lane is unchanged: the
-- governed write, the receipt, the projection that creates the agent with its
-- default read grant and single first-run wake, and the rule that a creator
-- cannot delegate authority it lacks.
--
-- What stays gated: a change to an existing agent or room (only the Co-Founder
-- may propose one, and a member approves it), and every other protected path.
-- Limits per run: three hires, five rooms.
alter function public.qorpera_company_path_allowed(jsonb, text, text)
	rename to qorpera_company_path_allowed_before_hiring;

-- 'agent' | 'room' for a canonical organization document an agent may create, 'directory' for their folders.
create function public.qorpera_agent_creatable_path_kind(p_path text)
returns text language sql immutable set search_path = '' as $$
	select case
		when public.qorpera_company_agent_path_id(p_path) is not null then 'agent'
		when public.qorpera_organization_path_kind(p_path) = 'room' then 'room'
		when public.qorpera_company_path_key(p_path) in ('organization','organization/agents','organization/rooms') then 'directory'
	end
$$;

create function public.qorpera_company_path_allowed(p_actor jsonb, p_path text, p_permission text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid := (p_actor ->> 'companyId')::uuid; v_environment uuid := (p_actor ->> 'environmentId')::uuid;
	v_staff uuid := nullif(p_actor ->> 'staffAgentId','')::uuid; v_kind text;
	v_resource public.qorpera_company_path_resources%rowtype; v_exists boolean;
begin
	if public.qorpera_company_path_allowed_before_hiring(p_actor, p_path, p_permission) then return true; end if;
	v_kind := public.qorpera_agent_creatable_path_kind(p_path);
	if p_permission is distinct from 'write' or p_actor ->> 'audience' is distinct from 'company' or v_staff is null
		or v_kind is null then return false; end if;
	v_resource := public.qorpera_company_path_resource(v_environment, p_path);
	v_exists := exists (select 1 from public.qorpera_company_path_entries entry
		where entry.environment_id = v_environment
			and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path),'sha256'));
	return v_resource.scope <> 'member_private'
		and public.qorpera_company_path_principal_allowed(v_profile, v_resource, 'member', (p_actor ->> 'userId')::uuid, 'write')
		and public.qorpera_company_path_principal_allowed(v_profile, v_resource, 'staff_agent', v_staff, 'read')
		and exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = v_profile and staff.staff_agent_id = v_staff
				and staff.employment_status = 'active' and staff.deleted_at is null)
		-- The publisher re-checks authority after it has written the entry, so a folder stays allowed once
		-- it exists. Creating one is harmless, and deleting anything is always proposal-gated.
		and (v_kind = 'directory' or not v_exists or exists (select 1 from public.qorpera_company_cofounders cofounder
				where cofounder.profile_id = v_profile and cofounder.staff_agent_id = v_staff));
end
$$;

-- The approval lane re-checks that the proposing agent may still write the
-- path. Use the same rule the proposal was admitted under, so a document an
-- agent may create with the default read grant can also be applied.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_company_path_approved_actor(uuid,text)'::regprocedure);
	v_old text := $old$or not public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'staff_agent',v_run.staff_agent_id,'write') then$old$;
	v_new text := $new$or not (public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'staff_agent',v_run.staff_agent_id,'write')
			or public.qorpera_company_path_allowed(jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
				'userId',v_run.requested_by_user_id,'staffAgentId',v_run.staff_agent_id,'audience',v_run.audience_kind),
				v_proposal.plan ->> 'path','write')) then$new$;
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Approved-actor source authority clause differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

-- Approval by policy for a document this run just proposed.
create function public.qorpera_self_approve_organization_proposal(p_binding jsonb, p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_proposal public.qorpera_company_path_proposals%rowtype;
	v_kind text; v_approver uuid; v_role public.qorpera_profile_role; v_limit integer;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id for update;
	v_kind := public.qorpera_agent_creatable_path_kind(v_proposal.plan ->> 'path');
	if not found or v_proposal.run_id is distinct from v_run.id or v_run.audience_kind <> 'company'
		or v_kind is null or v_kind = 'directory' or v_proposal.plan -> 'expectedVersion' <> 'null'::jsonb
		or v_proposal.plan -> 'entry' = 'null'::jsonb
		or exists (select 1 from public.qorpera_company_path_entries entry
			where entry.environment_id = v_proposal.environment_id
				and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(v_proposal.plan ->> 'path'),'sha256')) then
		raise exception 'Only a new agent or room proposed by this run is approved by policy' using errcode = '42501'; end if;
	if v_proposal.status in ('approved','applied') then
		return jsonb_build_object('proposalId', v_proposal.id, 'planSha256', v_proposal.plan_sha256, 'state', v_proposal.status); end if;
	if v_proposal.status <> 'open' then
		raise exception 'Organization proposal is closed' using errcode = '55000'; end if;
	v_limit := case v_kind when 'agent' then 3 else 5 end;
	if (select count(*) from public.qorpera_company_path_proposals other
		where other.run_id = v_run.id and other.id <> v_proposal.id and other.status in ('approved','applied')
			and public.qorpera_agent_creatable_path_kind(other.plan ->> 'path') = v_kind) >= v_limit then
		raise exception 'This run reached its limit for new %s', v_kind || 's' using errcode = '54000'; end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id;
	v_approver := case when v_role in ('owner','admin') then v_run.requested_by_user_id
		else public.qorpera_company_owner_user_id(v_run.profile_id) end;
	if v_approver is null then
		raise exception 'Organization approval authority is unavailable' using errcode = '42501'; end if;
	update public.qorpera_company_path_proposals set status = 'approved', approved_by_user_id = v_approver,
		approval_expires_at = clock_timestamp() + interval '10 minutes' where id = v_proposal.id;
	return jsonb_build_object('proposalId', v_proposal.id, 'planSha256', v_proposal.plan_sha256, 'state', 'approved');
end
$$;
grant execute on function public.qorpera_self_approve_organization_proposal(jsonb, uuid) to service_role;

-- The rules above are only safe while these documents can never be applied
-- outside the approval lane. Fail the migration if that ever stops being true.
do $$
begin
	if not public.qorpera_company_path_protected(null::public.qorpera_company_path_resources,
		jsonb_build_object('path','organization/agents/00000000-0000-4000-8000-000000000000.json','entry',jsonb_build_object('kind','file')))
		or not public.qorpera_company_path_protected(null::public.qorpera_company_path_resources,
		jsonb_build_object('path','organization/rooms/00000000-0000-4000-8000-000000000000.json','entry',jsonb_build_object('kind','file'))) then
		raise exception 'Agent or room documents are not proposal-gated; agent creation must not be enabled';
	end if;
end
$$;

-- No function here is callable by default (306_governed_company_computer_privileges).
revoke all on function public.qorpera_company_path_allowed(jsonb, text, text) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_company_path_allowed_before_hiring(jsonb, text, text) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_agent_creatable_path_kind(text) from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_self_approve_organization_proposal(jsonb, uuid) from public, anon, authenticated, qorpera_secret_broker;
