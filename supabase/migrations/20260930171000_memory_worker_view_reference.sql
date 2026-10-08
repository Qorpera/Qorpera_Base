-- Context tree W4a-1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §12, §14 W4): a worker starts from its parent's
-- views by reference. The SQL keeps and checks the reference; the runtime (W4b) composes from it.
-- * manage_worker's dispatch and follow-up requests to qorpera_folder_worker_commit may name `parentStep` (the parent's
--   step whose answer made the call, an integer from 0) and `view` (the parent's views by reference, 256 KiB at most:
--   {asOfSeq, conversations: [{sessionId, generation, through, blocks: [{path, version}]}]}). Other actions take neither.
--   A view is checked before the commit (a forged one is 22023) and carried in its own setting,
--   qorpera.folder_worker_view, so the request every rule reads stays small.
-- * The index keeps them per dispatch and per follow-up in qorpera_runtime_worker_parents (worker, sequence). The sending
--   run is the parent, as the wake's parent_run_id is. The wake payload (qorpera.worker-dispatch/v1: 8 KB at most, a
--   closed shape the runtime parses) does not change.
-- * qorpera_folder_worker_parent(environment, actor): the worker's own run reads its parent run, step, conversation and
--   view reference. Execute for service_role only.
-- * qorpera_memory_view_reference_check(environment, view): read-only, service_role. The worker calls it after it read
--   the blocks: 'ok', or 'generation_moved' (an erase raised a conversation's generation since), 'block_gone' (a version
--   was pruned or erased, or its tree is gone) or 'erasure_covers' (an open folder erasure erases a block). Anything but
--   'ok' means compose from the trees as they are now. It stores nothing: an erase after the check finds the worker
--   under way (§10 step 5).
-- Every inserted text names this migration (20260930171000), for the deploy guard.

-- A second run stops here, before anything changes.
do $$ begin
	if to_regclass('public.qorpera_runtime_worker_parents') is not null then
		raise exception 'W4a-1 (20260930171000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.w4a1_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'W4a-1 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The table -----------------------------------------------------------------------------------------------------------

-- A dispatch's or follow-up's parent step and view reference, one row per worker sequence that named either. No foreign
-- key on the parent run: its KEY SHARE would come in the index step, after the paths.
create table public.qorpera_runtime_worker_parents (
	worker_id uuid not null references public.qorpera_runtime_workers(id) on delete cascade,
	sequence integer not null check (sequence between 1 and 12),
	parent_run_id uuid not null,
	parent_step integer check (parent_step >= 0),
	parent_view jsonb check (parent_view is null or jsonb_typeof(parent_view) = 'object'),
	created_at timestamptz not null default clock_timestamp(),
	primary key (worker_id, sequence),
	check (parent_step is not null or parent_view is not null)
);
alter table public.qorpera_runtime_worker_parents enable row level security;
revoke all on public.qorpera_runtime_worker_parents from public, anon, authenticated, service_role;
comment on table public.qorpera_runtime_worker_parents is
	'Context tree W4 (RUNTIME-AGENT-MEMORY-TREE.md §12): the parent step and the parent''s views by reference that a '
	'worker''s dispatch or follow-up named. Read through qorpera_folder_worker_parent.';

-- 2. The reference's shape ---------------------------------------------------------------------------------------------

