do $$
begin
	if to_regclass('public.qorpera_company_site_domains') is not null then
		raise exception '20260930832000 (native web hosting) is already applied';
	end if;
	if to_regclass('public.qorpera_company_site_tickets') is null
		or to_regprocedure('public.qorpera_site_hosts_on()') is null
		or to_regprocedure('public.qorpera_member_role(uuid)') is null then
		raise exception '20260930832000 requires site hosts (20260930756000)';
	end if;
end $$;

set local lock_timeout = '3s';

do $$
declare v_con text;
begin
	for v_con in
		select con.conname
		from pg_constraint as con
		where con.conrelid = 'public.qorpera_site_settings'::regclass
			and con.contype = 'c'
			and pg_get_constraintdef(con.oid) like '%hosts_domain%'
			and pg_get_constraintdef(con.oid) not like '%hosts_enabled%'
	loop
		execute format('alter table public.qorpera_site_settings drop constraint %I', v_con);
	end loop;
end $$;

alter table public.qorpera_site_settings
	add constraint qorpera_site_settings_hosts_domain
		check (hosts_domain is null or hosts_domain in ('qorpera.com', 'qorpera.site')),
	add column public_enabled boolean not null default false,
	add column domains_enabled boolean not null default false,
	add column edge_ipv4 inet,
	add column edge_ipv6 inet,
	add column edge_cname_target text check (edge_cname_target is null or (
		char_length(edge_cname_target) between 3 and 253
		and edge_cname_target ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
	));

create table public.qorpera_company_site_deployments (
	id uuid primary key default extensions.gen_random_uuid(),
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	version_number integer not null check (version_number >= 1),
	kind text not null check (kind in ('static', 'server', 'hybrid')),
	state text not null default 'building' check (state in ('building', 'ready', 'live', 'stopped', 'failed')),
	manifest_sha256 text check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'),
	manifest_json jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest_json) = 'object'),
	file_count integer not null default 0 check (file_count between 0 and 10000),
	total_bytes bigint not null default 0 check (total_bytes between 0 and 536870912),
	oci_image_ref text check (oci_image_ref is null or (
		char_length(oci_image_ref) between 8 and 512 and oci_image_ref !~ '[[:cntrl:][:space:]]'
	)),
	app_port integer check (app_port is null or app_port between 1 and 65535),
	health_path text not null default '/' check (char_length(health_path) between 1 and 256 and left(health_path, 1) = '/'),
	idle_timeout_sec integer not null default 900 check (idle_timeout_sec between 0 and 86400),
	memory_mb integer not null default 512 check (memory_mb between 64 and 8192),
	vcpu_limit numeric(4,2) not null default 1.00 check (vcpu_limit between 0.25 and 8.00),
	has_credential_inputs boolean,
	upstream_addr text check (upstream_addr is null or (
		char_length(upstream_addr) between 3 and 255 and upstream_addr !~ '[[:cntrl:][:space:]]'
	)),
	created_by_user_id uuid,
	created_at timestamptz not null default clock_timestamp(),
	live_at timestamptz,
	stopped_at timestamptz,
	unique (site_id, version_number),
	check ((kind = 'static') or oci_image_ref is not null)
);

create index qorpera_company_site_deployments_site
	on public.qorpera_company_site_deployments(site_id, created_at desc);
create index qorpera_company_site_deployments_profile
	on public.qorpera_company_site_deployments(profile_id);
alter table public.qorpera_company_site_deployments enable row level security;
revoke all on public.qorpera_company_site_deployments
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

alter table public.qorpera_company_sites
	add column is_public boolean not null default false,
	add column deployment_kind text not null default 'static'
		check (deployment_kind in ('static', 'server', 'hybrid')),
	add column storage_mode text not null default 'db'
		check (storage_mode in ('db', 'blob')),
	add column live_deployment_id uuid
		references public.qorpera_company_site_deployments(id) on delete set null;

create table public.qorpera_company_site_domains (
	id uuid primary key default extensions.gen_random_uuid(),
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	hostname text not null unique check (
		char_length(hostname) between 4 and 253
		and hostname ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
		and hostname !~ '(^|\.)qorpera\.(com|site)$'
		and hostname !~ '^[0-9.]+$'
	),
	is_apex boolean not null,
	is_primary boolean not null default false,
	status text not null default 'pending_dns'
		check (status in ('pending_dns', 'dns_verified', 'tls_active', 'moved', 'failed')),
	verification_token text not null check (verification_token ~ '^[0-9a-f]{32}$'),
	last_checked_at timestamptz,
	verified_at timestamptz,
	tls_active_at timestamptz,
	consecutive_misses integer not null default 0 check (consecutive_misses >= 0),
	last_error text check (last_error is null or (char_length(last_error) <= 300 and last_error !~ '[[:cntrl:]]')),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp()
);

