-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3k part 1 (20260930019000): the Company Computer's screens, restarts and power-off on a
-- folder-v2 company. A new computer for an agent, a screen's cleanup event and the office power-off take the company row
-- only KEY SHARE (each is sent while another session holds the row FOR NO KEY UPDATE); a start status is plain reads; the
-- shared-surface and restart gates accept a folder-v2 Company File; a successor activation takes its start's requester
-- before the office. Folder-v2 only (the founder's decision of 3 October). 648's committed fixture; everything is
-- removed at the end.

-- A session holds a row and waits; the fences' helpers, as 850's.
create function pg_temp.hold(p_sql text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', p_sql) as t(x integer);
end $$;
create function pg_temp.release() returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'commit');
end $$;
create function pg_temp.claims(p_conn text, p_role text, p_user text default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text));
end $$;
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
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
-- The company row held FOR NO KEY UPDATE: a KEY SHARE goes through, FOR SHARE, NO KEY UPDATE and FOR UPDATE wait.
create function pg_temp.company_hold(p_company text) returns text language sql as $$
	select format('select 1 from public.qorpera_profiles where id = %L for no key update', '64800000-0000-4000-8000-0000000000' || p_company)
$$;
create function pg_temp.member_hold(p_user text) returns text language sql as $$
	select format('select 1 from public.qorpera_profile_members where profile_id = %L and user_id = %L for no key update',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000' || p_user)
$$;
create function pg_temp.office_free() returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_runtime_offices where id = %L for update',
		current_setting('qorpera_test.office_id')))
$$;

create function pg_temp.request(p_kind text) returns jsonb language sql as $$
	select jsonb_build_object('kind', p_kind, 'predecessor', jsonb_build_object('startup',
		jsonb_build_object('scope', current_setting('qorpera_test.scope')::jsonb)),
		'attestation', jsonb_build_object('activationId', '89400000-0000-4000-8000-0000000000f1'))
$$;

select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');

-- The company's computer, started by its owner and brought up by the provider (893's chain, uncontended).
do $$
declare v_office jsonb; v_scope text; v_generation text; v_answer text;
begin
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
		'64800000-0000-4000-8000-000000000020', '89400000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
	v_office := v_answer::jsonb;
	v_scope := (v_office - 'state')::text;
	v_generation := (select generation::text from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid);
	perform set_config('qorpera_test.scope', v_scope, false);
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.generation', v_generation, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_set_runtime_office_provider(%L, %s, %L, %L, 0, true)::text',
		v_scope, v_generation, '89400000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '89400000-0000-4000-8000-0000000000d4'));
	if v_answer !~ '"state": "requested"' then raise exception 'Setup: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89400000-0000-4000-8000-0000000000d4', '89400000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '89400000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'Setup: the provider reserves the start: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89400000-0000-4000-8000-0000000000d4', '89400000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
		'89400000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]', jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1',
			'activationId', '89400000-0000-4000-8000-0000000000f1', 'bootId', '89400000-0000-4000-8000-0000000000f2',
			'preparationObservationSha256', repeat('1', 64), 'configurationObservationSha256', repeat('2', 64),
			'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64), 'nativePort', 5900, 'viewerPort', 6080)));
	if v_answer !~ '"state": "prepared"' then raise exception 'Setup: the provider prepares the activation: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '89400000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '89400000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '89400000-0000-4000-8000-0000000000f1'));
	if v_answer !~ '"state": "ready"' then raise exception 'Setup: the computer reports ready: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
		v_scope, v_generation, '89400000-0000-4000-8000-0000000000d4', '89400000-0000-4000-8000-0000000000f1',
		'89400000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
	if (select state from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid) <> 'active' then
		raise exception 'Setup: the computer is active: %', v_answer; end if;
end $$;

-- A. A member's start status is plain reads: with the folder fence, the computer and the owner's member row all held
--    FOR UPDATE, it answers at once.
select pg_temp.hold($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
	for update$q$);
select * from dblink('fence_one', format('select 1 from public.qorpera_runtime_offices where id = %L for update',
	current_setting('qorpera_test.office_id'))) as t(x integer);
select * from dblink('fence_one', $q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
	and user_id = '64800000-0000-4000-8000-000000000001' for update$q$) as t(x integer);
