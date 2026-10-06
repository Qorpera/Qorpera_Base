-- The founding table's firstRun before the follow-up queue has converged the Co-Founder (after P15, 20260930022000).
--
-- Since P15 the creation commit no longer queues the Co-Founder's turn request: the follow-up queue does, in the same
-- transaction that makes the company ready (qorpera_folder_company_ready). In the seconds between the two the request is
-- missing, so firstRun read `waiting_for_login` for an author who has a login. It now reads `queued` while the company is
-- not ready yet; once it is ready, a missing request still means no usable login (or the author left), as before. The web
-- reads firstRun only once the company is ready, so this changes what the table's JSON says, not what a member sees.
-- The body carries this migration's id (20260930067000), for the deploy guard.

set local lock_timeout = '3s';

create or replace function public.qorpera_folder_company_first_run_state(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930039000: L2. 20260930067000: queued until the follow-up queue has converged the Co-Founder.
	select case
		when input.completed_at is not null or input.execution_run_id is not null then 'started'
		when input.failed_at is not null or request.status = 'failed' then 'failed'
		when request.status = 'queued' then 'queued'
		when request.id is null and not public.qorpera_folder_company_ready(p_profile_id) then 'queued'
		when request.id is null then 'waiting_for_login'
		else 'failed' end
	from public.qorpera_folder_company_creations as creation
	join public.qorpera_agent_first_runs as first_run on first_run.profile_id = creation.profile_id
		and first_run.staff_agent_id = creation.cofounder_id
	join public.qorpera_session_inputs as input on input.id = first_run.input_id
	left join public.qorpera_session_turn_requests as request on request.input_id = input.id
	where creation.profile_id = p_profile_id
$$;
revoke all on function public.qorpera_folder_company_first_run_state(uuid) from public, anon, authenticated, service_role;
