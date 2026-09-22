-- @fixture 150_runner_orchestrator.test.sql until "'qorpera_test.partial_attempt_input'"
-- A failed run whose durable outcome is still unknown cannot be discarded, but
-- a member can acknowledge it: the failure stops standing in for the agent,
-- nothing is replayed or changed, and acknowledging again is a no-op.
	'qorpera_test.acknowledged_input',
	public.qorpera_append_session_input(
		'15000000-0000-4000-8000-000000000055',
		'15000000-0000-4000-8000-000000000585',
		'user_message',
		'{"schema":"qorpera.session-prompt/v1","text":"Open the ledger and report the balance.","images":[]}'
	)::text,
	false
);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
select set_config(
	'qorpera_test.acknowledged_run',
	(public.qorpera_materialize_session_execution_runs(32) -> 0)::text,
	false
);
-- The lease expired after the agent had done work whose outcome nobody confirmed.
update public.qorpera_runner_jobs
set status = 'failed', last_error = 'Runner lease expired before durable completion; durable attempt output requires review',
	finished_at = statement_timestamp()
where id = (current_setting('qorpera_test.acknowledged_run')::jsonb ->> 'job_id')::uuid;
insert into public.qorpera_run_operation_receipts (
	id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
	input_sha256, downstream_idempotency_sha256, status, completed_at
) values (
	'15000000-0000-4000-8000-000000000586',
	(current_setting('qorpera_test.acknowledged_run')::jsonb ->> 'run_id')::uuid,
	(current_setting('qorpera_test.acknowledged_run')::jsonb ->> 'job_id')::uuid,
	'15000000-0000-4000-8000-000000000102',
	'external:ledger:report', 'company_operation', repeat('5', 64), repeat('8', 64),
	'ambiguous', statement_timestamp()
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000001","email":"orchestrator-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_run_id uuid := (current_setting('qorpera_test.acknowledged_run')::jsonb ->> 'run_id')::uuid;
	v_environment uuid := '15000000-0000-4000-8000-000000000020';
	v_result jsonb;
	v_row jsonb;
begin
	-- The failure outranks everything else the agent did.
	select entry into v_row
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity(v_environment)) as entry
	where (entry ->> 'run_id')::uuid = v_run_id;
	if v_row is null or v_row ->> 'activity' is distinct from 'needs_attention'
		or v_row ->> 'job_status' is distinct from 'failed' then
		raise exception 'unacknowledged failure with an ambiguous receipt was absent from staff activity';
	end if;
	-- Discard still refuses: the outcome is unknown.
	begin
		perform public.qorpera_resolve_failed_execution_run(v_run_id, 'discard');
		raise exception 'a run with an ambiguous receipt was discarded';
	exception when object_not_in_prerequisite_state then null;
	end;
	-- Acknowledge succeeds, records the member, and changes nothing else.
	v_result := public.qorpera_resolve_failed_execution_run(v_run_id, 'acknowledge');
	if v_result ->> 'action' is distinct from 'acknowledge' or (v_result ->> 'resolved')::boolean is not true
		or (v_result ->> 'run_id')::uuid is distinct from v_run_id then
		raise exception 'acknowledgment did not answer with the acknowledged run';
	end if;
	if (select count(*) from public.qorpera_execution_run_events as event
		where event.run_id = v_run_id and event.event_type = 'recovery_acknowledged'
			and event.payload ->> 'resolved_by_user_id' = '15000000-0000-4000-8000-000000000001') <> 1 then
		raise exception 'acknowledgment was not recorded once for the member';
	end if;
	if exists (select 1 from public.qorpera_run_operation_receipts as receipt
		where receipt.run_id = v_run_id and receipt.status <> 'ambiguous') then
		raise exception 'acknowledgment touched an operation receipt';
	end if;
	if exists (select 1 from public.qorpera_runner_jobs as job
		where job.id = (current_setting('qorpera_test.acknowledged_run')::jsonb ->> 'job_id')::uuid
			and job.status <> 'failed') then
		raise exception 'acknowledgment changed the job';
	end if;
	-- The agent's activity no longer reports the acknowledged failure.
	if exists (
		select 1 from jsonb_array_elements(public.qorpera_list_staff_execution_activity(v_environment)) as entry
		where (entry ->> 'run_id')::uuid = v_run_id
	) then
		raise exception 'acknowledged failure still stood in for the agent';
	end if;
	-- Acknowledging again is a no-op, not an error.
	v_result := public.qorpera_resolve_failed_execution_run(v_run_id, 'acknowledge');
	if (v_result ->> 'resolved')::boolean is not true then
		raise exception 'second acknowledgment was refused';
	end if;
	if (select count(*) from public.qorpera_execution_run_events as event
		where event.run_id = v_run_id and event.event_type = 'recovery_acknowledged') <> 1 then
		raise exception 'second acknowledgment was recorded again';
	end if;
	-- Acknowledging does not unlock what the unknown outcome forbids.
	begin
		perform public.qorpera_resolve_failed_execution_run(v_run_id, 'retry');
		raise exception 'an acknowledged run with an ambiguous receipt was retried';
	exception when object_not_in_prerequisite_state then null;
	end;
	-- The run's details remain readable for the thread.
	if public.qorpera_get_execution_run_recovery(v_run_id) -> 'job' ->> 'status' is distinct from 'failed' then
		raise exception 'acknowledged run lost its recovery details';
	end if;
end
$$;

-- A member without write access cannot acknowledge.
reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"15000000-0000-4000-8000-000000000003","email":"orchestrator-reader@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
begin
	begin
		perform public.qorpera_resolve_failed_execution_run(
			(current_setting('qorpera_test.acknowledged_run')::jsonb ->> 'run_id')::uuid, 'acknowledge'
		);
		raise exception 'a reader acknowledged a failed run';
	exception when insufficient_privilege then null;
	end;
end
$$;

reset role;
rollback;
