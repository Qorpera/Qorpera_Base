-- Consumed after the real 300 fixture. The current native assignment has
-- not sent anything. A canonical progress receipt must survive a real
-- usage-limit sponsor handoff; transcript claims never satisfy this fact.
select pg_temp.wake_assert(
	public.qorpera_describe_company_run_context(current_setting('qorpera_test.wake_binding')::jsonb)
		-> 'initialAcknowledgementSatisfied' = 'false'::jsonb,
	'A fresh run has no authenticated acknowledgement');
select pg_temp.wake_error(format('select public.qorpera_assert_wake_work_allowed(%L)',
	current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId'),
	'55000','Wake requires an acknowledgement before work');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','ack-before-handoff');
select pg_temp.wake_assert(
	public.qorpera_describe_company_run_context(current_setting('qorpera_test.wake_binding')::jsonb)
		-> 'initialAcknowledgementSatisfied' = 'true'::jsonb,
	'A canonical current-run progress send satisfies the initial acknowledgement');

-- Register a second credential of the same member and compute identity via
-- the real login producer. No provider request or real credential is involved.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.ack_login',public.qorpera_begin_native_provider_login(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000151','30000000-0000-4000-8000-000000000152',
	(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.ack_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'30000000-0000-4000-8000-000000000160',
	'object://native-capsules/30000000-0000-4000-8000-000000000160',repeat('d',64),'fixture-second-openai-account','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
select public.qorpera_record_provider_usage_signal(current_setting('qorpera_test.wake_binding')::jsonb,'usage_limit',clock_timestamp() + interval '2 hours');
select pg_temp.wake_assert(public.qorpera_handoff_run_sponsor(
	(current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid,'Fixture usage limit') is not null,
	'Usage-limit handoff finds the same member second connection');
reset role;

do $$
declare v_previous jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
	v_binding jsonb; v_context jsonb; v_continuation jsonb;
begin
	v_binding := pg_temp.wake_start((v_previous ->> 'runId')::uuid);
	perform pg_temp.wake_assert(v_binding ->> 'assignmentId' <> v_previous ->> 'assignmentId',
		'Sponsor continuation uses a fresh assignment');
	v_context := public.qorpera_describe_company_run_context(v_binding);
	v_continuation := (public.qorpera_read_company_run_context(v_binding,'continuation',
		(v_binding ->> 'runId')::uuid,v_context #>> '{continuation,content,sha256}',0,4096) #>> '{content,text}')::jsonb;
	perform pg_temp.wake_assert(v_context -> 'initialAcknowledgementSatisfied' = 'true'::jsonb,
		'A sponsor continuation preserves the original current-run acknowledgement');
	perform pg_temp.wake_assert(v_continuation ->> 'schema' = 'qorpera.run-continuation/v1'
		and jsonb_array_length(v_continuation -> 'priorSends') = 1,
		'The complete continuation retains exactly the original progress send');
	perform public.qorpera_assert_wake_work_allowed((v_binding ->> 'runId')::uuid);
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_agent_sends
		where run_id = (v_binding ->> 'runId')::uuid), 'Work resumes without a duplicate greeting');
	perform set_config('qorpera_test.ack_continued_binding',v_binding::text,true);
end $$;
select jsonb_build_object('binding',current_setting('qorpera_test.ack_continued_binding')::jsonb,
	'context',public.qorpera_describe_company_run_context(current_setting('qorpera_test.ack_continued_binding')::jsonb),
	'wake',public.qorpera_read_native_wake(current_setting('qorpera_test.ack_continued_binding')::jsonb));
