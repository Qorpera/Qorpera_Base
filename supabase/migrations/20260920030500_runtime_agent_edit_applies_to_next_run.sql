-- An agent edit never ends a run. It applies from the agent's next run.
--
-- The agent details panel saves every inline edit at once, and every save raises
-- the agent's single version (a colour as much as a charter). The kernel held a
-- run to the exact agent version it was admitted at, so any edit while the agent
-- worked ended the run at its next send, File write or context read, and a wake
-- that waited in the queue through an edit was cancelled. The member saw "A run
-- did not finish" for changing a colour.
--
-- Rule: a run stays valid while its agent is active and the agent's version is
-- the run's version or a later one.
-- - In flight: wake authority, Company File write authority, office waiters and
--   office demand accept a later agent version. The job specification of a run
--   in flight is the charter recorded for the run's own version, and its context
--   describes the agent as of that version, so the edit does not reach into it
--   (the runner refuses a context whose agent version is not its run's).
-- - Admission: a queued wake is admitted at the agent's current version. The wake
--   keeps the version it was pinned with (its identity is immutable); its run may
--   be later, never earlier, and never later than the agent itself has reached.
-- Archiving or deleting an agent still ends its runs: every check keeps
-- employment_status = 'active'. Member turns keep their exact admission rule.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure), 'sha256'), 'hex') <> 'cb98372078dd79181fb8fe0fa31e8e434b68a1e548a84fb4bb222d3ebfcece91' then
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
			and staff_agent_id = p_wake.staff_agent_id and version >= p_wake.staff_version and employment_status = 'active')
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
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure), 'sha256'), 'hex') <> '5897d2e8237f40f2376cedd99933c3b8b2d2347babf99aecb2c14142ba2e716a' then
		raise exception 'Reviewed function definition changed: qorpera_materialize_wake_execution_runs';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_materialize_wake_execution_runs(p_limit integer DEFAULT 32)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_wake public.qorpera_wake_occurrences%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_file public.qorpera_company_files%rowtype; v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_id uuid; v_payload jsonb; v_digest text; v_capability text; v_job_type text;
	v_publication text; v_review text; v_reviewers uuid[]; v_sequence bigint; v_runs jsonb := '[]';
	v_compute uuid; v_mode text; v_worker_class text; v_now timestamptz;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Wake materialization authority or bound is invalid' using errcode = '42501'; end if;
	perform public.qorpera_drain_office_activation_wakes(p_limit);
	perform public.qorpera_drain_company_file_wakes(p_limit);
	v_now := clock_timestamp();
	for v_wake in select * from public.qorpera_wake_occurrences
		where status = 'queued' and not_before <= v_now
		order by admission_scan_at,not_before,created_at,id for update skip locked limit p_limit
	loop
		update public.qorpera_wake_occurrences set admission_scan_at = clock_timestamp()
		where id = v_wake.id;
		begin
			perform public.qorpera_serialize_wake_admission(v_wake.profile_id);
			if public.qorpera_company_execution_paused(v_wake.profile_id) then
				update public.qorpera_wake_occurrences set blocked_reason = 'Company execution is paused' where id = v_wake.id;
				continue;
			end if;
			select * into v_file from public.qorpera_company_files
			where environment_id = v_wake.environment_id and profile_id = v_wake.profile_id for update;
			perform 1 from public.qorpera_profile_members
			where profile_id = v_wake.profile_id and user_id = v_wake.requested_by_user_id for share;
			perform 1 from public.qorpera_profile_staff
			where profile_id = v_wake.profile_id and staff_agent_id = v_wake.staff_agent_id for share;
			if v_wake.wake_kind not in ('routine','agent','room') or not public.qorpera_wake_authorized(v_wake) then
				update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
					blocked_reason = 'Wake recipient or source authority is unavailable' where id = v_wake.id;
				continue;
			end if;
			v_capability := 'agent_turn'; v_job_type := 'agent_turn';
			v_publication := 'automatic'; v_review := null; v_reviewers := '{}';
			if v_wake.wake_kind = 'routine' then
				select * into strict v_version from public.qorpera_cloud_routine_versions
				where routine_id = v_wake.routine_id and version = v_wake.routine_version;
				v_capability := v_version.required_capability; v_job_type := v_version.job_type;
				v_publication := v_version.publication_mode; v_review := v_version.review_policy_key;
				v_reviewers := v_version.reviewer_staff_ids;
			elsif v_wake.source_kind='office-activation' then
    -- Continuing protected work cannot downgrade its publication policy.
    select required_capability,job_type,publication_mode,review_policy_key,reviewer_staff_ids
    into strict v_capability,v_job_type,v_publication,v_review,v_reviewers
    from public.qorpera_execution_runs where id=v_wake.parent_run_id;
			end if;
			perform 1 from public.qorpera_execution_sponsor_bindings b
			join public.qorpera_execution_sponsor_versions s on s.binding_id = b.id and s.version = v_wake.sponsor_version
			join public.qorpera_provider_connections c on c.id = s.provider_connection_id
			where b.id = v_wake.sponsor_binding_id and b.profile_id = v_wake.profile_id and b.status = 'active'
				and (v_wake.wake_kind = 'room' or (s.allow_autonomous and public.qorpera_provider_autonomous_authority(s.provider_connection_id,s.provider_connection_version))) and c.profile_id = v_wake.profile_id and c.status = 'active' for share of b,c;
			if not found then
				update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
					blocked_reason = 'Wake execution authority is unavailable' where id = v_wake.id;
				continue;
			end if;
			select * into v_substrate from public.qorpera_company_substrate_versions
			where profile_id = v_wake.profile_id and environment_id = v_wake.environment_id
				and company_snapshot_id = v_file.head_snapshot_id order by created_at desc,id desc limit 1;
			if v_file.head_snapshot_id is null or v_substrate.id is null or (v_wake.logical_computer_id is not null
				and not exists(select 1 from public.qorpera_logical_computers where id = v_wake.logical_computer_id
					and profile_id = v_wake.profile_id and status = 'active' and capabilities ? v_capability)) then
				update public.qorpera_wake_occurrences set blocked_reason = 'Pinned Company File or computer is unavailable'
				where id = v_wake.id;
				continue;
			end if;
			-- Resolve compute from the already authorized immutable sponsor/capsule,
			-- then let the existing native provenance trigger verify ownership.
			select c.compute_identity_id,v.authentication_mode into v_compute,v_mode
			from public.qorpera_execution_sponsor_versions s join public.qorpera_provider_connection_versions v
				on v.connection_id = s.provider_connection_id and v.version = s.provider_connection_version
			left join public.qorpera_native_credential_capsules c on c.id = v.credential_capsule_id and c.status = 'active'
			where s.binding_id = v_wake.sponsor_binding_id and s.version = v_wake.sponsor_version;
			v_worker_class := 'managed_sandbox';
			if v_wake.logical_computer_id is not null then
				select computer_class into v_worker_class from public.qorpera_logical_computers where id = v_wake.logical_computer_id
					and (v_compute is null or compute_identity_id = v_compute);
				if v_compute is null then
					select compute_identity_id into v_compute from public.qorpera_logical_computers where id = v_wake.logical_computer_id;
				end if;
			end if;
			if (v_mode = 'native_subscription' and v_compute is null) or v_worker_class is null then
				update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
					blocked_reason = 'Wake compute authority is unavailable' where id = v_wake.id;
				continue;
			end if;
			if not public.qorpera_try_lock_execution_identity(v_wake.profile_id,v_compute) then
				update public.qorpera_wake_occurrences
				set blocked_reason = 'Compute identity is unavailable or recovering' where id = v_wake.id;
				continue;
			end if;
			v_id := extensions.gen_random_uuid();
			v_payload := jsonb_build_object('schema','qorpera.wake-run/v1','occurrenceId',v_wake.id);
			v_digest := encode(extensions.digest(convert_to(v_payload::text,'utf8'),'sha256'),'hex');
			-- A room post enters the room conversation once, before any agent's run.
			if v_wake.wake_kind = 'room' then
				perform public.qorpera_append_execution_input_events(v_wake.session_id,array[v_wake.source_id]);
			end if;
			select coalesce(max(sequence),0) into v_sequence from public.qorpera_session_events where session_id = v_wake.session_id;
			insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
				required_capability,job_type,payload,created_by_user_id)
			values(v_wake.profile_id,v_wake.environment_id,v_wake.session_id,v_substrate.id,v_id,
				v_capability,v_job_type,v_payload,v_wake.requested_by_user_id) returning * into v_job;
			insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
				substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
				required_capability,job_type,payload_sha256,publication_mode,review_policy_key,reviewer_staff_ids,logical_computer_id,
				compute_identity_id,worker_class,transcript_start_sequence,created_by_user_id)
			values(v_id,v_wake.profile_id,v_wake.environment_id,case when v_wake.wake_kind = 'room' then 'room_delivery' else 'wake' end,
				v_wake.id,v_wake.session_id,v_job.id,
				v_substrate.id,v_file.head_snapshot_id,v_wake.staff_agent_id,
				-- The agent row is share-locked above. A wake that waited through an edit
				-- is this agent's next run and takes the current version.
				(select staff.version from public.qorpera_profile_staff as staff
					where staff.profile_id = v_wake.profile_id and staff.staff_agent_id = v_wake.staff_agent_id),'{}',
				v_wake.sponsor_binding_id,v_wake.sponsor_version,v_capability,v_job_type,v_digest,
				v_publication,v_review,v_reviewers,v_wake.logical_computer_id,v_compute,v_worker_class,v_sequence,v_wake.requested_by_user_id)
			returning * into v_run;
			update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
			if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
				update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
				delete from public.qorpera_execution_runs where id = v_run.id;
				delete from public.qorpera_runner_jobs where id = v_job.id;
				update public.qorpera_wake_occurrences set blocked_reason = 'Execution sponsor authority or quota is unavailable'
				where id = v_wake.id;
				continue;
			end if;
			update public.qorpera_wake_occurrences set status = 'materialized',run_id = v_run.id,blocked_reason = null where id = v_wake.id;
			insert into public.qorpera_execution_run_events(run_id,event_type) values(v_run.id,'queued');
			v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
		exception when lock_not_available then
			continue;
		end;
	end loop;
	return v_runs;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure), 'sha256'), 'hex') <> '964cc556dadafbd47c20607d6e7de217cc2532e5faeb527c5d20ec90f03d318a' then
		raise exception 'Reviewed function definition changed: qorpera_runtime_wake_policy_internal';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runtime_wake_policy_internal(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_trigger jsonb; v_reporting text := 'optional'; v_count integer; v_human integer; v_kickoff integer; v_kind text;
begin
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run_id;
	if v_run.id is null or v_wake.id is null or v_wake.wake_schema <> 'qorpera.wake-envelope/v1'
		or v_wake.source_id is null or v_wake.causal_root_id is null
		or cardinality(v_wake.causal_agent_ids) not between 1 and 16
		or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_wake.staff_agent_id
		or v_wake.staff_agent_id is distinct from v_run.staff_agent_id
		or v_wake.staff_version is null or v_run.staff_version is null or v_run.staff_version < v_wake.staff_version
		-- A run is admitted at the agent's current version, which may be later than
		-- its wake's. It can never claim a version its agent has not reached.
		or not exists(select 1 from public.qorpera_profile_staff as staff where staff.profile_id = v_run.profile_id
			and staff.staff_agent_id = v_run.staff_agent_id and staff.version >= v_run.staff_version)
		or v_wake.requested_by_user_id is distinct from v_run.requested_by_user_id
		or v_wake.profile_id is distinct from v_run.profile_id
		or v_wake.environment_id is distinct from v_run.environment_id
		or v_wake.sponsor_binding_id is distinct from v_run.sponsor_binding_id
		or v_wake.sponsor_version is distinct from v_run.sponsor_version
		or v_wake.logical_computer_id is distinct from v_run.logical_computer_id
		or v_wake.session_id is distinct from v_run.session_id
		or (v_run.source_kind = 'wake' and (v_run.source_id is distinct from v_wake.id
			or cardinality(v_run.input_ids) <> 0
			or (v_wake.source_kind = 'schedule' and v_wake.source_id is distinct from v_wake.routine_id)
			or (v_wake.source_kind = 'company-file' and v_wake.source_id is distinct from v_wake.file_event_id)
			or (v_wake.source_kind = 'coworker' and v_wake.source_id is distinct from v_wake.id)
			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file'))
				or (v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation')))))
		or (v_run.source_kind = 'session_turn' and (v_wake.source_kind <> 'input'
			or v_run.job_type <> 'agent_turn'
			or v_wake.wake_kind not in ('human','first-run') or not coalesce(v_wake.source_id = any(v_run.input_ids),false)
			or v_wake.payload -> 'inputIds' is distinct from to_jsonb(v_run.input_ids)))
		or (v_run.source_kind = 'room_delivery' and (v_wake.wake_kind <> 'room' or v_wake.source_kind <> 'room'
			or v_run.source_id is distinct from v_wake.id or cardinality(v_run.input_ids) <> 0 or v_run.job_type <> 'agent_turn'))
		or v_run.source_kind not in ('session_turn','wake','room_delivery') then
		return public.qorpera_wake_policy_value(null); end if;
	if v_run.source_kind = 'session_turn' then
		select count(*),count(*) filter(where kind = 'user_message'),count(*) filter(where kind = 'kickoff')
		into v_count,v_human,v_kickoff from public.qorpera_session_inputs
		where id = any(v_run.input_ids) and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id
			and execution_run_id = v_run.id;
		v_kind := case when v_count = cardinality(v_run.input_ids) and v_count = v_human + v_kickoff
			then case when v_human > 0 then 'human' when v_kickoff = 1 then 'first-run' end end;
		if v_kind is null or v_kind <> v_wake.wake_kind
			or not public.qorpera_uuid_array_is_unique(v_run.input_ids) then return public.qorpera_wake_policy_value(null); end if;
	end if;
	if v_wake.wake_kind = 'routine' then
		select t.value into v_trigger from public.qorpera_cloud_routine_versions v,
			lateral jsonb_array_elements(v.triggers) t(value)
		where v.routine_id = v_wake.routine_id and v.version = v_wake.routine_version
			and v.profile_id = v_run.profile_id and v.environment_id = v_run.environment_id
			and v.created_by_user_id = v_run.requested_by_user_id and v.staff_agent_id = v_run.staff_agent_id
			and v.sponsor_binding_id = v_run.sponsor_binding_id and v.sponsor_version = public.qorpera_wake_standing_sponsor_version(v_wake)
			and v.required_capability = v_run.required_capability and v.job_type = v_run.job_type
			and t.value ->> 'id' = v_wake.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger) then
			return public.qorpera_wake_policy_value(null); end if;
		if (v_wake.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')
			or (v_wake.source_kind = 'company-file' and v_trigger ->> 'kind' <> 'listener') then
			return public.qorpera_wake_policy_value(null); end if;
		v_reporting := coalesce(v_trigger ->> 'replyPolicy','required');
	end if;
	if v_wake.wake_kind = 'room' and exists (select 1 from public.qorpera_company_rooms room
		where room.session_id = v_wake.session_id and room.bound_staff_agent_id = v_wake.staff_agent_id) then
		v_reporting := 'required'; end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_company_path_actor(uuid,jsonb)'::regprocedure), 'sha256'), 'hex') <> 'd25a03df42a373312bcc521198fce24297aaa37d49c6edfc0488fbf1be52bc72' then
		raise exception 'Reviewed function definition changed: qorpera_company_path_actor';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_company_path_actor(p_environment_id uuid, p_binding jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_file public.qorpera_company_files%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_user uuid; v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	if p_binding is not null then
		v_run := public.qorpera_native_tool_locked_run(p_binding);
		if v_run.environment_id <> p_environment_id or v_run.source_kind = 'proposal_review' then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		if v_run.session_id is not null then
			perform 1 from public.qorpera_shared_sessions session where session.id = v_run.session_id
				and session.profile_id = v_run.profile_id and session.environment_id = v_run.environment_id
				and (session.staff_agent_id = v_run.staff_agent_id::text
					or (session.staff_agent_id is null and public.qorpera_company_room_session_staff(session.id,v_run.staff_agent_id)))
				and session.status = 'open'
				and session.audience_kind = v_run.audience_kind
				and session.audience_user_id is not distinct from v_run.audience_user_id for share;
			if not found then raise exception 'Company File audience is unavailable' using errcode = '42501'; end if;
		end if;
		if exists (select 1 from unnest(v_run.input_ids) requested(id)
			left join public.qorpera_session_inputs input on input.id = requested.id
			where input.id is null or input.session_id is distinct from v_run.session_id
				or input.execution_run_id is distinct from v_run.id
				or input.author_user_id is distinct from v_run.requested_by_user_id
				or input.runtime_bundle_id <> v_run.runtime_bundle_id
				or input.runtime_bundle_sha256 <> v_run.runtime_bundle_sha256) then
			raise exception 'Company File requesting input changed' using errcode = '42501'; end if;
		v_user := v_run.requested_by_user_id;
	else
		v_user := auth.uid();
		if auth.role() is distinct from 'authenticated' or v_user is null then
			raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
		select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or not exists (select 1 from public.qorpera_profile_members
		where profile_id = v_file.profile_id and user_id = v_user) then
		raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	if v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	if v_file.path_gateway_version is distinct from 1 or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then
		raise exception 'Company File gateway is unavailable' using errcode = '55000'; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = v_user for share;
	if not found then raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	if p_binding is not null then
		perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id
			and staff_agent_id = v_run.staff_agent_id and version >= v_run.staff_version
			and employment_status = 'active' for share;
		if not found then raise exception 'Company File staff version changed' using errcode = '42501'; end if;
		perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id
			and user_id = v_run.sponsored_by_user_id for share;
		perform 1 from public.qorpera_execution_sponsor_bindings where id = v_run.sponsor_binding_id for share;
		perform 1 from public.qorpera_provider_connections connection
		join public.qorpera_execution_sponsor_versions sponsor on sponsor.provider_connection_id = connection.id
		where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version for share of connection;
		perform 1 from public.qorpera_runner_assignments where id = (p_binding ->> 'assignmentId')::uuid for share;
		perform 1 from public.qorpera_runners where id = (p_binding ->> 'runnerId')::uuid for share;
		perform 1 from public.qorpera_member_compute_identities where id = v_run.compute_identity_id for share;
		perform 1 from public.qorpera_native_credential_capsules where id = (p_binding ->> 'credentialCapsuleId')::uuid for share;
		perform public.qorpera_native_tool_locked_run(p_binding);
	end if;
	if public.qorpera_profile_gc_deletion_active(v_file.profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company File storage is busy', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	return jsonb_build_object('companyId',v_file.profile_id,'environmentId',p_environment_id,'userId',v_user,
		'staffAgentId',v_run.staff_agent_id,'runId',v_run.id,'jobId',v_run.job_id,
		'assignmentId',p_binding ->> 'assignmentId','sponsorBindingId',v_run.sponsor_binding_id,
		'sponsorVersion',v_run.sponsor_version,
		'audience',case when p_binding is null then 'human' else v_run.audience_kind end,
		'audienceUserId',case when p_binding is null then v_user else v_run.audience_user_id end,
		'runtimeBundleId',coalesce(v_run.runtime_bundle_id,v_bundle.runtime_bundle_id),
		'runtimeBundleSha256',coalesce(v_run.runtime_bundle_sha256,v_bundle.runtime_bundle_sha256));
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure), 'sha256'), 'hex') <> 'd1df3dffaa601708cf3af62abac4885ebeee1847184fa518758ccb8670867bad' then
		raise exception 'Reviewed function definition changed: qorpera_company_context_source';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_company_context_source(p_run public.qorpera_execution_runs, p_kind text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_input public.qorpera_session_inputs%rowtype; v_event public.qorpera_session_events%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_text text; v_author uuid; v_kind text; v_actor_kind text;
	v_attachments integer := 0;
begin
	if p_kind = 'input' then
		select * into v_input from public.qorpera_session_inputs where id = p_id and id = any(p_run.input_ids)
			and session_id = p_run.session_id and execution_run_id = p_run.id;
		if not found or v_input.author_user_id <> p_run.requested_by_user_id
			or v_input.runtime_bundle_id <> p_run.runtime_bundle_id
			or v_input.runtime_bundle_sha256 <> p_run.runtime_bundle_sha256 then
			raise exception 'Cloud context input is unavailable' using errcode = '42501'; end if;
		v_kind := case when v_input.kind = 'kickoff' or v_input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1'
			then 'private_startup' else 'current_human_request' end;
		v_actor_kind := v_input.actor_kind; v_author := v_input.author_user_id;
		v_text := case when jsonb_typeof(v_input.body -> 'text') = 'string' then v_input.body ->> 'text' else v_input.body::text end;
		if jsonb_typeof(v_input.body -> 'images') = 'array' then v_attachments := jsonb_array_length(v_input.body -> 'images'); end if;
	elsif p_kind = 'history' then
		select * into v_event from public.qorpera_session_events where event_id = p_id and session_id = p_run.session_id
			and sequence <= p_run.transcript_start_sequence and event_type = 'message' and not (event_id = any(p_run.input_ids));
		if not found then raise exception 'Cloud context history is unavailable' using errcode = '42501'; end if;
		select input.* into v_input from public.qorpera_session_inputs input where input.id = v_event.session_input_id
			and input.session_id = p_run.session_id and input.author_user_id = v_event.actor_user_id;
		if found then v_kind := 'historical_human_message'; v_actor_kind := 'human'; v_author := v_input.author_user_id;
		elsif exists (select 1 from public.qorpera_agent_sends where event_id = v_event.event_id and session_id = p_run.session_id) then
			v_kind := 'historical_agent_send'; v_actor_kind := 'staff_agent';
		else v_kind := 'historical_data'; v_actor_kind := 'company_service'; end if;
		v_text := v_event.body::text;
	elsif p_kind = 'job' and p_id = p_run.id then
		select payload::text into strict v_text from public.qorpera_runner_jobs where id = p_run.job_id and run_id = p_run.id;
		v_kind := 'wake_data'; v_actor_kind := 'control_plane';
	elsif p_kind = 'continuation' and p_id = p_run.id then
		v_text := public.qorpera_run_continuation(p_run)::text;
		if v_text is null then raise exception 'Run has no continuation' using errcode = '42501'; end if;
		v_kind := 'completed_work'; v_actor_kind := 'control_plane';
	elsif p_kind = 'job_spec' and p_id = p_run.staff_agent_id then
		select * into v_staff from public.qorpera_profile_staff where profile_id = p_run.profile_id
			and staff_agent_id = p_run.staff_agent_id and version >= p_run.staff_version and employment_status = 'active';
		if not found then raise exception 'Cloud context job specification changed' using errcode = '42501'; end if;
		v_kind := 'job_specification'; v_actor_kind := 'company_service'; v_text := v_staff.charter;
		-- An edit applies from the next run. A run in flight keeps the charter of its
		-- own version, read from the agent's recorded state at that version.
		if v_staff.version <> p_run.staff_version then
			select operation.payload ->> 'charter' into v_text from public.qorpera_company_operations as operation
			where operation.profile_id = p_run.profile_id and operation.operation_type = 'staff_state'
				and operation.entity_id = p_run.staff_agent_id and operation.entity_version = p_run.staff_version
			order by operation.sequence desc limit 1;
			if v_text is null then raise exception 'Cloud context job specification changed' using errcode = '42501'; end if;
		end if;
	else raise exception 'Cloud context source is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('kind',v_kind,'sourceKind',p_kind,'id',p_id,'actorKind',v_actor_kind,
		'authorUserId',v_author,'sequence',v_event.sequence,'attachmentCount',v_attachments,'text',coalesce(v_text,''));
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_office_waiter_authorized(public.qorpera_runtime_office_start_waiters)'::regprocedure), 'sha256'), 'hex') <> '81c96a849b4bd30cda06c4fe9ba79bcccca2a572804d2dc9f687a59b6eb5e876' then
		raise exception 'Reviewed function definition changed: qorpera_office_waiter_authorized';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_office_waiter_authorized(p_waiter public.qorpera_runtime_office_start_waiters)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_intent public.qorpera_runtime_office_start_intents%rowtype;
 v_parent public.qorpera_execution_runs%rowtype; v_office public.qorpera_runtime_offices%rowtype; v_job_status text;
 v_parent_wake public.qorpera_wake_occurrences%rowtype;
begin
 select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id;
 if not found then return false; end if;
 -- Standalone effect validators may already hold a job lock. Acquire the
 -- common profile fence without waiting before taking any office/grant lock.
 perform 1 from public.qorpera_profiles where id=v_parent.profile_id for update nowait;
 if not found then return false; end if;
 select * into v_intent from public.qorpera_runtime_office_start_intents where id=p_waiter.intent_id for share nowait;
 select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id for share nowait;
 select status into v_job_status from public.qorpera_runner_jobs where id=v_parent.job_id for share nowait;
 select * into v_office from public.qorpera_runtime_offices where id=v_intent.office_id for share nowait;
 if v_office.id is null or v_parent.id is null or v_intent.state<>'reserved'
  or v_office.state<>'active' or v_office.generation<>v_intent.computer_generation
  or v_office.image_sha256<>v_intent.image_sha256 or v_office.bootstrap_sha256<>v_intent.bootstrap_sha256
  or v_parent.profile_id<>v_office.profile_id or v_parent.environment_id<>v_office.environment_id
  or v_parent.audience_kind<>'company' or v_parent.audience_user_id is not null
  or v_job_status is distinct from 'completed' or v_parent.staff_version<>p_waiter.staff_version
  or p_waiter.state='cancelled' or public.qorpera_company_execution_paused(v_parent.profile_id) then return false; end if;
 -- Bound repeated internal revivals before admission, rather than launching
 -- a run whose complete historical context cannot be read. Source authority
 -- remains current, including room membership and revoked routine intent.
 if exists(with recursive ancestry(run_id,depth) as (
  select v_parent.id,1 union all select w.parent_run_id,a.depth+1 from ancestry a
  join public.qorpera_wake_occurrences w on w.run_id=a.run_id
  where w.source_kind='office-activation' and a.depth<9
 ) select 1 from ancestry where depth=9) then return false; end if;
 select * into v_parent_wake from public.qorpera_wake_occurrences where run_id=v_parent.id;
 if not found or public.qorpera_runtime_wake_policy_internal(v_parent.id)->>'kind' is distinct from v_parent_wake.wake_kind
  or not public.qorpera_wake_authorized(v_parent_wake) then return false; end if;
 perform 1 from public.qorpera_profile_staff where profile_id=v_parent.profile_id and staff_agent_id=v_parent.staff_agent_id
  and version>=p_waiter.staff_version and employment_status='active' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_profile_members where profile_id=v_parent.profile_id and user_id=v_parent.requested_by_user_id for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_runtime_office_access where office_id=v_office.id and profile_id=v_parent.profile_id
  and staff_agent_id=v_parent.staff_agent_id and grant_id=p_waiter.grant_id and version=p_waiter.grant_version and state='active' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_runtime_machine_allocations where id=v_intent.allocation_id and office_id=v_office.id
  and profile_id=v_office.profile_id and computer_generation=v_office.generation and released_at is null
  and instance_sha256=v_intent.instance_sha256 and provider_adapter='lxd' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_logical_computers computer where id=v_office.logical_computer_id
  and status='active' and public.qorpera_runtime_office_matches(computer) for share nowait;
 if not found then return false; end if;
 if not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
  and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
  or not exists(select 1 from public.qorpera_runtime_office_activations where intent_id=v_intent.id
   and office_id=v_office.id and computer_generation=v_office.generation and state='active' and superseded_at is null
   and allocation_id=v_intent.allocation_id and instance_sha256=v_intent.instance_sha256
   and provider_binding_sha256=v_intent.provider_binding_sha256)
  or not exists(select 1 from public.qorpera_run_operation_receipts where id=p_waiter.receipt_id
   and run_id=v_parent.id and status='completed' and operation_kind='cloud_tool'
   and logical_operation_key like 'computer_start:%' and not requires_company_revision)
  or exists(select 1 from public.qorpera_run_operation_receipts where run_id=v_parent.id
   and (status<>'completed' or completed_at is null or jsonb_typeof(result) is distinct from 'object'
    or (requires_company_revision and output_snapshot_id is null and proposal_id is null and company_path_proposal_id is null))) then return false; end if;
 return true;
end $function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure), 'sha256'), 'hex') <> 'f14feecb60cdb368933c0f89c53bad06929045bff2ac4120cd14424ece54cc8d' then
		raise exception 'Reviewed function definition changed: qorpera_runtime_office_has_demand';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runtime_office_has_demand(p_office public.qorpera_runtime_offices)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
	select p_office.privacy_state<>'shared'
		or exists(select 1 from public.qorpera_runtime_office_screens s where s.office_id=p_office.id
			and (s.drain_pending or s.takeover_user_id is not null or s.lease_id is not null))
		or exists(select 1 from public.qorpera_runtime_office_resources r where r.office_id=p_office.id and r.state<>'drained')
		or exists(select 1 from public.qorpera_runtime_office_viewers v where v.office_id=p_office.id
			and v.state<>'ended' and (v.expires_at>clock_timestamp() or v.mode='control' or v.state='draining'))
		-- Tool discovery precedes the first guest lease. Retain a warm office for
		-- its currently authorized turns, including routines while members are away.
		or exists(select 1 from public.qorpera_execution_runs e join public.qorpera_runner_jobs j on j.id=e.job_id
			join public.qorpera_runtime_office_access g on g.office_id=p_office.id and g.profile_id=e.profile_id and g.staff_agent_id=e.staff_agent_id
			join public.qorpera_profile_staff s on s.profile_id=e.profile_id and s.staff_agent_id=e.staff_agent_id
			where e.profile_id=p_office.profile_id and e.environment_id=p_office.environment_id
			and e.audience_kind='company' and e.audience_user_id is null and j.status in ('queued','leased')
			and e.deadline_at>clock_timestamp() and g.state='active' and s.employment_status='active' and s.version>=e.staff_version)
		or exists(select 1 from public.qorpera_runtime_office_start_waiters w
			join public.qorpera_runtime_office_start_intents i on i.id=w.intent_id
			join public.qorpera_execution_runs e on e.id=w.parent_run_id
			join public.qorpera_runner_jobs j on j.id=e.job_id
			where i.office_id=p_office.id and i.computer_generation=p_office.generation
			and w.state='waiting' and j.status not in ('failed','cancelled'))
		or exists(select 1 from public.qorpera_wake_occurrences w
			left join public.qorpera_execution_runs e on e.id=w.run_id
			left join public.qorpera_runner_jobs j on j.id=e.job_id
			where w.source_kind='office-activation' and w.payload->>'companyComputerId'=p_office.id::text
			and (w.status='queued' or j.status in ('queued','leased','running')))
