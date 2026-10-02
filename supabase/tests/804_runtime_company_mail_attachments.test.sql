-- @fixture 733_runtime_company_mail_sending.test.sql until "-- Switched off, nothing is queued."
-- Company mail attachments, step M2c-1 (20260928429984): an agent asks for a received email's attachment, which the
-- platform's worker fetches once into the company's objects and the runtime then writes as a company file; the
-- request checks the email is the company's and the attachment is one it lists, at most 40 MiB, while the email's
-- text is kept; the worker claims fetches under a lease, completes them with chunks the catalog holds, and tries a
-- passing failure again. An email carries company files the agent may read, at most 10 and 28 MiB, as they are when
-- queued; the worker's claim hands them over with the company, at most 64 MiB of them a claim.

create function pg_temp.ask(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_native_mail_attachment(current_setting('qorpera_test.routine_binding')::jsonb, p_request)
$$;
create function pg_temp.ask_error(p_request jsonb, p_state text, p_message text default null) returns void
language sql as $$
	select pg_temp.wake_error(format('select pg_temp.ask(%L::jsonb)', p_request), p_state, p_message)
$$;
create function pg_temp.fetch_row(p_delivery uuid, p_attachment integer) returns public.qorpera_mail_attachment_fetches
language sql as $$
	select * from public.qorpera_mail_attachment_fetches where delivery_id = p_delivery and attachment = p_attachment
$$;
-- A company object as the worker stores it: a Storage row in the bucket, which the catalog records.
create function pg_temp.object(p_company uuid, p_text text) returns jsonb language plpgsql as $$
declare v_sha text := encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex');
begin
	insert into storage.objects(bucket_id, name, metadata)
	values ('qorpera-profile-objects', p_company::text || '/' || v_sha, jsonb_build_object('size', octet_length(p_text)))
	on conflict do nothing;
	return jsonb_build_object('sha256', v_sha, 'bytes', octet_length(p_text));
end
$$;
create function pg_temp.with_files(p_n integer) returns uuid language sql as $$
	select pg_temp.received(p_n, 'support@mail.example.test', jsonb_build_object('attachments', jsonb_build_array(
		jsonb_build_object('id', 'att_' || p_n || '_1', 'filename', 'invoice.pdf', 'contentType', 'application/pdf',
			'size', 12),
		jsonb_build_object('id', 'att_' || p_n || '_2', 'filename', 'huge.bin', 'size', 41943041),
		jsonb_build_object('id', 'not/an id', 'filename', 'odd.txt'),
		jsonb_build_object('id', 'att_' || p_n || '_4', 'filename', 'unsized.txt'))))
$$;
select pg_temp.path_claims('service_role');
update public.qorpera_mail_settings set sending = true;

-- Privileges: the fetches are closed; the agents' door and the worker's are service_role's alone; the helpers nobody's.
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_mail_attachment_fetches', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'The attachment fetches are exposed to %', v_role; end if;
		foreach v_function in array array['public.qorpera_mail_attachments_kick()',
			'public.qorpera_mail_attachment_receipt(uuid,public.qorpera_mail_attachment_fetches)'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
	end loop;
	foreach v_function in array array['public.qorpera_native_mail_attachment(jsonb,jsonb)',
		'public.qorpera_claim_mail_attachment_fetches(integer,uuid)',
		'public.qorpera_complete_mail_attachment_fetch(uuid,uuid,text,bigint,jsonb)',
		'public.qorpera_fail_mail_attachment_fetch(uuid,uuid,text,boolean)'] loop
		foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
		if not has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% lost its caller', v_function; end if;
	end loop;
	if not exists (select 1 from public.qorpera_native_host_calls
		where name = 'qorpera_native_mail_attachment' and scope = 'binding') then
		raise exception 'The native host cannot reach save_attachment'; end if;
end
$$;

-- Requests: closed shapes, a delivery id and a place from 1 to 50.
select set_config('qorpera_test.files', pg_temp.with_files(60)::text, true);
select pg_temp.ask_error(request, '22023', 'Attachment request is invalid')
from (values ('null'::jsonb), ('[]'), ('{}'), (jsonb_build_object('deliveryId', current_setting('qorpera_test.files'))),
	(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 0)),
	(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 51)),
	(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 1.5)),
	(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', '1')),
	(jsonb_build_object('deliveryId', 'the invoice', 'attachment', 1)),
	(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 1, 'path', 'a.pdf'))
) as item(request);

