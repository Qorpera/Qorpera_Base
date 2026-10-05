-- Shared drafts (20260928000500): a room member's unsent message, seen and edited
-- live by the room's other members, written only from its current revision, and
-- pushed on a private topic that members receive and nobody publishes.

-- A owns the company; B and D are contributors in the room; C is a contributor
-- outside it; V is a viewer in the room (reads the conversation, shares no drafts);
-- O is not in the company.
insert into auth.users (id, email, email_confirmed_at)
values
	('96250000-0000-4000-8000-00000000000a', 'draft-owner@example.test', statement_timestamp()),
	('96250000-0000-4000-8000-00000000000b', 'draft-editor@example.test', statement_timestamp()),
	('96250000-0000-4000-8000-00000000000c', 'draft-outside-room@example.test', statement_timestamp()),
	('96250000-0000-4000-8000-00000000000d', 'draft-quiet@example.test', statement_timestamp()),
	('96250000-0000-4000-8000-0000000000e1', 'draft-viewer@example.test', statement_timestamp()),
	('96250000-0000-4000-8000-0000000000f0', 'draft-outsider@example.test', statement_timestamp());

create function pg_temp.as_user(p_user text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated',
		'email', (select email from auth.users where id = p_user::uuid), 'user_metadata', '{}'::jsonb)::text, false)
$$;

-- A's company is a folder-v2 company, opened the way the company creation opens one (856).
select set_config('qorpera_test.draft_company', public.qorpera_folder_company_open('96250000-0000-4000-8000-00000000000a',
	'96250000-0000-4000-8000-0000000000e9', 'Draft QA')::text, false);
do $$
begin
	if not public.qorpera_company_is_folder_v2((current_setting('qorpera_test.draft_company')::jsonb ->> 'profile_id')::uuid) then
		raise exception 'the draft company is not a folder-v2 company';
	end if;
end
$$;

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
select (current_setting('qorpera_test.draft_company')::jsonb ->> 'profile_id')::uuid, member.user_id, member.email, member.name, member.role::public.qorpera_profile_role
from (values
	('96250000-0000-4000-8000-00000000000b'::uuid, 'draft-editor@example.test', 'Bo', 'contributor'),
	('96250000-0000-4000-8000-00000000000c'::uuid, 'draft-outside-room@example.test', 'Cy', 'contributor'),
	('96250000-0000-4000-8000-00000000000d'::uuid, 'draft-quiet@example.test', 'Di', 'contributor'),
	('96250000-0000-4000-8000-0000000000e1'::uuid, 'draft-viewer@example.test', 'Vi', 'viewer')
) as member(user_id, email, name, role);

insert into public.qorpera_shared_sessions (id, profile_id, environment_id, title, created_by_user_id, audience_kind, execution_scope)
select '96250000-0000-4000-8000-000000000050',
	(current_setting('qorpera_test.draft_company')::jsonb ->> 'profile_id')::uuid,
	(current_setting('qorpera_test.draft_company')::jsonb ->> 'environment_id')::uuid,
	'Launch', '96250000-0000-4000-8000-00000000000a', 'company',
	jsonb_build_object('roomId', '96250000-0000-4000-8000-000000000060');

