-- Staff execution authority for native-subscription sponsors.
--
-- qorpera_execution_run_model_authority already runs a staff member without a
-- configured provider model when the sponsor connection authenticates through a
-- native subscription: the run records model_id 'provider-default' and the
-- native harness uses the provider's own default model. The authority
-- configuration entry point still demanded a projected staff model id, and the
-- staff-model sync rejects the reserved 'provider-default' sentinel, so an
-- agent document could never satisfy it for such sponsors. Coworker wakes
-- (qorpera_send_coworker_message) therefore had no authority to bind to.
--
-- The authority now requires a staff model id only when the sponsor's
-- connection version does not authenticate through a native subscription, and
-- a projected staff provider must still match the connection provider.
create or replace function public.qorpera_configure_staff_execution_authority(
	p_profile_id uuid,
	p_staff_agent_id uuid,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_logical_computer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_staff public.qorpera_profile_staff%rowtype;
	v_authority public.qorpera_staff_execution_authorities%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'staff execution authority requires authorize access' using errcode = '42501';
	end if;
	select staff.* into v_staff
	from public.qorpera_profile_staff as staff
	where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
		and staff.employment_status = 'active';
	if v_staff.staff_agent_id is null or not exists (
		select 1
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = p_sponsor_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		join public.qorpera_provider_connection_versions as connection_version
			on connection_version.connection_id = connection.id
			and connection_version.version = sponsor.provider_connection_version
		where binding.id = p_sponsor_binding_id and binding.profile_id = p_profile_id
			and binding.status = 'active' and sponsor.allow_autonomous
			and connection.profile_id = p_profile_id and connection.status = 'active'
			and (v_staff.model_provider is null or connection.provider = v_staff.model_provider)
			and (v_staff.model_id is not null or connection_version.authentication_mode = 'native_subscription')
			and (
				sponsor.sponsor_kind <> 'member_connection'
				or exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = p_profile_id and member.user_id = connection.owner_user_id
				)
			)
	) or (p_logical_computer_id is not null and not exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.id = p_logical_computer_id and computer.profile_id = p_profile_id
			and computer.status = 'active' and computer.capabilities ? 'agent_turn'
	)) then
		raise exception 'staff execution authority is unavailable' using errcode = '22023';
	end if;
	insert into public.qorpera_staff_execution_authorities (
		profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
		logical_computer_id, configured_by_user_id
	) values (
		p_profile_id, p_staff_agent_id, p_sponsor_binding_id, p_sponsor_version,
		p_logical_computer_id, v_user_id
	)
	on conflict (profile_id, staff_agent_id) do update set
		sponsor_binding_id = excluded.sponsor_binding_id,
		sponsor_version = excluded.sponsor_version,
		logical_computer_id = excluded.logical_computer_id,
		configured_by_user_id = excluded.configured_by_user_id,
		configured_at = statement_timestamp()
	returning * into v_authority;
	return jsonb_build_object(
		'profile_id', v_authority.profile_id,
		'staff_agent_id', v_authority.staff_agent_id,
		'sponsor_binding_id', v_authority.sponsor_binding_id,
		'sponsor_version', v_authority.sponsor_version,
		'logical_computer_id', v_authority.logical_computer_id,
		'configured_at', v_authority.configured_at
	);
end
$$;
