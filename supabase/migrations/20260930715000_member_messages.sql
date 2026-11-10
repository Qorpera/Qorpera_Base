-- Members of a company message each other (Jonas, 10 November 2026).
--
-- Jonas: "for multiplayer companies, I should also have a contact for the members I work with that's a direct way to
-- message and communicate with my friends im building with". Until now two members met only in an agent's thread or
-- a group chat, where every message is also the agents' to answer. From here each member has a chat with every other
-- member of the company: plain messages between two people, in the rail beside the agents.
--
-- What it is:
-- - One chat per pair of members per company. The same two people in another company have another chat there, as
--   each company has its own agents' threads.
-- - Company first: a chat is kept with its company and goes with it (the company's row is its only link). It is no
--   link to the two accounts, so an account's deletion leaves the messages, as it leaves a conversation's.
-- - Nothing here wakes an agent, takes a login, costs computer hours or touches the company's folder: a message is
--   a row, a read mark and a hint. A paused company's members still write to each other.
-- - Every member writes, viewers too: this is people talking, not work handed to an agent.
-- - A member reads only their own chats. The tables are closed to every API role; the five functions below are the
--   whole surface.
--
-- Read marks: each member's own, per chat: the newest message they have seen. Messages from the other member after
-- it are unread (the rail's count); the other member sees the mark as "Seen". A mark moves only when its member's
-- client says the messages were in front of them (qorpera_mark_member_chat_read): writing a message moves none.
--
-- Last online: the list says when each other member was last online, as the friends list does for friends
-- (20260930690000). Members of one company already see each other in it while they are there (its presence channel);
-- this adds when they last were. It is the only thing here one member learns of another outside their chat.
--
-- Live: a new message, one taken back and a moved read mark send the hint `member-chats` on the two members' own hint
-- topics (20260930653000), at commit, with no row and no id; the web then reads again. A missed hint is normal: the
-- web's slow poll reads the list too.
--
-- Order: a chat's sends go one at a time (an advisory lock on the chat, held to the end of the send's transaction),
-- so a message takes its place (`seq`) only after every earlier message of its chat is committed. A chat's committed
-- messages are therefore always a whole run from its first: no message turns up later in front of one already read,
-- and a read mark never passes a message that is still on its way (SQL test 1206). Sends in other chats do not wait.
--
-- A member who leaves keeps nothing open: the list names only the company's members now, and every call checks both
-- memberships. A message that lands as the other member leaves stays unread in a chat nobody lists; the rows are
-- still the company's.

set local lock_timeout = '3s';

create table public.qorpera_member_messages (
	id uuid primary key default gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	-- The two members, the lower id first, as qorpera_friendships orders a pair.
	user_low uuid not null,
	user_high uuid not null,
	-- One order for all member messages; a chat reads its own in this order.
	seq bigint generated always as identity,
	author_user_id uuid not null,
	-- The sender's own id for the message: a send repeated after a lost answer is the same message.
	client_message_id uuid not null,
	body text not null,
	created_at timestamptz not null default clock_timestamp(),
	-- Its author took it back: the row stays in its place, without its words.
	deleted_at timestamptz,
	constraint qorpera_member_messages_pair check (user_low < user_high and author_user_id in (user_low, user_high)),
	constraint qorpera_member_messages_body check (
		(deleted_at is null and body ~ '[^[:space:]]' and octet_length(body) <= 16384)
		or (deleted_at is not null and body = '')),
	constraint qorpera_member_messages_client unique (profile_id, author_user_id, client_message_id)
);
create index qorpera_member_messages_chat
	on public.qorpera_member_messages (profile_id, user_low, user_high, seq desc);
alter table public.qorpera_member_messages enable row level security;
revoke all on public.qorpera_member_messages from public, anon, authenticated, service_role;
revoke all on sequence public.qorpera_member_messages_seq_seq from public, anon, authenticated, service_role;
comment on table public.qorpera_member_messages is
	'Messages between two members of a company (20260930715000). Company data: deleted with the company, kept when an '
	'account goes. Read and written only through the qorpera_*_member_chat* and qorpera_*_member_message functions.';

create table public.qorpera_member_message_reads (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	-- The reader, and the member whose chat with them it is.
	user_id uuid not null,
	other_user_id uuid not null,
	-- The newest message of the chat the reader has seen (qorpera_member_messages.seq).
	read_seq bigint not null check (read_seq > 0),
	read_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id, other_user_id),
	constraint qorpera_member_message_reads_pair check (user_id <> other_user_id)
);
alter table public.qorpera_member_message_reads enable row level security;
revoke all on public.qorpera_member_message_reads from public, anon, authenticated, service_role;
comment on table public.qorpera_member_message_reads is
	'How far each member has read each of their chats with another member of the company (20260930715000).';

