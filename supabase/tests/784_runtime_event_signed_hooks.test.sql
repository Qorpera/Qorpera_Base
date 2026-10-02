-- @fixture 730_runtime_event_intake.test.sql until "-- Paused hooks refuse; resumed ones take deliveries again"
-- Signed hooks, step W1b (20260929998000): owners create Stripe, GitHub and Standard Webhooks hooks; an owner
-- saves the signing secret through the vault's capture; until then the hook answers not_ready. A signed delivery
-- waits as received; the company's broker claims it with the sealed secret and answers verified (the sender's id
-- and the event's type), duplicate, refused or retry. Claims are the authority's own company's, held 60 seconds;
-- retries wait longer each time and the fifth refuses; a removed hook, a gone secret or one sealed for another
-- authority refuses at the claim, and at the verdict. Removing a hook revokes its secret. The shared vault asks
-- once which of its companies have deliveries due.

-- The broker's calls, as the broker role.
create function pg_temp.vclaim_batch(p_authority uuid, p_capability text, p_limit integer default 16) returns jsonb
language plpgsql as $$
declare v_claimed jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v_claimed := public.qorpera_claim_event_verifications(p_authority, p_capability, p_limit);
	reset session authorization;
	return v_claimed;
end
$$;
grant execute on function pg_temp.vclaim_batch(uuid, text, integer) to qorpera_secret_broker;
-- The claimed deliveries alone, after checking the claim's shape.
create function pg_temp.vclaim(p_authority uuid, p_capability text, p_limit integer default 16) returns jsonb
language plpgsql as $$
declare v_batch jsonb := pg_temp.vclaim_batch(p_authority, p_capability, p_limit);
begin
	perform pg_temp.hook_assert(v_batch ->> 'schema' = 'qorpera.event-verification-claim/v1'
		and (select array_agg(key order by key) from jsonb_object_keys(v_batch) as key) = array['deliveries', 'refused', 'schema'],
		'A claim has its shape: ' || v_batch::text);
	return v_batch -> 'deliveries';
end
$$;
grant execute on function pg_temp.vclaim(uuid, text, integer) to qorpera_secret_broker;
create function pg_temp.vdue(p_capability text default repeat('f', 64)) returns jsonb language plpgsql as $$
declare v_due jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v_due := public.qorpera_broker_principal_event_verifications_due('78400000-0000-4000-8000-0000000002b0', p_capability);
	reset session authorization;
	return v_due;
end
$$;
grant execute on function pg_temp.vdue(text) to qorpera_secret_broker;
create function pg_temp.vfinish(p_delivery uuid, p_claim uuid, p_verdict text, p_key text, p_type text, p_reason text,
	p_authority uuid default '78400000-0000-4000-8000-0000000002a0', p_capability text default repeat('c', 64)) returns jsonb
language plpgsql as $$
declare v_result jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v_result := public.qorpera_finish_event_verification(p_authority, p_capability, p_delivery, p_claim, p_verdict, p_key,
		p_type, p_reason);
	reset session authorization;
	return v_result;
end
$$;
grant execute on function pg_temp.vfinish(uuid, uuid, text, text, text, text, uuid, text) to qorpera_secret_broker;
create function pg_temp.vcomplete(p_ticket jsonb, p_envelope bytea) returns jsonb language plpgsql as $$
declare
	v_capability text := encode(extensions.digest(p_ticket ->> 'captureCapability', 'sha256'), 'hex');
	v_envelope text := encode(extensions.digest(p_envelope, 'sha256'), 'hex');
	v_result jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v_result := public.qorpera_complete_cloud_secret_capture('78400000-0000-4000-8000-0000000002a0', repeat('c', 64),
		(p_ticket ->> 'ticketId')::uuid, v_capability, encode(p_envelope, 'base64'), v_envelope, null);
	reset session authorization;
	return v_result;
end
$$;
grant execute on function pg_temp.vcomplete(jsonb, bytea) to qorpera_secret_broker;
create function pg_temp.delivery(p_id uuid) returns public.qorpera_event_deliveries language sql as $$
	select * from public.qorpera_event_deliveries where id = p_id
