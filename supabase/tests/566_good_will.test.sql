-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930566000 (good will), on the folder-v2 runtime base: the company pays a falling-step share of each month's
-- sales without moms (Jonas's examples), counted from its bank's payments in. The months turn on given days: a month is
-- open, sorting from the 1st and final on the 5th; a payment nobody sorted counts as a sale; a payment a final month
-- missed counts in the next one; under 100 kr rolls over and no sales is zero. Alice (a company agent) lists and sorts
-- a month's payments through the host's calls; members who may write sort one too, viewers never; a final month never
-- changes. A founder's card (Stripe test mode, testers only before the live switch) pays a closed month through the
-- billing door. Members read the Company tab's good will, and each member their companies' good will.

select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'gw-ack') \g /dev/null
-- The company was made in October 2026: its good will starts with the steps, in November.
update public.qorpera_profiles set created_at = '2026-10-20 12:00+02' where id = '92400000-0000-4000-8000-000000000010';

create function pg_temp.gw_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; v_claims text := current_setting('request.jwt.claims', true);
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute p_sql into v;
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v;
end
$$;
-- A bank payment the vault kept (accounts 'a' and 'b'; the key a hash of the text).
create function pg_temp.gw_bank(p_account text, p_on date, p_amount numeric, p_who text, p_currency text default 'DKK')
returns void language sql as $$
	insert into public.qorpera_bank_transactions (profile_id, account_key, transaction_key, booked_on, amount, currency, counterparty)
	values ('92400000-0000-4000-8000-000000000010', repeat(p_account, 64),
		encode(extensions.digest(p_account || p_on || p_amount || p_who, 'sha256'), 'hex'), p_on, p_amount, p_currency, p_who)
$$;
create function pg_temp.gw_item(p_who text) returns uuid language sql as $$
	select id from public.qorpera_good_will_items where profile_id = '92400000-0000-4000-8000-000000000010' and counterparty = p_who
$$;
create function pg_temp.gw_month(p_month date, p_profile uuid default '92400000-0000-4000-8000-000000000010')
returns public.qorpera_good_will_months language sql as $$
	select * from public.qorpera_good_will_months where profile_id = p_profile and month = p_month
$$;
create function pg_temp.gw_list(p_month text) returns jsonb language sql as $$
	select public.qorpera_good_will_agent_list(current_setting('qorpera_test.base_binding')::jsonb, p_month)
$$;
create function pg_temp.gw_mark(p_marks jsonb) returns jsonb language sql as $$
	select public.qorpera_good_will_agent_mark(current_setting('qorpera_test.base_binding')::jsonb, jsonb_build_object('marks', p_marks))
$$;
create function pg_temp.gw_bill(p_method text, p_args jsonb) returns jsonb language sql as $$
	select public.qorpera_good_will_billing('gw-test-billing-key', p_method, p_args)
$$;

