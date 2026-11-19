-- No run, machine or API-key caps (runtime v92, 2026-09-24). A company has no
-- running-machine limit (node capacity is the only bound), an API-key
-- connection has no monthly budget and no per-run call, token or cost cap
-- (its concurrency stays), and a run has no deadline: neither a
-- run nor its native connection lease is bounded by 24 hours, and usage of a
-- run longer than a day is recorded as is. A run reads, asks its model, hires
-- and opens group chats without a count.
begin;

do $$
declare v_default text;
begin
	select column_default into strict v_default from information_schema.columns
	where table_schema = 'public' and table_name = 'qorpera_execution_runs' and column_name = 'deadline_at';
	if v_default not like '%100 years%' then
		raise exception 'A run deadline remains: %', v_default; end if;
	-- Waiting to start is bounded from the last time a job was queued, which every requeue records.
	-- (The usage-limit handoff, the other requeue path, is gone since 20260930059000.)
	if (select count(*) from pg_proc where oid = 'public.qorpera_terminalize_runner_attempt_before_native_start(uuid,text,text,boolean)'::regprocedure
			and prosrc like '%queued_at = statement_timestamp()%') <> 1 then
		raise exception 'A requeue path does not record when the job was queued again'; end if;
end
$$;

rollback;
