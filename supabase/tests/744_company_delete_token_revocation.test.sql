-- @fixture 715_company_delete_after_runs.test.sql until "-- 5. A machine still on a node keeps the deletion waiting"
-- 20260928269500: a connected account's tokens are revoked upstream on Disconnect and when the company
-- is deleted. Every version of a Gmail, Drive or GitHub secret that goes active→revoked is queued; the
-- finisher revokes a deleting company's connector secrets, waits for its queue (at most six hours) and
-- marks what is still open abandoned before the purge. A Google account still connected in a living
-- company is not revoked at Google (option A), nor is an older version of a Google secret; a
-- disconnected Google entry waits ten minutes. The ledger outlives the purge.
reset role;
create function pg_temp.token_refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;
create function pg_temp.token_finish() returns jsonb language sql as $$
	select public.qorpera_finish_company_deletion('30000000-0000-4000-8000-000000000010')
$$;
create function pg_temp.token_rows() returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(secret_id::text || '/' || version, jsonb_build_object('reason', reason,
		'outcome', outcome, 'attempts', attempts)), '{}')
	from public.qorpera_connector_token_revocations
$$;
-- A secret with its versions, inserted as the capture would leave it.
create function pg_temp.token_secret(p_id uuid, p_profile uuid, p_authority uuid, p_owner uuid, p_connector text,
	p_name text, p_label text, p_versions integer) returns void language plpgsql as $$
declare v_key text := (select key_id from public.qorpera_cloud_secret_broker_authorities where id = p_authority);
begin
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		connector_id, secret_name, purpose, current_version, created_by_user_id, account_label)
	select p_id, p_profile, environment.id, p_authority, 'company', p_connector, p_name, 'Connected account',
		p_versions, p_owner, p_label
	from public.qorpera_company_environments as environment where environment.profile_id = p_profile
	order by environment.created_at limit 1;
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id,
		encrypted_envelope, envelope_sha256, created_by_user_id)
	select p_id, version, p_authority, v_key, envelope, encode(extensions.digest(envelope, 'sha256'), 'hex'), p_owner
	from generate_series(1, p_versions) as version
	cross join lateral (select extensions.gen_random_bytes(64) || convert_to(p_id::text || version, 'UTF8') as envelope) as sealed;
end
$$;
create function pg_temp.token_claim(p_authority uuid, p_capability text, p_limit integer) returns jsonb
language plpgsql as $$
declare v_claimed jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v_claimed := public.qorpera_claim_connector_token_revocations(p_authority, p_capability, p_limit);
	reset session authorization;
	return v_claimed;
end
$$;
grant execute on function pg_temp.token_claim(uuid, text, integer) to qorpera_secret_broker;
create function pg_temp.token_complete(p_authority uuid, p_capability text, p_secret uuid, p_version bigint,
	p_outcome text, p_error text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v_result := public.qorpera_complete_connector_token_revocation(p_authority, p_capability, p_secret, p_version,
		p_outcome, p_error);
	reset session authorization;
	return v_result;
end
$$;
grant execute on function pg_temp.token_complete(uuid, text, uuid, bigint, text, text) to qorpera_secret_broker;
create function pg_temp.token_ids(p_claimed jsonb) returns text[] language sql as $$
	select coalesce(array_agg((item ->> 'secretId') || '/' || (item ->> 'secretVersion')
		order by item ->> 'secretId', item ->> 'secretVersion'), '{}')
	from jsonb_array_elements(p_claimed) as item
$$;

-- A third company, deleted too but not yet finished: its Google account does not keep another's
-- token (only a living company's connection counts).
insert into auth.users(id, email) values ('30000000-0000-4000-8000-000000000006', 'token-third@example.test');
select set_config('request.jwt.claims',
	'{"sub":"30000000-0000-4000-8000-000000000006","email":"token-third@example.test","role":"authenticated","user_metadata":{}}', true);
set local role authenticated;
select set_config('qorpera_test.token_third',
	public.qorpera_create_hosted_profile('Third company', 'main', 1) ->> 'profile_id', true);
reset role;

-- Each company's broker authority.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values
	('30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test',
		'company-kek-1', repeat('c', 64)),
	('30000000-0000-4000-8000-0000000002a1', current_setting('qorpera_test.delete_neighbour')::uuid,
		'https://secrets.qorpera.test', 'neighbour-kek-1', repeat('e', 64)),
	('30000000-0000-4000-8000-0000000002a2', current_setting('qorpera_test.token_third')::uuid,
		'https://secrets.qorpera.test', 'third-kek-1', repeat('f', 64));

-- The deleted company's connections (captured after the request, as a late capture would be):
--   b1 Gmail of an account the neighbour still has connected (two versions);
--   b2 Drive of its own account; b3 GitHub; b4 Gmail of the third company's account; b5 Gmail with
--   no account name; b6 a non-connector secret; b7 Gmail of its own account, reconnected once; b8
--   GitHub reconnected once.
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b1', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'gmail', 'primary',
	'shared@example.test', 2);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b2', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'google_drive', 'primary',
	'solo@example.test', 1);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b3', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'github', 'primary',
	'octocat', 1);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b4', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'gmail', 'second',
	'third@example.test', 1);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b5', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'gmail', 'unnamed',
	null, 1);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b6', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'canary', 'primary',
	null, 1);
