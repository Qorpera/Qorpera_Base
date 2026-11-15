-- 20260930777000: the company's own word on its orders, door `orders` (company views step 5, slice O2; the lane's
-- DESIGN-5-orders.md, shape C, "The narrow write (migration O2)" and §E). Slice O1 (20260930776000) keeps one
-- counts-only row a Stripe payment; what only the company knows, packed, on its way, delivered or cancelled, and the
-- orders that never went through Stripe (MobilePay, an invoice, a sale at a market), the company says here. The founder,
-- 15 November 2026: everyone in the company may see the shop's sales; agents may add orders outside Stripe by hand,
-- marked as added (at most 500 a day); a Stripe payment link on the site is the shop for now.
--
-- 1. qorpera_company_numbers_change(...): the one change dispatcher, internal, beside the questions' dispatcher. It
--    answers the data gateway's change shape {changed, columns, rows, more, asOf}: `changed` how many orders it wrote
--    (0 when the order already had that state), `columns` and `rows` what it gives back, `more` false. Who may change:
--    whoever may read the orders (qorpera_company_numbers_orders_readable: everyone in the company and any run of it),
--    except a viewer, a read-only member (the lead, 15 November 2026: everyone may see the sales, a viewer changes
--    none; 42501, as the platform's other writes refuse a viewer). Owners, admins and contributors may. Two changes:
--      order-state {order, state, test?}: `order` is Stripe's payment id (pi_...), a Checkout Session's id (cs_..., for
--        a session with no payment, as a free one; a paid one is named by its payment_intent) or the ref order-add
--        gave (add_...). It is hashed with the company's id as O1 keys its orders and matched; it is never kept. `state`
--        is packed, on_the_way, delivered or cancelled: forward only (paid, packed, on_the_way, delivered; a step may
--        be skipped), or to cancelled from any of them; a cancelled order takes no other state; the same state again
--        changes nothing (changed 0). Only a paid order takes a state: one still unpaid, one whose payment failed and
--        a refund or a dispute whose session never came are no orders (O1). Stripe's facts (amount, refunded, dispute)
--        are never touched, but cancelling an added order counts it refunded in full in the numbers, since no Stripe
--        refund will say so: it still counts as an order with its sales (in orders_today, the days, orders-sources),
--        and nothing deletes one. `test` true names a test-mode order, false a live one;
--        without it the order is found in either mode (Stripe's ids are unique across modes). Gives back `state`.
--      order-add {at, amount, currency, state?}: an order outside Stripe, kept as O1 keeps Stripe's (`source` added,
--        live, no hook), and a random ref (add_ and 32 hex) given back once, to name it in a later order-state: only
--        its hash is kept, so the caller keeps the ref. `at` is when it was ordered, a time with its zone or a day of
--        the company's (its first minute), within the last 399 days (the upkeep deletes order rows at 400, and an added
--        one must outlive the 24 hours its add is counted in and stay there to be cancelled) and not ahead of now (a
--        minute's leeway); `amount`
--        what was paid in the currency's major unit (a JSON number or its text, 0 or more, no more decimals than the
--        currency has in the answers, at most 9 999 999 999 minor units); `currency` an ISO 4217 code (three letters,
--        any case; funds and metals codes are not money a shop takes). `state` is paid (the default), packed,
--        on_the_way or delivered: a sale already handled is added as it stands. A company adds at most 500 orders in
--        24 hours (54000 beyond: a limit, not a bad value). Gives back `order`, `state`.
--    The state's setter is kept as a kind, `agent` or `member`, never a name; `state_at` is the change's time. A run
--    of an in-house worker with read access changes nothing (42501), as the folder core refuses its writes
--    (qorpera_folder_actor_resource_allowed, 20260928259230).
-- 2. qorpera_member_company_numbers_change(p_environment_id, p_change, p_params): a member of a folder-v2 company with
--    their own token through PostgREST (authenticated only), as qorpera_member_company_numbers asks. Anyone else: 42501.
-- 3. qorpera_run_company_numbers_change(p_environment_id, p_actor, p_change, p_params): a run through
--    qorpera_native_host_call (scope folder), resolved as qorpera_run_company_numbers resolves its read.
-- 4. The orders questions (O1's qorpera_company_numbers_orders and the dispatcher's list, patched by exact text):
--    * a sixth question, `qorpera/orders-sources` (currency, test, from, to as orders-states): source (stripe, added),
--      orders, sales, refunds, both rows always, for the orders made from `from` to `to`; the questions split Stripe's
--      orders from those added by hand this way (the days keep no source, so orders-days and orders-months answer
--      both together).
--    * to_pack's start is the first Stripe order the company gave a state of its own: an added order never moves it
--      (a sale entered weeks later, already delivered, is no sign that the company began marking Stripe's orders),
--      and an added order that is paid and has no state of the company's is to pack whenever it was made (the company
--      entered it itself). The 90-day rule stays: any state of the company's, Stripe's orders or added ones.
--    * orders-now's `stripe` is `live` for a Stripe order row, a verified secret or a verified delivery: an added order
--      no longer counts, so a hook that has verified nothing still says `waiting` in a shop that adds orders by hand.
-- Refusals are plain words: 22023 a parameter of the wrong kind or out of its bounds, or a state the order cannot take;
-- 42501 not a member or run of the company; P0002 a change that is not there or that the caller may not run (the same
-- words), and an order the company does not have or that is not paid. Errors the gateway words the same are worded as
-- it words them (`The change takes :order`, `The change takes no :x`, `Parameters are named values`).
--
-- Locks: order-state locks the one order row it changes (lock_timeout 3 s); O1's trigger then waits 100 ms and leaves
-- the fact to the upkeep, as for any lock. order-add takes a transaction lock per company for its daily count.
--
-- Every inserted text names this migration (20260930777000).

