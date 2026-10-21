-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Summary trees M1b-3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §8, §10; 20260930202000): zoom, a native host
-- call. The refs (`.`, thread:<agent>, group:<group>) and the ones that name nothing; a line's checks; the two lines
-- below a line, with their dates, text and block; one event as the transcript holds it (its speaker, a quoted message
-- fenced, attachments, a card, an erased event); a zoom with no line and the tree it reads; the receipt by target and
-- range, a retried call and a call id used for another read; malformed requests; the grants, the call list and the
-- observation vocabulary. Runs are 647's hand-built runs, on 769's helpers. Races with an erase are in 944.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- A structured entry as the TS parser sends it, and a file written with it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020'
		and key_text = public.qorpera_folder_key(p_key)
$$;
create function pg_temp.agent_text(p_id uuid, p_name text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: agent\nstatus: active\n---\nSell.\n', p_id, p_name)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind','agent','status','active',
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
-- A new agent folder with its agent.md, as one unit, staged by the owner who commits it (a version-2 file is held to
-- possession).
create function pg_temp.hire(p_handle text, p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name), pg_temp.member(1))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name), pg_temp.agent_parse(p_id, p_name))))
$$;
-- A group chat's folder (as 940), staged by the owner.
create function pg_temp.group_text(p_id uuid, p_agents uuid[], p_people uuid[]) returns text language sql as $$
	select format(E'---\nid: %s\nname: Launch\nagents:\n%speople:\n%s---\nPlan the launch.\n', p_id,
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a),
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_people) a))
$$;
create function pg_temp.new_group(p_handle text, p_id uuid, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_agents, p_people), pg_temp.member(1)))),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_agents, p_people),
			jsonb_build_object('kind','group','id',p_id,'name','Launch','subtitle',null,'agents',to_jsonb(p_agents),
				'people',to_jsonb(p_people),'purpose','Plan the launch.'))))
$$;
-- An agent's thread conversation.
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;

-- The tree's files (as 940).
create function pg_temp.ehash(p_seq bigint) returns text language sql immutable as $$
	select encode(extensions.digest('e' || p_seq, 'sha256'), 'hex')
$$;
create function pg_temp.toml(p_session uuid) returns text language sql as $$
	select format(E'format = 1\nconversation = "%s"\nnode_bytes = 1024\n', p_session)
$$;
create function pg_temp.line0(p_k bigint, p_seq bigint) returns text language sql as $$
	select format('{"l":0,"k":%s,"seq":%s,"hash":"%s","free":true,"text":"said"}', p_k, p_seq, pg_temp.ehash(p_seq))
$$;
create function pg_temp.line(p_l integer, p_k bigint, p_text text) returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"tries":1,"text":"%s"}', p_l, p_k, p_text)
$$;
create function pg_temp.tree_file(p_path text, p_text text) returns jsonb language sql as $$
	select pg_temp.write(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind))
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
create function pg_temp.memory(p_key text, p_units jsonb, p_session uuid) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', p_session,
			'generation', (select memory_generation from public.qorpera_shared_sessions where id = p_session)))))
$$;

-- The transcript: events by sequence, at 09:<seq> UTC, each with its hash; the inputs members wrote.
create function pg_temp.event_id(p_seq bigint) returns uuid language sql immutable as $$
	select ('94300000-0000-4000-8000-e' || lpad(p_seq::text, 11, '0'))::uuid
$$;
create function pg_temp.input_id(p_n integer) returns uuid language sql immutable as $$
	select ('94300000-0000-4000-8000-1' || lpad(p_n::text, 11, '0'))::uuid
$$;
create function pg_temp.at(p_seq bigint) returns text language sql immutable as $$
	select format('2026-10-04T09:%s:00.000Z', lpad(p_seq::text, 2, '0'))
$$;
create function pg_temp.input(p_session uuid, p_n integer, p_author integer, p_body jsonb) returns uuid language sql as $$
	select pg_temp.fx(format('insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, body) values (%L, %L, %L, %L, %L, %L, %L, %L, %L)', pg_temp.input_id(p_n), p_session,
		extensions.gen_random_uuid(), '63400000-0000-4000-8000-00000000000' || p_author, 'human', 'user_message',
		'63400000-0000-4000-8000-0000000000b2', repeat('b', 64), p_body));
	select pg_temp.input_id(p_n)