-- b8: GitHub reconnected once: each version is its own token.
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b8', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'github', 'second',
	'octocat', 2);
-- b7: Gmail reconnected once (two versions) of an account nobody else has.
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002b7', '30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-0000000002a0', '30000000-0000-4000-8000-000000000001', 'gmail', 'third',
	'solo2@example.test', 2);
-- The neighbour: the same Google account (another case), a GitHub connection it disconnects, a Gmail
-- (c3) and a Drive of the account its Gmail c1 still has (c4), both disconnected, and a member's own
-- GitHub connection (c5) that goes with the member.
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002c1', current_setting('qorpera_test.delete_neighbour')::uuid,
	'30000000-0000-4000-8000-0000000002a1', '30000000-0000-4000-8000-000000000005', 'gmail', 'primary',
	'Shared@Example.test', 1);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002c2', current_setting('qorpera_test.delete_neighbour')::uuid,
	'30000000-0000-4000-8000-0000000002a1', '30000000-0000-4000-8000-000000000005', 'github', 'primary',
	'octocat', 1);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002c3', current_setting('qorpera_test.delete_neighbour')::uuid,
	'30000000-0000-4000-8000-0000000002a1', '30000000-0000-4000-8000-000000000005', 'gmail', 'second',
	'neighbour@example.test', 1);
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002c4', current_setting('qorpera_test.delete_neighbour')::uuid,
	'30000000-0000-4000-8000-0000000002a1', '30000000-0000-4000-8000-000000000005', 'google_drive', 'primary',
	'shared@example.test', 1);
insert into auth.users(id, email) values ('30000000-0000-4000-8000-000000000007', 'token-member@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.delete_neighbour')::uuid, '30000000-0000-4000-8000-000000000007',
	'token-member@example.test', 'Token member', 'contributor');
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002c5', current_setting('qorpera_test.delete_neighbour')::uuid,
	'30000000-0000-4000-8000-0000000002a1', '30000000-0000-4000-8000-000000000007', 'github', 'mine', 'octo-member', 1);
update public.qorpera_cloud_secrets set owner_kind = 'member', owner_user_id = '30000000-0000-4000-8000-000000000007'
where id = '30000000-0000-4000-8000-0000000002c5';
-- The third company: the account of b4, then its deletion.
select pg_temp.token_secret('30000000-0000-4000-8000-0000000002d1', current_setting('qorpera_test.token_third')::uuid,
	'30000000-0000-4000-8000-0000000002a2', '30000000-0000-4000-8000-000000000006', 'gmail', 'primary',
	'third@example.test', 1);
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000006');
set local role authenticated;
select public.qorpera_delete_hosted_profile(current_setting('qorpera_test.token_third')::uuid);
reset role;
select pg_temp.wake_assert(pg_temp.token_rows() = '{}', 'Nothing is queued before a revoke');

-- 1. Disconnect in a living company queues each version of that connection only.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000005');
set local role authenticated;
select public.qorpera_revoke_cloud_secret(current_setting('qorpera_test.delete_neighbour')::uuid, secret)
from unnest(array['30000000-0000-4000-8000-0000000002c2', '30000000-0000-4000-8000-0000000002c3',
	'30000000-0000-4000-8000-0000000002c4']::uuid[]) as secret;
reset role;
-- A member's removal revokes the member's own connection, which is queued the same way.
delete from public.qorpera_profile_members
where profile_id = current_setting('qorpera_test.delete_neighbour')::uuid
	and user_id = '30000000-0000-4000-8000-000000000007';
