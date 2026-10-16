-- 20260930292000: the legacy sweep, step F2c (machines). Twenty-one functions keep only their folder-v2 path
-- (folder-v2 only, the founder's decision of 3 October). Each is patched in place from its live text, so its header,
-- its grants and the other migrations' changes to it stay; each anchor must occur exactly once.
-- 1. A company machine (placed, managed, released, put to sleep or given up), a coding machine (planned, admitted,
--    released, put to sleep), an office or run machine's reservation, the node reservation of every kind, and the
--    node update's drain, admission and lock take the folder fence and the folder-v2 locks on every company; the
--    snapshot-v1 branch, the profile gc fence, goes. A company without a folder now fails in the fence ("Company
--    folder is unavailable", 42501); the machine sweep skips it, and a machine placement is refused (NODE_UNAVAILABLE).
-- 2. An office machine's Company File is the folder core's (core = 'folder-v2'); the old path gateway's file
--    (path_gateway_version = 1) goes.
-- 3. Machine and coding check-ins ask on every company, not only on folder-v2.
-- The coding session claim's folder-v2 filter and the coding worker locks' refusal of other companies stay (step G).
-- Every patched body names this migration (20260930292000), and every earlier marker in it stays.

set local lock_timeout = '3s';

create function pg_temp.f2c_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep F2c anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The folder fence and the folder-v2 locks, without their test or the profile gc fence. ----------------------------

select pg_temp.f2c_patch('public.qorpera_abandon_machine_executor(text,text)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(v_profile) then
			perform public.qorpera_folder_machine_fence(v_profile);
		else
		perform public.qorpera_lock_profile_gc_fence(v_profile);
		end if;
$old$,
$new$		-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
		perform public.qorpera_folder_machine_fence(v_profile);
$new$);

select pg_temp.f2c_patch('public.qorpera_admit_executor_machines(text,text,integer)'::regprocedure,
$old$			if public.qorpera_company_is_folder_v2(v_machine.profile_id) then
				if cardinality(v_gave_up) > 0 or exists (select 1 from unnest(v_swept) as held(profile_id)
					where held.profile_id <> v_machine.profile_id) then raise sqlstate 'P0F04'; end if;
				perform 1 from public.qorpera_folder_fences where profile_id = v_machine.profile_id for key share nowait;
				if not found then raise sqlstate 'P0F04'; end if;
				perform 1 from public.qorpera_profiles where id = v_machine.profile_id for key share;
			else
			perform 1 from public.qorpera_profiles where id = v_machine.profile_id for update nowait;
			perform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);
			end if;
$old$,
$new$			-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
			if cardinality(v_gave_up) > 0 or exists (select 1 from unnest(v_swept) as held(profile_id)
				where held.profile_id <> v_machine.profile_id) then raise sqlstate 'P0F04'; end if;
			perform 1 from public.qorpera_folder_fences where profile_id = v_machine.profile_id for key share nowait;
			if not found then raise sqlstate 'P0F04'; end if;
			perform 1 from public.qorpera_profiles where id = v_machine.profile_id for key share;
$new$);

select pg_temp.f2c_patch('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select worker.profile_id from public.qorpera_runtime_workers worker where worker.id = p_worker_id)) then
		perform public.qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
	else
	perform public.qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
	end if;
$old$,
$new$	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
$new$);

select pg_temp.f2c_patch('public.qorpera_authorize_node_update_drain(uuid,text,text)'::regprocedure,
$old$  if public.qorpera_company_is_folder_v2(v_company) then
   perform 1 from public.qorpera_folder_fences where profile_id = v_company for key share;
   if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
  else
  perform public.qorpera_lock_profile_gc_fence(v_company);
  end if;
$old$,
$new$  -- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
  perform 1 from public.qorpera_folder_fences where profile_id = v_company for key share;
  if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
$new$);

select pg_temp.f2c_patch('public.qorpera_company_machine_fence_briefly(uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(p_profile_id) then
		perform public.qorpera_folder_machine_fence(p_profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	end if;
$old$,
$new$	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(p_profile_id);
$new$);

select pg_temp.f2c_patch('public.qorpera_member_manage_company_machine(uuid,uuid,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(p_profile_id) then
		perform public.qorpera_folder_machine_fence(p_profile_id);
		perform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = auth.uid() for key share;
		if not public.qorpera_can_write_profile(p_profile_id) then raise exception 'Company is unavailable' using errcode = '42501'; end if;
	else
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	end if;
$old$,
$new$	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(p_profile_id);
	perform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = auth.uid() for key share;
	if not public.qorpera_can_write_profile(p_profile_id) then raise exception 'Company is unavailable' using errcode = '42501'; end if;
$new$);

select pg_temp.f2c_patch('public.qorpera_node_update_locked(uuid,bigint,text,text)'::regprocedure,
$old$  if public.qorpera_company_is_folder_v2(v_company) then
   perform 1 from public.qorpera_folder_fences where profile_id = v_company for key share;
   if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
  else
  perform public.qorpera_lock_profile_gc_fence(v_company);
  end if;
$old$,
$new$  -- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
  perform 1 from public.qorpera_folder_fences where profile_id = v_company for key share;
  if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
$new$);

select pg_temp.f2c_patch('public.qorpera_place_company_machine(uuid,text,uuid)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(v_machine.profile_id) then
			perform public.qorpera_folder_machine_fence(v_machine.profile_id);
		else
		perform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);
		end if;
$old$,
$new$		-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
		perform public.qorpera_folder_machine_fence(v_machine.profile_id);
$new$);

select pg_temp.f2c_patch('public.qorpera_plan_coding_machine(uuid,uuid,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select worker.profile_id from public.qorpera_runtime_workers worker where worker.id = p_worker_id)) then
		perform public.qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
	else
	perform public.qorpera_lock_profile_gc_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
	end if;
$old$,
$new$	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
$new$);

select pg_temp.f2c_patch('public.qorpera_plan_coding_machine(uuid,uuid,text)'::regprocedure,
$old$			if public.qorpera_company_is_folder_v2(v_worker.profile_id) then
				perform public.qorpera_folder_machine_fence(v_worker.profile_id);
			else
			perform public.qorpera_lock_profile_gc_fence(v_worker.profile_id);
			end if;
$old$,
$new$			-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
			perform public.qorpera_folder_machine_fence(v_worker.profile_id);
$new$);

select pg_temp.f2c_patch('public.qorpera_release_coding_machine(uuid,text,text,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select machine.profile_id from public.qorpera_coding_machines machine where machine.id = p_machine_id)) then
		perform public.qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
	else
	perform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
	end if;
$old$,
$new$	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
$new$);

select pg_temp.f2c_patch('public.qorpera_release_node_update_admission(uuid,text,bigint,text)'::regprocedure,
$old$  if public.qorpera_company_is_folder_v2(v_company) then
   perform 1 from public.qorpera_folder_fences where profile_id = v_company for key share;
   if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
  else
  perform public.qorpera_lock_profile_gc_fence(v_company);
  end if;
$old$,
$new$  -- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
  perform 1 from public.qorpera_folder_fences where profile_id = v_company for key share;
  if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
$new$);

select pg_temp.f2c_patch('public.qorpera_release_runtime_machine(uuid,text,text)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(v_profile) then
			perform public.qorpera_folder_machine_fence(v_profile);
		else
		perform public.qorpera_lock_profile_gc_fence(v_profile);
		end if;
$old$,
$new$		-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
		perform public.qorpera_folder_machine_fence(v_profile);
$new$);

select pg_temp.f2c_patch('public.qorpera_suspend_coding_machine(uuid,text,text,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select machine.profile_id from public.qorpera_coding_machines machine where machine.id = p_machine_id)) then
		perform public.qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
	else
	perform public.qorpera_lock_profile_gc_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
	end if;
$old$,
$new$	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id;
$new$);

select pg_temp.f2c_patch('public.qorpera_suspend_runtime_node_machine(uuid,text,text,text,text,uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_profile) then
		perform public.qorpera_folder_machine_fence(v_profile);
	else
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	end if;
$old$,
$new$	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_profile);
$new$);

