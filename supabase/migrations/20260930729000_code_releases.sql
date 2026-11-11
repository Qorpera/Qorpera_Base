-- 20260930729000: a repository's website, kept as versions and put live or taken back only by a member on What's new
-- (own code storage, step 4 "released and live"; 11 Nov 2026).
--
-- A repository kept in Qorpera may now say in its checks file where its checks leave the built website. Once every
-- check of a landing passed, the coding executor keeps those files as a git tree in the repository's storage and says
-- so in the landing's report; a pass of the executor then uploads the tree into the site tables as a version of the
-- repository's own site. Nothing goes live by itself: an owner or admin puts the newest ready version live on Qorpera's
-- What's new page, or goes back to the version that was live before. This migration is the kernel's side of all of
-- that. It is inert until an executor that sends v3 reports is rolled: before that no row has a site, nothing is due,
-- nothing is ready, and publish_site's new refusals meet no code site.
--
-- 1. Tables and columns:
--    * qorpera_code_repositories: site_enabled, an operator's switch per repository (on by default; off, the checks
--      run and no site is made), switched by the database owner alone:
--        update public.qorpera_code_repositories set site_enabled = false
--        where environment_id = '…' and owner = '…' and name = '…';
--      the repository's site (site_id), its releases (last_release, live_release, last_version), and the back-off of
--      uploads that failed (site_attempts of the change site_change, site_not_before, site_problem, site_given_up).
--    * qorpera_code_changes: site_state, site and site_problem: made (the checks left a site, kept as a git tree;
--      site says which) or missed (Qorpera could not keep it; site_problem says why).
--    * qorpera_company_sites: code_owner and code_name for a repository's site (made by the platform at its first
--      upload; created_by_staff_agent_id may then be null), and published_by_user_id (a member put it live).
--    * qorpera_company_site_versions: a version made from a repository has its tree, change and commit, no run, call
--      or agent, and is listed once the executor has named its files; two more states, ready (complete, never live)
--      and kept (was live, kept for Go back). One version per tree and site.
--    * qorpera_company_site_file_parts: the parts of a file's bytes while they arrive in small calls.
--    * qorpera_code_releases: a member put a ready version live (release), or went back to the one before (back).
-- 2. The report qorpera.code-change-report/v3: v2 with `site`, and the row it appends or the filler it takes over.
-- 3. The executor's calls (service role): qorpera_code_sites_due, qorpera_code_site_begin, _list, _missing, _put,
--    _finish and _failed. Every refusal the pass tells apart is answered as a value: a raised error reaches the pass
--    only as CODING_CONTROL_UNCONFIRMED.
-- 4. The member's calls: qorpera_list_code_releases (any member), qorpera_put_code_release_live and
--    qorpera_code_release_back (owners and admins).
-- 5. Sixteen existing functions change, each by anchors on its definition as it is (an anchor that is not found
--    exactly once fails the migration), and each changed body carries the marker 20260930729000:
--    * qorpera_code_checks_switch answers `site` too;
--    * qorpera_code_change_report_valid and qorpera_record_code_change take v3;
--    * qorpera_code_change_files: the list says what is live and what is ready;
--    * qorpera_code_request_finish and qorpera_code_restore_record: an inheriting row inherits the site too;
--    * qorpera_complete_coding_turn: the platform's line on a landing says whether Qorpera keeps its site;
--    * qorpera_coding_turn_failure: CODING_CHECKS_SITE_REFUSED keeps the executor's words and counts as a round;
--    * qorpera_site_publish_check, qorpera_site_publish_begin and qorpera_site_unpublish: only Qorpera publishes or
--      takes down a repository's site (members still take one offline in Sites), and publish_site never publishes a
--      folder under code/; qorpera_site_publish_begin and qorpera_site_share_app make one site at a time in a company,
--      as a repository's first upload does, so the ten hold;
--    * qorpera_list_company_sites: a code site only while it is live, its row exactly qorpera.company-site/v1;
--    * qorpera_site_abandoned: never a code site.
--    * qorpera_unpublish_company_site: a member who takes a repository's site offline locks its registry row first and
--      has its list file written again.
--    * qorpera_member_app_layout_valid (20260930728000): a member's own apps drawer may place the bare key whats-new,
--      the What's new page, beside concepts and sites.
--
-- Who may call: section 3 the service role only, as the coding executor that holds the company (the custody check of
-- qorpera_code_hosts_deleting, 42501 otherwise, and care's holder rule: an executor that is not the environment's one
-- enabled executor on that machine gets nothing, or `lost`). Section 4 role authenticated, as a member of the company.
-- Locks, always in this order: the company's profile row (a key share, where a row with its key is written), the
-- repository's registry row, the company's lock on making a site (an advisory lock, only while a site is made), the
-- site row, then version rows. Every call of a repository's site keeps it, the member's taking it offline in Sites too.
-- A new site's name never waits on, and never keeps, a lock of a site whose name it passes over: a name some site has
-- is passed over without a lock, and an abandoned site is locked only when no other call holds it, then checked again
-- before it goes. The member's two writes give up after 3 s of waiting.

set local lock_timeout = '3s';

-- 1. Tables and columns ------------------------------------------------------------------------------------------------

alter table public.qorpera_code_repositories
	-- An operator's switch (step 4). Off: the checks run and no site is made.
	add column site_enabled boolean not null default true,
	-- The repository's site, made at its first upload; null before, or once a member took it offline (the site went).
	add column site_id uuid references public.qorpera_company_sites(id) on delete set null,
	-- Its releases: the last row's number, the live row's (read only while the site has a current version; null once a
	-- member took the site offline), and the last version number founders saw.
	add column last_release integer not null default 0 check (last_release >= 0),
	add column live_release integer check (live_release is null or live_release >= 1),
	add column last_version integer not null default 0 check (last_version >= 0),
	-- Uploads that failed: site_attempts failures in a row of change site_change, and the pass backs off until
	-- site_not_before; site_given_up is the change it stopped trying after five. All forgotten when a member takes the
	-- site offline.
	add column site_attempts integer not null default 0 check (site_attempts >= 0),
	add column site_change integer check (site_change is null or site_change >= 1),
	add column site_not_before timestamptz,
	add column site_problem text check (site_problem is null or site_problem ~ '^[A-Z0-9_:]{1,120}$'),
	add column site_given_up integer check (site_given_up is null or site_given_up >= 1);
create index qorpera_code_repositories_site on public.qorpera_code_repositories(site_id) where site_id is not null;

alter table public.qorpera_code_changes
	-- made: the checks left a site, kept as a git tree in repo.git (site says which). missed: Qorpera could not keep
	-- it (site_problem says why). Null: no site, a row before step 4, or one that is not a gated landing. An inheriting
	-- row (an andLater undo, a restore) copies the three from the row it inherits.
	add column site_state text check (site_state is null or site_state in ('made','missed')),
	add column site jsonb check (site is null or (jsonb_typeof(site) = 'object' and pg_column_size(site) <= 2048)),
	add column site_problem text check (site_problem is null or site_problem ~ '^[A-Z0-9_:]{1,120}$'),
	add check ((site_state is not distinct from 'made') = (site is not null)),
	add check ((site_state is not distinct from 'missed') = (site_problem is not null));
-- site for made:
-- {"schema":"qorpera.code-site/v1","tree":"<40 hex>","files":1..500,"bytes":0..26214400,
--  "folder":"<. or a folder of the repository, at most 300 bytes>","name":"<a site name>"|null,"title":"<1 to 120>"|null}
create index qorpera_code_changes_site on public.qorpera_code_changes(environment_id, owner, name, n)
	where site_state = 'made';

alter table public.qorpera_company_sites
	-- A repository's site (step 4): made by the platform, put live only from What's new.
	add column code_owner text,
	add column code_name text,
	-- Who put the live version up: a member (a code site) or an agent (publish_site). A plain value, no foreign key.
	add column published_by_user_id uuid,
	-- The platform makes a code site, for the agent of the change it was made at, or for none.
	alter column created_by_staff_agent_id drop not null,
	add constraint qorpera_company_sites_code check ((code_owner is null) = (code_name is null)
		and (code_owner is null or kind = 'files') and (code_owner is not null or created_by_staff_agent_id is not null)),
	add constraint qorpera_company_sites_code_repository foreign key (environment_id, code_owner, code_name)
		references public.qorpera_code_repositories(environment_id, owner, name) on delete cascade,
	drop constraint qorpera_company_sites_check,
	add constraint qorpera_company_sites_published check ((published_at is null)
		= (published_by_staff_agent_id is null and published_by_user_id is null)
		and (published_by_staff_agent_id is null or published_by_user_id is null));
-- One site a repository.
create unique index qorpera_company_sites_code on public.qorpera_company_sites(environment_id, code_owner, code_name)
	where code_owner is not null;

alter table public.qorpera_company_site_versions
	alter column run_id drop not null, alter column call_id drop not null, alter column staff_agent_id drop not null,
	-- A version made from a repository (step 4): its files' git tree, and the change and commit it was made at.
	add column tree text check (tree is null or tree ~ '^[0-9a-f]{40}$'),
	add column change integer check (change is null or change >= 1),
	add column main_sha text check (main_sha is null or main_sha ~ '^[0-9a-f]{40}$'),
	-- Every file of the version is named. A version of publish_site is named whole at its begin; a version made from a
	-- repository is named in pages by the executor, and is listed once the last page matched its manifest.
	add column listed boolean not null default true,
	drop constraint qorpera_company_site_versions_state_check,
	-- ready: complete, never live. kept: was live, kept for Go back.
	add constraint qorpera_company_site_versions_state_check check (state in ('uploading','live','ready','kept')),
	drop constraint qorpera_company_site_versions_check,
	add constraint qorpera_company_site_versions_published check ((state in ('live','kept')) = (published_at is not null)),
	add constraint qorpera_company_site_versions_from check ((tree is null) = (run_id is not null)
		and (tree is null) = (call_id is not null) and (tree is null) = (staff_agent_id is not null)
		and (tree is null) = (change is null) and (tree is null) = (main_sha is null)
		and (tree is not null or state in ('uploading','live'))),
	add constraint qorpera_company_site_versions_listed check (listed or (tree is not null and state = 'uploading'));
create unique index qorpera_company_site_versions_tree on public.qorpera_company_site_versions(site_id, tree)
	where tree is not null;

-- The bytes of one file of a version, in parts, while they arrive: a call carries at most 128 KiB. Once a file has all
-- its parts they are joined, checked against its size and digest, written to its content and deleted.
create table public.qorpera_company_site_file_parts (
	version_id uuid not null,
	path text not null,
	part integer not null check (part >= 0),
	of integer not null check (of between 1 and 128),
	content bytea not null check (octet_length(content) <= 131072),
	primary key (version_id, path, part),
	foreign key (version_id, path) references public.qorpera_company_site_files(version_id, path) on delete cascade,
	check (part < of)
);
alter table public.qorpera_company_site_file_parts enable row level security;
revoke all on public.qorpera_company_site_file_parts from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_company_site_file_parts is
	'20260930729000: the parts of a site file''s bytes while the coding executor uploads a repository''s site in small '
	'calls; joined, checked and deleted once a file has them all. Its functions write it.';

