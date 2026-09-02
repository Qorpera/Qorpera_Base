-- Founder decision 2026-09-02 (contract 14.1, resource grants at creation):
-- a company's staff agents read shared company state by default. A staff agent
-- receives a read grant on the shared root resource of each Company File
-- environment of its company when it is created or reactivated (genesis, hire,
-- migration) and when such a root resource is created. Unrevoked defaults are
-- carried forward when the root resource version advances; a default an owner
-- revoked on the current version is not recreated. The grant is an ordinary
-- qorpera_company_path_grants row (origin 'default_agent_read'), attributed to
-- the company owner and revocable like any grant. Writes keep their own rules.
-- Existing companies are backfilled once here (Company41's agent could read
-- nothing before this: production canary, 2026-09-02).

alter table public.qorpera_company_path_grants
	add column origin text not null default 'explicit' check (origin in ('explicit','default_agent_read'));

create function public.qorpera_company_owner_user_id(p_profile_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select member.user_id from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.role = 'owner'
	order by member.user_id limit 1
$$;
revoke all on function public.qorpera_company_owner_user_id(uuid) from public, anon, authenticated;

-- Idempotent: inserts the missing default read grants for one staff agent (or
-- every active agent) on every unrevoked shared root resource of the company.
create function public.qorpera_ensure_default_agent_read_grants(p_profile_id uuid, p_staff_agent_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_inserted integer := 0; v_resource record; v_staff record;
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
			if not exists (
					select 1 from public.qorpera_company_path_grants as grant_row
					where grant_row.resource_id = v_resource.id and grant_row.resource_version = v_resource.version
						and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id
						and 'read' = any(grant_row.permissions) and grant_row.revoked_at is null
						and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp()))
				and not exists (
					-- An owner's revocation of the default on this version stands.
					select 1 from public.qorpera_company_path_grants as grant_row
					where grant_row.resource_id = v_resource.id and grant_row.resource_version = v_resource.version
						and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id
						and grant_row.origin = 'default_agent_read' and grant_row.revoked_at is not null) then
				insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
					permissions, expires_at, created_by_user_id, origin)
				values (v_resource.id, v_resource.version, 'staff_agent', v_staff.staff_agent_id,
					array['read']::text[], null, v_owner, 'default_agent_read');
				v_inserted := v_inserted + 1;
			end if;
		end loop;
	end loop;
	return v_inserted;
end
$$;
revoke all on function public.qorpera_ensure_default_agent_read_grants(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_ensure_default_agent_read_grants(uuid, uuid) to service_role;

create function public.qorpera_default_agent_read_on_staff()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.employment_status = 'active' and (tg_op = 'INSERT' or old.employment_status is distinct from 'active') then
		perform public.qorpera_ensure_default_agent_read_grants(new.profile_id, new.staff_agent_id);
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_default_agent_read_on_staff() from public, anon, authenticated, service_role;
create trigger qorpera_profile_staff_default_read
	after insert or update of employment_status on public.qorpera_profile_staff
	for each row execute function public.qorpera_default_agent_read_on_staff();

create function public.qorpera_default_agent_read_on_resource()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile uuid;
begin
	if new.path = '' and new.path_match = 'subtree' and new.scope = 'company_shared' and new.revoked_at is null then
		select environment.profile_id into v_profile from public.qorpera_company_environments as environment
		where environment.id = new.environment_id;
		if tg_op = 'UPDATE' and new.version is distinct from old.version then
			insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
				permissions, expires_at, created_by_user_id, origin)
			select new.id, new.version, 'staff_agent', grant_row.principal_id, array['read']::text[], null,
				grant_row.created_by_user_id, 'default_agent_read'
			from public.qorpera_company_path_grants as grant_row
			where grant_row.resource_id = new.id and grant_row.resource_version = old.version
				and grant_row.origin = 'default_agent_read' and grant_row.revoked_at is null
				and exists (select 1 from public.qorpera_profile_staff as staff where staff.profile_id = v_profile
					and staff.staff_agent_id = grant_row.principal_id and staff.employment_status = 'active');
		elsif tg_op = 'INSERT' and v_profile is not null then
			perform public.qorpera_ensure_default_agent_read_grants(v_profile, null);
		end if;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_default_agent_read_on_resource() from public, anon, authenticated, service_role;
create trigger qorpera_company_path_resources_default_read
	after insert or update of version on public.qorpera_company_path_resources
	for each row execute function public.qorpera_default_agent_read_on_resource();

-- One-time backfill for companies that already have a shared root resource.
do $$
declare v_profile uuid; v_total integer := 0;
begin
	for v_profile in
		select distinct environment.profile_id from public.qorpera_company_path_resources as resource
		join public.qorpera_company_environments as environment on environment.id = resource.environment_id
		where resource.path = '' and resource.path_match = 'subtree' and resource.scope = 'company_shared'
			and resource.revoked_at is null
	loop
		v_total := v_total + public.qorpera_ensure_default_agent_read_grants(v_profile, null);
	end loop;
	raise notice 'default agent read grants backfilled: %', v_total;
end
$$;
