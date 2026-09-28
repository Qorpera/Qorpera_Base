-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 4a (20260928248910_runtime_computer_hours_payments): paid Stripe facts
-- become sources of hours through one dispatcher that only an enrolled billing key opens. Test-mode
-- payments make dry-run sources, and before the live switch only enrolled testers may start a checkout.
-- Founders buy credits; a member with a plan changes it on Stripe's billing page. A refund or
-- dispute reaches the purchase behind the payment, credits or plan hours. The Edge Function that
-- talks to Stripe is covered by its own unit tests.

insert into public.qorpera_computer_hour_billing_keys (key_sha256)
values (encode(extensions.digest('test-billing-key-0123456789', 'sha256'), 'hex'));
insert into public.qorpera_computer_hour_billing_keys (key_sha256, revoked_at)
values (encode(extensions.digest('revoked-billing-key-0123456789', 'sha256'), 'hex'), clock_timestamp());
update public.qorpera_computer_hour_catalog set stripe_price_test = 'price_' || replace(item_key, '_', '');
-- An operator enrolled the founder to try payments in test mode.
insert into public.qorpera_computer_hour_testers (user_id, note) values ('30000000-0000-4000-8000-000000000001', 'test founder');
create function pg_temp.bill(p_method text, p_args jsonb) returns jsonb language sql as $$
	select public.qorpera_computer_billing('test-billing-key-0123456789', p_method, p_args)
$$;
create function pg_temp.source(p_reference text) returns public.qorpera_computer_hour_sources language sql as $$
	select * from public.qorpera_computer_hour_sources where reference = p_reference
$$;

-- Only an enrolled, unrevoked key opens the door; the door is the service role's alone.
select pg_temp.wake_error($$select public.qorpera_computer_billing('wrong-key', 'catalog_price', '{"itemKey":"basis"}')$$, '42501');
select pg_temp.wake_error($$select public.qorpera_computer_billing('revoked-billing-key-0123456789', 'catalog_price',
	'{"itemKey":"basis"}')$$, '42501');
select pg_temp.wake_error($$select public.qorpera_computer_billing('wrong-key', 'catalog_price', '{"livemode":"maybe"}')$$, '42501');
select pg_temp.wake_assert(not has_function_privilege(role_name, 'public.qorpera_computer_billing(text,text,jsonb)', 'EXECUTE'),
	'The billing door is closed to ' || role_name) from unnest(array['anon', 'authenticated']) role_name;
select pg_temp.wake_assert(not exists (
	select 1 from pg_proc function join pg_namespace namespace on namespace.oid = function.pronamespace
	cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
	where namespace.nspname = 'public' and function.proname like 'qorpera_computer_billing_%'
		and has_function_privilege(role_name, function.oid, 'EXECUTE')
), 'The billing helpers are callable by no API role');
select pg_temp.wake_assert(not has_table_privilege(role_name, 'public.qorpera_computer_hour_invoice_sources', 'INSERT'),
	'Invoice links are written only through the door, not by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name;
select pg_temp.wake_assert(not has_table_privilege(role_name, 'public.qorpera_computer_hour_testers', privilege),
	'Testers are enrolled by an operator only, not by ' || role_name || ' (' || privilege || ')')
from unnest(array['anon', 'authenticated', 'service_role']) role_name, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege;
select pg_temp.wake_assert(pg_temp.bill('catalog_price', '{"itemKey":"standard"}') = '{"itemKey":"standard","kind":"plan",
	"priceMinor":63000,"currency":"dkk","hours":286,"active":true,"priceId":"price_standard"}'::jsonb, 'The catalog price');
select pg_temp.wake_assert(pg_temp.bill('catalog_price', '{"itemKey":"basis","livemode":true}') ->> 'priceId' is null,
	'No live price until an operator sets one');
select pg_temp.wake_assert(pg_temp.bill('catalog_item_by_price', '{"priceId":"price_standard"}') ->> 'itemKey' = 'standard'
	and pg_temp.bill('catalog_item_by_price', '{"priceId":"price_standard","livemode":true}') ->> 'itemKey' is null,
	'A Stripe price maps back to its item in its own mode');
select pg_temp.wake_error($$update public.qorpera_computer_hour_catalog set stripe_price_test = 'price_basis' where item_key = 'standard'$$,
	'23505');

-- Checkout. Before the live switch, test mode is for enrolled testers only and live mode is closed.
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000002","itemKey":"basis"}')
	= '{"refused":"item_unavailable"}', 'A member who is not a tester meets no test checkout');
