-- Company folder core, slice P18a: permanent erasure of deleted paths (deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md;
-- contract 5.6, the 2026-10-02 amendment "work for people" item 3, core §8). The coordinator's decisions of 3 October
-- 2026 (#732): P18a erases any path outside agents/, rules/ and tables/ (P18b), deletes the contact, human-task and
-- connection index rows built from erased files, scrubs path names from change sets and the tool output and reviewed
-- cards of ended runs that quoted them, and keeps attribution, member ids and read records.
--
-- * The request (qorpera_folder_erase) is one short transaction in the commit's lock order: the company row KEY SHARE
--   (rank 0), the member (rank 1), the human-task and contact rows to delete (rank 5), every root FOR UPDATE with its
--   ancestors KEY SHARE (paths), then each root's cutoff, the connection rows (where the commit's apply takes them) and
--   the writes. A live root keeps its current life: only the lives before it are erased. A file's history is erased
--   whole through its moves: the request refuses roots that are not closed under moves, naming the paths to add.
-- * The drain (qorpera_folder_erasure_step) runs every 5 seconds from pg_cron, one bounded step per tick: versions,
--   change sets, the runs that read an erased version, those runs' receipts and reviewed cards, then the bytes, which
--   folder GC collects once nothing else roots them (C1D §9.4).
-- No fence, no folder clock, no profile row stronger than KEY SHARE; every wait at most 2 s; no 40001 (test 361).
-- Inert until the member route (C4) calls the request; the drain finds nothing to do before that.

set local lock_timeout = '3s';

-- 1. Tables ------------------------------------------------------------------------------------------------------------