-- The caller's chat with `p_user_id` in the company: both are members of it now (not while it is being deleted), and
-- they are two people. Anyone else is refused, with the same words whatever was wrong.
create function public.qorpera_member_chat_pair(p_profile_id uuid, p_user_id uuid)
returns table (user_low uuid, user_high uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
begin
	-- 20260930715000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_profile_id is null or p_user_id is null
		or p_user_id = v_user or public.qorpera_member_role(p_profile_id) is null
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = p_user_id) then
		raise exception 'Member chat unavailable' using errcode = '42501';
	end if;
	user_low := least(v_user, p_user_id);
	user_high := greatest(v_user, p_user_id);
	return next;
end $$;

-- A message as the functions answer it. A deleted one keeps its place and says only that it is deleted. Its author
-- also gets the id they sent it with (`clientMessageId`), so a client knows its own message wherever it meets it:
-- in a read that comes before the send's answer, or after an answer that was lost.
create function public.qorpera_member_message_json(p_id uuid, p_seq bigint, p_author_user_id uuid,
	p_created_at timestamptz, p_deleted_at timestamptz, p_body text, p_client_message_id uuid default null)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('id', p_id, 'seq', p_seq, 'authorUserId', p_author_user_id, 'createdAt', p_created_at)
		|| case when p_deleted_at is null then jsonb_build_object('text', p_body)
			else jsonb_build_object('deleted', true) end
		|| case when p_client_message_id is null then '{}'::jsonb
			else jsonb_build_object('clientMessageId', p_client_message_id) end
$$;

