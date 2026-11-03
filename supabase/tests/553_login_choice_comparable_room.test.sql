-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A first login choice that works and compares room fairly (migration 20260930551000; live company-building test, 3
-- November 2026). 924's owner (…001) pays with login A, on which Alice's run is leased; they connect login B the same
-- way. A reports a weekly window, B a 30-day one (the founder's workspace plan). Checked: the room on one scale (a share
-- of a week that resets soon against a share of 30 days); a login that completed a run this week comes first while it
-- has 20% left in each window; a login whose provider refused its last three runs comes last, six hours later it is
-- chosen as before, and another kind of ending breaks the run of refusals; the three first choices (a new conversation,
-- new work, a new coding session) follow that order; the member's connection list reports each login's recent turns;
-- the payer functions keep their earlier bodies' markers; and the grants.

-- 0. Login B, as 905 connects it: for work while away too, with its own member sponsor.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.lr_login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '55300000-0000-4000-8000-000000000051', '55300000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('c', 64), 900)::text,
	true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.lr_connection', public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.lr_login')::jsonb ->> 'login_id')::uuid, repeat('c', 64), '55300000-0000-4000-8000-000000000060',
	'object://native-capsules/55300000-0000-4000-8000-000000000060', repeat('d', 64), 'fixture-openai-account-lr', 'personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,
	true) \g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.lr_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.lr_sponsor', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', '55300000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.lr_connection')::jsonb ->> 'connection_id')::uuid, 2, true)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

create function pg_temp.lr(p_key text) returns uuid language sql as $$
	select case p_key
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'b' then (current_setting('qorpera_test.lr_connection')::jsonb ->> 'connection_id')::uuid end
$$;
-- A login's fresh usage report for its version 2: one window this many days long, this much used, resetting in so many
-- days.
create function pg_temp.lr_usage(p_connection uuid, p_used numeric, p_window_days integer, p_reset_days numeric)
returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
	values (p_connection, 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second', 'windows',
		jsonb_build_array(jsonb_build_object('id', 'primary', 'label', 'Window', 'usedPercent', p_used,
			'windowSeconds', p_window_days * 86400,
			'resetAt', to_char((statement_timestamp() + p_reset_days * interval '1 day') at time zone 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
$$;
-- Bob's thread: the conversation whose first choice is asked (and forgotten again).
create function pg_temp.lr_session() returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031')
$$;
-- The three first choices, as connection ids: a new conversation, new work for Carol, a new coding session.
create function pg_temp.lr_choices() returns uuid[] language plpgsql as $$
declare v_session uuid := pg_temp.lr_session(); v_conversation uuid; v_work uuid; v_coding uuid;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_conversation := public.qorpera_select_member_session_account('92400000-0000-4000-8000-000000000010', v_session);
	reset role;
	delete from public.qorpera_member_session_accounts where session_id = v_session;
	perform pg_temp.base_claims('service_role');
	select public.qorpera_sponsor_binding_connection(sponsor.binding_id) into v_work
	from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001',
		'92400000-0000-4000-8000-000000000032', null) as sponsor;
	select login.connection_id into v_coding
	from public.qorpera_coding_owner_login('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001',
		'codex') as login;
	return array[v_conversation, v_work, v_coding];
end $$;
create function pg_temp.lr_expect(p_key text, p_label text) returns void language plpgsql as $$
declare v_choices uuid[] := pg_temp.lr_choices();
begin
	perform pg_temp.base_assert(v_choices = array[pg_temp.lr(p_key), pg_temp.lr(p_key), pg_temp.lr(p_key)],
		format('%s: expected %s for a new conversation, new work and a coding session, got %s (ranks A %s, B %s)', p_label,
			p_key, v_choices, public.qorpera_native_account_rank(pg_temp.lr('a'), 2),
			public.qorpera_native_account_rank(pg_temp.lr('b'), 2)));
end $$;
-- A run of the owner's in this agent's thread, on login A, started on a runner with a lease.
create function pg_temp.lr_run(p_staff uuid) returns jsonb language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, 'Draft the weekly note.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
		'fixture: a run: ' || v_pass::text);
	return pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
end $$;
-- The runner fails a run with the native host's words.
create function pg_temp.lr_fail(p_binding jsonb, p_error text) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	perform public.qorpera_fail_runner_job((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), p_error, false);
	reset role;
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs
		where id = (p_binding ->> 'jobId')::uuid), 'fixture: the run failed');
