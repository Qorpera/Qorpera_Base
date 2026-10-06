-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260928339790, on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): only a connection's owner revokes
-- it without the company's authorize role. A company-owned provider connection has no owner, and the owner's clause in
-- qorpera_set_provider_connection_status was NULL for it, so anyone signed in who knew the ids revoked the company's
-- connection. Here the base company's owner registers a company connection and the contributor a personal one. The
-- outsider (no member), the viewer and the contributor are refused revoking or disabling the company's connection, and it
-- stays active; the contributor revokes their own; the admin revokes the company's. On the previous function text the
-- outsider's revocation landed.

-- A provider connection registered through the product's function: the company's by its owner, or a member's own.
create function pg_temp.revoke_register(p_user uuid, p_owner uuid, p_client uuid) returns uuid language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated', p_user);
	return (public.qorpera_register_provider_connection('92400000-0000-4000-8000-000000000010', p_client, p_owner, 'openai',
		'api_key', 'codex', 'secret://revoke-fixture', null, case when p_owner is null then 'company' else 'member' end, 'v1', null,
		'{"monthly_microusd":1000000,"reservation_microusd":1000,"max_calls_per_run":8,"max_input_tokens_per_run":1000,"max_output_tokens_per_run":1000,"max_concurrent_runs":1}')
		->> 'connection_id')::uuid;
end
$$;
-- A status change by `p_user`: its result, or its error.
create function pg_temp.revoke_set(p_user uuid, p_connection uuid, p_status text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated', p_user);
	return jsonb_build_object('result', public.qorpera_set_provider_connection_status('92400000-0000-4000-8000-000000000010',
		p_connection, p_status));
exception when others then
	return jsonb_build_object('state', sqlstate, 'error', sqlerrm);
end
$$;
create function pg_temp.revoke_refused(p_user uuid, p_connection uuid, p_status text, p_label text,
	p_state text default '42501', p_message text default 'provider connection lifecycle requires authorize access')
returns void language plpgsql as $$
declare v_outcome jsonb := pg_temp.revoke_set(p_user, p_connection, p_status);
begin
	perform pg_temp.base_assert(v_outcome ->> 'state' = p_state and v_outcome ->> 'error' = p_message,
		p_label || ' is refused: ' || v_outcome::text);
end
$$;
create function pg_temp.revoke_status(p_connection uuid) returns text language sql as $$
	select status from public.qorpera_provider_connections where id = p_connection
$$;

select set_config('qorpera_test.revoke_company', pg_temp.revoke_register('92400000-0000-4000-8000-000000000001', null,
	'75800000-0000-4000-8000-000000000010')::text, true);
select set_config('qorpera_test.revoke_personal', pg_temp.revoke_register('92400000-0000-4000-8000-000000000002',
	'92400000-0000-4000-8000-000000000002', '75800000-0000-4000-8000-000000000011')::text, true);
select pg_temp.base_assert(owner_user_id is null and status = 'active', 'The company''s connection has no owner')
from public.qorpera_provider_connections where id = current_setting('qorpera_test.revoke_company')::uuid;

-- 1. The company's connection: the outsider, the viewer and the contributor neither revoke nor disable it, and it stays
--    active.
do $$
declare v_user uuid; v_status text;
begin
	foreach v_user in array array['92400000-0000-4000-8000-000000000005', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000002']::uuid[] loop
		foreach v_status in array array['revoked', 'disabled'] loop
			perform pg_temp.revoke_refused(v_user, current_setting('qorpera_test.revoke_company')::uuid, v_status,
				format('%s setting the company''s connection %s', v_user, v_status));
		end loop;
	end loop;
end $$;
select pg_temp.base_assert(pg_temp.revoke_status(current_setting('qorpera_test.revoke_company')::uuid) = 'active',
	'The company''s connection is still active');

-- 2. A member's own connection: the outsider and the viewer do not revoke the contributor's; the contributor does. A
--    connection nobody has: a caller without the role is refused (it got the transition error before); the admin gets the
--    transition error, as before.
select pg_temp.revoke_refused('92400000-0000-4000-8000-000000000005', current_setting('qorpera_test.revoke_personal')::uuid,
	'revoked', 'The outsider revoking the contributor''s connection');
select pg_temp.revoke_refused('92400000-0000-4000-8000-000000000003', current_setting('qorpera_test.revoke_personal')::uuid,
	'revoked', 'The viewer revoking the contributor''s connection');
select pg_temp.revoke_refused('92400000-0000-4000-8000-000000000002', '75800000-0000-4000-8000-000000000099', 'revoked',
	'The contributor revoking a connection nobody has');
select pg_temp.revoke_refused('92400000-0000-4000-8000-000000000004', '75800000-0000-4000-8000-000000000099', 'revoked',
	'The admin revoking a connection nobody has', '55000', 'provider connection lifecycle transition is invalid');
select pg_temp.base_assert(pg_temp.revoke_set('92400000-0000-4000-8000-000000000002',
	current_setting('qorpera_test.revoke_personal')::uuid, 'revoked') #>> '{result,status}' = 'revoked',
	'The contributor revokes their own connection');
select pg_temp.base_assert(pg_temp.revoke_status(current_setting('qorpera_test.revoke_personal')::uuid) = 'revoked',
	'The contributor''s connection is revoked');

-- 3. The admin revokes the company's connection.
select pg_temp.base_assert(pg_temp.revoke_set('92400000-0000-4000-8000-000000000004',
	current_setting('qorpera_test.revoke_company')::uuid, 'revoked') #>> '{result,status}' = 'revoked',
	'The admin revokes the company''s connection');

rollback;
