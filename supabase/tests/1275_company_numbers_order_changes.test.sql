-- @fixture 1274_company_numbers_orders.test.sql until "-- The checks start here."
-- The company's own word on its orders (company views step 5, slice O2, 20260930777000) on 1274's fixture: 924's
-- folder-v2 company with its members (owner, contributor, viewer, admin) and run, 420's Stripe hook delivering events
-- the real way, and another company. Checked here: the grants and the native host's row; order-state's transitions
-- (forward only, cancelled from any, the same again changes nothing) and that Stripe's facts stay; unknown, unpaid and
-- failed orders; the order's name hashed with the company (never kept); test and live; order-add (its answer, its row,
-- every bound) and its 500 a day; cancelling an added order; to_pack's start (Stripe's marks only) and its 90 days;
-- the questions after adds (orders-sources splits Stripe's from those added); rights; the native host's call. Each
-- numbered block stands alone (it clears the orders first).

-- Parameters with "@day" for five days ago (an added order's day that stays within its 400 days).
create function pg_temp.c_days(p_params jsonb) returns jsonb language sql as $$
	select replace(p_params::text, '"@day"', to_jsonb(to_char(current_date - 5, 'YYYY-MM-DD'))::text)::jsonb
$$;
-- A member's change, as their token makes it; the claims are the service role's again afterwards.
create function pg_temp.c_member(p_user uuid, p_change text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_member_company_numbers_change(p_environment, p_change, pg_temp.c_days(p_params));
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- 'ok' or '<sqlstate> <message>' of a member's change.
create function pg_temp.c_refused(p_change text, p_params jsonb default '{}'::jsonb,
	p_user uuid default '92400000-0000-4000-8000-000000000001',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns text language plpgsql as $$
declare v text;
begin
	v := pg_temp.o_state(format('select pg_temp.c_member(%L, %L, %L::jsonb, %L)', p_user, p_change, p_params,
		p_environment));
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- A run's change as the native host's dispatch makes it (the service role).
create function pg_temp.c_run(p_change text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_run_company_numbers_change(p_environment, pg_temp.o_actor(), p_change, pg_temp.c_days(p_params));
end $$;
-- order-state by a member (the owner by default): '<changed> <state>' or '<sqlstate> <message>'.
create function pg_temp.c_mark(p_order text, p_state text, p_more jsonb default '{}'::jsonb,
	p_user uuid default '92400000-0000-4000-8000-000000000001') returns text language plpgsql as $$
declare v jsonb;
begin
	begin
		v := pg_temp.c_member(p_user, 'order-state', jsonb_build_object('order', p_order, 'state', p_state) || p_more);
	exception when others then
		perform pg_temp.base_claims('service_role');
		return sqlstate || ' ' || sqlerrm;
	end;
	return (v ->> 'changed') || ' ' || (v #>> '{rows,0,0}');
end $$;
-- order-state by the run.
create function pg_temp.c_run_mark(p_order text, p_state text) returns text language plpgsql as $$
declare v jsonb;
begin
	begin
		v := pg_temp.c_run('order-state', jsonb_build_object('order', p_order, 'state', p_state));
	exception when others then
		return sqlstate || ' ' || sqlerrm;
	end;
	return (v ->> 'changed') || ' ' || (v #>> '{rows,0,0}');
end $$;
-- order-add by a member (the owner by default): the answer.
create function pg_temp.c_add(p_params jsonb, p_user uuid default '92400000-0000-4000-8000-000000000001')
returns jsonb language sql as $$
	select pg_temp.c_member(p_user, 'order-add', p_params)
$$;
-- order-add's ref.
create function pg_temp.c_ref(p_params jsonb, p_user uuid default '92400000-0000-4000-8000-000000000001')
returns text language sql as $$
	select pg_temp.c_add(p_params, p_user) #>> '{rows,0,0}'
$$;
-- A paid Checkout Session of payment p_pi.
create function pg_temp.c_paid(p_pi text, p_amount bigint, p_at timestamptz, p_live boolean default true)
returns text language sql as $$
	select pg_temp.o_send(pg_temp.o_event('evt_' || p_pi || case when p_live then '' else '_test' end,
		'checkout.session.completed', pg_temp.o_session('cs_' || p_pi, p_pi, p_amount, p_at, 'dkk', p_live)))
$$;
-- A time as order-add takes it.
create function pg_temp.c_iso(p_at timestamptz) returns text language sql as $$
	select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;
-- A question's rows, by name.
create function pg_temp.c_rows(p_question text, p_params jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select pg_temp.o_rows(p_question, p_params)
$$;

-- The checks start here.

-- 1. The grants: the change dispatcher and the currency list closed to every API role; the member's door to
--    authenticated only, the run's to the service role only, and on the native host's list (scope folder); the change
--    writes (volatile) as its owner with a 3 s lock wait; the indexes; both patched functions carry the marker.
do $$
declare v_function text; v_role text;
begin
	foreach v_function in array array['public.qorpera_order_currency_known(text)',
		'public.qorpera_company_numbers_change(uuid,uuid,jsonb,text,jsonb)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is open to %', v_function, v_role; end if;
		end loop;
	end loop;
	perform pg_temp.o_same(concat_ws(' ',
		has_function_privilege('anon', 'public.qorpera_member_company_numbers_change(uuid,text,jsonb)', 'EXECUTE'),
		has_function_privilege('authenticated', 'public.qorpera_member_company_numbers_change(uuid,text,jsonb)', 'EXECUTE'),
		has_function_privilege('service_role', 'public.qorpera_member_company_numbers_change(uuid,text,jsonb)', 'EXECUTE'),
		has_function_privilege('qorpera_secret_broker', 'public.qorpera_member_company_numbers_change(uuid,text,jsonb)',
			'EXECUTE'),
		has_function_privilege('anon', 'public.qorpera_run_company_numbers_change(uuid,jsonb,text,jsonb)', 'EXECUTE'),
		has_function_privilege('authenticated', 'public.qorpera_run_company_numbers_change(uuid,jsonb,text,jsonb)', 'EXECUTE'),
		has_function_privilege('service_role', 'public.qorpera_run_company_numbers_change(uuid,jsonb,text,jsonb)', 'EXECUTE'),
		has_function_privilege('qorpera_secret_broker', 'public.qorpera_run_company_numbers_change(uuid,jsonb,text,jsonb)',
			'EXECUTE')),
		'f t f f f f t f', 'the two doors');
	perform pg_temp.o_same((select scope || ' ' || budget from public.qorpera_native_host_calls
		where name = 'qorpera_run_company_numbers_change'), 'folder standard', 'the native host''s list');
	perform pg_temp.o_same((select string_agg(proname || ' ' || provolatile::text || ' ' || prosecdef || ' '
			|| coalesce(array_to_string(proconfig, ','), '-'), ' | ' order by proname)
		from pg_proc where pronamespace = 'public'::regnamespace and proname in ('qorpera_company_numbers_change',
			'qorpera_member_company_numbers_change', 'qorpera_run_company_numbers_change')),
		'qorpera_company_numbers_change v true search_path="",lock_timeout=3s'
		' | qorpera_member_company_numbers_change v true search_path=""'
		' | qorpera_run_company_numbers_change v true search_path=""', 'volatile, as their owner');
	perform pg_temp.o_same((select string_agg(indexname || ': ' || substring(indexdef from ' WHERE .*$'), ' | '
			order by indexname)
		from pg_indexes where schemaname = 'public' and indexname in ('qorpera_orders_added', 'qorpera_orders_marked')),
		'qorpera_orders_added:  WHERE (source = ''added''::text) | qorpera_orders_marked:  WHERE ((state = ANY '
		'(ARRAY[''packed''::text, ''on_the_way''::text, ''delivered''::text, ''cancelled''::text])) AND '
		'(source = ''stripe''::text))', 'the indexes');
	perform pg_temp.o_same((select string_agg(proname, ',' order by proname) from pg_proc
		where pronamespace = 'public'::regnamespace and prosrc like '%20260930777000%'),
		'qorpera_company_numbers_answer,qorpera_company_numbers_change,qorpera_company_numbers_orders,'
		'qorpera_member_company_numbers_change,qorpera_order_currency_known,qorpera_run_company_numbers_change',
		'the marker');
end $$;

-- 2. order-state: forward (a step may be skipped), cancelled from any state, nothing after cancelled, the same state
--    again changes nothing; the setter's kind and time; Stripe's facts (amount, refund, dispute) stay, and a later
--    refund moves them under the company's state; the answer's shape.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '1 hour'; v_start timestamptz := clock_timestamp(); v jsonb;
	v_state_at timestamptz;
begin
	perform pg_temp.o_clean();
	perform pg_temp.c_paid('pi_S1', 10000, v_at);
	perform pg_temp.o_send(pg_temp.o_event('evt_S1r', 'charge.refunded', pg_temp.o_charge('pi_S1', 10000, 2500)));
	perform pg_temp.o_send(pg_temp.o_event('evt_S1d', 'charge.dispute.created', pg_temp.o_dispute('pi_S1', 'needs_response')));
	perform pg_temp.o_same(pg_temp.o_order('pi_S1'), pg_temp.o_min(v_at) || ' dkk 10000 2500 open paid/stripe', 'paid');
	v := pg_temp.c_member('92400000-0000-4000-8000-000000000001', 'order-state', '{"order": "pi_S1", "state": "packed"}');
	perform pg_temp.o_json(v - 'asOf', '{"changed": 1, "columns": ["state"], "rows": [["packed"]], "more": false}',
		'the answer');
	perform pg_temp.o_same(((v ->> 'asOf') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')::text, 'true', 'asOf');
	perform pg_temp.o_same(pg_temp.o_order('pi_S1'), pg_temp.o_min(v_at) || ' dkk 10000 2500 open packed/member',
		'packed by a member; Stripe''s facts stay');
	perform pg_temp.o_same((select (state_at between v_start and clock_timestamp())::text from public.qorpera_orders
		where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_S1')), 'true',
		'its time');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'on_the_way'), '1 on_the_way', 'on its way');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'delivered'), '1 delivered', 'delivered');
	select state_at into v_state_at from public.qorpera_orders
	where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_S1');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'delivered'), '0 delivered', 'the same again');
	perform pg_temp.o_same((select (state_at = v_state_at)::text from public.qorpera_orders
		where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_S1')), 'true',
		'the same again keeps its time');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'packed'), '22023 The order is delivered already: a state only moves '
		'forward (packed, on_the_way, delivered), or to cancelled', 'never back');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'on_the_way'), '22023 The order is delivered already: a state only '
		'moves forward (packed, on_the_way, delivered), or to cancelled', 'never back a step');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'cancelled'), '1 cancelled', 'cancelled after delivered');
	perform pg_temp.o_same(pg_temp.o_order('pi_S1'), pg_temp.o_min(v_at) || ' dkk 10000 2500 open cancelled/member',
		'a Stripe order cancelled: its refund is Stripe''s');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'delivered'), '22023 The order is cancelled: a cancelled order takes '
		'no other state', 'nothing after cancelled');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S1', 'cancelled'), '0 cancelled', 'cancelled again');
	-- Stripe's refund after: its fact moves, the company's state stays.
	perform pg_temp.o_send(pg_temp.o_event('evt_S1r2', 'charge.refunded', pg_temp.o_charge('pi_S1', 10000, 10000)));
	perform pg_temp.o_same(pg_temp.o_order('pi_S1'), pg_temp.o_min(v_at) || ' dkk 10000 10000 open cancelled/member',
		'a refund after');
	-- A step skipped; then back is refused.
	perform pg_temp.c_paid('pi_S2', 2000, v_at);
	perform pg_temp.o_same(pg_temp.c_mark('pi_S2', 'delivered'), '1 delivered', 'paid to delivered');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S2', 'on_the_way'), '22023 The order is delivered already: a state only '
		'moves forward (packed, on_the_way, delivered), or to cancelled', 'skipped is passed');
	-- A run sets it as an agent; a member's later word is a member's.
	perform pg_temp.c_paid('pi_S3', 3000, v_at);
	perform pg_temp.o_same(pg_temp.c_run_mark('pi_S3', 'on_the_way'), '1 on_the_way', 'a run');
	perform pg_temp.o_same(pg_temp.o_order('pi_S3'), pg_temp.o_min(v_at) || ' dkk 3000 0 - on_the_way/agent', 'an agent''s');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S3', 'packed'), '22023 The order is on_the_way already: a state only '
		'moves forward (packed, on_the_way, delivered), or to cancelled', 'on its way is past packed');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S3', 'cancelled'), '1 cancelled', 'cancelled on its way');
	perform pg_temp.o_same(pg_temp.o_order('pi_S3'), pg_temp.o_min(v_at) || ' dkk 3000 0 - cancelled/member', 'a member''s');
	-- Paid to cancelled; paid is not a state the company sets.
	perform pg_temp.c_paid('pi_S4', 4000, v_at);
	perform pg_temp.o_same(pg_temp.c_mark('pi_S4', 'paid'), '22023 :state is packed, on_the_way, delivered or cancelled',
		'paid is Stripe''s');
	perform pg_temp.o_same(pg_temp.c_mark('pi_S4', 'cancelled'), '1 cancelled', 'paid to cancelled');
	perform pg_temp.o_same(pg_temp.o_order('pi_S4'), pg_temp.o_min(v_at) || ' dkk 4000 0 - cancelled/member',
		'a Stripe order''s refund stays Stripe''s');
	perform pg_temp.c_paid('pi_S5', 5000, v_at);
	perform public.qorpera_order_upkeep();
	perform pg_temp.o_same(pg_temp.c_mark('pi_S5', 'packed') || ', ' || pg_temp.c_mark('pi_S5', 'packed') || ', '
		|| pg_temp.c_mark('pi_S5', 'cancelled'), '1 packed, 0 packed, 1 cancelled', 'packed to cancelled');
	-- A change leaves the order for the upkeep to add again.
	perform pg_temp.o_same((select string_agg(rolled::text, ',') from public.qorpera_orders
		where ref_sha256 = public.qorpera_order_ref_sha256('92400000-0000-4000-8000-000000000010', 'pi_S5')), 'false',
		'left for the upkeep');