end $$;
create function pg_temp.lr_refused() returns text language sql as $$
	select 'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]'
$$;

select pg_temp.base_assert(pg_temp.lr_session() is not null, 'Bob''s thread has its session');

-- 1. Room on one scale. A: 50% left of a week that resets in a day (350); B: 97% left of 30 days with 27 to go (about
--    108). The room left alone (97 against 50) took B; now A comes first. With six days to go A has about 58: B.
select pg_temp.lr_usage(pg_temp.lr('a'), 50, 7, 1);
select pg_temp.lr_usage(pg_temp.lr('b'), 3, 30, 27);
do $$
begin
	perform pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.lr('a'), 2) = 50
		and public.qorpera_native_account_remaining(pg_temp.lr('b'), 2) = 97, 'the room left is as before');
	perform pg_temp.base_assert(abs(public.qorpera_native_account_paced_room(pg_temp.lr('a'), 2) - 350) < 1
		and abs(public.qorpera_native_account_paced_room(pg_temp.lr('b'), 2) - 97 / 0.9) < 1,
		format('the room on one scale: A %s, B %s', public.qorpera_native_account_paced_room(pg_temp.lr('a'), 2),
			public.qorpera_native_account_paced_room(pg_temp.lr('b'), 2)));
	perform pg_temp.base_assert(not public.qorpera_native_account_turns_refused(pg_temp.lr('a'))
		and not public.qorpera_native_account_turn_completed(pg_temp.lr('a'))
		and not public.qorpera_native_account_turns_refused(pg_temp.lr('b'))
		and not public.qorpera_native_account_turn_completed(pg_temp.lr('b')), 'no run of A or B has ended yet');
end $$;
select pg_temp.lr_expect('a', 'a week that resets in a day has more room than 30 days');
select pg_temp.lr_usage(pg_temp.lr('a'), 50, 7, 6);
select pg_temp.lr_expect('b', 'with six days to go the week has less room');
-- A reading without the window's length counts its room as it is, and unknown usage comes after measured room.
do $$
begin
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
	values (pg_temp.lr('a'), 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second', 'windows',
		jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 40))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
	perform pg_temp.base_assert(public.qorpera_native_account_paced_room(pg_temp.lr('a'), 2) = 60, 'no length: the room as it is');
	delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.lr('a');
	perform pg_temp.base_assert(public.qorpera_native_account_paced_room(pg_temp.lr('a'), 2) = -1
		and public.qorpera_native_account_rank(pg_temp.lr('a'), 2) > public.qorpera_native_account_rank(pg_temp.lr('b'), 2),
		'unknown usage comes after measured room');
end $$;
select pg_temp.lr_usage(pg_temp.lr('a'), 50, 7, 6);

-- 2. A login known to work. Alice's run on A completes: A comes first, with less room than B, while it has 20% left.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_public_send(v_binding, 'final', 'lr-base-final');
	update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where id = (v_binding ->> 'jobId')::uuid;
	perform pg_temp.base_assert(public.qorpera_native_account_turn_completed(pg_temp.lr('a'))
		and not public.qorpera_native_account_turn_completed(pg_temp.lr('b')), 'A completed a run this week');
end $$;
select pg_temp.lr_expect('a', 'a login known to work comes first');
select pg_temp.lr_usage(pg_temp.lr('a'), 85, 7, 6);
select pg_temp.lr_expect('b', 'a login known to work with 15% left does not come first');
select pg_temp.lr_usage(pg_temp.lr('a'), 50, 7, 6);

-- 3. A's provider refuses its next three runs (Bob's, Carol's and Alice's next): A comes last, also known to work and
--    with room; the member's list says so.
do $$
declare v_staff uuid;
begin
	foreach v_staff in array array['92400000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000032',
		'92400000-0000-4000-8000-000000000030']::uuid[] loop
		perform pg_temp.lr_fail(pg_temp.lr_run(v_staff), pg_temp.lr_refused());
	end loop;
	perform pg_temp.base_assert(public.qorpera_native_account_turns_refused(pg_temp.lr('a'))
		and public.qorpera_native_account_turn_completed(pg_temp.lr('a'))
		and not public.qorpera_native_account_turns_refused(pg_temp.lr('b')), 'A''s last three runs were refused');
