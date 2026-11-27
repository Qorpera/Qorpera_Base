set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_site_deployment_set_upstream(uuid,text)') is not null then
		raise exception '20260930935000_surface_app_host_server_hosting is already applied';
	end if;
	if to_regclass('public.qorpera_surfaces') is null
		or to_regclass('public.qorpera_company_site_deployments') is null
		or to_regclass('public.qorpera_surface_preview_builds') is null
		or to_regprocedure('public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text)') is null
		or to_regprocedure('public.qorpera_surface_request_build(text,uuid,uuid,text,text,jsonb,text)') is null
		or to_regprocedure('public.qorpera_surface_preview_build_settle(uuid)') is null
		or to_regprocedure('public.qorpera_web_edge_snapshot()') is null then
		raise exception '20260930935000 requires native edge surface previews (20260930916000)';
	end if;
end $$;

alter table public.qorpera_surface_preview_builds
	add column defer_settle boolean not null default false;

alter table public.qorpera_company_site_deployments
	add column updated_at timestamptz not null default now(),
	add column last_stop_attempt_at timestamptz;

create temp table sahs_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = any(array[
		'public.qorpera_surface_preview_build_settle(uuid)'::regprocedure,
		'public.qorpera_web_edge_snapshot()'::regprocedure
	]);

create function pg_temp.sahs_apply(p_def text, p_label text, p_pairs text[])
returns text language plpgsql as $$
declare
	v_def text := p_def;
	v_found integer;
