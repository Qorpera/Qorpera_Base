-- The company's profile fence before its Company File row, for every call that locks that row and then
-- needs the company's profile row.
--
-- Every agent tool call takes the company's profile fence (qorpera_lock_profile_gc_fence: the profile row
-- FOR UPDATE, then the company's wake admission fence) and then locks the Company File row. So do the
-- object gateway's upload confirmation and, since 20260925123000, coding machine admission (the fence, then
-- a storage volume whose key check locks the Company File row). The calls below did it the other way
-- round. They locked the Company File row (FOR UPDATE, or FOR SHARE to pin its head) and then waited for
-- the profile row, either for the fence itself (a snapshot or substrate version insert takes it in a
-- trigger) or for a key check on a row that points at the company's profile. A fence-first call meeting
-- one of them ended in 40P01:
--   - a member saving the Company File: preparing and publishing a revision (publishing moves the head,
--     whose trigger records a substrate version);
--   - a member preparing or submitting a proposal, or rebasing one (the new revision seeds its review
--     assignments);
--   - the object gateway copying a stored object into the company's bucket: the quota trigger locks the
--     Company File row, then the replica guard (the next trigger) takes the fence;
--   - the substrate version helper, reached from the head, staff and runner job triggers;
--   - a runner preparing a revision, or completing a job for a company not on the path gateway;
--   - the member-run wake claim and run enqueue, which pin the Company File head FOR SHARE.
-- Each now takes the fence first and then locks the Company File row as before. Where the caller is still
-- to be checked, the fence waits until it is known to be allowed to write, so a refused caller never locks
-- the company's profile row. The quota trigger runs before the bucket's policies, as its Company File lock
-- always did, and takes the fence for every stored object. A member's own upload needs no profile row; it
-- now also waits for fence holders that never lock the Company File row, each for one short call. The
-- fence is re-entrant, so a trigger that takes it again later finds it held. A rebase takes it after its
-- proposal row and before the Company File row, where accepting a proposal now takes it too (inside
-- publish): every call that locks a proposal row locks it before both.
--
-- Unchanged: the path gateway's actors and cutover, upload confirmation, object promotion and wake
-- admission already take the fence (or its NOWAIT form) first; claiming a bootstrap job locks the Company
-- File row but never waits for the profile row after it; the legacy session turn claim pins the head and
-- then writes only session rows.

create function pg_temp.company_file_fence_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company File fence integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- A member saving the Company File.
select pg_temp.company_file_fence_patch('public.qorpera_prepare_company_file_revision(uuid,uuid,uuid,text,integer,integer,integer,bigint)',
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
select pg_temp.company_file_fence_patch('public.qorpera_publish_company_file_revision(uuid,uuid,uuid)',
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
select pg_temp.company_file_fence_patch('public.qorpera_prepare_company_file_proposal(uuid,uuid,uuid,text,integer,integer,integer,bigint)',
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
select pg_temp.company_file_fence_patch('public.qorpera_submit_company_proposal(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,text,uuid[])',
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
select pg_temp.company_file_fence_patch('public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)',
	$old$	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_proposal.profile_id
		and file.environment_id = v_proposal.environment_id
	for update;
$old$,
	$new$	-- The company's profile fence after the proposal and before the Company File row, as accepting one
	-- takes them: the new revision seeds its review assignments, which need the profile row.
	perform public.qorpera_lock_profile_gc_fence(v_proposal.profile_id);
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_proposal.profile_id
		and file.environment_id = v_proposal.environment_id
	for update;
$new$);

-- An object stored in the company's bucket.
select pg_temp.company_file_fence_patch('public.qorpera_enforce_company_storage_quota()',
	$old$	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
$old$,
	$new$	-- The company's profile fence first: the object gateway's replica guard, the next trigger, takes it.
	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id)
	where exists (select 1 from public.qorpera_company_files as file where file.profile_id = v_identity.profile_id);
	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
$new$);

-- The substrate version helper (head, staff and runner job triggers).
select pg_temp.company_file_fence_patch('public.qorpera_ensure_current_company_substrate(uuid,uuid,uuid,uuid,uuid)',
	$old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.environment_id = p_environment_id
	for update;
$old$,
	$new$	-- The company's profile fence first: the substrate version insert below takes it.
	perform public.qorpera_lock_profile_gc_fence(file.profile_id) from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.environment_id = p_environment_id;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.environment_id = p_environment_id
	for update;
$new$);

-- A runner writing to the Company File.
select pg_temp.company_file_fence_patch('public.qorpera_runner_prepare_company_revision(uuid,text,uuid,text,uuid,uuid,text,integer,integer,integer,bigint)',
	$old$	select file.* into strict v_file from public.qorpera_company_files as file
	where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for share;
$old$,
	$new$	-- The company's profile fence first: the revision intent and snapshot inserts below need the profile row.
	perform public.qorpera_lock_profile_gc_fence(v_run.profile_id);
	select file.* into strict v_file from public.qorpera_company_files as file
	where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for share;
$new$);
select pg_temp.company_file_fence_patch('public.qorpera_complete_runner_job_before_path_runtime(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)',
	$old$		select file.* into strict v_file from public.qorpera_company_files as file
		where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for update;
$old$,
	$new$		-- The company's profile fence first, as the path runtime's completion takes it: moving the head and
		-- inserting a proposal both need the profile row.
		perform public.qorpera_lock_profile_gc_fence(v_run.profile_id);
		select file.* into strict v_file from public.qorpera_company_files as file
		where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for update;
$new$);

-- The member-run wake claim and run enqueue.
select pg_temp.company_file_fence_patch('public.qorpera_claim_wake_v2(uuid,text,uuid,integer,uuid,uuid,bigint)',
	$old$	select file.head_snapshot_id into v_current_snapshot_id
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.profile_id = v_profile_id
	for share;
$old$,
	$new$	-- The company's profile fence first: the wake claim insert below needs the profile row.
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	select file.head_snapshot_id into v_current_snapshot_id
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.profile_id = v_profile_id
	for share;
$new$);
select pg_temp.company_file_fence_patch('public.qorpera_enqueue_execution_run(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,text,text,jsonb,text,text,uuid[],uuid)',
	$old$	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_environment.profile_id and file.environment_id = p_environment_id
	for share;
$old$,
	$new$	-- The company's profile fence first: the job and run inserts below need the profile row.
	perform public.qorpera_lock_profile_gc_fence(v_environment.profile_id);
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_environment.profile_id and file.environment_id = p_environment_id
	for share;
$new$);
