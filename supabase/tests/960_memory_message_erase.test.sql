-- @fixture 700_folder_state_vision_agents.test.sql until "-- 2. The vision: a new name"
-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10; 20260930441000): a message's erase, steps 1 to 4.
-- The helpers; a request and its refusals; step 1 in one memory commit (the event and its input blanked, the candidate
-- blocks deleted with their other lines kept, the run table); step 2's plan and rewrite; step 3's block-history requests;
-- step 4's scrub of the receipts; the readers after an erase; and the privileges.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- A statement that must fail with this SQLSTATE.
create function pg_temp.fails(p_sql text, p_state text, p_what text) returns void language plpgsql as $$
declare v_state text; v_message text;
begin
	begin
		execute p_sql;
	exception when others then get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
	end;
	if v_state is distinct from p_state then
		raise exception '%: got % (%), want %', p_what, v_state, v_message, p_state using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)
$$;
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '70000000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;
create function pg_temp.ehash(p_seq bigint) returns text language sql immutable as $$
	select encode(extensions.digest('e' || p_seq, 'sha256'), 'hex')
$$;
-- Events 1 to n: 2 is not a message (session_info), 4 is a question, the rest are messages; event n is message n - 2
-- from 3 on. Each entry has its id e<n> and names e<n-1> as its parent.
create function pg_temp.events(p_session uuid, p_count integer) returns void language sql as $$
	insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
	select p_session, n, extensions.gen_random_uuid(),
		case n when 2 then 'session_info' when 4 then 'interaction_request' else 'message' end,
		'70000000-0000-4000-8000-000000000001',
		jsonb_build_object('entry', jsonb_build_object('n', n, 'id', 'e' || n, 'parentId', case when n > 1 then 'e' || (n - 1) end),
			'text', 'message ' || n),
		pg_temp.ehash(n), statement_timestamp() + n * interval '1 second'
	from generate_series(1, p_count) n
$$;
create function pg_temp.event(p_session uuid, p_seq bigint) returns public.qorpera_session_events language sql as $$
	select * from public.qorpera_session_events where session_id = p_session and sequence = p_seq
$$;
create function pg_temp.toml(p_session uuid, p_bytes integer default 1024) returns text language sql as $$
	select format(E'format = 1\nconversation = "%s"\nnode_bytes = %s\n', p_session, p_bytes)
$$;
create function pg_temp.line0(p_k bigint, p_seq bigint, p_text text default 'said') returns text language sql as $$
	select format('{"l":0,"k":%s,"seq":%s,"hash":"%s","free":true,"text":"%s"}', p_k, p_seq, pg_temp.ehash(p_seq), p_text)
$$;
create function pg_temp.line(p_l integer, p_k bigint, p_text text default 'summed up') returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"tries":1,"text":"%s"}', p_l, p_k, p_text)
$$;
-- A line above level 0 as the erase writes it back (its keys in the index's order).
create function pg_temp.kept(p_l integer, p_k bigint, p_text text default 'summed up') returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"text":"%s","tries":1}', p_l, p_k, p_text)
$$;
create function pg_temp.block(p_lines text[]) returns text language sql as $$
	select array_to_string(p_lines, E'\n') || E'\n'
