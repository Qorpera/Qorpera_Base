-- Company mail for accounts the company owns (Q1, agreed with A1 on 2 October; design
-- deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)", "Plus addresses and find_mail").
--
-- Plus addresses: local+tag@<mail domain> reaches the mailbox local@, so an agent can sign the company up for
-- a second account on one site (agents+stripe@). The tag is 1-64 lowercase letters, digits, dots, hyphens and
-- underscores (and the whole local part, as the mail door takes it, at most 64 characters); any other tag reaches
-- no mailbox. Plus addresses only receive: send_mail sends from a mailbox's own address, and refuses a company's
-- own mailboxes as recipients with or without a tag.
--
-- Each received mail now records, on its delivery, the mail's own headers an agent searches by: delivered-to
-- (the message's recipients that reach that mailbox, tags included), from, subject and authentication-results
-- (the mail door's SPF, DKIM and DMARC verdicts). Control characters become spaces and each value is cut to fit
-- its share of the headers' 8 KiB; the headers count toward the company's hourly bytes like the body. Mail
-- received earlier keeps none.
--
-- find_mail: an agent's search of its company's received mail, by mailbox, delivered-to address, sender and
-- subject (case-insensitive parts), since a time (at most 7 days back, the bodies' lifetime; 24 hours by
-- default) and before a time (to page back). It looks at the newest 2000 mails in that window and returns at
-- most 10, newest first, as many as fit the tool's 8 KiB answer, each with its delivery id for read_event; no
-- mail text and no matching inside it. more says there are others (or that the 2000 were not all it could
-- see), and nextBefore is the before that shows the next older ones. The runtime polls it to wait for a mail
-- (waitSeconds). It is a read: the run's company and environment only, through the native tool binding.
--
-- Locks: find takes the run's job and run rows as read_event does, and reads deliveries without locking: one
-- ordered scan of each mailbox's (hook_id, received_at) index, each planned with that mailbox's values and
-- stopping at 2000 rows, so a company's volume never makes a search read more than 2000 rows a mailbox.

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
-- 1. Plus addresses, and what a mail delivery keeps
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

-- A header value as a delivery keeps it: at most 998 characters, control characters as spaces, trimmed, and cut
-- further until its JSON text fits p_bytes (multibyte characters and escapes count); null when nothing is left.
create function public.qorpera_mail_header_value(p_value text, p_bytes integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare v_value text := btrim(regexp_replace(left(coalesce(p_value, ''), 998), '[[:cntrl:]]+', ' ', 'g'));
begin
	while octet_length(to_jsonb(v_value)::text) > p_bytes loop
		v_value := left(v_value, char_length(v_value)
			- greatest((octet_length(to_jsonb(v_value)::text) - p_bytes) / 4, 1));
	end loop;
	return nullif(btrim(v_value), '');
end
$$;
revoke all on function public.qorpera_mail_header_value(text, integer) from public, anon, authenticated, service_role;

-- The headers a received mail's delivery keeps, within 8 KiB of JSON: the recipients that reach the mailbox
-- (whole addresses, up to 2048 bytes), the mail's From and Subject (2048 bytes each) and the mail door's
-- authentication verdicts.
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
			select string_agg(fitting.recipient, ', ' order by fitting.recipient)
			from (
				select each.recipient,
					sum(octet_length(each.recipient) + 2) over (order by each.recipient) as running
				from (
					select distinct lower(btrim(item)) as recipient from unnest(p_recipients) as item
					where item is not null and char_length(item) between 3 and 320
				) as each
				where each.recipient = substring(each.recipient from '^[^@]+') || '@' || p_domain
					and public.qorpera_mail_box_part(each.recipient) = p_local_part
			) as fitting
			where fitting.running <= 2050
		),
		'from', case when jsonb_typeof(p_message -> 'from') = 'string'
			then public.qorpera_mail_header_value(p_message ->> 'from', 2048) end,
		'subject', case when jsonb_typeof(p_message -> 'subject') = 'string'
			then public.qorpera_mail_header_value(p_message ->> 'subject', 2048) end,
		'authentication-results', case when jsonb_typeof(p_message -> 'authentication') = 'object'
			then public.qorpera_mail_header_value(format('spf=%s dkim=%s dmarc=%s',
				coalesce(p_message #>> '{authentication,spf}', 'none'), coalesce(p_message #>> '{authentication,dkim}', 'none'),
				coalesce(p_message #>> '{authentication,dmarc}', 'none')), 300) end
	))
$$;
revoke all on function public.qorpera_mail_delivery_headers(text[], text, text, jsonb)
	from public, anon, authenticated, service_role;

select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$	v_results jsonb := '[]'::jsonb;
$old$,
	$new$	v_results jsonb := '[]'::jsonb;
	v_headers jsonb;
$new$);

select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		where mailbox.local_part = substring(v_recipient from '^([^@]+)@') and mailbox.removed_at is null;
$old$,
	$new$		where mailbox.local_part = public.qorpera_mail_box_part(v_recipient) and mailbox.removed_at is null;
$new$);

-- The headers are known before the limits: they count toward the company's hourly bytes like the body.
select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		if exists (select 1 from public.qorpera_event_deliveries as earlier where earlier.hook_id = v_hook.id
$old$,
	$new$		v_headers := public.qorpera_mail_delivery_headers(p_recipients, v_settings.domain, v_mailbox.local_part, v_parsed);
		if exists (select 1 from public.qorpera_event_deliveries as earlier where earlier.hook_id = v_hook.id
$new$);

select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$			or v_used_bytes + octet_length(v_body) > v_intake.company_hourly_bytes then
$old$,
	$new$			or v_used_bytes + octet_length(v_body) + octet_length(v_headers::text) > v_intake.company_hourly_bytes then
$new$);

select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$			'application/json', '{}'::jsonb, v_body, octet_length(v_body), v_sha256, clock_timestamp()
$old$,
	$new$			'application/json', v_headers, v_body, octet_length(v_body), v_sha256, clock_timestamp()
$new$);

select pg_temp.mail_find_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		values (v_hook.profile_id, v_hour, 1, octet_length(v_body))
$old$,
	$new$		values (v_hook.profile_id, v_hour, 1, octet_length(v_body) + octet_length(v_headers::text))
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
-- p_request: {mailbox?, to?, from?, subject?, since?, before?}. mailbox and to are addresses (lowercased); from
-- and subject match as case-insensitive parts of the mail's From and Subject; since and before are instants with
-- their offsets. Mail older than 7 days is never searched (its text is cleared then).
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
	v_before timestamptz;
	v_mailbox text;
	v_to text;
	v_from text;
	v_subject text;
	v_hooks uuid[];
	v_hook uuid;
	v_ids uuid[] := '{}';
	v_times timestamptz[] := '{}';
	v_box_ids uuid[];
	v_box_times timestamptz[];
	v_found jsonb;
	v_more boolean;
	v_next_before timestamptz;
	v_searched bigint;
	v_oldest_searched timestamptz;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['mailbox', 'to', 'from', 'subject', 'since', 'before'] <> '{}'::jsonb
		or exists (select 1 from jsonb_each(p_request) as field where jsonb_typeof(field.value) <> 'string')
		or char_length(p_request ->> 'mailbox') not between 3 and 320
		or char_length(p_request ->> 'to') not between 3 and 320
		or char_length(p_request ->> 'from') not between 1 and 320
		or char_length(p_request ->> 'subject') not between 1 and 200
		or exists (select 1 from jsonb_each_text(p_request) as field where field.key in ('since', 'before')
			and field.value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$')
		or exists (select 1 from jsonb_each_text(p_request) as field where field.value ~ '[[:cntrl:]]') then
		raise exception 'Mail search is invalid' using errcode = '22023'; end if;
	begin
		v_since := (p_request ->> 'since')::timestamptz;
		v_before := (p_request ->> 'before')::timestamptz;
	exception when others then
		raise exception 'Mail search is invalid: since and before are instants with their offsets' using errcode = '22023';
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
	-- The newest 2000 mails in the window bound the search: each mailbox's own index scan stops at 2000, and the
	-- newest 2000 of those are searched. Each mailbox is planned on its own, with its hook id and times as values
	-- (EXECUTE), so the planner sees that mailbox's own volume and keeps to its (hook_id, received_at) index, where
	-- the times are the index's bounds. Matching reads only the kept headers.
	foreach v_hook in array v_hooks loop
		execute 'select coalesce(array_agg(picked.id), ''{}''), coalesce(array_agg(picked.received_at), ''{}'')
			from (select delivery.id, delivery.received_at from public.qorpera_event_deliveries as delivery
				where delivery.hook_id = $1 and delivery.status = ''verified''
					and delivery.event_type = ''mail.received'' and delivery.received_at >= $2
					and delivery.received_at < $3
				order by delivery.received_at desc, delivery.id desc
				limit 2000) as picked'
		into v_box_ids, v_box_times using v_hook, v_since, coalesce(v_before, 'infinity'::timestamptz);
		v_ids := v_ids || v_box_ids;
		v_times := v_times || v_box_times;
	end loop;
	-- The kept 2000 are read back one by one by their key (the limit keeps it a lookup, never a scan of the table).
	with picked as (
		select picked.id, picked.received_at from unnest(v_ids, v_times) as picked(id, received_at)
		order by picked.received_at desc, picked.id desc
		limit 2000
	), candidate as (
		select delivery.* from picked
		cross join lateral (
			select one.id, one.hook_id, one.received_at, one.headers
			from public.qorpera_event_deliveries as one
			where one.id = picked.id
			limit 1
		) as delivery
	), matched as (
		select candidate.id, candidate.received_at, jsonb_strip_nulls(jsonb_build_object(
			'deliveryId', candidate.id,
			'mailbox', mailbox.local_part || '@' || v_settings.domain,
			'deliveredTo', coalesce(to_jsonb((string_to_array(candidate.headers ->> 'delivered-to', ', '))[1:5]), '[]'::jsonb),
			'from', left(candidate.headers ->> 'from', 200),
			'subject', left(candidate.headers ->> 'subject', 200),
			'authentication', candidate.headers ->> 'authentication-results',
			'receivedAt', candidate.received_at)) as item
		from candidate
		join public.qorpera_company_mailboxes as mailbox on mailbox.hook_id = candidate.hook_id
		where (v_to is null or v_to = any (string_to_array(candidate.headers ->> 'delivered-to', ', ')))
			and (v_from is null or strpos(lower(candidate.headers ->> 'from'), v_from) > 0)
			and (v_subject is null or strpos(lower(candidate.headers ->> 'subject'), v_subject) > 0)
		order by candidate.received_at desc, candidate.id desc
		limit 11
	), sized as (
		-- The bytes each mail takes in the tool's answer, which carries this text inside a JSON string and escapes
		-- < > & U+2028 U+2029 as \u003c: a quote or backslash costs one byte more, < > & five more, the two line
		-- separators (three bytes each in UTF-8) three more. The answer keeps the newest match always, then as many
		-- of the 10 as fit 6000 such bytes.
		select matched.item, matched.received_at,
			row_number() over (order by matched.received_at desc, matched.id desc) as place,
			sum(octet_length(matched.item::text) + 1
				+ (length(matched.item::text) - length(translate(matched.item::text, '"\', '')))
				+ 5 * (length(matched.item::text) - length(translate(matched.item::text, '<>&', '')))
				+ 3 * (length(matched.item::text) - length(translate(matched.item::text, E'\u2028\u2029', ''))))
				over (order by matched.received_at desc, matched.id desc) as running
		from matched
	), kept as (
		select sized.*, sized.place <= 10 and (sized.place = 1 or sized.running <= 6000) as shown from sized
	)
	select coalesce(jsonb_agg(kept.item order by kept.place) filter (where kept.shown), '[]'::jsonb),
		coalesce(bool_or(not kept.shown), false),
		min(kept.received_at) filter (where kept.shown),
		(select count(*) from candidate), (select min(candidate.received_at) from candidate)
	into v_found, v_more, v_next_before, v_searched, v_oldest_searched
	from kept;
	-- The next page starts before the oldest mail shown when matches were left out, or before the oldest mail
	-- searched when the 2000 bound was reached (so a page that shows nothing still has a next one).
	if not v_more then
		v_next_before := null;
	end if;
	if v_searched = 2000 then
		v_more := true;
		v_next_before := coalesce(v_next_before, v_oldest_searched);
	end if;
	return jsonb_strip_nulls(jsonb_build_object('schema', 'qorpera.agent-mail-search/v1', 'runId', v_run.id,
		'since', v_since, 'mails', v_found, 'more', v_more, 'nextBefore', v_next_before));
end
$$;
revoke all on function public.qorpera_find_agent_mail(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_find_agent_mail(jsonb, jsonb) to service_role;
-- The guest's native host reaches it as it reaches send_mail: through the publishable-key entry point, bound to
-- its job's run (G2-1, 20260928409985), and its dispatch lists it (G2-2, cloud-native-host-dispatch.ts).
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_find_agent_mail', 'binding');

-- ---------------------------------------------------------------------------
-- 3. Observations name the new tool
-- ---------------------------------------------------------------------------
select pg_temp.mail_find_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'list_hooks','read_event','send_mail',$old$,
	$new$'list_hooks','read_event','send_mail','find_mail',$new$);
