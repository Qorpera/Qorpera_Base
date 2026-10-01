-- Company state files, thin writers W4a: contract 14.1's restricted hire on folder-v2 companies
-- (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5 "Built (W4a)"; RUNTIME-COMPANY-FOLDER-C2.md §1, §2).
--
-- "Automatic hiring MUST verify that the creator can delegate the child's entire default: current, nonexpiring
-- read/write authority on every live shared root in the company. ... Restricted creators may propose hires for an
-- authorized member to approve." The legacy hire checks this at self-approval and before it applies
-- (qorpera_assert_agent_default_delegation, 20260926035000). On folder-v2 the hire is hire_agent's new agent folder,
-- and the roster triggers give the new agent the default grants. So, for folder-v2 runs:
-- * the automatic review's layering asks for such a hire, whatever the reviewer found (unless it denied it). The
--   owners and admins answer it on a card, and no rule lifts it;
-- * the review recorder checks again before the save, and records such a hire only from a member's answer.
-- Inert until a folder-v2 run has folder bytes. Snapshot-v1 hires are unchanged.

-- The legacy predicate as a plain read: an active agent holding, at each live shared root of the company, a current
-- nonexpiring read and write grant.
create function public.qorpera_folder_agent_delegates_default(p_profile_id uuid, p_staff_agent_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active')
		and not exists (
			select 1 from public.qorpera_company_path_resources resource
			join public.qorpera_company_environments environment on environment.id = resource.environment_id
			where environment.profile_id = p_profile_id and resource.path = '' and resource.path_match = 'subtree'
				and resource.scope = 'company_shared' and resource.revoked_at is null
				and not exists (select 1 from public.qorpera_company_path_grants grant_row
					where grant_row.resource_id = resource.id and grant_row.resource_version = resource.version
						and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = p_staff_agent_id
						and grant_row.permissions = array['read','write']::text[]
						and grant_row.revoked_at is null and grant_row.expires_at is null))
$$;
revoke all on function public.qorpera_folder_agent_delegates_default(uuid, uuid)
	from public, anon, authenticated, service_role;

create function pg_temp.w4a_restricted_hire_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'W4a restricted hire anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The layering: after the rules and the built-in checks, before a denied call's retry and the approver's scope.
select pg_temp.w4a_restricted_hire_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$	v_retry boolean; v_company_before boolean;$old$,
	$new$	v_retry boolean; v_company_before boolean; v_restricted boolean := false;$new$);
select pg_temp.w4a_restricted_hire_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$	-- The same call denied earlier in this conversation, tried again after a member wrote$old$,
	$new$	-- On a folder-v2 company, a hire by an agent that cannot delegate the new agent's default Company File access
	-- waits for a member (contract 14.1): it asks the owners and admins, as an access check no rule lifts.
	if p_review ->> 'tool' = 'hire_agent' and v_decision <> 'deny'
		and public.qorpera_environment_is_folder_v2(v_run.environment_id)
		and not public.qorpera_folder_agent_delegates_default(v_run.profile_id, v_run.staff_agent_id) then
		v_restricted := true; v_decision := 'ask'; v_built_in := 'access_change';
	end if;
	-- The same call denied earlier in this conversation, tried again after a member wrote$new$);
select pg_temp.w4a_restricted_hire_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$	v_always := v_decision = 'ask' and v_built_in in$old$,
	$new$	v_always := v_decision = 'ask' and not v_restricted and v_built_in in$new$);

-- The recorder: again before the save ("both at policy approval and before publication"), only a member's answer.
select pg_temp.w4a_restricted_hire_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$	-- A card's allow keeps the member who gave it,$old$,
	$new$	-- A hire by an agent that cannot delegate the new agent's default access stands only on a member's answer
	-- (contract 14.1), checked again now.
	if v_action.tool_name = 'hire_agent' and v_action.answer is null
		and not public.qorpera_folder_agent_delegates_default(v_run.profile_id, v_run.staff_agent_id) then
		raise exception 'This hire needs a member''s approval: the hiring agent cannot give the new agent its default access'
			using errcode = '42501'; end if;
	-- A card's allow keeps the member who gave it,$new$);
