-- Runtime Step 3 (contract 16.2 routine consent, 17): a member's typed
-- consent for autonomous work on their own provider connection. Consent is a
-- new immutable connection version carrying allow_autonomous, consented by
-- the connection's owner; sponsors that allow autonomous work reference such
-- a version (qorpera_create_member_execution_sponsor). Withdrawing consent
-- is the same operation with allow_autonomous false: existing sponsor
-- versions keep their pinned connection version, and autonomous admission
-- rechecks the latest consent through the sponsor's version at materialization.
create function public.qorpera_consent_provider_connection_autonomous(
	p_profile_id uuid, p_connection_id uuid, p_allow_autonomous boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype; v_next bigint;
begin
	if v_user is null or p_allow_autonomous is null then
		raise exception 'autonomous consent requires the connection owner' using errcode = '42501'; end if;
	select * into v_connection from public.qorpera_provider_connections
	where id = p_connection_id and profile_id = p_profile_id and owner_user_id = v_user and status = 'active' for update;
	if not found then raise exception 'autonomous consent requires the connection owner' using errcode = '42501'; end if;
	select * into v_version from public.qorpera_provider_connection_versions
	where connection_id = v_connection.id and authorization_state = 'active' order by version desc limit 1;
	if not found then raise exception 'provider connection has no active version' using errcode = '55000'; end if;
	if v_version.allow_autonomous = p_allow_autonomous then
		return jsonb_build_object('schema','qorpera.provider-connection-consent/v1','connection_id',v_connection.id,
			'version',v_version.version,'allow_autonomous',v_version.allow_autonomous,'changed',false);
	end if;
	select coalesce(max(version),0) + 1 into v_next from public.qorpera_provider_connection_versions
	where connection_id = v_connection.id;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v_version) || jsonb_build_object('version',v_next,'allow_autonomous',p_allow_autonomous,
			'consented_by_user_id',v_user,'consent_version','qorpera-native-provider-autonomous-consent/v1',
			'created_at',clock_timestamp()))).*;
	return jsonb_build_object('schema','qorpera.provider-connection-consent/v1','connection_id',v_connection.id,
		'version',v_next,'allow_autonomous',p_allow_autonomous,'changed',true);
end
$$;
revoke all on function public.qorpera_consent_provider_connection_autonomous(uuid, uuid, boolean) from public, anon;
grant execute on function public.qorpera_consent_provider_connection_autonomous(uuid, uuid, boolean) to authenticated;
