-- Run after the real wake fixture. Expiry is injected only into its disposable
-- claim; production RPCs must reject the terminal state without creating work.
savepoint terminal_claims;
update public.qorpera_runner_job_claims set lease_expires_at=statement_timestamp()-interval '1 second'
where id='30000000-0000-4000-8000-000000000093';
do $$
declare v_binding jsonb:=current_setting('qorpera_test.wake_binding')::jsonb;
	v_assignments bigint; v_runs bigint;
begin
	select count(*) into v_assignments from public.qorpera_runner_assignments;
	select count(*) into v_runs from public.qorpera_execution_runs;
	perform pg_temp.wake_error(format('select public.qorpera_assign_runner_job(%L,%L,%L,%L,%L,120)',
		'30000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000093',
		v_binding->>'runnerId',extensions.gen_random_uuid(),repeat('4',64)),
		'55000','orchestrator claim is unavailable');
	perform pg_temp.wake_error($call$select public.qorpera_renew_runner_job_claim(
		'30000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000093',120)$call$,
		'55000','orchestrator claim is unavailable');
	perform pg_temp.wake_error($call$select public.qorpera_claim_runner_job_for_orchestrator(
		'30000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000093',120)$call$,
		'55000','orchestrator claim replay is unavailable');
	perform pg_temp.wake_assert((select count(*)=v_assignments from public.qorpera_runner_assignments)
		and (select count(*)=v_runs from public.qorpera_execution_runs),
		'Terminal claim denial neither reassigns nor admits work');
end
$$;
rollback to terminal_claims;
