-- @fixture 627_runtime_coding_session_standby.test.sql until "-- 3. The next turn keeps the generation the guest still holds"
-- Computer hours, build step 6b part 4 (20260928319760): coding at zero, behind coding's own switch.
--   * With the zero rule on but coding's switch off, coding is left as it was: the machine step and
--     begin let a turn through, and the node does not refuse coding machines.
--   * With coding's switch on, a turn not yet begun waits: the machine step refuses it, begin answers
--     a refusal (nothing is written), and the deferral says "Waiting for computer hours", once per wait.
--   * Once the hour is over, the member's machine is due to sleep as soon as no turn holds it.
--   * Once hours are added, the next turn runs, before the next sweep.
-- At this point of 627, fix-send waits at sequence 4 for its next turn, attached to its member's machine,
-- which is awake and not live.
select pg_temp.path_claims('service_role');

create function pg_temp.hc_claim() returns jsonb language plpgsql as $$
declare v_claim jsonb;
begin
	-- The deferral's 15 seconds have passed (the claim keeps claim_after; only the queue, an answer or begin clear it).
	update public.qorpera_coding_sessions set claim_after = case when claim_after is not null then clock_timestamp() - interval '1 second' end
	where worker_id = (pg_temp.worker_row('fix-send')).id;
	v_claim := public.qorpera_claim_coding_session('exec-test', 60);
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = (pg_temp.worker_row('fix-send')).id::text,
		'The executor claims fix-send: ' || coalesce(v_claim::text, 'nothing'));
	perform public.qorpera_plan_coding_machine((pg_temp.worker_row('fix-send')).id, (v_claim ->> 'leaseToken')::uuid, repeat('c', 64));
	return v_claim;
end
$$;
create function pg_temp.hc_authorize(p_claim jsonb) returns jsonb language sql as $$
	select public.qorpera_authorize_coding_machine_run((pg_temp.worker_row('fix-send')).id, (p_claim ->> 'leaseToken')::uuid,
		current_setting('qorpera_test.coding_binding'), pg_temp.storage((pg_temp.worker_row('fix-send')).id), repeat('c', 64))
$$;
create function pg_temp.hc_begin(p_claim jsonb) returns jsonb language sql as $$
	select public.qorpera_begin_coding_turn((pg_temp.worker_row('fix-send')).id, (p_claim ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId', current_setting('qorpera_test.coding_vm'),
			'turnId', public.qorpera_coding_turn_id((pg_temp.worker_row('fix-send')).id, (p_claim ->> 'sequence')::int)))
$$;
create function pg_temp.hc_defer(p_claim jsonb, p_reason text) returns jsonb language sql as $$
	select public.qorpera_defer_coding_session((pg_temp.worker_row('fix-send')).id, (p_claim ->> 'leaseToken')::uuid, p_reason)
$$;
create function pg_temp.hc_steps(p_text text) returns bigint language sql as $$
	select count(*) from public.qorpera_coding_session_events
	where worker_id = (pg_temp.worker_row('fix-send')).id and kind = 'step' and body ->> 'text' = p_text
$$;

-- Coding machines are refused by the node only with coding's switch on.
select pg_temp.wake_assert(position($$and (p_provider_kind<>'coding' or public.qorpera_computer_hour_coding_on(clock_timestamp()))$$
		in pg_get_functiondef('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure)) > 0,
	'The node refusal covers coding machines only with coding''s switch on');
select pg_temp.wake_assert(not has_function_privilege(role_name, fn, 'EXECUTE'), 'Internal: ' || fn || ' for ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_computer_hour_coding_on(timestamptz)', 'public.qorpera_company_coding_at_zero(uuid,timestamptz)',
		'public.qorpera_computer_hour_coding_finish_window_over(uuid,timestamptz)']) fn;

-- The company uses more than its free hours, live, with the zero rule on; the sweep records it.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '1', 'At zero');

-- 1. Coding's switch off: the machine step and begin let the turn through (rolled back afterwards).
do $$
declare v_claim jsonb;
begin
	begin
		perform pg_temp.observe();
		v_claim := pg_temp.hc_claim();
		perform pg_temp.wake_assert(pg_temp.hc_authorize(v_claim) ->> 'intent' = 'run', 'Coding off: the turn gets its machine');
		perform pg_temp.wake_assert(pg_temp.hc_begin(v_claim) ->> 'occurrenceId' is not null, 'Coding off: the turn begins');
		raise sqlstate 'P0T01';
	exception when sqlstate 'P0T01' then null;
	end;
end
$$;

