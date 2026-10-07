-- Summary trees M1a, part 1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.3, §10): the checked batch commit.
--
-- 1. qorpera_shared_sessions.memory_generation: a conversation's erasure generation. An erase raises it (M3, W1); it is
--    never rebuilt from files.
-- 2. qorpera_folder_memory_commit: the only way to write a summary tree's files. It carries the batch's request
--    (environment, operation key, preconditions) into qorpera_folder_commit in the transaction setting
--    qorpera.folder_memory, as qorpera_folder_worker_commit does for a worker's files. Execute for service_role only.
-- 3. preconditions.sessionGenerations: each named conversation's row is taken FOR SHARE at the commit's session step
--    (rank 11, in id order, with the sessions the apply step writes FOR UPDATE in the same pass). Then every unit is
--    refused with memory_generation_stale when one generation differs, so a batch built before an erase is discarded
--    whole. A raise of memory_generation takes the same row FOR UPDATE at that step.
-- The tree files themselves (kinds, checks, index) are part 2, 20260930111000.
-- Every patched body carries the marker 20260930110000 for the deploy guard.

-- qorpera_shared_sessions is read by every run: never queue its readers behind this migration.
set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_shared_sessions'::regclass
		and attname = 'memory_generation' and not attisdropped) then
		raise exception 'M1a (20260930110000) is already applied'; end if;
end $$;

-- 1. The generation. A constant default, so adding it rewrites nothing.
alter table public.qorpera_shared_sessions add column memory_generation bigint not null default 0;
comment on column public.qorpera_shared_sessions.memory_generation is
	'Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §4.3): raised by an erase of this conversation''s words; a memory commit '
	'naming an older generation is refused with memory_generation_stale. Never rebuilt from files.';

-- 2. Helpers -----------------------------------------------------------------------------------------------------

-- The memory commit's request this transaction carries, or null.
create function public.qorpera_folder_memory_request()
returns jsonb language sql stable set search_path = '' as $$
	select case when coalesce(current_setting('qorpera.folder_memory', true), '') = '' then null
		else current_setting('qorpera.folder_memory', true)::jsonb end
$$;
revoke all on function public.qorpera_folder_memory_request() from public, anon, authenticated, service_role;

