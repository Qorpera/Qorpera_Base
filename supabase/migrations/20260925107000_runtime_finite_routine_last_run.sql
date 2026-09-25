-- Review 2026-09-25, finding 1: a finite routine's last run was cancelled.
--
-- The occurrence that reaches max_occurrences expires its routine in the same
-- insert (qorpera_routine_occurrence_recorded), and wake authorization required
-- an ACTIVE routine, so admission cancelled that occurrence with no run. A
-- one-time routine never ran and every finite routine lost its last run.
--
-- Expiry closes FUTURE scheduling only. The scheduler lists active routines
-- only, schedule admission (qorpera_enqueue_routine_wake) admits occurrences for
-- active routines only, and the lifecycle trigger refuses a slot past the limit
-- or the expiry instant. An occurrence queued before a routine that was running
-- normally reached its end still starts, and its run reads its wake and
-- completes, even when a company pause or missing capacity holds it past the
-- end: it is not dropped.
--
-- A stop still stops. A routine remembers whether it expired while active; one
-- that was paused when it expired (by its agent, a member, the authorization-
-- failure suspension, or its agent's archiving) runs nothing more, and its queued
-- occurrences are cancelled at that moment. A removal retires the routine, which
-- is never authorized. Archiving an agent also stops its already-ended routines,
-- so a restore does not revive their last run (active ones stay paused).
--
-- The same rule covers a new version. An edit applies to the next run: a queued
-- occurrence of an older version is still refused, but a run that has started
-- keeps the version it started with while its job is live and the routine
-- still belongs to the same agent (a member may move a routine to another
-- agent, which stops the old agent's run as before). Before this, a
-- routine run that saved its own routine (the "start dense, then upsert the
-- steady cadence" guidance) lost its authority inside that very call, whose
-- receipt re-checks the run, so the save rolled back with "Admitted wake
-- authority is unavailable". Work that continues after the job ended (a
-- Company Computer start continuation) follows the current version again.

create function pg_temp.finite_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Finite routine patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

alter table public.qorpera_cloud_routines
	add column expired_while_active boolean not null default false,
	add constraint qorpera_cloud_routines_expired_while_active check (not expired_while_active or status = 'expired');
-- Routines that expired before this migration keep today's behaviour: their
-- queued occurrences are refused.

create function public.qorpera_routine_expiry_origin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.status = 'expired' and old.status is distinct from 'expired' then
		new.expired_while_active := old.status = 'active';
	elsif new.status <> 'expired' then
		new.expired_while_active := false;
	end if;
	return new;
end
$$;
create trigger qorpera_cloud_routine_expiry_origin before update of status on public.qorpera_cloud_routines
	for each row execute function public.qorpera_routine_expiry_origin();

-- Archiving an agent pauses its active routines (qorpera_project_company_agent_document);
-- its ended ones stop here, on any path that archives the staff row.
create function public.qorpera_routine_stops_with_agent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_cloud_routines routine set expired_while_active = false
	where routine.profile_id = new.profile_id and routine.status = 'expired' and routine.expired_while_active
		and exists (select 1 from public.qorpera_cloud_routine_versions version
			where version.routine_id = routine.id and version.version = routine.current_version
				and version.staff_agent_id = new.staff_agent_id);
	return null;
end
$$;
create trigger qorpera_profile_staff_routines_stop after update of employment_status on public.qorpera_profile_staff
	for each row when (old.employment_status = 'active' and new.employment_status is distinct from 'active')
	execute function public.qorpera_routine_stops_with_agent();

-- A run whose job is still queued or leased: the one work an edit does not revoke.
create function public.qorpera_wake_run_live(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_run_id is not null and exists (select 1 from public.qorpera_execution_runs run
		join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = p_run_id and job.status in ('queued','leased'))
$$;

select pg_temp.finite_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$			on v.routine_id = r.id and v.version = r.current_version
		where r.id = p_wake.routine_id and r.status = 'active' and v.version = p_wake.routine_version$old$,
	$new$			on v.routine_id = r.id and (v.version = r.current_version or (public.qorpera_wake_run_live(p_wake.run_id)
				and exists (select 1 from public.qorpera_cloud_routine_versions cur where cur.routine_id = r.id
					and cur.version = r.current_version and cur.staff_agent_id = v.staff_agent_id)))
		where r.id = p_wake.routine_id and (r.status = 'active' or (r.status = 'expired' and r.expired_while_active))
			and v.version = p_wake.routine_version$new$);

create function public.qorpera_routine_expired_while_paused()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
		blocked_reason = 'Routine expired while paused'
	where routine_id = new.id and wake_kind = 'routine' and status = 'queued';
	return null;
end
$$;
create trigger qorpera_cloud_routine_expired_while_paused after update of status on public.qorpera_cloud_routines
	for each row when (old.status = 'paused' and new.status = 'expired')
	execute function public.qorpera_routine_expired_while_paused();

revoke all on function public.qorpera_routine_expired_while_paused()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_routine_expiry_origin()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_routine_stops_with_agent()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_wake_run_live(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
