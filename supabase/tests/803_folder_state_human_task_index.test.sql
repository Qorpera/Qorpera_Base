-- @fixture 785_folder_state_human_tasks_contacts.test.sql until "-- 1. A folder renamed onto a root"
-- Company state files, H2b (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (H2)"): human tasks and contacts on
-- the folder core. The index; the person's change (one tick, done with its proof, declined with its reason); the
-- company's side and its final states; references checked when set or changed; a task's folder that never outlives its
-- file and belongs to its person while the task is open; contacts that stay while a task names them; the platform's
-- narrow rights; the rank-5 row locks; the seeded roots. No wakes (H2c).

-- 785's company: Nora (a1) asks; member 02 is the person of pg_temp.task; the owner (01) is the company's side.
create function pg_temp.agent(p_id uuid default '70700000-0000-4000-8000-0000000000a1') returns jsonb language sql as $$
	select jsonb_build_object('kind','staff_agent','staffAgentId',p_id,'requesterUserId','70700000-0000-4000-8000-000000000001',
		'sessionKind','in_house','runId','80300000-0000-4000-8000-0000000000ff','audience',jsonb_build_object('kind','company'))
$$;
-- The decision an agent's run would get for one unit (its commit needs a run; the rules are the same).
create function pg_temp.decide(p_actor jsonb, p_unit jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_structured_decide('70700000-0000-4000-8000-000000000020', p_actor, extensions.gen_random_uuid(), 1,
		p_unit, coalesce(p_unit ->> 'from', p_unit ->> 'path'), p_unit ->> 'to')
$$;
-- The decision for a change set that read the folder at an early commit: what changed since is a conflict.
create function pg_temp.decide_at(p_commit text, p_actor jsonb, p_unit jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_structured_decide('70700000-0000-4000-8000-000000000020', p_actor,
		(select id from public.qorpera_folder_commits where environment_id = '70700000-0000-4000-8000-000000000020' and operation_key = p_commit),
		1, p_unit, coalesce(p_unit ->> 'from', p_unit ->> 'path'), p_unit ->> 'to')
$$;
create function pg_temp.idx(p_id uuid) returns public.qorpera_folder_human_task_index language sql as $$
	select * from public.qorpera_folder_human_task_index where environment_id = '70700000-0000-4000-8000-000000000020' and id = p_id
$$;
create function pg_temp.put(p_path text, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text))
		|| case when pg_temp.version(p_path) is null then '{}'::jsonb else jsonb_build_object('expectedVersion', pg_temp.version(p_path)) end
$$;
create function pg_temp.mkdir(p_path text) returns jsonb language sql as $$ select jsonb_build_object('op','mkdir','path',p_path) $$;
create function pg_temp.del(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op','delete','path',p_path,'expectedVersion',pg_temp.version(p_path),'asOfSeq',pg_temp.seq())
$$;
-- One unit, as one actor; the outcome and reason of its only unit.
create function pg_temp.one(p_actor jsonb, p_key text, p_unit jsonb) returns text language sql as $$
	select (r -> 'units' -> 0 ->> 'outcome') || coalesce('/' || (r -> 'units' -> 0 ->> 'reason'), '')
		|| coalesce(': ' || (r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'), '')
	from (select pg_temp.commit(p_actor, p_key, jsonb_build_array(p_unit)) as r) x
$$;
create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is null or (p_got <> p_want and p_got not like p_want) then
		raise exception '%: expected %, got %', p_what, p_want, p_got using errcode = 'QTF01'; end if;
end $$;

-- 1. The company: a second agent, the roots, two todos, a viewer, contacts with and without email, a connection --------

do $$
declare r jsonb;
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-hire', pg_temp.hire('otto', '70700000-0000-4000-8000-0000000000a2', 'Otto')),
		'saved', 'Otto is hired');
	r := pg_temp.commit(pg_temp.owner(), 'human-roots', jsonb_build_array(pg_temp.mkdir('human-tasks'), pg_temp.mkdir('contacts'),
		pg_temp.todo('agents/nora/todos/order-disk.md', '80300000-0000-4000-8000-0000000000d1', 'Order the disk', 'blocked'),
		pg_temp.todo('agents/otto/todos/other.md', '80300000-0000-4000-8000-0000000000d2', 'Other work'),
		pg_temp.save('contacts/maria.md', pg_temp.contact()),
		pg_temp.save('contacts/no-mail.md', pg_temp.contact('{"id":"80300000-0000-4000-8000-0000000000f3","email":null}'))));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
		('70700000-0000-4000-8000-000000000010','70700000-0000-4000-8000-000000000003','todos-stranger@example.test','Viewer','viewer');
	insert into public.qorpera_folder_connection_index(secret_id, environment_id, profile_id, folder_path, folder_path_version, commit_id, purpose)
	values ('80300000-0000-4000-8000-0000000000c9', '70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010',
		'connections/portal.md', extensions.gen_random_uuid(), extensions.gen_random_uuid(), '');
end $$;

-- 2. A new task: open, due in the future, from an active agent (the run's own), and its references ---------------------

do $$
declare ok constant text := 'saved'; x public.qorpera_folder_human_task_index;
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-1', pg_temp.save('human-tasks/fit-disk.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e1', '{"todo":"80300000-0000-4000-8000-0000000000d1",
			"connection":"80300000-0000-4000-8000-0000000000c9"}'))), ok, 'a member creates a task for another member');
	x := pg_temp.idx('80300000-0000-4000-8000-0000000000e1');
	if x.status is distinct from 'open' or x.member_user_id is distinct from '70700000-0000-4000-8000-000000000002'
		or x.from_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a1' or x.folder_path is distinct from 'human-tasks/fit-disk.md'
		or x.started_by_user_id is distinct from '70700000-0000-4000-8000-000000000001' or x.due_at is distinct from '2099-10-20T12:00:00Z'
		or x.todo_id is distinct from '80300000-0000-4000-8000-0000000000d1' or x.title is distinct from 'Fit the new disk in node 2'
		or x.folder_path_version is distinct from pg_temp.version('human-tasks/fit-disk.md') or x.retired_at is not null then
		raise exception 'The task is indexed: %', to_jsonb(x); end if;
	-- The person's own task, started by them: they pay for its wakes.
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-new-2', pg_temp.save('human-tasks/own.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e2'))), ok, 'a member makes a task for themselves');
	if (pg_temp.idx('80300000-0000-4000-8000-0000000000e2')).started_by_user_id is distinct from '70700000-0000-4000-8000-000000000002' then
		raise exception 'started_by_user_id is the creating commit''s member'; end if;
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-3', pg_temp.save('human-tasks/bad.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3', '{"status":"done"}'))), 'refused/structured_rule: a new task is open', 'new done');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-4', pg_temp.save('human-tasks/bad.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3', '{"due":"2001-01-01T00:00:00Z"}'))), 'refused/structured_rule: due is in the future',
		'a past due');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-5', pg_temp.save('human-tasks/bad.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3', '{"from":"80300000-0000-4000-8000-0000000000aa"}'))),
		'refused/structured_rule: from is an active agent%', 'an unknown from');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-6', pg_temp.save('human-tasks/bad.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3', '{"member":"70700000-0000-4000-8000-000000000003"}'))),
		'refused/structured_rule: member is a member of this company who can write%', 'a viewer is never a task''s person');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-7', pg_temp.save('human-tasks/bad.md',
		pg_temp.contact_task('{"id":"80300000-0000-4000-8000-0000000000e3","contact":"80300000-0000-4000-8000-0000000000f3"}'))),
		'refused/structured_rule: contact is a contact file of this company with an email', 'a contact without email');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-8', pg_temp.save('human-tasks/bad.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3', '{"todo":"80300000-0000-4000-8000-0000000000d2"}'))),
		'refused/structured_rule: todo is an open or blocked todo of the from agent', 'another agent''s todo');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-9', pg_temp.save('human-tasks/bad.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3', '{"connection":"80300000-0000-4000-8000-0000000000ca"}'))),
		'refused/structured_rule: connection is a connection file of this company', 'an unknown connection');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-new-10', pg_temp.save('human-tasks/bad.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3'))), 'refused/structured_rule: the platform never creates a task', 'platform');
	-- An agent's run creates a task from itself.
	perform pg_temp.is(pg_temp.decide(pg_temp.agent(), pg_temp.save('human-tasks/by-nora.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3'))) ->> 'ok', 'true', 'Nora''s run creates a task from Nora');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent('70700000-0000-4000-8000-0000000000a2'), pg_temp.save('human-tasks/by-otto.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e3'))) -> 'problems' -> 0 ->> 'message',
		'a task you create is from you: from is your own id', 'Otto''s run cannot create a task from Nora');
	-- One id, one file: not at another name, and the file never changes its id.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-11', pg_temp.save('human-tasks/copy.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e1'))), 'refused/structured_rule: this task already has the file human-tasks/fit-disk.md',
		'an id at a second name');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-new-12', pg_temp.save('human-tasks/fit-disk.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e4'))), 'refused/structured_rule: id never changes%', 'a new id at the same file');
