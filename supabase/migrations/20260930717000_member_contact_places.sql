-- A member places their member contacts in their own rail (Jonas, 10 November 2026).
--
-- Jonas, the day member chats went live (20260930715000): "not sure I like the member contacts at the top, undraggable
-- and un-hideable." Until now the other members stood in one fixed block under the Co-Founder. From here a contact is
-- a row like an agent's: it stands in a Members group at the foot of the list until its member drags it, and it drags
-- into the pinned row, into any section or among what is in none, pins and hides, as an agent or a group chat does.
--
-- Whose it is: each member's own, as their pins and hidden agents are (qorpera_member_sidebar_agents). The company's
-- sections file names agents and group chats, the same for everyone; a member sees different contacts than the next
-- member (never themselves), so where a contact stands is kept per member and never written to the company's folder.
-- Any member may place their contacts, viewers too: it changes nobody else's rail.
--
-- How a place is kept: the zone (the Members group, the pinned row, a section, or what is in no section), and in the
-- three shared zones the agent or group chat the contact stands after (`after_item_id`; none: first in the zone), with
-- `rank` ordering contacts that stand after the same one. The agents' own order is the company's and changes under a
-- member's feet; a contact keeps standing after the same agent when it does. An anchor that is no longer in the zone
-- (the agent moved, or is gone) leaves the contact at the zone's end, and a section that is gone leaves it in the
-- Members group: the client decides both from the sidebar it reads, nothing here follows the sections file.
--
-- 1. qorpera_member_sidebar_contacts: one row per member and contact, once placed or hidden. It goes with either
--    membership (a member who leaves, or whose account goes, takes their own places and the places others gave them)
--    and with the company.
-- 2. qorpera_list_member_chats answers `hidden` for every chat, `place` for a placed one, and `placing: true`, by
--    which a client knows this cloud keeps places.
-- 3. qorpera_place_member_contacts(company, contacts): sets the place and hidden of the named contacts and answers the
--    list again.

set local lock_timeout = '3s';

create table public.qorpera_member_sidebar_contacts (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	-- Whose rail it is, and the member placed in it.
	user_id uuid not null,
	other_user_id uuid not null,
	zone text not null default 'members' check (zone in ('members', 'pinned', 'unassigned', 'section')),
	-- The section, for zone 'section' (qorpera_company_sidebar_sections.id; no link: the sections follow the file).
	section_id uuid,
	-- The agent or group chat the contact stands after in its zone; none: first.
	after_item_id uuid,
	-- Its order among the contacts after the same item (in the Members group: among all of them).
	rank integer not null default 0 check (rank between 0 and 9999),
	hidden boolean not null default false,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, user_id, other_user_id),
	constraint qorpera_member_sidebar_contacts_pair check (user_id <> other_user_id),
	constraint qorpera_member_sidebar_contacts_section check ((zone = 'section') = (section_id is not null)),
	constraint qorpera_member_sidebar_contacts_after check (after_item_id is null or zone <> 'members'),
	constraint qorpera_member_sidebar_contacts_member foreign key (profile_id, user_id)
		references public.qorpera_profile_members(profile_id, user_id) on delete cascade,
	constraint qorpera_member_sidebar_contacts_other foreign key (profile_id, other_user_id)
		references public.qorpera_profile_members(profile_id, user_id) on delete cascade
);
-- A member who leaves is looked up as the contact too.
create index qorpera_member_sidebar_contacts_other
	on public.qorpera_member_sidebar_contacts (profile_id, other_user_id);
alter table public.qorpera_member_sidebar_contacts enable row level security;
revoke all on public.qorpera_member_sidebar_contacts from public, anon, authenticated, service_role;
comment on table public.qorpera_member_sidebar_contacts is
	'Where each member keeps their member contacts in their own rail, and which they hid (20260930717000). The '
	'member''s own, as their pins are; written only through qorpera_place_member_contacts.';