end $$;

-- 3. Orders that take no state: one the company does not have, a paid session named by its own id (it is named by
--    its payment), one unpaid, one whose payment failed, a refund whose session never came; another company's order.
--    A session without a payment (a free one) is named by its own id. Names and states of the wrong shape.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '1 hour';
begin
	perform pg_temp.o_clean();
	perform pg_temp.c_paid('pi_K1', 10000, v_at);
	perform pg_temp.o_same(pg_temp.c_mark('pi_Nobody', 'packed'), 'P0002 No order of this company is named so (a paid '
		'Checkout Session is named by its payment_intent, pi_...)', 'not there');
	perform pg_temp.o_same(pg_temp.c_mark('cs_pi_K1', 'packed'), 'P0002 No order of this company is named so (a paid '
		'Checkout Session is named by its payment_intent, pi_...)', 'a paid session by its own id');
	perform pg_temp.o_send(pg_temp.o_event('evt_KFree', 'checkout.session.completed',
		pg_temp.o_session('cs_KFree', null, 0, v_at, 'dkk', true, 'no_payment_required')));
	perform pg_temp.o_same(pg_temp.c_mark('cs_KFree', 'packed'), '1 packed', 'a free session by its own id');
	perform pg_temp.o_send(pg_temp.o_event('evt_KU', 'checkout.session.completed',
		pg_temp.o_session('cs_KU', 'pi_KUnpaid', 7000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_same(pg_temp.c_mark('pi_KUnpaid', 'packed'), 'P0002 The order named is not paid: only a paid '
		'order takes a state', 'unpaid');
	perform pg_temp.o_send(pg_temp.o_event('evt_KF1', 'checkout.session.completed',
		pg_temp.o_session('cs_KF', 'pi_KFailed', 7000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_send(pg_temp.o_event('evt_KF2', 'checkout.session.async_payment_failed',
		pg_temp.o_session('cs_KF', 'pi_KFailed', 7000, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_same(pg_temp.c_mark('pi_KFailed', 'cancelled'), 'P0002 The order named is not paid: only a paid '
		'order takes a state', 'failed');
	perform pg_temp.o_send(pg_temp.o_event('evt_KO', 'charge.refunded', pg_temp.o_charge('pi_KOrphan', 1000, 1000)));
	perform pg_temp.o_same(pg_temp.c_mark('pi_KOrphan', 'packed'), 'P0002 The order named is not paid: only a paid '
		'order takes a state', 'a refund whose session never came');
	perform pg_temp.o_same(pg_temp.o_order('pi_KUnpaid') || ' | ' || pg_temp.o_order('pi_KFailed') || ' | '
		|| pg_temp.o_order('pi_KOrphan'), pg_temp.o_min(v_at) || ' dkk 7000 0 - - | ' || pg_temp.o_min(v_at)
		|| ' dkk 7000 0 - failed/stripe | - - - 1000 - -', 'none of them changed');
	-- Another company's member names this company's order in their own company: not theirs.
	perform pg_temp.o_same(pg_temp.c_mark('pi_K1', 'packed', '{}', '12740000-0000-4000-8000-000000000006'),
		'42501 Company numbers are unavailable', 'another company''s member, here');
	perform pg_temp.o_same(pg_temp.o_state($s$select pg_temp.c_member('12740000-0000-4000-8000-000000000006',
		'order-state', '{"order": "pi_K1", "state": "packed"}', '12740000-0000-4000-8000-000000000020')$s$),
		'P0002 No order of this company is named so (a paid Checkout Session is named by its payment_intent, pi_...)',
		'another company''s member, there');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.o_same(pg_temp.o_order('pi_K1'), pg_temp.o_min(v_at) || ' dkk 10000 0 - paid/stripe', 'still paid');
	-- Shapes.
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": "ch_K1", "state": "packed"}'), '22023 :order is '
		'Stripe''s payment id (pi_...), a Checkout Session''s id (cs_...) or the ref order-add gave (add_...)', 'a charge');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": "pi_", "state": "packed"}'), '22023 :order is '
		'Stripe''s payment id (pi_...), a Checkout Session''s id (cs_...) or the ref order-add gave (add_...)', 'pi_ alone');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', jsonb_build_object('order', 'pi_' || repeat('a', 251),
		'state', 'packed')), '22023 :order is Stripe''s payment id (pi_...), a Checkout Session''s id (cs_...) or the ref '
		'order-add gave (add_...)', 'too long');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', jsonb_build_object('order', 'add_' || repeat('a', 31),
		'state', 'packed')), '22023 :order is Stripe''s payment id (pi_...), a Checkout Session''s id (cs_...) or the ref '
		'order-add gave (add_...)', 'an add ref too short');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', jsonb_build_object('order', 'add_' || repeat('A', 32),
		'state', 'packed')), '22023 :order is Stripe''s payment id (pi_...), a Checkout Session''s id (cs_...) or the ref '
		'order-add gave (add_...)', 'an add ref not hex');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": 5, "state": "packed"}'), '22023 :order is '
		'Stripe''s payment id (pi_...), a Checkout Session''s id (cs_...) or the ref order-add gave (add_...)', 'a number');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', jsonb_build_object('order', 'add_' || repeat('a', 32),
		'state', 'packed')), 'P0002 No order of this company is named so (a paid Checkout Session is named by its '
		'payment_intent, pi_...)', 'an add ref never given');
	perform pg_temp.o_same(pg_temp.c_mark('pi_K1', 'shipped'), '22023 :state is packed, on_the_way, delivered or '
		'cancelled', 'a state that is not');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": "pi_K1", "state": 2}'), '22023 :state is packed, '
		'on_the_way, delivered or cancelled', 'a state number');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"state": "packed"}'), '22023 The change takes :order',
		'no order');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": null, "state": "packed"}'),
		'22023 The change takes :order', 'a null order');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": "pi_K1"}'), '22023 The change takes :state',
		'no state');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": "pi_K1", "state": "packed", "note": "x"}'),
		'22023 The change takes no :note', 'a parameter it does not take');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{"order": "pi_K1", "state": "packed", "test": "yes"}'),
		'22023 :test is true or false', 'test');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', null), '22023 The change takes :order', 'no parameters');
