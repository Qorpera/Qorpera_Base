-- Run logs W1b, part 1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §7, §8): the log files and their index.
--
-- 1. Three structured kinds under a tree root's runs/<run>/: run.toml ('memory-run'), log/<8 digits>.jsonl
--    ('memory-steps', 16 steps a block) and t<tier>/<8 digits>.jsonl ('memory-run-block', the run's tree of step lines).
-- 2. The index: qorpera_memory_run_logs (one row per run.toml), qorpera_memory_run_steps (one row per step line, with
--    the company paths it names for erasure) and the run's tree lines in M1a's qorpera_memory_tree_nodes.
-- 3. qorpera_memory_run_generations: a run's memory generation and its open erase. A log batch names its run
--    (preconditions.runLog) and a tree batch the run's generation (preconditions.runGenerations). The memory commit
--    locks the rows before the receipts' rank 10: FOR NO KEY UPDATE for a log's first batch, FOR SHARE for the others;
--    an erase takes FOR UPDATE.
-- 4. Where a run's log goes: qorpera_memory_run_origin (its conversation, parent step, the run it continues and whether
--    it is narrow) and qorpera_memory_run_log_place.
-- 5. The refusals: a memory commit with runLog writes only that run's log folder; one without writes no runs/ path. A run
--    writes only its own log, as itself, without the folder's grants (§4.3); only the platform deletes. Steps are
--    append-only: a finished line never changes, a pending one only to its finished form, and a narrow log takes only
--    narrow lines.
-- 6. Native host calls: qorpera_memory_step_hashes and qorpera_memory_step_narrow ('lease'), qorpera_memory_run_log_place
--    ('run') and qorpera_folder_memory_commit ('folder'; a run actor writes only its own run's log and names no other
--    run in its request, which the memory commit refuses before it takes any lock).
-- Every new or patched body carries the marker 20260930231000 for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regclass('public.qorpera_memory_run_logs') is not null then
		raise exception 'W1b (20260930231000) is already applied'; end if;
	if to_regclass('public.qorpera_memory_trees') is null then
		raise exception 'W1b (20260930231000) needs M1a (20260928509140, 20260928509150)'; end if;
	if to_regclass('public.qorpera_runtime_worker_parents') is null then
		raise exception 'W1b (20260930231000) needs W4a-1 (20260928519130)'; end if;
end $$;

-- 1. The index ------------------------------------------------------------------------------------------------------

create table public.qorpera_memory_run_logs (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- The run (qorpera_execution_runs.id). No foreign key: its KEY SHARE would come in apply, after the paths.
	run_id uuid not null,
	-- The conversation the run served.
	session_id uuid not null,
	-- The step of the run that started this one (a worker's dispatch), and the run this one goes on from.
	parent_run_id uuid,
	parent_step integer check (parent_step >= 0),
	continues_run_id uuid,
	-- The whole log is narrow (§4.5), or it is from step narrow_from on.
	narrow boolean not null default false,
	narrow_from integer check (narrow_from >= 0),
	step_count integer not null default 0 check (step_count >= 0),
	run_path text collate "C" not null,
	run_key text collate "C" not null,
	toml_path_version uuid not null,
	commit_id uuid not null,
	retired_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, run_id),
	check ((parent_run_id is null) = (parent_step is null))
);
create unique index qorpera_memory_run_logs_key on public.qorpera_memory_run_logs(environment_id, run_key) where retired_at is null;
create index qorpera_memory_run_logs_parent on public.qorpera_memory_run_logs(environment_id, parent_run_id, parent_step)
	where parent_run_id is not null;
create index qorpera_memory_run_logs_continues on public.qorpera_memory_run_logs(environment_id, continues_run_id)
	where continues_run_id is not null;
create index qorpera_memory_run_logs_run on public.qorpera_memory_run_logs(run_id);
create index qorpera_memory_run_logs_commit on public.qorpera_memory_run_logs(commit_id);
alter table public.qorpera_memory_run_logs enable row level security;
revoke all on public.qorpera_memory_run_logs from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_run_logs to service_role;
comment on table public.qorpera_memory_run_logs is
	'Run logs (RUNTIME-AGENT-MEMORY-TREE.md §4.5): one row per runs/<run>/run.toml, an index of the company folder. A '
	'deleted log retires its row; erasure deletes retired rows.';

create table public.qorpera_memory_run_steps (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	run_id uuid not null,
	j integer not null check (j >= 0),
	tool text not null,
	call_id text not null,
	args_hash text check (args_hash ~ '^[0-9a-f]{64}$'),
	releases uuid[] not null default '{}',
	-- The folder keys a step names (its paths, and those in its result, arguments, output and reads) with their
	-- ancestors: an erased path finds its steps.
	needles text[] not null default '{}',
	narrow boolean not null,
	erased boolean not null,
	finished boolean not null,
	line_sha256 text not null check (line_sha256 ~ '^[0-9a-f]{64}$'),
	-- The parts a pending line keeps when it is finished: j, tool, call, args_hash and at.
	fixed_sha256 text not null check (fixed_sha256 ~ '^[0-9a-f]{64}$'),
	block_path text collate "C" not null,
	block_key text collate "C" not null,
	block_path_version uuid not null,
	commit_id uuid not null,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, run_id, j)
);
create index qorpera_memory_run_steps_block on public.qorpera_memory_run_steps(environment_id, block_key);
create index qorpera_memory_run_steps_commit on public.qorpera_memory_run_steps(commit_id);
create index qorpera_memory_run_steps_needles on public.qorpera_memory_run_steps using gin (needles);
alter table public.qorpera_memory_run_steps enable row level security;
revoke all on public.qorpera_memory_run_steps from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_run_steps to service_role;
comment on table public.qorpera_memory_run_steps is
	'Run logs (RUNTIME-AGENT-MEMORY-TREE.md §4.5, §8): one row per step line of a log block, an index of the company '
	'folder. needles holds the folder keys the step names, with their ancestors.';

create table public.qorpera_memory_run_generations (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	run_id uuid not null,
	memory_generation bigint not null default 0 check (memory_generation >= 0),
	-- An erase at work on the run's log: its batches are refused until it ends (W5).
	erase_open uuid,
	-- Set by the log's first batch; a later first batch is refused as gone.
	log_created_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, run_id)
);
alter table public.qorpera_memory_run_generations enable row level security;
revoke all on public.qorpera_memory_run_generations from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_run_generations to service_role;
comment on table public.qorpera_memory_run_generations is
	'Run logs (RUNTIME-AGENT-MEMORY-TREE.md §4.5, §8): a run''s memory generation, its open erase and when its log was '
	'made. A batch takes the row FOR SHARE (a log''s first batch FOR NO KEY UPDATE); an erase FOR UPDATE.';

