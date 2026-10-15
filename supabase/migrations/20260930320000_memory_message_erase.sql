-- Erasing one message (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10, M3): an owner or admin erases event i of
-- conversation C, and every line built from it goes with it. A line's sources follow from its address alone (§4.1), so
-- the blocks to delete do too, at most two per tier.
--
-- 1. qorpera_memory_message_erases, one row per event while it is not done, with the blocks step 1 deleted or found by
--    key alone (_blocks) and the runs whose receipts step 4 scrubs (_runs). The request writes it; the memory eraser of
--    the runtime carries it on through the steps below, each of which takes the row, checks its state and moves it on.
-- 2. Step 1 (qorpera_memory_message_erase_open): one memory commit, attributed to the member who asked. Under the
--    owner's index row (rank 2 or 4) and C's session row FOR UPDATE, its hook blanks the event and its input to
--    {"erased": true} (the event's hash is kept), raises C's memory_generation, checks that the commit deletes every
--    live candidate block and the message's images, keeps the other lines of each, and records the blocks with
--    history under C's earlier roots, which it finds by the 1,024 tree.toml manifests C's id allows. Read receipts
--    whose range holds i are read in a later statement, and their runs go to the run table.
-- 3. Step 2 (qorpera_memory_message_erase_rewrite): a second memory commit at the row's generation writes each deleted
--    block again with the lines kept, merged by position with any the next run wrote first, at the same place under
--    the owner's current root. A retired owner, or a later erase (memory_generation_stale), moves the row on instead.
-- 4. Step 3 (qorpera_memory_message_erase_ask): one block-history request per call (20260930120000), with the delete's
--    position as its cutoff, or none for a block found by key alone; the copies P18 names are kept on the row.
-- 5. Step 4 (qorpera_memory_message_erase_scrub): each ended run's linked receipts get P18's scrub (§6 there). W1's
--    step scrub (§10.1) comes with W1d.
-- 6. The readers: a parent entry id, a context source and a history line treat an erased body as opaque.
--
-- The runtime's memory eraser drives the steps (qorpera_memory_message_erase_due). Every patched body carries the marker
-- 20260930320000 (M3) for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regprocedure('public.qorpera_memory_message_erase_request(uuid,uuid,uuid,uuid)') is not null then
		raise exception 'Memory message erase (20260930320000) is already applied'; end if;
end $$;

create function pg_temp.m3_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Memory message erase anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The rows ----------------------------------------------------------------------------------------------------------

-- State: pending → open (step 1) → rewritten (step 2) → requested (step 3) → done (step 4 and P18's versions phase).
-- refused: the member lost the owner or admin role before step 1 landed.
create table public.qorpera_memory_message_erases (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	profile_id uuid not null,
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	event_id uuid not null,
	sequence bigint not null check (sequence >= 1),
	message_index bigint not null check (message_index >= 0),
	input_id uuid,
	client_input_id uuid,
	requested_by_user_id uuid not null,
	state text not null default 'pending' check (state in ('pending','open','rewritten','requested','done','refused')),
	generation bigint,
	owner_kind text check (owner_kind in ('agent','group')),
	owner_id uuid,
	root_key text collate "C",
	commit_id uuid,
	rewrite_commit_id uuid,
	last_error text,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	done_at timestamptz,
	check (state in ('pending','refused') or generation is not null or done_at is not null)
);
create unique index qorpera_memory_message_erases_event on public.qorpera_memory_message_erases(environment_id, event_id)
	where state not in ('done','refused');
create index qorpera_memory_message_erases_due on public.qorpera_memory_message_erases(updated_at)
	where state not in ('done','refused');
-- A conversation's open erases: a later erase's step 1 clears their kept lines.
create index qorpera_memory_message_erases_open on public.qorpera_memory_message_erases(session_id) where state = 'open';

-- One row per block: deleted by step 1 (its cutoff the delete's position, its kept lines {l, k, line}), or found by
-- key alone (no cutoff). kind 'images' is the message's images folder, asked like a block found by key alone.
create table public.qorpera_memory_message_erase_blocks (
	erase_id uuid not null references public.qorpera_memory_message_erases(id) on delete cascade,
	block_key text collate "C" not null,
	path text not null,
	kind text not null check (kind in ('block','images')),
	cutoff_seq bigint,
	cutoff_unit integer,
	keep jsonb,
	erasure_id uuid,
	accepted_at timestamptz,
	copies jsonb,
	primary key (erase_id, block_key),
	check ((cutoff_seq is null) = (cutoff_unit is null)),
	check (kind = 'block' or (cutoff_seq is null and keep is null))
);

-- The runs whose read receipts may hold i's text, scrubbed once each has ended (step 4).
create table public.qorpera_memory_message_erase_runs (
	erase_id uuid not null references public.qorpera_memory_message_erases(id) on delete cascade,
	run_id uuid not null,
	read_receipt_ids uuid[] not null default '{}',
	state text not null default 'pending' check (state in ('pending','done')),
	scrubbed_at timestamptz,
	primary key (erase_id, run_id)
);

alter table public.qorpera_memory_message_erases enable row level security;
alter table public.qorpera_memory_message_erase_blocks enable row level security;
alter table public.qorpera_memory_message_erase_runs enable row level security;
revoke all on public.qorpera_memory_message_erases, public.qorpera_memory_message_erase_blocks,
	public.qorpera_memory_message_erase_runs from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_message_erases, public.qorpera_memory_message_erase_blocks,
	public.qorpera_memory_message_erase_runs to service_role;

comment on table public.qorpera_memory_message_erases is
	'Message erases (RUNTIME-AGENT-MEMORY-TREE.md §10): one row per erased message, its four steps from pending to done. '
	'A second request for the message joins it.';
comment on table public.qorpera_memory_message_erase_blocks is
	'Message erases (RUNTIME-AGENT-MEMORY-TREE.md §10): each block whose history step 3 asks P18 to erase, with the lines '
	'step 2 writes back and the erasure that took it.';
comment on table public.qorpera_memory_message_erase_runs is
	'Message erases (RUNTIME-AGENT-MEMORY-TREE.md §10): each run that read the message, the receipts step 4 scrubs once '
	'it has ended.';

-- 2. Helpers (plain reads) ----------------------------------------------------------------------------------------------

-- An erased event's entry id is its event id, which its entry id was (§10 step 1): a later entry still names it as its
-- parent.
create function public.qorpera_memory_entry_id(p_body jsonb, p_event_id uuid)
returns text language sql immutable set search_path = '' as $$
	select case when p_body = '{"erased":true}'::jsonb then p_event_id::text else p_body #>> '{entry,id}' end
$$;

-- Message i is a source of node(l, k) exactly when w(k·2^l) ≤ i < (k+1)·2^l, w(s) = max(0, 16·⌊s/16⌋ − 16) (§4.1, §10).
create function public.qorpera_memory_erase_drops(p_index bigint, p_l integer, p_k bigint)
returns boolean language sql immutable set search_path = '' as $$
	select (p_index >> p_l) <= p_k and p_k <= ((16 * (p_index / 16) + 31) >> p_l)
$$;

-- The blocks under a root that can hold such a node: in tier t (levels 4t to 4t+3), from i's own block to the one
-- holding 16·⌊i/16⌋ + 31, so at most two per tier.
create function public.qorpera_memory_erase_candidates(p_root text, p_index bigint)
returns table (block_key text, rel text) language sql immutable set search_path = '' as $$
	select p_root || '/' || r.rel, r.rel
	from generate_series(0, 14) t
	cross join lateral generate_series(p_index >> (4 * t + 4), (16 * (p_index / 16) + 31) >> (4 * t + 4)) b
	cross join lateral (select 't' || t || '/' || lpad(b::text, 8, '0') || '.jsonl' as rel) r
	where p_root is not null and b <= 99999999
$$;

-- A node as its block line (§4.2).
create function public.qorpera_memory_erase_line(p_node public.qorpera_memory_tree_nodes)
returns text language sql immutable set search_path = '' as $$
	select '{"l":' || p_node.l || ',"k":' || p_node.k
		|| case when p_node.l = 0 then ',"seq":' || p_node.seq || ',"hash":"' || p_node.event_hash || '"' else '' end
		|| ',"free":' || case when p_node.free then 'true' else 'false' end || ',"text":' || to_json(p_node.text)::text
		|| case when not p_node.free then ',"tries":' || p_node.tries else '' end || '}'
$$;

-- Step 1's deletes: each live candidate block under the root, and the message's images folder, at their versions.
create function public.qorpera_memory_erase_deletes(p_environment_id uuid, p_root text, p_index bigint, p_client_input_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('op', 'delete', 'path', e.path, 'expectedVersion', e.version)
			|| case when e.kind = 'folder' then jsonb_build_object('asOfSeq', (select c.last_seq from public.qorpera_folder_clocks c
				where c.environment_id = p_environment_id)) else '{}'::jsonb end
		order by k.key collate "C"), '[]'::jsonb)
	from (select c.block_key as key, 'file' as kind from public.qorpera_memory_erase_candidates(p_root, p_index) c
		union all select p_root || '/images/' || p_client_input_id::text, 'folder' where p_client_input_id is not null) k
	join public.qorpera_folder_entries e on e.environment_id = p_environment_id
		and e.key_sha256 = extensions.digest(k.key, 'sha256') and e.kind = k.kind
	where p_root is not null
$$;

-- C's tree.toml is one of 1,024 byte strings (§4.2), which the platform writes as application/toml, one chunk, no
-- executable bit: so one of 1,024 manifests, whichever bundle wrote it (§10 step 1).
create function public.qorpera_memory_erase_toml_manifests(p_session_id uuid)
returns table (manifest_sha256 text) language sql immutable set search_path = '' as $$
	select encode(extensions.digest(convert_to(format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,'
			|| '"mediaType":"application/toml","executable":false,"chunks":[{"sha256":"%s","bytes":%s}]}',
			f.sha, f.bytes, f.sha, f.bytes), 'utf8'), 'sha256'), 'hex')
	from generate_series(1, 1024) n
	cross join lateral (select format(E'format = 1\nconversation = "%s"\nnode_bytes = %s\n', p_session_id, n) as text) t
	cross join lateral (select encode(extensions.digest(convert_to(t.text, 'utf8'), 'sha256'), 'hex') as sha,
		octet_length(convert_to(t.text, 'utf8')) as bytes) f
$$;

-- Every tree root that ever held C's tree.toml, by the manifest index of path versions, live or not.
create function public.qorpera_memory_erase_roots(p_environment_id uuid, p_session_id uuid)
returns table (root_key text) language sql stable set search_path = '' as $$
	select distinct regexp_replace(k.key, '/tree\.toml$', '') collate "C"
	from public.qorpera_memory_erase_toml_manifests(p_session_id) m
	join public.qorpera_folder_path_versions v on v.environment_id = p_environment_id and v.manifest_sha256 = m.manifest_sha256
	cross join lateral (select public.qorpera_folder_key(v.path) as key) k
	where k.key ~ '^agents/groups/[^/]+/memory/tree\.toml$'
		or (k.key ~ '^agents/[^/]+/memory/thread/tree\.toml$' and k.key !~ '^agents/groups/')
$$;

-- The read receipts whose result may hold message i of C, in the whole company (§10 step 4): a zoom of i's own line,
-- or of a line whose children have i among their sources (start+size overlaps [i, 16·⌊i/16⌋ + 32)), and a
-- read_context page whose range holds i.
create function public.qorpera_memory_erase_receipts(p_environment_id uuid, p_session_id uuid, p_index bigint)
returns table (run_id uuid, receipt_id uuid) language sql stable set search_path = '' as $$
	select r.run_id, r.id from public.qorpera_memory_read_receipts r
	where r.environment_id = p_environment_id and r.target_session_id = p_session_id
		and r.start < 16 * (p_index / 16) + 32
		and case when r.tool = 'zoom' then (r.size = 1 and r.start = p_index) or (r.size > 1 and r.start + r.size > p_index)
			else r.start <= p_index and r.start + greatest(r.size, 1) > p_index end
$$;

-- 3. Step 1 in the commit ---------------------------------------------------------------------------------------------

-- The erase's own request for one memory commit, set by step 1 or 2 around it (a memory request's preconditions hold
-- generations only): {environmentId, operationKey, eraseId, step 'open' or 'rewrite', profileId, userId, ownerKind,
-- ownerId, sessionId, root, generation, planSha}. It answers only inside that memory commit.
create function public.qorpera_memory_message_erase_context(p_environment_id uuid, p_operation_key text)
returns jsonb language sql stable set search_path = '' as $$
	select c.v from (select nullif(current_setting('qorpera.memory_message_erase', true), '')::jsonb as v) c
	where c.v ->> 'environmentId' = p_environment_id::text and c.v ->> 'operationKey' = p_operation_key
		and public.qorpera_folder_memory_request() ->> 'operationKey' = p_operation_key
