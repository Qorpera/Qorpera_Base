-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The platform's numbers of a company, door `money` (company views step 3, slice M1, 20260930767000) on 924's company
-- and its real native run of Alice's. A member asks qorpera_member_company_numbers with their own token, a run asks
-- qorpera_run_company_numbers through the native host's entry point; both answer in the data gateway's shape
-- {columns, rows, more, asOf, etag}, from the vault's bank summary. Checked here: the grants and the native host's
-- list; money-now in each state (no bank, waiting, current, paused, disconnected); money-balance's default 90 days, its
-- bounds and its refusals; money-expected, money-months and money-kinds (this month only, money in as one kind);
-- kroner rounded to øre; the etag (the same for the same answer, a member's and a run's alike, and new when the summary
-- changes); privacy (no name, transfer text, account number or item of the summary in any answer); rights (an
-- outsider, a member of another company, a member and a run that may not read bank/summary.json, a run asking another
-- company); the site questions answer since 20260930768000 (1266 checks them); unknown questions and bad parameters;
-- "today" in the company's own time zone, Copenhagen's while it has none or one the database does not know.

create function pg_temp.n_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.n_json(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.n_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.n_actor() returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId') from (select current_setting('qorpera_test.base_binding')::jsonb as b) s
$$;
-- A member's ask, as their token makes it; the claims are the service role's again afterwards.
create function pg_temp.n_member(p_user uuid, p_question text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_member_company_numbers(p_environment, p_question, p_params);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- The same ask's refusal (or 'ok').
create function pg_temp.n_refused(p_user uuid, p_question text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns text language plpgsql as $$
declare v text;
begin
	v := pg_temp.n_state(format('select pg_temp.n_member(%L, %L, %L::jsonb, %L)', p_user, p_question, p_params,
		p_environment));
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- A run's ask as the native host's dispatch makes it (the service role).
create function pg_temp.n_run(p_question text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_run_company_numbers(p_environment, pg_temp.n_actor(), p_question, p_params);
end $$;
create function pg_temp.n_rows(p_answer jsonb) returns jsonb language sql as $$ select p_answer -> 'rows' $$;
create function pg_temp.n_today() returns date language sql as $$
	select (clock_timestamp() at time zone 'Europe/Copenhagen')::date
$$;
create function pg_temp.n_day(p_offset integer) returns text language sql as $$
	select to_char(pg_temp.n_today() + p_offset, 'YYYY-MM-DD')
$$;
create function pg_temp.n_month() returns text language sql as $$ select to_char(pg_temp.n_today(), 'YYYY-MM') $$;
-- A day in another zone.
create function pg_temp.n_zone_day(p_zone text, p_offset integer) returns text language sql as $$
	select to_char((clock_timestamp() at time zone p_zone)::date + p_offset, 'YYYY-MM-DD')
$$;
-- A summary as the vault's reduce makes it, with names, an account, transfer words and items that must never show.
-- history: 400 days to today, the saldo of day today-i being 1000 + i (and 0.004 more, rounded away).
create function pg_temp.n_summary(p_saldo numeric default 12345.678, p_paused text default null) returns jsonb
language sql as $$
	select jsonb_build_object('schema', 'qorpera.bank-summary/v1', 'bank', 'Danske Bank',
		'updatedAt', '2026-11-14T08:00:00.000Z', 'pausedSince', p_paused,
		'saldo', p_saldo, 'disponibel', 12000.5, 'reserveret', 345.18,
		'payTo', jsonb_build_object('reg', '7531', 'account', '99887766'),
		'history', (select jsonb_agg(jsonb_build_object('date', pg_temp.n_day(-i), 'saldo', 1000 + i + 0.004) order by i desc)
			from generate_series(0, 399) i),
		'expected', jsonb_build_array(jsonb_build_object('date', pg_temp.n_day(14), 'saldo', 800),
			jsonb_build_object('date', pg_temp.n_day(7), 'saldo', 900.1)),
		'months', jsonb_build_array(
			jsonb_build_object('month', to_char(pg_temp.n_today() - interval '1 month', 'YYYY-MM'), 'in', 5000,
				'out', 3000.255),
			jsonb_build_object('month', pg_temp.n_month(), 'in', 1500, 'out', 2500)),
		'moneyIn', jsonb_build_object('month', pg_temp.n_month(), 'categories', jsonb_build_array(
			jsonb_build_object('name', 'Hansen Kaffe ApS', 'total', 1000, 'items', jsonb_build_array(jsonb_build_object(
				'name', 'Hansen Kaffe ApS', 'rhythm', 'monthly', 'next', null, 'amount', 1000))),
			jsonb_build_object('name', 'Jens Jensen', 'total', 500, 'items', jsonb_build_array(jsonb_build_object(
				'name', 'Jens Jensen faktura 1187', 'rhythm', 'once', 'next', null, 'amount', 500))))),
		'moneyOut', jsonb_build_object('month', pg_temp.n_month(), 'repeating', 2000, 'categories', jsonb_build_array(
			jsonb_build_object('name', 'Salaries', 'total', 1500, 'items', jsonb_build_array(jsonb_build_object(
				'name', 'Mette Madsen', 'rhythm', 'monthly', 'next', null, 'amount', 1500))),
			jsonb_build_object('name', 'Rent', 'total', 600, 'items', jsonb_build_array(jsonb_build_object(
				'name', 'Ejendomsselskabet Nord', 'rhythm', 'monthly', 'next', null, 'amount', 600))),
			jsonb_build_object('name', 'Other', 'total', 250.5, 'items', jsonb_build_array(jsonb_build_object(
				'name', 'Secret Supplier', 'rhythm', 'once', 'next', null, 'amount', 250.5))),
			jsonb_build_object('name', 'Card and app fees', 'total', 149.5, 'items', jsonb_build_array(jsonb_build_object(
				'name', 'Stripe Payments Europe', 'rhythm', 'monthly', 'next', null, 'amount', 149.5)))),
			'later', jsonb_build_array(jsonb_build_object('name', 'Skattestyrelsen Moms', 'date', pg_temp.n_day(30),
				'amount', 9999))))
$$;
-- The vault records a summary, as qorpera_finish_bank_sync does.
create function pg_temp.n_record(p_profile uuid, p_summary jsonb, p_status text default 'current') returns void
language sql as $$
	update public.qorpera_bank_syncs
	set summary = p_summary, summary_generation = summary_generation + 1, summary_at = clock_timestamp(),
		status = p_status, due_at = case when p_status in ('ended', 'disconnected') then null
			else clock_timestamp() + interval '6 hours' end
	where profile_id = p_profile
$$;

-- Another company, with its own member and its own bank, and a user who is a member of neither.
insert into auth.users(id, email) values
	('12650000-0000-4000-8000-000000000006', 'numbers-other@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12650000-0000-4000-8000-000000000010', 'Numbers other', '12650000-0000-4000-8000-000000000006');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12650000-0000-4000-8000-000000000010', '12650000-0000-4000-8000-000000000006', 'numbers-other@example.test',
		'Other owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12650000-0000-4000-8000-000000000020', '12650000-0000-4000-8000-000000000010', 'Environment', 1,
	'12650000-0000-4000-8000-000000000006');
select pg_temp.base_claims('service_role');
select public.qorpera_folder_enable('12650000-0000-4000-8000-000000000020') \g /dev/null
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('92400000-0000-4000-8000-0000000000d1', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test', 'key-1',
		repeat('6', 64)),
	('12650000-0000-4000-8000-0000000000d1', '12650000-0000-4000-8000-000000000010', 'https://broker.example.test', 'key-2',
		repeat('7', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
	secret_name, purpose, current_version, created_by_user_id, account_label)
values ('12650000-0000-4000-8000-0000000000b2', '12650000-0000-4000-8000-000000000010',
	'12650000-0000-4000-8000-000000000020', '12650000-0000-4000-8000-0000000000d1', 'company', 'bank', 'primary',
	'Company bank', 1, '12650000-0000-4000-8000-000000000006', '••1111');
select pg_temp.n_record('12650000-0000-4000-8000-000000000010', pg_temp.n_summary(777));
-- A booked transaction with a name and a text in the vault's own table: never read here.
insert into public.qorpera_bank_transactions(profile_id, account_key, transaction_key, booked_on, amount, currency,
	counterparty, remittance)
values ('92400000-0000-4000-8000-000000000010', repeat('a', 64), repeat('b', 64), pg_temp.n_today(), -42.5, 'DKK',
	'Karen Kristensen', 'Tak for kaffen');

-- 1. The grants: a member asks with their token only, a run through the service role only, the dispatcher and its
--    helpers by nobody. The native host lists the run's ask with scope folder.
do $$
declare v_function text;
begin
	if has_function_privilege('anon', 'public.qorpera_member_company_numbers(uuid,text,jsonb)', 'EXECUTE')
		or not has_function_privilege('authenticated', 'public.qorpera_member_company_numbers(uuid,text,jsonb)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_member_company_numbers(uuid,text,jsonb)', 'EXECUTE') then
		raise exception 'qorpera_member_company_numbers has the wrong grants'; end if;
	if has_function_privilege('anon', 'public.qorpera_run_company_numbers(uuid,jsonb,text,jsonb)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_run_company_numbers(uuid,jsonb,text,jsonb)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_run_company_numbers(uuid,jsonb,text,jsonb)', 'EXECUTE') then
		raise exception 'qorpera_run_company_numbers has the wrong grants'; end if;
	foreach v_function in array array['public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)',
		'public.qorpera_company_numbers_kroner(jsonb)', 'public.qorpera_company_numbers_day(jsonb,text)',
		'public.qorpera_company_numbers_kinds_month(date,text)', 'public.qorpera_company_numbers_balance_end(date,text)'] loop
		if has_function_privilege('anon', v_function, 'EXECUTE') or has_function_privilege('authenticated', v_function, 'EXECUTE')
			or has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% is open to an API role', v_function; end if;
	end loop;
	perform pg_temp.n_same((select scope || ' ' || budget from public.qorpera_native_host_calls
		where name = 'qorpera_run_company_numbers'), 'folder standard', 'the native host''s list');
end $$;

do $$
declare v_question text;
begin
	foreach v_question in array array['money-now', 'money-balance', 'money-expected', 'money-months', 'money-kinds'] loop
		perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000001', v_question),
			'55000 Not connected: the bank''s numbers come once the company connects its bank', 'no bank: ' || v_question);
	end loop;
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000001', 'money-balance', '{"since":"2026-11-01"}'),
		'22023 The question takes no :since', 'no bank, a parameter it does not take');
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000001', 'money-balance', '{"from":"2026-02-31"}'),
		'22023 :from is a day as YYYY-MM-DD', 'no bank, a bad day');
end $$;

-- 3. A bank connected (the trigger makes the sync): waiting until the vault records a summary.
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
	secret_name, purpose, current_version, created_by_user_id, account_label)