create table public.qorpera_code_releases (
	environment_id uuid not null,
	owner text not null,
	name text not null,
	n integer not null check (n >= 1),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	-- release: a member put a ready version live. back: a member went back to the version live before.
	kind text not null check (kind in ('release','back')),
	-- What founders call it: a release takes the next number; a go-back shows the number of the version it put back.
	version integer not null check (version >= 1),
	change integer not null check (change >= 1),
	main_sha text not null check (main_sha ~ '^[0-9a-f]{40}$'),
	tree text not null check (tree ~ '^[0-9a-f]{40}$'),
	-- The version it put live; null once pruned or taken offline with its site.
	version_id uuid references public.qorpera_company_site_versions(id) on delete set null,
	-- The release live before it; and the one Go back from it puts live.
	replaces integer,
	prior integer,
	-- What the member said yes to: the rows the page held (the newest 500), and its token over all of them.
	changes integer[] not null default '{}' check (cardinality(changes) <= 500),
	shown_sha256 text check (shown_sha256 is null or shown_sha256 ~ '^[0-9a-f]{64}$'),
	-- A plain value, no foreign key: a release names its member, it does not hold them.
	by_user_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, owner, name, n),
	foreign key (environment_id, owner, name)
		references public.qorpera_code_repositories(environment_id, owner, name) on delete cascade,
	check ((kind = 'release') = (shown_sha256 is not null)),
	check (kind = 'release' or cardinality(changes) = 0)
);
create index qorpera_code_releases_profile on public.qorpera_code_releases(profile_id);
create index qorpera_code_releases_version on public.qorpera_code_releases(version_id) where version_id is not null;
alter table public.qorpera_code_releases enable row level security;
revoke all on public.qorpera_code_releases from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_code_releases is
	'20260930729000: the releases of a repository kept in Qorpera: a member put a ready version of its site live, or '
	'went back to the one live before. Numbered without gaps under the registry row''s lock. Its functions write it.';

-- 2. What a report says of the site ------------------------------------------------------------------------------------

