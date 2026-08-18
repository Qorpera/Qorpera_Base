-- Idempotent local-to-cloud profile promotion.
--
-- The desktop persists p_promotion_id before contacting the hosted primary.
-- Retrying after a timeout or crash therefore returns the same profile and
-- environment instead of creating an orphaned duplicate.

alter table public.qorpera_profiles
	add column if not exists promotion_id uuid;

create unique index if not exists qorpera_profile_owner_promotion
	on public.qorpera_profiles (created_by_user_id, promotion_id)
	where promotion_id is not null;

create or replace function public.qorpera_promote_local_profile(
	p_promotion_id uuid,
	p_profile_name text,
	p_environment_name text,
	p_contract_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
	v_metadata jsonb := coalesce(auth.jwt() -> 'user_metadata', '{}'::jsonb);
	v_display_name text;
	v_avatar_url text;
	v_profile public.qorpera_profiles%rowtype;
	v_environment public.qorpera_company_environments%rowtype;
	v_created boolean := false;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_promotion_id is null then
		raise exception 'promotion id is invalid' using errcode = '22023';
	end if;
	if char_length(btrim(p_profile_name)) not between 1 and 120 then
		raise exception 'profile name is invalid' using errcode = '22023';
	end if;
	if char_length(btrim(p_environment_name)) not between 1 and 120 then
		raise exception 'environment name is invalid' using errcode = '22023';
	end if;
	if p_contract_version is null or p_contract_version < 1 then
		raise exception 'environment contract version is invalid' using errcode = '22023';
	end if;
	if v_email = '' then
		raise exception 'account email is unavailable' using errcode = '22023';
	end if;

	insert into public.qorpera_profiles (name, created_by_user_id, promotion_id)
	values (btrim(p_profile_name), v_user_id, p_promotion_id)
	on conflict (created_by_user_id, promotion_id) where promotion_id is not null do nothing
	returning * into v_profile;
	v_created := found;

	if not v_created then
		select profile.*
		into strict v_profile
		from public.qorpera_profiles as profile
		where profile.created_by_user_id = v_user_id
			and profile.promotion_id = p_promotion_id;

		select environment.*
		into strict v_environment
		from public.qorpera_company_environments as environment
		where environment.profile_id = v_profile.id
		order by environment.created_at, environment.id
		limit 1;

		if v_profile.name <> btrim(p_profile_name)
			or v_environment.name <> btrim(p_environment_name)
			or v_environment.contract_version <> p_contract_version then
			raise exception 'promotion id is already bound to different profile content' using errcode = '23505';
		end if;
	else
		v_display_name := coalesce(
			nullif(btrim(v_metadata ->> 'full_name'), ''),
			nullif(btrim(v_metadata ->> 'name'), ''),
			nullif(btrim(v_metadata ->> 'user_name'), ''),
			split_part(v_email, '@', 1)
		);
		v_avatar_url := nullif(coalesce(v_metadata ->> 'avatar_url', v_metadata ->> 'picture'), '');

		insert into public.qorpera_profile_members (
			profile_id,
			user_id,
			email,
			display_name,
			avatar_url,
			role
		)
		values (v_profile.id, v_user_id, v_email, left(v_display_name, 256), left(v_avatar_url, 2048), 'owner');

		insert into public.qorpera_company_environments (
			profile_id,
			name,
			contract_version,
			created_by_user_id
		)
		values (v_profile.id, btrim(p_environment_name), p_contract_version, v_user_id)
		returning * into v_environment;
	end if;

	return jsonb_build_object(
		'profile_id', v_profile.id,
		'environment_id', v_environment.id,
		'profile_name', v_profile.name,
		'environment_name', v_environment.name,
		'role', 'owner',
		'contract_version', v_environment.contract_version,
		'created_at', v_profile.created_at
	);
end
$$;

revoke all on function public.qorpera_promote_local_profile(uuid, text, text, integer) from public;
grant execute on function public.qorpera_promote_local_profile(uuid, text, text, integer) to authenticated;