-- The room is a folder-v2 group chat, as the folder index writes one for agents/groups/launch/group.md (its path,
-- that path's version and the commit that wrote it; no snapshot source).
insert into public.qorpera_company_rooms (id, profile_id, environment_id, room_key, name, purpose, status, session_id,
	version, source_path, created_by_user_id, folder_environment_id, folder_path, folder_path_version, folder_commit_id)
select '96250000-0000-4000-8000-000000000060',
	(current_setting('qorpera_test.draft_company')::jsonb ->> 'profile_id')::uuid,
	(current_setting('qorpera_test.draft_company')::jsonb ->> 'environment_id')::uuid,
	'chat-96250000-0000-4000-8000-000000000060', 'Launch', 'Launch planning', 'active', '96250000-0000-4000-8000-000000000050', 1,
	'organization/rooms/96250000-0000-4000-8000-000000000060.json', '96250000-0000-4000-8000-00000000000a',
	(current_setting('qorpera_test.draft_company')::jsonb ->> 'environment_id')::uuid, 'agents/groups/launch/group.md',
	'96250000-0000-4000-8000-000000000061', '96250000-0000-4000-8000-000000000062';

insert into public.qorpera_company_room_members (room_id, principal_kind, principal_id, status, source_path_version)
select '96250000-0000-4000-8000-000000000060', 'member', member, 'active', '96250000-0000-4000-8000-000000000061'
from unnest(array[
	'96250000-0000-4000-8000-00000000000a', '96250000-0000-4000-8000-00000000000b',
	'96250000-0000-4000-8000-00000000000d', '96250000-0000-4000-8000-0000000000e1'
]::uuid[]) as member;

-- The topic: exact prefix and a well-formed uuid, nothing else.
do $$
begin
	if public.qorpera_room_drafts_topic('96250000-0000-4000-8000-000000000060')
		<> 'qorpera-room-drafts-96250000-0000-4000-8000-000000000060' then
		raise exception 'room drafts topic has the wrong name';
	end if;
	if public.qorpera_room_drafts_topic_room(public.qorpera_room_drafts_topic('96250000-0000-4000-8000-000000000060'))
		is distinct from '96250000-0000-4000-8000-000000000060'::uuid then
		raise exception 'room drafts topic did not parse to its room';
	end if;
	if public.qorpera_room_drafts_topic_room('qorpera-room-drafts-not-a-uuid') is not null
		or public.qorpera_room_drafts_topic_room('qorpera-presence-96250000-0000-4000-8000-000000000060') is not null
		or public.qorpera_room_drafts_topic_room('xqorpera-room-drafts-96250000-0000-4000-8000-000000000060') is not null then
		raise exception 'a foreign topic parsed to a room';
	end if;
end
$$;

-- The owner starts a draft from revision 0; the change is broadcast on the room's topic.
select pg_temp.as_user('96250000-0000-4000-8000-00000000000a');
set role authenticated;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000a', 0, 'Plan the launch');
	if v_result ->> 'status' <> 'ok' or (v_result -> 'draft' ->> 'revision')::bigint <> 1
		or v_result -> 'draft' ->> 'body' <> 'Plan the launch'
		or v_result -> 'draft' ->> 'editorUserId' <> '96250000-0000-4000-8000-00000000000a'
		or v_result -> 'draft' -> 'contributors' <> '[]'::jsonb then
		raise exception 'owner could not start a draft: %', v_result;
	end if;
	-- The same text again changes nothing and broadcasts nothing.
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000a', 1, 'Plan the launch');
	if v_result ->> 'status' <> 'ok' or (v_result -> 'draft' ->> 'revision')::bigint <> 1 then
		raise exception 'an unchanged draft moved its revision: %', v_result;
	end if;
end
$$;
reset role;

do $$
declare v_rows integer; v_payload jsonb;
begin
	select count(*), max(payload::text)::jsonb into v_rows, v_payload from realtime.messages
	where topic = 'qorpera-room-drafts-96250000-0000-4000-8000-000000000060';
	if v_rows <> 1 or v_payload ->> 'schema' <> 'qorpera.room-draft/v1' or v_payload ->> 'body' <> 'Plan the launch'
		or (v_payload ->> 'revision')::bigint <> 1 then
		raise exception 'the first write broadcast % rows: %', v_rows, v_payload;
	end if;
	if exists (select 1 from realtime.messages
		where topic = 'qorpera-room-drafts-96250000-0000-4000-8000-000000000060'
			and (extension <> 'broadcast' or event <> 'draft' or private is not true)) then
		raise exception 'a draft change was not a private broadcast';
	end if;
end
$$;

-- Another room member edits it; the owner's stale write changes nothing and gets the current text.
select pg_temp.as_user('96250000-0000-4000-8000-00000000000b');
set role authenticated;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000a', 1, 'Plan the launch for Friday');
	if v_result ->> 'status' <> 'ok' or (v_result -> 'draft' ->> 'revision')::bigint <> 2
		or v_result -> 'draft' ->> 'editorUserId' <> '96250000-0000-4000-8000-00000000000b'
		or v_result -> 'draft' -> 'contributors' <> '["96250000-0000-4000-8000-00000000000b"]'::jsonb then
		raise exception 'a room member could not edit the draft: %', v_result;
	end if;
	-- A member cannot start a draft in someone else's name.
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000d', 0, 'Words for Di');
	if v_result ->> 'status' <> 'gone' then
		raise exception 'a member started a draft for another member: %', v_result;
	end if;
	-- A draft whose owner is not in the room is gone.
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000c', 0, 'Words for Cy');
	if v_result ->> 'status' <> 'gone' then
		raise exception 'a draft was started for a member outside the room: %', v_result;
	end if;
	-- The member sees the owner's draft and its contributor.
	v_result := public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060');
	if v_result ->> 'schema' <> 'qorpera.room-drafts/v1' or jsonb_array_length(v_result -> 'drafts') <> 1
		or v_result -> 'drafts' -> 0 ->> 'ownerUserId' <> '96250000-0000-4000-8000-00000000000a'
		or v_result -> 'drafts' -> 0 ->> 'body' <> 'Plan the launch for Friday' then
		raise exception 'room member listed %', v_result;
	end if;
	-- Receiving the topic is allowed, publishing on it is not.
	perform set_config('realtime.topic', 'qorpera-room-drafts-96250000-0000-4000-8000-000000000060', false);
	if (select count(*) from realtime.messages
		where topic = 'qorpera-room-drafts-96250000-0000-4000-8000-000000000060') <> 2 then
		raise exception 'room member could not receive the draft topic';
	end if;
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values ('qorpera-room-drafts-96250000-0000-4000-8000-000000000060', 'broadcast',
			'{"body":"forged"}'::jsonb, 'draft', true);
		raise exception 'a member published on the draft topic';
	exception when insufficient_privilege then null;
	end;
	perform set_config('realtime.topic', '', false);
end
$$;
reset role;

select pg_temp.as_user('96250000-0000-4000-8000-00000000000a');
set role authenticated;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000a', 1, 'Plan the launch today');
	if v_result ->> 'status' <> 'stale' or (v_result -> 'draft' ->> 'revision')::bigint <> 2
		or v_result -> 'draft' ->> 'body' <> 'Plan the launch for Friday' then
		raise exception 'a stale write was not refused with the current draft: %', v_result;
	end if;
	-- The owner's own draft is listed too.
	v_result := public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060');
	if jsonb_array_length(v_result -> 'drafts') <> 1 or (v_result -> 'drafts' -> 0 ->> 'revision')::bigint <> 2 then
		raise exception 'owner listed %', v_result;
	end if;
	-- Emptying it (sent or cleared) ends its contributors and hides it from the others.
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000a', 2, '');
	if v_result ->> 'status' <> 'ok' or (v_result -> 'draft' ->> 'revision')::bigint <> 3
		or v_result -> 'draft' -> 'contributors' <> '[]'::jsonb then
		raise exception 'owner could not empty the draft: %', v_result;
	end if;
	v_result := public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060');
	if jsonb_array_length(v_result -> 'drafts') <> 1 or v_result -> 'drafts' -> 0 ->> 'body' <> '' then
		raise exception 'owner lost the empty draft revision: %', v_result;
	end if;
	-- A revision past what a browser counts exactly is refused, so a draft can never break the room's listing.
	begin
		perform public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
			'96250000-0000-4000-8000-00000000000a', 9007199254740993, 'x');
		raise exception 'a revision past 2^53 was accepted';
	exception when invalid_parameter_value then null;
	end;
	-- Too long is refused.
	begin
		perform public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
			'96250000-0000-4000-8000-00000000000a', 3, repeat('x', 65537));
		raise exception 'an oversized draft was accepted';
	exception when invalid_parameter_value then null;
	end;