-- Only an email the company received: not another company's, not another hook's event, not an unknown id.
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('30000000-0000-4000-8000-0000000007a0',
	'30000000-0000-4000-8000-0000000007a1', 'theirs', 'Another company''s mailbox');
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(pg_temp.post('{"form":"contact"}') = 'accepted', 'A form post arrives');
select pg_temp.ask_error(jsonb_build_object('deliveryId', delivery, 'attachment', 1), '42501',
	'The email is not one the company received')
from unnest(array[
	pg_temp.received(61, 'theirs@mail.example.test', '{"attachments":[{"id":"att_61","filename":"a.pdf"}]}'),
	(select id from public.qorpera_event_deliveries where hook_id = '30000000-0000-4000-8000-0000000007b1'
		and status = 'verified' order by received_at desc limit 1),
	extensions.gen_random_uuid()
]) as item(delivery);

-- Only an attachment the email lists, by a provider id it can name, of at most 40 MiB.
select pg_temp.ask_error(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', n), state,
	message)
from (values (5, '22023', 'The email has no attachment 5; read_event lists its attachments'),
	(3, '22023', 'The email has no attachment 3; read_event lists its attachments'),
	(2, '54000', 'Attachment 2 is larger than 40 MiB, the most an attachment saved may be')) as item(n, state, message);
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_mail_attachment_fetches), 'Nothing was recorded');

-- The first request records the fetch: the worker fetches it; the agent sees it fetching.
select set_config('qorpera_test.asked',
	pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 1))::text, true);
select pg_temp.wake_assert(asked = jsonb_build_object('schema', 'qorpera.agent-mail-attachment/v1',
		'runId', current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId',
		'deliveryId', current_setting('qorpera_test.files'), 'attachment', 1, 'filename', 'invoice.pdf',
		'contentType', 'application/pdf', 'state', 'fetching'),
	'The request answers the fetch: ' || asked::text)
from (select current_setting('qorpera_test.asked')::jsonb as asked) as answer;
select pg_temp.wake_assert(row.status = 'pending' and row.email_id = pg_temp.mail_id(60)
		and row.provider_attachment_id = 'att_60_1' and row.profile_id = '30000000-0000-4000-8000-000000000010'
		and row.environment_id = '30000000-0000-4000-8000-000000000020'
		and row.requested_by_run_id = (current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId')::uuid,
	'The fetch names the provider''s email and attachment')
from pg_temp.fetch_row(current_setting('qorpera_test.files')::uuid, 1) as row;
-- Asking again is the same fetch; an attachment without a size is fetched too.
select pg_temp.wake_assert(pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'),
	'attachment', 1)) = current_setting('qorpera_test.asked')::jsonb, 'Asking again answers the same fetch');
select pg_temp.wake_assert(pg_temp.ask(jsonb_build_object('deliveryId', upper(current_setting('qorpera_test.files')),
	'attachment', 4)) ->> 'state' = 'fetching', 'An attachment of unknown size is fetched too');
select pg_temp.wake_assert((select count(*) from public.qorpera_mail_attachment_fetches) = 2, 'Two fetches, once each');

-- The worker claims due fetches under a lease, with what it needs to find each at the provider.
select set_config('qorpera_test.claim',
	public.qorpera_claim_mail_attachment_fetches(10, '80400000-0000-4000-8000-000000000001')::text, true);