$$;

-- Its locks (core §3): the member who asked at rank 1 (step 1), C's owner's index row FOR SHARE at its rank (2 or 4),
-- and C's session row at the session step, FOR UPDATE for step 1, which writes it, FOR SHARE for step 2.
create function public.qorpera_memory_message_erase_lock_targets(p_context jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select coalesce(jsonb_agg(t.target), '[]'::jsonb)
	from (select p_context as c) x
	cross join lateral (
		select jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', (x.c ->> 'profileId') || ':' || (x.c ->> 'userId'),
			'mode', 'keyshare', 'required', false) as target
		where x.c ->> 'step' = 'open'
		union all
		select case when x.c ->> 'ownerKind' = 'agent' then jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
				'key', (x.c ->> 'profileId') || ':' || (x.c ->> 'ownerId'), 'mode', 'share', 'required', false)
			else jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', x.c ->> 'ownerId', 'mode', 'share',
				'required', false) end
		where x.c ->> 'ownerId' is not null
		union all
		select jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', x.c ->> 'sessionId',
			'mode', case when x.c ->> 'step' = 'open' then 'update' else 'share' end, 'required', true)) t
	where x.c is not null
$$;

create function public.qorpera_memory_message_erase_targets(p_environment_id uuid, p_operation_key text)
returns jsonb language sql stable set search_path = '' as $$
	select public.qorpera_memory_message_erase_lock_targets(
		public.qorpera_memory_message_erase_context(p_environment_id, p_operation_key))
$$;

