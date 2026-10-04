-- 20260930040000: a run keeps the Company Computer awake only while it is in use (the 2026-10-03 amendment "one idle
-- rule for every machine", item 1). Folder-v2 only by the founder's decision of 3 October: the demand function is
-- shared by both cores and gets no snapshot-v1 branch.
-- - A run is in use while its job is leased and it made progress within qorpera_run_stall_minutes() (gap 4's clock:
--   qorpera_run_no_progress_since is null), or while a model request is in flight. A computer action still running
--   keeps the computer awake on its own: its resources are not yet drained.
-- - A model request is in flight from its context view until the run records anything else. The run's own records
--   arrive in order, so: the newest of them that is not a "writing" pulse is the request's result fence (recorded
--   around its context view), or the newest of all is a pulse of its reply. A long single request never makes a run
--   idle. The exception ends at the latest two hours after the request's context view (durable, written before every
--   request; the longest real requests take well under an hour), or at any durable receipt the run writes after that
--   view: so a harness that hangs inside a request, or lost diagnostics after a tool call, hold the computer at most
--   two hours, and then the run counts by its progress clock alone (the coordinator, 4 October 2026). These are
--   diagnostic records: if they are lost, a request counts only through its context view, for
--   qorpera_run_stall_minutes().
-- - qorpera_runtime_office_has_demand counts a leased run of an agent with access, and an agent run's screen lease,
--   only while that run is in use. A queued run still counts (its job start is its first progress), as do runs and
--   requests waiting for the computer to start.
-- - The seat (qorpera_runtime_office_screen_in_use) is unchanged: an idle run's lease keeps its seat, so its desktop
--   is not handed to another agent, but the computer may sleep.

-- Whether a run's model request is in flight, from its newest records (at most 400, as gap 4's clock reads them),
-- within two hours of the request's context view and before any receipt the run wrote after it.
create function public.qorpera_run_model_request_in_flight(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select view.created_at > clock_timestamp() - interval '2 hours'
			and not exists (select 1 from public.qorpera_run_operation_receipts receipt
				where receipt.run_id = p_run_id and receipt.created_at > view.created_at)
		from public.qorpera_native_context_views view where view.run_id = p_run_id order by view.ordinal desc limit 1), false)
	and (coalesce((select newest.operation = 'message_composition'
			from public.qorpera_runtime_observations newest where newest.run_id = p_run_id
			order by newest.id desc limit 1), false)
		or coalesce((select recent.operation = 'native_result_fence'
			from (select observation.id, observation.operation from public.qorpera_runtime_observations observation
				where observation.run_id = p_run_id order by observation.id desc limit 400) recent
			where recent.operation <> 'message_composition' order by recent.id desc limit 1), false))
$$;
revoke all on function public.qorpera_run_model_request_in_flight(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether a run holding or using a computer is in use (20260930040000).
create function public.qorpera_office_run_in_use(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = p_run_id and job.status = 'leased'
			and (public.qorpera_run_no_progress_since(run.id, job.started_at) is null
				or public.qorpera_run_model_request_in_flight(run.id)))
$$;
revoke all on function public.qorpera_office_run_in_use(uuid) from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.office_runs_in_use_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Office runs-in-use integration differs: %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;
select pg_temp.office_runs_in_use_patch('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure,
	$old$and (s.drain_pending or s.takeover_user_id is not null or s.lease_id is not null))$old$,
	$new$and (s.drain_pending or s.takeover_user_id is not null
				-- An agent run's lease counts while the run is in use (20260930040000).
				or (s.lease_id is not null and public.qorpera_office_run_in_use(s.run_id))))$new$);
select pg_temp.office_runs_in_use_patch('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure,
	$old$e.audience_user_id is null and j.status in ('queued','leased')$old$,
	$new$e.audience_user_id is null
			-- A queued turn counts; a leased one while it is in use (20260930040000).
			and (j.status = 'queued' or (j.status = 'leased' and public.qorpera_office_run_in_use(e.id)))$new$);

-- The demand function may have a private owner in production.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid = 'public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure;
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'Office demand function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant execute on function public.qorpera_office_run_in_use(uuid) to %I', v_owner);
	end if;
end $$;
