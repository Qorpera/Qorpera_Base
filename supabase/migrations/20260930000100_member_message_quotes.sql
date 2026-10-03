-- Quoted outside content in a member's message (contract: the 2026-10-02 amendment "quoted outside content in a
-- member's message", I5d part 1). A member's message may carry `quotes`, spans of its text that quote outside
-- content: today an email of the company's mail. Marks people can see are not enough against instructions hidden
-- in an email, so the platform fences those words like a tool result.
--
-- What this migration does:
-- - qorpera_check_member_quotes checks a body's quotes: shape, characters, marks and the mail record. It reads
--   only, never locks, and refuses with 22023. The input RPCs call it after membership and the right to write and
--   before the first lock they take: qorpera_append_session_input, qorpera_request_session_turn_v2,
--   qorpera_post_company_room_message and its folder-v2 path. Their closed body-key checks admit `quotes`.
-- - qorpera_member_message_fenced gives a quoted message as the run sees it: the member's words with each quote
--   replaced by `[quote N]`, and the quotes as `qorpera.member-quote/v1` records with trust "untrusted_data".
--   The run's context source (the current input, and earlier messages in its history) and the room post a
--   continuation carries use it, so the context, every read_context page and its sha256, `parentInputs` and
--   `roomPost` all carry the fenced form.
-- - Room mentions read the member's own words: a name inside a quote names nobody.
-- - The transcript entry keeps the quotes as `qorperaQuotes`, beside `qorperaAttachments`.
-- - A desktop's turn claim never takes a quoted message: it can't fence one.
--
-- Exact-text patches: each fails unless its function has the text given exactly once.