$$;
create function pg_temp.event(p_session uuid, p_seq bigint, p_type text, p_body jsonb, p_input uuid default null, p_run uuid default null,
	p_actor integer default 1) returns void language sql as $$
	select pg_temp.fx(format('insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body,
		event_hash, created_at, session_input_id, execution_kind, execution_id, execution_claimant_id, runner_assignment_id)
		values (%L, %s, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)', p_session, p_seq, pg_temp.event_id(p_seq), p_type,
		'63400000-0000-4000-8000-00000000000' || p_actor, p_body, pg_temp.ehash(p_seq),
		timestamptz '2026-10-04 09:00:00+00' + p_seq * interval '1 minute', p_input, case when p_run is not null then 'run' end, p_run,
		p_run, case when p_run is not null then extensions.gen_random_uuid() end))
$$;
-- An event as zoom returns it.
create function pg_temp.ev(p_index bigint, p_seq bigint, p_type text, p_kind text, p_speaker text, p_role text, p_text text,
	p_run uuid default null, p_attachments jsonb default null, p_card_type text default null, p_card jsonb default null,
	p_erased boolean default false, p_quotes jsonb default null) returns jsonb language sql as $$
	select jsonb_build_object('index', p_index, 'sequence', p_seq, 'eventId', pg_temp.event_id(p_seq), 'eventHash', pg_temp.ehash(p_seq),
		'type', p_type, 'at', pg_temp.at(p_seq), 'erased', p_erased, 'runId', p_run, 'speakerKind', p_kind, 'speaker', p_speaker,
		'role', p_role, 'text', p_text, 'quotes', p_quotes, 'attachments', p_attachments, 'cardType', p_card_type, 'card', p_card)
$$;

-- The zoom run's binding and run id, and a zoom by it.
create function pg_temp.b() returns jsonb language sql as $$ select current_setting('qorpera_test.zoom_binding')::jsonb $$;
create function pg_temp.run_id() returns uuid language sql as $$ select current_setting('qorpera_test.zoom_run')::uuid $$;
create function pg_temp.zoom(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_memory_zoom(pg_temp.b(), p_request)
$$;
create function pg_temp.receipts() returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_array(r.call_id, r.tool, r.target_session_id, r.start, r.size, r.from_offset)
		order by r.call_id collate "C"), '[]'::jsonb)
	from public.qorpera_memory_read_receipts r where r.run_id = pg_temp.run_id()
$$;
create function pg_temp.blk() returns jsonb language sql as $$
	select jsonb_build_object('path', 'QorperaOS/agents/nora/memory/thread/t0/00000000.jsonl',
		'version', pg_temp.version('QorperaOS/agents/nora/memory/thread/t0/00000000.jsonl'))
$$;
create function pg_temp.nora() returns jsonb language sql as $$
	select jsonb_build_object('ref', 'thread:nora', 'sessionId', pg_temp.thread('94300000-0000-4000-8000-0000000000a1'), 'kind', 'thread',
		'name', 'Nora')
$$;

-- The company chose Shared context, the beta its place on the test list offers, so its runs are recorded in the beta
-- (C5, 20260930508000).
insert into public.qorpera_memory_tree_companies(profile_id) values ('63400000-0000-4000-8000-000000000010');
insert into public.qorpera_company_memory_modes(profile_id, mode) values ('63400000-0000-4000-8000-000000000010', 'tree');

