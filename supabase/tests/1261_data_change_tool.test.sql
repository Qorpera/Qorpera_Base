-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930763000 (data_change), on 924's real native run of Alice's: a run's observations may name data_change, the
-- tool that runs a named change of a company database through the data gateway. The list stays closed: a name it does
-- not hold is refused. The patched body carries the migration's marker, after the three data tools.

-- A runtime observation row as the runtime sends it, for the base run (753's), naming `p_operation`.
create function pg_temp.dc_observation(p_operation text)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-observation/v1','attemptId',extensions.gen_random_uuid(),
		'parentAttemptId',null,'assignmentId',current_setting('qorpera_test.base_binding')::jsonb -> 'assignmentId',
		'phase','start','operation',p_operation,'logicalOperationSha256',repeat('7',64),
		'observedAt','2026-11-14T12:00:00.000Z','durationMs',null,'status','started','errorCategory',null,
		'receiptId',null,'readId',null,'inputBytes',null,'outputBytes',null,'inputTokens',null,'outputTokens',null,
		'cachedInputTokens',null,'cacheWriteInputTokens',null,'reasoningOutputTokens',null,'totalTokens',null)
$$;

-- 1. The service records a data_change observation of the run; a name the list does not hold is refused, and the
-- three data tools before it are still taken.
reset role;
do $$
declare v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid; v_result jsonb;
	v_tool text;
begin
	perform pg_temp.base_claims('service_role');
	foreach v_tool in array array['data_change', 'data_describe', 'data_apply', 'data_query'] loop
		set local role service_role;
		v_result := public.qorpera_record_runtime_observation_batch(v_run,
			jsonb_build_array(pg_temp.dc_observation(v_tool)));
		reset role;
		if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-receipt/v1'
			or (select count(*) from public.qorpera_runtime_observations
				where run_id = v_run and operation = v_tool) <> 1 then
			raise exception '1: % was not recorded: %', v_tool, v_result; end if;
	end loop;
	-- A batch answers a refused row in its slot (20260928319370): 22023, and no row.
	foreach v_tool in array array['data_changes', 'data_act', 'data_delete'] loop
		set local role service_role;
		v_result := public.qorpera_record_runtime_observation_batch(v_run,
			jsonb_build_array(pg_temp.dc_observation(v_tool)));
		reset role;
		if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-refusal/v1'
			or v_result #>> '{receipts,0,code}' is distinct from '22023'
			or (select count(*) from public.qorpera_runtime_observations
				where run_id = v_run and operation = v_tool) <> 0 then
			raise exception '1: % is a name the list does not hold and was not refused: %', v_tool, v_result; end if;
	end loop;
end
$$;

set constraints all immediate;
rollback;