select pg_temp.wake_assert(pg_temp.token_rows() = '{
		"30000000-0000-4000-8000-0000000002c2/1": {"reason": "disconnected", "outcome": null, "attempts": 0},
		"30000000-0000-4000-8000-0000000002c3/1": {"reason": "disconnected", "outcome": null, "attempts": 0},
		"30000000-0000-4000-8000-0000000002c4/1": {"reason": "disconnected", "outcome": null, "attempts": 0},
		"30000000-0000-4000-8000-0000000002c5/1": {"reason": "disconnected", "outcome": null, "attempts": 0}}'::jsonb,
	'Disconnect and a member''s removal queue their connections');

-- 2. The finisher revokes the deleted company's connector secrets and their grants, and waits for them.
insert into public.qorpera_cloud_secret_operation_grants(profile_id, environment_id, secret_id, staff_agent_id,
	connector_id, operation_id, operation_version, tool_name, issued_by_user_id)
select secret.profile_id, secret.environment_id, secret.id, staff.staff_agent_id, 'github', 'get_issue', 1,
	'github_get_issue', '30000000-0000-4000-8000-000000000001'
from public.qorpera_cloud_secrets as secret
cross join lateral (select staff_agent_id from public.qorpera_profile_staff
	where profile_id = secret.profile_id order by staff_agent_id limit 1) as staff
where secret.id = '30000000-0000-4000-8000-0000000002b3';
select set_config('qorpera_test.token_waiting', pg_temp.token_finish()::text, true);
do $$
declare v_result jsonb := current_setting('qorpera_test.token_waiting')::jsonb;
begin
	if v_result ->> 'state' <> 'waiting' or v_result #>> '{holdings,connector_tokens}' <> '10'
		or (select holdings ->> 'connector_tokens' from public.qorpera_company_deletions
			where profile_id = '30000000-0000-4000-8000-000000000010') <> '10' then
		raise exception 'The finisher did not wait for the queue: %', v_result;
	end if;
	if exists (select 1 from public.qorpera_cloud_secrets
			where profile_id = '30000000-0000-4000-8000-000000000010' and status = 'active'
				and connector_id in ('gmail', 'google_drive', 'github'))
		or (select status from public.qorpera_cloud_secrets where id = '30000000-0000-4000-8000-0000000002b6') <> 'active'
		or exists (select 1 from public.qorpera_cloud_secret_operation_grants
			where secret_id = '30000000-0000-4000-8000-0000000002b3' and status = 'active')
		or (select status from public.qorpera_cloud_secrets where id = '30000000-0000-4000-8000-0000000002c1') <> 'active' then
		raise exception 'The finisher revoked the wrong secrets';
	end if;
	if (select count(*) from public.qorpera_connector_token_revocations
			where profile_id = '30000000-0000-4000-8000-000000000010' and reason = 'company_deleted'
				and broker_authority_id = '30000000-0000-4000-8000-0000000002a0') <> 10 then
		raise exception 'The deleted company''s versions were not queued: %', pg_temp.token_rows();
	end if;
end
$$;

-- 3. The broker claims: the neighbour's still connected account (any case) and the unnamed one are
-- kept; the third company's account does not count, since that company is being deleted too; a Google
-- secret's older version is superseded by its current one.
select pg_temp.token_refused($q$select public.qorpera_claim_connector_token_revocations(
	'30000000-0000-4000-8000-0000000002a0', repeat('c', 64), 5)$q$, '42501');
select pg_temp.token_refused($q$select pg_temp.token_claim('30000000-0000-4000-8000-0000000002a0', repeat('d', 64), 5)$q$,
	'42501');
select pg_temp.token_refused($q$select pg_temp.token_claim('30000000-0000-4000-8000-0000000002a0', repeat('c', 64), 0)$q$,
	'22023');
select pg_temp.token_refused($q$select pg_temp.token_claim('30000000-0000-4000-8000-0000000002a0', repeat('c', 64), 21)$q$,
	'22023');
select set_config('qorpera_test.token_claimed',
	pg_temp.token_claim('30000000-0000-4000-8000-0000000002a0', repeat('c', 64), 20)::text, true);
do $$
declare
	v_claimed jsonb := current_setting('qorpera_test.token_claimed')::jsonb;
	v_github jsonb;
