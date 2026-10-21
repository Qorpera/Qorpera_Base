-- Members read mail (I5a), for the rebuilt Mailbox page: a list line shows the start of the mail, as a mail app does.
-- - qorpera_member_mail_threads gives each thread a `snippet`: the start of its newest message's text (a received
--   message's while its body is kept, a sent one's while the outbox keeps it), on one line, at most 200 characters.
--   Account mail has none, as it has no subject.
-- - qorpera_member_mail_waiting gives each waiting send a `snippet` of the text the agent wants to send, the same way.
-- Who may call, and every other part of both answers, are unchanged; the thread read keeps its full texts. A snippet
-- that can't be read (a body that isn't JSON or UTF-8) is left out; it never fails the list. Exact-text patches; each
-- inserted text names this migration (20260930522000), for deploy guards.

-- Text as a list line shows it: whitespace runs as one space, at most 200 characters; none when nothing is left.
create function public.qorpera_mail_snippet(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
	select nullif(left(btrim(regexp_replace(left(p_text, 4000), '[[:space:]]+', ' ', 'g')), 200), '')
$$;
revoke all on function public.qorpera_mail_snippet(text) from public, anon, authenticated, service_role;

-- A thread's snippet: its newest message's text. The newest received one is the thread's last received delivery,
-- read while the delivery keeps its body; the newest sent one is the thread's newest outbox email.
create function public.qorpera_mail_thread_snippet(p_thread text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_thread public.qorpera_mail_threads%rowtype;
begin
	select * into v_thread from public.qorpera_mail_threads as thread where thread.id = p_thread;
	if not found then return null; end if;
	if v_thread.last_direction = 'received' then
		return (select public.qorpera_mail_snippet(
				public.qorpera_mail_json_object(convert_from(delivery.body, 'UTF8')) ->> 'text')
			from public.qorpera_event_deliveries as delivery
			where delivery.id = v_thread.last_received_delivery_id and delivery.body is not null);
	end if;
	return (select public.qorpera_mail_snippet(mail.body)
		from public.qorpera_company_mail_outbox as mail
		where mail.thread = v_thread.id and mail.profile_id = v_thread.profile_id
		order by mail.created_at desc, mail.id desc limit 1);
exception when others then
	return null;
end
$$;
revoke all on function public.qorpera_mail_thread_snippet(text) from public, anon, authenticated, service_role;

create function pg_temp.mail_snippet_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail snippet patch anchor not found once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
begin
	perform pg_temp.mail_snippet_patch('public.qorpera_member_mail_threads(uuid,jsonb)',
		E'\t\t\t''account'', shown.account_mark)) order by shown.place)',
		E'\t\t\t''account'', shown.account_mark,\n'
		|| E'\t\t\t-- 20260930522000: the start of the newest message, never for account mail.\n'
		|| E'\t\t\t''snippet'', case when shown.account_mark is null\n'
		|| E'\t\t\t\tthen public.qorpera_mail_thread_snippet(shown.id) end)) order by shown.place)');
	perform pg_temp.mail_snippet_patch('public.qorpera_member_mail_waiting(uuid)',
		E'\t\t\t''to'', open_send.arguments -> ''to'', ''subject'', open_send.arguments -> ''subject'',\n',
		E'\t\t\t''to'', open_send.arguments -> ''to'', ''subject'', open_send.arguments -> ''subject'',\n'
		|| E'\t\t\t-- 20260930522000: the start of the text the agent wants to send.\n'
		|| E'\t\t\t''snippet'', case when jsonb_typeof(open_send.arguments -> ''text'') = ''string''\n'
		|| E'\t\t\t\tthen public.qorpera_mail_snippet(open_send.arguments ->> ''text'') end,\n');
end $$;
