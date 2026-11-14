-- The company's days by kind (migration 20260930769000): only the vault's own function, called by the broker with the
-- company's authority under the sync's live lease, writes them; a call replaces the company's rows of its range and
-- leaves the other days and companies alone; the cover tells which days were counted and from which accounts, and a write
-- from another set of accounts clears the company's days (a rotated secret over the same accounts keeps them, one with
-- new accounts does not); the days are dates in the company's time zone (Copenhagen
-- without one), which the kept transactions' answer tells the vault; a malformed call changes nothing; nothing personal
-- has a column.
begin;

insert into auth.users(id, email) values ('12670000-0000-4000-8000-000000000001', 'bank-days@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('12670000-0000-4000-8000-000000000010', 'Days Company', '12670000-0000-4000-8000-000000000001'),
	('12670000-0000-4000-8000-000000000011', 'Other Company', '12670000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12670000-0000-4000-8000-000000000010', '12670000-0000-4000-8000-000000000001', 'bank-days@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('12670000-0000-4000-8000-000000000020', '12670000-0000-4000-8000-000000000010', 'Environment', 1, '12670000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('12670000-0000-4000-8000-0000000000d1', '12670000-0000-4000-8000-000000000010', 'https://broker.example.test', 'key-1', repeat('1', 64)),
	('12670000-0000-4000-8000-0000000000d2', '12670000-0000-4000-8000-000000000011', 'https://broker.example.test', 'key-2', repeat('2', 64));

create function pg_temp.refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'Failed: %', p_what; end if;
end
$$;
-- The company has no time zone yet: its days are Copenhagen's.
create function pg_temp.today() returns date language sql as $$
	select (clock_timestamp() at time zone 'Europe/Copenhagen')::date
$$;
-- A sealed version of a company bank connection, as the capture leaves it.
create function pg_temp.seal(p_secret uuid, p_version bigint) returns void language plpgsql as $$
declare v_envelope bytea := extensions.gen_random_bytes(64);
begin
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (p_secret, p_version, '12670000-0000-4000-8000-0000000000d1', 'key-1', v_envelope,
		encode(extensions.digest(v_envelope, 'sha256'), 'hex'), '12670000-0000-4000-8000-000000000001');
end $$;
-- A company bank connection, sealed for the company's own authority.
create function pg_temp.connect(p_secret uuid, p_label text) returns void language plpgsql as $$
begin
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
		secret_name, purpose, current_version, created_by_user_id, account_label)
	values (p_secret, '12670000-0000-4000-8000-000000000010', '12670000-0000-4000-8000-000000000020',
		'12670000-0000-4000-8000-0000000000d1', 'company', 'bank', 'primary', 'Company bank', 1,
		'12670000-0000-4000-8000-000000000001', p_label);
	perform pg_temp.seal(p_secret, 1);
end $$;
-- A connect-again: the secret's next version, sealed.
create function pg_temp.rotate(p_secret uuid, p_version bigint) returns void language plpgsql as $$
begin
	update public.qorpera_cloud_secrets set current_version = p_version where id = p_secret;
	perform pg_temp.seal(p_secret, p_version);
end $$;
select pg_temp.connect('12670000-0000-4000-8000-0000000000e1', 'Danske Bank');
-- The broker's calls, under its own database login.
create function pg_temp.claim() returns jsonb language plpgsql as $$
declare v jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_claim_bank_sync('12670000-0000-4000-8000-0000000000d1', repeat('1', 64));
	reset session authorization;
	return v;
end
$$;
create function pg_temp.lease() returns uuid language sql as $$
	select lease_id from public.qorpera_bank_syncs where profile_id = '12670000-0000-4000-8000-000000000010'
$$;
-- The sync's own secret and version unless a test names another.
create function pg_temp.secret() returns uuid language sql as $$
	select secret_id from public.qorpera_bank_syncs where profile_id = '12670000-0000-4000-8000-000000000010'
$$;
create function pg_temp.version() returns bigint language sql as $$
	select secret_version from public.qorpera_bank_syncs where profile_id = '12670000-0000-4000-8000-000000000010'
$$;
-- The days of the accounts p_keys names (one account, 'aaa…', unless a test names others).
create function pg_temp.days(p_from date, p_to date, p_days jsonb, p_lease uuid default null,
	p_capability text default repeat('1', 64), p_secret uuid default null,
	p_keys jsonb default jsonb_build_array(repeat('a', 64))) returns jsonb language plpgsql as $$
declare
	v jsonb;
	v_lease uuid := coalesce(p_lease, pg_temp.lease());
	v_secret uuid := coalesce(p_secret, pg_temp.secret());
	v_version bigint := pg_temp.version();
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_record_bank_days('12670000-0000-4000-8000-0000000000d1', p_capability,
		v_secret, v_version, v_lease, p_keys, p_from, p_to, p_days);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.kept_answer() returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := pg_temp.lease(); v_secret uuid := pg_temp.secret(); v_version bigint := pg_temp.version();
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_record_bank_transactions('12670000-0000-4000-8000-0000000000d1', repeat('1', 64), v_secret, v_version,
		v_lease, jsonb_build_array(repeat('a', 64)), '[]');
	reset session authorization;
	return v;
end
$$;
create function pg_temp.finish() returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := pg_temp.lease(); v_secret uuid := pg_temp.secret(); v_version bigint := pg_temp.version();
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_finish_bank_sync('12670000-0000-4000-8000-0000000000d1', repeat('1', 64),
		v_secret, v_version, v_lease, 'current',
		jsonb_build_object('schema', 'qorpera.bank-summary/v1', 'saldo', 1), null, 'deep', null);
	reset session authorization;
	return v;
end
$$;
grant execute on function pg_temp.claim(), pg_temp.lease(), pg_temp.secret(), pg_temp.version(), pg_temp.today(),
	pg_temp.days(date, date, jsonb, uuid, text, uuid, jsonb), pg_temp.kept_answer(), pg_temp.finish() to qorpera_secret_broker;
create function pg_temp.row(p_day date, p_direction text, p_kind text, p_amount numeric, p_count integer)
returns jsonb language sql as $$
	select jsonb_build_object('day', p_day, 'direction', p_direction, 'kind', p_kind, 'amount', p_amount, 'count', p_count)
$$;
-- The company's rows as text, newest day first, each day as how many days ago.
create function pg_temp.kept() returns text language sql as $$
	select coalesce(string_agg(format('%s %s %s %s %s', pg_temp.today() - day, direction, kind, amount, count), '; '
		order by day desc, direction, kind), '')
	from public.qorpera_bank_days where profile_id = '12670000-0000-4000-8000-000000000010'
$$;
create function pg_temp.cover() returns text language sql as $$
	select format('%s..%s', pg_temp.today() - first_day, pg_temp.today() - last_day)
	from public.qorpera_bank_days_cover where profile_id = '12670000-0000-4000-8000-000000000010'
$$;
create function pg_temp.cover_accounts() returns text language sql as $$
	select accounts_sha256 from public.qorpera_bank_days_cover where profile_id = '12670000-0000-4000-8000-000000000010'
$$;
-- The digest of a set of account keys, as the cover keeps it: sorted, one a line.
create function pg_temp.accounts(p_keys text[]) returns text language sql as $$
	select encode(extensions.digest(array_to_string(array(select distinct_key.key
		from (select distinct key from unnest(p_keys) as key) as distinct_key order by distinct_key.key collate "C"), E'\n'),
		'sha256'), 'hex')
$$;

-- 1. Nobody reads or writes the tables; only the broker may call the function, and only with the company's authority.
do $$
declare v_role text; v_table text; v_right text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_table in array array['public.qorpera_bank_days', 'public.qorpera_bank_days_cover'] loop
			foreach v_right in array array['select', 'insert', 'update', 'delete'] loop
				perform pg_temp.check(not has_table_privilege(v_role, v_table, v_right), v_role || ' may not ' || v_right || ' ' || v_table);
			end loop;
		end loop;
	end loop;
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
		perform pg_temp.check(not has_function_privilege(v_role,
			'public.qorpera_record_bank_days(uuid,text,uuid,bigint,uuid,jsonb,date,date,jsonb)', 'execute'),
			v_role || ' may not record days');
	end loop;
	perform pg_temp.check(has_function_privilege('qorpera_secret_broker',
		'public.qorpera_record_bank_days(uuid,text,uuid,bigint,uuid,jsonb,date,date,jsonb)', 'execute'), 'the broker records days');
	perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.qorpera_bank_days'::regclass)
		and (select relrowsecurity from pg_class where oid = 'public.qorpera_bank_days_cover'::regclass), 'row security is on');
