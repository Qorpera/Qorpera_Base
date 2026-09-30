-- Company mail, sending: build step M2b (Q1; founder decisions of 29 September 2026: a company's first address is
-- on a mail domain Qorpera owns (decision 7), and mail goes out as the agent, with an AI line; contract section 19,
-- 2026-09-29 amendment "events wake agents", item 9; design deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)").
--
-- An agent sends from one of its company's live mailboxes (M2a) with the tool send_mail, which the automatic review
-- checks first like any action outside the company. The database queues the email in an outbox: from the agent by
-- name ("<agent> at <company>"), plain text, with a line saying an AI agent wrote and sent it, and, for a reply to a
-- received email, that email's thread headers. The Edge Function mail-outbox, called each minute by pg_cron + pg_net
-- with a Supabase secret key, claims a batch with a lease and sends it through the mail provider (Resend) with the
-- platform's key, which no node or agent holds. Sending has its own switch, off, and a company's hourly and daily
-- limits on recipients, since every company sends from the platform's domain.
--
-- Mail loops: a reply to an email sent automatically (an auto-reply, a mailing list, bulk mail: the mail door marks it
-- automated) is refused, a reply carries Auto-Submitted: auto-replied (RFC 3834) so other responders leave it alone,
-- and a company never emails its own mailboxes.
--
-- Lock order: a send takes the run (the tool binding locks the runner job, then the run), then a transaction lock
-- per company for its limits, then its insert's key-share locks on the company, environment and mailbox rows, as
-- other agent tools do. Claims lock outbox rows only.

set local lock_timeout = '3s';

create function pg_temp.mail_sending_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail sending integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Settings: sending is switched off, with limits per company
-- ---------------------------------------------------------------------------
alter table public.qorpera_mail_settings
	add column sending boolean not null default false,
	-- Recipients, not emails: an email to ten addresses counts ten.
	add column company_hourly_recipients integer not null default 60 check (company_hourly_recipients between 0 and 10000),
	add column company_daily_recipients integer not null default 300 check (company_daily_recipients between 0 and 100000);

-- ---------------------------------------------------------------------------
-- 2. The outbox
-- ---------------------------------------------------------------------------
create table public.qorpera_company_mail_outbox (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	mailbox_id uuid not null references public.qorpera_company_mailboxes(id) on delete cascade,
	-- The run and tool call that sent it: a repeated call returns the same email.
	run_id uuid not null,
	call_id text not null check (char_length(call_id) between 1 and 200),
	staff_agent_id uuid not null,
	-- Fixed when queued: "<agent> at <company>", and the whole text as sent, with the AI line.
	from_name text not null check (char_length(from_name) between 1 and 160
		and from_name !~ '["\\<>[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]'),
	-- The mailbox's address, fixed at the first attempt: every attempt sends the same email under one idempotency key.
	from_address text check (from_address is null or (char_length(from_address) <= 320 and from_address !~ '[\s"<>]')),
	recipients_to text[] not null check (cardinality(recipients_to) between 1 and 10),
	recipients_cc text[] not null default '{}' check (cardinality(recipients_cc) <= 9),
	subject text not null check (char_length(subject) between 1 and 200 and subject !~ '[[:cntrl:]]'),
	-- Cleared seven days after it settles, like a received event's body.
	body text check (body is null or char_length(body) <= 20500),
	-- A reply: the received email it answers and that email's thread.
	in_reply_to_delivery_id uuid,
	in_reply_to text check (in_reply_to is null or (char_length(in_reply_to) <= 980 and in_reply_to !~ '[[:cntrl:]]')),
	thread_references text check (thread_references is null
		or (char_length(thread_references) <= 980 and thread_references !~ '[[:cntrl:]]')),
	status text not null default 'pending'
		check (status in ('pending', 'retrying', 'delivering', 'sent', 'failed', 'cancelled')),
	attempt_count integer not null default 0 check (attempt_count >= 0),
	next_attempt_at timestamptz not null default clock_timestamp(),
	lease_id uuid,
	lease_expires_at timestamptz,
	provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 256),
	last_error text check (last_error is null or char_length(last_error) <= 1000),
	created_at timestamptz not null default clock_timestamp(),
	settled_at timestamptz,
	unique (run_id, call_id)
);
create index qorpera_company_mail_outbox_due on public.qorpera_company_mail_outbox (next_attempt_at)
	where status in ('pending', 'retrying', 'delivering');
