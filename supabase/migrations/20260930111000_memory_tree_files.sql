-- Summary trees M1a, part 2 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.2-§4.4, §8): the tree files.
--
-- 1. Two structured kinds: a tree's tree.toml ('memory-tree') and its blocks t<tier>/<8 digits>.jsonl ('memory-block'),
--    under an agent's thread root agents/<agent>/memory/thread or a group chat's root agents/groups/<group>/memory.
-- 2. Platform-only paths (§4.3): outside qorpera_folder_memory_commit, nothing is written, moved or deleted at or under a
--    tree root, and agents/<agent>/memory itself never moves or goes alone (platform_only). A tree moves or goes only
--    with its owning folder. A copy out of a tree is a read and stays allowed. Inside the memory commit only tree.toml,
--    t<n> folders and block files are written, only block files deleted, and every tree.toml or t<n> unit names its
--    conversation's generation. The root itself is made without one: it holds no summary, and a run log's first batch
--    (§4.5, W1) makes it on the way to runs/.
-- 3. The checks: tree.toml names the owner's own conversation; a block's lines are closed, sized, in order and in their
--    block, and each level-0 line matches its event (seq, hash and message number).
-- 4. The index (§4.4): qorpera_memory_trees (one row per tree) and qorpera_memory_tree_nodes (one row per line), kept by
--    apply on write, move and delete, and checked by verify. A deleted block's rows are deleted with it.
-- 5. qorpera_memory_read_receipts, the zoom and read_context receipts erasure matches by target and range (§8, §10);
--    M1b fills it.
-- 6. P29: a tree file wakes nobody (§4.3).
-- Every patched body carries the marker 20260930111000 for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; part 1 comes first.
do $$ begin
	if to_regclass('public.qorpera_memory_trees') is not null then
		raise exception 'M1a (20260930111000) is already applied'; end if;
	if not exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_shared_sessions'::regclass
		and attname = 'memory_generation' and not attisdropped) then
		raise exception 'M1a (20260930111000) needs part 1 (20260930110000)'; end if;
end $$;

-- 1. The index ------------------------------------------------------------------------------------------------------

create table public.qorpera_memory_trees (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- The conversation (qorpera_shared_sessions.id). No foreign key: its KEY SHARE would come in apply, after the paths.
	session_id uuid not null,
	root_path text collate "C" not null,
	root_key text collate "C" not null,
	owner_kind text not null check (owner_kind in ('agent','group')),
	-- The staff agent's id, or the group chat's room id.
	owner_id uuid not null,
	node_bytes integer not null check (node_bytes between 1 and 1024),
	toml_path_version uuid not null,
	commit_id uuid not null,
	retired_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, session_id)
);
create unique index qorpera_memory_trees_root on public.qorpera_memory_trees(environment_id, root_key) where retired_at is null;
create index qorpera_memory_trees_commit on public.qorpera_memory_trees(commit_id);
alter table public.qorpera_memory_trees enable row level security;
revoke all on public.qorpera_memory_trees from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_trees to service_role;
comment on table public.qorpera_memory_trees is
	'Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §4.4): one row per tree.toml, an index of the company folder. A deleted '
	'root retires its row; a new tree.toml revives it.';

create table public.qorpera_memory_tree_nodes (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- Always the conversation, for a run log's lines too.
	session_id uuid not null,
	-- Null for a conversation's tree; a run log's run (W1).
	run_id uuid,
	l smallint not null check (l between 0 and 59),
	k bigint not null check (k >= 0),
	text text not null,
	bytes integer not null check (bytes between 0 and 2048 and bytes = octet_length(text)),
	free boolean not null,
	tries smallint check ((tries is null) = free and (tries is null or tries between 1 and 3)),
	seq bigint,
	event_hash text check (event_hash ~ '^[0-9a-f]{64}$'),
	block_path text collate "C" not null,
	block_key text collate "C" not null,
	block_path_version uuid not null,
	commit_id uuid not null,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, block_key, l, k),
	check (run_id is not null or ((l = 0) = (seq is not null) and (seq is null) = (event_hash is null)))
);
create unique index qorpera_memory_tree_nodes_session on public.qorpera_memory_tree_nodes(environment_id, session_id, l, k)
	where run_id is null;
create unique index qorpera_memory_tree_nodes_run on public.qorpera_memory_tree_nodes(environment_id, run_id, l, k)
	where run_id is not null;
create index qorpera_memory_tree_nodes_commit on public.qorpera_memory_tree_nodes(commit_id);
alter table public.qorpera_memory_tree_nodes enable row level security;
revoke all on public.qorpera_memory_tree_nodes from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_tree_nodes to service_role;
comment on table public.qorpera_memory_tree_nodes is
	'Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §4.4): one row per line of a block file, an index of the company folder. '
	'A rewritten block replaces its rows; a deleted one deletes them. An address with no row is missing.';

