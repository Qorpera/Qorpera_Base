-- 20260930769000: the company's money in and out each day, by kind (company views, step 3, slice M2:
-- lanes/company-views-20261114/DESIGN-3.md §B and §E). The vault's bank sync (20260930523000) reduces the booked
-- transactions of the accounts the member shares now to the bank summary; the same reading now also gives each day's
-- money in and money out, summed by a kind word, and the vault records them here before it finishes the sync. Only the vault knows which accounts count now (the transactions table keeps an earlier bank's rows too), so SQL
-- never makes these days itself. The company's numbers (`money-days`, `money-kinds` over any range) read them.
--
-- - qorpera_bank_days: one row a company, day, direction and kind, with the kroner (always positive) and how many
--   payments. Kinds out are the summary's categories as words (salaries, taxes, rent, utilities, subscriptions, fees,
--   other); kinds in say what paid, never who (sales: payment providers' payouts; tax: the tax authority's refunds;
--   other). No party, transfer text, account or single payment is kept: a day's kind with one payment is that payment's
--   amount and day, which the members who may read it see on the Bank page anyway.
-- - qorpera_bank_days_cover: the days a company's rows cover, so a reader tells a day without money moving (inside the
--   cover, no row) from a day nobody counted (outside it), and the bank secret they were counted under. Every row lies
--   inside the cover; a write under another bank secret (another bank) clears the company's days first.
-- - Days are the company's own: "today" and every day are dates in the company's time zone (qorpera_profiles.time_zone,
--   20260930739000), Europe/Copenhagen when it has none or one the database does not know
--   (qorpera_bank_days_time_zone, the rule the company's numbers read by too). The vault learns the zone from the answer
--   that hands it the kept transactions: qorpera_record_bank_transactions gains `timeZone` (a vault from before this
--   reads only the keys it knows).
--
-- Only the vault's own function reaches them (as the broker role, with the company's authority, under the sync's live
-- lease); they go with the company. A vault from before this migration never calls it, so a company's days stay empty
-- until a vault with the new reduction syncs it.

