-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company accounts on the company folder (A1-1, A1-7: migration 20260930072000): who waits for an account's rows, and
-- for the company's account claim. 648's committed fixture (Ada's leased run on the folder fence) with the run's
-- acknowledgement, a broker authority, the company's mailbox and Ada's open todo; a connection holds one row (or the
-- claim) while real calls run on others. Waits are seen with pg_blocking_pids and pg_locks, never by wall-clock time; the
-- account functions' own lock_timeout (5 s) ends a wait that would never end, so a regression fails instead of hanging.
-- Everything this test commits goes with its cleanup at the end.
-- 1. A member the removal refuses (a contributor, someone outside the company) is refused at once while the account's
--    secret, or the company row, is held; the owner waits for the secret, then removes.
-- 2. The broker's call for another company's account (its secret or its account row held), or for another kind of
--    secret, is refused without locking it: no wait while that row is held.
-- 3. A removal and the broker's use of one account meet without a deadlock. On the company folder the use's run check
--    takes the company row only KEY SHARE (the old lease took it FOR UPDATE, and the removal's key share first made the
--    use queue there), so the two now meet at rank 8, in one order: the secret, then the account. The removal holds the
--    secret and waits for the account; the use waits for the secret holding neither the account nor its receipt; once
--    the account is let go the removal lands and the use is refused, the account gone.
-- 4. Vault rows before run-owned rows: a held secret makes the broker's use wait before it locks its receipt (the
--    receipt stays free while it waits), and the use lands once the secret is let go.
-- 5. The company's account claim (rank 9): an opening waits for an opening in flight that holds the claim, with its
--    receipt free, and then answers as that one left things: its own receipt's replay, or "already has this account"
--    (never a second account). A writer that took no claim is still caught by the unique indexes, the login's or the vault
--    name's, and their 23505 answers the same refusal.
-- 6. A close that waits for an account's rows while another close (6a) or a member's removal (6b) closes it answers the
--    closed account, after its receipt, never a refusal; nothing is closed twice.

-- The switch and the mail domain go back to what they were at the end.
select set_config('qorpera_test.cl_enabled', (select enabled::text from public.qorpera_company_account_settings), false)
\g /dev/null
select set_config('qorpera_test.cl_domain', coalesce((select domain from public.qorpera_mail_settings), ''), false) \g /dev/null
update public.qorpera_company_account_settings set enabled = true;
update public.qorpera_mail_settings set domain = 'nordlys.example';

-- The run's acknowledgement, as a progress send and its session event (the wake's work gate reads both; as 651's), the
-- company's mailbox 'locks' (its hook is not this test's), and Ada's open todo.
set session_replication_role = replica;
insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, event_hash, created_at,
	execution_kind, execution_id, execution_claimant_id, runner_assignment_id)
values ('64800000-0000-4000-8000-0000000000f7', 1, '64800000-0000-4000-8000-0000000000fa', 'message', '64800000-0000-4000-8000-000000000002',
	'{"schema":"qorpera.runner-transcript-entry/v1"}', repeat('0', 64), statement_timestamp(), 'run', '64800000-0000-4000-8000-0000000000f1',
	'64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f5');
insert into public.qorpera_agent_sends(event_id, run_id, session_id, assignment_id, idempotency_key, phase, text_sha256, body_sha256)
values ('64800000-0000-4000-8000-0000000000fa', '64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f7',
	'64800000-0000-4000-8000-0000000000f5', 'ack', 'progress', repeat('1', 64), repeat('2', 64));
insert into public.qorpera_company_mailboxes(hook_id, profile_id, environment_id, local_part)
values ('79700000-0000-4000-8000-000000000090', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'locks');
insert into public.qorpera_runtime_agent_todos(id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
	requested_by_user_id, created_by_run_id, updated_by_run_id)
