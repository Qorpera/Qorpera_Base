-- Keep sponsored request inputs under their request's authority. Ordinary
-- configured-session batches may consume only inputs without a turn request.
-- Retire stale author inputs without aborting cross-company reconciliation;
-- defer paused or contended companies and preserve all existing wake guards.

-- Preserve the caller's original selection before sponsorship approval replaces
-- execution pins. Approved historical rows have no recoverable original placement;
-- those rows retain the previous strict comparison against their stored pins.
alter table public.qorpera_session_turn_requests
 add column initial_execution_selection jsonb
 check (initial_execution_selection is null or (
  jsonb_typeof(initial_execution_selection) = 'object' and octet_length(initial_execution_selection::text) <= 4096
 ));
update public.qorpera_session_turn_requests
set initial_execution_selection = jsonb_build_object(
 'sponsor_binding_id',sponsor_binding_id,'sponsor_version',sponsor_version,
 'compute_identity_id',compute_identity_id,'logical_computer_id',logical_computer_id,'worker_class',worker_class)
where status = 'pending_sponsorship' or sponsor_mode <> 'sponsorship_request';

CREATE OR REPLACE FUNCTION public.qorpera_materialize_session_execution_runs(p_limit integer DEFAULT 32)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_binding public.qorpera_session_execution_bindings%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run_id uuid;
	v_input_ids uuid[];
	v_requester uuid;
	v_payload jsonb;
	v_payload_sha256 text;
	v_transcript_start_sequence bigint;
	v_claimed integer;
	v_compute uuid; v_mode text; v_worker_class text;
	v_runs jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'session run materialization requires control-plane authority' using errcode = '42501';
	end if;
	for v_binding in
		select binding.*
		from public.qorpera_session_execution_bindings as binding
		join public.qorpera_shared_sessions as session on session.id = binding.session_id
		where session.status = 'open'
			and not public.qorpera_company_execution_paused(session.profile_id)
			and exists (
				select 1 from public.qorpera_session_inputs as input
				where input.session_id = binding.session_id
					and input.completed_at is null and input.failed_at is null
					and input.execution_run_id is null and input.turn_id is null
					and not exists (select 1 from public.qorpera_session_turn_requests request
						where request.input_id = input.id)
			)
			and not exists (
				select 1 from public.qorpera_session_turns as legacy_turn
				where legacy_turn.session_id = binding.session_id and legacy_turn.status = 'active'
			)
		order by session.updated_at, binding.session_id
		for update of binding skip locked
		limit p_limit
	loop
		begin
			perform public.qorpera_serialize_wake_admission(v_binding.profile_id);
			select session.* into v_session
			from public.qorpera_shared_sessions as session
			where session.id = v_binding.session_id
			for update nowait;
		exception when lock_not_available then
			continue;
		end;
		if not found or v_session.status <> 'open'
			or public.qorpera_company_execution_paused(v_session.profile_id) or exists (
			select 1
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.session_id = v_session.id and run.source_kind = 'session_turn'
				and job.status in ('queued', 'leased')
		) or exists (
			select 1 from public.qorpera_session_turns as legacy_turn
			where legacy_turn.session_id = v_session.id and legacy_turn.status = 'active'
		) then
			continue;
		end if;
		select file.* into v_file
		from public.qorpera_company_files as file
		where file.profile_id = v_session.profile_id and file.environment_id = v_session.environment_id
		for share;
		select substrate.* into v_substrate
		from public.qorpera_company_substrate_versions as substrate
		where substrate.profile_id = v_session.profile_id
			and substrate.environment_id = v_session.environment_id
			and substrate.company_snapshot_id = v_file.head_snapshot_id
		order by substrate.created_at desc, substrate.id desc
		limit 1;
		select staff.* into v_staff
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_session.profile_id
			and staff.staff_agent_id = v_binding.staff_agent_id
			and staff.employment_status = 'active';
		if v_file.head_snapshot_id is null or v_substrate.id is null or v_staff.staff_agent_id is null
			or not exists (
				select 1 from public.qorpera_execution_sponsor_bindings as binding
				join public.qorpera_execution_sponsor_versions as sponsor
					on sponsor.binding_id = binding.id and sponsor.version = v_binding.sponsor_version
				join public.qorpera_provider_connections as connection
					on connection.id = sponsor.provider_connection_id
				where binding.id = v_binding.sponsor_binding_id
					and binding.profile_id = v_session.profile_id and binding.status = 'active'
					and connection.profile_id = v_session.profile_id and connection.status = 'active'
			) then
			continue;
		end if;
		with pending as (
			select input.id, input.position, input.body, input.author_user_id,
				case when jsonb_typeof(input.body -> 'images') = 'array'
					then jsonb_array_length(input.body -> 'images') else 0 end as image_count,
				input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1' as intro_retry
			from public.qorpera_session_inputs as input
			where input.session_id = v_session.id
				and input.completed_at is null and input.failed_at is null
				and input.execution_run_id is null and input.turn_id is null
				and not exists (select 1 from public.qorpera_session_turn_requests request
					where request.input_id = input.id)
			order by input.position
			limit 33
		), marked as (
			select pending.*,
				min(pending.position) over () as first_position,
				first_value(pending.author_user_id) over (order by pending.position) as first_author,
				min(pending.position) filter (where pending.intro_retry) over () as first_intro_retry_position
			from pending
		), author_segment as (
			select marked.*, min(marked.position) filter (
				where marked.author_user_id is distinct from marked.first_author
			) over () as next_author_position
			from marked
		), turn_segment as (
			select marked.* from author_segment as marked
			where (marked.next_author_position is null or marked.position < marked.next_author_position)
				and (marked.first_intro_retry_position is null
				or (marked.first_position = marked.first_intro_retry_position
					and marked.position = marked.first_intro_retry_position)
				or (marked.first_position < marked.first_intro_retry_position
					and marked.position < marked.first_intro_retry_position))
		), bounded as (
			select turn_segment.*,
				row_number() over (order by turn_segment.position) as cumulative_inputs,
				sum(octet_length(turn_segment.body::text)) over (order by turn_segment.position) as cumulative_body_bytes,
				sum(turn_segment.image_count) over (order by turn_segment.position) as cumulative_images,
				sum(coalesce((
					select sum((image ->> 'bytes')::bigint)
					from jsonb_array_elements(coalesce(turn_segment.body -> 'images', '[]'::jsonb)) as image
				), 0)) over (order by turn_segment.position) as cumulative_image_bytes
			from turn_segment
		)
		select array_agg(bounded.id order by bounded.position), min(bounded.author_user_id::text)::uuid
		into v_input_ids, v_requester
		from bounded
		where bounded.cumulative_inputs <= 32
			and bounded.cumulative_body_bytes <= 524288
			and bounded.cumulative_images <= 5
			and bounded.cumulative_image_bytes <= 8388608;
		if v_input_ids is null then continue; end if;
		-- Hold current author access through wake admission. NOWAIT avoids a
		-- lock inversion with membership removal closing private sessions.
		begin
			perform 1 from public.qorpera_profile_members member
			where member.profile_id = v_session.profile_id and member.user_id = v_requester
				and member.role in ('owner', 'admin', 'contributor')
				and (v_session.audience_kind = 'company'
					or (v_session.audience_kind = 'member_private' and v_session.audience_user_id = v_requester))
			for share nowait;
		exception when lock_not_available then
			continue;
		end;
		if not found then
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(), failure_reason = 'The input author no longer has session write access'
			where id = any(v_input_ids);
			continue;
		end if;
		-- Resolve native compute from the exact configured sponsor version and
		-- active capsule, as the wake materializer does. The existing provenance
		-- and recovery-epoch triggers still validate ownership and execution.
		select c.compute_identity_id,v.authentication_mode into v_compute,v_mode
		from public.qorpera_execution_sponsor_versions s
		join public.qorpera_provider_connection_versions v
			on v.connection_id=s.provider_connection_id and v.version=s.provider_connection_version
		left join public.qorpera_native_credential_capsules c on c.id=v.credential_capsule_id and c.status='active'
		where s.binding_id=v_binding.sponsor_binding_id and s.version=v_binding.sponsor_version;
		v_worker_class:='managed_sandbox';
		if v_binding.logical_computer_id is not null then
			select computer_class,coalesce(v_compute,compute_identity_id) into v_worker_class,v_compute
			from public.qorpera_logical_computers where id=v_binding.logical_computer_id
				and profile_id=v_session.profile_id and status='active' and capabilities ? v_binding.required_capability
				and (v_compute is null or compute_identity_id=v_compute);
		end if;
		if (v_mode='native_subscription' and v_compute is null) or v_worker_class is null then
			continue;
		end if;
		v_run_id := extensions.gen_random_uuid();
		v_payload := jsonb_build_object(
			'schema', 'qorpera.session-turn-run/v1',
			'session_id', v_session.id,
			'input_ids', to_jsonb(v_input_ids)
		);
		v_payload_sha256 := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
		select coalesce(max(event.sequence), 0) into v_transcript_start_sequence
		from public.qorpera_session_events as event where event.session_id = v_session.id;
		insert into public.qorpera_runner_jobs (
			profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id
		) values (
			v_session.profile_id, v_session.environment_id, v_session.id, v_substrate.id, v_run_id,
			v_binding.required_capability, v_binding.job_type, v_payload, v_requester
		) returning * into v_job;
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
			substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
			sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
			publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
			compute_identity_id, worker_class, transcript_start_sequence, created_by_user_id, requested_by_user_id
		) values (
			v_run_id, v_session.profile_id, v_session.environment_id, 'session_turn', v_run_id,
			v_session.id, v_job.id, v_substrate.id, v_file.head_snapshot_id,
			v_staff.staff_agent_id, v_staff.version, v_input_ids,
			v_binding.sponsor_binding_id, v_binding.sponsor_version,
			v_binding.required_capability, v_binding.job_type, v_payload_sha256,
			v_binding.publication_mode, v_binding.review_policy_key, v_binding.reviewer_staff_ids,
			v_binding.logical_computer_id, v_compute, v_worker_class, v_transcript_start_sequence, v_requester, v_requester
		) returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			continue;
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = v_run.id
		where id = any(v_input_ids) and execution_run_id is null and turn_id is null
			and completed_at is null and failed_at is null;
		get diagnostics v_claimed = row_count;
		if v_claimed <> cardinality(v_input_ids) then
			raise exception 'session inputs changed during run materialization' using errcode = '40001';
		end if;
		v_transcript_start_sequence := public.qorpera_append_execution_input_events(v_session.id, v_input_ids);
		update public.qorpera_execution_runs
		set transcript_start_sequence = v_transcript_start_sequence
		where id = v_run.id
		returning * into v_run;
		update public.qorpera_shared_sessions
		set company_snapshot_id = v_file.head_snapshot_id,
			staff_version = v_staff.version,
			updated_at = statement_timestamp()
		where id = v_session.id;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'queued', jsonb_build_object('input_count', cardinality(v_input_ids)));
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$function$;

