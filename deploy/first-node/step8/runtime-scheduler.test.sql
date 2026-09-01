-- Disposable component tests. Time-injected Step 8 functions are private,
-- owner-only test seams; production entrypoints always use the database clock.
-- All wake materialization, sponsor checks, File writes and public sends use
-- the actual frozen implementations. Terminal provider outcomes are fixtures.
begin;
select step8_test.restore();
select step8_test.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');

create function step8_test.publish(p_id uuid,p_policy jsonb,p_status text default 'active',p_at timestamptz default clock_timestamp())
returns jsonb language plpgsql as $$
declare r public.qorpera_cloud_routines%rowtype; doc text; file_path text := 'routine-' || p_id::text || '.json'; prior uuid; result jsonb; projection jsonb;
begin
	select * into strict r from public.qorpera_cloud_routines where id = p_id;
	perform public.qorpera_step8_lock_intent(r.environment_id);
	-- The main-owned File routine writer must perform this head transition in
	-- its admitted File transaction. The fixture tests that transaction contract.
	update public.qorpera_cloud_routines set status = p_status where id = r.id;
	doc := jsonb_build_object('schema','qorpera.routine-intent/v1','routineId',r.id,'version',r.current_version,
		'definition',step8_test.definition(r.id),'status',p_status,'policy',p_policy)::text;
	select version into prior from public.qorpera_company_path_entries where environment_id = r.environment_id and entry ->> 'path' = file_path;
	result := step8_test.path_commit(step8_test.path_plan('routine-' || extensions.gen_random_uuid()::text,file_path,step8_test.path_stage_file(file_path,doc),prior));
	perform step8_test.wake_assert(result ->> 'state' = 'applied','Routine document must be live, not proposed');
	projection := public.qorpera_step8_project_routine_at(r.id,r.current_version,file_path,result,doc,p_at);
	return projection || jsonb_build_object('document',doc,'path',file_path,'result',result);
end $$;

create function step8_test.new_schedule(p_policy jsonb,p_anchor timestamptz,p_at timestamptz)
returns uuid language plpgsql as $$
declare r jsonb; id uuid;
begin
	r := step8_test.wake_routine('30000000-0000-4000-8000-000000000030',jsonb_build_object(
		'id','tick','kind','schedule','intervalMinutes',5,'startAt',step8_test.instant(p_anchor)));
	id := (r ->> 'routine_id')::uuid;
	perform step8_test.publish(id,p_policy,'active',p_at);
	return id;
end $$;

create function step8_test.plan(p_id uuid,p_through timestamptz,p_slots timestamptz[])
returns jsonb language plpgsql as $$
declare s public.qorpera_step8_routine_state%rowtype; c public.qorpera_cloud_routine_schedule_cursors%rowtype; items jsonb;
begin
	select * into strict s from public.qorpera_step8_routine_state where routine_id = p_id;
	select * into strict c from public.qorpera_cloud_routine_schedule_cursors where routine_id = p_id and routine_version = s.routine_version;
	select coalesce(jsonb_agg(public.qorpera_step8_identity(p_id,s.routine_version,c.trigger_id,at) || jsonb_build_object('scheduledFor',step8_test.instant(at)) order by at),'[]') into items from unnest(p_slots) at;
	return jsonb_build_object('schema','qorpera.routine-schedule-plan/v1','routineId',p_id,'version',s.routine_version,'epoch',s.epoch,
		'expectedObservedThrough',step8_test.instant(s.observed_through),'expectedLastScheduledFor',step8_test.instant(c.last_scheduled_for),
		'through',step8_test.instant(greatest(p_through,s.observed_through)),'nextDueAt',step8_test.instant(greatest(p_through,s.observed_through)+interval '5 minutes'),
		'truncatedBefore',null,'occurrences',items);
end $$;

create function step8_test.outcome(p_occurrence uuid,p_outcome text)
returns bigint language plpgsql as $$
declare run uuid; event_id bigint; binding jsonb; terminal text := case when p_outcome = 'success' then 'completed' else 'failed' end;
begin
	select run_id into strict run from public.qorpera_wake_occurrences where id = p_occurrence;
	perform step8_test.wake_assert(run is not null,'Terminal fixture needs a real materialized wake run');
	if terminal = 'completed' then
		-- The frozen main mouth still requires a final for session-bound runs.
		-- Meet it using its actual authorized sender; do not disable that gate.
		select value into strict binding from step8_test.saved where key='outcome-binding:' || run::text;
		-- Seed the session's existing snapshot pin to this admitted run. The
		-- original human fixture predates the routine File publication; this
		-- success fixture does not claim the shared session-pin wiring is done.
		update public.qorpera_shared_sessions s set company_snapshot_id=r.company_snapshot_id
		from public.qorpera_execution_runs r where r.id=run and s.id=r.session_id;
		perform step8_test.wake_public_send(binding,'final');
	end if;
	update public.qorpera_runner_jobs set status = terminal,finished_at = clock_timestamp(),
		terminal_lease_token_sha256 = lease_token_sha256,lease_token_sha256 = null,lease_expires_at = null,
		result = case when terminal = 'completed' then '{"schema":"step8.synthetic-outcome/v1"}'::jsonb end,
		last_error = case when terminal = 'failed' then 'Synthetic provider outcome' end where run_id = run;
	-- Faithful normalized terminal evidence. Step 7/main must classify actual
	-- failures in the existing event producer; no regex on error prose here.
	insert into public.qorpera_execution_run_events(run_id,event_type,payload)
	values(run,terminal,jsonb_build_object('failureClass',case when p_outcome = 'authentication' then 'authentication' else 'other' end)) returning id into event_id;
	return event_id;
end $$;

