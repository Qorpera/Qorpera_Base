-- @fixture 887_folder_core_listener.test.sql until "-- 1. Listeners: the trigger, activation, the refusals gone"
-- Company state files, H2c = P31 (migration 20260930065000; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan
-- (P31)"): human-task wakes on folder-v2. P29's commit hook marks each change of a task that should wake its `from` agent
-- (done and declined; accepted, returned and cancelled; a new person; a hand-off; a new task someone else names the agent
-- in); the human-task drain makes the wakes, and one overdue wake per (task, due). Never a tick, never the agent's own
-- change, never a change the task has moved on from. The member who started the task pays; when nobody can, the mark
-- waits as unpaid until a member chooses to pay. An inactive `from` hands the wake to the Co-Founder. The pin trigger
-- trusts only the mark and the task; the run reads the task as it may. On 708's company (Nora a1, Otto a2, the
-- Co-Founder c0; the owner's login pays for unattended work, the member's does not); rolled back at the end. Races are
-- 916's.

-- The file's text as the parser reads it, near enough: the database reads only the parse and the text's hash (785's).
create function pg_temp.state_text(p_parse jsonb) returns text language sql as $$
	select E'---\n' || coalesce(string_agg(format(E'%s: %s\n', case k when 'secretState' then 'secret_state' else k end,
			case jsonb_typeof(v) when 'array' then (select '[' || string_agg(x #>> '{}', ', ') || ']' from jsonb_array_elements(v) x)
				else v #>> '{}' end), '' order by k), '')
		|| E'---\n' || coalesce(p_parse ->> 'instructions', p_parse ->> 'notes') || E'\n'
	from jsonb_each(p_parse) e(k, v)
	where k not in ('kind', 'instructions', 'steps', 'notes') and jsonb_typeof(v) <> 'null'
		and not (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0)
$$;
-- A member's task: member 02 fits a disk, for the agent Nora. It asks for no proof, so done needs none.
create function pg_temp.task(p_id uuid, p_set jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind','human-task','id',p_id,'title','Fit the new disk','status','open',
		'member','70700000-0000-4000-8000-000000000002','contact',null,'from','70700000-0000-4000-8000-0000000000a1','todo',null,
		'due','2099-10-20T12:00:00Z','minutes',40,'proof','[]'::jsonb,'files','["ops/disk-order.pdf"]'::jsonb,
		'reason',null,'secret',null,'secretState',null,'connection',null,'step',null,
		'instructions',E'## Steps\n- [ ] Fit it in slot 2',
		'steps','[{"line":15,"text":"Fit it in slot 2","done":false}]'::jsonb) || p_set
$$;
create function pg_temp.save(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write(p_path, 'human-task', pg_temp.state_text(p_parse), p_parse, pg_temp.version(p_path))
$$;
create function pg_temp.drain() returns jsonb language sql as $$
	select public.qorpera_folder_human_tasks_company('70700000-0000-4000-8000-000000000020')
$$;
-- The listener until it has heard every change set, then one drain.
create function pg_temp.wake_up() returns jsonb language plpgsql as $$
declare r jsonb;
begin
	loop
		r := pg_temp.listen();
		exit when not coalesce((r ->> 'more')::boolean, false);
	end loop;
	return pg_temp.drain();
end $$;
-- A drain's answer in one line: state woken/skipped/unpaid/held.
create function pg_temp.counts(p_result jsonb) returns text language sql as $$
	select (p_result ->> 'state') || case when p_result ? 'woken' then format(' %s/%s/%s/%s', p_result ->> 'woken',
		p_result ->> 'skipped', p_result ->> 'unpaid', p_result ->> 'held') else '' end
$$;
create function pg_temp.mark(p_task uuid, p_reason text) returns public.qorpera_folder_human_task_wakes language sql as $$
	select * from public.qorpera_folder_human_task_wakes where task_id = p_task and reason = p_reason order by id desc limit 1
$$;
create function pg_temp.marks(p_task uuid) returns text language sql as $$
	select coalesce(string_agg(reason || ':' || state || coalesce(':' || problem, ''), ' ' order by id), '')
	from public.qorpera_folder_human_task_wakes where task_id = p_task
$$;
create function pg_temp.tw_count(p_task uuid) returns integer language sql as $$
	select count(*)::integer from public.qorpera_wake_occurrences where source_kind = 'human-task' and source_id = p_task
$$;
create function pg_temp.due() returns boolean language sql as $$
	select public.qorpera_folder_human_tasks_due() -> 'items' @> '[{"environment_id":"70700000-0000-4000-8000-000000000020"}]'
$$;
-- Calls as a signed-in user, or as the service again.
create function pg_temp.as_user(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)
$$;
create function pg_temp.as_service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)
$$;
-- A woken mark's wake, checked as the pin trigger made it and as the materializer asks.
create function pg_temp.woken(p_task uuid, p_reason text, p_staff uuid, p_what text) returns public.qorpera_wake_occurrences
language plpgsql as $$
declare m public.qorpera_folder_human_task_wakes := pg_temp.mark(p_task, p_reason); w public.qorpera_wake_occurrences;
begin
	select * into w from public.qorpera_wake_occurrences where id = m.wake_id;
	if m.state is distinct from 'woken' or w.id is null or w.wake_kind <> 'agent' or w.source_kind <> 'human-task'
		or w.source_id <> p_task or w.staff_agent_id <> p_staff or w.parent_run_id is not null or w.status <> 'queued'
		or w.trigger_id <> 'human-task' or w.occurrence_key <> m.occurrence_key or w.causal_root_id <> w.id
		or w.payload <> jsonb_build_object('schema', 'qorpera.human-task-wake/v1', 'taskId', p_task, 'reason', p_reason,
			'commitId', m.commit_id, 'dueAt', to_char(m.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
		or w.session_id is distinct from public.qorpera_folder_wake_public_session(w.profile_id, w.environment_id, p_staff,
			w.requested_by_user_id)
		or not public.qorpera_wake_authorized(w) then
		raise exception '%: %, %', p_what, to_jsonb(m), to_jsonb(w); end if;
	return w;
end $$;

-- 1. The roots, a routine each for Nora, Otto and the Co-Founder (so their runs can save), and nothing to wake ----------------

do $$
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-roots', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','human-tasks'), jsonb_build_object('op','mkdir','path','contacts'),
		jsonb_build_object('op','mkdir','path','agents/co-founder/routines'),
		pg_temp.routine('agents/nora/routines/tasks.md', pg_temp.rparse('91500000-0000-4000-8000-000000000081', 'Tasks', pg_temp.every())),
		pg_temp.routine('agents/otto/routines/tasks.md', pg_temp.rparse('91500000-0000-4000-8000-000000000082', 'Tasks', pg_temp.every())),
		pg_temp.routine('agents/co-founder/routines/tasks.md', pg_temp.rparse('91500000-0000-4000-8000-000000000083', 'Tasks',
			pg_temp.every())))));
	-- Every change set so far reaches the hook, and none writes a task.
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'idle', 'nothing to wake');
	perform pg_temp.is((select count(*) from public.qorpera_folder_human_task_wakes)::text, '0', 'no mark');
	if pg_temp.due() then raise exception 'A company with nothing to wake is not due'; end if;
end $$;

-- 2. A new task someone else names Nora in: the listener marks it, the drain wakes her, paid by the member who started it ---

do $$
declare r jsonb; m public.qorpera_folder_human_task_wakes; w public.qorpera_wake_occurrences;
	e1 constant uuid := '91500000-0000-4000-8000-0000000000e1';
begin
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-1', jsonb_build_array(pg_temp.save('human-tasks/fit-disk.md',
		pg_temp.task(e1)))));
	perform pg_temp.listen();
	m := pg_temp.mark(e1, 'assigned');
	if m.id is null or m.state <> 'pending' or m.commit_id <> (r ->> 'commitId')::uuid or m.seq <> (r ->> 'seq')::bigint
		or m.actor_user_id is distinct from '70700000-0000-4000-8000-000000000001' or m.actor_staff_agent_id is not null
		or m.wake_id is not null or m.payer_user_id is not null or m.due_at is not null
		or m.expect <> '{"status":"open","from_staff_agent_id":"70700000-0000-4000-8000-0000000000a1"}'
		or m.occurrence_key <> 'human-task:' || e1 || ':' || (r ->> 'commitId') then
		raise exception 'The listener marks a new task for Nora: %', to_jsonb(m); end if;
	-- The listener writes no wake; the drain does, once the company is due.
	perform pg_temp.is(pg_temp.tw_count(e1)::text, '0', 'no wake from the listener');
	if not pg_temp.due() then raise exception 'A pending mark makes the company due'; end if;
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'done 1/0/0/0', 'the drain wakes Nora');
	w := pg_temp.woken(e1, 'assigned', '70700000-0000-4000-8000-0000000000a1', 'Nora''s wake for her new task');
	-- The starter pays with their own login; no parent run, so the chain is Nora alone.
	if w.requested_by_user_id <> '70700000-0000-4000-8000-000000000001' or w.sponsor_binding_id <> '70800000-0000-4000-8000-0000000000b1'
		or w.causal_agent_ids <> array['70700000-0000-4000-8000-0000000000a1']::uuid[]
		or (pg_temp.mark(e1, 'assigned')).attempts <> 1 then
		raise exception 'Paid by the owner who started it: %', to_jsonb(w); end if;
	-- Once.
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'idle', 'nothing more');
	if pg_temp.due() then raise exception 'A woken mark leaves the company'; end if;
