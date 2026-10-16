-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930488000 on 924's real native run of Alice's: the connector tool list (qorpera_list_native_connector_tools) as
-- the entry point reads its run without the run mutex, as describe does since 20260930487000 (test 674), and takes its
-- vault rows in rank 8's order: its grants FOR SHARE by id, then their secrets by id. Alice holds three grants of the
-- owner's: GA and GB on S1, a company Gmail connection, and GC on S2, the owner's own; the tool order is GA, GB, GC and
-- the id order GB, GA, GC. In each state the list answers one thing through the host, as the entry point by
-- request.path, directly (the locked run check) and as its body before this change, and lists a grant just when
-- qorpera_native_connector_locked_grant takes it. With the fixture committed (674's harness): while another connection
-- holds the run's budget row, the list through the host answers at once and a direct or nested one still waits; while
-- another holds S1, the list holds its three grants and queues for S1, the owner's Disconnect of S1 queues behind it
-- at GB, and both land (before this change: a deadlock). The timings are printed, not checked.
reset role;
select set_config('qorpera_test.k_token', 'k675-lease-token-0123456789abcdef', false);

-- A started run's job takes the known lease token, as 793 does.
create function pg_temp.k_token(p_binding jsonb) returns void language sql as $$
	update public.qorpera_runner_jobs
	set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.k_token'), 'utf8'), 'sha256'), 'hex')
	where id = (p_binding ->> 'jobId')::uuid
$$;
select pg_temp.k_token(current_setting('qorpera_test.base_binding')::jsonb);

-- The vault: a broker authority; S1 (...051), a company Gmail connection, and S2 (...052), the owner's own, the run's
-- sponsor's, each with a sealed version; three Gmail tools granted to Alice by the owner: GA (the first tool by name)
-- and GB (the second) on S1, GC (the third) on S2. GB's id is below GA's.
select pg_temp.base_assert((select run.sponsored_by_user_id from public.qorpera_execution_runs as run
	where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid) = '92400000-0000-4000-8000-000000000001',
	'the run is sponsored by the owner');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('67500000-0000-4000-8000-000000000040','92400000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','company-kek-1',repeat('e',64));
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
values ('67500000-0000-4000-8000-000000000051','92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020','67500000-0000-4000-8000-000000000040','company',null,
		'gmail','primary','Gmail account',1,'92400000-0000-4000-8000-000000000001'),
	('67500000-0000-4000-8000-000000000052','92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020','67500000-0000-4000-8000-000000000040','member',
		'92400000-0000-4000-8000-000000000001','gmail','personal','My Gmail',1,'92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,
	envelope_sha256,created_by_user_id)
select secret.id,1,'67500000-0000-4000-8000-000000000040','company-kek-1','\x0102',
	encode(extensions.digest('\x0102'::bytea,'sha256'),'hex'),'92400000-0000-4000-8000-000000000001'
from (values ('67500000-0000-4000-8000-000000000051'::uuid), ('67500000-0000-4000-8000-000000000052'::uuid)) as secret(id);
create temporary table k_ops as
select chosen.*, row_number() over (order by chosen.tool_name) as n from (
	select distinct on (operation.tool_name) operation.connector_id, operation.operation_id, operation.version, operation.tool_name
	from public.qorpera_cloud_connector_operations as operation
	where operation.connector_id = 'gmail' and operation.status = 'active'
	order by operation.tool_name, operation.version desc
) as chosen;
insert into public.qorpera_cloud_secret_operation_grants(id,profile_id,environment_id,secret_id,staff_agent_id,
	connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select granted.id,'92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000020',granted.secret_id,
	'92400000-0000-4000-8000-000000000030',operation.connector_id,operation.operation_id,operation.version,
	operation.tool_name,'92400000-0000-4000-8000-000000000001'
from (values ('67500000-0000-4000-8000-0000000000a2'::uuid, '67500000-0000-4000-8000-000000000051'::uuid, 1),
		('67500000-0000-4000-8000-0000000000a1'::uuid, '67500000-0000-4000-8000-000000000051'::uuid, 2),
		('67500000-0000-4000-8000-0000000000a3'::uuid, '67500000-0000-4000-8000-000000000052'::uuid, 3))
	as granted(id, secret_id, n)
join pg_temp.k_ops as operation on operation.n = granted.n;

-- The three grants in tool order (GA, GB, GC); one by its name; the names of the three a list answer gives, in its order.
create function pg_temp.k_grants() returns uuid[] language sql as $$
	select array['67500000-0000-4000-8000-0000000000a2','67500000-0000-4000-8000-0000000000a1',
		'67500000-0000-4000-8000-0000000000a3']::uuid[]
$$;
create function pg_temp.k_grant(p_name text) returns uuid language sql as $$
	select (pg_temp.k_grants())[array_position(array['GA','GB','GC'], p_name)]
$$;
create function pg_temp.k_names(p_grants uuid[]) returns text language sql as $$
	select coalesce(string_agg((array['GA','GB','GC'])[array_position(pg_temp.k_grants(), granted.id)], ',' order by granted.ordinal), 'none')
	from unnest(p_grants) with ordinality as granted(id, ordinal)
$$;
create function pg_temp.k_listed(p_tools jsonb) returns uuid[] language sql as $$
	select coalesce(array_agg((listed.tool ->> 'grantId')::uuid order by listed.ordinal), '{}')
	from jsonb_array_elements(case when jsonb_typeof(p_tools) = 'array' then p_tools else '[]'::jsonb end)
		with ordinality as listed(tool, ordinal)
	where (listed.tool ->> 'grantId')::uuid = any(pg_temp.k_grants())
$$;
select pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_operation_grants
	where id = any(pg_temp.k_grants()) and status = 'active') = 3, 'the three grants are active');