create table public.qorpera_folder_erasures (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	operation_key text not null check (operation_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
	-- The request (actor and root keys), compared on a replay; dropped once done.
	request_sha256 text check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$'),
	requested_by_user_id uuid not null,
	requested_at timestamptz not null default clock_timestamp(),
	as_of_seq bigint not null check (as_of_seq >= 0),
	as_of_at timestamptz not null,
	-- [{key, cutoffSeq, cutoffUnit, cutoffAt}]: every row at or under key strictly before (cutoffSeq, cutoffUnit) is
	-- erased. Dropped once done.
	roots jsonb check (roots is null or jsonb_typeof(roots) = 'array'),
	-- The first erased version's time: where the read-record walk starts.
	first_erased_at timestamptz,
	state text not null default 'working' check (state in ('working','waiting','done')),
	phase smallint not null default 1 check (phase between 1 and 6),
	revisit_at timestamptz,
	cursor jsonb not null default '{}'::jsonb,
	counts jsonb not null default '{}'::jsonb,
	bytes_pending boolean not null default false,
	-- What the request answered, for a replay.
	reply jsonb not null,
	done_at timestamptz,
	unique (environment_id, operation_key),
	check ((state = 'done') = (done_at is not null)),
	check (state = 'done' or (request_sha256 is not null and roots is not null)),
	check ((state = 'waiting') = (revisit_at is not null))
);
create index qorpera_folder_erasures_due on public.qorpera_folder_erasures(state, revisit_at, requested_at) where done_at is null;

-- Each erased path's written spellings and their first 100 characters, with the cutoff of the root they lie under:
-- what phases 2 and 4 blank in text.
create table public.qorpera_folder_erasure_needles (
	erasure_id uuid not null references public.qorpera_folder_erasures(id) on delete cascade,
	needle text not null check (char_length(needle) between 1 and 4096),
	cutoff_seq bigint not null,
	cutoff_unit integer not null,
	cutoff_at timestamptz not null,
	primary key (erasure_id, needle)
);

-- The runs whose receipts and reviewed cards phase 4 scrubs: 'noted', then 'done', or 'pending' while the run is live
-- or a card of it is still open.
create table public.qorpera_folder_erasure_runs (
	erasure_id uuid not null references public.qorpera_folder_erasures(id) on delete cascade,
	run_id uuid not null,
	state text not null default 'noted' check (state in ('noted','pending','done')),
	primary key (erasure_id, run_id)
);

-- Manifests and chunks whose roots an erasure ended, waiting for phase 5.
create table public.qorpera_folder_erasure_hashes (
	erasure_id uuid not null references public.qorpera_folder_erasures(id) on delete cascade,
	sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
	primary key (erasure_id, sha256)
);

alter table public.qorpera_folder_erasures enable row level security;
alter table public.qorpera_folder_erasure_needles enable row level security;
alter table public.qorpera_folder_erasure_runs enable row level security;
alter table public.qorpera_folder_erasure_hashes enable row level security;
revoke all on public.qorpera_folder_erasures, public.qorpera_folder_erasure_needles, public.qorpera_folder_erasure_runs,
	public.qorpera_folder_erasure_hashes from public, anon, authenticated, service_role;

-- 2. Indexes ------------------------------------------------------------------------------------------------------------

-- Versions by folded key, so a subtree's history is one range (an expression index: no table rewrite). Core §2's
-- PostgreSQL upgrade step reindexes it with the other folder keys.
create index qorpera_folder_path_versions_key_text
	on public.qorpera_folder_path_versions(environment_id, (public.qorpera_folder_key(path)) collate "C");
-- The manifests a chunk belongs to, read from the manifest side (the GC finish's cascade needs it too).
create index qorpera_folder_file_chunks_manifest on public.qorpera_folder_file_chunks(profile_id, manifest_sha256);
-- Change sets that saved nothing, by time (saved ones are walked by seq).
create index qorpera_folder_commits_unsaved on public.qorpera_folder_commits(environment_id, created_at, id) where seq is null;
-- Read records by time, for the runs that read an erased version.
create index qorpera_folder_run_read_records_time on public.qorpera_folder_run_read_records(environment_id, created_at);

-- 3. Helpers -----------------------------------------------------------------------------------------------------------

-- Whether a folded key is at or under a root key. Under means after '<root>/' and before '<root>0' in byte order ('0'
-- follows '/'), a range the key index serves.
create function public.qorpera_folder_erasure_covers(p_root text, p_key text)
returns boolean language sql immutable set search_path = '' as $$
	select p_key collate "C" = p_root collate "C"
		or (p_key collate "C" >= (p_root || '/') collate "C" and p_key collate "C" < (p_root || '0') collate "C")
$$;

-- Whether a position (seq, unit) lies strictly before a root's cutoff.
create function public.qorpera_folder_erasure_before(p_root jsonb, p_seq bigint, p_unit integer)
returns boolean language sql immutable set search_path = '' as $$
	select p_seq < (p_root ->> 'cutoffSeq')::bigint
		or (p_seq = (p_root ->> 'cutoffSeq')::bigint and p_unit < (p_root ->> 'cutoffUnit')::integer)
$$;

-- A live key's current life's start: the latest row at the key that starts a life (a write or mkdir with no prior, a
-- copy, or a move_in whose move_out is at another key; a same-key move, a case-only rename, continues the life).
create function public.qorpera_folder_erasure_life_start(p_environment_id uuid, p_key text)
returns table (seq bigint, unit_no integer, at timestamptz, version uuid)
language sql stable security definer set search_path = '' as $$
	select c.seq, v.unit_no, c.created_at, v.version
	from public.qorpera_folder_path_versions v
	join public.qorpera_folder_commits c on c.id = v.commit_id
	where v.environment_id = p_environment_id and v.key_sha256 = extensions.digest(p_key, 'sha256') and c.seq is not null
		and ((v.op in ('write','mkdir') and v.prior_version is null) or v.op = 'copy'
			or (v.op = 'move_in' and not exists (select 1 from public.qorpera_folder_path_versions o
				where o.commit_id = v.commit_id and o.unit_no = v.unit_no and o.prior_version = v.prior_version
					and o.op = 'move_out' and o.key_sha256 = v.key_sha256)))
	order by c.seq desc, v.unit_no desc
	limit 1
$$;

-- A root's cutoff as the request sees it: a deleted key's is (as of, end); a live key's is its current life's start.
create function public.qorpera_folder_erasure_cutoff(p_environment_id uuid, p_key text, p_as_of bigint, p_as_of_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_start record;
begin
	if not exists (select 1 from public.qorpera_folder_entries where environment_id = p_environment_id
			and key_sha256 = extensions.digest(p_key, 'sha256') and kind <> 'claim') then
		return jsonb_build_object('key', p_key, 'live', false, 'cutoffSeq', p_as_of, 'cutoffUnit', 2147483647,
			'cutoffAt', p_as_of_at);
	end if;
	select * into v_start from public.qorpera_folder_erasure_life_start(p_environment_id, p_key);
	return jsonb_build_object('key', p_key, 'live', true, 'cutoffSeq', coalesce(v_start.seq, 0),
		'cutoffUnit', coalesce(v_start.unit_no, 0), 'cutoffAt', coalesce(v_start.at, '-infinity'::timestamptz));
end $$;

-- The open partners of the moves under a set of roots (ERASURE.md §2.3): a move row under a root before its cutoff
-- whose partner (the other move op of the same commit, unit and prior) is under no root before that root's cutoff. A
-- partner already erased has no row and is closed.
create function public.qorpera_folder_erasure_open_moves(p_environment_id uuid, p_roots jsonb)
returns table (op text, partner_path text, partner_key text, seq bigint, unit_no integer, partner_version uuid)
language sql stable security definer set search_path = '' as $$
	with roots as (select r from jsonb_array_elements(p_roots) r),
	moves as (
		select distinct v.op, v.commit_id, v.unit_no, v.prior_version, c.seq
		from roots
		join public.qorpera_folder_path_versions v on v.environment_id = p_environment_id
			and public.qorpera_folder_erasure_covers(roots.r ->> 'key', public.qorpera_folder_key(v.path))
		join public.qorpera_folder_commits c on c.id = v.commit_id
		where v.op in ('move_in','move_out') and c.seq is not null
			and public.qorpera_folder_erasure_before(roots.r, c.seq, v.unit_no)
	)
	select m.op, p.path, public.qorpera_folder_key(p.path), m.seq, m.unit_no, p.version
	from moves m
	join public.qorpera_folder_path_versions p on p.commit_id = m.commit_id and p.unit_no = m.unit_no
		and p.prior_version = m.prior_version and p.op = case m.op when 'move_in' then 'move_out' else 'move_in' end
	where not exists (select 1 from roots
		where public.qorpera_folder_erasure_covers(roots.r ->> 'key', public.qorpera_folder_key(p.path))
			and public.qorpera_folder_erasure_before(roots.r, m.seq, m.unit_no))
$$;

-- Text with every needle that applies blanked: '' when any needle occurs in it.
create function public.qorpera_folder_erasure_hit(p_text text, p_needles text[])
returns boolean language sql immutable set search_path = '' as $$
	select p_text is not null and exists (select 1 from unnest(p_needles) n where strpos(p_text, n) > 0)
$$;

-- One change set's units with erased path names gone (ERASURE.md §4.3, phase 2). A unit whose path or target lies at
-- or under a root it is before the cutoff of gets "" there and loses its problems (they may quote the file's
-- content); in any other unit, a problem message holding an applicable needle becomes "". Null when nothing changes.
create function public.qorpera_folder_erasure_units(p_units jsonb, p_seq bigint, p_created_at timestamptz, p_roots jsonb,
	p_needles jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_unit jsonb; v_out jsonb := '[]'::jsonb; v_changed boolean := false; v_no integer; v_hit boolean;
	v_path_hit boolean; v_to_hit boolean; v_needles text[]; v_problem jsonb; v_problems jsonb;
begin
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_no := coalesce((v_unit ->> 'unit')::integer, 0);
		-- A root applies to a saved unit before its cutoff position, or to an unsaved change set made before its time.
		select coalesce(bool_or(public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v_unit ->> 'path'))), false),
			coalesce(bool_or(v_unit ? 'to' and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v_unit ->> 'to'))), false)
		into v_path_hit, v_to_hit
		from jsonb_array_elements(p_roots) r
		where case when p_seq is null then p_created_at < (r ->> 'cutoffAt')::timestamptz
			else public.qorpera_folder_erasure_before(r, p_seq, v_no) end;
		if v_path_hit or v_to_hit then
			if v_path_hit then v_unit := jsonb_set(v_unit, '{path}', '""'::jsonb); end if;
			if v_to_hit then v_unit := jsonb_set(v_unit, '{to}', '""'::jsonb); end if;
			v_unit := v_unit - 'problems';
			v_changed := true;
		elsif jsonb_typeof(v_unit -> 'problems') = 'array' then
			select coalesce(array_agg(n ->> 'needle'), '{}') into v_needles from jsonb_array_elements(p_needles) n
			where case when p_seq is null then p_created_at < (n ->> 'cutoffAt')::timestamptz
				else p_seq < (n ->> 'cutoffSeq')::bigint
					or (p_seq = (n ->> 'cutoffSeq')::bigint and v_no < (n ->> 'cutoffUnit')::integer) end;
			if cardinality(v_needles) > 0 then
				v_problems := '[]'::jsonb; v_hit := false;
				for v_problem in select value from jsonb_array_elements(v_unit -> 'problems') loop
					if public.qorpera_folder_erasure_hit(v_problem ->> 'message', v_needles) then
						v_problem := jsonb_set(v_problem, '{message}', '""'::jsonb); v_hit := true; end if;
					v_problems := v_problems || jsonb_build_array(v_problem);
				end loop;
				if v_hit then v_unit := jsonb_set(v_unit, '{problems}', v_problems); v_changed := true; end if;
			end if;
		end if;
		v_out := v_out || jsonb_build_array(v_unit);
	end loop;
	return case when v_changed then v_out end;
