-- @fixture 420_folder_stripe_hook_hold.test.sql until "-- 1. A Stripe signature that does not match holds the hook"
-- The platform's numbers of a company, door `orders` (company views step 5, slice O1, 20260930776000) on 420's fixture:
-- 924's folder-v2 company, its broker, a Stripe hook (and a GitHub one) the broker opened, the intake on. Each Stripe
-- event is delivered the real way: the intake receives it, the broker claims it and finishes it verified with the
-- event's id and type (qorpera_finish_event_verification, as the vault does), and the trigger makes the order. Checked
-- here: the grants, the tables (closed, no column for a buyer's data) and the trigger; each event type; events out of
-- order; duplicates (one delivery twice, two deliveries of one payment); a strange body (and a failing order write)
-- leaves the verification as it was; a locked order is retried by the upkeep; test and live apart; the company's zone;
-- every question's answer, defaults, bounds and refusals; rights (in one place); the privacy rule (no column of a new
-- table holds any of a buyer's details or Stripe's ids); the back-fill; the upkeep (days, once; whole at any time; 400
-- days) and its schedule. Each numbered block stands alone (it clears the orders first), so it can be run by itself.

-- Every call answers 'ok' or '<sqlstate> <message>'.
create function pg_temp.o_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.o_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.o_json(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.o_actor() returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId') from (select current_setting('qorpera_test.base_binding')::jsonb as b) s
$$;
-- A member's ask, as their token makes it; the claims are the service role's again afterwards.
create function pg_temp.o_member(p_user uuid, p_question text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_member_company_numbers(p_environment, p_question, p_params);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.o_ask(p_question text, p_params jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select pg_temp.o_member('92400000-0000-4000-8000-000000000001', p_question, p_params)
$$;
create function pg_temp.o_rows(p_question text, p_params jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select pg_temp.o_ask(p_question, p_params) -> 'rows'
$$;
-- orders-now's one row as {column: value}.
create function pg_temp.o_now(p_params jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select jsonb_object_agg(col.name, answer -> 'rows' -> 0 -> (col.place::integer - 1))
	from pg_temp.o_ask('orders-now', p_params) as answer,
		jsonb_array_elements_text(answer -> 'columns') with ordinality as col(name, place)
$$;
create function pg_temp.o_refused(p_question text, p_params jsonb default '{}'::jsonb,
	p_user uuid default '92400000-0000-4000-8000-000000000001',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns text language plpgsql as $$
declare v text;
begin
	v := pg_temp.o_state(format('select pg_temp.o_member(%L, %L, %L::jsonb, %L)', p_user, p_question, p_params,
		p_environment));
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- A run's ask as the native host's dispatch makes it (the service role).
create function pg_temp.o_run(p_question text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_run_company_numbers(p_environment, pg_temp.o_actor(), p_question, p_params);
end $$;

-- The broker's verified verdict with the event's id and type, as the vault gives it.
create function pg_temp.o_finish(p_item jsonb, p_key text, p_type text) returns jsonb language plpgsql as $$
declare v_answer jsonb;
begin
	perform set_config('request.jwt.claims', '', true);
	set local session authorization qorpera_secret_broker;
	v_answer := public.qorpera_finish_event_verification('41900000-0000-4000-8000-000000000040', repeat('9', 64),
		(p_item ->> 'deliveryId')::uuid, (p_item ->> 'claim')::uuid, 'verified', p_key, p_type, null);
	reset session authorization;
	return v_answer;
end $$;
grant execute on function pg_temp.o_finish(jsonb, text, text) to qorpera_secret_broker;
-- One delivery of raw bytes to hook h ('stripe' or 'github'), received, claimed and finished verified with the given
-- id and type: the verdict's outcome and the delivery's id. It is moved out of the hook's minute afterwards, so the
-- test's many deliveries are never limited.
create function pg_temp.o_deliver_raw(p_body bytea, p_key text, p_type text, p_hook text default 'stripe')
returns jsonb language plpgsql as $$
declare v_hook public.qorpera_event_hooks; v_received jsonb; v_item jsonb; v_answer jsonb;
begin
	select hook.* into v_hook from public.qorpera_event_hooks as hook
	where hook.id = current_setting('qorpera_test.e3h_' || p_hook)::uuid;
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_received := public.qorpera_receive_event(v_hook.address, 'application/json', case v_hook.proof
		when 'stripe' then '{"stripe-signature": "t=1790000000,v1=00"}'
		else '{"x-hub-signature-256": "sha256=00", "x-github-event": "push"}' end::jsonb, encode(p_body, 'base64'));
	reset role;
	if v_received ->> 'outcome' is distinct from 'accepted' then
		raise exception 'Setup: the intake did not take it: %', v_received; end if;
	v_item := pg_temp.e3h_claim() -> (v_received ->> 'deliveryId');
	if v_item is null then raise exception 'Setup: the broker did not claim %', v_received; end if;
	v_answer := pg_temp.o_finish(v_item, p_key, p_type);
	update public.qorpera_event_deliveries set received_at = received_at - interval '2 minutes'
	where id = (v_received ->> 'deliveryId')::uuid;
	return jsonb_build_object('outcome', v_answer ->> 'outcome', 'delivery', v_received ->> 'deliveryId');
end $$;
-- A Stripe event delivered: the verdict's outcome.
create function pg_temp.o_send(p_event jsonb, p_hook text default 'stripe') returns text language sql as $$
	select pg_temp.o_deliver_raw(convert_to(p_event::text, 'UTF8'), p_event ->> 'id', p_event ->> 'type', p_hook)
		->> 'outcome'
$$;

-- Stripe's shapes, with everything a buyer leaves in them. An event of an object, at a time (the object's own, else now).
create function pg_temp.o_event(p_id text, p_type text, p_object jsonb, p_at timestamptz default null) returns jsonb
language sql as $$
	select jsonb_build_object('id', p_id, 'object', 'event', 'api_version', '2025-10-29.clover', 'type', p_type,
		'created', extract(epoch from coalesce(p_at, clock_timestamp()))::bigint, 'livemode', p_object -> 'livemode',
		'pending_webhooks', 1, 'request', jsonb_build_object('id', 'req_KarenPrivate1', 'idempotency_key', 'karen-key-1'),
		'data', jsonb_build_object('object', p_object))
$$;
create function pg_temp.o_session(p_cs text, p_pi text, p_amount bigint, p_at timestamptz, p_currency text default 'dkk',
	p_live boolean default true, p_status text default 'paid', p_mode text default 'payment') returns jsonb
language sql as $$
	select jsonb_build_object('id', p_cs, 'object', 'checkout.session', 'mode', p_mode, 'amount_total', p_amount,
		'amount_subtotal', p_amount, 'currency', p_currency, 'payment_intent', p_pi,
		'created', extract(epoch from p_at)::bigint, 'livemode', p_live, 'payment_status', p_status, 'status', 'complete',
		'customer', 'cus_SecretCustomer123', 'customer_email', 'karen.blixen@example.dk',
		'customer_details', jsonb_build_object('name', 'Karen Blixen', 'email', 'karen.blixen@example.dk',
			'phone', '+4512345678', 'address', jsonb_build_object('line1', 'Rungstedlund 111', 'city', 'Rungsted Kyst',
				'postal_code', 'DK-2960', 'country', 'DK')),
		'shipping_details', jsonb_build_object('name', 'Karen Blixen', 'address',
			jsonb_build_object('line1', 'Rungstedlund 111', 'postal_code', '2960', 'country', 'DK')),
		'metadata', jsonb_build_object('note', 'leave at the door'), 'client_reference_id', 'karen-ref-77',
		'description', 'Two beeswax candles', 'payment_link', 'plink_KarenCandles')
$$;
create function pg_temp.o_charge(p_pi text, p_amount bigint, p_refunded bigint, p_live boolean default true)
returns jsonb language sql as $$
	select jsonb_build_object('id', 'ch_KarenCharge1', 'object', 'charge', 'amount', p_amount,
		'amount_refunded', p_refunded, 'currency', 'dkk', 'payment_intent', p_pi, 'livemode', p_live,
		'refunded', p_refunded >= p_amount, 'customer', 'cus_SecretCustomer123', 'receipt_email', 'karen.blixen@example.dk',
		'billing_details', jsonb_build_object('name', 'Karen Blixen', 'email', 'karen.blixen@example.dk',
			'phone', '+4512345678', 'address', jsonb_build_object('line1', 'Rungstedlund 111', 'postal_code', '2960',
				'country', 'DK')),
		'payment_method_details', jsonb_build_object('card', jsonb_build_object('brand', 'visa', 'last4', '4242',
			'country', 'DK', 'fingerprint', 'KarenFingerprint99')),
		'description', 'Two beeswax candles', 'metadata', jsonb_build_object('note', 'leave at the door'))
$$;
create function pg_temp.o_dispute(p_pi text, p_status text, p_live boolean default true) returns jsonb
language sql as $$
	select jsonb_build_object('id', 'dp_KarenDispute1', 'object', 'dispute', 'amount', 25000, 'currency', 'dkk',
		'charge', 'ch_KarenCharge1', 'payment_intent', p_pi, 'status', p_status, 'reason', 'fraudulent', 'livemode', p_live,
		'evidence', jsonb_build_object('customer_name', 'Karen Blixen', 'customer_email_address', 'karen.blixen@example.dk',
			'customer_purchase_ip', '203.0.113.9', 'billing_address', 'Rungstedlund 111, 2960'))
$$;
-- An order as 'YYYY-MM-DDTHH:MI currency amount refunded dispute state/by' ('-' for nothing), or null without a row.
create function pg_temp.o_order(p_ref text, p_live boolean default true) returns text language sql as $$
	select concat_ws(' ', coalesce(to_char(o.ordered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), '-'),
		coalesce(o.currency, '-'), coalesce(o.amount_minor::text, '-'), o.refunded_minor, coalesce(o.dispute, '-'),
		coalesce(o.state || '/' || o.state_by, '-'))
	from public.qorpera_orders as o
	where o.profile_id = '92400000-0000-4000-8000-000000000010' and o.live = p_live
		and o.ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', p_ref)
$$;
create function pg_temp.o_count() returns bigint language sql as $$
	select count(*) from public.qorpera_orders where profile_id = '92400000-0000-4000-8000-000000000010'
$$;
-- A time as the order line shows it.
create function pg_temp.o_min(p_at timestamptz) returns text language sql as $$
	select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI')
$$;
-- Now, to the second (so a session made now is today's).
create function pg_temp.o_at() returns timestamptz language sql as $$
	select date_trunc('second', clock_timestamp())
$$;
-- The company's today while it has no zone of its own.
create function pg_temp.o_today() returns date language sql as $$
	select (clock_timestamp() at time zone 'Europe/Copenhagen')::date
$$;
-- A stand-in for a lock held past the wait: a trigger on qorpera_orders that raises lock_not_available.
create function public.o1274_busy() returns trigger language plpgsql as $$
begin
	raise exception 'busy' using errcode = '55P03';
end $$;
-- Every block starts from no orders and no deliveries, in Copenhagen's zone.
create function pg_temp.o_clean() returns void language sql as $$
	delete from public.qorpera_order_retries;
	delete from public.qorpera_order_days;
	delete from public.qorpera_orders;
	delete from public.qorpera_event_deliveries where hook_id in (current_setting('qorpera_test.e3h_stripe')::uuid,
		current_setting('qorpera_test.e3h_github')::uuid);
	update public.qorpera_profiles set time_zone = null where id = '92400000-0000-4000-8000-000000000010';
$$;
-- Every text of the new tables' rows, for the privacy rule.
create function pg_temp.o_everything() returns text language sql as $$
	select concat_ws(E'\n', (select string_agg(o::text, E'\n') from public.qorpera_orders as o),
		(select string_agg(d::text, E'\n') from public.qorpera_order_days as d),
		(select string_agg(r::text, E'\n') from public.qorpera_order_retries as r),
		(select string_agg(u::text, E'\n') from public.qorpera_order_upkeep as u))
$$;

-- Another company with its own member and no Stripe hook.
insert into auth.users(id, email) values ('12740000-0000-4000-8000-000000000006', 'orders-other@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12740000-0000-4000-8000-000000000010', 'Orders other', '12740000-0000-4000-8000-000000000006');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12740000-0000-4000-8000-000000000010', '12740000-0000-4000-8000-000000000006', 'orders-other@example.test',
		'Other owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12740000-0000-4000-8000-000000000020', '12740000-0000-4000-8000-000000000010', 'Environment', 1,
	'12740000-0000-4000-8000-000000000006');
select pg_temp.base_claims('service_role');
select public.qorpera_folder_enable('12740000-0000-4000-8000-000000000020') \g /dev/null

-- The Stripe hook's secret, version 1, as 420 captures it; its minute at the most a hook may take.
select set_config('qorpera_test.o_capture', pg_temp.e3h_capture('1', 1)::text, true);
update public.qorpera_event_hooks set per_minute = 120
where id in (current_setting('qorpera_test.e3h_stripe')::uuid, current_setting('qorpera_test.e3h_github')::uuid);
select pg_temp.base_assert((select current_version from public.qorpera_event_hooks as hook
	cross join lateral public.qorpera_event_hook_secret(hook) as secret
	where hook.id = current_setting('qorpera_test.e3h_stripe')::uuid) = 1,
	'Setup: the Stripe hook''s secret is in the vault: ' || current_setting('qorpera_test.o_capture'));

-- The checks start here.

-- 1. The grants: every new function and table closed to the API roles; RLS on; no column that could hold a buyer's
--    data; the trigger after a status turns verified; the dispatcher's markers; the migration's back-fill and schedule.
do $$
declare v_function text; v_table text; v_role text;
begin
	foreach v_function in array array['public.qorpera_order_ref_sha256(uuid,text)',
		'public.qorpera_order_stripe_time(jsonb)', 'public.qorpera_order_stripe_minor(jsonb)',
		'public.qorpera_order_stripe_id(jsonb,text)', 'public.qorpera_order_fact(public.qorpera_event_deliveries)',
		'public.qorpera_order_from_delivery()', 'public.qorpera_order_backfill()',
		'public.qorpera_order_upkeep(timestamptz)', 'public.qorpera_schedule_order_upkeep()',
		'public.qorpera_company_numbers_orders_readable(uuid,uuid,jsonb)', 'public.qorpera_order_major(numeric,text)',
		'public.qorpera_order_day_rows(uuid,uuid,boolean,text,text,date,date)',
		'public.qorpera_company_numbers_orders(uuid,uuid,timestamptz,text,jsonb)',
		'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is open to %', v_function, v_role; end if;
		end loop;
	end loop;
	if not has_function_privilege('authenticated', 'public.qorpera_member_company_numbers(uuid,text,jsonb)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_run_company_numbers(uuid,jsonb,text,jsonb)',
			'EXECUTE') then
		raise exception 'the two doors lost their grants'; end if;
	foreach v_table in array array['public.qorpera_orders', 'public.qorpera_order_days', 'public.qorpera_order_retries',
		'public.qorpera_order_upkeep'] loop
		if not (select relrowsecurity from pg_class where oid = v_table::regclass) then
			raise exception '% has no row level security', v_table; end if;
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_table_privilege(v_role, v_table, 'SELECT') or has_table_privilege(v_role, v_table, 'INSERT')
				or has_table_privilege(v_role, v_table, 'UPDATE') or has_table_privilege(v_role, v_table, 'DELETE') then
				raise exception '% is open to %', v_table, v_role; end if;
		end loop;
	end loop;
	-- Every column there is: no name, email, phone, address, country, IP, card, customer, metadata, description or item.
	perform pg_temp.o_same((select string_agg(table_name || '.' || column_name, ',' order by table_name collate "C",
			ordinal_position)
		from information_schema.columns where table_schema = 'public' and table_name in ('qorpera_orders',
			'qorpera_order_days', 'qorpera_order_retries', 'qorpera_order_upkeep')),
		'qorpera_order_days.profile_id,qorpera_order_days.environment_id,qorpera_order_days.live,qorpera_order_days.day,'
		'qorpera_order_days.currency,qorpera_order_days.orders,qorpera_order_days.sales_minor,'
		'qorpera_order_days.refunds_minor,'
		'qorpera_order_retries.delivery_id,qorpera_order_retries.profile_id,qorpera_order_retries.since,'
		'qorpera_order_retries.attempts,'
		'qorpera_order_upkeep.id,qorpera_order_upkeep.ran_at,qorpera_order_upkeep.stopped,'
		'qorpera_orders.id,qorpera_orders.profile_id,qorpera_orders.environment_id,qorpera_orders.hook_id,'
		'qorpera_orders.source,qorpera_orders.live,qorpera_orders.ref_sha256,qorpera_orders.ordered_at,'
		'qorpera_orders.currency,qorpera_orders.amount_minor,qorpera_orders.refunded_minor,qorpera_orders.dispute,'
		'qorpera_orders.dispute_at,qorpera_orders.state,qorpera_orders.state_at,qorpera_orders.state_by,'
		'qorpera_orders.made_at,qorpera_orders.changed_at,qorpera_orders.rolled,qorpera_orders.rolled_day,'
		'qorpera_orders.rolled_currency,qorpera_orders.rolled_orders,qorpera_orders.rolled_sales_minor,'
		'qorpera_orders.rolled_refunds_minor', 'the tables'' columns');
	perform pg_temp.o_same((select array_to_string(proconfig, ',') from pg_proc
		where oid = 'public.qorpera_order_fact(public.qorpera_event_deliveries)'::regprocedure),
		'search_path="",lock_timeout=100ms', 'the fact waits 100 ms for a lock');
	perform pg_temp.o_same((select prosecdef::text from pg_proc
		where oid = 'public.qorpera_order_from_delivery()'::regprocedure), 'true', 'the trigger writes as its owner');
end $$;

-- 2. A Stripe hook that has verified nothing is waiting; a paid Checkout Session makes one order, and nothing a buyer
--    left in the event (name, email, phone, address, country, IP, card, customer, metadata, description) nor Stripe's
--    ids reaches any new table.
do $$
declare v_at timestamptz := pg_temp.o_at(); v_now jsonb; v_secret text;
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_same(pg_temp.o_now() ->> 'stripe', 'waiting', 'a hook that verified nothing yet');
	perform pg_temp.o_same(pg_temp.o_send(pg_temp.o_event('evt_Karen1', 'checkout.session.completed',
		pg_temp.o_session('cs_live_KarenSession1', 'pi_KarenPayment1', 25000, v_at))), 'verified', 'the verdict');
	perform pg_temp.o_same(pg_temp.o_order('pi_KarenPayment1'), pg_temp.o_min(v_at) || ' dkk 25000 0 - paid/stripe',
		'the order');
	perform pg_temp.o_same((select hook_id::text || ' ' || source || ' ' || environment_id from public.qorpera_orders),
		current_setting('qorpera_test.e3h_stripe') || ' stripe 92400000-0000-4000-8000-000000000020', 'its hook');
	-- Its key: sha256 of '<company id>:<payment intent id>', nothing else of Stripe's.
	perform pg_temp.o_same((select ref_sha256 from public.qorpera_orders), encode(extensions.digest(
		'92400000-0000-4000-8000-000000000010:pi_KarenPayment1', 'sha256'), 'hex'), 'its key');
	v_now := pg_temp.o_now();
	perform pg_temp.o_same(v_now ->> 'stripe', 'live', 'a hook that verified a delivery');
	perform pg_temp.o_same((v_now -> 'orders_today')::text || ' ' || (v_now -> 'sales_today')::text, '1 250.00',
		'today''s order');
	perform pg_temp.o_same(v_now ->> 'last_order_at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'the last order');
	perform public.qorpera_order_upkeep();
	-- (Digit-only values, a card's last four or a postal code, could match an amount or a time by chance: the columns'
	-- list in block 1 has no place for them.)
	foreach v_secret in array array['Karen', 'Blixen', 'karen.blixen@example.dk', 'example.dk', '+4512345678',
		'Rungstedlund', 'Rungsted', 'DK-2960', 'DK', '203.0.113.9', 'visa', 'KarenFingerprint99',
		'cus_SecretCustomer123', 'leave at the door', 'beeswax', 'karen-ref-77', 'plink_KarenCandles', 'req_KarenPrivate1',
		'karen-key-1', 'cs_live_KarenSession1', 'pi_KarenPayment1', 'KarenPayment1', 'evt_Karen1', 'ch_KarenCharge1'] loop
		if strpos(pg_temp.o_everything(), v_secret) > 0 then
			raise exception 'A new table holds %: %', v_secret, pg_temp.o_everything(); end if;
	end loop;
end $$;

-- 3. Each event type: a paid session; an unpaid one that waits, then succeeds; one that fails (and failed never undoes
--    paid); free (no payment required); a subscription and setup are no orders;
--    refunds (Stripe's running total, a stale one too); disputes (open, won, lost, warning_closed is won); another
--    type is nothing.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '1 hour';
begin
	perform pg_temp.o_clean();
	-- Async: unpaid waits (no state, no order), succeeded is paid.
	perform pg_temp.o_send(pg_temp.o_event('evt_A1', 'checkout.session.completed',
		pg_temp.o_session('cs_A', 'pi_Async', 10000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Async'), pg_temp.o_min(v_at) || ' dkk 10000 0 - -', 'unpaid waits');
	perform pg_temp.o_same(pg_temp.o_now() ->> 'orders_today', '0', 'an unpaid session is no order');
	perform pg_temp.o_send(pg_temp.o_event('evt_A2', 'checkout.session.async_payment_succeeded',
		pg_temp.o_session('cs_A', 'pi_Async', 10000, v_at, 'dkk', true, 'paid')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Async'), pg_temp.o_min(v_at) || ' dkk 10000 0 - paid/stripe', 'succeeded');
	-- A failure after paid changes nothing.
	perform pg_temp.o_send(pg_temp.o_event('evt_A3', 'checkout.session.async_payment_failed',
		pg_temp.o_session('cs_A', 'pi_Async', 10000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Async'), pg_temp.o_min(v_at) || ' dkk 10000 0 - paid/stripe',
		'failed never undoes paid');
	-- Unpaid, then failed.
	perform pg_temp.o_send(pg_temp.o_event('evt_F1', 'checkout.session.completed',
		pg_temp.o_session('cs_F', 'pi_Failed', 7000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_send(pg_temp.o_event('evt_F2', 'checkout.session.async_payment_failed',
		pg_temp.o_session('cs_F', 'pi_Failed', 7000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Failed'), pg_temp.o_min(v_at) || ' dkk 7000 0 - failed/stripe', 'failed');
	-- An unpaid completed after the failure keeps it failed; a success over it is paid.
	perform pg_temp.o_send(pg_temp.o_event('evt_F3', 'checkout.session.completed',
		pg_temp.o_session('cs_F', 'pi_Failed', 7000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Failed'), pg_temp.o_min(v_at) || ' dkk 7000 0 - failed/stripe',
		'unpaid after failed');
	perform pg_temp.o_send(pg_temp.o_event('evt_F4', 'checkout.session.async_payment_succeeded',
		pg_temp.o_session('cs_F', 'pi_Failed', 7000, v_at, 'dkk', true, 'paid')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Failed'), pg_temp.o_min(v_at) || ' dkk 7000 0 - paid/stripe',
		'paid over failed');
	-- Free, a subscription by its session, setup nothing.
	perform pg_temp.o_send(pg_temp.o_event('evt_Free', 'checkout.session.completed',
		pg_temp.o_session('cs_Free', 'pi_Free', 0, v_at, 'dkk', true, 'no_payment_required')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Free'), pg_temp.o_min(v_at) || ' dkk 0 0 - paid/stripe', 'free');
	perform pg_temp.o_send(pg_temp.o_event('evt_Sub', 'checkout.session.completed',
		pg_temp.o_session('cs_Subscription', null, 9900, v_at, 'dkk', true, 'paid', 'subscription')));
	perform pg_temp.o_same(coalesce(pg_temp.o_order('cs_Subscription'), 'none'), 'none',
		'a subscription is no order (its refunds could not be joined)');
	perform pg_temp.o_send(pg_temp.o_event('evt_Setup', 'checkout.session.completed',
		pg_temp.o_session('cs_Setup', 'pi_Setup', 0, v_at, 'dkk', true, 'no_payment_required', 'setup')));
	perform pg_temp.o_same(coalesce(pg_temp.o_order('pi_Setup'), pg_temp.o_order('cs_Setup'), 'none'), 'none',
		'setup is no order');
	-- Refunds: the running total, never back.
	perform pg_temp.o_send(pg_temp.o_event('evt_R1', 'charge.refunded', pg_temp.o_charge('pi_Async', 10000, 2500)));
	perform pg_temp.o_same(pg_temp.o_order('pi_Async'), pg_temp.o_min(v_at) || ' dkk 10000 2500 - paid/stripe',
		'a partial refund');
	perform pg_temp.o_send(pg_temp.o_event('evt_R2', 'charge.refunded', pg_temp.o_charge('pi_Async', 10000, 10000)));
	perform pg_temp.o_send(pg_temp.o_event('evt_R3', 'charge.refunded', pg_temp.o_charge('pi_Async', 10000, 2500)));
	perform pg_temp.o_same(pg_temp.o_order('pi_Async'), pg_temp.o_min(v_at) || ' dkk 10000 10000 - paid/stripe',
		'refunded in full, a stale partial after it');
	-- Disputes: open, then closed won, then a newer lost; an older open after it changes nothing.
	perform pg_temp.o_send(pg_temp.o_event('evt_D1', 'charge.dispute.created', pg_temp.o_dispute('pi_Free', 'needs_response'),
		v_at + interval '1 minute'));
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Free'), ' ', 5), 'open', 'a dispute opened');
	perform pg_temp.o_send(pg_temp.o_event('evt_D2', 'charge.dispute.closed', pg_temp.o_dispute('pi_Free', 'won'),
		v_at + interval '2 minutes'));
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Free'), ' ', 5), 'won', 'won');
	perform pg_temp.o_send(pg_temp.o_event('evt_D3', 'charge.dispute.closed', pg_temp.o_dispute('pi_Free', 'lost'),
		v_at + interval '3 minutes'));
	perform pg_temp.o_send(pg_temp.o_event('evt_D4', 'charge.dispute.created', pg_temp.o_dispute('pi_Free', 'needs_response'),
		v_at + interval '1 minute'));
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Free'), ' ', 5), 'lost', 'a newer lost; an older open after');
	perform pg_temp.o_send(pg_temp.o_event('evt_D5', 'charge.dispute.closed',
		pg_temp.o_dispute('pi_Failed', 'warning_closed'), v_at));
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Failed'), ' ', 5), 'won', 'warning_closed kept the money');
	-- A close and an open of the same second: the close, whichever comes last.
	perform pg_temp.o_send(pg_temp.o_event('evt_D6', 'charge.dispute.closed', pg_temp.o_dispute('pi_Async', 'lost'), v_at));
	perform pg_temp.o_send(pg_temp.o_event('evt_D7', 'charge.dispute.created', pg_temp.o_dispute('pi_Async', 'needs_response'),
		v_at));
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Async'), ' ', 5), 'lost', 'a close beats an open of its second');
	perform pg_temp.o_send(pg_temp.o_event('evt_D8', 'charge.dispute.created', pg_temp.o_dispute('pi_Subscription', 'x'),
		v_at));
	-- Another type changes nothing.
	perform pg_temp.o_send(pg_temp.o_event('evt_Other', 'payment_intent.succeeded',
		jsonb_build_object('id', 'pi_Other', 'object', 'payment_intent', 'amount', 500, 'currency', 'dkk', 'livemode', true,
			'created', extract(epoch from v_at)::bigint)));
	perform pg_temp.o_same(pg_temp.o_count()::text, '4', 'four rows: async, failed, free, a dispute');
	perform pg_temp.o_same(pg_temp.o_order('pi_Subscription'), '- - - 0 open -', 'a dispute of an unknown payment');
end $$;

-- 4. Out of order: a refund and a dispute before their session make the row (no order yet); the session fills it.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '1 hour';
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_send(pg_temp.o_event('evt_O1', 'charge.refunded', pg_temp.o_charge('pi_Late', 25000, 5000)));
	perform pg_temp.o_send(pg_temp.o_event('evt_O2', 'charge.dispute.created', pg_temp.o_dispute('pi_Late', 'needs_response')));
	perform pg_temp.o_same(pg_temp.o_order('pi_Late'), '- - - 5000 open -', 'the row before its session');
	perform pg_temp.o_same(pg_temp.o_now() ->> 'orders_today', '0', 'no order yet');
	perform pg_temp.o_same((pg_temp.o_now() -> 'disputes_open')::text, '1', 'its dispute counts');
	perform pg_temp.o_send(pg_temp.o_event('evt_O3', 'checkout.session.completed',
		pg_temp.o_session('cs_Late', 'pi_Late', 25000, v_at)));
	perform pg_temp.o_same(pg_temp.o_order('pi_Late'), pg_temp.o_min(v_at) || ' dkk 25000 5000 open paid/stripe',
		'the session fills it');
	perform pg_temp.o_same(pg_temp.o_count()::text, '1', 'one row');
end $$;

-- 5. Duplicates: the same event delivered twice is a duplicate (no body, no second fact); two deliveries of one payment
--    (completed and succeeded, two event ids) are one order; the back-fill over applied deliveries changes nothing.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '1 hour'; v_event jsonb; v_before text; v_changed timestamptz;
begin
	perform pg_temp.o_clean();
	v_event := pg_temp.o_event('evt_Twice', 'checkout.session.completed', pg_temp.o_session('cs_Twice', 'pi_Twice', 4000, v_at));
	perform pg_temp.o_same(pg_temp.o_send(v_event), 'verified', 'the first');
	select changed_at into v_changed from public.qorpera_orders;
	perform pg_temp.o_same(pg_temp.o_send(v_event), 'duplicate', 'the same event again');
	perform pg_temp.o_same((select changed_at = v_changed from public.qorpera_orders)::text, 'true',
		'a duplicate is no fact');
	perform pg_temp.o_send(pg_temp.o_event('evt_Twice2', 'checkout.session.async_payment_succeeded',
		pg_temp.o_session('cs_Twice', 'pi_Twice', 4000, v_at)));
	perform pg_temp.o_same(pg_temp.o_count()::text || ' ' || (pg_temp.o_now() -> 'orders_today')::text, '1 1',
		'two deliveries of one payment: one order');
	v_before := pg_temp.o_order('pi_Twice');
	perform public.qorpera_order_backfill();
	perform pg_temp.o_same(pg_temp.o_count()::text || ' ' || pg_temp.o_order('pi_Twice'), '1 ' || v_before,
		'the back-fill again');
end $$;

-- 6. A strange body never fails the verification and makes nothing: not UTF-8, not JSON, an array, no data.object, no
--    livemode, an amount that is text or too long, a bad currency, a payment intent of another kind, a session without
--    its time; a Stripe-shaped event on a GitHub hook. A failing order write (a constraint) is caught too.
do $$
declare v_at timestamptz := pg_temp.o_at(); v_body bytea; v_got jsonb; v_session jsonb;
begin
	perform pg_temp.o_clean();
	v_session := pg_temp.o_session('cs_Bad', 'pi_Bad', 1000, v_at);
	foreach v_body in array array['\xfffe7b7d'::bytea, convert_to('{"type": "checkout.session.completed", "data": {', 'UTF8'),
		convert_to('[1, 2, 3]', 'UTF8'),
		convert_to('{"id": "evt_B", "type": "checkout.session.completed", "data": {}}', 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'checkout.session.completed', v_session - 'livemode')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'checkout.session.completed',
			v_session || '{"amount_total": "1000"}')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'checkout.session.completed',
			v_session || '{"amount_total": 1234567890123456}')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'checkout.session.completed',
			v_session || '{"amount_total": -5}')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'checkout.session.completed', v_session || '{"currency": "kr."}')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'checkout.session.completed',
			v_session || '{"payment_intent": "ch_Bad", "id": "sess_Bad"}')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'checkout.session.completed', v_session - 'created')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'charge.refunded',
			pg_temp.o_charge('pi_Bad', 1000, 500) || '{"amount_refunded": 1.5}')::text, 'UTF8'),
		convert_to(pg_temp.o_event('evt_B', 'charge.dispute.closed', pg_temp.o_dispute('pi_Bad', 'under_review'))::text,
			'UTF8')] loop
		v_got := pg_temp.o_deliver_raw(v_body, 'evt_Bad' || md5(v_body::text), 'checkout.session.completed');
		perform pg_temp.o_same((v_got ->> 'outcome') || ' ' || (select status || ' ' || (verified_at is not null)::text
			|| ' ' || (body = v_body)::text from public.qorpera_event_deliveries where id = (v_got ->> 'delivery')::uuid),
			'verified verified true true', 'a strange body is verified as it is: ' || encode(v_body, 'escape'));
	end loop;
	v_got := pg_temp.o_deliver_raw(convert_to(pg_temp.o_event('evt_Github', 'checkout.session.completed', v_session)::text,
		'UTF8'), 'evt_Github', 'checkout.session.completed', 'github');
	perform pg_temp.o_same(v_got ->> 'outcome', 'verified', 'a GitHub delivery');
	perform pg_temp.o_same(pg_temp.o_count() || ' ' || (select count(*) from public.qorpera_order_retries), '0 0',
		'nothing made, nothing to retry');
	-- An order write that fails is caught: the verification stands.
	alter table public.qorpera_orders add constraint o1274_never check (amount_minor < 0);
	v_got := pg_temp.o_deliver_raw(convert_to(pg_temp.o_event('evt_Fails', 'checkout.session.completed', v_session)::text,
		'UTF8'), 'evt_Fails', 'checkout.session.completed');
	alter table public.qorpera_orders drop constraint o1274_never;
	perform pg_temp.o_same((v_got ->> 'outcome') || ' ' || (select status from public.qorpera_event_deliveries
		where id = (v_got ->> 'delivery')::uuid) || ' ' || pg_temp.o_count(), 'verified verified 0', 'a failing write');
end $$;

-- 7. A locked order: the fact is put aside, the verification stands; the upkeep retries it; one whose body is gone is
--    dropped. (The lock is a stand-in trigger that raises lock_not_available, as a lock held past 100 ms does.)
do $$
declare v_at timestamptz := pg_temp.o_at(); v_got jsonb; v_up jsonb;
begin
	perform pg_temp.o_clean();
	create trigger o1274_busy before insert or update on public.qorpera_orders
		for each row execute function public.o1274_busy();
	v_got := pg_temp.o_deliver_raw(convert_to(pg_temp.o_event('evt_Busy', 'checkout.session.completed',
		pg_temp.o_session('cs_Busy', 'pi_Busy', 3000, v_at))::text, 'UTF8'), 'evt_Busy', 'checkout.session.completed');
	perform pg_temp.o_deliver_raw(convert_to(pg_temp.o_event('evt_Busy2', 'checkout.session.completed',
		pg_temp.o_session('cs_Busy2', 'pi_Busy2', 3000, v_at))::text, 'UTF8'), 'evt_Busy2', 'checkout.session.completed');
	perform pg_temp.o_same((v_got ->> 'outcome') || ' ' || pg_temp.o_count() || ' '
		|| (select count(*) from public.qorpera_order_retries), 'verified 0 2', 'put aside');
	-- Still locked at the upkeep: waits, counted.
	v_up := public.qorpera_order_upkeep();
	perform pg_temp.o_same((v_up ->> 'retryWaiting') || ' ' || (select string_agg(attempts::text, ',')
		from public.qorpera_order_retries), '2 1,1', 'still locked');
	drop trigger o1274_busy on public.qorpera_orders;
	-- The second's body is cleared (as after 7 days): dropped.
	update public.qorpera_event_deliveries set body = null where hook_id = current_setting('qorpera_test.e3h_stripe')::uuid
		and delivery_key = 'evt_Busy2';
	v_up := public.qorpera_order_upkeep();
	perform pg_temp.o_same((v_up ->> 'retried') || ' ' || (v_up ->> 'retryDropped') || ' '
		|| (select count(*) from public.qorpera_order_retries), '1 1 0', 'retried and dropped');
	perform pg_temp.o_same(pg_temp.o_order('pi_Busy'), pg_temp.o_min(v_at) || ' dkk 3000 0 - paid/stripe',
		'the retried order');
	perform pg_temp.o_same(coalesce(pg_temp.o_order('pi_Busy2'), 'none'), 'none', 'no body, no order');
end $$;

-- 8. Test and live apart: a test purchase answers only with test: true (also "true"); the live answer stays empty.
do $$
declare v_at timestamptz := pg_temp.o_at();
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_send(pg_temp.o_event('evt_T1', 'checkout.session.completed',
		pg_temp.o_session('cs_test_Same', 'pi_Same', 1500, v_at, 'dkk', false)));
	perform pg_temp.o_send(pg_temp.o_event('evt_T2', 'charge.refunded', pg_temp.o_charge('pi_Same', 1500, 1500, false)));
	perform pg_temp.o_same(pg_temp.o_order('pi_Same', false) || ' | ' || coalesce(pg_temp.o_order('pi_Same', true), 'none'),
		pg_temp.o_min(v_at) || ' dkk 1500 1500 - paid/stripe | none', 'a test order, refunded');
	perform pg_temp.o_same((pg_temp.o_now() -> 'orders_today')::text || ' ' || coalesce(pg_temp.o_now() ->> 'last_order_at',
		'null'), '0 null', 'live: none');
	perform pg_temp.o_same((pg_temp.o_now('{"test": true}') -> 'orders_today')::text || ' '
		|| (pg_temp.o_now('{"test": true}') -> 'sales_today')::text || ' '
		|| (pg_temp.o_now('{"test": "true"}') -> 'refunds_30d')::text || ' '
		|| (pg_temp.o_now('{"test": false}') -> 'orders_today')::text, '1 15.00 15.00 0', 'test: true');
	-- The same payment id live is another order.
	perform pg_temp.o_send(pg_temp.o_event('evt_T3', 'checkout.session.completed',
		pg_temp.o_session('cs_live_Same', 'pi_Same', 2000, v_at, 'dkk', true)));
	perform pg_temp.o_same(pg_temp.o_order('pi_Same', true), pg_temp.o_min(v_at) || ' dkk 2000 0 - paid/stripe',
		'live apart');
	perform pg_temp.o_same(pg_temp.o_rows('orders-days', '{"test": true}') -> 29 ->> 1 || ' '
		|| (pg_temp.o_rows('orders-days') -> 29 ->> 1), '1 1', 'each mode its own day');
end $$;

-- 9. The company's zone: an order at 05:00 UTC is the day before in Los Angeles, before and after the upkeep adds it;
--    a day added keeps its zone; one not added yet follows the company's zone now.
do $$
declare
	v_day date := current_date - 5;
	v_at timestamptz := (current_date - 5)::timestamp at time zone 'UTC' + interval '5 hours';
	v_range jsonb := jsonb_build_object('from', to_char(current_date - 6, 'YYYY-MM-DD'),
		'to', to_char(current_date - 5, 'YYYY-MM-DD'));
	v_want jsonb;
begin
	perform pg_temp.o_clean();
	update public.qorpera_profiles set time_zone = 'America/Los_Angeles' where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.o_send(pg_temp.o_event('evt_Z1', 'checkout.session.completed',
		pg_temp.o_session('cs_Zone', 'pi_Zone', 12345, v_at)));
	perform pg_temp.o_send(pg_temp.o_event('evt_Z2', 'charge.refunded', pg_temp.o_charge('pi_Zone', 12345, 345)));
	v_want := jsonb_build_array(jsonb_build_array(to_char(v_day - 1, 'YYYY-MM-DD'), 1, 123.45, 3.45),
		jsonb_build_array(to_char(v_day, 'YYYY-MM-DD'), 0, 0, 0));
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_want, 'Los Angeles'' day, from the order');
	perform pg_temp.o_same((public.qorpera_order_upkeep() ->> 'rolled'), '1', 'the upkeep adds it');
	perform pg_temp.o_same((select string_agg(day || ' ' || currency || ' ' || orders || ' ' || sales_minor || ' '
		|| refunds_minor, ',') from public.qorpera_order_days), (v_day - 1)::text || ' dkk 1 12345 345', 'its day');
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_want, 'Los Angeles'' day, from the days');
	perform pg_temp.o_same((pg_temp.o_rows('orders-hours', jsonb_build_object('from',
		to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'), 'to', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'))) -> 0)::text,
		jsonb_build_array(to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(v_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI'), 1, 123.45)::text,
		'its hour, local');
	-- Copenhagen now: the added day stays; a new change follows the new zone (the difference moves the order).
	update public.qorpera_profiles set time_zone = 'Europe/Copenhagen' where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_want, 'an added day keeps its zone');
	perform pg_temp.o_send(pg_temp.o_event('evt_Z3', 'charge.refunded', pg_temp.o_charge('pi_Zone', 12345, 1345)));
	v_want := jsonb_build_array(jsonb_build_array(to_char(v_day - 1, 'YYYY-MM-DD'), 0, 0.00, 0.00),
		jsonb_build_array(to_char(v_day, 'YYYY-MM-DD'), 1, 123.45, 13.45));
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_want, 'a changed order, the zone now');
	perform public.qorpera_order_upkeep();
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_want, 'the same once added');
	perform pg_temp.o_same((select string_agg(day || ' ' || orders || ' ' || sales_minor || ' ' || refunds_minor, ','
		order by day) from public.qorpera_order_days), (v_day - 1)::text || ' 0 0 0,' || v_day::text || ' 1 12345 1345',
		'moved between days');
	-- An unknown zone is Copenhagen's.
	update public.qorpera_profiles set time_zone = 'Mars/Olympus_Mons' where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_want, 'an unknown zone');
end $$;

-- 10. The questions: orders-now (to_pack null until the company sets a state of its own in 90 days; never an order
--     refunded in full), the default currency, zero- and three-decimal currencies, orders-hours, orders-days,
--     orders-months, orders-states, and a company without a Stripe hook.
do $$
declare v_at timestamptz := pg_temp.o_at(); v jsonb; v_month text := to_char(pg_temp.o_today(), 'YYYY-MM');
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_send(pg_temp.o_event('evt_Q1', 'checkout.session.completed', pg_temp.o_session('cs_Q1', 'pi_Q1', 10000, v_at)));
	perform pg_temp.o_send(pg_temp.o_event('evt_Q2', 'checkout.session.completed', pg_temp.o_session('cs_Q2', 'pi_Q2', 20000, v_at)));
	perform pg_temp.o_send(pg_temp.o_event('evt_Q3', 'checkout.session.completed', pg_temp.o_session('cs_Q3', 'pi_Q3', 30000, v_at)));
	perform pg_temp.o_send(pg_temp.o_event('evt_Q4', 'charge.refunded', pg_temp.o_charge('pi_Q3', 30000, 30000)));
	perform pg_temp.o_send(pg_temp.o_event('evt_Q5', 'charge.dispute.created', pg_temp.o_dispute('pi_Q2', 'needs_response')));
	-- A failed payment is no order (it shows only in orders-states).
	perform pg_temp.o_send(pg_temp.o_event('evt_QF1', 'checkout.session.completed',
		pg_temp.o_session('cs_QF', 'pi_QF', 5000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_send(pg_temp.o_event('evt_QF2', 'checkout.session.async_payment_failed',
		pg_temp.o_session('cs_QF', 'pi_QF', 5000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_json(pg_temp.o_now() - 'last_order_at', jsonb_build_object('stripe', 'live', 'orders_today', 3,
		'sales_today', 600.00, 'to_pack', null, 'on_the_way', 0, 'refunds_30d', 300.00, 'disputes_open', 1),
		'no state of the company''s: to_pack is null');
	perform pg_temp.o_json(pg_temp.o_ask('orders-now') -> 'columns', '["stripe", "orders_today", "sales_today", "to_pack",
		"on_the_way", "refunds_30d", "disputes_open", "last_order_at"]', 'the columns');
	-- The company marks one on its way (slice O2 writes this): to_pack counts the paid one not refunded in full.
	update public.qorpera_orders set state = 'on_the_way', state_at = clock_timestamp(), state_by = 'agent', rolled = false
	where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_Q1');
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text || ' ' || (pg_temp.o_now() -> 'on_the_way')::text, '1 1',
		'to pack, on the way');
	-- Stripe's paid after it leaves the company's state as it is.
	perform pg_temp.o_send(pg_temp.o_event('evt_Q6', 'checkout.session.async_payment_succeeded',
		pg_temp.o_session('cs_Q1', 'pi_Q1', 10000, v_at)));
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Q1'), ' ', 6), 'on_the_way/agent', 'the company''s state stays');
	-- A state set more than 90 days ago is no sign of a shop that ships.
	update public.qorpera_orders set state_at = clock_timestamp() - interval '91 days'
	where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_Q1');
	perform pg_temp.o_same(coalesce((pg_temp.o_now() -> 'to_pack')::text, 'sql null'), 'null', '91 days ago');
	-- orders-states, from the order days.
	perform pg_temp.o_json(pg_temp.o_rows('orders-states'), '[["paid", 2, 500.00], ["packed", 0, 0.00],
		["on_the_way", 1, 100.00], ["delivered", 0, 0.00], ["cancelled", 0, 0.00], ["failed", 1, 50.00]]', 'orders-states');
	-- Currencies: four EUR orders (DKK has three) make EUR the default; DKK asked by name (any case); JPY whole; KWD three decimals.
	perform pg_temp.o_send(pg_temp.o_event('evt_E1', 'checkout.session.completed',
		pg_temp.o_session('cs_E1', 'pi_E1', 1999, v_at, 'EUR')));
	perform pg_temp.o_send(pg_temp.o_event('evt_E2', 'checkout.session.completed',
		pg_temp.o_session('cs_E2', 'pi_E2', 1, v_at, 'eur')));
	perform pg_temp.o_send(pg_temp.o_event('evt_E3', 'checkout.session.completed',
		pg_temp.o_session('cs_E3', 'pi_E3', 1, v_at, 'eur')));
	perform pg_temp.o_send(pg_temp.o_event('evt_E4', 'checkout.session.completed',
		pg_temp.o_session('cs_E4', 'pi_E4', 1, v_at, 'eur')));
	perform pg_temp.o_send(pg_temp.o_event('evt_J1', 'checkout.session.completed',
		pg_temp.o_session('cs_J1', 'pi_J1', 1500, v_at, 'jpy')));
	perform pg_temp.o_send(pg_temp.o_event('evt_K1', 'checkout.session.completed',
		pg_temp.o_session('cs_K1', 'pi_K1', 12345, v_at, 'kwd')));
	perform pg_temp.o_same((pg_temp.o_now() -> 'sales_today')::text || ' ' || (pg_temp.o_now('{"currency": "DKK"}') -> 'sales_today')::text
		|| ' ' || (pg_temp.o_now('{"currency": "jpy"}') -> 'sales_today')::text
		|| ' ' || (pg_temp.o_now('{"currency": "kwd"}') -> 'sales_today')::text
		|| ' ' || (pg_temp.o_now('{"currency": "usd"}') -> 'sales_today')::text,
		'20.02 600.00 1500 12.345 0.00', 'currencies');
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text || ' ' || (pg_temp.o_now() -> 'disputes_open')::text,
		'null 1', 'to_pack and disputes count every currency');
	-- orders-hours: by default the 48 hours to this one, zeros included; the order in this hour.
	v := pg_temp.o_ask('orders-hours', '{"currency": "dkk"}');
	perform pg_temp.o_same(jsonb_array_length(v -> 'rows') || ' ' || (v #>> '{rows,47,0}') || ' ' || (v #> '{rows,47,2}')::text
		|| ' ' || (v #> '{rows,47,3}')::text || ' ' || (v #> '{rows,0,2}')::text || ' ' || (v -> 'columns')::text,
		'48 ' || to_char(date_trunc('hour', v_at, 'UTC') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		|| ' 3 600.00 0 ["hour", "hour_local", "orders", "sales"]', 'orders-hours');
	-- orders-days: by default the 30 days to today.
	v := pg_temp.o_ask('orders-days', '{"currency": "dkk"}');
	perform pg_temp.o_same(jsonb_array_length(v -> 'rows') || ' ' || (v #> '{rows,29}')::text || ' ' || (v #> '{rows,0}')::text,
		'30 ' || jsonb_build_array(to_char(pg_temp.o_today(), 'YYYY-MM-DD'), 3, 600.00, 300.00)::text || ' '
		|| jsonb_build_array(to_char(pg_temp.o_today() - 29, 'YYYY-MM-DD'), 0, 0.00, 0.00)::text, 'orders-days');
	-- orders-months: this month and the 11 before.
	v := pg_temp.o_ask('orders-months', '{"currency": "dkk"}');
	perform pg_temp.o_same(jsonb_array_length(v -> 'rows') || ' ' || (v #> '{rows,11}')::text || ' ' || (v #>> '{rows,0,0}'),
		'12 ' || jsonb_build_array(v_month, 3, 600.00, 300.00)::text || ' '
		|| to_char(date_trunc('month', pg_temp.o_today()::timestamp) - interval '11 months', 'YYYY-MM'), 'orders-months');
	-- A company without a Stripe hook.
	perform pg_temp.o_json(pg_temp.o_member('12740000-0000-4000-8000-000000000006', 'orders-now', '{}',
		'12740000-0000-4000-8000-000000000020') -> 'rows', '[["none", 0, 0.00, null, 0, 0.00, 0, null]]', 'no Stripe hook');
	-- A free order is to pack too, once the company sets states of its own.
	update public.qorpera_orders set state_at = clock_timestamp()
	where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_Q1');
	perform pg_temp.o_send(pg_temp.o_event('evt_QFree', 'checkout.session.completed',
		pg_temp.o_session('cs_QFree', 'pi_QFree', 0, v_at, 'dkk', true, 'no_payment_required')));
	-- Q2, the four EUR orders, JPY's, KWD's (to_pack counts every currency) and the free one.
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '8', 'a free order to pack');
	-- The same answer keeps its etag.
	perform pg_temp.o_same(((pg_temp.o_ask('orders-days') ->> 'etag') = (pg_temp.o_ask('orders-days') ->> 'etag'))::text,
		'true', 'the etag');
end $$;

-- 10b. to_pack starts at the first order the company marked (the same mode): a shop that starts marking late does not
--      see its whole history. A test order marked earlier does not move the live start; an order made with the first
--      marked one counts.
do $$
declare v_now timestamptz := pg_temp.o_at(); v_n integer;
begin
	perform pg_temp.o_clean();
	foreach v_n in array array[40, 20, 10, 5, 0] loop
		perform pg_temp.o_send(pg_temp.o_event('evt_L' || v_n, 'checkout.session.completed',
			pg_temp.o_session('cs_L' || v_n, 'pi_L' || v_n, 1000, v_now - make_interval(days => v_n))));
	end loop;
	-- An order made the same second as the first marked one.
	perform pg_temp.o_send(pg_temp.o_event('evt_LSame', 'checkout.session.completed',
		pg_temp.o_session('cs_LSame', 'pi_LSame', 1000, v_now - interval '10 days')));
	-- A test order, marked, before them all.
	perform pg_temp.o_send(pg_temp.o_event('evt_LTest', 'checkout.session.completed',
		pg_temp.o_session('cs_LTest', 'pi_LTest', 1000, v_now - interval '50 days', 'dkk', false)));
	update public.qorpera_orders set state = 'packed', state_at = clock_timestamp(), state_by = 'member', rolled = false
	where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_LTest');
	perform pg_temp.o_same(coalesce((pg_temp.o_now() -> 'to_pack')::text, 'sql null') || ' '
		|| (pg_temp.o_now('{"test": true}') -> 'to_pack')::text, 'null 0', 'live marked nothing yet; test from its own');
	-- The company starts marking with the order of 10 days ago.
	update public.qorpera_orders set state = 'packed', state_at = clock_timestamp(), state_by = 'agent', rolled = false
	where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_L10');
	-- Not 40 or 20 days ago (before it); the one of its second, 5 days ago and today.
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '3', 'to pack from the first marked order on');
	perform pg_temp.o_same((pg_temp.o_now('{"test": true}') -> 'to_pack')::text, '0', 'the test side its own');
end $$;

-- 11. Bounds and refusals, in the gateway's words.
do $$
begin
	perform pg_temp.o_same(pg_temp.o_refused('orders-now', '{"site": "x"}'), '22023 The question takes no :site', 'a param');
	perform pg_temp.o_same(pg_temp.o_refused('orders-months', '{"from": "2026-01-01"}'), '22023 The question takes no :from',
		'months takes no range');
	perform pg_temp.o_same(pg_temp.o_refused('orders-now', '{"test": 1}'), '22023 :test is true or false', 'test');
	perform pg_temp.o_same(pg_temp.o_refused('orders-now', '{"test": "yes"}'), '22023 :test is true or false', 'test word');
	perform pg_temp.o_same(pg_temp.o_refused('orders-now', '{"currency": "kroner"}'),
		'22023 :currency is a currency''s three letters, as DKK', 'currency');
	perform pg_temp.o_same(pg_temp.o_refused('orders-now', '{"currency": 208}'),
		'22023 :currency is a currency''s three letters, as DKK', 'a currency number');
	perform pg_temp.o_same(pg_temp.o_refused('orders-days', '{"from": "2026-11-10", "to": "2026-11-09"}'),
		'22023 :from is after :to', 'from after to');
	perform pg_temp.o_same(pg_temp.o_refused('orders-days', jsonb_build_object('from', to_char(current_date - 400, 'YYYY-MM-DD'),
		'to', to_char(current_date, 'YYYY-MM-DD'))), '22023 From :from to :to is at most 400 days', '401 days');
	perform pg_temp.o_same(jsonb_array_length(pg_temp.o_rows('orders-days', jsonb_build_object('from',
		to_char(current_date - 399, 'YYYY-MM-DD'))))::text, '400', '400 days');
	perform pg_temp.o_same(pg_temp.o_refused('orders-states', jsonb_build_object('from',
		to_char(pg_temp.o_today() - 400, 'YYYY-MM-DD'), 'to', to_char(pg_temp.o_today() - 300, 'YYYY-MM-DD'))),
		'22023 qorpera/orders-states reaches 400 days back: :from is from ' || (pg_temp.o_today() - 399)::text,
		'orders-states before its rows');
	perform pg_temp.o_same(pg_temp.o_refused('orders-states', jsonb_build_object('from',
		to_char(pg_temp.o_today() - 399, 'YYYY-MM-DD'))), 'ok', 'orders-states 400 days back');
	perform pg_temp.o_same(pg_temp.o_refused('orders-states', '{"from": "2026-02-30"}'),
		'22023 :from is a day as YYYY-MM-DD', 'a day that is not');
	perform pg_temp.o_same(pg_temp.o_refused('orders-hours', '{"from": "2026-11-01", "to": "2026-11-08"}'),
		'22023 From :from to :to is at most 7 days', 'eight days');
	perform pg_temp.o_same(jsonb_array_length(pg_temp.o_rows('orders-hours', '{"from": "2026-11-01", "to": "2026-11-07"}'))::text,
		'168', 'seven days, in hours');
	perform pg_temp.o_same(pg_temp.o_refused('orders-hours', '{"from": "2026-11-01T00:00Z", "to": "2026-11-08T00:00Z"}'),
		'22023 From :from to :to is at most 7 days', '169 hours');
	perform pg_temp.o_same(pg_temp.o_refused('orders-hours', '{"from": "yesterday"}'),
		'22023 :from is a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MMZ', 'an hour that is not');
	perform pg_temp.o_same(pg_temp.o_refused('orders-later'), 'P0002 No question qorpera/orders-later that you may read',
		'a question that is not there');
	perform pg_temp.o_same(pg_temp.o_refused('orders-now', '[]'), '22023 Parameters are named values', 'params');
end $$;

-- 12. Rights: any member (a viewer too) and a run of the company, the same answer; never an outsider or another
--     company's member; a run of another company is refused. The rule lives in qorpera_company_numbers_orders_readable:
--     with it saying no, a member's ask is "no question that you may read", and the site questions are untouched.
do $$
declare v_member jsonb; v_rule text := pg_get_functiondef('public.qorpera_company_numbers_orders_readable(uuid,uuid,jsonb)'::regprocedure);
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_send(pg_temp.o_event('evt_W1', 'checkout.session.completed',
		pg_temp.o_session('cs_W1', 'pi_W1', 10000, pg_temp.o_at())));
	v_member := pg_temp.o_ask('orders-days');
	perform pg_temp.o_json(pg_temp.o_run('orders-days') - 'asOf', v_member - 'asOf', 'a run''s answer is a member''s');
	perform pg_temp.o_json(pg_temp.o_member('92400000-0000-4000-8000-000000000003', 'orders-now') -> 'rows',
		pg_temp.o_rows('orders-now'), 'a viewer');
	perform pg_temp.o_json(pg_temp.o_member('92400000-0000-4000-8000-000000000002', 'orders-states') -> 'rows',
		pg_temp.o_rows('orders-states'), 'a contributor');
	execute replace(v_rule, 'select p_environment_id is not null', 'select false and p_environment_id is not null');
	perform pg_temp.o_same(pg_temp.o_refused('orders-now'), 'P0002 No question qorpera/orders-now that you may read',
		'the rule says no');
	perform pg_temp.o_same(left(pg_temp.o_state($s$select pg_temp.o_run('orders-days')$s$), 5), 'P0002', 'to a run too');
	perform pg_temp.o_same(pg_temp.o_refused('sites'), 'ok', 'the site questions are another rule');
	execute v_rule;
	perform pg_temp.o_same(pg_temp.o_refused('orders-now'), 'ok', 'the rule back');
end $$;

-- 13. The back-fill: verified deliveries of Stripe hooks whose body is kept (here made before the trigger could see
--     them); a refused one, one whose body was cleared and a GitHub hook's are left.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '2 days'; v_result jsonb; v_body bytea;
begin
	perform pg_temp.o_clean();
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_event_deliveries(hook_id, profile_id, status, delivery_key, event_type, body, body_bytes,
		body_sha256, verified_at, reason)
	select current_setting('qorpera_test.e3h_' || kept.hook)::uuid, '92400000-0000-4000-8000-000000000010', kept.status,
		kept.key, 'checkout.session.completed', kept.body, coalesce(octet_length(kept.body), 0), repeat('a', 64),
		case when kept.status = 'verified' then v_at end, case when kept.status = 'refused' then 'Bad signature' end
	from (values
		('stripe', 'verified', 'evt_Back1', convert_to(pg_temp.o_event('evt_Back1', 'checkout.session.completed',
			pg_temp.o_session('cs_Back1', 'pi_Back1', 5000, v_at))::text, 'UTF8')),
		('stripe', 'refused', 'evt_Back2', convert_to(pg_temp.o_event('evt_Back2', 'checkout.session.completed',
			pg_temp.o_session('cs_Back2', 'pi_Back2', 5000, v_at))::text, 'UTF8')),
		('stripe', 'verified', 'evt_Back3', null),
		('github', 'verified', 'evt_Back4', convert_to(pg_temp.o_event('evt_Back4', 'checkout.session.completed',
			pg_temp.o_session('cs_Back4', 'pi_Back4', 5000, v_at))::text, 'UTF8')))
		as kept(hook, status, key, body);
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.o_same(pg_temp.o_count()::text, '0', 'the trigger did not see them');
	v_result := public.qorpera_order_backfill();
	perform pg_temp.o_same(pg_temp.o_order('pi_Back1') || ' | ' || coalesce(pg_temp.o_order('pi_Back2'), 'none') || ' | '
		|| coalesce(pg_temp.o_order('pi_Back4'), 'none') || ' | ' || pg_temp.o_count(),
		pg_temp.o_min(v_at) || ' dkk 5000 0 - paid/stripe | none | none | 1', 'back-filled');
	perform pg_temp.o_same((v_result ->> 'schema') || ' ' || ((v_result ->> 'applied')::integer >= 1)::text,
		'qorpera.order-backfill/v1 true', 'its answer');
end $$;

-- 14. The upkeep: days once (a second run adds nothing); refunds count on the order's day; changed orders move their
--     day; rows 400 days after the order go (days stay), an orphan 400 days after it was made, never one not added;
--     a locked order is left for the next run.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '3 days'; v_up jsonb; v_range jsonb; v_days jsonb;
begin
	perform pg_temp.o_clean();
	v_range := jsonb_build_object('from', to_char((v_at at time zone 'Europe/Copenhagen')::date, 'YYYY-MM-DD'),
		'to', to_char((v_at at time zone 'Europe/Copenhagen')::date, 'YYYY-MM-DD'));
	perform pg_temp.o_send(pg_temp.o_event('evt_U1', 'checkout.session.completed', pg_temp.o_session('cs_U1', 'pi_U1', 1000, v_at)));
	perform pg_temp.o_send(pg_temp.o_event('evt_U2', 'checkout.session.completed', pg_temp.o_session('cs_U2', 'pi_U2', 2000, v_at)));
	perform pg_temp.o_send(pg_temp.o_event('evt_U3', 'charge.refunded', pg_temp.o_charge('pi_U2', 2000, 500)));
	perform pg_temp.o_send(pg_temp.o_event('evt_U4', 'charge.refunded', pg_temp.o_charge('pi_Orphan', 2000, 500)));
	-- A failed payment and one still unpaid, the same day: no orders.
	perform pg_temp.o_send(pg_temp.o_event('evt_UF1', 'checkout.session.completed',
		pg_temp.o_session('cs_UF', 'pi_UF', 4000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_send(pg_temp.o_event('evt_UF2', 'checkout.session.async_payment_failed',
		pg_temp.o_session('cs_UF', 'pi_UF', 4000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_send(pg_temp.o_event('evt_UP', 'checkout.session.completed',
		pg_temp.o_session('cs_UP', 'pi_UP', 8000, v_at, 'dkk', true, 'unpaid')));
	v_days := pg_temp.o_rows('orders-days', v_range);
	perform pg_temp.o_same(v_days::text, jsonb_build_array(jsonb_build_array(v_range ->> 'from', 2, 30.00, 5.00))::text,
		'from the orders');
	v_up := public.qorpera_order_upkeep();
	perform pg_temp.o_same((v_up ->> 'stopped') || ' ' || (v_up ->> 'rolled') || ' '
		|| (select count(*) from public.qorpera_orders where not rolled), 'done 5 0', 'all added');
	perform pg_temp.o_same((select string_agg(orders || ' ' || sales_minor || ' ' || refunds_minor, ',')
		from public.qorpera_order_days), '2 3000 500', 'one day row');
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_days, 'from the days, the same');
	perform pg_temp.o_same((public.qorpera_order_upkeep() ->> 'rolled'), '0', 'a second run adds nothing');
	perform pg_temp.o_same((select string_agg(orders || ' ' || sales_minor || ' ' || refunds_minor, ',')
		from public.qorpera_order_days), '2 3000 500', 'still one day row, unchanged');
	-- A change after: the day is whole before and after the next run.
	perform pg_temp.o_send(pg_temp.o_event('evt_U5', 'charge.refunded', pg_temp.o_charge('pi_U1', 1000, 1000)));
	v_days := jsonb_build_array(jsonb_build_array(v_range ->> 'from', 2, 30.00, 15.00));
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_days, 'a refund after, before the run');
	perform public.qorpera_order_upkeep();
	perform pg_temp.o_json(pg_temp.o_rows('orders-days', v_range), v_days, 'and after it');
	perform pg_temp.o_same((select string_agg(orders || ' ' || sales_minor || ' ' || refunds_minor, ',')
		from public.qorpera_order_days), '2 3000 1500', 'the day row moved by the difference');
	-- 399 days after the orders: nothing goes.
	perform pg_temp.o_same((public.qorpera_order_upkeep(v_at + interval '399 days') ->> 'deleted'), '0', '399 days on');
	-- 401 days after, while the days cannot be written (locked): only orders already added go; U1, changed, waits.
	update public.qorpera_orders set rolled = false
	where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_U1');
	create trigger o1274_busy before insert or update on public.qorpera_orders
		for each row execute function public.o1274_busy();
	v_up := public.qorpera_order_upkeep(v_at + interval '401 days');
	drop trigger o1274_busy on public.qorpera_orders;
	perform pg_temp.o_same((v_up ->> 'stopped') || ' ' || (v_up ->> 'rolled') || ' ' || (v_up ->> 'deleted') || ' '
		|| coalesce(pg_temp.o_order('pi_U1'), 'gone') || ' | ' || coalesce(pg_temp.o_order('pi_U2'), 'gone'),
		'lock_timeout 0 3 ' || pg_temp.o_min(v_at) || ' dkk 1000 1000 - paid/stripe | gone', 'never one not added');
	v_up := public.qorpera_order_upkeep(v_at + interval '401 days');
	perform pg_temp.o_same((v_up ->> 'stopped') || ' ' || (v_up ->> 'rolled') || ' ' || (v_up ->> 'deleted') || ' '
		|| pg_temp.o_count(), 'done 1 1 1', 'added, then deleted; the orphan stays');
	-- The orphan, a refund whose session never came: 400 days after it was made.
	perform pg_temp.o_same((public.qorpera_order_upkeep(clock_timestamp() + interval '401 days') ->> 'deleted') || ' '
		|| pg_temp.o_count() || ' ' || (select string_agg(orders || ' ' || sales_minor || ' ' || refunds_minor, ',')
		from public.qorpera_order_days), '1 0 2 3000 1500', 'the orphan goes; the days stay');
	perform pg_temp.o_same((select (ran_at is not null)::text || ' ' || stopped from public.qorpera_order_upkeep),
		'true done', 'its last run');
end $$;

-- 15. A removed hook is no Stripe hook; its orders stay, also once the purge deletes it (its id cleared).
do $$
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_send(pg_temp.o_event('evt_H1', 'checkout.session.completed',
		pg_temp.o_session('cs_H1', 'pi_H1', 1000, pg_temp.o_at())));
	perform public.qorpera_order_upkeep();
	update public.qorpera_event_hooks set status = 'removed', removed_at = clock_timestamp()
	where id = current_setting('qorpera_test.e3h_stripe')::uuid;
	perform pg_temp.o_same(pg_temp.o_now() ->> 'stripe' || ' ' || (pg_temp.o_now() -> 'orders_today')::text, 'none 1',
		'a removed hook is none; its orders count');
	delete from public.qorpera_event_hooks where id = current_setting('qorpera_test.e3h_stripe')::uuid;
	perform pg_temp.o_same((select count(*) || ' ' || count(hook_id) from public.qorpera_orders), '1 0',
		'the order stays without its hook');
	perform pg_temp.o_same(pg_temp.o_now() ->> 'stripe', 'none', 'no Stripe hook now');
	perform pg_temp.o_same((pg_temp.o_now() -> 'orders_today')::text, '1', 'its order still counts');
end $$;

-- 16. The schedule. pg_cron is not part of the test database: a stand-in with its schedule-by-name contract shows one
--     job every 10 minutes whose command runs the upkeep.
savepoint o_cron;
do $$
declare v_first jsonb; v_second jsonb; v_command text;
begin
	if to_regnamespace('cron') is null then
		perform pg_temp.o_json(public.qorpera_schedule_order_upkeep(),
			'{"schema":"qorpera.order-upkeep-schedule/v1","scheduled":false}', 'a schedule without pg_cron');
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user,
			unique (jobname, username));
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v_first := public.qorpera_schedule_order_upkeep();
	v_second := public.qorpera_schedule_order_upkeep();
	perform pg_temp.o_same((v_first ->> 'scheduled') || ' ' || (v_second -> 'job' = v_first -> 'job')::text, 'true true',
		'scheduled, once');
	perform pg_temp.o_same((select count(*) || ' ' || min(schedule) || ' ' || min(command) from cron.job
		where jobname = 'qorpera-orders'), '1 */10 * * * * select public.qorpera_order_upkeep()', 'the job');
	select command into v_command from cron.job where jobname = 'qorpera-orders';
	execute v_command;
end $$;
rollback to savepoint o_cron;

rollback;
