-- Expiry reconciliation must run through the same public RPC as the cloud
-- scheduler. Only fixture setup and exact-boundary assertions inject a clock;
-- no production authority, queue, materializer or File function is replaced.
begin;
select step8_test.restore();

create function step8_test.schedule_expiry_snapshot(p_routine uuid)
returns jsonb language sql as $$
	select jsonb_build_object(
		'state',(select to_jsonb(s) from public.qorpera_step8_routine_state s where s.routine_id=p_routine),
		'cursor',(select to_jsonb(c) from public.qorpera_cloud_routine_schedule_cursors c where c.routine_id=p_routine),
		'wakes',(select coalesce(jsonb_agg(to_jsonb(w) order by w.id),'[]') from public.qorpera_wake_occurrences w where w.routine_id=p_routine),
		'epochs',(select coalesce(jsonb_agg(to_jsonb(e) order by e.occurrence_id),'[]') from public.qorpera_step8_occurrence_epochs e where e.routine_id=p_routine));
$$;

create function step8_test.assert_schedule_expired(p_plan jsonb,p_before jsonb)
returns void language plpgsql as $$
declare routine uuid := (p_plan ->> 'routineId')::uuid; current_state jsonb := step8_test.schedule_expiry_snapshot(routine);
	wake jsonb; previous_wakes jsonb; current_wakes jsonb;
begin
	perform step8_test.wake_assert(current_state #>> '{state,suspension}'='expired','Schedule commit persists expiry suspension');
	perform step8_test.wake_assert((current_state #>> '{state,observed_through}')::timestamptz=(p_plan ->> 'through')::timestamptz,'Expiry commits its exact watermark');
	perform step8_test.wake_assert(current_state #>> '{state,last_plan_sha256}'=encode(extensions.digest(convert_to(p_plan::text,'utf8'),'sha256'),'hex'),'Expiry commits the plan replay receipt');
	perform step8_test.wake_assert((current_state -> 'state')-array['suspension','observed_through','last_plan_sha256']=(p_before -> 'state')-array['suspension','observed_through','last_plan_sha256'],'Expiry preserves version, epoch, activation and failure state');
	perform step8_test.wake_assert((current_state #>> '{cursor,next_due_at}')::timestamptz=(p_plan ->> 'nextDueAt')::timestamptz,'Expiry commits the schedule cursor');
	perform step8_test.wake_assert((current_state -> 'cursor')-array['next_due_at','updated_at']=(p_before -> 'cursor')-array['next_due_at','updated_at'],'Empty expiry plan cannot invent a scheduled occurrence');
	perform step8_test.wake_assert(current_state -> 'epochs'=p_before -> 'epochs','Expiry preserves occurrence epoch attachments');
	select coalesce(jsonb_agg(value-array['status','finished_at','blocked_reason'] order by value ->> 'id'),'[]') into previous_wakes from jsonb_array_elements(p_before -> 'wakes');
	select coalesce(jsonb_agg(value-array['status','finished_at','blocked_reason'] order by value ->> 'id'),'[]') into current_wakes from jsonb_array_elements(current_state -> 'wakes');
	perform step8_test.wake_assert(current_wakes=previous_wakes,'Expiry preserves all existing occurrence identities and admission data');
	for wake in select value from jsonb_array_elements(current_state -> 'wakes') loop
		perform step8_test.wake_assert(wake ->> 'status'='cancelled' and wake ->> 'finished_at' is not null and wake ->> 'blocked_reason'='Routine expired','Expiry cancels every unlocked queued occurrence');
		perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at((wake ->> 'id')::uuid,(p_plan ->> 'through')::timestamptz),'Expired occurrences cannot execute');
	end loop;
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_step8_notification_intents n where n.routine_id=routine),'Expiry does not emit an authentication notification');
end $$;

-- The bug raised 42702 even with zero queued rows. Both cases below use the
-- public database-clock RPC, with a real pre-expiry admission in the second.
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid;
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '20 minutes';
	plan jsonb; prior_plan jsonb; before_state jsonb; committed_state jsonb; cases jsonb := '[]'; queued_count integer;
begin
	p := p || jsonb_build_object('expiresAt',step8_test.instant(at+interval '10 minutes'));
	for queued_count in 0..1 loop
		routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
		if queued_count=1 then
			perform public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']),at+interval '5 minutes');
		end if;
		before_state := step8_test.schedule_expiry_snapshot(routine);
		perform step8_test.wake_assert(jsonb_array_length(before_state -> 'wakes')=queued_count and before_state #> '{state,suspension}'='null'::jsonb,'Fixture has not already reconciled expiry');
		plan := step8_test.plan(routine,date_trunc('milliseconds',clock_timestamp())-interval '1 second','{}');
		perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan)='{"status":"committed","occurrences":[]}'::jsonb,'Public empty plan commits after expiry');
		perform step8_test.assert_schedule_expired(plan,before_state);
		committed_state := step8_test.schedule_expiry_snapshot(routine);
		perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan)='{"status":"duplicate"}'::jsonb,'Public expiry receipt replays exactly');
		perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot(routine)=committed_state,'Duplicate expiry does not rewrite cancellation timestamps or cursors');
		prior_plan := plan;
		plan := step8_test.plan(routine,(prior_plan ->> 'through')::timestamptz+interval '500 milliseconds','{}');
		perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan) ->> 'status'='committed','Fresh reconciliation succeeds when expiry is already sticky');
		perform step8_test.assert_schedule_expired(plan,before_state);
		perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot(routine) -> 'wakes'=committed_state -> 'wakes','Fresh empty plan does not recancel terminal occurrences');
		committed_state := step8_test.schedule_expiry_snapshot(routine);
		perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',prior_plan),'40001');
		perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot(routine)=committed_state,'Superseded expiry plan cannot mutate durable state');
		cases := cases || jsonb_build_array(jsonb_build_object('plan',plan,'before',before_state,'committed',committed_state));
	end loop;
	insert into step8_test.saved(key,value) values('expiry-replay-cases',cases);
