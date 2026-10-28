-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A login runs at most 64 runs at once (launch checklist L19.4, its D9 gap: "the 64-runs-at-once limit per account";
-- 20260828019990: a connection may sponsor several concurrent runs, bounded at 64 per connection). The bound is the
-- provider policy's 64, which the schema caps there and a sign-in cannot raise. The contributor signs in their own login
-- at that bound and asks Bob 64 times, first in his thread, then in 63 group chats: 64 queued runs, each holding one of
-- the login's slots (a conversation runs one run at a time, 20260930538000, so the 64 runs are in 64 conversations; an
-- agent may run in many at once). The 65th post, in another group chat where nothing runs, waits: its wake stays queued
-- with the quota's reason, on the contributor's own login, and makes no run, job or reservation, while the owner's login,
-- another account, still starts work. When the contributor stops their run in Bob's thread, its slot frees and the
-- waiting post becomes a run on the same login.

-- The contributor's sign-in, completed by the node host with the concurrency the login consents to.
create function pg_temp.lr_complete(p_max integer) returns jsonb language sql as $$
	select public.qorpera_complete_native_provider_login(current_setting('qorpera_test.lr_login')::uuid, repeat('c', 64),
		'42500000-0000-4000-8000-000000000060', 'object://native-capsules/42500000-0000-4000-8000-000000000060', repeat('d', 64),
		'fixture-member-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		jsonb_build_object('monthly_microusd', 1000000000, 'reservation_microusd', 1000, 'max_calls_per_run', 32,
			'max_input_tokens_per_run', 2000000, 'max_output_tokens_per_run', 500000, 'max_concurrent_runs', p_max))
$$;
-- Group chat i (2 to 65) below, for post i; its room has the group's id.
create function pg_temp.lr_group(p_i integer) returns uuid language sql immutable as $$
	select ('42500000-0000-4000-8000-' || lpad((1000 + p_i)::text, 12, '0'))::uuid
$$;
-- The contributor's post in a group chat, or in Bob's thread when none is named, paid by their own login, and the
-- materializer pass after it.
create function pg_temp.lr_post(p_text text, p_room uuid default null) returns jsonb language plpgsql as $$
begin
	if p_room is null then
		perform set_config('qorpera_test.lr_wakes', pg_temp.base_post('92400000-0000-4000-8000-000000000002',
			'92400000-0000-4000-8000-000000000031', p_text, current_setting('qorpera_test.lr_binding')::uuid)::text, true);
	else
		perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
		set local role authenticated;
		perform set_config('qorpera_test.lr_wakes', (public.qorpera_post_company_room_message(p_room, extensions.gen_random_uuid(),
			jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text), current_setting('qorpera_test.lr_binding')::uuid, 1)
			-> 'occurrenceIds')::text, true);
		reset role;
	end if;
	return pg_temp.base_materialize();
end
$$;
-- The runs the contributor's login holds.
create function pg_temp.lr_held() returns bigint language sql as $$
	select count(*) from public.qorpera_execution_sponsor_reservations
	where provider_connection_id = current_setting('qorpera_test.lr_connection')::uuid and status = 'reserved'
$$;
create function pg_temp.lr_counts() returns bigint[] language sql as $$
	select array[(select count(*) from public.qorpera_execution_runs where profile_id = '92400000-0000-4000-8000-000000000010'),
		(select count(*) from public.qorpera_runner_jobs where profile_id = '92400000-0000-4000-8000-000000000010'),
		(select count(*) from public.qorpera_execution_sponsor_reservations where profile_id = '92400000-0000-4000-8000-000000000010')]
$$;

-- 1. The bound is 64: the policy's default (20260828019990 set every subscription policy to it), and the schema's cap
--    on the policy and on every login version. 924's fixture lowers Codex to 32; the deployment's setter puts it back at
--    64 and cannot raise it past.
do $$
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert((select column_default from information_schema.columns where table_schema = 'public'
		and table_name = 'qorpera_provider_execution_policies' and column_name = 'max_native_concurrency') = '64',
		'a provider policy allows 64 runs at once by default');
	perform pg_temp.base_error($sql$select public.qorpera_set_provider_execution_policy('openai', 'native_subscription', 'codex-cli',
		'supported', 'enabled', 65, null, 'login-64-runs')$sql$, '23514');
	perform pg_temp.base_assert(public.qorpera_set_provider_execution_policy('openai', 'native_subscription', 'codex-cli', 'supported',
		'enabled', 64, null, 'login-64-runs') ->> 'max_native_concurrency' = '64', 'the Codex policy allows 64 runs at once');
	perform pg_temp.base_error(format('update public.qorpera_provider_connection_versions set max_native_concurrency = 65
		where connection_id = %L', current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id'), '23514');
end
$$;