values ('79700000-0000-4000-8000-000000000060', '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'64800000-0000-4000-8000-0000000000a1', 'sign-up', 'Sign up for hosting', 'open', '64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-0000000000f1', '64800000-0000-4000-8000-0000000000f1');
set session_replication_role = origin;

-- The broker authorities: the run's company's, and the snapshot control company's (64…11, another company).
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('79700000-0000-4000-8000-000000000040', '64800000-0000-4000-8000-000000000010', 'https://broker.example.test', 'company-kek-1',
		repeat('7', 64)),
	('79700000-0000-4000-8000-000000000041', '64800000-0000-4000-8000-000000000011', 'https://broker.example.test', 'other-kek-1',
		repeat('6', 64));

-- Accounts: three of the run's company (races 1, 3 and 4), the other company's, and a Gmail secret.
create function pg_temp.cl_account(p_id uuid, p_profile uuid, p_environment uuid, p_authority uuid, p_key text,
	p_connector text, p_login text, p_by uuid) returns void language plpgsql as $$
begin
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
		connector_id, secret_name, purpose, current_version, created_by_user_id)
	values (p_id, p_profile, p_environment, p_authority, 'company', null, p_connector,
		case p_connector when 'website' then 'site-' || right(p_id::text, 8) else 'primary' end, 'Account', 1, p_by);
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (p_id, 1, p_authority, p_key, '\x0102'::bytea, encode(extensions.digest('\x0102'::bytea, 'sha256'), 'hex'), p_by);
	if p_connector = 'website' then
		insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, opened_by_user_id)
		values (p_id, p_profile, p_environment, 'vercel.com', p_login, p_by);
	end if;
end
$$;
select pg_temp.cl_account(account.id, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020',
	'79700000-0000-4000-8000-000000000040', 'company-kek-1', account.connector, account.login,
	'64800000-0000-4000-8000-000000000001')
from (values ('79700000-0000-4000-8000-000000000050'::uuid, 'website', 'race-one@nordlys.example'),
	('79700000-0000-4000-8000-000000000051'::uuid, 'website', 'race-three@nordlys.example'),
	('79700000-0000-4000-8000-000000000054'::uuid, 'website', 'race-four@nordlys.example'),
	('79700000-0000-4000-8000-000000000053'::uuid, 'gmail', '')) as account(id, connector, login);
select pg_temp.cl_account('79700000-0000-4000-8000-000000000052', '64800000-0000-4000-8000-000000000011',
	'64800000-0000-4000-8000-000000000021', '79700000-0000-4000-8000-000000000041', 'other-kek-1', 'website',
	'team@other.example', '64800000-0000-4000-8000-000000000003');

-- The run's tool call begins (committed, so the other connections see it) and finishes its receipt.
create function pg_temp.cl_receipt(p_id uuid, p_key text) returns void language plpgsql as $$
begin
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb,
		p_id, p_key, repeat('a', 64), repeat('b', 64), false);
end
$$;
create function pg_temp.cl_done(p_id uuid) returns void language plpgsql as $$
begin
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.binding')::jsonb,
		p_id, repeat('a', 64), '{}'::jsonb);
end
$$;
-- A connection acts as a member (PostgREST's role and claims) or, with no claims, as the broker's own login.
create function pg_temp.cl_as(p_conn text, p_claims jsonb) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'reset session authorization');
	perform dblink_exec(p_conn, 'reset role');
	if p_claims is null then
		perform dblink_exec(p_conn, 'set session authorization qorpera_secret_broker');
	else
		perform dblink_exec(p_conn, format('set request.jwt.claims = %L', p_claims::text));
		perform dblink_exec(p_conn, format('set role %I', p_claims ->> 'role'));
	end if;
end
$$;
create function pg_temp.cl_member(p_user text) returns jsonb language sql as $$
	select jsonb_build_object('role', 'authenticated', 'sub', p_user)
