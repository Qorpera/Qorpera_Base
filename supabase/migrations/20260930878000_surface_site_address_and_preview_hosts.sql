-- WHY: A website interface's liveUrl said qorpera.com while its site lives on hosts_domain. Its preview frames stay on
-- site-serve's qorpera.com (same-site inside app.qorpera.com; the web router has no --p hosts), so the host rule takes
-- a --p host on qorpera.com whatever hosts_domain is, and on no other domain; own and --next hosts are unchanged.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_summary_json(public.qorpera_surfaces)') is null
		or to_regprocedure('public.qorpera_get_surface_workspace(uuid)') is null
		or to_regprocedure('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)') is null
		or to_regprocedure('public.qorpera_mint_surface_preview_pass(uuid)') is null
		or to_regprocedure('public.qorpera_site_host(text)') is null
		or to_regprocedure('public.qorpera_site_url(text)') is null
		or to_regprocedure('public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)') is null then
		raise exception '20260930878000 requires 20260930842000, 20260930843000 and 20260930860000';
	end if;
	if to_regprocedure('public.qorpera_site_preview_domain()') is not null then
		raise exception '20260930878000 is already applied';
	end if;
end $$;

create function public.qorpera_site_preview_domain()
returns text language sql immutable set search_path = '' as $$
	select 'qorpera.com'::text
$$;
revoke all on function public.qorpera_site_preview_domain()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.ssap_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930878000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930878000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.ssap_patch('public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure, array[
$old$		'liveUrl', case when site.slug is not null then 'https://' || site.slug || '.qorpera.com/' else null end,$old$,
$new$		'liveUrl', case when site.slug is not null then public.qorpera_site_url(site.slug) else null end,$new$
]);

select pg_temp.ssap_patch('public.qorpera_mint_surface_preview_pass(uuid)'::regprocedure, array[
$old$	v_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';$old$,
$new$	v_host := v_site.slug || '--p' || v_preview.short_host_id || '.' || public.qorpera_site_preview_domain();$new$
]);

select pg_temp.ssap_patch('public.qorpera_get_surface_workspace(uuid)'::regprocedure, array[
$old$v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';$old$,
$new$v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.' || public.qorpera_site_preview_domain();$new$,
$old$v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.qorpera.com';$old$,
$new$v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.' || public.qorpera_site_preview_domain();$new$
]);

select pg_temp.ssap_patch('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure, array[
$old$v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';$old$,
$new$v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.' || public.qorpera_site_preview_domain();$new$,
$old$v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.qorpera.com';$old$,
$new$v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.' || public.qorpera_site_preview_domain();$new$
]);

select pg_temp.ssap_patch('public.qorpera_site_host(text)'::regprocedure, array[
$old$	v_preview_id text;
begin
	if v_domain is null or p_host is null or right(p_host, char_length(v_domain) + 1) <> ('.' || v_domain) then
$old$,
$new$	v_preview_id text;
	v_preview_domain text := public.qorpera_site_preview_domain();
begin
	if v_domain is not null and p_host is not null
		and right(p_host, char_length(v_preview_domain) + 1) = ('.' || v_preview_domain)
		and left(p_host, -(char_length(v_preview_domain) + 1)) ~ '--p[a-z0-9]{8}$' then
		v_domain := v_preview_domain;
	end if;
	if v_domain is null or p_host is null or right(p_host, char_length(v_domain) + 1) <> ('.' || v_domain) then
$new$,
$old$	elsif v_label ~ '--p[a-z0-9]{8}$' then
$old$,
$new$	elsif v_label ~ '--p[a-z0-9]{8}$' and v_domain = v_preview_domain then
$new$
]);

drop function pg_temp.ssap_patch(regprocedure, text[]);
