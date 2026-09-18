-- pg_timezone_names computes the current offset for every zone even when only
-- one name is requested. On the deployed database each scan takes ~1.5s; the
-- two validations in read_native_wake exceed its three-second RPC deadline.
-- Keep the exact case-sensitive accepted-name set, indexed and writable only
-- by the migration owner. Refresh this catalog in a new migration when the
-- database tzdata adds or removes names; offsets still come from PostgreSQL.
create table public.qorpera_runtime_time_zone_names (
	name text collate "C" primary key
);
insert into public.qorpera_runtime_time_zone_names(name)
select name from pg_catalog.pg_timezone_names;
alter table public.qorpera_runtime_time_zone_names enable row level security;
revoke all on public.qorpera_runtime_time_zone_names from public,anon,authenticated,service_role;

create function public.qorpera_runtime_time_zone_name_valid(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_runtime_time_zone_names where name = p_name collate "C")
$$;
revoke all on function public.qorpera_runtime_time_zone_name_valid(text) from public,anon,authenticated,service_role;

-- Existing validator owners can differ from the applying role. Give only
-- those exact owners the private catalog predicate, with no API write grant.
-- The closed, read-only validators run as those owners so an authorized
-- caller does not need direct authority over this implementation catalog.
do $$
declare v_owner text;
begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc
		where oid in ('public.qorpera_cloud_routine_trigger_valid(jsonb)'::regprocedure,
			'public.qorpera_cloud_routine_trigger_before_wake_bus(jsonb)'::regprocedure)
	loop
		execute format('grant execute on function public.qorpera_runtime_time_zone_name_valid(text) to %I',v_owner);
	end loop;
end $$;

create or replace function public.qorpera_cloud_routine_trigger_before_wake_bus(p_trigger jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_interval integer; v_weekdays text[];
begin
	if p_trigger is null or jsonb_typeof(p_trigger) <> 'object'
		or not (p_trigger ?& array['id', 'kind', 'intervalMinutes'])
		or jsonb_typeof(p_trigger -> 'id') <> 'string'
		or p_trigger ->> 'id' <> btrim(p_trigger ->> 'id')
		or octet_length(convert_to(p_trigger ->> 'id', 'utf8')) not between 1 and 160
		or p_trigger ->> 'id' ~ E'[\r\n]'
		or p_trigger ->> 'kind' <> 'schedule'
		or jsonb_typeof(p_trigger -> 'intervalMinutes') <> 'number'
		or (p_trigger ->> 'intervalMinutes') !~ '^[0-9]+$' then return false; end if;
	v_interval := (p_trigger ->> 'intervalMinutes')::integer;
	if v_interval not between 5 and 10080 then return false; end if;
	if p_trigger ? 'weekdays' or p_trigger ? 'localTime' or p_trigger ? 'timeZone' then
		if not (p_trigger ?& array['weekdays', 'localTime', 'timeZone'])
			or p_trigger ? 'startAt'
			or (p_trigger - 'id' - 'kind' - 'intervalMinutes' - 'weekdays' - 'localTime' - 'timeZone') <> '{}'::jsonb
			or jsonb_typeof(p_trigger -> 'weekdays') <> 'array'
			or jsonb_array_length(p_trigger -> 'weekdays') not between 1 and 7
			or jsonb_typeof(p_trigger -> 'localTime') <> 'string'
			or (p_trigger ->> 'localTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			or jsonb_typeof(p_trigger -> 'timeZone') <> 'string'
			or char_length(p_trigger ->> 'timeZone') not between 1 and 128
			or p_trigger ->> 'timeZone' = 'auto'
			or not public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone') then return false; end if;
		select array_agg(day.value order by day.ordinality) into v_weekdays
		from jsonb_array_elements_text(p_trigger -> 'weekdays') with ordinality as day(value, ordinality);
		if cardinality(v_weekdays) <> jsonb_array_length(p_trigger -> 'weekdays')
			or cardinality(v_weekdays) <> (select count(distinct weekday) from unnest(v_weekdays) as item(weekday))
			or exists (select 1 from unnest(v_weekdays) as item(weekday)
				where item.weekday not in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday')) then return false; end if;
	else
		if (p_trigger - 'id' - 'kind' - 'intervalMinutes' - 'startAt') <> '{}'::jsonb then return false; end if;
		if p_trigger ? 'startAt' then
			if jsonb_typeof(p_trigger -> 'startAt') <> 'string'
				or (p_trigger ->> 'startAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' then return false; end if;
			if not isfinite((p_trigger ->> 'startAt')::timestamptz) then return false; end if;
		end if;
	end if;
	return true;
exception when others then return false;
end $$;

create or replace function public.qorpera_cloud_routine_trigger_valid(p_trigger jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	if jsonb_typeof(p_trigger) is distinct from 'object'
		or (p_trigger ? 'replyPolicy' and (jsonb_typeof(p_trigger -> 'replyPolicy') <> 'string'
			or p_trigger ->> 'replyPolicy' not in ('optional','required','silent'))) then return false; end if;
	if p_trigger ->> 'kind' = 'schedule' then
		return public.qorpera_cloud_routine_trigger_before_wake_bus(p_trigger - 'replyPolicy');
	end if;
	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'
		and p_trigger ?& array['id','kind','source','path','match','timeZone']
		and p_trigger - array['id','kind','source','path','match','timeZone','replyPolicy'] = '{}'::jsonb
		and jsonb_typeof(p_trigger -> 'id') = 'string'
		and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		and jsonb_typeof(p_trigger -> 'path') = 'string'
		and public.qorpera_company_path_valid(p_trigger ->> 'path',p_trigger ->> 'match' = 'subtree')
		and p_trigger ->> 'match' in ('exact','subtree')
		and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
		and public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone'),false);
exception when others then return false;
end $$;
