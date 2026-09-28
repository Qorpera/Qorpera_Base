-- Company folder core, C1a: the foundation (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §1-§3).
--
-- Inert for today's companies. Everything here runs only for a company whose Company File row says
-- core = 'folder-v2', and only an operator can make one (qorpera_folder_enable) until the reset (C5).
-- snapshot-v1 companies keep today's tables, functions and lock text unchanged; today's object GC skips
-- folder-v2 companies (their GC arrives with C1d).
--
-- This slice:
-- * the immutable per-company core flag;
-- * the folder core's own tables: entries (a version per path), immutable path versions, commits,
--   operation keys, the journal and its clock, and the folder fence and admission rows later slices use;
-- * the change-set commit for members and the platform, with the lock rules of core §3;
-- * reads and listings that take no company-wide lock and answer from one statement.
-- Agent (run) actors, authority revisions, read sets and review in SQL arrive with C1b and C1c; the
-- commit refuses a staff-agent actor until then. Structured files and their indexes arrive with C2.
--
-- Path locking (core §3 step 5). Every unit locks, in one increasing key order: its targets and sources
-- (FOR UPDATE, a copy's source included) and every ancestor of them (FOR KEY SHARE). An absent row is
-- claimed first, so a second transaction waits on the claim instead of missing it. Because every write
-- holds all its ancestors, a subtree unit needs to lock only its root: nothing inside can change, and
-- nothing can be created under a claimed target, while the root is held. No update ever changes a row's
-- key (a move deletes and re-inserts), because a READ COMMITTED locking read that follows an update chain
-- keeps the lock on the row's new version, which would sit at a key out of order.
--
-- A unit that creates a key lands on this change set's claim for it, or inserts the key outright when an
-- earlier unit of the same change set removed it (delete then write, move then mkdir at the old name).
-- Such a freed key stays guarded: another transaction waits on this one at the key's unique index. Every
-- apply checks the number of rows it placed and raises on a mismatch, so a lost write fails loudly.

-- 1. The core flag -----------------------------------------------------------------------------------

alter table public.qorpera_company_files
	add column core text not null default 'snapshot-v1' check (core in ('snapshot-v1','folder-v2'));

-- A folder-v2 company is ready without a head: it has none.
do $$
declare v_name text;
begin
	select con.conname into strict v_name from pg_catalog.pg_constraint con
	where con.conrelid = 'public.qorpera_company_files'::regclass and con.contype = 'c'
		and pg_catalog.pg_get_constraintdef(con.oid) = 'CHECK (((state = ''ready''::text) = (head_snapshot_id IS NOT NULL)))';
	execute format('alter table public.qorpera_company_files drop constraint %I', v_name);
end $$;
alter table public.qorpera_company_files add constraint qorpera_company_files_core_head check (
	(core = 'snapshot-v1' and (state = 'ready') = (head_snapshot_id is not null))
	or (core = 'folder-v2' and head_snapshot_id is null and path_gateway_version is null));

-- Only qorpera_folder_enable changes the flag: it runs as the table's owner and sets the marker. The marker
-- alone is not enough, since any session can set it.
create function public.qorpera_company_file_core_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
	if new.core is distinct from old.core then
		if not (old.core = 'snapshot-v1' and new.core = 'folder-v2' and old.state = 'provisioning'
			and old.head_snapshot_id is null and old.path_gateway_version is null
			and current_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = tg_relid)
			and coalesce(current_setting('qorpera.folder_enable', true), '') = 'on') then
			raise exception 'The Company File core cannot change' using errcode = '42501';
		end if;
	end if;
	return new;
end $$;
create trigger qorpera_company_file_core_guard before update of core on public.qorpera_company_files
	for each row execute function public.qorpera_company_file_core_guard();

-- 2. Tables --------------------------------------------------------------------------------------------

create function public.qorpera_folder_parent_path(p_path text)
returns text language sql immutable set search_path = '' as $$
	select case when strpos(p_path, '/') = 0 then null else regexp_replace(p_path, '/[^/]*$', '') end
$$;
-- Every ancestor of a path, nearest last ('a', 'a/b' for 'a/b/c').
create function public.qorpera_folder_ancestors(p_path text)
returns text[] language sql immutable set search_path = '' as $$
	select coalesce(array_agg(array_to_string(p.parts[1:n], '/') order by n), '{}')
	from (select string_to_array(p_path, '/') as parts) p, generate_series(1, cardinality(p.parts) - 1) as n
$$;

-- Per-company clock: the journal's sequence. Taken last in a commit (core §3 step 11). Not indexed on
-- last_seq, so its updates stay HOT. The folder tables reference this row, never the Company File row:
-- their foreign-key checks take KEY SHARE, which the clock's own updates never block, while the Company
-- File row is locked FOR UPDATE by today's upload quota trigger.
create table public.qorpera_folder_clocks (
	environment_id uuid primary key references public.qorpera_company_files(environment_id) on delete cascade,
	last_seq bigint not null default 0 check (last_seq >= 0)
);

-- The folder fence (stop and resume) and the admission row (wake admission and the wake count). Used by
-- the run paths of C1b/C1c; created and seeded here so every folder-v2 company has them from the start.
create table public.qorpera_folder_fences (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	revision bigint not null default 1 check (revision >= 1)
);
create table public.qorpera_folder_admissions (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	admitted bigint not null default 0 check (admitted >= 0)
);

create table public.qorpera_folder_commits (
	id uuid primary key,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	seq bigint check (seq is null or seq >= 1),
	operation_key text not null,
	-- Attribution (contract 4.2). A member or the platform in this slice; runs arrive with C1b/C1c.
	actor_kind text not null check (actor_kind in ('member','platform','staff_agent')),
	actor_id uuid,
	requester_kind text check (requester_kind in ('member','platform','staff_agent')),
	requester_id uuid,
	approver_user_id uuid,
	run_id uuid,
	causal_wake_id uuid,
	provider_connection_id uuid,
	receipt_id uuid,
	proposal_id uuid,
	audience jsonb,
	runtime_bundle_id uuid,
	units jsonb not null check (jsonb_typeof(units) = 'array'),
	created_at timestamptz not null default clock_timestamp(),
	unique (environment_id, seq),
	check ((actor_kind = 'platform') = (actor_id is null))
);
create index qorpera_folder_commits_run on public.qorpera_folder_commits(run_id) where run_id is not null;

-- Claimed first in a commit (core §3 step 1). No foreign key to runs.
create table public.qorpera_folder_operation_keys (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	operation_key text not null check (operation_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
	commit_id uuid not null,
	request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, operation_key)
);

