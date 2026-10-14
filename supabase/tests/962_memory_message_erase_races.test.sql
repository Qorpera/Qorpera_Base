-- @fixture 944_memory_zoom_erase_race.test.sql until "-- A. The erase first"
-- Summary trees M3 (RUNTIME-AGENT-MEMORY-TREE.md §10; 20260930320000) under concurrency, on 944's committed thread. Step 1
-- takes the conversation's session FOR UPDATE and reads receipts in a later statement; a zoom stores its receipt, then
-- takes the session FOR SHARE. So an erase first makes the zoom wait and read the erased event (its run is not the
-- erase's), and a zoom first makes step 1 wait and record the zoom's run. Step 4's scrub takes each operation receipt
-- SKIP LOCKED: one held elsewhere leaves the run pending, and the next scrub ends it. Ada's thread has no room, so the
-- erase rows are written here as the request would write them (owner ...01). The fixture goes at the end.

-- An erase row of a message of Ada's thread, as the request writes it.
create function pg_temp.erase_row(p_seq integer) returns uuid language sql as $$
	insert into public.qorpera_memory_message_erases(environment_id, profile_id, session_id, event_id, sequence, message_index,
		requested_by_user_id)
	values ('64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000f7',
		('94400000-0000-4000-8000-e' || lpad(p_seq::text, 11, '0'))::uuid, p_seq, p_seq - 1, '64800000-0000-4000-8000-000000000001')
	returning id
$$;
create function pg_temp.sql_open(p_id uuid) returns text language sql as $$
	select format('select public.qorpera_memory_message_erase_open(%L, %L)::text', '64800000-0000-4000-8000-000000000020', p_id)
$$;
create function pg_temp.erase_state(p_id uuid) returns jsonb language sql as $$
	select public.qorpera_memory_message_erase_status('64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000001',
		p_id) - 'eraseId' - 'sessionId'
		- 'eventId' - 'schema'
$$;
create function pg_temp.generation() returns bigint language sql as $$
	select memory_generation from public.qorpera_shared_sessions where id = '64800000-0000-4000-8000-0000000000f7'
$$;
create function pg_temp.op_content(p_call text) returns text language sql as $$
	select result #>> '{content,value}' from public.qorpera_run_operation_receipts
	where run_id = '64800000-0000-4000-8000-0000000000f1' and logical_operation_key = p_call
$$;
select set_config('qorpera_test.generation', pg_temp.generation()::text, false);

-- A. Step 1 first. fence_one has opened the erase of the first message and holds the session FOR UPDATE; fence_two's zoom of
-- it stores its receipt and waits at the session, and once the erase commits it reads the erased event. Step 1's receipt
-- scan ran before that receipt was committed, so the erase records no run.
select set_config('qorpera_test.erase_a', pg_temp.erase_row(1)::text, false);
select dblink_exec('fence_one', 'begin');
do $$
declare r jsonb := (select x::jsonb from dblink('fence_one', pg_temp.sql_open(current_setting('qorpera_test.erase_a')::uuid))
	as t(x text));
begin
	if r ->> 'state' <> 'open' or r ->> 'runsPending' <> '0' then raise exception 'A: step 1 opened: %', r; end if;
end $$;
select dblink_send_query('fence_two', pg_temp.sql_zoom('{"callId":"race-a","line":"0+1"}'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A: the zoom did not wait for step 1'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'A: the zoom waits at %, not at the session', pg_temp.queued_on('fence_two'); end if;
end $$;
select dblink_exec('fence_one', 'commit');
do $$
declare r jsonb;
begin
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then raise exception 'A: the zoom did not end'; end if;
	r := pg_temp.answer('fence_two');
	if r -> 'event' ->> 'erased' <> 'true' or r -> 'event' ->> 'text' is not null or r -> 'event' ->> 'sequence' <> '1' then
		raise exception 'A: the zoom after step 1 reads: %', r; end if;
	if pg_temp.receipt('race-a') is distinct from '0+1' then raise exception 'A: the receipt is %', pg_temp.receipt('race-a'); end if;
	if pg_temp.erase_state(current_setting('qorpera_test.erase_a')::uuid) <> '{"state":"open","blocks":0,"runsPending":0}'
		or exists (select 1 from public.qorpera_memory_message_erase_runs where erase_id = current_setting('qorpera_test.erase_a')::uuid)
		or pg_temp.generation() <> current_setting('qorpera_test.generation')::bigint + 1 then
		raise exception 'A: the erase after the zoom: %', pg_temp.erase_state(current_setting('qorpera_test.erase_a')::uuid); end if;
end $$;

-- B. The zoom first. fence_two's zoom of the second message is open (its receipt stored, the session FOR SHARE); step 1 in
-- fence_one waits for it at the session, then finds the receipt in its later statement and records the run.
select set_config('qorpera_test.erase_b', pg_temp.erase_row(2)::text, false);
select dblink_exec('fence_two', 'begin');
do $$
declare r jsonb := (select x::jsonb from dblink('fence_two', pg_temp.sql_zoom('{"callId":"race-b","line":"1+1"}')) as t(x text));
begin
	if r -> 'event' ->> 'text' is distinct from 'two' or r -> 'event' ->> 'erased' <> 'false' then
		raise exception 'B: the open zoom reads: %', r; end if;
end $$;
select dblink_exec('fence_one', 'begin');
select dblink_send_query('fence_one', pg_temp.sql_open(current_setting('qorpera_test.erase_b')::uuid));
do $$
begin
	if not pg_temp.waits_for('fence_one', 'fence_two') then raise exception 'B: step 1 did not wait for the zoom'; end if;
	if pg_temp.queued_on('fence_one') is distinct from 'public.qorpera_shared_sessions'::regclass then
		raise exception 'B: step 1 waits at %, not at the session', pg_temp.queued_on('fence_one'); end if;
end $$;
select dblink_exec('fence_two', 'commit');
do $$
declare r jsonb;
begin
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'B: step 1 did not end'; end if;
	r := pg_temp.answer('fence_one');
	if r ->> 'state' <> 'open' or r ->> 'runsPending' <> '1' then raise exception 'B: step 1 after the zoom: %', r; end if;
end $$;
select dblink_exec('fence_one', 'commit');
do $$
declare r jsonb := public.qorpera_memory_zoom(current_setting('qorpera_test.binding')::jsonb, '{"callId":"race-b2","line":"1+1"}');
begin
	if (select jsonb_agg(rr.call_id order by rr.call_id) from public.qorpera_memory_message_erase_runs t
			join public.qorpera_memory_read_receipts rr on rr.id = any (t.read_receipt_ids)
			where t.erase_id = current_setting('qorpera_test.erase_b')::uuid and t.run_id = '64800000-0000-4000-8000-0000000000f1'
				and t.state = 'pending') is distinct from '["race-b"]'::jsonb then
		raise exception 'B: the run table holds the zoom''s receipt'; end if;
	if r -> 'event' ->> 'erased' <> 'true' or pg_temp.generation() <> current_setting('qorpera_test.generation')::bigint + 2 then
		raise exception 'B: a later zoom reads: %', r; end if;
end $$;

-- C. Step 4 against a held operation receipt. The zoom race-b returned through a tool call whose operation receipt fence_three
-- holds FOR UPDATE: the scrub skips it (SKIP LOCKED, so it never waits) and the run stays pending; the next scrub ends it.
do $$
declare v_op uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, result, completed_at)
	values (v_op, '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f2',
		'64800000-0000-4000-8000-0000000000f5', 'race-b', 'cloud_tool', repeat('a', 64), repeat('e', 64), 'completed',
		jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'callId', 'race-b',
			'content', jsonb_build_object('kind', 'text', 'value', 'message 2 said two')), clock_timestamp());
	update public.qorpera_memory_read_receipts set operation_receipt_id = v_op
	where run_id = '64800000-0000-4000-8000-0000000000f1' and call_id = 'race-b';
	-- The run ends: its job failed.
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), lease_token_sha256 = null,
		lease_expires_at = null
	where id = '64800000-0000-4000-8000-0000000000f2';
	set local session_replication_role = origin;
	perform set_config('qorpera_test.op_b', v_op::text, false);