-- 1. The tables are no one's; members read through their two calls and sort through one; the agent's two calls and the
--    billing door are the service role's (the host's calls, the Edge Function); the rest is no one's.
do $$
declare v_role text; v_name text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		foreach v_name in array array['qorpera_good_will_step_versions', 'qorpera_good_will_steps', 'qorpera_good_will_items',
			'qorpera_good_will_months', 'qorpera_good_will_payers', 'qorpera_good_will_card_setups'] loop
			perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.' || v_name, 'SELECT, INSERT, UPDATE, DELETE'),
				format('%s is open to %s', v_name, v_role));
			perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = ('public.' || v_name)::regclass),
				v_name || ' has row security');
		end loop;
		foreach v_name in array array['public.qorpera_company_good_will(uuid)', 'public.qorpera_my_good_will()',
			'public.qorpera_mark_good_will_item(uuid,uuid,text,bigint,text)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_name, 'EXECUTE') = (v_role = 'authenticated'),
				format('%s for %s', v_name, v_role));
		end loop;
		foreach v_name in array array['public.qorpera_good_will_agent_list(jsonb,text)',
			'public.qorpera_good_will_agent_mark(jsonb,jsonb)', 'public.qorpera_good_will_billing(text,text,jsonb)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_name, 'EXECUTE') = (v_role = 'service_role'),
				format('%s for %s', v_name, v_role));
		end loop;
		foreach v_name in array array['public.qorpera_good_will_fee(bigint,date)', 'public.qorpera_good_will_today()',
			'public.qorpera_good_will_first_month(uuid)', 'public.qorpera_good_will_month_row(uuid,date,date)',
			'public.qorpera_good_will_recompute(uuid,date,date)', 'public.qorpera_good_will_gather(uuid,date)',
			'public.qorpera_good_will_finalize(uuid,date,date)',
			'public.qorpera_good_will_decide(uuid,uuid,text,bigint,text,text,uuid,uuid)',
			'public.qorpera_good_will_agent_run(jsonb)', 'public.qorpera_good_will_tick(date)',
			'public.qorpera_schedule_good_will()'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_name, 'EXECUTE'), format('%s is open to %s', v_name, v_role));
		end loop;
	end loop;
	perform pg_temp.base_assert((select count(*) from public.qorpera_native_host_calls
		where name in ('qorpera_good_will_agent_list', 'qorpera_good_will_agent_mark') and scope = 'binding') = 2,
		'the agent''s calls are host calls');
end
$$;

-- 2. The steps, marginal like tax brackets (Jonas, 5 Nov): 2,000,000 kr in a month = 29,500 kr; 50,000 → 5,000;
--    200,000 → 15,000; 400,000 → 20,500; 800,000 → 25,500. At a step's edge, and nothing sold.
do $$
declare v_case record;
begin
	for v_case in select * from (values (200000000::bigint, 2950000::bigint), (5000000, 500000), (20000000, 1500000),
		(40000000, 2050000), (80000000, 2550000), (10000000, 1000000), (0, 0), (1, 0), (5, 1)) as c(net, fee)
	loop
		perform pg_temp.base_assert((public.qorpera_good_will_fee(v_case.net, '2026-11-01') ->> 'feeOre')::bigint = v_case.fee,
			format('%s øre pays %s: %s', v_case.net, v_case.fee, public.qorpera_good_will_fee(v_case.net, '2026-11-01')));
	end loop;
	perform pg_temp.base_assert(public.qorpera_good_will_fee(200000000, '2026-11-01') -> 'steps' = jsonb_build_array(
		jsonb_build_object('fromOre', 0, 'toOre', 10000000, 'rateBp', 1000, 'baseOre', 10000000, 'feeOre', 1000000),
		jsonb_build_object('fromOre', 10000000, 'toOre', 25000000, 'rateBp', 500, 'baseOre', 15000000, 'feeOre', 750000),
		jsonb_build_object('fromOre', 25000000, 'toOre', 50000000, 'rateBp', 200, 'baseOre', 25000000, 'feeOre', 500000),
		jsonb_build_object('fromOre', 50000000, 'toOre', 100000000, 'rateBp', 100, 'baseOre', 50000000, 'feeOre', 500000),
		jsonb_build_object('fromOre', 100000000, 'toOre', null, 'rateBp', 20, 'baseOre', 100000000, 'feeOre', 200000)),
		'2 million kr per step: ' || (public.qorpera_good_will_fee(200000000, '2026-11-01') -> 'steps')::text);
	perform pg_temp.base_assert((public.qorpera_good_will_fee(0, '2026-11-01') ->> 'minChargeOre')::bigint = 10000,
		'under 100 kr rolls over');
end
$$;