$$;
-- tree.toml as the platform stages it (application/toml), or a block (text/markdown, the fixture's).
create function pg_temp.toml_file(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,
		'file',pg_temp.seal_v2('70000000-0000-4000-8000-000000000020', '{"kind":"platform"}',
			replace(pg_temp.manifest_v2(p_text), '"text/markdown"', '"application/toml"')) -> 'file',
		'structured', jsonb_build_array(pg_temp.entry(p_path, 'memory-tree', p_text, '{"kind":"memory-tree"}')))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.block_file(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select pg_temp.write(p_path, 'memory-block', p_text, '{"kind":"memory-block"}', p_expected)
$$;
create function pg_temp.memory(p_key text, p_units jsonb, p_sessions uuid[]) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('70000000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', coalesce((select jsonb_agg(jsonb_build_object('sessionId', s.id,
			'generation', s.memory_generation) order by u.o)
			from unnest(p_sessions) with ordinality u(id, o) join public.qorpera_shared_sessions s on s.id = u.id), '[]'::jsonb)))
$$;
create function pg_temp.nodes(p_session uuid) returns text language sql as $$
	select coalesce(string_agg(n.l || ':' || n.k || ':' || coalesce(n.seq::text, '-'), ',' order by n.l, n.k), '')
	from public.qorpera_memory_tree_nodes n
	where n.environment_id = '70000000-0000-4000-8000-000000000020' and n.session_id = p_session
$$;
create function pg_temp.erase(p_id uuid) returns public.qorpera_memory_message_erases language sql as $$
	select * from public.qorpera_memory_message_erases where id = p_id
$$;
-- An erase's blocks as rel:kind:keep(l:k, ...):cutoff?, by key.
create function pg_temp.blocks(p_id uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(substr(b.block_key, length(e.root_key) + 2) || ':' || b.kind || ':'
		|| coalesce((select string_agg((x ->> 'l') || '.' || (x ->> 'k'), ' ' order by (x ->> 'l')::integer, (x ->> 'k')::bigint)
			from jsonb_array_elements(b.keep) x), case when b.keep is null then '-' else '' end)
		|| ':' || case when b.cutoff_seq is null then 'key' else 'cut' end
		order by b.block_key collate "C"), '[]'::jsonb)
	from public.qorpera_memory_message_erase_blocks b join public.qorpera_memory_message_erases e on e.id = b.erase_id
	where b.erase_id = p_id
$$;
-- Step 2 as the runtime runs it: the plan, each text staged, the rewrite.
create function pg_temp.rewrite(p_id uuid) returns jsonb language plpgsql as $$
declare v_plan jsonb := public.qorpera_memory_message_erase_plan('70000000-0000-4000-8000-000000000020', p_id);
begin
	return public.qorpera_memory_message_erase_rewrite('70000000-0000-4000-8000-000000000020', p_id, v_plan ->> 'planSha256',
		coalesce((select jsonb_agg(jsonb_build_object('path', b ->> 'path', 'file', pg_temp.stage(b ->> 'text')) order by o)
			from jsonb_array_elements(v_plan -> 'blocks') with ordinality x(b, o)), '[]'::jsonb));
end $$;

-- 1. The helpers: an entry's id, the lines an erase drops, its candidate blocks, a line as the index holds it ----------

do $$
begin
	perform pg_temp.same(jsonb_build_array(
			public.qorpera_memory_entry_id('{"entry":{"id":"e7"}}', '70000000-0000-4000-8000-0000000000e7'),
			public.qorpera_memory_entry_id('{"erased":true}', '70000000-0000-4000-8000-0000000000e7'),
			public.qorpera_memory_entry_id('{"erased":true,"entry":{"id":"e7"}}', '70000000-0000-4000-8000-0000000000e7'),
			public.qorpera_memory_entry_id('{"text":"x"}', '70000000-0000-4000-8000-0000000000e7')),
		'["e7","70000000-0000-4000-8000-0000000000e7","e7",null]', 'An erased event''s entry id is its event id');
	-- Message 5: level 0 from 5 to 31, level 1 from 2 to 15, level 4 only 0 and 1. Message 20: from 20 to 47 at level 0,
	-- and no level-4 line before 1.
	perform pg_temp.same((select jsonb_agg(public.qorpera_memory_erase_drops(i, l, k) order by o) from (values
		(1, 5, 0, 4), (2, 5, 0, 5), (3, 5, 0, 31), (4, 5, 0, 32), (5, 5, 1, 1), (6, 5, 1, 2), (7, 5, 1, 15), (8, 5, 1, 16),
		(9, 5, 4, 0), (10, 5, 4, 1), (11, 5, 4, 2), (12, 5, 14, 0), (13, 20, 0, 19), (14, 20, 0, 47), (15, 20, 0, 48),
		(16, 20, 4, 0), (17, 20, 4, 1), (18, 0, 0, 0), (19, 15, 0, 31), (20, 16, 0, 15)) x(o, i, l, k)),
		'[false,true,true,false,false,true,true,false,true,true,false,true,false,true,false,false,true,true,true,false]',
		'The lines an erase drops');
	perform pg_temp.same((select jsonb_agg(rel order by block_key collate "C") from public.qorpera_memory_erase_candidates('r', 5)
		where rel ~ '^t[01]/'), '["t0/00000000.jsonl","t0/00000001.jsonl","t1/00000000.jsonl"]', 'Message 5''s candidates');
	perform pg_temp.same(to_jsonb((select count(*) from public.qorpera_memory_erase_candidates('r', 5))), '16', 'Two in tier 0, one above');
	perform pg_temp.same((select jsonb_agg(rel order by block_key collate "C") from public.qorpera_memory_erase_candidates('r', 40)
		where rel ~ '^t[01]/'), '["t0/00000002.jsonl","t0/00000003.jsonl","t1/00000000.jsonl"]', 'Message 40''s candidates');
	perform pg_temp.same(to_jsonb((select count(*) from public.qorpera_memory_erase_candidates(null, 5))), '0', 'No root, no candidates');
end $$;

-- 2. The Co-Founder's tree, and a request for message 5 (event 7) with its refusals -------------------------------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0'); root constant text := 'agents/co-founder/memory/thread';
	r jsonb; i integer; e7 uuid; e2 uuid;