create table public.qorpera_memory_step_hash_keys (
	environment_id uuid primary key references public.qorpera_folder_clocks(environment_id) on delete cascade,
	key bytea not null default extensions.gen_random_bytes(32),
	created_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_memory_step_hash_keys enable row level security;
revoke all on public.qorpera_memory_step_hash_keys from public, anon, authenticated, service_role;
comment on table public.qorpera_memory_step_hash_keys is
	'Run logs (RUNTIME-AGENT-MEMORY-TREE.md §4.5): the key a company''s narrow steps hash their results with. Read only '
	'by qorpera_memory_step_hashes.';

-- 2. Helpers ----------------------------------------------------------------------------------------------------------

-- The run log folder at or above a key, <root>/runs/<run>; else null.
create function public.qorpera_memory_run_folder_key(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930231000 (W1b)
	select r.root || substring(substr(p_key, char_length(r.root) + 1)
		from '^(/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(/|$)')
	from (select public.qorpera_memory_tree_root_key(p_key) as root) r
$$;
revoke all on function public.qorpera_memory_run_folder_key(text) from public, anon, authenticated, service_role;

-- run.toml, exactly: format = 1, run, conversation, then parent and step together, continues, narrow = true, one per
-- line, each only when it has a value. Null otherwise.
create function public.qorpera_memory_run_toml(p_text text)
returns jsonb language sql immutable set search_path = '' as $$
	-- 20260930231000 (W1b)
	select case when x.m is not null then jsonb_build_object('run', x.m[1], 'conversation', x.m[2], 'parent', x.m[4],
		'step', x.m[5]::integer, 'continues', x.m[7], 'narrow', x.m[8] is not null) end
	from (select regexp_match(p_text, '^format = 1\nrun = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\n'
		'conversation = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\n'
		'(parent = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\nstep = (0|[1-9][0-9]{0,8})\n)?'
		'(continues = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\n)?(narrow = true\n)?$') as m) x
$$;
revoke all on function public.qorpera_memory_run_toml(text) from public, anon, authenticated, service_role;

-- One line of a run's tree (§7.5), or null: M1a's block line without seq and hash, at every level.
create function public.qorpera_memory_run_block_line(p_line text)
returns jsonb language plpgsql immutable set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_json json; v_line jsonb; v_l integer; v_text text;
begin
	begin
		v_json := p_line::json;
		v_line := p_line::jsonb;
	exception when data_exception then return null; end;
	if json_typeof(v_json) is distinct from 'object' then return null; end if;
	-- json keeps a duplicate key, jsonb only the last.
	if (select count(*) from json_object_keys(v_json)) <> (select count(*) from jsonb_object_keys(v_line)) then return null; end if;
	v_l := case when jsonb_typeof(v_line -> 'l') = 'number' and (v_line -> 'l')::text ~ '^(0|[1-9][0-9]?)$'
		then (v_line ->> 'l')::integer end;
	if v_l is null or v_l > 59 then return null; end if;
	if (select array_agg(k order by k) from jsonb_object_keys(v_line) k) is distinct from (select array_agg(k order by k)
		from unnest(array['l','k','free','text']
			|| case when v_line -> 'free' = 'false'::jsonb then array['tries'] else '{}'::text[] end) k) then
		return null; end if;
	if jsonb_typeof(v_line -> 'k') is distinct from 'number' or (v_line -> 'k')::text !~ '^(0|[1-9][0-9]{0,18})$'
		or jsonb_typeof(v_line -> 'free') is distinct from 'boolean' or jsonb_typeof(v_line -> 'text') is distinct from 'string' then
		return null; end if;
	if (v_line ->> 'k')::numeric > 9223372036854775807 then return null; end if;
	if v_line ? 'tries' and (jsonb_typeof(v_line -> 'tries') is distinct from 'number' or (v_line -> 'tries')::text !~ '^[1-3]$') then
		return null; end if;
	v_text := v_line ->> 'text';
	if v_text ~ '[\x01-\x1f\x7f-\x9f]' then return null; end if;
	if octet_length(v_text) + char_length(v_text) - char_length(replace(replace(v_text, '"', ''), '\', '')) > 2048 then
		return null; end if;
	return v_line;
end $$;
revoke all on function public.qorpera_memory_run_block_line(text) from public, anon, authenticated, service_role;

-- A block of a run's tree, M1a's rules: 1 to 30 lines, each at most 2,113 bytes, 65,004 in all, by level then number,
-- each in its block.
create function public.qorpera_memory_run_block_parse(p_key text, p_text text)
returns jsonb language plpgsql immutable set search_path = '' as $$
-- 20260930231000 (W1b)
declare
	v_m text[] := regexp_match(p_key, '/t([0-9]|1[0-4])/([0-9]{8})\.jsonl$'); v_t integer; v_b bigint; v_lines text[];
	v_line text; v_parsed jsonb; v_out jsonb := '[]'::jsonb; v_no integer := 0; v_l integer; v_k bigint;
	v_prev_l integer := -1; v_prev_k bigint := -1;
begin
	if v_m is null then
		return jsonb_build_object('problem', 'a block''s name is t<tier>/<8 digits>.jsonl', 'line', null); end if;
	v_t := v_m[1]::integer; v_b := v_m[2]::bigint;
	if p_text is null or octet_length(p_text) > 65004 or right(p_text, 1) is distinct from E'\n' then
		return jsonb_build_object('problem', 'a block is 1 to 30 lines, each ending in a newline, at most 65,004 bytes',
			'line', null); end if;
	v_lines := string_to_array(left(p_text, -1), E'\n');
	if coalesce(cardinality(v_lines), 0) not between 1 and 30 then
		return jsonb_build_object('problem', 'a block is 1 to 30 lines, each ending in a newline, at most 65,004 bytes',
			'line', null); end if;
	foreach v_line in array v_lines loop
		v_no := v_no + 1;
		-- Sized before it is parsed: the parser never sees a long line.
		if octet_length(v_line) > 2113 then
			return jsonb_build_object('problem', 'this line is longer than a summary line can be', 'line', v_no); end if;
		v_parsed := public.qorpera_memory_run_block_line(v_line);
		if v_parsed is null then
			return jsonb_build_object('problem', 'this line is not a summary line', 'line', v_no); end if;
		v_l := (v_parsed ->> 'l')::integer; v_k := (v_parsed ->> 'k')::bigint;
		if v_l < 4 * v_t or v_l > 4 * v_t + 3 or (v_k >> (4 * v_t + 4 - v_l)) <> v_b then
			return jsonb_build_object('problem', 'this line does not belong in this block', 'line', v_no); end if;
		if v_l < v_prev_l or (v_l = v_prev_l and v_k <= v_prev_k) then
			return jsonb_build_object('problem', 'the lines go by level, then by number, each once', 'line', v_no); end if;
		v_prev_l := v_l; v_prev_k := v_k;
		v_out := v_out || jsonb_build_array(v_parsed);
	end loop;
	return jsonb_build_object('lines', v_out);
end $$;
revoke all on function public.qorpera_memory_run_block_parse(text, text) from public, anon, authenticated, service_role;

-- One step line of a log block (§4.5), or null: at most 50,175 bytes (49 KiB with its newline), a JSON object with
-- closed keys and no duplicate. Three shapes, as the runtime writes them (cloud-run-log.ts):
--   a step: j, tool, call, args, args_bytes, args_hash, result (null while pending), reads, reads_cut (only true, only
--     when finished), releases, paths, text, at; args, text and result at most 8 KiB each as stored, reads 16 KiB;
--     paths, the paths the step named in its args and its receipt, not its reads (the runtime gives
--     qorpera_memory_step_narrow these and the read paths): at most 1,024 strings of at most 4,096 characters, 8 KiB
--     as stored;
--   a narrow step (§4.5): j, tool, call, args_hash, narrow, finished, result_hash (when finished), releases, at;
--   an erased step (§8): j, tool, call, args_hash, erased, and narrow or args_bytes.
-- Returns its parts, the folder keys a step names, the line's sha256 and that of its fixed parts (j, tool, call,
-- args_hash and at). A step names each of its paths, and each path, from, to or paths in its result, its arguments,
-- its reads and its output (result.content.text of kind json, when it parses), spelled as qorpera_memory_step_narrow
-- spells them: a leading /company/ goes, and a string that is no company path names nothing.
create function public.qorpera_memory_run_step_line(p_line text)
returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare
	v_json json; v_line jsonb; v_keys text[]; v_want text[]; v_erased boolean; v_narrow boolean; v_finished boolean;
	v_args jsonb; v_output jsonb; v_paths text[] := '{}';
begin
	-- Sized before it is parsed.
	if p_line is null or octet_length(p_line) > 50175 then return null; end if;
	begin
		v_json := p_line::json;
		v_line := p_line::jsonb;
	exception when data_exception then return null; end;
	if json_typeof(v_json) is distinct from 'object' then return null; end if;
	if (select count(*) from json_object_keys(v_json)) <> (select count(*) from jsonb_object_keys(v_line)) then return null; end if;
	v_keys := (select array_agg(k order by k collate "C") from jsonb_object_keys(v_line) k);
	if jsonb_typeof(v_line -> 'j') is distinct from 'number' or (v_line -> 'j')::text !~ '^(0|[1-9][0-9]{0,9})$' then
		return null; end if;
	if (v_line ->> 'j')::bigint > 2147483647 then return null; end if;
	if jsonb_typeof(v_line -> 'tool') is distinct from 'string' or char_length(v_line ->> 'tool') not between 1 and 128
		or (v_line ->> 'tool') ~ '[\x01-\x1f\x7f-\x9f]' then return null; end if;
	if jsonb_typeof(v_line -> 'call') is distinct from 'string' or char_length(v_line ->> 'call') not between 1 and 256
		or (v_line ->> 'call') ~ '[\x01-\x1f\x7f-\x9f]' then return null; end if;
	if jsonb_typeof(v_line -> 'args_hash') is distinct from 'null' and (jsonb_typeof(v_line -> 'args_hash') is distinct from 'string'
		or (v_line ->> 'args_hash') !~ '^[0-9a-f]{64}$') then return null; end if;
	v_erased := v_line ? 'erased';
	v_narrow := v_line ? 'narrow';
	if v_narrow and v_line -> 'narrow' is distinct from 'true'::jsonb then return null; end if;
	if v_erased then
		if v_line -> 'erased' is distinct from 'true'::jsonb then return null; end if;
		v_finished := true;
		v_want := array['j','tool','call','args_hash','erased'] || case when v_narrow then array['narrow'] else array['args_bytes'] end;
	elsif v_narrow then
		if jsonb_typeof(v_line -> 'finished') is distinct from 'boolean' then return null; end if;
		v_finished := v_line -> 'finished' = 'true'::jsonb;
		v_want := array['j','tool','call','args_hash','narrow','finished','releases','at']
			|| case when v_finished then array['result_hash'] else '{}'::text[] end;
		if v_finished and (jsonb_typeof(v_line -> 'result_hash') is distinct from 'string'
			or (v_line ->> 'result_hash') !~ '^[0-9a-f]{64}$') then return null; end if;
	else
		v_finished := jsonb_typeof(v_line -> 'result') is distinct from 'null';
		v_want := array['j','tool','call','args','args_bytes','args_hash','result','reads','releases','paths','text','at']
			|| case when v_line ? 'reads_cut' then array['reads_cut'] else '{}'::text[] end;
	end if;
	if v_keys is distinct from (select array_agg(k order by k collate "C") from unnest(v_want) k) then return null; end if;
	if not v_narrow and (jsonb_typeof(v_line -> 'args_bytes') is distinct from 'number'
		or (v_line -> 'args_bytes')::text !~ '^(0|[1-9][0-9]{0,9})$') then return null; end if;
	if not v_erased then
		if jsonb_typeof(v_line -> 'releases') is distinct from 'array' then return null; end if;
		if exists (select 1 from jsonb_array_elements(v_line -> 'releases') r where jsonb_typeof(r.value) is distinct from 'string'
			or (r.value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return null; end if;
		if jsonb_typeof(v_line -> 'at') is distinct from 'string'
			or (v_line ->> 'at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' then return null; end if;
	end if;
	if not v_erased and not v_narrow then
		if jsonb_typeof(v_line -> 'args') is distinct from 'string' or jsonb_typeof(v_line -> 'text') is distinct from 'string'
			or jsonb_typeof(v_line -> 'reads') is distinct from 'array' then return null; end if;
		if octet_length((v_json -> 'args')::text) > 8192 or octet_length((v_json -> 'text')::text) > 8192
			or octet_length((v_json -> 'result')::text) > 8192 or octet_length((v_json -> 'reads')::text) > 16384 then
			return null; end if;
		if jsonb_typeof(v_line -> 'paths') is distinct from 'array' or jsonb_array_length(v_line -> 'paths') > 1024
			or octet_length((v_json -> 'paths')::text) > 8192 then return null; end if;
		if exists (select 1 from jsonb_array_elements(v_line -> 'paths') p where jsonb_typeof(p.value) is distinct from 'string'
			or char_length(p.value #>> '{}') > 4096) then return null; end if;
		if exists (select 1 from jsonb_array_elements(v_line -> 'reads') r where jsonb_typeof(r.value) is distinct from 'object') then
			return null; end if;
		if exists (select 1 from jsonb_array_elements(v_line -> 'reads') r
			where (select array_agg(k order by k collate "C") from jsonb_object_keys(r.value) k) is distinct from array['path','version']
				or jsonb_typeof(r.value -> 'path') is distinct from 'string'
				or jsonb_typeof(r.value -> 'version') not in ('string','null')) then return null; end if;
		if (select count(*) from json_array_elements(v_json -> 'reads') r cross join lateral json_object_keys(r.value) k)
			<> (select count(*) from jsonb_array_elements(v_line -> 'reads') r cross join lateral jsonb_object_keys(r.value) k) then
			return null; end if;
		if v_line ? 'reads_cut' and (v_line -> 'reads_cut' is distinct from 'true'::jsonb or not v_finished) then return null; end if;
		-- A pending step has read and released nothing yet.
		if not v_finished and (v_line -> 'reads' <> '[]'::jsonb or v_line -> 'releases' <> '[]'::jsonb) then return null; end if;
		-- Arguments cut to fit, or an output that is no JSON or was cut, add nothing: the step's paths hold what they name.
		begin
			v_args := (v_line ->> 'args')::jsonb;
		exception when data_exception or program_limit_exceeded then v_args := null; end;
		if v_line #> '{result,content,kind}' = '"json"'::jsonb and jsonb_typeof(v_line #> '{result,content,text}') = 'string' then
			begin
				v_output := (v_line #>> '{result,content,text}')::jsonb;
			exception when data_exception or program_limit_exceeded then v_output := null; end;
		end if;
		select coalesce(array_agg(distinct public.qorpera_folder_key(c.path)), '{}') into v_paths
		from (select p.value #>> '{}' as raw from jsonb_array_elements(v_line -> 'paths') p
			union all select p.value #>> '{}'
			from jsonb_path_query(jsonb_build_array(v_line -> 'result', v_args, v_output, v_line -> 'reads'),
				'lax $.**."path" ? (@.type() == "string")') p(value)
			union all select p.value #>> '{}' from jsonb_path_query(jsonb_build_array(v_line -> 'result', v_args, v_output),
				'lax $.**."from" ? (@.type() == "string")') p(value)
			union all select p.value #>> '{}' from jsonb_path_query(jsonb_build_array(v_line -> 'result', v_args, v_output),
				'lax $.**."to" ? (@.type() == "string")') p(value)
			union all select p.value #>> '{}' from jsonb_path_query(jsonb_build_array(v_line -> 'result', v_args, v_output),
				'lax $.**."paths"[*] ? (@.type() == "string")') p(value)) s
		cross join lateral (select case when s.raw like '/company/%' then substr(s.raw, 10) else s.raw end as path) c
		where public.qorpera_company_path_valid(c.path);
	end if;
	return jsonb_build_object('j', (v_line ->> 'j')::integer, 'tool', v_line ->> 'tool', 'call', v_line ->> 'call',
		'args_hash', v_line ->> 'args_hash', 'narrow', v_narrow, 'erased', v_erased, 'finished', v_finished,
		'releases', case when v_erased then '[]'::jsonb else v_line -> 'releases' end, 'paths', to_jsonb(v_paths),
		'line_sha256', encode(extensions.digest(convert_to(p_line, 'utf8'), 'sha256'), 'hex'),
		'fixed_sha256', encode(extensions.digest(convert_to(jsonb_build_object('j', v_line -> 'j', 'tool', v_line -> 'tool',
			'call', v_line -> 'call', 'args_hash', v_line -> 'args_hash', 'at', v_line -> 'at')::text, 'utf8'), 'sha256'), 'hex'));
end $$;
revoke all on function public.qorpera_memory_run_step_line(text) from public, anon, authenticated, service_role;

-- The folder keys a step's needles hold: each key and its ancestors.
create function public.qorpera_memory_run_step_needles(p_paths jsonb)
returns text[] language sql immutable set search_path = '' as $$
	-- 20260930231000 (W1b)
	select coalesce(array_agg(distinct n.key order by n.key), '{}')
	from jsonb_array_elements_text(coalesce(p_paths, '[]'::jsonb)) p(key)
	cross join lateral unnest(array[p.key] || public.qorpera_folder_ancestors(p.key)) n(key)
$$;
revoke all on function public.qorpera_memory_run_step_needles(jsonb) from public, anon, authenticated, service_role;

-- Whether every agent reads a path: the company's shared root or its rules, not revoked.
create function public.qorpera_folder_path_every_agent(p_environment_id uuid, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930231000 (W1b)
	select coalesce((select ((r.path = '' and r.scope = 'company_shared') or r.scope = 'company_rules') and r.revoked_at is null
		from public.qorpera_folder_path_resource(p_environment_id, p_path) r where r.id is not null), false)
$$;
revoke all on function public.qorpera_folder_path_every_agent(uuid, text) from public, anon, authenticated, service_role;

-- Whether a run's machine made it narrow (§4.5). W6a fills this in for coding runs.
create function public.qorpera_memory_run_machine_narrow(p_environment_id uuid, p_run_id uuid)
returns boolean language sql stable set search_path = '' as $$
	-- 20260930231000 (W1b)
	select false
$$;
revoke all on function public.qorpera_memory_run_machine_narrow(uuid, uuid) from public, anon, authenticated, service_role;

-- Whether a run's log is narrow, wholly or from a step on, or its machine made it so. W5 resumes no narrow run.
create function public.qorpera_run_log_narrow(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930231000 (W1b)
	select coalesce((select l.narrow or l.narrow_from is not null from public.qorpera_memory_run_logs l
			where l.run_id = p_run_id limit 1), false)
		or coalesce((select public.qorpera_memory_run_machine_narrow(r.environment_id, r.id) from public.qorpera_execution_runs r
			where r.id = p_run_id), false)
$$;
revoke all on function public.qorpera_run_log_narrow(uuid) from public, anon, authenticated, service_role;

-- 3. Where a log goes ---------------------------------------------------------------------------------------------------

-- A run's place among runs (§4.5): its conversation, the step of its parent run that started it (a worker's dispatch,
-- as W4a-1 keeps it), the run it continues (the worker's previous dispatch, or the run a completion, machine or office
-- wake follows) and whether it is narrow (§4.5: its parent step, its parent's log from that step, the run it continues,
-- or its machine). Null when the run is not in this company. Plain reads.
create function public.qorpera_memory_run_origin(p_environment_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare
	v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype; v_sequence integer;
	v_parent uuid; v_step integer; v_continues uuid; v_narrow boolean;
begin
	select * into v_run from public.qorpera_execution_runs r where r.id = p_run_id and r.environment_id = p_environment_id;
	if v_run.id is null then return null; end if;
	select * into v_wake from public.qorpera_wake_occurrences w where w.run_id = p_run_id;
	if v_wake.wake_kind = 'agent' and v_wake.source_kind = 'worker-dispatch' and exists (select 1
		from public.qorpera_runtime_workers k where k.id = v_wake.source_id and k.folder_environment_id = p_environment_id) then
		-- Any sequence a worker row can hold (a positive integer); the inner case casts only what fits.
		v_sequence := case when (v_wake.payload ->> 'sequence') ~ '^[1-9][0-9]{0,9}$' then
			case when (v_wake.payload ->> 'sequence')::bigint <= 2147483647 then (v_wake.payload ->> 'sequence')::integer end end;
		select p.parent_step into v_step from public.qorpera_runtime_worker_parents p
		where p.worker_id = v_wake.source_id and p.sequence = v_sequence and p.parent_run_id = v_wake.parent_run_id;
		if v_step is not null then v_parent := v_wake.parent_run_id; end if;
		select w.run_id into v_continues from public.qorpera_wake_occurrences w
		where w.environment_id = p_environment_id and w.source_id = v_wake.source_id and w.wake_kind = 'agent'
			and w.source_kind = 'worker-dispatch' and w.run_id is not null and w.run_id <> p_run_id
			and (case when (w.payload ->> 'sequence') ~ '^[1-9][0-9]{0,9}$' then (w.payload ->> 'sequence')::bigint end) < v_sequence
		order by (case when (w.payload ->> 'sequence') ~ '^[1-9][0-9]{0,9}$' then (w.payload ->> 'sequence')::bigint end) desc
		limit 1;
		v_narrow := coalesce((select s.narrow from public.qorpera_memory_run_steps s
				where s.environment_id = p_environment_id and s.run_id = v_parent and s.j = v_step), false)
			or coalesce((select l.narrow or (l.narrow_from is not null and (v_step is null or l.narrow_from <= v_step))
				from public.qorpera_memory_run_logs l
				where l.environment_id = p_environment_id and l.run_id = v_wake.parent_run_id), false)
			or (v_wake.parent_run_id is not null
				and public.qorpera_memory_run_machine_narrow(p_environment_id, v_wake.parent_run_id))
			or (v_continues is not null and public.qorpera_run_log_narrow(v_continues));
	else
		if v_wake.source_kind in ('worker-completion','machine-event','machine-checkin','office-activation')
			and exists (select 1 from public.qorpera_execution_runs r
				where r.id = v_wake.parent_run_id and r.environment_id = p_environment_id) then
			v_continues := v_wake.parent_run_id;
		end if;
		v_narrow := v_continues is not null and public.qorpera_run_log_narrow(v_continues);
	end if;
	v_narrow := v_narrow or public.qorpera_memory_run_machine_narrow(p_environment_id, p_run_id);
	return jsonb_build_object('conversation', coalesce(v_run.session_id,
			(select l.session_id from public.qorpera_memory_run_logs l
				where l.environment_id = p_environment_id and l.run_id = v_wake.parent_run_id),
			(select r.session_id from public.qorpera_execution_runs r
				where r.id = v_wake.parent_run_id and r.environment_id = p_environment_id)),
		'parent', v_parent, 'step', v_step, 'continues', v_continues, 'narrow', v_narrow);
end $$;
revoke all on function public.qorpera_memory_run_origin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_memory_run_origin(uuid, uuid) to service_role;

-- A conversation's tree root key: the agent's thread when its room is bound to one, else the group chat's.
create function public.qorpera_memory_conversation_root(p_environment_id uuid, p_profile_id uuid, p_session_id uuid)
returns text language sql stable set search_path = '' as $$
	-- 20260930231000 (W1b)
	select case when r.bound_staff_agent_id is not null
		then public.qorpera_memory_owner_root(p_environment_id, 'agent', r.bound_staff_agent_id)
		else public.qorpera_memory_owner_root(p_environment_id, 'group', r.id) end
	from public.qorpera_company_rooms r
	where r.session_id = p_session_id and r.profile_id = p_profile_id
	order by r.id limit 1
$$;
revoke all on function public.qorpera_memory_conversation_root(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Where a run's log would be made: its origin and its conversation's tree root; null when either is missing.
create function public.qorpera_memory_run_log_home(p_environment_id uuid, p_run_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	-- 20260930231000 (W1b)
	select case when o.origin ->> 'conversation' is not null and t.root is not null
		then jsonb_build_object('origin', o.origin, 'root', t.root) end
	from (select public.qorpera_memory_run_origin(p_environment_id, p_run_id) as origin) o
	cross join lateral (select public.qorpera_memory_conversation_root(p_environment_id,
		(select r.profile_id from public.qorpera_execution_runs r where r.id = p_run_id and r.environment_id = p_environment_id),
		(o.origin ->> 'conversation')::uuid) as root) t
$$;
revoke all on function public.qorpera_memory_run_log_home(uuid, uuid) from public, anon, authenticated, service_role;

-- A run's log folder for its next batch (§4.5): where it is (exists) and its last block's number and the run's
-- generation; or where it goes, the folders to make on the way (missing, outermost first) and the run's origin for
-- run.toml; or gone, when it was made once and is no longer there, or the run has no conversation tree.
create function public.qorpera_memory_run_log_place(p_environment_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_log public.qorpera_memory_run_logs%rowtype; v_gen public.qorpera_memory_run_generations%rowtype; v_home jsonb;
	v_root text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_gen from public.qorpera_memory_run_generations g
	where g.environment_id = p_environment_id and g.run_id = p_run_id;
	select * into v_log from public.qorpera_memory_run_logs l
	where l.environment_id = p_environment_id and l.run_id = p_run_id;
	if v_log.run_id is not null and v_log.retired_at is null then
		return jsonb_build_object('path', v_log.run_path, 'exists', true, 'missing', '[]'::jsonb,
			'last', (select substring(s.block_key from '/([0-9]{8})\.jsonl$')::integer from public.qorpera_memory_run_steps s
				where s.environment_id = p_environment_id and s.run_id = p_run_id and s.j = v_log.step_count - 1),
			'generation', coalesce(v_gen.memory_generation, 0), 'gone', false);
	end if;
	if v_log.run_id is not null or v_gen.log_created_at is not null then return jsonb_build_object('gone', true); end if;
	v_home := public.qorpera_memory_run_log_home(p_environment_id, p_run_id);
	if v_home is null then return jsonb_build_object('gone', true); end if;
	v_root := v_home ->> 'root';
	return jsonb_build_object('path', v_root || '/runs/' || p_run_id, 'exists', false,
		'missing', coalesce((select jsonb_agg(m.p order by m.n) from unnest(array[
				case when v_root !~ '^agents/groups/' then regexp_replace(v_root, '/thread$', '') end, v_root, v_root || '/runs'])
				with ordinality m(p, n)
			where m.p is not null and not exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(m.p, 'sha256') and e.kind <> 'claim')),
			'[]'::jsonb),
		'last', null, 'generation', coalesce(v_gen.memory_generation, 0), 'gone', false, 'origin', v_home -> 'origin');
end $$;
revoke all on function public.qorpera_memory_run_log_place(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_memory_run_log_place(uuid, uuid) to service_role;

-- A narrow step's result hashes (§4.5): keyed with the company's step hash key and the run, so a hash names nothing
-- outside its run. Only while the job holds its lease on the run; at most 128 sha256 digests, in their order.
create function public.qorpera_memory_step_hashes(p_environment_id uuid, p_job_id uuid, p_run_id uuid, p_digests jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_key bytea;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	-- A plain read: a lease is the job's status, and nothing here waits on the job.
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = p_job_id and j.status = 'leased'
			and j.run_id = p_run_id and j.environment_id = p_environment_id and j.lease_expires_at > clock_timestamp())
		or not exists (select 1 from public.qorpera_execution_runs r where r.id = p_run_id and r.environment_id = p_environment_id) then
		raise exception 'The run''s lease is not held' using errcode = '42501'; end if;
	if jsonb_typeof(p_digests) is distinct from 'array' then
		raise exception 'Step digests are a list of sha256 digests' using errcode = '22023'; end if;
	if jsonb_array_length(p_digests) > 128 then
		raise exception 'Step digests are a list of sha256 digests' using errcode = '22023'; end if;
	if exists (select 1 from jsonb_array_elements(p_digests) d where jsonb_typeof(d.value) is distinct from 'string'
		or (d.value #>> '{}') !~ '^[0-9a-f]{64}$') then
		raise exception 'Step digests are a list of sha256 digests' using errcode = '22023'; end if;
	insert into public.qorpera_memory_step_hash_keys(environment_id) values (p_environment_id) on conflict do nothing;
	select k.key into v_key from public.qorpera_memory_step_hash_keys k where k.environment_id = p_environment_id;
	return coalesce((select jsonb_agg(encode(extensions.hmac(convert_to(p_run_id::text || ':' || (d.value #>> '{}'), 'utf8'),
		v_key, 'sha256'), 'hex') order by d.n) from jsonb_array_elements(p_digests) with ordinality d(value, n)), '[]'::jsonb);
end $$;
revoke all on function public.qorpera_memory_step_hashes(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_memory_step_hashes(uuid, uuid, uuid, jsonb) to service_role;

-- What makes a run's next step lines narrow (§4.5), as its log's file rules decide it: the log is narrow from its next
-- step on (the whole log, or a step it holds), the run's machine went narrow, and which of the paths a step names not
-- every agent reads. A path is spelled as a step line has it (a leading /company/ goes); one that is no company path
-- names nothing, as in qorpera_memory_run_step_line. Only while the job holds its lease on the run; at most 1,024 paths.
create function public.qorpera_memory_step_narrow(p_environment_id uuid, p_job_id uuid, p_run_id uuid, p_paths jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930231000 (W1b)
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = p_job_id and j.status = 'leased'
			and j.run_id = p_run_id and j.environment_id = p_environment_id and j.lease_expires_at > clock_timestamp())
		or not exists (select 1 from public.qorpera_execution_runs r where r.id = p_run_id and r.environment_id = p_environment_id) then
		raise exception 'The run''s lease is not held' using errcode = '42501'; end if;
	if jsonb_typeof(p_paths) is distinct from 'array' then
		raise exception 'Step paths are a list of at most 1,024 paths' using errcode = '22023'; end if;
	if jsonb_array_length(p_paths) > 1024 or exists (select 1 from jsonb_array_elements(p_paths) p
		where jsonb_typeof(p.value) is distinct from 'string' or char_length(p.value #>> '{}') > 4096) then
		raise exception 'Step paths are a list of at most 1,024 paths' using errcode = '22023'; end if;
	return jsonb_build_object(
		'log', coalesce((select l.narrow or l.narrow_from is not null from public.qorpera_memory_run_logs l
			where l.environment_id = p_environment_id and l.run_id = p_run_id and l.retired_at is null), false),
		'machine', public.qorpera_memory_run_machine_narrow(p_environment_id, p_run_id),
		'restricted', coalesce((select jsonb_agg(p.value order by p.n)
			from jsonb_array_elements(p_paths) with ordinality p(value, n)
			cross join lateral (select case when p.value #>> '{}' like '/company/%' then substr(p.value #>> '{}', 10)
				else p.value #>> '{}' end as path) c
			where public.qorpera_company_path_valid(c.path)
				and not public.qorpera_folder_path_every_agent(p_environment_id, public.qorpera_folder_key(c.path))), '[]'::jsonb));
end $$;
revoke all on function public.qorpera_memory_step_narrow(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_memory_step_narrow(uuid, uuid, uuid, jsonb) to service_role;

-- A memory commit's run rows, before the receipts' rank 10 (§4.5): each run its request names, in id order, FOR SHARE;
-- the logged run FOR NO KEY UPDATE while its log is not made yet, so two first batches never both make it. An erase
-- takes the row FOR UPDATE and waits for the batches; a batch after it sees erase_open.
create function public.qorpera_memory_run_generations_lock(p_environment_id uuid, p_operation_key text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_request jsonb := public.qorpera_folder_memory_request(); v_log uuid; v_id uuid;
begin
	if v_request is null or v_request ->> 'environmentId' is distinct from p_environment_id::text
		or v_request ->> 'operationKey' is distinct from p_operation_key then return; end if;
	v_log := (v_request -> 'preconditions' -> 'runLog' ->> 'run')::uuid;
	for v_id in select distinct i.id from (select v_log as id union all
			select (g.value ->> 'runId')::uuid from jsonb_array_elements(coalesce(v_request -> 'preconditions' -> 'runGenerations',
				'[]'::jsonb)) g) i
		where i.id is not null order by i.id loop
		insert into public.qorpera_memory_run_generations(environment_id, run_id) values (p_environment_id, v_id)
		on conflict do nothing;
		if v_id = v_log and exists (select 1 from public.qorpera_memory_run_generations g
			where g.environment_id = p_environment_id and g.run_id = v_id and g.log_created_at is null) then
			perform 1 from public.qorpera_memory_run_generations g
			where g.environment_id = p_environment_id and g.run_id = v_id for no key update;
		else
			perform 1 from public.qorpera_memory_run_generations g
			where g.environment_id = p_environment_id and g.run_id = v_id for share;
		end if;
	end loop;
end $$;
revoke all on function public.qorpera_memory_run_generations_lock(uuid, text) from public, anon, authenticated, service_role;

-- 4. The request ---------------------------------------------------------------------------------------------------------

-- A memory request's preconditions: sessionGenerations (M1a); runLog, the run whose log the commit writes and the path
-- of its folder; runGenerations, the runs whose generation it names (at most 64, each once). Every session and run is
-- this company's.
create or replace function public.qorpera_folder_memory_preconditions_valid(p_environment_id uuid, p_preconditions jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_item jsonb; v_ids uuid[] := '{}'; v_runs uuid[] := '{}';
begin
	if jsonb_typeof(p_preconditions) is distinct from 'object' then return false; end if;
	if exists (select 1 from jsonb_object_keys(p_preconditions) k where k not in ('sessionGenerations','runLog','runGenerations')) then
		return false; end if;
	if p_preconditions ? 'sessionGenerations' then
		if jsonb_typeof(p_preconditions -> 'sessionGenerations') is distinct from 'array'
			or jsonb_array_length(p_preconditions -> 'sessionGenerations') > 64 then return false; end if;
		for v_item in select value from jsonb_array_elements(p_preconditions -> 'sessionGenerations') loop
			if jsonb_typeof(v_item) is distinct from 'object' then return false; end if;
			if exists (select 1 from jsonb_object_keys(v_item) k where k not in ('sessionId','generation'))
				or jsonb_typeof(v_item -> 'sessionId') is distinct from 'string'
				or (v_item ->> 'sessionId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				or jsonb_typeof(v_item -> 'generation') is distinct from 'number'
				or (v_item -> 'generation')::text !~ '^(0|[1-9][0-9]{0,17})$' then return false; end if;
			if (v_item ->> 'sessionId')::uuid = any (v_ids) then return false; end if;
			v_ids := v_ids || (v_item ->> 'sessionId')::uuid;
		end loop;
		if exists (select 1 from unnest(v_ids) i(id) where not exists (select 1 from public.qorpera_shared_sessions s
			where s.id = i.id and s.environment_id = p_environment_id)) then return false; end if;
	end if;
	if p_preconditions ? 'runLog' then
		v_item := p_preconditions -> 'runLog';
		if jsonb_typeof(v_item) is distinct from 'object' then return false; end if;
		if exists (select 1 from jsonb_object_keys(v_item) k where k not in ('run','path'))
			or jsonb_typeof(v_item -> 'run') is distinct from 'string'
			or (v_item ->> 'run') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or jsonb_typeof(v_item -> 'path') is distinct from 'string'
			or char_length(v_item ->> 'path') not between 1 and 4096 then return false; end if;
		v_runs := v_runs || (v_item ->> 'run')::uuid;
	end if;
	if p_preconditions ? 'runGenerations' then
		if jsonb_typeof(p_preconditions -> 'runGenerations') is distinct from 'array'
			or jsonb_array_length(p_preconditions -> 'runGenerations') > 64 then return false; end if;
		v_ids := '{}';
		for v_item in select value from jsonb_array_elements(p_preconditions -> 'runGenerations') loop
			if jsonb_typeof(v_item) is distinct from 'object' then return false; end if;
			if exists (select 1 from jsonb_object_keys(v_item) k where k not in ('runId','generation'))
				or jsonb_typeof(v_item -> 'runId') is distinct from 'string'
				or (v_item ->> 'runId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				or jsonb_typeof(v_item -> 'generation') is distinct from 'number'
				or (v_item -> 'generation')::text !~ '^(0|[1-9][0-9]{0,17})$' then return false; end if;
			if (v_item ->> 'runId')::uuid = any (v_ids) then return false; end if;
			v_ids := v_ids || (v_item ->> 'runId')::uuid;
		end loop;
		v_runs := v_runs || v_ids;
	end if;
	return not exists (select 1 from unnest(v_runs) i(id) where not exists (select 1 from public.qorpera_execution_runs r
		where r.id = i.id and r.environment_id = p_environment_id));
end $$;

-- The request's generations at decide, under the locks: a stale session or run generation, or a log batch while an
-- erase is open on its run, refuses the commit.
create or replace function public.qorpera_memory_generation_decide(p_environment_id uuid, p_commit_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_request jsonb := public.qorpera_folder_memory_request();
begin
	if v_request is null then return null; end if;
	if v_request ->> 'environmentId' is distinct from p_environment_id::text
		or v_request ->> 'operationKey' is distinct from (select c.operation_key from public.qorpera_folder_commits c where c.id = p_commit_id) then
		return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
			public.qorpera_company_state_problem('value', null, null, 'the memory request does not belong to this change'))); end if;
	if exists (select 1 from jsonb_array_elements(coalesce(v_request -> 'preconditions' -> 'sessionGenerations', '[]'::jsonb)) g
		where not exists (select 1 from public.qorpera_shared_sessions s
			where s.id = (g ->> 'sessionId')::uuid and s.environment_id = p_environment_id
				and s.memory_generation = (g ->> 'generation')::bigint)) then
		return jsonb_build_object('ok', false, 'reason', 'memory_generation_stale'); end if;
	if (v_request -> 'preconditions') ? 'runLog' and exists (select 1 from public.qorpera_memory_run_generations g
		where g.environment_id = p_environment_id and g.run_id = (v_request #>> '{preconditions,runLog,run}')::uuid
			and g.erase_open is not null) then
		return jsonb_build_object('ok', false, 'reason', 'memory_erase_open'); end if;
	if exists (select 1 from jsonb_array_elements(coalesce(v_request -> 'preconditions' -> 'runGenerations', '[]'::jsonb)) g
		where coalesce((select r.memory_generation from public.qorpera_memory_run_generations r
			where r.environment_id = p_environment_id and r.run_id = (g.value ->> 'runId')::uuid), 0)
			<> (g.value ->> 'generation')::bigint) then
		return jsonb_build_object('ok', false, 'reason', 'memory_generation_stale'); end if;
	return null;
end $$;

-- M1a's memory commit, now a call a run makes as itself: a run actor names only its own run in runLog and
-- runGenerations, checked before the commit takes any lock (the run generation rows are locked before the receipts'
-- rank 10). The platform names any run of the company, as before.
create or replace function public.qorpera_folder_memory_commit(p_environment_id uuid, p_actor jsonb, p_operation_key text,
	p_units jsonb, p_preconditions jsonb default '{}'::jsonb, p_review_id uuid default null, p_receipt_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_result jsonb; v_pre jsonb := coalesce(p_preconditions, '{}'::jsonb);
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if coalesce(current_setting('qorpera.folder_memory', true), '') <> '' then raise exception 'A memory request is already set in this transaction' using errcode = '55000'; end if;
	if p_environment_id is null or coalesce(p_operation_key, '') = ''
		or not public.qorpera_folder_memory_preconditions_valid(p_environment_id, v_pre) then
		raise exception 'Memory request is invalid' using errcode = '22023'; end if;
	if p_actor ->> 'kind' = 'run' and (v_pre ? 'runLog' and v_pre #>> '{runLog,run}' is distinct from p_actor ->> 'runId'
		or exists (select 1 from jsonb_array_elements(coalesce(v_pre -> 'runGenerations', '[]'::jsonb)) g
			where g.value ->> 'runId' is distinct from p_actor ->> 'runId')) then
		raise exception 'A run writes only its own run log' using errcode = '42501'; end if;
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', p_environment_id::text,
		'operationKey', p_operation_key, 'preconditions', v_pre)::text, true);
	v_result := public.qorpera_folder_commit(p_environment_id, p_actor, p_operation_key, p_units, p_review_id, p_receipt_id);
	perform set_config('qorpera.folder_memory', '', true);
	return v_result;
end $$;
revoke all on function public.qorpera_folder_memory_commit(uuid, jsonb, text, jsonb, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_memory_commit(uuid, jsonb, text, jsonb, jsonb, uuid, uuid) to service_role;

-- 5. The refusals ------------------------------------------------------------------------------------------------------

-- The structured-file hook's run log check, for every unit of a memory commit (§4.5), after M1a's tree check. Returns a
-- refusal or null. A commit without runLog is the platform's and writes no runs/ path. One with runLog writes only that
-- run's log folder and the folders on the way to it, t<n> only naming the run's generation; its actor is the platform or
-- that run, and only the platform deletes. The folder is where the log is, or where it goes while it has none.
create function public.qorpera_memory_run_log_paths(p_environment_id uuid, p_actor jsonb, p_op text, p_key text, p_unit jsonb,
	p_eff_path text)
returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare
	v_request jsonb := public.qorpera_folder_memory_request(); v_log jsonb; v_run uuid; v_log_key text; v_touch record;
	v_root text; v_row public.qorpera_memory_run_logs%rowtype; v_gen public.qorpera_memory_run_generations%rowtype;
	v_home jsonb;
	v_own_log constant jsonb := jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
		public.qorpera_company_state_problem('value', null, null, 'a run writes only its own run log')));
begin
	if v_request is null then return null; end if;
	v_log := v_request -> 'preconditions' -> 'runLog';
	if v_log is null and p_actor ->> 'kind' is distinct from 'platform' then return v_own_log; end if;
	if v_log is not null then
		v_run := (v_log ->> 'run')::uuid;
		v_log_key := public.qorpera_folder_key(v_log ->> 'path');
		if public.qorpera_memory_run_folder_key(v_log_key) is distinct from v_log_key
			or right(v_log_key, 42) <> '/runs/' || v_run::text then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a run log''s folder is <tree>/runs/<its run>'))); end if;
		if p_actor ->> 'kind' is distinct from 'platform'
			and (p_actor ->> 'kind' is distinct from 'staff_agent' or p_actor ->> 'runId' is distinct from v_run::text) then
			return v_own_log; end if;
		if p_op = 'delete' and p_actor ->> 'kind' is distinct from 'platform' then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'only the platform deletes a run log''s files'))); end if;
	end if;
	for v_touch in select p_key as key
		union all
		select public.qorpera_folder_key(c.path)
		from public.qorpera_folder_spelled_contents(p_eff_path,
			case when p_op = 'new_folder' then p_unit -> 'contents' else '[]'::jsonb end) c
	loop
		if v_log is null then
			v_root := public.qorpera_memory_tree_root_key(v_touch.key);
			if v_root is not null and ltrim(substr(v_touch.key, char_length(v_root) + 1), '/') ~ '^runs(/|$)' then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'a run log''s change names its run (runLog)'))); end if;
		elsif v_touch.key <> v_log_key and left(v_log_key, char_length(v_touch.key) + 1) <> v_touch.key || '/'
			and left(v_touch.key, char_length(v_log_key) + 1) <> v_log_key || '/' then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a run log''s change writes only its own log folder')));
		elsif left(v_touch.key, char_length(v_log_key) + 1) = v_log_key || '/'
			and substr(v_touch.key, char_length(v_log_key) + 2) ~ '^t([0-9]|1[0-4])(/|$)'
			and not exists (select 1 from jsonb_array_elements(coalesce(v_request -> 'preconditions' -> 'runGenerations',
				'[]'::jsonb)) g where g.value ->> 'runId' = v_run::text) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a run tree''s change names its run''s generation')));
		end if;
	end loop;
	if v_log is null then return null; end if;
	-- Where the log is, or where it goes.
	select * into v_row from public.qorpera_memory_run_logs l where l.environment_id = p_environment_id and l.run_id = v_run;
	if v_row.run_id is not null and v_row.retired_at is null then
		if v_row.run_key <> v_log_key then return jsonb_build_object('ok', false, 'reason', 'memory_run_log_moved'); end if;
		return null;
	end if;
	select * into v_gen from public.qorpera_memory_run_generations g where g.environment_id = p_environment_id and g.run_id = v_run;
	if v_row.run_id is not null or v_gen.log_created_at is not null then
		return jsonb_build_object('ok', false, 'reason', 'memory_run_log_gone'); end if;
	v_home := public.qorpera_memory_run_log_home(p_environment_id, v_run);
	if v_home is null then return jsonb_build_object('ok', false, 'reason', 'memory_run_log_gone'); end if;
	if (v_home ->> 'root') || '/runs/' || v_run::text <> v_log_key then
		return jsonb_build_object('ok', false, 'reason', 'memory_run_log_moved'); end if;
	return null;
end $$;
revoke all on function public.qorpera_memory_run_log_paths(uuid, jsonb, text, text, jsonb, text)
	from public, anon, authenticated, service_role;

-- Whether a memory commit's unit is in its run's own log, which the run writes as itself without the folder's grants
-- (§4.3): its agent may hold none where the log goes, as in a group chat's tree. Every path the unit makes is the log's
-- folder, under it, or a folder on the way to it inside the conversation's memory folder; the run's write still needs
-- the request of this commit, and the structured hook decides the unit as any other. Only the platform deletes.
create function public.qorpera_memory_run_log_admits(p_environment_id uuid, p_operation_key text, p_actor jsonb, p_op text,
	p_path text, p_unit jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_request jsonb := public.qorpera_folder_memory_request(); v_run text; v_log_key text;
begin
	if v_request is null or v_request ->> 'environmentId' is distinct from p_environment_id::text
		or v_request ->> 'operationKey' is distinct from p_operation_key or p_op not in ('write','mkdir','new_folder') then
		return false; end if;
	v_run := v_request #>> '{preconditions,runLog,run}';
	if v_run is null or p_actor ->> 'kind' is distinct from 'staff_agent' or p_actor ->> 'runId' is distinct from v_run then
		return false; end if;
	v_log_key := public.qorpera_folder_key(v_request #>> '{preconditions,runLog,path}');
	if public.qorpera_memory_run_folder_key(v_log_key) is distinct from v_log_key or right(v_log_key, 42) <> '/runs/' || v_run then
		return false; end if;
	return not exists (select 1
		from (select public.qorpera_folder_key(p_path) as key
			union all
			select public.qorpera_folder_key(p_path || '/' || (c.value ->> 'path'))
			from jsonb_array_elements(case when p_op = 'new_folder' and jsonb_typeof(p_unit -> 'contents') = 'array'
				then p_unit -> 'contents' else '[]'::jsonb end) c) t
		where t.key is null or not (t.key = v_log_key or left(t.key, char_length(v_log_key) + 1) = v_log_key || '/'
			or (left(v_log_key, char_length(t.key) + 1) = t.key || '/' and t.key ~ '^agents/([^/]+|groups/[^/]+)/memory(/|$)')));
end $$;
revoke all on function public.qorpera_memory_run_log_admits(uuid, text, jsonb, text, text, jsonb)
	from public, anon, authenticated, service_role;

-- A run log file's own rules, for each one a unit writes (§4.5). run.toml names the run's origin and never changes. A
-- log block is 1 to 16 step lines from its number on, after the log's last step or a block of the same commit: a step
-- stays in its block, a finished or erased line never changes and a pending one only to its finished form, which
-- names every path it named (or is narrow); a new
-- erased line is the erase's (W5). A narrow log, a log from its first narrow step on and a run whose machine went narrow
-- take only narrow lines; a line that is not narrow names only paths every agent reads. A run tree block parses. Returns
-- a refusal or null.
create function public.qorpera_memory_run_log_file_rules(p_environment_id uuid, p_entries jsonb, p_key text, p_kind text,
	p_parse jsonb, p_text text)
returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930231000 (W1b)
declare
	v_folder text := public.qorpera_memory_run_folder_key(p_key); v_run uuid; v_row public.qorpera_memory_run_logs%rowtype;
	v_toml jsonb; v_home jsonb; v_problem text; v_lines text[]; v_line text; v_parsed jsonb; v_no integer := 0;
	v_start integer; v_end integer; v_old public.qorpera_memory_run_steps%rowtype; v_block jsonb; v_narrow boolean;
	v_machine boolean;
begin
	if p_parse is distinct from jsonb_build_object('kind', p_kind) then
		return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
			public.qorpera_company_state_problem('front_matter', null, null, 'the platform could not read this file; save it again')));
	end if;
	v_run := right(v_folder, 36)::uuid;
	select * into v_row from public.qorpera_memory_run_logs l
	where l.environment_id = p_environment_id and l.run_id = v_run and l.retired_at is null;
	if p_kind = 'memory-run' then
		v_toml := public.qorpera_memory_run_toml(p_text);
		if v_toml is null then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'run.toml is format = 1, run, conversation, then parent '
					'and step, continues and narrow = true when they apply, one per line'))); end if;
		if v_toml ->> 'run' is distinct from v_run::text then
			v_problem := 'run is this log''s own run, ' || v_run;
		elsif v_row.run_id is null then
			v_home := public.qorpera_memory_run_log_home(p_environment_id, v_run);
			if v_home is null or (v_toml - 'run') is distinct from v_home -> 'origin' then
				v_problem := 'run.toml names the run''s conversation, parent step, the run it continues and whether it is narrow';
			end if;
		elsif (v_toml - 'run') is distinct from jsonb_build_object('conversation', v_row.session_id, 'parent', v_row.parent_run_id,
			'step', v_row.parent_step, 'continues', v_row.continues_run_id, 'narrow', v_row.narrow) then
			v_problem := 'a run log''s run.toml does not change';
		end if;
	elsif p_kind = 'memory-run-block' then
		if v_row.run_id is null then
			v_problem := 'write this log''s run.toml first';
		else
			v_block := public.qorpera_memory_run_block_parse(p_key, p_text);
			if v_block ? 'problem' then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', (v_block ->> 'line')::integer, null, v_block ->> 'problem'))); end if;
		end if;
	else
		v_toml := public.qorpera_memory_run_toml(p_entries -> (v_folder || '/run.toml') ->> 'text');
		if v_row.run_id is null and v_toml ->> 'run' is distinct from v_run::text then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'write this log''s run.toml first'))); end if;
		if p_text is null or octet_length(p_text) > 65536 or right(p_text, 1) is distinct from E'\n' then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a log block is 1 to 16 step lines, each ending in a newline, at most 65,536 bytes'))); end if;
		v_lines := string_to_array(left(p_text, -1), E'\n');
		if coalesce(cardinality(v_lines), 0) not between 1 and 16 then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a log block is 1 to 16 step lines, each ending in a newline, at most 65,536 bytes'))); end if;
		v_start := substring(p_key from '/([0-9]{8})\.jsonl$')::integer;
		v_end := v_start + cardinality(v_lines);
		-- Narrow before this block: the log, its committed steps from narrow_from, or a block before it in this commit.
		v_narrow := coalesce(v_row.narrow, (v_toml ->> 'narrow')::boolean, false)
			or exists (select 1 from jsonb_each(p_entries) e
				cross join lateral unnest(string_to_array(left(e.value ->> 'text', -1), E'\n')) l(line)
				where e.key ~ '/log/[0-9]{8}\.jsonl$' and left(e.key, -char_length('/log/00000000.jsonl')) = v_folder
					and (case when e.key ~ '/log/[0-9]{8}\.jsonl$' then substring(e.key from '/([0-9]{8})\.jsonl$')::integer end) < v_start
					and coalesce((public.qorpera_memory_run_step_line(l.line) ->> 'narrow')::boolean, false));
		-- The run's machine went narrow (W6a): every line written from now on is narrow.
		v_machine := public.qorpera_memory_run_machine_narrow(p_environment_id, v_run);
		foreach v_line in array v_lines loop
			v_no := v_no + 1;
			-- Sized before it is parsed.
			if octet_length(v_line) > 50175 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', v_no, null, 'this line is longer than a step line can be'))); end if;
			v_parsed := public.qorpera_memory_run_step_line(v_line);
			if v_parsed is null then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', v_no, null, 'this line is not a step line'))); end if;
			if (v_parsed ->> 'j')::integer <> v_start + v_no - 1 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', v_no, null, 'the steps go by j from the block''s number, each once')));
			end if;
			select * into v_old from public.qorpera_memory_run_steps s
			where s.environment_id = p_environment_id and s.run_id = v_run and s.j = v_start + v_no - 1;
			if v_old.run_id is not null and v_old.block_key <> p_key then
				v_problem := 'step ' || (v_start + v_no - 1) || ' is in another block';
			elsif v_old.run_id is not null and (v_old.erased or v_old.finished) and v_old.line_sha256 <> v_parsed ->> 'line_sha256' then
				v_problem := 'step ' || (v_start + v_no - 1) || ' is finished and does not change';
			elsif v_old.run_id is not null and not (v_old.erased or v_old.finished)
				and v_old.fixed_sha256 <> v_parsed ->> 'fixed_sha256' then
				v_problem := 'step ' || (v_start + v_no - 1) || ' changes only to its finished form';
			elsif (v_old.run_id is null or v_old.line_sha256 <> v_parsed ->> 'line_sha256') and (v_parsed ->> 'erased')::boolean then
				v_problem := 'only an erase writes an erased step';
			-- A pending line's paths stay in its finished form, so an erase still finds what its arguments hold; only the
			-- narrow form, which holds none of it, drops them.
			elsif v_old.run_id is not null and not (v_old.erased or v_old.finished) and not (v_parsed ->> 'narrow')::boolean
				and not (v_old.needles <@ public.qorpera_memory_run_step_needles(v_parsed -> 'paths')) then
				v_problem := 'step ' || (v_start + v_no - 1) || ' keeps every path it named while pending';
			elsif v_old.run_id is null and v_start + v_no - 1 < coalesce(v_row.step_count, 0) then
				v_problem := 'step ' || (v_start + v_no - 1) || ' is missing from its block';
			elsif (v_old.run_id is null or v_old.line_sha256 <> v_parsed ->> 'line_sha256')
				and not (v_parsed ->> 'narrow')::boolean and (v_narrow or v_start + v_no - 1 >= v_row.narrow_from) then
				v_problem := 'step ' || (v_start + v_no - 1) || ' comes after a narrow step and is written narrow';
			elsif (v_old.run_id is null or v_old.line_sha256 <> v_parsed ->> 'line_sha256')
				and not (v_parsed ->> 'narrow')::boolean and v_machine then
				v_problem := 'step ' || (v_start + v_no - 1) || ' comes after its machine went narrow and is written narrow';
			elsif (v_old.run_id is null or v_old.line_sha256 <> v_parsed ->> 'line_sha256')
				and not (v_parsed ->> 'narrow')::boolean and exists (select 1 from jsonb_array_elements_text(v_parsed -> 'paths') p(key)
					where not public.qorpera_folder_path_every_agent(p_environment_id, p.key)) then
				v_problem := 'step ' || (v_start + v_no - 1) || ' names a path not every agent reads and is written narrow';
			end if;
			if v_problem is not null then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', v_no, null, v_problem))); end if;
			v_narrow := v_narrow or (v_parsed ->> 'narrow')::boolean;
		end loop;
		if exists (select 1 from public.qorpera_memory_run_steps s
			where s.environment_id = p_environment_id and s.run_id = v_run and s.block_key = p_key and s.j >= v_end) then
			v_problem := 'a log block keeps every step it holds';
		-- Overlap first: blocks of one change that overlap may still chain, end to start.
		elsif exists (select 1 from jsonb_each(p_entries) e
			where e.key ~ '/log/[0-9]{8}\.jsonl$' and left(e.key, -char_length('/log/00000000.jsonl')) = v_folder and e.key <> p_key
				and (case when e.key ~ '/log/[0-9]{8}\.jsonl$' then substring(e.key from '/([0-9]{8})\.jsonl$')::integer end) < v_end
				and (case when e.key ~ '/log/[0-9]{8}\.jsonl$' then substring(e.key from '/([0-9]{8})\.jsonl$')::integer end)
					+ cardinality(string_to_array(left(e.value ->> 'text', -1), E'\n')) > v_start) then
			v_problem := 'two log blocks hold the same step';
		elsif v_start > coalesce(v_row.step_count, 0) and not exists (select 1 from jsonb_each(p_entries) e
			where e.key ~ '/log/[0-9]{8}\.jsonl$' and left(e.key, -char_length('/log/00000000.jsonl')) = v_folder
				and (case when e.key ~ '/log/[0-9]{8}\.jsonl$' then substring(e.key from '/([0-9]{8})\.jsonl$')::integer end)
					+ cardinality(string_to_array(left(e.value ->> 'text', -1), E'\n')) = v_start) then
			v_problem := 'a log block starts at the log''s next step';
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
		public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;
revoke all on function public.qorpera_memory_run_log_file_rules(uuid, jsonb, text, text, jsonb, text)
	from public, anon, authenticated, service_role;

-- 6. The index in apply ------------------------------------------------------------------------------------------------

-- A run log file written: run.toml upserts the log's row (a retired one comes back) and marks the log made; a log block
-- upserts its steps; a run tree block replaces its lines.
create function public.qorpera_memory_run_log_index(p_environment_id uuid, p_commit_id uuid, p_path text, p_key text,
	p_version uuid, p_kind text, p_text text)
returns void language plpgsql security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_folder text := public.qorpera_memory_run_folder_key(p_key); v_run uuid; v_toml jsonb; v_rows bigint; v_session uuid;
	v_block jsonb; v_steps jsonb;
begin
	v_run := right(v_folder, 36)::uuid;
	if p_kind = 'memory-run' then
		v_toml := public.qorpera_memory_run_toml(p_text);
		insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, parent_run_id, parent_step, continues_run_id,
			narrow, run_path, run_key, toml_path_version, commit_id)
		values (p_environment_id, v_run, (v_toml ->> 'conversation')::uuid, (v_toml ->> 'parent')::uuid,
			(v_toml ->> 'step')::integer, (v_toml ->> 'continues')::uuid, (v_toml ->> 'narrow')::boolean,
			left(p_path, -char_length('/run.toml')), v_folder, p_version, p_commit_id)
		on conflict (environment_id, run_id) do update set run_path = excluded.run_path, run_key = excluded.run_key,
			toml_path_version = excluded.toml_path_version, commit_id = excluded.commit_id, retired_at = null,
			updated_at = clock_timestamp();
		get diagnostics v_rows = row_count;
		if v_rows <> 1 or v_toml is null then raise exception 'A run log''s run.toml does not index' using errcode = 'XX000'; end if;
		update public.qorpera_memory_run_generations g set log_created_at = clock_timestamp(), updated_at = clock_timestamp()
		where g.environment_id = p_environment_id and g.run_id = v_run and g.log_created_at is null;
		return;
	end if;
	select l.session_id into v_session from public.qorpera_memory_run_logs l
	where l.environment_id = p_environment_id and l.run_id = v_run and l.retired_at is null;
	if v_session is null then raise exception 'A run log''s block has no run.toml in its commit' using errcode = 'XX000'; end if;
	if p_kind = 'memory-run-block' then
		v_block := public.qorpera_memory_run_block_parse(p_key, p_text);
		if v_block ? 'problem' then raise exception 'A run tree''s block does not parse in apply' using errcode = 'XX000'; end if;
		delete from public.qorpera_memory_tree_nodes n where n.environment_id = p_environment_id and n.block_key = p_key;
		insert into public.qorpera_memory_tree_nodes(environment_id, session_id, run_id, l, k, text, bytes, free, tries, seq,
			event_hash, block_path, block_key, block_path_version, commit_id)
		select p_environment_id, v_session, v_run, (x.value ->> 'l')::smallint, (x.value ->> 'k')::bigint, x.value ->> 'text',
			octet_length(x.value ->> 'text'), (x.value ->> 'free')::boolean, (x.value ->> 'tries')::smallint, null, null,
			p_path, p_key, p_version, p_commit_id
		from jsonb_array_elements(v_block -> 'lines') x;
		return;
	end if;
	select coalesce(jsonb_agg(public.qorpera_memory_run_step_line(l.line) order by l.n), '[]'::jsonb) into v_steps
	from unnest(string_to_array(left(p_text, -1), E'\n')) with ordinality l(line, n);
	if exists (select 1 from jsonb_array_elements(v_steps) s where jsonb_typeof(s.value) is distinct from 'object') then
		raise exception 'A run log''s block does not parse in apply' using errcode = 'XX000'; end if;
	insert into public.qorpera_memory_run_steps(environment_id, run_id, j, tool, call_id, args_hash, releases, needles, narrow,
		erased, finished, line_sha256, fixed_sha256, block_path, block_key, block_path_version, commit_id)
	select p_environment_id, v_run, (s.value ->> 'j')::integer, s.value ->> 'tool', s.value ->> 'call', s.value ->> 'args_hash',
		array(select r::uuid from jsonb_array_elements_text(s.value -> 'releases') r),
		case when (s.value ->> 'narrow')::boolean or (s.value ->> 'erased')::boolean then '{}'::text[]
			else public.qorpera_memory_run_step_needles(s.value -> 'paths') end,
		(s.value ->> 'narrow')::boolean, (s.value ->> 'erased')::boolean, (s.value ->> 'finished')::boolean,
		s.value ->> 'line_sha256', s.value ->> 'fixed_sha256', p_path, p_key, p_version, p_commit_id
	from jsonb_array_elements(v_steps) s
	on conflict (environment_id, run_id, j) do update set tool = excluded.tool, call_id = excluded.call_id,
		args_hash = excluded.args_hash, releases = excluded.releases, needles = excluded.needles, narrow = excluded.narrow,
		erased = excluded.erased, finished = excluded.finished, line_sha256 = excluded.line_sha256,
		fixed_sha256 = excluded.fixed_sha256, block_path = excluded.block_path, block_key = excluded.block_key,
		block_path_version = excluded.block_path_version, commit_id = excluded.commit_id, updated_at = clock_timestamp();
	update public.qorpera_memory_run_logs l set
		step_count = greatest(l.step_count, (select max((s.value ->> 'j')::integer) + 1 from jsonb_array_elements(v_steps) s)),
		narrow_from = least(l.narrow_from, (select min((s.value ->> 'j')::integer) from jsonb_array_elements(v_steps) s
			where (s.value ->> 'narrow')::boolean and not (s.value ->> 'erased')::boolean)),
		updated_at = clock_timestamp()
	where l.environment_id = p_environment_id and l.run_id = v_run and l.retired_at is null;
end $$;
revoke all on function public.qorpera_memory_run_log_index(uuid, uuid, text, text, uuid, text, text)
	from public, anon, authenticated, service_role;

-- A folder moved with run logs in it (an agent's or a group's rename): each log and step follows its file, to the
-- version the move made. Its tree lines follow with M1a's.
create function public.qorpera_memory_run_log_moved(p_environment_id uuid, p_commit_id uuid, p_key text, p_eff_path text,
	p_eff_to text)
returns void language plpgsql security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_rows bigint; v_moved bigint;
begin
	select count(*) into v_rows from public.qorpera_memory_run_logs l
	where l.environment_id = p_environment_id and l.retired_at is null
		and l.run_key > (p_key || '/') collate "C" and l.run_key < (p_key || '0') collate "C";
	update public.qorpera_memory_run_logs l set run_path = left(e.path, -char_length('/run.toml')),
		run_key = left(e.key_text, -char_length('/run.toml')), toml_path_version = e.version, commit_id = p_commit_id,
		updated_at = clock_timestamp()
	from public.qorpera_folder_entries e
	where l.environment_id = p_environment_id and l.retired_at is null
		and l.run_key > (p_key || '/') collate "C" and l.run_key < (p_key || '0') collate "C"
		and e.environment_id = p_environment_id
		and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to
			|| substr(l.run_path || '/run.toml', char_length(p_eff_path) + 1)), 'sha256');
	get diagnostics v_moved = row_count;
	if v_moved <> v_rows then raise exception 'A moved run log has no run.toml in its commit' using errcode = 'XX000'; end if;
	select count(*) into v_rows from public.qorpera_memory_run_steps s
	where s.environment_id = p_environment_id
		and s.block_key > (p_key || '/') collate "C" and s.block_key < (p_key || '0') collate "C";
	update public.qorpera_memory_run_steps s set block_path = e.path, block_key = e.key_text, block_path_version = e.version,
		commit_id = p_commit_id, updated_at = clock_timestamp()
	from public.qorpera_folder_entries e
	where s.environment_id = p_environment_id
		and s.block_key > (p_key || '/') collate "C" and s.block_key < (p_key || '0') collate "C"
		and e.environment_id = p_environment_id
		and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to || substr(s.block_path, char_length(p_eff_path) + 1)),
			'sha256');
	get diagnostics v_moved = row_count;
	if v_moved <> v_rows then raise exception 'A moved run log block has no version in its commit' using errcode = 'XX000'; end if;
end $$;
revoke all on function public.qorpera_memory_run_log_moved(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;

-- A path deleted: every log at or under it retires, and its steps go. Its tree lines go with M1a's.
create function public.qorpera_memory_run_log_deleted(p_environment_id uuid, p_commit_id uuid, p_key text)
returns void language plpgsql security definer set search_path = '' as $$
-- 20260930231000 (W1b)
begin
	delete from public.qorpera_memory_run_steps s
	where s.environment_id = p_environment_id
		and (s.block_key = p_key or (s.block_key > (p_key || '/') collate "C" and s.block_key < (p_key || '0') collate "C"));
	update public.qorpera_memory_run_logs l set retired_at = clock_timestamp(), commit_id = p_commit_id, updated_at = clock_timestamp()
	where l.environment_id = p_environment_id and l.retired_at is null
		and (l.run_key = p_key or (l.run_key > (p_key || '/') collate "C" and l.run_key < (p_key || '0') collate "C"));
end $$;
revoke all on function public.qorpera_memory_run_log_deleted(uuid, uuid, text) from public, anon, authenticated, service_role;

-- The run log rows a unit writes or relies on, locked at rank 5 (env:run): the run whose folder it writes in, FOR SHARE
-- for its tree and FOR NO KEY UPDATE for the rest; every log at or under what it deletes or moves FOR NO KEY UPDATE.
create function public.qorpera_memory_run_log_targets(p_environment_id uuid, p_unit jsonb)
returns table(tbl text, key text, mode text) language plpgsql stable security definer set search_path = '' as $$
-- 20260930231000 (W1b)
declare v_op text := p_unit ->> 'op'; v_key text; v_folder text;
begin
	v_key := public.qorpera_folder_key(coalesce(p_unit ->> 'path', p_unit ->> 'from'));
	if v_key is null or v_key !~ '^agents(/|$)' then return; end if;
	if v_op in ('write','mkdir','new_folder') then
		v_folder := public.qorpera_memory_run_folder_key(v_key);
		if v_folder is not null then
			tbl := 'qorpera_memory_run_logs'; key := p_environment_id || ':' || right(v_folder, 36);
			mode := case when substr(v_key, char_length(v_folder) + 2) ~ '^t([0-9]|1[0-4])(/|$)' then 'share' else 'nokeyupdate' end;
			return next;
		end if;
	elsif v_op in ('delete','move') then
		return query select 'qorpera_memory_run_logs'::text, l.environment_id || ':' || l.run_id, 'nokeyupdate'::text
			from public.qorpera_memory_run_logs l
			where l.environment_id = p_environment_id and l.retired_at is null
				and (l.run_key = v_key or (l.run_key > (v_key || '/') collate "C" and l.run_key < (v_key || '0') collate "C"))
			order by l.run_id;
	end if;
end $$;
revoke all on function public.qorpera_memory_run_log_targets(uuid, jsonb) from public, anon, authenticated, service_role;

-- 7. The patches -------------------------------------------------------------------------------------------------------

create function pg_temp.w1b_run_logs_replace(p_function regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'W1b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- What a memory commit may do under a tree root: M1a's tree, and a run log's folders and files under runs/. Only the
-- platform deletes a log, whole (qorpera_memory_run_log_paths); a run tree's blocks are written and deleted as a tree's.
create or replace function public.qorpera_memory_tree_path_allowed(p_rel text, p_kind text, p_op text)
returns boolean language sql immutable set search_path = '' as $$
	-- 20260930231000 (W1b): a run log's paths.
	select case
		when p_rel = '' then p_kind = 'folder' and p_op in ('mkdir','new_folder')
		when p_rel = 'tree.toml' then p_kind = 'file' and p_op = 'write'
		when p_rel ~ '^t([0-9]|1[0-4])$' then p_kind = 'folder' and p_op in ('mkdir','new_folder')
		when p_rel ~ '^t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then p_kind = 'file' and p_op in ('write','delete')
		when p_rel = 'runs' then p_kind = 'folder' and p_op in ('mkdir','new_folder')
		when p_rel ~ '^runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			p_kind = 'folder' and p_op in ('mkdir','new_folder','delete')
		when p_rel ~ '^runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(log|t([0-9]|1[0-4]))$' then
			p_kind = 'folder' and p_op in ('mkdir','new_folder')
		when p_rel ~ '^runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/run\.toml$' then
			p_kind = 'file' and p_op = 'write'
		when p_rel ~ '^runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log/[0-9]{8}\.jsonl$' then
			p_kind = 'file' and p_op = 'write'
		when p_rel ~ '^runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then
			p_kind = 'file' and p_op in ('write','delete')
		else false
	end
$$;

-- The three kinds, in a group's tree and in an agent's thread's, after each one's blocks.
select pg_temp.w1b_run_logs_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$		when p_key ~ '^agents/groups/[^/]+/memory/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
$old$,
	$new$		when p_key ~ '^agents/groups/[^/]+/memory/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
		-- 20260930231000 (W1b): a group chat's run logs.
		when p_key ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/run\.toml$'
			then 'memory-run'
		when p_key ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log/[0-9]{8}\.jsonl$'
			then 'memory-steps'
		when p_key ~ '^agents/groups/[^/]+/memory/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$'
			then 'memory-run-block'
$new$);
select pg_temp.w1b_run_logs_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$		when p_key ~ '^agents/[^/]+/memory/thread/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
$old$,
	$new$		when p_key ~ '^agents/[^/]+/memory/thread/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
		-- 20260930231000 (W1b): an agent's thread's run logs.
		when p_key ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/run\.toml$'
			then 'memory-run'
		when p_key ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/log/[0-9]{8}\.jsonl$'
			then 'memory-steps'
		when p_key ~ '^agents/[^/]+/memory/thread/runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$'
			then 'memory-run-block'
$new$);

-- Run log files end in .toml and .jsonl too. Right after M1a's kinds, so later kinds (E8a's network rules) stay after.
select pg_temp.w1b_run_logs_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$'memory-tree','memory-block' /* 20260930111000 (M1a) */$old$,
	$new$'memory-tree','memory-block' /* 20260930111000 (M1a) */,
		'memory-run','memory-steps','memory-run-block' /* 20260930231000 (W1b) */$new$);

-- A copy out of a run log is a read, as out of a tree.
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$in ('memory-tree','memory-block')) then$old$,
	$new$in ('memory-tree','memory-block',
				'memory-run','memory-steps','memory-run-block' /* 20260930231000 (W1b) */)) then$new$,
	2);

