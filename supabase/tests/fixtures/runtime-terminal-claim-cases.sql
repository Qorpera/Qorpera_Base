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

-- A runner already accepted this claim. Releasing it cannot become valid by
-- retrying a transaction; PostgREST must receive a terminal application error.
savepoint terminal_release;
do $$
declare v_binding jsonb:=current_setting('qorpera_test.wake_binding')::jsonb;
	v_before jsonb;
begin
	select jsonb_build_object('claim',to_jsonb(c),'assignment',to_jsonb(a),'job',to_jsonb(j),
		'events',(select count(*) from public.qorpera_execution_run_events where run_id=c.run_id))
	into v_before from public.qorpera_runner_job_claims c
	join public.qorpera_runner_assignments a on a.claim_id=c.id
	join public.qorpera_runner_jobs j on j.id=c.job_id
	where c.id='30000000-0000-4000-8000-000000000093';
	perform pg_temp.wake_error(format('select public.qorpera_release_runner_job_claim(%L,%L,%L,%L)',
		'30000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000093',
		v_binding->>'assignmentId','Disposable late release'),
		'55000','runner claim is already owned by a runner');
	perform pg_temp.wake_error(format('select public.qorpera_release_runner_job_claim(%L,%L,%L,%L)',
		'30000000-0000-4000-8000-000000000092',extensions.gen_random_uuid(),
		v_binding->>'assignmentId','Disposable missing release'),
		'55000','runner claim is unavailable');
	perform pg_temp.wake_assert(v_before=(select jsonb_build_object('claim',to_jsonb(c),
		'assignment',to_jsonb(a),'job',to_jsonb(j),
		'events',(select count(*) from public.qorpera_execution_run_events where run_id=c.run_id))
		from public.qorpera_runner_job_claims c join public.qorpera_runner_assignments a on a.claim_id=c.id
		join public.qorpera_runner_jobs j on j.id=c.job_id
		where c.id='30000000-0000-4000-8000-000000000093'),
		'Terminal release leaves accepted claim, assignment, job and event history unchanged');
end $$;
rollback to terminal_release;

savepoint unavailable_release_assignment;
update public.qorpera_runner_job_claims set status='assigned'
where id='30000000-0000-4000-8000-000000000093';
do $$
declare v_binding jsonb:=current_setting('qorpera_test.wake_binding')::jsonb;
begin
	perform pg_temp.wake_error(format('select public.qorpera_release_runner_job_claim(%L,%L,%L,%L)',
		'30000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000093',
		extensions.gen_random_uuid(),'Disposable wrong assignment'),
		'55000','runner assignment is unavailable');
	perform pg_temp.wake_error(format('select public.qorpera_release_runner_job_claim(%L,%L,%L,%L)',
		'30000000-0000-4000-8000-000000000092','30000000-0000-4000-8000-000000000093',
		v_binding->>'assignmentId','Disposable accepted assignment'),
		'55000','runner assignment is unavailable');
	perform pg_temp.wake_assert((select status='assigned' and released_at is null
		from public.qorpera_runner_job_claims where id='30000000-0000-4000-8000-000000000093')
		and (select status='accepted' from public.qorpera_runner_assignments
			where id=(v_binding->>'assignmentId')::uuid),
		'Unavailable assignment release preserves both states');
end $$;
rollback to unavailable_release_assignment;

-- Real admission and claim producers still support a recoverable dispatch
-- failure. Releasing twice must not consume another attempt or add an event.
savepoint recoverable_release;
do $$
declare v_input uuid; v_run uuid; v_claim jsonb; v_result jsonb; v_before jsonb;
	v_assignment uuid:=extensions.gen_random_uuid();
begin
	insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
	values('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'user_message',
		'30000000-0000-4000-8000-000000000001','{"schema":"qorpera.session-prompt/v1","text":"Release fixture.","images":[]}')
	returning id into v_input;
	perform public.qorpera_materialize_session_execution_runs(1);
	select execution_run_id into strict v_run from public.qorpera_session_inputs where id=v_input;
	v_claim:=public.qorpera_claim_runner_job_for_orchestrator(
		'30000000-0000-4000-8000-000000000092',extensions.gen_random_uuid(),120);
	perform pg_temp.wake_assert(v_claim#>>'{work,run_id}'=v_run::text,'Recoverable release claims its real admitted job');
	v_result:=public.qorpera_release_runner_job_claim('30000000-0000-4000-8000-000000000092',
		(v_claim->>'claim_id')::uuid,v_assignment,'Disposable infrastructure failure');
	perform pg_temp.wake_assert(v_result='{"released":true,"dispatch_failure_count":1,"terminal":false}'::jsonb,
		'Recoverable release records one infrastructure attempt');
	select jsonb_build_object('claim',to_jsonb(c),'job',to_jsonb(j),
		'events',(select jsonb_agg(to_jsonb(e) order by e.id) from public.qorpera_execution_run_events e where e.run_id=v_run))
	into v_before from public.qorpera_runner_job_claims c join public.qorpera_runner_jobs j on j.id=c.job_id
	where c.id=(v_claim->>'claim_id')::uuid;
	perform pg_temp.wake_assert(public.qorpera_release_runner_job_claim('30000000-0000-4000-8000-000000000092',
		(v_claim->>'claim_id')::uuid,v_assignment,'Disposable infrastructure failure')='{"released":true}'::jsonb,
		'Released claim replay remains successful');
	perform pg_temp.wake_assert(v_before=(select jsonb_build_object('claim',to_jsonb(c),'job',to_jsonb(j),
		'events',(select jsonb_agg(to_jsonb(e) order by e.id) from public.qorpera_execution_run_events e where e.run_id=v_run))
		from public.qorpera_runner_job_claims c join public.qorpera_runner_jobs j on j.id=c.job_id
		where c.id=(v_claim->>'claim_id')::uuid),'Release replay preserves exact claim, job and events');
end $$;
rollback to recoverable_release;
