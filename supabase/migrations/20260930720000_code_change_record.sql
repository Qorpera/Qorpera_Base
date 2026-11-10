-- 20260930720000: the change record of the repositories kept in Qorpera: every movement of main as a numbered row, and
-- undo, download and restore as requests the coding executor serves (own code storage, step 2b; 10 Nov 2026).
--
-- Until now a landing left one line in the agent's result and nothing else: no number, no list of what went into main,
-- no way to take a change out again, to hand the code to a member, or to put a repository back from its nightly copy.
-- This migration is the kernel's side of all of that. It is inert until an executor, a runtime and a web that know it
-- are rolled, except for (9): the folder rules (nobody writes those places today), the submit call (it takes two more
-- keys) and the completion's sentence (there are no rows yet, so no sentence).
--
-- 1. qorpera_code_repositories gets ten columns: the last change's number and main as the record knows it, the list
--    file's version and the version written, the back-off of record files that could not be written, the last
--    restore, and the generation of what the place holds besides git (it goes up each time a restore's job is let go
--    to move the place aside; a made download counts only in the generation it was made in).
-- 2. qorpera_code_changes: one numbered row per movement of main (a landing, an undo, a restore, or a movement nobody
--    recorded: `found`) and per landing that was refused. A row holds main before and after, so the rows cover main's
--    history end to end. Numbers have no gaps: the last one and one more, under the registry row's lock, in the
--    insert's own transaction (a rollback takes the number back with the row). Rows are never deleted.
-- 3. qorpera_code_requests: the work the executor does that no coding turn carries: an undo an agent asked for, a
--    download a member asked for, a restore an operator asked for. Each is leased, as care's run is.
-- 4. The executor's calls (service role):
--    * qorpera_record_code_change(worker, lease token, report): made by the executor that holds the turn's lease, inside
--      the landing's job while the company's line is still held (`inLine`), or once more after it. It appends the row; a
--      main the record does not know becomes a `found` row first; a turn that hands the same commit in again takes such
--      a row over. The row's words (title, summary, notice, the picture's path) are the kernel's own, never the report's.
--    * qorpera_code_change_files_due / _files / _files_written: the record files (code/<owner>/<name>/changes/<n>.md and
--      index.md) still to write, what they say, and that they were written. The row is the truth; a file is its copy.
--    * qorpera_code_requests_claim / qorpera_code_request_step / qorpera_code_request_finish: lease the oldest requests
--      this executor may do now, renew before each job, and say how each ended. An undo's finish writes the undo row
--      and sets the rows it took out `reverted`. The step, asked before a job's first command, is also where a made
--      download ends when that job is about to displace its file (a restore's job that sets the place aside, each
--      time one is let go; a newer download of the same file): before the file goes, and whatever becomes of the job
--      or of its finish.
--    * qorpera_code_restore_record: a restore's record, made inside the job that opens the place again, before the mark
--      that closes it goes, as a landing's row is written inside its own job. It writes the restore's row, sets every
--      row's state to what the restored main's history holds (`lost` for a row the restore went back past, in main again
--      for one a restore to a newer copy brought back), and makes every record file and care due again. The finish,
--      after that job has saved, only ends the request.
-- 5. The agent's calls (native host, scope binding; the agent's own company run only, under a run receipt):
--    qorpera_folder_request_code_undo, qorpera_folder_code_request (a read) and qorpera_folder_describe_code_change.
-- 6. The member's calls: qorpera_list_code_repositories (any member), qorpera_request_code_download and
--    qorpera_code_download (owners and admins).
-- 7. The operator's call: qorpera_request_code_restore, the database owner's alone.
-- 8. qorpera_code_changes_backfill: the landings that exist, from each one's `reported` worker event, as rows. Run once
--    here; it adds nothing for a landing that is a row, so the lead runs it again after the executors are rolled.
-- 9. Five existing functions change, each by anchors on its definition as it is (an anchor that is not found exactly
--    once fails the migration), and each changed body carries the marker 20260930720000:
--    * qorpera_folder_git_refusal: under code/<owner>/<name>/, changes/, downloads/ and restoring.json are the
--      platform's, as main/ is; so is everything under code/_set-aside/ (what a restore set aside).
--    * qorpera_folder_git_unit_refusal: in a repository kept in Qorpera a member no longer writes, restores or removes
--      repo.git/refs/**, packed-refs or shallow. Only the platform moves main (20260930707000 left the member's restore
--      open); the record now depends on it. A copy of a GitHub repository is as it was.
--    * qorpera_submit_coding_turn: a finish may carry `notice` (one line on what a customer will notice) and `picture`
--      (the path of a screenshot the session committed). A submission without them is stored as it is today.
--    * qorpera_complete_coding_turn: the platform's line on a landing ends with the change's number and where its record
--      is, when the turn has a row.
--    * qorpera_record_runtime_observation: the tool name manage_code joins the list.
--
-- Who may call: section 4 the service role only, as the coding executor (the turn's lease for the first; for the others
-- the custody check of qorpera_code_hosts_deleting, 42501 otherwise, and care's holder rule: an executor that is not the
-- environment's one enabled executor on that machine gets nothing, or `lost`). Section 5 the service role, with a run's
-- binding. Section 6 role authenticated, as a member of the company. Sections 7 and 8 no API role.
-- Locks, always in this order: the company's profile row (a key share, where a row with its key is written), the coding
-- session's row (only the first call), the repository's registry row, then rows of the two new tables. Nothing takes a
-- registry row before a session's. The claim locks request rows only; so does the step, but for a download's and for
-- a restore's of the place, which take the registry row first.

set local lock_timeout = '3s';

-- 1. The registry gets ten columns -------------------------------------------------------------------------------------

alter table public.qorpera_code_repositories
	add column last_change integer not null default 0 check (last_change >= 0),
	-- Main as the record knows it: main_after of the last row that moved main. Null before the first.
	add column last_main text check (last_main is null or last_main ~ '^[0-9a-f]{40}$'),
	-- The list file: bumped with every insert, state change and describe; written is what index.md holds.
	add column index_version bigint not null default 0,
	add column index_written bigint not null default 0,
	-- Record files that could not be written: the pass backs off per repository.
	add column files_attempts integer not null default 0 check (files_attempts >= 0),
	add column files_not_before timestamptz,
	add column files_problem text check (files_problem is null or files_problem ~ '^[A-Z0-9_:]{1,120}$'),
	add column restored_at timestamptz,
	add column restored_from text check (restored_from is null or restored_from ~ '^\d{8}T\d{6}Z-[0-9a-f]{12}$'),
	-- The generation of what the place holds besides git (downloads/): it goes up each time a restore's job is let go
	-- to move the place aside. A made download counts only in the generation its job was begun in.
	add column artifact_generation bigint not null default 0 check (artifact_generation >= 0);
-- The lists still to write.
create index qorpera_code_repositories_list_due on public.qorpera_code_repositories(environment_id, owner, name)
	where index_written < index_version;

-- 2. The changes --------------------------------------------------------------------------------------------------------

create table public.qorpera_code_changes (
	environment_id uuid not null,
	owner text not null,
	name text not null,
	n integer not null check (n >= 1),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	-- landing: a session's commit. undo: a commit that takes changes out. restore: main set from a stored bundle.
	-- found: main had moved and no record said how (a filler; a session that proves it is its own takes it over).
	kind text not null check (kind in ('landing','undo','restore','found')),
	-- landed: its effect is in main. reverted: an undo took it out. conflict, refused: it never went in.
	-- lost: a restore went back past it.
	state text not null check (state in ('landed','reverted','conflict','refused','lost')),
	how text check (how is null or how in ('fast-forward','merged')),
	main_before text check (main_before is null or main_before ~ '^[0-9a-f]{40}$'),
	main_after text check (main_after is null or main_after ~ '^[0-9a-f]{40}$'),
	head_sha text check (head_sha is null or head_sha ~ '^[0-9a-f]{40}$'),
	-- Plain values, no foreign keys: a record names its session, it does not hold it.
	worker_id uuid,
	sequence integer check (sequence is null or sequence >= 1),
	staff_agent_id uuid,
	owner_user_id uuid,
	request_id uuid,
	title text not null check (octet_length(title) between 1 and 400),
	summary text check (summary is null or octet_length(summary) <= 4000),
	notice text check (notice is null or (char_length(notice) between 1 and 200 and notice !~ '[\n\r\t]')),
	-- {"source":"commit","path":"docs/changes/x.png","blob":"<40 hex>","bytes":1,"type":"png",
	--  "at":"code/<owner>/<name>/changes/<n>.png"}  or  {"source":"folder","path":"…","sha256":"<64 hex>","bytes":1}
	picture jsonb check (picture is null or (jsonb_typeof(picture) = 'object' and pg_column_size(picture) <= 2048)),
	picture_problem text check (picture_problem is null
		or picture_problem in ('missing','not_a_file','too_large','not_a_picture','not_shared')),
	files_changed integer check (files_changed is null or files_changed >= 0),
	-- The first 50 paths: [{"path":"src/a.ts","change":"added"|"changed"|"removed"}]; paths_more counts the rest.
	paths jsonb check (paths is null or (jsonb_typeof(paths) = 'array' and pg_column_size(paths) <= 16384)),
	paths_more integer not null default 0 check (paths_more >= 0),
	-- {"code":"CODE_HOST_LAND_CONFLICT","paths":["…"]} for conflict and refused.
	refusal jsonb check (refusal is null or (jsonb_typeof(refusal) = 'object' and pg_column_size(refusal) <= 8192)),
	-- An undo's targets: the numbers of the rows whose effect it took out.
	undoes integer[],
	reverted_by integer,
	restored_from text,
	created_at timestamptz not null default clock_timestamp(),
	-- The file: version goes up whenever the row changes what its file says; written is the version the file holds.
	file_version integer not null default 1 check (file_version >= 1),
	file_written integer not null default 0 check (file_written >= 0),
	primary key (environment_id, owner, name, n),
	foreign key (environment_id, owner, name)
		references public.qorpera_code_repositories(environment_id, owner, name) on delete cascade,
	check ((kind = 'undo') = (undoes is not null)),
	check ((state in ('conflict','refused')) = (refusal is not null)),
	check (state in ('conflict','refused') or main_after is not null),
	check (kind <> 'landing' or (worker_id is not null and sequence is not null)),
	check ((state = 'reverted') = (reverted_by is not null))
);
-- One row per turn: a replay answers the row that is there.
create unique index qorpera_code_changes_turn on public.qorpera_code_changes(worker_id, sequence)
	where worker_id is not null;
-- "The row at commit X", for a release that names a commit, and for taking a filler over.
create index qorpera_code_changes_main on public.qorpera_code_changes(environment_id, owner, name, main_after)
	where main_after is not null;
-- The files still to write.
create index qorpera_code_changes_files on public.qorpera_code_changes(environment_id, owner, name)
	where file_written < file_version;
create index qorpera_code_changes_profile on public.qorpera_code_changes(profile_id);
alter table public.qorpera_code_changes enable row level security;
revoke all on public.qorpera_code_changes from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_code_changes is
	'20260930720000: the change record of a repository kept in Qorpera: a numbered row per movement of its main branch '
	'(landing, undo, restore, or one nobody recorded) and per refused landing, each with main before and after. Its '
	'functions write it; the changes since X are one range on the primary key.';

-- 3. The requests -------------------------------------------------------------------------------------------------------

-- Work the executor does that no coding turn carries.
create table public.qorpera_code_requests (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null,
	owner text not null,
	name text not null,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	kind text not null check (kind in ('undo','download','restore')),
	-- undo: {"change":12,"andLater":false,"reason":"…","notice":null}
	-- download: {"file":"files"|"history","fileName":"shop-2026-11-10.zip"}
	-- restore: {"mode":"verify"|"restore"|"discard","bundle":"<name>"|"fresh","damaged":"keep"|"remove",
	--           "note":"…","path":"code/_set-aside/…"|null}
	input jsonb not null check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 4096),
	state text not null default 'queued'
		check (state in ('queued','running','done','refused','failed','expired')),
	by_kind text not null check (by_kind in ('agent','member','operator')),
	by_user_id uuid,
	by_agent_id uuid,
	run_id uuid,
	lease_token uuid,
	lease_owner text,
	lease_until timestamptz,
	attempts integer not null default 0 check (attempts >= 0),
	not_before timestamptz,
	-- What a restore has done so far, so a run that stopped goes on where it was.
	progress jsonb check (progress is null or pg_column_size(progress) <= 4096),
	outcome jsonb check (outcome is null or pg_column_size(outcome) <= 16384),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	finished_at timestamptz,
	-- A download's file goes at this time.
	expires_at timestamptz,
	-- A download: the repository's artifact generation when the job that makes its file was begun (its step). Null
	-- until then.
	artifact_generation bigint check (artifact_generation is null or artifact_generation >= 0),
	foreign key (environment_id, owner, name)
		references public.qorpera_code_repositories(environment_id, owner, name) on delete cascade,
	check ((lease_token is null) = (lease_until is null) and (lease_token is null) = (lease_owner is null))
);
create index qorpera_code_requests_open on public.qorpera_code_requests(created_at)
	where state in ('queued','running');
create index qorpera_code_requests_expiring on public.qorpera_code_requests(expires_at)
	where kind = 'download' and state = 'done';
-- One movement of main is asked for at a time in a repository, and one download of each file.
create unique index qorpera_code_requests_one_move on public.qorpera_code_requests(environment_id, owner, name)
	where kind in ('undo','restore') and state in ('queued','running');
create unique index qorpera_code_requests_one_download
	on public.qorpera_code_requests(environment_id, owner, name, (input ->> 'file'))
	where kind = 'download' and state in ('queued','running');
create index qorpera_code_requests_repository on public.qorpera_code_requests(environment_id, owner, name, created_at);
-- A company's requests of the last day, for the download's rate.
create index qorpera_code_requests_profile on public.qorpera_code_requests(profile_id, created_at);
alter table public.qorpera_code_requests enable row level security;
revoke all on public.qorpera_code_requests from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_code_requests is
	'20260930720000: what was asked of a repository kept in Qorpera outside a coding turn: an agent''s undo, a member''s '
	'download, an operator''s restore. The coding executor leases each and says how it ended. Its functions write it.';

-- 4. What the calls share -----------------------------------------------------------------------------------------------

-- The coding executor's custody, as qorpera_code_hosts_deleting checks it (20260928569100).
create function public.qorpera_code_executor_custody(p_owner text, p_machine_id_sha256 text)
returns void language plpgsql stable set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
end $$;

-- A JSON string that matches the pattern (never JSON null: qorpera_code_care_text_valid takes that too).
create function public.qorpera_code_json_text(p_value jsonb, p_pattern text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_value) = 'string' and p_value #>> '{}' ~ p_pattern, false)
$$;

-- A JSON number that counts: whole, not negative, at most 15 digits.
create function public.qorpera_code_json_count(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_value) = 'number' and p_value #>> '{}' ~ '^[0-9]{1,15}$', false)
$$;

-- A JSON array of at most p_max strings.
create function public.qorpera_code_json_strings(p_value jsonb, p_max integer)
returns boolean language sql immutable set search_path = '' as $$
	select case when jsonb_typeof(p_value) = 'array' then jsonb_array_length(p_value) <= p_max
		and not exists (select 1 from jsonb_array_elements(p_value) entry where jsonb_typeof(entry) <> 'string')
		else false end
$$;

-- What a customer will notice, in one line: 1 to 200 characters, no line break and no tab.
create function public.qorpera_code_notice_valid(p_notice text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(char_length(p_notice) between 1 and 200 and p_notice !~ '[\n\r\t]', false)
$$;

-- The paths of a diff: JSON null, or an array of {"path","change"}.
create function public.qorpera_code_change_paths_valid(p_paths jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select case jsonb_typeof(p_paths) when 'null' then true
		when 'array' then not exists (select 1 from jsonb_array_elements(p_paths) entry
			where case when jsonb_typeof(entry) = 'object' then entry - array['path','change'] <> '{}'::jsonb
				or not public.qorpera_code_json_text(entry -> 'path', '.')
				or not coalesce(entry -> 'change' in ('"added"'::jsonb, '"changed"'::jsonb, '"removed"'::jsonb), false)
				else true end)
		else false end
$$;

-- The first entries of an array that a row can hold: at most p_count of them, and no more than p_bytes as a value. What
-- does not fit is counted by the caller (paths_more), so a long list never costs the row.
create function public.qorpera_code_change_fit(p_array jsonb, p_count integer, p_bytes integer)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_array jsonb := p_array;
begin
	if v_array is null or jsonb_typeof(v_array) <> 'array' then return null; end if;
	if jsonb_array_length(v_array) > p_count then
		select coalesce(jsonb_agg(entry.item order by entry.place), '[]'::jsonb) into v_array
		from jsonb_array_elements(p_array) with ordinality entry(item, place) where entry.place <= p_count;
	end if;
	while jsonb_array_length(v_array) > 0 and pg_column_size(v_array) > p_bytes loop
		v_array := v_array - (jsonb_array_length(v_array) - 1);
	end loop;
	return v_array;
end $$;

-- Appends one row to a repository's record and answers its number. The caller holds the registry row's lock: the number
-- is the last one and one more. p_values names the row's columns; a row that moved main (it has main_after) moves the
-- record's main with it, and every row moves the list's version.
create function public.qorpera_code_change_append(p_environment_id uuid, p_owner text, p_name text, p_values jsonb)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_n integer; v_profile uuid;
begin
	update public.qorpera_code_repositories set last_change = last_change + 1, index_version = index_version + 1,
		last_main = coalesce(p_values ->> 'main_after', last_main)
	where environment_id = p_environment_id and owner = p_owner and name = p_name
	returning last_change, profile_id into strict v_n, v_profile;
	insert into public.qorpera_code_changes
	select (jsonb_populate_record(null::public.qorpera_code_changes,
		jsonb_build_object('paths_more', 0, 'file_version', 1, 'file_written', 0, 'created_at', clock_timestamp())
		|| p_values || jsonb_build_object('environment_id', p_environment_id, 'owner', p_owner, 'name', p_name, 'n', v_n,
			'profile_id', v_profile))).*;
	return v_n;
end $$;

-- A filler: main moved from p_before to p_after and no record says how. Its files are counted when its file is written.
create function public.qorpera_code_change_found(p_environment_id uuid, p_owner text, p_name text, p_before text,
	p_after text)
returns integer language sql volatile security definer set search_path = '' as $$
	select public.qorpera_code_change_append(p_environment_id, p_owner, p_name, jsonb_build_object('kind', 'found',
		'state', 'landed', 'main_before', p_before, 'main_after', p_after, 'title', 'A change whose record was lost'))
$$;

-- Sets whether a row's effect is in main: landed, or reverted by row p_by. Its file says so, so its version goes up.
-- A row that is itself an undo sets each of its targets the other way: taken out of main, an undo's targets are back
-- in it; back in main, it takes them out again. A row that never went in, or that a restore went back past, stays.
create function public.qorpera_code_change_set(p_environment_id uuid, p_owner text, p_name text, p_n integer,
	p_in_main boolean, p_by integer)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.qorpera_code_changes%rowtype; v_target integer;
begin
	select * into v_row from public.qorpera_code_changes
	where environment_id = p_environment_id and owner = p_owner and name = p_name and n = p_n;
	if not found or v_row.state not in ('landed','reverted') then return; end if;
	update public.qorpera_code_changes set state = case when p_in_main then 'landed' else 'reverted' end,
		reverted_by = case when p_in_main then null else p_by end, file_version = file_version + 1
	where environment_id = p_environment_id and owner = p_owner and name = p_name and n = p_n;
	if v_row.kind = 'undo' then
		foreach v_target in array v_row.undoes loop
			perform public.qorpera_code_change_set(p_environment_id, p_owner, p_name, v_target, not p_in_main, p_n);
		end loop;
	end if;
end $$;

-- Sets the rows' states to what main's history holds once a restore has put main at p_main, and answers what it found:
-- {"boundary":"found"|"unknown","keptThrough":<n>|null,"lost":<int>,"back":<int>}. The caller holds the registry row's
-- lock.
-- The history is read from the rows, each of which holds main before and after: the newest row that moved main to
-- p_main, then the newest row before it that moved main to where that one began, and so on down. Never through a
-- restore's own row (main before a restore is no part of main after it), and always to a lower number (a commit that
-- lands again after a restore went back past it is a later row's, and says nothing of what the earlier row stood on).
-- That is one pass down the repository's rows, newest first, however long the record is.
-- * A row of that history is in main, unless an undo of that history took it out: every row of it starts as landed,
--   and the history's undos are done again in their order, each on its targets newest first and each target as it
--   stands when its turn comes, as their finishes did. So a row that an undo outside the history took out is in main
--   again, and a row an earlier restore marked lost is whatever this history makes it.
-- * A row that moved main and is not of that history is lost. A restore's own row is of it when the commit it restored
--   is one of the history's.
-- * A row that never went in (conflict, refused) stays as it is.
-- So a restore back, a restore forward to a newer copy and back again each leave the states the restored main has.
-- The walk ends where the record's first change began: then every row's place is known (boundary `found`). It may
-- also end at a commit that no change put main at. That is not read as nothing kept:
-- * a restore put main there whose own place in the record was not known: the rows before that restore stay as they
--   were left, the rows after it are set as above, and the boundary is `unknown`;
-- * no row says how main got there: nothing is known, no row is touched, and the boundary is `unknown`.
-- keptThrough is the newest row of the history: 0 when the boundary is found and main holds no row, null when it is
-- unknown and no row is known to be held. `lost` counts the rows this call marked lost, `back` the lost ones it found
-- in the history again.
create function public.qorpera_code_changes_restored(p_environment_id uuid, p_owner text, p_name text, p_main text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_history integer[] := '{}'; v_commits text[] := array[p_main]; v_at text := p_main; v_below integer;
	v_step record; v_undo record; v_target integer; v_known boolean; v_floor integer := 0; v_lost integer; v_back integer;
begin
	-- Down the rows that moved main, newest first: the next one that put main where the walk stands is the history's
	-- next row, and the walk then stands where that row began.
	for v_step in select change.n, change.main_before, change.main_after from public.qorpera_code_changes change
		where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
			and change.main_after is not null and change.kind <> 'restore'
		order by change.n desc
	loop
		continue when v_step.main_after <> v_at;
		v_history := v_history || v_step.n;
		v_below := v_step.n;
		v_at := v_step.main_before;
		-- (A row with no main before it is the record's first.)
		exit when v_at is null;
		v_commits := v_commits || v_at;
	end loop;
	-- Whether the walk ended where the record's first change began. A record with no change has nothing to place.
	select v_at is null or v_at is not distinct from first.main_before into v_known
	from (select change.main_before from public.qorpera_code_changes change
		where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
			and change.main_after is not null and change.kind <> 'restore'
		order by change.n limit 1) first;
	if not found then v_known := true; end if;
	if not v_known then
		select max(change.n) into v_floor from public.qorpera_code_changes change
		where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
			and change.kind = 'restore' and change.main_after = v_at and (v_below is null or change.n < v_below);
		if v_floor is null then
			return jsonb_build_object('boundary', 'unknown', 'keptThrough', null, 'lost', 0, 'back', 0);
		end if;
	end if;
	-- What moved main and is not of the history is lost. (A row's file says its state: its version goes up with it.)
	update public.qorpera_code_changes change set state = 'lost', reverted_by = null,
		file_version = change.file_version + 1
	where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
		and change.n > v_floor and change.main_after is not null and change.state in ('landed','reverted')
		and not case when change.kind = 'restore' then change.main_after = any(v_commits)
			else change.n in (select unnest(v_history)) end;
	get diagnostics v_lost = row_count;
	-- What is of the history starts in main: a row a restore marked lost is back, and a row an undo took out is in main
	-- until that undo, if the history holds it, is done again below. So is a row left as it was whose undo is not.
	select count(*) into v_back from public.qorpera_code_changes change
	where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
		and change.n > v_floor and change.main_after is not null and change.state = 'lost'
		and case when change.kind = 'restore' then change.main_after = any(v_commits)
			else change.n in (select unnest(v_history)) end;
	update public.qorpera_code_changes change set state = 'landed', reverted_by = null,
		file_version = change.file_version + 1
	where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
		and change.main_after is not null
		and case when change.n <= v_floor then change.state = 'reverted' and change.reverted_by > v_floor
			else change.state in ('reverted','lost') and case when change.kind = 'restore'
				then change.main_after = any(v_commits) else change.n in (select unnest(v_history)) end end;
	for v_undo in select change.n, change.undoes from public.qorpera_code_changes change
		where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
			and change.kind = 'undo' and change.n in (select unnest(v_history))
		order by change.n
	loop
		for v_target in select target from unnest(v_undo.undoes) target order by target desc loop
			if (select change.state from public.qorpera_code_changes change
				where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
					and change.n = v_target) = 'landed' then
				perform public.qorpera_code_change_set(p_environment_id, p_owner, p_name, v_target, false, v_undo.n);
			end if;
		end loop;
	end loop;
	return jsonb_build_object('boundary', case when v_known then 'found' else 'unknown' end,
		'keptThrough', case when cardinality(v_history) > 0 then v_history[1] when v_known then 0 end,
		'lost', v_lost, 'back', v_back);
end $$;

-- An undo's commit message, which is also its row's title: one change, or that change and every later one.
create function public.qorpera_code_undo_message(p_n integer, p_title text, p_later boolean)
returns text language plpgsql immutable set search_path = '' as $$
declare v_message text := case when p_later then 'Go back to before change ' || p_n
	else 'Undo change ' || p_n || ': ' || p_title end;
begin
	-- A title is at most 400 bytes; an undo of an undo of an undo grows by its words each time.
	while octet_length(v_message) > 400 loop v_message := left(v_message, length(v_message) - 1); end loop;
	return v_message;
end $$;

-- How long a claim or a step holds a request: an undo is one job, a download may wait behind turns, a restore is three
-- jobs of which one may run git's whole check.
create function public.qorpera_code_request_lease(p_kind text)
returns interval language sql immutable set search_path = '' as $$
	select case p_kind when 'undo' then interval '5 minutes' when 'download' then interval '30 minutes'
		else interval '2 hours' end
$$;

-- What keeps a restore of a repository's place waiting, or null: a coding session of the company is in a turn or just
-- came to wait for an executor (care's rule), or a session of this repository is attached to a machine.
create function public.qorpera_code_restore_waits(p_environment_id uuid, p_owner text, p_name text, p_now timestamptz)
returns text language sql stable security definer set search_path = '' as $$
	select case when public.qorpera_code_care_busy(p_environment_id, p_now) then 'SESSIONS_BUSY'
		when exists (select 1 from public.qorpera_coding_sessions session
			where session.environment_id = p_environment_id and session.repository ->> 'host' = 'qorpera'
				and session.repository ->> 'owner' = p_owner and session.repository ->> 'name' = p_name
				and session.attached_machine_id is not null) then 'SESSIONS_ATTACHED' end
$$;

-- Whether a restore holds the place: the kernel's own word in its progress, `held`. While it stands the request is
-- not put off: it is handed out and its steps are let go whatever the company's sessions do. The place is closed, or
-- about to be, by a job that was let go while the company was quiet; no session works in it or can start to, and
-- waiting for the company's other work would only keep the repository closed longer.
-- The word stands from the first step named `close` that is let go until the place is seen open again:
-- * The step that names `close` writes it when it is let go (qorpera_code_request_step). That answer was given under
--   the ordinary rule, with the company quiet. The step that names `set-aside` writes it too.
-- * It stays through every later step and claim of the request, whatever those are called and whatever the caller
--   sends: also through the first steps of a later claim, which read the place and close it again.
-- * Only the step by which the executor says that the place is open again as it was (`reopened`) takes it away: a
--   close that wrote no mark, a place this request closed and opened again untouched, a place a later claim read and
--   found without a mark. From there the request waits for quiet sessions like one that has not begun.
-- * A request that ends failed keeps it. The next restore asked for the same place begins with it
--   (qorpera_request_code_restore): the place may still be closed, and its executor reads the place first.
-- Nothing else counts: not the name of the step a call brings, and nothing the caller writes into the progress.
create function public.qorpera_code_restore_holds(p_progress jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_progress -> 'held' = 'true'::jsonb, false)
$$;

-- 5. The executor records a landing ---------------------------------------------------------------------------------------

-- Whether p_change is a landing's report, qorpera.code-change-report/v1: exactly its keys, each of its kind, and what
-- its state asks for (landed: how and both ends of main; unchanged: both ends; conflict and refused: the refusal).
create function public.qorpera_code_change_report_valid(p_change jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_change) = 'object' and pg_column_size(p_change) <= 65536
		and p_change ?& array['schema','state','inLine','how','headSha','mainBefore','mainAfter','filesChanged','paths',
			'pathsMore','picture','refusal']
		and p_change - array['schema','state','inLine','how','headSha','mainBefore','mainAfter','filesChanged','paths',
			'pathsMore','picture','refusal'] = '{}'::jsonb
		and p_change -> 'schema' = '"qorpera.code-change-report/v1"'::jsonb
		and jsonb_typeof(p_change -> 'inLine') = 'boolean'
		and public.qorpera_code_json_text(p_change -> 'headSha', '^[0-9a-f]{40}$')
		and case when p_change -> 'state' = '"landed"'::jsonb then
				p_change -> 'how' in ('"fast-forward"'::jsonb, '"merged"'::jsonb)
				and public.qorpera_code_json_text(p_change -> 'mainBefore', '^[0-9a-f]{40}$')
				and public.qorpera_code_json_text(p_change -> 'mainAfter', '^[0-9a-f]{40}$')
				and p_change -> 'refusal' = 'null'::jsonb
			when p_change -> 'state' = '"unchanged"'::jsonb then
				p_change -> 'how' = 'null'::jsonb
				and public.qorpera_code_json_text(p_change -> 'mainBefore', '^[0-9a-f]{40}$')
				and public.qorpera_code_json_text(p_change -> 'mainAfter', '^[0-9a-f]{40}$')
				and p_change -> 'refusal' = 'null'::jsonb
			when p_change -> 'state' in ('"conflict"'::jsonb, '"refused"'::jsonb) then
				p_change -> 'how' = 'null'::jsonb and p_change -> 'mainBefore' = 'null'::jsonb
				and p_change -> 'mainAfter' = 'null'::jsonb
				and case when jsonb_typeof(p_change -> 'refusal') = 'object' then
					p_change -> 'refusal' ?& array['code','paths']
					and (p_change -> 'refusal') - array['code','paths'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_change -> 'refusal' -> 'code', '^[A-Z][A-Z0-9_]{0,119}$')
					and public.qorpera_code_json_strings(p_change -> 'refusal' -> 'paths', 20)
					else false end
			else false end
		and (p_change -> 'filesChanged' = 'null'::jsonb or (public.qorpera_code_json_count(p_change -> 'filesChanged')
			and p_change ->> 'filesChanged' ~ '^[0-9]{1,9}$'))
		and public.qorpera_code_change_paths_valid(p_change -> 'paths')
		and public.qorpera_code_json_count(p_change -> 'pathsMore') and p_change ->> 'pathsMore' ~ '^[0-9]{1,9}$'
		and case jsonb_typeof(p_change -> 'picture') when 'null' then true
			when 'object' then case when p_change -> 'picture' -> 'state' = '"ok"'::jsonb then
					p_change -> 'picture' ?& array['blob','bytes','type']
					and (p_change -> 'picture') - array['state','blob','bytes','type'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_change -> 'picture' -> 'blob', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_count(p_change -> 'picture' -> 'bytes')
					and p_change -> 'picture' -> 'type' in ('"png"'::jsonb, '"jpeg"'::jsonb, '"webp"'::jsonb)
				else (p_change -> 'picture') - array['state'] = '{}'::jsonb
					and coalesce(p_change -> 'picture' -> 'state' in ('"missing"'::jsonb, '"not_a_file"'::jsonb,
						'"too_large"'::jsonb, '"not_a_picture"'::jsonb), false) end
			else false end, false)
$$;

-- A landing's report, from the executor that holds the turn's lease. Answers recorded (a row was appended), adopted (a
-- filler was taken over), replayed (the turn has its row), known (another row already says main got that commit), late
-- (main moved on before the report came, and the filler that covers it stands) or nothing.
create function public.qorpera_record_code_change(p_worker_id uuid, p_lease_token uuid, p_change jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_submission jsonb; v_repository public.qorpera_code_repositories%rowtype; v_row public.qorpera_code_changes%rowtype;
	v_state text := p_change ->> 'state'; v_before text := p_change ->> 'mainBefore'; v_after text := p_change ->> 'mainAfter';
	v_words jsonb; v_picture jsonb; v_problem text; v_paths jsonb; v_filler boolean := false; v_found integer;
	v_take integer; v_append boolean := false; v_answer text := 'nothing'; v_n integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if not public.qorpera_code_change_report_valid(p_change) then
		raise exception 'Code change report invalid' using errcode = '22023'; end if;
	-- The company's profile row first, as every coding call that goes on to write a row with its key (20260925123000):
	-- an agent tool or a machine plan holds it while it waits for this session.
	perform 1 from public.qorpera_profiles profile where profile.id = (select worker.profile_id
		from public.qorpera_runtime_workers worker where worker.id = p_worker_id) for key share;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	select turn.submission into v_submission from public.qorpera_coding_session_turns turn
	where turn.worker_id = p_worker_id and turn.sequence = v_worker.sequence;
	-- The report is of the commit this turn handed in, in a repository kept in Qorpera.
	if v_session.repository ->> 'host' is distinct from 'qorpera' or v_submission ->> 'kind' is distinct from 'finish'
		or v_submission ->> 'headSha' is distinct from p_change ->> 'headSha' then
		raise exception 'Code change report invalid' using errcode = '22023'; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_session.environment_id and owner = v_session.repository ->> 'owner'
		and name = v_session.repository ->> 'name' for update;
	if not found then raise exception 'Code repository is not registered' using errcode = '55000'; end if;
	-- One row per turn: a replay answers the row that is there.
	select change.n into v_n from public.qorpera_code_changes change
	where change.worker_id = p_worker_id and change.sequence = v_worker.sequence;
	if found then
		return jsonb_build_object('schema', 'qorpera.code-change-recorded/v1', 'state', 'replayed', 'change', v_n); end if;

	if v_state in ('conflict','refused') then
		v_append := true;
	elsif v_state = 'landed' and (p_change ->> 'inLine')::boolean then
		-- Made while the company's line was held: main cannot have moved since. A main the record does not know is a
		-- movement nobody recorded.
		v_filler := v_repository.last_main is not null and v_repository.last_main <> v_before;
		v_append := true;
	elsif v_state = 'landed' then
		-- Made after the job: main may have moved again, and a filler may already cover this landing.
		select change.n into v_take from public.qorpera_code_changes change
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.main_after = v_after and change.kind = 'found'
			and change.state <> 'lost'
		order by change.n desc limit 1;
		if v_take is null and (v_repository.last_main is null or v_repository.last_main = v_before) then
			v_append := true;
		elsif v_take is null then
			v_answer := 'late';
		end if;
	else
		-- Main already held the commit: the row that says so, a filler before any other. A row a restore went back past
		-- says nothing of main any more.
		select * into v_row from public.qorpera_code_changes change
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.main_after = v_after and change.state <> 'lost'
		order by (change.kind = 'found') desc, change.n desc limit 1;
		if found and v_row.kind = 'found' then
			v_take := v_row.n;
		elsif found then
			return jsonb_build_object('schema', 'qorpera.code-change-recorded/v1', 'state', 'known', 'change', v_row.n);
		else
			v_filler := v_repository.last_main is not null and v_repository.last_main <> v_before;
		end if;
	end if;
	if v_filler then
		v_found := public.qorpera_code_change_found(v_repository.environment_id, v_repository.owner, v_repository.name,
			v_repository.last_main, v_before);
		-- The filler ends at the commit that first held this turn's: the movement it covers is this turn's.
		if v_state = 'unchanged' and v_before = v_after then v_take := v_found; end if;
	end if;
	if not v_append and v_take is null then
		return jsonb_build_object('schema', 'qorpera.code-change-recorded/v1', 'state', v_answer, 'change', null); end if;

	-- The row's words are the kernel's own: the worker's title and the turn's submission, never the report's.
	v_n := coalesce(v_take, coalesce(v_found, v_repository.last_change) + 1);
	if v_submission ? 'picture' and p_change -> 'picture' ->> 'state' = 'ok' then
		v_picture := jsonb_build_object('source', 'commit', 'path', v_submission ->> 'picture',
			'blob', p_change -> 'picture' -> 'blob', 'bytes', p_change -> 'picture' -> 'bytes',
			'type', p_change -> 'picture' -> 'type', 'at', format('code/%s/%s/changes/%s.%s', v_repository.owner,
				v_repository.name, v_n, case p_change -> 'picture' ->> 'type' when 'jpeg' then 'jpg'
					else p_change -> 'picture' ->> 'type' end));
	elsif v_submission ? 'picture' then
		v_problem := p_change -> 'picture' ->> 'state';
	end if;
	v_words := jsonb_build_object('kind', 'landing', 'worker_id', v_worker.id, 'sequence', v_worker.sequence,
		'staff_agent_id', v_worker.staff_agent_id, 'owner_user_id', v_worker.owner_user_id, 'title', v_worker.title,
		'summary', v_submission ->> 'summary', 'notice', v_submission ->> 'notice', 'head_sha', p_change ->> 'headSha',
		'picture', v_picture, 'picture_problem', v_problem);
	if v_take is not null then
		-- Take the filler over: it becomes this turn's landing; its span, number and state stay.
		update public.qorpera_code_changes change set kind = 'landing', worker_id = v_worker.id, sequence = v_worker.sequence,
			staff_agent_id = v_worker.staff_agent_id, owner_user_id = v_worker.owner_user_id, title = v_worker.title,
			summary = v_submission ->> 'summary', notice = v_submission ->> 'notice', head_sha = p_change ->> 'headSha',
			how = coalesce(p_change ->> 'how', change.how), picture = v_picture, picture_problem = v_problem,
			file_version = change.file_version + 1
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.n = v_take;
		update public.qorpera_code_repositories set index_version = index_version + 1
		where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
		return jsonb_build_object('schema', 'qorpera.code-change-recorded/v1', 'state', 'adopted', 'change', v_take);
	end if;
	if v_state = 'landed' then
		v_paths := public.qorpera_code_change_fit(p_change -> 'paths', 50, 16384);
		v_words := v_words || jsonb_build_object('state', 'landed', 'how', p_change ->> 'how', 'main_before', v_before,
			'main_after', v_after, 'files_changed', p_change -> 'filesChanged', 'paths', v_paths,
			'paths_more', (p_change ->> 'pathsMore')::integer + case when v_paths is null then 0
				else jsonb_array_length(p_change -> 'paths') - jsonb_array_length(v_paths) end);
	else
		v_words := v_words || jsonb_build_object('state', v_state, 'refusal', jsonb_build_object(
			'code', p_change -> 'refusal' -> 'code',
			'paths', public.qorpera_code_change_fit(p_change -> 'refusal' -> 'paths', 20, 7168)));
	end if;
	v_n := public.qorpera_code_change_append(v_repository.environment_id, v_repository.owner, v_repository.name, v_words);
	return jsonb_build_object('schema', 'qorpera.code-change-recorded/v1', 'state', 'recorded', 'change', v_n);
end $$;

-- 6. The record files ---------------------------------------------------------------------------------------------------

-- The repositories with a record file to write, for this executor: a row whose file is behind, or the list, and the
-- pause after a failed write is over. At most p_limit (1 to 50). Read-only.
create function public.qorpera_code_change_files_due(p_owner text, p_machine_id_sha256 text, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_due jsonb;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_limit is null or p_limit not between 1 and 50 then
		raise exception 'Code change files limit invalid' using errcode = '22023'; end if;
	select coalesce(jsonb_agg(jsonb_build_object('companyId', due.profile_id, 'environmentId', due.environment_id,
			'owner', due.owner, 'name', due.name)
		order by due.environment_id, due.owner collate "C", due.name collate "C"), '[]'::jsonb) into v_due
	from (select repository.profile_id, repository.environment_id, repository.owner, repository.name
		from public.qorpera_code_repositories repository
		where (repository.environment_id, repository.owner, repository.name) in (
				select change.environment_id, change.owner, change.name from public.qorpera_code_changes change
				where change.file_written < change.file_version
				union
				select list.environment_id, list.owner, list.name from public.qorpera_code_repositories list
				where list.index_written < list.index_version)
			and (repository.files_not_before is null or repository.files_not_before <= v_now)
			and public.qorpera_code_care_holder(repository.environment_id, p_owner, p_machine_id_sha256)
			and not exists (select 1 from public.qorpera_company_deletions deletion
				where deletion.profile_id = repository.profile_id)
		order by repository.environment_id, repository.owner collate "C", repository.name collate "C"
		limit p_limit) due;
	return jsonb_build_object('schema', 'qorpera.code-change-files-due/v1', 'repositories', v_due);
end $$;

-- What a repository's record files should say: the rows whose file is behind, oldest first, at most p_limit (1 to 20),
-- and the list when it is behind (the newest 100 rows; a row's line is its notice, else its title). Read-only. An
-- executor that does not hold the repository's company, and a repository nobody registered, get no row and no list.
create function public.qorpera_code_change_files(p_owner text, p_machine_id_sha256 text, p_environment_id uuid,
	p_repository_owner text, p_name text, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_changes jsonb := '[]'::jsonb; v_index jsonb;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_repository_owner is null or p_name is null or p_limit is null
		or p_limit not between 1 and 20 then
		raise exception 'Code change files request invalid' using errcode = '22023'; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
	if found and public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256)
		and not exists (select 1 from public.qorpera_company_deletions deletion
			where deletion.profile_id = v_repository.profile_id) then
		select coalesce(jsonb_agg(jsonb_build_object('n', due.n, 'version', due.file_version, 'kind', due.kind,
				'state', due.state, 'how', due.how, 'createdAt', due.created_at, 'title', due.title,
				'session', (select worker.folder_path from public.qorpera_runtime_workers worker where worker.id = due.worker_id),
				'turn', due.sequence, 'mainBefore', due.main_before, 'mainAfter', due.main_after, 'headSha', due.head_sha,
				'summary', due.summary, 'notice', due.notice, 'picture', due.picture, 'pictureProblem', due.picture_problem)
				|| jsonb_build_object('filesChanged', due.files_changed, 'paths', due.paths, 'pathsMore', due.paths_more,
				-- A backfilled row, or a filler: the job counts what changed between the row's two ends of main. Not for a
				-- row a restore went back past, nor for a restore's own: the repository may no longer hold one of its ends.
				'needsDiff', due.files_changed is null and due.main_before is not null and due.main_after is not null
					and due.state <> 'lost' and due.kind <> 'restore',
				'refusal', due.refusal, 'undoes', to_jsonb(due.undoes), 'revertedBy', due.reverted_by,
				'restoredFrom', due.restored_from) order by due.n), '[]'::jsonb) into v_changes
		from (select change.* from public.qorpera_code_changes change
			where change.environment_id = p_environment_id and change.owner = p_repository_owner and change.name = p_name
				and change.file_written < change.file_version
			order by change.n limit p_limit) due;
		if v_repository.index_written < v_repository.index_version then
			select jsonb_build_object('version', v_repository.index_version, 'lines', coalesce(jsonb_agg(jsonb_build_object(
				'n', line.n, 'createdAt', line.created_at, 'state', line.state, 'kind', line.kind,
				'line', coalesce(line.notice, line.title)) order by line.n desc), '[]'::jsonb)) into v_index
			from (select change.n, change.created_at, change.state, change.kind, change.notice, change.title
				from public.qorpera_code_changes change
				where change.environment_id = p_environment_id and change.owner = p_repository_owner and change.name = p_name
				order by change.n desc limit 100) line;
		end if;
	else
		v_repository := null;
	end if;
	return jsonb_build_object('schema', 'qorpera.code-change-files/v1', 'repository', jsonb_build_object(
		'companyId', v_repository.profile_id, 'environmentId', p_environment_id, 'owner', p_repository_owner, 'name', p_name),
		'changes', v_changes, 'index', v_index);
end $$;

-- Whether p_written says which record files were written: exactly its keys; each change names its number and the
-- version written, and may carry the diff the job counted for it.
create function public.qorpera_code_change_files_written_valid(p_written jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_written) = 'object' and pg_column_size(p_written) <= 1048576
		and p_written ?& array['changes','indexVersion','problem']
		and p_written - array['changes','indexVersion','problem'] = '{}'::jsonb
		and (p_written -> 'indexVersion' = 'null'::jsonb or public.qorpera_code_json_count(p_written -> 'indexVersion'))
		and public.qorpera_code_care_text_valid(p_written -> 'problem', '^[A-Z0-9_:]{1,120}$')
		and case when jsonb_typeof(p_written -> 'changes') = 'array' then jsonb_array_length(p_written -> 'changes') <= 50
			and not exists (select 1 from jsonb_array_elements(p_written -> 'changes') entry
				where case when jsonb_typeof(entry) = 'object' then
					entry - array['n','version','filesChanged','paths','pathsMore'] <> '{}'::jsonb
					or not (public.qorpera_code_json_count(entry -> 'n') and entry ->> 'n' ~ '^[1-9][0-9]{0,8}$')
					or not (public.qorpera_code_json_count(entry -> 'version') and entry ->> 'version' ~ '^[1-9][0-9]{0,8}$')
					or (entry ? 'filesChanged' and not (public.qorpera_code_json_count(entry -> 'filesChanged')
						and entry ->> 'filesChanged' ~ '^[0-9]{1,9}$'))
					or (entry ? 'paths' and (entry -> 'paths' = 'null'::jsonb
						or not public.qorpera_code_change_paths_valid(entry -> 'paths')))
					or (entry ? 'pathsMore' and not (public.qorpera_code_json_count(entry -> 'pathsMore')
						and entry ->> 'pathsMore' ~ '^[0-9]{1,9}$'))
					else true end)
			else false end, false)
$$;

-- The record files a job wrote, once the job has saved. Each row's written version moves up to the one written, and the
-- list's too. A diff the job counted fills the row's files where they were not known (no new version: the file just
-- written already holds them). A problem pauses the repository's files, twice as long each time up to 10 minutes; no
-- problem ends the pause. Lost: the caller does not hold the repository's company, or nobody registered the repository.
create function public.qorpera_code_change_files_written(p_owner text, p_machine_id_sha256 text, p_environment_id uuid,
	p_repository_owner text, p_name text, p_written jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_repository public.qorpera_code_repositories%rowtype; v_entry jsonb;
	v_paths jsonb;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_repository_owner is null or p_name is null
		or not public.qorpera_code_change_files_written_valid(p_written) then
		raise exception 'Code change files report invalid' using errcode = '22023'; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name for update;
	if not found or not public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256) then
		return jsonb_build_object('schema', 'qorpera.code-change-files-written/v1', 'state', 'lost'); end if;
	for v_entry in select entry from jsonb_array_elements(p_written -> 'changes') entry loop
		v_paths := public.qorpera_code_change_fit(v_entry -> 'paths', 50, 16384);
		update public.qorpera_code_changes change set
			-- Never past the row's own version: a later change of the row must still find its file behind.
			file_written = greatest(change.file_written, least((v_entry ->> 'version')::integer, change.file_version)),
			files_changed = coalesce(change.files_changed, (v_entry ->> 'filesChanged')::integer),
			paths = case when change.files_changed is null and v_entry ? 'filesChanged' then v_paths else change.paths end,
			paths_more = case when change.files_changed is null and v_entry ? 'filesChanged'
				then coalesce((v_entry ->> 'pathsMore')::integer, 0)
					+ coalesce(jsonb_array_length(v_entry -> 'paths') - jsonb_array_length(v_paths), 0)
				else change.paths_more end
		where change.environment_id = p_environment_id and change.owner = p_repository_owner and change.name = p_name
			and change.n = (v_entry ->> 'n')::integer;
	end loop;
	update public.qorpera_code_repositories set
		index_written = greatest(index_written, least(coalesce((p_written ->> 'indexVersion')::bigint, 0), index_version)),
		files_problem = p_written ->> 'problem',
		files_attempts = case when p_written ->> 'problem' is null then 0 else files_attempts + 1 end,
		files_not_before = case when p_written ->> 'problem' is null then null
			else v_now + least(make_interval(secs => power(2, least(files_attempts + 1, 10))), interval '10 minutes') end
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
	return jsonb_build_object('schema', 'qorpera.code-change-files-written/v1', 'state', 'recorded');
end $$;

-- 7. The requests: claim, step, a restore's record, finish -----------------------------------------------------------------

-- Leases the oldest requests this executor may do now, at most p_limit (1 to 20): queued, or running with a lease that
-- ended; not put off; its company held by this executor and not being deleted. A restore of the place itself stays
-- queued while the company's sessions are not quiet or one of the repository's is on a machine, and its progress says
-- which; one that holds the place (qorpera_code_restore_holds: the kernel's own word in the progress, which a claim
-- hands out with the rest) is handed out whatever the sessions do. A
-- fourth claim of an undo or a restore, or a sixth of a download, ends the request failed (DID_NOT_FINISH) instead; a
-- restore keeps its progress, with what it recorded. Also claimed, as work `remove`: a made download whose time is
-- over. It locks request rows only.
create function public.qorpera_code_requests_claim(p_owner text, p_machine_id_sha256 text, p_limit integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_request public.qorpera_code_requests%rowtype; v_claimed jsonb := '[]'::jsonb;
	v_change public.qorpera_code_changes%rowtype; v_waiting text; v_item jsonb; v_spent boolean;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_limit is null or p_limit not between 1 and 20 then
		raise exception 'Code request limit invalid' using errcode = '22023'; end if;
	for v_request in select request.* from public.qorpera_code_requests request
		where (request.state = 'queued' or (request.state = 'running' and request.lease_until <= v_now))
			and (request.not_before is null or request.not_before <= v_now)
			and public.qorpera_code_care_holder(request.environment_id, p_owner, p_machine_id_sha256)
			and not exists (select 1 from public.qorpera_company_deletions deletion
				where deletion.profile_id = request.profile_id)
		order by request.created_at, request.id
		for update of request skip locked
	loop
		exit when jsonb_array_length(v_claimed) >= p_limit;
		if v_request.kind = 'restore' and v_request.input ->> 'mode' = 'restore'
			and not public.qorpera_code_restore_holds(v_request.progress) then
			v_waiting := public.qorpera_code_restore_waits(v_request.environment_id, v_request.owner, v_request.name, v_now);
			if v_waiting is not null then
				update public.qorpera_code_requests set state = 'queued', lease_token = null, lease_owner = null,
					lease_until = null, progress = coalesce(progress, '{}'::jsonb) || jsonb_build_object('waiting', v_waiting),
					updated_at = v_now
				where id = v_request.id;
				continue;
			end if;
		end if;
		if v_request.kind = 'undo' then
			select * into v_change from public.qorpera_code_changes change
			where change.environment_id = v_request.environment_id and change.owner = v_request.owner
				and change.name = v_request.name and change.n = (v_request.input ->> 'change')::integer;
		end if;
		-- Too many starts with no finish; or an undo whose target is not there with both ends of main (its request
		-- checked that it was).
		v_spent := v_request.attempts >= case when v_request.kind = 'download' then 5 else 3 end;
		if v_spent or (v_request.kind = 'undo' and (v_change.n is null or v_change.main_before is null
			or v_change.main_after is null)) then
			update public.qorpera_code_requests set state = 'failed', lease_token = null, lease_owner = null,
				lease_until = null, finished_at = v_now, updated_at = v_now,
				outcome = jsonb_build_object('schema', 'qorpera.code-request-outcome/v1', 'state', 'failed',
					'code', case when v_spent then 'DID_NOT_FINISH' else 'CHANGE_UNAVAILABLE' end)
			where id = v_request.id;
			continue;
		end if;
		update public.qorpera_code_requests set state = 'running', lease_token = extensions.gen_random_uuid(),
			lease_owner = p_owner, lease_until = v_now + public.qorpera_code_request_lease(kind), attempts = attempts + 1,
			progress = nullif(progress - 'waiting', '{}'::jsonb), updated_at = v_now
		where id = v_request.id returning * into v_request;
		v_item := jsonb_build_object('requestId', v_request.id, 'token', v_request.lease_token,
			'leaseUntil', v_request.lease_until, 'companyId', v_request.profile_id, 'environmentId', v_request.environment_id,
			'owner', v_request.owner, 'name', v_request.name, 'kind', v_request.kind);
		if v_request.kind = 'undo' then
			v_item := v_item || jsonb_build_object('change', jsonb_build_object('n', v_change.n,
					'mainBefore', v_change.main_before, 'mainAfter', v_change.main_after),
				'andLater', (v_request.input ->> 'andLater')::boolean,
				'message', public.qorpera_code_undo_message(v_change.n, v_change.title, (v_request.input ->> 'andLater')::boolean));
		elsif v_request.kind = 'download' then
			v_item := v_item || jsonb_build_object('work', 'make', 'file', v_request.input ->> 'file',
				'fileName', v_request.input ->> 'fileName', 'path', format('code/%s/%s/downloads/%s', v_request.owner,
					v_request.name, v_request.input ->> 'fileName'));
		else
			v_item := v_item || jsonb_build_object('mode', v_request.input ->> 'mode', 'bundle', v_request.input -> 'bundle',
				'damaged', v_request.input ->> 'damaged', 'progress', v_request.progress, 'path', v_request.input -> 'path',
				-- The repository's sessions that are not archived and have a base. (Which rows the restored main holds is
				-- the kernel's own to find, from the rows: qorpera_code_changes_restored.)
				'sessions', (select coalesce(jsonb_agg(jsonb_build_object('workerId', kept.worker_id, 'baseSha', kept.base_sha)
						order by kept.worker_id), '[]'::jsonb)
					from (select session.worker_id, session.base_sha from public.qorpera_coding_sessions session
						where session.environment_id = v_request.environment_id and session.archived_at is null
							and session.repository ->> 'host' = 'qorpera' and session.repository ->> 'owner' = v_request.owner
							and session.repository ->> 'name' = v_request.name and session.base_sha is not null
						order by session.worker_id limit 200) kept));
		end if;
		v_claimed := v_claimed || v_item;
	end loop;
	-- A made download whose time is over: its file is removed. Six claims and no finish: the request ends, and the file
	-- stays until the next download of its kind replaces it. A file is removed by its name, and two downloads of one
	-- kind on one day have the same name: a newer download of the kind that was made has replaced this one's file, so
	-- there is nothing of it left to remove; while a newer one is on its way, this one waits for it.
	for v_request in select request.* from public.qorpera_code_requests request
		where request.kind = 'download' and request.state = 'done' and request.expires_at <= v_now
			and (request.lease_until is null or request.lease_until <= v_now)
			and (request.not_before is null or request.not_before <= v_now)
			and public.qorpera_code_care_holder(request.environment_id, p_owner, p_machine_id_sha256)
			and not exists (select 1 from public.qorpera_company_deletions deletion
				where deletion.profile_id = request.profile_id)
		order by request.expires_at, request.id
		for update of request skip locked
	loop
		exit when jsonb_array_length(v_claimed) >= p_limit;
		v_waiting := (select newer.state from public.qorpera_code_requests newer
			where newer.environment_id = v_request.environment_id and newer.owner = v_request.owner
				and newer.name = v_request.name and newer.created_at > v_request.created_at and newer.kind = 'download'
				and newer.input ->> 'file' = v_request.input ->> 'file' and newer.state in ('queued','running','done')
			order by newer.created_at desc limit 1);
		if v_request.attempts >= 5 or v_waiting = 'done' then
			update public.qorpera_code_requests set state = 'expired', lease_token = null, lease_owner = null,
				lease_until = null, updated_at = v_now
			where id = v_request.id;
			continue;
		end if;
		continue when v_waiting is not null;
		update public.qorpera_code_requests set lease_token = extensions.gen_random_uuid(), lease_owner = p_owner,
			lease_until = v_now + public.qorpera_code_request_lease(kind), attempts = attempts + 1, updated_at = v_now
		where id = v_request.id returning * into v_request;
		v_claimed := v_claimed || jsonb_build_object('requestId', v_request.id, 'token', v_request.lease_token,
			'leaseUntil', v_request.lease_until, 'companyId', v_request.profile_id, 'environmentId', v_request.environment_id,
			'owner', v_request.owner, 'name', v_request.name, 'kind', 'download', 'work', 'remove',
			'file', v_request.input ->> 'file', 'fileName', v_request.input ->> 'fileName',
			'path', format('code/%s/%s/downloads/%s', v_request.owner, v_request.name, v_request.input ->> 'fileName'));
	end loop;
	return jsonb_build_object('schema', 'qorpera.code-requests/v1', 'requests', v_claimed);
end $$;

-- Asked before each job of a download or a restore, with the job's place in its company's line held and before the
-- job's first command: renews the lease and saves what the request has done so far. Lost: the token is not the
-- request's lease, or the caller no longer holds the company. Busy: a restore of the place itself that does not hold
-- it (qorpera_code_restore_holds), when the company's sessions are no longer quiet or one of the repository's is on a
-- machine. A download is never busy here: a turn's job cancels its job instead.
-- Whether a restore holds the place is the kernel's own to keep (`held` in the progress), by one rule:
-- * A step that names `close` or `set-aside` and is let go writes `held`. For the first close that answer is given
--   under the ordinary rule, so the place is about to be closed while the company is quiet. Every later step and
--   claim of the request is then let go whatever the sessions do, whatever its name: also the first step of a later
--   claim, which reads the place or closes it again.
-- * The step that names `reopened` takes `held` away. The executor asks it only when the place was seen open as it
--   was: the close wrote no mark, or the mark this request wrote was removed with nothing moved, or a job read the
--   place and found none. From then on the request waits for quiet sessions like one that has not begun. No other
--   word takes `held` away, and the caller cannot write it or remove it by sending it. A `reopened` that is not heard
--   leaves `held` in place: the next claim reads the place first, and says it again.
-- The step is also how the kernel learns that a job is about to displace what a made download points at, before the
-- job does it. So no download reads ready with its file gone, whatever becomes of the job or of its finish:
-- * A restore's job that sets the place aside is let go (the step that names `set-aside`: the one job of a restore
--   that moves anything out of the place asks it before it moves anything): the repository's artifact generation goes
--   up, and every made download of the repository is over, since downloads/ goes aside with the place. Each time it
--   is asked, not once for a request: a job that was let go may fail before it moves anything, the place is then
--   opened again as it was, downloads are made there, and the same request, claimed again, moves the place after
--   all. Its step then ends those too. A step asked twice ends nothing twice, and a download ended while its file
--   still stands is only asked for again.
-- * No other step of a restore ends a download: closing the place, building it, opening it and removing a set-aside
--   copy move nothing out of it. So a download made once the repository is open again outlives the rest of that
--   restore.
-- * A download is to be made: the request takes the repository's generation as it stands, which is the one its file
--   is made in, and the repository's earlier made download of the same file is over, since the job replaces what
--   downloads/ holds of its kind.
-- A step that answers busy or lost does none of this, and its job does not run. What a restore recorded (`recorded`,
-- which qorpera_code_restore_record wrote into the progress) and `held` are the kernel's own words there: a step
-- keeps them, and takes none from its caller. It locks the request's row; for a download's step and for a restore's
-- of the place, the repository's registry row before it.
create function public.qorpera_code_request_step(p_owner text, p_machine_id_sha256 text, p_request_id uuid,
	p_token uuid, p_progress jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_request public.qorpera_code_requests%rowtype;
	v_generation bigint; v_progress jsonb; v_place boolean; v_step text;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	-- (3 KiB: the row holds 4, and a restore that waits adds its word.)
	if p_progress is not null and (jsonb_typeof(p_progress) <> 'object' or pg_column_size(p_progress) > 3072) then
		raise exception 'Code request progress invalid' using errcode = '22023'; end if;
	-- An unlocked read names the request's kind and its repository, whose registry row is locked before the request's.
	select * into v_request from public.qorpera_code_requests where id = p_request_id;
	if v_request.kind = 'download' or (v_request.kind = 'restore' and v_request.input ->> 'mode' = 'restore') then
		select repository.artifact_generation into v_generation from public.qorpera_code_repositories repository
		where repository.environment_id = v_request.environment_id and repository.owner = v_request.owner
			and repository.name = v_request.name for update;
	end if;
	select * into v_request from public.qorpera_code_requests where id = p_request_id for update;
	if not found or p_token is null or v_request.lease_token is distinct from p_token
		or v_request.lease_owner is distinct from p_owner
		or not public.qorpera_code_care_holder(v_request.environment_id, p_owner, p_machine_id_sha256)
		or exists (select 1 from public.qorpera_company_deletions deletion
			where deletion.profile_id = v_request.profile_id) then
		return jsonb_build_object('schema', 'qorpera.code-request-step/v1', 'state', 'lost'); end if;
	-- The progress as this step will leave it: what the call brings (the row's own when it brings none), with the
	-- kernel's words as the row has them, whatever the caller sent under their names.
	v_progress := case when p_progress is null then v_request.progress else (p_progress - 'recorded' - 'held')
		|| case when v_request.progress ? 'recorded' then jsonb_build_object('recorded', v_request.progress -> 'recorded')
			else '{}'::jsonb end
		|| case when v_request.progress ? 'held' then jsonb_build_object('held', v_request.progress -> 'held')
			else '{}'::jsonb end end;
	v_place := v_request.kind = 'restore' and v_request.input ->> 'mode' = 'restore';
	v_step := v_progress ->> 'step';
	if v_place and not public.qorpera_code_restore_holds(v_progress)
		and public.qorpera_code_restore_waits(v_request.environment_id, v_request.owner, v_request.name, v_now) is not null then
		return jsonb_build_object('schema', 'qorpera.code-request-step/v1', 'state', 'busy'); end if;
	if v_place and v_step = 'set-aside' then
		-- The job this step lets go moves the place aside, downloads/ with it. Every such step ends what was made
		-- there, however often the request asks it. And the request holds the place.
		update public.qorpera_code_repositories set artifact_generation = artifact_generation + 1
		where environment_id = v_request.environment_id and owner = v_request.owner and name = v_request.name
		returning artifact_generation into v_generation;
		update public.qorpera_code_requests request set state = 'expired', lease_token = null, lease_owner = null,
			lease_until = null, updated_at = v_now
		where request.environment_id = v_request.environment_id and request.owner = v_request.owner
			and request.name = v_request.name and request.kind = 'download' and request.state = 'done';
		v_progress := v_progress || '{"held":true}'::jsonb;
	elsif v_place and v_step = 'close' then
		-- The job this step lets go closes the place: from here the request holds it, and the kernel keeps that word.
		v_progress := v_progress || '{"held":true}'::jsonb;
	elsif v_place and v_step = 'reopened' then
		-- The executor saw the place open again as it was: the request waits for quiet sessions again.
		v_progress := v_progress - 'held';
	elsif v_request.kind = 'download' and v_request.state = 'running' then
		-- The job this step lets go replaces what downloads/ holds of its kind. (A made download claimed to be removed
		-- is `done`, and displaces nothing.)
		update public.qorpera_code_requests request set state = 'expired', lease_token = null, lease_owner = null,
			lease_until = null, updated_at = v_now
		where request.environment_id = v_request.environment_id and request.owner = v_request.owner
			and request.name = v_request.name and request.kind = 'download' and request.state = 'done'
			and request.input ->> 'file' = v_request.input ->> 'file';
	end if;
	update public.qorpera_code_requests set lease_until = v_now + public.qorpera_code_request_lease(kind),
		progress = v_progress,
		artifact_generation = case when kind = 'download' and state = 'running' then v_generation
			else artifact_generation end,
		updated_at = v_now
	where id = p_request_id returning * into v_request;
	return jsonb_build_object('schema', 'qorpera.code-request-step/v1', 'state', 'go', 'leaseUntil', v_request.lease_until);
end $$;

-- Whether p_outcome is how a request of that kind ended, qorpera.code-request-outcome/v1: exactly the keys of one of its
-- shapes, each of its kind.
create function public.qorpera_code_request_outcome_valid(p_kind text, p_outcome jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_outcome) = 'object' and pg_column_size(p_outcome) <= 65536
		and p_outcome -> 'schema' = '"qorpera.code-request-outcome/v1"'::jsonb
		and case
			when p_outcome -> 'state' = '"busy"'::jsonb then p_outcome - array['schema','state'] = '{}'::jsonb
			when p_outcome -> 'state' = '"failed"'::jsonb then
				p_outcome - array['schema','state','code'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^[A-Z0-9_:]{1,120}$')
			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind = 'undo' then
				p_outcome ?& array['paths'] and p_outcome - array['schema','state','code','paths'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^CODE_HOST_[A-Z0-9_]{1,100}$')
				and public.qorpera_code_json_strings(p_outcome -> 'paths', 100)
			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind = 'download' then
				p_outcome - array['schema','state','code'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^CODE_HOST_[A-Z0-9_]{1,100}$')
			when p_outcome -> 'state' = '"done"'::jsonb then case p_kind || ':' || coalesce(p_outcome ->> 'result', '')
				when 'undo:undone' then
					p_outcome ?& array['filesChanged','paths','pathsMore']
					and p_outcome - array['schema','state','result','mainBefore','mainAfter','filesChanged','paths',
						'pathsMore'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'mainBefore', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'mainAfter', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_count(p_outcome -> 'filesChanged') and p_outcome ->> 'filesChanged' ~ '^[0-9]{1,9}$'
					and jsonb_typeof(p_outcome -> 'paths') = 'array' and public.qorpera_code_change_paths_valid(p_outcome -> 'paths')
					and public.qorpera_code_json_count(p_outcome -> 'pathsMore') and p_outcome ->> 'pathsMore' ~ '^[0-9]{1,9}$'
				when 'undo:nothing' then
					p_outcome - array['schema','state','result','mainSha'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
				when 'download:made' then
					p_outcome - array['schema','state','result','path','bytes','sha256','mainSha'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'path', '^code/.') and octet_length(p_outcome ->> 'path') <= 1024
					and public.qorpera_code_json_count(p_outcome -> 'bytes')
					and public.qorpera_code_json_text(p_outcome -> 'sha256', '^[0-9a-f]{64}$')
					and public.qorpera_code_json_text(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
				when 'download:removed' then p_outcome - array['schema','state','result'] = '{}'::jsonb
				when 'restore:verified' then
					p_outcome - array['schema','state','result','mainSha','refsSha256','refs'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'refsSha256', '^[0-9a-f]{64}$')
					and public.qorpera_code_json_count(p_outcome -> 'refs')
				when 'restore:restored' then
					pg_column_size(p_outcome) <= 12288 and p_outcome ?& array['previousMainSha','stranded','movedTo']
					and p_outcome - array['schema','state','result','bundle','mainSha','previousMainSha','refsSha256','refs',
						'stranded','movedTo'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'bundle', '^\d{8}T\d{6}Z-[0-9a-f]{12}$')
					and public.qorpera_code_json_text(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
					and public.qorpera_code_care_text_valid(p_outcome -> 'previousMainSha', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'refsSha256', '^[0-9a-f]{64}$')
					and public.qorpera_code_json_count(p_outcome -> 'refs')
					and public.qorpera_code_json_strings(p_outcome -> 'stranded', 200)
					and public.qorpera_code_care_text_valid(p_outcome -> 'movedTo', '^code/_set-aside/.')
					and coalesce(octet_length(p_outcome ->> 'movedTo'), 0) <= 1024
				when 'restore:discarded' then p_outcome - array['schema','state','result'] = '{}'::jsonb
				else false end
			else false end, false)
$$;

-- A restore's record: its row, and every row's state as the restored main has it. The executor makes this call inside
-- the job that opens the place again, with the company's line held and the mark that closes the place still there, as
-- a landing's row is written inside its own job: so no landing can be recorded between the restored main and this
-- row. The request stays its caller's (running); qorpera_code_request_finish ends it once that job has saved.
-- p_restored, exactly: {"schema":"qorpera.code-restore-record/v1","bundle":"<the stored bundle's name>",
-- "mainSha":"<main as restored>","previousMainSha":"<main when the place was closed>"|null}.
-- Under the registry row's lock:
-- * Main was not where the record had it when the place was closed (previousMainSha is given and is not the record's
--   main): a filler for that gap first, as before any other movement.
-- * Every row's state as the restored main's history has it (qorpera_code_changes_restored).
-- * The restore's own row, from main as it was to main as restored.
-- * The place is new: every record file and the list are written again, each at a new version, so that no
--   acknowledgment of a file written in the old place, which may still be on its way, counts for the new one; and
--   care checks the repository at the next quiet moment, trusting no refs it knew. (The downloads made in the old
--   place were over when the restore's job was let go to move it: qorpera_code_request_step.)
-- Made again, it is the same record:
-- * by the same request (the first answer was not heard, or the job did not save and the request was claimed again):
--   what it recorded is answered, and nothing is written;
-- * by a later request, when the record's newest movement of main is already this restore (an earlier request recorded
--   it and did not come to its end; the place has been closed since, so nothing moved main): that row is answered and
--   no second one is written; the rest is done again, which changes nothing.
-- Answers {"schema":"qorpera.code-restore-recorded/v1","state":"recorded","change":<the restore's row>,
-- "boundary":"found"|"unknown","keptThrough":<n>|null,"lost":<int>,"back":<int>} (the last four as
-- qorpera_code_changes_restored gives them; unknown: where the restored main stands among the earlier rows is not
-- known, their states were left as they were, and an operator must look), or
-- {…,"state":"lost"}: the token is not the request's lease, or the caller no longer holds the company; nothing is
-- written then. What was recorded is kept in the request's progress (`recorded`), for the same request's next call,
-- for the finish and for the operator. It locks the repository's registry row, then the request's, then rows of the
-- two tables.
create function public.qorpera_code_restore_record(p_owner text, p_machine_id_sha256 text, p_request_id uuid,
	p_token uuid, p_restored jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp(); v_request public.qorpera_code_requests%rowtype;
	v_repository public.qorpera_code_repositories%rowtype; v_last public.qorpera_code_changes%rowtype;
	v_bundle text := p_restored ->> 'bundle'; v_main text := p_restored ->> 'mainSha';
	v_previous text := p_restored ->> 'previousMainSha'; v_n integer; v_recorded jsonb;
	c_recorded constant jsonb := '{"schema":"qorpera.code-restore-recorded/v1","state":"recorded"}';
	c_lost constant jsonb := '{"schema":"qorpera.code-restore-recorded/v1","state":"lost"}';
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if jsonb_typeof(p_restored) is distinct from 'object'
		or not p_restored ?& array['schema','bundle','mainSha','previousMainSha']
		or p_restored - array['schema','bundle','mainSha','previousMainSha'] <> '{}'::jsonb
		or p_restored -> 'schema' <> '"qorpera.code-restore-record/v1"'::jsonb
		or not public.qorpera_code_json_text(p_restored -> 'bundle', '^\d{8}T\d{6}Z-[0-9a-f]{12}$')
		or not public.qorpera_code_json_text(p_restored -> 'mainSha', '^[0-9a-f]{40}$')
		or not public.qorpera_code_care_text_valid(p_restored -> 'previousMainSha', '^[0-9a-f]{40}$') then
		raise exception 'Code restore record invalid' using errcode = '22023'; end if;
	-- An unlocked read names the request's repository, whose registry row is locked before the request's.
	select * into v_request from public.qorpera_code_requests where id = p_request_id;
	if v_request.id is null or p_token is null then return c_lost; end if;
	-- The company's profile row first: a row written below checks its key (as qorpera_record_code_change).
	perform 1 from public.qorpera_profiles profile where profile.id = v_request.profile_id for key share;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_request.environment_id and owner = v_request.owner and name = v_request.name for update;
	select * into v_request from public.qorpera_code_requests where id = p_request_id for update;
	if v_request.lease_token is distinct from p_token or v_request.lease_owner is distinct from p_owner
		or not public.qorpera_code_care_holder(v_request.environment_id, p_owner, p_machine_id_sha256) then
		return c_lost; end if;
	-- Only a restore of the place is recorded, from the bundle that was asked for (`fresh` is the one the executor
	-- stored for it).
	if v_request.kind <> 'restore' or v_request.input ->> 'mode' <> 'restore'
		or v_request.input ->> 'bundle' not in ('fresh', v_bundle) then
		raise exception 'Code restore record invalid' using errcode = '22023'; end if;
	-- The same request again: what it recorded.
	v_recorded := v_request.progress -> 'recorded';
	if v_recorded is not null then
		if v_recorded ->> 'bundle' is distinct from v_bundle or v_recorded ->> 'mainSha' is distinct from v_main then
			raise exception 'Code restore record invalid' using errcode = '22023'; end if;
		return c_recorded || (v_recorded - 'bundle' - 'mainSha');
	end if;
	select * into v_last from public.qorpera_code_changes change
	where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
		and change.name = v_repository.name and change.main_after is not null
	order by change.n desc limit 1;
	if v_last.kind = 'restore' and v_last.restored_from = v_bundle and v_last.main_after = v_main
		and v_repository.last_main = v_main then
		-- The record's newest movement of main is this restore, from a request that did not come to its end.
		v_n := v_last.n;
	elsif v_repository.last_main is not null and v_previous <> v_repository.last_main then
		-- Main had moved before the place was closed, and nobody recorded how.
		perform public.qorpera_code_change_found(v_repository.environment_id, v_repository.owner, v_repository.name,
			v_repository.last_main, v_previous);
	end if;
	v_recorded := public.qorpera_code_changes_restored(v_repository.environment_id, v_repository.owner,
		v_repository.name, v_main);
	if v_n is null then
		v_n := public.qorpera_code_change_append(v_repository.environment_id, v_repository.owner, v_repository.name,
			jsonb_build_object('kind', 'restore', 'state', 'landed',
				'main_before', coalesce(v_previous, v_repository.last_main), 'main_after', v_main,
				'request_id', v_request.id, 'restored_from', v_bundle,
				'title', format('Restored from the copy of %s-%s-%s %s:%s UTC', substr(v_bundle, 1, 4), substr(v_bundle, 5, 2),
					substr(v_bundle, 7, 2), substr(v_bundle, 10, 2), substr(v_bundle, 12, 2)),
				'summary', v_request.input ->> 'note', 'owner_user_id', v_request.by_user_id));
	end if;
	-- The place is new: every file is written again from the rows, and care checks it at the next quiet moment. Each
	-- file's version goes up, and the list's: the files of the old place went aside, and a job that wrote one of them
	-- may still say so after this. What it says is of an older version, and leaves the file due.
	update public.qorpera_code_changes change set file_version = change.file_version + 1, file_written = 0
	where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
		and change.name = v_repository.name;
	update public.qorpera_code_repositories set main_sha = v_main, restored_at = v_now, restored_from = v_bundle,
		refs_sha256 = null, next_care_at = v_now, index_version = index_version + 1, index_written = 0
	where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
	v_recorded := v_recorded || jsonb_build_object('change', v_n);
	update public.qorpera_code_requests set updated_at = v_now, progress = coalesce(progress, '{}'::jsonb)
		|| jsonb_build_object('recorded', v_recorded || jsonb_build_object('bundle', v_bundle, 'mainSha', v_main))
	where id = p_request_id;
	return c_recorded || v_recorded;
end $$;

-- How a claimed request ended. Recorded, with the number of the row it wrote (an undo that took something out, a
-- restore that put the repository back), or lost: the token is not the request's lease, or the caller no longer holds
-- the company; nothing is written then.
-- * busy: back in the queue for two minutes.
-- * An undo that moved main: a filler first when main was not where the record had it, then the undo's row; the rows
--   it took out are reverted by it. With andLater that is every row from the target on that was in main, newest
--   first, each as it stands when its turn comes, so an undo among them puts its own targets back before they go too.
--   A finish that comes after its job, when the record has moved on, takes over the filler that covers the undo.
-- * A made download lasts 7 days; a removed one is expired. `made` is taken only from a request whose job asked its
--   step first (55000 otherwise): the step gave it the repository's artifact generation, and ended the earlier made
--   download of its file before the job replaced it. When a restore's job was let go to move the place since, the
--   file went aside before this finish came, or may have: the download is over at once (expired), and is ready to
--   nobody. The finish ends no other request.
-- * A restore that put the repository back was recorded inside the job that opened the place
--   (qorpera_code_restore_record): the finish writes no row. It ends the request, with what was recorded beside the
--   outcome, and takes `restored` only for a request that recorded this bundle at this main (55000 otherwise): a
--   record made now, with the place open, could take a landing made since for one the restore went back past.
-- It locks the repository's registry row, then the request's.
create function public.qorpera_code_request_finish(p_owner text, p_machine_id_sha256 text, p_request_id uuid,
	p_token uuid, p_outcome jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp(); v_request public.qorpera_code_requests%rowtype;
	v_repository public.qorpera_code_repositories%rowtype; v_change public.qorpera_code_changes%rowtype;
	v_state text := p_outcome ->> 'state'; v_result text := p_outcome ->> 'result'; v_removal boolean; v_n integer;
	v_target integer; v_later boolean; v_each integer; v_undoes integer[] := '{}'; v_paths jsonb; v_recorded jsonb;
	v_words jsonb; v_exact boolean; v_stored jsonb := p_outcome; v_displaced boolean := false;
	v_lost jsonb := jsonb_build_object('schema', 'qorpera.code-request-finish/v1', 'state', 'lost');
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	-- An unlocked read names the request's kind and its repository, whose registry row is locked before the request's.
	select * into v_request from public.qorpera_code_requests where id = p_request_id;
	if not public.qorpera_code_request_outcome_valid(coalesce(v_request.kind, 'undo'), p_outcome)
		and not (v_request.id is null and (public.qorpera_code_request_outcome_valid('download', p_outcome)
			or public.qorpera_code_request_outcome_valid('restore', p_outcome))) then
		raise exception 'Code request outcome invalid' using errcode = '22023'; end if;
	if v_request.id is null or p_token is null then return v_lost; end if;
	-- The company's profile row first: a row written below checks its key (as qorpera_record_code_change).
	perform 1 from public.qorpera_profiles profile where profile.id = v_request.profile_id for key share;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_request.environment_id and owner = v_request.owner and name = v_request.name for update;
	select * into v_request from public.qorpera_code_requests where id = p_request_id for update;
	if v_request.lease_token is distinct from p_token or v_request.lease_owner is distinct from p_owner
		or not public.qorpera_code_care_holder(v_request.environment_id, p_owner, p_machine_id_sha256) then
		return v_lost; end if;
	-- A made download whose time is over was claimed to be removed; everything else was claimed to be done.
	v_removal := v_request.state = 'done';
	if (v_removal and not (v_state in ('busy','failed') or v_result is not distinct from 'removed'))
		or (not v_removal and v_result is not distinct from 'removed')
		or (v_request.kind = 'restore' and v_state = 'done' and v_result is distinct from case v_request.input ->> 'mode'
			when 'verify' then 'verified' when 'restore' then 'restored' else 'discarded' end)
		or (v_result = 'made' and p_outcome ->> 'path' is distinct from format('code/%s/%s/downloads/%s', v_request.owner,
			v_request.name, v_request.input ->> 'fileName')) then
		raise exception 'Code request outcome invalid' using errcode = '22023'; end if;

	if v_state = 'busy' or (v_removal and v_state = 'failed') then
		-- Put off: a turn's job came first. A removal that failed is tried again later; the request itself was done.
		update public.qorpera_code_requests set state = case when v_removal then 'done' else 'queued' end,
			lease_token = null, lease_owner = null, lease_until = null,
			not_before = v_now + case when v_state = 'busy' then interval '2 minutes' else interval '10 minutes' end,
			-- A download that ends because it was put off every time says so to the member who waits.
			progress = case when kind = 'download' and not v_removal then '{"busy":true}'::jsonb else progress end,
			updated_at = v_now
		where id = p_request_id;
		return jsonb_build_object('schema', 'qorpera.code-request-finish/v1', 'state', 'recorded', 'change', null);
	end if;

	if v_request.kind = 'undo' and v_result = 'undone' then
		v_target := (v_request.input ->> 'change')::integer;
		v_later := (v_request.input ->> 'andLater')::boolean;
		select * into v_change from public.qorpera_code_changes change
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.n = v_target;
		v_paths := public.qorpera_code_change_fit(p_outcome -> 'paths', 50, 16384);
		v_words := jsonb_build_object('kind', 'undo', 'undoes', '[]'::jsonb, 'request_id', v_request.id,
			'title', public.qorpera_code_undo_message(v_target, coalesce(v_change.title, 'a change'), v_later),
			'summary', v_request.input ->> 'reason', 'notice', v_request.input ->> 'notice',
			'staff_agent_id', v_request.by_agent_id, 'owner_user_id', v_request.by_user_id,
			'files_changed', p_outcome -> 'filesChanged', 'paths', v_paths,
			'paths_more', (p_outcome ->> 'pathsMore')::integer
				+ jsonb_array_length(p_outcome -> 'paths') - jsonb_array_length(v_paths));
		if v_repository.last_main is not null and v_repository.last_main <> p_outcome ->> 'mainBefore' then
			-- Main is not where the record has it. When this finish comes after its job (the first was not heard), the
			-- record may have moved on: the next movement recorded left a filler that covers the undo. It ends at the
			-- undo's commit, or, when more was lost with it, starts where the undo started. The undo takes that filler
			-- over, as a landing reported late does. With no such filler main had moved before the undo and nobody
			-- recorded it: a filler for that gap first.
			select change.n, change.main_before = p_outcome ->> 'mainBefore' and change.main_after = p_outcome ->> 'mainAfter'
				and change.files_changed is null into v_n, v_exact
			from public.qorpera_code_changes change
			where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
				and change.name = v_repository.name and change.n > v_target and change.kind = 'found'
				and change.state in ('landed','reverted')
				and (change.main_after = p_outcome ->> 'mainAfter' or change.main_before = p_outcome ->> 'mainBefore')
			order by (change.main_after = p_outcome ->> 'mainAfter') desc, change.n desc limit 1;
			if v_n is null then
				perform public.qorpera_code_change_found(v_repository.environment_id, v_repository.owner, v_repository.name,
					v_repository.last_main, p_outcome ->> 'mainBefore');
			end if;
		end if;
		if v_n is not null then
			-- The filler becomes the undo's row; its span, number and state stay. What the job counted is the row's when
			-- the filler covers the undo and nothing else.
			update public.qorpera_code_changes change set kind = 'undo', undoes = '{}', request_id = v_request.id,
				title = v_words ->> 'title', summary = v_words ->> 'summary', notice = v_words ->> 'notice',
				staff_agent_id = v_request.by_agent_id, owner_user_id = v_request.by_user_id,
				files_changed = case when v_exact then (p_outcome ->> 'filesChanged')::integer else change.files_changed end,
				paths = case when v_exact then v_paths else change.paths end,
				paths_more = case when v_exact then (v_words ->> 'paths_more')::integer else change.paths_more end,
				file_version = change.file_version + 1
			where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
				and change.name = v_repository.name and change.n = v_n;
			update public.qorpera_code_repositories set index_version = index_version + 1
			where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
		else
			v_n := public.qorpera_code_change_append(v_repository.environment_id, v_repository.owner, v_repository.name,
				v_words || jsonb_build_object('state', 'landed', 'main_before', p_outcome ->> 'mainBefore',
					'main_after', p_outcome ->> 'mainAfter'));
		end if;
		if v_later then
			for v_each in select change.n from public.qorpera_code_changes change
				where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
					and change.name = v_repository.name and change.n >= v_target and change.n < v_n
				order by change.n desc
			loop
				if (select change.state from public.qorpera_code_changes change
					where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
						and change.name = v_repository.name and change.n = v_each) = 'landed' then
					perform public.qorpera_code_change_set(v_repository.environment_id, v_repository.owner, v_repository.name,
						v_each, false, v_n);
					v_undoes := v_each || v_undoes;
				end if;
			end loop;
		else
			perform public.qorpera_code_change_set(v_repository.environment_id, v_repository.owner, v_repository.name,
				v_target, false, v_n);
			v_undoes := array[v_target];
		end if;
		update public.qorpera_code_changes change set undoes = v_undoes
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.n = v_n;
		-- The row holds what changed; the request keeps the rest of the outcome.
		v_stored := p_outcome - 'paths';
	elsif v_request.kind = 'restore' and v_result = 'restored' then
		v_recorded := v_request.progress -> 'recorded';
		if v_recorded is null or v_recorded ->> 'bundle' is distinct from p_outcome ->> 'bundle'
			or v_recorded ->> 'mainSha' is distinct from p_outcome ->> 'mainSha' then
			raise exception 'Code restore is not recorded' using errcode = '55000'; end if;
		v_n := (v_recorded ->> 'change')::integer;
		-- The request keeps the outcome with what the record found: the boundary, the newest row main holds, and how
		-- many rows went and came back.
		v_stored := p_outcome || (v_recorded - 'change' - 'bundle' - 'mainSha');
	end if;
	-- A made download counts in the generation its job was begun in, and in no other: a restore's job that was let go
	-- to move the place since took its file aside.
	if v_result = 'made' then
		if v_request.artifact_generation is null then
			raise exception 'Code download was not begun' using errcode = '55000'; end if;
		v_displaced := v_request.artifact_generation <> v_repository.artifact_generation;
	end if;
	-- What a refused undo names fits the row.
	if v_state = 'refused' and p_outcome ? 'paths' then
		v_stored := p_outcome || jsonb_build_object('paths', public.qorpera_code_change_fit(p_outcome -> 'paths', 100, 12288));
	end if;
	update public.qorpera_code_requests set
		state = case when v_result = 'removed' or v_displaced then 'expired' else v_state end,
		lease_token = null, lease_owner = null, lease_until = null, not_before = null,
		-- A made download counts its removal's claims from none.
		attempts = case when v_result = 'made' then 0 else attempts end,
		outcome = case when v_n is null then v_stored else v_stored || jsonb_build_object('change', v_n) end,
		finished_at = coalesce(finished_at, v_now), updated_at = v_now,
		expires_at = case when v_result = 'made' and not v_displaced then v_now + interval '7 days' else expires_at end
	where id = p_request_id;
	return jsonb_build_object('schema', 'qorpera.code-request-finish/v1', 'state', 'recorded', 'change', v_n);
end $$;

-- 8. The agent's calls --------------------------------------------------------------------------------------------------

-- The run that may look after the company's code: an agent's own company run (never a worker's, a coding session's
-- included), whose wake allows work, as qorpera_folder_archive_coding_worker checks it (20260928499140).
create function public.qorpera_code_agent_run(p_binding jsonb)
returns public.qorpera_execution_runs language plpgsql volatile security definer set search_path = '' as $$
declare v_tool jsonb := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb); v_run public.qorpera_execution_runs%rowtype;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_tool -> 'resolved' -> 'audience' ->> 'kind' is distinct from 'company' or (public.qorpera_run_worker(v_run.id)).id is not null
		or not exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = v_run.profile_id
			and staff.staff_agent_id = v_run.staff_agent_id and staff.folder_environment_id = v_run.environment_id
			and staff.folder_retired_at is null and staff.deleted_at is null) then
		raise exception 'Code authority is unavailable' using errcode = '42501'; end if;
	return v_run;
end $$;

-- An agent asks for a change to be taken out of main: that change alone, or with andLater that change and every later
-- one. Answers queued (a request was added, or the open request for the very same undo was found: the same change
-- with the same andLater), already (the row is reverted) or refused with why; P0002 when there is no such repository
-- or number. An open undo of that change with the other scope is another undo: the caller is told busy, never handed
-- a request that does something else than it asked. A replay under the same operation key answers what the first
-- call answered.
create function public.qorpera_folder_request_code_undo(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_repository public.qorpera_code_repositories%rowtype;
	v_change public.qorpera_code_changes%rowtype; v_open public.qorpera_code_requests%rowtype; v_n integer;
	v_later boolean; v_reason text; v_id uuid;
begin
	-- Exactly its keys; the notice may be left out, which is a null.
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['operationKey','owner','name','change','andLater','reason']
		or p_request - array['operationKey','owner','name','change','andLater','reason','notice'] <> '{}'::jsonb
		or not public.qorpera_code_json_text(p_request -> 'operationKey', '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$')
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or not (public.qorpera_code_json_count(p_request -> 'change') and p_request ->> 'change' ~ '^[1-9][0-9]{0,8}$')
		or jsonb_typeof(p_request -> 'andLater') is distinct from 'boolean'
		or jsonb_typeof(p_request -> 'reason') is distinct from 'string' or btrim(p_request ->> 'reason') = ''
		or octet_length(p_request ->> 'reason') > 500
		or (p_request ->> 'notice' is not null and not public.qorpera_code_notice_valid(p_request ->> 'notice'))
		or (p_request ? 'notice' and jsonb_typeof(p_request -> 'notice') not in ('string','null')) then
		raise exception 'Code request is invalid' using errcode = '22023'; end if;
	v_run := public.qorpera_code_agent_run(p_binding);
	v_n := (p_request ->> 'change')::integer;
	v_later := (p_request ->> 'andLater')::boolean;
	-- (A notice left out and a null one are the same request.)
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('schema', 'qorpera.folder-code-undo/v1',
		'runId', v_run.id, 'request', p_request || jsonb_build_object('notice', p_request -> 'notice'))::text, 'utf8'),
		'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(p_binding, v_receipt_id, 'code:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':code:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Code operation needs reconciliation' using errcode = '55000'; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_run.environment_id and owner = p_request ->> 'owner' and name = p_request ->> 'name' for update;
	if found then
		select * into v_change from public.qorpera_code_changes change
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.n = v_n;
	end if;
	if v_change.n is null then raise exception 'No such change' using errcode = 'P0002'; end if;
	select * into v_open from public.qorpera_code_requests request
	where request.environment_id = v_repository.environment_id and request.owner = v_repository.owner
		and request.name = v_repository.name and request.kind in ('undo','restore') and request.state in ('queued','running');
	v_reason := case
		when v_change.state = 'reverted' then null
		when v_change.state in ('conflict','refused') then 'never_landed'
		when v_change.state = 'lost' then 'lost'
		when v_change.kind = 'restore' then 'restore'
		-- A restore is a wall: undo does not reach across it. Neither does it reach before the record's first main.
		when v_change.main_before is null or (v_later and exists (select 1 from public.qorpera_code_changes change
			where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
				and change.name = v_repository.name and change.n > v_n and change.kind = 'restore')) then 'wall'
		when v_later and (select count(*) from (select 1 from public.qorpera_code_changes change
			where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
				and change.name = v_repository.name and change.n >= v_n and change.state = 'landed' limit 501) later) > 500
			then 'too_many'
		when v_open.id is not null and (v_open.kind <> 'undo' or v_open.input -> 'change' <> to_jsonb(v_n)
			or v_open.input -> 'andLater' <> to_jsonb(v_later)) then 'busy'
		when v_open.id is null and (select count(*) from public.qorpera_coding_executors executor
			where executor.environment_id = v_repository.environment_id and executor.enabled) <> 1 then 'no_executor' end;
	if v_change.state = 'reverted' then
		v_result := jsonb_build_object('schema', 'qorpera.code-request/v1', 'state', 'already', 'change', v_n,
			'undoneBy', v_change.reverted_by);
	elsif v_reason is not null then
		v_result := jsonb_build_object('schema', 'qorpera.code-request/v1', 'state', 'refused', 'reason', v_reason);
	else
		v_id := v_open.id;
		if v_id is null then
			insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id,
				by_agent_id, run_id)
			values (v_repository.environment_id, v_repository.owner, v_repository.name, v_repository.profile_id, 'undo',
				jsonb_build_object('change', v_n, 'andLater', v_later, 'reason', p_request ->> 'reason',
					'notice', p_request ->> 'notice'), 'agent', v_run.requested_by_user_id, v_run.staff_agent_id, v_run.id)
			returning id into v_id;
		end if;
		v_result := jsonb_build_object('schema', 'qorpera.code-request/v1', 'state', 'queued', 'requestId', v_id);
	end if;
	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;

-- How a request of the agent's company stands: its state, and once it ended its result, the number of the row it wrote,
-- its code, and the paths a refused undo named. A read, with no receipt; P0002 for another company's request or none.
create function public.qorpera_folder_code_request(p_binding jsonb, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_request public.qorpera_code_requests%rowtype;
begin
	v_run := public.qorpera_code_agent_run(p_binding);
	select * into v_request from public.qorpera_code_requests request
	where request.id = p_request_id and request.environment_id = v_run.environment_id;
	if not found then raise exception 'No such code request' using errcode = 'P0002'; end if;
	return jsonb_build_object('schema', 'qorpera.code-request/v1', 'requestId', v_request.id, 'kind', v_request.kind,
		-- A download that was made and has gone again was done.
		'state', case when v_request.state = 'expired' then 'done' else v_request.state end,
		'result', v_request.outcome -> 'result', 'change', v_request.outcome -> 'change', 'code', v_request.outcome -> 'code',
		'paths', case when v_request.state = 'refused' then v_request.outcome -> 'paths' end);
end $$;

-- An agent says what a customer will notice of a change, or gives a picture of it: a file in the company's shared part
-- of the folder, a .png, .jpg, .jpeg or .webp of at most 4 MiB. The row pins the file's hash; the file is not copied. A
-- null leaves that one as it is. Answers saved, or refused with what is wrong with the picture; P0002 when there is no
-- such repository or number.
create function public.qorpera_folder_describe_code_change(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_repository public.qorpera_code_repositories%rowtype;
	v_change public.qorpera_code_changes%rowtype; v_entry public.qorpera_folder_entries%rowtype;
	v_notice text := p_request ->> 'notice'; v_path text := p_request ->> 'picture'; v_reason text; v_picture jsonb;
begin
	-- Exactly its keys; a notice or a picture left out is a null, and one of the two is given.
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['operationKey','owner','name','change']
		or p_request - array['operationKey','owner','name','change','notice','picture'] <> '{}'::jsonb
		or not public.qorpera_code_json_text(p_request -> 'operationKey', '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$')
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or not (public.qorpera_code_json_count(p_request -> 'change') and p_request ->> 'change' ~ '^[1-9][0-9]{0,8}$')
		or (p_request ? 'notice' and jsonb_typeof(p_request -> 'notice') not in ('string','null'))
		or (p_request ? 'picture' and jsonb_typeof(p_request -> 'picture') not in ('string','null'))
		or (v_notice is null and v_path is null)
		or (v_notice is not null and not public.qorpera_code_notice_valid(v_notice))
		or (v_path is not null and (v_path = '' or octet_length(v_path) > 1024)) then
		raise exception 'Code request is invalid' using errcode = '22023'; end if;
	v_run := public.qorpera_code_agent_run(p_binding);
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('schema', 'qorpera.folder-code-describe/v1',
		'runId', v_run.id, 'request', p_request || jsonb_build_object('notice', v_notice, 'picture', v_path))::text, 'utf8'),
		'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(p_binding, v_receipt_id, 'code:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':code:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Code operation needs reconciliation' using errcode = '55000'; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_run.environment_id and owner = p_request ->> 'owner' and name = p_request ->> 'name' for update;
	if found then
		select * into v_change from public.qorpera_code_changes change
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.n = (p_request ->> 'change')::integer;
	end if;
	if v_change.n is null then raise exception 'No such change' using errcode = 'P0002'; end if;
	if v_path is not null then
		-- Whether every agent and member reads the path comes first: a path outside the shared part is told nothing else.
		if not public.qorpera_folder_path_every_agent(v_run.environment_id, v_path) then
			v_reason := 'not_shared';
		else
			select * into v_entry from public.qorpera_folder_entries entry
			where entry.environment_id = v_run.environment_id
				and entry.key_sha256 = extensions.digest(public.qorpera_folder_key(v_path), 'sha256') and entry.kind <> 'claim';
			v_reason := case when v_entry.kind is null then 'missing' when v_entry.kind <> 'file' then 'not_a_file'
				when lower(v_path) !~ '\.(png|jpg|jpeg|webp)$' then 'not_a_picture'
				when v_entry.bytes > 4194304 then 'too_large' end;
		end if;
		v_picture := jsonb_build_object('source', 'folder', 'path', v_path, 'sha256', v_entry.file_sha256,
			'bytes', v_entry.bytes);
	end if;
	if v_reason is not null then
		v_result := jsonb_build_object('schema', 'qorpera.code-change-described/v1', 'state', 'refused', 'reason', v_reason);
	else
		update public.qorpera_code_changes change set notice = coalesce(v_notice, change.notice),
			picture = coalesce(v_picture, change.picture),
			picture_problem = case when v_picture is null then change.picture_problem end,
			file_version = change.file_version + 1
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.n = v_change.n
		returning * into v_change;
		update public.qorpera_code_repositories set index_version = index_version + 1
		where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
		v_result := jsonb_build_object('schema', 'qorpera.code-change-described/v1', 'state', 'saved', 'change', v_change.n,
			'notice', v_change.notice, 'picture', v_change.picture);
	end if;
	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;

-- 9. The member's calls -------------------------------------------------------------------------------------------------

-- How a download stands for the member who waits for it: queued, running, ready with its file, or failed with why (the
-- code is too large, it was put off behind coding turns every time, or anything else).
create function public.qorpera_code_download_view(p_request public.qorpera_code_requests, p_now timestamptz)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', p_request.id,
		'file', p_request.input ->> 'file',
		'state', case when p_request.state in ('queued','running') then p_request.state
			when p_request.state = 'done' and p_request.expires_at > p_now then 'ready' else 'failed' end,
		'reason', case when p_request.state in ('queued','running') or (p_request.state = 'done' and p_request.expires_at > p_now)
				then null
			when p_request.state = 'refused' and p_request.outcome ->> 'code' = 'CODE_HOST_DOWNLOAD_TOO_LARGE' then 'too_large'
			when p_request.state = 'failed' and p_request.progress -> 'busy' = 'true'::jsonb then 'busy' else 'failed' end,
		'path', case when p_request.state = 'done' and p_request.expires_at > p_now then p_request.outcome -> 'path' end,
		'bytes', case when p_request.state = 'done' and p_request.expires_at > p_now then p_request.outcome -> 'bytes' end)
$$;

-- The company's repositories kept in Qorpera, for any member (viewers too): each with how many changes its record
-- holds, and its downloads that are open or ready. canDownload says whether this member may ask for one.
create function public.qorpera_list_code_repositories(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null then
		raise exception 'Code unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.code-repositories/v1', 'canDownload', v_role in ('owner','admin'),
		'repositories', coalesce((select jsonb_agg(jsonb_build_object('owner', repository.owner, 'name', repository.name,
				'changes', repository.last_change,
				'downloads', coalesce((select jsonb_agg(jsonb_build_object('requestId', request.id,
						'file', request.input ->> 'file',
						'state', case when request.state = 'done' then 'ready' else request.state end,
						'path', request.outcome -> 'path', 'bytes', request.outcome -> 'bytes',
						'madeAt', case when request.state = 'done' then request.finished_at end,
						'expiresAt', request.expires_at) order by request.created_at, request.id)
					-- A download is made within hours and lasts 7 days: older requests are over.
					from public.qorpera_code_requests request
					where request.environment_id = repository.environment_id and request.owner = repository.owner
						and request.name = repository.name and request.created_at > v_now - interval '9 days'
						and request.kind = 'download' and (request.state in ('queued','running')
							or (request.state = 'done' and request.expires_at > v_now))), '[]'::jsonb))
				order by repository.owner collate "C", repository.name collate "C")
			from public.qorpera_code_repositories repository
			join public.qorpera_company_files file on file.environment_id = repository.environment_id
				and file.profile_id = p_profile_id and file.core = 'folder-v2'
			where repository.profile_id = p_profile_id), '[]'::jsonb));
end $$;

-- An owner or admin asks for the company's code: `files` (main's files as a .zip) or `history` (main with its history
-- as a git bundle, for a developer). Answers, in this order: the made download of that file when main has not moved
-- since (ready; a made download is over as soon as a job is let go that displaces its file, a newer download of that
-- file or a restore's job that sets the place aside, so the one found here still has its file); the open request of
-- that file; refused after 20 download requests of the company in 24 hours
-- (too_many) or when no executor holds the company (no_executor); else a new request (queued). P0002 when the company
-- has no such repository.
create function public.qorpera_request_code_download(p_profile_id uuid, p_owner text, p_name text, p_file text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_now timestamptz := clock_timestamp(); v_repository public.qorpera_code_repositories%rowtype;
	v_request public.qorpera_code_requests%rowtype; v_reason text;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null
		or v_role not in ('owner','admin') then
		raise exception 'Code unavailable' using errcode = '42501'; end if;
	if p_owner is null or p_name is null or p_file is null or p_file not in ('files','history') then
		raise exception 'Code download request is invalid' using errcode = '22023'; end if;
	-- The company's profile row first: the request's row checks its key.
	perform 1 from public.qorpera_profiles profile where profile.id = p_profile_id for key share;
	select repository.* into v_repository from public.qorpera_code_repositories repository
	join public.qorpera_company_files file on file.environment_id = repository.environment_id
		and file.profile_id = p_profile_id and file.core = 'folder-v2'
	where repository.profile_id = p_profile_id and repository.owner = p_owner and repository.name = p_name
	for update of repository;
	if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
	-- The file that is there, when main is where it was made.
	select * into v_request from public.qorpera_code_requests request
	where request.environment_id = v_repository.environment_id and request.owner = p_owner and request.name = p_name
		and request.created_at > v_now - interval '9 days' and request.kind = 'download' and request.input ->> 'file' = p_file
		and request.state = 'done' and request.expires_at > v_now and request.outcome ->> 'mainSha' = v_repository.last_main
	order by request.created_at desc limit 1;
	if found then return public.qorpera_code_download_view(v_request, v_now); end if;
	select * into v_request from public.qorpera_code_requests request
	where request.environment_id = v_repository.environment_id and request.owner = p_owner and request.name = p_name
		and request.kind = 'download' and request.input ->> 'file' = p_file and request.state in ('queued','running');
	if found then return public.qorpera_code_download_view(v_request, v_now); end if;
	v_reason := case when (select count(*) from public.qorpera_code_requests request
			where request.profile_id = p_profile_id and request.created_at > v_now - interval '24 hours'
				and request.kind = 'download') >= 20 then 'too_many'
		when (select count(*) from public.qorpera_coding_executors executor
			where executor.environment_id = v_repository.environment_id and executor.enabled) <> 1 then 'no_executor' end;
	if v_reason is not null then
		return jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', null, 'file', p_file,
			'state', 'refused', 'reason', v_reason, 'path', null, 'bytes', null);
	end if;
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id)
	values (v_repository.environment_id, p_owner, p_name, p_profile_id, 'download', jsonb_build_object('file', p_file,
		'fileName', p_name || '-' || to_char(v_now at time zone 'UTC', 'YYYY-MM-DD')
			|| case p_file when 'files' then '.zip' else '.bundle' end), 'member', auth.uid())
	returning * into v_request;
	return public.qorpera_code_download_view(v_request, v_now);
end $$;

-- How a download an owner or admin asked for stands. Read-only; P0002 for another company's request, or none.
create function public.qorpera_code_download(p_profile_id uuid, p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_request public.qorpera_code_requests%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null
		or v_role not in ('owner','admin') then
		raise exception 'Code unavailable' using errcode = '42501'; end if;
	select * into v_request from public.qorpera_code_requests request
	where request.id = p_request_id and request.profile_id = p_profile_id and request.kind = 'download';
	if not found then raise exception 'No such download' using errcode = 'P0002'; end if;
	return public.qorpera_code_download_view(v_request, clock_timestamp());
end $$;

-- 10. The operator's call -----------------------------------------------------------------------------------------------

-- An operator asks for a restore, as the database owner (no API role may call this): `verify` proves a stored bundle
-- restores and writes nothing; `restore` puts the repository back from a stored bundle, or from `fresh`, a new bundle of
-- the place as it stands, and keeps or removes the place it replaces (p_damaged); `discard` removes one set-aside copy,
-- whose path p_note gives. Answers the request's id; the operator reads the row for its state and outcome.
-- A restore of a place whose last restore ended failed with the kernel's word that it held the place still standing
-- begins with that word: the place may still be closed, and must not wait for the company's other work. Its executor
-- reads the place first, and says `reopened` when it finds it open.
create function public.qorpera_request_code_restore(p_environment_id uuid, p_owner text, p_name text, p_mode text,
	p_bundle text, p_damaged text, p_note text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_id uuid;
begin
	if p_environment_id is null or p_owner is null or p_name is null
		or coalesce(p_mode, '') not in ('verify','restore','discard')
		or (p_mode = 'verify' and coalesce(p_bundle, '') !~ '^\d{8}T\d{6}Z-[0-9a-f]{12}$')
		or (p_mode = 'restore' and coalesce(p_bundle, '') !~ '^(\d{8}T\d{6}Z-[0-9a-f]{12}|fresh)$')
		or (p_mode = 'restore' and coalesce(p_damaged, '') not in ('keep','remove'))
		or (p_mode <> 'restore' and p_damaged is not null and p_damaged not in ('keep','remove'))
		or (p_mode = 'discard' and (p_bundle is not null or coalesce(p_note, '') !~ ('^code/_set-aside/[a-z0-9-]{1,39}/at-'
			|| '[0-9TZ-]{1,40}/[a-z0-9_.-]{1,100}$') or split_part(p_note, '/', 3) <> p_owner
			or split_part(p_note, '/', 5) <> p_name))
		or octet_length(coalesce(p_note, '')) > 1000 then
		raise exception 'Code restore request is invalid' using errcode = '22023'; end if;
	-- The company's profile row first: the request's row checks its key.
	perform 1 from public.qorpera_profiles profile where profile.id = (select repository.profile_id
		from public.qorpera_code_repositories repository
		where repository.environment_id = p_environment_id and repository.owner = p_owner and repository.name = p_name)
	for key share;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_owner and name = p_name for update;
	if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
	if exists (select 1 from public.qorpera_code_requests request
		where request.environment_id = p_environment_id and request.owner = p_owner and request.name = p_name
			and request.kind in ('undo','restore') and request.state in ('queued','running')) then
		raise exception 'An undo or a restore is already asked for in this repository' using errcode = '55000'; end if;
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind, progress)
	values (p_environment_id, p_owner, p_name, v_repository.profile_id, 'restore', jsonb_build_object('mode', p_mode,
		'bundle', p_bundle, 'damaged', coalesce(p_damaged, 'keep'),
		'note', case when p_mode = 'discard' then null else p_note end,
		'path', case when p_mode = 'discard' then p_note end), 'operator',
		case when p_mode = 'restore' and (select last.state = 'failed' and public.qorpera_code_restore_holds(last.progress)
			from public.qorpera_code_requests last
			where last.environment_id = p_environment_id and last.owner = p_owner and last.name = p_name
				and last.kind = 'restore' and last.input ->> 'mode' = 'restore'
			order by last.created_at desc, last.id desc limit 1) then '{"held":true}'::jsonb end)
	returning id into v_id;
	return v_id;
end $$;

-- 11. The landings that exist --------------------------------------------------------------------------------------------

-- Each landing a worker reported that is no row yet, as a row; answers how many it added. For each registered
-- repository, in time order: its sessions' `reported` events with a landing (fast-forward or merged) newer than the
-- repository's last row. Main before is the row before it, and for the first row the session's base. The words are the
-- worker's title and the reported summary up to the platform's own line. The files are counted when the row's file is
-- written. A landing whose turn has a row adds nothing, so it can be run again.
create function public.qorpera_code_changes_backfill()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_event record; v_main text; v_last timestamptz;
	v_summary text; v_cut integer; v_count integer := 0; c_line constant text := E'\n\nQorpera landed this commit on ';
begin
	for v_repository in select * from public.qorpera_code_repositories
		order by environment_id, owner collate "C", name collate "C" for update
	loop
		v_main := v_repository.last_main;
		select change.created_at into v_last from public.qorpera_code_changes change
		where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
			and change.name = v_repository.name and change.n = v_repository.last_change;
		for v_event in select event.worker_id, event.sequence, event.created_at, event.body, worker.title,
				worker.staff_agent_id, worker.owner_user_id, session.base_sha
			from public.qorpera_coding_sessions session
			join public.qorpera_runtime_workers worker on worker.id = session.worker_id
			join public.qorpera_runtime_worker_events event on event.worker_id = session.worker_id and event.kind = 'reported'
			where session.environment_id = v_repository.environment_id and session.repository ->> 'host' = 'qorpera'
				and session.repository ->> 'owner' = v_repository.owner and session.repository ->> 'name' = v_repository.name
				and event.body -> 'landed' ->> 'state' in ('fast-forward','merged')
				and (v_last is null or event.created_at > v_last)
				and not exists (select 1 from public.qorpera_code_changes change
					where change.worker_id = event.worker_id and change.sequence = event.sequence)
			order by event.created_at, event.id
		loop
			v_summary := v_event.body ->> 'summary';
			v_cut := strpos(reverse(v_summary), reverse(c_line));
			if v_cut > 0 then v_summary := left(v_summary, length(v_summary) - v_cut - length(c_line) + 1); end if;
			perform public.qorpera_code_change_append(v_repository.environment_id, v_repository.owner, v_repository.name,
				jsonb_build_object('kind', 'landing', 'state', 'landed', 'how', v_event.body -> 'landed' ->> 'state',
					'main_before', coalesce(v_main, v_event.base_sha), 'main_after', v_event.body -> 'landed' ->> 'mainSha',
					'head_sha', v_event.body -> 'landed' ->> 'headSha', 'worker_id', v_event.worker_id,
					'sequence', v_event.sequence, 'staff_agent_id', v_event.staff_agent_id,
					'owner_user_id', v_event.owner_user_id, 'title', v_event.title, 'summary', nullif(v_summary, ''),
					'created_at', v_event.created_at));
			v_main := v_event.body -> 'landed' ->> 'mainSha';
			v_count := v_count + 1;
		end loop;
	end loop;
	return v_count;
end $$;

-- 12. Five existing functions ---------------------------------------------------------------------------------------------

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.code_record_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930720000' in v_definition) > 0 then
		raise exception '20260930720000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930720000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- The change record, the downloads, a restore's mark and what a restore set aside are the platform's.
select pg_temp.code_record_patch('public.qorpera_folder_git_refusal(text,text,text,uuid)'::regprocedure, array[
	$old$	if p_class = 'platform' or v_part[1] is distinct from 'code' or v_n < 4 then return null; end if;
	if v_part[4] = 'main' then return 'git_platform_only'; end if;$old$,
	$new$	if p_class = 'platform' or v_part[1] is distinct from 'code' then return null; end if;
	-- 20260930720000: what a restore set aside is the platform's alone.
	if v_n >= 2 and v_part[2] = '_set-aside' then return 'git_platform_only'; end if;
	if v_n < 4 then return null; end if;
	-- 20260930720000: a repository's change record, its downloads and a restore's mark are the platform's, as main/ is.
	if v_part[4] in ('main','changes','downloads','restoring.json') then return 'git_platform_only'; end if;$new$]);

-- In a repository kept in Qorpera, a member writes no ref: only the platform moves main.
select pg_temp.code_record_patch('public.qorpera_folder_git_unit_refusal(uuid,jsonb,text,text,text,uuid)'::regprocedure, array[
	$old$	select k.reason from (
		select p_key as key,$old$,
	$new$	-- 20260930720000: where the repository is kept in Qorpera, a member (a restore of an old version) writes and removes
	-- no ref, and neither of the two files that would move main for every reader: only the platform moves main. The
	-- repository is the kernel's own record of one there (qorpera_code_repositories), or its mark's file, as
	-- 20260930707000 tells the two kinds apart. A copy of a GitHub repository is as it was.
	select k.reason from (select m.key, coalesce(m.reason, case when p_class = 'member'
			and m.key ~ '^code/[^/]+/[^/]+/repo\.git/(refs(/.*)?|packed-refs|shallow)$'
			and (exists (select 1 from public.qorpera_code_repositories kept where kept.environment_id = p_environment_id
					and kept.owner = split_part(m.key, '/', 2) and kept.name = split_part(m.key, '/', 3))
				or public.qorpera_folder_git_version(p_environment_id,
					substring(m.key from '^code/[^/]+/[^/]+/repo\.git/') || 'refs/qorpera/kept-here') is not null)
			then 'git_platform_only' end) as reason from (
		select p_key as key,$new$,
	$old$	) k
	where k.reason is not null$old$,
	$new$	) m) k
	where k.reason is not null$new$]);

-- A finish may say what a customer will notice, and name a screenshot the session committed.
select pg_temp.code_record_patch('public.qorpera_submit_coding_turn(jsonb,jsonb)'::regprocedure, array[
	$old$		or (v_kind = 'finish' and (p_submission - array['kind','operationKey','summary','headSha'] <> '{}'::jsonb
			or coalesce(p_submission ->> 'headSha','') !~ '^[0-9a-f]{40}$'))$old$,
	$new$		-- 20260930720000: a finish may carry notice (one line, 1 to 200 characters) and picture (the path of a .png,
		-- .jpg, .jpeg or .webp file in the repository, at most 300 bytes, with no part that is . or ..).
		or (v_kind = 'finish' and (p_submission - array['kind','operationKey','summary','headSha','notice','picture'] <> '{}'::jsonb
			or coalesce(p_submission ->> 'headSha','') !~ '^[0-9a-f]{40}$'
			or (p_submission ? 'notice' and (jsonb_typeof(p_submission -> 'notice') <> 'string'
				or char_length(p_submission ->> 'notice') not between 1 and 200 or p_submission ->> 'notice' ~ '[\n\r\t]'))
			or (p_submission ? 'picture' and (jsonb_typeof(p_submission -> 'picture') <> 'string'
				or octet_length(p_submission ->> 'picture') > 300
				or p_submission ->> 'picture' !~ '^[A-Za-z0-9._-][A-Za-z0-9._ -]*(/[A-Za-z0-9._-][A-Za-z0-9._ -]*)*\.(png|jpg|jpeg|webp|PNG|JPG|JPEG|WEBP)$'
				or exists (select 1 from unnest(string_to_array(p_submission ->> 'picture', '/')) part where part in ('.','..'))))))$new$,
	$old$		'options',coalesce(p_submission -> 'options','[]'::jsonb),'operationKey',p_submission ->> 'operationKey');$old$,
	$new$		'options',coalesce(p_submission -> 'options','[]'::jsonb),'operationKey',p_submission ->> 'operationKey')
		-- A submission without the two is stored as it always was.
		|| jsonb_strip_nulls(jsonb_build_object('notice', p_submission ->> 'notice', 'picture', p_submission ->> 'picture'));$new$]);

-- The platform's line on a landing names the change and its record, when the turn has a row.
select pg_temp.code_record_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure, array[
	$old$			|| ', and the files are in the company folder at code/' || (v_session.repository ->> 'owner') || '/'
			|| (v_session.repository ->> 'name') || '/main/.';$old$,
	$new$			|| ', and the files are in the company folder at code/' || (v_session.repository ->> 'owner') || '/'
			|| (v_session.repository ->> 'name') || '/main/.'
			-- 20260930720000: the change's number and where its record is, when the landing was recorded.
			|| coalesce((select ' It is change ' || change.n || ' of this repository; its record is code/' || change.owner
					|| '/' || change.name || '/changes/' || change.n || '.md.'
				from public.qorpera_code_changes change
				where change.worker_id = v_worker.id and change.sequence = v_worker.sequence and change.state = 'landed'), '');$new$]);

-- The operations a run's observations may name, after machine_screen (20260930708000).
select pg_temp.code_record_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure, array[
	$old$/* 20260930708000 */'machine_screen',$old$,
	$new$/* 20260930708000 */'machine_screen',/* 20260930720000 */'manage_code',$new$]);

