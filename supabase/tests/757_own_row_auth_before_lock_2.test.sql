-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260928339820 on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): five functions that serve only
-- a company's owners and admins refuse anyone else before they lock the row their arguments name, so a caller they
-- refuse cannot queue for that row: a run operation receipt's resolution, an event hook's status, and an execution
-- sponsor's, a logical computer's and a provider connection's status. Here a second connection holds the row the
-- function locks first (the company row for the hook, which takes it before the hook on folder-v2). Someone outside
-- the company, a caller with the publishable key only (where that key may call the function) and the contributor are
-- refused at once, with the locked check's error; so are the viewer and the contributor revoking the company's
-- connection, which has no owner. The locked checks stay: an admin passes the plain check and waits for the row, the
-- owner makes them a contributor meanwhile, and the call is refused after the wait. On the previous function text every
-- refused call waited for the row. Test 924's fixture gives Alice's run, the owner's sponsor and the owner's
-- connection; this adds a receipt of the run in flight, a hook, a logical computer and a company connection through
-- their real paths. Row locks show only across connections, so the fixture is committed and removed again at the end
-- (the harness of 861). A failed run's recovery, which serves the company's writers, is held to the same: someone
-- outside the company, the publishable key and the viewer are refused while another transaction holds the run's job
-- (§5, ported from the native authority locks script in the legacy sweep).

reset role;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.r757_hook', public.qorpera_create_event_hook('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'own-row', 'Orders from the shop.') ->> 'id', false);
select set_config('qorpera_test.r757_computer', public.qorpera_upsert_logical_computer('92400000-0000-4000-8000-000000000010',
	'75700000-0000-4000-8000-000000000029', 'Own row computer', 'own-row', '1', '["agent_turn"]') ->> 'logical_computer_id', false);
select set_config('qorpera_test.r757_company_connection', public.qorpera_register_provider_connection(
	'92400000-0000-4000-8000-000000000010', '75700000-0000-4000-8000-000000000031', null, 'openai', 'api_key', 'codex',
	'secret://own-row-fixture', null, 'company', 'v1', null,
	'{"monthly_microusd":1000000,"reservation_microusd":1000,"max_calls_per_run":8,"max_input_tokens_per_run":1000,"max_output_tokens_per_run":1000,"max_concurrent_runs":1}')
	->> 'connection_id', false);
reset role;
-- The runtime begins a tool call of Alice's run, as the database owner (as 925 does): its receipt is in flight.
select pg_temp.base_claims('service_role');
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
	'75700000-0000-4000-8000-000000000050', 'own-row-receipt', repeat('1', 64), repeat('2', 64), false) \g /dev/null
