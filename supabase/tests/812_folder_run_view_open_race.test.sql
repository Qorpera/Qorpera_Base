-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- F3, the run view open (20260928439970) under concurrency: two first opens in one job at once, two opens with a view
-- open, an open beside a save in flight through the view, an open beside the run's completion, a refused actor beside
-- a held job, and a renewal beside a save in flight (20260930001000). The order is the run completion's (job, then the
-- job's run views, then the view open's run entry), so nothing deadlocks, a refused call never waits, the last
-- opener's view wins, and a renewal waits for a save only when it closes the view.
create function pg_temp.human() returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
begin
	return jsonb_build_object('actor', p, 'binding', pg_temp.native(p));
end $$;

-- Row locks show only across connections, so the fixture is committed here and removed again at the end (the
-- harness of 602, 746 and 793): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.r812_first_xid', xid(pg_current_xact_id())::text, false);
select set_config('qorpera_test.r812_p', (pg_temp.human() -> 'actor')::text, false);
select set_config('qorpera_test.r812_q', (pg_temp.human() -> 'actor')::text, false);
select dblink_connect('r812_a', 'dbname=' || current_database());
select dblink_connect('r812_b', 'dbname=' || current_database());
select set_config('qorpera_test.r812_' || name || '_pid', pid::text, false)
from unnest(array['a','b']) name, lateral dblink('r812_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r812_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r812_a_pid'), current_setting('qorpera_test.r812_b_pid'))) then
		raise exception 'Run view race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r812_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r812_counts as select * from dblink('r812_a', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r812_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r812_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r812_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r812_rows select v_table, kept.row_value
			from dblink('r812_a', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r812_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- Whether the connection's call waited for a lock the other connection holds before it finished (10 s at most).
create function pg_temp.r812_waited(p_connection text, p_for text) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r812_' || p_connection || '_pid')::integer;
	v_by integer := current_setting('qorpera_test.r812_' || p_for || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r812_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
-- A transaction on a connection as the native host's calls run: service_role.
create function pg_temp.r812_begin(p_connection text) returns void language plpgsql as $$
begin
	perform dblink_exec('r812_' || p_connection, 'begin');
	perform * from dblink('r812_' || p_connection,
		$q$select set_config('request.jwt.claims', '{"role":"service_role"}', true)$q$) as c(claims text);
end $$;
create function pg_temp.r812_open_sql(p_actor text) returns text language sql as $$
	select format('select public.qorpera_folder_run_view_open(%L, %L)', '63400000-0000-4000-8000-000000000020', p_actor)
$$;
create function pg_temp.r812_open_views(p_actor text) returns bigint language sql as $$
	select count(*) from dblink('r812_a', format($q$select id from public.qorpera_folder_views
		where job_id = %L and kind = 'run_box' and state = 'open'$q$, p_actor::jsonb ->> 'jobId')) as v(id uuid)
$$;
create function pg_temp.r812_view_state(p_view jsonb) returns text language sql as $$
	select state || coalesce('/' || reason, '') from dblink('r812_a', format($q$select state, close_reason
		from public.qorpera_folder_views where id = %L$q$, p_view ->> 'viewId')) as v(state text, reason text)
$$;

-- At the end: remove what the test committed, as 602, 746 and 793 do.
create function pg_temp.r812_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r812_first_xid')::xid;
begin
	perform pg_temp.r812_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r812_a','r812_b']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r812_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r812_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r812_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r812_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Run view race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 1. Two first opens in one job at once: the second waits for the first's view, then closes it and opens its own.
do $$
declare v_first jsonb; v_second jsonb; p text := current_setting('qorpera_test.r812_p');
begin
	perform pg_temp.r812_begin('a');
	perform pg_temp.r812_begin('b');
	select result into v_first from dblink('r812_a', pg_temp.r812_open_sql(p)) as call(result jsonb);
	perform dblink_send_query('r812_b', pg_temp.r812_open_sql(p));
	if not pg_temp.r812_waited('b', 'a') then
		raise exception 'A second first open did not wait for the first: %', pg_temp.r812_collect('r812_b'); end if;
	perform dblink_exec('r812_a', 'commit');
	v_second := pg_temp.r812_collect('r812_b');
	if v_second ? 'error' then raise exception 'Two first opens at once: the second failed: %', v_second; end if;
	perform dblink_exec('r812_b', 'commit');
	if pg_temp.r812_view_state(v_first) <> 'closed/superseded' or pg_temp.r812_view_state(v_second -> 'result') <> 'open'
		or pg_temp.r812_open_views(p) <> 1 then
		raise exception 'Two first opens at once: % then %', pg_temp.r812_view_state(v_first),
			pg_temp.r812_view_state(v_second -> 'result'); end if;
end $$;

-- 2. Two opens with a view open: the second waits for the first, then supersedes its new view.
do $$
declare v_first jsonb; v_second jsonb; p text := current_setting('qorpera_test.r812_p');
begin
	perform pg_temp.r812_begin('a');
	perform pg_temp.r812_begin('b');
	select result into v_first from dblink('r812_a', pg_temp.r812_open_sql(p)) as call(result jsonb);
	perform dblink_send_query('r812_b', pg_temp.r812_open_sql(p));
	if not pg_temp.r812_waited('b', 'a') then
		raise exception 'A second open did not wait for the first: %', pg_temp.r812_collect('r812_b'); end if;
	perform dblink_exec('r812_a', 'commit');
	v_second := pg_temp.r812_collect('r812_b');
	if v_second ? 'error' then raise exception 'Two opens with a view open: %', v_second; end if;
	perform dblink_exec('r812_b', 'commit');
	if pg_temp.r812_view_state(v_first) <> 'closed/superseded' or pg_temp.r812_open_views(p) <> 1 then
		raise exception 'Two opens with a view open left %', pg_temp.r812_view_state(v_first); end if;
end $$;

-- 3. A save in flight through the open view (the job and the view row KEY SHARE, as a commit through a view takes
--    them): the open waits it out, then supersedes the view.
do $$
declare v_outcome jsonb; p text := current_setting('qorpera_test.r812_p');
begin
	perform pg_temp.r812_begin('a');
	perform * from dblink('r812_a', format('select 1 from public.qorpera_runner_jobs where id = %L for key share',
		p::jsonb ->> 'jobId')) as held(one integer);
	perform * from dblink('r812_a', format($q$select 1 from public.qorpera_folder_views where job_id = %L and kind = 'run_box'
		and state = 'open' for key share$q$, p::jsonb ->> 'jobId')) as held(one integer);
	perform pg_temp.r812_begin('b');
	perform dblink_send_query('r812_b', pg_temp.r812_open_sql(p));
	if not pg_temp.r812_waited('b', 'a') then
		perform dblink_exec('r812_a', 'rollback');
		raise exception 'An open did not wait for a save in flight: %', pg_temp.r812_collect('r812_b'); end if;
	perform dblink_exec('r812_a', 'commit');
	v_outcome := pg_temp.r812_collect('r812_b');
	perform dblink_exec('r812_b', 'commit');
	if v_outcome ? 'error' or pg_temp.r812_open_views(p) <> 1 then
		raise exception 'An open beside a save in flight: %', v_outcome; end if;
end $$;

-- 4. The run's completion (the job FOR UPDATE, then its run views, as 20260928279600 takes them): an open waits at
--    the job and, once the run has ended, is refused; neither deadlocks.
do $$
declare v_outcome jsonb; p text := current_setting('qorpera_test.r812_p');
begin
	perform pg_temp.r812_begin('a');
	perform * from dblink('r812_a', format('select 1 from public.qorpera_runner_jobs where id = %L for update',
		p::jsonb ->> 'jobId')) as held(one integer);
	perform pg_temp.r812_begin('b');
	perform dblink_send_query('r812_b', pg_temp.r812_open_sql(p));
	if not pg_temp.r812_waited('b', 'a') then
		perform dblink_exec('r812_a', 'rollback');
		raise exception 'An open did not wait for the run''s completion: %', pg_temp.r812_collect('r812_b'); end if;
	perform * from dblink('r812_a', format($q$select 1 from public.qorpera_folder_views where kind = 'run_box' and run_id = %L
		and state = 'open' order by id for update$q$, p::jsonb ->> 'runId')) as held(one integer);
	perform dblink_exec('r812_a', format($q$update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(),
		close_reason = 'ended' where kind = 'run_box' and run_id = %L and state = 'open'$q$, p::jsonb ->> 'runId'));
	perform dblink_exec('r812_a', format($q$update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
		where id = %L$q$, p::jsonb ->> 'jobId'));
	perform dblink_exec('r812_a', 'commit');
	v_outcome := pg_temp.r812_collect('r812_b');
	perform dblink_exec('r812_b', 'rollback');
	if v_outcome ->> 'state' is distinct from '42501' then
		raise exception 'An open after the run''s completion: %', v_outcome; end if;
	if pg_temp.r812_open_views(p) <> 0 then raise exception 'The ended run kept an open view'; end if;
end $$;

-- 5. A refused actor (another assignment) while another transaction holds the job: refused at once, without waiting.
do $$
declare v_outcome jsonb; q text := current_setting('qorpera_test.r812_q');
begin
	perform pg_temp.r812_begin('a');
	perform * from dblink('r812_a', format('select 1 from public.qorpera_runner_jobs where id = %L for update',
		q::jsonb ->> 'jobId')) as held(one integer);
	perform pg_temp.r812_begin('b');
	perform dblink_send_query('r812_b', pg_temp.r812_open_sql(jsonb_set(q::jsonb, '{assignmentId}',
		to_jsonb(extensions.gen_random_uuid()::text))::text));
	if pg_temp.r812_waited('b', 'a') then
		perform dblink_exec('r812_a', 'rollback');
		raise exception 'A refused open waited for the job row: %', pg_temp.r812_collect('r812_b'); end if;
	v_outcome := pg_temp.r812_collect('r812_b');
	perform dblink_exec('r812_b', 'rollback');
	perform dblink_exec('r812_a', 'rollback');
	if v_outcome ->> 'state' is distinct from '42501' or v_outcome ->> 'error' is distinct from 'Folder run is not current' then
		raise exception 'A refused open: %', v_outcome; end if;
end $$;

-- 6. Renewal beside a save in flight through the view (the view row KEY SHARE): renewing it never waits; closing a
--    view that no longer matches its anchor (here the job's lease has ended) waits the save out first, so nothing
--    lands through a closed view (C1B §4; 20260930001000).
do $$
declare v_view jsonb; v_outcome jsonb; q text := current_setting('qorpera_test.r812_q');
	c_renew constant text := 'select public.qorpera_folder_view_renew(%L, %L)';
begin
	perform pg_temp.r812_begin('b');
	select result into v_view from dblink('r812_b', pg_temp.r812_open_sql(q)) as opened(result jsonb);
	perform dblink_exec('r812_b', 'commit');
	-- A renewal beside the save: answered at once, still open.
	perform pg_temp.r812_begin('a');
	perform * from dblink('r812_a', format('select 1 from public.qorpera_folder_views where id = %L for key share',
		v_view ->> 'viewId')) as held(one integer);
	perform pg_temp.r812_begin('b');
	perform dblink_send_query('r812_b', format(c_renew, v_view ->> 'viewId', v_view ->> 'pass'));
	if pg_temp.r812_waited('b', 'a') then
		perform dblink_exec('r812_a', 'rollback');
		raise exception 'A renewal waited for a save in flight: %', pg_temp.r812_collect('r812_b'); end if;
	v_outcome := pg_temp.r812_collect('r812_b');
	perform dblink_exec('r812_b', 'commit');
	perform dblink_exec('r812_a', 'rollback');
	if v_outcome -> 'result' ->> 'state' is distinct from 'open' then raise exception 'A renewal beside a save: %', v_outcome; end if;
	-- The job's lease ends, so the view no longer matches its anchor; a save is in flight through it.
	perform pg_temp.r812_begin('a');
	perform dblink_exec('r812_a', format($q$update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
		where id = %L$q$, q::jsonb ->> 'jobId'));
	perform dblink_exec('r812_a', 'commit');
	perform pg_temp.r812_begin('a');
	perform * from dblink('r812_a', format('select 1 from public.qorpera_folder_views where id = %L for key share',
		v_view ->> 'viewId')) as held(one integer);
	perform pg_temp.r812_begin('b');
	perform dblink_send_query('r812_b', format(c_renew, v_view ->> 'viewId', v_view ->> 'pass'));
	if not pg_temp.r812_waited('b', 'a') then
		perform dblink_exec('r812_a', 'rollback');
		raise exception 'Closing a view did not wait for its save in flight: %', pg_temp.r812_collect('r812_b'); end if;
	if pg_temp.r812_view_state(v_view) <> 'open' then raise exception 'The view closed before its save ended'; end if;
	perform dblink_exec('r812_a', 'commit');
	v_outcome := pg_temp.r812_collect('r812_b');
	perform dblink_exec('r812_b', 'commit');
	if v_outcome -> 'result' ->> 'state' is distinct from 'closed' or v_outcome -> 'result' ->> 'reason' is distinct from 'ended'
		or pg_temp.r812_view_state(v_view) <> 'closed/ended' then
		raise exception 'Closing a view after its save: % (%)', v_outcome, pg_temp.r812_view_state(v_view); end if;
end $$;

select pg_temp.r812_cleanup();