-- Whether p_site is a made site's value, as a landing's row keeps it (its `site`):
-- {"schema":"qorpera.code-site/v1","tree":"<40 hex>","files":1..500,"bytes":0..26214400,"folder":"<folder>",
--  "name":"<a site name>"|null,"title":"<title>"|null}
-- Exactly those keys; the folder `.` or a folder of the repository as a check's cwd is (a relative path of at most 300
-- bytes, no part empty, `.` or `..`, no control character or backslash); the title 1 to 120 characters on one line with
-- no space at either end (a version's own rule); all of it at most 2 KiB.
create function public.qorpera_code_site_valid(p_site jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(case when jsonb_typeof(p_site) = 'object' then pg_column_size(p_site) <= 2048
		and p_site ?& array['schema','tree','files','bytes','folder','name','title']
		and p_site - array['schema','tree','files','bytes','folder','name','title'] = '{}'::jsonb
		and p_site -> 'schema' = '"qorpera.code-site/v1"'::jsonb
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
		else false end, false)
$$;

-- Whether a report of schema v3 says what became of the site as its state asks: JSON null for every report but a
-- landing whose checks passed; for that, JSON null (the repository has no site, or sites are switched off),
-- {"state":"made","site":<qorpera_code_site_valid>} or {"state":"missed","code":"<CODE>"}.
create function public.qorpera_code_change_site_valid(p_change jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(case when p_change -> 'state' = '"landed"'::jsonb and p_change -> 'checks' -> 'state' = '"passed"'::jsonb
			then case jsonb_typeof(p_change -> 'site') when 'null' then true
				when 'object' then case p_change -> 'site' -> 'state'
					when '"made"'::jsonb then (p_change -> 'site') - array['state','site'] = '{}'::jsonb
						and public.qorpera_code_site_valid(p_change -> 'site' -> 'site')
					when '"missed"'::jsonb then (p_change -> 'site') - array['state','code'] = '{}'::jsonb
						and public.qorpera_code_json_text(p_change -> 'site' -> 'code', '^[A-Z0-9_:]{1,120}$')
					else false end
				else false end
		else p_change -> 'site' = 'null'::jsonb end, false)
$$;

-- 3. The executor's calls ----------------------------------------------------------------------------------------------

-- The repository's live release: the row live_release names, while the repository's site has a current version; else
-- null (no site, a site that is not live yet, or one a member took offline and the next upload made again).
create function public.qorpera_code_release_live(p_repository public.qorpera_code_repositories)
returns public.qorpera_code_releases language sql stable set search_path = '' as $$
	select release.* from public.qorpera_code_releases release
	join public.qorpera_company_sites site on site.id = p_repository.site_id and site.current_version_id is not null
	where release.environment_id = p_repository.environment_id and release.owner = p_repository.owner
		and release.name = p_repository.name and release.n = p_repository.live_release
$$;

-- A repository's ready point (step 4, 6.1), as a value: the newest (p_change null) or row p_change; null when there is
-- none. L is the change the live release is cut at (0 when the site is not live). A row r is a ready point when r.n > L,
-- it is landed, its checks passed or it inherited them, and it made a site; its tree has a ready, live or kept version
-- on the repository's site (unless p_versioned is false: the due list asks before the upload); and no row from L up to
-- r is reverted by a row numbered above r, or lost to a restore numbered above r (a change taken out later is never
-- released inside it; a row a restore at or below r went back past is no part of r). The newest is looked for among
-- the newest 200 rows after L that moved main.
-- What it holds: the rows after L up to r that are landed, of kind landing, undo or restore, but an undo whose every
-- target is among them (the two cancel). Listed: those with a notice, newest first, at most 20. The token is a SHA-256
-- over the repository, the live release, r, its commit and tree, and every row after L up to r (number, state, notice
-- and picture): a page that names it saw exactly that. Answers
-- {"change","mainSha","tree","site":<r's site>,"versionId":<uuid>|null,"live":<the live release's n, or 0>,"floor":L,
--  "held":[<n>, newest first, at most 500],"count":<held rows>,"listed":[<n>, newest first],"token":"<64 hex>",
--  "agent":<the staff agent of the newest listed row, else of the newest held row>|null}.
create function public.qorpera_code_release_point(p_repository public.qorpera_code_repositories,
	p_change integer default null, p_versioned boolean default true)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_live public.qorpera_code_releases%rowtype; v_floor integer; v_row public.qorpera_code_changes%rowtype;
	v_version uuid; v_held integer[]; v_count integer; v_listed integer[]; v_token text; v_agent uuid;
begin
	if p_repository.environment_id is null then return null; end if;
	v_live := public.qorpera_code_release_live(p_repository);
	v_floor := coalesce(v_live.change, 0);
	select ready.* into v_row
	from (select candidate.* from public.qorpera_code_changes candidate
		where candidate.environment_id = p_repository.environment_id and candidate.owner = p_repository.owner
			and candidate.name = p_repository.name and candidate.n > v_floor and (p_change is null or candidate.n = p_change)
			-- (Rows that moved main: a refused or conflicting landing takes no place in the window.)
			and candidate.main_after is not null
		order by candidate.n desc limit 200) ready
	where ready.state = 'landed' and ready.checks_state in ('passed','inherited') and ready.site_state = 'made'
		and (not p_versioned or exists (select 1 from public.qorpera_company_site_versions version
			where version.site_id = p_repository.site_id and version.tree = ready.site ->> 'tree'
				and version.state in ('ready','live','kept')))
		and not exists (select 1 from public.qorpera_code_changes taken
			where taken.environment_id = p_repository.environment_id and taken.owner = p_repository.owner
				and taken.name = p_repository.name and taken.n > v_floor and taken.n <= ready.n
				and ((taken.state = 'reverted' and taken.reverted_by > ready.n)
					-- (A row a restore at or below r went back past is not in r's files: r landed after that restore.)
					or (taken.state = 'lost' and not exists (select 1 from public.qorpera_code_changes wall
						where wall.environment_id = p_repository.environment_id and wall.owner = p_repository.owner
							and wall.name = p_repository.name and wall.kind = 'restore' and wall.n > taken.n
							and wall.n <= ready.n))))
	order by ready.n desc limit 1;
	if v_row.n is null then return null; end if;
	select version.id into v_version from public.qorpera_company_site_versions version
	where version.site_id = p_repository.site_id and version.tree = v_row.site ->> 'tree'
		and version.state in ('ready','live','kept');
	select coalesce(array_agg(held.n order by held.n desc) filter (where held.place <= 500), '{}'), count(*)::integer,
		coalesce(array_agg(held.n order by held.n desc) filter (where held.notice is not null and held.noticed <= 20), '{}')
	into v_held, v_count, v_listed
	from (select change.n, change.notice, row_number() over (order by change.n desc) as place,
			row_number() over (partition by change.notice is not null order by change.n desc) as noticed
		from public.qorpera_code_changes change
		where change.environment_id = p_repository.environment_id and change.owner = p_repository.owner
			and change.name = p_repository.name and change.n > v_floor and change.n <= v_row.n and change.state = 'landed'
			and change.kind in ('landing','undo','restore')
			and not (change.kind = 'undo' and not exists (select 1 from unnest(change.undoes) target(n) where target.n <= v_floor))) held;
	select coalesce((select change.staff_agent_id from public.qorpera_code_changes change
			where change.environment_id = p_repository.environment_id and change.owner = p_repository.owner
				and change.name = p_repository.name and change.n = v_listed[1]),
		(select change.staff_agent_id from public.qorpera_code_changes change
			where change.environment_id = p_repository.environment_id and change.owner = p_repository.owner
				and change.name = p_repository.name and change.n = v_held[1])) into v_agent;
	select encode(extensions.digest(convert_to(jsonb_build_array(p_repository.environment_id, p_repository.owner,
			p_repository.name, coalesce(v_live.n, 0), v_row.n, v_row.main_after, v_row.site ->> 'tree',
			coalesce(jsonb_agg(jsonb_build_array(shown.n, shown.state, shown.notice, shown.picture) order by shown.n),
				'[]'::jsonb))::text, 'utf8'), 'sha256'), 'hex') into v_token
	from public.qorpera_code_changes shown
	where shown.environment_id = p_repository.environment_id and shown.owner = p_repository.owner
		and shown.name = p_repository.name and shown.n > v_floor and shown.n <= v_row.n;
	return jsonb_build_object('change', v_row.n, 'mainSha', v_row.main_after, 'tree', v_row.site ->> 'tree',
		'site', v_row.site, 'versionId', v_version, 'live', coalesce(v_live.n, 0), 'floor', v_floor, 'held', to_jsonb(v_held),
		'count', v_count, 'listed', to_jsonb(v_listed), 'token', v_token, 'agent', v_agent);
end $$;

-- The names a repository's new site may take, in the order they are tried (step 4, 7.2): the one its checks file asks
-- for (p_wanted); the repository's name with _ and . made -, cut to 48 and trimmed of hyphens (`project` when that leaves
-- nothing); then that cut to 46 with -2 to -9. Only valid site names (qorpera_site_slug_valid), each once. Whether one
-- is free is the caller's to find, under the lock of the site that has it (qorpera_code_site_begin).
create function public.qorpera_code_site_slugs(p_name text, p_wanted text)
returns text[] language sql immutable set search_path = '' as $$
	select coalesce(array_agg(candidate.slug order by candidate.place), '{}') from (
		select distinct on (named.slug) named.slug, named.place from (
			select tried.slug, tried.place
			from (select coalesce(nullif(btrim(left(lower(translate(p_name, '_.', '--')), 48), '-'), ''), 'project') as name) base
			cross join lateral unnest(array[p_wanted, base.name] || array(select coalesce(nullif(btrim(left(base.name, 46), '-'),
				''), 'project') || '-' || number from generate_series(2, 9) number)) with ordinality tried(slug, place)
		) named
		where public.qorpera_site_slug_valid(named.slug)
		order by named.slug, named.place) candidate
$$;

-- Deletes the versions of a repository's site that neither Go back nor What's new needs any more, and answers how many
-- (step 4, D13): every ready or kept version but the live one, the versions the live release's chain of Go backs names
-- within five steps, and the newest three ready. An upload on its way is not touched.
create function public.qorpera_code_site_prune(p_site_id uuid)
returns integer language plpgsql volatile set search_path = '' as $$
declare v_site public.qorpera_company_sites%rowtype; v_repository public.qorpera_code_repositories%rowtype;
	v_live public.qorpera_code_releases%rowtype; v_keep uuid[] := '{}'; v_count integer;
begin
	select * into v_site from public.qorpera_company_sites where id = p_site_id;
	if v_site.code_owner is null then return 0; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_site.environment_id and owner = v_site.code_owner and name = v_site.code_name;
	v_live := public.qorpera_code_release_live(v_repository);
	if v_live.n is not null then
		with recursive chain(prior, version_id, depth) as (
			select release.prior, release.version_id, 1 from public.qorpera_code_releases release
			where release.environment_id = v_repository.environment_id and release.owner = v_repository.owner
				and release.name = v_repository.name and release.n = v_live.prior
			union all
			select release.prior, release.version_id, chain.depth + 1 from chain
			join public.qorpera_code_releases release on release.environment_id = v_repository.environment_id
				and release.owner = v_repository.owner and release.name = v_repository.name and release.n = chain.prior
			where chain.depth < 5)
		select coalesce(array_agg(chain.version_id) filter (where chain.version_id is not null), '{}') into v_keep from chain;
	end if;
	delete from public.qorpera_company_site_versions version
	where version.site_id = p_site_id and version.state in ('ready','kept')
		and version.id is distinct from v_site.current_version_id and not (version.id = any(v_keep))
		and version.id not in (select newest.id from public.qorpera_company_site_versions newest
			where newest.site_id = p_site_id and newest.state = 'ready'
			order by newest.created_at desc, newest.id desc limit 3);
	get diagnostics v_count = row_count;
	return v_count;
end $$;

-- What a repository's list file says of its site (step 4, 7.5 item 3): what is live
-- ({"version","kind","change","since","by":<the member's name, or null when they left>,"url"}) and what is ready
-- ({"change"}), each null when there is none; neither key for a repository that has no site and never made one.
create function public.qorpera_code_release_index(p_repository public.qorpera_code_repositories)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_live public.qorpera_code_releases%rowtype; v_point jsonb;
begin
	if p_repository.site_id is null and not exists (select 1 from public.qorpera_code_changes made
		where made.environment_id = p_repository.environment_id and made.owner = p_repository.owner
			and made.name = p_repository.name and made.site_state = 'made') then
		return '{}'::jsonb; end if;
	v_live := public.qorpera_code_release_live(p_repository);
	v_point := public.qorpera_code_release_point(p_repository);
	return jsonb_build_object('live', case when v_live.n is not null then jsonb_build_object('version', v_live.version,
			'kind', v_live.kind, 'change', v_live.change, 'since', v_live.created_at,
			'by', (select member.display_name from public.qorpera_profile_members member
				where member.profile_id = v_live.profile_id and member.user_id = v_live.by_user_id),
			'url', (select public.qorpera_site_url(site.slug) from public.qorpera_company_sites site
				where site.id = p_repository.site_id)) end,
		'ready', case when v_point is not null then jsonb_build_object('change', v_point -> 'change') end);
end $$;

-- The repository whose site a version made from code is of, for the executor that holds its company; null when the
-- version is gone or is no code site's, when the caller does not hold the company, or when it is being deleted.
create function public.qorpera_code_site_repository(p_owner text, p_machine_id_sha256 text, p_version_id uuid)
returns public.qorpera_code_repositories language sql stable set search_path = '' as $$
	select repository.* from public.qorpera_company_site_versions version
	join public.qorpera_company_sites site on site.id = version.site_id and site.code_owner is not null
	join public.qorpera_code_repositories repository on repository.environment_id = site.environment_id
		and repository.owner = site.code_owner and repository.name = site.code_name
	where version.id = p_version_id and version.tree is not null
		and public.qorpera_code_care_holder(repository.environment_id, p_owner, p_machine_id_sha256)
		and not exists (select 1 from public.qorpera_company_deletions deletion
			where deletion.profile_id = repository.profile_id)
$$;

-- Whether no upload pass tries the repository's newest point again until something changes: that point (6.1 without
-- its version, as the due list takes it; p_point when the caller has it) has no version and is the change the pass
-- gave up after five failures, and the give-up still holds. One given up for the company's ten (SITE_LIMIT) holds while
-- the company has 10 sites; one given up because every name it may take was taken (SITE_NAME_TAKEN), while each of
-- those names is had by a site that is not abandoned. Ends with a newer change that leaves a site (a newer point), an
-- upload that finishes, a member taking the site offline, room among the ten, or a free name.
create function public.qorpera_code_site_given_up(p_repository public.qorpera_code_repositories, p_point jsonb default null)
returns boolean language plpgsql stable set search_path = '' as $$
declare v_point jsonb := p_point;
begin
	if p_repository.site_given_up is null then return false; end if;
	v_point := coalesce(v_point, public.qorpera_code_release_point(p_repository, null, false));
	return coalesce(v_point ->> 'versionId' is null and (v_point ->> 'change')::integer = p_repository.site_given_up, false)
		and not (p_repository.site_problem is not distinct from 'SITE_LIMIT' and (select count(*)
			from public.qorpera_company_sites site where site.profile_id = p_repository.profile_id) < 10)
		and not (p_repository.site_problem is not distinct from 'SITE_NAME_TAKEN' and exists (select 1
			from unnest(public.qorpera_code_site_slugs(p_repository.name, v_point -> 'site' ->> 'name')) candidate(slug)
			where not exists (select 1 from public.qorpera_company_sites site where site.slug = candidate.slug
				and not public.qorpera_site_abandoned(site))));
end $$;

-- The sites to upload, for this executor: per repository whose sites are on, whose pause after a failed upload is over,
-- whose company it holds and is not being deleted, the newest ready point (6.1 without its version), when no version of
-- its tree is ready, live or kept on the repository's site and it is not the change the pass gave up (unless it gave up
-- for the company's ten or for its names, and the company has room again or a name is free). An older point is never
-- due: a newer one makes it pointless. At most p_limit (1 to 20). Read-only.
create function public.qorpera_code_sites_due(p_owner text, p_machine_id_sha256 text, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_repository public.qorpera_code_repositories%rowtype; v_point jsonb;
	v_due jsonb := '[]'::jsonb;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_limit is null or p_limit not between 1 and 20 then
		raise exception 'Code sites limit invalid' using errcode = '22023'; end if;
	for v_repository in select repository.* from public.qorpera_code_repositories repository
		where repository.site_enabled and (repository.site_not_before is null or repository.site_not_before <= v_now)
			and exists (select 1 from public.qorpera_code_changes made
				where made.environment_id = repository.environment_id and made.owner = repository.owner
					and made.name = repository.name and made.site_state = 'made')
			and public.qorpera_code_care_holder(repository.environment_id, p_owner, p_machine_id_sha256)
			and not exists (select 1 from public.qorpera_company_deletions deletion
				where deletion.profile_id = repository.profile_id)
		order by repository.environment_id, repository.owner collate "C", repository.name collate "C"
	loop
		exit when jsonb_array_length(v_due) >= p_limit;
		v_point := public.qorpera_code_release_point(v_repository, null, false);
		-- (A change given up for the company's ten, or because every name it may take was taken, is due again once a site
		-- went: the company has room, or one of its names is free or abandoned.)
		continue when v_point is null or v_point ->> 'versionId' is not null
			or public.qorpera_code_site_given_up(v_repository, v_point);
		v_due := v_due || jsonb_build_object('companyId', v_repository.profile_id, 'environmentId', v_repository.environment_id,
			'owner', v_repository.owner, 'name', v_repository.name, 'change', (v_point ->> 'change')::integer,
			'site', v_point -> 'site');
	end loop;
	return jsonb_build_object('schema', 'qorpera.code-sites-due/v1', 'sites', v_due);
end $$;

-- An upload's first step, for row p_change of a repository: its site, made when the repository has none (also after
-- a member took it offline), and the version of the row's tree, found (in any state) or made (`uploading`, its files
-- not named yet). p_manifest, exactly: {"manifestSha256":"<64 hex>","files":<n>,"bytes":<n>}, which the pass computed
-- from the tree; files and bytes are the row's site's. A new site: kind files, the repository's own, source
-- code/<owner>/<name>, the row's site title, made for the row's agent, a new password, its name by
-- qorpera_code_site_slugs, the first free or abandoned one. One upload a site is open: a new version ends the site's
-- other uploads.
-- Answers {"schema":"qorpera.code-site-begin/v1","state":"uploading"|"ready"|"live"|"kept","versionId","slug",
-- "listed":<bool>}, or {…,"state":"refused","code":…} and then writes nothing: SITE_ROW_GONE (no such row, or it made
-- no site), SITE_TREE_DIFFERS (files or bytes not the row's, or the tree's version has another manifest), SITE_LIMIT
-- (no site yet and the company has 10), SITE_NAME_TAKEN (no name free); or {…,"state":"lost"}: the caller does not
-- hold the company, it is being deleted, or nobody registered the repository.
create function public.qorpera_code_site_begin(p_owner text, p_machine_id_sha256 text, p_environment_id uuid,
	p_repository_owner text, p_name text, p_change integer, p_manifest jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_row public.qorpera_code_changes%rowtype;
	v_site public.qorpera_company_sites%rowtype; v_version public.qorpera_company_site_versions%rowtype; v_slug text;
	v_holder public.qorpera_company_sites%rowtype; v_now timestamptz := clock_timestamp();
	c_schema constant text := 'qorpera.code-site-begin/v1';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_repository_owner is null or p_name is null or p_change is null or p_change < 1
		or jsonb_typeof(p_manifest) is distinct from 'object'
		or not p_manifest ?& array['manifestSha256','files','bytes']
		or p_manifest - array['manifestSha256','files','bytes'] <> '{}'::jsonb
		or not public.qorpera_code_json_text(p_manifest -> 'manifestSha256', '^[0-9a-f]{64}$')
		or not (public.qorpera_code_json_count(p_manifest -> 'files') and p_manifest ->> 'files' ~ '^[0-9]{1,9}$')
		or not (public.qorpera_code_json_count(p_manifest -> 'bytes') and p_manifest ->> 'bytes' ~ '^[0-9]{1,9}$') then
		raise exception 'Code site begin invalid' using errcode = '22023'; end if;
	-- The company's profile row first: a site row written below checks its key.
	perform 1 from public.qorpera_profiles profile where profile.id = (select repository.profile_id
		from public.qorpera_code_repositories repository where repository.environment_id = p_environment_id
			and repository.owner = p_repository_owner and repository.name = p_name) for key share;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name for update;
	if not found or not public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256)
		or exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = v_repository.profile_id) then
		return jsonb_build_object('schema', c_schema, 'state', 'lost'); end if;
	select * into v_row from public.qorpera_code_changes change
	where change.environment_id = p_environment_id and change.owner = p_repository_owner and change.name = p_name
		and change.n = p_change;
	if v_row.site_state is distinct from 'made' then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_ROW_GONE'); end if;
	if p_manifest -> 'files' <> v_row.site -> 'files' or p_manifest -> 'bytes' <> v_row.site -> 'bytes' then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_TREE_DIFFERS'); end if;
	if v_repository.site_id is not null then
		select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	end if;
	if v_site.id is null then
		-- The company makes one site at a time (publish_site and share_app take the same lock before they count), so
		-- the count holds until the new site is in. A code site counts from its first upload, also while it waits in
		-- What's new.
		perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.company-sites:'
			|| v_repository.profile_id::text, 0));
		if (select count(*) from public.qorpera_company_sites site where site.profile_id = v_repository.profile_id) >= 10 then
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_LIMIT'); end if;
		-- Each name in turn, never waiting on another call's lock of a site and never keeping one on a name passed over
		-- (two first uploads of two companies whose names come in opposite orders would wait on each other): a name some
		-- site has is passed over, read without a lock, unless that site is abandoned; that site is locked only when no
		-- other call holds it, and taken over only when it is still abandoned under the lock (it may have gone live
		-- meanwhile); else the lock goes at once, with the block. A name another call takes at the same moment is passed
		-- over (on conflict); the only wait here is on that call's new site of the name, and that call waits on nothing
		-- of this one's.
		foreach v_slug in array public.qorpera_code_site_slugs(p_name, v_row.site ->> 'name') loop
			select site.* into v_holder from public.qorpera_company_sites site where site.slug = v_slug;
			if found then
				continue when not public.qorpera_site_abandoned(v_holder);
				begin
					select site.* into v_holder from public.qorpera_company_sites site where site.id = v_holder.id
					for update skip locked;
					if not found or not public.qorpera_site_abandoned(v_holder) then
						raise exception 'the name''s site is held or no longer abandoned' using errcode = 'QCS01'; end if;
					delete from public.qorpera_company_sites where id = v_holder.id;
				exception when sqlstate 'QCS01' then
					continue;
				end;
			end if;
			insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path,
				created_by_staff_agent_id, code_owner, code_name)
			values (v_repository.profile_id, p_environment_id, v_slug, v_row.site ->> 'title',
				format('code/%s/%s', p_repository_owner, p_name), v_row.staff_agent_id, p_repository_owner, p_name)
			on conflict (slug) do nothing
			returning * into v_site;
			exit when v_site.id is not null;
		end loop;
		if v_site.id is null then
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_NAME_TAKEN'); end if;
		insert into public.qorpera_company_site_secrets (site_id, password) values (v_site.id, public.qorpera_site_new_password());
		update public.qorpera_code_repositories set site_id = v_site.id
		where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
	end if;
	select * into v_version from public.qorpera_company_site_versions version
	where version.site_id = v_site.id and version.tree = v_row.site ->> 'tree' for update;
	if found and (v_version.manifest_sha256 <> p_manifest ->> 'manifestSha256'
		or v_version.file_count <> (p_manifest ->> 'files')::integer
		or v_version.total_bytes <> (p_manifest ->> 'bytes')::bigint) then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_TREE_DIFFERS'); end if;
	-- One open upload a site: an upload a newer change overtook goes.
	delete from public.qorpera_company_site_versions version
	where version.site_id = v_site.id and version.state = 'uploading' and version.tree <> v_row.site ->> 'tree';
	if v_version.id is null then
		insert into public.qorpera_company_site_versions (site_id, first_publish, title, source_path, manifest_sha256,
			file_count, total_bytes, tree, change, main_sha, listed)
		values (v_site.id, v_site.current_version_id is null, v_row.site ->> 'title', v_site.source_path,
			p_manifest ->> 'manifestSha256', (p_manifest ->> 'files')::integer, (p_manifest ->> 'bytes')::bigint,
			v_row.site ->> 'tree', v_row.n, v_row.main_after, false)
		returning * into v_version;
		update public.qorpera_company_sites set updated_at = v_now where id = v_site.id;
	end if;
	return jsonb_build_object('schema', c_schema, 'state', v_version.state, 'versionId', v_version.id, 'slug', v_site.slug,
		'listed', v_version.listed);
