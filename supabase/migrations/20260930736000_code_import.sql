-- 20260930736000: existing code brought into Qorpera, from GitHub or from a file, as a code request of kind import
-- (own code storage, step 6; 12 Nov 2026; STEP6-IMPORT-BUILD.md 4 as STEP6-BUILD.md "The import: what the second
-- check changed" corrects it).
--
-- Code that lives on GitHub, or that an agent made into a git bundle on a machine, becomes a repository kept in
-- Qorpera: the coding executor fetches the bytes (from GitHub through the secret broker's fetch relay, or the bundle
-- under code/_incoming/), the company's code host looks at them, and restore's own jobs set the place up. Only the
-- import's record makes the registry row and change 1, so a refused, failed or look-only import leaves no row. This
-- migration is the kernel's side of all of that. It is inert until an executor that claims kind import is rolled and
-- an agent or a member asks: old executors' three named arguments get the claim's default kinds, which leave imports
-- out.
--
-- 1. Tables:
--    * qorpera_code_repositories: imported_from, what the code was brought in from ({"kind":"github","repository":
--      "Owner/Name","via":…,"branch":…,"commit":…,"commits":…} or {"kind":"file","name":…,"sha256":…,"branch":…,
--      "commit":…,"commits":…}; branch is the default branch it had, commits how many earlier changes came with it),
--      and imported_at.
--    * qorpera_code_requests: kind import; the foreign key to the registry goes (an import has no registry row until its
--      record; every other request's function looks the row up and answers P0002 without one); look, what the code
--      host's look found (at most 16 KiB); one open import a company.
--    * qorpera_code_changes: kind import, change 1 of a repository brought in, always with no main before it.
--    * qorpera_cloud_secret_audit_events: code_request_id and the event type repository_import_fetch_used.
-- 2. The calls that ask (both answer {"schema":"qorpera.code-import/v1","state":"queued","requestId"} or
--    {…,"state":"refused","reason"}):
--    * qorpera_folder_request_code_import(binding, request): the agent's own company run, under a run receipt as undo.
--    * qorpera_request_code_import(profile, owner, name, github): owners and admins.
--    Each takes the company's import lock first, enrolls the company with an executor as a kept dispatch does, and reads
--    the company's own rows only. Asked again, it answers queued with the id of the request that has it: the open import
--    of the same place from the same source; the import that recorded the repository at the place from that source; a
--    look of the same place and source that ended in the last 30 minutes, when the call only looks again (the agent then
--    reads it with qorpera_folder_code_import). Refusals: deleting, kept_here, already_here, busy, sessions_open,
--    file_missing, no_executor.
-- 3. qorpera_folder_code_import(binding, request): the agent's read of an import. qorpera_folder_code_request answers
--    P0002 for kind import. Both agent calls join the native host's list.
-- 4. The executor's side: the claim takes p_kinds (the three-argument form goes: two forms would make every claim
--    ambiguous to PostgREST), at most one import a claim, and nothing else of a company whose import runs; an import's
--    look waits for the company's quiet as a restore does (and while a GitHub session of that code is open,
--    SESSIONS_OPEN), at the claim and at the step that first names look, and such a wait never uses up one of its five
--    claims; once an import recorded its repository no number of claims ends it, only the executor's finish after the
--    job that opens the place; the lease (15 minutes); the step keeps raw and kept once written;
--    qorpera_code_import_looked and qorpera_code_import_record (the registry row, change 1, the GitHub grants of that
--    code turned off); the finish's shapes and rules.
-- 5. While an import is open at a place, no session starts there and no GitHub session of that code starts or opens
--    again: "Code is being brought in at code/o/n; wait until it is in". Once it is in, no GitHub session of that code
--    does: "This code was brought into Qorpera as code/o/n: work on it there (host qorpera)". The dispatch and follow-up
--    rules say so in words, and every turn that opens takes the company's import lock (shared) and asks again, so a
--    request and a turn that meet are one after the other. A GitHub grant at a place refuses a kept dispatch only while
--    no repository is registered there.
-- 6. qorpera_authorize_code_import_fetch: the secret broker's fetch for an import, which the fetch authority asks when
--    no coding session has the worker id it was given (the session path is unchanged).
-- 7. qorpera_list_code_repositories: bringing (always there, [] when nothing runs), lastImport, and per repository
--    importedFrom, importedAt and earlierChanges, in the shapes the web reads (build6/E.md 1). A repository whose
--    import is still open (recorded, its place not open yet) is in bringing, not in repositories.
-- Every changed body carries the marker 20260930736000.
--
-- Who may call: 2 as named; 3 the service role with a run's binding; 4 the service role only, as the coding executor
-- that holds the company (custody 42501; care's holder rule: `lost`); 6 no API role (the fetch authority, a definer,
-- calls it as the secret broker's session); 7 any member.
-- Locks, always in this order: the company's profile row (key share), its import lock (an advisory lock; exclusive for
-- the two calls that ask, shared for a turn that opens), a member's row, the registry row, the request row. The fetch
-- for an import: the profile row, the asker's member row, the broker authority, the request, the grants, the secrets,
-- the version.

set local lock_timeout = '3s';

-- 1. Tables ------------------------------------------------------------------------------------------------------------

alter table public.qorpera_code_repositories
	-- What the code was brought in from, and when: null for a repository that began in Qorpera.
	add column imported_from jsonb check (imported_from is null or (jsonb_typeof(imported_from) = 'object'
		and pg_column_size(imported_from) <= 2048)),
	add column imported_at timestamptz;

alter table public.qorpera_code_requests
	drop constraint qorpera_code_requests_environment_id_owner_name_fkey,
	drop constraint qorpera_code_requests_kind_check,
	add constraint qorpera_code_requests_kind_check check (kind in ('undo','download','restore','import')),
	-- What the code host's look at an import found (qorpera.code-import-look/v1), written once.
	add column look jsonb check (look is null or pg_column_size(look) <= 16384);
comment on column public.qorpera_code_requests.look is
	'20260930736000: an import''s look, what the code host found in the code (size, history, who changed it lately, what '
	'stops it, strings that look like keys), written once by qorpera_code_import_looked.';
-- One open import a company.
create unique index qorpera_code_requests_one_import on public.qorpera_code_requests(profile_id)
	where kind = 'import' and state in ('queued','running');

alter table public.qorpera_code_changes
	drop constraint qorpera_code_changes_kind_check,
	add constraint qorpera_code_changes_kind_check check (kind in ('landing','undo','restore','found','import')),
	-- A repository brought in begins with it: nothing of main came before it.
	add constraint qorpera_code_changes_import check (kind <> 'import' or main_before is null);

alter table public.qorpera_cloud_secret_audit_events add column code_request_id uuid;
-- The event types as they stand, and the import's fetch.
do $$
declare v_types text[]; v_worker_types text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_event_type_check';
	select array_agg(m.value[1] order by m.value[1]) into v_worker_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') as m(value)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_coding_worker';
	if v_types is null or not 'repository_fetch_used' = any(v_types) or 'repository_import_fetch_used' = any(v_types)
		or v_worker_types is distinct from array['environment_secret_used', 'mcp_sign_in_used', 'repository_credential_used',
			'repository_fetch_used'] then
		raise exception '20260930736000: the audit event types differ: % / %', v_types, v_worker_types; end if;
	execute format('alter table public.qorpera_cloud_secret_audit_events
		drop constraint qorpera_cloud_secret_audit_events_event_type_check,
		add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (%s)),
		drop constraint qorpera_cloud_secret_audit_events_coding_worker,
		add constraint qorpera_cloud_secret_audit_events_coding_worker check (
			(event_type in (''repository_credential_used'', ''environment_secret_used'', ''mcp_sign_in_used'',
				''repository_fetch_used'')) = (coding_worker_id is not null)
			and (event_type = ''repository_import_fetch_used'') = (code_request_id is not null))',
		(select string_agg(quote_literal(t), ', ' order by o)
			from unnest(v_types || array['repository_import_fetch_used']) with ordinality as u(t, o)));
end $$;

-- 2. What the calls share ------------------------------------------------------------------------------------------------

