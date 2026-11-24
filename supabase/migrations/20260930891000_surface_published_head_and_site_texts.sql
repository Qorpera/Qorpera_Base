set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_summary_json(public.qorpera_surfaces)') is null
		or to_regprocedure('public.qorpera_site_unpublish(jsonb,text)') is null
		or to_regclass('public.qorpera_company_site_domains') is null
		or strpos(pg_get_functiondef('public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure),
			'''liveHeadSha''') = 0 then
		raise exception '20260930891000 requires 20260930729000, 20260930832000 and 20260930860000';
	end if;
	if strpos(pg_get_functiondef('public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure),
		'''publishedHeadSha''') > 0 then
		raise exception '20260930891000 is already applied';
	end if;
end $$;

create function pg_temp.sph_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930891000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930891000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.sph_patch('public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure, array[
$old$		'liveHeadSha', p_surface.live_head_sha,
$old$,
$new$		'liveHeadSha', p_surface.live_head_sha,
		'publishedHeadSha', p_surface.published_head_sha,
$new$
]);

select pg_temp.sph_patch('public.qorpera_site_unpublish(jsonb,text)'::regprocedure, array[
$old$'SITE_FROM_CODE: this site is made from code kept in Qorpera; only a member takes it offline, in Sites'$old$,
$new$'SITE_FROM_CODE: this site is made from code kept in Qorpera; unpublish_site cannot take it offline'$new$
]);

drop function pg_temp.sph_patch(regprocedure, text[]);

-- WHY: removes the throwaway site of the owner's Go live test on 24 Nov 2026, whose interface is already deleted.
-- Every guard must hold (not public, no custom domain, only deleted interfaces point at it); elsewhere it does nothing.
delete from public.qorpera_company_sites as site
where site.profile_id = 'aec016cf-a55b-4370-aac9-069b3b9322dc'
	and site.slug = 'thetaband-go-live-test'
	and site.kind = 'files'
	and not site.is_public
	and not exists (select 1 from public.qorpera_company_site_domains as dom where dom.site_id = site.id)
	and not exists (
		select 1 from public.qorpera_surfaces as surface
		where surface.site_id = site.id and surface.status <> 'archived'
	);
