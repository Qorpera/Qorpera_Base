-- Company folder core, C1c-3h (P07 part 1; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.1, the C1c-3 inventory §11):
-- coding machines on folder-v2. Every coding machine call that needs the company takes it first (runtime v123,
-- 20260925123000): the gc fence, which locks the company row FOR UPDATE. On folder-v2 that row is rank 0 and only ever
-- KEY SHARE (core §3/§9), and a folder effect holds it KEY SHARE for its whole transaction, so the gc fence would wait for
-- every agent tool call and, once held, make every folder effect of the company wait. On folder-v2 these calls take
-- C1c-3f's qorpera_folder_machine_fence (the folder fence KEY SHARE, then the company row KEY SHARE) in the same place:
-- * qorpera_authorize_coding_machine_run (a turn's admission to its machine), before the worker;
-- * qorpera_plan_coding_machine, before the session, and again before it inserts a member's new machine (which the gc
--   fence did "so parallel new members do not both upgrade a key share": KEY SHARE is never upgraded here);
-- * qorpera_suspend_coding_machine and qorpera_release_coding_machine, before the machine.
-- qorpera_reserve_runtime_node_machine's folder branch (C1c-3f, the machine kind) now serves the coding kind too: its
-- callers hold the folder fence already, so it never waits. Office reservations (C1c-3j) keep the gc fence.
-- A folder stop's second phase (the fence FOR UPDATE) makes these calls wait at the fence, before any coding row. The
-- pause is not read here, as for the gc fence. Snapshot-v1 keeps each statement in the else branch, so the activation
-- markers of 20260925123000 stay in each body. Nothing creates a folder-v2 coding session before C3 (the worker tools
-- refuse folder-v2), so this is inert until then; C1c-3i brings the turn's admission and the drains.

create function pg_temp.c1c3h_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3h anchor found % time(s) in %, expected %: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, p_count, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
begin
	-- A turn's admission and a plan: the company before the worker or the session.
	perform pg_temp.c1c3h_replace('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;\n',
		E'\t-- C1c-3h (20260930002300): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select worker.profile_id from public.qorpera_runtime_workers worker where worker.id = p_worker_id)) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3h_replace('public.qorpera_plan_coding_machine(uuid,uuid,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;\n',
		E'\t-- C1c-3h (20260930002300): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select worker.profile_id from public.qorpera_runtime_workers worker where worker.id = p_worker_id)) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;\n'
		|| E'\tend if;\n', 1);
	-- A plan's member machine insert: already held on folder-v2 (KEY SHARE, never upgraded).
	perform pg_temp.c1c3h_replace('public.qorpera_plan_coding_machine(uuid,uuid,text)',
		E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_worker.profile_id);\n',
		E'\t\t\t-- C1c-3h (20260930002300): on folder-v2 the same KEY SHARE locks again; nothing upgrades them.\n'
		|| E'\t\t\tif public.qorpera_company_is_folder_v2(v_worker.profile_id) then\n'
		|| E'\t\t\t\tperform public.qorpera_folder_machine_fence(v_worker.profile_id);\n'
		|| E'\t\t\telse\n'
		|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_worker.profile_id);\n'
		|| E'\t\t\tend if;\n', 1);

	-- Sleep and release: the company before the machine.
	perform pg_temp.c1c3h_replace('public.qorpera_suspend_coding_machine(uuid,text,text,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;\n',
		E'\t-- C1c-3h (20260930002300): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select machine.profile_id from public.qorpera_coding_machines machine where machine.id = p_machine_id)) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3h_replace('public.qorpera_release_coding_machine(uuid,text,text,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;\n',
		E'\t-- C1c-3h (20260930002300): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select machine.profile_id from public.qorpera_coding_machines machine where machine.id = p_machine_id)) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;\n'
		|| E'\tend if;\n', 1);

	-- The node reservation: the coding kind joins C1c-3f's folder branch; its callers above hold the folder fence.
	perform pg_temp.c1c3h_replace('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
		E' -- every caller; coding (C1c-3h) and office (C1c-3j) reservations still come with the gc fence.\n'
		|| E' if p_provider_kind=''machine'' and public.qorpera_company_is_folder_v2(v_profile) then\n',
		E' -- every caller. C1c-3h (20260930002300): the coding kind takes it too; office (C1c-3j) reservations still come\n'
		|| E' -- with the gc fence.\n'
		|| E' if p_provider_kind in (''machine'', ''coding'') and public.qorpera_company_is_folder_v2(v_profile) then\n', 1);
end $$;