do $$
declare p jsonb := (select value from step8_test.saved where key = 'policy'); t jsonb;
begin
	perform step8_test.wake_assert(public.qorpera_step8_policy_valid(p),'Shared JSON policy fixture');
	perform step8_test.wake_assert(not public.qorpera_step8_policy_valid(p - 'dst'),'No implicit DST policy');
	perform step8_test.wake_assert(not public.qorpera_step8_policy_valid(p || '{"timeZone":"auto"}'),'No device timezone');
	perform step8_test.wake_assert(not public.qorpera_step8_policy_valid(p || '{"expiresAt":"2026-02-30T00:00:00.000Z"}'),'No normalized invalid date');
	t := '{"id":"tick","kind":"schedule","intervalMinutes":5}';
	perform step8_test.wake_assert(public.qorpera_step8_trigger_valid(jsonb_build_array(t),p),'Existing interval contract');
	perform step8_test.wake_assert(not public.qorpera_step8_trigger_valid(jsonb_build_array(t,t || '{"id":"second"}'),p),'Exactly one schedule');
	perform step8_test.wake_assert(not public.qorpera_step8_trigger_valid(jsonb_build_array(t,(select value from step8_test.saved where key='external-trigger')),p),'Schedule OR listener');
	perform step8_test.wake_assert(public.qorpera_step8_trigger_valid('[{"id":"file","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"silent"}]',p),'Step 3 File listener and silence policy');
	perform step8_test.wake_assert(public.qorpera_step8_trigger_valid(jsonb_build_array((select value from step8_test.saved where key='external-trigger')),p),'GitHub shape accepted only by Step 8 compiler');
end $$;

do $$
declare p jsonb := (select value from step8_test.saved where key = 'policy'); t jsonb;
begin
	perform step8_test.wake_assert(public.qorpera_step8_local_instants('2026-10-25 02:30','Europe/Copenhagen','both') = array['2026-10-25T00:30:00Z'::timestamptz,'2026-10-25T01:30:00Z'::timestamptz],'DST fold has two exact instants');
	perform step8_test.wake_assert(coalesce(cardinality(public.qorpera_step8_local_instants('2026-03-29 02:30','Europe/Copenhagen','both')),0) = 0,'DST spring gap is skipped');
	perform step8_test.wake_assert(public.qorpera_step8_local_instants('2026-04-05 01:45','Australia/Lord_Howe','both') = array['2026-04-04T14:45:00Z'::timestamptz,'2026-04-04T15:15:00Z'::timestamptz],'Half-hour fold');
	perform step8_test.wake_assert(coalesce(cardinality(public.qorpera_step8_local_instants('2011-12-30 12:00','Pacific/Apia','both')),0) = 0,'Skipped civil date');
	perform step8_test.wake_assert(public.qorpera_step8_local_instants('1971-01-02 00:00','Africa/Monrovia','earlier') = array['1971-01-02T00:44:30Z'::timestamptz],'Historical second-level offset agrees with TypeScript');
	p := p || '{"quietWindows":[{"weekdays":["friday"],"start":"22:00","end":"07:00"}]}';
	perform step8_test.wake_assert(public.qorpera_step8_clock_allowed(p,'2026-08-28T21:59:59.999Z'),'Quiet start minus one millisecond');
	perform step8_test.wake_assert(not public.qorpera_step8_clock_allowed(p,'2026-08-28T22:00:00Z'),'Quiet start inclusive');
	perform step8_test.wake_assert(not public.qorpera_step8_clock_allowed(p,'2026-08-29T06:59:59.999Z'),'Overnight owns start weekday');
	perform step8_test.wake_assert(public.qorpera_step8_clock_allowed(p,'2026-08-29T07:00:00Z'),'Quiet end exclusive');
	t := '{"id":"tick","kind":"schedule","intervalMinutes":5,"timeZone":"Europe/Copenhagen","weekdays":["sunday"],"localTime":"02:30"}';
	p := p || '{"timeZone":"Europe/Copenhagen","quietWindows":[],"dst":{"gap":"skip","fold":"earlier"}}';
	perform step8_test.wake_assert(public.qorpera_step8_scheduled(t,p,'2026-10-25T00:30:00Z'),'Selected fold first instant');
	perform step8_test.wake_assert(not public.qorpera_step8_scheduled(t,p,'2026-10-25T01:30:00Z'),'Other fold excluded');
end $$;

savepoint null_policy_bindings;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid;
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '20 minutes';
	plan jsonb; invalid jsonb; field text; invalid_value jsonb; recovery uuid := extensions.gen_random_uuid();
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']);
	-- Equal wall clocks across pause/resume leave only the epoch as the CAS
	-- fence. An omitted/null binding must not attach this old plan to epoch 3.
	perform step8_test.publish(routine,p,'paused',at);
	perform step8_test.publish(routine,p,'active',at);
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',plan),'40001');
	foreach field in array array['epoch','version'] loop
		for invalid_value in select jsonb_array_elements('[null,0,-1]'::jsonb) loop
			invalid := jsonb_set(plan,array[field],invalid_value);
			perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',invalid),'22023');
			perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',invalid,at+interval '5 minutes'),'22023');
			perform step8_test.wake_error(format('select public.qorpera_step8_expire(%L,%L,%L)',routine,invalid ->> 'version',invalid ->> 'epoch'),'22023');
			perform step8_test.wake_error(format('select public.qorpera_step8_resume_after_auth(%L,%L,%L,%L)',routine,invalid ->> 'version',invalid ->> 'epoch',recovery),'22023');
		end loop;
		perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',plan-field),'22023');
	end loop;
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=routine),'Invalid bindings cannot queue work');
	perform step8_test.wake_assert((select epoch=3 and observed_through=at and last_plan_sha256 is null from public.qorpera_step8_routine_state where routine_id=routine),'Invalid bindings cannot alter policy state');
	perform step8_test.wake_assert((select last_scheduled_for is null from public.qorpera_cloud_routine_schedule_cursors where routine_id=routine),'Invalid bindings cannot advance the schedule cursor');
	plan := jsonb_set(plan,'{epoch}','3');
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan) ->> 'status'='committed','A complete current binding still admits');
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan) ->> 'status'='duplicate','A complete binding still supports receipt replay');
	-- Negative replay fixture only: no recovery authority stub or successful
	-- recovery is tested. The stored binding must reject absent caller fields.
	insert into public.qorpera_step8_auth_recoveries(receipt_id,routine_id,routine_version,from_epoch,to_epoch) values(recovery,routine,1,2,3);
	perform step8_test.wake_error(format('select public.qorpera_step8_resume_after_auth(%L,1,null,%L)',routine,recovery),'23505');
	perform step8_test.wake_error(format('select public.qorpera_step8_resume_after_auth(%L,null,2,%L)',routine,recovery),'23505');