update public.qorpera_computer_hour_catalog set stripe_price_live = 'price_live' || replace(item_key, '_', '');
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001","itemKey":"hours_20",
	"profileId":"30000000-0000-4000-8000-000000000010","livemode":true}') = '{"refused":"item_unavailable"}',
	'No live checkout before the live switch: it would take money for dry-run hours');
-- Founders buy credits for their company; a contributor may not, even a tester.
insert into public.qorpera_computer_hour_testers (user_id) values ('30000000-0000-4000-8000-000000000002');
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000002","itemKey":"hours_20",
	"profileId":"30000000-0000-4000-8000-000000000010"}') = '{"refused":"not_a_founder"}', 'A contributor cannot buy credits');
delete from public.qorpera_computer_hour_testers where user_id = '30000000-0000-4000-8000-000000000002';
select set_config('qorpera_test.cr', pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"hours_20","profileId":"30000000-0000-4000-8000-000000000010"}')::text, true);
select pg_temp.wake_assert((current_setting('qorpera_test.cr')::jsonb ->> 'priceId') = 'price_hours20'
	and current_setting('qorpera_test.cr')::jsonb ->> 'kind' = 'credits'
	and current_setting('qorpera_test.cr')::jsonb -> 'customerId' = 'null'::jsonb, 'A founder starts a credit checkout');
select pg_temp.wake_assert(pg_temp.bill('customer_set', '{"userId":"30000000-0000-4000-8000-000000000001","customerId":"cus_A1"}')
	->> 'customerId' = 'cus_A1' and pg_temp.bill('customer_set', '{"userId":"30000000-0000-4000-8000-000000000001","customerId":"cus_B2"}')
	->> 'customerId' = 'cus_A1' and pg_temp.bill('customer_user', '{"customerId":"cus_A1"}') ->> 'userId' = '30000000-0000-4000-8000-000000000001'
	and pg_temp.bill('customer_get', '{"userId":"30000000-0000-4000-8000-000000000001"}') ->> 'customerId' = 'cus_A1'
	and pg_temp.bill('customer_get', '{"userId":"30000000-0000-4000-8000-000000000001","livemode":true}') ->> 'customerId' is null,
	'One Stripe customer per member and mode, and back from it to the member');
select pg_temp.wake_assert((pg_temp.bill('checkout_attach', jsonb_build_object('checkoutId', current_setting('qorpera_test.cr')::jsonb ->> 'checkoutId',
	'sessionId', 'cs_test_credits1')) ->> 'attached')::boolean
	and not (pg_temp.bill('checkout_attach', jsonb_build_object('checkoutId', current_setting('qorpera_test.cr')::jsonb ->> 'checkoutId',
	'sessionId', 'cs_test_other')) ->> 'attached')::boolean, 'A checkout is attached to one Stripe session');
select pg_temp.bill('checkout_attach', jsonb_build_object('checkoutId', pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"hours_100","profileId":"30000000-0000-4000-8000-000000000010"}') ->> 'checkoutId', 'sessionId', 'cs_test_credits2'));
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001","itemKey":"dedicated"}')
	= '{"refused":"item_unavailable"}', 'The Dedicated plan is not sold');

-- Events are recorded once and a replay is a no-op. The first body's hash is kept: each delivery is
-- authenticated by its signature. An event left for review runs again when it is resent.
select pg_temp.wake_assert(pg_temp.bill('event_begin', jsonb_build_object('eventId', 'evt_1', 'type', 'checkout.session.completed',
	'bodySha256', repeat('a', 64))) ->> 'state' = 'open', 'A new event opens');
select pg_temp.bill('event_finish', '{"eventId":"evt_1","outcome":"applied"}');
select pg_temp.wake_assert(pg_temp.bill('event_begin', jsonb_build_object('eventId', 'evt_1', 'type', 'checkout.session.completed',
	'bodySha256', repeat('b', 64))) = '{"state":"finished","outcome":"applied"}', 'A replay finds it finished, whatever its body');
