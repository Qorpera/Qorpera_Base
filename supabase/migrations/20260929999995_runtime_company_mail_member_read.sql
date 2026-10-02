-- Company mail for members: build step I5a (Q1, with the Interfaces session, 2 October 2026; design
-- deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Members read mail (I5a)"; deploy/first-node/RUNTIME-INTERFACES.md §4,
-- the `mail` and `mail_addresses` sources).
--
-- Any member of a company reads its mail: the mailboxes with the agents that handle them, the threads newest first,
-- one thread's received and sent messages, and the sends that wait for a person's answer on a review card. The
-- calls check membership with a plain read before anything else (a company being deleted has none) and take no
-- lock; with mail switched off they answer empty. Account mail (mail to an address a company account signs in with,
-- A1's qorpera_company_account_mail, used once it exists) shows who used the account and when, never its subject,
-- text, recipients or attachments: decided when the mail arrives, and asked again when it is read.
--
-- Threads. A thread's id is base64url (no padding) of sha-256 over "<mailbox id>:<key>": safe in a URL and a path,
-- and the same after the text is cleared. A received message's key is its thread's root Message-ID (the first id it
-- references, else the one it answers, else its own); a reply to an email an agent started from that mailbox joins
-- the email's thread through the provider's Message-ID, which mail-outbox reads back after sending; mail without
-- ids, and mail received before this migration, is a thread of its own ("delivery:<id>"). An agent's reply joins
-- the received email's thread; an email an agent starts begins one ("mail:<id>"). What a received message needs
-- for 30 days (its thread, sender, subject, recipients, the sender's authentication, its attachments' descriptions
-- and its account mark) lives in qorpera_mail_received, apart from the delivery's headers and body, which the
-- deliveries' purge clears after 7 days. qorpera_mail_threads indexes the threads: kept as the mail door and
-- send_mail write messages, read by the members' calls, and deleted 30 days after their last message, with the
-- members' read marks.
--
-- Locks: the mail door takes a thread row after the company's usage row; a send takes it after the company's mail
-- limits lock; a read mark takes its own row and a key share of its thread. The members' reads lock nothing.

set local lock_timeout = '3s';

create function pg_temp.member_mail_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Member mail integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Threads
-- ---------------------------------------------------------------------------
create function public.qorpera_mail_thread_id(p_mailbox_id uuid, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
	select translate(rtrim(encode(extensions.digest(p_mailbox_id::text || ':' || p_key, 'sha256'), 'base64'), '='),
		'+/', '-_')
$$;
revoke all on function public.qorpera_mail_thread_id(uuid, text) from public, anon, authenticated, service_role;

-- A Message-ID as RFC 5322 writes it: in angle brackets, printable ASCII without quotes or backslashes, at most 998.
create function public.qorpera_mail_message_id(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
	select case when found.id ~ '^<[!#-''*-;=?-[\]-~]+>$' and char_length(found.id) <= 998 then found.id end
	from (select coalesce(substring(p_value from '<[^<>[:space:]]+>'),
		'<' || substring(btrim(p_value) from '^[^<>[:space:]]+$') || '>') as id) as found
$$;
revoke all on function public.qorpera_mail_message_id(text) from public, anon, authenticated, service_role;

-- The root of a received message's thread: the first id it references, else the one it answers, else its own.
create function public.qorpera_mail_thread_root(p_message jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
	select coalesce(
		case when jsonb_typeof(p_message -> 'references') = 'string'
			then public.qorpera_mail_message_id(substring(p_message ->> 'references' from '<[^<>[:space:]]+>')) end,
		case when jsonb_typeof(p_message -> 'inReplyTo') = 'string'
			then public.qorpera_mail_message_id(p_message ->> 'inReplyTo') end,
		case when jsonb_typeof(p_message -> 'messageId') = 'string'
			then public.qorpera_mail_message_id(p_message ->> 'messageId') end)
$$;
revoke all on function public.qorpera_mail_thread_root(jsonb) from public, anon, authenticated, service_role;

-- "Name <address>" or "address": the name and the bare address, lowercased, as a thread keeps them.
create function public.qorpera_mail_party(p_value text)
returns table (name text, address text)
language sql
immutable
set search_path = ''
as $$
	select left(nullif(btrim(regexp_replace(substring(p_value from '^(.*)<[^<>]*>\s*$'), '^"|"$', '', 'g')), ''), 320),
		left(nullif(lower(btrim(coalesce(substring(p_value from '<([^<>]*)>\s*$'), p_value))), ''), 320)
$$;
revoke all on function public.qorpera_mail_party(text) from public, anon, authenticated, service_role;

create table public.qorpera_mail_threads (
	id text primary key check (id ~ '^[A-Za-z0-9_-]{43}$'),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	-- The mailbox it began in.
	mailbox_id uuid not null references public.qorpera_company_mailboxes(id) on delete cascade,
	-- The newest message's subject, and the party outside the company: the newest received message's sender, else the
	-- first recipient of an email an agent started.
	subject text check (subject is null or char_length(subject) <= 998),
	outside_name text check (outside_name is null or char_length(outside_name) <= 320),
	outside_address text check (outside_address is null or char_length(outside_address) <= 320),
	last_at timestamptz not null,
	last_direction text not null check (last_direction in ('received', 'sent')),
	last_received_at timestamptz,
	last_received_delivery_id uuid,
	last_sent_at timestamptz,
	last_sent_staff_agent_id uuid,
	message_count integer not null default 0 check (message_count >= 0),
	-- Once a received message of it is account mail, the thread is: its subject is never shown.
	account jsonb check (account is null or jsonb_typeof(account) = 'object'),
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_mail_threads_environment on public.qorpera_mail_threads (environment_id, last_at desc, id desc);
create index qorpera_mail_threads_kept on public.qorpera_mail_threads (last_at);
alter table public.qorpera_mail_threads enable row level security;
revoke all on table public.qorpera_mail_threads from public, anon, authenticated, service_role;

-- Each received message as members read it, for the 30 days its delivery is kept.
create table public.qorpera_mail_received (
	delivery_id uuid primary key references public.qorpera_event_deliveries(id) on delete cascade,
	thread_id text not null check (thread_id ~ '^[A-Za-z0-9_-]{43}$'),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	mailbox_id uuid not null references public.qorpera_company_mailboxes(id) on delete cascade,
	received_at timestamptz not null,
	message_id text check (message_id is null or char_length(message_id) <= 998),
	from_name text check (from_name is null or char_length(from_name) <= 320),
	from_address text check (from_address is null or char_length(from_address) <= 320),
	subject text check (subject is null or char_length(subject) <= 998),
	delivered_to text[] not null default '{}' check (cardinality(delivered_to) <= 200),
	recipients_to jsonb check (recipients_to is null or (jsonb_typeof(recipients_to) = 'array'
		and jsonb_array_length(recipients_to) <= 50)),
	recipients_cc jsonb check (recipients_cc is null or (jsonb_typeof(recipients_cc) = 'array'
		and jsonb_array_length(recipients_cc) <= 50)),
	authentication jsonb check (authentication is null or jsonb_typeof(authentication) = 'object'),
	automated boolean not null default false,
	attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array'
		and jsonb_array_length(attachments) <= 50),
	account jsonb check (account is null or jsonb_typeof(account) = 'object')
);
create index qorpera_mail_received_thread on public.qorpera_mail_received (thread_id, received_at desc, delivery_id desc);
alter table public.qorpera_mail_received enable row level security;
revoke all on table public.qorpera_mail_received from public, anon, authenticated, service_role;

create table public.qorpera_mail_thread_reads (
	thread_id text not null references public.qorpera_mail_threads(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	read_at timestamptz not null,
	primary key (thread_id, user_id)
);
alter table public.qorpera_mail_thread_reads enable row level security;
revoke all on table public.qorpera_mail_thread_reads from public, anon, authenticated, service_role;

-- Account mail (A1's I5b): the account a received message's addresses sign in with, once A1's lookup exists. It is
-- given the mailbox's own company and environment, never ones taken from the mail.
create function public.qorpera_mail_account(p_profile_id uuid, p_environment_id uuid, p_delivered_to text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_account jsonb;
begin
	if coalesce(cardinality(p_delivered_to), 0) = 0
		or to_regprocedure('public.qorpera_company_account_mail(uuid,uuid,text[])') is null then
		return null; end if;
	execute 'select public.qorpera_company_account_mail($1, $2, $3)' into v_account
	using p_profile_id, p_environment_id, p_delivered_to;
	return case when jsonb_typeof(v_account) = 'object' then v_account end;
end
$$;
revoke all on function public.qorpera_mail_account(uuid, uuid, text[]) from public, anon, authenticated, service_role;

-- A message joins its thread: the thread's newest message, subject and outside party move on with it.
create function public.qorpera_mail_thread_note(p_thread text, p_profile_id uuid, p_environment_id uuid,
	p_mailbox_id uuid, p_direction text, p_at timestamptz, p_subject text, p_outside_name text,
	p_outside_address text, p_delivery_id uuid, p_staff_agent_id uuid, p_account jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_mail_threads as thread (id, profile_id, environment_id, mailbox_id, subject, outside_name,
		outside_address, last_at, last_direction, last_received_at, last_received_delivery_id, last_sent_at,
		last_sent_staff_agent_id, message_count, account)
	values (p_thread, p_profile_id, p_environment_id, p_mailbox_id, left(p_subject, 998), left(p_outside_name, 320),
		left(p_outside_address, 320), p_at, p_direction,
		case when p_direction = 'received' then p_at end, case when p_direction = 'received' then p_delivery_id end,
		case when p_direction = 'sent' then p_at end, case when p_direction = 'sent' then p_staff_agent_id end, 1,
		p_account)
	on conflict (id) do update set
		subject = case when excluded.last_at >= thread.last_at then coalesce(excluded.subject, thread.subject)
			else thread.subject end,
		-- A received message names the outside party; a sent one only while none is known.
		outside_name = case when p_direction = 'received' and excluded.last_at >= coalesce(thread.last_received_at, '-infinity')
			then excluded.outside_name when thread.outside_address is null then excluded.outside_name else thread.outside_name end,
		outside_address = case when p_direction = 'received' and excluded.last_at >= coalesce(thread.last_received_at, '-infinity')
			then excluded.outside_address else coalesce(thread.outside_address, excluded.outside_address) end,
		last_direction = case when excluded.last_at >= thread.last_at then excluded.last_direction else thread.last_direction end,
		last_at = greatest(thread.last_at, excluded.last_at),
		last_received_at = case when p_direction = 'received' and excluded.last_at >= coalesce(thread.last_received_at, '-infinity')
			then excluded.last_at else thread.last_received_at end,
		last_received_delivery_id = case when p_direction = 'received'
				and excluded.last_at >= coalesce(thread.last_received_at, '-infinity')
			then excluded.last_received_delivery_id else thread.last_received_delivery_id end,
		last_sent_at = case when p_direction = 'sent' and excluded.last_at >= coalesce(thread.last_sent_at, '-infinity')
			then excluded.last_at else thread.last_sent_at end,
		last_sent_staff_agent_id = case when p_direction = 'sent'
				and excluded.last_at >= coalesce(thread.last_sent_at, '-infinity')
			then excluded.last_sent_staff_agent_id else thread.last_sent_staff_agent_id end,
		message_count = thread.message_count + 1,
		account = coalesce(excluded.account, thread.account)
	-- The id is the company's mailbox's: another company's thread never shares it.
	where thread.profile_id = excluded.profile_id;
end
$$;
revoke all on function public.qorpera_mail_thread_note(text, uuid, uuid, uuid, text, timestamptz, text, text, text, uuid,
	uuid, jsonb) from public, anon, authenticated, service_role;

-- A received message joins its thread: it is recorded for members, and the thread learns of it.
create function public.qorpera_mail_received_note(p_delivery_id uuid, p_mailbox public.qorpera_company_mailboxes,
	p_received_at timestamptz, p_message jsonb, p_delivered_to text, p_from text, p_subject text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_root text := public.qorpera_mail_thread_root(p_message);
	v_thread text;
	v_party record;
	v_delivered_to text[] := coalesce(string_to_array(p_delivered_to, ', '), '{}');
	v_account jsonb;
begin
	-- A reply to an email an agent started from this mailbox joins that email's thread; else its root's; else its own.
	v_thread := coalesce(
		(select mail.thread from public.qorpera_company_mail_outbox as mail
			where mail.mailbox_id = p_mailbox.id and mail.message_id = v_root limit 1),
		public.qorpera_mail_thread_id(p_mailbox.id, coalesce(v_root, 'delivery:' || p_delivery_id)));
	select * into v_party from public.qorpera_mail_party(p_from);
	v_account := public.qorpera_mail_account(p_mailbox.profile_id, p_mailbox.environment_id, v_delivered_to);
	insert into public.qorpera_mail_received (delivery_id, thread_id, profile_id, environment_id, mailbox_id, received_at,
		message_id, from_name, from_address, subject, delivered_to, recipients_to, recipients_cc, authentication,
		automated, attachments, account)
	values (p_delivery_id, v_thread, p_mailbox.profile_id, p_mailbox.environment_id, p_mailbox.id, p_received_at,
		public.qorpera_mail_message_id(p_message ->> 'messageId'), v_party.name, v_party.address,
		-- An account mail's subject (its code) is not kept for members.
		case when v_account is null then left(p_subject, 998) end,
		v_delivered_to[1:200],
		case when jsonb_typeof(p_message -> 'to') = 'array'
			then (select jsonb_agg(item.value) from jsonb_array_elements(p_message -> 'to') with ordinality as item(value, n)
				where item.n <= 50 and jsonb_typeof(item.value) = 'string' and char_length(item.value #>> '{}') <= 320) end,
		case when jsonb_typeof(p_message -> 'cc') = 'array'
			then (select jsonb_agg(item.value) from jsonb_array_elements(p_message -> 'cc') with ordinality as item(value, n)
				where item.n <= 50 and jsonb_typeof(item.value) = 'string' and char_length(item.value #>> '{}') <= 320) end,
		case when jsonb_typeof(p_message -> 'authentication') = 'object' then jsonb_strip_nulls(jsonb_build_object(
			'spf', left(p_message #>> '{authentication,spf}', 32), 'dkim', left(p_message #>> '{authentication,dkim}', 32),
			'dmarc', left(p_message #>> '{authentication,dmarc}', 32))) end,
		coalesce(p_message -> 'automated' = 'true'::jsonb, false),
		coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
				'filename', left(item.value ->> 'filename', 256), 'contentType', left(item.value ->> 'contentType', 256),
				'size', case when jsonb_typeof(item.value -> 'size') = 'number' then item.value -> 'size' end)) order by item.n)
			from jsonb_array_elements(case when jsonb_typeof(p_message -> 'attachments') = 'array'
				then p_message -> 'attachments' else '[]'::jsonb end) with ordinality as item(value, n)
			where item.n <= 50 and jsonb_typeof(item.value) = 'object'), '[]'::jsonb),
		v_account)
	on conflict (delivery_id) do nothing;
	perform public.qorpera_mail_thread_note(v_thread, p_mailbox.profile_id, p_mailbox.environment_id, p_mailbox.id,
		'received', p_received_at, case when v_account is null then p_subject end, v_party.name, v_party.address,
		p_delivery_id, null, v_account);
end
$$;
revoke all on function public.qorpera_mail_received_note(uuid, public.qorpera_company_mailboxes, timestamptz, jsonb, text,
	text, text) from public, anon, authenticated, service_role;

-- The outbox keeps each email's thread, and the provider's Message-ID once mail-outbox has read it back.
alter table public.qorpera_company_mail_outbox
	add column thread text check (thread is null or thread ~ '^[A-Za-z0-9_-]{43}$'),
	add column message_id text check (message_id is null or (char_length(message_id) <= 998
		and message_id ~ '^<[^<>[:space:][:cntrl:]]+>$')),
	add column message_id_checked_at timestamptz;
create index qorpera_company_mail_outbox_thread on public.qorpera_company_mail_outbox (thread);
create index qorpera_company_mail_outbox_message_id on public.qorpera_company_mail_outbox (mailbox_id, message_id)
	where message_id is not null;
create index qorpera_company_mail_outbox_message_id_due on public.qorpera_company_mail_outbox (settled_at)
	where status = 'sent' and message_id is null and provider_message_id is not null;
-- The open send_mail cards a member reads.
create index qorpera_action_reviews_open_sends on public.qorpera_action_reviews (profile_id, created_at desc)
	where tool_name = 'send_mail' and decision = 'ask' and answer is null;

-- Mail from before this migration (the last 30 days), threaded as the mail door and send_mail now do, in the order
-- the messages came; older outbox emails get their thread's id only. Called once here; it records only what is not
-- recorded yet.
create function public.qorpera_mail_threads_backfill()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_message record; v_mail public.qorpera_company_mail_outbox%rowtype; v_count integer := 0;
begin
	for v_message in
		select 'received' as direction, delivery.id, delivery.received_at as at, mailbox as box,
			case when delivery.body is not null then public.qorpera_mail_json_object(convert_from(delivery.body, 'UTF8')) end
				as message,
			delivery.headers
		from public.qorpera_event_deliveries as delivery
		join public.qorpera_company_mailboxes as mailbox on mailbox.hook_id = delivery.hook_id
		where delivery.event_type = 'mail.received' and delivery.status = 'verified'
			and delivery.received_at > clock_timestamp() - interval '30 days'
			and not exists (select 1 from public.qorpera_mail_received as received where received.delivery_id = delivery.id)
		union all
		select 'sent', mail.id, mail.created_at, null, null, null
		from public.qorpera_company_mail_outbox as mail
		where mail.created_at > clock_timestamp() - interval '30 days' and mail.thread is null
		order by 3, 2
	loop
		if v_message.direction = 'received' then
			perform public.qorpera_mail_received_note(v_message.id, v_message.box, v_message.at,
				coalesce(v_message.message, '{}'::jsonb), v_message.headers ->> 'delivered-to',
				coalesce(v_message.headers ->> 'from', v_message.message ->> 'from'),
				coalesce(v_message.headers ->> 'subject', v_message.message ->> 'subject'));
		else
			update public.qorpera_company_mail_outbox as mail
			set thread = coalesce(
				(select received.thread_id from public.qorpera_mail_received as received
					where received.delivery_id = mail.in_reply_to_delivery_id),
				(select public.qorpera_mail_thread_id(mailbox.id, 'delivery:' || mail.in_reply_to_delivery_id)
					from public.qorpera_event_deliveries as delivery
					join public.qorpera_company_mailboxes as mailbox on mailbox.hook_id = delivery.hook_id
					where delivery.id = mail.in_reply_to_delivery_id),
				public.qorpera_mail_thread_id(mail.mailbox_id, 'mail:' || mail.id))
			where mail.id = v_message.id
			returning * into v_mail;
			perform public.qorpera_mail_thread_note(v_mail.thread, v_mail.profile_id, v_mail.environment_id,
				v_mail.mailbox_id, 'sent', v_mail.created_at, v_mail.subject, null, v_mail.recipients_to[1], null,
				v_mail.staff_agent_id, null);
		end if;
		v_count := v_count + 1;
	end loop;
	update public.qorpera_company_mail_outbox as mail
	set thread = coalesce(
		(select public.qorpera_mail_thread_id(mailbox.id, 'delivery:' || mail.in_reply_to_delivery_id)
			from public.qorpera_event_deliveries as delivery
			join public.qorpera_company_mailboxes as mailbox on mailbox.hook_id = delivery.hook_id
			where delivery.id = mail.in_reply_to_delivery_id),
		public.qorpera_mail_thread_id(mail.mailbox_id, 'mail:' || mail.id))
	where mail.thread is null;
	return v_count;
end
$$;
revoke all on function public.qorpera_mail_threads_backfill() from public, anon, authenticated, service_role;

-- A JSON object from text, or null when the text is none.
create function public.qorpera_mail_json_object(p_text text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare v_value jsonb;
begin
	v_value := p_text::jsonb;
	return case when jsonb_typeof(v_value) = 'object' then v_value end;
exception when others then
	return null;
end
$$;
revoke all on function public.qorpera_mail_json_object(text) from public, anon, authenticated, service_role;

select public.qorpera_mail_threads_backfill();
alter table public.qorpera_company_mail_outbox alter column thread set not null;

-- The mail door records each received message for members, after its usage, in its thread.
select pg_temp.member_mail_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		set deliveries = usage.deliveries + 1, bytes = usage.bytes + excluded.bytes;$old$,
	$new$		set deliveries = usage.deliveries + 1, bytes = usage.bytes + excluded.bytes;
		-- Members read it in its thread (I5a).
		perform public.qorpera_mail_received_note(v_delivery_id, v_mailbox, clock_timestamp(), v_parsed,
			v_headers ->> 'delivered-to', v_headers ->> 'from', v_headers ->> 'subject');$new$);

-- send_mail: a reply joins the received email's thread, a new email begins one, and the thread learns of it.
select pg_temp.member_mail_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	v_attachment_bytes bigint := 0;
begin$old$,
	$new$	v_attachment_bytes bigint := 0;
	v_mail_id uuid := extensions.gen_random_uuid();
	v_thread text;
begin$new$);
select pg_temp.member_mail_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	insert into public.qorpera_company_mail_outbox (profile_id, environment_id, mailbox_id, run_id, call_id,$old$,
	$new$	v_thread := case when v_delivery.id is not null
		then coalesce((select received.thread_id from public.qorpera_mail_received as received
				where received.delivery_id = v_delivery.id),
			public.qorpera_mail_thread_id((select mailbox.id from public.qorpera_company_mailboxes as mailbox
				where mailbox.hook_id = v_delivery.hook_id), 'delivery:' || v_delivery.id))
		else public.qorpera_mail_thread_id(v_mailbox.id, 'mail:' || v_mail_id) end;
	insert into public.qorpera_company_mail_outbox (id, thread, profile_id, environment_id, mailbox_id, run_id, call_id,$new$);
select pg_temp.member_mail_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	values (v_run.profile_id, v_run.environment_id, v_mailbox.id, v_run.id, p_call_id, v_run.staff_agent_id,$old$,
	$new$	values (v_mail_id, v_thread, v_run.profile_id, v_run.environment_id, v_mailbox.id, v_run.id, p_call_id,
		v_run.staff_agent_id,$new$);
select pg_temp.member_mail_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	returning * into v_mail;
	return public.qorpera_agent_mail_receipt(v_mail, v_threaded);$old$,
	$new$	returning * into v_mail;
	perform public.qorpera_mail_thread_note(v_thread, v_run.profile_id, v_run.environment_id, v_mailbox.id, 'sent',
		v_mail.created_at, v_mail.subject, null, v_to[1], null, v_run.staff_agent_id, null);
	return public.qorpera_agent_mail_receipt(v_mail, v_threaded);$new$);

-- The outbox's claim also deletes threads quiet for 30 days (their read marks go with them), a bounded batch.
select pg_temp.member_mail_patch('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$	select settings.* into v_settings from public.qorpera_mail_settings as settings;$old$,
	$new$	delete from public.qorpera_mail_threads where id in (select id from public.qorpera_mail_threads
		where last_at < v_now - interval '30 days' order by last_at limit 500);
	select settings.* into v_settings from public.qorpera_mail_settings as settings;$new$);

-- mail-outbox reads back the provider's Message-ID of what it sent, so a reply to an email an agent started joins
-- its thread: the sent emails still without one (a day at most, each asked again after five minutes, those never
-- asked first, the newest first) ...
create function public.qorpera_company_mail_message_ids_due(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare v_now timestamptz := clock_timestamp(); v_result jsonb;
begin
	if p_limit is null or p_limit not between 1 and 10 then
		raise exception 'Company mail message id request is invalid' using errcode = '22023'; end if;
	with due as (
		select mail.id from public.qorpera_company_mail_outbox as mail
		where mail.status = 'sent' and mail.message_id is null and mail.provider_message_id is not null
			and mail.settled_at between v_now - interval '1 day' and v_now - interval '10 seconds'
			and (mail.message_id_checked_at is null or mail.message_id_checked_at < v_now - interval '5 minutes')
		order by mail.message_id_checked_at nulls first, mail.settled_at desc
		for update skip locked
		limit p_limit
	), checked as (
		update public.qorpera_company_mail_outbox as mail set message_id_checked_at = v_now
		from due where mail.id = due.id
		returning mail.id, mail.provider_message_id
	)
	select coalesce(jsonb_agg(jsonb_build_object('mailId', checked.id, 'providerMessageId', checked.provider_message_id)),
		'[]'::jsonb) into v_result from checked;
	return v_result;
end
$$;
revoke all on function public.qorpera_company_mail_message_ids_due(integer) from public, anon, authenticated;
grant execute on function public.qorpera_company_mail_message_ids_due(integer) to service_role;

-- ... and records each, once, for the email the provider sent under that id.
create function public.qorpera_record_company_mail_message_id(p_mail_id uuid, p_provider_message_id text,
	p_message_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare v_message_id text := public.qorpera_mail_message_id(p_message_id);
begin
	if v_message_id is null then return false; end if;
	update public.qorpera_company_mail_outbox set message_id = v_message_id
	where id = p_mail_id and provider_message_id = p_provider_message_id and status = 'sent' and message_id is null;
	return found;
end
$$;
revoke all on function public.qorpera_record_company_mail_message_id(uuid, text, text) from public, anon, authenticated;
grant execute on function public.qorpera_record_company_mail_message_id(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The members' reads
-- ---------------------------------------------------------------------------
-- The caller's company for an environment, checked with a plain read before anything else: a member of a company
-- that is not being deleted, or the call is refused.
create function public.qorpera_member_mail_company(p_environment_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_profile_id uuid;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_environment_id is null then
		raise exception 'Company mail is unavailable' using errcode = '42501'; end if;
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment where environment.id = p_environment_id;
	if v_profile_id is null or public.qorpera_member_role(v_profile_id) is null then
		raise exception 'Company mail is unavailable' using errcode = '42501'; end if;
	return v_profile_id;
end
$$;
revoke all on function public.qorpera_member_mail_company(uuid) from public, anon, authenticated, service_role;

-- An agent by its id, with its name when the company has it.
create function public.qorpera_member_mail_agent(p_profile_id uuid, p_staff_agent_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select case when p_staff_agent_id is null then null else jsonb_strip_nulls(jsonb_build_object(
		'staffAgentId', p_staff_agent_id,
		'name', (select staff.display_name from public.qorpera_profile_staff as staff
			where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id))) end
$$;
revoke all on function public.qorpera_member_mail_agent(uuid, uuid) from public, anon, authenticated, service_role;

-- The agent whose routine woke on a received message.
create function public.qorpera_member_mail_woken_agent(p_delivery_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
	select version.staff_agent_id
	from public.qorpera_event_wake_deliveries as taken
	join public.qorpera_cloud_routines as routine on routine.id = taken.routine_id
	join public.qorpera_cloud_routine_versions as version
		on version.routine_id = routine.id and version.version = routine.current_version
	where taken.delivery_id = p_delivery_id
	order by taken.taken_at desc
	limit 1
$$;
revoke all on function public.qorpera_member_mail_woken_agent(uuid) from public, anon, authenticated, service_role;

-- The sends waiting for a person: the company's open review cards of send_mail in the environment, with their
-- arguments and the thread of the email each answers.
create function public.qorpera_member_mail_open_sends(p_profile_id uuid, p_environment_id uuid)
returns table (review_id uuid, staff_agent_id uuid, created_at timestamptz, arguments jsonb, thread text)
language sql
stable
security definer
set search_path = ''
as $$
	select review.id, review.staff_agent_id, review.created_at, card.arguments,
		(select received.thread_id from public.qorpera_mail_received as received
			where card.arguments ->> 'inReplyTo' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				and received.delivery_id = (card.arguments ->> 'inReplyTo')::uuid and received.profile_id = p_profile_id)
	from public.qorpera_action_reviews as review
	join public.qorpera_execution_runs as run on run.id = review.run_id
	cross join lateral (select case when jsonb_typeof(review.action -> 'arguments') = 'string'
		then public.qorpera_mail_json_object(review.action ->> 'arguments') end as arguments) as card
	where review.profile_id = p_profile_id and review.tool_name = 'send_mail' and review.decision = 'ask'
		and review.answer is null and run.environment_id = p_environment_id and card.arguments is not null
	order by review.created_at desc
	limit 200
$$;
revoke all on function public.qorpera_member_mail_open_sends(uuid, uuid) from public, anon, authenticated, service_role;

-- `mail_addresses`: the live mailboxes, with the routines that listen on them, their agents, and the last 7 days'
-- received mail (counted to 10,000).
create function public.qorpera_member_mail_addresses(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id); v_domain text; v_result jsonb;
begin
	select settings.domain into v_domain from public.qorpera_mail_settings as settings where settings.enabled;
	if v_domain is null then return '[]'::jsonb; end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'address', mailbox.local_part || '@' || v_domain, 'hookId', mailbox.hook_id, 'status', hook.status,
		'handledBy', coalesce((select jsonb_agg(public.qorpera_member_mail_agent(v_profile_id, listening.staff_agent_id)
			order by listening.staff_agent_id) from (select distinct version.staff_agent_id
				from public.qorpera_event_listener_cursors as cursor
				join public.qorpera_cloud_routines as routine on routine.id = cursor.routine_id
				join public.qorpera_cloud_routine_versions as version
					on version.routine_id = routine.id and version.version = routine.current_version
				where cursor.hook_id = mailbox.hook_id and cursor.active and routine.status = 'active') as listening),
			'[]'::jsonb),
		'routines', coalesce((select jsonb_agg(jsonb_build_object('routineId', routine.id, 'title', version.title,
				'staffAgentId', version.staff_agent_id) order by version.title, routine.id)
			from public.qorpera_event_listener_cursors as cursor
			join public.qorpera_cloud_routines as routine on routine.id = cursor.routine_id
			join public.qorpera_cloud_routine_versions as version
				on version.routine_id = routine.id and version.version = routine.current_version
			where cursor.hook_id = mailbox.hook_id and cursor.active and routine.status = 'active'), '[]'::jsonb),
		'last7Days', (select count(*) from (select 1 from public.qorpera_event_deliveries as delivery
			where delivery.hook_id = mailbox.hook_id and delivery.status = 'verified'
				and delivery.event_type = 'mail.received' and delivery.received_at > clock_timestamp() - interval '7 days'
			limit 10000) as recent)
	) order by mailbox.local_part), '[]'::jsonb) into v_result
	from public.qorpera_company_mailboxes as mailbox
	join public.qorpera_event_hooks as hook on hook.id = mailbox.hook_id
	where mailbox.environment_id = p_environment_id and mailbox.profile_id = v_profile_id and mailbox.removed_at is null;
	return v_result;
end
$$;
revoke all on function public.qorpera_member_mail_addresses(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_addresses(uuid) to authenticated;

-- `mail`: the threads, newest first, at most 50 a page, by mailbox address and state; the next page starts before
-- {lastAt, thread}. A thread is handled when a reply that has not failed or been cancelled followed its newest
-- received message.
create function public.qorpera_member_mail_threads(p_environment_id uuid, p_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
	v_domain text;
	v_box text;
	v_limit integer;
	v_before_at timestamptz;
	v_before_thread text;
	v_threads jsonb;
	v_more boolean;
	v_next jsonb;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['address', 'state', 'before', 'limit'] <> '{}'::jsonb
		or coalesce(jsonb_typeof(p_request -> 'address'), 'string') <> 'string'
		or char_length(p_request ->> 'address') not between 3 and 320
		or coalesce(p_request ->> 'state', 'new') not in ('new', 'handled', 'waiting')
		or coalesce(jsonb_typeof(p_request -> 'state'), 'string') <> 'string'
		or coalesce(jsonb_typeof(p_request -> 'limit'), 'number') <> 'number'
		or coalesce(p_request ->> 'limit', '50') !~ '^[1-9][0-9]?$' or coalesce((p_request ->> 'limit')::integer, 50) > 50
		or coalesce(jsonb_typeof(p_request -> 'before'), 'object') <> 'object'
		or (p_request ? 'before' and ((p_request -> 'before') - array['lastAt', 'thread'] <> '{}'::jsonb
			or jsonb_typeof(p_request #> '{before,lastAt}') is distinct from 'string'
			or p_request #>> '{before,lastAt}'
				!~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
			or jsonb_typeof(p_request #> '{before,thread}') is distinct from 'string'
			or p_request #>> '{before,thread}' !~ '^[A-Za-z0-9_-]{43}$')) then
		raise exception 'Mail threads request is invalid' using errcode = '22023'; end if;
	begin
		v_before_at := (p_request #>> '{before,lastAt}')::timestamptz;
	exception when others then
		raise exception 'Mail threads request is invalid' using errcode = '22023';
	end;
	v_before_thread := p_request #>> '{before,thread}';
	v_limit := coalesce((p_request ->> 'limit')::integer, 50);
	select settings.domain into v_domain from public.qorpera_mail_settings as settings where settings.enabled;
	if v_domain is null then return jsonb_build_object('threads', '[]'::jsonb); end if;
	v_box := public.qorpera_mail_box_part(lower(btrim(p_request ->> 'address')));
	if p_request ? 'address' and (v_box is null
		or lower(btrim(p_request ->> 'address')) <> substring(lower(btrim(p_request ->> 'address')) from '^[^@]+') || '@' || v_domain) then
		return jsonb_build_object('threads', '[]'::jsonb); end if;
	with waiting as (
		select distinct open_send.thread
		from public.qorpera_member_mail_open_sends(v_profile_id, p_environment_id) as open_send
		where open_send.thread is not null
	), page as (
		select thread.*, mailbox.local_part,
			case when thread.id in (select waiting.thread from waiting) then 'waiting'
				when thread.last_received_at is null or exists (select 1 from public.qorpera_company_mail_outbox as mail
					where mail.thread = thread.id and mail.created_at >= thread.last_received_at
						and mail.status not in ('failed', 'cancelled')) then 'handled'
				else 'new' end as state
		from public.qorpera_mail_threads as thread
		join public.qorpera_company_mailboxes as mailbox on mailbox.id = thread.mailbox_id
		where thread.environment_id = p_environment_id and thread.profile_id = v_profile_id
			and (v_box is null or mailbox.local_part = v_box)
			and (v_before_at is null or (thread.last_at, thread.id) < (v_before_at, v_before_thread))
		order by thread.last_at desc, thread.id desc
		-- A state filter looks at a bounded window, so a page never scans every thread.
		limit case when p_request ? 'state' then 2000 else v_limit + 1 end
	), kept as (
		select page.*, row_number() over (order by page.last_at desc, page.id desc) as place
		from page where not p_request ? 'state' or page.state = p_request ->> 'state'
	), shown as (
		select kept.*, coalesce(kept.account, public.qorpera_mail_account(kept.profile_id, kept.environment_id,
			(select received.delivered_to from public.qorpera_mail_received as received
				where received.delivery_id = kept.last_received_delivery_id))) as account_mark
		from kept where kept.place <= v_limit
	)
	select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
			'thread', shown.id, 'address', shown.local_part || '@' || v_domain,
			'fromName', shown.outside_name, 'fromAddress', shown.outside_address,
			'subject', case when shown.account_mark is null then shown.subject end,
			'lastAt', shown.last_at, 'state', shown.state,
			'handledBy', public.qorpera_member_mail_agent(shown.profile_id, coalesce(shown.last_sent_staff_agent_id,
				public.qorpera_member_mail_woken_agent(shown.last_received_delivery_id))),
			'direction', shown.last_direction,
			'unread', shown.last_received_at is not null and not exists (select 1
				from public.qorpera_mail_thread_reads as mark
				where mark.thread_id = shown.id and mark.user_id = auth.uid() and mark.read_at >= shown.last_received_at),
			'messages', shown.message_count,
			'account', shown.account_mark)) order by shown.place), '[]'::jsonb),
		-- More: matches past this page, or a state filter's window that ended before the threads did.
		(select count(*) > v_limit from kept) or (p_request ? 'state' and (select count(*) from page) = 2000),
		case when (select count(*) > v_limit from kept)
			then (select jsonb_build_object('lastAt', last.last_at, 'thread', last.id) from shown as last
				order by last.place desc limit 1)
			else (select jsonb_build_object('lastAt', last.last_at, 'thread', last.id) from page as last
				order by last.last_at, last.id limit 1) end
	into v_threads, v_more, v_next
	from shown;
	return jsonb_strip_nulls(jsonb_build_object('threads', v_threads,
		'nextBefore', case when v_more then v_next end));
end
$$;
revoke all on function public.qorpera_member_mail_threads(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_threads(uuid, jsonb) to authenticated;

-- One thread: its newest 50 messages, oldest first, received and sent, each text cut to 16,000 characters while it is
-- kept, and the sends waiting for a person in it. The 50 are chosen first; only their bodies are read.
create function public.qorpera_member_mail_thread(p_environment_id uuid, p_thread text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
	v_domain text;
	v_thread public.qorpera_mail_threads%rowtype;
	v_messages jsonb;
	v_more boolean;
	v_waiting jsonb;
begin
	if p_thread is null or p_thread !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'Mail thread request is invalid' using errcode = '22023'; end if;
	select settings.domain into v_domain from public.qorpera_mail_settings as settings where settings.enabled;
	if v_domain is null then return jsonb_build_object('messages', '[]'::jsonb, 'waiting', '[]'::jsonb); end if;
	select * into v_thread from public.qorpera_mail_threads as thread
	where thread.id = p_thread and thread.environment_id = p_environment_id and thread.profile_id = v_profile_id;
	if not found then
		raise exception 'No mail thread of this company has that id' using errcode = '22023'; end if;
	with chosen as (
		select * from (
			(select received.received_at as at, 'received:' || received.delivery_id as key, received.delivery_id,
				null::uuid as mail_id
			from public.qorpera_mail_received as received
			where received.thread_id = p_thread and received.profile_id = v_profile_id
			order by received.received_at desc, received.delivery_id desc limit 51)
			union all
			(select mail.created_at, 'sent:' || mail.id, null, mail.id
			from public.qorpera_company_mail_outbox as mail
			where mail.thread = p_thread and mail.profile_id = v_profile_id
			order by mail.created_at desc, mail.id desc limit 51)
		) as both_kinds
		order by both_kinds.at desc, both_kinds.key desc
		limit 51
	), placed as (
		select chosen.*, row_number() over (order by chosen.at desc, chosen.key desc) as place from chosen
	), items as (
		select placed.at, placed.key, placed.place, jsonb_strip_nulls(jsonb_build_object(
				'kind', 'received', 'deliveryId', received.delivery_id, 'fromName', received.from_name,
				'fromAddress', received.from_address,
				'to', case when mark.value is null then received.recipients_to end,
				'cc', case when mark.value is null then received.recipients_cc end,
				'subject', case when mark.value is null then received.subject end,
				'text', case when mark.value is null then left(body.message ->> 'text', 16000) end,
				'textTruncated', case when mark.value is null and char_length(body.message ->> 'text') > 16000 then true end,
				'textCleared', delivery.body is null,
				'authentication', received.authentication,
				'automated', received.automated,
				'receivedAt', received.received_at,
				'attachments', case when mark.value is null and jsonb_array_length(received.attachments) > 0
					then received.attachments end,
				'handledBy', public.qorpera_member_mail_agent(v_profile_id,
					public.qorpera_member_mail_woken_agent(received.delivery_id)),
				'account', mark.value)) as item
		from placed
		join public.qorpera_mail_received as received on received.delivery_id = placed.delivery_id
		left join public.qorpera_event_deliveries as delivery on delivery.id = received.delivery_id
		cross join lateral (select case when delivery.body is not null
			then public.qorpera_mail_json_object(convert_from(delivery.body, 'UTF8')) end as message) as body
		cross join lateral (select coalesce(received.account, public.qorpera_mail_account(received.profile_id,
			received.environment_id, received.delivered_to)) as value) as mark
		where placed.place <= 50
		union all
		select placed.at, placed.key, placed.place, jsonb_strip_nulls(jsonb_build_object(
			'kind', 'sent', 'mailId', mail.id, 'fromName', mail.from_name,
			'fromAddress', coalesce(mail.from_address, (select box.local_part || '@' || v_domain
				from public.qorpera_company_mailboxes as box where box.id = mail.mailbox_id)),
			'to', to_jsonb(mail.recipients_to), 'cc', to_jsonb(mail.recipients_cc), 'subject', mail.subject,
			'text', left(mail.body, 16000), 'textCleared', mail.body is null,
			'status', case when mail.status in ('pending', 'retrying', 'delivering') then 'queued' else mail.status end,
			'at', mail.created_at,
			'staffAgent', public.qorpera_member_mail_agent(v_profile_id, mail.staff_agent_id),
			'attachments', (select jsonb_agg(jsonb_build_object('filename', file.value ->> 'filename',
					'contentType', null, 'size', file.value -> 'bytes', 'path', file.value ->> 'path') order by file.n)
				from jsonb_array_elements(mail.attachments) with ordinality as file(value, n))))
		from placed
		join public.qorpera_company_mail_outbox as mail on mail.id = placed.mail_id
		where placed.place <= 50
	)
	select coalesce(jsonb_agg(items.item order by items.at, items.key), '[]'::jsonb),
		(select count(*) > 50 from chosen)
	into v_messages, v_more
	from items;
	select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
			'reviewId', open_send.review_id,
			'staffAgent', public.qorpera_member_mail_agent(v_profile_id, open_send.staff_agent_id),
			'to', open_send.arguments -> 'to', 'cc', open_send.arguments -> 'cc',
			'subject', open_send.arguments -> 'subject', 'text', open_send.arguments -> 'text',
			'attachments', open_send.arguments -> 'attachments', 'createdAt', open_send.created_at))
		order by open_send.created_at), '[]'::jsonb) into v_waiting
	from public.qorpera_member_mail_open_sends(v_profile_id, p_environment_id) as open_send
	where open_send.thread = p_thread;
	return jsonb_strip_nulls(jsonb_build_object('thread', v_thread.id,
		'address', (select box.local_part || '@' || v_domain from public.qorpera_company_mailboxes as box
			where box.id = v_thread.mailbox_id),
		'messages', v_messages, 'more', case when v_more then true end, 'waiting', v_waiting));
end
$$;
revoke all on function public.qorpera_member_mail_thread(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_thread(uuid, text) to authenticated;

-- The sends waiting for a person, a reply in its thread and a new email without one: the `waiting` source's mail rows.
create function public.qorpera_member_mail_waiting(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id); v_domain text; v_result jsonb;
begin
	select settings.domain into v_domain from public.qorpera_mail_settings as settings where settings.enabled;
	if v_domain is null then return '[]'::jsonb; end if;
	select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
			'reviewId', open_send.review_id, 'thread', open_send.thread,
			'address', case when jsonb_typeof(open_send.arguments -> 'from') = 'string'
				then lower(btrim(open_send.arguments ->> 'from')) end,
			'staffAgent', public.qorpera_member_mail_agent(v_profile_id, open_send.staff_agent_id),
			'to', open_send.arguments -> 'to', 'subject', open_send.arguments -> 'subject',
			'createdAt', open_send.created_at)) order by open_send.created_at desc), '[]'::jsonb) into v_result
	from public.qorpera_member_mail_open_sends(v_profile_id, p_environment_id) as open_send;
	return v_result;
end
$$;
revoke all on function public.qorpera_member_mail_waiting(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_waiting(uuid) to authenticated;

-- A member has read a thread: its unread mark clears until a newer message arrives.
create function public.qorpera_mark_mail_thread_read(p_environment_id uuid, p_thread text)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
begin
	if p_thread is null or p_thread !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'Mail thread request is invalid' using errcode = '22023'; end if;
	if not exists (select 1 from public.qorpera_mail_threads as thread
		where thread.id = p_thread and thread.environment_id = p_environment_id and thread.profile_id = v_profile_id) then
		raise exception 'No mail thread of this company has that id' using errcode = '22023'; end if;
	insert into public.qorpera_mail_thread_reads as mark (thread_id, user_id, read_at)
	values (p_thread, auth.uid(), clock_timestamp())
	on conflict (thread_id, user_id) do update set read_at = excluded.read_at;
	return true;
end
$$;
revoke all on function public.qorpera_mark_mail_thread_read(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_mark_mail_thread_read(uuid, text) to authenticated;
