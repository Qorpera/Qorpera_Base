-- 20260930767000: the platform's own numbers of a company, door `money` (company views step 3, slice M1; the lane's
-- DESIGN-3.md §E, shape 1; Jonas, 14 November 2026: "Yes, start step 3"). Pages, kits and agents ask them by the
-- reserved database name `qorpera`, which no company database may carry (the data gateway and qorpera_run_data_pass
-- refuse it), with the calls they already use: `qorpera/money-now` and the like. Nothing here touches the company data
-- store or its gateway: the numbers are read from what this database already holds, the vault's bank summary
-- (qorpera_bank_syncs.summary, qorpera.bank-summary/v1, 20260930523000).
--
-- 1. qorpera_company_numbers_answer(...): the one dispatcher, internal. It answers a fixed question in the data
--    gateway's answer shape {columns, rows, more, asOf, etag}: columns by name, rows as arrays in their order, `more`
--    false (no question here makes more rows than the gateway's limit), `asOf` the time of the answer and `etag` the
--    first 32 hex of the sha256 of {columns, rows, more}, so an answer that did not change keeps its etag.
--    The money questions, for whoever may read bank/summary.json by the folder's path authority (no new rule):
--      money-now       one row always: state (none, waiting, current, paused), bank, balance, available, reserved,
--                      as_of, paused_since; the numbers are null without a summary.
--      money-balance   day, balance (the end of each day) from `from` to `to`, the company's days as YYYY-MM-DD; by
--                      default the 90 days to today; at most 366 days.
--      money-expected  day, balance: the summary's forecast, an estimate.
--      money-months    month (YYYY-MM), money_in, money_out: the summary's twelve months.
--      money-kinds     direction (in, out), kind, amount, count for `month`, this month only (the default): money out by
--                      the vault's own kinds (salaries, taxes, rent, utilities, subscriptions, fees, other), money in as
--                      one kind, `all`, since the summary groups money in by who paid. `count` is null: the summary keeps
--                      no count of payments (slice M2 adds days and counts from the vault).
--    Kroner as JSON numbers rounded to øre; the summary counts Danish kroner only. "Today" and "this month" (the default
--    range, money-kinds' month) are the company's own, in its time zone (qorpera_profiles.time_zone, 20260930739000,
--    taken from a member's browser), or Europe/Copenhagen's while it has none or one the database does not know (not in
--    qorpera_runtime_time_zone_names). The answer does not name the zone: the gateway's shape has no place for it.
--    Until slice M2 (migration 20260930769000 makes the vault count in the company's zone) the summary's own days and
--    month are the vault's UTC ones, taken at the fetch, and lead or lag the company's by hours. So money-balance's
--    default range ends on the summary's newest day when that is the company's tomorrow (never later), and money-kinds'
--    "this month" is the summary's own month when that is the month of the company's today or tomorrow (a fetch just
--    past midnight UTC on the 1st, in a zone behind UTC): that month is answered and may be named as :month, beside the
--    company's own month, which then answers no rows. A summary of an earlier month (a fetch before the company's
--    month began, and none since) is never "this month": the company's month answers no rows.
--    Never answered: who paid or was paid, transfer texts, account numbers (`payTo`), single transactions, the summary's
--    items. The `site` questions (sites, site-now, site-hours, site-days, site-pages) answer 0A000 "not counted yet":
--    slice S1 counts them. Any other question, and a money question the caller may not read: P0002 "No question
--    qorpera/<q> that you may read", the same words for both, as the data gateway answers. A parameter the question
--    does not take, or one of the wrong kind or out of bounds: 22023 in the gateway's words.
-- 2. qorpera_member_company_numbers(p_environment_id, p_question, p_params): a member of a folder-v2 company asks with
--    their own token through PostgREST (authenticated only), like qorpera_member_digital_post. Anyone else: 42501.
-- 3. qorpera_run_company_numbers(p_environment_id, p_actor, p_question, p_params): a run asks through
--    qorpera_native_host_call (scope folder: p_environment_id and p_actor must be that job's run), like
--    qorpera_run_data_pass; the run as a read resolves it (its job leased, its requester a member, its agent active).
--
-- Nothing here writes or locks: each call reads one bank sync row by its key and the folder's path resources.

-- 1. The dispatcher ----------------------------------------------------------------------------------------------------

-- Kroner rounded to øre, from a summary's number; null for anything else.
create function public.qorpera_company_numbers_kroner(p_value jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select case when jsonb_typeof(p_value) = 'number' then to_jsonb(round((p_value #>> '{}')::numeric, 2))
		else 'null'::jsonb end
$$;

-- A day parameter as YYYY-MM-DD, a calendar day; null when it is not given.
create function public.qorpera_company_numbers_day(p_params jsonb, p_name text)
returns date language plpgsql immutable set search_path = '' as $$
declare v_text text; v_day date;
begin
	if not p_params ? p_name or jsonb_typeof(p_params -> p_name) = 'null' then return null; end if;
	v_text := p_params ->> p_name;
	if jsonb_typeof(p_params -> p_name) <> 'string' or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
		raise exception ':% is a day as YYYY-MM-DD', p_name using errcode = '22023'; end if;
	begin
		v_day := v_text::date;
	exception when others then
		raise exception ':% is a day as YYYY-MM-DD', p_name using errcode = '22023';
	end;
	if to_char(v_day, 'YYYY-MM-DD') <> v_text then
		raise exception ':% is a day as YYYY-MM-DD', p_name using errcode = '22023'; end if;
	return v_day;
end $$;

-- The month money-kinds answers as "this month": the summary's own (the vault's UTC month at its fetch) when that is the
-- month of the company's today or tomorrow (a month that leads, in a zone behind UTC), else the company's own month. A
-- month that lags is never taken: a stale summary of last month is not this month's.
create function public.qorpera_company_numbers_kinds_month(p_today date, p_summary_month text)
returns text language sql immutable set search_path = '' as $$
	select case when p_summary_month in (to_char(p_today, 'YYYY-MM'), to_char(p_today + 1, 'YYYY-MM'))
		then p_summary_month else to_char(p_today, 'YYYY-MM') end
$$;

-- The day money-balance's default range ends on: the company's today, or the summary's newest day (the vault's UTC
-- day) when that is the company's tomorrow.
create function public.qorpera_company_numbers_balance_end(p_today date, p_newest text)
returns date language sql immutable set search_path = '' as $$
	select case when p_newest = to_char(p_today + 1, 'YYYY-MM-DD') then p_today + 1 else p_today end
$$;

create function public.qorpera_company_numbers_answer(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_question text, p_params jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_params jsonb := coalesce(p_params, '{}'::jsonb);
	v_now timestamptz := clock_timestamp();
	v_zone text;
	v_today date;
	v_takes text[];
	v_key text;
	v_status text;
	v_summary jsonb;
	v_state text;
	v_from date;
	v_to date;
	v_month text;
	v_end date;
	v_columns text[];
	v_rows jsonb;
	v_body jsonb;
begin
	-- Company views step 3, slice M1 (20260930767000)
	-- The company's today, in its own zone; Copenhagen's while it has none, or one the database does not know.
	select profile.time_zone into v_zone from public.qorpera_profiles as profile where profile.id = p_profile_id;
	if v_zone is null or not exists (select 1 from public.qorpera_runtime_time_zone_names as known
			where known.name = v_zone) then
		v_zone := 'Europe/Copenhagen'; end if;
	begin
		v_today := (v_now at time zone v_zone)::date;
	exception when others then
		v_today := (v_now at time zone 'Europe/Copenhagen')::date;
	end;
	if jsonb_typeof(v_params) is distinct from 'object' then
		raise exception 'Parameters are named values' using errcode = '22023'; end if;
	if p_question is null or char_length(p_question) > 60 or p_question !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
		raise exception 'Name a question as qorpera/<question>' using errcode = '22023'; end if;
	if p_question in ('sites', 'site-now', 'site-hours', 'site-days', 'site-pages') then
		raise exception 'qorpera/% is not counted yet: the sites'' numbers come later', p_question
			using errcode = '0A000'; end if;
	v_takes := case p_question
		when 'money-now' then '{}'::text[]
		when 'money-balance' then array['from', 'to']
		when 'money-expected' then '{}'::text[]
		when 'money-months' then '{}'::text[]
		when 'money-kinds' then array['month'] end;
	-- A question that is not there and one the caller may not read: the same words.
	if v_takes is null or not public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor,
			'bank/summary.json', 'read') then
		raise exception 'No question qorpera/% that you may read', p_question using errcode = 'P0002'; end if;
	for v_key in select k from jsonb_object_keys(v_params) k order by k loop
		if not v_key = any (v_takes) then
			raise exception 'The question takes no :%', left(v_key, 60) using errcode = '22023'; end if;
	end loop;

	-- The company's bank: the sync of its bank connection in this environment. Disconnected is none; a sync without a
	-- summary yet is waiting; a summary whose bank stopped sharing (or whose consent ended) is paused.
	select sync.status, sync.summary into v_status, v_summary
	from public.qorpera_bank_syncs as sync
	join public.qorpera_cloud_secrets as secret on secret.id = sync.secret_id
	where sync.profile_id = p_profile_id and secret.environment_id = p_environment_id;
	v_state := case
		when v_status is null or v_status = 'disconnected' then 'none'
		when v_summary is null then 'waiting'
		when v_status = 'ended' or jsonb_typeof(v_summary -> 'pausedSince') = 'string' then 'paused'
		else 'current' end;
	if v_state in ('none', 'waiting') then v_summary := null; end if;

	case p_question
	when 'money-now' then
		v_columns := array['state', 'bank', 'balance', 'available', 'reserved', 'as_of', 'paused_since'];
		v_rows := jsonb_build_array(jsonb_build_array(v_state,
			case when jsonb_typeof(v_summary -> 'bank') = 'string' then v_summary -> 'bank' else 'null'::jsonb end,
			public.qorpera_company_numbers_kroner(v_summary -> 'saldo'),
			public.qorpera_company_numbers_kroner(v_summary -> 'disponibel'),
			public.qorpera_company_numbers_kroner(v_summary -> 'reserveret'),
			case when jsonb_typeof(v_summary -> 'updatedAt') = 'string' then v_summary -> 'updatedAt' else 'null'::jsonb end,
			case when jsonb_typeof(v_summary -> 'pausedSince') = 'string' then v_summary -> 'pausedSince'
				else 'null'::jsonb end));
	when 'money-balance' then
		v_from := public.qorpera_company_numbers_day(v_params, 'from');
		-- Without :to, today, or the summary's newest day when that is the company's tomorrow (the vault's UTC day);
		-- from a :from, at most its 366 days, and never before it.
		v_end := public.qorpera_company_numbers_balance_end(v_today, (select max(point ->> 'date')
			from jsonb_array_elements(case when jsonb_typeof(v_summary -> 'history') = 'array'
				then v_summary -> 'history' else '[]'::jsonb end) as point
			where jsonb_typeof(point) = 'object' and point ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'));
		v_to := coalesce(public.qorpera_company_numbers_day(v_params, 'to'),
			case when v_from is not null then greatest(v_from, least(v_from + 365, v_end)) else v_end end);
		v_from := coalesce(v_from, v_to - 89);
		if v_from > v_to then raise exception ':from is after :to' using errcode = '22023'; end if;
		if v_to - v_from + 1 > 366 then
			raise exception 'From :from to :to is at most 366 days' using errcode = '22023'; end if;
		v_columns := array['day', 'balance'];
		select jsonb_agg(jsonb_build_array(point ->> 'date', public.qorpera_company_numbers_kroner(point -> 'saldo'))
			order by point ->> 'date')
		into v_rows
		from jsonb_array_elements(case when jsonb_typeof(v_summary -> 'history') = 'array'
			then v_summary -> 'history' else '[]'::jsonb end) as point
		where jsonb_typeof(point) = 'object' and point ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
			and point ->> 'date' between to_char(v_from, 'YYYY-MM-DD') and to_char(v_to, 'YYYY-MM-DD');
	when 'money-expected' then
		v_columns := array['day', 'balance'];
		select jsonb_agg(jsonb_build_array(point ->> 'date', public.qorpera_company_numbers_kroner(point -> 'saldo'))
			order by point ->> 'date')
		into v_rows
		from jsonb_array_elements(case when jsonb_typeof(v_summary -> 'expected') = 'array'
			then v_summary -> 'expected' else '[]'::jsonb end) as point
		where jsonb_typeof(point) = 'object' and point ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
	when 'money-months' then
		v_columns := array['month', 'money_in', 'money_out'];
		select jsonb_agg(jsonb_build_array(month ->> 'month', public.qorpera_company_numbers_kroner(month -> 'in'),
			public.qorpera_company_numbers_kroner(month -> 'out')) order by month ->> 'month')
		into v_rows
		from jsonb_array_elements(case when jsonb_typeof(v_summary -> 'months') = 'array'
			then v_summary -> 'months' else '[]'::jsonb end) as month
		where jsonb_typeof(month) = 'object' and month ->> 'month' ~ '^[0-9]{4}-[0-9]{2}$';
	when 'money-kinds' then
		-- "This month": the summary's own when it is within a day of the company's (the vault's UTC month), else the
		-- company's. Either may be named; the company's own, when it is not the summary's, answers no rows.
		v_month := public.qorpera_company_numbers_kinds_month(v_today,
			coalesce(v_summary #>> '{moneyOut,month}', v_summary #>> '{moneyIn,month}'));
		if v_params ? 'month' and jsonb_typeof(v_params -> 'month') <> 'null' then
			if jsonb_typeof(v_params -> 'month') <> 'string' or v_params ->> 'month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
				raise exception ':month is a month as YYYY-MM' using errcode = '22023'; end if;
			if v_params ->> 'month' not in (v_month, to_char(v_today, 'YYYY-MM')) then
				raise exception 'qorpera/money-kinds answers this month only (%), for now', v_month
					using errcode = '22023'; end if;
			v_month := v_params ->> 'month';
		end if;
		v_columns := array['direction', 'kind', 'amount', 'count'];
		-- The categories' totals only, never their items: money in as one kind, money out by the vault's own kinds, in
		-- that fixed order. A summary of another month (an old one) has nothing for this month.
		with kinds(direction, kind, place, total) as (
			select 'in', 'all', 0, sum(round((category -> 'total' #>> '{}')::numeric, 2))
			from jsonb_array_elements(case when v_summary #>> '{moneyIn,month}' = v_month
				and jsonb_typeof(v_summary #> '{moneyIn,categories}') = 'array'
				then v_summary #> '{moneyIn,categories}' else '[]'::jsonb end) as category
			where jsonb_typeof(category -> 'total') = 'number'
			having count(*) > 0
			union all
			select 'out', listed.kind, listed.place, sum(round((category -> 'total' #>> '{}')::numeric, 2))
			from jsonb_array_elements(case when v_summary #>> '{moneyOut,month}' = v_month
				and jsonb_typeof(v_summary #> '{moneyOut,categories}') = 'array'
				then v_summary #> '{moneyOut,categories}' else '[]'::jsonb end) as category
			cross join lateral (select case category ->> 'name'
				when 'Salaries' then 'salaries' when 'Taxes and VAT' then 'taxes' when 'Rent' then 'rent'
				when 'Utilities' then 'utilities' when 'Subscriptions' then 'subscriptions'
				when 'Card and app fees' then 'fees' else 'other' end as kind) as named
			join (values ('salaries', 1), ('taxes', 2), ('rent', 3), ('utilities', 4), ('subscriptions', 5), ('fees', 6),
				('other', 7)) as listed(kind, place) on listed.kind = named.kind
			where jsonb_typeof(category -> 'total') = 'number'
			group by listed.kind, listed.place
		)
		select jsonb_agg(jsonb_build_array(direction, kind, to_jsonb(total), null) order by place)
		into v_rows from kinds;
	end case;

	v_body := jsonb_build_object('columns', to_jsonb(v_columns), 'rows', coalesce(v_rows, '[]'::jsonb), 'more', false);
	return v_body || jsonb_build_object(
		'asOf', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'etag', left(encode(extensions.digest(convert_to(v_body::text, 'utf8'), 'sha256'), 'hex'), 32));
end $$;

-- 2. A member's ask ----------------------------------------------------------------------------------------------------

create function public.qorpera_member_company_numbers(p_environment_id uuid, p_question text,
	p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb; v_profile uuid;
begin
	-- Company views step 3, slice M1 (20260930767000): a member of a folder-v2 company, with their own path authority.
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_environment_id is null then
		raise exception 'Company numbers are unavailable' using errcode = '42501'; end if;
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	if v_profile is null or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_profile and member.user_id = auth.uid()) then
		raise exception 'Company numbers are unavailable' using errcode = '42501'; end if;
	v_actor := jsonb_build_object('kind', 'member', 'userId', auth.uid());
	return public.qorpera_company_numbers_answer(p_environment_id, v_profile, v_actor, p_question, p_params);
end $$;

-- 3. A run's ask -------------------------------------------------------------------------------------------------------

create function public.qorpera_run_company_numbers(p_environment_id uuid, p_actor jsonb, p_question text,
	p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_auth jsonb; v_profile uuid;
begin
	-- Company views step 3, slice M1 (20260930767000): the run as a read resolves it, as qorpera_run_data_pass does.
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
	return public.qorpera_company_numbers_answer(p_environment_id, v_profile, v_auth, p_question, p_params);
end $$;

-- 4. Grants and the native host's list ---------------------------------------------------------------------------------

revoke all on function public.qorpera_company_numbers_kroner(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_numbers_day(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_numbers_kinds_month(date, text)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_numbers_balance_end(date, text)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_numbers_answer(uuid, uuid, jsonb, text, jsonb)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_member_company_numbers(uuid, text, jsonb)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_company_numbers(uuid, text, jsonb) to authenticated;
revoke all on function public.qorpera_run_company_numbers(uuid, jsonb, text, jsonb)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_run_company_numbers(uuid, jsonb, text, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_run_company_numbers', 'folder');