create table public.qorpera_memory_read_receipts (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	call_id text not null check (char_length(call_id) between 1 and 256),
	tool text not null check (tool in ('zoom','read_context')),
	operation_receipt_id uuid references public.qorpera_run_operation_receipts(id) on delete cascade,
	target_session_id uuid,
	target_run_id uuid,
	start bigint not null check (start >= 0),
	size bigint not null check (size >= 0),
	from_offset bigint not null default 0 check (from_offset >= 0),
	created_at timestamptz not null default clock_timestamp(),
	check ((target_session_id is null) <> (target_run_id is null)),
	unique (run_id, call_id)
);
create index qorpera_memory_read_receipts_session on public.qorpera_memory_read_receipts(environment_id, target_session_id, start)
	where target_session_id is not null;
create index qorpera_memory_read_receipts_run on public.qorpera_memory_read_receipts(environment_id, target_run_id, start)
	where target_run_id is not null;
create index qorpera_memory_read_receipts_receipt on public.qorpera_memory_read_receipts(operation_receipt_id);
alter table public.qorpera_memory_read_receipts enable row level security;
revoke all on public.qorpera_memory_read_receipts from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_read_receipts to service_role;
comment on table public.qorpera_memory_read_receipts is
	'Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §8, §10): what a zoom or read_context call read, by target and range '
	'(start, size, from), so an erase finds and scrubs it.';

-- The message number (§3) counts included events: one index serves the count and the level-0 check.
create index qorpera_session_events_memory on public.qorpera_session_events(session_id, sequence)
	where event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision');

-- 2. Helpers ----------------------------------------------------------------------------------------------------------

-- The event types a tree summarizes (§3: the history set of 20260923012000).
create function public.qorpera_memory_included_event(p_event_type text)
returns boolean language sql immutable set search_path = '' as $$
	select p_event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision')
$$;
revoke all on function public.qorpera_memory_included_event(text) from public, anon, authenticated, service_role;