values ('92400000-0000-4000-8000-0000000000b1', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-0000000000d1', 'company', 'bank', 'primary',
	'Company bank', 1, '92400000-0000-4000-8000-000000000001', '••6243');
do $$
declare v jsonb := pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-now');
begin
	perform pg_temp.n_same((select string_agg(k, ',' order by k) from jsonb_object_keys(v) k), 'asOf,columns,etag,more,rows',
		'the answer''s keys');
	perform pg_temp.n_json(v -> 'columns', '["state","bank","balance","available","reserved","as_of","paused_since"]',
		'money-now''s columns');
	perform pg_temp.n_json(v -> 'rows', '[["waiting",null,null,null,null,null,null]]', 'waiting');
	perform pg_temp.n_same(v ->> 'more', 'false', 'more');
	perform pg_temp.n_same(((v ->> 'etag') ~ '^[0-9a-f]{32}$')::text, 'true', 'the etag');
	perform pg_temp.n_same((abs(extract(epoch from (v ->> 'asOf')::timestamptz - clock_timestamp())) < 60)::text, 'true',
		'asOf is now');
	perform pg_temp.n_same((v ->> 'asOf' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')::text, 'true',
		'asOf in ISO, UTC');
	perform pg_temp.n_json(pg_temp.n_rows(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-months')), '[]',
		'waiting, no months');
	perform pg_temp.n_json(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-balance') -> 'rows', '[]',
		'waiting, no balance');
	perform pg_temp.n_json(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-kinds') -> 'columns',
		'["direction","kind","amount","count"]', 'money-kinds''s columns');
	perform pg_temp.n_json(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-kinds') -> 'rows', '[]',
		'waiting, no kinds');
end $$;
select pg_temp.n_record('92400000-0000-4000-8000-000000000010', pg_temp.n_summary());

-- 4. Current: money-now in kroner rounded to øre, by every member (viewers too).
do $$
declare v_user uuid; v_first jsonb; v jsonb;
begin
	v_first := pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-now');
	perform pg_temp.n_json(v_first -> 'rows',
		'[["current","Danske Bank",12345.68,12000.50,345.18,"2026-11-14T08:00:00.000Z",null]]', 'current');
	perform pg_temp.n_same(v_first #>> '{rows,0,2}', '12345.68', 'the balance to øre');
	foreach v_user in array array['92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000004']::uuid[] loop
		v := pg_temp.n_member(v_user, 'money-now');
		perform pg_temp.n_json(v - 'asOf', v_first - 'asOf', 'every member gets the same answer: ' || v_user);
	end loop;
end $$;

-- 5. money-balance: by default the 90 days to today; a range; at most 366 days; its refusals.
do $$
declare v jsonb; o constant uuid := '92400000-0000-4000-8000-000000000001';
begin
	v := pg_temp.n_member(o, 'money-balance');
	perform pg_temp.n_json(v -> 'columns', '["day","balance"]', 'money-balance''s columns');
	perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text, '90', 'the default 90 days');
	perform pg_temp.n_json(v #> '{rows,0}', jsonb_build_array(pg_temp.n_day(-89), 1089.00), 'the first of the 90 days');
	perform pg_temp.n_json(v #> '{rows,89}', jsonb_build_array(pg_temp.n_day(0), 1000.00), 'today');
	v := pg_temp.n_member(o, 'money-balance', jsonb_build_object('from', pg_temp.n_day(-12), 'to', pg_temp.n_day(-10)));
	perform pg_temp.n_json(v -> 'rows', jsonb_build_array(jsonb_build_array(pg_temp.n_day(-12), 1012.00),
		jsonb_build_array(pg_temp.n_day(-11), 1011.00), jsonb_build_array(pg_temp.n_day(-10), 1010.00)), 'a range');
	v := pg_temp.n_member(o, 'money-balance', jsonb_build_object('from', pg_temp.n_day(-365), 'to', pg_temp.n_day(0)));
	perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text, '366', '366 days');
	-- From a :from alone: at most its 366 days, to today.
	v := pg_temp.n_member(o, 'money-balance', jsonb_build_object('from', pg_temp.n_day(-5)));
	perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text, '6', 'from a :from to today');
	v := pg_temp.n_member(o, 'money-balance', jsonb_build_object('from', pg_temp.n_day(-399), 'to', null));
	perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text || ' ' || (v #>> '{rows,365,0}'),
		'366 ' || pg_temp.n_day(-34), 'a :from long ago: its 366 days');
	-- A :to alone: the 90 days to it.
	v := pg_temp.n_member(o, 'money-balance', jsonb_build_object('to', pg_temp.n_day(-100)));
	perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text || ' ' || (v #>> '{rows,0,0}'),
		'90 ' || pg_temp.n_day(-189), 'the 90 days to a :to');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-balance',
		jsonb_build_object('from', pg_temp.n_day(-366), 'to', pg_temp.n_day(0))),
		'22023 From :from to :to is at most 366 days', '367 days');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-balance',
		jsonb_build_object('from', pg_temp.n_day(-1), 'to', pg_temp.n_day(-2))), '22023 :from is after :to', 'backwards');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-balance', '{"from":"2026-02-31"}'),
		'22023 :from is a day as YYYY-MM-DD', 'a day the calendar lacks');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-balance', '{"to":"14-11-2026"}'),
		'22023 :to is a day as YYYY-MM-DD', 'another shape');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-balance', '{"from":20261101}'),
		'22023 :from is a day as YYYY-MM-DD', 'a number');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-balance', '{"since":"2026-11-01"}'),
		'22023 The question takes no :since', 'a parameter it does not take');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-now', '{"from":"2026-11-01"}'),
		'22023 The question takes no :from', 'money-now takes none');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-now', '[]'), '22023 Parameters are named values', 'not an object');
	perform pg_temp.n_json(pg_temp.n_member(o, 'money-now', null) -> 'rows', pg_temp.n_member(o, 'money-now') -> 'rows',
		'no parameters at all');