-- 13. Grants, the native host's list, and the landings that exist ------------------------------------------------------

revoke all on function public.qorpera_code_executor_custody(text, text),
	public.qorpera_code_json_text(jsonb, text),
	public.qorpera_code_json_count(jsonb),
	public.qorpera_code_json_strings(jsonb, integer),
	public.qorpera_code_notice_valid(text),
	public.qorpera_code_change_paths_valid(jsonb),
	public.qorpera_code_change_fit(jsonb, integer, integer),
	public.qorpera_code_change_append(uuid, text, text, jsonb),
	public.qorpera_code_change_found(uuid, text, text, text, text),
	public.qorpera_code_change_set(uuid, text, text, integer, boolean, integer),
	public.qorpera_code_changes_restored(uuid, text, text, text),
	public.qorpera_code_undo_message(integer, text, boolean),
	public.qorpera_code_request_lease(text),
	public.qorpera_code_restore_waits(uuid, text, text, timestamptz),
	public.qorpera_code_restore_holds(jsonb),
	public.qorpera_code_change_report_valid(jsonb),
	public.qorpera_code_change_files_written_valid(jsonb),
	public.qorpera_code_request_outcome_valid(text, jsonb),
	public.qorpera_code_agent_run(jsonb),
	public.qorpera_code_download_view(public.qorpera_code_requests, timestamptz),
	public.qorpera_request_code_restore(uuid, text, text, text, text, text, text),
	public.qorpera_code_changes_backfill()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_record_code_change(uuid, uuid, jsonb),
	public.qorpera_code_change_files_due(text, text, integer),
	public.qorpera_code_change_files(text, text, uuid, text, text, integer),
	public.qorpera_code_change_files_written(text, text, uuid, text, text, jsonb),
	public.qorpera_code_requests_claim(text, text, integer),
	public.qorpera_code_request_step(text, text, uuid, uuid, jsonb),
	public.qorpera_code_restore_record(text, text, uuid, uuid, jsonb),
	public.qorpera_code_request_finish(text, text, uuid, uuid, jsonb),
	public.qorpera_folder_request_code_undo(jsonb, jsonb),
	public.qorpera_folder_code_request(jsonb, uuid),
	public.qorpera_folder_describe_code_change(jsonb, jsonb),
	public.qorpera_list_code_repositories(uuid),
	public.qorpera_request_code_download(uuid, text, text, text),
	public.qorpera_code_download(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_code_change(uuid, uuid, jsonb),
	public.qorpera_code_change_files_due(text, text, integer),
	public.qorpera_code_change_files(text, text, uuid, text, text, integer),
	public.qorpera_code_change_files_written(text, text, uuid, text, text, jsonb),
	public.qorpera_code_requests_claim(text, text, integer),
	public.qorpera_code_request_step(text, text, uuid, uuid, jsonb),
	public.qorpera_code_restore_record(text, text, uuid, uuid, jsonb),
	public.qorpera_code_request_finish(text, text, uuid, uuid, jsonb),
	public.qorpera_folder_request_code_undo(jsonb, jsonb),
	public.qorpera_folder_code_request(jsonb, uuid),
	public.qorpera_folder_describe_code_change(jsonb, jsonb)
	to service_role;
grant execute on function public.qorpera_list_code_repositories(uuid),
	public.qorpera_request_code_download(uuid, text, text, text),
	public.qorpera_code_download(uuid, uuid)
	to authenticated;
comment on function public.qorpera_list_code_repositories(uuid) is
	'The company''s repositories kept in Qorpera, for any member: each with its number of changes and its downloads that '
	'are open or ready; canDownload says whether the caller (owner or admin) may ask for one (20260930720000).';
comment on function public.qorpera_request_code_download(uuid, text, text, text) is
	'An owner or admin asks for the code of a repository kept in Qorpera as a file in its downloads folder: main''s files '
	'(.zip) or main with its history (.bundle). The coding executor makes it; it lasts 7 days (20260930720000).';
comment on function public.qorpera_code_download(uuid, uuid) is
	'How a download an owner or admin asked for stands: queued, running, ready with its path, or failed with why '
	'(20260930720000).';

-- The native host may call the agent's three (G2), with the binding's scope.
insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_request_code_undo', 'binding'), ('qorpera_folder_code_request', 'binding'),
	('qorpera_folder_describe_code_change', 'binding');

-- The deploy guard: every changed body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_folder_git_refusal(text,text,text,uuid)',
		'public.qorpera_folder_git_unit_refusal(uuid,jsonb,text,text,text,uuid)',
		'public.qorpera_submit_coding_turn(jsonb,jsonb)',
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_record_runtime_observation(uuid,jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930720000') = 0 then
			raise exception '20260930720000 is missing from %', v_function; end if;
	end loop;
end $guard$;

-- The landings that exist become rows, each from its worker's report.
select public.qorpera_code_changes_backfill();