end $$;
-- Called by anyone but the broker's login (here the test's superuser), it is refused before anything is read.
select pg_temp.refused($q$select public.qorpera_record_bank_days('12670000-0000-4000-8000-0000000000d1', repeat('1', 64),
	'12670000-0000-4000-8000-0000000000e1', 1, null, '[]', current_date, current_date, '[]')$q$, '42501');
select pg_temp.refused($q$select pg_temp.days(pg_temp.today(), pg_temp.today(), '[]', null, repeat('9', 64))$q$, '42501');

-- 2. Nothing personal has a column: no party, text, account, transaction or currency; the days go with the company.
select pg_temp.check((select array_agg(attname::text order by attnum) from pg_attribute
	where attrelid = 'public.qorpera_bank_days'::regclass and attnum > 0 and not attisdropped)
	= array['profile_id', 'day', 'direction', 'kind', 'amount', 'count'], 'the days'' columns');
select pg_temp.check((select array_agg(attname::text order by attnum) from pg_attribute
	where attrelid = 'public.qorpera_bank_days_cover'::regclass and attnum > 0 and not attisdropped)
	= array['profile_id', 'accounts_sha256', 'first_day', 'last_day', 'written_at'], 'the cover''s columns');
select pg_temp.check((select bool_and(confdeltype = 'c' and confrelid = 'public.qorpera_profiles'::regclass) from pg_constraint
	where contype = 'f' and conrelid in ('public.qorpera_bank_days'::regclass, 'public.qorpera_bank_days_cover'::regclass))
	and (select count(*) = 2 from pg_constraint where contype = 'f'
		and conrelid in ('public.qorpera_bank_days'::regclass, 'public.qorpera_bank_days_cover'::regclass)),
	'the days go when the company goes');

