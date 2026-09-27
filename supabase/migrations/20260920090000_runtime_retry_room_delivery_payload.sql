-- A retried room delivery carries exactly the payload of a first delivery.
--
-- 20260920080000 added 'retryOfRunId' to the retried wake's payload. The runner
-- parses a room wake's payload as a closed object with roomId, inputIds and
-- recipientStaffId (cloud-wake-bus.ts), so the guest refused the wake and every
-- retried run failed right after it started (found live 2026-09-20 on the first
-- Try again). The link to the failed run stays where it already was: in the
-- failed run's recovery_released event (retry_occurrence_id).

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_retry_room_delivery(uuid,uuid,bigint)'::regprocedure), 'sha256'), 'hex') <> 'b4e29626e17d88ea589f856cbe1379159e1a7e296f21d4c420ad7e5435780a85' then
		raise exception 'Reviewed function definition changed: qorpera_retry_room_delivery';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_retry_room_delivery(p_run_id uuid, p_sponsor_binding_id uuid, p_sponsor_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user uuid := auth.uid();
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_room public.qorpera_company_rooms%rowtype;
	v_attempt bigint;
	v_id uuid := extensions.gen_random_uuid();
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Room retry requires a member' using errcode = '42501'; end if;
	perform 1 from public.qorpera_runner_jobs job
	join public.qorpera_execution_runs run on run.id = job.run_id and run.job_id = job.id
	where run.id = p_run_id and public.qorpera_can_write_profile(run.profile_id) for update of job;
	if not found then
		raise exception 'execution recovery requires company write access' using errcode = '42501'; end if;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = p_run_id for update;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id for update;
	select wake.* into v_wake from public.qorpera_wake_occurrences as wake where wake.run_id = v_run.id;
	if v_job.status not in ('failed','cancelled') or v_run.source_kind <> 'room_delivery'
		or v_wake.id is null or v_wake.wake_kind <> 'room' or v_wake.source_kind <> 'room' then
		raise exception 'execution recovery action is unavailable' using errcode = '55000'; end if;
	-- The wake runs on its requester's authority, so only the author of the post retries it.
	if v_wake.requested_by_user_id <> v_user then
		raise exception 'Only the author of the post can retry it' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_execution_run_events as resolved
		where resolved.run_id = v_run.id and resolved.event_type in ('recovery_released','recovery_discarded')) then
		raise exception 'execution recovery was already resolved' using errcode = '55000'; end if;
	if exists (select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = v_run.id and receipt.status in ('executing','ambiguous','completed'))
		or exists (select 1 from public.qorpera_company_proposals as proposal
			where proposal.execution_kind = 'run' and proposal.execution_id = v_run.id and proposal.status = 'open') then
		raise exception 'execution recovery cannot retry work with a durable operation outcome or open proposal'
			using errcode = '55000'; end if;
	-- A run that already spoke has delivered something; answering twice is not a retry.
	if exists (select 1 from public.qorpera_agent_sends as send where send.run_id = v_run.id) then
		raise exception 'execution recovery cannot retry a run that already answered' using errcode = '55000'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_run.profile_id);
	select * into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id for share;
	if not found or v_room.status <> 'active' or v_room.profile_id <> v_run.profile_id
		or not exists (select 1 from public.qorpera_company_room_members member
			where member.room_id = v_room.id and member.principal_kind = 'member' and member.principal_id = v_user
				and member.status = 'active')
		or not exists (select 1 from public.qorpera_company_room_members member
			join public.qorpera_profile_staff staff on staff.profile_id = v_room.profile_id
				and staff.staff_agent_id = member.principal_id and staff.employment_status = 'active'
			where member.room_id = v_room.id and member.principal_kind = 'staff_agent'
				and member.principal_id = v_wake.staff_agent_id and member.status = 'active') then
		raise exception 'Room is unavailable' using errcode = '42501'; end if;
	if p_sponsor_binding_id is null or p_sponsor_version is null or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings binding
			join public.qorpera_execution_sponsor_versions version on version.binding_id = binding.id and version.version = p_sponsor_version
			where binding.id = p_sponsor_binding_id and binding.profile_id = v_room.profile_id and binding.status = 'active'
				and binding.created_by_user_id = v_user) then
		raise exception 'Room sponsor is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_room.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_shared_sessions where id = v_room.session_id and status = 'open' for update;
	if not found then raise exception 'Room conversation is unavailable' using errcode = '42501'; end if;
	select count(*) into v_attempt from public.qorpera_wake_occurrences as earlier
	where earlier.wake_kind = 'room' and earlier.source_kind = 'room' and earlier.source_id = v_wake.source_id
		and earlier.staff_agent_id = v_wake.staff_agent_id;
	insert into public.qorpera_execution_run_events(run_id,event_type,payload)
	values (v_run.id,'recovery_released',jsonb_build_object('action','retry','resolved_by_user_id',v_user,
		'retry_occurrence_id',v_id));
	insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,
		staff_agent_id,requested_by_user_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,
		scheduled_for,not_before,payload)
	values (v_id,v_room.profile_id,v_room.environment_id,'room','room',v_wake.source_id,v_wake.staff_agent_id,v_user,
		p_sponsor_binding_id,p_sponsor_version,v_room.session_id,'room',
		'room:' || v_room.id::text || ':' || v_wake.source_id::text || ':' || v_wake.staff_agent_id::text
			|| ':retry:' || v_attempt::text,
		clock_timestamp(),clock_timestamp(),
		-- Exactly the payload of a first delivery: the runner parses a room wake as a
		-- closed object. The failed run is named in its recovery_released event.
		jsonb_build_object('roomId',v_room.id,'inputIds',jsonb_build_array(v_wake.source_id),
			'recipientStaffId',v_wake.staff_agent_id));
	return jsonb_build_object('schema','qorpera.company-room-retry/v1','runId',v_run.id,'roomId',v_room.id,
		'sessionId',v_room.session_id,'inputId',v_wake.source_id,'occurrenceId',v_id);
end
$function$
;
