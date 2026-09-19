-- An agent thread is one durable conversation per agent (2026-09-17 amendment),
-- and agents are edited while their thread lives. Member turns advance the
-- session's agent version when they are admitted; wakes and room deliveries
-- never did, yet three checks on that path demanded the exact version. After
-- any agent edit the agent's answers were refused with QRC01 "runner transcript
-- session pins changed" and reporting routines lost their public audience
-- (found live 2026-09-19: thread at version 1, agent at version 24).
--
-- A wake is admitted at the agent's current version, so it may use a session
-- opened at an earlier version of the same agent, like the Company File
-- successor rule for the snapshot pin. A run older than the session's pin is
-- still refused, and member turns keep their exact pin.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_wake_public_session(uuid,uuid,uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> 'e1cc874c23278e72e4707c1f2336af030bdc11f6b8911f568fb553e42a02742e' then
		raise exception 'Reviewed function definition changed: qorpera_wake_public_session';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_wake_public_session(p_profile uuid, p_environment uuid, p_staff uuid, p_requester uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_session uuid;
begin
	select s.id into v_session from public.qorpera_shared_sessions s
	join public.qorpera_profile_staff a on a.profile_id = s.profile_id
		and a.staff_agent_id = p_staff and a.version >= s.staff_version and a.employment_status = 'active'
	where s.profile_id = p_profile and s.environment_id = p_environment
		and s.staff_agent_id = p_staff::text and s.status = 'open'
		and (s.audience_kind = 'company' or (p_requester is not null and s.audience_kind = 'member_private'
			and s.audience_user_id = p_requester))
		and (coalesce(s.execution_scope ->> 'agentThread','') = 'true'
			or not (s.execution_scope ?| array['autonomousLabel','roomId','group','parentSession']))
	order by case when coalesce(s.execution_scope ->> 'agentThread','') = 'true' then 0 else 1 end,
		case when s.audience_kind = 'company' then 0 else 1 end, s.created_at, s.id
	limit 1 for share of s,a nowait;
	return v_session;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure), 'sha256'), 'hex') <> 'a1b8d1faaea9bab739f21ccfc8b43a522ceb60a4dc33d5d0460594277a0cb2ce' then
		raise exception 'Reviewed function definition changed: qorpera_wake_authorized';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_wake_authorized(p_wake public.qorpera_wake_occurrences)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ancestry jsonb; v_actor uuid; v_revision public.qorpera_company_path_revisions%rowtype; v_path text;
 v_standing_version bigint := public.qorpera_wake_standing_sponsor_version(p_wake);
