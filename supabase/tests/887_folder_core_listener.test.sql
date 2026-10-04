-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine: its row, its version and its position"
-- Company folder core, P29a (migration 20260930020000; deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md): file-change
-- wakes on the folder journal. A routine file with `when: file-change` is a listener from the change set that saved it;
-- the drain wakes it once per change set that touches its watch (exact or subtree, moves from and into it, a copy at its
-- target), never for its own agent's change, never naming a path its run may not read, at most 21 versions with `more`;
-- a paused company writes no wake and moves on; a known refusal (an expired routine, one at its limit, an archived agent)
-- is passed over without stopping the others; the H2c hook sees every change set in order, and a failed call is recorded
-- and called again, after a wait that doubles, until it succeeds. Then: 32 wakes a step inside one change set and a lock
-- error in the hook undoing its step; a failing targets hook or an invalid trigger never holding the cursor; the run's
-- wake read end to end; erasure noting the run of a file wake about what it erases. On 708's company (Nora and Otto); rolled back at the end. Races are 888's.

create function pg_temp.put(p_path text, p_text text) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text))
		|| case when pg_temp.version(public.qorpera_folder_key(p_path)) is not null
			then jsonb_build_object('expectedVersion', pg_temp.version(public.qorpera_folder_key(p_path))) else '{}'::jsonb end
$$;
create function pg_temp.mv(p_from text, p_to text) returns jsonb language sql as $$
	select jsonb_build_object('op','move','from',p_from,'to',p_to,'expectedVersion',pg_temp.version(public.qorpera_folder_key(p_from)),
		'asOfSeq',pg_temp.seq())
$$;
create function pg_temp.cp(p_from text, p_to text) returns jsonb language sql as $$
	select jsonb_build_object('op','copy','from',p_from,'to',p_to,'expectedVersion',pg_temp.version(public.qorpera_folder_key(p_from)))