-- Step 1 under the locks: the row, taken after the session row, must be pending; QME01 rolls the try back and the
-- caller tries again, QME02 refuses the erase, QME04 (the event erased already) ends it done.
create function public.qorpera_memory_message_erase_step1(p_context jsonb, p_units jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
	v_env uuid := (p_context ->> 'environmentId')::uuid;
	v_row public.qorpera_memory_message_erases%rowtype;
	v_role public.qorpera_profile_role;
	v_root text;
begin
	select * into v_row from public.qorpera_memory_message_erases where id = (p_context ->> 'eraseId')::uuid for update;
	if not found or v_row.state <> 'pending' or v_row.environment_id <> v_env then
		raise exception 'The erase moved on' using errcode = 'QME01'; end if;
	-- The event erased already, under the session's lock: a request that read it before the first erase's step 1 and wrote
	-- its row once that erase was done. Nothing is left to erase; QME04 rolls the try back and the caller ends the row.
	if exists (select 1 from public.qorpera_session_events where session_id = v_row.session_id and sequence = v_row.sequence
		and event_id = v_row.event_id and body = '{"erased":true}'::jsonb) then
		raise exception 'The event is erased already' using errcode = 'QME04'; end if;
	-- The role, under the member row's lock, as P18 checks it (ERASURE.md §3).
	select role into v_role from public.qorpera_profile_members
	where profile_id = v_row.profile_id and user_id = v_row.requested_by_user_id;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'Only owners and admins erase' using errcode = 'QME02'; end if;
	-- C's tree root, read again from the owner's row under its lock: a rename or a delete landed first or waits.
	v_root := public.qorpera_memory_owner_root(v_env, p_context ->> 'ownerKind', (p_context ->> 'ownerId')::uuid);
	if v_root is distinct from p_context ->> 'root' then
		raise exception 'The tree root moved' using errcode = 'QME01'; end if;
	-- The session row is held FOR UPDATE: the generation goes up by one, and the event's body is blanked, its hash kept.
	update public.qorpera_shared_sessions set memory_generation = memory_generation + 1
	where id = v_row.session_id and memory_generation = (p_context ->> 'generation')::bigint - 1;
	if not found then raise exception 'The generation moved' using errcode = 'QME01'; end if;
	-- An earlier erase still open is stale now: its rewrite never writes, and its kept lines (this event's among them) go.
	update public.qorpera_memory_message_erase_blocks b set keep = null
	from public.qorpera_memory_message_erases e
	where e.id = b.erase_id and e.session_id = v_row.session_id and e.state = 'open' and e.id <> v_row.id and b.keep is not null;
	update public.qorpera_session_events set body = '{"erased":true}'::jsonb
	where session_id = v_row.session_id and sequence = v_row.sequence and event_id = v_row.event_id
		and body <> '{"erased":true}'::jsonb;
	if not found then raise exception 'The event moved' using errcode = 'QME01'; end if;
	-- A member's message: its input, at the turn-input step.
	if v_row.input_id is not null then
		perform 1 from public.qorpera_session_inputs where id = v_row.input_id for update;
		update public.qorpera_session_inputs set body = '{"erased":true}'::jsonb where id = v_row.input_id;
	end if;
	-- The commit deletes each live candidate block and the images folder at its version, and nothing else.
	if (select coalesce(jsonb_agg(jsonb_build_array(u ->> 'op', public.qorpera_folder_key(u ->> 'path'), u ->> 'expectedVersion')
			order by public.qorpera_folder_key(u ->> 'path') collate "C"), '[]'::jsonb) from jsonb_array_elements(p_units) u)
		is distinct from (select coalesce(jsonb_agg(jsonb_build_array(u ->> 'op', public.qorpera_folder_key(u ->> 'path'),
			u ->> 'expectedVersion') order by public.qorpera_folder_key(u ->> 'path') collate "C"), '[]'::jsonb)
		from jsonb_array_elements(public.qorpera_memory_erase_deletes(v_env, v_root, v_row.message_index, v_row.client_input_id)) u) then
		raise exception 'The blocks changed' using errcode = 'QME01'; end if;
	-- Each deleted block with its other lines, read before the delete takes them from the index (step 2 writes them).
	insert into public.qorpera_memory_message_erase_blocks(erase_id, block_key, path, kind, keep)
	select v_row.id, k.key, u ->> 'path', case when k.key = v_root || '/images/' || v_row.client_input_id::text then 'images' else 'block' end,
		case when k.key <> v_root || '/images/' || coalesce(v_row.client_input_id::text, '') then (
			select coalesce(jsonb_agg(jsonb_build_object('l', n.l, 'k', n.k, 'line', public.qorpera_memory_erase_line(n))
				order by n.l, n.k), '[]'::jsonb)
			from public.qorpera_memory_tree_nodes n
			where n.environment_id = v_env and n.block_key = k.key and n.run_id is null and n.session_id = v_row.session_id
				and not public.qorpera_memory_erase_drops(v_row.message_index, n.l, n.k)) end
	from jsonb_array_elements(p_units) u
	cross join lateral (select public.qorpera_folder_key(u ->> 'path') as key) k;
	-- By key alone (step 3 asks them with no cutoff): each candidate block, and the images folder, with versions but not
	-- live under the current root, and each with versions under an earlier root of C, live or not.
	insert into public.qorpera_memory_message_erase_blocks(erase_id, block_key, path, kind)
	select v_row.id, c.key, (select v.path from public.qorpera_folder_path_versions v
			where v.environment_id = v_env and v.key_sha256 = extensions.digest(c.key, 'sha256') order by v.created_at desc limit 1),
		c.kind
	from (select r.root_key from public.qorpera_memory_erase_roots(v_env, v_row.session_id) r
		union select v_root where v_root is not null) r
	cross join lateral (select b.block_key as key, 'block' as kind from public.qorpera_memory_erase_candidates(r.root_key, v_row.message_index) b
		union all select r.root_key || '/images/' || v_row.client_input_id::text, 'images' where v_row.client_input_id is not null) c
	where exists (select 1 from public.qorpera_folder_path_versions v
		where v.environment_id = v_env and v.key_sha256 = extensions.digest(c.key, 'sha256'))
	on conflict (erase_id, block_key) do nothing;
	-- The receipts, in a later statement than the session's lock (§8): a zoom that stored its receipt first is found,
	-- and one that waited reads what this commit leaves.
	insert into public.qorpera_memory_message_erase_runs(erase_id, run_id, read_receipt_ids)
	select v_row.id, r.run_id, array_agg(r.receipt_id order by r.receipt_id)
	from public.qorpera_memory_erase_receipts(v_env, v_row.session_id, v_row.message_index) r
	group by r.run_id;
	update public.qorpera_memory_message_erases set state = 'open', generation = (p_context ->> 'generation')::bigint,
		owner_kind = p_context ->> 'ownerKind', owner_id = (p_context ->> 'ownerId')::uuid, root_key = v_root,
		last_error = null, updated_at = clock_timestamp()
	where id = v_row.id;
end $$;

-- The structured-file hook, after the session step (anchor below): step 1's work, or step 2's check of its plan.
create function public.qorpera_memory_message_erase_hook(p_environment_id uuid, p_operation_key text, p_units jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_context jsonb := public.qorpera_memory_message_erase_context(p_environment_id, p_operation_key);
	v_row public.qorpera_memory_message_erases%rowtype;
begin
	if v_context is null then return; end if;
	if v_context ->> 'step' = 'open' then
		perform public.qorpera_memory_message_erase_step1(v_context, p_units);
		return;
	end if;
	-- Step 2: the row is still open, C's current root (read again under the owner's lock; a rename moves the rewrite
	-- with it) is the one planned, and so is the plan, the lines kept merged with the blocks' live lines at their versions.
	select * into v_row from public.qorpera_memory_message_erases where id = (v_context ->> 'eraseId')::uuid for update;
	if not found or v_row.state <> 'open' or v_row.environment_id <> p_environment_id then
		raise exception 'The erase moved on' using errcode = 'QME01'; end if;
	if public.qorpera_memory_owner_root(p_environment_id, v_row.owner_kind, v_row.owner_id) is distinct from v_context ->> 'root' then
		raise exception 'The tree root moved' using errcode = 'QME01'; end if;
	if encode(extensions.digest(convert_to(public.qorpera_memory_message_erase_rewrite_plan(p_environment_id, v_row.id)::text,
			'utf8'), 'sha256'), 'hex') is distinct from v_context ->> 'planSha' then
		raise exception 'The rewrite plan changed' using errcode = 'QME01'; end if;
end $$;

select pg_temp.m3_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	E'\t-- 20260930110000 (M1a): a memory commit''s generations (rank 11, FOR SHARE).\n'
	|| E'\tv_targets := v_targets || public.qorpera_folder_memory_targets(p_environment_id, p_operation_key);\n',
	E'\t-- 20260930110000 (M1a): a memory commit''s generations (rank 11, FOR SHARE).\n'
	|| E'\tv_targets := v_targets || public.qorpera_folder_memory_targets(p_environment_id, p_operation_key);\n'
	|| E'\t-- 20260930320000 (M3): a message erase''s member, C''s owner row and C''s session row.\n'
	|| E'\tv_targets := v_targets || public.qorpera_memory_message_erase_targets(p_environment_id, p_operation_key);\n');
select pg_temp.m3_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	E'\t-- Rank 11: the sessions the apply step writes (the hook''s), FOR UPDATE in id order (C1C §5.6).\n'
	|| E'\tperform public.qorpera_folder_lock_sessions(p_environment_id, v_targets);\n',
	E'\t-- Rank 11: the sessions the apply step writes (the hook''s), FOR UPDATE in id order (C1C §5.6).\n'
	|| E'\tperform public.qorpera_folder_lock_sessions(p_environment_id, v_targets);\n'
	|| E'\t-- 20260930320000 (M3): a message erase''s step 1, or its rewrite''s check, under the session row.\n'
	|| E'\tperform public.qorpera_memory_message_erase_hook(p_environment_id, p_operation_key, p_units);\n');