-- 3. November's payments in, gathered on the 28th: October's is before good will began; a move from the company's other
--    account the same day is its own money, by rule; the rest wait to be sorted. Outgoing money is never a payment in.
select pg_temp.gw_bank('a', '2026-10-30', 5000.00, 'Before');
select pg_temp.gw_bank('a', '2026-11-03', 50000.00, 'Customer ApS');
select pg_temp.gw_bank('a', '2026-11-10', 20000.00, 'Owner loan');
select pg_temp.gw_bank('a', '2026-11-12', 3000.00, 'Own move');
select pg_temp.gw_bank('b', '2026-11-12', -3000.00, 'Own move out');
select pg_temp.gw_bank('a', '2026-11-20', 100.00, 'Euro customer', 'EUR');
select pg_temp.gw_bank('a', '2026-11-25', 1250.00, 'Small customer');
do $$
declare v_month public.qorpera_good_will_months;
begin
	perform pg_temp.base_assert(public.qorpera_good_will_gather('92400000-0000-4000-8000-000000000010', '2026-11-28') = 5,
		'five payments in');
	perform pg_temp.base_assert(pg_temp.gw_item('Before') is null and pg_temp.gw_item('Own move out') is null,
		'October and money out are not payments in');
	perform pg_temp.base_assert((select counted is false and reason = 'own_transfer' and decided_by = 'rule'
		from public.qorpera_good_will_items where id = pg_temp.gw_item('Own move')), 'the move between accounts is not counted');
	v_month := pg_temp.gw_month('2026-11-01');
	perform pg_temp.base_assert(v_month.status = 'open' and v_month.unsorted = 4 and v_month.due_ore = 0,
		'November runs, four to sort: ' || row_to_json(v_month)::text);
	perform pg_temp.base_assert(pg_temp.gw_month('2026-10-01') is null, 'no October');
	-- Gathering again keeps each payment once.
	perform pg_temp.base_assert(public.qorpera_good_will_gather('92400000-0000-4000-8000-000000000010', '2026-11-28') = 0,
		'kept once');
end
$$;

-- 4. Alice lists November and sorts it: the customer's payment is a sale (a Danish sale's moms, a fifth), the owner's
--    money is not. Only kroner count; reasons and marks are checked; the call is the company agent's only.
do $$
declare v_list jsonb; v_marks jsonb;
begin
	v_list := pg_temp.gw_list('2026-11');
	perform pg_temp.base_assert(v_list ->> 'schema' = 'qorpera.good-will-month/v1' and (v_list ->> 'itemCount')::integer = 5
		and jsonb_array_length(v_list -> 'items') = 5 and v_list -> 'month' ->> 'month' = '2026-11'
		and v_list ->> 'runId' = current_setting('qorpera_test.base_binding')::jsonb ->> 'runId', 'Alice lists November: ' || v_list::text);
	v_marks := pg_temp.gw_mark(jsonb_build_array(
		jsonb_build_object('itemId', pg_temp.gw_item('Customer ApS'), 'reason', 'sale'),
		jsonb_build_object('itemId', pg_temp.gw_item('Owner loan'), 'reason', 'member_money', 'note', 'The owner''s loan.')));
	perform pg_temp.base_assert(v_marks -> 'months' -> 0 ->> 'netOre' = '4000000' and v_marks -> 'months' -> 0 ->> 'feeOre' = '400000'
		and jsonb_array_length(v_marks -> 'items') = 2, '40,000 kr without moms pays 4,000 kr: ' || v_marks::text);
	perform pg_temp.base_assert((select decided_by = 'agent' and decided_by_staff_id = '92400000-0000-4000-8000-000000000030'
		and moms_ore = 1000000 from public.qorpera_good_will_items where id = pg_temp.gw_item('Customer ApS')), 'Alice decided');
	perform pg_temp.base_error(format('select pg_temp.gw_mark(%L)', jsonb_build_array(jsonb_build_object('itemId',
		pg_temp.gw_item('Euro customer'), 'reason', 'sale'))), '22023', 'Good will: only payments in kroner count for now');
	perform pg_temp.base_error(format('select pg_temp.gw_mark(%L)', jsonb_build_array(jsonb_build_object('itemId',
		pg_temp.gw_item('Customer ApS'), 'reason', 'gift'))), '22023');
	perform pg_temp.base_error(format('select pg_temp.gw_mark(%L)', jsonb_build_array(jsonb_build_object('itemId',
		pg_temp.gw_item('Customer ApS'), 'reason', 'sale', 'momsOre', 6000000))), '22023');
	perform pg_temp.base_error('select pg_temp.gw_mark(''[]'')', '22023');
	perform pg_temp.base_error(format('select pg_temp.gw_mark(%L)', jsonb_build_array(jsonb_build_object('itemId',
		'not-a-uuid', 'reason', 'sale'))), '22023');
	perform pg_temp.base_error(format('select pg_temp.gw_mark(%L)', jsonb_build_array(jsonb_build_object('itemId',
		extensions.gen_random_uuid(), 'reason', 'sale'))), '22023', 'Good will: no such payment in this company');
	-- All or none: a bad mark after a good one changes nothing.
	perform pg_temp.base_error(format('select pg_temp.gw_mark(%L)', jsonb_build_array(
		jsonb_build_object('itemId', pg_temp.gw_item('Small customer'), 'reason', 'sale'),
		jsonb_build_object('itemId', pg_temp.gw_item('Euro customer'), 'reason', 'sale'))), '22023');
	perform pg_temp.base_assert((select counted is null from public.qorpera_good_will_items where id = pg_temp.gw_item('Small customer')),
		'nothing of a refused list is kept');
	perform pg_temp.base_error('select pg_temp.gw_list(''2026-13'')', '22023');
	perform pg_temp.base_error('select pg_temp.gw_list(''2026-09'')', '22023');
