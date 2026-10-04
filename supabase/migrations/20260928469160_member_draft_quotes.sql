-- Quoted outside content in a member's message, I5d part 2 (contract: the 2026-10-02 amendment "quoted outside
-- content in a member's message", items 1 and 2). Two things the first part left for this one:
-- - Only a company whose runs fence quotes takes them. A whole-tree company runs on the legacy runner, which can't
--   fence a quote and refuses a run that holds one (I5d part 3), so one quoted message would stop every later run of
--   its conversation. qorpera_check_member_quotes now refuses quotes with 22023 unless the company is folder-v2 or
--   its Company File is on the company path (path_gateway_version 1). Every input RPC goes through it.
-- - A draft keeps its quotes beside its text, room drafts included, so a reload, another device or a co-editor keeps
--   them. qorpera_put_room_draft takes the quotes as an optional fifth argument (a client that sends four arguments
--   still reaches it), checks them as a message's quotes, and stores them. The draft's JSON carries its quotes.
--   Once a draft holds quotes, a save that keeps a quote's words without its record, or changes them, is refused
--   (22023), and removing a quote whole is an ordinary save (qorpera_draft_keeps_quotes):
--   - each earlier quote's words still in the text, inside their marks, keep a record of the same thread at that
--     place;
--   - a text-only save (an older client's, which can't send quotes) brings no newly marked words: a quote edited
--     inside its marks would otherwise become the member's own.
--   The member's own guillemets (»ja«, « merci ») are theirs. A client that knows quotes and has none left sends an
--   empty list, which the draft stores as none: its save is not a text-only one, so removing the last quote and
--   writing its own marks in the same save is ordinary. (A message still refuses an empty list.)
--
-- Exact-text patches keep I5d part 1's body marker; each patched or new function also carries "I5d-2 (20260930008000)".

create function pg_temp.member_draft_quotes_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- Quotes only where a run fences them.
select pg_temp.member_draft_quotes_patch('public.qorpera_check_member_quotes(uuid,uuid,jsonb)',
	$old$	if jsonb_typeof(p_body) is distinct from 'object' or not p_body ? 'quotes' then return; end if;
$old$,
	$new$	if jsonb_typeof(p_body) is distinct from 'object' or not p_body ? 'quotes' then return; end if;
	-- I5d-2 (20260930008000): a whole-tree company's legacy runner can't fence a quote.
	if not public.qorpera_environment_is_folder_v2(p_environment_id) and not exists (
		select 1 from public.qorpera_company_files as file
		where file.environment_id = p_environment_id and file.path_gateway_version = 1) then
		raise exception 'Quotes need a company whose runs fence them' using errcode = '22023'; end if;
$new$);

-- A draft's quotes, beside its text.
alter table public.qorpera_room_drafts
	add column quotes jsonb check (quotes is null or (jsonb_typeof(quotes) = 'array'
		and jsonb_array_length(quotes) between 1 and 16));

create or replace function public.qorpera_room_draft_json_internal(p_draft public.qorpera_room_drafts)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- I5d-2 (20260930008000): the draft's quotes travel with it.
	select jsonb_build_object(
		'schema', 'qorpera.room-draft/v1',
		'roomId', p_draft.room_id,
		'ownerUserId', p_draft.owner_user_id,
		'body', p_draft.body,
		'revision', p_draft.revision,
		'editorUserId', p_draft.editor_user_id,
		'contributors', to_jsonb(p_draft.contributors),
		'updatedAt', p_draft.updated_at)
		|| case when p_draft.quotes is null then '{}'::jsonb else jsonb_build_object('quotes', p_draft.quotes) end
$$;
revoke all on function public.qorpera_room_draft_json_internal(public.qorpera_room_drafts)
	from public, anon, authenticated, service_role;

-- Whether a save keeps a draft's quotes: see the header. Positions count characters (code points) from 0, as quotes do.
create function public.qorpera_draft_keeps_quotes(p_old_body text, p_old_quotes jsonb, p_body text, p_quotes jsonb)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare
	v_quote jsonb;
	v_words text;
	v_from integer;
	v_at integer;
	v_own text[];
	v_segment text;
	v_index integer;