-- The most bytes of git an import fetches: 1 GiB. An operator may replace this function, up to 2 GiB (the store's cap).
create function public.qorpera_code_import_maximum_bytes()
returns bigint language sql immutable set search_path = '' as $$
	select 1073741824::bigint
$$;

-- Whether p_from names the code to bring in, exactly: {"github":"Owner/Name"} or
-- {"file":"code/_incoming/<folder>/<name>.bundle"} (as the executor's codeImportIncomingPathValid takes it), each with
-- an optional "branch" (a branch name as a session's base).
create function public.qorpera_code_import_from_valid(p_from jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_from) = 'object'
		and (p_from - array['github','branch'] = '{}'::jsonb or p_from - array['file','branch'] = '{}'::jsonb)
		and case when p_from ? 'github' then public.qorpera_code_json_text(p_from -> 'github', '^[^/]+/[^/]+$')
				and public.qorpera_coding_repository_valid(jsonb_build_object('host', 'github.com',
					'owner', split_part(p_from ->> 'github', '/', 1), 'name', split_part(p_from ->> 'github', '/', 2),
					'baseBranch', 'main'))
			-- (codeImportIncomingPathValid's rule: the folder may not end in a dot, nor be git's own repo.git.)
			else public.qorpera_code_json_text(p_from -> 'file',
					'^code/_incoming/[A-Za-z0-9]([A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?/[A-Za-z0-9][A-Za-z0-9._-]{0,92}\.bundle$')
				and p_from ->> 'file' not like '%..%'
				and lower(split_part(p_from ->> 'file', '/', 3)) <> 'repo.git' end
		and (not p_from ? 'branch' or (jsonb_typeof(p_from -> 'branch') = 'string'
			and public.qorpera_coding_repository_valid(jsonb_build_object('host', 'github.com', 'owner', 'a', 'name', 'a',
				'baseBranch', p_from ->> 'branch')))), false)
$$;

-- One source, one key: GitHub ignores case in owner and name.
create function public.qorpera_code_import_from_key(p_from jsonb)
returns text language sql immutable set search_path = '' as $$
	select case when p_from ? 'github' then 'github:' || lower(p_from ->> 'github') else 'file:' || (p_from ->> 'file') end
		|| '#' || coalesce(p_from ->> 'branch', '')
$$;

-- The company's import lock (an advisory lock to the end of the transaction).
create function public.qorpera_code_import_lock_key(p_profile_id uuid)
returns bigint language sql immutable set search_path = '' as $$
	select hashtextextended('qorpera.code-imports:' || p_profile_id::text, 0)
$$;

-- Why no session may start or open again on p_repository in p_environment_id because of an import, or null. While an
-- import is open at its place (lower case), or, for a GitHub repository, from that GitHub repository: the import's
-- words. Once a GitHub repository was brought in (a registry row at its place that was brought in, or one whose
-- imported_from names it): the words that send it there. Only the company's own rows.
create function public.qorpera_code_import_problem(p_environment_id uuid, p_repository jsonb)
returns text language sql stable security definer set search_path = '' as $$
	select coalesce(
		(select 'Code is being brought in at code/' || request.owner || '/' || request.name || '; wait until it is in'
			from public.qorpera_code_requests request
			where request.environment_id = p_environment_id and request.kind = 'import' and request.state in ('queued','running')
				and ((request.owner = lower(p_repository ->> 'owner') and request.name = lower(p_repository ->> 'name'))
					or (p_repository ->> 'host' = 'github.com' and lower(request.input -> 'from' ->> 'github')
						= lower((p_repository ->> 'owner') || '/' || (p_repository ->> 'name'))))
			order by request.created_at limit 1),
		(select 'This code was brought into Qorpera as code/' || repository.owner || '/' || repository.name
				|| ': work on it there (host qorpera)'
			from public.qorpera_code_repositories repository
			where p_repository ->> 'host' = 'github.com' and repository.environment_id = p_environment_id
				and repository.imported_from is not null
				and ((repository.owner = lower(p_repository ->> 'owner') and repository.name = lower(p_repository ->> 'name'))
					or lower(repository.imported_from ->> 'repository')
						= lower((p_repository ->> 'owner') || '/' || (p_repository ->> 'name')))
			order by repository.owner, repository.name limit 1))
$$;

-- What keeps an import's look waiting, or null: what keeps a restore of its place waiting (care's quiet rule, a session
-- of the place on a machine), or an open GitHub session of that code (at the place, or on the GitHub repository it
-- brings in), whose copy the import would set aside.
create function public.qorpera_code_import_waits(p_request public.qorpera_code_requests, p_now timestamptz)
returns text language sql stable security definer set search_path = '' as $$
	select coalesce(public.qorpera_code_restore_waits(p_request.environment_id, p_request.owner, p_request.name, p_now),
		case when exists (select 1 from public.qorpera_coding_sessions session
			where session.environment_id = p_request.environment_id and session.archived_at is null
				and session.repository ->> 'host' = 'github.com'
				and ((lower(session.repository ->> 'owner') = p_request.owner and lower(session.repository ->> 'name') = p_request.name)
					or lower((session.repository ->> 'owner') || '/' || (session.repository ->> 'name'))
						= lower(p_request.input -> 'from' ->> 'github'))) then 'SESSIONS_OPEN' end)
$$;

-- A turn opens on a coding session: the company's import lock (shared: a turn does not wait for another turn, only for a
-- call that asks for an import), then the import's rule again, as it stands now. So a request and a turn that meet are
-- one after the other: the turn sees the open import, or the request sees the open session.
create function public.qorpera_code_import_guard(p_worker public.qorpera_runtime_workers)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_repository jsonb; v_problem text;
begin
	select session.repository into v_repository from public.qorpera_coding_sessions session where session.worker_id = p_worker.id;
	if v_repository is null then return; end if;
	perform pg_advisory_xact_lock_shared(public.qorpera_code_import_lock_key(p_worker.profile_id));
	v_problem := public.qorpera_code_import_problem(p_worker.environment_id, v_repository);
	if v_problem is not null then raise exception '%', v_problem using errcode = '55000'; end if;
end $$;

