-- @fixture 960_memory_message_erase.test.sql until "-- 3. Step 1"
-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10 step 4; 20260930441000): the run table and the
-- scrub. Which read receipts step 1 counts as reading message 5 (i = 5; its blocks' window is 0 to 31), at the edge of
-- each rule; a receipt stored after step 1; and the scrub of each kind of run: queued, with a card answered and not yet
-- used, with a card that never asked, with a call still executing, with a receipt scrubbed before. On 960's tree and
-- request, beside its runs A to D.

-- A call still executing: no result yet.
create function pg_temp.op_executing(p_run uuid, p_call text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status)
	select v_id, p_run, r.job_id, (select x.id from public.qorpera_runner_assignments x where x.run_id = p_run), p_call, 'cloud_tool',
		repeat('a', 64), repeat('e', 64), 'executing'
	from public.qorpera_execution_runs r where r.id = p_run;
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.card(p_run uuid, p_call text, p_decision text) returns void language sql as $$
	insert into public.qorpera_action_reviews(profile_id, run_id, call_id, staff_agent_id, tool_name, effect, argument_sha256,
		action, decision, built_in, reason, reviewer_model, approver_scope)
	values ('70000000-0000-4000-8000-000000000010', p_run, p_call, '70000000-0000-4000-8000-0000000000c0', 'send_mail', 'external',
		repeat('2', 64), '{"title":"Mail"}', p_decision, 'none', 'Ask first.', 'test',
		case when p_decision = 'ask' then 'owners_admins' end)
$$;
create function pg_temp.op_ctid(p_run uuid, p_call text) returns text language sql as $$
	select ctid::text from public.qorpera_run_operation_receipts where run_id = p_run and logical_operation_key = p_call
$$;

-- 1. More runs before step 1, each read at an edge of its rule -------------------------------------------------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0');
	e constant uuid := '96300000-0000-4000-8000-0000000000e1'; f constant uuid := '96300000-0000-4000-8000-0000000000f1';
	g constant uuid := '96300000-0000-4000-8000-0000000000a7'; h constant uuid := '96300000-0000-4000-8000-0000000000a8';
	i constant uuid := '96300000-0000-4000-8000-0000000000a9'; j constant uuid := '96300000-0000-4000-8000-0000000000aa';
	k constant uuid := '96300000-0000-4000-8000-0000000000ab';
begin
	-- E, ended. A zoom of a single line reads message 5 only as its own line (5+1); a zoom of more reads it when it starts
	-- inside its blocks' window (before 32) and ends after it. A read_context page reads it when it holds it; an empty
	-- page at 5 reads it.
	perform pg_temp.run(e, false);
	perform pg_temp.read(e, 'e-z1', 'zoom', pg_temp.op(e, 'e-z1'), 31, 2, s);
	perform pg_temp.read(e, 'e-z2', 'zoom', pg_temp.op(e, 'e-z2'), 32, 2, s);
	perform pg_temp.read(e, 'e-z3', 'zoom', pg_temp.op(e, 'e-z3'), 0, 6, s);
	perform pg_temp.read(e, 'e-z4', 'zoom', pg_temp.op(e, 'e-z4'), 0, 5, s);
	perform pg_temp.read(e, 'e-z5', 'zoom', pg_temp.op(e, 'e-z5'), 6, 1, s);
	perform pg_temp.read(e, 'e-z6', 'zoom', pg_temp.op(e, 'e-z6'), 4, 1, s);
	perform pg_temp.read(e, 'e-z7', 'zoom', pg_temp.op(e, 'e-z7'), 5, 1, s);
	perform pg_temp.read(e, 'e-r1', 'read_context', pg_temp.op(e, 'e-r1'), 5, 0, s);
	perform pg_temp.read(e, 'e-r2', 'read_context', pg_temp.op(e, 'e-r2'), 6, 0, s);
	perform pg_temp.read(e, 'e-r3', 'read_context', pg_temp.op(e, 'e-r3'), 0, 5, s);
	perform pg_temp.read(e, 'e-r4', 'read_context', pg_temp.op(e, 'e-r4'), 0, 6, s);
	perform pg_temp.read(e, 'e-r5', 'read_context', pg_temp.op(e, 'e-r5'), 5, 1, s);
	perform pg_temp.read(e, 'e-r6', 'read_context', pg_temp.op(e, 'e-r6'), 4, 1, s);
	-- F, ended: only reads at the edges just outside.
	perform pg_temp.run(f, false);
	perform pg_temp.read(f, 'f-z', 'zoom', pg_temp.op(f, 'f-z'), 32, 8, s);
	perform pg_temp.read(f, 'f-r', 'read_context', pg_temp.op(f, 'f-r'), 6, 4, s);
	-- G, ended, its zoom of message 5 still executing (the run ended before it answered).
	perform pg_temp.run(g, false);
	perform pg_temp.read(g, 'g-z', 'zoom', pg_temp.op_executing(g, 'g-z'), 5, 1, s);
	-- H, queued again (not ended).
	perform pg_temp.run(h, false);
	perform pg_temp.read(h, 'h-z', 'zoom', pg_temp.op(h, 'h-z'), 5, 1, s);
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'queued', finished_at = null, last_error = null
	where id = (select job_id from public.qorpera_execution_runs where id = h);
	set local session_replication_role = origin;
	-- I, ended, its card answered allow once and not yet used: the run may still act on it.
	perform pg_temp.run(i, false);
	perform pg_temp.read(i, 'i-z', 'zoom', pg_temp.op(i, 'i-z'), 5, 1, s);
	perform pg_temp.card(i, 'card-i', 'ask');
	update public.qorpera_action_reviews set answer = 'allow_once', answered_by_user_id = '70000000-0000-4000-8000-000000000001',
		answered_at = clock_timestamp()
	where run_id = i;
	-- J, ended, with a card its rules allowed (it never asked anyone).
	perform pg_temp.run(j, false);
	perform pg_temp.read(j, 'j-z', 'zoom', pg_temp.op(j, 'j-z'), 5, 1, s);
	perform pg_temp.card(j, 'card-j', 'allow');
	-- K, ended, its receipt scrubbed before (an earlier erase of a message on the same page).
	perform pg_temp.run(k, false);
	perform pg_temp.read(k, 'k-r', 'read_context', pg_temp.op(k, 'k-r'), 4, 2, s);
	set local session_replication_role = replica;
	update public.qorpera_run_operation_receipts set result = jsonb_set(result, '{content}', '{"kind":"text","value":"[erased]"}')
	where run_id = k;
	set local session_replication_role = origin;
end $$;

-- 2. Step 1: the run table holds each run with a receipt that read message 5, with just those receipts ----------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0');
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); r jsonb;
	e constant uuid := '96300000-0000-4000-8000-0000000000e1';