-- 2. Coding's switch on: a turn not yet begun waits, once per wait in the thread.
update public.qorpera_computer_hour_billing set coding_zero_rule_since = clock_timestamp() - interval '1 second';
do $$
declare v_claim jsonb; v_view jsonb; v_begun jsonb;
begin
	perform pg_temp.observe();
	v_claim := pg_temp.hc_claim();
	perform pg_temp.wake_assert(pg_temp.hc_authorize(v_claim) ->> 'reason' = 'COMPUTER_HOURS_EXHAUSTED',
		'The machine step refuses a turn not yet begun, though the machine is awake');
	-- Begin, had the company reached zero after the machine step: a refusal, and nothing written.
	v_begun := pg_temp.hc_begin(v_claim);
	perform pg_temp.wake_assert(v_begun = '{"state":"refused","reason":"COMPUTER_HOURS_EXHAUSTED"}'::jsonb
		and (pg_temp.worker_row('fix-send')).occurrence_id is null and (pg_temp.session_row('fix-send')).phase = 'preparing',
		'Begin answers a refusal and begins nothing: ' || v_begun::text);
	v_view := pg_temp.hc_defer(v_claim, 'COMPUTER_HOURS_EXHAUSTED');
	perform pg_temp.wake_assert(v_view ->> 'phase' = 'input_ready' and (pg_temp.session_row('fix-send')).last_step = 'Waiting for computer hours'
		and pg_temp.hc_steps('Waiting for computer hours') = 1, 'The session waits for computer hours: ' || v_view::text);
	-- The executor tries again later: still one step for the whole wait.
	v_claim := pg_temp.hc_claim();
	perform pg_temp.wake_assert(pg_temp.hc_authorize(v_claim) ->> 'reason' = 'COMPUTER_HOURS_EXHAUSTED', 'Still at zero');
	perform pg_temp.hc_defer(v_claim, 'COMPUTER_HOURS_EXHAUSTED');
	perform pg_temp.wake_assert(pg_temp.hc_steps('Waiting for computer hours') = 1, 'One step in the thread for the whole wait');
	-- A different reason posts its own step.
	v_claim := pg_temp.hc_claim();
	perform pg_temp.hc_defer(v_claim, 'NODE_CAPACITY_EXHAUSTED');
	perform pg_temp.wake_assert(pg_temp.hc_steps('Waiting for a coding machine') = 1
		and (pg_temp.session_row('fix-send')).last_step = 'Waiting for a coding machine', 'A new reason posts its own step');
end
$$;

-- 3. The hour is over: with no turn holding it, the member's machine is due to sleep though just used.
update public.qorpera_computer_hour_zero_state set ran_out_at = ran_out_at - interval '61 minutes'
where profile_id = '30000000-0000-4000-8000-000000000010';
update public.qorpera_coding_machines set last_used_at = clock_timestamp(), busy_at = clock_timestamp() where id = pg_temp.vm();
select pg_temp.wake_assert(pg_temp.listed() ->> 'live' = 'false' and pg_temp.listed() ->> 'sleepDue' = 'true',
	'After the hour the machine sleeps once no turn holds it: ' || (pg_temp.listed())::text);
-- A machine a turn holds is never put to sleep, the hour over or not.
do $$
declare v_claim jsonb := pg_temp.hc_claim();
begin
	perform pg_temp.wake_assert(pg_temp.listed() ->> 'live' = 'true' and pg_temp.listed() ->> 'sleepDue' = 'false',
		'A machine a turn holds does not sleep: ' || (pg_temp.listed())::text);
	perform pg_temp.hc_defer(v_claim, 'COMPUTER_HOURS_EXHAUSTED');
end
$$;
update public.qorpera_computer_hour_billing set coding_zero_rule_since = null;
select pg_temp.wake_assert(pg_temp.listed() ->> 'sleepDue' = 'false', 'Coding off: a busy machine stays awake as before');
update public.qorpera_computer_hour_billing set coding_zero_rule_since = clock_timestamp() - interval '1 second';

-- 4. Hours are added: the next turn gets its machine, before the next sweep.
insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, dry_run)
values ('credit', '30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000001', 72000,
	clock_timestamp() + interval '12 months', false);
do $$
declare v_claim jsonb;
begin
	perform pg_temp.observe();
	v_claim := pg_temp.hc_claim();
	perform pg_temp.wake_assert(pg_temp.hc_authorize(v_claim) ->> 'intent' = 'run', 'Hours added: the turn gets its machine');
	perform pg_temp.wake_assert(pg_temp.hc_begin(v_claim) ->> 'occurrenceId' is not null, 'and begins');
	perform pg_temp.wake_assert(pg_temp.listed() ->> 'sleepDue' = 'false', 'A machine a turn holds is not due to sleep');
end
$$;
rollback;
