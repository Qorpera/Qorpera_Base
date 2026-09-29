-- Event intake, build step W1a (Q1; founder decisions of 29 September 2026: events wake agents,
-- the top priority; contract section 19, 2026-09-29 amendment "events wake agents"; design
-- deploy/first-node/RUNTIME-EVENT-INTAKE.md).
--
-- A hook is a company connection that receives events at one public address. The Edge Function
-- event-intake hands each request to qorpera_receive_event (service_role only). This step creates
-- address-proven hooks only: whoever knows the address may post, and a delivery is verified in the
-- same call. Signed hooks (Stripe, GitHub, HMAC) and their verification in the vault follow in W1b
-- (20260929260100); the table already names their proofs so W1b adds no column. Deliveries are
-- runtime state: a queue entry and a receipt. Nothing wakes yet: event wakes are step W2.
--
-- Lock order: the hook row, then its deliveries. Receives on one hook are serialized by the hook
-- lock, which makes the per-minute limit and duplicate detection exact.

set local lock_timeout = '3s';

create table public.qorpera_event_hooks (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	name text not null check (name ~ '^[a-z][a-z0-9-]{0,63}$'),
	purpose text not null check (char_length(purpose) between 1 and 512 and purpose = btrim(purpose)),
	proof text not null check (proof in ('address', 'stripe', 'github', 'hmac-sha256')),
	address text not null unique check (address ~ '^[A-Za-z0-9_-]{43}$'),
	status text not null default 'active' check (status in ('active', 'paused', 'removed')),
	max_body_bytes integer not null default 262144 check (max_body_bytes between 1024 and 1048576),
	per_minute integer not null default 120 check (per_minute between 1 and 600),
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_by_staff_agent_id uuid,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	removed_at timestamptz,
	received_count bigint not null default 0 check (received_count >= 0),
	refused_count bigint not null default 0 check (refused_count >= 0),
	last_received_at timestamptz,
	check ((status = 'removed') = (removed_at is not null)),
	check (created_by_user_id is null or created_by_staff_agent_id is null)
);

create unique index qorpera_event_hooks_live_name
	on public.qorpera_event_hooks (profile_id, environment_id, name)
	where status <> 'removed';
create index qorpera_event_hooks_company on public.qorpera_event_hooks (profile_id, environment_id);