$$;
create function pg_temp.saved(p_result jsonb) returns jsonb language plpgsql as $$
begin
	if p_result is null or exists (select 1 from jsonb_array_elements(p_result -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Fixture commit: %', p_result; end if;
	return p_result;
end $$;
create function pg_temp.listen() returns jsonb language sql as $$
	select public.qorpera_folder_listen_company('70700000-0000-4000-8000-000000000020')
$$;
-- The file wakes of a routine, oldest first.
create function pg_temp.fw(p_routine uuid) returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where routine_id = p_routine and source_kind = 'company-file'
	order by (payload ->> 'seq')::bigint
$$;
create function pg_temp.fw_count(p_routine uuid) returns integer language sql as $$
	select count(*)::integer from public.qorpera_wake_occurrences where routine_id = p_routine and source_kind = 'company-file'
$$;
create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.watch(p_id uuid, p_watch text, p_match text) returns jsonb language sql as $$
	select pg_temp.rparse(p_id, 'Watch ' || p_watch, jsonb_build_object('when','file-change','watch',p_watch,'match',p_match))
$$;
-- The calls the H2c hook got, and a seq it fails on.
create temp table hook_calls (n bigserial, commit_id uuid, seq bigint, paused boolean, actor jsonb);

-- 1. Listeners: the trigger, activation, the refusals gone ------------------------------------------------------------------

do $$
declare r jsonb;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','docs'), jsonb_build_object('op','mkdir','path','docs/sub'),
		jsonb_build_object('op','mkdir','path','notes'))));
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0002', jsonb_build_array(
		pg_temp.routine('agents/nora/routines/docs.md', pg_temp.watch('88700000-0000-4000-8000-0000000000e1', 'docs', 'subtree')),
		pg_temp.routine('agents/otto/routines/exact.md', pg_temp.watch('88700000-0000-4000-8000-0000000000e2', 'docs/a.md', 'exact')))));
	perform pg_temp.is((pg_temp.rv('88700000-0000-4000-8000-0000000000e1')).triggers::text,
		'[{"id": "file", "kind": "file-change", "match": "subtree", "watch": "docs", "timeZone": "Europe/Copenhagen", "replyPolicy": "optional"}]',
		'the listener''s trigger');
	perform pg_temp.is((pg_temp.rt('88700000-0000-4000-8000-0000000000e1')).status, 'active', 'an active listener');
	-- The saving change set never wakes the routine it saved.
	r := pg_temp.listen();
	perform pg_temp.is(r ->> 'state', 'done', 'the first step');
	perform pg_temp.is((pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1') + pg_temp.fw_count('88700000-0000-4000-8000-0000000000e2'))::text,
		'0', 'activation: nothing up to the saving change set');
	perform pg_temp.is(pg_temp.listen() ->> 'state', 'idle', 'nothing new');
	-- The trigger check takes the folded watch only; the run resolve no longer refuses a file wake.
	if not public.qorpera_cloud_routine_trigger_valid('{"id":"file","kind":"file-change","watch":"docs","match":"subtree","timeZone":"UTC"}')
		or public.qorpera_cloud_routine_trigger_valid('{"id":"file","kind":"file-change","watch":"Docs","match":"subtree","timeZone":"UTC"}')
		or public.qorpera_cloud_routine_trigger_valid('{"id":"file","kind":"file-change","watch":"docs","match":"near","timeZone":"UTC"}') then
		raise exception 'The file-change trigger''s shape'; end if;
	if (select strpos(prosrc, '''company-file'',''office-activation''') from pg_proc
			where oid = 'public.qorpera_folder_run_resolve(uuid,uuid,jsonb)'::regprocedure) <> 0 then
		raise exception 'The run resolve accepts file wakes'; end if;
end $$;

-- 2. Matching: exact and subtree, siblings, moves from and into the watch, a copy at its target, a delete ----------------

do $$
declare r jsonb; w public.qorpera_wake_occurrences; v_changes jsonb;
begin
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0003', jsonb_build_array(pg_temp.put('docs/a.md', 'alpha'))));
	perform pg_temp.listen();
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1');
	if w.status <> 'queued' or w.source_id::text <> r ->> 'commitId' or w.occurrence_key <> 'file:' || (r ->> 'seq') || ':1'
		or w.trigger_id <> 'file' or w.payload <> jsonb_build_object('schema','qorpera.folder-file-wake/v1','seq',(r ->> 'seq')::bigint,
			'commitId',r ->> 'commitId','versions',jsonb_build_array(pg_temp.version('docs/a.md')),'more',0)
		or w.parent_run_id is not null or w.causal_root_id::text <> r ->> 'commitId'
		or w.causal_agent_ids <> array['70700000-0000-4000-8000-0000000000a1']::uuid[] then
		raise exception 'The subtree listener''s wake: %', to_jsonb(w); end if;
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e2')::text, '1', 'the exact listener too');
	if not public.qorpera_wake_authorized(w) then raise exception 'The wake is authorized, as the materializer asks'; end if;
	-- Under the subtree, and beside it.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0004', jsonb_build_array(pg_temp.put('docs/sub/b.md', 'beta'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0005', jsonb_build_array(pg_temp.put('docs-x.md', 'beside'),
		pg_temp.put('notes/c.md', 'gamma'))));
	perform pg_temp.listen();
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '2', 'a change under the watch, none beside it');
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e2')::text, '1', 'the exact watch sees only its path');
	-- Out of the watch, into it, and a copy (at its target only).
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0006', jsonb_build_array(pg_temp.mv('docs/sub/b.md', 'notes/b.md'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0007', jsonb_build_array(pg_temp.mv('notes/c.md', 'docs/c.md'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0008', jsonb_build_array(pg_temp.cp('docs/c.md', 'notes/c2.md'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0009', jsonb_build_array(pg_temp.cp('notes/b.md', 'docs/b2.md'))));
	perform pg_temp.listen();
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '5',
		'a move out, a move in and a copy in each wake it; a copy out does not');
	-- The run reads its changes as they are now: a move in names its readable source.
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1') offset 3 limit 1;
	v_changes := public.qorpera_folder_file_wake_changes(w, public.qorpera_folder_listener_actor(w.profile_id, w.staff_agent_id,
		w.requested_by_user_id, w.session_id)) -> 'changes';
	if v_changes -> 0 ->> 'path' <> 'docs/c.md' or v_changes -> 0 ->> 'op' <> 'move_in' or v_changes -> 0 ->> 'from' <> 'notes/c.md' then
		raise exception 'A move in, with its source: %', v_changes; end if;
	-- A delete under the watch wakes too, naming the version it ended.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0009b', jsonb_build_array(pg_temp.del('docs/b2.md'))));
	perform pg_temp.listen();
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '6', 'a delete wakes');
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1') offset 5 limit 1;
	v_changes := public.qorpera_folder_file_wake_changes(w, public.qorpera_folder_listener_actor(w.profile_id, w.staff_agent_id,
		w.requested_by_user_id, w.session_id)) -> 'changes';
	if jsonb_array_length(v_changes) <> 1 or v_changes -> 0 ->> 'path' <> 'docs/b2.md' or v_changes -> 0 ->> 'op' <> 'delete'
		or v_changes -> 0 ->> 'priorVersion' is null then
		raise exception 'A delete, with the version it ended: %', v_changes; end if;
end $$;

-- 3. Read rights: a path the run may not read is never named nor counted, and a grant narrowed later drops it -----------