-- 4. Readers of an erased event ---------------------------------------------------------------------------------------

-- An erased event keeps its place in the transcript: its entry id (its event id) still parents the next entry, and the
-- run context reads its text as (erased). Room posts never erase, so their readers stay as they are.
select pg_temp.m3_replace('public.qorpera_append_admitted_input_events(uuid,uuid[])'::regprocedure,
	E'\tselect event.sequence, event.event_hash, event.body #>> ''{entry,id}''\n',
	E'\t-- 20260930320000 (M3): an erased event keeps its entry id, its event id.\n'
	|| E'\tselect event.sequence, event.event_hash, public.qorpera_memory_entry_id(event.body, event.event_id)\n');
select pg_temp.m3_replace('public.qorpera_append_runner_transcript_event(uuid,text,uuid,text,uuid,uuid,text,jsonb,bigint)'::regprocedure,
	E'\t\t\t\tand parent.body #>> ''{entry,id}'' = p_body #>> ''{entry,parentId}''\n',
	E'\t\t\t\t-- 20260930320000 (M3): an erased parent keeps its entry id, its event id.\n'
	|| E'\t\t\t\tand public.qorpera_memory_entry_id(parent.body, parent.event_id) = p_body #>> ''{entry,parentId}''\n');
select pg_temp.m3_replace('public.qorpera_folder_append_transcript_event(public.qorpera_execution_runs,uuid,uuid,text,jsonb)'::regprocedure,
	E'\t\t\twhere parent.session_id = v_session.id and parent.body #>> ''{entry,id}'' = p_body #>> ''{entry,parentId}'')\n',
	E'\t\t\t-- 20260930320000 (M3): an erased parent keeps its entry id, its event id.\n'
	|| E'\t\t\twhere parent.session_id = v_session.id\n'
	|| E'\t\t\t\tand public.qorpera_memory_entry_id(parent.body, parent.event_id) = p_body #>> ''{entry,parentId}'')\n');
select pg_temp.m3_replace(f::regprocedure,
	E'\t\tselect event.body #>> ''{entry,id}'' into v_parent from public.qorpera_session_events as event\n',
	E'\t\t-- 20260930320000 (M3): an erased event keeps its entry id, its event id.\n'
	|| E'\t\tselect public.qorpera_memory_entry_id(event.body, event.event_id) into v_parent\n'
	|| E'\t\tfrom public.qorpera_session_events as event\n')
from unnest(array['public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)',
	'public.qorpera_record_action_review(jsonb,jsonb)']) f;
select pg_temp.m3_replace(f::regprocedure,
	E'\tselect coalesce(event.body #>> ''{entry,id}'', event.body ->> ''entryId'') into v_parent_id\n',
	E'\t-- 20260930320000 (M3): an erased event keeps its entry id, its event id.\n'
	|| E'\tselect coalesce(public.qorpera_memory_entry_id(event.body, event.event_id), event.body ->> ''entryId'') into v_parent_id\n')
from unnest(array['public.qorpera_folder_send_agent_message(jsonb,text,text,text)',
	'public.qorpera_send_runner_agent_message(uuid,text,uuid,text,uuid,text,text,text)']) f;
select pg_temp.m3_replace('public.qorpera_folder_send_agent_message(jsonb,text,text,text)'::regprocedure,
	E'\twhere event.session_id = v_run.session_id and ((event.body #>> ''{entry,id}'') is not null\n',
	E'\twhere event.session_id = v_run.session_id and (public.qorpera_memory_entry_id(event.body, event.event_id) is not null\n');
select pg_temp.m3_replace('public.qorpera_send_runner_agent_message(uuid,text,uuid,text,uuid,text,text,text)'::regprocedure,
	E'\t\t(event.body #>> ''{entry,id}'') is not null or\n',
	E'\t\tpublic.qorpera_memory_entry_id(event.body, event.event_id) is not null or\n');
select pg_temp.m3_replace('public.qorpera_folder_send_coworker_message(jsonb,uuid,text,text,boolean)'::regprocedure,
	E'\t\tselect event.body #>> ''{entry,id}'' into v_parent_entry from public.qorpera_session_events event\n'
	|| E'\t\twhere event.session_id = v_pair and event.body #>> ''{entry,id}'' is not null order by event.sequence desc limit 1;\n',
	E'\t\t-- 20260930320000 (M3): an erased event keeps its entry id, its event id.\n'
	|| E'\t\tselect public.qorpera_memory_entry_id(event.body, event.event_id) into v_parent_entry\n'
	|| E'\t\tfrom public.qorpera_session_events event where event.session_id = v_pair\n'
	|| E'\t\t\tand public.qorpera_memory_entry_id(event.body, event.event_id) is not null order by event.sequence desc limit 1;\n');
select pg_temp.m3_replace('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure,
	E'\t\t\tcase when jsonb_typeof(v_input.body -> ''text'') = ''string'' then v_input.body ->> ''text'' else v_input.body::text end);\n',
	E'\t\t\t-- 20260930320000 (M3): an erased message reads (erased).\n'
	|| E'\t\t\tcase when v_input.body = ''{"erased":true}''::jsonb then ''(erased)''\n'
	|| E'\t\t\t\twhen jsonb_typeof(v_input.body -> ''text'') = ''string'' then v_input.body ->> ''text'' else v_input.body::text end);\n');
