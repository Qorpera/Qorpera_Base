-- @fixture 530_coding_mcp_sign_ins.test.sql until "-- 1. The origin, the header and the name ------"
-- The secret broker's fetch for a code import (migration 20260930736000): qorpera_authorize_coding_repository_fetch
-- hands a worker id that no coding session has to qorpera_authorize_code_import_fetch. 530's fixture: the company's
-- broker (…40) and Another company's (…41), exec-530 holding the company, Alice's GitHub session b1 of
-- Qorpera/Qorpera_Base claimed by it, and the broker's calls with their helpers.
--   1. The company's GitHub connection, sealed by its broker, with Alice's grant on it; Alice brings Acme/Shop in through
--      it, and exec-530 claims the import and begins its fetch.
--   2. The fetch answers as the session path does, for the import's request, with one audit row of its own.
--   3. Every condition failing alone: the same opaque 42501, and no audit row.
--   4. A member's import: the member's role, no grant needed; an agent's request names its member.
--   5. The session path is as it was.

-- 1. The connection, the grant, the import ------------------------------------------------------------------------------
update public.qorpera_coding_executors set nas_machine_id_sha256 = repeat('5', 64) where owner = 'exec-530';
do $$ begin
	perform pg_temp.base_claims('service_role');
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
	values ('12300000-0000-4000-8000-000000000061', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '53000000-0000-4000-8000-000000000040', 'company', null, 'github',
		'primary', 'GitHub account', 1, '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values ('12300000-0000-4000-8000-000000000061', 1, '53000000-0000-4000-8000-000000000040', 'company-kek-1',
		pg_temp.mcp_envelope('github'), encode(extensions.digest(pg_temp.mcp_envelope('github'), 'sha256'), 'hex'),
		'92400000-0000-4000-8000-000000000001');
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id,
		connector_id, operation_id, operation_version, tool_name, issued_by_user_id)
	values ('12300000-0000-4000-8000-000000000062', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '12300000-0000-4000-8000-000000000061',
		'92400000-0000-4000-8000-000000000030', 'github', 'list_repositories', 1, 'github_list_repositories',
		'92400000-0000-4000-8000-000000000001');
	perform set_config('session_replication_role', 'origin', true);
end $$;
do $$
declare v jsonb; v_item jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v := public.qorpera_folder_request_code_import(pg_temp.c3_alice(), '{"operationKey":"fetch-1230","owner":"company",
		"name":"shop","from":{"github":"Acme/Shop"},"look":false}');
	perform pg_temp.base_assert(v ->> 'state' = 'queued'
		and (select input ->> 'via' from public.qorpera_code_requests where id = (v ->> 'requestId')::uuid) = 'connection',
		'Alice''s import, through the connection: ' || v::text);
	set local role service_role;
	v_item := public.qorpera_code_requests_claim('exec-530', repeat('5', 64), 5, array['import']) -> 'requests' -> 0;
	perform public.qorpera_code_request_step('exec-530', repeat('5', 64), (v_item ->> 'requestId')::uuid,
		(v_item ->> 'token')::uuid, '{"step":"fetch"}');
	reset role;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v ->> 'requestId', 'claimed: ' || coalesce(v_item::text, 'none'));
	perform set_config('qorpera_test.imp_request', v_item ->> 'requestId', false);
	perform set_config('qorpera_test.imp_lease', v_item ->> 'token', false);
end $$;
-- The fetch for the import, as the executor's lease gives it: its answer, or the refusal as '<sqlstate>:<message>'.
create function pg_temp.imp_fetch() returns text language sql as $$
	select pg_temp.mcp_fetch(current_setting('qorpera_test.imp_request')::uuid, current_setting('qorpera_test.imp_lease')::uuid)
$$;
-- What it answers after a change (made with the triggers off, undone with everything the call wrote).
create function pg_temp.imp_after(p_change text) returns text language sql as $$
	select pg_temp.mcp_after(p_change, 'select pg_temp.imp_fetch()')
$$;
create function pg_temp.imp_where() returns text language sql as $$
	select format('id = %L', current_setting('qorpera_test.imp_request'))
$$;

