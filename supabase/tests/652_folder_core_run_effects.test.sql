-- @fixture 647_folder_core_run_fence.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Company folder core, C1c-2b part 2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6): a folder-v2 run's public
-- effects on the folder fence. The native send, the interaction request and the action-review card write the run's
-- conversation through the folder transcript append after the recheck and the session; only the folder send may add a
-- send row; the read check, the context view and an agent's "Ask first" rule have folder bodies. Runs are 647's
-- hand-built runs with their native rows. Races are in 653.

create function pg_temp.send(p_binding jsonb, p_key text, p_text text, p_phase text) returns jsonb language sql as $$
	select public.qorpera_send_native_agent_message((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_key, p_text, p_phase)
$$;
create function pg_temp.card(p_binding jsonb, p_event uuid, p_data jsonb default '{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel?","payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event, p_data)
$$;
create function pg_temp.review(p_binding jsonb, p_call text) returns jsonb language sql as $$
	select public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'send_email',
		'effect', 'external', 'argumentSha256', repeat('d', 64),
		'action', jsonb_build_object('title', 'Send an email', 'target', 'bob@acme.test', 'details', jsonb_build_object('subject', 'Moved')),
		'decision', 'ask', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'The reviewer is unsure.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna'))
$$;
create function pg_temp.human() returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
begin
	return jsonb_build_object('actor', p, 'binding', pg_temp.native(p));
end $$;
create function pg_temp.events(p_run text) returns bigint language sql as $$
	select count(*) from public.qorpera_session_events where execution_id = p_run::uuid
$$;

