-- Ordinary company work must produce durable files. The historical default
-- granted only read, so new agents could never save reports without an owner
-- manually granting write. Keep the existing grant origin/helper names so
-- revocations and all creation/reactivation callers retain their identities.
-- Explicit grants, child resources and protected-path approval are unchanged.
create or replace function public.qorpera_ensure_default_agent_read_grants(p_profile_id uuid, p_staff_agent_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_inserted integer := 0; v_recovered integer; v_resource record; v_staff record;
begin
	v_owner := public.qorpera_company_owner_user_id(p_profile_id);
	if v_owner is null then return 0; end if;
	for v_resource in
		select resource.id, resource.version from public.qorpera_company_path_resources as resource
		join public.qorpera_company_environments as environment on environment.id = resource.environment_id
		where environment.profile_id = p_profile_id and resource.path = '' and resource.path_match = 'subtree'
			and resource.scope = 'company_shared' and resource.revoked_at is null
	loop
		for v_staff in
			select staff.staff_agent_id from public.qorpera_profile_staff as staff
			where staff.profile_id = p_profile_id and staff.employment_status = 'active'
				and (p_staff_agent_id is null or staff.staff_agent_id = p_staff_agent_id)
		loop
			-- Upgrade only live platform defaults, including a returning agent's
			-- old default. Never widen an explicit read-only grant.
			update public.qorpera_company_path_grants as grant_row
			set permissions = array['read','write']::text[]
			where grant_row.resource_id = v_resource.id and grant_row.resource_version = v_resource.version
				and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id
				and grant_row.origin = 'default_agent_read' and grant_row.revoked_at is null
				and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
				and grant_row.permissions = array['read']::text[];
			-- The old rollover trigger omitted defaults while staff were archived.
			-- Recover only wholly valid platform-default history, with no current
			-- grant or owner restriction. Keep its earliest expiry and attribution;
			-- an older valid row must never revive a later revoked/expired grant.
			insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
				permissions, expires_at, created_at, created_by_user_id, origin)
			select v_resource.id, v_resource.version, 'staff_agent', v_staff.staff_agent_id,
				array['read','write']::text[], history.expires_at, history.created_at, history.created_by_user_id, 'default_agent_read'
			from public.qorpera_company_path_grants as history
			where history.resource_id = v_resource.id and history.principal_kind = 'staff_agent'
				and history.principal_id = v_staff.staff_agent_id and history.origin = 'default_agent_read'
				and not exists (
					select 1 from public.qorpera_company_path_grants as current_grant
					where current_grant.resource_id = v_resource.id and current_grant.resource_version = v_resource.version
						and current_grant.principal_kind = 'staff_agent' and current_grant.principal_id = v_staff.staff_agent_id)
				and not exists (
					select 1 from public.qorpera_company_path_grants as restriction
					where restriction.resource_id = v_resource.id and restriction.principal_kind = 'staff_agent'
						and restriction.principal_id = v_staff.staff_agent_id
						and (restriction.origin <> 'default_agent_read' or restriction.revoked_at is not null
							or restriction.expires_at <= clock_timestamp()))
			order by history.expires_at nulls last, history.created_at, history.id limit 1;
			get diagnostics v_recovered = row_count;
			v_inserted := v_inserted + v_recovered;
			if not exists (
				select 1 from public.qorpera_company_path_grants as grant_row
				where grant_row.resource_id = v_resource.id and grant_row.resource_version = v_resource.version
					and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id
					and 'read' = any(grant_row.permissions) and grant_row.revoked_at is null
					and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp()))
			and not exists (
				-- Prior access is not a missing default. Preserve explicit access
				-- decisions as well as defaults omitted by older rollover triggers,
				-- including expired and revoked grants at historical versions.
				select 1 from public.qorpera_company_path_grants as grant_row
				where grant_row.resource_id = v_resource.id
					and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id) then
				insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
					permissions, expires_at, created_by_user_id, origin)
				values (v_resource.id, v_resource.version, 'staff_agent', v_staff.staff_agent_id,
					array['read','write']::text[], null, v_owner, 'default_agent_read');
				v_inserted := v_inserted + 1;
			end if;
		end loop;
	end loop;
	return v_inserted;
end
$$;

create or replace function public.qorpera_default_agent_read_on_resource()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile uuid;
begin
	if new.path = '' and new.path_match = 'subtree' and new.scope = 'company_shared' and new.revoked_at is null then
		select environment.profile_id into v_profile from public.qorpera_company_environments as environment
		where environment.id = new.environment_id;
		if tg_op = 'UPDATE' and new.version is distinct from old.version then
			-- Preserve the complete grant, including expiry and revocation, so a
			-- later reactivation cannot recreate access an owner withdrew.
			insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
				permissions, expires_at, revoked_at, created_at, created_by_user_id, origin)
			select new.id, new.version, 'staff_agent', grant_row.principal_id, grant_row.permissions,
				grant_row.expires_at, grant_row.revoked_at, grant_row.created_at, grant_row.created_by_user_id, 'default_agent_read'
			from public.qorpera_company_path_grants as grant_row
			where grant_row.resource_id = new.id and grant_row.resource_version = old.version
				and grant_row.origin = 'default_agent_read'
				and exists (select 1 from public.qorpera_profile_staff as staff where staff.profile_id = v_profile
					and staff.staff_agent_id = grant_row.principal_id);
		elsif tg_op = 'INSERT' and v_profile is not null then
			perform public.qorpera_ensure_default_agent_read_grants(v_profile, null);
		end if;
	end if;
	return new;
end
$$;

-- Existing agents receive the same usable default as newly created agents.
-- The helper excludes revoked resources, inactive staff and expired grants.
do $$
declare v_profile uuid;
begin
	for v_profile in
		select distinct environment.profile_id from public.qorpera_company_path_resources as resource
		join public.qorpera_company_environments as environment on environment.id = resource.environment_id
		where resource.path = '' and resource.path_match = 'subtree' and resource.scope = 'company_shared'
			and resource.revoked_at is null
	loop
		perform public.qorpera_ensure_default_agent_read_grants(v_profile, null);
	end loop;
end
$$;
