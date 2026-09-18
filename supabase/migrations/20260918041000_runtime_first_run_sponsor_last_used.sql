-- A member who signed in to the same provider more than once holds several usable connections, so "exactly one
-- usable account" chose none (found live on the managed test owner). The first run now uses the account that
-- member last used for a run in this company; a member who never ran anything still needs exactly one.
create or replace function public.qorpera_member_first_run_sponsor(p_profile_id uuid,p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	with usable as (
		select sponsor.binding_id,sponsor.version,identity.id as compute_identity_id,
			(select max(run.created_at) from public.qorpera_execution_runs run
				where run.profile_id = p_profile_id and run.sponsor_binding_id = sponsor.binding_id
					and run.sponsored_by_user_id = p_user_id) as last_used
		from public.qorpera_member_compute_identities identity
		join public.qorpera_native_credential_capsules capsule on capsule.compute_identity_id = identity.id
			and capsule.status = 'active' and capsule.ownership_kind = 'member' and capsule.owner_user_id = p_user_id
		join public.qorpera_provider_connection_versions version on version.credential_capsule_id = capsule.id
			and version.authentication_mode = 'native_subscription' and version.authorization_state = 'active'
		join public.qorpera_provider_connections connection on connection.id = version.connection_id
			and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id and connection.status = 'active'
		join lateral (
			select sponsor_version.binding_id,sponsor_version.version
			from public.qorpera_execution_sponsor_versions sponsor_version
			join public.qorpera_execution_sponsor_bindings binding on binding.id = sponsor_version.binding_id
				and binding.profile_id = p_profile_id and binding.status = 'active'
			where sponsor_version.provider_connection_id = connection.id
				and sponsor_version.provider_connection_version = version.version
				and sponsor_version.sponsor_kind = 'member_connection'
			order by sponsor_version.created_at desc,sponsor_version.version desc limit 1
		) sponsor on true
		where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
			and identity.owner_user_id = p_user_id and identity.status = 'active'
			and public.qorpera_provider_execution_enabled(connection.provider,'native_subscription',version.native_harness)
			and exists (select 1 from public.qorpera_profile_members member where member.profile_id = p_profile_id
				and member.user_id = p_user_id and member.role in ('owner','admin','contributor'))
	)
	select jsonb_build_object('sponsorBindingId',chosen.binding_id,'sponsorVersion',chosen.version,
		'computeIdentityId',chosen.compute_identity_id)
	from (select * from usable order by last_used desc nulls last,binding_id limit 1) chosen
	where chosen.last_used is not null or (select count(*) from usable) = 1
$$;
