-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- WB G5 (20260930538000): a conversation runs one run at a time, a wake's too. On the folder-v2 runtime base, Alice's
-- run messages Bob, and his wake runs in his own thread, the web's main chat. While that run is queued, then leased, the
-- owner's post there and the owner's start of Bob's first run wait: the due list leaves the company out, a pass is idle
-- and writes nothing, and the post's wake stays queued with no run and no reason (before, the post became a second run
-- beside the wake: production, 28 Oct 2026, run 4256). Once the wake is done the turn runs, and the post waits behind
-- it; once the turn is done, the post and a second message of Alice's run one after the other. In a group chat Bob and
-- Carol still answer side by side, while Bob's thread has its own run (no rule across conversations), and each waits
-- only for its own run there. A wake that waits names no reason, while a full login still blocks a wake in a free
-- conversation with the quota's reason (874 §5 before this change).

create function pg_temp.oc_thread(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '92400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
create function pg_temp.oc_counts() returns bigint[] language sql as $$
	select array[(select count(*) from public.qorpera_execution_runs where profile_id = '92400000-0000-4000-8000-000000000010'),
		(select count(*) from public.qorpera_runner_jobs where profile_id = '92400000-0000-4000-8000-000000000010'),
		(select count(*) from public.qorpera_execution_sponsor_reservations where profile_id = '92400000-0000-4000-8000-000000000010')]
$$;
-- A wake that waits for its conversation: queued, with no run and no reason.
create function pg_temp.oc_waits(p_wake uuid) returns boolean language sql as $$
	select status = 'queued' and run_id is null and blocked_reason is null from public.qorpera_wake_occurrences where id = p_wake
$$;
create function pg_temp.oc_run_of(p_wake uuid) returns uuid language sql as $$
	select run_id from public.qorpera_wake_occurrences where id = p_wake and status = 'materialized'
$$;
-- While everything waits: the due list leaves the company out, and a pass is idle and writes nothing.
create function pg_temp.oc_idle(p_when text) returns void language plpgsql as $$
declare v_counts bigint[] := pg_temp.oc_counts(); v_pass jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(public.qorpera_folder_materialize_due(null, 500) -> 'items') item
		where item ->> 'profile_id' = '92400000-0000-4000-8000-000000000010'), p_when || ': the company is not due');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'idle' and pg_temp.oc_counts() = v_counts,
		p_when || ': the pass is idle and writes nothing: ' || v_pass::text);
end $$;
-- A started run is done: a member's turn or post is answered (an acknowledgement, then the final report; a coworker's
-- wake may stay silent), and its runner completes its job (the trigger settles its reservation).
create function pg_temp.oc_done(p_binding jsonb) returns void language plpgsql as $$
begin
	if (select source_kind <> 'wake' from public.qorpera_execution_runs where id = (p_binding ->> 'runId')::uuid) then
		perform pg_temp.base_public_send(p_binding, 'progress');
		perform pg_temp.base_public_send(p_binding, 'final');
	end if;
	update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where run_id = (p_binding ->> 'runId')::uuid and status = 'leased';
	if not found then raise exception 'Fixture: run % is not leased', p_binding ->> 'runId'; end if;
end $$;
-- The login's concurrency, in every version of the owner's login.
create function pg_temp.oc_login_max(p_max bigint) returns void language sql as $$
	update public.qorpera_provider_connection_versions set quota_policy = jsonb_set(quota_policy, '{max_concurrent_runs}', to_jsonb(p_max))
	where connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
$$;

-- 1. The incident: Alice's message wakes Bob in his thread. While that run is queued, then leased, the owner's post
--    there and the owner's start of Bob's first run wait; once it is done, the turn runs and the post waits behind it.
do $$
declare v_alice jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_send jsonb; v_pass jsonb;
	v_run public.qorpera_execution_runs;
begin
	perform pg_temp.base_public_send(v_alice, 'progress');
	v_send := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000031', 'oc-ask-1', 'Could you check the note?');
	v_pass := pg_temp.base_materialize();
	select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.oc_run_of((v_send ->> 'occurrenceId')::uuid);
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_run.id) and v_run.source_kind = 'wake'
		and v_run.session_id = pg_temp.oc_thread('92400000-0000-4000-8000-000000000031'),
		'Fixture: Alice''s message is a wake run in Bob''s thread: ' || v_pass::text);
	perform set_config('qorpera_test.oc_wake_run', v_run.id::text, true);
	perform set_config('qorpera_test.oc_post', pg_temp.base_post('92400000-0000-4000-8000-000000000001',
		'92400000-0000-4000-8000-000000000031', 'Are you there?') ->> 0, true);