end $$;

-- 4. The order's name is hashed with the company's id and never kept: neither Stripe's ids nor an added order's ref
--    reach any table of the door; an added order's key is the sha256 of '<company id>:<ref>'.
do $$
declare v_ref text; v_everything text;
begin
	perform pg_temp.o_clean();
	perform pg_temp.c_paid('pi_HashOne', 10000, pg_temp.o_at());
	perform pg_temp.o_same(pg_temp.c_mark('pi_HashOne', 'packed'), '1 packed', 'marked by its id');
	perform pg_temp.o_same((select ref_sha256 from public.qorpera_orders where source = 'stripe'),
		encode(extensions.digest('92400000-0000-4000-8000-000000000010:pi_HashOne', 'sha256'), 'hex'), 'its key');
	v_ref := pg_temp.c_ref(jsonb_build_object('at', pg_temp.c_iso(pg_temp.o_at()), 'amount', 10, 'currency', 'DKK'));
	perform pg_temp.o_same((v_ref ~ '^add_[0-9a-f]{32}$')::text, 'true', 'the ref');
	perform pg_temp.o_same((select ref_sha256 from public.qorpera_orders where source = 'added'),
		encode(extensions.digest('92400000-0000-4000-8000-000000000010:' || v_ref, 'sha256'), 'hex'), 'the added key');
	perform pg_temp.o_same(pg_temp.c_mark(v_ref, 'delivered'), '1 delivered', 'named by its ref');
	perform public.qorpera_order_upkeep();
	v_everything := pg_temp.o_everything();
	if strpos(v_everything, 'HashOne') > 0 or strpos(v_everything, substr(v_ref, 5)) > 0 then
		raise exception 'A table of the door holds a name: %', v_everything; end if;
	-- Two adds, two refs.
	perform pg_temp.o_same((pg_temp.c_ref('{"at": "@day", "amount": 1, "currency": "dkk"}')
		<> pg_temp.c_ref('{"at": "@day", "amount": 1, "currency": "dkk"}'))::text, 'true', 'random refs');
