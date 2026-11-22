do $$
begin
	if exists (
		select 1
		from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_company_sites'
			and column_name = 'app_auth_mode'
	) then
		raise exception '20260930839000 (app relay auth, health and site rollbacks) is already applied';
	end if;
	if to_regclass('public.qorpera_company_site_domains') is null
		or to_regprocedure('public.qorpera_site_app_session(text,text)') is null
		or to_regprocedure('public.qorpera_site_member_pass(uuid)') is null
		or to_regprocedure('public.qorpera_site_publish_finish(jsonb,uuid)') is null then
		raise exception '20260930839000 requires native web hosting, app sites, and member passes';
	end if;
end $$;

set local lock_timeout = '3s';

alter table public.qorpera_company_sites
	add column app_auth_mode text not null default 'password'
		check (app_auth_mode in ('password', 'company_member', 'public'));

alter table public.qorpera_company_site_versions
	drop constraint if exists qorpera_company_site_versions_from,
	add constraint qorpera_company_site_versions_from check (
		(tree is null) = (run_id is not null)
		and (tree is null) = (call_id is not null)
		and (tree is null) = (staff_agent_id is not null)
		and (tree is null) = (change is null)
		and (tree is null) = (main_sha is null)
		and (tree is not null or state in ('uploading', 'live', 'kept'))
	);

create or replace function public.qorpera_site_content_type(p_path text)
returns text language sql immutable set search_path = '' as $$
	select case lower(substring(p_path from '\.([A-Za-z0-9]{1,12})$'))
		when 'html' then 'text/html; charset=utf-8'
		when 'htm' then 'text/html; charset=utf-8'
		when 'css' then 'text/css; charset=utf-8'
		when 'js' then 'text/javascript; charset=utf-8'
		when 'mjs' then 'text/javascript; charset=utf-8'
		when 'json' then 'application/json; charset=utf-8'
		when 'map' then 'application/json; charset=utf-8'
		when 'webmanifest' then 'application/manifest+json; charset=utf-8'
		when 'txt' then 'text/plain; charset=utf-8'
		when 'csv' then 'text/csv; charset=utf-8'
		when 'xml' then 'application/xml; charset=utf-8'
		when 'vtt' then 'text/vtt; charset=utf-8'
		when 'md' then 'text/markdown; charset=utf-8'
		when 'rss' then 'application/rss+xml; charset=utf-8'
		when 'atom' then 'application/atom+xml; charset=utf-8'
		when 'svg' then 'image/svg+xml'
		when 'png' then 'image/png'
		when 'jpg' then 'image/jpeg'
		when 'jpeg' then 'image/jpeg'
		when 'gif' then 'image/gif'
		when 'webp' then 'image/webp'
		when 'avif' then 'image/avif'
		when 'ico' then 'image/x-icon'
		when 'woff' then 'font/woff'
		when 'woff2' then 'font/woff2'
		when 'ttf' then 'font/ttf'
		when 'otf' then 'font/otf'
		when 'mp4' then 'video/mp4'
		when 'webm' then 'video/webm'
		when 'mp3' then 'audio/mpeg'
		when 'm4a' then 'audio/mp4'
		when 'ogg' then 'audio/ogg'
		when 'wav' then 'audio/wav'
		when 'pdf' then 'application/pdf'
		when 'wasm' then 'application/wasm'
		when 'glb' then 'model/gltf-binary'
		when 'gltf' then 'model/gltf+json'
	end
$$;

create function public.qorpera_site_app_resolve(
	p_slug_or_host text,
	out site_id uuid,
	out is_custom_domain boolean,
	out expected_host text
)
returns record language plpgsql stable set search_path = '' as $$
declare
	v_settings public.qorpera_site_settings%rowtype;
	v_input text := lower(btrim(coalesce(p_slug_or_host, '')));
	v_site public.qorpera_company_sites%rowtype;
