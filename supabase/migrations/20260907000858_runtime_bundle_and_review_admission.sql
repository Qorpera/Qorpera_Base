-- Split queued inputs at immutable executable provenance boundaries.
-- Validate review runtime support before creating a job, and isolate stale or
-- contended review authority from the global orchestrator claim transaction.

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
		order by review.created_at, review.id
		for update of review skip locked
		limit p_limit
	loop
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
