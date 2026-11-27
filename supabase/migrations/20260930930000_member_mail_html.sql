do $$ begin
	if to_regprocedure('public.qorpera_mail_html_snippet(text)') is not null then
		raise exception '20260930930000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_mail_thread(uuid,text,jsonb)') is null
		or to_regprocedure('public.qorpera_mail_thread_snippet(text)') is null then
		raise exception '20260930930000 needs 20260930512000 and 20260930522000'; end if;
end $$;

set local lock_timeout = '3s';

create function public.qorpera_mail_html_snippet(p_html text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare v_text text;
begin
	if p_html is null or btrim(p_html, E' \t\r\n\f\v') = '' then return null; end if;
	v_text := left(p_html, 65536);
	v_text := regexp_replace(v_text, '<!--.*?-->', ' ', 'g');
	v_text := regexp_replace(v_text, '<!--.*$', ' ', 'g');
	v_text := regexp_replace(v_text, '<head(?=[[:space:]/>])[^>]*>.*?</head[[:space:]]*>', ' ', 'gi');
	v_text := regexp_replace(v_text, '<style(?=[[:space:]/>])[^>]*>.*?</style[[:space:]]*>', ' ', 'gi');
	v_text := regexp_replace(v_text, '<style(?=[[:space:]/>])[^>]*>.*$', ' ', 'gi');
	v_text := regexp_replace(v_text, '<script(?=[[:space:]/>])[^>]*>.*?</script[[:space:]]*>', ' ', 'gi');
	v_text := regexp_replace(v_text, '<script(?=[[:space:]/>])[^>]*>.*$', ' ', 'gi');
	v_text := regexp_replace(v_text, '<title(?=[[:space:]/>])[^>]*>.*?</title[[:space:]]*>', ' ', 'gi');
	v_text := regexp_replace(v_text, '<title(?=[[:space:]/>])[^>]*>.*$', ' ', 'gi');
	v_text := regexp_replace(v_text, '<noscript(?=[[:space:]/>])[^>]*>.*?</noscript[[:space:]]*>', ' ', 'gi');
	v_text := regexp_replace(v_text, '<noscript(?=[[:space:]/>])[^>]*>.*$', ' ', 'gi');
	v_text := regexp_replace(v_text, '<[^>]*>', ' ', 'g');
	v_text := regexp_replace(v_text, '<[^>]*$', ' ', 'g');
	v_text := regexp_replace(v_text, '&(?:zwnj|zwj|shy);|&#(?:847|8203|8204|8205|65279|173);|&#x0*(?:34f|200b|200c|200d|feff|ad);', '', 'gi');
	v_text := regexp_replace(v_text, '[' || chr(847) || chr(8203) || chr(8204) || chr(8205) || chr(65279) || chr(173) || ']+', '', 'g');
	v_text := regexp_replace(v_text, '&nbsp;|&#160;|&#xa0;', ' ', 'gi');
	v_text := regexp_replace(v_text, '&lt;', '<', 'gi');
	v_text := regexp_replace(v_text, '&gt;', '>', 'gi');
	v_text := regexp_replace(v_text, '&quot;|&#34;', '"', 'gi');
	v_text := regexp_replace(v_text, '&apos;|&#39;|&#x27;', '''', 'gi');
	v_text := regexp_replace(v_text, '&ndash;|&#8211;', '–', 'gi');
	v_text := regexp_replace(v_text, '&mdash;|&#8212;', '—', 'gi');
	v_text := regexp_replace(v_text, '&hellip;|&#8230;', '…', 'gi');
	v_text := regexp_replace(v_text, '&bull;|&#8226;', '•', 'gi');
	v_text := regexp_replace(v_text, '&amp;|&#38;', '&', 'gi');
	return public.qorpera_mail_snippet(v_text);
end
$$;
revoke all on function public.qorpera_mail_html_snippet(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_mail_thread_snippet(p_thread text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_thread public.qorpera_mail_threads%rowtype;
	v_message jsonb;
begin
	select * into v_thread from public.qorpera_mail_threads as thread where thread.id = p_thread;
	if not found then return null; end if;
	if v_thread.last_direction = 'received' then
		select public.qorpera_mail_json_object(convert_from(delivery.body, 'UTF8')) into v_message
		from public.qorpera_event_deliveries as delivery
		where delivery.id = v_thread.last_received_delivery_id and delivery.body is not null;
		if v_message is null then return null; end if;
		return coalesce(
			case when jsonb_typeof(v_message -> 'text') = 'string'
				then public.qorpera_mail_snippet(v_message ->> 'text') end,
			case when jsonb_typeof(v_message -> 'html') = 'string'
				then public.qorpera_mail_html_snippet(v_message ->> 'html') end
		);
	end if;
	return (select public.qorpera_mail_snippet(mail.body)
		from public.qorpera_company_mail_outbox as mail
		where mail.thread = v_thread.id and mail.profile_id = v_thread.profile_id
		order by mail.created_at desc, mail.id desc limit 1);
exception when others then
	return null;
end
$$;
revoke all on function public.qorpera_mail_thread_snippet(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.mail_html_patch(p_target regprocedure, p_old text, p_new text)
returns void
language plpgsql
as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail html patch anchor not found once in %: %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.mail_html_patch('public.qorpera_member_mail_thread(uuid,text,jsonb)'::regprocedure,
	$old$				'text', case when mark.value is null then left(body.message ->> 'text', 16000) end,
				'textTruncated', case when mark.value is null and char_length(body.message ->> 'text') > 16000 then true end,
				'textCleared', delivery.body is null,$old$,
	$new$				'text', case when mark.value is null and jsonb_typeof(body.message -> 'text') = 'string'
					then left(body.message ->> 'text', 16000) end,
				'textTruncated', case when mark.value is null and jsonb_typeof(body.message -> 'text') = 'string'
					and char_length(body.message ->> 'text') > 16000 then true end,
				'html', case when mark.value is null and jsonb_typeof(body.message -> 'html') = 'string'
					and nullif(btrim(body.message ->> 'html', E' \t\r\n\f\v'), '') is not null
					then left(body.message ->> 'html', 262144) end,
				'htmlTruncated', case when mark.value is null and jsonb_typeof(body.message -> 'html') = 'string'
					and nullif(btrim(body.message ->> 'html', E' \t\r\n\f\v'), '') is not null
					and (char_length(body.message ->> 'html') > 262144
						or body.message -> 'truncated' = 'true'::jsonb) then true end,
				'textCleared', delivery.body is null,$new$);