end $$;

-- 4. The request ---------------------------------------------------------------------------------------------------------

create function public.qorpera_folder_erase(p_environment_id uuid, p_actor jsonb, p_paths jsonb, p_operation_key text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_key_bound constant integer := 2600;
	v_profile uuid; v_user uuid; v_role public.qorpera_profile_role;
	v_keys text[] := '{}'; v_spellings jsonb := '{}'::jsonb; v_path text; v_key text; v_other text;
	v_digest text; v_existing public.qorpera_folder_erasures%rowtype;
	v_tasks uuid[]; v_contacts uuid[]; v_connections uuid[];
	v_locks jsonb := '{}'::jsonb; v_lock record; v_claims text[] := '{}'; v_ancestor text;
	v_as_of bigint; v_as_of_at timestamptz; v_roots jsonb := '[]'::jsonb; v_root jsonb;
	v_work jsonb; v_added jsonb; v_live jsonb; v_open record; v_start record; v_grew boolean;
	v_counts jsonb := '[]'::jsonb; v_versions bigint; v_copies jsonb; v_reply jsonb; v_id uuid := extensions.gen_random_uuid();
begin
	-- 1. Checks, before any lock (ERASURE.md §3).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder erasure runs at read committed' using errcode = '25000'; end if;
	if coalesce(p_operation_key, '') !~ '^[A-Za-z0-9._:-]{8,200}$' then
		raise exception 'Operation key is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '22023'; end if;
	if p_actor ->> 'kind' is distinct from 'member' or p_actor - array['kind','userId'] <> '{}'::jsonb
		or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Only a member erases' using errcode = '22023'; end if;
	v_user := (p_actor ->> 'userId')::uuid;
	if jsonb_typeof(p_paths) is distinct from 'array' or jsonb_array_length(p_paths) not between 1 and 20 then
		raise exception 'Erasure paths are invalid' using errcode = '22023'; end if;
	for v_path in select value #>> '{}' from jsonb_array_elements(p_paths) loop
		if v_path is null or v_path = '' or not public.qorpera_company_path_valid(v_path) then
			raise exception 'Erasure path is invalid' using errcode = '22023'; end if;
		v_key := public.qorpera_folder_key(v_path);
		if octet_length(v_key) > c_key_bound then raise exception 'Erasure path is too long' using errcode = '22023'; end if;
		if split_part(v_key, '/', 1) in ('agents','rules','tables') then
			raise exception 'Erasing agents/, rules/ and tables/ is not available yet' using errcode = '0A000'; end if;
		-- A member's private paths are that member's alone (contract 4.3).
		if split_part(v_key, '/', 1) = 'members' and split_part(v_key, '/', 2) is distinct from v_user::text then
			raise exception 'Another member''s private paths are theirs alone' using errcode = '42501'; end if;
		foreach v_other in array v_keys loop
			if public.qorpera_folder_erasure_covers(v_other, v_key) or public.qorpera_folder_erasure_covers(v_key, v_other) then
				raise exception 'An erasure path lies inside another' using errcode = '22023'; end if;
		end loop;
		v_keys := v_keys || v_key;
		v_spellings := v_spellings || jsonb_build_object(v_key, v_path);
	end loop;
	v_keys := array(select k from unnest(v_keys) k order by k collate "C");
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('userId', v_user, 'roots', to_jsonb(v_keys))::text, 'utf8'),
		'sha256'), 'hex');
	-- A replay answers what the first request answered; the same key with other paths is refused, as the commit's.
	select * into v_existing from public.qorpera_folder_erasures where environment_id = p_environment_id and operation_key = p_operation_key;
	if found then
		if v_existing.request_sha256 is not null and v_existing.request_sha256 <> v_digest then
			raise exception 'Operation key was used for another erasure' using errcode = '22023'; end if;
		return v_existing.reply;
	end if;
	-- The retired human-task and contact rows under the roots, for rank 5 (a plain read; read again after the paths).
	select coalesce(array_agg(i.id order by i.environment_id::text || ':' || i.id::text collate "C"), '{}') into v_tasks
	from public.qorpera_folder_human_task_index i where i.environment_id = p_environment_id and i.retired_at is not null
		and exists (select 1 from unnest(v_keys) k where public.qorpera_folder_erasure_covers(k, i.folder_key));
	select coalesce(array_agg(i.id order by i.environment_id::text || ':' || i.id::text collate "C"), '{}') into v_contacts
	from public.qorpera_folder_contact_index i where i.environment_id = p_environment_id and i.retired_at is not null
		and exists (select 1 from unnest(v_keys) k where public.qorpera_folder_erasure_covers(k, i.folder_key));

	-- 2. Rank 0: the company row KEY SHARE; a company being deleted is purged whole.
	perform 1 from public.qorpera_profiles where id = v_profile for key share;
	if public.qorpera_company_deleting(v_profile) then
		raise exception 'The company is being deleted' using errcode = '55000'; end if;
	-- 3. Rank 1: owners and admins erase.
	v_role := public.qorpera_folder_mutator_role(v_profile, p_actor);
	if v_role not in ('owner','admin') then raise exception 'Only owners and admins erase' using errcode = '42501'; end if;
	-- 4. Rank 5, in qorpera_folder_structured_lock's table order (human tasks, then contacts), by key: the rows to delete.
	perform 1 from public.qorpera_folder_human_task_index i where i.environment_id = p_environment_id and i.id = any(v_tasks)
	order by i.environment_id::text || ':' || i.id::text collate "C" for update;
	perform 1 from public.qorpera_folder_contact_index i where i.environment_id = p_environment_id and i.id = any(v_contacts)
	order by i.environment_id::text || ':' || i.id::text collate "C" for update;
	-- 5. Paths: every root FOR UPDATE and every ancestor KEY SHARE, claiming absent keys, in one key order.
	foreach v_key in array v_keys loop
		v_path := v_spellings ->> v_key;
		foreach v_ancestor in array public.qorpera_folder_ancestors(v_path) loop
			if not v_locks ? public.qorpera_folder_key(v_ancestor) then
				v_locks := v_locks || jsonb_build_object(public.qorpera_folder_key(v_ancestor),
					jsonb_build_object('path', v_ancestor, 'mode', 'keyshare'));
			end if;
		end loop;
		v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_path, 'mode', 'update'));
	end loop;
	for v_lock in select l.key collate "C" as key, l.value ->> 'path' as path, l.value ->> 'mode' as mode
		from jsonb_each(v_locks) l order by l.key collate "C" loop
		if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_lock.mode) then v_claims := v_claims || v_lock.key; end if;
	end loop;

	-- 6. As of: every change under a held root has committed, and each root's cutoff.
	select last_seq into v_as_of from public.qorpera_folder_clocks where environment_id = p_environment_id;
	v_as_of_at := clock_timestamp();
	foreach v_key in array v_keys loop
		v_roots := v_roots || jsonb_build_array(public.qorpera_folder_erasure_cutoff(p_environment_id, v_key, v_as_of, v_as_of_at));
	end loop;
	-- A rank-5 row that became retired under a root since the plain read (a delete between step 1 and step 5) was not
	-- locked at its rank: the member route asks again.
	if exists (select 1 from public.qorpera_folder_human_task_index i where i.environment_id = p_environment_id
			and i.retired_at is not null and not i.id = any(v_tasks)
			and exists (select 1 from unnest(v_keys) k where public.qorpera_folder_erasure_covers(k, i.folder_key)))
		or exists (select 1 from public.qorpera_folder_contact_index i where i.environment_id = p_environment_id
			and i.retired_at is not null and not i.id = any(v_contacts)
			and exists (select 1 from unnest(v_keys) k where public.qorpera_folder_erasure_covers(k, i.folder_key))) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message',
			'Company folder changed while the erasure began; retry', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}';
	end if;
	-- A live root with no earlier life has nothing to erase.
	for v_root in select value from jsonb_array_elements(v_roots) loop
		select count(*) into v_versions from public.qorpera_folder_path_versions v
		join public.qorpera_folder_commits c on c.id = v.commit_id
		where v.environment_id = p_environment_id
			and public.qorpera_folder_erasure_covers(v_root ->> 'key', public.qorpera_folder_key(v.path))
			and public.qorpera_folder_erasure_before(v_root, c.seq, v.unit_no);
		if (v_root ->> 'live')::boolean and v_versions = 0 then
			raise exception 'Nothing to erase at %', v_spellings ->> (v_root ->> 'key') using errcode = '22023'; end if;
		v_counts := v_counts || jsonb_build_array(jsonb_build_object('path', v_spellings ->> (v_root ->> 'key'),
			'cutoffSeq', (v_root ->> 'cutoffSeq')::bigint, 'cutoffUnit', (v_root ->> 'cutoffUnit')::integer, 'versions', v_versions));
	end loop;
	-- §2.4: an unrevoked path resource at or under a deleted root is revoked first (a live root's governs its current file).
	if exists (select 1 from public.qorpera_company_path_resources r join jsonb_array_elements(v_roots) x on not (x ->> 'live')::boolean
			where r.environment_id = p_environment_id and r.revoked_at is null and r.path <> ''
				and public.qorpera_folder_erasure_covers(x ->> 'key', public.qorpera_folder_key(r.path))) then
		raise exception 'A path permission covers what would be erased; revoke it first' using errcode = '22023'; end if;
	-- §2.3: closed under moves. The chain is followed here; if it reaches paths not named, the request is refused with
	-- them (topmost first), and with any live file a history was moved into.
	v_work := v_roots; v_added := '[]'::jsonb; v_live := '[]'::jsonb;
	loop
		v_grew := false;
		for v_open in select * from public.qorpera_folder_erasure_open_moves(p_environment_id, v_work) loop
			if v_open.op = 'move_out' then
				-- The file went on to a live key: moved, not deleted, when that key's current life began with this move
				-- (or the key is a root whose current life holds it).
				select * into v_start from public.qorpera_folder_erasure_life_start(p_environment_id, v_open.partner_key);
				if exists (select 1 from public.qorpera_folder_entries where environment_id = p_environment_id
						and key_sha256 = extensions.digest(v_open.partner_key, 'sha256') and kind <> 'claim')
					and (v_start.version = v_open.partner_version
						or exists (select 1 from jsonb_array_elements(v_work) w where w ->> 'key' = v_open.partner_key)) then
					if not v_live @> jsonb_build_array(v_open.partner_path) then
						v_live := v_live || jsonb_build_array(v_open.partner_path); end if;
					continue;
				end if;
			end if;
			if not exists (select 1 from jsonb_array_elements(v_work) w where w ->> 'key' = v_open.partner_key) then
				v_work := v_work || jsonb_build_array(public.qorpera_folder_erasure_cutoff(p_environment_id, v_open.partner_key,
					v_as_of, v_as_of_at));
				v_added := v_added || jsonb_build_array(v_open.partner_path);
				v_grew := true;
			end if;
		end loop;
		exit when not v_grew or jsonb_array_length(v_added) >= 50;
	end loop;
	if jsonb_array_length(v_added) > 0 or jsonb_array_length(v_live) > 0 then
		raise exception 'This history continues at other paths' using errcode = '22023',
			detail = jsonb_build_object('add', (select coalesce(jsonb_agg(a order by a), '[]'::jsonb) from (
					select a.value #>> '{}' as a from jsonb_array_elements(v_added) a
					where not exists (select 1 from jsonb_array_elements(v_added) b
						where b.value <> a.value and public.qorpera_folder_erasure_covers(public.qorpera_folder_key(b.value #>> '{}'),
							public.qorpera_folder_key(a.value #>> '{}')))
					limit 20) t),
				'live', v_live)::text;
	end if;
	-- Copies: other files with an erased manifest (the empty file left out), so the member can name them too.
	select coalesce(jsonb_agg(distinct e.path), '[]'::jsonb) into v_copies from (
		select e.path from public.qorpera_folder_path_versions v
		join public.qorpera_folder_commits c on c.id = v.commit_id
		join jsonb_array_elements(v_roots) r on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v.path))
			and public.qorpera_folder_erasure_before(r, c.seq, v.unit_no)
		join public.qorpera_folder_entries e on e.environment_id = p_environment_id and e.kind = 'file'
			and e.manifest_sha256 = v.manifest_sha256 and e.bytes > 0
		where v.environment_id = p_environment_id and v.manifest_sha256 is not null
			and not exists (select 1 from jsonb_array_elements(v_roots) r2
				where public.qorpera_folder_erasure_covers(r2 ->> 'key', e.key_text))
		limit 20) e;
	-- 7. Connection rows, where the commit's apply takes them (after its paths).
	select coalesce(array_agg(i.secret_id order by i.secret_id), '{}') into v_connections
	from public.qorpera_folder_connection_index i
	join public.qorpera_folder_commits c on c.id = i.commit_id
	join jsonb_array_elements(v_roots) r on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(i.folder_path))
	where i.environment_id = p_environment_id and i.retired_at is not null and c.seq <= (r ->> 'cutoffSeq')::bigint;
	perform 1 from public.qorpera_folder_connection_index where secret_id = any(v_connections) order by secret_id for update;

	-- 8. Writes: the erasure and its needles, then the index rows, then the claims go.
	v_reply := jsonb_build_object('schema', 'qorpera.folder-erasure/v1', 'erasureId', v_id, 'asOfSeq', v_as_of,
		'roots', v_counts, 'copies', v_copies);
	insert into public.qorpera_folder_erasures(id, environment_id, profile_id, operation_key, request_sha256,
		requested_by_user_id, as_of_seq, as_of_at, roots, reply)
	values (v_id, p_environment_id, v_profile, p_operation_key, v_digest, v_user, v_as_of, v_as_of_at,
		(select jsonb_agg(r - 'live') from jsonb_array_elements(v_roots) r), v_reply);
	insert into public.qorpera_folder_erasure_needles(erasure_id, needle, cutoff_seq, cutoff_unit, cutoff_at)
	select v_id, n.needle, (r ->> 'cutoffSeq')::bigint, (r ->> 'cutoffUnit')::integer, (r ->> 'cutoffAt')::timestamptz
	from jsonb_array_elements(v_roots) r
	cross join lateral (values (v_spellings ->> (r ->> 'key')), (left(v_spellings ->> (r ->> 'key'), 100))) n(needle)
	on conflict do nothing;
	delete from public.qorpera_folder_human_task_index i using public.qorpera_folder_commits c, jsonb_array_elements(v_roots) r
	where i.environment_id = p_environment_id and i.id = any(v_tasks) and c.id = i.commit_id and i.retired_at is not null
		and public.qorpera_folder_erasure_covers(r ->> 'key', i.folder_key) and c.seq <= (r ->> 'cutoffSeq')::bigint;
	delete from public.qorpera_folder_contact_index i using public.qorpera_folder_commits c, jsonb_array_elements(v_roots) r
	where i.environment_id = p_environment_id and i.id = any(v_contacts) and c.id = i.commit_id and i.retired_at is not null
		and public.qorpera_folder_erasure_covers(r ->> 'key', i.folder_key) and c.seq <= (r ->> 'cutoffSeq')::bigint;
	delete from public.qorpera_folder_connection_index where secret_id = any(v_connections) and retired_at is not null;
	delete from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.kind = 'claim'
		and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));
	return v_reply;
