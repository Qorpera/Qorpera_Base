-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine: its row, its version and its position"
-- Listener routines, L1 (20260930565000; deploy/first-node/RUNTIME-LISTENER-ROUTINES.md): a routine file's `after`. An
-- agent's dynamic routine may wait for a todo or a human task of its company: the save checks the path's shape and that
-- the company has one there, and the version's trigger keeps its folded key. The routine waits in the folder tick while
-- the todo is open, and stops waiting once it is done. The routine's own run decides next without `after` (a plain
-- time, no review) or with a new one.

create function pg_temp.listening(p_id uuid) returns boolean language sql as $$
	select public.qorpera_routine_listening(pg_temp.rt(p_id), (pg_temp.rv(p_id)).triggers -> 0)
$$;
create function pg_temp.listed(p_id uuid) returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_folder_dynamic_routines_due(null, 500) -> 'items') item(value)
		where item.value ->> 'routine_id' = p_id::text)
$$;
create function pg_temp.after(p_at text, p_after text) returns jsonb language sql as $$
	select jsonb_build_object('when','once','at',p_at,'after',p_after)
$$;

do $$
declare a jsonb; b jsonb; u jsonb; v public.qorpera_cloud_routine_versions;
	e1 constant uuid := '56500000-0000-4000-8000-0000000000e1'; el constant uuid := '56500000-0000-4000-8000-0000000000e2';
	d1 constant uuid := '56500000-0000-4000-8000-0000000000d1';
	p text := 'QorperaOS/agents/nora/routines/review-landing.md';
	todo text := 'QorperaOS/agents/otto/todos/landing-page.md';
	soon text := to_char((date_trunc('second', clock_timestamp()) + interval '2 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
	far text := to_char((date_trunc('second', clock_timestamp()) + interval '40 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
	-- Otto's todo, and a run of one of Nora's routines (a member's, so the run is Nora's own unattended run).
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'listen-0002', jsonb_build_array(
		pg_temp.todo(todo, d1, 'Build the landing page'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'listen-0003', jsonb_build_array(pg_temp.routine(
		'QorperaOS/agents/nora/routines/inbox.md', pg_temp.rparse(e1, 'Inbox', pg_temp.every())))), 1, 'saved');
	a := pg_temp.routine_run(e1);

	-- The shape: after is a todo's or a human task's path, and only with when: once.
	perform pg_temp.misread('l1-shape-1', pg_temp.rparse(el, 'X', pg_temp.after('2030-01-01T09:00:00Z', 'product/plan.md')), 'trigger');
	perform pg_temp.misread('l1-shape-2', pg_temp.rparse(el, 'X', pg_temp.every() || '{"after":"QorperaOS/agents/otto/todos/landing-page.md"}'),
		'trigger');

	-- The rules: the company has no todo or human task there.
	u := jsonb_build_array(pg_temp.routine(p, pg_temp.rparse(el, 'Review the landing page',
		pg_temp.after(soon, 'QorperaOS/agents/otto/todos/missing.md'))));
	if pg_temp.problem(pg_temp.reviewed(a, 'l1-rule-1', u)) is distinct from 'after names no todo or human task of this company: '
		|| 'QorperaOS/agents/otto/todos/missing.md; give the path of one, as manage_todo or the human task lists show it' then
		raise exception 'A listener names a todo the company has: %', pg_temp.reviewed(a, 'l1-rule-1b', u); end if;

	-- A listener waits at most 31 days.
	if pg_temp.problem(pg_temp.reviewed(a, 'l1-rule-2', jsonb_build_array(pg_temp.routine(p,
			pg_temp.rparse(el, 'Review the landing page', pg_temp.after(far, todo)))))) is distinct from
		'a listener waits at most 31 days: choose an at within that, and decide again then if it is still open' then
		raise exception 'A listener''s latest time is bounded'; end if;

	-- Saved: the version keeps the folded key, and the routine listens while the todo is open.
	u := jsonb_build_array(pg_temp.routine(p, pg_temp.rparse(el, 'Review the landing page', pg_temp.after(soon, todo))));
	perform pg_temp.expect(pg_temp.commit(a, 'l1-save-1', u), 1, 'denied', 'review_required');
	perform pg_temp.expect(pg_temp.reviewed(a, 'l1-save-2', u), 1, 'saved');
	v := pg_temp.rv(el);
	if v.triggers is distinct from jsonb_build_array(jsonb_build_object('id','file','kind','once','at',soon,
			'after','qorperaos/agents/otto/todos/landing-page.md','timeZone','Europe/Copenhagen','replyPolicy','optional')) then
		raise exception 'The listener''s version: %', v.triggers; end if;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if not pg_temp.listening(el) or pg_temp.listed(el) then raise exception 'It listens while the todo is open'; end if;

	-- Otto finishes the todo: nothing open is left, so the tick lists it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'listen-0004', jsonb_build_array(
		pg_temp.todo(todo, d1, 'Build the landing page', 'done'))), 1, 'saved');
	if pg_temp.listening(el) or not pg_temp.listed(el) then raise exception 'A done todo ends the wait'; end if;

	-- The routine's own run decides: a plain next run drops after, with no review.
	b := pg_temp.routine_run(el);
	perform pg_temp.expect(pg_temp.commit(b, 'l1-decide-1', jsonb_build_array(pg_temp.routine(p,
		pg_temp.rparse(el, 'Review the landing page', pg_temp.once('2030-02-01T09:00:00Z'))))), 1, 'saved');
	v := pg_temp.rv(el);
	if v.triggers -> 0 ? 'after' or v.triggers -> 0 ->> 'at' <> '2030-02-01T09:00:00Z' then
		raise exception 'A plain decision drops after: %', v.triggers; end if;
end $$;

rollback;