end $$;
rollback to null_policy_bindings;

savepoint schedule_timestamp_precision;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid;
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '20 minutes';
	plan jsonb; invalid jsonb; state_before jsonb; cursor_before jsonb; context jsonb; field text; value jsonb;
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '5 minutes','{}');
	select to_jsonb(s) into state_before from public.qorpera_step8_routine_state s where routine_id=routine;
	select to_jsonb(c) into cursor_before from public.qorpera_cloud_routine_schedule_cursors c where routine_id=routine;
	-- The service RPC used to persist a microsecond watermark, while its read
	-- context exposed only milliseconds. Every subsequent fresh CAS then failed.
	invalid := jsonb_set(plan,'{through}',to_jsonb(to_char((at+interval '5 minutes 0.0005 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',invalid),'22023');
	foreach field in array array['expectedObservedThrough','through','nextDueAt','expectedLastScheduledFor','truncatedBefore'] loop
		-- Equivalent instants in another spelling are invalid too. Never round
		-- identities, discard fractional precision or normalize a caller's CAS.
		for value in select jsonb_array_elements(jsonb_build_array(1,true,'{}'::jsonb,'[]'::jsonb,
			step8_test.instant(at+interval '5 minutes') || ' ',
			replace(step8_test.instant(at+interval '5 minutes'),'Z','+00:00'),
			replace(step8_test.instant(at+interval '5 minutes'),'Z','000Z'),
			'infinity','1969-12-31T23:59:59.999Z','2026-02-30T00:00:00.000Z')) loop
			invalid := jsonb_set(plan,array[field],value);
			perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',invalid),'22023');
		end loop;
		if field not in ('expectedLastScheduledFor','truncatedBefore') then
			perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',jsonb_set(plan,array[field],'null')),'22023');
		end if;
	end loop;
	plan := step8_test.plan(routine,at+interval '10 minutes',array[at+interval '5 minutes',at+interval '10 minutes']);
	invalid := jsonb_set(plan,'{occurrences,1,scheduledFor}',to_jsonb(replace(plan #>> '{occurrences,1,scheduledFor}','Z','000Z')));
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule(%L)',invalid),'22023');
	perform step8_test.wake_error(format('update public.qorpera_step8_routine_state set observed_through=observed_through+interval ''0.0005 seconds'' where routine_id=%L',routine),'23514');
	perform step8_test.wake_error(format('update public.qorpera_step8_routine_state set active_since=active_since-interval ''0.0005 seconds'' where routine_id=%L',routine),'23514');
	perform step8_test.wake_assert((select to_jsonb(s)=state_before from public.qorpera_step8_routine_state s where routine_id=routine),'Malformed timestamps preserve the complete policy state');
	perform step8_test.wake_assert((select to_jsonb(c)=cursor_before from public.qorpera_cloud_routine_schedule_cursors c where routine_id=routine),'Malformed timestamps preserve the complete cursor');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=routine),'Malformed batch cannot leave a partial occurrence');
	context := public.qorpera_step8_read_schedule_context(routine);
	plan := plan || jsonb_build_object('expectedObservedThrough',context -> 'observedThrough','expectedLastScheduledFor',context -> 'lastScheduledFor');
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan) ->> 'status'='committed','Fresh read and canonical plan still commit');
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan) ->> 'status'='duplicate','Canonical plan replay keeps its identity');
	context := public.qorpera_step8_read_schedule_context(routine);
	perform step8_test.wake_assert((context ->> 'observedThrough')::timestamptz=at+interval '10 minutes','Read context preserves stored precision');
	plan := step8_test.plan(routine,at+interval '15 minutes',array[at+interval '15 minutes']) ||
		jsonb_build_object('expectedObservedThrough',context -> 'observedThrough','expectedLastScheduledFor',context -> 'lastScheduledFor','truncatedBefore',step8_test.instant(at+interval '15 minutes'));
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule(plan) ->> 'status'='committed','Next fresh CAS is not poisoned');
	perform step8_test.wake_assert((select count(*)=3 from public.qorpera_wake_occurrences where routine_id=routine),'Canonical plans admit each exact occurrence once');
end $$;
rollback to schedule_timestamp_precision;

savepoint schedule_anchor_range;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; context jsonb;
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '10 minutes'; head_before uuid;
	routines_before bigint; revisions_before bigint; policies_before bigint;
