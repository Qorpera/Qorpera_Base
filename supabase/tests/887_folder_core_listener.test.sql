-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine: its row, its version and its position"
-- Company folder core, P29a (migration 20260930020000; deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md): file-change
-- wakes on the folder journal. A routine file with `when: file-change` is a listener from the change set that saved it;
-- the drain wakes it once per change set that touches its watch (exact or subtree, moves from and into it, a copy at its
-- target), never for its own agent's change, never naming a path its run may not read, at most 21 versions with `more`;
-- a paused company writes no wake and moves on; a known refusal (an expired routine, one at its limit, an archived agent)
-- is passed over without stopping the others; the H2c hook sees every change set in order, and a failed call is recorded
-- and called again, after a wait that doubles, until it succeeds. On 708's company (Nora and Otto); rolled back at the end. Races are 888's.

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
create temp table hook_calls (commit_id uuid, seq bigint, paused boolean, actor jsonb);

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

-- 2. Matching: exact and subtree, siblings, moves from and into the watch, a copy at its target ------------------------------

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
end $$;

-- 3. Read rights: a path the run may not read is never named nor counted ----------------------------------------------------

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
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '5', 'no wake for unreadable paths alone');
	perform pg_temp.saved(pg_temp.commit('{"kind":"platform"}', 'listen-0011', jsonb_build_array(
		pg_temp.put('docs/private/t.md', 'hidden too'), pg_temp.put('docs/pub.md', 'public'))));
	perform pg_temp.listen();
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1') offset 5 limit 1;
	if w.payload -> 'versions' <> jsonb_build_array(pg_temp.version('docs/pub.md')) or (w.payload ->> 'more')::integer <> 0 then
		raise exception 'Only the readable path, and the unreadable one not counted: %', w.payload; end if;
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
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '6', 'Nora''s own change never wakes Nora');
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e2') offset 1 limit 1;
	if w.source_id::text <> r ->> 'commitId' or w.parent_run_id::text <> a ->> 'runId'
		or w.causal_agent_ids <> array['70700000-0000-4000-8000-0000000000a1','70700000-0000-4000-8000-0000000000a2']::uuid[]
		or not public.qorpera_wake_authorized(w) then
		raise exception 'Otto''s wake carries Nora''s chain: %', to_jsonb(w); end if;
end $$;

-- 5. Bounds: 21 versions, the rest counted in more --------------------------------------------------------------------------

do $$
declare w public.qorpera_wake_occurrences;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0013', (select jsonb_agg(pg_temp.put('docs/m' || lpad(i::text, 2, '0') || '.md',
		'many ' || i)) from generate_series(1, 25) i)));
	perform pg_temp.listen();
	select * into w from pg_temp.fw('88700000-0000-4000-8000-0000000000e1') offset 6 limit 1;
	if jsonb_array_length(w.payload -> 'versions') <> 21 or (w.payload ->> 'more')::integer <> 4 then
		raise exception '21 versions and more: %', w.payload; end if;
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
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '8', 'Nora''s still wakes');
	-- Otto archived, his routine not followed yet (still active): passed over.
	update public.qorpera_cloud_routines set max_occurrences = null where id = '88700000-0000-4000-8000-0000000000e2';
	update public.qorpera_profile_staff set employment_status = 'archived'
	where profile_id = '70700000-0000-4000-8000-000000000010' and staff_agent_id = '70700000-0000-4000-8000-0000000000a2';
	perform pg_temp.is((pg_temp.rt('88700000-0000-4000-8000-0000000000e2')).status, 'active', 'the routine not followed yet');
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'listen-0014b', jsonb_build_array(pg_temp.put('docs/a.md', 'alpha archived'))));
	r := pg_temp.listen();
	perform pg_temp.is(r ->> 'inactive', '1', 'an archived agent''s routine is set aside');
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e2')::text, '2', 'and wakes nothing');
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '9', 'Nora''s still wakes');
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
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '9', 'writes no wake');
	delete from public.qorpera_company_execution_pauses where profile_id = '70700000-0000-4000-8000-000000000010';
	perform pg_temp.is(pg_temp.listen() ->> 'state', 'idle', 'and does not replay it after the resume');
end $$;

-- 7. The H2c hook: every change set in order; a failed call is recorded and called again until it succeeds ----------------

create or replace function public.qorpera_folder_listener_commit(p_environment_id uuid, p_commit jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
	insert into pg_temp.hook_calls values ((p_commit ->> 'commitId')::uuid, (p_commit ->> 'seq')::bigint,
		(p_commit ->> 'paused')::boolean, p_commit -> 'actor');
	if (p_commit ->> 'seq') = current_setting('qorpera_test.hook_fails', true) then
		raise exception 'H2c is down' using errcode = 'P0887'; end if;
end $$;

do $$
declare r1 jsonb; r2 jsonb; r jsonb;
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
		'public.qorpera_folder_listener_retry_at(integer,timestamptz)']::regprocedure[] loop
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

rollback;
