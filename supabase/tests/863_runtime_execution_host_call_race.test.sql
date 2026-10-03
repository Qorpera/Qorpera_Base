-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- G2-3e (20260930011000): the execution host's entry points check its credential per call and with no lock, so a
-- refused call never waits for a transaction that holds the host's principal, the claim, its orchestrator, the job,
-- the assignment, the run, the runner or the run machine; a listed call's checks take no lock either; a rebind (a
-- rebuild) or a revocation takes effect on the next call. Test 300's fixture gives a run claimed by orchestrator 092
-- (adapter 'process') and its runner; this binds an execution host to 092, another to an orchestrator of another
-- adapter, and adds the run's machine allocation.
reset role;
create function pg_temp.sha(p_value text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_value, 'utf8'), 'sha256'), 'hex')
$$;
select set_config('qorpera_test.run', current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId', false);
select set_config('qorpera_test.runner', current_setting('qorpera_test.wake_binding')::jsonb ->> 'runnerId', false);
select set_config('qorpera_test.host_credential', 'H' || repeat('h', 42), false);
select set_config('qorpera_test.rebuilt_credential', 'N' || repeat('n', 42), false);
select set_config('qorpera_test.other_credential', 'O' || repeat('o', 42), false);
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
values ('86300000-0000-4000-8000-000000000071', '30000000-0000-4000-8000-000000000010',
	current_setting('qorpera_test.run')::uuid, current_setting('qorpera_test.runner')::uuid, 'process', repeat('7', 64));
select set_config('qorpera_test.host_hash', pg_temp.sha(current_setting('qorpera_test.host_credential')), false);
select set_config('qorpera_test.other_hash', pg_temp.sha(current_setting('qorpera_test.other_credential')), false);
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_register_runner_orchestrator('86300000-0000-4000-8000-0000000000b1', 'Another node', 'other-adapter',
	repeat('5', 64), 3600);
select public.qorpera_bind_execution_host_credential('qorpera-exec-test', 'process', '30000000-0000-4000-8000-000000000092',
	current_setting('qorpera_test.host_hash'));
select public.qorpera_bind_execution_host_credential('qorpera-exec-other', 'other-adapter', '86300000-0000-4000-8000-0000000000b1',
	current_setting('qorpera_test.other_hash'));
reset role;

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (the
-- harness of 602, 746, 793 and 861): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.wake_binding', current_setting('qorpera_test.wake_binding'), false);
select set_config('qorpera_test.r863_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r863_holder', 'dbname=' || current_database());
select dblink_connect('r863_caller', 'dbname=' || current_database());
select set_config('qorpera_test.r863_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('r863_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r863_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r863_holder_pid'),
			current_setting('qorpera_test.r863_caller_pid'))) then
		raise exception 'Execution host call race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r863_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r863_counts as select * from dblink('r863_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r863_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r863_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r863_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r863_rows select v_table, kept.row_value
			from dblink('r863_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r863_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- A sent command's status ('UPDATE 1'), or its error.
create function pg_temp.r863_command_outcome(p_connection text) returns text language plpgsql as $$
declare v_status text;
begin
	begin
		select status into v_status from dblink_get_result(p_connection) as command(status text);
	exception when others then
		v_status := 'error ' || sqlstate || ': ' || sqlerrm;
	end;
	perform * from dblink_get_result(p_connection, false) as command(status text);
	return v_status;
end
$$;
-- Whether the connection's statement waited for a lock held by p_by before it finished (10 s at most).
create function pg_temp.r863_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r863_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r863_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
create function pg_temp.r863_pid(p_connection text) returns integer language sql as $$
	select current_setting('qorpera_test.r863_' || p_connection || '_pid')::integer
$$;

-- At the end: remove what the test committed, as 602, 746, 793 and 861 do.
create function pg_temp.r863_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r863_first_xid')::xid;
begin
	perform pg_temp.r863_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r863_holder','r863_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r863_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r863_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r863_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r863_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Execution host call race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- A connection's transaction as PostgREST runs it: the publishable key on the entry point's RPC path, or the node
-- host (the service caller).
create function pg_temp.r863_begin(p_connection text, p_role text) returns void language plpgsql as $$
begin
	perform dblink_exec('r863_' || p_connection, 'begin');
	perform * from dblink('r863_' || p_connection, format($q$select set_config('request.jwt.claims', %L, true),
		set_config('request.path', %L, true)$q$, jsonb_build_object('role', p_role)::text,
		case p_role when 'anon' then '/rpc/qorpera_execution_host_call' else '/rpc/qorpera_bind_execution_host_credential' end))
		as c(claims text, path text);
	perform dblink_exec('r863_' || p_connection, format('set local role %I', p_role));
end $$;
-- A call through the standard entry point as SQL: the adapter's ended runners (no lock of its own: the function is
-- stable).
create function pg_temp.r863_call_sql(p_credential text, p_host text default 'qorpera-exec-test',
	p_name text default 'qorpera_runtime_ended_runners', p_args jsonb default null,
	p_entry text default 'qorpera_execution_host_call') returns text language sql as $$
	select format($q$select public.%I(%L, %L, %L, %L)$q$, p_entry, p_host, p_credential, p_name,
		coalesce(p_args, jsonb_build_object('p_runner_ids', jsonb_build_array(current_setting('qorpera_test.runner'))))::text)
