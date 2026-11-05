-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A routine paid by its member's login runs on another of their own logins while its own is at its usage limit
-- (20260930575000, founder decision 2026-11-05). Bob's routine file, saved by the owner, pays with the owner's login A
-- (the base sponsor). The owner connects login B with room; A reaches its usage limit. The scheduler's next wake pays with
-- B and is admitted and materialized on B, its run's wake policy accepts it, and the routine still pays with A (it is
-- not changed). The routine editor reads it as able to pay. With B at its limit too, the wake stays on A and the read
-- says it waits for the limit. A company account's routine never moves, and a member's routine never takes another
-- member's login.

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
		when 'b' then (current_setting('qorpera_test.p933_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.p933_sponsor')::jsonb ->> 'binding_id')::uuid end
$$;
create function pg_temp.p933_payer() returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v := public.qorpera_get_routine_payer('93300000-0000-4000-8000-0000000000e1');
	perform pg_temp.base_claims('service_role');
	return v;
end
$$;

-- Bob's routine file, saved by the owner: it pays with A.
select pg_temp.base_commit(pg_temp.base_owner(), 'p933-routine', jsonb_build_array(
	pg_temp.base_write('QorperaOS/agents/bob/routines/tick.md', 'routine',
		E'---\n' || pg_temp.p933_routine_parse('93300000-0000-4000-8000-0000000000e1', 'Tick')::text || E'\n---\n',
		pg_temp.p933_routine_parse('93300000-0000-4000-8000-0000000000e1', 'Tick')))) \g /dev/null
select pg_temp.base_assert(routine.status = 'active' and version.sponsor_binding_id = pg_temp.p933('aBinding')
		and version.created_by_user_id = '92400000-0000-4000-8000-000000000001',
	'Bob''s routine pays with the owner''s login A: ' || to_jsonb(version)::text)
from public.qorpera_cloud_routines routine
join public.qorpera_cloud_routine_versions version on version.routine_id = routine.id and version.version = routine.current_version
where routine.id = '93300000-0000-4000-8000-0000000000e1';

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
select set_config('qorpera_test.p933_sponsor',public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010','93300000-0000-4000-8000-000000000061',pg_temp.p933('b'),2,true)::text,true) \g /dev/null
reset role;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.p933('b'),2,jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',jsonb_build_array(
	jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));

-- While A has room, the routine's wakes pay with A (a login with room is kept).
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype := pg_temp.p933_schedule('p933-0');
begin
	perform pg_temp.base_assert(v_wake.sponsor_binding_id = pg_temp.p933('aBinding'), 'a wake left A while it had room');
	-- Out of the way of the next one, which the checks below materialize.
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
		blocked_reason = 'Test: not run' where id = v_wake.id;
end $$;

