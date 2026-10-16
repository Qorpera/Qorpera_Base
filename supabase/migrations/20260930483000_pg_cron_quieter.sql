-- Fewer pg_cron runs (production DB slowness, v180 item 2: the polling load).
--
-- Production runs pg_cron with cron.use_background_workers off, so every run of every job opens a fresh backend. Most
-- runs come from two jobs that usually find nothing: the folder follow-up step every 2 seconds (30 runs a minute, about
-- 43,200 a day) and the folder erasure drain every 5 seconds (12 a minute). Under an agent run's load those fresh
-- backends start slowly; on 16 Oct the erasure job failed twice with "job startup timeout". So:
--   1. The follow-up step runs every 10 seconds (6 a minute). It is the backstop: a writer that commits marks converges
--      them at once through the kicks (20260928479140 §10), and the step only picks up what no kick took and the rows whose
--      back-off ran out. The runtime's commits (hire_agent, an archive) have no kick, so they now wait up to 10 seconds
--      for the step, not 2. Its sweep of gone environments still runs about once a minute (one step in each minute's first
--      10 seconds). It also asks whether a company's follow-ups may run once per company with marks, not once per mark.
--   2. The erasure drain runs every 30 seconds (2 a minute). One step drains up to 1,000 versions and 1,000 commits, so
--      a drain does at most 2,000 of each a minute (it did 12,000).
--   3. Node receipt retention runs once an hour, at minute 2. A run deletes up to 5,000 receipts (10 batches of 500, one
--      second at most), so it keeps up with the nodes' receipts (production holds about 234,000 from two weeks).
--   4. One daily cleanup of the run log for every qorpera job, kept one day, as the follow-up and erasure jobs already
--      had (cron.log_run writes a row for each run). The meter, deletions, notices and retention jobs had none, so their
--      rows stayed forever.
-- Each schedule helper upserts its job by name, so applying this changes the running jobs' schedules in place. Nothing
-- outside the database changes; the steps and their callers are the same.

set local lock_timeout = '3s';

-- 1. The follow-up step and its schedule ------------------------------------------------------------------------------

create or replace function public.qorpera_folder_follow_up_step()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_subject record; v_work public.qorpera_folder_follow_ups%rowtype; v_swept bigint := 0; v_open uuid[];
begin
	perform set_config('lock_timeout', '2s', true);
	-- The sweep scans every row, so it runs about once a minute (one step in each minute's first 10 seconds).
	if extract(epoch from clock_timestamp())::bigint % 60 < 10 then v_swept := public.qorpera_folder_follow_up_sweep(); end if;
	-- Whether a company's follow-ups may run, asked once per company with marks (offset 0 keeps the check out of the scan).
	select coalesce(array_agg(e.environment_id), '{}') into v_open
	from (select distinct environment_id from public.qorpera_folder_follow_up_marks offset 0) e
	where public.qorpera_folder_follow_up_open(e.environment_id);
	for v_subject in select m.environment_id, m.subject_kind, m.subject_id from public.qorpera_folder_follow_up_marks m
		where m.environment_id = any (v_open)
		group by m.environment_id, m.subject_kind, m.subject_id order by min(m.id) limit 8
	loop
		v_work := public.qorpera_folder_follow_up_take(v_subject.environment_id, v_subject.subject_kind, v_subject.subject_id);
		-- (A subject whose only marks came with no commit keeps its back-off.)
		exit when v_work.subject_id is not null and v_work.dirty
			and (v_work.not_before is null or v_work.not_before <= clock_timestamp());
		v_work := null;
	end loop;
	if v_work.subject_id is null then
		select w.* into v_work from public.qorpera_folder_follow_ups w
		where w.dirty and (w.not_before is null or w.not_before <= clock_timestamp())
			and public.qorpera_folder_follow_up_open(w.environment_id)
		order by w.not_before nulls first, w.updated_at
		limit 1 for update skip locked;
		-- Its marks too, so the member a pending mark names authors its first run.
		if v_work.subject_id is not null then
			v_work := public.qorpera_folder_follow_up_take(v_work.environment_id, v_work.subject_kind, v_work.subject_id); end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-follow-up-step/v1', 'swept', v_swept,
		'converged', case when v_work.subject_id is not null and v_work.dirty
			then public.qorpera_folder_follow_up_converge(v_work) end);
