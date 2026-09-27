-- @fixture 290_company_file_path_gateway.test.sql until "-- Shared reads have an explicit"
-- A write or mkdir into a folder that does not exist is refused with PT424 by
-- the check, before any bytes are staged, and again by prepare and commit. It
-- records nothing, so the same call applies once the folder exists
-- (20260926203300_company_file_missing_parent).
create function pg_temp.expect_missing_parent(p_step text,p_plan jsonb)
returns void language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	begin
		if p_step = 'check' then
			perform public.qorpera_check_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,p_plan);
		elsif p_step = 'prepare' then
			perform public.qorpera_prepare_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,p_plan);
		else
			perform public.qorpera_commit_company_path_mutation('29000000-0000-4000-8000-000000000020',v_binding,p_plan,
				(select head_snapshot_id from public.qorpera_company_files
					where environment_id = '29000000-0000-4000-8000-000000000020'),repeat('e',64));
		end if;
		raise exception 'Missing folder of % was not refused at %',p_plan ->> 'path',p_step using errcode = 'QTP01';
	exception when sqlstate 'PT424' then null; end;
end
$$;

select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','missing-parent-ack','I am writing the acceptance check.','progress');
	if pg_temp.path_commit(pg_temp.path_plan('acceptance','acceptance','{"path":"acceptance","kind":"directory"}'))
		->> 'state' is distinct from 'applied' then raise exception 'Cannot create acceptance/'; end if;
end $$;
reset role;

create function pg_temp.missing_parent_trace()
returns jsonb language sql as $$
	select jsonb_build_object(
		'receipts',(select count(*) from public.qorpera_run_operation_receipts
			where run_id = (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid),
		'revisions',(select count(*) from public.qorpera_company_path_revisions
			where environment_id = '29000000-0000-4000-8000-000000000020'),
		'head',(select head_snapshot_id from public.qorpera_company_files
			where environment_id = '29000000-0000-4000-8000-000000000020'))
$$;
select set_config('qorpera_test.missing_parent_trace',pg_temp.missing_parent_trace()::text,true);
-- Bytes that were never uploaded: the refusal must come before they are needed.
select set_config('qorpera_test.unstaged',jsonb_build_object('path','acceptance/auto-review/check-1.txt','kind','file',
	'executable',false,'file',jsonb_build_object('manifestSha256',repeat('a',64),'fileSha256',repeat('b',64),'bytes',9,
	'mediaType','application/octet-stream'))::text,true);

-- The live case: acceptance/ exists, acceptance/auto-review/ does not. Every step refuses it.
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare v_unstaged jsonb := current_setting('qorpera_test.unstaged')::jsonb; v_step text;
begin
	foreach v_step in array array['check','prepare','commit'] loop
		perform pg_temp.expect_missing_parent(v_step,pg_temp.path_plan('check-1','acceptance/auto-review/check-1.txt',v_unstaged));
	end loop;
	perform pg_temp.expect_missing_parent('check',pg_temp.path_plan('round-1','acceptance/auto-review/round-1',
		'{"path":"acceptance/auto-review/round-1","kind":"directory"}'));
	perform pg_temp.expect_missing_parent('check',pg_temp.path_plan('deep','none/of/these/exist.md',
		jsonb_set(v_unstaged,'{path}','"none/of/these/exist.md"')));
end $$;
reset role;
-- Nothing was recorded or written, and no receipt holds the key.
do $$
begin
	if pg_temp.missing_parent_trace() is distinct from current_setting('qorpera_test.missing_parent_trace')::jsonb then
		raise exception 'A refused missing-folder write left a trace'; end if;
end $$;

select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_env uuid := '29000000-0000-4000-8000-000000000020';
	v_unstaged jsonb := current_setting('qorpera_test.unstaged')::jsonb;
	v_result jsonb;
begin
	-- A stale expected version is still reported first, as before.
	begin
		perform public.qorpera_check_company_path_mutation(v_env,b,pg_temp.path_plan('stale','acceptance/auto-review/check-1.txt',
			v_unstaged,extensions.gen_random_uuid()));
		raise exception 'Stale version was not refused';
	exception when sqlstate 'PT412' then null; end;

	-- A top-level entry needs no folder; checking it needs no bytes either.
	if public.qorpera_check_company_path_mutation(v_env,b,pg_temp.path_plan('top','top.txt',
		jsonb_set(v_unstaged,'{path}','"top.txt"'))) ->> 'state' is distinct from 'ready' then
		raise exception 'A top-level write was refused'; end if;

	-- As the runner tells the model: create the folder, then repeat the same call, same key.
	v_result := pg_temp.path_commit(pg_temp.path_plan('auto-review','acceptance/auto-review',
		'{"path":"acceptance/auto-review","kind":"directory"}'));
	if v_result ->> 'state' is distinct from 'applied' then raise exception 'Cannot create acceptance/auto-review/'; end if;
	v_result := pg_temp.path_commit(pg_temp.path_plan('check-1','acceptance/auto-review/check-1.txt',
		pg_temp.path_stage_file('acceptance/auto-review/check-1.txt','check 1')));
	if v_result ->> 'state' is distinct from 'applied' then raise exception 'The repeated write did not apply'; end if;
	v_result := pg_temp.path_commit(pg_temp.path_plan('round-1','acceptance/auto-review/round-1',
		'{"path":"acceptance/auto-review/round-1","kind":"directory"}'));
	if v_result ->> 'state' is distinct from 'applied' then raise exception 'The repeated mkdir did not apply'; end if;

	-- A file is not a folder.
	perform pg_temp.expect_missing_parent('check',pg_temp.path_plan('under-file','acceptance/auto-review/check-1.txt/x',
		'{"path":"acceptance/auto-review/check-1.txt/x","kind":"directory"}'));
	-- Another spelling of an existing folder stays an authority refusal, as before.
	begin
		perform public.qorpera_check_company_path_mutation(v_env,b,pg_temp.path_plan('case','Acceptance/check-2.txt',
			jsonb_set(v_unstaged,'{path}','"Acceptance/check-2.txt"')));
		raise exception 'Another spelling of acceptance/ was accepted';
	exception when insufficient_privilege then null; end;
end $$;

-- A deleted folder leaves a tombstone, which is no folder. Deletion by an
-- agent is only a proposal, so the index row stands in for an approved one.
reset role;
update public.qorpera_company_path_entries set entry = null, version = extensions.gen_random_uuid()
where environment_id = '29000000-0000-4000-8000-000000000020' and path = 'acceptance/auto-review/round-1';
set local role service_role;
select pg_temp.expect_missing_parent('check',pg_temp.path_plan('in-deleted','acceptance/auto-review/round-1/x.md',
	'{"path":"acceptance/auto-review/round-1/x.md","kind":"directory"}'));

-- A completed operation key still replays first, even once its folder is gone.
reset role;
update public.qorpera_company_path_entries set entry = null, version = extensions.gen_random_uuid()
where environment_id = '29000000-0000-4000-8000-000000000020' and path = 'acceptance/auto-review';
set local role service_role;
do $$
declare v_checked jsonb := public.qorpera_check_company_path_mutation('29000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.path_binding')::jsonb,pg_temp.path_plan('check-1','acceptance/auto-review/check-1.txt',
	pg_temp.path_stage_file('acceptance/auto-review/check-1.txt','check 1')));