-- 2. The answer ----------------------------------------------------------------------------------------------------------
do $$
declare v_result text := pg_temp.imp_fetch(); v_request uuid := current_setting('qorpera_test.imp_request')::uuid;
begin
	perform pg_temp.base_assert(v_result like 'ok:%' and substring(v_result from 4)::jsonb = jsonb_build_object(
		'schema', 'qorpera.coding-repository-fetch-authorization/v1',
		'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', '92400000-0000-4000-8000-000000000020',
		'secretId', '12300000-0000-4000-8000-000000000061', 'secretVersion', 1, 'keyId', 'company-kek-1',
		'connectorId', 'github', 'credentialName', 'access_token',
		'encryptedEnvelopeBase64', encode(pg_temp.mcp_envelope('github'), 'base64'),
		'envelopeSha256', encode(extensions.digest(pg_temp.mcp_envelope('github'), 'sha256'), 'hex'),
		'workerId', v_request, 'repository', '{"host":"github.com","owner":"Acme","name":"Shop","baseBranch":"main"}'::jsonb),
		'the import''s fetch: ' || v_result);
	-- One audit row, the import's own: the request, no coding worker.
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_audit_events
			where event_type = 'repository_import_fetch_used' and code_request_id = v_request and coding_worker_id is null
				and connector_id = 'github' and actor_user_id is null and secret_version = 1
				and secret_id = '12300000-0000-4000-8000-000000000061') = 1
		and pg_temp.mcp_used('repository_import_fetch_used') = 1 and pg_temp.mcp_used('repository_fetch_used') = 0,
		'one audit row');
	-- No repository grant is asked: Alice holds none for Acme/Shop, and every other may be off.
	perform pg_temp.base_assert(pg_temp.imp_after('update public.qorpera_coding_repository_grants set enabled = false')
		like 'ok:%', 'no repository grant needed');
	-- Each call is one row.
	perform pg_temp.imp_fetch();
	perform pg_temp.base_assert(pg_temp.mcp_used('repository_import_fetch_used') = 2, 'a row a call');
	-- The audit rows' rule: an import's fetch names its request and no worker, and only it names a request.
	perform pg_temp.base_error($q$insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, event_type,
		connector_id) values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'repository_import_fetch_used', 'github')$q$, '23514');
	perform pg_temp.base_error($q$insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, event_type,
		connector_id, code_request_id) values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'captured', 'github', '12300000-0000-4000-8000-0000000000aa')$q$, '23514');
end $$;

-- 3. Every condition failing alone ---------------------------------------------------------------------------------------
do $$
declare
	v_refused text := '42501:code import fetch is unavailable'; v_case record; v_result text;
	v_request uuid := current_setting('qorpera_test.imp_request')::uuid;
	v_lease uuid := current_setting('qorpera_test.imp_lease')::uuid; v_used bigint := pg_temp.mcp_used('repository_import_fetch_used');
