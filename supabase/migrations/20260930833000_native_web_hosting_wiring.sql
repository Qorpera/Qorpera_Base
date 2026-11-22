do $$
begin
	if to_regclass('public.qorpera_company_site_domains') is null
		or to_regclass('public.qorpera_company_site_deployments') is null then
		raise exception '20260930833000 requires native web hosting (20260930832000)';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_company_site_deployments'
			and column_name = 'version_id'
	) then
		raise exception '20260930833000 (native web hosting wiring) is already applied';
	end if;
end $$;

set local lock_timeout = '3s';

do $$
declare v_con text;
begin
	for v_con in
		select con.conname
		from pg_constraint as con
		where con.conrelid = 'public.qorpera_company_site_versions'::regclass
			and con.contype = 'c'
			and (
				pg_get_constraintdef(con.oid) like '%file_count%'
				or pg_get_constraintdef(con.oid) like '%total_bytes%'
			)
	loop
		execute format('alter table public.qorpera_company_site_versions drop constraint %I', v_con);
	end loop;
end $$;

alter table public.qorpera_company_site_versions
	add constraint qorpera_company_site_versions_file_count check (file_count between 0 and 10000),
	add constraint qorpera_company_site_versions_total_bytes check (total_bytes between 0 and 536870912);

alter table public.qorpera_company_site_deployments
	add column version_id uuid unique references public.qorpera_company_site_versions(id) on delete set null,
	add column change_number integer check (change_number is null or change_number >= 1),
	add column main_sha text check (main_sha is null or main_sha ~ '^[0-9a-f]{40}$'),
	add column env_spec jsonb not null default '{}'::jsonb check (jsonb_typeof(env_spec) = 'object');

create index qorpera_company_site_deployments_version
	on public.qorpera_company_site_deployments(version_id)
	where version_id is not null;

