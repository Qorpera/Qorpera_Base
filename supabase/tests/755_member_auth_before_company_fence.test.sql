-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "create function pg_temp.browser("
-- 20260929660000: someone outside a company is refused before that company's gc fence. Thirteen member functions
-- looked the company up from their argument and took its fence (the profile row FOR UPDATE) before they checked
-- the caller's membership, so anyone signed in who knew an environment, computer, identity, recovery or room id
-- could hold another company's fence for the length of a call. Here a second connection holds the company's
-- profile row FOR KEY SHARE, which the fence waits for. Someone outside the company calls each function and is
-- refused at once, with the error such a caller got before; a member calls it too and still waits for the fence.
-- On the previous function text every outsider's call for an id that exists waited. A member's scope checks still
-- run under the fence. The office catalog then answers its member, and a member removed while their call waits for
-- the fence is still refused: the locked check after the fence stays. Row locks show only across connections, so
-- the fixture is committed here and removed at the end, as in 602; the test refuses to run beside other
-- connections to this database.

-- Someone outside the company, and the rows the recovery and room functions look up (fixture rows: triggers and
-- key checks off). The viewer owns the compute identity; the owner is a member of the room.
reset role;
insert into auth.users(id,email) values ('75500000-0000-4000-8000-000000000001','fence-outsider@example.test');
set local session_replication_role = replica;
insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,owner_user_id,client_identity_id,display_name)
values ('75500000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000010','member',
	'30000000-0000-4000-8000-000000000003','75500000-0000-4000-8000-000000000011','Viewer identity');
insert into public.qorpera_identity_recoveries(id,client_request_id,profile_id,compute_identity_id,authority_id,
	backup_revision,storage_source,target_id,owner_user_id,status,expires_at)
values ('75500000-0000-4000-8000-000000000020','75500000-0000-4000-8000-000000000021','30000000-0000-4000-8000-000000000010',
	'75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000022',1,'nas','75500000-0000-4000-8000-000000000023',
	'30000000-0000-4000-8000-000000000001','awaiting_member',clock_timestamp()+interval '30 minutes');
insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,purpose,status,version,source_path,
	source_path_version,source_snapshot_id,source_file_sha256,created_by_user_id)
