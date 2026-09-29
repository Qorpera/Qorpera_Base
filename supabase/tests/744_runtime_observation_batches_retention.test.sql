-- @fixture 320_runtime_operational_observability.test.sql until "-- Operator RPCs are not a member, model, runner, or broker inspection surface."
-- Batch observation writes and scheduled retention (20260929370000), on SQL320's real native run.

-- Only service_role writes batches or runs retention by hand; no API role schedules it.
reset role;
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_record_runtime_observation_batch(uuid,jsonb)','EXECUTE')
				is distinct from (v_role = 'service_role')
			or has_function_privilege(v_role,'public.qorpera_run_runtime_observation_retention()','EXECUTE')
				is distinct from (v_role = 'service_role')
			or has_function_privilege(v_role,'public.qorpera_schedule_runtime_observation_retention()','EXECUTE') then
			raise exception 'Observation batch or retention boundary is incorrect for %',v_role; end if;
	end loop;
end
$$;

-- A batch needs the same service authority as one row.
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
begin
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	begin
		perform public.qorpera_record_runtime_observation_batch(v_run,jsonb_build_array(pg_temp.observation()));
		raise exception 'Member observation batch accepted' using errcode = 'QTB01';
	exception when insufficient_privilege then null; end;
	perform pg_temp.path_claims('service_role');
end
$$;

-- Rows go through the single-row function in order: each is recorded, replayed or refused on its own.
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_first jsonb := pg_temp.observation('34000000-0000-4000-8000-000000000001');
	v_second jsonb := pg_temp.observation('34000000-0000-4000-8000-000000000002');
	v_result jsonb; v_replay jsonb; v_before bigint;
