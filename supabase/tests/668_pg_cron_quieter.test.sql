-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Fewer pg_cron runs (20260930483000): the follow-up step every 10 seconds, the erasure drain every 30 seconds, node
-- receipt retention hourly, and one daily cleanup of every qorpera job's run log. The follow-up step asks whether a
-- company's follow-ups may run once per company with marks (it asked once per mark). Last, the three jobs' runs are
-- timed on a fresh connection each, as production's pg_cron runs them, and their steps with nothing to do in this
-- session, the old follow-up step beside the new one (printed, not checked).

reset role;

-- 1. The schedules. pg_cron is not part of the test database: a stand-in with its schedule-by-name contract (as 879).
do $$
declare v jsonb; v_jobs jsonb := '{}'; v_cleanup jsonb;
begin
	if to_regnamespace('cron') is null then
		if public.qorpera_schedule_cron_run_log_cleanup() ->> 'scheduled' is distinct from 'false' then
			raise exception 'The run log cleanup claimed a schedule without pg_cron'; end if;
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user, unique (jobname, username));
		create table cron.job_run_details(runid bigint generated always as identity primary key, jobid bigint, end_time timestamptz);
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	foreach v in array array[public.qorpera_schedule_folder_follow_ups(), public.qorpera_schedule_folder_erasure(),
		public.qorpera_schedule_runtime_node_receipt_retention()] loop
		if v ->> 'scheduled' is distinct from 'true' then raise exception 'A job was not scheduled: %', v; end if;
	end loop;
	select jsonb_object_agg(jobname, schedule) into v_jobs from cron.job where jobname in ('qorpera-folder-follow-ups',
		'qorpera-folder-erasure', 'qorpera-runtime-node-receipts-retention');
	if v_jobs is distinct from '{"qorpera-folder-follow-ups": "10 seconds", "qorpera-folder-erasure": "30 seconds",
			"qorpera-runtime-node-receipts-retention": "2 * * * *"}'::jsonb then
		raise exception 'The schedules: %', v_jobs; end if;
	-- The cleanup clears every qorpera job's runs older than a day at once, and no other job's.
	insert into cron.job_run_details(jobid, end_time)
	select j.jobid, now() - age from cron.job j, unnest(array[interval '2 days', interval '1 hour']) age
	where j.jobname = 'qorpera-folder-erasure';
	perform cron.schedule('another-extension-job', '* * * * *', 'select 1');
	insert into cron.job_run_details(jobid, end_time)
	select jobid, now() - interval '2 days' from cron.job where jobname = 'another-extension-job';
	v_cleanup := public.qorpera_schedule_cron_run_log_cleanup();
	if v_cleanup ->> 'scheduled' is distinct from 'true' or (v_cleanup ->> 'cleared')::bigint <> 1
			or public.qorpera_schedule_cron_run_log_cleanup() -> 'jobId' is distinct from v_cleanup -> 'jobId'
			or (select schedule from cron.job where jobname = 'qorpera-cron-run-log') is distinct from '41 3 * * *'
			or (select count(*) from cron.job_run_details d join cron.job j using (jobid)
				where j.jobname = 'qorpera-folder-erasure') <> 1
			or (select count(*) from cron.job_run_details d join cron.job j using (jobid)
				where j.jobname = 'another-extension-job') <> 1 then
		raise exception 'The run log cleanup: %', v_cleanup; end if;
	-- Its command, as its owner with no JWT, does the same.
	insert into cron.job_run_details(jobid, end_time)
	select jobid, now() - interval '3 days' from cron.job where jobname = 'qorpera-folder-follow-ups';
	perform set_config('request.jwt.claims', '', true);
	execute (select command from cron.job where jobname = 'qorpera-cron-run-log');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if (select count(*) from cron.job_run_details d join cron.job j using (jobid) where j.jobname = 'qorpera-folder-follow-ups') <> 0
			or (select count(*) from cron.job_run_details) <> 2 then
		raise exception 'The cleanup job''s command did not clear the old run'; end if;
end
$$;

rollback;
