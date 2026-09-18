-- Rotate a bounded admission scan without rewriting input or wake identity.
-- Initial positions use insertion time; historical rows share migration time
-- and retain their original tie-breaking order. Every visited entry moves
-- behind existing waiting work, including on a caught lock conflict.
alter table public.qorpera_session_execution_bindings
 add column admission_scan_at timestamptz not null default statement_timestamp();
alter table public.qorpera_session_turn_requests
 add column admission_scan_at timestamptz not null default statement_timestamp();
alter table public.qorpera_wake_occurrences
 add column admission_scan_at timestamptz not null default statement_timestamp();
alter table public.qorpera_company_proposal_review_assignments
 add column admission_scan_at timestamptz not null default statement_timestamp();

create index qorpera_session_binding_admission_scan
 on public.qorpera_session_execution_bindings(admission_scan_at,session_id);
create index qorpera_turn_request_admission_scan
 on public.qorpera_session_turn_requests(admission_scan_at,created_at,id) where status='queued';
create index qorpera_turn_request_session_order
 on public.qorpera_session_turn_requests(session_id,created_at,id) include(input_id) where status='queued';
create index qorpera_wake_admission_scan
 on public.qorpera_wake_occurrences(admission_scan_at,not_before,created_at,id) where status='queued';
create index qorpera_review_admission_scan
 on public.qorpera_company_proposal_review_assignments(admission_scan_at,created_at,id) where status='queued';

-- Queue position is operational metadata, not admitted wake identity.
CREATE OR REPLACE FUNCTION public.qorpera_guard_wake_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
	-- A recorded sponsor handoff on the wake's run is the only admitted identity move (contract 17).
	if new.sponsor_version is distinct from old.sponsor_version and not (new.run_id is not null
		and new.run_id = old.run_id and exists (select 1 from public.qorpera_execution_sponsor_handoffs handoff
			where handoff.run_id = new.run_id and handoff.binding_id = new.sponsor_binding_id
				and handoff.from_version = old.sponsor_version and handoff.to_version = new.sponsor_version)) then
		raise exception 'Admitted wake identity is immutable' using errcode = '42501'; end if;
	if (to_jsonb(new) - array['status','blocked_reason','run_id','finished_at','sponsor_version','admission_scan_at'])
		is distinct from (to_jsonb(old) - array['status','blocked_reason','run_id','finished_at','sponsor_version','admission_scan_at'])
		or (old.run_id is not null and new.run_id is distinct from old.run_id) then
		raise exception 'Admitted wake identity is immutable' using errcode = '42501'; end if;
	return new;
