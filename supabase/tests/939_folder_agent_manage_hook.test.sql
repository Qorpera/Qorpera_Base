-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete, written by the member."
-- Company folder core C4, E3a (migration 20260930106000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5): an
-- agent's manage_hook opens an address hook or a mailbox for its company, and pauses, resumes or removes one. The request's
-- shape and E1's rules come before the run; then the wake's acknowledgement, then the requester's role (an owner or an
-- admin; a worker never). A replay answers from the receipt, with a hook's address read again from its row and never
-- stored; E1's caps, names and marks hold; another company's hook is never found; signed proofs wait for E3b. Runs are
-- 647's hand-built runs with their native rows.

create function pg_temp.e3a_hook(p_binding jsonb, p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_manage_hook(p_binding, p_request)
$$;
create function pg_temp.e3a_call(p_binding jsonb, p_request jsonb) returns text language sql as $$
	select format('select public.qorpera_folder_manage_hook(%L::jsonb, %L::jsonb)', p_binding, p_request)
$$;
create function pg_temp.e3a_create(p_key text, p_name text, p_purpose text default 'Orders from the shop wake the Analyst.',
	p_more jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('action', 'create', 'kind', 'hook', 'operationKey', p_key, 'name', p_name, 'purpose', p_purpose) || p_more
$$;
create function pg_temp.e3a_mailbox(p_key text, p_local_part text, p_purpose text default 'Sales mail from customers.')
returns jsonb language sql as $$
	select jsonb_build_object('action', 'create', 'kind', 'mailbox', 'operationKey', p_key, 'localPart', p_local_part,
		'purpose', p_purpose)
$$;
create function pg_temp.e3a_status(p_key text, p_action text, p_hook text) returns jsonb language sql as $$
	select jsonb_build_object('action', p_action, 'operationKey', p_key, 'hook', p_hook)
$$;
-- A human run of an agent for a requester, acknowledged unless told otherwise, kept under its name.
create function pg_temp.e3a_run(p_name text, p_staff uuid, p_requester uuid, p_ack boolean default true) returns jsonb
language plpgsql as $$
declare x jsonb := pg_temp.agent_run(p_staff, p_requester);
begin
	if p_ack then
		perform public.qorpera_folder_send_agent_message(x -> 'binding', 'e3a-ack-' || p_name, 'On it.', 'progress'); end if;
	perform set_config('qorpera_test.e3a_' || p_name, x::text, false);
	return x;
end $$;
create function pg_temp.e3a_binding(p_name text) returns jsonb language sql as $$
	select current_setting('qorpera_test.e3a_' || p_name)::jsonb -> 'binding'
$$;
-- The fixture company's hook of this name: the live one, else the newest.
create function pg_temp.e3a_row(p_name text) returns public.qorpera_event_hooks language sql as $$
	select * from public.qorpera_event_hooks where profile_id = '63400000-0000-4000-8000-000000000010' and name = p_name
	order by status = 'removed', created_at desc, id limit 1
$$;
create function pg_temp.e3a_marks(p_kind text, p_hook uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_connection_file_marks where subject_kind = p_kind and secret_id = p_hook
$$;
create function pg_temp.e3a_receipt(p_binding jsonb, p_key text) returns public.qorpera_run_operation_receipts language sql as $$
	select * from public.qorpera_run_operation_receipts where run_id = (p_binding ->> 'runId')::uuid
		and logical_operation_key = 'hook:' || p_key
$$;
create function pg_temp.e3a_receipts() returns bigint language sql as $$
	select count(*) from public.qorpera_run_operation_receipts where logical_operation_key like 'hook:%'
$$;

-- 0. No mail domain and no public URL yet; four runs: the owner's (not yet acknowledged), an admin's, a member's and a
-- viewer's.
update public.qorpera_mail_settings set domain = null;
update public.qorpera_event_intake_settings set public_url = null;
delete from public.qorpera_folder_connection_file_marks;

do $$
begin
	perform pg_temp.e3a_run('owner', '63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000001', false);
	perform pg_temp.e3a_run('admin', '63400000-0000-4000-8000-0000000000a2', '63400000-0000-4000-8000-000000000005');
	perform pg_temp.e3a_run('member', '63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000002');
	perform pg_temp.e3a_run('viewer', '63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000003');
end $$;

-- 1. The request: its shape, then E1's rules word for word, all before the run (the owner's run has no acknowledgement
-- yet) and before any receipt.
do $$
declare b jsonb := pg_temp.e3a_binding('owner'); v_request text;
begin
	foreach v_request in array array[
		null, '[]', '"x"', 'null', '{}',
		'{"action":"create","kind":"hook","name":"orders","purpose":"Orders."}',
		'{"action":"create","kind":"hook","operationKey":"-bad","name":"orders","purpose":"Orders."}',
		'{"action":"create","kind":"hook","operationKey":7,"name":"orders","purpose":"Orders."}',
		format('{"action":"pause","hook":"orders","operationKey":"%s"}', 'k' || repeat('x', 192)),
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders","purpose":"Orders.","address":"x"}',
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders"}',
		'{"action":"delete","hook":"orders","operationKey":"k1"}',
		'{"action":"create","kind":"webhook","operationKey":"k1","name":"orders","purpose":"Orders."}',
		'{"action":"create","kind":"mailbox","operationKey":"k1","name":"sales","purpose":"Sales."}',
		'{"action":"create","kind":"mailbox","operationKey":"k1","localPart":"sales","purpose":"Sales.","proof":"address"}',
		'{"action":"create","kind":"mailbox","operationKey":"k1","localPart":"sales","purpose":"Sales.","perMinute":5}',
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders","purpose":"Orders.","maxBodyBytes":"2048"}',
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders","purpose":"Orders.","maxBodyBytes":1.5}',
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders","purpose":"Orders.","maxBodyBytes":10000000000}',
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders","purpose":"Orders.","perMinute":-1}',
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders","purpose":"Orders.","proof":null}',
		'{"action":"create","kind":"hook","operationKey":"k1","name":"orders","purpose":["Orders."]}',
		'{"action":"pause","name":"orders","operationKey":"k1"}',
		'{"action":"pause","kind":"hook","hook":"orders","operationKey":"k1"}',
		'{"action":"pause","hook":"orders","operationKey":"k1","proof":"address"}',
		'{"action":"remove","hook":5,"operationKey":"k1"}'
	] loop
		perform pg_temp.raises_like(pg_temp.e3a_call(b, v_request::jsonb), '22023', 'Hook request is invalid');
	end loop;
end $$;

do $$
declare b jsonb := pg_temp.e3a_binding('owner'); v record;
	c_name constant text := 'A hook name uses lowercase letters, digits and hyphens, starts with a letter and has at most 64 characters';
	c_purpose constant text := 'A hook needs a purpose of one line, 1 to 512 characters';
	c_box constant text := 'A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores';
	c_box_purpose constant text := 'A mailbox purpose is one line of at most 512 characters';
begin
	for v in select * from (values
		(pg_temp.e3a_create('k1', 'Orders'), '22023', c_name),
		(pg_temp.e3a_create('k1', '9orders'), '22023', c_name),
		(pg_temp.e3a_create('k1', 'mail-orders'), '22023', c_name),
		(pg_temp.e3a_create('k1', 'o' || repeat('x', 64)), '22023', c_name),
		(pg_temp.e3a_create('k1', 'orders', '   '), '22023', c_purpose),
		(pg_temp.e3a_create('k1', 'orders', 'Orders' || chr(10) || 'and refunds.'), '22023', c_purpose),
		(pg_temp.e3a_create('k1', 'orders', repeat('p', 513)), '22023', c_purpose),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"proof":"carrier-pigeon"}'), '22023',
			'A hook is proven by its address, or by a Stripe, GitHub or HMAC-SHA256 signature'),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"proof":"stripe"}'), '0A000', 'A signed hook comes later; use an address hook for now'),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"proof":"github"}'), '0A000', 'A signed hook comes later; use an address hook for now'),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"proof":"hmac-sha256"}'), '0A000',
			'A signed hook comes later; use an address hook for now'),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"maxBodyBytes":1023}'), '22023', 'A hook body limit is between 1 KiB and 256 KiB'),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"maxBodyBytes":262145}'), '22023', 'A hook body limit is between 1 KiB and 256 KiB'),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"perMinute":0}'), '22023', 'A hook accepts between 1 and 120 deliveries a minute'),
		(pg_temp.e3a_create('k1', 'orders', 'Orders.', '{"perMinute":121}'), '22023', 'A hook accepts between 1 and 120 deliveries a minute'),
		(pg_temp.e3a_mailbox('k1', 'Sales'), '22023', c_box),
		(pg_temp.e3a_mailbox('k1', 'a..b'), '22023', c_box),
		(pg_temp.e3a_mailbox('k1', '.sales'), '22023', c_box),
		(pg_temp.e3a_mailbox('k1', 'sales.'), '22023', c_box),
		(pg_temp.e3a_mailbox('k1', 'postmaster'), '22023', 'This mailbox name is reserved'),
		(pg_temp.e3a_mailbox('k1', 'no-reply'), '22023', 'This mailbox name is reserved'),
		(pg_temp.e3a_mailbox('k1', 'q0rpera'), '22023', 'A mailbox name that reads as Qorpera is reserved'),
		(pg_temp.e3a_mailbox('k1', 'team-qorpera'), '22023', 'A mailbox name that reads as Qorpera is reserved'),
		(pg_temp.e3a_mailbox('k1', 'sales', ''), '22023', c_box_purpose),
		(pg_temp.e3a_mailbox('k1', 'sales', repeat('p', 513)), '22023', c_box_purpose),
		(pg_temp.e3a_mailbox('k1', 'sales', 'Sales' || chr(9) || 'mail.'), '22023', c_box_purpose),
		(pg_temp.e3a_status('k1', 'pause', 'Bad Name'), 'P0002', 'No hook has this name'),
		(pg_temp.e3a_status('k1', 'remove', ''), 'P0002', 'No hook has this name')
	) t(request, state, message) loop
		perform pg_temp.raises_like(pg_temp.e3a_call(b, v.request), v.state, v.message);
	end loop;
	if pg_temp.e3a_receipts() <> 0 then raise exception 'A refused request leaves a receipt'; end if;