-- Whether p_look is what the code host's look found, qorpera.code-import-look/v1 (as the executor's codeImportLook
-- writes it): exactly its keys, each of its kind; a key left out is not of its kind. A path is at most 200 bytes or
-- null, never cut.
create function public.qorpera_code_import_path_valid(p_path jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_path) = 'null' or (jsonb_typeof(p_path) = 'string'
		and octet_length(p_path #>> '{}') between 1 and 200), false)
$$;
create function public.qorpera_code_import_look_valid(p_look jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_look) = 'object'
		and p_look - array['schema','bytes','defaultBranch','mainSha','commits','firstAt','lastAt','authors30d','tags',
			'branches','leftOut','files','entries','biggest','lfs','submodules','refused','secrets','fits','why'] = '{}'::jsonb
		and p_look -> 'schema' = '"qorpera.code-import-look/v1"'::jsonb
		and public.qorpera_code_json_count(p_look -> 'bytes') and public.qorpera_code_json_count(p_look -> 'commits')
		and public.qorpera_code_json_count(p_look -> 'authors30d') and public.qorpera_code_json_count(p_look -> 'leftOut')
		and public.qorpera_code_json_count(p_look -> 'files') and public.qorpera_code_json_count(p_look -> 'entries')
		and public.qorpera_code_json_count(p_look -> 'submodules')
		and (jsonb_typeof(p_look -> 'defaultBranch') = 'null' or (jsonb_typeof(p_look -> 'defaultBranch') = 'string'
			and octet_length(p_look ->> 'defaultBranch') between 1 and 200))
		and public.qorpera_code_care_text_valid(p_look -> 'mainSha', '^[0-9a-f]{40}$')
		and public.qorpera_code_care_text_valid(p_look -> 'firstAt', '^\d{4}-\d{2}-\d{2}T[0-9:.]{8,15}(Z|[+-]\d{2}:?\d{2})$')
		and public.qorpera_code_care_text_valid(p_look -> 'lastAt', '^\d{4}-\d{2}-\d{2}T[0-9:.]{8,15}(Z|[+-]\d{2}:?\d{2})$')
		and jsonb_typeof(p_look -> 'tags') = 'object' and (p_look -> 'tags') - array['seen','kept'] = '{}'::jsonb
		and public.qorpera_code_json_count(p_look -> 'tags' -> 'seen') and public.qorpera_code_json_count(p_look -> 'tags' -> 'kept')
		and jsonb_typeof(p_look -> 'branches') = 'object' and (p_look -> 'branches') - array['seen','kept'] = '{}'::jsonb
		and public.qorpera_code_json_count(p_look -> 'branches' -> 'seen')
		and public.qorpera_code_json_count(p_look -> 'branches' -> 'kept')
		and jsonb_typeof(p_look -> 'biggest') = 'object' and (p_look -> 'biggest') - array['path','bytes'] = '{}'::jsonb
		and public.qorpera_code_import_path_valid(p_look -> 'biggest' -> 'path')
		and public.qorpera_code_json_count(p_look -> 'biggest' -> 'bytes')
		and jsonb_typeof(p_look -> 'lfs') = 'object' and (p_look -> 'lfs') - array['pointers'] = '{}'::jsonb
		and public.qorpera_code_json_count(p_look -> 'lfs' -> 'pointers')
		and jsonb_typeof(p_look -> 'refused') = 'object' and (p_look -> 'refused') - array['code','paths','more'] = '{}'::jsonb
		and public.qorpera_code_care_text_valid(p_look -> 'refused' -> 'code', '^(IMPORT|CODE_HOST)_[A-Z0-9_]{1,100}$')
		and public.qorpera_code_json_count(p_look -> 'refused' -> 'more')
		and jsonb_typeof(p_look -> 'refused' -> 'paths') = 'array' and jsonb_array_length(p_look -> 'refused' -> 'paths') <= 10
		and not exists (select 1 from jsonb_array_elements(p_look -> 'refused' -> 'paths') path
			where not public.qorpera_code_import_path_valid(path))
		and jsonb_typeof(p_look -> 'secrets') = 'object' and (p_look -> 'secrets') - array['found','shown','scan'] = '{}'::jsonb
		and public.qorpera_code_json_count(p_look -> 'secrets' -> 'found')
		and jsonb_typeof(p_look -> 'secrets' -> 'shown') = 'array' and jsonb_array_length(p_look -> 'secrets' -> 'shown') <= 30
		and not exists (select 1 from jsonb_array_elements(p_look -> 'secrets' -> 'shown') shown
			where jsonb_typeof(shown) <> 'object' or shown - array['kind','path','inMain'] <> '{}'::jsonb
				or not public.qorpera_code_json_text(shown -> 'kind', '^[a-z][a-z0-9_-]{0,39}$')
				or not public.qorpera_code_import_path_valid(shown -> 'path')
				or jsonb_typeof(shown -> 'inMain') <> 'boolean')
		and jsonb_typeof(p_look -> 'secrets' -> 'scan') = 'object'
		and (p_look -> 'secrets' -> 'scan') - array['blobs','bytes','all'] = '{}'::jsonb
		and public.qorpera_code_json_count(p_look -> 'secrets' -> 'scan' -> 'blobs')
		and public.qorpera_code_json_count(p_look -> 'secrets' -> 'scan' -> 'bytes')
		and jsonb_typeof(p_look -> 'secrets' -> 'scan' -> 'all') = 'boolean'
		and jsonb_typeof(p_look -> 'fits') = 'boolean'
		and (jsonb_typeof(p_look -> 'why') = 'null'
			or public.qorpera_code_json_text(p_look -> 'why', '^(IMPORT|CODE_HOST)_[A-Z0-9_]{1,100}$')), false)
$$;

-- What a member reads of where code comes from: {"github":"Owner/Name"}, or {"file":"<the bundle's name>"} (never its
-- path); and of what a repository was brought in from: {"kind":"github","repository":"Owner/Name"} or
-- {"kind":"file","name":"<the bundle's name>"} (never its commit or bytes), null for code begun in Qorpera.
create function public.qorpera_code_import_member_source(p_from jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select case when p_from ? 'github' then jsonb_build_object('github', p_from ->> 'github')
		else jsonb_build_object('file', regexp_replace(p_from ->> 'file', '^.*/', '')) end
$$;
create function public.qorpera_code_import_member_from(p_imported_from jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select case when p_imported_from is null then null
		when p_imported_from ->> 'kind' = 'github'
			then jsonb_build_object('kind', 'github', 'repository', p_imported_from ->> 'repository')
		else jsonb_build_object('kind', 'file', 'name', p_imported_from ->> 'name') end
$$;

-- The answers of the calls that ask: the request that has it (read it with qorpera_folder_code_import), or why none.
create function public.qorpera_code_import_answer(p_request_id uuid, p_reason text)
returns jsonb language sql immutable set search_path = '' as $$
	select case when p_reason is null
		then jsonb_build_object('schema', 'qorpera.code-import/v1', 'state', 'queued', 'requestId', p_request_id)
		else jsonb_build_object('schema', 'qorpera.code-import/v1', 'state', 'refused', 'reason', p_reason) end
$$;

-- What both calls that ask do, once the caller is known and its input is valid. p_by_kind agent (p_by_agent_id and the
-- run, with the member whose run it is) or member (p_by_user_id, an owner or admin). In this order, under the company's
-- import lock, in the company's own rows:
-- * deleting: the company is being deleted.
-- * queued, with the request that has it: the open import of this place, from this source, that looks or not as asked;
--   the import that recorded the repository at this place from this source (GitHub: the same repository; a file: the
--   same bytes); asked to look only, a look of this place and source that ended in the last 30 minutes (of the same
--   bytes, for a file).
-- * kept_here: a repository is kept at this place. already_here: the GitHub repository was brought in at another place.
-- * busy: another import of the company is open. sessions_open: an open GitHub session of that code (at the place, or
--   on that GitHub repository). file_missing: the file is not in the folder.
-- * no_executor: after the company is enrolled as a kept dispatch enrolls it, it has not exactly one enabled executor.
-- Then a new request, queued. `via` is fixed now: connection when the asker may use the company's GitHub connection
-- (an owner or admin; an agent with a live grant on it from a current owner or admin), else public; file for a file.
create function public.qorpera_code_import_ask(p_environment_id uuid, p_profile_id uuid, p_owner text, p_name text,
	p_from jsonb, p_look boolean, p_by_kind text, p_by_user_id uuid, p_by_agent_id uuid, p_run_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp(); v_key text := public.qorpera_code_import_from_key(p_from);
	v_github text := p_from ->> 'github'; v_open public.qorpera_code_requests%rowtype;
	v_repository public.qorpera_code_repositories%rowtype; v_request public.qorpera_code_requests%rowtype;
	v_entry public.qorpera_folder_entries%rowtype; v_via text; v_id uuid; v_reason text;
begin
	-- The company's profile row first (the request's row checks its key), then its import lock, to the end of the
	-- transaction: two calls that ask at once are one after the other, and so are a call and a turn that opens.
	perform 1 from public.qorpera_profiles profile where profile.id = p_profile_id for key share;
	perform pg_advisory_xact_lock(public.qorpera_code_import_lock_key(p_profile_id));
	if exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = p_profile_id) then
		return public.qorpera_code_import_answer(null, 'deleting'); end if;
	select * into v_open from public.qorpera_code_requests request
	where request.profile_id = p_profile_id and request.kind = 'import' and request.state in ('queued','running');
	if v_open.id is not null and v_open.environment_id = p_environment_id and v_open.owner = p_owner and v_open.name = p_name
		and public.qorpera_code_import_from_key(v_open.input -> 'from') = v_key
		and v_open.input -> 'look' = to_jsonb(p_look) then
		return public.qorpera_code_import_answer(v_open.id, null); end if;
	if p_from ? 'file' then
		select * into v_entry from public.qorpera_folder_entries entry
		where entry.environment_id = p_environment_id
			and entry.key_sha256 = extensions.digest(public.qorpera_folder_key(p_from ->> 'file'), 'sha256') and entry.kind <> 'claim';
	end if;
	select * into v_repository from public.qorpera_code_repositories repository
	where repository.environment_id = p_environment_id and repository.owner = p_owner and repository.name = p_name;
	if v_repository.imported_from is not null and (case when v_github is not null
			then lower(v_repository.imported_from ->> 'repository') = lower(v_github)
			else v_repository.imported_from ->> 'sha256' = v_entry.file_sha256 end) then
		return public.qorpera_code_import_answer((select change.request_id from public.qorpera_code_changes change
			where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
				and change.n = 1), null);
	end if;
	if p_look then
		select * into v_request from public.qorpera_code_requests request
		where request.environment_id = p_environment_id and request.owner = p_owner and request.name = p_name
			and request.kind = 'import' and request.state = 'done' and request.outcome ->> 'result' = 'looked'
			and request.finished_at > v_now - interval '30 minutes'
			and public.qorpera_code_import_from_key(request.input -> 'from') = v_key
			and request.input ->> 'fileSha256' is not distinct from v_entry.file_sha256
		order by request.finished_at desc, request.id limit 1;
		if found then return public.qorpera_code_import_answer(v_request.id, null); end if;
	end if;
	v_reason := case
		when v_repository.environment_id is not null then 'kept_here'
		when v_github is not null and exists (select 1 from public.qorpera_code_repositories repository
			where repository.environment_id = p_environment_id
				and lower(repository.imported_from ->> 'repository') = lower(v_github)) then 'already_here'
		when v_open.id is not null then 'busy'
		when exists (select 1 from public.qorpera_coding_sessions session
			where session.environment_id = p_environment_id and session.archived_at is null
				and session.repository ->> 'host' = 'github.com'
				and ((lower(session.repository ->> 'owner') = p_owner and lower(session.repository ->> 'name') = p_name)
					or lower((session.repository ->> 'owner') || '/' || (session.repository ->> 'name')) = lower(v_github)))
			then 'sessions_open'
		when p_from ? 'file' and (v_entry.kind is null or v_entry.kind <> 'file') then 'file_missing' end;
	if v_reason is null then
		-- The company's executor, as its first kept session would enroll it (with the chosen executor's own harnesses).
		perform public.qorpera_coding_executor_enroll(p_environment_id, null);
		if (select count(*) from public.qorpera_coding_executors executor
			where executor.environment_id = p_environment_id and executor.enabled) <> 1 then v_reason := 'no_executor'; end if;
	end if;
	if v_reason is not null then return public.qorpera_code_import_answer(null, v_reason); end if;
	v_via := case when p_from ? 'file' then 'file'
		when exists (select 1 from public.qorpera_cloud_secrets secret
			where secret.profile_id = p_profile_id and secret.environment_id = p_environment_id and secret.owner_kind = 'company'
				and secret.connector_id = 'github' and secret.secret_name = 'primary' and secret.status = 'active'
				and (p_by_kind = 'member' or exists (select 1 from public.qorpera_cloud_secret_operation_grants grant_row
					where grant_row.secret_id = secret.id and grant_row.staff_agent_id = p_by_agent_id
						and grant_row.status = 'active'
						and (grant_row.expires_at is null or grant_row.expires_at > v_now)
						and exists (select 1 from public.qorpera_profile_members issuer
							where issuer.profile_id = grant_row.profile_id and issuer.user_id = grant_row.issued_by_user_id
								and issuer.role in ('owner','admin'))))) then 'connection'
		else 'public' end;
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id,
		by_agent_id, run_id)
	values (p_environment_id, p_owner, p_name, p_profile_id, 'import', jsonb_build_object('from', p_from, 'via', v_via,
			'look', p_look, 'maximumBytes', least(public.qorpera_code_import_maximum_bytes(), 2147483648))
			|| case when p_from ? 'file' then jsonb_build_object('fileSha256', v_entry.file_sha256) else '{}'::jsonb end,
		p_by_kind, p_by_user_id, p_by_agent_id, p_run_id)
	returning id into v_id;
	return public.qorpera_code_import_answer(v_id, null);
