-- Agent skills (contract 15.2). Two libraries, both ordinary Company File objects:
-- the company library skills/<name>/SKILL.md, governed by the usual path authority
-- (the default agent grant writes it, a protected path proposes), and an agent's
-- own library agents/<staffAgentId>/skills/<name>/SKILL.md.
--
-- 1. An agent writes its own skill library, and the folders on the way to it, as
--    it writes its memory notebook (20260924020000): never another agent's
--    library and nothing else under agents/<staffAgentId>/. A worker writes its
--    agent's library only when its dispatch allows Company File writes (the
--    runtime offers it update_skill only then).
-- 2. The runtime observes read_skill, search_skills and update_skill under their
--    own names. Patched into the live definition, not re-stated, so names other
--    migrations added stay. CREATE OR REPLACE keeps the ACL. Record this migration
--    BEFORE activating the bundle that observes them, or their observations are
--    rejected (22023) and dropped.
alter function public.qorpera_company_path_allowed(jsonb, text, text)
	rename to qorpera_company_path_allowed_before_skills;
create function public.qorpera_company_path_allowed(p_actor jsonb, p_path text, p_permission text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid := (p_actor ->> 'companyId')::uuid; v_staff uuid := nullif(p_actor ->> 'staffAgentId','')::uuid;
	v_run uuid := nullif(p_actor ->> 'runId','')::uuid; v_worker public.qorpera_runtime_workers%rowtype;
	v_key text; v_root text; v_resource public.qorpera_company_path_resources%rowtype;
begin
	if public.qorpera_company_path_allowed_before_skills(p_actor, p_path, p_permission) then return true; end if;
	if p_permission is distinct from 'write' or p_actor ->> 'audience' is distinct from 'company'
		or v_staff is null then return false; end if;
	if v_run is not null then
		v_worker := public.qorpera_run_worker(v_run);
		if v_worker.id is not null and (v_worker.access is distinct from 'write'
			or v_worker.staff_agent_id is distinct from v_staff) then return false; end if;
	end if;
	v_key := public.qorpera_company_path_key(p_path);
	v_root := 'agents/' || v_staff::text || '/skills';
	if v_key not in ('agents', 'agents/' || v_staff::text, v_root)
		and left(v_key, length(v_root) + 1) <> v_root || '/' then return false; end if;
	v_resource := public.qorpera_company_path_resource((p_actor ->> 'environmentId')::uuid, p_path);
	return v_resource.scope <> 'member_private' and v_resource.policy <> 'protected'
		and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = v_profile
			and staff.staff_agent_id = v_staff and staff.employment_status = 'active' and staff.deleted_at is null);
end
$$;

revoke all on function public.qorpera_company_path_allowed(jsonb, text, text),
	public.qorpera_company_path_allowed_before_skills(jsonb, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The kernel functions that call the path check keep their owners; those owners call the new one.
do $$ declare v_owner name; begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_company_path_allowed_before_skills(jsonb, text, text)'::regprocedure,
		'public.qorpera_company_path_require(jsonb, text, text)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Skill path function has an API owner'; end if;
		execute format('grant execute on function public.qorpera_company_path_allowed(jsonb, text, text) to %I', v_owner);
	end loop;
end $$;

create function pg_temp.agent_skills_replace(p_definition text, p_old text, p_new text)
returns text language plpgsql as $$
begin
	if p_old = '' or (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Runtime observation vocabulary differs: %', left(p_old, 80); end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $migration$
declare
	v_definition text := pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.agent_skills_replace(v_definition,
		$old$'update_memory','recall_memory',$old$,
		$new$'update_memory','recall_memory','read_skill','search_skills','update_skill',$new$);
	execute v_definition;
end
$migration$;
