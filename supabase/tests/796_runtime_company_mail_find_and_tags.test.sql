-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company mail and event hooks between companies, on the folder-v2 runtime base (ported from snapshot-v1 in the legacy
-- sweep; it also holds the surviving checks of 731, 732 and 733, which other tests chain on). Their tables are closed;
-- only an owner or admin makes a mailbox, in the company's own environment, and an address belongs to one company; a
-- mailbox never shows its hook address, to members or agents, and the public intake never fills it; an agent's run lists
-- only its company's hooks, with addresses only while an owner or admin requested it; it reads no other company's event,
-- listens to no other company's hook, sends from no other company's mailbox, answers no other company's email and finds
-- no other company's mail; settled texts are cleared after seven days; a company being deleted takes no mail, sends none,
-- and its queued mail is cancelled.

select pg_temp.base_claims('service_role');
create function pg_temp.mf_binding() returns jsonb language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb
$$;
create function pg_temp.mf_request(p_from text default 'support@mail.example.test', p_extra jsonb default '{}') returns jsonb
language sql as $$
	select jsonb_build_object('from', p_from, 'to', jsonb_build_array('customer@example.org'), 'subject', 'Hello',
		'text', 'Thanks for writing.') || p_extra
$$;
create function pg_temp.mf_send(p_call text, p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_send_agent_mail(pg_temp.mf_binding(), p_call, p_request)
$$;
create function pg_temp.mf_send_error(p_call text, p_request jsonb, p_state text, p_message text default null) returns void
language sql as $$
	select pg_temp.base_error(format('select pg_temp.mf_send(%L, %L::jsonb)', p_call, p_request), p_state, p_message)
$$;
-- A received email as the mail door stores it: the first recipient's result.
create function pg_temp.mf_mail(p_n integer, p_to text, p_subject text default 'Hello') returns jsonb language sql as $$
	select public.qorpera_receive_mail('aaaaaaaa-0000-4000-8000-' || lpad(p_n::text, 12, '0'), array[p_to],
		json_build_object('schema', 'qorpera.mail/v1', 'emailId', 'aaaaaaaa-0000-4000-8000-' || lpad(p_n::text, 12, '0'),
			'subject', p_subject, 'from', 'customer@example.org', 'to', json_build_array(p_to), 'text', 'Hi.')::text)
		-> 'results' -> 0
$$;
create function pg_temp.mf_find(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_find_agent_mail(pg_temp.mf_binding(), p_request)
$$;
create function pg_temp.mf_found(p_request jsonb) returns uuid[] language sql as $$
	select coalesce(array_agg((mail.value ->> 'deliveryId')::uuid order by mail.place), '{}')
	from jsonb_array_elements(pg_temp.mf_find(p_request) -> 'mails') with ordinality as mail(value, place)
$$;
create function pg_temp.mf_outbox(p_call text) returns public.qorpera_company_mail_outbox language sql as $$
	select * from public.qorpera_company_mail_outbox where call_id = p_call
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';

-- Another folder-v2 company (made as the base makes its own).
insert into auth.users(id, email) values ('79600000-0000-4000-8000-000000000001', 'other-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('79600000-0000-4000-8000-000000000010', 'Other company', '79600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('79600000-0000-4000-8000-000000000010', '79600000-0000-4000-8000-000000000001', 'other-owner@example.test', 'Other',
	'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('79600000-0000-4000-8000-000000000020', '79600000-0000-4000-8000-000000000010', 'Environment', 1,
	'79600000-0000-4000-8000-000000000001');
select public.qorpera_folder_enable('79600000-0000-4000-8000-000000000020') \g /dev/null

-- 1. The tables are closed ----------------------------------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_mail_settings', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_company_mailboxes', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_company_mail_outbox', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_event_listener_cursors', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_event_wake_deliveries', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Mail or event wake tables are exposed to %', v_role; end if;
	end loop;
end
$$;

-- 2. Making a mailbox: an owner or admin, in the company's own environment; an address is one company's ----------------

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_error($q$select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'support', 'Customer support')$q$, '42501');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
select pg_temp.base_error($q$select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'support', 'Customer support')$q$, '42501');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'79600000-0000-4000-8000-000000000020', 'support', 'Customer support')$q$, '22023');
select set_config('qorpera_test.mf_mailbox', public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'support', 'Customer support')::text, true);
select pg_temp.base_assert(current_setting('qorpera_test.mf_mailbox')::jsonb ->> 'email' = 'support@mail.example.test'
	and current_setting('qorpera_test.mf_mailbox')::jsonb ->> 'proof' = 'mail'
	and not (current_setting('qorpera_test.mf_mailbox')::jsonb ?| array['address', 'path']),
	'The mailbox shows its email address and never its hook address: ' || current_setting('qorpera_test.mf_mailbox'));