-- {asOfSeq, conversations: [{sessionId, generation, through, blocks: [{path, version}]}]}: closed keys, 1 to 64
-- conversations each named once, counts as JSON integers from 0, lowercase uuids. One check per IF: an OR may evaluate
-- jsonb_object_keys or jsonb_array_length on the wrong type first.
create function public.qorpera_memory_view_reference_valid(p_view jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
-- 20260930171000 (W4a-1)
declare v_conversation jsonb; v_block jsonb;
	c_count constant text := '^(0|[1-9][0-9]{0,17})$';
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	if jsonb_typeof(p_view) is distinct from 'object' then return false; end if;
	if octet_length(p_view::text) > 262144 then return false; end if;
	if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_view) k)
		is distinct from array['asOfSeq','conversations'] then return false; end if;
	if jsonb_typeof(p_view -> 'asOfSeq') <> 'number' or (p_view ->> 'asOfSeq') !~ c_count then return false; end if;
	if jsonb_typeof(p_view -> 'conversations') <> 'array' then return false; end if;
	if jsonb_array_length(p_view -> 'conversations') not between 1 and 64 then return false; end if;
	for v_conversation in select value from jsonb_array_elements(p_view -> 'conversations') loop
		if jsonb_typeof(v_conversation) <> 'object' then return false; end if;
		if (select array_agg(k order by k collate "C") from jsonb_object_keys(v_conversation) k)
			is distinct from array['blocks','generation','sessionId','through'] then return false; end if;
		if jsonb_typeof(v_conversation -> 'sessionId') <> 'string' or (v_conversation ->> 'sessionId') !~ c_uuid then
			return false; end if;
		if jsonb_typeof(v_conversation -> 'generation') <> 'number' or (v_conversation ->> 'generation') !~ c_count then
			return false; end if;
		if jsonb_typeof(v_conversation -> 'through') <> 'number' or (v_conversation ->> 'through') !~ c_count then
			return false; end if;
		if jsonb_typeof(v_conversation -> 'blocks') <> 'array' then return false; end if;
		for v_block in select value from jsonb_array_elements(v_conversation -> 'blocks') loop
			if jsonb_typeof(v_block) <> 'object' then return false; end if;
			if (select array_agg(k order by k collate "C") from jsonb_object_keys(v_block) k)
				is distinct from array['path','version'] then return false; end if;
			if jsonb_typeof(v_block -> 'path') <> 'string' or char_length(v_block ->> 'path') not between 1 and 1024 then
				return false; end if;
			if jsonb_typeof(v_block -> 'version') <> 'string' or (v_block ->> 'version') !~ c_uuid then return false; end if;
		end loop;
	end loop;
	if (select count(distinct value ->> 'sessionId') from jsonb_array_elements(p_view -> 'conversations'))
		<> jsonb_array_length(p_view -> 'conversations') then return false; end if;
	return true;
end $$;
revoke all on function public.qorpera_memory_view_reference_valid(jsonb) from public, anon, authenticated, service_role;

-- 3. The check ---------------------------------------------------------------------------------------------------------