-- The setup: two hires and their group chat; the zoom run (Agent A's, for the member); Nora's transcript, nine
-- included events and a session_info; Nora's tree, with lines 0-3 at level 0, both at level 1 and the first at level 2.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'zoom-setup', '[{"op":"mkdir","path":"QorperaOS"},
	{"op":"mkdir","path":"QorperaOS/agents"},{"op":"mkdir","path":"QorperaOS/agents/groups"}]'), 3, 'saved') \g /dev/null
do $$
declare
	nora constant uuid := '94300000-0000-4000-8000-0000000000a1'; otto constant uuid := '94300000-0000-4000-8000-0000000000a2';
	x jsonb; s uuid; r jsonb; i integer; run uuid; root constant text := 'QorperaOS/agents/nora/memory/thread';
	quote constant jsonb := jsonb_build_object('start', 5, 'end', 10, 'source', 'mail', 'ref', repeat('A', 43));
begin
	r := pg_temp.commit(pg_temp.member(1), 'zoom-hire', jsonb_build_array(pg_temp.hire('nora', nora, 'Nora'), pg_temp.hire('otto', otto, 'Otto')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'zoom-group', jsonb_build_array(pg_temp.new_group('launch',
		'94300000-0000-4000-8000-0000000000b1', array[nora, otto], array['63400000-0000-4000-8000-000000000001']::uuid[]))), 1, 'saved');
	x := pg_temp.agent_run();
	run := (x -> 'actor' ->> 'runId')::uuid;
	perform set_config('qorpera_test.zoom_binding', (x -> 'binding')::text, true);
	perform set_config('qorpera_test.zoom_run', run::text, true);

	s := pg_temp.thread(nora);
	if s is null or exists (select 1 from public.qorpera_session_events where session_id = s) then
		raise exception 'Nora has a thread with no events yet'; end if;
	perform pg_temp.event(s, 1, 'message', jsonb_build_object('entry', jsonb_build_object(
			'message', jsonb_build_object('role', 'user', 'content', 'See «hello» now'), 'qorperaQuotes', jsonb_build_array(quote))),
		pg_temp.input(s, 1, 5, jsonb_build_object('text', 'See «hello» now', 'quotes', jsonb_build_array(quote))));
	perform pg_temp.event(s, 2, 'session_info', '{"entry":{"customType":"qorpera.info"}}');
	perform pg_temp.event(s, 3, 'message', '{"entry":{"message":{"role":"assistant","content":"On it."}}}');
	perform pg_temp.fx(format('insert into public.qorpera_session_event_speakers(event_id, run_id, staff_agent_id, staff_version, display_name)
		values (%L, %L, %L, 1, %L)', pg_temp.event_id(3), run, nora, 'Nora'));
	perform pg_temp.event(s, 4, 'interaction_request',
		'{"entry":{"customType":"qorpera.interaction_request","data":{"question":"Ship?"}}}', p_run => run);
	perform pg_temp.event(s, 5, 'interaction_answer', '{"entry":{"customType":"qorpera.interaction_answer","data":{"answer":"yes"}}}',
		pg_temp.input(s, 5, 2, '{}'));
	perform pg_temp.event(s, 6, 'message', '{"erased":true}', pg_temp.input(s, 6, 2, '{}'));
	perform pg_temp.event(s, 7, 'message', jsonb_build_object('entry', jsonb_build_object(
		'message', jsonb_build_object('role', 'user', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Look'),
			jsonb_build_object('type', 'image', 'mimeType', 'image/png'))),
		'qorperaAttachments', jsonb_build_array(jsonb_build_object('mediaType', 'image/png', 'bytes', 2048, 'name', 'shot.png')))));
	perform pg_temp.event(s, 8, 'message', '{"entry":{"message":{"role":"assistant","content":[{"type":"text","text":"First"},'
		'{"type":"thinking","thinking":"hidden"},{"type":"text","text":"Second"}]}}}');
	perform pg_temp.event(s, 9, 'authorization_request', '{"entry":{"data":{"tool":"send_mail"}}}');
	perform pg_temp.event(s, 10, 'authorization_decision', '{"entry":{"data":{"decision":"allow"}}}', pg_temp.input(s, 10, 1, '{}'));

	r := pg_temp.memory('zoom-tree', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s)), jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl', array_to_string(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line0(2, 4),
			pg_temp.line0(3, 5), pg_temp.line(1, 0, 'first pair'), pg_temp.line(1, 1, 'second pair'), pg_temp.line(2, 0, 'first four')], E'\n')
			|| E'\n')), s);
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- The checks start here.

-- 1. Refs: `.` (also absent or null) is the run's own conversation; thread:<agent> and group:<group> by folder key.
-- A ref that names nothing answers missing, with no receipt -------------------------------------------------------------

do $$
declare
	own uuid := (select session_id from public.qorpera_execution_runs where id = pg_temp.run_id());
	otto uuid := pg_temp.thread('94300000-0000-4000-8000-0000000000a2');
	launch uuid := (select session_id from public.qorpera_company_rooms where id = '94300000-0000-4000-8000-0000000000b1');
	empty jsonb; ref text;
