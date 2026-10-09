-- G2-6a: a guest request proves its run's lease (deploy/first-node/RUNTIME-NATIVE-HOST-KEY.md, "G2-6").
--
-- The object gateway and the secret brokers serve a native host's requests on a node-level token (one for every guest)
-- and re-check the request's run binding against the database. The binding is only ids, and the checks behind it read
-- the job's stored lease_token_sha256 themselves (qorpera_native_tool_locked_run), so the node-level token and any
-- live run's ids were enough to act for that run: its objects, its secret operations and account fills, and its model
-- login. Now the caller also proves it holds that run's job lease token, which only the run's own native host has: the
-- holder header `job.<job id>.<lease token>` (NativeHostDispatch.holderHeader), checked here as qorpera_native_host_call
-- checks the token (20260928409985): the job by its primary key, leased, an agent turn, the lease unexpired, the token's
-- hash; and the binding's job and run are that job and its run.
--
-- A gate before the server's own call, not a replacement: the locked functions behind each request still check the
-- run and its lease under their locks, so a lease that ends between the proof and the work is still refused. Stable,
-- so it cannot take a row lock (Postgres refuses FOR UPDATE and FOR SHARE in a non-volatile function), and a refused
-- request waits for nothing. Only the servers may call it: the object gateway (service_role) and the brokers
-- (qorpera_secret_broker). Every refusal is the same 42501, and nothing of the header appears in it.
set local lock_timeout = '3s';

create function public.qorpera_native_binding_proven(p_binding jsonb, p_holder text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_job public.qorpera_runner_jobs%rowtype;
begin
	if jsonb_typeof(p_binding) is distinct from 'object' or p_holder is null
		or p_holder !~ '^job\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$'
		or lower(p_binding ->> 'jobId') is distinct from split_part(p_holder, '.', 2) then
		raise exception 'native binding proof is refused' using errcode = '42501'; end if;
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = split_part(p_holder, '.', 2)::uuid;
	if not found or v_job.status <> 'leased' or v_job.job_type <> 'agent_turn' or v_job.required_capability <> 'agent_turn'
		or v_job.run_id is null or v_job.lease_token_sha256 is null
		or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp()
		or v_job.lease_token_sha256 <> encode(extensions.digest(convert_to(split_part(p_holder, '.', 3), 'utf8'), 'sha256'), 'hex')
		or v_job.run_id::text is distinct from lower(p_binding ->> 'runId') then
		raise exception 'native binding proof is refused' using errcode = '42501'; end if;
	return true;
end
$$;
revoke all on function public.qorpera_native_binding_proven(jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_native_binding_proven(jsonb, text) to service_role, qorpera_secret_broker;
