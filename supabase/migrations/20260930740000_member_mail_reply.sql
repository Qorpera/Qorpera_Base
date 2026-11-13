-- A member answers in a mail thread (Jonas, 12 November 2026: the Mailbox gets Reply, Reply all and Forward "as in
-- the real gmail/outlook app", in place of the line that told an agent what to answer). Until now a member's own
-- email always began a thread of its own (20260930716000, step M2e); this lets it join one.
-- - qorpera_send_member_mail takes `replyTo`, {kind, id}: the message the email answers, as qorpera_member_mail_thread
--   names it. `received` with a received email's deliveryId, or `sent` with a sent email's mailId (a follow-up to an
--   email of the company's own, an agent's or a member's). The message must be this company's and environment's; mail
--   for one of the company's accounts on a site is not answered (its subject and text are never shown).
-- - The email joins that message's thread, and carries In-Reply-To and References (the answered message's id, after
--   the ids of its own References: the first and the newest that fit one header line, as an agent's reply), so the
--   other side's mail program threads it too. A message with no usable id (a sent email whose Message-ID is not read
--   back yet, a received one without one) is answered in the same thread without those headers.
-- - It is the member's own act, as any email of theirs: no AI line, no automatic review, and unlike an agent's reply
--   it also answers automatic email (a person replying starts no mail loop) and never carries Auto-Submitted.
--   in_reply_to_delivery_id, which marks an agent's automatic reply for the sender (Auto-Submitted: auto-replied),
--   stays empty on a member's email, so qorpera_claim_company_mail is not touched.
-- - Everything else is 20260930716000's: who may send, the mailbox, the recipients, the sending switch and the
--   company's limits. `from` is any live mailbox of the company; the web gives the thread's own.
-- - The answer to such a reply comes back to the same thread. A received email joined the thread of an email the
--   company sent only when that email's id was the first it referenced; now it joins the thread of the message it
--   answers, or of the first it references, when the company knows that message: one it sent from this mailbox or
--   one it received in it. So a member's reply that names only the email it answers (that email's own References are
--   gone with its text after seven days) still gets its answer in the thread.
-- - qorpera_member_mail_thread gives a received message's `replyTo`: the addresses its Reply-To header asks answers
--   to go to, read from the stored message while its text is kept, so Reply goes there and not to a no-reply sender.
-- Exact-text patches; each inserted text names this migration (20260930740000), for deploy guards.
-- qorpera_send_agent_mail and the outbox's claim are not touched.

set local lock_timeout = '3s';

-- A reply's References (RFC 5322 3.6.4): the <id> tokens of the answered message's own References, oldest first, then
-- that message's id, on one header line of at most 980 characters. The first id (the thread's root) keeps its place
-- when it fits beside the id answered, and the newest ids fill the rest. Null when the message answered has no usable
-- id: such a reply goes out without thread headers.
create function public.qorpera_mail_reply_references(p_stored text, p_in_reply_to text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_ids text[];
	v_root text;
	v_references text;
begin
	if p_in_reply_to is null or p_in_reply_to !~ '^<[^<>[:space:][:cntrl:]]+>$' or char_length(p_in_reply_to) > 980 then
		return null; end if;
	-- The ids before it, each once in its first place; the id answered is always the last.
	select coalesce(array_agg(listed.id order by listed.place), '{}') into v_ids from (
		select token.id[1] as id, min(token.place) as place
		from regexp_matches(coalesce(p_stored, ''), '<[^<>[:space:][:cntrl:]]+>', 'g') with ordinality as token(id, place)
		where token.id[1] <> p_in_reply_to
		group by 1) as listed;
	v_ids := v_ids || p_in_reply_to;
	v_references := p_in_reply_to;
	v_root := case when cardinality(v_ids) > 1 and char_length(v_ids[1]) + char_length(p_in_reply_to) + 1 <= 980
		then v_ids[1] end;
	for i in reverse cardinality(v_ids) - 1 .. 2 loop
		exit when coalesce(char_length(v_root) + 1, 0) + char_length(v_ids[i]) + char_length(v_references) + 1 > 980;
		v_references := v_ids[i] || ' ' || v_references;
	end loop;
	if v_root is not null then v_references := v_root || ' ' || v_references; end if;
	return v_references;
end
$$;
revoke all on function public.qorpera_mail_reply_references(text, text) from public, anon, authenticated, service_role;

create function pg_temp.member_reply_patch(p_target regprocedure, p_old text, p_new text)
returns void
language plpgsql
as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Member reply patch anchor not found once in %: %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- What a reply needs beside what a new email does.
select pg_temp.member_reply_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$	v_mail_id uuid := extensions.gen_random_uuid();
	v_thread text;
begin$old$,
	$new$	v_mail_id uuid := extensions.gen_random_uuid();
	v_thread text;
	-- 20260930740000: the message a reply answers, and the thread headers it gives the reply.
	v_received public.qorpera_mail_received%rowtype;
	v_answered public.qorpera_company_mail_outbox%rowtype;
	v_stored text;
	v_in_reply_to text;
	v_references text;
begin$new$);

