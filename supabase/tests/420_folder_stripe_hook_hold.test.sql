-- @fixture 419_folder_stripe_hook_capture.test.sql until "-- 1. The broker opens a Stripe hook with its capture key, and a GitHub hook as before"
-- Company folder core C4, E3c-4 (migration 20260930345000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.8 point 5):
-- a Stripe hook whose signature does not match is held until the next capture. On 419's fixture (405's office, 924's
-- folder-v2 company and its broker authority), with a Stripe, a GitHub and an HMAC hook the broker opened:
-- 1. a delivery refused because its Stripe signature does not match holds the hook: the verdict is still refused, the
--    hook answers not_ready and stores nothing, and its descriptor says it is held; any other refusal holds nothing;
-- 2. the next capture lifts the hold: while it holds, the broker's read offers no current version, so the capture stores
--    version 2, and a delivery verifies under it;
-- 3. a version a delivery verified under is never held, and a delivery verified beside the refused one lifts the hold;
-- 4. GitHub and HMAC hooks are never held, whatever the broker's words;
-- 5. the marker is in the four patched bodies and no other, and the verdict is still the broker's alone.

-- A delivery to hook h (its id in qorpera_test.e3h_<h>), as the intake (the service role), with its proof's headers.
create function pg_temp.e3h_post(p_hook text, p_body text) returns jsonb language plpgsql as $$
declare v_hook public.qorpera_event_hooks; v_answer jsonb;
begin
	select hook.* into v_hook from public.qorpera_event_hooks as hook
	where hook.id = current_setting('qorpera_test.e3h_' || p_hook)::uuid;
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_answer := public.qorpera_receive_event(v_hook.address, 'application/json', case v_hook.proof
		when 'stripe' then '{"stripe-signature": "t=1790000000,v1=00"}'
		when 'github' then '{"x-hub-signature-256": "sha256=00", "x-github-event": "push"}'
		else '{"webhook-id": "m1", "webhook-timestamp": "1790000000", "webhook-signature": "v1,AA=="}' end::jsonb,
		encode(convert_to(p_body, 'UTF8'), 'base64'));
	reset role;
	return v_answer;
end $$;
-- The broker claims every waiting delivery of the company: the claimed items by delivery id.
create function pg_temp.e3h_claim() returns jsonb language plpgsql as $$
declare v_batch jsonb;
begin
	perform set_config('request.jwt.claims', '', true);
	set local session authorization qorpera_secret_broker;
	v_batch := public.qorpera_claim_event_verifications('41900000-0000-4000-8000-000000000040', repeat('9', 64), 16);
	reset session authorization;
	return coalesce((select jsonb_object_agg(item ->> 'deliveryId', item)
		from jsonb_array_elements(v_batch -> 'deliveries') as item), '{}');
end $$;
-- The broker's verdict on a claimed item: refused with its words, or verified with the event's id.
create function pg_temp.e3h_finish(p_item jsonb, p_verdict text, p_words text) returns jsonb language plpgsql as $$
declare v_answer jsonb;
begin
	perform set_config('request.jwt.claims', '', true);
	set local session authorization qorpera_secret_broker;
	v_answer := public.qorpera_finish_event_verification('41900000-0000-4000-8000-000000000040', repeat('9', 64),
		(p_item ->> 'deliveryId')::uuid, (p_item ->> 'claim')::uuid, p_verdict,
		case when p_verdict = 'verified' then p_words end, case when p_verdict = 'verified' then 'invoice.paid' end,
		case when p_verdict = 'refused' then p_words end);
	reset session authorization;
	return v_answer;
end $$;
-- One delivery to hook h, claimed alone and given the verdict: the receive's answer, the claimed item and the verdict.
create function pg_temp.e3h_deliver(p_hook text, p_event text, p_verdict text, p_words text) returns jsonb
language plpgsql as $$
declare v_received jsonb := pg_temp.e3h_post(p_hook, format('{"id":"%s"}', p_event)); v_item jsonb;
begin
	v_item := pg_temp.e3h_claim() -> (v_received ->> 'deliveryId');
	return jsonb_build_object('received', v_received, 'item', v_item,
		'verdict', case when v_item is not null then pg_temp.e3h_finish(v_item, p_verdict, p_words) end);
