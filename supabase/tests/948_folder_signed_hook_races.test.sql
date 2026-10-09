-- @fixture 987_folder_signed_hooks.test.sql until "-- 0. Before the wake's acknowledgement"
-- Company folder core C4, E3b-2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.7): the races of E3b-1's signed
-- hooks (migration 20260930160000), on 987's fixture committed, from two connections as the broker's route and a member
-- make them:
-- 1. the same opening twice at once (the runtime's retry): the second waits for the run, then answers from the first's
--    receipt, and its secret id and envelope are never stored;
-- 2. two runs open hooks of the same name: the second waits for the company's hook claim, then is refused, and writes
--    nothing; 3. when the first rolls back, the second opens it;
-- 4. a fill holds the hook while the owner removes it: the removal waits, then revokes the secret the fill read;
-- 5. a fill holds the secret while the owner revokes it: the revoke waits, then revokes it;
-- 6. a revoke holds the secret: the fill waits, then is refused, and types nothing;
-- 7. a removal holds the hook: the fill waits, then is refused.
-- Alice's run (924's) and Bob's (the owner's post in Bob's thread, leased as 715 leases it) are the company's two runs.

-- Bob's run, which has spoken (a progress message), so it may work before it answers.
do $$
declare v_pass jsonb; v_binding jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Open the shop''s hooks.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'Bob''s run: ' || v_pass::text);
	v_binding := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.base_public_send(v_binding, 'progress', 'r948-bob-ack');
	perform set_config('qorpera_test.r948_bob', v_binding::text, false);
end
$$;

-- Row locks and advisory claims show only across connections, so 924's and 987's fixtures and this one are committed here
-- and removed again at the end (the harness of 602, 746, 793 and 861): the test refuses to run beside other connections
-- to this database, whose rows the cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.base_binding', current_setting('qorpera_test.base_binding'), false);
select set_config('qorpera_test.r948_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r948_holder', 'dbname=' || current_database());
select dblink_connect('r948_caller', 'dbname=' || current_database());
select set_config('qorpera_test.r948_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('r948_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r948_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r948_holder_pid'),
			current_setting('qorpera_test.r948_caller_pid'))) then
		raise exception 'Signed hook race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r948_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r948_counts as select * from dblink('r948_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r948_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r948_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r948_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r948_rows select v_table, kept.row_value
			from dblink('r948_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- At the end: remove what the test committed, as 861 does.
create function pg_temp.r948_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r948_first_xid')::xid;
begin
	perform pg_temp.r948_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r948_holder','r948_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r948_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r948_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r948_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r948_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Signed hook race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- A connection acts as the broker's own login (no JWT claims, as in production) or as Alice, the owner (PostgREST's role
-- and claims).
create function pg_temp.r948_as(p_connection text, p_who text) returns void language plpgsql as $$
begin
	perform dblink_exec('r948_' || p_connection, 'reset session authorization');
	perform dblink_exec('r948_' || p_connection, 'reset role');
	if p_who = 'broker' then
		perform dblink_exec('r948_' || p_connection, 'set request.jwt.claims = ''''');
		perform dblink_exec('r948_' || p_connection, 'set session authorization qorpera_secret_broker');
	else
		perform dblink_exec('r948_' || p_connection, format('set request.jwt.claims = %L',
			jsonb_build_object('role', 'authenticated', 'sub', '92400000-0000-4000-8000-000000000001')::text));
		perform dblink_exec('r948_' || p_connection, 'set role authenticated');
	end if;
end $$;
select dblink_exec(name, 'set lock_timeout = ''10s''') from unnest(array['r948_holder','r948_caller']) name;
-- The calls, as statements for a connection: the broker's opening on a run (the secret's id ends in p_secret, its
-- envelope is \x0<p_secret>), its fill on Alice's run under receipt p_n, the owner's removal of a hook and revoke of a
-- secret.
create function pg_temp.r948_open(p_binding text, p_request jsonb, p_secret text) returns text language sql as $$
	select format('select public.qorpera_folder_open_signed_hook(%L, %L, %L::jsonb, %s)::text',
		'98700000-0000-4000-8000-000000000040', repeat('9', 64), p_binding,
		pg_temp.e3b_open_args(p_request, p_secret, ('\x0' || p_secret)::bytea))
$$;
create function pg_temp.r948_fill(p_n text, p_envelope text) returns text language sql as $$
	select format('select public.qorpera_fill_event_hook_secret(%L, %L, %L::jsonb, %L, %L, %L)::text',
		'98700000-0000-4000-8000-000000000040', repeat('9', 64), current_setting('qorpera_test.base_binding'),
		'98700000-0000-4000-8000-0000000001' || p_n, p_envelope, repeat('b', 64))