end $$;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_start_agent_first_run('92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000031') ->> 'state' = 'started', 'The owner starts Bob''s first run');
reset role;
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.oc_request', (select id::text from public.qorpera_session_turn_requests
	where session_id = pg_temp.oc_thread('92400000-0000-4000-8000-000000000031') and status = 'queued'), true) \g /dev/null
do $$
declare v_pass jsonb; v_run public.qorpera_execution_runs; v_when text; v_binding jsonb;
begin
	foreach v_when in array array['queued', 'leased'] loop
		if v_when = 'leased' then v_binding := pg_temp.base_start(current_setting('qorpera_test.oc_wake_run')::uuid); end if;
		perform pg_temp.oc_idle('The wake run is ' || v_when);
		perform pg_temp.base_assert(pg_temp.oc_waits(current_setting('qorpera_test.oc_post')::uuid)
			and (select status = 'queued' and run_id is null from public.qorpera_session_turn_requests
				where id = current_setting('qorpera_test.oc_request')::uuid),
			'The post and the turn wait while the wake run is ' || v_when);
	end loop;
	perform pg_temp.oc_done(v_binding);
	-- Turns go first; the post, scanned in the same pass, finds the turn's run there and waits.
	v_pass := pg_temp.base_materialize();
	select * into strict v_run from public.qorpera_execution_runs where id = current_setting('qorpera_test.oc_request')::uuid;
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_run.id) and (v_pass ->> 'skipped')::integer = 1
		and v_run.source_kind = 'session_turn' and v_run.session_id = pg_temp.oc_thread('92400000-0000-4000-8000-000000000031')
		and pg_temp.oc_waits(current_setting('qorpera_test.oc_post')::uuid),
		'Once the wake is done the turn runs, and the post waits: ' || v_pass::text);
end $$;

-- 2. The reverse: while Bob's turn is queued, then leased, the post and a second message of Alice's wait; once the turn
--    is done, a pass runs one of them and leaves the other waiting, which runs once that run is done.
do $$
declare v_send jsonb := public.qorpera_send_coworker_message(current_setting('qorpera_test.base_binding')::jsonb,
		'92400000-0000-4000-8000-000000000031', 'oc-ask-2', 'And the receipts?');
	v_wakes uuid[] := array[current_setting('qorpera_test.oc_post')::uuid, (v_send ->> 'occurrenceId')::uuid];
	v_turn uuid := current_setting('qorpera_test.oc_request')::uuid; v_pass jsonb; v_first uuid; v_second uuid; v_when text;
	v_binding jsonb;
begin
	foreach v_when in array array['queued', 'leased'] loop
		if v_when = 'leased' then v_binding := pg_temp.base_start(v_turn); end if;
		perform pg_temp.oc_idle('The turn is ' || v_when);
		perform pg_temp.base_assert(pg_temp.oc_waits(v_wakes[1]) and pg_temp.oc_waits(v_wakes[2]),
			'The post and the message wait while the turn is ' || v_when);
	end loop;
	perform pg_temp.oc_done(v_binding);
	v_pass := pg_temp.base_materialize();
	select id into strict v_first from public.qorpera_wake_occurrences where id = any(v_wakes) and status = 'materialized';
	v_second := case when v_first = v_wakes[1] then v_wakes[2] else v_wakes[1] end;
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(pg_temp.oc_run_of(v_first))
		and (v_pass ->> 'skipped')::integer = 1 and pg_temp.oc_waits(v_second),
		'Once the turn is done one wake runs and the other waits: ' || v_pass::text);
	v_binding := pg_temp.base_start(pg_temp.oc_run_of(v_first));
	perform pg_temp.oc_idle('The first wake''s run is leased');
	perform pg_temp.oc_done(v_binding);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(pg_temp.oc_run_of(v_second) is not null
		and v_pass -> 'run_ids' = jsonb_build_array(pg_temp.oc_run_of(v_second)),
		'The other wake runs once that run is done: ' || v_pass::text);
	-- It stays live in Bob's thread for 3 and 4.
	perform set_config('qorpera_test.oc_thread_run', pg_temp.oc_run_of(v_second)::text, true);
end $$;

-- 3. A group chat of Bob and Carol: a pass runs both, while Bob's thread has its own run (no rule across
--    conversations); a later post's wakes each wait for their own agent's run there, and Bob's runs once his is done.
select pg_temp.base_commit(pg_temp.base_owner(), 'oc-group-desk', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
	jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/desk',
		'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file', 'file', pg_temp.base_stage(g.text))),
		'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/groups/desk/group.md', 'kind', 'group', 'text', g.text,
			'parse', jsonb_build_object('kind', 'group', 'id', '46500000-0000-4000-8000-000000000465', 'name', 'Desk', 'subtitle', null,
				'agents', '["92400000-0000-4000-8000-000000000031","92400000-0000-4000-8000-000000000032"]'::jsonb,
				'people', '["92400000-0000-4000-8000-000000000001","92400000-0000-4000-8000-000000000002"]'::jsonb, 'purpose', 'Run the desk.'),
			'parserVersion', 1)))))