begin
	empty := jsonb_build_object('generation', 0, 'messages', 0, 'root', null, 'nodeBytes', null, 'blocks', '[]'::jsonb, 'lines', '[]'::jsonb);
	perform pg_temp.same(pg_temp.zoom('{"callId":"own-1","conversation":"."}'), jsonb_build_object('schema', 'qorpera.memory-zoom/v1',
		'conversation', jsonb_build_object('ref', '.', 'sessionId', own, 'kind', 'thread', 'name', 'Agent A'),
		'line', null, 'messages', 0, 'from', 0, 'tree', empty || jsonb_build_object('sessionId', own)), 'The run''s own conversation');
	perform pg_temp.same(pg_temp.zoom('{"callId":"own-2"}') -> 'conversation', jsonb_build_object('ref', '.', 'sessionId', own,
		'kind', 'thread', 'name', 'Agent A'), 'An absent ref is the own conversation');
	perform pg_temp.same(pg_temp.zoom('{"callId":"own-3","conversation":null,"line":null,"from":null}') - 'tree',
		jsonb_build_object('schema', 'qorpera.memory-zoom/v1', 'conversation', jsonb_build_object('ref', '.', 'sessionId', own,
			'kind', 'thread', 'name', 'Agent A'), 'line', null, 'messages', 0, 'from', 0), 'JSON null is absent');
	perform pg_temp.same(pg_temp.zoom('{"callId":"otto-1","conversation":"thread:otto"}'), jsonb_build_object('schema', 'qorpera.memory-zoom/v1',
		'conversation', jsonb_build_object('ref', 'thread:otto', 'sessionId', otto, 'kind', 'thread', 'name', 'Otto'),
		'line', null, 'messages', 0, 'from', 0, 'tree', empty || jsonb_build_object('sessionId', otto)), 'An agent''s thread');
	perform pg_temp.same(pg_temp.zoom('{"callId":"nora-upper","conversation":"thread:NORA","line":"8+1"}') -> 'conversation',
		pg_temp.nora() || '{"ref":"thread:NORA"}', 'A thread ref is a folder key');
	perform pg_temp.same(pg_temp.zoom('{"callId":"group-1","conversation":"group:Launch"}') -> 'conversation',
		jsonb_build_object('ref', 'group:Launch', 'sessionId', launch, 'kind', 'group', 'name', 'Launch'), 'A group chat');
	if own is null or otto is null or launch is null or own = otto or launch in (own, otto) then
		raise exception 'Three conversations'; end if;

	foreach ref in array array['thread:groups', 'thread:x/y', 'thread:..', 'thread:', 'thread:pia', 'group:', 'group:groups', 'group:..',
		'group:launch/x', 'group:nora', 'run:' || pg_temp.run_id(), 'nora', '', '..', 'thread:' || repeat('n', 300)] loop
		perform pg_temp.same(pg_temp.zoom(jsonb_build_object('callId', 'missing-' || md5(ref), 'conversation', ref, 'line', '0+1')),
			jsonb_build_object('schema', 'qorpera.memory-zoom/v1', 'missing', 'conversation', 'conversation', jsonb_build_object('ref', ref)),
			'A ref that names nothing: ' || left(ref, 40));
	end loop;
	-- A retired agent's thread names nothing.
	perform pg_temp.fx(format('update public.qorpera_profile_staff set folder_retired_at = now() where staff_agent_id = %L',
		'94300000-0000-4000-8000-0000000000a2'));
	perform pg_temp.same(pg_temp.zoom('{"callId":"missing-retired","conversation":"thread:otto"}') -> 'missing', '"conversation"',
		'A retired agent''s thread');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set folder_retired_at = null where staff_agent_id = %L',
		'94300000-0000-4000-8000-0000000000a2'));
	if exists (select 1 from public.qorpera_memory_read_receipts where run_id = pg_temp.run_id() and call_id like 'missing-%') then
		raise exception 'A missing conversation leaves no receipt'; end if;
end $$;

-- 2. Lines: a line is an address of [0, T); its two lines below, with their dates, text and block (null when not built)
-- --------------------------------------------------------------------------------------------------------------------