end $$;

-- 6. money-expected, money-months, money-kinds.
do $$
declare v jsonb; o constant uuid := '92400000-0000-4000-8000-000000000001';
begin
	perform pg_temp.n_json(pg_temp.n_rows(pg_temp.n_member(o, 'money-expected')), jsonb_build_array(
		jsonb_build_array(pg_temp.n_day(7), 900.10), jsonb_build_array(pg_temp.n_day(14), 800.00)), 'the forecast, by day');
	v := pg_temp.n_member(o, 'money-months');
	perform pg_temp.n_json(v -> 'columns', '["month","money_in","money_out"]', 'money-months''s columns');
	perform pg_temp.n_json(v -> 'rows', jsonb_build_array(
		jsonb_build_array(to_char(pg_temp.n_today() - interval '1 month', 'YYYY-MM'), 5000.00, 3000.26),
		jsonb_build_array(pg_temp.n_month(), 1500.00, 2500.00)), 'the months');
	-- Money in as one kind; money out by the vault's kinds in their fixed order; no count yet.
	v := pg_temp.n_member(o, 'money-kinds');
	perform pg_temp.n_json(v -> 'rows', '[["in","all",1500,null],["out","salaries",1500,null],["out","rent",600,null],
		["out","fees",149.5,null],["out","other",250.5,null]]', 'the kinds');
	perform pg_temp.n_json(pg_temp.n_member(o, 'money-kinds', jsonb_build_object('month', pg_temp.n_month())) -> 'rows',
		v -> 'rows', 'this month named');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds',
		jsonb_build_object('month', to_char(pg_temp.n_today() - interval '1 month', 'YYYY-MM'))),
		format('22023 qorpera/money-kinds answers this month only (%s), for now', pg_temp.n_month()), 'last month');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds', '{"month":"2026-13"}'), '22023 :month is a month as YYYY-MM',
		'a month the calendar lacks');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds', '{"from":"2026-11-01"}'),
		'22023 The question takes no :from', 'M2''s range is not here yet');