-- A quote list is checked here. Nothing is locked: the mail check reads as the member's mail read does.
create function public.qorpera_check_member_quotes(p_profile_id uuid, p_environment_id uuid, p_body jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
	v_quotes jsonb;
	v_quote jsonb;
	v_text text;
	v_length integer;
	v_start bigint;
	v_end bigint;
	v_previous_end bigint := -1;
	v_thread public.qorpera_mail_threads%rowtype;
begin
	-- I5d-1 (20260930000100): the quote check, called before the first lock.
	if jsonb_typeof(p_body) is distinct from 'object' or not p_body ? 'quotes' then return; end if;
	v_quotes := p_body -> 'quotes';
	if jsonb_typeof(v_quotes) is distinct from 'array' or jsonb_array_length(v_quotes) not between 1 and 16
		or jsonb_typeof(p_body -> 'text') is distinct from 'string' or p_body ? 'displayText' then
		raise exception 'Message quotes are invalid' using errcode = '22023'; end if;
	v_text := p_body ->> 'text';
	v_length := char_length(v_text);
	for v_quote in select value from jsonb_array_elements(v_quotes) loop
		if jsonb_typeof(v_quote) is distinct from 'object'
			or v_quote - 'start' - 'end' - 'source' - 'ref' <> '{}'::jsonb
			or jsonb_typeof(v_quote -> 'start') is distinct from 'number'
			or jsonb_typeof(v_quote -> 'end') is distinct from 'number'
			or jsonb_typeof(v_quote -> 'source') is distinct from 'string'
			or jsonb_typeof(v_quote -> 'ref') is distinct from 'string'
			or (v_quote ->> 'start') !~ '^[0-9]{1,9}$' or (v_quote ->> 'end') !~ '^[0-9]{1,9}$' then
			raise exception 'Message quotes are invalid' using errcode = '22023'; end if;
		v_start := (v_quote ->> 'start')::bigint;
		v_end := (v_quote ->> 'end')::bigint;
		-- In order, apart, 1 to 2,000 characters, each inside a pair of marks: « just before, » just after.
		if v_start < 1 or v_end <= v_start or v_end - v_start > 2000 or v_end >= v_length
			or v_start <= v_previous_end
			or substr(v_text, v_start::integer, 1) <> '«' or substr(v_text, v_end::integer + 1, 1) <> '»' then
			raise exception 'Message quotes are invalid' using errcode = '22023'; end if;
		v_previous_end := v_end;
		if v_quote ->> 'source' <> 'mail' then
			raise exception 'Message quotes are invalid' using errcode = '22023'; end if;
		-- A thread the member's mail read shows them: mail switched on, this company and environment, never account
		-- mail. Any other ref reads as unknown, whether or not it exists.
		select thread.* into v_thread from public.qorpera_mail_threads as thread
		where thread.id = v_quote ->> 'ref' and thread.profile_id = p_profile_id
			and thread.environment_id = p_environment_id;
		if not found or (v_quote ->> 'ref') !~ '^[A-Za-z0-9_-]{43}$'
			or not exists (select 1 from public.qorpera_mail_settings as settings
				where settings.enabled and settings.domain is not null)
			or public.qorpera_mail_thread_account(v_thread) is not null then
			raise exception 'A quote names an unknown record' using errcode = '22023'; end if;
	end loop;
end
$function$;
revoke all on function public.qorpera_check_member_quotes(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- A quoted message as a run sees it, or null when the body has no quotes. The quotes were checked when the message
-- was written; this only cuts the text.
create function public.qorpera_member_message_fenced(p_input_id uuid, p_body jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $function$
declare
	v_text text;
	v_words text := '';
	v_records jsonb := '[]'::jsonb;
	v_quote jsonb;
	v_number integer := 0;
	v_cursor integer := 0;
	v_start integer;
	v_end integer;
begin
	-- I5d-1 (20260930000100): the fenced form of a quoted message.
	if jsonb_typeof(p_body) is distinct from 'object' or jsonb_typeof(p_body -> 'quotes') is distinct from 'array'
		or jsonb_typeof(p_body -> 'text') is distinct from 'string' then return null; end if;
	v_text := p_body ->> 'text';
	for v_quote in select value from jsonb_array_elements(p_body -> 'quotes') order by (value ->> 'start')::integer loop
		v_number := v_number + 1;
		v_start := (v_quote ->> 'start')::integer;
		v_end := (v_quote ->> 'end')::integer;
		v_words := v_words || substr(v_text, v_cursor + 1, v_start - v_cursor) || '[quote ' || v_number || ']';
		v_records := v_records || jsonb_build_array(jsonb_build_object(
			'schema', 'qorpera.member-quote/v1',
			'trust', 'untrusted_data',
			'provenance', jsonb_build_object('inputId', p_input_id, 'quote', v_number,
				'source', v_quote ->> 'source', 'ref', v_quote ->> 'ref'),
			'text', substr(v_text, v_start + 1, v_end - v_start)));
		v_cursor := v_end;
	end loop;
	return jsonb_build_object('text', v_words || substr(v_text, v_cursor + 1), 'quotes', v_records);
end
$function$;
revoke all on function public.qorpera_member_message_fenced(uuid, jsonb) from public, anon, authenticated, service_role;

create function pg_temp.member_quotes_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- A conversation input: quotes are checked after the right to write and before the company fence, and the body may
-- carry them.
select pg_temp.member_quotes_patch('public.qorpera_append_session_input(uuid,uuid,text,jsonb)',
	$old$	v_profile_id := public.qorpera_session_profile_for_write(p_session_id);
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
$old$,
	$new$	v_profile_id := public.qorpera_session_profile_for_write(p_session_id);
	-- I5d-1 (20260930000100): a message's quotes, before the company fence.
	perform public.qorpera_check_member_quotes(v_profile_id,
		(select session.environment_id from public.qorpera_shared_sessions as session where session.id = p_session_id), p_body);
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
$new$);
select pg_temp.member_quotes_patch('public.qorpera_append_session_input(uuid,uuid,text,jsonb)',
	$old$			or p_body - 'schema' - 'text' - 'displayText' - 'images' <> '{}'::jsonb then
$old$,
	$new$			or p_body - 'schema' - 'text' - 'displayText' - 'images' - 'quotes' <> '{}'::jsonb then
$new$);

-- Asking for a turn: checked after the write checks and before the conversation's lock. The input it appends is
-- checked again there, under that lock, the same way.
select pg_temp.member_quotes_patch('public.qorpera_request_session_turn_v2(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
	$old$	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
$old$,
	$new$	-- I5d-1 (20260930000100): a message's quotes, before the conversation's lock.
	perform public.qorpera_check_member_quotes(
		(select session.profile_id from public.qorpera_shared_sessions as session where session.id = p_session_id),
		(select session.environment_id from public.qorpera_shared_sessions as session where session.id = p_session_id), p_body);
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
$new$);

-- A room message (snapshot-v1): checked after membership and before the company fence; the body may carry quotes.
select pg_temp.member_quotes_patch('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)',
	$old$	perform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_company_rooms where id=p_room_id));
$old$,
	$new$	-- I5d-1 (20260930000100): a message's quotes, before the company fence.
	perform public.qorpera_check_member_quotes((select room.profile_id from public.qorpera_company_rooms as room where room.id = p_room_id),
		(select room.environment_id from public.qorpera_company_rooms as room where room.id = p_room_id), p_body);
	perform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_company_rooms where id=p_room_id));
$new$);
select pg_temp.member_quotes_patch('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)',
	$old$		or p_body - array['schema','text','images'] <> '{}'::jsonb
$old$,
	$new$		or p_body - array['schema','text','images','quotes'] <> '{}'::jsonb
$new$);