do $$
declare line text; head jsonb;
begin
	head := jsonb_build_object('schema', 'qorpera.memory-zoom/v1', 'conversation', pg_temp.nora(), 'messages', 9, 'from', 0);
	perform pg_temp.same(pg_temp.zoom('{"callId":"z-0+8","conversation":"thread:nora","line":"0+8"}'), head || jsonb_build_object('line', '0+8',
		'lines', jsonb_build_array(
			jsonb_build_object('line', '0+4', 'from', pg_temp.at(1), 'to', pg_temp.at(5), 'text', 'first four', 'block', pg_temp.blk()),
			jsonb_build_object('line', '4+4', 'from', pg_temp.at(6), 'to', pg_temp.at(9), 'text', null, 'block', null))), 'Level 3');
	perform pg_temp.same(pg_temp.zoom('{"callId":"z-0+4","conversation":"thread:nora","line":"0+4"}') -> 'lines', jsonb_build_array(
		jsonb_build_object('line', '0+2', 'from', pg_temp.at(1), 'to', pg_temp.at(3), 'text', 'first pair', 'block', pg_temp.blk()),
		jsonb_build_object('line', '2+2', 'from', pg_temp.at(4), 'to', pg_temp.at(5), 'text', 'second pair', 'block', pg_temp.blk())), 'Level 2');
	perform pg_temp.same(pg_temp.zoom('{"callId":"z-2+2","conversation":"thread:nora","line":"2+2"}') -> 'lines', jsonb_build_array(
		jsonb_build_object('line', '2+1', 'from', pg_temp.at(4), 'to', pg_temp.at(4), 'text', 'said', 'block', pg_temp.blk()),
		jsonb_build_object('line', '3+1', 'from', pg_temp.at(5), 'to', pg_temp.at(5), 'text', 'said', 'block', pg_temp.blk())), 'Level 1');
	perform pg_temp.same(pg_temp.zoom('{"callId":"z-4+2","conversation":"thread:nora","line":"4+2"}') -> 'lines', jsonb_build_array(
		jsonb_build_object('line', '4+1', 'from', pg_temp.at(6), 'to', pg_temp.at(6), 'text', null, 'block', null),
		jsonb_build_object('line', '5+1', 'from', pg_temp.at(7), 'to', pg_temp.at(7), 'text', null, 'block', null)), 'Lines not built');
	-- A retired tree has no lines; its dates stay.
	perform pg_temp.fx(format('update public.qorpera_memory_trees set retired_at = now() where session_id = %L',
		pg_temp.thread('94300000-0000-4000-8000-0000000000a1')));
	perform pg_temp.same(pg_temp.zoom('{"callId":"z-0+2-retired","conversation":"thread:nora","line":"0+2"}') -> 'lines', jsonb_build_array(
		jsonb_build_object('line', '0+1', 'from', pg_temp.at(1), 'to', pg_temp.at(1), 'text', null, 'block', null),
		jsonb_build_object('line', '1+1', 'from', pg_temp.at(3), 'to', pg_temp.at(3), 'text', null, 'block', null)), 'A retired tree');
	perform pg_temp.fx(format('update public.qorpera_memory_trees set retired_at = null where session_id = %L',
		pg_temp.thread('94300000-0000-4000-8000-0000000000a1')));

	foreach line in array array['8+2', '3+2', '0+3', '9+1', '0+16', '01+1', '0+0', '0+01', '', ' 0+1', '0+1 ', '-1+1', '0-1', '+1', '0+',
		'0+576460752303423488', '0+999999999999999999', '999999999999999999+999999999999999999', '0+1000000000000000000'] loop
		perform pg_temp.same(pg_temp.zoom(jsonb_build_object('callId', 'bad-' || md5(line), 'conversation', 'thread:nora', 'line', line)),
			jsonb_build_object('schema', 'qorpera.memory-zoom/v1', 'missing', 'line', 'conversation', pg_temp.nora(), 'line', line,
				'messages', 9), 'Not a line: ' || line);
	end loop;
	perform pg_temp.same(pg_temp.zoom('{"callId":"bad-group","conversation":"group:launch","line":"0+1"}') - 'conversation',
		'{"schema":"qorpera.memory-zoom/v1","missing":"line","line":"0+1","messages":0}', 'An empty conversation has no lines');
	if exists (select 1 from public.qorpera_memory_read_receipts where run_id = pg_temp.run_id() and call_id like 'bad-%') then
		raise exception 'A missing line leaves no receipt'; end if;
end $$;

-- 3. One event: as the transcript holds it, never a summary --------------------------------------------------------------

-- 634's fixture names every member "Member".
do $$
declare
	s uuid := pg_temp.thread('94300000-0000-4000-8000-0000000000a1'); run uuid := pg_temp.run_id(); want jsonb;
