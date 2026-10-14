-- Folder core slice P13 (C1c-3m; RUNTIME-COMPANY-FOLDER-C1C.md §6, core §3 and §9): the activation checks, folder-v2
-- only (founder decision, 3 October 2026: no snapshot-v1 digests). They read the functions as installed, so every
-- hosted-db run checks them, a release branch's included:
-- 1. no folder-v2 path takes the gc fence or the company row FOR UPDATE or NOWAIT (core §3 step 3: "The profile row is
--    never locked FOR UPDATE or NOWAIT on any folder-v2 path"); the sites still to move are listed, by owner;
-- 2. every function that ends a job lease takes the job FOR UPDATE first;
-- 3. only the run mutex's functions name the run budget row, and the folder-v2 ones take it before the job (C1C §5.2);
-- 4. the folder fence is taken FOR UPDATE, FOR NO KEY UPDATE or updated only by the functions named for it, and never
--    FOR SHARE;
-- 5. the folder core's tables have no deferred constraints or triggers (core §3 step 9), and the other tables the
--    folder core writes have only the light ones listed.
-- The checks read function text with comments removed. Check 1 counts a function as checking the core when a core test
-- (a folder-v2 or snapshot-v1 literal, or a call into the folder core) comes before its first such lock; a function
-- named qorpera_folder_% never passes that way, and a function whose core test covers only some branches is listed by
-- hand. Every list fails on a stale entry, so a renamed function or table never passes silently.
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
-- open: a folder-v2 site that still takes it; its owner moves it, and then removes the line;
-- partial: a function that tests the core first, but whose core test leaves a folder-v2 branch that still takes it;
--   the order check passes it, so it is listed by hand with the text of its core test (`pin`), printed with the open
--   sites, and its owner removes the line. A changed core test fails until the line is checked again.
create temporary table p13_allowed(name text primary key,
	kind text not null check (kind in ('fence', 'legacy', 'open', 'partial')), reason text not null,
	pin text check ((kind = 'partial') = (pin is not null))) on commit drop;
insert into p13_allowed(name, kind, reason) values
	('qorpera_lock_profile_gc_fence', 'fence', 'The gc fence itself; every caller is checked.'),
	-- Legacy stores and their GC: a folder-v2 company is enabled untouched and has no snapshots, so no substrate
	-- versions; today's GC never claims its objects (20260928120000).
	('qorpera_authorize_profile_object_deletion', 'legacy', 'Company object GC, which never claims a folder-v2 company''s objects, and artifact GC, whose object claim marks a folder-v2 plan''s entries retained before any deletion (20260928120000).'),
	('qorpera_finalize_profile_object_deletion', 'legacy', 'Company object GC; never claims a folder-v2 company''s objects.'),
	('qorpera_complete_company_object_gc', 'legacy', 'Company object GC; never claims a folder-v2 company''s objects.'),
	('qorpera_renew_company_object_gc', 'legacy', 'Company object GC; never claims a folder-v2 company''s objects.'),
	('qorpera_reject_gc_substrate_version', 'legacy', 'Trigger on substrate versions; runs (P28a) and members'' captures need a company snapshot, which folder-v2 never has.'),
	-- The old Company File gateway: a folder-v2 row has no path gateway (the qorpera_company_files check, verified below).
	('qorpera_company_path_actor', 'legacy', 'Refuses 55000 on a missing path_gateway_version before the fence (both checked below).'),
	('qorpera_enable_company_path_gateway', 'legacy', 'Operator only; takes the fence, then the files check refuses a folder-v2 row.'),
	('qorpera_promote_company_file_graph_to_supabase', 'legacy', 'Old Company File graph; no folder-v2 caller.'),
	('qorpera_verify_company_path_tree', 'legacy', 'Old tree proof; its caller, the old path lane''s routes, refuses folder-v2 first (finalize_company_bootstrap went with legacy sweep D1, 20260930330000).'),
	('qorpera_wake_path_authorized', 'legacy', 'Old file wake check; folder-v2 callers dispatch to folder bodies first, and manage_agent_worker refuses at company_path_actor.'),
	('qorpera_sync_company_file_listener', 'legacy', 'Takes the fence only for an old file-wake cursor; folder-v2 file wakes use the P29 listener.'),
	('qorpera_serialize_wake_admission', 'legacy', 'Old wake admission; every caller tests the core first: the drains filter folder-v2, P28a took the old materializers out of reconcile, and the quiet coding check-ins skip folder-v2 (20260930026000).'),
	('qorpera_register_governed_company_computer', 'legacy', 'Old logical computers (C1C §13); no caller.'),
	('qorpera_register_legacy_company_computer_teardown', 'legacy', 'Old logical computers (C1C §13); no caller.'),
	-- Artifacts: every path that makes an artifact, and every member function that would take the fence over one,
	-- refuses folder-v2 first (20260930041000, pinned below), and a folder-v2 company has no snapshots. So these are
	-- reached only through a snapshot-v1 company's artifacts and snapshots.
	('qorpera_reject_profile_root_during_gc', 'legacy', 'Trigger on artifacts and snapshots; artifact registration and the office capture, export and import refuse folder-v2, and folder-v2 has no snapshots.'),
	('qorpera_reject_gc_artifact_index_entry', 'legacy', 'Trigger on artifact index entries; index creation refuses folder-v2, and it has no artifacts.'),
	('qorpera_reject_gc_artifact_retention_hold', 'legacy', 'Trigger on artifact retention holds; hold creation refuses folder-v2, and it has no artifacts.'),
	('qorpera_reject_graph_completion_during_gc', 'legacy', 'Trigger on reachability graphs; graph completion refuses folder-v2, whose roots (artifacts, snapshots) do not exist.'),
	('qorpera_claim_artifact_gc_plans', 'legacy', 'Artifact GC plans need an artifact; folder-v2 has none, and the object claim retains a folder-v2 plan''s objects (20260928120000).'),
	('qorpera_renew_artifact_gc_lease', 'legacy', 'Artifact GC plans need an artifact; folder-v2 has none.');
-- No folder-v2 site is left to move: the last one, the office waiter check, tests the core first since C1c-3l part 2
-- (20260930030100).
-- A run's own machines and the node machine's kinds all test the core since C1c-3n (20260930046000) and P13's sign-in
-- machines (20260930035000): no partial entry is left.

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
	-- A listed function that is gone, or now tests the core first, is taken off the list. The fence itself always takes
	-- the lock with no core test, so its line also proves the patterns still match. A partial entry tests the core
	-- first by definition: it comes off once it no longer takes such a lock at all.
	select string_agg(a.name, ', ' order by a.name) into v_list from p13_allowed a
	where a.kind <> 'partial' and not exists (select 1 from p13_strong s
		where s.name = a.name and s.lock_at < 1000000 and s.core_at >= s.lock_at);
	if v_list is not null then raise exception 'Take these off the P13 list (gone, or they test the core first now): %', v_list; end if;
	select string_agg(a.name, ', ' order by a.name) into v_list from p13_allowed a
	where a.kind = 'partial' and not exists (select 1 from p13_strong s where s.name = a.name and s.lock_at < 1000000);
	if v_list is not null then raise exception 'Take these off the P13 list (gone, or they no longer take the lock): %', v_list; end if;
	-- A partial entry's core test is pinned: when its owner changes it, the line is checked again (and comes off).
	select string_agg(a.name, ', ' order by a.name) into v_list from p13_allowed a
	where a.kind = 'partial' and not exists (select 1 from p13_code c where c.name = a.name and position(a.pin in c.src) > 0);
	if v_list is not null then
		raise exception 'The core test of these partial P13 sites changed: % (take the line off if folder-v2 no longer takes the lock, or pin the new test)', v_list; end if;
	-- The legacy reason the gateway entries rest on: a folder-v2 row has no path gateway, and the gateway's actor
	-- refuses a missing one before it takes the fence.
	if not exists (select 1 from pg_constraint where conrelid = 'public.qorpera_company_files'::regclass and contype = 'c'
			and pg_get_constraintdef(oid) ~ 'folder-v2.*path_gateway_version IS NULL') then
		raise exception 'The company files check that keeps the old gateway off folder-v2 is gone'; end if;
	if not exists (select 1 from p13_code where name = 'qorpera_company_path_actor'
			and position('path_gateway_version is distinct from 1' in src) between 1 and position('qorpera_lock_profile_gc_fence(' in src)) then
		raise exception 'qorpera_company_path_actor no longer refuses a missing path gateway before the fence'; end if;
	-- The artifact entries rest on these refusals (20260930041000): each comes before any write, row lock, fence or job.
	select string_agg(n, ', ' order by n) into v_list from unnest(array['qorpera_register_artifact', 'qorpera_register_artifact_v2',
		'qorpera_runner_broker_authorize_output_object', 'qorpera_runner_broker_confirm_output_object',
		'qorpera_runner_broker_register_artifact', 'qorpera_create_artifact_index', 'qorpera_create_artifact_retention_hold',
		'qorpera_complete_object_reachability_graph', 'qorpera_cancel_artifact_gc_plan']) n
	where not exists (select 1 from p13_code c where c.name = n
		and position('Artifacts do not serve folder-v2 companies' in c.src) between 1 and coalesce((select min(nullif(position(m[1] in c.src), 0))
			from regexp_matches(c.src, '(\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M|\mfor\s+(?:update|share|no\s+key\s+update|key\s+share)\M|qorpera_lock_profile_gc_fence\(|qorpera_runner_broker_locked_job\()', 'gi') m),
			1000000));
	if v_list is not null then raise exception 'These artifact functions no longer refuse folder-v2 before any lock: %', v_list; end if;
	-- The sites still to move, for whoever reads a failing run's output (the list above is the record).
	select string_agg(format('%s (%s): %s', name, kind, reason), E'\n' order by name) into v_list from p13_allowed
	where kind in ('open', 'partial');
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
declare
	-- The transcript append, receipt begin, the runner's file object check and the reservation (C1C §5.2), with the
	-- folder-v2 bodies and the folder run entry that takes the mutex for every folder-v2 tool call.
	c_mutex constant text[] := array['qorpera_append_runner_transcript_event', 'qorpera_folder_append_transcript_event',
		'qorpera_begin_run_operation_receipt', 'qorpera_folder_begin_run_receipt',
		'qorpera_runner_broker_authorize_company_file_object', 'qorpera_reserve_execution_sponsor_authority',
		'qorpera_folder_tool_run'];
	v_list text;
begin
	select string_agg(name, ', ' order by name) into v_list from p13_code
	where src ~ 'qorpera_execution_run_budgets' and name <> all (c_mutex);
	if v_list is not null then raise exception 'Only the run mutex''s functions touch the run budget row; also: %', v_list; end if;
	select string_agg(n, ', ' order by n) into v_list from unnest(c_mutex) n
	where not exists (select 1 from p13_code c where c.name = n and c.src ~ 'qorpera_execution_run_budgets');
	if v_list is not null then raise exception 'Take these off the run mutex list (gone, or no longer the mutex): %', v_list; end if;
	-- On folder-v2 the mutex comes before the job. The folder run entry takes the budget row FOR UPDATE, then enters the
	-- run (which takes the job). The run check under every runtime tool call sends folder-v2 to it before any lock of its
	-- own. The receipt begin and the transcript's callers go through one of the two before they name the row.
	if not exists (select 1 from p13_code c where c.name = 'qorpera_folder_tool_run'
			and (select min(nullif(position(m[1] in c.src), 0)) from regexp_matches(c.src,
				'(public\.qorpera_execution_run_budgets\M[^;]*\mfor\s+update\M)', 'gi') m)
				< nullif(position('public.qorpera_folder_run_enter(' in c.src), 0)) then
		raise exception 'qorpera_folder_tool_run takes the run mutex before it enters the run (and the job)'; end if;
	if not exists (select 1 from p13_code c where c.name = 'qorpera_native_tool_locked_run'
			and position('public.qorpera_folder_tool_run(' in c.src) between 1 and coalesce((select min(nullif(position(m[1] in c.src), 0))
				from regexp_matches(c.src, '(\mfor\s+(?:update|no\s+key\s+update|share|key\s+share)\M)', 'gi') m), 1000000)) then
		raise exception 'qorpera_native_tool_locked_run sends folder-v2 to qorpera_folder_tool_run before any lock of its own'; end if;
	select string_agg(c.name, ', ' order by c.name) into v_list from p13_code c
	where (c.name = 'qorpera_folder_begin_run_receipt' or c.src like '%public.qorpera_folder_append_transcript_event(%')
		and c.name <> 'qorpera_folder_append_transcript_event'
		and not (least(coalesce(nullif(position('public.qorpera_folder_tool_run(' in c.src), 0), 1000000),
				coalesce(nullif(position('public.qorpera_native_tool_locked_run(' in c.src), 0), 1000000))
			< least(coalesce(nullif(position('qorpera_execution_run_budgets' in c.src), 0), 1000000),
				coalesce(nullif(position('public.qorpera_folder_append_transcript_event(' in c.src), 0), 1000000)));
	if v_list is not null then raise exception 'These folder-v2 functions use the run mutex without taking it first: %', v_list; end if;
	-- The old mutex functions take the job before the budget row, so they refuse folder-v2 (0A000) before the job.
	select string_agg(n, ', ' order by n) into v_list
	from unnest(array['qorpera_append_runner_transcript_event', 'qorpera_begin_run_operation_receipt']) n
	where not exists (select 1 from p13_code c where c.name = n
		and position('if public.qorpera_job_is_folder_v2(p_job_id) then raise exception' in c.src)
			between 1 and position('public.qorpera_runner_broker_locked_job(' in c.src));
	if v_list is not null then raise exception 'These old run mutex functions no longer refuse folder-v2 before the job: %', v_list; end if;
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
declare
	-- FOR UPDATE, and the fence's update: the pause's and deletion's drains, and resume (core §3 step 3, C1C §5.5).
	c_update constant text[] := array['qorpera_folder_pause_drain', 'qorpera_folder_deletion_drain', 'qorpera_folder_resume'];
	-- FOR NO KEY UPDATE: what serializes member management, creation, the operator's start, founding and deletion's
	-- entry (C1C §6.1).
	c_no_key constant text[] := array['qorpera_folder_member_change_enter', 'qorpera_folder_company_create',
		'qorpera_folder_company_operator_start', 'qorpera_folder_deletion_enter', 'qorpera_lock_company_founding',
		'qorpera_open_company_founding'];
	v_list text;
begin
	select string_agg(distinct c.name, ', ' order by c.name) into v_list from p13_code c,
		regexp_matches(c.src, 'qorpera_folder_fences\M[^;]*\mfor\s+update\M', 'gi') m
	where c.name <> all (c_update);
	if v_list is not null then raise exception 'The folder fence FOR UPDATE is taken also by: %', v_list; end if;
	select string_agg(distinct c.name, ', ' order by c.name) into v_list from p13_code c,
		regexp_matches(c.src, 'update\s+public\.qorpera_folder_fences\M', 'gi') m
	where c.name <> all (c_update);
	if v_list is not null then raise exception 'The folder fence is updated also by: %', v_list; end if;
	select string_agg(distinct c.name, ', ' order by c.name) into v_list from p13_code c,
		regexp_matches(c.src, 'qorpera_folder_fences\M[^;]*\mfor\s+no\s+key\s+update\M', 'gi') m
	where c.name <> all (c_no_key);
	if v_list is not null then raise exception 'The folder fence FOR NO KEY UPDATE is taken also by: %', v_list; end if;
	-- FOR SHARE would wait for, and block, member management's NO KEY UPDATE; every other site takes KEY SHARE.
	select string_agg(distinct c.name, ', ' order by c.name) into v_list from p13_code c,
		regexp_matches(c.src, 'qorpera_folder_fences\M[^;]*\mfor\s+share\M', 'gi') m;
	if v_list is not null then raise exception 'The folder fence is taken FOR SHARE by: %', v_list; end if;
	-- Each named function still takes its mode (a renamed one fails here).
	select string_agg(n, ', ' order by n) into v_list from unnest(c_update) n
	where not exists (select 1 from p13_code c where c.name = n and c.src ~* 'qorpera_folder_fences\M[^;]*\mfor\s+update\M');
	if v_list is not null then raise exception 'Take these off the fence FOR UPDATE list: %', v_list; end if;
	select string_agg(n, ', ' order by n) into v_list from unnest(c_no_key) n
	where not exists (select 1 from p13_code c where c.name = n and c.src ~* 'qorpera_folder_fences\M[^;]*\mfor\s+no\s+key\s+update\M');
	if v_list is not null then raise exception 'Take these off the fence FOR NO KEY UPDATE list: %', v_list; end if;
end $$;

-- 5. No deferred constraints or triggers on the folder core's tables ---------------------------------------------------

do $$
declare v_list text;
begin
	select string_agg(format('%s.%s', r.relname, c.conname), ', ' order by r.relname, c.conname) into v_list
	from pg_constraint c join pg_class r on r.oid = c.conrelid
	where c.condeferrable and r.relnamespace = 'public'::regnamespace and r.relname like 'qorpera\_folder\_%';
	if v_list is not null then raise exception 'Deferrable constraints on folder core tables: %', v_list; end if;
	select string_agg(format('%s.%s', r.relname, t.tgname), ', ' order by r.relname, t.tgname) into v_list
	from pg_trigger t join pg_class r on r.oid = t.tgrelid
	where t.tgdeferrable and r.relnamespace = 'public'::regnamespace and r.relname like 'qorpera\_folder\_%';
	if v_list is not null then raise exception 'Deferrable triggers on folder core tables: %', v_list; end if;
	if (select count(*) from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace
			and relname like 'qorpera\_folder\_%') < 30 then
		raise exception 'The folder core tables check found too few tables'; end if;
end $$;

-- The other tables the folder core's functions write (insert, update or delete): their deferred constraints and
-- constraint triggers run at the commit of a folder transaction, so each is listed with why it is light. A new one
-- fails until it is listed; a listed one that is gone fails until it is removed. (A deferrable foreign key of another
-- table that references one of these is a plain RI check on delete, and is not listed.)
create temporary table p13_deferred(relname text, conname text, reason text not null, primary key (relname, conname))
	on commit drop;
insert into p13_deferred values
	('qorpera_profile_staff', 'qorpera_profile_staff_source_entry', 'A foreign key to the old path entries; a folder-v2 agent row has a folder path and so no source path (the table''s folder check), so it checks nothing.'),
	('qorpera_runner_jobs', 'qorpera_native_presence_end', 'Deletes the native presence device of a job that left leased, SKIP LOCKED: it never waits (20260928419960).'),
	('qorpera_runtime_workers', 'qorpera_runtime_workers_coding_turn_recorded', 'One indexed read of the coding turn; no lock.'),
	('qorpera_runtime_workers', 'qorpera_runtime_workers_coding_turn_sequence', 'One indexed read of the coding turn; no lock.'),
	('qorpera_session_inputs', 'qorpera_session_inputs_turn_id_fkey', 'A foreign key to session turns; a plain RI check.');

do $$
declare v_list text;
begin
	with written as (
		select distinct lower(m[1]) as relname from p13_code c, regexp_matches(c.src,
			'(?:insert\s+into|update|delete\s+from)\s+public\.(qorpera_[a-z0-9_]+)', 'gi') m
		where c.name like 'qorpera\_folder\_%'
	), deferred as (
		select r.relname::text as relname, c.conname::text as conname from written w
		join pg_class r on r.relname = w.relname and r.relnamespace = 'public'::regnamespace
		join pg_constraint c on c.conrelid = r.oid and c.condeferrable
	)
	select string_agg(format('%s.%s', d.relname, d.conname), ', ' order by d.relname, d.conname) into v_list from deferred d
	where not exists (select 1 from p13_deferred p where p.relname = d.relname and p.conname = d.conname);
	if v_list is not null then
		raise exception 'Deferred constraints on tables the folder core writes, not listed with why they are light: %', v_list; end if;
	select string_agg(format('%s.%s', p.relname, p.conname), ', ' order by p.relname, p.conname) into v_list from p13_deferred p
	where not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
		where r.relnamespace = 'public'::regnamespace and r.relname = p.relname and c.conname = p.conname and c.condeferrable);
	if v_list is not null then raise exception 'Take these off the deferred list (gone, or no longer deferrable): %', v_list; end if;
	if (select count(distinct lower(m[1])) from p13_code c, regexp_matches(c.src,
			'(?:insert\s+into|update|delete\s+from)\s+public\.(qorpera_[a-z0-9_]+)', 'gi') m
			where c.name like 'qorpera\_folder\_%') < 50 then
		raise exception 'The written-tables check found too few tables; its pattern no longer matches'; end if;
end $$;

rollback;