$$;
create function pg_temp.cl_use(p_receipt uuid, p_account uuid) returns text language sql as $$
	select format('select public.qorpera_use_company_account(%L, %L, %L::jsonb, %L, repeat(''a'', 64), repeat(''b'', 64), %L)::text',
		'79700000-0000-4000-8000-000000000040', repeat('7', 64), current_setting('qorpera_test.binding'), p_receipt, p_account)
$$;
create function pg_temp.cl_open(p_receipt uuid, p_secret uuid, p_site text, p_login text) returns text language sql as $$
	select format('select public.qorpera_open_company_account(%L, %L, %L::jsonb, %L, repeat(''a'', 64), repeat(''b'', 64), %L, %L, %L, '
		'%L, ''{}''::text[], %L, ''Hosting'', %L, ''company-kek-1'', ''\x0102''::bytea, %L)::text',
		'79700000-0000-4000-8000-000000000040', repeat('7', 64), current_setting('qorpera_test.binding'), p_receipt, p_secret,
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', p_site, p_login,
		'79700000-0000-4000-8000-000000000060', encode(extensions.digest('\x0102'::bytea, 'sha256'), 'hex'))
$$;
create function pg_temp.cl_state(p_receipt uuid, p_account uuid, p_status text) returns text language sql as $$
	select format('select public.qorpera_set_company_account_state(%L, %L, %L::jsonb, %L, repeat(''a'', 64), repeat(''b'', 64), %L, %L)::text',
		'79700000-0000-4000-8000-000000000040', repeat('7', 64), current_setting('qorpera_test.binding'), p_receipt, p_account,
		p_status)
$$;
create function pg_temp.cl_remove(p_account uuid) returns text language sql as $$
	select format('select public.qorpera_remove_company_account(''64800000-0000-4000-8000-000000000010'', %L)::text', p_account)
$$;
-- A sent call's answer: 'ok:<result>' or '<sqlstate>:<message>'; the connection is ready again afterwards.
create function pg_temp.cl_result(p_conn text) returns text language plpgsql as $$
declare v text; v_out text;
begin
	begin
		select r into v from dblink_get_result(p_conn) as t(r text);
		v_out := 'ok:' || coalesce(v, '');
	exception when others then v_out := sqlstate || ':' || sqlerrm;
	end;
	begin perform * from dblink_get_result(p_conn) as t(r text); exception when others then null; end;
	return v_out;
end
$$;
-- Whether a waiting connection holds or queues for a row's tuple lock of a table (665's), or waits for an advisory lock.
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '30 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.waits_on_advisory(p_conn text) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '30 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'advisory' and not granted) then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- Whether a receipt is free: a NOWAIT lock on fence_four, released at once.
create function pg_temp.receipt_free(p_receipt uuid) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', format('select 1 from public.qorpera_run_operation_receipts where id = %L for update nowait',
		p_receipt)) as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