$$;
create function pg_temp.post(p_address text, p_body text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.hook_claims('service_role');
	set local role service_role;
	v_result := pg_temp.receive(p_address, p_body, '{"stripe-signature":"t=1790000000,v1=00"}');
	reset role;
	return v_result;
end
$$;
update public.qorpera_event_intake_settings set enabled = true, company_hourly_deliveries = 2000,
	company_hourly_bytes = 67108864;

-- Privileges: the broker's two functions are the broker role's alone; the helpers nobody's.
do $$
declare v_role text; v_function text;
begin
	foreach v_function in array array['public.qorpera_claim_event_verifications(uuid,text,integer)',
		'public.qorpera_finish_event_verification(uuid,text,uuid,uuid,text,text,text,text)',
		'public.qorpera_broker_principal_event_verifications_due(uuid,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
		if not has_function_privilege('qorpera_secret_broker', v_function, 'EXECUTE') then
			raise exception '% lost the broker', v_function; end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_event_hook_secret_name(uuid)',
			'public.qorpera_event_hook_secret(public.qorpera_event_hooks)',
			'public.qorpera_event_hook_revoke_signing_secret()'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
	end loop;
end
$$;

-- The company's broker authority, and another company's, both served by one shared vault (a principal).
insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256,
	registers_companies_created_after)
values ('78400000-0000-4000-8000-0000000002b0', 'https://vault.qorpera.test', 'vault-root-1', repeat('f', 64), now());
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values
	('78400000-0000-4000-8000-0000000002a0', '73000000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test',
		'company-kek-1', repeat('c', 64), '78400000-0000-4000-8000-0000000002b0'),
	('78400000-0000-4000-8000-0000000002a1', '73000000-0000-4000-8000-000000000011', 'https://secrets.qorpera.test',
		'other-kek-1', repeat('e', 64), '78400000-0000-4000-8000-0000000002b0');

-- Owners create signed hooks; the descriptor names the secret to save and says it is not there yet.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.billing', public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'billing', 'Stripe events', 'stripe')::text, true);
select set_config('qorpera_test.prs', public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'prs', 'Pull requests', 'github')::text, true);
select set_config('qorpera_test.backend', public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'backend', 'Our backend', 'hmac-sha256')::text, true);
reset role;
select pg_temp.hook_assert(current_setting('qorpera_test.billing')::jsonb -> 'signingSecret' = jsonb_build_object(
		'connectorId', 'event_hook', 'ready', false,
		'secretName', 'h' || replace(current_setting('qorpera_test.billing')::jsonb ->> 'id', '-', ''))
	and current_setting('qorpera_test.prs')::jsonb #>> '{signingSecret,ready}' = 'false'
	and current_setting('qorpera_test.backend')::jsonb ->> 'proof' = 'hmac-sha256'
	and not (current_setting('qorpera_test.forms')::jsonb ? 'signingSecret'),
	'A signed hook names its secret, and an address hook has none: ' || current_setting('qorpera_test.billing'));

-- Without its secret a signed hook takes nothing.
select pg_temp.hook_assert(pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address', '{"id":"evt_0"}')
	->> 'outcome' = 'not_ready' and pg_temp.rows((current_setting('qorpera_test.billing')::jsonb ->> 'id')::uuid) = 0,
	'A signed hook took a delivery without its secret');