begin
	want := jsonb_build_array(
		pg_temp.ev(0, 1, 'message', 'member', 'Member', 'user', 'See «[quote 1]» now', p_quotes => jsonb_build_array(jsonb_build_object(
			'schema', 'qorpera.member-quote/v1', 'trust', 'untrusted_data', 'provenance', jsonb_build_object('inputId', pg_temp.input_id(1),
			'quote', 1, 'source', 'mail', 'ref', repeat('A', 43)), 'text', 'hello'))),
		pg_temp.ev(1, 3, 'message', 'agent', 'Nora', 'assistant', 'On it.', run),
		pg_temp.ev(2, 4, 'interaction_request', 'agent', 'Agent A', null, null, run, p_card_type => 'qorpera.interaction_request',
			p_card => '{"question":"Ship?"}'),
		pg_temp.ev(3, 5, 'interaction_answer', 'member', 'Member', null, null, p_card_type => 'qorpera.interaction_answer',
			p_card => '{"answer":"yes"}'),
		pg_temp.ev(4, 6, 'message', 'member', 'Member', null, null, p_erased => true),
		pg_temp.ev(5, 7, 'message', 'member', 'Member', 'user', 'Look', p_attachments => '[{"mediaType":"image/png","bytes":2048}]'),
		pg_temp.ev(6, 8, 'message', 'agent', 'Agent', 'assistant', E'First\nSecond'),
		pg_temp.ev(7, 9, 'authorization_request', 'platform', 'Qorpera', null, null, p_card_type => 'authorization_request',
			p_card => '{"tool":"send_mail"}'),
		pg_temp.ev(8, 10, 'authorization_decision', 'member', 'Member', null, null, p_card_type => 'authorization_decision',
			p_card => '{"decision":"allow"}'));
	perform pg_temp.same(public.qorpera_memory_events(s, 0, 9), want, 'The included events');
	perform pg_temp.same(public.qorpera_memory_events(s, 7, 5), jsonb_build_array(want -> 7, want -> 8), 'Events to the end');
	perform pg_temp.same(public.qorpera_memory_events(s, 9, 1), '[]', 'Past the end');
	perform pg_temp.same(pg_temp.zoom('{"callId":"e-0","conversation":"thread:nora","line":"0+1"}'), jsonb_build_object(
		'schema', 'qorpera.memory-zoom/v1', 'conversation', pg_temp.nora(), 'line', '0+1', 'messages', 9, 'from', 0, 'event', want -> 0),
		'A quoted message, fenced');
	perform pg_temp.same(pg_temp.zoom('{"callId":"e-4","conversation":"thread:nora","line":"4+1"}') -> 'event', want -> 4,
		'An erased event');
	perform pg_temp.same(pg_temp.zoom('{"callId":"e-8","conversation":"thread:nora","line":"8+1","from":2048}') -> 'event', want -> 8,
		'The last event');
	-- A message whose quotes cannot be fenced carries no text: never the «» text.
	perform pg_temp.fx(format('update public.qorpera_session_inputs set body = %L where id = %L', '{"text":"See «hello» now"}',
		pg_temp.input_id(1)));
	perform pg_temp.same(public.qorpera_memory_events(s, 0, 1) -> 0 -> 'text', 'null', 'An unfenced quote');
	perform pg_temp.fx(format('update public.qorpera_session_inputs set body = %L where id = %L',
		jsonb_build_object('text', 'See «hello» now', 'quotes', jsonb_build_array(jsonb_build_object('start', 5, 'end', 10, 'source', 'mail',
			'ref', repeat('A', 43)))), pg_temp.input_id(1)));
end $$;

-- 4. No line: the tree, every line with its block --------------------------------------------------------------------

do $$
declare s uuid := pg_temp.thread('94300000-0000-4000-8000-0000000000a1'); tree jsonb; line jsonb;
begin
	tree := jsonb_build_object('sessionId', s, 'generation', (select memory_generation from public.qorpera_shared_sessions where id = s),
		'messages', 9, 'root', 'QorperaOS/agents/nora/memory/thread', 'nodeBytes', 1024, 'blocks', jsonb_build_array(pg_temp.blk()), 'lines', '[]'::jsonb);
	foreach line in array array['{"l":0,"k":0,"text":"said"}', '{"l":0,"k":1,"text":"said"}', '{"l":0,"k":2,"text":"said"}',
		'{"l":0,"k":3,"text":"said"}', '{"l":1,"k":0,"text":"first pair"}', '{"l":1,"k":1,"text":"second pair"}',
		'{"l":2,"k":0,"text":"first four"}']::jsonb[] loop
		tree := jsonb_set(tree, '{lines}', (tree -> 'lines') || jsonb_build_array(line || '{"block":0}'));
	end loop;
	perform pg_temp.same(pg_temp.zoom('{"callId":"t-1","conversation":"thread:nora"}'), jsonb_build_object('schema', 'qorpera.memory-zoom/v1',
		'conversation', pg_temp.nora(), 'line', null, 'messages', 9, 'from', 0, 'tree', tree), 'The tree');
	perform pg_temp.same(public.qorpera_memory_tree_read('63400000-0000-4000-8000-000000000020', s), tree, 'The tree read');
	perform pg_temp.same(public.qorpera_memory_tree_read('63400000-0000-4000-8000-000000000020', extensions.gen_random_uuid()), null,
		'No conversation');
	if public.qorpera_memory_tree_read(extensions.gen_random_uuid(), s) is not null then
		raise exception 'Another environment''s conversation'; end if;
end $$;