begin
	-- 1. Only the secret broker (the session path's own refusal comes first); its arguments well formed (the same).
	perform pg_temp.base_assert(pg_temp.mcp_try(format('select public.qorpera_authorize_coding_repository_fetch(%L, %L, %L, %L, %L)',
		'53000000-0000-4000-8000-000000000040', repeat('9', 64), v_request, v_lease, 'exec-530'))
		= '42501:cloud secret broker authority is required', '1: not the broker');
	perform pg_temp.base_assert(pg_temp.mcp_fetch(v_request, v_lease, 'exec 530') = '22023:coding repository fetch request is invalid'
		and pg_temp.mcp_fetch(v_request, null) = '22023:coding repository fetch request is invalid', '1: malformed');
	perform pg_temp.base_assert(pg_temp.mcp_fetch(v_request, v_lease, p_capability => null) = v_refused, '1: no capability');
	-- 2. A coding session with that id is the session path's (which refuses it here), never the import's.
	v_result := pg_temp.imp_after(format($q$insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id,
		harness, repository, branch, phase) values (%L, '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', 'codex', '{"host":"github.com","owner":"Acme","name":"Shop","baseBranch":"main"}',
		'qorpera/coding/x-1230', 'queued')$q$, v_request));
	perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable', '2: a session''s id: ' || v_result);
	for v_case in select * from (values
		-- 3. An import's request.
		('3: no request', null),
		('3: an undo', format($q$update public.qorpera_code_requests set kind = 'undo' where %s$q$, pg_temp.imp_where())),
		-- 4. The broker authority, active, by its capability.
		('4: a retired authority', $q$update public.qorpera_cloud_secret_broker_authorities set status = 'retired',
			retired_at = clock_timestamp() where id = '53000000-0000-4000-8000-000000000040'$q$),
		('4: another capability', 'capability'),
		-- 5. The request is the authority's company's.
		('5: another company''s broker', 'other broker'),
		-- 6. Running, under this lease, not run out.
		('6: queued', format($q$update public.qorpera_code_requests set state = 'queued' where %s$q$, pg_temp.imp_where())),
		('6: another executor', 'owner'),
		('6: another token', 'token'),
		('6: another executor''s lease', format($q$update public.qorpera_code_requests set lease_owner = 'exec-old' where %s$q$,
			pg_temp.imp_where())),
		('6: a lease that ran out', format($q$update public.qorpera_code_requests set lease_until = clock_timestamp()
			- interval '1 second' where %s$q$, pg_temp.imp_where())),
		-- 7. The one enabled executor of the company.
		('7: two executors', $q$insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses)
			values ('92400000-0000-4000-8000-000000000020', 'exec-other', true, array['codex'])$q$),
		('7: the executor switched off', $q$update public.qorpera_coding_executors set enabled = false
			where owner = 'exec-530'$q$),
		('7: another one enabled', $q$update public.qorpera_coding_executors set enabled = false where owner = 'exec-530';
			insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses)
			values ('92400000-0000-4000-8000-000000000020', 'exec-other', true, array['codex'])$q$),
		-- 8. Not being deleted.
		('8: being deleted', $q$insert into public.qorpera_company_deletions(profile_id) values ('92400000-0000-4000-8000-000000000010')$q$),
		-- 9. Through the connection, of a GitHub repository.
		('9: public', format($q$update public.qorpera_code_requests set input = jsonb_set(input, '{via}', '"public"')
			where %s$q$, pg_temp.imp_where())),
		('9: a file', format($q$update public.qorpera_code_requests set input = jsonb_set(input, '{from}',
			'{"file":"code/_incoming/f/a.bundle"}') where %s$q$, pg_temp.imp_where())),
		('9: GitHub with a path', format($q$update public.qorpera_code_requests set input = jsonb_set(input, '{from,github}',
			'"Acme/Shop/x"') where %s$q$, pg_temp.imp_where())),
		('9: no GitHub repository', format($q$update public.qorpera_code_requests set input = jsonb_set(input, '{from,github}',
			'"-acme/Shop"') where %s$q$, pg_temp.imp_where())),
		-- 10. Only its fetch: the step names fetch, no bytes are in, no look.
		('10: another step', format($q$update public.qorpera_code_requests set progress = '{"step":"look"}' where %s$q$,
			pg_temp.imp_where())),
		('10: no step', format($q$update public.qorpera_code_requests set progress = null where %s$q$, pg_temp.imp_where())),
		('10: the bytes are in', format($q$update public.qorpera_code_requests set progress = '{"step":"fetch","raw":{}}'
			where %s$q$, pg_temp.imp_where())),
		('10: a look', format($q$update public.qorpera_code_requests set look = '{}' where %s$q$, pg_temp.imp_where())),
		-- 11. Not recorded: no repository at its place.
		('11: a repository at the place', $q$insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
			values ('92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010', 'company', 'shop')$q$),
		-- 12. The agent, active, with a live grant on the connection from a current owner or admin; its member.
		('12: the agent archived', $q$update public.qorpera_profile_staff set employment_status = 'archived'
			where staff_agent_id = '92400000-0000-4000-8000-000000000030'$q$),
		('12: the grant revoked', $q$update public.qorpera_cloud_secret_operation_grants set status = 'revoked',
			revoked_at = clock_timestamp() where id = '12300000-0000-4000-8000-000000000062'$q$),
		('12: the grant expired', $q$update public.qorpera_cloud_secret_operation_grants set created_at = created_at
			- interval '1 hour', expires_at = created_at - interval '30 minutes' where id = '12300000-0000-4000-8000-000000000062'$q$),
		('12: the grant another agent''s', $q$update public.qorpera_cloud_secret_operation_grants
			set staff_agent_id = '92400000-0000-4000-8000-000000000031' where id = '12300000-0000-4000-8000-000000000062'$q$),
		('12: the grant''s issuer demoted', $q$update public.qorpera_cloud_secret_operation_grants
			set issued_by_user_id = '92400000-0000-4000-8000-000000000002' where id = '12300000-0000-4000-8000-000000000062'$q$),
		-- (The grant's issuer the admin, so that only the member's row tells.)
		('12: the member a viewer', $q$update public.qorpera_profile_members set role = 'viewer'
			where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
			update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000004'
			where id = '12300000-0000-4000-8000-000000000062'$q$),
		('12: the member gone', $q$delete from public.qorpera_profile_members
			where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
			update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000004'
			where id = '12300000-0000-4000-8000-000000000062'$q$),
		('12: no agent', format($q$update public.qorpera_code_requests set by_agent_id = null where %s$q$, pg_temp.imp_where())),
		('12: an operator''s', format($q$update public.qorpera_code_requests set by_kind = 'operator' where %s$q$,
			pg_temp.imp_where())),
		-- 14. The company's own GitHub connection, active, sealed by this broker.
		('14: a member''s secret', $q$update public.qorpera_cloud_secrets set owner_kind = 'member',
			owner_user_id = '92400000-0000-4000-8000-000000000001' where id = '12300000-0000-4000-8000-000000000061'$q$),
		('14: another connector', $q$update public.qorpera_cloud_secrets set connector_id = 'gitlab'
			where id = '12300000-0000-4000-8000-000000000061'$q$),
		('14: another name', $q$update public.qorpera_cloud_secrets set secret_name = 'second'
			where id = '12300000-0000-4000-8000-000000000061'$q$),
		('14: revoked', $q$update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp()
			where id = '12300000-0000-4000-8000-000000000061'$q$),
		('14: another broker''s', $q$update public.qorpera_cloud_secrets set broker_authority_id = '53000000-0000-4000-8000-000000000041'
			where id = '12300000-0000-4000-8000-000000000061'$q$),
		-- 15. Its current version under this broker's key.
		('15: another key', $q$update public.qorpera_cloud_secret_versions set key_id = 'company-kek-2'
			where secret_id = '12300000-0000-4000-8000-000000000061'$q$),
		('15: another version', $q$update public.qorpera_cloud_secrets set current_version = 2
			where id = '12300000-0000-4000-8000-000000000061'$q$)) as cases(what, change)
	loop
		v_result := case v_case.change
			when 'capability' then pg_temp.mcp_fetch(v_request, v_lease, p_capability => repeat('7', 64))
			when 'other broker' then pg_temp.mcp_fetch(v_request, v_lease, p_authority => '53000000-0000-4000-8000-000000000041',
				p_capability => repeat('8', 64))
			when 'owner' then pg_temp.mcp_fetch(v_request, v_lease, 'exec-other')
			when 'token' then pg_temp.mcp_fetch(v_request, '12300000-0000-4000-8000-0000000000ff')
			else case when v_case.change is null then pg_temp.mcp_fetch('12300000-0000-4000-8000-0000000000fe', v_lease)
				else pg_temp.imp_after(v_case.change) end end;
		perform pg_temp.base_assert(v_result = v_refused, v_case.what || ': ' || v_result);
	end loop;
	perform pg_temp.base_assert(pg_temp.mcp_used('repository_import_fetch_used') = v_used, 'a refusal writes no audit row');
	-- And the answer is still there when nothing failed.
	perform pg_temp.base_assert(pg_temp.imp_fetch() like 'ok:%', 'still answered');