select pg_temp.m3_replace('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure,
	E'\t\tv_text := v_event.body::text;\n',
	E'\t\t-- 20260930320000 (M3): an erased event reads (erased).\n'
	|| E'\t\tv_text := case when v_event.body = ''{"erased":true}''::jsonb then ''(erased)'' else v_event.body::text end;\n');

-- 5. The request, its status and the eraser's queue -------------------------------------------------------------------

create function public.qorpera_memory_message_erase_reply(p_erase_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_object('schema', 'qorpera.memory-message-erase/v1', 'eraseId', e.id, 'state', e.state,
		'sessionId', e.session_id, 'eventId', e.event_id,
		'blocks', (select count(*) from public.qorpera_memory_message_erase_blocks b where b.erase_id = e.id),
		'runsPending', (select count(*) from public.qorpera_memory_message_erase_runs r where r.erase_id = e.id and r.state = 'pending'))
	from public.qorpera_memory_message_erases e where e.id = p_erase_id
$$;

-- An owner or admin asks to erase one event of a room's conversation. A second request for the same event joins the
-- first; a request for an event already erased gets that erase. One that read the event before the first erase's step 1
-- and wrote its row once that erase was done ends done at its own step 1 (QME04).
create function public.qorpera_memory_message_erase_request(p_environment_id uuid, p_user_id uuid, p_session_id uuid,
	p_event_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_event public.qorpera_session_events%rowtype;
	v_id uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_environment_id is null or p_user_id is null or p_session_id is null or p_event_id is null then
		raise exception 'Memory message erase request is invalid' using errcode = '22023'; end if;
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id and environment_id = p_environment_id;
	if not found or not public.qorpera_environment_is_folder_v2(p_environment_id) or not exists (select 1
		from public.qorpera_company_rooms r where r.session_id = v_session.id and r.profile_id = v_session.profile_id) then
		raise exception 'Conversation not found' using errcode = 'P0002'; end if;
	-- Owners and admins erase (§10); step 1 checks again under the member's row.
	if not exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_session.profile_id
		and m.user_id = p_user_id and m.role in ('owner','admin')) then
		raise exception 'Only owners and admins erase' using errcode = '42501'; end if;
	select * into v_event from public.qorpera_session_events where session_id = v_session.id and event_id = p_event_id
		and event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision');
	if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
	insert into public.qorpera_memory_message_erases(environment_id, profile_id, session_id, event_id, sequence, message_index,
		input_id, client_input_id, requested_by_user_id)
	select p_environment_id, v_session.profile_id, v_session.id, v_event.event_id, v_event.sequence,
		public.qorpera_memory_message_index(v_session.id, v_event.sequence), i.id, i.client_input_id, p_user_id
	from (select 1) x
	left join public.qorpera_session_inputs i on i.id = v_event.session_input_id and i.session_id = v_session.id
	where v_event.body <> '{"erased":true}'::jsonb
	on conflict (environment_id, event_id) where state not in ('done','refused') do nothing
	returning id into v_id;
	if v_id is null then
		select e.id into v_id from public.qorpera_memory_message_erases e
		where e.environment_id = p_environment_id and e.event_id = p_event_id
		order by e.state not in ('done','refused') desc, e.state = 'done' desc, e.created_at desc limit 1;
	end if;
	if v_id is null then raise exception 'Message not found' using errcode = 'P0002'; end if;
	return public.qorpera_memory_message_erase_reply(v_id);
end $$;

-- Where an erase stands, for an owner or admin of its company.
create function public.qorpera_memory_message_erase_status(p_environment_id uuid, p_user_id uuid, p_erase_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_memory_message_erases e
		join public.qorpera_profile_members m on m.profile_id = e.profile_id and m.user_id = p_user_id and m.role in ('owner','admin')
		where e.id = p_erase_id and e.environment_id = p_environment_id) then
		raise exception 'Erase not found' using errcode = 'P0002'; end if;
	return public.qorpera_memory_message_erase_reply(p_erase_id);
end $$;

-- The memory eraser's queue: each erase not yet done, the longest waiting first. The state names its next step.
create function public.qorpera_memory_message_erase_due(p_limit integer)
returns table (environment_id uuid, erase_id uuid, state text)
language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 1000 then
		raise exception 'Memory message erase limit is invalid' using errcode = '22023'; end if;
	return query select e.environment_id, e.id, e.state from public.qorpera_memory_message_erases e
		where e.state not in ('done','refused') order by e.updated_at, e.id limit p_limit;
end $$;

-- 6. Step 1 -----------------------------------------------------------------------------------------------------------

-- One memory commit deletes the live candidate blocks and the images folder; its hook does the rest under the locks.
-- A try whose plain reads moved (QME01) rolls back and runs again with fresh ones; after three the eraser comes back.
create function public.qorpera_memory_message_erase_open(p_environment_id uuid, p_erase_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_row public.qorpera_memory_message_erases%rowtype;
	v_room public.qorpera_company_rooms%rowtype;
	v_context jsonb;
	v_units jsonb;
	v_key text;
	v_result jsonb;
	v_try integer := 0;
	v_error text;
	v_detail text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_row from public.qorpera_memory_message_erases where id = p_erase_id and environment_id = p_environment_id;
	if not found then raise exception 'Erase not found' using errcode = 'P0002'; end if;
	if v_row.state <> 'pending' then return public.qorpera_memory_message_erase_reply(v_row.id); end if;
	loop
		v_try := v_try + 1;
		v_result := null;
		-- Plain reads; the hook reads each again under its lock. C's owner: the agent the room is bound to, else the room.
		select * into v_room from public.qorpera_company_rooms r
		where r.session_id = v_row.session_id and r.profile_id = v_row.profile_id order by r.id limit 1;
		v_key := 'memerase:' || v_row.id::text || ':' || extensions.gen_random_uuid()::text;
		v_context := jsonb_build_object('environmentId', p_environment_id::text, 'operationKey', v_key,
			'eraseId', v_row.id::text, 'step', 'open', 'profileId', v_row.profile_id::text,
			'userId', v_row.requested_by_user_id::text,
			'ownerKind', case when v_room.bound_staff_agent_id is not null then 'agent' else 'group' end,
			'ownerId', coalesce(v_room.bound_staff_agent_id, v_room.id)::text, 'sessionId', v_row.session_id::text,
			'generation', (select s.memory_generation + 1 from public.qorpera_shared_sessions s where s.id = v_row.session_id));
		v_context := v_context || jsonb_build_object('root', public.qorpera_memory_owner_root(p_environment_id,
			v_context ->> 'ownerKind', (v_context ->> 'ownerId')::uuid));
		v_units := public.qorpera_memory_erase_deletes(p_environment_id, v_context ->> 'root', v_row.message_index,
			v_row.client_input_id);
		begin
			perform set_config('qorpera.memory_message_erase', v_context::text, true);
			if jsonb_array_length(v_units) > 0 then
				v_result := public.qorpera_folder_memory_commit(p_environment_id, '{"kind":"platform"}'::jsonb, v_key, v_units,
					jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object(
						'sessionId', v_row.session_id, 'generation', (v_context ->> 'generation')::bigint))));
				-- A refusal is an outcome, not an error: anything short of every unit saved rolls the try back.
				if jsonb_typeof(v_result -> 'units') is distinct from 'array' or exists (select 1
					from jsonb_array_elements(v_result -> 'units') u where u.value ->> 'outcome' is distinct from 'saved') then
					raise exception 'The erase commit was not saved' using errcode = 'QME01', detail = v_result::text; end if;
			else
				-- Nothing live to delete: the same step under the same locks, with no commit.
				perform public.qorpera_folder_company_enter(p_environment_id, v_row.profile_id,
					(select coalesce(jsonb_agg(t.value), '[]'::jsonb)
					from jsonb_array_elements(public.qorpera_memory_message_erase_lock_targets(v_context)) t
					where (t.value ->> 'rank')::integer between 1 and 7), false);
				perform 1 from public.qorpera_shared_sessions where id = v_row.session_id for update;
				perform public.qorpera_memory_message_erase_step1(v_context, '[]'::jsonb);
			end if;
			if not exists (select 1 from public.qorpera_memory_message_erases where id = v_row.id and state = 'open') then
				raise exception 'The erase did not open' using errcode = 'QME01'; end if;
			perform set_config('qorpera.memory_message_erase', '', true);
			exit;
		exception
			when sqlstate 'QME01' then
				get stacked diagnostics v_error = message_text, v_detail = pg_exception_detail;
				if v_try >= 3 then
					update public.qorpera_memory_message_erases
					set last_error = left(v_error || coalesce(': ' || nullif(v_detail, ''), ''), 4000), updated_at = clock_timestamp()
					where id = v_row.id;
					return public.qorpera_memory_message_erase_reply(v_row.id);
				end if;
			when sqlstate 'QME02' then
				get stacked diagnostics v_error = message_text;
				update public.qorpera_memory_message_erases set state = 'refused', last_error = v_error, updated_at = clock_timestamp()
				where id = v_row.id;
				return public.qorpera_memory_message_erase_reply(v_row.id);
			-- The first erase of the event did the work: this row is done, with no commit and the generation as it was.
			when sqlstate 'QME04' then
				update public.qorpera_memory_message_erases
				set state = 'done', last_error = null, done_at = clock_timestamp(), updated_at = clock_timestamp()
				where id = v_row.id and state = 'pending';
				return public.qorpera_memory_message_erase_reply(v_row.id);
		end;
	end loop;
	-- Each block step 1 deleted gets the delete's position, the cutoff of its history (step 3).
	update public.qorpera_memory_message_erase_blocks b set cutoff_seq = c.seq, cutoff_unit = v.unit_no
	from public.qorpera_folder_commits c
	join public.qorpera_folder_path_versions v on v.commit_id = c.id and v.op = 'delete'
	where c.id = (v_result ->> 'commitId')::uuid and b.erase_id = v_row.id and b.kind = 'block' and b.keep is not null
		and v.environment_id = p_environment_id and v.key_sha256 = extensions.digest(b.block_key, 'sha256');
	-- The commit is the member's: the platform made it on their word.
	update public.qorpera_folder_commits set requester_kind = 'member', requester_id = v_row.requested_by_user_id
	where id = (v_result ->> 'commitId')::uuid;
	update public.qorpera_memory_message_erases set commit_id = (v_result ->> 'commitId')::uuid, updated_at = clock_timestamp()
	where id = v_row.id;
	return public.qorpera_memory_message_erase_reply(v_row.id);