end
$$;

-- 5. Members: one who may write sorts a payment (an export: no moms); a viewer and an outsider never.
do $$
declare v jsonb;
begin
	v := pg_temp.gw_call('92400000-0000-4000-8000-000000000002', format(
		'select public.qorpera_mark_good_will_item(%L, %L, ''sale'', 0, ''Sold abroad'')',
		'92400000-0000-4000-8000-000000000010', pg_temp.gw_item('Customer ApS')));
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.good-will-mark/v1' and v -> 'month' ->> 'feeOre' = '500000'
		and v -> 'item' ->> 'decidedBy' = 'member', 'the contributor''s sort: ' || v::text);
	perform pg_temp.base_assert((select decided_by_user_id = '92400000-0000-4000-8000-000000000002' and decided_by_staff_id is null
		from public.qorpera_good_will_items where id = pg_temp.gw_item('Customer ApS')), 'the member decided');
	foreach v in array array['"92400000-0000-4000-8000-000000000003"', '"92400000-0000-4000-8000-000000000005"']::jsonb[] loop
		perform pg_temp.base_error(format('select pg_temp.gw_call(%L, %L)', v #>> '{}', format(
			'select public.qorpera_mark_good_will_item(%L, %L, ''refund'', null, null)',
			'92400000-0000-4000-8000-000000000010', pg_temp.gw_item('Customer ApS'))), '42501');
	end loop;
end
$$;