end $$;

-- An upload's files, named in pages of at most 150: p_files exactly {"files":[{"path","bytes","sha256"}],"last":<bool>}.
-- Each file is checked as publish_site's begin checks one (a path a site holds, a type it serves, at most 10 MiB, a
-- SHA-256) and added with no bytes; a path named again with the same values is the same file. With last: the files
-- named are as many as the version's, as large, their manifest is its manifest, and index.html is among them; then
-- each file's bytes are copied from any other version of the site that has a file of the same SHA-256 and size, and
-- the version is listed. Answers {"schema":"qorpera.code-site-list/v1","state":"listing"|"listed","missing":<files with
-- no bytes>}; or {…,"state":"refused","code":"SITE_FILE_REFUSED","path":<the file>} (a file a site cannot hold, or a
-- path named before with other values), {…,"code":"SITE_MANIFEST_DIFFERS","path":null} (more files than the version
-- has, or at last another count, size or manifest, or no index.html), and then every file of the version goes, so the
-- next pass names them from the start; or {…,"state":"lost"}. A version that is listed already answers so.
create function public.qorpera_code_site_list(p_owner text, p_machine_id_sha256 text, p_version_id uuid, p_files jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_version public.qorpera_company_site_versions%rowtype;
	v_item jsonb; v_file public.qorpera_company_site_files%rowtype; v_refusal jsonb; v_count integer; v_total bigint;
	v_manifest text; c_schema constant text := 'qorpera.code-site-list/v1';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_version_id is null or jsonb_typeof(p_files) is distinct from 'object' or not p_files ?& array['files','last']
		or p_files - array['files','last'] <> '{}'::jsonb or jsonb_typeof(p_files -> 'last') is distinct from 'boolean'
		or jsonb_typeof(p_files -> 'files') is distinct from 'array' or jsonb_array_length(p_files -> 'files') > 150
		or exists (select 1 from jsonb_array_elements(p_files -> 'files') item(value)
			where case when jsonb_typeof(item.value) = 'object' then not item.value ?& array['path','bytes','sha256']
				or item.value - array['path','bytes','sha256'] <> '{}'::jsonb or jsonb_typeof(item.value -> 'path') <> 'string'
				or jsonb_typeof(item.value -> 'bytes') <> 'number' or jsonb_typeof(item.value -> 'sha256') <> 'string'
				else true end) then
		raise exception 'Code site list invalid' using errcode = '22023'; end if;
	v_repository := public.qorpera_code_site_repository(p_owner, p_machine_id_sha256, p_version_id);
	if v_repository.environment_id is not null then
		select * into v_version from public.qorpera_company_site_versions where id = p_version_id for update;
	end if;
	if v_version.id is null then return jsonb_build_object('schema', c_schema, 'state', 'lost'); end if;
	if v_version.listed or v_version.state <> 'uploading' then
		return jsonb_build_object('schema', c_schema, 'state', 'listed', 'missing', (select count(*)
			from public.qorpera_company_site_files file where file.version_id = v_version.id and file.content is null));
	end if;
	for v_item in select item.value from jsonb_array_elements(p_files -> 'files') with ordinality item(value, place)
		order by item.place loop
		if not public.qorpera_site_path_valid(v_item ->> 'path') or public.qorpera_site_content_type(v_item ->> 'path') is null
			or (case when v_item ->> 'bytes' ~ '^[0-9]{1,8}$' then (v_item ->> 'bytes')::integer > 10485760 else true end)
			or v_item ->> 'sha256' !~ '^[0-9a-f]{64}$' then
			v_refusal := jsonb_build_object('code', 'SITE_FILE_REFUSED', 'path', v_item ->> 'path');
			exit;
		end if;
		insert into public.qorpera_company_site_files (version_id, path, bytes, sha256, content_type)
		values (v_version.id, v_item ->> 'path', (v_item ->> 'bytes')::integer, v_item ->> 'sha256',
			public.qorpera_site_content_type(v_item ->> 'path'))
		on conflict (version_id, path) do nothing;
		select * into v_file from public.qorpera_company_site_files file
		where file.version_id = v_version.id and file.path = v_item ->> 'path';
		if v_file.bytes <> (v_item ->> 'bytes')::integer or v_file.sha256 <> v_item ->> 'sha256' then
			v_refusal := jsonb_build_object('code', 'SITE_FILE_REFUSED', 'path', v_item ->> 'path');
			exit;
		end if;
	end loop;
	select count(*), coalesce(sum(file.bytes), 0), encode(extensions.digest(convert_to(string_agg(file.path || chr(9)
			|| file.sha256 || chr(9) || file.bytes::text, chr(10) order by file.path collate "C"), 'utf8'), 'sha256'), 'hex')
	into v_count, v_total, v_manifest
	from public.qorpera_company_site_files file where file.version_id = v_version.id;
	if v_refusal is null and (v_count > v_version.file_count or ((p_files -> 'last')::boolean
		and (v_count <> v_version.file_count or v_total <> v_version.total_bytes
			or v_manifest is distinct from v_version.manifest_sha256
			or not exists (select 1 from public.qorpera_company_site_files file
				where file.version_id = v_version.id and file.path = 'index.html')))) then
		v_refusal := jsonb_build_object('code', 'SITE_MANIFEST_DIFFERS', 'path', null);
	end if;
	if v_refusal is not null then
		delete from public.qorpera_company_site_files where version_id = v_version.id;
		return jsonb_build_object('schema', c_schema, 'state', 'refused') || v_refusal;
	end if;
	if (p_files -> 'last')::boolean then
		-- (The match is made on the files' keys alone; only a file that matched reads its bytes, by its key.)
		update public.qorpera_company_site_files file set content = source.content
		from (select distinct on (other.sha256, other.bytes) other.sha256, other.bytes, other.version_id, other.path
				from public.qorpera_company_site_files other
				join public.qorpera_company_site_versions version on version.id = other.version_id
				where version.site_id = v_version.site_id and version.id <> v_version.id and other.content is not null
				order by other.sha256, other.bytes, other.version_id) kept
			join public.qorpera_company_site_files source on source.version_id = kept.version_id and source.path = kept.path
		where file.version_id = v_version.id and file.content is null and kept.sha256 = file.sha256
			and kept.bytes = file.bytes;
		update public.qorpera_company_site_versions set listed = true where id = v_version.id;
	end if;
	return jsonb_build_object('schema', c_schema, 'state', case when (p_files -> 'last')::boolean then 'listed'
			else 'listing' end,
		'missing', (select count(*) from public.qorpera_company_site_files file
			where file.version_id = v_version.id and file.content is null));
end $$;

-- The files of an upload that have no bytes yet, in C order after p_after (from the first when null), at most p_limit
-- (1 to 100), each with its size. Read-only. Answers {"schema":"qorpera.code-site-missing/v1","missing":[{"path",
-- "bytes"}],"more":<bool>}, or {…,"state":"lost"}.
create function public.qorpera_code_site_missing(p_owner text, p_machine_id_sha256 text, p_version_id uuid, p_after text,
	p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_missing jsonb; v_more boolean;
	c_schema constant text := 'qorpera.code-site-missing/v1';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_version_id is null or p_limit is null or p_limit not between 1 and 100 then
		raise exception 'Code site missing invalid' using errcode = '22023'; end if;
	v_repository := public.qorpera_code_site_repository(p_owner, p_machine_id_sha256, p_version_id);
	if v_repository.environment_id is null then return jsonb_build_object('schema', c_schema, 'state', 'lost'); end if;
	select coalesce(jsonb_agg(jsonb_build_object('path', due.path, 'bytes', due.bytes) order by due.path collate "C")
			filter (where due.place <= p_limit), '[]'::jsonb), coalesce(max(due.place) > p_limit, false)
	into v_missing, v_more
	from (select file.path, file.bytes, row_number() over (order by file.path collate "C") as place
		from public.qorpera_company_site_files file
		where file.version_id = p_version_id and file.content is null
			and (p_after is null or file.path collate "C" > p_after collate "C")
		order by file.path collate "C" limit p_limit + 1) due;
	return jsonb_build_object('schema', c_schema, 'missing', v_missing, 'more', v_more);
end $$;

-- An upload's bytes, in parts: p_parts exactly {"parts":[{"path","part":<0-based>,"of":<1 to 128>,"contentBase64"}]},
-- 1 to 500 parts of at most 128 KiB each. Each part is kept; a part sent again is the same part (the first is kept).
-- When a file has all its parts they are joined in order, checked against its size and SHA-256, written, and deleted.
-- A file whose bytes are there already takes no part. Answers {"schema":"qorpera.code-site-put/v1","state":"kept",
-- "filed":<files this call completed>}; or {…,"state":"refused","code":"SITE_FILE_DIFFERS","path":<the file>}: no such
-- file in the version, a part that counts the file's parts otherwise than those kept, more bytes than the file has, or
-- a joined file of another size or SHA-256. That file's parts go, and the call stops there (files it completed before
-- stay). A version that is not uploading answers kept with nothing filed; one that is gone answers lost.
create function public.qorpera_code_site_put(p_owner text, p_machine_id_sha256 text, p_version_id uuid, p_parts jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_version public.qorpera_company_site_versions%rowtype;
	v_item jsonb; v_file public.qorpera_company_site_files%rowtype; v_content bytea; v_part integer; v_of integer;
	v_have integer; v_size bigint; v_filed integer := 0; c_schema constant text := 'qorpera.code-site-put/v1';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_version_id is null or jsonb_typeof(p_parts) is distinct from 'object' or not p_parts ? 'parts'
		or p_parts - 'parts' <> '{}'::jsonb or jsonb_typeof(p_parts -> 'parts') is distinct from 'array'
		or jsonb_array_length(p_parts -> 'parts') not between 1 and 500
		or exists (select 1 from jsonb_array_elements(p_parts -> 'parts') item(value)
			where case when jsonb_typeof(item.value) = 'object' then not item.value ?& array['path','part','of','contentBase64']
				or item.value - array['path','part','of','contentBase64'] <> '{}'::jsonb
				or jsonb_typeof(item.value -> 'path') <> 'string' or jsonb_typeof(item.value -> 'contentBase64') <> 'string'
				or not (public.qorpera_code_json_count(item.value -> 'part') and item.value ->> 'part' ~ '^[0-9]{1,3}$')
				or not (public.qorpera_code_json_count(item.value -> 'of') and item.value ->> 'of' ~ '^[0-9]{1,3}$')
				or case when item.value ->> 'part' ~ '^[0-9]{1,3}$' and item.value ->> 'of' ~ '^[0-9]{1,3}$'
					then (item.value ->> 'of')::integer not between 1 and 128
						or (item.value ->> 'part')::integer >= (item.value ->> 'of')::integer
					else true end
				else true end) then
		raise exception 'Code site put invalid' using errcode = '22023'; end if;
	v_repository := public.qorpera_code_site_repository(p_owner, p_machine_id_sha256, p_version_id);
	if v_repository.environment_id is not null then
		select * into v_version from public.qorpera_company_site_versions where id = p_version_id for update;
	end if;
	if v_version.id is null then return jsonb_build_object('schema', c_schema, 'state', 'lost'); end if;
	if v_version.state <> 'uploading' then
		return jsonb_build_object('schema', c_schema, 'state', 'kept', 'filed', 0); end if;
	for v_item in select item.value from jsonb_array_elements(p_parts -> 'parts') with ordinality item(value, place)
		order by item.place loop
		begin
			v_content := decode(v_item ->> 'contentBase64', 'base64');
		exception when others then
			raise exception 'Code site put invalid' using errcode = '22023';
		end;
		if octet_length(v_content) > 131072 then raise exception 'Code site put invalid' using errcode = '22023'; end if;
		v_part := (v_item ->> 'part')::integer;
		v_of := (v_item ->> 'of')::integer;
		v_file := null;
		select * into v_file from public.qorpera_company_site_files file
		where file.version_id = v_version.id and file.path = v_item ->> 'path';
		if v_file.path is null then
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_FILE_DIFFERS',
				'path', v_item ->> 'path'); end if;
		continue when v_file.content is not null;
		if not exists (select 1 from public.qorpera_company_site_file_parts kept
			where kept.version_id = v_version.id and kept.path = v_file.path and kept.of <> v_of) then
			insert into public.qorpera_company_site_file_parts (version_id, path, part, of, content)
			values (v_version.id, v_file.path, v_part, v_of, v_content)
			on conflict (version_id, path, part) do nothing;
			select count(*), coalesce(sum(octet_length(kept.content)), 0) into v_have, v_size
			from public.qorpera_company_site_file_parts kept where kept.version_id = v_version.id and kept.path = v_file.path;
		end if;
		if v_have is null or v_size > v_file.bytes then
			delete from public.qorpera_company_site_file_parts kept where kept.version_id = v_version.id and kept.path = v_file.path;
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_FILE_DIFFERS', 'path', v_file.path);
		end if;
		if v_have = v_of then
			select string_agg(kept.content, ''::bytea order by kept.part) into v_content
			from public.qorpera_company_site_file_parts kept where kept.version_id = v_version.id and kept.path = v_file.path;
			delete from public.qorpera_company_site_file_parts kept where kept.version_id = v_version.id and kept.path = v_file.path;
			if octet_length(v_content) <> v_file.bytes or encode(extensions.digest(v_content, 'sha256'), 'hex') <> v_file.sha256 then
				return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_FILE_DIFFERS', 'path', v_file.path);
			end if;
			update public.qorpera_company_site_files file set content = v_content
			where file.version_id = v_version.id and file.path = v_file.path;
			v_filed := v_filed + 1;
		end if;
		v_have := null; v_size := null;
	end loop;
	return jsonb_build_object('schema', c_schema, 'state', 'kept', 'filed', v_filed);
end $$;

-- An upload's last step: a listed uploading version with every file's bytes becomes ready; the repository's failed
-- uploads are forgotten (the change it gave up too) and its list is written again; then the site is pruned (qorpera_code_site_prune). Answers
-- {"schema":"qorpera.code-site-finish/v1","state":"ready","pruned":<versions deleted>}; {…,"state":"refused",
-- "code":"SITE_UPLOAD_INCOMPLETE"} when a file has no bytes yet or the version is not listed; a version that is not
-- uploading as it stands ({…,"state":"ready"|"live"|"kept","pruned":0}); or {…,"state":"lost"}.
create function public.qorpera_code_site_finish(p_owner text, p_machine_id_sha256 text, p_version_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_version public.qorpera_company_site_versions%rowtype;
	v_pruned integer; c_schema constant text := 'qorpera.code-site-finish/v1';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_version_id is null then raise exception 'Code site finish invalid' using errcode = '22023'; end if;
	v_repository := public.qorpera_code_site_repository(p_owner, p_machine_id_sha256, p_version_id);
	if v_repository.environment_id is not null then
		perform 1 from public.qorpera_code_repositories repository where repository.environment_id = v_repository.environment_id
			and repository.owner = v_repository.owner and repository.name = v_repository.name for update;
		perform 1 from public.qorpera_company_sites site where site.id = v_repository.site_id for update;
		select * into v_version from public.qorpera_company_site_versions where id = p_version_id for update;
	end if;
	if v_version.id is null then return jsonb_build_object('schema', c_schema, 'state', 'lost'); end if;
	if v_version.state <> 'uploading' then
		return jsonb_build_object('schema', c_schema, 'state', v_version.state, 'pruned', 0); end if;
	if not v_version.listed or exists (select 1 from public.qorpera_company_site_files file
		where file.version_id = v_version.id and file.content is null) then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_UPLOAD_INCOMPLETE'); end if;
	update public.qorpera_company_site_versions set state = 'ready' where id = v_version.id;
	update public.qorpera_code_repositories set site_attempts = 0, site_change = null, site_not_before = null,
		site_problem = null, site_given_up = null, index_version = index_version + 1
	where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
	v_pruned := public.qorpera_code_site_prune(v_version.site_id);
	return jsonb_build_object('schema', c_schema, 'state', 'ready', 'pruned', v_pruned);
end $$;

-- An upload that failed, with its code (the read's, a refused value's, or SITE_UPLOAD_FAILED for a call that did not
-- answer): the repository's problem; its failures in a row of change p_change (one for another change), and a pause of
-- 2^failures seconds, at most 10 minutes; the fifth of the same change gives that change up (no pass tries it again,
-- but for SITE_LIMIT or SITE_NAME_TAKEN once a site went, and after a member took the site offline) and writes the list
-- again. Answers {"schema":"qorpera.code-site-failed/v1","state":"recorded"}, or {…,"state":"lost"}.
create function public.qorpera_code_site_failed(p_owner text, p_machine_id_sha256 text, p_environment_id uuid,
	p_repository_owner text, p_name text, p_change integer, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_attempts integer;
	c_schema constant text := 'qorpera.code-site-failed/v1';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_repository_owner is null or p_name is null or p_change is null or p_change < 1
		or coalesce(p_code, '') !~ '^[A-Z0-9_:]{1,120}$' then
		raise exception 'Code site failure invalid' using errcode = '22023'; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name for update;
	if not found or not public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256)
		or exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = v_repository.profile_id) then
		return jsonb_build_object('schema', c_schema, 'state', 'lost'); end if;
	v_attempts := case when v_repository.site_change = p_change then v_repository.site_attempts + 1 else 1 end;
	update public.qorpera_code_repositories set site_problem = p_code, site_attempts = v_attempts, site_change = p_change,
		site_not_before = clock_timestamp() + least(make_interval(secs => power(2, least(v_attempts, 10))), interval '10 minutes'),
		site_given_up = case when v_attempts >= 5 then p_change else site_given_up end,
		index_version = index_version + case when v_attempts = 5 then 1 else 0 end
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
	return jsonb_build_object('schema', c_schema, 'state', 'recorded');
end $$;

-- 4. The member's calls ------------------------------------------------------------------------------------------------

-- Puts version p_version_id of a code site live, under the site's lock: the version live until now is kept for Go
-- back, the new one is live, and the site serves it from the visitor's next request (its sessions stay).
create function public.qorpera_code_release_switch(p_site_id uuid, p_version_id uuid)
returns void language plpgsql volatile set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
	update public.qorpera_company_site_versions set state = 'kept'
	where site_id = p_site_id and state = 'live' and id <> p_version_id;
	update public.qorpera_company_site_versions set state = 'live', published_at = v_now where id = p_version_id;
	update public.qorpera_company_sites set current_version_id = p_version_id,
		title = (select version.title from public.qorpera_company_site_versions version where version.id = p_version_id),
		published_at = v_now, published_by_user_id = auth.uid(), published_by_staff_agent_id = null, updated_at = v_now
	where id = p_site_id;
end $$;

-- The company's repositories with a site, for any member (viewers too): each with what is live, what Go back would put
-- live, what is ready to go live (the ready point, 6.1: its token, and its changes as the page shows them), how many
-- changes are not ready yet, and the problem of the last upload that failed, with givenUp: true while no upload pass
-- tries again (qorpera_code_site_given_up), false otherwise and whenever problem is null. canRelease says whether the
-- caller (an owner or admin) may put a version live or go back. Read-only.
-- {"schema":"qorpera.code-releases/v1","canRelease":<bool>,"sites":[{"owner","name",
--  "site":{"slug","url","title"}|null,
--  "live":{"version","kind":"release"|"back","since","by":"<userId>","from":<the version a back took off>|null}|null,
--  "back":{"version"}|null,
--  "ready":{"change","token","agent":"<staff agent id>"|null,"changes":[{"key":<n>,"notice","picture":"<path>"|null,
--   "at","wasLive":<bool>}],"quiet":<held changes not listed>}|null,
--  "waiting":<n>,"problem":"<CODE>"|null,"givenUp":<bool>}]}
-- A repository is listed when it has a site or made one: at most 10, every one with a site first (live, then not),
-- then those with none, a problem first, the newest first. A listed change has a notice
-- (newest first, at most 20); picture is the copy of a commit's picture under changes/, or the folder file an agent
-- gave; wasLive says it was in a release a Go back took off. waiting counts the landed changes above the ready point
-- (above the live one when nothing is ready).
create function public.qorpera_list_code_releases(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_repository public.qorpera_code_repositories%rowtype; v_site public.qorpera_company_sites%rowtype;
	v_live public.qorpera_code_releases%rowtype; v_prior public.qorpera_code_releases%rowtype; v_point jsonb;
	v_sites jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null then
		raise exception 'Releases unavailable' using errcode = '42501'; end if;
	-- At most ten, chosen by what a member can act on: every repository with a site (a company has at most ten sites),
	-- the live ones first; then those that made a site and have none now (never uploaded, or taken offline), a problem
	-- first, the newest change first. A repository's history never hides a site.
	for v_repository in select repository.* from public.qorpera_code_repositories repository
		join public.qorpera_company_files file on file.environment_id = repository.environment_id
			and file.profile_id = p_profile_id and file.core = 'folder-v2'
		left join public.qorpera_company_sites site on site.id = repository.site_id
		left join lateral (select made.created_at from public.qorpera_code_changes made
			where made.environment_id = repository.environment_id and made.owner = repository.owner
				and made.name = repository.name and made.site_state = 'made'
			order by made.n desc limit 1) newest on true
		where repository.profile_id = p_profile_id and (site.id is not null or newest.created_at is not null)
		order by case when site.current_version_id is not null then 0 when site.id is not null then 1 else 2 end,
			case when site.id is null then repository.site_problem is null end,
			case when site.id is null then newest.created_at end desc,
			repository.owner collate "C", repository.name collate "C"
		limit 10
	loop
		v_site := null; v_prior := null;
		select * into v_site from public.qorpera_company_sites where id = v_repository.site_id;
		v_live := public.qorpera_code_release_live(v_repository);
		if v_live.prior is not null then
			select * into v_prior from public.qorpera_code_releases release
			where release.environment_id = v_repository.environment_id and release.owner = v_repository.owner
				and release.name = v_repository.name and release.n = v_live.prior and release.version_id is not null;
		end if;
		v_point := public.qorpera_code_release_point(v_repository);
		v_sites := v_sites || jsonb_build_object('owner', v_repository.owner, 'name', v_repository.name,
			'site', case when v_site.id is not null then jsonb_build_object('slug', v_site.slug,
				'url', public.qorpera_site_url(v_site.slug), 'title', v_site.title) end,
			'live', case when v_live.n is not null then jsonb_build_object('version', v_live.version, 'kind', v_live.kind,
				'since', v_live.created_at, 'by', v_live.by_user_id,
				'from', case when v_live.kind = 'back' then (select replaced.version from public.qorpera_code_releases replaced
					where replaced.environment_id = v_repository.environment_id and replaced.owner = v_repository.owner
						and replaced.name = v_repository.name and replaced.n = v_live.replaces) end) end,
			'back', case when v_prior.n is not null then jsonb_build_object('version', v_prior.version) end,
			'ready', case when v_point is not null then jsonb_build_object('change', v_point -> 'change',
				'token', v_point -> 'token', 'agent', v_point -> 'agent',
				'changes', (select coalesce(jsonb_agg(jsonb_build_object('key', listed.n, 'notice', listed.notice,
						'picture', case listed.picture ->> 'source' when 'commit' then listed.picture ->> 'at'
							when 'folder' then listed.picture ->> 'path' end,
						'at', listed.created_at,
						'wasLive', exists (select 1 from public.qorpera_code_releases release
							where release.environment_id = v_repository.environment_id and release.owner = v_repository.owner
								and release.name = v_repository.name and listed.n = any(release.changes)))
						order by listed.n desc), '[]'::jsonb)
					from public.qorpera_code_changes listed
					where listed.environment_id = v_repository.environment_id and listed.owner = v_repository.owner
						and listed.name = v_repository.name
						and listed.n in (select item::integer from jsonb_array_elements_text(v_point -> 'listed') item)),
				'quiet', (v_point ->> 'count')::integer - jsonb_array_length(v_point -> 'listed')) end,
			'waiting', (select count(*) from public.qorpera_code_changes waiting
				where waiting.environment_id = v_repository.environment_id and waiting.owner = v_repository.owner
					and waiting.name = v_repository.name and waiting.state = 'landed'
					and waiting.kind in ('landing','undo','restore')
					and waiting.n > coalesce((v_point ->> 'change')::integer, v_live.change, 0)),
			'problem', v_repository.site_problem,
			'givenUp', case when v_repository.site_problem is not null and v_repository.site_given_up is not null
				then public.qorpera_code_site_given_up(v_repository) else false end);
	end loop;
	return jsonb_build_object('schema', 'qorpera.code-releases/v1', 'canRelease', v_role in ('owner','admin'),
		'sites', v_sites);
end $$;

-- An owner or admin puts live what the page showed (6.2): p_shown exactly {"live":<the live version's number, null
-- when nothing is live>,"change":<the ready point>,"token":"<its token>"}. Under the registry row's lock: the live
-- version is still that one, and the change is still a ready point with that token (a newer one is no reason to
-- refuse: what was shown goes live, and the newer changes wait); else nothing is written and the answer is moved. A
-- release row takes the next number and the next version number founders see; the version goes live in place of the
-- one before, which is kept for Go back; the list file is written again. Answers
-- {"schema":"qorpera.code-release/v1","state":"live","version":<n>,"url":"<the site's link>"}, or {…,"state":"moved"}.
-- 42501 for anyone but an owner or admin, P0002 for a repository the company does not keep, 55P03 after 3 s of
-- waiting for the lock (an upload's finish holds it).
create function public.qorpera_put_code_release_live(p_profile_id uuid, p_owner text, p_name text, p_shown jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_repository public.qorpera_code_repositories%rowtype; v_live public.qorpera_code_releases%rowtype; v_point jsonb;
	v_site public.qorpera_company_sites%rowtype; v_version public.qorpera_company_site_versions%rowtype; v_n integer;
	c_moved constant jsonb := '{"schema":"qorpera.code-release/v1","state":"moved"}';
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null
		or v_role not in ('owner','admin') then
		raise exception 'Releases unavailable' using errcode = '42501'; end if;
	if p_owner is null or p_name is null or jsonb_typeof(p_shown) is distinct from 'object'
		or not p_shown ?& array['live','change','token'] or p_shown - array['live','change','token'] <> '{}'::jsonb
		or not (p_shown -> 'live' = 'null'::jsonb or (public.qorpera_code_json_count(p_shown -> 'live')
			and p_shown ->> 'live' ~ '^[1-9][0-9]{0,8}$'))
		or not (public.qorpera_code_json_count(p_shown -> 'change') and p_shown ->> 'change' ~ '^[1-9][0-9]{0,8}$')
		or not public.qorpera_code_json_text(p_shown -> 'token', '^[0-9a-f]{64}$') then
		raise exception 'Release request is invalid' using errcode = '22023'; end if;
	-- The company's profile row first: the release row checks its key.
	perform 1 from public.qorpera_profiles profile where profile.id = p_profile_id for key share;
	select repository.* into v_repository from public.qorpera_code_repositories repository
	join public.qorpera_company_files file on file.environment_id = repository.environment_id
		and file.profile_id = p_profile_id and file.core = 'folder-v2'
	where repository.profile_id = p_profile_id and repository.owner = p_owner and repository.name = p_name
	for update of repository;
	if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
	v_live := public.qorpera_code_release_live(v_repository);
	if v_live.version is distinct from (p_shown ->> 'live')::integer then return c_moved; end if;
	v_point := public.qorpera_code_release_point(v_repository, (p_shown ->> 'change')::integer);
	if v_point is null or v_point ->> 'token' is distinct from p_shown ->> 'token' then return c_moved; end if;
	select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	select * into v_version from public.qorpera_company_site_versions
	where id = (v_point ->> 'versionId')::uuid and site_id = v_site.id for update;
	if v_version.id is null then return c_moved; end if;
	v_n := v_repository.last_release + 1;
	insert into public.qorpera_code_releases (environment_id, owner, name, n, profile_id, kind, version, change, main_sha,
		tree, version_id, replaces, prior, changes, shown_sha256, by_user_id)
	values (v_repository.environment_id, v_repository.owner, v_repository.name, v_n, v_repository.profile_id, 'release',
		v_repository.last_version + 1, (v_point ->> 'change')::integer, v_point ->> 'mainSha', v_point ->> 'tree',
		v_version.id, v_live.n, v_live.n,
		array(select held.n::integer from jsonb_array_elements_text(v_point -> 'held') with ordinality held(n, place)
			order by held.place),
		v_point ->> 'token', auth.uid());
	perform public.qorpera_code_release_switch(v_site.id, v_version.id);
	update public.qorpera_code_repositories set last_release = v_n, live_release = v_n, last_version = last_version + 1,
		index_version = index_version + 1
	where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
	return jsonb_build_object('schema', 'qorpera.code-release/v1', 'state', 'live', 'version', v_repository.last_version + 1,
		'url', public.qorpera_site_url(v_site.slug));
end $$;

-- An owner or admin goes back to the version that was live before (6.3): p_shown exactly {"live":<the live version's
-- number>,"to":<the version Go back names>}. Under the registry row's lock: the live release is still that version,
-- the release before it on the chain (its prior) still has its version, and that version's number is `to`; else
-- moved. A release row of kind back shows that number again, with that release's change, commit, tree and version;
-- the next Go back goes one further down the chain. The changes of the version it took off are ready again. Answers
-- as qorpera_put_code_release_live.
create function public.qorpera_code_release_back(p_profile_id uuid, p_owner text, p_name text, p_shown jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_repository public.qorpera_code_repositories%rowtype; v_live public.qorpera_code_releases%rowtype;
	v_prior public.qorpera_code_releases%rowtype; v_site public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype; v_n integer;
	c_moved constant jsonb := '{"schema":"qorpera.code-release/v1","state":"moved"}';
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null
		or v_role not in ('owner','admin') then
		raise exception 'Releases unavailable' using errcode = '42501'; end if;
	if p_owner is null or p_name is null or jsonb_typeof(p_shown) is distinct from 'object'
		or not p_shown ?& array['live','to'] or p_shown - array['live','to'] <> '{}'::jsonb
		or not (public.qorpera_code_json_count(p_shown -> 'live') and p_shown ->> 'live' ~ '^[1-9][0-9]{0,8}$')
		or not (public.qorpera_code_json_count(p_shown -> 'to') and p_shown ->> 'to' ~ '^[1-9][0-9]{0,8}$') then
		raise exception 'Release request is invalid' using errcode = '22023'; end if;
	-- The company's profile row first: the release row checks its key.
	perform 1 from public.qorpera_profiles profile where profile.id = p_profile_id for key share;
	select repository.* into v_repository from public.qorpera_code_repositories repository
	join public.qorpera_company_files file on file.environment_id = repository.environment_id
		and file.profile_id = p_profile_id and file.core = 'folder-v2'
	where repository.profile_id = p_profile_id and repository.owner = p_owner and repository.name = p_name
	for update of repository;
	if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
	v_live := public.qorpera_code_release_live(v_repository);
	if v_live.n is null or v_live.version <> (p_shown ->> 'live')::integer then return c_moved; end if;
	select * into v_prior from public.qorpera_code_releases release
	where release.environment_id = v_repository.environment_id and release.owner = v_repository.owner
		and release.name = v_repository.name and release.n = v_live.prior;
	if v_prior.version_id is null or v_prior.version <> (p_shown ->> 'to')::integer then return c_moved; end if;
	select * into v_site from public.qorpera_company_sites where id = v_repository.site_id for update;
	select * into v_version from public.qorpera_company_site_versions
	where id = v_prior.version_id and site_id = v_site.id for update;
	if v_version.id is null then return c_moved; end if;
	v_n := v_repository.last_release + 1;
	insert into public.qorpera_code_releases (environment_id, owner, name, n, profile_id, kind, version, change, main_sha,
		tree, version_id, replaces, prior, by_user_id)
	values (v_repository.environment_id, v_repository.owner, v_repository.name, v_n, v_repository.profile_id, 'back',
		v_prior.version, v_prior.change, v_prior.main_sha, v_prior.tree, v_version.id, v_live.n, v_prior.prior, auth.uid());
	perform public.qorpera_code_release_switch(v_site.id, v_version.id);
	update public.qorpera_code_repositories set last_release = v_n, live_release = v_n, index_version = index_version + 1
	where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
	return jsonb_build_object('schema', 'qorpera.code-release/v1', 'state', 'live', 'version', v_prior.version,
		'url', public.qorpera_site_url(v_site.slug));
end $$;

-- 5. Existing functions of the code ------------------------------------------------------------------------------------

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.code_releases_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930729000' in v_definition) > 0 then
		raise exception '20260930729000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930729000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- The switch says whether the repository's site is made too.
select pg_temp.code_releases_patch('public.qorpera_code_checks_switch(uuid,uuid)'::regprocedure, array[
	$old$			and repository.name = v_session.repository ->> 'name'), true));$old$,
	$new$			and repository.name = v_session.repository ->> 'name'), true),
		-- 20260930729000: and whether the site of a change whose checks passed is kept: the registry's switch, on when
		-- the repository has no row.
		'site', coalesce((select repository.site_enabled from public.qorpera_code_repositories repository
			where repository.environment_id = v_session.environment_id and repository.owner = v_session.repository ->> 'owner'
				and repository.name = v_session.repository ->> 'name'), true));$new$]);