values ('75500000-0000-4000-8000-000000000030','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
	'fence-room','Fence room','Where the fence test posts.','active',1,'rooms/fence-room.md',
	'75500000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000023',repeat('e',64),
	'30000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_room_members(room_id,principal_kind,principal_id,status,source_path_version)
values ('75500000-0000-4000-8000-000000000030','member','30000000-0000-4000-8000-000000000001','active',
	'75500000-0000-4000-8000-000000000031');
set local session_replication_role = origin;

-- What the calls need outlives this transaction.
select set_config(name, current_setting(name), false) from unnest(array['qorpera_test.office_scope']) name;
select set_config('qorpera_test.fence_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('fence_holder', 'dbname=' || current_database());
select dblink_connect('fence_caller', 'dbname=' || current_database());
select set_config('qorpera_test.fence_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller']) name, lateral dblink('fence_' || name, 'select pg_backend_pid()') as backend(pid integer);
-- Only this connection and its two may use the database while the test runs.
create function pg_temp.fence_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.fence_holder_pid'),
			current_setting('qorpera_test.fence_caller_pid'))) then
		raise exception 'Company fence test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.fence_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table fence_counts as select * from dblink('fence_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table fence_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.fence_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.fence_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.fence_rows select v_table, kept.row_value
			from dblink('fence_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- The caller runs as the role PostgREST would use, with that role's claims.
create function pg_temp.fence_as(p_claims jsonb) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_caller', 'reset role');
	perform dblink_exec('fence_caller', format('set request.jwt.claims = %L', p_claims));
	perform dblink_exec('fence_caller', format('set role %I', p_claims ->> 'role'));
end
$$;
create function pg_temp.fence_claims(p_user uuid) returns jsonb language sql as $$
	select jsonb_build_object('role', 'authenticated', 'sub', p_user)
$$;
-- The sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.fence_collect() returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result('fence_caller') as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result('fence_caller', false) as call(result jsonb);
	return v_outcome;
end
$$;
-- The holder keeps the company's profile row FOR KEY SHARE, which the fence's FOR UPDATE waits for, while one call
-- runs: the call's result or error, and whether it waited for the holder.
create function pg_temp.fence_call(p_user uuid, p_call text) returns jsonb language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.fence_caller_pid')::integer; v_waited boolean := false;
begin
	perform dblink_exec('fence_holder', 'begin');
	perform * from dblink('fence_holder', $q$select 1 from public.qorpera_profiles
		where id = '30000000-0000-4000-8000-000000000010' for key share$q$) as held(held integer);
	perform pg_temp.fence_as(pg_temp.fence_claims(p_user));
	perform dblink_send_query('fence_caller', p_call);
	for attempt in 1..200 loop
		if cardinality(pg_blocking_pids(v_pid)) > 0 then v_waited := true; exit; end if;
		exit when dblink_is_busy('fence_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	perform dblink_exec('fence_holder', 'rollback');
	return pg_temp.fence_collect() || jsonb_build_object('waited', v_waited);
end
$$;
-- Someone outside the company (or a member the function refuses before the fence) gets `p_message` at once.
create function pg_temp.fence_refused(p_user uuid, p_call text, p_message text, p_label text) returns void language plpgsql as $$
declare v_outcome jsonb := pg_temp.fence_call(p_user, p_call);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = '42501'
		and v_outcome ->> 'error' = p_message, p_label || ' is refused without waiting for the fence: ' || v_outcome::text);
end
$$;
-- A member still takes the fence: the call waits for the holder.
create function pg_temp.fence_waits(p_user uuid, p_call text, p_label text) returns jsonb language plpgsql as $$
declare v_outcome jsonb := pg_temp.fence_call(p_user, p_call);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true', p_label || ' still waits for the fence: ' || v_outcome::text);
	return v_outcome;
end
$$;
create function pg_temp.fence_office() returns public.qorpera_runtime_offices language sql as $$
	select * from public.qorpera_runtime_offices
	where id = (current_setting('qorpera_test.office_scope')::jsonb ->> 'companyComputerId')::uuid
$$;
create function pg_temp.fence_start(p_function text, p_scope jsonb default current_setting('qorpera_test.office_scope')::jsonb)
returns text language sql as $$
	select format('select public.%I(%L::jsonb, %s, ''75500000-0000-4000-8000-000000000040'')', p_function, p_scope,
		(pg_temp.fence_office()).generation)
$$;
create function pg_temp.fence_state(p_state text) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runtime_offices set state = p_state where id = (pg_temp.fence_office()).id;
end
$$;

-- At the end: remove what the test committed. Every row written since the fixture's first write goes,
-- with triggers and foreign-key checks off, and the rows it changed come back as they were. Every table
-- must hold again exactly what other connections saw before.
create function pg_temp.fence_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.fence_first_xid')::xid;
begin
	perform pg_temp.fence_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['fence_holder','fence_caller']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.fence_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.fence_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.fence_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.fence_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Company fence test cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 1. The office catalog. Someone outside the company is refused as for an environment nobody has; the viewer waits
--    for the fence and then gets the catalog.
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_member_office_catalog('30000000-0000-4000-8000-000000000020')$q$,
	'Company unavailable', 'The catalog of another company');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_member_office_catalog('75500000-0000-4000-8000-000000000099')$q$,
	'Company unavailable', 'The catalog of an environment nobody has');
do $$
declare v_outcome jsonb := pg_temp.fence_waits('30000000-0000-4000-8000-000000000003',
	$q$select public.qorpera_member_office_catalog('30000000-0000-4000-8000-000000000020')$q$, 'The viewer''s catalog');
begin
	perform pg_temp.wake_assert(v_outcome #>> '{result,companyId}' = '30000000-0000-4000-8000-000000000010'
		and v_outcome #> '{result,scope}' = current_setting('qorpera_test.office_scope')::jsonb
		and v_outcome #> '{result,canManage}' = 'false'::jsonb and jsonb_array_length(v_outcome #> '{result,staff}') > 0,
		'The viewer gets the catalog once the fence is free: ' || v_outcome::text);
end $$;

-- 2. Registering the first computer and an agent's access to it (owners and admins).
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	format('select public.qorpera_register_runtime_office(%L,%L,%L,%L,2)', '30000000-0000-4000-8000-000000000020',
		'34000000-0000-4000-8000-000000000001', repeat('a',64), repeat('b',64)),
	'Shared office registration is unavailable', 'Registering another company''s computer');