end $$;

-- 3. The person's change: a tick wakes nobody; declined wakes Nora, still paid by the starter ---------------------------------

do $$
declare t jsonb := pg_temp.task('91500000-0000-4000-8000-0000000000e1'); ticked jsonb; m public.qorpera_folder_human_task_wakes;
	w public.qorpera_wake_occurrences;
begin
	ticked := t || '{"instructions":"## Steps\n- [x] Fit it in slot 2","steps":[{"line":15,"text":"Fit it in slot 2","done":true}]}';
	perform pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'p31-tick-1', jsonb_build_array(pg_temp.save('human-tasks/fit-disk.md', ticked))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'idle', 'a tick wakes nobody');
	perform pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'p31-decline-1', jsonb_build_array(pg_temp.save('human-tasks/fit-disk.md',
		ticked || '{"status":"declined","reason":"I am away that week"}'))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'declined wakes Nora');
	m := pg_temp.mark('91500000-0000-4000-8000-0000000000e1', 'declined');
	if m.actor_user_id is distinct from '70700000-0000-4000-8000-000000000002'
		or m.expect <> '{"status":"declined","from_staff_agent_id":"70700000-0000-4000-8000-0000000000a1"}' then
		raise exception 'The person''s change: %', to_jsonb(m); end if;
	w := pg_temp.woken('91500000-0000-4000-8000-0000000000e1', 'declined', '70700000-0000-4000-8000-0000000000a1', 'declined');
	if w.requested_by_user_id <> '70700000-0000-4000-8000-000000000001' then
		raise exception 'The starter pays, not the person: %', to_jsonb(w); end if;
	perform pg_temp.is(pg_temp.marks('91500000-0000-4000-8000-0000000000e1'), 'assigned:woken declined:woken', 'two marks');
end $$;

-- 4. A change the task moved on from is skipped; done by the person; accepted by another agent's run, which joins the chain --