begin
	select head_snapshot_id into head_before from public.qorpera_company_files where environment_id='30000000-0000-4000-8000-000000000020';
	select count(*) into routines_before from public.qorpera_cloud_routines;
	select count(*) into revisions_before from public.qorpera_company_path_revisions;
	select count(*) into policies_before from public.qorpera_step8_routine_policies;
	-- The inherited schedule validator accepts this anchor. The Step 8 File
	-- projection must reject it, atomically with the version and actual File write.
	perform step8_test.wake_error(format('select step8_test.new_schedule(%L,%L,%L)',p,'1969-12-31T23:59:59.999Z',at),'22023');
	perform step8_test.wake_assert((select head_snapshot_id=head_before from public.qorpera_company_files where environment_id='30000000-0000-4000-8000-000000000020'),'Invalid anchor cannot change the File head');
	perform step8_test.wake_assert((select count(*)=routines_before from public.qorpera_cloud_routines),'Invalid anchor cannot retain a routine');
	perform step8_test.wake_assert((select count(*)=revisions_before from public.qorpera_company_path_revisions),'Invalid anchor cannot retain a File revision');
	perform step8_test.wake_assert((select count(*)=policies_before from public.qorpera_step8_routine_policies),'Invalid anchor cannot retain a policy projection');
	routine := step8_test.new_schedule(p,'1970-01-01T00:00:00.000Z',at);
	context := public.qorpera_step8_read_schedule_context(routine);
	perform step8_test.wake_assert(context #>> '{trigger,startAt}'='1970-01-01T00:00:00.000Z','Exact Unix epoch anchor remains valid and readable');
	perform public.qorpera_step8_assert_projection(routine);
end $$;
set constraints all immediate;
set constraints all deferred;
rollback to schedule_anchor_range;

savepoint projection_transitions;
do $$
declare p jsonb := (select value from step8_test.saved where key = 'policy'); routine uuid; at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '20 minutes';
	plan jsonb; published jsonb; occurrence uuid;
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '15 minutes',array[at+interval '5 minutes',at+interval '10 minutes',at+interval '15 minutes']);
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule_at(plan,at+interval '15 minutes') ->> 'status' = 'committed','Schedule admission');
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule_at(plan,at+interval '15 minutes') ->> 'status' = 'duplicate','Lost-response plan replay');
	perform step8_test.wake_assert((select count(*) = 3 from public.qorpera_wake_occurrences where routine_id=routine),'Only existing occurrence queue');
	select w.id into occurrence from public.qorpera_wake_occurrences w where w.routine_id = routine order by scheduled_for limit 1;
	perform step8_test.wake_assert(public.qorpera_step8_occurrence_allowed_at(occurrence,at+interval '15 minutes'),'Policy plus Step 3 authority admit the wake');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(occurrence,at),'No early materialization');
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',plan || '{"epoch":99}',at+interval '15 minutes'),'40001');
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '10 minutes','{}'),at+interval '10 minutes') ->> 'status' = 'clock-regressed','Backward clock is a durable no-op');
	published := step8_test.publish(routine,p,'paused',at+interval '16 minutes');
	perform step8_test.wake_assert((select count(*) = 3 from public.qorpera_wake_occurrences where routine_id=routine and status='cancelled'),'Pause cancels queued versions');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(occurrence,clock_timestamp()),'Cancelled epoch cannot execute');
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',plan,clock_timestamp()),'40001');
	published := step8_test.publish(routine,p,'active',at+interval '18 minutes');
	perform step8_test.wake_assert(published ->> 'epoch' = '3','Resume is a new admission epoch');
	perform step8_test.wake_assert((select active_since = at+interval '18 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Resume is future-only');
	perform step8_test.wake_assert(public.qorpera_step8_project_routine(routine,1,published ->> 'path',published -> 'result',published ->> 'document') ->> 'epoch' = '3','Idempotent projection does not reset activation');
	perform step8_test.wake_error(format('select step8_test.publish(%L,%L)',routine,p || '{"defaultWeekdays":["monday"]}'),'40001');
	-- A same-transaction version edit has its own immutable content identity.
	select client_routine_id into occurrence from public.qorpera_cloud_routines where public.qorpera_cloud_routines.id=routine;
	perform step8_test.wake_routine('30000000-0000-4000-8000-000000000030','{"id":"tick","kind":"schedule","intervalMinutes":10}',occurrence);
	perform step8_test.publish(routine,p || '{"defaultWeekdays":["monday"]}','active',at+interval '19 minutes');
	perform step8_test.wake_assert((select routine_version=2 and epoch=4 from public.qorpera_step8_routine_state where routine_id=routine),'Edit binds new version and epoch');
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',plan,clock_timestamp()),'40001');
end $$;
set constraints all immediate;
set constraints all deferred;
rollback to projection_transitions;

savepoint projection_drift;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; at timestamptz := date_trunc('milliseconds',clock_timestamp());
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	begin
		update public.qorpera_cloud_routines set status='paused' where public.qorpera_cloud_routines.id=routine;
		set constraints all immediate;
		raise exception 'Unprojected status committed';
	exception when sqlstate '55000' then null; end;
	perform step8_test.wake_assert((select status='active' from public.qorpera_cloud_routines where public.qorpera_cloud_routines.id=routine),'Failed drift transaction rolls back head');
	begin
		update public.qorpera_company_path_entries set version=extensions.gen_random_uuid() where path='routine-' || routine::text || '.json';
		set constraints all immediate;
		raise exception 'Unprojected File version committed';
	exception when sqlstate '55000' then null; end;
	perform public.qorpera_step8_assert_projection(routine);
end $$;
rollback to projection_drift;

savepoint expiry_and_quiet;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; at timestamptz := '2026-08-28T10:00:00Z'; plan jsonb; occurrence uuid;
begin
	p := p || jsonb_build_object('expiresAt',step8_test.instant(at+interval '10 minutes'));
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']);
	perform public.qorpera_step8_commit_schedule_at(plan,at+interval '5 minutes');
	select w.id into occurrence from public.qorpera_wake_occurrences w where w.routine_id=routine;
	perform step8_test.wake_assert(public.qorpera_step8_occurrence_allowed_at(occurrence,at+interval '10 minutes'-interval '1 millisecond'),'Expiry minus one millisecond');
	perform step8_test.wake_assert(not public.qorpera_step8_occurrence_allowed_at(occurrence,at+interval '10 minutes'),'Expiry exclusive');
	perform step8_test.wake_assert(public.qorpera_step8_expire_at(routine,1,1,at+interval '10 minutes'),'Durable expiry transition');
	perform step8_test.wake_assert((select status='cancelled' from public.qorpera_wake_occurrences w where w.id=occurrence),'Expiry cancels queued work');
	perform step8_test.publish(routine,p,'paused',at+interval '6 minutes');
	perform step8_test.publish(routine,p,'active',at+interval '7 minutes');
	perform step8_test.wake_assert((select suspension='expired' and observed_through=at+interval '10 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Resume and backward clock cannot unexpire same version');
end $$;
rollback to expiry_and_quiet;

savepoint bounded_admission;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; at timestamptz := '2026-08-28T10:00:00Z'; plan jsonb;
begin
	p := p || '{"quietWindows":[{"weekdays":["friday"],"start":"10:05","end":"10:10"}]}';
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']);
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',plan,at+interval '5 minutes'),'55000');
	plan := step8_test.plan(routine,at+interval '10 minutes',array[at+interval '5 minutes',at+interval '10 minutes']);
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',plan,at+interval '10 minutes'),'22023');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=routine),'Invalid quiet batch rolls back atomically');
	plan := step8_test.plan(routine,at+interval '10 minutes',array[at+interval '10 minutes']);
	perform public.qorpera_step8_commit_schedule_at(plan,at+interval '10 minutes');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_wake_occurrences where routine_id=routine),'Quiet end admits exact slot');
	routine := step8_test.new_schedule((select value from step8_test.saved where key='policy'),at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '20 minutes',array[at+interval '5 minutes',at+interval '10 minutes',at+interval '15 minutes',at+interval '20 minutes']);
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',plan,at+interval '20 minutes'),'55000');
	plan := step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']);
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',jsonb_set(plan,'{occurrences,0,occurrenceId}',to_jsonb(extensions.gen_random_uuid())),at+interval '5 minutes'),'22023');
	p := (select value from step8_test.saved where key='policy') || '{"catchUp":{"maxAgeSeconds":60,"maxOccurrences":3}}';
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '10 minutes',array[at+interval '5 minutes']);
	perform step8_test.wake_error(format('select public.qorpera_step8_commit_schedule_at(%L,%L)',plan,at+interval '10 minutes'),'22023');
