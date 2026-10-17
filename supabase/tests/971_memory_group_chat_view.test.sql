-- @fixture 970_memory_branches.test.sql until "-- The checks start here."
-- Summary trees M4c (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §5.3, §5.5; 20260930310000): a group-chat run's
-- primary view and branches, on the host calls 946 and 970 test for a thread run. The view: the chat as `.`, T before
-- the post that woke the run, the chat's tree under agents/groups/<group>/memory, the same for every agent in the chat;
-- its record names the chat. The branches: the agent's thread and its other group chats, never the chat itself, with
-- their trees. On 970's fixture: the launch chat (Nora and Otto) has messages at 1-3, Nora's thread 10-11, Otto's
-- thread 5 and a tree with one line.

-- A view call, a record call and a record request (as 946), and T and the last sequence of a run's view.
create function pg_temp.view(p_who text) returns jsonb language sql as $$
	select public.qorpera_memory_view(pg_temp.b(p_who))
$$;
create function pg_temp.record_view(p_who text, p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_memory_view_record(pg_temp.b(p_who), p_request)
$$;
create function pg_temp.request(p_step integer) returns jsonb language sql as $$
	select jsonb_build_object('step', p_step, 'messages', 2, 'headBytes', 2048, 'viewBytes', 512, 'branchesBytes', 128,
		'runViewBytes', 0, 'rawSteps', 0, 'placeholders', 0, 'waitMs', 0, 'waitedLines', 0, 'folded', false,
		'stablePrefixSha256', repeat('cd', 32))
$$;
create function pg_temp.t(p_who text) returns jsonb language sql as $$
	select jsonb_build_array(v -> 'messages', v -> 'lastSequence') from (select pg_temp.view(p_who) as v) x
$$;
-- The id of the fixture's event at a sequence number.
create function pg_temp.event_id(p_seq bigint) returns uuid language sql immutable as $$
	select ('97000000-0000-4000-8000-e' || lpad(p_seq::text, 11, '0'))::uuid
$$;

-- The setup (the company chose the beta in 970's): the launch chat's tree, a line for each of its messages; Nora's and
-- Otto's runs made the runs a member's post at 3 in the chat wakes (as 20260928289620's room post does): the post an
-- input of the chat's whose event is the one at 3, its poster one of the chat's people, each run the room delivery of a
-- room wake that names the post, with the transcript start at the post.
do $$
declare
	r jsonb; i integer; launch uuid := pg_temp.chat('launch'); root constant text := 'agents/groups/launch/memory';
	post constant uuid := pg_temp.event_id(3); poster constant uuid := '63400000-0000-4000-8000-000000000002'; who text;
begin
	r := pg_temp.memory('group-chat-tree', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(launch)), jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(root || '/t0/00000000.jsonl',
			pg_temp.line0(0, 1) || E'\n' || pg_temp.line0(1, 2) || E'\n' || pg_temp.line0(2, 3) || E'\n')), launch);
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.fx(format('insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256) values (%L, %L, %L, %L, %L, %L, %L, %L)', post, launch, extensions.gen_random_uuid(),
		poster, 'human', 'user_message', '63400000-0000-4000-8000-0000000000b2', repeat('b', 64)));
	perform pg_temp.fx(format('insert into public.qorpera_company_room_members(room_id, principal_kind, principal_id, status,
		source_path_version) values (%L, %L, %L, %L, %L)', pg_temp.id('launch'), 'member', poster, 'active', extensions.gen_random_uuid()));
	foreach who in array array['nora', 'otto'] loop
		perform pg_temp.fx(format('update public.qorpera_wake_occurrences set session_id = %L, wake_kind = %L, source_kind = %L,
			source_id = %L, trigger_id = %L, payload = %L where run_id = %L', launch, 'room', 'room', post, 'room',
			jsonb_build_object('roomId', pg_temp.id('launch'), 'inputIds', jsonb_build_array(post), 'recipientStaffId', pg_temp.id(who)),
			pg_temp.run_id(who)));
		perform pg_temp.fx(format('update public.qorpera_execution_runs set session_id = %L, source_kind = %L, source_id = (select id
			from public.qorpera_wake_occurrences where run_id = %L), input_ids = %L, transcript_start_sequence = 3 where id = %L', launch,
			'room_delivery', pg_temp.run_id(who), '{}', pg_temp.run_id(who)));
	end loop;
end $$;

-- The checks start here.

-- 1. The view: the chat, by its name, T up to the post that woke the run, and the chat's tree, its line for the post past
-- T; the same for each agent in the chat. A wake that names no post of the chat's: T up to the transcript start ---------

do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; launch uuid := pg_temp.chat('launch');
	wake jsonb := (select payload from public.qorpera_wake_occurrences where run_id = pg_temp.run_id('nora'));
begin
	perform pg_temp.same(pg_temp.view('nora') - 'tree', jsonb_build_object('schema', 'qorpera.memory-view/v1',
		'conversation', jsonb_build_object('sessionId', launch, 'kind', 'group', 'name', 'Launch'), 'messages', 2, 'lastSequence', 2),
		'Nora''s view of the launch chat, up to the post');
	perform pg_temp.same(pg_temp.view('nora') -> 'tree', public.qorpera_memory_tree_read(env, launch), 'The chat''s tree');
	perform pg_temp.same(jsonb_build_array(pg_temp.view('nora') #> '{tree,root}', pg_temp.view('nora') #> '{tree,messages}',
		jsonb_array_length(pg_temp.view('nora') #> '{tree,lines}'), pg_temp.view('nora') #> '{tree,blocks,0,path}'),
		'["agents/groups/launch/memory", 3, 3, "agents/groups/launch/memory/t0/00000000.jsonl"]',
		'The tree under the group''s folder, with its line for the post');
	perform pg_temp.same(pg_temp.view('otto'), pg_temp.view('nora'), 'Otto''s view is the same');

	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L', '{}', pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t('nora'), '[3, 3]', 'No post named');
	-- A post in another conversation (Nora's thread) is none of the chat's.
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L',
		jsonb_build_object('inputIds', jsonb_build_array(pg_temp.event_id(10))), pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t('nora'), '[3, 3]', 'A post elsewhere');
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L', wake, pg_temp.run_id('nora')));
	perform pg_temp.same(pg_temp.t('nora'), '[2, 2]', 'The post again');
end $$;

-- 2. The record names the chat ------------------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.same(pg_temp.record_view('nora', pg_temp.request(0)) -> 'step', '0', 'Recorded');
	perform pg_temp.same((select jsonb_build_array(v.session_id, v.staff_agent_id, v.messages) from public.qorpera_memory_views v
		where v.run_id = pg_temp.run_id('nora')), jsonb_build_array(pg_temp.chat('launch'), pg_temp.id('nora'), 2), 'The row');
end $$;

-- 3. The branches: the agent's thread and its other group chats, the most recently active first, never the chat; the
-- trees a request names, the chat's left out --------------------------------------------------------------------------

do $$
declare
	env constant uuid := '63400000-0000-4000-8000-000000000020'; launch uuid := pg_temp.chat('launch');
	otto uuid := pg_temp.thread('otto'); answer jsonb;
begin
	perform pg_temp.same(pg_temp.branches('nora'), jsonb_build_object('schema', 'qorpera.memory-branches/v1',
		'branches', jsonb_build_array(pg_temp.br('group:board', 'Board', pg_temp.chat('board'), 1),
			pg_temp.br('group:press', 'Press', pg_temp.chat('press'), 1), pg_temp.br('group:design', 'Design', pg_temp.chat('design'), 1),
			pg_temp.br('thread:nora', 'Nora', pg_temp.thread('nora'), 2), pg_temp.br('group:hiring', 'Hiring', pg_temp.chat('hiring'), 0)),
		'trees', '[]'::jsonb), 'Nora''s branches in the launch chat');
	perform pg_temp.same(pg_temp.branches('nora', jsonb_build_object('sessions', jsonb_build_array(launch, pg_temp.thread('nora')))) -> 'trees',
		jsonb_build_array(public.qorpera_memory_tree_read(env, pg_temp.thread('nora'))), 'Her thread''s tree, not the chat''s');

	perform pg_temp.same(pg_temp.branches('otto') -> 'branches', jsonb_build_array(pg_temp.br('group:ops', 'Ops', pg_temp.chat('ops'), 1),
		pg_temp.br('thread:otto', 'Otto', otto, 1)), 'Otto''s branches in the launch chat');
	answer := pg_temp.branches('otto', jsonb_build_object('sessions', jsonb_build_array(otto, launch)));
	perform pg_temp.same(answer -> 'trees', jsonb_build_array(public.qorpera_memory_tree_read(env, otto)), 'His thread''s tree');
	perform pg_temp.same(jsonb_build_array(answer #> '{trees,0,root}', jsonb_array_length(answer #> '{trees,0,lines}')),
		'["agents/otto/memory/thread", 1]', 'With its line');
end $$;

rollback;