create table public.qorpera_event_deliveries (
	id uuid primary key default extensions.gen_random_uuid(),
	hook_id uuid not null references public.qorpera_event_hooks(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	received_at timestamptz not null default clock_timestamp(),
	status text not null check (status in ('received', 'verified', 'refused', 'duplicate')),
	delivery_key text check (delivery_key is null or (char_length(delivery_key) between 1 and 256
		and delivery_key ~ '^[\x21-\x7e]+$')),
	event_type text check (event_type is null or (char_length(event_type) between 1 and 128
		and event_type ~ '^[\x21-\x7e]+$')),
	content_type text check (content_type is null or char_length(content_type) between 1 and 256),
	headers jsonb not null default '{}'::jsonb check (jsonb_typeof(headers) = 'object'
		and octet_length(headers::text) <= 8192),
	body bytea check (body is null or octet_length(body) <= 1048576),
	body_bytes integer not null check (body_bytes between 0 and 1048576),
	body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
	verified_at timestamptz,
	reason text check (reason is null or char_length(reason) between 1 and 500),
	check ((status in ('verified', 'duplicate')) = (verified_at is not null)),
	check (status = 'received' or delivery_key is not null or status = 'refused')
);

-- A verified delivery is unique per hook and sender id while its row lives (30 days).
create unique index qorpera_event_deliveries_verified_key
	on public.qorpera_event_deliveries (hook_id, delivery_key)
	where status = 'verified';
create index qorpera_event_deliveries_hook_received on public.qorpera_event_deliveries (hook_id, received_at);
create index qorpera_event_deliveries_received_at on public.qorpera_event_deliveries (received_at);
create index qorpera_event_deliveries_waiting on public.qorpera_event_deliveries (received_at)
	where status = 'received';

alter table public.qorpera_event_hooks enable row level security;
alter table public.qorpera_event_deliveries enable row level security;
revoke all on table public.qorpera_event_hooks from public, anon, authenticated, service_role;
revoke all on table public.qorpera_event_deliveries from public, anon, authenticated, service_role;

-- The headers the intake keeps (design "Deliveries"). Everything else never reaches the database.
create function public.qorpera_event_kept_headers()
returns text[]
language sql
immutable
set search_path = ''
as $$
	select array[
		'content-type', 'user-agent', 'stripe-signature', 'x-hub-signature-256', 'x-github-event',
		'x-github-delivery', 'x-github-hook-id', 'x-qorpera-signature', 'x-qorpera-timestamp',
		'x-qorpera-delivery', 'x-qorpera-event', 'idempotency-key', 'webhook-id', 'webhook-timestamp',
		'webhook-signature', 'svix-id', 'svix-timestamp', 'svix-signature']
$$;
revoke all on function public.qorpera_event_kept_headers() from public, anon, authenticated, service_role;

create function public.qorpera_event_hook_descriptor(p_hook public.qorpera_event_hooks, p_with_address boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
	select jsonb_strip_nulls(jsonb_build_object(
		'schema', 'qorpera.event-hook/v1',
		'id', p_hook.id,
		'companyId', p_hook.profile_id,
		'environmentId', p_hook.environment_id,
		'name', p_hook.name,
		'purpose', p_hook.purpose,
		'proof', p_hook.proof,
		'status', p_hook.status,
		'address', case when p_with_address then p_hook.address end,
		'path', case when p_with_address then '/functions/v1/event-intake/' || p_hook.address end,
		'maxBodyBytes', p_hook.max_body_bytes,
		'perMinute', p_hook.per_minute,
		'createdAt', p_hook.created_at,
		'receivedCount', p_hook.received_count,
		'refusedCount', p_hook.refused_count,
		'lastReceivedAt', p_hook.last_received_at))
$$;
revoke all on function public.qorpera_event_hook_descriptor(public.qorpera_event_hooks, boolean)
	from public, anon, authenticated, service_role;

-- An owner or admin creates a hook. W1a creates address-proven hooks only; W1b opens the signed
-- proofs when the vault can check them.
create function public.qorpera_create_event_hook(
	p_profile_id uuid,
	p_environment_id uuid,
	p_name text,
	p_purpose text,
	p_proof text default 'address',
	p_max_body_bytes integer default null,
	p_per_minute integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := public.qorpera_member_role(p_profile_id)::text;
	v_hook public.qorpera_event_hooks%rowtype;
begin
	if auth.uid() is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only owners and admins can create hooks' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_company_environments as environment
		where environment.id = p_environment_id and environment.profile_id = p_profile_id
	) then
		raise exception 'The company environment is invalid' using errcode = '22023';
	end if;
	if p_name is null or p_name !~ '^[a-z][a-z0-9-]{0,63}$' then
		raise exception 'A hook name uses lowercase letters, digits and hyphens, starts with a letter and has at most 64 characters'
			using errcode = '22023';
	end if;
	if p_purpose is null or char_length(btrim(p_purpose)) not between 1 and 512 then
		raise exception 'A hook needs a purpose of 1 to 512 characters' using errcode = '22023';
	end if;
	if p_proof is distinct from 'address' then
		raise exception 'Only address-proven hooks can be created yet' using errcode = '0A000';
	end if;
	if p_max_body_bytes is not null and p_max_body_bytes not between 1024 and 1048576 then
		raise exception 'A hook body limit is between 1 KiB and 1 MiB' using errcode = '22023';
	end if;
	if p_per_minute is not null and p_per_minute not between 1 and 600 then
		raise exception 'A hook accepts between 1 and 600 deliveries a minute' using errcode = '22023';
	end if;
	-- Serialize hook creation per company so the limit of 50 holds.
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	if (select count(*) from public.qorpera_event_hooks as hook
		where hook.profile_id = p_profile_id and hook.status <> 'removed') >= 50 then
		raise exception 'A company has at most 50 hooks' using errcode = '54000';
	end if;
	if exists (
		select 1 from public.qorpera_event_hooks as hook
		where hook.profile_id = p_profile_id and hook.environment_id = p_environment_id
			and hook.name = p_name and hook.status <> 'removed'
	) then
		raise exception 'A hook with this name already exists' using errcode = '23505';
	end if;
	insert into public.qorpera_event_hooks (
		profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute,
		created_by_user_id
	) values (
		p_profile_id, p_environment_id, p_name, btrim(p_purpose), p_proof,
		translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
		coalesce(p_max_body_bytes, 262144), coalesce(p_per_minute, 120), auth.uid()
	) returning * into v_hook;
	return public.qorpera_event_hook_descriptor(v_hook, true);
end
$$;
revoke all on function public.qorpera_create_event_hook(uuid, uuid, text, text, text, integer, integer)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_create_event_hook(uuid, uuid, text, text, text, integer, integer)
	to authenticated;

-- An owner or admin pauses, resumes or removes a hook. Removing is final and frees the name.
create function public.qorpera_set_event_hook_status(p_hook_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_hook public.qorpera_event_hooks%rowtype;
	v_role text;
begin
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id for update;
	v_role := public.qorpera_member_role(v_hook.profile_id)::text;
	if v_hook.id is null or auth.uid() is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only owners and admins can change hooks' using errcode = '42501';
	end if;
	if p_status is null or p_status not in ('active', 'paused', 'removed') then
		raise exception 'A hook is active, paused or removed' using errcode = '22023';
	end if;
	if v_hook.status = 'removed' then
		raise exception 'This hook was removed' using errcode = '55000';
	end if;
	if v_hook.status <> p_status then
		update public.qorpera_event_hooks
		set status = p_status,
			removed_at = case when p_status = 'removed' then statement_timestamp() end,
			updated_at = statement_timestamp()
		where id = v_hook.id
		returning * into v_hook;
	end if;
	return public.qorpera_event_hook_descriptor(v_hook, v_hook.status <> 'removed');
end
$$;
revoke all on function public.qorpera_set_event_hook_status(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_set_event_hook_status(uuid, text) to authenticated;

-- Every member sees the company's hooks; only owners and admins see their addresses.
create function public.qorpera_list_event_hooks(p_profile_id uuid, p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_role text := public.qorpera_member_role(p_profile_id)::text;
begin
	if auth.uid() is null or v_role is null then
		raise exception 'Company access is required' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(public.qorpera_event_hook_descriptor(hook, v_role in ('owner', 'admin')) order by hook.name)
		from public.qorpera_event_hooks as hook
		where hook.profile_id = p_profile_id and hook.environment_id = p_environment_id
			and hook.status <> 'removed'
	), '[]'::jsonb);
end
$$;
revoke all on function public.qorpera_list_event_hooks(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_list_event_hooks(uuid, uuid) to authenticated;

-- An owner or admin reads a hook's recent deliveries, without their bodies, to see what arrived.
create function public.qorpera_list_event_deliveries(p_hook_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_hook public.qorpera_event_hooks%rowtype;
	v_role text;
begin
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id;
	v_role := public.qorpera_member_role(v_hook.profile_id)::text;
	if v_hook.id is null or auth.uid() is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only owners and admins can read deliveries' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
			'id', delivery.id,
			'receivedAt', delivery.received_at,
			'status', delivery.status,
			'deliveryKey', delivery.delivery_key,
			'eventType', delivery.event_type,
			'contentType', delivery.content_type,
			'bodyBytes', delivery.body_bytes,
			'bodySha256', delivery.body_sha256,
			'verifiedAt', delivery.verified_at,
			'reason', delivery.reason)) order by delivery.received_at desc, delivery.id)
		from (
			select * from public.qorpera_event_deliveries as recent
			where recent.hook_id = v_hook.id
			order by recent.received_at desc, recent.id
			limit greatest(1, least(coalesce(p_limit, 50), 200))
		) as delivery
	), '[]'::jsonb);
