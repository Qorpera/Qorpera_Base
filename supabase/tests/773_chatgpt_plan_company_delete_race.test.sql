-- @fixture 771_chatgpt_plan_company_delete.test.sql until "-- The company is being deleted."
-- A folder-v2 company's deletion finisher never waits for a run's job while it holds the folder fence (ported from
-- snapshot-v1 in the legacy sweep; Sign in with ChatGPT, slice 1c, 20260928359960, on the drain of 20260928469280): a
-- run host holds its job and then takes the folder fence (the folder run entry: job, then fence KEY SHARE); the
-- finisher's stop skips a job one of them holds. Revoking the plan connection that pays for that job would end it
-- through the connection's status trigger, which would wait for the job under the fence: so the revocation leaves that
-- connection for a later pass, which ends the job and revokes it.

-- The base run's leased job is paid by the member's plan (what slice 4 enables), and the company is being deleted.
set local session_replication_role = replica;
update public.qorpera_execution_sponsor_versions as sponsor
set provider_connection_id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid, provider_connection_version = 1
from public.qorpera_execution_runs as run join public.qorpera_runner_jobs as job on job.id = run.job_id
where sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version and job.status = 'leased'
	and run.profile_id = '92400000-0000-4000-8000-000000000010';
set local session_replication_role = origin;
select set_config('qorpera_test.r773_job', (select job.id::text from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.job_id = job.id
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
	where job.status = 'leased' and sponsor.provider_connection_id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid), false);
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (the
-- harness of 746): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.r771','qorpera_test.r773_job']) name;
select set_config('qorpera_test.r773_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r773_holder', 'dbname=' || current_database());
select dblink_connect('r773_finisher', 'dbname=' || current_database());
select set_config('qorpera_test.r773_' || name || '_pid', pid::text, false)
from unnest(array['holder','finisher']) name, lateral dblink('r773_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r773_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r773_holder_pid'),
			current_setting('qorpera_test.r773_finisher_pid'))) then
		raise exception 'Plan deletion race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r773_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r773_counts as select * from dblink('r773_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r773_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r773_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r773_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r773_rows select v_table, kept.row_value
			from dblink('r773_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r773_collect(p_connection text) returns jsonb language plpgsql as $$
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
create function pg_temp.r773_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r773_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r773_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
create function pg_temp.r773_plan_status() returns text language sql as $$
	select status from public.qorpera_provider_connections where id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid
$$;

-- At the end: remove what the test committed, as 746 does.
create function pg_temp.r773_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r773_first_xid')::xid;
begin
	perform pg_temp.r773_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r773_holder','r773_finisher']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r773_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r773_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r773_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r773_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Plan deletion race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 1. A run host holds the job. A pass of the finisher runs meanwhile: its stop skips the job, and it leaves the plan
--    connection that pays for it, without waiting for the holder. The run host then gets the folder fence (the run
--    entry's KEY SHARE, after the finisher's drain committed): no deadlock.
do $$
declare v_finish jsonb; v_fence jsonb;
begin
	perform dblink_exec('r773_holder', 'begin');
	perform * from dblink('r773_holder', format('select 1 from public.qorpera_runner_jobs where id = %L for update',
		current_setting('qorpera_test.r773_job'))) as held(held integer);
	perform dblink_send_query('r773_finisher',
		'select public.qorpera_finish_company_deletion(''92400000-0000-4000-8000-000000000010'')');
	if pg_temp.r773_waited_for('finisher', current_setting('qorpera_test.r773_holder_pid')::integer) then
		perform dblink_exec('r773_holder', 'rollback');
		raise exception 'Plan deletion race: the finisher waited for a job a run host holds: %', pg_temp.r773_collect('r773_finisher'); end if;
	v_finish := pg_temp.r773_collect('r773_finisher');
	if v_finish ? 'error' or v_finish #>> '{result,state}' <> 'waiting'
		or v_finish #>> '{result,holdings,chatgpt_plan_logins}' <> '1' then
		perform dblink_exec('r773_holder', 'rollback');
		raise exception 'Plan deletion race: the finisher pass beside the held job: %', v_finish; end if;
	if pg_temp.r773_plan_status() <> 'active' then
		perform dblink_exec('r773_holder', 'rollback');
		raise exception 'Plan deletion race: the plan connection was revoked while its job was held'; end if;
	perform dblink_send_query('r773_holder', $q$select to_jsonb(revision) from public.qorpera_folder_fences
		where profile_id = '92400000-0000-4000-8000-000000000010' for key share$q$);
	v_fence := pg_temp.r773_collect('r773_holder');
	perform dblink_exec('r773_holder', 'rollback');
	if v_fence ? 'error' or v_fence -> 'result' is null or v_fence -> 'result' = 'null'::jsonb then
		raise exception 'Plan deletion race: the run host did not get the folder fence: %', v_fence; end if;
end $$;

-- 2. The next pass ends the job, which nothing holds now, and revokes the plan connection.
do $$
declare v_finish jsonb;
begin
	perform dblink_send_query('r773_finisher',
		'select public.qorpera_finish_company_deletion(''92400000-0000-4000-8000-000000000010'')');
	v_finish := pg_temp.r773_collect('r773_finisher');
	if v_finish ? 'error' or v_finish #>> '{result,state}' <> 'waiting' or pg_temp.r773_plan_status() <> 'revoked'
		or (select status from public.qorpera_runner_jobs where id = current_setting('qorpera_test.r773_job')::uuid) in ('queued', 'leased') then
		raise exception 'Plan deletion race: the pass after the run host: %, plan connection %', v_finish, pg_temp.r773_plan_status(); end if;
end $$;

select pg_temp.r773_cleanup();
