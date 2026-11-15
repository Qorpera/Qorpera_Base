-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930762000 (app_guide), on 924's real native run of Alice's: a run's observations may name app_guide, the
-- tool that answers how one part of an interface app is made, from the runtime's own text. The list stays closed: a
-- name it does not hold is refused. The patched body carries the migration's marker, after make_picture.

-- A runtime observation row as the runtime sends it, for the base run (753's), naming `p_operation`.
create function pg_temp.ag_observation(p_operation text)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-observation/v1','attemptId',extensions.gen_random_uuid(),
		'parentAttemptId',null,'assignmentId',current_setting('qorpera_test.base_binding')::jsonb -> 'assignmentId',
		'phase','start','operation',p_operation,'logicalOperationSha256',repeat('7',64),
		'observedAt','2026-11-14T12:00:00.000Z','durationMs',null,'status','started','errorCategory',null,
		'receiptId',null,'readId',null,'inputBytes',null,'outputBytes',null,'inputTokens',null,'outputTokens',null,
		'cachedInputTokens',null,'cacheWriteInputTokens',null,'reasoningOutputTokens',null,'totalTokens',null)
$$;

-- 1. The service records an app_guide observation of the run; a name the list does not hold is refused.
reset role;
do $$
declare v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid; v_result jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch(v_run,
		jsonb_build_array(pg_temp.ag_observation('app_guide')));
	reset role;
	if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-receipt/v1'
		or (select count(*) from public.qorpera_runtime_observations
			where run_id = v_run and operation = 'app_guide') <> 1 then
		raise exception '1: app_guide was not recorded: %', v_result; end if;
	-- A batch answers a refused row in its slot (20260928319370): 22023, and no row.
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch(v_run,
		jsonb_build_array(pg_temp.ag_observation('app_guides')));
	reset role;
	if v_result #>> '{receipts,0,schema}' is distinct from 'qorpera.runtime-observation-refusal/v1'
		or v_result #>> '{receipts,0,code}' is distinct from '22023'
		or (select count(*) from public.qorpera_runtime_observations
			where run_id = v_run and operation = 'app_guides') <> 0 then
		raise exception '1: a name the list does not hold was not refused: %', v_result; end if;
end
$$;

-- 2. The marker: the list names app_guide after make_picture, and only this body carries 20260930762000.
reset role;
do $$
begin
	-- After make_picture, not next to it: a later migration that anchors on the same line would put its own names
	-- between the two, whichever of them is applied first.
	if strpos(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
			$q$/* 20260930762000 */'app_guide',$q$)
		<= strpos(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
			$q$/* 20260930746000 */'make_picture',$q$) then
		raise exception '2: the observations'' list does not name app_guide after make_picture'; end if;
	if (select array_agg(proc.proname::text order by proc.proname::text collate "C")
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930762000') > 0)
		is distinct from array['qorpera_record_runtime_observation'] then
		raise exception '2: the marker is in other bodies'; end if;
end
$$;

set constraints all immediate;
rollback;