end $$;

-- 4. A member's import, and an agent's that names no member -------------------------------------------------------------
do $$
declare v_result text;
begin
	-- An agent's request that names no member checks none.
	v_result := pg_temp.imp_after(format($q$update public.qorpera_code_requests set by_user_id = null where %s$q$,
		pg_temp.imp_where()));
	perform pg_temp.base_assert(v_result like 'ok:%', 'an agent''s with no member: ' || v_result);
	-- An agent's member may be a contributor.
	v_result := pg_temp.imp_after($q$update public.qorpera_profile_members set role = 'contributor'
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
		update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000004'
		where id = '12300000-0000-4000-8000-000000000062'$q$);
	perform pg_temp.base_assert(v_result like 'ok:%', 'a contributor''s agent: ' || v_result);
	-- A member's: no grant needed, while the member is an owner or admin; a contributor is not.
	v_result := pg_temp.imp_after(format($q$update public.qorpera_code_requests set by_kind = 'member', by_agent_id = null
		where %s; delete from public.qorpera_cloud_secret_operation_grants$q$, pg_temp.imp_where()));
	perform pg_temp.base_assert(v_result like 'ok:%', 'a member''s: ' || v_result);
	v_result := pg_temp.imp_after(format($q$update public.qorpera_code_requests set by_kind = 'member', by_agent_id = null
		where %s; update public.qorpera_profile_members set role = 'admin'
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001'$q$,
		pg_temp.imp_where()));
	perform pg_temp.base_assert(v_result like 'ok:%', 'an admin''s: ' || v_result);
	v_result := pg_temp.imp_after(format($q$update public.qorpera_code_requests set by_kind = 'member', by_agent_id = null
		where %s; update public.qorpera_profile_members set role = 'contributor'
		where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001'$q$,
		pg_temp.imp_where()));
	perform pg_temp.base_assert(v_result = '42501:code import fetch is unavailable', 'a contributor''s own: ' || v_result);
	v_result := pg_temp.imp_after(format($q$update public.qorpera_code_requests set by_kind = 'member', by_agent_id = null,
		by_user_id = null where %s$q$, pg_temp.imp_where()));
	perform pg_temp.base_assert(v_result = '42501:code import fetch is unavailable', 'a member''s naming nobody: ' || v_result);
	-- A member's needs the company's own connection as much (no grant stands in front of it).
	foreach v_result in array array[
		$q$update public.qorpera_cloud_secrets set owner_kind = 'member', owner_user_id = '92400000-0000-4000-8000-000000000001'
			where id = '12300000-0000-4000-8000-000000000061'$q$,
		$q$update public.qorpera_cloud_secrets set connector_id = 'gitlab' where id = '12300000-0000-4000-8000-000000000061'$q$,
		$q$update public.qorpera_cloud_secrets set secret_name = 'second' where id = '12300000-0000-4000-8000-000000000061'$q$,
		$q$update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp()
			where id = '12300000-0000-4000-8000-000000000061'$q$] loop
		perform pg_temp.base_assert(pg_temp.imp_after(format($q$update public.qorpera_code_requests set by_kind = 'member',
			by_agent_id = null where %s; %s$q$, pg_temp.imp_where(), v_result)) = '42501:code import fetch is unavailable',
			'a member''s, with a connection not the company''s own: ' || v_result);
	end loop;