end $$;

-- 7. Privacy: no answer holds a name, a transfer's words, the account to pay to, an item or the vault's transactions.
do $$
declare v_question text; v_text text := '';
begin
	foreach v_question in array array['money-now', 'money-balance', 'money-expected', 'money-months', 'money-kinds'] loop
		-- Without the etag and the time, whose hex and digits could hold a number by chance.
		v_text := v_text || (pg_temp.n_member('92400000-0000-4000-8000-000000000001', v_question) - 'etag' - 'asOf')::text
			|| (pg_temp.n_run(v_question) - 'etag' - 'asOf')::text;
	end loop;
	v_text := v_text || (pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-balance',
		jsonb_build_object('from', pg_temp.n_day(-365))) - 'etag' - 'asOf')::text;
	perform pg_temp.n_same((select string_agg(word, ',') from unnest(array['Hansen', 'Jens', 'faktura', 'Mette',
		'Ejendomsselskabet', 'Secret', 'Stripe', 'Skattestyrelsen', 'Karen', 'kaffen', '7531', '99887766', 'payTo', 'items',
		'monthly', 'repeating', 'later', 'Rent', 'Salaries']) word where strpos(v_text, word) > 0), null,
		'words of the summary that leak');
end $$;

-- 8. The etag: the same for the same answer (and a run's equals a member's), new when the summary changes.
do $$
declare v_before jsonb := pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-now'); v_after jsonb;
begin
	perform pg_temp.n_same(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-now') ->> 'etag',
		v_before ->> 'etag', 'the same answer, the same etag');
	perform pg_temp.n_same(pg_temp.n_run('money-now') ->> 'etag', v_before ->> 'etag', 'a run''s answer, the same etag');
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', pg_temp.n_summary(20000));
	v_after := pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-now');
	perform pg_temp.n_json(v_after #> '{rows,0,2}', '20000', 'the new balance');
	perform pg_temp.n_same((v_after ->> 'etag' <> v_before ->> 'etag')::text, 'true', 'a new answer, a new etag');
end $$;

-- 9. Paused (the bank stopped sharing, or its consent ended), then none once the bank is disconnected.
savepoint n_states;
do $$
begin
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', pg_temp.n_summary(500, pg_temp.n_day(-3)));
	perform pg_temp.n_json(pg_temp.n_rows(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-now')),
		jsonb_build_array(jsonb_build_array('paused', 'Danske Bank', 500.00, 12000.50, 345.18, '2026-11-14T08:00:00.000Z',
			pg_temp.n_day(-3))), 'paused since');
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', pg_temp.n_summary(500), 'ended');
	perform pg_temp.n_same(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-now') #>> '{rows,0,0}', 'paused',
		'the consent ended');
	perform pg_temp.n_same(jsonb_array_length(pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-balance')
		-> 'rows')::text, '90', 'a paused bank''s curve');
	update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(),
		revoked_by_user_id = '92400000-0000-4000-8000-000000000001'
	where id = '92400000-0000-4000-8000-0000000000b1';
	perform pg_temp.n_same((select status from public.qorpera_bank_syncs
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'disconnected', 'the sync follows the disconnect');
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000001', 'money-now'),
		'55000 Not connected: the bank''s numbers come once the company connects its bank', 'disconnected');
	perform pg_temp.n_same(pg_temp.n_state($s$select pg_temp.n_run('money-kinds')$s$),
		'55000 Not connected: the bank''s numbers come once the company connects its bank', 'disconnected, to a run');
end $$;
rollback to savepoint n_states;
select pg_temp.base_claims('service_role');

-- 10. Rights. An outsider, a member of another company and a caller without a member's token get nothing; the other
--     company's member gets their own company's numbers.
do $$
declare v_role text;
begin
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000005', 'money-now'),
		'42501 Company numbers are unavailable', 'an outsider');
	perform pg_temp.n_same(pg_temp.n_refused('12650000-0000-4000-8000-000000000006', 'money-now'),
		'42501 Company numbers are unavailable', 'a member of another company');
	perform pg_temp.n_json(pg_temp.n_member('12650000-0000-4000-8000-000000000006', 'money-now', '{}',
		'12650000-0000-4000-8000-000000000020') #> '{rows,0,2}', '777', 'that member''s own company');
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000001', 'money-now', '{}',
		'12650000-0000-4000-8000-000000000020'), '42501 Company numbers are unavailable', 'the owner, in another company');
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000001', 'money-now', '{}',
		'12650000-0000-4000-8000-0000000000ff'), '42501 Company numbers are unavailable', 'no such company');
	foreach v_role in array array['anon', 'service_role'] loop
		perform pg_temp.base_claims(v_role);
		perform pg_temp.n_same(pg_temp.n_state($s$select public.qorpera_member_company_numbers(
			'92400000-0000-4000-8000-000000000020', 'money-now', '{}')$s$), '42501 Company numbers are unavailable',
			'the member''s ask as ' || v_role);
	end loop;
	perform pg_temp.base_claims('service_role');