-- The current folder: one row per live path. A claim is a placeholder a commit inserts for a path it is
-- about to create or lock (core §3 step 5); a claim never outlives its transaction.
create table public.qorpera_folder_entries (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	path text collate "C" not null check (public.qorpera_company_path_valid(path)),
	key_text text collate "C" generated always as (public.qorpera_company_path_key(path)) stored,
	key_sha256 bytea generated always as (extensions.digest(public.qorpera_company_path_key(path), 'sha256')) stored,
	-- A top-level path's parent key is the sha256 of '', so every listing is one indexed equality.
	parent_key_sha256 bytea generated always as (extensions.digest(
		public.qorpera_company_path_key(coalesce(public.qorpera_folder_parent_path(path), '')), 'sha256')) stored,
	name text collate "C" generated always as (regexp_replace(path, '^.*/', '')) stored,
	kind text not null check (kind in ('file','folder','claim')),
	version uuid,
	commit_id uuid references public.qorpera_folder_commits(id) on delete restrict,
	manifest_sha256 text check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint check (bytes >= 0),
	media_type text check (media_type ~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'),
	executable boolean,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, key_sha256),
	check ((kind = 'claim') = (version is null)),
	check ((kind = 'claim') = (commit_id is null)),
	check ((kind = 'file') = (manifest_sha256 is not null and file_sha256 is not null and bytes is not null
		and media_type is not null and executable is not null)),
	check (kind = 'file' or (manifest_sha256 is null and file_sha256 is null and bytes is null
		and media_type is null and executable is null))
);
create index qorpera_folder_entries_children on public.qorpera_folder_entries(environment_id, parent_key_sha256, key_text);
create index qorpera_folder_entries_key_text on public.qorpera_folder_entries(environment_id, key_text);

-- Immutable history: one row per version of a path, kept for good (core §2).
create table public.qorpera_folder_path_versions (
	version uuid primary key,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	path text collate "C" not null,
	key_sha256 bytea not null,
	prior_version uuid,
	op text not null check (op in ('write','mkdir','delete','move_out','move_in','copy')),
	kind text not null check (kind in ('file','folder')),
	commit_id uuid not null references public.qorpera_folder_commits(id) on delete restrict,
	unit_no integer not null check (unit_no >= 1),
	manifest_sha256 text,
	file_sha256 text,
	bytes bigint,
	media_type text,
	executable boolean,
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_folder_path_versions_path on public.qorpera_folder_path_versions(environment_id, key_sha256, created_at);
create index qorpera_folder_path_versions_commit on public.qorpera_folder_path_versions(commit_id);

create table public.qorpera_folder_journal (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	seq bigint not null check (seq >= 1),
	kind text not null check (kind in ('change_set','authority')),
	commit_id uuid references public.qorpera_folder_commits(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, seq),
	check ((kind = 'change_set') = (commit_id is not null))
);

alter table public.qorpera_folder_clocks enable row level security;
alter table public.qorpera_folder_fences enable row level security;
alter table public.qorpera_folder_admissions enable row level security;
alter table public.qorpera_folder_commits enable row level security;
alter table public.qorpera_folder_operation_keys enable row level security;
alter table public.qorpera_folder_entries enable row level security;
alter table public.qorpera_folder_path_versions enable row level security;
alter table public.qorpera_folder_journal enable row level security;
revoke all on public.qorpera_folder_clocks, public.qorpera_folder_fences, public.qorpera_folder_admissions,
	public.qorpera_folder_commits, public.qorpera_folder_operation_keys, public.qorpera_folder_entries,
	public.qorpera_folder_path_versions, public.qorpera_folder_journal
	from public, anon, authenticated, service_role;

-- 3. Today's GC skips folder-v2 companies ---------------------------------------------------------------

-- Its retention roots are snapshots, which a folder-v2 company never writes; left alone it would collect
-- every folder-v2 object after 24 hours. The folder core's GC (core §8) arrives with C1d.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_claim_company_object_gc(integer,uuid)'::regprocedure);
	v_old text := E'\t\t\tand exists (\n\t\t\t\tselect 1 from public.qorpera_company_files as file\n\t\t\t\twhere file.profile_id = object.profile_id\n\t\t\t)';
	v_new text := E'\t\t\tand exists (\n\t\t\t\tselect 1 from public.qorpera_company_files as file\n\t\t\t\twhere file.profile_id = object.profile_id\n\t\t\t)\n\t\t\tand not exists (\n\t\t\t\tselect 1 from public.qorpera_company_files as folder_file\n\t\t\t\twhere folder_file.profile_id = object.profile_id and folder_file.core = ''folder-v2''\n\t\t\t)';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Company object GC candidate selection differs'; end if;
	execute replace(v_definition, v_old, v_new);
end $$;

-- Artifact GC retains only hashes other reachability graphs name, and folder entries are in none of them, so
-- a folder file sharing a hash with a collected artifact would lose its object. A folder-v2 company's plans
-- retain everything until the folder core's GC.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_claim_artifact_gc_objects(uuid,uuid,integer)'::regprocedure);
	v_old text := E'\tif not found then raise sqlstate ''PGRST'' using message = jsonb_build_object(''code'', ''QRC01'', ''message'', ''artifact cleanup lease is unavailable'', ''details'', null, ''hint'', null)::text, detail = ''{"status":409,"headers":{}}''; end if;\n';
	v_new text := v_old || E'\tif exists (select 1 from public.qorpera_company_files as folder_file\n\t\twhere folder_file.profile_id = v_plan.profile_id and folder_file.core = ''folder-v2'') then\n\t\tupdate public.qorpera_artifact_gc_plan_entries as entry\n\t\tset status = ''retained'', acknowledged_at = statement_timestamp()\n\t\twhere entry.plan_id = p_plan_id and entry.status = ''pending'';\n\t\treturn ''[]''::jsonb;\n\tend if;\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Artifact GC object claim differs'; end if;
	execute replace(v_definition, v_old, v_new);
end $$;

-- 4. Enabling a company -------------------------------------------------------------------------------

