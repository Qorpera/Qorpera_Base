-- Push wake-ups for runner orchestrators (audit fix #13, 29 Sep 2026).
--
-- An idle orchestrator asks for work every 250 ms through the runner-orchestrator Edge Function: about
-- 240 claims a minute, each two RPCs and a full reconcile. The orchestrator can now join a private
-- Realtime topic and ask for work when this database broadcasts a wake-up, with a slow backstop poll
-- (runner-orchestrator QORPERA_RUNNER_ORCHESTRATOR_WAKE, off unless set).
--
-- Topic: 'qorpera-orchestrator-wake-' || hex(sha256('qorpera.orchestrator-wake/v1:' || control_token_sha256)).
-- Only this database keeps the control token's sha256, and the orchestrator computes it from its token, so
-- nobody else can name the topic; it moves with every control rotation. The payload names nothing.
--
-- Broadcast: once per transaction, to every active orchestrator whose control token has not expired, when
-- claimable work may have appeared: a runner job inserted or changing status (a finished job can make its
-- session's next input materializable), a session turn request or wake occurrence becoming queued, a session
-- input, or a queued proposal review. Nine row triggers; a WHEN clause filters rows before the function
-- runs, and after the first send in a transaction the function returns at once. A lost broadcast costs
-- only latency: the orchestrator still polls. The sends never fail the enqueuing transaction and wait at
-- most 200 ms for Realtime's table (see the function); they take no lock on any Qorpera row.
--
-- Reception: the orchestrator joins with the publishable key (the anon role). The policy lets anon read
-- broadcasts on wake topics only; there is no insert policy, so only the database publishes to them.
set local lock_timeout = '3s';

create function public.qorpera_runner_orchestrator_wake_topic(p_control_token_sha256 text)
returns text language sql immutable set search_path = '' as $$
	select 'qorpera-orchestrator-wake-' || encode(pg_catalog.sha256(convert_to(
		'qorpera.orchestrator-wake/v1:' || p_control_token_sha256, 'UTF8')), 'hex')
$$;
revoke all on function public.qorpera_runner_orchestrator_wake_topic(text) from public, anon, authenticated;
grant execute on function public.qorpera_runner_orchestrator_wake_topic(text) to service_role;

create function public.qorpera_wake_runner_orchestrators_internal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_topic text;
begin
	-- One wake-up per orchestrator per transaction, however many rows change.
	if current_setting('qorpera.runner_orchestrators_woken', true) = 'yes' then
		return null;
	end if;
	perform set_config('qorpera.runner_orchestrators_woken', 'yes', true);
	-- One subtransaction for all sends. realtime.send only inserts a row into realtime.messages (Realtime
	-- reads it from the WAL after commit), and turns its own failures into a warning. The block also
	-- absorbs a missing Realtime, and bounds any wait for Realtime's table (its partition maintenance)
	-- to 200 ms: the enqueuing transaction never fails and never waits longer because of a wake-up.
	begin
		perform set_config('lock_timeout', '200ms', true);
		for v_topic in
			-- A plain read: no row lock on the orchestrators, so heartbeats and rotation never wait on this.
			select public.qorpera_runner_orchestrator_wake_topic(orchestrator.control_token_sha256)
			from public.qorpera_runner_orchestrators as orchestrator
			where orchestrator.status = 'active' and orchestrator.control_token_expires_at > statement_timestamp()
		loop
			perform realtime.send(jsonb_build_object('schema', 'qorpera.orchestrator-wake/v1'), 'wake', v_topic, true);
		end loop;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		-- Rolling the subtransaction back also restores lock_timeout. The backstop poll finds the work.
		null;
	end;
	return null;
end
$$;
revoke all on function public.qorpera_wake_runner_orchestrators_internal() from public, anon, authenticated, service_role;

create trigger qorpera_runner_jobs_insert_wake_orchestrators
	after insert on public.qorpera_runner_jobs
	for each row execute function public.qorpera_wake_runner_orchestrators_internal();
create trigger qorpera_runner_jobs_status_wake_orchestrators
	after update of status on public.qorpera_runner_jobs
	for each row when (new.status is distinct from old.status)
	execute function public.qorpera_wake_runner_orchestrators_internal();

create trigger qorpera_session_turn_requests_insert_wake_orchestrators
	after insert on public.qorpera_session_turn_requests
	for each row when (new.status = 'queued')
	execute function public.qorpera_wake_runner_orchestrators_internal();
create trigger qorpera_session_turn_requests_status_wake_orchestrators
	after update of status on public.qorpera_session_turn_requests
	for each row when (new.status = 'queued' and old.status is distinct from 'queued')
	execute function public.qorpera_wake_runner_orchestrators_internal();

create trigger qorpera_session_inputs_insert_wake_orchestrators
	after insert on public.qorpera_session_inputs
	for each row execute function public.qorpera_wake_runner_orchestrators_internal();

create trigger qorpera_wake_occurrences_insert_wake_orchestrators
	after insert on public.qorpera_wake_occurrences
	for each row when (new.status = 'queued')
	execute function public.qorpera_wake_runner_orchestrators_internal();
create trigger qorpera_wake_occurrences_status_wake_orchestrators
	after update of status on public.qorpera_wake_occurrences
	for each row when (new.status = 'queued' and old.status is distinct from 'queued')
	execute function public.qorpera_wake_runner_orchestrators_internal();

create trigger qorpera_proposal_reviews_insert_wake_orchestrators
	after insert on public.qorpera_company_proposal_review_assignments
	for each row when (new.status = 'queued')
	execute function public.qorpera_wake_runner_orchestrators_internal();
create trigger qorpera_proposal_reviews_status_wake_orchestrators
	after update of status on public.qorpera_company_proposal_review_assignments
	for each row when (new.status = 'queued' and old.status is distinct from 'queued')
	execute function public.qorpera_wake_runner_orchestrators_internal();

-- The orchestrator receives its wake-ups as anon (publishable key). Only well-formed wake topics, and
-- nothing may be published to them by a client: there is no insert policy.
create policy qorpera_orchestrator_wake_receive
	on realtime.messages
	for select
	to anon
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.topic() ~ '^qorpera-orchestrator-wake-[0-9a-f]{64}$'
	);
