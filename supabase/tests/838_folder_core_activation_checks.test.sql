-- Folder core slice P13 (C1c-3m; RUNTIME-COMPANY-FOLDER-C1C.md §6, core §3 and §9): the activation checks, folder-v2
-- only (founder decision, 3 October 2026: no snapshot-v1 digests). They read the functions as installed, so every
-- hosted-db run checks them, a release branch's included:
-- 1. no folder-v2 path takes the gc fence or the company row FOR UPDATE or NOWAIT (core §3 step 3: "The profile row is
--    never locked FOR UPDATE or NOWAIT on any folder-v2 path"); the sites still to move are listed, by owner;
-- 2. every function that ends a job lease takes the job FOR UPDATE first;
-- 3. only the run mutex's functions name the run budget row, and the folder-v2 ones take it before the job (C1C §5.2);
-- 4. the folder fence is taken FOR UPDATE and FOR NO KEY UPDATE only by the functions named for it;
-- 5. the folder core's tables have no deferred constraints or triggers (core §3 step 9).
-- The checks read function text with comments removed. Check 1 counts a function as checking the core when a core test
-- (a folder-v2 or snapshot-v1 literal, or a call into the folder core) comes before its first such lock; a function
-- named qorpera_folder_% never passes that way.
begin;

-- Each function's text without comments, so a comment never counts as code.
create temporary table p13_code on commit drop as
select p.oid, p.proname::text as name,
	regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'gs'), '--[^\n]*', '', 'g') as src
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prolang <> 12 and p.proname like 'qorpera\_%';

-- 1. The gc fence and the company row --------------------------------------------------------------------------------

-- Where a function first takes the gc fence, or the company row FOR UPDATE or NOWAIT, and where it first tests the core.
create temporary table p13_strong on commit drop as
select c.name, least(
		coalesce(nullif(position('qorpera_lock_profile_gc_fence(' in c.src), 0), 1000000),
		coalesce((select min(nullif(position(m[1] in c.src), 0)) from regexp_matches(c.src,
			'(public\.qorpera_profiles\M[^;]*\mfor\s+update\M)', 'gi') m), 1000000),
		coalesce((select min(nullif(position(m[1] in c.src), 0)) from regexp_matches(c.src,
			'(public\.qorpera_profiles\M[^;]*\mnowait\M)', 'gi') m), 1000000)) as lock_at,
	coalesce((select min(nullif(position(t in c.src), 0)) from unnest(array['folder-v2', 'folder_v2', 'snapshot-v1',
		'public.qorpera_folder_']) t), 1000000) as core_at
from p13_code c;

-- The functions that take such a lock with no core test before it, each with why it is allowed:
-- fence: the gc fence itself (each of its callers is checked here);
-- legacy: reached only on snapshot-v1 (the reason says why), removed in the old-code cleanup pass;
-- open: a folder-v2 site that still takes it; its owner moves it, and then removes the line.
create temporary table p13_allowed(name text primary key, kind text not null check (kind in ('fence', 'legacy', 'open')),
	reason text not null) on commit drop;
