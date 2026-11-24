-- @fixture 1252_site_hosts.test.sql until "-- 1. Rights, the columns and their rules, the markers"
create function pg_temp.sph_site(p_profile uuid, p_slug text, p_public boolean) returns uuid language sql as $$
	insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id, is_public)
	values (p_profile, '92400000-0000-4000-8000-000000000020', p_slug, 'sites/web', '92400000-0000-4000-8000-000000000030',
		p_public)
	returning id
$$;

create function pg_temp.sph_surface(p_profile uuid, p_slug text, p_site uuid, p_status text) returns uuid language sql as $$
	insert into public.qorpera_surfaces (profile_id, slug, title, surface_group, archetype, status, source_kind, site_id, preview_mode)
	values (p_profile, p_slug, initcap(p_slug), 'products', 'live_build', p_status, 'code_repo', p_site,
		case when p_site is null then 'none' else 'static_site' end)
	returning id
$$;

create function pg_temp.sph_cleanup(p_profile uuid) returns void language sql as $$
	delete from public.qorpera_company_sites as site
	where site.profile_id = p_profile
		and site.slug = 'thetaband-go-live-test'
		and site.kind = 'files'
		and not site.is_public
		and site.taken_down_at is null
		and not exists (select 1 from public.qorpera_company_site_domains as dom where dom.site_id = site.id)
		and not exists (
			select 1 from public.qorpera_surfaces as surface
			where surface.site_id = site.id and surface.status <> 'archived'
		)
$$;

do $$
begin
	perform pg_temp.base_assert(
		strpos(pg_get_functiondef('public.qorpera_site_unpublish(jsonb,text)'::regprocedure),
			'unpublish_site cannot take it offline') > 0
		and strpos(pg_get_functiondef('public.qorpera_site_unpublish(jsonb,text)'::regprocedure), 'in Sites''') = 0,
		'the refusal an agent reads names no Sites page');
end $$;

do $$
declare
	v_company uuid := pg_temp.rel_company();
	v_site uuid;
begin
	v_site := pg_temp.sph_site(v_company, 'thetaband-go-live-test', false);
	perform pg_temp.sph_surface(v_company, 'go-live-test', v_site, 'archived');
	perform pg_temp.sph_cleanup('aec016cf-a55b-4370-aac9-069b3b9322dc');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_sites where id = v_site),
		'a site of the same name in another company is kept');

	update public.qorpera_company_sites set is_public = true where id = v_site;
	perform pg_temp.sph_cleanup(v_company);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_sites where id = v_site), 'a public site is kept');
	update public.qorpera_company_sites set is_public = false where id = v_site;

	insert into public.qorpera_company_site_domains (site_id, profile_id, hostname, is_apex, verification_token)
	values (v_site, v_company, 'go-live-test.example.dk', false, repeat('c', 32));
	perform pg_temp.sph_cleanup(v_company);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_sites where id = v_site), 'a site with a domain is kept');
	delete from public.qorpera_company_site_domains where site_id = v_site;

	update public.qorpera_surfaces set status = 'active' where site_id = v_site;
	perform pg_temp.sph_cleanup(v_company);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_sites where id = v_site),
		'a site an interface still shows is kept');
	update public.qorpera_surfaces set status = 'archived' where site_id = v_site;

	perform public.qorpera_site_take_down('thetaband-go-live-test', 'Reported.');
	perform pg_temp.sph_cleanup(v_company);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_sites where id = v_site),
		'a site Qorpera took down is kept, and nothing raises');
	perform public.qorpera_site_restore('thetaband-go-live-test');

	perform pg_temp.sph_cleanup(v_company);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites where id = v_site)
		and (select site_id from public.qorpera_surfaces where slug = 'go-live-test' and profile_id = v_company) is null,
		'the throwaway site goes, and its deleted interface keeps no link to it');
end $$;