do $$
begin
	if to_regprocedure('public.qorpera_run_company_numbers_change(uuid,jsonb,text,jsonb)') is not null then
		raise exception '20260930777000 (order changes) is already applied'; end if;
	if to_regclass('public.qorpera_orders') is null
		or to_regprocedure('public.qorpera_company_numbers_orders(uuid,uuid,timestamptz,text,jsonb)') is null
		or to_regprocedure('public.qorpera_company_numbers_orders_readable(uuid,uuid,jsonb)') is null
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure),
			'20260930776000') = 0 then
		raise exception '20260930777000 (order changes) needs the orders (20260930776000)'; end if;
end $$;

set local lock_timeout = '3s';

-- 1. Indexes ----------------------------------------------------------------------------------------------------------

-- A company's added orders by when they were added: the daily count.
create index qorpera_orders_added on public.qorpera_orders(profile_id, made_at) where source = 'added';
-- to_pack's start: the Stripe orders the company gave a state of its own (O1's index, now for Stripe's orders only).
drop index public.qorpera_orders_marked;
create index qorpera_orders_marked on public.qorpera_orders(profile_id, environment_id, live, ordered_at)
	where state in ('packed', 'on_the_way', 'delivered', 'cancelled') and source = 'stripe';

-- 2. The changes ------------------------------------------------------------------------------------------------------