select set_config('qorpera_test.r757_receipt', '75700000-0000-4000-8000-000000000050', false);
select set_config('qorpera_test.r757_sponsor', current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id', false);
select set_config('qorpera_test.r757_connection', current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id', false);
select set_config('qorpera_test.r757_run', current_setting('qorpera_test.base_binding')::jsonb ->> 'runId', false);
select set_config('qorpera_test.r757_job', current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId', false);
select pg_temp.base_assert((select status from public.qorpera_run_operation_receipts
		where id = current_setting('qorpera_test.r757_receipt')::uuid) = 'executing'
	and (select status from public.qorpera_event_hooks where id = current_setting('qorpera_test.r757_hook')::uuid) = 'active'
	and (select owner_user_id is null and status = 'active' from public.qorpera_provider_connections
		where id = current_setting('qorpera_test.r757_company_connection')::uuid),
	'The fixture has a receipt in flight, an active hook and an active company connection with no owner');

-- Commit the fixture, as 861 does: the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.r757_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r757_holder', 'dbname=' || current_database());
select dblink_connect('r757_caller', 'dbname=' || current_database());
select set_config('qorpera_test.r757_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('r757_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r757_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r757_holder_pid'),
			current_setting('qorpera_test.r757_caller_pid'))) then
		raise exception 'Own row lock test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r757_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r757_counts as select * from dblink('r757_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r757_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r757_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r757_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r757_rows select v_table, kept.row_value
			from dblink('r757_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- The holder acts for the owner when it changes the admin's role.
select dblink_exec('r757_holder', format('set request.jwt.claims = %L',
	jsonb_build_object('role', 'authenticated', 'sub', '92400000-0000-4000-8000-000000000001')::text));

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r757_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- The admin's role, changed by the holder for the owner.
create function pg_temp.r757_admin_role(p_role text) returns void language plpgsql as $$
begin
	perform * from dblink('r757_holder', format('select public.qorpera_update_profile_member_role(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000004', p_role)) as changed(member jsonb);
end
$$;
-- One call on the caller connection, as PostgREST makes it (the role and claims given), while the holder keeps the row
-- p_hold locks: the call's result or error, and whether it waited for the holder. With p_demote, the holder makes the
-- admin a contributor through the real role change while the call waits and commits, and makes them an admin again
-- after the call.
create function pg_temp.r757_call(p_hold text, p_claims jsonb, p_call text, p_demote boolean default false) returns jsonb
language plpgsql as $$
declare v_waited boolean := false; v_outcome jsonb; v_holder integer := current_setting('qorpera_test.r757_holder_pid')::integer;
	v_caller integer := current_setting('qorpera_test.r757_caller_pid')::integer;
begin
	perform dblink_exec('r757_holder', 'begin');
	perform * from dblink('r757_holder', p_hold) as held(one integer);
	perform dblink_exec('r757_caller', format('set request.jwt.claims = %L', p_claims::text));
	perform dblink_exec('r757_caller', format('set role %I', p_claims ->> 'role'));
	perform dblink_send_query('r757_caller', p_call);
	for attempt in 1..200 loop
		if v_holder = any (pg_blocking_pids(v_caller)) then v_waited := true; exit; end if;
		exit when dblink_is_busy('r757_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	-- A call still running that never waited proves nothing either way.
	if not v_waited and dblink_is_busy('r757_caller') = 1 then
		perform dblink_exec('r757_holder', 'rollback');
		raise exception 'The call neither waited nor finished: %', pg_temp.r757_collect('r757_caller');
	end if;
	if p_demote and v_waited then
		begin
			perform pg_temp.r757_admin_role('contributor');
		exception when others then
			perform dblink_exec('r757_holder', 'rollback');
			raise exception 'The demotion: % %; the call: %', sqlstate, sqlerrm, pg_temp.r757_collect('r757_caller');
		end;
		perform dblink_exec('r757_holder', 'commit');
	else
		perform dblink_exec('r757_holder', 'rollback');
	end if;
	v_outcome := pg_temp.r757_collect('r757_caller') || jsonb_build_object('waited', v_waited);
	perform dblink_exec('r757_caller', 'reset role');
	perform dblink_exec('r757_caller', 'reset request.jwt.claims');
	if p_demote and v_waited then perform pg_temp.r757_admin_role('admin'); end if;
	return v_outcome;
end
$$;
-- Refused at once, with the locked check's error.
create function pg_temp.r757_refused(p_hold text, p_claims jsonb, p_call text, p_message text, p_label text) returns void
language plpgsql as $$
declare v_outcome jsonb := pg_temp.r757_call(p_hold, p_claims, p_call);
begin
	perform pg_temp.base_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = '42501' and v_outcome ->> 'error' = p_message,
		p_label || ' waited for the row or was not refused as before: ' || v_outcome::text);
end
$$;
-- The admin passes the plain check and waits for the row; made a contributor meanwhile, they are refused after it.
create function pg_temp.r757_demoted(p_hold text, p_call text, p_message text, p_label text) returns void language plpgsql as $$
declare v_outcome jsonb := pg_temp.r757_call(p_hold, '{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000004"}', p_call, true);
begin
	perform pg_temp.base_assert(v_outcome ->> 'waited' = 'true' and v_outcome ->> 'state' = '42501' and v_outcome ->> 'error' = p_message,
		p_label || ': an admin made a contributor while waiting for the row was not refused after it: ' || v_outcome::text);
end
$$;
-- The holds and the calls.
create function pg_temp.r757_hold(p_table text, p_id text) returns text language sql as $$
	select format('select 1 from public.%I where id = %L for update', p_table, p_id)
$$;
create function pg_temp.r757_resolve() returns text language sql as $$
	select format('select public.qorpera_resolve_run_operation_receipt(%L, ''confirmed_not_run'', null, null, null)',
		current_setting('qorpera_test.r757_receipt'))
$$;
create function pg_temp.r757_hook_status(p_status text) returns text language sql as $$
	select format('select public.qorpera_set_event_hook_status(%L, %L)', current_setting('qorpera_test.r757_hook'), p_status)
$$;
create function pg_temp.r757_status(p_function text, p_id text, p_status text) returns text language sql as $$
	select format('select public.%I(%L, %L, %L)', p_function, '92400000-0000-4000-8000-000000000010', p_id, p_status)
$$;

-- At the end: remove what the test committed, as 861 does.
create function pg_temp.r757_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r757_first_xid')::xid;
begin
	perform pg_temp.r757_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r757_holder','r757_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r757_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r757_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r757_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r757_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Own row lock cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 1. Resolving a run operation receipt (757's old §5): owners and admins, in the folder-v2 resolution the dispatcher
--    sends it to. Someone outside the company, a caller with the publishable key only and the contributor are refused
--    while another transaction holds the receipt.
do $$
declare v_claims jsonb;
begin
	foreach v_claims in array array['{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000005"}',
		'{"role":"anon"}', '{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000002"}']::jsonb[] loop
		perform pg_temp.r757_refused(pg_temp.r757_hold('qorpera_run_operation_receipts', current_setting('qorpera_test.r757_receipt')),
			v_claims, pg_temp.r757_resolve(), 'operation recovery requires authorize access', '1: resolving the receipt as ' || v_claims::text);
	end loop;
end $$;

-- 2. An event hook's status (757's old §7): owners and admins. On folder-v2 the function takes the company row KEY SHARE
--    before the hook; someone outside the company and the contributor pausing it are refused while another transaction
--    holds the company row.
do $$
declare v_claims jsonb;
begin
	foreach v_claims in array array['{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000005"}',
		'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000002"}']::jsonb[] loop
		perform pg_temp.r757_refused(pg_temp.r757_hold('qorpera_profiles', '92400000-0000-4000-8000-000000000010'),
			v_claims, pg_temp.r757_hook_status('paused'), 'Only owners and admins can change hooks', '2: pausing the hook as ' || v_claims::text);
	end loop;
end $$;

-- 3. An execution sponsor's, a logical computer's and a provider connection's status (757's old §8): the named
--    company's owners and admins, and a connection's owner revoking it. Someone outside the company, a caller with the
--    publishable key only (not for the connection: 20260930005000 took that key's EXECUTE, which 001 checks) and the
--    contributor are refused disabling the owner's sponsor, the computer and the owner's connection while another
--    transaction holds the row. The company's connection has no owner: someone outside the company, the viewer and
--    the contributor are refused revoking it.
do $$
declare v_case record; v_claims jsonb;
begin
	for v_case in select * from (values
		('qorpera_set_execution_sponsor_status', 'qorpera_execution_sponsor_bindings', current_setting('qorpera_test.r757_sponsor'), 'disabled',
			'execution sponsor lifecycle requires authorize access', true),
		('qorpera_set_logical_computer_status', 'qorpera_logical_computers', current_setting('qorpera_test.r757_computer'), 'disabled',
			'logical computer lifecycle requires authorize access', true),
		('qorpera_set_provider_connection_status', 'qorpera_provider_connections', current_setting('qorpera_test.r757_connection'), 'disabled',
			'provider connection lifecycle requires authorize access', false)
	) as status_case(function_name, table_name, row_id, status, message, anon) loop
		foreach v_claims in array array['{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000005"}',
			'{"role":"anon"}', '{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000002"}']::jsonb[] loop
			continue when v_claims ->> 'role' = 'anon' and not v_case.anon;
			perform pg_temp.r757_refused(pg_temp.r757_hold(v_case.table_name, v_case.row_id), v_claims,
				pg_temp.r757_status(v_case.function_name, v_case.row_id, v_case.status), v_case.message,
				'3: ' || v_case.function_name || ' as ' || v_claims::text);
		end loop;
	end loop;
	foreach v_claims in array array['{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000005"}',
		'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000003"}',
		'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000002"}']::jsonb[] loop
		perform pg_temp.r757_refused(pg_temp.r757_hold('qorpera_provider_connections', current_setting('qorpera_test.r757_company_connection')),
			v_claims, pg_temp.r757_status('qorpera_set_provider_connection_status', current_setting('qorpera_test.r757_company_connection'),
				'revoked'), 'provider connection lifecycle requires authorize access',
			'3: revoking the company''s connection as ' || v_claims::text);
	end loop;
end $$;

-- 4. The locked checks stay (757's old §12, with a role change for the removal): an admin passes each plain check and
--    waits for the row; the owner makes them a contributor while the call waits, and the call is refused after it. For
--    the company's connection the locked check is 20260928339790's (before it, the admin's revocation landed). The
--    owner makes them an admin again after each call.
select pg_temp.r757_demoted(pg_temp.r757_hold('qorpera_run_operation_receipts', current_setting('qorpera_test.r757_receipt')),
	pg_temp.r757_resolve(), 'operation recovery requires authorize access', '4: resolving the receipt');
select pg_temp.r757_demoted(pg_temp.r757_hold('qorpera_profiles', '92400000-0000-4000-8000-000000000010'),
	pg_temp.r757_hook_status('paused'), 'Only owners and admins can change hooks', '4: pausing the hook');
select pg_temp.r757_demoted(pg_temp.r757_hold('qorpera_execution_sponsor_bindings', current_setting('qorpera_test.r757_sponsor')),
	pg_temp.r757_status('qorpera_set_execution_sponsor_status', current_setting('qorpera_test.r757_sponsor'), 'disabled'),
	'execution sponsor lifecycle requires authorize access', '4: the sponsor''s status');
select pg_temp.r757_demoted(pg_temp.r757_hold('qorpera_logical_computers', current_setting('qorpera_test.r757_computer')),
	pg_temp.r757_status('qorpera_set_logical_computer_status', current_setting('qorpera_test.r757_computer'), 'disabled'),
	'logical computer lifecycle requires authorize access', '4: the computer''s status');
select pg_temp.r757_demoted(pg_temp.r757_hold('qorpera_provider_connections', current_setting('qorpera_test.r757_connection')),
	pg_temp.r757_status('qorpera_set_provider_connection_status', current_setting('qorpera_test.r757_connection'), 'disabled'),
	'provider connection lifecycle requires authorize access', '4: the owner''s connection''s status');
select pg_temp.r757_demoted(pg_temp.r757_hold('qorpera_provider_connections', current_setting('qorpera_test.r757_company_connection')),
	pg_temp.r757_status('qorpera_set_provider_connection_status', current_setting('qorpera_test.r757_company_connection'), 'revoked'),
	'provider connection lifecycle requires authorize access', '4: revoking the company''s connection');

-- Read in a statement of its own, after the calls: the refused calls changed nothing, and the admin is an admin again.
select pg_temp.base_assert((select status from public.qorpera_run_operation_receipts
		where id = current_setting('qorpera_test.r757_receipt')::uuid) = 'executing'
	and (select status from public.qorpera_event_hooks where id = current_setting('qorpera_test.r757_hook')::uuid) = 'active'
	and (select status from public.qorpera_execution_sponsor_bindings where id = current_setting('qorpera_test.r757_sponsor')::uuid) = 'active'
	and (select status from public.qorpera_logical_computers where id = current_setting('qorpera_test.r757_computer')::uuid) = 'active'
	and (select count(*) from public.qorpera_provider_connections where status = 'active'
		and id in (current_setting('qorpera_test.r757_connection')::uuid, current_setting('qorpera_test.r757_company_connection')::uuid)) = 2
	and (select role::text from public.qorpera_profile_members where profile_id = '92400000-0000-4000-8000-000000000010'
		and user_id = '92400000-0000-4000-8000-000000000004') = 'admin',
	'1-4: a refused call changed its row, or the admin is not an admin again');

-- 5. A failed run's recovery: the company's writers. Someone outside the company, the publishable key (which may call
--    it) and the viewer discarding Alice's run are refused while another transaction holds the run's job, which the
--    function locks first.
do $$
declare v_claims jsonb;
begin
	foreach v_claims in array array['{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000005"}', '{"role":"anon"}',
		'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000003"}']::jsonb[] loop
		perform pg_temp.r757_refused(pg_temp.r757_hold('qorpera_runner_jobs', current_setting('qorpera_test.r757_job')), v_claims,
			format('select public.qorpera_resolve_failed_execution_run(%L, ''discard'')', current_setting('qorpera_test.r757_run')),
			'execution recovery requires company write access', '5: discarding the run as ' || v_claims::text);
	end loop;
end $$;

select pg_temp.r757_cleanup();
