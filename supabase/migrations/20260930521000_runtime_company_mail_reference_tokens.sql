-- 20260930521000: a reply's References lists the thread's ids as <id> tokens, whatever the shape of the stored header
-- (the coordinator, 20 October 2026; deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Sending (M2b)").
--
-- The mail provider sends a References header with several ids as a list, and the mail door stored the text of that
-- list (`["<a@example.org>","<b@example.net>"]`). send_mail split the stored References at spaces, so the text was one
-- id, and the provider put it in angle brackets: on 20 October 2026 (21:20 UTC) a reply went out with
-- `References: <["<A>","<B>"]> <C>`. Now send_mail takes the <id> tokens of the stored References, whatever is around
-- them, so a plain header, the text of a list and anything else give a clean list, for the mail stored before this
-- migration too. A token with a control character is left out on its own (it left out the whole stored References
-- before). The rest is 20260928309740's: the email answered comes last, and the first id and the newest ids fill one
-- header line (980 characters, RFC 5322 3.6.4). The mail door (supabase/functions/mail-intake) also stores such a
-- header as <id> tokens on one line from now on.
--
-- Deploy order: none; this migration and the mail door each fix replies on their own.

set local lock_timeout = '3s';

create function pg_temp.mail_references_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail references integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.mail_references_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$				v_references := btrim(regexp_replace(coalesce(v_message ->> 'references', ''), '\s+', ' ', 'g'));
				v_ids := case when v_references ~ '[[:cntrl:]]' then '{}'::text[]
					else array_remove(regexp_split_to_array(v_references, ' '), '') end || v_in_reply_to;$old$,
	$new$				-- They are the <id> tokens of the stored References, whatever is around them: a header, the text of a
				-- list (the provider's shape for a header with several ids) or anything else.
				v_ids := array(select token.id[1] from regexp_matches(coalesce(v_message ->> 'references', ''),
					'<[^<>[:space:][:cntrl:]]+>', 'g') with ordinality as token(id, place) order by token.place)
					|| v_in_reply_to;$new$);