create or replace function public.qorpera_code_site_valid(p_site jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(case when jsonb_typeof(p_site) = 'object' and pg_column_size(p_site) <= 2048 then
		case p_site -> 'schema'
		when '"qorpera.code-site/v1"'::jsonb then
			p_site ?& array['schema','tree','files','bytes','folder','name','title']
			and p_site - array['schema','tree','files','bytes','folder','name','title'] = '{}'::jsonb
			and public.qorpera_code_json_text(p_site -> 'tree', '^[0-9a-f]{40}$')
			and case when public.qorpera_code_json_count(p_site -> 'files') then (p_site ->> 'files')::bigint between 1 and 500
				else false end
			and case when public.qorpera_code_json_count(p_site -> 'bytes') then (p_site ->> 'bytes')::bigint <= 26214400
				else false end
			and case when jsonb_typeof(p_site -> 'folder') = 'string' then p_site ->> 'folder' = '.'
					or (octet_length(p_site ->> 'folder') between 1 and 300 and p_site ->> 'folder' !~ '[[:cntrl:]\\]'
						and not exists (select 1 from unnest(string_to_array(p_site ->> 'folder', '/')) part
							where part in ('', '.', '..')))
				else false end
			and case jsonb_typeof(p_site -> 'name') when 'null' then true
				when 'string' then public.qorpera_site_slug_valid(p_site ->> 'name') else false end
			and case jsonb_typeof(p_site -> 'title') when 'null' then true
				when 'string' then char_length(p_site ->> 'title') between 1 and 120 and p_site ->> 'title' !~ '[[:cntrl:]]'
					and p_site ->> 'title' = btrim(p_site ->> 'title')
				else false end
		when '"qorpera.code-site/v2"'::jsonb then
			p_site ?& array['schema','kind','tree','files','bytes','folder','name','title']
			and p_site - array[
				'schema','kind','tree','files','bytes','folder','name','title',
				'port','healthPath','dockerfile','idleTimeoutSec','memoryMb','vcpuLimit','spaFallback'
			] = '{}'::jsonb
			and p_site ->> 'kind' in ('static', 'server', 'hybrid')
			and public.qorpera_code_json_text(p_site -> 'tree', '^[0-9a-f]{40}$')
			and case when public.qorpera_code_json_count(p_site -> 'files') then
					(p_site ->> 'files')::bigint between (case when p_site ->> 'kind' = 'static' then 1 else 0 end) and 10000
				else false end
			and case when public.qorpera_code_json_count(p_site -> 'bytes') then
					(p_site ->> 'bytes')::bigint between 0 and 536870912
				else false end
			and case when jsonb_typeof(p_site -> 'folder') = 'string' then p_site ->> 'folder' = '.'
					or (octet_length(p_site ->> 'folder') between 1 and 300 and p_site ->> 'folder' !~ '[[:cntrl:]\\]'
						and not exists (select 1 from unnest(string_to_array(p_site ->> 'folder', '/')) part
							where part in ('', '.', '..')))
				else false end
			and case jsonb_typeof(p_site -> 'name') when 'null' then true
				when 'string' then public.qorpera_site_slug_valid(p_site ->> 'name') else false end
			and case jsonb_typeof(p_site -> 'title') when 'null' then true
				when 'string' then char_length(p_site ->> 'title') between 1 and 120 and p_site ->> 'title' !~ '[[:cntrl:]]'
					and p_site ->> 'title' = btrim(p_site ->> 'title')
				else false end
			and (not (p_site ? 'port') or p_site -> 'port' = 'null'::jsonb
				or (public.qorpera_code_json_count(p_site -> 'port') and (p_site ->> 'port')::bigint between 1 and 65535))
			and (not (p_site ? 'healthPath') or p_site -> 'healthPath' = 'null'::jsonb
				or (jsonb_typeof(p_site -> 'healthPath') = 'string'
					and char_length(p_site ->> 'healthPath') between 1 and 256
					and left(p_site ->> 'healthPath', 1) = '/'
					and p_site ->> 'healthPath' !~ '[[:cntrl:][:space:]]'))
			and (not (p_site ? 'dockerfile') or p_site -> 'dockerfile' = 'null'::jsonb
				or (jsonb_typeof(p_site -> 'dockerfile') = 'string'
					and octet_length(p_site ->> 'dockerfile') between 1 and 300
					and p_site ->> 'dockerfile' !~ '[[:cntrl:]\\]'
					and not exists (select 1 from unnest(string_to_array(p_site ->> 'dockerfile', '/')) part
						where part in ('', '.', '..'))))
			and (not (p_site ? 'idleTimeoutSec') or p_site -> 'idleTimeoutSec' = 'null'::jsonb
				or (public.qorpera_code_json_count(p_site -> 'idleTimeoutSec') and (p_site ->> 'idleTimeoutSec')::bigint between 0 and 86400))
			and (not (p_site ? 'memoryMb') or p_site -> 'memoryMb' = 'null'::jsonb
				or (public.qorpera_code_json_count(p_site -> 'memoryMb') and (p_site ->> 'memoryMb')::bigint between 64 and 8192))
			and (not (p_site ? 'vcpuLimit') or p_site -> 'vcpuLimit' = 'null'::jsonb
				or (jsonb_typeof(p_site -> 'vcpuLimit') = 'number' and (p_site ->> 'vcpuLimit')::numeric between 0.25 and 8.00))
			and (not (p_site ? 'spaFallback') or p_site -> 'spaFallback' = 'null'::jsonb
				or (jsonb_typeof(p_site -> 'spaFallback') = 'string'
					and char_length(p_site ->> 'spaFallback') between 1 and 512
					and p_site ->> 'spaFallback' !~ '[[:cntrl:]\\]'
					and not exists (select 1 from unnest(string_to_array(p_site ->> 'spaFallback', '/')) part
						where part in ('', '.', '..'))))
		else false end
	else false end, false)
$$;

create function public.qorpera_web_sync_live_deployment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_dep public.qorpera_company_site_deployments%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if new.current_version_id is not distinct from old.current_version_id then
		return new;
	end if;
	if new.current_version_id is null then
		new.live_deployment_id := null;
		return new;
	end if;
	select dep.* into v_dep
	from public.qorpera_company_site_deployments as dep
	where dep.site_id = new.id and dep.version_id = new.current_version_id
	for update;
	if not found then
		if old.live_deployment_id is not null then
			update public.qorpera_company_site_deployments
			set state = 'ready', stopped_at = v_now
			where site_id = new.id and state = 'live';
			new.live_deployment_id := null;
			new.storage_mode := 'db';
		end if;
		return new;
	end if;
	if new.is_public and coalesce(v_dep.has_credential_inputs, false) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;
	update public.qorpera_company_site_deployments
	set state = 'ready', stopped_at = v_now
	where site_id = new.id and state = 'live' and id <> v_dep.id;
	update public.qorpera_company_site_deployments
	set state = 'live', live_at = v_now, stopped_at = null
	where id = v_dep.id;
	new.live_deployment_id := v_dep.id;
	new.deployment_kind := v_dep.kind;
	new.storage_mode := 'blob';
	return new;
end $$;

revoke all on function public.qorpera_web_sync_live_deployment()
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

create trigger qorpera_web_sync_live_deployment_trigger
	before update of current_version_id on public.qorpera_company_sites
	for each row execute function public.qorpera_web_sync_live_deployment();

create function public.qorpera_web_code_deployment_register(
	p_owner text,
	p_machine_id_sha256 text,
	p_environment_id uuid,
	p_repository_owner text,
	p_name text,
	p_change integer,
	p_kind text,
	p_manifest_sha256 text,
	p_manifest_json jsonb,
	p_file_count integer,
	p_total_bytes bigint,
	p_oci_image_ref text default null,
	p_app_port integer default null,
	p_health_path text default '/',
	p_idle_timeout_sec integer default 900,
	p_memory_mb integer default 512,
	p_vcpu_limit numeric default 1.00,
	p_has_credential_inputs boolean default false,
	p_upstream_addr text default null,
	p_env_spec jsonb default '{}'::jsonb
)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_repository public.qorpera_code_repositories%rowtype;
	v_row public.qorpera_code_changes%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_holder public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype;
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_slug text;
	v_next_version integer;
	v_now timestamptz := clock_timestamp();
	v_pruned integer;
	c_schema constant text := 'qorpera.web-code-deployment/v1';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_repository_owner is null or p_name is null or p_change is null or p_change < 1
		or p_kind not in ('static', 'server', 'hybrid')
		or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(coalesce(p_manifest_json, '{}'::jsonb)) <> 'object'
		or jsonb_typeof(coalesce(p_env_spec, '{}'::jsonb)) <> 'object'
		or p_file_count is null or p_file_count not between 0 and 10000
		or p_total_bytes is null or p_total_bytes not between 0 and 536870912
		or (p_kind <> 'static' and p_oci_image_ref is null) then
		raise exception 'Code web deployment register invalid' using errcode = '22023';
	end if;
	perform 1 from public.qorpera_profiles as profile
	where profile.id = (
		select repo.profile_id from public.qorpera_code_repositories as repo
		where repo.environment_id = p_environment_id and repo.owner = p_repository_owner and repo.name = p_name
	) for key share;
	select * into v_repository
	from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name
	for update;
	if not found
		or not public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256)
		or exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = v_repository.profile_id) then
		return jsonb_build_object('schema', c_schema, 'state', 'lost');
	end if;
	select * into v_row
	from public.qorpera_code_changes as ch
	where ch.environment_id = p_environment_id and ch.owner = p_repository_owner and ch.name = p_name and ch.n = p_change;
	if v_row.site_state is distinct from 'made' then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_ROW_GONE');
	end if;
	if v_repository.site_id is not null then
		select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	end if;
	if v_site.id is null then
		perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.company-sites:' || v_repository.profile_id::text, 0));
		if (select count(*) from public.qorpera_company_sites as s where s.profile_id = v_repository.profile_id) >= 10 then
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_LIMIT');
		end if;
		foreach v_slug in array public.qorpera_code_site_slugs(p_name, v_row.site ->> 'name') loop
			select s.* into v_holder from public.qorpera_company_sites as s where s.slug = v_slug;
			if found then
				continue when not public.qorpera_site_abandoned(v_holder);
				begin
					select s.* into v_holder from public.qorpera_company_sites as s where s.id = v_holder.id for update skip locked;
					if not found or not public.qorpera_site_abandoned(v_holder) then
						raise exception 'holder busy' using errcode = 'QCS01';
					end if;
					delete from public.qorpera_company_sites where id = v_holder.id;
				exception when sqlstate 'QCS01' then
					continue;
				end;
			end if;
			insert into public.qorpera_company_sites (
				profile_id, environment_id, slug, title, source_path,
				created_by_staff_agent_id, code_owner, code_name, deployment_kind, storage_mode
			) values (
				v_repository.profile_id, p_environment_id, v_slug, v_row.site ->> 'title',
				format('code/%s/%s', p_repository_owner, p_name), v_row.staff_agent_id,
				p_repository_owner, p_name, p_kind, 'blob'
			) on conflict (slug) do nothing
			returning * into v_site;
			exit when v_site.id is not null;
		end loop;
		if v_site.id is null then
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_NAME_TAKEN');
		end if;
		insert into public.qorpera_company_site_secrets (site_id, password)
		values (v_site.id, public.qorpera_site_new_password());
		update public.qorpera_code_repositories
		set site_id = v_site.id
		where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
	end if;
	if v_site.taken_down_at is not null then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_TAKEN_DOWN');
	end if;
	select * into v_version
	from public.qorpera_company_site_versions as ver
	where ver.site_id = v_site.id and ver.tree = v_row.site ->> 'tree'
	for update;
	if not found then
		insert into public.qorpera_company_site_versions (
			site_id, state, first_publish, title, source_path, manifest_sha256,
			file_count, total_bytes, tree, change, main_sha, listed
		) values (
			v_site.id, 'ready', v_site.current_version_id is null, v_row.site ->> 'title',
			v_site.source_path, p_manifest_sha256, p_file_count, p_total_bytes,
			v_row.site ->> 'tree', v_row.n, v_row.main_after, true
		) returning * into v_version;
	else
		if v_version.state = 'uploading' then
			update public.qorpera_company_site_versions
			set state = 'ready', listed = true, manifest_sha256 = p_manifest_sha256,
				file_count = p_file_count, total_bytes = p_total_bytes
			where id = v_version.id
			returning * into v_version;
		end if;
	end if;
	select * into v_dep
	from public.qorpera_company_site_deployments as dep
	where dep.version_id = v_version.id
	for update;
	if not found then
		select coalesce(max(dep.version_number), 0) + 1 into v_next_version
		from public.qorpera_company_site_deployments as dep
		where dep.site_id = v_site.id;
		insert into public.qorpera_company_site_deployments (
			site_id, profile_id, version_number, version_id, kind, state, manifest_sha256, manifest_json,
			file_count, total_bytes, oci_image_ref, app_port, health_path, idle_timeout_sec,
			memory_mb, vcpu_limit, has_credential_inputs, upstream_addr, change_number, main_sha, env_spec, live_at
		) values (
			v_site.id, v_site.profile_id, v_next_version, v_version.id, p_kind,
			case when v_site.current_version_id = v_version.id then 'live' else 'ready' end,
			p_manifest_sha256, coalesce(p_manifest_json, '{}'::jsonb), p_file_count, p_total_bytes,
			p_oci_image_ref, p_app_port, coalesce(p_health_path, '/'), coalesce(p_idle_timeout_sec, 900),
			coalesce(p_memory_mb, 512), coalesce(p_vcpu_limit, 1.00), p_has_credential_inputs, p_upstream_addr,
			v_row.n, v_row.main_after, coalesce(p_env_spec, '{}'::jsonb),
			case when v_site.current_version_id = v_version.id then v_now else null end
		) returning * into v_dep;
	else
		update public.qorpera_company_site_deployments
		set kind = p_kind,
			manifest_sha256 = p_manifest_sha256,
			manifest_json = coalesce(p_manifest_json, '{}'::jsonb),
			file_count = p_file_count,
			total_bytes = p_total_bytes,
			oci_image_ref = p_oci_image_ref,
			app_port = p_app_port,
			health_path = coalesce(p_health_path, '/'),
			idle_timeout_sec = coalesce(p_idle_timeout_sec, 900),
			memory_mb = coalesce(p_memory_mb, 512),
			vcpu_limit = coalesce(p_vcpu_limit, 1.00),
			has_credential_inputs = p_has_credential_inputs,
			upstream_addr = coalesce(p_upstream_addr, upstream_addr),
			env_spec = coalesce(p_env_spec, '{}'::jsonb)
		where id = v_dep.id
		returning * into v_dep;
	end if;
	if v_site.current_version_id = v_version.id then
		update public.qorpera_company_sites
		set live_deployment_id = v_dep.id, deployment_kind = v_dep.kind, storage_mode = 'blob', updated_at = v_now
		where id = v_site.id;
	else
		update public.qorpera_company_sites set updated_at = v_now where id = v_site.id;
	end if;
	update public.qorpera_code_repositories
	set site_attempts = 0, site_change = null, site_not_before = null,
		site_problem = null, site_given_up = null, index_version = index_version + 1
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
	v_pruned := public.qorpera_code_site_prune(v_site.id);
	return jsonb_build_object(
		'schema', c_schema,
		'state', v_version.state,
		'siteId', v_site.id,
		'slug', v_site.slug,
		'versionId', v_version.id,
		'deploymentId', v_dep.id,
		'versionNumber', v_dep.version_number,
		'kind', v_dep.kind,
		'pruned', v_pruned
	);