end $$;
rollback to bounded_admission;

-- Persistent auth fixture: actual existing materializer, canonical run/job and
-- terminal event contracts; synthetic provider failures, no provider requests.
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '21 minutes';
	plan jsonb; occurrences uuid[]; events bigint[]; result jsonb; intent uuid; binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; sent jsonb; text text;
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '15 minutes',array[at+interval '5 minutes',at+interval '10 minutes',at+interval '15 minutes']);
	perform public.qorpera_step8_commit_schedule_at(plan,at+interval '15 minutes');
	perform step8_test.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(3))=3,'Existing materializer is reused');
	plan := step8_test.plan(routine,at+interval '20 minutes',array[at+interval '20 minutes']);
	perform public.qorpera_step8_commit_schedule_at(plan,at+interval '20 minutes');
	select array_agg(w.id order by w.scheduled_for) into occurrences from public.qorpera_wake_occurrences w where w.routine_id=routine and w.status='materialized';
	events := array[step8_test.outcome(occurrences[1],'authentication'),step8_test.outcome(occurrences[2],'authentication'),step8_test.outcome(occurrences[3],'authentication')];
	perform public.qorpera_step8_record_auth_outcome(events[3]);
	perform public.qorpera_step8_record_auth_outcome(events[1]);
	result := public.qorpera_step8_record_auth_outcome(events[2]);
	intent := (result ->> 'notificationId')::uuid;
	perform step8_test.wake_assert(intent is not null and result ->> 'failureCount'='3','Third distinct failure creates notification');
	perform step8_test.wake_assert(public.qorpera_step8_record_auth_outcome(events[2]) ->> 'status'='duplicate','Duplicate terminal delivery does not count twice');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_notification_intents where routine_id=routine),'Exactly one durable intent per suspension');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_wake_occurrences where routine_id=routine and status='cancelled'),'Suspension cancels queued work');
	perform step8_test.wake_error(format('select public.qorpera_step8_resume_after_auth(%L,1,1,%L)',routine,extensions.gen_random_uuid()),'55000');
	perform step8_test.wake_error(format('select public.qorpera_step8_ack_notification(%L,%L)',intent,extensions.gen_random_uuid()),'42501');
	text := 'Routine ' || routine::text || ' was suspended after repeated authentication failures. Reauthorize its connection and resume the routine.';
	sent := public.qorpera_send_native_agent_message((binding ->> 'leaseId')::uuid,(binding ->> 'runId')::uuid,(binding ->> 'jobId')::uuid,
		(binding ->> 'runnerId')::uuid,(binding ->> 'assignmentId')::uuid,(binding ->> 'credentialCapsuleId')::uuid,(binding ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','routine-auth:' || intent::text,text,'progress');
	insert into step8_test.saved(key,value) values('auth-routine',to_jsonb(routine)),('auth-events',to_jsonb(events)),('notification-intent',to_jsonb(intent)),('notification-send',sent);
	-- Simulate response loss before acknowledging. The real send receipt is
	-- durable; restart must acknowledge it, never append a public fake event.
end $$;

savepoint sticky_auth_and_ordering;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid := (select (value #>> '{}')::uuid from step8_test.saved where key='auth-routine');
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '21 minutes'; occurrences uuid[]; events bigint[]; client uuid; job record;
begin
	perform step8_test.publish(routine,p,'paused');
	perform step8_test.publish(routine,p,'active');
	perform step8_test.wake_assert((select suspension='authentication' and epoch=3 from public.qorpera_step8_routine_state where routine_id=routine),'File pause/resume cannot silently clear auth suspension');
	select client_routine_id into client from public.qorpera_cloud_routines where id=routine;
	perform step8_test.wake_routine('30000000-0000-4000-8000-000000000030','{"id":"tick","kind":"schedule","intervalMinutes":10}',client);
	perform step8_test.publish(routine,p,'active');
	perform step8_test.wake_assert((select suspension='authentication' and routine_version=2 from public.qorpera_step8_routine_state where routine_id=routine),'Content edit cannot silently clear auth suspension');
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	perform public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '15 minutes',array[at+interval '5 minutes',at+interval '10 minutes',at+interval '15 minutes']),at+interval '15 minutes');
	perform public.qorpera_materialize_wake_execution_runs(3);
	select array_agg(w.id order by w.scheduled_for) into occurrences from public.qorpera_wake_occurrences w where w.routine_id=routine;
	for job in select j.run_id from public.qorpera_runner_jobs j join public.qorpera_wake_occurrences w on w.run_id=j.run_id
		where w.routine_id=routine order by j.created_at,j.id loop
		insert into step8_test.saved(key,value) values('outcome-binding:' || job.run_id::text,step8_test.wake_start(job.run_id));
	end loop;
	events := array[step8_test.outcome(occurrences[1],'success'),step8_test.outcome(occurrences[2],'authentication'),step8_test.outcome(occurrences[3],'success')];
	perform public.qorpera_step8_record_auth_outcome(events[2]);
	perform public.qorpera_step8_record_auth_outcome(events[1]);
	perform step8_test.wake_assert((select failure_count=1 from public.qorpera_step8_routine_state where routine_id=routine),'Late older success cannot reset a newer failure');
	perform public.qorpera_step8_record_auth_outcome(events[3]);
	perform step8_test.wake_assert((select failure_count=0 from public.qorpera_step8_routine_state where routine_id=routine),'Newer success resets the repeated-failure count');
end $$;
rollback to sticky_auth_and_ordering;

savepoint configured_auth_reset;
do $$
declare p jsonb := jsonb_set((select value from step8_test.saved where key='policy'),'{authFailures,resetOn}','"non-authentication"');
	routine uuid; at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '21 minutes'; occurrences uuid[]; events bigint[]; client uuid; late_occurrence uuid; late_event bigint;
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	perform public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '15 minutes',array[at+interval '5 minutes',at+interval '10 minutes',at+interval '15 minutes']),at+interval '15 minutes');
	perform public.qorpera_materialize_wake_execution_runs(3);
	select array_agg(w.id order by w.scheduled_for) into occurrences from public.qorpera_wake_occurrences w where w.routine_id=routine;
	events := array[step8_test.outcome(occurrences[1],'authentication'),step8_test.outcome(occurrences[2],'other'),step8_test.outcome(occurrences[3],'authentication')];
	perform public.qorpera_step8_record_auth_outcome(events[3]);
	perform public.qorpera_step8_record_auth_outcome(events[1]);
	perform public.qorpera_step8_record_auth_outcome(events[2]);
	perform step8_test.wake_assert((select failure_count=1 from public.qorpera_step8_routine_state where routine_id=routine),'Configured non-authentication outcome resets older failures');
	-- The same immutable terminal evidence cannot count against a later edit.
	perform public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '20 minutes',array[at+interval '20 minutes']),at+interval '20 minutes');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select w.id into strict late_occurrence from public.qorpera_wake_occurrences w where w.routine_id=routine and status='materialized';
	late_event := step8_test.outcome(late_occurrence,'authentication');
	select client_routine_id into client from public.qorpera_cloud_routines where id=routine;
	perform step8_test.wake_routine('30000000-0000-4000-8000-000000000030','{"id":"tick","kind":"schedule","intervalMinutes":10}',client);
	perform step8_test.publish(routine,p,'active');
	perform step8_test.wake_assert(public.qorpera_step8_record_auth_outcome(late_event) ->> 'status'='stale','Late terminal evidence does not affect a new version');
	perform step8_test.wake_assert((select failure_count=0 from public.qorpera_step8_routine_state where routine_id=routine),'New version starts a fresh failure series when not suspended');