do $$
declare w public.qorpera_wake_occurrences;
begin
	-- docs/private is the member's own (…02): Nora's run, for the owner and the company, may not read it.
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy, created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', 'docs/private', 'subtree', 'member_private', '70700000-0000-4000-8000-000000000002',
		'normal', '70700000-0000-4000-8000-000000000002');
	perform pg_temp.saved(pg_temp.commit('{"kind":"platform"}', 'listen-0010', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','docs/private'), pg_temp.put('docs/private/s.md', 'hidden'))));
	perform pg_temp.listen();
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '6', 'no wake for unreadable paths alone');
	perform pg_temp.saved(pg_temp.commit('{"kind":"platform"}', 'listen-0011', jsonb_build_array(
		pg_temp.put('docs/private/t.md', 'hidden too'), pg_temp.put('docs/pub.md', 'public'))));
	perform pg_temp.listen();
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1') offset 6 limit 1;
	if w.payload -> 'versions' <> jsonb_build_array(pg_temp.version('docs/pub.md')) or (w.payload ->> 'more')::integer <> 0 then
		raise exception 'Only the readable path, and the unreadable one not counted: %', w.payload; end if;
	-- A grant narrowed before the run reads its wake: the change drops out of what it reads, and the wake is no longer
	-- readable, so the materializer cancels it (qorpera_folder_wake_authorized).
	if not public.qorpera_folder_file_wake_readable(w) then raise exception 'The wake is readable before the narrowing'; end if;
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy, created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', 'docs/pub.md', 'exact', 'member_private', '70700000-0000-4000-8000-000000000002',
		'normal', '70700000-0000-4000-8000-000000000002');
	if public.qorpera_folder_file_wake_readable(w) or public.qorpera_folder_wake_authorized(w)
		or jsonb_array_length(public.qorpera_folder_file_wake_changes(w, public.qorpera_folder_listener_actor(w.profile_id,
			w.staff_agent_id, w.requested_by_user_id, w.session_id)) -> 'changes') <> 0 then
		raise exception 'A narrowed grant drops the change at read time'; end if;
	delete from public.qorpera_company_path_resources where environment_id = '70700000-0000-4000-8000-000000000020' and path = 'docs/pub.md';
end $$;

-- 4. The self rule: a run's own change never wakes its agent; another agent's listener carries the chain on -------------

do $$
declare a jsonb; r jsonb; w public.qorpera_wake_occurrences;
begin
	-- A run of another routine of Nora's (a schedule).
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0012a', jsonb_build_array(
		pg_temp.routine('agents/nora/routines/hourly.md', pg_temp.rparse('88700000-0000-4000-8000-0000000000e3', 'Hourly', pg_temp.every(60))))));
	a := pg_temp.routine_run('88700000-0000-4000-8000-0000000000e3');
	r := pg_temp.saved(pg_temp.commit(a, 'listen-0012', jsonb_build_array(pg_temp.put('docs/a.md', 'alpha by nora'))));
	perform pg_temp.listen();
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '7', 'Nora''s own change never wakes Nora');
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e2') offset 1 limit 1;
	if w.source_id::text <> r ->> 'commitId' or w.parent_run_id::text <> a ->> 'runId'
		or w.causal_agent_ids <> array['70700000-0000-4000-8000-0000000000a1','70700000-0000-4000-8000-0000000000a2']::uuid[]
		or not public.qorpera_wake_authorized(w) then
		raise exception 'Otto''s wake carries Nora''s chain: %', to_jsonb(w); end if;
end $$;

-- 5. Bounds: 21 versions, the rest counted in more --------------------------------------------------------------------------

do $$
declare w public.qorpera_wake_occurrences; v_changes jsonb;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0013', (select jsonb_agg(pg_temp.put('docs/m' || lpad(i::text, 2, '0') || '.md',
		'many ' || i)) from generate_series(1, 25) i)));
	perform pg_temp.listen();
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1') offset 7 limit 1;
	if jsonb_array_length(w.payload -> 'versions') <> 21 or (w.payload ->> 'more')::integer <> 4 then
		raise exception '21 versions and more: %', w.payload; end if;
	-- One of them made private before the run reads: 20 changes, and the stored count, read under the old rights, dropped.
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy, created_by_user_id)
	values ('70700000-0000-4000-8000-000000000020', 'docs/m01.md', 'exact', 'member_private', '70700000-0000-4000-8000-000000000002',
		'normal', '70700000-0000-4000-8000-000000000002');
	v_changes := public.qorpera_folder_file_wake_changes(w, public.qorpera_folder_listener_actor(w.profile_id, w.staff_agent_id,
		w.requested_by_user_id, w.session_id));
	if jsonb_array_length(v_changes -> 'changes') <> 20 or (v_changes ->> 'more')::integer <> 0 then
		raise exception 'A hidden change hides the stored count too: %', v_changes; end if;
	delete from public.qorpera_company_path_resources where environment_id = '70700000-0000-4000-8000-000000000020' and path = 'docs/m01.md';
end $$;

-- 6. Known refusals are passed over, the others still wake; a paused company writes nothing and moves on ---------------------