-- 2. The native send: an acknowledgement, then the final report; a replay; the wake policy; the run's conversation
-- through the folder append (its event, the run's budget); "already final".
do $$
declare w jsonb := pg_temp.human(); b jsonb := w -> 'binding'; x jsonb; y jsonb; e public.qorpera_session_events%rowtype;
	v_new uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', b, 'final-early', 'Done.', 'final'), '55000',
		'wake requires an acknowledgement before its final report');
	x := pg_temp.send(b, 'ack-1', 'On it.', 'progress');
	if x ->> 'runId' <> b ->> 'runId' or x ->> 'phase' <> 'progress' or (x ->> 'sequence')::bigint < 1 then raise exception 'The send: %', x; end if;
	select * into strict e from public.qorpera_session_events where event_id = (x ->> 'messageId')::uuid;
	if e.execution_id::text <> b ->> 'runId' or e.event_type <> 'message' or e.runner_assignment_id::text <> b ->> 'assignmentId'
		or e.body #>> '{entry,message,content,0,text}' <> 'On it.' or e.sequence <> (x ->> 'sequence')::bigint then
		raise exception 'The send''s event: %', to_jsonb(e); end if;
	if not exists (select 1 from public.qorpera_agent_sends where event_id = e.event_id and run_id::text = b ->> 'runId' and phase = 'progress') then
		raise exception 'The send row'; end if;
	if (select transcript_event_count from public.qorpera_execution_run_budgets where run_id = (b ->> 'runId')::uuid) <> 1 then
		raise exception 'The send counts in the run''s budget'; end if;
	y := pg_temp.send(b, 'ack-1', 'On it.', 'progress');
	if y <> x then raise exception 'A send replay: %', y; end if;
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', b, 'ack-1', 'Changed.', 'progress'), '23505',
		'agent send key is bound to different content');
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', b, 'bad key!', 'x', 'progress'), '22023', 'agent send arguments are invalid');
	x := pg_temp.send(b, 'final-1', 'Done.', 'final');
	if (select body #>> '{entry,parentId}' from public.qorpera_session_events where event_id = (x ->> 'messageId')::uuid) <> e.event_id::text then
		raise exception 'The final report follows the acknowledgement'; end if;
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', b, 'final-2', 'Again.', 'final'), '55000',
		'agent public output is already final');
	-- The transcript append keeps the run's budget and refuses an entry whose parent is not in the conversation.
	perform pg_temp.fx(format('update public.qorpera_execution_run_budgets set transcript_bytes = 67108864 where run_id = %L', b ->> 'runId'));
	w := pg_temp.human();
	perform pg_temp.fx(format('update public.qorpera_execution_run_budgets set transcript_bytes = 67108800 where run_id = %L',
		w -> 'binding' ->> 'runId'));
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', w -> 'binding', 'ack-full', 'On it.', 'progress'), '55000',
		'runner transcript budget is exhausted');
	perform pg_temp.fx(format('update public.qorpera_execution_run_budgets set transcript_bytes = 0 where run_id = %L', w -> 'binding' ->> 'runId'));
	perform pg_temp.raises_like(format('select public.qorpera_folder_append_transcript_event(r, %L, %L, %L, %L) from public.qorpera_execution_runs r where r.id = %L',
		w -> 'binding' ->> 'assignmentId', v_new, 'message', jsonb_build_object('schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object('type', 'message', 'id', v_new, 'parentId', 'not-in-this-conversation',
				'timestamp', '2026-09-29T00:00:00.000Z',
				'message', jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'x'))),
				'delivery', jsonb_build_object('schema', 'qorpera.agent-send/v1', 'phase', 'progress'),
				'execution', jsonb_build_object('kind', 'run', 'id', w -> 'binding' ->> 'runId', 'claimantId', w -> 'binding' ->> 'runId',
					'runnerAssignmentId', w -> 'binding' ->> 'assignmentId'))), w -> 'binding' ->> 'runId'), '42501',
		'runner transcript parent is unavailable');
	-- The conversation's agent version pin: a thread already at a later version refuses an older run's append.
	w := pg_temp.human();
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set staff_version = 2 where id = (select session_id from '
		|| 'public.qorpera_execution_runs where id = %L)', w -> 'binding' ->> 'runId'));
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', w -> 'binding', 'ack-pinned', 'On it.', 'progress'), 'PGRST',
		'%runner transcript session pins changed%');
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set staff_version = 1 where id = (select session_id from '
		|| 'public.qorpera_execution_runs where id = %L)', w -> 'binding' ->> 'runId'));
	w := jsonb_build_object('actor', b);
	-- A coworker's wake has no public mouth.
	w := jsonb_build_object('actor', pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'agent', '63400000-0000-4000-8000-000000000002',
		'coworker', pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000002')));
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', pg_temp.native(w -> 'actor'), 'cw-1', 'Hi.', 'progress'), '42501',
		'agent send audience or assignment is unavailable');
end $$;

-- 3. The recheck before anything public: once a read the run released is revoked, the send, the card and the read
-- check refuse; the stop refuses too.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
	w jsonb := pg_temp.human(); p jsonb := w -> 'actor'; b jsonb := w -> 'binding'; v_res uuid; v_g uuid;
begin
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'secret-2', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_g := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'secret-2-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','secret-2'),
		jsonb_build_object('op','write','path','secret-2/s.txt','file',pg_temp.stage('secret two')))), 2, 'saved');
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('secret-2/s.txt', p) -> 'entry'));
	perform pg_temp.send(b, 'ack-recheck', 'On it.', 'progress');
	perform public.qorpera_assert_company_path_reads(c_env, b, array['secret-2/s.txt']);
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_g);
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', b, 'after-revoke', 'Here it is.', 'final'), '42501',
		'A read is no longer readable');
	perform pg_temp.raises_like(format('select pg_temp.card(%L, %L)', b, extensions.gen_random_uuid()), '42501', 'A read is no longer readable');
	perform pg_temp.raises_like(format('select pg_temp.review(%L, %L)', b, 'call-revoked'), '42501', 'A read is no longer readable');
	perform pg_temp.raises_like(format('select public.qorpera_assert_company_path_reads(%L, %L, %L)', c_env, b, array[]::text[]), '42501',
		'A read is no longer readable');
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 'req-revoked', 'threadId', 't', 'turnId', null,
			'purpose', 'turn', 'outputs', '[]'::jsonb)), '42501', 'A read is no longer readable');
	perform pg_temp.raises_like(format('select public.qorpera_add_agent_review_rule(%L, %L)', b, '{"operationKey":"rule-revoked","when":"Sending money"}'),
		'42501', 'A read is no longer readable');
	if pg_temp.events(b ->> 'runId') <> 1 then raise exception 'A refused effect writes nothing'; end if;
	w := pg_temp.human(); b := w -> 'binding';
	perform pg_temp.fx(format('insert into public.qorpera_company_deletions(profile_id) values (%L)', '63400000-0000-4000-8000-000000000010'));
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', b, 'stopped', 'x', 'progress'), '55000', 'Company execution is paused');
	perform pg_temp.fx('delete from public.qorpera_company_deletions where profile_id = ''63400000-0000-4000-8000-000000000010''');
