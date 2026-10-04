-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- 20260930040000: a run keeps the Company Computer awake only while it is in use (the 2026-10-03 amendment "one idle
-- rule for every machine", item 1), on a folder-v2 company's computer (folder-v2 only, the founder's decision of 3
-- October). A run is in use while its job is leased and it made progress in the last 15 minutes
-- (gap 4's clock), or while a model request is in flight. A long single model request under a live computer lease
-- keeps the computer awake; an idle run's lease keeps its seat while the computer may sleep; a queued turn still
-- counts. 648's committed fixture; the company's computer is registered, started and activated as 894 does, and Ada's
-- screen opened by the owner. Ada's run records are synthetic. Everything is removed at the end.

create function pg_temp.check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Runs in use: %', p_message; end if; end
$$;
create function pg_temp.refused(p_sql text, p_state text, p_message text default null) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		raise exception 'Expected SQLSTATE % (%), got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE % (%), but it succeeded: %', p_state, p_message, p_sql;
end $$;
create function pg_temp.claims(p_conn text, p_role text, p_user text default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text));
end $$;
-- Sends a call and waits up to ten seconds for it to end; its text answer, or the error as "<sqlstate> <message>".
create function pg_temp.settled(p_conn text, p_sql text) returns text language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '10 seconds'; v_answer text;
begin
	perform dblink_send_query(p_conn, p_sql);
	while dblink_is_busy(p_conn) = 1 loop
		if clock_timestamp() > v_until then return 'WAITED'; end if;
		perform pg_sleep(0.02);
	end loop;
	begin
		select r into v_answer from dblink_get_result(p_conn) as t(r text);
	exception when others then v_answer := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return coalesce(v_answer, 'null');
end $$;


-- The company's computer, started by its owner and brought up by the provider (894's chain), and Ada's screen opened
-- by the owner.
select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');
do $$
declare v_office jsonb; v_scope text; v_generation text; v_answer text; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
		'64800000-0000-4000-8000-000000000020', '87100000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
	v_office := v_answer::jsonb;
	v_scope := (v_office - 'state')::text;
	v_generation := (select generation::text from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid);
	perform set_config('qorpera_test.scope', v_scope, false);
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.generation', v_generation, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_set_runtime_office_provider(%L, %s, %L, %L, 0, true)::text',
		v_scope, v_generation, '87100000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '87100000-0000-4000-8000-0000000000d4'));
	if v_answer !~ '"state": "requested"' then raise exception 'Setup: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'87100000-0000-4000-8000-0000000000d4', '87100000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '87100000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'Setup: the provider reserves the start: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'87100000-0000-4000-8000-0000000000d4', '87100000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
		'87100000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]', jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1',
			'activationId', '87100000-0000-4000-8000-0000000000f1', 'bootId', '87100000-0000-4000-8000-0000000000f2',
			'preparationObservationSha256', repeat('1', 64), 'configurationObservationSha256', repeat('2', 64),
			'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64), 'nativePort', 5900, 'viewerPort', 6080)));
	if v_answer !~ '"state": "prepared"' then raise exception 'Setup: the provider prepares the activation: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '87100000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '87100000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '87100000-0000-4000-8000-0000000000f1'));
	if v_answer !~ '"state": "ready"' then raise exception 'Setup: the computer reports ready: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
		v_scope, v_generation, '87100000-0000-4000-8000-0000000000d4', '87100000-0000-4000-8000-0000000000f1',
		'87100000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
	if (select state from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid) <> 'active' then
		raise exception 'Setup: the computer is active: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_open_runtime_office_screen(%L, %L)::text',
		v_scope, '64800000-0000-4000-8000-0000000000a1'));
	if v_answer !~ '"state": "open"' then raise exception 'Setup: the owner opens Ada''s screen: %', v_answer; end if;
	select * into strict v_screen from public.qorpera_runtime_office_screens
	where office_id = (v_office ->> 'companyComputerId')::uuid and staff_agent_id = '64800000-0000-4000-8000-0000000000a1';
	perform set_config('qorpera_test.screen', v_screen.id::text, false);
end $$;
update public.qorpera_runtime_office_screens set touched_at = clock_timestamp() - interval '3 minutes'
where id = current_setting('qorpera_test.screen')::uuid;

create function pg_temp.office() returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices where id = current_setting('qorpera_test.office_id')::uuid
$$;
create function pg_temp.demand() returns boolean language sql as $$
	select public.qorpera_runtime_office_has_demand(pg_temp.office())
$$;
create function pg_temp.seat() returns boolean language sql as $$
	select public.qorpera_runtime_office_screen_in_use(s) from public.qorpera_runtime_office_screens s
	where s.id = current_setting('qorpera_test.screen')::uuid