end $$;

-- 5. Test and live: a test order is found without `test`, or with test true, never with test false; when both modes
--    hold the same id, the live one is changed unless test is true.
do $$
declare v_at timestamptz := pg_temp.o_at() - interval '1 hour';
begin
	perform pg_temp.o_clean();
	perform pg_temp.c_paid('pi_TM', 1500, v_at, false);
	perform pg_temp.o_same(pg_temp.c_mark('pi_TM', 'packed', '{"test": false}'), 'P0002 No order of this company is '
		'named so (a paid Checkout Session is named by its payment_intent, pi_...)', 'not live');
	perform pg_temp.o_same(pg_temp.c_mark('pi_TM', 'packed'), '1 packed', 'found in test mode');
	perform pg_temp.o_same(pg_temp.c_mark('pi_TM', 'on_the_way', '{"test": "true"}'), '1 on_the_way', 'test: "true"');
	perform pg_temp.o_same(pg_temp.o_order('pi_TM', false), pg_temp.o_min(v_at) || ' dkk 1500 0 - on_the_way/member',
		'the test order');
	perform pg_temp.c_paid('pi_Both', 1000, v_at, false);
	perform pg_temp.c_paid('pi_Both', 2000, v_at, true);
	perform pg_temp.o_same(pg_temp.c_mark('pi_Both', 'packed'), '1 packed', 'both: the live one');
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Both', true), ' ', 6) || ' '
		|| split_part(pg_temp.o_order('pi_Both', false), ' ', 6), 'packed/member paid/stripe', 'live changed');
	perform pg_temp.o_same(pg_temp.c_mark('pi_Both', 'delivered', '{"test": true}'), '1 delivered', 'test: true');
	perform pg_temp.o_same(pg_temp.c_mark('pi_Both', 'on_the_way', '{"test": false}'), '1 on_the_way', 'test: false');
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_Both', true), ' ', 6) || ' '
		|| split_part(pg_temp.o_order('pi_Both', false), ' ', 6), 'on_the_way/member delivered/member', 'each its own');
end $$;

