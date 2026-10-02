-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-2a (20260929999600): the end of a job deletes its presence device and expires its screen leases in the trigger
-- that ends its connection lease, locking only the rows that are free (skip locked), so it never waits for a device
-- or screen. These run against the rows' usual concurrent writers on separate connections: the presence heartbeat
-- (register, which waits for the job row the ending holds), the office supervisor's reap, a member's take-over, and
-- an ending of two jobs against the privacy fence and the reap, which lock several screens of one office in their own
-- order. None deadlocks (no 40P01). Office setup as in 405: a real office and screen lease for test 300's run (job
-- A); job B and its run are copies of job A's and its run's rows, with a second screen of the same office leased to job
-- B (rows only:
-- replica mode skips the foreign keys this test does not build); only guest readiness is synthetic.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.office',public.qorpera_register_runtime_office(
	'30000000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)::text,true);
select set_config('qorpera_test.office_scope',(current_setting('qorpera_test.office')::jsonb-'state')::text,true);
reset role;
create function pg_temp.office_call(p_action text,p_lease jsonb default null)
returns jsonb language sql as $$
	select public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,p_action,p_lease)
$$;
-- Synthetic guest readiness only. This is not a provider or Linux test.
update public.qorpera_runtime_offices set state='active'
where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select set_config('qorpera_test.binding',(current_setting('qorpera_test.office_lease')::jsonb->'binding')::text,true);
reset role;

-- The run's presence device, as the host registers it.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_native_presence_register(current_setting('qorpera_test.wake_binding')::jsonb,
	'7e2a0000-0000-4000-8000-000000000001','MCowBQYDK2VwAyEA'||repeat('A',43)||'=');
reset role;
select set_config('qorpera_test.job_b', '7e2a0000-0000-4000-8000-0000000000b1', false);
select set_config('qorpera_test.run_b', '7e2a0000-0000-4000-8000-0000000000b2', false);
set local session_replication_role = replica;
insert into public.qorpera_execution_runs
select (jsonb_populate_record(null::public.qorpera_execution_runs, to_jsonb(run) || jsonb_build_object(
	'id', current_setting('qorpera_test.run_b'), 'job_id', current_setting('qorpera_test.job_b'),
	'source_id', extensions.gen_random_uuid()))).*
from public.qorpera_execution_runs as run where run.id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
insert into public.qorpera_runner_jobs
select (jsonb_populate_record(null::public.qorpera_runner_jobs, to_jsonb(job) || jsonb_build_object(
	'id', current_setting('qorpera_test.job_b'), 'run_id', current_setting('qorpera_test.run_b'),
	'client_job_id', extensions.gen_random_uuid(), 'client_lease_id', null))).*
from public.qorpera_runner_jobs as job where job.id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')::uuid;
insert into public.qorpera_runtime_office_screens(office_id, ordinal, staff_agent_id, power, lease_id, run_id, lease_expires_at,
	grant_version, native_binding)
select screen.office_id, screen.ordinal + 1, extensions.gen_random_uuid(), screen.power, extensions.gen_random_uuid(),
	current_setting('qorpera_test.run_b')::uuid, clock_timestamp() + interval '1 hour', screen.grant_version,
	screen.native_binding || jsonb_build_object('jobId', current_setting('qorpera_test.job_b'), 'runId', current_setting('qorpera_test.run_b'))
from public.qorpera_runtime_office_screens as screen where screen.id = (current_setting('qorpera_test.binding')::jsonb ->> 'screenId')::uuid;
set local session_replication_role = origin;

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (the
-- harness of 602 and 746): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.wake_binding','qorpera_test.office','qorpera_test.office_scope','qorpera_test.office_lease','qorpera_test.binding',
	'qorpera_test.job_b','qorpera_test.run_b']) name;