end $$;

-- 7. Step 2 -----------------------------------------------------------------------------------------------------------

-- The rewrite: each block step 1 deleted with a kept line not live again, at the same place under C's current root, its
-- kept lines merged by position with the live lines the next run wrote there first (a live line wins). Each item is
-- {path, text, fileSha256, bytes, expectedVersion (null: the block is not there)}, by key; none when the owner is retired,
-- and none unless the row is open at the session's generation (a later erase or step 2's end cleared its kept lines).
create function public.qorpera_memory_message_erase_rewrite_plan(p_environment_id uuid, p_erase_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('path', p.key, 'text', p.text,
		'fileSha256', encode(extensions.digest(convert_to(p.text, 'utf8'), 'sha256'), 'hex'),
		'bytes', octet_length(convert_to(p.text, 'utf8')),
		'expectedVersion', (select f.version from public.qorpera_folder_entries f where f.environment_id = p_environment_id
			and f.key_sha256 = extensions.digest(p.key, 'sha256') and f.kind = 'file'))
		order by p.key collate "C"), '[]'::jsonb)
	from public.qorpera_memory_message_erases e
	cross join lateral (select public.qorpera_memory_owner_root(p_environment_id, e.owner_kind, e.owner_id) as root) r
	join public.qorpera_memory_message_erase_blocks b on b.erase_id = e.id and b.kind = 'block' and b.keep is not null
	cross join lateral (select r.root || substr(b.block_key, char_length(e.root_key) + 1) as key) k
	cross join lateral (select k.key, (select string_agg(m.line, E'\n' order by m.l, m.k) || E'\n' from (
			select (x.value ->> 'l')::integer as l, (x.value ->> 'k')::bigint as k, x.value ->> 'line' as line
			from jsonb_array_elements(b.keep) x
			where not exists (select 1 from public.qorpera_memory_tree_nodes n
				where n.environment_id = p_environment_id and n.block_key = k.key and n.run_id is null
					and n.session_id = e.session_id and n.l = (x.value ->> 'l')::integer and n.k = (x.value ->> 'k')::bigint)
			union all
			select n.l, n.k, public.qorpera_memory_erase_line(n) from public.qorpera_memory_tree_nodes n
			where n.environment_id = p_environment_id and n.block_key = k.key and n.run_id is null
				and n.session_id = e.session_id) m) as text) p
	where e.id = p_erase_id and e.environment_id = p_environment_id and r.root is not null and e.root_key is not null
		and e.state = 'open'
		and e.generation = (select s.memory_generation from public.qorpera_shared_sessions s where s.id = e.session_id)
		and exists (select 1 from jsonb_array_elements(b.keep) x
			where not exists (select 1 from public.qorpera_memory_tree_nodes n
				where n.environment_id = p_environment_id and n.block_key = k.key and n.run_id is null
					and n.session_id = e.session_id and n.l = (x.value ->> 'l')::integer and n.k = (x.value ->> 'k')::bigint))
$$;

-- The plan for the eraser to stage: it stages each text, then calls the rewrite with the plan's hash.
create function public.qorpera_memory_message_erase_plan(p_environment_id uuid, p_erase_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_plan jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_memory_message_erases where id = p_erase_id and environment_id = p_environment_id) then
		raise exception 'Erase not found' using errcode = 'P0002'; end if;
	v_plan := public.qorpera_memory_message_erase_rewrite_plan(p_environment_id, p_erase_id);
	return jsonb_build_object('schema', 'qorpera.memory-message-erase-plan/v1', 'eraseId', p_erase_id,
		'planSha256', encode(extensions.digest(convert_to(v_plan::text, 'utf8'), 'sha256'), 'hex'), 'blocks', v_plan);
end $$;

-- The row's move to step 3, its rewrite written or skipped: the kept lines go with it, so no later plan writes them.
create function public.qorpera_memory_message_erase_rewritten(p_erase_id uuid, p_commit_id uuid, p_error text)
returns jsonb language plpgsql volatile set search_path = '' as $$
begin
	update public.qorpera_memory_message_erase_blocks set keep = null where erase_id = p_erase_id and keep is not null;
	update public.qorpera_memory_message_erases
	set state = 'rewritten', rewrite_commit_id = p_commit_id, last_error = p_error, updated_at = clock_timestamp()
	where id = p_erase_id;
	return public.qorpera_memory_message_erase_reply(p_erase_id);
end $$;

