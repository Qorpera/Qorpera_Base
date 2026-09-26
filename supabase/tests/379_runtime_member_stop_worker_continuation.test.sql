-- @fixture 385_runtime_workers_todos.test.sql until "-- 8. One worker per coherent stream"
-- A worker's report revives its parent with a continuation (a wake run) in the
-- parent's conversation. A member's Stop there reaches that run
-- (20260926183100), through the same authority as a member turn, and counts as
-- a person stopping the revival: the parent's workers that still run stop with
-- it (qorpera_worker_revival_stopped, the drain's parent_stopped).

select pg_temp.path_claims('service_role');
do $$
declare v_run uuid := (current_setting('qorpera_test.revived_binding')::jsonb ->> 'runId')::uuid;
begin
	perform pg_temp.wake_assert((select run.source_kind = 'wake' and run.session_id = '30000000-0000-4000-8000-000000000040'
		and job.status = 'leased' and job.created_by_user_id = '30000000-0000-4000-8000-000000000001'
		from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id where run.id = v_run),
		'Fixture: the continuation works in the parent''s conversation for the member who started it');
end
$$;

set role authenticated;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert(public.qorpera_get_session_run_control('30000000-0000-4000-8000-000000000040') -> 'run'
	= jsonb_build_object('run_id',current_setting('qorpera_test.revived_binding')::jsonb ->> 'runId','status','leased','can_cancel',false),
	'Another contributor sees the continuation and may not stop it');
select pg_temp.wake_error(format('select public.qorpera_cancel_session_run(%L,%L)','30000000-0000-4000-8000-000000000040',
	current_setting('qorpera_test.revived_binding')::jsonb ->> 'runId'),'42501');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_get_session_run_control('30000000-0000-4000-8000-000000000040') #>> '{run,can_cancel}' = 'true',
	'The member it works for may stop it');
select pg_temp.wake_assert(public.qorpera_cancel_session_run('30000000-0000-4000-8000-000000000040',
	(current_setting('qorpera_test.revived_binding')::jsonb ->> 'runId')::uuid) ->> 'status' = 'cancelled',
	'Stop cancels the continuation');
reset role;

select pg_temp.wake_assert((select status = 'cancelled' and cancelled_by_user_id = '30000000-0000-4000-8000-000000000001'
	from public.qorpera_runner_jobs where run_id = (current_setting('qorpera_test.revived_binding')::jsonb ->> 'runId')::uuid),
	'The member is recorded as having stopped it');
select pg_temp.wake_assert(public.qorpera_worker_revival_stopped((current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid),
	'The kernel reads it as a person stopping the revival, so the parent''s running workers stop with it');

rollback;