-- A call's answer, or its refusal.
create function pg_temp.k_try(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	execute p_sql into v_result;
	return jsonb_build_object('result', v_result);
exception when others then
	return jsonb_build_object('state', sqlstate, 'error', sqlerrm);
end $$;
-- The list through the native host (its entry point, the job's token), and the list called directly.
create function pg_temp.k_host_sql(p_binding jsonb) returns text language sql as $$
	select format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)', p_binding ->> 'jobId',
		current_setting('qorpera_test.k_token'), 'qorpera_list_native_connector_tools', jsonb_build_object('p_binding', p_binding))
$$;
create function pg_temp.k_list_sql(p_binding jsonb) returns text language sql as $$
	select format('select public.qorpera_list_native_connector_tools(%L::jsonb)', p_binding)
$$;
-- The list's body before this change (20260828018000), verbatim.
create function pg_temp.k_old_list(p_binding jsonb) returns jsonb language plpgsql as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_result jsonb := '[]'::jsonb;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	for v_grant in
		select grant_row.* from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.profile_id=v_run.profile_id and grant_row.environment_id=v_run.environment_id
			and grant_row.staff_agent_id=v_run.staff_agent_id and grant_row.status='active'
		order by grant_row.tool_name,grant_row.id limit 32
	loop
		begin
			v_grant := public.qorpera_native_connector_locked_grant(p_binding,v_grant.id);
			v_result := v_result || (
				select jsonb_build_array(jsonb_build_object(
					'schema','qorpera.native-connector-tool/v1','grantId',v_grant.id,
					'toolName',operation.tool_name,'description',operation.description,
					'inputSchema',operation.input_schema,'connectorId',operation.connector_id,
					'operationId',operation.operation_id,'operationVersion',operation.version,
					'adapterSha256',operation.adapter_sha256,'destinationOrigin',operation.destination_origin
				)) from public.qorpera_cloud_connector_operations as operation
				where operation.connector_id=v_grant.connector_id and operation.operation_id=v_grant.operation_id
					and operation.version=v_grant.operation_version
			);
		exception when insufficient_privilege or no_data_found then null;
		end;
	end loop;
	return v_result;