$$;
-- A call from the caller connection in its own transaction; it must not wait for the holder.
create function pg_temp.r863_at_once(p_credential text, p_host text default 'qorpera-exec-test',
	p_name text default 'qorpera_runtime_ended_runners', p_args jsonb default null,
	p_entry text default 'qorpera_execution_host_call') returns jsonb language plpgsql as $$
declare v_outcome jsonb;
begin
	perform pg_temp.r863_begin('caller', 'anon');
	perform dblink_send_query('r863_caller', pg_temp.r863_call_sql(p_credential, p_host, p_name, p_args, p_entry));
	if pg_temp.r863_waited_for('caller', pg_temp.r863_pid('holder')) then
		perform dblink_exec('r863_holder', 'rollback');
		v_outcome := pg_temp.r863_collect('r863_caller');
		perform dblink_exec('r863_caller', 'rollback');
		raise exception 'An execution host call waited for the holder: %', v_outcome; end if;
	v_outcome := pg_temp.r863_collect('r863_caller');
	perform dblink_exec('r863_caller', 'rollback');
	return v_outcome;
end $$;
create function pg_temp.r863_refused(p_outcome jsonb) returns boolean language sql as $$
	select coalesce(p_outcome ->> 'state' = '42501' and p_outcome ->> 'error' = 'execution host call is refused', false)
$$;