-- An operator makes a new, untouched company folder-v2 (core §1). Its clock, fence and admission rows and
-- the root resource are created in the same step.
create function public.qorpera_folder_enable(p_environment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2') then
		return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',false);
	end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	if not found then raise exception 'Company File is unavailable' using errcode = '42501'; end if;
	if v_file.core = 'folder-v2' then
		return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',false);
	end if;
	if v_file.state <> 'provisioning' or v_file.head_snapshot_id is not null or v_file.path_gateway_version is not null
		or exists (select 1 from public.qorpera_company_snapshots where environment_id = p_environment_id) then
		raise exception 'Only an untouched company can use the folder core' using errcode = '55000'; end if;
	perform set_config('qorpera.folder_enable', 'on', true);
	update public.qorpera_company_files set core = 'folder-v2', state = 'ready', updated_at = statement_timestamp()
	where environment_id = p_environment_id;
	perform set_config('qorpera.folder_enable', '', true);
	insert into public.qorpera_folder_clocks(environment_id) values (p_environment_id);
	insert into public.qorpera_folder_fences(profile_id) values (v_file.profile_id) on conflict (profile_id) do nothing;
	insert into public.qorpera_folder_admissions(profile_id) values (v_file.profile_id) on conflict (profile_id) do nothing;
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	values (p_environment_id, '', 'subtree', 'company_shared', 'normal', v_file.created_by_user_id)
	on conflict (environment_id, path_key_sha256) do nothing;
	return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',true);
end $$;

-- 5. Helpers -------------------------------------------------------------------------------------------

-- Adapter-only and system names never enter the folder. git's own files and dependency caches are
-- allowed only under code/ (the 2026-09-27 amendment "every machine works in the company folder", item 9).
create function public.qorpera_folder_path_reserved(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	select split_part(p_key, '/', 1) in ('.qorpera','trail','inbox','credentials','secrets')
		or (split_part(p_key, '/', 1) <> 'code'
			and exists (select 1 from unnest(string_to_array(p_key, '/')) as part where part in ('.git','node_modules')))
$$;

-- LIKE pattern for everything strictly under a key.
create function public.qorpera_folder_under(p_key text)
returns text language sql immutable set search_path = '' as $$
	select replace(replace(replace(p_key, '\', '\\'), '%', '\%'), '_', '\_') || '/%'
$$;

-- Member authority over one path, through today's resources and grants (core §4; revisions arrive with
-- C1b). An unreadable path answers exactly like a missing one.
create function public.qorpera_folder_member_allowed(p_environment_id uuid, p_profile_id uuid, p_user_id uuid,
	p_path text, p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype;
begin
	v_resource := public.qorpera_company_path_resource(p_environment_id, p_path);
	if v_resource.id is null then return false; end if;
	return public.qorpera_company_path_principal_allowed(p_profile_id, v_resource, 'member', p_user_id, p_permission);
end $$;

-- Member authority over a root path and the keys below it. Every key resolves to one of a few boundaries,
-- each checked once: the root's own resource; the nearest subtree resource at or above the root, which
-- covers the descendants when the root's own resource is exact; a narrower resource inside that covers one
-- of the keys; or an implicit members/<id>/private folder.
create function public.qorpera_folder_member_keys_allowed(p_environment_id uuid, p_profile_id uuid, p_user_id uuid,
	p_root_path text, p_keys text[], p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_root_key text := public.qorpera_company_path_key(p_root_path);
begin
	if not public.qorpera_folder_member_allowed(p_environment_id, p_profile_id, p_user_id, p_root_path, p_permission) then
		return false; end if;
	if cardinality(p_keys) = 0 then return true; end if;
	return not exists (
		with keys as (select unnest(p_keys) as key), boundaries as (
			(select r.path_key as key from public.qorpera_company_path_resources r
			where r.environment_id = p_environment_id and r.path_match = 'subtree'
				and (r.path_key = '' or r.path_key = v_root_key or left(v_root_key, length(r.path_key) + 1) = r.path_key || '/')
			order by length(r.path_key) desc limit 1)
			union
			select r.path_key from public.qorpera_company_path_resources r
			where r.environment_id = p_environment_id and r.path_key like public.qorpera_folder_under(v_root_key)
				and exists (select 1 from keys k where k.key = r.path_key
					or (r.path_match = 'subtree' and k.key like public.qorpera_folder_under(r.path_key)))
			union
			select regexp_replace(k.key, '^(members/[^/]+/private)(/.*)?$', '\1') from keys k
			where k.key ~ '^members/[^/]+/private(/|$)'
		)
		select 1 from boundaries b
		where not public.qorpera_folder_member_allowed(p_environment_id, p_profile_id, p_user_id, b.key, p_permission));
end $$;

-- Member authority over a whole subtree, mapped from p_from_key onto p_to_path (p_to_path = the subtree's
-- own path when nothing moves).
create function public.qorpera_folder_member_subtree_allowed(p_environment_id uuid, p_profile_id uuid, p_user_id uuid,
	p_from_key text, p_to_path text, p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_folder_member_keys_allowed(p_environment_id, p_profile_id, p_user_id, p_to_path,
		array(select public.qorpera_company_path_key(p_to_path) || substr(e.key_text, char_length(p_from_key) + 1)
			from public.qorpera_folder_entries e
			where e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(p_from_key)),
		p_permission)
$$;

create function public.qorpera_folder_entry_json(p_path text, p_kind text, p_version uuid, p_seq bigint,
	p_manifest text, p_file text, p_bytes bigint, p_media text, p_executable boolean)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_strip_nulls(jsonb_build_object('path', p_path, 'kind', p_kind, 'version', p_version, 'seq', p_seq,
		'manifestSha256', p_manifest, 'fileSha256', p_file, 'bytes', p_bytes, 'mediaType', p_media, 'executable', p_executable))
$$;

-- A new folder's contents as they will be stored: each takes its folders' spelling, rebuilt from the names
-- of the unit's own folders on its way down (the commit checks that each one is there). Set-based, with each
-- key computed once.
create function public.qorpera_folder_spelled_contents(p_root_path text, p_contents jsonb)
returns table(ord bigint, path text, kind text, file jsonb) language sql stable set search_path = '' as $$
	with c as materialized (
		select t.ord, t.value ->> 'kind' as kind, string_to_array(t.value ->> 'path', '/') as parts,
			public.qorpera_company_path_key(t.value ->> 'path') as key,
			case when t.value ->> 'kind' = 'file' then t.value -> 'file' end as file
		from jsonb_array_elements(p_contents) with ordinality as t(value, ord)
	), spelled as (
		select c.ord, p_root_path || '/' || string_agg(a.parts[cardinality(a.parts)], '/' order by x.i) as path
		from c cross join lateral generate_series(1, cardinality(c.parts)) as x(i)
		join c as a on a.key = public.qorpera_company_path_key(array_to_string(c.parts[1:x.i], '/'))
		group by c.ord
	)
	select c.ord, s.path, c.kind, c.file from spelled s join c on c.ord = s.ord
$$;

-- Lock one path in the given mode, claiming it first when it is absent. Returns true when this call
-- inserted the claim. A concurrent claim is waited for by the insert, never missed.
create function public.qorpera_folder_lock_path(p_environment_id uuid, p_path text, p_mode text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_key bytea := extensions.digest(public.qorpera_company_path_key(p_path), 'sha256'); v_claimed boolean := false;
begin
	for v_attempt in 1..8 loop
		if p_mode = 'update' then
			perform 1 from public.qorpera_folder_entries where environment_id = p_environment_id and key_sha256 = v_key for update;
		else
			perform 1 from public.qorpera_folder_entries where environment_id = p_environment_id and key_sha256 = v_key for key share;
		end if;
		if found then return v_claimed; end if;
		insert into public.qorpera_folder_entries(environment_id, path, kind) values (p_environment_id, p_path, 'claim')
		on conflict do nothing;
		if found then v_claimed := true; end if;
	end loop;
	raise exception 'Company folder path could not be locked' using errcode = '55P03';
end $$;

-- 6. Applying one clean unit ---------------------------------------------------------------------------

-- Called by the commit only, after every lock is held and the unit was decided clean. Paths are the
-- effective ones: a new name takes its existing parent's spelling, and a moved or copied descendant keeps
-- its own stored spelling below the new root. Returns the unit's new version.
create function public.qorpera_folder_apply_unit(p_environment_id uuid, p_commit_id uuid, p_unit_no integer,
	p_op text, p_path text, p_to text, p_unit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
	v_key text := public.qorpera_company_path_key(p_path);
	v_row public.qorpera_folder_entries%rowtype;
	v_version uuid := extensions.gen_random_uuid(); v_file jsonb; v_prior uuid;
	v_placed bigint; v_expected bigint := 1;
begin
	select * into v_row from public.qorpera_folder_entries
	where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256');

	if p_op = 'write' then
		-- Lands on the unit's claim or on the file it replaces, or inserts the key an earlier unit removed.
		v_file := p_unit -> 'file';
		v_prior := case when v_row.kind = 'file' then v_row.version end;
		insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
			commit_id, unit_no, manifest_sha256, file_sha256, bytes, media_type, executable)
		values (v_version, p_environment_id, p_path, extensions.digest(v_key, 'sha256'), v_prior, 'write', 'file',
			p_commit_id, p_unit_no, v_file ->> 'manifestSha256', v_file ->> 'fileSha256', (v_file ->> 'bytes')::bigint,
			v_file ->> 'mediaType', (v_file ->> 'executable')::boolean);
		insert into public.qorpera_folder_entries as e(environment_id, path, kind, version, commit_id, manifest_sha256,
			file_sha256, bytes, media_type, executable)
		values (p_environment_id, p_path, 'file', v_version, p_commit_id, v_file ->> 'manifestSha256', v_file ->> 'fileSha256',
			(v_file ->> 'bytes')::bigint, v_file ->> 'mediaType', (v_file ->> 'executable')::boolean)
		on conflict (environment_id, key_sha256) do update set path = excluded.path, kind = excluded.kind,
			version = excluded.version, commit_id = excluded.commit_id, manifest_sha256 = excluded.manifest_sha256,
			file_sha256 = excluded.file_sha256, bytes = excluded.bytes, media_type = excluded.media_type,
			executable = excluded.executable, updated_at = clock_timestamp()
		where e.kind = 'claim' or (e.kind = 'file' and e.version = v_prior);
		get diagnostics v_placed = row_count;

	elsif p_op in ('mkdir','new_folder') then
		insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, op, kind, commit_id, unit_no)
		values (v_version, p_environment_id, p_path, extensions.digest(v_key, 'sha256'), 'mkdir', 'folder', p_commit_id, p_unit_no);
		insert into public.qorpera_folder_entries as e(environment_id, path, kind, version, commit_id)
		values (p_environment_id, p_path, 'folder', v_version, p_commit_id)
		on conflict (environment_id, key_sha256) do update set path = excluded.path, kind = excluded.kind,
			version = excluded.version, commit_id = excluded.commit_id, updated_at = clock_timestamp()
		where e.kind = 'claim';
		get diagnostics v_placed = row_count;
		if p_op = 'new_folder' and v_placed = 1 then
			-- Contents, set-based. Not claimed: nothing else can create a key below the held root.
			with c as materialized (
				select s.ord, s.path, s.kind, s.file, extensions.gen_random_uuid() as version
				from public.qorpera_folder_spelled_contents(p_path, p_unit -> 'contents') s
			), versions as (
				insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, op, kind, commit_id,
					unit_no, manifest_sha256, file_sha256, bytes, media_type, executable)
				select c.version, p_environment_id, c.path, extensions.digest(public.qorpera_company_path_key(c.path), 'sha256'),
					case when c.kind = 'file' then 'write' else 'mkdir' end, c.kind, p_commit_id, p_unit_no,
					c.file ->> 'manifestSha256', c.file ->> 'fileSha256', (c.file ->> 'bytes')::bigint, c.file ->> 'mediaType',
					(c.file ->> 'executable')::boolean
				from c
			), placed as (
				insert into public.qorpera_folder_entries as e(environment_id, path, kind, version, commit_id, manifest_sha256,
					file_sha256, bytes, media_type, executable)
				select p_environment_id, c.path, c.kind, c.version, p_commit_id, c.file ->> 'manifestSha256',
					c.file ->> 'fileSha256', (c.file ->> 'bytes')::bigint, c.file ->> 'mediaType', (c.file ->> 'executable')::boolean
				from c
				on conflict (environment_id, key_sha256) do update set path = excluded.path, kind = excluded.kind,
					version = excluded.version, commit_id = excluded.commit_id, manifest_sha256 = excluded.manifest_sha256,
					file_sha256 = excluded.file_sha256, bytes = excluded.bytes, media_type = excluded.media_type,
					executable = excluded.executable, updated_at = clock_timestamp()
				where e.kind = 'claim'
				returning 1
			)
			select 1 + (select count(*) from placed), 1 + (select count(*) from c) into v_placed, v_expected;
		end if;

	elsif p_op = 'delete' then
		-- Set-based: one statement for the versions, one for the rows.
		insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
			commit_id, unit_no)
		select case when e.key_sha256 = v_row.key_sha256 then v_version else extensions.gen_random_uuid() end,
			p_environment_id, e.path, e.key_sha256, e.version, 'delete', e.kind, p_commit_id, p_unit_no
		from public.qorpera_folder_entries e where e.environment_id = p_environment_id and e.kind <> 'claim'
			and (e.key_sha256 = v_row.key_sha256 or (v_row.kind = 'folder' and e.key_text like public.qorpera_folder_under(v_row.key_text)));
		get diagnostics v_expected = row_count;
		delete from public.qorpera_folder_entries e where e.environment_id = p_environment_id and e.kind <> 'claim'
			and (e.key_sha256 = v_row.key_sha256 or (v_row.kind = 'folder' and e.key_text like public.qorpera_folder_under(v_row.key_text)));
		get diagnostics v_placed = row_count;

	elsif p_op in ('move','copy') then
		-- Paths are rebuilt from the stored spelling, whose length matches the stored path (never the
		-- request's). A new key is a delete and a fresh insert, never an update of the key: a transaction
		-- waiting to lock the old key must find the row gone, not follow its update chain and end up holding
		-- the row under its new key, out of key order. New rows land on this change set's claims (the
		-- target's, and any another unit holds below it); nothing else can hold a key below a claimed target,
		-- since every write holds its ancestors. Set-based, in one statement.
		with src as materialized (
			select e.*, p_to || substr(e.path, char_length(v_row.path) + 1) as new_path,
				case when e.key_sha256 = v_row.key_sha256 then v_version else extensions.gen_random_uuid() end as new_version
			from public.qorpera_folder_entries e where e.environment_id = p_environment_id and e.kind <> 'claim'
				and (e.key_sha256 = v_row.key_sha256 or (v_row.kind = 'folder' and e.key_text like public.qorpera_folder_under(v_row.key_text)))
		), moved_out as (
			insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
				commit_id, unit_no, manifest_sha256, file_sha256, bytes, media_type, executable)
			select extensions.gen_random_uuid(), p_environment_id, src.path, src.key_sha256, src.version, 'move_out', src.kind,
				p_commit_id, p_unit_no, src.manifest_sha256, src.file_sha256, src.bytes, src.media_type, src.executable
			from src where p_op = 'move'
		), arrived as (
			insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
				commit_id, unit_no, manifest_sha256, file_sha256, bytes, media_type, executable)
			select src.new_version, p_environment_id, src.new_path,
				extensions.digest(public.qorpera_company_path_key(src.new_path), 'sha256'),
				case when p_op = 'move' then src.version end, case when p_op = 'move' then 'move_in' else 'copy' end, src.kind,
				p_commit_id, p_unit_no, src.manifest_sha256, src.file_sha256, src.bytes, src.media_type, src.executable
			from src
		), respelled as (
			update public.qorpera_folder_entries e set path = src.new_path, version = src.new_version, commit_id = p_commit_id,
				updated_at = clock_timestamp()
			from src where p_op = 'move' and public.qorpera_company_path_key(src.new_path) = src.key_text
				and e.environment_id = p_environment_id and e.key_sha256 = src.key_sha256
			returning 1
		), removed as (
			delete from public.qorpera_folder_entries e using src
			where p_op = 'move' and public.qorpera_company_path_key(src.new_path) <> src.key_text
				and e.environment_id = p_environment_id and e.key_sha256 = src.key_sha256
			returning 1
		), placed as (
			insert into public.qorpera_folder_entries as e(environment_id, path, kind, version, commit_id, manifest_sha256,
				file_sha256, bytes, media_type, executable)
			select p_environment_id, src.new_path, src.kind, src.new_version, p_commit_id, src.manifest_sha256, src.file_sha256,
				src.bytes, src.media_type, src.executable
			from src where p_op = 'copy' or public.qorpera_company_path_key(src.new_path) <> src.key_text
			on conflict (environment_id, key_sha256) do update set path = excluded.path, kind = excluded.kind,
				version = excluded.version, commit_id = excluded.commit_id, manifest_sha256 = excluded.manifest_sha256,
				file_sha256 = excluded.file_sha256, bytes = excluded.bytes, media_type = excluded.media_type,
				executable = excluded.executable, updated_at = clock_timestamp()
			where e.kind = 'claim'
			returning 1
		)
		-- Every source row lands once, and a move removes each old key it re-inserts.
		select (select count(*) from placed) + (select count(*) from respelled) + (select count(*) from removed),
			(select count(*) from src)
				+ (select count(*) from src where p_op = 'move' and public.qorpera_company_path_key(src.new_path) <> src.key_text)
		into v_placed, v_expected;
	else
		raise exception 'Unknown folder unit' using errcode = '22023';
	end if;
	if v_placed is distinct from v_expected or v_expected < 1 then
		raise exception 'Company folder unit % did not apply', p_unit_no using errcode = 'XX000'; end if;
	return v_version;
end $$;

-- 7. The change-set commit ----------------------------------------------------------------------------

-- Lock order (core §3): operation key; [run; folder fence: run actors, C1b/C1c]; the member; covering
-- resources; paths in one increasing key order (targets and sources, and every ancestor); objects;
-- [admission: wakes, C1c]; clock. Nothing is locked after the clock, and no lock is ever strengthened.
create function public.qorpera_folder_commit(p_environment_id uuid, p_actor jsonb, p_operation_key text, p_units jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype;
	v_actor_kind text; v_actor_id uuid; v_role public.qorpera_profile_role;
	v_request_sha text; v_commit_id uuid := extensions.gen_random_uuid(); v_existing record;
	v_unit jsonb; v_no integer; v_op text; v_path text; v_to text; v_key text; v_to_key text; v_parent text;
	v_row public.qorpera_folder_entries%rowtype; v_target public.qorpera_folder_entries%rowtype;
	v_parent_row public.qorpera_folder_entries%rowtype;
	v_outcomes jsonb := '[]'::jsonb; v_saved integer := 0; v_seq bigint; v_version uuid;
	v_file_json jsonb; v_as_of bigint; v_ancestor text;
	v_ok boolean; v_reason text; v_committed boolean := false; v_eff_path text; v_eff_to text;
	v_locks jsonb := '{}'::jsonb; v_claims text[] := '{}'; v_lock record; v_invalid boolean;
	c_subtree_bound constant integer := 50000;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder commits run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	v_actor_kind := p_actor ->> 'kind';
	if jsonb_typeof(p_actor) is distinct from 'object' or v_actor_kind is null then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if v_actor_kind = 'member' then
		if p_actor - array['kind','userId'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_actor_id := (p_actor ->> 'userId')::uuid;
	elsif v_actor_kind = 'platform' then
		if p_actor - array['kind'] <> '{}'::jsonb then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	elsif v_actor_kind = 'staff_agent' then
		-- Agent writes carry a run, its fence and its review; they arrive with C1b and C1c.
		raise exception 'Agent folder writes are not available yet' using errcode = '0A000';
	else
		raise exception 'Folder actor is invalid' using errcode = '22023';
	end if;
	if p_operation_key is null or p_operation_key !~ '^[A-Za-z0-9._:-]{8,200}$' then
		raise exception 'Operation key is invalid' using errcode = '22023'; end if;
	if jsonb_typeof(p_units) is distinct from 'array' or jsonb_array_length(p_units) not between 1 and 1000 then
		raise exception 'Change set is invalid' using errcode = '22023'; end if;

	-- The shape of each unit. Only malformed requests raise; everything else is an outcome.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop
		v_op := v_unit ->> 'op';
		if jsonb_typeof(v_unit) is distinct from 'object' or v_op is null
			or v_op not in ('write','mkdir','new_folder','delete','move','copy') then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		if v_path is null or not public.qorpera_company_path_valid(v_path)
			or (v_op in ('move','copy') and (v_to is null or not public.qorpera_company_path_valid(v_to)))
			or (v_op not in ('move','copy') and v_to is not null)
			or (v_op = 'write' and jsonb_typeof(v_unit -> 'file') is distinct from 'object')
			or (v_op = 'new_folder' and (jsonb_typeof(v_unit -> 'contents') is distinct from 'array'
				or jsonb_array_length(v_unit -> 'contents') > 10000
				or exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c
					where jsonb_typeof(c.value) is distinct from 'object' or c.value ->> 'path' is null
						or not public.qorpera_company_path_valid(v_path || '/' || (c.value ->> 'path'))))) then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
	end loop;

	-- Step 1. The operation key. A replay stops here and returns the stored outcomes. A key reused for a
	-- different change set is refused.
	v_request_sha := encode(extensions.digest(convert_to(jsonb_build_array(p_actor, p_units)::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_folder_operation_keys(environment_id, operation_key, commit_id, request_sha256)
	values (p_environment_id, p_operation_key, v_commit_id, v_request_sha) on conflict do nothing;
	if not found then
		select k.request_sha256, c.id, c.seq, c.units into v_existing
		from public.qorpera_folder_operation_keys k join public.qorpera_folder_commits c on c.id = k.commit_id
		where k.environment_id = p_environment_id and k.operation_key = p_operation_key;
		if v_existing.request_sha256 is distinct from v_request_sha then
			raise exception 'Operation key was used for a different change set' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_existing.id,'seq',v_existing.seq,
			'replay',true,'units',v_existing.units);
	end if;

	-- Step 4. The member's row, KEY SHARE; then every covering resource of the paths this change set names,
	-- FOR SHARE, in ancestors-first order.
	if v_actor_kind = 'member' then
		select role into v_role from public.qorpera_profile_members
		where profile_id = v_file.profile_id and user_id = v_actor_id for key share;
		if v_role is null then raise exception 'Company membership is required' using errcode = '42501'; end if;
	end if;

	-- The lock set: each unit's targets and sources FOR UPDATE, and every ancestor of them FOR KEY SHARE. The
	-- stronger mode wins. A copy's source is held FOR UPDATE too, so its subtree cannot change between the
	-- checks and the copy (writers below it hold it KEY SHARE).
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		foreach v_ancestor in array public.qorpera_folder_ancestors(v_path) || coalesce(public.qorpera_folder_ancestors(v_to), '{}') loop
			v_key := public.qorpera_company_path_key(v_ancestor);
			if not v_locks ? v_key then
				v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_ancestor, 'mode', 'keyshare'));
			end if;
		end loop;
		v_locks := v_locks || jsonb_build_object(public.qorpera_company_path_key(v_path), jsonb_build_object('path', v_path, 'mode', 'update'));
		if v_to is not null then
			v_locks := v_locks || jsonb_build_object(public.qorpera_company_path_key(v_to), jsonb_build_object('path', v_to, 'mode', 'update'));
		end if;
	end loop;

	perform 1 from public.qorpera_company_path_resources r
	where r.environment_id = p_environment_id
		and r.id in (select (public.qorpera_company_path_resource(p_environment_id, l.value ->> 'path')).id from jsonb_each(v_locks) l)
	order by r.path_key for share of r;

	-- Step 5. Paths, in one increasing key order. Ancestors sort before descendants, so every transaction
	-- takes a parent before its children.
	for v_lock in select l.key collate "C" as key, l.value ->> 'path' as path, l.value ->> 'mode' as mode
		from jsonb_each(v_locks) l order by l.key collate "C" loop
		if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_lock.mode) then
			v_claims := v_claims || v_lock.key;
		end if;
	end loop;

	-- Steps 7-8. Decide each unit from the locked rows, in order, and apply each clean one before the next is
	-- decided. Failures are outcomes, not exceptions.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop
		v_ok := true; v_reason := null; v_version := null;
		v_op := v_unit ->> 'op';
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		v_key := public.qorpera_company_path_key(v_path);
		v_to_key := case when v_to is not null then public.qorpera_company_path_key(v_to) end;
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		if not found then v_row := null; end if;
		-- The path a new name takes: its existing parent's spelling plus its own name.
		v_parent := public.qorpera_folder_parent_path(coalesce(v_to, v_path));
		v_parent_row := null;
		if v_parent is not null then
			select * into v_parent_row from public.qorpera_folder_entries
			where environment_id = p_environment_id and kind = 'folder'
				and key_sha256 = extensions.digest(public.qorpera_company_path_key(v_parent), 'sha256');
			if not found then v_parent_row := null; end if;
		end if;
		v_eff_path := case when v_op in ('move','copy') then coalesce(v_row.path, v_path)
			when v_parent_row.path is not null then v_parent_row.path || '/' || regexp_replace(v_path, '^.*/', '')
			else v_path end;
		v_eff_to := case when v_to is null then null
			when v_parent_row.path is not null then v_parent_row.path || '/' || regexp_replace(v_to, '^.*/', '')
			else v_to end;

		-- Names the folder never holds, on every path the unit produces.
		if public.qorpera_folder_path_reserved(coalesce(v_to_key, v_key))
			or (v_op in ('move','copy') and exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.key_text like public.qorpera_folder_under(v_key)
					and public.qorpera_folder_path_reserved(v_to_key || substr(e.key_text, char_length(v_key) + 1))))
			or (v_op = 'new_folder' and exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c
				where public.qorpera_folder_path_reserved(public.qorpera_company_path_key(v_path || '/' || (c.value ->> 'path'))))) then
			v_ok := false; v_reason := 'reserved';
		end if;

		-- Authority on every path the unit touches (a subtree's boundaries included): write on what changes,
		-- read on a copy's source.
		if v_ok and v_actor_kind = 'member' then
			if v_op in ('write','mkdir') then
				v_ok := public.qorpera_folder_member_allowed(p_environment_id, v_file.profile_id, v_actor_id, v_path, 'write');
			elsif v_op = 'new_folder' then
				v_ok := public.qorpera_folder_member_keys_allowed(p_environment_id, v_file.profile_id, v_actor_id, v_path,
					array(select public.qorpera_company_path_key(v_path || '/' || (c.value ->> 'path'))
						from jsonb_array_elements(v_unit -> 'contents') c), 'write');
			elsif v_op = 'delete' then
				v_ok := public.qorpera_folder_member_subtree_allowed(p_environment_id, v_file.profile_id, v_actor_id,
					v_key, v_path, 'write');
			elsif v_op in ('move','copy') then
				v_ok := public.qorpera_folder_member_subtree_allowed(p_environment_id, v_file.profile_id, v_actor_id,
						v_key, v_path, case when v_op = 'copy' then 'read' else 'write' end)
					and public.qorpera_folder_member_subtree_allowed(p_environment_id, v_file.profile_id, v_actor_id,
						v_key, v_to, 'write');
			end if;
			if not v_ok then v_reason := 'denied'; end if;
		end if;

		if v_ok and v_op = 'write' then
			if v_unit ? 'expectedVersion' and v_unit -> 'expectedVersion' <> 'null'::jsonb then
				if v_row.kind is distinct from 'file' or v_row.version::text is distinct from v_unit ->> 'expectedVersion' then
					v_ok := false; v_reason := 'version_changed'; end if;
			elsif v_row.kind is not null then
				v_ok := false; v_reason := 'exists';
			end if;
		elsif v_ok and v_op = 'mkdir' then
			if v_row.kind is not null then v_ok := false; v_reason := 'exists'; end if;
		elsif v_ok and v_op = 'new_folder' then
			-- Contents: no duplicate keys, each parent a folder inside the unit, valid files, nothing already there.
			-- Keys are computed once and matched by hash, not per pair.
			with c as materialized (
				select value, value ->> 'kind' as kind, public.qorpera_company_path_key(value ->> 'path') as key,
					public.qorpera_company_path_key(public.qorpera_folder_parent_path(value ->> 'path')) as parent_key
				from jsonb_array_elements(v_unit -> 'contents')
			)
			select exists (select 1 from c group by key having count(*) > 1)
				or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file')
				or exists (select 1 from c where parent_key is not null
					and not exists (select 1 from c as p where p.kind = 'folder' and p.key = c.parent_key))
				or exists (select 1 from c where kind = 'file'
					and (jsonb_typeof(value -> 'file') is distinct from 'object'
						or jsonb_typeof(value -> 'file' -> 'executable') is distinct from 'boolean'
						or coalesce(value -> 'file' ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
						or coalesce(value -> 'file' ->> 'bytes', '') !~ '^[0-9]{1,15}$'))
			into v_invalid;
			if v_row.kind is not null then v_ok := false; v_reason := 'exists';
			elsif v_invalid then
				v_ok := false; v_reason := 'invalid';
			elsif exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c where c.value ->> 'kind' = 'file'
				and not exists (select 1 from public.qorpera_verified_company_file_objects v
					where v.profile_id = v_file.profile_id and v.manifest_sha256 = c.value -> 'file' ->> 'manifestSha256'
						and v.file_sha256 = c.value -> 'file' ->> 'fileSha256'
						and v.bytes = (c.value -> 'file' ->> 'bytes')::bigint)) then
				v_ok := false; v_reason := 'bytes_unverified';
			elsif exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key)) then
				v_ok := false; v_reason := 'exists';
			end if;
		elsif v_ok and v_op in ('delete','move','copy') then
			if v_row.kind is null then
				v_ok := false; v_reason := 'missing';
			elsif (v_op <> 'copy' or v_unit ? 'expectedVersion') and v_row.version::text is distinct from v_unit ->> 'expectedVersion' then
				v_ok := false; v_reason := 'version_changed';
			elsif v_row.kind = 'folder' then
				-- A subtree delete or move refuses a change its writer did not see (core §3, units).
				v_as_of := case when v_unit ->> 'asOfSeq' ~ '^[0-9]{1,18}$' then (v_unit ->> 'asOfSeq')::bigint end;
				if v_op <> 'copy' and v_as_of is null then
					v_ok := false; v_reason := 'as_of_seq_required';
				elsif v_op <> 'copy' and exists (select 1 from public.qorpera_folder_entries e
					join public.qorpera_folder_commits c on c.id = e.commit_id
					where e.environment_id = p_environment_id and e.kind <> 'claim'
						and (e.key_sha256 = v_row.key_sha256 or e.key_text like public.qorpera_folder_under(v_key))
						and c.seq > v_as_of) then
					v_ok := false; v_reason := 'unseen_change';
				elsif (select count(*) from (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key) limit c_subtree_bound + 1) s) > c_subtree_bound then
					v_ok := false; v_reason := 'too_large';
				end if;
			end if;
		end if;
		if v_ok and v_to is not null then
			select * into v_target from public.qorpera_folder_entries
			where environment_id = p_environment_id and key_sha256 = extensions.digest(v_to_key, 'sha256') and kind <> 'claim';
			if found and (v_op = 'copy' or v_to_key <> v_key) then
				v_ok := false; v_reason := 'exists';
			elsif v_to_key like public.qorpera_folder_under(v_key) then
				v_ok := false; v_reason := 'into_itself';
			end if;
		end if;
		-- A missing parent is refused unless an earlier unit of this change set made it.
		if v_ok and v_op in ('write','mkdir','new_folder','move','copy') and v_parent is not null and v_parent_row.path is null then
			v_ok := false; v_reason := 'parent_missing';
		end if;
		-- Every path the unit produces stays within the path limit, spelled as it will be stored.
		if v_ok and (octet_length(coalesce(v_eff_to, v_eff_path)) > 4096
			or (v_op in ('move','copy') and v_row.kind = 'folder' and octet_length(v_eff_to) - octet_length(v_row.path)
				+ coalesce((select max(octet_length(e.path)) from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key)), 0) > 4096)
			or (v_op = 'new_folder' and exists (select 1 from public.qorpera_folder_spelled_contents(v_eff_path, v_unit -> 'contents') c
				where octet_length(c.path) > 4096))) then
			v_ok := false; v_reason := 'too_long';
		end if;
		-- Bytes (step 6): a written file must be verified content of this company. Its manifest object is held
		-- KEY SHARE; the full reference invariants of core §8 arrive with C1d.
		if v_ok and v_op = 'write' then
			v_file_json := v_unit -> 'file';
			if jsonb_typeof(v_file_json -> 'executable') is distinct from 'boolean'
				or coalesce(v_file_json ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
				or coalesce(v_file_json ->> 'bytes', '') !~ '^[0-9]{1,15}$' then
				v_ok := false; v_reason := 'invalid';
			elsif not exists (select 1 from public.qorpera_verified_company_file_objects
				where profile_id = v_file.profile_id and manifest_sha256 = v_file_json ->> 'manifestSha256'
					and file_sha256 = v_file_json ->> 'fileSha256' and bytes = (v_file_json ->> 'bytes')::bigint) then
				v_ok := false; v_reason := 'bytes_unverified';
			else
				perform 1 from public.qorpera_profile_objects o where o.profile_id = v_file.profile_id
					and o.sha256 = v_file_json ->> 'manifestSha256' for key share;
				if not found then v_ok := false; v_reason := 'bytes_unverified'; end if;
			end if;
		end if;

		if v_ok then
			if not v_committed then
				insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id,
					requester_kind, requester_id, units)
				values (v_commit_id, p_environment_id, p_operation_key, v_actor_kind, v_actor_id, v_actor_kind, v_actor_id, '[]');
				v_committed := true;
			end if;
			v_version := public.qorpera_folder_apply_unit(p_environment_id, v_commit_id, v_no, v_op, v_eff_path, v_eff_to, v_unit);
			v_saved := v_saved + 1;
		end if;
		v_outcomes := v_outcomes || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('unit', v_no, 'op', v_op,
			'path', case when v_ok and v_op not in ('move','copy') then v_eff_path else v_path end,
			'to', case when v_ok then v_eff_to else v_to end, 'version', v_version,
			'outcome', case when v_ok then 'saved' when v_reason = 'denied' then 'denied'
				when v_reason in ('version_changed','exists','unseen_change','missing') then 'conflict' else 'refused' end,
			'reason', v_reason)));
	end loop;

	-- Claims that did not become live never outlive the transaction.
	delete from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.kind = 'claim'
		and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));

	if v_saved = 0 then
		insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id,
			requester_kind, requester_id, units)
		values (v_commit_id, p_environment_id, p_operation_key, v_actor_kind, v_actor_id, v_actor_kind, v_actor_id, v_outcomes);
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',null,'replay',false,
			'units',v_outcomes);
	end if;

	-- Step 11. The clock, last. Sequence order is commit order; an abort rolls the increment back.
	update public.qorpera_folder_clocks set last_seq = last_seq + 1 where environment_id = p_environment_id
	returning last_seq into v_seq;
	update public.qorpera_folder_commits set seq = v_seq, units = v_outcomes where id = v_commit_id;
	insert into public.qorpera_folder_journal(environment_id, seq, kind, commit_id)
	values (p_environment_id, v_seq, 'change_set', v_commit_id);
	return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',v_seq,'replay',false,
		'units',v_outcomes);
