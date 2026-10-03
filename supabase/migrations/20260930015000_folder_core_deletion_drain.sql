-- Company folder core, C1c-3g (P08; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.5 and the 3g notes in §6.4 and
-- §6.5): company deletion drains the folder fence. Deletion took the gc fence (the company row FOR UPDATE and the legacy
-- wake admission row) in each of its steps. On folder-v2 the company row is rank 0 and only KEY SHARE (core §3/§9),
-- and the fence the folder pause drains was never drained by deletion: a folder effect past its pause re-read finished
-- after the deletion committed, and the purge took the company row before the fence (a 40P01 against C1c-3f's sweep).
-- On folder-v2:
-- * The request (qorpera_delete_hosted_profile, qorpera_request_company_deletion) takes the folder fence FOR NO KEY
--   UPDATE, member management's lock (C1c-3c: a leave, a removal or a join in flight serializes with the last member's
--   deletion), then the company row KEY SHARE; no legacy revision bump (folder effects never read it). A folder effect
--   in flight (the fence KEY SHARE) is not waited for; once the request commits, every effect re-reads the deletion
--   after the fence and refuses. Its stop's job pass skips the jobs effects hold, as before; the finisher ends them.
-- * The finisher (qorpera_finish_company_deletion) runs the folder pause's second phase for deletion,
--   qorpera_folder_deletion_drain: the fence FOR UPDATE (it waits out every effect in flight) and its revision bump,
--   then the company row FOR UPDATE as the purge takes it, before the stop again, the holdings and the revocations
--   (jobs, secrets, grants, connections): a holder of the row KEY SHARE that waits for one of those (a broker seal)
--   meets the finisher at the row, not in a cycle.
-- * The purge takes the same drain and then the company row FOR UPDATE: the one folder-v2 path that may, since it
--   deletes the row; it comes after the fence, so no effect holds the row while it waits, and before the cascade's
--   children (members, sessions, secrets …), which the remaining legacy holders of the row (sign-ins, retirements,
--   node update drains) take after it.
-- * The batch (qorpera_finish_company_deletions) finishes its random sample in company id order, as the node update
--   drains and the executor give-up take their companies, so two batches of locks never cross.
-- The 3f sweep's fence NOWAIT now skips a company whose purge holds the fence, and the last member's leave during the
-- purge waits at the fence instead of meeting it in 40P01 (§6.4's 3g notes). Snapshot-v1 keeps each statement in its
-- else branch. No real folder-v2 company exists before C1c-3's end, so this changes no live company.

create function pg_temp.c1c3g_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3g anchor found % time(s) in %, expected %: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, p_count, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The two locks ------------------------------------------------------------------------------------------------------

-- The request's: member management's fence mode, then rank 0.
create function public.qorpera_folder_deletion_enter(p_profile_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	-- C1c-3g (20260930015000): the folder fence FOR NO KEY UPDATE, then the company row KEY SHARE (rank 0).
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for no key update;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for key share;
	if not found then raise exception 'profile is unavailable' using errcode = '42501'; end if;
end $$;

-- The finisher's and the purge's: the folder pause's second phase, for a company being deleted (a deletion row, with a
-- pause row or without one, when the requester's account is gone).
create function public.qorpera_folder_deletion_drain(p_profile_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_revision bigint;
begin
	-- C1c-3g (20260930015000): the fence FOR UPDATE waits out every effect in flight; each effect after it re-reads the
	-- deletion and refuses.
	if not public.qorpera_company_deleting(p_profile_id) then
		raise exception 'The company is not being deleted' using errcode = '55000'; end if;
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for update;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	update public.qorpera_folder_fences set revision = revision + 1 where profile_id = p_profile_id returning revision into v_revision;
	return v_revision;
end $$;
revoke all on function public.qorpera_folder_deletion_enter(uuid), public.qorpera_folder_deletion_drain(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. Patches ------------------------------------------------------------------------------------------------------------

do $$
begin
	-- The last member's deletion: member management's lock in place of the company row FOR UPDATE.
	perform pg_temp.c1c3g_replace('public.qorpera_delete_hosted_profile(uuid)',
		E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n',
		E'\t-- C1c-3g (20260930015000): on folder-v2 the fence FOR NO KEY UPDATE (a leave, removal or join waits) and rank 0.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_deletion_enter(p_profile_id);\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\tend if;\n', 1);

	-- The request: the same locks (already held when the last member deletes), and no legacy bump.
	perform pg_temp.c1c3g_replace('public.qorpera_request_company_deletion(uuid,uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n',
		E'\t-- C1c-3g (20260930015000): on folder-v2 the fence FOR NO KEY UPDATE and rank 0; the finisher drains the fence.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_deletion_enter(p_profile_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3g_replace('public.qorpera_request_company_deletion(uuid,uuid)',
		E'\tif found then\n'
		|| E'\t\t-- The company counts as paused from now on: admission and effects re-read it after this bump.\n',
		E'\tif found and not public.qorpera_company_is_folder_v2(p_profile_id) then -- C1c-3g (20260930015000)\n'
		|| E'\t\t-- The company counts as paused from now on: admission and effects re-read it after this bump.\n', 1);
	perform pg_temp.c1c3g_replace('public.qorpera_stop_company_work(uuid)',
		E'\tif found then\n'
		|| E'\t\tupdate public.qorpera_company_wake_admission_fences set revision = revision + 1 where profile_id = p_profile_id;\n'
		|| E'\tend if;\n',
		E'\tif found and not public.qorpera_company_is_folder_v2(p_profile_id) then -- C1c-3g (20260930015000)\n'
		|| E'\t\tupdate public.qorpera_company_wake_admission_fences set revision = revision + 1 where profile_id = p_profile_id;\n'
		|| E'\tend if;\n', 1);

	-- The finisher: the drain in place of the gc fence.
	perform pg_temp.c1c3g_replace('public.qorpera_finish_company_deletion(uuid)',
		E'\t\t\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\t\t\tperform public.qorpera_stop_company_work(p_profile_id);\n',
		E'\t\t\t-- C1c-3g (20260930015000): on folder-v2 the folder pause''s second phase, for deletion, then the company row\n'
		|| E'\t\t\t-- FOR UPDATE as the purge takes it, before the stop''s and the revocations'' rows (jobs, secrets, grants).\n'
		|| E'\t\t\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\t\t\tperform public.qorpera_folder_deletion_drain(p_profile_id);\n'
		|| E'\t\t\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\t\t\telse\n'
		|| E'\t\t\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\t\t\tend if;\n'
		|| E'\t\t\tperform public.qorpera_stop_company_work(p_profile_id);\n', 1);

	-- The purge: the drain, then the company row FOR UPDATE, before the cascade's children.
	perform pg_temp.c1c3g_replace('public.qorpera_purge_company(uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\t-- The company row is locked: no new machine can be reserved for it until this transaction ends.\n',
		E'\t-- C1c-3g (20260930015000): on folder-v2 the drain, then the company row FOR UPDATE (the one folder-v2 path that\n'
		|| E'\t-- may: it deletes the row), after the fence and before the cascade''s children.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_deletion_drain(p_profile_id);\n'
		|| E'\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\tend if;\n'
		|| E'\t-- The company row is locked: no new machine can be reserved for it until this transaction ends.\n', 1);

	-- The batch: a random sample, finished in company id order.
	perform pg_temp.c1c3g_replace('public.qorpera_finish_company_deletions(integer)',
		E'\t\tselect deletion.profile_id from public.qorpera_company_deletions as deletion\n'
		|| E'\t\twhere deletion.purged_at is null\n'
		|| E'\t\torder by random()\n'
		|| E'\t\tlimit p_limit\n',
		E'\t\t-- C1c-3g (20260930015000): finished in company id order, as the node update drains and the executor give-up\n'
		|| E'\t\t-- take their companies, so two batches of locks never cross.\n'
		|| E'\t\tselect sample.profile_id from (select deletion.profile_id from public.qorpera_company_deletions as deletion\n'
		|| E'\t\twhere deletion.purged_at is null\n'
		|| E'\t\torder by random()\n'
		|| E'\t\tlimit p_limit) as sample order by sample.profile_id\n', 1);
end $$;