CREATE OR REPLACE FUNCTION public.qorpera_materialize_session_turn_requests(p_limit integer DEFAULT 32)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_request public.qorpera_session_turn_requests%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_payload jsonb;
	v_payload_sha256 text;
	v_transcript_start_sequence bigint;
	v_claimed integer;
	v_runs jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'session turn materialization requires control-plane authority' using errcode = '42501';
	end if;
	for v_request in
		select request.*
		from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session
			on session.id = request.session_id and session.status = 'open'
		join public.qorpera_session_inputs as input
			on input.id = request.input_id and input.session_id = request.session_id
		join public.qorpera_company_files as file
			on file.profile_id = request.profile_id and file.environment_id = session.environment_id
		where request.status = 'queued'
			and not public.qorpera_company_execution_paused(request.profile_id)
			and input.completed_at is null and input.failed_at is null
			and input.execution_run_id is null and input.turn_id is null
			and file.head_snapshot_id is not null
			and exists (
				select 1 from public.qorpera_company_substrate_versions as substrate
				where substrate.profile_id = request.profile_id
					and substrate.environment_id = session.environment_id
					and substrate.company_snapshot_id = file.head_snapshot_id
			)
		order by request.created_at, request.id
		for update of request skip locked
		limit p_limit
	loop
		begin
			perform public.qorpera_serialize_wake_admission(v_request.profile_id);
			select session.* into v_session
			from public.qorpera_shared_sessions as session
			where session.id = v_request.session_id
			for update nowait;
		exception when lock_not_available then
			continue;
		end;
		if not found or v_session.status <> 'open'
			or public.qorpera_company_execution_paused(v_session.profile_id) or exists (
			select 1
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.session_id = v_session.id and run.source_kind = 'session_turn'
				and job.status in ('queued', 'leased')
		) or exists (
			select 1 from public.qorpera_session_turns as legacy_turn
			where legacy_turn.session_id = v_session.id and legacy_turn.status = 'active'
		) then
			continue;
		end if;
		select input.* into v_input
		from public.qorpera_session_inputs as input
		where input.id = v_request.input_id and input.session_id = v_session.id
		for update;
		if not found or v_input.completed_at is not null or v_input.failed_at is not null
			or v_input.execution_run_id is not null or v_input.turn_id is not null then
			continue;
		end if;
		-- Hold current author access through wake admission. NOWAIT avoids a
		-- lock inversion with membership removal closing private sessions.
		begin
			perform 1 from public.qorpera_profile_members member
			where member.profile_id = v_session.profile_id and member.user_id = v_request.requested_by_user_id
				and member.role in ('owner', 'admin', 'contributor')
				and (v_session.audience_kind = 'company'
					or (v_session.audience_kind = 'member_private' and v_session.audience_user_id = v_request.requested_by_user_id))
			for share nowait;
		exception when lock_not_available then
			continue;
		end;
		if not found or v_input.author_user_id is distinct from v_request.requested_by_user_id then
			update public.qorpera_session_turn_requests
			set status = 'failed', failure_reason = 'The input author no longer has session write access'
			where id = v_request.id;
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(), failure_reason = 'The input author no longer has session write access'
			where id = v_input.id;
			continue;
		end if;
		select file.* into v_file
		from public.qorpera_company_files as file
		where file.profile_id = v_request.profile_id and file.environment_id = v_session.environment_id
		for share;
		select substrate.* into v_substrate
		from public.qorpera_company_substrate_versions as substrate
		where substrate.profile_id = v_request.profile_id
			and substrate.environment_id = v_session.environment_id
			and substrate.company_snapshot_id = v_file.head_snapshot_id
		order by substrate.created_at desc, substrate.id desc
		limit 1;
		select staff.* into v_staff
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_request.profile_id
			and staff.staff_agent_id = v_session.staff_agent_id::uuid
			and staff.employment_status = 'active';
		if v_file.head_snapshot_id is null or v_substrate.id is null or v_staff.staff_agent_id is null then
			continue;
		end if;
		select binding.* into v_binding
		from public.qorpera_execution_sponsor_bindings as binding
		where binding.id = v_request.sponsor_binding_id
			and binding.profile_id = v_request.profile_id and binding.status = 'active';
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = v_request.sponsor_binding_id
			and sponsor.version = v_request.sponsor_version;
		select connection.* into v_connection
		from public.qorpera_provider_connections as connection
		where connection.id = v_sponsor.provider_connection_id
			and connection.profile_id = v_request.profile_id and connection.status = 'active';
		select version.* into v_connection_version
		from public.qorpera_provider_connection_versions as version
		where version.connection_id = v_sponsor.provider_connection_id
			and version.version = v_sponsor.provider_connection_version
			and version.authorization_state = 'active';
		if v_request.compute_identity_id is not null then
			select identity.* into v_identity
			from public.qorpera_member_compute_identities as identity
			where identity.id = v_request.compute_identity_id
				and identity.profile_id = v_request.profile_id and identity.status = 'active';
		else
			v_identity := null;
		end if;
		if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
			or v_connection_version.connection_id is null
			or (v_request.sponsor_mode in ('member_connection', 'sponsorship_request') and (
				v_sponsor.sponsor_kind <> 'member_connection'
				or v_connection.owner_user_id is distinct from v_request.sponsored_by_user_id
				or v_identity.ownership_kind <> 'member'
				or v_identity.owner_user_id is distinct from v_request.sponsored_by_user_id
				or not exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = v_request.profile_id
						and member.user_id = v_request.sponsored_by_user_id
				)
			))
			or (v_request.sponsor_mode = 'company_connection' and (
				v_sponsor.sponsor_kind = 'member_connection'
				or v_identity.id is null or v_identity.ownership_kind = 'member'
			))
			or (v_request.logical_computer_id is not null and not exists (
				select 1 from public.qorpera_logical_computers as computer
				where computer.id = v_request.logical_computer_id
					and computer.profile_id = v_request.profile_id and computer.status = 'active'
					and computer.computer_class = v_request.worker_class
					and computer.compute_identity_id is not distinct from v_request.compute_identity_id
					and computer.capabilities ? v_request.required_capability
			)) then
			update public.qorpera_session_turn_requests
			set status = 'failed', failure_reason = 'The selected execution sponsor or computer is no longer available'
			where id = v_request.id;
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(),
				failure_reason = 'The selected execution sponsor or computer is no longer available'
			where id = v_input.id;
			continue;
		end if;
		if v_connection_version.authentication_mode = 'native_subscription' then
			select capsule.* into v_capsule
			from public.qorpera_native_credential_capsules as capsule
			where capsule.id = v_connection_version.credential_capsule_id
				and capsule.compute_identity_id = v_request.compute_identity_id
				and capsule.ownership_kind = v_identity.ownership_kind
				and capsule.owner_user_id is not distinct from v_identity.owner_user_id
				and capsule.owner_scope_key is not distinct from v_identity.owner_scope_key
				and capsule.status = 'active';
			if v_capsule.id is null or not public.qorpera_provider_execution_enabled(
				v_connection.provider, 'native_subscription', v_connection_version.native_harness
			) then
				update public.qorpera_session_turn_requests
				set status = 'failed', failure_reason = 'The selected native provider connection is not enabled'
				where id = v_request.id;
				update public.qorpera_session_inputs
				set failed_at = statement_timestamp(),
					failure_reason = 'The selected native provider connection is not enabled'
				where id = v_input.id;
				continue;
			end if;
		end if;
		v_payload := jsonb_build_object(
			'schema', 'qorpera.sponsored-session-turn/v1',
			'turn_request_id', v_request.id,
			'session_id', v_session.id,
			'input_ids', jsonb_build_array(v_input.id),
			'requested_by_user_id', v_request.requested_by_user_id,
			'sponsored_by_user_id', v_request.sponsored_by_user_id,
			'sponsor_mode', v_request.sponsor_mode,
			'compute_identity_id', v_request.compute_identity_id,
			'worker_class', v_request.worker_class
		);
		v_payload_sha256 := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
		select coalesce(max(event.sequence), 0) into v_transcript_start_sequence
		from public.qorpera_session_events as event where event.session_id = v_session.id;
		insert into public.qorpera_runner_jobs (
			profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id
		) values (
			v_request.profile_id, v_session.environment_id, v_session.id, v_substrate.id, v_request.id,
			v_request.required_capability, v_request.job_type, v_payload, v_request.requested_by_user_id
		) returning * into v_job;
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
			substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
			sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
			publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
			compute_identity_id, worker_class, requested_by_user_id, sponsored_by_user_id,
			transcript_start_sequence, created_by_user_id
		) values (
			v_request.id, v_request.profile_id, v_session.environment_id, 'session_turn', v_request.id,
			v_session.id, v_job.id, v_substrate.id, v_file.head_snapshot_id,
			v_staff.staff_agent_id, v_staff.version, array[v_input.id],
			v_request.sponsor_binding_id, v_request.sponsor_version,
			v_request.required_capability, v_request.job_type, v_payload_sha256,
			v_request.publication_mode, v_request.review_policy_key, v_request.reviewer_staff_ids,
			v_request.logical_computer_id, v_request.compute_identity_id, v_request.worker_class,
			v_request.requested_by_user_id, v_request.sponsored_by_user_id,
			v_transcript_start_sequence, v_request.requested_by_user_id
		) returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_session_turn_requests
			set status = 'failed', failure_reason = 'The selected sponsor quota or model authority is unavailable'
			where id = v_request.id;
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(),
				failure_reason = 'The selected sponsor quota or model authority is unavailable'
			where id = v_input.id;
			continue;
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = v_run.id
		where id = v_input.id and execution_run_id is null and turn_id is null
			and completed_at is null and failed_at is null;
		get diagnostics v_claimed = row_count;
		if v_claimed <> 1 then
			raise exception 'session input changed during sponsored turn materialization' using errcode = '40001';
		end if;
		v_transcript_start_sequence := public.qorpera_append_execution_input_events(
			v_session.id, array[v_input.id]
		);
		update public.qorpera_execution_runs
		set transcript_start_sequence = v_transcript_start_sequence
		where id = v_run.id
		returning * into v_run;
		update public.qorpera_session_turn_requests
		set status = 'materialized', run_id = v_run.id, materialized_at = statement_timestamp()
		where id = v_request.id;
		update public.qorpera_shared_sessions
		set company_snapshot_id = v_file.head_snapshot_id,
			staff_version = v_staff.version,
			updated_at = statement_timestamp()
		where id = v_session.id;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'queued', jsonb_build_object(
			'input_count', 1,
			'turn_request_id', v_request.id,
			'requested_by_user_id', v_request.requested_by_user_id,
			'sponsored_by_user_id', v_request.sponsored_by_user_id,
			'sponsor_binding_id', v_request.sponsor_binding_id,
			'sponsor_version', v_request.sponsor_version
		));
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$function$;