-- 3. Without a live lease nothing is written.
select pg_temp.refused($q$select pg_temp.days(pg_temp.today(), pg_temp.today(), '[]', '12670000-0000-4000-8000-0000000000f0')$q$, '55000');
select pg_temp.check(pg_temp.claim() ->> 'schema' = 'qorpera.bank-sync-claim/v1', 'the sync is claimed');
select pg_temp.refused($q$select pg_temp.days(pg_temp.today(), pg_temp.today(), '[]', '12670000-0000-4000-8000-0000000000f0')$q$, '55000');

-- 4. The first write: its rows, its cover. Another company's rows stay.
insert into public.qorpera_bank_days(profile_id, day, direction, kind, amount, count)
values ('12670000-0000-4000-8000-000000000011', current_date - 5, 'in', 'sales', 9, 1);
do $$
declare v jsonb := pg_temp.days(pg_temp.today() - 10, pg_temp.today(), jsonb_build_array(
	pg_temp.row(pg_temp.today() - 10, 'in', 'sales', 4450, 2),
	pg_temp.row(pg_temp.today() - 10, 'out', 'salaries', 64000, 1),
	pg_temp.row(pg_temp.today() - 5, 'in', 'tax', 2500.5, 1),
	pg_temp.row(pg_temp.today() - 2, 'out', 'other', 6150, 3),
	pg_temp.row(pg_temp.today(), 'in', 'other', 40, 1)));
begin
	perform pg_temp.check(v = jsonb_build_object('schema', 'qorpera.bank-days-result/v1', 'firstDay', pg_temp.today() - 10,
		'lastDay', pg_temp.today(), 'rows', 5), 'the answer: ' || v::text);
	perform pg_temp.check(pg_temp.kept() = '0 in other 40.00 1; 2 out other 6150.00 3; 5 in tax 2500.50 1; '
		|| '10 in sales 4450.00 2; 10 out salaries 64000.00 1', 'the rows: ' || pg_temp.kept());
	perform pg_temp.check(pg_temp.cover() = '10..0' and pg_temp.cover_accounts() = pg_temp.accounts(array[repeat('a', 64)]),
		'the cover: ' || pg_temp.cover());
end $$;

-- 5. A write replaces the rows of its range only: the days before it stay, and the cover keeps them.
do $$
declare v jsonb := pg_temp.days(pg_temp.today() - 3, pg_temp.today(), jsonb_build_array(
	pg_temp.row(pg_temp.today() - 1, 'out', 'rent', 18500, 1)));