-- The tree root at or above a key: agents/<agent>/memory/thread or agents/groups/<group>/memory; else null.
create function public.qorpera_memory_tree_root_key(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	select case
		when p_key ~ '^agents/groups/[^/]+/memory(/|$)' then substring(p_key from '^agents/groups/[^/]+/memory')
		when p_key ~ '^agents/groups(/|$)' then null
		when p_key ~ '^agents/[^/]+/memory/thread(/|$)' then substring(p_key from '^agents/[^/]+/memory/thread')
	end
$$;
revoke all on function public.qorpera_memory_tree_root_key(text) from public, anon, authenticated, service_role;

-- Whether a key is the platform's: at or under a tree root; for a move or a delete, also an agent's notebook folder
-- agents/<agent>/memory itself, which holds the thread's root.
create function public.qorpera_memory_platform_only_path(p_key text, p_move_or_delete boolean)
returns boolean language sql immutable set search_path = '' as $$
	select public.qorpera_memory_tree_root_key(p_key) is not null
		or (p_move_or_delete and p_key ~ '^agents/[^/]+/memory$' and p_key !~ '^agents/groups/')
$$;
revoke all on function public.qorpera_memory_platform_only_path(text, boolean) from public, anon, authenticated, service_role;

-- What a memory commit may do at a path relative to its root ('' is the root): make the root and t<n> folders, write
-- tree.toml, write and delete blocks. W1 adds a run log's paths.
create function public.qorpera_memory_tree_path_allowed(p_rel text, p_kind text, p_op text)
returns boolean language sql immutable set search_path = '' as $$
	select case
		when p_rel = '' then p_kind = 'folder' and p_op in ('mkdir','new_folder')
		when p_rel = 'tree.toml' then p_kind = 'file' and p_op = 'write'
		when p_rel ~ '^t([0-9]|1[0-4])$' then p_kind = 'folder' and p_op in ('mkdir','new_folder')
		when p_rel ~ '^t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then p_kind = 'file' and p_op in ('write','delete')
		else false
	end
$$;
revoke all on function public.qorpera_memory_tree_path_allowed(text, text, text) from public, anon, authenticated, service_role;

-- A message's number (§3): the 0-based rank of the event among the conversation's included events; null when the event
-- is missing or not included. An erased event keeps its row and type, so numbers never shift.
create function public.qorpera_memory_message_index(p_session_id uuid, p_sequence bigint)
returns bigint language sql stable set search_path = '' as $$
	select case when exists (select 1 from public.qorpera_session_events e where e.session_id = p_session_id
			and e.sequence = p_sequence
			and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision'))
		then (select count(*) from public.qorpera_session_events e where e.session_id = p_session_id and e.sequence < p_sequence
			and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision'))
	end
$$;
revoke all on function public.qorpera_memory_message_index(uuid, bigint) from public, anon, authenticated, service_role;

-- A root's owner, from its live index row (plain reads): the agent whose agent.md sits beside memory/, with its thread's
-- conversation (null before its first thread), or the group chat whose group.md sits beside memory/.
create function public.qorpera_memory_root_owner(p_environment_id uuid, p_root_key text)
returns table(owner_kind text, owner_id uuid, session_id uuid) language sql stable set search_path = '' as $$
	select 'agent'::text, s.staff_agent_id, r.session_id
	from public.qorpera_profile_staff s
	left join public.qorpera_company_rooms r on r.profile_id = s.profile_id and r.bound_staff_agent_id = s.staff_agent_id
	where p_root_key ~ '^agents/[^/]+/memory/thread$' and p_root_key !~ '^agents/groups/'
		and s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
		and public.qorpera_folder_key(s.folder_path) = regexp_replace(p_root_key, '/memory/thread$', '/agent.md')
	union all
	select 'group', r.id, r.session_id
	from public.qorpera_company_rooms r
	where p_root_key ~ '^agents/groups/[^/]+/memory$'
		and r.folder_environment_id = p_environment_id and r.folder_retired_at is null and r.folder_path is not null
		and public.qorpera_folder_key(r.folder_path) = regexp_replace(p_root_key, '/memory$', '/group.md')
	limit 1
$$;
revoke all on function public.qorpera_memory_root_owner(uuid, text) from public, anon, authenticated, service_role;

-- An owner's tree root key, from its live index row (plain reads): null when it has none or it is retired.
create function public.qorpera_memory_owner_root(p_environment_id uuid, p_owner_kind text, p_owner_id uuid)
returns text language sql stable set search_path = '' as $$
	select case p_owner_kind
		when 'agent' then (select regexp_replace(public.qorpera_folder_key(s.folder_path), '/agent\.md$', '/memory/thread')
			from public.qorpera_profile_staff s
			where s.staff_agent_id = p_owner_id and s.folder_environment_id = p_environment_id and s.folder_path is not null
				and s.folder_retired_at is null and s.deleted_at is null
			limit 1)
		when 'group' then (select regexp_replace(public.qorpera_folder_key(r.folder_path), '/group\.md$', '/memory')
			from public.qorpera_company_rooms r
			where r.id = p_owner_id and r.folder_environment_id = p_environment_id and r.folder_path is not null
				and r.folder_retired_at is null)
	end
$$;
revoke all on function public.qorpera_memory_owner_root(uuid, text, uuid) from public, anon, authenticated, service_role;

-- A conversation's live tree root path, as stored; null when it has none or it is retired.
create function public.qorpera_memory_session_tree_root(p_environment_id uuid, p_session_id uuid)
returns text language sql stable set search_path = '' as $$
	select t.root_path from public.qorpera_memory_trees t
	where t.environment_id = p_environment_id and t.session_id = p_session_id and t.retired_at is null
$$;
revoke all on function public.qorpera_memory_session_tree_root(uuid, uuid) from public, anon, authenticated, service_role;

-- tree.toml, exactly: format = 1, conversation = "<uuid>", node_bytes = 1 to 1024, one per line. Null otherwise.
create function public.qorpera_memory_tree_toml(p_text text)
returns jsonb language sql immutable set search_path = '' as $$
	select case when x.m is not null and x.m[2]::integer <= 1024
		then jsonb_build_object('conversation', x.m[1], 'nodeBytes', x.m[2]::integer) end
	from (select regexp_match(p_text, '^format = 1\nconversation = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\n'
		'node_bytes = ([1-9][0-9]{0,3})\n$') as m) x
$$;
revoke all on function public.qorpera_memory_tree_toml(text) from public, anon, authenticated, service_role;

-- One block line (§4.2), or null: a JSON object with closed keys and no duplicate; l and k (and seq, hash at level 0)
-- in range; tries 1 to 3 exactly when the line is not free; text without control characters, at most 2,048 bytes as
-- stored in the line (UTF-8, with " and \ escaped).
create function public.qorpera_memory_block_line(p_line text)
returns jsonb language plpgsql immutable set search_path = '' as $$
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
		from unnest(case when v_l = 0 then array['l','k','seq','hash','free','text'] else array['l','k','free','text'] end
			|| case when v_line -> 'free' = 'false'::jsonb then array['tries'] else '{}'::text[] end) k) then
		return null; end if;
	if jsonb_typeof(v_line -> 'k') is distinct from 'number' or (v_line -> 'k')::text !~ '^(0|[1-9][0-9]{0,18})$'
		or jsonb_typeof(v_line -> 'free') is distinct from 'boolean' or jsonb_typeof(v_line -> 'text') is distinct from 'string' then
		return null; end if;
	if (v_line ->> 'k')::numeric > 9223372036854775807 then return null; end if;
	if v_l = 0 and (jsonb_typeof(v_line -> 'seq') is distinct from 'number' or (v_line -> 'seq')::text !~ '^(0|[1-9][0-9]{0,18})$'
		or jsonb_typeof(v_line -> 'hash') is distinct from 'string' or (v_line ->> 'hash') !~ '^[0-9a-f]{64}$') then
		return null; end if;
	if v_l = 0 and (v_line ->> 'seq')::numeric > 9223372036854775807 then return null; end if;
	if v_line ? 'tries' and (jsonb_typeof(v_line -> 'tries') is distinct from 'number' or (v_line -> 'tries')::text !~ '^[1-3]$') then
		return null; end if;
	v_text := v_line ->> 'text';
	if v_text ~ '[\x01-\x1f\x7f-\x9f]' then return null; end if;
	if octet_length(v_text) + char_length(v_text) - char_length(replace(replace(v_text, '"', ''), '\', '')) > 2048 then
		return null; end if;
	return v_line;
end $$;
revoke all on function public.qorpera_memory_block_line(text) from public, anon, authenticated, service_role;

-- A block file (§4.2): {"lines": [...]} or {"problem", "line"}. Its name gives tier t and block b; it holds 1 to 30
-- lines, each ending in a newline, none empty, ordered by (l, k), each of levels 4t to 4t+3 and inside the block
-- (k >> (4t+4-l) = b), at most 2,212 bytes at level 0 and 2,113 above; at most 65,004 bytes in all.
create function public.qorpera_memory_block_parse(p_key text, p_text text)
returns jsonb language plpgsql immutable set search_path = '' as $$
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
		if octet_length(v_line) > 2212 then
			return jsonb_build_object('problem', 'this line is longer than a summary line can be', 'line', v_no); end if;
		v_parsed := public.qorpera_memory_block_line(v_line);
		if v_parsed is null then
			return jsonb_build_object('problem', 'this line is not a summary line', 'line', v_no); end if;
		v_l := (v_parsed ->> 'l')::integer; v_k := (v_parsed ->> 'k')::bigint;
		if octet_length(v_line) > (case when v_l = 0 then 2212 else 2113 end) then
			return jsonb_build_object('problem', 'this line is longer than a summary line can be', 'line', v_no); end if;
		if v_l < 4 * v_t or v_l > 4 * v_t + 3 or (v_k >> (4 * v_t + 4 - v_l)) <> v_b then
			return jsonb_build_object('problem', 'this line does not belong in this block', 'line', v_no); end if;
		if v_l < v_prev_l or (v_l = v_prev_l and v_k <= v_prev_k) then
			return jsonb_build_object('problem', 'the lines go by level, then by number, each once', 'line', v_no); end if;
		v_prev_l := v_l; v_prev_k := v_k;
		v_out := v_out || jsonb_build_array(v_parsed);
	end loop;
	return jsonb_build_object('lines', v_out);
end $$;
revoke all on function public.qorpera_memory_block_parse(text, text) from public, anon, authenticated, service_role;

-- 3. The refusals ------------------------------------------------------------------------------------------------------

-- The structured-file hook's tree check, for every unit (§4.3). Returns a refusal or null.
create function public.qorpera_memory_tree_paths(p_environment_id uuid, p_op text, p_key text, p_to_key text, p_unit jsonb,
	p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_request jsonb := public.qorpera_folder_memory_request(); v_touch record; v_root text; v_rel text; v_session uuid;
	v_platform_only constant jsonb := jsonb_build_object('ok', false, 'reason', 'platform_only', 'problems', jsonb_build_array(
		public.qorpera_company_state_problem('value', null, null, 'summary trees are written by the platform only')));
begin
	if v_request is null then
		if p_op in ('write','mkdir','new_folder') then
			if exists (select 1 from (select p_key as key union all
					select public.qorpera_folder_key(c.path) from public.qorpera_folder_spelled_contents(p_eff_path,
						case when p_op = 'new_folder' then p_unit -> 'contents' else '[]'::jsonb end) c) t
				where public.qorpera_memory_platform_only_path(t.key, false)) then
				return v_platform_only; end if;
		elsif p_op = 'delete' then
			if public.qorpera_memory_platform_only_path(p_key, true) then return v_platform_only; end if;
		elsif p_op = 'move' then
			-- A move counts by its source and its target, and by what it carries: a folder that holds a tree root may move
			-- only where each of its paths keeps the same place in a root of the same kind (an agent's rename, a group's).
			if public.qorpera_memory_platform_only_path(p_key, true) or public.qorpera_memory_platform_only_path(p_to_key, true) then
				return v_platform_only; end if;
			if (p_key ~ '^agents(/|$)' or p_to_key ~ '^agents(/|$)') and exists (select 1
				from public.qorpera_folder_entries e
				cross join lateral (select public.qorpera_memory_tree_root_key(e.key_text) as old_root,
					p_to_key || substr(e.key_text, char_length(p_key) + 1) as new_key) m
				cross join lateral (select public.qorpera_memory_tree_root_key(m.new_key) as new_root) n
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.key_text > (p_key || '/') collate "C" and e.key_text < (p_key || '0') collate "C"
					and (m.old_root is not null or n.new_root is not null)
					and (m.old_root is null or n.new_root is null
						or substr(e.key_text, char_length(m.old_root) + 1) <> substr(m.new_key, char_length(n.new_root) + 1))) then
				return v_platform_only; end if;
		elsif p_op = 'copy' then
			-- A copy out of a tree is a read; nothing is copied into one.
			if public.qorpera_memory_platform_only_path(p_to_key, false) then return v_platform_only; end if;
			if p_to_key ~ '^agents(/|$)' and exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.key_text > (p_key || '/') collate "C" and e.key_text < (p_key || '0') collate "C"
					and public.qorpera_memory_tree_root_key(p_to_key || substr(e.key_text, char_length(p_key) + 1)) is not null) then
				return v_platform_only; end if;
		end if;
		return null;
	end if;

	-- A memory commit: only a tree's own paths, each naming its conversation's generation.
	if p_op in ('move','copy') then
		return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
			public.qorpera_company_state_problem('value', null, null, 'a summary tree''s files are not moved or copied'))); end if;
	for v_touch in select p_key as key, p_eff_path as path, p_op as op,
			case when p_op = 'write' then 'file'
				when p_op = 'delete' then coalesce((select e.kind from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(p_key, 'sha256')
						and e.kind <> 'claim'), 'file')
				else 'folder' end as kind
		union all
		select public.qorpera_folder_key(c.path), c.path, case when c.kind = 'file' then 'write' else 'mkdir' end, c.kind
		from public.qorpera_folder_spelled_contents(p_eff_path,
			case when p_op = 'new_folder' then p_unit -> 'contents' else '[]'::jsonb end) c
	loop
		-- An agent's notebook folder may be made on the way to its thread's root.
		if v_touch.key = p_key and p_op in ('mkdir','new_folder') and p_key ~ '^agents/[^/]+/memory$'
			and p_key !~ '^agents/groups/' then continue; end if;
		v_root := public.qorpera_memory_tree_root_key(v_touch.key);
		if v_root is null then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a memory commit writes only summary trees'))); end if;
		v_rel := ltrim(substr(v_touch.key, char_length(v_root) + 1), '/');
		if not public.qorpera_memory_tree_path_allowed(v_rel, v_touch.kind, v_touch.op) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a summary tree holds only tree.toml and its blocks; only blocks are deleted'))); end if;
		if v_touch.op <> 'delete' and v_touch.path is distinct from v_touch.key then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('name', null, null, 'write the path in lowercase, as ' || left(v_touch.key, 100))));
		end if;
		-- The root holds no summary, so making it names no generation.
		if v_rel = 'tree.toml' or v_rel ~ '^t([0-9]|1[0-4])(/|$)' then
			v_session := coalesce((select t.session_id from public.qorpera_memory_trees t
				where t.environment_id = p_environment_id and t.root_key = v_root and t.retired_at is null),
				(select o.session_id from public.qorpera_memory_root_owner(p_environment_id, v_root) o));
			if v_session is null or not exists (select 1
				from jsonb_array_elements(coalesce(v_request -> 'preconditions' -> 'sessionGenerations', '[]'::jsonb)) g
				where g ->> 'sessionId' = v_session::text) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null,
						'a summary tree''s change names its conversation''s generation'))); end if;
		end if;
	end loop;
	return null;