-- The hook: run logs' paths for every unit, after the trees'; each run log file's own rules in the write loop.
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_rule := public.qorpera_memory_tree_paths(p_environment_id, v_op, v_key,
		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path, p_eff_to);
	if v_rule is not null then return v_rule; end if;
$old$,
	$new$	v_rule := public.qorpera_memory_tree_paths(p_environment_id, v_op, v_key,
		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path, p_eff_to);
	if v_rule is not null then return v_rule; end if;
	-- 20260930231000 (W1b): run logs' paths, for every unit of a memory commit.
	v_rule := public.qorpera_memory_run_log_paths(p_environment_id, p_actor, v_op, v_key, p_unit, p_eff_path);
	if v_rule is not null then return v_rule; end if;
$new$);
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			v_rule := public.qorpera_memory_tree_file_rules(p_environment_id, v_entries, v_file.key, v_checked ->> 'kind',
				v_checked -> 'parse', v_entries -> v_file.key ->> 'text');
			if v_rule is not null then return v_rule; end if;
$old$,
	$new$			v_rule := public.qorpera_memory_tree_file_rules(p_environment_id, v_entries, v_file.key, v_checked ->> 'kind',
				v_checked -> 'parse', v_entries -> v_file.key ->> 'text');
			if v_rule is not null then return v_rule; end if;
		-- 20260930231000 (W1b): a run log's run.toml, log blocks and tree blocks.
		elsif v_checked ->> 'kind' in ('memory-run','memory-steps','memory-run-block') then
			v_rule := public.qorpera_memory_run_log_file_rules(p_environment_id, v_entries, v_file.key, v_checked ->> 'kind',
				v_checked -> 'parse', v_entries -> v_file.key ->> 'text');
			if v_rule is not null then return v_rule; end if;
