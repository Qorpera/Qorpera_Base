-- Main-owned integration contract, not an installed listener/authority adapter.
-- The actual Step 3 File drain stays unchanged. The explicit epoch INSERTs below
-- represent its required same-transaction integration; without them the Step 8
-- guard must remain closed. No source identity or authority helper is replaced.
begin;
select step8_test.restore();

-- This fixture's human run predates installing Step 3. Replay its real queued
-- event through the existing capture trigger, as the frozen Step 3 test does.
insert into public.qorpera_execution_run_events(run_id,event_type)
values((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid,'queued');

do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine jsonb; routine_id_value uuid; change jsonb;
	s public.qorpera_step8_routine_state%rowtype; first_wake public.qorpera_wake_occurrences%rowtype;
	second_wake public.qorpera_wake_occurrences%rowtype; identity_before text; event_id bigint; result jsonb;
begin
	p := jsonb_set(jsonb_set(p,'{authFailures,threshold}','1'),'{authFailures,notificationSessionId}','"30000000-0000-4000-8000-000000000042"');
	p := p || jsonb_build_object('expiresAt',step8_test.instant(clock_timestamp()+interval '1 hour'));
	routine := step8_test.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"file-policy","kind":"listener","source":"company-file","path":"step8-file-event.md","match":"exact","timeZone":"UTC"}');
	routine_id_value := (routine ->> 'routine_id')::uuid;
	perform step8_test.publish(routine_id_value,p,'active',clock_timestamp()-interval '1 second');
	s := public.qorpera_step8_locked_state(routine_id_value,1,1);
	change := step8_test.path_commit(step8_test.path_plan('step8-file-first','step8-file-event.md',step8_test.path_stage_file('step8-file-event.md','First admitted File event.')));
	perform step8_test.wake_assert(change ->> 'state'='applied','File event must be an actual admitted revision');
	perform public.qorpera_drain_company_file_wakes(64); -- unmatched routine document
	perform step8_test.wake_assert(public.qorpera_drain_company_file_wakes(64) ->> 'admitted'='1','Actual Step 3 File drain admits once');
	select * into strict first_wake from public.qorpera_wake_occurrences where routine_id=routine_id_value;
	identity_before := first_wake.occurrence_key;
	perform step8_test.wake_assert(first_wake.file_event_id=(change ->> 'snapshotId')::uuid and first_wake.source_kind='company-file','File wake keeps its actual source revision');
	perform step8_test.wake_assert(public.qorpera_wake_authorized(first_wake),'Actual Step 3 authority remains required');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(first_wake.id,clock_timestamp()),'Missing main-owned epoch attachment fails closed');

	-- Required main-owned write, in the same transaction as the real Step 3
	-- claim/cursor/occurrence. This row is enforcement metadata, not authority.
	insert into public.qorpera_step8_occurrence_epochs(occurrence_id,routine_id,routine_version,epoch)
	values(first_wake.id,routine_id_value,s.routine_version,s.epoch);
	update public.qorpera_step8_routine_state set observed_through=greatest(observed_through,date_trunc('milliseconds',clock_timestamp())) where routine_id=routine_id_value;
	perform step8_test.wake_assert(public.qorpera_step8_occurrence_allowed_at(first_wake.id,clock_timestamp()),'Current attachment plus real authority permits the File wake');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(first_wake.id,(p ->> 'expiresAt')::timestamptz),'File occurrence is denied at exact expiry');
	perform step8_test.wake_assert(public.qorpera_drain_company_file_wakes(64) ->> 'admitted'='0','Duplicate drain creates no new File wake');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_occurrence_epochs where occurrence_id=first_wake.id),'Duplicate delivery retains one attachment');
	perform step8_test.wake_assert((select occurrence_key=identity_before from public.qorpera_wake_occurrences where public.qorpera_wake_occurrences.id=first_wake.id),'Epoch is never added to File occurrence identity');
	perform step8_test.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(1))=1,'Existing Step 3 materializer is reused');
	select * into strict first_wake from public.qorpera_wake_occurrences where public.qorpera_wake_occurrences.id=first_wake.id;
	perform step8_test.wake_assert(first_wake.run_id is not null,'File terminal fixture uses a real materialized run');

	perform step8_test.publish(routine_id_value,p,'paused');
	perform step8_test.publish(routine_id_value,p,'active');
	perform step8_test.wake_error(format('select public.qorpera_step8_locked_state(%L,1,1)',routine_id_value),'40001');
	s := public.qorpera_step8_locked_state(routine_id_value,1,3);
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(first_wake.id,clock_timestamp()),'Already materialized File wake loses policy eligibility after pause/resume');
	perform step8_test.wake_assert((select epoch=1 from public.qorpera_step8_occurrence_epochs where occurrence_id=first_wake.id),'Resume never relabels an existing attachment');
	event_id := step8_test.outcome(first_wake.id,'authentication');
	perform step8_test.wake_assert(public.qorpera_step8_record_auth_outcome(event_id) ->> 'status'='stale','Old File epoch cannot count against resumed routine');
	perform step8_test.wake_assert((select failure_count=0 from public.qorpera_step8_routine_state where routine_id=routine_id_value),'Stale File terminal evidence leaves current failure count unchanged');

	change := step8_test.path_commit(step8_test.path_plan('step8-file-second','step8-file-event.md',step8_test.path_stage_file('step8-file-event.md','File event after resume.'),(change ->> 'version')::uuid));
	perform step8_test.wake_assert(change ->> 'state'='applied','Resumed File event must be admitted');
	perform public.qorpera_drain_company_file_wakes(64); -- unmatched resume document
	perform step8_test.wake_assert(public.qorpera_drain_company_file_wakes(64) ->> 'admitted'='1','Resumed File listener admits a new event');
	select * into strict second_wake from public.qorpera_wake_occurrences where routine_id=routine_id_value and public.qorpera_wake_occurrences.id<>first_wake.id;
	perform step8_test.wake_assert(second_wake.file_event_id=(change ->> 'snapshotId')::uuid,'Resumed occurrence keeps the new actual revision');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(second_wake.id,clock_timestamp()),'A new File occurrence also requires its own attachment');
	insert into public.qorpera_step8_occurrence_epochs(occurrence_id,routine_id,routine_version,epoch)
	values(second_wake.id,routine_id_value,s.routine_version,s.epoch);
	update public.qorpera_step8_routine_state set observed_through=greatest(observed_through,date_trunc('milliseconds',clock_timestamp())) where routine_id=routine_id_value;
	perform step8_test.wake_assert(public.qorpera_step8_occurrence_allowed_at(second_wake.id,clock_timestamp()),'New epoch admits only its new File occurrence');
	perform step8_test.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(1))=1,'New File wake uses the same materializer');
	event_id := step8_test.outcome(second_wake.id,'authentication');
	result := public.qorpera_step8_record_auth_outcome(event_id);
	perform step8_test.wake_assert(result ->> 'failureCount'='1' and result ->> 'notificationId' is not null,'Current File terminal failure creates its durable notification intent');
	perform step8_test.wake_assert(public.qorpera_step8_record_auth_outcome(event_id) ->> 'status'='duplicate','Duplicate File terminal evidence does not repeat suspension');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_notification_intents where routine_id=routine_id_value and epoch=3),'File suspension has one intent for the current epoch');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(second_wake.id,clock_timestamp()),'Authentication suspension closes File policy eligibility');
end $$;
set constraints all immediate;
rollback;