select pg_temp.wake_assert(pg_temp.fence_waits('30000000-0000-4000-8000-000000000001',
	format('select public.qorpera_register_runtime_office(%L,%L,%L,%L,2)', '30000000-0000-4000-8000-000000000020',
		'34000000-0000-4000-8000-000000000001', repeat('a',64), repeat('b',64)), 'The owner''s registration')
	#>> '{result,companyComputerId}' = (pg_temp.fence_office()).id::text, 'The owner registers the same computer again');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	format('select public.qorpera_runtime_office_access_status(%L::jsonb, %L)', current_setting('qorpera_test.office_scope'),
		'30000000-0000-4000-8000-000000000030'),
	'Office grant administration unavailable', 'An agent''s access in another company');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000001',
	format('select public.qorpera_runtime_office_access_status(%L::jsonb, %L)', current_setting('qorpera_test.office_scope'),
		'30000000-0000-4000-8000-000000000030'), 'The owner reading an agent''s access');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	format('select public.qorpera_set_runtime_office_access(%L, %L, 999, true)', (pg_temp.fence_office()).id,
		'30000000-0000-4000-8000-000000000030'),
	'Shared office grant is unavailable', 'Setting an agent''s access in another company');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000001',
	format('select public.qorpera_set_runtime_office_access(%L, %L, 999, true)', (pg_temp.fence_office()).id,
		'30000000-0000-4000-8000-000000000030'), 'The owner setting an agent''s access');

-- 3. A computer's start. For someone outside the company the scope is still checked first: a scope that is not the
--    computer's gets the refusal it got before. A start or wake gets the refusal of the branch the computer's state
--    picks. A member's call checks the scope under the fence, as before.
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	format('select public.qorpera_runtime_office_start_status(%L::jsonb)', current_setting('qorpera_test.office_scope')),
	'Office start status requires membership', 'Another company''s start status');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	format('select public.qorpera_runtime_office_start_status(%L::jsonb)',
		current_setting('qorpera_test.office_scope')::jsonb || '{"logicalComputerId":"75500000-0000-4000-8000-000000000098"}'),
	'Office start scope differs', 'A start status for a scope that is not the computer''s');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000003',
	format('select public.qorpera_runtime_office_start_status(%L::jsonb)', current_setting('qorpera_test.office_scope')),
	'The viewer''s start status');
select pg_temp.wake_assert(pg_temp.fence_waits('30000000-0000-4000-8000-000000000003',
	format('select public.qorpera_runtime_office_start_status(%L::jsonb)',
		current_setting('qorpera_test.office_scope')::jsonb || '{"logicalComputerId":"75500000-0000-4000-8000-000000000098"}'),
	'The viewer''s start status for a scope that is not the computer''s') ->> 'error' = 'Office start scope differs',
	'The viewer learns the scope differs after the fence, as before');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001', pg_temp.fence_start('qorpera_request_runtime_office_start'),
	'Office wake unavailable', 'Waking another company''s running computer');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000002', pg_temp.fence_start('qorpera_request_runtime_office_start'),
	'The contributor waking the computer');
select pg_temp.wake_assert(pg_temp.fence_waits('30000000-0000-4000-8000-000000000002',
	format('select public.qorpera_request_runtime_office_start(%L::jsonb, %s, ''75500000-0000-4000-8000-000000000040'')',
		current_setting('qorpera_test.office_scope'), (pg_temp.fence_office()).generation + 1),
	'The contributor waking another generation of the computer') ->> 'error' = 'Office start scope differs',
	'The contributor learns the generation differs after the fence, as before');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001', pg_temp.fence_start('qorpera_cancel_runtime_office_start'),
	'Office start cancellation differs', 'Cancelling the start of another company''s running computer');
select pg_temp.wake_assert(pg_temp.fence_waits('30000000-0000-4000-8000-000000000001',
	pg_temp.fence_start('qorpera_cancel_runtime_office_start'), 'The owner cancelling the start of the running computer')
	->> 'error' = 'Office start cancellation differs', 'The owner learns the computer is not starting after the fence, as before');
select pg_temp.fence_state('provisioning');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001', pg_temp.fence_start('qorpera_request_runtime_office_start'),
	'Office start requires founder authority', 'Starting another company''s computer');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000002', pg_temp.fence_start('qorpera_request_runtime_office_start'),
	'The contributor starting the computer');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001', pg_temp.fence_start('qorpera_cancel_runtime_office_start'),
	'Office start cancellation requires founder authority', 'Cancelling the start of another company''s computer');
select pg_temp.fence_refused('30000000-0000-4000-8000-000000000002', pg_temp.fence_start('qorpera_cancel_runtime_office_start'),
	'Office start cancellation requires founder authority', 'The contributor cancelling the start');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000001', pg_temp.fence_start('qorpera_cancel_runtime_office_start'),
	'The owner cancelling the start');
