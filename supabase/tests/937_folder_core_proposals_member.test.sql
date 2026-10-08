-- @fixture 926_folder_core_proposals.test.sql until "-- 1. A view parks"
-- Company folder core, P40c (20260930102000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8): a member's open
-- proposals on the web. The caller lists their own open proposals of one agent, as the run's list gives them (a page of
-- 4 and its cursor; a structured file names only what a card shows), and discards one as their own actor; owners and
-- admins discard too. A proposal whose paths the member may not read now is neither listed nor counted. A company being
-- deleted answers neither; a paused one answers both.
--
-- The fixture (634, 769, 926's helpers): owner 1, contributors 2 and 4, viewer 3, admin 5; agents A (a1) and B (a2).

create function pg_temp.as_member(p_n integer) returns void language sql as $$
	select pg_temp.path_claims('authenticated', ('63400000-0000-4000-8000-00000000000' || p_n)::uuid)
$$;
create function pg_temp.mlist(p_staff uuid default '63400000-0000-4000-8000-0000000000a1', p_request jsonb default '{}')
returns jsonb language sql as $$
	select public.qorpera_member_folder_agent_proposals('63400000-0000-4000-8000-000000000020', p_staff, p_request)
$$;
create function pg_temp.mdiscard(p_proposal uuid) returns jsonb language sql as $$
	select public.qorpera_member_folder_discard_proposal('63400000-0000-4000-8000-000000000020', p_proposal)
$$;
-- A proposal parked below, by its name.
create function pg_temp.pid(p_name text) returns uuid language sql as $$
	select current_setting('qorpera_test.' || p_name)::uuid
$$;
-- The listed proposals, by their names.
create function pg_temp.listed(p_answer jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_agg(coalesce((select to_jsonb(n.name) from unnest(array['p1','p2','p3','p4','p5','q4','pc']) n(name)
		where current_setting('qorpera_test.' || n.name, true) = e.value ->> 'proposalId'), '"?"'::jsonb) order by e.ordinality), '[]')
	from jsonb_array_elements(p_answer -> 'proposals') with ordinality e
$$;
create function pg_temp.discarded(p_proposal uuid, p_by integer) returns void language plpgsql as $$
declare p public.qorpera_folder_proposals := pg_temp.proposal(p_proposal);
begin
	if p.status <> 'discarded' or p.decided_by <> 'member' or p.units <> '[]'::jsonb
		or p.decided_by_user_id is distinct from ('63400000-0000-4000-8000-00000000000' || p_by)::uuid
		or exists (select 1 from public.qorpera_folder_proposal_paths q where q.proposal_id = p.id) then
		raise exception 'The discarded proposal: %', to_jsonb(p); end if;
end $$;

-- Who may call them: authenticated only, each with its body marker. The core's discard stays the service's.
do $$
declare v_fn text; c_core constant text := 'public.qorpera_folder_member_discard_proposal(uuid,jsonb,uuid)';
begin
	foreach v_fn in array array['public.qorpera_member_folder_agent_proposals(uuid,uuid,jsonb)',
			'public.qorpera_member_folder_discard_proposal(uuid,uuid)'] loop
		if not has_function_privilege('authenticated', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('service_role', v_fn, 'execute') then
			raise exception '% has the wrong grants', v_fn; end if;
		if strpos(pg_get_functiondef(v_fn::regprocedure), 'P40c (20260930102000)') = 0 then
			raise exception '% has no body marker', v_fn; end if;
	end loop;
	if has_function_privilege('authenticated', c_core, 'execute') or has_function_privilege('anon', c_core, 'execute')
		or not has_function_privilege('service_role', c_core, 'execute')
		or strpos(pg_get_functiondef(c_core::regprocedure), '20260930102000 (P40c)') = 0 then
		raise exception 'The core''s discard has the wrong grants or no marker'; end if;
end $$;

-- 1. Agent A's run for member 2 parks five proposals through its box (the third, a hire); its run for member 4 parks
-- one. (Each run is made in a statement of its own.)
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); y jsonb; c jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p40c-agents-folder', '[{"op":"mkdir","path":"agents"}]'), 1, 'saved');
	perform set_config('qorpera_test.p1', (pg_temp.parked(pg_temp.vcommit(b, 'p40c-park-1',
		jsonb_build_array(pg_temp.deletes('rr1.txt'))))).id::text, true);
	perform set_config('qorpera_test.p2', (pg_temp.parked(pg_temp.vcommit(b, 'p40c-park-2',
		jsonb_build_array(pg_temp.deletes('rr2.txt'))))).id::text, true);
	perform set_config('qorpera_test.p3', (pg_temp.parked(pg_temp.vcommit(b, 'p40c-park-hire',
		jsonb_build_array(pg_temp.hire(b, 'nora', '63400000-0000-4000-8000-00000000f0c0', 'Nora'))))).id::text, true);
	perform set_config('qorpera_test.p4', (pg_temp.parked(pg_temp.vcommit(b, 'p40c-park-4',
		jsonb_build_array(pg_temp.deletes('rr3.txt'))))).id::text, true);
	perform set_config('qorpera_test.p5', (pg_temp.parked(pg_temp.vcommit(b, 'p40c-park-5',
		jsonb_build_array(pg_temp.deletes('rr4.txt'))))).id::text, true);
	y := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000004');
	c := pg_temp.vcommit(pg_temp.box(y -> 'actor'), 'p40c-park-member-4', jsonb_build_array(pg_temp.deletes('rr5.txt')));
	perform set_config('qorpera_test.q4', (pg_temp.parked(c)).id::text, true);
	if (select count(*) from public.qorpera_folder_proposals where status = 'open') <> 6
		or (pg_temp.proposal(pg_temp.pid('q4'))).member_user_id <> '63400000-0000-4000-8000-000000000004' then
		raise exception 'The parked proposals: %', (select jsonb_agg(to_jsonb(q)) from public.qorpera_folder_proposals q); end if;
end $$;

-- 2. Member 2's list: agent A's, oldest first, a page of 4 and its cursor; each unit as the run's list names it, and a
-- structured file's parse only by its name, title, role and status. Nothing of agent B's.
select pg_temp.as_member(2);
do $$
declare l jsonb := pg_temp.mlist(); m jsonb;
begin
	perform pg_temp.same(l - 'proposals', jsonb_build_object('schema', 'qorpera.member-folder-proposals/v1', 'moreProposals', 1,
		'nextCursor', pg_temp.pid('p4')), 'The first page');
	perform pg_temp.same(pg_temp.listed(l), '["p1","p2","p3","p4"]', 'The first page''s proposals');
	perform pg_temp.same((l -> 'proposals' -> 0) - 'createdAt', jsonb_build_object('proposalId', pg_temp.pid('p1'), 'viewKind', 'run_box',
		'createsAgent', false, 'unitCount', 1, 'units', '[{"unit":1,"op":"delete","path":"rr1.txt"}]'::jsonb, 'moreUnits', 0),
		'A listed delete');
	if (l -> 'proposals' -> 0 ->> 'createdAt')::timestamptz is distinct from (pg_temp.proposal(pg_temp.pid('p1'))).created_at then
		raise exception 'Its time: %', l -> 'proposals' -> 0; end if;
	perform pg_temp.same((l -> 'proposals' -> 2) - 'createdAt' - 'proposalId', '{"viewKind":"run_box","createsAgent":true,"unitCount":1,
		"units":[{"unit":1,"op":"new_folder","path":"agents/nora","structured":[{"path":"agents/nora/agent.md","kind":"agent",
		"parse":{"name":"Nora","role":"Sales","status":"active"}}]}],"moreUnits":0}', 'A listed hire');
	m := pg_temp.mlist(p_request => jsonb_build_object('cursor', pg_temp.pid('p4')));
	perform pg_temp.same(pg_temp.listed(m), '["p5"]', 'The page after the cursor');
	perform pg_temp.same(m - 'proposals' - 'schema', '{"moreProposals":0,"nextCursor":null}', 'The last page');
	perform pg_temp.same(pg_temp.mlist('63400000-0000-4000-8000-0000000000a2'),
		'{"schema":"qorpera.member-folder-proposals/v1","proposals":[],"moreProposals":0,"nextCursor":null}', 'Agent B''s');
	-- A bad request, no agent, and a cursor that is not one of the caller's proposals of the agent are refused.
	perform pg_temp.raises($s$select pg_temp.mlist(p_request => '{"todoKey":"x"}')$s$, '22023');
	perform pg_temp.raises($s$select pg_temp.mlist(p_request => '{"cursor":"p1"}')$s$, '22023');
	perform pg_temp.raises($s$select pg_temp.mlist(p_request => '[]')$s$, '22023');
	perform pg_temp.raises($s$select pg_temp.mlist(null)$s$, '22023');
	perform pg_temp.raises(format('select pg_temp.mlist(p_request => %L)', jsonb_build_object('cursor', extensions.gen_random_uuid())), 'P0002');
	perform pg_temp.raises(format('select pg_temp.mlist(p_request => %L)', jsonb_build_object('cursor', pg_temp.pid('q4'))), 'P0002');
	perform pg_temp.raises(format('select pg_temp.mlist(%L, %L)', '63400000-0000-4000-8000-0000000000a2',
		jsonb_build_object('cursor', pg_temp.pid('p1'))), 'P0002');
end $$;

-- Member 4 lists their own; the viewer, an owner and an admin list none (none waits for them); a non-member and anon are
-- refused.
select pg_temp.as_member(4);
do $$ begin
	perform pg_temp.same(pg_temp.listed(pg_temp.mlist()), '["q4"]', 'Member 4''s');
end $$;
do $$
declare n integer;
begin
	foreach n in array array[1, 3, 5] loop
		perform pg_temp.as_member(n);
		perform pg_temp.same(pg_temp.mlist() -> 'proposals', '[]', format('Member %s''s', n));
	end loop;
end $$;
select pg_temp.as_member(9);
do $$ begin
	perform pg_temp.raises('select pg_temp.mlist()', '42501');
end $$;
select pg_temp.path_claims('anon');
do $$ begin
	perform pg_temp.raises('select pg_temp.mlist()', '42501');
end $$;

-- 3. Read authority is decided at each list: a proposal naming a path the member may no longer read (a private folder
-- of the owner's here) is neither listed nor counted; once they may again, it is.
savepoint p40c_unreadable;
select pg_temp.path_claims('service_role');
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor');
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p40c-private-setup', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','p40c'),
		jsonb_build_object('op','write','path','p40c/a.txt','file',pg_temp.stage('p40c a')))), 2, 'saved');
	perform set_config('qorpera_test.pc', (pg_temp.parked(pg_temp.vcommit(b, 'p40c-park-private',
		jsonb_build_array(pg_temp.deletes('p40c/a.txt'))))).id::text, true);
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
		created_by_user_id)
	values ('63400000-0000-4000-8000-000000000020', 'p40c', 'subtree', 'member_private', '63400000-0000-4000-8000-000000000001',
		'normal', '63400000-0000-4000-8000-000000000001');
