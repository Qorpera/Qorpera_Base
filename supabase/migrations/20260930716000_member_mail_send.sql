-- Members send mail (founder decision, 10 November 2026: "Let a member send an email with no agent"). Until now
-- company email left only through an agent (contract section 19, 2026-09-29 amendment "events wake agents", item 9;
-- the founder decisions of 1 October 2026 in deploy/first-node/RUNTIME-EVENT-INTAKE.md). This amends both: a member
-- who may write in the company also sends from one of its mailboxes, as themself.
-- - qorpera_send_member_mail(environment, request) queues a new plain-text email in the outbox the agents' email
--   waits in. The request is {sendId, from, to, cc?, subject, text}, under send_mail's rules: the same address,
--   count, subject and text checks, a live mailbox of that company and environment that is not paused, the sending
--   switch, never to the company's own mailboxes, never as if from Qorpera, and the company's hourly and daily
--   limits, counted together with the agents' email under the same lock. `sendId` is the client's own id for the
--   send: the same one again is the email it already queued.
-- - What differs from an agent's email: it goes out from "<member> at <company>", its text is the member's as
--   written, with no AI line, and it passes no automatic review, since it is the member's own act. It is a new email
--   (no reply to a received one yet, no attachments yet), so it never carries Auto-Submitted.
-- - Only the platform's sender still sends it: mail-outbox claims it as any queued email, and the claim's JSON is
--   unchanged. No mail is private to a member (company memory is company-first): the email begins a thread every
--   member reads, an outside answer joins it and wakes the mailbox's routines as any received email does.
-- - The outbox says who sent each email: an agent's run and call, or a member and their send id, never both.
-- - Members read who sent it: a sent message of qorpera_member_mail_thread carries `member` ({userId, name?}) when a
--   member sent it themself, and a thread of qorpera_member_mail_threads carries `sentBy` when its newest message is
--   one. Exact-text patches; each inserted text names this migration (20260930716000), for deploy guards.
-- qorpera_send_agent_mail is not touched.

-- ---------------------------------------------------------------------------
-- 1. The outbox: an email is an agent's or a member's
-- ---------------------------------------------------------------------------
alter table public.qorpera_company_mail_outbox
	alter column run_id drop not null,
	alter column call_id drop not null,
	alter column staff_agent_id drop not null,
	-- The member who sent it themself, and their client's id for the send: the same send again is the same email.
	-- No reference to the account: the email stays the company's when the member leaves or their account is deleted.
	add column member_user_id uuid,
	add column member_send_id uuid,
	add constraint qorpera_company_mail_outbox_sender check (
		(run_id is not null and call_id is not null and staff_agent_id is not null
			and member_user_id is null and member_send_id is null)
		or (run_id is null and call_id is null and staff_agent_id is null
			and member_user_id is not null and member_send_id is not null));
create unique index qorpera_company_mail_outbox_member_send
	on public.qorpera_company_mail_outbox (profile_id, member_user_id, member_send_id)
	where member_user_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Who a member's email is from, as members read it