end $$;

-- 2. The wake's acknowledgement comes first, as for every governed effect.
do $$
declare b jsonb := pg_temp.e3a_binding('owner');
begin
	perform pg_temp.raises_like(pg_temp.e3a_call(b, pg_temp.e3a_create('e3a-create-0001', 'orders')), '55000',
		'Wake requires an acknowledgement before work');
	perform public.qorpera_folder_send_agent_message(b, 'e3a-ack-owner', 'On it.', 'progress');
end $$;

-- 3. Authority: the requester is an owner or an admin; a worker never opens a hook, whoever asked.
do $$
declare o jsonb := current_setting('qorpera_test.e3a_owner')::jsonb; w uuid; p jsonb;
begin
	perform pg_temp.raises_like(pg_temp.e3a_call(pg_temp.e3a_binding('member'), pg_temp.e3a_create('e3a-create-0001', 'orders')),
		'42501', 'Only owners and admins can open hooks; ask one of them');
	perform pg_temp.raises_like(pg_temp.e3a_call(pg_temp.e3a_binding('viewer'), pg_temp.e3a_mailbox('e3a-mailbox-0001', 'sales')),
		'42501', 'Only owners and admins can open hooks; ask one of them');
	w := pg_temp.worker('63400000-0000-4000-8000-0000000000a1', o -> 'actor', 'in-house', 'write');
	p := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'agent', '63400000-0000-4000-8000-000000000001', 'worker-dispatch',
		o -> 'actor', w);
	perform pg_temp.fx(format('update public.qorpera_runtime_workers set occurrence_id = (select id from public.qorpera_wake_occurrences
		where run_id = %L) where id = %L', p ->> 'runId', w));
	perform pg_temp.raises_like(pg_temp.e3a_call(pg_temp.native(p), pg_temp.e3a_create('e3a-create-0001', 'orders')), '42501',
		'Hook authority is unavailable');
	if pg_temp.e3a_receipts() <> 0 or (pg_temp.e3a_row('orders')).id is not null then
		raise exception 'A refused agent opens nothing'; end if;
end $$;

-- 4. The owner's agent opens an address hook: the answer carries the address and path, read from the row; the receipt
-- keeps the hook without them; the file is marked once; a replay answers the first answer.
do $$
declare b jsonb := pg_temp.e3a_binding('owner'); r jsonb; h public.qorpera_event_hooks; c public.qorpera_run_operation_receipts;
begin
	r := pg_temp.e3a_hook(b, pg_temp.e3a_create('e3a-create-0001', 'orders', '  Orders from the shop wake the Analyst.  '));
	h := pg_temp.e3a_row('orders');
	if r ->> 'schema' <> 'qorpera.agent-hook-receipt/v1' or r ->> 'runId' <> b ->> 'runId' or r ->> 'action' <> 'create'
		or r -> 'hook' <> public.qorpera_event_hook_descriptor(h, true) or (r -> 'hook') ? 'url' or (r -> 'hook') ? 'email' then
		raise exception 'The owner''s agent opens a hook: %', r; end if;
	if h.purpose <> 'Orders from the shop wake the Analyst.' or h.proof <> 'address' or h.status <> 'active'
		or h.max_body_bytes <> 65536 or h.per_minute <> 60 or h.environment_id <> '63400000-0000-4000-8000-000000000020'
		or h.created_by_staff_agent_id <> '63400000-0000-4000-8000-0000000000a1' or h.created_by_user_id is not null then
		raise exception 'The hook''s row: %', to_jsonb(h); end if;
	if pg_temp.e3a_marks('hook', h.id) <> 1 or pg_temp.e3a_marks('mailbox', h.id) <> 0 then
		raise exception 'The new hook marks its file once'; end if;
	c := pg_temp.e3a_receipt(b, 'e3a-create-0001');
	if c.status <> 'completed' or c.operation_kind <> 'cloud_tool' or c.id <> (r ->> 'receiptId')::uuid
		or c.result <> (r || jsonb_build_object('hook', public.qorpera_event_hook_descriptor(h, false)))
		or strpos(c.result::text, h.address) > 0 then
		raise exception 'The receipt keeps the hook without its address: %', to_jsonb(c); end if;
	-- The same request in other words (the purpose trimmed, the defaults spelled out) is the same request.
	if pg_temp.e3a_hook(b, pg_temp.e3a_create('e3a-create-0001', 'orders', '  Orders from the shop wake the Analyst.  ')) <> r
		or pg_temp.e3a_hook(b, pg_temp.e3a_create('e3a-create-0001', 'orders', 'Orders from the shop wake the Analyst.',
			'{"proof":"address","maxBodyBytes":65536,"perMinute":60}')) <> r then
		raise exception 'A replay answers the first answer'; end if;
	if (select count(*) from public.qorpera_event_hooks where name = 'orders') <> 1 or pg_temp.e3a_marks('hook', h.id) <> 1 then
		raise exception 'A replay opens nothing'; end if;
	perform pg_temp.raises_like(pg_temp.e3a_call(b, pg_temp.e3a_create('e3a-create-0001', 'orders-two')), '23505',
		'logical operation key is already bound to other work');
	perform pg_temp.raises_like(pg_temp.e3a_call(b, pg_temp.e3a_create('e3a-create-0002', 'orders')), '23505',
		'A hook with this name already exists');
	if (pg_temp.e3a_receipt(b, 'e3a-create-0002')).id is not null then
		raise exception 'A taken name leaves no receipt'; end if;
	perform set_config('qorpera_test.e3a_orders', h.id::text, false);
end $$;

-- With the intake's public URL, an answer carries the hook's URL too.
update public.qorpera_event_intake_settings set public_url = 'https://hooks.example.test';

do $$
declare r jsonb := pg_temp.e3a_hook(pg_temp.e3a_binding('owner'),
	pg_temp.e3a_create('e3a-create-0001', 'orders', 'Orders from the shop wake the Analyst.'));
	h public.qorpera_event_hooks := pg_temp.e3a_row('orders');
begin
	if r -> 'hook' <> public.qorpera_event_hook_descriptor(h, true)
		|| jsonb_build_object('url', 'https://hooks.example.test/functions/v1/event-intake/' || h.address) then
		raise exception 'The answer''s URL: %', r; end if;
end $$;

-- 5. An admin's agent opens one with its own limits.
do $$
declare r jsonb; h public.qorpera_event_hooks;
begin
	r := pg_temp.e3a_hook(pg_temp.e3a_binding('admin'), pg_temp.e3a_create('e3a-create-0003', 'deploys',
		'Deploys from CI wake the Ops agent.', '{"proof":"address","maxBodyBytes":2048,"perMinute":5}'));
	h := pg_temp.e3a_row('deploys');
	if h.max_body_bytes <> 2048 or h.per_minute <> 5 or h.created_by_staff_agent_id <> '63400000-0000-4000-8000-0000000000a2'
		or r -> 'hook' <> public.qorpera_event_hook_descriptor(h, true)
			|| jsonb_build_object('url', 'https://hooks.example.test/functions/v1/event-intake/' || h.address) then
		raise exception 'An admin''s agent opens a hook: %', r; end if;
end $$;

-- 6. Mailboxes: none before company mail is set up; then E1's name, limits and mark, its email address in the answer and
-- the receipt alike, never a hook address.
do $$
declare b jsonb := pg_temp.e3a_binding('owner');
begin
	perform pg_temp.raises_like(pg_temp.e3a_call(b, pg_temp.e3a_mailbox('e3a-mailbox-0001', 'sales')), '0A000',
		'Company mail is not set up yet');
	if (pg_temp.e3a_receipt(b, 'e3a-mailbox-0001')).id is not null then
		raise exception 'A mailbox without company mail leaves no receipt'; end if;
end $$;

update public.qorpera_mail_settings set domain = 'inbox.example.test';

do $$
declare b jsonb := pg_temp.e3a_binding('owner'); r jsonb; h public.qorpera_event_hooks; v_box public.qorpera_company_mailboxes;
	v_name text := 'mail-team-sales-eu-' || left(encode(extensions.digest('team.sales_eu'::text, 'sha256'), 'hex'), 6);
begin
	r := pg_temp.e3a_hook(b, pg_temp.e3a_mailbox('e3a-mailbox-0001', 'sales', ' Sales mail from customers. '));
	h := pg_temp.e3a_row('mail-sales');
	select * into v_box from public.qorpera_company_mailboxes where hook_id = h.id;
	if h.proof <> 'mail' or h.max_body_bytes <> 262144 or h.per_minute <> 120 or h.purpose <> 'Sales mail from customers.'
		or h.created_by_staff_agent_id <> '63400000-0000-4000-8000-0000000000a1' or h.created_by_user_id is not null
		or v_box.local_part <> 'sales' or v_box.created_by_user_id is not null or v_box.removed_at is not null
		or v_box.profile_id <> h.profile_id or v_box.environment_id <> h.environment_id then
		raise exception 'The mailbox''s rows: %, %', to_jsonb(h), to_jsonb(v_box); end if;
	if r -> 'hook' <> public.qorpera_event_hook_descriptor(h, false) or r -> 'hook' ->> 'email' <> 'sales@inbox.example.test'
		or (r -> 'hook') ?| array['address', 'path', 'url'] or strpos(r::text, h.address) > 0
		or (pg_temp.e3a_receipt(b, 'e3a-mailbox-0001')).result <> r then
		raise exception 'The mailbox''s answer: %', r; end if;
	if pg_temp.e3a_marks('mailbox', h.id) <> 1 or pg_temp.e3a_marks('hook', h.id) <> 0 then
		raise exception 'The new mailbox marks its file once, as a mailbox'; end if;
	if pg_temp.e3a_hook(b, pg_temp.e3a_mailbox('e3a-mailbox-0001', 'sales', 'Sales mail from customers.')) <> r then
		raise exception 'A mailbox''s replay answers the first answer'; end if;
	perform pg_temp.raises_like(pg_temp.e3a_call(pg_temp.e3a_binding('admin'), pg_temp.e3a_mailbox('e3a-mailbox-0002', 'sales')),
		'23505', 'This address is taken');
	-- A local part that is no hook name takes E1's short digest.
	r := pg_temp.e3a_hook(b, pg_temp.e3a_mailbox('e3a-mailbox-0003', 'team.sales_eu', 'Sales mail from Europe.'));
	if r -> 'hook' ->> 'name' <> v_name or r -> 'hook' ->> 'email' <> 'team.sales_eu@inbox.example.test'
		or (pg_temp.e3a_row(v_name)).id is null then
		raise exception 'A dotted mailbox''s name: %', r; end if;
end $$;

-- 7. The caps, under E1's per-company claim: 50 live hooks (mailboxes count), 20 live mailboxes.
do $$
declare b jsonb := pg_temp.e3a_binding('owner');
begin
	insert into public.qorpera_event_hooks(profile_id, environment_id, name, purpose, proof, address)
	select '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'filler-' || n, 'Filler.', 'address',
		rpad(md5('filler' || n), 43, 'f')
	from generate_series(1, 50 - (select count(*)::integer from public.qorpera_event_hooks
		where profile_id = '63400000-0000-4000-8000-000000000010' and status <> 'removed')) n;
	perform pg_temp.raises_like(pg_temp.e3a_call(b, pg_temp.e3a_create('e3a-create-0004', 'one-more')), '54000',
		'A company has at most 50 hooks');
	perform pg_temp.raises_like(pg_temp.e3a_call(b, pg_temp.e3a_mailbox('e3a-mailbox-0004', 'one-more')), '54000',
		'A company has at most 50 hooks');
	update public.qorpera_event_hooks set status = 'removed', removed_at = clock_timestamp() where name like 'filler-%';
	with box as (
		insert into public.qorpera_event_hooks(profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute)
		select '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'mail-filler-' || n, 'Filler.', 'mail',
			rpad(md5('mail-filler' || n), 43, 'f'), 262144, 120
		from generate_series(1, 20 - (select count(*)::integer from public.qorpera_company_mailboxes
			where profile_id = '63400000-0000-4000-8000-000000000010' and removed_at is null)) n
		returning id, profile_id, environment_id, name)
	insert into public.qorpera_company_mailboxes(hook_id, profile_id, environment_id, local_part)
	select id, profile_id, environment_id, substr(name, 6) from box;
	perform pg_temp.raises_like(pg_temp.e3a_call(b, pg_temp.e3a_mailbox('e3a-mailbox-0004', 'one-more')), '54000',
		'A company has at most 20 mailboxes');
	update public.qorpera_event_hooks set status = 'removed', removed_at = clock_timestamp() where name like 'mail-filler-%';
	delete from public.qorpera_folder_connection_file_marks
	where secret_id in (select id from public.qorpera_event_hooks where name like 'filler-%' or name like 'mail-filler-%');
	if (pg_temp.e3a_receipt(b, 'e3a-create-0004')).id is not null or (pg_temp.e3a_receipt(b, 'e3a-mailbox-0004')).id is not null then
		raise exception 'A cap leaves no receipt'; end if;
end $$;

-- 8. Pause, resume and remove, by name: a change marks the file, no change marks nothing; a removed hook says so; a new
-- hook of the name is the one found; a mailbox is removed with its hook, which frees its address; another company's hook
-- is never found.
do $$
declare a jsonb := pg_temp.e3a_binding('admin'); o jsonb := pg_temp.e3a_binding('owner'); r jsonb; r2 jsonb;
	v_id uuid := current_setting('qorpera_test.e3a_orders')::uuid; h public.qorpera_event_hooks; v_box uuid;
begin
	r := pg_temp.e3a_hook(a, pg_temp.e3a_status('e3a-pause-0001', 'pause', 'orders'));
	select * into h from public.qorpera_event_hooks where id = v_id;
	if h.status <> 'paused' or r ->> 'action' <> 'pause' or r -> 'hook' <> public.qorpera_event_hook_descriptor(h, false)
		or strpos(r::text, h.address) > 0 or pg_temp.e3a_marks('hook', v_id) <> 2 then
		raise exception 'An admin''s agent pauses a hook: %', r; end if;
	if pg_temp.e3a_hook(a, pg_temp.e3a_status('e3a-pause-0001', 'pause', 'orders')) <> r then
		raise exception 'A pause''s replay answers the first answer'; end if;
	r2 := pg_temp.e3a_hook(a, pg_temp.e3a_status('e3a-pause-0002', 'pause', 'orders'));
	if r2 -> 'hook' ->> 'status' <> 'paused' or pg_temp.e3a_marks('hook', v_id) <> 2 then
		raise exception 'A paused hook''s pause changes nothing: %', r2; end if;
	r := pg_temp.e3a_hook(a, pg_temp.e3a_status('e3a-resume-0001', 'resume', 'orders'));
	if r -> 'hook' ->> 'status' <> 'active' or (select status from public.qorpera_event_hooks where id = v_id) <> 'active'
		or pg_temp.e3a_marks('hook', v_id) <> 3 then
		raise exception 'An admin''s agent resumes a hook: %', r; end if;
	perform pg_temp.raises_like(pg_temp.e3a_call(pg_temp.e3a_binding('member'), pg_temp.e3a_status('e3a-pause-0003', 'pause', 'orders')),
		'42501', 'Only owners and admins can open hooks; ask one of them');
	perform pg_temp.raises_like(pg_temp.e3a_call(a, pg_temp.e3a_status('e3a-pause-0004', 'pause', 'nothing-here')), 'P0002',
		'No hook has this name');
	r := pg_temp.e3a_hook(a, pg_temp.e3a_status('e3a-remove-0001', 'remove', 'orders'));
	select * into h from public.qorpera_event_hooks where id = v_id;
	if h.status <> 'removed' or h.removed_at is null or r -> 'hook' ->> 'status' <> 'removed' or pg_temp.e3a_marks('hook', v_id) <> 4 then
		raise exception 'An admin''s agent removes a hook: %', r; end if;
	perform pg_temp.raises_like(pg_temp.e3a_call(a, pg_temp.e3a_status('e3a-resume-0002', 'resume', 'orders')), '55000',
		'This hook was removed');
	-- The creation's replay shows the address only while the hook is live.
	r := pg_temp.e3a_hook(o, pg_temp.e3a_create('e3a-create-0001', 'orders', 'Orders from the shop wake the Analyst.'));
	if (r -> 'hook') ?| array['address', 'path', 'url'] or (r -> 'hook' ->> 'id')::uuid <> v_id then
		raise exception 'A removed hook''s creation replays without its address: %', r; end if;
	r := pg_temp.e3a_hook(o, pg_temp.e3a_create('e3a-create-0005', 'orders', 'Orders again.'));
	r2 := pg_temp.e3a_hook(a, pg_temp.e3a_status('e3a-pause-0005', 'pause', 'orders'));
	if (r -> 'hook' ->> 'id')::uuid = v_id or r2 -> 'hook' ->> 'id' <> r -> 'hook' ->> 'id' or r2 -> 'hook' ->> 'status' <> 'paused' then
		raise exception 'A new hook of the name is the one found: %, %', r, r2; end if;
	-- A mailbox's hook removed: the address is free again.
	r := pg_temp.e3a_hook(o, pg_temp.e3a_status('e3a-remove-0002', 'remove', 'mail-sales'));
	v_box := (r -> 'hook' ->> 'id')::uuid;
	if (select removed_at from public.qorpera_company_mailboxes where hook_id = v_box) is null then
		raise exception 'A mailbox is removed with its hook'; end if;
	r := pg_temp.e3a_hook(o, pg_temp.e3a_mailbox('e3a-mailbox-0005', 'sales', 'Sales mail again.'));
	if (r -> 'hook' ->> 'id')::uuid = v_box or r -> 'hook' ->> 'name' <> 'mail-sales' or r -> 'hook' ->> 'email' <> 'sales@inbox.example.test' then
		raise exception 'A freed address opens again: %', r; end if;
	-- Another company's hook of a name is not this company's.
	insert into public.qorpera_event_hooks(profile_id, environment_id, name, purpose, proof, address)
	values ('64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021', 'elsewhere', 'Another company''s hook.',
		'address', rpad(md5('elsewhere'), 43, 'f'));
	perform pg_temp.raises_like(pg_temp.e3a_call(o, pg_temp.e3a_status('e3a-pause-0006', 'pause', 'elsewhere')), 'P0002',
		'No hook has this name');
	if (select status from public.qorpera_event_hooks where name = 'elsewhere') <> 'active' then
		raise exception 'Another company''s hook is untouched'; end if;
end $$;

-- 9. The grants, the native host's call, the observation's tool name and the marker; no receipt holds an address.
do $$
declare c_fn constant text := 'public.qorpera_folder_manage_hook(jsonb,jsonb)';
begin
	if has_function_privilege('anon', c_fn, 'execute') or has_function_privilege('authenticated', c_fn, 'execute')
		or not has_function_privilege('service_role', c_fn, 'execute') then
		raise exception 'Only the service runs manage_hook'; end if;
	if not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_folder_manage_hook' and scope = 'binding'
		and budget = 'standard') then
		raise exception 'The native host calls manage_hook with the binding''s scope'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
		'''manage_hook'' /* 20260930106000 (E3a) */') = 0
		or strpos((select prosrc from pg_proc where oid = c_fn::regprocedure), '20260930106000') = 0 then
		raise exception 'The observation names the tool; the bodies carry the marker'; end if;
	if exists (select 1 from public.qorpera_run_operation_receipts as receipt join public.qorpera_event_hooks as hook
		on strpos(receipt.result::text, hook.address) > 0 where receipt.logical_operation_key like 'hook:%') then
		raise exception 'A receipt holds a hook''s address'; end if;
	-- Twelve answered requests: three creations, three mailboxes, six changes of status.
	if pg_temp.e3a_receipts() <> 12 then
		raise exception 'The receipts: %', pg_temp.e3a_receipts(); end if;
end $$;

rollback;