-- 6. order-add: its answer and its row (added, live, no hook, the company's environment, the setter's kind); `at` as
--    a time with its zone or a day of the company's, within 400 days, never ahead (a minute's leeway); `amount` in the
--    currency's units with its decimals, 0 to 9 999 999 999 minor units; `currency` an ISO 4217 code; `state`.
do $$
declare v jsonb; v_now timestamptz := pg_temp.o_at(); v_ref text; v_day date := current_date - 5;
begin
	perform pg_temp.o_clean();
	v := pg_temp.c_add(jsonb_build_object('at', pg_temp.c_iso(v_now - interval '2 hours'), 'amount', 249.95,
		'currency', 'DKK'));
	v_ref := v #>> '{rows,0,0}';
	perform pg_temp.o_json(v - 'asOf', jsonb_build_object('changed', 1, 'columns', '["order", "state"]'::jsonb,
		'rows', jsonb_build_array(jsonb_build_array(v_ref, 'paid')), 'more', false), 'the answer');
	perform pg_temp.o_same(pg_temp.o_order(v_ref), pg_temp.o_min(v_now - interval '2 hours') || ' dkk 24995 0 - paid/member',
		'the order');
	perform pg_temp.o_same((select concat_ws(' ', source, live, coalesce(hook_id::text, 'no hook'), environment_id, rolled)
		from public.qorpera_orders where source = 'added'),
		'added t no hook 92400000-0000-4000-8000-000000000020 f', 'its row');
	-- By a run: an agent's; with a state.
	v_ref := pg_temp.c_run('order-add', jsonb_build_object('at', pg_temp.c_iso(v_now), 'amount', '12.50',
		'currency', 'eur', 'state', 'delivered')) #>> '{rows,0,0}';
	perform pg_temp.o_same(pg_temp.o_order(v_ref), pg_temp.o_min(v_now) || ' eur 1250 0 - delivered/agent', 'a run''s');
	-- When: a day is its first minute in the company's zone; a time with its offset; seconds kept, parts of them not.
	v_ref := pg_temp.c_ref(jsonb_build_object('at', to_char(v_day, 'YYYY-MM-DD'), 'amount', 1, 'currency', 'dkk'));
	perform pg_temp.o_same((select (ordered_at = v_day::timestamp at time zone 'Europe/Copenhagen')::text
		from public.qorpera_orders where ref_sha256 = public.qorpera_order_ref_sha256(
			'92400000-0000-4000-8000-000000000010', v_ref)), 'true', 'a day, in Copenhagen');
	update public.qorpera_profiles set time_zone = 'America/Los_Angeles' where id = '92400000-0000-4000-8000-000000000010';
	v_ref := pg_temp.c_ref(jsonb_build_object('at', to_char(v_day, 'YYYY-MM-DD'), 'amount', 1, 'currency', 'dkk'));
	perform pg_temp.o_same((select (ordered_at = v_day::timestamp at time zone 'America/Los_Angeles')::text
		from public.qorpera_orders where ref_sha256 = public.qorpera_order_ref_sha256(
			'92400000-0000-4000-8000-000000000010', v_ref)), 'true', 'a day, in Los Angeles');
	update public.qorpera_profiles set time_zone = null where id = '92400000-0000-4000-8000-000000000010';
	v_ref := pg_temp.c_ref(jsonb_build_object('at', to_char(v_day, 'YYYY-MM-DD') || 'T15:30:07.25+01:00', 'amount', 1,
		'currency', 'dkk'));
	perform pg_temp.o_same((select to_char(ordered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
		from public.qorpera_orders where ref_sha256 = public.qorpera_order_ref_sha256(
			'92400000-0000-4000-8000-000000000010', v_ref)), to_char(v_day, 'YYYY-MM-DD') || 'T14:30:07.000000',
		'an offset; to the second');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', jsonb_build_object('at', pg_temp.c_iso(clock_timestamp()
		+ interval '30 seconds'), 'amount', 1, 'currency', 'dkk')), 'ok', '30 seconds ahead');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', jsonb_build_object('at', pg_temp.c_iso(clock_timestamp()
		+ interval '2 minutes'), 'amount', 1, 'currency', 'dkk')), '22023 :at is ahead of now: an order is added once it '
		'was made', 'two minutes ahead');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', jsonb_build_object('at', pg_temp.c_iso(clock_timestamp()
		- interval '399 days'), 'amount', 1, 'currency', 'dkk')), 'ok', '399 days ago');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', jsonb_build_object('at', pg_temp.c_iso(clock_timestamp()
		- interval '400 days 1 minute'), 'amount', 1, 'currency', 'dkk')), '22023 :at is at most 400 days ago (order rows '
		'go then)', 'over 400 days ago');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "yesterday", "amount": 1, "currency": "dkk"}'),
		'22023 :at is when it was ordered: a time with its zone, as 2026-11-15T14:30Z or 2026-11-15T15:30+01:00, or a day '
		'as YYYY-MM-DD', 'a word');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "2026-02-30", "amount": 1, "currency": "dkk"}'),
		'22023 :at is when it was ordered: a time with its zone, as 2026-11-15T14:30Z or 2026-11-15T15:30+01:00, or a day '
		'as YYYY-MM-DD', 'a day that is not');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "2026-11-10T14:30", "amount": 1, "currency": "dkk"}'),
		'22023 :at is when it was ordered: a time with its zone, as 2026-11-15T14:30Z or 2026-11-15T15:30+01:00, or a day '
		'as YYYY-MM-DD', 'a time without its zone');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": 1790000000, "amount": 1, "currency": "dkk"}'),
		'22023 :at is when it was ordered: a time with its zone, as 2026-11-15T14:30Z or 2026-11-15T15:30+01:00, or a day '
		'as YYYY-MM-DD', 'a number');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "2026-11-10T25:30Z", "amount": 1, "currency": "dkk"}'),
		'22023 :at is when it was ordered: a time with its zone, as 2026-11-15T14:30Z or 2026-11-15T15:30+01:00, or a day '
		'as YYYY-MM-DD', 'an hour that is not');
	-- Amounts: the currency's decimals (trailing zeros are no decimals), text or a number, 0 to the bound.
	v_ref := pg_temp.c_ref('{"at": "@day", "amount": 249.950, "currency": "dkk"}');
	perform pg_temp.o_same(split_part(pg_temp.o_order(v_ref), ' ', 3), '24995', 'a trailing zero');
	v_ref := pg_temp.c_ref('{"at": "@day", "amount": 1500, "currency": "JPY"}');
	perform pg_temp.o_same(split_part(pg_temp.o_order(v_ref), ' ', 2) || ' ' || split_part(pg_temp.o_order(v_ref), ' ', 3),
		'jpy 1500', 'yen are whole');
	v_ref := pg_temp.c_ref('{"at": "@day", "amount": "1.234", "currency": "kwd"}');
	perform pg_temp.o_same(split_part(pg_temp.o_order(v_ref), ' ', 3), '1234', 'three decimals of KWD');
	v_ref := pg_temp.c_ref('{"at": "@day", "amount": 0, "currency": "dkk"}');
	perform pg_temp.o_same(split_part(pg_temp.o_order(v_ref), ' ', 3), '0', 'a free one');
	v_ref := pg_temp.c_ref('{"at": "@day", "amount": 99999999.99, "currency": "dkk"}');
	perform pg_temp.o_same(split_part(pg_temp.o_order(v_ref), ' ', 3), '9999999999', 'the most');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 100000000, "currency": "dkk"}'),
		'22023 :amount is at most 99999999.99 DKK', 'more than the most');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 10000000000, "currency": "jpy"}'),
		'22023 :amount is at most 9999999999 JPY', 'more yen than the most');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1.234, "currency": "dkk"}'),
		'22023 :amount has at most 2 decimals in DKK', 'three decimals of DKK');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1.5, "currency": "jpy"}'),
		'22023 :amount has at most 0 decimals in JPY', 'part of a yen');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": -5, "currency": "dkk"}'),
		'22023 :amount is what was paid, as a number of DKK, 0 or more (as 249.95)', 'below 0');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": "1e3", "currency": "dkk"}'),
		'22023 :amount is what was paid, as a number of DKK, 0 or more (as 249.95)', 'an exponent');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": "249,95", "currency": "dkk"}'),
		'22023 :amount is what was paid, as a number of DKK, 0 or more (as 249.95)', 'a comma');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": true, "currency": "dkk"}'),
		'22023 :amount is what was paid, as a number of DKK, 0 or more (as 249.95)', 'true');
	-- Currencies.
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "DKR"}'),
		'22023 :currency DKR is no currency ISO 4217 knows', 'kroner as nobody writes them');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "xau"}'),
		'22023 :currency XAU is no currency ISO 4217 knows', 'gold is no money a shop takes');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "kr."}'),
		'22023 :currency is a currency''s three letters, as DKK', 'kr.');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": 208}'),
		'22023 :currency is a currency''s three letters, as DKK', 'a number');
	perform pg_temp.o_same(concat_ws(' ', public.qorpera_order_currency_known('SEK'),
		public.qorpera_order_currency_known('nok'), public.qorpera_order_currency_known('usd'),
		public.qorpera_order_currency_known('xxx'), public.qorpera_order_currency_known('chw')), 't t t f f',
		'the list');
	-- States.
	perform pg_temp.o_same(pg_temp.c_add('{"at": "@day", "amount": 1, "currency": "dkk", "state": null}')
		#>> '{rows,0,1}', 'paid', 'a null state is paid');
	perform pg_temp.o_same(pg_temp.c_add('{"at": "@day", "amount": 1, "currency": "dkk", "state": "on_the_way"}')
		#>> '{rows,0,1}', 'on_the_way', 'on its way');
	perform pg_temp.o_same(pg_temp.c_add('{"at": "@day", "amount": 1, "currency": "dkk", "state": "packed"}')
		#>> '{rows,0,1}', 'packed', 'packed');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk", '
		'"state": "cancelled"}'), '22023 :state of an added order is paid, packed, on_the_way or delivered (cancel it '
		'afterwards with order-state)', 'not added cancelled');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk", '
		'"state": 3}'), '22023 :state of an added order is paid, packed, on_the_way or delivered (cancel it afterwards '
		'with order-state)', 'a state number');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk", '
		'"state": "failed"}'), '22023 :state of an added order is paid, packed, on_the_way or delivered (cancel it '
		'afterwards with order-state)', 'failed');
	-- What it takes.
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"amount": 1, "currency": "dkk"}'),
		'22023 The change takes :at', 'no at');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "currency": "dkk"}'),
		'22023 The change takes :amount', 'no amount');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1}'),
		'22023 The change takes :currency', 'no currency');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk", '
		'"test": true}'), '22023 The change takes no :test', 'only live');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk", '
		'"email": "karen.blixen@example.dk"}'), '22023 The change takes no :email', 'no buyer''s data');
	perform pg_temp.o_same((select count(*)::text from public.qorpera_orders where live is not true or hook_id is not null
		or source <> 'added'), '0', 'every added order live, without a hook');
end $$;