select pg_temp.fence_state('active');
-- Withdrawing a wake asks no membership: someone outside the company with no wake request of their own on the
-- computer's current cycle has nothing to withdraw, as before, and now without the fence.
do $$
declare v_outcome jsonb := pg_temp.fence_call('75500000-0000-4000-8000-000000000001',
	pg_temp.fence_start('qorpera_withdraw_runtime_office_wake'));
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome -> 'result' = '{"state":"unavailable"}'::jsonb,
		'Someone outside the company has no wake to withdraw, without waiting for the fence: ' || v_outcome::text);
end $$;
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	pg_temp.fence_start('qorpera_withdraw_runtime_office_wake',
		current_setting('qorpera_test.office_scope')::jsonb || '{"logicalComputerId":"75500000-0000-4000-8000-000000000098"}'),
	'Office start scope differs', 'Withdrawing a wake for a scope that is not the computer''s');
select pg_temp.wake_assert(pg_temp.fence_waits('30000000-0000-4000-8000-000000000003',
	pg_temp.fence_start('qorpera_withdraw_runtime_office_wake'), 'The viewer withdrawing a wake') -> 'result'
	= '{"state":"unavailable"}'::jsonb, 'The viewer has no wake to withdraw either');
-- Someone who asked for a wake while a member (fixture rows: the computer's current idle cycle and their request)
-- still withdraws it, under the fence. Their other requests, which the withdrawal would not touch, find nothing
-- without the fence: another request id, one on a superseded cycle, one on another generation's cycle.
do $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_office_idle_cycles(transition_id,office_id,computer_generation,request,superseded_at)
	values ('75500000-0000-4000-8000-000000000050',(pg_temp.fence_office()).id,(pg_temp.fence_office()).generation,'{}',null),
		('75500000-0000-4000-8000-000000000051',(pg_temp.fence_office()).id,(pg_temp.fence_office()).generation,'{}',clock_timestamp()),
		('75500000-0000-4000-8000-000000000052',(pg_temp.fence_office()).id,(pg_temp.fence_office()).generation+1,'{}',null);
	insert into public.qorpera_runtime_office_wake_requests(transition_id,user_id,request_id) values
		('75500000-0000-4000-8000-000000000050','75500000-0000-4000-8000-000000000001','75500000-0000-4000-8000-000000000040'),
		('75500000-0000-4000-8000-000000000051','75500000-0000-4000-8000-000000000001','75500000-0000-4000-8000-000000000042'),
		('75500000-0000-4000-8000-000000000052','75500000-0000-4000-8000-000000000001','75500000-0000-4000-8000-000000000043');
end $$;
do $$
declare v_request text; v_outcome jsonb;
begin
	foreach v_request in array array['75500000-0000-4000-8000-000000000041','75500000-0000-4000-8000-000000000042',
		'75500000-0000-4000-8000-000000000043'] loop
		v_outcome := pg_temp.fence_call('75500000-0000-4000-8000-000000000001',
			replace(pg_temp.fence_start('qorpera_withdraw_runtime_office_wake'), '75500000-0000-4000-8000-000000000040', v_request));
		perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome -> 'result' = '{"state":"unavailable"}'::jsonb,
			'A former member''s request ' || v_request || ' finds nothing, without waiting for the fence: ' || v_outcome::text);
	end loop;
end $$;
select pg_temp.wake_assert(pg_temp.fence_waits('75500000-0000-4000-8000-000000000001',
	pg_temp.fence_start('qorpera_withdraw_runtime_office_wake'), 'A former member withdrawing their own wake') -> 'result'
	= '{"state":"withdrawn"}'::jsonb, 'A former member withdraws their own wake');