create index qorpera_company_site_domains_site
	on public.qorpera_company_site_domains(site_id);
create index qorpera_company_site_domains_profile
	on public.qorpera_company_site_domains(profile_id);
create unique index qorpera_company_site_domains_primary
	on public.qorpera_company_site_domains(site_id) where is_primary;
alter table public.qorpera_company_site_domains enable row level security;
revoke all on public.qorpera_company_site_domains
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

create function public.qorpera_web_notify_route_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	perform pg_notify('qorpera_web_route_changes', tg_table_name);
	return null;
end $$;

revoke all on function public.qorpera_web_notify_route_change()
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

create trigger qorpera_web_notify_sites
	after insert or update or delete on public.qorpera_company_sites
	for each statement execute function public.qorpera_web_notify_route_change();

create trigger qorpera_web_notify_domains
	after insert or update or delete on public.qorpera_company_site_domains
	for each statement execute function public.qorpera_web_notify_route_change();

create trigger qorpera_web_notify_deployments
	after insert or update or delete on public.qorpera_company_site_deployments
	for each statement execute function public.qorpera_web_notify_route_change();

create trigger qorpera_web_notify_settings
	after update on public.qorpera_site_settings
	for each statement execute function public.qorpera_web_notify_route_change();

create function public.qorpera_company_site_hosting(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_settings public.qorpera_site_settings%rowtype;
begin
	if auth.uid() is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only the company''s members see its sites' using errcode = '42501';
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-hosting/v1',
		'hostsDomain', v_settings.hosts_domain,
		'hostsEnabled', coalesce(v_settings.enabled and v_settings.hosts_enabled, false),
		'publicEnabled', coalesce(v_settings.enabled and v_settings.public_enabled, false),
		'domainsEnabled', coalesce(v_settings.enabled and v_settings.domains_enabled, false),
		'edgeIpv4', host(v_settings.edge_ipv4),
		'edgeIpv6', host(v_settings.edge_ipv6),
		'edgeCnameTarget', v_settings.edge_cname_target,
		'sites', coalesce((
			select jsonb_agg(jsonb_build_object(
				'siteId', site.id,
				'slug', site.slug,
				'isPublic', site.is_public,
				'deploymentKind', site.deployment_kind,
				'storageMode', site.storage_mode,
				'liveDeploymentId', site.live_deployment_id,
				'domains', coalesce((
					select jsonb_agg(jsonb_build_object(
						'id', dom.id,
						'hostname', dom.hostname,
						'isApex', dom.is_apex,
						'isPrimary', dom.is_primary,
						'status', dom.status,
						'verificationToken', dom.verification_token,
						'lastCheckedAt', dom.last_checked_at,
						'verifiedAt', dom.verified_at,
						'tlsActiveAt', dom.tls_active_at,
						'lastError', dom.last_error
					) order by dom.is_primary desc, dom.hostname collate "C")
					from public.qorpera_company_site_domains as dom
					where dom.site_id = site.id
				), '[]'::jsonb)
			) order by site.slug collate "C")
			from public.qorpera_company_sites as site
			where site.profile_id = p_profile_id
		), '[]'::jsonb)
	);
end $$;

create function public.qorpera_set_company_site_public(p_site_id uuid, p_public boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_site public.qorpera_company_sites%rowtype;
	v_role public.qorpera_profile_role;
	v_dep public.qorpera_company_site_deployments%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins manage site visibility' using errcode = '42501';
	end if;
	if p_site_id is null or p_public is null then
		raise exception 'Site and visibility are required' using errcode = '22023';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id for update;
	if not found then
		raise exception 'Only founders and admins manage site visibility' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_site.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage site visibility' using errcode = '42501';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	if p_public then
		if not coalesce((select settings.enabled and settings.public_enabled from public.qorpera_site_settings as settings limit 1), false) then
			raise exception 'PUBLIC_SITES_DISABLED' using errcode = '42501';
		end if;
		if v_site.live_deployment_id is not null then
			select dep.* into v_dep from public.qorpera_company_site_deployments as dep where dep.id = v_site.live_deployment_id;
			if coalesce(v_dep.has_credential_inputs, false) then
				raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
			end if;
		end if;
	end if;
	update public.qorpera_company_sites
	set is_public = p_public, updated_at = clock_timestamp()
	where id = v_site.id;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-visibility/v1',
		'siteId', v_site.id,
		'isPublic', p_public
	);