select set_config('qorpera_test.r799_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r799_holder', 'dbname=' || current_database());
select dblink_connect('r799_ender', 'dbname=' || current_database());
select set_config('qorpera_test.r799_' || name || '_pid', pid::text, false)
from unnest(array['holder','ender']) name, lateral dblink('r799_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r799_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r799_holder_pid'),
			current_setting('qorpera_test.r799_ender_pid'))) then
		raise exception 'End-of-job cleanup race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r799_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r799_counts as select * from dblink('r799_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r799_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r799_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r799_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r799_rows select v_table, kept.row_value
			from dblink('r799_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r799_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- Whether the connection's call waited for a lock held by p_by before it finished (10 s at most).
create function pg_temp.r799_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r799_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r799_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;

-- At the end: remove what the test committed, as 602 and 746 do.
create function pg_temp.r799_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r799_first_xid')::xid;
begin
	perform pg_temp.r799_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r799_holder','r799_ender']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r799_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r799_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r799_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r799_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'End-of-job cleanup race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- The calls, each answering one jsonb value. The ending runs as the server's own paths do (the revoked runner).
create function pg_temp.r799_end_sql() returns text language sql as $$
	select format($q$select to_jsonb(public.qorpera_terminalize_runner_attempt(%L, 'failed', 'G2-2a race: the runner was revoked', false))$q$,
		current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId')
$$;
create function pg_temp.r799_heartbeat_sql() returns text language sql as $$
	select format($q$select set_config('request.jwt.claims', '{"role":"service_role"}', true),
		public.qorpera_native_presence_register(%L, '7e2a0000-0000-4000-8000-000000000001', %L)$q$,
		current_setting('qorpera_test.wake_binding'), 'MCowBQYDK2VwAyEA' || repeat('A', 43) || '=')
$$;
create function pg_temp.r799_supervisor_sql() returns text language sql as $$
	select format($q$select set_config('request.jwt.claims', '{"role":"service_role"}', true),
		public.qorpera_runtime_office_supervisor_status(%L, %s)$q$,
		current_setting('qorpera_test.office_scope'), current_setting('qorpera_test.binding')::jsonb ->> 'computerGeneration')
$$;
create function pg_temp.r799_takeover_sql() returns text language sql as $$
	select format($q$select set_config('request.jwt.claims', '{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}', true),
		public.qorpera_request_runtime_office_drain(%L, %L, %s, %s, %s, true)$q$,
		current_setting('qorpera_test.office_scope'), current_setting('qorpera_test.binding')::jsonb ->> 'screenId',
		current_setting('qorpera_test.binding')::jsonb ->> 'computerGeneration',
		current_setting('qorpera_test.binding')::jsonb ->> 'screenGeneration',
		(select epoch from public.qorpera_runtime_office_screens where id = (current_setting('qorpera_test.binding')::jsonb ->> 'screenId')::uuid))
$$;
-- A statement on a connection, run to its end; its error if it had one.
create function pg_temp.r799_run(p_connection text, p_sql text) returns text language plpgsql as $$
begin
	perform * from dblink(p_connection, p_sql, false) as r(a text, b text);
	return nullif(dblink_error_message(p_connection), 'OK');
end $$;
create function pg_temp.r799_send(p_connection text, p_sql text) returns void language plpgsql as $$
begin
	perform dblink_send_query(p_connection, p_sql);
end $$;
-- What a sent statement ended with: 'ok' or its SQLSTATE.
create function pg_temp.r799_outcome(p_connection text) returns text language plpgsql as $$
declare v_outcome text;
begin
	begin
		perform * from dblink_get_result(p_connection) as r(a text, b text);
		v_outcome := 'ok';
	exception when others then
		v_outcome := sqlstate;
	end;
	perform * from dblink_get_result(p_connection, false) as r(a text, b text);
	return v_outcome;
end $$;
-- The ending's call answers one column; the others two (the claims, then the answer).
create function pg_temp.r799_end_outcome() returns text language plpgsql as $$
declare v_outcome text;
begin
	begin
		perform * from dblink_get_result('r799_ender') as r(a jsonb);
		v_outcome := 'ok';
	exception when others then
		v_outcome := sqlstate;
	end;
	perform * from dblink_get_result('r799_ender', false) as r(a jsonb);
	return v_outcome;
end $$;
create function pg_temp.r799_count(p_connection text, p_sql text) returns bigint language sql as $$
	select n from dblink(p_connection, p_sql) as r(n bigint)
$$;
create function pg_temp.r799_device_sql() returns text language sql as $$
	select format('select count(*) from public.qorpera_native_presence_devices where run_id = %L',
		current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')
$$;
create function pg_temp.r799_expired_sql() returns text language sql as $$
	select format($q$select count(*) from public.qorpera_runtime_office_screens where id = %L and lease_id is not null
		and lease_expires_at <= clock_timestamp() - interval '30 seconds'$q$, current_setting('qorpera_test.binding')::jsonb ->> 'screenId')
$$;
create function pg_temp.r799_expect(p_ok boolean, p_label text) returns void language plpgsql as $$
declare v_name text;
begin
	if p_ok is not true then
		-- Stop what either connection still runs, so the failure reads as itself.
		foreach v_name in array array['r799_holder', 'r799_ender'] loop
			if dblink_is_busy(v_name) = 1 then perform dblink_cancel_query(v_name); end if;
			for attempt in 1..3 loop
				begin
					perform * from dblink_get_result(v_name, false) as r(a text);
				exception when others then null;
				end;
			end loop;
			perform dblink_exec(v_name, 'rollback', false);
		end loop;
		raise exception 'End-of-job cleanup race: %', p_label; end if;
end $$;

-- The two screens of the office, as the connection sees them: how many are leased and not yet past the grace.
create function pg_temp.r799_live_sql() returns text language sql as $$
	select format($q$select count(*) from public.qorpera_runtime_office_screens where office_id = %L and lease_id is not null
		and lease_expires_at > clock_timestamp() - interval '30 seconds'$q$,
		current_setting('qorpera_test.binding')::jsonb ->> 'companyComputerId')
$$;
-- Job B ends as the server's paths end a job: the trigger fires on its status.
create function pg_temp.r799_end_b_sql() returns text language sql as $$
	select format($q$update public.qorpera_runner_jobs set status = 'failed', lease_token_sha256 = null, lease_expires_at = null,
		finished_at = clock_timestamp(), last_error = 'G2-2a race: the runner was revoked' where id = %L returning to_jsonb(id)$q$,
		current_setting('qorpera_test.job_b'))
$$;
create function pg_temp.r799_fence_sql() returns text language sql as $$
	select format($q$select set_config('request.jwt.claims', '{"role":"service_role"}', true),
		public.qorpera_fence_runtime_office_screens(office)::text from public.qorpera_runtime_offices as office where office.id = %L$q$,
		current_setting('qorpera_test.binding')::jsonb ->> 'companyComputerId')
$$;
create function pg_temp.r799_screens_past_grace(p_past boolean) returns void language plpgsql as $$
begin
	perform dblink_exec('r799_holder', format($q$update public.qorpera_runtime_office_screens
		set lease_expires_at = clock_timestamp() + case when %L then interval '-31 seconds' else interval '1 hour' end
		where office_id = %L and lease_id is not null$q$, p_past, current_setting('qorpera_test.binding')::jsonb ->> 'companyComputerId'));
end $$;

-- 1. The presence heartbeat holds the job row (and its device); the ending waits for the job row, then deletes the device.
do $$
declare v_error text; v_end text;
begin
	perform dblink_exec('r799_holder', 'begin');
	v_error := pg_temp.r799_run('r799_holder', pg_temp.r799_heartbeat_sql());
	perform pg_temp.r799_expect(v_error is null, 'the heartbeat failed: ' || coalesce(v_error, ''));
	perform dblink_exec('r799_ender', 'begin');
	perform pg_temp.r799_send('r799_ender', pg_temp.r799_end_sql());
	perform pg_temp.r799_expect(pg_temp.r799_waited_for('ender', current_setting('qorpera_test.r799_holder_pid')::integer),
		'the ending did not wait for the heartbeat''s job row');
	perform dblink_exec('r799_holder', 'commit');
	v_end := pg_temp.r799_end_outcome();
	perform pg_temp.r799_expect(v_end = 'ok', 'the ending after a heartbeat answered ' || v_end);
	perform pg_temp.r799_expect(pg_temp.r799_count('r799_ender', pg_temp.r799_device_sql()) = 0, 'the device outlived the ending');
	perform dblink_exec('r799_ender', 'rollback');
end $$;

-- 2. The supervisor reaps the screen (office row, then the screen) and holds it; the ending does not wait for it and
--    leaves that screen to the reap.
do $$
declare v_error text; v_end text;
begin
	perform dblink_exec('r799_holder', 'begin');
	perform dblink_exec('r799_holder', format($q$update public.qorpera_runtime_office_screens
		set lease_expires_at = clock_timestamp() - interval '31 seconds' where id = %L$q$,
		current_setting('qorpera_test.binding')::jsonb ->> 'screenId'));
	v_error := pg_temp.r799_run('r799_holder', pg_temp.r799_supervisor_sql());
	perform pg_temp.r799_expect(v_error is null, 'the reap failed: ' || coalesce(v_error, ''));
	perform dblink_exec('r799_ender', 'begin');
	perform pg_temp.r799_send('r799_ender', pg_temp.r799_end_sql());
	perform pg_temp.r799_expect(not pg_temp.r799_waited_for('ender', current_setting('qorpera_test.r799_holder_pid')::integer),
		'the ending waited for the reap');
	v_end := pg_temp.r799_end_outcome();
	perform pg_temp.r799_expect(v_end = 'ok', 'the ending beside a reap answered ' || v_end);
	perform pg_temp.r799_expect(pg_temp.r799_count('r799_ender', pg_temp.r799_device_sql()) = 0, 'the device outlived the ending');
	perform pg_temp.r799_expect(pg_temp.r799_count('r799_ender', pg_temp.r799_expired_sql()) = 0, 'the ending took the reap''s screen');
	perform dblink_exec('r799_ender', 'rollback');
	perform dblink_exec('r799_holder', 'rollback');
end $$;

-- 3. A member takes the screen over (office row, then the screen) and holds it; the ending does not wait for it.
do $$
declare v_error text; v_end text;
begin
	perform dblink_exec('r799_holder', 'begin');
	v_error := pg_temp.r799_run('r799_holder', pg_temp.r799_takeover_sql());
	perform pg_temp.r799_expect(v_error is null, 'the take-over failed: ' || coalesce(v_error, ''));
	perform dblink_exec('r799_ender', 'begin');
	perform pg_temp.r799_send('r799_ender', pg_temp.r799_end_sql());
	perform pg_temp.r799_expect(not pg_temp.r799_waited_for('ender', current_setting('qorpera_test.r799_holder_pid')::integer),
		'the ending waited for the take-over');
	v_end := pg_temp.r799_end_outcome();
	perform pg_temp.r799_expect(v_end = 'ok', 'the ending beside a take-over answered ' || v_end);
	perform dblink_exec('r799_ender', 'rollback');
	perform dblink_exec('r799_holder', 'rollback');
end $$;

-- 4. The ending holds the job, device and screen rows; a member's take-over (office row, then the screen) waits for
--    it, and runs once it rolls back.
do $$
declare v_takeover text;
begin
	perform dblink_exec('r799_ender', 'begin');
	perform * from dblink('r799_ender', pg_temp.r799_end_sql()) as r(a jsonb);
	perform pg_temp.r799_expect(pg_temp.r799_count('r799_ender', pg_temp.r799_expired_sql()) = 1, 'the ending did not expire the lease');
	perform dblink_exec('r799_holder', 'begin');
	perform pg_temp.r799_send('r799_holder', pg_temp.r799_takeover_sql());
	perform pg_temp.r799_expect(pg_temp.r799_waited_for('holder', current_setting('qorpera_test.r799_ender_pid')::integer),
		'the take-over did not wait for the ending');
	perform dblink_exec('r799_ender', 'rollback');
	v_takeover := pg_temp.r799_outcome('r799_holder');
	perform pg_temp.r799_expect(v_takeover = 'ok', 'the take-over after an ending answered ' || v_takeover);
	perform dblink_exec('r799_holder', 'rollback');
end $$;

-- 5. The screen's lease already ran out past the grace: the ending leaves it to the supervisor, whose reap runs while
--    the ending is open without waiting for it.
do $$
declare v_reap text;
begin
	perform pg_temp.r799_screens_past_grace(true);
	perform dblink_exec('r799_ender', 'begin');
	perform * from dblink('r799_ender', pg_temp.r799_end_sql()) as r(a jsonb);
	perform dblink_exec('r799_holder', 'begin');
	perform pg_temp.r799_send('r799_holder', pg_temp.r799_supervisor_sql());
	perform pg_temp.r799_expect(not pg_temp.r799_waited_for('holder', current_setting('qorpera_test.r799_ender_pid')::integer),
		'the reap waited for the ending');
	v_reap := pg_temp.r799_outcome('r799_holder');
	perform pg_temp.r799_expect(v_reap = 'ok', 'the reap beside an ending answered ' || v_reap);
	perform dblink_exec('r799_holder', 'rollback');
	perform dblink_exec('r799_ender', 'rollback');
	perform pg_temp.r799_screens_past_grace(false);
end $$;

-- 6. One transaction ends job B (its screen, the office's second), then job A, while the privacy fence (office row,
--    then every screen in table order) holds the first screen and waits for the second. The ending skips the first,
--    so nothing waits in a circle; the fence runs once the ending rolls back.
do $$
declare v_fence text; v_end text;
begin
	perform dblink_exec('r799_ender', 'begin');
	perform * from dblink('r799_ender', pg_temp.r799_end_b_sql()) as r(a jsonb);
	perform pg_temp.r799_expect(pg_temp.r799_count('r799_ender', pg_temp.r799_live_sql()) = 1, 'the ending did not expire job B''s lease');
	perform dblink_exec('r799_holder', 'begin');
	perform pg_temp.r799_send('r799_holder', pg_temp.r799_fence_sql());
	perform pg_temp.r799_expect(pg_temp.r799_waited_for('holder', current_setting('qorpera_test.r799_ender_pid')::integer),
		'the fence did not wait for job B''s screen');
	perform pg_temp.r799_send('r799_ender', pg_temp.r799_end_sql());
	perform pg_temp.r799_expect(not pg_temp.r799_waited_for('ender', current_setting('qorpera_test.r799_holder_pid')::integer),
		'the ending of job A waited for the fence');
	v_end := pg_temp.r799_end_outcome();
	perform pg_temp.r799_expect(v_end = 'ok', 'the ending of job A beside the fence answered ' || v_end);
	perform pg_temp.r799_expect(pg_temp.r799_count('r799_ender', pg_temp.r799_live_sql()) = 1, 'the ending took the fenced screen');
	perform dblink_exec('r799_ender', 'rollback');
	v_fence := pg_temp.r799_outcome('r799_holder');
	perform pg_temp.r799_expect(v_fence = 'ok', 'the fence after the ending answered ' || v_fence);
	perform dblink_exec('r799_holder', 'rollback');
end $$;

-- 7. Both leases past the grace: one transaction ends job B, then job A, while the supervisor reaps both screens;
--    neither waits for the other.
do $$
declare v_reap text; v_end text;
begin
	perform pg_temp.r799_screens_past_grace(true);
	perform dblink_exec('r799_ender', 'begin');
	perform * from dblink('r799_ender', pg_temp.r799_end_b_sql()) as r(a jsonb);
	perform dblink_exec('r799_holder', 'begin');
	perform pg_temp.r799_send('r799_holder', pg_temp.r799_supervisor_sql());
	perform pg_temp.r799_expect(not pg_temp.r799_waited_for('holder', current_setting('qorpera_test.r799_ender_pid')::integer),
		'the reap waited for the ending of job B');
	v_reap := pg_temp.r799_outcome('r799_holder');
	perform pg_temp.r799_expect(v_reap = 'ok', 'the reap beside the ending answered ' || v_reap);
	perform pg_temp.r799_send('r799_ender', pg_temp.r799_end_sql());
	perform pg_temp.r799_expect(not pg_temp.r799_waited_for('ender', current_setting('qorpera_test.r799_holder_pid')::integer),
		'the ending of job A waited for the reap');
	v_end := pg_temp.r799_end_outcome();
	perform pg_temp.r799_expect(v_end = 'ok', 'the ending of job A beside the reap answered ' || v_end);
	perform dblink_exec('r799_ender', 'rollback');
	perform dblink_exec('r799_holder', 'rollback');
	perform pg_temp.r799_screens_past_grace(false);
end $$;

-- 8. The ending holds the job row and commits; the heartbeat waiting for it is then refused (the run ended), and the
--    device is gone.
do $$
declare v_heartbeat text;
begin
	perform dblink_exec('r799_ender', 'begin');
	perform * from dblink('r799_ender', pg_temp.r799_end_sql()) as r(a jsonb);
	perform dblink_exec('r799_holder', 'begin');
	perform pg_temp.r799_send('r799_holder', pg_temp.r799_heartbeat_sql());
	perform pg_temp.r799_expect(pg_temp.r799_waited_for('holder', current_setting('qorpera_test.r799_ender_pid')::integer),
		'the heartbeat did not wait for the ending');
	perform dblink_exec('r799_ender', 'commit');
	v_heartbeat := pg_temp.r799_outcome('r799_holder');
	perform pg_temp.r799_expect(v_heartbeat = '42501', 'the heartbeat after an ending answered ' || v_heartbeat);
	perform dblink_exec('r799_holder', 'rollback');
	perform pg_temp.r799_expect(pg_temp.r799_count('r799_holder', pg_temp.r799_device_sql()) = 0, 'the device outlived the ending');
end $$;

select pg_temp.r799_cleanup();
