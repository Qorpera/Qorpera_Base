-- Runtime observations: batch writes and scheduled retention (stack audit, 2026-09-29).
--
-- 1. qorpera_record_runtime_observation_batch(run, observations) records up to 50 observations of one
--    run in one call. The runtime sent one PostgREST call per row, one at a time: a company_read and
--    the model-request fence after it made about 14 rows and as many round trips, more than their
--    authority checks. Each row still goes through qorpera_record_runtime_observation itself, in
--    order, so its validation, closed vocabulary (which later migrations patch by text), reference
--    checks, replay rule and advisory lock are exactly the single-row function's. A row that function
--    refuses (22023 invalid, 42501 run or reference unavailable, 23505 a replay with other metadata)
--    gets a refusal in its slot and the other rows are still recorded: each row runs in its own
--    subtransaction, and 50 stays under the 64 a backend caches before other sessions' snapshots slow
--    down. Any other error fails the whole call, and the runtime sends it again (an exact replay is
--    acknowledged, never recorded twice). The call waits at most 1 s for any lock (lock_timeout,
--    55P03): a retry the runtime sends while its abandoned first attempt still runs (PostgREST does
--    not cancel it) waits on that attempt's row lock, and must fail fast and back off instead of
--    holding a pooled connection until the first commits. The single-row function stays for runners
--    of the previous bundle during a cut.
-- 2. qorpera_purge_runtime_observations (20260828019970) had no caller, so the table only grew.
--    qorpera_run_runtime_observation_retention() deletes the rows that purge deletes and only those:
--    observations ingested more than 30 days ago whose run's job is completed, failed or cancelled.
--    It touches no other table (no authority, receipt, read, revision or public send) and no
--    diagnostics of a job still in progress. Batches of 200 (the purge's own bound), at most 25 a
--    call and about two seconds, one call at a time (advisory lock). pg_cron runs it every five
--    minutes as 'qorpera-runtime-observations-retention': up to 5,000 rows each time, 1.44 million a
--    day, so the table keeps about 30 days. Where pg_cron is not installed (a database built only by
--    replaying migrations), or the applying role may not use it, nothing is scheduled and the
--    migration still applies; after enabling it, run, as the role that should own the job,
--    select public.qorpera_schedule_runtime_observation_retention(). Scheduling by the same name
--    replaces that one job, so running this file or the helper again is safe.
set local lock_timeout = '3s';

create or replace function public.qorpera_record_runtime_observation_batch(p_run_id uuid, p_observations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
	v_row jsonb;
	v_receipts jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runtime diagnostics require operator service authority' using errcode = '42501';
	end if;
	if p_run_id is null or jsonb_typeof(p_observations) is distinct from 'array' then
		raise exception 'Runtime observation batch is invalid' using errcode = '22023';
	end if;
	-- Every row is at most 8 KiB (the single-row check); this refuses an oversized call before any row.
	if jsonb_array_length(p_observations) not between 1 and 50
		or octet_length(p_observations::text) > 50 * (8192 + 2) then
		raise exception 'Runtime observation batch is invalid' using errcode = '22023';
	end if;
	for v_row in
		select item.value from jsonb_array_elements(p_observations) with ordinality as item(value, ordinal)
		order by item.ordinal
	loop
		begin
			v_receipts := v_receipts || jsonb_build_array(public.qorpera_record_runtime_observation(p_run_id, v_row));
		exception when sqlstate '22023' or sqlstate '42501' or sqlstate '23505' then
			v_receipts := v_receipts || jsonb_build_array(jsonb_build_object(
				'schema', 'qorpera.runtime-observation-refusal/v1', 'code', sqlstate));
		end;
	end loop;
	return jsonb_build_object('schema', 'qorpera.runtime-observation-batch-receipt/v1', 'runId', p_run_id,
		'receipts', v_receipts);
end
$$;
revoke all on function public.qorpera_record_runtime_observation_batch(uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_runtime_observation_batch(uuid, jsonb) to service_role;
comment on function public.qorpera_record_runtime_observation_batch(uuid, jsonb) is
	'Best-effort diagnostics, not authorization or billing. Up to 50 rows of one run, each recorded or refused by qorpera_record_runtime_observation exactly as one call would be; receipts are in row order.';

-- Run by pg_cron as its owner. EXECUTE is otherwise service_role's only; the body has no role check,
-- like the computer-hour meter (20260928248000).
create or replace function public.qorpera_run_runtime_observation_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	-- A value, not a call inside the query, so each batch reads a bounded range of the retention index.
	v_cutoff timestamptz := clock_timestamp() - interval '30 days';
	v_started timestamptz := clock_timestamp();
	v_batch integer;
	v_batches integer := 0;
	v_deleted integer := 0;
begin
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.runtime-observation-retention', 0)) then
		return jsonb_build_object('schema', 'qorpera.runtime-observation-retention/v1', 'busy', true,
			'deleted', 0, 'batches', 0);
	end if;
	loop
		-- The rows qorpera_purge_runtime_observations deletes (20260828019970), 200 at a time.
		with candidates as (
			select o.id from public.qorpera_runtime_observations o
			join public.qorpera_execution_runs r on r.id = o.run_id
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where o.ingested_at < v_cutoff and j.status in ('completed', 'failed', 'cancelled')
			order by o.ingested_at, o.id
			limit 200
			for update of o skip locked
		), removed as (
			delete from public.qorpera_runtime_observations where id in (select id from candidates) returning id
		)
		select count(*) into v_batch from removed;
		v_batches := v_batches + 1;
		v_deleted := v_deleted + v_batch;
		exit when v_batch < 200 or v_batches >= 25 or clock_timestamp() - v_started >= interval '2 seconds';
	end loop;
	return jsonb_build_object('schema', 'qorpera.runtime-observation-retention/v1', 'busy', false,
		'deleted', v_deleted, 'batches', v_batches, 'cutoff', v_cutoff, 'diagnosticDays', 30);
end
$$;
revoke all on function public.qorpera_run_runtime_observation_retention()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_run_runtime_observation_retention() to service_role;

-- Migration and operator only. Runs as its caller, who then owns the job and runs it. Without pg_cron,
-- or for a caller that may not use it (no USAGE on schema cron, or no right to schedule), the answer is
-- scheduled false (with a warning in the second case), never a failed migration.
create or replace function public.qorpera_schedule_runtime_observation_retention()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
	v_job bigint;
begin
	if to_regnamespace('cron') is null then
		return jsonb_build_object('schema', 'qorpera.runtime-observation-retention-schedule/v1', 'scheduled', false);
	end if;
	begin
		-- Looking up a function in schema cron already needs USAGE on it.
		if to_regprocedure('cron.schedule(text,text,text)') is null then
			return jsonb_build_object('schema', 'qorpera.runtime-observation-retention-schedule/v1', 'scheduled', false);
		end if;
		v_job := cron.schedule('qorpera-runtime-observations-retention', '*/5 * * * *',
			'select public.qorpera_run_runtime_observation_retention()');
	exception when insufficient_privilege then
		raise warning 'Runtime observation retention was not scheduled: % may not use pg_cron', current_user;
		return jsonb_build_object('schema', 'qorpera.runtime-observation-retention-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.runtime-observation-retention-schedule/v1', 'scheduled', true,
		'jobId', v_job);
end
$$;
revoke all on function public.qorpera_schedule_runtime_observation_retention()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select public.qorpera_schedule_runtime_observation_retention();
