-- @fixture 396_runtime_coding_executor.test.sql until "-- 2. The turn as the runner sees it"
-- One lock order for a coding session's rows (v117): the company's profile fence
-- and Company File, todo, worker, coding session, then the session's turn or
-- machine. Each race makes two real calls meet on one session: a third
-- connection holds one row, the first call starts and waits there, the second
-- starts (and waits, unless it needs nothing the first holds), and the holder
-- lets go. Races 1-5 each ended in "deadlock detected" on the previous function
-- text; race 6 did with an admission that held the todo. With one order neither
-- call is killed: both land, or one is refused for its own plain reason. Two
-- single calls then show what a call no longer waits for. Row locks show only
-- across connections, so the dispatch fixture above is committed here and
-- removed again at the end; the test refuses to run beside other connections to
-- this database, whose rows the cleanup could not tell from its own. A run that
-- fails before its cleanup leaves the fixture committed: CI starts a fresh
-- database each time, but a local database must be rebuilt before a rerun.

-- What the races need outlives this transaction.
reset role;
select set_config(name, current_setting(name), false) from unnest(array['qorpera_test.parent_binding','qorpera_test.coding_claim',
	'qorpera_test.coding_storage','qorpera_test.coding_binding','qorpera_test.coding_vm']) name;
select set_config('qorpera_test.lock_order_first_xid', xid(pg_current_xact_id())::text, false);
-- Three more connections to this same database, whatever the runner named it (a copy made from a
-- template has another name, and its calls would otherwise land in a database without the fixture).
select dblink_connect('lock_holder', 'dbname=' || current_database());
select dblink_connect('lock_first', 'dbname=' || current_database());
select dblink_connect('lock_second', 'dbname=' || current_database());
select set_config('qorpera_test.lock_' || name || '_pid', pid::text, false)
from unnest(array['holder','first','second']) name, lateral dblink('lock_' || name, 'select pg_backend_pid()') as backend(pid integer);
-- Only this connection and its three may use the database while the test runs.
create function pg_temp.lock_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.lock_holder_pid'),
			current_setting('qorpera_test.lock_first_pid'), current_setting('qorpera_test.lock_second_pid'))) then
		raise exception 'Lock order test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.lock_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table lock_order_counts as select * from dblink('lock_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table lock_order_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.lock_order_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.lock_order_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.lock_order_rows select v_table, kept.row_value
			from dblink('lock_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A call runs as the role PostgREST would use, with that role's claims.
create function pg_temp.lock_as(p_connection text, p_claims jsonb) returns void language plpgsql as $$
begin
	perform dblink_exec(p_connection, 'reset role');
	perform dblink_exec(p_connection, format('set request.jwt.claims = %L', p_claims));
	perform dblink_exec(p_connection, format('set role %I', p_claims ->> 'role'));
end
$$;
-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.lock_collect(p_connection text) returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result(p_connection) as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result(p_connection, false) as call(result jsonb);
	return v_outcome;
end
$$;
-- The holder locks one row; the first call starts and must wait, then the second (which may instead
-- finish at once when it needs nothing the first holds); the holder lets go. Each call's result, or its error.
create function pg_temp.lock_race(p_hold text, p_first text, p_first_claims jsonb, p_second text, p_second_claims jsonb,
	p_second_waits boolean default true)
returns jsonb language plpgsql as $$
declare v_name text; v_pid integer; v_early jsonb; v_outcome jsonb := '{}'::jsonb;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	foreach v_name in array array['first','second'] loop
		perform pg_temp.lock_as('lock_' || v_name, case v_name when 'first' then p_first_claims else p_second_claims end);
		perform dblink_send_query('lock_' || v_name, case v_name when 'first' then p_first else p_second end);
		v_pid := current_setting('qorpera_test.lock_' || v_name || '_pid')::integer;
		for attempt in 1..200 loop
			exit when cardinality(pg_blocking_pids(v_pid)) > 0 or dblink_is_busy('lock_' || v_name) = 0;
			perform pg_sleep(0.025);
		end loop;
		if cardinality(pg_blocking_pids(v_pid)) = 0 and (v_name = 'first' or p_second_waits) then
			perform dblink_exec('lock_holder', 'rollback');
			v_early := pg_temp.lock_collect('lock_' || v_name);
			if v_name = 'second' then v_early := jsonb_build_object('first', pg_temp.lock_collect('lock_first'), 'second', v_early); end if;
			raise exception 'Lock race: the % call did not wait for the held row: %', v_name, v_early; end if;
	end loop;
	perform dblink_exec('lock_holder', 'rollback');
	foreach v_name in array array['first','second'] loop
		v_outcome := v_outcome || jsonb_build_object(v_name, pg_temp.lock_collect('lock_' || v_name));
	end loop;
	return v_outcome;
end
$$;
-- The holder locks one row while a single call runs: its result, or its error, and whether it waited.
create function pg_temp.lock_single(p_hold text, p_call text, p_claims jsonb) returns jsonb language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.lock_first_pid')::integer; v_waited boolean := false;
begin
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	perform pg_temp.lock_as('lock_first', p_claims);
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..200 loop
		if cardinality(pg_blocking_pids(v_pid)) > 0 then v_waited := true; exit; end if;
		exit when dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('lock_holder', 'rollback');
	return pg_temp.lock_collect('lock_first') || jsonb_build_object('waited', v_waited);
end
$$;
create function pg_temp.lock_race_ok(p_outcome jsonb, p_message text) returns void language plpgsql as $$
begin
	if p_outcome #> '{first,error}' is not null or p_outcome #> '{second,error}' is not null then
		raise exception 'Lock race: %: %', p_message, p_outcome; end if;
end
$$;
create function pg_temp.lock_row(p_table text, p_column text, p_id uuid) returns text language sql as $$
	select format('select 1 from public.%I where %I = %L for update', p_table, p_column, p_id)
$$;
create function pg_temp.lock_cancel(p_operation text) returns text language sql as $$
	select format('select public.qorpera_manage_agent_worker(%L::jsonb, %L::jsonb)', current_setting('qorpera_test.parent_binding'),
		jsonb_build_object('action','cancel','operationKey',p_operation,'todoKey','composer-latency','workerKey','fix-send'))
$$;
-- The executor claims the next turn; the owner follows up first when the last one has ended.
create function pg_temp.lock_claim() returns void language plpgsql as $$
begin
	perform pg_temp.path_claims('service_role');
	perform set_config('qorpera_test.lock_lease', public.qorpera_claim_coding_session('exec-test', 300) ->> 'leaseToken', false);
end
$$;
create function pg_temp.lock_next_turn(p_text text, p_request uuid) returns void language plpgsql as $$
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id, p_text, p_request);
	perform pg_temp.lock_claim();
