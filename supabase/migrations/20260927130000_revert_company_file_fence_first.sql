-- Revert #354 (20260927090000_company_file_fence_first) after the production incident of 2026-09-27.
--
-- v133 (activated 02:41Z) made eleven Company File writer / runner functions take the company's
-- profile fence first. Minutes later a coding turn's completion failed with AUTHORITY_UNAVAILABLE and
-- from ~02:48Z the database stopped accepting connections until it was restarted at 02:59Z. With the
-- eleven functions put back to their earlier text (applied by hand in production at 03:05Z) runs and
-- coding sessions work again. This migration records that state for every other database.
--
-- Each function is restored only if it still carries #354's text exactly once; a function already
-- restored (production) is left alone. Any other state refuses, so nothing is changed silently.

create function pg_temp.company_file_fence_revert(p_target regprocedure, p_patched text, p_original text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
	v_patched integer := (length(v_definition) - length(replace(v_definition, p_patched, ''))) / length(p_patched);
	v_original integer := (length(v_definition) - length(replace(v_definition, p_original, ''))) / length(p_original);
begin
	if v_patched = 1 then execute replace(v_definition, p_patched, p_original);
	elsif v_patched = 0 and v_original = 1 then return;
	else raise exception 'Company File fence revert differs: % near %', p_target, left(p_patched, 60); end if;
end
$$;

select pg_temp.company_file_fence_revert('public.qorpera_enqueue_execution_run(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,text,text,jsonb,text,text,uuid[],uuid)', $new$	-- The company's profile fence first: the job and run inserts below need the profile row.
	perform public.qorpera_lock_profile_gc_fence(v_environment.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_environment.profile_id and file.environment_id = p_environment_id
	for share;
$new$, $old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_environment.profile_id and file.environment_id = p_environment_id
	for share;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_claim_wake_v2(uuid,text,uuid,integer,uuid,uuid,bigint)', $new$	-- The company's profile fence first: the wake claim insert below needs the profile row.
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	select file.head_snapshot_id into v_current_snapshot_id
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.profile_id = v_profile_id
	for share;
$new$, $old$	select file.head_snapshot_id into v_current_snapshot_id
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.profile_id = v_profile_id
	for share;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_complete_runner_job_before_path_runtime(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)', $new$		-- The company's profile fence first, as the path runtime's completion takes it: moving the head and
		-- inserting a proposal both need the profile row.
		perform public.qorpera_lock_profile_gc_fence(v_run.profile_id);
		select file.* into strict v_file from public.qorpera_company_files as file
		where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for update;
$new$, $old$		select file.* into strict v_file from public.qorpera_company_files as file
		where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for update;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_runner_prepare_company_revision(uuid,text,uuid,text,uuid,uuid,text,integer,integer,integer,bigint)', $new$	-- The company's profile fence first: the revision intent and snapshot inserts below need the profile row.
	perform public.qorpera_lock_profile_gc_fence(v_run.profile_id);
	select file.* into strict v_file from public.qorpera_company_files as file
	where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for share;
$new$, $old$	select file.* into strict v_file from public.qorpera_company_files as file
	where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for share;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_ensure_current_company_substrate(uuid,uuid,uuid,uuid,uuid)', $new$	-- The company's profile fence first: the substrate version insert below takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.environment_id = p_environment_id;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.environment_id = p_environment_id
	for update;
$new$, $old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.environment_id = p_environment_id
	for update;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_enforce_company_storage_quota()', $new$	-- The company's profile fence first: the object gateway's replica guard, the next trigger, takes it.
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id)
	where exists (select 1 from public.qorpera_company_files as file where file.profile_id = v_identity.profile_id);
	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
$new$, $old$	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)', $new$	-- The new revision's trigger ends the jobs of the proposal's running reviews: take them first, since every
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
$new$, $old$	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_proposal.profile_id
		and file.environment_id = v_proposal.environment_id
	for update;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_submit_company_proposal(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,text,uuid[])', $new$	-- The company's profile fence first: the proposal insert below needs the profile row.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and v_user_id is not null and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$new$, $old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_prepare_company_file_proposal(uuid,uuid,uuid,text,integer,integer,integer,bigint)', $new$	-- The company's profile fence first: the snapshot insert below takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$new$, $old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_publish_company_file_revision(uuid,uuid,uuid)', $new$	-- The company's profile fence first: moving the head records a substrate version, whose insert takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$new$, $old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$old$);
select pg_temp.company_file_fence_revert('public.qorpera_prepare_company_file_revision(uuid,uuid,uuid,text,integer,integer,integer,bigint)', $new$	-- The company's profile fence first: the snapshot insert below takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and public.qorpera_can_write_profile(file.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$new$, $old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for update;
$old$);