-- 5. Receipts: one per call, by target and range; a retry keeps it; the call id for another read refuses -------------

do $$
declare
	s uuid := pg_temp.thread('94300000-0000-4000-8000-0000000000a1');
	own uuid := (select session_id from public.qorpera_execution_runs where id = pg_temp.run_id());
	otto uuid := pg_temp.thread('94300000-0000-4000-8000-0000000000a2');
	launch uuid := (select session_id from public.qorpera_company_rooms where id = '94300000-0000-4000-8000-0000000000b1');
	first jsonb; call text;
begin
	perform pg_temp.same(pg_temp.receipts(), jsonb_build_array(
		jsonb_build_array('e-0', 'zoom', s, 0, 1, 0), jsonb_build_array('e-4', 'zoom', s, 4, 1, 0), jsonb_build_array('e-8', 'zoom', s, 8, 1, 2048),
		jsonb_build_array('group-1', 'zoom', launch, 0, 0, 0), jsonb_build_array('nora-upper', 'zoom', s, 8, 1, 0),
		jsonb_build_array('otto-1', 'zoom', otto, 0, 0, 0), jsonb_build_array('own-1', 'zoom', own, 0, 0, 0),
		jsonb_build_array('own-2', 'zoom', own, 0, 0, 0), jsonb_build_array('own-3', 'zoom', own, 0, 0, 0),
		jsonb_build_array('t-1', 'zoom', s, 0, 9, 0), jsonb_build_array('z-0+2-retired', 'zoom', s, 0, 2, 0),
		jsonb_build_array('z-0+4', 'zoom', s, 0, 4, 0), jsonb_build_array('z-0+8', 'zoom', s, 0, 8, 0),
		jsonb_build_array('z-2+2', 'zoom', s, 2, 2, 0), jsonb_build_array('z-4+2', 'zoom', s, 4, 2, 0)), 'The receipts');
	if exists (select 1 from public.qorpera_memory_read_receipts where run_id = pg_temp.run_id()
		and (environment_id <> '63400000-0000-4000-8000-000000000020' or target_run_id is not null or operation_receipt_id is not null)) then
		raise exception 'A receipt is the environment''s, of a conversation'; end if;

	-- A retry answers again and keeps its receipt.
	first := pg_temp.zoom('{"callId":"z-0+8","conversation":"thread:nora","line":"0+8"}');
	perform pg_temp.same(pg_temp.zoom('{"callId":"z-0+8","conversation":"thread:NORA","line":"0+8"}') - 'conversation',
		first - 'conversation', 'A retry');
	perform pg_temp.same(pg_temp.zoom('{"callId":"e-8","conversation":"thread:nora","line":"8+1","from":2048}') -> 'line', '"8+1"',
		'A retry with from');
	-- The same call id for another read refuses: another line, start, from, conversation or tool.
	foreach call in array array['{"callId":"z-0+8","conversation":"thread:nora","line":"0+4"}',
		'{"callId":"z-4+2","conversation":"thread:nora","line":"6+2"}', '{"callId":"z-0+8","conversation":"thread:nora","line":"0+8","from":1}',
		'{"callId":"z-2+2","conversation":"thread:nora"}', '{"callId":"e-0","conversation":"thread:nora","line":"8+1"}',
		'{"callId":"t-1","conversation":"thread:nora","line":"0+8"}', '{"callId":"own-1","conversation":"thread:nora"}',
		'{"callId":"context-1","conversation":"thread:nora","line":"0+1"}'] loop
		if call like '%context-1%' then
			perform pg_temp.fx(format('insert into public.qorpera_memory_read_receipts(environment_id, run_id, call_id, tool, target_session_id,
				start, size) values (%L, %L, %L, %L, %L, 0, 1) on conflict do nothing', '63400000-0000-4000-8000-000000000020', pg_temp.run_id(),
				'context-1', 'read_context', s));
		end if;
		perform pg_temp.raises(format('select public.qorpera_memory_zoom(%L, %L)', pg_temp.b(), call), '22023');
	end loop;

	-- A zoom with no line covers the conversation as read: a retry after another event widens its receipt.
	perform pg_temp.event(s, 11, 'message', '{"entry":{"message":{"role":"user","content":"More"}}}');
	perform pg_temp.same(pg_temp.zoom('{"callId":"t-1","conversation":"thread:nora"}') -> 'tree' -> 'messages', '10', 'The tree read again');
	perform pg_temp.same((select to_jsonb(array[start, size]) from public.qorpera_memory_read_receipts where run_id = pg_temp.run_id()
		and call_id = 't-1'), '[0, 10]', 'The receipt covers what was read');
	perform pg_temp.same(pg_temp.zoom('{"callId":"z-8+2","conversation":"thread:nora","line":"8+2"}') -> 'lines' -> 1,
		jsonb_build_object('line', '9+1', 'from', pg_temp.at(11), 'to', pg_temp.at(11), 'text', null, 'block', null), 'The new event');
	if (select count(*) from public.qorpera_memory_read_receipts where run_id = pg_temp.run_id()) <> 17 then
		raise exception 'Retries add no receipt'; end if;