begin
	perform pg_temp.check((v ->> 'rows')::integer = 1 and (v ->> 'firstDay')::date = pg_temp.today() - 10, 'the answer: ' || v::text);
	perform pg_temp.check(pg_temp.kept() = '1 out rent 18500.00 1; 5 in tax 2500.50 1; 10 in sales 4450.00 2; '
		|| '10 out salaries 64000.00 1', 'replaced in its range: ' || pg_temp.kept());
	perform pg_temp.check(pg_temp.cover() = '10..0', 'the cover stays: ' || pg_temp.cover());
	-- An empty range clears its days: no money moved then.
	v := pg_temp.days(pg_temp.today() - 6, pg_temp.today() - 4, '[]');
	perform pg_temp.check(pg_temp.kept() = '1 out rent 18500.00 1; 10 in sales 4450.00 2; 10 out salaries 64000.00 1',
		'an empty range: ' || pg_temp.kept());
	-- A range that touches the cover grows it.
	v := pg_temp.days(pg_temp.today() - 20, pg_temp.today() - 11, jsonb_build_array(
		pg_temp.row(pg_temp.today() - 15, 'out', 'fees', 12.5, 4)));
	perform pg_temp.check(pg_temp.cover() = '20..0' and pg_temp.kept() like '%15 out fees 12.50 4%', 'grown: ' || pg_temp.cover());
	perform pg_temp.check((select count(*) = 1 from public.qorpera_bank_days
		where profile_id = '12670000-0000-4000-8000-000000000011'), 'the other company''s day stays');
end $$;

-- 6. A malformed call is refused and changes nothing.
do $$
declare
	v_before text := pg_temp.kept();
	v_today date := pg_temp.today();
	v_case jsonb;
begin
	foreach v_case in array array[
		-- A day outside the range, a day twice, a kind of the other direction, an unknown kind or direction.
		jsonb_build_array(pg_temp.row(v_today - 4, 'in', 'sales', 1, 1)),
		jsonb_build_array(pg_temp.row(v_today, 'in', 'sales', 1, 1), pg_temp.row(v_today, 'in', 'sales', 2, 1)),
		jsonb_build_array(pg_temp.row(v_today, 'in', 'salaries', 1, 1)),
		jsonb_build_array(pg_temp.row(v_today, 'out', 'sales', 1, 1)),
		jsonb_build_array(pg_temp.row(v_today, 'sideways', 'other', 1, 1)),
		-- No negative kroner, no day without a payment, whole payments only.
		jsonb_build_array(pg_temp.row(v_today, 'out', 'other', -1, 1)),
		jsonb_build_array(pg_temp.row(v_today, 'out', 'other', 1, 0)),
		jsonb_build_array(pg_temp.row(v_today, 'out', 'other', 1, 1) || '{"count": 1.5}'),
		-- Nothing personal rides along, and nothing is missing.
		jsonb_build_array(pg_temp.row(v_today, 'in', 'other', 1, 1) || '{"counterparty": "Jens Hansen"}'),
		jsonb_build_array(pg_temp.row(v_today, 'in', 'other', 1, 1) - 'count'),
		-- The wrong types.
		jsonb_build_array(pg_temp.row(v_today, 'in', 'other', 1, 1) || '{"amount": "1"}'),
		jsonb_build_array(pg_temp.row(v_today, 'in', 'other', 1, 1) || '{"day": "not a day"}'),
		jsonb_build_array(pg_temp.row(v_today, 'in', 'other', 1, 1) || '{"day": "2026-02-30"}'),
		jsonb_build_array('"a day"'::jsonb),
		'{"day": "2026-11-14"}'::jsonb
	] loop
		perform pg_temp.refused(format('select pg_temp.days(%L, %L, %L)', v_today - 3, v_today, v_case), '22023');
	end loop;
	-- A range backwards, of more than 400 days, past tomorrow, or without an end.
	perform pg_temp.refused(format('select pg_temp.days(%L, %L, %L)', v_today, v_today - 1, '[]'), '22023');
	perform pg_temp.refused(format('select pg_temp.days(%L, %L, %L)', v_today - 400, v_today, '[]'), '22023');
	perform pg_temp.refused(format('select pg_temp.days(%L, %L, %L)', v_today, v_today + 2, '[]'), '22023');
	perform pg_temp.refused(format('select pg_temp.days(%L, null, %L)', v_today, '[]'), '22023');
	perform pg_temp.check(pg_temp.kept() = v_before and pg_temp.cover() = '20..0', 'nothing changed: ' || pg_temp.kept());
	-- 400 days is the most.
	perform pg_temp.days(v_today - 399, v_today, jsonb_build_array(pg_temp.row(v_today - 399, 'in', 'other', 1, 1)));
	perform pg_temp.check(pg_temp.cover() = '399..0' and pg_temp.kept() = '399 in other 1.00 1', 'a full range: ' || pg_temp.kept());
