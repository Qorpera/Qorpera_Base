-- Mentions in room posts. A member writes "@" and a name in a group chat or an
-- agent's thread:
-- * agents named in a group chat answer and the room's other agents are not woken;
--   a post that names no agent wakes every agent, as before;
-- * a named agent must answer (its room wake's reply policy is required);
-- * members named are told: the post is listed as an unseen mention for them until
--   they open the conversation.
-- The cloud reads mentions from the text itself, so the message body, the wake
-- payload and the runner are unchanged; clients follow the same rule to suggest
-- names and to show who will answer (packages/web/src/ui/mentions.ts).
--
-- The rule: "@" at the start or after a space, an opening bracket or a quote; then
-- a room member's name; then the end, a space or punctuation. Letters A-Z match in
-- either case and every Unicode space counts as a space (qorpera_mention_fold), the
-- same whatever the database's locale, as in the web. Longer names are read first
-- and take their letters, so "@Bo Jensen" names Bo Jensen and not Bo. Everyone who
-- shares a name named is named.

create table public.qorpera_room_mentions (
	input_id uuid not null references public.qorpera_session_inputs(id) on delete cascade,
	principal_kind text not null check (principal_kind in ('member', 'staff_agent')),
	principal_id uuid not null,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	author_user_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	-- When the member named opened the conversation (members only).
	seen_at timestamptz,
	primary key (input_id, principal_kind, principal_id)
);
create index qorpera_room_mentions_unseen on public.qorpera_room_mentions (principal_id, profile_id, session_id)
	where principal_kind = 'member' and seen_at is null;
alter table public.qorpera_room_mentions enable row level security;
revoke all on public.qorpera_room_mentions from public, anon, authenticated, service_role;

-- Text as the rule reads it: A-Z in lower case, every Unicode space a plain space, the
-- length unchanged. Other letters keep their case: the web inserts names as written.
create function public.qorpera_mention_fold(p_text text)
returns text language sql immutable set search_path = '' as $$
	select translate(
		translate(coalesce(p_text, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
		E'\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
		repeat(' ', 19))
$$;
revoke all on function public.qorpera_mention_fold(text) from public, anon, authenticated, service_role;

-- Who a text names among the room's active members and agents.
create function public.qorpera_room_text_mentions(p_room_id uuid, p_text text)
returns table (principal_kind text, principal_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
	v_text text := public.qorpera_mention_fold(p_text);
	v_candidate record;
	v_pattern text;
	v_name text;
	v_named boolean := false;
begin
	if strpos(v_text, '@') = 0 then return; end if;
	for v_candidate in
		select candidate.kind, candidate.id, candidate.name from (
			select 'staff_agent'::text as kind, member.principal_id as id,
				btrim(public.qorpera_mention_fold(staff.display_name), E' \t\n\r\f\v') as name
			from public.qorpera_company_room_members member
			join public.qorpera_company_rooms room on room.id = member.room_id
			join public.qorpera_profile_staff staff on staff.profile_id = room.profile_id
				and staff.staff_agent_id = member.principal_id and staff.employment_status = 'active'
			where member.room_id = p_room_id and member.principal_kind = 'staff_agent' and member.status = 'active'
			union all
			select 'member'::text, member.principal_id,
				btrim(public.qorpera_mention_fold(profile_member.display_name), E' \t\n\r\f\v')
			from public.qorpera_company_room_members member
			join public.qorpera_company_rooms room on room.id = member.room_id
			join public.qorpera_profile_members profile_member on profile_member.profile_id = room.profile_id
				and profile_member.user_id = member.principal_id
			where member.room_id = p_room_id and member.principal_kind = 'member' and member.status = 'active'
		) candidate
		where candidate.name is not null and candidate.name <> ''
		order by char_length(candidate.name) desc, candidate.name, candidate.kind, candidate.id
	loop
		if v_candidate.name is distinct from v_name then
			-- The last name's letters are taken: a shorter name inside it does not match there. The
			-- boundaries are looked at, not taken, so a name written twice in a row goes twice.
			if v_named then v_text := regexp_replace(v_text, v_pattern, ' ', 'g'); end if;
			v_name := v_candidate.name;
			-- Every character that is not a letter, digit or space is escaped to stand for itself.
			v_pattern := '(^|(?<=[ \t\n\r\f\v(\["''“‘]))@'
				|| regexp_replace(v_candidate.name, '([^[:alnum:][:space:]])', '\\\1', 'g')
				|| '(?=$|[ \t\n\r\f\v.,!?;:)\]}"''”’])';
			v_named := v_text ~ v_pattern;
		end if;
		if v_named then
			principal_kind := v_candidate.kind;
			principal_id := v_candidate.id;
			return next;
		end if;
	end loop;
end
$$;
revoke all on function public.qorpera_room_text_mentions(uuid, text) from public, anon, authenticated, service_role;

-- Record a new post's mentions (never the author's own name); returns the agents it names.
create function public.qorpera_record_room_mentions(p_room_id uuid, p_input_id uuid, p_author_user_id uuid, p_text text)
returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare v_room public.qorpera_company_rooms%rowtype; v_agents uuid[];
begin
	select * into strict v_room from public.qorpera_company_rooms where id = p_room_id;
	insert into public.qorpera_room_mentions (input_id, principal_kind, principal_id, profile_id, session_id, author_user_id)
	select p_input_id, mention.principal_kind, mention.principal_id, v_room.profile_id, v_room.session_id, p_author_user_id
	from public.qorpera_room_text_mentions(p_room_id, p_text) mention
	where not (mention.principal_kind = 'member' and mention.principal_id = p_author_user_id)
	on conflict do nothing;
	select coalesce(array_agg(mention.principal_id order by mention.principal_id), '{}'::uuid[]) into v_agents
	from public.qorpera_room_mentions mention
	where mention.input_id = p_input_id and mention.principal_kind = 'staff_agent';
	return v_agents;
end
$$;
revoke all on function public.qorpera_record_room_mentions(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- The post records its mentions and wakes only the agents it names, when it names any.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)'::regprocedure);
	v_old := $old$v_input public.qorpera_session_inputs%rowtype; v_staff uuid; v_ids uuid[] := '{}'::uuid[]; v_id uuid; v_text text;$old$;
	v_new := $new$v_input public.qorpera_session_inputs%rowtype; v_staff uuid; v_ids uuid[] := '{}'::uuid[]; v_id uuid; v_text text;
	v_mentioned uuid[] := '{}'::uuid[];$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Room post declarations differ'; end if;
	v_definition := replace(v_definition, v_old, v_new);
	v_old := $old$values (v_room.session_id,p_client_input_id,'user_message',v_user,p_body,clock_timestamp()) returning * into v_input;$old$;
	v_new := $new$values (v_room.session_id,p_client_input_id,'user_message',v_user,p_body,clock_timestamp()) returning * into v_input;
		-- Mentions (20260928010000): agents named alone answer; members named are told.
		v_mentioned := public.qorpera_record_room_mentions(v_room.id,v_input.id,v_user,v_text);$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Room post input insert differs'; end if;
	v_definition := replace(v_definition, v_old, v_new);
	v_old := $old$where member.room_id = v_room.id and member.principal_kind = 'staff_agent' and member.status = 'active'
			order by member.principal_id$old$;
	v_new := $new$where member.room_id = v_room.id and member.principal_kind = 'staff_agent' and member.status = 'active'
				and (cardinality(v_mentioned) = 0 or member.principal_id = any(v_mentioned))
			order by member.principal_id$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Room post wake recipients differ'; end if;
	execute replace(v_definition, v_old, v_new);

	-- An agent named in a room post must answer it.
	v_definition := pg_get_functiondef('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure);
	v_old := $old$where room.session_id = v_wake.session_id and room.bound_staff_agent_id = v_wake.staff_agent_id) then
		v_reporting := 'required'; end if;$old$;
	v_new := $new$where room.session_id = v_wake.session_id and room.bound_staff_agent_id = v_wake.staff_agent_id) then
		v_reporting := 'required'; end if;
	if v_wake.wake_kind = 'room' and exists (select 1 from public.qorpera_room_mentions mention
		where mention.input_id = v_wake.source_id and mention.principal_kind = 'staff_agent'
			and mention.principal_id = v_wake.staff_agent_id) then
		v_reporting := 'required'; end if;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Runtime wake policy room rule differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

-- The signed-in member's unseen mentions in a company, by conversation.
create function public.qorpera_list_member_mentions(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	return jsonb_build_object('schema', 'qorpera.member-mentions/v1', 'sessions', coalesce((
		select jsonb_agg(jsonb_build_object('sessionId', unseen.session_id, 'count', unseen.count, 'latestAt', unseen.latest)
			order by unseen.latest desc)
		from (
			select mention.session_id, count(*)::integer as count, max(mention.created_at) as latest
			from public.qorpera_room_mentions mention
			where mention.principal_kind = 'member' and mention.principal_id = auth.uid()
				and mention.profile_id = p_profile_id and mention.seen_at is null
				and public.qorpera_can_read_session(mention.session_id)
			group by mention.session_id
			order by max(mention.created_at) desc
			limit 200
		) unseen
	), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_list_member_mentions(uuid) from public, anon;
grant execute on function public.qorpera_list_member_mentions(uuid) to authenticated;

-- The member opened the conversation: its mentions of them are seen.
create function public.qorpera_mark_member_mentions_seen(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_seen integer;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'session read access is required' using errcode = '42501';
	end if;
	update public.qorpera_room_mentions set seen_at = clock_timestamp()
	where principal_kind = 'member' and principal_id = auth.uid() and session_id = p_session_id and seen_at is null;
	get diagnostics v_seen = row_count;
	return jsonb_build_object('schema', 'qorpera.member-mentions-seen/v1', 'seen', v_seen);
end
$$;
revoke all on function public.qorpera_mark_member_mentions_seen(uuid) from public, anon;
grant execute on function public.qorpera_mark_member_mentions_seen(uuid) to authenticated;
