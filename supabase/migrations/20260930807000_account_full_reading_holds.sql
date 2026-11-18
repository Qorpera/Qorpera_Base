do $$ begin
	if to_regclass('public.qorpera_native_account_usage_marks') is not null then
		raise exception '20260930807000 is already applied'; end if;
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure), '20260930724000') = 0 then
		raise exception '20260930807000 needs 20260930724000'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.account_hold_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930807000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

create table public.qorpera_native_account_usage_marks (
	owner_user_id uuid not null references auth.users(id) on delete cascade,
	provider text not null,
	provider_account_identity text not null check (provider_account_identity ~ '^[0-9a-f]{64}$'),
	full_observed_at timestamptz,
	full_until timestamptz,
	room_observed_at timestamptz,
	primary key (owner_user_id, provider, provider_account_identity),
	check ((full_observed_at is null) = (full_until is null) and full_until > full_observed_at),
	check (full_observed_at is not null or room_observed_at is not null)
);
alter table public.qorpera_native_account_usage_marks enable row level security;
revoke all on public.qorpera_native_account_usage_marks from public, anon, authenticated, service_role;

create function public.qorpera_note_native_account_reading(p_connection_id uuid, p_connection_version bigint,
	p_identity text, p_usage jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_provider text; v_observed timestamptz; v_room boolean; v_full_until timestamptz;
begin
	if p_identity is null or jsonb_typeof(p_usage -> 'observedAt') is distinct from 'string'
		or jsonb_typeof(p_usage -> 'windows') is distinct from 'array' or jsonb_array_length(p_usage -> 'windows') = 0 then
		return; end if;
	select owner.id, connection.provider into v_owner, v_provider
	from public.qorpera_provider_connections as connection
	join auth.users as owner on owner.id = connection.owner_user_id
	join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
		and version.version = p_connection_version
	where connection.id = p_connection_id and connection.status = 'active' and version.authorization_state = 'active'
		and version.authentication_mode = 'native_subscription'
		and not exists (select 1 from public.qorpera_provider_connection_versions as newer
			where newer.connection_id = connection.id and newer.version > version.version);
	if v_owner is null then return; end if;
	v_observed := (p_usage ->> 'observedAt')::timestamptz;
	v_room := not exists (select 1 from jsonb_array_elements(p_usage -> 'windows') as w
		where jsonb_typeof(w -> 'usedPercent') is distinct from 'number' or (w ->> 'usedPercent')::numeric < 0
			or (w ->> 'usedPercent')::numeric >= 100
			or (w ? 'resetAt' and (w ->> 'resetAt')::timestamptz <= v_observed));
	select max((w ->> 'resetAt')::timestamptz) into v_full_until
	from jsonb_array_elements(p_usage -> 'windows') as w
	where jsonb_typeof(w -> 'usedPercent') = 'number' and (w ->> 'usedPercent')::numeric >= 100
		and jsonb_typeof(w -> 'resetAt') = 'string'
		and (w ->> 'resetAt')::timestamptz > v_observed
		and (w ->> 'resetAt')::timestamptz < v_observed + interval '90 days';
	if not v_room and v_full_until is null then return; end if;
	insert into public.qorpera_native_account_usage_marks as mark(owner_user_id, provider, provider_account_identity,
		full_observed_at, full_until, room_observed_at)
	values (v_owner, v_provider, p_identity, case when not v_room then v_observed end, case when not v_room then v_full_until end,
		case when v_room then v_observed end)
	on conflict (owner_user_id, provider, provider_account_identity) do update set
		full_observed_at = case when excluded.full_observed_at >= coalesce(mark.full_observed_at, '-infinity')
			then excluded.full_observed_at else mark.full_observed_at end,
		full_until = case when excluded.full_observed_at >= coalesce(mark.full_observed_at, '-infinity')
			then excluded.full_until else mark.full_until end,
		room_observed_at = greatest(mark.room_observed_at, excluded.room_observed_at);
end $$;
revoke all on function public.qorpera_note_native_account_reading(uuid, bigint, text, jsonb)
	from public, anon, authenticated, service_role;

create function public.qorpera_native_account_reading_noted()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_note_native_account_reading(new.connection_id, new.connection_version,
		new.provider_account_identity, new.provider_account_usage);
	return null;
end $$;
revoke all on function public.qorpera_native_account_reading_noted() from public, anon, authenticated, service_role;

create trigger qorpera_native_account_reading_noted
after insert or update of provider_account_usage, provider_account_identity
on public.qorpera_native_provider_account_metadata
for each row when (new.provider_account_usage is not null and new.provider_account_identity is not null)
execute function public.qorpera_native_account_reading_noted();

create function public.qorpera_native_account_full_reading_hold(p_connection_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select mark.full_until
	from public.qorpera_provider_connections as connection
	cross join lateral (select v.version from public.qorpera_provider_connection_versions as v
		where v.connection_id = connection.id order by v.version desc limit 1) as current_version
	join public.qorpera_native_provider_account_metadata as own on own.connection_id = connection.id
		and own.connection_version = current_version.version
	join public.qorpera_native_account_usage_marks as mark on mark.owner_user_id = connection.owner_user_id
		and mark.provider = connection.provider and mark.provider_account_identity = own.provider_account_identity
	where connection.id = p_connection_id and mark.full_until > statement_timestamp()
		and (mark.room_observed_at is null or mark.room_observed_at < mark.full_observed_at)
$$;
revoke all on function public.qorpera_native_account_full_reading_hold(uuid) from public, anon, authenticated, service_role;

select pg_temp.account_hold_replace('public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
	E'\treturn v_reset;\n',
	E'\treturn greatest(v_reset, public.qorpera_native_account_full_reading_hold(p_connection_id));\n');

select public.qorpera_note_native_account_reading(reading.connection_id, reading.connection_version,
	reading.provider_account_identity, reading.provider_account_usage)
from public.qorpera_native_provider_account_metadata as reading
where reading.provider_account_usage is not null and reading.provider_account_identity is not null
	and jsonb_typeof(reading.provider_account_usage -> 'observedAt') = 'string';

drop function pg_temp.account_hold_replace(regprocedure, text, text);