end $$;

-- 3. The person's change: one tick; done with every listed proof; declined with its reason; nothing else ---------------

do $$
declare t jsonb := pg_temp.task('80300000-0000-4000-8000-0000000000e1', '{"todo":"80300000-0000-4000-8000-0000000000d1",
	"connection":"80300000-0000-4000-8000-0000000000c9"}');
	ticked jsonb;
begin
	ticked := t || jsonb_build_object('instructions', E'## Steps\n- [x] Fit it in slot 2\n- [x] Agree a window',
		'steps', '[{"line":15,"text":"Fit it in slot 2","done":true},{"line":16,"text":"Agree a window","done":true}]'::jsonb);
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-1', pg_temp.save('human-tasks/fit-disk.md', ticked)), 'saved', 'the person ticks');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-2', pg_temp.save('human-tasks/fit-disk.md', ticked || '{"title":"Mine now"}')),
		'refused/structured_rule: as the task''s person you may only tick%', 'the person changes the title');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-3', pg_temp.save('human-tasks/fit-disk.md', ticked || jsonb_build_object(
		'instructions', E'## Steps\n- [x] Fit it anywhere\n- [x] Agree a window',
		'steps', '[{"line":15,"text":"Fit it anywhere","done":true},{"line":16,"text":"Agree a window","done":true}]'::jsonb))),
		'refused/structured_rule: as the task''s person you may only tick%', 'the person rewrites a step');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-3b', pg_temp.save('human-tasks/fit-disk.md', ticked || jsonb_build_object(
		'instructions', E'Bring a screwdriver.\n## Steps\n- [x] Fit it in slot 2\n- [x] Agree a window'))),
		'refused/structured_rule: as the task''s person you may only tick%', 'the person adds a line outside the steps');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-4', pg_temp.save('human-tasks/fit-disk.md', ticked || '{"status":"cancelled"}')),
		'refused/structured_rule: as the task''s person you may tick its steps, or mark it done or declined', 'the person cancels');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-5', pg_temp.save('human-tasks/fit-disk.md', ticked || '{"status":"done"}')),
		'refused/structured_rule: done needs the proof the task asks for: photo, note', 'done without proof');
	-- The folder is the person's while the task is open: not the company's, and not an agent's.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-p-6', pg_temp.mkdir('human-tasks/fit-disk')),
		'refused/structured_rule: only the task''s person adds to its folder while the task is open', 'the owner makes the folder');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent(), pg_temp.mkdir('human-tasks/fit-disk')) -> 'problems' -> 0 ->> 'message',
		'only the task''s person adds to its folder while the task is open', 'Nora makes the folder');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-7', jsonb_build_object('op','new_folder','path','human-tasks/fit-disk',
		'contents', jsonb_build_array(jsonb_build_object('path','proof','kind','folder')))), 'saved', 'the person makes the folder');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-8', pg_temp.put('human-tasks/fit-disk/proof/photo-1.jpg', 'a photo')), 'saved',
		'the person adds a photo');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-9', pg_temp.put('human-tasks/fit-disk/note.md', '')), 'saved', 'an empty note');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-10', pg_temp.save('human-tasks/fit-disk.md', ticked || '{"status":"done"}')),
		'refused/structured_rule: done needs the proof the task asks for: note', 'an empty note is no note');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-11', pg_temp.put('human-tasks/fit-disk/note.md', 'Back up at 14:10.')), 'saved',
		'the person writes the note');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-12', pg_temp.save('human-tasks/fit-disk.md', ticked || '{"status":"done"}')),
		'saved', 'done with its proof');
	-- The person's save does not make them the task's starter.
	if (pg_temp.idx('80300000-0000-4000-8000-0000000000e1')).started_by_user_id is distinct from '70700000-0000-4000-8000-000000000001' then
		raise exception 'started_by_user_id stays the creating commit''s member after the person''s save'; end if;
	-- Done: the folder stays as it is while the agent checks it; the person's part is over.
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-13', pg_temp.put('human-tasks/fit-disk/proof/photo-2.jpg', 'another')),
		'refused/structured_rule: the task is done:%', 'more proof after done');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-p-14', pg_temp.del('human-tasks/fit-disk/proof/photo-1.jpg')),
		'refused/structured_rule: the task is done:%', 'the owner deletes proof of a done task');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-p-15', pg_temp.save('human-tasks/fit-disk.md', ticked || '{"status":"declined","reason":"x"}')),
		'refused/structured_rule: this task is done; it is no longer yours to change', 'the person after done');
	if (pg_temp.idx('80300000-0000-4000-8000-0000000000e1')).status is distinct from 'done' then raise exception 'The index says done'; end if;
