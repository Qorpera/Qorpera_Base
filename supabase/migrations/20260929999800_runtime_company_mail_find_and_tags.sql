-- Company mail for accounts the company owns (Q1, agreed with A1 on 2 October; design
-- deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)", "Plus addresses and find_mail").
--
-- Plus addresses: local+tag@<mail domain> reaches the mailbox local@, so an agent can sign the company up for
-- a second account on one site (agents+stripe@). The tag is 1-64 lowercase letters, digits, dots, hyphens and
-- underscores; any other tag reaches no mailbox. Plus addresses only receive: send_mail sends from a mailbox's
-- own address, and refuses a company's own mailboxes as recipients with or without a tag.
--
-- Each received mail now records, on its delivery, the mail's own headers an agent searches by: delivered-to
-- (the message's recipients that reach that mailbox, tags included), from and subject. Mail received earlier
-- keeps none.
--
-- find_mail: an agent's search of its company's received mail, by mailbox, delivered-to address, sender and
-- subject (case-insensitive parts), since a time (at most 7 days back, the bodies' lifetime; 24 hours by
-- default). It returns at most 10, newest first, each with its delivery id for read_event; no mail text and no
-- matching inside it. The runtime polls it to wait for a mail (waitSeconds). It is a read: the run's company
-- and environment only, through the native tool binding.
--
-- Locks: find takes the run's job and run rows as read_event does, and reads deliveries without locking.

set local lock_timeout = '3s';

create function pg_temp.mail_find_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail find integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Plus addresses
-- ---------------------------------------------------------------------------
-- The mailbox an address's local part reaches: the local part itself, or the part before a +tag. Null when the
-- tag is not one a mailbox takes.
create function public.qorpera_mail_box_part(p_address text)
returns text
language sql
immutable
set search_path = ''
as $$
	select case
		when position('+' in address.local_part) = 0 then address.local_part
		when substring(address.local_part from position('+' in address.local_part) + 1) ~ '^[a-z0-9._-]{1,64}$'
			then split_part(address.local_part, '+', 1)
	end
	from (select substring(lower(btrim(p_address)) from '^([^@]+)@') as local_part) as address
$$;
revoke all on function public.qorpera_mail_box_part(text) from public, anon, authenticated, service_role;

-- The headers a received mail's delivery keeps: the recipients that reach the mailbox (at most 2048
-- characters), and the mail's From and Subject as the mail door wrote them.
create function public.qorpera_mail_delivery_headers(
	p_recipients text[],
	p_domain text,
	p_local_part text,
	p_message jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
	select jsonb_strip_nulls(jsonb_build_object(
		'delivered-to', (
			select left(string_agg(recipient, ', ' order by recipient), 2048)
			from (
				select distinct lower(btrim(item)) as recipient from unnest(p_recipients) as item
				where item is not null and char_length(item) between 3 and 320
			) as each
			where each.recipient = substring(each.recipient from '^[^@]+') || '@' || p_domain
				and public.qorpera_mail_box_part(each.recipient) = p_local_part
		),
		'from', case when jsonb_typeof(p_message -> 'from') = 'string' then left(p_message ->> 'from', 998) end,
		'subject', case when jsonb_typeof(p_message -> 'subject') = 'string' then left(p_message ->> 'subject', 998) end
	))
$$;
revoke all on function public.qorpera_mail_delivery_headers(text[], text, text, jsonb)
	from public, anon, authenticated, service_role;

select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		where mailbox.local_part = substring(v_recipient from '^([^@]+)@') and mailbox.removed_at is null;
$old$,
	$new$		where mailbox.local_part = public.qorpera_mail_box_part(v_recipient) and mailbox.removed_at is null;
$new$);

select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$			'application/json', '{}'::jsonb, v_body, octet_length(v_body), v_sha256, clock_timestamp()
$old$,
	$new$			'application/json',
			public.qorpera_mail_delivery_headers(p_recipients, v_settings.domain, v_mailbox.local_part, v_parsed),
			v_body, octet_length(v_body), v_sha256, clock_timestamp()
$new$);

-- A company's own mailboxes stay refused as recipients under any tag.
select pg_temp.mail_find_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$			and mailbox.local_part || '@' || v_settings.domain = any (v_to || v_cc)) then
$old$,
	$new$			and exists (select 1 from unnest(v_to || v_cc) as recipient
				where recipient = substring(recipient from '^[^@]+') || '@' || v_settings.domain
					and public.qorpera_mail_box_part(recipient) = mailbox.local_part)) then
$new$);

