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
--    while it is shared (published_at) and its machine is there and not removed. Its source_path names the machine it
--    was shared from. An app site that is off holds its name for a day after its last change, as an unfinished files
--    site does; a shared one always holds it.
--    qorpera_company_site_app_claims: one-time claims of 15 minutes, each recording the share_app call that issued it.
--    The agent's command carries a claim; the program trades it for a connection key at once, so the command text
--    (which members see in the machine's list) holds nothing that still works.
-- 3. The agent's calls, through the native host with the run's binding (scope binding), as the publish calls:
--    qorpera_site_share_check (read only, before the automatic review: the slug and the machine, so a share that would
--    fail on its machine is refused before any card) and qorpera_site_share_app. A new app link (no
--    live one with this slug), and a live one shared from another machine, needs the automatic review's approval of
--    that share_app call for this slug in this run, exactly as qorpera_site_publish_begin's for a new site. Every share
--    issues a new claim and ends the site's older unused ones. qorpera_site_unpublish turns an app link off (not
--    shared, its key, claims and visitors' sessions gone; the site, its name and its password stay for the next
--    share); qorpera_site_publish_check refuses an app link's name, so a website never takes one over.
-- 4. The members' list adds each site's kind, its app's machine (the name, or null when the machine is gone) and port,
--    and the link per kind; an app link's state is 'live' or 'off'. A member's unpublish deletes an app site as it
--    does a files site (unchanged: the delete takes its key, claims and sessions with it).
-- 5. The relay's calls (service_role only): qorpera_site_app_connect (a claim, used once, for a new key, or the current
--    key) and qorpera_site_app_session (a visitor's session). qorpera_site_unlock unlocks a live app link as it does a
--    live files site; qorpera_site_serve never serves an app link (it answers as locked).
-- 6. Observations name share_app beside publish_site, as the runtime's closed vocabulary does.
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
		or to_regprocedure('public.qorpera_site_agent_run(jsonb,boolean)') is null then
		raise exception '20260930562000 (app links) needs company sites (20260930550000) and company machines'; end if;
	-- Each body this migration replaces is still the one company sites wrote.
	if exists (select 1 from unnest(array['public.qorpera_site_url(text)', 'public.qorpera_site_abandoned(public.qorpera_company_sites)',
		'public.qorpera_site_publish_check(jsonb,text)', 'public.qorpera_site_unpublish(jsonb,text)',
		'public.qorpera_list_company_sites(uuid)', 'public.qorpera_site_serve(text,text,text,text,integer,integer)',
		'public.qorpera_site_unlock(text,text,text)']) as fn(signature)
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
	-- sha256 of the link program's current connection key; null until a claim is used, and while the link is off.
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
	-- That call made the link live (it was not shared before).
	first_share boolean not null,
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	used_at timestamptz
);
create index qorpera_company_site_app_claims_site on public.qorpera_company_site_app_claims(site_id, created_at);
alter table public.qorpera_company_site_app_claims enable row level security;
revoke all on public.qorpera_company_site_app_claims from public, anon, authenticated, service_role;

-- Helpers (no API role calls them) ---------------------------------------------------------------------------------------

-- An app link that answers: shared, and its machine there and not removed (the switches are the callers').
create function public.qorpera_site_app_live(p_site public.qorpera_company_sites) returns boolean language sql stable
set search_path = '' as $$
	-- 20260930562000
	select coalesce(p_site.kind = 'app' and p_site.published_at is not null and p_site.machine_id is not null
		and exists (select 1 from public.qorpera_company_machines as machine
			where machine.id = p_site.machine_id and machine.removed_at is null), false)
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

-- 3. The agent's calls -------------------------------------------------------------------------------------------------

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

-- Before the automatic review (share_app's prepare), for a share of this slug from the company machine p_machine:
-- 'refused' when share_app would refuse the machine (none of that name, removed, or not always-on), so no owner
-- approves a card for a share that fails; else whether it makes a new app link ('new': none of this company is live
-- under the slug, so it needs approval), updates the company's live one ('update', with the machine and port it
-- forwards to now; it needs approval when p_machine is another machine), or cannot ('taken': another company's site,
-- or a website of this company). url is the app link the slug has, or would have. Reads only.
create function public.qorpera_site_share_check(p_binding jsonb, p_slug text, p_machine text)
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
			return jsonb_build_object('state', 'update', 'needsReview', v_site.machine_id is distinct from v_machine.id,
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
-- at once, and a new claim for the link program (the site's older unused claims end). The same call again (its run
-- and call id) answers the same site, as that call did, with a fresh claim.
create function public.qorpera_site_share_app(p_binding jsonb, p_call_id text, p_request jsonb, p_review_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930562000
declare
	v_run public.qorpera_execution_runs%rowtype; v_site public.qorpera_company_sites%rowtype;
	v_machine public.qorpera_company_machines%rowtype; v_settings public.qorpera_site_settings%rowtype;
	v_slug text; v_title text; v_port integer; v_new boolean; v_first boolean; v_claim text; v_host text;
	v_now timestamptz := clock_timestamp(); v_expires timestamptz;
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
	-- A new app link, or a live one shared from another machine, goes out only on the automatic review's approval of a
	-- built-in check of this agent's share_app with this slug, in this run: an owner's or admin's Allow on its card,
	-- which this run used, or the reviewer's allow of this very call under a company Allow rule. An approval never
	-- carries over to another run.
	if (v_new or v_site.machine_id is distinct from v_machine.id) and not exists (select 1 from public.qorpera_action_reviews as review
		where review.id = p_review_id and review.profile_id = v_run.profile_id and review.staff_agent_id = v_run.staff_agent_id
			and review.tool_name = 'share_app'
			and review.built_in in ('money', 'legal_terms', 'delete_outside', 'access_change')
			and ((review.answer in ('allow_once', 'always_allow') and review.consumed_run_id = v_run.id)
				or (review.decision = 'allow' and review.run_id = v_run.id and review.call_id = p_call_id))
			and public.qorpera_site_review_slug(review.action ->> 'arguments') = v_slug) then
		raise exception 'SITE_APPROVAL_REQUIRED: a new app link, or an app link from another machine, goes out only after an owner or admin approves it on a card'
			using errcode = '42501'; end if;
	perform public.qorpera_site_assert_resume_recorded(v_run.id, p_binding);
	if v_site.id is null then
		insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id,
			kind, machine_id, app_port, published_at, published_by_staff_agent_id)
		values (v_run.profile_id, v_run.environment_id, v_slug, v_title, v_machine.name, v_run.staff_agent_id,
			'app', v_machine.id, v_port, v_now, v_run.staff_agent_id)
		returning * into v_site;
		insert into public.qorpera_company_site_secrets (site_id, password) values (v_site.id, public.qorpera_site_new_password());
	else
		-- An update without a title keeps the site's. The program connected now keeps its key until the new claim is used.
		update public.qorpera_company_sites set title = coalesce(v_title, title), source_path = v_machine.name,
			machine_id = v_machine.id, app_port = v_port, published_at = v_now,
			published_by_staff_agent_id = v_run.staff_agent_id, updated_at = v_now
		where id = v_site.id returning * into v_site;
	end if;
	-- The same call again answers as it did.
	select claim.first_share into v_first from public.qorpera_company_site_app_claims as claim
	where claim.site_id = v_site.id and claim.run_id = v_run.id and claim.call_id = p_call_id
	order by claim.created_at limit 1;
	v_first := coalesce(v_first, v_new);
	-- One claim a site that works: the new one. Claims a day past their end go.
	delete from public.qorpera_company_site_app_claims as claim
	where claim.site_id = v_site.id and claim.expires_at < v_now - interval '1 day';
	update public.qorpera_company_site_app_claims set expires_at = v_now
	where site_id = v_site.id and used_at is null and expires_at > v_now;
	v_claim := public.qorpera_site_new_secret();
	v_expires := v_now + interval '15 minutes';
	insert into public.qorpera_company_site_app_claims (claim_sha256, site_id, run_id, call_id, first_share, expires_at)
	values (public.qorpera_site_sha256(v_claim), v_site.id, v_run.id, p_call_id, v_first, v_expires);
	v_host := v_slug || v_settings.app_host_suffix;
	return jsonb_build_object('slug', v_slug, 'url', 'https://' || v_host || '/', 'machine', v_machine.name, 'port', v_port,
		'firstShare', v_first, 'claim', v_claim, 'claimExpiresAt', v_expires,
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

revoke all on function public.qorpera_site_share_check(jsonb, text, text), public.qorpera_site_share_app(jsonb, text, jsonb, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_site_share_check(jsonb, text, text), public.qorpera_site_share_app(jsonb, text, jsonb, uuid)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_site_share_check', 'binding'), ('qorpera_site_share_app', 'binding');

-- 4. The members' calls --------------------------------------------------------------------------------------------------

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
		left join public.qorpera_profile_staff as staff on staff.profile_id = site.profile_id
			and staff.staff_agent_id = site.published_by_staff_agent_id
		where site.profile_id = p_profile_id), '[]'::jsonb);
end $$;

-- 5. The relays' calls -------------------------------------------------------------------------------------------------

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

-- A visitor's password. Wrong ones are counted by an HMAC of the visitor's network (never the address): 10 per network
-- and slug and 30 per network across slugs per 15 minutes, and 300 per slug per hour, after which the slug answers
-- 'limited' to everyone but the sessions already open. Right: a new session for 7 days.
create or replace function public.qorpera_site_unlock(p_slug text, p_password text, p_client text)
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
		-- 20260930562000: a files site with a live version, or a live app link while app links are switched on.
		select site.* into v_site from public.qorpera_company_sites as site
		where site.slug = p_slug and not public.qorpera_company_deleting(site.profile_id)
			and case when site.kind = 'app' then v_settings.apps_enabled and public.qorpera_site_app_live(site)
				else site.current_version_id is not null end;
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

-- The link program's connection: p_secret is an unused, unexpired claim of the slug's live app link (used now, for a
-- new key that replaces the old one, so only the newest program connects; the key is answered this once and only its
-- sha256 is kept) or the link's current key (key null). Anything else (an unknown slug, a link that is off or does not
-- answer, a switch off, the company being deleted, a wrong, used or expired secret) is the same 'refused'.
create function public.qorpera_site_app_connect(p_slug text, p_secret text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930562000
declare v_site public.qorpera_company_sites%rowtype; v_sha text; v_key text;
begin
	if not coalesce((select settings.enabled and settings.apps_enabled from public.qorpera_site_settings as settings), false)
		or not public.qorpera_site_slug_valid(p_slug) or p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{43}$' then
		return jsonb_build_object('state', 'refused'); end if;
	-- Locked, so a claim's key never lands on a link turned off meanwhile.
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = p_slug and site.kind = 'app' and not public.qorpera_company_deleting(site.profile_id) for update;
	if not found or not public.qorpera_site_app_live(v_site) then return jsonb_build_object('state', 'refused'); end if;
	v_sha := public.qorpera_site_sha256(p_secret);
	update public.qorpera_company_site_app_claims as claim set used_at = clock_timestamp()
	where claim.claim_sha256 = v_sha and claim.site_id = v_site.id and claim.used_at is null and claim.expires_at > clock_timestamp();
	if found then
		v_key := public.qorpera_site_new_secret();
		update public.qorpera_company_sites set app_key_sha256 = public.qorpera_site_sha256(v_key) where id = v_site.id;
		return jsonb_build_object('state', 'ok', 'key', v_key, 'port', v_site.app_port);
	end if;
	if v_site.app_key_sha256 = v_sha then
		return jsonb_build_object('state', 'ok', 'key', null, 'port', v_site.app_port); end if;
	return jsonb_build_object('state', 'refused');
end $$;

-- A visitor's session of an app link: 'open' for a live link's unexpired session of its current password, else
-- 'locked' (both switches on, the company not being deleted).
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
	return jsonb_build_object('state', 'open');
end $$;

revoke all on function public.qorpera_site_app_connect(text, text), public.qorpera_site_app_session(text, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_site_app_connect(text, text), public.qorpera_site_app_session(text, text)
	to service_role;

-- 6. Observations ------------------------------------------------------------------------------------------------------

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
