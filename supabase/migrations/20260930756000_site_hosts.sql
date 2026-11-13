-- 20260930756000: every company website gets an address of its own (own code storage, step 5, release 5.1; 13 Nov 2026,
-- founder: "Use qorpera.com"). A files site's own host is https://<slug>.qorpera.com/, served at the top; the look at a
-- version before it is live (Look first) is https://<slug>--next.qorpera.com/, opened by an owner's or admin's one-time
-- ticket; an operator takes a site down; an operator's drill makes one landing's checks fail, or one landing's site be
-- refused, once. Inert until the operator turns hosts on (lanes/own-code-storage/STEP5-BUILD.md, the order in the cut):
--     update public.qorpera_site_settings set hosts_domain = 'qorpera.com';   -- first; hosts are still off
--     update public.qorpera_site_settings set hosts_enabled = true;          -- only after every gate of the cut
-- and back: update public.qorpera_site_settings set hosts_enabled = false;
-- With hosts off and no takedown or drill set, every existing call answers as before, but for the name rule (3), which
-- holds from this migration on (production's one slug passes it).
--
-- 1. Settings: hosts_domain (the domain own hosts live under, one level: <slug>.<domain>) and hosts_enabled (off), which
--    needs the domain. Hosts are on when enabled and hosts_enabled both are (qorpera_site_hosts_on).
-- 2. Tables and columns:
--    * qorpera_company_sites: taken_down_at and taken_down_reason, an operator's takedown (both or neither).
--    * qorpera_company_site_sessions: scope, 'site' (a visitor's, after the password: every row so far) or 'next' (a
--      member's look at one version, version_id, after a ticket).
--    * qorpera_company_site_tickets: Look first's one-time tickets, kept by sha256, for 2 minutes.
--    * qorpera_code_repositories: drill ('check' or 'site'), drill_set_at and drill_taken_at: an operator's drill, which
--      the checks switch takes once.
-- 3. The name rule (D20), in qorpera_site_slug_valid: a-z, 0-9 and -, 3 to 48, a letter or digit at both ends, no two
--    hyphens in a row, not ending -preview, never holding qorpera, and none of qorpera_site_reserved_names (one text,
--    which the coding executor's RESERVED copies byte for byte). Every stored slug must pass it, or this migration
--    fails. qorpera_code_site_slugs takes qorpera out of a repository's name and makes a run of hyphens one.
--    A site host (qorpera_site_host): the host, lower-cased, ends .<hosts_domain>; the one label before it is the slug,
--    or, when it ends --next, the slug with that ending taken off (a next host); the slug matches ^[a-z0-9]+(-[a-z0-9]+)*$,
--    is 3 to 48 long and passes the name rule. As one regex: ^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.com$
--    (qorpera_site_host_pattern), the length checked apart.
-- 4. site-serve's calls (service role only): qorpera_site_serve_host (the old host's legacy or moved, a site's own host
--    and its next host, gone for a site taken down), qorpera_site_unlock_host (an own host's password) and
--    qorpera_site_enter (a next host's ticket for a session of 12 hours).
-- 5. The members' calls: qorpera_open_site_preview (owners and admins: a ticket for the ready version What's new shows)
--    and qorpera_company_site_access (any member: whether hosts are on, and each site by its name, whether Qorpera took
--    it down and why).
-- 6. The operator's calls (no API role may call them, the service role neither), run as the database owner:
--      select public.qorpera_site_take_down('<slug>', '<reason, one line>');  select public.qorpera_site_restore('<slug>');
--      select public.qorpera_code_set_drill('<environment id>', '<owner>', '<name>', 'check' | 'site' | null);
--    A takedown and a restore enter the site's company first, as every writer for a company does (folder fence, then
--    company row, KEY SHARE: qorpera_site_enter_company), so a company's deletion either sees a takedown and waits, or
--    holds the company and the takedown waits for it.
-- 7. Twenty-four existing functions change, each by anchors on its definition as the migrations before this one leave it (an
--    anchor that is not found exactly once fails the migration); each changed body carries the marker 20260930756000 and
--    keeps every marker it had:
--    * qorpera_site_slug_valid: the name rule (3);
--    * qorpera_site_url: a files site's own host while hosts are on;
--    * qorpera_site_serve and qorpera_site_unlock (the old host's): never a site taken down; the old serve reads a
--      visitor's session only, and the old unlock's cap of 2000 sessions counts visitors' only;
--    * qorpera_site_app_live: an app link taken down answers as off;
--    * qorpera_code_site_slugs: the derived names (3);
--    * qorpera_code_checks_switch: rootLinks while hosts are on, and an operator's drill, taken once;
--    * qorpera_code_release_index: preparing, while hosts are on; for a site taken down, no live version, no link,
--      nothing being prepared, and takenDown with the reason;
--    * qorpera_list_code_releases: preview, while hosts are on;
--    * qorpera_put_code_release_live and qorpera_code_release_back: refused (SITE_TAKEN_DOWN) for a site taken down;
--    * an agent's calls, publish_site's (qorpera_site_publish_check, _begin, _put, _finish), share_app's
--      (qorpera_site_share_check, qorpera_site_share_app) and unpublish_site's (qorpera_site_unpublish): a name that
--      breaks the rule is refused with the rule in one sentence (qorpera_site_name_words); a site of the company that
--      Qorpera took down takes nothing, refused SITE_TAKEN_DOWN with the reason in plain words and no address
--      (qorpera_site_taken_down_words), writing nothing;
--    * a repository's site's upload pass (qorpera_code_sites_due, qorpera_code_site_begin): never a site taken down;
--    * a takedown sticks until qorpera_site_restore: unpublish_site (above), a member's take offline
--      (qorpera_unpublish_company_site) and a company's deletion (qorpera_delete_hosted_profile) refuse while a site is
--      taken down, a deletion asked before waits (qorpera_finish_company_deletion's holdings: taken_down_sites), and
--      such a site is never abandoned (qorpera_site_abandoned), so its name is never free. A trigger on
--      qorpera_company_sites refuses deleting or renaming such a row whatever the way but a company's purge. Each call
--      decides on the site's row as it holds it locked (or reads it again after its lock), so a takedown on its way is
--      waited for, then read.
--    The operator's takedown and restore write a repository's list file again (its index_version).
--
-- Locks, by the first statements and in this order (the order the executor's site calls take rows in), each waiting 3 s
-- at most and held to the end of the transaction the file runs in: ACCESS EXCLUSIVE on qorpera_code_repositories, then
-- qorpera_company_sites, then qorpera_company_site_sessions (new columns with no rewrite, and their checks, which scan
-- the table) with SHARE ROW EXCLUSIVE on qorpera_company_site_versions (the new foreign keys to it), the new tickets
-- table (SHARE ROW EXCLUSIVE again on qorpera_company_sites and qorpera_company_site_versions), then ACCESS EXCLUSIVE on
-- qorpera_site_settings. No row is rewritten; each table is scanned once to check its new constraints.

do $$
begin
	if to_regclass('public.qorpera_company_site_tickets') is not null then
		raise exception '20260930756000 (site hosts) is already applied'; end if;
	if to_regclass('public.qorpera_code_releases') is null
		or to_regprocedure('public.qorpera_site_app_live(public.qorpera_company_sites)') is null
		or to_regprocedure('public.qorpera_code_checks_switch(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_site_new_secret()') is null then
		raise exception '20260930756000 (site hosts) needs company sites, app links, code checks and code releases (20260930550000, 20260930562000, 20260930721000, 20260930729000)'; end if;
end $$;

set local lock_timeout = '3s';

-- 1. Tables, columns and settings (in the order of the locks) --------------------------------------------------------

alter table public.qorpera_code_repositories
	-- An operator's drill (step 5; qorpera_code_set_drill), taken once by the checks switch: check, one check of the next
	-- landing fails on purpose; site, the next landing's site is refused on purpose. Null: none waits.
	add column drill text check (drill is null or drill in ('check', 'site')),
	add column drill_set_at timestamptz,
	add column drill_taken_at timestamptz;

alter table public.qorpera_company_sites
	-- An operator took the site down (qorpera_site_take_down): every host of it answers gone, nothing goes live on it, and
	-- members see the reason. Both null while it is up.
	add column taken_down_at timestamptz,
	add column taken_down_reason text check (taken_down_reason is null
		or (char_length(taken_down_reason) between 1 and 300 and taken_down_reason !~ '[[:cntrl:]]')),
	add constraint qorpera_company_sites_taken_down check ((taken_down_at is null) = (taken_down_reason is null));

alter table public.qorpera_company_site_sessions
	-- site: a visitor's, after the password. next: a member's look at one version before it is live (Look first), after
	-- a ticket; it serves that version, on the site's next host only.
	add column scope text not null default 'site' check (scope in ('site', 'next')),
	add column version_id uuid references public.qorpera_company_site_versions(id) on delete cascade,
	add constraint qorpera_company_site_sessions_scope check ((scope = 'next') = (version_id is not null));
create index qorpera_company_site_sessions_version on public.qorpera_company_site_sessions(version_id)
	where version_id is not null;

create table public.qorpera_company_site_tickets (
	ticket_sha256 text primary key check (ticket_sha256 ~ '^[0-9a-f]{64}$'),
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	-- The version the ticket's session shows: the ready point's What's new drew.
	version_id uuid not null references public.qorpera_company_site_versions(id) on delete cascade,
	-- A plain value, no foreign key: the owner or admin who asked.
	user_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	check (expires_at > created_at)
);
create index qorpera_company_site_tickets_site on public.qorpera_company_site_tickets(site_id, expires_at);
create index qorpera_company_site_tickets_version on public.qorpera_company_site_tickets(version_id);
alter table public.qorpera_company_site_tickets enable row level security;
revoke all on public.qorpera_company_site_tickets from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_company_site_tickets is
	'20260930756000: Look first''s one-time tickets: an owner or admin opens a ready version on the site''s next host '
	'within 2 minutes, once (qorpera_open_site_preview, qorpera_site_enter). Kept by sha256. Its functions write it.';

alter table public.qorpera_site_settings
	-- The domain a files site's own host is under, <slug>.<hosts_domain>, and its next host <slug>--next.<hosts_domain>:
	-- one level, which the platform's certificate covers. Set before hosts_enabled.
	add column hosts_domain text check (hosts_domain is null or (char_length(hosts_domain) <= 190
		and hosts_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')),
	-- Own hosts on: links name them, the old host's links move there, Look first opens.
	add column hosts_enabled boolean not null default false,
	add constraint qorpera_site_settings_hosts check (not hosts_enabled or hosts_domain is not null);

-- Helpers (no API role calls them) ---------------------------------------------------------------------------------------

-- The names a site never takes: the platform's own names under qorpera.com, today's and the ones planned (D20). One
-- text, words split by one space; the coding executor's RESERVED copies it byte for byte. A new platform name under
-- qorpera.com is added here by a migration, after production is read for a site of that name, before its DNS record,
-- tunnel hostname or envoy host is made.
create function public.qorpera_site_reserved_names() returns text language sql immutable set search_path = '' as $$
	-- 20260930756000
	select 'api app www admin assets static qorpera login signin signup robots favicon sites site well-known help support status mail functions auth rest storage realtime objects inbox send screens edge coding noreply staging dev test preview next docs blog news account accounts billing pay payments checkout secure security sso id oauth my dashboard console portal cdn media files download downloads smtp imap pop mx autoconfig autodiscover abuse postmaster hostmaster webmaster ns1 ns2 vpn git code data db ws live screen desktop computer health metrics tunnel gateway relay hooks webhooks events invite invites join team teams company companies members cofounder agent agents chat email webmail calendar ftp m mobile wiki shop store home root system internal private public demo beta'::text
$$;

-- Whether sites have hosts of their own: sites on and hosts on.
create function public.qorpera_site_hosts_on() returns boolean language sql stable set search_path = '' as $$
	-- 20260930756000
	select coalesce((select settings.enabled and settings.hosts_enabled from public.qorpera_site_settings as settings), false)
$$;

-- The site hosts under p_domain as one regex: group 1 the slug, group 2 '--next' on a next host. The slug's length (3 to
-- 48) and the name rule are checked apart (qorpera_site_host). Group 1 never holds two hyphens in a row, so it never
-- takes --next in.
create function public.qorpera_site_host_pattern(p_domain text) returns text language sql immutable set search_path = '' as $$
	-- 20260930756000
	select '^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.' || replace(p_domain, '.', '\.') || '$'
$$;

-- What a host is, given lower-case: {"slug","scope":"site"} for a site's own host <slug>.<hosts_domain>,
-- {"slug","scope":"next"} for its next host <slug>--next.<hosts_domain>; null for any other host, while no domain is set,
-- and for a slug that is not 3 to 48 long or breaks the name rule. Reads no site.
create function public.qorpera_site_host(p_host text) returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930756000
declare v_domain text := (select settings.hosts_domain from public.qorpera_site_settings as settings); v_label text;
	v_next boolean;
begin
	if v_domain is null or p_host is null or right(p_host, char_length(v_domain) + 1) <> ('.' || v_domain) then
		return null; end if;
	-- The one label before the domain; a trailing --next makes it a next host.
	v_label := left(p_host, -(char_length(v_domain) + 1));
	v_next := right(v_label, 6) = '--next';
	if v_next then v_label := left(v_label, -6); end if;
	if v_label !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_label) not between 3 and 48
		or not public.qorpera_site_slug_valid(v_label) then
		return null; end if;
	return jsonb_build_object('slug', v_label, 'scope', case when v_next then 'next' else 'site' end);
end $$;

-- What an agent reads when a site's name breaks the rule, in one sentence: every SITE_NAME_INVALID refusal of
-- publish_site, share_app and unpublish_site below, and, byte for byte, the coding executor's words for a checks file's
-- site.name (CODE_SITE_NAME_RULE) and the runtime's for a slug of the wrong shape (SITE_NAME_RULE); a test of each
-- compares its text with this one.
create function public.qorpera_site_name_words() returns text language sql immutable set search_path = '' as $$
	-- 20260930756000
	select 'A site''s name is 3 to 48 characters of a to z, 0 to 9 and single hyphens, starts and ends with a letter or digit, does not end in -preview, does not contain qorpera, and is not a reserved name (such as app, api, mail, shop, login).'::text
$$;

-- What an agent reads when it would publish to, share, or upload to a site Qorpera took down: a refusal in plain words
-- it can pass on, with the operator's reason (characters the runtime relays as they are, any other one a ?), and no
-- address.
create function public.qorpera_site_taken_down_words(p_reason text) returns text language sql immutable set search_path = '' as $$
	-- 20260930756000
	select 'SITE_TAKEN_DOWN: This site was taken down by Qorpera ('
		|| regexp_replace(coalesce(p_reason, ''), '[^ -~À-ÿ]', '?', 'g')
		|| ') and cannot be published until Qorpera restores it. Tell a member of the company.'
$$;

-- The operator's reason when the site p_site_id is taken down (qorpera_site_take_down); null while it is up, or for no
-- site.
create function public.qorpera_site_down_reason(p_site_id uuid) returns text language sql stable set search_path = '' as $$
	-- 20260930756000
	select site.taken_down_reason from public.qorpera_company_sites as site
	where site.id = p_site_id and site.taken_down_at is not null
$$;

revoke all on function public.qorpera_site_reserved_names(), public.qorpera_site_hosts_on(),
	public.qorpera_site_host_pattern(text), public.qorpera_site_host(text), public.qorpera_site_name_words(),
	public.qorpera_site_taken_down_words(text), public.qorpera_site_down_reason(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. Existing functions ------------------------------------------------------------------------------------------------

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.site_hosts_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930756000' in v_definition) > 0 then
		raise exception '20260930756000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930756000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- The name rule.
select pg_temp.site_hosts_patch('public.qorpera_site_slug_valid(text)'::regprocedure, array[
	$old$ and p_slug not in ('api', 'app', 'www', 'admin',
		'assets', 'static', 'qorpera', 'login', 'signin', 'signup', 'robots', 'favicon', 'sites', 'site', 'well-known',
		'help', 'support', 'status', 'mail', 'functions', 'auth', 'rest', 'storage', 'realtime'), false)$old$,
	$new$
		-- 20260930756000: a site's own host is <slug>.qorpera.com, beside the platform's own names (D20): no two hyphens in a
		-- row (so neither <slug>--next nor an xn-- name is ever a slug), not ending -preview (an app link's host), never
		-- holding qorpera, and none of the reserved names (one text: qorpera_site_reserved_names).
		and strpos(p_slug, '--') = 0 and right(p_slug, 8) <> '-preview' and strpos(p_slug, 'qorpera') = 0
		and p_slug <> all (string_to_array(public.qorpera_site_reserved_names(), ' ')), false)$new$]);

-- Every site's name passes the rule, or nothing of this migration holds.
do $$
declare v_broken text[];
begin
	select array_agg(site.slug order by site.slug collate "C") into v_broken from public.qorpera_company_sites as site
	where not public.qorpera_site_slug_valid(site.slug);
	if v_broken is not null then
		raise exception '20260930756000: these sites'' names break the name rule (qorpera_site_slug_valid): %',
			array_to_string(v_broken, ', '); end if;
end $$;

-- A repository's site's names: no qorpera, and a run of hyphens is one.
select pg_temp.site_hosts_patch('public.qorpera_code_site_slugs(text,text)'::regprocedure, array[
	$old$			from (select coalesce(nullif(btrim(left(lower(translate(p_name, '_.', '--')), 48), '-'), ''), 'project') as name) base$old$,
	$new$			-- 20260930756000: the name rule (qorpera_site_slug_valid) refuses qorpera and two hyphens in a row: the
			-- repository's name has each qorpera made a hyphen, then each run of hyphens made one.
			from (select coalesce(nullif(btrim(left(regexp_replace(replace(lower(translate(p_name, '_.', '--')), 'qorpera', '-'),
				'-{2,}', '-', 'g'), 48), '-'), ''), 'project') as name) base$new$]);

-- A files site's link names its own host while hosts are on.
select pg_temp.site_hosts_patch('public.qorpera_site_url(text)'::regprocedure, array[
	$old$		else settings.origin || '/' || p_slug || '/' end$old$,
	$new$		-- 20260930756000: a website's own host, while hosts are on (qorpera_site_hosts_on).
		when settings.enabled and settings.hosts_enabled then 'https://' || p_slug || '.' || settings.hosts_domain || '/'
		else settings.origin || '/' || p_slug || '/' end$new$]);

-- The old host's file: never a site taken down, and a visitor's session only.
select pg_temp.site_hosts_patch('public.qorpera_site_serve(text,text,text,text,integer,integer)'::regprocedure, array[
	$old$	where site.slug = p_slug and site.kind = 'files' and site.current_version_id is not null$old$,
	$new$	where site.slug = p_slug and site.kind = 'files' and site.current_version_id is not null
		-- 20260930756000: a site Qorpera took down answers as locked here (gone on the new hosts).
		and site.taken_down_at is null$new$,
	$old$			and session.password_version = v_site.password_version and session.expires_at > clock_timestamp()) then$old$,
	$new$			and session.password_version = v_site.password_version and session.expires_at > clock_timestamp()
			-- 20260930756000: a visitor's session, never a member's look at a next version.
			and session.scope = 'site') then$new$]);

-- The old host's password: never for a site taken down; the cap counts visitors' sessions only.
select pg_temp.site_hosts_patch('public.qorpera_site_unlock(text,text,text)'::regprocedure, array[
	$old$		where site.slug = p_slug and site.current_version_id is not null and not public.qorpera_company_deleting(site.profile_id);$old$,
	$new$		where site.slug = p_slug and site.current_version_id is not null and not public.qorpera_company_deleting(site.profile_id)
			-- 20260930756000: never a site Qorpera took down.
			and site.taken_down_at is null;$new$,
	$old$			select old.token_sha256 from public.qorpera_company_site_sessions as old where old.site_id = v_site.id$old$,
	$new$			select old.token_sha256 from public.qorpera_company_site_sessions as old where old.site_id = v_site.id
				-- 20260930756000: visitors' sessions; members' looks at a next version keep their own cap of 20.
				and old.scope = 'site'$new$]);

-- An app link taken down answers as off: no visitor's session, no password, no program.
select pg_temp.site_hosts_patch('public.qorpera_site_app_live(public.qorpera_company_sites)'::regprocedure, array[
	$old$	select coalesce(p_site.kind = 'app' and p_site.published_at is not null and p_site.machine_id is not null$old$,
	$new$	select coalesce(p_site.kind = 'app' and p_site.published_at is not null and p_site.machine_id is not null
		-- 20260930756000: never a link Qorpera took down (qorpera_site_take_down).
		and p_site.taken_down_at is null$new$]);

-- The switch says, while hosts are on, that links from / are a site's own; and it hands an operator's drill over once.
select pg_temp.site_hosts_patch('public.qorpera_code_checks_switch(uuid,uuid)'::regprocedure, array[
	$old$declare v_session public.qorpera_coding_sessions%rowtype;$old$,
	$new$declare v_session public.qorpera_coding_sessions%rowtype;
	-- 20260930756000: the answer, and the drill it takes.
	v_answer jsonb; v_drill text;$new$,
	$old$	return jsonb_build_object('schema', 'qorpera.code-checks-switch/v1', 'enabled', coalesce((select repository.checks_enabled$old$,
	$new$	v_answer := jsonb_build_object('schema', 'qorpera.code-checks-switch/v1', 'enabled', coalesce((select repository.checks_enabled$new$,
	$old$				and repository.name = v_session.repository ->> 'name'), true));$old$,
	$new$				and repository.name = v_session.repository ->> 'name'), true));
	-- 20260930756000: while sites have hosts of their own (qorpera_site_hosts_on), a site is served at the top of its own
	-- host, so links from / are its own: rootLinks, true, only then.
	if public.qorpera_site_hosts_on() then v_answer := v_answer || '{"rootLinks":true}'::jsonb; end if;
	-- An operator's drill (qorpera_code_set_drill), taken by this answer alone: a check drill while the checks run, a site
	-- drill while the site is kept. The registry row is locked and written only when such a drill waits.
	select repository.drill into v_drill from public.qorpera_code_repositories repository
	where repository.environment_id = v_session.environment_id and repository.owner = v_session.repository ->> 'owner'
		and repository.name = v_session.repository ->> 'name'
		and ((repository.drill = 'check' and repository.checks_enabled) or (repository.drill = 'site' and repository.site_enabled))
	for update;
	if v_drill is not null then
		update public.qorpera_code_repositories repository set drill = null, drill_taken_at = clock_timestamp()
		where repository.environment_id = v_session.environment_id and repository.owner = v_session.repository ->> 'owner'
			and repository.name = v_session.repository ->> 'name';
		v_answer := v_answer || jsonb_build_object('drill', v_drill);
	end if;
	return v_answer;$new$]);

-- The list file says, while hosts are on, what is being prepared for What's new; and, for a site Qorpera took down,
-- that it is (no live version, no link, nothing being prepared).
select pg_temp.site_hosts_patch('public.qorpera_code_release_index(public.qorpera_code_repositories)'::regprocedure, array[
	$old$	return jsonb_build_object('live', case when v_live.n is not null then jsonb_build_object('version', v_live.version,$old$,
	$new$	-- 20260930756000: a site Qorpera took down has nothing live and no link (takenDown below says why).
	return jsonb_build_object('live', case when v_live.n is not null
			and public.qorpera_site_down_reason(p_repository.site_id) is null then jsonb_build_object('version', v_live.version,$new$,
	$old$		'ready', case when v_point is not null then jsonb_build_object('change', v_point -> 'change') end);$old$,
	$new$		'ready', case when v_point is not null then jsonb_build_object('change', v_point -> 'change') end)
		-- 20260930756000: while hosts are on (qorpera_site_hosts_on), what is being prepared for What's new: the change due
		-- now (the due list's point) while its version is not ready yet, the repository's sites are on, the upload pass
		-- has not given it up and Qorpera did not take the site down; else null.
		|| case when public.qorpera_site_hosts_on() then jsonb_build_object('preparing', (select case
				when due.point is not null and due.point ->> 'versionId' is null and p_repository.site_enabled
					and not public.qorpera_code_site_given_up(p_repository, due.point)
					and public.qorpera_site_down_reason(p_repository.site_id) is null
				then jsonb_build_object('change', due.point -> 'change') end
			from (select public.qorpera_code_release_point(p_repository, null, false) as point) due))
			else '{}'::jsonb end
		-- 20260930756000: a site Qorpera took down, hosts on or off: {"reason"}, the operator's.
		|| case when public.qorpera_site_down_reason(p_repository.site_id) is not null
			then jsonb_build_object('takenDown', jsonb_build_object('reason', public.qorpera_site_down_reason(p_repository.site_id)))
			else '{}'::jsonb end;$new$]);

-- What's new says, while hosts are on, whether the caller may look at a ready version first.
select pg_temp.site_hosts_patch('public.qorpera_list_code_releases(uuid)'::regprocedure, array[
	$old$'canRelease', v_role in ('owner','admin'),
		'sites', v_sites);$old$,
	$new$'canRelease', v_role in ('owner','admin'),
		'sites', v_sites)
		-- 20260930756000: while hosts are on (qorpera_site_hosts_on), whether the caller may open Look first
		-- (qorpera_open_site_preview): owners and admins.
		|| case when public.qorpera_site_hosts_on() then jsonb_build_object('preview', v_role in ('owner','admin'))
			else '{}'::jsonb end;$new$]);

-- Nothing goes live on a site taken down, nor back.
select pg_temp.site_hosts_patch('public.qorpera_put_code_release_live(uuid,text,text,jsonb)'::regprocedure, array[
	$old$	select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;$old$,
	$new$	select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	-- 20260930756000: Qorpera took the site down (qorpera_site_take_down): nothing goes live until it is restored.
	if v_site.taken_down_at is not null then
		return '{"schema":"qorpera.code-release/v1","state":"refused","code":"SITE_TAKEN_DOWN"}'::jsonb; end if;$new$]);
select pg_temp.site_hosts_patch('public.qorpera_code_release_back(uuid,text,text,jsonb)'::regprocedure, array[
	$old$	select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;$old$,
	$new$	select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	-- 20260930756000: Qorpera took the site down (qorpera_site_take_down): nothing goes live until it is restored.
	if v_site.taken_down_at is not null then
		return '{"schema":"qorpera.code-release/v1","state":"refused","code":"SITE_TAKEN_DOWN"}'::jsonb; end if;$new$]);

-- The agents' calls (the cross-check of 13 Nov 2026, the lead's calls on its seams 2 and 7): a refused name says the
-- rule in one sentence; a site Qorpera took down takes nothing from an agent (publish_site's check, begin, put and
-- finish, share_app's check and share, a repository's site's upload pass), and the refusal says why in plain words,
-- with no address. Nothing is written by a refused call.
select pg_temp.site_hosts_patch('public.qorpera_site_publish_check(jsonb,text)'::regprocedure, array[
	$old$		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;$old$,
	$new$		-- 20260930756000: the rule in one sentence (qorpera_site_name_words), as the executor and the runtime say it.
		raise exception '%', 'SITE_NAME_INVALID: ' || public.qorpera_site_name_words() using errcode = '22023'; end if;$new$,
	$old$	-- 20260930562000: an app link of the company keeps its name; a website never takes it over.$old$,
	$new$	-- 20260930756000: a site of the company that Qorpera took down takes nothing until Qorpera restores it.
	if found and v_site.profile_id = v_run.profile_id and v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;
	-- 20260930562000: an app link of the company keeps its name; a website never takes it over.$new$]);
select pg_temp.site_hosts_patch('public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)'::regprocedure, array[
	$old$		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;$old$,
	$new$		-- 20260930756000: the rule in one sentence (qorpera_site_name_words), as the executor and the runtime say it.
		raise exception '%', 'SITE_NAME_INVALID: ' || public.qorpera_site_name_words() using errcode = '22023'; end if;
	-- 20260930756000: a site of the company that Qorpera took down takes nothing until Qorpera restores it, not even the
	-- same call again (read here, and again under the site's lock below).
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = v_slug and site.profile_id = v_run.profile_id and site.taken_down_at is not null;
	if found then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;
	v_site := null;$new$,
	$old$	if v_site.kind = 'app' then$old$,
	$new$	-- 20260930756000: taken down meanwhile (under the lock): nothing is written.
	if v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;
	if v_site.kind = 'app' then$new$]);
select pg_temp.site_hosts_patch('public.qorpera_site_publish_put(jsonb,uuid,jsonb)'::regprocedure, array[
	$old$	v_run := public.qorpera_site_agent_run(p_binding);
	select version.* into v_version from public.qorpera_company_site_versions as version$old$,
	$new$	v_run := public.qorpera_site_agent_run(p_binding);
	-- 20260930756000: the upload's site first, shared (begin and finish take a site before its version), so a takedown on
	-- its way is waited for, and read below before any byte is kept (the review of #1774, F2).
	perform 1 from public.qorpera_company_sites as site
	join public.qorpera_company_site_versions as version on version.site_id = site.id
	where version.id = p_version_id and version.run_id = v_run.id and site.profile_id = v_run.profile_id
	for share of site;
	select version.* into v_version from public.qorpera_company_site_versions as version$new$,
	$old$	if v_version.state = 'live' then return public.qorpera_site_publish_receipt(v_site, v_version); end if;$old$,
	$new$	-- 20260930756000: taken down while the upload was on its way: nothing more of it is kept.
	if v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;
	if v_version.state = 'live' then return public.qorpera_site_publish_receipt(v_site, v_version); end if;$new$]);
select pg_temp.site_hosts_patch('public.qorpera_site_publish_finish(jsonb,uuid)'::regprocedure, array[
	$old$	if v_version.state = 'live' then
		return public.qorpera_site_publish_receipt(v_site, v_version);
	end if;$old$,
	$new$	-- 20260930756000: taken down while the upload was on its way: it never goes live, and no link is given.
	if v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;
	if v_version.state = 'live' then
		return public.qorpera_site_publish_receipt(v_site, v_version);
	end if;$new$]);
select pg_temp.site_hosts_patch('public.qorpera_site_share_check(jsonb,text,text,integer)'::regprocedure, array[
	$old$		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;$old$,
	$new$		-- 20260930756000: the rule in one sentence (qorpera_site_name_words), as the executor and the runtime say it.
		raise exception '%', 'SITE_NAME_INVALID: ' || public.qorpera_site_name_words() using errcode = '22023'; end if;$new$,
	$old$	if found and v_site.profile_id = v_run.profile_id then
		if v_site.kind <> 'app' then return$old$,
	$new$	-- 20260930756000: a site of the company that Qorpera took down takes nothing until Qorpera restores it.
	if found and v_site.profile_id = v_run.profile_id and v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;
	if found and v_site.profile_id = v_run.profile_id then
		if v_site.kind <> 'app' then return$new$]);
select pg_temp.site_hosts_patch('public.qorpera_site_share_app(jsonb,text,jsonb,uuid)'::regprocedure, array[
	$old$		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not a reserved word'
			using errcode = '22023'; end if;$old$,
	$new$		-- 20260930756000: the rule in one sentence (qorpera_site_name_words), as the executor and the runtime say it.
		raise exception '%', 'SITE_NAME_INVALID: ' || public.qorpera_site_name_words() using errcode = '22023'; end if;$new$,
	$old$	if v_site.id is not null and v_site.kind <> 'app' then$old$,
	$new$	-- 20260930756000: a site of the company that Qorpera took down (under the lock): nothing is written.
	if v_site.id is not null and v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;
	if v_site.id is not null and v_site.kind <> 'app' then$new$]);
select pg_temp.site_hosts_patch('public.qorpera_site_unpublish(jsonb,text)'::regprocedure, array[
	$old$		raise exception 'SITE_NAME_INVALID: a site name is 3 to 48 lowercase letters, digits and hyphens' using errcode = '22023'; end if;$old$,
	$new$		-- 20260930756000: the rule in one sentence (qorpera_site_name_words), as every other refusal of a name says it.
		raise exception '%', 'SITE_NAME_INVALID: ' || public.qorpera_site_name_words() using errcode = '22023'; end if;
	-- 20260930756000: a site of the company that Qorpera took down stays as it is, its name with it, until Qorpera
	-- restores it: no agent takes it offline. Read locked (the review of #1774, F2): a takedown on its way is waited
	-- for and then read, and every write below is on the row as it is then.
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = p_slug and site.profile_id = v_run.profile_id for update;
	if found and v_site.taken_down_at is not null then
		raise exception '%', public.qorpera_site_taken_down_words(v_site.taken_down_reason) using errcode = '55000'; end if;$new$]);
-- A takedown sticks until Qorpera restores the site (the lead's call, 13 Nov 2026): no member takes it offline or deletes
-- its company, and its name is never free for another site (it is never abandoned). The trigger below holds the same for
-- every other way a row could go.
select pg_temp.site_hosts_patch('public.qorpera_unpublish_company_site(uuid)'::regprocedure, array[
	$old$	perform public.qorpera_company_site_for_admin(p_site_id);$old$,
	$new$	perform public.qorpera_company_site_for_admin(p_site_id);
	-- 20260930756000: a site Qorpera took down stays as it is, its name with it, until Qorpera restores it.
	if exists (select 1 from public.qorpera_company_sites as site where site.id = p_site_id and site.taken_down_at is not null) then
		raise exception 'Qorpera took this site down, so it stays as it is until Qorpera restores it. If you think this is wrong, tell us with Feedback in your menu.'
			using errcode = '55000'; end if;$new$]);
select pg_temp.site_hosts_patch('public.qorpera_delete_hosted_profile(uuid)'::regprocedure, array[
	$old$	if exists (select 1 from public.qorpera_profile_members as other
		where other.profile_id = p_profile_id and other.user_id <> v_actor_id) then$old$,
	$new$	-- 20260930756000: a company with a site Qorpera took down stays until Qorpera restores the site, its name with it.
	-- Its sites read locked (the review of #1774, F2): a takedown on its way is waited for, then read; one that comes
	-- after waits for this request, and the finisher then waits for it.
	perform 1 from public.qorpera_company_sites as site where site.profile_id = p_profile_id for share;
	if exists (select 1 from public.qorpera_company_sites as site where site.profile_id = p_profile_id
		and site.taken_down_at is not null) then
		raise exception 'Qorpera took one of this company''s sites down, so the company can''t be deleted until Qorpera restores the site. If you think this is wrong, tell us with Feedback in your menu.'
			using errcode = '55000'; end if;
	if exists (select 1 from public.qorpera_profile_members as other
		where other.profile_id = p_profile_id and other.user_id <> v_actor_id) then$new$]);
select pg_temp.site_hosts_patch('public.qorpera_finish_company_deletion(uuid)'::regprocedure, array[
	$old$			v_holdings := public.qorpera_company_node_holdings(p_profile_id);$old$,
	$new$			v_holdings := public.qorpera_company_node_holdings(p_profile_id);
			-- 20260930756000: a site Qorpera took down keeps the deletion waiting until Qorpera restores it (its name with it).
			v_holdings := v_holdings || jsonb_build_object('taken_down_sites', (select count(*)
				from public.qorpera_company_sites as site where site.profile_id = p_profile_id and site.taken_down_at is not null));$new$,
	$old$			or (v_holdings ->> 'chatgpt_plan_logins')::bigint > 0) then$old$,
	$new$			or (v_holdings ->> 'chatgpt_plan_logins')::bigint > 0
			or (v_holdings ->> 'taken_down_sites')::bigint > 0) then$new$]);
select pg_temp.site_hosts_patch('public.qorpera_site_abandoned(public.qorpera_company_sites)'::regprocedure, array[
	$old$	select p_site.code_owner is null$old$,
	$new$	-- 20260930756000: a site Qorpera took down keeps its name until Qorpera restores it.
	select p_site.code_owner is null and p_site.taken_down_at is null$new$]);
select pg_temp.site_hosts_patch('public.qorpera_code_sites_due(text,text,integer)'::regprocedure, array[
	$old$			or public.qorpera_code_site_given_up(v_repository, v_point);$old$,
	$new$			or public.qorpera_code_site_given_up(v_repository, v_point)
			-- 20260930756000: never a site Qorpera took down: nothing is uploaded to it until it is restored.
			or public.qorpera_site_down_reason(v_repository.site_id) is not null;$new$]);
select pg_temp.site_hosts_patch('public.qorpera_code_site_begin(text,text,uuid,text,text,integer,jsonb)'::regprocedure, array[
	$old$		select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	end if;$old$,
	$new$		select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	end if;
	-- 20260930756000: a site Qorpera took down takes no upload until it is restored (the due list leaves it out; this is
	-- for an upload that was due before): nothing is written.
	if v_site.taken_down_at is not null then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_TAKEN_DOWN'); end if;$new$]);

drop function pg_temp.site_hosts_patch(regprocedure, text[]);

-- A takedown sticks: a site Qorpera took down keeps its row and its name until qorpera_site_restore, whatever would
-- delete it (an agent's or a member's call, a takeover of an abandoned name, a cascade) or rename it. Only a company's
-- purge passes, as through every delete guard (qorpera_company_purge_active); and a company with a site taken down never
-- reaches its purge (qorpera_finish_company_deletion keeps the deletion waiting). An operator who must remove such a site
-- for good restores it and deletes it in one transaction (SITE-HOSTS.md).
create function public.qorpera_site_takedown_sticks() returns trigger language plpgsql security definer
set search_path = '' as $$
-- 20260930756000
begin
	if tg_op = 'DELETE' and public.qorpera_company_purge_active() then return old; end if;
	raise exception '%', public.qorpera_site_taken_down_words(old.taken_down_reason) using errcode = '55000';
end $$;
revoke all on function public.qorpera_site_takedown_sticks() from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_company_sites_takedown_sticks before delete on public.qorpera_company_sites
	for each row when (old.taken_down_at is not null) execute function public.qorpera_site_takedown_sticks();
create trigger qorpera_company_sites_takedown_keeps_name before update of slug on public.qorpera_company_sites
	for each row when (old.taken_down_at is not null and new.slug is distinct from old.slug)
	execute function public.qorpera_site_takedown_sticks();

-- 3. site-serve's calls ------------------------------------------------------------------------------------------------

-- What site-serve answers on a host (p_host: X-Forwarded-Host as the front sets it; lower-cased here too). p_path is the
-- request's path with or without its leading slash; p_token the visitor's __Host-qorpera_site cookie; p_etag, p_offset
-- and p_length as qorpera_site_serve takes them. Answers:
--   the old host (qorpera_site_settings.origin's): {"state":"gone"} when the path's first part names a files site taken
--   down; {"state":"moved","url":"https://<slug>.<hosts_domain>/"} when it names any valid slug while hosts are on (the
--   function keeps the rest of the path, without a ~token part, and the query); else {"state":"legacy"}: the old
--   handler, as before.
--   any other host: {"state":"none"} while hosts are off, for a host that is no site host (qorpera_site_host), for a
--   slug with no files site, an app link, a company being deleted, and on an own host for a site not live yet;
--   {"state":"gone"} for a site taken down (own and next host, with or without a session);
--   {"state":"locked","scope":"site"|"next","public":false} without a session of that scope for that site (on the own
--   host a visitor's of the current password; on the next host a member's whose version is still the site's, ready,
--   live or kept);
--   {"state":"directory","path":"<path>/","scope","public":false} for a folder with an index.html;
--   {"state":"file","status":200,"path","contentType","bytes","sha256","offset","content","scope","public":false}: the
--   file of the live version (own host) or of the session's version (next host), content as qorpera_site_serve gives it;
--   {"state":"file","status":404,…} the version's own 404.html for a path it does not have (p_etag ignored);
--   {"state":"missing","scope","public":false} for such a path when it has no 404.html.
-- Read-only.
create function public.qorpera_site_serve_host(p_host text, p_path text, p_token text, p_etag text, p_offset integer,
	p_length integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930756000
declare v_settings public.qorpera_site_settings%rowtype; v_host text := lower(p_host); v_path text; v_host_of jsonb;
	v_slug text; v_scope text; v_site public.qorpera_company_sites%rowtype; v_version uuid; v_status integer := 200;
	v_file_path text; v_type text; v_bytes integer; v_sha256 text; v_offset integer; v_length integer;
begin
	select settings.* into v_settings from public.qorpera_site_settings as settings;
	v_path := ltrim(coalesce(p_path, ''), '/');
	-- The old host: the path's first part names the site.
	if v_host = substring(v_settings.origin from '^https://(.+)$') then
		v_slug := split_part(v_path, '/', 1);
		if public.qorpera_site_slug_valid(v_slug) then
			if exists (select 1 from public.qorpera_company_sites as site where site.slug = v_slug and site.kind = 'files'
				and site.taken_down_at is not null and not public.qorpera_company_deleting(site.profile_id)) then
				return '{"state":"gone"}'::jsonb; end if;
			-- Every valid name moves, a site or not, so the old host still shows nothing of which sites exist.
			if v_settings.enabled and v_settings.hosts_enabled then
				return jsonb_build_object('state', 'moved', 'url', 'https://' || v_slug || '.' || v_settings.hosts_domain || '/');
			end if;
		end if;
		return '{"state":"legacy"}'::jsonb;
	end if;
	-- Any other host: a site's own host or its next host, while hosts are on.
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
		-- The own host serves the live version, to a visitor's session of the current password.
		if v_site.current_version_id is null then return '{"state":"none"}'::jsonb; end if;
		if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32}$' or not exists (select 1
			from public.qorpera_company_site_sessions as session
			where session.token_sha256 = public.qorpera_site_sha256(p_token) and session.site_id = v_site.id
				and session.scope = 'site' and session.password_version = v_site.password_version
				and session.expires_at > clock_timestamp()) then
			return '{"state":"locked","scope":"site","public":false}'::jsonb; end if;
		v_version := v_site.current_version_id;
	else
		-- The next host serves the version a member's session was opened for, while it is one of the site's.
		if p_token ~ '^[A-Za-z0-9_-]{32}$' then
			select session.version_id into v_version from public.qorpera_company_site_sessions as session
			join public.qorpera_company_site_versions as version on version.id = session.version_id
				and version.site_id = v_site.id and version.state in ('ready', 'live', 'kept')
			where session.token_sha256 = public.qorpera_site_sha256(p_token) and session.site_id = v_site.id
				and session.scope = 'next' and session.password_version = v_site.password_version
				and session.expires_at > clock_timestamp();
		end if;
		if v_version is null then return '{"state":"locked","scope":"next","public":false}'::jsonb; end if;
	end if;
	if v_path = '' or right(v_path, 1) = '/' then v_path := v_path || 'index.html'; end if;
	if public.qorpera_site_path_valid(v_path) then
		select file.path, file.content_type, file.bytes, file.sha256 into v_file_path, v_type, v_bytes, v_sha256
		from public.qorpera_company_site_files as file where file.version_id = v_version and file.path = v_path;
		if v_file_path is null and exists (select 1 from public.qorpera_company_site_files as file
			where file.version_id = v_version and file.path = v_path || '/index.html') then
			return jsonb_build_object('state', 'directory', 'path', v_path || '/', 'scope', v_scope, 'public', false); end if;
	end if;
	-- A path the version does not have: its own 404.html, with status 404, when it has one.
	if v_file_path is null then
		select file.path, file.content_type, file.bytes, file.sha256 into v_file_path, v_type, v_bytes, v_sha256
		from public.qorpera_company_site_files as file where file.version_id = v_version and file.path = '404.html';
		if v_file_path is null then
			return jsonb_build_object('state', 'missing', 'scope', v_scope, 'public', false); end if;
		v_status := 404;
	end if;
	v_offset := least(greatest(coalesce(p_offset, 0), 0), v_bytes);
	v_length := least(greatest(coalesce(p_length, 0), 0), v_bytes - v_offset);
	return jsonb_build_object('state', 'file', 'status', v_status, 'path', v_file_path, 'contentType', v_type,
		'bytes', v_bytes, 'sha256', v_sha256, 'offset', v_offset,
		'content', case when (v_status = 200 and p_etag is not distinct from v_sha256) or v_length = 0 then null
			else (select translate(encode(substring(file.content from v_offset + 1 for v_length), 'base64'), chr(10), '')
				from public.qorpera_company_site_files as file where file.version_id = v_version and file.path = v_file_path) end,
		'scope', v_scope, 'public', false);
end $$;

-- A visitor's password on a site's own host: qorpera_site_unlock's answers ({"state":"open","token","maxAge":604800},
-- {"state":"wrong"}, {"state":"limited","retryAfter"}) and limits, for the host's slug, while hosts are on. A next host,
-- or any host that is no site's, answers wrong and counts nothing.
create function public.qorpera_site_unlock_host(p_host text, p_password text, p_client text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930756000
declare v_host_of jsonb;
begin
	if public.qorpera_site_hosts_on() then v_host_of := public.qorpera_site_host(lower(p_host)); end if;
	if v_host_of is null or v_host_of ->> 'scope' <> 'site' then return '{"state":"wrong"}'::jsonb; end if;
	return public.qorpera_site_unlock(v_host_of ->> 'slug', p_password, p_client);
end $$;

-- A next host's ticket (p_ticket: 43 characters of base64url) for a member's session: while hosts are on, for a ticket
-- of that host's site, not expired, whose member is still an owner or admin of the company and whose version is still
-- one of the site's (ready, live or kept), of a site not taken down. The ticket goes as it is taken (one use); then the
-- site's expired next sessions go and those past the newest 19, and a next session of 12 hours for that version is
-- made. Answers {"state":"open","token":"<32 characters>","maxAge":43200}, or {"state":"refused"}.
create function public.qorpera_site_enter(p_host text, p_ticket text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930756000
declare v_host_of jsonb; v_site public.qorpera_company_sites%rowtype; v_ticket public.qorpera_company_site_tickets%rowtype;
	v_token text; v_now timestamptz := clock_timestamp();
begin
	if p_ticket is null or p_ticket !~ '^[A-Za-z0-9_-]{43}$' or not public.qorpera_site_hosts_on() then
		return '{"state":"refused"}'::jsonb; end if;
	v_host_of := public.qorpera_site_host(lower(p_host));
	if v_host_of is null or v_host_of ->> 'scope' <> 'next' then return '{"state":"refused"}'::jsonb; end if;
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = v_host_of ->> 'slug' and site.kind = 'files' and site.taken_down_at is null
		and not public.qorpera_company_deleting(site.profile_id);
	if not found then return '{"state":"refused"}'::jsonb; end if;
	-- One use: the ticket goes in the statement that takes it, so two uses at once never both open a session.
	delete from public.qorpera_company_site_tickets as ticket
	where ticket.ticket_sha256 = public.qorpera_site_sha256(p_ticket) and ticket.site_id = v_site.id
		and ticket.expires_at > v_now
	returning ticket.* into v_ticket;
	if v_ticket.ticket_sha256 is null
		or not exists (select 1 from public.qorpera_company_site_versions as version where version.id = v_ticket.version_id
			and version.site_id = v_site.id and version.state in ('ready', 'live', 'kept'))
		or not exists (select 1 from public.qorpera_profile_members as member where member.profile_id = v_site.profile_id
			and member.user_id = v_ticket.user_id and member.role in ('owner', 'admin')) then
		return '{"state":"refused"}'::jsonb; end if;
	-- At most 20 next sessions a site, the newest; visitors' sessions are not touched.
	delete from public.qorpera_company_site_sessions as session
	where session.site_id = v_site.id and session.scope = 'next' and session.expires_at <= v_now;
	delete from public.qorpera_company_site_sessions as session where session.token_sha256 in (
		select old.token_sha256 from public.qorpera_company_site_sessions as old
		where old.site_id = v_site.id and old.scope = 'next'
		order by old.created_at desc offset 19);
	v_token := public.qorpera_site_new_token();
	insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at, scope, version_id)
	values (public.qorpera_site_sha256(v_token), v_site.id, v_site.password_version, v_now + interval '12 hours', 'next',
		v_ticket.version_id);
	return jsonb_build_object('state', 'open', 'token', v_token, 'maxAge', 43200);
end $$;

revoke all on function public.qorpera_site_serve_host(text, text, text, text, integer, integer),
	public.qorpera_site_unlock_host(text, text, text), public.qorpera_site_enter(text, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_site_serve_host(text, text, text, text, integer, integer),
	public.qorpera_site_unlock_host(text, text, text), public.qorpera_site_enter(text, text)
	to service_role;

-- 4. The members' calls ------------------------------------------------------------------------------------------------

-- Look first: an owner or admin opens the version What's new shows as ready (p_change, its ready.change) on the site's
-- next host. 42501 for anyone else, 22023 for a request that is not one, P0002 for a repository the company does not
-- keep. Answers {"schema":"qorpera.site-preview/v1","state":"off"} while hosts are off; "moved" when p_change is no
-- longer a ready point with a version (read the page again); "gone" when Qorpera took the site down; else
-- {…,"state":"open","url":"https://<slug>--next.<hosts_domain>/.qorpera/enter?t=<43 characters>"}: a one-time ticket for
-- 2 minutes (only its sha256 is kept; the site's expired tickets go, and those past the newest 19).
create function public.qorpera_open_site_preview(p_profile_id uuid, p_owner text, p_name text, p_change integer)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- 20260930756000
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_repository public.qorpera_code_repositories%rowtype; v_site public.qorpera_company_sites%rowtype; v_point jsonb;
	v_ticket text; v_now timestamptz := clock_timestamp(); c_schema constant text := 'qorpera.site-preview/v1';
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null
		or v_role not in ('owner','admin') then
		raise exception 'Releases unavailable' using errcode = '42501'; end if;
	if p_owner is null or p_name is null or p_change is null or p_change < 1 then
		raise exception 'Look first request is invalid' using errcode = '22023'; end if;
	select repository.* into v_repository from public.qorpera_code_repositories repository
	join public.qorpera_company_files file on file.environment_id = repository.environment_id
		and file.profile_id = p_profile_id and file.core = 'folder-v2'
	where repository.profile_id = p_profile_id and repository.owner = p_owner and repository.name = p_name;
	if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
	if not public.qorpera_site_hosts_on() then return jsonb_build_object('schema', c_schema, 'state', 'off'); end if;
	v_point := public.qorpera_code_release_point(v_repository, p_change);
	-- Read shared (the review of #1774, F2): a takedown on its way is waited for, then read, and no ticket outlives it.
	select site.* into v_site from public.qorpera_company_sites as site where site.id = v_repository.site_id for share;
	if v_point is null or v_point ->> 'versionId' is null or v_site.id is null then
		return jsonb_build_object('schema', c_schema, 'state', 'moved'); end if;
	if v_site.taken_down_at is not null then return jsonb_build_object('schema', c_schema, 'state', 'gone'); end if;
	delete from public.qorpera_company_site_tickets as ticket where ticket.site_id = v_site.id and ticket.expires_at <= v_now;
	delete from public.qorpera_company_site_tickets as ticket where ticket.ticket_sha256 in (
		select old.ticket_sha256 from public.qorpera_company_site_tickets as old where old.site_id = v_site.id
		order by old.created_at desc offset 19);
	v_ticket := public.qorpera_site_new_secret();
	insert into public.qorpera_company_site_tickets (ticket_sha256, site_id, version_id, user_id, created_at, expires_at)
	values (public.qorpera_site_sha256(v_ticket), v_site.id, (v_point ->> 'versionId')::uuid, auth.uid(), v_now,
		v_now + interval '2 minutes');
	return jsonb_build_object('schema', c_schema, 'state', 'open', 'url', 'https://' || v_site.slug || '--next.'
		|| (select settings.hosts_domain from public.qorpera_site_settings as settings) || '/.qorpera/enter?t=' || v_ticket);
end $$;

-- What the company's sites may do beyond qorpera.company-site/v1, for any member (viewers too; 42501 for anyone else):
-- {"schema":"qorpera.company-site-access/v1","hosts":<sites have hosts of their own>,
--  "sites":[{"siteId","takenDown":null|{"at","reason"}}]}, every site of the company, by slug. Read leniently: later
-- steps add keys (public sites, own addresses). Read-only.
create function public.qorpera_company_site_access(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930756000
begin
	if auth.uid() is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only the company''s members see its sites' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.company-site-access/v1', 'hosts', public.qorpera_site_hosts_on(),
		-- Each site by its name too (the review of #1774, F4): a project's site that never went live is in no list, and
		-- Sites draws a row for it from here while it is taken down.
		'sites', coalesce((select jsonb_agg(jsonb_build_object('siteId', site.id, 'slug', site.slug, 'title', site.title,
				'kind', site.kind, 'source', site.source_path,
				'takenDown', case when site.taken_down_at is not null
					then jsonb_build_object('at', site.taken_down_at, 'reason', site.taken_down_reason) end)
			order by site.slug collate "C")
			from public.qorpera_company_sites as site where site.profile_id = p_profile_id), '[]'::jsonb));
end $$;

revoke all on function public.qorpera_open_site_preview(uuid, text, text, integer), public.qorpera_company_site_access(uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_open_site_preview(uuid, text, text, integer), public.qorpera_company_site_access(uuid)
	to authenticated;
comment on function public.qorpera_open_site_preview(uuid, text, text, integer) is
	'Look first: an owner or admin opens the ready version What''s new shows on the site''s next host, with a one-time '
	'ticket of 2 minutes; off while hosts are off, moved for a page that moved, gone for a site taken down (20260930756000).';
comment on function public.qorpera_company_site_access(uuid) is
	'For any member: whether sites have hosts of their own, and which of the company''s sites Qorpera took down and '
	'why (20260930756000).';

-- 5. The operator's calls --------------------------------------------------------------------------------------------

-- The company of the site p_slug, entered as every caller that writes for a company enters it (the review of #1774,
-- F1): on folder-v2 the folder fence KEY SHARE, then the company row KEY SHARE (rank 0); before folder-v2 the company
-- row alone. A company's deletion finisher holds the fence (qorpera_folder_deletion_drain) and the company row FOR UPDATE
-- before it counts the company's sites taken down, and its purge deletes the row: so a takedown either commits before
-- the finisher counts, which then waits for it, or waits for the finisher's pass, after which a purged company has no
-- site of this name (P0002). Answers the company's id, or null for no such site.
create function public.qorpera_site_enter_company(p_slug text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
-- 20260930756000
declare v_profile uuid;
begin
	select site.profile_id into v_profile from public.qorpera_company_sites as site where site.slug = p_slug;
	if not found then return null; end if;
	perform 1 from public.qorpera_folder_fences as fence where fence.profile_id = v_profile for key share;
	perform 1 from public.qorpera_profiles as profile where profile.id = v_profile for key share;
	return v_profile;
end $$;
revoke all on function public.qorpera_site_enter_company(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Takes the site of p_slug (any kind) down, for a reason members read (one line, 1 to 300 characters; a second takedown
-- keeps its time and takes the new reason): its hosts answer gone, an app link answers as off, nothing goes live on it,
-- and its Look first tickets go. Nothing is deleted. 22023 for a reason that is not one, P0002 for no such site.
create function public.qorpera_site_take_down(p_slug text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930756000
declare v_site public.qorpera_company_sites%rowtype; v_reason text := btrim(p_reason); v_profile uuid;
begin
	if v_reason is null or char_length(v_reason) not between 1 and 300 or v_reason ~ '[[:cntrl:]]' then
		raise exception 'A takedown''s reason is one line of 1 to 300 characters' using errcode = '22023'; end if;
	-- The company first (qorpera_site_enter_company), then a repository's site's registry row (the order the executor's
	-- site calls take rows in), then the site.
	v_profile := public.qorpera_site_enter_company(p_slug);
	perform 1 from public.qorpera_code_repositories as repository
	where repository.site_id = (select site.id from public.qorpera_company_sites as site
		where site.slug = p_slug and site.profile_id = v_profile) for update;
	update public.qorpera_company_sites set taken_down_at = coalesce(taken_down_at, clock_timestamp()),
		taken_down_reason = v_reason
	where slug = p_slug and profile_id = v_profile returning * into v_site;
	if v_site.id is null then raise exception 'No site has this name' using errcode = 'P0002'; end if;
	delete from public.qorpera_company_site_tickets where site_id = v_site.id;
	-- Its list file is written again (changes/index.md says it was taken down, and no link).
	update public.qorpera_code_repositories as repository set index_version = repository.index_version + 1
	where repository.site_id = v_site.id;
	return jsonb_build_object('schema', 'qorpera.site-take-down/v1', 'slug', v_site.slug, 'state', 'down');
end $$;

-- Undoes a takedown: the site answers as before it (its sessions were kept). P0002 for no such site.
create function public.qorpera_site_restore(p_slug text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930756000
declare v_site public.qorpera_company_sites%rowtype; v_profile uuid;
begin
	-- In the takedown's order: the company, the registry row, the site.
	v_profile := public.qorpera_site_enter_company(p_slug);
	perform 1 from public.qorpera_code_repositories as repository
	where repository.site_id = (select site.id from public.qorpera_company_sites as site
		where site.slug = p_slug and site.profile_id = v_profile) for update;
	update public.qorpera_company_sites set taken_down_at = null, taken_down_reason = null
	where slug = p_slug and profile_id = v_profile returning * into v_site;
	if v_site.id is null then raise exception 'No site has this name' using errcode = 'P0002'; end if;
	update public.qorpera_code_repositories as repository set index_version = repository.index_version + 1
	where repository.site_id = v_site.id;
	return jsonb_build_object('schema', 'qorpera.site-take-down/v1', 'slug', v_site.slug, 'state', 'up');
end $$;

-- Sets a repository's drill (check, site; null clears it) for the checks switch to take once. A drill the switch took
-- but no landing used (no checks file, nothing to land, an answer lost on the way) is spent: set it again. Answers
-- {"schema":"qorpera.code-drill/v1","owner","name","drill","setAt","takenAt"}. 22023 for another drill, P0002 for no
-- such repository.
create function public.qorpera_code_set_drill(p_environment_id uuid, p_owner text, p_name text, p_drill text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930756000
declare v_repository public.qorpera_code_repositories%rowtype;
begin
	if p_drill is not null and p_drill not in ('check', 'site') then
		raise exception 'A drill is check, site or null' using errcode = '22023'; end if;
	update public.qorpera_code_repositories set drill = p_drill, drill_set_at = clock_timestamp()
	where environment_id = p_environment_id and owner = p_owner and name = p_name returning * into v_repository;
	if v_repository.environment_id is null then raise exception 'No such repository' using errcode = 'P0002'; end if;
	return jsonb_build_object('schema', 'qorpera.code-drill/v1', 'owner', v_repository.owner, 'name', v_repository.name,
		'drill', v_repository.drill, 'setAt', v_repository.drill_set_at, 'takenAt', v_repository.drill_taken_at);
end $$;

revoke all on function public.qorpera_site_take_down(text, text), public.qorpera_site_restore(text),
	public.qorpera_code_set_drill(uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 6. Every changed body carries the marker, and keeps the ones it had -------------------------------------------------

do $guard$
declare v_function text; v_markers text[]; v_marker text;
begin
	for v_function, v_markers in select checked.signature, checked.markers from (values
		('public.qorpera_site_slug_valid(text)', array['20260930550000']),
		('public.qorpera_site_url(text)', array['20260930550000', '20260930562000']),
		('public.qorpera_site_serve(text,text,text,text,integer,integer)', array['20260930550000', '20260930562000']),
		('public.qorpera_site_unlock(text,text,text)', array['20260930550000']),
		('public.qorpera_site_app_live(public.qorpera_company_sites)', array['20260930562000']),
		('public.qorpera_code_site_slugs(text,text)', array[]::text[]),
		('public.qorpera_code_checks_switch(uuid,uuid)', array['20260930729000']),
		('public.qorpera_code_release_index(public.qorpera_code_repositories)', array[]::text[]),
		('public.qorpera_list_code_releases(uuid)', array[]::text[]),
		('public.qorpera_put_code_release_live(uuid,text,text,jsonb)', array[]::text[]),
		('public.qorpera_code_release_back(uuid,text,text,jsonb)', array[]::text[]),
		('public.qorpera_site_publish_check(jsonb,text)', array['20260930550000', '20260930562000', '20260930729000']),
		('public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)', array['20260930550000', '20260930562000', '20260930729000']),
		('public.qorpera_site_publish_put(jsonb,uuid,jsonb)', array['20260930550000']),
		('public.qorpera_site_publish_finish(jsonb,uuid)', array['20260930550000']),
		('public.qorpera_site_share_check(jsonb,text,text,integer)', array['20260930562000']),
		('public.qorpera_site_share_app(jsonb,text,jsonb,uuid)', array['20260930562000', '20260930729000']),
		('public.qorpera_site_unpublish(jsonb,text)', array['20260930550000', '20260930562000', '20260930729000']),
		('public.qorpera_code_sites_due(text,text,integer)', array[]::text[]),
		('public.qorpera_code_site_begin(text,text,uuid,text,text,integer,jsonb)', array[]::text[]),
		('public.qorpera_unpublish_company_site(uuid)', array['20260930550000', '20260930729000']),
		('public.qorpera_delete_hosted_profile(uuid)', array[]::text[]),
		('public.qorpera_finish_company_deletion(uuid)', array[]::text[]),
		('public.qorpera_site_abandoned(public.qorpera_company_sites)', array['20260930550000', '20260930562000', '20260930729000'])) checked(signature, markers)
	loop
		foreach v_marker in array v_markers || '20260930756000'::text loop
			if strpos((select prosrc from pg_proc where oid = v_function::regprocedure), v_marker) = 0 then
				raise exception '% is missing from %', v_marker, v_function; end if;
		end loop;
	end loop;
end $guard$;