-- The caller's chats in the company: one entry per other member, with or without messages. `lastSeenAt` is when that
-- member was last online (their last mark, else their last sign-in); `unread` counts their messages after the
-- caller's read mark, at most 100; `last` is the chat's newest message, its words cut to 280 characters.
create function public.qorpera_list_member_chats(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
begin
	-- 20260930715000
	if auth.role() is distinct from 'authenticated' or v_user is null
		or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Member chats unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object('schema', 'qorpera.member-chats/v1', 'chats', coalesce((
		select jsonb_agg(jsonb_build_object(
				'userId', other.user_id,
				'lastSeenAt', coalesce(presence.last_seen_at, account.last_sign_in_at),
				'unread', waiting.count,
				'readSeq', coalesce(mine.read_seq, 0),
				'theirReadSeq', coalesce(theirs.read_seq, 0),
				'last', latest.message)
			order by other.joined_at, other.user_id)
		from public.qorpera_profile_members as other
		left join auth.users as account on account.id = other.user_id
		left join public.qorpera_account_presence as presence on presence.user_id = other.user_id
		left join public.qorpera_member_message_reads as mine
			on mine.profile_id = p_profile_id and mine.user_id = v_user and mine.other_user_id = other.user_id
		left join public.qorpera_member_message_reads as theirs
			on theirs.profile_id = p_profile_id and theirs.user_id = other.user_id and theirs.other_user_id = v_user
		cross join lateral (
			select count(*)::integer as count
			from (
				select 1
				from public.qorpera_member_messages as message
				where message.profile_id = p_profile_id
					and message.user_low = least(v_user, other.user_id)
					and message.user_high = greatest(v_user, other.user_id)
					and message.seq > coalesce(mine.read_seq, 0)
					and message.author_user_id = other.user_id
					and message.deleted_at is null
				limit 100
			) as unread
		) as waiting
		left join lateral (
			select public.qorpera_member_message_json(message.id, message.seq, message.author_user_id,
				message.created_at, message.deleted_at, left(message.body, 280)) as message
			from public.qorpera_member_messages as message
			where message.profile_id = p_profile_id
				and message.user_low = least(v_user, other.user_id)
				and message.user_high = greatest(v_user, other.user_id)
			order by message.seq desc
			limit 1
		) as latest on true
		where other.profile_id = p_profile_id and other.user_id <> v_user), '[]'::jsonb));
end $$;

-- One page of the caller's chat with `p_user_id`, oldest first: the newest `p_limit` messages (50 when not said, 200 at
-- most), or those before `p_before_seq`. `hasMore` says there are older ones. With the page come both read marks. The
-- caller's own messages carry the id they were sent with; the other member's never do.
create function public.qorpera_read_member_chat(p_profile_id uuid, p_user_id uuid, p_before_seq bigint default null,
	p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_low uuid;
	v_high uuid;
	v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
	v_messages jsonb;
	v_more boolean;
begin
	-- 20260930715000
	select pair.user_low, pair.user_high into v_low, v_high
	from public.qorpera_member_chat_pair(p_profile_id, p_user_id) as pair;
	select coalesce(jsonb_agg(public.qorpera_member_message_json(page.id, page.seq, page.author_user_id,
				page.created_at, page.deleted_at, page.body,
				case when page.author_user_id = v_user then page.client_message_id end) order by page.seq)
			filter (where page.position <= v_limit), '[]'::jsonb),
		coalesce(bool_or(page.position > v_limit), false)
	into v_messages, v_more
	from (
		select message.id, message.seq, message.author_user_id, message.created_at, message.deleted_at, message.body,
			message.client_message_id, row_number() over (order by message.seq desc) as position
		from public.qorpera_member_messages as message
		where message.profile_id = p_profile_id and message.user_low = v_low and message.user_high = v_high
			and (p_before_seq is null or message.seq < p_before_seq)
		order by message.seq desc
		limit v_limit + 1
	) as page;
	return jsonb_build_object('schema', 'qorpera.member-chat/v1', 'userId', p_user_id, 'messages', v_messages,
		'hasMore', v_more,
		'readSeq', coalesce((select reads.read_seq from public.qorpera_member_message_reads as reads
			where reads.profile_id = p_profile_id and reads.user_id = v_user and reads.other_user_id = p_user_id), 0),
		'theirReadSeq', coalesce((select reads.read_seq from public.qorpera_member_message_reads as reads
			where reads.profile_id = p_profile_id and reads.user_id = p_user_id and reads.other_user_id = v_user), 0));
end $$;

-- The caller writes to `p_user_id`. `p_client_message_id` is the caller's own id for the message: the same call again
-- answers the same message and writes nothing; the id with other words, or for another member, is refused (23505).
-- The words: not blank, at most 16 KiB. No read mark moves: the sender's own messages are never unread to them.
create function public.qorpera_send_member_message(p_profile_id uuid, p_user_id uuid, p_client_message_id uuid,
	p_text text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_low uuid;
	v_high uuid;
	v_message public.qorpera_member_messages%rowtype;
begin
	-- 20260930715000
	select pair.user_low, pair.user_high into v_low, v_high
	from public.qorpera_member_chat_pair(p_profile_id, p_user_id) as pair;
	if p_client_message_id is null or p_text is null or p_text !~ '[^[:space:]]' or octet_length(p_text) > 16384 then
		raise exception 'Message is invalid' using errcode = '22023';
	end if;
	-- One send at a time in this chat, to the end of this transaction: the message's place is taken after every earlier
	-- message of the chat is committed.
	perform pg_advisory_xact_lock(hashtextextended(
		'qorpera.member-chat:' || p_profile_id::text || ':' || v_low::text || ':' || v_high::text, 0));
	insert into public.qorpera_member_messages (profile_id, user_low, user_high, author_user_id, client_message_id, body)
	values (p_profile_id, v_low, v_high, v_user, p_client_message_id, p_text)
	on conflict on constraint qorpera_member_messages_client do nothing
	returning * into v_message;
	if not found then
		select * into strict v_message
		from public.qorpera_member_messages as message
		where message.profile_id = p_profile_id and message.author_user_id = v_user
			and message.client_message_id = p_client_message_id;
		-- A message taken back since keeps its id: the same call still answers it, deleted.
		if v_message.user_low <> v_low or v_message.user_high <> v_high
			or (v_message.deleted_at is null and v_message.body <> p_text) then
			raise exception 'Message id is bound to different content' using errcode = '23505';
		end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.member-message/v1', 'userId', p_user_id,
		'message', public.qorpera_member_message_json(v_message.id, v_message.seq, v_message.author_user_id,
			v_message.created_at, v_message.deleted_at, v_message.body, v_message.client_message_id));
end $$;

-- The caller has seen their chat with `p_user_id` up to the message `p_seq`. The mark only moves forward, and only to
-- a message of this chat: the chat's newest message at or before `p_seq`. Answers the mark as it stands.
create function public.qorpera_mark_member_chat_read(p_profile_id uuid, p_user_id uuid, p_seq bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_low uuid;
	v_high uuid;
	v_seq bigint;
begin
	-- 20260930715000
	select pair.user_low, pair.user_high into v_low, v_high
	from public.qorpera_member_chat_pair(p_profile_id, p_user_id) as pair;
	select max(message.seq) into v_seq
	from public.qorpera_member_messages as message
	where message.profile_id = p_profile_id and message.user_low = v_low and message.user_high = v_high
		and message.seq <= p_seq;
	if v_seq is not null then
		insert into public.qorpera_member_message_reads as reads (profile_id, user_id, other_user_id, read_seq)
		values (p_profile_id, v_user, p_user_id, v_seq)
		on conflict (profile_id, user_id, other_user_id) do update
			set read_seq = excluded.read_seq, read_at = clock_timestamp()
			where reads.read_seq < excluded.read_seq;
	end if;
	return jsonb_build_object('schema', 'qorpera.member-chat-read/v1', 'userId', p_user_id,
		'readSeq', coalesce((select reads.read_seq from public.qorpera_member_message_reads as reads
			where reads.profile_id = p_profile_id and reads.user_id = v_user and reads.other_user_id = p_user_id), 0));
end $$;

-- The caller takes back a message of their own: its words go, its place stays. Only its author, while a member of
-- the company; the other member may have left. Taking it back twice answers the same.
create function public.qorpera_delete_member_message(p_profile_id uuid, p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_message public.qorpera_member_messages%rowtype;
begin
	-- 20260930715000
	if auth.role() is distinct from 'authenticated' or v_user is null
		or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Member chat unavailable' using errcode = '42501';
	end if;
	update public.qorpera_member_messages as message
	set deleted_at = clock_timestamp(), body = ''
	where message.id = p_message_id and message.profile_id = p_profile_id and message.author_user_id = v_user
		and message.deleted_at is null
	returning * into v_message;
	if not found then
		select * into v_message
		from public.qorpera_member_messages as message
		where message.id = p_message_id and message.profile_id = p_profile_id and message.author_user_id = v_user;
		if not found then
			raise exception 'Member chat unavailable' using errcode = '42501';
		end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.member-message/v1',
		'userId', case when v_message.user_low = v_user then v_message.user_high else v_message.user_low end,
		'message', public.qorpera_member_message_json(v_message.id, v_message.seq, v_message.author_user_id,
			v_message.created_at, v_message.deleted_at, v_message.body, v_message.client_message_id));
end $$;

-- The hint: at commit, `member-chats` to the two members of the changed chat who are members of the company then, on
-- their own hint topics (20260930653000). Built as qorpera_live_hint_internal is: one hint per chat per transaction,
-- a 20 ms lock budget, and every error caught (a cancel too), so a failing Realtime never fails or slows the write;
-- the first error ends hinting for the rest of the transaction. Not on a delete: only the company's purge deletes these
-- rows, and nobody is left to hear of it.
create function public.qorpera_member_chat_hint()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_low uuid;
	v_high uuid;
	v_class text;
begin
	-- 20260930715000
	if current_setting('qorpera.live_hints_failed', true) = 'on' then return null; end if;
	begin
		if tg_table_name = 'qorpera_member_messages' then
			v_low := new.user_low;
			v_high := new.user_high;
		else
			v_low := least(new.user_id, new.other_user_id);
			v_high := greatest(new.user_id, new.other_user_id);
		end if;
		v_class := new.profile_id || ' member-chats ' || v_low || ' ' || v_high;
		if strpos(coalesce(current_setting('qorpera.live_hints_sent', true), ''), '|' || v_class || '|') > 0 then
			return null;
		end if;
		perform set_config('lock_timeout', '20ms', true);
		perform public.qorpera_live_hint_send('member-chats', array(
			select public.qorpera_live_hint_topic(member.profile_id, member.user_id)
			from public.qorpera_profile_members as member
			where member.profile_id = new.profile_id and member.user_id in (v_low, v_high)
				and not exists (select 1 from public.qorpera_company_deletions as deletion
					where deletion.profile_id = new.profile_id)), v_class);
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception
		when query_canceled then
			perform set_config('qorpera.live_hints_failed', 'on', true);
		when others then
			perform set_config('qorpera.live_hints_failed', 'on', true);
	end;
	return null;
end $$;

create constraint trigger qorpera_member_chat_hint after insert or update on public.qorpera_member_messages
	deferrable initially deferred for each row execute function public.qorpera_member_chat_hint();
create constraint trigger qorpera_member_chat_hint after insert or update on public.qorpera_member_message_reads
	deferrable initially deferred for each row execute function public.qorpera_member_chat_hint();

-- Internal: reached only from the functions above and the triggers.
revoke all on function public.qorpera_member_chat_pair(uuid, uuid),
	public.qorpera_member_message_json(uuid, bigint, uuid, timestamptz, timestamptz, text, uuid),
	public.qorpera_member_chat_hint()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

revoke all on function public.qorpera_list_member_chats(uuid),
	public.qorpera_read_member_chat(uuid, uuid, bigint, integer),
	public.qorpera_send_member_message(uuid, uuid, uuid, text),
	public.qorpera_mark_member_chat_read(uuid, uuid, bigint),
	public.qorpera_delete_member_message(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_member_chats(uuid),
	public.qorpera_read_member_chat(uuid, uuid, bigint, integer),
	public.qorpera_send_member_message(uuid, uuid, uuid, text),
	public.qorpera_mark_member_chat_read(uuid, uuid, bigint),
	public.qorpera_delete_member_message(uuid, uuid)
	to authenticated;

comment on function public.qorpera_list_member_chats(uuid) is
	'A member''s chats with the other members of a company: last online, unread count, read marks and the newest '
	'message (20260930715000).';
comment on function public.qorpera_read_member_chat(uuid, uuid, bigint, integer) is
	'One page of a member''s chat with another member of the company, oldest first, with both read marks '
	'(20260930715000).';
comment on function public.qorpera_send_member_message(uuid, uuid, uuid, text) is
	'A member writes to another member of the company; the client id makes a repeated send the same message '
	'(20260930715000). Wakes no agent and takes no login.';
comment on function public.qorpera_mark_member_chat_read(uuid, uuid, bigint) is
	'A member has seen their chat with another member up to a message; the mark only moves forward (20260930715000).';
comment on function public.qorpera_delete_member_message(uuid, uuid) is
	'A member takes back a message of their own in a member chat: its words go, its place stays (20260930715000).';
