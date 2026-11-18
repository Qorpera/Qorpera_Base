-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
create function pg_temp.cs_observation(p_operation text)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-observation/v1','attemptId',extensions.gen_random_uuid(),
		'parentAttemptId',null,'assignmentId',current_setting('qorpera_test.base_binding')::jsonb -> 'assignmentId',
		'phase','start','operation',p_operation,'logicalOperationSha256',repeat('7',64),
		'observedAt','2026-11-14T12:00:00.000Z','durationMs',null,'status','started','errorCategory',null,
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
		jsonb_build_array(pg_temp.cs_observation('company_search')));
	reset role;
	if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-receipt/v1'
		or (select count(*) from public.qorpera_runtime_observations
			where run_id = v_run and operation = 'company_search') <> 1 then
		raise exception 'company_search was not recorded: %', v_result; end if;
end
$$;

set constraints all immediate;
rollback;