end
$$;

-- At the end: remove what the test committed. Every row written since the fixture's first write goes,
-- with triggers and foreign-key checks off, and the rows it changed come back as they were. Every table
-- must hold again exactly what other connections saw before.
create function pg_temp.lock_order_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.lock_order_first_xid')::xid;
begin
	perform pg_temp.lock_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['lock_holder','lock_first','lock_second']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.lock_order_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.lock_order_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.lock_order_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.lock_order_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Lock order cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 1. The owner answers while the executor finishes the turn with a question. The completion waits for
--    the todo first; the answer used to lock the worker and wait for the session the completion held.
--    (The main connection writes nothing in a race's own transaction: the calls would wait for it.)
do $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_heartbeat_coding_session((pg_temp.worker_row('fix-send')).id,
		(current_setting('qorpera_test.coding_claim')::jsonb ->> 'leaseToken')::uuid, 300);
end $$;
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
	v_lease uuid := (current_setting('qorpera_test.coding_claim')::jsonb ->> 'leaseToken')::uuid;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_runtime_agent_todos', 'id', v_worker.todo_id),
		format($q$select public.qorpera_complete_coding_turn(%L, %L, 'blocked', 'Composer fixed; the poll interval is your call.',
			'Keep 250 ms, or raise to 500 ms?', null, null, null, null, null, '["Keep 250 ms","Raise to 500 ms"]')$q$, v_worker.id, v_lease),
		'{"role":"service_role"}',
		format($q$select public.qorpera_answer_coding_session(%L, 'Keep 250 ms.', '60200000-0000-4000-8000-000000000001')$q$, v_worker.id),
		'{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}');
	perform pg_temp.lock_race_ok(v_outcome, 'owner answer against executor completion');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,phase}' = 'awaiting_input' and v_outcome #>> '{second,result,phase}' = 'input_ready'
		and (pg_temp.worker_row('fix-send')).state = 'active' and (pg_temp.worker_row('fix-send')).sequence = 2,
		'The question lands first and the owner''s answer opens the next turn: ' || v_outcome::text);
end $$;