-- An owner saves the secret through the vault's capture; the broker completes it.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.ticket', public.qorpera_begin_cloud_secret_capture('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'company', null, 'event_hook',
	current_setting('qorpera_test.billing')::jsonb #>> '{signingSecret,secretName}', 'Stripe signing secret')::text, true);
reset role;
select set_config('qorpera_test.secret', pg_temp.vcomplete(current_setting('qorpera_test.ticket')::jsonb,
	convert_to('sealed version one', 'UTF8')) ->> 'secretId', true);
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.hook_assert(exists (select 1 from jsonb_array_elements(public.qorpera_list_event_hooks(
		'73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000020')) as hook(value)
	where hook.value ->> 'name' = 'billing' and hook.value #>> '{signingSecret,ready}' = 'true'),
	'A saved secret makes the hook ready');
reset role;

-- A signed delivery waits as received: no key, no type, not verified; it counts toward the budget.
select set_config('qorpera_test.usage', (select coalesce(sum(deliveries), 0) || ',' || coalesce(sum(bytes), 0)
	from public.qorpera_event_intake_usage where profile_id = '73000000-0000-4000-8000-000000000010'), true);
select set_config('qorpera_test.d1', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_1","type":"invoice.paid"}') ->> 'deliveryId', true);
select pg_temp.hook_assert(status = 'received' and delivery_key is null and event_type is null and verified_at is null
		and convert_from(body, 'UTF8') = '{"id":"evt_1","type":"invoice.paid"}' and headers ? 'stripe-signature'
		and verify_claim is null and verify_attempts = 0,
	'The signed delivery waits for the vault')
from pg_temp.delivery(current_setting('qorpera_test.d1')::uuid);
select pg_temp.hook_assert(sum(deliveries) = split_part(current_setting('qorpera_test.usage'), ',', 1)::bigint + 1
		and sum(bytes) = split_part(current_setting('qorpera_test.usage'), ',', 2)::bigint
			+ octet_length('{"stripe-signature": "t=1790000000,v1=00"}') + octet_length('{"id":"evt_1","type":"invoice.paid"}'),
	'The signed delivery counts toward the company''s hour')
from public.qorpera_event_intake_usage where profile_id = '73000000-0000-4000-8000-000000000010';

-- Only the broker, with its own capability, claims; and only its own company's deliveries.
select pg_temp.hook_error($q$select public.qorpera_claim_event_verifications('78400000-0000-4000-8000-0000000002a0',
	repeat('c', 64), 16)$q$, '42501');
select pg_temp.hook_error($q$select pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('d', 64))$q$, '42501');
select pg_temp.hook_error($q$select public.qorpera_finish_event_verification('78400000-0000-4000-8000-0000000002a0',
	repeat('c', 64), gen_random_uuid(), gen_random_uuid(), 'retry', null, null, null)$q$, '42501');
select pg_temp.hook_error($q$select pg_temp.vfinish(gen_random_uuid(), gen_random_uuid(), 'retry', null, null, null,
	'78400000-0000-4000-8000-0000000002a0', repeat('d', 64))$q$, '42501');
select pg_temp.hook_error($q$select pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64), 0)$q$, '22023');
select pg_temp.hook_error($q$select pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64), 17)$q$, '22023');
update public.qorpera_cloud_secret_broker_authorities set status = 'retired', retired_at = clock_timestamp()
where id = '78400000-0000-4000-8000-0000000002a0';
select pg_temp.hook_error($q$select pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64))$q$, '42501');
select pg_temp.hook_error($q$select pg_temp.vfinish(gen_random_uuid(), gen_random_uuid(), 'retry', null, null, null)$q$, '42501');
update public.qorpera_cloud_secret_broker_authorities set status = 'active', retired_at = null
where id = '78400000-0000-4000-8000-0000000002a0';
select pg_temp.hook_assert(pg_temp.vclaim('78400000-0000-4000-8000-0000000002a1', repeat('e', 64)) = '[]'::jsonb,
	'Another company''s broker claims nothing of this company');
-- The other company serves from its own broker now, with a delivery waiting there.
update public.qorpera_cloud_secret_broker_authorities set principal_id = null where id = '78400000-0000-4000-8000-0000000002a1';
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address)
values ('78400000-0000-4000-8000-0000000000e0', '73000000-0000-4000-8000-000000000011', '73000000-0000-4000-8000-000000000021',
	'other-billing', 'Stripe events', 'stripe', repeat('T', 43));
insert into public.qorpera_event_deliveries (hook_id, profile_id, status, content_type, headers, body, body_bytes, body_sha256)
values ('78400000-0000-4000-8000-0000000000e0', '73000000-0000-4000-8000-000000000011', 'received', 'application/json', '{}',
	'\x7b7d', 2, repeat('0', 64));
-- The shared vault asks once which of its companies have something due; only the broker, with the principal's capability.
select pg_temp.hook_assert(pg_temp.vdue() = jsonb_build_object('schema', 'qorpera.broker-principal-event-verifications/v1',
	'companyIds', jsonb_build_array('73000000-0000-4000-8000-000000000010')), 'The company with a delivery waiting is due');
select pg_temp.hook_error($q$select pg_temp.vdue(repeat('d', 64))$q$, '42501');
select pg_temp.hook_error($q$select public.qorpera_broker_principal_event_verifications_due(
	'78400000-0000-4000-8000-0000000002b0', repeat('f', 64))$q$, '42501');
