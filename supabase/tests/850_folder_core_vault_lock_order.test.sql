-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3d-2 (20260930003500): on a folder-v2 company the vault's own changes take rank 8's inner
-- order (tickets, grants, secrets) and the member row before them, so they never meet an agent's tool call or a member
-- change in a cycle. In each case a holder keeps one row so the others queue behind it in the order that deadlocked
-- before: the change must wait where the order puts it (and leave the secret free), and once the holder ends both land.
-- 648's committed fixture (Ada's leased run), plus a broker authority, secrets, grants and capture tickets of the company,
-- an admin and a second contributor; all removed at the end.

-- The company's login pays for unattended work (as 663's).
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
-- An admin who starts a capture, and a contributor with a connection of their own.
insert into auth.users(id, email) values
	('85000000-0000-4000-8000-000000000003', 'vault-order-admin@example.test'),
	('85000000-0000-4000-8000-000000000004', 'vault-order-member@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('64800000-0000-4000-8000-000000000010', '85000000-0000-4000-8000-000000000003', 'vault-order-admin@example.test', 'Admin', 'admin'),
	('64800000-0000-4000-8000-000000000010', '85000000-0000-4000-8000-000000000004', 'vault-order-member@example.test', 'Member',
		'contributor');
set session_replication_role = origin;

-- The vault: one broker authority; secrets A (Disconnect), B (share, and one operation granted), C (a company rotation),
-- E (the contributor's own); grants of Ada's on A, B and C; capture tickets for C's rotation and for D's first capture.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('85000000-0000-4000-8000-0000000000b0', '64800000-0000-4000-8000-000000000010', 'https://broker.example.test', 'test',
	repeat('a', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id, connector_id,
	secret_name, purpose, current_version, created_by_user_id)
values
	('85000000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85000000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'a', 'Mail A', 1, '64800000-0000-4000-8000-000000000001'),
	('85000000-0000-4000-8000-0000000000a2', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85000000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'b', 'Mail B', 1, '64800000-0000-4000-8000-000000000001'),
	('85000000-0000-4000-8000-0000000000a3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85000000-0000-4000-8000-0000000000b0', 'company', null, 'google_drive', 'primary', 'Files', 1,
		'64800000-0000-4000-8000-000000000001'),
	('85000000-0000-4000-8000-0000000000a5', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85000000-0000-4000-8000-0000000000b0', 'member', '85000000-0000-4000-8000-000000000004', 'gmail', 'personal', 'Own mail', 1,
		'85000000-0000-4000-8000-000000000004');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256,
	created_by_user_id)
select secret.id, 1, '85000000-0000-4000-8000-0000000000b0', 'test', decode('abcd', 'hex'), repeat('b', 64), secret.created_by_user_id
from public.qorpera_cloud_secrets as secret where secret.broker_authority_id = '85000000-0000-4000-8000-0000000000b0';
-- Ada's grants: A's first mail operation, B's second, C's first file operation.
insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id, connector_id,
	operation_id, operation_version, tool_name, issued_by_user_id)
select grant_row.id, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', grant_row.secret_id,
	'64800000-0000-4000-8000-0000000000a1', operation.connector_id, operation.operation_id, operation.version, operation.tool_name,
	'64800000-0000-4000-8000-000000000001'
from (values ('85000000-0000-4000-8000-0000000000c1'::uuid, '85000000-0000-4000-8000-0000000000a1'::uuid, 'gmail', 0),
		('85000000-0000-4000-8000-0000000000c2'::uuid, '85000000-0000-4000-8000-0000000000a2'::uuid, 'gmail', 1),
		('85000000-0000-4000-8000-0000000000c3'::uuid, '85000000-0000-4000-8000-0000000000a3'::uuid, 'google_drive', 0))
	as grant_row(id, secret_id, connector, position)
cross join lateral (select operation.* from public.qorpera_cloud_connector_operations as operation
	where operation.connector_id = grant_row.connector and operation.status = 'active'
	order by operation.operation_id offset grant_row.position limit 1) as operation;
-- C's rotation (by the owner) and D's first capture of a company connection (by the admin), pending.
insert into public.qorpera_cloud_secret_capture_tickets(id, profile_id, environment_id, broker_authority_id, key_id, secret_id,
	target_version, owner_kind, owner_user_id, connector_id, secret_name, purpose, capture_capability_sha256, created_by_user_id,
	expires_at)
values
	('85000000-0000-4000-8000-0000000000d3', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85000000-0000-4000-8000-0000000000b0', 'test', '85000000-0000-4000-8000-0000000000a3', 2, 'company', null, 'google_drive',
		'primary', 'Files', repeat('e', 64), '64800000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 hour'),
	('85000000-0000-4000-8000-0000000000d4', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85000000-0000-4000-8000-0000000000b0', 'test', '85000000-0000-4000-8000-0000000000a4', 1, 'company', null, 'github',
		'primary', 'Code', repeat('f', 64), '85000000-0000-4000-8000-000000000003', clock_timestamp() + interval '1 hour');

-- The holder (fence_one) keeps one row in a transaction of its own.
create function pg_temp.hold(p_sql text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', p_sql) as t(x integer);
end $$;
create function pg_temp.release() returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'commit');
end $$;
-- An agent call's grant check (Ada's run), as the native host makes it.
create function pg_temp.sql_call(p_grant uuid) returns text language sql as $$
	select format('select (public.qorpera_native_connector_locked_grant(%L, %L)).id::text', current_setting('qorpera_test.binding'), p_grant)
$$;
-- The broker's seal of a ticket (its capture capability's digest is the ticket's own).
create function pg_temp.sql_seal(p_ticket uuid) returns text language sql as $$
	select format('select public.qorpera_complete_cloud_secret_capture(%L, %L, %L, %L, %L, %L, null)::text',
		'85000000-0000-4000-8000-0000000000b0', repeat('a', 64), p_ticket,
		(select capture_capability_sha256 from public.qorpera_cloud_secret_capture_tickets where id = p_ticket),
		encode('\x0102'::bytea, 'base64'),
		encode(extensions.digest('\x0102'::bytea, 'sha256'), 'hex'))
$$;
create function pg_temp.claims(p_conn text, p_user text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_build_object('role', 'authenticated', 'sub', p_user)::text));
end $$;
-- Whether a connection waits at a row of a table (665's): it holds or queues for that row's tuple lock while blocked.
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- Whether a row is free (665's): a NOWAIT lock on fence_four, released at once.
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
create function pg_temp.sql_secret(p_secret uuid) returns text language sql as $$
	select format('select 1 from public.qorpera_cloud_secrets where id = %L for update', p_secret)
$$;

-- A. Disconnect against an agent call: the holder keeps Ada's grant on A, the call queues for it, then the owner's
--    Disconnect queues for the grants without taking the secret. Before, the Disconnect took the secret first: once the
--    holder ended, the call had the grant and waited for the secret, the Disconnect waited for the grant.
select pg_temp.hold($q$select 1 from public.qorpera_cloud_secret_operation_grants where id = '85000000-0000-4000-8000-0000000000c1' for update$q$);
select dblink_send_query('fence_two', pg_temp.sql_call('85000000-0000-4000-8000-0000000000c1'));
do $$ begin if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A: the call must wait for the holder'; end if; end $$;
select pg_temp.claims('fence_three', '64800000-0000-4000-8000-000000000001');
select dblink_send_query('fence_three', format('select public.qorpera_revoke_cloud_secret(%L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '85000000-0000-4000-8000-0000000000a1'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secret_operation_grants') then
		raise exception 'A: the Disconnect must wait at the grant'; end if;
	if not pg_temp.row_free(pg_temp.sql_secret('85000000-0000-4000-8000-0000000000a1')) then
		raise exception 'A: the Disconnect must not hold the secret while it waits'; end if;
end $$;
select pg_temp.release();
do $$
declare v_call text := pg_temp.outcome('fence_two'); v_disconnect text := pg_temp.outcome('fence_three');
begin
	if v_call <> 'ok' or v_disconnect <> 'ok'
		or (select status from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a1') <> 'revoked'
		or (select status from public.qorpera_cloud_secret_operation_grants where id = '85000000-0000-4000-8000-0000000000c1') <> 'revoked' then
		raise exception 'A: the call % and the Disconnect %', v_call, v_disconnect; end if;
end $$;

-- F. Granting one operation of B to Ada: it takes Ada's staff row (rank 2) before the secret.
select pg_temp.hold($q$select 1 from public.qorpera_profile_staff where profile_id = '64800000-0000-4000-8000-000000000010'
	and staff_agent_id = '64800000-0000-4000-8000-0000000000a1' for update$q$);
select dblink_send_query('fence_three', format('select public.qorpera_grant_cloud_secret_operation(%L, %L, %L, %L, %L, %L, %s)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', '85000000-0000-4000-8000-0000000000a2',
	'64800000-0000-4000-8000-0000000000a1', 'gmail', operation.operation_id, operation.version))
from (select operation.* from public.qorpera_cloud_connector_operations as operation where operation.connector_id = 'gmail'
	and operation.status = 'active' order by operation.operation_id offset 2 limit 1) as operation;
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_profile_staff') then raise exception 'F: the grant must wait at the agent'; end if;
	if not pg_temp.row_free(pg_temp.sql_secret('85000000-0000-4000-8000-0000000000a2')) then
		raise exception 'F: the grant must not hold the secret while it waits'; end if;
end $$;
select pg_temp.release();
do $$
declare v_grant text := pg_temp.outcome('fence_three');
begin
	if v_grant <> 'ok' then raise exception 'F: the grant %', v_grant; end if;
end $$;

-- B. Sharing B with every agent against an agent call on Ada's grant on B: the share takes the grants it may replace
--    before the secret.
select pg_temp.hold($q$select 1 from public.qorpera_cloud_secret_operation_grants where id = '85000000-0000-4000-8000-0000000000c2' for update$q$);
select dblink_send_query('fence_two', pg_temp.sql_call('85000000-0000-4000-8000-0000000000c2'));
do $$ begin if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'B: the call must wait for the holder'; end if; end $$;
select dblink_send_query('fence_three', format('select public.qorpera_grant_cloud_connector(%L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', '85000000-0000-4000-8000-0000000000a2'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secret_operation_grants') then
		raise exception 'B: the share must wait at the grant'; end if;
	if not pg_temp.row_free(pg_temp.sql_secret('85000000-0000-4000-8000-0000000000a2')) then
		raise exception 'B: the share must not hold the secret while it waits'; end if;
end $$;
select pg_temp.release();
do $$
declare v_call text := pg_temp.outcome('fence_two'); v_share text := pg_temp.outcome('fence_three');
begin
	if v_call <> 'ok' or v_share <> 'ok'
		or not (select available_to_all_agents from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a2') then
		raise exception 'B: the call % and the share %', v_call, v_share; end if;
end $$;

-- C. The broker's seal of C's rotation (a company connection, shared on sealing) against an agent call on Ada's grant on
--    C: the seal takes the grants before it updates the secret.
select pg_temp.hold($q$select 1 from public.qorpera_cloud_secret_operation_grants where id = '85000000-0000-4000-8000-0000000000c3' for update$q$);
select dblink_send_query('fence_two', pg_temp.sql_call('85000000-0000-4000-8000-0000000000c3'));
do $$ begin if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'C: the call must wait for the holder'; end if; end $$;
select dblink_exec('fence_three', 'set session authorization qorpera_secret_broker');
select dblink_send_query('fence_three', pg_temp.sql_seal('85000000-0000-4000-8000-0000000000d3'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secret_operation_grants') then
		raise exception 'C: the seal must wait at the grant'; end if;
	if not pg_temp.row_free(pg_temp.sql_secret('85000000-0000-4000-8000-0000000000a3')) then
		raise exception 'C: the seal must not hold the secret while it waits'; end if;
end $$;
select pg_temp.release();
do $$
declare v_call text := pg_temp.outcome('fence_two'); v_seal text := pg_temp.outcome('fence_three');
begin
	if v_call <> 'ok' or v_seal <> 'ok'
		or (select current_version from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a3') <> 2 then
		raise exception 'C: the call % and the seal %', v_call, v_seal; end if;
end $$;

-- D. The broker's seal of D's first capture against the owner demoting its creator, the admin: the seal takes the
--    creator's member row before the ticket, so the demotion waits for it there. Before, the seal waited for the ticket
--    holding nothing, the demotion took the member row and then waited for the ticket: once the holder ended, the seal
--    had the ticket and waited for the member row.
select pg_temp.hold($q$select 1 from public.qorpera_cloud_secret_capture_tickets where id = '85000000-0000-4000-8000-0000000000d4' for update$q$);
select dblink_send_query('fence_three', pg_temp.sql_seal('85000000-0000-4000-8000-0000000000d4'));
do $$ begin if not pg_temp.waits_for('fence_three', 'fence_one') then raise exception 'D: the seal must wait for the holder'; end if; end $$;
select pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000001');
select dblink_send_query('fence_two', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '85000000-0000-4000-8000-000000000003', 'contributor'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_three') or not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') then
		raise exception 'D: the demotion must wait for the seal at the member row'; end if;
end $$;
select pg_temp.release();
do $$
declare v_seal text := pg_temp.outcome('fence_three'); v_demotion text := pg_temp.outcome('fence_two');
begin
	if v_seal <> 'ok' or v_demotion <> 'ok'
		or not exists (select 1 from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a4')
		or (select role::text from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '85000000-0000-4000-8000-000000000003') <> 'contributor' then
		raise exception 'D: the seal % and the demotion %', v_seal, v_demotion; end if;
end $$;
select dblink_exec('fence_three', 'reset session authorization');

-- E. The contributor starts rotating their own connection while the owner removes them: the start takes their member row
--    before the secret, so the removal waits for it there. Before, the start waited for the secret holding nothing, the
--    removal took the member row and then waited for the secret: once the holder ended, the start had the secret and its
--    ticket's membership check waited for the member row.
select pg_temp.hold(pg_temp.sql_secret('85000000-0000-4000-8000-0000000000a5'));
select pg_temp.claims('fence_three', '85000000-0000-4000-8000-000000000004');
select dblink_send_query('fence_three', format('select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, %L, %L, %L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'member', '85000000-0000-4000-8000-000000000004',
	'gmail', 'personal', 'Own mail', '85000000-0000-4000-8000-0000000000a5'));
do $$ begin if not pg_temp.waits_for('fence_three', 'fence_one') then raise exception 'E: the start must wait for the holder'; end if; end $$;
select dblink_send_query('fence_two', format('select public.qorpera_remove_profile_member(%L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '85000000-0000-4000-8000-000000000004'));
do $$
begin
	if not pg_temp.waits_for('fence_two', 'fence_three') or not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') then
		raise exception 'E: the removal must wait for the start at the member row'; end if;
end $$;
select pg_temp.release();
do $$
declare v_start text := pg_temp.outcome('fence_three'); v_removal text := pg_temp.outcome('fence_two');
begin
	if v_start <> 'ok' or v_removal <> 'ok'
		or exists (select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
			and user_id = '85000000-0000-4000-8000-000000000004')
		or (select status from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a5') <> 'revoked'
		or exists (select 1 from public.qorpera_cloud_secret_capture_tickets where secret_id = '85000000-0000-4000-8000-0000000000a5'
			and status = 'pending') then
		raise exception 'E: the start % and the removal %', v_start, v_removal; end if;
end $$;

-- G–J (review round 1): a refusal before any lock, the seal of a first capture, and the NOWAIT re-checks.
-- Every Gmail grant of the company is withdrawn first, so the new connection C' (a7) holds Ada's only two: cf for
-- get_profile and c5 for read_message, whose ids run against their operations. D'' (d6) is a first capture of the
-- company's Gmail "primary" (a6), and a9 is a Gmail connection of the other company.
set session_replication_role = replica;
update public.qorpera_cloud_secret_operation_grants set status = 'revoked', revoked_at = clock_timestamp(),
	revoked_by_user_id = '64800000-0000-4000-8000-000000000001'
where profile_id = '64800000-0000-4000-8000-000000000010' and connector_id = 'gmail' and status = 'active';
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id, connector_id,
	secret_name, purpose, current_version, created_by_user_id)
values
	('85000000-0000-4000-8000-0000000000a7', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
		'85000000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'c', 'Mail C', 1, '64800000-0000-4000-8000-000000000001'),
	('85000000-0000-4000-8000-0000000000a9', '64800000-0000-4000-8000-000000000011', '64800000-0000-4000-8000-000000000021',
		'85000000-0000-4000-8000-0000000000b0', 'company', null, 'gmail', 'primary', 'Other company', 1,
		'64800000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256,
	created_by_user_id)
values ('85000000-0000-4000-8000-0000000000a7', 1, '85000000-0000-4000-8000-0000000000b0', 'test', decode('abcd', 'hex'), repeat('b', 64),
	'64800000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id, connector_id,
	operation_id, operation_version, tool_name, issued_by_user_id)
select grant_row.id, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'85000000-0000-4000-8000-0000000000a7', '64800000-0000-4000-8000-0000000000a1', operation.connector_id, operation.operation_id,
	operation.version, operation.tool_name, '64800000-0000-4000-8000-000000000001'
from (values ('85000000-0000-4000-8000-0000000000cf'::uuid, 'get_profile'), ('85000000-0000-4000-8000-0000000000c5'::uuid, 'read_message'))
	as grant_row(id, operation_id)
join public.qorpera_cloud_connector_operations as operation on operation.connector_id = 'gmail'
	and operation.operation_id = grant_row.operation_id and operation.status = 'active';
insert into public.qorpera_cloud_secret_capture_tickets(id, profile_id, environment_id, broker_authority_id, key_id, secret_id,
	target_version, owner_kind, owner_user_id, connector_id, secret_name, purpose, capture_capability_sha256, created_by_user_id,
	expires_at)
values ('85000000-0000-4000-8000-0000000000d6', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'85000000-0000-4000-8000-0000000000b0', 'test', '85000000-0000-4000-8000-0000000000a6', 1, 'company', null, 'gmail', 'primary',
	'Mail', repeat('7', 64), '64800000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 hour');
set session_replication_role = origin;
create function pg_temp.sql_grant(p_grant uuid) returns text language sql as $$
	select format('select 1 from public.qorpera_cloud_secret_operation_grants where id = %L for update', p_grant)
$$;
-- Waits up to ten seconds for a connection's query to end.
create function pg_temp.settles(p_conn text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '10 seconds';
begin
	while dblink_is_busy(p_conn) = 1 loop
		if clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
	return true;
end $$;

-- H. A share of another company's secret is refused before any lock: it never queues behind an agent's grant. Before,
--    its pre-lock took this company's grants of the secret's connector first, and waited behind any of them.
select pg_temp.hold(pg_temp.sql_grant('85000000-0000-4000-8000-0000000000cf'));
select pg_temp.claims('fence_three', '85000000-0000-4000-8000-000000000003');
select dblink_send_query('fence_three', format('select public.qorpera_grant_cloud_connector(%L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', '85000000-0000-4000-8000-0000000000a9'));
do $$
begin
	if not pg_temp.settles('fence_three') then
		perform pg_temp.release(); raise exception 'H: the refused share must not wait at a grant'; end if;
	if pg_temp.outcome('fence_three') not like 'P0002 %' then raise exception 'H: the share is refused as before'; end if;
end $$;
select pg_temp.release();

-- I. The broker seals D'''s first capture (the company's Gmail, shared on sealing) while the owner disconnects C', whose
--    two grants of Ada's the share replaces. The Disconnect takes them by id (c5, then cf); the holder plays one that has
--    taken c5. The seal now takes them by id too, so it waits at c5 holding nothing. Before, it took Ada's grants by
--    operation (cf before c5), held cf while it waited for c5, and the Disconnect's next lock closed the cycle.
select pg_temp.claims('fence_one', '64800000-0000-4000-8000-000000000001');
select pg_temp.hold(pg_temp.sql_grant('85000000-0000-4000-8000-0000000000c5'));
select dblink_exec('fence_three', 'set session authorization qorpera_secret_broker');
select dblink_send_query('fence_three', pg_temp.sql_seal('85000000-0000-4000-8000-0000000000d6'));
do $$
begin
	if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secret_operation_grants') then
		raise exception 'I: the seal must wait at the grant'; end if;
	if not pg_temp.row_free(pg_temp.sql_grant('85000000-0000-4000-8000-0000000000cf')) then
		raise exception 'I: the seal must take the grants by id, holding none while it waits for c5'; end if;
end $$;
do $$
declare v_disconnect text := 'ok';
begin
	begin
		perform * from dblink('fence_one', format('select public.qorpera_revoke_cloud_secret(%L, %L)::text',
			'64800000-0000-4000-8000-000000000010', '85000000-0000-4000-8000-0000000000a7')) as t(r text);
	exception when others then v_disconnect := sqlstate || ' ' || sqlerrm;
	end;
	if v_disconnect <> 'ok' then perform pg_temp.release(); raise exception 'I: the Disconnect %', v_disconnect; end if;
end $$;
select pg_temp.release();
do $$
declare v_seal text := pg_temp.outcome('fence_three');
begin
	if v_seal <> 'ok'
		or (select status from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a6') is distinct from 'active'
		or (select status from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a7') <> 'revoked' then
		raise exception 'I: the seal %', v_seal; end if;
end $$;
select dblink_exec('fence_three', 'reset session authorization');

-- J. A share of B against a grant it did not pre-lock: while the share waits for B, a grant of Ada's on the new Gmail
--    connection (a6) commits and a holder keeps it, as an agent call would. The share takes it NOWAIT and is refused,
--    retryably, at once. Before, it waited for any grant on another secret.
update public.qorpera_cloud_secret_operation_grants set status = 'revoked', revoked_at = clock_timestamp(),
	revoked_by_user_id = '64800000-0000-4000-8000-000000000001'
where secret_id = '85000000-0000-4000-8000-0000000000a6' and staff_agent_id = '64800000-0000-4000-8000-0000000000a1'
	and operation_id in ('get_profile', 'read_message') and status = 'active';
select pg_temp.hold(pg_temp.sql_secret('85000000-0000-4000-8000-0000000000a2'));
select pg_temp.claims('fence_three', '64800000-0000-4000-8000-000000000001');
select dblink_send_query('fence_three', format('select public.qorpera_grant_cloud_connector(%L, %L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', '85000000-0000-4000-8000-0000000000a2'));
do $$ begin if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secrets') then raise exception 'J: the share must wait at B'; end if; end $$;
create function pg_temp.sql_new_grant(p_id uuid, p_operation text) returns text language sql as $$
	select format($q$insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id,
		connector_id, operation_id, operation_version, tool_name, issued_by_user_id)
	select %L, %L, %L, %L, %L, operation.connector_id, operation.operation_id, operation.version, operation.tool_name, %L
	from public.qorpera_cloud_connector_operations as operation
	where operation.connector_id = 'gmail' and operation.operation_id = %L and operation.status = 'active'$q$,
		p_id, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', '85000000-0000-4000-8000-0000000000a6',
		'64800000-0000-4000-8000-0000000000a1', '64800000-0000-4000-8000-000000000001', p_operation)
$$;
select dblink_exec('fence_four', pg_temp.sql_new_grant('85000000-0000-4000-8000-0000000000c8', 'get_profile'));
select dblink_exec('fence_two', 'begin');
select * from dblink('fence_two', $q$select 1 from public.qorpera_cloud_secret_operation_grants
	where id = '85000000-0000-4000-8000-0000000000c8' for share$q$) as t(x integer);
select pg_temp.release();
do $$
declare v_settled boolean := pg_temp.settles('fence_three'); v_share text;
begin
	perform dblink_exec('fence_two', 'rollback');
	v_share := pg_temp.outcome('fence_three');
	if not v_settled or v_share not like '55P03 %' then raise exception 'J: the share must be refused at once: %', v_share; end if;
end $$;

-- G. A Disconnect of a6 against a grant created on it while the Disconnect waited for the secret (the holder keeps a6
--    FOR NO KEY UPDATE, so the new grant's key check passes): an agent call takes that grant and queues for a6. The
--    Disconnect's re-check takes it NOWAIT once it holds a6 and is refused, retryably; the call lands. Before, the
--    Disconnect waited for the call's grant while the call waited for a6.
select dblink_exec('fence_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
select pg_temp.hold(format('select 1 from public.qorpera_cloud_secrets where id = %L for no key update',
	'85000000-0000-4000-8000-0000000000a6'));
select dblink_send_query('fence_three', format('select public.qorpera_revoke_cloud_secret(%L, %L)::text',
	'64800000-0000-4000-8000-000000000010', '85000000-0000-4000-8000-0000000000a6'));
do $$ begin if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secrets') then raise exception 'G: the Disconnect must wait at a6'; end if; end $$;
select dblink_exec('fence_four', pg_temp.sql_new_grant('85000000-0000-4000-8000-0000000000c9', 'read_message'));
select dblink_send_query('fence_two', pg_temp.sql_call('85000000-0000-4000-8000-0000000000c9'));
do $$ begin if not pg_temp.waits_at('fence_two', 'public.qorpera_cloud_secrets') then raise exception 'G: the call must wait at a6'; end if; end $$;
select pg_temp.release();
do $$
declare v_disconnect text := pg_temp.outcome('fence_three'); v_call text := pg_temp.outcome('fence_two');
begin
	if v_disconnect not like '55P03 %' or v_call <> 'ok'
		or (select status from public.qorpera_cloud_secrets where id = '85000000-0000-4000-8000-0000000000a6') <> 'active' then
		raise exception 'G: the Disconnect % and the call %', v_disconnect, v_call; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 663 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	delete from public.qorpera_cloud_secret_audit_events where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_operation_grants where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_capture_tickets where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_versions where secret_id in
		(select id from public.qorpera_cloud_secrets where profile_id = any (v_profiles));
	delete from public.qorpera_cloud_secrets where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_broker_authorities where id = '85000000-0000-4000-8000-0000000000b0';
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003', '85000000-0000-4000-8000-000000000003', '85000000-0000-4000-8000-000000000004');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_secrets where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_secret_broker_authorities where id = '85000000-0000-4000-8000-0000000000b0') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
