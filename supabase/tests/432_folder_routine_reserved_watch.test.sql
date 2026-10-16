-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine: its row, its version and its position"
-- Launch checklist L23.2 (migration 20260930493000): a routine never watches a reserved path. No save lands on one
-- (qorpera_folder_path_reserved: .qorpera, trail, inbox, credentials, secrets, and .git or node_modules outside code/),
-- so a file-change routine watching one would never wake. The routine rules refuse it as their other problems
-- (structured_rule, one value problem naming the watch), by its folder key (Inbox, inbox and inbox/x.md alike), for a
-- member and an agent's run, on a new routine and on an edit, before the read check; nothing is stored. A watch outside
-- them, and a .git under code/, is saved as before. On 708's company (Nora and Otto); rolled back at the end.

create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.saved(p_result jsonb) returns jsonb language plpgsql as $$
begin
	if p_result is null or exists (select 1 from jsonb_array_elements(p_result -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Fixture commit: %', p_result; end if;
	return p_result;
end $$;
create function pg_temp.watch(p_id uuid, p_watch text, p_match text) returns jsonb language sql as $$
	select pg_temp.rparse(p_id, 'Watch ' || p_watch, jsonb_build_object('when','file-change','watch',p_watch,'match',p_match))
$$;
-- The one problem a reserved watch gets (the commit leaves out its null line and key).
create function pg_temp.reserved(p_watch text) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('code', 'value', 'message', p_watch
		|| ' is reserved: nothing is ever saved there, so this routine would never wake; watch a folder the company writes, like orders'))
$$;
-- A routine file at p_path watching p_watch, saved by p_actor: refused for its reserved watch, and nothing stored (no
-- seq, no file version, no routine row).
create function pg_temp.refuse(p_actor jsonb, p_key text, p_path text, p_id uuid, p_watch text, p_match text)
returns void language plpgsql as $$
declare v_seq bigint := pg_temp.seq(); v_file uuid := pg_temp.version(p_path); r jsonb;
begin
	r := pg_temp.commit(p_actor, p_key, jsonb_build_array(pg_temp.routine(p_path, pg_temp.watch(p_id, p_watch, p_match))));
	if not pg_temp.refused(r) or r -> 'units' -> 0 -> 'problems' is distinct from pg_temp.reserved(p_watch) then
		raise exception 'A watch on % (%) is refused as reserved: %', p_watch, p_match, r; end if;
	if r ->> 'seq' is not null or pg_temp.seq() is distinct from v_seq or pg_temp.version(p_path) is distinct from v_file then
		raise exception 'A refused watch on % stores nothing: %', p_watch, r; end if;
end $$;

-- 1. Folders the company writes, one under code/, and the reserved paths by their folder key -------------------------------

do $$
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'reserved-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','orders'), jsonb_build_object('op','mkdir','path','orders/incoming'),
		jsonb_build_object('op','mkdir','path','code'), jsonb_build_object('op','mkdir','path','code/repo'),
		jsonb_build_object('op','mkdir','path','code/repo/.git'))));
	if not (select bool_and(public.qorpera_folder_path_reserved(public.qorpera_folder_key(p))) from unnest(array['inbox', 'Inbox',
			'inbox/x.md', 'ＩＮＢＯＸ', 'trail', '.qorpera/x.md', 'credentials', 'secrets/api.md', 'orders/node_modules',
			'orders/incoming/.git/HEAD']) p)
		or (select bool_or(public.qorpera_folder_path_reserved(public.qorpera_folder_key(p))) from unnest(array['orders',
			'orders/incoming', 'orders/inbox', 'inboxes', 'code/repo/.git', 'code/repo/node_modules', 'agents/nora']) p) then
		raise exception 'The reserved paths by their folder key'; end if;
end $$;

-- 2. A new routine watching a reserved path is refused, for a member and an agent's run ----------------------------------