-- The caller's chats in the company, as before (20260930715000), and now where the caller keeps each contact:
-- `hidden` always, `place` once the caller placed it, and `placing` so a client knows places are kept here.
create or replace function public.qorpera_list_member_chats(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
begin
	-- 20260930717000 (places), 20260930715000
	if auth.role() is distinct from 'authenticated' or v_user is null
		or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Member chats unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object('schema', 'qorpera.member-chats/v1', 'placing', true, 'chats', coalesce((
		select jsonb_agg(jsonb_build_object(
					'userId', other.user_id,
					'lastSeenAt', coalesce(presence.last_seen_at, account.last_sign_in_at),
					'unread', waiting.count,
					'readSeq', coalesce(mine.read_seq, 0),
					'theirReadSeq', coalesce(theirs.read_seq, 0),
					'last', latest.message,
					'hidden', coalesce(placed.hidden, false))
				|| case when placed.user_id is null then '{}'::jsonb
					else jsonb_build_object('place', jsonb_strip_nulls(jsonb_build_object(
						'zone', placed.zone, 'sectionId', placed.section_id, 'after', placed.after_item_id,
						'rank', placed.rank))) end
			order by other.joined_at, other.user_id)
		from public.qorpera_profile_members as other
		left join auth.users as account on account.id = other.user_id
		left join public.qorpera_account_presence as presence on presence.user_id = other.user_id
		left join public.qorpera_member_message_reads as mine
			on mine.profile_id = p_profile_id and mine.user_id = v_user and mine.other_user_id = other.user_id
		left join public.qorpera_member_message_reads as theirs
			on theirs.profile_id = p_profile_id and theirs.user_id = other.user_id and theirs.other_user_id = v_user
		left join public.qorpera_member_sidebar_contacts as placed
			on placed.profile_id = p_profile_id and placed.user_id = v_user and placed.other_user_id = other.user_id
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

-- The caller places contacts in their own rail. `p_contacts` is a list of up to 100 entries, each one contact's whole
-- place: `userId` (another member of the company now), `zone` ('members', 'pinned', 'unassigned' or 'section'),
-- `sectionId` (a section of the company; with zone 'section' only), `after` (an agent's or a group chat's id, or
-- none; never in 'members'), `rank` (0 to 9999) and `hidden`. Anything else is refused whole (22023), and nothing is
-- written. Any member may (42501 for anyone else, and while the company is being deleted). `after` is not checked
-- against the company's agents: it is the caller's own note of where the contact stands, read back only by them.
-- Answers the list as qorpera_list_member_chats does.
create function public.qorpera_place_member_contacts(p_profile_id uuid, p_contacts jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_count integer;
begin
	-- 20260930717000
	if auth.role() is distinct from 'authenticated' or v_user is null
		or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Member chats unavailable' using errcode = '42501';
	end if;
	if p_contacts is null or jsonb_typeof(p_contacts) <> 'array'
		or jsonb_array_length(p_contacts) not between 1 and 100 then
		raise exception 'Contact places are invalid' using errcode = '22023';
	end if;
	-- Every entry is checked before anything is cast: a wrong shape is a refusal, never a cast error.
	if exists (
		select 1 from jsonb_array_elements(p_contacts) as entry(item)
		where jsonb_typeof(item) <> 'object'
			or jsonb_typeof(item -> 'userId') is distinct from 'string'
			or not pg_input_is_valid(item ->> 'userId', 'uuid')
			or jsonb_typeof(item -> 'zone') is distinct from 'string'
			or item ->> 'zone' not in ('members', 'pinned', 'unassigned', 'section')
			or jsonb_typeof(item -> 'hidden') is distinct from 'boolean'
			or jsonb_typeof(item -> 'rank') is distinct from 'number'
			or item ->> 'rank' !~ '^[0-9]{1,4}$'
			or case when item ->> 'zone' = 'section'
				then jsonb_typeof(item -> 'sectionId') is distinct from 'string'
					or not pg_input_is_valid(item ->> 'sectionId', 'uuid')
				else coalesce(jsonb_typeof(item -> 'sectionId'), 'null') <> 'null' end
			or case when coalesce(jsonb_typeof(item -> 'after'), 'null') = 'null' then false
				else item ->> 'zone' = 'members' or jsonb_typeof(item -> 'after') <> 'string'
					or not pg_input_is_valid(item ->> 'after', 'uuid') end
	) then
		raise exception 'Contact places are invalid' using errcode = '22023';
	end if;
	select count(*) into v_count
	from (select distinct (item ->> 'userId')::uuid as other_user_id
		from jsonb_array_elements(p_contacts) as entry(item)) as named
	join public.qorpera_profile_members as member
		on member.profile_id = p_profile_id and member.user_id = named.other_user_id
	where named.other_user_id <> v_user;
	-- Each entry names another member of the company, and no one twice.
	if v_count <> jsonb_array_length(p_contacts) then
		raise exception 'Contact places are invalid' using errcode = '22023';
	end if;
	if exists (
		select 1 from jsonb_array_elements(p_contacts) as entry(item)
		where item ->> 'zone' = 'section' and not exists (
			select 1 from public.qorpera_company_sidebar_sections as section
			where section.profile_id = p_profile_id and section.id = (item ->> 'sectionId')::uuid)
	) then
		raise exception 'Contact places are invalid' using errcode = '22023';
	end if;
	insert into public.qorpera_member_sidebar_contacts as placed
		(profile_id, user_id, other_user_id, zone, section_id, after_item_id, rank, hidden)
	select p_profile_id, v_user, (item ->> 'userId')::uuid, item ->> 'zone', (item ->> 'sectionId')::uuid,
		(item ->> 'after')::uuid, (item ->> 'rank')::integer, (item ->> 'hidden')::boolean
	from jsonb_array_elements(p_contacts) as entry(item)
	on conflict (profile_id, user_id, other_user_id) do update
		set zone = excluded.zone, section_id = excluded.section_id, after_item_id = excluded.after_item_id,
			rank = excluded.rank, hidden = excluded.hidden, updated_at = clock_timestamp();
	return public.qorpera_list_member_chats(p_profile_id);
end $$;

revoke all on function public.qorpera_place_member_contacts(uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_place_member_contacts(uuid, jsonb) to authenticated;

comment on function public.qorpera_list_member_chats(uuid) is
	'A member''s chats with the other members of a company: last online, unread count, read marks, the newest '
	'message (20260930715000), and where the member keeps each contact in their own rail (20260930717000).';
comment on function public.qorpera_place_member_contacts(uuid, jsonb) is
	'A member places contacts in their own rail: zone, what each stands after, and hidden (20260930717000). Changes '
	'nobody else''s rail and nothing of the company''s.';
