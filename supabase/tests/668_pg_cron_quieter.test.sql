-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Fewer pg_cron runs (20260930483000): the follow-up step every 10 seconds, the erasure drain every 30 seconds, node
-- receipt retention hourly, and one daily cleanup of every qorpera job's run log. The follow-up step asks whether a
-- company's follow-ups may run once per company with marks (it asked once per mark). Last, the three jobs' steps are
-- timed with nothing to do, the old follow-up step beside the new one (printed, not checked).

reset role;

-- The follow-up step of 20260928479140, for the comparison.
create function pg_temp.fq_old_step() returns jsonb language plpgsql as $$
declare v_subject record; v_work public.qorpera_folder_follow_ups%rowtype; v_swept bigint := 0;
begin
	perform set_config('lock_timeout', '2s', true);
	if extract(epoch from clock_timestamp())::bigint % 60 < 2 then v_swept := public.qorpera_folder_follow_up_sweep(); end if;
	for v_subject in select m.environment_id, m.subject_kind, m.subject_id from public.qorpera_folder_follow_up_marks m
		where public.qorpera_folder_follow_up_open(m.environment_id)
		group by m.environment_id, m.subject_kind, m.subject_id order by min(m.id) limit 8
	loop
		v_work := public.qorpera_folder_follow_up_take(v_subject.environment_id, v_subject.subject_kind, v_subject.subject_id);
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
		if v_work.subject_id is not null then
			v_work := public.qorpera_folder_follow_up_take(v_work.environment_id, v_work.subject_kind, v_work.subject_id); end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-follow-up-step/v1', 'swept', v_swept,
		'converged', case when v_work.subject_id is not null and v_work.dirty
			then public.qorpera_folder_follow_up_converge(v_work) end);
end $$;
create function pg_temp.fq_open_calls() returns bigint language sql as $$
	select coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = 'qorpera_folder_follow_up_open'), 0)::bigint
$$;

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
	perform set_config('qorpera_test.fq_runs', format('runs a minute: follow-ups 30 -> %s, erasure 12 -> %s, node receipt retention 0.2 -> %s',
		60 / 10, 60 / 30, round(1 / 60.0, 3)), true);
end
$$;
select current_setting('qorpera_test.fq_runs') as fq_runs \gset
\echo 668 schedules: :fq_runs

-- 2. A paused company with 200 marks on 50 subjects: the old step asked whether it may run once per mark (and took
--    nothing); the new step asks once for it, and takes nothing either.
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
select f.profile_id, (select id from auth.users order by created_at limit 1)
from public.qorpera_company_files f where f.environment_id = '92400000-0000-4000-8000-000000000020'
on conflict do nothing;
delete from public.qorpera_folder_follow_up_marks;
insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id)
select '92400000-0000-4000-8000-000000000020', 'agent', s.id
from (select extensions.gen_random_uuid() as id from generate_series(1, 50)) s, generate_series(1, 4);
set local track_functions = 'all';
do $$
declare v_marks bigint; v_envs bigint; v_at bigint; v_old bigint; v_new bigint; v_old_step jsonb; v_new_step jsonb;
begin
	select count(*), count(distinct environment_id) into v_marks, v_envs from public.qorpera_folder_follow_up_marks;
	perform set_config('request.jwt.claims', '', true);
	v_at := pg_temp.fq_open_calls();
	v_old_step := pg_temp.fq_old_step();
	v_old := pg_temp.fq_open_calls() - v_at;
	v_at := pg_temp.fq_open_calls();
	v_new_step := public.qorpera_folder_follow_up_step();
	v_new := pg_temp.fq_open_calls() - v_at;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('qorpera_test.fq_open', format('with %s marks of %s companies: old step %s checks, new step %s',
		v_marks, v_envs, v_old, v_new), true);
	if v_marks <> 200 or v_envs <> 1 or v_old - v_new <> 199 then
		raise exception 'The steps'' company checks are not as expected: %', current_setting('qorpera_test.fq_open'); end if;
	if v_old_step -> 'converged' is distinct from 'null'::jsonb or v_new_step -> 'converged' is distinct from 'null'::jsonb
			or (select count(*) from public.qorpera_folder_follow_up_marks) <> v_marks then
		raise exception 'A paused company''s marks were taken: % / %', v_old_step, v_new_step; end if;
end
$$;
select current_setting('qorpera_test.fq_open') as fq_open \gset
\echo 668 company checks: :fq_open
reset track_functions;

-- 3. The timing with nothing to do (the test marks gone, the company running again): the old and new follow-up steps in
--    turn, the erasure step and a retention run, 20 times each (printed only).
delete from public.qorpera_folder_follow_up_marks where environment_id = '92400000-0000-4000-8000-000000000020';
delete from public.qorpera_company_execution_pauses where profile_id = (select profile_id from public.qorpera_company_files
	where environment_id = '92400000-0000-4000-8000-000000000020');
do $$
declare v_start timestamptz; v_old double precision := 0; v_new double precision := 0; v_erasure double precision := 0;
	v_retention double precision := 0; c_rounds constant integer := 20;
begin
	perform set_config('request.jwt.claims', '', true);
	for i in 1 .. c_rounds loop
		v_start := clock_timestamp();
		perform pg_temp.fq_old_step();
		v_old := v_old + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		perform public.qorpera_folder_follow_up_step();
		v_new := v_new + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		perform public.qorpera_folder_erasure_step();
		v_erasure := v_erasure + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		perform public.qorpera_run_runtime_node_receipt_retention();
		v_retention := v_retention + extract(epoch from clock_timestamp() - v_start);
	end loop;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('qorpera_test.fq_ms', format('follow-up step old %s ms, new %s ms; erasure step %s ms; retention run %s ms (mean of %s each)',
		round((1000 * v_old / c_rounds)::numeric, 2), round((1000 * v_new / c_rounds)::numeric, 2),
		round((1000 * v_erasure / c_rounds)::numeric, 2), round((1000 * v_retention / c_rounds)::numeric, 2), c_rounds), true);
end
$$;
select current_setting('qorpera_test.fq_ms') as fq_ms \gset
\echo 668 timing: :fq_ms

rollback;
