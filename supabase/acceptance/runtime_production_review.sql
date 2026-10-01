-- Run after runtime_wake_bus.sql's fixture/helpers, before its report/rollback.
-- These are disposable database regressions, not provider or live evidence.
create function pg_temp.review_consent(p_allow boolean)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 execute 'set local role authenticated';
 v_result := public.qorpera_consent_provider_connection_autonomous('30000000-0000-4000-8000-000000000010',
  (current_setting('qorpera_test.wake_connection')::jsonb->>'connection_id')::uuid,p_allow);
 execute 'reset role';
 perform pg_temp.path_claims('service_role');
 return v_result;
end $$;

select pg_temp.wake_acceptance_case('withdrawal_cancels_previously_queued_autonomous_wake',$test$
do $$ declare v_routine jsonb; v_wake uuid; begin
 v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
  '{"id":"review-tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}');
 v_wake := pg_temp.wake_schedule(v_routine,'before-withdrawal');
 perform pg_temp.review_consent(false);
 perform public.qorpera_materialize_wake_execution_runs(1);
 perform pg_temp.wake_assert((select status='cancelled' and run_id is null
  from public.qorpera_wake_occurrences where id=v_wake),'Withdrawn wake cannot admit a run');
end $$;
$test$);

select pg_temp.wake_acceptance_case('withdrawal_fences_active_autonomous_run_and_reconsent_does_not_revive_it',$test$
do $$ declare v_routine jsonb; v_wake uuid; v_run uuid; v_binding jsonb; v_consent jsonb; begin
 v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
  '{"id":"review-tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}');
 v_wake := pg_temp.wake_schedule(v_routine,'admitted-before-withdrawal');
 perform public.qorpera_materialize_wake_execution_runs(1);
 select run_id into strict v_run from public.qorpera_wake_occurrences where id=v_wake;
 v_binding := pg_temp.wake_start(v_run);
 perform set_config('qorpera_test.wake_binding',v_binding::text,true);
 perform pg_temp.handoff_begin(v_binding,repeat('c',64));
 perform pg_temp.review_consent(false);
 perform pg_temp.wake_assert(not public.qorpera_reserve_execution_sponsor_authority(v_run),'Existing reservation cannot restore consent');
 perform pg_temp.wake_error(format('select public.qorpera_describe_native_tool_authority(%L)',v_binding),'42501');
 perform pg_temp.wake_error(format('select pg_temp.path_commit(%L)',pg_temp.path_plan('after-withdrawal','blocked.md',
  pg_temp.path_stage_file('blocked.md','Must not publish'))),'42501');
 v_consent := pg_temp.review_consent(true);
 perform pg_temp.wake_error(format('select public.qorpera_describe_native_tool_authority(%L)',v_binding),'42501');
 perform pg_temp.wake_assert(not public.qorpera_provider_autonomous_authority(
  (v_consent->>'connection_id')::uuid,2),'Old sponsor pin stays revoked after renewed consent');
 perform pg_temp.wake_assert(public.qorpera_provider_autonomous_authority(
  (v_consent->>'connection_id')::uuid,(v_consent->>'version')::bigint),'New consent version is available for fresh sponsorship');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 execute 'set local role authenticated';
 perform pg_temp.wake_error(format('select public.qorpera_create_member_execution_sponsor(%L,%L,%L,2,true)',
  '30000000-0000-4000-8000-000000000010',extensions.gen_random_uuid(),v_consent->>'connection_id'),'42501');
 perform public.qorpera_create_member_execution_sponsor('30000000-0000-4000-8000-000000000010',extensions.gen_random_uuid(),
  (v_consent->>'connection_id')::uuid,(v_consent->>'version')::bigint,true);
 execute 'reset role';
end $$;
$test$);

select pg_temp.wake_acceptance_case('autonomous_withdrawal_preserves_explicit_human_run',$test$
do $$ declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; begin
 perform pg_temp.review_consent(false);
 perform pg_temp.handoff_begin(v_binding,repeat('c',64));
 perform pg_temp.wake_public_send(v_binding,'progress');
 perform pg_temp.path_commit(pg_temp.path_plan('human-after-withdrawal','human.md',pg_temp.path_stage_file('human.md','Explicit request')));
end $$;
$test$);