do $$
declare e2 constant uuid := '91500000-0000-4000-8000-0000000000e2'; t jsonb := pg_temp.task('91500000-0000-4000-8000-0000000000e2');
	a jsonb; m public.qorpera_folder_human_task_wakes; w public.qorpera_wake_occurrences;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-2', jsonb_build_array(pg_temp.save('human-tasks/sign.md', t))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'p31-done-2', jsonb_build_array(pg_temp.save('human-tasks/sign.md',
		t || '{"status":"done"}'))));
	-- Two change sets, two marks; by the drain the task is done, so only done wakes.
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/1/0/0', 'the late assigned mark is skipped, done wakes');
	perform pg_temp.is(pg_temp.marks(e2), 'assigned:skipped:changed done:woken', 'a change the task moved on from is skipped');
	perform pg_temp.woken(e2, 'done', '70700000-0000-4000-8000-0000000000a1', 'done');
	-- Otto's run accepts it.
	a := pg_temp.routine_run('91500000-0000-4000-8000-000000000082');
	perform pg_temp.saved(pg_temp.commit(a, 'p31-accept-2', jsonb_build_array(pg_temp.save('human-tasks/sign.md',
		t || '{"status":"accepted"}'))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'accepted wakes Nora');
	m := pg_temp.mark(e2, 'accepted');
	w := pg_temp.woken(e2, 'accepted', '70700000-0000-4000-8000-0000000000a1', 'accepted');
	if m.actor_staff_agent_id is distinct from '70700000-0000-4000-8000-0000000000a2' or m.actor_user_id is not null
		or w.causal_agent_ids <> array['70700000-0000-4000-8000-0000000000a2', '70700000-0000-4000-8000-0000000000a1']::uuid[]
		or w.requested_by_user_id <> '70700000-0000-4000-8000-000000000001' then
		raise exception 'Otto''s change wakes Nora with Otto in the chain: %, %', to_jsonb(m), to_jsonb(w); end if;
end $$;

-- 5. The agent's own changes wake nobody: Nora's run makes a task from herself, then cancels it ------------------------------

do $$
declare e3 constant uuid := '91500000-0000-4000-8000-0000000000e3'; a jsonb := pg_temp.routine_run('91500000-0000-4000-8000-000000000081');
begin
	perform pg_temp.saved(pg_temp.commit(a, 'p31-own-1', jsonb_build_array(pg_temp.save('human-tasks/own.md', pg_temp.task(e3)))));
	perform pg_temp.saved(pg_temp.commit(a, 'p31-own-2', jsonb_build_array(pg_temp.save('human-tasks/own.md',
		pg_temp.task(e3, '{"status":"cancelled"}')))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'idle', 'nothing to wake');
	perform pg_temp.is(pg_temp.marks(e3), '', 'no mark for the agent''s own changes');
	-- The run's member started it: their login would pay for its later wakes.
	if (select started_by_user_id from public.qorpera_folder_human_task_index where id = e3) <> '70700000-0000-4000-8000-000000000001' then
		raise exception 'The run''s requester started the task'; end if;
	-- A final task removed: a mark still waiting for it (one a busy pass left) finds no task. Restored, it is no new task:
	-- nobody is woken.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-remove-2', jsonb_build_array(pg_temp.del('human-tasks/sign.md'))));
	insert into public.qorpera_folder_human_task_wakes(environment_id, profile_id, task_id, reason, commit_id, seq, occurrence_key)
	select environment_id, profile_id, task_id, 'accepted', commit_id, seq, 'human-task:' || task_id || ':late'
	from public.qorpera_folder_human_task_wakes where task_id = '91500000-0000-4000-8000-0000000000e2' and reason = 'accepted';
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 0/1/0/0', 'a removed task wakes nobody');
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-restore-2', jsonb_build_array(pg_temp.save('human-tasks/sign.md',
		pg_temp.task('91500000-0000-4000-8000-0000000000e2', '{"status":"accepted"}')))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'idle', 'a restore wakes nobody');
	perform pg_temp.is(pg_temp.marks('91500000-0000-4000-8000-0000000000e2'),
		'assigned:skipped:changed done:woken accepted:woken accepted:skipped:task_gone', 'no mark for a restore');
end $$;

-- A task renamed wakes nobody; a new task at its old name is a new task, whatever the name held before.
do $$
declare e11 constant uuid := '91500000-0000-4000-8000-0000000000eb'; e12 constant uuid := '91500000-0000-4000-8000-0000000000ec';
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-11', jsonb_build_array(pg_temp.save('human-tasks/old-name.md',
		pg_temp.task(e11)))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'assigned');
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-rename-11', jsonb_build_array(
		pg_temp.move('human-tasks/old-name.md', 'human-tasks/new-name.md'))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'idle', 'a rename wakes nobody');
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-12', jsonb_build_array(pg_temp.save('human-tasks/old-name.md',
		pg_temp.task(e12)))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'a new task at the old name');
	perform pg_temp.is(pg_temp.marks(e11) || ' / ' || pg_temp.marks(e12), 'assigned:woken / assigned:woken', 'one mark each');
end $$;

-- 6. Overdue: one wake per (task, due), a new due arms it again, a final task never ------------------------------------------

