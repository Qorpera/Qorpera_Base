-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.rr_observation(p_operation text)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-observation/v1','attemptId',extensions.gen_random_uuid(),
		'parentAttemptId',null,'assignmentId',current_setting('qorpera_test.base_binding')::jsonb -> 'assignmentId',
		'phase','start','operation',p_operation,'logicalOperationSha256',repeat('7',64),
		'observedAt','2026-11-15T12:00:00.000Z','durationMs',null,'status','started','errorCategory',null,
		'receiptId',null,'readId',null,'inputBytes',null,'outputBytes',null,'inputTokens',null,'outputTokens',null,
		'cachedInputTokens',null,'cacheWriteInputTokens',null,'reasoningOutputTokens',null,'totalTokens',null)
$$;

reset role;
do $$
declare v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid; v_result jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch(v_run,
		jsonb_build_array(pg_temp.rr_observation('record_reflection')));
	reset role;
	if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-receipt/v1'
		or (select count(*) from public.qorpera_runtime_observations
			where run_id = v_run and operation = 'record_reflection') <> 1 then
		raise exception '1: record_reflection was not recorded: %', v_result; end if;
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch(v_run,
		jsonb_build_array(pg_temp.rr_observation('record_reflections')));
	reset role;
	if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-refusal/v1'
		or v_result #>> '{receipts,0,code}' is distinct from '22023'
		or (select count(*) from public.qorpera_runtime_observations
			where run_id = v_run and operation = 'record_reflections') <> 0 then
		raise exception '1: a name the list does not hold was not refused: %', v_result; end if;
end
$$;

set constraints all immediate;
rollback;