$$;
create function pg_temp.r948_remove(p_hook text) returns text language sql as $$
	select format('select public.qorpera_set_event_hook_status(%L, ''removed'')::text', p_hook)
$$;
create function pg_temp.r948_revoke(p_secret text) returns text language sql as $$
	select format('select public.qorpera_revoke_cloud_secret(''92400000-0000-4000-8000-000000000010'', %L)::text',
		'98700000-0000-4000-8000-000000000' || p_secret)
$$;
-- The holder runs a call in a transaction it keeps open, or in one of its own; either answers 'ok:<answer>' or
-- '<sqlstate>:<message>'.
create function pg_temp.r948_hold(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform dblink_exec('r948_holder', 'begin');
	select r into v from dblink('r948_holder', p_sql) as t(r text);
	return 'ok:' || coalesce(v, '');
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.r948_once(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	select r into v from dblink('r948_holder', p_sql) as t(r text);
	return 'ok:' || coalesce(v, '');
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
-- The caller's sent call's answer, the same way; the connection is ready again afterwards.
create function pg_temp.r948_result() returns text language plpgsql as $$
declare v text; v_out text;
begin
	begin
		select r into v from dblink_get_result('r948_caller') as t(r text);
		v_out := 'ok:' || coalesce(v, '');
	exception when others then v_out := sqlstate || ':' || sqlerrm;
	end;
	begin perform * from dblink_get_result('r948_caller') as t(r text); exception when others then null; end;
	return v_out;
end
$$;
-- Whether the caller waits for the holder: on a row of a table (its tuple lock), or on an advisory claim (10 s at most).
create function pg_temp.r948_waits_at(p_table regclass) returns boolean language plpgsql as $$
declare v_caller integer := current_setting('qorpera_test.r948_caller_pid')::integer;
	v_holder integer := current_setting('qorpera_test.r948_holder_pid')::integer;
begin
	for attempt in 1..400 loop
		if exists (select 1 from pg_catalog.pg_locks where pid = v_caller and locktype = 'tuple' and relation = p_table)
			and v_holder = any(pg_blocking_pids(v_caller)) then return true; end if;
		exit when dblink_is_busy('r948_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
create function pg_temp.r948_waits_on_claim() returns boolean language plpgsql as $$
declare v_caller integer := current_setting('qorpera_test.r948_caller_pid')::integer;
	v_holder integer := current_setting('qorpera_test.r948_holder_pid')::integer;
begin
	for attempt in 1..400 loop
		if exists (select 1 from pg_catalog.pg_locks where pid = v_caller and locktype = 'advisory' and not granted)
			and v_holder = any(pg_blocking_pids(v_caller)) then return true; end if;
		exit when dblink_is_busy('r948_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
-- A failed check rolls the holder back first, so the caller is not left waiting.
create function pg_temp.r948_check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if p_ok is distinct from true then
		begin perform dblink_exec('r948_holder', 'rollback'); exception when others then null; end;
		raise exception '%', p_message;
	end if;
end
$$;
create function pg_temp.r948_audit(p_secret text) returns text[] language sql as $$
	select coalesce(array_agg(event_type order by id), '{}') from public.qorpera_cloud_secret_audit_events
	where secret_id = ('98700000-0000-4000-8000-000000000' || p_secret)::uuid
$$;
create function pg_temp.r948_status(p_secret text) returns text language sql as $$
	select status from public.qorpera_cloud_secrets where id = ('98700000-0000-4000-8000-000000000' || p_secret)::uuid
$$;

-- 1. The same opening twice at once ---------------------------------------------------------------------------------------
-- The runtime's retry while the first call is in flight: the second waits for the run, then answers from the first's
-- receipt; its secret id and envelope are never stored.
select pg_temp.r948_as('holder', 'broker'), pg_temp.r948_as('caller', 'broker');
do $$
declare
	v_request jsonb := pg_temp.e3b_create('r948-same-key', 'r948-one', '{"proof": "github"}');
	v_first text;
	v_second text;
begin
	v_first := pg_temp.r948_hold(pg_temp.r948_open(current_setting('qorpera_test.base_binding'), v_request, '481'));
	perform pg_temp.r948_check(v_first like 'ok:%', '1: the first opening: ' || v_first);
	perform dblink_send_query('r948_caller', pg_temp.r948_open(current_setting('qorpera_test.base_binding'), v_request, '482'));
	perform pg_temp.r948_check(pg_temp.r948_waits_at('public.qorpera_execution_run_budgets'),
		'1: the second opening did not wait for the run');
	perform dblink_exec('r948_holder', 'commit');
	v_second := pg_temp.r948_result();
	perform pg_temp.r948_check(v_second = v_first, '1: the second opening is not the first''s answer: ' || v_second);
	perform pg_temp.r948_check(pg_temp.e3b_answer(v_first) ->> 'secretSite' = 'github.com'
			and pg_temp.r948_status('481') = 'active' and pg_temp.r948_status('482') is null
			and (select count(*) from public.qorpera_cloud_secret_versions
				where secret_id = '98700000-0000-4000-8000-000000000481') = 1,
		'1: the secrets: ' || v_first);
	perform set_config('qorpera_test.r948_one', pg_temp.e3b_answer(v_first) #>> '{hook,id}', false);
end $$;

-- 2. Two runs open hooks of the same name ---------------------------------------------------------------------------------
-- Alice's run holds its opening; Bob's waits for the company's hook claim, then is refused and writes nothing (no hook,
-- secret or receipt).
do $$
declare v_first text; v_second text;
begin
	v_first := pg_temp.r948_hold(pg_temp.r948_open(current_setting('qorpera_test.base_binding'),
		pg_temp.e3b_create('r948-name-a', 'r948-two', '{"proof": "github"}'), '483'));
	perform pg_temp.r948_check(v_first like 'ok:%', '2: Alice''s opening: ' || v_first);
	perform dblink_send_query('r948_caller', pg_temp.r948_open(current_setting('qorpera_test.r948_bob'),
		pg_temp.e3b_create('r948-name-b', 'r948-two', '{"proof": "github"}'), '484'));
	perform pg_temp.r948_check(pg_temp.r948_waits_on_claim(), '2: Bob''s opening did not wait for the company''s hook claim');
	perform dblink_exec('r948_holder', 'commit');
	v_second := pg_temp.r948_result();
	perform pg_temp.r948_check(v_second = '23505:A hook with this name already exists',
		'2: Bob''s opening of a taken name: ' || v_second);
	perform pg_temp.r948_check(pg_temp.r948_status('483') = 'active' and pg_temp.r948_status('484') is null
			and (select count(*) from public.qorpera_event_hooks where name = 'r948-two') = 1
			and not exists (select 1 from public.qorpera_run_operation_receipts
				where run_id = (current_setting('qorpera_test.r948_bob')::jsonb ->> 'runId')::uuid
					and logical_operation_key = 'hook:r948-name-b'),
		'2: Bob''s refused opening wrote something');
end $$;

-- 3. The same, when Alice's opening rolls back: Bob's waits, then opens the hook.
do $$
declare v_first text; v_second text;
begin
	v_first := pg_temp.r948_hold(pg_temp.r948_open(current_setting('qorpera_test.base_binding'),
		pg_temp.e3b_create('r948-name-c', 'r948-three', '{"proof": "github"}'), '485'));
	perform pg_temp.r948_check(v_first like 'ok:%', '3: Alice''s opening: ' || v_first);
	perform dblink_send_query('r948_caller', pg_temp.r948_open(current_setting('qorpera_test.r948_bob'),
		pg_temp.e3b_create('r948-name-d', 'r948-three', '{"proof": "github"}'), '486'));
	perform pg_temp.r948_check(pg_temp.r948_waits_on_claim(), '3: Bob''s opening did not wait for the company''s hook claim');
	perform dblink_exec('r948_holder', 'rollback');
	v_second := pg_temp.r948_result();
	perform pg_temp.r948_check(v_second like 'ok:%' and pg_temp.e3b_answer(v_second) ->> 'secretSite' = 'github.com',
		'3: Bob''s opening after the rollback: ' || v_second);
	perform pg_temp.r948_check(pg_temp.r948_status('486') = 'active' and pg_temp.r948_status('485') is null
			and not exists (select 1 from public.qorpera_run_operation_receipts
				where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
					and logical_operation_key = 'hook:r948-name-c'),
		'3: the rolled back opening left something');
	perform set_config('qorpera_test.r948_three', pg_temp.e3b_answer(v_second) #>> '{hook,id}', false);
end $$;

-- Two more hooks on Alice's run, each opened in a transaction of its own: an HMAC hook (6) and a GitHub hook (7).
do $$
declare v text;
begin
	v := pg_temp.r948_once(pg_temp.r948_open(current_setting('qorpera_test.base_binding'),
		pg_temp.e3b_create('r948-open-six', 'r948-six', '{"proof": "hmac-sha256", "site": "hooks.example.com"}'), '487'));
	perform pg_temp.r948_check(v like 'ok:%', 'The HMAC hook: ' || v);
	perform set_config('qorpera_test.r948_six', pg_temp.e3b_answer(v) #>> '{hook,id}', false);
	v := pg_temp.r948_once(pg_temp.r948_open(current_setting('qorpera_test.base_binding'),
		pg_temp.e3b_create('r948-open-seven', 'r948-seven', '{"proof": "github"}'), '488'));
	perform pg_temp.r948_check(v like 'ok:%', 'The GitHub hook: ' || v);
	perform set_config('qorpera_test.r948_seven', pg_temp.e3b_answer(v) #>> '{hook,id}', false);
end $$;

-- 4. A fill holds the hook while the owner removes it ---------------------------------------------------------------------
-- The removal waits for the hook, then revokes the secret the fill read.
select set_config('qorpera_test.r948_env44',
	pg_temp.e3b_fill_envelope('r948-fill-4', current_setting('qorpera_test.r948_one'))::text, false);
select pg_temp.e3b_begin('44', 'computer_browser:r948-fill-4', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env44')));
select pg_temp.r948_as('holder', 'broker'), pg_temp.r948_as('caller', 'owner');
do $$
declare v_fill text; v_remove text;
begin
	v_fill := pg_temp.r948_hold(pg_temp.r948_fill('44', current_setting('qorpera_test.r948_env44')));
	perform pg_temp.r948_check(v_fill like 'ok:%', '4: the fill: ' || v_fill);
	perform dblink_send_query('r948_caller', pg_temp.r948_remove(current_setting('qorpera_test.r948_one')));
	perform pg_temp.r948_check(pg_temp.r948_waits_at('public.qorpera_event_hooks'), '4: the removal did not wait for the hook');
	perform dblink_exec('r948_holder', 'commit');
	v_remove := pg_temp.r948_result();
	perform pg_temp.r948_check(pg_temp.e3b_answer(v_fill) ->> 'hookId' = current_setting('qorpera_test.r948_one')
			and pg_temp.e3b_answer(v_fill) ->> 'secretId' = '98700000-0000-4000-8000-000000000481'
			and pg_temp.e3b_answer(v_fill) ->> 'receiptId' = '98700000-0000-4000-8000-000000000144',
		'4: the fill''s answer: ' || v_fill);
	perform pg_temp.r948_check(pg_temp.e3b_answer(v_remove) ->> 'status' = 'removed', '4: the removal: ' || v_remove);
	perform pg_temp.r948_check(pg_temp.r948_status('481') = 'revoked'
			and pg_temp.r948_audit('481') = array['hook_secret_made', 'hook_secret_used', 'secret_revoked'],
		'4: the removed hook''s secret: ' || pg_temp.r948_audit('481')::text);
end $$;
select pg_temp.e3b_end('44', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env44')));

-- 5. A fill holds the secret while the owner revokes it -------------------------------------------------------------------
-- The revoke waits for the secret, then revokes it (Bob's hook of 3).
select set_config('qorpera_test.r948_env45',
	pg_temp.e3b_fill_envelope('r948-fill-5', current_setting('qorpera_test.r948_three'))::text, false);
select pg_temp.e3b_begin('45', 'computer_browser:r948-fill-5', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env45')));
do $$
declare v_fill text; v_revoke text;
begin
	v_fill := pg_temp.r948_hold(pg_temp.r948_fill('45', current_setting('qorpera_test.r948_env45')));
	perform pg_temp.r948_check(v_fill like 'ok:%', '5: the fill: ' || v_fill);
	perform dblink_send_query('r948_caller', pg_temp.r948_revoke('486'));
	perform pg_temp.r948_check(pg_temp.r948_waits_at('public.qorpera_cloud_secrets'), '5: the revoke did not wait for the secret');
	perform dblink_exec('r948_holder', 'commit');
	v_revoke := pg_temp.r948_result();
	perform pg_temp.r948_check(pg_temp.e3b_answer(v_fill) ->> 'hookId' = current_setting('qorpera_test.r948_three')
			and pg_temp.e3b_answer(v_fill) ->> 'secretId' = '98700000-0000-4000-8000-000000000486',
		'5: the fill''s answer: ' || v_fill);
	perform pg_temp.r948_check(pg_temp.e3b_answer(v_revoke) ->> 'status' = 'revoked', '5: the revoke: ' || v_revoke);
	perform pg_temp.r948_check(pg_temp.r948_status('486') = 'revoked'
			and pg_temp.r948_audit('486') = array['hook_secret_made', 'hook_secret_used', 'secret_revoked'],
		'5: the revoked secret: ' || pg_temp.r948_audit('486')::text);
end $$;
select pg_temp.e3b_end('45', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env45')));

-- 6. A revoke holds the secret --------------------------------------------------------------------------------------------
-- The fill waits for the secret, then is refused, and types nothing.
select set_config('qorpera_test.r948_env46',
	pg_temp.e3b_fill_envelope('r948-fill-6', current_setting('qorpera_test.r948_six'))::text, false);
select pg_temp.e3b_begin('46', 'computer_browser:r948-fill-6', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env46')));
select pg_temp.r948_as('holder', 'owner'), pg_temp.r948_as('caller', 'broker');
do $$
declare v_revoke text; v_fill text;
begin
	v_revoke := pg_temp.r948_hold(pg_temp.r948_revoke('487'));
	perform pg_temp.r948_check(pg_temp.e3b_answer(v_revoke) ->> 'status' = 'revoked', '6: the revoke: ' || v_revoke);
	perform dblink_send_query('r948_caller', pg_temp.r948_fill('46', current_setting('qorpera_test.r948_env46')));
	perform pg_temp.r948_check(pg_temp.r948_waits_at('public.qorpera_cloud_secrets'), '6: the fill did not wait for the secret');
	perform dblink_exec('r948_holder', 'commit');
	v_fill := pg_temp.r948_result();
	perform pg_temp.r948_check(v_fill = '55000:This hook''s secret is gone from the vault', '6: the fill of a revoked secret: ' || v_fill);
	perform pg_temp.r948_check(pg_temp.r948_audit('487') = array['hook_secret_made', 'secret_revoked'],
		'6: the revoked secret''s audit: ' || pg_temp.r948_audit('487')::text);
end $$;
select pg_temp.e3b_end('46', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env46')));

-- 7. A removal holds the hook ---------------------------------------------------------------------------------------------
-- The fill waits for the hook, then is refused.
select set_config('qorpera_test.r948_env47',
	pg_temp.e3b_fill_envelope('r948-fill-7', current_setting('qorpera_test.r948_seven'))::text, false);
select pg_temp.e3b_begin('47', 'computer_browser:r948-fill-7', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env47')));
do $$
declare v_remove text; v_fill text;
begin
	v_remove := pg_temp.r948_hold(pg_temp.r948_remove(current_setting('qorpera_test.r948_seven')));
	perform pg_temp.r948_check(pg_temp.e3b_answer(v_remove) ->> 'status' = 'removed', '7: the removal: ' || v_remove);
	perform dblink_send_query('r948_caller', pg_temp.r948_fill('47', current_setting('qorpera_test.r948_env47')));
	perform pg_temp.r948_check(pg_temp.r948_waits_at('public.qorpera_event_hooks'), '7: the fill did not wait for the hook');
	perform dblink_exec('r948_holder', 'commit');
	v_fill := pg_temp.r948_result();
	perform pg_temp.r948_check(v_fill = '55000:This hook was removed', '7: the fill of a removed hook: ' || v_fill);
	perform pg_temp.r948_check(pg_temp.r948_status('488') = 'revoked'
			and pg_temp.r948_audit('488') = array['hook_secret_made', 'secret_revoked'],
		'7: the removed hook''s secret: ' || pg_temp.r948_audit('488')::text);
end $$;
select pg_temp.e3b_end('47', pg_temp.e3b_sha(current_setting('qorpera_test.r948_env47')));

-- What the races left: the hooks and the secrets the broker chose.
do $$
begin
	perform pg_temp.r948_check((select array_agg(name || ':' || status order by name) from public.qorpera_event_hooks
			where name like 'r948-%') = array['r948-one:removed', 'r948-seven:removed', 'r948-six:active', 'r948-three:active',
			'r948-two:active'],
		'The hooks: ' || (select array_agg(name || ':' || status order by name) from public.qorpera_event_hooks
			where name like 'r948-%')::text);
	perform pg_temp.r948_check((select array_agg(right(id::text, 3) || ':' || status order by id) from public.qorpera_cloud_secrets
			where id::text like '98700000-0000-4000-8000-000000000%' and right(id::text, 3) between '481' and '489')
			= array['481:revoked', '483:active', '486:revoked', '487:revoked', '488:revoked'],
		'The secrets: ' || (select array_agg(right(id::text, 3) || ':' || status order by id) from public.qorpera_cloud_secrets
			where id::text like '98700000-0000-4000-8000-000000000%' and right(id::text, 3) between '481' and '489')::text);
end $$;

select pg_temp.r948_cleanup();