end $$;

-- 7. A range apart from the cover starts a new one, and the days outside it go.
do $$
begin
	perform pg_temp.days(pg_temp.today(), pg_temp.today(), jsonb_build_array(pg_temp.row(pg_temp.today(), 'in', 'sales', 7, 1)));
	update public.qorpera_bank_days_cover set first_day = pg_temp.today() - 399, last_day = pg_temp.today() - 380
	where profile_id = '12670000-0000-4000-8000-000000000010';
	perform pg_temp.days(pg_temp.today() - 5, pg_temp.today(), jsonb_build_array(pg_temp.row(pg_temp.today() - 5, 'out', 'taxes', 3, 1)));
	perform pg_temp.check(pg_temp.cover() = '5..0' and pg_temp.kept() = '5 out taxes 3.00 1', 'a new cover: ' || pg_temp.kept());
end $$;

-- 8. The kept transactions' answer tells the vault the company's zone: Copenhagen while it has none.
select pg_temp.check(pg_temp.kept_answer() ->> 'timeZone' = 'Europe/Copenhagen'
	and pg_temp.kept_answer() ->> 'schema' = 'qorpera.bank-transactions-kept/v1', 'no zone is Copenhagen''s');

-- 9. Once the sync is finished, its lease is gone and so is the right to write.
select pg_temp.check(pg_temp.finish() ->> 'status' = 'current', 'the sync finishes');
select pg_temp.refused($q$select pg_temp.days(pg_temp.today(), pg_temp.today(), '[]')$q$, '55000');
select pg_temp.check(pg_temp.kept() = '5 out taxes 3.00 1', 'the days stay after the sync');

-- 10. The days follow the accounts they were counted from.
-- 10a. A connect-again over the same accounts (the consent renewed at the same bank, the secret rotated) keeps the days.
select pg_temp.rotate('12670000-0000-4000-8000-0000000000e1', 2);
select pg_temp.check((pg_temp.claim() ->> 'secretVersion')::bigint = 2, 'the rotated secret is claimed');
do $$
begin
	perform pg_temp.days(pg_temp.today() - 1, pg_temp.today(), jsonb_build_array(pg_temp.row(pg_temp.today(), 'in', 'sales', 11, 1)));
	perform pg_temp.check(pg_temp.kept() = '0 in sales 11.00 1; 5 out taxes 3.00 1' and pg_temp.cover() = '5..0',
		'the same accounts keep their days: ' || pg_temp.kept());
	-- 10b. An account added: another set of accounts clears every day, even those the range does not reach.
	perform pg_temp.days(pg_temp.today() - 1, pg_temp.today(), jsonb_build_array(pg_temp.row(pg_temp.today(), 'in', 'sales', 12, 1)),
		null, repeat('1', 64), null, jsonb_build_array(repeat('a', 64), repeat('b', 64)));
	perform pg_temp.check(pg_temp.kept() = '0 in sales 12.00 1' and pg_temp.cover() = '1..0'
		and pg_temp.cover_accounts() = pg_temp.accounts(array[repeat('a', 64), repeat('b', 64)]),
		'an added account starts over: ' || pg_temp.kept());
	-- The same set in another order, named twice, is the same accounts: the cover grows.
	perform pg_temp.days(pg_temp.today() - 3, pg_temp.today() - 2, jsonb_build_array(pg_temp.row(pg_temp.today() - 3, 'out', 'rent', 5, 1)),
		null, repeat('1', 64), null, jsonb_build_array(repeat('b', 64), repeat('a', 64), repeat('b', 64)));
	perform pg_temp.check(pg_temp.kept() = '0 in sales 12.00 1; 3 out rent 5.00 1' and pg_temp.cover() = '3..0',
		'the same set in another order: ' || pg_temp.kept());
end $$;
-- Account keys of another shape are refused, and change nothing.
select pg_temp.refused(format('select pg_temp.days(%L, %L, %L, null, repeat(%L, 64), null, %L)', pg_temp.today(), pg_temp.today(),
	'[]', '1', v_keys), '22023')
