-- Review 2026-09-25, finding 1: a finite routine's last run was cancelled.
--
-- The occurrence that reaches max_occurrences expires its routine in the same
-- insert (qorpera_routine_occurrence_recorded), and wake authorization required
-- an ACTIVE routine, so admission cancelled that occurrence with no run. A
-- one-time routine never ran and every finite routine lost its last run.
--
-- Expiry closes FUTURE scheduling only. The scheduler lists active routines
-- only, schedule admission (qorpera_enqueue_routine_wake) and the file listener
-- drain admit occurrences for active routines only, and the lifecycle trigger
-- refuses a slot past the limit or the expiry instant. So every occurrence of
-- an expired routine was admitted while it was live; authorization now accepts
-- it through materialization, the run's own wake reads and completion.
--
-- A pause and a removal still stop pending work: removal retires the routine
-- (never authorized), and a routine that expires while paused cancels its
-- still-queued occurrences at that moment, as admission would have while the
-- pause held.
--
-- The same rule covers a new version. An edit applies to the next run: a
-- queued occurrence of an older version is still refused at admission, but a
-- run already admitted keeps the version it started with. Before this, a
-- routine run that saved its own routine (the "start dense, then upsert the
-- steady cadence" guidance) lost its authority inside that very call, whose
-- receipt re-checks the run, so the save rolled back with "Admitted wake
-- authority is unavailable".

create function pg_temp.finite_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Finite routine patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.finite_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$			on v.routine_id = r.id and v.version = r.current_version
		where r.id = p_wake.routine_id and r.status = 'active' and v.version = p_wake.routine_version$old$,
	$new$			on v.routine_id = r.id and (v.version = r.current_version or p_wake.run_id is not null)
		where r.id = p_wake.routine_id and r.status in ('active','expired') and v.version = p_wake.routine_version$new$);

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
