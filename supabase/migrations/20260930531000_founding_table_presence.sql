-- Live presence at the founding table (hub round 3, "writing the first message together", Jonas 22 October 2026):
-- who is at the table now, who is writing, and where each founder's caret is in the shared idea box.
--
-- Every seat of an open table joins one private Realtime topic, `qorpera-founding-<profile id>`: joined founders, and
-- invited people too, who read the table already (qorpera_read_company_founding). Realtime authorises a private join by
-- reading (receive) and writing (publish) realtime.messages as the joining user, with realtime.topic() set to the topic
-- being joined. The two policies below allow that on this topic only, and only for its own rows (the topic equality
-- rule of 20260930017000), to someone with a seat at that table while it is open. A started, closed or deleted table,
-- or a seat given up, joins nothing.
--
-- What a tab tracks and sends on the topic is its own claim. As on the company's presence topic (20260819011000, the
-- device registry of 20260820001000), each tab registers an opaque device id with a public signing key here, and signs
-- what it sends; the other tabs look the device up, and the seat it belongs to comes from this table's seats. So nobody
-- can appear, write or move a caret as another founder. A tab registers again every minute; a device is resolved for
-- two minutes after that and removed after five.
--
-- Realtime checks a join when it is made, and again when the tab's sign-in is renewed; a tab whose seat goes leaves the
-- topic as soon as its table read says so, and its device stops resolving at once.
--
-- Nothing here changes the table: presence is lossy and never table state, and Ready and Start do not read it.
-- Each function body carries the marker 20260930531000 for the deploy guard.

set local lock_timeout = '3s';

-- The table a topic belongs to, or null for any other topic.
create function public.qorpera_founding_topic_profile(p_topic text)
returns uuid language sql immutable set search_path = '' as $$
	-- 20260930531000: the founding table's presence topic.
	select case
		when p_topic ~ '^qorpera-founding-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			then substring(p_topic from 18)::uuid
	end
$$;
revoke all on function public.qorpera_founding_topic_profile(text) from public, anon;
grant execute on function public.qorpera_founding_topic_profile(text) to authenticated;

-- A seat (joined or invited) at a table that is still open and not being deleted: who may read the open table.
create function public.qorpera_can_join_founding_table(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930531000: the people at an open founding table.
	select p_profile_id is not null and public.qorpera_company_founding_open(p_profile_id)
		and public.qorpera_company_founding_seated(p_profile_id)
$$;
revoke all on function public.qorpera_can_join_founding_table(uuid) from public, anon;
grant execute on function public.qorpera_can_join_founding_table(uuid) to authenticated;

create policy qorpera_founding_table_receive
	on realtime.messages
	for select
	to authenticated
	using (
		realtime.messages.extension in ('presence', 'broadcast')
		and realtime.messages.topic = (select realtime.topic())
		and public.qorpera_can_join_founding_table(public.qorpera_founding_topic_profile(realtime.topic()))
	);

-- Invited people publish too: they are at the table (presence), though only joined founders write in it.
create policy qorpera_founding_table_publish
	on realtime.messages
	for insert
	to authenticated
	with check (
		realtime.messages.extension in ('presence', 'broadcast')
		and realtime.messages.topic = (select realtime.topic())
		and public.qorpera_can_join_founding_table(public.qorpera_founding_topic_profile(realtime.topic()))
	);

-- One row per open tab: its device id, the person it belongs to, and the key its messages are signed with. No client
-- reads or writes it except through the functions below.
create table public.qorpera_founding_presence_devices (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	client_id uuid not null,
	user_id uuid not null references auth.users(id) on delete cascade,
	public_key text not null check (public_key ~ '^[A-Za-z0-9+/]{40,240}={0,2}$'),
	last_seen_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, client_id)
);
create index qorpera_founding_presence_devices_expiry on public.qorpera_founding_presence_devices (last_seen_at);
alter table public.qorpera_founding_presence_devices enable row level security;
revoke all on public.qorpera_founding_presence_devices from public, anon, authenticated, service_role;

-- Register (or keep) this tab's device at the table. A device id stays with the person who registered it until it has
-- been quiet for five minutes. Devices quiet that long are removed here, a few at a time, skipping any another call
-- holds, so no registration waits for another.
create function public.qorpera_register_founding_presence(p_profile_id uuid, p_client_id uuid, p_public_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_registered integer;
begin
	-- 20260930531000: a tab's device at the founding table.
	if v_user is null or p_client_id is null or p_public_key is null
		or p_public_key !~ '^[A-Za-z0-9+/]{40,240}={0,2}$'
		or not public.qorpera_can_join_founding_table(p_profile_id) then
		raise exception 'This founding table is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_founding_presence_devices (profile_id, client_id, user_id, public_key)
	values (p_profile_id, p_client_id, v_user, p_public_key)
	on conflict (profile_id, client_id) do update
	set user_id = excluded.user_id, public_key = excluded.public_key, last_seen_at = statement_timestamp()
	where qorpera_founding_presence_devices.user_id = excluded.user_id
		or qorpera_founding_presence_devices.last_seen_at < statement_timestamp() - interval '5 minutes';
	get diagnostics v_registered = row_count;
	if v_registered <> 1 then
		raise exception 'This presence device id is already in use' using errcode = '23505'; end if;
	delete from public.qorpera_founding_presence_devices as device
	where (device.profile_id, device.client_id) in (
		select quiet.profile_id, quiet.client_id from public.qorpera_founding_presence_devices as quiet
		where quiet.last_seen_at < statement_timestamp() - interval '5 minutes'
		order by quiet.last_seen_at limit 64 for update skip locked);
	return jsonb_build_object('client_id', p_client_id, 'user_id', v_user, 'public_key', p_public_key);
end $$;

-- The devices behind these ids at this table: only ones registered in the last two minutes by someone who still has a
-- seat there.
create function public.qorpera_list_founding_presence(p_profile_id uuid, p_client_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	-- 20260930531000: who the tabs at the founding table are.
	if auth.uid() is null or p_client_ids is null or cardinality(p_client_ids) > 64
		or not public.qorpera_can_join_founding_table(p_profile_id) then
		raise exception 'This founding table is unavailable' using errcode = '42501'; end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object('client_id', device.client_id, 'user_id', device.user_id,
			'public_key', device.public_key) order by device.client_id)
		from public.qorpera_founding_presence_devices as device
		join public.qorpera_company_founder_seats as seat
			on seat.profile_id = device.profile_id and seat.user_id = device.user_id
		where device.profile_id = p_profile_id and device.client_id = any(p_client_ids)
			and device.last_seen_at >= statement_timestamp() - interval '2 minutes'
	), '[]'::jsonb);
end $$;

-- A tab leaving the table removes its own device, whether or not it still has a seat there.
create function public.qorpera_unregister_founding_presence(p_profile_id uuid, p_client_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930531000: a tab leaves the founding table.
	delete from public.qorpera_founding_presence_devices
	where profile_id = p_profile_id and client_id = p_client_id and user_id = auth.uid();
end $$;

revoke all on function public.qorpera_register_founding_presence(uuid, uuid, text),
	public.qorpera_list_founding_presence(uuid, uuid[]), public.qorpera_unregister_founding_presence(uuid, uuid)
	from public, anon;
grant execute on function public.qorpera_register_founding_presence(uuid, uuid, text),
	public.qorpera_list_founding_presence(uuid, uuid[]), public.qorpera_unregister_founding_presence(uuid, uuid)
	to authenticated;
