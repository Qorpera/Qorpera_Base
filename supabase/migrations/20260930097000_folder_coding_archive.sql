-- C3b: the agent's archive of a coding session on folder-v2 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8
-- "Plan (C3)"). `manage_worker`'s archive closes a coding session the agent no longer needs: an active one is cancelled
-- first, its programs stop and it leaves its machine, its files and branch are kept, and a later follow-up reopens it.
-- On snapshot-v1 it was a branch of qorpera_manage_agent_worker; on folder-v2 it is a run effect like F2's cancel
-- (qorpera_folder_cancel_agent_worker): no file, the run's check with the todo (FOR SHARE) and the worker (FOR NO KEY
-- UPDATE) at rank 5, the receipt, then qorpera_archive_coding_worker, which writes the session after the worker, as every
-- coding-session writer does. A session that has a new turn since the agent was asked about it is left alone (55000), as
-- before. The native host may call it with the binding's scope, beside cancel.

set local lock_timeout = '3s';

create function public.qorpera_folder_archive_coding_worker(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid; v_environment uuid; v_worker public.qorpera_runtime_workers%rowtype; v_targets jsonb := '[]'::jsonb;
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_folder text; v_archived boolean;
	c_path constant text := '^agents/[a-z0-9]+(-[a-z0-9]+)*/todos/[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$';
begin
	-- 20260930097000 (C3b).
	if jsonb_typeof(p_request) is distinct from 'object'
		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k) is distinct from array['folder','operationKey']
		or coalesce(p_request ->> 'operationKey', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or coalesce(p_request ->> 'folder', '') !~ c_path
		or public.qorpera_company_state_worker_folder(p_request ->> 'folder') is distinct from (p_request ->> 'folder') then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;
	v_folder := p_request ->> 'folder';
	-- The targets, from an unlocked read of the run's company and the worker.
	if coalesce(p_binding ->> 'jobId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		select file.profile_id, file.environment_id into v_profile, v_environment from public.qorpera_runner_jobs job
		join public.qorpera_company_files file on file.environment_id = job.environment_id and file.core = 'folder-v2'
		where job.id = (p_binding ->> 'jobId')::uuid;
	end if;
	if v_environment is not null then
		v_worker := public.qorpera_company_state_worker_at(v_environment, v_folder);
		if v_worker.id is not null then
			v_targets := jsonb_build_array(
				jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_agent_todos', 'key', v_worker.todo_id::text, 'mode', 'share',
					'required', false),
				jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers', 'key', v_worker.id::text, 'mode', 'nokeyupdate',
					'required', false));
		end if;
	end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, v_targets);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	-- Only the agent's own company run archives its sessions (contract 13).
	if v_tool -> 'resolved' -> 'audience' ->> 'kind' is distinct from 'company' or (public.qorpera_run_worker(v_run.id)).id is not null
		or not exists (select 1 from public.qorpera_profile_staff s where s.profile_id = v_run.profile_id
			and s.staff_agent_id = v_run.staff_agent_id and s.folder_environment_id = v_run.environment_id and s.folder_retired_at is null
			and s.deleted_at is null
			and public.qorpera_folder_key(public.qorpera_folder_parent_path(s.folder_path)) = array_to_string((string_to_array(v_folder, '/'))[1:2], '/')) then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('schema', 'qorpera.folder-coding-archive/v1',
		'runId', v_run.id, 'folder', v_folder, 'operationKey', p_request ->> 'operationKey')::text, 'utf8'), 'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(p_binding, v_receipt_id, 'worker:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':worker:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Worker operation needs reconciliation' using errcode = '55000'; end if;
	-- No worker at the folder, or only a retired one: nothing to archive (never a retry).
	if v_worker.id is null or v_worker.folder_retired_at is not null then
		raise exception 'Worker is unavailable' using errcode = 'P0002'; end if;
	-- Read again under the locks: the worker the targets named, still at its folder.
	select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	if v_worker.id is null or v_worker.folder_retired_at is not null or v_worker.folder_environment_id <> v_run.environment_id
		or v_worker.folder_key <> public.qorpera_folder_key(v_folder) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'The worker changed while the archive waited',
			'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	if v_worker.species <> 'coding' then
		raise exception 'Only a coding session can be archived' using errcode = '22023'; end if;
	if public.qorpera_coding_question_stale(v_run.id, v_worker) then
		raise exception 'The session has a new turn since you were asked; leave it' using errcode = '55000'; end if;
	v_archived := public.qorpera_archive_coding_worker(v_worker, 'agent', v_run.id, null);
	select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	v_result := jsonb_build_object('schema', 'qorpera.agent-worker-receipt/v1', 'runId', v_run.id, 'receiptId', v_receipt_id,
		'action', 'archive', 'folder', v_worker.folder_path, 'archived', v_archived,
		'worker', public.qorpera_worker_view(v_worker, false),
		'phase', (select s.phase from public.qorpera_coding_sessions s where s.worker_id = v_worker.id));
	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;
revoke all on function public.qorpera_folder_archive_coding_worker(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_archive_coding_worker(jsonb, jsonb) to service_role;

-- The native host may call it (G2), with the binding's scope, as cancel.
insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_archive_coding_worker', 'binding');
