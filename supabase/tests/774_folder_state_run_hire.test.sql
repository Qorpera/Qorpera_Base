-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Company state files, thin writers W4a (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §5; RUNTIME-COMPANY-FOLDER-C2.md
-- §5): a run's hire, as hire_agent saves it. One new folder agents/<handle> with agent.md, the agent's folders and its
-- first assignment as a todo, staged by the run and saved with the review recorded for exactly that change set. The
-- commit indexes the agent (its roster row and thread) and the todo as the new agent's, asked for by the run's
-- requester. Without the review, or with a review of other units, nothing is saved. The agent rules still hold for a
-- reviewed hire. Contract 14.1: an agent that cannot delegate the default access hires only on an owner's or admin's
-- answer; the predicate case by case.
-- Runs are 647's hand-built runs, on 769's helpers.

-- A structured entry as the runtime sends it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.agent_text(p_id uuid, p_name text, p_kind text default 'agent') returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Bookkeeper\nkind: %s\nstatus: active\nfigure: acorn\n---\nKeep the books.\n',
		p_id, p_name, p_kind)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Bookkeeper','agentKind',p_kind,'status','active',
		'colour',null,'figure','acorn','model',null,'effort',null,'instructions','Keep the books.')
$$;
create function pg_temp.todo_text(p_id uuid) returns text language sql as $$
	select format(E'---\nid: %s\ntitle: Reconcile September\nstatus: open\nrequested_by: %s\n---\nMatch every bank line.\n',
		p_id, '63400000-0000-4000-8000-000000000002')
$$;
create function pg_temp.todo_parse(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind','todo','id',p_id,'title','Reconcile September','status','open',
		'requestedBy','63400000-0000-4000-8000-000000000002','detail','Match every bank line.')
$$;
-- The hire's one unit, staged by the actor that commits it (a version-2 file is held to possession).
create function pg_temp.hire(p_actor jsonb, p_handle text, p_agent uuid, p_todo uuid, p_name text default 'Vera',
	p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_agent, p_name, p_kind), p_actor)),
			jsonb_build_object('path','memory','kind','folder'),
			jsonb_build_object('path','skills','kind','folder'),
			jsonb_build_object('path','routines','kind','folder'),
			jsonb_build_object('path','todos','kind','folder'),
			jsonb_build_object('path','todos/first-assignment.md','kind','file','file',pg_temp.stage(pg_temp.todo_text(p_todo), p_actor))),
		'structured', jsonb_build_array(
			pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent', pg_temp.agent_text(p_agent, p_name, p_kind),
				pg_temp.agent_parse(p_agent, p_name, p_kind)),
			pg_temp.entry('agents/' || p_handle || '/todos/first-assignment.md', 'todo', pg_temp.todo_text(p_todo),
				pg_temp.todo_parse(p_todo)))))
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

-- The agents folder, as the seeded tree has it.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'run-hire-setup', '[{"op":"mkdir","path":"agents"}]'), 1, 'saved')
	\g /dev/null

-- 1. Unreviewed, or reviewed for other units: denied, and nothing is indexed.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb;
	c_agent constant uuid := '77400000-0000-4000-8000-0000000000a1'; c_todo constant uuid := '77400000-0000-4000-8000-0000000000d1';
begin
	u := pg_temp.hire(p, 'vera', c_agent, c_todo);
	perform pg_temp.expect(pg_temp.commit(p, 'run-hire-none', u), 1, 'denied', 'review_required');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-other'), pg_temp.hire(p, 'vera-other', c_agent, c_todo));
	perform pg_temp.expect(pg_temp.commit(p, 'run-hire-other', u, (r ->> 'reviewId')::uuid), 1, 'denied', 'review_required');
	if (pg_temp.staff(c_agent)).staff_agent_id is not null or pg_temp.present('agents/vera') then
		raise exception 'A hire without its review saves nothing'; end if;
end $$;

-- 2. Reviewed: saved and indexed. The roster row is the file's, its thread exists, and the first todo is the new
-- agent's own, asked for by the run's requester.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; c jsonb;
	s public.qorpera_profile_staff%rowtype;
	c_agent constant uuid := '77400000-0000-4000-8000-0000000000a2'; c_todo constant uuid := '77400000-0000-4000-8000-0000000000d2';