begin
	if pg_temp.token_ids(v_claimed) <> array['30000000-0000-4000-8000-0000000002b2/1',
			'30000000-0000-4000-8000-0000000002b3/1', '30000000-0000-4000-8000-0000000002b4/1',
			'30000000-0000-4000-8000-0000000002b7/2', '30000000-0000-4000-8000-0000000002b8/1',
			'30000000-0000-4000-8000-0000000002b8/2'] then
		raise exception 'The broker claimed the wrong entries: %', v_claimed;
	end if;
	-- One base64 line each (Postgres itself breaks lines at 76 characters).
	if exists (select 1 from jsonb_array_elements(v_claimed) as item
			where item ->> 'encryptedEnvelopeBase64' ~ '[\r\n]'
				or length(item ->> 'encryptedEnvelopeBase64') <= 76) then
		raise exception 'A claimed envelope is not one base64 line';
	end if;
	select item into v_github from jsonb_array_elements(v_claimed) as item
	where item ->> 'secretId' = '30000000-0000-4000-8000-0000000002b3';
	if v_github - 'encryptedEnvelopeBase64' <> jsonb_build_object('schema', 'qorpera.connector-token-revocation/v1',
			'companyId', '30000000-0000-4000-8000-000000000010',
			'environmentId', (select environment_id from public.qorpera_cloud_secrets
				where id = '30000000-0000-4000-8000-0000000002b3'),
			'secretId', '30000000-0000-4000-8000-0000000002b3', 'secretVersion', 1, 'keyId', 'company-kek-1',
			'connectorId', 'github',
			'envelopeSha256', (select envelope_sha256 from public.qorpera_cloud_secret_versions
				where secret_id = '30000000-0000-4000-8000-0000000002b3'))
		or decode(v_github ->> 'encryptedEnvelopeBase64', 'base64') <> (select encrypted_envelope
			from public.qorpera_cloud_secret_versions where secret_id = '30000000-0000-4000-8000-0000000002b3') then
		raise exception 'A claimed entry differs: %', v_github;
	end if;
	if (select jsonb_object_agg(secret_id::text || '/' || version, outcome) from public.qorpera_connector_token_revocations
			where secret_id in ('30000000-0000-4000-8000-0000000002b1', '30000000-0000-4000-8000-0000000002b5',
				'30000000-0000-4000-8000-0000000002b7') and outcome is not null)
		<> '{"30000000-0000-4000-8000-0000000002b1/1": "superseded", "30000000-0000-4000-8000-0000000002b1/2": "kept_shared",
			"30000000-0000-4000-8000-0000000002b5/1": "kept_shared", "30000000-0000-4000-8000-0000000002b7/1": "superseded"}'::jsonb then
		raise exception 'A still connected, unnamed or older Google version was not kept: %', pg_temp.token_rows();
	end if;
	-- Leased: nothing more now; the neighbour's broker sees only its own GitHub entries (its Google ones
	-- wait ten minutes after the Disconnect).
	if pg_temp.token_claim('30000000-0000-4000-8000-0000000002a0', repeat('c', 64), 20) <> '[]'
		or pg_temp.token_ids(pg_temp.token_claim('30000000-0000-4000-8000-0000000002a1', repeat('e', 64), 20))
			<> array['30000000-0000-4000-8000-0000000002c2/1', '30000000-0000-4000-8000-0000000002c5/1'] then
		raise exception 'A leased, waiting or another broker''s entry was claimed';
	end if;
end
$$;
-- Ten minutes after the Disconnect: the neighbour's Drive is kept (its Gmail has the same account), its
-- other Gmail is claimed.
update public.qorpera_connector_token_revocations set requested_at = requested_at - interval '11 minutes'
where secret_id in ('30000000-0000-4000-8000-0000000002c3', '30000000-0000-4000-8000-0000000002c4');
do $$
begin
	if pg_temp.token_ids(pg_temp.token_claim('30000000-0000-4000-8000-0000000002a1', repeat('e', 64), 20))
			<> array['30000000-0000-4000-8000-0000000002c3/1'] then
		raise exception 'A disconnected Google entry was not due after ten minutes';
	end if;
end
$$;
do $$
begin
	if (select outcome from public.qorpera_connector_token_revocations
			where secret_id = '30000000-0000-4000-8000-0000000002c4') <> 'kept_shared' then
		raise exception 'A Drive of an account the same company still has on Gmail was not kept';
	end if;
end
$$;