end $$;
revoke all on function public.qorpera_memory_tree_paths(uuid, text, text, text, jsonb, text, text)
	from public, anon, authenticated, service_role;

-- A tree file's own rules, for each one a unit writes (§4.2): its parse is only its kind; tree.toml names the owner's
-- conversation, and no other tree holds either; a block belongs to a tree of that conversation, its lines parse, and
-- every level-0 line matches its event: seq, hash and message number. Returns a refusal or null.
create function public.qorpera_memory_tree_file_rules(p_environment_id uuid, p_entries jsonb, p_key text, p_kind text,
	p_parse jsonb, p_text text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_root text := public.qorpera_memory_tree_root_key(p_key); v_owner record; v_toml jsonb; v_block jsonb; v_problem text;
	v_min bigint; v_max bigint; v_base bigint;
begin
	if p_parse is distinct from jsonb_build_object('kind', p_kind) then
		return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
			public.qorpera_company_state_problem('front_matter', null, null, 'the platform could not read this file; save it again')));
	end if;
	select * into v_owner from public.qorpera_memory_root_owner(p_environment_id, v_root);
	if v_owner.session_id is null then
		v_problem := 'this tree''s agent or group chat has no conversation';
	elsif p_kind = 'memory-tree' then
		v_toml := public.qorpera_memory_tree_toml(p_text);
		if v_toml is null then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'tree.toml is format = 1, conversation = "<id>" and node_bytes = 1 to 1024, one per line'))); end if;
		if v_toml ->> 'conversation' is distinct from v_owner.session_id::text then
			v_problem := 'conversation is this tree''s own, ' || v_owner.session_id;
		elsif exists (select 1 from public.qorpera_memory_trees t where t.environment_id = p_environment_id
			and t.retired_at is null and (t.root_key = v_root) <> (t.session_id = v_owner.session_id)
			and (t.root_key = v_root or t.session_id = v_owner.session_id)) then
			v_problem := 'another tree holds this conversation or this place';
		end if;
	else
		if not exists (select 1 from public.qorpera_memory_trees t where t.environment_id = p_environment_id
				and t.root_key = v_root and t.session_id = v_owner.session_id and t.retired_at is null)
			and public.qorpera_memory_tree_toml(p_entries -> (v_root || '/tree.toml') ->> 'text') ->> 'conversation'
				is distinct from v_owner.session_id::text then
			v_problem := 'write this tree''s tree.toml first';
		else
			v_block := public.qorpera_memory_block_parse(p_key, p_text);
			if v_block ? 'problem' then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', (v_block ->> 'line')::integer, null, v_block ->> 'problem'))); end if;
			select min((x.value ->> 'seq')::bigint), max((x.value ->> 'seq')::bigint) into v_min, v_max
			from jsonb_array_elements(v_block -> 'lines') x where x.value ->> 'l' = '0';
			if v_min is not null then
				v_base := public.qorpera_memory_message_index(v_owner.session_id, v_min);
				if v_base is null or exists (select 1 from jsonb_array_elements(v_block -> 'lines') x
					where x.value ->> 'l' = '0' and not exists (select 1 from (
						select e.sequence, e.event_hash, v_base + row_number() over (order by e.sequence) - 1 as idx
						from public.qorpera_session_events e
						where e.session_id = v_owner.session_id and e.sequence between v_min and v_max
							and e.event_type in ('message','interaction_request','interaction_answer','authorization_request',
								'authorization_decision')
						order by e.sequence limit 16) w
						where w.sequence = (x.value ->> 'seq')::bigint and w.event_hash = x.value ->> 'hash'
							and w.idx = (x.value ->> 'k')::bigint)) then
					v_problem := 'a level-0 line does not match its message (seq, hash and number)';
				end if;
			end if;
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
		public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;