create table public.qorpera_bank_days (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	-- A calendar day in the company's time zone: a booked transaction's date is its bank's own day.
	day date not null,
	direction text not null check (direction in ('in', 'out')),
	kind text not null check (
		(direction = 'in' and kind in ('sales', 'tax', 'other'))
		or (direction = 'out' and kind in ('salaries', 'taxes', 'rent', 'utilities', 'subscriptions', 'fees', 'other'))
	),
	amount numeric(18, 2) not null check (amount >= 0),
	count integer not null check (count > 0),
	primary key (profile_id, day, direction, kind)
);
alter table public.qorpera_bank_days enable row level security;
revoke all on public.qorpera_bank_days from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_bank_days_cover (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	-- The bank secret (qorpera_cloud_secrets.id) whose sync wrote the days.
	secret_id uuid not null,
	first_day date not null,
	last_day date not null,
	written_at timestamptz not null,
	check (first_day <= last_day)
);
alter table public.qorpera_bank_days_cover enable row level security;
revoke all on public.qorpera_bank_days_cover from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The company's time zone for its days: its own when the database knows the name, else Europe/Copenhagen.
create function public.qorpera_bank_days_time_zone(p_profile_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce((select profile.time_zone from public.qorpera_profiles as profile
		where profile.id = p_profile_id and profile.time_zone is not null
			and public.qorpera_runtime_time_zone_name_valid(profile.time_zone)), 'Europe/Copenhagen')
$$;
revoke all on function public.qorpera_bank_days_time_zone(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The leased sync's days (this claim's lease only): the company's rows from p_from to p_to are replaced by p_days in
-- one call. Under the cover's bank secret, the cover grows by the range when it meets or touches it (older days stay,
-- e.g. beyond the 13 months the vault reads back); a range apart from it, or a write under another bank secret, starts
-- a new cover and every row outside it goes. At most 400 days, ending no later than tomorrow in the company's time zone
-- (the vault's clock may run a little ahead); each day in the range at most once a direction and kind.
create function public.qorpera_record_bank_days(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_lease_id uuid,
	p_from date,
	p_to date,
	p_days jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_sync public.qorpera_bank_syncs%rowtype;
	v_cover public.qorpera_bank_days_cover%rowtype;
	v_now timestamptz := clock_timestamp();
	v_first date;
	v_last date;
	v_rows integer;
begin
	v_authority := public.qorpera_bank_sync_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_from is null or p_to is null or p_from > p_to or p_to - p_from >= 400
		or p_to > (v_now at time zone public.qorpera_bank_days_time_zone(v_authority.profile_id))::date + 1
		or jsonb_typeof(p_days) is distinct from 'array' or jsonb_array_length(p_days) > 4000
		or exists (select 1 from jsonb_array_elements(p_days) as item(value)
			where jsonb_typeof(item.value) <> 'object'
				or (select array_agg(field.name order by field.name collate "C") from jsonb_object_keys(item.value) as field(name))
					is distinct from array['amount', 'count', 'day', 'direction', 'kind']
				or jsonb_typeof(item.value->'day') <> 'string' or item.value->>'day' !~ '^\d{4}-\d{2}-\d{2}$'
				or jsonb_typeof(item.value->'direction') <> 'string' or jsonb_typeof(item.value->'kind') <> 'string'
				or jsonb_typeof(item.value->'amount') <> 'number' or jsonb_typeof(item.value->'count') <> 'number') then
		raise exception 'bank days are invalid' using errcode = '22023';
	end if;
	select sync.* into v_sync
	from public.qorpera_bank_syncs as sync
	where sync.profile_id = v_authority.profile_id
	for update;
	if v_sync.profile_id is null or v_sync.secret_id is distinct from p_secret_id
		or v_sync.secret_version is distinct from p_secret_version or v_sync.lease_id is distinct from p_lease_id
		or v_sync.lease_until is null or v_sync.lease_until <= v_now then
		raise exception 'bank sync is not leased' using errcode = '55000';
	end if;
	select cover.* into v_cover
	from public.qorpera_bank_days_cover as cover
	where cover.profile_id = v_authority.profile_id
	for update;
	if v_cover.profile_id is not null and v_cover.secret_id = p_secret_id
		and v_cover.first_day <= p_to + 1 and v_cover.last_day >= p_from - 1 then
		v_first := least(v_cover.first_day, p_from);
		v_last := greatest(v_cover.last_day, p_to);
	else
		v_first := p_from;
		v_last := p_to;
	end if;
	begin
		if exists (select 1 from jsonb_array_elements(p_days) as item(value)
			where (item.value->>'day')::date not between p_from and p_to) then
			raise exception 'bank days are invalid' using errcode = '22023';
		end if;
		delete from public.qorpera_bank_days as kept
		where kept.profile_id = v_authority.profile_id
			and (kept.day between p_from and p_to or kept.day not between v_first and v_last);
		insert into public.qorpera_bank_days (profile_id, day, direction, kind, amount, count)
		select v_authority.profile_id, (item.value->>'day')::date, item.value->>'direction', item.value->>'kind',
			(item.value->>'amount')::numeric(18, 2), (item.value->>'count')::integer
		from jsonb_array_elements(p_days) as item(value);
		get diagnostics v_rows = row_count;
	exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
		or numeric_value_out_of_range or check_violation or not_null_violation or unique_violation then
		raise exception 'bank days are invalid' using errcode = '22023';
	end;
	insert into public.qorpera_bank_days_cover as cover (profile_id, secret_id, first_day, last_day, written_at)
	values (v_authority.profile_id, p_secret_id, v_first, v_last, v_now)
	on conflict (profile_id) do update
	set secret_id = excluded.secret_id, first_day = excluded.first_day, last_day = excluded.last_day,
		written_at = excluded.written_at;
	return jsonb_build_object('schema', 'qorpera.bank-days-result/v1', 'firstDay', v_first, 'lastDay', v_last,
		'rows', v_rows);
end
$$;
revoke all on function public.qorpera_record_bank_days(uuid, text, uuid, bigint, uuid, date, date, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_bank_days(uuid, text, uuid, bigint, uuid, date, date, jsonb)
	to qorpera_secret_broker;

-- The answer that hands the vault the kept transactions also says the company's time zone. A vault from before this
-- reads only the keys it knows (cloud-bank-sync.ts, parseKept).
do $$
declare
	v_definition text := pg_get_functiondef(
		'public.qorpera_record_bank_transactions(uuid,text,uuid,bigint,uuid,jsonb,jsonb)'::regprocedure);
	v_old text := $old$return jsonb_build_object('schema', 'qorpera.bank-transactions-kept/v1', 'transactions', v_kept);$old$;
begin
	if position('20260930769000' in v_definition) > 0 then
		raise exception '20260930769000 is already in qorpera_record_bank_transactions'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930769000 anchor differs in qorpera_record_bank_transactions'; end if;
	execute replace(v_definition, v_old, $new$-- 20260930769000: the company's time zone, whose dates its days are.
	return jsonb_build_object('schema', 'qorpera.bank-transactions-kept/v1', 'transactions', v_kept,
		'timeZone', public.qorpera_bank_days_time_zone(v_authority.profile_id));$new$);
end $$;