select pg_temp.wake_assert(jsonb_array_length(claim) = 2 and claim -> 0 = jsonb_build_object(
		'fetchId', (pg_temp.fetch_row(current_setting('qorpera_test.files')::uuid, 1)).id,
		'leaseId', '80400000-0000-4000-8000-000000000001', 'attemptCount', 1,
		'companyId', '30000000-0000-4000-8000-000000000010', 'emailId', pg_temp.mail_id(60), 'attachmentId', 'att_60_1'),
	'The claim hands over each fetch: ' || claim::text)
from (select current_setting('qorpera_test.claim')::jsonb as claim) as claimed;
select pg_temp.wake_assert(public.qorpera_claim_mail_attachment_fetches(10, '80400000-0000-4000-8000-000000000002')
	= '[]'::jsonb, 'A leased fetch is not claimed twice');
select pg_temp.wake_error($$select public.qorpera_claim_mail_attachment_fetches(11, extensions.gen_random_uuid())$$,
	'22023');
select pg_temp.wake_error($$select public.qorpera_claim_mail_attachment_fetches(1, null)$$, '22023');
select pg_temp.wake_assert(pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'),
	'attachment', 1)) ->> 'state' = 'fetching', 'A claimed fetch is still fetching for the agent');

-- Completing: only the lease, only chunks in the shape stored (4 MiB each but the last), only chunks the catalog holds.
select set_config('qorpera_test.chunk', pg_temp.object('30000000-0000-4000-8000-000000000010', 'PDF-1.7 bytes')::text,
	true);
select set_config('qorpera_test.fetch', (pg_temp.fetch_row(current_setting('qorpera_test.files')::uuid, 1)).id::text,
	true);
select pg_temp.wake_assert(not public.qorpera_complete_mail_attachment_fetch(current_setting('qorpera_test.fetch')::uuid,
	'80400000-0000-4000-8000-000000000002', repeat('f', 64), 13,
	jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb)), 'Another lease completes nothing');
select pg_temp.wake_error(format($$select public.qorpera_complete_mail_attachment_fetch(%L, %L, %L, %s, %L::jsonb)$$,
	current_setting('qorpera_test.fetch'), '80400000-0000-4000-8000-000000000001', sha, bytes, chunks), '22023',
	'Mail attachment is invalid')
from (values (repeat('f', 64), 14::bigint, jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb)),
	(repeat('F', 64), 13, jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb)),
	(repeat('f', 64), 13, '[]'::jsonb),
	(repeat('f', 64), 13, jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb || '{"extra":1}')),
	(repeat('f', 64), 4194304 + 13, jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb,
		current_setting('qorpera_test.chunk')::jsonb)),
	(repeat('f', 64), 41943041, '[]'::jsonb)) as item(sha, bytes, chunks);
select pg_temp.wake_error(format($$select public.qorpera_complete_mail_attachment_fetch(%L, %L, %L, 13, %L::jsonb)$$,
	current_setting('qorpera_test.fetch'), '80400000-0000-4000-8000-000000000001', repeat('f', 64),
	jsonb_build_array(jsonb_build_object('sha256', repeat('e', 64), 'bytes', 13))), '55000',
	'Mail attachment chunks are not stored');
-- Another company's object of the same bytes is not this company's.
select pg_temp.object('30000000-0000-4000-8000-0000000007a0', 'other company bytes');
select pg_temp.wake_error(format($$select public.qorpera_complete_mail_attachment_fetch(%L, %L, %L, 19, %L::jsonb)$$,
	current_setting('qorpera_test.fetch'), '80400000-0000-4000-8000-000000000001', repeat('f', 64),
	jsonb_build_array(jsonb_build_object('sha256',
		encode(extensions.digest(convert_to('other company bytes', 'utf8'), 'sha256'), 'hex'), 'bytes', 19))), '55000');
select pg_temp.wake_assert(public.qorpera_complete_mail_attachment_fetch(current_setting('qorpera_test.fetch')::uuid,
	'80400000-0000-4000-8000-000000000001', repeat('f', 64), 13,
	jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb)), 'The lease completes the fetch');
