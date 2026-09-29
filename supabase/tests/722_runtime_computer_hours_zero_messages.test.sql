-- @fixture 150_runner_orchestrator.test.sql until "-- END RECOVERY FIXTURE"
-- Computer hours, build step 6a (20260928249200_runtime_computer_hours_zero_wait): a member's message
-- to an agent in a company at zero starts no run; it waits in the session's queue and starts by itself
-- once hours arrive.

select set_config('qorpera_test.zero_input', public.qorpera_append_session_input(
	'15000000-0000-4000-8000-000000000055',
	'71800000-0000-4000-8000-000000000001',
	'user_message',
	'{"schema":"qorpera.session-prompt/v1","text":"Please look at the plan.","images":[]}'
)::text, false);
reset role;

-- Live payments; the company has used more than its free hours; the zero rule is on.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('15000000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
do $$
begin
	if not public.qorpera_company_at_zero('15000000-0000-4000-8000-000000000010', clock_timestamp()) then
		raise exception 'The fixture company should be at zero';
	end if;
end
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
do $$
begin
	if public.qorpera_materialize_session_execution_runs(32) <> '[]'::jsonb then
		raise exception 'At zero, a member message must start no run';
	end if;
	if exists (
		select 1 from public.qorpera_session_inputs input
		where input.id = (current_setting('qorpera_test.zero_input')::jsonb ->> 'input_id')::uuid
			and (input.execution_run_id is not null or input.failed_at is not null or input.completed_at is not null)
	) then
		raise exception 'The message waits in the queue, neither started nor failed';
	end if;
end
$$;
reset role;

-- Hours arrive: the message starts by itself.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
select 'credit', '15000000-0000-4000-8000-000000000010', founder.user_id, 72000, clock_timestamp() + interval '12 months', false
from public.qorpera_company_founders('15000000-0000-4000-8000-000000000010') founder
limit 1;
set role service_role;
do $$
declare v_runs jsonb := public.qorpera_materialize_session_execution_runs(32);
begin
	if jsonb_array_length(v_runs) <> 1 then
		raise exception 'Once hours arrive the waiting message starts: %', v_runs;
	end if;
	if not exists (
		select 1 from public.qorpera_session_inputs input
		where input.id = (current_setting('qorpera_test.zero_input')::jsonb ->> 'input_id')::uuid
			and input.execution_run_id is not null
	) then
		raise exception 'The waiting message is the one that started';
	end if;
end
$$;
reset role;
rollback;