select set_config('qorpera_test.mf_forms', public.qorpera_create_event_hook('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'forms', 'Form posts')::text, true);
-- Members see the mailbox's email address; its hook address never shows.
select pg_temp.base_assert((select count(*) = 1 from jsonb_array_elements(public.qorpera_list_event_hooks(
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020')) as hook(value)
	where hook.value ->> 'email' = 'support@mail.example.test' and not hook.value ? 'address'),
	'Members list the mailbox with its email address and no hook address');
-- The other company's owner: its own mailbox and hook, and never this company's address.
select pg_temp.base_claims('authenticated', '79600000-0000-4000-8000-000000000001');
select pg_temp.base_error($q$select public.qorpera_create_company_mailbox('79600000-0000-4000-8000-000000000010',
	'79600000-0000-4000-8000-000000000020', 'support', 'Their support')$q$, '23505');
select public.qorpera_create_company_mailbox('79600000-0000-4000-8000-000000000010', '79600000-0000-4000-8000-000000000020',
	'theirs', 'Their mailbox') \g /dev/null
select set_config('qorpera_test.mf_elsewhere', public.qorpera_create_event_hook('79600000-0000-4000-8000-000000000010',
	'79600000-0000-4000-8000-000000000020', 'elsewhere', 'Their form posts') ->> 'id', true);
select pg_temp.base_claims('service_role');

-- The public event intake treats a mailbox's hook address as unknown.
select pg_temp.base_assert(public.qorpera_receive_event((select address from public.qorpera_event_hooks
	where id = (current_setting('qorpera_test.mf_mailbox')::jsonb ->> 'id')::uuid), 'application/json', '{}',
	encode(convert_to('{}', 'UTF8'), 'base64')) ->> 'outcome' = 'unknown', 'The public intake never fills a mailbox');

-- 3. An agent's run: its company's hooks only, addresses only while an owner or admin requested it ---------------------

select pg_temp.base_public_send(pg_temp.mf_binding(), 'progress', 'mf-ack') \g /dev/null
do $$
declare v_hooks jsonb := public.qorpera_list_agent_event_hooks(pg_temp.mf_binding()) -> 'hooks';
begin
	perform pg_temp.base_assert(jsonb_array_length(v_hooks) = 2
		and v_hooks -> 0 ->> 'name' = 'forms'
		and v_hooks -> 0 ->> 'address' = current_setting('qorpera_test.mf_forms')::jsonb ->> 'address'
		and v_hooks -> 0 ->> 'url' = 'https://intake.example.test/functions/v1/event-intake/'
			|| (current_setting('qorpera_test.mf_forms')::jsonb ->> 'address')
		and v_hooks -> 1 ->> 'email' = 'support@mail.example.test'
		and not (v_hooks -> 1 ?| array['address', 'path', 'url']),
		'Agents list their own company''s hooks, with addresses for an owner''s run, and never a mailbox''s: ' || v_hooks::text);
end
$$;
-- The owner who requested the run is a contributor now (the founder guard set aside): no addresses.
set local session_replication_role = replica;
update public.qorpera_profile_members set role = 'contributor'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
select pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(public.qorpera_list_agent_event_hooks(pg_temp.mf_binding())
		-> 'hooks') as hook(value) where hook.value ?| array['address', 'path', 'url']),
	'A contributor''s run lists hooks without addresses');
set local session_replication_role = replica;
update public.qorpera_profile_members set role = 'owner'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
set local session_replication_role = origin;

-- It reads no other company's event.
with delivery as (
	insert into public.qorpera_event_deliveries(hook_id, profile_id, status, delivery_key, event_type, content_type, body,
		body_bytes, body_sha256, verified_at)
	values (current_setting('qorpera_test.mf_elsewhere')::uuid, '79600000-0000-4000-8000-000000000010', 'verified', 'mf-their-1',
		'form.posted', 'application/json', convert_to('{"name":"Elsewhere"}', 'UTF8'), 20,
		encode(extensions.digest('{"name":"Elsewhere"}', 'sha256'), 'hex'), clock_timestamp())
	returning id)
select set_config('qorpera_test.mf_their_event', id::text, true) from delivery \g /dev/null
select pg_temp.base_error(format('select public.qorpera_read_agent_event(%L::jsonb, %L::jsonb)', pg_temp.mf_binding(),
	jsonb_build_object('deliveryId', current_setting('qorpera_test.mf_their_event'))), '42501', 'Event is unavailable');

-- It listens to no other company's hook: a routine file on it is refused.
do $$
declare
	v_hook text := current_setting('qorpera_test.mf_elsewhere');
	v_parse jsonb := jsonb_build_object('kind', 'routine', 'id', '79600000-0000-4000-8000-0000000000e1', 'title', 'Elsewhere',
		'status', 'active', 'trigger', jsonb_build_object('when', 'event', 'hook', v_hook, 'only', null),
		'timezone', 'Europe/Copenhagen', 'ends', null, 'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'optional',
		'conclusion', null, 'instructions', 'Answer their forms.');
	v_text text := E'---\n' || v_parse::text || E'\n---\n';
	v_unit jsonb := pg_temp.base_write('agents/alice/routines/elsewhere.md', 'routine', v_text, v_parse);
	v_result jsonb;
begin
	perform pg_temp.base_seal(pg_temp.base_owner(), pg_temp.base_manifest(v_text));
	v_result := public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), 'mf-routine',
		jsonb_build_array(v_unit));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and v_result -> 'units' -> 0 ->> 'reason' = 'structured_rule'
		and v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
			= 'hook ' || v_hook || ' is not a hook or mailbox of this company; list_hooks shows them',
		'A routine on another company''s hook: ' || v_result::text);