-- 6. On 2 December November is sorting; on the 5th it is final: the payment nobody sorted counts as a sale with its moms,
--    the euros do not, and the month is closed to charge. A final month's payments never change.
do $$
declare v_month public.qorpera_good_will_months; v_tick jsonb;
begin
	v_tick := public.qorpera_good_will_tick('2026-12-02');
	perform pg_temp.base_assert((v_tick ->> 'failed')::integer = 0, 'the tick: ' || v_tick::text);
	perform pg_temp.base_assert((pg_temp.gw_month('2026-11-01')).status = 'sorting', 'November is sorting');
	perform pg_temp.base_assert((pg_temp.gw_month('2026-12-01')).status = 'open', 'December runs');
	v_tick := public.qorpera_good_will_tick('2026-12-05');
	v_month := pg_temp.gw_month('2026-11-01');
	perform pg_temp.base_assert(v_month.status = 'closed' and v_month.sales_ore = 5125000 and v_month.moms_ore = 25000
		and v_month.net_ore = 5100000 and v_month.fee_ore = 510000 and v_month.due_ore = 510000 and v_month.unsorted = 0
		and v_month.final_at is not null, 'November is closed at 5,100 kr: ' || row_to_json(v_month)::text);
	perform pg_temp.base_assert((select counted and reason = 'sale' and decided_by = 'rule' and moms_ore = 25000
		from public.qorpera_good_will_items where id = pg_temp.gw_item('Small customer')), 'unsorted counts as a sale');
	perform pg_temp.base_assert((select counted is false and reason = 'other' from public.qorpera_good_will_items
		where id = pg_temp.gw_item('Euro customer')), 'the euros do not count');
	perform pg_temp.base_error(format('select pg_temp.gw_mark(%L)', jsonb_build_array(jsonb_build_object('itemId',
		pg_temp.gw_item('Owner loan'), 'reason', 'sale'))), '55000', 'Good will: 2026-11 is final; its payments can no longer change');
	-- Ticking again changes nothing final.
	perform public.qorpera_good_will_tick('2026-12-06');
	perform pg_temp.base_assert((pg_temp.gw_month('2026-11-01')).due_ore = 510000, 'final stays final');
end
$$;

-- 7. A November payment the bank books after November is final counts in December. December's 400 kr without moms pays
--    40 kr, under 100 kr: it rolls over to January, which sells nothing and rolls it on. A company that never sells has
--    nothing to pay.
insert into public.qorpera_profiles(id, name, created_by_user_id, created_at)
values ('56600000-0000-4000-8000-000000000010', 'Quiet company', '92400000-0000-4000-8000-000000000001', '2026-11-02');
select pg_temp.gw_bank('a', '2026-11-29', 500.00, 'Late customer');
do $$
declare v_month public.qorpera_good_will_months;
begin
	perform public.qorpera_good_will_gather('56600000-0000-4000-8000-000000000010', '2026-12-10');
	perform public.qorpera_good_will_tick('2026-12-10');
	perform pg_temp.base_assert((select month = '2026-12-01' from public.qorpera_good_will_items where id = pg_temp.gw_item('Late customer')),
		'the late payment counts in December');
	perform public.qorpera_good_will_tick('2027-01-05');
	v_month := pg_temp.gw_month('2026-12-01');
	perform pg_temp.base_assert(v_month.status = 'carried' and v_month.fee_ore = 4000 and v_month.carried_out_ore = 4000,
		'December rolls over 40 kr: ' || row_to_json(v_month)::text);
	perform pg_temp.base_assert((pg_temp.gw_month('2026-12-01', '56600000-0000-4000-8000-000000000010')).status = 'zero',
		'nothing sold, nothing to pay');
	perform public.qorpera_good_will_tick('2027-02-05');
	v_month := pg_temp.gw_month('2027-01-01');
	perform pg_temp.base_assert(v_month.status = 'carried' and v_month.fee_ore = 0 and v_month.carried_in_ore = 4000
		and v_month.due_ore = 4000 and v_month.carried_out_ore = 4000, 'January rolls it on: ' || row_to_json(v_month)::text);
end
$$;