-- A report may say what became of the site: v3.
select pg_temp.code_releases_patch('public.qorpera_code_change_report_valid(jsonb)'::regprocedure, array[
	$old$			'pathsMore','picture','refusal','checks'] = '{}'::jsonb
		and case p_change -> 'schema' when '"qorpera.code-change-report/v1"'::jsonb then not (p_change ? 'checks')
			when '"qorpera.code-change-report/v2"'::jsonb then public.qorpera_code_change_checks_valid(p_change)
			else false end$old$,
	$new$			'pathsMore','picture','refusal','checks','site'] = '{}'::jsonb
		-- 20260930729000: v3 is v2 with what became of the site (site), as its state and its checks ask.
		and case p_change -> 'schema' when '"qorpera.code-change-report/v1"'::jsonb then not (p_change ? 'checks')
				and not (p_change ? 'site')
			when '"qorpera.code-change-report/v2"'::jsonb then public.qorpera_code_change_checks_valid(p_change)
				and not (p_change ? 'site')
			when '"qorpera.code-change-report/v3"'::jsonb then public.qorpera_code_change_checks_valid(p_change)
				and public.qorpera_code_change_site_valid(p_change)
			else false end$new$]);

-- The row a report appends, or the filler a turn takes over, keeps what became of the site.
select pg_temp.code_releases_patch('public.qorpera_record_code_change(uuid,uuid,jsonb)'::regprocedure, array[
	$old$		'checks_state', p_change -> 'checks' ->> 'state', 'checks', p_change -> 'checks' -> 'result');$old$,
	$new$		'checks_state', p_change -> 'checks' ->> 'state', 'checks', p_change -> 'checks' -> 'result',
		-- 20260930729000: the site the checks left, or why Qorpera could not keep it, from a v3 report of a passed
		-- landing (none from v1 or v2, or another state).
		'site_state', p_change -> 'site' ->> 'state', 'site', p_change -> 'site' -> 'site',
		'site_problem', p_change -> 'site' ->> 'code');$new$,
	$old$			checks_state = p_change -> 'checks' ->> 'state', checks = p_change -> 'checks' -> 'result',$old$,
	$new$			checks_state = p_change -> 'checks' ->> 'state', checks = p_change -> 'checks' -> 'result',
			-- 20260930729000: and what became of the site, as the report says (none from v1 or v2).
			site_state = p_change -> 'site' ->> 'state', site = p_change -> 'site' -> 'site',
			site_problem = p_change -> 'site' ->> 'code',$new$]);