select pg_temp.wake_assert(not public.qorpera_complete_mail_attachment_fetch(current_setting('qorpera_test.fetch')::uuid,
	'80400000-0000-4000-8000-000000000001', repeat('f', 64), 13,
	jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb)), 'A stored fetch completes once');
select pg_temp.wake_assert(asked ->> 'state' = 'stored' and asked ->> 'fileSha256' = repeat('f', 64)
		and (asked ->> 'bytes')::bigint = 13 and asked -> 'chunks' = jsonb_build_array(current_setting('qorpera_test.chunk')::jsonb),
	'The agent gets the stored chunks: ' || asked::text)
from (select pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 1))
	as asked) as answer;
-- An empty attachment has no chunks.
select set_config('qorpera_test.empty', pg_temp.received(62, 'support@mail.example.test',
	'{"attachments":[{"id":"att_62","filename":"empty.txt","size":0}]}')::text, true);
select pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.empty'), 'attachment', 1));
update public.qorpera_mail_attachment_fetches set status = 'fetching', lease_id = '80400000-0000-4000-8000-000000000003',
	lease_expires_at = clock_timestamp() + interval '5 minutes'
where delivery_id = current_setting('qorpera_test.empty')::uuid;
select pg_temp.wake_assert(public.qorpera_complete_mail_attachment_fetch(
	(pg_temp.fetch_row(current_setting('qorpera_test.empty')::uuid, 1)).id, '80400000-0000-4000-8000-000000000003',
	encode(extensions.digest('', 'sha256'), 'hex'), 0, '[]'), 'An empty attachment is stored with no chunks');

-- Failing: a failure that may pass waits 1, 2, 4 ... minutes; after six attempts, or any other failure, it is final.
select set_config('qorpera_test.unsized', (pg_temp.fetch_row(current_setting('qorpera_test.files')::uuid, 4)).id::text,
	true);
select pg_temp.wake_assert(not public.qorpera_fail_mail_attachment_fetch(current_setting('qorpera_test.unsized')::uuid,
	'80400000-0000-4000-8000-000000000002', 'Resend returned HTTP 503', true), 'Another lease fails nothing');
select pg_temp.wake_assert(public.qorpera_fail_mail_attachment_fetch(current_setting('qorpera_test.unsized')::uuid,
	'80400000-0000-4000-8000-000000000001', 'Resend returned HTTP 503', true), 'A passing failure is recorded');
select pg_temp.wake_assert(row.status = 'pending' and row.lease_id is null and row.last_error = 'Resend returned HTTP 503'
		and row.next_attempt_at between clock_timestamp() + interval '50 seconds' and clock_timestamp() + interval '70 seconds',
	'A passing failure waits a minute: ' || row.status)
from pg_temp.fetch_row(current_setting('qorpera_test.files')::uuid, 4) as row;
select pg_temp.wake_assert(public.qorpera_claim_mail_attachment_fetches(10, '80400000-0000-4000-8000-000000000004')
	= '[]'::jsonb, 'A waiting fetch is not claimed before its time');
update public.qorpera_mail_attachment_fetches set next_attempt_at = clock_timestamp() - interval '1 second'
where id = current_setting('qorpera_test.unsized')::uuid;
select pg_temp.wake_assert(jsonb_array_length(public.qorpera_claim_mail_attachment_fetches(10,
	'80400000-0000-4000-8000-000000000005')) = 1, 'Its time come, it is claimed again');
select pg_temp.wake_assert(public.qorpera_fail_mail_attachment_fetch(current_setting('qorpera_test.unsized')::uuid,
	'80400000-0000-4000-8000-000000000005', 'Resend returned HTTP 503', true)
	and (pg_temp.fetch_row(current_setting('qorpera_test.files')::uuid, 4)).next_attempt_at
		between clock_timestamp() + interval '110 seconds' and clock_timestamp() + interval '130 seconds',
	'The second passing failure waits two minutes');