CREATE OR REPLACE FUNCTION public.qorpera_request_session_turn(p_session_id uuid, p_client_input_id uuid, p_client_request_id uuid, p_body jsonb, p_sponsor_mode text, p_sponsor_binding_id uuid, p_sponsor_version bigint, p_requested_sponsor_user_id uuid, p_compute_identity_id uuid, p_logical_computer_id uuid, p_worker_class text DEFAULT 'managed_sandbox'::text, p_required_capability text DEFAULT 'agent_turn'::text, p_job_type text DEFAULT 'agent_turn'::text, p_publication_mode text DEFAULT 'automatic'::text, p_review_policy_key text DEFAULT NULL::text, p_reviewer_staff_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_input jsonb;
	v_request public.qorpera_session_turn_requests%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_initial_status text;
	v_sponsored_by uuid;
	v_sponsored_at timestamptz;
begin
	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = p_session_id for update;
	if v_user_id is null or not found or v_session.status <> 'open'
		or not public.qorpera_can_write_profile(v_session.profile_id)
		or p_client_request_id is null
		or p_sponsor_mode not in ('member_connection', 'company_connection', 'sponsorship_request')
		or p_worker_class not in ('managed_sandbox', 'company_computer')
		or p_required_capability not in ('agent_turn', 'git_worktree', 'company_substrate')
		or coalesce(p_job_type, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_publication_mode not in ('automatic', 'review')
		or not public.qorpera_uuid_array_is_unique(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) then
		raise exception 'session turn request is invalid' using errcode = '22023';
	end if;
	if p_sponsor_mode = 'sponsorship_request' then
		if p_sponsor_binding_id is not null or p_sponsor_version is not null
			or p_compute_identity_id is not null or p_requested_sponsor_user_id is null
			or not exists (
				select 1 from public.qorpera_profile_members as member
				where member.profile_id = v_session.profile_id
					and member.user_id = p_requested_sponsor_user_id
			) then
			raise exception 'sponsorship request is invalid' using errcode = '22023';
		end if;
		v_initial_status := 'pending_sponsorship';
		v_sponsored_by := null;
		v_sponsored_at := null;
	else
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version;
		select connection.* into v_connection
		from public.qorpera_provider_connections as connection
		where connection.id = v_sponsor.provider_connection_id
			and connection.profile_id = v_session.profile_id and connection.status = 'active';
		select version.* into v_connection_version
		from public.qorpera_provider_connection_versions as version
		where version.connection_id = v_sponsor.provider_connection_id
			and version.version = v_sponsor.provider_connection_version
			and version.authorization_state = 'active';
		if p_compute_identity_id is not null then
			select identity.* into v_identity
			from public.qorpera_member_compute_identities as identity
			where identity.id = p_compute_identity_id and identity.profile_id = v_session.profile_id
				and identity.status = 'active';
		end if;
		if v_sponsor.binding_id is null or v_connection.id is null or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings as binding
			where binding.id = p_sponsor_binding_id and binding.profile_id = v_session.profile_id
				and binding.status = 'active'
		) or v_connection_version.connection_id is null
			or (p_sponsor_mode = 'member_connection' and (
				v_identity.ownership_kind is distinct from 'member'
				or v_identity.owner_user_id is distinct from v_user_id
			)) then
			raise exception 'session turn sponsor is unavailable' using errcode = '42501';
		end if;
		if p_sponsor_mode = 'member_connection' and (
			v_sponsor.sponsor_kind <> 'member_connection' or v_connection.owner_user_id <> v_user_id
		) then
			raise exception 'personal session turn requires the requester connection' using errcode = '42501';
		end if;
		if p_sponsor_mode = 'company_connection' and v_sponsor.sponsor_kind = 'member_connection' then
			raise exception 'company session turn requires a company connection' using errcode = '42501';
		end if;
		if p_sponsor_mode = 'company_connection' and (
			v_identity.id is null or v_identity.ownership_kind = 'member'
			or not public.qorpera_can_authorize_profile(v_session.profile_id)
		) then
			raise exception 'company session turn compute identity is unavailable' using errcode = '42501';
		end if;
		if v_connection_version.authentication_mode = 'native_subscription' then
			select capsule.* into v_capsule
			from public.qorpera_native_credential_capsules as capsule
			where capsule.id = v_connection_version.credential_capsule_id and capsule.status = 'active';
			if v_identity.id is null or v_capsule.compute_identity_id is distinct from v_identity.id
				or v_capsule.ownership_kind <> v_identity.ownership_kind
				or v_capsule.owner_user_id is distinct from v_identity.owner_user_id
				or v_capsule.owner_scope_key is distinct from v_identity.owner_scope_key then
				raise exception 'native session turn credential ownership is unavailable' using errcode = '42501';
			end if;
		end if;
		v_initial_status := 'queued';
		v_sponsored_by := case when p_sponsor_mode = 'member_connection' then v_user_id else null end;
		v_sponsored_at := statement_timestamp();
	end if;
	if p_logical_computer_id is not null and not exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.id = p_logical_computer_id and computer.profile_id = v_session.profile_id
			and computer.status = 'active' and computer.computer_class = p_worker_class
			and computer.compute_identity_id is not distinct from p_compute_identity_id
			and computer.capabilities ? p_required_capability
	) then
		raise exception 'session turn logical computer is unavailable' using errcode = '42501';
	end if;
	select request.* into v_request
	from public.qorpera_session_turn_requests as request
	where request.session_id = p_session_id and request.client_request_id = p_client_request_id;
	if found then
		return jsonb_build_object(
			'turn_request_id', v_request.id,
			'input_id', v_request.input_id,
			'status', v_request.status,
			'sponsor_mode', v_request.sponsor_mode
		);
	end if;
	v_input := public.qorpera_append_session_input(p_session_id, p_client_input_id, 'user_message', p_body);
	-- A new request cannot adopt an input already consumed by the ordinary
	-- queue. Existing request retries return above without changing ownership.
	if not exists (
		select 1 from public.qorpera_session_inputs input
		where input.id = (v_input ->> 'input_id')::uuid
			and input.execution_run_id is null and input.turn_id is null
			and input.completed_at is null and input.failed_at is null
	) then
		raise exception 'session input has already been consumed' using errcode = '23505';
	end if;
	insert into public.qorpera_session_turn_requests (
		profile_id, session_id, client_request_id, input_id, requested_by_user_id,
		sponsor_mode, sponsor_binding_id, sponsor_version, sponsored_by_user_id,
		requested_sponsor_user_id, compute_identity_id, logical_computer_id, worker_class,
		required_capability, job_type, publication_mode, review_policy_key,
		reviewer_staff_ids, status, sponsored_at, initial_execution_selection
	) values (
		v_session.profile_id, v_session.id, p_client_request_id, (v_input ->> 'input_id')::uuid,
		v_user_id, p_sponsor_mode, p_sponsor_binding_id, p_sponsor_version, v_sponsored_by,
		p_requested_sponsor_user_id, p_compute_identity_id, p_logical_computer_id, p_worker_class,
		p_required_capability, p_job_type, p_publication_mode, nullif(btrim(p_review_policy_key), ''),
		coalesce(p_reviewer_staff_ids, '{}'::uuid[]), v_initial_status, v_sponsored_at,
		jsonb_build_object('sponsor_binding_id',p_sponsor_binding_id,'sponsor_version',p_sponsor_version,
			'compute_identity_id',p_compute_identity_id,'logical_computer_id',p_logical_computer_id,'worker_class',p_worker_class)
	) returning * into v_request;
	return jsonb_build_object(
		'turn_request_id', v_request.id,
		'input_id', v_request.input_id,
		'status', v_request.status,
		'sponsor_mode', v_request.sponsor_mode
	);
