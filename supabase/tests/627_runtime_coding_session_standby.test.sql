-- @fixture 601_runtime_coding_turn_continuity.test.sql until "-- 1. Executor loss right after the harness submitted"
-- Coding sessions stand by between turns (2026-09-28). A session stays attached
-- to its member's machine after its turn, under an attachment its machine's
-- executor renews; commands of earlier turns can still be read and cancelled;
-- the machine sleeps only when quiet; the member, the agent or the executor
-- archives a session, and a new turn reopens it; a machine is removed once its
-- member has no open session.
--
-- The fixture leaves fix-send at sequence 2, waiting for the owner.

create function pg_temp.vm() returns uuid language sql as $$ select current_setting('qorpera_test.coding_vm')::uuid $$;
create function pg_temp.binding() returns text language sql as $$ select current_setting('qorpera_test.coding_binding') $$;
create function pg_temp.listed() returns jsonb language sql as $$
	select entry from jsonb_array_elements(public.qorpera_list_coding_machines('exec-test',repeat('c',64))) entry where entry ->> 'machineId' = pg_temp.vm()::text
$$;
create function pg_temp.custody(p_intent text,p_worker uuid default null,p_lease uuid default null) returns jsonb language sql as $$
	select public.qorpera_authorize_coding_machine_custody(pg_temp.vm(),'exec-test',pg_temp.binding(),repeat('c',64),p_intent,p_worker,p_lease)
$$;
-- p_generation: the digest of the token the guest's live lease names, as the executor reads it; null for none.
create function pg_temp.attach(p_key text,p_turn jsonb,p_generation text default null) returns jsonb language sql as $$
	select public.qorpera_attach_coding_session((pg_temp.worker_row(p_key)).id,(p_turn #>> '{claim,leaseToken}')::uuid,pg_temp.binding(),
		pg_temp.storage((pg_temp.worker_row(p_key)).id),repeat('c',64),p_generation)
$$;
create function pg_temp.gen(p_token text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_token,'utf8'),'sha256'),'hex')
$$;
create function pg_temp.last_stop() returns jsonb language sql as $$
	select body from public.qorpera_coding_session_events where worker_id = (pg_temp.worker_row('fix-send')).id and kind = 'step'
		and actor = 'executor' and body ? 'stopped' order by id desc limit 1
$$;
create function pg_temp.keep(p_observation jsonb default null) returns jsonb language sql as $$
	select public.qorpera_keep_coding_attachments(pg_temp.vm(),'exec-test',pg_temp.binding(),repeat('c',64),p_observation)
$$;
create function pg_temp.kept(p_keep jsonb,p_key text) returns jsonb language sql as $$
	select entry from jsonb_array_elements(p_keep -> 'sessions') entry where entry ->> 'workerId' = (pg_temp.worker_row(p_key)).id::text
$$;
create function pg_temp.view(p_key text) returns jsonb language sql as $$
	select public.qorpera_coding_session_view(pg_temp.session_row(p_key),pg_temp.worker_row(p_key))
$$;
select pg_temp.path_claims('service_role');