select pg_temp.f2c_patch('public.qorpera_release_company_machine(uuid,text,text,text)'::regprocedure,
$old$			-- C1c-3f (20260930002000): on folder-v2 custody holds the folder fence and the company row KEY SHARE.
			if not public.qorpera_company_is_folder_v2(v_placement.profile_id) then
			perform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);
			end if;
$old$,
$new$			-- C1c-3f (20260930002000): custody holds the folder fence and the company row KEY SHARE. Legacy sweep F2c
			-- (20260930292000) removed the profile gc fence a snapshot-v1 company took here.
$new$);

select pg_temp.f2c_patch('public.qorpera_suspend_company_machine(uuid,text,text,text)'::regprocedure,
$old$	-- C1c-3f (20260930002000): on folder-v2 custody holds the folder fence and the company row KEY SHARE.
	if not public.qorpera_company_is_folder_v2(v_placement.profile_id) then
	perform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);
	end if;
$old$,
$new$	-- C1c-3f (20260930002000): custody holds the folder fence and the company row KEY SHARE. Legacy sweep F2c
	-- (20260930292000) removed the profile gc fence a snapshot-v1 company took here.
$new$);

select pg_temp.f2c_patch('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure,
$old$	-- C1c-3j (20260930012000): a folder-v2 office takes the folder fence and the company row KEY SHARE.
	if p_run_id is null and public.qorpera_company_is_folder_v2(v_profile) then
		perform public.qorpera_folder_machine_fence(v_profile);
	-- C1c-3n (20260930046000): a folder-v2 run's machine, after its job: the folder fence and rank 0, the run's requester
	-- (rank 1), then the identity's machine lock, which a sign-in's machine of the identity takes too (20260930035000).
	elsif public.qorpera_company_is_folder_v2(v_profile) then
		perform public.qorpera_folder_machine_fence(v_profile);
		perform 1 from public.qorpera_profile_members member
$old$,
$new$	-- C1c-3j (20260930012000): an office takes the folder fence and the company row KEY SHARE.
	-- C1c-3n (20260930046000): a run's machine, after its job: the folder fence and rank 0, the run's requester
	-- (rank 1), then the identity's machine lock, which a sign-in's machine of the identity takes too (20260930035000).
	-- 20260930292000 (legacy sweep F2c): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_profile);
	if p_run_id is not null then
		perform 1 from public.qorpera_profile_members member
