-- Company state files, thin writers W4c (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5 "Plan (W4c)"): F2-6's resume
-- rule and the run agent's routine read.
--
-- 1. A save that changes nothing is a resume. Until C2's follow-up queue writes them into files, the platform records
--    three pauses in the routine row only: a member's Stop of a dynamic run (pause_reason member), the
--    authorization-failure suspension and a wait for a model account. The file still says active, so a resume has no
--    status to change. A save by anyone but the platform whose file says active, with the same parse as the file the
--    routine follows (also active), while the row is paused for one of those reasons, ends that pause: it pays like a
--    resume (qorpera_company_state_routine_restarts, now with the actor's kind, so the rules' login check refuses a
--    member or a run-less agent without a paying login), and the index writer takes the saver's word on the status
--    when it is paid. An unpaid resume keeps the platform's pause and its reason. Every pause that comes from a file
--    leaves a file saying paused, so a paused row behind an active file can only be the platform's.
-- 2. qorpera_folder_agent_routines: a plain read of the run agent's file routines from the index, as W1's todo read,
--    each only if the run may read its file.
-- Inert: only folder-v2 companies have file routines, and none exists before C1c-3.

create function public.qorpera_company_state_routine_resumes(p_row public.qorpera_cloud_routines, p_prev jsonb,
	p_parse jsonb, p_actor_kind text)
returns boolean language sql stable set search_path = '' as $$
	select coalesce(p_actor_kind is distinct from 'platform' and p_parse ->> 'status' = 'active'
		and p_prev = p_parse and p_row.status = 'paused'
		and p_row.pause_reason in ('member', 'authorization_failed', 'needs_model_account'), false)
$$;
revoke all on function public.qorpera_company_state_routine_resumes(public.qorpera_cloud_routines, jsonb, jsonb, text)
	from public, anon, authenticated, service_role;

create function public.qorpera_company_state_routine_restarts(p_row public.qorpera_cloud_routines, p_prev jsonb,
	p_parse jsonb, p_actor_kind text)
returns boolean language sql stable set search_path = '' as $$
	select coalesce(p_parse ->> 'status' = 'active' and (p_row.id is null or p_row.status in ('expired','retired')
			or p_prev ->> 'status' is distinct from 'active'), false)
		or (p_row.max_occurrences is not null and coalesce((p_parse ->> 'runs')::integer > p_row.max_occurrences, true))
		or (p_row.expires_at is not null and coalesce((p_parse ->> 'ends')::timestamptz > p_row.expires_at, true))
		or public.qorpera_company_state_routine_resumes(p_row, p_prev, p_parse, p_actor_kind)
$$;
revoke all on function public.qorpera_company_state_routine_restarts(public.qorpera_cloud_routines, jsonb, jsonb, text)
	from public, anon, authenticated, service_role;

create function pg_temp.w4c_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'W4c anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The rules: the actor's kind reaches the restart test.
select pg_temp.w4c_replace('public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure,
	$old$public.qorpera_company_state_routine_restarts(v_row, v_prev, p_parse)$old$,
	$new$public.qorpera_company_state_routine_restarts(v_row, v_prev, p_parse, p_actor ->> 'kind')$new$);

-- The index writer: the restart test with the commit's actor, and the saver's word on a paid resume.
select pg_temp.w4c_replace('public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$	v_set boolean; v_reason text;$old$,
	$new$	v_set boolean; v_reason text; v_resumes boolean;$new$);
select pg_temp.w4c_replace('public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$	v_restarts := public.qorpera_company_state_routine_restarts(v_row, v_prev, p_parse);$old$,
	$new$	v_restarts := public.qorpera_company_state_routine_restarts(v_row, v_prev, p_parse, v_commit.actor_kind);
	-- A save that changes nothing over the platform's pause is a resume (W4c).
	v_resumes := public.qorpera_company_state_routine_resumes(v_row, v_prev, p_parse, v_commit.actor_kind);$new$);
select pg_temp.w4c_replace('public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		or (v_status = 'concluded' and v_row.status <> 'concluded');$old$,
	$new$		or (v_status = 'concluded' and v_row.status <> 'concluded')
		-- A paid resume; an unpaid one keeps the platform's pause and its reason.
		or (v_resumes and v_paid);$new$);

drop function public.qorpera_company_state_routine_restarts(public.qorpera_cloud_routines, jsonb, jsonb);

