-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- F3 step 5j-6a (migration 20260930440000): MCP sign-ins for coding sessions and the running session's repository
-- fetch, on 928's base: Alice's coding session for the owner, on Qorpera/Qorpera_Base, claimed by executor exec-530.
-- The sign-ins go through real captures (begin as a member, complete as the broker).
-- 1. The origin, the header and the name; the record's own checks.
-- 2. Starting a sign-in: who may, and what is refused before anything is written.
-- 3. Completing one: only with the record its begin wrote; a rotation; one active sign-in per owner and origin.
-- 4. The members' list.
-- 5. The broker's read: the company's for the origin, else the session member's own; never another member's; none
--    for an origin without one. The lease, the phase and the refusals, each writing nothing. Disconnect and removal.
-- 6. The broker's repository fetch while the session runs.
-- 7. The patched bodies name the migration; only the secret broker reads, only members begin and list.

select pg_temp.base_claims('service_role');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('53000000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
-- Another company's broker, for 5.
set local session_replication_role = replica;
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('53000000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
set local session_replication_role = origin;
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('53000000-0000-4000-8000-000000000041', '53000000-0000-4000-8000-000000000011', 'https://broker.example.test',
	'company-kek-1', repeat('8', 64));

-- Alice's session on Qorpera/Qorpera_Base for the owner, claimed by exec-530 (as 528 sets up its own).
do $$
declare v_claim jsonb;
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-530', true,
		array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	perform pg_temp.base_assert(pg_temp.c3_dispatch(pg_temp.c3_alice(), 'mcp-dispatch-530',
		'QorperaOS/agents/alice/todos/fix-login/session-530', pg_temp.c3_brief('53000000-0000-4000-8000-0000000000b1'))
		-> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch');
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner,
		machine_id_sha256, binding)
	values ('53000000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-530', repeat('8', 64),
		'{}');
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-530', 300);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '53000000-0000-4000-8000-0000000000b1'
		and (pg_temp.c3_worker('53000000-0000-4000-8000-0000000000b1')).owner_user_id
			= '92400000-0000-4000-8000-000000000001',
		'the owner''s session is claimed: ' || coalesce(v_claim::text, 'none'));
	perform set_config('qorpera_test.mcp_worker', v_claim ->> 'workerId', true);
	perform set_config('qorpera_test.mcp_lease', v_claim ->> 'leaseToken', true);
end $$;

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.mcp_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.mcp_try(text) to qorpera_secret_broker, authenticated;
-- A statement that answers nothing, as 'ok' or '<sqlstate>'.
create function pg_temp.mcp_do(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then
	return sqlstate;
end $$;
create function pg_temp.mcp_member(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.mcp_try(p_sql);
	reset role;
	return v;
end $$;
-- A call as the secret broker.
create function pg_temp.mcp_broker(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform set_config('request.jwt.claims', '{}', true);
	execute 'set local session authorization qorpera_secret_broker';
	v := pg_temp.mcp_try(p_sql);
	execute 'reset session authorization';
	return v;
end $$;
-- A member starts a sign-in in the fixture's company and environment.
create function pg_temp.mcp_begin(p_user uuid, p_owner_kind text, p_origin text,
	p_header text default 'authorization', p_prefix text default 'Bearer ')
returns text language sql as $$
	select pg_temp.mcp_member(p_user, format('select public.qorpera_begin_coding_mcp_sign_in(%L, %L, %L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_owner_kind, p_origin,
		p_header, p_prefix))
$$;
-- A member starts a plain capture under the connector mcp (a new secret, or a rotation of p_secret).
create function pg_temp.mcp_capture(p_user uuid, p_owner_kind text, p_name text, p_secret uuid default null)
returns text language sql as $$
	select pg_temp.mcp_member(p_user, format(
		'select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, %L, %L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_owner_kind,
		case when p_owner_kind = 'member' then p_user end, 'mcp', p_name, 'A plain capture', p_secret))
$$;
-- The broker seals a started capture with the envelope 'mcp envelope <tag>'.
create function pg_temp.mcp_envelope(p_tag text) returns bytea language sql immutable as $$
	select convert_to('mcp envelope ' || p_tag, 'UTF8')
$$;
create function pg_temp.mcp_complete(p_capture text, p_tag text) returns text language sql as $$
	select pg_temp.mcp_broker(format(
		'select public.qorpera_complete_cloud_secret_capture(%L, %L, %L, %L, %L, %L, null)',
		'53000000-0000-4000-8000-000000000040', repeat('9', 64), substring(p_capture from 4)::jsonb ->> 'ticketId',
		encode(extensions.digest(substring(p_capture from 4)::jsonb ->> 'captureCapability', 'sha256'), 'hex'),
		encode(pg_temp.mcp_envelope(p_tag), 'base64'),
		encode(extensions.digest(pg_temp.mcp_envelope(p_tag), 'sha256'), 'hex')))
$$;
create function pg_temp.mcp_authorize(p_worker uuid, p_lease uuid, p_origin text, p_owner text default 'exec-530',
	p_authority uuid default '53000000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language sql as $$
	select pg_temp.mcp_broker(format('select public.qorpera_authorize_coding_mcp_sign_in(%L, %L, %L, %L, %L, %L)',
		p_authority, p_capability, p_worker, p_lease, p_owner, p_origin))
$$;
-- The broker's read for the claimed session, as the executor's lease gives it.
create function pg_temp.mcp_now(p_origin text) returns text language sql as $$
	select pg_temp.mcp_authorize(current_setting('qorpera_test.mcp_worker')::uuid,
		current_setting('qorpera_test.mcp_lease')::uuid, p_origin)
$$;
-- Whose sign-in a read served (company, member or none); a refusal as it is.
create function pg_temp.mcp_served(p_result text) returns text language sql as $$
	select case when p_result like 'ok:%'
		then coalesce(substring(p_result from 4)::jsonb -> 'signIn' ->> 'ownerKind', 'none') else p_result end
$$;
create function pg_temp.mcp_fetch(p_worker uuid, p_lease uuid, p_owner text default 'exec-530',
	p_authority uuid default '53000000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language sql as $$
	select pg_temp.mcp_broker(format('select public.qorpera_authorize_coding_repository_fetch(%L, %L, %L, %L, %L)',
		p_authority, p_capability, p_worker, p_lease, p_owner))
$$;
-- The fetch for the claimed session: the secret it served (its last two digits), or the refusal.
create function pg_temp.mcp_fetch_now() returns text language sql as $$
	select case when v like 'ok:%' then right(substring(v from 4)::jsonb ->> 'secretId', 2) else v end
	from (select pg_temp.mcp_fetch(current_setting('qorpera_test.mcp_worker')::uuid,
		current_setting('qorpera_test.mcp_lease')::uuid) as v) as call
$$;
-- What p_call answers after a change (made with the triggers off), which is then undone with everything p_call wrote.
create function pg_temp.mcp_after(p_change text, p_call text) returns text language plpgsql as $$
declare v text;
begin
	perform set_config('session_replication_role', 'replica', true);
	execute p_change;
	perform set_config('session_replication_role', 'origin', true);
	execute p_call into v;
	raise exception using errcode = 'QE530', message = v;
exception when sqlstate 'QE530' then
	return sqlerrm;
end $$;
create function pg_temp.mcp_used(p_type text) returns bigint language sql as $$
	select count(*) from public.qorpera_cloud_secret_audit_events
	where profile_id = '92400000-0000-4000-8000-000000000010' and event_type = p_type
$$;
-- A member's list, as origin/ownerKind/version in the answer's order; a refusal as it is.
create function pg_temp.mcp_listed(p_user uuid) returns text language sql as $$
	select case when v like 'ok:%' then coalesce((
		select string_agg((e ->> 'origin') || '/' || (e ->> 'ownerKind') || '/' || (e ->> 'version'), ',' order by n)
		from jsonb_array_elements(substring(v from 4)::jsonb) with ordinality as s(e, n)), '') else v end
	from (select pg_temp.mcp_member(p_user, format('select public.qorpera_list_coding_mcp_sign_ins(%L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020')) as v) as call
$$;

-- 1. The origin, the header and the name -----------------------------------------------------------------------------
do $$
declare
	v_long text := 'https://' || repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.'
		|| repeat('d', 61) || ':65535';
	v_origin text;
	v_header text;
	v_name text;
begin
	foreach v_origin in array array['https://mcp.linear.app', 'https://mcp.sentry.dev:8443', 'https://a.io',
		'https://x1.example.com:65535', 'https://a-b.c-d.co:1', 'https://mcp.1password.com', v_long] loop
		perform pg_temp.base_assert(public.qorpera_coding_mcp_origin_valid(v_origin), 'an origin: ' || v_origin);
	end loop;
	foreach v_origin in array array['http://mcp.linear.app', 'https://MCP.linear.app', 'https://mcp.linear.app/',
		'https://mcp.linear.app/mcp', 'https://mcp.linear.app?a=1', 'https://mcp.linear.app:443', 'https://mcp.linear.app:0',
		'https://mcp.linear.app:08443', 'https://mcp.linear.app:65536', 'https://mcp.linear.app:99999',
		'https://mcp.linear.app:', 'https://user@mcp.linear.app', 'https://linear', 'https://localhost',
		'https://localhost:8080', 'https://mcp.localhost', 'https://printer.local', 'https://db.internal', 'https://nas.lan',
		'https://router.home', 'https://intranet.corp', 'https://1.0.0.127.in-addr.arpa', 'https://mcp.test',
		'https://mcp.example', 'https://mcp.invalid', 'https://10.0.0.1', 'https://169.254.169.254', 'https://[::1]',
		-- An address in the spellings a URL parser also reads as one (its last label a number, decimal or hex).
		'https://127.0.0.0x1', 'https://a.0x7f', 'https://a.0x', 'https://a.0xff:8443', 'https://0x7f.0x0.0x0.0x1',
		'https://2130706433.0177', 'https://example.0X1',
		'https://-a.io', 'https://a..io', 'https://a.io.', 'https://' || repeat('a', 64) || '.io',
		replace(v_long, ':65535', 'd'), '', ' https://a.io', 'https://a.io '] loop
		perform pg_temp.base_assert(not public.qorpera_coding_mcp_origin_valid(v_origin), 'not an origin: ' || v_origin);
	end loop;
	perform pg_temp.base_assert(public.qorpera_coding_mcp_origin_valid(null) = false, 'no origin');

	foreach v_header in array array['authorization', 'x-api-key', 'api-key', 'private-token', repeat('a', 64)] loop
		perform pg_temp.base_assert(public.qorpera_coding_mcp_header_allowed(v_header), 'a header: ' || v_header);
	end loop;
	foreach v_header in array array['Authorization', 'host', 'cookie', 'content-type', 'content-length',
		'transfer-encoding', 'connection', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
		'x-real-ip', 'proxy-authorization', 'mcp-session-id', 'mcp-protocol-version', 'sec-fetch-site', 'last-event-id',
		'x api', 'x_api', '-x', '', repeat('a', 65)] loop
		perform pg_temp.base_assert(not public.qorpera_coding_mcp_header_allowed(v_header), 'not a header: ' || v_header);
	end loop;
	perform pg_temp.base_assert(public.qorpera_coding_mcp_header_allowed(null) = false, 'no header');

	-- The name: the origin's slug and the start of its digest, a vault name, never two origins' alike.
	v_name := public.qorpera_coding_mcp_secret_name('https://mcp.linear.app');
	perform pg_temp.base_assert(v_name = 'mcp-mcp-linear-app-'
		|| left(encode(extensions.digest('https://mcp.linear.app', 'sha256'), 'hex'), 16), 'a name: ' || v_name);
	perform pg_temp.base_assert(public.qorpera_coding_mcp_secret_name('https://mcp.sentry.dev:8443')
		like 'mcp-mcp-sentry-dev-8443-%', 'a name with a port');
	perform pg_temp.base_assert(public.qorpera_coding_mcp_secret_name('https://a-b.c.io')
		<> public.qorpera_coding_mcp_secret_name('https://a.b-c.io'), 'two origins with one slug');
	v_name := public.qorpera_coding_mcp_secret_name(v_long);
	perform pg_temp.base_assert(char_length(v_name) = 63 and v_name ~ '^[a-z][a-z0-9_-]{0,63}$',
		'the longest origin''s name: ' || v_name);

	-- The record's own checks: an origin, the kind's refresh secret, an OAuth sign-in's header.
	foreach v_name in array array[
		format('insert into public.qorpera_coding_mcp_sign_ins(secret_id, capture_ticket_id, profile_id, environment_id, '
			|| 'origin) values (gen_random_uuid(), gen_random_uuid(), %L, %L, %L)', '92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000020', 'https://localhost'),
		format('insert into public.qorpera_coding_mcp_sign_ins(secret_id, capture_ticket_id, profile_id, environment_id, '
			|| 'origin, refresh_secret_id) values (gen_random_uuid(), gen_random_uuid(), %L, %L, %L, gen_random_uuid())',
			'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'https://mcp.linear.app'),
		format('insert into public.qorpera_coding_mcp_sign_ins(secret_id, capture_ticket_id, profile_id, environment_id, '
			|| 'origin, kind, header_name) values (gen_random_uuid(), gen_random_uuid(), %L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'https://mcp.linear.app',
			'oauth', 'x-api-key'),
		format('insert into public.qorpera_coding_mcp_sign_ins(secret_id, capture_ticket_id, profile_id, environment_id, '
			|| 'origin, header_prefix) values (gen_random_uuid(), gen_random_uuid(), %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'https://mcp.linear.app',
			'Bearer')] loop
		perform pg_temp.base_assert(pg_temp.mcp_do(v_name) = '23514', 'a record check: ' || v_name);
	end loop;
end $$;

-- 2. Starting a sign-in ----------------------------------------------------------------------------------------------
do $$
declare
	v_tickets bigint := (select count(*) from public.qorpera_cloud_secret_capture_tickets);
	v_records bigint := (select count(*) from public.qorpera_coding_mcp_sign_ins);
	v_result text;
	v_answer jsonb;
	v_owner uuid := '92400000-0000-4000-8000-000000000001';
begin
	foreach v_result in array array[pg_temp.mcp_begin(v_owner, 'member', 'http://mcp.linear.app'),
		pg_temp.mcp_begin(v_owner, 'member', 'https://localhost:8080'),
		pg_temp.mcp_begin(v_owner, 'member', 'https://10.0.0.1'),
		pg_temp.mcp_begin(v_owner, 'company', 'https://mcp.linear.app/mcp'),
		pg_temp.mcp_begin(v_owner, 'member', null)] loop
		perform pg_temp.base_assert(v_result = '22023:An MCP server is named by its origin, https://host[:port]',
			'an origin refused: ' || v_result);
	end loop;
	foreach v_result in array array[pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'host'),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'cookie', ''),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'Authorization'),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'x-forwarded-for', ''),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'mcp-session-id', ''),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', null),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'authorization', null),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'authorization', 'Bearer'),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'authorization', 'Bearer  '),
		pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'authorization', 'Two words ')] loop
		perform pg_temp.base_assert(v_result = '22023:That header is not available for an MCP sign-in',
			'a header refused: ' || v_result);
	end loop;
	-- A viewer and an outsider may start none; a contributor no company sign-in.
	foreach v_result in array array[
		pg_temp.mcp_begin('92400000-0000-4000-8000-000000000003', 'member', 'https://mcp.linear.app'),
		pg_temp.mcp_begin('92400000-0000-4000-8000-000000000005', 'member', 'https://mcp.linear.app')] loop
		perform pg_temp.base_assert(v_result = '42501:secret capture requires company write access',
			'not a writer: ' || v_result);
	end loop;
	foreach v_result in array array[
		pg_temp.mcp_begin('92400000-0000-4000-8000-000000000002', 'company', 'https://mcp.linear.app'),
		pg_temp.mcp_begin(v_owner, 'team', 'https://mcp.linear.app')] loop
		perform pg_temp.base_assert(v_result = '22023:secret capture scope is invalid', 'the owner kind: ' || v_result);
	end loop;
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_capture_tickets) = v_tickets
		and (select count(*) from public.qorpera_coding_mcp_sign_ins) = v_records, 'a refusal writes nothing');

	-- The owner's own for Linear, the contributor's own for Sentry (another header), the company's for Linear.
	v_result := pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app');
	perform pg_temp.base_assert(v_result like 'ok:%', 'the owner''s begin: ' || v_result);
	v_answer := substring(v_result from 4)::jsonb;
	perform pg_temp.base_assert(v_answer ->> 'schema' = 'qorpera.cloud-secret-capture/v1'
		and v_answer #>> '{scope,connectorId}' = 'mcp' and v_answer #>> '{scope,ownerKind}' = 'member'
		and v_answer #>> '{scope,ownerUserId}' = v_owner::text and v_answer #>> '{scope,version}' = '1'
		and v_answer #>> '{scope,secretName}' = public.qorpera_coding_mcp_secret_name('https://mcp.linear.app')
		and v_answer #>> '{scope,purpose}' = 'Sign-in for the MCP server at https://mcp.linear.app'
		and v_answer -> 'signIn' = jsonb_build_object('schema', 'qorpera.coding-mcp-sign-in/v1',
			'secretId', v_answer #>> '{scope,secretId}', 'origin', 'https://mcp.linear.app', 'kind', 'api_key',
			'headerName', 'authorization', 'headerPrefix', 'Bearer '), 'the owner''s answer: ' || v_result);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_coding_mcp_sign_ins as sign_in
		where sign_in.secret_id = (v_answer #>> '{scope,secretId}')::uuid
			and sign_in.capture_ticket_id = (v_answer ->> 'ticketId')::uuid
			and sign_in.profile_id = '92400000-0000-4000-8000-000000000010'
			and sign_in.environment_id = '92400000-0000-4000-8000-000000000020'
			and sign_in.origin = 'https://mcp.linear.app' and sign_in.refresh_secret_id is null), 'the owner''s record');
	perform set_config('qorpera_test.own_capture', v_result, true);
	perform set_config('qorpera_test.own_secret', v_answer #>> '{scope,secretId}', true);
	v_result := pg_temp.mcp_begin('92400000-0000-4000-8000-000000000002', 'member', 'https://mcp.sentry.dev:8443',
		'x-api-key', '');
	perform pg_temp.base_assert(v_result like 'ok:%'
		and substring(v_result from 4)::jsonb -> 'signIn' ->> 'headerName' = 'x-api-key'
		and substring(v_result from 4)::jsonb -> 'signIn' ->> 'headerPrefix' = '', 'the contributor''s begin: ' || v_result);
	perform set_config('qorpera_test.other_capture', v_result, true);
	perform set_config('qorpera_test.other_secret', substring(v_result from 4)::jsonb #>> '{scope,secretId}', true);
	v_result := pg_temp.mcp_begin('92400000-0000-4000-8000-000000000004', 'company', 'https://mcp.linear.app');
	perform pg_temp.base_assert(v_result like 'ok:%'
		and substring(v_result from 4)::jsonb #>> '{scope,ownerKind}' = 'company'
		and substring(v_result from 4)::jsonb #> '{scope,ownerUserId}' = 'null'::jsonb,
		'the administrator''s company begin: ' || v_result);
	perform set_config('qorpera_test.company_capture', v_result, true);
	perform set_config('qorpera_test.company_secret', substring(v_result from 4)::jsonb #>> '{scope,secretId}', true);
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_capture_tickets) = v_tickets + 3
		and (select count(*) from public.qorpera_coding_mcp_sign_ins) = v_records + 3, 'three begins');
end $$;

-- 3. Completing a sign-in --------------------------------------------------------------------------------------------
do $$
declare
	v_owner uuid := '92400000-0000-4000-8000-000000000001';
	v_records bigint;
	v_result text;
	v_answer jsonb;
begin
	v_result := pg_temp.mcp_complete(current_setting('qorpera_test.own_capture'), 'own');
	v_answer := substring(v_result from 4)::jsonb;
	perform pg_temp.base_assert(v_result like 'ok:%' and v_answer ->> 'connectorId' = 'mcp'
		and v_answer ->> 'secretId' = current_setting('qorpera_test.own_secret') and v_answer ->> 'version' = '1'
		and v_answer ->> 'secretName' = public.qorpera_coding_mcp_secret_name('https://mcp.linear.app')
		and v_answer ->> 'ownerKind' = 'member', 'the owner''s complete: ' || v_result);
	v_result := pg_temp.mcp_complete(current_setting('qorpera_test.other_capture'), 'other');
	perform pg_temp.base_assert(v_result like 'ok:%', 'the contributor''s complete: ' || v_result);
	v_result := pg_temp.mcp_complete(current_setting('qorpera_test.company_capture'), 'company');
	perform pg_temp.base_assert(v_result like 'ok:%', 'the company''s complete: ' || v_result);
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secrets
		where connector_id = 'mcp' and status = 'active' and current_version = 1
			and id in (current_setting('qorpera_test.own_secret')::uuid, current_setting('qorpera_test.other_secret')::uuid,
				current_setting('qorpera_test.company_secret')::uuid)) = 3, 'three sign-ins sealed');

	-- One active sign-in per owner and origin.
	v_records := (select count(*) from public.qorpera_coding_mcp_sign_ins);
	foreach v_result in array array[pg_temp.mcp_begin(v_owner, 'member', 'https://mcp.linear.app', 'x-api-key', ''),
		pg_temp.mcp_begin(v_owner, 'company', 'https://mcp.linear.app')] loop
		perform pg_temp.base_assert(v_result = '23505:an active secret already has this name', 'a second: ' || v_result);
	end loop;
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_mcp_sign_ins) = v_records,
		'a second writes no record');

	-- A plain capture under mcp starts, and never completes.
	v_result := pg_temp.mcp_capture(v_owner, 'member', public.qorpera_coding_mcp_secret_name('https://tools.acme.io'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'a plain begin: ' || v_result);
	v_answer := substring(v_result from 4)::jsonb;
	v_result := pg_temp.mcp_complete(v_result, 'plain');
	perform pg_temp.base_assert(v_result = '42501:cloud secret capture is unavailable', 'a plain complete: ' || v_result);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_cloud_secrets
		where id = (v_answer #>> '{scope,secretId}')::uuid), 'no secret from a plain capture');
	-- Nor one whose record no longer names the origin its secret is named for.
	v_result := pg_temp.mcp_begin(v_owner, 'member', 'https://bound.acme.io');
	perform pg_temp.base_assert(v_result like 'ok:%', 'the bound begin: ' || v_result);
	update public.qorpera_coding_mcp_sign_ins set origin = 'https://moved.acme.io'
	where capture_ticket_id = (substring(v_result from 4)::jsonb ->> 'ticketId')::uuid;
	v_result := pg_temp.mcp_complete(v_result, 'moved');
	perform pg_temp.base_assert(v_result = '42501:cloud secret capture is unavailable', 'a moved record: ' || v_result);

	-- A rotation is a plain capture of the secret, under its name.
	v_result := pg_temp.mcp_capture(v_owner, 'member', public.qorpera_coding_mcp_secret_name('https://mcp.linear.app'),
		current_setting('qorpera_test.own_secret')::uuid);
	perform pg_temp.base_assert(v_result like 'ok:%' and substring(v_result from 4)::jsonb #>> '{scope,version}' = '2',
		'the rotation''s begin: ' || v_result);
	v_result := pg_temp.mcp_complete(v_result, 'own-2');
	perform pg_temp.base_assert(v_result like 'ok:%' and substring(v_result from 4)::jsonb ->> 'version' = '2',
		'the rotation: ' || v_result);
end $$;

-- 4. The members' list -----------------------------------------------------------------------------------------------
do $$
declare v_result text;
begin
	v_result := pg_temp.mcp_listed('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v_result = 'https://mcp.linear.app/company/1,https://mcp.linear.app/member/2',
		'the owner''s list: ' || v_result);
	v_result := pg_temp.mcp_listed('92400000-0000-4000-8000-000000000002');
	perform pg_temp.base_assert(v_result = 'https://mcp.linear.app/company/1,https://mcp.sentry.dev:8443/member/1',
		'the contributor''s list: ' || v_result);
	v_result := pg_temp.mcp_listed('92400000-0000-4000-8000-000000000003');
	perform pg_temp.base_assert(v_result = 'https://mcp.linear.app/company/1', 'the viewer''s list: ' || v_result);
	v_result := pg_temp.mcp_listed('92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_assert(v_result = '', 'the outsider''s list: ' || v_result);
	-- The entry: what the record says, never a value.
	v_result := pg_temp.mcp_member('92400000-0000-4000-8000-000000000002', format(
		'select public.qorpera_list_coding_mcp_sign_ins(%L, %L) -> 1', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020'));
	perform pg_temp.base_assert(v_result like 'ok:%'
		and (select array_agg(k order by k) from jsonb_object_keys(substring(v_result from 4)::jsonb) as k)
			= array['createdAt', 'headerName', 'headerPrefix', 'kind', 'origin', 'ownerKind', 'schema', 'secretId',
				'secretName', 'updatedAt', 'version']
		and substring(v_result from 4)::jsonb - array['createdAt', 'updatedAt'] = jsonb_build_object(
			'schema', 'qorpera.coding-mcp-sign-in/v1', 'secretId', current_setting('qorpera_test.other_secret'),
			'secretName', public.qorpera_coding_mcp_secret_name('https://mcp.sentry.dev:8443'),
			'origin', 'https://mcp.sentry.dev:8443', 'kind', 'api_key', 'headerName', 'x-api-key', 'headerPrefix', '',
			'ownerKind', 'member', 'version', 1), 'the contributor''s entry: ' || v_result);
end $$;

-- 5. The broker's read -----------------------------------------------------------------------------------------------
do $$
declare
	v_worker uuid := current_setting('qorpera_test.mcp_worker')::uuid;
	v_result text;
begin
	-- Linear: the company's wins over the owner's own.
	v_result := pg_temp.mcp_now('https://mcp.linear.app');
	perform pg_temp.base_assert(v_result like 'ok:%' and substring(v_result from 4)::jsonb = jsonb_build_object(
		'schema', 'qorpera.coding-mcp-sign-in-authorization/v1',
		'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', '92400000-0000-4000-8000-000000000020',
		'workerId', v_worker, 'origin', 'https://mcp.linear.app',
		'signIn', jsonb_build_object('secretId', current_setting('qorpera_test.company_secret'), 'secretVersion', 1,
			'keyId', 'company-kek-1', 'ownerKind', 'company', 'kind', 'api_key', 'headerName', 'authorization',
			'headerPrefix', 'Bearer ', 'encryptedEnvelopeBase64', encode(pg_temp.mcp_envelope('company'), 'base64'),
			'envelopeSha256', encode(extensions.digest(pg_temp.mcp_envelope('company'), 'sha256'), 'hex'))),
		'Linear: ' || v_result);
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_audit_events
		where event_type = 'mcp_sign_in_used' and coding_worker_id = v_worker and connector_id = 'mcp'
			and actor_user_id is null and secret_version = 1
			and secret_id = current_setting('qorpera_test.company_secret')::uuid) = 1
		and pg_temp.mcp_used('mcp_sign_in_used') = 1, 'one audit row for the read');
	-- Sentry has only the contributor's own, which never reaches Alice's session; the other origins have none.
	foreach v_result in array array[pg_temp.mcp_now('https://mcp.sentry.dev:8443'),
		pg_temp.mcp_now('https://tools.acme.io'), pg_temp.mcp_now('https://bound.acme.io'),
		pg_temp.mcp_now('https://moved.acme.io')] loop
		perform pg_temp.base_assert(v_result like 'ok:%'
			and substring(v_result from 4)::jsonb -> 'signIn' = 'null'::jsonb, 'no sign-in: ' || v_result);
	end loop;
	perform pg_temp.base_assert(pg_temp.mcp_used('mcp_sign_in_used') = 1, 'no sign-in, no audit row');
end $$;

-- The lease and the phase.
do $$
declare
	v_phase text;
	v_result text;
	v_call text := 'select pg_temp.mcp_served(pg_temp.mcp_now(''https://mcp.linear.app''))';
begin
	foreach v_phase in array array['running', 'awaiting_input', 'input_ready', 'publishing'] loop
		v_result := pg_temp.mcp_after(format('update public.qorpera_coding_sessions set phase = %L where worker_id = %L',
			v_phase, current_setting('qorpera_test.mcp_worker')), v_call);
		perform pg_temp.base_assert(v_result = 'company', v_phase || ': ' || v_result);
	end loop;
	foreach v_phase in array array['queued', 'completed', 'failed', 'cancelled'] loop
		v_result := pg_temp.mcp_after(format('update public.qorpera_coding_sessions set phase = %L where worker_id = %L',
			v_phase, current_setting('qorpera_test.mcp_worker')), v_call);
		perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable', v_phase || ': ' || v_result);
	end loop;
	v_result := pg_temp.mcp_after(format('update public.qorpera_coding_sessions
		set lease_until = clock_timestamp() - interval ''1 second'' where worker_id = %L',
		current_setting('qorpera_test.mcp_worker')), v_call);
	perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable', 'an expired lease: ' || v_result);
	-- The company's outlives its creator's demotion, as a company connection does.
	v_result := pg_temp.mcp_after('update public.qorpera_profile_members set role = ''contributor''
		where profile_id = ''92400000-0000-4000-8000-000000000010''
			and user_id = ''92400000-0000-4000-8000-000000000004''', v_call);
	perform pg_temp.base_assert(v_result = 'company', 'its creator demoted: ' || v_result);
end $$;

-- The refusals, each writing nothing.
do $$
declare
	v_worker uuid := current_setting('qorpera_test.mcp_worker')::uuid;
	v_lease uuid := current_setting('qorpera_test.mcp_lease')::uuid;
	v_origin text := 'https://mcp.linear.app';
	v_call text := 'select pg_temp.mcp_served(pg_temp.mcp_now(''https://mcp.linear.app''))';
	v_used bigint := pg_temp.mcp_used('mcp_sign_in_used');
	v_result text;
begin
	-- Anyone but the broker (here the database's owner).
	v_result := pg_temp.mcp_try(format('select public.qorpera_authorize_coding_mcp_sign_in(%L, %L, %L, %L, %L, %L)',
		'53000000-0000-4000-8000-000000000040', repeat('9', 64), v_worker, v_lease, 'exec-530', v_origin));
	perform pg_temp.base_assert(v_result = '42501:cloud secret broker authority is required', 'not the broker: ' || v_result);
	-- A malformed request, an origin that is not one among them.
	foreach v_result in array array[pg_temp.mcp_authorize(null, v_lease, v_origin),
		pg_temp.mcp_authorize(v_worker, null, v_origin), pg_temp.mcp_authorize(v_worker, v_lease, v_origin, 'exec 530'),
		pg_temp.mcp_authorize(v_worker, v_lease, v_origin, null), pg_temp.mcp_authorize(v_worker, v_lease, null),
		pg_temp.mcp_authorize(v_worker, v_lease, 'https://mcp.linear.app/'),
		pg_temp.mcp_authorize(v_worker, v_lease, 'https://localhost:8080'),
		pg_temp.mcp_authorize(v_worker, v_lease, 'https://mcp.linear.app:443')] loop
		perform pg_temp.base_assert(v_result = '22023:coding MCP sign-in request is invalid', 'malformed: ' || v_result);
	end loop;
	-- The broker's own proof.
	foreach v_result in array array[
		pg_temp.mcp_authorize(v_worker, v_lease, v_origin, p_capability => repeat('7', 64)),
		pg_temp.mcp_authorize(v_worker, v_lease, v_origin, p_authority => '53000000-0000-4000-8000-0000000000ff')] loop
		perform pg_temp.base_assert(v_result = '42501:cloud secret broker authority is unavailable',
			'the authority: ' || v_result);
	end loop;
	-- A session that is not there, or another company's.
	foreach v_result in array array[pg_temp.mcp_authorize('53000000-0000-4000-8000-0000000000ff', v_lease, v_origin),
		pg_temp.mcp_authorize(v_worker, v_lease, v_origin, p_authority => '53000000-0000-4000-8000-000000000041',
			p_capability => repeat('8', 64))] loop
		perform pg_temp.base_assert(v_result = '42501:coding session is unavailable to this broker',
			'the session: ' || v_result);
	end loop;
	-- Another lease, or another executor.
	foreach v_result in array array[pg_temp.mcp_authorize(v_worker, '53000000-0000-4000-8000-0000000000ff', v_origin),
		pg_temp.mcp_authorize(v_worker, v_lease, v_origin, 'exec-other')] loop
		perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable', 'the lease: ' || v_result);
	end loop;
	-- The executor switched off, the worker no longer active, the agent's repository grant switched off, the session's
	-- member made a viewer, a version under another key.
	v_result := pg_temp.mcp_after('update public.qorpera_coding_executors set enabled = false
		where environment_id = ''92400000-0000-4000-8000-000000000020''', v_call);
	perform pg_temp.base_assert(v_result = '42501:coding executor is unavailable', 'the executor: ' || v_result);
	v_result := pg_temp.mcp_after(format(
		'update public.qorpera_runtime_workers set state = ''failed'', result = ''{}'' where id = %L', v_worker), v_call);
	perform pg_temp.base_assert(v_result = '42501:coding executor is unavailable', 'the worker: ' || v_result);
	v_result := pg_temp.mcp_after('update public.qorpera_coding_repository_grants set enabled = false
		where environment_id = ''92400000-0000-4000-8000-000000000020''', v_call);
	perform pg_temp.base_assert(v_result = '42501:coding repository grant is unavailable', 'the agent: ' || v_result);
	v_result := pg_temp.mcp_after('update public.qorpera_profile_members set role = ''viewer''
		where profile_id = ''92400000-0000-4000-8000-000000000010''
			and user_id = ''92400000-0000-4000-8000-000000000001''', v_call);
	perform pg_temp.base_assert(v_result = '42501:coding session member is unavailable', 'the member: ' || v_result);
	v_result := pg_temp.mcp_after(format('update public.qorpera_cloud_secret_versions set key_id = ''company-kek-2''
		where secret_id = %L', current_setting('qorpera_test.company_secret')), v_call);
	perform pg_temp.base_assert(v_result = '42501:cloud secret version is unavailable', 'the version: ' || v_result);
	-- A sign-in another broker sealed.
	v_result := pg_temp.mcp_after(format('update public.qorpera_cloud_secrets
		set broker_authority_id = ''53000000-0000-4000-8000-000000000041'' where id = %L',
		current_setting('qorpera_test.company_secret')), v_call);
	perform pg_temp.base_assert(v_result = 'member', 'another broker''s: ' || v_result);
	perform pg_temp.base_assert(pg_temp.mcp_used('mcp_sign_in_used') = v_used, 'a refusal writes no audit row');
end $$;

-- Disconnect, and a member who leaves.
do $$
declare v_result text;
begin
	-- The owner disconnects the company's: the owner's own serves, its second version.
	v_result := pg_temp.mcp_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_revoke_cloud_secret(%L, %L)', '92400000-0000-4000-8000-000000000010',
		current_setting('qorpera_test.company_secret')));
	perform pg_temp.base_assert(v_result like 'ok:%', 'Disconnect: ' || v_result);
	v_result := pg_temp.mcp_now('https://mcp.linear.app');
	perform pg_temp.base_assert(v_result like 'ok:%'
		and substring(v_result from 4)::jsonb -> 'signIn' ->> 'ownerKind' = 'member'
		and substring(v_result from 4)::jsonb -> 'signIn' ->> 'secretId' = current_setting('qorpera_test.own_secret')
		and substring(v_result from 4)::jsonb -> 'signIn' ->> 'secretVersion' = '2'
		and substring(v_result from 4)::jsonb -> 'signIn' ->> 'encryptedEnvelopeBase64'
			= encode(pg_temp.mcp_envelope('own-2'), 'base64'), 'after Disconnect: ' || v_result);
	perform pg_temp.base_assert(pg_temp.mcp_listed('92400000-0000-4000-8000-000000000001')
		= 'https://mcp.linear.app/member/2', 'the list after Disconnect');
	-- The owner disconnects their own: none.
	v_result := pg_temp.mcp_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_revoke_cloud_secret(%L, %L)', '92400000-0000-4000-8000-000000000010',
		current_setting('qorpera_test.own_secret')));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the own Disconnect: ' || v_result);
	perform pg_temp.base_assert(pg_temp.mcp_served(pg_temp.mcp_now('https://mcp.linear.app')) = 'none',
		'after both are disconnected');
	-- The contributor leaves: their own sign-in ends with them.
	v_result := pg_temp.mcp_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_remove_profile_member(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000002'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the removal: ' || v_result);
	perform pg_temp.base_assert((select status from public.qorpera_cloud_secrets
		where id = current_setting('qorpera_test.other_secret')::uuid) = 'revoked', 'the contributor''s sign-in ended');
end $$;

-- 6. The repository fetch --------------------------------------------------------------------------------------------
-- The company's GitHub connection, sealed by this broker.
do $$ begin
	perform pg_temp.base_claims('service_role');
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
	values ('53000000-0000-4000-8000-000000000061', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '53000000-0000-4000-8000-000000000040', 'company', null, 'github',
		'primary', 'GitHub account', 1, '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values ('53000000-0000-4000-8000-000000000061', 1, '53000000-0000-4000-8000-000000000040', 'company-kek-1',
		pg_temp.mcp_envelope('github'), encode(extensions.digest(pg_temp.mcp_envelope('github'), 'sha256'), 'hex'),
		'92400000-0000-4000-8000-000000000001');
end $$;

do $$
declare
	v_worker uuid := current_setting('qorpera_test.mcp_worker')::uuid;
	v_lease uuid := current_setting('qorpera_test.mcp_lease')::uuid;
	v_result text;
	v_answer jsonb;
	v_phase text;
	v_call text := 'select pg_temp.mcp_fetch_now()';
	v_refused text := '42501:company GitHub connection is unavailable to this agent';
begin
	-- No grant for the agent yet: refused.
	v_result := pg_temp.mcp_fetch_now();
	perform pg_temp.base_assert(v_result = v_refused, 'no grant: ' || v_result);
	-- The owner's grant of one GitHub operation to the agent.
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id,
		connector_id, operation_id, operation_version, tool_name, issued_by_user_id)
	values ('53000000-0000-4000-8000-000000000062', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '53000000-0000-4000-8000-000000000061',
		'92400000-0000-4000-8000-000000000030', 'github', 'list_repositories', 1, 'github_list_repositories',
		'92400000-0000-4000-8000-000000000001');
	perform set_config('session_replication_role', 'origin', true);

	v_result := pg_temp.mcp_fetch(v_worker, v_lease);
	perform pg_temp.base_assert(v_result like 'ok:%', 'the fetch: ' || v_result);
	v_answer := substring(v_result from 4)::jsonb;
	perform pg_temp.base_assert(v_answer = jsonb_build_object(
		'schema', 'qorpera.coding-repository-fetch-authorization/v1',
		'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', '92400000-0000-4000-8000-000000000020',
		'secretId', '53000000-0000-4000-8000-000000000061', 'secretVersion', 1, 'keyId', 'company-kek-1',
		'connectorId', 'github', 'credentialName', 'access_token',
		'encryptedEnvelopeBase64', encode(pg_temp.mcp_envelope('github'), 'base64'),
		'envelopeSha256', encode(extensions.digest(pg_temp.mcp_envelope('github'), 'sha256'), 'hex'),
		'workerId', v_worker, 'repository', (pg_temp.c3_session(v_worker)).repository), 'the fetch''s answer: ' || v_result);
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_audit_events
		where event_type = 'repository_fetch_used' and coding_worker_id = v_worker and connector_id = 'github'
			and actor_user_id is null and secret_version = 1
			and secret_id = '53000000-0000-4000-8000-000000000061') = 1
		and pg_temp.mcp_used('repository_fetch_used') = 1, 'one audit row for the fetch');

	-- While the session runs, and in every phase that runs commands; not once it stops, nor on an expired lease.
	foreach v_phase in array array['running', 'awaiting_input', 'input_ready', 'publishing'] loop
		v_result := pg_temp.mcp_after(format('update public.qorpera_coding_sessions set phase = %L where worker_id = %L',
			v_phase, v_worker), v_call);
		perform pg_temp.base_assert(v_result = '61', v_phase || ': ' || v_result);
	end loop;
	foreach v_phase in array array['queued', 'completed', 'failed', 'cancelled'] loop
		v_result := pg_temp.mcp_after(format('update public.qorpera_coding_sessions set phase = %L where worker_id = %L',
			v_phase, v_worker), v_call);
		perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable', v_phase || ': ' || v_result);
	end loop;
	v_result := pg_temp.mcp_after(format('update public.qorpera_coding_sessions
		set lease_until = clock_timestamp() - interval ''1 second'' where worker_id = %L', v_worker), v_call);
	perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable', 'an expired lease: ' || v_result);

	-- The refusals, each writing nothing.
	v_result := pg_temp.mcp_try(format('select public.qorpera_authorize_coding_repository_fetch(%L, %L, %L, %L, %L)',
		'53000000-0000-4000-8000-000000000040', repeat('9', 64), v_worker, v_lease, 'exec-530'));
	perform pg_temp.base_assert(v_result = '42501:cloud secret broker authority is required', 'not the broker: ' || v_result);
	foreach v_result in array array[pg_temp.mcp_fetch(null, v_lease), pg_temp.mcp_fetch(v_worker, null),
		pg_temp.mcp_fetch(v_worker, v_lease, 'exec 530'), pg_temp.mcp_fetch(v_worker, v_lease, null)] loop
		perform pg_temp.base_assert(v_result = '22023:coding repository fetch request is invalid', 'malformed: ' || v_result);
	end loop;
	v_result := pg_temp.mcp_fetch(v_worker, v_lease, p_capability => repeat('7', 64));
	perform pg_temp.base_assert(v_result = '42501:cloud secret broker authority is unavailable', 'the authority: ' || v_result);
	v_result := pg_temp.mcp_fetch(v_worker, '53000000-0000-4000-8000-0000000000ff');
	perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable', 'the lease: ' || v_result);
	v_result := pg_temp.mcp_after('update public.qorpera_coding_repository_grants set enabled = false
		where environment_id = ''92400000-0000-4000-8000-000000000020''', v_call);
	perform pg_temp.base_assert(v_result = '42501:coding repository grant is unavailable', 'the agent: ' || v_result);
	-- The grant's issuer no longer an owner or administrator, the grant withdrawn or expired, the connection another
	-- broker's, its version under another key.
	v_result := pg_temp.mcp_after('update public.qorpera_profile_members set role = ''contributor''
		where profile_id = ''92400000-0000-4000-8000-000000000010''
			and user_id = ''92400000-0000-4000-8000-000000000001''', v_call);
	perform pg_temp.base_assert(v_result = v_refused, 'the issuer demoted: ' || v_result);
	v_result := pg_temp.mcp_after('update public.qorpera_cloud_secret_operation_grants
		set status = ''revoked'', revoked_at = statement_timestamp()
		where id = ''53000000-0000-4000-8000-000000000062''', v_call);
	perform pg_temp.base_assert(v_result = v_refused, 'the grant withdrawn: ' || v_result);
	v_result := pg_temp.mcp_after('update public.qorpera_cloud_secret_operation_grants
		set created_at = created_at - interval ''1 hour'', expires_at = created_at - interval ''30 minutes''
		where id = ''53000000-0000-4000-8000-000000000062''', v_call);
	perform pg_temp.base_assert(v_result = v_refused, 'the grant expired: ' || v_result);
	v_result := pg_temp.mcp_after('update public.qorpera_cloud_secrets
		set broker_authority_id = ''53000000-0000-4000-8000-000000000041''
		where id = ''53000000-0000-4000-8000-000000000061''', v_call);
	perform pg_temp.base_assert(v_result = v_refused, 'another broker''s: ' || v_result);
	v_result := pg_temp.mcp_after('update public.qorpera_cloud_secret_versions set key_id = ''company-kek-2''
		where secret_id = ''53000000-0000-4000-8000-000000000061''', v_call);
	perform pg_temp.base_assert(v_result = '42501:cloud secret version is unavailable', 'the version: ' || v_result);
	perform pg_temp.base_assert(pg_temp.mcp_used('repository_fetch_used') = 1, 'a refusal writes no audit row');
end $$;

-- 7. The patched bodies, and who may call -----------------------------------------------------------------------------
do $$
declare
	v_role text;
	v_function text;
begin
	foreach v_function in array array['public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)',
		'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'] loop
		perform pg_temp.base_assert(position('20260930440000' in pg_get_functiondef(v_function::regprocedure)) > 0,
			v_function || ' names 20260930440000');
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		foreach v_function in array array['public.qorpera_authorize_coding_mcp_sign_in(uuid,text,uuid,uuid,text,text)',
			'public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)',
			'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'execute'), v_role || ' ' || v_function);
		end loop;
	end loop;
	foreach v_function in array array['public.qorpera_authorize_coding_mcp_sign_in(uuid,text,uuid,uuid,text,text)',
		'public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)',
		'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'] loop
		perform pg_temp.base_assert(has_function_privilege('qorpera_secret_broker', v_function, 'execute'),
			'the broker: ' || v_function);
	end loop;
	foreach v_function in array array['public.qorpera_begin_coding_mcp_sign_in(uuid,uuid,text,text,text,text)',
		'public.qorpera_list_coding_mcp_sign_ins(uuid,uuid)'] loop
		perform pg_temp.base_assert(has_function_privilege('authenticated', v_function, 'execute'), 'members: ' || v_function);
		foreach v_role in array array['anon', 'service_role', 'qorpera_secret_broker'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'execute'), v_role || ' ' || v_function);
		end loop;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_coding_mcp_origin_valid(text)',
			'public.qorpera_coding_mcp_header_allowed(text)', 'public.qorpera_coding_mcp_secret_name(text)',
			'public.qorpera_coding_relay_session(uuid,text,uuid,uuid,text)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'execute'), v_role || ' ' || v_function);
		end loop;
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_coding_mcp_sign_ins',
			'select, insert, update, delete'), v_role || ' the record');
	end loop;
end $$;

rollback;