begin
	u := pg_temp.hire(p, 'vera', c_agent, c_todo);
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-1'), u);
	c := pg_temp.commit(p, 'run-hire-0001', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	if (select review_id from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid) is distinct from (r ->> 'reviewId')::uuid then
		raise exception 'The hire''s commit names its review'; end if;
	s := pg_temp.staff(c_agent);
	if s.display_name is distinct from 'Vera' or s.role is distinct from 'Bookkeeper' or s.charter is distinct from 'Keep the books.'
		or s.folder_path is distinct from 'agents/vera/agent.md' or s.employment_status is distinct from 'active' then
		raise exception 'The hire reaches the roster from its file: %', to_jsonb(s); end if;
	if not exists (select 1 from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
			and bound_staff_agent_id = c_agent) then
		raise exception 'A hire gets its thread'; end if;
	if not exists (select 1 from public.qorpera_runtime_agent_todos where id = c_todo and staff_agent_id = c_agent
			and requested_by_user_id = '63400000-0000-4000-8000-000000000002' and state = 'open') then
		raise exception 'The first assignment is the new agent''s open todo, asked for by the requester'; end if;
	if not (pg_temp.present('agents/vera/memory') and pg_temp.present('agents/vera/skills') and pg_temp.present('agents/vera/routines')
			and pg_temp.present('agents/vera/todos/first-assignment.md')) then
		raise exception 'The hire brings its folders'; end if;
	-- The folder is now taken: another hire of the same handle is a conflict.
	u := pg_temp.hire(p, 'vera', '77400000-0000-4000-8000-0000000000a3', '77400000-0000-4000-8000-0000000000d3', 'Vera Two');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-2'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'run-hire-0002', u, (r ->> 'reviewId')::uuid), 1, 'conflict', 'exists');
end $$;

-- 3. A review does not lift the agent rules: a run never hires a Co-Founder, and an id another agent holds is refused.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; u jsonb; r jsonb; v jsonb;
begin
	u := pg_temp.hire(p, 'chief', '77400000-0000-4000-8000-0000000000a4', '77400000-0000-4000-8000-0000000000d4', 'Chief', 'co-founder');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-3'), u);
	v := pg_temp.expect(pg_temp.commit(p, 'run-hire-0003', u, (r ->> 'reviewId')::uuid), 1, 'refused', 'structured_rule');
	u := pg_temp.hire(p, 'vera-again', '77400000-0000-4000-8000-0000000000a2', '77400000-0000-4000-8000-0000000000d5', 'Vera Again');
	r := pg_temp.record(b, pg_temp.action(b, 'call-hire-4'), u);
	v := pg_temp.expect(pg_temp.commit(p, 'run-hire-0004', u, (r ->> 'reviewId')::uuid), 1, 'refused', 'structured_rule');
	if pg_temp.present('agents/chief') or pg_temp.present('agents/vera-again') then raise exception 'A refused hire saves nothing'; end if;
end $$;

-- 4. The predicate, case by case (the legacy hire's, as a boolean): agent B holds the default grant; each change below
-- takes it away, and its undoing gives it back.
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	v_grant uuid := (pg_temp.agent_grant((pg_temp.root()).id, '63400000-0000-4000-8000-0000000000a2')).id;
	v_staff text := format('profile_id = %L and staff_agent_id = %L', '63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-0000000000a2');
	v_case text[];
	-- The root's columns a copy may set (not its id, environment or generated key).
	v_columns text := (select string_agg(quote_ident(column_name), ', ' order by ordinal_position) from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_company_path_resources' and is_generated = 'NEVER'
			and column_name not in ('id', 'environment_id'));
begin
	if not public.qorpera_folder_agent_delegates_default(c_profile, c_b) then raise exception 'The fixture agent delegates'; end if;
	foreach v_case slice 1 in array array[
		array[format('update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where id = %L', v_grant),
			format('update public.qorpera_company_path_grants set revoked_at = null where id = %L', v_grant)],
		array[format('update public.qorpera_company_path_grants set permissions = array[%L] where id = %L', 'read', v_grant),
			format('update public.qorpera_company_path_grants set permissions = array[%L, %L] where id = %L', 'read', 'write', v_grant)],
		array[format('update public.qorpera_company_path_grants set expires_at = clock_timestamp() + interval %L where id = %L', '1 day', v_grant),
			format('update public.qorpera_company_path_grants set expires_at = null where id = %L', v_grant)],
		-- A grant for another version of the root.
		array[format('update public.qorpera_company_path_grants set resource_version = %L where id = %L', extensions.gen_random_uuid(), v_grant),
			format('update public.qorpera_company_path_grants set resource_version = %L where id = %L',
				(select resource_version from public.qorpera_company_path_grants where id = v_grant), v_grant)],
		array[format('update public.qorpera_company_path_grants set principal_id = %L where id = %L', '63400000-0000-4000-8000-0000000000a1', v_grant),
			format('update public.qorpera_company_path_grants set principal_id = %L where id = %L', c_b, v_grant)],
		array[format('update public.qorpera_profile_staff set employment_status = %L where %s', 'archived', v_staff),
			format('update public.qorpera_profile_staff set employment_status = %L where %s', 'active', v_staff)],
		-- A second environment's live shared root without B's grant; revoked, it no longer counts.
		array[format('insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) '
				|| 'values (%L, %L, %L, 1, %L); insert into public.qorpera_company_path_resources(id, environment_id, %s) '
				|| 'select %L, %L, %s from public.qorpera_company_path_resources where id = %L',
				'77400000-0000-4000-8000-000000000021', c_profile, 'Second', '63400000-0000-4000-8000-000000000001', v_columns,
				'77400000-0000-4000-8000-000000000031', '77400000-0000-4000-8000-000000000021', v_columns, (pg_temp.root()).id),
			format('update public.qorpera_company_path_resources set revoked_at = clock_timestamp() where id = %L',
				'77400000-0000-4000-8000-000000000031')]] loop
		perform pg_temp.fx(v_case[1]);
		if public.qorpera_folder_agent_delegates_default(c_profile, c_b) then raise exception 'Delegates after: %', v_case[1]; end if;
		perform pg_temp.fx(v_case[2]);
		if not public.qorpera_folder_agent_delegates_default(c_profile, c_b) then raise exception 'Does not delegate after: %', v_case[2]; end if;
	end loop;
	-- Only the shared roots count: a narrower shared resource without B's grant does not.
	perform pg_temp.fx(format('insert into public.qorpera_company_path_resources(id, environment_id, %s) select %L, environment_id, %s '
		|| 'from public.qorpera_company_path_resources where id = %L', v_columns, '77400000-0000-4000-8000-000000000032',
		replace(v_columns, 'path,', quote_literal('teams') || ','), (pg_temp.root()).id));
	if not public.qorpera_folder_agent_delegates_default(c_profile, c_b) then raise exception 'Only the shared roots count'; end if;
end $$;

-- 5. Contract 14.1: an agent that cannot delegate the new agent's default access (here a finite grant on the shared
-- root) does not hire on its own. The layering asks the owners and admins on a card whatever the reviewer found, with
-- no Always allow and its own reason, also when a denied hire is retried; the recorder refuses that agent's own allow
-- and a member's answer given before the restriction, and records an owner's answer. Other agents' hires and this
-- agent's other delegations are unchanged.
do $$
declare
	c_b constant uuid := '63400000-0000-4000-8000-0000000000a2'; c_owner constant uuid := '63400000-0000-4000-8000-000000000001';
	x jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2'); b jsonb := x -> 'binding'; p jsonb := x -> 'actor';
	u jsonb; r jsonb; v_action uuid; v_chat uuid; v_early uuid; a public.qorpera_action_reviews%rowtype; y jsonb;
begin
	-- Before the restriction: a card on the reviewer's own doubt, answered by the member and used by the run.
	v_early := pg_temp.action(b, 'call-early', 'ask');
	if (select approver_scope from public.qorpera_action_reviews where id = v_early) <> 'member' then
		raise exception 'An unrestricted hire''s doubt is the member''s card'; end if;
	perform pg_temp.answer(v_early);
	perform public.qorpera_await_action_review(b, v_early, false);
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set expires_at = clock_timestamp() + interval %L where id = %L',
		'1 day', (pg_temp.agent_grant((pg_temp.root()).id, c_b)).id));
	-- That answer no longer carries the hire.
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_early,
		pg_temp.hire(p, 'vera-early', '77400000-0000-4000-8000-0000000000a7', '77400000-0000-4000-8000-0000000000d7', 'Vera E')),
		'42501', 'This hire needs a member''s approval%');
	-- The reviewer allowed it (and even proposed a rule); the kernel asks the owners and admins, with no Always allow.
	v_action := (public.qorpera_record_action_review(b, jsonb_build_object('callId', 'call-restricted-1', 'tool', 'hire_agent',
		'effect', 'delegation', 'argumentSha256', md5('call-restricted-1') || md5('call-restricted-1'),
		'action', jsonb_build_object('title', 'Hire an agent', 'target', 'vera', 'details', '{}'::jsonb), 'decision', 'allow',
		'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fine.', 'proposedRule', 'Always let agents hire',
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
	select * into a from public.qorpera_action_reviews where id = v_action;
	if a.decision <> 'ask' or a.approver_scope <> 'owners_admins' or a.built_in <> 'access_change' or a.proposed_rule is not null
		or a.card_session_id is null or a.reason not like 'This agent''s own Company File access is limited%' then
		raise exception 'A restricted hire asks the owners and admins on a card: %', to_jsonb(a); end if;
	-- A deny stays a deny; a denied hire tried again asks the owners and admins too, never the member alone.
	if (public.qorpera_record_action_review(b, jsonb_build_object('callId', 'call-retry-1', 'tool', 'hire_agent',
			'effect', 'delegation', 'argumentSha256', md5('call-retry') || md5('call-retry'), 'action', '{}'::jsonb,
			'decision', 'deny', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'No.', 'proposedRule', null,
			'reviewerModel', 'gpt-6-luna')) ->> 'decision') <> 'deny' then
		raise exception 'A restricted hire''s deny stays a deny'; end if;
	y := public.qorpera_record_action_review(b, jsonb_build_object('callId', 'call-retry-2', 'tool', 'hire_agent',
		'effect', 'delegation', 'argumentSha256', md5('call-retry') || md5('call-retry'), 'action', '{}'::jsonb,
		'decision', 'deny', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Still no.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna'));
	if y ->> 'decision' <> 'ask' or y ->> 'approverScope' <> 'owners_admins' or y ->> 'reason' not like '% The review: Still no.' then
		raise exception 'A retried restricted hire asks the owners and admins, with the reviewer''s reason: %', y; end if;
	-- The reviewer's finding that it was not asked for stays the built-in check.
	if (public.qorpera_record_action_review(b, jsonb_build_object('callId', 'call-unasked', 'tool', 'hire_agent',
			'effect', 'delegation', 'argumentSha256', md5('call-unasked') || md5('call-unasked'), 'action', '{}'::jsonb,
			'decision', 'ask', 'ruleIds', '[]'::jsonb, 'builtIn', 'not_requested', 'reason', 'Nobody asked for a hire.',
			'proposedRule', null, 'reviewerModel', 'gpt-6-luna')) ->> 'builtIn') <> 'not_requested' then
		raise exception 'A restricted hire keeps a not-asked-for finding'; end if;
	v_chat := pg_temp.action(b, 'call-restricted-chat', 'allow', 'delegation', 'create_group_chat');
	if (select decision from public.qorpera_action_reviews where id = v_chat) <> 'allow' then
		raise exception 'Only a restricted agent''s hire asks'; end if;
	-- And the recorder takes that agent's own allow for anything but a hire.
	perform pg_temp.record(b, v_chat, jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'rr-restricted-chat')));
	u := pg_temp.hire(p, 'vera-restricted', '77400000-0000-4000-8000-0000000000a6', '77400000-0000-4000-8000-0000000000d6', 'Vera R');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', 'This change has no approval in this run');
	-- Its own allow (written as if the layering had let it through) is refused by the recorder, checked again.
	perform pg_temp.fx(format('update public.qorpera_action_reviews set decision = %L, approver_scope = null, approver_user_id = null, card_session_id = null where id = %L',
		'allow', v_action));
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', 'This hire needs a member''s approval%');
	-- An owner's answer, used by the run: recorded with the owner, and the hire saves with them as its approver.
	v_action := (public.qorpera_record_action_review(b, jsonb_build_object('callId', 'call-restricted-3', 'tool', 'hire_agent',
		'effect', 'delegation', 'argumentSha256', md5('call-restricted-3') || md5('call-restricted-3'), 'action', '{}'::jsonb,
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fine.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
	perform pg_temp.fx(format('update public.qorpera_action_reviews set answer = %L, answered_by_user_id = %L, answered_at = clock_timestamp() where id = %L',
		'allow_once', c_owner, v_action));
	if public.qorpera_await_action_review(b, v_action, false) ->> 'state' <> 'approved' then raise exception 'The holding call uses the answer'; end if;
	r := pg_temp.record(b, v_action, u);
	y := pg_temp.commit(p, 'run-hire-0006', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(y, 1, 'saved');
	if (select approver_user_id from public.qorpera_folder_commits where id = (y ->> 'commitId')::uuid) is distinct from c_owner then
		raise exception 'A restricted hire saves with its owner as approver'; end if;
	-- Agent A, unrestricted, keeps the reviewer's allow for a hire.
	x := pg_temp.agent_run();
	v_action := pg_temp.action(x -> 'binding', 'call-unrestricted');
	if (select decision from public.qorpera_action_reviews where id = v_action) <> 'allow' then
		raise exception 'An unrestricted agent''s hire keeps the allow'; end if;
end $$;

rollback;