select set_config('qorpera_test.claim', pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64))::text, true);
select pg_temp.hook_assert(count(*) = 1 and bool_and(item ->> 'schema' = 'qorpera.event-verification/v1'
		and item ->> 'deliveryId' = current_setting('qorpera_test.d1')
		and item ->> 'proof' = 'stripe' and item ->> 'secretId' = current_setting('qorpera_test.secret')
		and (item ->> 'secretVersion')::integer = 1 and item ->> 'keyId' = 'company-kek-1'
		and convert_from(decode(item ->> 'encryptedEnvelopeBase64', 'base64'), 'UTF8') = 'sealed version one'
		and convert_from(decode(item ->> 'bodyBase64', 'base64'), 'UTF8') = '{"id":"evt_1","type":"invoice.paid"}'
		and item #>> '{headers,stripe-signature}' = 't=1790000000,v1=00'
		and (item ->> 'receivedAt')::bigint = floor(extract(epoch from (pg_temp.delivery(current_setting('qorpera_test.d1')::uuid)).received_at))
		and item ->> 'environmentId' = '73000000-0000-4000-8000-000000000020'
		and item ->> 'companyId' = '73000000-0000-4000-8000-000000000010'
		and item ->> 'hookId' = current_setting('qorpera_test.billing')::jsonb ->> 'id'
		and item ->> 'envelopeSha256' = encode(extensions.digest('sealed version one', 'sha256'), 'hex')
		and (select array_agg(key order by key) from jsonb_object_keys(item) as key) = array['bodyBase64', 'claim',
			'companyId', 'deliveryId', 'encryptedEnvelopeBase64', 'envelopeSha256', 'environmentId', 'headers', 'hookId',
			'keyId', 'proof', 'receivedAt', 'schema', 'secretId', 'secretVersion']
		and (select verify_claim = (item ->> 'claim')::uuid and verify_attempts = 1
				and verify_claim_until between clock_timestamp() + interval '55 seconds' and clock_timestamp() + interval '60 seconds'
			from pg_temp.delivery(current_setting('qorpera_test.d1')::uuid))),
	'The claim carries the delivery and the sealed secret: ' || coalesce(string_agg(item::text, ', '), 'nothing'))
from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) as claimed(item);
select pg_temp.hook_assert(pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) = '[]'::jsonb
	and pg_temp.vdue() -> 'companyIds' = '[]'::jsonb,
	'A claimed delivery is not claimed twice, and its company is not due while the claim holds');

-- The verdict: only the claim that holds the delivery answers, in a valid shape.
select set_config('qorpera_test.c1', current_setting('qorpera_test.claim')::jsonb -> 0 ->> 'claim', true);
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d1')::uuid, gen_random_uuid(), 'verified', 'evt_1',
	'invoice.paid', null) ->> 'outcome' = 'stale', 'Another claim cannot answer');
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d1')::uuid, current_setting('qorpera_test.c1')::uuid,
	'verified', 'evt_1', 'invoice.paid', null, '78400000-0000-4000-8000-0000000002a1', repeat('e', 64)) ->> 'outcome' = 'stale',
	'Another company''s broker cannot answer');
select pg_temp.hook_error(format('select pg_temp.vfinish(%L, %L, %L, %L, %L, %L)', current_setting('qorpera_test.d1'),
	current_setting('qorpera_test.c1'), verdict, key, type, reason), '22023')
from (values ('verified', null, null, null), ('verified', 'body:abc', null, null), ('verified', 'has space', null, null),
	('verified', repeat('k', 257), null, null), ('verified', 'evt_1', repeat('t', 129), null), ('verified', 'evt_1', '', null),
	('verified', 'evt_1', null, 'a reason'), ('refused', null, null, null), ('refused', 'evt_1', null, 'Bad'),
	('refused', null, null, E'Two\nlines'), ('retry', 'evt_1', null, null), ('accepted', 'evt_1', null, null))
	as bad(verdict, key, type, reason);
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d1')::uuid, current_setting('qorpera_test.c1')::uuid,
	'verified', 'evt_1', 'invoice.paid', null) ->> 'outcome' = 'verified', 'The broker verifies the delivery');
select pg_temp.hook_assert(status = 'verified' and delivery_key = 'evt_1' and event_type = 'invoice.paid'
		and verified_at > now() and verify_claim is null and body is not null,
	'A verified signed delivery carries its sender id and type, stamped by the clock')
from pg_temp.delivery(current_setting('qorpera_test.d1')::uuid);
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d1')::uuid, current_setting('qorpera_test.c1')::uuid,
	'verified', 'evt_1', 'invoice.paid', null) ->> 'outcome' = 'stale', 'A verdict is given once');

-- The same event again is a duplicate; a bad signature is refused; a retry offers it again.
select set_config('qorpera_test.d2', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_1","type":"invoice.paid"}') ->> 'deliveryId', true);
select set_config('qorpera_test.d3', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_2"}') ->> 'deliveryId', true);
select set_config('qorpera_test.d4', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_3"}') ->> 'deliveryId', true);
select set_config('qorpera_test.claim', pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64))::text, true);
select pg_temp.hook_assert((select array_agg(item ->> 'deliveryId' order by place)
		from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) with ordinality as claimed(item, place))
	= array[current_setting('qorpera_test.d2'), current_setting('qorpera_test.d3'), current_setting('qorpera_test.d4')],
	'Three wait, oldest first');
