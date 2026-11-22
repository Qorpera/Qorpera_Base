set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_spawn_cross_surface_session(uuid,text,text,text,jsonb)') is not null then
		raise exception 'Surface Preview Host Serving (20260930842000) is already applied';
	end if;
	if to_regclass('public.qorpera_surface_previews') is null
		or to_regprocedure('public.qorpera_site_serve_host(text,text,text,text,integer,integer)') is null
		or to_regprocedure('public.qorpera_site_member_pass_redeem(text,text)') is null
		or to_regprocedure('public.qorpera_web_edge_tls_allow(text)') is null
		or not exists (select 1 from pg_roles where rolname = 'qorpera_web_router') then
		raise exception 'Surface Preview Host Serving (20260930842000) requires 20260930756000, 20260930774000, 20260930832000, 20260930834000, and 20260930841000 first';
	end if;
end $$;

alter table public.qorpera_company_site_sessions
	drop constraint if exists qorpera_company_site_sessions_scope_check,
	drop constraint if exists qorpera_company_site_sessions_scope,
	drop constraint if exists qorpera_company_site_sessions_member,
	add column if not exists preview_host text check (preview_host is null or char_length(preview_host) between 1 and 253),
	add constraint qorpera_company_site_sessions_scope_check check (scope in ('site', 'next', 'preview')),
	add constraint qorpera_company_site_sessions_scope check ((scope in ('next', 'preview')) = (version_id is not null)),
	add constraint qorpera_company_site_sessions_member check (member_user_id is null or scope in ('site', 'preview')),
	add constraint qorpera_company_site_sessions_preview_host check ((scope = 'preview') = (preview_host is not null));

-- WHY: Matches site-serve's SITE_HOST rule for live, --next, and isolated --p<8chars> surface preview hosts (qorpera-web-router only routes live and --next hosts).
create or replace function public.qorpera_site_host_pattern(p_domain text)
returns text language sql immutable set search_path = '' as $$
	select '^([a-z0-9]+(?:-[a-z0-9]+)*)(--next|--p[a-z0-9]{8})?\.' || replace(p_domain, '.', '\.') || '$'
$$;

create or replace function public.qorpera_site_host(p_host text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_domain text := (select settings.hosts_domain from public.qorpera_site_settings as settings);
	v_label text;
	v_next boolean := false;
	v_preview_id text;
begin
	if v_domain is null or p_host is null or right(p_host, char_length(v_domain) + 1) <> ('.' || v_domain) then
		return null;
	end if;
	v_label := left(p_host, -(char_length(v_domain) + 1));
	if right(v_label, 6) = '--next' then
		v_next := true;
		v_label := left(v_label, -6);
	elsif v_label ~ '--p[a-z0-9]{8}$' then
		v_preview_id := right(v_label, 8);
		v_label := left(v_label, -11);
	end if;
	if v_label !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_label) not between 3 and 48
		or not public.qorpera_site_slug_valid(v_label) then
		return null;
	end if;
	if v_preview_id is not null then
		return jsonb_build_object('slug', v_label, 'scope', 'preview', 'previewId', v_preview_id);
	end if;
	return jsonb_build_object('slug', v_label, 'scope', case when v_next then 'next' else 'site' end);
end $$;

