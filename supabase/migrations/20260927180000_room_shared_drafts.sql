-- Shared drafts: a member's unsent message in a room (an agent thread or a group
-- chat) is visible, live, to the room's other members, who may edit it with the
-- member. Only the owner sends it, as an ordinary room post on the owner's own
-- sponsor; a draft never becomes a message by itself and wakes nothing.
--
-- The cloud is the only authority. It stores each draft's text under one
-- revision, accepts an edit only against the current revision (a stale editor
-- merges and retries), names the editor from the caller's token, and pushes every
-- change on a private Realtime topic that members receive and nobody publishes.
-- Access follows posting: an active member of an active room (the same test as
-- qorpera_post_company_room_message), and, as in the clients, not a viewer.
-- Drafts are not execution, so a paused company still lets members write them.
--
-- Cost: one short row per member and room, updated in place (no index covers a
-- changing column, so updates stay HOT); each change is one realtime.messages
-- row, kept by Realtime for its own retention like any broadcast.

create table public.qorpera_room_drafts (
	room_id uuid not null references public.qorpera_company_rooms(id) on delete cascade,
	owner_user_id uuid not null references auth.users(id) on delete cascade,
	body text not null check (octet_length(convert_to(body, 'utf8')) <= 65536),
	revision bigint not null check (revision > 0),
	-- The last member to change the text; not a reference, so a departed editor
	-- does not take someone else's draft with them.
	editor_user_id uuid not null,
	-- Members other than the owner who have edited this draft since the owner last emptied it.
	contributors uuid[] not null default '{}' check (cardinality(contributors) <= 64),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (room_id, owner_user_id)
);
alter table public.qorpera_room_drafts enable row level security;
revoke all on public.qorpera_room_drafts from public, anon, authenticated, service_role;