do $$
declare e4 constant uuid := '91500000-0000-4000-8000-0000000000e4'; m public.qorpera_folder_human_task_wakes;
	w public.qorpera_wake_occurrences; v_due timestamptz := date_trunc('second', clock_timestamp()) - interval '1 hour';
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-4', jsonb_build_array(pg_temp.save('human-tasks/call.md',
		pg_temp.task(e4)))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'assigned');
	-- A member hands the task to another person: Nora is woken. A move of its due date wakes nobody.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-person-4', jsonb_build_array(pg_temp.save('human-tasks/call.md',
		pg_temp.task(e4, '{"member":"70700000-0000-4000-8000-000000000001"}')))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'a new person wakes Nora');
	if (pg_temp.mark(e4, 'person')).expect <> '{"contact_id":null,"member_user_id":"70700000-0000-4000-8000-000000000001",
			"from_staff_agent_id":"70700000-0000-4000-8000-0000000000a1"}' then
		raise exception 'A new person: %', to_jsonb(pg_temp.mark(e4, 'person')); end if;
	perform pg_temp.woken(e4, 'person', '70700000-0000-4000-8000-0000000000a1', 'a new person');
	perform pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'p31-due-4', jsonb_build_array(pg_temp.save('human-tasks/call.md',
		pg_temp.task(e4, '{"member":"70700000-0000-4000-8000-000000000001","due":"2099-12-01T09:00:00Z"}')))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'idle', 'a moved due wakes nobody');
	-- Time passes (the index row's due, as the scan reads it).
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set due_at = %L where id = %L', v_due, e4));
	if not pg_temp.due() then raise exception 'An overdue task makes the company due'; end if;
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'done 1/0/0/0', 'overdue wakes Nora');
	m := pg_temp.mark(e4, 'overdue');
	w := pg_temp.woken(e4, 'overdue', '70700000-0000-4000-8000-0000000000a1', 'overdue');
	if m.due_at <> v_due or m.commit_id is not null or m.actor_user_id is not null or m.actor_staff_agent_id is not null
		or m.occurrence_key <> public.qorpera_folder_human_task_due_key(e4, v_due)
		or m.occurrence_key <> 'human-task-due:' || e4 || ':' || (extract(epoch from v_due) * 1000000)::bigint
		or w.payload ->> 'dueAt' <> to_char(v_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') then
		raise exception 'The overdue mark: %, %', to_jsonb(m), to_jsonb(w); end if;
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'idle', 'once per due');
	if pg_temp.due() then raise exception 'A woken due leaves the company'; end if;
	-- A new due that passes too arms it again.
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set due_at = %L where id = %L', v_due + interval '1 minute', e4));
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'done 1/0/0/0', 'a new due wakes again');
	perform pg_temp.is(pg_temp.tw_count(e4)::text, '4', 'assigned, the person and two dues');
	-- A mark for a due the task no longer has (one a busy pass left pending) is skipped; a mark tried a moment ago waits
	-- before it is tried again (5 s, doubling, as the listener's hook failures).
	insert into public.qorpera_folder_human_task_wakes(environment_id, profile_id, task_id, reason, due_at, occurrence_key, attempts,
		last_attempt_at)
	values ('70700000-0000-4000-8000-000000000020', '70700000-0000-4000-8000-000000000010', e4, 'overdue', v_due - interval '1 day',
		public.qorpera_folder_human_task_due_key(e4, v_due - interval '1 day'), 1, clock_timestamp());
	if pg_temp.due() then raise exception 'A mark tried a moment ago is not due'; end if;
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'idle', 'not tried before its wait');
	update public.qorpera_folder_human_task_wakes set last_attempt_at = last_attempt_at - interval '5 seconds'
	where task_id = e4 and due_at = v_due - interval '1 day';
	if not pg_temp.due() then raise exception 'After its wait the mark is due'; end if;
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'done 0/1/0/0', 'a due the task no longer has');
	perform pg_temp.is((select state || ':' || problem || ':' || attempts from public.qorpera_folder_human_task_wakes
		where task_id = e4 and due_at = v_due - interval '1 day'), 'skipped:changed:2', 'skipped as changed');
	-- A final task's due wakes nobody.
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set due_at = %L where id = %L', v_due,
		'91500000-0000-4000-8000-0000000000e2'));
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'idle', 'an accepted task is never overdue');
end $$;

-- 7. An inactive `from`: the Co-Founder is woken in its place; a hand-off wakes the new `from` --------------------------------

do $$
declare e5 constant uuid := '91500000-0000-4000-8000-0000000000e5';
	t jsonb := pg_temp.task('91500000-0000-4000-8000-0000000000e5', '{"from":"70700000-0000-4000-8000-0000000000a2"}');
	assigned public.qorpera_wake_occurrences; m public.qorpera_folder_human_task_wakes;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-5', jsonb_build_array(pg_temp.save('human-tasks/otto.md', t))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'Otto''s task wakes Otto');
	assigned := pg_temp.woken(e5, 'assigned', '70700000-0000-4000-8000-0000000000a2', 'Otto''s wake');
	-- Otto is archived before his wake runs: the materializer no longer takes it.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-archive-otto', jsonb_build_array(pg_temp.write('agents/otto/agent.md',
		'agent', pg_temp.agent_text('70700000-0000-4000-8000-0000000000a2', 'Otto', 'agent', 'archived'),
		pg_temp.agent_parse('70700000-0000-4000-8000-0000000000a2', 'Otto', 'agent', 'archived'), pg_temp.version('agents/otto/agent.md')))));
	if public.qorpera_wake_authorized(assigned) then raise exception 'An archived agent''s task wake is no longer authorized'; end if;
	perform pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'p31-done-5', jsonb_build_array(pg_temp.save('human-tasks/otto.md',
		t || '{"status":"done"}'))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'done wakes the Co-Founder');
	perform pg_temp.woken(e5, 'done', '70700000-0000-4000-8000-0000000000c0', 'the Co-Founder stands in');
	-- The Co-Founder's run returns it: its own change wakes nobody, though it is not the task's `from`.
	perform pg_temp.saved(pg_temp.commit(pg_temp.routine_run('91500000-0000-4000-8000-000000000083'), 'p31-return-5',
		jsonb_build_array(pg_temp.save('human-tasks/otto.md',
			t || '{"status":"returned","reason":"The photo is blurry","due":"2099-11-01T00:00:00Z"}'))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 0/1/0/0', 'the Co-Founder''s own change');
	perform pg_temp.is(pg_temp.marks(e5), 'assigned:woken done:woken returned:skipped:own_change', 'skipped as its own');
	-- A member hands it to Nora: Nora is woken.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-handoff-5', jsonb_build_array(pg_temp.save('human-tasks/otto.md',
		t || '{"status":"returned","reason":"The photo is blurry","due":"2099-11-01T00:00:00Z",
			"from":"70700000-0000-4000-8000-0000000000a1"}'))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 1/0/0/0', 'the hand-off wakes Nora');
	m := pg_temp.mark(e5, 'handoff');
	perform pg_temp.woken(e5, 'handoff', '70700000-0000-4000-8000-0000000000a1', 'the hand-off');
	if m.expect <> '{"from_staff_agent_id":"70700000-0000-4000-8000-0000000000a1"}' then
		raise exception 'A hand-off expects the new from: %', to_jsonb(m); end if;
