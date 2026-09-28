-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 4a (20260929110000_runtime_computer_hours_payments): paid Stripe facts
-- become sources of hours through one dispatcher that only an enrolled billing key opens. Test-mode
-- payments make dry-run sources. Founders buy credits; a member with a plan changes it on Stripe's
-- billing page. The Edge Function that talks to Stripe is covered by its own unit tests.

insert into public.qorpera_computer_hour_billing_keys (key_sha256)
values (encode(extensions.digest('test-billing-key-0123456789', 'sha256'), 'hex'));
update public.qorpera_computer_hour_catalog set stripe_price_test = 'price_' || replace(item_key, '_', '');
create function pg_temp.bill(p_method text, p_args jsonb) returns jsonb language sql as $$
	select public.qorpera_computer_billing('test-billing-key-0123456789', p_method, p_args)
$$;

-- Only the enrolled key opens the door; the door is the service role's alone.
select pg_temp.wake_error($$select public.qorpera_computer_billing('wrong-key', 'catalog_price', '{"itemKey":"basis"}')$$, '42501');
select pg_temp.wake_assert(not has_function_privilege(role_name, 'public.qorpera_computer_billing(text,text,jsonb)', 'EXECUTE'),
	'The billing door is closed to ' || role_name) from unnest(array['anon', 'authenticated']) role_name;
select pg_temp.wake_assert(not exists (
	select 1 from pg_proc function join pg_namespace namespace on namespace.oid = function.pronamespace
	cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
	where namespace.nspname = 'public' and function.proname like 'qorpera_computer_billing_%'
		and has_function_privilege(role_name, function.oid, 'EXECUTE')
), 'The billing helpers are callable by no API role');
select pg_temp.wake_assert(pg_temp.bill('catalog_price', '{"itemKey":"standard"}') = '{"itemKey":"standard","kind":"plan",
	"priceMinor":63000,"currency":"dkk","hours":286,"active":true,"priceId":"price_standard"}'::jsonb, 'The catalog price');
select pg_temp.wake_assert(pg_temp.bill('catalog_price', '{"itemKey":"basis","livemode":true}') ->> 'priceId' is null,
	'No live price until an operator sets one');
select pg_temp.wake_assert(pg_temp.bill('catalog_item_by_price', '{"priceId":"price_standard"}') ->> 'itemKey' = 'standard'
	and pg_temp.bill('catalog_item_by_price', '{"priceId":"price_standard","livemode":true}') ->> 'itemKey' is null,
	'A Stripe price maps back to its item in its own mode');

-- Checkout: founders buy credits for their company; a contributor may not.
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000002","itemKey":"hours_20",
	"profileId":"30000000-0000-4000-8000-000000000010"}') = '{"refused":"not_a_founder"}', 'A contributor cannot buy credits');
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
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001","itemKey":"dedicated"}')
	= '{"refused":"item_unavailable"}', 'The Dedicated plan is not sold');

-- Events are recorded once; a replay is a no-op; another body under the same id is refused.
select pg_temp.wake_assert(pg_temp.bill('event_begin', jsonb_build_object('eventId', 'evt_1', 'type', 'checkout.session.completed',
	'bodySha256', repeat('a', 64))) ->> 'state' = 'open', 'A new event opens');
select pg_temp.bill('event_finish', '{"eventId":"evt_1","outcome":"applied"}');
select pg_temp.wake_assert(pg_temp.bill('event_begin', jsonb_build_object('eventId', 'evt_1', 'type', 'checkout.session.completed',
	'bodySha256', repeat('a', 64))) = '{"state":"finished","outcome":"applied"}', 'A replay finds it finished');
select pg_temp.wake_error(format('select public.qorpera_computer_billing(%L, %L, %L)', 'test-billing-key-0123456789', 'event_begin',
	jsonb_build_object('eventId', 'evt_1', 'type', 'x', 'bodySha256', repeat('b', 64))), '42501');

-- Credits paid: 20 hours for the company, a dry run in test mode, bought by the founder, twelve months.
select pg_temp.wake_assert((paid ->> 'added')::boolean and paid ->> 'profileId' = '30000000-0000-4000-8000-000000000010',
	'Credits are added once paid: ' || paid::text)