create function pg_temp.review_terminal_lease(p_status text)
returns void language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_before jsonb;
begin
 if p_status = 'expired' then
  -- Controlled clock fixture; authority itself is not replaced.
  update public.qorpera_native_provider_connection_leases set expires_at=clock_timestamp()-interval '1 second'
  where id=(v_binding->>'leaseId')::uuid;
 else
  perform public.qorpera_release_native_provider_connection_lease((v_binding->>'leaseId')::uuid,
   (v_binding->>'runnerId')::uuid,repeat('2',64),(v_binding->>'jobId')::uuid,repeat('3',64),p_status);
 end if;
 select to_jsonb(lease) into strict v_before from public.qorpera_native_provider_connection_leases lease
 where id=(v_binding->>'leaseId')::uuid;
 perform pg_temp.wake_error(format('select public.qorpera_acquire_native_provider_connection_lease(%L,%L,%L,%L,%L,120)',
  v_binding->>'runId',v_binding->>'runnerId',repeat('2',64),v_binding->>'assignmentId',repeat('3',64)),'55000');
 perform pg_temp.wake_assert((select to_jsonb(lease)=v_before from public.qorpera_native_provider_connection_leases lease
  where id=(v_binding->>'leaseId')::uuid),'Denied replay preserves the exact lease');
end $$;
select pg_temp.wake_acceptance_case('released_lease_stays_released',$test$select pg_temp.review_terminal_lease('released');$test$);
select pg_temp.wake_acceptance_case('revoked_lease_stays_revoked',$test$select pg_temp.review_terminal_lease('revoked');$test$);
select pg_temp.wake_acceptance_case('expired_lease_cannot_be_extended_by_acquire',$test$select pg_temp.review_terminal_lease('expired');$test$);

select pg_temp.wake_acceptance_case('released_lease_cannot_overbook_native_capacity',$test$
do $$ declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
 v_connection jsonb := current_setting('qorpera_test.wake_connection')::jsonb || '{"version":2}'::jsonb;
begin
 perform public.qorpera_release_native_provider_connection_lease((v_binding->>'leaseId')::uuid,
  (v_binding->>'runnerId')::uuid,repeat('2',64),(v_binding->>'jobId')::uuid,repeat('3',64),'released');
 perform public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
  'supported','enabled',1,null,'review-one-slot-policy');
 perform pg_temp.handoff_competing_assignment(v_connection,true);
 perform pg_temp.wake_error(format('select public.qorpera_acquire_native_provider_connection_lease(%L,%L,%L,%L,%L,120)',
  v_binding->>'runId',v_binding->>'runnerId',repeat('2',64),v_binding->>'assignmentId',repeat('3',64)),'55000');
 perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_native_provider_connection_leases
  where provider_connection_id=(v_connection->>'connection_id')::uuid and status='active'
   and expires_at>clock_timestamp()),'Only the competing run occupies the one-slot connection');
end $$;
$test$);

create function pg_temp.review_completed_handoff()
returns jsonb language plpgsql as $$
declare v_first jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_second jsonb;
 v_plan jsonb; v_result jsonb; v_context jsonb; v_continuation jsonb; v_receipt jsonb; v_page jsonb; v_coworker jsonb;