end $$;

-- 4. The company's side: done is the person's; returned goes back with a reason and a new due; final never changes -----

do $$
declare t jsonb := pg_temp.task('80300000-0000-4000-8000-0000000000e1', '{"todo":"80300000-0000-4000-8000-0000000000d1",
	"connection":"80300000-0000-4000-8000-0000000000c9"}') || jsonb_build_object('instructions', E'## Steps\n- [x] Fit it in slot 2\n- [x] Agree a window',
		'steps', '[{"line":15,"text":"Fit it in slot 2","done":true},{"line":16,"text":"Agree a window","done":true}]'::jsonb);
	own jsonb := pg_temp.task('80300000-0000-4000-8000-0000000000e2');
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-1', pg_temp.save('human-tasks/own.md', own || '{"status":"done"}')),
		'refused/structured_rule: done is the task''s person''s to set', 'the company sets done');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-2', pg_temp.save('human-tasks/own.md', own || '{"status":"accepted"}')),
		'refused/structured_rule: a open task cannot become accepted', 'accepting an open task');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-3', pg_temp.save('human-tasks/fit-disk.md', t || '{"status":"cancelled"}')),
		'refused/structured_rule: cancelling a done task needs a reason%', 'cancelling done work without a reason');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-4', pg_temp.save('human-tasks/fit-disk.md', t
		|| '{"status":"returned","reason":"The serial is not readable","due":"2001-01-01T00:00:00Z"}')),
		'refused/structured_rule: due is in the future', 'returned with a past due');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-5', pg_temp.save('human-tasks/fit-disk.md', t
		|| '{"status":"returned","reason":"The serial is not readable","due":"2099-11-01T00:00:00Z"}')), 'saved', 'returned');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-c-5b', pg_temp.save('human-tasks/fit-disk.md', t
		|| '{"status":"returned","reason":"It was readable","due":"2099-11-01T00:00:00Z"}')),
		'refused/structured_rule: as the task''s person you may only tick%', 'the person rewrites the reason');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-5c', pg_temp.del('human-tasks/fit-disk/proof/photo-1.jpg')),
		'refused/structured_rule: only the task''s person changes its folder while the task is returned', 'the owner deletes the person''s proof');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent('70700000-0000-4000-8000-0000000000a2'), jsonb_build_object('op','move',
		'from','human-tasks/fit-disk/proof/photo-1.jpg','to','human-tasks/fit-disk/proof/photo-9.jpg',
		'expectedVersion',pg_temp.version('human-tasks/fit-disk/proof/photo-1.jpg'))) -> 'problems' -> 0 ->> 'message',
		'only the task''s person changes its folder while the task is returned', 'an agent renames the person''s proof');
	-- Returned is the person's again: more proof, then done (which drops the reason).
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-c-6', pg_temp.put('human-tasks/fit-disk/proof/photo-2.jpg', 'sharper')), 'saved',
		'proof after a return');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-c-7', pg_temp.save('human-tasks/fit-disk.md', t
		|| '{"status":"done","due":"2099-11-01T00:00:00Z"}')), 'saved', 'done again');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-8', pg_temp.save('human-tasks/fit-disk.md', t
		|| '{"status":"accepted","due":"2099-11-01T00:00:00Z"}')), 'saved', 'accepted');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-9', pg_temp.save('human-tasks/fit-disk.md', t
		|| '{"status":"accepted","due":"2099-11-01T00:00:00Z","title":"Done long ago"}')),
		'refused/structured_rule: a accepted task is final; it never changes', 'a final task');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-c-10', pg_temp.put('human-tasks/fit-disk/proof/photo-3.jpg', 'late')),
		'refused/structured_rule: a accepted task''s folder takes nothing new', 'proof after accepted');
	-- Declined by the person, with its reason; final too.
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-c-11', pg_temp.save('human-tasks/own.md', own
		|| '{"status":"declined","reason":"I am away that week"}')), 'saved', 'declined');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-12', pg_temp.save('human-tasks/own.md', own
		|| '{"status":"cancelled","reason":"x"}')), 'refused/structured_rule: a declined task is final; it never changes', 'after declined');
	-- An owner who is a task's person never acts as the company on it.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-13', pg_temp.save('human-tasks/owners.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e5', '{"member":"70700000-0000-4000-8000-000000000001"}'))), 'saved',
		'a task for the owner');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-c-14', pg_temp.save('human-tasks/owners.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e5', '{"member":"70700000-0000-4000-8000-000000000001","status":"cancelled"}'))),
		'refused/structured_rule: as the task''s person you may tick its steps, or mark it done or declined', 'the owner cancels their own');
	-- Who started a task never changes with later saves by others.
	if (pg_temp.idx('80300000-0000-4000-8000-0000000000e1')).started_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or (pg_temp.idx('80300000-0000-4000-8000-0000000000e2')).started_by_user_id is distinct from '70700000-0000-4000-8000-000000000002' then
		raise exception 'started_by_user_id stays the creating commit''s member'; end if;