-- 4. Recovering a compute identity.
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	format('select public.qorpera_request_identity_recovery(%L, %L, %L, 1, %L, ''nas'')', '75500000-0000-4000-8000-000000000010',
		'75500000-0000-4000-8000-000000000023', '75500000-0000-4000-8000-000000000041', repeat('c',64)),
	'recovery requires a current company owner', 'Recovering another company''s identity');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000001',
	format('select public.qorpera_request_identity_recovery(%L, %L, %L, 1, %L, ''nas'')', '75500000-0000-4000-8000-000000000010',
		'75500000-0000-4000-8000-000000000023', '75500000-0000-4000-8000-000000000041', repeat('c',64)),
	'The owner requesting a recovery');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_consent_identity_recovery('75500000-0000-4000-8000-000000000020')$q$,
	'recovery member consent is unavailable', 'Consenting to another company''s recovery');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000003',
	$q$select public.qorpera_consent_identity_recovery('75500000-0000-4000-8000-000000000020')$q$,
	'The identity''s member consenting');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_list_member_recovery_identities('30000000-0000-4000-8000-000000000010', null, 10)$q$,
	'Recovery membership is unavailable', 'Listing another company''s recoverable identities');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_list_member_recovery_identities('75500000-0000-4000-8000-000000000099', null, 10)$q$,
	'Recovery membership is unavailable', 'Listing the identities of a company nobody has');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000003',
	$q$select public.qorpera_list_member_recovery_identities('30000000-0000-4000-8000-000000000010', null, 10)$q$,
	'The viewer listing recoverable identities');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_cancel_identity_recovery('75500000-0000-4000-8000-000000000020')$q$,
	'recovery cancellation is unavailable', 'Cancelling another company''s recovery');
select pg_temp.fence_refused('30000000-0000-4000-8000-000000000002',
	$q$select public.qorpera_cancel_identity_recovery('75500000-0000-4000-8000-000000000020')$q$,
	'recovery cancellation is unavailable', 'A member who neither owns the company nor the identity cancelling');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000001',
	$q$select public.qorpera_cancel_identity_recovery('75500000-0000-4000-8000-000000000020')$q$,
	'The owner cancelling the recovery');

-- 5. Posting in a room: members of the company who are active members of the room. A room nobody has now gets the
--    same refusal.
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_post_company_room_message('75500000-0000-4000-8000-000000000030',
		'75500000-0000-4000-8000-000000000042', '{}', null, null)$q$,
	'Room is unavailable', 'Posting in another company''s room');
select pg_temp.fence_refused('75500000-0000-4000-8000-000000000001',
	$q$select public.qorpera_post_company_room_message('75500000-0000-4000-8000-000000000099',
		'75500000-0000-4000-8000-000000000042', '{}', null, null)$q$,
	'Room is unavailable', 'Posting in a room nobody has');
select pg_temp.fence_refused('30000000-0000-4000-8000-000000000003',
	$q$select public.qorpera_post_company_room_message('75500000-0000-4000-8000-000000000030',
		'75500000-0000-4000-8000-000000000042', '{}', null, null)$q$,
	'Room is unavailable', 'A member of the company outside the room posting');
select pg_temp.fence_waits('30000000-0000-4000-8000-000000000001',
	$q$select public.qorpera_post_company_room_message('75500000-0000-4000-8000-000000000030',
		'75500000-0000-4000-8000-000000000042', '{}', null, null)$q$,
	'The owner posting in the room');

-- 6. The catalog's membership check after the fence stays. The viewer's call passes the plain check and waits for
--    the fence; the holder removes the viewer from the company and lets go; the call reads the membership again
--    under its lock and refuses.
do $$
declare v_pid integer := current_setting('qorpera_test.fence_caller_pid')::integer; v_outcome jsonb;
begin
	perform dblink_exec('fence_holder', 'begin');
	perform * from dblink('fence_holder', $q$select 1 from public.qorpera_profiles
		where id = '30000000-0000-4000-8000-000000000010' for key share$q$) as held(held integer);
	perform pg_temp.fence_as(pg_temp.fence_claims('30000000-0000-4000-8000-000000000003'));
	perform dblink_send_query('fence_caller', $q$select public.qorpera_member_office_catalog('30000000-0000-4000-8000-000000000020')$q$);
	for attempt in 1..200 loop
		exit when cardinality(pg_blocking_pids(v_pid)) > 0 or dblink_is_busy('fence_caller') = 0;
		perform pg_sleep(0.025);
	end loop;
	if cardinality(pg_blocking_pids(v_pid)) = 0 then
		perform dblink_exec('fence_holder', 'rollback');
		raise exception 'The viewer''s catalog did not wait for the fence: %', pg_temp.fence_collect(); end if;
	perform dblink_exec('fence_holder', $q$set local session_replication_role = replica$q$);
	perform dblink_exec('fence_holder', $q$delete from public.qorpera_profile_members
		where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '30000000-0000-4000-8000-000000000003'$q$);
	perform dblink_exec('fence_holder', 'commit');
	v_outcome := pg_temp.fence_collect();
	perform pg_temp.wake_assert(v_outcome ->> 'state' = '42501' and v_outcome ->> 'error' = 'Company unavailable',
		'A member removed while waiting for the fence is refused: ' || v_outcome::text);
end $$;

-- Remove what this test committed.
select pg_temp.fence_cleanup();