begin
 perform pg_temp.handoff_connection();
 perform pg_temp.handoff_begin(v_first,repeat('c',64));
 perform pg_temp.wake_public_send(v_first,'progress');
 v_plan := pg_temp.path_plan('completed-before-quota','before-quota.md',pg_temp.path_stage_file('before-quota.md','Completed once'));
 v_result := pg_temp.path_commit(v_plan);
 v_coworker := public.qorpera_send_coworker_message(v_first,'30000000-0000-4000-8000-000000000031',
  'before-quota-coworker','The first part is completed.');
 select to_jsonb(receipt) into strict v_receipt from public.qorpera_run_operation_receipts receipt
 where id=(v_result->>'receiptId')::uuid;
 perform public.qorpera_record_provider_usage_signal(v_first,'usage_limit',clock_timestamp()+interval '2 hours');
 -- The failure report no longer hands off (20260929910000): call the handoff function directly.
 perform public.qorpera_handoff_run_sponsor((v_first->>'runId')::uuid,'Native harness failed (provider allowance unavailable)');
 perform pg_temp.wake_assert((select status='queued' from public.qorpera_runner_jobs
  where id=(v_first->>'jobId')::uuid),'Confirmed work allows continuation');
 v_second := pg_temp.wake_start((v_first->>'runId')::uuid);
 perform set_config('qorpera_test.wake_binding',v_second::text,true);
 v_context := public.qorpera_describe_company_run_context(v_second);
 v_continuation := (v_context #>> '{continuation,content,text}')::jsonb;
 perform pg_temp.wake_assert(v_continuation->>'runId'=v_first->>'runId'
  and jsonb_array_length(v_continuation->'receipts')=2 and jsonb_array_length(v_continuation->'priorSends')=1,
  'Fresh context contains the original receipt and acknowledgement');
 perform pg_temp.wake_assert(v_continuation#>>'{receipts,0,assignmentId}'=v_first->>'assignmentId',
  'Original effect provenance is retained');
 v_page := public.qorpera_read_company_run_context(v_second,'continuation',(v_second->>'runId')::uuid,
  v_context#>>'{continuation,content,sha256}',0,1024);
 perform pg_temp.wake_assert(v_page->>'kind'='completed_work','Continuation is a bounded admitted context source');
 perform pg_temp.handoff_begin(v_second,repeat('d',64));
 perform pg_temp.wake_assert(pg_temp.path_commit(v_plan)=v_result,'Exact plan replays original result');
 perform pg_temp.wake_assert(public.qorpera_send_coworker_message(v_second,'30000000-0000-4000-8000-000000000031',
  'before-quota-coworker','The first part is completed.')=v_coworker,'Completed coworker delivery replays without another wake');
 perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_wake_occurrences
  where parent_run_id=(v_first->>'runId')::uuid and source_kind='coworker'),'Coworker delivery occurs once across sponsors');
 perform pg_temp.wake_assert((select to_jsonb(receipt)=v_receipt from public.qorpera_run_operation_receipts receipt
  where id=(v_result->>'receiptId')::uuid),'Original receipt is byte-for-byte unchanged');
 perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_company_path_revisions
  where receipt_id=(v_result->>'receiptId')::uuid),'Completed effect is published exactly once');
 perform pg_temp.wake_error(format('select pg_temp.path_commit(%L)',v_plan||'{"path":"changed.md"}'::jsonb),'22023');
 perform pg_temp.path_commit(pg_temp.path_plan('unfinished-after-quota','after-quota.md',
  pg_temp.path_stage_file('after-quota.md','Continued unfinished work')));
 perform pg_temp.wake_assert((public.qorpera_read_company_run_context(v_second,'continuation',(v_second->>'runId')::uuid,
  v_context#>>'{continuation,content,sha256}',0,1024))->'content'=v_page->'content',
  'New effects do not change the admitted continuation snapshot');
 perform pg_temp.wake_public_send(v_second,'final','continued-final');
 perform pg_temp.wake_acceptance_finish(v_second);
 return jsonb_build_object('context',v_context,'binding',v_second);
end $$;
select pg_temp.wake_acceptance_case('completed_write_continues_and_replays_once_on_new_sponsor',
 $test$select pg_temp.review_completed_handoff();$test$);

create function pg_temp.review_unresolved_handoff(p_ambiguous boolean)
returns void language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_id uuid := extensions.gen_random_uuid();
begin
 perform pg_temp.handoff_connection();
 perform pg_temp.handoff_begin(v_binding,repeat('c',64));
 perform pg_temp.wake_public_send(v_binding,'progress');
 perform public.qorpera_begin_native_tool_operation(v_binding,v_id,'uncertain-effect',repeat('a',64),repeat('b',64),false);
 if p_ambiguous then
  update public.qorpera_run_operation_receipts set status='ambiguous',completed_at=clock_timestamp() where id=v_id;
 end if;
 perform public.qorpera_record_provider_usage_signal(v_binding,'usage_limit',clock_timestamp()+interval '2 hours');
 -- The failure report no longer hands off (20260929910000): ask the handoff function itself, whose receipt
 -- fence this case proves, then report the failure.
 perform public.qorpera_handoff_run_sponsor((v_binding->>'runId')::uuid,'Native harness failed (provider allowance unavailable)');
 perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_execution_sponsor_handoffs
  where run_id=(v_binding->>'runId')::uuid),'Uncertain effect still blocks continuation');
 perform public.qorpera_fail_runner_job((v_binding->>'runnerId')::uuid,repeat('2',64),
  (v_binding->>'jobId')::uuid,repeat('3',64),'Native harness failed (provider allowance unavailable)',false);
 perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_execution_sponsor_handoffs
  where run_id=(v_binding->>'runId')::uuid),'The failure report never hands off');
end $$;
select pg_temp.wake_acceptance_case('executing_receipt_still_fences_handoff',$test$select pg_temp.review_unresolved_handoff(false);$test$);
select pg_temp.wake_acceptance_case('ambiguous_receipt_still_fences_handoff',$test$select pg_temp.review_unresolved_handoff(true);$test$);