select pg_temp.wake_assert(body_sha256 = repeat('a', 64), 'The first body is kept')
from public.qorpera_computer_hour_stripe_events where event_id = 'evt_1';
select pg_temp.bill('event_begin', jsonb_build_object('eventId', 'evt_2', 'type', 'invoice.paid', 'bodySha256', repeat('c', 64)));
select pg_temp.bill('event_finish', '{"eventId":"evt_2","outcome":"needs_review","detail":"no recorded period"}');
select pg_temp.wake_assert(pg_temp.bill('event_begin', jsonb_build_object('eventId', 'evt_2', 'type', 'invoice.paid',
	'bodySha256', repeat('c', 64))) = '{"state":"open","outcome":null}', 'An event left for review opens again when resent');

-- Credits paid: 20 hours for the company, a dry run in test mode, bought by the founder, twelve months.
select pg_temp.wake_assert((paid ->> 'added')::boolean and paid ->> 'profileId' = '30000000-0000-4000-8000-000000000010',
	'Credits are added once paid: ' || paid::text)
from (select pg_temp.bill('credits_paid', '{"sessionId":"cs_test_credits1","paymentIntentId":"pi_1",
	"paidAt":"2026-09-28T12:00:00Z"}') paid) p;
select pg_temp.wake_assert(not (pg_temp.bill('credits_paid', '{"sessionId":"cs_test_credits1","paymentIntentId":"pi_1",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'A second delivery adds nothing');
select pg_temp.wake_assert(source.granted_seconds = 72000 and source.dry_run and source.user_id = '30000000-0000-4000-8000-000000000001'
	and source.expires_at = '2027-09-28T12:00:00Z' and source.profile_id = '30000000-0000-4000-8000-000000000010',
	'The credit source') from pg_temp.source('pi_1') source;
select pg_temp.bill('credits_paid', '{"sessionId":"cs_test_credits2","paymentIntentId":"pi_2","paidAt":"2026-09-28T12:00:00Z"}');
-- A dispute freezes the purchase and a won one unfreezes it; a lost one withdraws it; a refund takes it back.
select pg_temp.wake_assert(pg_temp.bill('dispute', '{"paymentIntentId":"pi_1","status":"open"}') = '{"matched":1,"changed":1}'
	and (pg_temp.source('pi_1')).frozen_at is not null, 'Frozen by a dispute');
select pg_temp.wake_assert(pg_temp.bill('dispute', '{"paymentIntentId":"pi_1","status":"open"}') = '{"matched":1,"changed":0}',
	'A dispute opened twice changes nothing');
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_1","status":"won"}');
select pg_temp.wake_assert(frozen_at is null and withdrawn_at is null, 'Unfrozen when won') from pg_temp.source('pi_1');
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_2","status":"open"}');
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_2","status":"lost"}');
select pg_temp.wake_assert(withdrawn_at is not null, 'Withdrawn when lost') from pg_temp.source('pi_2');
select pg_temp.wake_assert(pg_temp.bill('refund', '{"paymentIntentId":"pi_1"}') = '{"matched":1,"changed":1}'
	and (pg_temp.source('pi_1')).withdrawn_at is not null, 'Withdrawn by a refund');
select pg_temp.wake_assert(pg_temp.bill('refund', '{"paymentIntentId":"pi_unknown","invoiceId":"in_unknown"}')
	= '{"matched":0,"changed":0}', 'A refund of an unknown payment matches nothing, and says so');
select pg_temp.wake_error($$select public.qorpera_computer_billing('test-billing-key-0123456789', 'dispute',
	'{"paymentIntentId":"pi_1","status":"maybe"}')$$, '22023');

-- Plans: the first period once paid, a renewal when it starts, both linked to their invoice.
select pg_temp.wake_assert(pg_temp.bill('subscription_state', '{"subscriptionId":"sub_1","userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"basis","status":"active","periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z",
	"eventCreated":"2026-09-01T00:00:05Z"}') ->> 'applied' = 'true', 'The subscription is recorded');
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001","itemKey":"standard"}')
	= '{"refused":"has_plan"}', 'A member with a plan changes it on the billing page');
select pg_temp.wake_assert((pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"basis",
	"periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z","invoiceId":"in_c1"}') ->> 'added')::boolean
	and not (pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"basis",
	"periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z","invoiceId":"in_c1"}') ->> 'added')::boolean,
	'A period is added once');
select set_config('qorpera_test.sep', 'sub_1:' || extract(epoch from timestamptz '2026-09-01T00:00:00Z')::bigint, true);
select pg_temp.wake_assert(source.granted_seconds = 74 * 3600 and source.dry_run and exists (
	select 1 from public.qorpera_computer_hour_invoice_sources invoice
	where invoice.stripe_invoice_id = 'in_c1' and invoice.source_id = source.id), 'The period is linked to its invoice')
from pg_temp.source(current_setting('qorpera_test.sep')) source;
-- An older event does not overwrite the subscription.
select pg_temp.bill('subscription_state', '{"subscriptionId":"sub_1","userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"basis","status":"incomplete","periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z",
	"eventCreated":"2026-08-31T00:00:00Z"}');
select pg_temp.wake_assert(status = 'active', 'An older event changes nothing')
from public.qorpera_computer_hour_subscriptions where stripe_subscription_id = 'sub_1';

-- Upgraded to Standard with a third of the period left: (286 - 74) h x 1/3 = 70.67 h = 254400 s.
select pg_temp.wake_assert(upgrade = '{"added":true,"seconds":254400}', 'Upgrade: ' || upgrade::text)
from (select pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodEnd":"2026-10-01T00:00:00Z","paidAt":"2026-09-21T00:00:00Z","invoiceId":"in_up1"}') upgrade) u;
select pg_temp.wake_assert(period_start = '2026-09-21T00:00:00Z' and period_end = '2026-10-01T00:00:00Z' and granted_seconds = 254400,
	'The extra period covers the rest of the period') from pg_temp.source(current_setting('qorpera_test.sep') || ':upgrade');
select pg_temp.wake_assert(pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodEnd":"2026-10-01T00:00:00Z","paidAt":"2026-09-21T00:00:00Z","invoiceId":"in_up1"}') = '{"added":false,"seconds":254400}',
	'The same invoice again adds nothing');
-- One top-up per period: another upgrade invoice in the period (after a downgrade that returned the
-- money, say) is for review, and so is a change that lowered the plan at once.
select pg_temp.wake_assert(pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodEnd":"2026-10-01T00:00:00Z","paidAt":"2026-09-25T00:00:00Z","invoiceId":"in_up2"}') = '{"refused":"second_change_in_period"}',
	'A second top-up in the period is refused');
select pg_temp.wake_assert(pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"standard","toItemKey":"basis",
	"periodEnd":"2026-10-01T00:00:00Z","paidAt":"2026-09-24T00:00:00Z","invoiceId":"in_down1"}') = '{"refused":"plan_lowered_at_once"}',
	'A downgrade that took effect at once is for review');
select pg_temp.wake_assert(pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodEnd":"2026-12-01T00:00:00Z","paidAt":"2026-11-20T00:00:00Z","invoiceId":"in_up3"}') = '{"refused":"no_recorded_period"}',
	'An upgrade needs its recorded period');

-- The renewal: October's period arrives when its invoice is created, before payment.
select pg_temp.bill('subscription_state', '{"subscriptionId":"sub_1","userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"standard","status":"active","periodStart":"2026-10-01T00:00:00Z","periodEnd":"2026-11-01T00:00:00Z",
	"eventCreated":"2026-10-01T00:00:05Z"}');
select pg_temp.wake_assert((pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"standard",
	"periodStart":"2026-10-01T00:00:00Z","periodEnd":"2026-11-01T00:00:00Z","invoiceId":"in_c2"}') ->> 'added')::boolean, 'The renewal');
select set_config('qorpera_test.oct', 'sub_1:' || extract(epoch from timestamptz '2026-10-01T00:00:00Z')::bigint, true);
-- An upgrade paid at the end of September but handled after the renewal never tops up October.
select pg_temp.wake_assert(pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodEnd":"2026-11-01T00:00:00Z","paidAt":"2026-09-30T23:58:00Z","invoiceId":"in_up4"}') = '{"refused":"paid_outside_period"}'
	and pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodEnd":"2026-10-01T00:00:00Z","paidAt":"2026-10-01T00:01:00Z","invoiceId":"in_up5"}') = '{"refused":"paid_outside_period"}',
	'An upgrade paid outside its period is for review');
select pg_temp.wake_assert((pg_temp.source(current_setting('qorpera_test.oct') || ':upgrade')).id is null, 'October has no top-up');

-- A refund or dispute of a plan payment reaches its hours through the invoice.
select pg_temp.wake_assert(pg_temp.bill('refund', '{"paymentIntentId":"pi_plan_up1","invoiceId":"in_up1"}') = '{"matched":1,"changed":1}'
	and (pg_temp.source(current_setting('qorpera_test.sep') || ':upgrade')).withdrawn_at is not null
	and (pg_temp.source(current_setting('qorpera_test.sep'))).withdrawn_at is null,
	'A refunded upgrade withdraws its top-up only');
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_plan_c1","invoiceId":"in_c1","status":"open"}');
select pg_temp.wake_assert(frozen_at is not null, 'A disputed plan payment freezes its period')
from pg_temp.source(current_setting('qorpera_test.sep'));
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_plan_c1","invoiceId":"in_c1","status":"won"}');
select pg_temp.wake_assert(frozen_at is null, 'Won, the period is unfrozen') from pg_temp.source(current_setting('qorpera_test.sep'));
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_plan_c1","invoiceId":"in_c1","status":"lost"}');
select pg_temp.wake_assert(withdrawn_at is not null, 'Lost, the period is withdrawn') from pg_temp.source(current_setting('qorpera_test.sep'));
select pg_temp.wake_assert(pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodEnd":"2026-10-01T00:00:00Z","paidAt":"2026-09-26T00:00:00Z","invoiceId":"in_up6"}') = '{"refused":"period_withdrawn"}',
	'No top-up of a withdrawn period');

-- October's payment fails for good: its unused hours are withdrawn; a payment after that is for review.
select pg_temp.wake_assert((pg_temp.bill('plan_failed', '{"subscriptionId":"sub_1","periodStart":"2026-10-01T00:00:00Z"}')
	->> 'withdrawn')::integer = 1, 'A failed period is withdrawn');
select pg_temp.wake_assert(paid = jsonb_build_object('added', false, 'reference', current_setting('qorpera_test.oct'), 'withdrawn', true),
	'A withdrawn period stays withdrawn: ' || paid::text)
from (select pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"standard",
	"periodStart":"2026-10-01T00:00:00Z","periodEnd":"2026-11-01T00:00:00Z","invoiceId":"in_c2"}') paid) p;
-- An unpaid subscription keeps getting invoices from Stripe, but no new period.
select pg_temp.bill('subscription_state', '{"subscriptionId":"sub_1","userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"standard","status":"unpaid","periodStart":"2026-11-01T00:00:00Z","periodEnd":"2026-12-01T00:00:00Z",
	"eventCreated":"2026-11-01T00:00:05Z"}');
select pg_temp.wake_assert(pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"standard",
	"periodStart":"2026-11-01T00:00:00Z","periodEnd":"2026-12-01T00:00:00Z","invoiceId":"in_c3"}') = '{"skipped":"subscription unpaid"}',
	'No period for an unpaid subscription');
-- Nor for a cancelled or paused one (a late payment of its open invoice goes to review in the function).
create function pg_temp.period_when(p_status text, p_event text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.bill('subscription_state', jsonb_build_object('subscriptionId', 'sub_1',
		'userId', '30000000-0000-4000-8000-000000000001', 'itemKey', 'standard', 'status', p_status,
		'periodStart', '2026-11-01T00:00:00Z', 'periodEnd', '2026-12-01T00:00:00Z', 'eventCreated', p_event));
	return pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"standard",
		"periodStart":"2026-11-01T00:00:00Z","periodEnd":"2026-12-01T00:00:00Z","invoiceId":"in_c3"}');
end
$$;
select pg_temp.wake_assert(pg_temp.period_when('canceled', '2026-11-02T00:00:01Z') = '{"skipped":"subscription canceled"}',
	'No period for a cancelled subscription');
select pg_temp.wake_assert(pg_temp.period_when('paused', '2026-11-02T00:00:02Z') = '{"skipped":"subscription paused"}',
	'No period for a paused subscription');
select pg_temp.wake_assert(pg_temp.period_when('incomplete_expired', '2026-11-02T00:00:03Z')
	= '{"skipped":"subscription incomplete_expired"}', 'No period for an expired first payment');
select pg_temp.wake_assert(pg_temp.period_when('unpaid', '2026-11-02T00:00:04Z') = '{"skipped":"subscription unpaid"}',
	'Unpaid again');

-- Members read the offers and their own plan. Before the live switch only testers can buy, and
-- members see only measured hours: the plan's hours are left out.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(jsonb_array_length(offers -> 'items') = 5 and position('price_' in offers::text) = 0
	and not exists (select 1 from jsonb_array_elements(offers -> 'items') item where not (item ->> 'available')::boolean),
	'Five offers for a tester, without Stripe ids: ' || offers::text)
from (select public.qorpera_list_computer_hour_offers() offers) o;
select pg_temp.wake_assert(plan -> 'plan' ->> 'itemKey' = 'standard' and plan -> 'plan' ->> 'status' = 'unpaid'
	and plan ->> 'mode' = 'dry_run' and plan -> 'hours' = 'null'::jsonb, 'My plan in the dry run: ' || plan::text)
from (select public.qorpera_read_my_computer_plan() plan) p;
reset role;
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_assert(not exists (select 1 from jsonb_array_elements(public.qorpera_list_computer_hour_offers() -> 'items') item
	where (item ->> 'available')::boolean), 'Nothing is for sale to a member who is not a tester before the live switch');
reset role;

-- From the live switch: live prices for everyone, live sources, and members see their plan's hours.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
update public.qorpera_computer_hour_catalog set stripe_price_live = null where item_key = 'hours_500';
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001","itemKey":"hours_20",
	"profileId":"30000000-0000-4000-8000-000000000010"}') = '{"refused":"item_unavailable"}', 'Test mode closes with the live switch');
select pg_temp.bill('checkout_attach', jsonb_build_object('checkoutId', pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"hours_20","profileId":"30000000-0000-4000-8000-000000000010","livemode":true}') ->> 'checkoutId', 'sessionId', 'cs_live_credits1'));
select pg_temp.bill('credits_paid', '{"sessionId":"cs_live_credits1","paymentIntentId":"pi_live1","paidAt":"2026-09-28T12:00:00Z",
	"livemode":true}');
select pg_temp.wake_assert(not dry_run and granted_seconds = 72000, 'A live payment makes a live source') from pg_temp.source('pi_live1');
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000002","itemKey":"basis",
	"livemode":true}') ->> 'kind' = 'plan', 'Live: any member may start a plan checkout');
-- A live plan for the other member, in its first period now.
select set_config('qorpera_test.live_start', to_jsonb(date_trunc('second', clock_timestamp()) - interval '1 day') #>> '{}', true);
select set_config('qorpera_test.live_end', to_jsonb(date_trunc('second', clock_timestamp()) + interval '29 days') #>> '{}', true);
select pg_temp.bill('subscription_state', jsonb_build_object('subscriptionId', 'sub_live1',
	'userId', '30000000-0000-4000-8000-000000000002', 'itemKey', 'basis', 'status', 'active',
	'periodStart', current_setting('qorpera_test.live_start'), 'periodEnd', current_setting('qorpera_test.live_end'),
	'eventCreated', current_setting('qorpera_test.live_start'), 'livemode', true));
select pg_temp.bill('plan_period', jsonb_build_object('subscriptionId', 'sub_live1', 'itemKey', 'basis',
	'periodStart', current_setting('qorpera_test.live_start'), 'periodEnd', current_setting('qorpera_test.live_end'),
	'invoiceId', 'in_live1', 'livemode', true));
select pg_temp.wake_assert(not dry_run and user_id = '30000000-0000-4000-8000-000000000002' and granted_seconds = 74 * 3600,
	'A live plan period') from pg_temp.source('sub_live1:' || extract(epoch from current_setting('qorpera_test.live_start')::timestamptz)::bigint);
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_assert((select array_agg(item ->> 'itemKey' order by item ->> 'itemKey') from jsonb_array_elements(offers -> 'items') item
	where (item ->> 'available')::boolean) = array['basis', 'hours_100', 'hours_20', 'standard'],
	'Live: what has a live price is for sale to every member: ' || offers::text)
from (select public.qorpera_list_computer_hour_offers() offers) o;
select pg_temp.wake_assert(plan ->> 'mode' = 'live' and plan -> 'plan' ->> 'itemKey' = 'basis'
	and plan -> 'hours' = jsonb_build_object('grantedSeconds', 74 * 3600, 'companies', '[]'::jsonb),
	'Live: my plan with its hours: ' || plan::text)
from (select public.qorpera_read_my_computer_plan() plan) p;
reset role;
select pg_temp.path_claims('anon');
set local role anon;
select pg_temp.wake_error('select public.qorpera_read_my_computer_plan()', '42501');
reset role;
rollback;
