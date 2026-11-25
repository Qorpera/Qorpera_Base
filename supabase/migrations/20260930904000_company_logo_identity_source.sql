set local lock_timeout = '3s';

do $$
begin
	if to_regprocedure('public.qorpera_company_logo_source(uuid)') is null
		or to_regprocedure('public.qorpera_company_logos(uuid[])') is null
		or to_regprocedure('public.qorpera_publish_company_logo(uuid,text)') is null
		or to_regclass('public.qorpera_surfaces') is null then
		raise exception '20260930904000 requires company logos (20260930696000) and surfaces (20260930843000)';
	end if;
	if to_regprocedure('public.qorpera_company_logo_source_entry(uuid)') is not null then
		raise exception '20260930904000 is already applied';
	end if;
end $$;

create function public.qorpera_company_logo_source_entry(p_profile_id uuid)
returns table (path text, file_sha256 text, bytes bigint, media_type text)
language sql
stable
security definer
set search_path = ''
as $$
	with identity_roots as (
		select
			(array_agg(root order by root_rank asc))[1] as root,
			min(root_rank) as root_rank
		from (
			select
				nullif(btrim(coalesce(s.folder_root, ''), '/ '), '') as root,
				row_number() over (
					order by s.is_global desc, (s.surface_kind = 'identity') desc, s.sort_order asc, s.created_at asc
				) as root_rank
			from public.qorpera_surfaces s
			where s.profile_id = p_profile_id
				and s.status = 'active'
				and (s.is_global = true or s.surface_kind = 'identity' or s.slug = 'identity')
			union all
			select 'identity'::text as root, 1000000::bigint as root_rank
		) raw_roots
		where root is not null
		group by public.qorpera_folder_key(root)
	),
	candidates as (
		select
			extensions.digest(public.qorpera_folder_key(r.root || '/' || stem.name), 'sha256') as key_sha256,
			r.root_rank * 100 + stem.ord as priority
		from identity_roots r
		cross join unnest(array[
			'logo.svg',
			'logo.png',
			'logo.webp',
			'logo.jpg',
			'logo.jpeg',
			'logo-light.svg',
			'logo-light.png',
			'logo-light.webp',
			'logo-light.jpg',
			'logo-light.jpeg'
		]) with ordinality as stem(name, ord)
		union all
		select
			extensions.digest(public.qorpera_folder_key('QorperaOS/brand/logo.svg'), 'sha256') as key_sha256,
			900000000::bigint as priority
	)
	select entry.path, entry.file_sha256, entry.bytes, entry.media_type
	from candidates c
	join public.qorpera_company_environments environment
		on environment.profile_id = p_profile_id
	join public.qorpera_folder_entries entry
		on entry.environment_id = environment.id
		and entry.key_sha256 = c.key_sha256
	where entry.kind = 'file'
	order by c.priority asc, entry.updated_at desc
	limit 1
$$;

create or replace function public.qorpera_company_logo_source(p_profile_id uuid)
returns table (file_sha256 text, bytes bigint, media_type text)
language sql
stable
security definer
set search_path = ''
as $$
	select entry.file_sha256, entry.bytes, entry.media_type
	from public.qorpera_company_logo_source_entry(p_profile_id) entry
$$;

create or replace function public.qorpera_company_logos(p_profile_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_result jsonb;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if coalesce(cardinality(p_profile_ids), 0) > 200 then
		raise exception 'ask for at most 200 logos at a time' using errcode = '22023';
	end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'profile_id', company.id,
		'object_name', logo.object_name,
		'updated_at', logo.updated_at,
		'publisher', can_publish.allowed,
		'source_sha256', case when can_publish.allowed then source.file_sha256 end,
		'source_bytes', case when can_publish.allowed then source.bytes end,
		'source_path', case when can_publish.allowed then source.path end
	) order by company.id), '[]'::jsonb)
	into v_result
	from public.qorpera_profiles company
	left join public.qorpera_company_logos logo on logo.profile_id = company.id
	cross join lateral (
		select public.qorpera_can_publish_company_logo(company.id) as allowed
	) can_publish
	left join lateral (
		select entry.path, entry.file_sha256, entry.bytes
		from public.qorpera_company_logo_source_entry(company.id) entry
		where can_publish.allowed
	) source on true
	where company.id = any(coalesce(p_profile_ids, array[]::uuid[]))
		and public.qorpera_can_see_company_logo(company.id)
		and (logo.object_name is not null or can_publish.allowed);
	return v_result;
end
$$;

revoke all on function public.qorpera_company_logo_source_entry(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_logo_source(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_logos(uuid[]) from public, anon;
grant execute on function public.qorpera_company_logos(uuid[]) to authenticated;