update public.qorpera_mail_attachment_fetches set next_attempt_at = clock_timestamp() - interval '1 second',
	attempt_count = 5
where id = current_setting('qorpera_test.unsized')::uuid;
select public.qorpera_claim_mail_attachment_fetches(10, '80400000-0000-4000-8000-000000000006');
select pg_temp.wake_assert(public.qorpera_fail_mail_attachment_fetch(current_setting('qorpera_test.unsized')::uuid,
	'80400000-0000-4000-8000-000000000006', 'Resend returned HTTP 503', true)
	and (pg_temp.fetch_row(current_setting('qorpera_test.files')::uuid, 4)).status = 'failed',
	'The sixth attempt''s failure is final');
select pg_temp.wake_assert(asked ->> 'state' = 'failed' and asked ->> 'error' = 'Resend returned HTTP 503'
		and not asked ? 'chunks',
	'The agent learns why: ' || asked::text)
from (select pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 4))
	as asked) as answer;
-- A final failure at once: the provider no longer has it.
select set_config('qorpera_test.gone', pg_temp.received(63, 'support@mail.example.test',
	'{"attachments":[{"id":"att_63","filename":"old.pdf","size":3}]}')::text, true);
select pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.gone'), 'attachment', 1));
select public.qorpera_claim_mail_attachment_fetches(10, '80400000-0000-4000-8000-000000000007');
select pg_temp.wake_assert(public.qorpera_fail_mail_attachment_fetch((pg_temp.fetch_row(current_setting('qorpera_test.gone')::uuid,
	1)).id, '80400000-0000-4000-8000-000000000007', 'The mail provider no longer has this attachment', false)
	and (pg_temp.fetch_row(current_setting('qorpera_test.gone')::uuid, 1)).status = 'failed', 'A lasting failure is final');
-- A fetch not done within a day, or whose worker vanished after its sixth attempt, is given up.
select set_config('qorpera_test.late', pg_temp.received(64, 'support@mail.example.test',
	'{"attachments":[{"id":"att_64","filename":"late.pdf","size":3}]}')::text, true);
select pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.late'), 'attachment', 1));
update public.qorpera_mail_attachment_fetches set created_at = clock_timestamp() - interval '1 day 1 minute'
where delivery_id = current_setting('qorpera_test.late')::uuid;
select pg_temp.wake_assert(public.qorpera_claim_mail_attachment_fetches(10, '80400000-0000-4000-8000-000000000008')
	= '[]'::jsonb and (pg_temp.fetch_row(current_setting('qorpera_test.late')::uuid, 1)).last_error = 'Not fetched within a day',
	'A day-old fetch is given up');
-- A failed fetch is tried afresh when asked again ten minutes after it failed; sooner, the failure stands.
select pg_temp.wake_assert(pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.gone'),
	'attachment', 1)) ->> 'state' = 'failed', 'Asked again at once, the failure stands');
-- Its day starts again too: a fetch first asked for two days ago is not given up at its next claim.
update public.qorpera_mail_attachment_fetches set settled_at = clock_timestamp() - interval '11 minutes',
	created_at = clock_timestamp() - interval '2 days'
where delivery_id in (current_setting('qorpera_test.gone')::uuid, current_setting('qorpera_test.late')::uuid);
select pg_temp.wake_assert(asked ->> 'state' = 'fetching' and row.status = 'pending' and row.attempt_count = 0
		and row.settled_at is null and row.created_at > clock_timestamp() - interval '1 minute',
	'Asked again later, a failed fetch starts afresh: ' || asked::text)
from (select pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.gone'), 'attachment', 1))
	as asked) as answer, pg_temp.fetch_row(current_setting('qorpera_test.gone')::uuid, 1) as row;
select pg_temp.wake_assert(claim -> 0 ->> 'fetchId' = (pg_temp.fetch_row(current_setting('qorpera_test.gone')::uuid, 1)).id::text
		and (claim -> 0 ->> 'attemptCount')::integer = 1 and jsonb_array_length(claim) = 1,
	'The fetch started afresh is claimed as a first attempt: ' || claim::text)