$new$);

-- Apply: log and run tree blocks after their unit's run.toml; the index on write, move and delete.
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$'memory-block' /* 20260930111000 (M1a) */), false) loop$old$,
	$new$'memory-block' /* 20260930111000 (M1a) */,
				'memory-steps','memory-run-block' /* 20260930231000 (W1b) */), false) loop$new$);
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				perform public.qorpera_memory_tree_index(p_environment_id, p_commit_id, v_file.path, v_file.key, v_version, v_kind,
					v_entry ->> 'text');
$old$,
	$new$				perform public.qorpera_memory_tree_index(p_environment_id, p_commit_id, v_file.path, v_file.key, v_version, v_kind,
					v_entry ->> 'text');
			-- 20260930231000 (W1b): a run log's run.toml, log block or tree block.
			elsif v_kind in ('memory-run','memory-steps','memory-run-block') then
				perform public.qorpera_memory_run_log_index(p_environment_id, p_commit_id, v_file.path, v_file.key, v_version, v_kind,
					v_entry ->> 'text');
$new$);
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		perform public.qorpera_memory_tree_moved(p_environment_id, p_commit_id, v_key, p_eff_path, p_eff_to);
$old$,
	$new$		perform public.qorpera_memory_tree_moved(p_environment_id, p_commit_id, v_key, p_eff_path, p_eff_to);
		-- 20260930231000 (W1b): run logs follow their files.
		perform public.qorpera_memory_run_log_moved(p_environment_id, p_commit_id, v_key, p_eff_path, p_eff_to);