from unnest(array['[]', '"aaa"', '["not-a-key"]', '[1]', jsonb_build_array(repeat('A', 64))::text]) as v_keys;
select pg_temp.check(pg_temp.kept() = '0 in sales 12.00 1; 3 out rent 5.00 1', 'refused keys changed nothing');
-- 10c. A connect-again under the same secret that shares other accounts (another bank, the secret rotated) clears them.
select pg_temp.finish();
select pg_temp.rotate('12670000-0000-4000-8000-0000000000e1', 3);
select pg_temp.check((pg_temp.claim() ->> 'secretVersion')::bigint = 3, 'the secret rotated again is claimed');
do $$
begin
	perform pg_temp.days(pg_temp.today() - 1, pg_temp.today(), jsonb_build_array(pg_temp.row(pg_temp.today() - 1, 'out', 'fees', 2, 1)),
		null, repeat('1', 64), null, jsonb_build_array(repeat('c', 64)));
	perform pg_temp.check(pg_temp.kept() = '1 out fees 2.00 1' and pg_temp.cover() = '1..0'
		and pg_temp.cover_accounts() = pg_temp.accounts(array[repeat('c', 64)]), 'a rotated secret with new accounts: ' || pg_temp.kept());
end $$;
-- 10d. A new secret over the same accounts (a Disconnect, then a connect to the same bank) keeps them; the old secret
-- may no longer write.
select pg_temp.finish();
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(),
	revoked_by_user_id = '12670000-0000-4000-8000-000000000001'
where id = '12670000-0000-4000-8000-0000000000e1';
select pg_temp.connect('12670000-0000-4000-8000-0000000000e2', 'Danske Bank');
select pg_temp.check((pg_temp.claim() ->> 'secretId')::uuid = '12670000-0000-4000-8000-0000000000e2', 'the new secret is claimed');
select pg_temp.refused($q$select pg_temp.days(pg_temp.today(), pg_temp.today(), '[]', null, repeat('1', 64),
	'12670000-0000-4000-8000-0000000000e1', jsonb_build_array(repeat('c', 64)))$q$, '55000');
do $$
begin
	perform pg_temp.days(pg_temp.today() - 2, pg_temp.today() - 2, jsonb_build_array(pg_temp.row(pg_temp.today() - 2, 'in', 'tax', 4, 1)),
		null, repeat('1', 64), null, jsonb_build_array(repeat('c', 64)));
	perform pg_temp.check(pg_temp.kept() = '1 out fees 2.00 1; 2 in tax 4.00 1' and pg_temp.cover() = '2..0',
		'a new secret over the same accounts: ' || pg_temp.kept());
end $$;

-- 11. With a zone of its own, the company's days are its own dates: the kept answer names the zone, and the newest day
-- a write may end on is tomorrow there. A zone the database does not know counts as none.
update public.qorpera_profiles set time_zone = 'Pacific/Kiritimati' where id = '12670000-0000-4000-8000-000000000010';
select pg_temp.check(pg_temp.kept_answer() ->> 'timeZone' = 'Pacific/Kiritimati', 'the company''s own zone');
select pg_temp.check(pg_temp.days(
	(clock_timestamp() at time zone 'Pacific/Kiritimati')::date + 1, (clock_timestamp() at time zone 'Pacific/Kiritimati')::date + 1,
	'[]') ->> 'schema' = 'qorpera.bank-days-result/v1', 'tomorrow in the company''s zone');
select pg_temp.refused(format('select pg_temp.days(%L, %L, %L)',
	(clock_timestamp() at time zone 'Pacific/Kiritimati')::date + 2, (clock_timestamp() at time zone 'Pacific/Kiritimati')::date + 2,
	'[]'), '22023');
update public.qorpera_profiles set time_zone = 'Pacific/Pago_Pago' where id = '12670000-0000-4000-8000-000000000010';
select pg_temp.refused(format('select pg_temp.days(%L, %L, %L)',
	(clock_timestamp() at time zone 'Pacific/Pago_Pago')::date + 2, (clock_timestamp() at time zone 'Pacific/Pago_Pago')::date + 2,
	'[]'), '22023');
update public.qorpera_profiles set time_zone = 'Mars/Olympus' where id = '12670000-0000-4000-8000-000000000010';
select pg_temp.check(pg_temp.kept_answer() ->> 'timeZone' = 'Europe/Copenhagen', 'an unknown zone is Copenhagen''s');

rollback;
