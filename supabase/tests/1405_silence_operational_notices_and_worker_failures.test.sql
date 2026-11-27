-- @fixture 830_runtime_run_no_progress_notice.test.sql until "-- A. A run that just started is working"

create function pg_temp.snf_assert(p_ok boolean, p_msg text)
returns void language plpgsql as $$
begin
	if not coalesce(p_ok, false) then
		raise exception 'silence_operational_notices_and_worker_failures: %', p_msg;
	end if;
end $$;

create function pg_temp.snf_activity_has_run(p_run uuid)
returns boolean language plpgsql as $$
declare v_rows jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_rows := public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020');
	reset role;
	perform pg_temp.base_claims('service_role');
	return exists (
		select 1 from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) elem
		where elem ->> 'run_id' = p_run::text
	);
end $$;

do $$
declare
	v_run uuid := pg_temp.st_run();
	v_job uuid;
	v_occ uuid;
	v_kind text;
	v_sweep jsonb;
	v_receipt uuid;
begin
	select job_id, source_id into strict v_job, v_occ
	from public.qorpera_execution_runs where id = v_run;

	perform pg_temp.st_age(30);
	insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
	values (
		'92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001',
		'run_no_progress',
		jsonb_build_object('schema', 'qorpera.member-notification.run-no-progress/v1', 'runId', v_run),
		v_run::text
	);
	v_sweep := pg_temp.st_sweep();
	perform pg_temp.snf_assert(
		v_sweep ->> 'opened' = '0'
		and v_sweep ->> 'closed' = '1'
		and pg_temp.st_open_notices() = '{}',
		'notify_runs_without_progress opens zero new notices and closes pre-existing run_no_progress notices: ' || v_sweep::text
	);

	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'failed', last_error = 'Background run timed out',
		finished_at = clock_timestamp(), lease_token_sha256 = null, lease_expires_at = null
	where id = v_job;
	update public.qorpera_wake_occurrences
	set status = 'failed', finished_at = clock_timestamp()
	where id = v_occ;
	set local session_replication_role = origin;

	foreach v_kind in array array[
		'worker-dispatch', 'worker-completion', 'machine-event',
		'machine-checkin', 'office-activation', 'surface-escalation', 'light-ask'
	] loop
		set local session_replication_role = replica;
		update public.qorpera_wake_occurrences set source_kind = v_kind where id = v_occ;
		set local session_replication_role = origin;
		perform pg_temp.snf_assert(
			not pg_temp.snf_activity_has_run(v_run),
			'failed background wake ' || v_kind || ' without unsettled receipts stays out of chat activity'
		);
	end loop;

	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set source_kind = 'worker-dispatch' where id = v_occ;
	v_receipt := extensions.gen_random_uuid();
	insert into public.qorpera_run_operation_receipts(
		id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, requires_company_revision
	)
	values (
		v_receipt, v_run, v_job, extensions.gen_random_uuid(), 'snf-unsettled', 'cloud_tool',
		repeat('a', 64), repeat('b', 64), 'executing', true
	);
	set local session_replication_role = origin;
	perform pg_temp.snf_assert(
		pg_temp.snf_activity_has_run(v_run),
		'failed worker-dispatch with an executing receipt still surfaces for recovery'
	);

	set local session_replication_role = replica;
	update public.qorpera_run_operation_receipts
	set status = 'ambiguous', completed_at = clock_timestamp()
	where id = v_receipt;
	set local session_replication_role = origin;
	perform pg_temp.snf_assert(
		pg_temp.snf_activity_has_run(v_run),
		'failed worker-dispatch with an ambiguous receipt still surfaces for recovery'
	);

	set local session_replication_role = replica;
	update public.qorpera_run_operation_receipts
	set status = 'completed', result = '{"ok":true}'::jsonb
	where id = v_receipt;
	update public.qorpera_runner_jobs set last_error = 'Run failed [code=RUN_COMPLETION_REFUSED]' where id = v_job;
	set local session_replication_role = origin;
	perform pg_temp.snf_assert(
		pg_temp.snf_activity_has_run(v_run),
		'failed worker-dispatch with RUN_COMPLETION_REFUSED still surfaces for recovery'
	);

	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set last_error = 'Provider error' where id = v_job;
	update public.qorpera_execution_runs
	set source_kind = 'session_turn', input_ids = array[extensions.gen_random_uuid()]
	where id = v_run;
	set local session_replication_role = origin;
	perform pg_temp.snf_assert(
		pg_temp.snf_activity_has_run(v_run),
		'failed direct user session_turn without final answer still surfaces in chat activity'
	);
end $$;

rollback;