do $$
declare w text[]; i integer := 0; a jsonb;
begin
	-- Every reserved root, a file and a folder under one, any case or width, exact or subtree; .git and node_modules
	-- outside code/. Credentials and secrets, which the agent may not read either, are refused as reserved.
	foreach w slice 1 in array array[['inbox','subtree'], ['Inbox','subtree'], ['inbox/x.md','exact'], ['ＩＮＢＯＸ/Mail','subtree'],
		['trail','subtree'], ['.qorpera','subtree'], ['.qorpera/settings.md','exact'], ['credentials','subtree'],
		['secrets/api.md','exact'], ['orders/node_modules','subtree'], ['orders/incoming/.git/HEAD','exact']] loop
		i := i + 1;
		perform pg_temp.refuse(pg_temp.owner(), 'reserved-01' || lpad(i::text, 2, '0'), 'agents/nora/routines/watch-' || i || '.md',
			('43200000-0000-4000-8000-0000000001' || lpad(i::text, 2, '0'))::uuid, w[1], w[2]);
		perform pg_temp.is((pg_temp.rt(('43200000-0000-4000-8000-0000000001' || lpad(i::text, 2, '0'))::uuid)).id::text, null,
			'no routine row for a watch on ' || w[1]);
	end loop;
	-- The member who does not pay for unattended work, in Otto's folder: the same refusal.
	perform pg_temp.refuse(pg_temp.mem(), 'reserved-0201', 'agents/otto/routines/mail.md', '43200000-0000-4000-8000-000000000201',
		'inbox', 'subtree');
	-- An agent's run (manage_routine) saving a routine of its own: refused at once, before any review.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'reserved-0202', jsonb_build_array(pg_temp.routine(
		'agents/nora/routines/hourly.md', pg_temp.rparse('43200000-0000-4000-8000-000000000202', 'Hourly', pg_temp.every())))));
	a := pg_temp.routine_run('43200000-0000-4000-8000-000000000202');
	perform pg_temp.refuse(a, 'reserved-0203', 'agents/nora/routines/mail.md', '43200000-0000-4000-8000-000000000203',
		'inbox', 'subtree');
	perform pg_temp.refuse(a, 'reserved-0204', 'agents/nora/routines/mail.md', '43200000-0000-4000-8000-000000000203',
		'inbox/new', 'subtree');
	perform pg_temp.is((pg_temp.rt('43200000-0000-4000-8000-000000000203')).id::text, null, 'no routine row for the run''s watch');
	-- inbox/ with its slash never reaches the rules: the parse refuses an empty part (as the agent's tool does).
	perform pg_temp.misread('reserved-0205', pg_temp.watch('43200000-0000-4000-8000-000000000204', 'inbox/', 'subtree'), 'trigger');
end $$;

-- 3. A watch outside them is saved as before ---------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'reserved-0301', jsonb_build_array(
		pg_temp.routine('agents/nora/routines/orders.md', pg_temp.watch('43200000-0000-4000-8000-000000000301', 'orders/incoming', 'subtree')),
		pg_temp.routine('agents/nora/routines/order.md', pg_temp.watch('43200000-0000-4000-8000-000000000302', 'orders/incoming/a.md', 'exact')),
		pg_temp.routine('agents/otto/routines/repo.md', pg_temp.watch('43200000-0000-4000-8000-000000000303', 'code/repo/.git', 'subtree')))));
	perform pg_temp.is((pg_temp.rv('43200000-0000-4000-8000-000000000301')).triggers::text,
		'[{"id": "file", "kind": "file-change", "match": "subtree", "watch": "orders/incoming", "timeZone": "Europe/Copenhagen", "replyPolicy": "optional"}]',
		'the watch on orders/incoming');
	perform pg_temp.is((pg_temp.rt('43200000-0000-4000-8000-000000000301')).status, 'active', 'an active listener');
	perform pg_temp.is((pg_temp.rv('43200000-0000-4000-8000-000000000302')).triggers -> 0 ->> 'watch', 'orders/incoming/a.md',
		'the exact watch on a file');
	perform pg_temp.is((pg_temp.rv('43200000-0000-4000-8000-000000000303')).triggers -> 0 ->> 'watch', 'code/repo/.git',
		'.git under code/ is not reserved');
end $$;

-- 4. An edit that points a saved routine's watch at a reserved path is refused; the routine stays as it was ------------------

do $$
declare e constant uuid := '43200000-0000-4000-8000-000000000301'; p constant text := 'agents/nora/routines/orders.md';
	a jsonb; v_file uuid; v_row jsonb; v_version jsonb;
begin
	-- A run of Nora's hourly routine (708's run fixture has no file wake), acting for her agent.
	a := pg_temp.routine_run('43200000-0000-4000-8000-000000000202');
	v_file := pg_temp.version(p); v_row := to_jsonb(pg_temp.rt(e)); v_version := to_jsonb(pg_temp.rv(e));
	-- By a member, by Nora's run, and with a pause in the same save.
	perform pg_temp.refuse(pg_temp.owner(), 'reserved-0401', p, e, 'inbox', 'subtree');
	perform pg_temp.refuse(a, 'reserved-0402', p, e, 'Inbox/order.md', 'exact');
	perform pg_temp.refuse(pg_temp.owner(), 'reserved-0403', p, e, 'orders/incoming/node_modules', 'subtree');
	if pg_temp.problem(pg_temp.commit(pg_temp.owner(), 'reserved-0404', jsonb_build_array(pg_temp.routine(p,
		pg_temp.watch(e, 'trail', 'subtree') || '{"status":"paused"}'))))
		is distinct from pg_temp.reserved('trail') -> 0 ->> 'message' then
		raise exception 'A paused routine does not watch a reserved path either'; end if;
	if pg_temp.version(p) is distinct from v_file or to_jsonb(pg_temp.rt(e)) is distinct from v_row
		or to_jsonb(pg_temp.rv(e)) is distinct from v_version then
		raise exception 'A refused edit leaves the routine as it was: %, %', to_jsonb(pg_temp.rt(e)), to_jsonb(pg_temp.rv(e)); end if;
	-- Pointed at another folder the company writes, the edit is saved.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'reserved-0405', jsonb_build_array(pg_temp.routine(p,
		pg_temp.watch(e, 'orders', 'subtree')))));
	perform pg_temp.is((pg_temp.rv(e)).triggers -> 0 ->> 'watch', 'orders', 'the edit to orders');
end $$;

rollback;