end
$$;
-- The list in this transaction through the host (the publishable key's role on the host's RPC path), as the entry point
-- by request.path (PostgREST's form; the plain read the host reaches), by direct SQL with no request.path (the locked
-- run check) and (p_before) as its body before this change. The service role's claims stay set after.
create function pg_temp.k_four(p_binding jsonb, p_before boolean default true) returns jsonb language plpgsql as $$
declare v_host jsonb; v_plain jsonb; v_locked jsonb; v_before jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
	v_host := pg_temp.k_try(pg_temp.k_host_sql(p_binding));
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.path', '/rest/v1/rpc/qorpera_list_native_connector_tools', true);
	v_plain := pg_temp.k_try(pg_temp.k_list_sql(p_binding));
	perform set_config('request.path', '', true);
	v_locked := pg_temp.k_try(pg_temp.k_list_sql(p_binding));
	if p_before then v_before := pg_temp.k_try(format('select pg_temp.k_old_list(%L::jsonb)', p_binding)); end if;
	return jsonb_strip_nulls(jsonb_build_object('host', v_host, 'plain', v_plain, 'locked', v_locked, 'before', v_before));
end $$;
-- A state: the four answers are one (jsonb =); they answer (p_state null) or refuse with p_state ('*': either way); the
-- list names exactly p_listed of the three grants, in tool order, and those are the ones the grant check takes.
create function pg_temp.k_state(p_name text, p_listed text, p_state text default null) returns text language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v jsonb := pg_temp.k_four(v_binding);
	v_listed text := pg_temp.k_names(pg_temp.k_listed(v #> '{locked,result}')); v_taken text; v_ok boolean;
begin
	select pg_temp.k_names(coalesce(array_agg(granted.id order by granted.ordinal), '{}')) into v_taken
	from unnest(pg_temp.k_grants()) with ordinality as granted(id, ordinal)
	where pg_temp.k_try(format('select to_jsonb(public.qorpera_native_connector_locked_grant(%L::jsonb, %L::uuid))',
		v_binding, granted.id)) ? 'result';
	if v -> 'host' is distinct from v -> 'locked' or v -> 'plain' is distinct from v -> 'locked'
		or v -> 'before' is distinct from v -> 'locked' then
		raise exception '675 %: the list answers differently through the host, plain, locked and before: %', p_name, v; end if;
	v_ok := (p_state is null and v -> 'locked' ? 'result') or p_state = '*' or v #>> '{locked,state}' = p_state;
	if not coalesce(v_ok, false) or v_listed is distinct from p_listed or v_taken is distinct from p_listed then
		raise exception '675 %: expected % (%); the list named % and the grant check took %: %', p_name, p_listed,
			coalesce(p_state, 'an answer'), v_listed, v_taken, v; end if;
	return format('%s: %s', p_name, coalesce(v #>> '{locked,state}' || ' ' || (v #>> '{locked,error}'), 'lists ' || v_listed));
end $$;
-- This transaction's calls of the plain read, the locked run check and the locked grant check.
create function pg_temp.k_calls() returns bigint[] language sql as $$
	select array_agg(coalesce((select sum(f.calls) from pg_stat_xact_user_functions f
		where f.schemaname = 'public' and f.funcname = n.name), 0)::bigint order by n.ordinal)
	from unnest(array['qorpera_folder_native_run_plain', 'qorpera_folder_tool_run', 'qorpera_native_connector_locked_grant'])
		with ordinality as n(name, ordinal)
$$;

-- 1. The list's source: the plain run check as the entry point and the locked one otherwise; no call of the locked
--    grant check; its grants FOR SHARE by id before their secrets. Its settings and grants are as before: the service
--    role runs it, the API roles do not.
do $$
declare v_list pg_proc;
begin
	select * into strict v_list from pg_proc where oid = 'public.qorpera_list_native_connector_tools(jsonb)'::regprocedure;
	if position('v_run := public.qorpera_folder_native_run_plain(p_binding);' in v_list.prosrc) = 0
		or position('v_run := public.qorpera_native_tool_locked_run(p_binding);' in v_list.prosrc) = 0
		or position('qorpera_native_connector_locked_grant(' in v_list.prosrc) > 0
		or v_list.prosrc !~ 'order by grant_row\.id for share;.*order by secret\.id for share of secret;'
		or not v_list.prosecdef or v_list.proconfig is distinct from array['search_path=""']
		or not has_function_privilege('service_role', v_list.oid, 'execute')
		or exists (select 1 from unnest(array['public','anon','authenticated']) r(name)
			where has_function_privilege(r.name, v_list.oid, 'execute')) then
		raise exception 'The connector tool list is not as expected: % %', v_list.proconfig, v_list.proacl; end if;
end $$;

-- 2. With nothing held, the three answers are one and name the three grants: through the host and as the entry point
--    by request.path the list reads plain, directly it takes the locked run check, and none takes the locked grant check.
set local track_functions = 'all';
do $$
declare v_at bigint[] := pg_temp.k_calls(); v jsonb := pg_temp.k_four(current_setting('qorpera_test.base_binding')::jsonb, false);
	v_after bigint[] := pg_temp.k_calls();
begin
	if pg_temp.k_listed(v #> '{locked,result}') is distinct from pg_temp.k_grants()
		or v -> 'host' is distinct from v -> 'locked' or v -> 'plain' is distinct from v -> 'locked' then
		raise exception 'The list answers differently through the host, plain and locked: %', v; end if;
	if array[v_after[1] - v_at[1], v_after[2] - v_at[2], v_after[3] - v_at[3]] is distinct from array[2, 1, 0]::bigint[] then
		raise exception 'The list did not read plain twice, lock once and skip the grant check: % then %', v_at, v_after; end if;
end $$;
reset track_functions;

-- 3. The states, each undone after: a revoked or expired grant, a revoked connection, a retired operation, a grant of a
--    company connection issued by a contributor (refused) or an admin (kept), a grant of the owner's own connection
--    issued by an admin, that connection made the admin's (the run's sponsor is the owner), Alice archived, and the
--    company's stop.
savepoint k_state;
select pg_temp.k_state('as fixed', 'GA,GB,GC') as k_out \gset
\echo 675 state :k_out

set local session_replication_role = replica;
update public.qorpera_cloud_secret_operation_grants set status = 'revoked', revoked_at = statement_timestamp()
where id = pg_temp.k_grant('GA');
set local session_replication_role = origin;
select pg_temp.k_state('GA revoked', 'GB,GC') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_cloud_secret_operation_grants
set created_at = statement_timestamp() - interval '2 hours', expires_at = statement_timestamp() - interval '1 hour'
where id = pg_temp.k_grant('GA');
set local session_replication_role = origin;
select pg_temp.k_state('GA expired', 'GB,GC') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp()
where id = '67500000-0000-4000-8000-000000000051';
set local session_replication_role = origin;
select pg_temp.k_state('S1 revoked', 'GC') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_cloud_connector_operations as operation set status = 'retired'
from public.qorpera_cloud_secret_operation_grants as grant_row
where grant_row.id = pg_temp.k_grant('GA') and operation.connector_id = grant_row.connector_id
	and operation.operation_id = grant_row.operation_id and operation.version = grant_row.operation_version;
set local session_replication_role = origin;
select pg_temp.k_state('GA''s operation retired', 'GB,GC') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000002'
where id = pg_temp.k_grant('GA');
set local session_replication_role = origin;
select pg_temp.k_state('GA issued by a contributor', 'GB,GC') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000004'
where id = pg_temp.k_grant('GA');
set local session_replication_role = origin;
select pg_temp.k_state('GA issued by an admin', 'GA,GB,GC') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000004'
where id = pg_temp.k_grant('GC');
set local session_replication_role = origin;
select pg_temp.k_state('GC issued by an admin', 'GA,GB') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_cloud_secrets set owner_user_id = '92400000-0000-4000-8000-000000000004'
where id = '67500000-0000-4000-8000-000000000052';
update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000004'
where id = pg_temp.k_grant('GC');
set local session_replication_role = origin;
select pg_temp.k_state('S2 the admin''s', 'GA,GB') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

set local session_replication_role = replica;
update public.qorpera_profile_staff set employment_status = 'archived'
where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '92400000-0000-4000-8000-000000000030';
set local session_replication_role = origin;
select pg_temp.k_state('Alice archived', 'none', '*') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;

insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'k675');
select pg_temp.k_state('paused', 'none', '55000') as k_out \gset
\echo 675 state :k_out
rollback to savepoint k_state;
release savepoint k_state;

-- 4. A caller that is neither the service role nor the broker is refused by the run check, as before: a member's
--    claims, as the entry point by request.path, directly and as the list before this change.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_plain jsonb; v_locked jsonb; v_before jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform set_config('request.path', '/rest/v1/rpc/qorpera_list_native_connector_tools', true);
	v_plain := pg_temp.k_try(pg_temp.k_list_sql(v_binding));
	perform set_config('request.path', '', true);
	v_locked := pg_temp.k_try(pg_temp.k_list_sql(v_binding));
	v_before := pg_temp.k_try(format('select pg_temp.k_old_list(%L::jsonb)', v_binding));
	perform pg_temp.base_claims('service_role');
	if v_plain is distinct from '{"state": "42501", "error": "native tool host authority is required"}'::jsonb
		or v_locked is distinct from v_plain or v_before is distinct from v_plain then
		raise exception 'A member''s claims were not refused as before: plain %, locked %, before %', v_plain, v_locked, v_before; end if;
end $$;

-- 5. The timing, on this machine with nothing else running (printed only): the list through the host, directly (the
--    locked run check) and as its body before this change (the locked run check, then the locked grant check for each
--    grant), 20 times each.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_host_sql text := pg_temp.k_host_sql(v_binding);
	v_start timestamptz; v_host double precision := 0; v_locked double precision := 0; v_before double precision := 0;
	c_rounds constant integer := 20;
begin
	for i in 1 .. c_rounds loop
		perform set_config('request.jwt.claims', '{"role":"anon"}', true);
		perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
		v_start := clock_timestamp();
		execute v_host_sql;
		v_host := v_host + extract(epoch from clock_timestamp() - v_start);
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		perform set_config('request.path', '', true);
		v_start := clock_timestamp();
		perform public.qorpera_list_native_connector_tools(v_binding);
		v_locked := v_locked + extract(epoch from clock_timestamp() - v_start);
		v_start := clock_timestamp();
		perform pg_temp.k_old_list(v_binding);
		v_before := v_before + extract(epoch from clock_timestamp() - v_start);
	end loop;
	perform set_config('qorpera_test.k_ms', format('the list through the host %s ms, directly (locked) %s ms, its body before '
		|| 'this change %s ms; mean of %s, three grants', round((v_host * 1000 / c_rounds)::numeric, 2),
		round((v_locked * 1000 / c_rounds)::numeric, 2), round((v_before * 1000 / c_rounds)::numeric, 2), c_rounds), false);
end $$;
select current_setting('qorpera_test.k_ms') as k_ms \gset
\echo 675 timing: :k_ms

-- Row locks show only across connections, so 924's fixture and the vault rows are committed here and removed again at
-- the end (674's harness, from 793): the test refuses to run beside other connections to this database, whose rows the
-- cleanup could not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.base_binding','qorpera_test.k_token']) name;
select set_config('qorpera_test.k_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('k_holder', 'dbname=' || current_database());
select dblink_connect('k_caller', 'dbname=' || current_database());
select dblink_connect('k_vault', 'dbname=' || current_database());
select set_config('qorpera_test.k_' || name || '_pid', pid::text, false)
from unnest(array['holder','caller','vault']) name, lateral dblink('k_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.k_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.k_holder_pid'), current_setting('qorpera_test.k_caller_pid'),
			current_setting('qorpera_test.k_vault_pid'))) then
		raise exception 'The connector tool list test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.k_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table k_counts as select * from dblink('k_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table k_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.k_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.k_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.k_rows select v_table, kept.row_value
			from dblink('k_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.k_collect(p_connection text) returns jsonb language plpgsql as $$
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
-- Whether one connection's sent call waited for a lock another holds before it finished (10 s at most).
create function pg_temp.k_waits(p_waiting text, p_for text) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.k_' || p_waiting || '_pid')::integer;
	v_for integer := current_setting('qorpera_test.k_' || p_for || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_for = any(pg_blocking_pids(v_pid)) then return true; end if;
		exit when dblink_is_busy('k_' || p_waiting) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
-- Whether a row is free: a NOWAIT lock on it, in a subtransaction this function then rolls back, which releases it.
create function pg_temp.k_free(p_sql text) returns boolean language plpgsql as $$
begin
	execute p_sql || ' nowait';
	raise sqlstate 'K6750';
exception
	when lock_not_available then return false;
	when sqlstate 'K6750' then return true;
end $$;
-- At the end: remove what the test committed, as 793 does.
create function pg_temp.k_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.k_first_xid')::xid;
begin
	perform pg_temp.k_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['k_holder','k_caller','k_vault']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.k_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.k_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.k_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.k_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Connector tool list test cleanup left other row counts: %', v_wrong; end if;
end $$;
-- One call on the caller connection, in its own transaction, as the platform's service caller on p_path with a 1 s
-- lock_timeout, after p_setup: its answer or its error, and how long it took.
create function pg_temp.k_remote(p_path text, p_sql text, p_setup text default null) returns jsonb language plpgsql as $$
declare v_start timestamptz; v_outcome jsonb;
begin
	perform dblink_exec('k_caller', 'begin');
	perform * from dblink('k_caller', format($q$select set_config('request.jwt.claims', '{"role":"service_role"}', true),
		set_config('request.path', %L, true), set_config('lock_timeout', '1s', true)$q$, p_path)) as s(claims text, path text, timeout text);
	if p_setup is not null then perform dblink_exec('k_caller', p_setup); end if;
	v_start := clock_timestamp();
	perform dblink_send_query('k_caller', p_sql);
	v_outcome := pg_temp.k_collect('k_caller');
	perform dblink_exec('k_caller', 'rollback');
	return v_outcome || jsonb_build_object('ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric));
end $$;

-- 6. Another transaction holds the run's budget row (the run mutex), as a slow tool step does. The list through the
--    host (the publishable key's role on the host's RPC path) answers the three tools without waiting for it.
select dblink_exec('k_holder', 'begin');
select * from dblink('k_holder', format('select 1 from public.qorpera_execution_run_budgets where run_id = %L for update',
	current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')) as held(one integer);
do $$
declare v_start timestamptz; v_outcome jsonb;
begin
	perform dblink_exec('k_caller', 'begin');
	perform * from dblink('k_caller', $q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', '/rpc/qorpera_native_host_call', true)$q$) as c(claims text, path text);
	perform dblink_exec('k_caller', 'set local role anon');
	v_start := clock_timestamp();
	perform dblink_send_query('k_caller', pg_temp.k_host_sql(current_setting('qorpera_test.base_binding')::jsonb));
	if pg_temp.k_waits('caller', 'holder') then
		perform dblink_exec('k_holder', 'rollback');
		raise exception 'The list through the host waited for the run mutex: %', pg_temp.k_collect('k_caller'); end if;
	v_outcome := pg_temp.k_collect('k_caller');
	perform set_config('qorpera_test.k_held_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric)::text, false);
	perform dblink_exec('k_caller', 'rollback');
	if pg_temp.k_listed(v_outcome -> 'result') is distinct from pg_temp.k_grants() then
		perform dblink_exec('k_holder', 'rollback');
		raise exception 'The list through the host did not answer the three tools: %', v_outcome; end if;
end $$;

-- Still held: the list by direct SQL waits (55P03 under a 1 s lock_timeout). With request.path set to the list by hand,
-- the list itself reads plain, but a function that calls it still waits.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_path text := '/rest/v1/rpc/qorpera_list_native_connector_tools'; v_direct jsonb; v_plain jsonb; v_nested jsonb;
begin
	v_direct := pg_temp.k_remote('', pg_temp.k_list_sql(v_binding));
	v_plain := pg_temp.k_remote(v_path, pg_temp.k_list_sql(v_binding));
	v_nested := pg_temp.k_remote(v_path, format('select public.k675_nested(%L::jsonb)', v_binding),
		$f$create function public.k675_nested(p_binding jsonb) returns jsonb language plpgsql security definer set search_path = ''
			as $b$ begin return public.qorpera_list_native_connector_tools(p_binding); end $b$ $f$);
	perform dblink_exec('k_holder', 'rollback');
	perform set_config('qorpera_test.k_direct_ms', coalesce(v_direct ->> 'ms', '?'), false);
	if v_direct ->> 'state' is distinct from '55P03' or pg_temp.k_listed(v_plain -> 'result') is distinct from pg_temp.k_grants()
		or v_nested ->> 'state' is distinct from '55P03' then
		raise exception 'The run mutex is not as expected: direct %, by hand %, nested %', v_direct, v_plain, v_nested; end if;
end $$;

-- 7. Another transaction holds S1 FOR UPDATE, as a Disconnect, a share or the broker's seal does once it holds the
--    grants. The list through the host takes GB, GA and GC FOR SHARE (by id) and then queues for S1, holding neither
--    the run mutex nor S2; the owner's Disconnect of S1, which takes S1's grants by id before S1, queues behind the list
--    at GB. Once the holder ends, the list answers the three tools; once the list's transaction ends, the Disconnect
--    lands: no 40P01. Before this change the list held GA and queued for S1; with S1 it queued for GB, which the
--    Disconnect held while it queued for GA.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_start timestamptz; v_queued boolean;
	v_grants_held boolean; v_free boolean; v_behind boolean; v_list jsonb; v_disconnect jsonb;
begin
	perform dblink_exec('k_holder', 'begin');
	perform * from dblink('k_holder', $q$select 1 from public.qorpera_cloud_secrets
		where id = '67500000-0000-4000-8000-000000000051' for update$q$) as held(one integer);
	perform dblink_exec('k_caller', 'begin');
	perform * from dblink('k_caller', $q$select set_config('request.jwt.claims', '{"role":"anon"}', true),
		set_config('request.path', '/rpc/qorpera_native_host_call', true)$q$) as c(claims text, path text);
	perform dblink_exec('k_caller', 'set local role anon');
	v_start := clock_timestamp();
	perform dblink_send_query('k_caller', pg_temp.k_host_sql(v_binding));
	v_queued := pg_temp.k_waits('caller', 'holder');
	select bool_and(not pg_temp.k_free(format('select 1 from public.qorpera_cloud_secret_operation_grants where id = %L for update',
		granted.id))) into v_grants_held from unnest(pg_temp.k_grants()) as granted(id);
	v_free := pg_temp.k_free(format('select 1 from public.qorpera_execution_run_budgets where run_id = %L for update', v_binding ->> 'runId'))
		and pg_temp.k_free($q$select 1 from public.qorpera_cloud_secrets where id = '67500000-0000-4000-8000-000000000052' for update$q$);
	perform dblink_exec('k_vault', 'begin');
	perform * from dblink('k_vault', $q$select set_config('request.jwt.claims',
		'{"role":"authenticated","sub":"92400000-0000-4000-8000-000000000001"}', true)$q$) as c(claims text);
	perform dblink_send_query('k_vault', $q$select public.qorpera_revoke_cloud_secret('92400000-0000-4000-8000-000000000010',
		'67500000-0000-4000-8000-000000000051')$q$);
	v_behind := pg_temp.k_waits('vault', 'caller');
	perform dblink_exec('k_holder', 'rollback');
	v_list := pg_temp.k_collect('k_caller');
	perform set_config('qorpera_test.k_queued_ms', round((extract(epoch from clock_timestamp() - v_start) * 1000)::numeric)::text, false);
	perform dblink_exec('k_caller', 'rollback');
	v_disconnect := pg_temp.k_collect('k_vault');
	perform dblink_exec('k_vault', 'rollback');
	if not (v_queued and v_grants_held and v_free and v_behind) or pg_temp.k_listed(v_list -> 'result') is distinct from pg_temp.k_grants()
		or not (v_disconnect ? 'result') then
		raise exception 'The vault order is not as expected: the list queued for S1 %, held the grants %, left the mutex and S2 free %; '
			'the Disconnect queued behind it %; the list %, the Disconnect %', v_queued, v_grants_held, v_free, v_behind, v_list, v_disconnect;
	end if;
end $$;
select current_setting('qorpera_test.k_held_ms') as k_held_ms, current_setting('qorpera_test.k_direct_ms') as k_direct_ms,
	current_setting('qorpera_test.k_queued_ms') as k_queued_ms \gset
\echo 675 while the budget row is held: the list through the host answered in :k_held_ms ms; directly it gave up after :k_direct_ms ms (55P03). While S1 was held: the list queued, holding its grants, and answered in :k_queued_ms ms; the Disconnect queued behind it and landed.

select pg_temp.k_cleanup();
