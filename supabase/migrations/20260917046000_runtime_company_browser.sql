-- 2026-09-17 amendment: the company browser.
--
-- A browser profile was a member's property, prepared through a private
-- sign-in and lent to one agent; without such a grant an agent had no browser.
-- The product decision is company first: agents are the workers, members
-- review through them, and nobody keeps a private browser on the Company
-- Computer. Every agent with computer access now has a company-owned browser
-- profile and an active grant from the start (new access rows and a backfill).
-- Chrome locks a profile to one running browser, so each agent keeps its own
-- profile directory; the office service keeps their sign-ins in step (the
-- company's one set of logins, runtime amendment of the same date).
-- A company-owned profile does not depend on any member's membership.

alter table public.qorpera_runtime_browser_profiles
	add column company_owned boolean not null default false;

create function public.qorpera_ensure_runtime_company_browser(p_office_id uuid, p_staff_agent_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_owner uuid; v_access record; v_profile uuid; v_count integer := 0;
begin
	select * into v_office from public.qorpera_runtime_offices where id = p_office_id;
	if not found or v_office.state = 'retired' then return 0; end if;
	select member.user_id into v_owner from public.qorpera_profile_members member
		where member.profile_id = v_office.profile_id and member.role = 'owner'
		order by member.joined_at, member.user_id limit 1;
	if v_owner is null then return 0; end if;
	for v_access in
		select access.staff_agent_id from public.qorpera_runtime_office_access access
		where access.office_id = v_office.id and access.state = 'active'
			and (p_staff_agent_id is null or access.staff_agent_id = p_staff_agent_id)
			and not exists(select 1 from public.qorpera_runtime_browser_grants existing
				where existing.office_id = v_office.id and existing.staff_agent_id = access.staff_agent_id and existing.state = 'active')
	loop
		v_profile := extensions.gen_random_uuid();
		insert into public.qorpera_runtime_browser_profiles(id, office_id, owner_user_id, version, prepared, verified_version, company_owned)
			values(v_profile, v_office.id, v_owner, 1, true, 1, true);
		insert into public.qorpera_runtime_browser_grants(profile_id, office_id, staff_agent_id, profile_version, owner_membership_version, state)
			values(v_profile, v_office.id, v_access.staff_agent_id, 1, 0, 'active');
		v_count := v_count + 1;
	end loop;
	if v_count > 0 then update public.qorpera_runtime_offices set revision = revision + 1 where id = v_office.id; end if;
	return v_count;
end
$$;
revoke all on function public.qorpera_ensure_runtime_company_browser(uuid, uuid) from public, anon, authenticated, service_role;

create function public.qorpera_runtime_company_browser_for_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.state = 'active' then perform public.qorpera_ensure_runtime_company_browser(new.office_id, new.staff_agent_id); end if;
	return null;
end
$$;
revoke all on function public.qorpera_runtime_company_browser_for_access() from public, anon, authenticated, service_role;
create trigger qorpera_runtime_company_browser_for_access
	after insert or update of state on public.qorpera_runtime_office_access
	for each row execute function public.qorpera_runtime_company_browser_for_access();

do $patch$
declare v_def text; v_pairs text[][] := array[
	['join public.qorpera_profile_members m on', 'left join public.qorpera_profile_members m on'],
	['and g.owner_membership_version=coalesce((select version from public.qorpera_runtime_browser_membership_revocations where profile_id=v_office.profile_id and user_id=p.owner_user_id),0)',
	 'and (p.company_owned or (m.user_id is not null and g.owner_membership_version=coalesce((select version from public.qorpera_runtime_browser_membership_revocations where profile_id=v_office.profile_id and user_id=p.owner_user_id),0)))'],
	['for share of g,p,m;', 'for share of g,p;']];
	v_pair text[];
begin
	v_def := pg_get_functiondef('public.qorpera_native_office_descriptor(jsonb)'::regprocedure);
	foreach v_pair slice 1 in array v_pairs loop
		if (length(v_def) - length(replace(v_def, v_pair[1], ''))) / length(v_pair[1]) <> 1 then
			raise exception 'office descriptor body differs: %', left(v_pair[1], 40); end if;
		v_def := replace(v_def, v_pair[1], v_pair[2]);
	end loop;
	execute v_def;
end
$patch$;

select public.qorpera_ensure_runtime_company_browser(office.id) from public.qorpera_runtime_offices office where office.state <> 'retired';