end $$;

-- 5. The drain -----------------------------------------------------------------------------------------------------------

-- A card field blanked in its own JSON type, so every reader of an answered card still parses it.
create function public.qorpera_folder_erasure_blank(p_value jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select case jsonb_typeof(p_value) when 'string' then '"Erased."'::jsonb when 'object' then '{}'::jsonb
		when 'array' then '[]'::jsonb else p_value end
$$;

-- One bounded step of the oldest erasure that can go on (ERASURE.md §4.2, §4.3). pg_cron calls it every 5 seconds; it
-- checks no JWT role (none comes with pg_cron) and is revoked from every API role. Returns what it did.
create function public.qorpera_folder_erasure_step(p_versions integer default 1000, p_commits integer default 1000,
	p_hashes integer default 2000)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_candidate record; v_erasure public.qorpera_folder_erasures%rowtype; v_got boolean := false;
	v_batch jsonb; v_rows integer := 0; v_count integer := 0; v_hashes text[]; v_needles jsonb; v_commit record;
	v_units jsonb; v_cursor jsonb; v_record record; v_run record; v_ended boolean; v_left integer; v_bytes bigint := 0;
	v_raw text[]; v_escaped text[]; v_gc boolean; v_max_seq bigint; v_max_at timestamptz; v_hit integer; v_done integer;
begin
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder erasure runs at read committed' using errcode = '25000'; end if;
	-- Candidates: working erasures, then waiting ones due a revisit; none of a company being deleted (its purge removes
	-- them). The company row KEY SHARE first (the purge holds it FOR UPDATE: skip), then the erasure row.
	for v_candidate in select e.id, e.profile_id from public.qorpera_folder_erasures e
		where e.done_at is null and (e.state = 'working' or (e.state = 'waiting' and e.revisit_at <= clock_timestamp()))
			and not exists (select 1 from public.qorpera_company_deletions d where d.profile_id = e.profile_id)
		order by e.state = 'waiting', e.requested_at, e.id
		limit 20
	loop
		perform 1 from public.qorpera_profiles where id = v_candidate.profile_id for key share skip locked;
		if not found then continue; end if;
		select * into v_erasure from public.qorpera_folder_erasures where id = v_candidate.id for update skip locked;
		if not found or v_erasure.done_at is not null then continue; end if;
		v_got := true;
		exit;
	end loop;
	if not v_got then return jsonb_build_object('schema', 'qorpera.folder-erasure-step/v1', 'erasureId', null); end if;
	v_cursor := v_erasure.cursor;
	select max((r ->> 'cutoffSeq')::bigint), max((r ->> 'cutoffAt')::timestamptz) into v_max_seq, v_max_at
	from jsonb_array_elements(v_erasure.roots) r;

	if v_erasure.phase = 1 then
		-- Versions under each root before its cutoff: their hashes, spellings and runs kept, then the rows deleted.
		select coalesce(jsonb_agg(jsonb_build_object('version', b.version, 'path', b.path, 'commitId', b.commit_id,
				'manifest', b.manifest_sha256, 'at', b.created_at, 'root', b.root)), '[]'::jsonb)
		into v_batch from (
			select v.version, v.path, v.commit_id, v.manifest_sha256, v.created_at, r as root
			from jsonb_array_elements(v_erasure.roots) r
			join public.qorpera_folder_path_versions v on v.environment_id = v_erasure.environment_id
				and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v.path))
			join public.qorpera_folder_commits c on c.id = v.commit_id
			where public.qorpera_folder_erasure_before(r, c.seq, v.unit_no)
			limit p_versions) b;
		v_rows := jsonb_array_length(v_batch);
		insert into public.qorpera_folder_erasure_hashes(erasure_id, sha256)
		select distinct v_erasure.id, h from (
			select b ->> 'manifest' as h from jsonb_array_elements(v_batch) b where b ->> 'manifest' is not null
			union
			select ch.chunk_sha256 from jsonb_array_elements(v_batch) b
			join public.qorpera_folder_file_chunks ch on ch.profile_id = v_erasure.profile_id and ch.manifest_sha256 = b ->> 'manifest'
		) x
		on conflict do nothing;
		insert into public.qorpera_folder_erasure_needles(erasure_id, needle, cutoff_seq, cutoff_unit, cutoff_at)
		select distinct on (n.needle) v_erasure.id, n.needle, (b -> 'root' ->> 'cutoffSeq')::bigint,
			(b -> 'root' ->> 'cutoffUnit')::integer, (b -> 'root' ->> 'cutoffAt')::timestamptz
		from jsonb_array_elements(v_batch) b
		cross join lateral (values (b ->> 'path'), (left(b ->> 'path', 100))) n(needle)
		order by n.needle
		on conflict do nothing;
		insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
		select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_batch) b
		join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid where c.run_id is not null
		on conflict do nothing;
		delete from public.qorpera_folder_path_versions v
		where v.version in (select (b ->> 'version')::uuid from jsonb_array_elements(v_batch) b);
		update public.qorpera_folder_erasures set
			first_erased_at = least(coalesce(first_erased_at, 'infinity'::timestamptz),
				coalesce((select min((b ->> 'at')::timestamptz) from jsonb_array_elements(v_batch) b), 'infinity'::timestamptz)),
			phase = case when v_rows < p_versions then 2 else 1 end,
			counts = jsonb_set(counts, '{versions}', to_jsonb(coalesce((counts ->> 'versions')::bigint, 0) + v_rows))
		where id = v_erasure.id;
		update public.qorpera_folder_erasures set first_erased_at = null
		where id = v_erasure.id and first_erased_at = 'infinity'::timestamptz;

	elsif v_erasure.phase = 2 then
		-- Change sets before each root's cutoff: saved ones by seq, then unsaved ones by time (§4.3 phase 2).
		select coalesce(jsonb_agg(jsonb_build_object('needle', n.needle, 'cutoffSeq', n.cutoff_seq, 'cutoffUnit', n.cutoff_unit,
			'cutoffAt', n.cutoff_at)), '[]'::jsonb) into v_needles
		from public.qorpera_folder_erasure_needles n where n.erasure_id = v_erasure.id;
		if not v_cursor ? 'unsaved' then
			for v_commit in select c.id, c.seq, c.created_at, c.units, c.run_id from public.qorpera_folder_commits c
				where c.environment_id = v_erasure.environment_id and c.seq is not null
					and c.seq > coalesce((v_cursor ->> 'seq')::bigint, 0) and c.seq <= v_max_seq
				order by c.seq limit p_commits
			loop
				v_units := public.qorpera_folder_erasure_units(v_commit.units, v_commit.seq, v_commit.created_at,
					v_erasure.roots, v_needles);
				if v_units is not null then
					update public.qorpera_folder_commits set units = v_units where id = v_commit.id;
					if v_commit.run_id is not null then
						insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_commit.run_id)
						on conflict do nothing;
					end if;
					v_rows := v_rows + 1;
				end if;
				v_count := v_count + 1;
				v_cursor := jsonb_build_object('seq', v_commit.seq);
			end loop;
			if v_count < p_commits then v_cursor := jsonb_build_object('unsaved', true); end if;
		else
			for v_commit in select c.id, c.created_at, c.units, c.run_id from public.qorpera_folder_commits c
				where c.environment_id = v_erasure.environment_id and c.seq is null and c.created_at < v_max_at
					and (c.created_at, c.id) > (coalesce((v_cursor ->> 'at')::timestamptz, '-infinity'::timestamptz),
						coalesce((v_cursor ->> 'id')::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
				order by c.created_at, c.id limit p_commits
			loop
				v_units := public.qorpera_folder_erasure_units(v_commit.units, null, v_commit.created_at, v_erasure.roots, v_needles);
				if v_units is not null then
					update public.qorpera_folder_commits set units = v_units where id = v_commit.id;
					if v_commit.run_id is not null then
						insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_commit.run_id)
						on conflict do nothing;
					end if;
					v_rows := v_rows + 1;
				end if;
				v_count := v_count + 1;
				v_cursor := jsonb_build_object('unsaved', true, 'at', v_commit.created_at, 'id', v_commit.id);
			end loop;
		end if;
		update public.qorpera_folder_erasures set
			phase = case when v_cursor ? 'unsaved' and (v_count < p_commits) and (v_erasure.cursor ? 'unsaved') then 3 else 2 end,
			cursor = case when v_cursor ? 'unsaved' and (v_count < p_commits) and (v_erasure.cursor ? 'unsaved') then '{}'::jsonb
				else v_cursor end,
			counts = jsonb_set(counts, '{commits}', to_jsonb(coalesce((counts ->> 'commits')::bigint, 0) + v_rows))
		where id = v_erasure.id;

	elsif v_erasure.phase = 3 then
		-- The runs that read an erased version: read records from the first erased version's time to the cutoff's.
		for v_record in select rr.run_id, rr.release_id, rr.resource_id, rr.created_at, rr.reads
			from public.qorpera_folder_run_read_records rr
			where v_erasure.first_erased_at is not null and rr.environment_id = v_erasure.environment_id
				and rr.created_at >= v_erasure.first_erased_at and rr.created_at < v_max_at
				and (rr.created_at, rr.run_id, rr.release_id, rr.resource_id) >
					(coalesce((v_cursor ->> 'at')::timestamptz, '-infinity'::timestamptz),
					 coalesce((v_cursor ->> 'run')::uuid, '00000000-0000-0000-0000-000000000000'::uuid),
					 coalesce((v_cursor ->> 'release')::uuid, '00000000-0000-0000-0000-000000000000'::uuid),
					 coalesce((v_cursor ->> 'resource')::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
			order by rr.created_at, rr.run_id, rr.release_id, rr.resource_id
			limit p_commits
		loop
			if exists (select 1 from jsonb_array_elements(v_record.reads) rd join jsonb_array_elements(v_erasure.roots) r
					on public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(rd ->> 'path'))
					and v_record.created_at < (r ->> 'cutoffAt')::timestamptz) then
				insert into public.qorpera_folder_erasure_runs(erasure_id, run_id) values (v_erasure.id, v_record.run_id)
				on conflict do nothing;
			end if;
			v_count := v_count + 1;
			v_bytes := v_bytes + pg_column_size(v_record.reads);
			v_cursor := jsonb_build_object('at', v_record.created_at, 'run', v_record.run_id, 'release', v_record.release_id,
				'resource', v_record.resource_id);
			exit when v_bytes > 4194304;
		end loop;
		update public.qorpera_folder_erasures set
			phase = case when v_count < p_commits and v_bytes <= 4194304 then 4 else 3 end,
			cursor = case when v_count < p_commits and v_bytes <= 4194304 then '{}'::jsonb else v_cursor end
		where id = v_erasure.id;
	end if;

	if v_erasure.phase = 4 or v_erasure.state = 'waiting' then
		-- The noted runs' receipts and reviewed cards (§6): one pass over the noted runs (and, on a revisit, the pending
		-- ones). A run still live, a row locked meanwhile (run-owned rows: SKIP LOCKED) or a card still open leaves the
		-- run pending, revisited hourly. Receipts keep their envelope; cards keep each field's JSON type.
		select coalesce(array_agg(n.needle), '{}'),
			coalesce(array_agg(substr(to_jsonb(n.needle)::text, 2, char_length(to_jsonb(n.needle)::text) - 2)), '{}')
		into v_raw, v_escaped from public.qorpera_folder_erasure_needles n where n.erasure_id = v_erasure.id;
		v_count := 0;
		for v_run in select er.run_id from public.qorpera_folder_erasure_runs er
			where er.erasure_id = v_erasure.id and (er.state = 'noted' or (er.state = 'pending' and v_erasure.state = 'waiting'))
			order by er.run_id limit 200
		loop
			v_ended := exists (select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
				where r.id = v_run.run_id and j.status not in ('queued','leased'));
			v_left := 0;
			if v_ended and cardinality(v_raw) > 0 then
				select count(*) into v_hit from public.qorpera_run_operation_receipts o
				where o.run_id = v_run.run_id and o.status = 'completed' and o.created_at < v_max_at
					and public.qorpera_folder_erasure_hit((o.result -> 'content')::text, v_escaped)
					and o.result -> 'content' is distinct from '{"kind":"text","value":"[erased]"}'::jsonb;
				with locked as (
					select o.id from public.qorpera_run_operation_receipts o
					where o.run_id = v_run.run_id and o.status = 'completed' and o.created_at < v_max_at
						and public.qorpera_folder_erasure_hit((o.result -> 'content')::text, v_escaped)
						and o.result -> 'content' is distinct from '{"kind":"text","value":"[erased]"}'::jsonb
					for no key update skip locked)
				update public.qorpera_run_operation_receipts o
				set result = jsonb_set(o.result, '{content}', '{"kind":"text","value":"[erased]"}'::jsonb)
				from locked where o.id = locked.id;
				get diagnostics v_done = row_count;
				v_count := v_count + v_done;
				v_left := v_left + greatest(v_hit - v_done, 0);
				-- An open card (or an allow not yet used) is what a member or a woken agent still reads: left pending.
				select count(*) into v_hit from public.qorpera_action_reviews a
				where a.run_id = v_run.run_id and a.created_at < v_max_at
					and not (a.decision <> 'ask' or a.answer is not distinct from 'deny' or a.consumed_at is not null)
					and (public.qorpera_folder_erasure_hit(a.action::text, v_escaped) or public.qorpera_folder_erasure_hit(a.reason, v_raw));
				v_left := v_left + v_hit;
				select count(*) into v_hit from public.qorpera_action_reviews a
				where a.run_id = v_run.run_id and a.created_at < v_max_at
					and (a.decision <> 'ask' or a.answer is not distinct from 'deny' or a.consumed_at is not null)
					and (public.qorpera_folder_erasure_hit(a.action::text, v_escaped) or public.qorpera_folder_erasure_hit(a.reason, v_raw));
				with locked as (
					select a.id from public.qorpera_action_reviews a
					where a.run_id = v_run.run_id and a.created_at < v_max_at
						and (a.decision <> 'ask' or a.answer is not distinct from 'deny' or a.consumed_at is not null)
						and (public.qorpera_folder_erasure_hit(a.action::text, v_escaped) or public.qorpera_folder_erasure_hit(a.reason, v_raw))
					for no key update skip locked)
				update public.qorpera_action_reviews a
				set action = a.action || coalesce((select jsonb_object_agg(k, public.qorpera_folder_erasure_blank(a.action -> k))
						from unnest(array['title','target','details','arguments']) k
						where a.action ? k and public.qorpera_folder_erasure_hit((a.action -> k)::text, v_escaped)), '{}'::jsonb),
					reason = case when public.qorpera_folder_erasure_hit(a.reason, v_raw) then 'Erased.' else a.reason end
				from locked where a.id = locked.id;
				get diagnostics v_done = row_count;
				v_count := v_count + v_done;
				v_left := v_left + greatest(v_hit - v_done, 0);
			end if;
			update public.qorpera_folder_erasure_runs set state = case when v_ended and v_left = 0 then 'done' else 'pending' end
			where erasure_id = v_erasure.id and run_id = v_run.run_id;
		end loop;
		update public.qorpera_folder_erasures set
			phase = case when phase = 4 and not exists (select 1 from public.qorpera_folder_erasure_runs
				where erasure_id = v_erasure.id and state = 'noted') then 5 else phase end,
			counts = jsonb_set(counts, '{scrubbed}', to_jsonb(coalesce((counts ->> 'scrubbed')::bigint, 0) + v_count))
		where id = v_erasure.id;
	end if;

	select * into v_erasure from public.qorpera_folder_erasures where id = v_erasure.id;
	if v_erasure.phase = 5 then
		-- Bytes (C1D §9.4), in a statement after the deletes: side rows for hashes nothing roots now, where a catalog row
		-- exists, when folder GC serves the company; otherwise they wait (bytes_pending).
		v_gc := public.qorpera_folder_gc_company(v_erasure.profile_id);
		if v_gc then
			select coalesce(array_agg(h.sha256 order by h.sha256 collate "C"), '{}') into v_hashes from (
				select sha256 from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id
				order by sha256 collate "C" limit p_hashes) h;
			insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
			select v_erasure.profile_id, h, clock_timestamp() from unnest(v_hashes) h
			where exists (select 1 from public.qorpera_profile_objects o where o.profile_id = v_erasure.profile_id and o.sha256 = h)
				and not public.qorpera_folder_object_rooted(v_erasure.profile_id, h)
			order by h collate "C"
			on conflict (profile_id, sha256) do update
			set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);
			delete from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id and sha256 = any(v_hashes);
		end if;
		update public.qorpera_folder_erasures set
			phase = case when not exists (select 1 from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id)
				then 6 else 5 end,
			bytes_pending = not v_gc and exists (select 1 from public.qorpera_folder_erasure_hashes where erasure_id = v_erasure.id)
		where id = v_erasure.id;
	end if;

	select * into v_erasure from public.qorpera_folder_erasures where id = v_erasure.id;
	if v_erasure.phase = 6 and not exists (select 1 from public.qorpera_folder_erasure_runs
			where erasure_id = v_erasure.id and state <> 'done') then
		-- Done: the roots, the needles and the request digest go; the counts stay.
		delete from public.qorpera_folder_erasure_needles where erasure_id = v_erasure.id;
		delete from public.qorpera_folder_erasure_runs where erasure_id = v_erasure.id;
		update public.qorpera_folder_erasures set state = 'done', done_at = clock_timestamp(), revisit_at = null,
			roots = null, request_sha256 = null, cursor = '{}'::jsonb, reply = reply - 'roots' - 'copies'
		where id = v_erasure.id;
	elsif v_erasure.phase in (5, 6) and (v_erasure.bytes_pending or exists (select 1 from public.qorpera_folder_erasure_runs
			where erasure_id = v_erasure.id and state = 'pending')) then
		-- Waiting for pending runs or bytes: revisited once an hour, so it never holds up the others.
		update public.qorpera_folder_erasures set state = 'waiting', revisit_at = clock_timestamp() + interval '1 hour'
		where id = v_erasure.id;
	end if;
	select * into v_erasure from public.qorpera_folder_erasures where id = v_erasure.id;
	return jsonb_build_object('schema', 'qorpera.folder-erasure-step/v1', 'erasureId', v_erasure.id, 'state', v_erasure.state,
		'phase', v_erasure.phase);