insert into p13_allowed values
	('qorpera_lock_profile_gc_fence', 'fence', 'The gc fence itself; every caller is checked.'),
	-- Legacy stores and their GC: a folder-v2 company is enabled untouched, has no artifacts, snapshots, substrate
	-- versions or graphs, and today's GC never claims its objects (20260928120000).
	('qorpera_authorize_profile_object_deletion', 'legacy', 'Company object GC; never claims a folder-v2 company''s objects.'),
	('qorpera_finalize_profile_object_deletion', 'legacy', 'Company object GC; never claims a folder-v2 company''s objects.'),
	('qorpera_complete_company_object_gc', 'legacy', 'Company object GC; never claims a folder-v2 company''s objects.'),
	('qorpera_renew_company_object_gc', 'legacy', 'Company object GC; never claims a folder-v2 company''s objects.'),
	('qorpera_cancel_artifact_gc_plan', 'legacy', 'Artifact GC; a folder-v2 company has no artifacts.'),
	('qorpera_claim_artifact_gc_plans', 'legacy', 'Artifact GC; retains everything of a folder-v2 company.'),
	('qorpera_renew_artifact_gc_lease', 'legacy', 'Artifact GC; a folder-v2 company has no artifacts.'),
	('qorpera_reject_gc_artifact_index_entry', 'legacy', 'Trigger on artifact index entries; no folder-v2 writer.'),
	('qorpera_reject_gc_artifact_retention_hold', 'legacy', 'Trigger on artifact retention holds; no folder-v2 writer.'),
	('qorpera_reject_gc_substrate_version', 'legacy', 'Trigger on substrate versions; folder-v2 runs have none (P28a).'),
	('qorpera_reject_graph_completion_during_gc', 'legacy', 'Trigger on reachability graphs; no folder-v2 writer.'),
	('qorpera_reject_profile_root_during_gc', 'legacy', 'Trigger on artifacts and snapshots; every byte feature refuses folder-v2 before it writes (C1D §9.3).'),
	-- The old Company File gateway: a folder-v2 row has no path gateway (the qorpera_company_files check, verified below).
	('qorpera_company_path_actor', 'legacy', 'Refuses 55000 before the fence: a folder-v2 company has no path_gateway_version.'),
	('qorpera_enable_company_path_gateway', 'legacy', 'Enables the old gateway; the files check refuses it on folder-v2.'),
	('qorpera_promote_company_file_graph_to_supabase', 'legacy', 'Old Company File graph; no folder-v2 caller.'),
	('qorpera_verify_company_path_tree', 'legacy', 'Old tree proof; its caller finalize_company_bootstrap refuses folder-v2 (C1c-1).'),
	('qorpera_wake_path_authorized', 'legacy', 'Old file wake check; folder-v2 callers dispatch to folder bodies first, and manage_agent_worker refuses at company_path_actor.'),
	('qorpera_sync_company_file_listener', 'legacy', 'Takes the fence only for an old file-wake cursor; folder-v2 file wakes use the P29 listener.'),
	('qorpera_serialize_wake_admission', 'legacy', 'Old wake admission; its drains test the core first and P28a took the old materializers out of reconcile. One folder-v2 caller is open: ask_quiet_coding_sessions (S3, C1c-3i).'),
	('qorpera_register_governed_company_computer', 'legacy', 'Old logical computers (C1C §13); no caller.'),
	('qorpera_register_legacy_company_computer_teardown', 'legacy', 'Old logical computers (C1C §13); no caller.'),
	-- Folder-v2 sites still to move (C1c-3 inventory §16, and the office and coding slices).
	('qorpera_office_waiter_authorized', 'open', 'Office activation wakes (A1, C1c-3l).'),
	('qorpera_runtime_office_access_status', 'open', 'Office access (A1, C1c-3k part 2).'),
	('qorpera_set_runtime_office_access', 'open', 'Office access (A1, C1c-3k part 2).'),
	('qorpera_release_runtime_machine', 'open', 'Run machine release (§16; owner to be named).'),
	('qorpera_reserve_runtime_login_machine', 'open', 'Model login machine (§16; owner to be named).'),
	('qorpera_release_runtime_login_machine', 'open', 'Model login machine (§16; owner to be named).'),
	('qorpera_reserve_runtime_account_refresh_machine', 'open', 'Account refresh machine (§16; owner to be named).'),
	('qorpera_release_runtime_account_refresh_machine', 'open', 'Account refresh machine (§16; owner to be named).'),
	('qorpera_activate_identity_recovery', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_cancel_identity_recovery', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_consent_identity_recovery', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_request_identity_recovery', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_request_login_identity_recovery', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_request_account_refresh_identity_recovery', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_register_identity_recovery_target', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_prepare_identity_key_backup', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_recovery_locked', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_recovery_member_role', 'open', 'Identity recovery (§16; owner to be named).'),
	('qorpera_confirm_runtime_identity_retirement', 'open', 'Identity retirement (§16; owner to be named).'),
	('qorpera_authorize_node_update_drain', 'open', 'Node update drain (§16; owner to be named).'),
	('qorpera_node_update_locked', 'open', 'Node update drain (§16; owner to be named).'),
	('qorpera_release_node_update_admission', 'open', 'Node update drain (§16; owner to be named).');

do $$
declare v_list text;
begin
	-- No function of the folder core takes such a lock at all.
	select string_agg(name, ', ' order by name) into v_list from p13_strong
	where lock_at < 1000000 and name like 'qorpera\_folder\_%';
	if v_list is not null then
		raise exception 'Folder core functions take the gc fence or the company row FOR UPDATE or NOWAIT: %', v_list; end if;
	-- Every other function that takes one tests the core first, or is listed.
	select string_agg(s.name, ', ' order by s.name) into v_list from p13_strong s
	where s.lock_at < 1000000 and s.core_at >= s.lock_at and not exists (select 1 from p13_allowed a where a.name = s.name);
	if v_list is not null then
		raise exception 'These take the gc fence or the company row FOR UPDATE or NOWAIT before testing the core: % (a folder-v2 path must take the company row KEY SHARE only, core §3)', v_list; end if;
	-- A listed function that is gone, or now tests the core first, is taken off the list.
	select string_agg(a.name, ', ' order by a.name) into v_list from p13_allowed a
	where a.kind <> 'fence' and not exists (select 1 from p13_strong s
		where s.name = a.name and s.lock_at < 1000000 and s.core_at >= s.lock_at);
	if v_list is not null then raise exception 'Take these off the P13 list (gone, or they test the core first now): %', v_list; end if;
	-- The legacy reason the gateway entries rest on: a folder-v2 row has no path gateway.
	if not exists (select 1 from pg_constraint where conrelid = 'public.qorpera_company_files'::regclass and contype = 'c'
			and pg_get_constraintdef(oid) ~ 'folder-v2.*path_gateway_version IS NULL') then
		raise exception 'The company files check that keeps the old gateway off folder-v2 is gone'; end if;
	select string_agg(format('%s: %s', name, reason), E'\n' order by name) into v_list from p13_allowed where kind = 'open';
	if v_list is not null then raise notice E'P13 open folder-v2 sites (each takes the gc fence or the company row FOR UPDATE or NOWAIT):\n%', v_list; end if;
end $$;

-- 2. Lease-ending functions take the job FOR UPDATE first ------------------------------------------------------------

do $$
declare v_list text;
begin
	-- A function that changes a job's status or lease owner (runner, client lease) must have taken the job FOR UPDATE
	-- before, or in the same statement (a locking subquery): the lock that waits out every effect holding the job
	-- KEY SHARE (C1C §5.2). Renewal changes only the expiry.
	select string_agg(name, ', ' order by name) into v_list from (
		select c.name, c.src,
			(select min(nullif(position(m[1] in c.src), 0)) from regexp_matches(c.src,
				'(update\s+public\.qorpera_runner_jobs\M[^;]*\mset\M[^;]*\m(?:status|runner_id|client_lease_id)\s*=)', 'gi') m) as change_at,
			(select min(nullif(position(m[1] in c.src), 0)) from regexp_matches(c.src,
				'(public\.qorpera_runner_jobs\M[^;]*\mfor\s+update\M)', 'gi') m) as lock_at
		from p13_code c) j
	where j.change_at is not null and (j.lock_at is null
		or (j.lock_at > j.change_at and position(';' in substr(j.src, j.change_at, j.lock_at - j.change_at)) > 0));
	if v_list is not null then raise exception 'These change a job''s lease without taking it FOR UPDATE first: %', v_list; end if;
	if (select count(*) from p13_code where src ~* 'update\s+public\.qorpera_runner_jobs\M[^;]*\mset\M[^;]*\m(status|runner_id|client_lease_id)\s*=') < 5 then
		raise exception 'The lease-ending check found too few functions; its pattern no longer matches'; end if;
end $$;

-- 3. The run mutex ---------------------------------------------------------------------------------------------------

do $$
declare v_list text;
begin
	select string_agg(name, ', ' order by name) into v_list from p13_code
	where src ~ 'qorpera_execution_run_budgets' and name <> all (array[
		-- The transcript append, receipt begin, the runner's file object check and the reservation (C1C §5.2), with the
		-- folder-v2 bodies and the folder run entry that takes the mutex for every folder-v2 tool call.
		'qorpera_append_runner_transcript_event', 'qorpera_folder_append_transcript_event',
		'qorpera_begin_run_operation_receipt', 'qorpera_folder_begin_run_receipt',
		'qorpera_runner_broker_authorize_company_file_object', 'qorpera_reserve_execution_sponsor_authority',
		'qorpera_folder_tool_run']);
	if v_list is not null then raise exception 'Only the run mutex''s functions touch the run budget row; also: %', v_list; end if;
	-- On folder-v2 the mutex comes before the job.
	select string_agg(name, ', ' order by name) into v_list from (
		select c.name, position('qorpera_execution_run_budgets' in c.src) as mutex_at,
			(select min(nullif(position(m[1] in c.src), 0)) from regexp_matches(c.src,
				'(public\.qorpera_runner_jobs\M[^;]*\mfor\s+(?:update|no\s+key\s+update|share|key\s+share)\M)', 'gi') m) as job_at
		from p13_code c where c.name like 'qorpera\_folder\_%' and c.src ~ 'qorpera_execution_run_budgets') f
	where f.job_at is not null and f.job_at < f.mutex_at;
	if v_list is not null then raise exception 'These folder-v2 functions lock the job before the run mutex: %', v_list; end if;
end $$;

-- 4. The folder fence's strong modes ----------------------------------------------------------------------------------

do $$
declare v_list text;
begin
	-- FOR UPDATE: stop and resume, and deletion's drain (core §3 step 3, C1C §5.5).
	select string_agg(distinct c.name, ', ' order by c.name) into v_list from p13_code c,
		regexp_matches(c.src, 'qorpera_folder_fences\M[^;]*\mfor\s+update\M', 'gi') m
	where c.name <> all (array['qorpera_folder_pause_drain', 'qorpera_folder_deletion_drain', 'qorpera_folder_resume']);
	if v_list is not null then raise exception 'The folder fence FOR UPDATE is taken also by: %', v_list; end if;
	-- FOR NO KEY UPDATE: what serializes member management, creation, founding and deletion's entry (C1C §6.1).
	select string_agg(distinct c.name, ', ' order by c.name) into v_list from p13_code c,
		regexp_matches(c.src, 'qorpera_folder_fences\M[^;]*\mfor\s+no\s+key\s+update\M', 'gi') m
	where c.name <> all (array['qorpera_folder_member_change_enter', 'qorpera_folder_company_create',
		'qorpera_folder_company_operator_start', 'qorpera_folder_deletion_enter', 'qorpera_lock_company_founding',
		'qorpera_open_company_founding']);
	if v_list is not null then raise exception 'The folder fence FOR NO KEY UPDATE is taken also by: %', v_list; end if;
end $$;

-- 5. No deferred constraints or triggers on the folder core's tables ---------------------------------------------------

do $$
declare v_list text;
begin
	select string_agg(format('%s.%s', conrelid::regclass, conname), ', ') into v_list from pg_constraint
	where condeferrable and conrelid::regclass::text like 'qorpera\_folder\_%';
	if v_list is not null then raise exception 'Deferrable constraints on folder core tables: %', v_list; end if;
	select string_agg(format('%s.%s', tgrelid::regclass, tgname), ', ') into v_list from pg_trigger
	where tgdeferrable and tgrelid::regclass::text like 'qorpera\_folder\_%';
	if v_list is not null then raise exception 'Deferrable triggers on folder core tables: %', v_list; end if;
	if (select count(*) from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace
			and relname like 'qorpera\_folder\_%') < 30 then
		raise exception 'The folder core tables check found too few tables'; end if;
end $$;

rollback;