end $$;
-- A capture on receipt 4n: the office admits the call, the broker reads it and, given a version, stores that version of
-- the Stripe hook's secret in box \x03n. The broker's read and store answers.
create function pg_temp.e3h_capture(p_n text, p_version bigint) returns jsonb language plpgsql as $$
declare v_envelope text := pg_temp.e3c_envelope('e3h-' || p_n); v_read text; v_store text;
begin
	perform pg_temp.e3c_begin('4' || p_n, v_envelope);
	set local session authorization qorpera_secret_broker;
	v_read := pg_temp.e3c_capture('4' || p_n, v_envelope);
	if p_version is not null then
		v_store := pg_temp.e3c_capture('4' || p_n, v_envelope, pg_temp.e3c_store_args(p_version, ('\x030' || p_n)::bytea),
			'qorpera_folder_store_hook_capture');
	end if;
	reset session authorization;
	perform pg_temp.e3c_end('4' || p_n, v_envelope);
	return jsonb_build_object('read', v_read, 'store', v_store);
end $$;
-- The hook's capture key, its secret's current version and the deliveries it stored.
create function pg_temp.e3h_state(p_hook text default 'stripe') returns jsonb language sql as $$
	select jsonb_build_object('held', capture.held_secret_version, 'heldAt', capture.held_at,
		'verified', capture.verified_secret_version, 'keys', (select count(*) from public.qorpera_event_hook_capture_keys
			where hook_id = current_setting('qorpera_test.e3h_' || p_hook)::uuid),
		'current', (select secret.current_version from public.qorpera_event_hooks as hook
			cross join lateral public.qorpera_event_hook_secret(hook) as secret
			where hook.id = current_setting('qorpera_test.e3h_' || p_hook)::uuid),
		'deliveries', (select count(*) from public.qorpera_event_deliveries
			where hook_id = current_setting('qorpera_test.e3h_' || p_hook)::uuid))
	from (select 1) as one
	left join public.qorpera_event_hook_capture_keys as capture
		on capture.hook_id = current_setting('qorpera_test.e3h_' || p_hook)::uuid
$$;
create function pg_temp.e3h_received_at(p_delivery text) returns timestamptz language sql as $$
	select received_at from public.qorpera_event_deliveries where id = p_delivery::uuid
$$;
create function pg_temp.e3h_secret(p_hook text default 'stripe') returns jsonb language sql as $$
	select public.qorpera_event_hook_descriptor(hook, false) -> 'signingSecret' from public.qorpera_event_hooks as hook
	where hook.id = current_setting('qorpera_test.e3h_' || p_hook)::uuid
$$;
grant execute on function pg_temp.e3h_claim(), pg_temp.e3h_finish(jsonb, text, text) to qorpera_secret_broker;

-- The intake takes deliveries; the broker opens a Stripe hook (secret id 201), a GitHub one (203) and an HMAC one (204).
update public.qorpera_event_intake_settings set enabled = true, company_hourly_deliveries = 2000,
	company_hourly_bytes = 67108864;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.e3h_open', concat_ws(E'\n',
	pg_temp.e3c_call('qorpera_folder_open_stripe_hook', pg_temp.e3c_open_args(pg_temp.e3c_create('e3h-stripe', 'stripe-pays'),
		'201')),
	pg_temp.e3c_call('qorpera_folder_open_signed_hook', pg_temp.e3c_signed_args(pg_temp.e3c_create('e3h-github', 'repo-pushes',
		'{"proof": "github"}'), '203')),
	pg_temp.e3c_call('qorpera_folder_open_signed_hook', pg_temp.e3c_signed_args(pg_temp.e3c_create('e3h-hmac', 'signed-events',
		'{"proof": "hmac-sha256", "site": "hooks.example.com"}'), '204', '\x0202'))), true);
reset session authorization;