end $$;

-- 8. Reads without the company lock ---------------------------------------------------------------------

-- One statement answers, so the entry and asOfSeq come from the same snapshot (core §4). No job, fence,
-- profile or Company File lock is taken. An unreadable path answers exactly like a missing one.
create function public.qorpera_folder_read(p_environment_id uuid, p_actor jsonb, p_path text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_kind text := p_actor ->> 'kind'; v_user uuid; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if v_kind = 'member' then v_user := (p_actor ->> 'userId')::uuid;
	elsif v_kind is distinct from 'platform' then raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if not public.qorpera_company_path_valid(p_path) then raise exception 'Path is invalid' using errcode = '22023'; end if;
	select jsonb_build_object('schema','qorpera.folder-read/v1','asOfSeq',k.last_seq,
			'found', e.path is not null,
			'entry', case when e.path is not null then public.qorpera_folder_entry_json(e.path, e.kind, e.version, c.seq,
				e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable) end)
	into v_result
	from public.qorpera_company_files f
	join public.qorpera_folder_clocks k on k.environment_id = f.environment_id
	left join public.qorpera_folder_entries e on e.environment_id = f.environment_id and e.kind <> 'claim'
		and e.key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path), 'sha256')
		and (v_kind = 'platform' or public.qorpera_folder_member_allowed(f.environment_id, f.profile_id, v_user, p_path, 'read'))
	left join public.qorpera_folder_commits c on c.id = e.commit_id
	where f.environment_id = p_environment_id and f.core = 'folder-v2';
	if v_result is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	return v_result;