-- 2. The agent cancels while the executor finishes. The agent's worker tool took todo, worker, then
--    session; the completion took the session first.
select pg_temp.lock_claim();
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_sessions', 'worker_id', v_worker.id),
		format($q$select public.qorpera_complete_coding_turn(%L, %L, 'succeeded', 'Composer posts first.')$q$, v_worker.id,
			current_setting('qorpera_test.lock_lease')),
		'{"role":"service_role"}', pg_temp.lock_cancel('lock-order-cancel-1'), '{"role":"service_role"}');
	perform pg_temp.lock_race_ok(v_outcome, 'agent cancel against executor completion');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,phase}' = 'completed' and v_outcome #>> '{second,result,action}' = 'cancel'
		and (pg_temp.worker_row('fix-send')).state = 'succeeded' and (pg_temp.session_row('fix-send')).phase = 'completed',
		'The completion lands first; the cancel then finds nothing running: ' || v_outcome::text);
end $$;

-- 3. The agent cancels while the executor begins the turn. The begin took the session first. Now it
--    waits for the todo; the cancel, queued behind it, already holds the company's profile fence (every
--    agent tool call takes it first), so the turn's wake admission refuses at once (55P03, its fail-fast
--    for producers that hold other locks) instead of waiting in a cycle. The cancel lands, and nothing of
--    the turn remains.
select pg_temp.lock_next_turn('Also cover the group chat composer.', '60200000-0000-4000-8000-000000000002');
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_sessions', 'worker_id', v_worker.id),
		format($q$select public.qorpera_begin_coding_turn(%L, %L, %L::jsonb)$q$, v_worker.id, current_setting('qorpera_test.lock_lease'),
			jsonb_build_object('vmId', current_setting('qorpera_test.coding_vm'), 'turnId', public.qorpera_coding_turn_id(v_worker.id, 3))),
		'{"role":"service_role"}', pg_temp.lock_cancel('lock-order-cancel-2'), '{"role":"service_role"}');
	if v_outcome #>> '{first,state}' = '55P03' and v_outcome #>> '{first,error}' like '%"qorpera_profiles"%' then
		v_outcome := v_outcome - 'first'; end if;
	perform pg_temp.lock_race_ok(v_outcome, 'agent cancel against executor begin');
	perform pg_temp.wake_assert(v_outcome #>> '{second,result,action}' = 'cancel'
		and (pg_temp.worker_row('fix-send')).state = 'cancelled' and (pg_temp.session_row('fix-send')).phase = 'cancelled'
		and not exists (select 1 from public.qorpera_wake_occurrences where source_id = v_worker.id
			and occurrence_key = 'worker-dispatch:' || v_worker.id::text || ':3' and status <> 'cancelled'),
		'The cancel lands and the turn leaves no live wake: ' || v_outcome::text);
end $$;

-- 4. The owner writes while the executor admits the turn to its machine. The admission took the
--    session, then the worker; the answer took the worker, then the session. Now the admission lands and
--    the answer is refused plainly: the session is working.
select pg_temp.lock_next_turn('Pick the composer work up again.', '60200000-0000-4000-8000-000000000003');
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_sessions', 'worker_id', v_worker.id),
		format($q$select public.qorpera_authorize_coding_machine_run(%L, %L, %L, %L::jsonb, %L)$q$, v_worker.id,
			current_setting('qorpera_test.lock_lease'), current_setting('qorpera_test.coding_binding'),
			current_setting('qorpera_test.coding_storage'), repeat('c', 64)),
		'{"role":"service_role"}',
		format($q$select public.qorpera_answer_coding_session(%L, 'Is it done yet?', '60200000-0000-4000-8000-000000000005')$q$, v_worker.id),
		'{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}');
	perform pg_temp.wake_assert(v_outcome #>> '{second,state}' = '55000'
		and v_outcome #>> '{second,error}' = 'The session is still working; wait for its question or its result',
		'The answer is refused because the session works, not killed: ' || v_outcome::text);
	perform pg_temp.lock_race_ok(v_outcome - 'second', 'owner answer against machine admission');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,intent}' = 'run' and v_outcome #>> '{first,result,machineId}' = current_setting('qorpera_test.coding_vm')
		and (pg_temp.worker_row('fix-send')).state = 'active' and (pg_temp.worker_row('fix-send')).sequence = 4,
		'The machine is admitted for the turn: ' || v_outcome::text);
end $$;

