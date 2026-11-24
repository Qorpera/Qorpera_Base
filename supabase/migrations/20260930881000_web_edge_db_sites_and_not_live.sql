do $$
begin
	if to_regprocedure('public.qorpera_web_edge_snapshot()') is null
		or to_regprocedure('public.qorpera_company_deleting(uuid)') is null
		or to_regclass('public.qorpera_company_site_deployments') is null
		or not exists (select 1 from pg_roles where rolname = 'qorpera_web_router')
		or strpos(pg_get_functiondef('public.qorpera_web_edge_snapshot()'::regprocedure), '''qorpera_web_router''') = 0 then
		raise exception '20260930881000 requires native web hosting (20260930833000) and the web router role (20260930834000)';
	end if;
	if to_regprocedure('public.qorpera_web_edge_site_file(uuid,uuid,text)') is not null
		or strpos(pg_get_functiondef('public.qorpera_web_edge_snapshot()'::regprocedure), '''db_live''') > 0 then
		raise exception '20260930881000 (web edge database sites) is already applied';
	end if;
end $$;

set local lock_timeout = '3s';

create function public.qorpera_web_edge_db_servable(p_site_id uuid, p_version_id uuid)
returns boolean language sql stable set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_company_sites as site
		join public.qorpera_company_site_versions as ver on ver.site_id = site.id
		where site.id = p_site_id
			and ver.id = p_version_id
			and site.kind = 'files'
			and site.live_deployment_id is null
			and site.taken_down_at is null
			and not public.qorpera_company_deleting(site.profile_id)
			and ver.state in ('ready', 'live', 'kept')
			and not exists (
				select 1 from public.qorpera_company_site_deployments as dep where dep.version_id = ver.id
			)
			and not exists (
				select 1 from public.qorpera_company_site_files as file
				where file.version_id = ver.id and file.content is null
			)
	)
$$;

create function public.qorpera_web_edge_db_manifest(p_version_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_object('files', coalesce(jsonb_object_agg(file.path, jsonb_build_object(
		'sha256', file.sha256,
		'bytes', file.bytes,
		'content_type', case
			when file.content_type ~ '^[a-z]+/[a-z0-9.+-]+(; charset=utf-8)?$' then file.content_type
			else 'application/octet-stream'
		end
	)), '{}'::jsonb))
	from public.qorpera_company_site_files as file
	where file.version_id = p_version_id
$$;

create function pg_temp.web_edge_881000_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930881000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930881000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.web_edge_881000_patch('public.qorpera_web_edge_snapshot()'::regprocedure, array[
$old$where sec.site_id = site.id$old$,
$new$where sec.site_id = site.id
						and (site.kind <> 'files'
							or (site.is_public and coalesce(v_settings.enabled and v_settings.public_enabled, false)))$new$,
$old$'live_deployment', ($old$,
$new$'db_live', (
					select jsonb_build_object(
						'id', 'db:' || ver.id::text,
						'kind', 'static',
						'manifest', public.qorpera_web_edge_db_manifest(ver.id)
					)
					from public.qorpera_company_site_versions as ver
					where ver.id = site.current_version_id
						and public.qorpera_web_edge_db_servable(site.id, ver.id)
				),
				'db_previews', coalesce((
					select jsonb_object_agg(
						ver.id::text,
						jsonb_build_object(
							'id', 'db:' || ver.id::text,
							'kind', 'static',
							'manifest', public.qorpera_web_edge_db_manifest(ver.id)
						)
					)
					from public.qorpera_company_site_versions as ver
					where ver.site_id = site.id
						and public.qorpera_web_edge_db_servable(site.id, ver.id)
				), '{}'::jsonb),
				'live_deployment', ($new$
]);

drop function pg_temp.web_edge_881000_patch(regprocedure, text[]);

create function public.qorpera_web_edge_site_file(p_site_id uuid, p_version_id uuid, p_path text)
returns bytea language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role', 'qorpera_web_router') then
		raise exception 'Edge site file requires service_role' using errcode = '42501';
	end if;
	if p_site_id is null or p_version_id is null or p_path is null
		or not public.qorpera_web_edge_db_servable(p_site_id, p_version_id) then
		return null;
	end if;
	return (
		select file.content
		from public.qorpera_company_site_files as file
		where file.version_id = p_version_id and file.path = p_path
	);
end $$;

revoke all on function
	public.qorpera_web_edge_db_servable(uuid, uuid),
	public.qorpera_web_edge_db_manifest(uuid),
	public.qorpera_web_edge_site_file(uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay, qorpera_web_router;

grant execute on function public.qorpera_web_edge_site_file(uuid, uuid, text) to service_role, qorpera_web_router;

update public.qorpera_company_sites as site
set password_version = site.password_version + 1
where site.kind = 'files'
	and not (site.is_public and coalesce((
		select settings.enabled and settings.public_enabled from public.qorpera_site_settings as settings limit 1
	), false));
