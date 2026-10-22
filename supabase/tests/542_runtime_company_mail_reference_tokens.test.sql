-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930521000, on the folder-v2 runtime base: a reply's References lists the thread's ids as <id> tokens, whatever
-- the shape of the stored header. The text of a list (the provider's shape for a header with several ids) and anything
-- around the ids give the thread's ids; a plain header, folded or not, and one longer than a header line (the first id
-- and the newest that fit 980 characters, then the email answered) give what they gave before.

select pg_temp.base_claims('service_role');
-- A reply to a received email with this message id and References: the References it goes out with.
create function pg_temp.mr_references(p_n integer, p_message_id text, p_references text) returns text
language plpgsql as $$
declare
	v_email text := '54200000-0000-4000-8000-' || lpad(p_n::text, 12, '0');
	v_received jsonb := public.qorpera_receive_mail(v_email, array['support@mail.example.test'],
		jsonb_build_object('schema', 'qorpera.mail/v1', 'emailId', v_email, 'subject', 'Hello', 'from', 'customer@example.org',
			'to', jsonb_build_array('support@mail.example.test'), 'messageId', p_message_id, 'references', p_references,
			'text', 'Hi.')::text) -> 'results' -> 0;
	v_receipt jsonb;
	v_mail public.qorpera_company_mail_outbox%rowtype;
begin
	v_receipt := public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb, 'mr-' || p_n,
		jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
			'subject', 'Re: Hello', 'text', 'Thanks for writing.', 'inReplyTo', v_received ->> 'deliveryId'));
	select * into v_mail from public.qorpera_company_mail_outbox where call_id = 'mr-' || p_n;
	perform pg_temp.base_assert(v_received ->> 'outcome' = 'accepted' and (v_receipt ->> 'threaded')::boolean
		and v_mail.in_reply_to = p_message_id, 'Reply ' || p_n || ' answers ' || p_message_id || ': ' || v_receipt::text);
	return v_mail.thread_references;
end
$$;
-- A message id 48 characters long.
create function pg_temp.mr_id(p_n integer) returns text language sql immutable as $$
	select '<id' || lpad(p_n::text, 2, '0') || '.' || repeat('x', 29) || '@example.net>'
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'support', 'Customer support') \g /dev/null
select pg_temp.base_claims('service_role');
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'mr-ack') \g /dev/null

-- 1. The text of a list, and ids with anything around them, give the thread's ids ----------------------------------------

select pg_temp.base_assert(pg_temp.mr_references(1, '<c@example.com>', '["<a@example.org>","<b@example.net>"]')
	= '<a@example.org> <b@example.net> <c@example.com>', 'The text of a list gives its ids');
select pg_temp.base_assert(pg_temp.mr_references(2, '<c@example.com>',
		E'Re: <a@example.org>, "<b@example.net>" and b@example.org <x\x01y@example.org>')
	= '<a@example.org> <b@example.net> <c@example.com>',
	'Only the <id> tokens are kept: no words, no bare ids, no id with a control character');
select pg_temp.base_assert(pg_temp.mr_references(3, '<c@example.com>', 'no ids []') = '<c@example.com>',
	'References without ids leaves the email answered');

-- 2. A plain header, folded or not, gives what it gave before ------------------------------------------------------------

select pg_temp.base_assert(pg_temp.mr_references(n, '<c@example.com>', header)
		= '<a@example.org> <b@example.net> <c@example.com>', 'A plain header: ' || header)
from (values (4, '<a@example.org> <b@example.net>'), (5, E' <a@example.org>\r\n\t<b@example.net> ')) as item(n, header);

-- 3. A long thread keeps its first id and the newest that fit 980 characters, then the email answered, as before ----------

select pg_temp.base_assert(pg_temp.mr_references(n, '<last@example.com>', header)
		= (select '<root@example.org> ' || string_agg(pg_temp.mr_id(id), ' ' order by id) || ' <last@example.com>'
			from generate_series(22, 40) as id),
	'A long thread keeps its first id and the newest that fit, from a ' || shape)
from (values
	(6, 'header', (select '<root@example.org> ' || string_agg(pg_temp.mr_id(id), ' ' order by id)
		from generate_series(1, 40) as id)),
	(7, 'list', (select to_jsonb(array['<root@example.org>'] || array_agg(pg_temp.mr_id(id) order by id))::text
		from generate_series(1, 40) as id))) as item(n, shape, header);
-- 968 characters: the next older id, with its space, would make it 1017.
select pg_temp.base_assert(char_length(thread_references) = 968, 'The References is ' || char_length(thread_references))
from public.qorpera_company_mail_outbox where call_id = 'mr-6';

rollback;
