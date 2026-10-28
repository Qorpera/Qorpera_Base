-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Context tree W5a-2 (20260930270000): a runner's accept races a step erase's first commit on the run's generation row,
-- and nothing deadlocks. Test 924's run of Alice's has a log; its first attempt's lease runs out before it starts, and
-- the next attempt is claimed and offered to a new runner. The erase's first commit (by hand, as the erase makes it)
-- takes the generation row FOR UPDATE and then reads the job plainly; the accept takes the job, then the row FOR SHARE.
-- 1. The erase lands first: the accept waits for it, then refuses (55006). 2. The accept lands first: the erase waits for
-- it, finds the job leased and does not open; the attempt runs. 990 has the rest of W5a-2.
reset role;

-- The run's log, and the next attempt, offered but not accepted.
do $$
declare v_run public.qorpera_execution_runs; v_claim jsonb; v_runner jsonb; v_assignment jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
	values (v_run.environment_id, v_run.id, extensions.gen_random_uuid(), 'QorperaOS/agents/alice/runs/' || v_run.id,
		'qorperaos/agents/alice/runs/' || v_run.id, extensions.gen_random_uuid(), extensions.gen_random_uuid());
	insert into public.qorpera_memory_run_generations(environment_id, run_id, log_created_at)
	values (v_run.environment_id, v_run.id, clock_timestamp());
	perform pg_temp.base_claims('service_role');
	update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second' where id = v_run.job_id;
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	-- The fresh retry's wait (20260930537000) is over.
	update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp(), queued_at = statement_timestamp()
	where id = v_run.job_id;
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), 120);
	perform pg_temp.base_assert(v_claim #>> '{work,job_id}' = v_run.job_id::text, 'the next attempt is claimed: ' || v_claim::text);
	v_runner := public.qorpera_provision_execution_runner(v_run.id, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'base-fixture');
	v_assignment := public.qorpera_assign_runner_job('92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid, extensions.gen_random_uuid(), repeat('3', 64), 120);
	perform set_config('qorpera_test.r994_attempt', jsonb_build_object('environmentId', v_run.environment_id, 'runId', v_run.id,
		'jobId', v_run.job_id, 'runnerId', v_runner ->> 'runner_id', 'assignmentId', v_assignment ->> 'assignment_id')::text, false);
end
$$;

-- Row locks show only across connections, so 924's fixture is committed here and removed again at the end (the
-- harness of 793): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.r994_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r994_holder', 'dbname=' || current_database());
select dblink_connect('r994_caller', 'dbname=' || current_database());
select set_config('qorpera_test.r994_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('r994_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r994_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r994_holder_pid'),
			current_setting('qorpera_test.r994_caller_pid'))) then
		raise exception 'Resume erase race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r994_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r994_counts as select * from dblink('r994_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r994_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r994_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r994_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r994_rows select v_table, kept.row_value
			from dblink('r994_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r994_collect(p_connection text) returns jsonb language plpgsql as $$
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
create function pg_temp.r994_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r994_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r994_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;

-- At the end: remove what the test committed, as 793 does.
create function pg_temp.r994_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r994_first_xid')::xid;
begin
	perform pg_temp.r994_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r994_holder','r994_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r994_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r994_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r994_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r994_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Resume erase race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- The erase's first commit, in two statements: the run's generation row FOR UPDATE, then (with a new snapshot) the
-- job read plainly; the erase opens only while no attempt holds the job and no other erase is open.
create function pg_temp.r994_erase_lock_sql() returns text language sql as $$
	select format('select to_jsonb(erase.erase_open) from public.qorpera_memory_run_generations as erase
		where erase.environment_id = %L and erase.run_id = %L for update',
		current_setting('qorpera_test.r994_attempt')::jsonb ->> 'environmentId', current_setting('qorpera_test.r994_attempt')::jsonb ->> 'runId')
$$;
create function pg_temp.r994_erase_open_sql() returns text language sql as $$
	select format('update public.qorpera_memory_run_generations as erase
		set erase_open = extensions.gen_random_uuid(), memory_generation = erase.memory_generation + 1, updated_at = clock_timestamp()
		where erase.environment_id = %L and erase.run_id = %L and erase.erase_open is null
			and not exists (select 1 from public.qorpera_runner_jobs as job where job.id = %L and job.status = %L)
		returning erase.erase_open',
		current_setting('qorpera_test.r994_attempt')::jsonb ->> 'environmentId', current_setting('qorpera_test.r994_attempt')::jsonb ->> 'runId',
		current_setting('qorpera_test.r994_attempt')::jsonb ->> 'jobId', 'leased')
$$;
-- The runner's accept from the caller connection, as runner-control calls it with the service key.
create function pg_temp.r994_accept_send() returns void language plpgsql as $$
declare v_attempt jsonb := current_setting('qorpera_test.r994_attempt')::jsonb;
begin
	perform dblink_exec('r994_caller', 'begin');
	perform * from dblink('r994_caller', $q$select set_config('request.jwt.claims', '{"role":"service_role"}', true)$q$) as c(claims text);
	perform dblink_exec('r994_caller', 'set local role service_role');
	perform dblink_send_query('r994_caller', format('select public.qorpera_accept_runner_assignment(%L, %L, %L, %L, %L)',
		v_attempt ->> 'runnerId', repeat('2', 64), v_attempt ->> 'assignmentId', v_attempt ->> 'jobId', repeat('3', 64)));
end $$;

-- 1. The erase lands first. The accept waits for it on the generation row, then refuses: 55006, and nothing deadlocks.
do $$
declare v_opened uuid; v_outcome jsonb;
begin
	perform dblink_exec('r994_holder', 'begin');
	perform * from dblink('r994_holder', pg_temp.r994_erase_lock_sql()) as locked(erase_open jsonb);
	select erase_open into v_opened from dblink('r994_holder', pg_temp.r994_erase_open_sql()) as opened(erase_open uuid);
	if v_opened is null then
		perform dblink_exec('r994_holder', 'rollback');
		raise exception 'The erase did not open on an offered attempt'; end if;
	perform pg_temp.r994_accept_send();
	if not pg_temp.r994_waited_for('caller', current_setting('qorpera_test.r994_holder_pid')::integer) then
		perform dblink_exec('r994_holder', 'rollback');
		raise exception 'The accept did not wait for the erase: %', pg_temp.r994_collect('r994_caller'); end if;
	perform dblink_exec('r994_holder', 'commit');
	v_outcome := pg_temp.r994_collect('r994_caller');
	perform dblink_exec('r994_caller', 'rollback');
	if v_outcome ->> 'state' is distinct from '55006' or v_outcome ->> 'error' is distinct from 'memory_erase_open' then
		raise exception 'The accept after the erase was not refused: %', v_outcome; end if;
end $$;

-- The erase's last commit, after its rewrite.
select dblink_exec('r994_holder', format('update public.qorpera_memory_run_generations set erase_open = null where run_id = %L',
	current_setting('qorpera_test.r994_attempt')::jsonb ->> 'runId')) \g /dev/null

-- 2. The accept lands first. The erase waits for it on the generation row, then reads the job leased and does not open:
--    it stays pending until the attempt ends. Nothing deadlocks.
do $$
declare v_outcome jsonb; v_locked jsonb; v_opened bigint;
begin
	perform pg_temp.r994_accept_send();
	v_outcome := pg_temp.r994_collect('r994_caller');
	if v_outcome ? 'error' then
		perform dblink_exec('r994_caller', 'rollback');
		raise exception 'The accept was refused with no erase open: %', v_outcome; end if;
	perform dblink_exec('r994_holder', 'begin');
	perform dblink_send_query('r994_holder', pg_temp.r994_erase_lock_sql());
	if not pg_temp.r994_waited_for('holder', current_setting('qorpera_test.r994_caller_pid')::integer) then
		perform dblink_exec('r994_caller', 'rollback');
		raise exception 'The erase did not wait for the accept: %', pg_temp.r994_collect('r994_holder'); end if;
	perform dblink_exec('r994_caller', 'commit');
	v_locked := pg_temp.r994_collect('r994_holder');
	if v_locked ? 'error' then
		perform dblink_exec('r994_holder', 'rollback');
		raise exception 'The erase failed waiting for the accept: %', v_locked; end if;
	select count(*) into v_opened from dblink('r994_holder', pg_temp.r994_erase_open_sql()) as opened(erase_open uuid);
	perform dblink_exec('r994_holder', 'commit');
	if v_opened <> 0 then raise exception 'The erase opened on a leased job'; end if;
end $$;

-- The attempt holds the job, and only the first erase raised the run's generation.
do $$
declare v_attempt jsonb := current_setting('qorpera_test.r994_attempt')::jsonb;
begin
	if not exists (select 1 from public.qorpera_runner_jobs where id = (v_attempt ->> 'jobId')::uuid and status = 'leased'
		and runner_id = (v_attempt ->> 'runnerId')::uuid and client_lease_id = (v_attempt ->> 'assignmentId')::uuid) then
		raise exception 'The accepted attempt does not hold the job'; end if;
	if not exists (select 1 from public.qorpera_memory_run_generations where run_id = (v_attempt ->> 'runId')::uuid
		and erase_open is null and memory_generation = 1) then
		raise exception 'The run''s generation row is not as the erases left it'; end if;
end $$;

select pg_temp.r994_cleanup();