-- An undo that inherits its checks inherits the site the same row's checks left.
select pg_temp.code_releases_patch('public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$				(checks_state, checks) = (select case when kept.n is null then 'not_run' else 'inherited' end,$old$,
	$new$				(checks_state, checks, site_state, site, site_problem) = (select case when kept.n is null then 'not_run'
						else 'inherited' end,$new$,
	$old$						case when kept.n is not null then jsonb_build_object('schema', 'qorpera.code-checks/v1', 'as', kept.n) end$old$,
	$new$						case when kept.n is not null then jsonb_build_object('schema', 'qorpera.code-checks/v1', 'as', kept.n) end,
						-- 20260930729000: main has that row's files, so its site is the site of this row's files too.
						inherited.site_state, inherited.site, inherited.site_problem$new$,
	$old$							and back.main_after = v_request.progress -> 'begun' ->> 'mainBefore') kept)$old$,
	$new$							and back.main_after = v_request.progress -> 'begun' ->> 'mainBefore') kept
					left join public.qorpera_code_changes inherited on inherited.environment_id = v_repository.environment_id
						and inherited.owner = v_repository.owner and inherited.name = v_repository.name
						and inherited.n = kept.n)$new$]);

-- A restore that inherits its checks inherits the site the same row's checks left.
select pg_temp.code_releases_patch('public.qorpera_code_restore_record(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$						jsonb_build_object('schema', 'qorpera.code-checks/v1', 'as', kept.n))$old$,
	$new$						jsonb_build_object('schema', 'qorpera.code-checks/v1', 'as', kept.n),
						-- 20260930729000: and the site that row's checks left (the restored main has its files).
						'site_state', kept.site_state, 'site', kept.site, 'site_problem', kept.site_problem)$new$]);