-- A reaches its usage limit during the base run. Its newest usage reading shows the full window and its reset, which the
-- signal records (Codex's usage-limit error names none).
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.p933('a'),2,jsonb_build_object('observedAt',statement_timestamp()-interval '10 minutes','windows',jsonb_build_array(
	jsonb_build_object('id','primary','label','5 hours','usedPercent',100,
		'resetAt',to_char((statement_timestamp() + interval '3 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.p933_signal', public.qorpera_record_provider_usage_signal(
	current_setting('qorpera_test.base_binding')::jsonb,'usage_limit')::text, true) \g /dev/null
reset role;
select pg_temp.base_assert(abs(extract(epoch from (current_setting('qorpera_test.p933_signal')::jsonb ->> 'resetsAt')::timestamptz
		- (statement_timestamp() + interval '3 hours'))) < 2
	and public.qorpera_native_account_remaining(pg_temp.p933('a'), 2) = 0,
	'the signal takes its reset from the newest usage reading: ' || current_setting('qorpera_test.p933_signal'));

-- The next wake pays with B; the routine still pays with A.
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype := pg_temp.p933_schedule('p933-1'); v_payer jsonb;
	v_version public.qorpera_cloud_routine_versions%rowtype;
begin
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.sponsor_binding_id = pg_temp.p933('bBinding')
		and v_wake.requested_by_user_id = '92400000-0000-4000-8000-000000000001' and v_wake.logical_computer_id is null,
		'the wake at A''s limit does not pay with B: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(public.qorpera_wake_authorized(v_wake), 'the wake on B is not admitted');
	select version.* into strict v_version from public.qorpera_cloud_routine_versions version
	join public.qorpera_cloud_routines routine on routine.id = version.routine_id and routine.current_version = version.version
	where routine.id = '93300000-0000-4000-8000-0000000000e1';
	perform pg_temp.base_assert(v_version.sponsor_binding_id = pg_temp.p933('aBinding'), 'the routine''s own payer changed');
	v_payer := pg_temp.p933_payer();
	perform pg_temp.base_assert((v_payer ->> 'canPay')::boolean and v_payer -> 'waitsFor' = 'null'::jsonb
		and v_payer ->> 'connectionId' = pg_temp.p933('a')::text,
		'the routine editor does not read the routine as able to pay: ' || v_payer::text);
	perform set_config('qorpera_test.p933_wake', v_wake.id::text, true);
end $$;

-- The wake materializes into a run on B, and the run's wake policy accepts it.
select pg_temp.base_materialize() \g /dev/null
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.p933_wake')::uuid;
	perform pg_temp.base_assert(v_wake.status = 'materialized' and v_wake.run_id is not null,
		'the wake on B did not materialize: ' || to_jsonb(v_wake)::text);
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.base_assert(v_run.sponsor_binding_id = pg_temp.p933('bBinding'), 'the run does not pay with B');
	perform pg_temp.base_assert(public.qorpera_runtime_wake_policy_internal(v_run.id)
		is distinct from public.qorpera_wake_policy_value(null), 'the run''s wake policy refuses it');
end $$;

-- B reaches its limit too: the next wake stays on A and waits for it, and the read says so.
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','100')
where connection_id = pg_temp.p933('b');
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype := pg_temp.p933_schedule('p933-2'); v_payer jsonb;
begin
	perform pg_temp.base_assert(v_wake.sponsor_binding_id = pg_temp.p933('aBinding'),
		'a wake moved while no login had room: ' || to_jsonb(v_wake)::text);
	v_payer := pg_temp.p933_payer();
	perform pg_temp.base_assert(not (v_payer ->> 'canPay')::boolean and v_payer ->> 'waitsFor' = 'usage_limit',
		'the read does not say the routine waits for the limit: ' || v_payer::text);
end $$;

-- Never another member's login: as the contributor's routine (…002 saved it), A's limit gives no move to the owner's B.
select pg_temp.base_assert(not exists (select 1 from public.qorpera_routine_wake_payer('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000031', pg_temp.p933('aBinding'), 1) payer
	where payer.binding_id is distinct from pg_temp.p933('aBinding')), 'a routine moved to another member''s login');
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','20')
where connection_id = pg_temp.p933('b');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_member_work_login_with_room('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000031', null)),
	'another member''s login offered room to a member');
-- A run on another member's login is no run on the routine member's own login.
select pg_temp.base_assert(not public.qorpera_routine_runs_on_own_login(
	jsonb_populate_record(null::public.qorpera_cloud_routine_versions, jsonb_build_object('profile_id', '92400000-0000-4000-8000-000000000010',
		'created_by_user_id', '92400000-0000-4000-8000-000000000002', 'sponsor_binding_id', pg_temp.p933('aBinding'), 'sponsor_version', 1)),
	pg_temp.p933('bBinding'), 1), 'a routine of one member ran on another member''s login');
select pg_temp.base_assert(public.qorpera_routine_runs_on_own_login(
	jsonb_populate_record(null::public.qorpera_cloud_routine_versions, jsonb_build_object('profile_id', '92400000-0000-4000-8000-000000000010',
		'created_by_user_id', '92400000-0000-4000-8000-000000000001', 'sponsor_binding_id', pg_temp.p933('aBinding'), 'sponsor_version', 1)),
	pg_temp.p933('bBinding'), 1), 'a routine could not run on its member''s other login');

-- The helpers are the database's own.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_routine_wake_payer(uuid,uuid,uuid,uuid,bigint)',
		'public.qorpera_routine_runs_on_own_login(public.qorpera_cloud_routine_versions,uuid,bigint)',
		'public.qorpera_member_work_login_with_room(uuid,uuid,uuid,uuid)', 'public.qorpera_native_account_reading_reset(uuid)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'execute')
			and not has_function_privilege('authenticated', v_fn, 'execute')
			and not has_function_privilege('service_role', v_fn, 'execute'), v_fn || ' is postgres-only');
	end loop;
end $$;

rollback;