$new$);
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		perform public.qorpera_memory_tree_deleted(p_environment_id, p_commit_id, v_key);
$old$,
	$new$		perform public.qorpera_memory_tree_deleted(p_environment_id, p_commit_id, v_key);
		-- 20260930231000 (W1b): a log's steps go with its folder, and the log retires.
		perform public.qorpera_memory_run_log_deleted(p_environment_id, p_commit_id, v_key);
$new$);

-- Verify: every run log and step this commit touched points at its live file.
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$		-- 20260930111000 (M1a): summary trees and their lines.
$old$,
	$new$		-- 20260930231000 (W1b): run logs and their steps.
		or exists (select 1 from public.qorpera_memory_run_logs l
			where l.environment_id = p_environment_id and l.commit_id = p_commit_id and l.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(l.run_key || '/run.toml', 'sha256') and e.version = l.toml_path_version
					and e.path = l.run_path || '/run.toml'))
		or exists (select 1 from public.qorpera_memory_run_steps s
			where s.environment_id = p_environment_id and s.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(s.block_key, 'sha256') and e.version = s.block_path_version
					and e.path = s.block_path))
		-- 20260930111000 (M1a): summary trees and their lines.
$new$);

-- Erasure (§8): the retired run log rows under its roots, as M1a's tree rows. A log row holds paths and a version; its
-- steps' rows went with their folder.
select pg_temp.w1b_run_logs_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		and public.qorpera_folder_erasure_covers(r ->> 'key', t.root_key)
		and public.qorpera_folder_erasure_row_before(r, t.commit_id, t.toml_path_version);