end $$;

-- 5. Hand-offs and references: checked when set or changed, never on the person's change --------------------------------

do $$
declare t jsonb := pg_temp.task('80300000-0000-4000-8000-0000000000e6', '{"todo":"80300000-0000-4000-8000-0000000000d1"}');
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-h-1', pg_temp.save('human-tasks/hand.md', t)), 'saved', 'a task for the hand-off');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-h-2', pg_temp.save('human-tasks/hand.md', t
		|| '{"member":"70700000-0000-4000-8000-000000000003"}')), 'refused/structured_rule: member is a member%', 'handed to a viewer');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-h-3', pg_temp.save('human-tasks/hand.md', t
		|| '{"from":"70700000-0000-4000-8000-0000000000a2"}')), 'refused/structured_rule: from changes only when%', 'from while Nora is active');
	-- Nora's todo closes: the task still names it, and the person's tick is not refused for it.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-h-4', pg_temp.todo('agents/nora/todos/order-disk.md',
		'80300000-0000-4000-8000-0000000000d1', 'Order the disk', 'done')), 'saved', 'the todo is done');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-h-5', pg_temp.save('human-tasks/hand.md', t || jsonb_build_object(
		'instructions', E'## Steps\n- [x] Fit it in slot 2\n- [x] Agree a window',
		'steps', '[{"line":15,"text":"Fit it in slot 2","done":true},{"line":16,"text":"Agree a window","done":true}]'::jsonb))),
		'saved', 'the person ticks a task whose todo closed');
	-- Nora leaves: a member or the Co-Founder hands the task to another agent; another agent cannot.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-h-6', pg_temp.write('agents/nora/agent.md', 'agent',
		pg_temp.agent_text('70700000-0000-4000-8000-0000000000a1', 'Nora', 'agent', 'archived'),
		pg_temp.agent_parse('70700000-0000-4000-8000-0000000000a1', 'Nora', 'agent', 'archived'), pg_temp.version('agents/nora/agent.md'))),
		'saved', 'Nora is archived');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent('70700000-0000-4000-8000-0000000000a2'), pg_temp.save('human-tasks/hand.md', t
		|| '{"from":"70700000-0000-4000-8000-0000000000a2","todo":null}')) -> 'problems' -> 0 ->> 'message',
		'from changes only when the asking agent is no longer active, by a member or the Co-Founder', 'Otto takes it over himself');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent('70700000-0000-4000-8000-0000000000c0'), pg_temp.save('human-tasks/hand.md', t
		|| '{"from":"70700000-0000-4000-8000-0000000000a2","todo":null}')) ->> 'ok', 'true', 'the Co-Founder hands it to Otto');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-h-7', pg_temp.save('human-tasks/hand.md', t
		|| '{"from":"70700000-0000-4000-8000-0000000000a2"}')), 'refused/structured_rule: todo is an open or blocked todo of the from agent',
		'a hand-off keeping Nora''s todo');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-h-8', pg_temp.save('human-tasks/hand.md', t
		|| '{"from":"70700000-0000-4000-8000-0000000000a2","todo":"80300000-0000-4000-8000-0000000000d2"}')), 'saved', 'a member hands it to Otto');
