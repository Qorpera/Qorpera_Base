-- Explicit authority/version fences are application conflicts, not engine serialization
-- failures. PostgREST retries SQLSTATE 40001 on affected hosted versions. PGRST
-- carries code QRC01 and HTTP 409 without invoking that retry path. PT409 remains
-- reserved for existing Company File head conflicts with bounded rebuild semantics.
-- No engine serialization_failure handler is installed: genuine 40001 propagates.
-- Each replacement is pinned to the reviewed effective definition and preserves ACL,
-- owner, search_path, volatility and per-function settings.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_accept_company_proposal(uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> '3ec624142a036c1620f53e00cb6034eab5bc765a49ed1855fd2b0338f8574c0a' then
		raise exception 'Reviewed function definition changed: qorpera_accept_company_proposal';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_accept_company_proposal(p_proposal_id uuid, p_expected_proposal_snapshot_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
	v_revision bigint;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_proposal.profile_id) then
		raise exception 'company proposal authorization is required' using errcode = '42501';
	end if;
	if v_proposal.proposal_snapshot_id is distinct from p_expected_proposal_snapshot_id then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company proposal changed before acceptance', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_proposal.status = 'accepted' then
		return public.qorpera_company_proposal_json(v_proposal);
	end if;
	if v_proposal.status <> 'open' then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company proposal was resolved before acceptance', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select max(revision.revision) into v_revision
	from public.qorpera_company_proposal_revisions as revision
	where revision.proposal_id = v_proposal.id;
	if v_proposal.execution_kind = 'run' and cardinality(v_proposal.reviewer_staff_ids) > 0 and (
		(select count(*)
		 from public.qorpera_company_proposal_review_assignments as review
		 where review.proposal_id = v_proposal.id and review.proposal_revision = v_revision)
			<> cardinality(v_proposal.reviewer_staff_ids)
		or exists (
			select 1
			from public.qorpera_company_proposal_review_assignments as review
			where review.proposal_id = v_proposal.id and review.proposal_revision = v_revision
				and review.status <> 'approved'
		)
	) then
		raise exception 'company proposal still requires its configured reviews' using errcode = '55000';
	end if;
	update public.qorpera_company_proposals
	set status = 'accepted', resolved_by_user_id = v_user_id, resolved_at = statement_timestamp()
	where id = v_proposal.id
	returning * into v_proposal;
	perform public.qorpera_publish_company_file_revision(
		v_proposal.environment_id, v_proposal.proposal_snapshot_id, v_proposal.base_snapshot_id
	);
	return public.qorpera_company_proposal_json(v_proposal);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_accept_runner_assignment(uuid,text,uuid,uuid,text)'::regprocedure), 'sha256'), 'hex') <> 'e28c46bc6b848069070d9c4eff0c4a221af1b4f5572e233d75db642f46e21087' then
		raise exception 'Reviewed function definition changed: qorpera_accept_runner_assignment';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_accept_runner_assignment(p_runner_id uuid, p_session_token_sha256 text, p_assignment_id uuid, p_job_id uuid, p_assignment_capability_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_runner public.qorpera_runners%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role'
		or p_assignment_capability_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner assignment acceptance is invalid' using errcode = '42501';
	end if;
	-- Read only to authenticate the immutable assignment identity before locks.
	select assignment.* into v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = p_assignment_id and assignment.job_id = p_job_id
		and assignment.runner_id = p_runner_id;
	if not found or v_assignment.capability_sha256 is distinct from p_assignment_capability_sha256 then
		raise exception 'runner assignment capability is unavailable' using errcode = '42501';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id for update;
	select claim.* into strict v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = v_assignment.claim_id for update;
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.status = 'active' for update;
	if not found or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner session is unavailable' using errcode = '42501';
	end if;
	select assignment.* into strict v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = p_assignment_id and assignment.job_id = p_job_id
		and assignment.runner_id = p_runner_id and assignment.claim_id = v_claim.id for update;
	if v_assignment.capability_sha256 is distinct from p_assignment_capability_sha256 then
		raise exception 'runner assignment capability is unavailable' using errcode = '42501';
	end if;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.deadline_at <= statement_timestamp()
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'execution sponsor is unavailable' using errcode = '42501';
	end if;
	if v_assignment.status = 'accepted' and v_job.status = 'leased'
		and v_job.runner_id = p_runner_id
		and v_job.client_lease_id = p_assignment_id
		and v_job.lease_token_sha256 = p_assignment_capability_sha256
		and v_job.lease_expires_at > statement_timestamp() then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if v_assignment.status <> 'offered' or v_assignment.expires_at <= statement_timestamp()
		or v_job.status <> 'queued' then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner assignment is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if (
		select count(*) from public.qorpera_runner_jobs as active_job
		where active_job.runner_id = p_runner_id and active_job.status = 'leased'
			and active_job.lease_expires_at > statement_timestamp()
	) >= v_runner.max_concurrency then
		raise exception 'runner is at capacity' using errcode = '55000';
	end if;
	if v_claim.status <> 'assigned' or v_claim.lease_expires_at <= statement_timestamp() then
		raise exception 'runner claim is unavailable' using errcode = '55000';
	end if;
	update public.qorpera_runner_jobs
	set status = 'leased', runner_id = p_runner_id, client_lease_id = p_assignment_id,
		lease_token_sha256 = p_assignment_capability_sha256,
		lease_expires_at = least(v_run.deadline_at, statement_timestamp() + interval '2 minutes'),
		attempt_count = attempt_count + 1,
		started_at = coalesce(started_at, statement_timestamp()), last_error = null
	where id = p_job_id returning * into v_job;
	update public.qorpera_runner_assignments
	set status = 'accepted', accepted_at = statement_timestamp() where id = p_assignment_id;
	update public.qorpera_runner_job_claims set status = 'accepted' where id = v_claim.id;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, 'runner_started', jsonb_build_object(
		'assignment_id', p_assignment_id, 'runner_id', p_runner_id,
		'lease_expires_at', v_job.lease_expires_at
	));
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_ack_office_software_install(uuid,uuid,text,jsonb,text,text)'::regprocedure), 'sha256'), 'hex') <> '3e96c9a305e225a04d6e3db606cb3662873eb94005d31af82717a8df8789dd06' then
		raise exception 'Reviewed function definition changed: qorpera_ack_office_software_install';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_ack_office_software_install(p_update_id uuid, p_challenge_id uuid, p_receipt_text text, p_measured_service jsonb, p_evidence_sha256 text, p_provider_capability text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u public.qorpera_office_software_updates%rowtype; c public.qorpera_office_software_challenges%rowtype; r jsonb; v_capability bigint;
begin
 perform public.qorpera_require_office_software_capability((select allocation_id from public.qorpera_office_software_updates where id=p_update_id),p_provider_capability,false);
 u:=public.qorpera_lock_office_software_install(p_update_id);
 v_capability:=public.qorpera_require_office_software_capability(u.allocation_id,p_provider_capability,true);
 if p_receipt_text is null or octet_length(p_receipt_text)>65536 then raise exception 'Invalid office software receipt' using errcode='22023'; end if;
 r:=p_receipt_text::jsonb;
 perform public.qorpera_office_software_object(r,array['schema','plan','planSha256','state','service','installedAt']);
 perform public.qorpera_office_software_strings(r,array['schema','planSha256','state','installedAt']);
 perform public.qorpera_office_software_artifact(p_measured_service);
 perform public.qorpera_office_software_sha(p_evidence_sha256);
 if r->>'schema' is distinct from 'qorpera.office-service-software-receipt/v1' or r->>'state' is distinct from 'installed'
  or r->'plan' is distinct from u.plan or r->>'planSha256' is distinct from u.plan_sha256
  or r->'service' is distinct from u.statement#>'{next,service}' or p_measured_service is distinct from r->'service'
  or coalesce(r->>'installedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  or (r->>'installedAt')::timestamptz<(u.statement#>>'{acceptance,testedAt}')::timestamptz then
  raise exception 'Office software installation differs' using errcode='42501'; end if;
 select * into c from public.qorpera_office_software_challenges where id=p_challenge_id for update;
 if not found or c.phase<>'install' or c.update_id<>u.id or c.revision<>u.target_revision or c.capability_revision<>v_capability then
  raise exception 'Office software installation challenge differs' using errcode='42501'; end if;
 if u.state='installed' then
  if u.receipt<>r or u.installation_evidence_sha256<>p_evidence_sha256 or u.installation_challenge_id is distinct from p_challenge_id then
   raise exception 'Office software installation cannot be rebound' using errcode='42501'; end if;
 else
  if c.expires_at<=clock_timestamp() then raise exception 'Office software installation challenge expired' using errcode='42501'; end if;
  insert into public.qorpera_office_software_revisions values(u.allocation_id,u.target_revision,
   u.statement->'next'||jsonb_build_object('sourceCommit',u.statement#>'{source,commit}'));
  update public.qorpera_office_software_baselines set current_revision=u.target_revision
   where allocation_id=u.allocation_id and current_revision=u.previous_revision;
  if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Office software revision changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
  update public.qorpera_office_software_updates set state='installed',receipt=r,installation_evidence_sha256=p_evidence_sha256,installation_challenge_id=p_challenge_id where id=u.id;
  if c.expires_at<=clock_timestamp() then raise exception 'Office software installation acknowledgement expired' using errcode='42501'; end if;
 end if;
 return jsonb_build_object('schema','qorpera.office-software-installation/v1','updateId',u.id,'state','installed','targetRevision',u.target_revision);
end $function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_append_account_event_profile_scope(uuid,uuid,text,jsonb,bigint,text,uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> '78ec196cd1a61b90b9c3ed81e2f147a5134182d63db6cec7e528f06a38693643' then
		raise exception 'Reviewed function definition changed: qorpera_append_account_event_profile_scope';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_append_account_event_profile_scope(p_session_id uuid, p_event_id uuid, p_event_type text, p_body jsonb, p_expected_sequence bigint DEFAULT NULL::bigint, p_execution_kind text DEFAULT NULL::text, p_execution_id uuid DEFAULT NULL::uuid, p_execution_claimant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
	v_execution_valid boolean := false;
	v_body_schema text;
	v_entry jsonb;
	v_entry_type text;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_event_type not in (
		'message',
		'session_info',
		'run_receipt',
		'artifact_receipt',
		'authorization_request',
		'authorization_decision'
	) then
		raise exception 'session event type is invalid' using errcode = '22023';
	end if;
	if p_body is null
		or jsonb_typeof(p_body) <> 'object'
		or octet_length(convert_to(p_body::text, 'utf8')) > 262144 then
		raise exception 'session event body is invalid or too large' using errcode = '22023';
	end if;
	if (p_execution_kind is null) is distinct from (p_execution_id is null)
		or (p_execution_kind is null) is distinct from (p_execution_claimant_id is null)
		or (p_execution_kind is not null and p_execution_kind not in ('turn', 'wake')) then
		raise exception 'session event execution identity is invalid' using errcode = '22023';
	end if;
	-- Account-authored trail events use one of two closed envelopes. The
	-- execution identity is optional provenance: transcripts are synced
	-- conversations, and the audit record of what actually executed lives in
	-- the run, receipt, and publication tables, not in chat content
	-- (founder decision, 2026-08-26).
	v_body_schema := p_body ->> 'schema';
	if v_body_schema = 'qorpera.shared-session/v1' then
		v_entry := p_body -> 'entry';
		if jsonb_typeof(v_entry) <> 'object' then
			raise exception 'session metadata body is invalid' using errcode = '22023';
		end if;
		if p_event_type <> 'session_info'
			or not (p_body ?& array['schema', 'entry'])
			or (p_body - 'schema' - 'entry') <> '{}'::jsonb
			or not (v_entry ?& array['type', 'id', 'parentId', 'timestamp', 'name'])
			or (v_entry - 'type' - 'id' - 'parentId' - 'timestamp' - 'name') <> '{}'::jsonb
			or v_entry ->> 'type' <> 'session_info'
			or jsonb_typeof(v_entry -> 'id') <> 'string'
			or char_length(v_entry ->> 'id') not between 1 and 512
			or jsonb_typeof(v_entry -> 'parentId') not in ('null', 'string')
			or jsonb_typeof(v_entry -> 'timestamp') <> 'string'
			or char_length(v_entry ->> 'timestamp') not between 1 and 64
			or jsonb_typeof(v_entry -> 'name') <> 'string'
			or char_length(v_entry ->> 'name') not between 1 and 256 then
			raise exception 'session metadata body is invalid' using errcode = '22023';
		end if;
	elsif v_body_schema = 'qorpera.shared-trail-entry-part/v1' then
		v_entry_type := p_body ->> 'entryType';
		if not (p_body ?& array['schema', 'entryId', 'entryType', 'partIndex', 'partCount', 'payloadBase64'])
			or (p_body - 'schema' - 'entryId' - 'entryType' - 'partIndex' - 'partCount' - 'payloadBase64') <> '{}'::jsonb
			or jsonb_typeof(p_body -> 'entryId') <> 'string'
			or char_length(p_body ->> 'entryId') not between 1 and 512
			or jsonb_typeof(p_body -> 'entryType') <> 'string'
			or char_length(v_entry_type) not between 1 and 128
			or jsonb_typeof(p_body -> 'partIndex') <> 'number'
			or (p_body ->> 'partIndex') !~ '^(0|[1-9][0-9]*)$'
			or jsonb_typeof(p_body -> 'partCount') <> 'number'
			or (p_body ->> 'partCount') !~ '^[1-9][0-9]*$'
			or jsonb_typeof(p_body -> 'payloadBase64') <> 'string'
			or char_length(p_body ->> 'payloadBase64') not between 4 and 240000
			or char_length(p_body ->> 'payloadBase64') % 4 <> 0
			or (p_body ->> 'payloadBase64') !~ '^[A-Za-z0-9+/]*={0,2}$'
			or (p_event_type = 'message' and v_entry_type <> 'message')
			or (p_event_type = 'session_info' and v_entry_type = 'message')
			or (p_event_type not in ('message', 'session_info') and v_entry_type <> 'custom') then
			raise exception 'session entry part body is invalid' using errcode = '22023';
		end if;
		if (p_body ->> 'partIndex')::numeric < 0
			or (p_body ->> 'partCount')::numeric > 128
			or (p_body ->> 'partIndex')::numeric >= (p_body ->> 'partCount')::numeric then
			raise exception 'session entry part body is invalid' using errcode = '22023';
		end if;
	else
		raise exception 'session event schema is invalid' using errcode = '22023';
	end if;
	if p_execution_kind is null then
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.id = p_session_id;
		if not found or not public.qorpera_can_write_profile(v_session.profile_id) then
			raise exception 'profile write access is required' using errcode = '42501';
		end if;
		-- Metadata is display data; the hosted session row stays authoritative
		-- for title and creation time. Requiring byte-equality here jammed a
		-- session's entire synchronization after any local rename or
		-- timestamp precision drift (founder trail-simplification ruling,
		-- 2026-08-26). Only the entry identity must line up.
		if p_body #>> '{entry,id}' <> 'cloud-session-info:' || v_session.client_session_id::text
			or jsonb_typeof(p_body #> '{entry,parentId}') <> 'null' then
			raise exception 'session metadata does not match the hosted session' using errcode = '22023';
		end if;
	end if;

	select event.* into v_existing
	from public.qorpera_session_events as event
	where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> p_session_id
			or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body
			or v_existing.execution_kind is distinct from p_execution_kind
			or v_existing.execution_id is distinct from p_execution_id
			or v_existing.execution_claimant_id is distinct from p_execution_claimant_id then
			raise exception 'event id is already bound to different content' using errcode = '23505';
		end if;
		if v_existing.actor_user_id <> v_user_id and p_execution_kind is not null then
			raise exception 'session event belongs to another member' using errcode = '42501';
		end if;
		if not public.qorpera_can_write_profile(public.qorpera_session_profile_id(p_session_id)) then
			raise exception 'profile write access is required' using errcode = '42501';
		end if;
		if p_event_type = 'authorization_decision'
			and not public.qorpera_can_authorize_profile(public.qorpera_session_profile_id(p_session_id)) then
			raise exception 'authorization requires full access' using errcode = '42501';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id,
			'sequence', v_existing.sequence,
			'event_id', v_existing.event_id,
			'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id,
			'body', v_existing.body,
			'previous_hash', v_existing.previous_hash,
			'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind,
			'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'created_at', v_existing.created_at
		);
	end if;

	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_session.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if v_session.status <> 'open' then
		raise exception 'session is closed' using errcode = '55000';
	end if;
	if p_event_type = 'authorization_decision' and not public.qorpera_can_authorize_profile(v_session.profile_id) then
		raise exception 'authorization requires full access' using errcode = '42501';
	end if;

	if p_execution_kind = 'turn' then
		select exists (
			select 1
			from public.qorpera_session_turns as turn
			where turn.id = p_execution_id
				and turn.session_id = p_session_id
				and turn.claimant_id = p_execution_claimant_id
				and turn.claimed_by_user_id = v_user_id
				and turn.status = 'active'
				and turn.lease_expires_at > statement_timestamp()
				and turn.company_snapshot_id = v_session.company_snapshot_id
				and turn.staff_version = v_session.staff_version
		) into v_execution_valid;
	elsif p_execution_kind = 'wake' then
		select exists (
			select 1
			from public.qorpera_wake_claims as claim
			where claim.execution_id = p_execution_id
				and claim.profile_id = v_session.profile_id
				and claim.claimant_id = p_execution_claimant_id
				and claim.claimed_by_user_id = v_user_id
				and claim.completed_at is null
				and claim.claim_expires_at > statement_timestamp()
				and claim.company_snapshot_id = v_session.company_snapshot_id
				and claim.staff_version = v_session.staff_version
				and (
					v_session.staff_agent_id is null
					or v_session.staff_agent_id = claim.staff_agent_id::text
				)
		) into v_execution_valid;
	else
		-- No execution asserted: plain account-authored content. Membership
		-- and write access were already enforced above; an execution identity
		-- is optional provenance, but one that IS asserted must match a live
		-- claim (validated in the branch above).
		v_execution_valid := true;
	end if;
	if not v_execution_valid then
		raise exception 'live trail execution claim is required' using errcode = '42501';
	end if;

	select event.sequence, event.event_hash
	into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
	order by event.sequence desc
	limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'session event sequence changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(
		extensions.digest(
			convert_to(
				coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
					'session_id', p_session_id,
					'sequence', v_sequence,
					'event_id', p_event_id,
					'event_type', p_event_type,
					'actor_user_id', v_user_id,
					'body', p_body,
					'execution_kind', p_execution_kind,
					'execution_id', p_execution_id,
					'execution_claimant_id', p_execution_claimant_id,
					'created_at', v_created_at
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, created_at
	) values (
		p_session_id, v_sequence, p_event_id, p_event_type, v_user_id, p_body,
		v_previous_hash, v_event_hash, p_execution_kind, p_execution_id,
		p_execution_claimant_id, v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = p_session_id;

	return jsonb_build_object(
		'session_id', p_session_id,
		'sequence', v_sequence,
		'event_id', p_event_id,
		'event_type', p_event_type,
		'actor_user_id', v_user_id,
		'body', p_body,
		'previous_hash', v_previous_hash,
		'event_hash', v_event_hash,
		'execution_kind', p_execution_kind,
		'execution_id', p_execution_id,
		'execution_claimant_id', p_execution_claimant_id,
		'created_at', v_created_at
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_append_execution_input_events(uuid,uuid[])'::regprocedure), 'sha256'), 'hex') <> '03e5147f240f99381065573ffd3d47a20c50c75194a206e89d875605f0b915a6' then
		raise exception 'Reviewed function definition changed: qorpera_append_execution_input_events';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_append_execution_input_events(p_session_id uuid, p_input_ids uuid[])
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint;
	v_previous_hash text;
	v_parent_entry_id text;
	v_body jsonb;
	v_text text;
	v_images jsonb;
	v_event_hash text;
begin
	if auth.role() <> 'service_role' or p_session_id is null
		or coalesce(cardinality(p_input_ids), 0) not between 1 and 32
		or cardinality(p_input_ids) <> (select count(distinct input_id) from unnest(p_input_ids) as input_id) then
		raise exception 'execution input transcript authority is invalid' using errcode = '42501';
	end if;
	select session.* into strict v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id and session.status = 'open'
	for update;
	if (
		select count(*)
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
	) <> cardinality(p_input_ids) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'execution input transcript set changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select event.sequence, event.event_hash, event.body #>> '{entry,id}'
	into v_sequence, v_previous_hash, v_parent_entry_id
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
	order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	for v_input in
		select input.*
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
		order by input.position
	loop
		if v_input.kind <> 'user_message'
			or v_input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1' then
			continue;
		end if;
		select event.* into v_existing
		from public.qorpera_session_events as event
		where event.event_id = v_input.id;
		if found then
			if v_existing.session_id <> p_session_id
				or v_existing.session_input_id is distinct from v_input.id
				or v_existing.actor_user_id <> v_input.author_user_id
				or v_existing.event_type <> 'message' then
				raise exception 'session input event id is already bound to other content' using errcode = '23505';
			end if;
			continue;
		end if;
		v_text := coalesce(v_input.body ->> 'displayText', v_input.body ->> 'text', '');
		v_images := case when jsonb_typeof(v_input.body -> 'images') = 'array'
			then v_input.body -> 'images' else '[]'::jsonb end;
		if v_text = '' then
			v_text := case jsonb_array_length(v_images)
				when 1 then '[Attached image]'
				else '[' || jsonb_array_length(v_images)::text || ' attached images]'
			end;
		end if;
		v_body := jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'message',
				'id', v_input.id,
				'parentId', v_parent_entry_id,
				'timestamp', to_char(v_input.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				'message', jsonb_build_object(
					'role', 'user',
					'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text)),
					'timestamp', floor(extract(epoch from v_input.created_at) * 1000)::bigint
				),
				'qorperaAttachments', v_images
			)
		);
		v_sequence := v_sequence + 1;
		v_event_hash := encode(extensions.digest(convert_to(
			coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
				'session_id', p_session_id,
				'sequence', v_sequence,
				'event_id', v_input.id,
				'event_type', 'message',
				'actor_user_id', v_input.author_user_id,
				'body', v_body,
				'session_input_id', v_input.id,
				'created_at', v_input.created_at
			)::text,
			'utf8'
		), 'sha256'), 'hex');
		insert into public.qorpera_session_events (
			session_id, sequence, event_id, event_type, actor_user_id, body,
			previous_hash, event_hash, session_input_id, created_at
		) values (
			p_session_id, v_sequence, v_input.id, 'message', v_input.author_user_id, v_body,
			v_previous_hash, v_event_hash, v_input.id, v_input.created_at
		);
		v_previous_hash := v_event_hash;
		v_parent_entry_id := v_input.id::text;
	end loop;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return v_sequence;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_append_runner_transcript_event(uuid,text,uuid,text,uuid,uuid,text,jsonb,bigint)'::regprocedure), 'sha256'), 'hex') <> '52f1a3b05d10683d958503d20db90307adacf0a80516285a5d9bb55142497686' then
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
		or (v_session.staff_agent_id is not null and v_session.staff_version <> v_run.staff_version) then
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

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_append_session_input(uuid,uuid,text,jsonb)'::regprocedure), 'sha256'), 'hex') <> '1643b032b8014ce1b0d60f70d63d34e5eed25334c8a9fee0265b1bba6d52f594' then
		raise exception 'Reviewed function definition changed: qorpera_append_session_input';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_append_session_input(p_session_id uuid, p_client_input_id uuid, p_kind text, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_input public.qorpera_session_inputs%rowtype;
	v_profile_id uuid;
	v_image jsonb;
	v_image_bytes bigint;
	v_total_image_bytes bigint := 0;
	v_pending_inputs integer;
	v_pending_body_bytes bigint;
begin
	v_profile_id := public.qorpera_session_profile_for_write(p_session_id);
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	if public.qorpera_profile_gc_deletion_active(v_profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'profile object cleanup is in progress', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if p_client_input_id is null then
		raise exception 'client input id is required' using errcode = '22023';
	end if;
	if p_kind is distinct from 'user_message' then
		raise exception 'input kind is invalid' using errcode = '22023';
	end if;
	if p_body is null or jsonb_typeof(p_body) <> 'object' or pg_column_size(p_body) > 131072 then
		raise exception 'input body is invalid' using errcode = '22023';
	end if;
	if p_body ->> 'schema' = 'qorpera.staff-intro-retry/v1' then
		if p_body <> jsonb_build_object('schema', 'qorpera.staff-intro-retry/v1') then
			raise exception 'introduction retry body is invalid' using errcode = '22023';
		end if;
	elsif p_body ->> 'schema' = 'qorpera.session-prompt/v1' then
		if jsonb_typeof(p_body -> 'text') is distinct from 'string'
			or octet_length(p_body ->> 'text') > 65536
			or (p_body ? 'displayText' and (
				jsonb_typeof(p_body -> 'displayText') is distinct from 'string'
				or octet_length(p_body ->> 'displayText') > 65536
			))
			or jsonb_typeof(p_body -> 'images') is distinct from 'array'
			or jsonb_array_length(p_body -> 'images') > 5
			or p_body - 'schema' - 'text' - 'displayText' - 'images' <> '{}'::jsonb then
			raise exception 'session prompt body is invalid' using errcode = '22023';
		end if;
		for v_image in select value from jsonb_array_elements(p_body -> 'images') loop
			if jsonb_typeof(v_image) is distinct from 'object'
				or v_image - 'objectSha256' - 'bytes' - 'mediaType' <> '{}'::jsonb
				or coalesce(v_image ->> 'objectSha256', '') !~ '^[0-9a-f]{64}$'
				or jsonb_typeof(v_image -> 'bytes') is distinct from 'number'
				or coalesce(v_image ->> 'mediaType', '') not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp') then
				raise exception 'session prompt image is invalid' using errcode = '22023';
			end if;
			begin
				v_image_bytes := (v_image ->> 'bytes')::bigint;
			exception when others then
				raise exception 'session prompt image size is invalid' using errcode = '22023';
			end;
			if to_jsonb(v_image_bytes) <> v_image -> 'bytes' or v_image_bytes not between 1 and 8388608 then
				raise exception 'session prompt image size is invalid' using errcode = '22023';
			end if;
			v_total_image_bytes := v_total_image_bytes + v_image_bytes;
			if v_total_image_bytes > 8388608 then
				raise exception 'session prompt images exceed the turn allowance' using errcode = '22023';
			end if;
			if not exists (
				select 1 from public.qorpera_profile_objects as object
				where object.profile_id = v_profile_id
					and object.sha256 = v_image ->> 'objectSha256'
					and object.bytes = v_image_bytes
			) then
				raise exception 'session prompt image object is unavailable or has the wrong size' using errcode = '22023';
			end if;
		end loop;
	else
		raise exception 'input body schema is invalid' using errcode = '22023';
	end if;

	-- Serialize producers for this session so the pending row/byte limits are
	-- durable rather than a client-side estimate. Idempotent retries return the
	-- original input before consuming queue capacity.
	perform 1
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	select input.* into v_input
	from public.qorpera_session_inputs as input
	where input.session_id = p_session_id and input.client_input_id = p_client_input_id;
	if found then
		if v_input.author_user_id <> v_user_id
			or v_input.kind <> 'user_message'
			or v_input.body <> p_body then
			raise exception 'client input id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object('input_id', v_input.id, 'position', v_input.position);
	end if;
	select count(*), coalesce(sum(pg_column_size(input.body)), 0)
	into v_pending_inputs, v_pending_body_bytes
	from public.qorpera_session_inputs as input
	where input.session_id = p_session_id
		and input.completed_at is null
		and input.failed_at is null;
	if v_pending_inputs >= 512 or v_pending_body_bytes + pg_column_size(p_body) > 16777216 then
		raise exception 'session queue capacity is reached' using errcode = '54000';
	end if;

	insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
	values (p_session_id, p_client_input_id, 'user_message', v_user_id, p_body)
	returning * into v_input;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return jsonb_build_object('input_id', v_input.id, 'position', v_input.position);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_assign_runner_job(uuid,uuid,uuid,uuid,text,integer)'::regprocedure), 'sha256'), 'hex') <> '54534eecb086be66d5ac47d1e9242344b36fabc2a79a5a844debadadeb31a117' then
		raise exception 'Reviewed function definition changed: qorpera_assign_runner_job';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_assign_runner_job(p_orchestrator_id uuid, p_claim_id uuid, p_runner_id uuid, p_client_assignment_id uuid, p_capability_sha256 text, p_assignment_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '25s'
 SET statement_timeout TO '25s'
AS $function$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
begin
	if auth.role() <> 'service_role' or p_client_assignment_id is null
		or p_capability_sha256 !~ '^[0-9a-f]{64}$'
		or p_assignment_seconds not between 30 and 900 then
		raise exception 'runner assignment is invalid' using errcode = '42501';
	end if;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id;
	if not found then raise exception 'runner claim is unavailable' using errcode = '55000'; end if;
	perform 1 from public.qorpera_runner_jobs where id = v_claim.job_id for update;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id for update;
	if not found or v_claim.status not in ('claimed', 'assigned')
		or v_claim.lease_expires_at <= statement_timestamp() then
		raise exception 'orchestrator claim is unavailable' using errcode = '55000';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_claim.job_id for update;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_claim.run_id;
	if v_run.deadline_at <= statement_timestamp()
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'execution sponsor is unavailable' using errcode = '42501';
	end if;
	-- Reject retired/expired runners before the logical-computer UPDATE can
	-- wait on a stale runner held by reconciliation.
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.profile_id = v_job.profile_id
		and runner.status = 'active' and runner.session_expires_at > statement_timestamp()
		and runner.capabilities ? v_job.required_capability for update;
	if not found then raise exception 'compatible runner is unavailable' using errcode = '55000'; end if;
	if v_run.logical_computer_id is not null then
		update public.qorpera_runners as runner
		set logical_computer_id = v_run.logical_computer_id
		where runner.id = p_runner_id and runner.profile_id = v_job.profile_id
			and runner.logical_computer_id is null
			and not exists (
				select 1 from public.qorpera_runner_jobs as active_job
				where active_job.runner_id = runner.id and active_job.status = 'leased'
			);
	end if;
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.profile_id = v_job.profile_id
		and runner.status = 'active' and runner.session_expires_at > statement_timestamp()
		and runner.capabilities ? v_job.required_capability
		and (v_run.logical_computer_id is null or runner.logical_computer_id = v_run.logical_computer_id)
		and (
			runner.logical_computer_id is null
			or exists (
				select 1 from public.qorpera_logical_computers as computer
				where computer.id = runner.logical_computer_id and computer.profile_id = v_run.profile_id
					and computer.status = 'active' and computer.capabilities ? v_job.required_capability
			)
		)
	for update;
	if not found then raise exception 'compatible runner is unavailable' using errcode = '55000'; end if;
	update public.qorpera_runner_assignments as assignment
	set status = 'delivery_failed', last_error = 'Superseded after orchestrator recovery'
	where assignment.claim_id = v_claim.id and assignment.status = 'offered';
	insert into public.qorpera_runner_assignments (
		id, claim_id, job_id, run_id, runner_id, capability_sha256, expires_at
	) values (
		p_client_assignment_id, v_claim.id, v_claim.job_id, v_claim.run_id,
		p_runner_id, p_capability_sha256,
		least(v_run.deadline_at, v_claim.lease_expires_at, statement_timestamp() + make_interval(secs => p_assignment_seconds))
	) returning * into v_assignment;
	update public.qorpera_runner_job_claims set status = 'assigned' where id = v_claim.id;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, 'runner_assigned', jsonb_build_object(
		'orchestrator_id', p_orchestrator_id,
		'assignment_id', v_assignment.id,
		'runner_id', p_runner_id,
		'expires_at', v_assignment.expires_at
	));
	return jsonb_build_object(
		'assignment_id', v_assignment.id,
		'claim_id', v_assignment.claim_id,
		'run_id', v_assignment.run_id,
		'job_id', v_assignment.job_id,
		'runner_id', v_assignment.runner_id,
		'capability_sha256', v_assignment.capability_sha256,
		'expires_at', v_assignment.expires_at
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_authorize_profile_object_deletion(uuid,text,bigint,text,uuid)'::regprocedure), 'sha256'), 'hex') <> '72221b75cfd27e0719afc33dc636ac3daf6cb904e2ddcf34d2a58eb589641f54' then
		raise exception 'Reviewed function definition changed: qorpera_authorize_profile_object_deletion';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_authorize_profile_object_deletion(p_profile_id uuid, p_sha256 text, p_bytes bigint, p_backend text, p_lease_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_authorization public.qorpera_profile_object_deletion_authorizations%rowtype;
	v_object public.qorpera_profile_objects%rowtype;
	v_source_kind text;
	v_source_id uuid;
begin
	if auth.role() <> 'service_role'
		or p_profile_id is null
		or p_lease_id is null
		or p_sha256 is null
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null
		or p_bytes not between 0 and 8388608
		or p_backend is null
		or p_backend not in ('supabase-storage', 'nas-object-gateway') then
		raise exception 'object deletion authorization is invalid' using errcode = '42501';
	end if;
	select deletion_auth.* into v_authorization
	from public.qorpera_profile_object_deletion_authorizations as deletion_auth
	where deletion_auth.profile_id = p_profile_id and deletion_auth.object_sha256 = p_sha256
	for update;
	if found then
		if v_authorization.bytes is distinct from p_bytes
			or v_authorization.backend is distinct from p_backend then
			raise exception 'object deletion authorization does not match the catalog address' using errcode = '55000';
		end if;
		return jsonb_build_object('state', 'authorized', 'authorization_id', v_authorization.authorization_id);
	end if;

	select plan.id, 'artifact_gc' into v_source_id, v_source_kind
	from public.qorpera_artifact_gc_plans as plan
	join public.qorpera_artifact_gc_plan_entries as entry on entry.plan_id = plan.id
	where plan.profile_id = p_profile_id
		and plan.status = 'deleting'
		and plan.lease_id = p_lease_id
		and plan.lease_expires_at > statement_timestamp()
		and entry.object_sha256 = p_sha256
		and entry.bytes = p_bytes
		and entry.status = 'pending'
	for update of plan;
	if not found then
		select lease.profile_id, 'company_gc' into v_source_id, v_source_kind
		from public.qorpera_company_object_gc_leases as lease
		join public.qorpera_company_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
		for update of lease;
	end if;
	if v_source_kind is null then
		select lease.profile_id, 'deleted_profile_gc' into v_source_id, v_source_kind
		from public.qorpera_deleted_profile_object_gc_leases as lease
		join public.qorpera_deleted_profile_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
			and entry.backend = p_backend
		for update of lease;
	end if;
	if v_source_kind is null then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'object deletion lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;

	if v_source_kind <> 'deleted_profile_gc' then
		perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	end if;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256
	for update;
	if not found then
		return jsonb_build_object('state', 'completed');
	end if;
	if v_object.bytes <> p_bytes or v_object.backend <> p_backend then
		raise exception 'object deletion does not match the catalog' using errcode = '55000';
	end if;
	insert into public.qorpera_profile_object_deletion_authorizations (
		profile_id, object_sha256, bytes, backend, source_kind, source_id, lease_id,
		company_lease_profile_id, company_lease_id,
		deleted_profile_lease_profile_id, deleted_profile_lease_id
	) values (
		p_profile_id, p_sha256, p_bytes, p_backend, v_source_kind, v_source_id, p_lease_id,
		case when v_source_kind = 'company_gc' then p_profile_id else null end,
		case when v_source_kind = 'company_gc' then p_lease_id else null end,
		case when v_source_kind = 'deleted_profile_gc' then p_profile_id else null end,
		case when v_source_kind = 'deleted_profile_gc' then p_lease_id else null end
	) returning * into v_authorization;
	return jsonb_build_object('state', 'authorized', 'authorization_id', v_authorization.authorization_id);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_authorize_profile_object_replication(uuid,text,bigint)'::regprocedure), 'sha256'), 'hex') <> '5ca5810111de76cb5213550f973e862cc6bf19f4a157a1b928ceee14bf922c13' then
		raise exception 'Reviewed function definition changed: qorpera_authorize_profile_object_replication';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_authorize_profile_object_replication(p_profile_id uuid, p_sha256 text, p_bytes bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
	if auth.role() is distinct from 'service_role'
		or p_profile_id is null or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null or p_bytes not between 0 and 8388608 then
		raise exception 'replication authority is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'replication is fenced by cleanup', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for key share;
	if not found then raise exception 'replication company is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_objects
	where profile_id = p_profile_id and sha256 = p_sha256 and bytes = p_bytes for key share;
	if not found then raise exception 'replication object is unavailable' using errcode = '42501'; end if;
	return true;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_begin_office_software(text,text,text,bigint,text,text)'::regprocedure), 'sha256'), 'hex') <> 'e912c97ed0c3f322e2db3494a35eb61c5022b6a3bc56b96fe6b7695a2907b422' then
		raise exception 'Reviewed function definition changed: qorpera_begin_office_software';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_begin_office_software(p_plan_text text, p_statement_text text, p_plan_sha256 text, p_expected_revision bigint, p_stop_text text, p_provider_capability text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p jsonb; s jsonb; a public.qorpera_runtime_office_activations%rowtype;
 b public.qorpera_office_software_baselines%rowtype; u public.qorpera_office_software_updates%rowtype;
 o public.qorpera_runtime_offices%rowtype; v_current jsonb; v_stop jsonb; v_key text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
 if p_plan_text is null or p_statement_text is null or p_stop_text is null or octet_length(p_plan_text)>65536 or octet_length(p_statement_text)>65536 or octet_length(p_stop_text)>65536 then
  raise exception 'Invalid office software documents' using errcode='22023'; end if;
 p:=p_plan_text::jsonb; s:=p_statement_text::jsonb;
 perform public.qorpera_require_office_software_capability((p#>>'{predecessor,startup,allocationId}')::uuid,p_provider_capability,false);
 perform public.qorpera_office_software_object(p,array['schema','updateId','predecessor','stopAcknowledgementSha256','successorActivationId','statementSha256']);
 perform public.qorpera_office_software_object(s,array['schema','base','previous','next','source','acceptance']);
 perform public.qorpera_office_software_object(s->'source',array['repository','commit','tree']);
 perform public.qorpera_office_software_object(s->'acceptance',array['testedAt','evidenceSha256','change']);
 perform public.qorpera_office_software_object(s->'next',array['packageManifestSha256','service']);
 perform public.qorpera_office_software_strings(p,array['schema','updateId','stopAcknowledgementSha256','successorActivationId','statementSha256']);
 perform public.qorpera_office_software_strings(s->'source',array['repository','commit','tree']);
 perform public.qorpera_office_software_strings(s->'acceptance',array['testedAt','evidenceSha256','change']);
 perform public.qorpera_office_software_strings(s->'next',array['packageManifestSha256']);
 perform public.qorpera_office_software_specification(s->'previous');
 perform public.qorpera_office_software_artifact(s#>'{next,service}');
 foreach v_key in array array['updateId','successorActivationId'] loop
  if jsonb_typeof(p->v_key) is distinct from 'string' or p->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
   raise exception 'Invalid office software identity' using errcode='22023'; end if;
 end loop;
 perform public.qorpera_office_software_sha(p->>'stopAcknowledgementSha256');
 perform public.qorpera_office_software_sha(p->>'statementSha256');
 perform public.qorpera_office_software_sha(p_plan_sha256);
 perform public.qorpera_office_software_sha(s#>>'{next,packageManifestSha256}');
 perform public.qorpera_office_software_sha(s#>>'{acceptance,evidenceSha256}');
 if p->>'schema' is distinct from 'qorpera.office-service-software-plan/v1'
  or s->>'schema' is distinct from 'qorpera.office-service-software-statement/v1'
  or s#>>'{source,tree}' is distinct from 'clean' or s#>>'{acceptance,change}' is distinct from 'service-only'
  or coalesce(s#>>'{source,commit}','') !~ '^[0-9a-f]{40}$'
  or coalesce(s#>>'{source,repository}','') !~ '^https://[^/?#@:]+(/[^?#]*)?$'
  or length(s#>>'{source,repository}')>2048
  or coalesce(s#>>'{acceptance,testedAt}','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  or s#>'{previous,service,sha256}'=s#>'{next,service,sha256}'
  or s#>'{previous,packageManifestSha256}'=s#>'{next,packageManifestSha256}'
  or encode(extensions.digest(p_plan_text,'sha256'),'hex')<>p_plan_sha256
  or encode(extensions.digest(p_statement_text,'sha256'),'hex')<>p->>'statementSha256'
  or p#>>'{predecessor,action}' is distinct from 'service_restart'
  or (select count(distinct value) from unnest(array[p->>'updateId',p->>'successorActivationId',p#>>'{predecessor,activationId}',p#>>'{predecessor,transitionId}']) value)<>4 then
  raise exception 'Office software plan or statement differs' using errcode='42501'; end if;
 perform (s#>>'{acceptance,testedAt}')::timestamptz;
 perform public.qorpera_lock_runtime_office_stop(p->'predecessor');
 select * into strict a from public.qorpera_runtime_office_activations where activation_id=(p#>>'{predecessor,activationId}')::uuid;
 perform public.qorpera_check_runtime_office_restart_surfaces(a);
 perform public.qorpera_require_office_software_capability(a.allocation_id,p_provider_capability,true);
 select * into strict o from public.qorpera_runtime_offices where id=a.office_id;
 select * into b from public.qorpera_office_software_baselines where allocation_id=a.allocation_id for update;
 if not found or s->'base' is distinct from b.base then raise exception 'Office software baseline unavailable' using errcode='42501'; end if;
 select public.qorpera_runtime_office_stop_result(stop,p->'predecessor') into v_stop
  from public.qorpera_runtime_office_stops stop where transition_id=(p#>>'{predecessor,transitionId}')::uuid;
 if v_stop is null or p_stop_text::jsonb<>v_stop or encode(extensions.digest(p_stop_text,'sha256'),'hex')<>p->>'stopAcknowledgementSha256'
  then raise exception 'Office software stop unavailable' using errcode='42501'; end if;
 select * into u from public.qorpera_office_software_updates where id=(p->>'updateId')::uuid for update;
 if found then
  if u.plan<>p or u.statement<>s or u.plan_sha256<>p_plan_sha256 or u.previous_revision is distinct from p_expected_revision then
   raise exception 'Office software update cannot be rebound' using errcode='42501'; end if;
  return jsonb_build_object('updateId',u.id,'state',u.state,'targetRevision',u.target_revision);
 end if;
 select specification into v_current from public.qorpera_office_software_revisions where allocation_id=b.allocation_id and revision=b.current_revision;
 if p_expected_revision is null or p_expected_revision<>b.current_revision or a.software_revision is distinct from b.current_revision
  or s->'previous' is distinct from v_current or exists(select 1 from public.qorpera_runtime_office_activations where activation_id=(p->>'successorActivationId')::uuid) then
  raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Office software current revision changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 insert into public.qorpera_office_software_updates(id,allocation_id,predecessor_activation_id,successor_activation_id,transition_id,
  previous_revision,target_revision,plan,statement,plan_sha256,statement_sha256,office_revision,privacy_version,privacy_state,privacy_challenge)
 values((p->>'updateId')::uuid,a.allocation_id,a.activation_id,(p->>'successorActivationId')::uuid,(p#>>'{predecessor,transitionId}')::uuid,
  b.current_revision,b.current_revision+1,p,s,p_plan_sha256,p->>'statementSha256',o.revision,o.privacy_version,o.privacy_state,o.privacy_challenge) returning * into u;
 return jsonb_build_object('updateId',u.id,'state',u.state,'targetRevision',u.target_revision);
end $function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_claim_artifact_gc_objects(uuid,uuid,integer)'::regprocedure), 'sha256'), 'hex') <> '0555c4b374fb8cc88abdc843dc3b1d20cc293d3e0aab90d940c0ed131f6dbd36' then
		raise exception 'Reviewed function definition changed: qorpera_claim_artifact_gc_objects';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_claim_artifact_gc_objects(p_plan_id uuid, p_lease_id uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 100 then
		raise exception 'artifact cleanup object claim is invalid' using errcode = '42501';
	end if;
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;

	update public.qorpera_artifact_gc_plan_entries as entry
	set status = 'retained', acknowledged_at = statement_timestamp()
	where entry.plan_id = p_plan_id and entry.status = 'pending'
		and exists (
			select 1
			from public.qorpera_object_reachability_entries as retained_entry
			join public.qorpera_object_reachability_graphs as retained_graph
				on retained_graph.id = retained_entry.graph_id
			where retained_entry.object_sha256 = entry.object_sha256
				and retained_graph.id <> v_plan.graph_id
				and retained_graph.profile_id = v_plan.profile_id
				and retained_graph.status = 'complete'
		);

	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', v_plan.profile_id::text || '/' || entry.object_sha256,
			'backend', coalesce(object.backend, 'missing')
		) order by entry.object_sha256)
		from (
			select candidate.* from public.qorpera_artifact_gc_plan_entries as candidate
			where candidate.plan_id = p_plan_id and candidate.status = 'pending'
			order by candidate.object_sha256 limit p_limit
		) as entry
		left join public.qorpera_profile_objects as object
			on object.profile_id = v_plan.profile_id and object.sha256 = entry.object_sha256
	), '[]'::jsonb);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_claim_company_object_gc(integer,uuid)'::regprocedure), 'sha256'), 'hex') <> 'd544b94825260c14509fbf6c401c8d91c0c02d430f90af215aef92c9896fff2a' then
		raise exception 'Reviewed function definition changed: qorpera_claim_company_object_gc';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_claim_company_object_gc(p_limit integer, p_lease_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '8s'
AS $function$
declare
	v_profile_id uuid;
	v_cutoff timestamptz := statement_timestamp() - interval '24 hours';
	v_candidates text[];
	v_objects jsonb;
begin
	if auth.role() <> 'service_role' or p_lease_id is null or p_limit not between 1 and 100 then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_company_object_gc_leases
	where lease_expires_at <= statement_timestamp();

	-- Candidate selection runs without the profile GC fence.
	for v_profile_id in
		select object.profile_id
		from public.qorpera_profile_objects as object
		where object.created_at < v_cutoff
			and exists (
				select 1 from public.qorpera_company_files as file
				where file.profile_id = object.profile_id
			)
		group by object.profile_id
		order by min(object.created_at), object.profile_id
	loop
		if public.qorpera_profile_gc_deletion_active(v_profile_id) then
			continue;
		end if;
		-- One retained-hash evaluation for this profile, still without the fence.
		select array_agg(candidate.sha256 order by candidate.created_at, candidate.sha256)
		into v_candidates
		from (
			with retained as materialized (
				select retained.object_sha256
				from public.qorpera_company_retained_object_hashes(v_profile_id) as retained
			)
			select object.sha256, object.created_at
			from public.qorpera_profile_objects as object
			where object.profile_id = v_profile_id
				and object.created_at < v_cutoff
				and not exists (
					select 1 from retained where retained.object_sha256 = object.sha256
				)
			order by object.created_at, object.sha256
			limit p_limit
		) as candidate;
		if v_candidates is null then
			continue;
		end if;

		-- Fence: one profile, held only around the lease and entry inserts.
		perform public.qorpera_lock_profile_gc_fence(v_profile_id);
		if public.qorpera_profile_gc_deletion_active(v_profile_id) then
			return null;
		end if;
		insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
		values (v_profile_id, p_lease_id, statement_timestamp() + interval '10 minutes');
		insert into public.qorpera_company_object_gc_entries (profile_id, lease_id, object_sha256, bytes)
		with retained as materialized (
			select retained.object_sha256
			from public.qorpera_company_retained_object_hashes(v_profile_id) as retained
		)
		select object.profile_id, p_lease_id, object.sha256, object.bytes
		from public.qorpera_profile_objects as object
		where object.profile_id = v_profile_id
			and object.sha256 = any (v_candidates)
			and object.created_at < v_cutoff
			and not exists (
				select 1 from retained where retained.object_sha256 = object.sha256
			)
		order by object.created_at, object.sha256
		limit p_limit;
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', entry.profile_id::text || '/' || entry.object_sha256,
			'backend', coalesce(object.backend, 'missing')
		) order by entry.object_sha256) into v_objects
		from public.qorpera_company_object_gc_entries as entry
		left join public.qorpera_profile_objects as object
			on object.profile_id = entry.profile_id and object.sha256 = entry.object_sha256
		where entry.profile_id = v_profile_id and entry.lease_id = p_lease_id;
		if v_objects is null then
			delete from public.qorpera_company_object_gc_leases
			where profile_id = v_profile_id and lease_id = p_lease_id;
			return null;
		end if;
		return jsonb_build_object(
			'profile_id', v_profile_id,
			'lease_id', p_lease_id,
			'objects', v_objects
		);
	end loop;
	return null;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_claim_runner_job(uuid,text,uuid,text)'::regprocedure), 'sha256'), 'hex') <> '03811094504ea14dc903b9fd61d3f2dbd43ce12beee48355a502dc709cbe5ec2' then
		raise exception 'Reviewed function definition changed: qorpera_claim_runner_job';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_claim_runner_job(p_runner_id uuid, p_session_token_sha256 text, p_client_lease_id uuid, p_lease_token_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_recovered boolean;
begin
	if auth.role() <> 'service_role' or p_client_lease_id is null
		or p_session_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job claim is invalid' using errcode = '42501';
	end if;
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.status = 'active' for update;
	if not found then raise exception 'runner session is unavailable' using errcode = '42501'; end if;

	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.runner_id = p_runner_id and job.client_lease_id = p_client_lease_id;
	if found then
		if v_job.status <> 'leased' or v_job.lease_expires_at <= statement_timestamp()
			or v_job.lease_token_sha256 <> p_lease_token_sha256 then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner lease replay is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		return public.qorpera_runner_job_json(v_job);
	end if;

	if (
		select count(*) from public.qorpera_runner_jobs as active_job
		where active_job.runner_id = p_runner_id and active_job.status = 'leased'
			and active_job.lease_expires_at > statement_timestamp()
	) >= v_runner.max_concurrency then
		return 'null'::jsonb;
	end if;

	for v_job in
		select exhausted.* from public.qorpera_runner_jobs as exhausted
		where exhausted.profile_id = v_runner.profile_id and exhausted.status = 'leased'
			and exhausted.lease_expires_at <= statement_timestamp()
			and exhausted.attempt_count >= 8 for update skip locked
	loop
		update public.qorpera_runner_jobs
		set status = 'failed', terminal_lease_token_sha256 = lease_token_sha256,
			lease_token_sha256 = null, lease_expires_at = null,
			finished_at = statement_timestamp(), last_error = 'Runner lease expired after the final attempt'
		where id = v_job.id returning * into v_job;
		perform public.qorpera_append_runner_audit(
			v_job.profile_id, v_job.runner_id, v_job.id, 'job_failed',
			jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'lease_expired'), null
		);
	end loop;

	select candidate.* into v_job
	from public.qorpera_runner_jobs as candidate
	where candidate.profile_id = v_runner.profile_id
		and candidate.required_capability in (
			select capability.value from jsonb_array_elements_text(v_runner.capabilities) as capability(value)
		)
		and candidate.attempt_count < 8
		and (
			candidate.status = 'queued'
			or (candidate.status = 'leased' and candidate.lease_expires_at <= statement_timestamp())
		)
	order by candidate.created_at, candidate.id
	for update skip locked
	limit 1;
	if not found then return 'null'::jsonb; end if;
	v_recovered := v_job.status = 'leased';

	update public.qorpera_runner_jobs
	set status = 'leased', runner_id = p_runner_id, client_lease_id = p_client_lease_id,
		lease_token_sha256 = p_lease_token_sha256,
		lease_expires_at = statement_timestamp() + interval '2 minutes',
		attempt_count = attempt_count + 1,
		started_at = coalesce(started_at, statement_timestamp()), last_error = null
	where id = v_job.id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_leased',
		jsonb_build_object(
			'attempt_count', v_job.attempt_count,
			'lease_expires_at', v_job.lease_expires_at,
			'recovered', coalesce(v_recovered, false)
		), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_company_path_actor(uuid,jsonb)'::regprocedure), 'sha256'), 'hex') <> 'ed390eb8347c4356fd1dba9240d600d6927ac5ca0b970c31d6ac1354259c3ab6' then
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
			and staff_agent_id = v_run.staff_agent_id and version = v_run.staff_version
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
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_artifact_gc_objects(uuid,uuid,text[])'::regprocedure), 'sha256'), 'hex') <> '2e21615fa4d452169b1612e0f40c01f5228a11092b3357873b97190959301005' then
		raise exception 'Reviewed function definition changed: qorpera_complete_artifact_gc_objects';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_artifact_gc_objects(p_plan_id uuid, p_lease_id uuid, p_object_sha256s text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_count integer;
	v_bytes bigint;
begin
	if auth.role() <> 'service_role' or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		) or exists (select 1 from unnest(p_object_sha256s) as sha256 where sha256 !~ '^[0-9a-f]{64}$') then
		raise exception 'artifact cleanup acknowledgement is invalid' using errcode = '42501';
	end if;
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	if exists (
		select 1 from unnest(p_object_sha256s) as sha256
		left join public.qorpera_artifact_gc_plan_entries as entry
			on entry.plan_id = p_plan_id and entry.object_sha256 = sha256 and entry.status = 'pending'
		where entry.object_sha256 is null
	) then
		raise exception 'artifact cleanup acknowledgement is outside the plan' using errcode = '22023';
	end if;
	select count(*), coalesce(sum(entry.bytes), 0) into v_count, v_bytes
	from public.qorpera_artifact_gc_plan_entries as entry
	where entry.plan_id = p_plan_id and entry.object_sha256 = any(p_object_sha256s);
	update public.qorpera_artifact_gc_plan_entries
	set status = 'deleted', acknowledged_at = statement_timestamp()
	where plan_id = p_plan_id and object_sha256 = any(p_object_sha256s);
	perform public.qorpera_append_artifact_gc_audit(
		v_plan, 'object_batch_acknowledged',
		jsonb_build_object('object_count', v_count, 'storage_bytes', v_bytes), null
	);
	return jsonb_build_object('object_count', v_count, 'storage_bytes', v_bytes);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_artifact_gc_plan(uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> 'c94b43cdf69d7dba8929dea52c843ce5adfaca51e0fdc154856cc1a9ccd2a111' then
		raise exception 'Reviewed function definition changed: qorpera_complete_artifact_gc_plan';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_artifact_gc_plan(p_plan_id uuid, p_lease_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_artifact public.qorpera_artifacts%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'artifact cleanup completion requires the worker' using errcode = '42501';
	end if;
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	perform public.qorpera_claim_artifact_gc_objects(p_plan_id, p_lease_id, 100);
	if exists (
		select 1 from public.qorpera_artifact_gc_plan_entries as entry
		where entry.plan_id = p_plan_id and entry.status = 'pending'
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup still has pending objects', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if exists (
		select 1
		from public.qorpera_artifact_gc_plan_entries as entry
		join public.qorpera_profile_objects as object
			on object.profile_id = v_plan.profile_id
			and object.sha256 = entry.object_sha256
		where entry.plan_id = p_plan_id and entry.status = 'deleted'
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup storage removal is not yet visible', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select artifact.* into v_artifact from public.qorpera_artifacts as artifact
	where artifact.id = v_plan.artifact_id for update;
	if exists (
		select 1 from public.qorpera_artifact_retention_holds as hold
		where hold.artifact_id = v_artifact.id and hold.released_at is null
			and (hold.expires_at is null or hold.expires_at > statement_timestamp())
	) or exists (
		select 1 from public.qorpera_artifact_index_entries as index_entry
		join public.qorpera_company_substrate_versions as version
			on version.artifact_index_id = index_entry.index_id
		where index_entry.artifact_id = v_artifact.id
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup became retained before completion', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_artifacts set gc_completed_at = statement_timestamp()
	where id = v_artifact.id;
	update public.qorpera_artifact_gc_plans
	set status = 'completed', completed_at = statement_timestamp(),
		lease_id = null, lease_expires_at = null, last_error = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(
		v_plan, 'completed', jsonb_build_object(
			'deleted_object_count', (
				select count(*) from public.qorpera_artifact_gc_plan_entries as entry
				where entry.plan_id = p_plan_id and entry.status = 'deleted'
			),
			'retained_object_count', (
				select count(*) from public.qorpera_artifact_gc_plan_entries as entry
				where entry.plan_id = p_plan_id and entry.status = 'retained'
			)
		), null
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_company_object_gc(uuid,uuid,text[])'::regprocedure), 'sha256'), 'hex') <> '3961d12029bfb018562ef24f14dff21ff0e2bc3d1cdacc66c0fdb3798784c0d2' then
		raise exception 'Reviewed function definition changed: qorpera_complete_company_object_gc';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_company_object_gc(p_profile_id uuid, p_lease_id uuid, p_object_sha256s text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role' or cardinality(p_object_sha256s) not between 1 and 100 then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	select count(*) into v_expected
	from public.qorpera_company_object_gc_entries as entry
	where entry.profile_id = p_profile_id and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s);
	if v_expected <> cardinality(p_object_sha256s) or exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id and object.sha256 = any(p_object_sha256s)
	) then
		raise exception 'company object cleanup was not confirmed by storage' using errcode = '55000';
	end if;
	delete from public.qorpera_company_object_gc_leases
	where profile_id = p_profile_id and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company object cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return v_expected;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_deleted_profile_object_gc(uuid,uuid,text[])'::regprocedure), 'sha256'), 'hex') <> '32612dbc5b0f08729f5439a313f87739a6964dedf0fd102ca5435a0f723c91b6' then
		raise exception 'Reviewed function definition changed: qorpera_complete_deleted_profile_object_gc';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_deleted_profile_object_gc(p_profile_id uuid, p_lease_id uuid, p_object_sha256s text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role'
		or p_profile_id is null
		or p_lease_id is null
		or p_object_sha256s is null
		or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		)
		or exists (
			select 1 from unnest(p_object_sha256s) as sha256
			where sha256 !~ '^[0-9a-f]{64}$'
		) then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	select count(*) into v_expected
	from public.qorpera_deleted_profile_object_gc_entries as entry
	where entry.profile_id = p_profile_id
		and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s);
	if v_expected <> cardinality(p_object_sha256s) or exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id and object.sha256 = any(p_object_sha256s)
	) then
		raise exception 'deleted profile object cleanup was not confirmed by storage' using errcode = '55000';
	end if;
	delete from public.qorpera_deleted_profile_object_gc_leases
	where profile_id = p_profile_id
		and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'deleted profile object cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return v_expected;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_profile_invitation_delivery(uuid,uuid,text)'::regprocedure), 'sha256'), 'hex') <> '24712cf95ade9cca4599cf50103782811725a2f58b17d69c8dca16f44da7d7fe' then
		raise exception 'Reviewed function definition changed: qorpera_complete_profile_invitation_delivery';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_profile_invitation_delivery(p_invitation_id uuid, p_lease_id uuid, p_provider_message_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
	if char_length(btrim(p_provider_message_id)) not between 1 and 256 then
		raise exception 'provider message id is invalid' using errcode = '22023';
	end if;
	update public.qorpera_profile_invitation_deliveries
	set status = 'delivered',
		provider_message_id = btrim(p_provider_message_id),
		last_error = null,
		sent_at = statement_timestamp(),
		next_attempt_at = statement_timestamp(),
		lease_id = null,
		lease_expires_at = null,
		updated_at = statement_timestamp()
	where invitation_id = p_invitation_id
		and status = 'delivering'
		and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'invitation delivery lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return 'true'::jsonb;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_run_operation_receipt(uuid,text,uuid,text,uuid,uuid,text,jsonb,uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> 'fc393769a4dbf1212e01323ddb75383d37751168b1a39a622d6dfd36e73fccb2' then
		raise exception 'Reviewed function definition changed: qorpera_complete_run_operation_receipt';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_run_operation_receipt(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_assignment_id uuid, p_receipt_id uuid, p_input_sha256 text, p_result jsonb, p_output_snapshot_id uuid DEFAULT NULL::uuid, p_proposal_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 65536
		or (p_output_snapshot_id is not null and p_proposal_id is not null) then
		raise exception 'run operation result is invalid' using errcode = '22023';
	end if;
	select receipt.* into v_receipt
	from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_job.run_id for update;
	if not found or v_receipt.job_id <> p_job_id or v_receipt.assignment_id <> p_assignment_id
		or v_receipt.input_sha256 <> p_input_sha256 then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'run operation receipt is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_receipt.status = 'completed' then
		if v_receipt.result <> p_result
			or v_receipt.output_snapshot_id is distinct from p_output_snapshot_id
			or v_receipt.proposal_id is distinct from p_proposal_id then
			raise exception 'run operation completion replay differs' using errcode = '23505';
		end if;
		return jsonb_build_object('state', 'completed', 'receipt_id', v_receipt.id, 'result', v_receipt.result);
	end if;
	if v_receipt.status <> 'executing' then
		raise exception 'run operation requires recovery review' using errcode = '55000';
	end if;
	if v_receipt.requires_company_revision and p_output_snapshot_id is null and p_proposal_id is null then
		raise exception 'Company File operation has no durable revision' using errcode = '55000';
	end if;
	if p_output_snapshot_id is not null and not exists (
		select 1 from public.qorpera_company_snapshots as snapshot
		join public.qorpera_company_snapshot_publications as publication
			on publication.snapshot_id = snapshot.id and publication.status in ('prepared', 'published')
		join public.qorpera_runner_company_revision_outputs as output
			on output.snapshot_id = snapshot.id
		where snapshot.id = p_output_snapshot_id and snapshot.profile_id = v_job.profile_id
			and snapshot.environment_id = v_job.environment_id
			and output.run_id = v_job.run_id and output.job_id = v_job.id
			and output.assignment_id = v_receipt.assignment_id
			and public.qorpera_object_root_has_current_proof('company_snapshot', snapshot.id)
	) then
		raise exception 'Company File operation snapshot is not the verified run candidate' using errcode = '55000';
	end if;
	if p_proposal_id is not null and not exists (
		select 1 from public.qorpera_company_proposals as proposal
		join public.qorpera_runner_company_revision_outputs as output
			on output.snapshot_id = proposal.proposal_snapshot_id
		where proposal.id = p_proposal_id and proposal.profile_id = v_job.profile_id
			and proposal.environment_id = v_job.environment_id
			and proposal.execution_kind = 'run' and proposal.execution_id = v_job.run_id
			and proposal.execution_claimant_id = v_job.run_id
			and output.run_id = v_job.run_id and output.job_id = v_job.id
			and output.assignment_id = v_receipt.assignment_id
	) then
		raise exception 'Company File operation proposal is not owned by this run' using errcode = '55000';
	end if;
	update public.qorpera_run_operation_receipts
	set status = 'completed', result = p_result,
		output_snapshot_id = p_output_snapshot_id, proposal_id = p_proposal_id,
		completed_at = statement_timestamp()
	where id = p_receipt_id returning * into v_receipt;
	return jsonb_build_object('state', 'completed', 'receipt_id', v_receipt.id, 'result', v_receipt.result);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_runner_job(uuid,text,uuid,text,jsonb)'::regprocedure), 'sha256'), 'hex') <> '93a255e77f96b07eac0d4dba976314c3defcf0202777ae11c8e65d1d85c43e0b' then
		raise exception 'Reviewed function definition changed: qorpera_complete_runner_job';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_runner_job(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
begin
	if auth.role() <> 'service_role'
		or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 65536
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job completion is invalid' using errcode = '42501';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id for update;
	if found and v_job.status = 'completed'
		and v_job.terminal_lease_token_sha256 = p_lease_token_sha256 and v_job.result = p_result then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if not found or v_job.status <> 'leased' or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_runner_jobs
	set status = 'completed', terminal_lease_token_sha256 = lease_token_sha256,
		lease_token_sha256 = null, lease_expires_at = null,
		result = p_result, last_error = null, finished_at = statement_timestamp()
	where id = p_job_id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_completed',
		jsonb_build_object('attempt_count', v_job.attempt_count), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_runner_job_before_path_runtime(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure), 'sha256'), 'hex') <> '0ac6731f5d48ab4e3959765aa8ce8228808142b936335f5174e1498310ba4d05' then
		raise exception 'Reviewed function definition changed: qorpera_complete_runner_job_before_path_runtime';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_runner_job_before_path_runtime(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_client_artifact_index_id uuid, p_client_substrate_version_id uuid, p_output_snapshot_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
	v_existing public.qorpera_execution_run_results%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_publication public.qorpera_company_snapshot_publications%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_transcript_end_sequence bigint := 0;
	v_result_sha256 text;
	v_head_restricted_content_sha256 text;
	v_disposition text := 'unchanged';
	v_reason text;
	v_title text;
	v_completed jsonb;
	v_completed_inputs integer;
	v_review_assignment public.qorpera_company_proposal_review_assignments%rowtype;
	v_review jsonb;
	v_review_decision text;
	v_review_comment text;
	v_review_comment_id uuid;
begin
	if auth.role() <> 'service_role' or p_client_artifact_index_id is null
		or p_client_substrate_version_id is null or p_result is null
		or jsonb_typeof(p_result) <> 'object'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job completion is invalid' using errcode = '42501';
	end if;
	v_result_sha256 := encode(extensions.digest(convert_to(p_result::text, 'utf8'), 'sha256'), 'hex');
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select result.* into v_existing from public.qorpera_execution_run_results as result
	where result.job_id = v_job.id;
	if found then
		if v_job.status <> 'completed' or v_job.terminal_lease_token_sha256 <> p_lease_token_sha256
			or v_existing.runner_id <> p_runner_id
			or v_existing.output_snapshot_id is distinct from p_output_snapshot_id
			or v_existing.client_artifact_index_id <> p_client_artifact_index_id
			or v_existing.client_substrate_version_id <> p_client_substrate_version_id
			or v_existing.result_sha256 <> v_result_sha256 then
			raise exception 'runner completion replay differs from the stored result' using errcode = '23505';
		end if;
		return public.qorpera_runner_job_json(v_job);
	end if;
	if v_job.status <> 'leased' or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'runner execution authority is unavailable' using errcode = '42501';
	end if;
	if v_run.source_kind = 'proposal_review' then
		select review.* into v_review_assignment
		from public.qorpera_company_proposal_review_assignments as review
		where review.run_id = v_run.id for update;
		select proposal.* into v_proposal
		from public.qorpera_company_proposals as proposal
		where proposal.id = v_review_assignment.proposal_id for share;
		v_review := p_result -> 'review';
		v_review_decision := v_review ->> 'decision';
		v_review_comment := btrim(v_review ->> 'comment');
		if v_review_assignment.id is null or v_review_assignment.status <> 'running'
			or v_proposal.status <> 'open' or v_review_assignment.proposal_revision <> (
				select max(revision.revision)
				from public.qorpera_company_proposal_revisions as revision
				where revision.proposal_id = v_review_assignment.proposal_id
			)
			or p_output_snapshot_id is not null
			or exists (
				select 1 from public.qorpera_runner_job_artifacts as artifact
				where artifact.job_id = v_job.id
			)
			or jsonb_typeof(v_review) <> 'object'
			or v_review_decision is null or v_review_decision not in ('approve', 'request_changes')
			or coalesce(char_length(v_review_comment), 0) not between 1 and 16384
			or exists (
				select 1 from jsonb_object_keys(v_review) as field(key)
				where field.key not in ('decision', 'comment')
			) then
			raise exception 'proposal review result is invalid' using errcode = '22023';
		end if;
	end if;
	select assignment.* into v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = v_job.client_lease_id and assignment.job_id = v_job.id
		and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
		and assignment.status = 'accepted' for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner assignment is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if exists (
		select 1 from public.qorpera_runner_model_requests as request
		where request.job_id = v_job.id and request.status = 'reserved'
	) or exists (
		select 1 from public.qorpera_run_operation_receipts as receipt
		where receipt.run_id = v_run.id and receipt.status in ('executing', 'ambiguous')
	) then
		raise exception 'runner execution has unresolved work' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_run_operation_receipts as receipt
		left join public.qorpera_company_proposals as proposal on proposal.id = receipt.proposal_id
		where receipt.run_id = v_run.id and receipt.status = 'completed'
			and receipt.requires_company_revision
			and coalesce(receipt.output_snapshot_id, proposal.proposal_snapshot_id)
				is distinct from p_output_snapshot_id
	) then
		raise exception 'runner completion omitted an operation-bound Company File candidate' using errcode = '55000';
	end if;
	if v_run.session_id is not null then
		select max(event.sequence) into v_transcript_end_sequence
		from public.qorpera_session_events as event
		where event.session_id = v_run.session_id and event.execution_kind = 'run'
			and event.execution_id = v_run.id and event.runner_assignment_id = v_assignment.id;
		if v_transcript_end_sequence is null
			or v_transcript_end_sequence <= v_run.transcript_start_sequence
			or not exists (
				select 1
				from public.qorpera_session_events as event
				cross join lateral jsonb_array_elements(case
					when jsonb_typeof(event.body #> '{entry,message,content}') = 'array'
						then event.body #> '{entry,message,content}'
					else '[]'::jsonb
				end) as part(value)
				where event.session_id = v_run.session_id
					and event.sequence > v_run.transcript_start_sequence
					and event.sequence <= v_transcript_end_sequence
					and event.execution_kind = 'run'
					and event.execution_id = v_run.id
					and event.runner_assignment_id = v_assignment.id
					and event.event_type = 'message'
					and event.body #>> '{entry,message,role}' = 'assistant'
					and part.value ->> 'type' = 'text'
					and char_length(btrim(part.value ->> 'text')) > 0
			)
			or exists (
				select 1 from public.qorpera_session_events as event
				where event.session_id = v_run.session_id
					and event.sequence > v_run.transcript_start_sequence
					and event.sequence <= v_transcript_end_sequence
					and (
						event.execution_kind is distinct from 'run'
						or event.execution_id is distinct from v_run.id
						or event.runner_assignment_id is distinct from v_assignment.id
					)
			) then
			raise exception 'runner transcript boundary is invalid' using errcode = '55000';
		end if;
	else
		v_transcript_end_sequence := 0;
	end if;

	if p_output_snapshot_id is not null then
		select file.* into strict v_file from public.qorpera_company_files as file
		where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for update;
		select snapshot.* into v_snapshot
		from public.qorpera_company_snapshots as snapshot
		where snapshot.id = p_output_snapshot_id and snapshot.profile_id = v_run.profile_id
			and snapshot.environment_id = v_run.environment_id
			and snapshot.workspace_id = v_file.canonical_workspace_id;
		select publication.* into v_publication
		from public.qorpera_company_snapshot_publications as publication
		where publication.snapshot_id = p_output_snapshot_id;
		if v_snapshot.id is null or v_publication.snapshot_id is null
			or v_snapshot.parent_snapshot_id is distinct from v_run.company_snapshot_id
			or v_publication.expected_head_snapshot_id is distinct from v_run.company_snapshot_id
			or v_publication.status <> 'prepared'
			or v_publication.restricted_content_sha256 is null
			or not exists (
				select 1 from public.qorpera_runner_company_revision_outputs as output
				where output.snapshot_id = v_snapshot.id and output.run_id = v_run.id
					and output.job_id = v_job.id and output.assignment_id = v_assignment.id
			)
			or not public.qorpera_object_root_has_current_proof('company_snapshot', v_snapshot.id) then
			raise exception 'runner Company File output is not durably verified' using errcode = '55000';
		end if;
		select publication.restricted_content_sha256 into v_head_restricted_content_sha256
		from public.qorpera_company_snapshot_publications as publication
		where publication.snapshot_id = v_file.head_snapshot_id;
		if v_run.publication_mode = 'automatic'
			and v_file.head_snapshot_id is not distinct from v_run.company_snapshot_id
			and v_publication.restricted_content_sha256 is not distinct from v_head_restricted_content_sha256 then
			update public.qorpera_company_snapshot_publications
			set status = 'published', published_at = statement_timestamp()
			where snapshot_id = v_snapshot.id;
			update public.qorpera_company_workspaces
			set head_snapshot_id = v_snapshot.id, updated_at = statement_timestamp()
			where id = v_file.canonical_workspace_id;
			update public.qorpera_company_files
			set head_snapshot_id = v_snapshot.id, state = 'ready',
				logical_bytes = v_snapshot.total_bytes, updated_at = statement_timestamp()
			where environment_id = v_file.environment_id;
			v_disposition := 'published';
		else
			v_reason := case
				when v_run.publication_mode = 'review' then 'policy'
				when v_publication.restricted_content_sha256 is distinct from v_head_restricted_content_sha256 then 'authority'
				else 'conflict'
			end;
			select left('Review ' || coalesce(staff.display_name, 'agent') || ' output', 256)
			into v_title from public.qorpera_profile_staff as staff
			where staff.profile_id = v_run.profile_id and staff.staff_agent_id = v_run.staff_agent_id;
			insert into public.qorpera_company_proposals (
				profile_id, environment_id, client_proposal_id, base_snapshot_id,
				proposal_snapshot_id, execution_kind, execution_id, execution_claimant_id,
				session_id, trail_end_sequence, reason, policy_key, title,
				reviewer_staff_ids, created_by_user_id
			) values (
				v_run.profile_id, v_run.environment_id, v_run.id, v_run.company_snapshot_id,
				v_snapshot.id, 'run', v_run.id, v_run.id, v_run.session_id,
				v_transcript_end_sequence, v_reason,
				case when v_reason = 'policy' then v_run.review_policy_key else null end,
				coalesce(v_title, 'Review agent output'),
				case when v_reason = 'policy' then v_run.reviewer_staff_ids else '{}'::uuid[] end,
				v_run.created_by_user_id
			)
			on conflict (profile_id, client_proposal_id) do nothing
			returning * into v_proposal;
			if not found then
				select proposal.* into strict v_proposal
				from public.qorpera_company_proposals as proposal
				where proposal.profile_id = v_run.profile_id and proposal.client_proposal_id = v_run.id;
				if v_proposal.proposal_snapshot_id <> v_snapshot.id
					or v_proposal.execution_kind <> 'run' or v_proposal.execution_id <> v_run.id then
					raise exception 'runner proposal id is already bound to different output' using errcode = '23505';
				end if;
			end if;
			v_disposition := 'review_pending';
		end if;
	end if;

	v_completed := public.qorpera_complete_runner_job_v4(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_client_artifact_index_id, p_client_substrate_version_id, p_result
	);
	update public.qorpera_runner_jobs
	set result = result || jsonb_build_object(
		'company_file', jsonb_build_object(
			'disposition', v_disposition,
			'output_snapshot_id', p_output_snapshot_id,
			'proposal_id', case when v_disposition = 'review_pending' then v_proposal.id else null end
		)
	)
	where id = v_job.id
	returning * into v_job;
	if pg_column_size(v_job.result) > 65536 then
		raise exception 'runner completion result is too large' using errcode = '22023';
	end if;
	insert into public.qorpera_execution_run_results (
		run_id, job_id, assignment_id, runner_id, transcript_end_sequence,
		company_disposition, output_snapshot_id, proposal_id,
		client_artifact_index_id, client_substrate_version_id, result_sha256
	) values (
		v_run.id, v_job.id, v_assignment.id, p_runner_id, v_transcript_end_sequence,
		v_disposition, p_output_snapshot_id,
		case when v_disposition = 'review_pending' then v_proposal.id else null end,
		p_client_artifact_index_id, p_client_substrate_version_id, v_result_sha256
	);
	if v_run.source_kind = 'proposal_review' then
		insert into public.qorpera_company_proposal_comments (
			proposal_id, client_comment_id, body, author_staff_agent_id
		) values (
			v_review_assignment.proposal_id, v_run.id, v_review_comment, v_run.staff_agent_id
		)
		returning id into v_review_comment_id;
		update public.qorpera_company_proposal_review_assignments
		set status = case v_review_decision
				when 'approve' then 'approved'
				else 'changes_requested'
			end,
			comment_id = v_review_comment_id,
			completed_at = statement_timestamp()
		where id = v_review_assignment.id and status = 'running';
	end if;
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs
		set completed_at = coalesce(completed_at, statement_timestamp())
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		get diagnostics v_completed_inputs = row_count;
		if v_completed_inputs <> cardinality(v_run.input_ids) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner session inputs changed before completion', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
	end if;
	if v_disposition = 'review_pending' then
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'review_pending', jsonb_build_object('proposal_id', v_proposal.id));
	end if;
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_runner_job_v2(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure), 'sha256'), 'hex') <> 'f6871a7aecfe07f1364951760ab13e095b65cf9431c35a551ab0a5f1ffb34d9a' then
		raise exception 'Reviewed function definition changed: qorpera_complete_runner_job_v2';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_runner_job_v2(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_client_artifact_index_id uuid, p_client_substrate_version_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_source public.qorpera_company_substrate_versions%rowtype;
	v_existing_index public.qorpera_artifact_indexes%rowtype;
	v_index public.qorpera_artifact_indexes%rowtype;
	v_existing_version public.qorpera_company_substrate_versions%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_artifact_ids uuid[];
	v_output_artifact_count integer;
	v_total_artifact_count integer;
	v_total_bytes bigint;
	v_index_sha256 text;
	v_version_sha256 text;
	v_result jsonb;
begin
	if auth.role() <> 'service_role'
		or p_client_artifact_index_id is null
		or p_client_substrate_version_id is null
		or p_result is null
		or jsonb_typeof(p_result) <> 'object'
		or p_result ? 'output_substrate'
		or pg_column_size(p_result) > 64512
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job completion is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
	for update;
	if found and v_job.status = 'completed' and v_job.terminal_lease_token_sha256 = p_lease_token_sha256 then
		if (v_job.result - 'output_substrate') <> p_result then
			raise exception 'runner completion replay differs from the stored result' using errcode = '23505';
		end if;
		if v_job.output_artifact_count > 0 and not exists (
			select 1
			from public.qorpera_artifact_indexes as artifact_index
			join public.qorpera_company_substrate_versions as version
				on version.id = v_job.output_substrate_version_id
			where artifact_index.id = v_job.output_artifact_index_id
				and artifact_index.client_index_id = p_client_artifact_index_id
				and version.client_version_id = p_client_substrate_version_id
				and version.artifact_index_id = artifact_index.id
		) then
			raise exception 'runner completion replay uses different publication ids' using errcode = '23505';
		end if;
		return public.qorpera_runner_job_json(v_job);
	end if;
	if not found or v_job.status <> 'leased'
		or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select version.* into strict v_source
	from public.qorpera_company_substrate_versions as version
	where version.id = v_job.substrate_version_id;
	if v_source.profile_id <> v_job.profile_id or v_source.environment_id <> v_job.environment_id then
		raise exception 'runner source substrate is inconsistent' using errcode = '55000';
	end if;
	select count(*) into v_output_artifact_count
	from public.qorpera_runner_job_artifacts as job_artifact
	where job_artifact.job_id = v_job.id;
	if v_output_artifact_count = 0 then
		v_result := p_result || jsonb_build_object('output_substrate', null);
	else
		select coalesce(array_agg(source.artifact_id order by source.artifact_id), '{}'::uuid[])
		into v_artifact_ids
		from (
			select entry.artifact_id
			from public.qorpera_artifact_index_entries as entry
			where entry.index_id = v_source.artifact_index_id
			union
			select job_artifact.artifact_id
			from public.qorpera_runner_job_artifacts as job_artifact
			where job_artifact.job_id = v_job.id
		) as source;
		v_total_artifact_count := cardinality(v_artifact_ids);
		if v_total_artifact_count > 5000 then
			raise exception 'runner output substrate has too many artifacts' using errcode = '55000';
		end if;
		select coalesce(sum(artifact.bytes), 0) into v_total_bytes
		from public.qorpera_artifacts as artifact
		where artifact.id = any(v_artifact_ids)
			and artifact.profile_id = v_job.profile_id
			and artifact.environment_id = v_job.environment_id;
		if (
			select count(*)
			from public.qorpera_artifacts as artifact
			where artifact.id = any(v_artifact_ids)
				and artifact.profile_id = v_job.profile_id
				and artifact.environment_id = v_job.environment_id
		) <> v_total_artifact_count then
			raise exception 'runner output substrate contains unavailable artifacts' using errcode = '55000';
		end if;
		v_index_sha256 := encode(
			extensions.digest(
				convert_to(
					jsonb_build_object(
						'contract_version', 1,
						'profile_id', v_job.profile_id,
						'environment_id', v_job.environment_id,
						'artifact_ids', to_jsonb(v_artifact_ids)
					)::text,
					'utf8'
				),
				'sha256'
			),
			'hex'
		);
		select artifact_index.* into v_existing_index
		from public.qorpera_artifact_indexes as artifact_index
		where artifact_index.profile_id = v_job.profile_id
			and artifact_index.client_index_id = p_client_artifact_index_id;
		if found then
			if v_existing_index.environment_id <> v_job.environment_id
				or v_existing_index.content_sha256 <> v_index_sha256
				or v_existing_index.artifact_count <> v_total_artifact_count
				or v_existing_index.total_bytes <> v_total_bytes then
				raise exception 'runner output artifact index id is already bound to different content' using errcode = '23505';
			end if;
			v_index := v_existing_index;
		else
			insert into public.qorpera_artifact_indexes (
				profile_id, environment_id, client_index_id, contract_version,
				content_sha256, artifact_count, total_bytes, created_by_user_id
			) values (
				v_job.profile_id, v_job.environment_id, p_client_artifact_index_id, 1,
				v_index_sha256, v_total_artifact_count, v_total_bytes, v_job.created_by_user_id
			) returning * into v_index;
			insert into public.qorpera_artifact_index_entries (index_id, ordinal, artifact_id)
			select v_index.id, (row_number() over (order by artifact_id))::integer, artifact_id
			from unnest(v_artifact_ids) as artifact_id;
		end if;
		v_version_sha256 := encode(
			extensions.digest(
				convert_to(
					jsonb_build_object(
						'contract_version', v_source.contract_version,
						'profile_id', v_job.profile_id,
						'environment_id', v_job.environment_id,
						'company_snapshot_id', v_source.company_snapshot_id,
						'operation_sequence', v_source.operation_sequence,
						'artifact_manifest_sha256', v_index.content_sha256
					)::text,
					'utf8'
				),
				'sha256'
			),
			'hex'
		);
		select version.* into v_existing_version
		from public.qorpera_company_substrate_versions as version
		where version.profile_id = v_job.profile_id
			and version.client_version_id = p_client_substrate_version_id;
		if found then
			if v_existing_version.environment_id <> v_job.environment_id
				or v_existing_version.company_snapshot_id <> v_source.company_snapshot_id
				or v_existing_version.contract_version <> v_source.contract_version
				or v_existing_version.operation_sequence <> v_source.operation_sequence
				or v_existing_version.operation_count <> v_source.operation_count
				or v_existing_version.artifact_index_id <> v_index.id
				or v_existing_version.content_sha256 <> v_version_sha256 then
				raise exception 'runner output substrate id is already bound to different content' using errcode = '23505';
			end if;
			v_version := v_existing_version;
		else
			insert into public.qorpera_company_substrate_versions (
				profile_id, environment_id, company_snapshot_id, client_version_id,
				contract_version, operation_sequence, operation_count,
				artifact_index_id, artifact_manifest_sha256, content_sha256,
				created_by_user_id
			) values (
				v_job.profile_id, v_job.environment_id, v_source.company_snapshot_id,
				p_client_substrate_version_id, v_source.contract_version,
				v_source.operation_sequence, v_source.operation_count,
				v_index.id, v_index.content_sha256, v_version_sha256,
				v_job.created_by_user_id
			) returning * into v_version;
		end if;
		v_result := p_result || jsonb_build_object(
			'output_substrate', jsonb_build_object(
				'source_substrate_version_id', v_source.id,
				'artifact_index_id', v_index.id,
				'substrate_version_id', v_version.id,
				'output_artifact_count', v_output_artifact_count,
				'total_artifact_count', v_total_artifact_count
			)
		);
	end if;
	if pg_column_size(v_result) > 65536 then
		raise exception 'runner completion result is too large' using errcode = '22023';
	end if;
	update public.qorpera_runner_jobs
	set status = 'completed', terminal_lease_token_sha256 = lease_token_sha256,
		lease_token_sha256 = null, lease_expires_at = null,
		result = v_result, last_error = null, finished_at = statement_timestamp(),
		output_artifact_count = v_output_artifact_count,
		output_artifact_index_id = case when v_output_artifact_count > 0 then v_index.id else null end,
		output_substrate_version_id = case when v_output_artifact_count > 0 then v_version.id else null end
	where id = p_job_id
	returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_completed',
		jsonb_build_object(
			'attempt_count', v_job.attempt_count,
			'output_artifact_count', v_job.output_artifact_count,
			'output_artifact_index_id', v_job.output_artifact_index_id,
			'output_substrate_version_id', v_job.output_substrate_version_id
		),
		null
	);
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_runner_job_v5(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure), 'sha256'), 'hex') <> 'd493e58de3458e245fe4c64bb4eaeb5b122890c71047d93178107bdbb6967896' then
		raise exception 'Reviewed function definition changed: qorpera_complete_runner_job_v5';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_runner_job_v5(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_client_artifact_index_id uuid, p_client_substrate_version_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_result jsonb;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if v_job.run_id is not null then
		select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if exists (
			select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = v_run.id and receipt.status in ('executing', 'ambiguous')
		) then
			raise exception 'runner execution has an unresolved operation' using errcode = '55000';
		end if;
		if v_run.session_id is not null and not exists (
			select 1 from public.qorpera_session_events as event
			where event.session_id = v_run.session_id and event.execution_kind = 'run'
				and event.execution_id = v_run.id and event.sequence > v_run.transcript_start_sequence
		) then
			raise exception 'runner execution has no durable transcript output' using errcode = '55000';
		end if;
	end if;
	v_result := public.qorpera_complete_runner_job_v4(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_client_artifact_index_id, p_client_substrate_version_id, p_result
	);
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs
		set completed_at = coalesce(completed_at, statement_timestamp())
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		if exists (
			select 1 from unnest(v_run.input_ids) as expected(input_id)
			where not exists (
				select 1 from public.qorpera_session_inputs as input
				where input.id = expected.input_id and input.session_id = v_run.session_id
					and input.execution_run_id = v_run.id and input.completed_at is not null
			)
		) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner session inputs changed before completion', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
	end if;
	return v_result;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure), 'sha256'), 'hex') <> '456ee199e6edf4b2d3a57d43d5820b1836bf1307aec3aee9ae84e4b6803f4986' then
		raise exception 'Reviewed function definition changed: qorpera_complete_runner_job_v6';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_complete_runner_job_v6(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_client_artifact_index_id uuid, p_client_substrate_version_id uuid, p_output_snapshot_id uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '25s'
 SET statement_timeout TO '25s'
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_execution_run_results%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_binding jsonb; v_actor jsonb; v_receipt jsonb; v_hash text; v_mode integer; v_started jsonb;
	v_last_snapshot uuid; v_applied jsonb; v_proposed jsonb; v_count integer; v_final uuid;
	v_transcript_end bigint := 0; v_disposition text := 'unchanged'; v_completed_inputs integer;
begin
	if auth.role() is distinct from 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id,p_session_token_sha256) then
		raise exception 'Runner completion authority is unavailable' using errcode = '42501'; end if;
	select * into v_job from public.qorpera_runner_jobs where id = p_job_id and runner_id = p_runner_id for update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	select path_gateway_version into v_mode from public.qorpera_company_files where environment_id = v_job.environment_id;
	if v_mode is distinct from 1 then
		if p_result ->> 'runtime' = 'company-path-v1' then
			raise exception 'Company runtime selection changed' using errcode = '42501'; end if;
		return public.qorpera_complete_runner_job_before_path_runtime(p_runner_id,p_session_token_sha256,
			p_job_id,p_lease_token_sha256,p_client_artifact_index_id,p_client_substrate_version_id,p_output_snapshot_id,p_result);
	end if;
	if p_output_snapshot_id is not null or p_client_artifact_index_id is null or p_client_substrate_version_id is null
		or jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 49152
		or p_result ->> 'schema' is distinct from 'qorpera.runner-result/v1'
		or p_result ->> 'runtime' is distinct from 'company-path-v1'
		or p_result ->> 'backend' is distinct from 'native-company-runtime'
		or p_result - array['schema','runtime','backend','native_lease_id','substrate_version_id',
			'backend_result','output_count','output_bytes','publication','usage'] <> '{}'::jsonb
		or p_result -> 'publication' is distinct from 'null'::jsonb
		or p_result -> 'output_count' is distinct from '0'::jsonb
		or p_result -> 'output_bytes' is distinct from '0'::jsonb
		or p_result ->> 'substrate_version_id' is distinct from v_job.substrate_version_id::text then
		raise exception 'Governed completion cannot publish a whole Company File or artifacts' using errcode = '22023'; end if;
	v_hash := encode(extensions.digest(convert_to(p_result::text,'utf8'),'sha256'),'hex');
	select * into v_existing from public.qorpera_execution_run_results where job_id = v_job.id;
	if found then
		if v_job.status <> 'completed' or v_job.terminal_lease_token_sha256 is distinct from p_lease_token_sha256
			or v_existing.runner_id <> p_runner_id or v_existing.result_sha256 <> v_hash
			or v_existing.client_artifact_index_id <> p_client_artifact_index_id
			or v_existing.client_substrate_version_id <> p_client_substrate_version_id then
			raise exception 'Runner completion replay differs from its receipt' using errcode = '23505'; end if;
		-- Receipt replay conveys no new read, write, model call or public send.
		return public.qorpera_runner_job_json(v_job);
	end if;
	v_job := public.qorpera_runner_broker_locked_job(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256);
	select * into strict v_run from public.qorpera_execution_runs where id = v_job.run_id;
	select * into v_lease from public.qorpera_native_provider_connection_leases
	where id = (p_result ->> 'native_lease_id')::uuid and run_id = v_run.id and job_id = v_job.id;
	if not found then raise exception 'Native completion authority is unavailable' using errcode = '42501'; end if;
	v_binding := jsonb_build_object('leaseId',v_lease.id,'runId',v_run.id,'jobId',v_job.id,'runnerId',p_runner_id,
		'assignmentId',v_job.client_lease_id,'credentialCapsuleId',v_lease.credential_capsule_id,
		'computeIdentityId',v_run.compute_identity_id,'provider',v_run.model_provider,'nativeHarness','codex-cli','model',v_run.model_id);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,v_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	select payload into v_started from public.qorpera_execution_run_events where run_id = v_run.id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1'
	order by id desc limit 1;
	if not found or v_started ->> 'runId' is distinct from v_run.id::text
		or v_started ->> 'jobId' is distinct from v_job.id::text
		or v_started ->> 'leaseId' is distinct from v_lease.id::text
		or coalesce(v_started ->> 'binarySha256','') !~ '^[0-9a-f]{64}$' then
		raise exception 'Native execution has no matching durable admission' using errcode = '55000'; end if;
	if exists(select 1 from public.qorpera_runner_model_requests where job_id = v_job.id and status = 'reserved')
		or exists(select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id and status in ('executing','ambiguous'))
		or exists(select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then
		raise exception 'Governed execution has unresolved or ungoverned work' using errcode = '55000'; end if;
	-- Every required effect already has its exact, atomic path revision or
	-- proposal. Different operations need not (and usually will not) share a head.
	if exists(select 1 from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id
		and receipt.status = 'completed' and (receipt.requires_company_revision or receipt.output_snapshot_id is not null
			or receipt.company_path_proposal_id is not null or receipt.proposal_id is not null) and not (
			exists(select 1 from public.qorpera_company_path_revisions revision
				where revision.receipt_id = receipt.id and revision.run_id = v_run.id
					and revision.environment_id = v_run.environment_id and revision.snapshot_id = receipt.output_snapshot_id)
			or exists(select 1 from public.qorpera_company_path_proposals proposal
				where proposal.receipt_id = receipt.id and proposal.run_id = v_run.id
					and proposal.environment_id = v_run.environment_id and proposal.id = receipt.company_path_proposal_id)
		)) then raise exception 'Governed completion omitted a path effect receipt' using errcode = '55000'; end if;
	v_receipt := p_result -> 'backend_result';
	select count(*),max(delivery.event_id::text) filter(where delivery.phase = 'final'),coalesce(max(event.sequence),0)
	into v_count,v_final,v_transcript_end from public.qorpera_agent_sends delivery
	join public.qorpera_session_events event on event.event_id = delivery.event_id
	where delivery.run_id = v_run.id and delivery.assignment_id = v_job.client_lease_id;
	-- Server-owned wake policy decides whether silence is a valid terminal result
	-- (contract 6.3, 7.2); a silent completion invents no transcript event.
	perform public.qorpera_assert_wake_completion(v_run.id);
	if v_count = 0 then v_transcript_end := v_run.transcript_start_sequence; end if;
	if jsonb_typeof(v_receipt) is distinct from 'object'
		or v_receipt - array['schema','run_id','message_count','final_message_id','provider_session_id'] <> '{}'::jsonb
		or v_receipt ->> 'schema' is distinct from 'qorpera.native-harness-result/v2'
		or v_receipt ->> 'run_id' is distinct from v_run.id::text
		or v_receipt -> 'message_count' is distinct from to_jsonb(v_count)
		or v_receipt -> 'final_message_id' is distinct from coalesce(to_jsonb(v_final),'null'::jsonb)
		or (v_run.session_id is null and v_count <> 0)
		or (v_count > 0 and (v_final is null or v_transcript_end <= v_run.transcript_start_sequence))
		or jsonb_typeof(v_receipt -> 'provider_session_id') is distinct from 'string'
		or char_length(btrim(v_receipt ->> 'provider_session_id')) not between 1 and 1024 then
		raise exception 'Native completion does not match durable public delivery' using errcode = '55000'; end if;
	perform public.qorpera_bind_execution_provider_session(p_runner_id,p_session_token_sha256,p_job_id,
		p_lease_token_sha256,v_receipt ->> 'provider_session_id',null);
	select coalesce(jsonb_agg(receipt.id order by receipt.completed_at,receipt.id),'[]'::jsonb) into v_applied
	from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id and receipt.output_snapshot_id is not null;
	select coalesce(jsonb_agg(receipt.id order by receipt.completed_at,receipt.id),'[]'::jsonb) into v_proposed
	from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id and receipt.company_path_proposal_id is not null;
	select receipt.output_snapshot_id into v_last_snapshot from public.qorpera_run_operation_receipts receipt
	where receipt.run_id = v_run.id and receipt.output_snapshot_id is not null order by receipt.completed_at desc,receipt.id desc limit 1;
	if v_last_snapshot is not null then v_disposition := 'published'; end if;
	-- Uses the existing job/usage bookkeeping and final-send trigger. Terminal
	-- job cleanup releases native authority in this same database transaction.
	perform public.qorpera_complete_runner_job_v4(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256,
		p_client_artifact_index_id,p_client_substrate_version_id,p_result);
	update public.qorpera_runner_jobs set result = result || jsonb_build_object('company_file',jsonb_build_object(
		'runtime','company-path-v1','disposition',v_disposition,'output_snapshot_id',v_last_snapshot,'proposal_id',null,
		'native_binary_sha256',v_started ->> 'binarySha256',
		'applied_receipt_ids',v_applied,'proposal_receipt_ids',v_proposed)) where id = v_job.id returning * into v_job;
	if pg_column_size(v_job.result) > 65536 then raise exception 'Runner completion receipt is too large' using errcode = '54000'; end if;
	insert into public.qorpera_execution_run_results(run_id,job_id,assignment_id,runner_id,transcript_end_sequence,
		company_disposition,output_snapshot_id,proposal_id,client_artifact_index_id,client_substrate_version_id,result_sha256)
	values(v_run.id,v_job.id,v_job.client_lease_id,p_runner_id,v_transcript_end,v_disposition,v_last_snapshot,null,
		p_client_artifact_index_id,p_client_substrate_version_id,v_hash);
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs set completed_at = clock_timestamp()
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		get diagnostics v_completed_inputs = row_count;
		if v_completed_inputs <> cardinality(v_run.input_ids) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Runner session inputs changed before completion', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	end if;
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_configure_runtime_node(jsonb,bigint)'::regprocedure), 'sha256'), 'hex') <> '6ccce1b5aaf963606b4669cadd9cae72ae2a7d6004e39dffa297e105344a1180' then
		raise exception 'Reviewed function definition changed: qorpera_configure_runtime_node';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_configure_runtime_node(p_policy jsonb, p_expected_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_node public.qorpera_runtime_nodes%rowtype; v_id uuid; v_cpu bigint; v_memory bigint;
begin
 if auth.role() is distinct from 'service_role' or p_expected_version is null or p_expected_version not between 0 and 9007199254740990
  or jsonb_typeof(p_policy) is distinct from 'object'
  or p_policy-array['schema','nodeId','machineIdSha256','label','cpuMillis','memoryBytes','headroomCpuMillis','headroomMemoryBytes','standardCpuMillis','standardMemoryBytes','enabled']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_policy))<>11
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-policy/v1'
  or jsonb_typeof(p_policy->'enabled') is distinct from 'boolean' then
  raise exception 'Invalid node policy' using errcode='42501'; end if;
 begin
  v_id:=(p_policy->>'nodeId')::uuid;
  if v_id is null or coalesce(p_policy->>'machineIdSha256','') !~ '^[0-9a-f]{64}$'
   or coalesce(p_policy->>'label','') !~ '^[a-z][a-z0-9-]{0,62}$' then raise check_violation; end if;
  if exists(select 1 from unnest(array['cpuMillis','memoryBytes','headroomCpuMillis','headroomMemoryBytes','standardCpuMillis','standardMemoryBytes']) k
   where jsonb_typeof(p_policy->k) is distinct from 'number' or p_policy->>k !~ '^(0|[1-9][0-9]*)$') then raise check_violation; end if;
 exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node policy' using errcode='42501'; end;
 -- Serialize first registration as well as later edits; no company lock is
 -- taken from this node-only configuration path.
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||v_id::text,0));
 select * into v_node from public.qorpera_runtime_nodes where id=v_id for update;
 if (found and v_node.version<>p_expected_version) or (not found and p_expected_version<>0) then
  raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node policy version changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 if v_node.id is not null and v_node.machine_id_sha256<>p_policy->>'machineIdSha256' then
  raise exception 'Node host identity is immutable' using errcode='42501'; end if;
 select coalesce(sum(cpu_millis),0),coalesce(sum(memory_bytes),0) into v_cpu,v_memory
  from public.qorpera_runtime_node_demands where node_id=v_id and reserved_at is not null and released_at is null;
 begin
  if v_cpu>(p_policy->>'cpuMillis')::bigint-(p_policy->>'headroomCpuMillis')::bigint
   or v_memory>(p_policy->>'memoryBytes')::bigint-(p_policy->>'headroomMemoryBytes')::bigint then
   raise exception 'Node policy would discard occupied capacity' using errcode='55000'; end if;
  insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,
   headroom_cpu_millis,headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled)
  values(v_id,p_policy->>'machineIdSha256',p_policy->>'label',p_expected_version+1,(p_policy->>'cpuMillis')::bigint,
   (p_policy->>'memoryBytes')::bigint,(p_policy->>'headroomCpuMillis')::bigint,(p_policy->>'headroomMemoryBytes')::bigint,
   (p_policy->>'standardCpuMillis')::bigint,(p_policy->>'standardMemoryBytes')::bigint,(p_policy->>'enabled')::boolean)
  on conflict(id) do update set label=excluded.label,version=excluded.version,cpu_millis=excluded.cpu_millis,
   memory_bytes=excluded.memory_bytes,headroom_cpu_millis=excluded.headroom_cpu_millis,headroom_memory_bytes=excluded.headroom_memory_bytes,
   standard_cpu_millis=excluded.standard_cpu_millis,standard_memory_bytes=excluded.standard_memory_bytes,
   enabled=excluded.enabled,updated_at=clock_timestamp() returning * into v_node;
 exception when numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node policy limits' using errcode='42501'; end;
 insert into public.qorpera_runtime_node_policies(node_id,version,policy) values(v_id,v_node.version,p_policy);
 return jsonb_build_object('nodeId',v_id,'version',v_node.version);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_confirm_profile_object_deletion(uuid,text,bigint,text,uuid)'::regprocedure), 'sha256'), 'hex') <> 'aaeaa304e5c2be5a62a67d5ff4d3c978b7faa1e3baa45797836df67f4d7b5593' then
		raise exception 'Reviewed function definition changed: qorpera_confirm_profile_object_deletion';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_confirm_profile_object_deletion(p_profile_id uuid, p_sha256 text, p_bytes bigint, p_backend text, p_lease_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_deleted boolean;
begin
	if auth.role() <> 'service_role'
		or p_backend <> 'nas-object-gateway'
		or p_lease_id is null
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608 then
		raise exception 'object deletion confirmation is invalid' using errcode = '42501';
	end if;
	if not exists (
		select 1
		from public.qorpera_artifact_gc_plans as plan
		join public.qorpera_artifact_gc_plan_entries as entry on entry.plan_id = plan.id
		where plan.profile_id = p_profile_id
			and plan.status = 'deleting'
			and plan.lease_id = p_lease_id
			and plan.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
			and entry.status = 'pending'
	) and not exists (
		select 1
		from public.qorpera_company_object_gc_leases as lease
		join public.qorpera_company_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
	) and not exists (
		select 1
		from public.qorpera_deleted_profile_object_gc_leases as lease
		join public.qorpera_deleted_profile_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
			and entry.backend = p_backend
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'object deletion lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	delete from public.qorpera_profile_objects
	where profile_id = p_profile_id
		and sha256 = p_sha256
		and bytes = p_bytes
		and backend = p_backend;
	v_deleted := found;
	if not v_deleted and exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id and object.sha256 = p_sha256
	) then
		raise exception 'object deletion does not match the catalog' using errcode = '55000';
	end if;
	return v_deleted;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_confirm_profile_object_upload(uuid,text,bigint,text)'::regprocedure), 'sha256'), 'hex') <> 'c4d8d1b687512c55de45e4205b6404ebdc5c9eb98f812fe88f234be2e15ec24e' then
		raise exception 'Reviewed function definition changed: qorpera_confirm_profile_object_upload';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_confirm_profile_object_upload(p_profile_id uuid, p_sha256 text, p_bytes bigint, p_backend text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_object public.qorpera_profile_objects%rowtype;
	v_limit bigint;
	v_used bigint;
begin
	if auth.role() <> 'service_role'
		or p_backend <> 'nas-object-gateway'
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608 then
		raise exception 'object upload confirmation is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'profile object writes are temporarily fenced', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id
	for update;
	if not found then
		raise exception 'company storage authority is unavailable' using errcode = '55000';
	end if;
	select min(file.storage_limit_bytes), max(file.storage_used_bytes)
	into v_limit, v_used
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256
	for update;
	if found and v_object.bytes <> p_bytes then
		raise exception 'object address is already bound to a different size' using errcode = '23505';
	end if;
	if not found and not public.qorpera_profile_storage_is_unlimited(p_profile_id)
		and v_used + p_bytes > v_limit then
		raise exception 'company storage allowance exceeded' using errcode = '23514';
	end if;
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend)
	values (p_profile_id, p_sha256, p_bytes, p_backend)
	on conflict (profile_id, sha256) do update
	set backend = excluded.backend;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256;
	return jsonb_build_object(
		'profile_id', v_object.profile_id,
		'sha256', v_object.sha256,
		'bytes', v_object.bytes,
		'backend', v_object.backend
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_create_runtime_office_viewer(jsonb,bigint,text,jsonb)'::regprocedure), 'sha256'), 'hex') <> '833666a4ac8cafa91ade681f34ea9889e6f10fb0789ed4867dab4409ffc09986' then
		raise exception 'Reviewed function definition changed: qorpera_create_runtime_office_viewer';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_create_runtime_office_viewer(p_binding jsonb, p_epoch bigint, p_mode text DEFAULT 'watch'::text, p_private_challenge jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
	v_viewer public.qorpera_runtime_office_viewers%rowtype; v_token text:=translate(rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),'+/','-_');
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_mode is null or p_mode not in ('watch','control') then
		raise exception 'Member viewer authority required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_binding->>'companyComputerId')::uuid for update;
	if not found then raise exception 'Office unavailable' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=(p_binding->>'screenId')::uuid for update;
	if not found or v_screen.epoch is distinct from p_epoch then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Office screen changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	if p_private_challenge is not null then
		perform public.qorpera_check_runtime_office_private_access(p_private_challenge);
		if p_mode<>'control' or p_private_challenge->>'screenId' is distinct from v_screen.id::text then
			raise exception 'Private screen differs' using errcode='42501'; end if;
	end if;
	v_viewer.id:=extensions.gen_random_uuid(); v_viewer.office_id:=v_office.id; v_viewer.screen_id:=v_screen.id;
	v_viewer.member_id:=auth.uid(); v_viewer.binding:=p_binding; v_viewer.mode:=p_mode;
	v_viewer.membership_version:=coalesce((select version from public.qorpera_runtime_browser_membership_revocations where profile_id=v_office.profile_id and user_id=auth.uid()),0);
	v_viewer.screen_epoch:=v_screen.epoch; v_viewer.privacy_version:=v_office.privacy_version; v_viewer.state:='issued';
	v_viewer.expires_at:=clock_timestamp()+interval '30 seconds'; v_viewer.absolute_deadline:=clock_timestamp()+interval '1 hour';
	v_viewer.capability_sha256:=encode(extensions.digest(v_token,'sha256'),'hex');
	v_viewer.control_lease_id:=case when p_mode='control' then extensions.gen_random_uuid() else null end;
	v_viewer.private_sign_in:=case when p_private_challenge is not null then jsonb_build_object('challengeId',p_private_challenge->'challengeId',
		'profileId',p_private_challenge->'profileId','profileVersion',p_private_challenge->'profileVersion') else null end;
	perform public.qorpera_assert_runtime_office_viewer(v_viewer,v_office,v_screen);
	if (select count(*) from public.qorpera_runtime_office_viewers where office_id=v_office.id and state in ('issued','active') and expires_at>clock_timestamp())>=32
		or (select count(*) from public.qorpera_runtime_office_viewers where office_id=v_office.id and member_id=auth.uid() and issued_at>clock_timestamp()-interval '1 minute')>=60 then
		return '{"state":"refused","reason":"VIEWER_CAPACITY_EXHAUSTED"}'::jsonb; end if;
	if p_mode='control' and exists(select 1 from public.qorpera_runtime_office_viewers where screen_id=v_screen.id and mode='control' and state<>'ended') then
		return '{"state":"refused","reason":"SCREEN_OCCUPIED"}'::jsonb; end if;
	insert into public.qorpera_runtime_office_viewers(id,office_id,screen_id,member_id,membership_version,binding,screen_epoch,
		privacy_version,private_sign_in,mode,control_lease_id,capability_sha256,expires_at,absolute_deadline)
	values(v_viewer.id,v_viewer.office_id,v_viewer.screen_id,v_viewer.member_id,v_viewer.membership_version,v_viewer.binding,v_viewer.screen_epoch,
		v_viewer.privacy_version,v_viewer.private_sign_in,v_viewer.mode,v_viewer.control_lease_id,v_viewer.capability_sha256,v_viewer.expires_at,v_viewer.absolute_deadline)
	returning * into v_viewer;
	return jsonb_build_object('state','issued','capability',v_token,'grant',public.qorpera_runtime_office_viewer_grant(v_viewer));
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,jsonb)'::regprocedure), 'sha256'), 'hex') <> 'dfc378e77651c07fbb40c866b0eb92e1bad2b4efac7f2b8c2dec5ac451e9284c' then
		raise exception 'Reviewed function definition changed: qorpera_enqueue_routine_wake';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_enqueue_routine_wake(p_routine_id uuid, p_expected_version bigint, p_occurrence_id uuid, p_occurrence_key text, p_trigger_id text, p_scheduled_for timestamp with time zone, p_expected_last_scheduled_for timestamp with time zone, p_next_due_at timestamp with time zone, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_routine public.qorpera_cloud_routines%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype;
	v_occurrence public.qorpera_wake_occurrences%rowtype;
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'wake enqueue requires control-plane authority' using errcode = '42501';
	end if;
	if p_occurrence_id is null or p_expected_version is null or p_expected_version < 1
		or octet_length(convert_to(btrim(coalesce(p_occurrence_key, '')), 'utf8')) not between 1 and 256
		or p_occurrence_key ~ E'[\r\n]'
		or octet_length(convert_to(btrim(coalesce(p_trigger_id, '')), 'utf8')) not between 1 and 160
		or p_trigger_id ~ E'[\r\n]'
		or p_scheduled_for is null or p_next_due_at is null or p_next_due_at <= p_scheduled_for
		or p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 8192 then
		raise exception 'wake occurrence is invalid' using errcode = '22023';
	end if;
	perform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_cloud_routines where id=p_routine_id));
	select routine.* into v_routine
	from public.qorpera_cloud_routines as routine where routine.id = p_routine_id
	for share;
	select version.* into v_version
	from public.qorpera_cloud_routine_versions as version
	where version.routine_id = p_routine_id and version.version = p_expected_version;
	if v_routine.id is null or v_routine.status <> 'active'
		or v_routine.current_version <> p_expected_version or v_version.routine_id is null
		or not exists (
			select 1 from jsonb_array_elements(v_version.triggers) as trigger(value)
			where trigger.value ->> 'id' = btrim(p_trigger_id)
				and trigger.value ->> 'kind' = 'schedule'
		) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'wake routine version is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select cursor.* into v_cursor
	from public.qorpera_cloud_routine_schedule_cursors as cursor
	where cursor.routine_id = p_routine_id
		and cursor.routine_version = p_expected_version
		and cursor.trigger_id = btrim(p_trigger_id)
	for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'wake schedule cursor is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select occurrence.* into v_occurrence
	from public.qorpera_wake_occurrences as occurrence
	where occurrence.routine_id = p_routine_id and occurrence.occurrence_key = btrim(p_occurrence_key);
	if found then
		if v_occurrence.id <> p_occurrence_id
			or v_occurrence.routine_version <> p_expected_version
			or v_occurrence.trigger_id <> btrim(p_trigger_id)
			or v_occurrence.scheduled_for <> p_scheduled_for
			or v_occurrence.payload <> p_payload then
			raise exception 'wake occurrence key is already bound to other work' using errcode = '23505';
		end if;
	end if;
	if v_cursor.last_scheduled_for is distinct from p_expected_last_scheduled_for then
		if v_cursor.last_scheduled_for = p_scheduled_for and v_cursor.next_due_at = p_next_due_at
			and v_occurrence.id is not null then
			return jsonb_build_object(
				'occurrence_id', v_occurrence.id, 'status', v_occurrence.status,
				'run_id', v_occurrence.run_id, 'scheduled_for', v_occurrence.scheduled_for
			);
		end if;
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'wake schedule cursor changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if p_expected_last_scheduled_for is not null and p_scheduled_for <= p_expected_last_scheduled_for then
		raise exception 'wake schedule did not advance' using errcode = '22023';
	end if;
	if v_occurrence.id is null then
		insert into public.qorpera_wake_occurrences (
			id, profile_id, environment_id, routine_id, routine_version,
			trigger_id, occurrence_key, scheduled_for, not_before, payload
		) values (
			p_occurrence_id, v_routine.profile_id, v_routine.environment_id,
			v_routine.id, v_version.version, btrim(p_trigger_id), btrim(p_occurrence_key),
			p_scheduled_for, p_scheduled_for, p_payload
		) returning * into v_occurrence;
	end if;
	update public.qorpera_cloud_routine_schedule_cursors
	set last_scheduled_for = p_scheduled_for,
		next_due_at = p_next_due_at,
		updated_at = statement_timestamp()
	where routine_id = p_routine_id and routine_version = p_expected_version
		and trigger_id = btrim(p_trigger_id);
	return jsonb_build_object(
		'occurrence_id', v_occurrence.id, 'status', v_occurrence.status,
		'run_id', v_occurrence.run_id, 'scheduled_for', v_occurrence.scheduled_for
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_ensure_staff_session(uuid,text,uuid,text)'::regprocedure), 'sha256'), 'hex') <> '1c51d046853855295a0948593077439518f471db099b17262bbf97404acad884' then
		raise exception 'Reviewed function definition changed: qorpera_ensure_staff_session';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_ensure_staff_session(p_environment_id uuid, p_staff_agent_id text, p_client_session_id uuid, p_title text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id uuid := auth.uid(); v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype; v_created boolean := false;
	v_staff_uuid uuid;
begin
	select environment.profile_id into v_profile_id from public.qorpera_company_environments environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501'; end if;
	if p_client_session_id is null then raise exception 'client session id is required' using errcode = '22023'; end if;
	if p_staff_agent_id is null or char_length(btrim(p_staff_agent_id)) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023'; end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023'; end if;
	if btrim(p_staff_agent_id) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		v_staff_uuid := btrim(p_staff_agent_id)::uuid;
	end if;
	insert into public.qorpera_shared_sessions(profile_id,environment_id,client_session_id,title,staff_agent_id,
		audience_kind,audience_user_id,created_by_user_id)
	values (v_profile_id,p_environment_id,p_client_session_id,btrim(p_title),btrim(p_staff_agent_id),
		'company',null,v_user_id)
	on conflict (profile_id,staff_agent_id) where status = 'open' and staff_agent_id is not null
		and audience_kind = 'company'
		and not (execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])
	do nothing returning * into v_session;
	v_created := found;
	if v_created then
		if v_staff_uuid is null or not exists (
			select 1 from public.qorpera_agent_first_runs first_run
			where first_run.profile_id = v_profile_id and first_run.staff_agent_id = v_staff_uuid
		) then
			insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id)
			values (v_session.id,v_session.id,'kickoff',v_user_id);
		end if;
	else
		select session.* into v_session from public.qorpera_shared_sessions session
		where session.profile_id = v_profile_id and session.staff_agent_id = btrim(p_staff_agent_id)
			and session.status = 'open' and session.audience_kind = 'company'
			and not (session.execution_scope ?| array['autonomousLabel','roomId','group','parentSession']);
		if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'staff session could not be adopted', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	end if;
	return jsonb_build_object('session_id',v_session.id,'client_session_id',v_session.client_session_id,
		'environment_id',v_session.environment_id,'title',v_session.title,
		'company_snapshot_id',v_session.company_snapshot_id,'staff_version',v_session.staff_version,
		'audience_kind',v_session.audience_kind,'audience_user_id',v_session.audience_user_id,
		'created',v_created,'created_by_user_id',v_session.created_by_user_id,'created_at',v_session.created_at);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_escalate_responsibility(jsonb,jsonb)'::regprocedure), 'sha256'), 'hex') <> '338fffe44a503bfb78f564c9aeb01f19d16d596b319035598f02ce19ee52f233' then
		raise exception 'Reviewed function definition changed: qorpera_escalate_responsibility';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_escalate_responsibility(p_binding jsonb, p_signal jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_recipient jsonb;
	v_r public.qorpera_company_responsibilities%rowtype; v_queue public.qorpera_responsibility_escalations%rowtype;
	v_authority public.qorpera_staff_execution_authorities%rowtype; v_ancestry jsonb; v_occurrence uuid;
	v_staff uuid; v_user uuid; v_path text; v_evidence uuid[]; v_paths text[]; v_digest text;
	v_receipt uuid:=extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_new boolean:=false; v_signal_id uuid;
begin
	v_run:=public.qorpera_native_tool_locked_run(p_binding);
	v_actor:=public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.audience_kind <> 'company' then
		raise exception 'Private context requires its publication authority' using errcode='42501'; end if;
	if jsonb_typeof(p_signal) is distinct from 'object'
		or not (p_signal ?& array['operationKey','responsibilityId','responsibilityVersion','kind','summary','recommendation','evidenceReadIds'])
		or p_signal-array['operationKey','responsibilityId','responsibilityVersion','kind','summary','recommendation','evidenceReadIds'] <> '{}'::jsonb
		or coalesce(p_signal->>'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or jsonb_typeof(p_signal->'responsibilityVersion') is distinct from 'number'
		or coalesce(p_signal->>'responsibilityVersion','') !~ '^[1-9][0-9]{0,14}$'
		or coalesce(p_signal->>'kind','') not in ('decision','blocker','risk','exception','outcome','resource_proposal')
		or jsonb_typeof(p_signal->'summary') is distinct from 'string'
		or coalesce(p_signal->>'summary','') !~ '[^[:space:]]' or octet_length(p_signal->>'summary') > 2048
		or jsonb_typeof(p_signal->'recommendation') is distinct from 'string'
		or coalesce(p_signal->>'recommendation','') !~ '[^[:space:]]' or octet_length(p_signal->>'recommendation') > 2048
		or jsonb_typeof(p_signal->'evidenceReadIds') is distinct from 'array' then
		raise exception 'Responsibility signal is invalid' using errcode='22023'; end if;
	if jsonb_array_length(p_signal->'evidenceReadIds') not between 1 and 16
		or exists(select 1 from jsonb_array_elements(p_signal->'evidenceReadIds') id where jsonb_typeof(id) <> 'string') then
		raise exception 'Responsibility evidence is invalid' using errcode='22023'; end if;
	select array_agg(id::uuid order by id::uuid) into v_evidence from jsonb_array_elements_text(p_signal->'evidenceReadIds') id;
	if cardinality(v_evidence) <> (select count(distinct id) from unnest(v_evidence) id) then
		raise exception 'Responsibility evidence repeats' using errcode='22023'; end if;
	v_r:=public.qorpera_current_escalation_responsibility(v_actor,(p_signal->>'responsibilityId')::uuid,(p_signal->>'responsibilityVersion')::bigint);
	if v_r.accountable_staff_agent_id <> v_run.staff_agent_id then
		raise exception 'Only the accountable agent may escalate this responsibility' using errcode='42501'; end if;
	-- Evidence is a confirmed read of this run, with the exact version still
	-- current. A UUID, path, model assertion or another run's receipt is no grant.
	if exists(select 1 from unnest(v_evidence) wanted(id)
		left join public.qorpera_company_read_observations o on o.id=wanted.id and o.run_id=v_run.id and o.kind='file'
		left join public.qorpera_company_read_confirmations c on c.read_id=o.id
		left join public.qorpera_company_path_entries e on e.environment_id=o.environment_id and e.path=o.path
		where o.id is null or c.read_id is null or c.included_bytes=0 or e.version is distinct from o.version
			or e.entry is distinct from o.source->'entry') then
		raise exception 'Responsibility evidence is unavailable' using errcode='42501'; end if;
	case v_r.escalation_target->>'kind'
		when 'cofounder' then select staff_agent_id into v_staff from public.qorpera_company_cofounders where profile_id=v_run.profile_id for share;
		when 'staff_agent' then v_staff:=(v_r.escalation_target->>'id')::uuid;
		when 'member' then v_user:=(v_r.escalation_target->>'id')::uuid;
		when 'accountable_member' then v_user:=v_r.accountable_user_id;
		else raise exception 'Responsibility target is unavailable' using errcode='42501';
	end case;
	if (v_staff is null) = (v_user is null) then
		raise exception 'Responsibility target is unavailable' using errcode='42501'; end if;
	if v_staff is not null then
		perform 1 from public.qorpera_profile_staff where profile_id=v_run.profile_id and staff_agent_id=v_staff
			and employment_status='active' and deleted_at is null for share;
		if not found then raise exception 'Responsibility staff target is unavailable' using errcode='42501'; end if;
		select * into v_authority from public.qorpera_staff_execution_authorities
		where profile_id=v_run.profile_id and staff_agent_id=v_staff for share;
		if not found or not exists(select 1 from public.qorpera_execution_sponsor_versions s
			join public.qorpera_execution_sponsor_bindings b on b.id=s.binding_id
			where s.binding_id=v_authority.sponsor_binding_id and s.version=v_authority.sponsor_version
				and b.profile_id=v_run.profile_id and b.status='active' and s.allow_autonomous) then
			raise exception 'Responsibility execution authority is unavailable' using errcode='42501'; end if;
	end if;
	if v_user is not null then
		perform 1 from public.qorpera_profile_members where profile_id=v_run.profile_id and user_id=v_user
			and role in ('owner','admin','contributor') for share;
		if not found then raise exception 'Responsibility member is unavailable' using errcode='42501'; end if;
		v_recipient:=v_actor || jsonb_build_object('audience','human','userId',v_user,'audienceUserId',v_user,'staffAgentId',null);
	end if;
	select array_agg(path order by path collate "C") into v_paths from (
		select path from public.qorpera_company_run_read_paths where run_id=v_run.id union select v_r.source_path) paths;
	foreach v_path in array v_paths loop
		if (v_staff is not null and not coalesce(public.qorpera_wake_path_authorized(v_run.environment_id,v_run.requested_by_user_id,v_staff,v_path),false))
			or (v_user is not null and not public.qorpera_company_path_allowed(v_recipient,v_path,'read')) then
			raise exception 'Responsibility target cannot receive this context' using errcode='42501'; end if;
	end loop;
	v_digest:=encode(extensions.digest(convert_to(p_signal::text,'utf8'),'sha256'),'hex');
	v_begun:=public.qorpera_begin_native_tool_operation(p_binding,v_receipt,'responsibility:'||(p_signal->>'operationKey'),
		v_digest,encode(extensions.digest(convert_to(v_run.id::text||':responsibility:'||(p_signal->>'operationKey'),'utf8'),'sha256'),'hex'),false);
	if v_begun->>'state'='completed' then return v_begun->'result'; end if;
	if v_begun->>'state' is distinct from 'executing' or v_begun->>'receipt_id' is distinct from v_receipt::text then
		raise exception 'Responsibility signal requires reconciliation' using errcode='55000'; end if;
	if (select count(*) from public.qorpera_responsibility_escalation_signals where run_id=v_run.id) >= 32 then
		raise exception 'Responsibility signal budget exceeded' using errcode='54000'; end if;
	-- The company-file actor holds the environment lock. The unique index is
	-- also a final concurrent-delivery fence; one lane can cause only one wake.
	select * into v_queue from public.qorpera_responsibility_escalations
	where responsibility_id=v_r.id and responsibility_version=v_r.version and signal_kind=p_signal->>'kind' and status='open' for update;
	if not found then
		v_new:=true;
		insert into public.qorpera_responsibility_escalations(profile_id,environment_id,responsibility_id,responsibility_version,
			source_path,source_path_version,source_file_sha256,source_snapshot_id,source_manifest_sha256,target_staff_id,target_user_id,signal_kind,status)
		values(v_run.profile_id,v_run.environment_id,v_r.id,v_r.version,v_r.source_path,v_r.source_path_version,v_r.source_file_sha256,
			v_r.source_snapshot_id,(select entry#>>'{file,manifestSha256}' from public.qorpera_company_path_entries
				where environment_id=v_r.environment_id and path=v_r.source_path),
			v_staff,v_user,p_signal->>'kind','open') returning * into v_queue;
		if v_staff is not null then
			v_occurrence:=extensions.gen_random_uuid();
			v_ancestry:=public.qorpera_wake_ancestry(v_run.id,v_run.staff_agent_id,v_staff,v_occurrence);
			if v_ancestry is not null then
				-- The signal owns the one operation receipt. Enqueue the normal
				-- coworker occurrence atomically, without nesting a second effect.
				insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,staff_agent_id,
					parent_run_id,sponsor_binding_id,sponsor_version,trigger_id,occurrence_key,scheduled_for,not_before,payload)
				values(v_occurrence,v_run.profile_id,v_run.environment_id,'agent','coworker',v_staff,v_run.id,
					v_authority.sponsor_binding_id,v_authority.sponsor_version,'coworker','escalation:'||v_queue.id::text,
					clock_timestamp(),clock_timestamp(),jsonb_build_object('senderStaffId',v_run.staff_agent_id,'receiptId',v_receipt,
						'text',jsonb_build_object('schema','qorpera.responsibility-escalation-wake/v1','escalationId',v_queue.id,
							'responsibilityId',v_r.id,'responsibilityVersion',v_r.version,'kind',v_queue.signal_kind)::text));
			else v_occurrence:=null; end if;
			update public.qorpera_responsibility_escalations set occurrence_id=v_occurrence,
				status=case when v_occurrence is null then 'causal_fence' else 'open' end
			where id=v_queue.id returning * into v_queue;
		end if;
	elsif (v_queue.target_staff_id,v_queue.target_user_id,v_queue.source_path_version,v_queue.source_file_sha256)
		is distinct from (v_staff,v_user,v_r.source_path_version,v_r.source_file_sha256) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Responsibility route changed without a new version', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	insert into public.qorpera_responsibility_escalation_signals(escalation_id,run_id,receipt_id,summary,recommendation,evidence_read_ids,read_paths)
	values(v_queue.id,v_run.id,v_receipt,p_signal->>'summary',p_signal->>'recommendation',v_evidence,v_paths) returning id into v_signal_id;
	v_result:=jsonb_build_object('schema','qorpera.responsibility-escalation-receipt/v1','runId',v_run.id,'receiptId',v_receipt,
		'escalationId',v_queue.id,'signalId',v_signal_id,'status',case when v_queue.status='causal_fence' then 'causal-fence'
			when not v_new then 'coalesced' when v_staff is null then 'member-queued' else 'agent-queued' end);
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt,v_digest,v_result);
	return v_result;
end $function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_fail_artifact_gc_plan(uuid,uuid,text)'::regprocedure), 'sha256'), 'hex') <> '198ddd47d2c6b72fc31314f4155c522e86bc571ddeb2480485b36f876192a60f' then
		raise exception 'Reviewed function definition changed: qorpera_fail_artifact_gc_plan';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_fail_artifact_gc_plan(p_plan_id uuid, p_lease_id uuid, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_status text;
begin
	if auth.role() <> 'service_role' then
		raise exception 'artifact cleanup failure requires the worker' using errcode = '42501';
	end if;
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	v_status := case when v_plan.attempt_count >= 8 then 'failed' else 'retrying' end;
	update public.qorpera_artifact_gc_plans
	set status = v_status,
		next_attempt_at = statement_timestamp() + make_interval(
			secs => least(3600, (30 * power(2, greatest(attempt_count - 1, 0)))::integer)
		),
		last_error = left(coalesce(nullif(btrim(p_error), ''), 'Storage cleanup failed'), 1000),
		lease_id = null, lease_expires_at = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(
		v_plan, case when v_status = 'failed' then 'failed' else 'retrying' end,
		jsonb_build_object('attempt_count', v_plan.attempt_count, 'error', v_plan.last_error), null
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_fail_profile_invitation_delivery(uuid,uuid,text,boolean)'::regprocedure), 'sha256'), 'hex') <> '80a0ee0d944cb60c854016aeab25589a0c0cc38bae268b5fd7c0659df2e27788' then
		raise exception 'Reviewed function definition changed: qorpera_fail_profile_invitation_delivery';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_fail_profile_invitation_delivery(p_invitation_id uuid, p_lease_id uuid, p_error text, p_retryable boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_attempt_count integer;
	v_expires_at timestamptz;
	v_status text;
	v_next_attempt_at timestamptz;
begin
	select delivery.attempt_count, invitation.expires_at
	into v_attempt_count, v_expires_at
	from public.qorpera_profile_invitation_deliveries as delivery
	join public.qorpera_profile_invitations as invitation on invitation.id = delivery.invitation_id
	where delivery.invitation_id = p_invitation_id
		and delivery.status = 'delivering'
		and delivery.lease_id = p_lease_id
		and delivery.lease_expires_at > statement_timestamp()
	for update of delivery;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'invitation delivery lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;

	v_status := case
		when p_retryable and v_attempt_count < 8 and v_expires_at > statement_timestamp() then 'retrying'
		else 'failed'
	end;
	v_next_attempt_at := case
		when v_status = 'retrying' then statement_timestamp() + make_interval(
			secs => least(3600, (30 * power(2, greatest(v_attempt_count - 1, 0)))::integer)
		)
		else v_expires_at
	end;

	update public.qorpera_profile_invitation_deliveries
	set status = v_status,
		last_error = left(coalesce(nullif(btrim(p_error), ''), 'Email delivery failed'), 1000),
		next_attempt_at = v_next_attempt_at,
		lease_id = null,
		lease_expires_at = null,
		updated_at = statement_timestamp()
	where invitation_id = p_invitation_id;

	return jsonb_build_object('status', v_status, 'next_attempt_at', v_next_attempt_at);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)'::regprocedure), 'sha256'), 'hex') <> 'c4148d58d267a46917046888df4025d91e5c082500edd653e020ef791722b19d' then
		raise exception 'Reviewed function definition changed: qorpera_fail_runner_job';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_fail_runner_job(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_error text, p_retryable boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_error text := left(coalesce(nullif(btrim(p_error), ''), 'Runner job failed'), 1000);
	v_handoff jsonb;
begin
	if auth.role() <> 'service_role' or p_retryable is null
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job failure is invalid' using errcode = '42501';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id for update;
	if found and v_job.terminal_lease_token_sha256 = p_lease_token_sha256
		and v_job.last_error like v_error || '%'
		and v_job.status in ('queued', 'failed', 'cancelled') then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if not found or v_job.status <> 'leased' or v_job.runner_id <> p_runner_id
		or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	-- Contract 17: a usage limit on the sponsoring connection continues the run
	-- on the next eligible connection of the same principal instead of failing it.
	if v_job.run_id is not null then
		v_handoff := public.qorpera_handoff_run_sponsor(v_job.run_id, v_error);
		if v_handoff is not null then
			select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
			perform public.qorpera_append_runner_audit(
				v_job.profile_id, p_runner_id, v_job.id, 'job_requeued',
				jsonb_build_object('attempt_count', v_job.attempt_count, 'sponsor_handoff', v_handoff), null
			);
			return public.qorpera_runner_job_json(v_job);
		end if;
	end if;
	perform public.qorpera_terminalize_runner_attempt(
		v_job.id, 'failed', v_error, p_retryable
	);
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id,
		case when v_job.status = 'queued' then 'job_requeued' else 'job_failed' end,
		jsonb_build_object('attempt_count', v_job.attempt_count), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_guard_cloud_bound_legacy_turn()'::regprocedure), 'sha256'), 'hex') <> '49f93f8dd0d403eb1a87fdbdb6c5d57f9579c559e34af0f8d9b1058445dafe78' then
		raise exception 'Reviewed function definition changed: qorpera_guard_cloud_bound_legacy_turn';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_guard_cloud_bound_legacy_turn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
	if exists (
		select 1 from public.qorpera_session_execution_bindings as binding
		where binding.session_id = new.session_id
	) or exists (
		select 1
		from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		where run.session_id = new.session_id and job.status in ('queued', 'leased')
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'session is bound to cloud execution', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return new;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_guard_legacy_owned_session_input()'::regprocedure), 'sha256'), 'hex') <> '4033edec58902b68ba43e3f3a3cab2e3c165d2bc94e2cbb758e99c6f4c07dd8f' then
		raise exception 'Reviewed function definition changed: qorpera_guard_legacy_owned_session_input';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_guard_legacy_owned_session_input()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
	if old.turn_id is not null
		and new.execution_run_id is distinct from old.execution_run_id then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'session input is owned by a legacy execution turn', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return new;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_guard_runner_owned_session_input()'::regprocedure), 'sha256'), 'hex') <> 'edc0a35b9d07ca7ff4aa80394575373e22c03d8831178e0bc06a92ca4322da89' then
		raise exception 'Reviewed function definition changed: qorpera_guard_runner_owned_session_input';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_guard_runner_owned_session_input()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
	if new.turn_id is distinct from old.turn_id and (
		old.execution_run_id is not null
		or exists (
			select 1
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.session_id = old.session_id
				and run.source_kind = 'session_turn'
				and job.status in ('queued', 'leased')
		)
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'session is owned by a cloud execution run', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return new;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_materialize_session_execution_runs(integer)'::regprocedure), 'sha256'), 'hex') <> 'b89fd51758e0d585fe06c98858b5f2ae9ed17483d28ab60d91dc761d40728b8c' then
		raise exception 'Reviewed function definition changed: qorpera_materialize_session_execution_runs';
	end if;
end $guard$;

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
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'session inputs changed during run materialization', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
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
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_materialize_session_turn_requests(integer)'::regprocedure), 'sha256'), 'hex') <> 'a7e416bda604ed6989f53c161d0f698242244889a3ac38dd04a5e16558e086ba' then
		raise exception 'Reviewed function definition changed: qorpera_materialize_session_turn_requests';
	end if;
end $guard$;

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
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'session input changed during sponsored turn materialization', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
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
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_native_office_company_file_source(jsonb,jsonb)'::regprocedure), 'sha256'), 'hex') <> 'e201a3a1c8b037f8e9b7c29f84440f85fe561206e3592bc75ddab1cfc4fa14c6' then
		raise exception 'Reviewed function definition changed: qorpera_native_office_company_file_source';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_native_office_company_file_source(p_binding jsonb, p_args jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_authority jsonb; v_read jsonb; v_file jsonb; v_company uuid; v_environment uuid;
 v_cached public.qorpera_verified_company_file_objects%rowtype;
begin
 if not public.qorpera_valid_office_file_import(p_args) or p_args#>>'{source,realm}' is distinct from 'company_file' then
  raise exception 'Invalid Company File import' using errcode='42501'; end if;
 v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
 if v_authority#>>'{identity,audienceKind}' is distinct from 'company' or v_authority#>'{identity,audienceUserId}' is distinct from 'null'::jsonb then
  raise exception 'Company File import requires shared audience' using errcode='42501'; end if;
 v_company:=(v_authority#>>'{identity,companyId}')::uuid; v_environment:=(v_authority#>>'{identity,environmentId}')::uuid;
 perform public.qorpera_assert_wake_work_allowed((p_binding->>'runId')::uuid);
 perform public.qorpera_lock_profile_gc_fence(v_company);
 if public.qorpera_profile_gc_deletion_active(v_company) then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company File storage is busy', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 -- This existing gateway locks the current actor/context, checks path and
 -- audience grants, refuses aliases, and remembers the path in the run read set.
 v_read:=public.qorpera_read_company_path(v_environment,p_args#>>'{source,path}',p_binding);
 if v_read#>>'{entry,kind}' is distinct from 'file' or (v_read->>'version')::uuid is distinct from (p_args#>>'{source,version}')::uuid then
  raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company File import source changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 v_file:=v_read#>'{entry,file}';
 select * into v_cached from public.qorpera_verified_company_file_objects where profile_id=v_company
  and manifest_sha256=v_file->>'manifestSha256' and verifier_version=1;
 if not found or v_cached.file_sha256 is distinct from v_file->>'fileSha256'
  or v_cached.bytes is distinct from (v_file->>'bytes')::bigint or v_cached.bytes not between 0 and 8388608
  or v_cached.media_type is distinct from 'application/octet-stream' or v_cached.manifest_bytes not between 1 and 8192
  or v_cached.manifest_bytes is distinct from (v_read->>'manifestBytes')::bigint
  or exists(select 1 from jsonb_array_elements(v_cached.objects) o left join public.qorpera_profile_objects stored
   on stored.profile_id=v_company and stored.sha256=o->>'sha256'
   where stored.sha256 is null or stored.bytes is distinct from (o->>'bytes')::bigint or not public.qorpera_object_exists(v_company,o->>'sha256')) then
  raise exception 'Company File import bytes unavailable' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.company-file-transfer-source/v1','companyId',v_company,'environmentId',v_environment,
  'source',p_args->'source','sha256',v_cached.file_sha256,'manifestSha256',v_cached.manifest_sha256,
  'manifestBytes',v_cached.manifest_bytes,'bytes',v_cached.bytes,'mediaType',v_cached.media_type);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_observe_runtime_node(jsonb)'::regprocedure), 'sha256'), 'hex') <> 'e4bfc461f0f9a7484aa87dc3f2e8155a0cbc67abaec5496e16a76a59baeb1fa1' then
		raise exception 'Reviewed function definition changed: qorpera_observe_runtime_node';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_observe_runtime_node(p_observation jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_node public.qorpera_runtime_nodes%rowtype; v_previous public.qorpera_runtime_node_observations%rowtype;
 v_receipt public.qorpera_runtime_node_observation_receipts%rowtype;
 v_id uuid; v_observation uuid; v_at timestamptz; v_cpu bigint; v_memory bigint;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_observation) is distinct from 'object'
  or p_observation-array['schema','nodeId','machineIdSha256','observationId','observedAt','cpuMillis','memoryBytes','state']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_observation))<>8
  or p_observation->>'schema' is distinct from 'qorpera.runtime-node-observation/v1'
  or coalesce(p_observation->>'state','') not in ('ready','unavailable')
  or coalesce(p_observation->>'observedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then
  raise exception 'Invalid node observation' using errcode='42501'; end if;
 begin
  v_id:=(p_observation->>'nodeId')::uuid; v_observation:=(p_observation->>'observationId')::uuid;
  v_at:=(p_observation->>'observedAt')::timestamptz;
  v_cpu:=(p_observation->>'cpuMillis')::bigint; v_memory:=(p_observation->>'memoryBytes')::bigint;
  if v_id is null or v_observation is null or v_at is null or not isfinite(v_at)
   or jsonb_typeof(p_observation->'cpuMillis') is distinct from 'number'
   or jsonb_typeof(p_observation->'memoryBytes') is distinct from 'number'
   or coalesce(p_observation->>'cpuMillis','') !~ '^[1-9][0-9]*$'
   or coalesce(p_observation->>'memoryBytes','') !~ '^[1-9][0-9]*$'
   or v_cpu not between 1 and 1024000 or v_memory not between 1 and 1125899906842624 then raise check_violation; end if;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node observation' using errcode='42501'; end;
 select * into v_node from public.qorpera_runtime_nodes where id=v_id for update;
 if not found or v_node.machine_id_sha256 is distinct from p_observation->>'machineIdSha256' then
  raise exception 'Node host identity differs' using errcode='42501'; end if;
 select * into v_receipt from public.qorpera_runtime_node_observation_receipts where node_id=v_id and observation_id=v_observation;
 if found then
  if v_receipt.observation<>p_observation then raise exception 'Node observation identity changed' using errcode='42501'; end if;
  return jsonb_build_object('nodeId',v_id,'observationId',v_observation,'observedAt',v_receipt.observed_at);
 end if;
 if v_at>clock_timestamp()+interval '2 seconds' or v_at<clock_timestamp()-interval '60 seconds' then
  raise exception 'Node observation is not current' using errcode='42501'; end if;
 select * into v_previous from public.qorpera_runtime_node_observations where node_id=v_id;
 if v_previous.node_id is not null and v_at<=v_previous.observed_at then
  raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node observation arrived out of order', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 insert into public.qorpera_runtime_node_observation_receipts(node_id,observation_id,observed_at,observation)
  values(v_id,v_observation,v_at,p_observation);
 insert into public.qorpera_runtime_node_observations(node_id,observation_id,observed_at,observation)
  values(v_id,v_observation,v_at,p_observation) on conflict(node_id) do update set observation_id=excluded.observation_id,
   observed_at=excluded.observed_at,observation=excluded.observation,received_at=clock_timestamp();
 return jsonb_build_object('nodeId',v_id,'observationId',v_observation,'observedAt',v_at);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)'::regprocedure), 'sha256'), 'hex') <> '2af0632045237ce7b464b3c1ed3c080a1b0742ea28e7cdcba893d0b46e648b56' then
		raise exception 'Reviewed function definition changed: qorpera_observe_runtime_node_inventory';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_observe_runtime_node_inventory(p_observation jsonb, p_context_sha256 text, p_inventory jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid; v_observation uuid; v_context jsonb; v_old public.qorpera_runtime_node_inventory_receipts%rowtype;
 v_result jsonb; v_item jsonb; v_expected jsonb; v_binding jsonb; v_ready boolean:=true; v_policy jsonb; v_policy_hash text;
begin
 if auth.role() is distinct from 'service_role' or coalesce(p_context_sha256,'') !~ '^[0-9a-f]{64}$'
  or jsonb_typeof(p_inventory) is distinct from 'object' or p_inventory-array['schema','bootId','entries']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_inventory))<>3 or p_inventory->>'schema' is distinct from 'qorpera.runtime-node-inventory/v1'
  or coalesce(p_inventory->>'bootId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or jsonb_typeof(p_inventory->'entries') is distinct from 'array' or jsonb_array_length(p_inventory->'entries')>4096
  or octet_length(p_inventory::text)>4194304 then raise exception 'Invalid node inventory' using errcode='42501'; end if;
 begin v_id:=(p_observation->>'nodeId')::uuid; v_observation:=(p_observation->>'observationId')::uuid;
 exception when invalid_text_representation then raise exception 'Invalid node inventory identity' using errcode='42501'; end;
 perform 1 from public.qorpera_runtime_nodes where id=v_id for update;
 if not found then raise exception 'Node inventory host unconfigured' using errcode='42501'; end if;
 select * into v_old from public.qorpera_runtime_node_inventory_receipts where node_id=v_id and observation_id=v_observation;
 if found then
  if v_old.inventory<>p_inventory or v_old.context_sha256<>p_context_sha256 then raise exception 'Node inventory identity changed' using errcode='42501'; end if;
  return public.qorpera_observe_runtime_node(p_observation);
 end if;
 -- Never convert a historical hardware-only receipt into inventory authority.
 if exists(select 1 from public.qorpera_runtime_node_observation_receipts where node_id=v_id and observation_id=v_observation) then
  raise exception 'Existing hardware observation has no inventory authority' using errcode='42501'; end if;
 v_context:=public.qorpera_runtime_node_inventory_context(v_id);
 if v_context->>'contextSha256'<>p_context_sha256 then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node inventory ledger changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 v_policy:=v_context->'policy';
 select policy_sha256 into strict v_policy_hash from public.qorpera_runtime_node_inventory_policies where node_id=v_id;
 if (v_policy->>'operatingCpuMillis')::numeric+coalesce((select sum((i->>'cpuMillis')::numeric) from jsonb_array_elements(v_policy->'infrastructure') i),0)>(v_context->>'headroomCpuMillis')::numeric
  or (v_policy->>'operatingMemoryBytes')::numeric+coalesce((select sum((i->>'memoryBytes')::numeric) from jsonb_array_elements(v_policy->'infrastructure') i),0)>(v_context->>'headroomMemoryBytes')::numeric then v_ready:=false; end if;
 for v_item in select value from jsonb_array_elements(p_inventory->'entries') loop
  if jsonb_typeof(v_item) is distinct from 'object'
   or v_item-array['project','name','physicalId','type','state','configurationSha256','cpuMillis','memoryBytes','allocation','category','reason']<>'{}'::jsonb
   or (select count(*) from jsonb_object_keys(v_item))<>11
   or coalesce(v_item->>'project','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$' or coalesce(v_item->>'name','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
   or (v_item->'physicalId'<>'null'::jsonb and coalesce(v_item->>'physicalId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
   or coalesce(v_item->>'type','') not in ('virtual-machine','container')
   or coalesce(v_item->>'state','') not in ('starting','running','stopping','suspended','failed','unavailable')
   or coalesce(v_item->>'configurationSha256','') !~ '^[0-9a-f]{64}$'
   or coalesce(v_item->>'category','') not in ('managed','infrastructure','unmanaged')
   or (v_item->'reason'<>'null'::jsonb and coalesce(v_item->>'reason','') not in ('UNREGISTERED_INSTANCE','INSTANCE_AUTHORITY_DIFFERS','INSTANCE_STATE_UNAVAILABLE'))
   or exists(select 1 from unnest(array['cpuMillis','memoryBytes']) k where v_item->k<>'null'::jsonb and
    (jsonb_typeof(v_item->k) is distinct from 'number' or coalesce(v_item->>k,'') !~ '^[1-9][0-9]{0,15}$')) then
   raise exception 'Invalid node inventory entry' using errcode='42501'; end if;
  if v_item->>'category'='managed' then
   select a into v_expected from jsonb_array_elements(v_context->'allocations') a where a=v_item->'allocation';
   if not found or v_item->>'type'<>'virtual-machine' then raise exception 'Node inventory allocation differs' using errcode='42501'; end if;
   if v_item->'cpuMillis' is distinct from v_expected->'cpuMillis' or v_item->'memoryBytes' is distinct from v_expected->'memoryBytes' then v_ready:=false; end if;
   v_binding:=jsonb_build_object('project',v_item->'project','name',v_item->'name','physicalId',v_item->'physicalId','configurationSha256',v_item->'configurationSha256');
   if v_expected->'physical'<>'null'::jsonb and v_expected->'physical'<>v_binding then v_ready:=false;
   elsif v_item->'reason'='null'::jsonb and v_item->'physicalId'<>'null'::jsonb and v_item->>'state'<>'unavailable'
    and v_item->'cpuMillis'=v_expected->'cpuMillis' and v_item->'memoryBytes'=v_expected->'memoryBytes' then
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
     values((v_expected->>'allocationId')::uuid,v_id,(v_item->>'physicalId')::uuid,v_binding) on conflict(allocation_id) do nothing;
   end if;
  elsif v_item->>'category'='infrastructure' then
   if v_item->'allocation'<>'null'::jsonb then raise exception 'Infrastructure cannot hide an allocation' using errcode='42501'; end if;
   select i into v_expected from jsonb_array_elements(v_policy->'infrastructure') i where i->>'project'=v_item->>'project' and i->>'name'=v_item->>'name';
   if not found or v_expected<>(v_item-array['state','allocation','category','reason']) then v_ready:=false; end if;
  else
   if v_item->'allocation'<>'null'::jsonb then raise exception 'Unmanaged instance cannot claim an allocation' using errcode='42501'; end if;
   v_ready:=false;
  end if;
  if v_item->'physicalId'='null'::jsonb or v_item->'cpuMillis'='null'::jsonb or v_item->'memoryBytes'='null'::jsonb
   or v_item->>'state'='unavailable' or v_item->'reason'<>'null'::jsonb then v_ready:=false; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_inventory->'entries') i group by i->>'project',i->>'name' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_inventory->'entries') i where i->'physicalId'<>'null'::jsonb group by i->>'physicalId' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_inventory->'entries') i where i->'allocation'<>'null'::jsonb group by i->'allocation'->>'allocationId' having count(*)>1) then
  raise exception 'Node inventory duplicates identity' using errcode='42501'; end if;
 if p_observation->>'state'='ready' and not v_ready then raise exception 'Node inventory is not ready' using errcode='42501'; end if;
 v_result:=public.qorpera_observe_runtime_node(p_observation);
 insert into public.qorpera_runtime_node_inventory_receipts(node_id,observation_id,node_version,policy_sha256,context_sha256,inventory)
 values(v_id,v_observation,(v_context->>'nodeVersion')::bigint,v_policy_hash,p_context_sha256,p_inventory);
 return v_result;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_promote_company_file_graph_to_supabase(uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> '07d068abec18a6c43a640f2b13d27305899b00aec081dfcfaebc1c4e1fab023c' then
		raise exception 'Reviewed function definition changed: qorpera_promote_company_file_graph_to_supabase';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_promote_company_file_graph_to_supabase(p_profile_id uuid, p_graph_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_entry_count bigint;
	v_entry_bytes bigint;
	v_catalog_objects bigint;
	v_storage_objects bigint;
	v_changed_objects bigint;
begin
	if auth.role() is distinct from 'service_role'
		or p_profile_id is null
		or p_graph_id is null then
		raise exception 'Supabase graph promotion is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'profile object cleanup is in progress', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	join public.qorpera_company_files as file
		on file.profile_id = graph.profile_id
		and file.environment_id = graph.environment_id
		and file.head_snapshot_id = graph.root_id
	where graph.id = p_graph_id
		and graph.profile_id = p_profile_id
		and graph.root_kind = 'company_snapshot'
		and graph.status = 'complete'
		and graph.closure_verified
	for update of graph;
	if not found then
		raise exception 'current verified Company File graph is unavailable' using errcode = '55000';
	end if;
	select count(*), coalesce(sum(entry.bytes), 0)
	into v_entry_count, v_entry_bytes
	from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = v_graph.id;
	if v_entry_count <> v_graph.object_count or v_entry_bytes <> v_graph.storage_bytes then
		raise exception 'Company File graph totals are invalid' using errcode = '55000';
	end if;
	perform 1
	from public.qorpera_object_reachability_entries as entry
	join public.qorpera_profile_objects as object
		on object.profile_id = p_profile_id
		and object.sha256 = entry.object_sha256
		and object.bytes = entry.bytes
	where entry.graph_id = v_graph.id
	for update of object;
	get diagnostics v_catalog_objects = row_count;
	if v_catalog_objects <> v_entry_count then
		raise exception 'Company File catalog closure is unavailable' using errcode = '55000';
	end if;
	perform 1
	from public.qorpera_object_reachability_entries as entry
	join storage.objects as storage_object
		on storage_object.bucket_id = 'qorpera-profile-objects'
		and storage_object.name = p_profile_id::text || '/' || entry.object_sha256
		and case
			when (storage_object.metadata ->> 'size') ~ '^[0-9]+$'
				then (storage_object.metadata ->> 'size')::bigint
			else -1
		end = entry.bytes
	where entry.graph_id = v_graph.id
	for key share of storage_object;
	get diagnostics v_storage_objects = row_count;
	if v_storage_objects <> v_entry_count then
		raise exception 'verified Supabase Company File closure is unavailable' using errcode = '55000';
	end if;
	update public.qorpera_profile_objects as object
	set backend = 'supabase-storage'
	where object.profile_id = p_profile_id
		and object.backend <> 'supabase-storage'
		and exists (
			select 1
			from public.qorpera_object_reachability_entries as entry
			where entry.graph_id = v_graph.id
				and entry.object_sha256 = object.sha256
				and entry.bytes = object.bytes
		);
	get diagnostics v_changed_objects = row_count;
	return jsonb_build_object(
		'profile_id', p_profile_id,
		'graph_id', v_graph.id,
		'snapshot_id', v_graph.root_id,
		'object_count', v_entry_count,
		'storage_bytes', v_entry_bytes,
		'backend', 'supabase-storage',
		'changed_objects', v_changed_objects
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_put_profile_staff(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone,bigint)'::regprocedure), 'sha256'), 'hex') <> '02c7eb9a25ae60a244356b14b355318a13f310d2ff32131076fe758a2e9cb56a' then
		raise exception 'Reviewed function definition changed: qorpera_put_profile_staff';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_put_profile_staff(p_profile_id uuid, p_staff_agent_id uuid, p_display_name text, p_role text, p_charter text, p_template_id text, p_department_id text, p_appearance_color text, p_appearance_shape text, p_appearance_creature text, p_model_provider text, p_model_id text, p_employment_status text, p_lifecycle_state text, p_created_at timestamp with time zone, p_expected_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_member_role text;
	v_current public.qorpera_profile_staff%rowtype;
	v_result public.qorpera_profile_staff%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select member.role
	into v_member_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_member_role is null or v_member_role = 'viewer' then
		raise exception 'profile write access denied' using errcode = '42501';
	end if;
	if p_staff_agent_id is null or p_created_at is null then
		raise exception 'staff identity is invalid' using errcode = '22023';
	end if;
	if char_length(p_display_name) not between 1 and 160 or p_display_name <> btrim(p_display_name)
		or char_length(p_role) not between 1 and 320 or p_role <> btrim(p_role)
		or octet_length(convert_to(p_charter, 'utf8')) not between 1 and 32768 or p_charter <> btrim(p_charter)
		or char_length(p_appearance_color) not between 1 and 64 or p_appearance_color <> btrim(p_appearance_color)
		or char_length(p_appearance_shape) not between 1 and 64 or p_appearance_shape <> btrim(p_appearance_shape)
		or (p_appearance_creature is not null and (char_length(p_appearance_creature) not between 1 and 64 or p_appearance_creature <> btrim(p_appearance_creature)))
		or ((p_model_provider is null) <> (p_model_id is null))
		or (p_model_provider is not null and (char_length(p_model_provider) not between 1 and 128 or p_model_provider <> btrim(p_model_provider)))
		or (p_model_id is not null and (char_length(p_model_id) not between 1 and 256 or p_model_id <> btrim(p_model_id)))
		or (p_template_id is not null and (char_length(p_template_id) not between 1 and 256 or p_template_id <> btrim(p_template_id)))
		or (p_department_id is not null and (char_length(p_department_id) not between 1 and 256 or p_department_id <> btrim(p_department_id)))
		or p_employment_status not in ('active', 'archived')
		or p_lifecycle_state not in ('setup', 'active') then
		raise exception 'staff record is invalid' using errcode = '22023';
	end if;

	select staff.*
	into v_current
	from public.qorpera_profile_staff as staff
	where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
	for update;

	if not found then
		if p_expected_version is not null then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'staff version conflict', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		insert into public.qorpera_profile_staff (
			profile_id, staff_agent_id, display_name, role, charter, template_id, department_id,
			appearance_color, appearance_shape, appearance_creature, model_provider, model_id,
			employment_status, lifecycle_state, version, created_at, updated_at, updated_by_user_id
		)
		values (
			p_profile_id, p_staff_agent_id, p_display_name, p_role, p_charter, p_template_id, p_department_id,
			p_appearance_color, p_appearance_shape, p_appearance_creature, p_model_provider, p_model_id,
			p_employment_status, p_lifecycle_state, 1, p_created_at, p_created_at, v_user_id
		)
		returning * into v_result;
	else
		if p_expected_version is null then
			if v_current.display_name = p_display_name
				and v_current.role = p_role
				and v_current.charter = p_charter
				and v_current.template_id is not distinct from p_template_id
				and v_current.department_id is not distinct from p_department_id
				and v_current.appearance_color = p_appearance_color
				and v_current.appearance_shape = p_appearance_shape
				and v_current.appearance_creature is not distinct from p_appearance_creature
				and v_current.model_provider is not distinct from p_model_provider
				and v_current.model_id is not distinct from p_model_id
				and v_current.employment_status = p_employment_status
				and v_current.lifecycle_state = p_lifecycle_state
				and v_current.created_at = p_created_at then
				v_result := v_current;
			else
				raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'staff version conflict', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
			end if;
		elsif v_current.version <> p_expected_version then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'staff version conflict', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		else
			update public.qorpera_profile_staff
			set display_name = p_display_name,
				role = p_role,
				charter = p_charter,
				template_id = p_template_id,
				department_id = p_department_id,
				appearance_color = p_appearance_color,
				appearance_shape = p_appearance_shape,
				appearance_creature = p_appearance_creature,
				model_provider = p_model_provider,
				model_id = p_model_id,
				employment_status = p_employment_status,
				lifecycle_state = p_lifecycle_state,
				version = version + 1,
				updated_at = statement_timestamp(),
				updated_by_user_id = v_user_id
			where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id
			returning * into v_result;
		end if;
	end if;

	return jsonb_build_object(
		'profile_id', v_result.profile_id,
		'staff_agent_id', v_result.staff_agent_id,
		'display_name', v_result.display_name,
		'role', v_result.role,
		'charter', v_result.charter,
		'template_id', v_result.template_id,
		'department_id', v_result.department_id,
		'appearance_color', v_result.appearance_color,
		'appearance_shape', v_result.appearance_shape,
		'appearance_creature', v_result.appearance_creature,
		'model_provider', v_result.model_provider,
		'model_id', v_result.model_id,
		'employment_status', v_result.employment_status,
		'lifecycle_state', v_result.lifecycle_state,
		'version', v_result.version,
		'created_at', v_result.created_at,
		'updated_at', v_result.updated_at,
		'updated_by_user_id', v_result.updated_by_user_id
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_put_staff_provider_model(uuid,uuid,text,text,bigint)'::regprocedure), 'sha256'), 'hex') <> 'ab17e328b0d661dcefe67cf441e0fb08f984d67808a2d4c62792910e64deb668' then
		raise exception 'Reviewed function definition changed: qorpera_put_staff_provider_model';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_put_staff_provider_model(p_profile_id uuid, p_staff_agent_id uuid, p_provider text, p_model_id text, p_expected_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_current public.qorpera_staff_provider_models%rowtype;
	v_result public.qorpera_staff_provider_models%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'staff provider model requires company write access' using errcode = '42501';
	end if;
	if p_staff_agent_id is null
		or coalesce(p_provider, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(btrim(coalesce(p_model_id, ''))) not between 1 and 256
		or p_model_id <> btrim(p_model_id)
		or p_model_id = 'provider-default'
		or p_model_id ~ E'[\r\n]'
		or not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
				and staff.employment_status = 'active'
		) then
		raise exception 'staff provider model is invalid' using errcode = '22023';
	end if;
	select mapping.* into v_current
	from public.qorpera_staff_provider_models as mapping
	where mapping.profile_id = p_profile_id and mapping.staff_agent_id = p_staff_agent_id
		and mapping.provider = p_provider
	for update;
	if not found then
		if p_expected_version is not null then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'staff provider model version conflict', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		insert into public.qorpera_staff_provider_models (
			profile_id, staff_agent_id, provider, model_id, configured_by_user_id
		) values (
			p_profile_id, p_staff_agent_id, p_provider, p_model_id, v_user_id
		) returning * into v_result;
	elsif p_expected_version is null then
		if v_current.model_id <> p_model_id then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'staff provider model version conflict', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		v_result := v_current;
	elsif v_current.version <> p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'staff provider model version conflict', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	else
		update public.qorpera_staff_provider_models
		set model_id = p_model_id,
			version = version + 1,
			configured_by_user_id = v_user_id,
			configured_at = statement_timestamp()
		where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id
			and provider = p_provider
		returning * into v_result;
	end if;
	return jsonb_build_object(
		'profile_id', v_result.profile_id,
		'staff_agent_id', v_result.staff_agent_id,
		'provider', v_result.provider,
		'model_id', v_result.model_id,
		'version', v_result.version,
		'configured_by_user_id', v_result.configured_by_user_id,
		'configured_at', v_result.configured_at
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> '102bcad12b7c0c32162eb41e1e1b855ed50dec2aea679abc787c5e619d4ffdde' then
		raise exception 'Reviewed function definition changed: qorpera_rebase_company_proposal';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_rebase_company_proposal(p_proposal_id uuid, p_expected_proposal_snapshot_id uuid, p_expected_head_snapshot_id uuid, p_replacement_snapshot_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_publication public.qorpera_company_snapshot_publications%rowtype;
	v_revision bigint;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_proposal.profile_id) then
		raise exception 'company proposal rebase authorization is required' using errcode = '42501';
	end if;
	if v_proposal.status <> 'open'
		or v_proposal.proposal_snapshot_id is distinct from p_expected_proposal_snapshot_id
		or p_replacement_snapshot_id is null
		or p_replacement_snapshot_id = v_proposal.proposal_snapshot_id then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company proposal changed before rebase', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_proposal.profile_id
		and file.environment_id = v_proposal.environment_id
	for update;
	if v_file.head_snapshot_id is distinct from p_expected_head_snapshot_id then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company head changed before proposal rebase', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = p_replacement_snapshot_id
		and snapshot.profile_id = v_proposal.profile_id
		and snapshot.environment_id = v_proposal.environment_id
		and snapshot.workspace_id = v_file.canonical_workspace_id;
	select publication.* into v_publication
	from public.qorpera_company_snapshot_publications as publication
	where publication.snapshot_id = p_replacement_snapshot_id;
	if v_snapshot.id is null or v_publication.snapshot_id is null
		or v_snapshot.parent_snapshot_id is distinct from v_file.head_snapshot_id
		or v_publication.expected_head_snapshot_id is distinct from v_file.head_snapshot_id
		or v_publication.status <> 'prepared'
		or v_publication.restricted_content_sha256 is null
		or not public.qorpera_object_root_has_current_proof('company_snapshot', v_snapshot.id) then
		raise exception 'rebased company proposal is not durably verified' using errcode = '55000';
	end if;
	select coalesce(max(revision), 0) + 1 into v_revision
	from public.qorpera_company_proposal_revisions
	where proposal_id = v_proposal.id;
	insert into public.qorpera_company_proposal_revisions (
		proposal_id, revision, base_snapshot_id, proposal_snapshot_id,
		change_kind, created_by_user_id
	) values (
		v_proposal.id, v_revision, v_file.head_snapshot_id, v_snapshot.id,
		'rebased', v_user_id
	);
	update public.qorpera_company_proposals
	set base_snapshot_id = v_file.head_snapshot_id,
		proposal_snapshot_id = v_snapshot.id
	where id = v_proposal.id
	returning * into v_proposal;
	return public.qorpera_company_proposal_json(v_proposal);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure), 'sha256'), 'hex') <> 'e9ad166c20b78fbfed6acd7330cf413004b6a8d227e6727e47898a8175d508f4' then
		raise exception 'Reviewed function definition changed: qorpera_reconcile_runner_orchestrator_without_sponsored_turns';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(p_orchestrator_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_released integer := 0;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role' or not exists (
		select 1 from public.qorpera_runner_orchestrators as orchestrator
		where orchestrator.id = p_orchestrator_id and orchestrator.status = 'active'
	) then
		raise exception 'orchestrator is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_runner_orchestrators
	set last_heartbeat_at = statement_timestamp() where id = p_orchestrator_id;
	perform public.qorpera_materialize_session_execution_runs(32);
	perform public.qorpera_materialize_wake_execution_runs(32);
	perform public.qorpera_materialize_company_proposal_review_runs(32);
	perform public.qorpera_quarantine_runner_model_requests(
		job.id, 'The runner disappeared before the model gateway result was recorded'
	)
	from public.qorpera_runner_jobs as job
	where job.status in ('completed', 'failed', 'cancelled')
		and exists (
			select 1 from public.qorpera_runner_model_requests as request
			where request.job_id = job.id and request.status = 'reserved'
				and request.reservation_expires_at <= statement_timestamp()
		);
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Execution sponsor, model policy, or quota reservation is unavailable'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and not public.qorpera_execution_sponsor_available(run)
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and not public.qorpera_execution_sponsor_available(candidate_run)
			order by candidate.id for update of candidate skip locked);
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Pinned logical computer is unavailable or incompatible'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and not public.qorpera_execution_compute_available(run)
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and not public.qorpera_execution_compute_available(candidate_run)
			order by candidate.id for update of candidate skip locked);
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Execution deadline expired before runner acceptance'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and run.deadline_at <= statement_timestamp()
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and candidate_run.deadline_at <= statement_timestamp()
			order by candidate.id for update of candidate skip locked);
	for v_job in
		select job.* from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on run.id = job.run_id
		where job.status = 'leased' and (
			job.lease_expires_at <= statement_timestamp()
			or run.deadline_at <= statement_timestamp()
			or not public.qorpera_execution_sponsor_available(run)
			or not public.qorpera_execution_compute_available(run)
		)
		for update skip locked
	loop
		select run.* into strict v_run
		from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if v_run.deadline_at <= statement_timestamp() then
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Execution deadline expired before durable completion', false
			);
		elsif not public.qorpera_execution_sponsor_available(v_run) then
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Execution sponsor or provider authority became unavailable', false
			);
		elsif not public.qorpera_execution_compute_available(v_run) then
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Pinned logical computer became unavailable or incompatible', false
			);
		else
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Runner lease expired before durable completion', true
			);
		end if;
	end loop;
	perform public.qorpera_retire_stale_managed_runners();
	update public.qorpera_runner_assignments as assignment
	set status = 'expired', last_error = 'Assignment was not accepted before expiry'
	where assignment.status = 'offered' and assignment.expires_at <= statement_timestamp()
		and assignment.id in (select candidate.id from public.qorpera_runner_assignments as candidate
			where candidate.status = 'offered' and candidate.expires_at <= statement_timestamp()
			order by candidate.id for update skip locked);
	update public.qorpera_runner_job_claims as claim
	set status = 'released', released_at = statement_timestamp(),
		release_reason = 'Orchestrator claim expired before runner acceptance'
	where claim.status in ('claimed', 'assigned') and claim.lease_expires_at <= statement_timestamp()
		and claim.id in (select candidate.id from public.qorpera_runner_job_claims as candidate
			where candidate.status in ('claimed', 'assigned') and candidate.lease_expires_at <= statement_timestamp()
			order by candidate.id for update skip locked);
	get diagnostics v_released = row_count;
	return jsonb_build_object('released', v_released);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_reissue_runner_activation(uuid,text)'::regprocedure), 'sha256'), 'hex') <> '79102f7d106d4d161877aebaaaafe51973050ef0a2e71bd64b56df424870738b' then
		raise exception 'Reviewed function definition changed: qorpera_reissue_runner_activation';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_reissue_runner_activation(p_runner_id uuid, p_activation_token_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_locked_jobs uuid[] := array[]::uuid[];
	v_locked_job uuid;
	v_previous_status text;
begin
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_runner.profile_id) then
		raise exception 'runner registration requires full access' using errcode = '42501';
	end if;
	for v_locked_job in
		select job.id from public.qorpera_runner_jobs as job
		where job.runner_id = p_runner_id and job.status = 'leased'
		order by job.id for update
	loop
		v_locked_jobs := array_append(v_locked_jobs, v_locked_job);
	end loop;
	select runner.* into strict v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id for update;
	if not public.qorpera_can_authorize_profile(v_runner.profile_id) then
		raise exception 'runner administration requires full access' using errcode = '42501';
	end if;
	if exists (select 1 from public.qorpera_runner_jobs as job
		where job.runner_id = p_runner_id and job.status = 'leased'
			and not (job.id = any(v_locked_jobs))) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
			'message', 'Runner leases changed before administration', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}';
	end if;
	if v_runner.status = 'revoked' or p_activation_token_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'runner activation cannot be reissued' using errcode = '55000';
	end if;
	v_previous_status := v_runner.status;
	if v_runner.status = 'active' then
		for v_job in
			select job.* from public.qorpera_runner_jobs as job
			where job.runner_id = p_runner_id and job.status = 'leased'
		loop
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Runner session was reset for re-pairing', true
			);
			select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_job.id;
			perform public.qorpera_append_runner_audit(
				v_job.profile_id, p_runner_id, v_job.id,
				case when v_job.status = 'queued' then 'job_requeued' else 'job_failed' end,
				jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'runner_repaired'), v_user_id
			);
		end loop;
	end if;
	update public.qorpera_runners
	set status = 'pending', activation_token_sha256 = p_activation_token_sha256,
		activation_expires_at = statement_timestamp() + interval '15 minutes',
		session_token_sha256 = null, session_expires_at = null,
		previous_session_token_sha256 = null, previous_session_expires_at = null,
		last_renewal_id = null, platform = null, runner_version = null,
		activated_at = null
	where id = p_runner_id returning * into v_runner;
	perform public.qorpera_append_runner_audit(
		v_runner.profile_id, v_runner.id, null, 'runner_registered',
		jsonb_build_object(
			'reissued', true,
			'previous_status', v_previous_status,
			'activation_expires_at', v_runner.activation_expires_at
		), v_user_id
	);
	return public.qorpera_runner_json(v_runner);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_reject_company_proposal(uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> '77cd5b9a49624f2b3eaaee73770e0d0b0c9f4c860dd83d6db6f85ddc92659ee6' then
		raise exception 'Reviewed function definition changed: qorpera_reject_company_proposal';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_reject_company_proposal(p_proposal_id uuid, p_expected_proposal_snapshot_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_proposal.profile_id) then
		raise exception 'company proposal authorization is required' using errcode = '42501';
	end if;
	if v_proposal.proposal_snapshot_id is distinct from p_expected_proposal_snapshot_id then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company proposal changed before rejection', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_proposal.status = 'rejected' then
		return public.qorpera_company_proposal_json(v_proposal);
	end if;
	if v_proposal.status <> 'open' then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company proposal was resolved before rejection', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_company_proposals
	set status = 'rejected', resolved_by_user_id = v_user_id, resolved_at = statement_timestamp()
	where id = v_proposal.id
	returning * into v_proposal;
	return public.qorpera_company_proposal_json(v_proposal);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_reject_graph_completion_during_gc()'::regprocedure), 'sha256'), 'hex') <> 'cdaa2926024511e82a8e360f64c0d1ef44558d257b54ac44608c035365ebc9b7' then
		raise exception 'Reviewed function definition changed: qorpera_reject_graph_completion_during_gc';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_reject_graph_completion_during_gc()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
	if old.status <> 'complete' and new.status = 'complete' then
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if public.qorpera_profile_gc_deletion_active(new.profile_id) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'profile object cleanup is in progress', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
	end if;
	return new;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_reject_profile_root_during_gc()'::regprocedure), 'sha256'), 'hex') <> 'db031425cbb90f43a4020c7f286dac89888a2d4e8e75fef759a6b2a856d566ba' then
		raise exception 'Reviewed function definition changed: qorpera_reject_profile_root_during_gc';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_reject_profile_root_during_gc()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
	perform public.qorpera_lock_profile_gc_fence(new.profile_id);
	if public.qorpera_profile_gc_deletion_active(new.profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'profile object cleanup is in progress', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return new;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure), 'sha256'), 'hex') <> '75d4de717802f1e0370ebcbf1ee6b4692c79a025c2034f2c018d7b062d0e1e55' then
		raise exception 'Reviewed function definition changed: qorpera_release_runner_job_claim';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_release_runner_job_claim(p_orchestrator_id uuid, p_claim_id uuid, p_client_assignment_id uuid, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
begin
	if auth.role() <> 'service_role' or p_client_assignment_id is null
		or char_length(btrim(coalesce(p_error, ''))) not between 1 and 1000 then
		raise exception 'runner claim release is invalid' using errcode = '42501';
	end if;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id;
	if not found then raise exception 'runner claim is unavailable' using errcode = '55000'; end if;
	perform 1 from public.qorpera_runner_jobs where id = v_claim.job_id for update;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id for update;
	if not found then
		raise exception 'runner claim is unavailable' using errcode = '55000';
	end if;
	if v_claim.status = 'released' then
		return jsonb_build_object('released', true);
	end if;
	if v_claim.status not in ('claimed', 'assigned') then
		raise exception 'runner claim is already owned by a runner' using errcode = '55000';
	end if;
	select assignment.* into v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = p_client_assignment_id and assignment.claim_id = p_claim_id for update;
	if v_claim.status = 'assigned' and (not found or v_assignment.status <> 'offered') then
		raise exception 'runner assignment is unavailable' using errcode = '55000';
	end if;
	if v_assignment.id is not null and v_assignment.status = 'offered' then
		update public.qorpera_runner_assignments
		set status = 'delivery_failed', last_error = btrim(p_error) where id = v_assignment.id;
	end if;
	update public.qorpera_runner_job_claims
	set status = 'released', released_at = statement_timestamp(), release_reason = btrim(p_error)
	where id = p_claim_id;
	update public.qorpera_runner_jobs
	set dispatch_failure_count = dispatch_failure_count + 1,
		last_error = btrim(p_error)
	where id = v_claim.job_id and status = 'queued' and dispatch_failure_count < 8
	returning * into v_job;
	if v_job.id is not null and v_job.dispatch_failure_count >= 8 then
		update public.qorpera_runner_jobs
		set status = 'failed', finished_at = statement_timestamp(),
			last_error = 'Runner dispatch failed after the final infrastructure attempt: ' || btrim(p_error)
		where id = v_job.id returning * into v_job;
	end if;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, 'infrastructure_retry', jsonb_build_object(
		'assignment_id', v_assignment.id, 'reason', btrim(p_error),
		'dispatch_failure_count', v_job.dispatch_failure_count,
		'terminal', coalesce(v_job.status = 'failed', false)
	));
	return jsonb_build_object(
		'released', true,
		'dispatch_failure_count', v_job.dispatch_failure_count,
		'terminal', coalesce(v_job.status = 'failed', false)
	);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_renew_artifact_gc_lease(uuid,uuid,text[])'::regprocedure), 'sha256'), 'hex') <> '0330521627de55dcdf4dabd753aea8d245d3be8b13bfe78ad1a42d8cedc115d1' then
		raise exception 'Reviewed function definition changed: qorpera_renew_artifact_gc_lease';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_renew_artifact_gc_lease(p_plan_id uuid, p_lease_id uuid, p_object_sha256s text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	if auth.role() <> 'service_role'
		or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		)
		or exists (
			select 1 from unnest(p_object_sha256s) as sha256
			where sha256 !~ '^[0-9a-f]{64}$'
		) then
		raise exception 'artifact cleanup lease renewal is invalid' using errcode = '42501';
	end if;
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	perform public.qorpera_lock_profile_gc_fence(v_plan.profile_id);
	if exists (
		select 1
		from unnest(p_object_sha256s) as sha256
		left join public.qorpera_artifact_gc_plan_entries as entry
			on entry.plan_id = p_plan_id
			and entry.object_sha256 = sha256
			and entry.status = 'pending'
		where entry.object_sha256 is null
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'artifact cleanup lease renewal is outside the pending plan', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_artifact_gc_plans
	set lease_expires_at = statement_timestamp() + interval '5 minutes'
	where id = p_plan_id
	returning * into v_plan;
	return jsonb_build_object('lease_expires_at', v_plan.lease_expires_at);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_renew_company_object_gc(uuid,uuid,text[])'::regprocedure), 'sha256'), 'hex') <> '26f7761bc6d305a0266255e704eba7236e060c66101ed0e335f296a101b21ef3' then
		raise exception 'Reviewed function definition changed: qorpera_renew_company_object_gc';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_renew_company_object_gc(p_profile_id uuid, p_lease_id uuid, p_object_sha256s text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role' or cardinality(p_object_sha256s) not between 1 and 100 then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	select count(*) into v_expected
	from public.qorpera_company_object_gc_entries as entry
	where entry.profile_id = p_profile_id and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s)
		and not exists (
			select 1
			from public.qorpera_company_retained_object_hashes(p_profile_id) as retained
			where retained.object_sha256 = entry.object_sha256
		);
	if v_expected <> cardinality(p_object_sha256s) or exists (
		select 1 from public.qorpera_company_object_gc_leases as lease
		where lease.profile_id = p_profile_id and lease.lease_id = p_lease_id
			and lease.lease_expires_at <= statement_timestamp()
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company object cleanup lease is stale', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_company_object_gc_leases
	set lease_expires_at = statement_timestamp() + interval '10 minutes'
	where profile_id = p_profile_id and lease_id = p_lease_id;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company object cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_renew_deleted_profile_object_gc(uuid,uuid,text[])'::regprocedure), 'sha256'), 'hex') <> '54707e2ae5f84751fa0c0158cf4b79bf5cd3bb6c2ff693c0315a645dc3b8858c' then
		raise exception 'Reviewed function definition changed: qorpera_renew_deleted_profile_object_gc';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_renew_deleted_profile_object_gc(p_profile_id uuid, p_lease_id uuid, p_object_sha256s text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role'
		or p_profile_id is null
		or p_lease_id is null
		or p_object_sha256s is null
		or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		)
		or exists (
			select 1 from unnest(p_object_sha256s) as sha256
			where sha256 !~ '^[0-9a-f]{64}$'
		) then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	select count(*) into v_expected
	from public.qorpera_deleted_profile_object_gc_entries as entry
	where entry.profile_id = p_profile_id
		and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s);
	if v_expected <> cardinality(p_object_sha256s) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'deleted profile object cleanup lease is stale', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_deleted_profile_object_gc_leases
	set lease_expires_at = statement_timestamp() + interval '10 minutes'
	where profile_id = p_profile_id
		and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'deleted profile object cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_renew_runner_job(uuid,text,uuid,text)'::regprocedure), 'sha256'), 'hex') <> '588d0da6b96868ca71b22352f610380cc0be2454e9aa7227c99a358c3dac5cb1' then
		raise exception 'Reviewed function definition changed: qorpera_renew_runner_job';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_renew_runner_job(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '25s'
 SET statement_timeout TO '25s'
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
begin
	if auth.role() <> 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job renewal is invalid' using errcode = '42501';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.status = 'leased' and job.runner_id = p_runner_id
		and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp() for update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	update public.qorpera_runner_jobs
	set lease_expires_at = statement_timestamp() + interval '6 minutes'
	where id = p_job_id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_lease_renewed',
		jsonb_build_object('lease_expires_at', v_job.lease_expires_at), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_request_runtime_office_drain_v1(jsonb,uuid,bigint,bigint,bigint,boolean)'::regprocedure), 'sha256'), 'hex') <> '3987819c5bf53f48b395bc66ec7359e013fc72e2d2be54672a62f8376891fed3' then
		raise exception 'Reviewed function definition changed: qorpera_request_runtime_office_drain_v1';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_request_runtime_office_drain_v1(p_scope jsonb, p_screen_id uuid, p_computer_generation bigint, p_screen_generation bigint, p_epoch bigint, p_takeover boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_takeover is null then
		raise exception 'Member office authority required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation is distinct from p_computer_generation or v_office.state<>'active'
		or not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id
			and user_id=auth.uid() and role in ('owner','admin')) then
		raise exception 'Office takeover unavailable' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=p_screen_id for update;
	if not found or v_screen.generation is distinct from p_screen_generation or v_screen.epoch is distinct from p_epoch then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Office screen changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	update public.qorpera_runtime_office_screens set epoch=epoch+1,lease_id=null,run_id=null,lease_expires_at=null,
		grant_version=null,native_binding=null,drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null,
		takeover_user_id=case when p_takeover then auth.uid() else null end,touched_at=clock_timestamp()
		where id=v_screen.id returning * into v_screen;
	update public.qorpera_runtime_office_resources set state='draining' where screen_id=v_screen.id and state='active';
	update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
	return jsonb_build_object('state','draining','drainId',v_screen.drain_id,'epoch',v_screen.epoch,
		'binding',public.qorpera_runtime_office_scope(v_office)||jsonb_build_object('computerGeneration',v_office.generation,
			'screenId',v_screen.id,'screenOrdinal',v_screen.ordinal,'screenGeneration',v_screen.generation,'staffAgentId',v_screen.staff_agent_id));
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_request_runtime_office_privacy(jsonb,uuid,uuid,bigint,boolean)'::regprocedure), 'sha256'), 'hex') <> '56b828c3a44fa977832ea002a315eb2a8e384fd140b6ce09533be0c42545ae29' then
		raise exception 'Reviewed function definition changed: qorpera_request_runtime_office_privacy';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_request_runtime_office_privacy(p_scope jsonb, p_profile_id uuid, p_screen_id uuid, p_expected_version bigint, p_private boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_profile public.qorpera_runtime_browser_profiles%rowtype;
	v_challenge jsonb; v_drains jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_private is null then
		raise exception 'Browser owner required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.state<>'active' then
		raise exception 'Office privacy unavailable' using errcode='42501'; end if;
	if v_office.privacy_version is distinct from p_expected_version then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Office privacy changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	select * into v_profile from public.qorpera_runtime_browser_profiles where id=p_profile_id and office_id=v_office.id for update;
	if not found or v_profile.owner_user_id<>auth.uid() then raise exception 'Browser owner required' using errcode='42501'; end if;
	if p_private then
		perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
		if not found or v_office.privacy_state<>'shared'
			or not exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and id=p_screen_id)
			or exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and (drain_pending or takeover_user_id is not null)) then
			raise exception 'Private sign-in unavailable' using errcode='42501'; end if;
		-- A changed login never revives prior consent. Exit requires a new grant.
		update public.qorpera_runtime_browser_profiles set version=version+1,prepared=false,verified_version=null where id=p_profile_id returning * into v_profile;
		update public.qorpera_runtime_browser_grants set state='revoked',version=version+1,configured_at=clock_timestamp()
			where profile_id=p_profile_id and state='active';
	else
		-- Cancellation is also a fresh drain; loss of membership cannot strand cleanup.
		if v_office.privacy_state not in ('entering','private')
			or v_office.privacy_challenge->>'profileId' is distinct from p_profile_id::text
			or v_office.privacy_challenge->>'memberId' is distinct from auth.uid()::text
			or v_office.privacy_challenge->>'screenId' is distinct from p_screen_id::text then
			raise exception 'Private sign-in differs' using errcode='42501'; end if;
	end if;
	v_drains:=public.qorpera_fence_runtime_office_screens(v_office);
	v_challenge:=jsonb_build_object('scope',p_scope,'computerGeneration',v_office.generation,
		'challengeId',extensions.gen_random_uuid(),'version',v_office.privacy_version+1,
		'state',case when p_private then 'entering' else 'leaving' end,'memberId',auth.uid(),
		'profileId',p_profile_id,'profileVersion',v_profile.version,'screenId',p_screen_id,'drains',v_drains);
	update public.qorpera_runtime_offices set privacy_state=v_challenge->>'state',privacy_version=privacy_version+1,
		privacy_challenge=v_challenge,privacy_owner_membership_version=case when p_private then coalesce((select version from public.qorpera_runtime_browser_membership_revocations
			where profile_id=v_office.profile_id and user_id=auth.uid()),0) else privacy_owner_membership_version end,revision=revision+1 where id=v_office.id;
	insert into public.qorpera_runtime_office_privacy_events(office_id,version,state,challenge)
		values(v_office.id,v_office.privacy_version+1,v_challenge->>'state',v_challenge);
	return v_challenge;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_resolve_failed_execution_run(uuid,text)'::regprocedure), 'sha256'), 'hex') <> '0dc1152b403af13fed3c5cf511c667568b3d287fec3c6c83009af0313eb0aae9' then
		raise exception 'Reviewed function definition changed: qorpera_resolve_failed_execution_run';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_resolve_failed_execution_run(p_run_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_changed integer;
begin
	perform 1 from public.qorpera_runner_jobs job
	join public.qorpera_execution_runs run on run.id=job.run_id and run.job_id=job.id
	where run.id=p_run_id and auth.uid() is not null
	 and public.qorpera_can_write_profile(run.profile_id) for update of job;
	if not found then
		raise exception 'execution recovery requires company write access' using errcode = '42501';
	end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id for update;
	if auth.uid() is null or not found or not public.qorpera_can_write_profile(v_run.profile_id) then
		raise exception 'execution recovery requires company write access' using errcode = '42501';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id for update;
	if v_job.status not in ('failed', 'cancelled')
		or p_action not in ('retry', 'discard')
		or (p_action = 'retry' and v_run.source_kind <> 'session_turn')
		or (p_action = 'discard' and v_run.source_kind = 'proposal_review') then
		raise exception 'execution recovery action is unavailable' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_execution_run_events as resolved
		where resolved.run_id = v_run.id
			and resolved.event_type in ('recovery_released', 'recovery_discarded')
	) then
		raise exception 'execution recovery was already resolved' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_run_operation_receipts as receipt
		where receipt.run_id = v_run.id and receipt.status in ('executing', 'ambiguous')
	) or exists (
		select 1 from public.qorpera_company_proposals as proposal
		where proposal.execution_kind = 'run' and proposal.execution_id = v_run.id
			and proposal.status = 'open'
	) then
		raise exception 'execution recovery still has an unresolved durable outcome' using errcode = '55000';
	end if;
	if p_action = 'retry' then
		if exists (
			select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = v_run.id and receipt.status = 'completed'
		) then
			raise exception 'execution recovery cannot retry work with a durable operation outcome or open proposal' using errcode = '55000';
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = null, failed_at = null, failure_reason = null
		where id = any(v_run.input_ids) and execution_run_id = v_run.id
			and completed_at is null;
		get diagnostics v_changed = row_count;
		if v_changed <> cardinality(v_run.input_ids) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'execution recovery input set changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_released', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid()
		));
		update public.qorpera_shared_sessions set updated_at = statement_timestamp()
		where id = v_run.session_id;
	else
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_discarded', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid()
		));
	end if;
	return jsonb_build_object('run_id', v_run.id, 'action', p_action, 'resolved', true);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_revoke_runner(uuid)'::regprocedure), 'sha256'), 'hex') <> 'bc7c45531f737d82d64a2f01ac90bbbf6c27e7cfed1e1b7dd9299a782c33c941' then
		raise exception 'Reviewed function definition changed: qorpera_revoke_runner';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_revoke_runner(p_runner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_locked_jobs uuid[] := array[]::uuid[];
	v_locked_job uuid;
begin
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_runner.profile_id) then
		raise exception 'runner revocation requires full access' using errcode = '42501';
	end if;
	for v_locked_job in
		select job.id from public.qorpera_runner_jobs as job
		where job.runner_id = p_runner_id and job.status = 'leased'
		order by job.id for update
	loop
		v_locked_jobs := array_append(v_locked_jobs, v_locked_job);
	end loop;
	select runner.* into strict v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id for update;
	if not public.qorpera_can_authorize_profile(v_runner.profile_id) then
		raise exception 'runner administration requires full access' using errcode = '42501';
	end if;
	if exists (select 1 from public.qorpera_runner_jobs as job
		where job.runner_id = p_runner_id and job.status = 'leased'
			and not (job.id = any(v_locked_jobs))) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01',
			'message', 'Runner leases changed before administration', 'details', null, 'hint', null)::text,
			detail = '{"status":409,"headers":{}}';
	end if;
	if v_runner.status = 'revoked' then return public.qorpera_runner_json(v_runner); end if;
	for v_job in
		select job.* from public.qorpera_runner_jobs as job
		where job.runner_id = p_runner_id and job.status = 'leased'
	loop
		perform public.qorpera_terminalize_runner_attempt(
			v_job.id, 'failed', 'Runner was revoked before completion', true
		);
		select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_job.id;
		perform public.qorpera_append_runner_audit(
			v_job.profile_id, p_runner_id, v_job.id,
			case when v_job.status = 'queued' then 'job_requeued' else 'job_failed' end,
			jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'runner_revoked'), v_user_id
		);
	end loop;
	update public.qorpera_runners
	set status = 'revoked', session_token_sha256 = null, session_expires_at = null,
		previous_session_token_sha256 = null, previous_session_expires_at = null,
		last_renewal_id = null, revoked_by_user_id = v_user_id,
		revoked_at = statement_timestamp()
	where id = p_runner_id returning * into v_runner;
	perform public.qorpera_append_runner_audit(
		v_runner.profile_id, v_runner.id, null, 'runner_revoked', '{}'::jsonb, v_user_id
	);
	return public.qorpera_runner_json(v_runner);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runner_append_company_revision_graph(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure), 'sha256'), 'hex') <> 'b7851d792d29af51e4f691f06f76731470d9c1ef7b75813e09436a56ba1d3a0a' then
		raise exception 'Reviewed function definition changed: qorpera_runner_append_company_revision_graph';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runner_append_company_revision_graph(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_assignment_id uuid, p_graph_id uuid, p_entries jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_input_count integer;
	v_valid_count integer;
begin
	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot' for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner Company File graph is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	v_snapshot := public.qorpera_runner_company_revision_snapshot(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, v_graph.root_id
	);
	if v_graph.status <> 'uploading' or jsonb_typeof(p_entries) <> 'array'
		or jsonb_array_length(p_entries) not between 1 and 500 then
		raise exception 'runner Company File graph page is invalid' using errcode = '22023';
	end if;
	select count(*), count(*) filter (
		where entry.sha256 ~ '^[0-9a-f]{64}$' and entry.bytes between 0 and 8388608
	) into v_input_count, v_valid_count
	from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint);
	if v_input_count <> jsonb_array_length(p_entries) or v_valid_count <> v_input_count
		or v_input_count <> (
			select count(distinct entry.sha256)
			from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
		) or exists (
			select 1 from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
			left join public.qorpera_profile_objects as object
				on object.profile_id = v_snapshot.profile_id and object.sha256 = entry.sha256
			where object.profile_id is null or object.bytes <> entry.bytes
		) or exists (
			select 1 from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
			join public.qorpera_object_reachability_entries as existing
				on existing.graph_id = p_graph_id and existing.object_sha256 = entry.sha256
			where existing.bytes <> entry.bytes
		) then
		raise exception 'runner Company File graph page is invalid' using errcode = '22023';
	end if;
	insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
	select p_graph_id, entry.sha256, entry.bytes
	from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
	order by entry.sha256 on conflict (graph_id, object_sha256) do nothing;
	select count(*) into v_input_count from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = p_graph_id;
	if v_input_count > v_graph.object_count then
		raise exception 'runner Company File graph exceeds its declared size' using errcode = '22023';
	end if;
	return v_input_count;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runner_broker_finalize_model_request(uuid,text,uuid,text,uuid,text,text,bigint,bigint,bigint,jsonb,text)'::regprocedure), 'sha256'), 'hex') <> '5d61722c7874b665774944a920d50779369239d8c807139b88f6e28bcfe335c9' then
		raise exception 'Reviewed function definition changed: qorpera_runner_broker_finalize_model_request';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runner_broker_finalize_model_request(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_request_id uuid, p_request_sha256 text, p_outcome text, p_input_tokens bigint, p_output_tokens bigint, p_cost_microusd bigint, p_response jsonb, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_policy public.qorpera_runner_model_policies%rowtype;
	v_request public.qorpera_runner_model_requests%rowtype;
	v_observation public.qorpera_runner_model_usage_observations%rowtype;
	v_reservation public.qorpera_execution_sponsor_reservations%rowtype;
	v_response jsonb;
	v_cost_used bigint;
	v_effective_outcome text;
	v_effective_error_code text;
	v_budget_exceeded boolean := false;
begin
	if auth.role() <> 'service_role' or p_session_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_token_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'runner model finalization is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
		and (
			(job.status = 'leased' and job.lease_token_sha256 = p_lease_token_sha256)
			or (job.status in ('completed', 'failed', 'cancelled')
				and job.terminal_lease_token_sha256 = p_lease_token_sha256)
		)
	for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner model finalization authority is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select policy.* into v_policy
	from public.qorpera_runner_model_policies as policy where policy.job_id = v_job.id for update;
	select request.* into v_request
	from public.qorpera_runner_model_requests as request
	where request.job_id = v_job.id and request.client_request_id = p_request_id
	for update;
	if not found or v_request.runner_id <> p_runner_id or v_request.request_sha256 <> p_request_sha256 then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner model reservation is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if coalesce(p_outcome, '') not in ('completed', 'failed')
		or p_input_tokens is null or p_input_tokens not between 0 and 100000000
		or p_output_tokens is null or p_output_tokens not between 0 and 100000000
		or p_cost_microusd is null or p_cost_microusd not between 0 and 9007199254740991
		or (p_outcome = 'completed' and (p_error_code is not null or pg_column_size(coalesce(p_response, 'null'::jsonb)) > 589824))
		or (p_outcome = 'failed' and (
			p_response is not null
			or p_error_code is null
			or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$'
			or char_length(p_error_code) > 64
		)) then
		raise exception 'runner model result is invalid' using errcode = '22023';
	end if;
	if v_job.run_id is not null then
		select reservation.* into strict v_reservation
		from public.qorpera_execution_sponsor_reservations as reservation
		where reservation.run_id = v_job.run_id
		for update;
		select coalesce(sum(observation.cost_microusd), 0) into v_cost_used
		from public.qorpera_runner_model_usage_observations as observation
		where observation.job_id = v_job.id and observation.request_id <> v_request.id;
		v_budget_exceeded := v_cost_used + p_cost_microusd
			> least(v_policy.max_cost_microusd, v_reservation.reserved_microusd);
	end if;
	v_effective_outcome := case when v_budget_exceeded then 'failed' else p_outcome end;
	v_effective_error_code := case when v_budget_exceeded then 'gateway_cost_exceeded' else p_error_code end;
	v_response := case when v_effective_outcome = 'completed' then jsonb_build_object(
		'request_id', v_request.client_request_id,
		'provider', v_request.provider,
		'model', v_request.model,
		'output', coalesce(p_response, 'null'::jsonb),
		'usage', jsonb_build_object(
			'input_tokens', p_input_tokens,
			'output_tokens', p_output_tokens,
			'cost_microusd', p_cost_microusd
		)
	) else null end;

	if v_request.status not in ('reserved', 'ambiguous') then
		select observation.* into strict v_observation
		from public.qorpera_runner_model_usage_observations as observation
		where observation.request_id = v_request.id;
		if v_request.status <> v_effective_outcome
			or v_request.response is distinct from v_response
			or v_request.error_code is distinct from v_effective_error_code
			or v_observation.input_tokens <> p_input_tokens
			or v_observation.output_tokens <> p_output_tokens
			or v_observation.cost_microusd <> p_cost_microusd then
			raise exception 'runner model result replay differs' using errcode = '23505';
		end if;
		return coalesce(v_request.response, jsonb_build_object('state', 'failed'));
	end if;
	update public.qorpera_runner_model_requests
	set status = v_effective_outcome, response = v_response,
		error_code = v_effective_error_code, finalized_at = statement_timestamp()
	where id = v_request.id returning * into v_request;
	insert into public.qorpera_runner_model_usage_observations (
		request_id, profile_id, environment_id, job_id, runner_id,
		actor_user_id, authorized_by_user_id, provider, model,
		outcome, input_tokens, output_tokens, cost_microusd
	) values (
		v_request.id, v_request.profile_id, v_request.environment_id, v_request.job_id, v_request.runner_id,
		v_request.actor_user_id, v_request.authorized_by_user_id, v_request.provider, v_request.model,
		v_effective_outcome, p_input_tokens, p_output_tokens, p_cost_microusd
	);
	if v_budget_exceeded then
		perform public.qorpera_terminalize_runner_attempt(
			v_job.id, 'failed', 'Model gateway reported cost above the reserved run budget', false
		);
	end if;
	if v_job.run_id is not null and not exists (
		select 1 from public.qorpera_runner_model_requests as request
		where request.job_id = v_job.id and request.status = 'reserved'
	) and (select job.status from public.qorpera_runner_jobs as job where job.id = v_job.id)
		in ('completed', 'failed', 'cancelled') then
		update public.qorpera_execution_sponsor_reservations as reservation
		set status = 'settled', actual_microusd = coalesce((
				select sum(observation.cost_microusd)
				from public.qorpera_runner_model_usage_observations as observation
				where observation.job_id = v_job.id
			), 0), settled_at = statement_timestamp()
		where reservation.run_id = v_job.run_id and reservation.status in ('reserved', 'settled');
	end if;
	return coalesce(v_response, jsonb_build_object('state', 'failed'));
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runner_broker_job(uuid,text,uuid,text)'::regprocedure), 'sha256'), 'hex') <> 'eaaa29dcee438a2c9f540da9897f2599ded7c083012befb6e694aa02d01d9c55' then
		raise exception 'Reviewed function definition changed: qorpera_runner_broker_job';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runner_broker_job(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text)
 RETURNS qorpera_runner_jobs
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role' and session_user <> 'qorpera_secret_broker'
		or p_session_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner broker authorization is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
		and job.status = 'leased' and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp();
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_job.run_id is not null then
		select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if not found or v_run.deadline_at <= statement_timestamp()
			or not public.qorpera_execution_sponsor_available(v_run)
			or not public.qorpera_execution_compute_available(v_run) then
			raise exception 'runner execution sponsor is unavailable' using errcode = '42501';
		end if;
	end if;
	return v_job;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runner_broker_locked_job(uuid,text,uuid,text)'::regprocedure), 'sha256'), 'hex') <> 'dd565b29460564ee6c40ab5a24d1c9c7796b5e0d39aadc95f21699623a8dca68' then
		raise exception 'Reviewed function definition changed: qorpera_runner_broker_locked_job';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runner_broker_locked_job(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text)
 RETURNS qorpera_runner_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
		and job.status = 'leased' and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp()
	for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_job.run_id is not null then
		select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if v_run.deadline_at <= statement_timestamp()
			or not public.qorpera_execution_sponsor_available(v_run)
			or not public.qorpera_execution_compute_available(v_run) then
			raise exception 'runner execution sponsor is unavailable' using errcode = '42501';
		end if;
	end if;
	return v_job;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runner_company_revision_snapshot(uuid,text,uuid,text,uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> 'a5432e1644c6567f9d7d69b10f8b67179457ee534b030769a1a3f4e78d382ab1' then
		raise exception 'Reviewed function definition changed: qorpera_runner_company_revision_snapshot';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runner_company_revision_snapshot(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_assignment_id uuid, p_snapshot_id uuid)
 RETURNS qorpera_company_snapshots
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	join public.qorpera_company_snapshot_publications as publication on publication.snapshot_id = snapshot.id
	where snapshot.id = p_snapshot_id and snapshot.profile_id = v_run.profile_id
		and snapshot.environment_id = v_run.environment_id
		and snapshot.parent_snapshot_id is not distinct from v_run.company_snapshot_id
		and publication.expected_head_snapshot_id is not distinct from v_run.company_snapshot_id
		and publication.status = 'prepared';
	if not found or not exists (
		select 1 from public.qorpera_runner_assignments as assignment
		where assignment.id = p_assignment_id and assignment.job_id = v_job.id
			and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
			and assignment.status = 'accepted'
	) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner Company File revision is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return v_snapshot;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runner_complete_company_revision_graph(uuid,text,uuid,text,uuid,uuid)'::regprocedure), 'sha256'), 'hex') <> '8495f3728b210c82297be26447e475b20a70e4beccaf18e73a092ce550cf337b' then
		raise exception 'Reviewed function definition changed: qorpera_runner_complete_company_revision_graph';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runner_complete_company_revision_graph(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid, p_lease_token_sha256 text, p_assignment_id uuid, p_graph_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_object_count integer;
	v_storage_bytes bigint;
	v_content_sha256 text;
begin
	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot' for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner Company File graph is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	v_snapshot := public.qorpera_runner_company_revision_snapshot(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, v_graph.root_id
	);
	if v_graph.status = 'complete' then
		return public.qorpera_object_reachability_graph_json(v_graph);
	end if;
	select count(*), coalesce(sum(entry.bytes), 0), encode(
		extensions.digest(convert_to(coalesce(string_agg(
			entry.object_sha256 || ':' || entry.bytes::text, E'\n' order by entry.object_sha256
		), ''), 'utf8'), 'sha256'), 'hex'
	) into v_object_count, v_storage_bytes, v_content_sha256
	from public.qorpera_object_reachability_entries as entry where entry.graph_id = p_graph_id;
	if v_object_count <> v_graph.object_count or v_storage_bytes <> v_graph.storage_bytes
		or v_content_sha256 <> v_graph.content_sha256
		or not exists (
			select 1 from public.qorpera_object_reachability_entries as entry
			where entry.graph_id = p_graph_id and entry.object_sha256 = v_graph.root_object_sha256
		) or not public.qorpera_object_graph_objects_available(p_graph_id) then
		raise exception 'runner Company File graph does not match its declaration' using errcode = '22023';
	end if;
	update public.qorpera_object_reachability_graphs
	set status = 'complete', completed_at = statement_timestamp()
	where id = p_graph_id returning * into v_graph;
	return public.qorpera_object_reachability_graph_json(v_graph);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_set_company_machine_limit(uuid,integer,bigint)'::regprocedure), 'sha256'), 'hex') <> 'd3c71431004ddbd3a2ef7e8b5217cc17cb99a3cb0165706632f977bbd0323a4d' then
		raise exception 'Reviewed function definition changed: qorpera_set_company_machine_limit';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_set_company_machine_limit(p_profile_id uuid, p_max_machines integer, p_expected_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_version bigint;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_max_machines is null
		or p_max_machines not between 1 and 64 or p_expected_version is null or p_expected_version<0 then
		raise exception 'Invalid machine ceiling' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	perform 1 from public.qorpera_profile_members where profile_id=p_profile_id and user_id=auth.uid() and role in ('owner','admin') for share;
	if not found then raise exception 'Machine ceiling requires founder authority' using errcode='42501'; end if;
	select version into v_version from public.qorpera_company_machine_limits where profile_id=p_profile_id for update;
	if coalesce(v_version,0)<>p_expected_version then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Machine ceiling version changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	insert into public.qorpera_company_machine_limits(profile_id,max_machines,version,updated_by_user_id)
	values(p_profile_id,p_max_machines,1,auth.uid()) on conflict(profile_id) do update
		set max_machines=excluded.max_machines,version=qorpera_company_machine_limits.version+1,updated_by_user_id=auth.uid();
	return public.qorpera_company_machine_capacity(p_profile_id);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_set_runtime_browser_grant(jsonb,uuid,uuid,bigint,bigint,boolean)'::regprocedure), 'sha256'), 'hex') <> 'b37b7036471e4c181a59512f7e9876e113b6fbe319e2c13d08121633d5103a08' then
		raise exception 'Reviewed function definition changed: qorpera_set_runtime_browser_grant';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_set_runtime_browser_grant(p_scope jsonb, p_profile_id uuid, p_staff_agent_id uuid, p_profile_version bigint, p_expected_version bigint, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_profile public.qorpera_runtime_browser_profiles%rowtype;
	v_grant public.qorpera_runtime_browser_grants%rowtype; v_drains jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_enabled is null then
		raise exception 'Browser owner required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
		raise exception 'Browser office differs' using errcode='42501'; end if;
	select * into v_profile from public.qorpera_runtime_browser_profiles where id=p_profile_id and office_id=v_office.id for update;
	if not found or v_profile.owner_user_id<>auth.uid() then raise exception 'Browser owner required' using errcode='42501'; end if;
	if v_profile.version is distinct from p_profile_version then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Browser profile changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	select * into v_grant from public.qorpera_runtime_browser_grants where profile_id=p_profile_id and staff_agent_id=p_staff_agent_id for update;
	if coalesce(v_grant.version,0) is distinct from p_expected_version then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Browser grant changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	if p_enabled then
		perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
		if not found or v_office.state<>'active' or v_office.privacy_state<>'shared' or not v_profile.prepared
			or exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and (drain_pending or takeover_user_id is not null))
			or not exists(select 1 from public.qorpera_runtime_office_access where office_id=v_office.id and staff_agent_id=p_staff_agent_id and state='active')
			or not exists(select 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id and staff_agent_id=p_staff_agent_id and employment_status='active') then
			raise exception 'Browser grant unavailable' using errcode='42501'; end if;
	end if;
	insert into public.qorpera_runtime_browser_grants(profile_id,office_id,staff_agent_id,profile_version,owner_membership_version,state)
	values(p_profile_id,v_office.id,p_staff_agent_id,v_profile.version,coalesce((select version from public.qorpera_runtime_browser_membership_revocations
		where profile_id=v_office.profile_id and user_id=auth.uid()),0),case when p_enabled then 'active' else 'revoked' end)
	on conflict(profile_id,staff_agent_id) do update set version=qorpera_runtime_browser_grants.version+1,
		profile_version=excluded.profile_version,owner_membership_version=excluded.owner_membership_version,state=excluded.state,configured_at=clock_timestamp() returning * into v_grant;
	-- Even idle browser channels must close before a replacement starts.
	-- A private office is already fenced; do not replace its pending challenge.
	v_drains:=case when v_office.privacy_state='shared' then public.qorpera_fence_runtime_office_screens(v_office,p_staff_agent_id) else '[]'::jsonb end;
	update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
	return jsonb_build_object('profileId',v_profile.id,'grantId',v_grant.id,'version',v_grant.version,'state',v_grant.state,'drains',v_drains);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_set_runtime_office_access(uuid,uuid,bigint,boolean)'::regprocedure), 'sha256'), 'hex') <> '464ae0345e331802a8eb5e5b46223f07c596e433c4e8561353889d6588fb07e0' then
		raise exception 'Reviewed function definition changed: qorpera_set_runtime_office_access';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_set_runtime_office_access(p_office_id uuid, p_staff_agent_id uuid, p_expected_version bigint, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_enabled is null
		or p_expected_version is null or p_expected_version<0 then
		raise exception 'Invalid shared office grant' using errcode='42501';
	end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=p_office_id;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=p_office_id for update;
	if v_office.state='retired' or not exists(select 1 from public.qorpera_profile_members
		where profile_id=v_office.profile_id and user_id=auth.uid() and role in ('owner','admin'))
		or not exists(select 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id
			and staff_agent_id=p_staff_agent_id and employment_status='active') then
		raise exception 'Shared office grant is unavailable' using errcode='42501';
	end if;
	select * into v_access from public.qorpera_runtime_office_access
		where office_id=p_office_id and staff_agent_id=p_staff_agent_id for update;
	if coalesce(v_access.version,0)<>p_expected_version then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Shared office grant version changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	insert into public.qorpera_runtime_office_access(office_id,staff_agent_id,profile_id,state,capabilities,configured_by_user_id)
	values(p_office_id,p_staff_agent_id,v_office.profile_id,case when p_enabled then 'active' else 'revoked' end,'["shell"]',auth.uid())
	on conflict(office_id,staff_agent_id) do update set version=qorpera_runtime_office_access.version+1,
		state=excluded.state,configured_by_user_id=excluded.configured_by_user_id
	returning * into v_access;
	return jsonb_build_object('grantId',v_access.grant_id,'version',v_access.version,'state',v_access.state);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_set_runtime_office_provider(jsonb,bigint,uuid,text,bigint,boolean)'::regprocedure), 'sha256'), 'hex') <> 'b4fb73c87c73dd11463e7af11e865587f442a47ccc7dc4f7c706c04753d119a5' then
		raise exception 'Reviewed function definition changed: qorpera_set_runtime_office_provider';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_set_runtime_office_provider(p_scope jsonb, p_computer_generation bigint, p_provider_id uuid, p_policy_sha256 text, p_expected_version bigint, p_preparation_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_provider public.qorpera_runtime_office_providers%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_provider_id is null or coalesce(p_policy_sha256,'') !~ '^[0-9a-f]{64}$'
		or p_computer_generation is null or p_computer_generation not between 1 and 9007199254740991
		or p_expected_version is null or p_expected_version not between 0 and 9007199254740990 or p_preparation_enabled is null then
		raise exception 'Invalid office provider enrollment' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office provider scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation then
		raise exception 'Office provider scope differs' using errcode='42501'; end if;
	select * into v_provider from public.qorpera_runtime_office_providers where office_id=v_office.id
		and computer_generation=v_office.generation for update;
	if not found then
		if p_expected_version<>0 or not p_preparation_enabled or v_office.state not in ('provisioning','recovering')
			or exists(select 1 from public.qorpera_runtime_machine_allocations where office_id=v_office.id
				and computer_generation=v_office.generation) then
			raise exception 'Office provider cannot adopt an allocated generation' using errcode='42501'; end if;
		insert into public.qorpera_runtime_office_providers(office_id,computer_generation,provider_id,policy_sha256,version,preparation_enabled)
		values(v_office.id,v_office.generation,p_provider_id,p_policy_sha256,1,true) returning * into v_provider;
	else
		if v_provider.provider_id<>p_provider_id or v_provider.policy_sha256<>p_policy_sha256 then
			raise exception 'Office provider cannot be rebound' using errcode='42501'; end if;
		if v_provider.version<>p_expected_version then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Office provider version differs', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
		update public.qorpera_runtime_office_providers set version=version+1,preparation_enabled=p_preparation_enabled
			where office_id=v_office.id and computer_generation=v_office.generation returning * into v_provider;
	end if;
	return jsonb_build_object('providerId',v_provider.provider_id,'policySha256',v_provider.policy_sha256,
		'computerGeneration',v_provider.computer_generation,'version',v_provider.version,'preparationEnabled',v_provider.preparation_enabled);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_submit_company_proposal(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,text,uuid[])'::regprocedure), 'sha256'), 'hex') <> 'fd998525b80d4168b8dbd718e2cc36b75914f00e45f8939c8fe60ebb1bd0b5e9' then
		raise exception 'Reviewed function definition changed: qorpera_submit_company_proposal';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_submit_company_proposal(p_environment_id uuid, p_client_proposal_id uuid, p_proposal_snapshot_id uuid, p_execution_kind text, p_execution_id uuid, p_execution_claimant_id uuid, p_session_id uuid, p_trail_end_sequence bigint, p_reason text, p_policy_key text, p_title text, p_reviewer_staff_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_user_id uuid := auth.uid();
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_publication public.qorpera_company_snapshot_publications%rowtype;
	v_turn public.qorpera_session_turns%rowtype;
	v_wake public.qorpera_wake_claims%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_base_snapshot_id uuid;
	v_completed integer;
begin
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = p_environment_id
	for share;
	if v_user_id is null or not found or not public.qorpera_can_write_profile(v_file.profile_id) then
		raise exception 'company proposal write access is required' using errcode = '42501';
	end if;
	if p_client_proposal_id is null or p_proposal_snapshot_id is null
		or p_execution_kind not in ('turn', 'wake')
		or p_execution_id is null or p_execution_claimant_id is null
		or p_session_id is null or p_trail_end_sequence < 0
		or p_reason not in ('policy', 'authority', 'conflict', 'recovery')
		or char_length(btrim(p_title)) not between 1 and 256
		or (p_policy_key is not null and char_length(btrim(p_policy_key)) not between 1 and 128)
		or cardinality(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) > 20 then
		raise exception 'company proposal is invalid' using errcode = '22023';
	end if;
	-- A committed submission may have transitioned the execution before its
	-- response reached the client. Resolve exact replays before requiring the
	-- now-finished lease so retry remains idempotent after process/network loss.
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.profile_id = v_file.profile_id
		and proposal.client_proposal_id = p_client_proposal_id;
	if found then
		if v_proposal.proposal_snapshot_id <> p_proposal_snapshot_id
			or v_proposal.execution_kind <> p_execution_kind
			or v_proposal.execution_id <> p_execution_id
			or v_proposal.execution_claimant_id <> p_execution_claimant_id
			or v_proposal.session_id <> p_session_id
			or v_proposal.trail_end_sequence <> p_trail_end_sequence
			or v_proposal.reason <> p_reason
			or v_proposal.policy_key is distinct from nullif(btrim(p_policy_key), '')
			or v_proposal.title <> btrim(p_title)
			or v_proposal.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[])
			or v_proposal.created_by_user_id <> v_user_id then
			raise exception 'company proposal id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_company_proposal_json(v_proposal);
	end if;
	if exists (
		select 1 from unnest(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) as requested(staff_agent_id)
		where not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = v_file.profile_id
				and staff.staff_agent_id = requested.staff_agent_id
				and staff.employment_status = 'active'
		)
	) then
		raise exception 'company proposal reviewer is unavailable' using errcode = '22023';
	end if;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	join public.qorpera_company_snapshot_publications as publication on publication.snapshot_id = snapshot.id
	where snapshot.id = p_proposal_snapshot_id
		and snapshot.profile_id = v_file.profile_id
		and snapshot.environment_id = v_file.environment_id
		and snapshot.workspace_id = v_file.canonical_workspace_id
		and publication.status = 'prepared';
	if not found then
		raise exception 'company proposal snapshot is not durably verified' using errcode = '55000';
	end if;
	select publication.* into strict v_publication
	from public.qorpera_company_snapshot_publications as publication
	where publication.snapshot_id = v_snapshot.id;
	if not public.qorpera_object_root_has_current_proof('company_snapshot', v_snapshot.id)
		or v_publication.restricted_content_sha256 is null then
		raise exception 'company proposal snapshot is not durably verified' using errcode = '55000';
	end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id and session.profile_id = v_file.profile_id;
	if not found then
		raise exception 'company proposal session is invalid' using errcode = '22023';
	end if;

	if p_execution_kind = 'turn' then
		select turn.* into v_turn
		from public.qorpera_session_turns as turn
		where turn.id = p_execution_id and turn.session_id = p_session_id
		for update;
		if not found or v_turn.claimant_id <> p_execution_claimant_id
			or v_turn.claimed_by_user_id <> v_user_id
			or v_turn.status <> 'active'
			or v_turn.lease_expires_at <= statement_timestamp() then
			raise exception 'live proposal execution is required' using errcode = '42501';
		end if;
		v_base_snapshot_id := v_turn.company_snapshot_id;
		if p_trail_end_sequence < v_turn.trail_start_sequence
			or (p_trail_end_sequence > 0 and not exists (
				select 1 from public.qorpera_session_events as event
				where event.session_id = p_session_id and event.sequence = p_trail_end_sequence
			))
			or exists (
				select 1 from public.qorpera_session_events as event
				where event.session_id = p_session_id
					and event.sequence > v_turn.trail_start_sequence
					and event.sequence <= p_trail_end_sequence
					and (
						event.execution_kind is distinct from 'turn'
						or event.execution_id is distinct from v_turn.id
						or event.execution_claimant_id is distinct from v_turn.claimant_id
					)
			)
			or (
				select count(*) from public.qorpera_session_events as event
				where event.session_id = p_session_id
					and event.sequence > v_turn.trail_start_sequence
					and event.sequence <= p_trail_end_sequence
			) <> p_trail_end_sequence - v_turn.trail_start_sequence then
			raise exception 'company proposal trail boundary is invalid' using errcode = '22023';
		end if;
	else
		select claim.* into v_wake
		from public.qorpera_wake_claims as claim
		where claim.execution_id = p_execution_id and claim.profile_id = v_file.profile_id
		for update;
		if not found or v_wake.claimant_id <> p_execution_claimant_id
			or v_wake.claimed_by_user_id <> v_user_id
			or v_wake.completed_at is not null
			or v_wake.claim_expires_at <= statement_timestamp() then
			raise exception 'live proposal execution is required' using errcode = '42501';
		end if;
		v_base_snapshot_id := v_wake.company_snapshot_id;
		if exists (
			select 1 from public.qorpera_session_events as event
			where event.session_id = p_session_id and event.sequence <= p_trail_end_sequence
				and event.event_type <> 'session_info'
				and (
					event.execution_kind is distinct from 'wake'
					or event.execution_id is distinct from v_wake.execution_id
					or event.execution_claimant_id is distinct from v_wake.claimant_id
				)
		) then
			raise exception 'company proposal trail boundary is invalid' using errcode = '22023';
		end if;
	end if;
	if v_snapshot.parent_snapshot_id is distinct from v_base_snapshot_id
		or v_publication.expected_head_snapshot_id is distinct from v_base_snapshot_id then
		raise exception 'company proposal does not match its execution snapshot' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_operation_receipts as receipt
		where receipt.profile_id = v_file.profile_id
			and receipt.execution_kind = p_execution_kind
			and receipt.execution_id = p_execution_id
			and receipt.status = 'executing'
	) then
		raise exception 'company proposal has an unresolved operation receipt' using errcode = '55000';
	end if;

	insert into public.qorpera_company_proposals (
		profile_id, environment_id, client_proposal_id, base_snapshot_id,
		proposal_snapshot_id, execution_kind, execution_id, execution_claimant_id,
		session_id, trail_end_sequence, reason, policy_key, title,
		reviewer_staff_ids, created_by_user_id
	) values (
		v_file.profile_id, v_file.environment_id, p_client_proposal_id, v_base_snapshot_id,
		v_snapshot.id, p_execution_kind, p_execution_id, p_execution_claimant_id,
		p_session_id, p_trail_end_sequence, p_reason, nullif(btrim(p_policy_key), ''),
		btrim(p_title), coalesce(p_reviewer_staff_ids, '{}'::uuid[]), v_user_id
	)
	on conflict (profile_id, client_proposal_id) do nothing
	returning * into v_proposal;
	if not found then
		select proposal.* into strict v_proposal
		from public.qorpera_company_proposals as proposal
		where proposal.profile_id = v_file.profile_id and proposal.client_proposal_id = p_client_proposal_id;
		if v_proposal.proposal_snapshot_id <> p_proposal_snapshot_id
			or v_proposal.execution_kind <> p_execution_kind
			or v_proposal.execution_id <> p_execution_id
			or v_proposal.execution_claimant_id <> p_execution_claimant_id
			or v_proposal.session_id <> p_session_id
			or v_proposal.trail_end_sequence <> p_trail_end_sequence
			or v_proposal.reason <> p_reason
			or v_proposal.policy_key is distinct from nullif(btrim(p_policy_key), '')
			or v_proposal.title <> btrim(p_title)
			or v_proposal.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[])
			or v_proposal.created_by_user_id <> v_user_id then
			raise exception 'company proposal id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_company_proposal_json(v_proposal);
	end if;

	if p_execution_kind = 'turn' then
		update public.qorpera_session_inputs
		set completed_at = statement_timestamp(), claim_expires_at = null
		where turn_id = p_execution_id and completed_at is null and failed_at is null;
		get diagnostics v_completed = row_count;
		if v_completed <> cardinality(v_turn.input_ids) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'company proposal inputs changed before submission', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		update public.qorpera_session_turns
		set status = 'review_pending', completed_at = statement_timestamp(),
			trail_end_sequence = p_trail_end_sequence
		where id = p_execution_id;
	else
		update public.qorpera_wake_claims
		set completed_at = statement_timestamp()
		where execution_id = p_execution_id;
	end if;
	return public.qorpera_company_proposal_json(v_proposal);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_verify_company_path_file(uuid,text)'::regprocedure), 'sha256'), 'hex') <> '5209c8558f28cea0d474890e1f2ae4f8ae0640ff7c8a72d2e2286c5419fc9b1e' then
		raise exception 'Reviewed function definition changed: qorpera_verify_company_path_file';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_verify_company_path_file(p_profile_id uuid, p_manifest_text text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_manifest jsonb; v_sha text; v_objects jsonb; v_bytes integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File verifier authority is required' using errcode = '42501'; end if;
	v_bytes := octet_length(p_manifest_text);
	if p_manifest_text is null or v_bytes not between 1 and 8388608 then
		raise exception 'Company File manifest is invalid' using errcode = '22023'; end if;
	v_manifest := p_manifest_text::jsonb;
	v_sha := encode(extensions.digest(convert_to(p_manifest_text,'utf8'),'sha256'),'hex');
	if v_manifest ->> 'schema' is distinct from 'qorpera.cloud-file-manifest/v1'
		or v_manifest - array['schema','fileSha256','bytes','mediaType','chunks'] <> '{}'::jsonb
		or not public.qorpera_company_path_entry_valid(jsonb_build_object('kind','file','path','verified',
			'executable',false,'file',jsonb_build_object('manifestSha256',v_sha,
				'fileSha256',v_manifest -> 'fileSha256','bytes',v_manifest -> 'bytes','mediaType',v_manifest -> 'mediaType')))
		or jsonb_typeof(v_manifest -> 'chunks') is distinct from 'array' then
		raise exception 'Company File manifest is invalid' using errcode = '22023'; end if;
	-- This existing verified-file cache has a 256 MiB/64-chunk contract. The
	-- model tools are ranged; expanding the storage codec is a separate change.
	if jsonb_array_length(v_manifest -> 'chunks') > 64 or (v_manifest ->> 'bytes')::bigint > 268435456
		or exists (select 1 from jsonb_array_elements(v_manifest -> 'chunks') with ordinality as c(value,n)
			where jsonb_typeof(value) <> 'object' or value - array['sha256','bytes'] <> '{}'::jsonb
				or coalesce(value ->> 'sha256','') !~ '^[0-9a-f]{64}$'
				or coalesce(value ->> 'bytes','') !~ '^[1-9][0-9]{0,6}$'
				or jsonb_typeof(value -> 'bytes') <> 'number'
				or (value ->> 'bytes')::bigint > 4194304
				or (n < jsonb_array_length(v_manifest -> 'chunks') and (value ->> 'bytes')::bigint <> 4194304))
		or (select coalesce(sum((value ->> 'bytes')::bigint),0) from jsonb_array_elements(v_manifest -> 'chunks'))
			<> (v_manifest ->> 'bytes')::bigint then
		raise exception 'Company File chunks are invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company File storage is busy', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	select jsonb_agg(object order by object ->> 'sha256') into v_objects from (
		select distinct value as object from jsonb_array_elements(v_manifest -> 'chunks')
		union select jsonb_build_object('sha256',v_sha,'bytes',v_bytes)
	) as closure;
	if exists (select 1 from jsonb_array_elements(v_objects) as o(value)
		left join public.qorpera_profile_objects as stored
			on stored.profile_id = p_profile_id and stored.sha256 = o.value ->> 'sha256'
		where stored.sha256 is null or stored.bytes <> (o.value ->> 'bytes')::bigint) then
		raise exception 'Company File objects are unavailable' using errcode = '55000'; end if;
	insert into public.qorpera_verified_company_file_objects (
		profile_id,manifest_sha256,manifest_bytes,file_sha256,bytes,media_type,objects
	) values (p_profile_id,v_sha,v_bytes,v_manifest ->> 'fileSha256',(v_manifest ->> 'bytes')::bigint,
		'application/octet-stream',v_objects)
	on conflict (profile_id,manifest_sha256,verifier_version) do update
	set verified_at = clock_timestamp(), objects = excluded.objects
	where qorpera_verified_company_file_objects.file_sha256 = excluded.file_sha256
		and qorpera_verified_company_file_objects.bytes = excluded.bytes
		and qorpera_verified_company_file_objects.manifest_bytes = excluded.manifest_bytes
		and qorpera_verified_company_file_objects.media_type = excluded.media_type
		and qorpera_verified_company_file_objects.objects @> excluded.objects
		and qorpera_verified_company_file_objects.objects <@ excluded.objects;
	if not found then raise exception 'Company File verification differs' using errcode = '23505'; end if;
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_verify_company_path_tree(uuid,text)'::regprocedure), 'sha256'), 'hex') <> '0eb4dd5b030211ff577ba8138ae5f1ebb254c4e468998020c2362f9baf635fc4' then
		raise exception 'Reviewed function definition changed: qorpera_verify_company_path_tree';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_verify_company_path_tree(p_profile_id uuid, p_manifest_text text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tree jsonb; v_sha text; v_count integer; v_total bigint; v_entries jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File verifier authority is required' using errcode = '42501'; end if;
	if p_manifest_text is null or octet_length(p_manifest_text) not between 1 and 8388608 then
		raise exception 'Company File tree is invalid' using errcode = '22023'; end if;
	v_tree := p_manifest_text::jsonb; v_entries := v_tree -> 'entries';
	v_sha := encode(extensions.digest(convert_to(p_manifest_text,'utf8'),'sha256'),'hex');
	if v_tree ->> 'schema' is distinct from 'qorpera.company-tree/v1'
		or v_tree -> 'contractVersion' is distinct from '3'::jsonb
		or v_tree - array['schema','contractVersion','omittedLayers','entries'] <> '{}'::jsonb
		or v_tree -> 'omittedLayers' is distinct from '["company-git-history","session-trail","staff-registry", "product-git-checkouts","dependency-caches","staff-instructions","system-metadata"]'::jsonb
		or jsonb_typeof(v_entries) is distinct from 'array' then
		raise exception 'Company File tree is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(v_entries) > 50000
		or exists (select 1 from jsonb_array_elements(v_entries) where not public.qorpera_company_path_entry_valid(value))
		or (select count(distinct public.qorpera_company_path_key(value ->> 'path')) from jsonb_array_elements(v_entries)) <> jsonb_array_length(v_entries)
		or exists (select 1 from jsonb_array_elements(v_entries) child
			where strpos(child ->> 'path','/') > 0 and not exists (
				select 1 from jsonb_array_elements(v_entries) parent where parent ->> 'kind' = 'directory'
					and parent ->> 'path' = regexp_replace(child ->> 'path','/[^/]+$','')))
		then raise exception 'Company File tree paths are invalid' using errcode = '22023'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company File storage is busy', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	if not exists (select 1 from public.qorpera_profile_objects where profile_id = p_profile_id
		and sha256 = v_sha and bytes = octet_length(p_manifest_text))
		or exists (select 1 from jsonb_array_elements(v_entries) where value ->> 'kind' = 'file'
			and not public.qorpera_company_path_file_available(p_profile_id,value -> 'file')) then
		raise exception 'Company File tree objects are unavailable' using errcode = '55000'; end if;
	select count(*),coalesce(sum((value #>> '{file,bytes}')::bigint),0) into v_count,v_total
	from jsonb_array_elements(v_entries) where value ->> 'kind' = 'file';
	insert into public.qorpera_company_path_tree_cache(profile_id,sha256,bytes,manifest,file_count,total_bytes)
	values (p_profile_id,v_sha,octet_length(p_manifest_text),v_tree,v_count,v_total)
	on conflict (profile_id,sha256) do update set verified_at = clock_timestamp()
	where qorpera_company_path_tree_cache.manifest = excluded.manifest and qorpera_company_path_tree_cache.bytes = excluded.bytes;
	if not found then raise exception 'Company File tree verification differs' using errcode = '23505'; end if;
	return v_sha;
end
$function$
;
