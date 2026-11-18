-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.agent_text(p_id uuid, p_name text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Research\nkind: agent\nstatus: active\nfigure: acorn\n---\nFind out.\n', p_id, p_name)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Research','agentKind','agent','status','active',
		'colour',null,'figure','acorn','model',null,'effort',null,'instructions','Find out.')
$$;
create function pg_temp.todo_text(p_id uuid) returns text language sql as $$
	select format(E'---\nid: %s\ntitle: Start\nstatus: open\nrequested_by: %s\n---\nBegin.\n', p_id, '63400000-0000-4000-8000-000000000002')
$$;
create function pg_temp.todo_parse(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind','todo','id',p_id,'title','Start','status','open',
		'requestedBy','63400000-0000-4000-8000-000000000002','detail','Begin.')
$$;
create function pg_temp.id(p_kind text, p_n integer) returns uuid language sql immutable as $$
	select format('12960000-0000-4000-8000-%s%s', case p_kind when 'a' then 'a' else 'd' end, lpad(p_n::text, 11, '0'))::uuid
$$;
create function pg_temp.member(p_actor jsonb, p_handle text, p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(pg_temp.id('a', p_n), initcap(p_handle)), p_actor)),
			jsonb_build_object('path','memory','kind','folder'),
			jsonb_build_object('path','skills','kind','folder'),
			jsonb_build_object('path','routines','kind','folder'),
			jsonb_build_object('path','todos','kind','folder'),
			jsonb_build_object('path','todos/first-assignment.md','kind','file','file',pg_temp.stage(pg_temp.todo_text(pg_temp.id('d', p_n)), p_actor))),
		'structured', jsonb_build_array(
			pg_temp.entry('QorperaOS/agents/' || p_handle || '/agent.md', 'agent', pg_temp.agent_text(pg_temp.id('a', p_n), initcap(p_handle)),
				pg_temp.agent_parse(pg_temp.id('a', p_n), initcap(p_handle))),
			pg_temp.entry('QorperaOS/agents/' || p_handle || '/todos/first-assignment.md', 'todo', pg_temp.todo_text(pg_temp.id('d', p_n)),
				pg_temp.todo_parse(pg_temp.id('d', p_n)))))
$$;
create function pg_temp.team(p_actor jsonb, p_handles text[], p_first integer) returns jsonb language sql as $$
	select jsonb_agg(pg_temp.member(p_actor, h, p_first + n::integer - 1) order by n) from unnest(p_handles) with ordinality u(h, n)
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;
create function pg_temp.team_action(p_binding jsonb, p_call text, p_decision text default 'allow') returns uuid language sql as $$
	select (public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'hire_team',
		'effect', 'delegation', 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Hire a team of 3 agents', 'target', 'Market, Brand and Sales',
			'details', jsonb_build_object('Market', 'Research · first task: Begin.', 'Brand', 'Research · first task: Begin.',
				'Sales', 'Research · first task: Begin.')),
		'decision', p_decision, 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid
$$;

select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'hire-team-setup',
	'[{"op":"mkdir","path":"QorperaOS"},{"op":"mkdir","path":"QorperaOS/agents"}]'), 2, 'saved')
	\g /dev/null

do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
	v_commit uuid; n integer;
begin
	u := pg_temp.team(p, array['market', 'brand', 'sales'], 1);
	r := pg_temp.record(b, pg_temp.team_action(b, 'call-team-1'), u);
	if (r ->> 'units')::integer <> 3 then raise exception '1: one review stands for the whole team: %', r; end if;
	c := pg_temp.commit(p, 'run-hire-team-0001', u, (r ->> 'reviewId')::uuid);
	for n in 1..3 loop perform pg_temp.expect(c, n, 'saved'); end loop;
	v_commit := (c ->> 'commitId')::uuid;
	if (select review_id from public.qorpera_folder_commits where id = v_commit) is distinct from (r ->> 'reviewId')::uuid then
		raise exception '1: the team''s commit names its one review'; end if;
	for n in 1..3 loop
		if (pg_temp.staff(pg_temp.id('a', n))).employment_status is distinct from 'active'
			or (pg_temp.staff(pg_temp.id('a', n))).folder_commit_id is distinct from v_commit then
			raise exception '1: every hire of the team is indexed by the one commit: %', to_jsonb(pg_temp.staff(pg_temp.id('a', n))); end if;
		if not exists (select 1 from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
				and bound_staff_agent_id = pg_temp.id('a', n)) then
			raise exception '1: every hire of the team gets its thread'; end if;
		if not exists (select 1 from public.qorpera_agent_first_runs where staff_agent_id = pg_temp.id('a', n)) then
			raise exception '1: every hire of the team gets its first run'; end if;
		if (select count(*) from public.qorpera_profile_staff s where s.profile_id = '63400000-0000-4000-8000-000000000010'
				and s.employment_status = 'active' and s.staff_agent_id in (pg_temp.id('a', 1), pg_temp.id('a', 2), pg_temp.id('a', 3))
				and s.staff_agent_id <> pg_temp.id('a', n)) <> 2 then
			raise exception '1: each hire''s coworkers hold the two others'; end if;
	end loop;