begin
	perform pg_temp.events(s, 34);
	r := pg_temp.memory('m3-tree-1', jsonb_build_array(
		jsonb_build_object('op','mkdir','path',root),
		pg_temp.toml_file(root || '/tree.toml', pg_temp.toml(s)),
		jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.block_file(root || '/t0/00000000.jsonl', pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3),
			pg_temp.line0(2, 4), pg_temp.line0(3, 5), pg_temp.line0(4, 6), pg_temp.line0(5, 7), pg_temp.line0(6, 8),
			pg_temp.line(1, 0), pg_temp.line(1, 1), pg_temp.line(1, 2), pg_temp.line(2, 0), pg_temp.line(2, 1), pg_temp.line(3, 0)])),
		pg_temp.block_file(root || '/t0/00000001.jsonl', pg_temp.block(array[pg_temp.line0(16, 18), pg_temp.line(1, 8)])),
		pg_temp.block_file(root || '/t0/00000002.jsonl', pg_temp.block(array[pg_temp.line0(32, 34)])),
		jsonb_build_object('op','mkdir','path',root || '/t1'),
		pg_temp.block_file(root || '/t1/00000000.jsonl', pg_temp.block(array[pg_temp.line(4, 0)])),
		jsonb_build_object('op','mkdir','path',root || '/t2'),
		pg_temp.block_file(root || '/t2/00000000.jsonl', pg_temp.block(array[pg_temp.line(8, 0)]))), array[s]);
	for i in 1..10 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- A block deleted before the erase keeps its versions: step 3 asks it by key alone.
	r := pg_temp.memory('m3-tree-2', jsonb_build_array(jsonb_build_object('op','delete','path',root || '/t2/00000000.jsonl',
		'expectedVersion',pg_temp.version(root || '/t2/00000000.jsonl'))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)),
		'"0:0:1,0:1:3,0:2:4,0:3:5,0:4:6,0:5:7,0:6:8,0:16:18,0:32:34,1:0:-,1:1:-,1:2:-,1:8:-,2:0:-,2:1:-,3:0:-,4:0:-"', 'The tree');
	e7 := (pg_temp.event(s, 7)).event_id; e2 := (pg_temp.event(s, 2)).event_id;

	-- Only the folder core asks.
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, e7), '42501', 'Only the folder core');
	perform pg_temp.service();
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, null), '22023', 'A request names all four');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), e7),
		'P0002', 'No such conversation');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), s, e7), '42501', 'Not a member');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, e2), 'P0002', 'Not a message');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_request(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, extensions.gen_random_uuid()),
		'P0002', 'No such message');
	if exists (select 1 from public.qorpera_memory_message_erases) then raise exception 'A refusal leaves no row'; end if;

	r := public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001', s, e7);
	perform pg_temp.same(r - 'eraseId', jsonb_build_object('schema', 'qorpera.memory-message-erase/v1', 'state', 'pending',
		'sessionId', s, 'eventId', e7, 'blocks', 0, 'runsPending', 0), 'A request');
	perform pg_temp.same(public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020',
		'70000000-0000-4000-8000-000000000001', s, e7), r, 'A second request joins the first');
	perform pg_temp.same(to_jsonb((select array_agg(x.erase_id) from public.qorpera_memory_message_erase_due(10) x)),
		jsonb_build_array(r -> 'eraseId'), 'The queue');
	perform pg_temp.same((select jsonb_build_object('sequence', e.sequence, 'index', e.message_index, 'input', e.input_id,
			'user', e.requested_by_user_id, 'generation', e.generation, 'root', e.root_key)
		from public.qorpera_memory_message_erases e where e.id = (r ->> 'eraseId')::uuid),
		'{"sequence":7,"index":5,"input":null,"user":"70000000-0000-4000-8000-000000000001","generation":null,"root":null}',
		'The row holds the message and its number');
	perform pg_temp.same(public.qorpera_memory_message_erase_status('70000000-0000-4000-8000-000000000020',
		'70000000-0000-4000-8000-000000000001', (r ->> 'eraseId')::uuid), r, 'Its status');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_status(%L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), r ->> 'eraseId'), 'P0002', 'Status for members only');
	perform pg_temp.fails('select * from public.qorpera_memory_message_erase_due(0)', '22023', 'A limit from 1 to 1000');
end $$;

-- 2b. Runs that read message 5, and runs that did not ----------------------------------------------------------------

-- A run of the Co-Founder in its thread with its job, live (leased) or ended (failed). The rows by hand, with foreign keys
-- and triggers off: the fixture has no sponsor or bundle, and nothing here reads them.
create function pg_temp.run(p_run uuid, p_live boolean) returns void language plpgsql as $$
declare s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0'); v_job uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, session_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, lease_token_sha256, lease_expires_at, finished_at, last_error, run_id)
	values (v_job, '70000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000020', s, v_job, 'agent_turn',
		'agent_turn', '{}', '70000000-0000-4000-8000-000000000001', case when p_live then 'leased' else 'failed' end,
		case when p_live then repeat('a', 64) end, case when p_live then clock_timestamp() + interval '1 hour' end,
		case when not p_live then clock_timestamp() end, case when not p_live then 'test' end, p_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
		company_seq, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, input_ids, created_by_user_id, requested_by_user_id, model_provider, model_id,
		model_selection, audience_kind, runtime_bundle_id, runtime_bundle_sha256)
	values (p_run, '70000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000020', 'manual', p_run, s, v_job,
		(select last_seq from public.qorpera_folder_clocks where environment_id = '70000000-0000-4000-8000-000000000020'),
		'70000000-0000-4000-8000-0000000000c0',
		(select version from public.qorpera_profile_staff where profile_id = '70000000-0000-4000-8000-000000000010'
			and staff_agent_id = '70000000-0000-4000-8000-0000000000c0'),
		extensions.gen_random_uuid(), 1, 'agent_turn', 'agent_turn', repeat('c', 64), 34, '{}', '70000000-0000-4000-8000-000000000001',
		'70000000-0000-4000-8000-000000000001', 'openai', 'gpt-test', 'provider_default', 'company', extensions.gen_random_uuid(),
		repeat('b', 64));
	-- Its assignment: a scrub updates the receipts, and an update checks the keys of a row this transaction wrote.
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at,
		accepted_at)
	values (extensions.gen_random_uuid(), extensions.gen_random_uuid(), v_job, p_run, extensions.gen_random_uuid(), repeat('e', 64),
		'accepted', clock_timestamp() + interval '1 hour', clock_timestamp());
	set local session_replication_role = origin;
end $$;
create function pg_temp.end_run(p_run uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'failed', lease_token_sha256 = null, lease_expires_at = null,
		finished_at = clock_timestamp(), last_error = 'test'
	where id = (select job_id from public.qorpera_execution_runs where id = p_run);
	set local session_replication_role = origin;
end $$;
-- A tool call's completed operation receipt, its content the text it returned.
create function pg_temp.op(p_run uuid, p_call text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, result, completed_at)
	select v_id, p_run, r.job_id, (select x.id from public.qorpera_runner_assignments x where x.run_id = p_run), p_call, 'cloud_tool',
		repeat('a', 64), repeat('e', 64), 'completed',
		jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'callId', p_call,
			'content', jsonb_build_object('kind', 'text', 'value', 'message 5 said ' || p_call)), clock_timestamp()
	from public.qorpera_execution_runs r where r.id = p_run;
	set local session_replication_role = origin;
	return v_id;