$old$,
	$new$		and public.qorpera_folder_erasure_covers(r ->> 'key', t.root_key)
		and public.qorpera_folder_erasure_row_before(r, t.commit_id, t.toml_path_version);
	-- 20260930231000 (W1b): the run log rows, retired, whose run.toml went before its erase root's cutoff.
	delete from public.qorpera_memory_run_logs l using jsonb_array_elements(v_roots) r
	where l.environment_id = p_environment_id and l.retired_at is not null
		and public.qorpera_folder_erasure_covers(r ->> 'key', l.run_key)
		and public.qorpera_folder_erasure_row_before(r, l.commit_id, l.toml_path_version);
$new$);

-- The commit: a memory request's run generation rows, after the hook's locks and before rank 10.
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	-- Rank 10: a run's released reads still hold (C1B-2 §3). A narrowing that commits after this is caught after the
$old$,
	$new$	-- 20260930231000 (W1b): a memory request's run generation rows (qorpera_memory_run_generations_lock).
	perform public.qorpera_memory_run_generations_lock(p_environment_id, p_operation_key);

	-- Rank 10: a run's released reads still hold (C1B-2 §3). A narrowing that commits after this is caught after the
$new$);
select pg_temp.w1b_run_logs_replace(
	'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if v_ok and v_actor_kind in ('member','run','view') then
$old$,
	$new$		-- 20260930231000 (W1b): not a memory commit's unit in its run's own log, which the run writes as itself (§4.3).
		if v_ok and v_actor_kind in ('member','run','view') and not (v_actor_kind = 'run'
			and public.qorpera_memory_run_log_admits(p_environment_id, p_operation_key, v_auth_actor, v_op, v_path, v_unit)) then
$new$);