end $$;

create or replace function public.qorpera_schedule_folder_follow_ups()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The folder follow-up queue was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.folder-follow-up-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-folder-follow-ups', '10 seconds', 'select public.qorpera_folder_follow_up_step()');
		v_clean := cron.schedule('qorpera-folder-follow-ups-log', '23 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-folder-follow-ups')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The folder follow-up queue was not scheduled (%): % may not use pg_cron, or pg_cron is older than 1.5',
			sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.folder-follow-up-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.folder-follow-up-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;

-- 2. The erasure drain's schedule --------------------------------------------------------------------------------------

create or replace function public.qorpera_schedule_folder_erasure()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'Folder erasure was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.folder-erasure-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-folder-erasure', '30 seconds', 'select public.qorpera_folder_erasure_step()');
		v_clean := cron.schedule('qorpera-folder-erasure-log', '17 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-folder-erasure')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'Folder erasure was not scheduled (%): % may not use pg_cron, or pg_cron is older than 1.5', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.folder-erasure-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.folder-erasure-schedule/v1', 'scheduled', true, 'jobs', jsonb_build_array(v_step, v_clean));
end $$;

-- 3. Node receipt retention's schedule ---------------------------------------------------------------------------------

create or replace function public.qorpera_schedule_runtime_node_receipt_retention()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
	v_job bigint;
begin
	if to_regnamespace('cron') is null then
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', false);
	end if;
	begin
		-- Looking up a function in schema cron already needs USAGE on it.
		if to_regprocedure('cron.schedule(text,text,text)') is null then
			return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', false);
		end if;
		-- Minute 2 of each hour: never with the every-five-minutes jobs at minutes 0, 5, 10, ...
		v_job := cron.schedule('qorpera-runtime-node-receipts-retention', '2 * * * *',
			'select public.qorpera_run_runtime_node_receipt_retention()');
	exception when insufficient_privilege then
		raise warning 'Node receipt retention was not scheduled: % may not use pg_cron', current_user;
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', true,
		'jobId', v_job);
end
$$;

-- 4. One daily cleanup of every qorpera job's run log ------------------------------------------------------------------

-- Where pg_cron is absent or the role may not use it, nothing is scheduled and the migration still applies; run
-- select public.qorpera_schedule_cron_run_log_cleanup() as the role that owns the jobs after enabling it. Each call also
-- clears the rows older than a day at once.
create function public.qorpera_schedule_cron_run_log_cleanup()
returns jsonb language plpgsql set search_path = '' as $$
declare v_job bigint; v_cleared bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The run log cleanup was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.cron-run-log-cleanup-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_job := cron.schedule('qorpera-cron-run-log', '41 3 * * *',
			$q$delete from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'qorpera-%')
				and end_time < now() - interval '1 day'$q$);
		delete from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'qorpera-%')
			and end_time < now() - interval '1 day';
		get diagnostics v_cleared = row_count;
	exception when others then
		raise warning 'The run log cleanup was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.cron-run-log-cleanup-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.cron-run-log-cleanup-schedule/v1', 'scheduled', true, 'jobId', v_job,
		'cleared', v_cleared);
end $$;
revoke all on function public.qorpera_schedule_cron_run_log_cleanup() from public, anon, authenticated, service_role;

select public.qorpera_schedule_folder_follow_ups();
select public.qorpera_schedule_folder_erasure();
select public.qorpera_schedule_runtime_node_receipt_retention();
select public.qorpera_schedule_cron_run_log_cleanup();