-- The request may name the message it answers.
select pg_temp.member_reply_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$		or p_request - array['sendId','from','to','cc','subject','text'] <> '{}'::jsonb
$old$,
	$new$		or p_request - array['sendId','from','to','cc','subject','text','replyTo'] <> '{}'::jsonb
		-- 20260930740000: a reply names the message it answers, a received one or a sent one, by its id.
		-- Only an object is taken apart (a case keeps that order).
		or (p_request ? 'replyTo' and case when jsonb_typeof(p_request -> 'replyTo') = 'object' then
			(p_request -> 'replyTo') - array['kind','id'] <> '{}'::jsonb
			or jsonb_typeof(p_request #> '{replyTo,kind}') is distinct from 'string'
			or p_request #>> '{replyTo,kind}' not in ('received', 'sent')
			or jsonb_typeof(p_request #> '{replyTo,id}') is distinct from 'string'
			or p_request #>> '{replyTo,id}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			else true end)
$new$);

-- The message answered: this company's and environment's, with its thread and its ids.
select pg_temp.member_reply_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$	-- The company's limits on recipients, the agents' email and the members' counted together. Email cancelled before
$old$,
	$new$	-- 20260930740000: a reply joins the thread of the message it answers, and carries that message's ids so the other
	-- side's mail program threads it too. It is the member's own act: it answers automatic email as well, and the
	-- sender never marks it Auto-Submitted (in_reply_to_delivery_id, which says an agent replied, stays empty).
	if p_request ? 'replyTo' then
		if p_request #>> '{replyTo,kind}' = 'received' then
			select * into v_received from public.qorpera_mail_received as received
			where received.delivery_id = (p_request #>> '{replyTo,id}')::uuid and received.profile_id = v_profile_id
				and received.environment_id = p_environment_id;
			-- Mail for one of the company's accounts on a site shows no subject and no text: it is not answered.
			if not found or coalesce(v_received.account, public.qorpera_mail_account(v_profile_id, p_environment_id,
					v_received.delivered_to)) is not null then
				raise exception 'The email this answers is not one the company can answer' using errcode = '42501'; end if;
			v_thread := v_received.thread_id;
			v_in_reply_to := v_received.message_id;
			-- The thread's earlier ids are in the email's own References, while its text is kept (seven days).
			select public.qorpera_mail_json_object(convert_from(delivery.body, 'UTF8')) ->> 'references' into v_stored
			from public.qorpera_event_deliveries as delivery
			where delivery.id = v_received.delivery_id and delivery.body is not null;
		else
			select * into v_answered from public.qorpera_company_mail_outbox as mail
			where mail.id = (p_request #>> '{replyTo,id}')::uuid and mail.profile_id = v_profile_id
				and mail.environment_id = p_environment_id;
			if not found then
				raise exception 'The email this answers is not one the company can answer' using errcode = '42501'; end if;
			v_thread := v_answered.thread;
			v_in_reply_to := v_answered.message_id;
			v_stored := v_answered.thread_references;
		end if;
		v_references := public.qorpera_mail_reply_references(v_stored, v_in_reply_to);
		if v_references is null then
			v_in_reply_to := null; end if;
	end if;
	-- The company's limits on recipients, the agents' email and the members' counted together. Email cancelled before
$new$);

-- The email joins that thread, with its headers.
select pg_temp.member_reply_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$	-- The member's text as written: no AI line, since no agent wrote it. A new email begins its own thread.
	v_thread := public.qorpera_mail_thread_id(v_mailbox.id, 'mail:' || v_mail_id);
	insert into public.qorpera_company_mail_outbox (id, thread, profile_id, environment_id, mailbox_id, member_user_id,
		member_send_id, from_name, recipients_to, recipients_cc, subject, body)
	values (v_mail_id, v_thread, v_profile_id, p_environment_id, v_mailbox.id, v_user_id, v_send_id,
		v_member || ' at ' || v_company, v_to, v_cc, btrim(p_request ->> 'subject'),
		rtrim(p_request ->> 'text', E' \t\r\n'))
$old$,
	$new$	-- The member's text as written: no AI line, since no agent wrote it. A new email begins its own thread; a reply
	-- is in the thread of the message it answers (20260930740000).
	v_thread := coalesce(v_thread, public.qorpera_mail_thread_id(v_mailbox.id, 'mail:' || v_mail_id));
	insert into public.qorpera_company_mail_outbox (id, thread, profile_id, environment_id, mailbox_id, member_user_id,
		member_send_id, from_name, recipients_to, recipients_cc, subject, body, in_reply_to, thread_references)
	values (v_mail_id, v_thread, v_profile_id, p_environment_id, v_mailbox.id, v_user_id, v_send_id,
		v_member || ' at ' || v_company, v_to, v_cc, btrim(p_request ->> 'subject'),
		rtrim(p_request ->> 'text', E' \t\r\n'), v_in_reply_to, v_references)
$new$);

-- ---------------------------------------------------------------------------
-- The answer to a reply comes back to its thread
-- ---------------------------------------------------------------------------
-- A received message's id is looked up by mailbox when a later email answers or references it.
create index qorpera_mail_received_message_id on public.qorpera_mail_received (mailbox_id, message_id)
	where message_id is not null;

select pg_temp.member_reply_patch('public.qorpera_mail_received_note(uuid,public.qorpera_company_mailboxes,timestamptz,jsonb,text,text,text)'::regprocedure,
	$old$	v_root text := public.qorpera_mail_thread_root(p_message);
$old$,
	$new$	v_root text := public.qorpera_mail_thread_root(p_message);
	-- 20260930740000: the message it answers, by that message's id.
	v_answers text := case when jsonb_typeof(p_message -> 'inReplyTo') = 'string'
		then public.qorpera_mail_message_id(p_message ->> 'inReplyTo') end;
$new$);
select pg_temp.member_reply_patch('public.qorpera_mail_received_note(uuid,public.qorpera_company_mailboxes,timestamptz,jsonb,text,text,text)'::regprocedure,
	$old$	v_thread := coalesce(
		(select mail.thread from public.qorpera_company_mail_outbox as mail
			where mail.mailbox_id = p_mailbox.id and mail.message_id = v_root limit 1),
		public.qorpera_mail_thread_id(p_mailbox.id, coalesce(v_root, 'delivery:' || p_delivery_id)));$old$,
	$new$	-- 20260930740000: also of a message this mailbox received, and of the message it answers before the first it
	-- references: a member's reply names the email it answers, and the answer to that reply names that email first.
	v_thread := coalesce(
		(select known.thread from (
				select mail.thread, mail.message_id, mail.created_at as at
				from public.qorpera_company_mail_outbox as mail
				where mail.mailbox_id = p_mailbox.id and mail.message_id in (v_answers, v_root)
				union all
				select received.thread_id, received.message_id, received.received_at
				from public.qorpera_mail_received as received
				where received.mailbox_id = p_mailbox.id and received.message_id in (v_answers, v_root)) as known
			order by (known.message_id is not distinct from v_answers) desc, known.at desc limit 1),
		public.qorpera_mail_thread_id(p_mailbox.id, coalesce(v_root, 'delivery:' || p_delivery_id)));$new$);

-- ---------------------------------------------------------------------------
-- Where an email asks its answers to go
-- ---------------------------------------------------------------------------
select pg_temp.member_reply_patch('public.qorpera_member_mail_thread(uuid,text,jsonb)'::regprocedure,
	$old$				'cc', case when mark.value is null then received.recipients_cc end,
$old$,
	$new$				'cc', case when mark.value is null then received.recipients_cc end,
				-- 20260930740000: the addresses its Reply-To header names, while its stored message is kept.
				'replyTo', case when mark.value is null and jsonb_typeof(body.message -> 'replyTo') = 'array'
					then (select jsonb_agg(item.value order by item.n)
						from jsonb_array_elements(body.message -> 'replyTo') with ordinality as item(value, n)
						where item.n <= 10 and jsonb_typeof(item.value) = 'string'
							and char_length(item.value #>> '{}') between 3 and 320) end,
$new$);