-- 1. The owner answers; the turn attaches its session and a command starts. The attachment is the
--    session's own: the same machine keeps its token, and the keeper renews it with the turn open.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn jsonb; v_attach jsonb; v_again jsonb;
	v_keep jsonb; v_command uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Raise it to 500 ms.','30000000-0000-4000-8000-000000000701');
	perform pg_temp.path_claims('service_role');
	v_turn := pg_temp.next_turn('fix-send');
	perform set_config('qorpera_test.turn3',v_turn::text,false);
	v_attach := pg_temp.attach('fix-send',v_turn);
	v_again := pg_temp.attach('fix-send',v_turn,pg_temp.gen(v_attach ->> 'attachmentToken'));
	perform pg_temp.wake_assert(v_attach ->> 'schema' = 'qorpera.coding-attachment/v1' and v_attach ->> 'machineId' = pg_temp.vm()::text
		and v_again ->> 'attachmentToken' = v_attach ->> 'attachmentToken' and (v_attach #>> '{turn,sequence}')::int = 3
		and (v_attach #>> '{turn,turnId}')::uuid = public.qorpera_coding_turn_id(v_worker.id,3) and (v_attach #>> '{turn,open}')::boolean
		and (pg_temp.session_row('fix-send')).attached_machine_id = pg_temp.vm()
		and (pg_temp.session_row('fix-send')).attachment_until > clock_timestamp() + interval '50 seconds',
		'A turn attaches its session; a second attach on the same machine, the guest holding it, keeps the generation: '||v_attach::text);
	-- A guest that does not hold the live generation (its lease ran out) gets a new one.
	v_attach := pg_temp.attach('fix-send',v_turn);
	perform pg_temp.wake_assert(v_attach ->> 'attachmentToken' <> v_again ->> 'attachmentToken','Without the guest''s lease a new generation starts');
	perform set_config('qorpera_test.token',v_attach ->> 'attachmentToken',false);
	begin perform public.qorpera_attach_coding_session(v_worker.id,extensions.gen_random_uuid(),pg_temp.binding(),pg_temp.storage(v_worker.id),repeat('c',64),null);
		raise exception 'A foreign lease attached the session'; exception when insufficient_privilege then null; end;
	-- A command of turn 3, receipted by its run.
	perform public.qorpera_begin_native_tool_operation(v_turn -> 'binding',v_command,'coding_run_command:dev-server',repeat('a',64),repeat('b',64),false);
	perform public.qorpera_complete_native_tool_operation(v_turn -> 'binding',v_command,repeat('a',64),'{}'::jsonb);
	perform set_config('qorpera_test.command3',v_command::text,false);
	v_keep := pg_temp.keep(jsonb_build_object('schema','qorpera.coding-machine-observation/v1','busy',true,'sessions',jsonb_build_array(
		jsonb_build_object('workerId',v_worker.id,'busy',true,'running',jsonb_build_array(
			jsonb_build_object('commandId',v_command,'turn',3,'command','npm run dev')))))) ;
	perform pg_temp.wake_assert(pg_temp.kept(v_keep,'fix-send') ->> 'state' = 'kept'
		and pg_temp.kept(v_keep,'fix-send') ->> 'attachmentToken' = v_attach ->> 'attachmentToken'
		and (pg_temp.kept(v_keep,'fix-send') #>> '{turn,open}')::boolean and (pg_temp.kept(v_keep,'fix-send') #>> '{turn,sequence}')::int = 3
		and (pg_temp.session_row('fix-send')).running_commands -> 0 ->> 'command' = 'npm run dev'
		and (pg_temp.session_row('fix-send')).busy_at is not null
		and (select busy_at is not null from public.qorpera_coding_machines where id = pg_temp.vm()),
		'The keeper renews the attachment, names the open turn and records what runs: '||v_keep::text);
	begin perform pg_temp.keep('{"schema":"qorpera.coding-machine-observation/v1","busy":true,"sessions":[{"workerId":"x","busy":true,"running":[]}]}');
		raise exception 'A malformed observation was accepted'; exception when sqlstate '22023' then null; end;
	begin perform public.qorpera_keep_coding_attachments(pg_temp.vm(),'someone-else',pg_temp.binding(),repeat('c',64),null);
		raise exception 'A foreign executor kept the attachments'; exception when insufficient_privilege then null; end;
	-- Even the turn's own lease no longer detaches an attached session.
	perform pg_temp.wake_assert(pg_temp.custody('detach',v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid) ->> 'reason' = 'SESSION_ATTACHED',
		'An attached session is not detached while its attachment may stay');
end $$;

-- 2. The turn ends. The session stands by: attached, its command still running, the turn closed.
--    The machine is not live, but it sleeps only once quiet: no turn and no busy command for the delay.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn jsonb := current_setting('qorpera_test.turn3')::jsonb;
	v_keep jsonb; v_view jsonb;
begin
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','ask','operationKey','ask-3',
		'summary','Raised to 500 ms; the dev server runs.','question','Keep the dev server running?','options',jsonb_build_array('Yes','No')));
	perform pg_temp.end_turn('fix-send',v_turn);
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid,'blocked','Raised to 500 ms.',
		'Keep the dev server running?',null,null,null,null,null,'["Yes","No"]');
	v_keep := pg_temp.keep(jsonb_build_object('schema','qorpera.coding-machine-observation/v1','busy',false,'sessions',jsonb_build_array(
		jsonb_build_object('workerId',v_worker.id,'busy',false,'running',jsonb_build_array(
			jsonb_build_object('commandId',current_setting('qorpera_test.command3')::uuid,'turn',3,'command','npm run dev'))))));
	v_view := pg_temp.view('fix-send');
	perform pg_temp.wake_assert(pg_temp.kept(v_keep,'fix-send') ->> 'state' = 'kept' and not (pg_temp.kept(v_keep,'fix-send') #>> '{turn,open}')::boolean
		and (v_view ->> 'attached')::boolean and (v_view ->> 'runningCommands')::int = 1 and not (v_view ->> 'machineAsleep')::boolean
		and v_view ->> 'archivedAt' is null and v_view ->> 'phase' = 'awaiting_input',
		'After its turn the session stands by with its command running: '||v_view::text);
	perform pg_temp.wake_assert(pg_temp.listed() ->> 'live' = 'false' and pg_temp.listed() ->> 'sleepDue' = 'false'
		and pg_temp.listed() -> 'attached' = jsonb_build_array(jsonb_build_object('workerId',v_worker.id,'attachmentToken',current_setting('qorpera_test.token'))),
		'A machine that has just been used is not due to sleep, and lists its attached sessions: '||(pg_temp.listed())::text);
	update public.qorpera_coding_machines set last_used_at = clock_timestamp() - interval '11 minutes' where id = pg_temp.vm();
	perform pg_temp.wake_assert(pg_temp.listed() ->> 'sleepDue' = 'false','A command that used the processor recently keeps the machine awake');
	update public.qorpera_coding_machines set busy_at = clock_timestamp() - interval '11 minutes' where id = pg_temp.vm();
	perform pg_temp.wake_assert(pg_temp.listed() ->> 'sleepDue' = 'true','Ten quiet minutes make the machine due to sleep, a waiting server or not');
	update public.qorpera_coding_machines set last_used_at = clock_timestamp(), busy_at = null where id = pg_temp.vm();
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Yes, keep it.','30000000-0000-4000-8000-000000000702');
	perform pg_temp.path_claims('service_role');
	-- A follow-up waiting in the queue is not admitted yet: the keeper still names the turn before it, closed.
	perform pg_temp.wake_assert(pg_temp.kept(pg_temp.keep(null),'fix-send') #> '{turn}' = jsonb_build_object('sequence',3,
			'turnId',public.qorpera_coding_turn_id(v_worker.id,3),'open',false),
		'A queued follow-up does not move the attachment''s turn');