revoke all on function public.qorpera_memory_tree_file_rules(uuid, jsonb, text, text, jsonb, text)
	from public, anon, authenticated, service_role;

-- 4. The index in apply ------------------------------------------------------------------------------------------------

-- A tree file written: tree.toml upserts its tree's row (a retired one comes back); a block replaces its rows.
create function public.qorpera_memory_tree_index(p_environment_id uuid, p_commit_id uuid, p_path text, p_key text,
	p_version uuid, p_kind text, p_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_root text := public.qorpera_memory_tree_root_key(p_key); v_owner record; v_toml jsonb; v_session uuid; v_block jsonb;
begin
	if p_kind = 'memory-tree' then
		select * into v_owner from public.qorpera_memory_root_owner(p_environment_id, v_root);
		v_toml := public.qorpera_memory_tree_toml(p_text);
		insert into public.qorpera_memory_trees(environment_id, session_id, root_path, root_key, owner_kind, owner_id, node_bytes,
			toml_path_version, commit_id)
		values (p_environment_id, (v_toml ->> 'conversation')::uuid, left(p_path, -char_length('/tree.toml')), v_root,
			v_owner.owner_kind, v_owner.owner_id, (v_toml ->> 'nodeBytes')::integer, p_version, p_commit_id)
		on conflict (environment_id, session_id) do update set root_path = excluded.root_path, root_key = excluded.root_key,
			owner_kind = excluded.owner_kind, owner_id = excluded.owner_id, node_bytes = excluded.node_bytes,
			toml_path_version = excluded.toml_path_version, commit_id = excluded.commit_id, retired_at = null,
			updated_at = clock_timestamp();
		return;
	end if;
	select t.session_id into v_session from public.qorpera_memory_trees t
	where t.environment_id = p_environment_id and t.root_key = v_root and t.retired_at is null;
	if v_session is null then raise exception 'A summary tree''s block has no tree in its commit' using errcode = 'XX000'; end if;
	v_block := public.qorpera_memory_block_parse(p_key, p_text);
	if v_block ? 'problem' then raise exception 'A summary tree''s block does not parse in apply' using errcode = 'XX000'; end if;
	delete from public.qorpera_memory_tree_nodes n where n.environment_id = p_environment_id and n.block_key = p_key;
	insert into public.qorpera_memory_tree_nodes(environment_id, session_id, l, k, text, bytes, free, tries, seq, event_hash,
		block_path, block_key, block_path_version, commit_id)
	select p_environment_id, v_session, (x.value ->> 'l')::smallint, (x.value ->> 'k')::bigint, x.value ->> 'text',
		octet_length(x.value ->> 'text'), (x.value ->> 'free')::boolean, (x.value ->> 'tries')::smallint,
		(x.value ->> 'seq')::bigint, x.value ->> 'hash', p_path, p_key, p_version, p_commit_id
	from jsonb_array_elements(v_block -> 'lines') x;
end $$;
revoke all on function public.qorpera_memory_tree_index(uuid, uuid, text, text, uuid, text, text)
	from public, anon, authenticated, service_role;

-- A folder moved with trees in it (an agent's or a group's rename): each tree and line follows its file, to the version
-- the move made.
create function public.qorpera_memory_tree_moved(p_environment_id uuid, p_commit_id uuid, p_key text, p_eff_path text,
	p_eff_to text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_rows bigint; v_moved bigint;
begin
	select count(*) into v_rows from public.qorpera_memory_trees t
	where t.environment_id = p_environment_id and t.retired_at is null
		and t.root_key > (p_key || '/') collate "C" and t.root_key < (p_key || '0') collate "C";
	update public.qorpera_memory_trees t set root_path = left(e.path, -char_length('/tree.toml')),
		root_key = left(e.key_text, -char_length('/tree.toml')), toml_path_version = e.version, commit_id = p_commit_id,
		updated_at = clock_timestamp()
	from public.qorpera_folder_entries e
	where t.environment_id = p_environment_id and t.retired_at is null
		and t.root_key > (p_key || '/') collate "C" and t.root_key < (p_key || '0') collate "C"
		and e.environment_id = p_environment_id
		and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to
			|| substr(t.root_path || '/tree.toml', char_length(p_eff_path) + 1)), 'sha256');
	get diagnostics v_moved = row_count;
	if v_moved <> v_rows then raise exception 'A moved summary tree has no tree.toml in its commit' using errcode = 'XX000'; end if;
	select count(*) into v_rows from public.qorpera_memory_tree_nodes n
	where n.environment_id = p_environment_id
		and n.block_key > (p_key || '/') collate "C" and n.block_key < (p_key || '0') collate "C";
	update public.qorpera_memory_tree_nodes n set block_path = e.path, block_key = e.key_text, block_path_version = e.version,
		commit_id = p_commit_id, updated_at = clock_timestamp()
	from public.qorpera_folder_entries e
	where n.environment_id = p_environment_id
		and n.block_key > (p_key || '/') collate "C" and n.block_key < (p_key || '0') collate "C"
		and e.environment_id = p_environment_id
		and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to || substr(n.block_path, char_length(p_eff_path) + 1)),
			'sha256');
	get diagnostics v_moved = row_count;
	if v_moved <> v_rows then raise exception 'A moved summary block has no version in its commit' using errcode = 'XX000'; end if;