from (select pg_temp.bill('credits_paid', '{"sessionId":"cs_test_credits1","paymentIntentId":"pi_1",
	"paidAt":"2026-09-28T12:00:00Z"}') paid) p;
select pg_temp.wake_assert(not (pg_temp.bill('credits_paid', '{"sessionId":"cs_test_credits1","paymentIntentId":"pi_1",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'A second delivery adds nothing');
select pg_temp.wake_assert(source.granted_seconds = 72000 and source.dry_run and source.user_id = '30000000-0000-4000-8000-000000000001'
	and source.expires_at = '2027-09-28T12:00:00Z' and source.profile_id = '30000000-0000-4000-8000-000000000010',
	'The credit source') from public.qorpera_computer_hour_sources source where source.reference = 'pi_1';
-- A dispute freezes the purchase, a won dispute unfreezes it, a refund takes it back.
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_1","status":"open"}');
select pg_temp.wake_assert(frozen_at is not null, 'Frozen by a dispute') from public.qorpera_computer_hour_sources where reference = 'pi_1';
select pg_temp.bill('dispute', '{"paymentIntentId":"pi_1","status":"won"}');
select pg_temp.wake_assert(frozen_at is null and withdrawn_at is null, 'Unfrozen when won') from public.qorpera_computer_hour_sources where reference = 'pi_1';
select pg_temp.wake_assert((pg_temp.bill('refund', '{"paymentIntentId":"pi_1"}') ->> 'withdrawn')::integer = 1, 'Refunded');
select pg_temp.wake_assert(withdrawn_at is not null, 'Withdrawn by a refund') from public.qorpera_computer_hour_sources where reference = 'pi_1';

-- Plans: the first period once paid, a renewal when it starts, an upgrade pro rata, a failed renewal withdrawn.
select pg_temp.wake_assert(pg_temp.bill('subscription_state', '{"subscriptionId":"sub_1","userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"basis","status":"active","periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z",
	"eventCreated":"2026-09-01T00:00:05Z"}') ->> 'applied' = 'true', 'The subscription is recorded');
select pg_temp.wake_assert(pg_temp.bill('checkout_begin', '{"userId":"30000000-0000-4000-8000-000000000001","itemKey":"standard"}')
	= '{"refused":"has_plan"}', 'A member with a plan changes it on the billing page');
select pg_temp.wake_assert((pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"basis",
	"periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z"}') ->> 'added')::boolean
	and not (pg_temp.bill('plan_period', '{"subscriptionId":"sub_1","itemKey":"basis",
	"periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z"}') ->> 'added')::boolean, 'A period is added once');
-- An older event does not overwrite the subscription.
select pg_temp.bill('subscription_state', '{"subscriptionId":"sub_1","userId":"30000000-0000-4000-8000-000000000001",
	"itemKey":"basis","status":"incomplete","periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z",
	"eventCreated":"2026-08-31T00:00:00Z"}');
select pg_temp.wake_assert(status = 'active', 'An older event changes nothing')
from public.qorpera_computer_hour_subscriptions where stripe_subscription_id = 'sub_1';
-- Upgraded to Standard with a third of the period left: (286 - 74) h x 1/3 = 70.67 h = 254400 s.
select pg_temp.wake_assert((upgrade ->> 'seconds')::bigint = 254400 and (upgrade ->> 'added')::boolean, 'Upgrade: ' || upgrade::text)
from (select pg_temp.bill('plan_upgrade', '{"subscriptionId":"sub_1","fromItemKey":"basis","toItemKey":"standard",
	"periodStart":"2026-09-01T00:00:00Z","periodEnd":"2026-10-01T00:00:00Z","paidAt":"2026-09-21T00:00:00Z","invoiceId":"in_up1"}') upgrade) u;
select pg_temp.wake_assert(period_start = '2026-09-21T00:00:00Z' and period_end = '2026-10-01T00:00:00Z' and granted_seconds = 254400,
	'The extra period covers the rest of the period') from public.qorpera_computer_hour_sources where reference = 'in_up1';
-- The renewal fails for good: the period's unused hours are withdrawn.
select pg_temp.wake_assert((pg_temp.bill('plan_failed', '{"subscriptionId":"sub_1","periodStart":"2026-09-01T00:00:00Z"}')
	->> 'withdrawn')::integer = 1, 'A failed period is withdrawn');

-- Members read the offers and their own plan.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(jsonb_array_length(offers -> 'items') = 5 and position('price_' in offers::text) = 0,
	'Five offers, without Stripe ids: ' || offers::text)
from (select public.qorpera_list_computer_hour_offers() offers) o;
select pg_temp.wake_assert(plan -> 'plan' ->> 'itemKey' = 'basis' and plan ->> 'mode' = 'dry_run', 'My plan: ' || plan::text)
from (select public.qorpera_read_my_computer_plan() plan) p;
reset role;
select pg_temp.path_claims('anon');
set local role anon;
select pg_temp.wake_error('select public.qorpera_read_my_computer_plan()', '42501');
reset role;
rollback;