end $$;

create or replace function public.qorpera_web_edge_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_settings public.qorpera_site_settings%rowtype;
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Edge snapshot requires service_role' using errcode = '42501';
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	return jsonb_build_object(
		'hosts_domain', coalesce(v_settings.hosts_domain, 'qorpera.site'),
		'legacy_hosts_domains', case
			when v_settings.hosts_domain = 'qorpera.site' then jsonb_build_array('qorpera.com')
			else '[]'::jsonb
		end,
		'hosts_enabled', coalesce(v_settings.enabled and v_settings.hosts_enabled, false),
		'public_enabled', coalesce(v_settings.enabled and v_settings.public_enabled, false),
		'domains_enabled', coalesce(v_settings.enabled and v_settings.domains_enabled, false),
		'edge_ipv4', host(v_settings.edge_ipv4),
		'edge_ipv6', host(v_settings.edge_ipv6),
		'edge_cname_target', v_settings.edge_cname_target,
		'sites', coalesce((
			select jsonb_agg(jsonb_build_object(
				'id', site.id,
				'slug', site.slug,
				'is_public', site.is_public,
				'taken_down', site.taken_down_at is not null,
				'password_sha256', (
					select encode(extensions.digest(convert_to(sec.password, 'utf8'), 'sha256'), 'hex')
					from public.qorpera_company_site_secrets as sec
					where sec.site_id = site.id
				),
				'password_version', site.password_version,
				'primary_custom_domain', (
					select dom.hostname
					from public.qorpera_company_site_domains as dom
					where dom.site_id = site.id
						and dom.is_primary
						and dom.status in ('dns_verified', 'tls_active')
					limit 1
				),
				'live_deployment', (
					select jsonb_build_object(
						'id', dep.id,
						'kind', dep.kind,
						'manifest', coalesce(dep.manifest_json, '{}'::jsonb),
						'upstream_addr', dep.upstream_addr,
						'oci_image_ref', dep.oci_image_ref,
						'app_port', dep.app_port,
						'health_path', coalesce(dep.health_path, '/'),
						'idle_timeout_sec', coalesce(dep.idle_timeout_sec, 900),
						'memory_mb', coalesce(dep.memory_mb, 512),
						'vcpu_limit', coalesce(dep.vcpu_limit, 1.00),
						'env_spec', coalesce(dep.env_spec, '{}'::jsonb)
					)
					from public.qorpera_company_site_deployments as dep
					where dep.id = site.live_deployment_id
				),
				'preview_deployments', coalesce((
					select jsonb_object_agg(
						dep.version_id::text,
						jsonb_build_object(
							'id', dep.id,
							'kind', dep.kind,
							'manifest', coalesce(dep.manifest_json, '{}'::jsonb),
							'upstream_addr', dep.upstream_addr,
							'oci_image_ref', dep.oci_image_ref,
							'app_port', dep.app_port,
							'health_path', coalesce(dep.health_path, '/'),
							'idle_timeout_sec', coalesce(dep.idle_timeout_sec, 900),
							'memory_mb', coalesce(dep.memory_mb, 512),
							'vcpu_limit', coalesce(dep.vcpu_limit, 1.00),
							'env_spec', coalesce(dep.env_spec, '{}'::jsonb)
						)
					)
					from public.qorpera_company_site_deployments as dep
					join public.qorpera_company_site_versions as ver on ver.id = dep.version_id
					where dep.site_id = site.id
						and dep.version_id is not null
						and ver.state in ('ready', 'live', 'kept')
				), '{}'::jsonb)
			) order by site.slug collate "C")
			from public.qorpera_company_sites as site
		), '[]'::jsonb),
		'custom_domains', coalesce((
			select jsonb_agg(jsonb_build_object(
				'id', dom.id,
				'site_id', dom.site_id,
				'hostname', dom.hostname,
				'is_apex', dom.is_apex,
				'is_primary', dom.is_primary,
				'status', dom.status,
				'verification_token', dom.verification_token,
				'last_checked_at', dom.last_checked_at,
				'consecutive_misses', dom.consecutive_misses
			) order by dom.hostname collate "C")
			from public.qorpera_company_site_domains as dom
		), '[]'::jsonb)
	);