end $$;

-- 6. Files and folders: only task files and task folders under the root; a task's folder goes first; final tasks go ------

do $$
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-1', pg_temp.put('human-tasks/notes.txt', 'x')),
		'refused/structured_rule: directly under human-tasks/ go only task files (.md) and task folders', 'a plain file at the root');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-2', pg_temp.mkdir('human-tasks/no-task')),
		'refused/structured_rule: human-tasks/no-task/ belongs to the task human-tasks/no-task.md, which must be saved first', 'a folder with no task');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-3', pg_temp.del('human-tasks/fit-disk.md')),
		'refused/structured_rule: the task''s folder human-tasks/fit-disk/ goes first%', 'a task file before its folder');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-4', pg_temp.del('human-tasks/hand.md')),
		'refused/structured_rule: only a final task is removed; cancel it first', 'an open task');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent('70700000-0000-4000-8000-0000000000a2'), pg_temp.del('human-tasks/fit-disk')) -> 'problems' -> 0 ->> 'message',
		'a accepted task''s folder is only removed whole, by a member or the platform', 'an agent removes proof');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-4b', pg_temp.del('human-tasks/fit-disk/proof/photo-2.jpg')),
		'refused/structured_rule: a accepted task''s folder is only removed whole, by a member or the platform', 'a single proof file');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-f-4c', pg_temp.del('human-tasks/own.md')),
		'refused/structured_rule: the task''s person never renames or removes its file', 'the person removes their own task');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-f-4d', jsonb_build_object('op','move','from','human-tasks/hand.md',
		'to','human-tasks/hand-2.md','expectedVersion',pg_temp.version('human-tasks/hand.md'))),
		'refused/structured_rule: the platform never renames or removes a member''s task', 'the platform renames a member''s task');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-5', pg_temp.del('human-tasks/fit-disk')), 'saved', 'a member removes a final task''s folder');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-6', pg_temp.del('human-tasks/fit-disk.md')), 'saved', 'then its file');
	if (pg_temp.idx('80300000-0000-4000-8000-0000000000e1')).retired_at is null then raise exception 'A removed task retires'; end if;
	-- A restore: the same final file again revives it; a changed one is refused.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-7', pg_temp.save('human-tasks/fit-disk.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000e1', '{"todo":"80300000-0000-4000-8000-0000000000d1",
			"connection":"80300000-0000-4000-8000-0000000000c9","status":"open"}'))),
		'refused/structured_rule: a accepted task is final; it never changes', 'a final task restored as new');
	-- A task without a folder renames freely, and its row follows.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-8', jsonb_build_object('op','move','from','human-tasks/hand.md',
		'to','human-tasks/hand-over.md','expectedVersion',pg_temp.version('human-tasks/hand.md'))), 'saved', 'a rename');
	if (pg_temp.idx('80300000-0000-4000-8000-0000000000e6')).folder_path is distinct from 'human-tasks/hand-over.md'
		or (pg_temp.idx('80300000-0000-4000-8000-0000000000e6')).folder_path_version is distinct from pg_temp.version('human-tasks/hand-over.md') then
		raise exception 'A renamed task''s row follows it: %', to_jsonb(pg_temp.idx('80300000-0000-4000-8000-0000000000e6')); end if;
	-- The roots are fixed (Jonas, 2 October).
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-9', pg_temp.del('human-tasks')), 'refused/seeded', 'the task root');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-f-10', pg_temp.del('contacts')), 'refused/seeded', 'the contact root');
end $$;