end $$;

-- 3. The calls that ask, and the agent's read ------------------------------------------------------------------------------

-- The agent's call (manage_code, action bring_in): exactly {operationKey, owner, name, from, look}, owner and name the
-- place under code/ (lower case, as a repository kept in Qorpera). The agent's own company run only, under a run receipt:
-- the same call again in the run answers what it answered.
create function public.qorpera_folder_request_code_import(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['operationKey','owner','name','from','look']
		or p_request - array['operationKey','owner','name','from','look'] <> '{}'::jsonb
		or not public.qorpera_code_json_text(p_request -> 'operationKey', '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$')
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or not public.qorpera_code_import_from_valid(p_request -> 'from')
		or jsonb_typeof(p_request -> 'look') is distinct from 'boolean' then
		raise exception 'Code request is invalid' using errcode = '22023'; end if;
	v_run := public.qorpera_code_agent_run(p_binding);
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('schema', 'qorpera.folder-code-import/v1',
		'runId', v_run.id, 'request', p_request)::text, 'utf8'), 'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(p_binding, v_receipt_id, 'code:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':code:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Code operation needs reconciliation' using errcode = '55000'; end if;
	v_result := public.qorpera_code_import_ask(v_run.environment_id, v_run.profile_id, p_request ->> 'owner',
		p_request ->> 'name', p_request -> 'from', (p_request ->> 'look')::boolean, 'agent', v_run.requested_by_user_id,
		v_run.staff_agent_id, v_run.id);
	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;

-- An owner's or admin's call (Storage, "Bring code in"): GitHub's Owner/Name, brought in at code/<owner>/<name>/.
create function public.qorpera_request_code_import(p_profile_id uuid, p_owner text, p_name text, p_github text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id); v_environment uuid;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null
		or v_role not in ('owner','admin') then
		raise exception 'Code unavailable' using errcode = '42501'; end if;
	if coalesce(p_owner, '') !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$'
		or coalesce(p_name, '') !~ '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$'
		or p_github is null or not public.qorpera_code_import_from_valid(jsonb_build_object('github', p_github)) then
		raise exception 'Code import request is invalid' using errcode = '22023'; end if;
	select file.environment_id into v_environment from public.qorpera_company_files file
	where file.profile_id = p_profile_id and file.core = 'folder-v2' order by file.environment_id limit 1;
	if v_environment is null then raise exception 'Code unavailable' using errcode = '42501'; end if;
	return public.qorpera_code_import_ask(v_environment, p_profile_id, p_owner, p_name, jsonb_build_object('github', p_github),
		false, 'member', auth.uid(), null, null);
end $$;