-- The list file says what is live and what is ready.
select pg_temp.code_releases_patch('public.qorpera_code_change_files(text,text,uuid,text,text,integer)'::regprocedure, array[
	$old$				'line', coalesce(line.notice, line.title)) order by line.n desc), '[]'::jsonb)) into v_index$old$,
	$new$				'line', coalesce(line.notice, line.title)) order by line.n desc), '[]'::jsonb))
				-- 20260930729000: what of the repository's site is live and what is ready, when it has a site or made one.
				|| public.qorpera_code_release_index(v_repository) into v_index$new$]);

-- The platform's line on a landing says whether Qorpera keeps its site for What's new.
select pg_temp.code_releases_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure, array[
	$old$					when 'off' then ' Checks are switched off for this repository, so nothing checked this change.' end
				from public.qorpera_code_changes change
				where change.worker_id = v_worker.id and change.sequence = v_worker.sequence and change.state = 'landed'), '');$old$,
	$new$					when 'off' then ' Checks are switched off for this repository, so nothing checked this change.' end
				from public.qorpera_code_changes change
				where change.worker_id = v_worker.id and change.sequence = v_worker.sequence and change.state = 'landed'), '')
			-- 20260930729000: whether Qorpera keeps the site the checks left, for a member to put live on What's new.
			|| coalesce((select case change.site_state
					when 'made' then ' Qorpera keeps its site for What''s new, where a member puts it live.'
					when 'missed' then ' Qorpera could not keep its site this time (' || change.site_problem
						|| '); the next change that goes in keeps one.' end
				from public.qorpera_code_changes change
				where change.worker_id = v_worker.id and change.sequence = v_worker.sequence and change.state = 'landed'), '');$new$]);

-- A site the code made wrong fails the turn as a failed check does: the executor's words, its code, and a round.
select pg_temp.code_releases_patch('public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure, array[
	$old$	elsif substring(p_summary from '\[code=(CODING_CHECKS_[A-Z_]{1,40})\]\s*$') in ('CODING_CHECKS_FAILED',
		'CODING_CHECKS_REFUSED', 'CODING_CHECKS_DID_NOT_RUN', 'CODING_CHECKS_MAIN_MOVED') then$old$,
	$new$	-- 20260930729000: the site the checks left was refused (CODING_CHECKS_SITE_REFUSED): the code's fault, as a failed
	-- check is, so a round too.
	elsif substring(p_summary from '\[code=(CODING_CHECKS_[A-Z_]{1,40})\]\s*$') in ('CODING_CHECKS_FAILED',
		'CODING_CHECKS_REFUSED', 'CODING_CHECKS_DID_NOT_RUN', 'CODING_CHECKS_MAIN_MOVED', 'CODING_CHECKS_SITE_REFUSED') then$new$,
	$old$		if v_code in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED') then$old$,
	$new$		if v_code in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED', 'CODING_CHECKS_SITE_REFUSED') then$new$,
	$old$				and turn.outcome ->> 'reason' in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED')$old$,
	$new$				and turn.outcome ->> 'reason' in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED', 'CODING_CHECKS_SITE_REFUSED')$new$,
	$old$						and coalesce(other.outcome ->> 'reason', '') not in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED',
							'CODING_CHECKS_DID_NOT_RUN', 'CODING_CHECKS_MAIN_MOVED')), 0);$old$,
	$new$						and coalesce(other.outcome ->> 'reason', '') not in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED',
							'CODING_CHECKS_DID_NOT_RUN', 'CODING_CHECKS_MAIN_MOVED', 'CODING_CHECKS_SITE_REFUSED')), 0);$new$]);

-- 6. Existing functions of the sites -----------------------------------------------------------------------------------

-- publish_site never takes a repository's site, never publishes a folder under code/, and counts a code site that
-- waits in What's new among the ten.
select pg_temp.code_releases_patch('public.qorpera_site_publish_check(jsonb,text)'::regprocedure, array[
	$old$	if found and v_site.profile_id = v_run.profile_id and v_site.kind = 'app' then
		raise exception 'SITE_NAME_TAKEN: an app link of the company has this name; choose another' using errcode = '55000'; end if;$old$,
	$new$	if found and v_site.profile_id = v_run.profile_id and v_site.kind = 'app' then
		raise exception 'SITE_NAME_TAKEN: an app link of the company has this name; choose another' using errcode = '55000'; end if;
	-- 20260930729000: a site made from a repository goes live only from What's new, on a member's yes.
	if found and v_site.profile_id = v_run.profile_id and v_site.code_owner is not null then
		raise exception 'SITE_FROM_CODE: this site is made from code kept in Qorpera; a member puts it live in What''s new'
			using errcode = '55000'; end if;$new$,
	$old$		raise exception 'SITE_LIMIT: the company has 10 sites, as many as it can have; update or unpublish one first'$old$,
	$new$		raise exception 'SITE_LIMIT: the company has 10 sites, counting a project''s site that waits in What''s new; update or unpublish one first'$new$]);