end $$;

-- 8. Who pays: the starter's own login; none that can pay, or a starter who left, leaves the mark unpaid until a member chooses
-- to pay ----------------------------------------------------------------------------------------------------------------------

do $$
declare e6 constant uuid := '91500000-0000-4000-8000-0000000000e6'; e7 constant uuid := '91500000-0000-4000-8000-0000000000e7';
	r jsonb; w public.qorpera_wake_occurrences; v_state text;
begin
	-- The member starts a task for themselves; their login does not pay for unattended work.
	perform pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'p31-new-6', jsonb_build_array(pg_temp.save('human-tasks/mine.md',
		pg_temp.task(e6)))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 0/0/1/0', 'nobody can pay');
	perform pg_temp.is(pg_temp.marks(e6), 'assigned:unpaid:no_payer', 'unpaid, and why');
	perform pg_temp.is(pg_temp.tw_count(e6)::text, '0', 'no wake');
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'idle', 'an unpaid mark waits');
	-- A member who left: a guest joins, starts a task, and leaves before the drain.
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000003', 'todos-stranger@example.test', 'Guest', 'contributor');
	perform pg_temp.saved(pg_temp.commit('{"kind":"member","userId":"70700000-0000-4000-8000-000000000003"}', 'p31-new-7',
		jsonb_build_array(pg_temp.save('human-tasks/guest.md', pg_temp.task(e7)))));
	perform pg_temp.fx('delete from public.qorpera_profile_members where user_id = ''70700000-0000-4000-8000-000000000003''');
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 0/0/1/0', 'the starter left');
	perform pg_temp.is(pg_temp.marks(e7), 'assigned:unpaid:starter_left', 'unpaid because the starter left');
	-- The company's members see what waits; only a member who may write may choose to pay.
	perform pg_temp.as_user('70700000-0000-4000-8000-000000000002');
	r := public.qorpera_member_folder_human_task_waits('70700000-0000-4000-8000-000000000020');
	if not (r -> 'waits' @> jsonb_build_array(jsonb_build_object('taskId', e6, 'reason', 'assigned', 'problem', 'no_payer'),
			jsonb_build_object('taskId', e7, 'reason', 'assigned', 'problem', 'starter_left')))
		or jsonb_array_length(r -> 'waits') <> 2 then
		raise exception 'The waits: %', r; end if;
	perform pg_temp.as_user('70700000-0000-4000-8000-000000000003');
	begin
		perform public.qorpera_folder_human_task_wake_continue('70700000-0000-4000-8000-000000000020', e7);
		v_state := 'allowed';
	exception when insufficient_privilege then v_state := '42501';
	end;
	perform pg_temp.is(v_state, '42501', 'someone who left cannot pay');
	-- Nor a viewer.
	perform pg_temp.fx('insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		(''70700000-0000-4000-8000-000000000010'', ''70700000-0000-4000-8000-000000000003'', ''todos-stranger@example.test'',
			''Viewer'', ''viewer'')');
	begin
		perform public.qorpera_folder_human_task_wake_continue('70700000-0000-4000-8000-000000000020', e7);
		v_state := 'allowed';
	exception when insufficient_privilege then v_state := '42501';
	end;
	perform pg_temp.is(v_state, '42501', 'a viewer cannot pay');
	perform pg_temp.fx('delete from public.qorpera_profile_members where user_id = ''70700000-0000-4000-8000-000000000003''');
	begin
		perform public.qorpera_member_folder_human_task_waits('70700000-0000-4000-8000-000000000020');
		v_state := 'allowed';
	exception when insufficient_privilege then v_state := '42501';
	end;
	perform pg_temp.is(v_state, '42501', 'nor see the waits');
	-- The owner chooses to pay for both.
	perform pg_temp.as_user('70700000-0000-4000-8000-000000000001');
	perform pg_temp.is(public.qorpera_folder_human_task_wake_continue('70700000-0000-4000-8000-000000000020', e6) ->> 'rearmed', '1',
		'the owner pays for the member''s task');
	perform pg_temp.is(public.qorpera_folder_human_task_wake_continue('70700000-0000-4000-8000-000000000020', e7) ->> 'rearmed', '1',
		'and for the guest''s');
	perform pg_temp.is(public.qorpera_folder_human_task_wake_continue('70700000-0000-4000-8000-000000000020', e7) ->> 'rearmed', '0',
		'nothing left to pay for');
	perform pg_temp.as_service();
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'done 2/0/0/0', 'both wake');
	w := pg_temp.woken(e6, 'assigned', '70700000-0000-4000-8000-0000000000a1', 'paid by the owner');
	if w.requested_by_user_id <> '70700000-0000-4000-8000-000000000001' or w.sponsor_binding_id <> '70800000-0000-4000-8000-0000000000b1'
		or (pg_temp.mark(e6, 'assigned')).payer_user_id <> '70700000-0000-4000-8000-000000000001' then
		raise exception 'The member who chose pays: %', to_jsonb(w); end if;
	perform pg_temp.woken(e7, 'assigned', '70700000-0000-4000-8000-0000000000a1', 'the guest''s task, paid by the owner');