end $$;

-- 3. The next turn keeps the generation the guest still holds: it reads what earlier turns left running, and may
--    read or cancel an earlier turn's command; it may start only its own. Then the ways an attachment ends besides
--    archive: the guest no longer carries it, the grant was withdrawn, the guest's lease ran out.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn jsonb; v_context jsonb; v_scope jsonb;
	v_attach jsonb; v_command uuid := current_setting('qorpera_test.command3')::uuid; v_other uuid := extensions.gen_random_uuid();
	v_empty jsonb := '{"schema":"qorpera.coding-machine-observation/v1","busy":false,"sessions":[]}'; v_keep jsonb; v_token text;
begin
	-- The sleep of another machine, as the executor recorded it after turn 3, is in the thread and in the next context.
	perform public.qorpera_coding_event(v_worker.id,4,'step','executor',jsonb_build_object('text','The machine went to sleep','reason','SLEEP',
		'stopped',jsonb_build_array(jsonb_build_object('commandId',v_other,'turn',2,'command','npm test -- --watch'))));
	v_turn := pg_temp.next_turn('fix-send');
	perform set_config('qorpera_test.turn4',v_turn::text,false);
	v_attach := pg_temp.attach('fix-send',v_turn,pg_temp.gen(current_setting('qorpera_test.token')));
	perform pg_temp.wake_assert(v_attach ->> 'attachmentToken' = current_setting('qorpera_test.token')
		and (v_attach #>> '{turn,sequence}')::int = 4 and (pg_temp.session_row('fix-send')).attachment_turn = 4,
		'A session standing by keeps its generation into the next turn, which it now names');
	v_context := public.qorpera_read_coding_turn_context(v_turn -> 'binding');
	perform pg_temp.wake_assert(v_context ->> 'schema' = 'qorpera.coding-turn-context/v2'
		and v_context -> 'commands' = jsonb_build_object(
			'running',jsonb_build_array(jsonb_build_object('commandId',v_command,'turn',3,'command','npm run dev')),
			'stopped',jsonb_build_array(jsonb_build_object('commandId',v_other,'turn',2,'command','npm test -- --watch','reason','SLEEP')),
			'omitted',0),
		'The context names the command still running and the one sleep stopped: '||(v_context -> 'commands')::text);
	v_scope := jsonb_build_object('workerId',v_worker.id,'vmId',pg_temp.vm(),'requestId',public.qorpera_coding_turn_id(v_worker.id,4),'turn',4);
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_command(v_turn -> 'binding',v_scope,'read',v_command,null) ->> 'inputSha256' = repeat('a',64)
		and public.qorpera_authorize_coding_command(v_turn -> 'binding',v_scope,'cancel',v_command,null) ->> 'inputSha256' = repeat('a',64),
		'Turn 4 reads and cancels the command turn 3 started');
	begin perform public.qorpera_authorize_coding_command(v_turn -> 'binding',v_scope,'start',v_command,repeat('a',64));
		raise exception 'Turn 4 started a command receipted by turn 3'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_authorize_coding_command(v_turn -> 'binding',v_scope,'read',v_other,null);
		raise exception 'A command without a receipt was read'; exception when insufficient_privilege then null; end;
	perform set_config('qorpera_test.turn4_scope',v_scope::text,false);

	-- The guest does not name the session. Just attached, the observation may predate it: kept. Older: released,
	-- keeping what it last saw running for the record.
	perform pg_temp.wake_assert(pg_temp.kept(pg_temp.keep(v_empty),'fix-send') ->> 'state' = 'kept','A fresh attachment is not judged by an older look');
	update public.qorpera_coding_sessions set attached_at = clock_timestamp() - interval '1 minute' where worker_id = v_worker.id;
	perform pg_temp.wake_assert(pg_temp.kept(pg_temp.keep(v_empty),'fix-send') ->> 'reason' = 'EXPIRED'
		and (pg_temp.session_row('fix-send')).attachment_until <= clock_timestamp()
		and (pg_temp.session_row('fix-send')).running_commands -> 0 ->> 'command' = 'npm run dev',
		'A session the guest no longer carries is released, with what it last ran');
	-- Its next attach takes a new generation, and records what the old one had running as stopped.
	v_attach := pg_temp.attach('fix-send',v_turn,pg_temp.gen(current_setting('qorpera_test.token')));
	perform pg_temp.wake_assert(v_attach ->> 'attachmentToken' <> current_setting('qorpera_test.token')
		and (pg_temp.session_row('fix-send')).running_commands = '[]'::jsonb
		and pg_temp.last_stop() ->> 'reason' = 'EXPIRED' and pg_temp.last_stop() #>> '{stopped,0,command}' = 'npm run dev'
		and pg_temp.last_stop() ->> 'text' = 'The session lost its machine; 1 command was stopped',
		'An ended attachment is never renewed: the next attach starts a new generation and records what stopped');
	v_token := v_attach ->> 'attachmentToken';

	-- A withdrawn repository grant ends the attachment at the keeper's next pass, and stays the reason while it lasts:
	-- the running turn may not attach the session again. Granting it again does not revive the attachment.
	update public.qorpera_coding_repository_grants set enabled = false where environment_id = '30000000-0000-4000-8000-000000000020';
	v_keep := pg_temp.keep(null);
	perform pg_temp.wake_assert(pg_temp.kept(pg_temp.keep(null),'fix-send') ->> 'reason' = 'REPOSITORY_WITHDRAWN'
		and pg_temp.attach('fix-send',v_turn) = '{"state":"refused","reason":"REPOSITORY_WITHDRAWN"}'::jsonb,
		'A lasting reason is never read as an expiry a running turn may attach past');
	update public.qorpera_coding_repository_grants set enabled = true where environment_id = '30000000-0000-4000-8000-000000000020';
	perform pg_temp.wake_assert(pg_temp.kept(v_keep,'fix-send') ->> 'reason' = 'REPOSITORY_WITHDRAWN'
		and pg_temp.kept(pg_temp.keep(null),'fix-send') ->> 'reason' = 'EXPIRED',
		'A withdrawn grant releases the session, and an ended attachment stays ended: '||v_keep::text);
	perform pg_temp.wake_assert(pg_temp.custody('detach',v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid) ->> 'intent' = 'detach','A released session may be detached');

	-- The guest's lease of the live generation ran out (the executor leaves the session out of its observation): the
	-- attachment ends, and its end is told in the thread even when nothing was running.
	v_attach := pg_temp.attach('fix-send',v_turn);
	v_token := v_attach ->> 'attachmentToken';
	perform pg_temp.wake_assert(pg_temp.custody('detach',v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid) ->> 'reason' = 'SESSION_ATTACHED',
		'A live attachment is not taken off');
	update public.qorpera_coding_sessions set attached_at = clock_timestamp() - interval '1 minute' where worker_id = v_worker.id;
	perform pg_temp.wake_assert(pg_temp.kept(pg_temp.keep(v_empty),'fix-send') ->> 'reason' = 'EXPIRED'
		and pg_temp.custody('detach',v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid) ->> 'intent' = 'detach',
		'A session left out of the observation is released, and may be taken off');
	perform pg_temp.wake_assert(public.qorpera_record_coding_session_detached(pg_temp.vm(),'exec-test',pg_temp.binding(),repeat('c',64),v_worker.id,
			v_token::uuid,'EXPIRED','[]') ->> 'state' = 'detached'
		and pg_temp.last_stop() ->> 'text' = 'The session lost its machine' and pg_temp.last_stop() -> 'stopped' = '[]'::jsonb,
		'A lost attachment is told in the thread even when nothing was running');
	-- Attached again for what follows.
	v_attach := pg_temp.attach('fix-send',v_turn);
	perform set_config('qorpera_test.token',v_attach ->> 'attachmentToken',false);