-- ISO 4217's codes of money (2025): funds codes (BOV, CHE, CHW, CLF, COU, MXV, USN, UYI, UYW), metals, XDR, XSU, XUA,
-- XTS and XXX are left out. ANG and XCG, SLL and SLE, ZWL and ZWG are both kept while either is in use.
create function public.qorpera_order_currency_known(p_currency text) returns boolean
language sql immutable set search_path = '' as $$
	-- 20260930777000
	select lower(p_currency) = any (array['aed', 'afn', 'all', 'amd', 'ang', 'aoa', 'ars', 'aud', 'awg', 'azn', 'bam',
		'bbd', 'bdt', 'bgn', 'bhd', 'bif', 'bmd', 'bnd', 'bob', 'brl', 'bsd', 'btn', 'bwp', 'byn', 'bzd', 'cad', 'cdf',
		'chf', 'clp', 'cny', 'cop', 'crc', 'cup', 'cve', 'czk', 'djf', 'dkk', 'dop', 'dzd', 'egp', 'ern', 'etb', 'eur',
		'fjd', 'fkp', 'gbp', 'gel', 'ghs', 'gip', 'gmd', 'gnf', 'gtq', 'gyd', 'hkd', 'hnl', 'htg', 'huf', 'idr', 'ils',
		'inr', 'iqd', 'irr', 'isk', 'jmd', 'jod', 'jpy', 'kes', 'kgs', 'khr', 'kmf', 'kpw', 'krw', 'kwd', 'kyd', 'kzt',
		'lak', 'lbp', 'lkr', 'lrd', 'lsl', 'lyd', 'mad', 'mdl', 'mga', 'mkd', 'mmk', 'mnt', 'mop', 'mru', 'mur', 'mvr',
		'mwk', 'mxn', 'myr', 'mzn', 'nad', 'ngn', 'nio', 'nok', 'npr', 'nzd', 'omr', 'pab', 'pen', 'pgk', 'php', 'pkr',
		'pln', 'pyg', 'qar', 'ron', 'rsd', 'rub', 'rwf', 'sar', 'sbd', 'scr', 'sdg', 'sek', 'sgd', 'shp', 'sle', 'sll',
		'sos', 'srd', 'ssp', 'stn', 'svc', 'syp', 'szl', 'thb', 'tjs', 'tmt', 'tnd', 'top', 'try', 'ttd', 'twd', 'tzs',
		'uah', 'ugx', 'usd', 'uyu', 'uzs', 'ved', 'ves', 'vnd', 'vuv', 'wst', 'xaf', 'xcd', 'xcg', 'xof', 'xpf', 'yer',
		'zar', 'zmw', 'zwg', 'zwl'])
$$;