-- ---------------------------------------------------------------------------
-- 2. find_mail
-- ---------------------------------------------------------------------------
-- p_request: {mailbox?, to?, from?, subject?, since?}. mailbox and to are addresses (lowercased); from and
-- subject match as case-insensitive parts of the mail's From and Subject; since is an instant with its offset.
-- Mail older than 7 days is never searched (its text is cleared then).
create function public.qorpera_find_agent_mail(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_settings public.qorpera_mail_settings%rowtype;
	v_now timestamptz := clock_timestamp();
	v_since timestamptz;
	v_mailbox text;
	v_to text;
	v_from text;
	v_subject text;
	v_hooks uuid[];
	v_found jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['mailbox', 'to', 'from', 'subject', 'since'] <> '{}'::jsonb
		or exists (select 1 from jsonb_each(p_request) as field where jsonb_typeof(field.value) <> 'string')
		or char_length(p_request ->> 'mailbox') not between 3 and 320
		or char_length(p_request ->> 'to') not between 3 and 320
		or char_length(p_request ->> 'from') not between 1 and 320
		or char_length(p_request ->> 'subject') not between 1 and 200
		or char_length(p_request ->> 'since') not between 10 and 64
		or (p_request ->> 'since') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
		or exists (select 1 from jsonb_each_text(p_request) as field where field.value ~ '[[:cntrl:]]') then
		raise exception 'Mail search is invalid' using errcode = '22023'; end if;
	begin
		v_since := (p_request ->> 'since')::timestamptz;
	exception when others then
		raise exception 'Mail search is invalid: since is an instant with its offset' using errcode = '22023';
	end;
	v_since := greatest(coalesce(v_since, v_now - interval '24 hours'), v_now - interval '7 days');
	v_mailbox := lower(btrim(p_request ->> 'mailbox'));
	v_to := lower(btrim(p_request ->> 'to'));
	v_from := lower(p_request ->> 'from');
	v_subject := lower(p_request ->> 'subject');
	select settings.* into v_settings from public.qorpera_mail_settings as settings;
	-- The company's mailboxes, paused ones included; one named that is not the company's is an error.
	select coalesce(array_agg(mailbox.hook_id), '{}') into v_hooks
	from public.qorpera_company_mailboxes as mailbox
	where mailbox.profile_id = v_run.profile_id and mailbox.environment_id = v_run.environment_id
		and mailbox.removed_at is null
		and (v_mailbox is null or mailbox.local_part || '@' || v_settings.domain = v_mailbox);
	if v_mailbox is not null and cardinality(v_hooks) = 0 then
		raise exception 'No mailbox of this company has that address; list_hooks shows them' using errcode = '22023';
	end if;
	-- The newest 2000 mails in the window bound the search; matching reads only the kept headers.
	select coalesce(jsonb_agg(found.item order by found.received_at desc, found.id desc), '[]'::jsonb) into v_found
	from (
		select delivery.id, delivery.received_at, jsonb_build_object(
			'deliveryId', delivery.id,
			'mailbox', mailbox.local_part || '@' || v_settings.domain,
			'deliveredTo', coalesce(to_jsonb(string_to_array(delivery.headers ->> 'delivered-to', ', ')), '[]'::jsonb),
			'from', delivery.headers ->> 'from',
			'subject', delivery.headers ->> 'subject',
			'receivedAt', delivery.received_at) as item
		from (
			select candidate.* from public.qorpera_event_deliveries as candidate
			where candidate.hook_id = any (v_hooks) and candidate.status = 'verified'
				and candidate.event_type = 'mail.received' and candidate.received_at >= v_since
			order by candidate.received_at desc, candidate.id desc
			limit 2000
		) as delivery
		join public.qorpera_company_mailboxes as mailbox on mailbox.hook_id = delivery.hook_id
		where (v_to is null or v_to = any (string_to_array(delivery.headers ->> 'delivered-to', ', ')))
			and (v_from is null or strpos(lower(delivery.headers ->> 'from'), v_from) > 0)
			and (v_subject is null or strpos(lower(delivery.headers ->> 'subject'), v_subject) > 0)
		order by delivery.received_at desc, delivery.id desc
		limit 11
	) as found;
	return jsonb_build_object('schema', 'qorpera.agent-mail-search/v1', 'runId', v_run.id, 'since', v_since,
		'mails', coalesce((select jsonb_agg(mail.value order by mail.place) from jsonb_array_elements(v_found)
			with ordinality as mail(value, place) where mail.place <= 10), '[]'::jsonb),
		'more', jsonb_array_length(v_found) > 10);
end
$$;
revoke all on function public.qorpera_find_agent_mail(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_find_agent_mail(jsonb, jsonb) to service_role;
-- The guest's native host reaches it as it reaches send_mail: through the publishable-key entry point, bound to
-- its job's run (G2-1, 20260929999500).
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_find_agent_mail', 'binding');

-- ---------------------------------------------------------------------------
-- 3. Observations name the new tool
-- ---------------------------------------------------------------------------
select pg_temp.mail_find_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'list_hooks','read_event','send_mail',$old$,
	$new$'list_hooks','read_event','send_mail','find_mail',$new$);
