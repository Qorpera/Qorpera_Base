-- Company folder core, C1c-2c part 2: a folder-v2 run's completion, sponsor handoff and receipt recovery
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.9).
--
-- Changes only folder-v2 behaviour; no real folder-v2 run exists yet (C1C §5.8). Snapshot-v1 keeps every path.
-- * complete_runner_job_v6's folder-v2 lane replaces C1c-1's refusal. In order: the job FOR UPDATE (the lease ends, so
--   completion waits out every tool call, save and release holding the job KEY SHARE); the run's run box views FOR
--   UPDATE in id order (job, then view: C1B §4); the fence, this company's row and the ranks through the run entry,
--   with a routine run's routine FOR NO KEY UPDATE; the recheck; receipts matched to the commits that carry them; the
--   provider-session owner; the job update (today's v4, v3 and v2 bookkeeping). The run box views end with the run.
--   It never reaches complete_runner_job_before_path_runtime and never takes the run mutex (which comes before the job).
-- * Dispositions from the run's commits: review_pending when a unit waits for review, else published when a commit
--   saved a unit (the run result names the last saving commit, the highest seq), else unchanged. Run results gain
--   folder_commit_id; their check allows published and review_pending with a folder commit in place of a snapshot.
-- * complete_runner_job_v2 skips the source substrate lookup for a folder-v2 job: such a job has none (core C4), and the
--   folder lane refuses artifacts before it.
-- * handoff_run_sponsor accepts a revision receipt satisfied by a folder commit.
-- * resolve_run_operation_receipt's folder-v2 mode: confirmed_completed records the commit that carries the receipt
--   (and refuses a snapshot or proposal); confirmed_not_run refuses while a commit carries it.
--   terminalize_runner_attempt_before_native_start needs no change: it marks executing receipts ambiguous on either core.

-- 1. Patch helpers (names unique to this migration: pg_temp lives for the whole session) ------------------------

create function pg_temp.c1c2c2_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-2c patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;
create function pg_temp.c1c2c2_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'C1c-2c guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'C1c-2c guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'C1c-2c guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;

-- 2. Run results name a folder commit -------------------------------------------------------------------------------

-- No default (no rewrite). The foreign key restricts, as output_snapshot_id's does: a purge finds the result through it
-- and deletes both in one statement, where SET NULL would leave a published result without its commit. The new check
-- is the old one with a folder commit branch; every existing row has no folder commit and met the old check, so it is
-- added NOT VALID (no scan of the table).
alter table public.qorpera_execution_run_results add column folder_commit_id uuid;
alter table public.qorpera_execution_run_results
	add constraint qorpera_execution_run_results_folder_commit_id_fkey foreign key (folder_commit_id)
		references public.qorpera_folder_commits(id) on delete restrict not valid,
	drop constraint qorpera_execution_run_results_check,
	add constraint qorpera_execution_run_results_check check (
		(company_disposition = 'unchanged' and output_snapshot_id is null and proposal_id is null and folder_commit_id is null)
		or (company_disposition = 'published' and proposal_id is null
			and ((output_snapshot_id is not null and folder_commit_id is null) or (output_snapshot_id is null and folder_commit_id is not null)))
		or (company_disposition = 'review_pending'
			and ((output_snapshot_id is not null and proposal_id is not null and folder_commit_id is null)
				or (output_snapshot_id is null and proposal_id is null and folder_commit_id is not null)))) not valid;

-- 3. The folder completion lane -------------------------------------------------------------------------------------

create function public.qorpera_folder_complete_run_job(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid,
	p_lease_token_sha256 text, p_client_artifact_index_id uuid, p_client_substrate_version_id uuid, p_output_snapshot_id uuid,
	p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '25s' set statement_timeout = '25s' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_execution_run_results%rowtype; v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_targets jsonb; v_resolved jsonb; v_receipt jsonb; v_hash text;
	v_started jsonb; v_count integer; v_final uuid; v_transcript_end bigint := 0; v_disposition text := 'unchanged';
	v_commit uuid; v_applied jsonb; v_completed_inputs integer;
begin
	if auth.role() is distinct from 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id,p_session_token_sha256) then
		raise exception 'Runner completion authority is unavailable' using errcode = '42501'; end if;
	-- 1. The job FOR UPDATE: completion ends the lease (core §3 step 2).
	select * into v_job from public.qorpera_runner_jobs where id = p_job_id and runner_id = p_runner_id for update;
	if not found then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Runner job lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	-- The path lane's result: the runtime names no core, and a folder-v2 run publishes no snapshot and no artifacts.
	if p_output_snapshot_id is not null or p_client_artifact_index_id is null or p_client_substrate_version_id is null
		or jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 49152
		or p_result ->> 'schema' is distinct from 'qorpera.runner-result/v1'
		or p_result ->> 'runtime' is distinct from 'company-path-v1'
		or p_result ->> 'backend' is distinct from 'native-company-runtime'
		or p_result - array['schema','runtime','backend','native_lease_id','substrate_version_id',
			'backend_result','output_count','output_bytes','publication','usage'] <> '{}'::jsonb
		or p_result -> 'publication' is distinct from 'null'::jsonb
		or p_result -> 'output_count' is distinct from '0'::jsonb
		or p_result -> 'output_bytes' is distinct from '0'::jsonb
		or p_result ->> 'substrate_version_id' is distinct from v_job.substrate_version_id::text then
		raise exception 'Governed completion cannot publish a whole Company File or artifacts' using errcode = '22023'; end if;
	v_hash := encode(extensions.digest(convert_to(p_result::text,'utf8'),'sha256'),'hex');
	select * into v_existing from public.qorpera_execution_run_results where job_id = v_job.id;
	if found then
		if v_job.status <> 'completed' or v_job.terminal_lease_token_sha256 is distinct from p_lease_token_sha256
			or v_existing.runner_id <> p_runner_id or v_existing.result_sha256 <> v_hash
			or v_existing.client_artifact_index_id <> p_client_artifact_index_id
			or v_existing.client_substrate_version_id <> p_client_substrate_version_id then
			raise exception 'Runner completion replay differs from its receipt' using errcode = '23505'; end if;
		-- A replay conveys no new read, write, model call or public send.
		return public.qorpera_runner_job_json(v_job);
	end if;
	v_job := public.qorpera_runner_broker_locked_job(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256);
	select * into strict v_run from public.qorpera_execution_runs where id = v_job.run_id;
	select * into v_lease from public.qorpera_native_provider_connection_leases
	where id = (p_result ->> 'native_lease_id')::uuid and run_id = v_run.id and job_id = v_job.id;
	if not found then raise exception 'Native completion authority is unavailable' using errcode = '42501'; end if;
	-- 2. The run's run box views, FOR UPDATE in id order: after the job, before the fence (C1B §4). Closing waits out a
	-- view's save in flight.
	perform 1 from public.qorpera_folder_views where kind = 'run_box' and run_id = v_run.id and state = 'open' order by id for update;
	-- 3. The fence with the stop re-read, this company's row and the ranks, through the run entry; a routine run's
	-- routine FOR NO KEY UPDATE at rank 5 (merged with the run check's own KEY SHARE on it).
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	v_targets := jsonb_build_array(jsonb_build_object('rank', 0, 'tbl', 'qorpera_profiles', 'key', v_run.profile_id::text,
		'mode', 'keyshare', 'required', true))
		|| case when v_wake.wake_kind = 'routine' then jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines',
			'key', v_wake.routine_id::text, 'mode', 'nokeyupdate', 'required', true)) else '[]'::jsonb end;
	v_resolved := public.qorpera_folder_run_enter(v_run.environment_id, v_run.profile_id, jsonb_build_object('kind', 'run',
		'runId', v_run.id, 'jobId', v_job.id, 'runnerId', p_runner_id, 'assignmentId', v_job.client_lease_id), v_targets);
	-- 4. Rank 10: the run's released reads still hold.
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_resolved);
	select payload into v_started from public.qorpera_execution_run_events where run_id = v_run.id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1'
	order by id desc limit 1;
	if not found or v_started ->> 'runId' is distinct from v_run.id::text
		or v_started ->> 'jobId' is distinct from v_job.id::text
		or v_started ->> 'leaseId' is distinct from v_lease.id::text
		or coalesce(v_started ->> 'binarySha256','') !~ '^[0-9a-f]{64}$' then
		raise exception 'Native execution has no matching durable admission' using errcode = '55000'; end if;
	if exists(select 1 from public.qorpera_runner_model_requests where job_id = v_job.id and status = 'reserved')
		or exists(select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id and status in ('executing','ambiguous'))
		or exists(select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then
		raise exception 'Governed execution has unresolved or ungoverned work' using errcode = '55000'; end if;
	-- 5. Every completed receipt that requires a revision names a commit of this run that carries it.
	if exists(select 1 from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id
		and receipt.status = 'completed' and receipt.requires_company_revision and not exists (
			select 1 from public.qorpera_folder_commits c where c.id = receipt.folder_commit_id and c.receipt_id = receipt.id
				and c.run_id = v_run.id and c.environment_id = v_run.environment_id)) then
		raise exception 'Governed completion omitted a folder commit receipt' using errcode = '55000'; end if;
	v_receipt := p_result -> 'backend_result';
	select count(*),max(delivery.event_id::text) filter(where delivery.phase = 'final'),coalesce(max(event.sequence),0)
	into v_count,v_final,v_transcript_end from public.qorpera_agent_sends delivery
	join public.qorpera_session_events event on event.event_id = delivery.event_id
	where delivery.run_id = v_run.id and delivery.assignment_id = v_job.client_lease_id;
	perform public.qorpera_assert_wake_completion(v_run.id);
	if v_count = 0 then v_transcript_end := v_run.transcript_start_sequence; end if;
	if jsonb_typeof(v_receipt) is distinct from 'object'
		or v_receipt - array['schema','run_id','message_count','final_message_id','provider_session_id'] <> '{}'::jsonb
		or v_receipt ->> 'schema' is distinct from 'qorpera.native-harness-result/v2'
		or v_receipt ->> 'run_id' is distinct from v_run.id::text
		or v_receipt -> 'message_count' is distinct from to_jsonb(v_count)
		or v_receipt -> 'final_message_id' is distinct from coalesce(to_jsonb(v_final),'null'::jsonb)
		or (v_run.session_id is null and v_count <> 0)
		or (v_count > 0 and (v_final is null or v_transcript_end <= v_run.transcript_start_sequence))
		or jsonb_typeof(v_receipt -> 'provider_session_id') is distinct from 'string'
		or char_length(btrim(v_receipt ->> 'provider_session_id')) not between 1 and 1024 then
		raise exception 'Native completion does not match durable public delivery' using errcode = '55000'; end if;
	-- 6. The provider-session owner.
	perform public.qorpera_bind_execution_provider_session(p_runner_id,p_session_token_sha256,p_job_id,
		p_lease_token_sha256,v_receipt ->> 'provider_session_id',null);
	-- The disposition from the run's commits: a unit waiting for review, else the last saving commit.
	select c.id into v_commit from public.qorpera_folder_commits c
	where c.run_id = v_run.id and c.environment_id = v_run.environment_id
		and exists (select 1 from jsonb_array_elements(c.units) u where u ->> 'outcome' = 'waiting_for_review')
	order by c.created_at desc, c.id desc limit 1;
	if v_commit is not null then v_disposition := 'review_pending';
	else
		select c.id into v_commit from public.qorpera_folder_commits c
		where c.run_id = v_run.id and c.environment_id = v_run.environment_id and c.seq is not null order by c.seq desc limit 1;
		if v_commit is not null then v_disposition := 'published'; end if;
	end if;
	select coalesce(jsonb_agg(receipt.id order by receipt.completed_at,receipt.id),'[]'::jsonb) into v_applied
	from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id and receipt.folder_commit_id is not null;
	-- 7. The job update: today's bookkeeping, final-send trigger and native lease cleanup.
	perform public.qorpera_complete_runner_job_v4(p_runner_id,p_session_token_sha256,p_job_id,p_lease_token_sha256,
		p_client_artifact_index_id,p_client_substrate_version_id,p_result);
	update public.qorpera_runner_jobs set result = result || jsonb_build_object('company_file',jsonb_build_object(
		'runtime','folder-v2','disposition',v_disposition,'folder_commit_id',v_commit,
		'native_binary_sha256',v_started ->> 'binarySha256','applied_receipt_ids',v_applied)) where id = v_job.id returning * into v_job;
	if pg_column_size(v_job.result) > 65536 then raise exception 'Runner completion receipt is too large' using errcode = '54000'; end if;
	-- The run's run box views end with it.
	update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'ended'
	where kind = 'run_box' and run_id = v_run.id and state = 'open';
	insert into public.qorpera_execution_run_results(run_id,job_id,assignment_id,runner_id,transcript_end_sequence,
		company_disposition,output_snapshot_id,proposal_id,folder_commit_id,client_artifact_index_id,client_substrate_version_id,
		result_sha256)
	values(v_run.id,v_job.id,v_job.client_lease_id,p_runner_id,v_transcript_end,v_disposition,null,null,v_commit,
		p_client_artifact_index_id,p_client_substrate_version_id,v_hash);
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs set completed_at = clock_timestamp()
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		get diagnostics v_completed_inputs = row_count;
		if v_completed_inputs <> cardinality(v_run.input_ids) then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Runner session inputs changed before completion', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	end if;
	return public.qorpera_runner_job_json(v_job);
end $$;

-- 4. Receipt recovery on folder-v2 ------------------------------------------------------------------------------------

-- A member with authorize access resolves an ambiguous receipt, as today. confirmed_completed records the folder commit
-- that carries the receipt (one per receipt, qorpera_folder_commits_one_per_receipt), never a snapshot or proposal; a
-- receipt that requires a revision and that no commit carries cannot be confirmed completed. confirmed_not_run refuses
-- while a commit carries the receipt: the operation ran.
create function public.qorpera_folder_resolve_run_receipt(p_receipt_id uuid, p_resolution text, p_result jsonb,
	p_output_snapshot_id uuid, p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_run public.qorpera_execution_runs%rowtype; v_commit uuid;
begin
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt where receipt.id = p_receipt_id for update;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_receipt.run_id;
	if v_user_id is null or v_receipt.id is null or not public.qorpera_can_authorize_profile(v_run.profile_id) then
		raise exception 'operation recovery requires authorize access' using errcode = '42501'; end if;
	if v_receipt.status <> 'ambiguous' or p_resolution is null or p_resolution not in ('confirmed_completed', 'confirmed_not_run') then
		raise exception 'operation recovery is unavailable' using errcode = '55000'; end if;
	select c.id into v_commit from public.qorpera_folder_commits c
	where c.receipt_id = v_receipt.id and c.run_id = v_run.id and c.environment_id = v_run.environment_id;
	if p_resolution = 'confirmed_completed' then
		if jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 65536
			or p_output_snapshot_id is not null or p_proposal_id is not null
			or (v_receipt.requires_company_revision and v_commit is null) then
			raise exception 'operation recovery result is invalid' using errcode = '22023'; end if;
		update public.qorpera_run_operation_receipts
		set status = 'completed', result = p_result, folder_commit_id = v_commit, recovery_resolution = p_resolution,
			recovery_resolved_by_user_id = v_user_id, recovery_resolved_at = statement_timestamp()
		where id = p_receipt_id returning * into v_receipt;
	else
		if v_commit is not null then
			raise exception 'A folder commit carries this operation: it ran' using errcode = '55000'; end if;
		update public.qorpera_run_operation_receipts
		set status = 'cancelled', recovery_resolution = p_resolution,
			recovery_resolved_by_user_id = v_user_id, recovery_resolved_at = statement_timestamp()
		where id = p_receipt_id returning * into v_receipt;
	end if;
	return jsonb_build_object('receipt_id', v_receipt.id, 'status', v_receipt.status,
		'recovery_resolution', v_receipt.recovery_resolution, 'folder_commit_id', v_receipt.folder_commit_id);
end $$;

-- 5. Dispatch and patches ------------------------------------------------------------------------------------------

do $$
begin
	-- v6: the folder lane in place of C1c-1's refusal (C1c-1 §4: it replaces the guard, it adds no lane behind it).
	perform pg_temp.c1c2c2_replace('public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)',
		'if public.qorpera_job_is_folder_v2(p_job_id) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;',
		'if public.qorpera_job_is_folder_v2(p_job_id) then return public.qorpera_folder_complete_run_job(p_runner_id, '
		|| 'p_session_token_sha256, p_job_id, p_lease_token_sha256, p_client_artifact_index_id, p_client_substrate_version_id, '
		|| 'p_output_snapshot_id, p_result); end if;', 1);
	-- v2: a folder-v2 job has no source substrate (core C4); the folder lane refused artifacts before it, and this
	-- refuses them again rather than reading a substrate.
	perform pg_temp.c1c2c2_replace('public.qorpera_complete_runner_job_v2(uuid,text,uuid,text,uuid,uuid,jsonb)',
		E'\tselect version.* into strict v_source\n'
		|| E'\tfrom public.qorpera_company_substrate_versions as version\n'
		|| E'\twhere version.id = v_job.substrate_version_id;\n'
		|| E'\tif v_source.profile_id <> v_job.profile_id or v_source.environment_id <> v_job.environment_id then\n'
		|| E'\t\traise exception ''runner source substrate is inconsistent'' using errcode = ''55000'';\n'
		|| E'\tend if;\n',
		E'\tif public.qorpera_job_is_folder_v2(v_job.id) then\n'
		|| E'\t\tif exists (select 1 from public.qorpera_runner_job_artifacts where job_id = v_job.id) then\n'
		|| E'\t\t\traise exception ''runner source substrate is inconsistent'' using errcode = ''55000''; end if;\n'
		|| E'\telse\n'
		|| E'\tselect version.* into strict v_source\n'
		|| E'\tfrom public.qorpera_company_substrate_versions as version\n'
		|| E'\twhere version.id = v_job.substrate_version_id;\n'
		|| E'\tif v_source.profile_id <> v_job.profile_id or v_source.environment_id <> v_job.environment_id then\n'
		|| E'\t\traise exception ''runner source substrate is inconsistent'' using errcode = ''55000'';\n'
		|| E'\tend if;\n'
		|| E'\tend if;\n', 1);
	-- The handoff: a revision receipt satisfied by a folder commit may cross the attempt boundary (only folder-v2
	-- receipts ever carry one).
	perform pg_temp.c1c2c2_replace('public.qorpera_handoff_run_sponsor(uuid,text)',
		E'\t\t\t\tand proposal_id is null and company_path_proposal_id is null)))\n',
		E'\t\t\t\tand proposal_id is null and company_path_proposal_id is null and folder_commit_id is null)))\n', 1);
	-- Recovery: a folder-v2 receipt resolves through the folder mode.
	perform pg_temp.c1c2c2_guard('public.qorpera_resolve_run_operation_receipt(uuid,text,jsonb,uuid,uuid)',
		'if public.qorpera_environment_is_folder_v2((select run.environment_id from public.qorpera_run_operation_receipts receipt '
		|| 'join public.qorpera_execution_runs run on run.id = receipt.run_id where receipt.id = p_receipt_id)) then '
		|| 'return public.qorpera_folder_resolve_run_receipt(p_receipt_id, p_resolution, p_result, p_output_snapshot_id, p_proposal_id); end if;');
end $$;

-- 6. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through v6 and the recovery function.
revoke all on function public.qorpera_folder_complete_run_job(uuid, text, uuid, text, uuid, uuid, uuid, jsonb)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_resolve_run_receipt(uuid, text, jsonb, uuid, uuid)
	from public, anon, authenticated, service_role;