end $$;
revoke all on function public.qorpera_memory_tree_moved(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;

-- A path deleted: the lines of every block at or under it go, and every tree at or under it retires.
create function public.qorpera_memory_tree_deleted(p_environment_id uuid, p_commit_id uuid, p_key text)
returns void language plpgsql security definer set search_path = '' as $$
begin
	delete from public.qorpera_memory_tree_nodes n
	where n.environment_id = p_environment_id
		and (n.block_key = p_key or (n.block_key > (p_key || '/') collate "C" and n.block_key < (p_key || '0') collate "C"));
	update public.qorpera_memory_trees t set retired_at = clock_timestamp(), commit_id = p_commit_id, updated_at = clock_timestamp()
	where t.environment_id = p_environment_id and t.retired_at is null
		and (t.root_key = p_key or (t.root_key > (p_key || '/') collate "C" and t.root_key < (p_key || '0') collate "C"));
end $$;
revoke all on function public.qorpera_memory_tree_deleted(uuid, uuid, text) from public, anon, authenticated, service_role;

-- 5. The patches -------------------------------------------------------------------------------------------------------

create function pg_temp.m1a_tree_files_replace(p_function regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'M1a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The two kinds: a group's before agents/groups' null, an agent's thread after agent.md.
select pg_temp.m1a_tree_files_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$		when p_key ~ '^agents/(groups|sections\.md)(/|$)' then null
$old$,
	$new$		-- 20260930111000 (M1a): a group chat's summary tree.
		when p_key ~ '^agents/groups/[^/]+/memory/tree\.toml$' then 'memory-tree'
		when p_key ~ '^agents/groups/[^/]+/memory/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
		when p_key ~ '^agents/(groups|sections\.md)(/|$)' then null
$new$);
select pg_temp.m1a_tree_files_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$		when p_key ~ '^agents/[^/]+/agent\.md$' then 'agent'
$old$,
	$new$		when p_key ~ '^agents/[^/]+/agent\.md$' then 'agent'
		-- 20260930111000 (M1a): an agent's thread's summary tree.
		when p_key ~ '^agents/[^/]+/memory/thread/tree\.toml$' then 'memory-tree'
		when p_key ~ '^agents/[^/]+/memory/thread/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$' then 'memory-block'
$new$);