begin
	for i in 1..cardinality(p_pairs) / 2 loop
		v_found := (length(v_def) - length(replace(v_def, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930935000 anchor found % time(s) in %, expected 1: %',
				v_found, p_label, left(p_pairs[2 * i - 1], 120);
		end if;
		v_def := replace(v_def, p_pairs[2 * i - 1], p_pairs[2 * i]);
	end loop;
	return v_def;
end $$;

create function pg_temp.sahs_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
begin
	execute pg_temp.sahs_apply(pg_get_functiondef(p_target), p_target::text, p_pairs);
end $$;

drop function public.qorpera_surface_site_deployment_register(uuid, text, text, jsonb, integer, bigint, boolean, boolean, text, text);

create function public.qorpera_surface_site_deployment_register(
	p_surface_id uuid,
	p_tree_sha text,
	p_manifest_sha256 text,
	p_manifest_json jsonb,
	p_file_count integer,
	p_total_bytes bigint,
	p_has_credential_inputs boolean default false,
	p_promote_live boolean default false,
	p_main_sha text default null,
	p_title text default null,
	p_kind text default 'static',
	p_oci_image_ref text default null,
	p_app_port integer default null,
	p_health_path text default '/',
	p_idle_timeout_sec integer default 900,
	p_memory_mb integer default 512,
	p_vcpu_limit numeric default 1.00,
	p_upstream_addr text default null,
	p_env_spec jsonb default '{}'::jsonb,
	p_check_public_promote boolean default false
)
returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype;
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_kind text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'static');
	v_oci_image_ref text := nullif(btrim(coalesce(p_oci_image_ref, '')), '');
	v_health_path text := coalesce(nullif(btrim(coalesce(p_health_path, '')), ''), '/');
	v_idle_timeout_sec integer := coalesce(p_idle_timeout_sec, 900);
	v_memory_mb integer := coalesce(p_memory_mb, 512);
	v_vcpu_limit numeric := coalesce(p_vcpu_limit, 1.00);
	v_upstream_addr text := nullif(btrim(coalesce(p_upstream_addr, '')), '');
	v_env_spec jsonb := coalesce(p_env_spec, '{}'::jsonb);
	v_tree_key text;
	v_main_sha text;
	v_next_change integer;
	v_next_version integer;
	v_title text;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Surface site deployment register requires service_role' using errcode = '42501';
	end if;
	if p_surface_id is null
		or p_tree_sha is null or p_tree_sha !~ '^[0-9a-f]{40}$'
		or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(coalesce(p_manifest_json, 'null'::jsonb)) <> 'object'
		or jsonb_typeof(v_env_spec) <> 'object'
		or v_kind not in ('static', 'server', 'hybrid')
		or p_file_count is null or p_file_count not between (case when v_kind = 'static' then 1 else 0 end) and 10000
		or p_total_bytes is null or p_total_bytes not between 0 and 536870912
		or (p_main_sha is not null and p_main_sha !~ '^[0-9a-f]{40}$')
		or (v_kind <> 'static' and v_oci_image_ref is null)
		or (v_oci_image_ref is not null and (char_length(v_oci_image_ref) not between 8 and 512 or v_oci_image_ref ~ '[[:cntrl:][:space:]]'))
		or (p_app_port is not null and p_app_port not between 1 and 65535)
		or char_length(v_health_path) not between 1 and 256
		or left(v_health_path, 1) <> '/'
		or v_health_path ~ '[[:cntrl:][:space:]]'
		or v_idle_timeout_sec not between 0 and 86400
		or v_memory_mb not between 64 and 8192
		or v_vcpu_limit not between 0.25 and 8.00
		or (v_upstream_addr is not null and (char_length(v_upstream_addr) not between 3 and 255 or v_upstream_addr ~ '[[:cntrl:][:space:]]')) then
		raise exception 'Surface site deployment input is invalid' using errcode = '22023';
	end if;

	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null or v_surface.site_id is null then
		raise exception 'Surface preview site not found' using errcode = 'P0002';
	end if;
	select * into v_site from public.qorpera_company_sites where id = v_surface.site_id for update;
	if v_site.id is null then
		raise exception 'Surface preview site not found' using errcode = 'P0002';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	if public.qorpera_company_deleting(v_site.profile_id) then
		raise exception 'Company is deleting' using errcode = '55000';
	end if;
	if (coalesce(p_promote_live, false) or coalesce(p_check_public_promote, false))
		and v_site.is_public
		and coalesce(p_has_credential_inputs, false) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;

	if v_kind = 'static' then
		v_tree_key := left(p_manifest_sha256, 40);
	else
		v_tree_key := left(
			encode(
				extensions.digest(
					convert_to(
						v_kind || ':' || p_manifest_sha256 || ':' || coalesce(v_oci_image_ref, '') || ':' ||
						coalesce(p_app_port::text, '') || ':' || v_health_path || ':' ||
						v_idle_timeout_sec::text || ':' || v_memory_mb::text || ':' ||
						v_vcpu_limit::text || ':' || v_env_spec::text,
						'utf8'
					),
					'sha256'
				),
				'hex'
			),
			40
		);
	end if;
	v_main_sha := coalesce(p_main_sha, p_tree_sha);
	v_title := nullif(btrim(coalesce(p_title, '')), '');

	select * into v_version
	from public.qorpera_company_site_versions as ver
	where ver.site_id = v_site.id and ver.tree = v_tree_key
	for update;

	if coalesce(p_promote_live, false) then
		update public.qorpera_company_site_versions
		set state = 'kept'
		where site_id = v_site.id
			and state = 'live'
			and (v_version.id is null or id <> v_version.id);
	end if;

	if v_version.id is null then
		select coalesce(max(ver.change), 0) + 1 into v_next_change
		from public.qorpera_company_site_versions as ver
		where ver.site_id = v_site.id;

		insert into public.qorpera_company_site_versions (
			site_id, state, first_publish, title, source_path, manifest_sha256,
			file_count, total_bytes, tree, change, main_sha, listed, published_at
		) values (
			v_site.id,
			case when coalesce(p_promote_live, false) then 'live' else 'ready' end,
			v_site.current_version_id is null,
			coalesce(v_title, v_site.title, v_surface.title),
			v_site.source_path,
			p_manifest_sha256,
			p_file_count,
			p_total_bytes,
			v_tree_key,
			v_next_change,
			v_main_sha,
			true,
			case when coalesce(p_promote_live, false) then v_now else null end
		)
		returning * into v_version;
	else
		update public.qorpera_company_site_versions
		set
			state = case
				when coalesce(p_promote_live, false) then 'live'
				when state = 'uploading' then 'ready'
				else state
			end,
			listed = true,
			manifest_sha256 = p_manifest_sha256,
			file_count = p_file_count,
			total_bytes = p_total_bytes,
			published_at = case
				when coalesce(p_promote_live, false) then coalesce(published_at, v_now)
				else published_at
			end
		where id = v_version.id
		returning * into v_version;
	end if;

	select * into v_dep
	from public.qorpera_company_site_deployments as dep
	where dep.version_id = v_version.id
	for update;

	if v_dep.id is null then
		select coalesce(max(dep.version_number), 0) + 1 into v_next_version
		from public.qorpera_company_site_deployments as dep
		where dep.site_id = v_site.id;

		insert into public.qorpera_company_site_deployments (
			site_id, profile_id, version_number, version_id, kind, state,
			manifest_sha256, manifest_json, file_count, total_bytes,
			oci_image_ref, app_port, health_path, idle_timeout_sec, memory_mb, vcpu_limit,
			has_credential_inputs, upstream_addr, change_number, main_sha, env_spec, live_at, updated_at, last_stop_attempt_at
		) values (
			v_site.id,
			v_site.profile_id,
			v_next_version,
			v_version.id,
			v_kind,
			case when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then 'live' else 'ready' end,
			p_manifest_sha256,
			p_manifest_json,
			p_file_count,
			p_total_bytes,
			v_oci_image_ref,
			p_app_port,
			v_health_path,
			v_idle_timeout_sec,
			v_memory_mb,
			v_vcpu_limit,
			coalesce(p_has_credential_inputs, false),
			v_upstream_addr,
			v_version.change,
			v_version.main_sha,
			v_env_spec,
			case when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then v_now else null end,
			v_now,
			null
		)
		returning * into v_dep;
	else
		update public.qorpera_company_site_deployments
		set
			kind = v_kind,
			state = case
				when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then 'live'
				when state = 'stopped' then 'ready'
				else state
			end,
			manifest_sha256 = p_manifest_sha256,
			manifest_json = p_manifest_json,
			file_count = p_file_count,
			total_bytes = p_total_bytes,
			oci_image_ref = v_oci_image_ref,
			app_port = p_app_port,
			health_path = v_health_path,
			idle_timeout_sec = v_idle_timeout_sec,
			memory_mb = v_memory_mb,
			vcpu_limit = v_vcpu_limit,
			has_credential_inputs = coalesce(p_has_credential_inputs, false),
			upstream_addr = coalesce(v_upstream_addr, upstream_addr),
			env_spec = v_env_spec,
			live_at = case
				when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then coalesce(live_at, v_now)
				else live_at
			end,
			stopped_at = case
				when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id or state = 'stopped' then null
				else stopped_at
			end,
			updated_at = v_now,
			last_stop_attempt_at = null
		where id = v_dep.id
		returning * into v_dep;
	end if;

	if coalesce(p_promote_live, false) then
		update public.qorpera_company_site_deployments
		set
			state = case when kind in ('server', 'hybrid') then 'stopped' else 'ready' end,
			upstream_addr = case when kind in ('server', 'hybrid') then null else upstream_addr end,
			stopped_at = v_now
		where site_id = v_site.id and state = 'live' and id <> v_dep.id;

		update public.qorpera_company_sites
		set
			current_version_id = v_version.id,
			live_deployment_id = v_dep.id,
			deployment_kind = v_kind,
			storage_mode = 'blob',
			title = coalesce(v_title, title),
			updated_at = v_now
		where id = v_site.id;
	elsif v_site.current_version_id = v_version.id then
		update public.qorpera_company_sites
		set
			live_deployment_id = v_dep.id,
			deployment_kind = v_kind,
			storage_mode = 'blob',
			updated_at = v_now
		where id = v_site.id;
	end if;

	if v_surface.preview_mode in ('static_site', 'app_proxy') then
		update public.qorpera_surfaces
		set
			preview_mode = case when v_kind in ('server', 'hybrid') then 'app_proxy' else 'static_site' end,
			updated_at = v_now
		where id = v_surface.id
			and preview_mode is distinct from (case when v_kind in ('server', 'hybrid') then 'app_proxy' else 'static_site' end);
	end if;

	perform public.qorpera_code_site_prune(v_site.id);
	delete from public.qorpera_company_site_deployments
	where site_id = v_site.id
		and version_id is null
		and id is distinct from v_dep.id
		and state <> 'live'
		and (kind = 'static' or upstream_addr is null or state = 'stopped');

	perform pg_notify('qorpera_web_route_changes', 'surface_deployment');

	return jsonb_build_object(
		'siteId', v_site.id,
		'slug', v_site.slug,
		'versionId', v_version.id,
		'deploymentId', v_dep.id,
		'versionNumber', v_dep.version_number,
		'kind', v_dep.kind,
		'state', v_version.state,
		'deploymentState', v_dep.state
	);
end $$;

create function public.qorpera_surface_site_deployment_set_upstream(
	p_deployment_id uuid,
	p_upstream_addr text
)
returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_upstream text := nullif(btrim(coalesce(p_upstream_addr, '')), '');
	v_dep public.qorpera_company_site_deployments%rowtype;
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Surface site deployment upstream update requires service_role' using errcode = '42501';
	end if;
	if p_deployment_id is null
		or v_upstream is null
		or char_length(v_upstream) not between 3 and 255
		or v_upstream ~ '[[:cntrl:][:space:]]' then
		raise exception 'Surface site deployment upstream input is invalid' using errcode = '22023';
	end if;

	update public.qorpera_company_site_deployments
	set
		upstream_addr = v_upstream,
		updated_at = clock_timestamp(),
		last_stop_attempt_at = null
	where id = p_deployment_id
		and kind in ('server', 'hybrid')
		and state <> 'stopped'
	returning * into v_dep;

	if v_dep.id is null then
		raise exception 'Hosted app deployment not found' using errcode = 'P0002';
	end if;

	perform pg_notify('qorpera_web_route_changes', 'deployment_upstream');

	return jsonb_build_object(
		'deploymentId', v_dep.id,
		'siteId', v_dep.site_id,
		'upstreamAddr', v_dep.upstream_addr,
		'state', v_dep.state
	);
end $$;

create function public.qorpera_surface_stale_app_deployments_due(
	p_limit integer default 16
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_limit integer := least(greatest(coalesce(p_limit, 16), 1), 64);
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Stale app deployment lookup requires service_role' using errcode = '42501';
	end if;

	return coalesce(
		(
			select jsonb_agg(
				jsonb_build_object(
					'deploymentId', row.id,
					'siteId', row.site_id,
					'profileId', row.profile_id,
					'upstreamAddr', row.upstream_addr
				)
				order by row.sort_at asc, row.id asc
			)
			from (
				select dep.id, dep.site_id, dep.profile_id, dep.upstream_addr,
					coalesce(dep.last_stop_attempt_at, dep.updated_at, dep.created_at) as sort_at
				from public.qorpera_company_site_deployments dep
				join public.qorpera_company_sites site on site.id = dep.site_id
				where dep.kind in ('server', 'hybrid')
					and dep.state in ('ready', 'building')
					and dep.upstream_addr is not null
					and dep.id is distinct from site.live_deployment_id
					and (dep.version_id is null or dep.version_id is distinct from site.current_version_id)
					and (dep.last_stop_attempt_at is null or dep.last_stop_attempt_at < v_now - interval '5 minutes')
					and not exists (
						select 1
						from public.qorpera_surface_previews sp
						where sp.site_version_id = dep.version_id
							and sp.status in ('composing', 'building', 'ready')
							and sp.expires_at > v_now
					)
					and not exists (
						select 1
						from public.qorpera_company_site_tickets tk
						where tk.site_id = dep.site_id
							and tk.version_id = dep.version_id
							and tk.expires_at > v_now
					)
					and not exists (
						select 1
						from public.qorpera_company_site_member_passes mp
						where mp.site_id = dep.site_id
							and mp.version_id = dep.version_id
							and mp.expires_at > v_now
					)
					and (
						dep.version_id is null
						or dep.updated_at < v_now - interval '2 minutes'
						or exists (
							select 1
							from public.qorpera_surface_previews sp
							where sp.site_version_id = dep.version_id
								and (
									(sp.expires_at <= v_now and sp.expires_at >= dep.updated_at)
									or (sp.status in ('failed', 'conflicted') and sp.updated_at >= dep.updated_at)
								)
						)
						or exists (
							select 1
							from public.qorpera_surfaces sf
							where sf.site_id = dep.site_id and sf.status = 'archived'
						)
					)
				order by coalesce(dep.last_stop_attempt_at, dep.updated_at, dep.created_at) asc, dep.id asc
				limit v_limit
			) as row
		),
		'[]'::jsonb
	);
end $$;

create function public.qorpera_surface_app_deployment_mark_stopped(
	p_deployment_id uuid,
	p_expected_upstream_addr text default null,
	p_force boolean default false,
	p_stop_failed boolean default false,
	p_claim_only boolean default false
)
returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_expected_upstream text := nullif(btrim(coalesce(p_expected_upstream_addr, '')), '');
	v_now timestamptz := clock_timestamp();
	v_is_live boolean := false;
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'App deployment stop marker requires service_role' using errcode = '42501';
	end if;
	if p_deployment_id is null then
		raise exception 'Deployment id is required' using errcode = '22023';
	end if;

	if coalesce(p_claim_only, false) then
		if coalesce(p_force, false) then
			select dep.* into v_dep
			from public.qorpera_company_site_deployments dep
			where dep.id = p_deployment_id
			for update;
			if v_dep.id is null then
				return jsonb_build_object(
					'claimed', false,
					'stopped', false,
					'isLive', false,
					'deploymentId', p_deployment_id
				);
			end if;
			select * into v_site
			from public.qorpera_company_sites
			where id = v_dep.site_id;
			v_is_live := v_dep.state = 'live'
				or v_dep.id = v_site.live_deployment_id
				or (v_dep.version_id is not null and v_dep.version_id = v_site.current_version_id);
			return jsonb_build_object(
				'claimed', (not v_is_live) and v_dep.kind in ('server', 'hybrid') and v_dep.state <> 'stopped',
				'stopped', false,
				'isLive', v_is_live,
				'deploymentId', p_deployment_id
			);
		end if;

		update public.qorpera_company_site_deployments dep
		set last_stop_attempt_at = v_now
		from public.qorpera_company_sites site
		where dep.id = p_deployment_id
			and site.id = dep.site_id
			and dep.kind in ('server', 'hybrid')
			and dep.state in ('ready', 'building')
			and dep.upstream_addr is not null
			and dep.id is distinct from site.live_deployment_id
			and (v_expected_upstream is null or dep.upstream_addr = v_expected_upstream)
			and (dep.version_id is null or dep.version_id is distinct from site.current_version_id)
			and (dep.last_stop_attempt_at is null or dep.last_stop_attempt_at < v_now - interval '5 minutes')
			and not exists (
				select 1
				from public.qorpera_surface_previews sp
				where sp.site_version_id = dep.version_id
					and sp.status in ('composing', 'building', 'ready')
					and sp.expires_at > v_now
			)
			and not exists (
				select 1
				from public.qorpera_company_site_tickets tk
				where tk.site_id = dep.site_id
					and tk.version_id = dep.version_id
					and tk.expires_at > v_now
			)
			and not exists (
				select 1
				from public.qorpera_company_site_member_passes mp
				where mp.site_id = dep.site_id
					and mp.version_id = dep.version_id
					and mp.expires_at > v_now
			)
			and (
				dep.version_id is null
				or dep.updated_at < v_now - interval '2 minutes'
				or exists (
					select 1
					from public.qorpera_surface_previews sp
					where sp.site_version_id = dep.version_id
						and (
							(sp.expires_at <= v_now and sp.expires_at >= dep.updated_at)
							or (sp.status in ('failed', 'conflicted') and sp.updated_at >= dep.updated_at)
						)
				)
				or exists (
					select 1
					from public.qorpera_surfaces sf
					where sf.site_id = dep.site_id and sf.status = 'archived'
				)
			)
		returning dep.* into v_dep;

		return jsonb_build_object(
			'claimed', v_dep.id is not null,
			'stopped', false,
			'deploymentId', p_deployment_id
		);
	end if;

	if coalesce(p_stop_failed, false) then
		update public.qorpera_company_site_deployments dep
		set last_stop_attempt_at = v_now
		from public.qorpera_company_sites site
		where dep.id = p_deployment_id
			and site.id = dep.site_id
			and dep.kind in ('server', 'hybrid')
			and dep.state <> 'live'
			and dep.id is distinct from site.live_deployment_id
			and (v_expected_upstream is null or dep.upstream_addr = v_expected_upstream)
		returning dep.* into v_dep;

		return jsonb_build_object(
			'stopped', false,
			'backedOff', v_dep.id is not null,
			'deploymentId', p_deployment_id
		);
	end if;

	update public.qorpera_company_site_deployments dep
	set
		state = 'stopped',
		upstream_addr = null,
		stopped_at = coalesce(dep.stopped_at, v_now),
		updated_at = v_now,
		last_stop_attempt_at = null
	from public.qorpera_company_sites site
	where dep.id = p_deployment_id
		and site.id = dep.site_id
		and dep.kind in ('server', 'hybrid')
		and dep.state <> 'live'
		and dep.id is distinct from site.live_deployment_id
		and (dep.version_id is null or dep.version_id is distinct from site.current_version_id)
		and (
			coalesce(p_force, false)
			or (
				(v_expected_upstream is null or dep.upstream_addr = v_expected_upstream)
				and not exists (
					select 1
					from public.qorpera_surface_previews sp
					where sp.site_version_id = dep.version_id
						and sp.status in ('composing', 'building', 'ready')
						and sp.expires_at > v_now
				)
				and not exists (
					select 1
					from public.qorpera_company_site_tickets tk
					where tk.site_id = dep.site_id
						and tk.version_id = dep.version_id
						and tk.expires_at > v_now
				)
				and not exists (
					select 1
					from public.qorpera_company_site_member_passes mp
					where mp.site_id = dep.site_id
						and mp.version_id = dep.version_id
						and mp.expires_at > v_now
				)
				and (
					dep.version_id is null
					or dep.updated_at < v_now - interval '2 minutes'
					or exists (
						select 1
						from public.qorpera_surface_previews sp
						where sp.site_version_id = dep.version_id
							and (
								(sp.expires_at <= v_now and sp.expires_at >= dep.updated_at)
								or (sp.status in ('failed', 'conflicted') and sp.updated_at >= dep.updated_at)
							)
					)
					or exists (
						select 1
						from public.qorpera_surfaces sf
						where sf.site_id = dep.site_id and sf.status = 'archived'
					)
				)
			)
		)
	returning dep.* into v_dep;

	if v_dep.id is not null then
		perform pg_notify('qorpera_web_route_changes', 'deployment_stopped');
		return jsonb_build_object('stopped', true, 'deploymentId', v_dep.id, 'state', v_dep.state);
	end if;

	return jsonb_build_object('stopped', false, 'deploymentId', p_deployment_id);
end $$;

select pg_temp.sahs_patch(
	'public.qorpera_surface_preview_build_settle(uuid)'::regprocedure,
	array[
$old$	elsif v_build.state = 'built' and v_build.manifest_json is not null and v_build.manifest_sha256 is not null then$old$,
$new$	elsif v_build.state = 'built' and not coalesce(v_build.defer_settle, false) and v_build.manifest_json is not null and v_build.manifest_sha256 is not null then$new$,
$old$		if v_build.state = 'built' and v_build.manifest_json is not null and v_build.manifest_sha256 is not null then$old$,
$new$		if v_build.state = 'built' and not coalesce(v_build.defer_settle, false) and v_build.manifest_json is not null and v_build.manifest_sha256 is not null then$new$
	]
);

select pg_temp.sahs_patch(
	'public.qorpera_web_edge_snapshot()'::regprocedure,
	array[
$old$					where dep.site_id = site.id
						and dep.version_id is not null
						and ver.state in ('ready', 'live', 'kept')$old$,
$new$					where dep.site_id = site.id
						and dep.version_id is not null
						and dep.state <> 'stopped'
						and ver.state in ('ready', 'live', 'kept')$new$
	]
);

do $$
declare
	v_def text;
begin
	v_def := pg_get_functiondef('public.qorpera_surface_request_build(text,uuid,uuid,text,text,jsonb,text)'::regprocedure);
	v_def := pg_temp.sahs_apply(v_def, 'qorpera_surface_request_build', array[
		'p_stale_built_tree text DEFAULT NULL::text)',
		'p_stale_built_tree text DEFAULT NULL::text, p_defer_settle boolean DEFAULT false)',
$old$		insert into public.qorpera_surface_preview_builds(
			profile_id, surface_id, builder_id, repository_key, commit_sha, tree_sha, recipe, recipe_sha256
		)
		values (
			v_surface.profile_id, v_surface.id, v_builder.id, coalesce(v_surface.repository_key, 'surfaces/' || lower(v_surface.slug)),
			p_commit_sha, p_tree_sha, p_recipe, v_recipe_sha
		)
		returning * into v_build;
	elsif v_build.state in ('built', 'failed', 'dropped') then
		update public.qorpera_surface_preview_builds
		set state = 'queued', builder_id = v_builder.id, commit_sha = p_commit_sha, built_tree_sha = null,
			manifest_sha256 = null, manifest_json = null, file_count = null, total_bytes = null, has_credential_inputs = false,
			error_detail = null, worker_id = null, worker_sequence = null, attempts = 0, queued_at = v_now,
			started_at = null, finished_at = null, updated_at = v_now
		where id = v_build.id
		returning * into v_build;
	end if;$old$,
$new$		insert into public.qorpera_surface_preview_builds(
			profile_id, surface_id, builder_id, repository_key, commit_sha, tree_sha, recipe, recipe_sha256, defer_settle
		)
		values (
			v_surface.profile_id, v_surface.id, v_builder.id, coalesce(v_surface.repository_key, 'surfaces/' || lower(v_surface.slug)),
			p_commit_sha, p_tree_sha, p_recipe, v_recipe_sha, coalesce(p_defer_settle, false)
		)
		returning * into v_build;
	elsif v_build.state in ('built', 'failed', 'dropped') then
		update public.qorpera_surface_preview_builds
		set state = 'queued', builder_id = v_builder.id, commit_sha = p_commit_sha, built_tree_sha = null,
			manifest_sha256 = null, manifest_json = null, file_count = null, total_bytes = null, has_credential_inputs = false,
			defer_settle = coalesce(p_defer_settle, false),
			error_detail = null, worker_id = null, worker_sequence = null, attempts = 0, queued_at = v_now,
			started_at = null, finished_at = null, updated_at = v_now
		where id = v_build.id
		returning * into v_build;
	elsif coalesce(p_defer_settle, false) and not v_build.defer_settle then
		update public.qorpera_surface_preview_builds
		set defer_settle = true, updated_at = v_now
		where id = v_build.id
		returning * into v_build;
	end if;$new$
	]);
	drop function public.qorpera_surface_request_build(text, uuid, uuid, text, text, jsonb, text);
	execute v_def;
end $$;

revoke all on function
	public.qorpera_surface_site_deployment_register(uuid, text, text, jsonb, integer, bigint, boolean, boolean, text, text, text, text, integer, text, integer, integer, numeric, text, jsonb, boolean),
	public.qorpera_surface_site_deployment_set_upstream(uuid, text),
	public.qorpera_surface_stale_app_deployments_due(integer),
	public.qorpera_surface_app_deployment_mark_stopped(uuid, text, boolean, boolean, boolean),
	public.qorpera_surface_request_build(text, uuid, uuid, text, text, jsonb, text, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

grant execute on function
	public.qorpera_surface_site_deployment_register(uuid, text, text, jsonb, integer, bigint, boolean, boolean, text, text, text, text, integer, text, integer, integer, numeric, text, jsonb, boolean),
	public.qorpera_surface_site_deployment_set_upstream(uuid, text),
	public.qorpera_surface_stale_app_deployments_due(integer),
	public.qorpera_surface_app_deployment_mark_stopped(uuid, text, boolean, boolean, boolean),
	public.qorpera_surface_request_build(text, uuid, uuid, text, text, jsonb, text, boolean)
	to service_role;

do $$
declare
	v_bad text;
	v_owner text;
begin
	select string_agg(p.oid::regprocedure::text, ', ') into v_bad
	from pg_proc p
	join sahs_before b on b.oid = p.oid
	where (to_jsonb(p) - 'prosrc') is distinct from b.fields;
	if v_bad is not null then
		raise exception '20260930935000 changed function metadata on: %', v_bad;
	end if;

	for v_owner in
		select distinct pg_get_userbyid(p.proowner)
		from pg_proc p
		where p.pronamespace = 'public'::regnamespace
			and p.proname in (
				'qorpera_surface_site_deployment_register',
				'qorpera_surface_site_deployment_set_upstream',
				'qorpera_surface_stale_app_deployments_due',
				'qorpera_surface_app_deployment_mark_stopped',
				'qorpera_surface_request_build'
			)
	loop
		if v_owner <> 'postgres' then
			execute format(
				'grant select, insert, update, delete on table '
				'public.qorpera_surfaces, public.qorpera_company_sites, public.qorpera_company_site_versions, '
				'public.qorpera_company_site_deployments, public.qorpera_surface_previews, public.qorpera_surface_jobs, '
				'public.qorpera_surface_preview_builders, public.qorpera_surface_preview_builds, '
				'public.qorpera_company_site_tickets, public.qorpera_company_site_member_passes, '
				'public.qorpera_profile_members to %I',
				v_owner
			);
			execute format(
				'grant execute on function '
				'public.qorpera_company_deleting(uuid), public.qorpera_code_site_prune(uuid), '
				'public.qorpera_surface_preview_recipe_valid(jsonb), public.qorpera_company_coding_at_zero(uuid, timestamptz), '
				'public.qorpera_surface_preview_build_detail(text, text), public.qorpera_surface_build_waiter_fail(text, uuid, text), '
				'public.qorpera_surface_preview_selected(uuid), public.qorpera_surface_preview_build_settle(uuid), '
				'public.qorpera_surface_preview_builder_kick(uuid), public.qorpera_surface_preview_kick_failed(uuid, text) to %I',
				v_owner
			);
		end if;
	end loop;
end $$;