end $$;

-- A receipt of another worker's run is never this session's command.
do $$
declare v_turn jsonb := current_setting('qorpera_test.turn4')::jsonb; v_foreign uuid := extensions.gen_random_uuid();
begin
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,v_foreign,
		'coding_run_command:not-a-session',repeat('a',64),repeat('b',64),false);
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.parent_binding')::jsonb,v_foreign,repeat('a',64),'{}'::jsonb);
	begin perform public.qorpera_authorize_coding_command(v_turn -> 'binding',current_setting('qorpera_test.turn4_scope')::jsonb,'read',v_foreign,null);
		raise exception 'Another run''s command was read'; exception when insufficient_privilege then null; end;
end $$;

-- 4. The owner archives the session mid-turn: the turn is cancelled, the attachment ends now, and the
--    keeper releases it. Detach custody follows; the detach record ends that generation only.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_view jsonb; v_keep jsonb; v_events bigint; v_detached jsonb;
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000002');
	begin perform public.qorpera_archive_coding_session(v_worker.id,'30000000-0000-4000-8000-000000000703');
		raise exception 'Another member archived the owner''s session'; exception when insufficient_privilege then null; end;
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	v_view := public.qorpera_archive_coding_session(v_worker.id,'30000000-0000-4000-8000-000000000703');
	v_events := pg_temp.events('fix-send','step');
	perform public.qorpera_archive_coding_session(v_worker.id,'30000000-0000-4000-8000-000000000704');
	perform pg_temp.wake_assert(v_view ->> 'archivedBy' = 'member' and v_view ->> 'archivedAt' is not null and v_view ->> 'phase' = 'cancelled'
		and v_view ->> 'workerState' = 'cancelled' and not (v_view ->> 'attached')::boolean and pg_temp.events('fix-send','step') = v_events,
		'Archiving cancels the running turn, ends the attachment, and repeats as a no-op: '||v_view::text);
	perform pg_temp.path_claims('service_role');
	v_keep := pg_temp.keep(null);
	perform pg_temp.wake_assert(pg_temp.kept(v_keep,'fix-send') = jsonb_build_object('workerId',v_worker.id,'state','release','reason','ARCHIVED',
		'attachmentToken',current_setting('qorpera_test.token')::uuid),'The keeper releases an archived session: '||v_keep::text);
	perform pg_temp.wake_assert(pg_temp.custody('detach',v_worker.id) ->> 'intent' = 'detach','An archived session may be detached');
	v_detached := public.qorpera_record_coding_session_detached(pg_temp.vm(),'exec-test',pg_temp.binding(),repeat('c',64),v_worker.id,
		extensions.gen_random_uuid(),'ARCHIVED','[]');
	perform pg_temp.wake_assert(v_detached ->> 'state' = 'unchanged' and (pg_temp.session_row('fix-send')).attached_machine_id = pg_temp.vm(),
		'Another generation''s detach changes nothing');
	begin perform public.qorpera_record_coding_session_detached(pg_temp.vm(),'exec-test',pg_temp.binding(),repeat('c',64),v_worker.id,
			current_setting('qorpera_test.token')::uuid,'SOMETHING','[]');
		raise exception 'An unknown detach reason was accepted'; exception when sqlstate '22023' then null; end;
	v_detached := public.qorpera_record_coding_session_detached(pg_temp.vm(),'exec-test',pg_temp.binding(),repeat('c',64),v_worker.id,
		current_setting('qorpera_test.token')::uuid,'ARCHIVED',jsonb_build_array(jsonb_build_object('commandId',current_setting('qorpera_test.command3')::uuid,
			'turn',3,'command','npm run dev')));
	perform pg_temp.wake_assert(v_detached ->> 'state' = 'detached' and (pg_temp.session_row('fix-send')).attached_machine_id is null
		and (pg_temp.session_row('fix-send')).running_commands = '[]'::jsonb
		and (select body ->> 'text' = 'Archived; 1 command was stopped' and body ->> 'reason' = 'ARCHIVED' from public.qorpera_coding_session_events
			where worker_id = v_worker.id and kind = 'step' and actor = 'executor' order by id desc limit 1),
		'The detach record ends the attachment and says what it stopped');
