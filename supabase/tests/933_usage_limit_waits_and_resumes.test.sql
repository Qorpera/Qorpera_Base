-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Work at a usage limit waits on its own login and goes on by itself (20260930575000, founder decision 2026-11-05: "wait
-- + resume only"). The base's owner pays with login A. Bob's routine file, saved by the owner, pays with A too; the owner
-- also connects login B with room. A reaches its usage limit during the base run: the signal takes its reset from A's
-- newest usage reading, and the owner's notice names A and no other login. Then the owner's post in Bob's thread and the
-- routine's next wake stay on A and wait: the materializer leaves them queued, never moving them to B. A usage reading
-- after the limit that shows room ends the wall at once, and the materializer starts the post's run, on A. A wall with a
-- reset days ahead ends a day after the limit at the latest.

create function pg_temp.p933_routine_parse(p_id uuid, p_title text) returns jsonb language sql as $$
	select jsonb_build_object('kind','routine','id',p_id,'title',p_title,'status','active',
		'trigger',jsonb_build_object('when','every','minutes',60,'starts',null),'timezone',null,'ends',null,'runs',null,'quiet',null,
		'effort','medium','reply','optional','conclusion',null,'instructions','Look at the numbers.')
$$;
-- A slot the scheduler queues for the routine's current version, as its schedule step does: answers the wake.
create function pg_temp.p933_schedule(p_key text) returns public.qorpera_wake_occurrences language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_at timestamptz := statement_timestamp() - interval '5 minutes';
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype; v_result jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.base_claims('service_role');
	select cursor_row.* into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors cursor_row
	join public.qorpera_cloud_routines routine on routine.id = cursor_row.routine_id and routine.current_version = cursor_row.routine_version
	where routine.id = '93300000-0000-4000-8000-0000000000e1';
	v_result := public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, v_id, p_key, v_cursor.trigger_id,
		v_at, v_cursor.last_scheduled_for, v_at + interval '5 minutes', '{}');
	perform pg_temp.base_assert(v_result ->> 'status' = 'queued' and (v_result ->> 'occurrence_id')::uuid = v_id,
		'the scheduler queues the slot: ' || v_result::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_id;
	return v_wake;
end
$$;
create function pg_temp.p933(p_key text) returns uuid language sql as $$
	select case p_key
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.p933_connection')::jsonb ->> 'connection_id')::uuid end
$$;
create function pg_temp.p933_wake(p_id uuid) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where id = p_id
$$;

-- Bob's routine file, saved by the owner: it pays with A.
select pg_temp.base_commit(pg_temp.base_owner(), 'p933-routine', jsonb_build_array(
	pg_temp.base_write('QorperaOS/agents/bob/routines/tick.md', 'routine',
		E'---\n' || pg_temp.p933_routine_parse('93300000-0000-4000-8000-0000000000e1', 'Tick')::text || E'\n---\n',
		pg_temp.p933_routine_parse('93300000-0000-4000-8000-0000000000e1', 'Tick')))) \g /dev/null

-- The owner connects login B, for work while away too, with room left.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.p933_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','93300000-0000-4000-8000-000000000051','93300000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.p933_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.p933_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'93300000-0000-4000-8000-000000000060',
	'object://native-capsules/93300000-0000-4000-8000-000000000060',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = pg_temp.p933('b') and version = 1;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010',
	'93300000-0000-4000-8000-000000000061',pg_temp.p933('b'),2,true) \g /dev/null
reset role;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.p933('b'),2,jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',jsonb_build_array(
	jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));