end $$;

create function public.qorpera_web_edge_redeem_ticket(p_host text, p_ticket text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_host text := lower(btrim(coalesce(p_host, '')));
	v_host_of jsonb;
	v_site public.qorpera_company_sites%rowtype;
	v_ticket public.qorpera_company_site_tickets%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Edge ticket redeem requires service_role' using errcode = '42501';
	end if;
	if p_ticket is null or p_ticket !~ '^[A-Za-z0-9_-]{43}$' or not public.qorpera_site_hosts_on() then
		return '{"state":"refused"}'::jsonb;
	end if;
	v_host_of := public.qorpera_site_host(v_host);
	if v_host_of is null or v_host_of ->> 'scope' <> 'next' then
		return '{"state":"refused"}'::jsonb;
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.slug = v_host_of ->> 'slug'
		and site.kind = 'files'
		and site.taken_down_at is null
		and not public.qorpera_company_deleting(site.profile_id);
	if not found then
		return '{"state":"refused"}'::jsonb;
	end if;
	delete from public.qorpera_company_site_tickets as ticket
	where ticket.ticket_sha256 = public.qorpera_site_sha256(p_ticket)
		and ticket.site_id = v_site.id
		and ticket.expires_at > v_now
	returning ticket.* into v_ticket;
	if v_ticket.ticket_sha256 is null
		or not exists (
			select 1 from public.qorpera_company_site_versions as ver
			where ver.id = v_ticket.version_id and ver.site_id = v_site.id and ver.state in ('ready', 'live', 'kept')
		)
		or not exists (
			select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_site.profile_id and member.user_id = v_ticket.user_id and member.role in ('owner', 'admin')
		) then
		return '{"state":"refused"}'::jsonb;
	end if;
	return jsonb_build_object(
		'state', 'open',
		'site_id', v_site.id,
		'version_id', v_ticket.version_id,
		'password_version', v_site.password_version,
		'max_age', 43200
	);
end $$;

create function public.qorpera_web_edge_redeem_member_pass(p_host text, p_pass text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_host text := lower(btrim(coalesce(p_host, '')));
	v_host_of jsonb;
	v_site public.qorpera_company_sites%rowtype;
	v_pass public.qorpera_company_site_member_passes%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Edge member pass redeem requires service_role' using errcode = '42501';
	end if;
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' or not public.qorpera_site_hosts_on() then
		return '{"state":"refused"}'::jsonb;
	end if;
	v_host_of := public.qorpera_site_host(v_host);
	if v_host_of is null or v_host_of ->> 'scope' <> 'site' then
		return '{"state":"refused"}'::jsonb;
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.slug = v_host_of ->> 'slug'
		and site.kind = 'files'
		and (site.current_version_id is not null or site.live_deployment_id is not null)
		and site.taken_down_at is null
		and not public.qorpera_company_deleting(site.profile_id);
	if not found then
		return '{"state":"refused"}'::jsonb;
	end if;
	delete from public.qorpera_company_site_member_passes as pass
	where pass.pass_sha256 = public.qorpera_site_sha256(p_pass)
		and pass.site_id = v_site.id
		and pass.host = v_host
		and pass.expires_at > v_now
	returning pass.* into v_pass;
	if v_pass.pass_sha256 is null or not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_site.profile_id and member.user_id = v_pass.user_id
	) then
		return '{"state":"refused"}'::jsonb;
	end if;
	return jsonb_build_object(
		'state', 'open',
		'site_id', v_site.id,
		'password_version', v_site.password_version,
		'max_age', 43200
	);
end $$;

create function public.qorpera_recheck_company_site_domain(p_domain_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_dom public.qorpera_company_site_domains%rowtype;
	v_role public.qorpera_profile_role;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	if p_domain_id is null then
		raise exception 'Domain is required' using errcode = '22023';
	end if;
	select dom.* into v_dom from public.qorpera_company_site_domains as dom where dom.id = p_domain_id for update;
	if not found then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_dom.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	update public.qorpera_company_site_domains
	set last_checked_at = null, updated_at = clock_timestamp()
	where id = v_dom.id
	returning * into v_dom;
	perform pg_notify('qorpera_web_route_changes', 'domain_recheck');
	return jsonb_build_object(
		'schema', 'qorpera.company-site-domain-recheck/v1',
		'id', v_dom.id,
		'hostname', v_dom.hostname,
		'status', v_dom.status
	);
end $$;

revoke all on function
	public.qorpera_recheck_company_site_domain(uuid),
	public.qorpera_web_edge_redeem_ticket(text, text),
	public.qorpera_web_edge_redeem_member_pass(text, text),
	public.qorpera_web_code_deployment_register(
		text, text, uuid, text, text, integer, text, text, jsonb, integer, bigint,
		text, integer, text, integer, integer, numeric, boolean, text, jsonb
	)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

grant execute on function
	public.qorpera_recheck_company_site_domain(uuid)
	to authenticated;

grant execute on function
	public.qorpera_web_edge_redeem_ticket(text, text),
	public.qorpera_web_edge_redeem_member_pass(text, text),
	public.qorpera_web_code_deployment_register(
		text, text, uuid, text, text, integer, text, text, jsonb, integer, bigint,
		text, integer, text, integer, integer, numeric, boolean, text, jsonb
	)
	to service_role;