end $$;

-- 4. Only the folder send adds a send row on folder-v2: a direct insert, or one under another run's marker, refuses.
do $$
declare w jsonb := pg_temp.human(); b jsonb := w -> 'binding'; v_session uuid;
begin
	select session_id into strict v_session from public.qorpera_execution_runs where id = (b ->> 'runId')::uuid;
	perform pg_temp.raises_like(format('insert into public.qorpera_agent_sends(event_id, run_id, session_id, assignment_id, idempotency_key, '
		|| 'phase, text_sha256, body_sha256) values (%L, %L, %L, %L, ''forged'', ''progress'', %L, %L)', extensions.gen_random_uuid(), b ->> 'runId',
		v_session, b ->> 'assignmentId', repeat('1', 64), repeat('2', 64)), '42501', 'Folder send authority is required');
	perform set_config('qorpera.folder_send', extensions.gen_random_uuid()::text, true);
	perform pg_temp.raises_like(format('insert into public.qorpera_agent_sends(event_id, run_id, session_id, assignment_id, idempotency_key, '
		|| 'phase, text_sha256, body_sha256) values (%L, %L, %L, %L, ''forged'', ''progress'', %L, %L)', extensions.gen_random_uuid(), b ->> 'runId',
		v_session, b ->> 'assignmentId', repeat('1', 64), repeat('2', 64)), '42501', 'Folder send authority is required');
	perform set_config('qorpera.folder_send', '', true);
	-- The folder send clears its marker after its insert.
	perform pg_temp.send(b, 'ack-marker', 'On it.', 'progress');
	if current_setting('qorpera.folder_send', true) <> '' then raise exception 'The marker must be cleared after the send'; end if;
end $$;