end $$;

create function public.qorpera_add_company_site_domain(p_site_id uuid, p_hostname text, p_is_apex boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_site public.qorpera_company_sites%rowtype;
	v_role public.qorpera_profile_role;
	v_settings public.qorpera_site_settings%rowtype;
	v_host text := lower(btrim(coalesce(p_hostname, '')));
	v_token text;
	v_domain public.qorpera_company_site_domains%rowtype;
	v_existing_count integer;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	if p_site_id is null or p_is_apex is null then
		raise exception 'Site and domain are required' using errcode = '22023';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id for update;
	if not found then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_site.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	if not coalesce(v_settings.enabled and v_settings.domains_enabled, false) then
		raise exception 'CUSTOM_DOMAINS_DISABLED' using errcode = '42501';
	end if;
	if right(v_host, 1) = '.' then
		v_host := left(v_host, -1);
	end if;
	if char_length(v_host) not between 4 and 253
		or v_host !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
		or v_host ~ '(^|\.)qorpera\.(com|site)$'
		or v_host ~ '^[0-9.]+$' then
		raise exception 'DOMAIN_INVALID' using errcode = '22023';
	end if;
	select count(*) into v_existing_count from public.qorpera_company_site_domains as dom where dom.site_id = v_site.id;
	if v_existing_count >= 5 then
		raise exception 'SITE_DOMAIN_LIMIT_REACHED' using errcode = '22023';
	end if;
	v_token := encode(extensions.gen_random_bytes(16), 'hex');
	insert into public.qorpera_company_site_domains (
		site_id, profile_id, hostname, is_apex, is_primary, status, verification_token
	) values (
		v_site.id, v_site.profile_id, v_host, p_is_apex, false, 'pending_dns', v_token
	) returning * into v_domain;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-domain/v1',
		'id', v_domain.id,
		'siteId', v_domain.site_id,
		'hostname', v_domain.hostname,
		'isApex', v_domain.is_apex,
		'isPrimary', v_domain.is_primary,
		'status', v_domain.status,
		'verificationToken', v_domain.verification_token,
		'dns', jsonb_build_object(
			'recordType', case when v_domain.is_apex then 'A' else 'CNAME' end,
			'ipv4', host(v_settings.edge_ipv4),
			'ipv6', host(v_settings.edge_ipv6),
			'cnameTarget', v_settings.edge_cname_target,
			'txtHost', '_qorpera.' || v_domain.hostname,
			'txtValue', 'qorpera-verify=' || v_domain.verification_token
		)
	);
end $$;

create function public.qorpera_remove_company_site_domain(p_domain_id uuid)
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
	delete from public.qorpera_company_site_domains where id = v_dom.id;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-domain-remove/v1',
		'id', v_dom.id,
		'removed', true
	);
end $$;

create function public.qorpera_set_primary_site_domain(p_domain_id uuid)
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
	if v_dom.status not in ('dns_verified', 'tls_active') then
		raise exception 'DOMAIN_NOT_VERIFIED' using errcode = '22023';
	end if;
	update public.qorpera_company_site_domains
	set is_primary = false, updated_at = clock_timestamp()
	where site_id = v_dom.site_id and is_primary and id <> v_dom.id;
	update public.qorpera_company_site_domains
	set is_primary = true, updated_at = clock_timestamp()
	where id = v_dom.id;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-domain-primary/v1',
		'id', v_dom.id,
		'siteId', v_dom.site_id,
		'hostname', v_dom.hostname
	);
end $$;

create function public.qorpera_web_edge_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_settings public.qorpera_site_settings%rowtype;
begin
	if auth.role() is distinct from 'service_role' and current_user <> 'postgres' then
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
						'manifest', dep.manifest_json,
						'upstream_addr', dep.upstream_addr,
						'oci_image_ref', dep.oci_image_ref,
						'health_path', dep.health_path,
						'idle_timeout_sec', dep.idle_timeout_sec
					)
					from public.qorpera_company_site_deployments as dep
					where dep.id = site.live_deployment_id
				),
				'preview_deployments', '{}'::jsonb
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
				'verification_token', dom.verification_token
			) order by dom.hostname collate "C")
			from public.qorpera_company_site_domains as dom
		), '[]'::jsonb)
	);
