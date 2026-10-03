-- @fixture 658_folder_core_run_completion.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C3 (P23 part 2, migration 20260930002210): the runner broker's model of a folder-v2 run. The broker
-- describes it in the path lane's shape with no substrate anywhere, and the run then completes through the folder lane
-- (the round trip); the substrate's operations and artifacts refuse, as does a proposal review. Snapshot-v1 keeps its text (each patch reversed is the definition before the migration) and
-- its describe. Runs are 647's hand-built runs, prepared as 658 prepares them.

create function pg_temp.describe(b jsonb) returns jsonb language sql as $$
	select public.qorpera_runner_broker_describe((b ->> 'runnerId')::uuid, repeat('f', 64), (b ->> 'jobId')::uuid, repeat('a', 64))
$$;
create function pg_temp.refuses(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected % from %', p_state, p_sql using errcode = 'QTF01';
exception when others then
	if sqlstate = 'QTF01' then raise; end if;
	if sqlstate <> p_state or sqlerrm <> p_message then
		raise exception 'Expected % "%" from %, got % "%"', p_state, p_message, p_sql, sqlstate, sqlerrm using errcode = 'QTF02'; end if;
end $$;

-- 1. The round trip. The description names the job, the run and the sponsor, in the path lane's shape, and no substrate:
-- no version, snapshot, proposal snapshot, artifact index or Company File output limits, and null substrate and snapshot
-- ids on the job and the run (the run here still has the ids 658 gave it). The run then completes unchanged through v6's
-- folder lane, naming the job's substrate as a run from before P28 does.
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; d jsonb; r jsonb;
begin
	d := pg_temp.describe(b);
	if d ->> 'company_runtime' is distinct from 'company-path-v1'
		or d -> 'version' <> 'null'::jsonb or d -> 'snapshot' <> 'null'::jsonb or d -> 'proposal_snapshot' <> 'null'::jsonb
		or d -> 'artifact_index' <> 'null'::jsonb or d -> 'company_file_output_limits' <> 'null'::jsonb
		or d #> '{job,substrate_version_id}' <> 'null'::jsonb or d #> '{run,substrate_version_id}' <> 'null'::jsonb
		or d #> '{run,company_snapshot_id}' <> 'null'::jsonb
		or d #>> '{job,job_id}' is distinct from b ->> 'jobId' or d #>> '{run,run_id}' is distinct from b ->> 'runId'
		or d #>> '{sponsor,binding_id}' is null or d #>> '{output_limits,root_contract}' is distinct from 'qorpera.object/v1' then
		raise exception '1: the folder-v2 description: %', d; end if;
	if (select substrate_version_id from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid) is null then
		raise exception '1: before P28 the job row still names a substrate'; end if;
	-- A human wake owes its final message before completion (as in 658).
	perform pg_temp.send(b, 'final', 'Done.', 'final');
	r := pg_temp.complete(b);
	if (pg_temp.outcome(b ->> 'runId')).company_disposition is distinct from 'unchanged'
		or (select status from public.qorpera_runner_jobs where id = (b ->> 'jobId')::uuid) <> 'completed' then
		raise exception '1: the described run completes unchanged: %', r; end if;
end $$;

-- 2. The substrate's operations and artifacts, and a proposal review's description, refuse on folder-v2.
do $$
declare h jsonb := pg_temp.human(); b jsonb := h -> 'binding';
begin
	perform pg_temp.refuses(format('select public.qorpera_runner_broker_list_operations(%L, %L, %L, %L, 0, 10)', b ->> 'runnerId', repeat('f', 64),
		b ->> 'jobId', repeat('a', 64)), '0A000', 'This Company File path does not serve folder-v2 companies');
	perform pg_temp.refuses(format('select public.qorpera_runner_broker_list_artifacts(%L, %L, %L, %L, 0, 10)', b ->> 'runnerId', repeat('f', 64),
		b ->> 'jobId', repeat('a', 64)), '0A000', 'This Company File path does not serve folder-v2 companies');
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set source_kind = 'proposal_review', input_ids = '{}' where id = (b ->> 'runId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.refuses(format('select pg_temp.describe(%L)', b), '0A000', 'This Company File path does not serve folder-v2 companies');
end $$;

-- 3. Snapshot-v1 keeps its describe: the same call for a snapshot-v1 job takes the legacy body (it fails there for its own
-- reasons: 647's snapshot-v1 job has no substrate rows), never the folder description.
do $$
declare s jsonb := current_setting('qorpera_test.snapshot_binding')::jsonb;
begin
	begin
		perform pg_temp.describe(s);
		raise exception '3: a snapshot-v1 job without its substrate cannot be described' using errcode = 'QTF01';
	exception when others then
		if sqlstate = 'QTF01' or sqlerrm = 'This Company File path does not serve folder-v2 companies'
			or sqlerrm = 'runner job assignment is unavailable' then
			raise exception '3: the snapshot-v1 describe took the folder lane: % %', sqlstate, sqlerrm; end if;
	end;
end $$;

-- 4. Snapshot-v1 keeps its text: each patched body with its folder-v2 line reversed is byte for byte the definition before
-- the migration. The folder describe is postgres-only.
do $$
declare v_text text;
	c_refuse constant text := 'if public.qorpera_job_is_folder_v2(p_job_id) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;';
begin
	v_text := replace(pg_get_functiondef('public.qorpera_runner_broker_describe(uuid,text,uuid,text)'::regprocedure),
		E'\t-- P23 (20260930002210): a folder-v2 run is described in the path lane''s shape, with no substrate.\n'
		|| E'\tif public.qorpera_job_is_folder_v2(p_job_id) then\n'
		|| E'\t\treturn public.qorpera_folder_runner_broker_describe(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);\n'
		|| E'\tend if;\n',
		E'\t' || c_refuse || E'\n');
	if md5(v_text) <> '8ba12b47c0141c8c8d156e711ad056df' then raise exception '4: qorpera_runner_broker_describe''s text changed'; end if;
	v_text := replace(pg_get_functiondef('public.qorpera_runner_broker_list_operations(uuid,text,uuid,text,bigint,integer)'::regprocedure),
		E'\t' || c_refuse || E' -- P23 (20260930002210)\n', '');
	if md5(v_text) <> 'e6c3c190dbf4a3ae2714d6b8dfe716d3' then raise exception '4: qorpera_runner_broker_list_operations''s text changed'; end if;
	v_text := replace(pg_get_functiondef('public.qorpera_runner_broker_list_artifacts(uuid,text,uuid,text,integer,integer)'::regprocedure),
		E'\t' || c_refuse || E' -- P23 (20260930002210)\n', '');
	if md5(v_text) <> '99615be73b2b74318372736749af8be0' then raise exception '4: qorpera_runner_broker_list_artifacts''s text changed'; end if;
	if has_function_privilege('public', 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)', 'execute') then
		raise exception '4: qorpera_folder_runner_broker_describe must be postgres-only'; end if;
end $$;

rollback;