-- The targets: the run log rows a unit writes in, deletes or moves, at rank 5, after the hooks.
select pg_temp.w1b_run_logs_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$	v_member uuid; v_h2 record; v_f2 record; v_p16 record; v_p15_session uuid;$old$,
	$new$	v_member uuid; v_h2 record; v_f2 record; v_p16 record; v_p15_session uuid; v_w1b record;$new$);
select pg_temp.w1b_run_logs_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$		-- 20260930016000 (P16): the table rows and the company index row a unit writes or relies on, at rank 5.$old$,
	$new$		-- 20260930231000 (W1b): the run logs a unit writes in (FOR SHARE in a run's tree, else FOR NO KEY UPDATE), and every
		-- log at or under what it deletes or moves (FOR NO KEY UPDATE).
		for v_w1b in select * from public.qorpera_memory_run_log_targets(p_environment_id, v_unit) loop
			rank := 5; tbl := v_w1b.tbl; key := v_w1b.key; mode := v_w1b.mode;
			return next;
		end loop;
		-- 20260930016000 (P16): the table rows and the company index row a unit writes or relies on, at rank 5.$new$);

-- The lock: run logs at rank 5, after the hooks, keyed 'environment_id:run_id'.
select pg_temp.w1b_run_logs_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$'qorpera_event_hooks' /* 20260930060000 (E1) */], t ->> 'tbl'),$old$,
	$new$'qorpera_event_hooks' /* 20260930060000 (E1) */,
			'qorpera_memory_run_logs' /* 20260930231000 (W1b) */], t ->> 'tbl'),$new$);
