-- A turn is not capped by a number of tool calls, effectful operations,
-- transcript events or wall-clock time (founder, 2026-09-22). The counters
-- stay for observability; the byte bound on the transcript and the run
-- deadline remain the outer safety limits, and the deadline now defaults
-- to its 24-hour maximum instead of six hours.

alter table public.qorpera_execution_run_budgets
	drop constraint qorpera_execution_run_budgets_transcript_event_count_check,
	add constraint qorpera_execution_run_budgets_transcript_event_count_check check (transcript_event_count >= 0),
	drop constraint qorpera_execution_run_budgets_operation_count_check,
	add constraint qorpera_execution_run_budgets_operation_count_check check (operation_count >= 0);

alter table public.qorpera_execution_runs
	alter column deadline_at set default statement_timestamp() + interval '24 hours';

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
	where run_id = v_run.id
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

create or replace function public.qorpera_begin_run_operation_receipt(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_receipt_id uuid,
	p_logical_operation_key text,
	p_operation_kind text,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_requires_company_revision boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if exists (
		select 1 from public.qorpera_execution_runs as run
		where run.id = v_job.run_id and run.source_kind = 'proposal_review'
	) then
		raise exception 'proposal review executions cannot perform operations' using errcode = '42501';
	end if;
	if v_job.run_id is null or p_receipt_id is null
		or char_length(btrim(coalesce(p_logical_operation_key, ''))) not between 1 and 256
		or coalesce(p_operation_kind, '') !~ '^[a-z][a-z0-9_]{0,63}$'
		or p_input_sha256 !~ '^[0-9a-f]{64}$'
		or p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$'
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.job_id = p_job_id
				and assignment.run_id = v_job.run_id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted'
		) then
		raise exception 'run operation authority is invalid' using errcode = '42501';
	end if;
	select receipt.* into v_receipt
	from public.qorpera_run_operation_receipts as receipt
	where receipt.run_id = v_job.run_id and receipt.logical_operation_key = btrim(p_logical_operation_key)
	for update;
	if found then
		if v_receipt.operation_kind <> p_operation_kind
			or v_receipt.input_sha256 <> p_input_sha256
			or v_receipt.downstream_idempotency_sha256 <> p_downstream_idempotency_sha256
			or v_receipt.requires_company_revision <> coalesce(p_requires_company_revision, false) then
			raise exception 'logical operation key is already bound to other work' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'state', v_receipt.status,
			'receipt_id', v_receipt.id,
			'result', v_receipt.result,
			'output_snapshot_id', v_receipt.output_snapshot_id,
			'proposal_id', v_receipt.proposal_id
		);
	end if;
	if exists (
		select 1 from public.qorpera_run_operation_receipts as unresolved
		where unresolved.run_id = v_job.run_id and unresolved.status in ('executing', 'ambiguous')
	) then
		raise exception 'run has an unresolved operation' using errcode = '55000';
	end if;
	update public.qorpera_execution_run_budgets
	set operation_count = operation_count + 1
	where run_id = v_job.run_id;
	if not found then
		raise exception 'run operation budget is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_run_operation_receipts (
		id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, requires_company_revision
	) values (
		p_receipt_id, v_job.run_id, p_job_id, p_assignment_id, btrim(p_logical_operation_key),
		p_operation_kind, p_input_sha256, p_downstream_idempotency_sha256,
		coalesce(p_requires_company_revision, false)
	) returning * into v_receipt;
	return jsonb_build_object('state', 'executing', 'receipt_id', v_receipt.id);
end
$$;