-- 5. The interaction request: a card in the run's conversation, after the recheck and the session; a replay keeps its
-- first parent and time; a run without a conversation has no card.
do $$
declare w jsonb := pg_temp.human(); b jsonb := w -> 'binding'; v_event uuid := extensions.gen_random_uuid(); x jsonb; y jsonb;
begin
	perform pg_temp.send(b, 'ack-card', 'Checking.', 'progress');
	x := pg_temp.card(b, v_event);
	if x ->> 'event_type' <> 'interaction_request' or x ->> 'execution_id' <> b ->> 'runId' or x -> 'body' #>> '{entry,customType}' <> 'interaction_request' then
		raise exception 'The card: %', x; end if;
	y := pg_temp.card(b, v_event);
	if y -> 'body' <> x -> 'body' or y ->> 'sequence' <> x ->> 'sequence' then raise exception 'A card replay: %', y; end if;
	perform pg_temp.raises_like(format('select pg_temp.card(%L, %L, %L)', b, extensions.gen_random_uuid(), '{"schema":"nope"}'), '22023',
		'interaction request is invalid');
	-- A secret card never names a company connection: the company connects it in Settings.
	perform pg_temp.raises_like(format('select pg_temp.card(%L, %L, %L)', b, extensions.gen_random_uuid(),
		'{"schema":"qorpera.interaction/v1","surface":"secret","title":"Token","payload":{"name":"gh_token","label":"Token","purpose":"Needed","connectorId":"github"}}'),
		'22023', 'a secret card cannot name a company connection; the company connects it in Settings');
	w := jsonb_build_object('actor', pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'agent', '63400000-0000-4000-8000-000000000002',
		'coworker', pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000002')));
	perform pg_temp.raises_like(format('select pg_temp.card(%L, %L)', pg_temp.native(w -> 'actor'), extensions.gen_random_uuid()), '55000',
		'interaction requests need a conversation');
	-- A group chat (a room not bound to this run's agent) carries no card.
	w := pg_temp.human(); b := w -> 'binding';
	-- The run's conversation is agent A's thread; bound to another agent for this check, it is a group chat for A's run.
	perform pg_temp.fx($q$insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color,
		appearance_shape, employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id) values ('63400000-0000-4000-8000-000000000010',
		'65200000-0000-4000-8000-0000000000a3', 'Agent C', 'QA', 'Test.', 'green', 'round', 'active', 'active', statement_timestamp(),
		statement_timestamp(), '63400000-0000-4000-8000-000000000001')$q$);
	perform pg_temp.fx(format('update public.qorpera_company_rooms set bound_staff_agent_id = %L where session_id = (select session_id from '
		|| 'public.qorpera_execution_runs where id = %L)', '65200000-0000-4000-8000-0000000000a3', b ->> 'runId'));
	perform pg_temp.raises_like(format('select pg_temp.card(%L, %L)', b, extensions.gen_random_uuid()), '22023', 'cards are not raised in a group chat');
	perform pg_temp.fx(format('update public.qorpera_company_rooms set bound_staff_agent_id = %L where session_id = (select session_id from '
		|| 'public.qorpera_execution_runs where id = %L)', '63400000-0000-4000-8000-0000000000a1', b ->> 'runId'));
end $$;

-- 6. The action-review card: an ask in the conversation, through the folder append.
do $$
declare w jsonb := pg_temp.human(); b jsonb := w -> 'binding'; x jsonb;
begin
	perform pg_temp.send(b, 'ack-review', 'Checking.', 'progress');
	x := pg_temp.review(b, 'call-1');
	if not exists (select 1 from public.qorpera_session_events e join public.qorpera_action_reviews r on r.id = e.event_id
		where r.run_id::text = b ->> 'runId' and r.call_id = 'call-1' and e.event_type = 'authorization_request'
			and e.execution_id::text = b ->> 'runId') then
		raise exception 'The review card in the conversation: %', x; end if;
end $$;

-- 7. The read check before a model request: the run check and the recheck; the path list is not used.
do $$
declare c_env constant uuid := '63400000-0000-4000-8000-000000000020'; w jsonb := pg_temp.human(); b jsonb := w -> 'binding';
begin
	perform public.qorpera_assert_company_path_reads(c_env, b, array['anything/at/all.md']);
	if exists (select 1 from public.qorpera_company_run_read_paths where run_id = (b ->> 'runId')::uuid) then
		raise exception 'The folder read check never writes legacy read paths'; end if;
	perform pg_temp.raises_like(format('select public.qorpera_assert_company_path_reads(%L, %L, null)', c_env, b), '22023',
		'Company File context read set is invalid');
	perform pg_temp.raises_like(format('select public.qorpera_assert_company_path_reads(%L, null, %L)', c_env, array[]::text[]), '42501',
		'Company File authority is unavailable');
	perform pg_temp.raises_like(format('select public.qorpera_folder_assert_run_reads(%L, %L, %L)', '64700000-0000-4000-8000-000000000021', b,
		array[]::text[]), '42501', 'Company File authority is unavailable');
end $$;

-- 8. The context view: outputs cite this run's releases; the ordinal and the replay; a malformed screenshot refused (a
--    real one is recorded since P06d, test 910).
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	w jsonb := pg_temp.human(); p jsonb := w -> 'actor'; b jsonb := w -> 'binding'; v_release uuid := extensions.gen_random_uuid();
	v_out text := repeat('7', 64); x jsonb; v_view jsonb; v_other uuid := extensions.gen_random_uuid();
	v_empty uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format('insert into public.qorpera_native_execution_launches(run_id, runtime_bundle_id, runtime_bundle_sha256, binary_sha256,
		reasoning_effort, reasoning_policy_sha256, tool_catalog_text, context_sha256, context_bytes) values (%L, %L, %L, %L, ''low'', %L, ''{}'', %L, 1)',
		b ->> 'runId', extensions.gen_random_uuid(), repeat('b', 64), repeat('c', 64), repeat('d', 64), repeat('e', 64)));
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'view-setup', jsonb_build_array(jsonb_build_object('op','write','path','view.txt',
		'file',pg_temp.stage('view')))), 1, 'saved');
	perform public.qorpera_folder_record_release(c_env, p, v_release,
		(select jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority'))
			from (select pg_temp.read('view.txt', p) -> 'entry' e) x), v_out);
	v_view := jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 'req-1', 'threadId', 't', 'turnId', null,
		'purpose', 'turn', 'outputs', jsonb_build_array(jsonb_build_object('callId', 'c1', 'kind', 'function_call_output', 'sha256', repeat('8', 64),
			'bytes', 10, 'readId', v_release, 'readSha256', v_out, 'includedBytes', 10, 'includedSha256', repeat('9', 64))));
	x := public.qorpera_record_native_context_view(c_env, b, v_view);
	if x ->> 'ordinal' <> '1' then raise exception 'The first view: %', x; end if;
	if public.qorpera_record_native_context_view(c_env, b, v_view) <> x then raise exception 'A view replay'; end if;
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(v_view, '{threadId}', '"other"')), '23505', 'Context request replay differs');
	if public.qorpera_record_native_context_view(c_env, b, jsonb_set(v_view, '{requestId}', '"req-2"')) ->> 'ordinal' <> '2' then
		raise exception 'The second view''s ordinal'; end if;
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"req-3"'), '{outputs,0,readSha256}', to_jsonb(repeat('6', 64)))), '42501', 'Context read provenance differs');
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"req-4"'), '{outputs,0,readId}', to_jsonb(extensions.gen_random_uuid()))), '42501',
		'Context read provenance differs');
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"req-5"'), '{outputs,0,capture}', '{"assetId":"x"}')), '22023',
		'Native capture invalid');
	-- The release id in upper case is the same release.
	if public.qorpera_record_native_context_view(c_env, b, jsonb_set(jsonb_set(v_view, '{requestId}', '"req-6"'), '{outputs,0,readId}',
		to_jsonb(upper(v_release::text)))) ->> 'ordinal' <> '3' then raise exception 'An upper-case release id'; end if;
	-- Another run's release, a release that released no reads (the runtime sends readId null for those), and a run
	-- without its launch provenance, all refuse.
	w := pg_temp.human();
	perform public.qorpera_folder_record_release(c_env, w -> 'actor', v_other,
		(select jsonb_agg(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority'))
			from (select pg_temp.read('view.txt', w -> 'actor') -> 'entry' e) x), v_out);
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"req-7"'), '{outputs,0,readId}', to_jsonb(v_other))), '42501', 'Context read provenance differs');
	perform public.qorpera_folder_record_release(c_env, p, v_empty, '[]'::jsonb, v_out);
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, b,
		jsonb_set(jsonb_set(v_view, '{requestId}', '"req-8"'), '{outputs,0,readId}', to_jsonb(v_empty))), '42501', 'Context read provenance differs');
	perform pg_temp.raises_like(format('select public.qorpera_record_native_context_view(%L, %L, %L)', c_env, w -> 'binding',
		jsonb_set(v_view, '{requestId}', '"req-9"')), '42501', 'Native launch provenance is unavailable');