$$;
create function pg_temp.idle_poll() returns jsonb language sql as $$
	select public.qorpera_reconcile_runtime_office_idle(current_setting('qorpera_test.scope')::jsonb,
		current_setting('qorpera_test.generation')::bigint, '87100000-0000-4000-8000-0000000000b0', repeat('f', 64), 60000)
$$;
-- Ada's leased run, as its harness records it: a record ingested p_ago ago, and a context view made p_ago ago.
create function pg_temp.record(p_operation text, p_phase text, p_ago interval) returns void language sql as $$
	insert into public.qorpera_runtime_observations(run_id, attempt_id, phase, operation, observed_at, ingested_at, observation)
	values ('64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(), p_phase, p_operation, clock_timestamp() - p_ago,
		clock_timestamp() - p_ago, '{}')
$$;
create function pg_temp.view(p_ago interval) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_native_context_views(run_id, ordinal, request_id, view, created_at)
	values ('64800000-0000-4000-8000-0000000000f1',
		coalesce((select max(ordinal) from public.qorpera_native_context_views where run_id = '64800000-0000-4000-8000-0000000000f1'), 0) + 1,
		'request-' || extensions.gen_random_uuid(), '{}', clock_timestamp() - p_ago);
	set local session_replication_role = origin;
end $$;
-- Ada's run holds her screen (a synthetic lease, as the screen tool's acquire leaves it).
create function pg_temp.lease() returns void language sql as $$
	update public.qorpera_runtime_office_screens set lease_id = '87100000-0000-4000-8000-0000000000c1',
		run_id = '64800000-0000-4000-8000-0000000000f1', lease_expires_at = clock_timestamp() + interval '1 minute',
		grant_version = 1, native_binding = '{}', power = 'open'
	where id = current_setting('qorpera_test.screen')::uuid
$$;
-- Ada's job moves to another state, with the columns that state requires. Its substrate is the fixture's made-up one,
-- so foreign keys and triggers are off while it changes, as when the fixture wrote it.
create function pg_temp.job(p_status text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = p_status,
		lease_token_sha256 = case when p_status = 'leased' then lease_token_sha256 end,
		lease_expires_at = case when p_status = 'leased' then lease_expires_at end,
		finished_at = case when p_status = 'failed' then clock_timestamp() end,
		last_error = case when p_status = 'failed' then 'Ended for the test' end
	where id = '64800000-0000-4000-8000-0000000000f2';
	set local session_replication_role = origin;
end $$;
create function pg_temp.in_use() returns boolean language sql as $$
	select public.qorpera_office_run_in_use('64800000-0000-4000-8000-0000000000f1')
$$;

-- 1. A run that has just started is in use: Ada's leased run keeps her computer awake (her default access, placed here).
select pg_temp.check(pg_temp.in_use() and pg_temp.demand(), 'a run that has just started keeps the computer awake');
select pg_temp.check(pg_temp.idle_poll() -> 'request' = 'null', 'the idle policy starts counting');

-- From here the run is 20 minutes old: its job start and its assignment no longer count as recent progress.
update public.qorpera_runner_jobs set started_at = clock_timestamp() - interval '20 minutes'
where id = '64800000-0000-4000-8000-0000000000f2';
update public.qorpera_runner_assignments set created_at = clock_timestamp() - interval '20 minutes'
where id = '64800000-0000-4000-8000-0000000000f5';
select pg_temp.check(not pg_temp.in_use() and not pg_temp.demand(),
	'a run with neither progress nor a model request for 15 minutes is idle and keeps nothing awake');
select pg_temp.check(not pg_temp.seat(), 'nothing holds the seat yet');

-- 2. A long single model request under a live computer lease: the request's context view and result fence are 20
--    minutes old, nothing came after them, and the run holds Ada's screen. It stays in use, and so do the computer and
--    the seat.
begin;
select pg_temp.record('model_turn', 'start', '21 minutes');
select pg_temp.record('native_result_fence', 'start', '20 minutes');
select pg_temp.view('20 minutes');
select pg_temp.record('native_result_fence', 'finish', '20 minutes');
select pg_temp.lease();
select pg_temp.check(pg_temp.in_use() and pg_temp.demand() and pg_temp.seat(),
	'a model request 20 minutes long keeps its run in use, the computer awake and the seat');
select pg_temp.check(public.qorpera_run_no_progress_since('64800000-0000-4000-8000-0000000000f1',
	clock_timestamp() - interval '20 minutes') is not null, 'gap 4''s notice still sees no progress inside the request');
-- Without computer access the lease alone keeps the computer awake, while its run is in use.
update public.qorpera_runtime_office_access set state = 'revoked' where office_id = current_setting('qorpera_test.office_id')::uuid;
select pg_temp.check(pg_temp.demand(), 'the lease of a run in use keeps the computer awake on its own');
select pg_temp.job('queued');
select pg_temp.check(not pg_temp.demand() and pg_temp.seat(), 'a lease whose run is no longer leased keeps nothing awake');
rollback;

-- 3. The run's reply streams: its newest record is a "writing" pulse, older than 15 minutes (a hang inside the request
--    keeps the computer awake until the run ends).
begin;
select pg_temp.record('native_result_fence', 'start', '30 minutes');
select pg_temp.view('30 minutes');
select pg_temp.record('native_result_fence', 'finish', '30 minutes');
-- A record other than the fence after it (the runtime writes none there today): only the pulses then show the reply
-- is still streaming.
select pg_temp.record('company_context', 'start', '25 minutes');
select pg_temp.record('company_context', 'finish', '25 minutes');
select pg_temp.record('message_composition', 'start', '20 minutes');
select pg_temp.record('message_composition', 'finish', '20 minutes');
select pg_temp.record('message_composition', 'start', '19 minutes');
select pg_temp.check(pg_temp.in_use() and pg_temp.demand(), 'a reply still streaming keeps its run in use');
rollback;

