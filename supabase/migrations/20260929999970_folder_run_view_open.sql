-- F3, the server-side folder search (deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Server-side search"): the native
-- host opens its run's own folder view, through G2's native host entry point. Founder decision "Light threads"
-- (2 October 2026): a chat turn has no shell, and agents search the folder on the node's folder service with the run's
-- own view, so a folder shared with only some agents is there exactly for them.
--
-- qorpera_folder_run_view_open(p_environment_id, p_actor) opens the view of kind run_box with the run actor as its
-- opener (qorpera_folder_view_open's own run_box path) and returns {schema, viewId, pass, leaseUntil}. The node's
-- folder service renews it while it serves it (qorpera_folder_view_renew, by its pass); the run's completion closes
-- it. A second open in the same job (a native host that started again) first closes this job's open run view as
-- superseded, so the one-open-run-box index never refuses it, and the folder service's renew of the old one answers
-- closed.
--
-- G2: listed in qorpera_native_host_calls with scope folder (p_environment_id and p_actor must be this job's run).
-- The release that goes with each answer is qorpera_folder_record_release with the run actor, already listed (P8 in
-- the folder service design: only a run's own releases can be cited).
--
-- Authorization before lock: the actor's shape and its leased job are checked with plain reads first. Locks, in the
-- order of the run's completion (20260928279600, C1B §4): the job (KEY SHARE), then this job's open run views (FOR
-- UPDATE, in id order), then qorpera_folder_view_open's run entry (pause, the job again, the fence, the principals).
-- No new lock target.

set local lock_timeout = '3s';

create function public.qorpera_folder_run_view_open(p_environment_id uuid, p_actor jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'run'
		or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
			where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;
	-- The run's leased job, read plainly before any lock; qorpera_folder_view_open checks it again under its locks.
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = (p_actor ->> 'jobId')::uuid
			and j.run_id = (p_actor ->> 'runId')::uuid and j.environment_id = p_environment_id and j.status = 'leased'
			and j.runner_id = (p_actor ->> 'runnerId')::uuid and j.client_lease_id = (p_actor ->> 'assignmentId')::uuid
			and j.lease_expires_at > clock_timestamp()) then
		raise exception 'Folder run is not current' using errcode = '42501'; end if;
	perform 1 from public.qorpera_runner_jobs where id = (p_actor ->> 'jobId')::uuid for key share;
	perform 1 from public.qorpera_folder_views where kind = 'run_box' and job_id = (p_actor ->> 'jobId')::uuid and state = 'open'
	order by id for update;
	update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'superseded'
	where kind = 'run_box' and job_id = (p_actor ->> 'jobId')::uuid and state = 'open';
	return public.qorpera_folder_view_open(p_environment_id, p_actor, 'run_box', '{}'::jsonb);
end $$;

revoke all on function public.qorpera_folder_run_view_open(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_run_view_open(uuid, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_folder_run_view_open', 'folder');