end $$;
-- A read receipt: a zoom or a read_context page of a conversation (or of a run's log), linked to its operation receipt.
create function pg_temp.read(p_run uuid, p_call text, p_tool text, p_op uuid, p_start bigint, p_size bigint, p_session uuid,
	p_target_run uuid default null) returns uuid language sql as $$
	insert into public.qorpera_memory_read_receipts(environment_id, run_id, call_id, tool, operation_receipt_id, target_session_id,
		target_run_id, start, size)
	values ('70000000-0000-4000-8000-000000000020', p_run, p_call, p_tool, p_op, p_session, p_target_run, p_start, p_size)
	returning id
$$;
-- The calls a run's rows in the run table name, in order.
create function pg_temp.run_calls(p_run uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(rr.call_id order by rr.call_id), '[]'::jsonb)
	from public.qorpera_memory_message_erase_runs t join public.qorpera_memory_read_receipts rr on rr.id = any(t.read_receipt_ids)
	where t.run_id = p_run
$$;
create function pg_temp.content(p_run uuid, p_call text) returns text language sql as $$
	select result #>> '{content,value}' from public.qorpera_run_operation_receipts where run_id = p_run and logical_operation_key = p_call
$$;

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0');
	a constant uuid := '96000000-0000-4000-8000-0000000000a1'; b constant uuid := '96000000-0000-4000-8000-0000000000b1';
	c constant uuid := '96000000-0000-4000-8000-0000000000c1'; d constant uuid := '96000000-0000-4000-8000-0000000000d1';
begin
	-- A, live: a zoom of message 5's own line.
	perform pg_temp.run(a, true);
	perform pg_temp.read(a, 'zoom-a', 'zoom', pg_temp.op(a, 'zoom-a'), 5, 1, s);
	-- B, ended with a card still open: a read_context page of messages 0 to 7.
	perform pg_temp.run(b, false);
	perform pg_temp.read(b, 'rc-b', 'read_context', pg_temp.op(b, 'rc-b'), 0, 8, s);
	insert into public.qorpera_action_reviews(profile_id, run_id, call_id, staff_agent_id, tool_name, effect, argument_sha256,
		action, decision, built_in, reason, reviewer_model, approver_scope)
	values ('70000000-0000-4000-8000-000000000010', b, 'card-b', '70000000-0000-4000-8000-0000000000c0', 'send_mail', 'external',
		repeat('2', 64), '{"title":"Mail"}', 'ask', 'none', 'Ask first.', 'test', 'owners_admins');
	-- C, ended: zooms of messages 32-47 and 0-3 (neither a source), of the line over 4-5 (a source), a read_context page
	-- at 5 with no operation receipt yet, and one from 6.
	perform pg_temp.run(c, false);
	perform pg_temp.read(c, 'zoom-c1', 'zoom', pg_temp.op(c, 'zoom-c1'), 32, 16, s);
	perform pg_temp.read(c, 'zoom-c2', 'zoom', pg_temp.op(c, 'zoom-c2'), 0, 4, s);
	perform pg_temp.read(c, 'zoom-c3', 'zoom', pg_temp.op(c, 'zoom-c3'), 4, 2, s);
	perform pg_temp.read(c, 'rc-c4', 'read_context', null, 5, 0, s);
	perform pg_temp.read(c, 'rc-c5', 'read_context', pg_temp.op(c, 'rc-c5'), 6, 4, s);
	-- D, ended: a page of A's run log, not of the conversation.
	perform pg_temp.run(d, false);
	perform pg_temp.read(d, 'rc-d', 'read_context', pg_temp.op(d, 'rc-d'), 5, 1, null, a);
end $$;

-- 3. Step 1: one memory commit blanks the event, deletes the three live candidate blocks and keeps their other lines ----

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0'); root constant text := 'agents/co-founder/memory/thread';
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); g bigint; r jsonb; er public.qorpera_memory_message_erases;
begin
	perform pg_temp.service();
	g := (select memory_generation from public.qorpera_shared_sessions where id = s);
	r := public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1","state":"open",'
		'"blocks":4,"runsPending":3}', 'Step 1 opens the erase');
	er := pg_temp.erase(eid);
	if er.generation is distinct from g + 1 or (select memory_generation from public.qorpera_shared_sessions where id = s) <> g + 1
		or er.owner_kind is distinct from 'agent' or er.owner_id is distinct from '70000000-0000-4000-8000-0000000000c0'
		or er.root_key is distinct from root or er.last_error is not null then
		raise exception 'The row holds the generation, the owner and the root: %', to_jsonb(er); end if;
	-- The event keeps its place and hash; its body goes. Its neighbours stay.
	if (pg_temp.event(s, 7)).body is distinct from '{"erased":true}'::jsonb or (pg_temp.event(s, 7)).event_hash <> pg_temp.ehash(7)
		or (pg_temp.event(s, 6)).body #>> '{entry,id}' is distinct from 'e6' or (pg_temp.event(s, 8)).body #>> '{entry,id}' is distinct from 'e8' then
		raise exception 'Step 1 blanks the event and only it'; end if;
	-- The deleted blocks' lines leave the index; the unrelated block stays.
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:32:34"', 'The index after step 1');
	if pg_temp.version(root || '/t0/00000000.jsonl') is not null or pg_temp.version(root || '/t0/00000001.jsonl') is not null
		or pg_temp.version(root || '/t1/00000000.jsonl') is not null or pg_temp.version(root || '/t0/00000002.jsonl') is null
		or pg_temp.version(root || '/tree.toml') is null then
		raise exception 'Step 1 deletes the live candidate blocks and nothing else'; end if;
	perform pg_temp.same(pg_temp.blocks(eid), '["t0/00000000.jsonl:block:0.0 0.1 0.2 0.3 0.4 1.0 1.1 2.0:cut",'
		'"t0/00000001.jsonl:block::cut","t1/00000000.jsonl:block::cut","t2/00000000.jsonl:block:-:key"]', 'The blocks');
	-- A kept line as the index held it.
	perform pg_temp.same((select b.keep -> 0 from public.qorpera_memory_message_erase_blocks b
			where b.erase_id = eid and b.block_key = root || '/t0/00000000.jsonl'),
		jsonb_build_object('l', 0, 'k', 0, 'line', pg_temp.line0(0, 1)), 'A kept level-0 line');
	perform pg_temp.same((select b.keep -> 7 from public.qorpera_memory_message_erase_blocks b
			where b.erase_id = eid and b.block_key = root || '/t0/00000000.jsonl'),
		jsonb_build_object('l', 2, 'k', 0, 'line', pg_temp.kept(2, 0)), 'A kept summary line');
	-- The commit: the member's, by the eraser's key; each cut is its block's delete there.
	if not exists (select 1 from public.qorpera_folder_commits c where c.id = er.commit_id
			and c.requester_kind = 'member' and c.requester_id = '70000000-0000-4000-8000-000000000001'
			and c.operation_key like 'memerase:' || eid || ':%')
		or exists (select 1 from public.qorpera_memory_message_erase_blocks b where b.erase_id = eid and b.cutoff_seq is not null
			and not exists (select 1 from public.qorpera_folder_path_versions v join public.qorpera_folder_commits c on c.id = v.commit_id
				where v.commit_id = er.commit_id and v.op = 'delete' and v.key_sha256 = extensions.digest(b.block_key, 'sha256')
					and c.seq = b.cutoff_seq and v.unit_no = b.cutoff_unit)) then
		raise exception 'The member''s commit and its cuts'; end if;
	perform pg_temp.same(to_jsonb((select count(*) from public.qorpera_folder_commits c where c.operation_key like 'memerase:%')), '1',
		'One commit');
	-- The runs that read message 5, each with the receipts that did: not D (a run log), not C's pages that miss it.
	perform pg_temp.same((select jsonb_object_agg(t.run_id, pg_temp.run_calls(t.run_id)) from public.qorpera_memory_message_erase_runs t
			where t.erase_id = eid and t.state = 'pending' and t.scrubbed_at is null),
		'{"96000000-0000-4000-8000-0000000000a1":["zoom-a"],"96000000-0000-4000-8000-0000000000b1":["rc-b"],'
		'"96000000-0000-4000-8000-0000000000c1":["rc-c4","zoom-c3"]}', 'The runs to scrub');
	-- An open erase is past step 1: a second call answers where it stands.
	perform pg_temp.same(public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid), r, 'Step 1 runs once');
	perform pg_temp.same(public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020',
		'70000000-0000-4000-8000-000000000001', s, (pg_temp.event(s, 7)).event_id), r, 'A request joins the open erase');