end
$$;
reset role;

select pg_temp.as_user('96250000-0000-4000-8000-00000000000b');
set role authenticated;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060');
	if jsonb_array_length(v_result -> 'drafts') <> 0 then
		raise exception 'an empty draft was listed to another member: %', v_result;
	end if;
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000b', 0, 'Mine');
	if v_result ->> 'status' <> 'ok' or (v_result -> 'draft' ->> 'revision')::bigint <> 1 then
		raise exception 'member could not start their own draft: %', v_result;
	end if;
end
$$;
reset role;

-- A draft cleared away (a month untouched) starts again from the revision its owner
-- last knew, so the revisions others saw never repeat.
delete from public.qorpera_room_drafts where owner_user_id = '96250000-0000-4000-8000-00000000000b';
set role authenticated;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000b', 7, 'Mine');
	if v_result ->> 'status' <> 'ok' or (v_result -> 'draft' ->> 'revision')::bigint <> 8
		or v_result -> 'draft' ->> 'body' <> 'Mine' then
		raise exception 'owner could not start a cleared-away draft again: %', v_result;
	end if;
end
$$;
reset role;

-- A viewer in the room, a company member outside it, and an outsider see and change nothing.
do $$
declare v_user text; v_ok boolean;
begin
	foreach v_user in array array['96250000-0000-4000-8000-0000000000e1', '96250000-0000-4000-8000-00000000000c',
		'96250000-0000-4000-8000-0000000000f0'] loop
		perform pg_temp.as_user(v_user);
		set local role authenticated;
		v_ok := false;
		begin
			perform public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060');
		exception when insufficient_privilege then v_ok := true;
		end;
		if not v_ok then raise exception '% listed room drafts', v_user; end if;
		v_ok := false;
		begin
			perform public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
				'96250000-0000-4000-8000-00000000000b', 1, 'Hijack');
		exception when insufficient_privilege then v_ok := true;
		end;
		if not v_ok then raise exception '% edited a room draft', v_user; end if;
		perform set_config('realtime.topic', 'qorpera-room-drafts-96250000-0000-4000-8000-000000000060', true);
		if exists (select 1 from realtime.messages
			where topic = 'qorpera-room-drafts-96250000-0000-4000-8000-000000000060') then
			raise exception '% received the draft topic', v_user;
		end if;
		reset role;
	end loop;