select set_config('qorpera_test.c2', current_setting('qorpera_test.claim')::jsonb -> 0 ->> 'claim', true);
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d2')::uuid, current_setting('qorpera_test.c2')::uuid,
		'verified', 'evt_1', 'invoice.paid', null) ->> 'outcome' = 'duplicate'
	and pg_temp.vfinish(current_setting('qorpera_test.d3')::uuid, current_setting('qorpera_test.c2')::uuid,
		'refused', null, null, 'The Stripe signature does not match') ->> 'outcome' = 'refused'
	and pg_temp.vfinish(current_setting('qorpera_test.d4')::uuid, current_setting('qorpera_test.c2')::uuid,
		'retry', null, null, null) ->> 'outcome' = 'retry',
	'Duplicate, refused and retry are recorded');
select pg_temp.hook_assert((select status = 'duplicate' and delivery_key = 'evt_1' and body is null and verified_at is not null
		and reason = 'An earlier delivery had this key' from pg_temp.delivery(current_setting('qorpera_test.d2')::uuid))
	and (select status = 'refused' and reason = 'The Stripe signature does not match' and verified_at is null
			and body is null and body_sha256 is not null
		from pg_temp.delivery(current_setting('qorpera_test.d3')::uuid))
	and (select status = 'received' and verify_claim is null and verify_attempts = 1
			and verify_claim_until between clock_timestamp() + interval '55 seconds' and clock_timestamp() + interval '60 seconds'
		from pg_temp.delivery(current_setting('qorpera_test.d4')::uuid)),
	'Each verdict leaves its delivery as it says');
select pg_temp.hook_assert(pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) = '[]'::jsonb,
	'A retry waits before it is offered again');

-- Each retry waits five times longer; the fifth attempt's retry refuses the delivery.
do $$
declare v_claimed jsonb; v_until timestamptz; v_answer jsonb;
begin
	for n in 2..5 loop
		update public.qorpera_event_deliveries set verify_claim_until = clock_timestamp() - interval '1 second'
		where id = current_setting('qorpera_test.d4')::uuid;
		v_claimed := pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64));
		perform pg_temp.hook_assert(jsonb_array_length(v_claimed) = 1, format('Attempt %s takes it again', n));
		v_answer := pg_temp.vfinish(current_setting('qorpera_test.d4')::uuid, (v_claimed -> 0 ->> 'claim')::uuid, 'retry',
			null, null, null);
		if n < 5 then
			v_until := (pg_temp.delivery(current_setting('qorpera_test.d4')::uuid)).verify_claim_until;
			perform pg_temp.hook_assert(v_answer ->> 'outcome' = 'retry' and v_until
				between clock_timestamp() + interval '1 minute' * power(5, n - 1) - interval '5 seconds'
				and clock_timestamp() + interval '1 minute' * power(5, n - 1), format('Retry %s waits %s', n, v_until - clock_timestamp()));
		end if;
	end loop;
	perform pg_temp.hook_assert(v_answer ->> 'outcome' = 'refused' and (select status = 'refused'
			and reason = 'The vault could not check it' and verify_attempts = 5 and body is null and verify_claim is null
		from pg_temp.delivery(current_setting('qorpera_test.d4')::uuid)), 'The fifth retry refuses it: ' || v_answer::text);
end
$$;
-- A delivery whose fifth claim ended without a verdict is refused at the next claim.
select set_config('qorpera_test.d4b', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_4b"}') ->> 'deliveryId', true);
update public.qorpera_event_deliveries set verify_attempts = 5, verify_claim = gen_random_uuid(),
	verify_claim_until = clock_timestamp() - interval '1 second'
where id = current_setting('qorpera_test.d4b')::uuid;
select pg_temp.hook_assert(pg_temp.vclaim_batch('78400000-0000-4000-8000-0000000002a0', repeat('c', 64))
		= jsonb_build_object('schema', 'qorpera.event-verification-claim/v1', 'deliveries', '[]'::jsonb, 'refused', 1)
	and (select status = 'refused' and reason = 'The vault could not check it' and body is null
			and verify_claim is null and verify_claim_until is null
		from pg_temp.delivery(current_setting('qorpera_test.d4b')::uuid)),
	'Five claims without a verdict refuse it at the claim');

-- A delivery the purge refused while it was claimed keeps its refusal.
select set_config('qorpera_test.d11', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_11"}') ->> 'deliveryId', true);
select set_config('qorpera_test.c4', pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) -> 0 ->> 'claim', true);
update public.qorpera_event_deliveries set status = 'refused', reason = 'Not verified in time'
where id = current_setting('qorpera_test.d11')::uuid;
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d11')::uuid, current_setting('qorpera_test.c4')::uuid,
		'verified', 'evt_11', null, null) ->> 'outcome' = 'stale'
	and (select status = 'refused' and delivery_key is null from pg_temp.delivery(current_setting('qorpera_test.d11')::uuid)),
	'A refused delivery is not verified later');