-- Whether a view reference still stands. A reference no parent could have composed is 22023: a conversation of another
-- company or none, a generation above the conversation's, a folder clock ahead of the company's, or a block version
-- that is not a tree block at its path, saved by asOfSeq. Otherwise, in this order: 'generation_moved' when an erase
-- raised a generation since; 'block_gone' when a version is no longer kept (pruned, or erased by an erasure that is
-- done) or is not under its conversation's live tree; 'erasure_covers' when an open folder erasure erases one (its
-- root covers the block and its cutoff comes after the version, so a live root's current life is not counted); else
-- 'ok'.
create function public.qorpera_memory_view_reference_check(p_environment_id uuid, p_view jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
-- 20260930171000 (W4a-1)
declare v_conversation jsonb; v_block jsonb; v_session public.qorpera_shared_sessions%rowtype; v_root text; v_key text;
	v_version public.qorpera_folder_path_versions%rowtype; v_seq bigint; v_as_of bigint;
	v_moved boolean := false; v_gone boolean := false; v_erased boolean := false;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if not public.qorpera_memory_view_reference_valid(p_view) then
		raise exception 'View reference is invalid' using errcode = '22023'; end if;
	v_as_of := (p_view ->> 'asOfSeq')::bigint;
	if v_as_of > coalesce((select last_seq from public.qorpera_folder_clocks where environment_id = p_environment_id), -1) then
		raise exception 'View reference is invalid' using errcode = '22023'; end if;
	for v_conversation in select value from jsonb_array_elements(p_view -> 'conversations') loop
		select * into v_session from public.qorpera_shared_sessions
		where id = (v_conversation ->> 'sessionId')::uuid and environment_id = p_environment_id;
		if v_session.id is null or (v_conversation ->> 'generation')::bigint > v_session.memory_generation then
			raise exception 'View reference is invalid' using errcode = '22023'; end if;
		v_moved := v_moved or (v_conversation ->> 'generation')::bigint < v_session.memory_generation;
		v_root := (select root_key from public.qorpera_memory_trees
			where environment_id = p_environment_id and session_id = v_session.id and retired_at is null);
		for v_block in select value from jsonb_array_elements(v_conversation -> 'blocks') loop
			select * into v_version from public.qorpera_folder_path_versions where version = (v_block ->> 'version')::uuid;
			if v_version.version is null then v_gone := true; continue; end if;
			v_seq := (select seq from public.qorpera_folder_commits where id = v_version.commit_id);
			v_key := public.qorpera_folder_key(v_version.path);
			if v_version.environment_id <> p_environment_id or v_version.path is distinct from (v_block ->> 'path')
				or v_version.kind is distinct from 'file' or v_version.op not in ('write','move_in')
				or public.qorpera_structured_path_kind(v_key) is distinct from 'memory-block'
				or v_seq is null or v_seq > v_as_of then
				raise exception 'View reference is invalid' using errcode = '22023'; end if;
			-- Its tree: the block's key without t<tier>/<name>.jsonl is the conversation's live root.
			if v_root is null or regexp_replace(v_key, '/t([0-9]|1[0-4])/[0-9]{8}\.jsonl$', '') is distinct from v_root then
				v_gone := true; continue; end if;
			if exists (select 1 from public.qorpera_folder_erasures erasure, jsonb_array_elements(erasure.roots) root
				where erasure.environment_id = p_environment_id and erasure.state <> 'done'
					and public.qorpera_folder_erasure_covers(root.value ->> 'key', v_key)
					and public.qorpera_folder_erasure_before(root.value, v_seq, v_version.unit_no)) then
				v_erased := true; end if;
		end loop;
	end loop;
	return case when v_moved then 'generation_moved' when v_gone then 'block_gone' when v_erased then 'erasure_covers'
		else 'ok' end;
end $$;
revoke all on function public.qorpera_memory_view_reference_check(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_memory_view_reference_check(uuid, jsonb) to service_role;

-- 4. The dispatch and the follow-up keep them --------------------------------------------------------------------------

-- The index step's write: a row when the request named a parent step or a view (the view from its own setting).
create function public.qorpera_folder_worker_parent_keep(p_worker_id uuid, p_sequence integer, p_parent_run_id uuid,
	p_request jsonb)
returns void language plpgsql set search_path = '' as $$
-- 20260930171000 (W4a-1)
declare v_view text := coalesce(current_setting('qorpera.folder_worker_view', true), '');
begin
	if p_request ? 'parentStep' or v_view <> '' then
		insert into public.qorpera_runtime_worker_parents(worker_id, sequence, parent_run_id, parent_step, parent_view)
		values (p_worker_id, p_sequence, p_parent_run_id, (p_request ->> 'parentStep')::integer, nullif(v_view, '')::jsonb);
	end if;
end $$;
revoke all on function public.qorpera_folder_worker_parent_keep(uuid, integer, uuid, jsonb)
	from public, anon, authenticated, service_role;

select pg_temp.w4a1_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k
				where v_action <> 'dispatch' or k not in ('harness','owner','repository','species'))$old$,
	$new$		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k
				where (v_action <> 'dispatch' or k not in ('harness','owner','repository','species'))
					-- 20260930171000 (W4a-1): a dispatch or a follow-up may also name its parent's step and views.
					and (v_action not in ('dispatch','followup') or k not in ('parentStep','view')))$new$);