do $$
declare v_name text; v_setting text;
begin
	for v_name, v_setting in select * from (values ('stripe-pays', 'stripe'), ('repo-pushes', 'github'),
		('signed-events', 'hmac')) as hook(name, setting) loop
		perform set_config('qorpera_test.e3h_' || v_setting, (select hook.id::text from public.qorpera_event_hooks as hook
			where hook.profile_id = '92400000-0000-4000-8000-000000000010' and hook.name = v_name), true);
		-- set_config stores a null as ''.
		perform pg_temp.base_assert(current_setting('qorpera_test.e3h_' || v_setting) <> '',
			E'Setup: the broker opens ' || v_name || E':\n' || current_setting('qorpera_test.e3h_open'));
	end loop;
	-- 419's helpers capture into the hook in qorpera_test.e3c_hook.
	perform set_config('qorpera_test.e3c_hook', current_setting('qorpera_test.e3h_stripe'), true);
end $$;


-- 1. A Stripe signature that does not match holds the hook; any other refusal holds nothing ------------------------------

select set_config('qorpera_test.e3h_cap1', pg_temp.e3h_capture('1', 1)::text, true);
-- A refusal for another reason, then one because the signature does not match, then a delivery to the held hook.
select set_config('qorpera_test.e3h_d0', pg_temp.e3h_deliver('stripe', 'evt_0', 'refused',
	'The Stripe signature is outside the five minutes allowed')::text, true);
select set_config('qorpera_test.e3h_s0', pg_temp.e3h_state()::text, true);
select set_config('qorpera_test.e3h_d1', pg_temp.e3h_deliver('stripe', 'evt_1', 'refused',
	'The Stripe signature does not match')::text, true);
select set_config('qorpera_test.e3h_s1', pg_temp.e3h_state()::text, true);
select set_config('qorpera_test.e3h_d2', pg_temp.e3h_post('stripe', '{"id":"evt_2"}')::text, true);
select set_config('qorpera_test.e3h_s2', pg_temp.e3h_state()::text, true);