-- Step 2: one memory commit at the row's generation writes the plan's blocks, each from its staged file, the plan
-- checked again by the hook under the owner's and the session's locks. A plan that moved is planned again; a later
-- erase (memory_generation_stale) or a retired owner moves the row on with nothing written.
create function public.qorpera_memory_message_erase_rewrite(p_environment_id uuid, p_erase_id uuid, p_plan_sha256 text,
	p_files jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_row public.qorpera_memory_message_erases%rowtype;
	v_plan jsonb;
	v_root text;
	v_units jsonb;
	v_key text;
	v_result jsonb;
	v_error text;
	v_detail text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_row from public.qorpera_memory_message_erases where id = p_erase_id and environment_id = p_environment_id;
	if not found then raise exception 'Erase not found' using errcode = 'P0002'; end if;
	if v_row.state <> 'open' then return public.qorpera_memory_message_erase_reply(v_row.id); end if;
	if (select s.memory_generation from public.qorpera_shared_sessions s where s.id = v_row.session_id) <> v_row.generation then
		return public.qorpera_memory_message_erase_rewritten(v_row.id, null, 'memory_generation_stale'); end if;
	v_root := public.qorpera_memory_owner_root(p_environment_id, v_row.owner_kind, v_row.owner_id);
	v_plan := public.qorpera_memory_message_erase_rewrite_plan(p_environment_id, v_row.id);
	if encode(extensions.digest(convert_to(v_plan::text, 'utf8'), 'sha256'), 'hex') is distinct from p_plan_sha256 then
		raise exception 'The rewrite plan changed; plan it again' using errcode = '55000'; end if;
	if jsonb_array_length(v_plan) = 0 then return public.qorpera_memory_message_erase_rewritten(v_row.id, null, null); end if;
	-- Each staged file holds its block's text, in the plan's order.
	if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) <> jsonb_array_length(v_plan)
		or exists (select 1 from jsonb_array_elements(v_plan) with ordinality p(item, o)
			join jsonb_array_elements(p_files) with ordinality f(item, o) on f.o = p.o
			where jsonb_typeof(f.item) is distinct from 'object' or f.item ->> 'path' is distinct from p.item ->> 'path'
				or f.item #>> '{file,fileSha256}' is distinct from p.item ->> 'fileSha256'
				or f.item #> '{file,bytes}' is distinct from p.item -> 'bytes'
				or f.item #> '{file,executable}' is distinct from 'false'::jsonb) then
		raise exception 'The staged files do not match the plan' using errcode = '22023'; end if;
	select jsonb_agg(jsonb_build_object('op', 'write', 'path', p.item ->> 'path', 'file', f.item -> 'file',
			'structured', jsonb_build_array(jsonb_build_object('path', p.item ->> 'path', 'kind', 'memory-block',
				'text', p.item ->> 'text', 'parse', '{"kind":"memory-block"}'::jsonb, 'parserVersion', 1)))
		|| case when jsonb_typeof(p.item -> 'expectedVersion') = 'string'
			then jsonb_build_object('expectedVersion', p.item -> 'expectedVersion') else '{}'::jsonb end
		order by p.o)
	into v_units
	from jsonb_array_elements(v_plan) with ordinality p(item, o)
	join jsonb_array_elements(p_files) with ordinality f(item, o) on f.o = p.o;
	v_key := 'memerase:' || v_row.id::text || ':' || extensions.gen_random_uuid()::text;
	begin
		perform set_config('qorpera.memory_message_erase', jsonb_build_object('environmentId', p_environment_id::text,
			'operationKey', v_key, 'eraseId', v_row.id::text, 'step', 'rewrite', 'profileId', v_row.profile_id::text,
			'userId', v_row.requested_by_user_id::text, 'ownerKind', v_row.owner_kind, 'ownerId', v_row.owner_id::text,
			'sessionId', v_row.session_id::text, 'root', v_root, 'generation', v_row.generation,
			'planSha', p_plan_sha256)::text, true);
		v_result := public.qorpera_folder_memory_commit(p_environment_id, '{"kind":"platform"}'::jsonb, v_key, v_units,
			jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object(
				'sessionId', v_row.session_id, 'generation', v_row.generation))));
		if exists (select 1 from jsonb_array_elements(v_result -> 'units') u where u.value ->> 'reason' = 'memory_generation_stale') then
			raise exception 'A later erase raised the generation' using errcode = 'QME03'; end if;
		if jsonb_typeof(v_result -> 'units') is distinct from 'array' or exists (select 1
			from jsonb_array_elements(v_result -> 'units') u where u.value ->> 'outcome' is distinct from 'saved') then
			raise exception 'The rewrite commit was not saved' using errcode = 'QME01', detail = v_result::text; end if;
		perform set_config('qorpera.memory_message_erase', '', true);
	exception
		when sqlstate 'QME01' then
			get stacked diagnostics v_error = message_text, v_detail = pg_exception_detail;
			update public.qorpera_memory_message_erases
			set last_error = left(v_error || coalesce(': ' || nullif(v_detail, ''), ''), 4000), updated_at = clock_timestamp()
			where id = v_row.id;
			return public.qorpera_memory_message_erase_reply(v_row.id);
		when sqlstate 'QME03' then
			return public.qorpera_memory_message_erase_rewritten(v_row.id, null, 'memory_generation_stale');
	end;
	update public.qorpera_folder_commits set requester_kind = 'member', requester_id = v_row.requested_by_user_id
	where id = (v_result ->> 'commitId')::uuid;
	return public.qorpera_memory_message_erase_rewritten(v_row.id, (v_result ->> 'commitId')::uuid, null);
end $$;

-- 8. Step 3 -----------------------------------------------------------------------------------------------------------