begin
	perform pg_temp.service();
	r := public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid);
	-- A, B and C of 960; E, G, H, I, J and K here.
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1","state":"open",'
		'"blocks":4,"runsPending":9}', 'Step 1 opens the erase');
	perform pg_temp.same(pg_temp.run_calls(e), '["e-r1","e-r4","e-r5","e-z1","e-z3","e-z7"]', 'E''s receipts in the table');
	perform pg_temp.same((select jsonb_object_agg(t.run_id, pg_temp.run_calls(t.run_id))
			from public.qorpera_memory_message_erase_runs t where t.erase_id = eid and t.run_id::text like '96300000-%'
				and t.run_id <> e),
		'{"96300000-0000-4000-8000-0000000000a7":["g-z"],"96300000-0000-4000-8000-0000000000a8":["h-z"],'
		'"96300000-0000-4000-8000-0000000000a9":["i-z"],"96300000-0000-4000-8000-0000000000aa":["j-z"],'
		'"96300000-0000-4000-8000-0000000000ab":["k-r"]}', 'The other runs in the table; F is not');
	if exists (select 1 from public.qorpera_memory_message_erase_runs t where t.erase_id = eid
			and (t.state <> 'pending' or t.scrubbed_at is not null
				or t.read_receipt_ids <> (select array_agg(x order by x) from unnest(t.read_receipt_ids) x))) then
		raise exception 'Each run waits for step 4, its receipts in order'; end if;
end $$;

-- 3. A receipt stored after step 1 is not the table's: its call read the message erased --------------------------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0');
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); r jsonb;
	e constant uuid := '96300000-0000-4000-8000-0000000000e1'; l constant uuid := '96300000-0000-4000-8000-0000000000ac';
begin
	perform pg_temp.service();
	perform pg_temp.run(l, false);
	perform pg_temp.read(l, 'l-z', 'zoom', pg_temp.op(l, 'l-z'), 5, 1, s);
	perform pg_temp.read(e, 'e-z8', 'zoom', pg_temp.op(e, 'e-z8'), 5, 1, s);
	r := public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r -> 'runsPending', '9','Step 1 runs once; the table stays');
	perform pg_temp.same(pg_temp.run_calls(l) || pg_temp.run_calls(e), '["e-r1","e-r4","e-r5","e-z1","e-z3","e-z7"]',
		'No later receipt joins the table');
end $$;

-- 4. Step 4 on each kind of run, after steps 2 and 3 ------------------------------------------------------------------

do $$
declare
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); r jsonb; n integer := 0; v_ctid text;
	a constant uuid := '96000000-0000-4000-8000-0000000000a1'; c constant uuid := '96000000-0000-4000-8000-0000000000c1';
	e constant uuid := '96300000-0000-4000-8000-0000000000e1'; f constant uuid := '96300000-0000-4000-8000-0000000000f1';
	g constant uuid := '96300000-0000-4000-8000-0000000000a7'; k constant uuid := '96300000-0000-4000-8000-0000000000ab';