end
$$;
select set_config('realtime.topic', '', false);

-- Anonymous callers cannot reach the functions at all.
set role anon;
do $$
begin
	begin
		perform public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060');
		raise exception 'anon listed room drafts';
	exception when insufficient_privilege then null;
	end;
end
$$;
reset role;

-- Another member's draft that nobody touched for a day leaves the list; the owner still gets it back.
update public.qorpera_room_drafts set updated_at = clock_timestamp() - interval '2 days'
where owner_user_id = '96250000-0000-4000-8000-00000000000b';
select pg_temp.as_user('96250000-0000-4000-8000-00000000000a');
set role authenticated;
do $$
begin
	if exists (select 1 from jsonb_array_elements(
		public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060') -> 'drafts') as draft
		where draft ->> 'ownerUserId' = '96250000-0000-4000-8000-00000000000b') then
		raise exception 'a day-old draft was listed to another member';
	end if;
end
$$;
reset role;
select pg_temp.as_user('96250000-0000-4000-8000-00000000000b');
set role authenticated;
do $$
begin
	if not exists (select 1 from jsonb_array_elements(
		public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060') -> 'drafts') as draft
		where draft ->> 'ownerUserId' = '96250000-0000-4000-8000-00000000000b' and draft ->> 'body' = 'Mine') then
		raise exception 'the owner lost their own day-old draft';
	end if;
end
$$;
reset role;

-- Leaving the room ends a member's access and takes their draft away.
update public.qorpera_company_room_members set status = 'removed', removed_at = clock_timestamp()
where room_id = '96250000-0000-4000-8000-000000000060' and principal_id = '96250000-0000-4000-8000-00000000000b';
update public.qorpera_room_drafts set updated_at = clock_timestamp()
where owner_user_id = '96250000-0000-4000-8000-00000000000b';
select pg_temp.as_user('96250000-0000-4000-8000-00000000000a');
set role authenticated;
do $$
declare v_result jsonb;
begin
	if exists (select 1 from jsonb_array_elements(
		public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060') -> 'drafts') as draft
		where draft ->> 'ownerUserId' = '96250000-0000-4000-8000-00000000000b') then
		raise exception 'a departed member''s draft was listed';
	end if;
	v_result := public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
		'96250000-0000-4000-8000-00000000000b', 1, 'Edit after they left');
	if v_result ->> 'status' <> 'gone' then
		raise exception 'a departed member''s draft was still writable: %', v_result;
	end if;
end
$$;
reset role;
select pg_temp.as_user('96250000-0000-4000-8000-00000000000b');
set role authenticated;
do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_list_room_drafts('96250000-0000-4000-8000-000000000060');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'a departed member still listed room drafts'; end if;
end
$$;
reset role;

-- An archived room shares nothing.
update public.qorpera_company_rooms set status = 'archived' where id = '96250000-0000-4000-8000-000000000060';
select pg_temp.as_user('96250000-0000-4000-8000-00000000000a');
set role authenticated;
do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_put_room_draft('96250000-0000-4000-8000-000000000060',
			'96250000-0000-4000-8000-00000000000a', 3, 'Archived');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'a draft was written in an archived room'; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);