select pg_temp.w4a1_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$		or (v_action = 'followup' and (jsonb_typeof(p_request -> 'text') <> 'string'$old$,
	$new$		-- 20260930171000 (W4a-1): a step is an integer from 0; a view has the reference's shape (checked below).
		or (v_action in ('dispatch','followup') and p_request ? 'parentStep' and (jsonb_typeof(p_request -> 'parentStep') <> 'number'
			or (p_request ->> 'parentStep') !~ '^(0|[1-9][0-9]{0,8})$'))
		or (v_action in ('dispatch','followup') and p_request ? 'view'
			and not public.qorpera_memory_view_reference_valid(p_request -> 'view'))
		or (v_action = 'followup' and (jsonb_typeof(p_request -> 'text') <> 'string'$new$);

select pg_temp.w4a1_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$	perform set_config('qorpera.folder_worker', (p_request || jsonb_build_object('environmentId', p_environment_id::text,$old$,
	$new$	-- 20260930171000 (W4a-1): a view is checked against the folder, then carried in its own setting for the index.
	if coalesce(current_setting('qorpera.folder_worker_view', true), '') <> '' then
		raise exception 'A worker request is already set in this transaction' using errcode = '55000'; end if;
	if v_action in ('dispatch','followup') and p_request ? 'view' then
		perform public.qorpera_memory_view_reference_check(p_environment_id, p_request -> 'view'); end if;
	perform set_config('qorpera.folder_worker_view', coalesce((p_request -> 'view')::text, ''), true);
	perform set_config('qorpera.folder_worker', ((p_request - 'view') || jsonb_build_object('environmentId', p_environment_id::text,$new$);

select pg_temp.w4a1_replace('public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure,
	$old$	perform set_config('qorpera.folder_worker', '', true);$old$,
	$new$	perform set_config('qorpera.folder_worker', '', true);
	perform set_config('qorpera.folder_worker_view', '', true); -- 20260930171000 (W4a-1)$new$);

select pg_temp.w4a1_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		values (v_worker.id, v_worker.sequence, 'dispatched', v_commit.run_id, v_dispatch);$old$,
	$new$		values (v_worker.id, v_worker.sequence, 'dispatched', v_commit.run_id, v_dispatch);
		perform public.qorpera_folder_worker_parent_keep(v_worker.id, v_worker.sequence, v_commit.run_id, v_request); -- 20260930171000 (W4a-1)$new$);

select pg_temp.w4a1_replace('public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		values (v_worker.id, v_worker.sequence, 'followup', v_commit.run_id, jsonb_build_object('text', p_parse ->> 'followUp'));$old$,
	$new$		values (v_worker.id, v_worker.sequence, 'followup', v_commit.run_id, jsonb_build_object('text', p_parse ->> 'followUp'));
		perform public.qorpera_folder_worker_parent_keep(v_worker.id, v_worker.sequence, v_commit.run_id, v_request); -- 20260930171000 (W4a-1)$new$);

-- 5. The worker reads its parent ----------------------------------------------------------------------------------------

-- A worker's own run (its binding is checked as for a read): the worker and the sequence its wake started, the parent run
-- (the wake's), that run's conversation, and the step and view reference the dispatch or follow-up named (JSON null
-- when it named none). Any other actor, or a run that is not a worker's in this company, is refused.
create function public.qorpera_folder_worker_parent(p_environment_id uuid, p_actor jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 20260930171000 (W4a-1)
declare v_wake public.qorpera_wake_occurrences%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_parent public.qorpera_runtime_worker_parents%rowtype; v_sequence integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_folder_read_actor(p_environment_id, p_actor);
	select * into v_wake from public.qorpera_wake_occurrences
	where run_id = (p_actor ->> 'runId')::uuid and wake_kind = 'agent' and source_kind = 'worker-dispatch';
	select * into v_worker from public.qorpera_runtime_workers where id = v_wake.source_id;
	if v_worker.id is null or v_worker.folder_environment_id is distinct from p_environment_id then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	v_sequence := case when (v_wake.payload ->> 'sequence') ~ '^[1-9][0-9]?$' then (v_wake.payload ->> 'sequence')::integer end;
	select * into v_parent from public.qorpera_runtime_worker_parents
	where worker_id = v_worker.id and sequence = v_sequence and parent_run_id = v_wake.parent_run_id;
	return jsonb_build_object('schema', 'qorpera.folder-worker-parent/v1', 'workerId', v_worker.id, 'sequence', v_sequence,
		'parentRunId', v_wake.parent_run_id, 'parentStep', v_parent.parent_step,
		'parentSessionId', (select run.session_id from public.qorpera_execution_runs run where run.id = v_wake.parent_run_id),
		'view', v_parent.parent_view);
end $$;
revoke all on function public.qorpera_folder_worker_parent(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_worker_parent(uuid, jsonb) to service_role;

-- 6. The deploy guard ---------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_memory_view_reference_valid(jsonb)', 'public.qorpera_memory_view_reference_check(uuid,jsonb)',
		'public.qorpera_folder_worker_parent_keep(uuid,integer,uuid,jsonb)', 'public.qorpera_folder_worker_parent(uuid,jsonb)',
		'public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)',
		'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930171000') = 0 then
			raise exception 'W4a-1 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