-- A room message (folder-v2): checked with the body checks, before the folder's locks.
select pg_temp.member_quotes_patch('public.qorpera_folder_post_room_message(uuid,uuid,jsonb,uuid,bigint)',
	$old$		or p_body - array['schema','text','images'] <> '{}'::jsonb
$old$,
	$new$		or p_body - array['schema','text','images','quotes'] <> '{}'::jsonb
$new$);
select pg_temp.member_quotes_patch('public.qorpera_folder_post_room_message(uuid,uuid,jsonb,uuid,bigint)',
	$old$	-- The room's agents, as the answering loop reads them.
$old$,
	$new$	-- I5d-1 (20260930000100): a message's quotes, before the folder's locks.
	perform public.qorpera_check_member_quotes(v_room.profile_id, v_room.environment_id, p_body);
	-- The room's agents, as the answering loop reads them.
$new$);

-- Mentions read the member's own words: a name inside a quote (an email's "@Luna") names nobody, so it neither picks
-- the agent that answers nor tells a member. Both room paths.
select pg_temp.member_quotes_patch(room_function,
	$old$		v_mentioned := public.qorpera_record_room_mentions(v_room.id,v_input.id,v_user,v_text);
$old$,
	$new$		-- I5d-1 (20260930000100): a name inside a quote names nobody.
		v_mentioned := public.qorpera_record_room_mentions(v_room.id,v_input.id,v_user,
			coalesce(public.qorpera_member_message_fenced(v_input.id, p_body) ->> 'text', v_text));
$new$)
from unnest(array[
	'public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)',
	'public.qorpera_folder_post_room_message(uuid,uuid,jsonb,uuid,bigint)'
]::regprocedure[]) as room_function;

-- The transcript entry keeps the quotes beside the attachments, so history can be fenced the same way.
select pg_temp.member_quotes_patch('public.qorpera_append_admitted_input_events(uuid,uuid[])',
	$old$					'qorperaAttachments', v_images
				)
			);
$old$,
	$new$					'qorperaAttachments', v_images
				) -- I5d-1 (20260930000100): the quotes beside the attachments.
				|| case when jsonb_typeof(v_input.body -> 'quotes') = 'array'
					then jsonb_build_object('qorperaQuotes', v_input.body -> 'quotes') else '{}'::jsonb end
			);
$new$);

-- The run's context: the current input and earlier messages carry the fenced form, never the quoted words as text.
select pg_temp.member_quotes_patch('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)',
	$old$		v_text := case when jsonb_typeof(v_input.body -> 'text') = 'string' then v_input.body ->> 'text' else v_input.body::text end;
$old$,
	$new$		-- I5d-1 (20260930000100): a quoted input in its fenced form.
		v_text := coalesce(public.qorpera_member_message_fenced(v_input.id, v_input.body)::text,
			case when jsonb_typeof(v_input.body -> 'text') = 'string' then v_input.body ->> 'text' else v_input.body::text end);
$new$);
select pg_temp.member_quotes_patch('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)',
	$old$		v_text := v_event.body::text;
$old$,
	$new$		v_text := v_event.body::text;
		-- I5d-1 (20260930000100): an earlier quoted message: its entry carries the member's words with placeholders and the quote records.
		if v_kind = 'historical_human_message' and public.qorpera_member_message_fenced(v_input.id, v_input.body) is not null then
			v_text := jsonb_set(jsonb_set(v_event.body, '{entry,message,content}',
					jsonb_build_array(jsonb_build_object('type', 'text',
						'text', public.qorpera_member_message_fenced(v_input.id, v_input.body) ->> 'text'))),
				'{entry,qorperaQuotes}', public.qorpera_member_message_fenced(v_input.id, v_input.body) -> 'quotes')::text;
		end if;
$new$);

-- A continuation carries the room post that woke it fenced as well.
select pg_temp.member_quotes_patch(continuation_function,
	$old$'roomPost',(select jsonb_build_object('kind','historical_room_input','id',id,'authorUserId',author_user_id,'body',body)$old$,
	$new$'roomPost',(select jsonb_build_object('kind','historical_room_input','id',id,'authorUserId',author_user_id,'body', /* I5d-1 (20260930000100) */
		case when public.qorpera_member_message_fenced(id, body) is null then body
			else body - 'text' - 'quotes' || public.qorpera_member_message_fenced(id, body) end)$new$)
from unnest(array[
	'public.qorpera_office_run_continuation(public.qorpera_execution_runs,integer)',
	'public.qorpera_worker_run_continuation(public.qorpera_execution_runs,integer)',
	'public.qorpera_machine_run_continuation(public.qorpera_execution_runs,integer)'
]::regprocedure[]) as continuation_function;

-- A desktop's turn claim can't fence a quoted message, so it never takes one.
select pg_temp.member_quotes_patch('public.qorpera_claim_session_turn(uuid,uuid,integer,uuid,bigint)',
	$old$	with pending as (
$old$,
	$new$	-- I5d-1 (20260930000100): a desktop can't fence a quoted message.
	if exists (select 1 from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.completed_at is null and input.failed_at is null
			and input.body ? 'quotes') then
		return jsonb_build_object('claimed', false, 'reason', 'quotes-need-a-cloud-run');
	end if;
	with pending as (
$new$);
