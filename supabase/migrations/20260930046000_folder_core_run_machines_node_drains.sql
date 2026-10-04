-- Company folder core, C1c-3n (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.15; found by P13's activation check,
-- test 838): a run's machine and the node updates on the folder core's order, folder-v2 only.
--
-- These still took the gc fence (the company row FOR UPDATE) on folder-v2, which every folder effect holds KEY SHARE:
-- * a run's machine reservation (qorpera_reserve_runtime_machine with a run): since P28 materializes folder-v2 runs, every
--   run's machine start made the company's effects wait and waited for them;
-- * the node reservation of a run's machine (qorpera_reserve_runtime_node_machine, kind 'native') and every machine
--   release (qorpera_release_runtime_machine);
-- * the three node-update steps (qorpera_authorize_node_update_drain, qorpera_node_update_locked, the updater's poll,
--   and qorpera_release_node_update_admission), each for every company on the node, in one transaction.
-- On folder-v2 now:
-- * The run's reservation keeps its job FOR UPDATE first, then takes the folder fence and the company row KEY SHARE
--   (qorpera_folder_machine_fence; the pause is read after the locks, as before), the run's requester's member row KEY
--   SHARE (rank 1) and the identity's machine lock: the transaction advisory lock
--   hashtextextended('qorpera.identity-machine:' || <compute identity id>::text, 0) that a sign-in's machine takes too
--   (20260930035000), so a run's and a sign-in's machine of one identity serialize, as the gc fence made them before.
--   Then the run, the runner and the allocation as before.
-- * The node reservation of a run's machine and a release take the machine fence and rank 0, then their rows.
-- * The node-update steps take each company's folder fence KEY SHARE, in company-id order, and nothing stronger: no
--   company row. A stop's second phase or a resume (the fence FOR UPDATE) waits for them, so the node's pause proof (every
--   company on the node paused) holds while it is recorded and checked; effects, admission and machine reservations
--   (KEY SHARE) never wait. The node rows come after every company's fence, as before.
-- A company that is not folder-v2 keeps the gc fence in each else branch, untested (folder-v2 only since 3 Oct). Every
-- patched body carries the marker 20260930046000.

create function pg_temp.c1c3n_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C1c-3n anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A run's machine reservation ----------------------------------------------------------------------------------------

select pg_temp.c1c3n_replace('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)',
	$old$	if p_run_id is null and public.qorpera_company_is_folder_v2(v_profile) then
		perform public.qorpera_folder_machine_fence(v_profile);
	else
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	end if;$old$,
	$new$	if p_run_id is null and public.qorpera_company_is_folder_v2(v_profile) then
		perform public.qorpera_folder_machine_fence(v_profile);
	-- C1c-3n (20260930046000): a folder-v2 run's machine, after its job: the folder fence and rank 0, the run's requester
	-- (rank 1), then the identity's machine lock, which a sign-in's machine of the identity takes too (20260930035000).
	elsif public.qorpera_company_is_folder_v2(v_profile) then
		perform public.qorpera_folder_machine_fence(v_profile);
		perform 1 from public.qorpera_profile_members member
		where member.profile_id = v_profile
			and member.user_id = (select run.requested_by_user_id from public.qorpera_execution_runs run where run.id = p_run_id)
		for key share;
		perform pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' || run.compute_identity_id::text, 0))
		from public.qorpera_execution_runs run where run.id = p_run_id and run.compute_identity_id is not null;
	else
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	end if;$new$);

-- 2. The node reservation of a run's machine --------------------------------------------------------------------------

select pg_temp.c1c3n_replace('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$  perform public.qorpera_folder_machine_fence(v_profile);
 else
 perform public.qorpera_lock_profile_gc_fence(v_profile);
 end if;$old$,
	$new$  perform public.qorpera_folder_machine_fence(v_profile);
 -- C1c-3n (20260930046000): a folder-v2 run's machine (its company reservation took the identity's machine lock).
 elsif p_provider_kind = 'native' and public.qorpera_company_is_folder_v2(v_profile) then
  perform public.qorpera_folder_machine_fence(v_profile);
 else
 perform public.qorpera_lock_profile_gc_fence(v_profile);
 end if;$new$);

-- 3. A machine's release ------------------------------------------------------------------------------------------------

select pg_temp.c1c3n_replace('public.qorpera_release_runtime_machine(uuid,text,text)',
	$old$		perform public.qorpera_lock_profile_gc_fence(v_profile);
		select * into strict v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;$old$,
	$new$		-- C1c-3n (20260930046000): on folder-v2 the folder fence and the company row KEY SHARE, then the allocation.
		if public.qorpera_company_is_folder_v2(v_profile) then
			perform public.qorpera_folder_machine_fence(v_profile);
		else
		perform public.qorpera_lock_profile_gc_fence(v_profile);
		end if;
		select * into strict v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;$new$);

-- 4. The node-update steps: each company's folder fence KEY SHARE, in company-id order ---------------------------------

do $$
declare v_target regprocedure;
begin
	foreach v_target in array array['public.qorpera_authorize_node_update_drain(uuid,text,text)',
		'public.qorpera_node_update_locked(uuid,bigint,text,text)',
		'public.qorpera_release_node_update_admission(uuid,text,bigint,text)']::regprocedure[] loop
		perform pg_temp.c1c3n_replace(v_target,
			$old$ for v_company in select x from unnest(t.company_ids) x order by x loop perform public.qorpera_lock_profile_gc_fence(v_company); end loop;$old$,
			$new$ -- C1c-3n (20260930046000): a folder-v2 company's fence KEY SHARE alone, in company-id order. A stop's second phase or
 -- a resume (the fence FOR UPDATE) waits, so the node's pause proof holds; effects and admission (KEY SHARE) never do.
 for v_company in select x from unnest(t.company_ids) x order by x loop
  if public.qorpera_company_is_folder_v2(v_company) then
   perform 1 from public.qorpera_folder_fences where profile_id = v_company for key share;
   if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
  else
  perform public.qorpera_lock_profile_gc_fence(v_company);
  end if;
 end loop;$new$);
	end loop;
end $$;