end $$;
select pg_temp.as_member(2);
do $$
declare l jsonb := pg_temp.mlist();
begin
	perform pg_temp.same(pg_temp.listed(l), '["p1","p2","p3","p4"]', 'The first page, without the unreadable proposal');
	perform pg_temp.same(l -> 'moreProposals', '1', 'The unreadable proposal is not counted');
	perform pg_temp.same(pg_temp.listed(pg_temp.mlist(p_request => jsonb_build_object('cursor', pg_temp.pid('p4')))), '["p5"]',
		'Nor listed after the cursor');
end $$;
select pg_temp.path_claims('service_role');
select pg_temp.fx($s$delete from public.qorpera_company_path_resources
	where environment_id = '63400000-0000-4000-8000-000000000020' and path = 'p40c'$s$);
select pg_temp.as_member(2);
do $$
declare l jsonb := pg_temp.mlist();
begin
	perform pg_temp.same(l -> 'moreProposals', '2', 'Readable again, it is counted');
	perform pg_temp.same(pg_temp.listed(pg_temp.mlist(p_request => jsonb_build_object('cursor', pg_temp.pid('p4')))), '["p5","pc"]',
		'And listed');
end $$;
rollback to savepoint p40c_unreadable;

-- 4. The discard: the member it waits for, an owner or an admin; another member, the viewer and a non-member are refused.
-- A decided proposal answers as it stands.
do $$
declare n integer;
begin
	foreach n in array array[3, 4, 9] loop
		perform pg_temp.as_member(n);
		perform pg_temp.raises(format('select pg_temp.mdiscard(%L)', pg_temp.pid('p1')), '42501');
	end loop;
	perform pg_temp.path_claims('anon');
	perform pg_temp.raises(format('select pg_temp.mdiscard(%L)', pg_temp.pid('p1')), '42501');
	-- The core's discard, reached directly, takes only the caller's own actor.
	perform pg_temp.as_member(2);
	perform pg_temp.raises(format('select pg_temp.discard(4, %L)', pg_temp.pid('p1')), '42501');
	if (pg_temp.proposal(pg_temp.pid('p1'))).status <> 'open' then raise exception 'A refused discard changed the proposal'; end if;
