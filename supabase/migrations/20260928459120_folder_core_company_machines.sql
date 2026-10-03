-- Company folder core, C1c-3f: the compute fence and company machines on the folder fence
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.1 and §6.5).
--
-- Changes only folder-v2 behaviour; snapshot-v1 keeps every path (each patch keeps the old statement in its else). On a
-- folder-v2 company no machine path takes the company row FOR UPDATE or NOWAIT any more (core §9):
-- * qorpera_folder_machine_fence(company): the folder fence KEY SHARE, then the company row KEY SHARE (rank 0). Stop and
--   resume (the fence FOR UPDATE) wait for it; member changes (FOR NO KEY UPDATE) do not. It reads no pause: the paths
--   that end a machine run while the company is paused, and the node reservation reads the pause again after it.
-- * The executor's brief fence (qorpera_company_machine_fence_briefly, under its 2 s lock_timeout) takes it. Custody
--   (suspend, release, running, commands, the executor's authorization) then locks the machine, the placement, the
--   allocation, the node and the demand; admission takes the company-machines advisory lock and the machine first, and
--   placing takes the executor row before the allocation.
-- * Placing a machine and reserving its node take it again: every caller holds it already in the same modes, so it never
--   waits. Suspend and release skip their second gc fence, which custody's folder fence replaces. The reservation's
--   folder branch serves the machine kind only: coding (C1c-3h) and office (C1c-3j) reservations still come from
--   callers that take the gc fence first.
-- * A member's start, stop or delete: the folder fence, rank 0 and the member's row KEY SHARE (rank 1), then the member's
--   write access read again, before the advisory lock and the machine. The gc fence was taken before the machine was
--   even looked up, so any member who can write could hold a folder-v2 company's row FOR UPDATE.
-- * Admission's sweep of stopped task machines takes a folder-v2 company's fence KEY SHARE NOWAIT (a company being stopped
--   is swept on a later pass), then its row KEY SHARE, never the row FOR UPDATE NOWAIT. That row waits only for a holder
--   of it stronger, which may want locks the pass holds: until C1c-3g, deletion's gc fence, which wants the company's
--   machine lock and machines next; a node update drain, which locks several companies' rows in id order. So the sweep
--   waits for a folder-v2 company's row only while the pass has given up no disk (its machine locks) and holds no other
--   company's row (from an earlier sweep); otherwise that company waits a pass.
-- * Giving up a disabled executor takes each folder-v2 company's folder fence in place of the gc fence, in id order.
-- * An agent's machine_start serves folder-v2: its authority check is the folder tool run (the run mutex, the job, the
--   fence, rank 0), then the receipt, the advisory lock, the machine and the rows admission takes.
-- Machine events still reach no folder-v2 run (qorpera_drain_machine_wakes skips it): that drain is C1c-3i's.

-- 1. Patch helper (a name unique to this migration: pg_temp lives for the whole session) ---------------------------

create function pg_temp.c1c3f_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3f patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. A machine path's company locks on folder-v2 ------------------------------------------------------------------------