end $$;

create function public.qorpera_web_edge_tls_allow(p_domain text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_host text := lower(btrim(coalesce(p_domain, '')));
	v_settings public.qorpera_site_settings%rowtype;
	v_parsed jsonb;
	v_allowed boolean := false;
begin
	if auth.role() is distinct from 'service_role' and current_user <> 'postgres' then
		raise exception 'TLS check requires service_role' using errcode = '42501';
	end if;
	if right(v_host, 1) = '.' then
		v_host := left(v_host, -1);
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	if coalesce(v_settings.enabled and v_settings.domains_enabled, false) then
		select exists (
			select 1
			from public.qorpera_company_site_domains as dom
			join public.qorpera_company_sites as site on site.id = dom.site_id
			where dom.hostname = v_host
				and dom.status in ('dns_verified', 'tls_active')
				and site.taken_down_at is null
		) into v_allowed;
		if v_allowed then
			return jsonb_build_object('allowed', true, 'reason', 'custom_domain');
		end if;
	end if;
	if coalesce(v_settings.enabled and v_settings.hosts_enabled, false) then
		v_parsed := public.qorpera_site_host(v_host);
		if v_parsed is not null then
			select exists (
				select 1
				from public.qorpera_company_sites as site
				where site.slug = v_parsed ->> 'slug'
					and site.taken_down_at is null
			) into v_allowed;
			if v_allowed then
				return jsonb_build_object('allowed', true, 'reason', 'site_host');
			end if;
		end if;
	end if;
	return jsonb_build_object('allowed', false, 'reason', 'denied');
end $$;

create function public.qorpera_web_domain_mark_checked(p_domain_id uuid, p_status text, p_error text)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_dom public.qorpera_company_site_domains%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and current_user <> 'postgres' then
		raise exception 'Domain update requires service_role' using errcode = '42501';
	end if;
	if p_status not in ('pending_dns', 'dns_verified', 'tls_active', 'moved', 'failed') then
		raise exception 'Invalid domain status' using errcode = '22023';
	end if;
	update public.qorpera_company_site_domains
	set status = p_status,
		last_checked_at = v_now,
		verified_at = case when p_status in ('dns_verified', 'tls_active') then coalesce(verified_at, v_now) else verified_at end,
		tls_active_at = case when p_status = 'tls_active' then coalesce(tls_active_at, v_now) else tls_active_at end,
		consecutive_misses = case when p_status in ('dns_verified', 'tls_active') then 0 else consecutive_misses + 1 end,
		last_error = case when p_error is null then null else left(regexp_replace(p_error, '[[:cntrl:]]', ' ', 'g'), 300) end,
		updated_at = v_now
	where id = p_domain_id
	returning * into v_dom;
	if not found then
		raise exception 'Domain not found' using errcode = 'P0002';
	end if;
	return jsonb_build_object('id', v_dom.id, 'status', v_dom.status, 'hostname', v_dom.hostname);
end $$;

create function public.qorpera_web_deployment_create(
	p_site_id uuid,
	p_kind text,
	p_manifest_sha256 text,
	p_manifest_json jsonb,
	p_file_count integer,
	p_total_bytes bigint,
	p_oci_image_ref text,
	p_app_port integer,
	p_health_path text,
	p_idle_timeout_sec integer,
	p_has_credential_inputs boolean
)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_site public.qorpera_company_sites%rowtype;
	v_next_version integer;
	v_dep public.qorpera_company_site_deployments%rowtype;
begin
	if auth.role() is distinct from 'service_role' and current_user <> 'postgres' then
		raise exception 'Deployment creation requires service_role' using errcode = '42501';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id for update;
	if not found then
		raise exception 'Site not found' using errcode = 'P0002';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	select coalesce(max(dep.version_number), 0) + 1 into v_next_version
	from public.qorpera_company_site_deployments as dep where dep.site_id = v_site.id;
	insert into public.qorpera_company_site_deployments (
		site_id, profile_id, version_number, kind, state, manifest_sha256, manifest_json,
		file_count, total_bytes, oci_image_ref, app_port, health_path, idle_timeout_sec, has_credential_inputs
	) values (
		v_site.id, v_site.profile_id, v_next_version, p_kind, 'ready', p_manifest_sha256,
		coalesce(p_manifest_json, '{}'::jsonb), coalesce(p_file_count, 0), coalesce(p_total_bytes, 0),
		p_oci_image_ref, p_app_port, coalesce(p_health_path, '/'), coalesce(p_idle_timeout_sec, 900),
		p_has_credential_inputs
	) returning * into v_dep;
	return jsonb_build_object(
		'id', v_dep.id,
		'siteId', v_dep.site_id,
		'versionNumber', v_dep.version_number,
		'kind', v_dep.kind,
		'state', v_dep.state
	);
end $$;

create function public.qorpera_web_deployment_promote(
	p_site_id uuid,
	p_deployment_id uuid,
	p_upstream_addr text,
	p_published_by_user_id uuid default null
)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_site public.qorpera_company_sites%rowtype;
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and current_user <> 'postgres' then
		raise exception 'Deployment promotion requires service_role' using errcode = '42501';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id for update;
	if not found then
		raise exception 'Site not found' using errcode = 'P0002';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	select dep.* into v_dep from public.qorpera_company_site_deployments as dep
	where dep.id = p_deployment_id and dep.site_id = v_site.id for update;
	if not found then
		raise exception 'Deployment not found' using errcode = 'P0002';
	end if;
	if v_site.is_public and coalesce(v_dep.has_credential_inputs, false) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;
	update public.qorpera_company_site_deployments
	set state = 'stopped', stopped_at = v_now, upstream_addr = null
	where site_id = v_site.id and state = 'live' and id <> v_dep.id;
	update public.qorpera_company_site_deployments
	set state = 'live', live_at = v_now, upstream_addr = p_upstream_addr
	where id = v_dep.id;
	update public.qorpera_company_sites
	set live_deployment_id = v_dep.id,
		deployment_kind = v_dep.kind,
		storage_mode = 'blob',
		published_at = case
			when published_at is not null then published_at
			when p_published_by_user_id is not null then v_now
			else null
		end,
		published_by_user_id = case
			when published_at is not null then published_by_user_id
			when p_published_by_user_id is not null then p_published_by_user_id
			else null
		end,
		updated_at = v_now
	where id = v_site.id;
	return jsonb_build_object(
		'siteId', v_site.id,
		'deploymentId', v_dep.id,
		'versionNumber', v_dep.version_number,
		'state', 'live'
	);
end $$;

create function public.qorpera_web_deployment_set_upstream(p_deployment_id uuid, p_upstream_addr text)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_dep public.qorpera_company_site_deployments%rowtype;
begin
	if auth.role() is distinct from 'service_role' and current_user <> 'postgres' then
		raise exception 'Upstream update requires service_role' using errcode = '42501';
	end if;
	update public.qorpera_company_site_deployments
	set upstream_addr = p_upstream_addr
	where id = p_deployment_id
	returning * into v_dep;
	if not found then
		raise exception 'Deployment not found' using errcode = 'P0002';
	end if;
	return jsonb_build_object('deploymentId', v_dep.id, 'upstreamAddr', v_dep.upstream_addr);
end $$;

revoke all on function
	public.qorpera_company_site_hosting(uuid),
	public.qorpera_set_company_site_public(uuid, boolean),
	public.qorpera_add_company_site_domain(uuid, text, boolean),
	public.qorpera_remove_company_site_domain(uuid),
	public.qorpera_set_primary_site_domain(uuid),
	public.qorpera_web_edge_snapshot(),
	public.qorpera_web_edge_tls_allow(text),
	public.qorpera_web_domain_mark_checked(uuid, text, text),
	public.qorpera_web_deployment_create(uuid, text, text, jsonb, integer, bigint, text, integer, text, integer, boolean),
	public.qorpera_web_deployment_promote(uuid, uuid, text, uuid),
	public.qorpera_web_deployment_set_upstream(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

grant execute on function
	public.qorpera_company_site_hosting(uuid),
	public.qorpera_set_company_site_public(uuid, boolean),
	public.qorpera_add_company_site_domain(uuid, text, boolean),
	public.qorpera_remove_company_site_domain(uuid),
	public.qorpera_set_primary_site_domain(uuid)
	to authenticated;

grant execute on function
	public.qorpera_web_edge_snapshot(),
	public.qorpera_web_edge_tls_allow(text),
	public.qorpera_web_domain_mark_checked(uuid, text, text),
	public.qorpera_web_deployment_create(uuid, text, text, jsonb, integer, bigint, text, integer, text, integer, boolean),
	public.qorpera_web_deployment_promote(uuid, uuid, text, uuid),
	public.qorpera_web_deployment_set_upstream(uuid, text)
	to service_role;
