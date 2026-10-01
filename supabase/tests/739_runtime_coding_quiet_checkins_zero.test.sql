-- @fixture 655_runtime_coding_quiet_checkins.test.sql until "-- 1. A day without a turn: the agent is asked once, in the shape of a report it already reads."
-- Quiet coding check-ins and computer hours (20260928349870): a company at zero is not asked. Its
-- mark stays unasked and the thread says nothing; once hours are added (before the next sweep),
-- the next scan asks the latest mark reached, with the right day count. Archiving the session withdraws
-- a question about it that no run has taken yet.

-- As 655 step 1: the agent's run ends, its report reaches it, and that continuation ends.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send');
begin
	perform pg_temp.finish_job(v_worker.steering_run_id, 'failed');
	perform public.qorpera_drain_worker_wakes(32);
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send')).completion_state = 'delivered', 'The report reached the agent');
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
	where id = (pg_temp.worker_row('fix-send')).completion_occurrence_id;
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '26 hours', busy_at = null
	where worker_id = v_worker.id;
end
$$;

-- The company uses more than its free hours, live, with the zero rule on; the sweep records it.
reset role;
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ((pg_temp.worker_row('fix-send')).profile_id, clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero');
select pg_temp.path_claims('service_role');

-- 1. At zero: a day, then three days without a turn, and nobody is asked; the session records no mark and
--    the thread says nothing.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send');
begin
	perform pg_temp.wake_assert(pg_temp.ask() = 0 and not exists (select 1 from pg_temp.asks(v_worker.id)), 'Not asked at zero after a day');
	perform pg_temp.pass(v_worker.id, interval '2 days');
	perform pg_temp.wake_assert(pg_temp.ask() = 0 and not exists (select 1 from pg_temp.asks(v_worker.id)), 'Not asked at zero after three days');
	perform pg_temp.wake_assert((pg_temp.session_row('fix-send')).quiet_asked_days is null
		and not exists (select 1 from public.qorpera_coding_session_events where worker_id = v_worker.id and kind = 'step'
			and actor = 'kernel' and body ? 'quietDays'),
		'No mark recorded, nothing in the thread');
end
$$;

-- 2. Hours are added: the next scan asks the latest mark reached, three days, with the right day count.
reset role;
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', (pg_temp.worker_row('fix-send')).profile_id, '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
select pg_temp.path_claims('service_role');
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.wake_assert(pg_temp.ask() = 1, 'Hours added: asked');
	select * into strict v_wake from pg_temp.asks(v_worker.id);
	perform pg_temp.wake_assert(v_wake.status = 'queued' and v_wake.occurrence_key like '%:3'
		and v_wake.payload #>> '{completions,0,summary}' like '%has had no turn for 3 days%',
		'Only the latest mark, with its day count: ' || v_wake.occurrence_key);
	perform pg_temp.wake_assert((pg_temp.session_row('fix-send')).quiet_asked_days = 3
		and exists (select 1 from public.qorpera_coding_session_events where worker_id = v_worker.id and kind = 'step' and actor = 'kernel'
			and body ->> 'text' = 'Quiet for 3 days; asked the agent whether it can be archived'),
		'The thread tells it now, with the right days');
end
$$;

-- 3. The question still waits (as it would, held at zero) when the session is archived (here as the 30-day scan
--    does, by the kernel): it is withdrawn and never runs for the archived session.
reset role;
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.wake_assert(public.qorpera_archive_coding_worker(v_worker, 'kernel', null, null), 'Archived');
	select * into strict v_wake from pg_temp.asks(v_worker.id);
	perform pg_temp.wake_assert(v_wake.status = 'cancelled' and v_wake.finished_at is not null and v_wake.run_id is null,
		'The waiting question went with the archive: ' || v_wake.status);
end
$$;
rollback;