-- 2. The contributor signs in their own login. It cannot consent to more than the policy's 64; at 64 it is accepted,
--    and its version records 64 for its runs and its leases.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.lr_identity', public.qorpera_upsert_member_compute_identity('92400000-0000-4000-8000-000000000010',
	'42500000-0000-4000-8000-000000000050', 'Contributor identity', 'qorpera-member-linux', 'v1', '["agent_turn"]',
	'{"network":"provider-native-only","credentialExport":false}') ->> 'compute_identity_id', true) \g /dev/null
select set_config('qorpera_test.lr_login', public.qorpera_begin_native_provider_login('92400000-0000-4000-8000-000000000010',
	'42500000-0000-4000-8000-000000000051', '42500000-0000-4000-8000-000000000052',
	current_setting('qorpera_test.lr_identity')::uuid, 'openai', 'codex-cli', repeat('c', 64), 900) ->> 'login_id', true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error('select pg_temp.lr_complete(65)', '42501', 'native provider policy does not authorize this connection');
select set_config('qorpera_test.lr_connection', pg_temp.lr_complete(64) ->> 'connection_id', true) \g /dev/null
reset role;
do $$
declare v_version public.qorpera_provider_connection_versions;
begin
	select * into strict v_version from public.qorpera_provider_connection_versions
	where connection_id = current_setting('qorpera_test.lr_connection')::uuid;
	perform pg_temp.base_assert(v_version.max_native_concurrency = 64 and (v_version.quota_policy ->> 'max_concurrent_runs')::integer = 64,
		'the login consents to 64 runs at once: ' || to_jsonb(v_version)::text);
end
$$;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.lr_binding', public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010',
	'42500000-0000-4000-8000-000000000061', current_setting('qorpera_test.lr_connection')::uuid, 1, false) ->> 'binding_id', true)
\g /dev/null
reset role;

-- Group chats 2 to 65 of Bob and Carol with the owner and the contributor, saved by the owner. A conversation runs one
-- run at a time (20260930538000), so 64 runs at once need 64 conversations: Bob's thread and 63 of these.
select pg_temp.base_claims('service_role');
select pg_temp.base_commit(pg_temp.base_owner(), 'lr-group-chats', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path',
	'QorperaOS/agents/groups')) || (select jsonb_agg(jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/questions-' || i,
		'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file', 'file', pg_temp.base_stage(g.text))),
		'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/groups/questions-' || i || '/group.md', 'kind', 'group',
			'text', g.text, 'parse', jsonb_build_object('kind', 'group', 'id', pg_temp.lr_group(i), 'name', 'Questions ' || i, 'subtitle', null,
				'agents', '["92400000-0000-4000-8000-000000000031","92400000-0000-4000-8000-000000000032"]'::jsonb,
				'people', '["92400000-0000-4000-8000-000000000001","92400000-0000-4000-8000-000000000002"]'::jsonb, 'purpose', 'Answer questions.'),
			'parserVersion', 1))) order by i)
	from generate_series(2, 65) i
	cross join lateral (select format(E'---\nid: %s\nname: Questions %s\nagents:\n  - 92400000-0000-4000-8000-000000000031\n'
		|| E'  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n'
		|| E'  - 92400000-0000-4000-8000-000000000002\n---\nAnswer questions.\n', pg_temp.lr_group(i), i) as text) g)) \g /dev/null

-- 3. 64 posts to Bob, the first in his thread and each other one in its group chat naming him, are 64 queued runs of
--    Bob's, each holding one of the login's slots.
do $$
declare v_pass jsonb; v_runs uuid[] := '{}'::uuid[];
begin
	for i in 1..64 loop
		v_pass := case when i = 1 then pg_temp.lr_post('Question 1.') else pg_temp.lr_post('@Bob question ' || i || '.', pg_temp.lr_group(i)) end;
		perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
			'fixture: post ' || i || ' is one run: ' || v_pass::text);
		v_runs := v_runs || (v_pass -> 'run_ids' ->> 0)::uuid;
	end loop;
	perform pg_temp.base_assert(pg_temp.lr_held() = 64 and (select count(*) = 64 and count(distinct run.session_id) = 64
		and bool_and(run.staff_agent_id = '92400000-0000-4000-8000-000000000031')
		and bool_and(run.sponsor_binding_id = current_setting('qorpera_test.lr_binding')::uuid and job.status = 'queued'
			and job.created_by_user_id = '92400000-0000-4000-8000-000000000002' and reservation.status = 'reserved'
			and reservation.provider_connection_id = current_setting('qorpera_test.lr_connection')::uuid)
		from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		join public.qorpera_execution_sponsor_reservations as reservation on reservation.run_id = run.id
		where run.id = any(v_runs)), 'the login holds 64 queued runs of the contributor''s, one in each conversation');
	perform set_config('qorpera_test.lr_first_run', v_runs[1]::text, true);
	perform set_config('qorpera_test.lr_session', (select session_id from public.qorpera_execution_runs where id = v_runs[1])::text, true);
