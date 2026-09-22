-- A failed post into a room can be tried again.
--
-- qorpera_resolve_failed_execution_run retries session turns only. Agent threads
-- are rooms (2026-09-17 amendment), so a member whose post ended in a failed run
-- could only dismiss it and type the message again. The retry keeps the member's
-- message as it is: the failed run is released from recovery and the same input
-- wakes the same agent once more, under a new occurrence key, on the account the
-- member chooses now. Every gate of a first delivery applies again (room and
-- company membership, sponsor authority, the founder stop, the wake ceilings),
-- because the new wake goes through the same pin trigger and materializer.
create function public.qorpera_retry_room_delivery(p_run_id uuid,p_sponsor_binding_id uuid,p_sponsor_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
		jsonb_build_object('roomId',v_room.id,'inputIds',jsonb_build_array(v_wake.source_id),
			'recipientStaffId',v_wake.staff_agent_id,'retryOfRunId',v_run.id));
	return jsonb_build_object('schema','qorpera.company-room-retry/v1','runId',v_run.id,'roomId',v_room.id,
		'sessionId',v_room.session_id,'inputId',v_wake.source_id,'occurrenceId',v_id);
end
$$;
revoke all on function public.qorpera_retry_room_delivery(uuid,uuid,bigint) from public,anon,service_role;
grant execute on function public.qorpera_retry_room_delivery(uuid,uuid,bigint) to authenticated;
