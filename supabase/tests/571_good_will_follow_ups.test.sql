-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930571000 (good will follow-ups), on the folder-v2 runtime base: a good will invoice that could not charge the
-- card tells the company's founders and the card's member once (a line above the composer), and its paid retry takes
-- the line away; the computer-hours zero rule stays off (its switches cleared, nobody at zero).

select pg_temp.base_claims('service_role');
insert into public.qorpera_computer_hour_billing_keys (key_sha256)
values (encode(extensions.digest('gw-follow-up-key', 'sha256'), 'hex'));
-- A closed November with its finalized invoice, on the admin's card (the admin is no founder: they still hear of it).
insert into public.qorpera_good_will_months (profile_id, month, status, sales_ore, moms_ore, net_ore, fee_ore, due_ore,
	sorting_since, final_at, payer_user_id, stripe_invoice_id, invoice_url, livemode)
values ('92400000-0000-4000-8000-000000000010', '2026-11-01', 'closed', 6250000, 1250000, 5000000, 500000, 500000,
	'2026-12-01', clock_timestamp(), '92400000-0000-4000-8000-000000000004', 'in_follow1', 'https://invoice.stripe.com/i/f1',
	false);

create function pg_temp.fu_bill(p_method text) returns jsonb language sql as $$
	select public.qorpera_good_will_billing('gw-follow-up-key', p_method, '{"invoiceId": "in_follow1", "livemode": false}')
$$;
create function pg_temp.fu_notices() returns table (user_id uuid, open boolean, subject jsonb) language sql as $$
	select n.user_id, n.acknowledged_at is null, n.subject from public.qorpera_member_notifications n
	where n.profile_id = '92400000-0000-4000-8000-000000000010' and n.kind = 'good_will_card_failed' and n.dedupe_key = 'in_follow1'
$$;

do $$
declare v jsonb;
begin
	-- The notice is internal; the kind is allowed.
	foreach v in array array['"anon"', '"authenticated"', '"service_role"']::jsonb[] loop
		perform pg_temp.base_assert(not has_function_privilege(v #>> '{}',
			'public.qorpera_good_will_card_notice(public.qorpera_good_will_months)', 'EXECUTE'), 'the notice is open to ' || v::text);
	end loop;
	perform pg_temp.base_assert(strpos(pg_get_constraintdef((select oid from pg_constraint
		where conname = 'qorpera_member_notifications_kind')), 'good_will_card_failed') > 0, 'the kind is allowed');
	perform pg_temp.base_assert(strpos(pg_get_constraintdef((select oid from pg_constraint
		where conname = 'qorpera_member_notifications_kind')), 'interface_supervision_ended') > 0
		and strpos(pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_member_notifications_kind')),
			'provider_usage_limit') > 0, 'earlier kinds are kept');

	-- 1. The card fails: the owner (the founder) and the admin (whose card it is) hear of it, once; nobody else.
	v := pg_temp.fu_bill('invoice_failed');
	perform pg_temp.base_assert(v ->> 'status' = 'failed', 'failed: ' || v::text);
	perform pg_temp.base_assert((select array_agg(user_id order by user_id) from pg_temp.fu_notices() where open)
		= array['92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000004']::uuid[],
		'the founder and the card''s member: ' || (select jsonb_agg(to_jsonb(n)) from pg_temp.fu_notices() n)::text);
	perform pg_temp.base_assert((select subject = jsonb_build_object('schema', 'qorpera.member-notification.good-will-card-failed/v1',
		'month', '2026-11', 'dueOre', 500000, 'invoiceUrl', 'https://invoice.stripe.com/i/f1', 'mine', true)
		from pg_temp.fu_notices() where user_id = '92400000-0000-4000-8000-000000000004'), 'the card''s member reads it is theirs');
	perform pg_temp.base_assert((select not (subject ->> 'mine')::boolean from pg_temp.fu_notices()
		where user_id = '92400000-0000-4000-8000-000000000001'), 'the founder reads it is the company''s card');
	-- Stripe says it again: still once.
	perform pg_temp.fu_bill('invoice_failed');
	perform pg_temp.base_assert((select count(*) from pg_temp.fu_notices()) = 2, 'told once');

	-- 2. Stripe's retry pays it: the lines go.
	v := pg_temp.fu_bill('invoice_paid');
	perform pg_temp.base_assert(v ->> 'status' = 'charged', 'charged: ' || v::text);
	perform pg_temp.base_assert(not exists (select 1 from pg_temp.fu_notices() where open), 'paid takes the lines away');

	-- 3. The zero rule stays off.
	perform pg_temp.base_assert((select zero_rule_since is null and coding_zero_rule_since is null
		from public.qorpera_computer_hour_billing), 'the zero rule''s switches are off');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_computer_hour_zero_state), 'nobody is at zero');
	perform pg_temp.base_assert(col_description('public.qorpera_computer_hour_billing'::regclass,
		(select attnum from pg_attribute where attrelid = 'public.qorpera_computer_hour_billing'::regclass
			and attname = 'zero_rule_since')) like 'Retired by good will%', 'the switch says it is retired');
	-- The live switch alone holds no company's work.
	update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 minute';
	perform pg_temp.base_assert(not public.qorpera_company_at_zero('92400000-0000-4000-8000-000000000010', clock_timestamp()),
		'live payments hold nothing');
	update public.qorpera_computer_hour_billing set live_since = null;
end
$$;

rollback;