-- 1. Another transaction holds the host's principal, the run's claim, its orchestrator, the job, the assignment, the
--    run, the runner and the run machine (as a rebuild, a claim change, an orchestrator's heartbeat, the run's
--    progress and a reservation would). A wrong credential, another host's name and another host's release of the run
--    machine are refused at once; the host's listed calls' checks take no lock, so its ended runners and its run's
--    identity answer at once too (the identity's own function locks only the identity row).
do $$
declare v_outcome jsonb; v_row record;
begin
	perform dblink_exec('r863_holder', 'begin');
	for v_row in select * from (values
		('qorpera_execution_host_principals', 'host_id', 'qorpera-exec-test'),
		('qorpera_runner_job_claims', 'run_id', current_setting('qorpera_test.run')),
		('qorpera_runner_jobs', 'id', current_setting('qorpera_test.wake_binding')::jsonb ->> 'jobId'),
		('qorpera_runner_assignments', 'id', current_setting('qorpera_test.wake_binding')::jsonb ->> 'assignmentId'),
		('qorpera_runner_orchestrators', 'id', '30000000-0000-4000-8000-000000000092'),
		('qorpera_execution_runs', 'id', current_setting('qorpera_test.run')),
		('qorpera_runners', 'id', current_setting('qorpera_test.runner')),
		('qorpera_runtime_machine_allocations', 'id', '86300000-0000-4000-8000-000000000071')) as held(table_name, column_name, value) loop
		perform * from dblink('r863_holder', format('select 1 from public.%I where %I::text = %L for update', v_row.table_name,
			v_row.column_name, v_row.value)) as held(one integer);
	end loop;
	v_outcome := pg_temp.r863_at_once('W' || repeat('w', 42));
	if not pg_temp.r863_refused(v_outcome) then
		perform dblink_exec('r863_holder', 'rollback');
		raise exception 'A wrong credential was not refused: %', v_outcome; end if;
	v_outcome := pg_temp.r863_at_once(current_setting('qorpera_test.host_credential'), 'qorpera-exec-other');
	if not pg_temp.r863_refused(v_outcome) then
		perform dblink_exec('r863_holder', 'rollback');
		raise exception 'Another host''s name was not refused: %', v_outcome; end if;
	v_outcome := pg_temp.r863_at_once(current_setting('qorpera_test.other_credential'), 'qorpera-exec-other',
		'qorpera_release_runtime_machine', jsonb_build_object('p_allocation_id', '86300000-0000-4000-8000-000000000071',
			'p_provider_adapter', 'other-adapter', 'p_instance_sha256', repeat('7', 64)), 'qorpera_execution_host_call_long');
	if not pg_temp.r863_refused(v_outcome) then
		perform dblink_exec('r863_holder', 'rollback');
		raise exception 'Another host''s release was not refused: %', v_outcome; end if;
	v_outcome := pg_temp.r863_at_once(current_setting('qorpera_test.host_credential'), 'qorpera-exec-test',
		'qorpera_identity_recovery_runtime_state', jsonb_build_object('p_compute_identity_id',
			current_setting('qorpera_test.wake_binding')::jsonb ->> 'computeIdentityId', 'p_run_id', current_setting('qorpera_test.run')));
	if v_outcome ? 'error' then
		perform dblink_exec('r863_holder', 'rollback');
		raise exception 'The host''s identity call was refused: %', v_outcome; end if;
	v_outcome := pg_temp.r863_at_once(current_setting('qorpera_test.host_credential'));
	perform dblink_exec('r863_holder', 'rollback');
	if v_outcome ? 'error' then raise exception 'The host''s listed call was refused: %', v_outcome; end if;
end $$;

-- 2. A rebuild's bind in flight: until it commits the old credential works, at once; from its commit on the old one
--    is refused and the new one works.
do $$
declare v_outcome jsonb;
begin
	perform pg_temp.r863_begin('holder', 'service_role');
	perform * from dblink('r863_holder', format($q$select public.qorpera_bind_execution_host_credential('qorpera-exec-test', 'process', '30000000-0000-4000-8000-000000000092', %L)$q$,
		pg_temp.sha(current_setting('qorpera_test.rebuilt_credential')))) as bound(result jsonb);
	v_outcome := pg_temp.r863_at_once(current_setting('qorpera_test.host_credential'));
	if v_outcome ? 'error' then
		perform dblink_exec('r863_holder', 'rollback');
		raise exception 'The credential was refused before the rebuild''s bind committed: %', v_outcome; end if;
	perform dblink_exec('r863_holder', 'commit');
	v_outcome := pg_temp.r863_at_once(current_setting('qorpera_test.host_credential'));
	if not pg_temp.r863_refused(v_outcome) then raise exception 'A rebuilt host''s old credential was not refused: %', v_outcome; end if;
	v_outcome := pg_temp.r863_at_once(current_setting('qorpera_test.rebuilt_credential'));
	if v_outcome ? 'error' then raise exception 'The rebuilt credential was refused: %', v_outcome; end if;
end $$;

-- 3. A revocation while the host's call is in flight: the revocation does not wait for the call's transaction, and the
--    host's next call, in that same transaction, is refused.
do $$
declare v_outcome jsonb; v_status jsonb;
begin
	perform pg_temp.r863_begin('caller', 'anon');
	perform * from dblink('r863_caller', pg_temp.r863_call_sql(current_setting('qorpera_test.rebuilt_credential'))) as call(result jsonb);
	perform pg_temp.r863_begin('holder', 'service_role');
	perform dblink_send_query('r863_holder', $q$select to_jsonb(public.qorpera_revoke_execution_host_credential('qorpera-exec-test'))$q$);
	if pg_temp.r863_waited_for('holder', pg_temp.r863_pid('caller')) then
		perform dblink_exec('r863_caller', 'rollback');
		v_status := pg_temp.r863_collect('r863_holder');
		perform dblink_exec('r863_holder', 'rollback');
		raise exception 'A revocation waited for an execution host call: %', v_status; end if;
	v_status := pg_temp.r863_collect('r863_holder');
	perform dblink_exec('r863_holder', 'commit');
	if v_status ? 'error' then
		perform dblink_exec('r863_caller', 'rollback');
		raise exception 'The revocation failed: %', v_status; end if;
	perform dblink_send_query('r863_caller', pg_temp.r863_call_sql(current_setting('qorpera_test.rebuilt_credential')));
	v_outcome := pg_temp.r863_collect('r863_caller');
	perform dblink_exec('r863_caller', 'rollback');
	if not pg_temp.r863_refused(v_outcome) then
		raise exception 'A revoked host''s credential was not refused in a call in flight: %', v_outcome; end if;
end $$;

select pg_temp.r863_cleanup();
