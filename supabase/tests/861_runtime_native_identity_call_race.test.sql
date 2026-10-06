-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- G2-3a (20260930005000) on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): the native identity entry
-- point checks the holder's credential per call and with no lock, so a refused call never waits for a transaction that
-- holds the identity, its runner, the holder's allocation or credential; a re-bind or a release takes effect on the next
-- call, not after the calls in flight. A first bind and a release of the same allocation wait only for each other's
-- single statement (the bind's foreign key KEY SHARE against the release's FOR UPDATE), and whichever commits first, a
-- released allocation's credential is refused. A sign-in's completion compares the capability before it locks the
-- sign-in. Test 924's fixture gives the owner's identity, the runner of Alice's run (a thread post the folder
-- materializer turned into a run) and a completed sign-in; this adds a run allocation with a bound job guest credential,
-- a pending sign-in with an unbound allocation, and an account refresh request.
reset role;
create function pg_temp.r861_sha(p_value text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_value, 'utf8'), 'sha256'), 'hex')
$$;
select set_config('qorpera_test.identity', current_setting('qorpera_test.base_binding')::jsonb ->> 'computeIdentityId', false);
select set_config('qorpera_test.profile', '92400000-0000-4000-8000-000000000010', false);
select set_config('qorpera_test.job_credential', 'J' || repeat('j', 42), false);
select set_config('qorpera_test.rotated_credential', 'N' || repeat('n', 42), false);
select set_config('qorpera_test.login_credential', 'L' || repeat('l', 42), false);
select set_config('qorpera_test.refresh_credential', 'R' || repeat('r', 42), false);
select set_config('qorpera_test.epoch', recovery_epoch::text, false)
from public.qorpera_member_compute_identities where id = current_setting('qorpera_test.identity')::uuid;

select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.login_id', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '86100000-0000-4000-8000-000000000051', '86100000-0000-4000-8000-000000000052',
	current_setting('qorpera_test.identity')::uuid, 'openai', 'codex-cli', pg_temp.r861_sha('login-capability'), 900) ->> 'login_id', false);
reset role;
insert into public.qorpera_native_account_refresh_requests(id, profile_id, client_request_id, compute_identity_id,
	requested_by_user_id, capability_sha256, compute_recovery_epoch)
values ('86100000-0000-4000-8000-000000000061', current_setting('qorpera_test.profile')::uuid,
	'86100000-0000-4000-8000-000000000062', current_setting('qorpera_test.identity')::uuid,
	'92400000-0000-4000-8000-000000000001', pg_temp.r861_sha('refresh-capability'), current_setting('qorpera_test.epoch')::bigint);
