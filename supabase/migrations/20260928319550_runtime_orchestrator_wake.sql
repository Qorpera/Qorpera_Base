-- Push wake-ups for runner orchestrators (audit fix #13, 29 Sep 2026).
--
-- An idle orchestrator asks for work every 250 ms through the runner-orchestrator Edge Function: about
-- 240 claims a minute, each two RPCs and a full reconcile. The orchestrator can now join a private
-- Realtime topic and ask for work when this database broadcasts a wake-up, with a slow backstop poll
-- (runner-orchestrator QORPERA_RUNNER_ORCHESTRATOR_WAKE, off unless set).
--
-- Switch: nothing is sent until an operator sets qorpera_orchestrator_wake_settings.enabled (off here).
-- While it is off, each transaction pays once for a subtransaction (no transaction id) with one lookup of
-- that row, and nothing else. The lookup shares the sends' 200 ms budget below, and a switch that cannot be
-- read in time, or at all, counts as off.
--
-- Topic: 'qorpera-orchestrator-wake-' || hex(sha256('qorpera.orchestrator-wake/v1:' || control_token_sha256)).
-- Only this database keeps the control token's sha256, and the orchestrator computes it from its token, so
-- nobody else can name the topic; it moves with every control rotation. The payload names nothing.
--
-- Broadcast: once per transaction, to every active orchestrator whose control token has not expired, when
-- claimable work may have appeared: a runner job inserted or changing status (a finished job can make its
-- session's next input materializable), a session turn request or wake occurrence becoming queued, a session
-- input, or a queued proposal review. Nine AFTER row triggers; a WHEN clause filters rows before the
-- function runs, and after the first send in a transaction the function returns at once. Work that becomes
-- claimable by time or elsewhere sends no wake-up and is found by the orchestrator's poll: an expired
-- placement deferral or claim lease, a node switched back on, a completed sign-in, bought hours, a declared
-- bundle.
--
-- Cost inside the enqueuing transaction: a plain read of the active orchestrators (no row locks), then one
-- realtime.send each, which inserts a row into realtime.messages (Realtime reads it from the WAL after
-- commit; no network call). The switch lookup and all sends together wait at most 200 ms for a lock (on the
-- switch's table, or Realtime's during its partition maintenance), and a missing or failing Realtime is
-- absorbed: a wake-up never fails an enqueue and never holds it up longer than that.
--
-- Reception: the orchestrator joins with the publishable key (the anon role). The policy lets anon read a
-- row only on the topic it joined, and only a wake topic; there is no insert policy, so only the database
-- publishes to them.
set local lock_timeout = '3s';

create table public.qorpera_orchestrator_wake_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false
);
insert into public.qorpera_orchestrator_wake_settings (singleton) values (true);
alter table public.qorpera_orchestrator_wake_settings enable row level security;
revoke all on public.qorpera_orchestrator_wake_settings from public, anon, authenticated;

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
	v_started timestamptz;
	v_left integer;
	v_topic text;
begin
	-- One wake-up per orchestrator per transaction, however many rows change.
	if current_setting('qorpera.runner_orchestrators_woken', true) = 'yes' then
		return null;
	end if;
	perform set_config('qorpera.runner_orchestrators_woken', 'yes', true);
	-- One subtransaction for the switch and all sends, under one 200 ms budget for lock waits. The switch is read
	-- inside it, so a lock on its table (a migration altering it) holds the enqueue up at most 200 ms and counts
	-- as off. realtime.send only inserts a row into realtime.messages, and turns its own failures (a lock timeout
	-- included) into a warning, so each send waits at most what is left of the budget, and none starts once it
	-- is spent. The block also absorbs a missing Realtime.
	v_started := clock_timestamp();
	begin
		perform set_config('lock_timeout', '200ms', true);
		if coalesce((select settings.enabled from public.qorpera_orchestrator_wake_settings as settings), false) then
			for v_topic in
				-- A plain read: no row lock on the orchestrators, so heartbeats and rotation never wait on this.
				select public.qorpera_runner_orchestrator_wake_topic(orchestrator.control_token_sha256)
				from public.qorpera_runner_orchestrators as orchestrator
				where orchestrator.status = 'active' and orchestrator.control_token_expires_at > statement_timestamp()
			loop
				v_left := 200 - floor(extract(epoch from clock_timestamp() - v_started) * 1000)::integer;
				exit when v_left < 1;
				perform set_config('lock_timeout', v_left || 'ms', true);
				perform realtime.send(jsonb_build_object('schema', 'qorpera.orchestrator-wake/v1'), 'wake', v_topic, true);
			end loop;
		end if;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		-- A switch that cannot be read counts as off. Rolling the subtransaction back also restores lock_timeout.
		-- The backstop poll finds the work.
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

-- The orchestrator receives its wake-ups as anon (publishable key): a row only on the wake topic it joined
-- (Realtime's join check sets realtime.topic and reads with it), so no other setting widens what anon sees.
-- Nothing may be published to a wake topic by a client: there is no insert policy.
create policy qorpera_orchestrator_wake_receive
	on realtime.messages
	for select
	to anon
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.messages.topic = (select realtime.topic())
		and realtime.messages.topic ~ '^qorpera-orchestrator-wake-[0-9a-f]{64}$'
	);
