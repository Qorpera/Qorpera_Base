-- Readers of a company share its profile fence, and lock waits on an agent's hot calls end before the
-- runtime gives up on them.
--
-- The fence (qorpera_lock_profile_gc_fence) is the company's profile row FOR UPDATE and then its wake
-- admission row FOR UPDATE (20260907000700). Every agent call takes it, and the path gateway's actor then
-- locks the Company File row FOR UPDATE (20260920030500), so every call in one company waited for every
-- other, reads included: the authority checks before and after each model request, context views, reads,
-- lists and presence. What the fence has to exclude:
--   - object garbage collection. The GC claim, lease and deletion paths take the fence and then start a
--     deletion; every holder checks qorpera_profile_gc_deletion_active after it, and every GC root insert
--     takes it in its trigger. A reader must not overlap a GC decision.
--   - the founder's stop and company deletion. They take the fence, record the pause or deletion and add
--     one to the wake admission revision (qorpera_set_company_execution_pause, qorpera_request_company_
--     deletion, qorpera_stop_company_work). A call that checked "not paused" after the fence must end before
--     the stop commits, or wait for it and then see it.
--   - every other fence holder: writers, admissions, office and machine placement, member management.
-- It does not need to exclude another reader: two reads of the same company change nothing the other relies
-- on. Each works under its own run's job row (locked before the fence), writes only rows keyed by its own
-- run (read observations and confirmations, the run's read set, context views, presence devices) and holds
-- every authority row it relies on FOR SHARE.
--
-- So a call that entered through one of the reader RPCs below takes the fence in a shared mode: the profile
-- row FOR SHARE, the wake admission row FOR SHARE, and the Company File row FOR SHARE (in the actor, and in
-- qorpera_wake_path_authorized for an agent wake's read set). What still conflicts:
--   - profile row FOR SHARE conflicts with FOR UPDATE and FOR NO KEY UPDATE: every exclusive fence holder
--     (GC included), qorpera_serialize_wake_admission, member and founding changes, event hook creation and
--     any update of the row. It no longer conflicts with another reader, nor with the KEY SHARE a foreign-key
--     insert takes on the profile row (telemetry, receipts, runs), which never needed to wait for a reader.
--   - wake admission row FOR SHARE conflicts with the stop's, resume's and deletion's revision update and
--     with qorpera_serialize_wake_admission's upsert, so a stop still waits for readers in flight and a
--     reader still waits for a stop and then sees it. Under repeatable read a newer revision still fails the
--     lock with a serialization error.
--   - Company File row FOR SHARE conflicts with every writer that locks it FOR UPDATE or moves the head, so a
--     reader still sees one head for its whole call.
-- Lock order is #377's (20260927150000), unchanged: the run's job row, the profile row, the wake admission
-- row, the Company File row, then authority rows FOR SHARE. Only the strength changes, and only for readers.
--
-- The mode is decided by the transaction's entry point, never by a nested call: PostgREST sets request.path
-- to the RPC it runs, one RPC per transaction, and qorpera_company_fence_shared() is true only for these
-- names in PostgREST's exact form (/rpc/<name>, or /rest/v1/rpc/<name>). Supabase Storage also sets
-- request.path, to its own URL with the query string; the pattern is anchored so that no Storage URL (they
-- start /object, /upload, /bucket, /s3 or /render) can name a reader. A reader RPC reached from inside a writer (qorpera_describe_native_tool_authority is called by
-- twenty of them) keeps the exclusive fence, so no transaction takes the fence shared and then exclusive,
-- which would deadlock two such transactions. The readers' whole call graph (functions and the triggers of
-- the tables they write) takes no other exclusive lock on these three rows; the one it reached,
-- qorpera_office_waiter_authorized's profile row FOR UPDATE NOWAIT for an office activation wake, now takes
-- FOR SHARE NOWAIT in a shared call. Direct SQL callers (tests, the secret broker's own connection) do not
-- set request.path and keep the exclusive fence, as before.
-- qorpera_fence_native_context (20260929400000, the one-call context fence) is a reader too: it only calls
-- the first three readers in the list, in one transaction, and reads the run's read set. Until that
-- migration is applied no such RPC exists, so its name matches no request.
--
-- Kept FOR UPDATE, not FOR NO KEY UPDATE: the exclusive fence's profile row. FOR UPDATE also waits for every
-- transaction that inserted a row pointing at the company (KEY SHARE) and is still open, and callers rely on
-- that: GC sees a root inserted just before it, and company deletion's sweep (qorpera_stop_company_work)
-- sees a job enqueued just before it. The exclusive actor's Company File row stays FOR UPDATE for the same
-- reason. Readers no longer take either.
--
-- Lock waits. The runtime gives these calls 3 s (the path gateway's RPCs) or 5-10 s (the tool authority),
-- and the native result boundary 4 s for a whole model request, but the database waited up to its 8 s
-- statement timeout: the lease validator, which takes the fence for every agent call, sets lock_timeout 25s
-- for itself (20260913000100, for the host's authority monitor), and that applied to the fence wait inside
-- every hot call. A client that had given up left its statement waiting on a pooled PostgREST connection.
-- Now:
--   - a reader waits at most 1500 ms for the profile, wake admission or Company File row: the shared lock
--     helpers below set their own lock_timeout, which also holds inside the validator;
--   - the Company File write path (check, prepare, commit, write) waits at most 2 s for any lock, the fence
--     inside the validator included (qorpera.company_fence_wait): under its 3 s client deadline, so a write
--     that could not lock ends with a definite "not committed" instead of a client timeout that may have
--     committed. The verification steps are left out: company bootstrap calls them too. The five set the
--     fence wait in their bodies for the length of the call, not as a function setting: a function's SET of
--     a custom parameter needs a superuser (permission denied, 42501, for Supabase's postgres role).
-- The validator itself keeps its 25 s budget and its exclusive fence when the host's authority monitor calls
-- it directly (every 15 s per run, and a failure ends the run): it is not one of the reader RPCs above.
-- A wait that runs out raises lock_not_available (55P03), which PostgREST returns as HTTP 500. The runtime
-- treats it as transport_unavailable (packages/runtime/src/cloud-company-path-control.ts) or a failed RPC
-- that fails its run retryably, never as a refusal (403) or a head conflict (PT409), like the 2 s fence
-- waits of qorpera_company_machine_fence_briefly and qorpera_receive_event. No exception handler maps it:
-- a handler around the fence would open a subtransaction for every fence call, and a read set can take
-- the fence once per path. The role-wide statement_timeout is not changed.
--
-- Load: scripts/load-company-fence-pool.mjs drives readers, writers, GC and foreign-key inserts on one
-- company through a small pool with the production role timeouts. It runs when these functions change
-- (scripts/run-on-node-plan.mjs).

set local lock_timeout = '3s';

create function public.qorpera_company_fence_shared()
returns boolean
language sql
stable
set search_path = ''
as $$
	select coalesce(substring(coalesce(current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$') = any (array[
		'qorpera_describe_native_tool_authority',
		'qorpera_assert_company_path_reads',
		'qorpera_record_native_context_view',
		'qorpera_read_company_path_v2',
		'qorpera_list_company_paths_v2',
		'qorpera_read_company_path',
		'qorpera_list_company_paths',
		'qorpera_confirm_company_path_read',
		'qorpera_native_presence_register',
		'qorpera_company_presence_scope',
		'qorpera_native_presence_subject',
		'qorpera_describe_company_run_context',
		'qorpera_read_company_run_context',
		'qorpera_fence_native_context'
	]), false)
$$;
comment on function public.qorpera_company_fence_shared() is
	'True when this transaction entered through a reader RPC (PostgREST request.path): the company fence and Company File row are then taken FOR SHARE. 20260929380000.';
-- Internal: only SECURITY DEFINER functions owned by the migration role call these. Supabase's default
-- privileges grant EXECUTE on new functions to the API roles, so revoke from them too, not only from PUBLIC.
revoke all on function public.qorpera_company_fence_shared() from public, anon, authenticated, service_role;

-- A reader's fence: the profile row, then the wake admission row, FOR SHARE, each waited for 1500 ms at most.
create function public.qorpera_lock_profile_gc_fence_shared(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1500ms'
as $$
begin
	perform 1 from public.qorpera_profiles where id = p_profile_id for share;
	if not found then raise exception 'profile is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_company_wake_admission_fences(profile_id,revision) values (p_profile_id,1)
	on conflict (profile_id) do nothing;
	perform 1 from public.qorpera_company_wake_admission_fences where profile_id = p_profile_id for share;
end
$$;
revoke all on function public.qorpera_lock_profile_gc_fence_shared(uuid) from public, anon, authenticated, service_role;

-- A reader's Company File row, FOR SHARE, waited for 1500 ms at most.
create function public.qorpera_lock_company_file_shared(p_environment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1500ms'
as $$
begin
	perform 1 from public.qorpera_company_files where environment_id = p_environment_id for share;
end
$$;
revoke all on function public.qorpera_lock_company_file_shared(uuid) from public, anon, authenticated, service_role;

create function pg_temp.company_fence_shared_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company fence shared readers differ: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- The fence: shared for a reader; otherwise as before, waiting at most qorpera.company_fence_wait when the
-- caller set one (the Company File write path below).
select pg_temp.company_fence_shared_patch('public.qorpera_lock_profile_gc_fence(uuid)',
	$old$AS $function$
begin
 perform 1 from public.qorpera_profiles where id=p_profile_id for update;
$old$,
	$new$AS $function$
declare v_wait text := nullif(current_setting('qorpera.company_fence_wait', true), ''); v_lock_timeout text;
begin
 -- A reader shares the fence with other readers (20260929380000); everyone else holds it alone.
 if public.qorpera_company_fence_shared() then
  perform public.qorpera_lock_profile_gc_fence_shared(p_profile_id);
  return;
 end if;
 -- The caller's budget for this wait, which a lock_timeout of a function in between would override.
 if v_wait is not null then
  v_lock_timeout := current_setting('lock_timeout');
  perform set_config('lock_timeout', v_wait, true);
 end if;
 perform 1 from public.qorpera_profiles where id=p_profile_id for update;
$new$);
select pg_temp.company_fence_shared_patch('public.qorpera_lock_profile_gc_fence(uuid)',
	$old$ perform 1 from public.qorpera_company_wake_admission_fences where profile_id=p_profile_id for update;
end $function$$old$,
	$new$ perform 1 from public.qorpera_company_wake_admission_fences where profile_id=p_profile_id for update;
 if v_wait is not null then perform set_config('lock_timeout', v_lock_timeout, true); end if;
end $function$$new$);

-- The path gateway's actor: the Company File row after the fence, FOR SHARE for a reader.
select pg_temp.company_fence_shared_patch('public.qorpera_company_path_actor(uuid,jsonb)',
	$old$	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
$old$,
	$new$	if public.qorpera_company_fence_shared() then
		perform public.qorpera_lock_company_file_shared(p_environment_id);
		select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id;
	else
		select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	end if;
$new$);

-- An agent wake's read set, checked path by path under the fence.
select pg_temp.company_fence_shared_patch('public.qorpera_wake_path_authorized(uuid,uuid,uuid,text)',
	$old$	select * into v_file from public.qorpera_company_files where environment_id=p_environment for update;
$old$,
	$new$	if public.qorpera_company_fence_shared() then
		perform public.qorpera_lock_company_file_shared(p_environment);
		select * into v_file from public.qorpera_company_files where environment_id=p_environment;
	else
		select * into v_file from public.qorpera_company_files where environment_id=p_environment for update;
	end if;
$new$);

-- An office activation wake's waiter re-takes the profile row without waiting: a shared call already holds
-- it FOR SHARE, and FOR UPDATE NOWAIT would fail whenever another reader holds it too.
select pg_temp.company_fence_shared_patch('public.qorpera_office_waiter_authorized(public.qorpera_runtime_office_start_waiters)',
	$old$ perform 1 from public.qorpera_profiles where id=v_parent.profile_id for update nowait;
$old$,
	$new$ if public.qorpera_company_fence_shared() then
  perform 1 from public.qorpera_profiles where id=v_parent.profile_id for share nowait;
 else
  perform 1 from public.qorpera_profiles where id=v_parent.profile_id for update nowait;
 end if;
$new$);

-- The Company File write path: 2 s for any one lock wait, the fence's included.
--
-- lock_timeout is a function setting, as for any function. The fence wait cannot be one: a function's (or a
-- role's) SET of a custom parameter such as qorpera.company_fence_wait needs a superuser or a SET grant on that
-- parameter, and Supabase's postgres role, which applies migrations, has neither (permission denied, 42501;
-- scripts/check-migration-custom-settings.mjs refuses one). set_config needs neither. So each of the five sets
-- the wait itself, transaction-local, as its first statement, and gives the caller's value back as it returns:
-- every return passes its value through qorpera_company_fence_wait_end, which runs after that value was computed
-- (computing it may take locks, under the 2 s). That is what the function setting did, for every caller: only
-- the five call each other in SQL, and the runtime calls each as its own RPC; within a call the wait is 2 s, and
-- after it the caller's own value (or none) stands again, so nothing later in the caller's transaction, such as
-- the host monitor's lease check with its 25 s, inherits the 2 s. An error needs nothing: it aborts the
-- transaction, or the caller's exception block rolls back its subtransaction, and either way PostgreSQL restores
-- the setting; none of the five catches an error itself.
alter function public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb) set lock_timeout = '2s';
alter function public.qorpera_prepare_company_path_mutation(uuid,jsonb,jsonb) set lock_timeout = '2s';
alter function public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text) set lock_timeout = '2s';
alter function public.qorpera_native_company_file_write_source(uuid,jsonb,jsonb) set lock_timeout = '2s';
alter function public.qorpera_native_company_file_write(uuid,jsonb,jsonb,jsonb,text,uuid,text) set lock_timeout = '2s';

-- A write path call's return value, after the caller's fence wait is back ('' when it had none, which the
-- fence reads as none). It has no setting of its own for the wait, so the value it sets outlives its own call.
create function public.qorpera_company_fence_wait_end(p_previous text, p_result jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
	perform pg_catalog.set_config('qorpera.company_fence_wait', coalesce(p_previous, ''), true);
	return p_result;
end
$$;
comment on function public.qorpera_company_fence_wait_end(text, jsonb) is
	'Puts back the caller''s qorpera.company_fence_wait as a Company File write path call returns p_result. 20260929380000.';
-- Internal: only the five below call it, as its owner.
revoke all on function public.qorpera_company_fence_wait_end(text, jsonb) from public, anon, authenticated, service_role;

-- Each of the five as it is live: its one top-level declare section saves the caller's wait, the first statement
-- after its one top-level begin sets 2 s, and each of its p_returns return statements (each ends at its first
-- semicolon) returns through the helper. Any other text refuses the migration.
create function pg_temp.company_fence_wait_patch(p_target regprocedure, p_returns integer)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
	v_declare text := E'AS $function$\ndeclare ';
	v_begin text := E'\nbegin\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_declare, ''))) / length(v_declare) <> 1
		or (length(v_definition) - length(replace(v_definition, v_begin, ''))) / length(v_begin) <> 1
		or (select count(*) from regexp_matches(v_definition, '\mreturn\M', 'gi')) <> p_returns
		or (select count(*) from regexp_matches(v_definition, '\mreturn\s+[^;]*;', 'g')) <> p_returns
		or v_definition like '%company_fence_wait%' then
		raise exception 'Company fence wait: % differs', p_target; end if;
	v_definition := regexp_replace(v_definition, '\mreturn\s+([^;]*);',
		'return public.qorpera_company_fence_wait_end(v_fence_wait, \1);', 'g');
	v_definition := replace(v_definition, v_declare,
		v_declare || E'v_fence_wait text := pg_catalog.current_setting(''qorpera.company_fence_wait'', true);\n\t');
	v_definition := replace(v_definition, v_begin, v_begin
		|| E'\t-- The write path''s fence wait, for this call only; the caller''s comes back as it ends (20260929380000).\n'
		|| E'\tperform pg_catalog.set_config(''qorpera.company_fence_wait'', ''2s'', true);\n');
	execute v_definition;
end
$$;
select pg_temp.company_fence_wait_patch(patch.target, patch.returns) from (values
	('public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure, 2),
	('public.qorpera_prepare_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure, 3),
	('public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 2),
	('public.qorpera_native_company_file_write_source(uuid,jsonb,jsonb)'::regprocedure, 1),
	('public.qorpera_native_company_file_write(uuid,jsonb,jsonb,jsonb,text,uuid,text)'::regprocedure, 4)) patch(target, returns);