from (select public.qorpera_claim_mail_attachment_fetches(10, '80400000-0000-4000-8000-000000000009') as claim) as claimed;

-- An email whose text was cleared has no attachments to fetch; one already fetched stays.
update public.qorpera_event_deliveries set body = null
where id in (current_setting('qorpera_test.files')::uuid, current_setting('qorpera_test.late')::uuid);
select pg_temp.ask_error(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'), 'attachment', 2),
	'0A000', 'The email''s text and attachments were cleared 7 days after it arrived');
select pg_temp.wake_assert(pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.files'),
	'attachment', 1)) ->> 'state' = 'stored', 'An attachment fetched before stays');
select pg_temp.wake_assert(pg_temp.ask(jsonb_build_object('deliveryId', current_setting('qorpera_test.late'),
	'attachment', 1)) ->> 'state' = 'failed', 'A failed fetch of a cleared email is not tried again');

-- Sending: company files the agent may read, each once, at most 10 and 28 MiB; recorded as they are when queued.
create function pg_temp.file(p_path text, p_text text) returns jsonb language plpgsql as $$
declare v_entry jsonb := pg_temp.path_stage_file(p_path, p_text); v_result jsonb;
begin
	v_result := pg_temp.path_commit(pg_temp.path_plan('file-' || md5(p_path), p_path, v_entry));
	return v_entry || jsonb_build_object('version', (select version from public.qorpera_company_path_entries
		where environment_id = '30000000-0000-4000-8000-000000000020' and path = p_path));