-- The agent's read of an import its company asked for: how it stands (state, step, what it waits for), the look, and
-- how it ended (result imported or looked, the change, the code of a refusal or failure). P0002 for another company's.
create function public.qorpera_folder_code_import(p_binding jsonb, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_request public.qorpera_code_requests%rowtype;
begin
	v_run := public.qorpera_code_agent_run(p_binding);
	select * into v_request from public.qorpera_code_requests request
	where request.id = p_request_id and request.environment_id = v_run.environment_id and request.kind = 'import';
	if not found then raise exception 'No such code import' using errcode = 'P0002'; end if;
	return jsonb_build_object('schema', 'qorpera.code-import/v1', 'requestId', v_request.id, 'owner', v_request.owner,
		'name', v_request.name, 'state', v_request.state, 'step', v_request.progress -> 'step',
		'waiting', v_request.progress -> 'waiting', 'look', v_request.look, 'result', v_request.outcome -> 'result',
		'change', v_request.outcome -> 'change', 'code', v_request.outcome -> 'code');
end $$;

-- 4. The executor's calls ------------------------------------------------------------------------------------------------

-- What the code host's look found, from the executor that holds the import's lease: written once (the same look again
-- is fine; another is 22023), at most 16,000 bytes as stored (the executor keeps it under 15 KiB of JSON). Answers
-- {"schema":"qorpera.code-import-looked/v1","state":"recorded"} or {…,"state":"lost"}. It locks the request's row.
create function public.qorpera_code_import_looked(p_owner text, p_machine_id_sha256 text, p_request_id uuid, p_token uuid,
	p_look jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_request public.qorpera_code_requests%rowtype;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if not public.qorpera_code_import_look_valid(p_look) or pg_column_size(p_look) > 16000 then
		raise exception 'Code import look invalid' using errcode = '22023'; end if;
	select * into v_request from public.qorpera_code_requests where id = p_request_id for update;
	if v_request.kind <> 'import' then raise exception 'Code import look invalid' using errcode = '22023'; end if;
	if v_request.id is null or p_token is null or v_request.lease_token is distinct from p_token
		or v_request.lease_owner is distinct from p_owner
		or not public.qorpera_code_care_holder(v_request.environment_id, p_owner, p_machine_id_sha256) then
		return '{"schema":"qorpera.code-import-looked/v1","state":"lost"}'::jsonb; end if;
	if v_request.look is not null and v_request.look <> p_look then
		raise exception 'Code import look invalid' using errcode = '22023'; end if;
	update public.qorpera_code_requests set look = p_look, updated_at = clock_timestamp() where id = p_request_id;
	return '{"schema":"qorpera.code-import-looked/v1","state":"recorded"}'::jsonb;
end $$;

-- An import's record, made by the executor that holds its lease inside the job that opens the place, before the mark
-- that closes it goes (as a restore's record). p_imported, exactly {"schema":"qorpera.code-import-record/v1",
-- "bundle":"<the restore-shaped bundle the look made: progress.kept.name>","mainSha":"<progress.kept.mainSha>",
-- "files":<files in main>}. The import's look must be in (and the import not a look only). It inserts the registry row
-- (care due at once, main, imported_from, imported_at), appends change 1 (kind import, landed, no main before it, the
-- asker, "Brought in from GitHub: Owner/Name" or "Brought in from <file>", checks not run), turns off every GitHub
-- grant of the environment at the place or on the GitHub repository brought in, and keeps what it recorded in the
-- progress (`recorded`). Answers {"schema":"qorpera.code-import-recorded/v1","state":"recorded","change":1} or
-- {…,"state":"lost"}. Made again by the same request it answers what it recorded; a registry row that is there
-- otherwise is 55000. It locks the profile row (key share), the registry row (the one there, or the one it inserts),
-- then the request.
create function public.qorpera_code_import_record(p_owner text, p_machine_id_sha256 text, p_request_id uuid, p_token uuid,
	p_imported jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp(); v_request public.qorpera_code_requests%rowtype;
	v_repository public.qorpera_code_repositories%rowtype; v_github text; v_from jsonb; v_n integer;
	c_lost constant jsonb := '{"schema":"qorpera.code-import-recorded/v1","state":"lost"}';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if jsonb_typeof(p_imported) is distinct from 'object'
		or not p_imported ?& array['schema','bundle','mainSha','files']
		or p_imported - array['schema','bundle','mainSha','files'] <> '{}'::jsonb
		or p_imported -> 'schema' <> '"qorpera.code-import-record/v1"'::jsonb
		or not public.qorpera_code_json_text(p_imported -> 'bundle', '^\d{8}T\d{6}Z-[0-9a-f]{12}$')
		or not public.qorpera_code_json_text(p_imported -> 'mainSha', '^[0-9a-f]{40}$')
		or not (public.qorpera_code_json_count(p_imported -> 'files') and p_imported ->> 'files' ~ '^[0-9]{1,9}$') then
		raise exception 'Code import record invalid' using errcode = '22023'; end if;
	-- An unlocked read names the request's place, whose registry row is locked before the request's.
	select * into v_request from public.qorpera_code_requests where id = p_request_id;
	if v_request.id is null or p_token is null then return c_lost; end if;
	perform 1 from public.qorpera_profiles profile where profile.id = v_request.profile_id for key share;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_request.environment_id and owner = v_request.owner and name = v_request.name for update;
	select * into v_request from public.qorpera_code_requests where id = p_request_id for update;
	if v_request.lease_token is distinct from p_token or v_request.lease_owner is distinct from p_owner
		or not public.qorpera_code_care_holder(v_request.environment_id, p_owner, p_machine_id_sha256) then
		return c_lost; end if;
	if v_request.kind <> 'import' or v_request.input -> 'look' <> 'false'::jsonb or v_request.look is null
		or v_request.progress -> 'kept' ->> 'name' is distinct from p_imported ->> 'bundle'
		or v_request.progress -> 'kept' ->> 'mainSha' is distinct from p_imported ->> 'mainSha' then
		raise exception 'Code import record invalid' using errcode = '22023'; end if;
	-- The same request again: what it recorded.
	if v_request.progress ? 'recorded' then
		return '{"schema":"qorpera.code-import-recorded/v1","state":"recorded"}'::jsonb
			|| jsonb_build_object('change', v_request.progress -> 'recorded' -> 'change');
	end if;
	if v_repository.environment_id is not null then
		raise exception 'A repository is kept at that place already' using errcode = '55000'; end if;
	v_github := v_request.input -> 'from' ->> 'github';
	v_from := case when v_github is not null then jsonb_build_object('kind', 'github', 'repository', v_github,
			'via', v_request.input ->> 'via')
		else jsonb_build_object('kind', 'file', 'name', regexp_replace(v_request.input -> 'from' ->> 'file', '^.*/', ''),
			'sha256', v_request.input ->> 'fileSha256') end
		|| jsonb_build_object('branch', v_request.look -> 'defaultBranch', 'commit', p_imported ->> 'mainSha',
			'commits', v_request.look -> 'commits');
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, main_sha, imported_from,
		imported_at, care_enabled, next_care_at)
	values (v_request.environment_id, v_request.profile_id, v_request.owner, v_request.name, p_imported ->> 'mainSha',
		v_from, v_now, true, v_now);
	v_n := public.qorpera_code_change_append(v_request.environment_id, v_request.owner, v_request.name,
		jsonb_build_object('kind', 'import', 'state', 'landed', 'main_before', null, 'main_after', p_imported ->> 'mainSha',
			'request_id', v_request.id, 'staff_agent_id', v_request.by_agent_id,
			'owner_user_id', case when v_request.by_kind = 'member' then v_request.by_user_id end,
			'title', case when v_github is not null then 'Brought in from GitHub: ' || v_github
				else 'Brought in from ' || (v_from ->> 'name') end,
			'checks_state', 'not_run', 'files_changed', (p_imported ->> 'files')::integer));
	-- GitHub's grants of that code end: Qorpera works on it here now.
	update public.qorpera_coding_repository_grants grant_row set enabled = false
	where grant_row.environment_id = v_request.environment_id and grant_row.repository ->> 'host' = 'github.com'
		and grant_row.enabled
		and ((lower(grant_row.repository ->> 'owner') = v_request.owner and lower(grant_row.repository ->> 'name') = v_request.name)
			or lower((grant_row.repository ->> 'owner') || '/' || (grant_row.repository ->> 'name')) = lower(v_github));
	update public.qorpera_code_requests set updated_at = v_now, progress = coalesce(progress, '{}'::jsonb)
		|| jsonb_build_object('recorded', jsonb_build_object('change', v_n, 'bundle', p_imported ->> 'bundle',
			'mainSha', p_imported ->> 'mainSha'))
	where id = p_request_id;
	return jsonb_build_object('schema', 'qorpera.code-import-recorded/v1', 'state', 'recorded', 'change', v_n);
end $$;

-- 6. The secret broker's fetch for an import -------------------------------------------------------------------------------

-- The fetch relay's authority for an import: qorpera_authorize_coding_repository_fetch asks it when no coding session
-- has p_worker_id, which is then an import request's id. One opaque 42501 for any failure, and nothing written then.
-- It answers only while the import fetches (its progress names step fetch, has no raw bundle and no look, and no
-- repository is registered at its place), for the executor that holds its lease and is the company's one enabled
-- executor, through the company's GitHub connection sealed by this broker: for an agent, which is active and holds a
-- live grant on it from a current owner or admin (the session path's own rule), and whose member, when the request names
-- one, is still an owner, admin or contributor; for a member, who is still an owner or admin. No repository grant: an
-- import only reads, and its record turns GitHub's grants of that code off. One audit row
-- (repository_import_fetch_used, with the request), and the session path's answer, workerId the request's id and the
-- repository GitHub's. Locks: the profile row, the asker's member row, the authority, the request, the grants, the
-- secrets, the version.
create function public.qorpera_authorize_code_import_fetch(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_worker_id uuid, p_lease_token uuid, p_executor_owner text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_request public.qorpera_code_requests%rowtype; v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_role public.qorpera_profile_members.role%type; v_grant_ids uuid[] := '{}'; v_secret_ids uuid[];
	v_secret public.qorpera_cloud_secrets%rowtype; v_version public.qorpera_cloud_secret_versions%rowtype; v_github text;
begin
	if session_user <> 'qorpera_secret_broker' or p_broker_authority_id is null or p_worker_id is null
		or p_lease_token is null or coalesce(p_executor_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or p_broker_capability_sha256 is null
		or exists (select 1 from public.qorpera_coding_sessions session where session.worker_id = p_worker_id) then
		raise exception 'code import fetch is unavailable' using errcode = '42501'; end if;
	-- An unlocked read names the request's company and asker.
	select * into v_request from public.qorpera_code_requests request where request.id = p_worker_id;
	if v_request.id is null or v_request.kind is distinct from 'import' then
		raise exception 'code import fetch is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles as profile where profile.id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id) for key share;
	if v_request.by_user_id is not null then
		select member.role into v_role from public.qorpera_profile_members as member
		where member.profile_id = v_request.profile_id and member.user_id = v_request.by_user_id for share;
	end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	select * into v_request from public.qorpera_code_requests request where request.id = p_worker_id for share;
	v_github := v_request.input -> 'from' ->> 'github';
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256
		or v_request.profile_id is distinct from v_authority.profile_id
		or v_request.state <> 'running' or v_request.lease_owner is distinct from p_executor_owner
		or v_request.lease_token is distinct from p_lease_token or v_request.lease_until <= clock_timestamp()
		or (select count(*) from public.qorpera_coding_executors executor
			where executor.environment_id = v_request.environment_id and executor.enabled) <> 1
		or not exists (select 1 from public.qorpera_coding_executors executor
			where executor.environment_id = v_request.environment_id and executor.owner = p_executor_owner and executor.enabled)
		or exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = v_request.profile_id)
		or v_request.input ->> 'via' is distinct from 'connection' or coalesce(v_github, '') !~ '^[^/]+/[^/]+$'
		or not public.qorpera_coding_repository_valid(jsonb_build_object('host', 'github.com',
			'owner', split_part(v_github, '/', 1), 'name', split_part(v_github, '/', 2), 'baseBranch', 'main'))
		or v_request.progress ->> 'step' is distinct from 'fetch' or coalesce(v_request.progress ? 'raw', false)
		or v_request.look is not null
		or exists (select 1 from public.qorpera_code_repositories repository
			where repository.environment_id = v_request.environment_id and repository.owner = v_request.owner
				and repository.name = v_request.name)
		or (case v_request.by_kind
			when 'agent' then v_request.by_agent_id is null
				or not exists (select 1 from public.qorpera_profile_staff as staff
					where staff.profile_id = v_request.profile_id and staff.staff_agent_id = v_request.by_agent_id
						and staff.employment_status = 'active')
				or (v_request.by_user_id is not null and coalesce(v_role not in ('owner','admin','contributor'), true))
			when 'member' then coalesce(v_role not in ('owner','admin'), true)
			else true end) then
		raise exception 'code import fetch is unavailable' using errcode = '42501'; end if;
	-- An agent's live grants on the company's connection (the session path's own query, for the asking agent).
	if v_request.by_kind = 'agent' then
		select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_grant_ids
		from (
			select grant_row.id
			from public.qorpera_cloud_secret_operation_grants as grant_row
			where grant_row.profile_id = v_request.profile_id and grant_row.environment_id = v_request.environment_id
				and grant_row.staff_agent_id = v_request.by_agent_id and grant_row.status = 'active'
				and exists (
					select 1 from public.qorpera_cloud_secrets as secret
					where secret.id = grant_row.secret_id and secret.owner_kind = 'company' and secret.connector_id = 'github'
						and secret.secret_name = 'primary' and secret.status = 'active'
				)
			order by grant_row.id
			for share
		) as locked;
	end if;
	select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_secret_ids
	from (
		select secret.id
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_request.profile_id and secret.environment_id = v_request.environment_id
			and secret.owner_kind = 'company' and secret.connector_id = 'github' and secret.secret_name = 'primary'
			and secret.status = 'active' and secret.broker_authority_id = v_authority.id
			and (v_request.by_kind = 'member' or exists (
				select 1 from public.qorpera_cloud_secret_operation_grants as grant_row
				where grant_row.id = any(v_grant_ids) and grant_row.secret_id = secret.id
					and grant_row.status = 'active'
					and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
					and exists (
						select 1 from public.qorpera_profile_members as issuer
						where issuer.profile_id = grant_row.profile_id and issuer.user_id = grant_row.issued_by_user_id
							and issuer.role in ('owner','admin')
					)
			))
		order by secret.id
		for share of secret
	) as locked;
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = any(v_secret_ids) order by secret.updated_at desc, secret.id limit 1;
	if v_secret.id is null then raise exception 'code import fetch is unavailable' using errcode = '42501'; end if;
	select version.* into v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id = v_secret.id and version.version = v_secret.current_version for share;
	if v_version.secret_id is null or v_version.broker_authority_id <> v_authority.id
		or v_version.key_id <> v_authority.key_id then
		raise exception 'code import fetch is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_cloud_secret_audit_events (profile_id, environment_id, secret_id, secret_version, event_type,
		connector_id, code_request_id)
	values (v_secret.profile_id, v_secret.environment_id, v_secret.id, v_secret.current_version,
		'repository_import_fetch_used', v_secret.connector_id, v_request.id);
	return jsonb_build_object(
		'schema','qorpera.coding-repository-fetch-authorization/v1',
		'companyId',v_secret.profile_id,'environmentId',v_secret.environment_id,
		'secretId',v_secret.id,'secretVersion',v_secret.current_version,'keyId',v_version.key_id,
		'connectorId',v_secret.connector_id,'credentialName','access_token',
		'encryptedEnvelopeBase64',encode(v_version.encrypted_envelope,'base64'),
		'envelopeSha256',v_version.envelope_sha256,
		'workerId',v_request.id,'repository',jsonb_build_object('host', 'github.com', 'owner', split_part(v_github, '/', 1),
			'name', split_part(v_github, '/', 2), 'baseBranch', 'main'));
end $$;

-- 5 to 7. Existing functions -----------------------------------------------------------------------------------------------

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.code_import_patch(p_target regprocedure, p_edits text[]) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930736000' in v_definition) > 0 then
		raise exception '20260930736000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930736000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- An import holds its request for 15 minutes; the executor renews it every 5.
select pg_temp.code_import_patch('public.qorpera_code_request_lease(text)'::regprocedure, array[
	$old$when 'download' then interval '30 minutes'$old$,
	$new$when 'download' then interval '30 minutes'
		-- 20260930736000: an import's steps renew it every 5 minutes.
		when 'import' then interval '15 minutes'$new$]);

-- How an import ends.
select pg_temp.code_import_patch('public.qorpera_code_request_outcome_valid(text,jsonb)'::regprocedure, array[
	$old$			when p_outcome -> 'state' = '"done"'::jsonb then case p_kind || ':' || coalesce(p_outcome ->> 'result', '')$old$,
	$new$			-- 20260930736000: an import refused with its code, before anything moved.
			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind = 'import' then
				p_outcome - array['schema','state','code'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^(IMPORT|CODE_HOST)_[A-Z0-9_]{1,100}$')
			when p_outcome -> 'state' = '"done"'::jsonb then case p_kind || ':' || coalesce(p_outcome ->> 'result', '')$new$,
	$old$				when 'restore:discarded' then p_outcome - array['schema','state','result'] = '{}'::jsonb$old$,
	$new$				when 'restore:discarded' then p_outcome - array['schema','state','result'] = '{}'::jsonb
				-- 20260930736000: an import brought in (change 1, main, the restore-shaped bundle, the first bundle, and
				-- where a GitHub copy at the place went), or a look only.
				when 'import:imported' then
					p_outcome - array['schema','state','result','change','mainSha','bundle','rawBundle','setAside'] = '{}'::jsonb
					and p_outcome -> 'change' = '1'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'bundle', '^\d{8}T\d{6}Z-[0-9a-f]{12}$')
					and public.qorpera_code_care_text_valid(p_outcome -> 'rawBundle', '^import-\d{8}T\d{6}Z-[0-9a-f]{12}$')
					and public.qorpera_code_care_text_valid(p_outcome -> 'setAside', '^code/_set-aside/.')
					and coalesce(octet_length(p_outcome ->> 'setAside'), 0) <= 1024
				when 'import:looked' then p_outcome - array['schema','state','result'] = '{}'::jsonb$new$]);

-- The claim: the kinds asked for; one import a claim; nothing else of a company whose import runs; an import's look
-- waits for quiet as a restore does; five claims of an import until it records; an import's item. It replaces the
-- three-argument form.
select pg_temp.code_import_patch('public.qorpera_code_requests_claim(text,text,integer)'::regprocedure, array[
	$old$public.qorpera_code_requests_claim(p_owner text, p_machine_id_sha256 text, p_limit integer)$old$,
	$new$public.qorpera_code_requests_claim(p_owner text, p_machine_id_sha256 text, p_limit integer, p_kinds text[] DEFAULT ARRAY['undo'::text, 'download'::text, 'restore'::text])$new$,
	$old$	v_change public.qorpera_code_changes%rowtype; v_waiting text; v_item jsonb; v_begun jsonb; v_spent boolean;$old$,
	$new$	v_change public.qorpera_code_changes%rowtype; v_waiting text; v_item jsonb; v_begun jsonb; v_spent boolean;
	v_import boolean := false; -- 20260930736000$new$,
	$old$		raise exception 'Code request limit invalid' using errcode = '22023'; end if;$old$,
	$new$		raise exception 'Code request limit invalid' using errcode = '22023'; end if;
	-- 20260930736000: the kinds this executor takes, at least one, each a kind of request.
	if p_kinds is null or cardinality(p_kinds) = 0 or array_position(p_kinds, null) is not null
		or not p_kinds <@ array['undo','download','restore','import'] then
		raise exception 'Code request kinds invalid' using errcode = '22023'; end if;$new$,
	$old$		where (request.state = 'queued' or (request.state = 'running' and request.lease_until <= v_now))$old$,
	$new$		where (request.state = 'queued' or (request.state = 'running' and request.lease_until <= v_now))
			and request.kind = any (p_kinds) -- 20260930736000$new$,
	$old$		exit when jsonb_array_length(v_claimed) >= p_limit;
		if v_request.kind = 'restore' and v_request.input ->> 'mode' = 'restore'$old$,
	$new$		exit when jsonb_array_length(v_claimed) >= p_limit;
		-- 20260930736000: one import a claim (an executor runs one at a time), and nothing else of a company while its
		-- import runs (it holds the company's line in the code host for as long as an hour).
		continue when v_request.kind = 'import' and v_import;
		continue when v_request.kind <> 'import' and exists (select 1 from public.qorpera_code_requests import
			where import.profile_id = v_request.profile_id and import.kind = 'import' and import.state = 'running'
				and import.lease_until > v_now);
		-- An import whose bytes are in and whose look is still to run waits for quiet as a restore of the place does,
		-- and while a GitHub session of that code is open; the wait uses up none of its claims.
		if v_request.kind = 'import' and coalesce(v_request.progress ? 'raw', false) and v_request.look is null then
			v_waiting := public.qorpera_code_import_waits(v_request, v_now);
			if v_waiting is not null then
				update public.qorpera_code_requests set state = 'queued', lease_token = null, lease_owner = null,
					lease_until = null, progress = coalesce(progress, '{}'::jsonb) || jsonb_build_object('waiting', v_waiting),
					updated_at = v_now
				where id = v_request.id;
				continue;
			end if;
		end if;
		if v_request.kind = 'restore' and v_request.input ->> 'mode' = 'restore'$new$,
	$old$		v_spent := v_request.attempts >= case when v_request.kind = 'download' then 5 else 3 end;$old$,
	$new$		-- 20260930736000: an import has five claims, as a download, until it recorded its repository. From its record on
		-- the place holds the import's mark until the job that opens it removes it, and the executor's finish after that
		-- job is the import's only end: it is claimed again for as long as that takes (the review of #1710, F2).
		v_spent := v_request.attempts >= case when v_request.kind in ('download','import') then 5 else 3 end
			and not (v_request.kind = 'import' and coalesce(v_request.progress ? 'recorded', false));$new$,
	$old$		else
			v_item := v_item || jsonb_build_object('mode', v_request.input ->> 'mode', 'bundle', v_request.input -> 'bundle',$old$,
	$new$		elsif v_request.kind = 'import' then
			-- 20260930736000: what was asked, what it has done so far, and the look when it is in.
			v_import := true;
			v_item := v_item || jsonb_build_object('input', v_request.input, 'progress', v_request.progress,
				'looked', v_request.look);
		else
			v_item := v_item || jsonb_build_object('mode', v_request.input ->> 'mode', 'bundle', v_request.input -> 'bundle',$new$,
	$old$		where request.kind = 'download' and request.state = 'done' and request.expires_at <= v_now$old$,
	$new$		where request.kind = 'download' and request.state = 'done' and request.expires_at <= v_now
			-- 20260930736000: only when downloads are asked for, and not in a company whose import runs.
			and 'download' = any (p_kinds)
			and not exists (select 1 from public.qorpera_code_requests import
				where import.profile_id = request.profile_id and import.kind = 'import' and import.state = 'running'
					and import.lease_until > v_now)$new$]);
drop function public.qorpera_code_requests_claim(text, text, integer);

-- The step: an import's look waits for quiet at the step that first names it, and the step keeps the import's bundles
-- once written.
select pg_temp.code_import_patch('public.qorpera_code_request_step(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$	v_generation bigint; v_progress jsonb; v_place boolean; v_step text;$old$,
	$new$	v_generation bigint; v_progress jsonb; v_place boolean; v_step text; v_waiting text; -- 20260930736000$new$,
	$old$		|| case when v_request.progress ? 'begun' then jsonb_build_object('begun', v_request.progress -> 'begun')
			else '{}'::jsonb end end;$old$,
	$new$		|| case when v_request.progress ? 'begun' then jsonb_build_object('begun', v_request.progress -> 'begun')
			else '{}'::jsonb end
		-- 20260930736000: an import's first bundle and its restore-shaped one, once the row has them: the fetch authority
		-- and the record read them.
		|| case when v_request.kind = 'import' and v_request.progress ? 'raw'
			then jsonb_build_object('raw', v_request.progress -> 'raw') else '{}'::jsonb end
		|| case when v_request.kind = 'import' and v_request.progress ? 'kept'
			then jsonb_build_object('kept', v_request.progress -> 'kept') else '{}'::jsonb end end;$new$,
	$old$	v_step := v_progress ->> 'step';$old$,
	$new$	v_step := v_progress ->> 'step';
	-- 20260930736000: the step that first names an import's look waits for quiet, as the claim does. A wait puts the
	-- import back in the queue there and then, with what it brings and the word, and gives its claim back: the lease ends
	-- (the finish that follows is lost), and the next claim waits until the company is quiet.
	if v_request.kind = 'import' and v_step = 'look' and v_request.progress ->> 'step' is distinct from 'look'
		and v_request.look is null then
		v_waiting := public.qorpera_code_import_waits(v_request, v_now);
		if v_waiting is not null then
			update public.qorpera_code_requests set state = 'queued', lease_token = null, lease_owner = null, lease_until = null,
				attempts = greatest(attempts - 1, 0), updated_at = v_now,
				progress = (v_progress - 'step') || case when v_request.progress ? 'step'
					then jsonb_build_object('step', v_request.progress -> 'step') else '{}'::jsonb end
					|| jsonb_build_object('waiting', v_waiting)
			where id = p_request_id;
			return jsonb_build_object('schema', 'qorpera.code-request-step/v1', 'state', 'busy');
		end if;
	end if;$new$]);

-- The finish: once an import is recorded it ends only brought in or put off; it is brought in only as it recorded; a
-- look only ends looked; and a finish for a request that is gone may be an import's.
select pg_temp.code_import_patch('public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$			or public.qorpera_code_request_outcome_valid('restore', p_outcome))) then$old$,
	$new$			or public.qorpera_code_request_outcome_valid('restore', p_outcome)
			-- 20260930736000
			or public.qorpera_code_request_outcome_valid('import', p_outcome))) then$new$,
	$old$			v_request.name, v_request.input ->> 'fileName')) then
		raise exception 'Code request outcome invalid' using errcode = '22023'; end if;$old$,
	$new$			v_request.name, v_request.input ->> 'fileName')) then
		raise exception 'Code request outcome invalid' using errcode = '22023'; end if;
	-- 20260930736000: an import that recorded its repository is in: it ends brought in, as it recorded, or is put off. One
	-- that looks only ends looked, once its look is in.
	if v_request.kind = 'import' then
		v_recorded := v_request.progress -> 'recorded';
		if v_recorded is not null and v_state <> 'busy' and v_result is distinct from 'imported' then
			raise exception 'Code import is recorded' using errcode = '55000'; end if;
		if v_result = 'imported' and (v_recorded ->> 'bundle' is distinct from p_outcome ->> 'bundle'
			or v_recorded ->> 'mainSha' is distinct from p_outcome ->> 'mainSha') then
			raise exception 'Code import is not recorded' using errcode = '55000'; end if;
		if v_result = 'looked' and (v_request.input -> 'look' <> 'true'::jsonb or v_request.look is null) then
			raise exception 'Code request outcome invalid' using errcode = '22023'; end if;
	end if;$new$,
	$old$		v_stored := p_outcome || (v_recorded - 'change' - 'bundle' - 'mainSha');
	end if;$old$,
	$new$		v_stored := p_outcome || (v_recorded - 'change' - 'bundle' - 'mainSha');
	elsif v_request.kind = 'import' and v_result = 'imported' then
		-- 20260930736000: change 1, as the import's record wrote it.
		v_n := (v_recorded ->> 'change')::integer;
		v_stored := p_outcome - 'change';
	end if;$new$]);