end $$;
do $$
declare
	v_id uuid := current_setting('qorpera_test.erase_b')::uuid;
	v_plan jsonb := public.qorpera_memory_message_erase_plan('64800000-0000-4000-8000-000000000020', v_id);
	r jsonb;
begin
	r := public.qorpera_memory_message_erase_rewrite('64800000-0000-4000-8000-000000000020', v_id, v_plan ->> 'planSha256', '[]');
	if r ->> 'state' <> 'rewritten' then raise exception 'C: the rewrite: %', r; end if;
	r := public.qorpera_memory_message_erase_ask('64800000-0000-4000-8000-000000000020', v_id);
	if r ->> 'state' <> 'requested' then raise exception 'C: the ask: %', r; end if;
end $$;
select dblink_exec('fence_three', 'begin');
do $$
begin
	if (select x from dblink('fence_three', format('select 1 from public.qorpera_run_operation_receipts where id = %L for update',
			current_setting('qorpera_test.op_b'))) as t(x integer)) is distinct from 1 then
		raise exception 'C: fence_three holds no receipt'; end if;
end $$;
do $$
declare r jsonb := public.qorpera_memory_message_erase_scrub('64800000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.erase_b')::uuid);
begin
	if r ->> 'state' <> 'requested' or r ->> 'runsPending' <> '1' or pg_temp.op_content('race-b') <> 'message 2 said two' then
		raise exception 'C: the scrub past a held receipt: % (%)', r, pg_temp.op_content('race-b'); end if;
end $$;
select dblink_exec('fence_three', 'commit');
do $$
declare r jsonb := public.qorpera_memory_message_erase_scrub('64800000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.erase_b')::uuid);
begin
	if r ->> 'state' <> 'done' or r ->> 'runsPending' <> '0' or pg_temp.op_content('race-b') <> '[erased]'
		or pg_temp.erase_state(current_setting('qorpera_test.erase_b')::uuid) <> '{"state":"done","blocks":0,"runsPending":0}' then
		raise exception 'C: the next scrub: % (%)', r, pg_temp.op_content('race-b'); end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 919 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_memory_message_erase_blocks where erase_id in
		(select id from public.qorpera_memory_message_erases where environment_id = any (v_envs));
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
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
		or exists (select 1 from public.qorpera_memory_read_receipts where run_id = '64800000-0000-4000-8000-0000000000f1')
		or exists (select 1 from public.qorpera_session_events where session_id = '64800000-0000-4000-8000-0000000000f7')
		or exists (select 1 from public.qorpera_memory_message_erases where session_id = '64800000-0000-4000-8000-0000000000f7')
		or exists (select 1 from public.qorpera_memory_message_erase_runs where run_id = '64800000-0000-4000-8000-0000000000f1')
		or exists (select 1 from public.qorpera_run_operation_receipts where run_id = '64800000-0000-4000-8000-0000000000f1') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