-- A change of the company's orders, in the data gateway's change shape. Rights: the doors admit a member or a run of
-- the company; the orders' read rule decides the rest, and a viewer changes nothing. p_actor is the doors' actor: a
-- member's {kind: member, userId}, or a run's as qorpera_folder_read_actor resolves it (kind staff_agent).
create function public.qorpera_company_numbers_change(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_change text, p_params jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- 20260930777000
declare
	c_steps constant text[] := array['paid', 'packed', 'on_the_way', 'delivered'];
	v_params jsonb := coalesce(p_params, '{}'::jsonb);
	v_now timestamptz := clock_timestamp();
	v_zone text;
	v_takes text[];
	v_needs text[];
	v_key text;
	v_by text;
	v_live boolean;
	v_order public.qorpera_orders%rowtype;
	v_state text;
	v_text text;
	v_at timestamptz;
	v_currency text;
	v_decimals integer;
	v_amount numeric;
	v_minor bigint;
	v_ref text;
	v_changed integer;
	v_columns text[];
	v_rows jsonb;
begin
	if jsonb_typeof(v_params) is distinct from 'object' then
		raise exception 'Parameters are named values' using errcode = '22023'; end if;
	if p_change is null or char_length(p_change) > 60 or p_change !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
		raise exception 'Name a change as qorpera/<change>' using errcode = '22023'; end if;
	v_takes := case p_change
		when 'order-state' then array['order', 'state', 'test']
		when 'order-add' then array['at', 'amount', 'currency', 'state'] end;
	v_needs := case p_change
		when 'order-state' then array['order', 'state']
		when 'order-add' then array['at', 'amount', 'currency'] end;
	-- A change that is not there and one the caller may not run: the same words, as the gateway answers.
	if v_takes is null or not coalesce(
			public.qorpera_company_numbers_orders_readable(p_environment_id, p_profile_id, p_actor), false) then
		raise exception 'No change qorpera/% that you may run', p_change using errcode = 'P0002'; end if;
	v_by := case p_actor ->> 'kind' when 'member' then 'member' when 'staff_agent' then 'agent' end;
	if v_by is null then raise exception 'Company numbers are unavailable' using errcode = '42501'; end if;
	-- A viewer sees the sales and changes none.
	if v_by = 'member' and exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = (p_actor ->> 'userId')::uuid
				and member.role = 'viewer') then
		raise exception 'A viewer sees the orders but changes none' using errcode = '42501'; end if;
	-- An in-house worker with read access writes nothing, as the folder core says (20260928259230).
	if p_actor ->> 'sessionKind' = 'in_house' and p_actor ->> 'workerAccess' = 'read' then
		raise exception 'A worker with read access changes no orders' using errcode = '42501'; end if;
	for v_key in select k from jsonb_object_keys(v_params) k order by k loop
		if not v_key = any (v_takes) then
			raise exception 'The change takes no :%', left(v_key, 60) using errcode = '22023'; end if;
	end loop;
	foreach v_key in array v_needs loop
		if jsonb_typeof(v_params -> v_key) is null or jsonb_typeof(v_params -> v_key) = 'null' then
			raise exception 'The change takes :%', v_key using errcode = '22023'; end if;
	end loop;

	if p_change = 'order-state' then
		v_text := v_params ->> 'order';
		if jsonb_typeof(v_params -> 'order') <> 'string'
			or v_text !~ '^((pi|cs)_[A-Za-z0-9_]{1,250}|add_[0-9a-f]{32})$' then
			raise exception ':order is Stripe''s payment id (pi_...), a Checkout Session''s id (cs_...) or the ref order-add gave (add_...)'
				using errcode = '22023'; end if;
		v_state := v_params ->> 'state';
		if jsonb_typeof(v_params -> 'state') <> 'string'
			or v_state not in ('packed', 'on_the_way', 'delivered', 'cancelled') then
			raise exception ':state is packed, on_the_way, delivered or cancelled' using errcode = '22023'; end if;
		if v_params ? 'test' and jsonb_typeof(v_params -> 'test') <> 'null' then
			if v_params -> 'test' in ('true'::jsonb, '"true"'::jsonb) then v_live := false;
			elsif v_params -> 'test' in ('false'::jsonb, '"false"'::jsonb) then v_live := true;
			else raise exception ':test is true or false' using errcode = '22023'; end if;
		end if;
		-- The order, by its hash; the live one first should both modes hold the id.
		select o.* into v_order from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id
			and o.ref_sha256 = public.qorpera_order_ref_sha256(p_profile_id, v_text)
			and (v_live is null or o.live = v_live)
		order by o.live desc limit 1
		for update;
		if not found then
			raise exception 'No order of this company is named so (a paid Checkout Session is named by its payment_intent, pi_...)'
				using errcode = 'P0002'; end if;
		if v_order.state is null or v_order.state = 'failed' then
			raise exception 'The order named is not paid: only a paid order takes a state' using errcode = 'P0002'; end if;
		if v_order.state = v_state then
			v_changed := 0;
		elsif v_order.state = 'cancelled' then
			raise exception 'The order is cancelled: a cancelled order takes no other state' using errcode = '22023';
		elsif v_state <> 'cancelled' and array_position(c_steps, v_state) <= array_position(c_steps, v_order.state) then
			raise exception 'The order is % already: a state only moves forward (packed, on_the_way, delivered), or to cancelled',
				v_order.state using errcode = '22023';
		else
			update public.qorpera_orders set state = v_state, state_at = v_now, state_by = v_by,
				-- An added order cancelled: refunded in full in the numbers (no Stripe refund will say it).
				refunded_minor = case when v_state = 'cancelled' and source = 'added' then amount_minor
					else refunded_minor end,
				changed_at = v_now, rolled = false
			where id = v_order.id;
			v_changed := 1;
		end if;
		v_columns := array['state'];
		v_rows := jsonb_build_array(jsonb_build_array(v_state));
	else
		-- order-add. The currency first: the amount's decimals are the currency's in the answers.
		v_text := v_params ->> 'currency';
		if jsonb_typeof(v_params -> 'currency') <> 'string' or v_text !~ '^[A-Za-z]{3}$' then
			raise exception ':currency is a currency''s three letters, as DKK' using errcode = '22023'; end if;
		if not public.qorpera_order_currency_known(v_text) then
			raise exception ':currency % is no currency ISO 4217 knows', upper(v_text) using errcode = '22023'; end if;
		v_currency := lower(v_text);
		v_decimals := scale((public.qorpera_order_major(1, v_currency) #>> '{}')::numeric);
		v_text := v_params ->> 'amount';
		if jsonb_typeof(v_params -> 'amount') not in ('number', 'string') or v_text !~ '^[0-9]{1,15}(\.[0-9]{1,6})?$' then
			raise exception ':amount is what was paid, as a number of %, 0 or more (as 249.95)', upper(v_currency)
				using errcode = '22023'; end if;
		v_amount := v_text::numeric;
		if round(v_amount, v_decimals) <> v_amount then
			raise exception ':amount has at most % decimals in %', v_decimals, upper(v_currency) using errcode = '22023'; end if;
		if v_amount * power(10::numeric, v_decimals) > 9999999999 then
			raise exception ':amount is at most % %', round(9999999999 / power(10::numeric, v_decimals), v_decimals),
				upper(v_currency) using errcode = '22023'; end if;
		v_minor := (v_amount * power(10::numeric, v_decimals))::bigint;
		-- When: a time with its zone, or a day of the company's (its first minute).
		v_text := v_params ->> 'at';
		v_zone := public.qorpera_company_numbers_zone(p_profile_id);
		begin
			if jsonb_typeof(v_params -> 'at') <> 'string' then
				raise exception using errcode = '22023';
			elsif v_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
				if to_char(v_text::date, 'YYYY-MM-DD') <> v_text then raise exception using errcode = '22023'; end if;
				v_at := v_text::date::timestamp at time zone v_zone;
			elsif v_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
				v_at := v_text::timestamptz;
			else
				raise exception using errcode = '22023';
			end if;
		exception when others then
			raise exception ':at is when it was ordered: a time with its zone, as 2026-11-15T14:30Z or 2026-11-15T15:30+01:00, or a day as YYYY-MM-DD'
				using errcode = '22023';
		end;
		if v_at > v_now + interval '1 minute' then
			raise exception ':at is ahead of now: an order is added once it was made' using errcode = '22023'; end if;
		-- Order rows go 400 days after the order: an added one outlives its 24 hours in the daily count and can be
		-- cancelled for at least a day.
		if v_at < v_now - interval '399 days' then
			raise exception ':at is at most 399 days ago (order rows go at 400)' using errcode = '22023'; end if;
		v_state := coalesce(v_params ->> 'state', 'paid');
		if (v_params ? 'state' and jsonb_typeof(v_params -> 'state') not in ('string', 'null'))
			or v_state not in ('paid', 'packed', 'on_the_way', 'delivered') then
			raise exception ':state of an added order is paid, packed, on_the_way or delivered (cancel it afterwards with order-state)'
				using errcode = '22023'; end if;
		-- At most 500 a company in 24 hours, counted one add at a time.
		perform pg_advisory_xact_lock(hashtextextended('qorpera.order-add:' || p_profile_id::text, 0));
		if (select count(*) from public.qorpera_orders as o
				where o.profile_id = p_profile_id and o.source = 'added' and o.made_at > v_now - interval '24 hours') >= 500 then
			raise exception 'A company adds at most 500 orders in 24 hours: add the rest later' using errcode = '54000'; end if;
		v_ref := 'add_' || encode(extensions.gen_random_bytes(16), 'hex');
		insert into public.qorpera_orders (profile_id, environment_id, hook_id, source, live, ref_sha256, ordered_at,
			currency, amount_minor, refunded_minor, state, state_at, state_by, made_at, changed_at)
		values (p_profile_id, p_environment_id, null, 'added', true, public.qorpera_order_ref_sha256(p_profile_id, v_ref),
			date_trunc('second', v_at), v_currency, v_minor, 0, v_state, v_now, v_by, v_now, v_now);
		v_changed := 1;
		v_columns := array['order', 'state'];
		v_rows := jsonb_build_array(jsonb_build_array(v_ref, v_state));
	end if;

	return jsonb_build_object('changed', v_changed, 'columns', to_jsonb(v_columns), 'rows', v_rows, 'more', false,
		'asOf', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

-- 3. A member's change ------------------------------------------------------------------------------------------------

create function public.qorpera_member_company_numbers_change(p_environment_id uuid, p_change text,
	p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_profile uuid;
begin
	-- 20260930777000: a member of a folder-v2 company, as qorpera_member_company_numbers admits one.
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_environment_id is null then
		raise exception 'Company numbers are unavailable' using errcode = '42501'; end if;
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	if v_profile is null or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_profile and member.user_id = auth.uid()) then
		raise exception 'Company numbers are unavailable' using errcode = '42501'; end if;
	return public.qorpera_company_numbers_change(p_environment_id, v_profile,
		jsonb_build_object('kind', 'member', 'userId', auth.uid()), p_change, p_params);
end $$;

-- 4. A run's change ---------------------------------------------------------------------------------------------------

create function public.qorpera_run_company_numbers_change(p_environment_id uuid, p_actor jsonb, p_change text,
	p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_auth jsonb; v_profile uuid;
begin
	-- 20260930777000: the run as a read resolves it (its job leased, its requester a member, its agent active), as
	-- qorpera_run_company_numbers does.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Company numbers are for a run' using errcode = '22023'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth ->> 'kind' is distinct from 'staff_agent' or v_auth ->> 'runId' is null then
		raise exception 'Company numbers are for a run' using errcode = '22023'; end if;
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	return public.qorpera_company_numbers_change(p_environment_id, v_profile, v_auth, p_change, p_params);
end $$;

-- 5. Grants and the native host's list --------------------------------------------------------------------------------

revoke all on function public.qorpera_order_currency_known(text),
	public.qorpera_company_numbers_change(uuid, uuid, jsonb, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_member_company_numbers_change(uuid, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_company_numbers_change(uuid, text, jsonb) to authenticated;
revoke all on function public.qorpera_run_company_numbers_change(uuid, jsonb, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_run_company_numbers_change(uuid, jsonb, text, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_run_company_numbers_change', 'folder');

-- 6. The questions: orders-sources, and to_pack's start from Stripe's orders only -------------------------------------

-- Each anchor must be found exactly once, in the definition as 20260930776000 left it; the patched function is made
-- once all are replaced.
create function pg_temp.order_changes_patch(p_target regprocedure, p_pairs text[]) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_index integer;
begin
	if position('20260930777000' in v_definition) > 0 then
		raise exception '20260930777000 is already in %', p_target; end if;
	for v_index in 1 .. array_length(p_pairs, 1) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
				/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930777000 anchor is not found exactly once in %: %', p_target, left(p_pairs[v_index], 80);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.order_changes_patch('public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure,
	array[$old$	if p_question in ('orders-now', 'orders-hours', 'orders-days', 'orders-months', 'orders-states') then$old$,
	$new$	-- 20260930777000: orders-sources too.
	if p_question in ('orders-now', 'orders-hours', 'orders-days', 'orders-months', 'orders-states',
			'orders-sources') then$new$]);

select pg_temp.order_changes_patch('public.qorpera_company_numbers_orders(uuid,uuid,timestamptz,text,jsonb)'::regprocedure,
	array[
	$old$		when 'orders-states' then array['currency', 'test', 'from', 'to'] end;$old$,
	$new$		when 'orders-states' then array['currency', 'test', 'from', 'to']
		-- 20260930777000: Stripe's orders and those added by hand, apart.
		when 'orders-sources' then array['currency', 'test', 'from', 'to'] end;$new$,

	$old$	if p_question in ('orders-days', 'orders-states') then$old$,
	$new$	if p_question in ('orders-days', 'orders-states', 'orders-sources') then$new$,

	$old$		if p_question = 'orders-states' and v_from < v_today - 399 then
			raise exception 'qorpera/orders-states reaches 400 days back: :from is from %', v_today - 399$old$,
	$new$		if p_question in ('orders-states', 'orders-sources') and v_from < v_today - 399 then
			raise exception 'qorpera/% reaches 400 days back: :from is from %', p_question, v_today - 399$new$,

	$old$		-- to_pack starts at the first order of this mode the company gave a state of its own: what came before it was
		-- never marked and is not waiting to be packed.
		select min(o.ordered_at) into v_marked_since from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live
			and o.state in ('packed', 'on_the_way', 'delivered', 'cancelled');$old$,
	$new$		-- to_pack starts at the first Stripe order of this mode the company gave a state of its own: what came before
		-- it was never marked and is not waiting to be packed. An added order never moves it (20260930777000): the
		-- company entered it itself, so it is to pack while it is paid and has no state of the company's.
		select min(o.ordered_at) into v_marked_since from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live
			and o.state in ('packed', 'on_the_way', 'delivered', 'cancelled') and o.source = 'stripe';$new$,

	$old$			when exists (select 1 from public.qorpera_orders as o
					where o.profile_id = p_profile_id and o.environment_id = p_environment_id)$old$,
	$new$			-- 20260930777000: a Stripe order row; an added order says nothing of the hook.
			when exists (select 1 from public.qorpera_orders as o
					where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.source = 'stripe')$new$,

	$old$then count(*) filter (where o.state = 'paid' and o.ordered_at >= v_marked_since$old$,
	$new$then count(*) filter (where o.state = 'paid' and (o.source = 'added' or o.ordered_at >= v_marked_since)$new$,

	$old$	end case;

	return jsonb_build_object('columns', to_jsonb(v_columns)$old$,
	$new$	when 'orders-sources' then
		-- 20260930777000: orders, sales and refunds of Stripe's orders and of those added by hand, for the orders made
		-- from :from to :to (as orders-states, from the order rows).
		v_columns := array['source', 'orders', 'sales', 'refunds'];
		select jsonb_agg(jsonb_build_array(listed.source, coalesce(counted.orders, 0),
			public.qorpera_order_major(coalesce(counted.sales, 0), v_currency),
			public.qorpera_order_major(coalesce(counted.refunds, 0), v_currency)) order by listed.place)
		into v_rows
		from (values ('stripe', 1), ('added', 2)) as listed(source, place)
		left join (select o.source, count(*) as orders, sum(o.amount_minor) as sales,
				sum(least(o.refunded_minor, o.amount_minor)) as refunds
			from public.qorpera_orders as o
			where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live
				and o.state = any (c_orders) and o.currency = v_currency
				and o.ordered_at >= v_from::timestamp at time zone v_zone
				and o.ordered_at < (v_to + 1)::timestamp at time zone v_zone
			group by o.source) as counted on counted.source = listed.source;
	end case;

	return jsonb_build_object('columns', to_jsonb(v_columns)$new$]);

drop function pg_temp.order_changes_patch(regprocedure, text[]);

-- Both patched functions keep their grants (none) and carry every marker.
do $$
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure),
			'20260930777000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure),
			'20260930776000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_numbers_orders(uuid,uuid,timestamptz,text,jsonb)'::regprocedure),
			'20260930777000') = 0 then
		raise exception '20260930777000: a patched function lost a marker'; end if;
end $$;