-- 7. Contacts and the platform: the link service makes a contact's change; a contact a task names stays, with its email -

do $$
declare vat jsonb := pg_temp.contact_task('{"id":"80300000-0000-4000-8000-0000000000e7","from":"70700000-0000-4000-8000-0000000000a2"}');
	sec jsonb := pg_temp.task('80300000-0000-4000-8000-0000000000e8', '{"from":"70700000-0000-4000-8000-0000000000a2",
		"secret":"Code from the SMS","secretState":"asked","step":"phone_code"}');
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-1', pg_temp.save('human-tasks/file-vat.md', vat)), 'saved', 'a contact''s task');
	-- A contact file renames within contacts/, and its row follows.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-1b', jsonb_build_object('op','move','from','contacts/maria.md',
		'to','contacts/maria-jensen.md','expectedVersion',pg_temp.version('contacts/maria.md'))), 'saved', 'a contact''s rename');
	if (select folder_path || ' ' || (folder_path_version = pg_temp.version('contacts/maria-jensen.md'))::text from public.qorpera_folder_contact_index
		where environment_id = '70700000-0000-4000-8000-000000000020' and id = '78500000-0000-4000-8000-0000000000f1')
		is distinct from 'contacts/maria-jensen.md true' then raise exception 'A renamed contact''s row follows it'; end if;
	-- The platform as the contact's person: their proof, then done; never anything else.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-2', pg_temp.mkdir('human-tasks/file-vat')),
		'refused/structured_rule: only the task''s person adds to its folder%', 'a member adds to a contact''s folder');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-k-3', jsonb_build_object('op','new_folder','path','human-tasks/file-vat',
		'contents', jsonb_build_array(jsonb_build_object('path','proof','kind','folder')))), 'saved', 'the link service makes the folder');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-k-4', pg_temp.put('human-tasks/file-vat/proof/file-1.pdf', 'receipt')),
		'saved', 'the contact uploads');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-k-5', pg_temp.save('human-tasks/file-vat.md', vat || '{"title":"Other"}')),
		'refused/structured_rule: as the task''s person you may only tick%', 'the platform edits a contact''s task');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-k-6', pg_temp.save('human-tasks/file-vat.md', vat || '{"status":"done"}')),
		'saved', 'the contact marks it done');
	-- While the task is not final its contact stays, and keeps its email; one id, one file.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-7', pg_temp.del('contacts/maria-jensen.md')),
		'refused/structured_rule: a contact named by a task that is not final stays; cancel its tasks first', 'deleting the contact');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-8', pg_temp.save('contacts/maria-jensen.md', pg_temp.contact('{"email":null}'))),
		'refused/structured_rule: a contact named by a task that is not final keeps its email', 'removing its email');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-9', pg_temp.save('contacts/maria-jensen.md',
		pg_temp.contact('{"id":"80300000-0000-4000-8000-0000000000f4"}'))), 'refused/structured_rule: id never changes%', 'a new id');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-10', pg_temp.save('contacts/maria-2.md', pg_temp.contact())),
		'refused/structured_rule: this contact already has the file contacts/maria-jensen.md', 'the id at a second file');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-11', pg_temp.save('human-tasks/file-vat.md', vat
		|| '{"status":"cancelled","reason":"Filed by someone else"}')), 'saved', 'the company cancels the done work, with a reason');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-12', pg_temp.save('contacts/maria-jensen.md', pg_temp.contact('{"email":null}'))),
		'saved', 'its email may go now');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-13', pg_temp.del('contacts/maria-jensen.md')), 'saved', 'and the contact');
	-- On a member's task the platform only marks the secret saved.
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-k-14', pg_temp.save('human-tasks/code.md', sec)), 'saved', 'a takeover task');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-k-15', pg_temp.save('human-tasks/code.md', sec || '{"title":"Other"}')),
		'refused/structured_rule: on a member''s task the platform only marks the secret saved', 'the platform edits a member''s task');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-k-16', pg_temp.save('human-tasks/code.md', sec || '{"secretState":"saved"}')),
		'saved', 'the vault''s writer marks it saved');
	perform pg_temp.is(pg_temp.one('{"kind":"platform"}', 'human-k-17', pg_temp.mkdir('human-tasks/code')),
		'refused/structured_rule: only the task''s person adds to its folder%', 'the platform in a member''s folder');