from (select E'---\nid: 46500000-0000-4000-8000-000000000465\nname: Desk\nagents:\n  - 92400000-0000-4000-8000-000000000031\n'
	|| E'  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n'
	|| E'  - 92400000-0000-4000-8000-000000000002\n---\nRun the desk.\n' as text) g \g /dev/null
-- The owner posts in the group chat on their own sponsor; answers the post's wakes, Bob's first.
create function pg_temp.oc_group_post(p_text text) returns uuid[] language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_post_company_room_message('46500000-0000-4000-8000-000000000465', extensions.gen_random_uuid(),
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text),
		(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
	reset role;
	perform pg_temp.base_claims('service_role');
	return array(select id from public.qorpera_wake_occurrences where id in (select jsonb_array_elements_text(v_result -> 'occurrenceIds')::uuid)
		order by staff_agent_id);
end $$;
do $$
declare v_group uuid := (select session_id from public.qorpera_company_rooms where id = '46500000-0000-4000-8000-000000000465');
	v_first uuid[] := pg_temp.oc_group_post('Plan the week.'); v_second uuid[]; v_pass jsonb := pg_temp.base_materialize();
begin
	perform pg_temp.base_assert(v_group is not null and (select session.staff_agent_id is null from public.qorpera_shared_sessions as session
		where session.id = v_group), 'Fixture: the group chat is a conversation with no agent');
	perform pg_temp.base_assert(cardinality(v_first) = 2 and jsonb_array_length(v_pass -> 'run_ids') = 2
		and (select count(distinct run.staff_agent_id) = 2 from public.qorpera_execution_runs as run
			where run.id in (pg_temp.oc_run_of(v_first[1]), pg_temp.oc_run_of(v_first[2])) and run.session_id = v_group
				and run.source_kind = 'room_delivery' and v_pass -> 'run_ids' ? run.id::text),
		'One pass runs both agents of the group chat: ' || v_pass::text);
	perform pg_temp.base_assert((select job.status = 'queued' from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id where run.id = current_setting('qorpera_test.oc_thread_run')::uuid),
		'Bob runs in his thread and in the group chat at once');
	v_second := pg_temp.oc_group_post('Anyone free?');
	perform pg_temp.oc_idle('Both agents run in the group chat');
	perform pg_temp.base_assert(pg_temp.oc_waits(v_second[1]) and pg_temp.oc_waits(v_second[2]),
		'Each agent''s second wake waits for its own run there');
	-- Bob's first group run ends; Carol's still runs.
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'Fixture: Bob''s group run ends'
	where run_id = pg_temp.oc_run_of(v_first[1]);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(pg_temp.oc_run_of(v_second[1]) is not null
		and v_pass -> 'run_ids' = jsonb_build_array(pg_temp.oc_run_of(v_second[1])) and pg_temp.oc_waits(v_second[2]),
		'Only Bob''s second wake runs, and Carol''s waits for her run: ' || v_pass::text);
end $$;

-- 4. A full login: a wake in a busy conversation still waits with no reason, and a wake in a free one is blocked with
--    the quota's reason and leaves no run, job or reservation; once the login has room, it runs.
select pg_temp.oc_login_max((select count(*) from public.qorpera_execution_sponsor_reservations
	where provider_connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		and status = 'reserved')) \g /dev/null
do $$
declare v_busy uuid := (pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'One more thing.') ->> 0)::uuid;
	v_free uuid := (pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000032',
		'Are you free?') ->> 0)::uuid;
	v_counts bigint[] := pg_temp.oc_counts(); v_pass jsonb := pg_temp.base_materialize();
begin
	perform pg_temp.base_assert(v_pass -> 'run_ids' = '[]'::jsonb and (v_pass ->> 'blocked')::integer = 1
		and (select status = 'queued' and run_id is null and blocked_reason = 'Execution sponsor authority or quota is unavailable'
			from public.qorpera_wake_occurrences where id = v_free)
		and pg_temp.oc_waits(v_busy) and pg_temp.oc_counts() = v_counts,
		'A full login blocks the free conversation''s wake, and the busy one''s waits: ' || v_pass::text);
	perform pg_temp.oc_login_max(32);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(pg_temp.oc_run_of(v_free) is not null and v_pass -> 'run_ids' = jsonb_build_array(pg_temp.oc_run_of(v_free))
		and (select blocked_reason is null from public.qorpera_wake_occurrences where id = v_free) and pg_temp.oc_waits(v_busy),
		'Once the login has room the blocked wake runs, and the busy one''s still waits: ' || v_pass::text);
end $$;

rollback;
