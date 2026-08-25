create function public.qorpera_describe_native_provider_login_route(
	p_login_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_login public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if auth.role() <> 'service_role' or p_capability_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'native provider login route description is invalid' using errcode = '42501';
	end if;
	select login.* into v_login
	from public.qorpera_native_provider_login_sessions as login
	where login.id = p_login_id and login.capability_sha256 = p_capability_sha256
		and (
			(login.status = 'pending' and login.expires_at > statement_timestamp())
			or (
				login.status = 'completed'
				and login.completed_at > statement_timestamp() - interval '15 minutes'
			)
		)
	for update;
	if not found then
		raise exception 'native provider login is unavailable' using errcode = '55000';
	end if;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_login.compute_identity_id
		and identity.profile_id = v_login.profile_id and identity.status = 'active';
	return jsonb_build_object(
		'login_id', v_login.id,
		'profile_id', v_login.profile_id,
		'client_connection_id', v_login.client_connection_id,
		'compute_identity_id', v_identity.id,
		'compute_identity_ownership_kind', v_identity.ownership_kind,
		'compute_identity_owner_user_id', v_identity.owner_user_id,
		'compute_identity_owner_scope_key', v_identity.owner_scope_key,
		'provider', v_login.provider,
		'native_harness', v_login.native_harness,
		'expires_at', v_login.expires_at,
		'status', v_login.status
	);
end
$$;

revoke all on function public.qorpera_describe_native_provider_login_route(uuid, text) from public;
grant execute on function public.qorpera_describe_native_provider_login_route(uuid, text) to service_role;