select pg_temp.w1b_run_logs_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$old$,
	$new$		elsif v_target.tbl = 'qorpera_memory_run_logs' then
			-- key: 'environment_id:run_id' (20260930231000, W1b).
			execute 'select 1 from public.qorpera_memory_run_logs where environment_id = $1 and run_id = $2' || v_clause
			using split_part(v_target.key, ':', 1)::uuid, split_part(v_target.key, ':', 2)::uuid;
		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$new$);

drop function pg_temp.w1b_run_logs_replace(regprocedure, text, text, integer);

-- 8. Native host calls ---------------------------------------------------------------------------------------------------

-- A run hashes its narrow steps' results and learns what makes its steps narrow while it holds its lease, finds where
-- its log goes, and writes its log through the memory commit as itself (a run actor names only its own run in its
-- request and writes only its own run's log, qorpera_memory_run_log_paths, and needs no grant there,
-- qorpera_memory_run_log_admits).
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_step_hashes', 'lease'),
	('qorpera_memory_step_narrow', 'lease'), ('qorpera_memory_run_log_place', 'run'), ('qorpera_folder_memory_commit', 'folder');

-- 9. The deploy guard ---------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_memory_run_folder_key(text)', 'public.qorpera_memory_run_toml(text)',
		'public.qorpera_memory_run_block_line(text)', 'public.qorpera_memory_run_block_parse(text,text)',
		'public.qorpera_memory_run_step_line(text)', 'public.qorpera_memory_run_step_needles(jsonb)',
		'public.qorpera_folder_path_every_agent(uuid,text)', 'public.qorpera_memory_run_machine_narrow(uuid,uuid)',
		'public.qorpera_run_log_narrow(uuid)', 'public.qorpera_memory_run_origin(uuid,uuid)',
		'public.qorpera_memory_conversation_root(uuid,uuid,uuid)', 'public.qorpera_memory_run_log_home(uuid,uuid)',
		'public.qorpera_memory_run_log_place(uuid,uuid)', 'public.qorpera_memory_step_hashes(uuid,uuid,uuid,jsonb)',
		'public.qorpera_memory_step_narrow(uuid,uuid,uuid,jsonb)', 'public.qorpera_memory_run_generations_lock(uuid,text)',
		'public.qorpera_folder_memory_preconditions_valid(uuid,jsonb)', 'public.qorpera_memory_generation_decide(uuid,uuid)',
		'public.qorpera_folder_memory_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)',
		'public.qorpera_memory_run_log_paths(uuid,jsonb,text,text,jsonb,text)',
		'public.qorpera_memory_run_log_admits(uuid,text,jsonb,text,text,jsonb)',
		'public.qorpera_memory_run_log_file_rules(uuid,jsonb,text,text,jsonb,text)',
		'public.qorpera_memory_run_log_index(uuid,uuid,text,text,uuid,text,text)',
		'public.qorpera_memory_run_log_moved(uuid,uuid,text,text,text)', 'public.qorpera_memory_run_log_deleted(uuid,uuid,text)',
		'public.qorpera_memory_run_log_targets(uuid,jsonb)', 'public.qorpera_memory_tree_path_allowed(text,text,text)',
		'public.qorpera_structured_path_kind(text)', 'public.qorpera_company_state_path_problems(text,boolean)',
		'public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)',
		'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)',
		'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)',
		'public.qorpera_folder_structured_verify(uuid,uuid)', 'public.qorpera_folder_erase(uuid,jsonb,jsonb,text)',
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)',
		'public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930231000') = 0 then
			raise exception 'W1b marker is missing in %', v_function; end if;
	end loop;
	if (select count(*) from public.qorpera_native_host_calls c where c.name in ('qorpera_memory_step_hashes',
		'qorpera_memory_step_narrow', 'qorpera_memory_run_log_place', 'qorpera_folder_memory_commit')) <> 4 then
		raise exception 'W1b host calls are missing'; end if;
end $guard$;
