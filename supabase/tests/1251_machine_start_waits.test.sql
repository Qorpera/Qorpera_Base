-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930755000 (agent-box B1 follow-up): each machine_start's wait for its machine is kept where a release can count it.
-- On 924's base (Alice's live conversation run):
-- 1. qorpera_native_machine_manage, action `waited`: one row for the run's report, column by column (the run, its agent,
--    a conversation's run, whether the model asked, the limit, the state the start answered and why it waited, how long,
--    how it ended, the state after); the answer says recorded.
-- 2. Which machine: the one the start answered, by its id, of the run's company and of that name; a removed one too (a
--    wait that ended `gone`), also after a new machine took its name (review r1 F1 of #1771); another company's, a wrong
--    name or an unknown id never: recorded false and no row.
-- 3. Every malformed report is refused (22023) and writes nothing: a missing or extra key, a value of the wrong kind or
--    out of bounds, an outcome or a state not known; the request takes no other key.
-- 4. Rows older than 30 days go as a report is added; younger ones stay.
-- 5. The table and the check are internal; the patched body names the migration; status, list, stop and delete answer
--    as before.

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'w1-ack') \g /dev/null

create function pg_temp.w_binding() returns jsonb language sql as $$ select current_setting('qorpera_test.base_binding')::jsonb $$;
create function pg_temp.w_run() returns uuid language sql as $$ select (pg_temp.w_binding() ->> 'runId')::uuid $$;
-- A report as the runtime sends it (cloud-machine-tools.ts), changed by p_change.
create function pg_temp.w_wait(p_change jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('asked', false, 'limitSeconds', 60, 'stateBefore', 'waiting', 'waitingFor', 'NODE_CAPACITY_EXHAUSTED',
		'waitedMs', 21744, 'outcome', 'running', 'stateAfter', 'running') || p_change
$$;
-- The report of a wait for the machine named p_machine (its id: the company's live machine of that name unless p_id).
create function pg_temp.w_report(p_machine text, p_wait jsonb, p_id uuid default null) returns jsonb language sql as $$
	select public.qorpera_native_machine_manage(pg_temp.w_binding(),
		jsonb_build_object('action', 'waited', 'machine', p_machine, 'wait', p_wait, 'machineId', coalesce(p_id,
			(select id from public.qorpera_company_machines where name = p_machine and removed_at is null
				and profile_id = '92400000-0000-4000-8000-000000000010'), extensions.gen_random_uuid())))
$$;
create function pg_temp.w_rows() returns bigint language sql as $$ select count(*) from public.qorpera_company_machine_start_waits $$;
-- A machine as the rows say: Alice's, of 924's company unless another is named.
create function pg_temp.w_machine(p_name text, p_profile uuid default '92400000-0000-4000-8000-000000000010',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns uuid language sql as $$
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
		desired_state, desired_by)
	values (extensions.gen_random_uuid(), p_profile, p_environment, p_name, 'A machine', '92400000-0000-4000-8000-000000000030',
		null, null, '92400000-0000-4000-8000-000000000001', 2, 4294967296, 42949672960, 'standard', 'task', 'running', 'agent')
	returning id
$$;

-- 1. One row for one report ---------------------------------------------------------------------------------------------
do $$
declare v_machine uuid := pg_temp.w_machine('research-word-count'); v jsonb; v_row public.qorpera_company_machine_start_waits;
begin
	v := pg_temp.w_report('research-word-count', pg_temp.w_wait());
	perform pg_temp.base_assert(v = '{"schema":"qorpera.machine-wait/v1","recorded":true}'::jsonb, '1: recorded: ' || v::text);
	select * into strict v_row from public.qorpera_company_machine_start_waits;
	perform pg_temp.base_assert(v_row.machine_id = v_machine and v_row.profile_id = '92400000-0000-4000-8000-000000000010'
		and v_row.environment_id = '92400000-0000-4000-8000-000000000020' and v_row.run_id = pg_temp.w_run()
		and v_row.staff_agent_id = '92400000-0000-4000-8000-000000000030' and not v_row.worker and not v_row.asked
		and v_row.limit_seconds = 60 and v_row.state_before = 'waiting' and v_row.waiting_for = 'NODE_CAPACITY_EXHAUSTED'
		and v_row.waited_ms = 21744 and v_row.outcome = 'running' and v_row.state_after = 'running'
		and v_row.created_at <= clock_timestamp(), '1: the row: ' || to_jsonb(v_row)::text);
	-- Every outcome and both states the runtime sends, a null waitingFor, the bounds.
	v := pg_temp.w_report('research-word-count', pg_temp.w_wait('{"asked":true,"limitSeconds":0,"stateBefore":"starting",
		"waitingFor":null,"waitedMs":0,"outcome":"not_asked","stateAfter":"starting"}'));
	perform pg_temp.base_assert(v ->> 'recorded' = 'true', '1: not asked');
	perform pg_temp.w_report('research-word-count', pg_temp.w_wait(jsonb_build_object('outcome', o, 'limitSeconds', 300,
		'waitedMs', 600000, 'stateAfter', 'deleted')))
	from unnest(array['limit', 'hours', 'stopped', 'gone', 'work_stopped']) o;
	perform pg_temp.base_assert(pg_temp.w_rows() = 7 and (select count(distinct outcome) from public.qorpera_company_machine_start_waits) = 7,
		'1: every outcome: ' || pg_temp.w_rows());
end $$;

-- 2. Which machine -----------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_gone uuid; v_new uuid; v_rows bigint := pg_temp.w_rows();
begin
	-- None of that name: not recorded.
	v := pg_temp.w_report('nobody', pg_temp.w_wait());
	perform pg_temp.base_assert(v = '{"schema":"qorpera.machine-wait/v1","recorded":false}'::jsonb and pg_temp.w_rows() = v_rows,
		'2: no such machine: ' || v::text);
	-- Another company's machine of the name is never this run's.
	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values ('12510000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000005');
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('12510000-0000-4000-8000-000000000020', '12510000-0000-4000-8000-000000000010', 'Environment', 1,
		'92400000-0000-4000-8000-000000000005');
	v := pg_temp.w_report('elsewhere', pg_temp.w_wait(), pg_temp.w_machine('elsewhere', '12510000-0000-4000-8000-000000000010',
		'12510000-0000-4000-8000-000000000020'));
	perform pg_temp.base_assert(v ->> 'recorded' = 'false' and pg_temp.w_rows() = v_rows, '2: another company''s: ' || v::text);
	-- The id of a machine of this company, under another name: not recorded.
	v := pg_temp.w_report('not-its-name', pg_temp.w_wait(), (select id from public.qorpera_company_machines
		where name = 'research-word-count'));
	perform pg_temp.base_assert(v ->> 'recorded' = 'false' and pg_temp.w_rows() = v_rows, '2: a wrong name: ' || v::text);
	-- A machine removed while its start waited (the wait ended gone), and a new machine that took its name before the
	-- report came: the report is the removed one's.
	v_gone := pg_temp.w_machine('shard-1');
	update public.qorpera_company_machines set desired_state = 'deleted', removed_at = clock_timestamp() where id = v_gone;
	v_new := pg_temp.w_machine('shard-1');
	v := pg_temp.w_report('shard-1', pg_temp.w_wait('{"outcome":"gone","stateAfter":"deleted"}'), v_gone);
	perform pg_temp.base_assert(v ->> 'recorded' = 'true' and (select machine_id from public.qorpera_company_machine_start_waits
		order by created_at desc, id limit 1) = v_gone
		and not exists (select 1 from public.qorpera_company_machine_start_waits where machine_id = v_new),
		'2: the removed machine, not the new one of its name: ' || v::text);
	perform pg_temp.w_report('shard-1', pg_temp.w_wait());
	perform pg_temp.base_assert((select count(*) from public.qorpera_company_machine_start_waits where machine_id = v_new) = 1,
		'2: the new one by its own id');
end $$;

-- 3. Malformed reports write nothing ----------------------------------------------------------------------------------------
do $$
declare v_rows bigint := pg_temp.w_rows(); v_bad jsonb;
begin
	foreach v_bad in array array[
		pg_temp.w_wait() - 'asked', pg_temp.w_wait('{"extra":1}'), pg_temp.w_wait('{"asked":"no"}'),
		pg_temp.w_wait('{"limitSeconds":301}'), pg_temp.w_wait('{"limitSeconds":-1}'), pg_temp.w_wait('{"limitSeconds":1.5}'),
		pg_temp.w_wait('{"limitSeconds":"60"}'), pg_temp.w_wait('{"waitedMs":600001}'), pg_temp.w_wait('{"waitedMs":-5}'),
		pg_temp.w_wait('{"stateBefore":"running"}'), pg_temp.w_wait('{"stateBefore":null}'), pg_temp.w_wait('{"waitingFor":"lower"}'),
		pg_temp.w_wait('{"waitingFor":7}'), pg_temp.w_wait('{"outcome":"done"}'), pg_temp.w_wait('{"stateAfter":"Running"}'),
		pg_temp.w_wait('{"stateAfter":null}'), '[]'::jsonb, '"waited"'::jsonb, 'null'::jsonb] loop
		perform pg_temp.base_error(format('select pg_temp.w_report(%L, %L::jsonb)', 'research-word-count', v_bad), '22023');
	end loop;
	perform pg_temp.base_error(format('select public.qorpera_native_machine_manage(%L::jsonb, %L::jsonb)', pg_temp.w_binding(),
		jsonb_build_object('action', 'waited', 'machine', 'research-word-count', 'machineId', extensions.gen_random_uuid(),
			'wait', pg_temp.w_wait(), 'more', 1)), '22023');
	-- No id, or not an id.
	perform pg_temp.base_error(format('select public.qorpera_native_machine_manage(%L::jsonb, %L::jsonb)', pg_temp.w_binding(),
		jsonb_build_object('action', 'waited', 'machine', 'research-word-count', 'wait', pg_temp.w_wait())), '22023');
	perform pg_temp.base_error(format('select public.qorpera_native_machine_manage(%L::jsonb, %L::jsonb)', pg_temp.w_binding(),
		jsonb_build_object('action', 'waited', 'machine', 'research-word-count', 'machineId', 'not-an-id', 'wait', pg_temp.w_wait())),
		'22023');
	perform pg_temp.base_error(format('select public.qorpera_native_machine_manage(%L::jsonb, %L::jsonb)', pg_temp.w_binding(),
		jsonb_build_object('action', 'waited', 'machine', 'research-word-count', 'machineId', extensions.gen_random_uuid())),
		'22023');
	perform pg_temp.base_error(format('select public.qorpera_native_machine_manage(%L::jsonb, %L::jsonb)', pg_temp.w_binding(),
		jsonb_build_object('action', 'waited', 'machine', 'Bad Name', 'machineId', extensions.gen_random_uuid(),
			'wait', pg_temp.w_wait())), '22023');
	perform pg_temp.base_assert(pg_temp.w_rows() = v_rows, '3: nothing written');
end $$;

-- 4. Rows older than 30 days go ---------------------------------------------------------------------------------------------
do $$
declare v_rows bigint;
begin
	update public.qorpera_company_machine_start_waits set created_at = clock_timestamp() - interval '31 days'
	where id in (select id from public.qorpera_company_machine_start_waits order by created_at, id limit 2);
	update public.qorpera_company_machine_start_waits set created_at = clock_timestamp() - interval '29 days'
	where id in (select id from public.qorpera_company_machine_start_waits where created_at > clock_timestamp() - interval '30 days'
		order by created_at, id limit 1);
	v_rows := pg_temp.w_rows();
	perform pg_temp.w_report('research-word-count', pg_temp.w_wait());
	perform pg_temp.base_assert(pg_temp.w_rows() = v_rows - 1
		and not exists (select 1 from public.qorpera_company_machine_start_waits where created_at < clock_timestamp() - interval '30 days')
		and exists (select 1 from public.qorpera_company_machine_start_waits where created_at < clock_timestamp() - interval '28 days'),
		'4: the two old rows went, the 29-day one stayed: ' || pg_temp.w_rows() || ' of ' || v_rows);
end $$;

-- 5. Internal, the marker, the other actions -------------------------------------------------------------------------------
do $$
declare v jsonb;
begin
	perform pg_temp.base_assert(not has_table_privilege('anon', 'public.qorpera_company_machine_start_waits', 'select')
		and not has_table_privilege('authenticated', 'public.qorpera_company_machine_start_waits', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_company_machine_start_waits', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_company_machine_start_waits', 'insert'),
		'5: the table is internal');
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_valid_machine_start_wait(jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_valid_machine_start_wait(jsonb)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_valid_machine_start_wait(jsonb)', 'execute'),
		'5: the check is internal');
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure),
			'20260930755000') > 0
		and strpos(pg_get_functiondef('public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure), '20260930747000') > 0
		and strpos(pg_get_functiondef('public.qorpera_valid_machine_start_wait(jsonb)'::regprocedure), '20260930755000') > 0,
		'5: the markers');
	v := public.qorpera_native_machine_manage(pg_temp.w_binding(), '{"action":"status","machine":"research-word-count"}');
	perform pg_temp.base_assert(v #>> '{machine,name}' = 'research-word-count', '5: status as before: ' || v::text);
	v := public.qorpera_native_machine_manage(pg_temp.w_binding(), '{"action":"list"}');
	perform pg_temp.base_assert(jsonb_array_length(v -> 'machines') >= 2, '5: list as before');
	v := public.qorpera_native_machine_manage(pg_temp.w_binding(), '{"action":"stop","machine":"research-word-count"}');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.machine-change/v1', '5: stop as before: ' || v::text);
	perform pg_temp.base_error(format('select public.qorpera_native_machine_manage(%L::jsonb, %L::jsonb)', pg_temp.w_binding(),
		'{"action":"status","machine":"research-word-count","wait":{}}'), '22023');
end $$;

rollback;