-- 5. The executor detaches the session from the machine while the turn is admitted there again. The
--    detach took the machine, then the session; the admission takes the session before the machine.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_sessions', 'worker_id', v_worker.id),
		format($q$select public.qorpera_authorize_coding_machine_run(%L, %L, %L, %L::jsonb, %L)$q$, v_worker.id,
			current_setting('qorpera_test.lock_lease'), current_setting('qorpera_test.coding_binding'),
			current_setting('qorpera_test.coding_storage'), repeat('c', 64)),
		'{"role":"service_role"}',
		format($q$select public.qorpera_authorize_coding_machine_custody(%L, 'exec-test', %L, %L, 'detach', %L, %L)$q$,
			current_setting('qorpera_test.coding_vm'), current_setting('qorpera_test.coding_binding'), repeat('c', 64), v_worker.id,
			current_setting('qorpera_test.lock_lease')),
		'{"role":"service_role"}');
	perform pg_temp.lock_race_ok(v_outcome, 'machine detach against machine admission');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,intent}' = 'run' and v_outcome #>> '{second,result,intent}' = 'detach',
		'The admission lands first, then the turn''s own detach: ' || v_outcome::text);
end $$;

-- 6. The agent edits the todo while the executor admits the turn to its machine. The admission locks the
--    worker, never the todo: its node reservation waits for the company's profile fence, which the todo
--    tool holds while it locks the todo, so the admission must not hold the todo then.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.lock_row('qorpera_coding_sessions', 'worker_id', v_worker.id),
		format($q$select public.qorpera_authorize_coding_machine_run(%L, %L, %L, %L::jsonb, %L)$q$, v_worker.id,
			current_setting('qorpera_test.lock_lease'), current_setting('qorpera_test.coding_binding'),
			current_setting('qorpera_test.coding_storage'), repeat('c', 64)),
		'{"role":"service_role"}',
		format($q$select public.qorpera_manage_agent_todo(%L::jsonb, %L::jsonb)$q$, current_setting('qorpera_test.parent_binding'),
			'{"action":"upsert","operationKey":"lock-order-todo-1","todoKey":"composer-latency","title":"Fix the delay after send, then the group chat"}'),
		'{"role":"service_role"}', false);
	perform pg_temp.lock_race_ok(v_outcome, 'agent todo edit against machine admission');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,intent}' = 'run'
		and (select title from public.qorpera_runtime_agent_todos where id = v_worker.todo_id) = 'Fix the delay after send, then the group chat',
		'The todo edit and the admission both land: ' || v_outcome::text);
end $$;

-- 7. A delegation only records an event, so it starts at the worker: the owner hands a question to the
--    agent while an agent tool holds the todo, and does not wait for it.
do $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_complete_coding_turn((pg_temp.worker_row('fix-send')).id, current_setting('qorpera_test.lock_lease')::uuid,
		'blocked', 'Both composers post first now.', 'Ship the direct chat first, or both together?');
end $$;
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_single(pg_temp.lock_row('qorpera_runtime_agent_todos', 'id', v_worker.todo_id),
		format($q$select public.qorpera_delegate_coding_session(%L, '60200000-0000-4000-8000-000000000006')$q$, v_worker.id),
		'{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}');
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome #>> '{result,phase}' = 'awaiting_input'
		and exists (select 1 from public.qorpera_coding_session_events event where event.worker_id = v_worker.id and event.kind = 'delegated'
			and event.body ->> 'clientRequestId' = '60200000-0000-4000-8000-000000000006'),
		'The delegation lands without waiting for the todo: ' || v_outcome::text);
end $$;

-- 8. Someone who does not own the session locks nothing: a company member's answer is refused while
--    another connection holds the worker, without waiting for it.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_single(pg_temp.lock_row('qorpera_runtime_workers', 'id', v_worker.id),
		format($q$select public.qorpera_answer_coding_session(%L, 'Both together.', '60200000-0000-4000-8000-000000000007')$q$, v_worker.id),
		'{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000002"}');
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = '42501'
		and v_outcome ->> 'error' like 'Only the owner of this coding session can talk to it%',
		'A non-owner is refused without taking a lock: ' || v_outcome::text);
end $$;

-- 9. The helper is internal.
select pg_temp.wake_assert(not has_function_privilege(role_name, 'public.qorpera_lock_coding_worker(uuid)', 'EXECUTE'),
	'Only the kernel locks a coding worker: ' || role_name)
from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) role_name;

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