end $$;
select pg_temp.as_member(2);
do $$
declare r jsonb := pg_temp.mdiscard(pg_temp.pid('p1'));
begin
	perform pg_temp.same(r, jsonb_build_object('schema', 'qorpera.folder-proposal/v1', 'proposalId', pg_temp.pid('p1'),
		'status', 'discarded'), 'Member 2''s discard');
	perform pg_temp.discarded(pg_temp.pid('p1'), 2);
	perform pg_temp.same(pg_temp.mdiscard(pg_temp.pid('p1')), r, 'Again, as it stands');
	perform pg_temp.raises(format('select pg_temp.mdiscard(%L)', extensions.gen_random_uuid()), 'P0002');
	perform pg_temp.raises('select pg_temp.mdiscard(null)', '22023');
end $$;
select pg_temp.as_member(5);
do $$ begin
	perform pg_temp.same(pg_temp.mdiscard(pg_temp.pid('p2')) -> 'status', '"discarded"', 'The admin''s discard');
	perform pg_temp.discarded(pg_temp.pid('p2'), 5);
end $$;
select pg_temp.as_member(1);
do $$ begin
	perform pg_temp.same(pg_temp.mdiscard(pg_temp.pid('q4')) -> 'status', '"discarded"', 'The owner''s discard');
	perform pg_temp.discarded(pg_temp.pid('q4'), 1);