end
$$;

-- 4. Mail: from, answering and finding this company's only -------------------------------------------------------------

select pg_temp.mf_send_error('from-' || n, pg_temp.mf_request(address), '42501',
	'No mailbox of this company has that address; list_hooks shows them')
from unnest(array['theirs@mail.example.test', 'theirs']) with ordinality as item(address, n);
select set_config('qorpera_test.mf_their_mail', pg_temp.mf_mail(1, 'theirs+stripe@mail.example.test', 'Confirm your Stripe account')
	->> 'deliveryId', true);
select set_config('qorpera_test.mf_our_mail', pg_temp.mf_mail(2, 'support+stripe@mail.example.test', 'Confirm your Stripe account')
	->> 'deliveryId', true);
select pg_temp.mf_send_error('reply-theirs', pg_temp.mf_request(p_extra => jsonb_build_object('inReplyTo',
	current_setting('qorpera_test.mf_their_mail'))), '42501', 'The email this answers is not one the company received');
select pg_temp.base_assert(current_setting('qorpera_test.mf_their_mail') is not null
	and current_setting('qorpera_test.mf_our_mail')::uuid = any (pg_temp.mf_found('{"subject":"Confirm"}'))
	and not (current_setting('qorpera_test.mf_their_mail')::uuid = any (pg_temp.mf_found('{"subject":"Confirm"}')))
	and pg_temp.mf_found('{"to":"theirs+stripe@mail.example.test"}') = '{}',
	'Another company''s mail is not found');
select pg_temp.base_error(format('select pg_temp.mf_find(%L::jsonb)', '{"mailbox":"theirs@mail.example.test"}'), '22023',
	'No mailbox of this company has that address; list_hooks shows them');

-- 5. Settled texts are cleared after seven days; the receipt stays --------------------------------------------------------

select pg_temp.base_assert(pg_temp.mf_send('mf-' || call, pg_temp.mf_request(p_extra => jsonb_build_object('subject', 'Order ' || call)))
	->> 'status' = 'queued', 'Mail ' || call || ' is queued')
from unnest(array['a', 'b', 'c']) as call;
select public.qorpera_claim_company_mail(50, '79600000-0000-4000-8000-0000000000a1') \g /dev/null
select public.qorpera_complete_company_mail((pg_temp.mf_outbox('mf-' || call)).id, '79600000-0000-4000-8000-0000000000a1',
	'provider-' || call) from unnest(array['b', 'c']) as call \g /dev/null
select public.qorpera_fail_company_mail((pg_temp.mf_outbox('mf-a')).id, '79600000-0000-4000-8000-0000000000a1',
	'Resend returned HTTP 429', true) \g /dev/null
update public.qorpera_company_mail_outbox set settled_at = clock_timestamp() - interval '8 days' where call_id = 'mf-b';
select public.qorpera_claim_company_mail(1, '79600000-0000-4000-8000-0000000000a2') \g /dev/null
select pg_temp.base_assert((pg_temp.mf_outbox('mf-b')).status = 'sent' and (pg_temp.mf_outbox('mf-b')).body is null
	and (pg_temp.mf_outbox('mf-c')).body is not null
	and pg_temp.mf_send('mf-b', '{}') ->> 'subject' = 'Order b', 'A settled text is cleared after seven days');

-- 6. A company being deleted takes no mail, sends none, and its queued mail is cancelled ---------------------------------

update public.qorpera_company_mail_outbox set next_attempt_at = clock_timestamp() where call_id = 'mf-a';
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.mf_mail(3, 'support@mail.example.test') ->> 'outcome' = 'unknown',
	'A company being deleted takes no mail');
select pg_temp.mf_send_error('deleting', pg_temp.mf_request(), '55000');
select pg_temp.base_assert(public.qorpera_claim_company_mail(50, '79600000-0000-4000-8000-0000000000a3') = '[]'::jsonb,
	'A company being deleted sends nothing more');
select pg_temp.base_assert((pg_temp.mf_outbox('mf-a')).status = 'cancelled'
	and (pg_temp.mf_outbox('mf-a')).last_error = 'The company is being deleted; an earlier attempt may have gone out',
	'Its queued email is cancelled, and an attempted one says it may have gone out: '
		|| coalesce((pg_temp.mf_outbox('mf-a')).last_error, 'none'));

rollback;