create function public.qorpera_folder_machine_fence(p_profile_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	-- C1c-3f (20260930002000): the folder fence KEY SHARE, then the company row KEY SHARE (rank 0). No pause read here.
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for key share;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for key share;
	if not found then raise exception 'profile is unavailable' using errcode = '42501'; end if;
end $$;

-- 3. Patches ------------------------------------------------------------------------------------------------------------

do $$
begin
	-- The executor's brief fence: custody and admission.
	perform pg_temp.c1c3f_replace('public.qorpera_company_machine_fence_briefly(uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n',
		E'\t-- C1c-3f (20260930002000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(p_profile_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\tend if;\n', 1);

	-- Placing a machine: its callers hold the folder fence already (admission's brief fence, a run's folder tool run).
	perform pg_temp.c1c3f_replace('public.qorpera_place_company_machine(uuid,text,uuid)',
		E'\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n',
		E'\t\t-- C1c-3f (20260930002000): on folder-v2 the folder fence and the company row KEY SHARE, held by every caller.\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(v_machine.profile_id) then\n'
		|| E'\t\t\tperform public.qorpera_folder_machine_fence(v_machine.profile_id);\n'
		|| E'\t\telse\n'
		|| E'\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n'
		|| E'\t\tend if;\n', 1);

	-- Reserving a node for a machine; the pause is read again under it, as before. Other kinds keep the gc fence.
	perform pg_temp.c1c3f_replace('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
		E' perform public.qorpera_lock_profile_gc_fence(v_profile);\n',
		E' -- C1c-3f (20260930002000): a folder-v2 machine takes the folder fence and the company row KEY SHARE, held by\n'
		|| E' -- every caller; coding (C1c-3h) and office (C1c-3j) reservations still come with the gc fence.\n'
		|| E' if p_provider_kind=''machine'' and public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'  perform public.qorpera_folder_machine_fence(v_profile);\n'
		|| E' else\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(v_profile);\n'
		|| E' end if;\n', 1);

	-- Suspend and release: custody took the folder fence on folder-v2.
	perform pg_temp.c1c3f_replace('public.qorpera_suspend_company_machine(uuid,text,text,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n',
		E'\t-- C1c-3f (20260930002000): on folder-v2 custody holds the folder fence and the company row KEY SHARE.\n'
		|| E'\tif not public.qorpera_company_is_folder_v2(v_placement.profile_id) then\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3f_replace('public.qorpera_release_company_machine(uuid,text,text,text)',
		E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n',
		E'\t\t\t-- C1c-3f (20260930002000): on folder-v2 custody holds the folder fence and the company row KEY SHARE.\n'
		|| E'\t\t\tif not public.qorpera_company_is_folder_v2(v_placement.profile_id) then\n'
		|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);\n'
		|| E'\t\t\tend if;\n', 1);

	-- A member's start, stop or delete: the folder fence, rank 0, the member (rank 1), then the access read again.
	perform pg_temp.c1c3f_replace('public.qorpera_member_manage_company_machine(uuid,uuid,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n',
		E'\t-- C1c-3f (20260930002000): on folder-v2 the folder fence, the company row and the member''s row KEY SHARE, then the\n'
		|| E'\t-- member''s write access read again (a removal or a demotion that committed meanwhile refuses here).\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(p_profile_id);\n'
		|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = auth.uid() for key share;\n'
		|| E'\t\tif not public.qorpera_can_write_profile(p_profile_id) then raise exception ''Company is unavailable'' using errcode = ''42501''; end if;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\tend if;\n', 1);

	-- Admission: the companies whose machine locks the disk give-up holds, and whose rows the sweep holds, to the end of
	-- the pass (declared first, since the patches below use them).
	perform pg_temp.c1c3f_replace('public.qorpera_admit_executor_machines(text,text,integer)',
		E'\tv_busy uuid[] := ''{}'';\n',
		E'\tv_busy uuid[] := ''{}'';\n'
		|| E'\tv_gave_up uuid[] := ''{}''; v_swept uuid[] := ''{}''; -- C1c-3f (20260930002000)\n', 1);

	-- Admission's sweep of stopped task machines: never the company row FOR UPDATE NOWAIT on folder-v2.
	perform pg_temp.c1c3f_replace('public.qorpera_admit_executor_machines(text,text,integer)',
		E'\t\t\tperform 1 from public.qorpera_profiles where id = v_machine.profile_id for update nowait;\n'
		|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n',
		E'\t\t\t-- C1c-3f (20260930002000): on folder-v2 the fence KEY SHARE without waiting (a company being stopped is swept\n'
		|| E'\t\t\t-- on a later pass), then the company row KEY SHARE, which waits only for a holder of the row stronger. Until\n'
		|| E'\t\t\t-- C1c-3g that holder may be deletion (it wants the machine locks a disk give-up holds) or a node update drain (it\n'
		|| E'\t\t\t-- wants the other rows the sweep holds): with either held, the company waits a pass.\n'
		|| E'\t\t\tif public.qorpera_company_is_folder_v2(v_machine.profile_id) then\n'
		|| E'\t\t\t\tif cardinality(v_gave_up) > 0 or exists (select 1 from unnest(v_swept) as held(profile_id)\n'
		|| E'\t\t\t\t\twhere held.profile_id <> v_machine.profile_id) then raise sqlstate ''P0F04''; end if;\n'
		|| E'\t\t\t\tperform 1 from public.qorpera_folder_fences where profile_id = v_machine.profile_id for key share nowait;\n'
		|| E'\t\t\t\tif not found then raise sqlstate ''P0F04''; end if;\n'
		|| E'\t\t\t\tperform 1 from public.qorpera_profiles where id = v_machine.profile_id for key share;\n'
		|| E'\t\t\telse\n'
		|| E'\t\t\tperform 1 from public.qorpera_profiles where id = v_machine.profile_id for update nowait;\n'
		|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);\n'
		|| E'\t\t\tend if;\n'
		|| E'\t\t\tv_swept := v_swept || v_machine.profile_id; -- C1c-3f (20260930002000)\n', 1);

	-- The disk give-up records the companies whose machine lock it holds, for the sweep above.
	perform pg_temp.c1c3f_replace('public.qorpera_admit_executor_machines(text,text,integer)',
		E'\t\t\t\t\tperform 1 from public.qorpera_company_machines where id = v_asleep.machine_id and desired_state = ''stopped'' for update nowait;\n'
		|| E'\t\t\t\t\tif not found then raise sqlstate ''P0F04''; end if;\n',
		E'\t\t\t\t\tperform 1 from public.qorpera_company_machines where id = v_asleep.machine_id and desired_state = ''stopped'' for update nowait;\n'
		|| E'\t\t\t\t\tif not found then raise sqlstate ''P0F04''; end if;\n'
		|| E'\t\t\t\t\t-- C1c-3f (20260930002000): held to the end of the pass.\n'
		|| E'\t\t\t\t\tv_gave_up := v_gave_up || v_asleep.profile_id;\n', 1);

	-- Giving up a disabled executor: each folder-v2 company's folder fence, in the same id order.
	perform pg_temp.c1c3f_replace('public.qorpera_abandon_machine_executor(text,text)',
		E'\t\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n',
		E'\t\t-- C1c-3f (20260930002000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'\t\t\tperform public.qorpera_folder_machine_fence(v_profile);\n'
		|| E'\t\telse\n'
		|| E'\t\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'
		|| E'\t\tend if;\n', 1);

	-- An agent's machine_start serves folder-v2: the refusal line gives way to this marker, nothing else changes.
	perform pg_temp.c1c3f_replace('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)',
		E'\tif public.qorpera_binding_is_folder_v2(p_binding) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n',
		E'\t-- C1c-3f (20260930002000): serves folder-v2; the authority check below is then the folder tool run.\n', 1);
end $$;

-- 4. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through the machine functions.
revoke all on function public.qorpera_folder_machine_fence(uuid) from public, anon, authenticated, service_role;