do $$
declare r jsonb; v_unit jsonb;
begin
	update public.qorpera_cloud_routines set max_occurrences = public.qorpera_routine_occurrence_count(id)
	where id = '88700000-0000-4000-8000-0000000000e2';
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0014', jsonb_build_array(pg_temp.put('docs/a.md', 'alpha again'))));
	r := pg_temp.listen();
	perform pg_temp.is(r ->> 'skipped', '1', 'Otto''s routine at its limit is passed over');
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '9', 'Nora''s still wakes');
	-- Otto archived, his routine not followed yet (still active): passed over.
	update public.qorpera_cloud_routines set max_occurrences = null where id = '88700000-0000-4000-8000-0000000000e2';
	update public.qorpera_profile_staff set employment_status = 'archived'
	where profile_id = '70700000-0000-4000-8000-000000000010' and staff_agent_id = '70700000-0000-4000-8000-0000000000a2';
	perform pg_temp.is((pg_temp.rt('88700000-0000-4000-8000-0000000000e2')).status, 'active', 'the routine not followed yet');
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0014b', jsonb_build_array(pg_temp.put('docs/a.md', 'alpha archived'))));
	r := pg_temp.listen();
	perform pg_temp.is(r ->> 'inactive', '1', 'an archived agent''s routine is set aside');
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e2')::text, '2', 'and wakes nothing');
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '10', 'Nora''s still wakes');
	update public.qorpera_profile_staff set employment_status = 'active'
	where profile_id = '70700000-0000-4000-8000-000000000010' and staff_agent_id = '70700000-0000-4000-8000-0000000000a2';
	update public.qorpera_cloud_routines set expires_at = clock_timestamp() - interval '1 minute'
	where id = '88700000-0000-4000-8000-0000000000e2';
	-- Staged before the pause (an upload stops with the company; a member's save does not).
	v_unit := pg_temp.put('docs/a.md', 'alpha paused');
	perform pg_temp.possess('70700000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(v_unit));
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000001', 'test');
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0015', jsonb_build_array(v_unit)));
	r := pg_temp.listen();
	perform pg_temp.is(r ->> 'state', 'paused', 'a paused company');
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '10', 'writes no wake');
	delete from public.qorpera_company_execution_pauses where profile_id = '70700000-0000-4000-8000-000000000010';
	perform pg_temp.is(pg_temp.listen() ->> 'state', 'idle', 'and does not replay it after the resume');
end $$;

-- 7. The H2c hook: every change set in order; a failed call is recorded and called again until it succeeds ----------------

create or replace function public.qorpera_folder_listener_commit(p_environment_id uuid, p_commit jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
	insert into pg_temp.hook_calls(commit_id, seq, paused, actor) values ((p_commit ->> 'commitId')::uuid,
		(p_commit ->> 'seq')::bigint, (p_commit ->> 'paused')::boolean, p_commit -> 'actor');
	if (p_commit ->> 'seq') = current_setting('qorpera_test.hook_fails', true) then
		raise exception 'H2c is down' using errcode = 'P0887'; end if;
end $$;

do $$
declare r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; r jsonb; v_unit jsonb;
begin
	r1 := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0016', jsonb_build_array(pg_temp.put('notes/h1.md', 'one'))));
	r2 := pg_temp.saved(pg_temp.commit(pg_temp.mem(), 'listen-0017', jsonb_build_array(pg_temp.put('notes/h2.md', 'two'))));
	perform set_config('qorpera_test.hook_fails', r1 ->> 'seq', true);
	r := pg_temp.listen();
	perform pg_temp.is(r ->> 'hookFailures', '1', 'the failure is counted, the step goes on');
	-- A failed call's own work is undone with it: only the second change set's call stays, with its actor.
	if (select array_agg(seq order by seq) from pg_temp.hook_calls) <> array[(r2 ->> 'seq')::bigint]
		or (select actor from pg_temp.hook_calls where seq = (r2 ->> 'seq')::bigint)
			<> '{"id":"70700000-0000-4000-8000-000000000002","kind":"member"}'::jsonb then
		raise exception 'Each change set, with its actor: %', (select jsonb_agg(to_jsonb(h)) from pg_temp.hook_calls h); end if;
	if not exists (select 1 from public.qorpera_folder_listener_hook_failures where commit_id = (r1 ->> 'commitId')::uuid
			and sqlstate = 'P0887' and attempts = 1) then raise exception 'The failure is recorded, without its text'; end if;
	perform pg_temp.is((select processed_seq from public.qorpera_folder_listener_cursors
		where environment_id = '70700000-0000-4000-8000-000000000020')::text, r2 ->> 'seq', 'the cursor moves on');
	-- Not called again before its wait (5 s), nor is the company due for it.
	perform pg_temp.is(pg_temp.listen() ->> 'state', 'idle', 'a failure waits');
	if (select public.qorpera_folder_listen_due() -> 'items' @> '[{"environment_id":"70700000-0000-4000-8000-000000000020"}]') then
		raise exception 'A failure still waiting makes no company due'; end if;
	-- After it: still failing, called again with no new change set, counted again; the next wait is 10 s.
	update public.qorpera_folder_listener_hook_failures set last_attempt_at = last_attempt_at - interval '5 seconds'
	where commit_id = (r1 ->> 'commitId')::uuid;
	if not (select public.qorpera_folder_listen_due() -> 'items' @> '[{"environment_id":"70700000-0000-4000-8000-000000000020"}]') then
		raise exception 'A company with a failure to call again is due'; end if;
	perform pg_temp.listen();
	perform pg_temp.is((select attempts from public.qorpera_folder_listener_hook_failures
		where commit_id = (r1 ->> 'commitId')::uuid)::text, '2', 'called again with no new change set');
	perform pg_temp.is((select array_agg(extract(epoch from public.qorpera_folder_listener_retry_at(n, 'epoch'))::integer order by n)
		from generate_series(1, 9) n)::text, '{5,10,20,40,80,160,320,600,600}', 'the waits double up to 10 minutes');
	-- Then it succeeds and the record goes.
	perform set_config('qorpera_test.hook_fails', '', true);
	update public.qorpera_folder_listener_hook_failures set last_attempt_at = last_attempt_at - interval '10 seconds'
	where commit_id = (r1 ->> 'commitId')::uuid;
	perform pg_temp.listen();
	if exists (select 1 from public.qorpera_folder_listener_hook_failures where commit_id = (r1 ->> 'commitId')::uuid)
		or not exists (select 1 from pg_temp.hook_calls where seq = (r1 ->> 'seq')::bigint and not paused) then
		raise exception 'A call that succeeds removes its record'; end if;
	perform pg_temp.is(pg_temp.listen() ->> 'state', 'idle', 'then the company is idle');
	-- Change sets reach the hook in seq order; a paused company's with paused set.
	r3 := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0018', jsonb_build_array(pg_temp.put('notes/h3.md', 'three'))));
	r4 := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0019', jsonb_build_array(pg_temp.put('notes/h4.md', 'four'))));
	perform pg_temp.listen();
	v_unit := pg_temp.put('notes/h5.md', 'five');
	perform pg_temp.possess('70700000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(v_unit));
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000001', 'test');
	r5 := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0020', jsonb_build_array(v_unit)));
	perform pg_temp.is(pg_temp.listen() ->> 'state', 'paused', 'a paused step');
	delete from public.qorpera_company_execution_pauses where profile_id = '70700000-0000-4000-8000-000000000010';
	if (select jsonb_agg(jsonb_build_array(seq, paused) order by n) from pg_temp.hook_calls where seq > (r2 ->> 'seq')::bigint)
		<> jsonb_build_array(jsonb_build_array((r3 ->> 'seq')::bigint, false), jsonb_build_array((r4 ->> 'seq')::bigint, false),
			jsonb_build_array((r5 ->> 'seq')::bigint, true)) then
		raise exception 'The hook hears change sets in order, paused when paused: %',
			(select jsonb_agg(to_jsonb(h) order by n) from pg_temp.hook_calls h); end if;
end $$;

-- 8. Grants and the lock text --------------------------------------------------------------------------------------------

do $$
declare v_fn regprocedure; v_body text;
begin
	foreach v_fn in array array['public.qorpera_folder_listen_company(uuid,integer)', 'public.qorpera_folder_listen_due(uuid,integer)']::regprocedure[] loop
		if not has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('authenticated', v_fn, 'execute') then raise exception 'Grants of %', v_fn; end if;
	end loop;
	foreach v_fn in array array['public.qorpera_folder_listener_matches(uuid,uuid,jsonb,uuid,text,text)',
			'public.qorpera_folder_listener_commit(uuid,jsonb)', 'public.qorpera_folder_listener_targets(uuid,jsonb)',
		'public.qorpera_folder_listener_retry_at(integer,timestamptz)',
		'public.qorpera_folder_listener_targets_valid(uuid,jsonb)']::regprocedure[] loop
		if has_function_privilege('service_role', v_fn, 'execute') then raise exception 'No API role runs %', v_fn; end if;
	end loop;
	select prosrc into v_body from pg_proc where oid = 'public.qorpera_folder_listen_company(uuid,integer)'::regprocedure;
	-- The lease comes after the fence and ranks; no 40001; the 2 s budget.
	if strpos(v_body, 'for update skip locked') < strpos(v_body, 'qorpera_folder_company_enter')
		or v_body ~* '40001' or not (select proconfig @> array['lock_timeout=2s'] from pg_proc
			where oid = 'public.qorpera_folder_listen_company(uuid,integer)'::regprocedure) then
		raise exception 'The lock text of the drain'; end if;
	if exists (select 1 from pg_class where relname in ('qorpera_folder_listener_cursors','qorpera_folder_listener_hook_failures')
			and not relrowsecurity) then raise exception 'RLS on the new tables'; end if;
end $$;

-- 9. Bounds inside one change set: 32 wakes a step, the rest on the next, none twice; a lock error in the hook undoes the
-- whole step --------------------------------------------------------------------------------------------------------------

do $$
declare r jsonb; r1 jsonb; r2 jsonb; r3 jsonb; v_before bigint; v_state text;
begin
	-- 38 more listeners on docs/ (19 Nora's, 19 Otto's) beside e1; e2 (exact, docs/a.md) has expired by now.
	for i in 1 .. 38 loop
		perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'bound-r' || i, jsonb_build_array(
			pg_temp.routine(case when i % 2 = 0 then 'agents/nora' else 'agents/otto' end || '/routines/b' || lpad(i::text, 2, '0') || '.md',
				pg_temp.watch(('88700000-0000-4000-8000-0000000001' || lpad(i::text, 2, '0'))::uuid, 'docs', 'subtree')))));
	end loop;
	for i in 1 .. 20 loop
		v_state := pg_temp.listen() ->> 'state';
		exit when v_state = 'idle';
	end loop;
	perform pg_temp.is(v_state, 'idle', 'the saves drained');
	v_before := (select processed_seq from public.qorpera_folder_listener_cursors
		where environment_id = '70700000-0000-4000-8000-000000000020');
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'bound-0001', jsonb_build_array(pg_temp.put('docs/a.md', 'alpha bound'))));
	r1 := pg_temp.listen();
	r2 := pg_temp.listen();
	r3 := pg_temp.listen();
	if (r1 ->> 'wakes')::integer <> 32 or (r1 ->> 'processedSeq')::bigint <> v_before or (r1 ->> 'more')::boolean is not true
		or (r2 ->> 'wakes')::integer <> 7 or (r2 ->> 'processedSeq')::bigint <> (r ->> 'seq')::bigint or r3 ->> 'state' <> 'idle'
		or (select count(*) from public.qorpera_wake_occurrences where source_kind = 'company-file'
			and source_id = (r ->> 'commitId')::uuid) <> 39
		or (select count(distinct routine_id) from public.qorpera_wake_occurrences where source_kind = 'company-file'
			and source_id = (r ->> 'commitId')::uuid) <> 39 then
		raise exception 'Bounded steps, each wake once: % % %', r1, r2, r3; end if;