-- True when the user may post in the room, and so may see and edit its drafts. Viewers
-- read the room's conversation; its drafts are for the members who write in it.
create function public.qorpera_room_draft_member_internal(p_room_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_room_id is not null and p_user_id is not null and exists (
		select 1 from public.qorpera_company_rooms room
		join public.qorpera_profile_members profile_member
			on profile_member.profile_id = room.profile_id and profile_member.user_id = p_user_id
				and profile_member.role <> 'viewer'
		join public.qorpera_company_room_members room_member
			on room_member.room_id = room.id and room_member.principal_kind = 'member'
				and room_member.principal_id = p_user_id and room_member.status = 'active'
		where room.id = p_room_id and room.status = 'active' and room.session_id is not null)
$$;
revoke all on function public.qorpera_room_draft_member_internal(uuid, uuid) from public, anon, authenticated, service_role;

create function public.qorpera_can_share_room_draft(p_room_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_room_draft_member_internal(p_room_id, auth.uid())
$$;
revoke all on function public.qorpera_can_share_room_draft(uuid) from public, anon;
grant execute on function public.qorpera_can_share_room_draft(uuid) to authenticated;

create function public.qorpera_room_drafts_topic(p_room_id uuid)
returns text language sql immutable set search_path = '' as $$
	select 'qorpera-room-drafts-' || p_room_id::text
$$;
revoke all on function public.qorpera_room_drafts_topic(uuid) from public, anon;
grant execute on function public.qorpera_room_drafts_topic(uuid) to authenticated;

create function public.qorpera_room_drafts_topic_room(p_topic text)
returns uuid language sql immutable set search_path = '' as $$
	select case
		when p_topic ~ '^qorpera-room-drafts-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			then substring(p_topic from 21)::uuid
	end
$$;
revoke all on function public.qorpera_room_drafts_topic_room(text) from public, anon;
grant execute on function public.qorpera_room_drafts_topic_room(text) to authenticated;

-- Members receive a room's draft changes. There is no insert policy for this
-- topic: only the cloud (qorpera_put_room_draft, through realtime.send) publishes,
-- so every change carries the editor the token named.
create policy qorpera_room_drafts_member_receive
	on realtime.messages
	for select
	to authenticated
	using (
		realtime.messages.extension = 'broadcast'
		and public.qorpera_can_share_room_draft(public.qorpera_room_drafts_topic_room(realtime.topic()))
	);

create function public.qorpera_room_draft_json_internal(p_draft public.qorpera_room_drafts)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'schema', 'qorpera.room-draft/v1',
		'roomId', p_draft.room_id,
		'ownerUserId', p_draft.owner_user_id,
		'body', p_draft.body,
		'revision', p_draft.revision,
		'editorUserId', p_draft.editor_user_id,
		'contributors', to_jsonb(p_draft.contributors),
		'updatedAt', p_draft.updated_at)
$$;
revoke all on function public.qorpera_room_draft_json_internal(public.qorpera_room_drafts)
	from public, anon, authenticated, service_role;

-- The room's drafts the caller may see: every other member's that has text and
-- changed in the last day, and the caller's own (with its revision, even empty,
-- so a reloaded browser resumes it). A member who left the room takes their draft
-- off the list.
create function public.qorpera_list_room_drafts(p_room_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated' or not public.qorpera_can_share_room_draft(p_room_id) then
		raise exception 'Room is unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.room-drafts/v1',
		'roomId', p_room_id,
		'drafts', coalesce((
			select jsonb_agg(public.qorpera_room_draft_json_internal(draft) order by draft.updated_at, draft.owner_user_id)
			from public.qorpera_room_drafts draft
			where draft.room_id = p_room_id
				and public.qorpera_room_draft_member_internal(draft.room_id, draft.owner_user_id)
				and (draft.owner_user_id = auth.uid()
					or (draft.body ~ '[^[:space:]]' and draft.updated_at > clock_timestamp() - interval '1 day'))
		), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_list_room_drafts(uuid) from public, anon;
grant execute on function public.qorpera_list_room_drafts(uuid) to authenticated;

-- Replace a draft's text, only from its current revision. A stale revision changes
-- nothing and returns the current draft, so the editor merges its own change into it
-- and writes again. Only the owner starts a draft (from revision 0, or from the
-- revision it last knew when the old one was cleared away, so revisions never go
-- back); any member of the room edits one that exists.
create function public.qorpera_put_room_draft(
	p_room_id uuid, p_owner_user_id uuid, p_base_revision bigint, p_body text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_draft public.qorpera_room_drafts%rowtype;
	v_contributors uuid[];
begin
	if auth.role() is distinct from 'authenticated' or v_user is null
		or not public.qorpera_room_draft_member_internal(p_room_id, v_user) then
		raise exception 'Room is unavailable' using errcode = '42501';
	end if;
	if p_base_revision is null or p_base_revision < 0 or p_body is null
		or octet_length(convert_to(p_body, 'utf8')) > 65536 then
		raise exception 'Draft is invalid' using errcode = '22023';
	end if;
	-- A draft whose owner left the room is gone for everyone.
	if not public.qorpera_room_draft_member_internal(p_room_id, p_owner_user_id) then
		return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'gone');
	end if;
	select * into v_draft from public.qorpera_room_drafts
	where room_id = p_room_id and owner_user_id = p_owner_user_id for update;
	if not found then
		if p_owner_user_id <> v_user then
			return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'gone');
		end if;
		insert into public.qorpera_room_drafts (room_id, owner_user_id, body, revision, editor_user_id)
		values (p_room_id, p_owner_user_id, p_body, p_base_revision + 1, v_user)
		on conflict (room_id, owner_user_id) do nothing
		returning * into v_draft;
		if not found then
			-- Another tab of the owner wrote first.
			select * into v_draft from public.qorpera_room_drafts
			where room_id = p_room_id and owner_user_id = p_owner_user_id;
			return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'stale',
				'draft', public.qorpera_room_draft_json_internal(v_draft));
		end if;
	elsif v_draft.revision <> p_base_revision then
		return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'stale',
			'draft', public.qorpera_room_draft_json_internal(v_draft));
	elsif v_draft.body = p_body then
		return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'ok',
			'draft', public.qorpera_room_draft_json_internal(v_draft));
	else
		-- The owner emptying the draft (it was sent or cleared) ends its contributors.
		v_contributors := case
			when v_user = p_owner_user_id and p_body = '' then '{}'::uuid[]
			when v_user = p_owner_user_id or v_user = any (v_draft.contributors) then v_draft.contributors
			when cardinality(v_draft.contributors) >= 64 then v_draft.contributors
			else v_draft.contributors || v_user
		end;
		update public.qorpera_room_drafts
		set body = p_body, revision = v_draft.revision + 1, editor_user_id = v_user,
			contributors = v_contributors, updated_at = clock_timestamp()
		where room_id = p_room_id and owner_user_id = p_owner_user_id
		returning * into v_draft;
	end if;
	perform realtime.send(public.qorpera_room_draft_json_internal(v_draft), 'draft',
		public.qorpera_room_drafts_topic(p_room_id), true);
	-- Drafts nobody touched for a month leave the room (one row per member: the key's room prefix finds them).
	delete from public.qorpera_room_drafts
	where room_id = p_room_id and updated_at < clock_timestamp() - interval '30 days';
	return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'ok',
		'draft', public.qorpera_room_draft_json_internal(v_draft));
end
$$;
revoke all on function public.qorpera_put_room_draft(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.qorpera_put_room_draft(uuid, uuid, bigint, text) to authenticated;