$new$);

select pg_temp.f2c_patch('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure,
$old$		from public.qorpera_execution_runs run where run.id = p_run_id and run.compute_identity_id is not null;
	else
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	end if;
$old$,
$new$		from public.qorpera_execution_runs run where run.id = p_run_id and run.compute_identity_id is not null;
	end if;
$new$);

select pg_temp.f2c_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure,
$old$ -- C1c-3f (20260930002000): a folder-v2 machine takes the folder fence and the company row KEY SHARE, held by
 -- every caller. C1c-3h (20260930002300): the coding kind takes it too, and C1c-3j (20260930012000) the
 -- office kind. 20260930035000: a sign-in's or refresh's login machine too (the gateway's own call, after the
 -- company reservation).
 if p_provider_kind in ('machine', 'coding', 'office', 'login') and public.qorpera_company_is_folder_v2(v_profile) then
  perform public.qorpera_folder_machine_fence(v_profile);
 -- C1c-3n (20260930046000): a folder-v2 run's machine (its company reservation took the identity's machine lock).
 elsif p_provider_kind = 'native' and public.qorpera_company_is_folder_v2(v_profile) then
  perform public.qorpera_folder_machine_fence(v_profile);
 else
 perform public.qorpera_lock_profile_gc_fence(v_profile);
 end if;
$old$,
$new$ -- C1c-3f (20260930002000): a machine takes the folder fence and the company row KEY SHARE, held by
 -- every caller. C1c-3h (20260930002300): the coding kind takes it too, and C1c-3j (20260930012000) the
 -- office kind. 20260930035000: a sign-in's or refresh's login machine too (the gateway's own call, after the
 -- company reservation). C1c-3n (20260930046000): a run's machine (its company reservation took the identity's
 -- machine lock). Legacy sweep F2c (20260930292000): folder-v2 only, so every kind on every company takes it.
 perform public.qorpera_folder_machine_fence(v_profile);
$new$);

-- 2. The Company File an office machine needs is the folder core's. ---------------------------------------------------

select pg_temp.f2c_patch('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3j 20260930012000 */)$old$,
$new$core='folder-v2' /* C1c-3j 20260930012000; only it since 20260930292000 */$new$);

-- 3. Machine and coding check-ins ask on every company. ---------------------------------------------------------------

select pg_temp.f2c_patch('public.qorpera_coding_busy_checkins_unasked(uuid)'::regprocedure,
$old$	-- 20260930109000.
$old$,
$new$	-- 20260930109000; legacy sweep F2c (20260930292000) asks on every company (folder-v2 only).
$new$);

select pg_temp.f2c_patch('public.qorpera_coding_busy_checkins_unasked(uuid)'::regprocedure,
$old$			and public.qorpera_environment_is_folder_v2(session.environment_id)
$old$,
$new$$new$);

select pg_temp.f2c_patch('public.qorpera_company_machine_always_on_checkins_unasked(uuid)'::regprocedure,
$old$	-- 20260930201000.
$old$,
$new$	-- 20260930201000; legacy sweep F2c (20260930292000) asks on every company (folder-v2 only).
$new$);

select pg_temp.f2c_patch('public.qorpera_company_machine_always_on_checkins_unasked(uuid)'::regprocedure,
$old$			and public.qorpera_environment_is_folder_v2(machine.environment_id)
$old$,
$new$$new$);

select pg_temp.f2c_patch('public.qorpera_company_machine_busy_checkins_unasked(uuid)'::regprocedure,
$old$	-- 20260930181000.
$old$,
$new$	-- 20260930181000; legacy sweep F2c (20260930292000) asks on every company (folder-v2 only).
$new$);

select pg_temp.f2c_patch('public.qorpera_company_machine_busy_checkins_unasked(uuid)'::regprocedure,
$old$			and public.qorpera_environment_is_folder_v2(machine.environment_id)
$old$,
$new$$new$);