select pg_temp.code_releases_patch('public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)'::regprocedure, array[
	$old$	-- The site, locked for the rest of the publish.$old$,
	$new$	-- 20260930729000: the company makes one site at a time (a repository's site at its first upload takes the same
	-- lock before it counts), so the count of its ten below holds until the new site is in.
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.company-sites:' || v_run.profile_id::text, 0));
	-- The site, locked for the rest of the publish.$new$,
	$old$		or char_length(v_source) not between 1 and 4096 or v_source ~ '[[:cntrl:]]' then
		raise exception 'Site publish request is invalid' using errcode = '22023'; end if;$old$,
	$new$		or char_length(v_source) not between 1 and 4096 or v_source ~ '[[:cntrl:]]' then
		raise exception 'Site publish request is invalid' using errcode = '22023'; end if;
	-- 20260930729000: a repository kept in Qorpera goes live only through What's new, never from its folder.
	if lower(split_part(ltrim(v_source, '/'), '/', 1)) = 'code' then
		raise exception 'SITE_FROM_CODE: source must not be under code/: a repository kept in Qorpera goes live only through What''s new, on a member''s yes'
			using errcode = '22023'; end if;$new$,
	$old$	if v_site.kind = 'app' then
		raise exception 'SITE_NAME_TAKEN: an app link of the company has this name; choose another' using errcode = '55000'; end if;$old$,
	$new$	if v_site.kind = 'app' then
		raise exception 'SITE_NAME_TAKEN: an app link of the company has this name; choose another' using errcode = '55000'; end if;
	-- 20260930729000: a site made from a repository goes live only from What's new, on a member's yes.
	if v_site.code_owner is not null then
		raise exception 'SITE_FROM_CODE: this site is made from code kept in Qorpera; a member puts it live in What''s new'
			using errcode = '55000'; end if;$new$,
	$old$		raise exception 'SITE_LIMIT: the company has 10 sites, as many as it can have; update or unpublish one first'$old$,
	$new$		raise exception 'SITE_LIMIT: the company has 10 sites, counting a project''s site that waits in What''s new; update or unpublish one first'$new$]);

-- share_app makes a site as publish_site does: one at a time in the company.
select pg_temp.code_releases_patch('public.qorpera_site_share_app(jsonb,text,jsonb,uuid)'::regprocedure, array[
	$old$	-- The site, locked for the rest of the share.$old$,
	$new$	-- 20260930729000: the company makes one site at a time (publish_site and a repository's first upload take the same
	-- lock before they count), so the count of its ten below holds until the new site is in.
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.company-sites:' || v_run.profile_id::text, 0));
	-- The site, locked for the rest of the share.$new$]);

-- An agent never takes a repository's site offline; a member does, in Sites.
select pg_temp.code_releases_patch('public.qorpera_site_unpublish(jsonb,text)'::regprocedure, array[
	$old$	with removed as (delete from public.qorpera_company_sites as site where site.slug = p_slug and site.profile_id = v_run.profile_id$old$,
	$new$	-- 20260930729000: a site made from a repository is taken offline only by a member, in Sites: never deleted here.
	with removed as (delete from public.qorpera_company_sites as site where site.slug = p_slug and site.profile_id = v_run.profile_id
		and site.code_owner is null$new$,
	$old$	select exists (select 1 from removed) into v_removed;$old$,
	$new$	select exists (select 1 from removed) into v_removed;
	-- 20260930729000: nothing went, and the name is the company's code site (seen locked, as it stands then): refused.
	if not v_removed then
		perform 1 from public.qorpera_company_sites as site where site.slug = p_slug and site.profile_id = v_run.profile_id
			and site.code_owner is not null for update;
		if found then
			raise exception 'SITE_FROM_CODE: this site is made from code kept in Qorpera; only a member takes it offline, in Sites'
				using errcode = '55000'; end if;
	end if;$new$]);

-- The members' list shows a repository's site once it is live, in the row every site has.
select pg_temp.code_releases_patch('public.qorpera_list_company_sites(uuid)'::regprocedure, array[
	$old$		where site.profile_id = p_profile_id), '[]'::jsonb);$old$,
	$new$		where site.profile_id = p_profile_id
			-- 20260930729000: a site made from a repository once it is live (before, it waits in What's new), as
			-- qorpera.company-site/v1 with its source code/<owner>/<name> and no agent that published it.
			and (site.code_owner is null or site.current_version_id is not null)), '[]'::jsonb);$new$]);

-- A repository's site holds its name, also before it is first live.
select pg_temp.code_releases_patch('public.qorpera_site_abandoned(public.qorpera_company_sites)'::regprocedure, array[
	$old$	select case when p_site.kind = 'app' then p_site.published_at is null else p_site.current_version_id is null end$old$,
	$new$	-- 20260930729000: a site made from a repository is never abandoned: it waits in What's new.
	select p_site.code_owner is null
		and case when p_site.kind = 'app' then p_site.published_at is null else p_site.current_version_id is null end$new$]);

-- A member who takes a repository's site offline in Sites: its list file says so.
select pg_temp.code_releases_patch('public.qorpera_unpublish_company_site(uuid)'::regprocedure, array[
	$old$	perform public.qorpera_company_site_for_admin(p_site_id);$old$,
	$new$	-- 20260930729000: a repository's site takes its registry row first, as every call on such a site does (the registry
	-- row, then the site, then its versions); only for an owner or admin, who alone goes on.
	if coalesce(public.qorpera_member_role(v_profile)::text in ('owner', 'admin'), false) then
		perform 1 from public.qorpera_code_repositories repository
		join public.qorpera_company_sites site on site.id = p_site_id and repository.environment_id = site.environment_id
			and repository.owner = site.code_owner and repository.name = site.code_name
		for update of repository;
	end if;
	perform public.qorpera_company_site_for_admin(p_site_id);$new$,
	$old$	delete from public.qorpera_company_sites where id = p_site_id;$old$,
	$new$	-- 20260930729000: a repository's site goes with its kept versions and its way back: the repository's list file is
	-- written again (nothing is live). The newest change that left a site is due again at once: the next upload pass
	-- makes the site anew, with a new password and not live, and it waits in What's new for a member. So the repository
	-- forgets what it kept of the old site: its live release, and its failed uploads (a pause, a change given up, the
	-- problem), which would keep that change from being due. Its release and version numbers go on.
	update public.qorpera_code_repositories repository set index_version = repository.index_version + 1,
		live_release = null, site_attempts = 0, site_change = null, site_not_before = null, site_problem = null,
		site_given_up = null
	from public.qorpera_company_sites site
	where site.id = p_site_id and repository.environment_id = site.environment_id and repository.owner = site.code_owner
		and repository.name = site.code_name;
	delete from public.qorpera_company_sites where id = p_site_id;$new$]);

-- A member's own apps drawer (20260930728000) may place What's new, the platform's page, as it places Sites.
select pg_temp.code_releases_patch('public.qorpera_member_app_layout_valid(jsonb)'::regprocedure, array[
	$old$			where place.key !~ '^(page:(mailbox|members|bank)|app:[a-z0-9-]{1,64}|concepts|sites|group:[a-z0-9-]{1,40})$'$old$,
	$new$			-- 20260930729000: What's new, the platform's page, is the bare whats-new (app:whats-new is an agent's app).
			where place.key !~ '^(page:(mailbox|members|bank)|app:[a-z0-9-]{1,64}|concepts|sites|whats-new|group:[a-z0-9-]{1,40})$'$new$]);

-- 7. Grants, and the deploy guard --------------------------------------------------------------------------------------

revoke all on function public.qorpera_code_site_valid(jsonb),
	public.qorpera_code_change_site_valid(jsonb),
	public.qorpera_code_release_live(public.qorpera_code_repositories),
	public.qorpera_code_release_point(public.qorpera_code_repositories, integer, boolean),
	public.qorpera_code_site_slugs(text, text),
	public.qorpera_code_site_given_up(public.qorpera_code_repositories, jsonb),
	public.qorpera_code_site_prune(uuid),
	public.qorpera_code_release_index(public.qorpera_code_repositories),
	public.qorpera_code_site_repository(text, text, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_code_sites_due(text, text, integer),
	public.qorpera_code_site_begin(text, text, uuid, text, text, integer, jsonb),
	public.qorpera_code_site_list(text, text, uuid, jsonb),
	public.qorpera_code_site_missing(text, text, uuid, text, integer),
	public.qorpera_code_site_put(text, text, uuid, jsonb),
	public.qorpera_code_site_finish(text, text, uuid),
	public.qorpera_code_site_failed(text, text, uuid, text, text, integer, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_code_sites_due(text, text, integer),
	public.qorpera_code_site_begin(text, text, uuid, text, text, integer, jsonb),
	public.qorpera_code_site_list(text, text, uuid, jsonb),
	public.qorpera_code_site_missing(text, text, uuid, text, integer),
	public.qorpera_code_site_put(text, text, uuid, jsonb),
	public.qorpera_code_site_finish(text, text, uuid),
	public.qorpera_code_site_failed(text, text, uuid, text, text, integer, text)
	to service_role;
revoke all on function public.qorpera_code_release_switch(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_list_code_releases(uuid),
	public.qorpera_put_code_release_live(uuid, text, text, jsonb),
	public.qorpera_code_release_back(uuid, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_code_releases(uuid),
	public.qorpera_put_code_release_live(uuid, text, text, jsonb),
	public.qorpera_code_release_back(uuid, text, text, jsonb)
	to authenticated;
comment on function public.qorpera_list_code_releases(uuid) is
	'What''s new, for any member: each repository site of the company with what is live, what Go back puts live, what '
	'is ready (its changes and the token a yes names), how many changes are not ready yet, and the last upload''s '
	'problem; canRelease says whether the caller (owner or admin) may put a version live (20260930729000).';
comment on function public.qorpera_put_code_release_live(uuid, text, text, jsonb) is
	'An owner or admin puts live exactly the ready version What''s new showed: the live version, the ready change and its '
	'token; a page that moved is answered moved, and nothing is written (20260930729000).';
comment on function public.qorpera_code_release_back(uuid, text, text, jsonb) is
	'An owner or admin goes back to the version live before the live one, as What''s new showed it; recorded as a '
	'release that shows that version''s number (20260930729000).';

-- Every changed body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_code_checks_switch(uuid,uuid)',
		'public.qorpera_code_change_report_valid(jsonb)',
		'public.qorpera_record_code_change(uuid,uuid,jsonb)',
		'public.qorpera_code_change_files(text,text,uuid,text,text,integer)',
		'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)',
		'public.qorpera_code_restore_record(text,text,uuid,uuid,jsonb)',
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)',
		'public.qorpera_site_publish_check(jsonb,text)',
		'public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)',
		'public.qorpera_site_unpublish(jsonb,text)',
		'public.qorpera_list_company_sites(uuid)',
		'public.qorpera_site_abandoned(public.qorpera_company_sites)',
		'public.qorpera_unpublish_company_site(uuid)',
		'public.qorpera_member_app_layout_valid(jsonb)',
		'public.qorpera_site_share_app(jsonb,text,jsonb,uuid)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930729000') = 0 then
			raise exception '20260930729000 is missing from %', v_function; end if;
	end loop;
end $guard$;