end $$;

-- 4. Step 2: the plan, its refusals, a live write that moves it, and the rewrite --------------------------------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0'); root constant text := 'agents/co-founder/memory/thread';
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); p jsonb; p1 jsonb; r jsonb; v uuid;
	er public.qorpera_memory_message_erases;
	t text := pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line0(2, 4), pg_temp.line0(3, 5),
		pg_temp.line0(4, 6), pg_temp.kept(1, 0), pg_temp.kept(1, 1), pg_temp.kept(2, 0)]);
begin
	perform pg_temp.service();
	-- The plan: the one block with lines to keep, its text those lines in order, as a new file.
	p := public.qorpera_memory_message_erase_plan('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(p - 'planSha256', jsonb_build_object('schema', 'qorpera.memory-message-erase-plan/v1', 'eraseId', eid,
		'blocks', jsonb_build_array(jsonb_build_object('path', root || '/t0/00000000.jsonl', 'text', t,
			'fileSha256', encode(extensions.digest(convert_to(t, 'utf8'), 'sha256'), 'hex'), 'bytes', octet_length(t),
			'expectedVersion', null))), 'The plan');
	perform pg_temp.same(p -> 'planSha256',
		to_jsonb(encode(extensions.digest(convert_to((p -> 'blocks')::text, 'utf8'), 'sha256'), 'hex')), 'The plan''s hash');
	-- A rewrite holds to the plan and its files.
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_plan(%L, %L)',
		'70000000-0000-4000-8000-000000000020', eid), '42501', 'Only the folder core plans');
	perform pg_temp.service();
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_plan(%L, %L)',
		'70000000-0000-4000-8000-000000000020', extensions.gen_random_uuid()), 'P0002', 'No such erase');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_rewrite(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', eid, repeat('0', 64), '[]'), '55000', 'Another plan');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_rewrite(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', eid, p ->> 'planSha256', '[]'), '22023', 'No files');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_rewrite(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', eid, p ->> 'planSha256', jsonb_build_array(jsonb_build_object(
			'path', root || '/t0/00000000.jsonl', 'file', pg_temp.stage(E'other\n')))), '22023', 'A file that is not the text');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_rewrite(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', eid, p ->> 'planSha256', jsonb_build_array(jsonb_build_object(
			'path', root || '/t0/00000001.jsonl', 'file', pg_temp.stage(t)))), '22023', 'A file at another path');
	-- A run writes the block again first: the plan takes its live line in place of the kept one, over its version.
	r := pg_temp.memory('m3-live-1', jsonb_build_array(pg_temp.block_file(root || '/t0/00000000.jsonl',
		pg_temp.block(array[pg_temp.line0(0, 1, 'again')]))), array[s]);
	perform pg_temp.expect(r, 1, 'saved');
	v := pg_temp.version(root || '/t0/00000000.jsonl');
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_rewrite(%L, %L, %L, %L)',
		'70000000-0000-4000-8000-000000000020', eid, p ->> 'planSha256', jsonb_build_array(jsonb_build_object(
			'path', root || '/t0/00000000.jsonl', 'file', pg_temp.stage(t)))), '55000', 'The plan moved');
	t := pg_temp.block(array[pg_temp.line0(0, 1, 'again'), pg_temp.line0(1, 3), pg_temp.line0(2, 4), pg_temp.line0(3, 5),
		pg_temp.line0(4, 6), pg_temp.kept(1, 0), pg_temp.kept(1, 1), pg_temp.kept(2, 0)]);
	p1 := public.qorpera_memory_message_erase_plan('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(p1 -> 'blocks', jsonb_build_array(jsonb_build_object('path', root || '/t0/00000000.jsonl', 'text', t,
		'fileSha256', encode(extensions.digest(convert_to(t, 'utf8'), 'sha256'), 'hex'), 'bytes', octet_length(t),
		'expectedVersion', v)), 'The plan over the live block');
	if (pg_temp.erase(eid)).state <> 'open' then raise exception 'A refused rewrite leaves the row open'; end if;
	-- The rewrite: one member's commit, the kept lines back in the index beside the live one.
	r := pg_temp.rewrite(eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1",'
		'"state":"rewritten","blocks":4,"runsPending":3}', 'Step 2 rewrites the block');
	perform pg_temp.same(to_jsonb(pg_temp.nodes(s)), '"0:0:1,0:1:3,0:2:4,0:3:5,0:4:6,0:32:34,1:0:-,1:1:-,2:0:-"',
		'The index after step 2');
	if (select n.text from public.qorpera_memory_tree_nodes n where n.session_id = s and n.l = 0 and n.k = 0) is distinct from 'again'
		or pg_temp.version(root || '/t0/00000000.jsonl') = v then
		raise exception 'Step 2 writes over the live block and keeps its line'; end if;
	er := pg_temp.erase(eid);
	if er.last_error is not null or not exists (select 1 from public.qorpera_folder_commits c where c.id = er.rewrite_commit_id
			and c.requester_kind = 'member' and c.requester_id = '70000000-0000-4000-8000-000000000001'
			and c.operation_key like 'memerase:' || eid || ':%') then
		raise exception 'The member''s rewrite commit: %', to_jsonb(er); end if;
	-- A rewritten erase is past step 2: its kept lines are gone, the plan is empty and a second call answers where it stands.
	perform pg_temp.same(public.qorpera_memory_message_erase_plan('70000000-0000-4000-8000-000000000020', eid) -> 'blocks', '[]',
		'Nothing left to plan');
	if exists (select 1 from public.qorpera_memory_message_erase_blocks b where b.erase_id = eid and b.keep is not null) then
		raise exception 'Kept lines outlive step 2'; end if;
	perform pg_temp.same(pg_temp.rewrite(eid), r, 'Step 2 runs once');
	perform pg_temp.same(to_jsonb((select count(*) from public.qorpera_folder_commits c where c.operation_key like 'memerase:%')), '2',
		'Two commits');