-- The run agent's file routines, as the index keeps them, each only if the run may read its file: the routine as the
-- runtime reads it (qorpera_agent_routine_view: status and the platform's pause reason, occurrences, the next run,
-- limits; its instructions are the file's), and the file's own view (its path, version and parse, whose status is the
-- file's). Any run of the agent but a worker may read, a member's private conversation included. routineKey reads one
-- whole; a page (32, newest first, with a cursor) cuts each routine's instructions to 200 characters, as W1's todo
-- read cuts a detail, so a page stays one tool result's size. Routines from before the company's folder (no file) are
-- not listed.
create function public.qorpera_folder_agent_routines(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_auth jsonb; v_profile uuid; v_staff uuid; v_after public.qorpera_cloud_routines%rowtype; v_routines jsonb;
	v_more bigint; v_last uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Routine authority is unavailable' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth ->> 'kind' is distinct from 'staff_agent' or (public.qorpera_run_worker((p_actor ->> 'runId')::uuid)).id is not null then
		raise exception 'Routine authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) key where key not in ('routineKey', 'cursor'))
		or (p_request ? 'routineKey' and (jsonb_typeof(p_request -> 'routineKey') <> 'string'
			or (p_request ->> 'routineKey') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_request ->> 'routineKey') > 64))
		or (p_request ? 'cursor' and (jsonb_typeof(p_request -> 'cursor') <> 'string'
			or (p_request ->> 'cursor') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
		or (p_request ? 'routineKey' and p_request ? 'cursor') then
		raise exception 'Routine request is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files
	where environment_id = p_environment_id and core = 'folder-v2';
	v_staff := (v_auth ->> 'staffAgentId')::uuid;
	if p_request ? 'cursor' then
		select * into v_after from public.qorpera_cloud_routines routine
		where routine.id = (p_request ->> 'cursor')::uuid and routine.profile_id = v_profile
			and routine.folder_environment_id = p_environment_id and routine.owner_staff_agent_id = v_staff
			and routine.folder_retired_at is null
			and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth, routine.folder_path, 'read');
		if not found then raise exception 'Routine cursor is unavailable; list again without it' using errcode = '22023'; end if;
	end if;
	with matching as (
		select routine.id, routine.created_at from public.qorpera_cloud_routines routine
		-- A row from before the folder has no folder environment (qorpera_cloud_routines_folder_complete).
		where routine.profile_id = v_profile and routine.folder_environment_id = p_environment_id
			and routine.owner_staff_agent_id = v_staff and routine.folder_retired_at is null
			and (not p_request ? 'routineKey' or routine.routine_key = p_request ->> 'routineKey')
			and (v_after.id is null or (routine.created_at, routine.id) < (v_after.created_at, v_after.id))
			and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth, routine.folder_path, 'read')),
	page as (select * from matching order by created_at desc, id desc limit 32)
	select coalesce(jsonb_agg((public.qorpera_agent_routine_view(routine) - 'intent') || jsonb_build_object('path', routine.folder_path,
				'folderVersion', routine.folder_path_version, 'cursor', routine.id,
				'file', case when p_request ? 'routineKey' or file.structured -> 'parse' ->> 'instructions' is null
					then file.structured -> 'parse'
					else file.structured -> 'parse' || jsonb_build_object('instructions', left(file.structured -> 'parse' ->> 'instructions', 200)) end)
			|| case when not p_request ? 'routineKey' and char_length(file.structured -> 'parse' ->> 'instructions') > 200
				then '{"instructionsTruncated":true}'::jsonb else '{}'::jsonb end
			order by page.created_at desc, page.id desc), '[]'::jsonb),
		(select count(*) from matching) - count(*),
		(array_agg(page.id order by page.created_at, page.id))[1]
	into v_routines, v_more, v_last
	from page join public.qorpera_cloud_routines routine on routine.id = page.id
	left join public.qorpera_folder_path_versions file on file.version = routine.folder_path_version;
	return jsonb_build_object('schema', 'qorpera.folder-agent-routines/v1', 'routines', v_routines, 'moreRoutines', v_more,
		'nextCursor', case when v_more > 0 then v_last end);
end $$;

revoke all on function public.qorpera_folder_agent_routines(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_agent_routines(uuid, jsonb, jsonb) to service_role;