-- The agent's read of a request is for undo, download and restore: an import has its own.
select pg_temp.code_import_patch('public.qorpera_folder_code_request(jsonb,uuid)'::regprocedure, array[
	$old$	where request.id = p_request_id and request.environment_id = v_run.environment_id;$old$,
	$new$	where request.id = p_request_id and request.environment_id = v_run.environment_id
		and request.kind <> 'import'; -- 20260930736000: qorpera_folder_code_import reads an import$new$]);

-- An import enrolls its company as a kept dispatch does, with no harness of its own: the chosen executor's.
select pg_temp.code_import_patch('public.qorpera_coding_executor_enroll(uuid,text)'::regprocedure, array[
	$old$	where executor.enabled and p_harness = any(executor.harnesses)
	group by executor.owner$old$,
	$new$	-- 20260930736000: no harness (an import's): any.
	where executor.enabled and (p_harness is null or p_harness = any(executor.harnesses))
	group by executor.owner$new$,
	$old$	where executor.owner = v_owner and executor.enabled and p_harness = any(executor.harnesses)$old$,
	$new$	where executor.owner = v_owner and executor.enabled and (p_harness is null or p_harness = any(executor.harnesses))$new$,
	$old$	values (p_environment_id, v_owner, true, array[p_harness], v_like.vm_policy, v_like.nas_policy,$old$,
	$new$	values (p_environment_id, v_owner, true, case when p_harness is null then v_like.harnesses else array[p_harness] end,
		v_like.vm_policy, v_like.nas_policy,$new$]);

-- The dispatch and follow-up rules: an import's words, and a GitHub grant at a place refuses a kept dispatch only while
-- no repository is registered there.
select pg_temp.code_import_patch(
	'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure, array[
	$old$			-- 20260930670000: one place under code/ never holds both a GitHub copy and a repository kept in Qorpera.$old$,
	$new$			-- 20260930736000: while code is being brought in at a place, no session starts there, nor a GitHub session of
			-- the code it brings in; once it is in, no GitHub session of that code (qorpera_code_import_problem).
			elsif v_species = 'coding' and public.qorpera_code_import_problem(p_environment_id, v_request -> 'repository')
				is not null then
				v_problem := public.qorpera_code_import_problem(p_environment_id, v_request -> 'repository');
			-- 20260930670000: one place under code/ never holds both a GitHub copy and a repository kept in Qorpera.$new$,
	$old$						and lower(grant_row.repository ->> 'name') = v_request -> 'repository' ->> 'name') then
				v_problem := 'The company''s code already holds a copy of a GitHub repository at code/'$old$,
	$new$						and lower(grant_row.repository ->> 'name') = v_request -> 'repository' ->> 'name')
				-- 20260930736000: only while no repository is registered there (once code is brought in, it is).
				and not exists (select 1 from public.qorpera_code_repositories kept
					where kept.environment_id = p_environment_id and kept.owner = v_request -> 'repository' ->> 'owner'
						and kept.name = v_request -> 'repository' ->> 'name') then
				v_problem := 'The company''s code already holds a copy of a GitHub repository at code/'$new$,
	$old$				v_problem := 'This coding session runs for another member';$old$,
	$new$				v_problem := 'This coding session runs for another member';
			-- 20260930736000: a session opens again only where no import stands in its way.
			elsif v_worker.species = 'coding' and public.qorpera_code_import_problem(p_environment_id,
				(select session.repository from public.qorpera_coding_sessions session where session.worker_id = v_worker.id))
				is not null then
				v_problem := public.qorpera_code_import_problem(p_environment_id,
					(select session.repository from public.qorpera_coding_sessions session where session.worker_id = v_worker.id));$new$]);