begin
	select count(*) into v_before from public.qorpera_runtime_observations;
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch(v_run,jsonb_build_array(
		v_first,
		v_first || '{"operation":"print_secret"}',
		v_first,
		v_first || '{"logicalOperationSha256":null}',
		v_second || '{"receiptId":"34000000-0000-4000-8000-0000000000ff"}',
		v_second));
	v_replay := public.qorpera_record_runtime_observation(v_run,v_first);
	reset role;
	if v_result - 'receipts' <> jsonb_build_object('schema','qorpera.runtime-observation-batch-receipt/v1','runId',v_run)
		or jsonb_array_length(v_result -> 'receipts') <> 6
		or (v_result #> '{receipts,0}') - 'replayed' <> v_replay - 'replayed'
		or v_result #> '{receipts,0,replayed}' <> 'false'::jsonb
		or v_result #> '{receipts,1}' <> '{"schema":"qorpera.runtime-observation-refusal/v1","code":"22023"}'::jsonb
		or v_result #> '{receipts,2}' <> v_replay
		or v_result #> '{receipts,3}' <> '{"schema":"qorpera.runtime-observation-refusal/v1","code":"23505"}'::jsonb
		or v_result #> '{receipts,4}' <> '{"schema":"qorpera.runtime-observation-refusal/v1","code":"42501"}'::jsonb
		or v_result #>> '{receipts,5,attemptId}' <> v_second ->> 'attemptId'
		or v_result #> '{receipts,5,replayed}' <> 'false'::jsonb then
		raise exception 'Batch receipts differ from single-row outcomes: %',v_result; end if;
	if (select count(*) from public.qorpera_runtime_observations) <> v_before + 2
		or (select array_agg(attempt_id order by id) from public.qorpera_runtime_observations
			where attempt_id in ('34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000002'))
			<> array['34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000002']::uuid[] then
		raise exception 'Batch did not record each accepted row exactly once, in order'; end if;

	-- A run that does not exist: every row is refused, nothing is recorded.
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch('34000000-0000-4000-8000-0000000000aa',
		jsonb_build_array(pg_temp.observation(),pg_temp.observation()));
	reset role;
	if v_result -> 'receipts' <> jsonb_build_array(
			'{"schema":"qorpera.runtime-observation-refusal/v1","code":"42501"}'::jsonb,
			'{"schema":"qorpera.runtime-observation-refusal/v1","code":"42501"}'::jsonb)
		or (select count(*) from public.qorpera_runtime_observations) <> v_before + 2 then
		raise exception 'Batch recorded rows for an unavailable run'; end if;
end
$$;

-- The call itself: an array of 1 to 50 rows of at most 8 KiB each.
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_input jsonb; v_result jsonb; v_before bigint;
begin
	foreach v_input in array array[
		null,
		'{}'::jsonb,
		'"row"'::jsonb,
		'[]'::jsonb,
		(select jsonb_agg(pg_temp.observation()) from generate_series(1,51)),
		(select jsonb_agg(repeat('x',8200)) from generate_series(1,50))] loop
		begin
			set local role service_role;
			perform public.qorpera_record_runtime_observation_batch(v_run,v_input);
			raise exception 'Invalid observation batch accepted' using errcode = 'QTB02';
		exception when sqlstate '22023' then null; end;
		reset role;
	end loop;
	begin
		set local role service_role;
		perform public.qorpera_record_runtime_observation_batch(null,jsonb_build_array(pg_temp.observation()));
		raise exception 'Batch without a run accepted' using errcode = 'QTB02';
	exception when sqlstate '22023' then null; end;
	reset role;
	select count(*) into v_before from public.qorpera_runtime_observations;
	set local role service_role;
	v_result := public.qorpera_record_runtime_observation_batch(v_run,
		(select jsonb_agg(pg_temp.observation()) from generate_series(1,50)));
	reset role;
	if jsonb_array_length(v_result -> 'receipts') <> 50
		or exists(select 1 from jsonb_array_elements(v_result -> 'receipts') receipt
			where receipt ->> 'schema' <> 'qorpera.runtime-observation-receipt/v1')
		or (select count(*) from public.qorpera_runtime_observations) <> v_before + 50 then
		raise exception 'A full batch of 50 was not recorded'; end if;
end
$$;

-- A retry must not wait for the attempt it repeats. Another session holds the row lock a still-running
-- first attempt holds (the single-row function's advisory lock on run and attempt); the batch gives up
-- after its 1 s lock timeout with 55P03, which the runtime backs off on, and records nothing.
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_row jsonb := pg_temp.observation('34000000-0000-4000-8000-0000000000b1'); v_started timestamptz; v_waited interval;
begin
	perform dblink_connect('attempt_peer','dbname=' || current_database());
	perform * from dblink('attempt_peer', format('select pg_advisory_lock(hashtextextended(%L,19970))',
		'runtime-observation:' || v_run || ':' || (v_row ->> 'attemptId'))) as held(held text);
	v_started := clock_timestamp();
	begin
		set local role service_role;
		perform public.qorpera_record_runtime_observation_batch(v_run,jsonb_build_array(v_row));
		raise exception 'A batch waited out a held row lock' using errcode = 'QTB03';
	exception when lock_not_available then null; end;
	reset role;
	v_waited := clock_timestamp() - v_started;
	perform dblink_disconnect('attempt_peer');
	if v_waited < interval '0.9 seconds' or v_waited > interval '3 seconds'
		or exists (select 1 from public.qorpera_runtime_observations where run_id = v_run
			and attempt_id = '34000000-0000-4000-8000-0000000000b1') then
		raise exception 'The batch lock timeout differs: waited %', v_waited; end if;
end
$$;

-- Retention: the purge's rows only (over 30 days old, terminal job), 200 at a time, bounded per call.
reset role;
insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,parent_attempt_id,
	operation,logical_operation_sha256,observed_at,ingested_at,observation)
select (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid,attempt,'start',null,null,
	'model_turn',null,clock_timestamp(),clock_timestamp()-interval '31 days',
	pg_temp.observation(attempt) || '{"operation":"model_turn","logicalOperationSha256":null,"assignmentId":null}'
from (select extensions.gen_random_uuid() as attempt from generate_series(1,5250)) old;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_result jsonb; v_total integer := 0;
	v_fresh bigint; v_events bigint; v_receipts bigint; v_reads bigint; v_sends bigint;
begin
	set local role service_role;
	v_result := public.qorpera_run_runtime_observation_retention();
	reset role;
	if v_result ->> 'deleted' <> '0' or v_result ->> 'busy' <> 'false' then
		raise exception 'Retention pruned a job still in progress: %',v_result; end if;
	set local role service_role;
	perform public.qorpera_terminalize_runner_attempt((b ->> 'jobId')::uuid,'failed','Retention fixture',false);
	reset role;
	select count(*) into v_fresh from public.qorpera_runtime_observations where ingested_at > clock_timestamp()-interval '1 day';
	select count(*) into v_events from public.qorpera_execution_run_events;
	select count(*) into v_receipts from public.qorpera_run_operation_receipts;
	select count(*) into v_reads from public.qorpera_company_read_observations;
	select count(*) into v_sends from public.qorpera_agent_sends;
	-- Another session running retention meanwhile answers busy and deletes nothing.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-observation-retention',0));
	perform dblink_connect('retention_peer','dbname=' || current_database());
	if (select value from dblink('retention_peer','select public.qorpera_run_runtime_observation_retention()')
			as peer(value jsonb)) -> 'busy' <> 'true'::jsonb then
		raise exception 'A second retention call ran concurrently'; end if;
	perform dblink_disconnect('retention_peer');
	-- One call: 200-row batches, at most 25 of them, and never more than it reports.
	set local role service_role;
	v_result := public.qorpera_run_runtime_observation_retention();
	reset role;
	if (v_result ->> 'batches')::integer not between 1 and 25
		or (v_result ->> 'deleted')::integer <> 200 * (v_result ->> 'batches')::integer
		or (select count(*) from public.qorpera_runtime_observations where ingested_at < clock_timestamp()-interval '30 days')
			<> 5250 - (v_result ->> 'deleted')::integer then
		raise exception 'One retention call exceeded its bound: %',v_result; end if;
	v_total := (v_result ->> 'deleted')::integer;
	for attempt in 1..30 loop
		set local role service_role;
		v_result := public.qorpera_run_runtime_observation_retention();
		reset role;
		v_total := v_total + (v_result ->> 'deleted')::integer;
		exit when (v_result ->> 'deleted')::integer < 200 * (v_result ->> 'batches')::integer;
	end loop;
	set local role service_role;
	v_result := public.qorpera_purge_runtime_observations(1);
	reset role;
	if v_total <> 5250 or v_result ->> 'deleted' <> '0' or v_result -> 'moreEligible' <> 'false'::jsonb
		or (select count(*) from public.qorpera_runtime_observations where ingested_at > clock_timestamp()-interval '1 day') <> v_fresh
		or (select count(*) from public.qorpera_execution_run_events) <> v_events
		or (select count(*) from public.qorpera_run_operation_receipts) <> v_receipts
		or (select count(*) from public.qorpera_company_read_observations) <> v_reads
		or (select count(*) from public.qorpera_agent_sends) <> v_sends then
		raise exception 'Retention left eligible rows or touched fresh diagnostics or authority (deleted %)',v_total; end if;
end
$$;

-- pg_cron is not part of the test database. A stand-in with pg_cron's schedule-by-name contract shows
-- the helper schedules one job, idempotently, whose command runs as its owner.
do $$
declare v_first jsonb; v_second jsonb; v_command text;
begin
	if to_regnamespace('cron') is null then
		if public.qorpera_schedule_runtime_observation_retention() <>
			'{"schema":"qorpera.runtime-observation-retention-schedule/v1","scheduled":false}'::jsonb then
			raise exception 'Retention claimed a schedule without pg_cron'; end if;
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user,
			unique (jobname, username));
		create function cron.schedule(p_name text,p_schedule text,p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname,schedule,command) values (p_name,p_schedule,p_command)
			on conflict (jobname,username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v_first := public.qorpera_schedule_runtime_observation_retention();
	v_second := public.qorpera_schedule_runtime_observation_retention();
	if v_first ->> 'scheduled' <> 'true' or v_second -> 'jobId' <> v_first -> 'jobId'
		or (select count(*) from cron.job where jobname = 'qorpera-runtime-observations-retention') <> 1
		or (select schedule from cron.job where jobname = 'qorpera-runtime-observations-retention') <> '*/5 * * * *' then
		raise exception 'Retention is not scheduled exactly once every five minutes'; end if;
	select command into v_command from cron.job where jobname = 'qorpera-runtime-observations-retention';
	if v_command <> 'select public.qorpera_run_runtime_observation_retention()' then
		raise exception 'Scheduled retention runs another command: %',v_command; end if;
	execute v_command;
	-- A caller that may not use pg_cron gets scheduled false, never an error that would fail the migration:
	-- without USAGE on schema cron, then with USAGE but without the right to schedule.
	create role retention_scheduler nologin;
	grant execute on function public.qorpera_schedule_runtime_observation_retention() to retention_scheduler;
	for v_step in 1..2 loop
		if v_step = 2 then
			grant usage on schema cron to retention_scheduler;
			revoke execute on function cron.schedule(text,text,text) from public;
		end if;
		set local role retention_scheduler;
		if public.qorpera_schedule_runtime_observation_retention() ->> 'scheduled' <> 'false' then
			raise exception 'A caller without pg_cron rights scheduled retention (step %)', v_step; end if;
		reset role;
	end loop;
end
$$;
set constraints all immediate;
rollback;
