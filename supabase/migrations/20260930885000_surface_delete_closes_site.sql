-- WHY: Deleting an interface (20260930875000) left its website as it was: a public site stayed public on its address
-- and its domains, with nothing left in the app to close it. The delete now closes it, as "Make it not live" does.
-- One statement, so a refusal changes nothing also where psql rolls back statement by statement (SQL test 1367).
set local lock_timeout = '3s';

do $migration$
declare
	v_target constant regprocedure := 'public.qorpera_surface_remove(uuid,boolean)'::regprocedure;
	v_old constant text := $old$	delete from public.qorpera_surface_publish_asks where surface_id = p_surface_id;

	return v_surface;$old$;
	v_new constant text := $new$	delete from public.qorpera_surface_publish_asks where surface_id = p_surface_id;

	perform public.qorpera_surface_site_close(v_surface.site_id);

	return v_surface;$new$;
	v_def text;
	v_hits integer;
	v_owner name;
	v_site_id uuid;
begin
	if to_regprocedure('public.qorpera_surface_remove(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_set_company_site_public(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_web_notify_route_change()') is null
		or not exists (
			select 1 from pg_trigger as trg
			where trg.tgrelid = 'public.qorpera_company_sites'::regclass and trg.tgname = 'qorpera_web_notify_sites'
		)
		or not exists (select 1 from pg_roles where rolname = 'qorpera_site_relay')
		or not exists (select 1 from pg_roles where rolname = 'qorpera_web_router') then
		raise exception '20260930885000 requires 20260930832000, 20260930834000 and 20260930875000';
	end if;
	if to_regprocedure('public.qorpera_surface_site_close(uuid)') is not null then
		raise exception '20260930885000 is already applied';
	end if;

	v_def := pg_get_functiondef(v_target);
	v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
	if v_hits <> 1 then
		raise exception '20260930885000: anchor matched % time(s) in %: %', v_hits, v_target, left(v_old, 120);
	end if;

	create function public.qorpera_surface_site_close(p_site_id uuid)
	returns void language plpgsql security definer set search_path = '' as $fn$
	declare
		v_site public.qorpera_company_sites%rowtype;
	begin
		select site.* into v_site
		from public.qorpera_company_sites as site
		where site.id = p_site_id and site.is_public and site.kind = 'files'
		for update;
		if v_site.id is null or exists (
			select 1 from public.qorpera_surfaces as surface
			where surface.profile_id = v_site.profile_id and surface.site_id = v_site.id and surface.status <> 'archived'
		) then
			return;
		end if;
		update public.qorpera_company_sites
		set is_public = false, password_version = password_version + 1, updated_at = clock_timestamp()
		where id = v_site.id;
	end $fn$;

	execute replace(v_def, v_old, v_new);

	revoke all on function public.qorpera_surface_site_close(uuid)
		from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay, qorpera_web_router;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[v_target, 'public.qorpera_surface_site_close(uuid)'::regprocedure])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker', 'qorpera_site_relay', 'qorpera_web_router') then
			raise exception 'Surface site close function has an API owner: %', v_owner;
		end if;
		execute format('grant select, update on public.qorpera_company_sites to %I', v_owner);
		execute format('grant select on public.qorpera_surfaces to %I', v_owner);
		execute format('grant execute on function public.qorpera_surface_site_close(uuid) to %I', v_owner);
	end loop;

	for v_site_id in
		select distinct surface.site_id
		from public.qorpera_surfaces as surface
		where surface.status = 'archived' and surface.site_id is not null
		order by surface.site_id
	loop
		perform public.qorpera_surface_site_close(v_site_id);
	end loop;
end $migration$;