end $$;

create or replace function public.qorpera_folder_listener_commit(p_environment_id uuid, p_commit jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if current_setting('qorpera_test.hook_lock', true) = 'on' then raise exception 'held' using errcode = '55P03'; end if;
	insert into pg_temp.hook_calls(commit_id, seq, paused, actor) values ((p_commit ->> 'commitId')::uuid,
		(p_commit ->> 'seq')::bigint, (p_commit ->> 'paused')::boolean, p_commit -> 'actor');
end $$;

do $$
declare r jsonb; r1 jsonb; r2 jsonb; r3 jsonb; v_before bigint;
begin
	v_before := (select processed_seq from public.qorpera_folder_listener_cursors
		where environment_id = '70700000-0000-4000-8000-000000000020');
	-- 39 subtree listeners hear docs/zz.md: 32 in the first step (which stops before the hook), then 7 and the hook.
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'bound-0002', jsonb_build_array(pg_temp.put('docs/zz.md', 'zz'))));
	perform set_config('qorpera_test.hook_lock', 'on', true);
	r1 := pg_temp.listen();
	r2 := pg_temp.listen();
	if r1 ->> 'state' <> 'done' or (r1 ->> 'wakes')::integer <> 32 or r2 ->> 'state' <> 'busy'
		or (select count(*) from public.qorpera_wake_occurrences where source_kind = 'company-file'
			and source_id = (r ->> 'commitId')::uuid) <> 32
		or (select processed_seq from public.qorpera_folder_listener_cursors
			where environment_id = '70700000-0000-4000-8000-000000000020') <> v_before
		or exists (select 1 from public.qorpera_folder_listener_hook_failures where commit_id = (r ->> 'commitId')::uuid) then
		raise exception 'A lock error in the hook undoes its step: % %', r1, r2; end if;
	perform set_config('qorpera_test.hook_lock', 'off', true);
	r3 := pg_temp.listen();
	if r3 ->> 'state' <> 'done' or (r3 ->> 'wakes')::integer <> 7 or (r3 ->> 'processedSeq')::bigint <> (r ->> 'seq')::bigint
		or (select count(*) from public.qorpera_wake_occurrences where source_kind = 'company-file'
			and source_id = (r ->> 'commitId')::uuid) <> 39
		or not exists (select 1 from pg_temp.hook_calls where seq = (r ->> 'seq')::bigint) then
		raise exception 'Then the step is done once: %', r3; end if;
	-- The extra listeners rest.
	perform pg_temp.fx($q$update public.qorpera_cloud_routines set status = 'paused'
		where id::text like '88700000-0000-4000-8000-0000000001%'$q$);