-- Tree files end in .toml and .jsonl; their paths are still lowercase.
select pg_temp.m1a_tree_files_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$	if not p_folder and v_kind not in ('vision','sections','interface','interface-order','table','table-rows') -- 20260930016000 (P16)
$old$,
	$new$	if not p_folder and v_kind not in ('vision','sections','interface','interface-order','table','table-rows', -- 20260930016000 (P16)
		'memory-tree','memory-block' /* 20260930111000 (M1a) */)
$new$);

-- A copy out of a tree is a read: its files become ordinary files (a copy onto a structured path is still refused).
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$		if public.qorpera_structured_path_kind(p_from_key) is distinct from public.qorpera_structured_path_kind(v_to_key) then
			return jsonb_build_object('ok', false, 'reason', 'kind_change'); end if;
$old$,
	$new$		if public.qorpera_structured_path_kind(p_from_key) is distinct from public.qorpera_structured_path_kind(v_to_key)
			-- 20260930111000 (M1a): a copy out of a summary tree.
			and not (p_op = 'copy' and public.qorpera_structured_path_kind(p_from_key) in ('memory-tree','memory-block')) then
			return jsonb_build_object('ok', false, 'reason', 'kind_change'); end if;
$new$);
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$			if public.qorpera_structured_path_kind(v_entry.key_text)
				is distinct from public.qorpera_structured_path_kind(public.qorpera_folder_key(v_new_path)) then
