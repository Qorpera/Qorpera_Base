-- 20260930703000: a run in Agent notebooks mode waits at its login's usage limit too, and goes on by itself at the reset
-- (founder, 9 Nov 2026: make "Work will go on by itself when it resets" true, not change the words).
--
-- The rule is 20260930575000's (5 Nov): work at a usage limit waits on its same login and goes on by itself once the
-- limit resets; nothing moves to another login by itself. Yet most runs never waited. 20260930539000 (G1 b) let a run in
-- Agent notebooks mode (no run log) resume from its own receipts after a cut-off, and kept "today's path" for a usage
-- limit: such a run ended there, failed and waiting for review. That PR was scoped to cut-offs (its brief asked for no
-- more) and gave no other reason; the resume itself already serves a pause (qorpera_memory_run_resume_of answers
-- 'limit_reset' for a run_paused event, and the runtime composes a receipts resume for either reason), a pause is not an
-- attempt, its queue time counts from the reset, and a run's deadline is a century. On 9 Nov the founder's Engineering
-- worker stopped this way while the notice said its work would go on by itself (about 7 days).
-- * A run that resumes from its receipts now pauses at its login's usage limit as a run with a log does
--   (qorpera_resume_run_from_log): its job waits queued for the reset (6 hours without one), on the same login, and
--   qorpera_release_paused_runs_with_room or the reset brings it back; the next attempt is told its receipts. A run that
--   cannot resume still stops as before: a narrow run, one that already sent its final answer, a coding session's turn,
--   a run in tree mode with no log, one out of attempts or with an unsettled step.
-- * While it waits, the run holds its conversation (one run at a time, 20260930538000), as a paused run with a log does.
--   The member whose own login pays for it may move it, by their own pick, to another of their logins that can pay now
--   (qorpera_move_paused_run): never onto or off a ChatGPT plan, never from a login that may work while they are away
--   onto one that may not, never a routine's run (its routine names its payer), only on the run's own computer
--   identity. The run, its wake and its reservation move together and the move is recorded
--   (qorpera_execution_run_payer_moves); the wake's identity guard admits exactly that recorded move, as it admits a
--   recorded sponsor handoff. The run then goes on at once from its receipts or log on the chosen login, so it never
--   also comes back later on the old one.
-- * The agents' activity says when a run waits for a usage limit, until when, whose login pays and whether its member may
--   move it (paused_until, sponsor_binding_id, requested_by_user_id, paid_by_chatgpt_plan, paid_while_away, movable), so
--   the thread can say so and offer the move only where it can be made.
-- * A worker whose run still stops at a usage limit tells its agent that the work stopped and does not go on by itself
--   (qorpera_worker_usage_limit_text); the usage-limit notice says whether its run stopped (run_stopped).
-- Locks: the move takes the job FOR UPDATE, then the run, the wake, the reservation and the target connection, in the
-- order the materializer and the reservation take them; the reads add none. Every new or changed body carries the
-- marker 20260930703000.

set local lock_timeout = '3s';

do $$
begin
	if to_regprocedure('public.qorpera_move_paused_run(uuid,uuid)') is not null then
		raise exception '20260930703000 is already applied'; end if;
	if to_regprocedure('public.qorpera_release_paused_runs_with_room(uuid)') is null
		or to_regprocedure('public.qorpera_run_resumes_from_receipts(uuid)') is null then
		raise exception '20260930703000 needs 20260930539000 and 20260930575000'; end if;
end $$;

create function pg_temp.np703_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930703000' in v_definition) > 0 then
		raise exception '20260930703000 is already in %', p_target; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930703000 anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A run that resumes from its receipts pauses ------------------------------------------------------------------------

select pg_temp.np703_patch('public.qorpera_resume_run_from_log(uuid,text,boolean)'::regprocedure,
	E'\t\t-- 20260930539000 (G1 b): a run that resumes from its receipts never pauses; at its usage limit it ends as before.\n'
	|| E'\t\tif public.qorpera_run_resumes_from_receipts(v_run.id) then return null; end if;\n',
	E'\t\t-- 20260930703000: a run that resumes from its receipts pauses too, on the same login, and goes on from them at the\n'
	|| E'\t\t-- reset (20260930539000 ended it here).\n');