create index qorpera_company_mail_outbox_company on public.qorpera_company_mail_outbox (profile_id, created_at);
create index qorpera_company_mail_outbox_kept on public.qorpera_company_mail_outbox (settled_at)
	where body is not null and status in ('sent', 'failed', 'cancelled');
alter table public.qorpera_company_mail_outbox enable row level security;
revoke all on table public.qorpera_company_mail_outbox from public, anon, authenticated, service_role;

-- A name as a mail header may carry it: no quotes, brackets, backslashes, control characters or invisible format
-- characters (bidi controls turn a name around), one line.
create function public.qorpera_mail_display_name(p_name text, p_fallback text)
returns text
language sql
immutable
set search_path = ''
as $$
	select coalesce(nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''),
		'["\\<>[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]', ' ', 'g'), '\s+', ' ', 'g')), 64), ''), p_fallback)
$$;
revoke all on function public.qorpera_mail_display_name(text, text) from public, anon, authenticated, service_role;

-- The receipt an agent gets for an email it sent.
create function public.qorpera_agent_mail_receipt(p_mail public.qorpera_company_mail_outbox, p_threaded boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
	select jsonb_build_object('schema', 'qorpera.agent-mail/v1', 'runId', p_mail.run_id, 'mailId', p_mail.id,
		'status', case when p_mail.status in ('pending', 'retrying', 'delivering') then 'queued' else p_mail.status end,
		'from', (select mailbox.local_part || '@' || settings.domain from public.qorpera_company_mailboxes as mailbox,
			public.qorpera_mail_settings as settings where mailbox.id = p_mail.mailbox_id),
		'fromName', p_mail.from_name, 'to', to_jsonb(p_mail.recipients_to), 'cc', to_jsonb(p_mail.recipients_cc),
		'subject', p_mail.subject)
		|| case when p_mail.in_reply_to_delivery_id is null then '{}'::jsonb
			else jsonb_build_object('inReplyTo', p_mail.in_reply_to_delivery_id, 'threaded', p_threaded) end
$$;
revoke all on function public.qorpera_agent_mail_receipt(public.qorpera_company_mail_outbox, boolean)
	from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. send_mail: an agent queues an email from a mailbox of its company
-- ---------------------------------------------------------------------------
create function public.qorpera_send_agent_mail(p_binding jsonb, p_call_id text, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	-- Lowercase, as the tool writes them: a plain local part and a domain name.
	c_address constant text := '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
	v_run public.qorpera_execution_runs%rowtype;
	v_settings public.qorpera_mail_settings%rowtype;
	v_existing public.qorpera_company_mail_outbox%rowtype;
	v_mail public.qorpera_company_mail_outbox%rowtype;
	v_mailbox public.qorpera_company_mailboxes%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_delivery public.qorpera_event_deliveries%rowtype;
	v_from text;
	v_to text[];
	v_cc text[];
	v_text text;
	v_agent text;
	v_company text;
	v_message jsonb;
	v_in_reply_to text;
	v_references text;
	v_ids text[];
	v_threaded boolean := false;
	v_now timestamptz := clock_timestamp();
	v_recipients integer;
	v_hour bigint;
	v_day bigint;
	v_next timestamptz;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	-- Work the wake allows (acknowledged, the company neither paused nor being deleted, no final answer yet), by an
	-- agent, never a worker.
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Only a company agent sends mail' using errcode = '42501'; end if;
	if p_call_id is null or char_length(p_call_id) not between 1 and 200 then
		raise exception 'Mail request is invalid' using errcode = '22023'; end if;
	-- The same call again (a retried request) is the email it already queued.
	select * into v_existing from public.qorpera_company_mail_outbox where run_id = v_run.id and call_id = p_call_id;
	if found then
		return public.qorpera_agent_mail_receipt(v_existing, v_existing.in_reply_to is not null);
	end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['from','to','cc','subject','text','inReplyTo'] <> '{}'::jsonb
		or not (p_request ?& array['from','to','subject','text'])
		or jsonb_typeof(p_request -> 'from') <> 'string' or jsonb_typeof(p_request -> 'to') <> 'array'
		or jsonb_typeof(p_request -> 'subject') <> 'string' or jsonb_typeof(p_request -> 'text') <> 'string'
		or coalesce(jsonb_typeof(p_request -> 'cc'), 'array') <> 'array'
		or coalesce(jsonb_typeof(p_request -> 'inReplyTo'), 'string') <> 'string'
		or jsonb_array_length(p_request -> 'to') not between 1 and 10
		or jsonb_array_length(coalesce(p_request -> 'cc', '[]')) > 9
		or exists (select 1 from jsonb_array_elements((p_request -> 'to') || coalesce(p_request -> 'cc', '[]')) as item(value)
			where jsonb_typeof(item.value) <> 'string' or char_length(item.value #>> '{}') > 254
				or lower(btrim(item.value #>> '{}')) !~ c_address)
		or char_length(p_request ->> 'subject') not between 1 and 200 or p_request ->> 'subject' ~ '[[:cntrl:]]'
		or btrim(p_request ->> 'subject') = ''
		or char_length(p_request ->> 'text') not between 1 and 20000 or btrim(p_request ->> 'text', E' \t\r\n') = ''
		or (p_request ? 'inReplyTo' and p_request ->> 'inReplyTo'
			!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Mail request is invalid' using errcode = '22023';
	end if;
	-- Each address once, in the order written; an address in to is not copied again in cc.
	select array_agg(address order by first) into v_to from (
		select lower(btrim(item.value #>> '{}')) as address, min(item.n) as first
		from jsonb_array_elements(p_request -> 'to') with ordinality as item(value, n) group by 1) as listed;
	select coalesce(array_agg(address order by first), '{}') into v_cc from (
		select lower(btrim(item.value #>> '{}')) as address, min(item.n) as first
		from jsonb_array_elements(coalesce(p_request -> 'cc', '[]')) with ordinality as item(value, n) group by 1) as listed
	where not address = any (v_to);
	v_recipients := cardinality(v_to) + cardinality(v_cc);
	if v_recipients > 10 then
		raise exception 'Mail request is invalid' using errcode = '22023'; end if;
	select settings.* into v_settings from public.qorpera_mail_settings as settings;
	if not coalesce(v_settings.enabled and v_settings.sending, false) or v_settings.domain is null then
		raise exception 'Sending company mail is switched off' using errcode = '0A000'; end if;
	-- The mailbox: live, this company's and this environment's, and not paused.
	v_from := lower(btrim(p_request ->> 'from'));
	if v_from like '%@%' then
		if v_from <> split_part(v_from, '@', 1) || '@' || v_settings.domain then
			raise exception 'No mailbox of this company has that address; list_hooks shows them' using errcode = '42501'; end if;
		v_from := split_part(v_from, '@', 1);
	end if;
	select * into v_mailbox from public.qorpera_company_mailboxes
	where local_part = v_from and removed_at is null and profile_id = v_run.profile_id
		and environment_id = v_run.environment_id;
	if not found then
		raise exception 'No mailbox of this company has that address; list_hooks shows them' using errcode = '42501'; end if;
	select * into strict v_hook from public.qorpera_event_hooks where id = v_mailbox.hook_id;
	if v_hook.status <> 'active' then
		raise exception 'The mailbox is paused; a member resumes it' using errcode = '0A000'; end if;
	-- A company's own mailboxes wake its own routines: email to them would talk to itself, and could loop.
	if exists (select 1 from public.qorpera_company_mailboxes as mailbox
		where mailbox.profile_id = v_run.profile_id and mailbox.removed_at is null
			and mailbox.local_part || '@' || v_settings.domain = any (v_to || v_cc)) then
		raise exception 'Email to your own company''s mailboxes is refused; reach coworkers with send_coworker_message'
			using errcode = '42501'; end if;
	-- A reply joins the thread of a received email of this company; one whose text was cleared goes out unthreaded.
	if p_request ? 'inReplyTo' then
		select * into v_delivery from public.qorpera_event_deliveries where id = (p_request ->> 'inReplyTo')::uuid;
		select * into v_hook from public.qorpera_event_hooks where id = v_delivery.hook_id;
		if v_delivery.id is null or v_delivery.status <> 'verified' or v_delivery.event_type <> 'mail.received'
			or v_hook.proof is distinct from 'mail' or v_hook.profile_id is distinct from v_run.profile_id
			or v_hook.environment_id is distinct from v_run.environment_id then
			raise exception 'The email this answers is not one the company received' using errcode = '42501'; end if;
		if v_delivery.body is not null then
			begin
				v_message := convert_from(v_delivery.body, 'UTF8')::jsonb;
			exception when others then
				v_message := null;
			end;
			-- Answering an auto-reply, a mailing list or bulk mail is how mail loops start.
			if v_message -> 'automated' = 'true'::jsonb then
				raise exception 'That email was sent automatically (an auto-reply, a mailing list or bulk mail); it is not answered'
					using errcode = '42501'; end if;
			v_in_reply_to := nullif(btrim(v_message ->> 'messageId'), '');
			if v_in_reply_to is not null and v_in_reply_to !~ '[[:cntrl:]]' and char_length(v_in_reply_to) <= 978 then
				if v_in_reply_to !~ '^<.*>$' then v_in_reply_to := '<' || v_in_reply_to || '>'; end if;
				-- The thread's ids, oldest first, then the email answered. References keeps the first and the newest that
				-- fit one header line (RFC 5322 3.6.4).
				v_references := btrim(regexp_replace(coalesce(v_message ->> 'references', ''), '\s+', ' ', 'g'));
				v_ids := case when v_references ~ '[[:cntrl:]]' then '{}'::text[]
					else array_remove(regexp_split_to_array(v_references, ' '), '') end || v_in_reply_to;
				v_references := v_in_reply_to;
				for i in reverse cardinality(v_ids) - 1 .. 2 loop
					exit when char_length(v_ids[1]) + char_length(v_ids[i]) + char_length(v_references) + 2 > 980;
					v_references := v_ids[i] || ' ' || v_references;
				end loop;
				if cardinality(v_ids) > 1 and char_length(v_ids[1]) + char_length(v_references) + 1 <= 980 then
					v_references := v_ids[1] || ' ' || v_references; end if;
				v_threaded := true;
			else
				v_in_reply_to := null;
			end if;
		end if;
	end if;
	-- The company's limits on recipients, counted under one lock per company. Email cancelled before any attempt never
	-- went out; any other may have.
	perform pg_advisory_xact_lock(hashtextextended('qorpera-company-mail:' || v_run.profile_id::text, 0));
	if v_recipients > least(v_settings.company_hourly_recipients, v_settings.company_daily_recipients) then
		raise exception 'The company''s email limits allow % recipients an hour and % a day, fewer than this email has',
			v_settings.company_hourly_recipients, v_settings.company_daily_recipients using errcode = '54000'; end if;
	select coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc))
			filter (where created_at > v_now - interval '1 hour'), 0),
		coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc)), 0)
	into v_hour, v_day
	from public.qorpera_company_mail_outbox
	where profile_id = v_run.profile_id and created_at > v_now - interval '1 day'
		and (status <> 'cancelled' or attempt_count > 0);
	if v_hour + v_recipients > v_settings.company_hourly_recipients
		or v_day + v_recipients > v_settings.company_daily_recipients then
		-- Room returns when enough of the window's oldest email has left it: the newest email that must go first.
		select greatest(
			case when v_hour + v_recipients > v_settings.company_hourly_recipients then (
				select sent.created_at + interval '1 hour' from (
					select created_at, id, sum(cardinality(recipients_to) + cardinality(recipients_cc))
						over (order by created_at desc, id desc) as newer
					from public.qorpera_company_mail_outbox where profile_id = v_run.profile_id
						and created_at > v_now - interval '1 hour' and (status <> 'cancelled' or attempt_count > 0)) as sent
				where sent.newer > v_settings.company_hourly_recipients - v_recipients
				order by sent.created_at desc, sent.id desc limit 1) end,
			case when v_day + v_recipients > v_settings.company_daily_recipients then (
				select sent.created_at + interval '1 day' from (
					select created_at, id, sum(cardinality(recipients_to) + cardinality(recipients_cc))
						over (order by created_at desc, id desc) as newer
					from public.qorpera_company_mail_outbox where profile_id = v_run.profile_id
						and created_at > v_now - interval '1 day' and (status <> 'cancelled' or attempt_count > 0)) as sent
				where sent.newer > v_settings.company_daily_recipients - v_recipients
				order by sent.created_at desc, sent.id desc limit 1) end,
			v_now) into v_next;
		raise exception 'The company has emailed the % recipients an hour and % a day its limits allow; this email can go after %',
			v_settings.company_hourly_recipients, v_settings.company_daily_recipients,
			-- To the second, rounded up.
			to_char(date_trunc('second', v_next + interval '999999 microseconds') at time zone 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS"Z"') using errcode = '54000';
	end if;
	v_agent := public.qorpera_mail_display_name((select staff.display_name from public.qorpera_profile_staff as staff
		where staff.profile_id = v_run.profile_id and staff.staff_agent_id = v_run.staff_agent_id), 'Agent');
	v_company := public.qorpera_mail_display_name((select profile.name from public.qorpera_profiles as profile
		where profile.id = v_run.profile_id), 'the company');
	-- The AI line, its own last paragraph on every email (not after a signature separator, which clients dim).
	v_text := rtrim(p_request ->> 'text', E' \t\r\n') || E'\n\n'
		|| format('Written and sent by %s, an AI agent working for %s.', v_agent, v_company);
	insert into public.qorpera_company_mail_outbox (profile_id, environment_id, mailbox_id, run_id, call_id,
		staff_agent_id, from_name, recipients_to, recipients_cc, subject, body, in_reply_to_delivery_id, in_reply_to,
		thread_references)
	values (v_run.profile_id, v_run.environment_id, v_mailbox.id, v_run.id, p_call_id, v_run.staff_agent_id,
		v_agent || ' at ' || v_company, v_to, v_cc, btrim(p_request ->> 'subject'), v_text,
		(p_request ->> 'inReplyTo')::uuid, v_in_reply_to, v_references)
	returning * into v_mail;
	return public.qorpera_agent_mail_receipt(v_mail, v_threaded);
end
$$;
revoke all on function public.qorpera_send_agent_mail(jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_send_agent_mail(jsonb, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The worker's door: claim a batch with a lease, then complete or fail each
-- ---------------------------------------------------------------------------
create function public.qorpera_claim_company_mail(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_settings public.qorpera_mail_settings%rowtype;
	v_now timestamptz := clock_timestamp();
	v_result jsonb;
begin
	if p_limit is null or p_limit not between 1 and 50 or p_lease_id is null then
		raise exception 'Company mail claim is invalid' using errcode = '22023';
	end if;
	-- Texts kept seven days after they settle, a bounded batch at a time.
	update public.qorpera_company_mail_outbox set body = null
	where id in (select id from public.qorpera_company_mail_outbox
		where body is not null and status in ('sent', 'failed', 'cancelled') and settled_at < v_now - interval '7 days'
		order by settled_at limit 500);
	select settings.* into v_settings from public.qorpera_mail_settings as settings;
	-- Switched off, nothing is sent: queued email waits, and the first claim after sending is switched on again fails
	-- what waited more than a day (below).
	if not coalesce(v_settings.enabled and v_settings.sending, false) or v_settings.domain is null then
		return '[]'::jsonb;
	end if;
	-- Open: waiting, or leased by a worker that did not finish in time. An email already attempted may have gone out
	-- (a lost answer, a timeout), and says so.
	update public.qorpera_company_mail_outbox as mail
	set status = 'cancelled', settled_at = v_now, lease_id = null, lease_expires_at = null,
		last_error = case when public.qorpera_company_deleting(mail.profile_id) then 'The company is being deleted'
			when mailbox.removed_at is not null then 'The mailbox was removed'
			else 'The mailbox was paused' end
			|| case when mail.attempt_count > 0 then '; an earlier attempt may have gone out' else '' end
	from public.qorpera_company_mailboxes as mailbox, public.qorpera_event_hooks as hook
	where mailbox.id = mail.mailbox_id and hook.id = mailbox.hook_id
		and (mail.status in ('pending', 'retrying') or (mail.status = 'delivering' and mail.lease_expires_at <= v_now))
		and (mailbox.removed_at is not null or hook.status <> 'active' or public.qorpera_company_deleting(mail.profile_id));
	update public.qorpera_company_mail_outbox as mail
	set status = 'failed', settled_at = v_now, lease_id = null, lease_expires_at = null,
		last_error = left(case when mail.attempt_count >= 8 then coalesce(mail.last_error, 'Gave up after eight attempts')
			else 'Not sent within a day' end
			|| case when mail.attempt_count > 0 then '; an earlier attempt may have gone out' else '' end, 1000)
	where (mail.status in ('pending', 'retrying') or (mail.status = 'delivering' and mail.lease_expires_at <= v_now))
		and (mail.created_at <= v_now - interval '1 day'
			or (mail.status = 'delivering' and mail.attempt_count >= 8));
	with candidates as (
		select mail.id
		from public.qorpera_company_mail_outbox as mail
		where mail.status in ('pending', 'retrying', 'delivering')
			and mail.next_attempt_at <= v_now
			and (mail.lease_expires_at is null or mail.lease_expires_at <= v_now)
		order by mail.next_attempt_at, mail.created_at
		for update skip locked
		limit p_limit
	), claimed as (
		update public.qorpera_company_mail_outbox as mail
		set status = 'delivering', attempt_count = mail.attempt_count + 1, lease_id = p_lease_id,
			lease_expires_at = v_now + interval '5 minutes',
			-- The current domain at the first attempt; later attempts repeat it (a domain change moves unsent email).
			from_address = coalesce(mail.from_address, (select mailbox.local_part || '@' || v_settings.domain
				from public.qorpera_company_mailboxes as mailbox where mailbox.id = mail.mailbox_id))
		from candidates
		where mail.id = candidates.id
		returning mail.*
	)
	select coalesce(jsonb_agg(jsonb_build_object(
		'mailId', claimed.id, 'leaseId', claimed.lease_id, 'attemptCount', claimed.attempt_count,
		'from', '"' || claimed.from_name || '" <' || claimed.from_address || '>',
		'to', to_jsonb(claimed.recipients_to), 'cc', to_jsonb(claimed.recipients_cc),
		'subject', claimed.subject, 'text', claimed.body,
		-- A reply is an automatic response (RFC 3834): other responders leave it unanswered.
		'headers', jsonb_strip_nulls(jsonb_build_object('In-Reply-To', claimed.in_reply_to,
			'References', claimed.thread_references,
			'Auto-Submitted', case when claimed.in_reply_to_delivery_id is not null then 'auto-replied' end))
	) order by claimed.created_at), '[]'::jsonb) into v_result
	from claimed;
	return v_result;
end
$$;

create function public.qorpera_complete_company_mail(p_mail_id uuid, p_lease_id uuid, p_provider_message_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_rows integer;
begin
	update public.qorpera_company_mail_outbox
	set status = 'sent', settled_at = clock_timestamp(), provider_message_id = left(p_provider_message_id, 256),
		lease_id = null, lease_expires_at = null, last_error = null
	where id = p_mail_id and lease_id = p_lease_id and status = 'delivering';
	get diagnostics v_rows = row_count;
	return v_rows = 1;
end
$$;

-- A retryable failure waits 1, 2, 4 ... minutes (at most an hour) and stops after eight attempts.
create function public.qorpera_fail_company_mail(p_mail_id uuid, p_lease_id uuid, p_error text, p_retryable boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_rows integer;
begin
	update public.qorpera_company_mail_outbox
	set status = case when p_retryable and attempt_count < 8 then 'retrying' else 'failed' end,
		settled_at = case when p_retryable and attempt_count < 8 then null else clock_timestamp() end,
		next_attempt_at = clock_timestamp()
			+ least(interval '1 hour', interval '1 minute' * power(2, greatest(attempt_count - 1, 0))),
		last_error = left(coalesce(p_error, 'Unknown error'), 1000), lease_id = null, lease_expires_at = null
	where id = p_mail_id and lease_id = p_lease_id and status = 'delivering';
	get diagnostics v_rows = row_count;
	return v_rows = 1;
end
$$;
revoke all on function public.qorpera_claim_company_mail(integer, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_complete_company_mail(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qorpera_fail_company_mail(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.qorpera_claim_company_mail(integer, uuid) to service_role;
grant execute on function public.qorpera_complete_company_mail(uuid, uuid, text) to service_role;
grant execute on function public.qorpera_fail_company_mail(uuid, uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Observations name the new tool
-- ---------------------------------------------------------------------------
select pg_temp.mail_sending_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'list_hooks','read_event',$old$,
	$new$'list_hooks','read_event','send_mail',$new$);