end
$function$;

CREATE OR REPLACE FUNCTION public.qorpera_request_session_turn_v2(p_session_id uuid, p_client_input_id uuid, p_client_request_id uuid, p_body jsonb, p_sponsor_mode text, p_sponsor_binding_id uuid, p_sponsor_version bigint, p_requested_sponsor_user_id uuid, p_compute_identity_id uuid, p_logical_computer_id uuid, p_worker_class text DEFAULT 'managed_sandbox'::text, p_required_capability text DEFAULT 'agent_turn'::text, p_job_type text DEFAULT 'agent_turn'::text, p_publication_mode text DEFAULT 'automatic'::text, p_review_policy_key text DEFAULT NULL::text, p_reviewer_staff_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_request public.qorpera_session_turn_requests%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
begin
	if exists (select 1 from public.qorpera_shared_sessions session join public.qorpera_company_execution_pauses pause
			on pause.profile_id = session.profile_id where session.id = p_session_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if v_user_id is null or not found or not public.qorpera_can_write_profile(v_session.profile_id) then
		raise exception 'session turn request is unavailable' using errcode = '42501';
	end if;
	select request.* into v_request
	from public.qorpera_session_turn_requests as request
	where request.session_id = p_session_id and request.client_request_id = p_client_request_id;
	if found then
		select input.* into v_input
		from public.qorpera_session_inputs as input
		where input.id = v_request.input_id;
		if v_request.requested_by_user_id is distinct from v_user_id
			or v_input.client_input_id is distinct from p_client_input_id
			or v_input.author_user_id is distinct from v_user_id
			or v_input.kind is distinct from 'user_message'
			or v_input.body is distinct from p_body
			or v_request.sponsor_mode is distinct from p_sponsor_mode
			or v_request.requested_sponsor_user_id is distinct from p_requested_sponsor_user_id
			or coalesce(v_request.initial_execution_selection, jsonb_build_object(
				'sponsor_binding_id',v_request.sponsor_binding_id,'sponsor_version',v_request.sponsor_version,
				'compute_identity_id',v_request.compute_identity_id,'logical_computer_id',v_request.logical_computer_id,
				'worker_class',v_request.worker_class)) is distinct from jsonb_build_object(
				'sponsor_binding_id',p_sponsor_binding_id,'sponsor_version',p_sponsor_version,
				'compute_identity_id',p_compute_identity_id,'logical_computer_id',p_logical_computer_id,'worker_class',p_worker_class)
			or v_request.required_capability is distinct from p_required_capability
			or v_request.job_type is distinct from p_job_type
			or v_request.publication_mode is distinct from p_publication_mode
			or v_request.review_policy_key is distinct from nullif(btrim(p_review_policy_key), '')
			or v_request.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[]) then
			raise exception 'session turn client request id is bound to another request' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'turn_request_id', v_request.id,
			'input_id', v_request.input_id,
			'status', v_request.status,
			'sponsor_mode', v_request.sponsor_mode
		);
	end if;
	return public.qorpera_request_session_turn(
		p_session_id, p_client_input_id, p_client_request_id, p_body, p_sponsor_mode,
		p_sponsor_binding_id, p_sponsor_version, p_requested_sponsor_user_id,
		p_compute_identity_id, p_logical_computer_id, p_worker_class, p_required_capability,
		p_job_type, p_publication_mode, p_review_policy_key, p_reviewer_staff_ids
	);
end
$function$;
