-- Default staff execution authority at hire (23 Sep 2026).
--
-- A staff member can only be woken by a coworker message, a routine or a held
-- delivery when qorpera_staff_execution_authorities names a sponsor for it;
-- qorpera_send_coworker_message answers `authority_unavailable` otherwise.
-- The only writer of that table was qorpera_configure_staff_execution_authority,
-- which no client or hiring path calls, so every agent hired through the web
-- client was born without messaging authority (found on 2026-09-23 in company
-- Qorpera: six agents, none reachable by a coworker until rows were configured
-- by hand).
--
-- The default is the same authority the manual entry point would accept for a
-- native-subscription sponsor: the company's newest active autonomous sponsor
-- whose connection is an active native subscription owned by a member (or a
-- company sponsor), matching the agent's model provider when one is projected.
-- It is granted when an agent becomes active and when such a sponsor appears,
-- and only where no authority exists; a configured authority is never replaced.

create function public.qorpera_default_staff_execution_sponsor(p_profile_id uuid, p_model_provider text)
returns table (binding_id uuid, sponsor_version bigint, created_by_user_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
	select sponsor.binding_id, sponsor.version, sponsor.created_by_user_id
	from public.qorpera_execution_sponsor_bindings as binding
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = binding.id
		and sponsor.version = (
			select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
			where latest.binding_id = binding.id
		)
	join public.qorpera_provider_connections as connection
		on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as connection_version
		on connection_version.connection_id = connection.id
		and connection_version.version = sponsor.provider_connection_version
	where binding.profile_id = p_profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and connection.profile_id = p_profile_id and connection.status = 'active'
		and connection_version.authentication_mode = 'native_subscription'
		and connection_version.authorization_state = 'active'
		and (p_model_provider is null or connection.provider = p_model_provider)
		and (
			sponsor.sponsor_kind <> 'member_connection'
			or exists (
				select 1 from public.qorpera_profile_members as member
				where member.profile_id = p_profile_id and member.user_id = connection.owner_user_id
			)
		)
	order by sponsor.created_at desc, sponsor.binding_id
	limit 1
$$;
revoke all on function public.qorpera_default_staff_execution_sponsor(uuid, text) from public, anon, authenticated;

-- Idempotent: inserts the missing default authority for one active staff agent
-- (or every active agent) of a company. Returns the number of rows inserted.
create function public.qorpera_ensure_default_staff_execution_authorities(p_profile_id uuid, p_staff_agent_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_inserted integer := 0;
	v_staff record;
	v_sponsor record;
begin
	for v_staff in
		select staff.staff_agent_id, staff.model_provider
		from public.qorpera_profile_staff as staff
		where staff.profile_id = p_profile_id and staff.employment_status = 'active'
			and (p_staff_agent_id is null or staff.staff_agent_id = p_staff_agent_id)
			and not exists (
				select 1 from public.qorpera_staff_execution_authorities as authority
				where authority.profile_id = p_profile_id and authority.staff_agent_id = staff.staff_agent_id
			)
		order by staff.staff_agent_id
	loop
		select * into v_sponsor
		from public.qorpera_default_staff_execution_sponsor(p_profile_id, v_staff.model_provider);
		if v_sponsor.binding_id is null then continue; end if;
		insert into public.qorpera_staff_execution_authorities (
			profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
			logical_computer_id, configured_by_user_id
		) values (
			p_profile_id, v_staff.staff_agent_id, v_sponsor.binding_id, v_sponsor.sponsor_version,
			null, v_sponsor.created_by_user_id
		)
		on conflict (profile_id, staff_agent_id) do nothing;
		if found then v_inserted := v_inserted + 1; end if;
	end loop;
	return v_inserted;
end
$$;
revoke all on function public.qorpera_ensure_default_staff_execution_authorities(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_ensure_default_staff_execution_authorities(uuid, uuid) to service_role;

create function public.qorpera_default_staff_execution_authority_on_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.employment_status = 'active' then
		perform public.qorpera_ensure_default_staff_execution_authorities(new.profile_id, new.staff_agent_id);
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_default_staff_execution_authority_on_staff() from public, anon, authenticated, service_role;
create trigger qorpera_profile_staff_default_execution_authority
	after insert or update of employment_status, model_provider on public.qorpera_profile_staff
	for each row execute function public.qorpera_default_staff_execution_authority_on_staff();

-- A member connecting an autonomous native account later grants the company's
-- agents that still have no authority.
create function public.qorpera_default_staff_execution_authority_on_sponsor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_profile uuid;
begin
	if new.allow_autonomous then
		select binding.profile_id into v_profile
		from public.qorpera_execution_sponsor_bindings as binding where binding.id = new.binding_id;
		if v_profile is not null then
			perform public.qorpera_ensure_default_staff_execution_authorities(v_profile, null);
		end if;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_default_staff_execution_authority_on_sponsor() from public, anon, authenticated, service_role;
create trigger qorpera_execution_sponsor_versions_default_staff_authority
	after insert on public.qorpera_execution_sponsor_versions
	for each row execute function public.qorpera_default_staff_execution_authority_on_sponsor();

-- Backfill: every company with an active agent lacking authority.
select public.qorpera_ensure_default_staff_execution_authorities(company.profile_id, null)
from (
	select distinct staff.profile_id from public.qorpera_profile_staff as staff
	where staff.employment_status = 'active'
		and not exists (
			select 1 from public.qorpera_staff_execution_authorities as authority
			where authority.profile_id = staff.profile_id and authority.staff_agent_id = staff.staff_agent_id
		)
) as company;
