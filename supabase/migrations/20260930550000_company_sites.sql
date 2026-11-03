-- 20260930550000: company sites. An agent publishes a static website from the Company File to a private,
-- password-protected link, https://sites.qorpera.com/<slug>/ (founder go, 3 November 2026: "Yes, build publishing").
--
-- 1. Settings: qorpera_site_settings, one row. Publishing and serving are switched off until the operator has routed
--    the sites host (deploy/sites/), then `update public.qorpera_site_settings set enabled = true;`. Off again, every
--    site answers as locked and no agent publishes; nothing is deleted.
-- 2. Tables, none readable by an API role (service_role included): every read and write goes through the functions
--    below.
--    - qorpera_company_sites: one per slug, across all companies (one shared origin, path-based). A site belongs to
--      its company (profile_id, on delete cascade), so deleting the company deletes its sites with it
--      (qorpera_purge_company walks the foreign keys). A site whose first upload never finished holds its slug for
--      its company; another company may take the slug a day after its last activity.
--    - qorpera_company_site_secrets: the site's password, which owners and admins read and change in Settings →
--      Sites. Stored as written, since founders copy it to share; never shown to an agent or a visitor.
--    - qorpera_company_site_versions and qorpera_company_site_files: each publish is a new version, filled while
--      'uploading' and switched in at once ('live'); the version it replaced goes in the same transaction. Files are
--      bytes in the database (at most 25 MiB and 500 files a site, 10 MiB a file), so a switch, an unpublish and a
--      company's deletion are one transaction each, with no object store to clean after them.
--    - qorpera_company_site_sessions: a visitor's session after the password, by its token's sha256, for 7 days;
--      a new password ends them all.
--    - qorpera_site_unlock_failures: wrong passwords by slug and an HMAC of the visitor's network (an IPv4 address, an
--      IPv6 /64), for an hour, for the limits (10 per network and slug and 30 per network across slugs per 15
--      minutes, 300 per slug per hour).
-- 3. The agent's calls, through the native host with the run's binding (qorpera_native_host_calls, scope binding):
--    qorpera_site_publish_check (read only: new or update, before the automatic review), then
--    qorpera_site_publish_begin / _put / _finish, and qorpera_site_unpublish. Only a company agent's run (no worker)
--    whose wake allows work. A new site (no live version yet), and an update from another source folder than the live
--    version's, needs the automatic review's approval of that call in this run: a built-in check (the runtime records
--    such a publish as an access change, so an owner or admin answers its card, unless a company Allow rule covers
--    it), for this slug, answered Allow in this run or allowed for this very call. Any other update does not. A
--    resumed attempt that has not recorded its resume publishes and unpublishes nothing (as 20260930546000).
-- 4. The members' calls (Settings → Sites): any member lists the company's sites; owners and admins read and change a
--    password and unpublish a site.
-- 5. The edge function site-serve's calls (service_role only): qorpera_site_serve (a file for a session) and
--    qorpera_site_unlock (the password, its limits and a new session). An unknown slug answers as a locked one.
-- 6. Observations name publish_site and unpublish_site, as the runtime's closed vocabulary does.
-- Every inserted text names this migration (20260930550000).

do $$
begin
	if to_regclass('public.qorpera_company_sites') is not null then
		raise exception '20260930550000 (company sites) is already applied'; end if;
	if to_regprocedure('public.qorpera_native_tool_locked_run(jsonb)') is null
		or to_regprocedure('public.qorpera_assert_wake_work_allowed(uuid)') is null
		or to_regprocedure('public.qorpera_run_worker(uuid)') is null
		or to_regprocedure('public.qorpera_company_deleting(uuid)') is null
		or to_regprocedure('public.qorpera_member_role(uuid)') is null
		or to_regprocedure('public.qorpera_run_resumes_from_receipts(uuid)') is null
		or to_regprocedure('public.qorpera_memory_run_resume_of(uuid,uuid,uuid)') is null
		or to_regclass('public.qorpera_memory_run_resumes') is null
		or to_regclass('public.qorpera_action_reviews') is null
		or to_regclass('public.qorpera_native_host_calls') is null then
		raise exception '20260930550000 (company sites) needs G1 b (20260930539000) and the auto-review tables'; end if;
end $$;

set local lock_timeout = '3s';

-- 1. Settings ----------------------------------------------------------------------------------------------------------