end $$;
select pg_temp.lr_expect('b', 'a login whose provider refused its last three runs comes last');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.lr_list',
	public.qorpera_list_member_native_execution_connections('92400000-0000-4000-8000-000000000010')::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
do $$
declare v_list jsonb := current_setting('qorpera_test.lr_list')::jsonb;
begin
	perform pg_temp.base_assert((select jsonb_object_agg(case entry ->> 'connection_id' when pg_temp.lr('a')::text then 'a'
				else 'b' end, entry -> 'recent_turns')
			from jsonb_array_elements(v_list -> 'connections') as entry where (entry ->> 'connection_version')::bigint = 2)
		= '{"a": {"refused": true, "completed": true}, "b": {"refused": false, "completed": false}}'::jsonb,
		'the member''s list reports the recent turns: ' || (v_list -> 'connections')::text);
end $$;

-- 4. Six hours after the last refusal A is chosen as before: it is never switched off.
update public.qorpera_runner_jobs set finished_at = clock_timestamp() - interval '8 hours'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
update public.qorpera_runner_jobs set finished_at = clock_timestamp() - interval '7 hours'
where status = 'failed' and last_error like '%[code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]%'
	and run_id in (select lease.run_id from public.qorpera_native_provider_connection_leases as lease
		where lease.provider_connection_id = pg_temp.lr('a'));
select pg_temp.base_assert(not public.qorpera_native_account_turns_refused(pg_temp.lr('a')), 'refusals older than six hours');
select pg_temp.lr_expect('a', 'six hours after its refusals the login is chosen as before');

-- 5. Another kind of ending breaks the run of refusals: the newest of them now failed on Qorpera's side.
update public.qorpera_runner_jobs set finished_at = clock_timestamp()
where status = 'failed' and last_error like '%[code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]%'
	and run_id in (select lease.run_id from public.qorpera_native_provider_connection_leases as lease
		where lease.provider_connection_id = pg_temp.lr('a'));
select pg_temp.base_assert(public.qorpera_native_account_turns_refused(pg_temp.lr('a')), 'the refusals are recent again');
update public.qorpera_runner_jobs
set last_error = 'Native provider bridge request failed (503) [code=NATIVE_PROMPT_COMPOSITION:TRANSPORT_UNAVAILABLE]'
where id = (select job.id from public.qorpera_runner_jobs as job
	join public.qorpera_native_provider_connection_leases as lease on lease.job_id = job.id
	where lease.provider_connection_id = pg_temp.lr('a') and job.status = 'failed'
	order by job.finished_at desc, job.id desc limit 1);
select pg_temp.base_assert(not public.qorpera_native_account_turns_refused(pg_temp.lr('a')),
	'another kind of ending breaks the run of refusals');
select pg_temp.lr_expect('a', 'a login whose last run failed on Qorpera''s side is chosen as before');

-- 6. The payer functions keep their earlier bodies (and markers), and no API role reads the new functions.
do $$
declare v_role text; v_function text;
begin
	if position('20260930059000' in pg_get_functiondef('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure)) = 0
		or position('20260930059000' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) = 0
		or position('20260930543000' in pg_get_functiondef('public.qorpera_coding_owner_login(uuid,uuid,text)'::regprocedure)) = 0
		or position('20260930551000' in pg_get_functiondef('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure)) = 0
		or position('20260930551000' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) = 0
		or position('20260930551000' in pg_get_functiondef('public.qorpera_coding_owner_login(uuid,uuid,text)'::regprocedure)) = 0
		or position('20260930551000' in pg_get_functiondef('public.qorpera_list_member_native_execution_connections(uuid)'::regprocedure)) = 0
	then
		raise exception 'a first choice lacks its earlier or its 20260930551000 body'; end if;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_native_account_login_connections(uuid)',
			'public.qorpera_native_account_turns_refused(uuid)', 'public.qorpera_native_account_turn_completed(uuid)',
			'public.qorpera_native_account_paced_room_company(uuid,bigint)',
			'public.qorpera_native_account_paced_room(uuid,bigint)', 'public.qorpera_native_account_rank(uuid,bigint)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '% may call %', v_role, v_function; end if;
		end loop;
	end loop;
	if not has_function_privilege('authenticated', 'public.qorpera_list_member_native_execution_connections(uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_coding_owner_login(uuid,uuid,text)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_select_member_session_account(uuid,uuid)', 'execute') then
		raise exception 'the patched functions'' grants changed'; end if;
end $$;

rollback;