-- A delivery waiting on an address hook, or without its body, is refused at the claim.
insert into public.qorpera_event_deliveries (id, hook_id, profile_id, status, content_type, headers, body, body_bytes, body_sha256)
values ('78400000-0000-4000-8000-0000000000d1', current_setting('qorpera_test.hook')::uuid,
	'73000000-0000-4000-8000-000000000010', 'received', 'application/json', '{}', '\x7b7d', 2, repeat('0', 64));
select set_config('qorpera_test.d12', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_12"}') ->> 'deliveryId', true);
update public.qorpera_event_deliveries set body = null where id = current_setting('qorpera_test.d12')::uuid;
select set_config('qorpera_test.d13', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_13"}') ->> 'deliveryId', true);
select set_config('qorpera_test.d14', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_14"}') ->> 'deliveryId', true);
select set_config('qorpera_test.claim', pg_temp.vclaim_batch('78400000-0000-4000-8000-0000000002a0', repeat('c', 64), 1)::text,
	true);
select pg_temp.hook_assert((current_setting('qorpera_test.claim')::jsonb ->> 'refused')::integer = 2
	and current_setting('qorpera_test.claim')::jsonb #>> '{deliveries,0,deliveryId}' = current_setting('qorpera_test.d13')
	and jsonb_array_length(current_setting('qorpera_test.claim')::jsonb -> 'deliveries') = 1
	and (select reason = 'The hook is not signed' and body is null from pg_temp.delivery('78400000-0000-4000-8000-0000000000d1'))
	and (select reason = 'The delivery''s body is gone' from pg_temp.delivery(current_setting('qorpera_test.d12')::uuid)),
	'What no check could fix is refused at the claim, which looks past it: ' || current_setting('qorpera_test.claim'));
select pg_temp.hook_assert((select verify_claim is null and verify_attempts = 0
		from pg_temp.delivery(current_setting('qorpera_test.d14')::uuid)),
	'A claim takes no more than it asked for');
select pg_temp.vfinish(current_setting('qorpera_test.d13')::uuid,
	(current_setting('qorpera_test.claim')::jsonb #>> '{deliveries,0,claim}')::uuid, 'verified', 'evt_13', null, null);
select pg_temp.vfinish(current_setting('qorpera_test.d14')::uuid,
	(pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) -> 0 ->> 'claim')::uuid, 'verified', 'evt_14',
	null, null);

-- The claim refuses what no verdict could fix: a secret sealed for another authority, a gone secret, a removed hook.
select set_config('qorpera_test.d5', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_5"}') ->> 'deliveryId', true);
update public.qorpera_cloud_secret_versions set broker_authority_id = '78400000-0000-4000-8000-0000000002a1'
where secret_id = current_setting('qorpera_test.secret')::uuid;
select pg_temp.hook_assert(pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) = '[]'::jsonb
	and (select reason = 'The hook''s signing secret must be saved again'
		from pg_temp.delivery(current_setting('qorpera_test.d5')::uuid)),
	'A secret sealed for another authority refuses at the claim');
update public.qorpera_cloud_secret_versions set broker_authority_id = '78400000-0000-4000-8000-0000000002a0'
where secret_id = current_setting('qorpera_test.secret')::uuid;
select set_config('qorpera_test.d6b', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_6b"}') ->> 'deliveryId', true);
select set_config('qorpera_test.c6b', pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) -> 0 ->> 'claim',
	true);
select set_config('qorpera_test.d6', pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address',
	'{"id":"evt_6"}') ->> 'deliveryId', true);
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp()
where id = current_setting('qorpera_test.secret')::uuid;
select pg_temp.hook_assert(pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) = '[]'::jsonb
	and (select reason = 'The hook''s signing secret is gone' from pg_temp.delivery(current_setting('qorpera_test.d6')::uuid))
	and pg_temp.post(current_setting('qorpera_test.billing')::jsonb ->> 'address', '{"id":"evt_7"}') ->> 'outcome' = 'not_ready',
	'A revoked secret refuses what waits and takes nothing new');
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d6b')::uuid, current_setting('qorpera_test.c6b')::uuid,
		'verified', 'evt_6b', null, null) ->> 'outcome' = 'refused'
	and (select status = 'refused' and reason = 'The hook''s signing secret is gone' and delivery_key is null and body is null
		from pg_temp.delivery(current_setting('qorpera_test.d6b')::uuid)),
	'A delivery claimed before its secret was revoked is not verified after');