create table public.qorpera_site_settings (
	id boolean primary key default true check (id),
	enabled boolean not null default false,
	-- The public origin the links name, with no path.
	origin text not null default 'https://sites.qorpera.com' check (origin ~ '^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
	-- The key of the visitors' address hashes (an HMAC), so a stored hash never gives the address back.
	client_key bytea not null default extensions.gen_random_bytes(32) check (octet_length(client_key) = 32)
);
insert into public.qorpera_site_settings default values;
alter table public.qorpera_site_settings enable row level security;
revoke all on public.qorpera_site_settings from public, anon, authenticated, service_role;

-- 2. Tables ------------------------------------------------------------------------------------------------------------

create table public.qorpera_company_sites (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	-- 3 to 48 lowercase letters, digits and hyphens, a letter or digit at each end (reserved names: below).
	slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
	title text check (title is null or (char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]' and title = btrim(title))),
	source_path text not null check (char_length(source_path) between 1 and 4096 and source_path !~ '[[:cntrl:]]'),
	-- The live version; null until the first upload is switched in.
	current_version_id uuid,
	-- A new password ends every session of the old one.
	password_version integer not null default 1 check (password_version > 0),
	created_by_staff_agent_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	published_at timestamptz,
	published_by_staff_agent_id uuid,
	check ((published_at is null) = (published_by_staff_agent_id is null))
);
create index qorpera_company_sites_profile on public.qorpera_company_sites(profile_id);
create index qorpera_company_sites_environment on public.qorpera_company_sites(environment_id);

create table public.qorpera_company_site_secrets (
	site_id uuid primary key references public.qorpera_company_sites(id) on delete cascade,
	password text not null check (char_length(password) between 10 and 128 and password !~ '[[:cntrl:]]' and btrim(password) <> ''),
	changed_at timestamptz not null default clock_timestamp(),
	-- Null: made by the platform at the first publish.
	changed_by_user_id uuid references auth.users(id) on delete set null
);

create table public.qorpera_company_site_versions (
	id uuid primary key default extensions.gen_random_uuid(),
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	state text not null default 'uploading' check (state in ('uploading', 'live')),
	-- The tool call that publishes it: the same call again is the same version.
	run_id uuid not null,
	call_id text not null check (char_length(call_id) between 1 and 200 and call_id !~ '[[:cntrl:]]'),
	staff_agent_id uuid not null,
	-- The site had no live version when this one began: it needed its approval, and going live opens the site.
	first_publish boolean not null,
	title text check (title is null or (char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]' and title = btrim(title))),
	source_path text not null check (char_length(source_path) between 1 and 4096 and source_path !~ '[[:cntrl:]]'),
	-- sha256 of its lines `<path> TAB <sha256> TAB <bytes>`, in path order (C), joined by LF.
	manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	file_count integer not null check (file_count between 1 and 500),
	total_bytes bigint not null check (total_bytes between 0 and 26214400),
	created_at timestamptz not null default clock_timestamp(),
	published_at timestamptz,
	check ((state = 'live') = (published_at is not null)),
	unique (site_id, run_id, call_id)
);
create index qorpera_company_site_versions_site on public.qorpera_company_site_versions(site_id, state);
-- Set null, never restrict: the version a site names goes only with its site, and the purge walks only the edges
-- that delete or block.
alter table public.qorpera_company_sites add constraint qorpera_company_sites_current_version
	foreign key (current_version_id) references public.qorpera_company_site_versions(id) on delete set null;

create table public.qorpera_company_site_files (
	version_id uuid not null references public.qorpera_company_site_versions(id) on delete cascade,
	-- Segments of letters, digits, '.', '_' and '-', none starting with '.' or '-', at most 16 of them and 512 characters.
	path text not null check (char_length(path) <= 512
		and path ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}(/[A-Za-z0-9_][A-Za-z0-9._-]{0,199}){0,15}$'),
	bytes integer not null check (bytes between 0 and 10485760),
	sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
	content_type text not null check (char_length(content_type) between 1 and 100),
	-- Null until its upload; checked against bytes and sha256 as it lands.
	content bytea check (content is null or octet_length(content) = bytes),
	primary key (version_id, path)
);
-- Out of line and uncompressed, so a byte range (a video's) reads only the chunks it covers.
alter table public.qorpera_company_site_files alter column content set storage external;

create table public.qorpera_company_site_sessions (
	token_sha256 text primary key check (token_sha256 ~ '^[0-9a-f]{64}$'),
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	password_version integer not null,
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null
);
create index qorpera_company_site_sessions_site on public.qorpera_company_site_sessions(site_id, expires_at);

-- No company key: an unknown slug is limited as a known one is. Rows go after an hour.
create table public.qorpera_site_unlock_failures (
	slug text not null check (char_length(slug) between 1 and 48),
	client_sha256 text not null check (client_sha256 ~ '^[0-9a-f]{64}$'),
	failed_at timestamptz not null default clock_timestamp()
);
create index qorpera_site_unlock_failures_slug on public.qorpera_site_unlock_failures(slug, failed_at);
create index qorpera_site_unlock_failures_client on public.qorpera_site_unlock_failures(slug, client_sha256, failed_at);
create index qorpera_site_unlock_failures_age on public.qorpera_site_unlock_failures(failed_at);
create index qorpera_site_unlock_failures_network on public.qorpera_site_unlock_failures(client_sha256, failed_at);

alter table public.qorpera_company_sites enable row level security;
alter table public.qorpera_company_site_secrets enable row level security;
alter table public.qorpera_company_site_versions enable row level security;
alter table public.qorpera_company_site_files enable row level security;
alter table public.qorpera_company_site_sessions enable row level security;
alter table public.qorpera_site_unlock_failures enable row level security;
revoke all on public.qorpera_company_sites, public.qorpera_company_site_secrets, public.qorpera_company_site_versions,
	public.qorpera_company_site_files, public.qorpera_company_site_sessions, public.qorpera_site_unlock_failures
	from public, anon, authenticated, service_role;

-- Helpers (no API role calls them) ---------------------------------------------------------------------------------------

create function public.qorpera_site_slug_valid(p_slug text) returns boolean language sql immutable set search_path = '' as $$
	-- 20260930550000
	select coalesce(p_slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' and p_slug not in ('api', 'app', 'www', 'admin',
		'assets', 'static', 'qorpera', 'login', 'signin', 'signup', 'robots', 'favicon', 'sites', 'site', 'well-known',
		'help', 'support', 'status', 'mail', 'functions', 'auth', 'rest', 'storage', 'realtime'), false)
$$;

create function public.qorpera_site_path_valid(p_path text) returns boolean language sql immutable set search_path = '' as $$
	-- 20260930550000
	select coalesce(char_length(p_path) <= 512
		and p_path ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}(/[A-Za-z0-9_][A-Za-z0-9._-]{0,199}){0,15}$', false)
$$;

-- The content type a site file is served with, by its extension; null for a type a site cannot serve (anything that
-- is not a static web file: no server code is ever run).
create function public.qorpera_site_content_type(p_path text) returns text language sql immutable set search_path = '' as $$
	-- 20260930550000
	select case lower(substring(p_path from '\.([A-Za-z0-9]{1,12})$'))
		when 'html' then 'text/html; charset=utf-8' when 'htm' then 'text/html; charset=utf-8'
		when 'css' then 'text/css; charset=utf-8'
		when 'js' then 'text/javascript; charset=utf-8' when 'mjs' then 'text/javascript; charset=utf-8'
		when 'json' then 'application/json; charset=utf-8' when 'map' then 'application/json; charset=utf-8'
		when 'webmanifest' then 'application/manifest+json; charset=utf-8'
		when 'txt' then 'text/plain; charset=utf-8' when 'csv' then 'text/csv; charset=utf-8'
		when 'xml' then 'application/xml; charset=utf-8'
		when 'svg' then 'image/svg+xml'
		when 'png' then 'image/png' when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg' when 'gif' then 'image/gif'
		when 'webp' then 'image/webp' when 'avif' then 'image/avif' when 'ico' then 'image/x-icon'
		when 'woff' then 'font/woff' when 'woff2' then 'font/woff2' when 'ttf' then 'font/ttf' when 'otf' then 'font/otf'
		when 'mp4' then 'video/mp4' when 'webm' then 'video/webm'
		when 'mp3' then 'audio/mpeg' when 'm4a' then 'audio/mp4' when 'ogg' then 'audio/ogg' when 'wav' then 'audio/wav'
		when 'pdf' then 'application/pdf'
	end
$$;

create function public.qorpera_site_url(p_slug text) returns text language sql stable security definer set search_path = '' as $$
	-- 20260930550000
	select settings.origin || '/' || p_slug || '/' from public.qorpera_site_settings as settings
$$;

-- A new password: three groups of four from 31 letters and digits that are never mistaken for each other (59 bits).
create function public.qorpera_site_new_password() returns text language plpgsql volatile set search_path = '' as $$
-- 20260930550000
declare c_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789'; v_bytes bytea; v_chars text := ''; i integer;
begin
	while char_length(v_chars) < 12 loop
		v_bytes := extensions.gen_random_bytes(16);
		for i in 0..15 loop
			exit when char_length(v_chars) = 12;
			-- Rejection sampling: 248 = 8 * 31, so every letter is as likely.
			if get_byte(v_bytes, i) < 248 then
				v_chars := v_chars || substr(c_alphabet, get_byte(v_bytes, i) % 31 + 1, 1); end if;
		end loop;
	end loop;
	return substr(v_chars, 1, 4) || '-' || substr(v_chars, 5, 4) || '-' || substr(v_chars, 9, 4);
end $$;

-- A visitor's session token: 24 random bytes in base64url, 32 characters.
create function public.qorpera_site_new_token() returns text language sql volatile set search_path = '' as $$
	-- 20260930550000
	select translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_')
$$;

create function public.qorpera_site_sha256(p_text text) returns text language sql immutable set search_path = '' as $$
	-- 20260930550000
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;

-- A site whose first upload never finished, a day after its last change: another company may take its slug.
create function public.qorpera_site_abandoned(p_site public.qorpera_company_sites) returns boolean language sql stable
set search_path = '' as $$
	-- 20260930550000
	select p_site.current_version_id is null and p_site.updated_at < clock_timestamp() - interval '1 day'
$$;

-- The slug a recorded review's call named, read from the exact arguments its card shows; null when they are not an
-- object with a string slug.
create function public.qorpera_site_review_slug(p_arguments text) returns text language plpgsql immutable
set search_path = '' as $$
-- 20260930550000
declare v jsonb;
begin
	begin v := p_arguments::jsonb;
	exception when others then return null; end;
	return case when jsonb_typeof(v) = 'object' and jsonb_typeof(v -> 'slug') = 'string' then v ->> 'slug' end;
end $$;

-- The run that may publish: a company agent's (never a worker's), whose wake allows work, with publishing switched on
-- (or, for p_unpublishing, whatever the switch says: taking a site offline is always allowed).
create function public.qorpera_site_agent_run(p_binding jsonb, p_unpublishing boolean default false)
returns public.qorpera_execution_runs language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_run public.qorpera_execution_runs%rowtype;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Only a company agent publishes websites' using errcode = '42501'; end if;
	if not p_unpublishing and not coalesce((select settings.enabled from public.qorpera_site_settings as settings), false) then
		raise exception 'Publishing websites is not switched on yet' using errcode = '0A000'; end if;
	return v_run;
end $$;

-- A resumed attempt of a run with no log changes no site before it records its resume (as 20260930546000 fences mail).
create function public.qorpera_site_assert_resume_recorded(p_run_id uuid, p_binding jsonb) returns void
language plpgsql security definer set search_path = '' as $$
-- 20260930550000
begin
	if public.qorpera_run_resumes_from_receipts(p_run_id) and not exists (select 1 from public.qorpera_memory_run_resumes as resume
		where resume.run_id = p_run_id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid)
		and public.qorpera_memory_run_resume_of(p_run_id, (p_binding ->> 'assignmentId')::uuid,
			(p_binding ->> 'leaseId')::uuid) is not null then
		raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
end $$;

-- What the agent is told about a site and one of its versions; never its password.
create function public.qorpera_site_publish_receipt(p_site public.qorpera_company_sites,
	p_version public.qorpera_company_site_versions, p_unchanged boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930550000
	select jsonb_build_object('schema', 'qorpera.site-publish/v1', 'siteId', p_site.id, 'slug', p_site.slug,
		'url', public.qorpera_site_url(p_site.slug),
		'mode', case when p_version.first_publish and not p_unchanged then 'new' else 'update' end, 'versionId', p_version.id,
		'state', case when p_version.state = 'live' then 'live' else 'uploading' end, 'unchanged', p_unchanged,
		'files', p_version.file_count, 'bytes', p_version.total_bytes,
		'missing', coalesce((select jsonb_agg(file.path order by file.path collate "C") from public.qorpera_company_site_files as file
			where file.version_id = p_version.id and file.content is null), '[]'::jsonb))
$$;

revoke all on function public.qorpera_site_slug_valid(text), public.qorpera_site_path_valid(text),
	public.qorpera_site_content_type(text), public.qorpera_site_url(text), public.qorpera_site_new_password(),
	public.qorpera_site_new_token(), public.qorpera_site_sha256(text),
	public.qorpera_site_abandoned(public.qorpera_company_sites), public.qorpera_site_review_slug(text),
	public.qorpera_site_agent_run(jsonb, boolean), public.qorpera_site_assert_resume_recorded(uuid, jsonb),
	public.qorpera_site_publish_receipt(public.qorpera_company_sites, public.qorpera_company_site_versions, boolean)
	from public, anon, authenticated, service_role;

-- 3. The agent's calls -------------------------------------------------------------------------------------------------

-- Before the automatic review (the tool's prepare): whether publishing this slug makes a new site or updates a live
-- one of this company. Reads only.
create function public.qorpera_site_publish_check(p_binding jsonb, p_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_run public.qorpera_execution_runs%rowtype; v_site public.qorpera_company_sites%rowtype;
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	if not public.qorpera_site_slug_valid(p_slug) then
		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.slug = p_slug;
	if found and v_site.profile_id = v_run.profile_id then
		return jsonb_build_object('schema', 'qorpera.site-publish-check/v1', 'slug', p_slug, 'url', public.qorpera_site_url(p_slug),
			'mode', case when v_site.current_version_id is null then 'new' else 'update' end, 'siteId', v_site.id,
			'liveSource', case when v_site.current_version_id is not null then v_site.source_path end);
	end if;
	if found and not public.qorpera_site_abandoned(v_site) then
		raise exception 'SITE_NAME_TAKEN: another site already has this name; choose another' using errcode = '55000'; end if;
	if (select count(*) from public.qorpera_company_sites as site where site.profile_id = v_run.profile_id) >= 10 then
		raise exception 'SITE_LIMIT: the company has 10 sites, as many as it can have; update or unpublish one first'
			using errcode = '55000'; end if;
	return jsonb_build_object('schema', 'qorpera.site-publish-check/v1', 'slug', p_slug, 'url', public.qorpera_site_url(p_slug),
		'mode', 'new', 'siteId', null, 'liveSource', null);
end $$;

-- A publish's first step: the site (new: with its password), and a new version with every file named, each file's
-- bytes copied from the live version when it has the same digest. Answers which files still need their bytes. The
-- same call again (its run and call id) answers its own version as it is now.
create function public.qorpera_site_publish_begin(p_binding jsonb, p_call_id text, p_request jsonb, p_review_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare
	v_run public.qorpera_execution_runs%rowtype; v_site public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype; v_slug text; v_title text; v_source text; v_manifest text;
	v_count integer; v_total bigint; v_new boolean; v_current_manifest text;
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	if p_call_id is null or char_length(p_call_id) not between 1 and 200 or p_call_id ~ '[[:cntrl:]]'
		or jsonb_typeof(p_request) is distinct from 'object'
		or not (p_request ?& array['slug', 'source', 'manifestSha256', 'files'])
		or p_request - array['slug', 'title', 'source', 'manifestSha256', 'files'] <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'slug') is distinct from 'string'
		or jsonb_typeof(p_request -> 'source') is distinct from 'string'
		or jsonb_typeof(p_request -> 'manifestSha256') is distinct from 'string'
		or coalesce(jsonb_typeof(p_request -> 'title'), 'string') not in ('string', 'null')
		or jsonb_typeof(p_request -> 'files') is distinct from 'array' then
		raise exception 'Site publish request is invalid' using errcode = '22023'; end if;
	v_slug := p_request ->> 'slug';
	if not public.qorpera_site_slug_valid(v_slug) then
		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;
	-- The same call again: its own version, if it still sends the same files.
	select version.* into v_version from public.qorpera_company_site_versions as version
	join public.qorpera_company_sites as site on site.id = version.site_id
	where site.slug = v_slug and site.profile_id = v_run.profile_id and version.run_id = v_run.id and version.call_id = p_call_id;
	if found then
		if v_version.manifest_sha256 is distinct from p_request ->> 'manifestSha256' then
			raise exception 'SITE_SOURCE_CHANGED: the files changed since this call began; call publish_site again'
				using errcode = '22023'; end if;
		select site.* into v_site from public.qorpera_company_sites as site where site.id = v_version.site_id;
		return public.qorpera_site_publish_receipt(v_site, v_version);
	end if;
	v_title := nullif(btrim(p_request ->> 'title'), '');
	v_source := p_request ->> 'source';
	if (v_title is not null and (char_length(v_title) > 120 or v_title ~ '[[:cntrl:]]'))
		or char_length(v_source) not between 1 and 4096 or v_source ~ '[[:cntrl:]]' then
		raise exception 'Site publish request is invalid' using errcode = '22023'; end if;
	-- The files: 1 to 500 distinct paths a site can serve, each named with its size and digest, at most 10 MiB each and
	-- 25 MiB in all, with an index.html at the top.
	if jsonb_array_length(p_request -> 'files') not between 1 and 500 or exists (
		select 1 from jsonb_array_elements(p_request -> 'files') as item(value)
		where jsonb_typeof(item.value) is distinct from 'object' or item.value - array['path', 'bytes', 'sha256'] <> '{}'::jsonb
			or jsonb_typeof(item.value -> 'path') is distinct from 'string'
			or jsonb_typeof(item.value -> 'bytes') is distinct from 'number'
			or jsonb_typeof(item.value -> 'sha256') is distinct from 'string'
			or not public.qorpera_site_path_valid(item.value ->> 'path')
			or public.qorpera_site_content_type(item.value ->> 'path') is null
			or (item.value ->> 'bytes') !~ '^[0-9]{1,8}$' or (item.value ->> 'bytes')::bigint > 10485760
			or item.value ->> 'sha256' !~ '^[0-9a-f]{64}$') then
		raise exception 'SITE_FILES_INVALID: each file is a web file (HTML, CSS, JavaScript, JSON, text, images, fonts, audio, video or PDF) of at most 10 MiB, at a path of letters, digits, dots, hyphens and underscores'
			using errcode = '22023'; end if;
	select count(distinct item.value ->> 'path'), sum((item.value ->> 'bytes')::bigint),
		encode(extensions.digest(convert_to(string_agg((item.value ->> 'path') || chr(9) || (item.value ->> 'sha256') || chr(9)
			|| ((item.value ->> 'bytes')::bigint)::text, chr(10) order by (item.value ->> 'path') collate "C"), 'utf8'), 'sha256'), 'hex')
	into v_count, v_total, v_manifest
	from jsonb_array_elements(p_request -> 'files') as item(value);
	if v_count <> jsonb_array_length(p_request -> 'files') then
		raise exception 'SITE_FILES_INVALID: a path is named twice' using errcode = '22023'; end if;
	if v_total > 26214400 then
		raise exception 'SITE_TOO_LARGE: a site is at most 25 MiB' using errcode = '22023'; end if;
	if not exists (select 1 from jsonb_array_elements(p_request -> 'files') as item(value) where item.value ->> 'path' = 'index.html') then
		raise exception 'SITE_NO_INDEX: a site needs an index.html at its top' using errcode = '22023'; end if;
	if v_manifest <> p_request ->> 'manifestSha256' then
		raise exception 'Site publish request is invalid' using errcode = '22023'; end if;

	-- The site, locked for the rest of the publish.
	select site.* into v_site from public.qorpera_company_sites as site where site.slug = v_slug for update;
	if found and v_site.profile_id <> v_run.profile_id then
		if not public.qorpera_site_abandoned(v_site) then
			raise exception 'SITE_NAME_TAKEN: another site already has this name; choose another' using errcode = '55000'; end if;
		delete from public.qorpera_company_sites where id = v_site.id;
		v_site := null;
	end if;
	v_new := v_site.id is null or v_site.current_version_id is null;
	-- An update without a title keeps the site's.
	if v_title is null and not v_new then v_title := v_site.title; end if;
	if v_site.id is null and (select count(*) from public.qorpera_company_sites as site where site.profile_id = v_run.profile_id) >= 10 then
		raise exception 'SITE_LIMIT: the company has 10 sites, as many as it can have; update or unpublish one first'
			using errcode = '55000'; end if;
	-- A new site, or a live one switched to another source folder, goes out only on the automatic review's approval of a
	-- built-in check of this agent's publish_site with this slug, in this run: an owner's or admin's Allow on its card,
	-- which this run used, or the reviewer's allow of this very call under a company Allow rule. An approval never
	-- carries over to another run.
	if (v_new or v_site.source_path is distinct from v_source) and not exists (select 1 from public.qorpera_action_reviews as review
		where review.id = p_review_id and review.profile_id = v_run.profile_id and review.staff_agent_id = v_run.staff_agent_id
			and review.tool_name = 'publish_site'
			and review.built_in in ('money', 'legal_terms', 'delete_outside', 'access_change')
			and ((review.answer in ('allow_once', 'always_allow') and review.consumed_run_id = v_run.id)
				or (review.decision = 'allow' and review.run_id = v_run.id and review.call_id = p_call_id))
			and public.qorpera_site_review_slug(review.action ->> 'arguments') = v_slug) then
		raise exception 'SITE_APPROVAL_REQUIRED: a new website, or a website from another folder, goes out only after an owner or admin approves it on a card'
			using errcode = '42501'; end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	if v_site.id is null then
		insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
		values (v_run.profile_id, v_run.environment_id, v_slug, v_title, v_source, v_run.staff_agent_id)
		returning * into v_site;
		insert into public.qorpera_company_site_secrets (site_id, password) values (v_site.id, public.qorpera_site_new_password());
	end if;
	-- The same files as the live version: nothing to publish.
	select version.manifest_sha256 into v_current_manifest from public.qorpera_company_site_versions as version
	where version.id = v_site.current_version_id;
	if v_current_manifest = v_manifest and (v_title is not distinct from v_site.title) then
		select version.* into v_version from public.qorpera_company_site_versions as version where version.id = v_site.current_version_id;
		return public.qorpera_site_publish_receipt(v_site, v_version, true);
	end if;
	-- One open upload a site: this one replaces any other (whose own put or finish then answers SITE_UPLOAD_GONE).
	delete from public.qorpera_company_site_versions as version where version.site_id = v_site.id and version.state = 'uploading';
	update public.qorpera_company_sites set updated_at = clock_timestamp() where id = v_site.id;
	insert into public.qorpera_company_site_versions (site_id, run_id, call_id, staff_agent_id, first_publish, title,
		source_path, manifest_sha256, file_count, total_bytes)
	values (v_site.id, v_run.id, p_call_id, v_run.staff_agent_id, v_new, v_title, v_source, v_manifest, v_count, v_total)
	returning * into v_version;
	insert into public.qorpera_company_site_files (version_id, path, bytes, sha256, content_type, content)
	select v_version.id, item.value ->> 'path', (item.value ->> 'bytes')::integer, item.value ->> 'sha256',
		public.qorpera_site_content_type(item.value ->> 'path'),
		(select live.content from public.qorpera_company_site_files as live
			where live.version_id = v_site.current_version_id and live.sha256 = item.value ->> 'sha256'
				and live.bytes = (item.value ->> 'bytes')::integer and live.content is not null limit 1)
	from jsonb_array_elements(p_request -> 'files') as item(value);
	return public.qorpera_site_publish_receipt(v_site, v_version);
end $$;

-- A batch of file bytes for an uploading version of this run: each file's base64 content, checked against the size
-- and digest the begin named. At most 10 MiB of bytes a call (one file's most). Answers the files still missing.
create function public.qorpera_site_publish_put(p_binding jsonb, p_version_id uuid, p_files jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare
	v_run public.qorpera_execution_runs%rowtype; v_version public.qorpera_company_site_versions%rowtype;
	v_site public.qorpera_company_sites%rowtype; v_item jsonb; v_file public.qorpera_company_site_files%rowtype;
	v_bytes bytea; v_used bigint := 0;
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	select version.* into v_version from public.qorpera_company_site_versions as version
	join public.qorpera_company_sites as site on site.id = version.site_id
	where version.id = p_version_id and version.run_id = v_run.id and site.profile_id = v_run.profile_id
	for update of version;
	if not found then
		raise exception 'SITE_UPLOAD_GONE: this upload is no longer open; publish again' using errcode = '55000'; end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = v_version.site_id;
	if v_version.state = 'live' then return public.qorpera_site_publish_receipt(v_site, v_version); end if;
	if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) not between 1 and 500
		or octet_length(p_files::text) > 15204352 then
		raise exception 'Site upload is invalid' using errcode = '22023'; end if;
	for v_item in select item.value from jsonb_array_elements(p_files) as item(value) loop
		if jsonb_typeof(v_item) is distinct from 'object' or v_item - array['path', 'content'] <> '{}'::jsonb
			or jsonb_typeof(v_item -> 'path') is distinct from 'string' or jsonb_typeof(v_item -> 'content') is distinct from 'string' then
			raise exception 'Site upload is invalid' using errcode = '22023'; end if;
		select file.* into v_file from public.qorpera_company_site_files as file
		where file.version_id = v_version.id and file.path = v_item ->> 'path';
		if not found then raise exception 'Site upload is invalid' using errcode = '22023'; end if;
		begin
			v_bytes := decode(v_item ->> 'content', 'base64');
		exception when others then
			raise exception 'Site upload is invalid' using errcode = '22023';
		end;
		v_used := v_used + octet_length(v_bytes);
		if v_used > 10485760 then raise exception 'Site upload is invalid' using errcode = '22023'; end if;
		if octet_length(v_bytes) <> v_file.bytes or encode(extensions.digest(v_bytes, 'sha256'), 'hex') <> v_file.sha256 then
			raise exception 'SITE_FILE_CHANGED: a file''s bytes are not the ones named when the publish began; publish again'
				using errcode = '22023'; end if;
		update public.qorpera_company_site_files set content = v_bytes
		where version_id = v_version.id and path = v_file.path and content is null;
	end loop;
	return jsonb_build_object('schema', 'qorpera.site-publish-put/v1', 'versionId', v_version.id,
		'missing', coalesce((select jsonb_agg(file.path order by file.path collate "C") from public.qorpera_company_site_files as file
			where file.version_id = v_version.id and file.content is null), '[]'::jsonb));
end $$;

-- A publish's last step: the version, complete, goes live in place of the one before, which goes. The same call again
-- answers it as live.
create function public.qorpera_site_publish_finish(p_binding jsonb, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare
	v_run public.qorpera_execution_runs%rowtype; v_version public.qorpera_company_site_versions%rowtype;
	v_site public.qorpera_company_sites%rowtype; v_now timestamptz := clock_timestamp();
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	select site.* into v_site from public.qorpera_company_sites as site
	where site.id = (select version.site_id from public.qorpera_company_site_versions as version where version.id = p_version_id)
		and site.profile_id = v_run.profile_id
	for update;
	select version.* into v_version from public.qorpera_company_site_versions as version
	where version.id = p_version_id and version.site_id = v_site.id and version.run_id = v_run.id for update;
	if v_site.id is null or v_version.id is null then
		raise exception 'SITE_UPLOAD_GONE: this upload is no longer open; publish again' using errcode = '55000'; end if;
	if v_version.state = 'live' then
		return public.qorpera_site_publish_receipt(v_site, v_version);
	end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	if exists (select 1 from public.qorpera_company_site_files as file where file.version_id = v_version.id and file.content is null) then
		raise exception 'SITE_UPLOAD_INCOMPLETE: some files have no bytes yet' using errcode = '55000'; end if;
	update public.qorpera_company_site_versions set state = 'live', published_at = v_now where id = v_version.id
	returning * into v_version;
	update public.qorpera_company_sites set current_version_id = v_version.id, title = v_version.title,
		source_path = v_version.source_path, published_at = v_now, published_by_staff_agent_id = v_version.staff_agent_id,
		updated_at = v_now
	where id = v_site.id returning * into v_site;
	-- The version it replaced.
	delete from public.qorpera_company_site_versions as version where version.site_id = v_site.id and version.id <> v_version.id;
	return public.qorpera_site_publish_receipt(v_site, v_version);
end $$;

-- Takes one of the company's sites offline: its files, password and sessions go. Allowed with publishing switched
-- off.
create function public.qorpera_site_unpublish(p_binding jsonb, p_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_run public.qorpera_execution_runs%rowtype; v_removed boolean;
begin
	v_run := public.qorpera_site_agent_run(p_binding, true);
	if not public.qorpera_site_slug_valid(p_slug) then
		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens' using errcode = '22023'; end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	with removed as (delete from public.qorpera_company_sites as site where site.slug = p_slug and site.profile_id = v_run.profile_id
		returning 1)
	select exists (select 1 from removed) into v_removed;
	return jsonb_build_object('schema', 'qorpera.site-unpublish/v1', 'slug', p_slug, 'removed', v_removed);
end $$;

revoke all on function public.qorpera_site_publish_check(jsonb, text), public.qorpera_site_publish_begin(jsonb, text, jsonb, uuid),
	public.qorpera_site_publish_put(jsonb, uuid, jsonb), public.qorpera_site_publish_finish(jsonb, uuid),
	public.qorpera_site_unpublish(jsonb, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_site_publish_check(jsonb, text), public.qorpera_site_publish_begin(jsonb, text, jsonb, uuid),
	public.qorpera_site_publish_put(jsonb, uuid, jsonb), public.qorpera_site_publish_finish(jsonb, uuid),
	public.qorpera_site_unpublish(jsonb, text)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_site_publish_check', 'binding'), ('qorpera_site_publish_begin', 'binding'), ('qorpera_site_publish_put', 'binding'), ('qorpera_site_publish_finish', 'binding'), ('qorpera_site_unpublish', 'binding');

-- 4. The members' calls --------------------------------------------------------------------------------------------------

create function public.qorpera_list_company_sites(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930550000
begin
	if auth.uid() is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only the company''s members see its sites' using errcode = '42501'; end if;
	return coalesce((select jsonb_agg(jsonb_build_object('schema', 'qorpera.company-site/v1', 'id', site.id, 'slug', site.slug,
		'title', site.title, 'url', public.qorpera_site_url(site.slug),
		'state', case when site.current_version_id is null then 'publishing' else 'live' end,
		'source', site.source_path, 'files', coalesce(version.file_count, 0), 'bytes', coalesce(version.total_bytes, 0),
		'publishedAt', site.published_at,
		'publishedBy', case when staff.staff_agent_id is not null then jsonb_build_object('agentId', staff.staff_agent_id,
			'name', staff.display_name) end,
		'createdAt', site.created_at, 'passwordChangedAt', secret.changed_at)
		order by coalesce(site.published_at, site.created_at) desc, site.slug collate "C")
		from public.qorpera_company_sites as site
		join public.qorpera_company_site_secrets as secret on secret.site_id = site.id
		left join public.qorpera_company_site_versions as version on version.id = site.current_version_id
		left join public.qorpera_profile_staff as staff on staff.profile_id = site.profile_id
			and staff.staff_agent_id = site.published_by_staff_agent_id
		where site.profile_id = p_profile_id), '[]'::jsonb);
end $$;

-- The site, locked, for an owner or admin of its company; 42501 for anyone else (a site that is gone included).
create function public.qorpera_company_site_for_admin(p_site_id uuid)
returns public.qorpera_company_sites language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_site public.qorpera_company_sites%rowtype;
begin
	-- Who asks first, then the lock: a member who may not cannot hold the site's row.
	if auth.uid() is null or coalesce(public.qorpera_member_role((select site.profile_id from public.qorpera_company_sites as site
		where site.id = p_site_id))::text not in ('owner', 'admin'), true) then
		raise exception 'Only founders and admins see or change a site''s password' using errcode = '42501'; end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site_id for update;
	if v_site.id is null or coalesce(public.qorpera_member_role(v_site.profile_id)::text not in ('owner', 'admin'), true) then
		raise exception 'Only founders and admins see or change a site''s password' using errcode = '42501'; end if;
	return v_site;
end $$;
revoke all on function public.qorpera_company_site_for_admin(uuid) from public, anon, authenticated, service_role;

create function public.qorpera_company_site_password(p_site_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_site public.qorpera_company_sites%rowtype;
begin
	v_site := public.qorpera_company_site_for_admin(p_site_id);
	return (select jsonb_build_object('schema', 'qorpera.company-site-password/v1', 'siteId', v_site.id,
		'password', secret.password, 'changedAt', secret.changed_at)
		from public.qorpera_company_site_secrets as secret where secret.site_id = v_site.id);
end $$;

-- A new password (null: a new random one): every visitor's session ends, so they enter the new one.
create function public.qorpera_set_company_site_password(p_site_id uuid, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_site public.qorpera_company_sites%rowtype; v_password text;
begin
	v_site := public.qorpera_company_site_for_admin(p_site_id);
	v_password := coalesce(p_password, public.qorpera_site_new_password());
	if char_length(v_password) not between 10 and 128 or v_password ~ '[[:cntrl:]]' or btrim(v_password) = '' then
		raise exception 'A site password is 10 to 128 characters' using errcode = '22023'; end if;
	update public.qorpera_company_site_secrets set password = v_password, changed_at = clock_timestamp(),
		changed_by_user_id = auth.uid()
	where site_id = v_site.id;
	update public.qorpera_company_sites set password_version = password_version + 1, updated_at = clock_timestamp()
	where id = v_site.id;
	delete from public.qorpera_company_site_sessions where site_id = v_site.id;
	return public.qorpera_company_site_password(v_site.id);
end $$;

-- Takes a site offline at once: its files, password and sessions go. Answers whether it was still there.
create function public.qorpera_unpublish_company_site(p_site_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_profile uuid;
begin
	select site.profile_id into v_profile from public.qorpera_company_sites as site where site.id = p_site_id;
	if not found then
		return jsonb_build_object('schema', 'qorpera.company-site-unpublish/v1', 'siteId', p_site_id, 'removed', false); end if;
	perform public.qorpera_company_site_for_admin(p_site_id);
	delete from public.qorpera_company_sites where id = p_site_id;
	return jsonb_build_object('schema', 'qorpera.company-site-unpublish/v1', 'siteId', p_site_id, 'removed', true);
end $$;

revoke all on function public.qorpera_list_company_sites(uuid), public.qorpera_company_site_password(uuid),
	public.qorpera_set_company_site_password(uuid, text), public.qorpera_unpublish_company_site(uuid)
	from public, anon, service_role;
grant execute on function public.qorpera_list_company_sites(uuid), public.qorpera_company_site_password(uuid),
	public.qorpera_set_company_site_password(uuid, text), public.qorpera_unpublish_company_site(uuid)
	to authenticated;

-- 5. The edge function's calls -----------------------------------------------------------------------------------------

-- One file of a site for a visitor's session. Every answer that is not the site's (no live site with this slug, no
-- valid session for this token, publishing switched off, the company being deleted) is the same 'locked'. The content
-- is the bytes from p_offset, at most p_length of them (base64, no newlines): p_length 0 for none (a HEAD, a check),
-- and none either when p_etag is the file's sha256 (the visitor holds it).
create function public.qorpera_site_serve(p_slug text, p_path text, p_token text, p_etag text, p_offset integer,
	p_length integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930550000
declare v_site public.qorpera_company_sites%rowtype; v_path text; v_file record; v_offset integer; v_length integer;
begin
	if not coalesce((select settings.enabled from public.qorpera_site_settings as settings), false)
		or not public.qorpera_site_slug_valid(p_slug) or p_token is null or p_token !~ '^[A-Za-z0-9_-]{32}$' then
		return jsonb_build_object('state', 'locked'); end if;
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = p_slug and site.current_version_id is not null and not public.qorpera_company_deleting(site.profile_id);
	if not found or not exists (select 1 from public.qorpera_company_site_sessions as session
		where session.token_sha256 = public.qorpera_site_sha256(p_token) and session.site_id = v_site.id
			and session.password_version = v_site.password_version and session.expires_at > clock_timestamp()) then
		return jsonb_build_object('state', 'locked'); end if;
	v_path := coalesce(p_path, '');
	if v_path = '' or right(v_path, 1) = '/' then v_path := v_path || 'index.html'; end if;
	if not public.qorpera_site_path_valid(v_path) then return jsonb_build_object('state', 'missing'); end if;
	select file.path, file.content_type, file.bytes, file.sha256 into v_file from public.qorpera_company_site_files as file
	where file.version_id = v_site.current_version_id and file.path = v_path;
	if found then
		v_offset := least(greatest(coalesce(p_offset, 0), 0), v_file.bytes);
		v_length := least(greatest(coalesce(p_length, 0), 0), v_file.bytes - v_offset);
		return jsonb_build_object('state', 'file', 'path', v_file.path, 'contentType', v_file.content_type,
			'bytes', v_file.bytes, 'sha256', v_file.sha256, 'offset', v_offset,
			'content', case when p_etag is not distinct from v_file.sha256 or v_length = 0 then null
				else (select translate(encode(substring(file.content from v_offset + 1 for v_length), 'base64'), chr(10), '')
					from public.qorpera_company_site_files as file
					where file.version_id = v_site.current_version_id and file.path = v_path) end);
	end if;
	if exists (select 1 from public.qorpera_company_site_files as file
		where file.version_id = v_site.current_version_id and file.path = v_path || '/index.html') then
		return jsonb_build_object('state', 'directory', 'path', v_path || '/'); end if;
	return jsonb_build_object('state', 'missing');
end $$;

-- A visitor's network for the limits: an IPv4 address, or an IPv6 address's /64 (one home or phone has a whole /64);
-- anything else as given. Never stored: only its HMAC under qorpera_site_settings.client_key.
create function public.qorpera_site_client_network(p_client text) returns text language plpgsql immutable
set search_path = '' as $$
-- 20260930550000
declare v inet;
begin
	begin v := btrim(p_client)::inet;
	exception when others then return left(coalesce(p_client, ''), 128); end;
	return host(network(set_masklen(v, case when family(v) = 6 then 64 else 32 end)));
end $$;
revoke all on function public.qorpera_site_client_network(text) from public, anon, authenticated, service_role;

-- A visitor's password. Wrong ones are counted by an HMAC of the visitor's network (never the address): 10 per network
-- and slug and 30 per network across slugs per 15 minutes, and 300 per slug per hour, after which the slug answers
-- 'limited' to everyone but the sessions already open. Right: a new session for 7 days.
create function public.qorpera_site_unlock(p_slug text, p_password text, p_client text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930550000
declare
	v_now timestamptz := clock_timestamp(); v_client text; v_count integer; v_oldest timestamptz;
	v_site public.qorpera_company_sites%rowtype; v_secret public.qorpera_company_site_secrets%rowtype; v_token text;
	v_settings public.qorpera_site_settings%rowtype;
begin
	if p_slug is null or not public.qorpera_site_slug_valid(p_slug) or p_password is null or char_length(p_password) > 1024 then
		return jsonb_build_object('state', 'wrong'); end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings;
	v_client := encode(extensions.hmac(convert_to(public.qorpera_site_client_network(p_client), 'utf8'), v_settings.client_key,
		'sha256'), 'hex');
	delete from public.qorpera_site_unlock_failures as failure where failure.ctid = any (array(
		select old.ctid from public.qorpera_site_unlock_failures as old where old.failed_at < v_now - interval '1 hour' limit 500));
	select count(*), min(failure.failed_at) into v_count, v_oldest from public.qorpera_site_unlock_failures as failure
	where failure.slug = p_slug and failure.client_sha256 = v_client and failure.failed_at > v_now - interval '15 minutes';
	if v_count < 10 then
		select count(*), min(failure.failed_at) into v_count, v_oldest from public.qorpera_site_unlock_failures as failure
		where failure.client_sha256 = v_client and failure.failed_at > v_now - interval '15 minutes';
		if v_count < 30 then v_count := 0; end if;
	end if;
	if v_count > 0 then
		return jsonb_build_object('state', 'limited', 'retryAfter',
			greatest(1, ceil(extract(epoch from v_oldest + interval '15 minutes' - v_now)))::integer); end if;
	select count(*), min(failure.failed_at) into v_count, v_oldest from public.qorpera_site_unlock_failures as failure
	where failure.slug = p_slug and failure.failed_at > v_now - interval '1 hour';
	if v_count >= 300 then
		return jsonb_build_object('state', 'limited', 'retryAfter',
			greatest(1, ceil(extract(epoch from v_oldest + interval '1 hour' - v_now)))::integer); end if;
	if v_settings.enabled then
		select site.* into v_site from public.qorpera_company_sites as site
		where site.slug = p_slug and site.current_version_id is not null and not public.qorpera_company_deleting(site.profile_id);
		select secret.* into v_secret from public.qorpera_company_site_secrets as secret where secret.site_id = v_site.id;
	end if;
	-- Compared by digest, so the comparison's time says nothing about the password.
	if v_secret.site_id is not null
		and extensions.digest(convert_to(v_secret.password, 'utf8'), 'sha256') = extensions.digest(convert_to(p_password, 'utf8'), 'sha256') then
		delete from public.qorpera_company_site_sessions as session where session.site_id = v_site.id
			and (session.expires_at <= v_now or session.password_version <> v_site.password_version);
		-- At most 2000 open sessions a site: the oldest go first.
		delete from public.qorpera_company_site_sessions as session where session.token_sha256 in (
			select old.token_sha256 from public.qorpera_company_site_sessions as old where old.site_id = v_site.id
			order by old.created_at desc offset 1999);
		v_token := public.qorpera_site_new_token();
		insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at)
		values (public.qorpera_site_sha256(v_token), v_site.id, v_site.password_version, v_now + interval '7 days');
		return jsonb_build_object('state', 'open', 'token', v_token, 'maxAge', 604800);
	end if;
	insert into public.qorpera_site_unlock_failures (slug, client_sha256, failed_at) values (p_slug, v_client, v_now);
	return jsonb_build_object('state', 'wrong');
end $$;

revoke all on function public.qorpera_site_serve(text, text, text, text, integer, integer),
	public.qorpera_site_unlock(text, text, text) from public, anon, authenticated;
grant execute on function public.qorpera_site_serve(text, text, text, text, integer, integer),
	public.qorpera_site_unlock(text, text, text) to service_role;

-- 6. Observations ------------------------------------------------------------------------------------------------------

create function pg_temp.company_sites_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930550000' in v_definition) > 0 then
		raise exception '20260930550000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930550000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.company_sites_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930525000 */'company_edit','company_move',$old$,
	$new$/* 20260930525000 */'company_edit','company_move',/* 20260930550000 */'publish_site','unpublish_site',$new$);

drop function pg_temp.company_sites_replace(regprocedure, text, text);
