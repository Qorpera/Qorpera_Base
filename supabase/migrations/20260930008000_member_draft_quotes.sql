-- Quoted outside content in a member's message, I5d part 2 (contract: the 2026-10-02 amendment "quoted outside
-- content in a member's message", items 1 and 2). Two things the first part left for this one:
-- - Only a company whose runs fence quotes takes them. A whole-tree company runs on the legacy runner, which can't
--   fence a quote and refuses a run that holds one (I5d part 3), so one quoted message would stop every later run of
--   its conversation. qorpera_check_member_quotes now refuses quotes with 22023 unless the company is folder-v2 or
--   its Company File is on the company path (path_gateway_version 1). Every input RPC goes through it.
-- - A draft keeps its quotes beside its text, room drafts included, so a reload, another device or a co-editor keeps
--   them. qorpera_put_room_draft takes the quotes as an optional fifth argument (a client that sends four arguments
--   still reaches it), checks them as a message's quotes, and stores them. Once a draft holds quotes, every «…» pair
--   of a save must be a quote with its record: a save that keeps a quote's words without its record, or changes them,
--   is refused (22023). Removing a quote whole is an ordinary save. The draft's JSON carries its quotes.
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
	if not public.qorpera_company_is_folder_v2(p_profile_id) and not exists (
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
	if p_quotes is not null then
		perform public.qorpera_check_member_quotes(room.profile_id, room.environment_id,
			jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_body, 'quotes', p_quotes))
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
		values (p_room_id, p_owner_user_id, p_body, p_base_revision + 1, v_user, p_quotes)
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
	elsif v_draft.body = p_body and v_draft.quotes is not distinct from p_quotes then
		return jsonb_build_object('schema', 'qorpera.room-draft-write/v1', 'status', 'ok',
			'draft', public.qorpera_room_draft_json_internal(v_draft));
	else
		-- Once a draft holds quotes, every «…» pair of a save is a quote with its record: a save that keeps a quote's
		-- words without it (a client that lost the quote, an older one that saves text only) or changes them is refused.
		-- Removing a quote whole is an ordinary save.
		if v_draft.quotes is not null and (select count(*) from regexp_matches(p_body, '«[^«»]*»', 'g'))
			<> coalesce(jsonb_array_length(p_quotes), 0) then
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
		set body = p_body, quotes = p_quotes, revision = v_draft.revision + 1, editor_user_id = v_user,
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