-- 1. A's newest usage reading shows the full window and its reset; A reaches its usage limit during the base run. The
-- signal records that reset (Codex's usage-limit error names none); an older reading, or another version's, names none.
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.p933('a'),2,jsonb_build_object('observedAt',statement_timestamp()-interval '10 minutes','windows',jsonb_build_array(
	jsonb_build_object('id','primary','label','5 hours','usedPercent',100,
		'resetAt',to_char((statement_timestamp() + interval '3 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
select pg_temp.base_assert(public.qorpera_native_account_reading_reset(pg_temp.p933('a'), 1) is null,
	'another version''s reading named a reset');
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.p933_signal', public.qorpera_record_provider_usage_signal(
	current_setting('qorpera_test.base_binding')::jsonb,'usage_limit')::text, true) \g /dev/null
reset role;
select pg_temp.base_assert(abs(extract(epoch from (current_setting('qorpera_test.p933_signal')::jsonb ->> 'resetsAt')::timestamptz
		- (statement_timestamp() + interval '3 hours'))) < 2
	and public.qorpera_native_account_remaining(pg_temp.p933('a'), 2) = 0,
	'the signal takes its reset from the newest usage reading: ' || current_setting('qorpera_test.p933_signal'));
-- The owner's notice names A, and no other login.
select pg_temp.base_assert((select notice.subject ? 'accountEmail' and not notice.subject ? 'movedTo'
		and notice.subject ->> 'connectionId' = pg_temp.p933('a')::text
	from public.qorpera_member_notifications notice
	where notice.user_id = '92400000-0000-4000-8000-000000000001' and notice.kind = 'provider_usage_limit'), 'the notice');
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage, '{observedAt}', to_jsonb(statement_timestamp() - interval '2 days'))
where connection_id = pg_temp.p933('a') and connection_version = 2;
select pg_temp.base_assert(public.qorpera_native_account_reading_reset(pg_temp.p933('a'), 2) is null,
	'a reading older than a day named a reset');

-- 2. A wall with a reset three days ahead ends a day after the limit at the latest.
savepoint p933_day;
update public.qorpera_provider_connection_usage_signals set resets_at = statement_timestamp() + interval '3 days',
	observed_at = statement_timestamp() - interval '1 hour'
where provider_connection_id = pg_temp.p933('a') and signal_kind = 'usage_limit';
select pg_temp.base_assert(public.qorpera_native_account_usage_limit_reset(pg_temp.p933('a')) is not null,
	'a known reset ahead did not hold the wall within the day');
update public.qorpera_provider_connection_usage_signals set observed_at = statement_timestamp() - interval '25 hours'
where provider_connection_id = pg_temp.p933('a') and signal_kind = 'usage_limit';
select pg_temp.base_assert(public.qorpera_native_account_usage_limit_reset(pg_temp.p933('a')) is null,
	'a usage limit''s wall held for more than a day');
rollback to savepoint p933_day;

-- 3. The owner's post in Bob's thread, paid by A, and the routine's next wake wait on A: never moved to B.
select set_config('qorpera_test.p933_post', pg_temp.base_post('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000031', 'Are the numbers in?') ->> 0, true) \g /dev/null
select set_config('qorpera_test.p933_routine_wake', (pg_temp.p933_schedule('p933-1')).id::text, true) \g /dev/null
select pg_temp.base_materialize() \g /dev/null
select pg_temp.base_materialize() \g /dev/null
do $$
declare v_post public.qorpera_wake_occurrences := pg_temp.p933_wake(current_setting('qorpera_test.p933_post')::uuid);
	v_routine public.qorpera_wake_occurrences := pg_temp.p933_wake(current_setting('qorpera_test.p933_routine_wake')::uuid);
begin
	perform pg_temp.base_assert(v_post.status = 'queued' and v_post.run_id is null
		and v_post.sponsor_binding_id = pg_temp.p933('aBinding'), 'the post at A''s limit did not wait on A: ' || to_jsonb(v_post)::text);
	perform pg_temp.base_assert(v_routine.status = 'queued' and v_routine.run_id is null
		and v_routine.sponsor_binding_id = pg_temp.p933('aBinding'),
		'the routine''s wake at A''s limit did not wait on A: ' || to_jsonb(v_routine)::text);
	perform pg_temp.base_assert(public.qorpera_sponsor_waits_for_usage_limit(pg_temp.p933('aBinding'), 1)
		and not exists (select 1 from public.qorpera_execution_sponsor_versions sponsor
			join public.qorpera_execution_runs run on run.sponsor_binding_id = sponsor.binding_id
			where sponsor.provider_connection_id = pg_temp.p933('b')), 'work moved to B');
end $$;

-- 4. A usage reading of A after its limit shows room (as Settings → Refresh or the vault's daily check records it): the
-- wall ends at once, though the signal named a reset, and the post goes on, on A.
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_build_object('observedAt', statement_timestamp(),
	'windows', jsonb_build_array(jsonb_build_object('id','primary','label','5 hours','usedPercent',35)))
where connection_id = pg_temp.p933('a') and connection_version = 2;
select pg_temp.base_assert(public.qorpera_native_account_usage_limit_reset(pg_temp.p933('a')) is null
	and not public.qorpera_sponsor_waits_for_usage_limit(pg_temp.p933('aBinding'), 1),
	'a reading with room did not end the wall');
select pg_temp.base_materialize() \g /dev/null
do $$
declare v_post public.qorpera_wake_occurrences := pg_temp.p933_wake(current_setting('qorpera_test.p933_post')::uuid);
	v_run public.qorpera_execution_runs%rowtype;
begin
	perform pg_temp.base_assert(v_post.status = 'materialized', 'the post did not go on: ' || to_jsonb(v_post)::text);
	select * into strict v_run from public.qorpera_execution_runs where id = v_post.run_id;
	perform pg_temp.base_assert(v_run.sponsor_binding_id = pg_temp.p933('aBinding'), 'the post''s run left A');
end $$;

-- The helpers are the database's own.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_sponsor_waits_for_usage_limit(uuid,bigint)',
		'public.qorpera_coding_session_waits_for_usage_limit(uuid)', 'public.qorpera_release_paused_runs_with_room(uuid)',
		'public.qorpera_native_account_reading_reset(uuid,bigint)', 'public.qorpera_usage_limit_account(uuid,uuid)',
		'public.qorpera_native_account_usage_recheck_due(uuid,bigint)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'execute')
			and not has_function_privilege('authenticated', v_fn, 'execute')
			and not has_function_privilege('service_role', v_fn, 'execute')
			and not has_function_privilege('qorpera_secret_broker', v_fn, 'execute'), v_fn || ' is postgres-only');
	end loop;
end $$;

rollback;