-- A new version of the secret is the one claimed.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.ticket', public.qorpera_begin_cloud_secret_capture('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'company', null, 'event_hook',
	current_setting('qorpera_test.prs')::jsonb #>> '{signingSecret,secretName}', 'GitHub signing secret')::text, true);
reset role;
select set_config('qorpera_test.prs_secret', pg_temp.vcomplete(current_setting('qorpera_test.ticket')::jsonb,
	convert_to('github version one', 'UTF8')) ->> 'secretId', true);
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.ticket', public.qorpera_begin_cloud_secret_capture('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'company', null, 'event_hook',
	current_setting('qorpera_test.prs')::jsonb #>> '{signingSecret,secretName}', 'GitHub signing secret',
	current_setting('qorpera_test.prs_secret')::uuid)::text, true);
reset role;
select pg_temp.vcomplete(current_setting('qorpera_test.ticket')::jsonb, convert_to('github version two', 'UTF8'));
select set_config('qorpera_test.d8', pg_temp.post(current_setting('qorpera_test.prs')::jsonb ->> 'address',
	'{"action":"opened"}') ->> 'deliveryId', true);
select set_config('qorpera_test.claim', pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64))::text, true);
select pg_temp.hook_assert(count(*) = 1 and bool_and((item ->> 'secretVersion')::integer = 2 and item ->> 'proof' = 'github'
		and convert_from(decode(item ->> 'encryptedEnvelopeBase64', 'base64'), 'UTF8') = 'github version two'),
	'The claim carries the current version: ' || coalesce(string_agg(item::text, ', '), 'nothing'))
from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) as claimed(item);
select set_config('qorpera_test.c8', current_setting('qorpera_test.claim')::jsonb -> 0 ->> 'claim', true);
-- One more waits unclaimed when the hook is removed.
select set_config('qorpera_test.d8b', pg_temp.post(current_setting('qorpera_test.prs')::jsonb ->> 'address',
	'{"action":"closed"}') ->> 'deliveryId', true);

-- A member's own secret of the hook's name, or a company secret of another connector, is not the hook's.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000003');
set local role authenticated;
select set_config('qorpera_test.ticket', public.qorpera_begin_cloud_secret_capture('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'member', '73000000-0000-4000-8000-000000000003', 'event_hook',
	current_setting('qorpera_test.backend')::jsonb #>> '{signingSecret,secretName}', 'Planted secret')::text, true);
reset role;
select pg_temp.vcomplete(current_setting('qorpera_test.ticket')::jsonb, convert_to('planted', 'UTF8'));
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.ticket', public.qorpera_begin_cloud_secret_capture('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'company', null, 'vault',
	current_setting('qorpera_test.backend')::jsonb #>> '{signingSecret,secretName}', 'Another connector')::text, true);
reset role;
select pg_temp.vcomplete(current_setting('qorpera_test.ticket')::jsonb, convert_to('other connector', 'UTF8'));
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.hook_assert(exists (select 1 from jsonb_array_elements(public.qorpera_list_event_hooks(
		'73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000020')) as hook(value)
	where hook.value ->> 'name' = 'backend' and hook.value #>> '{signingSecret,ready}' = 'false'),
	'A member''s secret or another connector''s made the hook ready');
reset role;
select pg_temp.hook_assert(pg_temp.post(current_setting('qorpera_test.backend')::jsonb ->> 'address', '{"n":0}') ->> 'outcome'
	= 'not_ready', 'A member''s secret or another connector''s let the hook take a delivery');
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.ticket', public.qorpera_begin_cloud_secret_capture('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'company', null, 'event_hook',
	current_setting('qorpera_test.backend')::jsonb #>> '{signingSecret,secretName}', 'Backend signing secret')::text, true);
reset role;
select pg_temp.vcomplete(current_setting('qorpera_test.ticket')::jsonb, convert_to('backend version one', 'UTF8'));

-- A removed hook's deliveries are refused: a claimed one at its verdict, a waiting one at the next claim.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_event_hook_status((current_setting('qorpera_test.prs')::jsonb ->> 'id')::uuid, 'removed');
reset role;
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d8')::uuid, current_setting('qorpera_test.c8')::uuid,
		'verified', 'sig:' || repeat('b', 64), 'pull_request.opened', null) ->> 'outcome' = 'refused'
	and (select status = 'refused' and reason = 'The hook was removed' and delivery_key is null and body is null
		from pg_temp.delivery(current_setting('qorpera_test.d8')::uuid)),
	'A delivery claimed before its hook was removed is not verified after');
select pg_temp.hook_assert(pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) = '[]'::jsonb
	and (select status = 'refused' and reason = 'The hook was removed' and verify_claim is null and verify_claim_until is null
		from pg_temp.delivery(current_setting('qorpera_test.d8b')::uuid)),
	'A removed hook''s waiting delivery is refused');
