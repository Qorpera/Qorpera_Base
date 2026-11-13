-- @fixture 1252_site_hosts.test.sql until "-- 10c. A takedown sticks"
-- A takedown and the calls it must stop, on two connections (migration 20260930756000; the review of #1774, round 1).
-- Locks show only across connections, so 1252's fixture (its sites, and its agent's run) is committed here and removed
-- again at the end (the harness of 746 and 773): the test refuses to run beside other connections to this database,
-- whose rows the cleanup could not tell from its own. Each call that must wait is seen waiting with pg_blocking_pids,
-- never by time; every connection gives up after 20 s.
--   F1. A company's deletion and a takedown of one of its sites, in both orders: the takedown first (its transaction
--       open), and the finisher waits for it, then sees it and waits; the finisher first (its pass open), and the
--       takedown waits for it, then finds no site of that name.
--   F2. A takedown on its way (its transaction open) while an agent takes its app link offline, or puts a publish's
--       files: the agent's call waits for the site's row, then reads the takedown and is refused, writing nothing.
--   Round 3. The same while the executor's upload pass puts the bytes of a repository's site, or finishes its version
--       (change 4 of company/h-look, due at the end of 1252's fixture): refused SITE_TAKEN_DOWN, nothing written.
-- The other company (91170000-…010, 1170's) has the site race-down, abandoned two days ago, and its deletion asked.

select pg_temp.rel_other_site('race-down', interval '2 days');
insert into public.qorpera_company_deletions (profile_id) values ('91170000-0000-4000-8000-000000000010');

reset role;
select set_config('qorpera_test.base_binding', current_setting('qorpera_test.base_binding'), false) \g /dev/null
select set_config('qorpera_test.r1254_first_xid', xid(pg_current_xact_id())::text, false) \g /dev/null
select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['r1254_hold', 'r1254_act']) name \g /dev/null
select set_config('qorpera_test.r1254_' || name || '_pid', pid::text, false)
from unnest(array['hold', 'act']) name, lateral dblink('r1254_' || name, 'select pg_backend_pid()') as backend(pid integer) \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['r1254_hold', 'r1254_act']) name \g /dev/null
create function pg_temp.r1254_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r1254_hold_pid'),
			current_setting('qorpera_test.r1254_act_pid'))) then
		raise exception 'Takedown race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r1254_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r1254_counts as select * from dblink('r1254_hold', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r1254_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r1254_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r1254_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r1254_rows select v_table, kept.row_value
			from dblink('r1254_hold', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- Whether r1254_act's call waits on r1254_hold; false when the call ended first.
create function pg_temp.r1254_waits() returns boolean language plpgsql as $$
declare v_hold integer := current_setting('qorpera_test.r1254_hold_pid')::integer;
	v_act integer := current_setting('qorpera_test.r1254_act_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_hold = any(pg_blocking_pids(v_act)) then return true; end if;
		exit when dblink_is_busy('r1254_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
-- The answer of r1254_act's call, or its error as {"error":<sqlstate>,"message":…}.
create function pg_temp.r1254_answer() returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result('r1254_act') as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result('r1254_act') as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result('r1254_act') as call(answer text);
	return v::jsonb;
end $$;
-- r1254_act as the native host the runtime calls through (the service role), or as the database owner (null).
create function pg_temp.r1254_act_as(p_role text) returns void language plpgsql as $$
begin
	perform dblink_exec('r1254_act', 'reset role');
	perform dblink_exec('r1254_act', format('set request.jwt.claims = %L',
		case when p_role is null then '{}' else jsonb_build_object('role', p_role)::text end));
	if p_role is not null then perform dblink_exec('r1254_act', format('set role %I', p_role)); end if;
end $$;
-- The takedown of p_slug, as the operator runs it, on r1254_hold in a transaction left open.
create function pg_temp.r1254_hold_takedown(p_slug text) returns void language plpgsql as $$
begin
	perform dblink_exec('r1254_hold', 'begin');
	perform * from dblink('r1254_hold', format('select public.qorpera_site_take_down(%L, %L)::text', p_slug, 'Reported.'))
		as held(answer text);
end $$;

-- At the end: remove what the test committed, as 746 and 773 do.
create function pg_temp.r1254_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r1254_first_xid')::xid;
begin
	perform pg_temp.r1254_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r1254_hold', 'r1254_act']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r1254_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r1254_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r1254_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r1254_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Takedown race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- F2. An agent takes its app link offline while the operator's takedown of it is on its way: the call waits for the
-- link's row, then reads the takedown and is refused in its words; the link stays shared (its key, claims and
-- visitors' sessions too), so a restore gives it back as it was.
do $$
declare v jsonb; v_app jsonb := to_jsonb(pg_temp.sh_site('link-app'));
begin
	if v_app ->> 'published_at' is null then raise exception 'F2: the fixture''s app link is not shared: %', v_app; end if;
	perform pg_temp.r1254_act_as('service_role');
	perform pg_temp.r1254_hold_takedown('link-app');
	perform dblink_send_query('r1254_act', format('select public.qorpera_site_unpublish(%L, %L)::text',
		current_setting('qorpera_test.base_binding'), 'link-app'));
	if not pg_temp.r1254_waits() then
		perform dblink_exec('r1254_hold', 'rollback');
		raise exception 'F2: the agent''s unpublish did not wait for the takedown on its way: %', pg_temp.r1254_answer(); end if;
	perform dblink_exec('r1254_hold', 'commit');
	v := pg_temp.r1254_answer();
	if v ->> 'error' is distinct from '55000' or v ->> 'message' is distinct from public.qorpera_site_taken_down_words('Reported.')
		or (pg_temp.sh_site('link-app')).published_at is null
		or to_jsonb(pg_temp.sh_site('link-app')) -> 'app_key_sha256' is distinct from v_app -> 'app_key_sha256'
		or (pg_temp.sh_site('link-app')).taken_down_at is null then
		raise exception 'F2: the app link after the agent''s unpublish beside a takedown: %, the link %', v,
			to_jsonb(pg_temp.sh_site('link-app')); end if;
	perform public.qorpera_site_restore('link-app');
	if (pg_temp.sh_site('link-app')).published_at is null then
		raise exception 'F2: the restore did not give the link back as it was'; end if;
end $$;

-- F2. An agent puts a publish's files while the operator's takedown of its site is on its way: the put waits for the
-- site (shared, before its version), then reads the takedown and is refused; nothing of it is kept.
do $$
declare v jsonb; v_files jsonb := (select jsonb_agg(to_jsonb(file) order by file.path) from public.qorpera_company_site_files file
	where file.version_id = '12520000-0000-4000-8000-000000000041');
begin
	perform pg_temp.r1254_act_as('service_role');
	perform pg_temp.r1254_hold_takedown('agent-shop');
	perform dblink_send_query('r1254_act', format('select public.qorpera_site_publish_put(%L, %L, %L)::text',
		current_setting('qorpera_test.base_binding'), '12520000-0000-4000-8000-000000000041',
		'[{"path":"index.html","content":"PHA+"}]'));
	if not pg_temp.r1254_waits() then
		perform dblink_exec('r1254_hold', 'rollback');
		raise exception 'F2: the put did not wait for the takedown on its way: %', pg_temp.r1254_answer(); end if;
	perform dblink_exec('r1254_hold', 'commit');
	v := pg_temp.r1254_answer();
	if v ->> 'error' is distinct from '55000'
		or v ->> 'message' is distinct from public.qorpera_site_taken_down_words('Reported.')
		or (select jsonb_agg(to_jsonb(file) order by file.path) from public.qorpera_company_site_files file
			where file.version_id = '12520000-0000-4000-8000-000000000041') is distinct from v_files then
		raise exception 'F2: the put beside a takedown: %', v; end if;
	perform public.qorpera_site_restore('agent-shop');
end $$;

-- Round 3. The executor's upload of change 4 of company/h-look (look-shop) begins and lists its files, committed.
select set_config('qorpera_test.r1254_version',
	pg_temp.rel_begin('h-look', 4, pg_temp.rel_manifest(pg_temp.rel_texts('h4'))) ->> 'versionId', false) \g /dev/null
select pg_temp.base_assert(pg_temp.rel_list(current_setting('qorpera_test.r1254_version')::uuid,
	pg_temp.rel_files(pg_temp.rel_texts('h4')), true) ->> 'state' = 'listed', 'the upload is listed') \g /dev/null
-- Its put while a takedown is on its way: the put waits for the site (shared, before the version), then reads the
-- takedown and is refused; no bytes are kept (the listing copied some from the site's other versions already).
do $$
declare v jsonb; v_kept jsonb := (select jsonb_agg(jsonb_build_array(file.path, file.content is not null) order by file.path)
	from public.qorpera_company_site_files file where file.version_id = current_setting('qorpera_test.r1254_version')::uuid);
begin
	if v_kept is null or not exists (select 1 from jsonb_array_elements(v_kept) kept where kept -> 1 = 'false') then
		raise exception 'Round 3: the listed upload has no file left to put: %', v_kept; end if;
	perform pg_temp.r1254_act_as('service_role');
	perform pg_temp.r1254_hold_takedown('look-shop');
	perform dblink_send_query('r1254_act', format('select public.qorpera_code_site_put(%L, %L, %L, %L)::text', 'exec-1170',
		repeat('5', 64), current_setting('qorpera_test.r1254_version'),
		jsonb_build_object('parts', pg_temp.rel_parts(pg_temp.rel_texts('h4')))));
	if not pg_temp.r1254_waits() then
		perform dblink_exec('r1254_hold', 'rollback');
		raise exception 'Round 3: the upload''s put did not wait for the takedown on its way: %', pg_temp.r1254_answer(); end if;
	perform dblink_exec('r1254_hold', 'commit');
	v := pg_temp.r1254_answer();
	if v is distinct from '{"schema":"qorpera.code-site-put/v1","state":"refused","code":"SITE_TAKEN_DOWN"}'::jsonb
		or (select jsonb_agg(jsonb_build_array(file.path, file.content is not null) order by file.path)
			from public.qorpera_company_site_files file where file.version_id = current_setting('qorpera_test.r1254_version')::uuid)
			is distinct from v_kept
		or exists (select 1 from public.qorpera_company_site_file_parts
			where version_id = current_setting('qorpera_test.r1254_version')::uuid) then
		raise exception 'Round 3: the upload''s put beside a takedown: %', v; end if;
end $$;
select public.qorpera_site_restore('look-shop') \g /dev/null
select pg_temp.base_assert(pg_temp.rel_put(current_setting('qorpera_test.r1254_version')::uuid,
	pg_temp.rel_parts(pg_temp.rel_texts('h4'))) ->> 'state' = 'kept', 'the bytes once restored') \g /dev/null
-- Its finish while a takedown is on its way: the finish waits (the registry row, then the site), then reads the
-- takedown and is refused; the version stays uploading.
do $$
declare v jsonb;
begin
	perform pg_temp.r1254_act_as('service_role');
	perform pg_temp.r1254_hold_takedown('look-shop');
	perform dblink_send_query('r1254_act', format('select public.qorpera_code_site_finish(%L, %L, %L)::text', 'exec-1170',
		repeat('5', 64), current_setting('qorpera_test.r1254_version')));
	if not pg_temp.r1254_waits() then
		perform dblink_exec('r1254_hold', 'rollback');
		raise exception 'Round 3: the upload''s finish did not wait for the takedown on its way: %', pg_temp.r1254_answer(); end if;
	perform dblink_exec('r1254_hold', 'commit');
	v := pg_temp.r1254_answer();
	if v is distinct from '{"schema":"qorpera.code-site-finish/v1","state":"refused","code":"SITE_TAKEN_DOWN"}'::jsonb
		or (select state from public.qorpera_company_site_versions where id = current_setting('qorpera_test.r1254_version')::uuid)
			<> 'uploading' then
		raise exception 'Round 3: the upload''s finish beside a takedown: %', v; end if;
end $$;
select public.qorpera_site_restore('look-shop') \g /dev/null

-- F1, the takedown first. Its transaction is open when the finisher's pass comes: the pass waits for it (the company's
-- fence and row), then counts the site taken down and waits; the site and its name stay.
do $$
declare v jsonb;
begin
	perform pg_temp.r1254_act_as(null);
	perform pg_temp.r1254_hold_takedown('race-down');
	perform dblink_send_query('r1254_act',
		'select public.qorpera_finish_company_deletion(''91170000-0000-4000-8000-000000000010'')::text');
	if not pg_temp.r1254_waits() then
		perform dblink_exec('r1254_hold', 'rollback');
		raise exception 'F1: the finisher did not wait for the takedown on its way: %', pg_temp.r1254_answer(); end if;
	perform dblink_exec('r1254_hold', 'commit');
	v := pg_temp.r1254_answer();
	if v ->> 'state' is distinct from 'waiting' or v #>> '{holdings,taken_down_sites}' is distinct from '1'
		or (pg_temp.sh_site('race-down')).taken_down_at is null
		or not exists (select 1 from public.qorpera_profiles where id = '91170000-0000-4000-8000-000000000010') then
		raise exception 'F1: the finisher after a takedown on its way: %', v; end if;
end $$;

-- F1, the finisher first. Restored (committed on its own, as the operator runs it), the company's deletion goes on: its
-- pass is open when the takedown comes, which waits for it (the company's fence and row), then finds no site of that
-- name. Nothing is taken down.
select public.qorpera_site_restore('race-down') \g /dev/null
do $$
declare v jsonb; v_pass text;
begin
	perform pg_temp.r1254_act_as(null);
	perform dblink_exec('r1254_hold', 'begin');
	select answer into v_pass from dblink('r1254_hold',
		'select public.qorpera_finish_company_deletion(''91170000-0000-4000-8000-000000000010'')::text') as pass(answer text);
	if v_pass::jsonb ->> 'state' is distinct from 'purged' then
		perform dblink_exec('r1254_hold', 'rollback');
		raise exception 'F1: the finisher''s pass after the restore: %', v_pass; end if;
	perform dblink_send_query('r1254_act', format('select public.qorpera_site_take_down(%L, %L)::text', 'race-down', 'Reported.'));
	if not pg_temp.r1254_waits() then
		perform dblink_exec('r1254_hold', 'rollback');
		raise exception 'F1: the takedown did not wait for the finisher''s pass: %', pg_temp.r1254_answer(); end if;
	perform dblink_exec('r1254_hold', 'commit');
	v := pg_temp.r1254_answer();
	if v ->> 'error' is distinct from 'P0002' or v ->> 'message' is distinct from 'No site has this name'
		or (pg_temp.sh_site('race-down')).id is not null
		or exists (select 1 from public.qorpera_profiles where id = '91170000-0000-4000-8000-000000000010') then
		raise exception 'F1: the takedown after the finisher''s pass: %', v; end if;
end $$;

select pg_temp.r1254_cleanup();