-- Every turn that opens (a dispatch, an agent's follow-up, a member's answer) asks the import's rule again under the
-- company's import lock.
select pg_temp.code_import_patch(
	'public.qorpera_open_coding_turn(public.qorpera_runtime_workers,text,text,uuid,uuid)'::regprocedure, array[
	$old$begin
	if exists (select 1 from public.qorpera_coding_session_turns turn where turn.worker_id = p_worker.id$old$,
	$new$begin
	-- 20260930736000: no turn starts on code that is being brought in, nor on a GitHub copy of code brought in.
	perform public.qorpera_code_import_guard(p_worker);
	if exists (select 1 from public.qorpera_coding_session_turns turn where turn.worker_id = p_worker.id$new$]);

-- The fetch authority: an import's request id in place of a session's goes to the import's own authority.
select pg_temp.code_import_patch(
	'public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)'::regprocedure, array[
	$old$	v_session := public.qorpera_coding_relay_session(p_broker_authority_id, p_broker_capability_sha256, p_worker_id,$old$,
	$new$	-- 20260930736000: no coding session has this id: it is an import's request (or nothing), which the import's own
	-- authority answers. The session path is as it was.
	if not exists (select 1 from public.qorpera_coding_sessions as session where session.worker_id = p_worker_id) then
		return public.qorpera_authorize_code_import_fetch(p_broker_authority_id, p_broker_capability_sha256, p_worker_id,
			p_lease_token, p_executor_owner);
	end if;
	v_session := public.qorpera_coding_relay_session(p_broker_authority_id, p_broker_capability_sha256, p_worker_id,$new$]);

-- The repositories' list: what is being brought in, the last import that did not come in, and what each repository was
-- brought in from.
select pg_temp.code_import_patch('public.qorpera_list_code_repositories(uuid)'::regprocedure, array[
	$old$				'changes', repository.last_change,$old$,
	$new$				'changes', repository.last_change,
				-- 20260930736000: what it was brought in from ({kind, repository} or {kind, name}, null for code begun
				-- here), when, and how many earlier changes came with it.
				'importedFrom', public.qorpera_code_import_member_from(repository.imported_from), 'importedAt', repository.imported_at,
				'earlierChanges', repository.imported_from -> 'commits',$new$,
	$old$			where repository.profile_id = p_profile_id), '[]'::jsonb),
		-- 20260930735000: the places of the company's GitHub-host coding sessions$old$,
	$new$			where repository.profile_id = p_profile_id
				-- 20260930736000: a repository whose import is still open is not in yet (its place is closed until the
				-- import's open job and finish): it shows in bringing.
				and not exists (select 1 from public.qorpera_code_requests import
					where import.environment_id = repository.environment_id and import.owner = repository.owner
						and import.name = repository.name and import.kind = 'import' and import.state in ('queued','running'))),
			'[]'::jsonb),
		-- 20260930735000: the places of the company's GitHub-host coding sessions$new$,
	$old$				limit 100) copy), '[]'::jsonb));$old$,
	$new$				limit 100) copy), '[]'::jsonb),
		-- 20260930736000: the code being brought in now (looks only are an agent's), oldest first, and the newest import of
		-- the last day that ended refused or failed, unless one ended later.
		'bringing', coalesce((select jsonb_agg(jsonb_build_object('owner', request.owner, 'name', request.name,
				'from', public.qorpera_code_import_member_source(request.input -> 'from'),
				'step', request.progress -> 'step', 'waiting', request.progress -> 'waiting', 'startedAt', request.created_at)
				order by request.created_at, request.id)
			from public.qorpera_code_requests request
			join public.qorpera_company_files file on file.environment_id = request.environment_id
				and file.profile_id = p_profile_id and file.core = 'folder-v2'
			where request.profile_id = p_profile_id and request.kind = 'import' and request.state in ('queued','running')
				and request.input -> 'look' = 'false'::jsonb), '[]'::jsonb),
		'lastImport', (select jsonb_build_object('owner', last.owner, 'name', last.name,
				'from', public.qorpera_code_import_member_source(last.input -> 'from'), 'state', last.state,
				'reason', last.outcome ->> 'code')
			from (select request.* from public.qorpera_code_requests request
				join public.qorpera_company_files file on file.environment_id = request.environment_id
					and file.profile_id = p_profile_id and file.core = 'folder-v2'
				where request.profile_id = p_profile_id and request.kind = 'import'
					and request.input -> 'look' = 'false'::jsonb and request.state in ('done','refused','failed')
					and request.finished_at > v_now - interval '24 hours'
				order by request.finished_at desc, request.id desc limit 1) last
			where last.state in ('refused','failed')));$new$]);