end $$;

savepoint exact_schedule_expiry;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid;
	at timestamptz := '2026-08-28T10:00:00.000Z'; expires_at timestamptz := at+interval '10 minutes';
	plan jsonb; before_state jsonb; expired_state jsonb; occurrence uuid;
begin
	p := p || jsonb_build_object('expiresAt',step8_test.instant(expires_at));
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	perform public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']),at+interval '5 minutes');
	select w.id into strict occurrence from public.qorpera_wake_occurrences w where w.routine_id=routine;
	perform step8_test.wake_assert(public.qorpera_step8_occurrence_allowed_at(occurrence,expires_at-interval '1 millisecond'),'Occurrence remains eligible one millisecond before expiry');
	before_state := step8_test.schedule_expiry_snapshot(routine);
	plan := step8_test.plan(routine,expires_at,'{}');
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule_at(plan,expires_at) ->> 'status'='committed','Schedule reconciliation expires at the exact exclusive boundary');
	perform step8_test.assert_schedule_expired(plan,before_state);
	expired_state := step8_test.schedule_expiry_snapshot(routine);
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,expires_at-interval '1 millisecond','{}'),expires_at-interval '1 millisecond') ->> 'status'='clock-regressed','Backward clock after expiry is a no-op');
	perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot(routine)=expired_state,'Backward clock cannot regress expiry state, cursor or queue');
	perform step8_test.publish(routine,p,'paused',at+interval '6 minutes');
	perform step8_test.publish(routine,p,'active',at+interval '7 minutes');
	perform step8_test.wake_assert((select s.suspension='expired' and s.epoch=3 and s.active_since=expires_at and s.observed_through=expires_at from public.qorpera_step8_routine_state s where s.routine_id=routine),'Pause/resume cannot unexpire a version or regress its activation floor');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(occurrence,expires_at-interval '1 millisecond'),'Resume and clock rollback cannot revive the cancelled epoch');
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',plan),'40001');
	perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot(routine) -> 'wakes'=expired_state -> 'wakes','Pause/resume does not rewrite terminal occurrence evidence');
end $$;
set constraints all immediate;
set constraints all deferred;
rollback to exact_schedule_expiry;

-- Persist an unexpired projection with one real queued occurrence, but make
-- its policy deadline precede the actual database clock. Fresh backends race
-- this public commit, and the persistent volume survives a database restart.
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid;
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '20 minutes'; plan jsonb;
begin
	p := p || jsonb_build_object('expiresAt',step8_test.instant(at+interval '10 minutes'));
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	perform public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']),at+interval '5 minutes');
	plan := step8_test.plan(routine,date_trunc('milliseconds',clock_timestamp())-interval '1 second','{}');
	insert into step8_test.saved(key,value) values('expiry-race-plan',plan),('expiry-race-before',step8_test.schedule_expiry_snapshot(routine));
end $$;

create function step8_test.commit_expired_schedule()
returns jsonb language sql as $$
	select public.qorpera_step8_commit_schedule((select value from step8_test.saved where key='expiry-race-plan'));
$$;

create function step8_test.assert_schedule_expiry_rollback()
returns void language plpgsql as $$
declare plan jsonb := (select value from step8_test.saved where key='expiry-race-plan');
begin
	perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot((plan ->> 'routineId')::uuid)=(select value from step8_test.saved where key='expiry-race-before'),'Interrupted expiry rolls back suspension, cancellation, cursor, epochs and receipt together');
end $$;

create function step8_test.assert_schedule_expiry_committed()
returns void language plpgsql as $$
declare plan jsonb := (select value from step8_test.saved where key='expiry-race-plan');
begin
	perform step8_test.assert_schedule_expired(plan,(select value from step8_test.saved where key='expiry-race-before'));
	insert into step8_test.saved(key,value) values('expiry-race-committed',step8_test.schedule_expiry_snapshot((plan ->> 'routineId')::uuid));
end $$;

create function step8_test.assert_schedule_expiry_restart()
returns void language plpgsql as $$
declare replay jsonb; cases jsonb := (select value from step8_test.saved where key='expiry-replay-cases');
begin
	cases := cases || jsonb_build_array(jsonb_build_object('plan',(select value from step8_test.saved where key='expiry-race-plan'),
		'before',(select value from step8_test.saved where key='expiry-race-before'),'committed',(select value from step8_test.saved where key='expiry-race-committed')));
	for replay in select value from jsonb_array_elements(cases) loop
		perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot((replay #>> '{plan,routineId}')::uuid)=replay -> 'committed','Restart retains the complete expired state and cancelled queue');
		perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(replay -> 'plan')='{"status":"duplicate"}'::jsonb,'Public expiry receipt survives database restart');
		perform step8_test.assert_schedule_expired(replay -> 'plan',replay -> 'before');
		perform step8_test.wake_assert(step8_test.schedule_expiry_snapshot((replay #>> '{plan,routineId}')::uuid)=replay -> 'committed','Replay after restart preserves cancellation timestamps and all durable state');
	end loop;
end $$;
commit;