end $$;

-- 10. Nothing holds the cursor: a targets hook that raises or answers a malformed shape, a trigger that no longer
-- validates ----------------------------------------------------------------------------------------------------------------

create or replace function public.qorpera_folder_listener_targets(p_environment_id uuid, p_commits jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if current_setting('qorpera_test.targets', true) = 'raise' then raise exception 'P31 is down' using errcode = 'P0888'; end if;
	if current_setting('qorpera_test.targets', true) = 'rank5' then
		return jsonb_build_object('targets', jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines',
			'key', '88700000-0000-4000-8000-0000000000e1', 'mode', 'nokeyupdate')), 'sessions', '[]'::jsonb, 'admit', false); end if;
	return '{"targets":[],"sessions":[],"admit":false}'::jsonb;
end $$;

do $$
declare r jsonb; r2 jsonb; s jsonb; w integer;
begin
	-- It raises: the listener still wakes, the cursor moves on, the change set is recorded for the hook with the SQLSTATE.
	perform set_config('qorpera_test.targets', 'raise', true);
	w := pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1');
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0030', jsonb_build_array(pg_temp.put('docs/t1.md', 't1'))));
	s := pg_temp.listen();
	if s ->> 'state' <> 'done' or s ->> 'processedSeq' <> r ->> 'seq' or pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1') <> w + 1
		or not exists (select 1 from public.qorpera_folder_listener_hook_failures where commit_id = (r ->> 'commitId')::uuid
			and sqlstate = 'P0888') or exists (select 1 from pg_temp.hook_calls where seq = (r ->> 'seq')::bigint) then
		raise exception 'A raising targets hook holds nothing: %', s; end if;
	-- A malformed answer (a target past rank 3) the same, as QP29T; the earlier failure is tried again and fails again.
	perform set_config('qorpera_test.targets', 'rank5', true);
	r2 := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0031', jsonb_build_array(pg_temp.put('notes/t2.md', 't2'))));
	update public.qorpera_folder_listener_hook_failures set last_attempt_at = last_attempt_at - interval '1 hour'
	where environment_id = '70700000-0000-4000-8000-000000000020';
	s := pg_temp.listen();
	if s ->> 'processedSeq' <> r2 ->> 'seq' or not exists (select 1 from public.qorpera_folder_listener_hook_failures
			where commit_id = (r2 ->> 'commitId')::uuid and sqlstate = 'QP29T')
		or (select attempts from public.qorpera_folder_listener_hook_failures where commit_id = (r ->> 'commitId')::uuid) <> 2 then
		raise exception 'A malformed targets answer holds nothing: %', s; end if;
	-- Fixed: both change sets reach the hook and their records go.
	perform set_config('qorpera_test.targets', '', true);
	update public.qorpera_folder_listener_hook_failures set last_attempt_at = last_attempt_at - interval '1 hour'
	where environment_id = '70700000-0000-4000-8000-000000000020';
	perform pg_temp.listen();
	if exists (select 1 from public.qorpera_folder_listener_hook_failures where environment_id = '70700000-0000-4000-8000-000000000020')
		or (select count(*) from pg_temp.hook_calls where seq in ((r ->> 'seq')::bigint, (r2 ->> 'seq')::bigint)) <> 2 then
		raise exception 'Once the targets hook answers, the change sets reach the hook'; end if;
	if public.qorpera_folder_listener_targets_valid('70700000-0000-4000-8000-000000000010', jsonb_build_object('targets', jsonb_build_array(
			jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', '70700000-0000-4000-8000-000000000010:70700000-0000-4000-8000-0000000000a1',
				'mode', 'keyshare')), 'sessions', jsonb_build_array(extensions.gen_random_uuid()), 'admit', true)) is not true
		or public.qorpera_folder_listener_targets_valid('70700000-0000-4000-8000-000000000010', jsonb_build_object('targets', jsonb_build_array(
			jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', '70800000-0000-4000-8000-000000000010:70700000-0000-4000-8000-0000000000a1',
				'mode', 'keyshare')))) is not false
		or public.qorpera_folder_listener_targets_valid('70700000-0000-4000-8000-000000000010', '{"admit":"yes"}') is not false
		or public.qorpera_folder_listener_targets_valid('70700000-0000-4000-8000-000000000010', '{"sessions":[1]}') is not false then
		raise exception 'The targets the drain accepts'; end if;
	-- A stored trigger that no longer validates (a watch that is not its own folded key) is no listener.
	perform pg_temp.fx($q$update public.qorpera_cloud_routine_versions set triggers = jsonb_set(triggers, '{0,watch}', '"Docs"')
		where routine_id = '88700000-0000-4000-8000-0000000000e1'$q$);
	w := pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1');
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0032', jsonb_build_array(pg_temp.put('docs/t3.md', 't3'))));
	s := pg_temp.listen();
	if s ->> 'state' <> 'done' or s ->> 'processedSeq' <> r ->> 'seq' or pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1') <> w then
		raise exception 'An invalid trigger holds nothing: %', s; end if;
	perform pg_temp.fx($q$update public.qorpera_cloud_routine_versions set triggers = jsonb_set(triggers, '{0,watch}', '"docs"')
		where routine_id = '88700000-0000-4000-8000-0000000000e1'$q$);
