-- Computer hours (20260928248970_computer_hour_credits_deleted_company), on folder-v2 companies of their own (ported from
-- snapshot-v1 in the legacy sweep): a pack of hours paid for a company that is gone or being deleted adds no credit. The
-- billing door refuses it (22023), so the computer-billing function records the Stripe event for review and a refund.
begin;

insert into auth.users(id,email) values ('71400000-0000-4000-8000-000000000001','credits-owner@example.test');
-- The company that keeps its credit, and one that will be leaving, both on the folder core.
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('71400000-0000-4000-8000-000000000010','Kept company','71400000-0000-4000-8000-000000000001'),
	('71400000-0000-4000-8000-000000000020','Leaving company','71400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('71400000-0000-4000-8000-000000000010','71400000-0000-4000-8000-000000000001','credits-owner@example.test','Owner','owner'),
	('71400000-0000-4000-8000-000000000020','71400000-0000-4000-8000-000000000001','credits-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('71400000-0000-4000-8000-000000000011','71400000-0000-4000-8000-000000000010','Environment',1,'71400000-0000-4000-8000-000000000001'),
	('71400000-0000-4000-8000-000000000021','71400000-0000-4000-8000-000000000020','Environment',1,'71400000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable(id) from unnest(array['71400000-0000-4000-8000-000000000011',
	'71400000-0000-4000-8000-000000000021']::uuid[]) id \g /dev/null

create function pg_temp.credit_assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'Credit assertion: %', p_message; end if; end
$$;
create function pg_temp.credit_error(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and sqlerrm = p_message then return; end if;
		raise exception 'Expected SQLSTATE % with message %, got %: %', p_state, p_message, sqlstate, sqlerrm;
	end;
	raise exception 'Expected SQLSTATE %, call succeeded', p_state;
end
$$;
select pg_temp.credit_assert(public.qorpera_company_is_folder_v2('71400000-0000-4000-8000-000000000010')
	and public.qorpera_company_is_folder_v2('71400000-0000-4000-8000-000000000020'), 'Both companies are folder-v2');

insert into public.qorpera_computer_hour_billing_keys (key_sha256)
values (encode(extensions.digest('test-billing-key-0123456789', 'sha256'), 'hex'));
create function pg_temp.bill(p_method text, p_args jsonb) returns jsonb language sql as $$
	select public.qorpera_computer_billing('test-billing-key-0123456789', p_method, p_args)
$$;
-- Checkouts for the kept company, for a company that no longer exists, and for one being deleted.
insert into public.qorpera_computer_hour_checkouts (user_id, item_key, profile_id, livemode, stripe_session_id) values
	('71400000-0000-4000-8000-000000000001', 'hours_20', '71400000-0000-4000-8000-000000000010', false, 'cs_test_kept'),
	('71400000-0000-4000-8000-000000000001', 'hours_20', '71400000-0000-4000-8000-000000000099', false, 'cs_test_gone'),
	('71400000-0000-4000-8000-000000000001', 'hours_20', '71400000-0000-4000-8000-000000000020', false, 'cs_test_before'),
	('71400000-0000-4000-8000-000000000001', 'hours_20', '71400000-0000-4000-8000-000000000020', false, 'cs_test_leaving');

select pg_temp.credit_assert((pg_temp.bill('credits_paid', '{"sessionId":"cs_test_kept","paymentIntentId":"pi_kept",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'A company that exists gets its credit');
select pg_temp.credit_error($$select public.qorpera_computer_billing('test-billing-key-0123456789', 'credits_paid',
	'{"sessionId":"cs_test_gone","paymentIntentId":"pi_gone","paidAt":"2026-09-28T12:00:00Z"}')$$, '22023',
	'Billing: credits for a company that no longer exists');
select pg_temp.credit_assert(not exists (select 1 from public.qorpera_computer_hour_sources where reference = 'pi_gone'),
	'No credit for a company that no longer exists');

-- Paid before the deletion was requested: credited.
select pg_temp.credit_assert((pg_temp.bill('credits_paid', '{"sessionId":"cs_test_before","paymentIntentId":"pi_before",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'Paid before the deletion: credited');

-- Being deleted: company delete (20260928249150) records the request in qorpera_company_deletions and answers
-- qorpera_company_deleting; the guard must use company delete's own function, so a rename there fails this test.
insert into public.qorpera_company_deletions (profile_id) values ('71400000-0000-4000-8000-000000000020');
select pg_temp.credit_assert(public.qorpera_company_deleting('71400000-0000-4000-8000-000000000020'), 'The company is being deleted');
select pg_temp.credit_error($$select public.qorpera_computer_billing('test-billing-key-0123456789', 'credits_paid',
	'{"sessionId":"cs_test_leaving","paymentIntentId":"pi_leaving","paidAt":"2026-09-28T12:00:00Z"}')$$, '22023',
	'Billing: credits for a company that is being deleted');
select pg_temp.credit_assert(not exists (select 1 from public.qorpera_computer_hour_sources where reference = 'pi_leaving'),
	'No credit for a company being deleted');
-- A repeated delivery of a payment already credited stays a quiet no-op, even for a company being deleted.
select pg_temp.credit_assert(not (pg_temp.bill('credits_paid', '{"sessionId":"cs_test_before","paymentIntentId":"pi_before",
	"paidAt":"2026-09-28T12:00:00Z"}') ->> 'added')::boolean, 'The same payment again adds nothing and raises nothing');
select pg_temp.credit_assert(not has_function_privilege(role_name, 'public.qorpera_computer_hour_credit_company_guard()', 'EXECUTE'),
	'The guard is callable by no API role') from unnest(array['anon', 'authenticated', 'service_role']) role_name;
rollback;
