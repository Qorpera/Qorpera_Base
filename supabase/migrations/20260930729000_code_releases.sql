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
-- 5. Thirteen existing functions change, each by anchors on its definition as it is (an anchor that is not found
--    exactly once fails the migration), and each changed body carries the marker 20260930729000:
--    * qorpera_code_checks_switch answers `site` too;
--    * qorpera_code_change_report_valid and qorpera_record_code_change take v3;
--    * qorpera_code_change_files: the list says what is live and what is ready;
--    * qorpera_code_request_finish and qorpera_code_restore_record: an inheriting row inherits the site too;
--    * qorpera_complete_coding_turn: the platform's line on a landing says whether Qorpera keeps its site;
--    * qorpera_coding_turn_failure: CODING_CHECKS_SITE_REFUSED keeps the executor's words and counts as a round;
--    * qorpera_site_publish_check, qorpera_site_publish_begin and qorpera_site_unpublish: only Qorpera publishes or
--      takes down a repository's site (members still take one offline in Sites), and publish_site never publishes a
--      folder under code/;
--    * qorpera_list_company_sites: a code site only while it is live, its row exactly qorpera.company-site/v1;
--    * qorpera_site_abandoned: never a code site.
--
-- Who may call: section 3 the service role only, as the coding executor that holds the company (the custody check of
-- qorpera_code_hosts_deleting, 42501 otherwise, and care's holder rule: an executor that is not the environment's one
-- enabled executor on that machine gets nothing, or `lost`). Section 4 role authenticated, as a member of the company.
-- Locks, always in this order: the company's profile row (a key share, where a row with its key is written), the
-- repository's registry row, the site row, then version rows. The member's two writes give up after 3 s of waiting.

set local lock_timeout = '3s';

-- 1. Tables and columns ------------------------------------------------------------------------------------------------

alter table public.qorpera_code_repositories
	-- An operator's switch (step 4). Off: the checks run and no site is made.
	add column site_enabled boolean not null default true,
	-- The repository's site, made at its first upload; null before, or once a member took it offline (the site went).
	add column site_id uuid references public.qorpera_company_sites(id) on delete set null,
	-- Its releases: the last row's number, the live row's (read only while the site has a current version), and the
	-- last version number founders saw.
	add column last_release integer not null default 0 check (last_release >= 0),
	add column live_release integer check (live_release is null or live_release >= 1),
	add column last_version integer not null default 0 check (last_version >= 0),
	-- Uploads that failed: site_attempts failures in a row of change site_change, and the pass backs off until
	-- site_not_before; site_given_up is the change it stopped trying after five.
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