end $$;

-- 5. The session path is as it was ---------------------------------------------------------------------------------------
do $$
declare v_result text := pg_temp.mcp_fetch_now();
begin
	-- Alice's session b1 (Qorpera/Qorpera_Base) fetches through the same connection and grant, with its own audit row.
	perform pg_temp.base_assert(v_result = '61' and (select count(*) from public.qorpera_cloud_secret_audit_events
		where event_type = 'repository_fetch_used' and coding_worker_id = current_setting('qorpera_test.mcp_worker')::uuid
			and code_request_id is null) = 1, 'the session''s fetch: ' || v_result);
	-- Its lease is the session's: the import's lease does not open it, nor the session's the import.
	perform pg_temp.base_assert(pg_temp.mcp_fetch(current_setting('qorpera_test.mcp_worker')::uuid,
			current_setting('qorpera_test.imp_lease')::uuid) = '42501:coding session lease is unavailable'
		and pg_temp.mcp_fetch(current_setting('qorpera_test.imp_request')::uuid,
			current_setting('qorpera_test.mcp_lease')::uuid) = '42501:code import fetch is unavailable', 'two leases');
	perform pg_temp.base_assert(position('20260930736000' in pg_get_functiondef(
		'public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)'::regprocedure)) > 0
		and position('qorpera_coding_relay_session' in pg_get_functiondef(
		'public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)'::regprocedure)) > 0, 'the patched body');
	foreach v_result in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_result,
			'public.qorpera_authorize_code_import_fetch(uuid,text,uuid,uuid,text)', 'EXECUTE')
			and has_function_privilege(v_result, 'public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)',
				'EXECUTE') = (v_result = 'qorpera_secret_broker'), 'who may call: ' || v_result);
	end loop;
end $$;

rollback;