begin
	perform pg_temp.service();
	perform pg_temp.same(pg_temp.rewrite(eid) -> 'state', '"rewritten"', 'Step 2');
	loop
		n := n + 1;
		r := public.qorpera_memory_message_erase_ask('70000000-0000-4000-8000-000000000020', eid);
		exit when r ->> 'state' = 'requested' or n > 8;
	end loop;
	perform pg_temp.same(r -> 'state', '"requested"', 'Step 3');
	v_ctid := pg_temp.op_ctid(k, 'k-r');
	r := public.qorpera_memory_message_erase_scrub('70000000-0000-4000-8000-000000000020', eid);
	-- A is live and H queued; B's card is open, and so is I's, answered and not yet used.
	perform pg_temp.same(r -> 'runsPending', '4', 'Step 4 leaves the runs that may still act');
	perform pg_temp.same((select jsonb_object_agg(t.run_id, t.state) from public.qorpera_memory_message_erase_runs t
			where t.erase_id = eid),
		'{"96000000-0000-4000-8000-0000000000a1":"pending","96000000-0000-4000-8000-0000000000b1":"pending",'
		'"96000000-0000-4000-8000-0000000000c1":"done","96300000-0000-4000-8000-0000000000e1":"done",'
		'"96300000-0000-4000-8000-0000000000a7":"done","96300000-0000-4000-8000-0000000000a8":"pending",'
		'"96300000-0000-4000-8000-0000000000a9":"pending","96300000-0000-4000-8000-0000000000aa":"done",'
		'"96300000-0000-4000-8000-0000000000ab":"done"}', 'The run table');
	-- E: each receipt in the table is scrubbed, each outside it (and the one after step 1) stays.
	perform pg_temp.same((select jsonb_object_agg(o.logical_operation_key, o.result #>> '{content,value}' = '[erased]')
			from public.qorpera_run_operation_receipts o where o.run_id = e),
		'{"e-r1":true,"e-r2":false,"e-r3":false,"e-r4":true,"e-r5":true,"e-r6":false,"e-z1":true,"e-z2":false,"e-z3":true,'
		'"e-z4":false,"e-z5":false,"e-z6":false,"e-z7":true,"e-z8":false}', 'E''s receipts');
	perform pg_temp.same(jsonb_build_array(pg_temp.content(f, 'f-z'), pg_temp.content(f, 'f-r'),
			pg_temp.content('96300000-0000-4000-8000-0000000000ac', 'l-z'), pg_temp.content(a, 'zoom-a'),
			pg_temp.content('96300000-0000-4000-8000-0000000000a9', 'i-z'), pg_temp.content(c, 'zoom-c3'),
			pg_temp.content('96300000-0000-4000-8000-0000000000aa', 'j-z')),
		'["message 5 said f-z","message 5 said f-r","message 5 said l-z","message 5 said zoom-a","message 5 said i-z",'
		'"[erased]","[erased]"]', 'Only the ended runs'' receipts in the table are scrubbed');
	-- G's call never answered: there is nothing to scrub. K's was scrubbed before and is not written again.
	if exists (select 1 from public.qorpera_run_operation_receipts o where o.run_id = g
			and (o.status <> 'executing' or o.result is not null)) then
		raise exception 'An executing call stays as it is'; end if;
	perform pg_temp.same(to_jsonb(pg_temp.op_ctid(k, 'k-r')), to_jsonb(v_ctid), 'A scrubbed receipt is not written again');
	perform pg_temp.same(to_jsonb(pg_temp.content(k, 'k-r')), '"[erased]"', 'K stays scrubbed');
end $$;

-- 5. The rest end, the cards are answered or used, and the versions go: the erase is done ------------------------------

do $$
declare
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); r jsonb;
	a constant uuid := '96000000-0000-4000-8000-0000000000a1'; b constant uuid := '96000000-0000-4000-8000-0000000000b1';
	h constant uuid := '96300000-0000-4000-8000-0000000000a8'; i constant uuid := '96300000-0000-4000-8000-0000000000a9';
begin
	perform pg_temp.service();
	-- H runs again and ends; I uses its answer. A and B stay as they are: still pending.
	perform pg_temp.end_run(h);
	update public.qorpera_action_reviews set consumed_at = clock_timestamp(), consumed_run_id = i where run_id = i;
	r := public.qorpera_memory_message_erase_scrub('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r -> 'runsPending', '2', 'H and I scrubbed');
	perform pg_temp.same(jsonb_build_array(pg_temp.content(h, 'h-z'), pg_temp.content(i, 'i-z'), pg_temp.content(a, 'zoom-a')),
		'["[erased]","[erased]","message 5 said zoom-a"]', 'H and I scrubbed, A not');
	perform pg_temp.end_run(a);
	update public.qorpera_action_reviews set answer = 'deny', answered_by_user_id = '70000000-0000-4000-8000-000000000001',
		answered_at = clock_timestamp()
	where run_id = b;
	set local session_replication_role = replica;
	update public.qorpera_folder_erasures set phase = 2
	where id in (select x.erasure_id from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid) and phase = 1;
	set local session_replication_role = origin;
	r := public.qorpera_memory_message_erase_scrub('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1",'
		'"state":"done","blocks":4,"runsPending":0}', 'The erase is done');
	if exists (select 1 from public.qorpera_memory_message_erase_runs t where t.erase_id = eid
			and (t.state <> 'done' or t.scrubbed_at is null)) then
		raise exception 'Every run is done'; end if;
end $$;

rollback;