end
$function$;

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
		order by binding.admission_scan_at, session.updated_at, binding.session_id
		for update of binding skip locked
		limit p_limit
	loop
		update public.qorpera_session_execution_bindings set admission_scan_at = clock_timestamp()
		where session_id = v_binding.session_id;
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
				input.runtime_bundle_id, input.runtime_bundle_sha256,
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
				first_value(pending.runtime_bundle_id) over (order by pending.position) as first_bundle_id,
				first_value(pending.runtime_bundle_sha256) over (order by pending.position) as first_bundle_sha256,
				min(pending.position) filter (where pending.intro_retry) over () as first_intro_retry_position
			from pending
		), provenance_segment as (
			select marked.*, min(marked.position) filter (
				where marked.author_user_id is distinct from marked.first_author
					or marked.runtime_bundle_id is distinct from marked.first_bundle_id
					or marked.runtime_bundle_sha256 is distinct from marked.first_bundle_sha256
			) over () as next_provenance_position
			from marked
		), turn_segment as (
			select marked.* from provenance_segment as marked
			where (marked.next_provenance_position is null or marked.position < marked.next_provenance_position)
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
		if not public.qorpera_try_lock_execution_identity(v_session.profile_id,v_compute) then
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
			-- Rotate sessions without overtaking their earlier queued sponsorship.
			and not exists (
    select 1 from public.qorpera_session_turn_requests earlier
    join public.qorpera_session_inputs earlier_input on earlier_input.id=earlier.input_id
    where earlier.session_id=request.session_id and earlier.status='queued'
     and (earlier.created_at,earlier.id)<(request.created_at,request.id)
     and earlier_input.completed_at is null and earlier_input.failed_at is null
     and earlier_input.execution_run_id is null and earlier_input.turn_id is null
   )
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
		order by request.admission_scan_at, request.created_at, request.id
		for update of request skip locked
		limit p_limit
	loop
		update public.qorpera_session_turn_requests set admission_scan_at = clock_timestamp()
		where id = v_request.id;
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
			or exists (
    select 1 from public.qorpera_session_turn_requests earlier
    join public.qorpera_session_inputs earlier_input on earlier_input.id=earlier.input_id
    where earlier.session_id=v_request.session_id and earlier.status='queued'
     and (earlier.created_at,earlier.id)<(v_request.created_at,v_request.id)
     and earlier_input.completed_at is null and earlier_input.failed_at is null
     and earlier_input.execution_run_id is null and earlier_input.turn_id is null
   )
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
		if not public.qorpera_try_lock_execution_identity(v_request.profile_id,v_request.compute_identity_id) then
			continue;
		end if;
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
				v_substrate.id,v_file.head_snapshot_id,v_wake.staff_agent_id,v_wake.staff_version,'{}',
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
$function$;

CREATE OR REPLACE FUNCTION public.qorpera_materialize_company_proposal_review_runs(p_limit integer DEFAULT 32)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_review public.qorpera_company_proposal_review_assignments%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_revision public.qorpera_company_proposal_revisions%rowtype;
	v_origin public.qorpera_execution_runs%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype;
	v_computer public.qorpera_logical_computers%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_compute uuid;
	v_worker_class text;
	v_run_id uuid;
	v_payload jsonb;
	v_payload_sha256 text;
	v_runs jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'proposal review materialization requires control-plane authority' using errcode = '42501';
	end if;
	for v_review in
		select review.*
		from public.qorpera_company_proposal_review_assignments as review
		join public.qorpera_company_proposals as proposal on proposal.id = review.proposal_id
		where review.status = 'queued' and proposal.status = 'open'
			and not public.qorpera_company_execution_paused(review.profile_id)
			and review.proposal_revision = (
				select max(revision.revision)
				from public.qorpera_company_proposal_revisions as revision
				where revision.proposal_id = review.proposal_id
			)
		order by review.admission_scan_at, review.created_at, review.id
		for update of review skip locked
		limit p_limit
	loop
		update public.qorpera_company_proposal_review_assignments set admission_scan_at = clock_timestamp()
		where id = v_review.id;
		begin
		perform public.qorpera_serialize_wake_admission(v_review.profile_id);
		if public.qorpera_company_execution_paused(v_review.profile_id) then continue; end if;
		select proposal.* into v_proposal
		from public.qorpera_company_proposals as proposal where proposal.id = v_review.proposal_id;
		select revision.* into v_revision
		from public.qorpera_company_proposal_revisions as revision
		where revision.proposal_id = v_review.proposal_id
			and revision.revision = v_review.proposal_revision;
		select run.* into v_origin
		from public.qorpera_execution_runs as run
		where v_proposal.execution_kind = 'run' and run.id = v_proposal.execution_id;
		select file.* into v_file
		from public.qorpera_company_files as file
		where file.profile_id = v_review.profile_id and file.environment_id = v_proposal.environment_id
		for share nowait;
		select substrate.* into v_substrate
		from public.qorpera_company_substrate_versions as substrate
		where substrate.profile_id = v_review.profile_id
			and substrate.environment_id = v_proposal.environment_id
			and substrate.company_snapshot_id = v_file.head_snapshot_id
		order by substrate.created_at desc, substrate.id desc
		limit 1;
		select staff.* into v_staff
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_review.profile_id
			and staff.staff_agent_id = v_review.reviewer_staff_agent_id
			and staff.employment_status = 'active';
		select snapshot.* into v_snapshot
		from public.qorpera_company_snapshots as snapshot
		where snapshot.id = v_revision.proposal_snapshot_id
			and snapshot.profile_id = v_review.profile_id
			and snapshot.environment_id = v_proposal.environment_id;
		if v_proposal.id is null or v_revision.proposal_id is null or v_origin.id is null
			or v_file.head_snapshot_id is null or v_substrate.id is null
			or v_staff.staff_agent_id is null or v_snapshot.id is null
			then
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'Reviewer configuration, sponsor, or pinned Company File is unavailable'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		-- Resolve the exact authority captured when the assignment was seeded.
		-- Native harnesses currently accept agent_turn only, and path-runtime
		-- completion has no proposal-review receipt. Do not create a run that
		-- either runtime cannot execute, or substitute another payer/runtime.
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions sponsor
		join public.qorpera_execution_sponsor_bindings binding on binding.id = sponsor.binding_id
		where sponsor.binding_id = v_review.reviewer_sponsor_binding_id
			and sponsor.version = v_review.reviewer_sponsor_version and sponsor.allow_autonomous
			and binding.profile_id = v_review.profile_id and binding.status = 'active'
		for share of binding nowait;
		select connection.* into v_connection from public.qorpera_provider_connections connection
		where connection.id = v_sponsor.provider_connection_id and connection.profile_id = v_review.profile_id
			and connection.status = 'active' and connection.provider = v_staff.model_provider
		for share nowait;
		select version.* into v_version from public.qorpera_provider_connection_versions version
		where version.connection_id = v_connection.id and version.version = v_sponsor.provider_connection_version
			and version.authorization_state = 'active'
		for share nowait;
		if v_sponsor.binding_id is null or v_connection.id is null or v_version.connection_id is null
			or not public.qorpera_provider_autonomous_authority(v_connection.id,v_version.version) then
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'Reviewer sponsor or current autonomous consent is unavailable'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		if v_version.authentication_mode = 'native_subscription' or v_file.path_gateway_version = 1 then
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'The selected reviewer runtime does not support proposal_review jobs'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		if v_sponsor.sponsor_kind = 'member_connection' then
			perform 1 from public.qorpera_profile_members member
			where member.profile_id = v_review.profile_id and member.user_id = v_connection.owner_user_id
			for share nowait;
			if not found then
				update public.qorpera_company_proposal_review_assignments
				set status = 'failed', completed_at = statement_timestamp(),
					failure_reason = 'Reviewer sponsor owner is no longer a company member'
				where id = v_review.id and status = 'queued';
				continue;
			end if;
		end if;
		v_compute := null; v_worker_class := 'managed_sandbox';
		if v_review.reviewer_logical_computer_id is not null then
			select computer.* into v_computer from public.qorpera_logical_computers computer
			where computer.id = v_review.reviewer_logical_computer_id and computer.profile_id = v_review.profile_id
				and computer.status = 'active' and computer.capabilities ? 'agent_turn'
				and computer.computer_class = 'managed_sandbox'
			for share nowait;
			select identity.* into v_identity from public.qorpera_member_compute_identities identity
			where identity.id = v_computer.compute_identity_id and identity.profile_id = v_review.profile_id
				and identity.status = 'active' and identity.recovery_pending_id is null
				and case when v_sponsor.sponsor_kind = 'member_connection' then
					identity.ownership_kind = 'member' and identity.owner_user_id = v_connection.owner_user_id
				else identity.ownership_kind <> 'member' and v_connection.owner_user_id is null end
			for share nowait;
			if v_computer.id is null or (v_computer.compute_identity_id is not null and v_identity.id is null) then
				update public.qorpera_company_proposal_review_assignments
				set status = 'failed', completed_at = statement_timestamp(),
					failure_reason = 'Reviewer logical computer or compute identity is unavailable'
				where id = v_review.id and status = 'queued';
				continue;
			end if;
			v_compute := v_computer.compute_identity_id; v_worker_class := v_computer.computer_class;
		end if;
		v_payload := jsonb_build_object(
			'schema', 'qorpera.company-proposal-review/v1',
			'proposal_id', v_proposal.id,
			'proposal_revision', v_review.proposal_revision,
			'policy_key', v_proposal.policy_key,
			'title', v_proposal.title,
			'base_snapshot_id', v_revision.base_snapshot_id,
			'proposal_snapshot', public.qorpera_company_snapshot_json(v_snapshot),
			'instruction', 'Review the proposed Company File revision. Return an approve or request_changes decision with a concise, evidence-based comment.'
		);
		if pg_column_size(v_payload) > 65536 then
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'Reviewer input exceeds the durable runner payload limit'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		v_payload_sha256 := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
		v_run_id := extensions.gen_random_uuid();
		insert into public.qorpera_runner_jobs (
			profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id
		) values (
			v_review.profile_id, v_proposal.environment_id, null, v_substrate.id, v_run_id,
			'agent_turn', 'proposal_review', v_payload, v_proposal.created_by_user_id
		) returning * into v_job;
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
			substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
			sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
			publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
			compute_identity_id, worker_class, transcript_start_sequence, created_by_user_id
		) values (
			v_run_id, v_review.profile_id, v_proposal.environment_id, 'proposal_review', v_run_id,
			null, v_job.id, v_substrate.id, v_file.head_snapshot_id,
			v_staff.staff_agent_id, v_staff.version, '{}'::uuid[],
			v_review.reviewer_sponsor_binding_id, v_review.reviewer_sponsor_version,
			'agent_turn', 'proposal_review',
			v_payload_sha256, 'automatic', null, '{}'::uuid[], v_review.reviewer_logical_computer_id,
			v_compute, v_worker_class, 0, v_proposal.created_by_user_id
		) returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'Reviewer execution sponsor, provider, or quota is unavailable'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		update public.qorpera_company_proposal_review_assignments
		set status = 'running', run_id = v_run.id, started_at = statement_timestamp()
		where id = v_review.id and status = 'queued';
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'queued', jsonb_build_object(
			'proposal_id', v_proposal.id, 'proposal_revision', v_review.proposal_revision
		));
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
		exception when lock_not_available then
			-- Leave this assignment queued; unrelated companies can progress.
			continue;
		end;
	end loop;
	return v_runs;