begin
	site_id := null;
	is_custom_domain := false;
	expected_host := null;
	if v_input = '' then
		return;
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	if not coalesce(v_settings.enabled and v_settings.apps_enabled, false) then
		return;
	end if;
	if public.qorpera_site_slug_valid(v_input) then
		select site.* into v_site
		from public.qorpera_company_sites as site
		where site.slug = v_input
			and site.kind = 'app'
			and not public.qorpera_company_deleting(site.profile_id);
		if found and public.qorpera_site_app_live(v_site) then
			site_id := v_site.id;
			is_custom_domain := false;
			expected_host := v_site.slug || v_settings.app_host_suffix;
		end if;
		return;
	end if;
	if not coalesce(v_settings.domains_enabled, false) then
		return;
	end if;
	if right(v_input, 1) = '.' then
		v_input := left(v_input, -1);
	end if;
	if char_length(v_input) not between 4 and 253
		or v_input !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' then
		return;
	end if;
	select site.* into v_site
	from public.qorpera_company_site_domains as dom
	join public.qorpera_company_sites as site on site.id = dom.site_id
	where dom.hostname = v_input
		and dom.status in ('dns_verified', 'tls_active')
		and site.kind = 'app'
		and not public.qorpera_company_deleting(site.profile_id);
	if found and public.qorpera_site_app_live(v_site) then
		site_id := v_site.id;
		is_custom_domain := true;
		expected_host := v_input;
	end if;
end $$;

