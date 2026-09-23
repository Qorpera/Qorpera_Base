-- Thread interactions, runtime step (bundle v76, on top of the v75 kernel):
--   1. the native provider path may append an `interaction_request` card under
--      the same lease authority as an agent send (`qorpera_append_native_interaction_request`);
--   2. the run context shows cards and answers in the thread history, so an agent
--      remembers what it asked and what was answered;
--   3. `ask_member` joins the closed runtime observation vocabulary.
-- Rollout order: record this migration BEFORE activating bundle v76. A v76 runner
-- against the previous definitions has every ask_member observation rejected and
-- every card append refused; earlier runners are unaffected.
begin;

-- 1. The native path's card append. Mirrors qorpera_send_native_agent_message:
-- validate the native execution lease, then append through the runner
-- transcript authority with the runner's own token hashes. The entry is built
-- here so a guest never chooses execution identity fields.
create function public.qorpera_append_native_interaction_request(
	p_lease_id uuid, p_run_id uuid, p_job_id uuid, p_runner_id uuid,
	p_assignment_id uuid, p_credential_capsule_id uuid, p_compute_identity_id uuid,
	p_provider text, p_native_harness text,
	p_event_id uuid, p_data jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_session_token_sha256 text;
	v_lease_token_sha256 text;
	v_run public.qorpera_execution_runs%rowtype;
	v_parent text;
	v_body jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'native interaction authority is required' using errcode = '42501';
	end if;
	if p_event_id is null or not public.qorpera_interaction_request_valid(p_data) then
		raise exception 'interaction request is invalid' using errcode = '22023';
	end if;
	-- Match the job-first lock order used by runner operations and completion.
	perform 1 from public.qorpera_runner_jobs as job where job.id = p_job_id for update;
	perform public.qorpera_validate_native_provider_execution_lease(
		p_lease_id, p_run_id, p_job_id, p_runner_id, p_assignment_id,
		p_credential_capsule_id, p_compute_identity_id, p_provider, p_native_harness
	);
	select runner.session_token_sha256 into strict v_session_token_sha256
	from public.qorpera_runners as runner where runner.id = p_runner_id;
	select job.lease_token_sha256 into strict v_lease_token_sha256
	from public.qorpera_runner_jobs as job where job.id = p_job_id;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = p_run_id;
	if v_run.session_id is null then
		raise exception 'interaction requests need a conversation' using errcode = '55000';
	end if;
	-- The card follows whatever the thread ends with; a replay keeps its first
	-- parent and time so the runner append sees the identical body.
	select event.body #>> '{entry,parentId}' into v_parent
	from public.qorpera_session_events as event
	where event.event_id = p_event_id and event.session_id = v_run.session_id;
	if not found then
		select event.body #>> '{entry,id}' into v_parent
		from public.qorpera_session_events as event
		where event.session_id = v_run.session_id
		order by event.sequence desc limit 1;
	end if;
	v_body := jsonb_build_object(
		'schema', 'qorpera.runner-transcript-entry/v1',
		'entry', jsonb_build_object(
			'type', 'custom',
			'customType', 'interaction_request',
			'id', p_event_id,
			'parentId', v_parent,
			'timestamp', coalesce(
				(select to_char(event.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					from public.qorpera_session_events as event where event.event_id = p_event_id),
				to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
			'data', p_data,
			'execution', jsonb_build_object(
				'kind', 'run', 'id', p_run_id, 'claimantId', p_run_id, 'runnerAssignmentId', p_assignment_id
			)
		)
	);
	return public.qorpera_append_runner_transcript_event(
		p_runner_id, v_session_token_sha256, p_job_id, v_lease_token_sha256,
		p_assignment_id, p_event_id, 'interaction_request', v_body
	);
end
$$;
revoke all on function public.qorpera_append_native_interaction_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, jsonb)
	from public, anon, authenticated;
grant execute on function public.qorpera_append_native_interaction_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, jsonb)
	to service_role;

-- 2. Cards and answers are part of the thread history an agent reads. Patched
-- in place so every later hardening of these two functions stays.
do $$
declare
	v_definition text;
	v_needle text;
	v_patched text;
begin
	v_definition := pg_get_functiondef('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure);
	v_needle := E'and sequence <= p_run.transcript_start_sequence and event_type = \'message\' and not (event_id = any(p_run.input_ids));';
	if (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle) <> 1 then
		raise exception 'Context source history filter differs';
	end if;
	v_patched := replace(v_definition, v_needle,
		E'and sequence <= p_run.transcript_start_sequence and event_type in (\'message\', \'interaction_request\', \'interaction_answer\', \'authorization_request\', \'authorization_decision\') and not (event_id = any(p_run.input_ids));');
	execute v_patched;

	v_definition := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure);
	v_needle := E'and sequence <= v_run.transcript_start_sequence and event_type = \'message\'';
	if (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle) <> 2 then
		raise exception 'Run context history filter differs';
	end if;
	execute replace(v_definition, v_needle,
		E'and sequence <= v_run.transcript_start_sequence and event_type in (\'message\', \'interaction_request\', \'interaction_answer\', \'authorization_request\', \'authorization_decision\')');
end
$$;

-- 3. ask_member in the observation vocabulary. Rebased on master's latest text
-- (20260922232000, coding executor names) so this replacement drops nothing. Same function as
-- 20260922200000 with one more name (rebase note: after #218 merges, add its coding_* names here and in CLOUD_RUNTIME_TOOL_OPERATIONS); ACL restated because CREATE OR REPLACE keeps it.
create or replace function public.qorpera_record_runtime_observation(p_run_id uuid,p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_keys text[] := array['schema','attemptId','parentAttemptId','assignmentId','phase','operation',
		'logicalOperationSha256','observedAt','durationMs','status','errorCategory','receiptId','readId',
		'inputBytes','outputBytes','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens',
		'reasoningOutputTokens','totalTokens'];
	v_key text; v_number numeric; v_observed timestamptz;
	v_uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_runtime_observations%rowtype;
	v_other public.qorpera_runtime_observations%rowtype;
	v_replayed boolean := false;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runtime diagnostics require operator service authority' using errcode = '42501'; end if;
	if p_run_id is null or jsonb_typeof(p_observation) is distinct from 'object'
		or octet_length(p_observation::text) > 8192 or not (p_observation ?& v_keys)
		or p_observation - v_keys <> '{}'::jsonb
		or p_observation ->> 'schema' is distinct from 'qorpera.runtime-observation/v1'
		or jsonb_typeof(p_observation -> 'attemptId') is distinct from 'string'
		or p_observation ->> 'attemptId' !~* v_uuid_pattern then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['parentAttemptId','assignmentId','receiptId','readId'] loop
		if p_observation -> v_key <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> v_key) <> 'string' or p_observation ->> v_key !~* v_uuid_pattern) then
			raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	end loop;
	if p_observation ->> 'operation' not in ('model_turn','model_request','company_read','company_list',
		'company_write','company_mkdir','company_delete','send_message','ask_member','read_context','send_coworker_message',
		'computer_start','computer_screen','computer_browser','computer_desktop','computer_shell','computer_screenshot',
		'computer_transfer','hire_agent','create_group_chat','manage_routine','report_work','manage_todo','manage_worker',
		'coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask',
		'company_context','message_composition','connector','unknown_tool','run_authority','context_authority',
		'native_result_fence','diagnostic_export')
		or jsonb_typeof(p_observation -> 'operation') <> 'string'
		or (p_observation -> 'logicalOperationSha256' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'logicalOperationSha256') <> 'string'
			or p_observation ->> 'logicalOperationSha256' !~ '^[0-9a-f]{64}$'))
		or (p_observation -> 'errorCategory' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'errorCategory') <> 'string' or p_observation ->> 'errorCategory' not in (
			'invalid_arguments','unavailable_tool','call_id_reused','budget_exhausted','authority_unavailable',
			'stale_version','protected_path','ambiguous_effect','cancelled','timeout','provider_failed',
			'transport_unavailable','invalid_response','unknown','export_unavailable')))
		or not coalesce((p_observation ->> 'phase' = 'start' and p_observation ->> 'status' = 'started'
			and p_observation -> 'durationMs' = 'null'::jsonb and p_observation -> 'errorCategory' = 'null'::jsonb)
			or (p_observation ->> 'phase' = 'finish' and p_observation ->> 'status' in
			('succeeded','failed','cancelled','denied','unconfirmed','proposed','replayed')),false) then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['durationMs','inputBytes','outputBytes','inputTokens','outputTokens',
		'cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] loop
		if p_observation -> v_key = 'null'::jsonb then continue; end if;
		if jsonb_typeof(p_observation -> v_key) <> 'number' then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
		v_number := (p_observation ->> v_key)::numeric;
		if v_number < 0 or v_number > 9007199254740991 or v_number <> trunc(v_number) then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
	end loop;
	-- Exactly the emitter's finite UTC-millisecond representation, not PostgreSQL
	-- special dates, local timezone guesses, calendar normalization, or year zero.
	if jsonb_typeof(p_observation -> 'observedAt') <> 'string'
		or p_observation ->> 'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
		or p_observation ->> 'observedAt' like '0000-%' then
		raise exception 'Runtime observation time is invalid' using errcode = '22023'; end if;
	begin
		v_observed := (p_observation ->> 'observedAt')::timestamptz;
		if not isfinite(v_observed) or to_char(v_observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			<> p_observation ->> 'observedAt' then raise invalid_datetime_format; end if;
	exception when datetime_field_overflow or invalid_datetime_format then
		raise exception 'Runtime observation time is invalid' using errcode = '22023';
	end;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if not found then raise exception 'Runtime observation run is unavailable' using errcode = '42501'; end if;
	if (p_observation ->> 'assignmentId' is not null and not exists (
		select 1 from public.qorpera_runner_assignments a where a.id = (p_observation ->> 'assignmentId')::uuid
			and a.run_id = p_run_id and a.job_id = v_run.job_id))
		or (p_observation ->> 'receiptId' is not null and not exists (
			select 1 from public.qorpera_run_operation_receipts r where r.id = (p_observation ->> 'receiptId')::uuid
				and r.run_id = p_run_id and r.job_id = v_run.job_id))
		or (p_observation ->> 'readId' is not null and not exists (
			select 1 from public.qorpera_company_read_observations r where r.id = (p_observation ->> 'readId')::uuid
				and r.run_id = p_run_id and r.environment_id = v_run.environment_id)) then
		raise exception 'Runtime observation reference is unavailable' using errcode = '42501'; end if;
	-- Only the new diagnostic identity is locked; telemetry does not lock a
	-- job, lease, file, or live authorization. A finish may arrive before start.
	perform pg_advisory_xact_lock(hashtextextended('runtime-observation:' || p_run_id::text || ':' ||
		(p_observation ->> 'attemptId')::uuid::text,19970));
	select * into v_existing from public.qorpera_runtime_observations
	where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid and phase = p_observation ->> 'phase';
	if found then
		if v_existing.observation <> p_observation then
			raise exception 'Runtime observation identity already records different metadata' using errcode = '23505'; end if;
		v_replayed := true;
	else
		select * into v_other from public.qorpera_runtime_observations
		where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid;
		if found and (v_other.observation -> 'operation',v_other.observation -> 'assignmentId',
			v_other.observation -> 'parentAttemptId',v_other.observation -> 'logicalOperationSha256') is distinct from
			(p_observation -> 'operation',p_observation -> 'assignmentId',p_observation -> 'parentAttemptId',
			p_observation -> 'logicalOperationSha256') then
			raise exception 'Runtime observation attempt metadata changed' using errcode = '23505'; end if;
		insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,parent_attempt_id,
			operation,logical_operation_sha256,observed_at,observation)
		values (p_run_id,(p_observation ->> 'attemptId')::uuid,p_observation ->> 'phase',
			(p_observation ->> 'assignmentId')::uuid,(p_observation ->> 'parentAttemptId')::uuid,
			p_observation ->> 'operation',p_observation ->> 'logicalOperationSha256',v_observed,p_observation)
		returning * into v_existing;
	end if;
	return jsonb_build_object('schema','qorpera.runtime-observation-receipt/v1','runId',p_run_id,
		'attemptId',v_existing.attempt_id,'phase',v_existing.phase,'ingestedAt',v_existing.ingested_at,'replayed',v_replayed);
end
$$;
revoke all on function public.qorpera_record_runtime_observation(uuid,jsonb)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_record_runtime_observation(uuid,jsonb) to service_role;

commit;