-- Whether a memory commit's preconditions are well formed: closed keys; sessionGenerations is at most 64 distinct
-- conversations of this company, each {sessionId, generation}.
create function public.qorpera_folder_memory_preconditions_valid(p_environment_id uuid, p_preconditions jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare v_item jsonb; v_ids uuid[] := '{}';
begin
	if jsonb_typeof(p_preconditions) is distinct from 'object' then return false; end if;
	if exists (select 1 from jsonb_object_keys(p_preconditions) k where k <> 'sessionGenerations') then return false; end if;
	if not p_preconditions ? 'sessionGenerations' then return true; end if;
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
	return not exists (select 1 from unnest(v_ids) i(id) where not exists (select 1 from public.qorpera_shared_sessions s
		where s.id = i.id and s.environment_id = p_environment_id));
end $$;
revoke all on function public.qorpera_folder_memory_preconditions_valid(uuid, jsonb) from public, anon, authenticated, service_role;

-- The commit's lock targets for a memory request of this change set: each sessionGenerations conversation at rank 11,
-- FOR SHARE, not required (a conversation gone by then fails the generation check instead).
create function public.qorpera_folder_memory_targets(p_environment_id uuid, p_operation_key text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_request jsonb := public.qorpera_folder_memory_request();
begin
	if v_request is null or v_request ->> 'environmentId' is distinct from p_environment_id::text
		or v_request ->> 'operationKey' is distinct from p_operation_key
		or jsonb_typeof(v_request -> 'preconditions' -> 'sessionGenerations') is distinct from 'array' then
		return '[]'::jsonb; end if;
	return coalesce((select jsonb_agg(jsonb_build_object('rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', g ->> 'sessionId',
			'mode', 'share', 'required', false))
		from jsonb_array_elements(v_request -> 'preconditions' -> 'sessionGenerations') g), '[]'::jsonb);
end $$;
revoke all on function public.qorpera_folder_memory_targets(uuid, text) from public, anon, authenticated, service_role;

-- The structured-file hook's first check, for every unit (§4.3): a memory request belongs to this change set, and every
-- generation it names is still current. Its sessions are locked by now (rank 11), so the reading is final for this
-- commit. Returns a refusal or null.
create function public.qorpera_memory_generation_decide(p_environment_id uuid, p_commit_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
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
	return null;
end $$;
revoke all on function public.qorpera_memory_generation_decide(uuid, uuid) from public, anon, authenticated, service_role;

create function pg_temp.m1a_generation_replace(p_function regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'M1a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 3. The session step: FOR UPDATE where any target writes the session, FOR SHARE where every target only reads its
-- memory generation. One pass in id order either way, so a writer and a memory commit never take two rows crosswise.
create or replace function public.qorpera_folder_lock_sessions(p_environment_id uuid, p_targets jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_required uuid[]; v_locked uuid[] := '{}'; v_target record;
begin
	select coalesce(array_agg(distinct (t ->> 'key')::uuid), '{}'),
		coalesce(array_agg(distinct (t ->> 'key')::uuid) filter (where coalesce((t ->> 'required')::boolean, false)), '{}')
	into v_ids, v_required
	from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) t where t ->> 'rank' = '11';
	if cardinality(v_ids) = 0 then return; end if;
	if exists (select 1 from public.qorpera_shared_sessions where id = any (v_ids) and environment_id <> p_environment_id) then
		raise exception 'A session target belongs to another company' using errcode = 'XX000'; end if;
	-- 20260930110000 (M1a): a memory commit's generations FOR SHARE; a session any other target names FOR UPDATE, as
	-- before (a target with no mode too).
	for v_target in select (t ->> 'key')::uuid as id, bool_or(coalesce(t ->> 'mode', 'update') <> 'share') as writes
		from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) t where t ->> 'rank' = '11'
		group by 1 order by 1 loop
		if v_target.writes then
			perform 1 from public.qorpera_shared_sessions s
			where s.id = v_target.id and s.environment_id = p_environment_id for update;
		else
			perform 1 from public.qorpera_shared_sessions s
			where s.id = v_target.id and s.environment_id = p_environment_id for share;
		end if;
		if found then v_locked := v_locked || v_target.id; end if;
	end loop;
	if exists (select 1 from unnest(v_required) r(id) where not (r.id = any (v_locked))) then
		raise exception 'A session this change set relies on is unavailable' using errcode = '42501'; end if;
end $$;

-- The commit: the memory request's targets join the hooks', and rank 11 accepts FOR SHARE.
select pg_temp.m1a_generation_replace(
	'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	v_targets := v_targets || coalesce((select jsonb_agg(to_jsonb(t))
			from public.qorpera_folder_structured_targets(p_environment_id, v_hook_actor, p_units) t), '[]'::jsonb);
$old$,
	$new$	v_targets := v_targets || coalesce((select jsonb_agg(to_jsonb(t))
			from public.qorpera_folder_structured_targets(p_environment_id, v_hook_actor, p_units) t), '[]'::jsonb);
	-- 20260930110000 (M1a): a memory commit's generations (rank 11, FOR SHARE).
	v_targets := v_targets || public.qorpera_folder_memory_targets(p_environment_id, p_operation_key);
$new$);
select pg_temp.m1a_generation_replace(
	'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	-- Every target names a rank 0-9 (or 11: a session the apply step writes, FOR UPDATE only), a table, a key and a
$old$,
	$new$	-- Every target names a rank 0-9 (or 11: a session the apply step writes, FOR UPDATE, or one whose memory generation a
	-- memory commit checks, FOR SHARE; 20260930110000), a table, a key and a
$new$);
select pg_temp.m1a_generation_replace(
	'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			or (t ->> 'rank' = '11' and (t ->> 'mode' <> 'update'
$old$,
	$new$			or (t ->> 'rank' = '11' and (t ->> 'mode' not in ('update','share') /* 20260930110000 (M1a) */
$new$);

-- The structured-file hook checks the generations first, for every unit.
select pg_temp.m1a_generation_replace(
	'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_key := public.qorpera_folder_key(p_eff_path);
	-- 20260929999980 (H2b): human tasks' folders and files, and the contacts they name, for every unit.
$old$,
	$new$	v_key := public.qorpera_folder_key(p_eff_path);
	-- 20260930110000 (M1a): a memory commit's request and generations, for every unit that gets this far; a stale one
	-- refuses each of them, so the commit is refused whole (a unit refused earlier keeps its own reason).
	v_rule := public.qorpera_memory_generation_decide(p_environment_id, p_commit_id);
	if v_rule is not null then return v_rule; end if;
	-- 20260929999980 (H2b): human tasks' folders and files, and the contacts they name, for every unit.
$new$);

-- 4. The memory commit. The caller is a service_role definer (the eraser, the prune) or the runtime host; the actor is
-- whatever qorpera_folder_commit accepts. The request is cleared again before it returns, so nothing later in the
-- transaction inherits it.
create function public.qorpera_folder_memory_commit(p_environment_id uuid, p_actor jsonb, p_operation_key text, p_units jsonb,
	p_preconditions jsonb default '{}'::jsonb, p_review_id uuid default null, p_receipt_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if coalesce(current_setting('qorpera.folder_memory', true), '') <> '' then
		raise exception 'A memory request is already set in this transaction' using errcode = '55000'; end if;
	if p_environment_id is null or coalesce(p_operation_key, '') = ''
		or not public.qorpera_folder_memory_preconditions_valid(p_environment_id, coalesce(p_preconditions, '{}'::jsonb)) then
		raise exception 'Memory request is invalid' using errcode = '22023'; end if;
	perform set_config('qorpera.folder_memory', jsonb_build_object('environmentId', p_environment_id::text,
		'operationKey', p_operation_key, 'preconditions', coalesce(p_preconditions, '{}'::jsonb))::text, true);
	v_result := public.qorpera_folder_commit(p_environment_id, p_actor, p_operation_key, p_units, p_review_id, p_receipt_id);
	perform set_config('qorpera.folder_memory', '', true);
	return v_result;
end $$;
revoke all on function public.qorpera_folder_memory_commit(uuid, jsonb, text, jsonb, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_memory_commit(uuid, jsonb, text, jsonb, jsonb, uuid, uuid) to service_role;