-- 7. At most 500 added orders a company in 24 hours; older ones and another company's do not count.
do $$
declare v_key bigint := hashtextextended('qorpera.order-add:92400000-0000-4000-8000-000000000010', 0);
begin
	perform pg_temp.o_clean();
	insert into public.qorpera_orders (profile_id, environment_id, source, live, ref_sha256, ordered_at, currency,
		amount_minor, state, state_at, state_by, made_at, changed_at)
	select '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'added', true,
		encode(extensions.digest('cap' || n, 'sha256'), 'hex'), clock_timestamp(), 'dkk', 100, 'paid', clock_timestamp(),
		'agent', clock_timestamp() - interval '23 hours 59 minutes', clock_timestamp()
	from generate_series(1, 499) as n;
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}'), 'ok',
		'the 500th');
	-- The add held its company's lock to the end of the transaction.
	perform pg_temp.o_same((select count(*)::text from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
		and classid = ((v_key >> 32) & 4294967295)::text::oid and objid = (v_key & 4294967295)::text::oid
		and objsubid = 1 and granted), '1', 'counted one add at a time');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}'),
		'54000 A company adds at most 500 orders in 24 hours: add the rest later', 'the 501st');
	perform pg_temp.o_same(left(pg_temp.o_state($s$select pg_temp.c_run('order-add',
		'{"at": "@day", "amount": 1, "currency": "dkk"}')$s$), 5), '54000', 'a run too');
	-- Another company adds its own.
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}',
		'12740000-0000-4000-8000-000000000006', '12740000-0000-4000-8000-000000000020'), 'ok', 'another company');
	-- One made over 24 hours ago no longer counts.
	update public.qorpera_orders set made_at = clock_timestamp() - interval '24 hours 1 minute'
	where ref_sha256 = encode(extensions.digest('cap1', 'sha256'), 'hex');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}'), 'ok',
		'a day later');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}'),
		'54000 A company adds at most 500 orders in 24 hours: add the rest later', 'full again');
	-- Stripe's orders never count.
	update public.qorpera_orders set source = 'stripe', state_by = 'stripe', hook_id = null
	where ref_sha256 = encode(extensions.digest('cap2', 'sha256'), 'hex');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}'), 'ok',
		'Stripe''s do not count');
end $$;

-- 8. Cancelling an added order counts it refunded in full (no Stripe refund will say so): the days move before and
--    after the upkeep. Moving it on leaves its money as it was.
do $$
declare v_at timestamptz := pg_temp.o_at(); v_ref text; v_range jsonb;
begin
	perform pg_temp.o_clean();
	v_range := jsonb_build_object('from', to_char(pg_temp.o_today(), 'YYYY-MM-DD'));
	v_ref := pg_temp.c_ref(jsonb_build_object('at', pg_temp.c_iso(v_at), 'amount', 300, 'currency', 'dkk'));
	perform pg_temp.o_same(pg_temp.c_mark(v_ref, 'packed'), '1 packed', 'an added order packed');
	perform pg_temp.o_same(pg_temp.o_order(v_ref), pg_temp.o_min(v_at) || ' dkk 30000 0 - packed/member',
		'its money as it was');
	perform public.qorpera_order_upkeep();
	perform pg_temp.o_json(pg_temp.c_rows('orders-days', v_range),
		jsonb_build_array(jsonb_build_array(to_char(pg_temp.o_today(), 'YYYY-MM-DD'), 1, 300.00, 0.00)), 'a day');
	perform pg_temp.o_same(pg_temp.c_mark(v_ref, 'cancelled'), '1 cancelled', 'cancelled');
	perform pg_temp.o_same(pg_temp.o_order(v_ref), pg_temp.o_min(v_at) || ' dkk 30000 30000 - cancelled/member',
		'refunded in full');
	perform pg_temp.o_json(pg_temp.c_rows('orders-days', v_range),
		jsonb_build_array(jsonb_build_array(to_char(pg_temp.o_today(), 'YYYY-MM-DD'), 1, 300.00, 300.00)),
		'its day, before the upkeep');
	perform public.qorpera_order_upkeep();
	perform pg_temp.o_json(pg_temp.c_rows('orders-days', v_range),
		jsonb_build_array(jsonb_build_array(to_char(pg_temp.o_today(), 'YYYY-MM-DD'), 1, 300.00, 300.00)),
		'its day, after');
	perform pg_temp.o_same((pg_temp.o_now() -> 'refunds_30d')::text, '300.00', 'refunds of 30 days');
end $$;

-- 9. to_pack's start is the first Stripe order the company marked (order-state feeds O1's rule); an added order never
--    moves it and, paid with no state of the company's, is to pack whenever it was made; the 90 days count any state of
--    the company's; a test order marked does not move the live start.
do $$
declare v_now timestamptz := pg_temp.o_at(); v_n integer; v_old text; v_ref text;
begin
	perform pg_temp.o_clean();
	foreach v_n in array array[40, 20, 10, 5, 0] loop
		perform pg_temp.c_paid('pi_P' || v_n, 1000, v_now - make_interval(days => v_n));
	end loop;
	v_old := pg_temp.c_ref(jsonb_build_object('at', pg_temp.c_iso(v_now - interval '60 days'), 'amount', 10,
		'currency', 'dkk'));
	perform pg_temp.o_same(coalesce((pg_temp.o_now() -> 'to_pack')::text, 'sql null'), 'null',
		'no state of the company''s yet');
	perform pg_temp.o_same(pg_temp.c_mark('pi_P10', 'packed'), '1 packed', 'the first Stripe order marked');
	-- P5 and P0 (P40 and P20 came before), and the added one of 60 days ago.
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '3', 'from the first marked Stripe order on');
	-- An added order of 30 days ago, delivered: no start.
	perform pg_temp.c_add(jsonb_build_object('at', pg_temp.c_iso(v_now - interval '30 days'), 'amount', 10,
		'currency', 'dkk', 'state', 'delivered'));
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '3', 'an added state is no start');
	-- The added one of 60 days ago packed: it leaves to_pack, and is no start either.
	perform pg_temp.o_same(pg_temp.c_mark(v_old, 'packed'), '1 packed', 'the added one packed');
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '2', 'an added order marked is no start');
	-- A test order of 50 days ago marked: the live start stays.
	perform pg_temp.c_paid('pi_PTest', 1000, v_now - interval '50 days', false);
	perform pg_temp.o_same(pg_temp.c_mark('pi_PTest', 'packed'), '1 packed', 'a test order marked');
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text || ' ' || (pg_temp.o_now('{"test": true}') -> 'to_pack')::text,
		'2 0', 'each mode its own start');
	-- An older Stripe order cancelled: the start moves back to it, so P20 is to pack.
	perform pg_temp.o_same(pg_temp.c_mark('pi_P40', 'cancelled'), '1 cancelled', 'P40 cancelled');
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '3', 'P20, P5, P0');
	perform pg_temp.o_same(pg_temp.c_mark('pi_P5', 'on_the_way'), '1 on_the_way', 'P5 on its way');
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text || ' ' || (pg_temp.o_now() -> 'on_the_way')::text, '2 1',
		'to pack, on its way');

	-- Only added orders: paid ones wait for a state of the company's in 90 days, then are to pack.
	perform pg_temp.o_clean();
	perform pg_temp.c_add(jsonb_build_object('at', pg_temp.c_iso(v_now - interval '100 days'), 'amount', 10,
		'currency', 'dkk'));
	v_ref := pg_temp.c_ref(jsonb_build_object('at', pg_temp.c_iso(v_now), 'amount', 10, 'currency', 'dkk'));
	perform pg_temp.o_same(coalesce((pg_temp.o_now() -> 'to_pack')::text, 'sql null'), 'null', 'added, never marked');
	perform pg_temp.c_add(jsonb_build_object('at', pg_temp.c_iso(v_now), 'amount', 10, 'currency', 'dkk',
		'state', 'delivered'));
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '2', 'a state of the company''s: both paid ones');
	perform pg_temp.o_same(pg_temp.c_mark(v_ref, 'delivered'), '1 delivered', 'one delivered');
	perform pg_temp.o_same((pg_temp.o_now() -> 'to_pack')::text, '1', 'one to pack');
end $$;