do $$
declare v_answer text := pg_temp.settled('fence_two', format('select public.qorpera_runtime_office_start_status(%L)::text',
	current_setting('qorpera_test.scope')));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_two'); end if;
	if v_answer !~ '"officeState": "active"' or v_answer !~ '89400000-0000-4000-8000-0000000000d4' then
		raise exception 'A: start status answers without a lock: %', v_answer; end if;
end $$;

-- B. A screen on the folder-v2 computer: the owner opens Ada's screen, its shared surface passes the gate, and the
--    supervisor's first heartbeat makes its lifetime. Then the screen's cleanup event (DESKTOP_REAPED) takes the machine
--    fence: sent while another session holds the company row, it does not wait.
do $$
declare v_answer text; v_screen public.qorpera_runtime_office_screens%rowtype;
begin
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_open_runtime_office_screen(%L, %L)::text',
		current_setting('qorpera_test.scope'), '64800000-0000-4000-8000-0000000000a1'));
	if v_answer !~ '"state": "open"' then raise exception 'B: the owner opens Ada''s screen: %', v_answer; end if;
	select * into strict v_screen from public.qorpera_runtime_office_screens
	where office_id = current_setting('qorpera_test.office_id')::uuid and staff_agent_id = '64800000-0000-4000-8000-0000000000a1';
	perform set_config('qorpera_test.binding', (current_setting('qorpera_test.scope')::jsonb || jsonb_build_object(
		'computerGeneration', current_setting('qorpera_test.generation')::bigint, 'screenId', v_screen.id,
		'screenOrdinal', v_screen.ordinal, 'screenGeneration', v_screen.generation, 'staffAgentId', v_screen.staff_agent_id))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_check_runtime_office_shared_surface(%L)::text',
		current_setting('qorpera_test.binding')));
	if v_answer !~ '"state": "authorized"' then raise exception 'B: the shared surface passes its gate: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_record_runtime_screen_event(%L, %L, null, %L)::text',
		current_setting('qorpera_test.startup'), current_setting('qorpera_test.binding'), jsonb_build_object(
			'lifetimeId', '89400000-0000-4000-8000-0000000000c1', 'eventId', '89400000-0000-4000-8000-0000000000e1', 'sequence', 1,
			'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'state', 'requested', 'reason', 'SCREEN_REQUESTED')));
	if not exists (select 1 from public.qorpera_runtime_screen_lifetimes where id = '89400000-0000-4000-8000-0000000000c1') then
		raise exception 'B: the first heartbeat makes the screen''s lifetime: %', v_answer; end if;
end $$;
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_three', format('select public.qorpera_record_runtime_screen_event(%L, %L, null, %L)::text',
	current_setting('qorpera_test.startup'), current_setting('qorpera_test.binding'), jsonb_build_object(
		'lifetimeId', '89400000-0000-4000-8000-0000000000c1', 'eventId', '89400000-0000-4000-8000-0000000000e2', 'sequence', 2,
		'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'state', 'closed', 'reason', 'DESKTOP_REAPED')));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_three'); end if;
	if v_answer = 'WAITED' or v_answer like '40P01%' then
		raise exception 'B: the screen''s cleanup event takes no company row FOR UPDATE: %', v_answer; end if;
end $$;

-- B2. Observation retention takes the machine fence: the observer's record of a heartbeat on that screen, sent while
--     another session holds the company row, gets past its identity checks to the fence and does not wait.
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_three', format('select public.qorpera_retain_runtime_screen_observation(%L)::text',
	jsonb_build_object('schema', 'qorpera.runtime-screen-observation/v1', 'startup', current_setting('qorpera_test.startup')::jsonb,
		'binding', current_setting('qorpera_test.binding')::jsonb, 'privacy', null, 'event', jsonb_build_object(
			'lifetimeId', '89400000-0000-4000-8000-0000000000c1', 'eventId', '89400000-0000-4000-8000-0000000000e3', 'sequence', 3,
			'observedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'state', 'ready', 'reason', 'SCREEN_HEARTBEAT'))::text));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_three'); end if;
	if v_answer = 'WAITED' or v_answer like '22023 %' or v_answer like '42501 Retained invocation%' then
		raise exception 'B2: retention reaches its fence and takes no company row FOR UPDATE: %', v_answer; end if;
end $$;

-- C. The office power-off's node suspend takes the machine fence: sent while another session holds the company row, it
--    does not wait (it then refuses for its made-up provider).
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_three', format(
	'select public.qorpera_suspend_runtime_node_machine(%L, %L, %L, %L, %L, %L)::text', '89400000-0000-4000-8000-0000000000a9',
	'office-provider', repeat('f', 64), repeat('c', 64), repeat('e', 64), '89400000-0000-4000-8000-0000000000e9'));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_three'); end if;
	if v_answer = 'WAITED' then raise exception 'C: the node suspend takes no company row FOR UPDATE'; end if;