-- 8. The card and the charge. Before the live switch only an enrolled tester opens Stripe's test page, and only for a
--    company they found; their card pays the company's closed month; a live key invoices nothing.
insert into public.qorpera_computer_hour_billing_keys (key_sha256)
values (encode(extensions.digest('gw-test-billing-key', 'sha256'), 'hex'));
do $$
declare v jsonb; v_setup uuid;
begin
	perform pg_temp.base_error('select public.qorpera_good_will_billing(''wrong'', ''due'', ''{}'')', '42501', 'Billing key refused');
	v := pg_temp.gw_bill('card_begin', jsonb_build_object('userId', '92400000-0000-4000-8000-000000000001',
		'profileId', '92400000-0000-4000-8000-000000000010', 'livemode', false));
	perform pg_temp.base_assert(v ->> 'refused' = 'not_open', 'not a tester: ' || v::text);
	insert into public.qorpera_computer_hour_testers (user_id) values ('92400000-0000-4000-8000-000000000001'),
		('92400000-0000-4000-8000-000000000004');
	v := pg_temp.gw_bill('card_begin', jsonb_build_object('userId', '92400000-0000-4000-8000-000000000004',
		'profileId', '92400000-0000-4000-8000-000000000010', 'livemode', false));
	perform pg_temp.base_assert(v ->> 'refused' = 'not_a_founder', 'an admin is no founder: ' || v::text);
	v := pg_temp.gw_bill('card_begin', jsonb_build_object('userId', '92400000-0000-4000-8000-000000000001',
		'profileId', '92400000-0000-4000-8000-000000000010', 'livemode', false));
	v_setup := (v ->> 'setupId')::uuid;
	perform pg_temp.base_assert(v_setup is not null and v ->> 'companyName' = 'Folder runtime base', 'the founder''s page: ' || v::text);
	perform pg_temp.base_assert((pg_temp.gw_bill('card_attach', jsonb_build_object('setupId', v_setup,
		'sessionId', 'cs_test_gw1')) ->> 'attached')::boolean, 'the page is Stripe''s session');
	perform pg_temp.base_assert(pg_temp.gw_bill('card_saved', jsonb_build_object('sessionId', 'cs_test_gw1', 'livemode', true,
		'customerId', 'cus_gw1', 'paymentMethodId', 'pm_gw1')) ->> 'outcome' = 'ignored', 'a live event never saves a test page');
	v := pg_temp.gw_bill('card_saved', jsonb_build_object('sessionId', 'cs_test_gw1', 'livemode', false,
		'customerId', 'cus_gw1', 'paymentMethodId', 'pm_gw1', 'brand', 'visa', 'last4', '4242'));
	perform pg_temp.base_assert(v ->> 'outcome' = 'applied', 'the card is saved: ' || v::text);
	perform pg_temp.base_assert(pg_temp.gw_bill('card_saved', jsonb_build_object('sessionId', 'cs_test_gw1', 'livemode', false,
		'customerId', 'cus_gw1', 'paymentMethodId', 'pm_gw1')) ->> 'detail' = 'already saved', 'saved once');
	v := pg_temp.gw_bill('due', '{"livemode": true}');
	perform pg_temp.base_assert(v ->> 'held' = 'dry_run' and v -> 'months' = '[]', 'live invoices nothing before the switch');
	v := pg_temp.gw_bill('due', '{"livemode": false}');
	perform pg_temp.base_assert(jsonb_array_length(v -> 'months') = 1 and v -> 'months' -> 0 ->> 'month' = '2026-11'
		and v -> 'months' -> 0 ->> 'dueOre' = '510000' and v -> 'months' -> 0 ->> 'customerId' = 'cus_gw1'
		and v -> 'months' -> 0 ->> 'paymentMethodId' = 'pm_gw1', 'November is due on the tester''s card: ' || v::text);
	perform pg_temp.base_assert((pg_temp.gw_bill('invoiced', jsonb_build_object('profileId', '92400000-0000-4000-8000-000000000010',
		'month', '2026-11', 'invoiceId', 'in_gw1', 'invoiceUrl', 'https://invoice.stripe.com/i/gw1', 'livemode', false,
		'userId', '92400000-0000-4000-8000-000000000001')) ->> 'recorded')::boolean, 'invoiced');
	perform pg_temp.base_assert(pg_temp.gw_bill('due', '{"livemode": false}') -> 'months' = '[]', 'invoiced once');
	perform pg_temp.base_assert(pg_temp.gw_bill('invoice_failed', '{"invoiceId": "in_gw1", "livemode": false}') ->> 'status' = 'failed',
		'the card failed');
	perform pg_temp.base_assert(pg_temp.gw_bill('invoice_paid', '{"invoiceId": "in_gw1", "livemode": false}') ->> 'status' = 'charged',
		'Stripe''s retry paid it');
	perform pg_temp.base_assert(pg_temp.gw_bill('invoice_paid', '{"invoiceId": "in_gw1", "livemode": false}') ->> 'outcome' = 'ignored',
		'paid once');
	perform pg_temp.base_assert((pg_temp.gw_month('2026-11-01')).charged_at is not null, 'charged');
	perform pg_temp.base_error('select pg_temp.gw_bill(''refund'', ''{}'')', '22023');