end $$;

-- 8. Locks: a unit's own rows at rank 5, and a row changed since the change set read the folder is a conflict -----------

do $$
declare env constant uuid := '70700000-0000-4000-8000-000000000020'; t jsonb; u record; c1 uuid; c2 uuid;
begin
	for u in select * from (values
		(pg_temp.mkdir('human-tasks/own/proof'), '[{"rank":5,"tbl":"qorpera_folder_human_task_index","mode":"share"}]', '80300000-0000-4000-8000-0000000000e2'),
		(pg_temp.del('human-tasks/own.md'), '[{"rank":5,"tbl":"qorpera_folder_human_task_index","mode":"nokeyupdate"}]', '80300000-0000-4000-8000-0000000000e2'),
		(pg_temp.del('contacts/no-mail.md'), '[{"rank":5,"tbl":"qorpera_folder_contact_index","mode":"nokeyupdate"}]', '80300000-0000-4000-8000-0000000000f3'),
		(jsonb_build_object('op','move','from','human-tasks/hand-over.md','to','human-tasks/hand-3.md','expectedVersion',
			pg_temp.version('human-tasks/hand-over.md')), '[{"rank":5,"tbl":"qorpera_folder_human_task_index","mode":"nokeyupdate"}]',
			'80300000-0000-4000-8000-0000000000e6'),
		(jsonb_build_object('op','move','from','contacts/no-mail.md','to','contacts/no-mail-2.md','expectedVersion',
			pg_temp.version('contacts/no-mail.md')), '[{"rank":5,"tbl":"qorpera_folder_contact_index","mode":"nokeyupdate"}]',
			'80300000-0000-4000-8000-0000000000f3')) v(unit, want, id)
	loop
		select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t
		from public.qorpera_folder_structured_targets(env, pg_temp.owner(), jsonb_build_array(u.unit)) y;
		if t is distinct from jsonb_build_array(u.want::jsonb -> 0 || jsonb_build_object('key', env || ':' || u.id)) then
			raise exception 'Unit % locks %, got %', u.unit, u.want, t; end if;
	end loop;
	-- A task save that names a contact holds the contact's row too.
	select coalesce(jsonb_agg(to_jsonb(y) order by y.tbl), '[]'::jsonb) into t
	from public.qorpera_folder_structured_targets(env, pg_temp.owner(), jsonb_build_array(pg_temp.save('human-tasks/new.md',
		pg_temp.contact_task('{"id":"80300000-0000-4000-8000-0000000000e9","contact":"80300000-0000-4000-8000-0000000000f3"}')))) y;
	if t is distinct from jsonb_build_array(
		jsonb_build_object('rank', 5, 'tbl', 'qorpera_folder_contact_index', 'key', env || ':80300000-0000-4000-8000-0000000000f3', 'mode', 'share'),
		jsonb_build_object('rank', 5, 'tbl', 'qorpera_folder_human_task_index', 'key', env || ':80300000-0000-4000-8000-0000000000e9', 'mode', 'nokeyupdate')) then
		raise exception 'A task save holds its row and its contact''s: %', t; end if;
	-- A change set that read the folder before a row's last save meets a conflict, wherever the rules read that row: a task
	-- file's removal, a contact's removal, and what leaves or lands in a task's folder.
	perform pg_temp.is(pg_temp.decide_at('seed-0001', pg_temp.owner(), pg_temp.del('human-tasks/hand-over.md')) ->> 'reason',
		'version_changed', 'a task file removed by an old view');
	perform pg_temp.is(pg_temp.decide_at('seed-0001', pg_temp.owner(), pg_temp.del('contacts/no-mail.md')) ->> 'reason',
		'version_changed', 'a contact removed by an old view');
	perform pg_temp.is(pg_temp.decide_at('seed-0001', pg_temp.mem(), pg_temp.del('human-tasks/own')) ->> 'reason',
		'version_changed', 'a task folder removed by an old view');
	perform pg_temp.is(pg_temp.decide_at('seed-0001', pg_temp.mem(), pg_temp.mkdir('human-tasks/hand-over')) ->> 'reason',
		'version_changed', 'a task folder made by an old view');
	-- Verify stops a commit whose task or contact row does not point at its file's current version.
	update public.qorpera_folder_human_task_index set folder_path_version = extensions.gen_random_uuid()
	where environment_id = env and id = '80300000-0000-4000-8000-0000000000e6' returning commit_id into c1;
	begin
		perform public.qorpera_folder_structured_verify(env, c1);
		raise exception 'verify passed a task row off its file' using errcode = 'QTF02';
	exception when sqlstate 'XX000' then null;
	end;
	update public.qorpera_folder_human_task_index set folder_path_version = pg_temp.version('human-tasks/hand-over.md')
	where environment_id = env and id = '80300000-0000-4000-8000-0000000000e6';
	update public.qorpera_folder_contact_index set folder_path_version = extensions.gen_random_uuid()
	where environment_id = env and id = '80300000-0000-4000-8000-0000000000f3' returning commit_id into c1;
	begin
		perform public.qorpera_folder_structured_verify(env, c1);
		raise exception 'verify passed a contact row off its file' using errcode = 'QTF02';
	exception when sqlstate 'XX000' then null;
	end;
	update public.qorpera_folder_contact_index set folder_path_version = pg_temp.version('contacts/no-mail.md')
	where environment_id = env and id = '80300000-0000-4000-8000-0000000000f3';
	-- Sequence order is commit order: a row written after a change set read the folder is newer than it.
	select id into c1 from public.qorpera_folder_commits where environment_id = env and operation_key = 'human-new-1';
	select id into c2 from public.qorpera_folder_commits where environment_id = env and operation_key = 'human-k-16';
	if not public.qorpera_company_state_changed_since(c1, c2) or public.qorpera_company_state_changed_since(c2, c1) then
		raise exception 'changed_since compares the row''s commit with the change set''s view'; end if;