end $$;

-- 5. Step 3: one block's history request per call, each an erasure for this row; a replay finds its own ----------------

do $$
declare
	root constant text := 'agents/co-founder/memory/thread';
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); r jsonb; i integer; b public.qorpera_memory_message_erase_blocks;
begin
	perform pg_temp.service();
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_ask(%L, %L)',
		'70000000-0000-4000-8000-000000000020', eid), '42501', 'Only the folder core asks');
	perform pg_temp.service();
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_ask(%L, %L)',
		'70000000-0000-4000-8000-000000000020', extensions.gen_random_uuid()), 'P0002', 'No such erase');
	-- Four blocks, four calls, in key order.
	for i in 1..4 loop
		r := public.qorpera_memory_message_erase_ask('70000000-0000-4000-8000-000000000020', eid);
		perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', jsonb_build_object('schema', 'qorpera.memory-message-erase/v1',
			'state', case when i < 4 then 'rewritten' else 'requested' end, 'blocks', 4, 'runsPending', 3), format('Ask %s', i));
		perform pg_temp.same((select jsonb_agg(substr(x.block_key, length(root) + 2) order by x.block_key)
				from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid and x.accepted_at is not null),
			(select jsonb_agg(y) from (select y from unnest(array['t0/00000000.jsonl', 't0/00000001.jsonl', 't1/00000000.jsonl',
				't2/00000000.jsonl']) y limit i) z), format('The blocks asked after %s', i));
		if (pg_temp.erase(eid)).last_error is not null then raise exception 'Ask %: %', i, (pg_temp.erase(eid)).last_error; end if;
	end loop;
	-- Each block's erasure: its own key, for this row, cut at the block's delete or by key alone, its copies kept.
	for b in select * from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid order by x.block_key loop
		if b.erasure_id is null or b.copies is null or not exists (select 1 from public.qorpera_folder_erasures e
				where e.id = b.erasure_id and e.environment_id = '70000000-0000-4000-8000-000000000020'
					and e.operation_key = 'memtree:' || encode(extensions.digest(convert_to('qorpera_memory_message_erases:' || eid
						|| ':' || b.block_key, 'utf8'), 'sha256'), 'hex')
					and e.block_history -> 'for' = jsonb_build_object('table', 'qorpera_memory_message_erases', 'id', eid::text)
					and e.block_history ->> 'path' = b.path and e.requested_by_user_id = '70000000-0000-4000-8000-000000000001'
					and (e.block_history ->> 'cutoffSeq')::bigint is not distinct from b.cutoff_seq
					and (e.block_history ->> 'cutoffUnit')::integer is not distinct from b.cutoff_unit
					and coalesce(e.reply -> 'copies', '[]'::jsonb) = b.copies) then
			raise exception 'The erasure of %: %', b.block_key, to_jsonb(b); end if;
	end loop;
	if (select count(distinct x.erasure_id) from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid) <> 4 then
		raise exception 'One erasure per block'; end if;
	-- A request accepted before a restart, its answer lost: asked again, the erasure is found by its key.
	b := (select x from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid and x.block_key = root || '/t1/00000000.jsonl');
	update public.qorpera_memory_message_erase_blocks set erasure_id = null, copies = null, accepted_at = null
	where erase_id = eid and block_key = b.block_key;
	update public.qorpera_memory_message_erases set state = 'rewritten' where id = eid;
	perform pg_temp.same(public.qorpera_memory_message_erase_ask('70000000-0000-4000-8000-000000000020', eid), r, 'The replay');
	if (select x.erasure_id from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid and x.block_key = b.block_key)
			is distinct from b.erasure_id
		or (select x.copies from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid and x.block_key = b.block_key)
			is distinct from b.copies
		or (select count(*) from public.qorpera_folder_erasures e where e.operation_key like 'memtree:%') <> 4 then
		raise exception 'The replay finds its erasure'; end if;
	-- A requested erase is past step 3.
	perform pg_temp.same(public.qorpera_memory_message_erase_ask('70000000-0000-4000-8000-000000000020', eid), r, 'Step 3 runs once');
