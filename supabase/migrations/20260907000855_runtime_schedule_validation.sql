-- Restore the anchored-weekday and time-window schedule forms introduced in
-- 20260827001000. The time-zone catalog optimization accidentally reinstated
-- the older validator. Keep its private indexed predicate, owner, and ACL.
create or replace function public.qorpera_cloud_routine_trigger_before_wake_bus(p_trigger jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_interval integer;
	v_months integer[];
	v_weekdays text[];
	v_window_start integer;
	v_window_end integer;
begin
	if p_trigger is null or jsonb_typeof(p_trigger) <> 'object'
		or not (p_trigger ?& array['id', 'kind', 'intervalMinutes'])
		or jsonb_typeof(p_trigger -> 'id') <> 'string'
		or p_trigger ->> 'id' <> btrim(p_trigger ->> 'id')
		or octet_length(convert_to(p_trigger ->> 'id', 'utf8')) not between 1 and 160
		or p_trigger ->> 'id' ~ E'[\r\n]'
		or p_trigger ->> 'kind' <> 'schedule'
		or jsonb_typeof(p_trigger -> 'intervalMinutes') <> 'number'
		or (p_trigger ->> 'intervalMinutes') !~ '^[0-9]+$' then
		return false;
	end if;
	v_interval := (p_trigger ->> 'intervalMinutes')::integer;
	if v_interval not between 5 and 10080 then return false; end if;

	if p_trigger ? 'months' or p_trigger ? 'windowStart' or p_trigger ? 'windowEnd' then
		if not (p_trigger ?& array['windowStart', 'windowEnd', 'timeZone'])
			or (p_trigger - 'id' - 'kind' - 'intervalMinutes' - 'months' - 'weekdays' - 'windowStart' - 'windowEnd' - 'timeZone') <> '{}'::jsonb
			or jsonb_typeof(p_trigger -> 'windowStart') <> 'string'
			or (p_trigger ->> 'windowStart') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			or jsonb_typeof(p_trigger -> 'windowEnd') <> 'string'
			or (p_trigger ->> 'windowEnd') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			or jsonb_typeof(p_trigger -> 'timeZone') <> 'string'
			or char_length(p_trigger ->> 'timeZone') not between 1 and 128
			or p_trigger ->> 'timeZone' = 'auto'
			or not public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone') then
			return false;
		end if;
		v_window_start := substring(p_trigger ->> 'windowStart' from 1 for 2)::integer * 60
			+ substring(p_trigger ->> 'windowStart' from 4 for 2)::integer;
		v_window_end := substring(p_trigger ->> 'windowEnd' from 1 for 2)::integer * 60
			+ substring(p_trigger ->> 'windowEnd' from 4 for 2)::integer;
		if v_window_start > v_window_end then return false; end if;

		if p_trigger ? 'months' then
			if jsonb_typeof(p_trigger -> 'months') <> 'array'
				or jsonb_array_length(p_trigger -> 'months') not between 1 and 12
				or exists (
					select 1 from jsonb_array_elements(p_trigger -> 'months') as month(value)
					where jsonb_typeof(month.value) <> 'number' or month.value::text !~ '^[0-9]+$'
				) then
				return false;
			end if;
			select array_agg(month.value::integer order by month.ordinality) into v_months
			from jsonb_array_elements_text(p_trigger -> 'months') with ordinality as month(value, ordinality);
			if cardinality(v_months) <> (select count(distinct value) from unnest(v_months) as item(value))
				or exists (select 1 from unnest(v_months) as item(value) where item.value not between 1 and 12) then
				return false;
			end if;
		end if;

		if p_trigger ? 'weekdays' then
			if jsonb_typeof(p_trigger -> 'weekdays') <> 'array'
				or jsonb_array_length(p_trigger -> 'weekdays') not between 1 and 7 then
				return false;
			end if;
			select array_agg(day.value order by day.ordinality) into v_weekdays
			from jsonb_array_elements_text(p_trigger -> 'weekdays') with ordinality as day(value, ordinality);
			if cardinality(v_weekdays) <> jsonb_array_length(p_trigger -> 'weekdays')
				or cardinality(v_weekdays) <> (select count(distinct weekday) from unnest(v_weekdays) as item(weekday))
				or exists (
					select 1 from unnest(v_weekdays) as item(weekday)
					where item.weekday not in (
						'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
					)
				) then
				return false;
			end if;
		end if;
	elsif p_trigger ? 'weekdays' or p_trigger ? 'localTime' or p_trigger ? 'timeZone' then
		if not (p_trigger ?& array['weekdays', 'localTime', 'timeZone'])
			or (p_trigger - 'id' - 'kind' - 'intervalMinutes' - 'startAt' - 'weekdays' - 'localTime' - 'timeZone') <> '{}'::jsonb
			or jsonb_typeof(p_trigger -> 'weekdays') <> 'array'
			or jsonb_array_length(p_trigger -> 'weekdays') not between 1 and 7
			or jsonb_typeof(p_trigger -> 'localTime') <> 'string'
			or (p_trigger ->> 'localTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			or jsonb_typeof(p_trigger -> 'timeZone') <> 'string'
			or char_length(p_trigger ->> 'timeZone') not between 1 and 128
			or p_trigger ->> 'timeZone' = 'auto'
			or not public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone') then
			return false;
		end if;
		if p_trigger ? 'startAt' then
			if jsonb_typeof(p_trigger -> 'startAt') <> 'string'
				or (p_trigger ->> 'startAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' then
				return false;
			end if;
			if not isfinite((p_trigger ->> 'startAt')::timestamptz) then return false; end if;
		end if;
		select array_agg(day.value order by day.ordinality) into v_weekdays
		from jsonb_array_elements_text(p_trigger -> 'weekdays') with ordinality as day(value, ordinality);
		if cardinality(v_weekdays) <> jsonb_array_length(p_trigger -> 'weekdays')
			or cardinality(v_weekdays) <> (select count(distinct weekday) from unnest(v_weekdays) as item(weekday))
			or exists (
				select 1 from unnest(v_weekdays) as item(weekday)
				where item.weekday not in (
					'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
				)
			) then
			return false;
		end if;
	else
		if (p_trigger - 'id' - 'kind' - 'intervalMinutes' - 'startAt') <> '{}'::jsonb then
			return false;
		end if;
		if p_trigger ? 'startAt' then
			if jsonb_typeof(p_trigger -> 'startAt') <> 'string'
				or (p_trigger ->> 'startAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' then
				return false;
			end if;
			if not isfinite((p_trigger ->> 'startAt')::timestamptz) then return false; end if;
		end if;
	end if;
	return true;
exception when others then
	return false;
end
$$;