end $$;

-- 11. bank/ private to the contributor: they still read the numbers; the owner, and the run the owner asked for, get
--     the same words as for a question that is not there.
savepoint n_private;
insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
	created_by_user_id)
values ('92400000-0000-4000-8000-000000000020', 'bank', 'subtree', 'member_private',
	'92400000-0000-4000-8000-000000000002', 'normal', '92400000-0000-4000-8000-000000000001');
do $$
begin
	perform pg_temp.n_same(pg_temp.n_member('92400000-0000-4000-8000-000000000002', 'money-now') #>> '{rows,0,0}', 'current',
		'the member bank/ is private to');
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000001', 'money-now'),
		'P0002 No question qorpera/money-now that you may read', 'a member without bank read');
	perform pg_temp.n_same(pg_temp.n_refused('92400000-0000-4000-8000-000000000003', 'money-kinds'),
		'P0002 No question qorpera/money-kinds that you may read', 'a viewer without bank read');
	perform pg_temp.n_same(pg_temp.n_state($s$select pg_temp.n_run('money-now')$s$),
		'P0002 No question qorpera/money-now that you may read', 'a run without bank read');
end $$;
rollback to savepoint n_private;
select pg_temp.base_claims('service_role');

-- 12. A run asks through the native host's entry point with its job's lease token, and gets what its requester's
--     member ask gets; it may not ask another company's numbers, there or directly, nor as a member or the platform.
select set_config('qorpera_test.n_token', 'n1265-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.n_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
do $$
declare v_host jsonb; v_member jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
	v_host := public.qorpera_native_host_call((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid,
		current_setting('qorpera_test.n_token'), 'qorpera_run_company_numbers', jsonb_build_object(
			'p_environment_id', '92400000-0000-4000-8000-000000000020', 'p_actor', pg_temp.n_actor(),
			'p_question', 'money-balance', 'p_params', jsonb_build_object('from', pg_temp.n_day(-2))));
	perform pg_temp.n_same(pg_temp.n_state(format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)',
		current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId', current_setting('qorpera_test.n_token'),
		'qorpera_run_company_numbers', jsonb_build_object('p_environment_id', '12650000-0000-4000-8000-000000000020',
			'p_actor', pg_temp.n_actor(), 'p_question', 'money-now'))),
		'42501 native host call is refused', 'the host''s call for another company');
	perform set_config('request.path', '', true);
	v_member := pg_temp.n_member('92400000-0000-4000-8000-000000000001', 'money-balance',
		jsonb_build_object('from', pg_temp.n_day(-2)));
	perform pg_temp.n_json(v_host - 'asOf', v_member - 'asOf', 'the run''s answer is its requester''s');
	perform pg_temp.n_same(jsonb_array_length(v_host -> 'rows')::text, '3', 'three days');
	perform pg_temp.base_claims('service_role');
	-- Directly, as the service role: another company, a member's actor, the platform, a member's token.
	perform pg_temp.n_same(left(pg_temp.n_state($s$select pg_temp.n_run('money-now', '{}',
		'12650000-0000-4000-8000-000000000020')$s$), 5), '42501', 'a run asking another company''s numbers');
	perform pg_temp.n_same(pg_temp.n_state($s$select public.qorpera_run_company_numbers(
		'92400000-0000-4000-8000-000000000020', '{"kind":"member","userId":"92400000-0000-4000-8000-000000000001"}',
		'money-now')$s$), '22023 Company numbers are for a run', 'a member''s actor');
	perform pg_temp.n_same(pg_temp.n_state($s$select public.qorpera_run_company_numbers(
		'92400000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'money-now')$s$),
		'22023 Company numbers are for a run', 'the platform');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.n_same(pg_temp.n_state(format('select public.qorpera_run_company_numbers(%L, %L::jsonb, %L)',
		'92400000-0000-4000-8000-000000000020', pg_temp.n_actor(), 'money-now')), '42501 Folder core authority is required',
		'a member''s token');
	perform pg_temp.base_claims('service_role');
end $$;

do $$
declare v_question text; o constant uuid := '92400000-0000-4000-8000-000000000001';
begin
	perform pg_temp.n_same(pg_temp.n_refused(o, 'sites'), 'ok', 'sites');
	foreach v_question in array array['site-now', 'site-hours', 'site-days', 'site-pages'] loop
		perform pg_temp.n_same(pg_temp.n_refused(o, v_question),
			'55000 Not connected: visits count once the company publishes a website', v_question);
	end loop;
	perform pg_temp.n_same(pg_temp.n_state($s$select pg_temp.n_run('site-now')$s$),
		'55000 Not connected: visits count once the company publishes a website', 'a run''s site-now');
	foreach v_question in array array['money-days', 'money', 'stock-now', 'balance'] loop
		perform pg_temp.n_same(pg_temp.n_refused(o, v_question),
			format('P0002 No question qorpera/%s that you may read', v_question), v_question);
	end loop;
	foreach v_question in array array['Money-now', 'money_now', 'money--now', '-money', '', repeat('a', 61)] loop
		perform pg_temp.n_same(pg_temp.n_refused(o, v_question), '22023 Name a question as qorpera/<question>',
			'the name ' || v_question);
	end loop;
	perform pg_temp.n_same(pg_temp.n_state($s$select pg_temp.n_member('92400000-0000-4000-8000-000000000001', null)$s$),
		'22023 Name a question as qorpera/<question>', 'no name');
end $$;

-- 14. "Today" is the company's own. 924's company has no zone, so the checks above ran on Copenhagen's days. A company
--     whose zone is a day off Copenhagen's now (Kiritimati, UTC+14, from 10:00 to 23:00 UTC; Pago Pago, UTC-11, at
--     the other hours) gets the 90 days to its own today, for a member and a run alike, and its own month for
--     money-kinds; a zone the database does not know, and no zone, are Copenhagen's.
savepoint n_zone;
do $$
declare
	v_zone text := case when pg_temp.n_zone_day('Pacific/Kiritimati', 0) <> pg_temp.n_day(0) then 'Pacific/Kiritimati'
		else 'Pacific/Pago_Pago' end;
	o constant uuid := '92400000-0000-4000-8000-000000000001';
	v jsonb;
	v_first text;
begin
	perform pg_temp.n_same((select time_zone from public.qorpera_profiles
		where id = '92400000-0000-4000-8000-000000000010'), null, '924''s company has no zone');
	perform pg_temp.n_same((pg_temp.n_zone_day(v_zone, 0) <> pg_temp.n_day(0))::text, 'true',
		'the zone''s today is not Copenhagen''s: ' || v_zone);
	update public.qorpera_profiles set time_zone = v_zone where id = '92400000-0000-4000-8000-000000000010';
	-- The summary's history runs to Copenhagen's today. In a zone a day ahead that is the zone's yesterday, and the 90
	-- days end on the zone's today; in a zone a day behind it is the zone's tomorrow, where the range ends (section 15).
	v_first := case when pg_temp.n_zone_day(v_zone, 1) = pg_temp.n_day(0)::text then pg_temp.n_day(-89)::text
		else pg_temp.n_zone_day(v_zone, -89) end;
	v := pg_temp.n_member(o, 'money-balance');
	perform pg_temp.n_same(v #>> '{rows,0,0}', v_first, 'the 90 days to the zone''s today, or to its tomorrow: ' || v_zone);
	perform pg_temp.n_same(pg_temp.n_run('money-balance') #>> '{rows,0,0}', v_first, 'a run''s 90 days, the same');
	perform pg_temp.n_same((select string_agg(k, ',' order by k) from jsonb_object_keys(v) k), 'asOf,columns,etag,more,rows',
		'the zone is not in the answer');
	-- The zone's month, or the summary's own (Copenhagen's here) when that is within a day of it.
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds', '{"month":"2000-01"}'),
		format('22023 qorpera/money-kinds answers this month only (%s), for now',
			case when pg_temp.n_month() in (left(pg_temp.n_zone_day(v_zone, 0), 7), left(pg_temp.n_zone_day(v_zone, 1), 7))
				then pg_temp.n_month() else left(pg_temp.n_zone_day(v_zone, 0), 7) end),
		'the zone''s month');
	-- A zone of the right shape that the database does not know: Copenhagen's.
	update public.qorpera_profiles set time_zone = 'Mars/Olympus_Mons' where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.n_same(pg_temp.n_member(o, 'money-balance') #>> '{rows,0,0}', pg_temp.n_day(-89),
		'an unknown zone is Copenhagen''s');
	-- No zone again: Copenhagen's.
	update public.qorpera_profiles set time_zone = null where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.n_same(pg_temp.n_member(o, 'money-balance') #>> '{rows,0,0}', pg_temp.n_day(-89),
		'no zone is Copenhagen''s');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds', '{"month":"2000-01"}'),
		format('22023 qorpera/money-kinds answers this month only (%s), for now', pg_temp.n_month()), 'Copenhagen''s month');
end $$;
rollback to savepoint n_zone;
select pg_temp.base_claims('service_role');

-- 15. Until slice M2 the summary's days and month are the vault's UTC ones, and may lead or lag the company's.
--     money-kinds' "this month" is the summary's own when it is the month of the company's today or tomorrow: on the
--     company's 31 October a summary of November (fetched after midnight UTC, in a zone behind it) is answered, and
--     either month may be named. A summary that lags (last month's, with no fetch since) is never this month's.
--     money-balance's default range ends on the summary's newest day when that is the company's tomorrow, never later.
savepoint n_utc;
do $$
declare o constant uuid := '92400000-0000-4000-8000-000000000001'; v jsonb;
begin
	-- The month, by the company's day and the summary's month.
	perform pg_temp.n_same(public.qorpera_company_numbers_kinds_month('2026-10-31', '2026-11'), '2026-11',
		'a summary a month ahead, on the company''s last day of the month');
	perform pg_temp.n_same(public.qorpera_company_numbers_kinds_month('2026-12-31', '2027-01'), '2027-01',
		'a summary a month ahead, across the year');
	perform pg_temp.n_same(public.qorpera_company_numbers_kinds_month('2026-11-01', '2026-10'), '2026-11',
		'a summary a month behind, on the company''s first day of the month: the company''s');
	perform pg_temp.n_same(public.qorpera_company_numbers_kinds_month('2026-11-15', '2026-12'), '2026-11',
		'a summary a month ahead, mid-month: the company''s');
	perform pg_temp.n_same(public.qorpera_company_numbers_kinds_month('2026-11-15', '2026-10'), '2026-11',
		'an old summary: the company''s');
	perform pg_temp.n_same(public.qorpera_company_numbers_kinds_month('2026-11-15', null), '2026-11', 'no summary');
	-- The balance's end, by the company's day and the summary's newest day.
	perform pg_temp.n_same(public.qorpera_company_numbers_balance_end('2026-10-31', '2026-11-01')::text, '2026-11-01',
		'the summary''s newest day is the company''s tomorrow');
	perform pg_temp.n_same(public.qorpera_company_numbers_balance_end('2026-10-31', '2026-11-02')::text, '2026-10-31',
		'never later');
	perform pg_temp.n_same(public.qorpera_company_numbers_balance_end('2026-10-31', '2026-10-30')::text, '2026-10-31',
		'a summary behind');
	perform pg_temp.n_same(public.qorpera_company_numbers_balance_end('2026-10-31', null)::text, '2026-10-31', 'no days');

	-- A summary whose months are next month's: answered only on the company's last day of a month (the month of its
	-- tomorrow), where both months may be named; on any other day it is no month of the company's: the company's month
	-- has no rows, and next month is refused.
	perform set_config('qorpera_test.n_next', to_char(date_trunc('month', pg_temp.n_today()) + interval '1 month',
		'YYYY-MM'), true);
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', jsonb_set(jsonb_set(pg_temp.n_summary(),
		'{moneyIn,month}', to_jsonb(current_setting('qorpera_test.n_next'))),
		'{moneyOut,month}', to_jsonb(current_setting('qorpera_test.n_next'))));
	if to_char(pg_temp.n_today() + 1, 'YYYY-MM') = current_setting('qorpera_test.n_next') then
		v := pg_temp.n_member(o, 'money-kinds', jsonb_build_object('month', current_setting('qorpera_test.n_next')));
		perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text, '5', 'next month''s summary by name, on the last day');
		perform pg_temp.n_same(jsonb_array_length(pg_temp.n_member(o, 'money-kinds') -> 'rows')::text, '5',
			'this month is the summary''s, on the last day');
	else
		perform pg_temp.n_json(pg_temp.n_member(o, 'money-kinds') -> 'rows', '[]',
			'next month''s summary is no month of the company''s mid-month');
		perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds',
			jsonb_build_object('month', current_setting('qorpera_test.n_next'))),
			format('22023 qorpera/money-kinds answers this month only (%s), for now', pg_temp.n_month()),
			'next month is refused mid-month');
	end if;
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds', jsonb_build_object('month', pg_temp.n_month())), 'ok',
		'the company''s own month may always be named');
	-- A summary of last month (fetched before this month began, and none since): never this month's.
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', jsonb_set(jsonb_set(pg_temp.n_summary(),
		'{moneyIn,month}', to_jsonb(to_char(date_trunc('month', pg_temp.n_today()) - interval '1 month', 'YYYY-MM'))),
		'{moneyOut,month}', to_jsonb(to_char(date_trunc('month', pg_temp.n_today()) - interval '1 month', 'YYYY-MM'))));
	perform pg_temp.n_json(pg_temp.n_member(o, 'money-kinds') -> 'rows', '[]', 'last month''s summary');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds',
		jsonb_build_object('month', to_char(date_trunc('month', pg_temp.n_today()) - interval '1 month', 'YYYY-MM'))),
		format('22023 qorpera/money-kinds answers this month only (%s), for now', pg_temp.n_month()),
		'last month is refused');
	-- A summary two months ahead is no month of the company's: nothing, and its month is refused.
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', jsonb_set(jsonb_set(pg_temp.n_summary(),
		'{moneyIn,month}', to_jsonb(to_char(pg_temp.n_today() + interval '2 months', 'YYYY-MM'))),
		'{moneyOut,month}', to_jsonb(to_char(pg_temp.n_today() + interval '2 months', 'YYYY-MM'))));
	perform pg_temp.n_json(pg_temp.n_member(o, 'money-kinds') -> 'rows', '[]', 'a summary two months ahead');
	perform pg_temp.n_same(pg_temp.n_refused(o, 'money-kinds',
		jsonb_build_object('month', to_char(pg_temp.n_today() + interval '2 months', 'YYYY-MM'))),
		format('22023 qorpera/money-kinds answers this month only (%s), for now', pg_temp.n_month()),
		'its month is refused');

	-- History to the company's tomorrow (the vault's UTC day): the default range ends there, 90 days.
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', jsonb_set(pg_temp.n_summary(), '{history}',
		(select jsonb_agg(jsonb_build_object('date', pg_temp.n_day(1 - i), 'saldo', 2000 + i) order by i desc)
			from generate_series(0, 199) i)));
	v := pg_temp.n_member(o, 'money-balance');
	perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text || ' ' || (v #>> '{rows,0,0}') || ' ' || (v #>> '{rows,89,0}'),
		'90 ' || pg_temp.n_day(-88) || ' ' || pg_temp.n_day(1), 'the range ends on the summary''s newest day');
	-- History to the day after: the range ends on the company's today, and leaves the later days out.
	perform pg_temp.n_record('92400000-0000-4000-8000-000000000010', jsonb_set(pg_temp.n_summary(), '{history}',
		(select jsonb_agg(jsonb_build_object('date', pg_temp.n_day(2 - i), 'saldo', 2000 + i) order by i desc)
			from generate_series(0, 199) i)));
	v := pg_temp.n_member(o, 'money-balance');
	perform pg_temp.n_same(jsonb_array_length(v -> 'rows')::text || ' ' || (v #>> '{rows,89,0}'), '90 ' || pg_temp.n_day(0),
		'never past the company''s tomorrow');
end $$;
rollback to savepoint n_utc;
select pg_temp.base_claims('service_role');

rollback;