-- ---------------------------------------------------------------------------
-- The name is the member's in the company now; none once they have left it.
create function public.qorpera_member_mail_member(p_profile_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select case when p_user_id is null then null else jsonb_strip_nulls(jsonb_build_object(
		'userId', p_user_id,
		'name', (select nullif(btrim(member.display_name), '') from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = p_user_id))) end
$$;
revoke all on function public.qorpera_member_mail_member(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. A member queues an email from a mailbox of their company
-- ---------------------------------------------------------------------------
create function public.qorpera_send_member_mail(p_environment_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	-- As send_mail reads them: lowercase, a plain local part and a domain name.
	c_address constant text := '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
	-- A member of the company the environment belongs to; a company being deleted has none.
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
	v_user_id uuid := auth.uid();
	v_settings public.qorpera_mail_settings%rowtype;
	v_mail public.qorpera_company_mail_outbox%rowtype;
	v_mailbox public.qorpera_company_mailboxes%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_send_id uuid;
	v_from text;
	v_to text[];
	v_cc text[];
	v_member text;
	v_company text;
	v_now timestamptz := clock_timestamp();
	v_recipients integer;
	v_hour bigint;
	v_day bigint;
	v_next timestamptz;
	v_mail_id uuid := extensions.gen_random_uuid();
	v_thread text;
begin
	-- Owners, admins and contributors; a viewer reads the company's mail and sends none.
	if not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'Only a member who can write in the company sends its email' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['sendId','from','to','cc','subject','text'] <> '{}'::jsonb
		or not (p_request ?& array['sendId','from','to','subject','text'])
		or jsonb_typeof(p_request -> 'sendId') <> 'string'
		or p_request ->> 'sendId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or jsonb_typeof(p_request -> 'from') <> 'string' or jsonb_typeof(p_request -> 'to') <> 'array'
		or jsonb_typeof(p_request -> 'subject') <> 'string' or jsonb_typeof(p_request -> 'text') <> 'string'
		or coalesce(jsonb_typeof(p_request -> 'cc'), 'array') <> 'array'
		or jsonb_array_length(p_request -> 'to') not between 1 and 10
		or jsonb_array_length(coalesce(p_request -> 'cc', '[]')) > 9
		or exists (select 1 from jsonb_array_elements((p_request -> 'to') || coalesce(p_request -> 'cc', '[]')) as item(value)
			where jsonb_typeof(item.value) <> 'string' or char_length(item.value #>> '{}') > 254
				or lower(btrim(item.value #>> '{}')) !~ c_address)
		or char_length(p_request ->> 'subject') not between 1 and 200 or p_request ->> 'subject' ~ '[[:cntrl:]]'
		or btrim(p_request ->> 'subject') = ''
		or char_length(p_request ->> 'text') not between 1 and 20000 or btrim(p_request ->> 'text', E' \t\r\n') = '' then
		raise exception 'Mail request is invalid' using errcode = '22023';
	end if;
	v_send_id := (p_request ->> 'sendId')::uuid;
	-- One company's sends in turn: its limits are counted under this lock, and the same send again (a retried request)
	-- is the email it already queued, whatever has changed since.
	perform pg_advisory_xact_lock(hashtextextended('qorpera-company-mail:' || v_profile_id::text, 0));
	select * into v_mail from public.qorpera_company_mail_outbox
	where profile_id = v_profile_id and member_user_id = v_user_id and member_send_id = v_send_id;
	if found then
		return jsonb_build_object('mailId', v_mail.id, 'thread', v_mail.thread,
			'status', case when v_mail.status in ('pending', 'retrying', 'delivering') then 'queued' else v_mail.status end);
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
			raise exception 'No mailbox of this company has that address' using errcode = '42501'; end if;
		v_from := split_part(v_from, '@', 1);
	end if;
	select * into v_mailbox from public.qorpera_company_mailboxes
	where local_part = v_from and removed_at is null and profile_id = v_profile_id and environment_id = p_environment_id;
	if not found then
		raise exception 'No mailbox of this company has that address' using errcode = '42501'; end if;
	select * into strict v_hook from public.qorpera_event_hooks where id = v_mailbox.hook_id;
	if v_hook.status <> 'active' then
		raise exception 'The mailbox is paused; resume it to send from it' using errcode = '0A000'; end if;
	-- A company never emails its own mailboxes, tagged or not.
	if exists (select 1 from public.qorpera_company_mailboxes as mailbox
		where mailbox.profile_id = v_profile_id and mailbox.removed_at is null
			and exists (select 1 from unnest(v_to || v_cc) as recipient
				where recipient = substring(recipient from '^[^@]+') || '@' || v_settings.domain
					and public.qorpera_mail_box_part(recipient) = mailbox.local_part)) then
		raise exception 'Email to your own company''s mailboxes is refused' using errcode = '42501'; end if;
	-- The company's limits on recipients, the agents' email and the members' counted together. Email cancelled before
	-- any attempt never went out; any other may have.
	if v_recipients > least(v_settings.company_hourly_recipients, v_settings.company_daily_recipients) then
		raise exception 'The company''s email limits allow % recipients an hour and % a day, fewer than this email has',
			v_settings.company_hourly_recipients, v_settings.company_daily_recipients using errcode = '54000'; end if;
	select coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc))
			filter (where created_at > v_now - interval '1 hour'), 0),
		coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc)), 0)
	into v_hour, v_day
	from public.qorpera_company_mail_outbox
	where profile_id = v_profile_id and created_at > v_now - interval '1 day'
		and (status <> 'cancelled' or attempt_count > 0);
	if v_hour + v_recipients > v_settings.company_hourly_recipients
		or v_day + v_recipients > v_settings.company_daily_recipients then
		-- Room returns when enough of the window's oldest email has left it: the newest email that must go first.
		select greatest(
			case when v_hour + v_recipients > v_settings.company_hourly_recipients then (
				select sent.created_at + interval '1 hour' from (
					select created_at, id, sum(cardinality(recipients_to) + cardinality(recipients_cc))
						over (order by created_at desc, id desc) as newer
					from public.qorpera_company_mail_outbox where profile_id = v_profile_id
						and created_at > v_now - interval '1 hour' and (status <> 'cancelled' or attempt_count > 0)) as sent
				where sent.newer > v_settings.company_hourly_recipients - v_recipients
				order by sent.created_at desc, sent.id desc limit 1) end,
			case when v_day + v_recipients > v_settings.company_daily_recipients then (
				select sent.created_at + interval '1 day' from (
					select created_at, id, sum(cardinality(recipients_to) + cardinality(recipients_cc))
						over (order by created_at desc, id desc) as newer
					from public.qorpera_company_mail_outbox where profile_id = v_profile_id
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
	-- The member's name in the company, never their address: a name that is an address reads as the sender's.
	v_member := public.qorpera_mail_display_name((select member.display_name from public.qorpera_profile_members as member
		where member.profile_id = v_profile_id and member.user_id = v_user_id), 'A member');
	if v_member like '%@%' then
		v_member := 'A member'; end if;
	v_company := public.qorpera_mail_display_name((select profile.name from public.qorpera_profiles as profile
		where profile.id = v_profile_id), 'the company');
	-- Nothing goes out as if from Qorpera (founder decision, 1 October 2026).
	if public.qorpera_mail_name_reads_as_qorpera(v_member) or public.qorpera_mail_name_reads_as_qorpera(v_company)
		or public.qorpera_mail_name_reads_as_qorpera(v_mailbox.local_part) then
		raise exception 'Email that would look like it comes from Qorpera is refused; change your name, the company''s or the mailbox''s'
			using errcode = '42501'; end if;
	-- The member's text as written: no AI line, since no agent wrote it. A new email begins its own thread.
	v_thread := public.qorpera_mail_thread_id(v_mailbox.id, 'mail:' || v_mail_id);
	insert into public.qorpera_company_mail_outbox (id, thread, profile_id, environment_id, mailbox_id, member_user_id,
		member_send_id, from_name, recipients_to, recipients_cc, subject, body)
	values (v_mail_id, v_thread, v_profile_id, p_environment_id, v_mailbox.id, v_user_id, v_send_id,
		v_member || ' at ' || v_company, v_to, v_cc, btrim(p_request ->> 'subject'),
		rtrim(p_request ->> 'text', E' \t\r\n'))
	returning * into v_mail;
	perform public.qorpera_mail_thread_note(v_thread, v_profile_id, p_environment_id, v_mailbox.id, 'sent',
		v_mail.created_at, v_mail.subject, null, v_to[1], null, null, null);
	return jsonb_build_object('mailId', v_mail.id, 'thread', v_thread, 'status', 'queued');
end
$$;
revoke all on function public.qorpera_send_member_mail(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_send_member_mail(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Members read who sent it
-- ---------------------------------------------------------------------------
create function pg_temp.member_send_patch(p_target regprocedure, p_old text, p_new text)
returns void
language plpgsql
as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Member send patch anchor not found once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

do $$
begin
	-- A sent message: the member who sent it themself, beside the agent of an agent's.
	perform pg_temp.member_send_patch('public.qorpera_member_mail_thread(uuid,text,jsonb)',
		E'\t\t\t''staffAgent'', public.qorpera_member_mail_agent(v_profile_id, mail.staff_agent_id),\n',
		E'\t\t\t''staffAgent'', public.qorpera_member_mail_agent(v_profile_id, mail.staff_agent_id),\n'
		|| E'\t\t\t-- 20260930716000: the member who sent it themself.\n'
		|| E'\t\t\t''member'', public.qorpera_member_mail_member(v_profile_id, mail.member_user_id),\n');
	-- A list line: the member whose own email is the thread's newest message, as the snippet's is.
	perform pg_temp.member_send_patch('public.qorpera_member_mail_threads(uuid,jsonb)',
		E'\t\t\t''direction'', shown.last_direction,\n',
		E'\t\t\t''direction'', shown.last_direction,\n'
		|| E'\t\t\t-- 20260930716000: the member whose own email is the newest message of the thread.\n'
		|| E'\t\t\t''sentBy'', case when shown.last_direction = ''sent'' then public.qorpera_member_mail_member(\n'
		|| E'\t\t\t\tshown.profile_id, (select mail.member_user_id from public.qorpera_company_mail_outbox as mail\n'
		|| E'\t\t\t\t\twhere mail.thread = shown.id order by mail.created_at desc, mail.id desc limit 1)) end,\n');
end $$;