-- 4. Completion: an outcome is kept once given; an error offers the entry again later; another broker
-- or an unknown entry is refused.
do $$
declare v_result jsonb;
begin
	v_result := pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
		'30000000-0000-4000-8000-0000000002b2', 1, 'revoked', null);
	if v_result ->> 'outcome' <> 'revoked'
		or pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
			'30000000-0000-4000-8000-0000000002b2', 1, 'already_invalid', null) ->> 'outcome' <> 'revoked'
		or pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
			'30000000-0000-4000-8000-0000000002b2', 1, null, 'late failure') ->> 'outcome' <> 'revoked' then
		raise exception 'A completed entry changed';
	end if;
	perform pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
		'30000000-0000-4000-8000-0000000002b4', 1, 'already_invalid', null);
	perform pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
		'30000000-0000-4000-8000-0000000002b3', 1, null, '  GitHub answered 502  ');
	perform pg_temp.token_complete('30000000-0000-4000-8000-0000000002a1', repeat('e', 64),
		'30000000-0000-4000-8000-0000000002c2', 1, 'not_ours', null);
	perform pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
		'30000000-0000-4000-8000-0000000002b7', 2, 'revoked', null);
	perform pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
		'30000000-0000-4000-8000-0000000002b8', version, 'revoked', null)
	from generate_series(1, 2) as version;
end
$$;
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a1', repeat('e', 64),
	'30000000-0000-4000-8000-0000000002b3', 1, 'revoked', null)$q$, 'P0002');
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
	'30000000-0000-4000-8000-0000000002b3', 9, 'revoked', null)$q$, 'P0002');
-- A wrong capability learns nothing: 42501 whether the entry is missing, another broker's or its own.
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('d', 64),
	'30000000-0000-4000-8000-0000000002b3', 9, 'revoked', null)$q$, '42501');
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a1', repeat('d', 64),
	'30000000-0000-4000-8000-0000000002b3', 1, 'revoked', null)$q$, '42501');
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('d', 64),
	'30000000-0000-4000-8000-0000000002b3', 1, 'revoked', null)$q$, '42501');
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
	'30000000-0000-4000-8000-0000000002b3', 1, 'revoked', 'both')$q$, '22023');
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
	'30000000-0000-4000-8000-0000000002b3', 1, 'kept_shared', null)$q$, '22023');
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
	'30000000-0000-4000-8000-0000000002b3', 1, null, '   ')$q$, '22023');
select pg_temp.token_refused($q$select public.qorpera_complete_connector_token_revocation(
	'30000000-0000-4000-8000-0000000002a0', repeat('c', 64), '30000000-0000-4000-8000-0000000002b3', 1, 'revoked')$q$,
	'42501');
select pg_temp.wake_assert((select last_error = 'GitHub answered 502' and outcome is null and attempts = 1
		and lease_until between clock_timestamp() + interval '50 seconds' and clock_timestamp() + interval '70 seconds'
		from public.qorpera_connector_token_revocations where secret_id = '30000000-0000-4000-8000-0000000002b3')
	and pg_temp.token_claim('30000000-0000-4000-8000-0000000002a0', repeat('c', 64), 20) = '[]',
	'A failed entry waits a minute before it is offered again');

-- 5. The finisher still waits for the open entry. A version that is gone completes without the broker.
select pg_temp.wake_assert(pg_temp.token_finish() #>> '{holdings,connector_tokens}' = '1',
	'The finisher waits for the last open entry');
savepoint envelope_gone;
update public.qorpera_connector_token_revocations set lease_until = null
where secret_id = '30000000-0000-4000-8000-0000000002b3';
delete from public.qorpera_cloud_secret_versions where secret_id = '30000000-0000-4000-8000-0000000002b3';
select set_config('qorpera_test.token_gone',
	pg_temp.token_claim('30000000-0000-4000-8000-0000000002a0', repeat('c', 64), 20)::text, true);
select pg_temp.wake_assert(current_setting('qorpera_test.token_gone') = '[]'
	and (select outcome from public.qorpera_connector_token_revocations
		where secret_id = '30000000-0000-4000-8000-0000000002b3') = 'envelope_gone',
	'An entry whose version is gone completes as envelope_gone');
rollback to envelope_gone;