end $$;
rollback to configured_auth_reset;

-- Leave the threshold-crossing observation unconsumed for concurrent callers.
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '21 minutes'; occurrences uuid[]; events bigint[];
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	perform public.qorpera_step8_commit_schedule_at(step8_test.plan(routine,at+interval '15 minutes',array[at+interval '5 minutes',at+interval '10 minutes',at+interval '15 minutes']),at+interval '15 minutes');
	perform public.qorpera_materialize_wake_execution_runs(3);
	select array_agg(w.id order by w.scheduled_for) into occurrences from public.qorpera_wake_occurrences w where w.routine_id=routine;
	events := array[step8_test.outcome(occurrences[1],'authentication'),step8_test.outcome(occurrences[2],'authentication'),step8_test.outcome(occurrences[3],'authentication')];
	perform public.qorpera_step8_record_auth_outcome(events[1]);
	perform public.qorpera_step8_record_auth_outcome(events[2]);
	insert into step8_test.saved(key,value) values('race-auth-routine',to_jsonb(routine)),('race-auth-event',to_jsonb(events[3]));
end $$;

-- Persist a fresh schedule for rollback, racing consumers and restart tests.
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '10 minutes'; plan jsonb;
begin
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	plan := step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']);
	insert into step8_test.saved(key,value) values('recovery-routine',to_jsonb(routine)),('recovery-plan',plan);