end
$$;

-- 9. Members read the Company tab's good will: the card (the founder's own), who may add one, the months of the last year
--    and the steps. Each member reads their companies' good will this year. Outsiders and calls with no user read nothing.
do $$
declare v jsonb; v_recent boolean := current_date < '2027-11-01';
begin
	v := pg_temp.gw_call('92400000-0000-4000-8000-000000000001',
		'select public.qorpera_company_good_will(''92400000-0000-4000-8000-000000000010'')');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.company-good-will/v1' and v ->> 'companyName' = 'Folder runtime base'
		and (v ->> 'canAddCard')::boolean and (v -> 'card' ->> 'mine')::boolean and v -> 'card' ->> 'last4' = '4242'
		and jsonb_typeof(v -> 'card' -> 'payerName') = 'string' and jsonb_array_length(v -> 'steps') = 5 and v ->> 'minChargeOre' = '10000',
		'the owner reads: ' || v::text);
	perform pg_temp.base_assert(not v_recent or exists (select 1 from jsonb_array_elements(v -> 'months') as m(value)
		where m.value ->> 'month' = '2026-11' and m.value ->> 'status' = 'charged' and m.value ->> 'dueOre' = '510000'
		and m.value ->> 'invoiceUrl' = 'https://invoice.stripe.com/i/gw1'), 'November is charged: ' || (v -> 'months')::text);
	v := pg_temp.gw_call('92400000-0000-4000-8000-000000000003',
		'select public.qorpera_company_good_will(''92400000-0000-4000-8000-000000000010'')');
	perform pg_temp.base_assert(not (v ->> 'canAddCard')::boolean and not (v -> 'card' ->> 'mine')::boolean, 'the viewer reads');
	perform pg_temp.base_error(format('select pg_temp.gw_call(%L, %L)', '92400000-0000-4000-8000-000000000005',
		'select public.qorpera_company_good_will(''92400000-0000-4000-8000-000000000010'')'), '42501');
	perform pg_temp.base_error('select public.qorpera_company_good_will(''92400000-0000-4000-8000-000000000010'')', '42501');
	v := pg_temp.gw_call('92400000-0000-4000-8000-000000000001', 'select public.qorpera_my_good_will()');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.my-good-will/v1' and exists (select 1
		from jsonb_array_elements(v -> 'companies') as c(value) where c.value ->> 'profileId' = '92400000-0000-4000-8000-000000000010'
			and c.value ->> 'payer' = 'me' and c.value ->> 'last4' = '4242' and c.value ->> 'rateBp' = '1000'), 'the owner''s companies: ' || v::text);
	perform pg_temp.base_assert((v ->> 'paidByMeOre')::bigint = case when extract(year from current_date) = 2026 then 510000 else 0 end,
		'paid on the owner''s card this year: ' || v::text);
	v := pg_temp.gw_call('92400000-0000-4000-8000-000000000002', 'select public.qorpera_my_good_will()');
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v -> 'companies') as c(value)
		where c.value ->> 'payer' = 'other' and c.value ->> 'last4' is null) and (v ->> 'paidByMeOre')::bigint = 0,
		'a contributor never pays: ' || v::text);
end
$$;

rollback;
