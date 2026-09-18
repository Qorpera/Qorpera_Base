-- 2026-09-17 amendment: every agent has the Company Computer.
--
-- Access to the Company Computer was a per-agent grant an owner or admin had
-- to configure, so a new agent could not use (or be shown on) the computer
-- until somebody found that setting. The product decision is that the
-- computer is a given: each active agent of a company has desktop and shell
-- access to the company's computers by default. The grant table and its
-- versions stay (runs and leases bind to a grant version); the default is
-- recorded in the name of the company's owner of record. A grant somebody
-- revoked on purpose is left revoked.

create function public.qorpera_ensure_runtime_office_default_access(p_office_id uuid, p_staff_agent_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_owner uuid; v_count integer;
begin
	select * into v_office from public.qorpera_runtime_offices where id = p_office_id;
	if not found or v_office.state = 'retired' then return 0; end if;
	select member.user_id into v_owner from public.qorpera_profile_members member
		where member.profile_id = v_office.profile_id and member.role = 'owner'
		order by member.joined_at, member.user_id limit 1;
	if v_owner is null then return 0; end if;
	insert into public.qorpera_runtime_office_access(office_id, staff_agent_id, profile_id, state, capabilities, configured_by_user_id)
	select v_office.id, staff.staff_agent_id, staff.profile_id, 'active', '["desktop", "shell"]'::jsonb, v_owner
	from public.qorpera_profile_staff staff
	where staff.profile_id = v_office.profile_id and staff.employment_status = 'active' and staff.deleted_at is null
		and (p_staff_agent_id is null or staff.staff_agent_id = p_staff_agent_id)
		and not exists(select 1 from public.qorpera_runtime_office_access existing
			where existing.office_id = v_office.id and existing.staff_agent_id = staff.staff_agent_id);
	get diagnostics v_count = row_count;
	return v_count;
end
$$;
revoke all on function public.qorpera_ensure_runtime_office_default_access(uuid, uuid) from public, anon, authenticated, service_role;

create function public.qorpera_runtime_office_default_access_for_staff()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_office uuid;
begin
	if new.employment_status = 'active' and new.deleted_at is null then
		for v_office in select id from public.qorpera_runtime_offices where profile_id = new.profile_id and state <> 'retired' loop
			perform public.qorpera_ensure_runtime_office_default_access(v_office, new.staff_agent_id);
		end loop;
	end if;
	return null;
end
$$;
revoke all on function public.qorpera_runtime_office_default_access_for_staff() from public, anon, authenticated, service_role;
create trigger qorpera_profile_staff_default_office_access
	after insert or update of employment_status, deleted_at on public.qorpera_profile_staff
	for each row execute function public.qorpera_runtime_office_default_access_for_staff();

create function public.qorpera_runtime_office_default_access_for_office()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_ensure_runtime_office_default_access(new.id);
	return null;
end
$$;
revoke all on function public.qorpera_runtime_office_default_access_for_office() from public, anon, authenticated, service_role;
create trigger qorpera_runtime_office_default_access
	after insert on public.qorpera_runtime_offices
	for each row execute function public.qorpera_runtime_office_default_access_for_office();

select public.qorpera_ensure_runtime_office_default_access(office.id) from public.qorpera_runtime_offices office where office.state <> 'retired';