end $$;

-- 6. Step 4: each ended run with no open card has its receipts scrubbed; the erase is done once the versions are gone ---

do $$
declare
	eid uuid := (select e.id from public.qorpera_memory_message_erases e); r jsonb; er public.qorpera_memory_message_erases;
	a constant uuid := '96000000-0000-4000-8000-0000000000a1'; b constant uuid := '96000000-0000-4000-8000-0000000000b1';
	c constant uuid := '96000000-0000-4000-8000-0000000000c1'; d constant uuid := '96000000-0000-4000-8000-0000000000d1';
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_scrub(%L, %L)',
		'70000000-0000-4000-8000-000000000020', eid), '42501', 'Only the folder core scrubs');
	perform pg_temp.service();
	perform pg_temp.fails(format('select public.qorpera_memory_message_erase_scrub(%L, %L)',
		'70000000-0000-4000-8000-000000000020', extensions.gen_random_uuid()), 'P0002', 'No such erase');
	-- C has ended: the receipt that read message 5 keeps its envelope, its content erased. A is live; B has an open card.
	r := public.qorpera_memory_message_erase_scrub('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1",'
		'"state":"requested","blocks":4,"runsPending":2}', 'Step 4 scrubs the ended run');
	perform pg_temp.same((select jsonb_object_agg(t.run_id, t.state || ':' || (t.scrubbed_at is not null))
			from public.qorpera_memory_message_erase_runs t where t.erase_id = eid),
		'{"96000000-0000-4000-8000-0000000000a1":"pending:false","96000000-0000-4000-8000-0000000000b1":"pending:false",'
		'"96000000-0000-4000-8000-0000000000c1":"done:true"}', 'The run table after C');
	perform pg_temp.same((select o.result from public.qorpera_run_operation_receipts o where o.run_id = c and o.logical_operation_key = 'zoom-c3'),
		'{"schema":"qorpera.cloud-tool-operation-result/v1","callId":"zoom-c3","content":{"kind":"text","value":"[erased]"}}',
		'The scrubbed receipt');
	perform pg_temp.same(jsonb_build_array(pg_temp.content(c, 'zoom-c1'), pg_temp.content(c, 'zoom-c2'), pg_temp.content(c, 'rc-c5'),
			pg_temp.content(a, 'zoom-a'), pg_temp.content(b, 'rc-b'), pg_temp.content(d, 'rc-d')),
		'["message 5 said zoom-c1","message 5 said zoom-c2","message 5 said rc-c5","message 5 said zoom-a","message 5 said rc-b",'
		'"message 5 said rc-d"]', 'The other receipts stay');
	-- A ends and B's card is denied: both are scrubbed, while P18 still erases the blocks' versions.
	perform pg_temp.end_run(a);
	update public.qorpera_action_reviews set answer = 'deny', answered_by_user_id = '70000000-0000-4000-8000-000000000001',
		answered_at = clock_timestamp()
	where run_id = b;
	r := public.qorpera_memory_message_erase_scrub('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1",'
		'"state":"requested","blocks":4,"runsPending":0}', 'Every run scrubbed, the versions not yet gone');
	perform pg_temp.same(jsonb_build_array(pg_temp.content(a, 'zoom-a'), pg_temp.content(b, 'rc-b'), pg_temp.content(c, 'zoom-c3')),
		'["[erased]","[erased]","[erased]"]', 'A and B scrubbed');
	-- Each erasure moves past its versions phase: the erase is done.
	set local session_replication_role = replica;
	update public.qorpera_folder_erasures set phase = 2
	where id in (select x.erasure_id from public.qorpera_memory_message_erase_blocks x where x.erase_id = eid) and phase = 1;
	set local session_replication_role = origin;
	r := public.qorpera_memory_message_erase_scrub('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r - 'eraseId' - 'sessionId' - 'eventId', '{"schema":"qorpera.memory-message-erase/v1",'
		'"state":"done","blocks":4,"runsPending":0}', 'The erase is done');
	er := pg_temp.erase(eid);
	if er.done_at is null or er.last_error is not null then raise exception 'A done erase: %', to_jsonb(er); end if;
	perform pg_temp.same(public.qorpera_memory_message_erase_scrub('70000000-0000-4000-8000-000000000020', eid), r, 'Step 4 runs once');
	perform pg_temp.same(public.qorpera_memory_message_erase_status('70000000-0000-4000-8000-000000000020',
		'70000000-0000-4000-8000-000000000001', eid), r, 'Its status');
end $$;

-- 7. Readers: a run's context reads the erased message as (erased), its neighbour as it was ------------------------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000c0'); v_run public.qorpera_execution_runs;
begin
	select * into v_run from public.qorpera_execution_runs where id = '96000000-0000-4000-8000-0000000000a1';
	perform pg_temp.same(public.qorpera_company_context_source(v_run, 'history', (pg_temp.event(s, 7)).event_id) - 'id',
		jsonb_build_object('kind', 'historical_data', 'sourceKind', 'history', 'actorKind', 'company_service', 'authorUserId', null,
			'sequence', 7, 'attachmentCount', 0, 'text', '(erased)'), 'An erased message reads (erased)');
	perform pg_temp.same(public.qorpera_company_context_source(v_run, 'history', (pg_temp.event(s, 6)).event_id) -> 'text',
		to_jsonb((pg_temp.event(s, 6)).body::text), 'Its neighbour reads as it was');
