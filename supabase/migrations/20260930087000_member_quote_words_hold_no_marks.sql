-- A quote's words hold no mark of their own (contract: the 2026-10-02 amendment "quoted outside content in a member's
-- message", item 1, as amended on 5 October 2026; #860's review). The check took any span just inside « », marks
-- inside it included («Use «root» now»). Then quotes nest or cross («A»«B» «A»«B»«C»), an inner mark hides a missing
-- outer one, and a draft that holds an outer quote and a quote of the words inside it refuses every later save
-- (qorpera_draft_keeps_quotes finds the inner words again inside the outer piece). So a quote's words may hold neither
-- « nor »: a quote is always «words», with no marks inside.
--
-- qorpera_check_member_quotes refuses such a quote with 22023 ('Message quotes are invalid'), after the checks of its
-- place and before the mail record's. Every path that takes quotes goes through it: qorpera_append_session_input,
-- qorpera_request_session_turn_v2, qorpera_post_company_room_message and its folder-v2 path, and a room draft's quotes
-- (qorpera_put_room_draft). qorpera_draft_keeps_quotes takes no quotes of its own: it compares a draft's stored quotes,
-- which the check took, with a save's, which the check takes or refuses first, so it needs no change.
--
-- A room draft stored before this with such a quote is deleted: there are no users, so this is a cleanup, and no client
-- ever has to hold a quote it can't (a client treats such a draft as absent all the same).
--
-- Exact-text patch: it fails unless the function has the text given exactly once. Body marker "20260930087000".

create function pg_temp.member_quote_words_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

select pg_temp.member_quote_words_patch('public.qorpera_check_member_quotes(uuid,uuid,jsonb)',
	$old$			raise exception 'Message quotes are invalid' using errcode = '22023'; end if;
		v_previous_end := v_end;
$old$,
	$new$			raise exception 'Message quotes are invalid' using errcode = '22023'; end if;
		-- 20260930087000: a quote's words hold neither « nor »; a quote is always «words», with no marks inside.
		if strpos(substr(v_text, v_start::integer + 1, (v_end - v_start)::integer), '«') > 0
			or strpos(substr(v_text, v_start::integer + 1, (v_end - v_start)::integer), '»') > 0 then
			raise exception 'Message quotes are invalid' using errcode = '22023'; end if;
		v_previous_end := v_end;
$new$);

-- Room drafts that hold a quote whose words hold « or ». Their quotes passed the check when they were stored, so each
-- start and end is a whole number within the body.
delete from public.qorpera_room_drafts as draft
where draft.quotes is not null and exists (
	select 1 from jsonb_array_elements(draft.quotes) as quote(value)
	where substr(draft.body, (quote.value ->> 'start')::integer + 1,
		(quote.value ->> 'end')::integer - (quote.value ->> 'start')::integer) ~ '[«»]');