do $$
declare
	v_capture jsonb := current_setting('qorpera_test.e3h_cap1')::jsonb;
	v_d0 jsonb := current_setting('qorpera_test.e3h_d0')::jsonb;
	v_d1 jsonb := current_setting('qorpera_test.e3h_d1')::jsonb;
	v_s0 jsonb := current_setting('qorpera_test.e3h_s0')::jsonb;
	v_s1 jsonb := current_setting('qorpera_test.e3h_s1')::jsonb;
	v_s2 jsonb := current_setting('qorpera_test.e3h_s2')::jsonb;
	v_at timestamptz := pg_temp.e3h_received_at(v_d1 #>> '{received,deliveryId}');
	v_secret jsonb := pg_temp.e3h_secret();
begin
	perform pg_temp.base_assert(pg_temp.e3c_answer(v_capture ->> 'store') ->> 'version' = '1'
			and v_s0 ->> 'current' = '1' and v_s0 ->> 'keys' = '1',
		'1: the first capture stores version 1: ' || v_capture::text);
	perform pg_temp.base_assert(v_d0 ->> 'verdict' = '{"outcome": "refused"}' and v_d0 #>> '{item,secretVersion}' = '1'
			and v_s0 -> 'held' = 'null' and v_s0 -> 'verified' = 'null',
		'1: a refusal for another reason holds nothing: ' || v_d0::text || ' ' || v_s0::text);
	perform pg_temp.base_assert(v_d1 ->> 'verdict' = '{"outcome": "refused"}' and v_s1 ->> 'held' = '1'
			and (v_s1 ->> 'heldAt')::timestamptz = v_at and v_s1 -> 'verified' = 'null'
			and (select status = 'refused' and reason = 'The Stripe signature does not match' and body is null
				from public.qorpera_event_deliveries where id = (v_d1 #>> '{received,deliveryId}')::uuid),
		'1: a signature that does not match is refused and holds version 1: ' || v_d1::text || ' ' || v_s1::text);
	-- The same verdict again is stale and changes nothing.
	perform pg_temp.base_assert(pg_temp.e3h_finish(v_d1 -> 'item', 'refused', 'The Stripe signature does not match')
			->> 'outcome' = 'stale' and pg_temp.e3h_state() = v_s1,
		'1: a stale verdict holds nothing more');
	perform pg_temp.base_assert(current_setting('qorpera_test.e3h_d2') = '{"outcome": "not_ready"}'
			and v_s2 = v_s1,
		'1: the held hook takes nothing: ' || current_setting('qorpera_test.e3h_d2') || ' ' || v_s2::text);
	perform pg_temp.base_assert(v_secret ->> 'ready' = 'true' and v_secret ->> 'version' = '1'
			and v_secret -> 'lastRefusal' = jsonb_build_object('receivedAt', v_at,
				'reason', 'held: the captured secret does not match'),
		'1: the descriptor says the hook is held: ' || coalesce(v_secret::text, 'none'));
end $$;

-- 2. The next capture lifts the hold: the broker's read offers no held version, so the capture stores a new one ----------

select set_config('qorpera_test.e3h_cap2', pg_temp.e3h_capture('2', 2)::text, true);
select set_config('qorpera_test.e3h_s3', pg_temp.e3h_state()::text, true);
select set_config('qorpera_test.e3h_secret3', pg_temp.e3h_secret()::text, true);
select set_config('qorpera_test.e3h_d3', pg_temp.e3h_deliver('stripe', 'evt_3', 'verified', 'evt_3')::text, true);
select set_config('qorpera_test.e3h_s4', pg_temp.e3h_state()::text, true);

do $$
declare
	v_capture jsonb := current_setting('qorpera_test.e3h_cap2')::jsonb;
	v_read jsonb := pg_temp.e3c_answer(current_setting('qorpera_test.e3h_cap2')::jsonb ->> 'read');
	v_s3 jsonb := current_setting('qorpera_test.e3h_s3')::jsonb;
	v_s4 jsonb := current_setting('qorpera_test.e3h_s4')::jsonb;
	v_d3 jsonb := current_setting('qorpera_test.e3h_d3')::jsonb;
	v_secret jsonb := current_setting('qorpera_test.e3h_secret3')::jsonb;
begin
	perform pg_temp.base_assert(v_read ->> 'version' = '2' and not v_read ? 'current'
			and pg_temp.e3c_answer(v_capture ->> 'store') ->> 'version' = '2',
		'2: while version 1 is held the broker''s read offers no current version, and the capture stores version 2: '
			|| v_capture::text);
	perform pg_temp.base_assert(v_s3 ->> 'current' = '2' and v_s3 ->> 'held' = '1',
		'2: the hold stays on version 1, which is no longer current: ' || v_s3::text);
	perform pg_temp.base_assert(v_secret ->> 'version' = '2' and not v_secret ? 'lastRefusal',
		'2: the descriptor has no refusal under version 2: ' || v_secret::text);
	perform pg_temp.base_assert(v_d3 #>> '{item,secretVersion}' = '2' and v_d3 ->> 'verdict' = '{"outcome": "verified"}'
			and v_s4 ->> 'verified' = '2' and v_s4 -> 'held' = 'null' and v_s4 -> 'heldAt' = 'null',
		'2: a delivery verifies under version 2, and the old hold is lifted: ' || v_d3::text || ' ' || v_s4::text);
end $$;

-- 3. A version a delivery verified under is never held; a delivery verified beside the refused one lifts the hold -------

select set_config('qorpera_test.e3h_d4', pg_temp.e3h_deliver('stripe', 'evt_4', 'refused',
	'The Stripe signature does not match')::text, true);
select set_config('qorpera_test.e3h_s5', pg_temp.e3h_state()::text, true);
select set_config('qorpera_test.e3h_secret5', pg_temp.e3h_secret()::text, true);
select set_config('qorpera_test.e3h_d5', pg_temp.e3h_deliver('stripe', 'evt_5', 'verified', 'evt_5')::text, true);
select set_config('qorpera_test.e3h_read5', pg_temp.e3h_capture('5', null)::text, true);
-- Version 3, and two deliveries claimed together: one does not match, then the other verifies.
select set_config('qorpera_test.e3h_cap3', pg_temp.e3h_capture('3', 3)::text, true);
select set_config('qorpera_test.e3h_d6', pg_temp.e3h_post('stripe', '{"id":"evt_6"}')::text, true);
select set_config('qorpera_test.e3h_d7', pg_temp.e3h_post('stripe', '{"id":"evt_7"}')::text, true);
select set_config('qorpera_test.e3h_k67', pg_temp.e3h_claim()::text, true);
select set_config('qorpera_test.e3h_f6', pg_temp.e3h_finish(current_setting('qorpera_test.e3h_k67')::jsonb
	-> (current_setting('qorpera_test.e3h_d6')::jsonb ->> 'deliveryId'), 'refused', 'The Stripe signature does not match')::text, true);
select set_config('qorpera_test.e3h_s6', pg_temp.e3h_state()::text, true);
select set_config('qorpera_test.e3h_d8', pg_temp.e3h_post('stripe', '{"id":"evt_8"}')::text, true);
select set_config('qorpera_test.e3h_f7', pg_temp.e3h_finish(current_setting('qorpera_test.e3h_k67')::jsonb
	-> (current_setting('qorpera_test.e3h_d7')::jsonb ->> 'deliveryId'), 'verified', 'evt_7')::text, true);
select set_config('qorpera_test.e3h_s7', pg_temp.e3h_state()::text, true);
select set_config('qorpera_test.e3h_d9', pg_temp.e3h_deliver('stripe', 'evt_9', 'verified', 'evt_9')::text, true);

do $$
declare
	v_d4 jsonb := current_setting('qorpera_test.e3h_d4')::jsonb;
	v_d5 jsonb := current_setting('qorpera_test.e3h_d5')::jsonb;
	v_d9 jsonb := current_setting('qorpera_test.e3h_d9')::jsonb;
	v_s5 jsonb := current_setting('qorpera_test.e3h_s5')::jsonb;
	v_s6 jsonb := current_setting('qorpera_test.e3h_s6')::jsonb;
	v_s7 jsonb := current_setting('qorpera_test.e3h_s7')::jsonb;
	v_k67 jsonb := current_setting('qorpera_test.e3h_k67')::jsonb;
	v_read5 jsonb := pg_temp.e3c_answer(current_setting('qorpera_test.e3h_read5')::jsonb ->> 'read');
	v_cap3 jsonb := current_setting('qorpera_test.e3h_cap3')::jsonb;
	v_d6 text := current_setting('qorpera_test.e3h_d6')::jsonb ->> 'deliveryId';
	v_d7 text := current_setting('qorpera_test.e3h_d7')::jsonb ->> 'deliveryId';
begin
	perform pg_temp.base_assert(v_d4 #>> '{item,secretVersion}' = '2' and v_d4 ->> 'verdict' = '{"outcome": "refused"}'
			and v_s5 -> 'held' = 'null' and v_s5 ->> 'verified' = '2',
		'3: a signature that does not match holds no version a delivery verified under: ' || v_d4::text || ' ' || v_s5::text);
	perform pg_temp.base_assert(current_setting('qorpera_test.e3h_secret5')::jsonb -> 'lastRefusal'
			= jsonb_build_object('receivedAt', pg_temp.e3h_received_at(v_d4 #>> '{received,deliveryId}'),
				'reason', 'The Stripe signature does not match'),
		'3: the descriptor names the refusal, not a hold: ' || current_setting('qorpera_test.e3h_secret5'));
	perform pg_temp.base_assert(v_d5 ->> 'verdict' = '{"outcome": "verified"}',
		'3: the hook still takes deliveries: ' || v_d5::text);
	perform pg_temp.base_assert(v_read5 ->> 'version' = '3' and v_read5 #>> '{current,version}' = '2'
			and pg_temp.e3c_answer(v_cap3 ->> 'read') #>> '{current,version}' = '2'
			and pg_temp.e3c_answer(v_cap3 ->> 'store') ->> 'version' = '3',
		'3: unheld, the broker''s read offers the current version again, and version 3 stores: ' || v_read5::text || ' '
			|| v_cap3::text);
	perform pg_temp.base_assert((select array_agg(key order by key) from jsonb_object_keys(v_k67) as key)
			= (select array_agg(id order by id) from unnest(array[v_d6, v_d7]) as id)
			and v_k67 #>> array[v_d6, 'secretVersion'] = '3' and v_k67 #>> array[v_d7, 'secretVersion'] = '3',
		'3: two deliveries are claimed together under version 3: ' || v_k67::text);
	perform pg_temp.base_assert(current_setting('qorpera_test.e3h_f6') = '{"outcome": "refused"}' and v_s6 ->> 'held' = '3'
			and (v_s6 ->> 'heldAt')::timestamptz = pg_temp.e3h_received_at(v_d6)
			and current_setting('qorpera_test.e3h_d8') = '{"outcome": "not_ready"}',
		'3: the one that does not match holds version 3: ' || v_s6::text || ' ' || current_setting('qorpera_test.e3h_d8'));
	perform pg_temp.base_assert(current_setting('qorpera_test.e3h_f7') = '{"outcome": "verified"}'
			and v_s7 -> 'held' = 'null' and v_s7 -> 'heldAt' = 'null' and v_s7 ->> 'verified' = '3'
			and v_d9 ->> 'verdict' = '{"outcome": "verified"}',
		'3: the other verifies under version 3 and lifts the hold: ' || v_s7::text || ' ' || v_d9::text);
end $$;

-- 4. GitHub and HMAC hooks are never held, whatever the broker's words -------------------------------------------------

select set_config('qorpera_test.e3h_g', jsonb_build_array(
	pg_temp.e3h_deliver('github', 'g_1', 'refused', 'The GitHub signature does not match'),
	pg_temp.e3h_deliver('github', 'g_2', 'refused', 'The Stripe signature does not match'),
	pg_temp.e3h_post('github', '{"id":"g_3"}'))::text, true);
select set_config('qorpera_test.e3h_h', jsonb_build_array(
	pg_temp.e3h_deliver('hmac', 'h_1', 'refused', 'The signature does not match'),
	pg_temp.e3h_deliver('hmac', 'h_2', 'refused', 'The Stripe signature does not match'),
	pg_temp.e3h_post('hmac', '{"id":"h_3"}'))::text, true);

do $$
declare v_hook text; v_answers jsonb; v_state jsonb; v_secret jsonb;
begin
	foreach v_hook in array array['github', 'hmac'] loop
		v_answers := current_setting('qorpera_test.e3h_' || left(v_hook, 1))::jsonb;
		v_state := pg_temp.e3h_state(v_hook);
		v_secret := pg_temp.e3h_secret(v_hook);
		perform pg_temp.base_assert(v_answers #>> '{0,verdict}' = '{"outcome": "refused"}'
				and v_answers #>> '{1,verdict}' = '{"outcome": "refused"}' and v_answers -> 2 ? 'deliveryId'
				and v_state ->> 'keys' = '0' and v_state ->> 'deliveries' = '3',
			'4: a ' || v_hook || ' hook refuses and still takes deliveries: ' || v_answers::text || ' ' || v_state::text);
		perform pg_temp.base_assert((select array_agg(key order by key) from jsonb_object_keys(v_secret) as key)
				= array['connectorId', 'ready', 'secretName'],
			'4: a ' || v_hook || ' hook''s descriptor keeps its three keys: ' || coalesce(v_secret::text, 'none'));
	end loop;
end $$;


-- 5. The marker, and who may give a verdict --------------------------------------------------------------------------

do $$
declare v_role text;
begin
	perform pg_temp.base_assert((select array_agg(proc.proname::text order by proc.proname::text collate "C")
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930345000') > 0) = array[
			'qorpera_event_hook_descriptor', 'qorpera_finish_event_verification', 'qorpera_folder_read_hook_capture',
			'qorpera_receive_event'],
		'5: the marker''s bodies');
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role,
				'public.qorpera_finish_event_verification(uuid,text,uuid,uuid,text,text,text,text)', 'execute')
				= (v_role = 'qorpera_secret_broker')
			and has_function_privilege(v_role, 'public.qorpera_receive_event(text,text,jsonb,text)', 'execute')
				= (v_role = 'service_role')
			and has_function_privilege(v_role, 'public.qorpera_folder_read_hook_capture(uuid,text,jsonb,uuid,text,text)',
				'execute') = (v_role = 'qorpera_secret_broker')
			and not has_function_privilege(v_role,
				'public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)', 'execute')
			and not has_table_privilege(v_role, 'public.qorpera_event_hook_capture_keys', 'select, update'),
			'5: the patched functions keep their grants, and the capture keys stay closed, for ' || v_role);
	end loop;
end $$;

rollback;