end $$;

-- 8. Privileges: the folder core calls the eight steps, as their definer, and reads the tables; no one calls the rest -

do $$
declare
	v_bad text;
	v_steps constant text[] := array['public.qorpera_memory_message_erase_request(uuid,uuid,uuid,uuid)',
		'public.qorpera_memory_message_erase_status(uuid,uuid,uuid)', 'public.qorpera_memory_message_erase_due(integer)',
		'public.qorpera_memory_message_erase_open(uuid,uuid)', 'public.qorpera_memory_message_erase_plan(uuid,uuid)',
		'public.qorpera_memory_message_erase_rewrite(uuid,uuid,text,jsonb)', 'public.qorpera_memory_message_erase_ask(uuid,uuid)',
		'public.qorpera_memory_message_erase_scrub(uuid,uuid)'];
begin
	select string_agg(f || ' ' || r, ', ') into v_bad
	from unnest(v_steps || array['public.qorpera_memory_entry_id(jsonb,uuid)', 'public.qorpera_memory_erase_drops(bigint,integer,bigint)',
		'public.qorpera_memory_erase_candidates(text,bigint)', 'public.qorpera_memory_erase_line(public.qorpera_memory_tree_nodes)',
		'public.qorpera_memory_erase_deletes(uuid,text,bigint,uuid)', 'public.qorpera_memory_erase_toml_manifests(uuid)',
		'public.qorpera_memory_erase_roots(uuid,uuid)', 'public.qorpera_memory_erase_image_folders(uuid,uuid)',
		'public.qorpera_memory_erase_receipts(uuid,uuid,bigint)',
		'public.qorpera_memory_message_erase_context(uuid,text)', 'public.qorpera_memory_message_erase_lock_targets(jsonb)',
		'public.qorpera_memory_message_erase_targets(uuid,text)', 'public.qorpera_memory_message_erase_step1(jsonb,jsonb)',
		'public.qorpera_memory_message_erase_hook(uuid,text,jsonb)', 'public.qorpera_memory_message_erase_reply(uuid)',
		'public.qorpera_memory_message_erase_rewrite_plan(uuid,uuid)', 'public.qorpera_memory_message_erase_rewritten(uuid,uuid,text)']) f,
		unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, f, 'execute') is distinct from (f = any(v_steps) and r = 'service_role');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	if exists (select 1 from unnest(v_steps) f join pg_proc p on p.oid = f::regprocedure where not p.prosecdef) then
		raise exception 'The steps run as their definer'; end if;
	select string_agg(t || ' ' || r, ', ') into v_bad
	from unnest(array['public.qorpera_memory_message_erases', 'public.qorpera_memory_message_erase_blocks',
		'public.qorpera_memory_message_erase_runs']) t, unnest(array['anon', 'authenticated', 'service_role']) r
	where has_table_privilege(r, t, 'insert,update,delete,truncate')
		or has_table_privilege(r, t, 'select') is distinct from (r = 'service_role');
	if v_bad is not null then raise exception 'Table readers: %', v_bad; end if;
end $$;

rollback;
