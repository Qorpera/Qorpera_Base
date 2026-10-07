-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Batch observation writes and scheduled retention (20260928319370) on a folder-v2 company (ported from snapshot-v1 in
-- the legacy sweep), on 924's real native run of Alice's: only the service role writes a batch or runs retention by hand,
-- and no API role schedules it; a member's batch is refused; retention purges a terminal job's observations older than
-- 30 days, all of them, keeps a job's still in progress, and never touches fresh observations, run events, receipts,
-- read observations or sends.

-- A runtime observation row as the runtime sends it, for the base run (from 320's helper).
create function pg_temp.ob_observation(p_attempt uuid default extensions.gen_random_uuid())
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-observation/v1','attemptId',p_attempt,
		'parentAttemptId',null,'assignmentId',current_setting('qorpera_test.base_binding')::jsonb -> 'assignmentId',
		'phase','start','operation','company_write','logicalOperationSha256',repeat('7',64),
		'observedAt','2026-08-31T12:00:00.000Z','durationMs',null,'status','started','errorCategory',null,
		'receiptId',null,'readId',null,'inputBytes',null,'outputBytes',null,'inputTokens',null,'outputTokens',null,
		'cachedInputTokens',null,'cacheWriteInputTokens',null,'reasoningOutputTokens',null,'totalTokens',null)
$$;

-- Only service_role writes batches or runs retention by hand; no API role schedules it.
reset role;
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_record_runtime_observation_batch(uuid,jsonb)','EXECUTE')
				is distinct from (v_role = 'service_role')
			or has_function_privilege(v_role,'public.qorpera_run_runtime_observation_retention()','EXECUTE')
				is distinct from (v_role = 'service_role')
			or has_function_privilege(v_role,'public.qorpera_schedule_runtime_observation_retention()','EXECUTE') then
			raise exception 'Observation batch or retention boundary is incorrect for %',v_role; end if;
	end loop;
end
$$;

-- A batch needs the same service authority as one row: a member's is refused; the service's records the row.
do $$
declare v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid; v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
	begin
		perform public.qorpera_record_runtime_observation_batch(v_run,jsonb_build_array(pg_temp.ob_observation()));
		raise exception 'Member observation batch accepted' using errcode = 'QTB01';
	exception when insufficient_privilege then null; end;
	perform pg_temp.base_claims('service_role');
	if exists (select 1 from public.qorpera_runtime_observations where run_id = v_run) then
		raise exception 'A refused batch recorded a row'; end if;
	-- Control, and the fresh row retention must keep.
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch(v_run,jsonb_build_array(pg_temp.ob_observation()));
	reset role;
	if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-receipt/v1'
		or (select count(*) from public.qorpera_runtime_observations where run_id = v_run) <> 1 then
		raise exception 'The service''s batch did not record its row: %',v_result; end if;
end
$$;

-- Retention: the purge's rows only (over 30 days old, terminal job), all of them. The run acknowledges its wake first, so
-- it has a send and run events retention must leave alone.
reset role;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress','ob-ack') \g /dev/null
insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,parent_attempt_id,
	operation,logical_operation_sha256,observed_at,ingested_at,observation)
select (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,attempt,'start',null,null,
	'model_turn',null,clock_timestamp(),clock_timestamp()-interval '31 days',
	pg_temp.ob_observation(attempt) || '{"operation":"model_turn","logicalOperationSha256":null,"assignmentId":null}'
from (select extensions.gen_random_uuid() as attempt from generate_series(1,5250)) old;
do $$
declare b jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_result jsonb; v_total integer := 0;
	v_fresh bigint; v_events bigint; v_receipts bigint; v_reads bigint; v_sends bigint;
begin
	set local role service_role;
	v_result := public.qorpera_run_runtime_observation_retention();
	reset role;
	if v_result ->> 'deleted' <> '0' or v_result ->> 'busy' <> 'false' then
		raise exception 'Retention pruned a job still in progress: %',v_result; end if;
	set local role service_role;
	perform public.qorpera_terminalize_runner_attempt((b ->> 'jobId')::uuid,'failed','Retention fixture',false);
	reset role;
	select count(*) into v_fresh from public.qorpera_runtime_observations where ingested_at > clock_timestamp()-interval '1 day';
	select count(*) into v_events from public.qorpera_execution_run_events;
	select count(*) into v_receipts from public.qorpera_run_operation_receipts;
	select count(*) into v_reads from public.qorpera_company_read_observations;
	select count(*) into v_sends from public.qorpera_agent_sends;
	if v_fresh < 1 or v_sends < 1 then raise exception 'Retention fixture: a fresh observation and a send'; end if;
	for attempt in 1..30 loop
		set local role service_role;
		v_result := public.qorpera_run_runtime_observation_retention();
		reset role;
		v_total := v_total + (v_result ->> 'deleted')::integer;
		exit when (v_result ->> 'deleted')::integer < 200 * (v_result ->> 'batches')::integer
			or (v_result ->> 'deleted')::integer = 0;
	end loop;
	set local role service_role;
	v_result := public.qorpera_purge_runtime_observations(1);
	reset role;
	if v_total <> 5250 or v_result ->> 'deleted' <> '0' or v_result -> 'moreEligible' <> 'false'::jsonb
		or (select count(*) from public.qorpera_runtime_observations where ingested_at < clock_timestamp()-interval '30 days') <> 0
		or (select count(*) from public.qorpera_runtime_observations where ingested_at > clock_timestamp()-interval '1 day') <> v_fresh
		or (select count(*) from public.qorpera_execution_run_events) <> v_events
		or (select count(*) from public.qorpera_run_operation_receipts) <> v_receipts
		or (select count(*) from public.qorpera_company_read_observations) <> v_reads
		or (select count(*) from public.qorpera_agent_sends) <> v_sends then
		raise exception 'Retention left eligible rows or touched fresh diagnostics or authority (deleted %)',v_total; end if;
end
$$;
set constraints all immediate;
rollback;