end $$;
select pg_temp.as_member(2);
do $$
declare l jsonb := pg_temp.mlist();
begin
	perform pg_temp.same(pg_temp.listed(l), '["p3","p4","p5"]', 'Discarded proposals are not listed');
	perform pg_temp.same(l - 'proposals' - 'schema', '{"moreProposals":0,"nextCursor":null}', 'One page');
	-- A cursor discarded since its page still pages on, as the run's list does.
	perform pg_temp.same(pg_temp.listed(pg_temp.mlist(p_request => jsonb_build_object('cursor', pg_temp.pid('p2')))),
		'["p3","p4","p5"]', 'After a discarded cursor');
end $$;

-- 5. A company being deleted answers neither; a paused one answers both (a discard writes nothing to the folder).
savepoint p40c_deleting;
select pg_temp.path_claims('service_role');
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001');
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.raises('select pg_temp.mlist()', '55000');
	perform pg_temp.raises(format('select pg_temp.mdiscard(%L)', pg_temp.pid('p3')), '55000');
end $$;
rollback to savepoint p40c_deleting;
savepoint p40c_paused;
select pg_temp.path_claims('service_role');
select public.qorpera_folder_pause('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001',
	'member proposals test') \g /dev/null
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(pg_temp.listed(pg_temp.mlist()), '["p3","p4","p5"]', 'The list while paused');
	perform pg_temp.same(pg_temp.mdiscard(pg_temp.pid('p3')) -> 'status', '"discarded"', 'A discard while paused');
end $$;
rollback to savepoint p40c_paused;
select pg_temp.path_claims('service_role');

rollback;