end $$;

-- A ChatGPT plan pays for no human-task wake, even the starter's own.
do $$
declare e8 constant uuid := '91500000-0000-4000-8000-0000000000e8';
begin
	if not public.qorpera_listener_source('human-task') then raise exception 'A human-task wake is a listener''s source'; end if;
	-- The member's login becomes a plan that may work unattended.
	perform pg_temp.fx($sql$
		update public.qorpera_provider_connection_versions set allow_autonomous = true
		where connection_id = '70800000-0000-4000-8000-0000000000c2';
		insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id, provider,
			native_harness, current_version, access_issued_at, access_expires_at, login_kind)
		select '91500000-0000-4000-8000-0000000000f1', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
			v.credential_capsule_id, extensions.gen_random_uuid(), 'openai', 'codex-cli', 1, clock_timestamp(),
			clock_timestamp() + interval '10 days', 'chatgpt_plan'
		from public.qorpera_provider_connection_versions v where v.connection_id = '70800000-0000-4000-8000-0000000000c2'$sql$);
	if (select s.binding_id from public.qorpera_starter_sponsor('70700000-0000-4000-8000-000000000010',
			'70700000-0000-4000-8000-000000000002', '70700000-0000-4000-8000-0000000000a1', null) s)
			is distinct from '70800000-0000-4000-8000-0000000000b2' then
		raise exception 'Fixture: the member''s plan would pay for new work'; end if;
	perform pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'p31-new-8', jsonb_build_array(pg_temp.save('human-tasks/plan.md',
		pg_temp.task(e8)))));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'done 0/0/1/0', 'a plan never pays');
	perform pg_temp.is(pg_temp.marks(e8), 'assigned:unpaid:plan', 'unpaid because the login is a plan');
	-- Nor does the pin trigger let a plan pay, whoever inserts the wake.
	update public.qorpera_folder_human_task_wakes set state = 'pending', problem = null where task_id = e8;
	begin
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
			requested_by_user_id, trigger_id, occurrence_key, scheduled_for, not_before)
		select extensions.gen_random_uuid(), m.profile_id, m.environment_id, 'agent', 'human-task', e8,
			'70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-000000000002', 'human-task', m.occurrence_key,
			clock_timestamp(), clock_timestamp()
		from public.qorpera_folder_human_task_wakes m where m.task_id = e8;
		raise exception 'A plan paid for a task wake';
	exception when insufficient_privilege then
		if sqlerrm <> 'No model account can pay for this work' then raise; end if;
	end;
	update public.qorpera_folder_human_task_wakes set state = 'unpaid', problem = 'plan' where task_id = e8;
end $$;

-- 9. A paused company: the listener still marks, the drain waits; after the resume it wakes ------------------------------------

do $$
declare e9 constant uuid := '91500000-0000-4000-8000-0000000000e9'; v_unit jsonb := pg_temp.save('human-tasks/paused.md',
	pg_temp.task('91500000-0000-4000-8000-0000000000e9'));
begin
	perform pg_temp.possess('70700000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(v_unit));
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000001', 'test');
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-9', jsonb_build_array(v_unit)));
	perform pg_temp.is(pg_temp.counts(pg_temp.wake_up()), 'paused', 'the drain waits');
	perform pg_temp.is(pg_temp.marks(e9), 'assigned:pending', 'the listener marked it');
	if pg_temp.due() then raise exception 'A paused company is not due'; end if;
	delete from public.qorpera_company_execution_pauses where profile_id = '70700000-0000-4000-8000-000000000010';
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'done 1/0/0/0', 'woken after the resume');
end $$;

-- 10. The pin trigger trusts only the mark and the task ------------------------------------------------------------------------

do $$
declare e10 constant uuid := '91500000-0000-4000-8000-0000000000ea'; m public.qorpera_folder_human_task_wakes;
	w public.qorpera_wake_occurrences; v_case text;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'p31-new-10', jsonb_build_array(pg_temp.save('human-tasks/pin.md',
		pg_temp.task(e10)))));
	perform pg_temp.listen();
	m := pg_temp.mark(e10, 'assigned');
	perform public.qorpera_folder_admit_wakes('70700000-0000-4000-8000-000000000010');
	-- No mark under the key, another task's mark, or a parent run: refused.
	foreach v_case in array array['key', 'task', 'parent'] loop
		begin
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
				requested_by_user_id, trigger_id, occurrence_key, scheduled_for, not_before, parent_run_id)
			values (extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020', 'agent',
				'human-task', case when v_case = 'task' then '91500000-0000-4000-8000-0000000000e1'::uuid else e10 end,
				'70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-000000000001', 'human-task',
				case when v_case = 'key' then 'human-task:' || e10 || ':' || extensions.gen_random_uuid() else m.occurrence_key end,
				clock_timestamp(), clock_timestamp(),
				case when v_case = 'parent' then (select id from public.qorpera_execution_runs
					where environment_id = '70700000-0000-4000-8000-000000000020' limit 1) end);
			raise exception 'The pin trigger took a wake with no fitting mark (%)', v_case;
		exception when insufficient_privilege then null;
		end;
	end loop;
	-- What the inserter says about the agent, the payer and the payload is replaced by the mark's and the task's.
	begin
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
			requested_by_user_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
		values (extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020', 'agent',
			'human-task', e10, '70700000-0000-4000-8000-0000000000c0', '70700000-0000-4000-8000-000000000002', 'other',
			m.occurrence_key, clock_timestamp(), clock_timestamp(), '{"reason":"done"}')
		returning * into w;
		if w.staff_agent_id <> '70700000-0000-4000-8000-0000000000a1' or w.requested_by_user_id <> '70700000-0000-4000-8000-000000000001'
			or w.trigger_id <> 'human-task' or w.payload ->> 'reason' <> 'assigned'
			or w.sponsor_binding_id <> '70800000-0000-4000-8000-0000000000b1' then
			raise exception 'The pin trigger takes the mark''s and the task''s word: %', to_jsonb(w); end if;
		raise exception 'undo' using errcode = 'QP31U';
	exception when sqlstate 'QP31U' then null;
	end;
	-- A woken mark admits no second wake.
	perform pg_temp.is(pg_temp.counts(pg_temp.drain()), 'done 1/0/0/0', 'the drain wakes it');
	-- Before its run, the wake holds only while its payer is the mark's.
	w := pg_temp.woken(e10, 'assigned', '70700000-0000-4000-8000-0000000000a1', 'the pinned wake');
	update public.qorpera_folder_human_task_wakes set payer_user_id = '70700000-0000-4000-8000-000000000002' where task_id = e10;
	if public.qorpera_folder_wake_authorized(w) then raise exception 'A wake paid by another member than its mark''s does not hold'; end if;
	update public.qorpera_folder_human_task_wakes set payer_user_id = null where task_id = e10;
	begin
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
			requested_by_user_id, trigger_id, occurrence_key, scheduled_for, not_before)
		values (extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020', 'agent',
			'human-task', e10, '70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-000000000001', 'human-task',
			m.occurrence_key, clock_timestamp(), clock_timestamp());
		raise exception 'A woken mark took a second wake';
	exception when insufficient_privilege then null;
	end;