end
$function$;

-- Keep scan rotation after contention; processed_head and event claims
-- remain atomic inside the per-cursor subtransaction.
CREATE OR REPLACE FUNCTION public.qorpera_drain_company_file_wakes(p_limit integer DEFAULT 32)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_cursor public.qorpera_company_file_wake_cursors%rowtype; v_revision public.qorpera_company_path_revisions%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype; v_file public.qorpera_company_files%rowtype;
	v_trigger jsonb; v_path text; v_key text; v_selector text; v_ancestry jsonb; v_occurrence uuid; v_outcome text;
	v_scanned integer := 0; v_examined integer := 0; v_admitted integer := 0;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'File wake drain authority or bound is invalid' using errcode = '42501'; end if;
	-- LIMIT is on cursor selection BEFORE any revision lookup. Each selected
	-- cursor examines at most one indexed successor, including denied and
	-- unmatched candidates. There is no revision x subscription history scan.
	for v_cursor in
		select c.* from public.qorpera_company_file_wake_cursors c where c.active
		order by c.last_scanned_at,c.routine_id,c.routine_version,c.trigger_id
		for update of c skip locked limit p_limit
	loop
		v_scanned := v_scanned + 1;
		update public.qorpera_company_file_wake_cursors set last_scanned_at = clock_timestamp()
		where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id;
		begin
			if not exists(select 1 from public.qorpera_cloud_routines where id = v_cursor.routine_id
				and current_version = v_cursor.routine_version and status = 'active') then continue; end if;
			select * into strict v_version from public.qorpera_cloud_routine_versions
			where routine_id = v_cursor.routine_id and version = v_cursor.routine_version;
			select value into strict v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = v_cursor.trigger_id;
			select * into strict v_file from public.qorpera_company_files where environment_id = v_cursor.environment_id;
			perform public.qorpera_serialize_wake_admission(v_file.profile_id);
			select * into strict v_file from public.qorpera_company_files where environment_id = v_cursor.environment_id for update;
			select * into v_revision from public.qorpera_company_path_revisions
			where environment_id = v_cursor.environment_id and parent_snapshot_id = v_cursor.processed_head;
			if not found then
				if v_file.head_snapshot_id is distinct from v_cursor.processed_head then
					raise exception 'Company File listener history is unavailable' using errcode = '55000'; end if;
				continue;
			end if;
			v_examined := v_examined + 1; v_occurrence := null;
			v_path := v_revision.change #>> '{plan,path}';
			if v_revision.change #>> '{plan,schema}' is distinct from 'qorpera.company-path-mutation/v1'
				or not coalesce(public.qorpera_company_path_valid(v_path),false) then
				raise exception 'Company File listener event is invalid' using errcode = '55000'; end if;
			v_key := public.qorpera_company_path_key(v_path); v_selector := public.qorpera_company_path_key(v_trigger ->> 'path');
			if (v_key = v_selector or (v_trigger ->> 'match' = 'subtree'
				and (v_selector = '' or left(v_key,length(v_selector) + 1) = v_selector || '/')))
				and not exists(select 1 from public.qorpera_company_file_wake_claims
					where event_id = v_revision.snapshot_id and routine_id = v_cursor.routine_id
						and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id) then
				v_outcome := 'denied';
				if coalesce(public.qorpera_wake_path_authorized(v_cursor.environment_id,v_version.created_by_user_id,
					v_version.staff_agent_id,v_path),false)
					and (coalesce(v_trigger ->> 'replyPolicy','required') in ('optional','silent')
						or public.qorpera_wake_public_session(v_version.profile_id,v_cursor.environment_id,
							v_version.staff_agent_id,v_version.created_by_user_id) is not null) then
					v_ancestry := public.qorpera_wake_ancestry(v_revision.run_id,v_revision.actor_staff_id,
						v_version.staff_agent_id,v_revision.snapshot_id);
					v_outcome := 'causal-fence';
					if v_ancestry is not null then
						v_occurrence := extensions.gen_random_uuid(); v_outcome := 'admitted';
						insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,routine_id,routine_version,
							wake_kind,source_kind,file_event_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
						values(v_occurrence,v_version.profile_id,v_cursor.environment_id,v_cursor.routine_id,v_cursor.routine_version,
							'routine','company-file',v_revision.snapshot_id,v_cursor.trigger_id,
							'file:' || v_cursor.routine_version::text || ':' || v_cursor.trigger_id || ':' || v_revision.snapshot_id::text,
							v_revision.created_at,clock_timestamp(),jsonb_build_object(
								'eventId',v_revision.snapshot_id,'path',v_path,
								'previousVersion',v_revision.change #> '{plan,expectedVersion}',
								'version',v_revision.change -> 'version',
								'operation',case when v_revision.change #> '{plan,entry}' = 'null'::jsonb then 'delete' else 'upsert' end,
								'receiptId',v_revision.receipt_id,'proposalId',v_revision.proposal_id));
						v_admitted := v_admitted + 1;
					end if;
				end if;
				insert into public.qorpera_company_file_wake_claims(event_id,routine_id,routine_version,trigger_id,outcome,occurrence_id)
				values(v_revision.snapshot_id,v_cursor.routine_id,v_cursor.routine_version,v_cursor.trigger_id,v_outcome,v_occurrence);
			end if;
			-- Terminal denied/cycle claims stay private. An unmatched revision also
			-- advances the cursor in this transaction; a crash loses none of these
			-- decisions and cannot leave an orphan occurrence.
			update public.qorpera_company_file_wake_cursors set processed_head = v_revision.snapshot_id
			where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id;
		exception when lock_not_available then
			continue;
		end;
	end loop;
	return jsonb_build_object('schema','qorpera.file-wake-drain/v1','scanned',v_scanned,'examined',v_examined,'admitted',v_admitted);
end
$function$;