end $$;

-- D. The restart gate accepts a ready folder-v2 Company File: with the computer in maintenance and nothing left on its
--    surfaces, the restart check gets past the gate to the allocation.
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'maintenance' where id = current_setting('qorpera_test.office_id')::uuid;
update public.qorpera_runtime_office_screens set power = 'closed', lease_id = null
where office_id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
do $$
declare v_answer text := 'ok';
begin
	begin
		perform public.qorpera_check_runtime_office_restart_surfaces((select activation from public.qorpera_runtime_office_activations
			as activation where activation.activation_id = '89400000-0000-4000-8000-0000000000f1'));
	exception when others then v_answer := sqlstate || ' ' || sqlerrm;
	end;
	if v_answer <> 'ok' then raise exception 'D: the restart check passes its gate and finds the allocation: %', v_answer; end if;
end $$;

-- E. A member's new computer for an agent (member_agent_office's 'new' branch) takes the machine fence, never the gc
--    fence: with scale-out on and the only computer in maintenance (no seat for Ada now), the owner's ask is sent while
--    another session holds the company row, and adds the company's second computer without waiting.
select set_config('qorpera_test.scale_out', (select enabled::text from public.qorpera_runtime_office_scale_out where singleton), false);
update public.qorpera_runtime_office_scale_out set enabled = true where singleton;
select pg_temp.hold(pg_temp.company_hold('10'));
do $$
declare v_answer text := pg_temp.settled('fence_two', format('select public.qorpera_member_agent_office(%L, %L)::text',
	'64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-0000000000a1'));
begin
	perform pg_temp.release();
	if v_answer = 'WAITED' then perform pg_temp.outcome('fence_two'); end if;
	if v_answer = 'WAITED' or v_answer !~ '"computers": 2' then
		raise exception 'E: a new computer for an agent takes its locks without waiting: %', v_answer; end if;
end $$;
update public.qorpera_runtime_office_scale_out set enabled = current_setting('qorpera_test.scale_out')::boolean where singleton;

-- F. A successor activation (a restart, a reset or a host reboot) takes its activation's start before the office: each
--    is sent while the owner's member row is held (the start's requester, a role change in flight), waits there holding
--    no office, and then goes on (its made-up request is refused by the status check; never 40P01).
do $$
declare v_call record; v_outcome text;
begin
	for v_call in select * from (values
		('restart', 'qorpera_activate_runtime_office_successor'),
		('reset', 'qorpera_activate_runtime_office_reset_successor'),
		('boot', 'qorpera_activate_runtime_office_boot_successor')) as c(kind, fn)
	loop
		perform pg_temp.hold(pg_temp.member_hold('01'));
		perform dblink_send_query('fence_three', format('select public.%I(%L, %L)::text', v_call.fn, pg_temp.request(v_call.kind),
			repeat('5', 32)));
		if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_members') or not pg_temp.office_free() then
			perform pg_temp.release(); raise exception 'F: the % successor must wait at the member row before the office', v_call.kind; end if;
		perform pg_temp.release();
		v_outcome := pg_temp.outcome('fence_three');
		if v_outcome like '40P01%' then raise exception 'F: the % successor deadlocked: %', v_call.kind, v_outcome; end if;
	end loop;
end $$;

-- G. Exactly the patched functions and the successor's prelude name this migration.
do $$
begin
	if (select count(*) from pg_proc where prosrc ~ '20260930019000') <> 14 then
		raise exception 'G: 13 patched functions and the successor''s prelude name 20260930019000 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930019000'); end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 850 does), the screen's events first (they name only its lifetime).
delete from public.qorpera_runtime_screen_events where lifetime_id = '89400000-0000-4000-8000-0000000000c1';
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