-- WHY: Keeps qorpera_web_edge_tls_allow aligned with qorpera-web-router's is_tls_allowed so on-demand TLS never issues certs for --p preview hosts the router does not yet route.
create or replace function public.qorpera_web_edge_tls_allow(p_domain text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_host text := lower(btrim(coalesce(p_domain, '')));
	v_settings public.qorpera_site_settings%rowtype;
	v_parsed jsonb;
	v_allowed boolean := false;
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role', 'qorpera_web_router') then
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
		if v_parsed is not null and v_parsed ->> 'scope' in ('site', 'next') then
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

create or replace function public.qorpera_site_member_pass_redeem(p_host text, p_pass text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_host text := lower(p_host);
	v_host_of jsonb;
	v_scope text;
	v_site public.qorpera_company_sites%rowtype;
	v_pass public.qorpera_company_site_member_passes%rowtype;
	v_version_id uuid;
	v_token text;
	v_now timestamptz := clock_timestamp();
begin
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' or v_host is null or not public.qorpera_site_hosts_on() then
		return '{"state":"refused"}'::jsonb;
	end if;
	v_host_of := public.qorpera_site_host(v_host);
	v_scope := v_host_of ->> 'scope';
	if v_host_of is null or v_scope not in ('site', 'preview') then
		return '{"state":"refused"}'::jsonb;
	end if;

	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.slug = v_host_of ->> 'slug'
		and site.kind = 'files'
		and (v_scope = 'preview' or site.current_version_id is not null)
		and site.taken_down_at is null
		and not public.qorpera_company_deleting(site.profile_id);
	if not found then
		return '{"state":"refused"}'::jsonb;
	end if;

	if v_scope = 'preview' then
		select p.site_version_id into v_version_id
		from public.qorpera_surface_previews p
		join public.qorpera_surfaces surf on surf.id = p.surface_id
		where surf.site_id = v_site.id
			and p.short_host_id = v_host_of ->> 'previewId'
			and p.status = 'ready'
			and p.site_version_id is not null
			and p.expires_at > v_now
		limit 1;
		if v_version_id is null then
			return '{"state":"refused"}'::jsonb;
		end if;
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

	delete from public.qorpera_company_site_member_passes as pass
	where pass.site_id = v_site.id and pass.expires_at <= v_now;

	delete from public.qorpera_company_site_sessions as session
	where session.site_id = v_site.id
		and session.member_user_id is not null
		and (session.expires_at <= v_now or session.password_version <> v_site.password_version);
	delete from public.qorpera_company_site_sessions as session
	where session.token_sha256 in (
		select old.token_sha256 from public.qorpera_company_site_sessions as old
		where old.site_id = v_site.id and old.member_user_id is not null
		order by old.created_at desc offset 49
	);

	v_token := public.qorpera_site_new_token();
	insert into public.qorpera_company_site_sessions (
		token_sha256, site_id, password_version, expires_at, scope, member_user_id, version_id, preview_host
	)
	values (
		public.qorpera_site_sha256(v_token), v_site.id, v_site.password_version,
		v_now + interval '12 hours', v_scope, v_pass.user_id, v_version_id,
		case when v_scope = 'preview' then v_host else null end
	);
	return jsonb_build_object('state', 'open', 'token', v_token, 'maxAge', 43200);
end $$;

create or replace function public.qorpera_site_serve_host(
	p_host text,
	p_path text,
	p_token text,
	p_etag text,
	p_offset integer,
	p_length integer
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_settings public.qorpera_site_settings%rowtype;
	v_host text := lower(p_host);
	v_path text;
	v_host_of jsonb;
	v_slug text;
	v_scope text;
	v_site public.qorpera_company_sites%rowtype;
	v_version uuid;
	v_status integer := 200;
	v_file_path text;
	v_type text;
	v_bytes integer;
	v_sha256 text;
	v_offset integer;
	v_length integer;
begin
	select settings.* into v_settings from public.qorpera_site_settings as settings;
	v_path := ltrim(coalesce(p_path, ''), '/');
	if v_host = substring(v_settings.origin from '^https://(.+)$') then
		v_slug := split_part(v_path, '/', 1);
		if public.qorpera_site_slug_valid(v_slug) then
			if exists (select 1 from public.qorpera_company_sites as site where site.slug = v_slug and site.kind = 'files'
				and site.taken_down_at is not null and not public.qorpera_company_deleting(site.profile_id)) then
				return '{"state":"gone"}'::jsonb;
			end if;
			if v_settings.enabled and v_settings.hosts_enabled then
				return jsonb_build_object('state', 'moved', 'url', 'https://' || v_slug || '.' || v_settings.hosts_domain || '/');
			end if;
		end if;
		return '{"state":"legacy"}'::jsonb;
	end if;
	if not (v_settings.enabled and v_settings.hosts_enabled) then return '{"state":"none"}'::jsonb; end if;
	v_host_of := public.qorpera_site_host(v_host);
	if v_host_of is null then return '{"state":"none"}'::jsonb; end if;
	v_slug := v_host_of ->> 'slug';
	v_scope := v_host_of ->> 'scope';
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = v_slug and site.kind = 'files' and not public.qorpera_company_deleting(site.profile_id);
	if not found then return '{"state":"none"}'::jsonb; end if;
	if v_site.taken_down_at is not null then return '{"state":"gone"}'::jsonb; end if;

	if v_scope = 'site' then
		if v_site.current_version_id is null then return '{"state":"none"}'::jsonb; end if;
		if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32}$' or not exists (
			select 1 from public.qorpera_company_site_sessions as session
			where session.token_sha256 = public.qorpera_site_sha256(p_token)
				and session.site_id = v_site.id
				and session.scope = 'site'
				and session.password_version = v_site.password_version
				and session.expires_at > clock_timestamp()
		) then
			return '{"state":"locked","scope":"site","public":false}'::jsonb;
		end if;
		v_version := v_site.current_version_id;
	elsif v_scope = 'preview' then
		if p_token ~ '^[A-Za-z0-9_-]{32}$' then
			select session.version_id into v_version
			from public.qorpera_company_site_sessions as session
			join public.qorpera_company_site_versions as version
				on version.id = session.version_id
				and version.site_id = v_site.id
				and version.state in ('ready', 'live', 'kept')
			where session.token_sha256 = public.qorpera_site_sha256(p_token)
				and session.site_id = v_site.id
				and session.scope = 'preview'
				and session.preview_host = v_host
				and session.member_user_id is not null
				and session.password_version = v_site.password_version
				and session.expires_at > clock_timestamp();
		end if;
		if v_version is null then
			return '{"state":"locked","scope":"preview","public":false}'::jsonb;
		end if;
	else
		if p_token ~ '^[A-Za-z0-9_-]{32}$' then
			select session.version_id into v_version
			from public.qorpera_company_site_sessions as session
			join public.qorpera_company_site_versions as version
				on version.id = session.version_id
				and version.site_id = v_site.id
				and version.state in ('ready', 'live', 'kept')
			where session.token_sha256 = public.qorpera_site_sha256(p_token)
				and session.site_id = v_site.id
				and session.scope = 'next'
				and session.password_version = v_site.password_version
				and session.expires_at > clock_timestamp();
		end if;
		if v_version is null then
			return '{"state":"locked","scope":"next","public":false}'::jsonb;
		end if;
	end if;

	if v_path = '' or right(v_path, 1) = '/' then v_path := v_path || 'index.html'; end if;
	if public.qorpera_site_path_valid(v_path) then
		select file.path, file.content_type, file.bytes, file.sha256 into v_file_path, v_type, v_bytes, v_sha256
		from public.qorpera_company_site_files as file where file.version_id = v_version and file.path = v_path;
		if v_file_path is null and exists (
			select 1 from public.qorpera_company_site_files as file
			where file.version_id = v_version and file.path = v_path || '/index.html'
		) then
			return jsonb_build_object('state', 'directory', 'path', v_path || '/', 'scope', v_scope, 'public', false);
		end if;
	end if;
	if v_file_path is null then
		select file.path, file.content_type, file.bytes, file.sha256 into v_file_path, v_type, v_bytes, v_sha256
		from public.qorpera_company_site_files as file where file.version_id = v_version and file.path = '404.html';
		if v_file_path is null then
			return jsonb_build_object('state', 'missing', 'scope', v_scope, 'public', false);
		end if;
		v_status := 404;
	end if;
	v_offset := least(greatest(coalesce(p_offset, 0), 0), v_bytes);
	v_length := least(greatest(coalesce(p_length, 0), 0), v_bytes - v_offset);
	return jsonb_build_object(
		'state', 'file',
		'status', v_status,
		'path', v_file_path,
		'contentType', v_type,
		'bytes', v_bytes,
		'sha256', v_sha256,
		'offset', v_offset,
		'content', case
			when (v_status = 200 and p_etag is not distinct from v_sha256) or v_length = 0 then null
			else (
				select translate(encode(substring(file.content from v_offset + 1 for v_length), 'base64'), chr(10), '')
				from public.qorpera_company_site_files as file where file.version_id = v_version and file.path = v_file_path
			)
		end,
		'scope', v_scope,
		'public', false
	);
end $$;

-- WHY: Powers 1-click Brand -> Website token sync and Inbox -> Product bug fix handoffs across company Surfaces.
create function public.qorpera_spawn_cross_surface_session(
	p_source_surface_id uuid,
	p_target_surface_slug text,
	p_prompt text,
	p_title text default null,
	p_source_ref jsonb default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_source public.qorpera_surfaces%rowtype;
	v_target public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_title text;
	v_placement jsonb;
	v_machine_id uuid;
	v_session public.qorpera_surface_sessions%rowtype;
begin
	if char_length(v_prompt) < 1 or char_length(v_prompt) > 16000 then
		raise exception 'Prompt must be 1..16000 characters' using errcode = '22023';
	end if;
	select * into v_source from public.qorpera_surfaces where id = p_source_surface_id;
	if v_source.id is null then raise exception 'Source surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_source.profile_id, true);

	select * into v_target
	from public.qorpera_surfaces
	where profile_id = v_source.profile_id
		and slug = lower(btrim(coalesce(p_target_surface_slug, '')))
		and status = 'active';
	if v_target.id is null then raise exception 'Target surface not found' using errcode = 'P0002'; end if;

	v_title := coalesce(nullif(btrim(coalesce(p_title, '')), ''), 'From ' || v_source.title || ': ' || left(v_prompt, 64));
	v_placement := public.qorpera_surface_machine_placement_hint(v_source.profile_id, 6);
	v_machine_id := case when v_placement ->> 'machineId' is not null then (v_placement ->> 'machineId')::uuid else null end;

	insert into public.qorpera_surface_sessions(
		profile_id, surface_id, machine_id, title, prompt,
		origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
	)
	values (
		v_source.profile_id, v_target.id, v_machine_id, left(v_title, 160), v_prompt,
		'cross_surface', 'From ' || v_source.title,
		jsonb_build_object('sourceSurfaceId', v_source.id, 'sourceSurfaceSlug', v_source.slug, 'detail', p_source_ref),
		v_user_id, 'queued', v_target.live_head_sha
	)
	returning * into v_session;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_source.profile_id, v_session.id, 'member', v_user_id, v_prompt);

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_spawn_cross_surface_session(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.qorpera_spawn_cross_surface_session(uuid, text, text, text, jsonb) to authenticated;