end
$$;

-- 4. The 65th post, in group chat 65 where nothing runs (so it waits for the login, not for its conversation), waits: no
--    run, job or reservation; its wake stays queued with the quota's reason, on the contributor's own login. Another pass
--    leaves it waiting.
do $$
declare v_counts bigint[] := pg_temp.lr_counts(); v_pass jsonb; v_wake public.qorpera_wake_occurrences;
begin
	v_pass := pg_temp.lr_post('@Bob question 65.', pg_temp.lr_group(65));
	perform pg_temp.base_assert(jsonb_array_length(current_setting('qorpera_test.lr_wakes')::jsonb) = 1,
		'fixture: the 65th post wakes Bob once');
	perform set_config('qorpera_test.lr_waiting', current_setting('qorpera_test.lr_wakes')::jsonb ->> 0, true);
	perform pg_temp.base_assert(v_pass -> 'run_ids' = '[]'::jsonb and (v_pass ->> 'blocked')::integer = 1
		and (v_pass ->> 'failed')::integer = 0 and (v_pass ->> 'cancelled')::integer = 0, 'the 65th run waits: ' || v_pass::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.lr_waiting')::uuid;
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.run_id is null
		and v_wake.blocked_reason = 'Execution sponsor authority or quota is unavailable'
		and v_wake.sponsor_binding_id = current_setting('qorpera_test.lr_binding')::uuid and v_wake.sponsor_version = 1,
		'the post waits for its login, with the quota''s reason: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(pg_temp.lr_counts() = v_counts and pg_temp.lr_held() = 64,
		'the waiting post holds no run, job or reservation');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass -> 'run_ids' = '[]'::jsonb and (v_pass ->> 'blocked')::integer = 1
		and pg_temp.lr_counts() = v_counts, 'another pass leaves it waiting: ' || v_pass::text);
end
$$;

-- 5. The limit is the login's: the owner's login, another account, still starts work, and does not stand in for the
--    contributor's waiting post.
do $$
declare v_owner uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid; v_pass jsonb;
	v_held bigint := (select count(*) from public.qorpera_execution_sponsor_reservations
		where provider_connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
			and status = 'reserved');
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000032', 'Draft the plan.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1 and (v_pass ->> 'blocked')::integer = 1,
		'the owner''s post runs while the contributor''s waits: ' || v_pass::text);
	perform pg_temp.base_assert((select reservation.provider_connection_id = v_owner and reservation.status = 'reserved'
		and run.staff_agent_id = '92400000-0000-4000-8000-000000000032'
		from public.qorpera_execution_runs as run
		join public.qorpera_execution_sponsor_reservations as reservation on reservation.run_id = run.id
		where run.id = (v_pass -> 'run_ids' ->> 0)::uuid), 'Carol''s run is on the owner''s login');
	perform pg_temp.base_assert((select count(*) from public.qorpera_execution_sponsor_reservations
		where provider_connection_id = v_owner and status = 'reserved') = v_held + 1 and pg_temp.lr_held() = 64,
		'each login holds only its own runs');
	perform pg_temp.base_assert((select status = 'queued' and run_id is null
		and sponsor_binding_id = current_setting('qorpera_test.lr_binding')::uuid from public.qorpera_wake_occurrences
		where id = current_setting('qorpera_test.lr_waiting')::uuid), 'the contributor''s post still waits for their own login');
end
$$;

-- 6. The contributor stops their oldest run, in Bob's thread (a member's Stop is a thread's): its slot frees, and the
--    waiting post becomes a run on the same login.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.lr_session')::uuid,
	current_setting('qorpera_test.lr_first_run')::uuid) ->> 'status' = 'cancelled', 'the contributor stops their oldest run');
reset role;
do $$
declare v_pass jsonb; v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_assert(pg_temp.lr_held() = 63 and (select status = 'settled' from public.qorpera_execution_sponsor_reservations
		where run_id = current_setting('qorpera_test.lr_first_run')::uuid), 'the stopped run frees its slot');
	v_pass := pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.lr_waiting')::uuid;
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_wake.run_id) and (v_pass ->> 'blocked')::integer = 0
		and v_wake.status = 'materialized' and v_wake.blocked_reason is null, 'the waiting post runs: ' || v_pass::text);
	perform pg_temp.base_assert((select run.sponsor_binding_id = current_setting('qorpera_test.lr_binding')::uuid
		and reservation.provider_connection_id = current_setting('qorpera_test.lr_connection')::uuid and reservation.status = 'reserved'
		from public.qorpera_execution_runs as run
		join public.qorpera_execution_sponsor_reservations as reservation on reservation.run_id = run.id
		where run.id = v_wake.run_id), 'on the contributor''s own login');
	perform pg_temp.base_assert(pg_temp.lr_held() = 64, 'the login holds 64 runs again');
end
$$;

rollback;