insert into public.qorpera_runtime_machine_allocations(id, profile_id, run_id, runner_id, provider_adapter, instance_sha256)
values ('86100000-0000-4000-8000-000000000071', current_setting('qorpera_test.profile')::uuid,
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runnerId')::uuid, 'lxd', repeat('7', 64));
insert into public.qorpera_runtime_machine_allocations(id, profile_id, login_session_id, login_compute_identity_id,
	provider_adapter, instance_sha256)
values ('86100000-0000-4000-8000-000000000072', current_setting('qorpera_test.profile')::uuid,
	current_setting('qorpera_test.login_id')::uuid, current_setting('qorpera_test.identity')::uuid, 'lxd-login', repeat('8', 64));
select set_config('qorpera_test.job_hash', pg_temp.r861_sha(current_setting('qorpera_test.job_credential')), false);
select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_bind_native_identity_credential('86100000-0000-4000-8000-000000000071', 'lxd', repeat('7', 64),
	'job_guest', current_setting('qorpera_test.job_hash'));
reset role;

-- Row locks show only across connections, so 924's fixture and this one are committed here and removed again at the end
-- (the harness of 602, 746 and 793): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config('qorpera_test.base_binding', current_setting('qorpera_test.base_binding'), false);
select set_config('qorpera_test.r861_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('r861_holder', 'dbname=' || current_database());
select dblink_connect('r861_caller', 'dbname=' || current_database());
select set_config('qorpera_test.r861_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('r861_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.r861_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.r861_holder_pid'),
			current_setting('qorpera_test.r861_caller_pid'))) then
		raise exception 'Native identity call race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.r861_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table r861_counts as select * from dblink('r861_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table r861_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.r861_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.r861_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.r861_rows select v_table, kept.row_value
			from dblink('r861_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.r861_collect(p_connection text) returns jsonb language plpgsql as $$
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
create function pg_temp.r861_command_outcome(p_connection text) returns text language plpgsql as $$
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
create function pg_temp.r861_waited_for(p_connection text, p_by integer) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.r861_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if p_by = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('r861_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
create function pg_temp.r861_pid(p_connection text) returns integer language sql as $$
	select current_setting('qorpera_test.r861_' || p_connection || '_pid')::integer
$$;

-- At the end: remove what the test committed, as 602, 746 and 793 do.
create function pg_temp.r861_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.r861_first_xid')::xid;
begin
	perform pg_temp.r861_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['r861_holder','r861_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.r861_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.r861_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.r861_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.r861_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Native identity call race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- A connection's transaction as PostgREST runs it: the publishable key on the entry point's RPC path, or the node
-- host (the service caller).
create function pg_temp.r861_begin(p_connection text, p_role text) returns void language plpgsql as $$
begin
	perform dblink_exec('r861_' || p_connection, 'begin');
	perform * from dblink('r861_' || p_connection, format($q$select set_config('request.jwt.claims', %L, true),
		set_config('request.path', %L, true)$q$, jsonb_build_object('role', p_role)::text,
		case p_role when 'anon' then '/rpc/qorpera_native_identity_call' else '/rpc/qorpera_bind_native_identity_credential' end))
		as c(claims text, path text);
	perform dblink_exec('r861_' || p_connection, format('set local role %I', p_role));
end $$;
-- A call through the entry point as SQL: the identity's account list (no lock of its own: the function is stable).
create function pg_temp.r861_call_sql(p_credential text, p_name text default 'qorpera_list_native_provider_account_refreshes',
	p_args jsonb default null) returns text language sql as $$
	select format($q$select public.qorpera_native_identity_call(%L, %L, %L, %L)$q$,
		current_setting('qorpera_test.identity'), p_credential, p_name,
		coalesce(p_args, jsonb_build_object('p_compute_identity_id', current_setting('qorpera_test.identity'),
			'p_recovery_epoch', current_setting('qorpera_test.epoch')::bigint))::text)
$$;
-- A call from the caller connection in its own transaction; it must not wait for the holder.
create function pg_temp.r861_at_once(p_credential text, p_name text default 'qorpera_list_native_provider_account_refreshes',
	p_args jsonb default null) returns jsonb language plpgsql as $$
declare v_outcome jsonb;
begin
	perform pg_temp.r861_begin('caller', 'anon');
	perform dblink_send_query('r861_caller', pg_temp.r861_call_sql(p_credential, p_name, p_args));
	if pg_temp.r861_waited_for('caller', pg_temp.r861_pid('holder')) then
		perform dblink_exec('r861_holder', 'rollback');
		v_outcome := pg_temp.r861_collect('r861_caller');
		perform dblink_exec('r861_caller', 'rollback');
		raise exception 'A native identity call (%) waited for the holder: %', p_name, v_outcome; end if;
	v_outcome := pg_temp.r861_collect('r861_caller');
	perform dblink_exec('r861_caller', 'rollback');
	return v_outcome;
end $$;
create function pg_temp.r861_refused(p_outcome jsonb) returns boolean language sql as $$
	select coalesce(p_outcome ->> 'state' = '42501' and p_outcome ->> 'error' = 'native identity call is refused', false)
$$;
-- A sign-in's completion with every input valid but the capability (as test 924's fixture completes its sign-in).
create function pg_temp.r861_complete_sql(p_capability text) returns text language sql as $$
	select format($q$select public.qorpera_complete_native_provider_login(%L, %L, %L, %L, %L, %L, %L, %L, %L, null)$q$,
		current_setting('qorpera_test.login_id'), p_capability, '86100000-0000-4000-8000-000000000081',
		'object://native-capsules/86100000-0000-4000-8000-000000000081', repeat('b', 64), 'fixture-openai-account',
		'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')
$$;

-- 1. Another transaction holds the identity, its runner, the job guest's allocation and its credential (as a recovery,
--    a runner change, a reservation and a re-bind would). A wrong credential and another kind's call are refused at
--    once; a listed call's checks take no lock, so it runs at once too.
do $$
declare v_outcome jsonb;
begin
	perform dblink_exec('r861_holder', 'begin');
	perform * from dblink('r861_holder', format('select 1 from public.qorpera_member_compute_identities where id = %L for update',
		current_setting('qorpera_test.identity'))) as held(one integer);
	perform * from dblink('r861_holder', format('select 1 from public.qorpera_runners where id = %L for update',
		current_setting('qorpera_test.base_binding')::jsonb ->> 'runnerId')) as held(one integer);
	perform * from dblink('r861_holder', format('select 1 from public.qorpera_runtime_machine_allocations where id = %L for update',
		'86100000-0000-4000-8000-000000000071')) as held(one integer);
	perform * from dblink('r861_holder', format('select 1 from public.qorpera_native_identity_credentials where allocation_id = %L for update',
		'86100000-0000-4000-8000-000000000071')) as held(one integer);
	v_outcome := pg_temp.r861_at_once('W' || repeat('w', 42));
	if not pg_temp.r861_refused(v_outcome) then
		perform dblink_exec('r861_holder', 'rollback');
		raise exception 'A wrong credential was not refused: %', v_outcome; end if;
	v_outcome := pg_temp.r861_at_once(current_setting('qorpera_test.job_credential'), 'qorpera_describe_native_provider_login',
		jsonb_build_object('p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', pg_temp.r861_sha('login-capability')));
	if not pg_temp.r861_refused(v_outcome) then
		perform dblink_exec('r861_holder', 'rollback');
		raise exception 'A job guest''s sign-in call was not refused: %', v_outcome; end if;
	v_outcome := pg_temp.r861_at_once(current_setting('qorpera_test.job_credential'));
	perform dblink_exec('r861_holder', 'rollback');
	if v_outcome ? 'error' then raise exception 'A job guest''s listed call was refused: %', v_outcome; end if;
end $$;

-- 2. Another transaction holds the sign-in. Its completion with a wrong or no capability is refused at once (55000);
--    with the right one it waits for the holder, as before.
do $$
declare v_outcome jsonb; v_capability text;
begin
	perform dblink_exec('r861_holder', 'begin');
	perform * from dblink('r861_holder', format('select 1 from public.qorpera_native_provider_login_sessions where id = %L for update',
		current_setting('qorpera_test.login_id'))) as held(one integer);
	foreach v_capability in array array[repeat('0', 64), null] loop
		perform pg_temp.r861_begin('caller', 'service_role');
		perform dblink_send_query('r861_caller', pg_temp.r861_complete_sql(v_capability));
		if pg_temp.r861_waited_for('caller', pg_temp.r861_pid('holder')) then
			perform dblink_exec('r861_holder', 'rollback');
			v_outcome := pg_temp.r861_collect('r861_caller');
			perform dblink_exec('r861_caller', 'rollback');
			raise exception 'A sign-in completion with capability % waited for the sign-in: %', coalesce(v_capability, 'null'), v_outcome; end if;
		v_outcome := pg_temp.r861_collect('r861_caller');
		perform dblink_exec('r861_caller', 'rollback');
		if v_outcome ->> 'state' is distinct from '55000' then
			perform dblink_exec('r861_holder', 'rollback');
			raise exception 'A sign-in completion with capability % answered %', coalesce(v_capability, 'null'), v_outcome; end if;
	end loop;
	perform pg_temp.r861_begin('caller', 'service_role');
	perform dblink_send_query('r861_caller', pg_temp.r861_complete_sql(pg_temp.r861_sha('login-capability')));
	if not pg_temp.r861_waited_for('caller', pg_temp.r861_pid('holder')) then
		perform dblink_exec('r861_holder', 'rollback');
		v_outcome := pg_temp.r861_collect('r861_caller');
		perform dblink_exec('r861_caller', 'rollback');
		raise exception 'The sign-in completion with its capability did not wait for the held sign-in: %', v_outcome; end if;
	perform dblink_exec('r861_holder', 'rollback');
	v_outcome := pg_temp.r861_collect('r861_caller');
	perform dblink_exec('r861_caller', 'rollback');
	if v_outcome ? 'error' then raise exception 'The sign-in completion with its capability failed: %', v_outcome; end if;
end $$;

-- 3. A re-bind in flight: until it commits the old credential works, at once; from its commit on the old one is
--    refused and the new one works.
do $$
declare v_outcome jsonb;
begin
	perform pg_temp.r861_begin('holder', 'service_role');
	perform * from dblink('r861_holder', format($q$select public.qorpera_bind_native_identity_credential(%L, 'lxd', %L, 'job_guest', %L)$q$,
		'86100000-0000-4000-8000-000000000071', repeat('7', 64), pg_temp.r861_sha(current_setting('qorpera_test.rotated_credential'))))
		as bound(result jsonb);
	v_outcome := pg_temp.r861_at_once(current_setting('qorpera_test.job_credential'));
	if v_outcome ? 'error' then
		perform dblink_exec('r861_holder', 'rollback');
		raise exception 'The credential was refused before its replacement committed: %', v_outcome; end if;
	perform dblink_exec('r861_holder', 'commit');
	v_outcome := pg_temp.r861_at_once(current_setting('qorpera_test.job_credential'));
	if not pg_temp.r861_refused(v_outcome) then raise exception 'A replaced credential was not refused: %', v_outcome; end if;
	v_outcome := pg_temp.r861_at_once(current_setting('qorpera_test.rotated_credential'));
	if v_outcome ? 'error' then raise exception 'The new credential was refused: %', v_outcome; end if;
end $$;

-- 4. A release (the node host's qorpera_release_runtime_machine) while the holder's call is in flight: the release
--    does not wait for the call's transaction, and the holder's next call, in that same transaction, is refused.
do $$
declare v_outcome jsonb; v_status jsonb;
begin
	perform pg_temp.r861_begin('caller', 'anon');
	perform * from dblink('r861_caller', pg_temp.r861_call_sql(current_setting('qorpera_test.rotated_credential')))
		as call(result jsonb);
	perform pg_temp.r861_begin('holder', 'service_role');
	perform dblink_send_query('r861_holder', format($q$select public.qorpera_release_runtime_machine(%L, 'lxd', %L)$q$,
		'86100000-0000-4000-8000-000000000071', repeat('7', 64)));
	if pg_temp.r861_waited_for('holder', pg_temp.r861_pid('caller')) then
		perform dblink_exec('r861_caller', 'rollback');
		v_status := pg_temp.r861_collect('r861_holder');
		perform dblink_exec('r861_holder', 'rollback');
		raise exception 'A release waited for a native identity call: %', v_status; end if;
	v_status := pg_temp.r861_collect('r861_holder');
	perform dblink_exec('r861_holder', 'commit');
	if v_status ? 'error' then
		perform dblink_exec('r861_caller', 'rollback');
		raise exception 'The release failed: %', v_status; end if;
	perform dblink_send_query('r861_caller', pg_temp.r861_call_sql(current_setting('qorpera_test.rotated_credential')));
	v_outcome := pg_temp.r861_collect('r861_caller');
	perform dblink_exec('r861_caller', 'rollback');
	if not pg_temp.r861_refused(v_outcome) then
		raise exception 'A released allocation''s credential was not refused in a call in flight: %', v_outcome; end if;
end $$;

-- 5. A first bind and a release of the same allocation (the login gateway's releases) wait only for each other, and
--    whichever commits first, the bound credential is refused once the allocation is released. a) The bind first: a
--    sign-in's first bind is open while the gateway releases its allocation. b) The release first: an account
--    refresh's release is open while its login guest's credential is bound.
do $$
declare v_outcome jsonb;
begin
	perform pg_temp.r861_begin('holder', 'service_role');
	perform * from dblink('r861_holder', format($q$select public.qorpera_bind_native_identity_credential(%L, 'lxd-login', %L, 'login_guest', %L)$q$,
		'86100000-0000-4000-8000-000000000072', repeat('8', 64), pg_temp.r861_sha(current_setting('qorpera_test.login_credential'))))
		as bound(result jsonb);
	perform pg_temp.r861_begin('caller', 'service_role');
	perform dblink_send_query('r861_caller', format(
		$q$select public.qorpera_release_runtime_login_machine(%L, 'lxd-login', %L, %L)$q$,
		'86100000-0000-4000-8000-000000000072', repeat('8', 64), current_setting('qorpera_test.login_id')));
	if not pg_temp.r861_waited_for('caller', pg_temp.r861_pid('holder')) then
		perform dblink_exec('r861_holder', 'rollback');
		v_outcome := pg_temp.r861_collect('r861_caller');
		perform dblink_exec('r861_caller', 'rollback');
		raise exception 'The release did not wait for the open first bind (the test holds nothing): %', v_outcome; end if;
	perform dblink_exec('r861_holder', 'commit');
	v_outcome := pg_temp.r861_collect('r861_caller');
	perform dblink_exec('r861_caller', 'commit');
	if v_outcome ? 'error' then raise exception 'The release after a bind failed: %', v_outcome; end if;
	v_outcome := pg_temp.r861_at_once(current_setting('qorpera_test.login_credential'), 'qorpera_describe_native_provider_login',
		jsonb_build_object('p_login_id', current_setting('qorpera_test.login_id'), 'p_capability_sha256', pg_temp.r861_sha('login-capability')));
	if not pg_temp.r861_refused(v_outcome) then
		raise exception 'A credential bound before its allocation''s release was not refused: %', v_outcome; end if;
end $$;
insert into public.qorpera_runtime_machine_allocations(id, profile_id, account_refresh_request_id, login_compute_identity_id,
	provider_adapter, instance_sha256)
values ('86100000-0000-4000-8000-000000000073', current_setting('qorpera_test.profile')::uuid,
	'86100000-0000-4000-8000-000000000061', current_setting('qorpera_test.identity')::uuid, 'lxd-login', repeat('9', 64));
do $$
declare v_outcome jsonb;
begin
	perform pg_temp.r861_begin('holder', 'service_role');
	perform * from dblink('r861_holder', format(
		$q$select public.qorpera_release_runtime_account_refresh_machine(%L, 'lxd-login', %L, %L)$q$,
		'86100000-0000-4000-8000-000000000073', repeat('9', 64), '86100000-0000-4000-8000-000000000061')) as released(result jsonb);
	perform pg_temp.r861_begin('caller', 'service_role');
	perform dblink_send_query('r861_caller', format(
		$q$select public.qorpera_bind_native_identity_credential(%L, 'lxd-login', %L, 'login_guest', %L)$q$,
		'86100000-0000-4000-8000-000000000073', repeat('9', 64), pg_temp.r861_sha(current_setting('qorpera_test.refresh_credential'))));
	if not pg_temp.r861_waited_for('caller', pg_temp.r861_pid('holder')) then
		perform dblink_exec('r861_holder', 'rollback');
		v_outcome := pg_temp.r861_collect('r861_caller');
		perform dblink_exec('r861_caller', 'rollback');
		raise exception 'The bind did not wait for the open release (the test holds nothing): %', v_outcome; end if;
	perform dblink_exec('r861_holder', 'commit');
	v_outcome := pg_temp.r861_collect('r861_caller');
	perform dblink_exec('r861_caller', 'commit');
	if v_outcome ? 'error' then raise exception 'A bind behind a release failed: %', v_outcome; end if;
	v_outcome := pg_temp.r861_at_once(current_setting('qorpera_test.refresh_credential'),
		'qorpera_describe_native_account_refresh_route', jsonb_build_object('p_request_id', '86100000-0000-4000-8000-000000000061',
			'p_capability_sha256', pg_temp.r861_sha('refresh-capability')));
	if not pg_temp.r861_refused(v_outcome) then
		raise exception 'A credential bound while its allocation was released was not refused: %', v_outcome; end if;
end $$;

select pg_temp.r861_cleanup();