-- One block's history request per call, so per transaction: an erasure P18 accepts is in its versions phase until it
-- commits and pg_cron moves it on, and a second request over an overlapping path in the same transaction would get
-- 55006 every time. The eraser calls again until the row is requested.
create function public.qorpera_memory_message_erase_ask(p_environment_id uuid, p_erase_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_row public.qorpera_memory_message_erases%rowtype;
	v_block public.qorpera_memory_message_erase_blocks%rowtype;
	v_for jsonb;
	v_key text;
	v_request jsonb;
	v_existing public.qorpera_folder_erasures%rowtype;
	v_reply jsonb;
	v_state text;
	v_message text;
	v_detail text;
	v_life jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_row from public.qorpera_memory_message_erases where id = p_erase_id and environment_id = p_environment_id
	for update;
	if not found then raise exception 'Erase not found' using errcode = 'P0002'; end if;
	if v_row.state <> 'rewritten' then return public.qorpera_memory_message_erase_reply(v_row.id); end if;
	select * into v_block from public.qorpera_memory_message_erase_blocks
	where erase_id = v_row.id and accepted_at is null order by block_key limit 1;
	if found then
		v_for := jsonb_build_object('table', 'qorpera_memory_message_erases', 'id', v_row.id::text);
		v_key := 'memtree:' || encode(extensions.digest(convert_to('qorpera_memory_message_erases:' || v_row.id::text || ':'
			|| v_block.block_key, 'utf8'), 'sha256'), 'hex');
		-- A request P18 accepted before a restart is found by its key.
		select * into v_existing from public.qorpera_folder_erasures where environment_id = p_environment_id and operation_key = v_key;
		if found then
			if v_existing.block_history -> 'for' is distinct from v_for then
				raise exception 'Another request holds this block''s key' using errcode = '55000'; end if;
			v_reply := jsonb_build_object('erasureId', v_existing.id, 'copies', coalesce(v_existing.reply -> 'copies', '[]'::jsonb));
		else
			-- The delete's position as the cutoff, or none for a block found by key alone.
			v_request := jsonb_build_object('path', v_block.path, 'for', v_for)
				|| case when v_block.cutoff_seq is not null
					then jsonb_build_object('cutoffSeq', v_block.cutoff_seq, 'cutoffUnit', v_block.cutoff_unit) else '{}'::jsonb end;
			begin
				v_reply := public.qorpera_folder_erase_block_history(p_environment_id, v_row.requested_by_user_id, v_key, v_request);
			exception
				when sqlstate '55000' or sqlstate '55006' or sqlstate '55P03' or sqlstate 'PGRST' then
					get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
					if v_state = '55000' and v_message = 'Block is live again' and v_block.cutoff_seq is null then
						-- The newest life is the tree built again, or another tree's block at the name: it keeps that life.
						v_life := v_detail::jsonb -> 'life';
						begin
							v_reply := public.qorpera_folder_erase_block_history(p_environment_id, v_row.requested_by_user_id, v_key,
								v_request || jsonb_build_object('lifeSeq', (v_life ->> 'seq')::bigint, 'lifeUnit', (v_life ->> 'unit')::integer));
						exception
							when sqlstate '55000' or sqlstate '55006' or sqlstate '55P03' or sqlstate 'PGRST' then
								get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
								if v_state = '55000' and v_message <> 'Block is live again' then raise; end if;
						end;
					elsif v_state = '55000' then raise;
					end if;
			end;
		end if;
		if v_reply is null then
			-- Asked again later: another erasure's versions phase, a lock, or a life newer than the refusal's.
			update public.qorpera_memory_message_erases set last_error = left(v_message, 4000), updated_at = clock_timestamp()
			where id = v_row.id;
			return public.qorpera_memory_message_erase_reply(v_row.id);
		end if;
		update public.qorpera_memory_message_erase_blocks
		set erasure_id = (v_reply ->> 'erasureId')::uuid, copies = coalesce(v_reply -> 'copies', '[]'::jsonb),
			accepted_at = clock_timestamp()
		where erase_id = v_row.id and block_key = v_block.block_key;
	end if;
	update public.qorpera_memory_message_erases
	set state = case when exists (select 1 from public.qorpera_memory_message_erase_blocks b
			where b.erase_id = v_row.id and b.accepted_at is null) then 'rewritten' else 'requested' end,
		last_error = null, updated_at = clock_timestamp()
	where id = v_row.id;
	return public.qorpera_memory_message_erase_reply(v_row.id);
end $$;

-- 9. Step 4 -----------------------------------------------------------------------------------------------------------

-- Each run in the run table, once it has ended with no open card, gets P18's scrub (§6 there) on the receipts step 1
-- linked: the envelope stays and the content becomes [erased]. A run still live, with an open card or a receipt
-- locked by another writer stays pending for the next call. The row is done once every run is, and every block's
-- erasure is past its versions phase.
create function public.qorpera_memory_message_erase_scrub(p_environment_id uuid, p_erase_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_row public.qorpera_memory_message_erases%rowtype;
	v_run public.qorpera_memory_message_erase_runs%rowtype;
	v_receipt record;
	v_ended boolean;
	v_left integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_row from public.qorpera_memory_message_erases where id = p_erase_id and environment_id = p_environment_id
	for update;
	if not found then raise exception 'Erase not found' using errcode = 'P0002'; end if;
	if v_row.state <> 'requested' then return public.qorpera_memory_message_erase_reply(v_row.id); end if;
	for v_run in select * from public.qorpera_memory_message_erase_runs where erase_id = v_row.id and state = 'pending'
		order by run_id
	loop
		v_ended := exists (select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
			where r.id = v_run.run_id and j.status not in ('queued','leased'))
			and not exists (select 1 from public.qorpera_action_reviews a where a.run_id = v_run.run_id
				and not (a.decision <> 'ask' or a.answer is not distinct from 'deny' or a.consumed_at is not null));
		continue when not v_ended;
		v_left := 0;
		for v_receipt in select rr.id, rr.run_id, rr.call_id, rr.operation_receipt_id
			from public.qorpera_memory_read_receipts rr
			where rr.id = any(v_run.read_receipt_ids) and rr.environment_id = p_environment_id
			order by rr.id
		loop
			if v_receipt.operation_receipt_id is not null and exists (select 1 from public.qorpera_run_operation_receipts o
				where o.id = v_receipt.operation_receipt_id and o.run_id = v_run.run_id and o.status = 'completed'
					and o.result -> 'content' is distinct from '{"kind":"text","value":"[erased]"}'::jsonb) then
				perform 1 from public.qorpera_run_operation_receipts where id = v_receipt.operation_receipt_id
				for no key update skip locked;
				if found then
					update public.qorpera_run_operation_receipts
					set result = jsonb_set(result, '{content}', '{"kind":"text","value":"[erased]"}'::jsonb)
					where id = v_receipt.operation_receipt_id;
				else
					v_left := v_left + 1;
				end if;
			end if;
			-- M3 step 4: a scrubbed receipt (run_id, call_id known here).
		end loop;
		if v_left = 0 then
			update public.qorpera_memory_message_erase_runs set state = 'done', scrubbed_at = clock_timestamp()
			where erase_id = v_row.id and run_id = v_run.run_id;
		end if;
	end loop;
	if not exists (select 1 from public.qorpera_memory_message_erase_runs where erase_id = v_row.id and state = 'pending')
		and not exists (select 1 from public.qorpera_memory_message_erase_blocks b where b.erase_id = v_row.id
			and b.erasure_id is not null and not public.qorpera_folder_erasure_past_versions(b.erasure_id)) then
		update public.qorpera_memory_message_erases set state = 'done', done_at = clock_timestamp(), last_error = null,
			updated_at = clock_timestamp()
		where id = v_row.id;
	else
		update public.qorpera_memory_message_erases set updated_at = clock_timestamp() where id = v_row.id;
	end if;
	return public.qorpera_memory_message_erase_reply(v_row.id);
end $$;

-- 10. Privileges ------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_memory_entry_id(jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_erase_drops(bigint, integer, bigint) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_erase_candidates(text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_erase_line(public.qorpera_memory_tree_nodes) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_erase_deletes(uuid, text, bigint, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_erase_toml_manifests(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_erase_roots(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_erase_receipts(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_context(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_lock_targets(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_targets(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_step1(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_hook(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_reply(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_rewrite_plan(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_rewritten(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_memory_message_erase_request(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_memory_message_erase_status(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_memory_message_erase_due(integer) from public, anon, authenticated;
revoke all on function public.qorpera_memory_message_erase_open(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_memory_message_erase_plan(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_memory_message_erase_rewrite(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.qorpera_memory_message_erase_ask(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_memory_message_erase_scrub(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_memory_message_erase_request(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.qorpera_memory_message_erase_status(uuid, uuid, uuid) to service_role;
grant execute on function public.qorpera_memory_message_erase_due(integer) to service_role;
grant execute on function public.qorpera_memory_message_erase_open(uuid, uuid) to service_role;
grant execute on function public.qorpera_memory_message_erase_plan(uuid, uuid) to service_role;
grant execute on function public.qorpera_memory_message_erase_rewrite(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.qorpera_memory_message_erase_ask(uuid, uuid) to service_role;
grant execute on function public.qorpera_memory_message_erase_scrub(uuid, uuid) to service_role;

drop function pg_temp.m3_replace(regprocedure, text, text);