end $$;

-- 11. The run reads its wake: the task as the run may read it, who changed it, and how it may answer ---------------------------

-- A leased run of a task wake, as the materializer leaves it (P28; 887's file_run).
create function pg_temp.task_run(p_wake uuid) returns jsonb language plpgsql as $$
declare w public.qorpera_wake_occurrences; s public.qorpera_shared_sessions; v_run uuid := extensions.gen_random_uuid();
	v_job uuid := extensions.gen_random_uuid(); v_runner uuid := extensions.gen_random_uuid();
	v_assignment uuid := extensions.gen_random_uuid();
begin
	select * into strict w from public.qorpera_wake_occurrences where id = p_wake;
	select * into s from public.qorpera_shared_sessions where id = w.session_id;
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, w.profile_id, w.environment_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn',
		'{}', w.requested_by_user_id, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, audience_user_id, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, company_seq)
	values (v_run, w.profile_id, w.environment_id, 'wake', w.id, v_job, null, null,
		w.staff_agent_id, w.staff_version, w.sponsor_binding_id, w.sponsor_version, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
		w.requested_by_user_id, w.requested_by_user_id, 'openai', 'gpt-test', 'provider_default', coalesce(s.audience_kind, 'company'),
		s.audience_user_id, extensions.gen_random_uuid(), repeat('b', 64), w.session_id, '{}', pg_temp.seq());
	update public.qorpera_wake_occurrences set run_id = v_run, status = 'materialized' where id = w.id;
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;
-- The native rows a run's binding needs (887's).
create function pg_temp.native(p_actor jsonb) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_identity uuid := '91500000-0000-4000-8000-0000000000d1';
	v_lease uuid := extensions.gen_random_uuid(); v_sponsor public.qorpera_execution_sponsor_versions%rowtype; v_capsule uuid;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	select credential_capsule_id into strict v_capsule from public.qorpera_provider_connection_versions
	where connection_id = v_sponsor.provider_connection_id and version = v_sponsor.provider_connection_version;
	set local session_replication_role = replica;
	insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
	values (v_identity, v_run.profile_id, 'company', v_identity, 'Task fixture') on conflict (id) do nothing;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values (v_capsule, v_run.profile_id, v_identity, 'company', 'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64),
		v_run.created_by_user_id) on conflict (id) do nothing;
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values ((p_actor ->> 'runnerId')::uuid, v_run.profile_id, (p_actor ->> 'runnerId')::uuid, 'Task runner', '["agent_turn"]',
		'active', repeat('e', 64), clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour',
		v_run.created_by_user_id, v_identity);
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values ((p_actor ->> 'assignmentId')::uuid, extensions.gen_random_uuid(), v_run.job_id, v_run.id, (p_actor ->> 'runnerId')::uuid,
		repeat('e', 64), 'accepted', clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run.id, v_run.job_id, v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, v_capsule,
		v_identity, (p_actor ->> 'runnerId')::uuid, (p_actor ->> 'assignmentId')::uuid, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run.id, v_run.job_id, v_run.profile_id, v_run.sponsor_binding_id, v_run.sponsor_version, v_sponsor.provider_connection_id,
		v_sponsor.provider_connection_version, date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_run.job_id, v_run.profile_id, v_run.environment_id, '["gpt-test"]', 32, 1000, 1000, v_run.created_by_user_id);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run.id);
	update public.qorpera_execution_runs set compute_identity_id = v_identity where id = v_run.id;
	set local session_replication_role = origin;
	return jsonb_build_object('leaseId', v_lease, 'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', p_actor ->> 'runnerId',
		'assignmentId', p_actor ->> 'assignmentId', 'credentialCapsuleId', v_capsule, 'computeIdentityId', v_identity,
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-test');
end $$;

do $$
declare w public.qorpera_wake_occurrences; a jsonb; e jsonb;
begin
	-- Nora's wake for the declined task (section 3).
	w := pg_temp.woken('91500000-0000-4000-8000-0000000000e1', 'declined', '70700000-0000-4000-8000-0000000000a1', 'declined');
	a := pg_temp.task_run(w.id);
	if public.qorpera_runtime_wake_policy_internal((a ->> 'runId')::uuid) <> public.qorpera_wake_policy_value('agent',
			case when w.session_id is null then 'optional' else 'continuation' end) then
		raise exception 'Optional in the agent''s own thread, no mouth without one: %',
			public.qorpera_runtime_wake_policy_internal((a ->> 'runId')::uuid); end if;
	e := public.qorpera_read_native_wake(pg_temp.native(a));
	if e -> 'source' ->> 'kind' is distinct from 'human-task'
		or e -> 'source' ->> 'id' is distinct from '91500000-0000-4000-8000-0000000000e1'
		or e ->> 'actorUserId' is distinct from '70700000-0000-4000-8000-000000000002' or e ->> 'actorStaffId' is not null
		or e ->> 'parentRunId' is not null or e -> 'causal' ->> 'rootId' is distinct from w.id::text
		or (select array_agg(k order by k) from jsonb_object_keys(e -> 'payload') k)
			is distinct from array['commitId','dueAt','reason','schema','task','taskId']
		or e -> 'payload' -> 'task' is distinct from '{"due":"2099-10-20T12:00:00.000000Z","path":"human-tasks/fit-disk.md",
			"title":"Fit the new disk","status":"declined"}'
		or e -> 'payload' ->> 'reason' is distinct from 'declined' or e -> 'payload' -> 'dueAt' is distinct from 'null' then
		raise exception 'The run''s wake: %', e; end if;
	-- The task is shown only while the run may read its file.
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy, created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', 'human-tasks/fit-disk.md', 'exact', 'member_private',
		'70700000-0000-4000-8000-000000000002', 'normal', '70700000-0000-4000-8000-000000000002');
	if public.qorpera_folder_human_task_wake_payload(w, public.qorpera_folder_listener_actor(w.profile_id, w.staff_agent_id,
			w.requested_by_user_id, w.session_id)) -> 'task' <> 'null' then
		raise exception 'A task the run may not read is not shown'; end if;
	delete from public.qorpera_company_path_resources
	where environment_id = '70700000-0000-4000-8000-000000000020' and path = 'human-tasks/fit-disk.md';
	if public.qorpera_folder_human_task_wake_payload(w, public.qorpera_folder_listener_actor(w.profile_id, w.staff_agent_id,
			w.requested_by_user_id, w.session_id)) -> 'task' ->> 'path' is distinct from 'human-tasks/fit-disk.md' then
		raise exception 'A task the run may read is shown'; end if;
	-- Once its run is admitted, a later change of the task does not take the wake's authority away; before, it does.
	select * into w from public.qorpera_wake_occurrences where id = w.id;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set retired_at = clock_timestamp() where id = %L',
		'91500000-0000-4000-8000-0000000000e1'));
	if not public.qorpera_folder_wake_authorized(w) then raise exception 'A running task wake keeps its authority'; end if;
	w.run_id := null;
	if public.qorpera_folder_wake_authorized(w) then raise exception 'A task wake not yet run needs its task'; end if;
	perform pg_temp.fx(format('update public.qorpera_folder_human_task_index set retired_at = null where id = %L',
		'91500000-0000-4000-8000-0000000000e1'));