end $$;

create function step8_test.crash_schedule()
returns void language plpgsql as $$
declare plan jsonb := (select value from step8_test.saved where key='recovery-plan');
begin perform public.qorpera_step8_commit_schedule_at(plan,(plan ->> 'through')::timestamptz); end $$;

create function step8_test.assert_crash_rolled_back()
returns void language plpgsql as $$
declare plan jsonb := (select value from step8_test.saved where key='recovery-plan');
begin
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=(plan ->> 'routineId')::uuid),'Interrupted insert rolls back');
	perform step8_test.wake_assert((select observed_through=(plan ->> 'expectedObservedThrough')::timestamptz from public.qorpera_step8_routine_state where routine_id=(plan ->> 'routineId')::uuid),'Interrupted watermark rolls back');
end $$;

create function step8_test.concurrent_schedule()
returns jsonb language plpgsql as $$
declare plan jsonb := (select value from step8_test.saved where key='recovery-plan');
begin return public.qorpera_step8_commit_schedule_at(plan,(plan ->> 'through')::timestamptz); end $$;

create function step8_test.assert_concurrent_schedule()
returns void language plpgsql as $$
declare plan jsonb := (select value from step8_test.saved where key='recovery-plan');
begin
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_wake_occurrences where routine_id=(plan ->> 'routineId')::uuid),'Concurrent plan admits one occurrence');
	perform step8_test.wake_assert((select observed_through=(plan ->> 'through')::timestamptz from public.qorpera_step8_routine_state where routine_id=(plan ->> 'routineId')::uuid),'Cursor and queue commit together');
end $$;