begin
	if v_checked ->> 'state' is distinct from 'completed' or v_checked #>> '{result,state}' is distinct from 'applied' then
		raise exception 'A completed write did not replay: %',v_checked; end if;
end $$;

-- The runner observes the refusal as denied with errorCategory parent_missing.
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_recorded jsonb;
begin
	v_recorded := public.qorpera_record_runtime_observation(v_run,jsonb_build_object('schema','qorpera.runtime-observation/v1',
		'attemptId',extensions.gen_random_uuid(),'parentAttemptId',null,
		'assignmentId',current_setting('qorpera_test.path_binding')::jsonb -> 'assignmentId',
		'phase','finish','operation','company_write','logicalOperationSha256',repeat('7',64),
		'observedAt','2026-09-26T19:29:30.000Z','durationMs',12,'status','denied','errorCategory','parent_missing',
		'receiptId',null,'readId',null,'inputBytes',9,'outputBytes',null,'inputTokens',null,'outputTokens',null,
		'cachedInputTokens',null,'cacheWriteInputTokens',null,'reasoningOutputTokens',null,'totalTokens',null));
	if v_recorded ->> 'replayed' is distinct from 'false' then raise exception 'Unexpected receipt: %',v_recorded; end if;
end $$;
reset role;
do $$
begin
	if not exists (select 1 from public.qorpera_runtime_observations
		where run_id = (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid
			and observation ->> 'status' = 'denied' and observation ->> 'errorCategory' = 'parent_missing') then
		raise exception 'parent_missing observation was not kept'; end if;
end $$;

set constraints all immediate;
rollback;
