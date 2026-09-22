-- Runtime observation vocabulary: every runtime-owned tool is observed under its
-- own registered name. Until now read_context, send_coworker_message, the
-- computer_* tools, the Step 8 tools (hire_agent, create_group_chat,
-- manage_routine) and the Step 5 tools (report_work, manage_todo,
-- manage_worker) were all recorded as unknown_tool (seen live 2026-09-22 on run
-- bde0513e in company Qorpera). The vocabulary stays closed; the TypeScript side
-- (CLOUD_RUNTIME_OPERATIONS) lists the same names. The ingestion contract,
-- authorization checks and immutable replay semantics are unchanged.
--
-- Rollout order: record this migration BEFORE activating bundle v68. A v68
-- runner against the previous definition has every observation for these tools
-- rejected (22023) and silently dropped by the exporter; earlier runners are
-- unaffected by this definition.
begin;

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
		'company_write','company_mkdir','company_delete','send_message','read_context','send_coworker_message',
		'computer_start','computer_screen','computer_browser','computer_desktop','computer_shell','computer_screenshot',
		'computer_transfer','hire_agent','create_group_chat','manage_routine','report_work','manage_todo','manage_worker',
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

-- CREATE OR REPLACE retains the existing function ACL; state it explicitly.
revoke all on function public.qorpera_record_runtime_observation(uuid,jsonb)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_record_runtime_observation(uuid,jsonb) to service_role;

commit;