end $$;

-- 6. Status, for the member route ---------------------------------------------------------------------------------------

create function public.qorpera_folder_erasure_status(p_environment_id uuid, p_actor jsonb, p_erasure_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_erasure public.qorpera_folder_erasures%rowtype; v_role public.qorpera_profile_role;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_erasure from public.qorpera_folder_erasures where id = p_erasure_id and environment_id = p_environment_id;
	if not found then raise exception 'Erasure is unavailable' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'member' then raise exception 'Only a member reads an erasure' using errcode = '22023'; end if;
	select role into v_role from public.qorpera_profile_members
	where profile_id = v_erasure.profile_id and user_id = (p_actor ->> 'userId')::uuid;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'Only owners and admins read an erasure' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-erasure-status/v1', 'erasureId', v_erasure.id, 'state', v_erasure.state,
		'phase', v_erasure.phase, 'counts', v_erasure.counts, 'bytesPending', v_erasure.bytes_pending,
		'pendingRuns', (select count(*) from public.qorpera_folder_erasure_runs where erasure_id = v_erasure.id and state = 'pending'),
		'requestedAt', v_erasure.requested_at, 'doneAt', v_erasure.done_at);
end $$;

-- 7. Grants and the schedule ---------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_erasure_covers(text, text), public.qorpera_folder_erasure_before(jsonb, bigint, integer),
	public.qorpera_folder_erasure_life_start(uuid, text), public.qorpera_folder_erasure_cutoff(uuid, text, bigint, timestamptz),
	public.qorpera_folder_erasure_open_moves(uuid, jsonb), public.qorpera_folder_erasure_hit(text, text[]),
	public.qorpera_folder_erasure_units(jsonb, bigint, timestamptz, jsonb, jsonb), public.qorpera_folder_erasure_blank(jsonb),
	public.qorpera_folder_erasure_step(integer, integer, integer)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_erase(uuid, jsonb, jsonb, text),
	public.qorpera_folder_erasure_status(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_erase(uuid, jsonb, jsonb, text),
	public.qorpera_folder_erasure_status(uuid, jsonb, uuid) to service_role;

-- The drain every 5 seconds (pg_cron 1.5 or later), and a daily cleanup of its run log (cron.log_run is cluster-wide).
-- Where pg_cron is absent or the role may not use it, nothing is scheduled and the migration still applies; run
-- select public.qorpera_schedule_folder_erasure() as the role that should own the jobs after enabling it.
create function public.qorpera_schedule_folder_erasure()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null then
		return jsonb_build_object('schema', 'qorpera.folder-erasure-schedule/v1', 'scheduled', false);
	end if;
	begin
		if to_regprocedure('cron.schedule(text,text,text)') is null then
			return jsonb_build_object('schema', 'qorpera.folder-erasure-schedule/v1', 'scheduled', false);
		end if;
		v_step := cron.schedule('qorpera-folder-erasure', '5 seconds', 'select public.qorpera_folder_erasure_step()');
		v_clean := cron.schedule('qorpera-folder-erasure-log', '17 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-folder-erasure')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'Folder erasure was not scheduled (%): % may not use pg_cron, or pg_cron is older than 1.5', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.folder-erasure-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.folder-erasure-schedule/v1', 'scheduled', true, 'jobs', jsonb_build_array(v_step, v_clean));
end $$;
revoke all on function public.qorpera_schedule_folder_erasure() from public, anon, authenticated, service_role;
select public.qorpera_schedule_folder_erasure();