create function pg_temp.cl_check(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if p_ok is distinct from true then raise exception '%', p_message; end if;
end
$$;
-- The holder (fence_one) keeps one row, or the claim, in a transaction of its own (a lock statement's row is read and
-- dropped; writes go through dblink_exec).
create function pg_temp.hold(p_sql text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	if p_sql ~* '^\s*select\M' then
		perform * from dblink('fence_one', p_sql) as t(x text);
	else
		perform dblink_exec('fence_one', p_sql);
	end if;
end $$;
select dblink_exec(name, 'set lock_timeout = ''10s''') from unnest(array['fence_one','fence_two','fence_three','fence_four']) name
\g /dev/null

-- 1. The removal refuses a contributor and an outsider without waiting for the held secret, or for the held company row;
--    the owner waits for the secret, then removes.
do $$
declare v_who record; v_hold text; v_out text;
begin
	foreach v_hold in array array[
		'select 1 from public.qorpera_cloud_secrets where id = ''79700000-0000-4000-8000-000000000050'' for update',
		'select 1 from public.qorpera_profiles where id = ''64800000-0000-4000-8000-000000000010'' for update'] loop
		for v_who in select * from (values ('contributor', '64800000-0000-4000-8000-000000000002'),
			('outsider', '64800000-0000-4000-8000-000000000003')) as who(name, id) loop
			perform pg_temp.hold(v_hold);
			perform pg_temp.cl_as('fence_two', pg_temp.cl_member(v_who.id));
			perform dblink_send_query('fence_two', pg_temp.cl_remove('79700000-0000-4000-8000-000000000050'));
			if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
				perform dblink_exec('fence_one', 'rollback');
				raise exception 'Race 1: the % waited for % before being refused', v_who.name, v_hold; end if;
			v_out := pg_temp.cl_result('fence_two');
			perform dblink_exec('fence_one', 'rollback');
			perform pg_temp.cl_check(v_out = '42501:company account removal is unavailable',
				format('Race 1: the %s was not refused: %s', v_who.name, v_out));
		end loop;
	end loop;
	perform pg_temp.hold('select 1 from public.qorpera_cloud_secrets where id = ''79700000-0000-4000-8000-000000000050'' for update');
	perform pg_temp.cl_as('fence_two', pg_temp.cl_member('64800000-0000-4000-8000-000000000001'));
	perform dblink_send_query('fence_two', pg_temp.cl_remove('79700000-0000-4000-8000-000000000050'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 1: the owner did not wait for the held secret'; end if;
	perform dblink_exec('fence_one', 'rollback');
	v_out := pg_temp.cl_result('fence_two');
	perform pg_temp.cl_check(v_out like 'ok:%"removed": true%', 'Race 1: the owner did not remove: ' || v_out);
end $$;

-- 2. The broker's call for another company's account, or a Gmail secret, locks neither: no wait while each is held.
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000101', 'company_account:use:79700000-0000-4000-8000-000000000052:r1');
select pg_temp.cl_as('fence_two', null);
do $$
declare v_hold text; v_out text;
begin
	foreach v_hold in array array[
		'select 1 from public.qorpera_cloud_secrets where id = ''79700000-0000-4000-8000-000000000052'' for update',
		'select 1 from public.qorpera_company_accounts where secret_id = ''79700000-0000-4000-8000-000000000052'' for update'] loop
		perform pg_temp.hold(v_hold);
		perform dblink_send_query('fence_two', pg_temp.cl_use('79700000-0000-4000-8000-000000000101',
			'79700000-0000-4000-8000-000000000052'));
		if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
			perform dblink_exec('fence_one', 'rollback');
			raise exception 'Race 2: the broker waited for another company''s account (%)', v_hold; end if;
		v_out := pg_temp.cl_result('fence_two');
		perform dblink_exec('fence_one', 'rollback');
		perform pg_temp.cl_check(v_out = '22023:The company has no such open account',
			'Race 2: the broker used another company''s account: ' || v_out);
	end loop;
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000101');
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000102', 'company_account:use:79700000-0000-4000-8000-000000000053:r2');
do $$
declare v_out text;
begin
	perform pg_temp.hold('select 1 from public.qorpera_cloud_secrets where id = ''79700000-0000-4000-8000-000000000053'' for update');
	perform dblink_send_query('fence_two', pg_temp.cl_use('79700000-0000-4000-8000-000000000102',
		'79700000-0000-4000-8000-000000000053'));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 2: the broker waited for a Gmail secret'; end if;
	v_out := pg_temp.cl_result('fence_two');
	perform dblink_exec('fence_one', 'rollback');
	perform pg_temp.cl_check(v_out = '22023:The company has no such open account', 'Race 2: the broker used a Gmail secret: ' || v_out);
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000102');

-- 3. A removal and the broker's use of one account. The holder keeps the account row; the owner's removal (the fence, the
--    company row and the member KEY SHARE, then the secret) waits for it there; the use (its run check passes beside the
--    removal's key shares) waits for the secret, holding neither the account nor its receipt. The holder lets go: the
--    removal lands, and the use is refused because the account is gone. Neither is killed as a deadlock.
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000103', 'company_account:use:79700000-0000-4000-8000-000000000051:r3');
do $$
declare v_removal text; v_use text;
begin
	perform pg_temp.hold('select 1 from public.qorpera_company_accounts where secret_id = ''79700000-0000-4000-8000-000000000051'' for update');
	perform pg_temp.cl_as('fence_two', pg_temp.cl_member('64800000-0000-4000-8000-000000000001'));
	perform dblink_send_query('fence_two', pg_temp.cl_remove('79700000-0000-4000-8000-000000000051'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_company_accounts') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 3: the removal did not wait at the held account: %', pg_temp.cl_result('fence_two'); end if;
	perform pg_temp.cl_as('fence_three', null);
	perform dblink_send_query('fence_three', pg_temp.cl_use('79700000-0000-4000-8000-000000000103',
		'79700000-0000-4000-8000-000000000051'));
	if not pg_temp.waits_for('fence_three', 'fence_two') or not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 3: the use did not wait for the removal at the secret: % / %', pg_temp.cl_result('fence_two'),
			pg_temp.cl_result('fence_three'); end if;
	if not pg_temp.receipt_free('79700000-0000-4000-8000-000000000103') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 3: the use holds its receipt while it waits for the secret'; end if;
	perform dblink_exec('fence_one', 'rollback');
	v_removal := pg_temp.cl_result('fence_two');
	v_use := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_removal like 'ok:%"removed": true%' and v_use = '22023:The company has no such open account',
		format('Race 3: a removal and a use of one account did not both land: %s / %s', v_removal, v_use));
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000103');

-- 4. A held secret: the broker's use waits for it before it locks its receipt, and lands once it is let go.
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000104', 'company_account:use:79700000-0000-4000-8000-000000000054:r4');
do $$
declare v_use text;
begin
	perform pg_temp.hold('select 1 from public.qorpera_cloud_secrets where id = ''79700000-0000-4000-8000-000000000054'' for update');
	perform dblink_send_query('fence_three', pg_temp.cl_use('79700000-0000-4000-8000-000000000104',
		'79700000-0000-4000-8000-000000000054'));
	if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 4: the use did not wait at the held secret: %', pg_temp.cl_result('fence_three'); end if;
	if not pg_temp.receipt_free('79700000-0000-4000-8000-000000000104') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 4: the use locked its receipt before the vault rows'; end if;
	perform dblink_exec('fence_one', 'rollback');
	v_use := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_use like 'ok:%"receiptId": "79700000-0000-4000-8000-000000000104"%',
		'Race 4: the use did not land once the secret was let go: ' || v_use);
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000104');

-- 5. The company's account claim. The holder plays an opening in flight: it takes the claim (the same key the opening
--    builds) and, for 5b, writes its own account.
create function pg_temp.sql_claim() returns text language sql as $$
	select format('select pg_advisory_xact_lock(hashtextextended(%L, 0))',
		'qorpera.company-accounts:' || '64800000-0000-4000-8000-000000000010')
$$;
create function pg_temp.sql_held_account(p_secret uuid, p_name text, p_site text, p_login text) returns text language sql as $$
	select format('insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
			connector_id, secret_name, purpose, current_version, created_by_user_id)
		values (%1$L, %2$L, %3$L, %4$L, ''company'', ''website'', %5$L, ''Held'', 1, %6$L)', p_secret,
			'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', '79700000-0000-4000-8000-000000000040',
			p_name, '64800000-0000-4000-8000-000000000001')
		|| case when p_login is null then '' else format('; insert into public.qorpera_company_accounts(secret_id, profile_id,
			environment_id, site, login, opened_by_user_id) values (%L, %L, %L, %L, %L, %L)', p_secret,
			'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', p_site, p_login,
			'64800000-0000-4000-8000-000000000001') end
$$;

-- 5a. The replay: an opening that lost its answer repeats while another opening holds the claim. It waits at the claim
--     with its receipt free, then answers the account its receipt opened (not a second one, though it drew a new id).
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000105', 'company_account:open:r5');
select set_config('qorpera_test.cl_opened', (select r from dblink('fence_three', pg_temp.cl_open('79700000-0000-4000-8000-000000000105',
	'79700000-0000-4000-8000-000000000205', 'vercel.com', 'locks+vercel.com@nordlys.example')) as t(r text)), false) \g /dev/null
do $$
declare v_replay text;
begin
	perform pg_temp.hold(pg_temp.sql_claim());
	perform dblink_send_query('fence_three', pg_temp.cl_open('79700000-0000-4000-8000-000000000105',
		'79700000-0000-4000-8000-000000000295', 'vercel.com', 'locks+vercel.com@nordlys.example'));
	if not pg_temp.waits_on_advisory('fence_three') or not pg_temp.waits_for('fence_three', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 5a: the repeated opening did not wait at the claim: %', pg_temp.cl_result('fence_three'); end if;
	if not pg_temp.receipt_free('79700000-0000-4000-8000-000000000105') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 5a: the opening locked its receipt before the claim'; end if;
	perform dblink_exec('fence_one', 'rollback');
	v_replay := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_replay = 'ok:' || current_setting('qorpera_test.cl_opened')
			and current_setting('qorpera_test.cl_opened') like '%"accountId": "79700000-0000-4000-8000-000000000205"%'
			and not exists (select 1 from public.qorpera_cloud_secrets where id = '79700000-0000-4000-8000-000000000295'),
		format('Race 5a: the replay did not answer its account: %s (first %s)', v_replay, current_setting('qorpera_test.cl_opened')));
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000105');

-- 5b. Already open: the holder's opening writes the account for a login under the claim; a second opening of that
--     login waits at the claim, then answers "already has this account".
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000106', 'company_account:open:r6');
do $$
declare v_open text;
begin
	perform pg_temp.hold(pg_temp.sql_claim());
	perform dblink_exec('fence_one', pg_temp.sql_held_account('79700000-0000-4000-8000-000000000256', 'held-netlify',
		'netlify.com', 'locks+netlify.com@nordlys.example'));
	perform dblink_send_query('fence_three', pg_temp.cl_open('79700000-0000-4000-8000-000000000106',
		'79700000-0000-4000-8000-000000000206', 'netlify.com', 'Locks+Netlify.com@nordlys.example'));
	if not pg_temp.waits_on_advisory('fence_three') or not pg_temp.waits_for('fence_three', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 5b: the second opening did not wait at the claim: %', pg_temp.cl_result('fence_three'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_open := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_open = '23505:The company already has this account; use it'
			and not exists (select 1 from public.qorpera_cloud_secrets where id = '79700000-0000-4000-8000-000000000206'),
		'Race 5b: the second opening of one login did not answer "already has this account": ' || v_open);
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000106');

-- 5c. A writer that took no claim holds a login: the opening's plain check cannot see its row, so the opening inserts and
--     waits at the login's unique index; once the writer commits, the index's 23505 answers the duplicate's refusal.
--     5d: the same for a vault name (the website's own name, held by a secret without an account).
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000107', 'company_account:open:r7');
do $$
declare v_open text;
begin
	perform pg_temp.hold(pg_temp.sql_held_account('79700000-0000-4000-8000-000000000257', 'held-render',
		'render.com', 'locks+render.com@nordlys.example'));
	perform dblink_send_query('fence_three', pg_temp.cl_open('79700000-0000-4000-8000-000000000107',
		'79700000-0000-4000-8000-000000000207', 'render.com', 'locks+render.com@nordlys.example'));
	if not pg_temp.waits_for('fence_three', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 5c: the opening did not wait at the login''s index: %', pg_temp.cl_result('fence_three'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_open := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_open = '23505:The company already has this account; use it'
			and not exists (select 1 from public.qorpera_cloud_secrets where id = '79700000-0000-4000-8000-000000000207'),
		'Race 5c: the login''s unique index did not answer the duplicate''s refusal: ' || v_open);
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000107');
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000108', 'company_account:open:r8');
do $$
declare v_open text;
begin
	perform pg_temp.hold(pg_temp.sql_held_account('79700000-0000-4000-8000-000000000258', 'fly-io', null, null));
	perform dblink_send_query('fence_three', pg_temp.cl_open('79700000-0000-4000-8000-000000000108',
		'79700000-0000-4000-8000-000000000208', 'fly.io', 'locks+fly.io@nordlys.example'));
	if not pg_temp.waits_for('fence_three', 'fence_one') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 5d: the opening did not wait at the vault name''s index: %', pg_temp.cl_result('fence_three'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_open := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_open = '23505:The company already has this account; use it'
			and not exists (select 1 from public.qorpera_cloud_secrets where id = '79700000-0000-4000-8000-000000000208'),
		'Race 5d: the vault name''s unique index did not answer the duplicate''s refusal: ' || v_open);
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000108');

select pg_temp.cl_check(not exists (select 1 from public.qorpera_cloud_secret_versions where secret_id in
		('79700000-0000-4000-8000-000000000050','79700000-0000-4000-8000-000000000051'))
	and (select count(*) from public.qorpera_company_accounts where status = 'closed'
		and secret_id in ('79700000-0000-4000-8000-000000000050','79700000-0000-4000-8000-000000000051')) = 2
	and (select count(*) from public.qorpera_company_accounts where profile_id = '64800000-0000-4000-8000-000000000010'
		and status <> 'closed') = 4,
	'The removed accounts kept envelopes or stayed open, or a race left a second account');

-- 6. Closes that meet. 6a: the holder plays another close in flight (it revokes the secret, which closes the account
--    through the revoke trigger, and keeps its transaction open); the broker's close of the same account passed its plain
--    read while the account was still open, so it waits for the secret, then finds the account closed and answers it.
--    6b: the holder keeps the account row; the owner's removal takes the secret and waits for the account; the broker's
--    close waits for the secret behind it; the holder lets go, the removal lands, and the close answers the closed account.
select pg_temp.cl_account('79700000-0000-4000-8000-000000000055', '64800000-0000-4000-8000-000000000010',
	'64800000-0000-4000-8000-000000000020', '79700000-0000-4000-8000-000000000040', 'company-kek-1', 'website',
	'race-six@nordlys.example', '64800000-0000-4000-8000-000000000001');
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000111', 'company_account:state:79700000-0000-4000-8000-000000000054:r6a');
do $$
declare v_close text;
begin
	perform pg_temp.hold($q$update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(),
		updated_at = statement_timestamp() where id = '79700000-0000-4000-8000-000000000054'$q$);
	perform dblink_send_query('fence_three', pg_temp.cl_state('79700000-0000-4000-8000-000000000111',
		'79700000-0000-4000-8000-000000000054', 'closed'));
	if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 6a: the close did not wait at the secret another close holds: %', pg_temp.cl_result('fence_three'); end if;
	if not pg_temp.receipt_free('79700000-0000-4000-8000-000000000111') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 6a: the close locked its receipt before the vault rows'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_close := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_close like 'ok:%"status": "closed"%' and v_close like '%"accountId": "79700000-0000-4000-8000-000000000054"%',
		'Race 6a: a close that waited while another closed the account was not answered the closed account: ' || v_close);
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000111');
select pg_temp.cl_as('fence_two', pg_temp.cl_member('64800000-0000-4000-8000-000000000001'));
select pg_temp.cl_receipt('79700000-0000-4000-8000-000000000112', 'company_account:state:79700000-0000-4000-8000-000000000055:r6b');
do $$
declare v_remove text; v_close text;
begin
	perform pg_temp.hold('select 1 from public.qorpera_company_accounts where secret_id = ''79700000-0000-4000-8000-000000000055'' for update');
	perform dblink_send_query('fence_two', pg_temp.cl_remove('79700000-0000-4000-8000-000000000055'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_company_accounts') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 6b: the removal did not wait at the held account: %', pg_temp.cl_result('fence_two'); end if;
	perform dblink_send_query('fence_three', pg_temp.cl_state('79700000-0000-4000-8000-000000000112',
		'79700000-0000-4000-8000-000000000055', 'closed'));
	if not pg_temp.waits_at('fence_three', 'public.qorpera_cloud_secrets') then
		perform dblink_exec('fence_one', 'rollback');
		raise exception 'Race 6b: the close did not wait at the secret the removal holds: %', pg_temp.cl_result('fence_three'); end if;
	perform dblink_exec('fence_one', 'rollback');
	v_remove := pg_temp.cl_result('fence_two');
	v_close := pg_temp.cl_result('fence_three');
	perform pg_temp.cl_check(v_remove like 'ok:%', 'Race 6b: the removal did not land: ' || v_remove);
	perform pg_temp.cl_check(v_close like 'ok:%"status": "closed"%' and v_close like '%"accountId": "79700000-0000-4000-8000-000000000055"%',
		'Race 6b: a close that waited behind a removal was not answered the closed account: ' || v_close);
end $$;
select pg_temp.cl_done('79700000-0000-4000-8000-000000000112');
-- Each account was closed once: by the other close (no state change of the waiting close's) or by the removal (its
-- remover recorded); no envelope is left.
select pg_temp.cl_check(not exists (select 1 from public.qorpera_cloud_secret_audit_events where event_type = 'account_state_changed'
		and receipt_id in ('79700000-0000-4000-8000-000000000111', '79700000-0000-4000-8000-000000000112'))
	and (select count(*) from public.qorpera_company_accounts where status = 'closed' and closed_at is not null
		and secret_id in ('79700000-0000-4000-8000-000000000054', '79700000-0000-4000-8000-000000000055')) = 2
	and (select removed_by_user_id from public.qorpera_company_accounts where secret_id = '79700000-0000-4000-8000-000000000055')
		= '64800000-0000-4000-8000-000000000001'
	and not exists (select 1 from public.qorpera_cloud_secret_versions where secret_id in
		('79700000-0000-4000-8000-000000000054', '79700000-0000-4000-8000-000000000055')),
	'Race 6: an account was closed twice, kept its envelopes, or lost its remover');

select dblink_exec(name, 'reset session authorization') from unnest(array['fence_two','fence_three']) name \g /dev/null
select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name \g /dev/null

-- Remove the fixture and what this test committed (as 850 does), and put the switch and the mail domain back.
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
	delete from public.qorpera_cloud_secret_versions where secret_id in
		(select id from public.qorpera_cloud_secrets where profile_id = any (v_profiles));
	delete from public.qorpera_company_accounts where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secrets where profile_id = any (v_profiles);
	delete from public.qorpera_cloud_secret_broker_authorities
	where id in ('79700000-0000-4000-8000-000000000040', '79700000-0000-4000-8000-000000000041');
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
update public.qorpera_company_account_settings set enabled = current_setting('qorpera_test.cl_enabled')::boolean;
update public.qorpera_mail_settings set domain = nullif(current_setting('qorpera_test.cl_domain'), '');
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_cloud_secrets where profile_id in ('64800000-0000-4000-8000-000000000010',
			'64800000-0000-4000-8000-000000000011'))
		or exists (select 1 from public.qorpera_company_accounts where profile_id in ('64800000-0000-4000-8000-000000000010',
			'64800000-0000-4000-8000-000000000011'))
		or exists (select 1 from public.qorpera_company_mailboxes where hook_id = '79700000-0000-4000-8000-000000000090')
		or exists (select 1 from public.qorpera_cloud_secret_broker_authorities
			where id in ('79700000-0000-4000-8000-000000000040', '79700000-0000-4000-8000-000000000041')) then
		raise exception 'The race fixture must be removed'; end if;
end $$;