begin
	-- I5d-2 (20260930008000): a draft's quotes are kept, never turned into the member's words.
	if p_old_quotes is null then return true; end if;
	for v_quote in select value from jsonb_array_elements(p_old_quotes) loop
		v_words := substr(p_old_body, (v_quote ->> 'start')::integer + 1,
			(v_quote ->> 'end')::integer - (v_quote ->> 'start')::integer);
		v_from := 1;
		loop
			v_at := strpos(substr(p_body, v_from), '«' || v_words || '»');
			exit when v_at = 0;
			-- The « stands at character v_from + v_at - 1 (from 1), so the words start there (from 0).
			if not exists (select 1 from jsonb_array_elements(coalesce(p_quotes, '[]'::jsonb)) as kept(value)
				where (kept.value ->> 'start')::integer = v_from + v_at - 1
					and (kept.value ->> 'end')::integer = v_from + v_at - 1 + char_length(v_words)
					and kept.value ->> 'source' = v_quote ->> 'source' and kept.value ->> 'ref' = v_quote ->> 'ref') then
				return false; end if;
			v_from := v_from + v_at;
		end loop;
	end loop;
	if p_quotes is not null then return true; end if;
	-- A text-only save: its marked words must all have been the member's own before.
	v_own := array(select segment[1] from regexp_matches(p_old_body, '«([^«»]*)»', 'g') as segment);
	for v_quote in select value from jsonb_array_elements(p_old_quotes) loop
		v_index := array_position(v_own, substr(p_old_body, (v_quote ->> 'start')::integer + 1,
			(v_quote ->> 'end')::integer - (v_quote ->> 'start')::integer));
		if v_index is not null then v_own := v_own[:v_index - 1] || v_own[v_index + 1:]; end if;
	end loop;
	for v_segment in select segment[1] from regexp_matches(p_body, '«([^«»]*)»', 'g') as segment loop
		v_index := array_position(v_own, v_segment);
		if v_index is null then return false; end if;
		v_own := v_own[:v_index - 1] || v_own[v_index + 1:];
	end loop;
	return true;
end
$$;
revoke all on function public.qorpera_draft_keeps_quotes(text, jsonb, text, jsonb)
	from public, anon, authenticated, service_role;

-- Replace a draft's text, and its quotes, only from its current revision. A stale revision changes nothing and
-- returns the current draft, so the editor merges its own change into it and writes again. Only the owner starts a
-- draft (from revision 0, or from the revision it last knew when the old one was cleared away, so revisions never go
-- back); any member of the room edits one that exists.
drop function public.qorpera_put_room_draft(uuid, uuid, bigint, text);
create function public.qorpera_put_room_draft(
	p_room_id uuid, p_owner_user_id uuid, p_base_revision bigint, p_body text, p_quotes jsonb default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_draft public.qorpera_room_drafts%rowtype;
	v_contributors uuid[];
	-- An empty list: a client that knows quotes, with none left. The draft stores none.
	v_quotes jsonb := case when p_quotes = '[]'::jsonb then null else p_quotes end;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null
		or not public.qorpera_room_draft_member_internal(p_room_id, v_user) then
		raise exception 'Room is unavailable' using errcode = '42501';
	end if;
	-- Revisions stay within what a browser counts exactly (2^53).
	if p_base_revision is null or p_base_revision < 0 or p_base_revision > 9007199254740990 or p_body is null
		or octet_length(convert_to(p_body, 'utf8')) > 65536 then
		raise exception 'Draft is invalid' using errcode = '22023';
	end if;
	-- I5d-2 (20260930008000): a draft's quotes are checked as a message's would be, before the draft's lock.
	if v_quotes is not null then
		perform public.qorpera_check_member_quotes(room.profile_id, room.environment_id,
			jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_body, 'quotes', v_quotes))
		from public.qorpera_company_rooms as room where room.id = p_room_id;
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
		insert into public.qorpera_room_drafts (room_id, owner_user_id, body, revision, editor_user_id, quotes)
		values (p_room_id, p_owner_user_id, p_body, p_base_revision + 1, v_user, v_quotes)
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
	elsif v_draft.body = p_body and v_draft.quotes is not distinct from v_quotes then
		return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'ok',
			'draft', public.qorpera_room_draft_json_internal(v_draft));
	else
		-- A save that keeps a quote's words without its record, or changes them, is refused; removing a quote whole is
		-- an ordinary save. The list as sent: an empty one is not a text-only save.
		if not public.qorpera_draft_keeps_quotes(v_draft.body, v_draft.quotes, p_body, p_quotes) then
			raise exception 'A save would keep a quote''s words without its record' using errcode = '22023';
		end if;
		-- The owner emptying the draft (it was sent or cleared) ends its contributors.
		v_contributors := case
			when v_user = p_owner_user_id and p_body = '' then '{}'::uuid[]
			when v_user = p_owner_user_id or v_user = any (v_draft.contributors) then v_draft.contributors
			when cardinality(v_draft.contributors) >= 64 then v_draft.contributors
			else v_draft.contributors || v_user
		end;
		update public.qorpera_room_drafts
		set body = p_body, quotes = v_quotes, revision = v_draft.revision + 1, editor_user_id = v_user,
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
revoke all on function public.qorpera_put_room_draft(uuid, uuid, bigint, text, jsonb) from public, anon;
grant execute on function public.qorpera_put_room_draft(uuid, uuid, bigint, text, jsonb) to authenticated;
