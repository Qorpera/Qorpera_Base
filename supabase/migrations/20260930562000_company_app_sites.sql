-- 20260930562000: private app links (deploy/sites/APP-PREVIEW.md §1; founder go, 3 November 2026: "Yes, build it"). An
-- agent shares one port of one of the company's always-on machines as https://<slug>-preview.qorpera.com/, behind the
-- site's password, as a static site is. An app link is a company site with kind 'app': the same slug space, password,
-- sessions, unlock limits, members' list, password change and unpublish. Only serving differs: the relay (app-relay)
-- forwards a visitor's requests to the link program the agent runs on that machine, which dials out to the relay.
--
-- 1. Settings: apps_enabled (the app links' own switch; both it and enabled must be on) and app_host_suffix
--    ('-preview.qorpera.com'). Off, every app link answers as locked and no agent shares one; nothing is deleted.
-- 2. qorpera_company_sites: kind ('files' or 'app'), machine_id (the company machine, set null when the machine row
--    goes), app_port, app_key_sha256 (the link program's current connection key). A files site has no machine, port or
--    key; an app site has a port and never a files version, and a key only while it is shared. An app site is live
--    while it is shared (published_at) and its machine is there (not removed, not being deleted: one rule, the one
--    share_app takes a machine by). Its source_path names the machine it was shared from. An app site that is off holds
--    its name for a day after its last change, as an unfinished files site does; a shared one always holds it.
--    qorpera_company_site_app_claims: claims of 15 minutes, each recording the share_app call that issued it. The
--    agent's command carries a claim; the program trades it for a connection key at once, so the command text (which
--    members see in the machine's list) holds nothing that works for long. A claim stays redeemable for 2 minutes after
--    its first use (an answer lost on the way still lets the program connect), by the program that first redeemed it
--    only (its per-process id, kept as a sha256); each redemption makes a new key in place of the last, so only the
--    newest program connects.
-- 3. The relay's own API role, qorpera_site_relay (PostgREST switches to it from authenticator, as to anon): it runs
--    the relay's three functions and no other function in public (every other one is revoked from PUBLIC), and reads
--    no table.
-- 4. The agent's calls, through the native host with the run's binding (scope binding), as the publish calls:
--    qorpera_site_share_check (read only, before the automatic review: the slug, the machine and the port, so a share
--    that would fail on its machine is refused before any card) and qorpera_site_share_app. A new app link (no live
--    one with this slug), and a live one shared from another machine or port (another port is another service), needs
--    the automatic review's approval of that share_app call for this slug in this run, exactly as
--    qorpera_site_publish_begin's for a new site. Such a move also ends the link's key, so the program connected now is
--    cut off; the new claim makes the next key. Every share issues a new claim and ends the site's older ones.
--    qorpera_site_unpublish turns an app link off (not shared, its key, claims and visitors' sessions gone; the site,
--    its name and its password stay for the next share); qorpera_site_publish_check and qorpera_site_publish_begin
--    refuse an app link's name, so a website never takes one over.
-- 5. The members' list adds each site's kind, its app's machine (the name, or null when the machine is gone) and port,
--    and the link per kind; an app link's state is 'live' or 'off'. A member's unpublish deletes an app site as it
--    does a files site (unchanged: the delete takes its key, claims and sessions with it).
-- 6. The relay's calls (service_role and qorpera_site_relay): qorpera_site_app_connect (a claim for a new key, or the
--    current key; with the site's id, which the relay keeps with the program so it forwards only to that site's),
--    qorpera_site_app_session (a visitor's session, with the site's id) and qorpera_site_app_unlock (the password of a
--    live app link, with qorpera_site_unlock's limits and failure rows). qorpera_site_unlock stays the files sites'
--    alone (unchanged) and qorpera_site_serve never serves an app link (it answers as locked).
-- 7. Observations name share_app beside publish_site, as the runtime's closed vocabulary does.
-- Every inserted text names this migration (20260930562000).
--
-- Locks: brief ACCESS EXCLUSIVE on qorpera_site_settings and qorpera_company_sites (new columns, no rewrite) and SHARE
-- ROW EXCLUSIVE on qorpera_company_machines (the new foreign key).

do $$
begin
	if to_regclass('public.qorpera_company_site_app_claims') is not null then
		raise exception '20260930562000 (app links) is already applied'; end if;
	if to_regclass('public.qorpera_company_sites') is null or to_regclass('public.qorpera_site_settings') is null
		or to_regclass('public.qorpera_company_machines') is null
		or to_regprocedure('public.qorpera_site_agent_run(jsonb,boolean)') is null
		or to_regprocedure('public.qorpera_site_unlock(text,text,text)') is null then
		raise exception '20260930562000 (app links) needs company sites (20260930550000) and company machines'; end if;
	-- Each body this migration replaces is still the one company sites wrote.
	if exists (select 1 from unnest(array['public.qorpera_site_url(text)', 'public.qorpera_site_abandoned(public.qorpera_company_sites)',
		'public.qorpera_site_publish_check(jsonb,text)', 'public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)',
		'public.qorpera_site_unpublish(jsonb,text)', 'public.qorpera_list_company_sites(uuid)',
		'public.qorpera_site_serve(text,text,text,text,integer,integer)']) as fn(signature)
		where to_regprocedure(fn.signature) is null
			or position('20260930550000' in pg_get_functiondef(to_regprocedure(fn.signature))) = 0
			or position('20260930562000' in pg_get_functiondef(to_regprocedure(fn.signature))) > 0) then
		raise exception '20260930562000 (app links): a company sites function differs from 20260930550000'; end if;
end $$;

set local lock_timeout = '3s';

-- 1. Settings ----------------------------------------------------------------------------------------------------------

alter table public.qorpera_site_settings
	add column apps_enabled boolean not null default false,
	-- An app link's host is <slug><suffix>, one name under the zone (Universal SSL covers one level).
	add column app_host_suffix text not null default '-preview.qorpera.com'
		check (app_host_suffix ~ '^-[a-z0-9-]{0,14}(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$');

-- 2. Tables ------------------------------------------------------------------------------------------------------------

alter table public.qorpera_company_sites
	add column kind text not null default 'files' check (kind in ('files', 'app')),
	-- The machine an app link forwards to; null once that machine's row is gone.
	add column machine_id uuid references public.qorpera_company_machines(id) on delete set null,
	add column app_port integer check (app_port between 1 and 65535),
	-- sha256 of the link program's current connection key; null until a claim is used, while the link is off, and after
	-- a share moved it to another machine or port.
	add column app_key_sha256 text check (app_key_sha256 ~ '^[0-9a-f]{64}$'),
	add constraint qorpera_company_sites_kind_shape check (case kind
		when 'files' then machine_id is null and app_port is null and app_key_sha256 is null
		else app_port is not null and current_version_id is null and (published_at is not null or app_key_sha256 is null) end);
create index qorpera_company_sites_machine on public.qorpera_company_sites(machine_id) where machine_id is not null;

create table public.qorpera_company_site_app_claims (
	claim_sha256 text primary key check (claim_sha256 ~ '^[0-9a-f]{64}$'),
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	-- The share_app call that issued it: the same call again answers as that call did.
	run_id uuid not null,
	call_id text not null check (char_length(call_id) between 1 and 200 and call_id !~ '[[:cntrl:]]'),
	-- That call made the link live (it was not shared before), and made the site and its password.
	first_share boolean not null,
	new_password boolean not null,
	created_at timestamptz not null default clock_timestamp(),
	-- Redeemable until then: 15 minutes from the share, 2 minutes from the first use, now when a newer share ends it.
	expires_at timestamptz not null,
	used_at timestamptz,
	-- sha256 of the per-process id of the program that first redeemed it: only that program redeems it again.
	program_sha256 text check (program_sha256 ~ '^[0-9a-f]{64}$'),
	check ((used_at is null) = (program_sha256 is null))
);
create index qorpera_company_site_app_claims_site on public.qorpera_company_site_app_claims(site_id, created_at);
alter table public.qorpera_company_site_app_claims enable row level security;
revoke all on public.qorpera_company_site_app_claims from public, anon, authenticated, service_role;

-- 3. The relay's role --------------------------------------------------------------------------------------------------

-- The relay faces the internet, so its key (a JWT whose role is qorpera_site_relay) opens only its own calls: no login,
-- no table, EXECUTE on the three functions granted below. PostgREST switches to it from authenticator.
do $$
begin
	if not exists (select 1 from pg_roles where rolname = 'qorpera_site_relay') then
		create role qorpera_site_relay nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
	end if;
	if exists (select 1 from pg_roles where rolname = 'qorpera_site_relay'
		and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
		raise exception 'The site relay role has unsafe attributes'; end if;
	if exists (select 1 from pg_roles where rolname = 'authenticator') then
		grant qorpera_site_relay to authenticator; end if;
end $$;
grant usage on schema public to qorpera_site_relay;

-- Helpers (no API role calls them) ---------------------------------------------------------------------------------------

-- An app link that answers: shared, and its machine there (not removed, not being deleted: the rule share_app takes a
-- machine by). The switches are the callers'.
create function public.qorpera_site_app_live(p_site public.qorpera_company_sites) returns boolean language sql stable
set search_path = '' as $$
	-- 20260930562000
	select coalesce(p_site.kind = 'app' and p_site.published_at is not null and p_site.machine_id is not null
		and exists (select 1 from public.qorpera_company_machines as machine
			where machine.id = p_site.machine_id and machine.removed_at is null and machine.desired_state <> 'deleted'), false)
$$;

-- A claim or a connection key: 32 random bytes in base64url, 43 characters.
create function public.qorpera_site_new_secret() returns text language sql volatile set search_path = '' as $$
	-- 20260930562000
	select translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_')
$$;

revoke all on function public.qorpera_site_app_live(public.qorpera_company_sites), public.qorpera_site_new_secret()
	from public, anon, authenticated, service_role;

create or replace function public.qorpera_site_url(p_slug text) returns text language sql stable security definer set search_path = '' as $$
	-- 20260930550000
	-- 20260930562000: an app link's own host.
	select case when exists (select 1 from public.qorpera_company_sites as site where site.slug = p_slug and site.kind = 'app')
		then 'https://' || p_slug || settings.app_host_suffix || '/'
		else settings.origin || '/' || p_slug || '/' end
	from public.qorpera_site_settings as settings
$$;

-- A site whose first upload never finished, or an app link that is off, a day after its last change: another company
-- may take its slug.
create or replace function public.qorpera_site_abandoned(p_site public.qorpera_company_sites) returns boolean language sql stable
set search_path = '' as $$
	-- 20260930550000
	-- 20260930562000: an app link is never live by a version; it holds its name while it is shared.
	select case when p_site.kind = 'app' then p_site.published_at is null else p_site.current_version_id is null end
		and p_site.updated_at < clock_timestamp() - interval '1 day'
$$;

-- 4. The agent's calls -------------------------------------------------------------------------------------------------

-- Before the automatic review (the tool's prepare): whether publishing this slug makes a new site or updates a live
-- one of this company. Reads only.
create or replace function public.qorpera_site_publish_check(p_binding jsonb, p_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_run public.qorpera_execution_runs%rowtype; v_site public.qorpera_company_sites%rowtype;
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	if not public.qorpera_site_slug_valid(p_slug) then
		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.slug = p_slug;
	-- 20260930562000: an app link of the company keeps its name; a website never takes it over.
	if found and v_site.profile_id = v_run.profile_id and v_site.kind = 'app' then
		raise exception 'SITE_NAME_TAKEN: an app link of the company has this name; choose another' using errcode = '55000'; end if;
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
create or replace function public.qorpera_site_publish_begin(p_binding jsonb, p_call_id text, p_request jsonb, p_review_id uuid)
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
	-- 20260930562000: an app link of the company keeps its name; a website never takes it over.
	if v_site.kind = 'app' then
		raise exception 'SITE_NAME_TAKEN: an app link of the company has this name; choose another' using errcode = '55000'; end if;
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

-- Before the automatic review (share_app's prepare), for a share of this slug from the company machine p_machine's port
-- p_port: 'refused' when share_app would refuse the machine (none of that name, removed or being deleted, or not
-- always-on), so no owner approves a card for a share that fails; else whether it makes a new app link ('new': none of
-- this company is live under the slug, so it needs approval), updates the company's live one ('update', with the
-- machine and port it forwards to now; it needs approval when p_machine or p_port is another), or cannot ('taken':
-- another company's site, or a website of this company). url is the app link the slug has, or would have. Reads only.
create function public.qorpera_site_share_check(p_binding jsonb, p_slug text, p_machine text, p_port integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930562000
declare
	v_run public.qorpera_execution_runs%rowtype; v_site public.qorpera_company_sites%rowtype;
	v_machine public.qorpera_company_machines%rowtype; v_url text;
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	if not coalesce((select settings.apps_enabled from public.qorpera_site_settings as settings), false) then
		raise exception 'Sharing app links is not switched on yet' using errcode = '0A000'; end if;
	if not public.qorpera_site_slug_valid(p_slug) then
		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;
	if p_port is null or p_port not between 1 and 65535 then
		raise exception 'Site share request is invalid' using errcode = '22023'; end if;
	-- The machine as share_app takes it.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.profile_id = v_run.profile_id and machine.name = p_machine and machine.removed_at is null
		and machine.desired_state <> 'deleted';
	if not found then
		return jsonb_build_object('state', 'refused', 'reason', 'APP_MACHINE_NOT_FOUND', 'needsReview', false); end if;
	if v_machine.lifetime <> 'always-on' then
		return jsonb_build_object('state', 'refused', 'reason', 'APP_MACHINE_NOT_ALWAYS_ON', 'needsReview', false); end if;
	v_url := (select 'https://' || p_slug || settings.app_host_suffix || '/' from public.qorpera_site_settings as settings);
	select site.* into v_site from public.qorpera_company_sites as site where site.slug = p_slug;
	if found and v_site.profile_id = v_run.profile_id then
		if v_site.kind <> 'app' then return jsonb_build_object('state', 'taken', 'needsReview', false, 'url', v_url); end if;
		if public.qorpera_site_app_live(v_site) then
			return jsonb_build_object('state', 'update',
				'needsReview', v_site.machine_id is distinct from v_machine.id or v_site.app_port is distinct from p_port,
				'url', v_url, 'port', v_site.app_port,
				'machine', (select machine.name from public.qorpera_company_machines as machine where machine.id = v_site.machine_id));
		end if;
		return jsonb_build_object('state', 'new', 'needsReview', true, 'url', v_url);
	end if;
	if found and not public.qorpera_site_abandoned(v_site) then
		return jsonb_build_object('state', 'taken', 'needsReview', false, 'url', v_url); end if;
	if (select count(*) from public.qorpera_company_sites as site where site.profile_id = v_run.profile_id) >= 10 then
		raise exception 'SITE_LIMIT: the company has 10 sites, as many as it can have; update or unpublish one first'
			using errcode = '55000'; end if;
	return jsonb_build_object('state', 'new', 'needsReview', true, 'url', v_url);
end $$;

-- Shares one port of one of the company's always-on machines as an app link: the site (new: with its password), shared
-- at once, and a new claim for the link program (the site's older claims end). The same call again (its run and call
-- id) answers the same site, as that call did, with a fresh claim.
create function public.qorpera_site_share_app(p_binding jsonb, p_call_id text, p_request jsonb, p_review_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930562000
declare
	v_run public.qorpera_execution_runs%rowtype; v_site public.qorpera_company_sites%rowtype;
	v_machine public.qorpera_company_machines%rowtype; v_settings public.qorpera_site_settings%rowtype;
	v_slug text; v_title text; v_port integer; v_new boolean; v_first boolean; v_created boolean := false;
	v_new_password boolean; v_claim text; v_host text; v_now timestamptz := clock_timestamp(); v_expires timestamptz;
begin
	v_run := public.qorpera_site_agent_run(p_binding);
	select settings.* into v_settings from public.qorpera_site_settings as settings;
	if not coalesce(v_settings.apps_enabled, false) then
		raise exception 'Sharing app links is not switched on yet' using errcode = '0A000'; end if;
	if p_call_id is null or char_length(p_call_id) not between 1 and 200 or p_call_id ~ '[[:cntrl:]]'
		or jsonb_typeof(p_request) is distinct from 'object'
		or not (p_request ?& array['slug', 'machine', 'port'])
		or p_request - array['slug', 'title', 'machine', 'port'] <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'slug') is distinct from 'string'
		or jsonb_typeof(p_request -> 'machine') is distinct from 'string'
		or jsonb_typeof(p_request -> 'port') is distinct from 'number'
		or coalesce(jsonb_typeof(p_request -> 'title'), 'string') not in ('string', 'null')
		or (p_request ->> 'port') !~ '^[0-9]{1,5}$' then
		raise exception 'Site share request is invalid' using errcode = '22023'; end if;
	v_slug := p_request ->> 'slug';
	v_port := (p_request ->> 'port')::integer;
	if v_port not between 1 and 65535 then raise exception 'Site share request is invalid' using errcode = '22023'; end if;
	if not public.qorpera_site_slug_valid(v_slug) then
		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;
	v_title := nullif(btrim(p_request ->> 'title'), '');
	if v_title is not null and (char_length(v_title) > 120 or v_title ~ '[[:cntrl:]]') then
		raise exception 'Site share request is invalid' using errcode = '22023'; end if;
	-- The company's machine of that name, there and staying: an always-on one, since a task machine sleeps when its task
	-- is done and its link would stop.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.profile_id = v_run.profile_id and machine.name = p_request ->> 'machine' and machine.removed_at is null
		and machine.desired_state <> 'deleted';
	if not found then
		raise exception 'APP_MACHINE_NOT_FOUND: the company has no machine of that name; start an always-on one with machine_start'
			using errcode = '22023'; end if;
	if v_machine.lifetime <> 'always-on' then
		raise exception 'APP_MACHINE_NOT_ALWAYS_ON: a task machine sleeps when its task is done, so its link would stop; share from an always-on machine'
			using errcode = '55000'; end if;

	-- The site, locked for the rest of the share.
	select site.* into v_site from public.qorpera_company_sites as site where site.slug = v_slug for update;
	if found and v_site.profile_id <> v_run.profile_id then
		if not public.qorpera_site_abandoned(v_site) then
			raise exception 'SITE_NAME_TAKEN: another site already has this name; choose another' using errcode = '55000'; end if;
		delete from public.qorpera_company_sites where id = v_site.id;
		v_site := null;
	end if;
	if v_site.id is not null and v_site.kind <> 'app' then
		raise exception 'SITE_NAME_TAKEN: a website of the company has this name; choose another name for the app link'
			using errcode = '55000'; end if;
	v_new := v_site.id is null or not public.qorpera_site_app_live(v_site);
	if v_site.id is null and (select count(*) from public.qorpera_company_sites as site where site.profile_id = v_run.profile_id) >= 10 then
		raise exception 'SITE_LIMIT: the company has 10 sites, as many as it can have; update or unpublish one first'
			using errcode = '55000'; end if;
	-- A new app link, or a live one shared from another machine or port (another service), goes out only on the
	-- automatic review's approval of a built-in check of this agent's share_app with this slug, in this run: an owner's
	-- or admin's Allow on its card, which this run used, or the reviewer's allow of this very call under a company Allow
	-- rule. An approval never carries over to another run.
	if (v_new or v_site.machine_id is distinct from v_machine.id or v_site.app_port is distinct from v_port)
		and not exists (select 1 from public.qorpera_action_reviews as review
		where review.id = p_review_id and review.profile_id = v_run.profile_id and review.staff_agent_id = v_run.staff_agent_id
			and review.tool_name = 'share_app'
			and review.built_in in ('money', 'legal_terms', 'delete_outside', 'access_change')
			and ((review.answer in ('allow_once', 'always_allow') and review.consumed_run_id = v_run.id)
				or (review.decision = 'allow' and review.run_id = v_run.id and review.call_id = p_call_id))
			and public.qorpera_site_review_slug(review.action ->> 'arguments') = v_slug) then
		raise exception 'SITE_APPROVAL_REQUIRED: a new app link, or an app link from another machine or port, goes out only after an owner or admin approves it on a card'
			using errcode = '42501'; end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	if v_site.id is null then
		insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id,
			kind, machine_id, app_port, published_at, published_by_staff_agent_id)
		values (v_run.profile_id, v_run.environment_id, v_slug, v_title, v_machine.name, v_run.staff_agent_id,
			'app', v_machine.id, v_port, v_now, v_run.staff_agent_id)
		returning * into v_site;
		insert into public.qorpera_company_site_secrets (site_id, password) values (v_site.id, public.qorpera_site_new_password());
		v_created := true;
	else
		-- An update without a title keeps the site's. The same machine and port: the program connected now keeps its key
		-- until the new claim is used. Another machine or port: its key ends now, so the old program is cut off.
		update public.qorpera_company_sites set title = coalesce(v_title, title), source_path = v_machine.name,
			app_key_sha256 = case when machine_id is not distinct from v_machine.id and app_port is not distinct from v_port
				then app_key_sha256 end,
			machine_id = v_machine.id, app_port = v_port, published_at = v_now,
			published_by_staff_agent_id = v_run.staff_agent_id, updated_at = v_now
		where id = v_site.id returning * into v_site;
	end if;
	-- The same call again answers as it did.
	select claim.first_share, claim.new_password into v_first, v_new_password from public.qorpera_company_site_app_claims as claim
	where claim.site_id = v_site.id and claim.run_id = v_run.id and claim.call_id = p_call_id
	order by claim.created_at limit 1;
	v_first := coalesce(v_first, v_new);
	v_new_password := coalesce(v_new_password, v_created);
	-- One claim a site that works: the new one. Claims a day past their end go.
	delete from public.qorpera_company_site_app_claims as claim
	where claim.site_id = v_site.id and claim.expires_at < v_now - interval '1 day';
	update public.qorpera_company_site_app_claims set expires_at = v_now where site_id = v_site.id and expires_at > v_now;
	v_claim := public.qorpera_site_new_secret();
	v_expires := v_now + interval '15 minutes';
	insert into public.qorpera_company_site_app_claims (claim_sha256, site_id, run_id, call_id, first_share, new_password, expires_at)
	values (public.qorpera_site_sha256(v_claim), v_site.id, v_run.id, p_call_id, v_first, v_new_password, v_expires);
	v_host := v_slug || v_settings.app_host_suffix;
	return jsonb_build_object('slug', v_slug, 'url', 'https://' || v_host || '/', 'machine', v_machine.name, 'port', v_port,
		'firstShare', v_first, 'newPassword', v_new_password, 'claim', v_claim, 'claimExpiresAt', v_expires,
		'clientUrl', 'https://' || v_host || '/.qorpera/client.mjs', 'connectUrl', 'wss://' || v_host || '/.qorpera/connect');
end $$;

-- Takes one of the company's sites offline: its files, password and sessions go. Allowed with publishing switched
-- off.
create or replace function public.qorpera_site_unpublish(p_binding jsonb, p_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930550000
declare v_run public.qorpera_execution_runs%rowtype; v_removed boolean; v_site public.qorpera_company_sites%rowtype;
begin
	v_run := public.qorpera_site_agent_run(p_binding, true);
	if not public.qorpera_site_slug_valid(p_slug) then
		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens' using errcode = '22023'; end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	-- 20260930562000: an app link goes off: its key, claims and visitors' sessions go; the site, its name and password
	-- stay for the next share. Answers whether it was shared.
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = p_slug and site.profile_id = v_run.profile_id and site.kind = 'app' for update;
	if found then
		if v_site.published_at is not null then
			update public.qorpera_company_sites set published_at = null, published_by_staff_agent_id = null, app_key_sha256 = null,
				updated_at = clock_timestamp()
			where id = v_site.id;
		end if;
		delete from public.qorpera_company_site_app_claims where site_id = v_site.id;
		delete from public.qorpera_company_site_sessions where site_id = v_site.id;
		return jsonb_build_object('schema', 'qorpera.site-unpublish/v1', 'slug', p_slug, 'removed', v_site.published_at is not null);
	end if;
	with removed as (delete from public.qorpera_company_sites as site where site.slug = p_slug and site.profile_id = v_run.profile_id
		returning 1)
	select exists (select 1 from removed) into v_removed;
	return jsonb_build_object('schema', 'qorpera.site-unpublish/v1', 'slug', p_slug, 'removed', v_removed);
end $$;

revoke all on function public.qorpera_site_share_check(jsonb, text, text, integer), public.qorpera_site_share_app(jsonb, text, jsonb, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_site_share_check(jsonb, text, text, integer), public.qorpera_site_share_app(jsonb, text, jsonb, uuid)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_site_share_check', 'binding'), ('qorpera_site_share_app', 'binding');

-- 5. The members' calls --------------------------------------------------------------------------------------------------

create or replace function public.qorpera_list_company_sites(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930550000
begin
	if auth.uid() is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only the company''s members see its sites' using errcode = '42501'; end if;
	-- 20260930562000: each site's kind, an app link's machine (its name, or null when it is gone) and port, the link per
	-- kind, and an app link's state: 'live' while it answers, else 'off'.
	return coalesce((select jsonb_agg(jsonb_build_object('schema', 'qorpera.company-site/v1', 'id', site.id, 'slug', site.slug,
		'title', site.title, 'url', public.qorpera_site_url(site.slug),
		'state', case when site.kind = 'app' then case when public.qorpera_site_app_live(site) then 'live' else 'off' end
			when site.current_version_id is null then 'publishing' else 'live' end,
		'kind', site.kind, 'machine', machine.name, 'port', site.app_port,
		'source', site.source_path, 'files', coalesce(version.file_count, 0), 'bytes', coalesce(version.total_bytes, 0),
		'publishedAt', site.published_at,
		'publishedBy', case when staff.staff_agent_id is not null then jsonb_build_object('agentId', staff.staff_agent_id,
			'name', staff.display_name) end,
		'createdAt', site.created_at, 'passwordChangedAt', secret.changed_at)
		order by coalesce(site.published_at, site.created_at) desc, site.slug collate "C")
		from public.qorpera_company_sites as site
		join public.qorpera_company_site_secrets as secret on secret.site_id = site.id
		left join public.qorpera_company_site_versions as version on version.id = site.current_version_id
		left join public.qorpera_company_machines as machine on machine.id = site.machine_id and machine.removed_at is null
			and machine.desired_state <> 'deleted'
		left join public.qorpera_profile_staff as staff on staff.profile_id = site.profile_id
			and staff.staff_agent_id = site.published_by_staff_agent_id
		where site.profile_id = p_profile_id), '[]'::jsonb);
end $$;

-- 6. The relays' calls -------------------------------------------------------------------------------------------------

-- One file of a site for a visitor's session. Every answer that is not the site's (no live site with this slug, no
-- valid session for this token, publishing switched off, the company being deleted) is the same 'locked'. The content
-- is the bytes from p_offset, at most p_length of them (base64, no newlines): p_length 0 for none (a HEAD, a check),
-- and none either when p_etag is the file's sha256 (the visitor holds it).
create or replace function public.qorpera_site_serve(p_slug text, p_path text, p_token text, p_etag text, p_offset integer,
	p_length integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930550000
declare v_site public.qorpera_company_sites%rowtype; v_path text; v_file record; v_offset integer; v_length integer;
begin
	if not coalesce((select settings.enabled from public.qorpera_site_settings as settings), false)
		or not public.qorpera_site_slug_valid(p_slug) or p_token is null or p_token !~ '^[A-Za-z0-9_-]{32}$' then
		return jsonb_build_object('state', 'locked'); end if;
	-- 20260930562000: never an app link (the relay serves it): it answers as locked.
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = p_slug and site.kind = 'files' and site.current_version_id is not null
		and not public.qorpera_company_deleting(site.profile_id);
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

-- A visitor's password for an app link, as qorpera_site_unlock takes a website's (which never opens an app link): the
-- same limits on the same failure rows (wrong ones by an HMAC of the visitor's network: 10 per network and slug and 30
-- per network across slugs per 15 minutes, 300 per slug per hour), and a new session for 7 days when it is right and
-- the link is live with both switches on.
create function public.qorpera_site_app_unlock(p_slug text, p_password text, p_client text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930562000
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
	if v_settings.enabled and v_settings.apps_enabled then
		select site.* into v_site from public.qorpera_company_sites as site
		where site.slug = p_slug and site.kind = 'app' and not public.qorpera_company_deleting(site.profile_id)
			and public.qorpera_site_app_live(site);
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

-- The link program's connection, with the site's id (the relay forwards a visitor only to a program of the site the
-- visitor's session is of). p_program is the program's per-process id (43 characters of base64url; anything else is
-- refused). p_secret is the link's current key (key null; read only; any well-formed p_program), or a claim of the
-- slug's live app link redeemable now: the site locked, a new key replaces the last, so only the newest program
-- connects; the key is answered this once and only its sha256 is kept. The first redemption binds the claim to
-- p_program: in its 2 minutes more only that program redeems it again, so a claim read off the machine by anyone else
-- takes nothing over. Anything else (an unknown slug, a link that is off or does not answer, a switch off, the company
-- being deleted, a wrong or ended secret, a claim another program redeemed) is the same 'refused'.
create function public.qorpera_site_app_connect(p_slug text, p_secret text, p_program text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930562000
declare v_site public.qorpera_company_sites%rowtype; v_sha text; v_program text; v_key text;
begin
	if not coalesce((select settings.enabled and settings.apps_enabled from public.qorpera_site_settings as settings), false)
		or not public.qorpera_site_slug_valid(p_slug) or p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{43}$'
		or p_program is null or p_program !~ '^[A-Za-z0-9_-]{43}$' then
		return jsonb_build_object('state', 'refused'); end if;
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = p_slug and site.kind = 'app' and not public.qorpera_company_deleting(site.profile_id);
	if not found or not public.qorpera_site_app_live(v_site) then return jsonb_build_object('state', 'refused'); end if;
	v_sha := public.qorpera_site_sha256(p_secret);
	if v_site.app_key_sha256 = v_sha then
		return jsonb_build_object('state', 'ok', 'key', null, 'port', v_site.app_port, 'siteId', v_site.id::text); end if;
	v_program := public.qorpera_site_sha256(p_program);
	if not exists (select 1 from public.qorpera_company_site_app_claims as claim
		where claim.claim_sha256 = v_sha and claim.site_id = v_site.id and claim.expires_at > clock_timestamp()
			and (claim.program_sha256 is null or claim.program_sha256 = v_program)) then
		return jsonb_build_object('state', 'refused'); end if;
	-- A claim: locked, so a key never lands on a link turned off or moved meanwhile.
	select site.* into v_site from public.qorpera_company_sites as site
	where site.id = v_site.id and not public.qorpera_company_deleting(site.profile_id) for update;
	if not found or not public.qorpera_site_app_live(v_site) then return jsonb_build_object('state', 'refused'); end if;
	-- Its first use binds it to this program and leaves it 2 minutes more, for an answer lost on the way; later uses (by
	-- that program only) keep that end.
	update public.qorpera_company_site_app_claims as claim set used_at = coalesce(claim.used_at, clock_timestamp()),
		program_sha256 = coalesce(claim.program_sha256, v_program),
		expires_at = case when claim.used_at is null then clock_timestamp() + interval '2 minutes' else claim.expires_at end
	where claim.claim_sha256 = v_sha and claim.site_id = v_site.id and claim.expires_at > clock_timestamp()
		and (claim.program_sha256 is null or claim.program_sha256 = v_program);
	if not found then return jsonb_build_object('state', 'refused'); end if;
	v_key := public.qorpera_site_new_secret();
	update public.qorpera_company_sites set app_key_sha256 = public.qorpera_site_sha256(v_key) where id = v_site.id;
	return jsonb_build_object('state', 'ok', 'key', v_key, 'port', v_site.app_port, 'siteId', v_site.id::text);
end $$;

-- A visitor's session of an app link: 'open', with the site's id, for a live link's unexpired session of its current
-- password, else 'locked' (both switches on, the company not being deleted).
create function public.qorpera_site_app_session(p_slug text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930562000
declare v_site public.qorpera_company_sites%rowtype;
begin
	if not coalesce((select settings.enabled and settings.apps_enabled from public.qorpera_site_settings as settings), false)
		or not public.qorpera_site_slug_valid(p_slug) or p_token is null or p_token !~ '^[A-Za-z0-9_-]{32}$' then
		return jsonb_build_object('state', 'locked'); end if;
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = p_slug and site.kind = 'app' and not public.qorpera_company_deleting(site.profile_id);
	if not found or not public.qorpera_site_app_live(v_site) or not exists (select 1 from public.qorpera_company_site_sessions as session
		where session.token_sha256 = public.qorpera_site_sha256(p_token) and session.site_id = v_site.id
			and session.password_version = v_site.password_version and session.expires_at > clock_timestamp()) then
		return jsonb_build_object('state', 'locked'); end if;
	return jsonb_build_object('state', 'open', 'siteId', v_site.id::text);
end $$;

revoke all on function public.qorpera_site_app_unlock(text, text, text), public.qorpera_site_app_connect(text, text, text),
	public.qorpera_site_app_session(text, text) from public, anon, authenticated;
grant execute on function public.qorpera_site_app_unlock(text, text, text), public.qorpera_site_app_connect(text, text, text),
	public.qorpera_site_app_session(text, text) to service_role, qorpera_site_relay;

-- 7. Observations ------------------------------------------------------------------------------------------------------

create function pg_temp.company_app_sites_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930562000' in v_definition) > 0 then
		raise exception '20260930562000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930562000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.company_app_sites_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930550000 */'publish_site','unpublish_site',$old$,
	$new$/* 20260930550000 */'publish_site','unpublish_site',/* 20260930562000 */'share_app',$new$);

drop function pg_temp.company_app_sites_replace(regprocedure, text, text);