-- 6. The six hours run from the later of the request and the entry: either alone keeps it waiting.
savepoint request_old;
update public.qorpera_company_deletions set requested_at = requested_at - interval '7 hours'
where profile_id = '30000000-0000-4000-8000-000000000010';
select pg_temp.wake_assert(pg_temp.token_finish() ->> 'state' = 'waiting', 'An entry queued lately still waits');
rollback to request_old;
savepoint entry_old;
update public.qorpera_connector_token_revocations set requested_at = requested_at - interval '7 hours'
where profile_id = '30000000-0000-4000-8000-000000000010';
select pg_temp.wake_assert(pg_temp.token_finish() ->> 'state' = 'waiting', 'A deletion requested lately still waits');
rollback to entry_old;
-- Six hours after both, the finisher stops waiting: the open entry is abandoned right before the purge,
-- and the ledger outlives the company.
update public.qorpera_company_deletions set requested_at = requested_at - interval '7 hours'
where profile_id = '30000000-0000-4000-8000-000000000010';
update public.qorpera_connector_token_revocations set requested_at = requested_at - interval '7 hours'
where profile_id = '30000000-0000-4000-8000-000000000010';
select pg_temp.wake_assert(pg_temp.token_finish() ->> 'state' = 'purged', 'The company is purged after the deadline');
select pg_temp.wake_assert(pg_temp.token_rows() - array['30000000-0000-4000-8000-0000000002c3/1',
		'30000000-0000-4000-8000-0000000002c4/1', '30000000-0000-4000-8000-0000000002c5/1',
		'30000000-0000-4000-8000-0000000002b7/1', '30000000-0000-4000-8000-0000000002b7/2',
		'30000000-0000-4000-8000-0000000002b8/1', '30000000-0000-4000-8000-0000000002b8/2'] = jsonb_build_object(
		'30000000-0000-4000-8000-0000000002b1/1', jsonb_build_object('reason', 'company_deleted', 'outcome', 'superseded', 'attempts', 0),
		'30000000-0000-4000-8000-0000000002b1/2', jsonb_build_object('reason', 'company_deleted', 'outcome', 'kept_shared', 'attempts', 0),
		'30000000-0000-4000-8000-0000000002b2/1', jsonb_build_object('reason', 'company_deleted', 'outcome', 'revoked', 'attempts', 1),
		'30000000-0000-4000-8000-0000000002b3/1', jsonb_build_object('reason', 'company_deleted', 'outcome', 'abandoned', 'attempts', 1),
		'30000000-0000-4000-8000-0000000002b4/1', jsonb_build_object('reason', 'company_deleted', 'outcome', 'already_invalid', 'attempts', 1),
		'30000000-0000-4000-8000-0000000002b5/1', jsonb_build_object('reason', 'company_deleted', 'outcome', 'kept_shared', 'attempts', 0),
		'30000000-0000-4000-8000-0000000002c2/1', jsonb_build_object('reason', 'disconnected', 'outcome', 'not_ours', 'attempts', 1))
	and not exists (select 1 from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010')
	and not exists (select 1 from public.qorpera_cloud_secrets where profile_id = '30000000-0000-4000-8000-000000000010')
	and (select status from public.qorpera_cloud_secrets where id = '30000000-0000-4000-8000-0000000002c1') = 'active',
	'The ledger keeps the receipts after the purge; the neighbour keeps its connection');
-- A late answer for the purged company is refused: its authority went with it.
select pg_temp.token_refused($q$select pg_temp.token_complete('30000000-0000-4000-8000-0000000002a0', repeat('c', 64),
	'30000000-0000-4000-8000-0000000002b3', 1, 'revoked', null)$q$, '42501');

-- 7. Nothing here is open to members or the service role.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		if has_table_privilege(v_role, 'public.qorpera_connector_token_revocations', 'SELECT')
			or has_function_privilege(v_role, 'public.qorpera_claim_connector_token_revocations(uuid,text,integer)', 'EXECUTE')
			or has_function_privilege(v_role,
				'public.qorpera_complete_connector_token_revocation(uuid,text,uuid,bigint,text,text)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_revoke_company_connector_secrets(uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_abandon_company_token_revocations(uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_company_token_revocations_open(uuid)', 'EXECUTE') then
			raise exception 'Token revocation is open to %', v_role;
		end if;
	end loop;
	if has_table_privilege('qorpera_secret_broker', 'public.qorpera_connector_token_revocations', 'SELECT')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_revoke_company_connector_secrets(uuid)', 'EXECUTE')
		or not has_function_privilege('qorpera_secret_broker',
			'public.qorpera_claim_connector_token_revocations(uuid,text,integer)', 'EXECUTE') then
		raise exception 'The broker login has the wrong privileges';
	end if;
end
$$;
rollback;
