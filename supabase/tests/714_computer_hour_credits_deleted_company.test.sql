-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours (20260928248970_computer_hour_credits_deleted_company): a pack of hours paid for a
-- company that is gone or being deleted adds no credit. The billing door refuses it (22023), so the
-- computer-billing function records the Stripe event for review and a refund.

insert into public.qorpera_computer_hour_billing_keys (key_sha256)
values (encode(extensions.digest('test-billing-key-0123456789', 'sha256'), 'hex'));
create function pg_temp.bill(p_method text, p_args jsonb) returns jsonb language sql as $$
	select public.qorpera_computer_billing('test-billing-key-0123456789', p_method, p_args)
$$;
-- Checkouts for the fixture company, for a company that no longer exists, and for one being deleted.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('71400000-0000-4000-8000-000000000020','Leaving company','30000000-0000-4000-8000-000000000001');
insert into public.qorpera_computer_hour_checkouts (user_id, item_key, profile_id, livemode, stripe_session_id) values
	('30000000-0000-4000-8000-000000000001', 'hours_20', '30000000-0000-4000-8000-000000000010', false, 'cs_test_kept'),
	('30000000-0000-4000-8000-000000000001', 'hours_20', '71400000-0000-4000-8000-000000000099', false, 'cs_test_gone'),
	('30000000-0000-4000-8000-000000000001', 'hours_20', '71400000-0000-4000-8000-000000000020', false, 'cs_test_before'),
	('30000000-0000-4000-8000-000000000001', 'hours_20', '71400000-0000-4000-8000-000000000020', false, 'cs_test_leaving');

select pg_temp.wake_assert((pg_temp.bill('credits_paid', '{"sessionId":"cs_test_kept","paymentIntentId":"pi_kept",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'A company that exists gets its credit');
select pg_temp.wake_error($$select public.qorpera_computer_billing('test-billing-key-0123456789', 'credits_paid',
	'{"sessionId":"cs_test_gone","paymentIntentId":"pi_gone","paidAt":"2026-09-28T12:00:00Z"}')$$, '22023',
	'Billing: credits for a company that no longer exists');
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_computer_hour_sources where reference = 'pi_gone'),
	'No credit for a company that no longer exists');

-- Paid before the deletion was requested: credited.
select pg_temp.wake_assert((pg_temp.bill('credits_paid', '{"sessionId":"cs_test_before","paymentIntentId":"pi_before",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'Paid before the deletion: credited');

-- Being deleted: company delete (20260929150000) records the request in qorpera_company_deletions and
-- answers qorpera_company_deleting. Where that table is not in the database yet, a stand-in function
-- for this test (rolled back) answers for the leaving company. With the table present the guard must
-- use company delete's own function, so a rename there fails this test.
do $$
begin
	if to_regclass('public.qorpera_company_deletions') is null then
		execute $f$create function public.qorpera_company_deleting(p_profile_id uuid) returns boolean language sql as
			'select p_profile_id = ''71400000-0000-4000-8000-000000000020''::uuid'$f$;
	else
		execute $f$insert into public.qorpera_company_deletions (profile_id)
			values ('71400000-0000-4000-8000-000000000020')$f$;
	end if;
end
$$;
select pg_temp.wake_error($$select public.qorpera_computer_billing('test-billing-key-0123456789', 'credits_paid',
	'{"sessionId":"cs_test_leaving","paymentIntentId":"pi_leaving","paidAt":"2026-09-28T12:00:00Z"}')$$, '22023',
	'Billing: credits for a company that is being deleted');
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_computer_hour_sources where reference = 'pi_leaving'),
	'No credit for a company being deleted');
-- A repeated delivery of a payment already credited stays a quiet no-op, even for a company being deleted.
select pg_temp.wake_assert(not (pg_temp.bill('credits_paid', '{"sessionId":"cs_test_before","paymentIntentId":"pi_before",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'The same payment again adds nothing and raises nothing');
select pg_temp.wake_assert(not has_function_privilege(role_name, 'public.qorpera_computer_hour_credit_company_guard()', 'EXECUTE'),
	'The guard is callable by no API role') from unnest(array['anon', 'authenticated', 'service_role']) role_name;
rollback;