end $$;

-- 12. Grants, the marks' privacy and the drain's lock text --------------------------------------------------------------------

do $$
declare v_fn regprocedure; v_body text;
begin
	foreach v_fn in array array['public.qorpera_folder_human_tasks_due(uuid,integer)',
			'public.qorpera_folder_human_tasks_company(uuid,integer)']::regprocedure[] loop
		if not has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('authenticated', v_fn, 'execute') then raise exception 'Grants of %', v_fn; end if;
	end loop;
	foreach v_fn in array array['public.qorpera_folder_human_task_wake_continue(uuid,uuid)',
			'public.qorpera_member_folder_human_task_waits(uuid)']::regprocedure[] loop
		if not has_function_privilege('authenticated', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('service_role', v_fn, 'execute') then raise exception 'Grants of %', v_fn; end if;
	end loop;
	foreach v_fn in array array['public.qorpera_folder_human_task_due_key(uuid,timestamptz)',
			'public.qorpera_folder_human_task_recipient(uuid,uuid,uuid)', 'public.qorpera_folder_human_task_sponsor(uuid,uuid,uuid)',
			'public.qorpera_folder_human_task_wake_marker(public.qorpera_wake_occurrences)',
			'public.qorpera_folder_human_task_wake_fits(public.qorpera_wake_occurrences,public.qorpera_folder_human_task_wakes)',
			'public.qorpera_folder_human_task_wake_payload(public.qorpera_wake_occurrences,jsonb)']::regprocedure[] loop
		if has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
			raise exception 'No API role runs %', v_fn; end if;
	end loop;
	if has_table_privilege('authenticated', 'public.qorpera_folder_human_task_wakes', 'select')
		or has_table_privilege('service_role', 'public.qorpera_folder_human_task_wakes', 'select')
		or not (select relrowsecurity from pg_class where oid = 'public.qorpera_folder_human_task_wakes'::regclass) then
		raise exception 'The marks are private'; end if;
	select prosrc into v_body from pg_proc where oid = 'public.qorpera_folder_human_tasks_company(uuid,integer)'::regprocedure;
	-- The fence and ranks, the threads, admission, then the marks; no 40001; the 2 s budget.
	if not (strpos(v_body, 'qorpera_folder_company_enter') < strpos(v_body, 'for key share')
			and strpos(v_body, 'for key share') < strpos(v_body, 'qorpera_folder_admit_wakes')
			and strpos(v_body, 'qorpera_folder_admit_wakes') < strpos(v_body, 'for update skip locked'))
		or v_body ~* '40001' or not (select proconfig @> array['lock_timeout=2s'] from pg_proc
			where oid = 'public.qorpera_folder_human_tasks_company(uuid,integer)'::regprocedure) then
		raise exception 'The lock text of the drain'; end if;
end $$;

rollback;