create function step8_test.assert_restart()
returns void language plpgsql as $$
declare plan jsonb := (select value from step8_test.saved where key='recovery-plan'); intent uuid := (select (value #>> '{}')::uuid from step8_test.saved where key='notification-intent');
	sent jsonb := (select value from step8_test.saved where key='notification-send'); message uuid; count_before bigint;
begin
	perform step8_test.assert_concurrent_schedule();
	perform step8_test.wake_assert(public.qorpera_step8_commit_schedule_at(plan,(plan ->> 'through')::timestamptz) ->> 'status'='duplicate','Restart retains last exact plan receipt');
	perform step8_test.wake_assert((select message_id is null from public.qorpera_step8_notification_intents where id=intent),'Unacknowledged intent survives restart');
	perform step8_test.wake_assert(jsonb_array_length(public.qorpera_step8_list_notification_intents(1) -> 'items')=1,'Pending notification has bounded restart discovery');
	select event_id into strict message from public.qorpera_agent_sends where idempotency_key='routine-auth:' || intent::text;
	select count(*) into count_before from public.qorpera_session_events;
	perform public.qorpera_step8_ack_notification(intent,message);
	perform public.qorpera_step8_ack_notification(intent,message);
	perform step8_test.wake_assert((select message_id=message from public.qorpera_step8_notification_intents where id=intent),'Existing authorized send receipt acknowledged');
	perform step8_test.wake_assert((select count(*)=count_before from public.qorpera_session_events),'Acknowledgement never appends duplicate public messages');
end $$;

create function step8_test.concurrent_auth()
returns jsonb language sql as $$
	select public.qorpera_step8_record_auth_outcome((select (value #>> '{}')::bigint from step8_test.saved where key='race-auth-event'))
$$;

create function step8_test.assert_concurrent_auth()
returns void language plpgsql as $$
declare routine uuid := (select (value #>> '{}')::uuid from step8_test.saved where key='race-auth-routine');
begin
	perform step8_test.wake_assert((select failure_count=3 and suspension='authentication' from public.qorpera_step8_routine_state where routine_id=routine),'Concurrent third failure suspends once');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_notification_intents where routine_id=routine),'Concurrent suspension emits one intent');
end $$;

create function step8_test.concurrent_pause()
returns void language plpgsql as $$
declare routine uuid := (select (value #>> '{}')::uuid from step8_test.saved where key='recovery-routine');
begin
	perform step8_test.restore();
	perform step8_test.publish(routine,(select value from step8_test.saved where key='policy'),'paused');
end $$;

create function step8_test.concurrent_transition(p_plan jsonb)
returns text language plpgsql as $$
begin
	perform public.qorpera_step8_commit_schedule_at(p_plan,(p_plan ->> 'through')::timestamptz);
	return 'committed';
exception when serialization_failure then return 'stale';
end $$;

create function step8_test.intent_authority_snapshot(p_occurrence uuid)
returns jsonb language sql as $$
	select jsonb_build_object('wake',to_jsonb(w),'epoch',to_jsonb(e),'state',to_jsonb(s),'cursor',to_jsonb(c),'policy',to_jsonb(p))
	from public.qorpera_wake_occurrences w
	join public.qorpera_step8_occurrence_epochs e on e.occurrence_id=w.id
	join public.qorpera_step8_routine_state s on s.routine_id=w.routine_id
	join public.qorpera_cloud_routine_schedule_cursors c on c.routine_id=w.routine_id and c.routine_version=w.routine_version and c.trigger_id=w.trigger_id
	join public.qorpera_step8_routine_policies p on p.routine_id=w.routine_id and p.routine_version=w.routine_version
	where w.id=p_occurrence
$$;

create function step8_test.assert_intent_authority(p_fixture jsonb,p_allowed boolean)
returns void language plpgsql as $$
declare w public.qorpera_wake_occurrences%rowtype; file_path text := p_fixture #>> '{snapshot,policy,path}';
begin
	select * into strict w from public.qorpera_wake_occurrences where id=(p_fixture #>> '{snapshot,wake,id}')::uuid;
	-- Exercise the private predicate under the documented common lock order.
	-- This does not install a policy guard in the shared materializer/effect lane.
	perform public.qorpera_step8_lock_intent(w.environment_id);
	perform 1 from public.qorpera_cloud_routines where id=w.routine_id for share;
	perform 1 from public.qorpera_step8_routine_state where routine_id=w.routine_id for update;
	perform 1 from public.qorpera_wake_occurrences where id=w.id for update;
	perform public.qorpera_step8_assert_projection(w.routine_id);
	perform step8_test.wake_assert(public.qorpera_wake_path_authorized(w.environment_id,w.requested_by_user_id,w.staff_agent_id,file_path)
		is not distinct from p_allowed,'Current intent-path authority matches the owner grant/scope change');
	perform step8_test.wake_assert(public.qorpera_wake_authorized(w),'Generic scheduled wake authority alone does not cover the routine intent path');
	perform step8_test.wake_assert(public.qorpera_step8_occurrence_allowed_at(w.id,clock_timestamp()) is not distinct from p_allowed,
		format('Intent-path occurrence guard: %s / %s must return %s',p_fixture ->> 'stage',p_fixture ->> 'change',p_allowed));
	if p_allowed then
		perform public.qorpera_step8_read_schedule_context(w.routine_id);
	else
		perform step8_test.wake_error(format('select public.qorpera_step8_read_schedule_context(%L)',w.routine_id),'42501');
	end if;
	perform step8_test.wake_assert(step8_test.intent_authority_snapshot(w.id)=p_fixture -> 'snapshot',
		'Authority rechecks preserve the complete occurrence (including identity, status and run), epoch, state, cursor and projection');
end $$;

-- Invoked after the other materializer fixtures, with materialized cases first
-- so no unrelated queued occurrence can consume their one-item batch. Saved
-- snapshots and real ACL rows survive the harness's database restart.
create function step8_test.check_intent_authority(p_stage text,p_change text)
returns void language plpgsql as $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid; occurrence uuid;
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '10 minutes'; resource jsonb; grant_id uuid;
	file_path text; fixture jsonb;
begin
	perform step8_test.restore();
	perform step8_test.wake_assert(p_stage in ('queued','materialized') and p_change in ('staff-grant-revoked','intent-made-private'),'Known authority regression case');
	routine := step8_test.new_schedule(p,at+interval '5 minutes',at);
	file_path := 'routine-' || routine::text || '.json';
	perform public.qorpera_step8_commit_schedule(step8_test.plan(routine,at+interval '5 minutes',array[at+interval '5 minutes']));
	select w.id into strict occurrence from public.qorpera_wake_occurrences w where w.routine_id=routine;
	if p_stage='materialized' then
		perform step8_test.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(1))=1,'Authority fixture uses the actual Step 3 materializer');
	end if;
	perform step8_test.wake_assert((select status=p_stage and (run_id is not null)=(p_stage='materialized')
		from public.qorpera_wake_occurrences where id=occurrence),'Authority fixture has the requested occurrence stage and real run binding');
	if p_change='staff-grant-revoked' then
		perform step8_test.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
		resource := public.qorpera_set_company_path_resource('30000000-0000-4000-8000-000000000020',file_path,'exact','company_shared','normal');
		grant_id := public.qorpera_grant_company_path((resource ->> 'resourceId')::uuid,(resource ->> 'version')::uuid,
			'staff_agent','30000000-0000-4000-8000-000000000030',array['read']);
		perform step8_test.path_claims('service_role');
	end if;
	fixture := jsonb_build_object('stage',p_stage,'change',p_change,'snapshot',step8_test.intent_authority_snapshot(occurrence));
	perform step8_test.assert_intent_authority(fixture,true);
	perform step8_test.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	if p_change='staff-grant-revoked' then
		perform public.qorpera_revoke_company_path((resource ->> 'resourceId')::uuid,(resource ->> 'version')::uuid,grant_id);
	else
		perform public.qorpera_set_company_path_resource('30000000-0000-4000-8000-000000000020',file_path,'exact','member_private','normal');
	end if;
	perform step8_test.path_claims('service_role');
	perform step8_test.assert_intent_authority(fixture,false);
	if p_change='staff-grant-revoked' then
		-- An explicit new owner grant restores authority without recreating or
		-- relabeling the occurrence. Revoke it again for the restart assertions.
		perform step8_test.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
		grant_id := public.qorpera_grant_company_path((resource ->> 'resourceId')::uuid,(resource ->> 'version')::uuid,
			'staff_agent','30000000-0000-4000-8000-000000000030',array['read']);
		perform step8_test.path_claims('service_role');
		perform step8_test.assert_intent_authority(fixture,true);
		perform step8_test.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
		perform public.qorpera_revoke_company_path((resource ->> 'resourceId')::uuid,(resource ->> 'version')::uuid,grant_id);
		perform step8_test.path_claims('service_role');
		perform step8_test.assert_intent_authority(fixture,false);
	end if;
	insert into step8_test.saved(key,value) values('intent-authority:' || p_stage || ':' || p_change,fixture);
end $$;

do $$ declare role text; begin
	foreach role in array array['anon','authenticated','service_role'] loop
		perform step8_test.wake_assert(not has_table_privilege(role,'public.qorpera_step8_notification_intents','SELECT'),'Intents are private');
		perform step8_test.wake_assert(not has_table_privilege(role,'public.qorpera_step8_routine_state','UPDATE'),'No direct projection mutations');
		perform step8_test.wake_assert(not has_function_privilege(role,'public.qorpera_step8_project_routine(uuid,bigint,text,jsonb,text)','EXECUTE'),'Only admitted File transaction can project');
		perform step8_test.wake_assert(not has_function_privilege(role,'public.qorpera_step8_commit_schedule_at(jsonb,timestamptz)','EXECUTE'),'No client-selected production clock');
	end loop;
end $$;
commit;