$old$,
	$new$			if public.qorpera_structured_path_kind(v_entry.key_text)
				is distinct from public.qorpera_structured_path_kind(public.qorpera_folder_key(v_new_path))
				-- 20260930111000 (M1a): a copy out of a summary tree.
				and not (p_op = 'copy' and public.qorpera_structured_path_kind(v_entry.key_text) in ('memory-tree','memory-block')) then
$new$);

-- The hook: tree paths for every unit, after the generations; each tree file's own rules in the write loop.
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_rule := public.qorpera_memory_generation_decide(p_environment_id, p_commit_id);
	if v_rule is not null then return v_rule; end if;
$old$,
	$new$	v_rule := public.qorpera_memory_generation_decide(p_environment_id, p_commit_id);
	if v_rule is not null then return v_rule; end if;
	-- 20260930111000 (M1a): summary trees' paths, for every unit.
	v_rule := public.qorpera_memory_tree_paths(p_environment_id, v_op, v_key,
		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path, p_eff_to);
	if v_rule is not null then return v_rule; end if;
$new$);
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			v_rule := public.qorpera_company_state_worker_rules(p_environment_id, v_profile, p_actor, p_commit_id, v_file.key,
				v_checked -> 'parse', v_file.file);
			if v_rule is not null then return v_rule; end if;
		end if;
$old$,
	$new$			v_rule := public.qorpera_company_state_worker_rules(p_environment_id, v_profile, p_actor, p_commit_id, v_file.key,
				v_checked -> 'parse', v_file.file);
			if v_rule is not null then return v_rule; end if;
		-- 20260930111000 (M1a): a summary tree's tree.toml and blocks.
		elsif v_checked ->> 'kind' in ('memory-tree','memory-block') then
			v_rule := public.qorpera_memory_tree_file_rules(p_environment_id, v_entries, v_file.key, v_checked ->> 'kind',
				v_checked -> 'parse', v_entries -> v_file.key ->> 'text');
			if v_rule is not null then return v_rule; end if;
		end if;
$new$);

-- Apply: blocks after their unit's tree.toml; the index on write, move and delete.
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			order by coalesce(public.qorpera_structured_path_kind(f.key) in ('todo','routine','table-rows' /* P16 */), false) loop
$old$,
	$new$			order by coalesce(public.qorpera_structured_path_kind(f.key) in ('todo','routine','table-rows' /* P16 */,
				'memory-block' /* 20260930111000 (M1a) */), false) loop
$new$);
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			elsif v_kind in ('worker-brief','worker-results') then
				perform public.qorpera_company_state_index_worker(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
$old$,
	$new$			elsif v_kind in ('worker-brief','worker-results') then
				perform public.qorpera_company_state_index_worker(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			-- 20260930111000 (M1a): a summary tree's tree.toml or block.
			elsif v_kind in ('memory-tree','memory-block') then
				perform public.qorpera_memory_tree_index(p_environment_id, p_commit_id, v_file.path, v_file.key, v_version, v_kind,
					v_entry ->> 'text');
$new$);
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		if v_h2_moved <> v_h2_rows then raise exception 'A moved hook file has no version in its commit' using errcode = 'XX000'; end if;
$old$,
	$new$		if v_h2_moved <> v_h2_rows then raise exception 'A moved hook file has no version in its commit' using errcode = 'XX000'; end if;
		-- 20260930111000 (M1a): summary trees follow their files.
		perform public.qorpera_memory_tree_moved(p_environment_id, p_commit_id, v_key, p_eff_path, p_eff_to);
$new$);
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- A rule file removed: the rule is archived (review records keep citing it); a restore brings it back.
$old$,
	$new$		-- 20260930111000 (M1a): a block's lines go with it; a tree whose root goes retires.
		perform public.qorpera_memory_tree_deleted(p_environment_id, p_commit_id, v_key);
		-- A rule file removed: the rule is archived (review records keep citing it); a restore brings it back.
$new$);

-- Verify: every tree and line this commit touched points at its live file.
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$		-- 20260930060000 (E1): hook and mailbox rows.
$old$,
	$new$		-- 20260930111000 (M1a): summary trees and their lines.
		or exists (select 1 from public.qorpera_memory_trees t
			where t.environment_id = p_environment_id and t.commit_id = p_commit_id and t.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(t.root_key || '/tree.toml', 'sha256') and e.version = t.toml_path_version
					and e.path = t.root_path || '/tree.toml'))
		or exists (select 1 from public.qorpera_memory_tree_nodes n
			where n.environment_id = p_environment_id and n.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(n.block_key, 'sha256') and e.version = n.block_path_version
					and e.path = n.block_path))
		-- 20260930060000 (E1): hook and mailbox rows.
$new$);

-- P29: a tree file wakes nobody.
select pg_temp.m1a_tree_files_replace(
	'public.qorpera_folder_listener_matches(uuid,uuid,jsonb,uuid,text,text)'::regprocedure,
	$old$where v.commit_id = p_commit_id$old$,
	$new$where v.commit_id = p_commit_id
				and public.qorpera_memory_tree_root_key(public.qorpera_folder_key(v.path)) is null /* 20260930111000 (M1a) */$new$,
	3);