-- 10. The questions after adds: orders-now, orders-days and orders-months count added orders with Stripe's;
--     orders-sources splits them (both rows always, zeros included), per currency and mode, 400 days back at most;
--     orders-states counts them by state.
do $$
declare v_at timestamptz := pg_temp.o_at(); v_ref text; v_month text := to_char(pg_temp.o_today(), 'YYYY-MM');
	v jsonb; v_days jsonb;
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_json(pg_temp.o_ask('orders-sources') - 'asOf' - 'etag', '{"columns": ["source", "orders", "sales",
		"refunds"], "rows": [["stripe", 0, 0.00, 0.00], ["added", 0, 0.00, 0.00]], "more": false}', 'nothing yet');
	perform pg_temp.c_paid('pi_A1', 10000, v_at);
	-- A failed payment is no order (orders-states' failed only).
	perform pg_temp.o_send(pg_temp.o_event('evt_AF1', 'checkout.session.completed',
		pg_temp.o_session('cs_AF', 'pi_AF', 9999, v_at, 'dkk', true, 'unpaid')));
	perform pg_temp.o_send(pg_temp.o_event('evt_AF2', 'checkout.session.async_payment_failed',
		pg_temp.o_session('cs_AF', 'pi_AF', 9999, v_at, 'dkk', true, 'unpaid')));
	v_ref := pg_temp.c_ref(jsonb_build_object('at', pg_temp.c_iso(v_at), 'amount', 50, 'currency', 'dkk'));
	perform pg_temp.c_add(jsonb_build_object('at', pg_temp.c_iso(v_at), 'amount', '25.05', 'currency', 'DKK',
		'state', 'delivered'));
	perform pg_temp.c_add(jsonb_build_object('at', pg_temp.c_iso(v_at), 'amount', 19.99, 'currency', 'eur'));
	perform pg_temp.o_send(pg_temp.o_event('evt_A1r', 'charge.refunded', pg_temp.o_charge('pi_A1', 10000, 1000)));
	perform pg_temp.o_json(pg_temp.o_now() - 'last_order_at' - 'stripe', jsonb_build_object('orders_today', 3,
		'sales_today', 175.05, 'to_pack', 2, 'on_the_way', 0, 'refunds_30d', 10.00, 'disputes_open', 0),
		'orders-now (the delivered one is a state of the company''s: the two paid added ones to pack, any currency)');
	perform pg_temp.o_json(pg_temp.c_rows('orders-sources'), '[["stripe", 1, 100.00, 10.00], ["added", 2, 75.05, 0.00]]',
		'orders-sources');
	perform pg_temp.o_json(pg_temp.c_rows('orders-sources', '{"currency": "EUR"}'),
		'[["stripe", 0, 0.00, 0.00], ["added", 1, 19.99, 0.00]]', 'orders-sources in euros');
	perform pg_temp.o_json(pg_temp.c_rows('orders-sources', '{"test": true}'),
		'[["stripe", 0, 0.00, 0.00], ["added", 0, 0.00, 0.00]]', 'added orders are live');
	v_days := jsonb_build_array(jsonb_build_array(to_char(pg_temp.o_today(), 'YYYY-MM-DD'), 3, 175.05, 10.00));
	perform pg_temp.o_json(pg_temp.c_rows('orders-days', jsonb_build_object('from', to_char(pg_temp.o_today(), 'YYYY-MM-DD'))),
		v_days, 'orders-days, from the rows');
	perform public.qorpera_order_upkeep();
	perform pg_temp.o_json(pg_temp.c_rows('orders-days', jsonb_build_object('from', to_char(pg_temp.o_today(), 'YYYY-MM-DD'))),
		v_days, 'orders-days, from the days');
	perform pg_temp.o_json(pg_temp.c_rows('orders-months') -> 11, jsonb_build_array(v_month, 3, 175.05, 10.00),
		'orders-months');
	-- The added one cancelled: refunded in full; the Stripe one cancelled: Stripe's refund only.
	perform pg_temp.o_same(pg_temp.c_mark(v_ref, 'cancelled') || ' ' || pg_temp.c_mark('pi_A1', 'cancelled'),
		'1 cancelled 1 cancelled', 'both cancelled');
	perform pg_temp.o_json(pg_temp.c_rows('orders-sources'), '[["stripe", 1, 100.00, 10.00], ["added", 2, 75.05, 50.00]]',
		'orders-sources after');
	perform pg_temp.o_json(pg_temp.c_rows('orders-states'), '[["paid", 0, 0.00], ["packed", 0, 0.00], ["on_the_way", 0, '
		'0.00], ["delivered", 1, 25.05], ["cancelled", 2, 150.00], ["failed", 1, 99.99]]', 'orders-states');
	-- A range: the orders made then.
	perform pg_temp.o_json(pg_temp.c_rows('orders-sources', jsonb_build_object('from', to_char(pg_temp.o_today() - 9,
		'YYYY-MM-DD'), 'to', to_char(pg_temp.o_today() - 1, 'YYYY-MM-DD'))),
		'[["stripe", 0, 0.00, 0.00], ["added", 0, 0.00, 0.00]]', 'other days');
	v := pg_temp.o_ask('orders-sources');
	perform pg_temp.o_same((v ? 'etag' and v ? 'asOf' and v -> 'more' = 'false')::text, 'true', 'the answer''s shape');
	-- Bounds, as orders-states.
	perform pg_temp.o_same(pg_temp.o_refused('orders-sources', jsonb_build_object('from',
		to_char(pg_temp.o_today() - 400, 'YYYY-MM-DD'), 'to', to_char(pg_temp.o_today() - 300, 'YYYY-MM-DD'))),
		'22023 qorpera/orders-sources reaches 400 days back: :from is from ' || (pg_temp.o_today() - 399)::text,
		'400 days back');
	perform pg_temp.o_same(pg_temp.o_refused('orders-sources', jsonb_build_object('from',
		to_char(pg_temp.o_today() - 399, 'YYYY-MM-DD'))), 'ok', '399 days back');
	perform pg_temp.o_same(pg_temp.o_refused('orders-states', jsonb_build_object('from',
		to_char(pg_temp.o_today() - 400, 'YYYY-MM-DD'), 'to', to_char(pg_temp.o_today() - 300, 'YYYY-MM-DD'))),
		'22023 qorpera/orders-states reaches 400 days back: :from is from ' || (pg_temp.o_today() - 399)::text,
		'orders-states'' words stay');
	perform pg_temp.o_same(pg_temp.o_refused('orders-sources', '{"from": "2026-11-10", "to": "2026-11-09"}'),
		'22023 :from is after :to', 'from after to');
	perform pg_temp.o_same(pg_temp.o_refused('orders-sources', '{"site": "x"}'), '22023 The question takes no :site',
		'a parameter it does not take');
	-- A run asks it too.
	perform pg_temp.o_json(pg_temp.o_run('orders-sources') - 'asOf', pg_temp.o_ask('orders-sources') - 'asOf',
		'a run''s answer');
end $$;

-- 11. Rights: any member of the company (owner, admin, contributor, viewer: who may read may change) and a run of it;
--     never an outsider, another company's member or a run of another company; the read rule says no for both doors;
--     a change that is not there has the same words. The doors' own checks.
do $$
declare v_rule text := pg_get_functiondef('public.qorpera_company_numbers_orders_readable(uuid,uuid,jsonb)'::regprocedure);
	v_at timestamptz := pg_temp.o_at() - interval '1 hour'; v_ref text;
begin
	perform pg_temp.o_clean();
	perform pg_temp.c_paid('pi_W1', 1000, v_at);
	perform pg_temp.o_same(pg_temp.c_mark('pi_W1', 'packed', '{}', '92400000-0000-4000-8000-000000000003'), '1 packed',
		'a viewer');
	perform pg_temp.o_same(pg_temp.c_mark('pi_W1', 'on_the_way', '{}', '92400000-0000-4000-8000-000000000002'),
		'1 on_the_way', 'a contributor');
	perform pg_temp.o_same(pg_temp.c_mark('pi_W1', 'delivered', '{}', '92400000-0000-4000-8000-000000000004'),
		'1 delivered', 'an admin');
	v_ref := pg_temp.c_ref('{"at": "@day", "amount": 1, "currency": "dkk"}', '92400000-0000-4000-8000-000000000003');
	perform pg_temp.o_same(split_part(pg_temp.o_order(v_ref), ' ', 6), 'paid/member', 'a viewer adds');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}',
		'92400000-0000-4000-8000-000000000005'), '42501 Company numbers are unavailable', 'an outsider');
	perform pg_temp.o_same(pg_temp.c_mark('pi_W1', 'cancelled', '{}', '92400000-0000-4000-8000-000000000005'),
		'42501 Company numbers are unavailable', 'an outsider marks');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}',
		'12740000-0000-4000-8000-000000000006'), '42501 Company numbers are unavailable', 'another company''s member');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '{}', '92400000-0000-4000-8000-000000000001',
		'92400000-0000-4000-8000-0000000000ff'), '42501 Company numbers are unavailable', 'no such company');
	-- The run's door: a run of another company, a member's actor, a member's token.
	perform pg_temp.o_same(left(pg_temp.o_state($s$select pg_temp.c_run('order-add',
		'{"at": "@day", "amount": 1, "currency": "dkk"}', '12740000-0000-4000-8000-000000000020')$s$), 5), '42501',
		'a run changing another company''s orders');
	perform pg_temp.o_same(pg_temp.o_state($s$select public.qorpera_run_company_numbers_change(
		'92400000-0000-4000-8000-000000000020', '{"kind": "member", "userId": "92400000-0000-4000-8000-000000000001"}',
		'order-state', '{"order": "pi_W1", "state": "cancelled"}')$s$), '22023 Company numbers are for a run',
		'a member''s actor at the run''s door');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.o_same(pg_temp.o_state(format('select public.qorpera_run_company_numbers_change(%L, %L::jsonb, %L, %L)',
		'92400000-0000-4000-8000-000000000020', pg_temp.o_actor(), 'order-state', '{"order": "pi_W1", "state": "cancelled"}')),
		'42501 Folder core authority is required', 'a member''s token at the run''s door');
	perform pg_temp.base_claims('anon');
	perform pg_temp.o_same(pg_temp.o_state($s$select public.qorpera_member_company_numbers_change(
		'92400000-0000-4000-8000-000000000020', 'order-state', '{"order": "pi_W1", "state": "cancelled"}')$s$),
		'42501 Company numbers are unavailable', 'no token');
	perform pg_temp.base_claims('anon', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.o_same(pg_temp.o_state($s$select public.qorpera_member_company_numbers_change(
		'92400000-0000-4000-8000-000000000020', 'order-state', '{"order": "pi_W1", "state": "cancelled"}')$s$),
		'42501 Company numbers are unavailable', 'the anon role with a member''s id');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.o_same(pg_temp.o_state($s$select public.qorpera_member_company_numbers_change(
		'92400000-0000-4000-8000-000000000020', 'order-state', '{"order": "pi_W1", "state": "cancelled"}')$s$),
		'42501 Company numbers are unavailable', 'the service role at the member''s door');
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_W1'), ' ', 6), 'delivered/member', 'nothing changed it');
	-- Changes that are not there, names and parameters of the wrong shape.
	perform pg_temp.o_same(pg_temp.c_refused('order-delete', '{"order": "pi_W1"}'),
		'P0002 No change qorpera/order-delete that you may run', 'a change that is not there');
	perform pg_temp.o_same(pg_temp.c_refused('Order State'), '22023 Name a change as qorpera/<change>', 'a name');
	perform pg_temp.o_same(pg_temp.c_refused(repeat('a', 61)), '22023 Name a change as qorpera/<change>', 'too long');
	perform pg_temp.o_same(pg_temp.c_refused('order-state', '[]'), '22023 Parameters are named values', 'params');
	-- The read rule says no: the same words as a change that is not there, to members and runs alike.
	execute replace(v_rule, 'select p_environment_id is not null', 'select false and p_environment_id is not null');
	perform pg_temp.o_same(pg_temp.c_mark('pi_W1', 'cancelled'), 'P0002 No change qorpera/order-state that you may run',
		'the rule says no');
	perform pg_temp.o_same(pg_temp.c_run_mark('pi_W1', 'cancelled'), 'P0002 No change qorpera/order-state that you may run',
		'to a run too');
	perform pg_temp.o_same(pg_temp.c_refused('order-add', '{"at": "@day", "amount": 1, "currency": "dkk"}'),
		'P0002 No change qorpera/order-add that you may run', 'nor adds');
	execute v_rule;
	perform pg_temp.o_same(pg_temp.c_mark('pi_W1', 'cancelled'), '1 cancelled', 'the rule back');
	-- An actor of another kind never reaches a change.
	perform pg_temp.o_same(pg_temp.o_state($s$select public.qorpera_company_numbers_change(
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010', '{"kind": "platform"}',
		'order-state', '{"order": "pi_W1", "state": "cancelled"}')$s$), '42501 Company numbers are unavailable',
		'another kind of actor');
end $$;

-- 12. A run changes through the native host's entry point with its job's lease token; never another company's orders.
select set_config('qorpera_test.c_token', 'c1275-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.c_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
do $$
declare v_host jsonb;
begin
	perform pg_temp.o_clean();
	perform pg_temp.c_paid('pi_N1', 1000, pg_temp.o_at());
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
	v_host := public.qorpera_native_host_call((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid,
		current_setting('qorpera_test.c_token'), 'qorpera_run_company_numbers_change', jsonb_build_object(
			'p_environment_id', '92400000-0000-4000-8000-000000000020', 'p_actor', pg_temp.o_actor(),
			'p_change', 'order-state', 'p_params', '{"order": "pi_N1", "state": "packed"}'::jsonb));
	perform pg_temp.o_json(v_host - 'asOf', '{"changed": 1, "columns": ["state"], "rows": [["packed"]], "more": false}',
		'through the host');
	perform pg_temp.o_same(pg_temp.o_state(format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)',
		current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId', current_setting('qorpera_test.c_token'),
		'qorpera_run_company_numbers_change', jsonb_build_object('p_environment_id', '12740000-0000-4000-8000-000000000020',
			'p_actor', pg_temp.o_actor(), 'p_change', 'order-add',
			'p_params', pg_temp.c_days('{"at": "@day", "amount": 1, "currency": "dkk"}')))),
		'42501 native host call is refused', 'the host''s call for another company');
	perform set_config('request.path', '', true);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.o_same(split_part(pg_temp.o_order('pi_N1'), ' ', 6), 'packed/agent', 'an agent''s word');
	perform pg_temp.o_same((select count(*)::text from public.qorpera_orders
		where profile_id = '12740000-0000-4000-8000-000000000010'), '0', 'nothing for the other company');
end $$;

rollback;
