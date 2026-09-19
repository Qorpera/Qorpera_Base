-- Contract 14.1: "Authorized agents may create coworkers with startup
-- instructions through the same cloud operation. The creating agent cannot
-- grant authority it does not possess." 14.2: the Co-Founder can hire and
-- retire agents.
--
-- The projection already accepts an agent actor and enforces the delegation
-- rule. What stopped an agent was one step earlier: a staff agent reads the
-- shared Company File by default but holds no write permission, so the path
-- kernel refused the agent document before it could become a proposal.
--
-- An agent document path is always protected (20260828019600): a write there
-- is a proposal that changes nothing until an authorized member approves it.
-- Proposing is therefore safe to allow:
--   * any active agent may propose a NEW coworker;
--   * only the company Co-Founder may propose a change to an existing agent
--     (retire, restore, revise);
--   * the requesting member must hold write on the path, as for any write.
alter function public.qorpera_company_path_allowed(jsonb, text, text)
	rename to qorpera_company_path_allowed_before_hiring;

create function public.qorpera_company_path_allowed(p_actor jsonb, p_path text, p_permission text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid := (p_actor ->> 'companyId')::uuid; v_environment uuid := (p_actor ->> 'environmentId')::uuid;
	v_staff uuid := nullif(p_actor ->> 'staffAgentId','')::uuid;
	v_resource public.qorpera_company_path_resources%rowtype;
begin
	if public.qorpera_company_path_allowed_before_hiring(p_actor, p_path, p_permission) then return true; end if;
	if p_permission is distinct from 'write' or p_actor ->> 'audience' is distinct from 'company' or v_staff is null
		or public.qorpera_company_agent_path_id(p_path) is null then return false; end if;
	v_resource := public.qorpera_company_path_resource(v_environment, p_path);
	return v_resource.scope <> 'member_private'
		and public.qorpera_company_path_principal_allowed(v_profile, v_resource, 'member', (p_actor ->> 'userId')::uuid, 'write')
		and public.qorpera_company_path_principal_allowed(v_profile, v_resource, 'staff_agent', v_staff, 'read')
		and exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = v_profile and staff.staff_agent_id = v_staff
				and staff.employment_status = 'active' and staff.deleted_at is null)
		and (not exists (select 1 from public.qorpera_company_path_entries entry
				where entry.environment_id = v_environment
					and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path),'sha256'))
			or exists (select 1 from public.qorpera_company_cofounders cofounder
				where cofounder.profile_id = v_profile and cofounder.staff_agent_id = v_staff));
end
$$;
revoke all on function public.qorpera_company_path_allowed(jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_path_allowed_before_hiring(jsonb, text, text)
	from public, anon, authenticated, service_role;

-- The rule above is only safe while an agent document can never be applied
-- directly. Fail the migration if that ever stops being true.
do $$
begin
	if not public.qorpera_company_path_protected(null::public.qorpera_company_path_resources,
		jsonb_build_object('path','organization/agents/00000000-0000-4000-8000-000000000000.json','entry',jsonb_build_object('kind','file'))) then
		raise exception 'Agent documents are not proposal-gated; agent hiring must not be enabled';
	end if;
end
$$;

-- No function here is callable by default: PostgreSQL grants EXECUTE to PUBLIC on creation, and the secret
-- broker must keep exactly its three custody calls (306_governed_company_computer_privileges).
revoke all on function public.qorpera_company_path_allowed(jsonb, text, text) from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_company_path_allowed_before_hiring(jsonb, text, text) from public, anon, authenticated, qorpera_secret_broker;
