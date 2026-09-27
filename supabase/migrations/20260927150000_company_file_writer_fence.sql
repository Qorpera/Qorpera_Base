-- A member's Company File writes take the company's profile fence first, and so does a NAS replica copy
-- (the storage quota trigger). No hot insert path takes a new fence.
--
-- Every agent tool call takes the company's profile fence (qorpera_lock_profile_gc_fence: the profile row FOR
-- UPDATE, then the company's wake admission fence) and then locks the Company File row. So do the object
-- gateway's upload confirmation and coding machine admission (20260925123000). These calls did it the other
-- way round: they locked the Company File row and then waited for the profile row, so a fence-first call
-- meeting one of them ended in 40P01.
--   - A member saving the Company File: preparing and publishing a revision. The snapshot insert takes the
--     fence in its GC trigger; publishing moves the head, whose substrate version insert takes it too.
--     Accepting a proposal publishes it.
--   - A member preparing or submitting a proposal (FOR SHARE on the Company File row, then the snapshot or
--     proposal insert), or rebasing one (its new revision seeds review assignments, keyed to the company).
--   - The object gateway copying a NAS object into the company's Storage bucket: the quota trigger locks the
--     Company File row, then the replica guard (the next BEFORE trigger) takes the fence. Under concurrent
--     uploads, replica copies, agent tool calls and coding turns this deadlocked about twice a second
--     (scripts/load-company-file-fence.mjs), and agent tool calls waited up to 3 s, near the native result
--     boundary's 4 s budget.
--
-- #354 (20260927090000) made eleven functions take the fence first and was reverted after the v133 incident
-- (20260927130000). Its production logs show no lock pile-up (no deadlocks, no connection-slot errors; the
-- instance froze and restarted), but this change is narrower anyway. It never takes a new fence on a hot
-- insert path:
--   - The quota trigger takes the fence only for a NAS replica copy, which the replica guard fences anyway. A
--     member's or the runtime's own upload keeps its old text: it locks the Company File row and never needs
--     the profile row afterwards.
--   - The member writers are occasional member actions. Each takes the fence only once the caller is known to
--     be allowed to write, so a refused caller never locks the company's profile row.
--   - Unchanged, as before #354: the substrate version helper (qorpera_ensure_current_company_substrate), the
--     runner's revision prepare and non-gateway completion, and the legacy member-run wake claim and run
--     enqueue.
--
-- A rebase takes the jobs of the proposal's running reviews before the fence (its new revision's trigger ends
-- them, and every job holder takes its job before the fence), then the fence, then the Company File row. A
-- review job the materializer starts while the rebase waits for the fence is locked NOWAIT after it; if a job
-- holder has it, the rebase refuses with a 409 instead of deadlocking. Accepting a proposal keeps the same
-- order: its status trigger ends those jobs, then publish takes the fence. No call here waits for a runner
-- job after the fence. The fence is re-entrant, so a trigger that takes it again later finds it held.

create function pg_temp.company_file_writer_fence_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company File writer fence integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- A member saving the Company File.
select pg_temp.company_file_writer_fence_patch('public.qorpera_prepare_company_file_revision(uuid,uuid,uuid,text,integer,integer,integer,bigint)',
	$old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$old$,
	$new$	-- The company's profile fence first: the snapshot insert below takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$new$);
select pg_temp.company_file_writer_fence_patch('public.qorpera_publish_company_file_revision(uuid,uuid,uuid)',
	$old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$old$,
	$new$	-- The company's profile fence first: moving the head records a substrate version, whose insert takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$new$);

-- A member proposing a change, or rebasing one.
select pg_temp.company_file_writer_fence_patch('public.qorpera_prepare_company_file_proposal(uuid,uuid,uuid,text,integer,integer,integer,bigint)',
	$old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$old$,
	$new$	-- The company's profile fence first: the snapshot insert below takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$new$);
select pg_temp.company_file_writer_fence_patch('public.qorpera_submit_company_proposal(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,text,uuid[])',
	$old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$old$,
	$new$	-- The company's profile fence first: the proposal insert below needs the profile row.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and v_user_id is not null and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$new$);
select pg_temp.company_file_writer_fence_patch('public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)',
	$old$	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_proposal.profile_id
		and file.environment_id = v_proposal.environment_id
	for update;
$old$,
	$new$	-- The new revision's trigger ends the jobs of the proposal's running reviews: take them first, since every
	-- job holder takes its job before the fence. Then the company's profile fence, before the Company File row:
	-- the trigger also seeds the new revision's review assignments, which need the profile row. A review job
	-- that appeared while this call waited for the fence is taken without waiting: a job holder waiting for the
	-- fence refuses this rebase instead of deadlocking with it.
	perform 1 from public.qorpera_company_proposal_review_assignments as review
	join public.qorpera_runner_jobs as job on job.run_id = review.run_id
	where review.proposal_id = v_proposal.id and review.status = 'running'
	order by job.id for update of job;
	perform public.qorpera_lock_profile_gc_fence(v_proposal.profile_id);
	begin
		perform 1 from public.qorpera_company_proposal_review_assignments as review
		join public.qorpera_runner_jobs as job on job.run_id = review.run_id
		where review.proposal_id = v_proposal.id and review.status = 'running'
		order by job.id for update of job nowait;
	exception when lock_not_available then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company proposal review changed before rebase', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end;
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_proposal.profile_id
		and file.environment_id = v_proposal.environment_id
	for update;
$new$);

-- A NAS replica copy into the company's Storage bucket.
select pg_temp.company_file_writer_fence_patch('public.qorpera_enforce_company_storage_quota()',
	$old$	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
$old$,
	$new$	-- A NAS replica copy takes the company's profile fence first: the replica guard, the next trigger, takes it,
	-- and every fence holder takes the fence before this Company File row. Other uploads never need the profile
	-- row after this lock, so they do not take the fence.
	if new.user_metadata -> 'qorpera_nas_replica' = 'true'::jsonb then
		perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id)
		where exists (select 1 from public.qorpera_company_files as file where file.profile_id = v_identity.profile_id);
	end if;
	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
$new$);