end $$;

do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
begin
	u := pg_temp.team(p, array['support', 'market', 'finance'], 4);
	r := pg_temp.record(b, pg_temp.team_action(b, 'call-team-2'), u);
	c := pg_temp.commit(p, 'run-hire-team-0002', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	perform pg_temp.expect(c, 2, 'conflict', 'exists');
	perform pg_temp.expect(c, 3, 'saved');
	if (pg_temp.staff(pg_temp.id('a', 5))).staff_agent_id is not null
		or (pg_temp.staff(pg_temp.id('a', 4))).employment_status is distinct from 'active'
		or (pg_temp.staff(pg_temp.id('a', 6))).employment_status is distinct from 'active' then
		raise exception '2: a folder taken meanwhile is that hire''s conflict alone'; end if;
end $$;

do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb;
begin
	u := pg_temp.team(p, array['legal', 'people'], 7);
	perform pg_temp.expect(pg_temp.commit(p, 'run-hire-team-0003', u), 1, 'denied', 'review_required');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, pg_temp.team_action(b, 'call-team-3', 'deny'), u),
		'42501', 'This change has no approval in this run');
	if (pg_temp.staff(pg_temp.id('a', 7))).staff_agent_id is not null or pg_temp.present('QorperaOS/agents/legal') then
		raise exception '3: a team without its approval saves nothing'; end if;
end $$;

do $$
declare
	c_b constant uuid := '63400000-0000-4000-8000-0000000000a2'; c_owner constant uuid := '63400000-0000-4000-8000-000000000001';
	x jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2'); b jsonb := x -> 'binding'; p jsonb := x -> 'actor';
	u jsonb; r jsonb; v_action uuid; a public.qorpera_action_reviews%rowtype; y jsonb;
begin
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set expires_at = clock_timestamp() + interval %L where id = %L',
		'1 day', (pg_temp.agent_grant((pg_temp.root()).id, c_b)).id));
	v_action := pg_temp.team_action(b, 'call-team-restricted');
	select * into a from public.qorpera_action_reviews where id = v_action;
	if a.decision <> 'ask' or a.approver_scope <> 'owners_admins' or a.built_in <> 'access_change' or a.card_session_id is null
		or a.reason not like 'This agent''s own Company File access is limited%' then
		raise exception '4: a restricted hirer''s team asks the owners and admins on a card: %', to_jsonb(a); end if;
	if (select count(*) from public.qorpera_action_reviews where run_id = a.run_id and call_id = 'call-team-restricted') <> 1 then
		raise exception '4: the whole team is one card'; end if;
	u := pg_temp.team(p, array['ops', 'quality'], 9);
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', 'This change has no approval in this run');
	perform pg_temp.fx(format('update public.qorpera_action_reviews set decision = %L, approver_scope = null, approver_user_id = null, card_session_id = null where id = %L',
		'allow', v_action));
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', 'This hire needs a member''s approval%');
	v_action := pg_temp.team_action(b, 'call-team-restricted-2');
	perform pg_temp.fx(format('update public.qorpera_action_reviews set answer = %L, answered_by_user_id = %L, answered_at = clock_timestamp() where id = %L',
		'allow_once', c_owner, v_action));
	if public.qorpera_await_action_review(b, v_action, false) ->> 'state' <> 'approved' then raise exception '4: the holding call uses the answer'; end if;
	r := pg_temp.record(b, v_action, u);
	y := pg_temp.commit(p, 'run-hire-team-0004', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(y, 1, 'saved');
	perform pg_temp.expect(y, 2, 'saved');
	if (select approver_user_id from public.qorpera_folder_commits where id = (y ->> 'commitId')::uuid) is distinct from c_owner then
		raise exception '4: a restricted hirer''s team saves with its owner as approver'; end if;
end $$;

do $$
begin
	if strpos(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
			$q$'computer_transfer','hire_agent',/* 20260930799000 */'hire_team','create_group_chat',$q$) = 0 then
		raise exception '5: a run''s observations may name hire_team'; end if;
	if (select array_agg(proc.proname::text order by proc.proname::text collate "C")
			from pg_proc as proc join pg_namespace as namespace on namespace.oid = proc.pronamespace
			where namespace.nspname = 'public' and strpos(proc.prosrc, '20260930799000') > 0)
		is distinct from array['qorpera_folder_record_review', 'qorpera_record_action_review', 'qorpera_record_runtime_observation'] then
		raise exception '5: the marker is in exactly the three bodies'; end if;
end $$;

rollback;