revoke all on function public.qorpera_site_app_resolve(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

create function public.qorpera_set_company_site_app_auth_mode(p_site_id uuid, p_auth_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_site public.qorpera_company_sites%rowtype;
	v_role public.qorpera_profile_role;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins manage app authentication' using errcode = '42501';
	end if;
	if p_site_id is null or p_auth_mode is null or p_auth_mode not in ('password', 'company_member', 'public') then
		raise exception 'Site and auth mode (password, company_member, public) are required' using errcode = '22023';
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.id = p_site_id
	for update;
	if not found then
		raise exception 'Only founders and admins manage app authentication' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_site.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage app authentication' using errcode = '42501';
	end if;
	if v_site.kind <> 'app' then
		raise exception 'APP_SITE_REQUIRED' using errcode = '22023';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	if p_auth_mode = 'public' then
		if not coalesce((select settings.enabled and settings.public_enabled from public.qorpera_site_settings as settings limit 1), false) then
			raise exception 'PUBLIC_SITES_DISABLED' using errcode = '42501';
		end if;
	end if;
	update public.qorpera_company_sites
	set app_auth_mode = p_auth_mode,
		is_public = (p_auth_mode = 'public'),
		updated_at = clock_timestamp()
	where id = v_site.id;
	if p_auth_mode = 'company_member' then
		delete from public.qorpera_company_site_sessions
		where site_id = v_site.id and member_user_id is null;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-app-auth-mode/v1',
		'siteId', v_site.id,
		'slug', v_site.slug,
		'authMode', p_auth_mode
	);
end $$;

revoke all on function public.qorpera_set_company_site_app_auth_mode(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;
grant execute on function public.qorpera_set_company_site_app_auth_mode(uuid, text) to authenticated;

create or replace function public.qorpera_site_member_pass(p_site uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_user uuid := auth.uid();
	v_profile uuid;
	v_site public.qorpera_company_sites%rowtype;
	v_settings public.qorpera_site_settings%rowtype;
	v_pass text;
	v_host text;
	v_action text;
	v_open integer;
	v_oldest timestamptz;
	v_now timestamptz;
	c_schema constant text := 'qorpera.site-member-pass/v1';
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Only the company''s members open its site here' using errcode = '42501';
	end if;
	if p_site is null then
		raise exception 'A site is needed' using errcode = '22023';
	end if;
	select site.profile_id into v_profile
	from public.qorpera_company_sites as site
	where site.id = p_site
		and (site.kind = 'files' or (site.kind = 'app' and site.app_auth_mode = 'company_member'));
	if v_profile is null or public.qorpera_member_role(v_profile) is null then
		raise exception 'Only the company''s members open its site here' using errcode = '42501';
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site for share;
	if v_site.kind = 'files' then
		if not public.qorpera_site_hosts_on() then
			return jsonb_build_object('schema', c_schema, 'state', 'off');
		end if;
		if v_site.taken_down_at is not null then
			return jsonb_build_object('schema', c_schema, 'state', 'gone');
		end if;
		if v_site.current_version_id is null then
			return jsonb_build_object('schema', c_schema, 'state', 'none');
		end if;
		v_host := v_site.slug || '.' || v_settings.hosts_domain;
		v_action := 'https://' || v_host || '/__qorpera/member';
	else
		if not coalesce(v_settings.enabled and v_settings.apps_enabled, false) then
			return jsonb_build_object('schema', c_schema, 'state', 'off');
		end if;
		if v_site.taken_down_at is not null then
			return jsonb_build_object('schema', c_schema, 'state', 'gone');
		end if;
		if not public.qorpera_site_app_live(v_site) then
			return jsonb_build_object('schema', c_schema, 'state', 'none');
		end if;
		v_host := v_site.slug || v_settings.app_host_suffix;
		v_action := 'https://' || v_host || '/.qorpera/member';
	end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.site-member-pass:' || v_user::text, 0));
	v_now := clock_timestamp();
	delete from public.qorpera_company_site_member_passes as pass
	where pass.user_id = v_user and pass.expires_at <= v_now;
	select count(*), min(pass.expires_at) into v_open, v_oldest
	from public.qorpera_company_site_member_passes as pass
	where pass.user_id = v_user;
	if v_open >= 30 then
		return jsonb_build_object(
			'schema', c_schema,
			'state', 'limited',
			'retryAfter', greatest(1, ceil(extract(epoch from v_oldest - v_now)))::integer
		);
	end if;
	v_pass := public.qorpera_site_new_secret();
	insert into public.qorpera_company_site_member_passes (pass_sha256, site_id, user_id, host, created_at, expires_at)
	values (public.qorpera_site_sha256(v_pass), v_site.id, v_user, v_host, v_now, v_now + interval '60 seconds');
	return jsonb_build_object(
		'schema', c_schema,
		'state', 'open',
		'host', v_host,
		'pass', v_pass,
		'expiresAt', v_now + interval '60 seconds',
		'action', v_action
	);
end $$;

create or replace function public.qorpera_site_app_connect(p_slug text, p_secret text, p_program text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_site public.qorpera_company_sites%rowtype;
	v_settings public.qorpera_site_settings%rowtype;
	v_sha text;
	v_program text;
	v_key text;
	v_domains jsonb;
	v_answer jsonb;
begin
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	if not coalesce(v_settings.enabled and v_settings.apps_enabled, false)
		or not public.qorpera_site_slug_valid(p_slug)
		or p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{43}$'
		or p_program is null or p_program !~ '^[A-Za-z0-9_-]{43}$' then
		return jsonb_build_object('state', 'refused');
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.slug = p_slug and site.kind = 'app' and not public.qorpera_company_deleting(site.profile_id);
	if not found or not public.qorpera_site_app_live(v_site) then
		return jsonb_build_object('state', 'refused');
	end if;
	v_sha := public.qorpera_site_sha256(p_secret);
	if v_site.app_key_sha256 = v_sha then
		v_key := null;
	else
		v_program := public.qorpera_site_sha256(p_program);
		if not exists (
			select 1 from public.qorpera_company_site_app_claims as claim
			where claim.claim_sha256 = v_sha and claim.site_id = v_site.id and claim.expires_at > clock_timestamp()
				and (claim.program_sha256 is null or claim.program_sha256 = v_program)
		) then
			return jsonb_build_object('state', 'refused');
		end if;
		select site.* into v_site
		from public.qorpera_company_sites as site
		where site.id = v_site.id and not public.qorpera_company_deleting(site.profile_id)
		for update;
		if not found or not public.qorpera_site_app_live(v_site) then
			return jsonb_build_object('state', 'refused');
		end if;
		update public.qorpera_company_site_app_claims as claim
		set used_at = coalesce(claim.used_at, clock_timestamp()),
			program_sha256 = coalesce(claim.program_sha256, v_program),
			expires_at = case when claim.used_at is null then clock_timestamp() + interval '2 minutes' else claim.expires_at end
		where claim.claim_sha256 = v_sha and claim.site_id = v_site.id and claim.expires_at > clock_timestamp()
			and (claim.program_sha256 is null or claim.program_sha256 = v_program);
		if not found then
			return jsonb_build_object('state', 'refused');
		end if;
		v_key := public.qorpera_site_new_secret();
		update public.qorpera_company_sites set app_key_sha256 = public.qorpera_site_sha256(v_key) where id = v_site.id;
	end if;
	v_answer := jsonb_build_object('state', 'ok', 'key', v_key, 'port', v_site.app_port, 'siteId', v_site.id::text);
	if v_site.app_auth_mode <> 'password' then
		v_answer := v_answer || jsonb_build_object('authMode', v_site.app_auth_mode);
	end if;
	if coalesce(v_settings.domains_enabled, false) then
		select jsonb_agg(dom.hostname order by dom.is_primary desc, dom.hostname collate "C")
		into v_domains
		from public.qorpera_company_site_domains as dom
		where dom.site_id = v_site.id and dom.status in ('dns_verified', 'tls_active');
		if v_domains is not null then
			v_answer := v_answer || jsonb_build_object('domains', v_domains);
		end if;
	end if;
	return v_answer;
end $$;

create or replace function public.qorpera_site_app_session(p_slug text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_resolved record;
	v_site public.qorpera_company_sites%rowtype;
	v_settings public.qorpera_site_settings%rowtype;
	v_member_id uuid;
	v_extra jsonb := '{}'::jsonb;
begin
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	if not coalesce(v_settings.enabled and v_settings.apps_enabled, false) then
		return jsonb_build_object('state', 'locked');
	end if;
	select * into v_resolved from public.qorpera_site_app_resolve(p_slug);
	if v_resolved.site_id is null then
		return jsonb_build_object('state', 'locked');
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = v_resolved.site_id;
	if v_resolved.is_custom_domain then
		v_extra := jsonb_build_object('slug', v_site.slug);
	end if;
	if v_site.app_auth_mode = 'public' then
		if not coalesce(v_settings.public_enabled, false) then
			return jsonb_build_object('state', 'locked');
		end if;
		return jsonb_build_object('state', 'open', 'siteId', v_site.id::text, 'authMode', 'public') || v_extra;
	end if;
	if v_site.app_auth_mode = 'company_member' then
		if p_token is not null and p_token ~ '^[A-Za-z0-9_-]{32}$' then
			select session.member_user_id into v_member_id
			from public.qorpera_company_site_sessions as session
			join public.qorpera_profile_members as member
				on member.profile_id = v_site.profile_id and member.user_id = session.member_user_id
			where session.token_sha256 = public.qorpera_site_sha256(p_token)
				and session.site_id = v_site.id
				and session.member_user_id is not null
				and session.expires_at > clock_timestamp();
		elsif p_token is not null and p_token ~ '^[A-Za-z0-9_-]{43}$' then
			select pass.user_id into v_member_id
			from public.qorpera_company_site_member_passes as pass
			join public.qorpera_profile_members as member
				on member.profile_id = v_site.profile_id and member.user_id = pass.user_id
			where pass.pass_sha256 = public.qorpera_site_sha256(p_token)
				and pass.site_id = v_site.id
				and pass.host = v_resolved.expected_host
				and pass.expires_at > clock_timestamp();
		end if;
		if v_member_id is null then
			return jsonb_build_object('state', 'locked', 'authMode', 'company_member') || v_extra;
		end if;
		return jsonb_build_object(
			'state', 'open',
			'siteId', v_site.id::text,
			'authMode', 'company_member',
			'memberId', v_member_id::text
		) || v_extra;
	end if;
	if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32}$' then
		return jsonb_build_object('state', 'locked') || v_extra;
	end if;
	if not exists (
		select 1 from public.qorpera_company_site_sessions as session
		where session.token_sha256 = public.qorpera_site_sha256(p_token)
			and session.site_id = v_site.id
			and session.password_version = v_site.password_version
			and session.expires_at > clock_timestamp()
	) then
		return jsonb_build_object('state', 'locked') || v_extra;
	end if;
	return jsonb_build_object('state', 'open', 'siteId', v_site.id::text) || v_extra;
end $$;

create or replace function public.qorpera_site_app_unlock(p_slug text, p_password text, p_client text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp();
	v_client text;
	v_count integer;
	v_oldest timestamptz;
	v_resolved record;
	v_site public.qorpera_company_sites%rowtype;
	v_secret public.qorpera_company_site_secrets%rowtype;
	v_pass public.qorpera_company_site_member_passes%rowtype;
	v_token text;
	v_settings public.qorpera_site_settings%rowtype;
	v_limit_key text;
begin
	if p_slug is null or btrim(p_slug) = '' or p_password is null or char_length(p_password) > 1024 then
		return jsonb_build_object('state', 'wrong');
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	select * into v_resolved from public.qorpera_site_app_resolve(p_slug);
	if v_resolved.site_id is not null then
		select site.* into v_site from public.qorpera_company_sites as site where site.id = v_resolved.site_id;
		v_limit_key := v_site.slug;
	elsif public.qorpera_site_slug_valid(p_slug) then
		v_limit_key := p_slug;
	else
		return jsonb_build_object('state', 'wrong');
	end if;
	v_client := encode(
		extensions.hmac(convert_to(public.qorpera_site_client_network(p_client), 'utf8'), v_settings.client_key, 'sha256'),
		'hex'
	);
	delete from public.qorpera_site_unlock_failures as failure
	where failure.ctid = any (array(
		select old.ctid from public.qorpera_site_unlock_failures as old
		where old.failed_at < v_now - interval '1 hour'
		limit 500
	));
	select count(*), min(failure.failed_at) into v_count, v_oldest
	from public.qorpera_site_unlock_failures as failure
	where failure.slug = v_limit_key and failure.client_sha256 = v_client and failure.failed_at > v_now - interval '15 minutes';
	if v_count < 10 then
		select count(*), min(failure.failed_at) into v_count, v_oldest
		from public.qorpera_site_unlock_failures as failure
		where failure.client_sha256 = v_client and failure.failed_at > v_now - interval '15 minutes';
		if v_count < 30 then
			v_count := 0;
		end if;
	end if;
	if v_count > 0 then
		return jsonb_build_object(
			'state', 'limited',
			'retryAfter', greatest(1, ceil(extract(epoch from v_oldest + interval '15 minutes' - v_now)))::integer
		);
	end if;
	select count(*), min(failure.failed_at) into v_count, v_oldest
	from public.qorpera_site_unlock_failures as failure
	where failure.slug = v_limit_key and failure.failed_at > v_now - interval '1 hour';
	if v_count >= 300 then
		return jsonb_build_object(
			'state', 'limited',
			'retryAfter', greatest(1, ceil(extract(epoch from v_oldest + interval '1 hour' - v_now)))::integer
		);
	end if;
	if v_site.id is not null and v_site.app_auth_mode = 'company_member' then
		if p_password ~ '^[A-Za-z0-9_-]{43}$' then
			delete from public.qorpera_company_site_member_passes as pass
			where pass.pass_sha256 = public.qorpera_site_sha256(p_password)
				and pass.site_id = v_site.id
				and pass.host = v_resolved.expected_host
				and pass.expires_at > v_now
				and exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = v_site.profile_id and member.user_id = pass.user_id
				)
			returning * into v_pass;
			if found then
				delete from public.qorpera_company_site_sessions as session
				where session.site_id = v_site.id and session.member_user_id is not null
					and (session.expires_at <= v_now or session.token_sha256 in (
						select old.token_sha256 from public.qorpera_company_site_sessions as old
						where old.site_id = v_site.id and old.member_user_id is not null
						order by old.created_at desc
						offset 49
					));
				v_token := public.qorpera_site_new_token();
				insert into public.qorpera_company_site_sessions (
					token_sha256, site_id, password_version, expires_at, member_user_id
				) values (
					public.qorpera_site_sha256(v_token), v_site.id, v_site.password_version, v_now + interval '12 hours', v_pass.user_id
				);
				return jsonb_build_object(
					'state', 'open',
					'token', v_token,
					'maxAge', 43200,
					'memberId', v_pass.user_id::text
				);
			end if;
		end if;
		insert into public.qorpera_site_unlock_failures (slug, client_sha256, failed_at)
		values (v_limit_key, v_client, v_now);
		return jsonb_build_object('state', 'wrong');
	end if;
	if v_site.id is not null and v_site.app_auth_mode = 'password' then
		select secret.* into v_secret from public.qorpera_company_site_secrets as secret where secret.site_id = v_site.id;
		if v_secret.site_id is not null
			and extensions.digest(convert_to(v_secret.password, 'utf8'), 'sha256')
				= extensions.digest(convert_to(p_password, 'utf8'), 'sha256') then
			delete from public.qorpera_company_site_sessions as session
			where session.site_id = v_site.id
				and (session.expires_at <= v_now or session.password_version <> v_site.password_version);
			delete from public.qorpera_company_site_sessions as session
			where session.token_sha256 in (
				select old.token_sha256 from public.qorpera_company_site_sessions as old
				where old.site_id = v_site.id
				order by old.created_at desc
				offset 1999
			);
			v_token := public.qorpera_site_new_token();
			insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at)
			values (public.qorpera_site_sha256(v_token), v_site.id, v_site.password_version, v_now + interval '7 days');
			return jsonb_build_object('state', 'open', 'token', v_token, 'maxAge', 604800);
		end if;
	end if;
	insert into public.qorpera_site_unlock_failures (slug, client_sha256, failed_at)
	values (v_limit_key, v_client, v_now);
	return jsonb_build_object('state', 'wrong');
end $$;

create or replace function public.qorpera_site_publish_finish(p_binding jsonb, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_version public.qorpera_company_site_versions%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.id = (select version.site_id from public.qorpera_company_site_versions as version where version.id = p_version_id)
		and site.profile_id = v_run.profile_id
	for update;
	select version.* into v_version
	from public.qorpera_company_site_versions as version
	where version.id = p_version_id and version.site_id = v_site.id and version.run_id = v_run.id
	for update;
	if v_site.id is null or v_version.id is null then
		raise exception 'SITE_UPLOAD_GONE: this upload is no longer open; publish again' using errcode = '55000';
	end if;
	if v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000';
	end if;
	if v_version.state = 'live' then
		return public.qorpera_site_publish_receipt(v_site, v_version);
	end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	if exists (
		select 1 from public.qorpera_company_site_files as file
		where file.version_id = v_version.id and file.content is null
	) then
		raise exception 'SITE_UPLOAD_INCOMPLETE: some files have no bytes yet' using errcode = '55000';
	end if;
	update public.qorpera_company_site_versions
	set state = 'kept'
	where site_id = v_site.id and state = 'live' and id <> v_version.id;
	update public.qorpera_company_site_versions
	set state = 'live', published_at = v_now
	where id = v_version.id
	returning * into v_version;
	update public.qorpera_company_sites
	set current_version_id = v_version.id,
		title = v_version.title,
		source_path = v_version.source_path,
		published_at = v_now,
		published_by_staff_agent_id = v_version.staff_agent_id,
		published_by_user_id = null,
		updated_at = v_now
	where id = v_site.id
	returning * into v_site;
	delete from public.qorpera_company_site_versions as version
	where version.site_id = v_site.id and version.state = 'uploading' and version.id <> v_version.id;
	delete from public.qorpera_company_site_versions as version
	where version.id in (
		select old.id
		from public.qorpera_company_site_versions as old
		where old.site_id = v_site.id and old.tree is null and old.state = 'kept' and old.id <> v_version.id
		order by old.published_at desc nulls last, old.created_at desc, old.id desc
		offset 9
	);
	return public.qorpera_site_publish_receipt(v_site, v_version);
end $$;

create function public.qorpera_site_list_versions(p_site_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_site public.qorpera_company_sites%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only the company''s members list site versions' using errcode = '42501';
	end if;
	if p_site_id is null then
		raise exception 'A site is needed' using errcode = '22023';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id;
	if not found or public.qorpera_member_role(v_site.profile_id) is null then
		raise exception 'Only the company''s members list site versions' using errcode = '42501';
	end if;
	if v_site.kind <> 'files' then
		raise exception 'STATIC_SITE_REQUIRED' using errcode = '22023';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.site-versions/v1',
		'siteId', v_site.id,
		'slug', v_site.slug,
		'url', public.qorpera_site_url(v_site.slug),
		'currentVersionId', v_site.current_version_id,
		'versions', coalesce((
			select jsonb_agg(jsonb_build_object(
				'id', version.id,
				'state', version.state,
				'isCurrent', version.id = v_site.current_version_id,
				'title', version.title,
				'sourcePath', version.source_path,
				'fileCount', version.file_count,
				'totalBytes', version.total_bytes,
				'manifestSha256', version.manifest_sha256,
				'origin', case when version.tree is not null then 'code' else 'publish_site' end,
				'change', version.change,
				'createdAt', version.created_at,
				'publishedAt', version.published_at
			) order by (version.id = v_site.current_version_id) desc, version.published_at desc nulls last, version.created_at desc, version.id desc)
			from (
				select version.*
				from public.qorpera_company_site_versions as version
				where version.site_id = v_site.id and version.state in ('live', 'kept', 'ready')
				order by (version.id = v_site.current_version_id) desc, version.published_at desc nulls last, version.created_at desc, version.id desc
				limit 20
			) as version
		), '[]'::jsonb)
	);
end $$;

create function public.qorpera_site_activate_version(p_site_id uuid, p_version_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_site public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype;
	v_role public.qorpera_profile_role;
	v_previous uuid;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins activate site versions' using errcode = '42501';
	end if;
	if p_site_id is null or p_version_id is null then
		raise exception 'Site and version are required' using errcode = '22023';
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.id = p_site_id
	for update;
	if not found then
		raise exception 'Only founders and admins activate site versions' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_site.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins activate site versions' using errcode = '42501';
	end if;
	if v_site.kind <> 'files' then
		raise exception 'STATIC_SITE_REQUIRED' using errcode = '22023';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	select version.* into v_version
	from public.qorpera_company_site_versions as version
	where version.id = p_version_id and version.site_id = v_site.id and version.state in ('live', 'kept', 'ready')
	for update;
	if not found then
		raise exception 'SITE_VERSION_UNAVAILABLE' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_company_site_files as file
		where file.version_id = v_version.id and file.content is null
	) then
		raise exception 'SITE_VERSION_INCOMPLETE' using errcode = '55000';
	end if;
	v_previous := v_site.current_version_id;
	update public.qorpera_company_site_versions
	set state = 'kept'
	where site_id = v_site.id and state = 'live' and id <> v_version.id;
	update public.qorpera_company_site_versions
	set state = 'live', published_at = v_now
	where id = v_version.id
	returning * into v_version;
	update public.qorpera_company_sites
	set current_version_id = v_version.id,
		title = coalesce(v_version.title, v_site.title),
		source_path = v_version.source_path,
		published_at = v_now,
		published_by_user_id = auth.uid(),
		published_by_staff_agent_id = null,
		updated_at = v_now
	where id = v_site.id;
	return jsonb_build_object(
		'schema', 'qorpera.site-version-activate/v1',
		'siteId', v_site.id,
		'slug', v_site.slug,
		'versionId', v_version.id,
		'previousVersionId', v_previous,
		'url', public.qorpera_site_url(v_site.slug),
		'activatedAt', v_now
	);
end $$;

revoke all on function public.qorpera_site_list_versions(uuid), public.qorpera_site_activate_version(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;
grant execute on function public.qorpera_site_list_versions(uuid), public.qorpera_site_activate_version(uuid, uuid)
	to authenticated;

create function public.qorpera_site_agent_list_versions(p_binding jsonb, p_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_machine_name text;
begin
	v_run := public.qorpera_site_agent_run(p_binding, true);
	if not public.qorpera_site_slug_valid(p_slug) then
		raise exception '%', 'SITE_NAME_INVALID: ' || public.qorpera_site_name_words() using errcode = '22023';
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.slug = p_slug and site.profile_id = v_run.profile_id;
	if not found then
		raise exception 'SITE_NOT_FOUND: no site of the company has this name' using errcode = '55000';
	end if;
	if v_site.machine_id is not null then
		select machine.name into v_machine_name
		from public.qorpera_company_machines as machine
		where machine.id = v_site.machine_id and machine.removed_at is null and machine.desired_state <> 'deleted';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.site-versions/v1',
		'siteId', v_site.id,
		'slug', v_site.slug,
		'kind', v_site.kind,
		'machine', v_machine_name,
		'machineId', v_site.machine_id,
		'port', v_site.app_port,
		'appAuthMode', v_site.app_auth_mode,
		'url', public.qorpera_site_url(v_site.slug),
		'currentVersionId', v_site.current_version_id,
		'versions', case when v_site.kind = 'files' then coalesce((
			select jsonb_agg(jsonb_build_object(
				'id', version.id,
				'state', version.state,
				'isCurrent', version.id = v_site.current_version_id,
				'title', version.title,
				'sourcePath', version.source_path,
				'fileCount', version.file_count,
				'totalBytes', version.total_bytes,
				'manifestSha256', version.manifest_sha256,
				'origin', case when version.tree is not null then 'code' else 'publish_site' end,
				'change', version.change,
				'createdAt', version.created_at,
				'publishedAt', version.published_at
			) order by (version.id = v_site.current_version_id) desc, version.published_at desc nulls last, version.created_at desc, version.id desc)
			from (
				select version.*
				from public.qorpera_company_site_versions as version
				where version.site_id = v_site.id and version.state in ('live', 'kept', 'ready')
				order by (version.id = v_site.current_version_id) desc, version.published_at desc nulls last, version.created_at desc, version.id desc
				limit 20
			) as version
		), '[]'::jsonb) else '[]'::jsonb end
	);
end $$;

create function public.qorpera_site_agent_activate_version(p_binding jsonb, p_slug text, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype;
	v_previous uuid;
	v_now timestamptz := clock_timestamp();
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	if not public.qorpera_site_slug_valid(p_slug) then
		raise exception '%', 'SITE_NAME_INVALID: ' || public.qorpera_site_name_words() using errcode = '22023';
	end if;
	if p_version_id is null then
		raise exception 'SITE_VERSION_UNAVAILABLE: a version id is required' using errcode = '22023';
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.slug = p_slug and site.profile_id = v_run.profile_id
	for update;
	if not found then
		raise exception 'SITE_NOT_FOUND: no site of the company has this name' using errcode = '55000';
	end if;
	if v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000';
	end if;
	if v_site.kind <> 'files' then
		raise exception 'STATIC_SITE_REQUIRED: version rollback applies to static websites, not app links' using errcode = '22023';
	end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	select version.* into v_version
	from public.qorpera_company_site_versions as version
	where version.id = p_version_id and version.site_id = v_site.id and version.state in ('live', 'kept')
	for update;
	if not found then
		raise exception 'SITE_VERSION_UNAVAILABLE: that version is not available for this site' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_company_site_files as file
		where file.version_id = v_version.id and file.content is null
	) then
		raise exception 'SITE_VERSION_INCOMPLETE: that version is missing file bytes' using errcode = '55000';
	end if;
	v_previous := v_site.current_version_id;
	update public.qorpera_company_site_versions
	set state = 'kept'
	where site_id = v_site.id and state = 'live' and id <> v_version.id;
	update public.qorpera_company_site_versions
	set state = 'live', published_at = v_now
	where id = v_version.id
	returning * into v_version;
	update public.qorpera_company_sites
	set current_version_id = v_version.id,
		title = coalesce(v_version.title, v_site.title),
		source_path = v_version.source_path,
		published_at = v_now,
		published_by_staff_agent_id = v_run.staff_agent_id,
		published_by_user_id = null,
		updated_at = v_now
	where id = v_site.id;
	return jsonb_build_object(
		'schema', 'qorpera.site-version-activate/v1',
		'siteId', v_site.id,
		'slug', v_site.slug,
		'versionId', v_version.id,
		'previousVersionId', v_previous,
		'url', public.qorpera_site_url(v_site.slug),
		'activatedAt', v_now
	);
end $$;

revoke all on function public.qorpera_site_agent_list_versions(jsonb, text),
	public.qorpera_site_agent_activate_version(jsonb, text, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;
grant execute on function public.qorpera_site_agent_list_versions(jsonb, text),
	public.qorpera_site_agent_activate_version(jsonb, text, uuid)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_site_agent_list_versions', 'binding'),
	('qorpera_site_agent_activate_version', 'binding');

create function pg_temp.app_relay_839000_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930839000' in v_definition) > 0 then
		raise exception '20260930839000 is already in %', p_function;
	end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930839000 anchor differs in %: %', p_function, left(p_old, 80);
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.app_relay_839000_replace(
	'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'share_app',$old$,
	$new$'share_app',/* 20260930839000 */'manage_site',$new$
);

drop function pg_temp.app_relay_839000_replace(regprocedure, text, text);