end $$;

-- 9. Files from before H2 (an operator's test companies): a task with no index row counts as no task ---------------------

do $$
declare t jsonb := pg_temp.task('80300000-0000-4000-8000-0000000000ec', '{"from":"70700000-0000-4000-8000-0000000000a2"}');
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-old-1', pg_temp.save('human-tasks/old.md', t)), 'saved', 'a task');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-old-2', pg_temp.mkdir('human-tasks/old')), 'saved', 'its folder');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-old-3', pg_temp.mkdir('human-tasks/old/proof')), 'saved', 'its proof folder');
	-- As if both were saved before H2: no index row.
	delete from public.qorpera_folder_human_task_index where id = '80300000-0000-4000-8000-0000000000ec';
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-old-4', pg_temp.put('human-tasks/old/proof/photo-1.jpg', 'x')),
		'refused/structured_rule: human-tasks/old/ belongs to the task human-tasks/old.md, which must be saved first', 'nothing lands');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent('70700000-0000-4000-8000-0000000000a2'), pg_temp.del('human-tasks/old')) -> 'problems' -> 0 ->> 'message',
		'a folder without its task file is only removed, by a member or the platform', 'an agent removes it');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-old-5', jsonb_build_object('op','move','from','human-tasks/old/proof',
		'to','human-tasks/old/kept','expectedVersion',pg_temp.version('human-tasks/old/proof'),'asOfSeq',pg_temp.seq())),
		'refused/structured_rule: a folder without its task file is only removed, by a member or the platform', 'a member moves it');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-old-6', pg_temp.del('human-tasks/old')), 'saved', 'a member removes it');
	perform pg_temp.is(pg_temp.decide(pg_temp.agent('70700000-0000-4000-8000-0000000000a2'), pg_temp.del('human-tasks/old.md')) -> 'problems' -> 0 ->> 'message',
		'only a member or the platform removes a task saved before its index', 'an agent removes the old task');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-old-7', pg_temp.del('human-tasks/old.md')), 'saved', 'a member removes the old task');
end $$;

-- 10. A folder left without its file (an operator's state): no task lands on its name -----------------------------------

do $$
declare t jsonb := pg_temp.task('80300000-0000-4000-8000-0000000000ed', '{"from":"70700000-0000-4000-8000-0000000000a2"}');
begin
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-st-1', pg_temp.save('human-tasks/stale.md', t)), 'saved', 'a task');
	perform pg_temp.is(pg_temp.one(pg_temp.mem(), 'human-st-2', pg_temp.mkdir('human-tasks/stale')), 'saved', 'its folder');
	-- As if the file were gone and the folder left (no commit can do this since H2).
	delete from public.qorpera_folder_human_task_index where id = '80300000-0000-4000-8000-0000000000ed';
	delete from public.qorpera_folder_entries where environment_id = '70700000-0000-4000-8000-000000000020'
		and key_text = 'human-tasks/stale.md';
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-st-3', pg_temp.save('human-tasks/stale.md',
		pg_temp.task('80300000-0000-4000-8000-0000000000ee', '{"from":"70700000-0000-4000-8000-0000000000a2"}'))),
		'refused/structured_rule: a folder named human-tasks/stale/ is still there; a new task needs a free name', 'a new task on the name');
	perform pg_temp.is(pg_temp.one(pg_temp.owner(), 'human-st-4', jsonb_build_object('op','move','from','human-tasks/hand-over.md',
		'to','human-tasks/stale.md','expectedVersion',pg_temp.version('human-tasks/hand-over.md'))),
		'refused/structured_rule: a folder named human-tasks/stale/ is still there; a new task needs a free name', 'a task moved onto the name');
end $$;

rollback;