-- 4. The run's last tool call ended 20 minutes ago, recorded as the runtime records one (its start, the run's authority
--    check, its end), and the run records nothing more: idle, the computer may sleep, and an idle run's lease still
--    keeps its seat.
begin;
select pg_temp.record('native_result_fence', 'start', '40 minutes');
select pg_temp.view('40 minutes');
select pg_temp.record('native_result_fence', 'finish', '40 minutes');
select pg_temp.record('action_review', 'start', '39 minutes');
select pg_temp.record('action_review', 'finish', '39 minutes');
select pg_temp.record('computer_shell', 'start', '21 minutes');
select pg_temp.record('context_authority', 'start', '21 minutes');
select pg_temp.record('context_authority', 'finish', '21 minutes');
select pg_temp.record('computer_shell', 'finish', '20 minutes');
select pg_temp.lease();
select pg_temp.check(not pg_temp.in_use() and not pg_temp.demand() and pg_temp.seat(),
	'after the tool, nothing for 15 minutes: the run is idle, the computer keeps no demand, the lease keeps its seat');
update public.qorpera_runtime_office_idle_policies set idle_since = clock_timestamp() - interval '2 hours'
where office_id = current_setting('qorpera_test.office_id')::uuid;
select pg_temp.check(pg_temp.idle_poll() #>> '{request,action}' = 'power_off', 'the computer goes to sleep under an idle run''s lease');
rollback;

-- 5. Recent progress keeps the run in use: a tool that ended a minute ago, or a context view a minute ago.
begin;
select pg_temp.record('computer_shell', 'start', '2 minutes');
select pg_temp.record('computer_shell', 'finish', '1 minute');
select pg_temp.check(pg_temp.in_use() and pg_temp.demand(), 'a tool call a minute ago is progress');
rollback;
begin;
select pg_temp.view('1 minute');
select pg_temp.check(pg_temp.in_use() and pg_temp.demand(), 'a context view a minute ago is progress');
rollback;

-- 6. A queued turn still counts, before its job starts; an ended run does not.
begin;
select pg_temp.job('queued');
select pg_temp.check(not pg_temp.in_use() and pg_temp.demand(), 'a queued turn of an agent with access keeps the computer awake');
select pg_temp.job('failed');
select pg_temp.check(not pg_temp.demand(), 'an ended run keeps nothing awake');
rollback;

-- 7. Only the platform runs the helpers, and the demand function names this migration.
select pg_temp.check(not exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
	cross join unnest(array['public.qorpera_office_run_in_use(uuid)','public.qorpera_run_model_request_in_flight(uuid)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute'))
	and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_office_run_in_use(uuid)', 'execute')
	and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_run_model_request_in_flight(uuid)', 'execute'),
	'only the platform runs the helpers');
select pg_temp.check(pg_get_functiondef('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure)
	~ '20260930040000', 'the demand function names this migration');

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 894 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_offices uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	select array_agg(id) into v_offices from public.qorpera_runtime_offices where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('office_id','profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' and c.table_name <> 'qorpera_runtime_offices'
		order by c.column_name = 'office_id' desc loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'office_id' then v_offices when 'profile_id' then v_profiles
			when 'environment_id' then v_envs when 'run_id' then v_runs when 'job_id' then v_jobs
			when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_runtime_offices where id = any (v_offices);
	delete from public.qorpera_logical_computers where profile_id = any (v_profiles);
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_runtime_offices where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_logical_computers where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