end
$$;
revoke all on function public.qorpera_list_event_deliveries(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_list_event_deliveries(uuid, integer) to authenticated;

-- The intake's one door (Edge Function event-intake, service_role). Returns the outcome the
-- function turns into an HTTP answer: accepted, duplicate, unknown, paused, not_ready, too_large or
-- limited. Malformed input from the function itself raises 22023.
create function public.qorpera_receive_event(
	p_address text,
	p_content_type text,
	p_headers jsonb,
	p_body_base64 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_hook public.qorpera_event_hooks%rowtype;
	v_body bytea;
	v_body_sha256 text;
	v_headers jsonb := '{}'::jsonb;
	v_key text;
	v_value jsonb;
	v_delivery_key text;
	v_event_type text;
	v_delivery_id uuid;
begin
	if p_headers is null or jsonb_typeof(p_headers) <> 'object' or octet_length(p_headers::text) > 8192
		or p_body_base64 is null or char_length(p_body_base64) > 1398104
		or (p_content_type is not null and char_length(p_content_type) not between 1 and 256) then
		raise exception 'The delivery is malformed' using errcode = '22023';
	end if;
	for v_key, v_value in select key, value from jsonb_each(p_headers) loop
		if v_key <> lower(v_key) or not (v_key = any (public.qorpera_event_kept_headers()))
			or jsonb_typeof(v_value) <> 'string' or char_length(v_value #>> '{}') > 2048 then
			raise exception 'The delivery carries a header the intake does not keep: %', left(v_key, 64)
				using errcode = '22023';
		end if;
		v_headers := v_headers || jsonb_build_object(v_key, v_value);
	end loop;
	begin
		v_body := decode(p_body_base64, 'base64');
	exception when others then
		raise exception 'The delivery body is not base64' using errcode = '22023';
	end;
	if octet_length(v_body) > 1048576 then
		raise exception 'The delivery body is over 1 MiB' using errcode = '22023';
	end if;

	if p_address is null or p_address !~ '^[A-Za-z0-9_-]{43}$' then
		return jsonb_build_object('outcome', 'unknown');
	end if;
	select hook.* into v_hook
	from public.qorpera_event_hooks as hook
	where hook.address = p_address
	for update;
	if not found or v_hook.status = 'removed' or public.qorpera_company_deleting(v_hook.profile_id) then
		return jsonb_build_object('outcome', 'unknown');
	end if;
	if v_hook.status = 'paused' then
		update public.qorpera_event_hooks set refused_count = refused_count + 1 where id = v_hook.id;
		return jsonb_build_object('outcome', 'paused');
	end if;
	if octet_length(v_body) > v_hook.max_body_bytes then
		update public.qorpera_event_hooks set refused_count = refused_count + 1 where id = v_hook.id;
		return jsonb_build_object('outcome', 'too_large', 'maxBodyBytes', v_hook.max_body_bytes);
	end if;
	if (select count(*) from public.qorpera_event_deliveries as recent
		where recent.hook_id = v_hook.id and recent.received_at > clock_timestamp() - interval '60 seconds')
		>= v_hook.per_minute then
		update public.qorpera_event_hooks set refused_count = refused_count + 1 where id = v_hook.id;
		return jsonb_build_object('outcome', 'limited', 'retryAfterSeconds', 60);
	end if;
	if v_hook.proof <> 'address' then
		-- Signed hooks are verified by the vault (W1b); until then they take nothing.
		update public.qorpera_event_hooks set refused_count = refused_count + 1 where id = v_hook.id;
		return jsonb_build_object('outcome', 'not_ready');
	end if;

	v_body_sha256 := encode(extensions.digest(v_body, 'sha256'), 'hex');
	v_delivery_key := coalesce(v_headers ->> 'x-qorpera-delivery', v_headers ->> 'idempotency-key');
	if v_delivery_key is null or char_length(v_delivery_key) not between 1 and 256
		or v_delivery_key !~ '^[\x21-\x7e]+$' then
		v_delivery_key := 'sha256:' || v_body_sha256;
	end if;
	v_event_type := v_headers ->> 'x-qorpera-event';
	if v_event_type is not null and (char_length(v_event_type) not between 1 and 128
		or v_event_type !~ '^[\x21-\x7e]+$') then
		v_event_type := null;
	end if;

	update public.qorpera_event_hooks
	set received_count = received_count + 1, last_received_at = clock_timestamp()
	where id = v_hook.id;
	if exists (
		select 1 from public.qorpera_event_deliveries as earlier
		where earlier.hook_id = v_hook.id and earlier.status = 'verified' and earlier.delivery_key = v_delivery_key
	) then
		insert into public.qorpera_event_deliveries (
			hook_id, profile_id, status, delivery_key, event_type, content_type, headers,
			body, body_bytes, body_sha256, verified_at, reason
		) values (
			v_hook.id, v_hook.profile_id, 'duplicate', v_delivery_key, v_event_type, p_content_type, v_headers,
			null, octet_length(v_body), v_body_sha256, clock_timestamp(), 'An earlier delivery had this key'
		) returning id into v_delivery_id;
		return jsonb_build_object('outcome', 'duplicate', 'deliveryId', v_delivery_id);
	end if;
	insert into public.qorpera_event_deliveries (
		hook_id, profile_id, status, delivery_key, event_type, content_type, headers,
		body, body_bytes, body_sha256, verified_at
	) values (
		v_hook.id, v_hook.profile_id, 'verified', v_delivery_key, v_event_type, p_content_type, v_headers,
		v_body, octet_length(v_body), v_body_sha256, clock_timestamp()
	) returning id into v_delivery_id;
	return jsonb_build_object('outcome', 'accepted', 'deliveryId', v_delivery_id);
end
$$;
revoke all on function public.qorpera_receive_event(text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_receive_event(text, text, jsonb, text) to service_role;

-- Retention, scheduled by the coordinator (pg_cron, hourly): a delivery still waiting for the vault
-- after 24 hours is refused, rows are deleted after 30 days, and bodies are cleared after 7.
create function public.qorpera_purge_event_deliveries(p_limit integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 10000));
	v_expired integer;
	v_cleared integer;
	v_deleted integer;
begin
	with waiting as (
		select delivery.id from public.qorpera_event_deliveries as delivery
		where delivery.status = 'received' and delivery.received_at < clock_timestamp() - interval '24 hours'
		order by delivery.received_at limit v_limit
		for update skip locked
	)
	update public.qorpera_event_deliveries as delivery
	set status = 'refused', reason = 'Not verified in time'
	from waiting where delivery.id = waiting.id;
	get diagnostics v_expired = row_count;

	with old as (
		select delivery.id from public.qorpera_event_deliveries as delivery
		where delivery.received_at < clock_timestamp() - interval '30 days'
		order by delivery.received_at limit v_limit
		for update skip locked
	)
	delete from public.qorpera_event_deliveries as delivery
	using old where delivery.id = old.id;
	get diagnostics v_deleted = row_count;

	with old as (
		select delivery.id from public.qorpera_event_deliveries as delivery
		where delivery.body is not null and delivery.received_at < clock_timestamp() - interval '7 days'
		order by delivery.received_at limit v_limit
		for update skip locked
	)
	update public.qorpera_event_deliveries as delivery
	set body = null
	from old where delivery.id = old.id;
	get diagnostics v_cleared = row_count;

	return jsonb_build_object('expired', v_expired, 'cleared', v_cleared, 'deleted', v_deleted);
end
$$;
revoke all on function public.qorpera_purge_event_deliveries(integer) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_purge_event_deliveries(integer) to service_role;
