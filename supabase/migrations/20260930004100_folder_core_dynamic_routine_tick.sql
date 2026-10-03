-- Company folder core, C1c-3e: a folder-v2 dynamic routine's next run (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md
-- §6.8).
--
-- An agent's dynamic routine (`when: once`) gets its next run from the control-plane tick. The tick
-- (qorpera_restore_dynamic_routine_runs, inside the Company File drain) visits every company in one transaction, so
-- since C1c-2c part 1 it skips folder-v2 companies: a folder-v2 dynamic routine never ran again. Here it gets a
-- folder-v2 path that takes one company per transaction, as routine firing does (qorpera_folder_enqueue_routine_wake):
-- * qorpera_folder_dynamic_routines_due(after, limit): the folder-v2 dynamic routines that may be missing their run (the
--   tick's own filter), paged by routine id, without a lock. Service role.
-- * qorpera_folder_restore_dynamic_routine_run(routine, expected version): one routine, in the caller's transaction. The
--   folder fence and the company row KEY SHARE (rank 0); the version's member, agent and execution authority KEY SHARE
--   (ranks 1 to 3); the routine FOR NO KEY UPDATE SKIP LOCKED (rank 5: a save holding it makes the tick come back next
--   pass, as the legacy tick's SKIP LOCKED does); then the legacy checks, in the legacy order; the public session KEY
--   SHARE; admission; the insert. A refusal for want of authority (42501, from the wake's pin trigger) suspends the
--   routine and tells its member once, as the legacy tick does, with the insert and admission undone. It answers a
--   status, never raises for a routine it cannot run. Service role.
-- * qorpera_ensure_dynamic_routine_run refuses a folder-v2 routine (0A000) as its first line: the legacy path takes no
--   fence and no ranks, and none of its callers reaches folder-v2 (the tick skips it; the agent tools refuse it).
-- The runner-orchestrator edge function gets the actions `folder_dynamic_routines` and `restore_dynamic_routine`, and
-- the orchestrator's routine reconciler calls them after the schedule heads. Each inserted text names this migration
-- (20260930004100), for deploy guards.

set local lock_timeout = '3s';

-- 1. The folder-v2 dynamic routines that may be missing their run ----------------------------------------------------

create function public.qorpera_folder_dynamic_routines_due(p_after_routine_id uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_next uuid; v_has_more boolean;
begin
	-- 20260930004100: folder core C1c-3e.
	if auth.role() <> 'service_role' then
		raise exception 'routine schedule discovery requires control-plane authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'routine schedule page limit is invalid' using errcode = '22023'; end if;
	with page as (
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
			-- Not one the restore would only answer `ended` for (the lifecycle sweep closes it).
			and (routine.expires_at is null or routine.expires_at > statement_timestamp())
			and (routine.max_occurrences is null or (select count(*) from public.qorpera_wake_occurrences as wake
				where wake.routine_id = routine.id) < routine.max_occurrences)
		order by routine.id
		limit p_limit + 1
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

-- 2. One routine's next run, in its own company's transaction --------------------------------------------------------

create function public.qorpera_folder_restore_dynamic_routine_run(p_routine_id uuid, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_trigger jsonb; v_ended integer; v_at timestamptz; v_id uuid; v_last public.qorpera_wake_occurrences%rowtype;
	v_session uuid; v_occurrence public.qorpera_wake_occurrences%rowtype; v_owner uuid; v_error text;
begin
	-- 20260930004100: folder core C1c-3e.
	if auth.role() <> 'service_role' then
		raise exception 'routine firing requires control-plane authority' using errcode = '42501'; end if;
	if p_routine_id is null or p_expected_version is null then
		raise exception 'routine is invalid' using errcode = '22023'; end if;
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id;
	if not found then return jsonb_build_object('status', 'gone'); end if;
	if not public.qorpera_company_is_folder_v2(v_routine.profile_id) then return jsonb_build_object('status', 'not_folder'); end if;
	-- Rank 0: the fence KEY SHARE (stop and resume wait for it; member changes do not), the pause read under it, then the
	-- company row KEY SHARE.
	perform 1 from public.qorpera_folder_fences where profile_id = v_routine.profile_id for key share;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_routine.profile_id) then return jsonb_build_object('status', 'paused'); end if;
	perform 1 from public.qorpera_profiles where id = v_routine.profile_id for key share;
	-- Ranks 1 to 3: the version's member, agent and execution authority (a version never changes).
	select * into v_version from public.qorpera_cloud_routine_versions
	where routine_id = p_routine_id and version = p_expected_version;
	if not found then return jsonb_build_object('status', 'changed'); end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_routine.profile_id
		and user_id = v_version.created_by_user_id for key share;
	perform 1 from public.qorpera_profile_staff where profile_id = v_routine.profile_id
		and staff_agent_id = v_version.staff_agent_id for key share;
	perform 1 from public.qorpera_staff_execution_authorities where profile_id = v_routine.profile_id
		and staff_agent_id = v_version.staff_agent_id for key share;
	-- Rank 5: the routine. A save or a decision holding it makes this pass skip it; the next pass comes back.
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id for no key update skip locked;
	if not found then return jsonb_build_object('status', 'busy'); end if;
	-- The legacy tick's checks (qorpera_ensure_dynamic_routine_run), in its order.
	if v_routine.status <> 'active' or v_routine.origin <> 'agent' or v_routine.current_version <> p_expected_version then
		return jsonb_build_object('status', 'changed'); end if;
	v_trigger := v_version.triggers -> 0;
	if jsonb_array_length(v_version.triggers) <> 1 or v_trigger ->> 'kind' is distinct from 'once' then
		return jsonb_build_object('status', 'changed'); end if;
	v_id := public.qorpera_dynamic_routine_pending_occurrence(v_routine.id, v_routine.current_version);
	if v_id is not null then return jsonb_build_object('status', 'pending', 'occurrence_id', v_id); end if;
	-- Runs of one routine never overlap.
	if exists (select 1 from public.qorpera_wake_occurrences as wake where wake.routine_id = v_routine.id
		and wake.status = 'materialized' and public.qorpera_wake_run_live(wake.run_id)) then
		return jsonb_build_object('status', 'running'); end if;
	-- A member's Stop of the routine's latest run pauses the routine, once.
	select wake.* into v_last from public.qorpera_wake_occurrences as wake
	where wake.routine_id = v_routine.id order by wake.created_at desc, wake.id desc limit 1;
	if v_last.run_id is not null and v_last.blocked_reason is distinct from 'A member stopped this run; the routine paused'
		and exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.id = v_last.run_id and job.status = 'cancelled' and job.cancelled_by_user_id is not null) then
		update public.qorpera_wake_occurrences set blocked_reason = 'A member stopped this run; the routine paused'
		where id = v_last.id;
		update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'member', updated_at = statement_timestamp()
		where id = v_routine.id;
		return jsonb_build_object('status', 'stopped');
	end if;
	select count(*) into v_ended from public.qorpera_wake_occurrences
	where routine_id = v_routine.id and routine_version = v_routine.current_version;
	v_at := case when v_ended = 0 then greatest((v_trigger ->> 'at')::timestamptz, statement_timestamp())
		when v_ended <= 3 then statement_timestamp()
		else statement_timestamp() + least(interval '15 minutes' * power(2, least(v_ended - 4, 12)), interval '1 day') end;
	-- An expired or limited routine is closed by the lifecycle sweep, not here.
	if (v_routine.expires_at is not null and v_at >= v_routine.expires_at)
		or (v_routine.max_occurrences is not null and (select count(*) from public.qorpera_wake_occurrences
			where routine_id = v_routine.id) >= v_routine.max_occurrences) then
		return jsonb_build_object('status', 'ended'); end if;
	-- The public session the pin trigger will choose, KEY SHARE before admission; then admission and the insert, undone
	-- together when the kernel refuses the run for want of authority.
	v_session := public.qorpera_folder_wake_public_session(v_routine.profile_id, v_routine.environment_id,
		v_version.staff_agent_id, v_version.created_by_user_id);
	if v_session is not null then
		perform 1 from public.qorpera_shared_sessions where id = v_session for key share; end if;
	v_id := extensions.gen_random_uuid();
	begin
		perform public.qorpera_folder_admit_wakes(v_routine.profile_id);
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version,
			trigger_id, occurrence_key, scheduled_for, not_before, payload)
		values (v_id, v_routine.profile_id, v_routine.environment_id, v_routine.id, v_routine.current_version,
			v_trigger ->> 'id', 'once:' || v_routine.current_version || ':' || (v_ended + 1), v_at, v_at,
			jsonb_build_object('schema', 'qorpera.routine-once-occurrence/v1', 'attempt', v_ended + 1))
		returning * into v_occurrence;
	exception when insufficient_privilege then
		-- Admission's own 42501 (no admission row) is not the kernel refusing the run: raise it.
		get stacked diagnostics v_error = message_text;
		if v_error = 'Company folder is unavailable' then raise; end if;
		update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'authorization_failed',
			updated_at = statement_timestamp()
		where id = v_routine.id and status = 'active';
		v_owner := coalesce(v_version.created_by_user_id, v_routine.created_by_user_id);
		insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
		values (v_routine.profile_id, v_owner, 'routine_suspended',
			jsonb_build_object('routineId', v_routine.id, 'staffAgentId', v_routine.owner_staff_agent_id,
				'reason', 'authorization_failed'), 'routine:' || v_routine.id::text)
		on conflict do nothing;
		return jsonb_build_object('status', 'suspended');
	end;
	-- The trigger chose the session without a lock: it must be the one this call locked.
	if v_occurrence.session_id is distinct from v_session then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'wake routine audience changed',
			'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return jsonb_build_object('status', 'inserted', 'occurrence_id', v_occurrence.id, 'not_before', v_occurrence.not_before);
end $$;

-- 3. The legacy path refuses folder-v2 --------------------------------------------------------------------------------

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_ensure_dynamic_routine_run(uuid)'::regprocedure);
	v_old text := E'begin\n\t-- SKIP LOCKED: the tick never waits on a routine an agent is saving; the next tick retries.\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'C1c-3e patch anchor not found once in qorpera_ensure_dynamic_routine_run'; end if;
	execute replace(v_definition, v_old,
		E'begin\n'
		|| E'\t-- 20260930004100: a folder-v2 routine''s next run comes from qorpera_folder_restore_dynamic_routine_run.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select routine.profile_id from public.qorpera_cloud_routines as routine\n'
		|| E'\t\t\twhere routine.id = p_routine_id)) then\n'
		|| E'\t\traise exception ''A folder-v2 routine''''s next run comes from the folder tick'' using errcode = ''0A000''; end if;\n'
		|| E'\t-- SKIP LOCKED: the tick never waits on a routine an agent is saving; the next tick retries.\n');
end $$;

-- 4. Privileges ------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_dynamic_routines_due(uuid, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_dynamic_routines_due(uuid, integer) to service_role;
revoke all on function public.qorpera_folder_restore_dynamic_routine_run(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_restore_dynamic_routine_run(uuid, bigint) to service_role;
