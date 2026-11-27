-- @fixture 926_folder_core_proposals.test.sql until "-- 1. A view parks"

create function pg_temp.qaf_assert(p_ok boolean, p_msg text)
returns void language plpgsql as $$
begin
	if not coalesce(p_ok, false) then
		raise exception 'quiet_approvals_and_file_ops: %', p_msg;
	end if;
end $$;

create function pg_temp.qaf_del_dir(p_path text)
returns jsonb language sql as $$
	select jsonb_build_object(
		'op', 'delete',
		'path', p_path,
		'expectedVersion', pg_temp.read(p_path) -> 'entry' ->> 'version',
		'asOfSeq', (select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020')
	)
$$;

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_owner constant uuid := '63400000-0000-4000-8000-000000000001';
	c_agent constant uuid := '63400000-0000-4000-8000-0000000000a1';
	v_m jsonb := pg_temp.member(1);
	x jsonb := pg_temp.agent_run(c_agent, c_owner);
	p jsonb := x -> 'actor';
	b jsonb := x -> 'binding';
	v_box jsonb := pg_temp.box(p);
	r jsonb;
	u jsonb;
	v_rev jsonb;
	v_path text;
	v_nora constant uuid := '14030000-0000-4000-8000-0000000000a1';
	v_grp constant uuid := '14030000-0000-4000-8000-0000000000b1';
	v_worker_run jsonb;
	v_worker_binding jsonb;
	v_ask jsonb;
	v_thread uuid;
begin
	perform pg_temp.expect(pg_temp.commit(v_m, 'qaf-seed', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'docs'),
		jsonb_build_object('op', 'write', 'path', 'docs/a.md', 'file', pg_temp.stage('alpha', v_m)),
		jsonb_build_object('op', 'write', 'path', 'docs/b.md', 'file', pg_temp.stage('beta', v_m)),
		jsonb_build_object('op', 'write', 'path', 'docs/c.md', 'file', pg_temp.stage('gamma', v_m)),
		jsonb_build_object('op', 'write', 'path', 'docs/d.md', 'file', pg_temp.stage('delta', v_m)),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS'),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/surfaces'),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/surfaces/demo'),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/surfaces/demo/note.md', 'file', pg_temp.stage('surface note', v_m)),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/skills'),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/skills/demo.md', 'file', pg_temp.stage('skill', v_m)),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents'),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups/old-grp'),
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/old-agent')
	)), 15, 'saved');

	r := pg_temp.commit(p, 'qaf-run-plain-ops', jsonb_build_array(
		pg_temp.deletes('docs/a.md'),
		jsonb_build_object('op', 'move', 'from', 'docs/b.md', 'to', 'docs/b-moved.md',
			'expectedVersion', pg_temp.read('docs/b.md') -> 'entry' ->> 'version'),
		pg_temp.deletes('QorperaOS/surfaces/demo/note.md'),
		pg_temp.deletes('QorperaOS/skills/demo.md')
	));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'saved');
	perform pg_temp.expect(r, 4, 'saved');
	perform pg_temp.qaf_assert(
		not pg_temp.present('docs/a.md')
		and not pg_temp.present('docs/b.md')
		and pg_temp.present('docs/b-moved.md')
		and not pg_temp.present('QorperaOS/surfaces/demo/note.md')
		and not pg_temp.present('QorperaOS/skills/demo.md'),
		'run commits plain deletes, moves, and QorperaOS work file deletes without review'
	);

	r := pg_temp.vcommit(v_box, 'qaf-view-plain-ops', jsonb_build_array(
		pg_temp.deletes('docs/c.md'),
		jsonb_build_object('op', 'move', 'from', 'docs/d.md', 'to', 'docs/d-moved.md',
			'expectedVersion', pg_temp.read('docs/d.md') -> 'entry' ->> 'version')
	));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.qaf_assert(
		(pg_temp.parked(r)).id is null
		and not pg_temp.present('docs/c.md')
		and pg_temp.present('docs/d-moved.md'),
		'view commits plain deletes and moves directly without parking proposals'
	);

	foreach v_path in array array[
		'QorperaOS/surfaces/x/index.md',
		'QorperaOS/skills/s.md',
		'QorperaOS/agents/agent-a/skills/s.md',
		'QorperaOS/agents/agent-a/todos/t.md',
		'QorperaOS/agents/agent-a/routines/r.md',
		'QorperaOS/vision/reading.md',
		'QorperaOS/human-tasks/h.md',
		'QorperaOS/contacts/c.md'
	] loop
		perform pg_temp.qaf_assert(
			public.qorpera_folder_structured_review_class(c_env, p, jsonb_build_object('op', 'delete', 'path', v_path), v_path, null) = 'plain',
			'expected plain review class for ' || v_path
		);
	end loop;

	u := jsonb_build_array(pg_temp.qaf_del_dir('QorperaOS/agents/old-agent'));
	perform pg_temp.expect(pg_temp.commit(p, 'qaf-del-agent-none', u), 1, 'denied', 'review_required');
	r := pg_temp.vcommit(v_box, 'qaf-del-agent-view', u);
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	perform pg_temp.qaf_assert((pg_temp.parked(r)).id is not null and pg_temp.present('QorperaOS/agents/old-agent'),
		'deleting an agent folder still requires review and parks from a view');
	v_rev := pg_temp.record(b, pg_temp.action(b, 'qaf-del-agent-allow', 'allow', 'delegation', 'end_role'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'qaf-del-agent-ok', u, (v_rev ->> 'reviewId')::uuid), 1, 'saved');
	perform pg_temp.qaf_assert(not pg_temp.present('QorperaOS/agents/old-agent'),
		'deleting an agent folder saves with recorded delegation review');

	u := jsonb_build_array(pg_temp.qaf_del_dir('QorperaOS/agents/groups/old-grp'));
	perform pg_temp.expect(pg_temp.commit(p, 'qaf-del-grp-none', u), 1, 'denied', 'review_required');
	v_rev := pg_temp.record(b, pg_temp.action(b, 'qaf-del-grp-allow', 'allow', 'delegation', 'create_group_chat'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'qaf-del-grp-ok', u, (v_rev ->> 'reviewId')::uuid), 1, 'saved');

	r := pg_temp.vcommit(v_box, 'qaf-hire-view', jsonb_build_array(pg_temp.hire(v_box, 'nora', v_nora, 'Nora')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	perform pg_temp.qaf_assert((pg_temp.parked(r)).effect = 'delegation', 'hiring a staff agent stays delegation');

	perform pg_temp.qaf_assert(
		public.qorpera_folder_structured_review_class(
			c_env, p,
			jsonb_build_object('op', 'write', 'path', 'QorperaOS/agents/groups/launch/group.md', 'structured', jsonb_build_array(
				jsonb_build_object('path', 'QorperaOS/agents/groups/launch/group.md', 'kind', 'group',
					'parse', jsonb_build_object('kind', 'group', 'id', v_grp, 'name', 'Launch'))
			)),
			'QorperaOS/agents/groups/launch/group.md', null
		) = 'delegation',
		'creating a group chat stays delegation'
	);

	select session_id into v_thread
	from public.qorpera_company_rooms
	where profile_id = '63400000-0000-4000-8000-000000000010' and bound_staff_agent_id = c_agent
	limit 1;
	v_worker_run := pg_temp.run(c_agent, 'agent', c_owner, 'worker-dispatch', p, pg_temp.worker(c_agent, p, 'in-house', 'read'));
	v_worker_binding := pg_temp.native(v_worker_run);
	v_ask := public.qorpera_record_action_review(v_worker_binding, jsonb_build_object(
		'callId', 'qaf-worker-ask-1',
		'tool', 'machine_run',
		'effect', 'external',
		'argumentSha256', repeat('a', 64),
		'action', jsonb_build_object('title', 'Run shell command', 'target', 'office', 'arguments', '{"command":"echo hi"}'),
		'decision', 'ask',
		'ruleIds', '[]'::jsonb,
		'builtIn', 'none',
		'reason', 'Needs approval.',
		'proposedRule', null,
		'reviewerModel', 'gpt-6-luna'
	));
	perform pg_temp.qaf_assert(
		v_ask ->> 'decision' = 'ask'
		and (v_ask ->> 'card')::boolean is false
		and (v_ask ->> 'cardElsewhere')::boolean is false
		and (select card_session_id from public.qorpera_action_reviews where id = (v_ask ->> 'reviewId')::uuid) is null
		and not exists (
			select 1 from public.qorpera_session_events
			where event_id = (v_ask ->> 'reviewId')::uuid
				and (v_thread is null or session_id = v_thread)
		),
		'worker-dispatch ask drops no card into the agent thread: ' || v_ask::text
	);
end $$;

rollback;