select pg_temp.hook_assert((select status = 'revoked' and revoked_at is not null
		and revoked_by_user_id = '73000000-0000-4000-8000-000000000001'
		from public.qorpera_cloud_secrets where id = current_setting('qorpera_test.prs_secret')::uuid)
	and (select count(*) = 1 and bool_and(secret_id = current_setting('qorpera_test.prs_secret')::uuid
			and secret_version = 2 and actor_user_id = '73000000-0000-4000-8000-000000000001')
		from public.qorpera_cloud_secret_audit_events
		where profile_id = '73000000-0000-4000-8000-000000000010' and connector_id = 'event_hook'
			and event_type = 'secret_revoked')
	and (select count(*) = 2 from public.qorpera_cloud_secrets
		where profile_id = '73000000-0000-4000-8000-000000000010' and connector_id = 'event_hook' and status = 'active'
			and secret_name = current_setting('qorpera_test.backend')::jsonb #>> '{signingSecret,secretName}'),
	'Removing a hook revokes its signing secret, and only its own');

-- Two verdicts with the same sender id: one is verified, the other a duplicate.
select set_config('qorpera_test.d9', pg_temp.post(current_setting('qorpera_test.backend')::jsonb ->> 'address', '{"n":1}')
	->> 'deliveryId', true);
select set_config('qorpera_test.d10', pg_temp.post(current_setting('qorpera_test.backend')::jsonb ->> 'address', '{"n":1}')
	->> 'deliveryId', true);
select set_config('qorpera_test.c3', pg_temp.vclaim('78400000-0000-4000-8000-0000000002a0', repeat('c', 64)) -> 0 ->> 'claim', true);
select pg_temp.hook_assert(pg_temp.vfinish(current_setting('qorpera_test.d9')::uuid, current_setting('qorpera_test.c3')::uuid,
		'verified', 'sig:' || repeat('a', 64), null, null) ->> 'outcome' = 'verified'
	and pg_temp.vfinish(current_setting('qorpera_test.d10')::uuid, current_setting('qorpera_test.c3')::uuid,
		'verified', 'sig:' || repeat('a', 64), null, null) ->> 'outcome' = 'duplicate',
	'An exact replay of one signature is a duplicate');

-- Pausing keeps the secret; however a hook is removed, its secret goes with it (here without a member's session, as
-- an agent's removal will be), and a member's own secret of that name stays.
update public.qorpera_event_hooks set status = 'paused' where id = (current_setting('qorpera_test.backend')::jsonb ->> 'id')::uuid;
select pg_temp.hook_assert((select count(*) = 1 from public.qorpera_cloud_secrets where connector_id = 'event_hook'
		and owner_kind = 'company' and status = 'active'
		and secret_name = current_setting('qorpera_test.backend')::jsonb #>> '{signingSecret,secretName}'),
	'Pausing a hook revoked its secret');
select pg_temp.hook_claims('service_role');
update public.qorpera_event_hooks set status = 'removed', removed_at = statement_timestamp()
where id = (current_setting('qorpera_test.backend')::jsonb ->> 'id')::uuid;
select pg_temp.hook_assert((select status = 'revoked' and revoked_by_user_id is null from public.qorpera_cloud_secrets
		where connector_id = 'event_hook' and owner_kind = 'company'
			and secret_name = current_setting('qorpera_test.backend')::jsonb #>> '{signingSecret,secretName}')
	and (select status = 'active' from public.qorpera_cloud_secrets where connector_id = 'event_hook' and owner_kind = 'member'
		and secret_name = current_setting('qorpera_test.backend')::jsonb #>> '{signingSecret,secretName}')
	and (select count(*) = 2 from public.qorpera_cloud_secret_audit_events
		where profile_id = '73000000-0000-4000-8000-000000000010' and connector_id = 'event_hook'
			and event_type = 'secret_revoked'),
	'Removing a hook without a member''s session revokes its secret too');

rollback;