-- A change's record file of a repository brought in says what came with it: change 1 carries what the registry row
-- says it was brought in from.
select pg_temp.code_import_patch('public.qorpera_code_change_files(text,text,uuid,text,text,integer)'::regprocedure, array[
	$old$				'restoredFrom', due.restored_from,$old$,
	$new$				'restoredFrom', due.restored_from,
				-- 20260930736000: change 1 of code brought in: imported_from (kind, repository or name, branch, commit,
				-- commits). Null for every other kind.
				'importedFrom', case when due.kind = 'import' then v_repository.imported_from end,$new$]);

-- 8. The native host, grants, and the deploy guard -------------------------------------------------------------------------

-- The native host may call the agent's two, with the binding's scope.
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_folder_request_code_import', 'binding'), ('qorpera_folder_code_import', 'binding');

revoke all on function public.qorpera_code_import_maximum_bytes(),
	public.qorpera_code_import_from_valid(jsonb),
	public.qorpera_code_import_from_key(jsonb),
	public.qorpera_code_import_lock_key(uuid),
	public.qorpera_code_import_problem(uuid, jsonb),
	public.qorpera_code_import_waits(public.qorpera_code_requests, timestamptz),
	public.qorpera_code_import_guard(public.qorpera_runtime_workers),
	public.qorpera_code_import_path_valid(jsonb),
	public.qorpera_code_import_look_valid(jsonb),
	public.qorpera_code_import_answer(uuid, text),
	public.qorpera_code_import_member_source(jsonb),
	public.qorpera_code_import_member_from(jsonb),
	public.qorpera_code_import_ask(uuid, uuid, text, text, jsonb, boolean, text, uuid, uuid, uuid),
	public.qorpera_authorize_code_import_fetch(uuid, text, uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_folder_request_code_import(jsonb, jsonb),
	public.qorpera_folder_code_import(jsonb, uuid),
	public.qorpera_code_requests_claim(text, text, integer, text[]),
	public.qorpera_code_import_looked(text, text, uuid, uuid, jsonb),
	public.qorpera_code_import_record(text, text, uuid, uuid, jsonb),
	public.qorpera_request_code_import(uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_request_code_import(jsonb, jsonb),
	public.qorpera_folder_code_import(jsonb, uuid),
	public.qorpera_code_requests_claim(text, text, integer, text[]),
	public.qorpera_code_import_looked(text, text, uuid, uuid, jsonb),
	public.qorpera_code_import_record(text, text, uuid, uuid, jsonb)
	to service_role;
grant execute on function public.qorpera_request_code_import(uuid, text, text, text) to authenticated;
comment on function public.qorpera_request_code_import(uuid, text, text, text) is
	'An owner or admin brings a GitHub project into Qorpera as code/<owner>/<name>/: queued, done (already in), or '
	'refused with a reason; the coding executor fetches it, looks at it and sets it up (20260930736000).';
comment on function public.qorpera_folder_request_code_import(jsonb, jsonb) is
	'An agent''s own company run brings code in from GitHub or a file under code/_incoming/, or only looks at it, '
	'under a run receipt (20260930736000).';
comment on function public.qorpera_authorize_code_import_fetch(uuid, text, uuid, uuid, text) is
	'The secret broker''s fetch through the company''s GitHub connection for a code import while it fetches; asked by '
	'qorpera_authorize_coding_repository_fetch for a worker id no coding session has (20260930736000).';

-- Every changed body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_code_request_lease(text)',
		'public.qorpera_code_request_outcome_valid(text,jsonb)',
		'public.qorpera_code_requests_claim(text,text,integer,text[])',
		'public.qorpera_code_request_step(text,text,uuid,uuid,jsonb)',
		'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)',
		'public.qorpera_folder_code_request(jsonb,uuid)',
		'public.qorpera_coding_executor_enroll(uuid,text)',
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)',
		'public.qorpera_open_coding_turn(public.qorpera_runtime_workers,text,text,uuid,uuid)',
		'public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)',
		'public.qorpera_list_code_repositories(uuid)',
		'public.qorpera_code_change_files(text,text,uuid,text,text,integer)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930736000') = 0 then
			raise exception '20260930736000 is missing from %', v_function; end if;
	end loop;
	if to_regprocedure('public.qorpera_code_requests_claim(text,text,integer)') is not null then
		raise exception '20260930736000: the three-argument claim is still there'; end if;
end $guard$;