begin
 if v_standing_version is null then return false; end if;
 -- Hold source authority through the effect transaction. NOWAIT avoids a
 -- lock inversion with an editor already holding a routine and its File.
 -- Contention retries; a changed repeatable-read row fails serialization.
 if p_wake.wake_kind='routine' then
  perform 1 from public.qorpera_cloud_routines where id=p_wake.routine_id for share nowait;
 elsif p_wake.wake_kind='agent' then
  perform 1 from public.qorpera_staff_execution_authorities
  where profile_id=p_wake.profile_id and staff_agent_id=p_wake.staff_agent_id for share nowait;
 elsif p_wake.wake_kind='room' then
  perform 1 from public.qorpera_company_rooms where session_id=p_wake.session_id for share nowait;
  perform 1 from public.qorpera_company_room_members member
  join public.qorpera_company_rooms room on room.id=member.room_id
  where room.session_id=p_wake.session_id and member.principal_id in (p_wake.requested_by_user_id,p_wake.staff_agent_id)
  order by member.principal_kind,member.principal_id for share of member nowait;
 end if;
	if p_wake.wake_schema <> 'qorpera.wake-envelope/v1'
		or (p_wake.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
			where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id))
		or not exists(select 1 from public.qorpera_profile_members where profile_id = p_wake.profile_id
			and user_id = p_wake.requested_by_user_id)
		or not exists(select 1 from public.qorpera_profile_staff where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and version = p_wake.staff_version and employment_status = 'active')
		or (p_wake.session_id is not null and not exists(select 1 from public.qorpera_shared_sessions
			where id = p_wake.session_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id
				and (staff_agent_id = p_wake.staff_agent_id::text or (p_wake.wake_kind = 'room' and staff_agent_id is null
					and execution_scope ->> 'roomId' is not null)) and status = 'open'
				and (p_wake.wake_kind <> 'routine' or (staff_version <= p_wake.staff_version and not
					(coalesce(execution_scope ->> 'agentThread','') <> 'true'
						and execution_scope ?| array['autonomousLabel','roomId','group','parentSession']))))) then return false; end if;
	-- An older occurrence may have been pinned without a public audience.
	-- Do not attach a later session or reserve compute for an unsatisfiable
	-- final obligation. Only explicit optional/silent reporting allows none.
	if p_wake.wake_kind = 'routine' and p_wake.session_id is null and not exists(
		select 1 from public.qorpera_cloud_routine_versions v,
			lateral jsonb_array_elements(v.triggers) t(value)
		where v.routine_id = p_wake.routine_id and v.version = p_wake.routine_version
			and t.value ->> 'id' = p_wake.trigger_id
			and public.qorpera_cloud_routine_trigger_valid(t.value)
			and t.value ->> 'replyPolicy' in ('optional','silent')
	) then return false; end if;
	if p_wake.wake_kind = 'routine' and not exists(
		select 1 from public.qorpera_cloud_routines r join public.qorpera_cloud_routine_versions v
			on v.routine_id = r.id and v.version = r.current_version
		where r.id = p_wake.routine_id and r.status = 'active' and v.version = p_wake.routine_version
			and v.created_by_user_id = p_wake.requested_by_user_id and v.staff_agent_id = p_wake.staff_agent_id
			and v.sponsor_binding_id = p_wake.sponsor_binding_id and v.sponsor_version = v_standing_version
	) then return false; end if;
	if p_wake.wake_kind = 'room' then
		if p_wake.source_kind <> 'room' or p_wake.session_id is null or not exists (
			select 1 from public.qorpera_company_rooms room
			join public.qorpera_company_room_members agent on agent.room_id = room.id and agent.principal_kind = 'staff_agent'
				and agent.principal_id = p_wake.staff_agent_id and agent.status = 'active'
			join public.qorpera_company_room_members poster on poster.room_id = room.id and poster.principal_kind = 'member'
				and poster.principal_id = p_wake.requested_by_user_id and poster.status = 'active'
			join public.qorpera_session_inputs input on input.id = p_wake.source_id and input.session_id = room.session_id
			where room.session_id = p_wake.session_id and room.profile_id = p_wake.profile_id and room.status = 'active') then
			return false; end if;
	end if;
	if p_wake.source_kind = 'company-file' then
		select * into v_revision from public.qorpera_company_path_revisions
		where snapshot_id = p_wake.file_event_id and environment_id = p_wake.environment_id;
		if not found or v_revision.run_id is distinct from p_wake.parent_run_id
			or not coalesce(public.qorpera_wake_path_authorized(p_wake.environment_id,p_wake.requested_by_user_id,
				p_wake.staff_agent_id,v_revision.change #>> '{plan,path}'),false) then return false; end if;
		v_actor := v_revision.actor_staff_id;
	elsif p_wake.wake_kind = 'agent' then
		if not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and sponsor_binding_id = p_wake.sponsor_binding_id
			and sponsor_version = v_standing_version
			and logical_computer_id is not distinct from p_wake.logical_computer_id) then return false; end if;
		select staff_agent_id into v_actor from public.qorpera_execution_runs
		where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id;
		if not found then return false; end if;
		-- Coworker content cannot wash an already-read path's authority away.
		-- Use the existing durable read set, not another taint or memory store.
		for v_path in select path from public.qorpera_company_run_read_paths where run_id = p_wake.parent_run_id loop
			if not coalesce(public.qorpera_wake_path_authorized(p_wake.environment_id,p_wake.requested_by_user_id,
				p_wake.staff_agent_id,v_path),false) then return false; end if;
		end loop;
	end if;
 if p_wake.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(p_wake);
 else v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,v_actor,p_wake.staff_agent_id,
  coalesce(p_wake.file_event_id,p_wake.id)); end if;
	return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
		and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids),false);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_append_runner_transcript_event(uuid,text,uuid,text,uuid,uuid,text,jsonb,bigint)'::regprocedure), 'sha256'), 'hex') <> '15b0896264bf44d6e6c07a3a339559f782e9467714408b3b74b4351d4f5a2742' then
		raise exception 'Reviewed function definition changed: qorpera_append_runner_transcript_event';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_append_runner_transcript_event(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_assignment_id uuid, p_event_id uuid, p_event_type text, p_body jsonb, p_expected_sequence bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.id is null or v_run.session_id is null or p_event_id is null
		or p_event_type not in (
			'message', 'run_receipt', 'artifact_receipt',
			'authorization_request', 'authorization_decision'
		) or p_body is null or octet_length(convert_to(p_body::text, 'utf8')) > 262144
		or coalesce(p_body ->> 'schema', '') <> 'qorpera.runner-transcript-entry/v1'
		or coalesce(jsonb_typeof(p_body -> 'entry'), '') <> 'object'
		or coalesce(p_body #>> '{entry,id}', '') <> p_event_id::text
		or not public.qorpera_runner_transcript_entry_valid(p_event_type, p_body)
		or coalesce(p_body #>> '{entry,execution,kind}', '') <> 'run'
		or coalesce(p_body #>> '{entry,execution,id}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,claimantId}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,runnerAssignmentId}', '') <> p_assignment_id::text
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.job_id = p_job_id
				and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted'
		) then
		raise exception 'runner transcript authority is invalid' using errcode = '42501';
	end if;
	select event.* into v_existing
	from public.qorpera_session_events as event where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> v_run.session_id or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body or v_existing.execution_kind <> 'run'
			or v_existing.execution_id <> v_run.id
			or v_existing.execution_claimant_id <> v_run.id then
			raise exception 'runner event id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id, 'sequence', v_existing.sequence,
			'event_id', v_existing.event_id, 'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id, 'body', v_existing.body,
			'previous_hash', v_existing.previous_hash, 'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind, 'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'runner_assignment_id', v_existing.runner_assignment_id,
			'created_at', v_existing.created_at
		);
	end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = v_run.session_id for update;
	if not found or v_session.status <> 'open'
		or v_session.profile_id <> v_run.profile_id or v_session.environment_id <> v_run.environment_id
		or not public.qorpera_run_head_follows_session_pin(v_run, v_session.company_snapshot_id)
		or (v_session.staff_agent_id is not null and v_session.staff_version <> v_run.staff_version
			and not (v_run.source_kind in ('wake', 'room_delivery')
				and v_run.staff_version > v_session.staff_version)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner transcript session pins changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if jsonb_typeof(p_body #> '{entry,parentId}') = 'string'
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body #>> '{entry,id}' = p_body #>> '{entry,parentId}'
		)
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
				and parent.body ->> 'entryId' = p_body #>> '{entry,parentId}'
				and jsonb_typeof(parent.body -> 'partIndex') = 'number'
				and jsonb_typeof(parent.body -> 'partCount') = 'number'
			group by parent.body ->> 'entryId', parent.body ->> 'partCount',
				parent.execution_kind, parent.execution_id, parent.execution_claimant_id
			having count(distinct (parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer
				and min((parent.body ->> 'partIndex')::integer) = 0
				and max((parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer - 1
		) then
		raise exception 'runner transcript parent is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_execution_run_budgets
	set transcript_event_count = transcript_event_count + 1,
		transcript_bytes = transcript_bytes + octet_length(convert_to(p_body::text, 'utf8'))
	where run_id = v_run.id and transcript_event_count < 2000
		and transcript_bytes + octet_length(convert_to(p_body::text, 'utf8')) <= 67108864;
	if not found then
		raise exception 'runner transcript budget is exhausted' using errcode = '55000';
	end if;
	select event.sequence, event.event_hash into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = v_session.id order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'session event sequence changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(extensions.digest(convert_to(
		coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
			'session_id', v_session.id,
			'sequence', v_sequence,
			'event_id', p_event_id,
			'event_type', p_event_type,
			'actor_user_id', v_run.created_by_user_id,
			'body', p_body,
			'execution_kind', 'run',
			'execution_id', v_run.id,
			'execution_claimant_id', v_run.id,
			'runner_assignment_id', p_assignment_id,
			'created_at', v_created_at
		)::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, runner_assignment_id, created_at
	) values (
		v_session.id, v_sequence, p_event_id, p_event_type, v_run.created_by_user_id, p_body,
		v_previous_hash, v_event_hash, 'run', v_run.id, v_run.id, p_assignment_id, v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = v_session.id;
	return jsonb_build_object(
		'session_id', v_session.id, 'sequence', v_sequence,
		'event_id', p_event_id, 'event_type', p_event_type,
		'actor_user_id', v_run.created_by_user_id, 'body', p_body,
		'previous_hash', v_previous_hash, 'event_hash', v_event_hash,
		'execution_kind', 'run', 'execution_id', v_run.id,
		'execution_claimant_id', v_run.id, 'runner_assignment_id', p_assignment_id,
		'created_at', v_created_at
	);
end
$function$
;