end $$;

-- 5. A machine is removed only once its member has no open session. The owner's answer reopens the
--    archived session; the agent archives it; after a quiet month the executor archives the rest.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_receipt jsonb; v_archived integer; v_view jsonb;
begin
	perform pg_temp.wake_assert(pg_temp.custody('stop') ->> 'intent' = 'stop','The machine with no turn may stop');
	perform public.qorpera_suspend_coding_machine(pg_temp.vm(),'exec-test',pg_temp.binding(),repeat('c',64));
	update public.qorpera_runtime_node_demands set suspended_at = suspended_at - interval '1 hour' where allocation_id = pg_temp.vm();
	perform pg_temp.wake_assert((pg_temp.view('fix-send') ->> 'machineAsleep')::boolean
		and exists (select 1 from public.qorpera_coding_sessions session join public.qorpera_runtime_workers worker on worker.id = session.worker_id
			where worker.owner_user_id = v_worker.owner_user_id and session.archived_at is null)
		and pg_temp.listed() ->> 'removeDue' = 'false' and pg_temp.custody('delete') ->> 'reason' = 'MACHINE_NOT_DUE',
		'An asleep machine stays while its member has an open session');
	-- The owner reopens the archived session by answering it.
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	v_view := public.qorpera_answer_coding_session(v_worker.id,'Actually, stop it.','30000000-0000-4000-8000-000000000705');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((pg_temp.session_row('fix-send')).archived_at is null and v_view -> 'archivedAt' = 'null'::jsonb
		and v_view ->> 'phase' = 'input_ready'
		and (select body ->> 'text' = 'Reopened' from public.qorpera_coding_session_events where worker_id = v_worker.id and kind = 'step' order by id desc limit 1),
		'A new turn reopens an archived session');
	-- The agent archives it again (queued turn cancelled), with its own tool.
	v_receipt := pg_temp.worker('{"action":"archive","operationKey":"archive-fix-send","todoKey":"composer-latency","workerKey":"fix-send"}');
	perform pg_temp.wake_assert(v_receipt ->> 'action' = 'archive' and v_receipt #>> '{coding,archivedBy}' = 'agent'
		and v_receipt #>> '{worker,state}' = 'cancelled','The agent archives a coding session: '||v_receipt::text);
	perform pg_temp.worker('{"action":"dispatch","operationKey":"standby-notes","todoKey":"composer-latency","workerKey":"standby-notes",
		"title":"Notes","goal":"Summarise the thread.","definitionOfDone":"A summary exists.","access":"read"}');
	begin perform pg_temp.worker('{"action":"archive","operationKey":"archive-in-house","todoKey":"composer-latency","workerKey":"standby-notes"}');
		raise exception 'An in-house worker was archived'; exception when sqlstate '22023' then null; end;
	-- Every other open session of the member is quiet for more than a month; the executor archives them.
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '31 days', busy_at = null where archived_at is null;
	v_archived := public.qorpera_archive_quiet_coding_sessions('exec-test');
	perform pg_temp.wake_assert(v_archived >= 1 and not exists (select 1 from public.qorpera_coding_sessions where archived_at is null)
		and exists (select 1 from public.qorpera_coding_sessions where archived_by = 'kernel'),
		'Quiet sessions are archived by the executor');
	perform pg_temp.wake_assert(pg_temp.listed() ->> 'removeDue' = 'true' and pg_temp.custody('delete') ->> 'intent' = 'delete',
		'With no open session, the asleep machine is removed');
end $$;

-- 6. Only the owner's archive is a member call; the executor's calls are the service role's.
select pg_temp.wake_assert(has_function_privilege('authenticated','public.qorpera_archive_coding_session(uuid,uuid)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_keep_coding_attachments(uuid,text,text,text,jsonb)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_attach_coding_session(uuid,uuid,text,jsonb,text,text)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_archive_quiet_coding_sessions(text)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_record_coding_session_detached(uuid,text,text,text,uuid,uuid,text,jsonb)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_coding_stopped_event(text,jsonb)','EXECUTE')
	and has_function_privilege('service_role','public.qorpera_keep_coding_attachments(uuid,text,text,text,jsonb)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_archive_coding_session(uuid,uuid)','EXECUTE'),
	'Grants: members archive their own sessions; the executor keeps and detaches');