end $$;

-- 6. Malformed requests refuse (22023); the run check comes first -----------------------------------------------------

do $$
declare request text;
begin
	foreach request in array array['[]', '"zoom"', '1', '{}', '{"callId":""}', '{"callId":5}', '{"callId":null}',
		format('{"callId":"%s"}', repeat('c', 257)), '{"callId":"m","depth":1}', '{"callId":"m","conversation":5}',
		'{"callId":"m","conversation":["."]}', '{"callId":"m","line":8}', '{"callId":"m","line":{"start":0}}', '{"callId":"m","from":"3"}',
		'{"callId":"m","from":-1}', '{"callId":"m","from":1.5}', '{"callId":"m","from":12345678901234567}',
		'{"callId":"m","from":9007199254740992}', '{"callId":"m","from":true}'] loop
		perform pg_temp.raises(format('select public.qorpera_memory_zoom(%L, %L)', pg_temp.b(), request), '22023');
	end loop;
	perform pg_temp.raises(format('select public.qorpera_memory_zoom(%L, null)', pg_temp.b()), '22023');
	if exists (select 1 from public.qorpera_memory_read_receipts where run_id = pg_temp.run_id() and call_id = 'm') then
		raise exception 'A malformed request leaves no receipt'; end if;
	-- The edges that are well formed.
	perform pg_temp.same(pg_temp.zoom(jsonb_build_object('callId', repeat('c', 256), 'from', 9007199254740991)) -> 'from',
		'9007199254740991', 'The largest from');
	-- The run check comes before the request's: a run whose lease is gone refuses whatever the request (the block's
	-- rollback restores it).
	begin
		perform pg_temp.fx(format('delete from public.qorpera_execution_run_budgets where run_id = %L', pg_temp.run_id()));
		perform public.qorpera_memory_zoom(pg_temp.b(), '[]');
		raise exception 'A run with no lease' using errcode = 'QTF02';
	exception when others then
		if sqlstate <> '42501' then raise; end if;
	end;
	if not exists (select 1 from public.qorpera_execution_run_budgets where run_id = pg_temp.run_id()) then
		raise exception 'The run''s budget is back'; end if;
end $$;

-- 7. The grants, the call list and the observation vocabulary ---------------------------------------------------------

do $$
declare v_bad text;
begin
	select string_agg(f || ' ' || r, ', ') into v_bad
	from unnest(array['public.qorpera_memory_zoom(jsonb,jsonb)', 'public.qorpera_memory_conversation(uuid,text,uuid)',
		'public.qorpera_memory_event(uuid,public.qorpera_session_events,bigint)', 'public.qorpera_memory_events(uuid,bigint,integer)',
		'public.qorpera_memory_tree_read(uuid,uuid)']) f,
		unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, f, 'execute') is distinct from (f = 'public.qorpera_memory_zoom(jsonb,jsonb)' and r = 'service_role');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	if not (select p.prosecdef from pg_proc p where p.oid = 'public.qorpera_memory_zoom(jsonb,jsonb)'::regprocedure)
		or exists (select 1 from pg_proc p where p.oid in ('public.qorpera_memory_conversation(uuid,text,uuid)'::regprocedure,
			'public.qorpera_memory_event(uuid,public.qorpera_session_events,bigint)'::regprocedure,
			'public.qorpera_memory_events(uuid,bigint,integer)'::regprocedure, 'public.qorpera_memory_tree_read(uuid,uuid)'::regprocedure)
			and (p.prosecdef or p.provolatile <> 's')) then
		raise exception 'zoom is the one definer; its helpers are stable invokers'; end if;
	perform pg_temp.same((select to_jsonb(array[c.scope, c.budget]) from public.qorpera_native_host_calls c where c.name = 'qorpera_memory_zoom'),
		'["binding", "standard"]', 'The call list');
	if pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)
		not like '%''apply_proposal'',''discard_proposal'',/* 20260930202000 (M1b-3) */''zoom'',%' then
		raise exception 'zoom joins the observation vocabulary'; end if;
end $$;

rollback;
