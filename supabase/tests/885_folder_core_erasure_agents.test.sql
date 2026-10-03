-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine: its row, its version and its position"
-- Company folder core, P18b (migration 20260930009300; deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md §5, §11):
-- erasure of a deleted agent folder, group chat and rule. Their rows keep fixed placeholders and bare ids, lose their
-- path and environment, and never come back; contract 14.1's dependent state goes (execution authority and connector
-- grants deleted, path grants revoked through the authority journal, office and browser grants revoked by the drain);
-- the operations log's earlier names, charters and chat titles are scrubbed with each row's hash recomputed. On 708's
-- company (Nora and Otto); rolled back at the end.

create function pg_temp.group_text(p_id uuid, p_name text, p_agents uuid[]) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nagents:\n%speople:\n---\nPlan the launch.\n', p_id, p_name,
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a))
$$;
create function pg_temp.group_parse(p_id uuid, p_name text, p_agents uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('kind','group','id',p_id,'name',p_name,'subtitle',null,'agents',to_jsonb(p_agents),
		'people','[]'::jsonb,'purpose','Plan the launch.')
$$;
create function pg_temp.new_group(p_handle text, p_id uuid, p_name text, p_agents uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents)))),
		'structured', jsonb_build_array(pg_temp.entry('agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents), pg_temp.group_parse(p_id, p_name, p_agents))))
$$;
create function pg_temp.rule(p_name text, p_id uuid, p_outcome text, p_text text) returns jsonb language sql as $$
	select pg_temp.write('rules/' || p_name || '.md', 'rule', format(E'---\nid: %s\noutcome: %s\n---\n%s\n', p_id, p_outcome, p_text),
		jsonb_build_object('kind','rule','id',p_id,'outcome',p_outcome,'text',p_text), pg_temp.version('rules/' || p_name || '.md'))
$$;
create function pg_temp.erase(p_paths text[], p_key text) returns jsonb language sql as $$
	select public.qorpera_folder_erase('70700000-0000-4000-8000-000000000020', pg_temp.owner(), to_jsonb(p_paths), p_key)
$$;
create function pg_temp.drain(p_id uuid) returns public.qorpera_folder_erasures language plpgsql as $$
declare v public.qorpera_folder_erasures%rowtype;
begin
	for i in 1..80 loop
		select * into v from public.qorpera_folder_erasures where id = p_id;
		exit when v.state <> 'working';
		perform public.qorpera_folder_erasure_step();
	end loop;
	select * into v from public.qorpera_folder_erasures where id = p_id;
	return v;
end $$;
create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.outcome(p_result jsonb) returns text language sql as $$
	select (p_result -> 'units' -> 0 ->> 'outcome') || coalesce('/' || (p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'), '')
$$;
create function pg_temp.ops_hash(o public.qorpera_company_operations) returns text language sql as $$
	select encode(extensions.digest(convert_to(jsonb_build_object('operation_type', o.operation_type, 'entity_id', o.entity_id,
		'entity_version', o.entity_version, 'payload', o.payload)::text, 'utf8'), 'sha256'), 'hex')
$$;

-- 1. Nora's folder (a routine and a todo), a group chat with her and a rule; then all three are deleted ----------------

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit(pg_temp.owner(), 'erase-agents-0', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/groups'),
		jsonb_build_object('op','mkdir','path','rules')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'erase-agents-1', jsonb_build_array(
		pg_temp.routine('agents/nora/routines/daily.md', pg_temp.rparse('88500000-0000-4000-8000-0000000000b1', 'Daily inbox', pg_temp.every(60))),
		pg_temp.todo('agents/nora/todos/call-maria.md', '88500000-0000-4000-8000-0000000000c1', 'Call Maria about the audit', 'open', null,
			'Ask Maria about the audit.'),
		pg_temp.new_group('launch', '88500000-0000-4000-8000-0000000000d1', 'Launch with Nora',
			array['70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-0000000000a2']::uuid[]),
		pg_temp.rule('no-maria', '88500000-0000-4000-8000-0000000000e1', 'ask-first', 'mail Maria at Jensen Revision')));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- An execution authority, an office (with a browser profile), an office access and a browser grant of Nora's, as
	-- their own mutators leave them; the rows they point at exist, since an update checks them.
	perform pg_temp.fx($q$
		insert into public.qorpera_staff_execution_authorities(profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
			configured_by_user_id)
		values ('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-0000000000a1', '70800000-0000-4000-8000-0000000000b1', 1,
			'70700000-0000-4000-8000-000000000001');
		insert into public.qorpera_runtime_offices(id, profile_id, environment_id, logical_computer_id, client_computer_id, image_sha256,
			bootstrap_sha256, state, max_screens, created_by_user_id)
		values ('88500000-0000-4000-8000-0000000000f3', '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020',
			'88500000-0000-4000-8000-0000000000f5', '88500000-0000-4000-8000-0000000000f6', repeat('1', 64), repeat('2', 64), 'active', 1,
			'70700000-0000-4000-8000-000000000001');
		insert into public.qorpera_runtime_browser_profiles(id, office_id, owner_user_id)
		values ('88500000-0000-4000-8000-0000000000f4', '88500000-0000-4000-8000-0000000000f3', '70700000-0000-4000-8000-000000000001');
		insert into public.qorpera_runtime_office_access(office_id, staff_agent_id, profile_id, state, capabilities, configured_by_user_id)
		values ('88500000-0000-4000-8000-0000000000f3', '70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-000000000010',
			'active', '["shell"]', '70700000-0000-4000-8000-000000000001');
		insert into public.qorpera_runtime_browser_grants(profile_id, office_id, staff_agent_id, profile_version, owner_membership_version, state)
		values ('88500000-0000-4000-8000-0000000000f4', '88500000-0000-4000-8000-0000000000f3', '70700000-0000-4000-8000-0000000000a1',
			1, 0, 'active')$q$);
	-- A finished worker under her todo, as its files leave it (F2-5b), with its dispatch event; its run is a routine run.
	perform set_config('qorpera_test.worker_run', pg_temp.routine_run('88500000-0000-4000-8000-0000000000b1') ->> 'runId', true);
	perform pg_temp.fx(format($q$
		insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, title, access,
			revival, dispatch, state, requested_by_user_id, steering_run_id, result, reported_at, acceptance_note, folder_environment_id,
			folder_path, folder_key, folder_brief_version, folder_commit_id)
		values ('88500000-0000-4000-8000-0000000000c2', '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020',
			'70700000-0000-4000-8000-0000000000a1', '88500000-0000-4000-8000-0000000000c1', 'ask-maria', 'Ask Maria about the audit',
			'read', 'each', '{"goal":"Ask Maria about the audit","definitionOfDone":"She answers","sources":["contacts/maria.md"]}',
			'succeeded', '70700000-0000-4000-8000-000000000001', %1$L, '{"summary":"Maria said yes","words":3}', clock_timestamp(),
			'Maria agreed', '70700000-0000-4000-8000-000000000020', 'agents/nora/todos/call-maria/ask-maria',
			'agents/nora/todos/call-maria/ask-maria', '88500000-0000-4000-8000-0000000000c3',
			(select id from public.qorpera_folder_commits where operation_key = 'erase-agents-1'));
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values ('88500000-0000-4000-8000-0000000000c2', 1, 'dispatched', %1$L, '{"goal":"Ask Maria about the audit"}')$q$,
		current_setting('qorpera_test.worker_run')));
	-- A second office (the other environment's) with Nora's access, and her pair conversation with Otto.
	perform pg_temp.fx($q$
		insert into public.qorpera_runtime_offices(id, profile_id, environment_id, logical_computer_id, client_computer_id, image_sha256,
			bootstrap_sha256, state, max_screens, created_by_user_id)
		values ('88500000-0000-4000-8000-0000000000f7', '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000022',
			'88500000-0000-4000-8000-0000000000f8', '88500000-0000-4000-8000-0000000000f9', repeat('1', 64), repeat('2', 64), 'active', 1,
			'70700000-0000-4000-8000-000000000001');
		insert into public.qorpera_runtime_office_access(office_id, staff_agent_id, profile_id, state, capabilities, configured_by_user_id)
		values ('88500000-0000-4000-8000-0000000000f7', '70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-000000000010',
			'active', '["shell"]', '70700000-0000-4000-8000-000000000001')$q$);
	perform public.qorpera_agent_pair_session_internal('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020',
		'70700000-0000-4000-8000-0000000000a1', '70700000-0000-4000-8000-0000000000a2', '70700000-0000-4000-8000-000000000001');
	if not exists (select 1 from public.qorpera_staff_execution_authorities where staff_agent_id = '70700000-0000-4000-8000-0000000000a1')
		or not exists (select 1 from public.qorpera_company_path_grants where principal_kind = 'staff_agent'
			and principal_id = '70700000-0000-4000-8000-0000000000a1' and revoked_at is null)
		or not exists (select 1 from public.qorpera_company_rooms where bound_staff_agent_id = '70700000-0000-4000-8000-0000000000a1') then
		raise exception 'Fixture: Nora has an execution authority (%), a path grant (%) and a thread (%)',
			exists (select 1 from public.qorpera_staff_execution_authorities where staff_agent_id = '70700000-0000-4000-8000-0000000000a1'),
			exists (select 1 from public.qorpera_company_path_grants where principal_id = '70700000-0000-4000-8000-0000000000a1'),
			exists (select 1 from public.qorpera_company_rooms where bound_staff_agent_id = '70700000-0000-4000-8000-0000000000a1'); end if;
	r := pg_temp.commit(pg_temp.owner(), 'erase-agents-2', jsonb_build_array(
		jsonb_build_object('op','delete','path','agents/nora','expectedVersion',pg_temp.version('agents/nora'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','delete','path','agents/groups/launch','expectedVersion',pg_temp.version('agents/groups/launch'),
			'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','delete','path','rules/no-maria.md','expectedVersion',pg_temp.version('rules/no-maria.md'))));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	if (select folder_retired_at is null or employment_status <> 'archived' from public.qorpera_profile_staff
			where staff_agent_id = '70700000-0000-4000-8000-0000000000a1') then raise exception 'Fixture: Nora is retired'; end if;
	-- Nova moves into agents/nora: the root is live, and only its earlier life (Nora's) is erased.
	r := pg_temp.commit(pg_temp.owner(), 'erase-agents-2b', jsonb_build_array(pg_temp.hire('nora', '70700000-0000-4000-8000-0000000000a3', 'Nova')));
	perform pg_temp.expect(r, 1, 'saved');
	-- A connector grant of hers, as archiving leaves it (revoked).
	perform pg_temp.fx($q$
		insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id, connector_id,
			operation_id, operation_version, tool_name, issued_by_user_id, status, revoked_at)
		values ('88500000-0000-4000-8000-0000000000f1', '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020',
			'88500000-0000-4000-8000-0000000000f2', '70700000-0000-4000-8000-0000000000a1', 'gmail', 'send', 1, 'gmail_send',
			'70700000-0000-4000-8000-000000000001', 'revoked', clock_timestamp())$q$);
end $$;

-- 2. The request: the rows take their placeholders, 14.1's state goes, the grants are revoked through the journal --------

do $$
declare r jsonb; v_staff public.qorpera_profile_staff%rowtype; v_thread public.qorpera_company_rooms%rowtype;
	v_group public.qorpera_company_rooms%rowtype; v_seq bigint; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_ops bigint;
begin
	v_seq := pg_temp.seq();
	select count(*) into v_ops from public.qorpera_company_operations o join public.qorpera_company_rooms m on m.session_id = o.entity_id
	where m.bound_staff_agent_id = '70700000-0000-4000-8000-0000000000a1' and o.operation_type = 'session_state';
	r := pg_temp.erase(array['agents/nora', 'agents/groups/launch', 'rules/no-maria.md'], 'erase-agents-3');
	if r -> 'erased' <> '{"agents":1,"groupChats":1,"todos":1,"workers":1,"routines":1,"rules":1}'::jsonb then
		raise exception 'The reply counts what was erased: %', r; end if;
	select * into v_staff from public.qorpera_profile_staff where staff_agent_id = '70700000-0000-4000-8000-0000000000a1';
	if (v_staff.display_name, v_staff.role, v_staff.charter) is distinct from ('Erased agent', 'Erased', 'Erased.')
		or v_staff.folder_path is not null or v_staff.folder_environment_id is not null or v_staff.folder_erased_at is null
		or v_staff.folder_path_version is null or v_staff.folder_retired_at is null or v_staff.deleted_at is not null then
		raise exception 'The agent keeps its row with placeholders: %', row_to_json(v_staff); end if;
	select * into v_thread from public.qorpera_company_rooms where bound_staff_agent_id = '70700000-0000-4000-8000-0000000000a1';
	if v_thread.name <> 'Erased agent' or v_thread.status <> 'archived'
		or (select title from public.qorpera_shared_sessions where id = v_thread.session_id) <> 'Erased agent' then
		raise exception 'The thread and its session are renamed, still archived'; end if;
	-- The thread trigger leaves an erased agent's thread to the erasure: one rename of its session, not a second.
	if (select count(*) from public.qorpera_company_operations where entity_id = v_thread.session_id
			and operation_type = 'session_state') <> v_ops + 1 then
		raise exception 'The thread trigger left the erased agent''s thread alone'; end if;
	if (select title from public.qorpera_shared_sessions where profile_id = '70700000-0000-4000-8000-000000000010'
			and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key('70700000-0000-4000-8000-0000000000a1',
				'70700000-0000-4000-8000-0000000000a2')) <> 'Erased agent & Otto' then
		raise exception 'The pair conversation is titled with the erased side''s placeholder'; end if;
	if (select (display_name, folder_path, folder_erased_at) is distinct from ('Nova', 'agents/nora/agent.md', null)
			from public.qorpera_profile_staff where staff_agent_id = '70700000-0000-4000-8000-0000000000a3') then
		raise exception 'The agent living at the root now is untouched'; end if;
	select * into v_group from public.qorpera_company_rooms where room_key = 'chat-88500000-0000-4000-8000-0000000000d1';
	if (v_group.name, v_group.purpose) is distinct from ('Erased group chat', 'Erased.') or v_group.folder_path is not null
		or v_group.folder_erased_at is null
		or (select title from public.qorpera_shared_sessions where id = v_group.session_id) <> 'Erased group chat' then
		raise exception 'The group chat and its session take placeholders: %', row_to_json(v_group); end if;
	if (select (title, detail, todo_key, folder_path) is distinct from ('Erased', '', 'erased.885000000000400080000000000000c1', null)
			from public.qorpera_runtime_agent_todos where id = '88500000-0000-4000-8000-0000000000c1') then
		raise exception 'The todo takes placeholders and a tombstone key'; end if;
	-- The worker keeps its row, state and JSON shapes; what its files said goes.
	if (select (title, worker_key, dispatch, result, acceptance_note, state, folder_path, folder_key, folder_erased_at is not null)
			is distinct from ('Erased', 'erased.885000000000400080000000000000c2',
				'{"goal":"Erased.","definitionOfDone":"Erased.","sources":[]}'::jsonb, '{"summary":"Erased.","words":3}'::jsonb,
				'Erased.', 'succeeded', null, null, true)
			from public.qorpera_runtime_workers where id = '88500000-0000-4000-8000-0000000000c2')
		or (select body from public.qorpera_runtime_worker_events where worker_id = '88500000-0000-4000-8000-0000000000c2')
			<> '{"goal":"Erased."}'::jsonb then
		raise exception 'The worker and its events take placeholders'; end if;
	if (select (routine_key, folder_path) is distinct from ('erased.885000000000400080000000000000b1', null)
			from public.qorpera_cloud_routines where id = '88500000-0000-4000-8000-0000000000b1') then
		raise exception 'The routine takes a tombstone key'; end if;
	for v_version in select * from public.qorpera_cloud_routine_versions where routine_id = '88500000-0000-4000-8000-0000000000b1' loop
		if (v_version.title, v_version.prompt) is distinct from ('Erased', 'Erased.') or v_version.content_sha256 <>
				public.qorpera_company_state_routine_sha(v_version.staff_agent_id, 'Erased', 'Erased.', v_version.triggers,
					v_version.effort, v_version.sponsor_binding_id, v_version.sponsor_version) then
			raise exception 'Each routine version takes placeholders and its hash'; end if;
	end loop;
	if (select (when_text, folder_path) is distinct from ('Erased.', null) from public.qorpera_review_rules
			where id = '88500000-0000-4000-8000-0000000000e1') then raise exception 'The rule takes its placeholder'; end if;
	-- Contract 14.1: the execution authority and the connector grant go; the path grants are revoked through the journal.
	if exists (select 1 from public.qorpera_staff_execution_authorities where staff_agent_id = '70700000-0000-4000-8000-0000000000a1')
		or exists (select 1 from public.qorpera_cloud_secret_operation_grants where id = '88500000-0000-4000-8000-0000000000f1')
		or exists (select 1 from public.qorpera_company_path_grants where principal_kind = 'staff_agent'
			and principal_id = '70700000-0000-4000-8000-0000000000a1' and revoked_at is null) then
		raise exception 'The agent''s dependent state goes'; end if;
	if not exists (select 1 from public.qorpera_folder_journal j where j.environment_id = '70700000-0000-4000-8000-000000000020'
			and j.seq > v_seq and j.kind = 'authority' and (j.authority ->> 'narrowing')::boolean
			and exists (select 1 from public.qorpera_folder_authority_changes c where c.environment_id = j.environment_id and c.seq = j.seq
				and c.grant_id in (select id from public.qorpera_company_path_grants where principal_id = '70700000-0000-4000-8000-0000000000a1'))) then
		raise exception 'The revocation is journalled, narrowing'; end if;
	perform set_config('qorpera_test.erasure', r ->> 'erasureId', true);
end $$;

-- 3. An erased id never comes back: each kind's rule refuses it ----------------------------------------------------------

do $$
begin
	perform pg_temp.is(pg_temp.outcome(pg_temp.commit(pg_temp.owner(), 'erase-agents-4', jsonb_build_array(
		pg_temp.hire('nora-again', '70700000-0000-4000-8000-0000000000a1', 'Nora')))),
		'refused/this id belongs to an agent outside the company folder', 'the agent');
	perform pg_temp.is(pg_temp.outcome(pg_temp.commit(pg_temp.owner(), 'erase-agents-5', jsonb_build_array(
		pg_temp.new_group('launch', '88500000-0000-4000-8000-0000000000d1', 'Launch',
			array['70700000-0000-4000-8000-0000000000a2', '70700000-0000-4000-8000-0000000000c0']::uuid[])))),
		'refused/this id belongs to another conversation; give this group chat a new id', 'the group chat');
	perform pg_temp.is(pg_temp.outcome(pg_temp.commit(pg_temp.owner(), 'erase-agents-6', jsonb_build_array(
		pg_temp.rule('no-maria', '88500000-0000-4000-8000-0000000000e1', 'ask-first', 'mail Maria')))),
		'refused/this id belongs to another rule; give this rule a new id', 'the rule');
	perform pg_temp.is(pg_temp.outcome(pg_temp.commit(pg_temp.owner(), 'erase-agents-7', jsonb_build_array(
		pg_temp.todo('agents/otto/todos/call-maria.md', '88500000-0000-4000-8000-0000000000c1', 'Call', 'open', null, '')))),
		'refused/this id belongs to another todo; give this todo a new id', 'the todo');
	perform pg_temp.is(pg_temp.outcome(pg_temp.commit(pg_temp.owner(), 'erase-agents-8', jsonb_build_array(
		pg_temp.routine('agents/otto/routines/daily.md', pg_temp.rparse('88500000-0000-4000-8000-0000000000b1', 'Daily', pg_temp.every(60)))))),
		'refused/this id belongs to another routine; give this routine a new id', 'the routine');
end $$;

-- 4. The drain: the operations log's earlier names, charters and titles, each row's hash recomputed; office and browser --

do $$
declare v public.qorpera_folder_erasures%rowtype; v_op public.qorpera_company_operations%rowtype;
begin
	-- The company's other environment is not folder-v2 yet, so the bytes wait for folder GC: it is enabled, the
	-- fixture's upload intents are made older than their day, and the revisit goes on.
	v := pg_temp.drain(current_setting('qorpera_test.erasure')::uuid);
	perform public.qorpera_folder_enable('70700000-0000-4000-8000-000000000022');
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	update public.qorpera_folder_erasures set revisit_at = clock_timestamp() - interval '1 second' where id = v.id and state = 'waiting';
	perform public.qorpera_folder_erasure_step();
	v := pg_temp.drain(v.id);
	if v.state <> 'done' or v.agents is not null then raise exception 'Done: %', row_to_json(v); end if;
	if exists (select 1 from public.qorpera_company_operations o where o.profile_id = '70700000-0000-4000-8000-000000000010'
			and ((o.operation_type = 'staff_state' and o.entity_id = '70700000-0000-4000-8000-0000000000a1'
					and (o.payload ->> 'display_name' <> 'Erased agent' or o.payload ->> 'charter' <> 'Erased.'
						or o.payload ->> 'role' <> 'Erased'))
				or (o.operation_type = 'session_state' and o.payload ->> 'title' in ('Nora', 'Launch with Nora', 'Nora & Otto')))) then
		raise exception 'No earlier name, charter or title is left in the operations log'; end if;
	for v_op in select * from public.qorpera_company_operations o where o.profile_id = '70700000-0000-4000-8000-000000000010'
			and o.operation_type in ('staff_state', 'session_state') loop
		if v_op.content_sha256 <> pg_temp.ops_hash(v_op) then
			raise exception 'Every row''s hash matches its own fields (rows are not chained): %', v_op.sequence; end if;
	end loop;
	if (v.counts ->> 'operations')::integer < 3 then raise exception 'The scrubbed rows are counted: %', v.counts; end if;
	-- Otto's and Nova's rows are theirs: not one of them changes.
	if exists (select 1 from public.qorpera_company_operations o where o.profile_id = '70700000-0000-4000-8000-000000000010'
			and o.operation_type = 'staff_state' and o.entity_id in ('70700000-0000-4000-8000-0000000000a2', '70700000-0000-4000-8000-0000000000a3')
			and o.payload ->> 'display_name' not in ('Otto', 'Nova')) then
		raise exception 'Other agents'' operations rows are left'; end if;
	if exists (select 1 from public.qorpera_runtime_office_access where staff_agent_id = '70700000-0000-4000-8000-0000000000a1'
			and state <> 'revoked')
		or exists (select 1 from public.qorpera_runtime_browser_grants where staff_agent_id = '70700000-0000-4000-8000-0000000000a1'
			and state <> 'revoked')
		or exists (select 1 from public.qorpera_runtime_office_access where staff_agent_id = '70700000-0000-4000-8000-0000000000a3'
			and state = 'revoked')
		or not exists (select 1 from public.qorpera_runtime_office_access where staff_agent_id = '70700000-0000-4000-8000-0000000000a3'
			and state = 'active') then
		raise exception 'Office and browser grants are revoked'; end if;
end $$;

-- 5. Each read of the request's rows by path writes the folded-key range out (the indexes 20260930009300 adds); the row
-- cutoff keeps a row whose last version is not before the cutoff --------------------------------------------------------

do $$
declare v_plan text; v_seq bigint; v_commit uuid; v_first uuid; v_second uuid;
begin
	perform set_config('enable_seqscan', 'off', true);
	execute format($q$explain (format json) select t.id from unnest(array['agents/nora']) k
		join public.qorpera_runtime_agent_todos t on t.folder_environment_id = %L and t.folder_path is not null
			and public.qorpera_folder_key(t.folder_path) collate "C" >= k collate "C"
			and public.qorpera_folder_key(t.folder_path) collate "C" < (k || '0') collate "C"$q$,
		'70700000-0000-4000-8000-000000000020') into v_plan;
	perform set_config('enable_seqscan', 'on', true);
	if strpos(v_plan, 'qorpera_runtime_agent_todos_folder_key') = 0 then raise exception 'The todo range uses its index: %', v_plan; end if;
	select c.id, c.seq into v_commit, v_seq from public.qorpera_folder_commits c where c.operation_key = 'erase-agents-0';
	select version into v_first from public.qorpera_folder_path_versions where commit_id = v_commit and unit_no = 1;
	select version into v_second from public.qorpera_folder_path_versions where commit_id = v_commit and unit_no = 2;
	if not public.qorpera_folder_erasure_row_before(jsonb_build_object('cutoffSeq', v_seq, 'cutoffUnit', 2), v_commit, v_first)
		or public.qorpera_folder_erasure_row_before(jsonb_build_object('cutoffSeq', v_seq, 'cutoffUnit', 2), v_commit, v_second)
		or not public.qorpera_folder_erasure_row_before(jsonb_build_object('cutoffSeq', v_seq + 1, 'cutoffUnit', 1), v_commit, v_second)
		or public.qorpera_folder_erasure_row_before(jsonb_build_object('cutoffSeq', v_seq - 1, 'cutoffUnit', 9), v_commit, v_first) then
		raise exception 'A row at the cutoff''s commit counts only with its last version before the cutoff'; end if;
	if (select (length(prosrc) - length(replace(prosrc, '.folder_path) collate "C" <', ''))) / length('.folder_path) collate "C" <')
			from pg_proc where oid = 'public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure) < 8 then
		raise exception 'The agents'', chats'', routines'', todos'' and rules'' reads write the key range out'; end if;
end $$;

rollback;