end $$;

-- 11. The run reads its wake: the closed payload the runtime parses, built under the run's rights --------------------------

-- A leased run of a file wake, as the materializer leaves it (P28), and the native rows its binding needs (as 647's).
create function pg_temp.file_run(p_wake uuid) returns jsonb language plpgsql as $$
declare w public.qorpera_wake_occurrences; v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
begin
	select * into strict w from public.qorpera_wake_occurrences where id = p_wake;
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, w.profile_id, w.environment_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn',
		'{}', w.requested_by_user_id, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, company_seq)
	values (v_run, w.profile_id, w.environment_id, 'wake', w.id, v_job, null, null,
		w.staff_agent_id, w.staff_version, w.sponsor_binding_id, w.sponsor_version, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
		w.requested_by_user_id, w.requested_by_user_id, 'openai', 'gpt-test', 'provider_default', 'company', extensions.gen_random_uuid(),
		repeat('b', 64), w.session_id, '{}', (w.payload ->> 'seq')::bigint);
	update public.qorpera_wake_occurrences set run_id = v_run, status = 'materialized' where id = w.id;
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;
create function pg_temp.native(p_actor jsonb) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_identity uuid := '88700000-0000-4000-8000-0000000000d1';
	v_lease uuid := extensions.gen_random_uuid(); v_sponsor public.qorpera_execution_sponsor_versions%rowtype; v_capsule uuid;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	select credential_capsule_id into strict v_capsule from public.qorpera_provider_connection_versions
	where connection_id = v_sponsor.provider_connection_id and version = v_sponsor.provider_connection_version;
	set local session_replication_role = replica;
	insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
	values (v_identity, v_run.profile_id, 'company', v_identity, 'Listener fixture') on conflict (id) do nothing;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values (v_capsule, v_run.profile_id, v_identity, 'company', 'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64),
		v_run.created_by_user_id) on conflict (id) do nothing;
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values ((p_actor ->> 'runnerId')::uuid, v_run.profile_id, (p_actor ->> 'runnerId')::uuid, 'Listener runner', '["agent_turn"]',
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
	-- Nora's first wake: the owner's write of docs/a.md.
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1') limit 1;
	a := pg_temp.file_run(w.id);
	e := public.qorpera_read_native_wake(pg_temp.native(a));
	if e -> 'source' ->> 'kind' <> 'company-file' or e -> 'source' ->> 'id' <> w.source_id::text
		or e ->> 'actorUserId' <> '70700000-0000-4000-8000-000000000001' or e ->> 'parentRunId' is not null
		or e -> 'causal' ->> 'rootId' <> w.source_id::text
		or (select array_agg(k order by k) from jsonb_object_keys(e -> 'payload') k) <> array['changes','commitId','more','schema','seq']
		or e -> 'payload' ->> 'schema' <> 'qorpera.folder-file-wake/v1' or e -> 'payload' ->> 'commitId' <> w.source_id::text
		or e -> 'payload' -> 'changes' <> jsonb_build_array(jsonb_build_object('path', 'docs/a.md', 'op', 'write',
			'version', w.payload -> 'versions' -> 0 #>> '{}'))
		or (e -> 'payload' ->> 'more')::integer <> 0 then
		raise exception 'The run''s wake: %', e; end if;
end $$;

-- 12. Erasure notes the runs of the file wakes about what it erases ---------------------------------------------------------

do $$
declare w public.qorpera_wake_occurrences; a jsonb; v_id uuid; v public.qorpera_folder_erasures%rowtype;
begin
	-- The wake of docs/b2.md's delete (2), run; then docs/b2.md is erased.
	select o.* into strict w from public.qorpera_wake_occurrences o where o.routine_id = '88700000-0000-4000-8000-0000000000e1'
		and o.source_kind = 'company-file' and exists (select 1 from public.qorpera_folder_path_versions pv
			where pv.commit_id = o.source_id and pv.path = 'docs/b2.md' and pv.op = 'delete');
	a := pg_temp.file_run(w.id);
	v_id := (public.qorpera_folder_erase('70700000-0000-4000-8000-000000000020', pg_temp.owner(), '["docs/b2.md"]', 'erase-b2')
		->> 'erasureId')::uuid;
	for i in 1 .. 60 loop
		select * into v from public.qorpera_folder_erasures where id = v_id;
		exit when v.state <> 'working';
		perform public.qorpera_folder_erasure_step(3, 3, 3);
	end loop;
	if not exists (select 1 from public.qorpera_folder_erasure_runs where erasure_id = v_id and run_id = (a ->> 'runId')::uuid) then
		raise exception 'The run of a file wake about an erased change is noted: %', to_jsonb(v); end if;
end $$;

rollback;