end
$$;
-- A large file without its bytes: chunks of 4 MiB the catalog holds, as the path gateway stages them.
create function pg_temp.big_file(p_path text, p_bytes bigint) returns jsonb language plpgsql as $$
declare v_chunks jsonb := '[]'; v_sha text; v_size bigint; v_manifest text; v_entry jsonb;
begin
	for v_part in 0 .. ceil(p_bytes / 4194304.0)::integer - 1 loop
		v_size := least(4194304, p_bytes - v_part * 4194304);
		v_sha := encode(extensions.digest(p_path || ':' || v_part, 'sha256'), 'hex');
		insert into storage.objects(bucket_id, name, metadata)
		values ('qorpera-profile-objects', '30000000-0000-4000-8000-000000000010/' || v_sha,
			jsonb_build_object('size', v_size)) on conflict do nothing;
		v_chunks := v_chunks || jsonb_build_array(jsonb_build_object('sha256', v_sha, 'bytes', v_size));
	end loop;
	v_manifest := jsonb_build_object('schema', 'qorpera.cloud-file-manifest/v1',
		'fileSha256', encode(extensions.digest(p_path, 'sha256'), 'hex'), 'bytes', p_bytes,
		'mediaType', 'application/octet-stream', 'chunks', v_chunks)::text;
	v_sha := encode(extensions.digest(convert_to(v_manifest, 'utf8'), 'sha256'), 'hex');
	insert into storage.objects(bucket_id, name, metadata)
	values ('qorpera-profile-objects', '30000000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size', octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('30000000-0000-4000-8000-000000000010', v_manifest);
	v_entry := jsonb_build_object('path', p_path, 'kind', 'file', 'executable', false, 'file', jsonb_build_object(
		'manifestSha256', v_sha, 'fileSha256', encode(extensions.digest(p_path, 'sha256'), 'hex'), 'bytes', p_bytes,
		'mediaType', 'application/octet-stream'));
	perform pg_temp.path_commit(pg_temp.path_plan('file-' || p_path, p_path, v_entry));
	return v_entry;
end
$$;
select set_config('qorpera_test.path_binding', current_setting('qorpera_test.routine_binding'), true);
select set_config('qorpera_test.report', pg_temp.file('report.md', 'Quarterly numbers')::text, true);
select set_config('qorpera_test.sheet', pg_temp.file('totals.csv', 'name,amount')::text, true);
select set_config('qorpera_test.with_files', pg_temp.send('files-1', pg_temp.request(p_extra =>
	'{"attachments":["report.md","totals.csv"]}'))::text, true);
select pg_temp.wake_assert(sent -> 'attachments' = jsonb_build_array(
		jsonb_build_object('path', 'report.md', 'bytes', 17), jsonb_build_object('path', 'totals.csv', 'bytes', 11)),
	'The receipt lists the files: ' || sent::text)
from (select current_setting('qorpera_test.with_files')::jsonb as sent) as receipt;
select pg_temp.wake_assert(mail.attachment_bytes = 28 and mail.attachments = jsonb_build_array(
		jsonb_build_object('path', 'report.md', 'filename', 'report.md',
			'version', current_setting('qorpera_test.report')::jsonb -> 'version',
			'manifestSha256', current_setting('qorpera_test.report')::jsonb #> '{file,manifestSha256}',
			'fileSha256', current_setting('qorpera_test.report')::jsonb #> '{file,fileSha256}', 'bytes', 17),
		jsonb_build_object('path', 'totals.csv', 'filename', 'totals.csv',
			'version', current_setting('qorpera_test.sheet')::jsonb -> 'version',
			'manifestSha256', current_setting('qorpera_test.sheet')::jsonb #> '{file,manifestSha256}',
			'fileSha256', current_setting('qorpera_test.sheet')::jsonb #> '{file,fileSha256}', 'bytes', 11)),
	'The email records each file as it is now: ' || mail.attachments::text)
from pg_temp.outbox(current_setting('qorpera_test.with_files')::jsonb) as mail;
select pg_temp.wake_assert(exists (select 1 from public.qorpera_company_run_read_paths
		where run_id = (current_setting('qorpera_test.routine_binding')::jsonb ->> 'runId')::uuid and path = 'totals.csv'),
	'Attaching a file is reading it');
select pg_temp.wake_assert(not pg_temp.send('files-2', pg_temp.request()) ? 'attachments',
	'An email without files lists none');
-- Not a file, unknown, twice, more than 10, not a path.
select pg_temp.path_commit(pg_temp.path_plan('dir-finance', 'finance', '{"path":"finance","kind":"directory"}'));
select pg_temp.send_error('files-bad-' || n, pg_temp.request(p_extra => jsonb_build_object('attachments', files)), state)
from (values (1, '["finance"]'::jsonb, '22023'), (2, '["missing.pdf"]', '22023'), (3, '["report.md","report.md"]', '22023'),
	(4, (select jsonb_agg('f' || part || '.pdf') from generate_series(1, 11) as part), '22023'), (5, '[7]', '22023'),
	(6, '"report.md"', '22023'), (7, jsonb_build_array(''), '22023'), (8, jsonb_build_array(repeat('a', 4097)), '22023'),
	(9, '["../outside.md"]', '42501')) as item(n, files, state);
-- At most 28 MiB in all.
select pg_temp.big_file('big.bin', 29360128 - 11);
select pg_temp.send_error('files-big', pg_temp.request(p_extra => '{"attachments":["report.md","totals.csv","big.bin"]}'),
	'54000');
select pg_temp.wake_assert(pg_temp.send('files-fit', pg_temp.request(p_extra => '{"attachments":["totals.csv","big.bin"]}'))
	->> 'status' = 'queued', 'Exactly 28 MiB fits');
-- A file the agent may not read: a member's private file.
select pg_temp.file('private.md', 'Only for the founder');
select pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_path_resource('30000000-0000-4000-8000-000000000020', 'private.md', 'exact',
	'member_private', 'normal');
reset role;
select pg_temp.path_claims('service_role');
select pg_temp.send_error('files-private', pg_temp.request(p_extra => '{"attachments":["private.md"]}'), '42501');
-- A file at the same path in another company's environment is not this company's.
insert into public.qorpera_company_path_entries(environment_id, path, entry)
values ('30000000-0000-4000-8000-0000000007a1', 'theirs-only.md',
	(current_setting('qorpera_test.report')::jsonb - 'version') || '{"path":"theirs-only.md"}');
select pg_temp.send_error('files-theirs', pg_temp.request(p_extra => '{"attachments":["theirs-only.md"]}'), '22023');
-- A file name a mail header cannot carry.
select pg_temp.file(repeat('n', 260) || '.md', 'long name');
select pg_temp.send_error('files-long-name', pg_temp.request(p_extra => jsonb_build_object('attachments',
	jsonb_build_array(repeat('n', 260) || '.md'))), '22023');

-- The worker's claim hands the files over with the company; a claim takes at most 64 MiB of them, and always one.
update public.qorpera_company_mail_outbox set status = 'cancelled', settled_at = clock_timestamp()
where status = 'pending' and call_id not in ('files-1', 'files-2', 'files-fit');
select set_config('qorpera_test.claim', public.qorpera_claim_company_mail(50, '80400000-0000-4000-8000-000000000011')::text,
	true);
select pg_temp.wake_assert(job -> 'companyId' = '"30000000-0000-4000-8000-000000000010"'::jsonb
		and job -> 'attachments' = jsonb_build_array(
			jsonb_build_object('filename', 'report.md',
				'manifestSha256', current_setting('qorpera_test.report')::jsonb #> '{file,manifestSha256}',
				'fileSha256', current_setting('qorpera_test.report')::jsonb #> '{file,fileSha256}', 'bytes', 17),
			jsonb_build_object('filename', 'totals.csv',
				'manifestSha256', current_setting('qorpera_test.sheet')::jsonb #> '{file,manifestSha256}',
				'fileSha256', current_setting('qorpera_test.sheet')::jsonb #> '{file,fileSha256}', 'bytes', 11)),
	'The claim hands the files over: ' || job::text)
from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) as item(job)
where job ->> 'mailId' = current_setting('qorpera_test.with_files')::jsonb ->> 'mailId';
select pg_temp.wake_assert(not job ? 'attachments' and not job ? 'companyId', 'An email without files has none')
from jsonb_array_elements(current_setting('qorpera_test.claim')::jsonb) as item(job)
where job ->> 'mailId' = (select id::text from public.qorpera_company_mail_outbox where call_id = 'files-2');
-- A claim carries at most 28 MiB of attachments: the 28 MiB email waits for the next one.
select pg_temp.wake_assert(jsonb_array_length(current_setting('qorpera_test.claim')::jsonb) = 2
		and public.qorpera_claim_company_mail(50, '80400000-0000-4000-8000-000000000012') -> 0 ->> 'mailId'
			= (select id::text from public.qorpera_company_mail_outbox where call_id = 'files-fit'),
	'An email of 28 MiB has a claim of its own');
-- Emails of 10, 10 and 28 MiB: a claim takes the first two (20 MiB), and the third waits.
update public.qorpera_company_mail_outbox set status = 'pending', lease_id = null, lease_expires_at = null,
	attempt_count = 0, next_attempt_at = clock_timestamp() - interval '1 minute',
	attachment_bytes = case when call_id = 'files-fit' then 29360128 else 10485760 end
where call_id in ('files-1', 'files-2', 'files-fit');
select pg_temp.wake_assert(jsonb_array_length(public.qorpera_claim_company_mail(50, '80400000-0000-4000-8000-000000000013')) = 2
	and jsonb_array_length(public.qorpera_claim_company_mail(50, '80400000-0000-4000-8000-000000000014')) = 1,
	'A claim carries at most 28 MiB of attachments');

-- Once the run has given its final answer, it saves no attachment.
select pg_temp.wake_public_send(current_setting('qorpera_test.routine_binding')::jsonb, 'final', 'attachments-final');
select pg_temp.ask_error(jsonb_build_object('deliveryId', current_setting('qorpera_test.gone'), 'attachment', 1),
	'55000', 'Wake public output is already final');

rollback;