-- 2. Whether a run waits for a usage limit --------------------------------------------------------------------------------

-- The reset a run waits for at its login's usage limit, while that pause is in force (its job is queued and deferred to
-- the time its newest pause named); else null. A cut-off or a handoff after the pause, or a release, ends it.
create function public.qorpera_run_usage_pause(p_run_id uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
	-- 20260930703000
	select job.dispatch_deferred_until
	from public.qorpera_execution_runs as run
	join public.qorpera_runner_jobs as job on job.id = run.job_id and job.run_id = run.id
	cross join lateral (select event.event_type, event.payload from public.qorpera_execution_run_events as event
		where event.run_id = run.id and event.event_type in ('run_cut_off', 'run_paused', 'sponsor_handoff')
		order by event.id desc limit 1) as last_event
	where run.id = p_run_id and job.status = 'queued' and job.dispatch_deferred_until > clock_timestamp()
		and last_event.event_type = 'run_paused' and last_event.payload ->> 'schema' = 'qorpera.run-resume/v1'
		and (last_event.payload ->> 'resetsAt')::timestamptz = job.dispatch_deferred_until
$$;

-- What the agents' activity says of a run waiting for a usage limit: until when, the login (binding) that pays, the member
-- it was started for, whether a ChatGPT plan pays, whether its login may work while that member is away, and whether its
-- member may move it at all (qorpera_move_paused_run's own conditions on the run: a member's login, no routine's run,
-- one that still resumes). Empty for any other run.
create function public.qorpera_run_usage_pause_json(p_run_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	-- 20260930703000
	select coalesce((select jsonb_build_object('paused_until', pause.until, 'sponsor_binding_id', run.sponsor_binding_id,
			'requested_by_user_id', run.requested_by_user_id, 'paid_by_chatgpt_plan', plan.paid,
			'paid_while_away', sponsor.allow_autonomous,
			'movable', sponsor.sponsor_kind = 'member_connection' and not plan.paid
				and exists (select 1 from public.qorpera_wake_occurrences as wake where wake.run_id = run.id
					and wake.wake_kind <> 'routine' and wake.sponsor_binding_id = run.sponsor_binding_id
					and wake.sponsor_version = run.sponsor_version)
				and public.qorpera_run_resumes_from_log(run.id))
		from public.qorpera_execution_runs as run
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = run.sponsor_binding_id
			and sponsor.version = run.sponsor_version
		cross join lateral (select public.qorpera_run_usage_pause(run.id) as until) as pause
		cross join lateral (select public.qorpera_sponsor_version_is_chatgpt_plan(run.sponsor_binding_id, run.sponsor_version)
			as paid) as plan
		where run.id = p_run_id and pause.until is not null), '{}'::jsonb)
$$;

revoke all on function public.qorpera_run_usage_pause(uuid), public.qorpera_run_usage_pause_json(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.np703_patch('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
	E'\t\t|| case when activity.superseded then jsonb_build_object(''superseded'', true) else ''{}''::jsonb end\n',
	E'\t\t|| case when activity.superseded then jsonb_build_object(''superseded'', true) else ''{}''::jsonb end\n'
	|| E'\t\t-- 20260930703000: a run waiting for its login''s usage limit says until when, and whose login pays.\n'
	|| E'\t\t|| case when activity.job_status = ''queued'' then public.qorpera_run_usage_pause_json(activity.run_id)\n'
	|| E'\t\t\telse ''{}''::jsonb end\n');

-- 3. The member's own move of a waiting run ------------------------------------------------------------------------------

-- Each move of a waiting run to another login, by the member whose login paid. The wake's identity guard admits a sponsor
-- change only with the matching row of the same transaction.
create table public.qorpera_execution_run_payer_moves (
	id uuid primary key default extensions.gen_random_uuid(),
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	job_id uuid not null,
	profile_id uuid not null,
	from_binding_id uuid not null,
	from_version bigint not null,
	from_connection_id uuid not null,
	to_binding_id uuid not null,
	to_version bigint not null,
	to_connection_id uuid not null,
	moved_by_user_id uuid not null,
	created_at timestamptz not null default now(),
	check (from_connection_id <> to_connection_id)
);
create index qorpera_execution_run_payer_moves_run on public.qorpera_execution_run_payer_moves(run_id, created_at);
alter table public.qorpera_execution_run_payer_moves enable row level security;
revoke all on public.qorpera_execution_run_payer_moves from public, anon, authenticated, service_role;
grant select on public.qorpera_execution_run_payer_moves to service_role;
comment on table public.qorpera_execution_run_payer_moves is
	'20260930703000: a run waiting at its login''s usage limit, moved by the member whose login paid to another of theirs.';

select pg_temp.np703_patch('public.qorpera_guard_wake_identity()'::regprocedure,
	E'begin\n\t-- A recorded sponsor handoff on the wake''s run is the only admitted identity move (contract 17).\n',
	E'begin\n'
	|| E'\t-- 20260930703000: the member''s own recorded move of their waiting run (qorpera_move_paused_run) moves its wake\n'
	|| E'\t-- with it, in the same transaction; nothing else about the wake changes.\n'
	|| E'\tif new.run_id is not null and new.run_id = old.run_id\n'
	|| E'\t\tand (new.sponsor_binding_id, new.sponsor_version) is distinct from (old.sponsor_binding_id, old.sponsor_version)\n'
	|| E'\t\tand (to_jsonb(new) - array[''sponsor_binding_id'', ''sponsor_version''])\n'
	|| E'\t\t\t= (to_jsonb(old) - array[''sponsor_binding_id'', ''sponsor_version''])\n'
	|| E'\t\tand exists (select 1 from public.qorpera_execution_run_payer_moves as move\n'
	|| E'\t\t\twhere move.run_id = new.run_id and move.created_at = now()\n'
	|| E'\t\t\t\tand move.from_binding_id = old.sponsor_binding_id and move.from_version = old.sponsor_version\n'
	|| E'\t\t\t\tand move.to_binding_id = new.sponsor_binding_id and move.to_version = new.sponsor_version) then\n'
	|| E'\t\treturn new; end if;\n'
	|| E'\t-- A recorded sponsor handoff on the wake''s run is the only admitted identity move (contract 17).\n');

-- The member whose own login pays for a run waiting at its usage limit moves it to another of their logins that can pay
-- now, and it goes on there at once. Answers {schema, runId, connectionId}.
create function public.qorpera_move_paused_run(p_run_id uuid, p_connection_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_from public.qorpera_execution_sponsor_versions%rowtype;
	v_to_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_to record;
	v_pause public.qorpera_execution_run_events%rowtype;
	v_reservation public.qorpera_execution_sponsor_reservations%rowtype;
	v_active integer;
	v_now timestamptz;
begin
	-- 20260930703000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_run_id is null or p_connection_id is null then
		raise exception 'Waiting work is unavailable' using errcode = '42501'; end if;
	-- The job before the run, as everywhere; one answer for a run that is not there or not the caller's company's.
	perform 1 from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.id = job.run_id and run.job_id = job.id
	where run.id = p_run_id and public.qorpera_can_write_profile(run.profile_id)
	for update of job;
	if not found then raise exception 'Waiting work is unavailable' using errcode = '42501'; end if;
	select * into strict v_run from public.qorpera_execution_runs where id = p_run_id for update;
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	select * into strict v_from from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	-- Only the member whose own login pays for it, for work started for them (a member's login pays for nothing else).
	if v_from.sponsor_kind <> 'member_connection'
		or not exists (select 1 from public.qorpera_provider_connections as connection
			where connection.id = v_from.provider_connection_id and connection.owner_user_id = v_user)
		or coalesce(v_run.requested_by_user_id, v_run.created_by_user_id) is distinct from v_user then
		raise exception 'Only the member whose login pays for this work can move it' using errcode = '42501'; end if;
	if public.qorpera_run_usage_pause(v_run.id) is null then
		raise exception 'This work is not waiting for a usage limit' using errcode = '55000'; end if;
	-- It goes on from where it stopped: a run that can no longer resume (made narrow since) is not moved.
	if not public.qorpera_run_resumes_from_log(v_run.id) then
		raise exception 'This work cannot go on from where it stopped' using errcode = '55000'; end if;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id for update;
	-- A routine's run is paid as its routine says; it is not moved.
	if v_wake.id is null or v_wake.wake_kind = 'routine'
		or v_wake.sponsor_binding_id is distinct from v_run.sponsor_binding_id
		or v_wake.sponsor_version is distinct from v_run.sponsor_version then
		raise exception 'This work cannot move to another login' using errcode = '55000'; end if;
	-- One of the member's own live logins on the run's computer identity, with room now, and not the one that pays.
	select live.connection_id, live.connection_version, live.binding_id, live.sponsor_version, live.compute_identity_id
	into v_to
	from public.qorpera_member_live_account_bindings(v_run.profile_id, v_user) as live
	where live.connection_id = p_connection_id
	order by live.binding_id limit 1;
	if v_to.connection_id is null or v_to.connection_id = v_from.provider_connection_id
		or v_to.compute_identity_id is distinct from v_run.compute_identity_id
		or public.qorpera_native_account_remaining(v_to.connection_id, v_to.connection_version) = 0 then
		raise exception 'This login cannot pay for this work now' using errcode = '22023'; end if;
	select * into strict v_to_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_to.binding_id and version = v_to.sponsor_version;
	-- Never onto or off a ChatGPT plan (20260928359950), never from a login that may work while the member is away onto
	-- one that may not (as 20260930580000 moves a waiting turn).
	if public.qorpera_connection_is_chatgpt_plan(v_from.provider_connection_id)
		or public.qorpera_connection_is_chatgpt_plan(v_to.connection_id)
		or (v_from.allow_autonomous and not v_to_sponsor.allow_autonomous) then
		raise exception 'This login cannot pay for this work now' using errcode = '22023'; end if;
	-- The run's reservation moves with it, within the chosen login's bound on runs at once.
	select * into v_reservation from public.qorpera_execution_sponsor_reservations where run_id = v_run.id for update;
	if found and v_reservation.status = 'reserved' then
		perform 1 from public.qorpera_provider_connections where id = v_to.connection_id for update;
		select count(*) into v_active from public.qorpera_execution_sponsor_reservations as reservation
		where reservation.provider_connection_id = v_to.connection_id and reservation.status = 'reserved';
		if v_active >= coalesce((select (version.quota_policy ->> 'max_concurrent_runs')::integer
				from public.qorpera_provider_connection_versions as version
				where version.connection_id = v_to.connection_id and version.version = v_to.connection_version), 0) then
			raise exception 'This login is busy with other work. Try again soon.' using errcode = '55000'; end if;
		update public.qorpera_execution_sponsor_reservations
		set binding_id = v_to.binding_id, sponsor_version = v_to.sponsor_version,
			provider_connection_id = v_to.connection_id, provider_connection_version = v_to.connection_version
		where run_id = v_run.id;
	end if;
	v_now := clock_timestamp();
	insert into public.qorpera_execution_run_payer_moves(run_id, job_id, profile_id, from_binding_id, from_version,
		from_connection_id, to_binding_id, to_version, to_connection_id, moved_by_user_id)
	values (v_run.id, v_job.id, v_run.profile_id, v_run.sponsor_binding_id, v_run.sponsor_version,
		v_from.provider_connection_id, v_to.binding_id, v_to.sponsor_version, v_to.connection_id, v_user);
	update public.qorpera_wake_occurrences set sponsor_binding_id = v_to.binding_id, sponsor_version = v_to.sponsor_version
	where id = v_wake.id;
	update public.qorpera_execution_runs set sponsor_binding_id = v_to.binding_id, sponsor_version = v_to.sponsor_version
	where id = v_run.id;
	-- The pause now names the chosen login, which the next attempt's launch and lease must hold, and ends now.
	select * into strict v_pause from public.qorpera_execution_run_events
	where run_id = v_run.id and event_type = 'run_paused' order by id desc limit 1;
	insert into public.qorpera_execution_run_events(run_id, event_type, payload)
	values (v_run.id, 'run_paused', jsonb_strip_nulls(jsonb_build_object('schema', 'qorpera.run-resume/v1',
		'assignmentId', v_pause.payload ->> 'assignmentId', 'reason', 'moved to another login by its member',
		'sponsorVersion', v_to.sponsor_version, 'providerConnectionId', v_to.connection_id,
		'providerConnectionVersion', v_to.connection_version, 'resetsAt', v_now)));
	update public.qorpera_runner_jobs set dispatch_deferred_until = v_now, queued_at = v_now where id = v_job.id;
	return jsonb_build_object('schema', 'qorpera.paused-run-move/v1', 'runId', v_run.id, 'connectionId', v_to.connection_id);
end
$$;
revoke all on function public.qorpera_move_paused_run(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_move_paused_run(uuid, uuid) to authenticated;

-- 4. What the agent and the notice are told -------------------------------------------------------------------------------

-- A worker's run that still stops at a usage limit could not wait: its words say the work stopped.
select pg_temp.np703_patch('public.qorpera_worker_usage_limit_text(uuid)'::regprocedure,
	E'\t\t|| ''The work does not move to another login by itself. It waits and goes on by itself on this login once the limit ''\n'
	|| E'\t\t|| ''resets (its usage is checked at least once a day). The member can also choose another of their logins for it ''\n'
	|| E'\t\t|| ''(in the conversation''''s Login menu).''\n',
	E'\t\t-- 20260930703000: a run that can resume waits instead; this one could not, so the work stopped.\n'
	|| E'\t\t|| ''This run could not wait for the reset, so the work stopped. It does not go on by itself and does not move to ''\n'
	|| E'\t\t|| ''another login by itself. Start it again to go on: on this login it waits until the limit resets. The member ''\n'
	|| E'\t\t|| ''can also continue it with another of their logins from the agent''''s thread.''\n');

-- A coding session's turn names its own card where those words name the agent's thread.
select pg_temp.np703_patch('public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure,
	E'\t\t\t''choose another of their logins for it (in the conversation''''s Login menu)'',\n',
	E'\t\t\t-- 20260930703000: those words name the agent''''s thread.\n'
	|| E'\t\t\t''continue it with another of their logins from the agent''''s thread'',\n');

-- Whether the run a usage-limit notice names stopped (it failed or was stopped) rather than waits: the notice says so.
create function public.qorpera_usage_limit_notice_run(p_notification public.qorpera_member_notifications)
returns jsonb
language sql stable security definer set search_path = '' as $$
	-- 20260930703000
	select case when p_notification.kind = 'provider_usage_limit'
			and jsonb_typeof(p_notification.subject -> 'runId') = 'string'
			and (p_notification.subject ->> 'runId') ~ '^[0-9a-fA-F-]{36}$'
		then jsonb_build_object('run_stopped', exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.id = (p_notification.subject ->> 'runId')::uuid and run.profile_id = p_notification.profile_id
				and job.status in ('failed', 'cancelled')))
		else '{}'::jsonb end
$$;
revoke all on function public.qorpera_usage_limit_notice_run(public.qorpera_member_notifications)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.np703_patch('public.qorpera_list_member_notifications(uuid,integer)'::regprocedure,
	E'jsonb_agg(public.qorpera_member_notification_json(notification)\n',
	E'jsonb_agg(public.qorpera_member_notification_json(notification)\n'
	|| E'\t\t-- 20260930703000: a usage-limit notice says whether its run stopped.\n'
	|| E'\t\t|| public.qorpera_usage_limit_notice_run(notification)\n');

-- 5. The deploy guard -----------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_resume_run_from_log(uuid,text,boolean)', 'public.qorpera_run_usage_pause(uuid)',
		'public.qorpera_run_usage_pause_json(uuid)', 'public.qorpera_list_staff_execution_activity(uuid)',
		'public.qorpera_guard_wake_identity()', 'public.qorpera_move_paused_run(uuid,uuid)',
		'public.qorpera_worker_usage_limit_text(uuid)',
		'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)',
		'public.qorpera_usage_limit_notice_run(public.qorpera_member_notifications)',
		'public.qorpera_list_member_notifications(uuid,integer)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930703000') = 0 then
			raise exception '20260930703000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_resume_run_from_log(uuid,text,boolean)'::regprocedure),
		'qorpera_run_resumes_from_receipts') > 0 then
		raise exception '20260930703000: a run that resumes from its receipts still never pauses'; end if;
end $guard$;

drop function pg_temp.np703_patch(regprocedure, text, text);