end $$;

-- Lists a folder's children, or its whole subtree, in key order after a key cursor. Unreadable names are
-- hidden. The page and its asOfSeq come from one statement; a client lists, then follows the journal from
-- the first page's asOfSeq.
create function public.qorpera_folder_list(p_environment_id uuid, p_actor jsonb, p_parent text, p_after text,
	p_limit integer, p_recursive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_kind text := p_actor ->> 'kind'; v_user uuid; v_parent_key text; v_under text; v_after text; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if v_kind = 'member' then v_user := (p_actor ->> 'userId')::uuid;
	elsif v_kind is distinct from 'platform' then raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if p_limit is null or p_limit not between 1 and 1000 or not public.qorpera_company_path_valid(coalesce(p_parent, ''), true)
		or (p_after is not null and not public.qorpera_company_path_valid(p_after)) then
		raise exception 'Listing is invalid' using errcode = '22023'; end if;
	v_parent_key := public.qorpera_company_path_key(coalesce(p_parent, ''));
	v_under := case when v_parent_key = '' then '%' else public.qorpera_folder_under(v_parent_key) end;
	v_after := case when p_after is not null then public.qorpera_company_path_key(p_after) end;
	with page as (
		select e.*, c.seq as commit_seq from public.qorpera_folder_entries e
		join public.qorpera_folder_commits c on c.id = e.commit_id
		join public.qorpera_company_files f on f.environment_id = e.environment_id
		where e.environment_id = p_environment_id and f.core = 'folder-v2' and e.kind <> 'claim'
			and (p_recursive or e.parent_key_sha256 = extensions.digest(v_parent_key, 'sha256'))
			and (not p_recursive or e.key_text like v_under)
			and (v_after is null or e.key_text > v_after)
			and (v_kind = 'platform' or public.qorpera_folder_member_allowed(p_environment_id, f.profile_id, v_user, e.path, 'read'))
		order by e.key_text limit p_limit
	)
	select jsonb_build_object('schema','qorpera.folder-list/v1', 'asOfSeq', k.last_seq,
		'entries', coalesce((select jsonb_agg(public.qorpera_folder_entry_json(p.path, p.kind, p.version, p.commit_seq,
			p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable) order by p.key_text) from page p), '[]'::jsonb),
		'next', case when (select count(*) from page) = p_limit
			then (select p.path from page p order by p.key_text desc limit 1) end)
	into v_result
	from public.qorpera_folder_clocks k join public.qorpera_company_files f on f.environment_id = k.environment_id
	where k.environment_id = p_environment_id and f.core = 'folder-v2';
	if v_result is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	return v_result;
end $$;

-- 9. Grants ---------------------------------------------------------------------------------------------

revoke all on function public.qorpera_company_file_core_guard(), public.qorpera_folder_parent_path(text),
	public.qorpera_folder_ancestors(text), public.qorpera_folder_path_reserved(text), public.qorpera_folder_under(text),
	public.qorpera_folder_member_allowed(uuid,uuid,uuid,text,text),
	public.qorpera_folder_member_keys_allowed(uuid,uuid,uuid,text,text[],text),
	public.qorpera_folder_member_subtree_allowed(uuid,uuid,uuid,text,text,text),
	public.qorpera_folder_entry_json(text,text,uuid,bigint,text,text,bigint,text,boolean),
	public.qorpera_folder_spelled_contents(text,jsonb),
	public.qorpera_folder_lock_path(uuid,text,text),
	public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_enable(uuid), public.qorpera_folder_commit(uuid,jsonb,text,jsonb),
	public.qorpera_folder_read(uuid,jsonb,text), public.qorpera_folder_list(uuid,jsonb,text,text,integer,boolean)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_enable(uuid), public.qorpera_folder_commit(uuid,jsonb,text,jsonb),
	public.qorpera_folder_read(uuid,jsonb,text), public.qorpera_folder_list(uuid,jsonb,text,text,integer,boolean)
	to service_role;
