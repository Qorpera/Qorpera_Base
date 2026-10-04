-- Company folder core: a folder-v2 routine's expiry (after P28; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.9).
--
-- The legacy expiry sweep (qorpera_expire_cloud_routines) ran only inside the Company File drain, which P28 took out of
-- the reconcile RPC; it also updated every company's routines in one transaction. Since then nothing ended a routine
-- past its `expires_at`, so a folder-v2 routine stayed active: the schedule heads kept listing it and every poll's
-- enqueue was refused ("Routine has expired"). Its expiry now rides P04's folder-v2 dynamic routine tick, one company per
-- transaction, under the folder core's locks:
-- * qorpera_folder_dynamic_routines_due also names a folder-v2 routine of any origin and trigger that is active or
--   paused and past its expiry (paused companies included; a company being deleted is left to its purge).
-- * qorpera_folder_restore_dynamic_routine_run ends such a routine before anything else: the fence KEY SHARE (taken
--   already), the company row KEY SHARE (rank 0), the routine FOR NO KEY UPDATE SKIP LOCKED (rank 5), then
--   status = 'expired' (the status triggers record whether it was active, and cancel a paused routine's queued runs).
--   It answers `ended`, whether or not the company is paused, as the legacy sweep did; `changed` if the routine was
--   extended, its end removed, retired or concluded meanwhile.
-- The legacy sweep has no caller now, so a snapshot-v1 routine no longer expires (no snapshot-v1 company remains).
-- The routine file keeps its status until core C2's queue writes platform statuses into files (STATE "Status"). The
-- orchestrator needs no change: `ended` is one of the restore's answers.
-- Also (P28's tidy-up): qorpera_folder_materialize_company's comment on F2's worker drain is corrected. The drain, like
-- the listener (P29), runs in its own transaction as its own orchestrator step, never inside the materializer.
-- Each inserted text names this migration (20260930027000), for deploy guards.

set local lock_timeout = '3s';

-- 1. The list -------------------------------------------------------------------------------------------------------

create or replace function public.qorpera_folder_dynamic_routines_due(p_after_routine_id uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_next uuid; v_has_more boolean;
begin
	-- 20260930009500: folder core C1c-3e. 20260930027000: and the routines past their expiry, which the restore ends.
	if auth.role() <> 'service_role' then
		raise exception 'routine schedule discovery requires control-plane authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'routine schedule page limit is invalid' using errcode = '22023'; end if;
	with candidates as (
		select routine.id, routine.current_version from public.qorpera_cloud_routines as routine
		join public.qorpera_cloud_routine_versions as version
			on version.routine_id = routine.id and version.version = routine.current_version
		where routine.status = 'active' and routine.origin = 'agent' and version.triggers -> 0 ->> 'kind' = 'once'
			and (p_after_routine_id is null or routine.id > p_after_routine_id)
			and public.qorpera_company_is_folder_v2(routine.profile_id)
			and public.qorpera_dynamic_routine_pending_occurrence(routine.id, routine.current_version) is null
			and not exists (select 1 from public.qorpera_wake_occurrences as wake where wake.routine_id = routine.id
				and wake.status = 'materialized' and public.qorpera_wake_run_live(wake.run_id))
			and not public.qorpera_company_execution_paused(routine.profile_id)
			-- Not one the restore would only answer `ended` for (the expiry below closes it).
			and (routine.expires_at is null or routine.expires_at > statement_timestamp())
			and (routine.max_occurrences is null or (select count(*) from public.qorpera_wake_occurrences as wake
				where wake.routine_id = routine.id) < routine.max_occurrences)
		union
		-- Any folder-v2 routine past its expiry, paused company or not; a company being deleted is left to its purge.
		select routine.id, routine.current_version from public.qorpera_cloud_routines as routine
		where routine.status in ('active', 'paused') and routine.expires_at <= statement_timestamp()
			and (p_after_routine_id is null or routine.id > p_after_routine_id)
			and public.qorpera_company_is_folder_v2(routine.profile_id)
			and not public.qorpera_company_deleting(routine.profile_id)
	), page as (
		select * from candidates order by id limit p_limit + 1
	), visible as (
		select * from page order by id limit p_limit
	)
	select (select coalesce(jsonb_agg(jsonb_build_object('routine_id', visible.id, 'version', visible.current_version)
				order by visible.id), '[]'::jsonb) from visible),
		(select visible.id from visible order by visible.id desc limit 1),
		(select count(*) > p_limit from page)
	into v_items, v_next, v_has_more;
	return jsonb_build_object('items', v_items, 'has_more', v_has_more,
		'next_after_routine_id', case when v_has_more then v_next end);
end $$;

-- 2. The restore ends a routine past its expiry ---------------------------------------------------------------------

do $$
declare v_target constant regprocedure := 'public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)';
	v_definition text := pg_get_functiondef(v_target);
	c_old constant text := $old$	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_routine.profile_id) then return jsonb_build_object('status', 'paused'); end if;
$old$;
	c_new constant text := $new$	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	-- 20260930027000: a routine past its expiry ends first, paused company or not (the legacy sweep's rule), unless the
	-- company is being deleted (its purge removes it; every effect refuses then, C1c-3g): the company row KEY SHARE
	-- (rank 0), the routine FOR NO KEY UPDATE (rank 5), then its status. One changed meanwhile (extended, its end
	-- removed, retired or concluded) answers changed.
	if v_routine.status in ('active', 'paused') and v_routine.expires_at <= statement_timestamp()
		and not public.qorpera_company_deleting(v_routine.profile_id) then
		perform 1 from public.qorpera_profiles where id = v_routine.profile_id for key share;
		select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id for no key update skip locked;
		if not found then return jsonb_build_object('status', 'busy'); end if;
		-- Positive, so an end removed meanwhile (expires_at null) answers changed too.
		if not coalesce(v_routine.status in ('active', 'paused') and v_routine.expires_at <= statement_timestamp(), false) then
			return jsonb_build_object('status', 'changed'); end if;
		update public.qorpera_cloud_routines set status = 'expired', pause_reason = null, updated_at = statement_timestamp()
		where id = v_routine.id;
		return jsonb_build_object('status', 'ended');
	end if;
	if public.qorpera_company_execution_paused(v_routine.profile_id) then return jsonb_build_object('status', 'paused'); end if;
$new$;
begin
	if (length(v_definition) - length(replace(v_definition, c_old, ''))) / length(c_old) <> 1 then
		raise exception 'Routine expiry patch anchor not found in %', v_target; end if;
	execute replace(v_definition, c_old, c_new);
end $$;

-- 3. The materializer's comment on F2's worker drain ---------------------------------------------------------------

do $$
declare v_target constant regprocedure := 'public.qorpera_folder_materialize_company(uuid,integer)';
	v_definition text := pg_get_functiondef(v_target);
	c_old constant text := E'\t-- F2-5b-3 calls the folder worker drain here, before this function locks anything (core C4).\n';
	c_new constant text := E'\t-- 20260930027000: F2''s worker drain and the listener (P29) run in their own transactions, as their own orchestrator\n'
		|| E'\t-- steps before this one: a drain admits wakes, and admission must come after this function''s ranks.\n';
begin
	if (length(v_definition) - length(replace(v_definition, c_old, ''))) / length(c_old) <> 1 then
		raise exception 'Materializer comment anchor not found in %', v_target; end if;
	execute replace(v_definition, c_old, c_new);
end $$;