$function$
;

-- The context description is patched in place, like 20260919234000 does, so the
-- two patches commute on a backend that receives them in either order.
do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure);
	v_old text;
	v_new text;
begin
	v_old := $old$ v_result jsonb; v_continuation jsonb;$old$;
	v_new := $new$ v_result jsonb; v_continuation jsonb; v_recorded jsonb;$new$;
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Run context declaration differs'; end if;
	v_definition := replace(v_definition,v_old,v_new);
	v_old := $old$	select * into strict v_staff from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and staff_agent_id = v_run.staff_agent_id;$old$;
	v_new := v_old || $new$
	-- An edit applies from the next run. A run describes its agent as of its own
	-- version, from the state recorded for that version.
	if v_staff.version <> v_run.staff_version then
		select operation.payload into v_recorded from public.qorpera_company_operations as operation
		where operation.profile_id = v_run.profile_id and operation.operation_type = 'staff_state'
			and operation.entity_id = v_run.staff_agent_id and operation.entity_version = v_run.staff_version
		order by operation.sequence desc limit 1;
		if v_recorded is null or v_staff.version < v_run.staff_version then
			raise exception 'Cloud context agent version is unavailable' using errcode = '42501'; end if;
		v_staff.version := v_run.staff_version;
		v_staff.display_name := v_recorded ->> 'display_name';
		v_staff.role := v_recorded ->> 'role';
	end if;$new$;
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Run context agent clause differs'; end if;
	execute replace(v_definition,v_old,v_new);
end
$patch$;