end $$;

-- 9. An agent's "Ask first" rule: added once; a replay; the same key for other text; the same text again is the same
-- rule. No company row lock (the member row serializes, 653).
do $$
declare w jsonb := pg_temp.human(); b jsonb := w -> 'binding'; x jsonb; y jsonb;
begin
	-- The wake's work gate: no rule before the owed acknowledgement.
	perform pg_temp.raises_like(format('select public.qorpera_add_agent_review_rule(%L, %L)', b, '{"operationKey":"rule-0","when":"Sending money"}'),
		'55000', 'Wake requires an acknowledgement before work');
	perform pg_temp.send(b, 'ack-rule', 'Noted.', 'progress');
	x := public.qorpera_add_agent_review_rule(b, '{"operationKey":"rule-1","when":"Sending money"}');
	if (x ->> 'added')::boolean is not true or x -> 'rule' ->> 'when' is null then raise exception 'The rule: %', x; end if;
	y := public.qorpera_add_agent_review_rule(b, '{"operationKey":"rule-1","when":"Sending money"}');
	if (y ->> 'added')::boolean or y -> 'rule' <> x -> 'rule' then raise exception 'A rule replay: %', y; end if;
	perform pg_temp.raises_like(format('select public.qorpera_add_agent_review_rule(%L, %L)', b, '{"operationKey":"rule-1","when":"Other"}'),
		'23505', 'This operation key already added another rule');
	y := public.qorpera_add_agent_review_rule(b, '{"operationKey":"rule-2","when":"sending money"}');
	if (y ->> 'added')::boolean or y -> 'rule' ->> 'id' <> x -> 'rule' ->> 'id' then raise exception 'The same rule again: %', y; end if;
	perform pg_temp.raises_like(format('select public.qorpera_add_agent_review_rule(%L, %L)', b, '{"operationKey":"bad key!","when":"x"}'),
		'22023', 'Rule request is invalid');
	-- The member's rule budget: a full budget refuses the add, with the member's way out.
	perform pg_temp.fx(format('insert into public.qorpera_review_rules(id, profile_id, scope, member_user_id, when_text, outcome, created_via, '
		|| 'created_by_staff_agent_id) select extensions.gen_random_uuid(), %L, ''member'', %L, ''Budget rule '' || n || '' '' || repeat(''x'', 250), '
		|| '''ask_first'', ''agent'', %L from generate_series(1, 70) n', '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002',
		'63400000-0000-4000-8000-0000000000a1'));
	y := public.qorpera_add_agent_review_rule(b, '{"operationKey":"rule-full","when":"Signing contracts"}');
	if (y ->> 'added')::boolean or y ->> 'refused' is null then raise exception 'A full rule budget: %', y; end if;
end $$;

-- 10. Snapshot-v1 controls and privileges.
do $$
declare s jsonb := current_setting('qorpera_test.snapshot_binding')::jsonb; v_fn text;
begin
	-- Since legacy sweep F1e (20260930248000) the send and the card take the folder path for every job: the binding
	-- they build names no model (its run has no row), which the folder run check refuses first.
	perform pg_temp.raises_like(format('select pg_temp.send(%L, %L, %L, %L)', s, 'k', 'x', 'progress'), '22023', 'native tool binding is invalid');
	perform pg_temp.raises_like(format('select pg_temp.card(%L, %L)', s, extensions.gen_random_uuid()), '22023', 'native tool binding is invalid');
	-- The rule is the folder core's since legacy sweep F1e: its run check refuses a job outside folder-v2.
	perform pg_temp.raises_like(format('select public.qorpera_add_agent_review_rule(%L, %L)', s, '{"operationKey":"k","when":"x"}'), '42501',
		'native tool run is unavailable');
	foreach v_fn in array array['public.qorpera_folder_append_transcript_event(public.qorpera_execution_runs,uuid,uuid,text,jsonb)',
		'public.qorpera_folder_send_agent_message(jsonb,text,text,text)', 'public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)',
		'public.qorpera_folder_assert_run_reads(uuid,jsonb,text[])', 'public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)',
		'public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)'] loop
		if has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
			or has_function_privilege('anon', v_fn, 'execute') then raise exception '% must be postgres-only', v_fn; end if;
	end loop;
end $$;

rollback;
