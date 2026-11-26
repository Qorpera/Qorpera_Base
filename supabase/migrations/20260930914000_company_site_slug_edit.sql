do $$
begin
	if to_regprocedure('public.qorpera_set_company_site_slug(uuid,text)') is not null
		or to_regprocedure('public.qorpera_check_company_site_slug(uuid,text)') is not null then
		raise exception '20260930914000 (company site slug edit) is already applied';
	end if;
	if to_regclass('public.qorpera_company_sites') is null
		or to_regclass('public.qorpera_company_site_member_passes') is null
		or to_regclass('public.qorpera_company_site_tickets') is null
		or to_regclass('public.qorpera_company_site_sessions') is null
		or to_regclass('public.qorpera_code_repositories') is null
		or to_regprocedure('public.qorpera_site_slug_valid(text)') is null
		or to_regprocedure('public.qorpera_site_reserved_names()') is null
		or to_regprocedure('public.qorpera_site_abandoned(public.qorpera_company_sites)') is null
		or to_regprocedure('public.qorpera_site_url(text)') is null
		or to_regprocedure('public.qorpera_member_role(uuid)') is null
		or to_regprocedure('public.qorpera_company_deleting(uuid)') is null
		or not exists (select 1 from pg_roles where rolname = 'qorpera_site_relay')
		or not exists (select 1 from pg_roles where rolname = 'qorpera_web_router') then
		raise exception '20260930914000 requires company sites, site hosts, member passes, and web hosting';
	end if;
end $$;

set local lock_timeout = '3s';

create function public.qorpera_check_company_site_slug(p_site_id uuid, p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_site public.qorpera_company_sites%rowtype;
	v_holder public.qorpera_company_sites%rowtype;
	v_role public.qorpera_profile_role;
	v_slug text := lower(btrim(coalesce(p_slug, '')));
	v_reason text;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	if p_site_id is null then
		raise exception 'Site is required' using errcode = '22023';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id;
	if not found then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_site.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') or public.qorpera_company_deleting(v_site.profile_id) then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	if v_site.kind <> 'files' then
		raise exception 'SITE_KIND_UNSUPPORTED' using errcode = '22023';
	end if;
	if v_slug = v_site.slug then
		return jsonb_build_object(
			'schema', 'qorpera.company-site-slug-check/v1',
			'siteId', v_site.id,
			'slug', v_slug,
			'available', true,
			'reason', 'current'
		);
	end if;
	if not public.qorpera_site_slug_valid(v_slug) then
		v_reason := case
			when v_slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' and strpos(v_slug, '--') = 0 then 'reserved'
			else 'invalid'
		end;
		return jsonb_build_object(
			'schema', 'qorpera.company-site-slug-check/v1',
			'siteId', v_site.id,
			'slug', v_slug,
			'available', false,
			'reason', v_reason
		);
	end if;
	select site.* into v_holder from public.qorpera_company_sites as site where site.slug = v_slug;
	if found and v_holder.id <> v_site.id and not public.qorpera_site_abandoned(v_holder) then
		return jsonb_build_object(
			'schema', 'qorpera.company-site-slug-check/v1',
			'siteId', v_site.id,
			'slug', v_slug,
			'available', false,
			'reason', 'taken'
		);
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-slug-check/v1',
		'siteId', v_site.id,
		'slug', v_slug,
		'available', true,
		'reason', 'available'
	);
end $$;

create function public.qorpera_set_company_site_slug(p_site_id uuid, p_slug text)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_site public.qorpera_company_sites%rowtype;
	v_holder public.qorpera_company_sites%rowtype;
	v_locked_holder_id uuid;
	v_role public.qorpera_profile_role;
	v_slug text;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	if p_site_id is null or p_slug is null then
		raise exception 'Site and address are required' using errcode = '22023';
	end if;
	v_slug := lower(btrim(p_slug));
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id;
	if not found then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_site.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') or public.qorpera_company_deleting(v_site.profile_id) then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	if v_site.kind <> 'files' then
		raise exception 'SITE_KIND_UNSUPPORTED' using errcode = '22023';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	if not public.qorpera_site_slug_valid(v_slug) then
		raise exception 'SITE_SLUG_INVALID' using errcode = '22023';
	end if;

	perform 1
	from public.qorpera_code_repositories as repo
	where repo.site_id = p_site_id
	order by repo.environment_id, repo.owner, repo.name
	for update;

	select site.* into v_holder
	from public.qorpera_company_sites as site
	where site.slug = v_slug and site.id <> p_site_id;
	if found then
		if not public.qorpera_site_abandoned(v_holder) then
			raise exception 'SITE_SLUG_TAKEN' using errcode = '23505';
		end if;
		v_locked_holder_id := v_holder.id;
		perform 1
		from public.qorpera_company_sites as site
		where site.id in (p_site_id, v_locked_holder_id)
		order by site.id
		for update;
	end if;

	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id for update;
	if not found then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_site.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') or public.qorpera_company_deleting(v_site.profile_id) then
		raise exception 'Only founders and admins manage site addresses' using errcode = '42501';
	end if;
	if v_site.kind <> 'files' then
		raise exception 'SITE_KIND_UNSUPPORTED' using errcode = '22023';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	if v_site.slug = v_slug then
		return jsonb_build_object(
			'schema', 'qorpera.company-site-slug/v1',
			'siteId', v_site.id,
			'slug', v_site.slug,
			'url', public.qorpera_site_url(v_site.slug)
		);
	end if;

	select site.* into v_holder
	from public.qorpera_company_sites as site
	where site.slug = v_slug and site.id <> v_site.id;
	if found then
		if v_holder.id is distinct from v_locked_holder_id or not public.qorpera_site_abandoned(v_holder) then
			raise exception 'SITE_SLUG_TAKEN' using errcode = '23505';
		end if;
		delete from public.qorpera_company_sites where id = v_holder.id;
	end if;

	begin
		update public.qorpera_company_sites
		set slug = v_slug, updated_at = clock_timestamp()
		where id = v_site.id;
	exception when unique_violation then
		raise exception 'SITE_SLUG_TAKEN' using errcode = '23505';
	end;

	delete from public.qorpera_company_site_member_passes where site_id = v_site.id;
	delete from public.qorpera_company_site_tickets where site_id = v_site.id;
	delete from public.qorpera_company_site_sessions where site_id = v_site.id;
	update public.qorpera_code_repositories as repo
	set index_version = repo.index_version + 1
	where repo.site_id = v_site.id;

	return jsonb_build_object(
		'schema', 'qorpera.company-site-slug/v1',
		'siteId', v_site.id,
		'slug', v_slug,
		'url', public.qorpera_site_url(v_slug)
	);
end $$;

do $$
begin
	if to_regprocedure('public.qorpera_live_hint_internal()') is not null then
		create constraint trigger qorpera_live_hint_site_slug
			after update on public.qorpera_company_sites
			deferrable initially deferred for each row
			when (old.slug is distinct from new.slug)
			execute function public.qorpera_live_hint_internal('surfaces');
	end if;
end $$;

revoke all on function
	public.qorpera_check_company_site_slug(uuid, text),
	public.qorpera_set_company_site_slug(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay, qorpera_web_router;

grant execute on function
	public.qorpera_check_company_site_slug(uuid, text),
	public.qorpera_set_company_site_slug(uuid, text)
	to authenticated;
