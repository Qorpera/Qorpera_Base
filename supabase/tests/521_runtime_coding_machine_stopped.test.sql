-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- 20260930431000: a member's coding machine stopped from outside (5g-1b, deploy/coding-worker/README.md "Machines stopped
-- from outside"). Only the executor that planned the machine records the stop, with its exact custody. Every session
-- attached to the machine is detached and gets one MACHINE_STOPPED event ("The machine stopped"), naming the commands
-- last seen running there, commands or not; the next turn's context lists those commands as stopped for that reason.
-- A session on another machine is not touched, and a second record of the same stop changes nothing. 928's helpers on
-- 924's base: Alice's run, three of its coding sessions (cancelled, so their first turn ended), b1 and b2 attached to
-- the owner's machine d1 on exec-521, b3 to a second machine d2.

do $$
declare v_alice jsonb := pg_temp.c3_alice();
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-521', true, array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	for i in 1 .. 3 loop
		perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'ms-dispatch-' || i,
			'agents/alice/todos/fix-login/session-' || chr(96 + i), pg_temp.c3_brief(('52100000-0000-4000-8000-0000000000b' || i)::uuid,
				p_title => case i when 1 then 'Fix the login page' when 2 then 'Fix the logout page' else 'Fix the signup page' end))
			-> 'units' -> 0 ->> 'outcome' = 'saved', 'dispatch ' || i);
		perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder',
			'agents/alice/todos/fix-login/session-' || chr(96 + i), 'operationKey', 'ms-cancel-' || i));
		perform pg_temp.base_assert((select settled_at from public.qorpera_coding_session_turns
			where worker_id = ('52100000-0000-4000-8000-0000000000b' || i)::uuid and sequence = 1) is not null, 'turn 1 ended: ' || i);
	end loop;
	-- The owner's two machines on exec-521, each pinned to its binding text as the first run authority pins it.
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
		instance_sha256)
	select ('52100000-0000-4000-8000-0000000000d' || n)::uuid, 'member', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-521', repeat('7', 64), binding::jsonb,
		encode(extensions.digest(convert_to(binding, 'utf8'), 'sha256'), 'hex')
	from (values (1, '{}'), (2, '{"number":2}')) v(n, binding);
	set local session_replication_role = origin;
end $$;

-- A session attached to p_machine, its commands last seen running p_running; answers its attachment token.
create function pg_temp.ms_attach(p_worker uuid, p_machine uuid, p_running jsonb) returns uuid language plpgsql as $$
declare v_token uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set attached_machine_id = p_machine, attachment_token = v_token,
		attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = (select w.sequence from public.qorpera_runtime_workers w where w.id = p_worker),
		attached_at = clock_timestamp(), observed_at = clock_timestamp(), running_commands = p_running
	where worker_id = p_worker;
	set local session_replication_role = origin;
	return v_token;
end $$;
-- The executor's record of p_machine stopped from outside, under p_role's claims and with this custody.
create function pg_temp.ms_stopped(p_machine uuid, p_owner text default 'exec-521', p_binding text default '{}',
	p_sha256 text default repeat('7', 64), p_role text default 'service_role') returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims(p_role, case p_role when 'authenticated' then '92400000-0000-4000-8000-000000000001'::uuid end);
	return public.qorpera_record_coding_machine_stopped(p_machine, p_owner, p_binding, p_sha256);
end $$;
-- The executor's step events in a session's thread, oldest first.
create function pg_temp.ms_events(p_worker uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('sequence', e.sequence, 'body', e.body) order by e.id), '[]'::jsonb)
	from public.qorpera_coding_session_events e where e.worker_id = p_worker and e.kind = 'step' and e.actor = 'executor'
$$;
-- Whether a session is attached nowhere and runs nothing, as a detach leaves it.
create function pg_temp.ms_detached(p_worker uuid) returns boolean language sql as $$
	select s.attached_machine_id is null and s.attachment_token is null and s.attachment_until is null and s.attachment_turn is null
		and s.attached_at is null and s.running_commands = '[]'::jsonb
	from public.qorpera_coding_sessions s where s.worker_id = p_worker
$$;

do $$
begin
	perform set_config('qorpera_test.ms_b1', pg_temp.ms_attach('52100000-0000-4000-8000-0000000000b1', '52100000-0000-4000-8000-0000000000d1',
		'[{"commandId":"52100000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"},
		  {"commandId":"52100000-0000-4000-8000-0000000000c2","turn":1,"command":"npm test -- --watch"}]')::text, true);
	perform set_config('qorpera_test.ms_b2', pg_temp.ms_attach('52100000-0000-4000-8000-0000000000b2', '52100000-0000-4000-8000-0000000000d1',
		'[]')::text, true);
	perform set_config('qorpera_test.ms_b3', pg_temp.ms_attach('52100000-0000-4000-8000-0000000000b3', '52100000-0000-4000-8000-0000000000d2',
		'[{"commandId":"52100000-0000-4000-8000-0000000000c3","turn":1,"command":"npm run build"}]')::text, true);
end $$;

-- 1. The refusals: only the service role, only with the machine's exact custody; nothing changes -----------------------
select pg_temp.base_error(format('select pg_temp.ms_stopped(%L, p_role => %L)', '52100000-0000-4000-8000-0000000000d1', r.role),
	'42501', 'Coding machine custody required')
from unnest(array['anon', 'authenticated']) r(role);
select pg_temp.base_error(format('select pg_temp.ms_stopped(%s, %L, %L, %L)', v.machine, v.owner, v.binding, v.sha256), '42501', v.message)
from (values
	('null', 'exec-521', '{}', repeat('7', 64), 'Coding machine custody required'),
	(quote_literal('52100000-0000-4000-8000-0000000000d1'), 'exec 521', '{}', repeat('7', 64), 'Coding machine custody required'),
	(quote_literal('52100000-0000-4000-8000-0000000000d1'), 'exec-521', '{}', 'nope', 'Coding machine custody required'),
	(quote_literal('52100000-0000-4000-8000-0000000000d1'), 'exec-521', '', repeat('7', 64), 'Coding machine custody required'),
	-- An unknown machine, another executor's, another machine id's, another binding, the same binding as other text.
	(quote_literal('52100000-0000-4000-8000-0000000000d9'), 'exec-521', '{}', repeat('7', 64), 'Coding machine custody differs'),
	(quote_literal('52100000-0000-4000-8000-0000000000d1'), 'exec-other', '{}', repeat('7', 64), 'Coding machine custody differs'),
	(quote_literal('52100000-0000-4000-8000-0000000000d1'), 'exec-521', '{}', repeat('8', 64), 'Coding machine custody differs'),
	(quote_literal('52100000-0000-4000-8000-0000000000d1'), 'exec-521', '{"number":2}', repeat('7', 64), 'Coding machine custody differs'),
	(quote_literal('52100000-0000-4000-8000-0000000000d1'), 'exec-521', '{ }', repeat('7', 64), 'Coding machine custody differs')
) v(machine, owner, binding, sha256, message);
-- A removed machine (undone after).
do $$
begin
	begin
		set local session_replication_role = replica;
		update public.qorpera_coding_machines set removing_at = clock_timestamp(), removed_at = clock_timestamp()
		where id = '52100000-0000-4000-8000-0000000000d1';
		set local session_replication_role = origin;
		perform pg_temp.base_error($q$select pg_temp.ms_stopped('52100000-0000-4000-8000-0000000000d1')$q$, '42501',
			'Coding machine custody differs');
		raise exception 'Undone' using errcode = 'QB521';
	exception when sqlstate 'QB521' then null;
	end;
end $$;
select pg_temp.base_assert(not pg_temp.ms_detached(w.id) and pg_temp.ms_events(w.id) = '[]'::jsonb, 'nothing changed: ' || w.id)
from unnest(array['52100000-0000-4000-8000-0000000000b1', '52100000-0000-4000-8000-0000000000b2',
	'52100000-0000-4000-8000-0000000000b3']::uuid[]) w(id);

-- 2. The stop: every session on d1 is detached, each with one MACHINE_STOPPED event; d2's session is not touched -------
do $$
declare v_result jsonb; b1 public.qorpera_runtime_workers := pg_temp.c3_worker('52100000-0000-4000-8000-0000000000b1');
	b2 public.qorpera_runtime_workers := pg_temp.c3_worker('52100000-0000-4000-8000-0000000000b2');
	v_before timestamptz := clock_timestamp();
begin
	v_result := pg_temp.ms_stopped('52100000-0000-4000-8000-0000000000d1');
	perform pg_temp.base_assert(v_result = jsonb_build_object('schema', 'qorpera.coding-machine-stopped/v1',
		'machineId', '52100000-0000-4000-8000-0000000000d1', 'detached', jsonb_build_array(
			jsonb_build_object('workerId', b1.id, 'attachmentToken', current_setting('qorpera_test.ms_b1')),
			jsonb_build_object('workerId', b2.id, 'attachmentToken', current_setting('qorpera_test.ms_b2')))),
		'the answer names each attachment it ended: ' || v_result::text);
	perform pg_temp.base_assert(pg_temp.ms_detached(b1.id) and pg_temp.ms_detached(b2.id)
		and (pg_temp.c3_session(b1.id)).observed_at >= v_before and (pg_temp.c3_session(b2.id)).observed_at >= v_before,
		'both detached: ' || to_jsonb(pg_temp.c3_session(b1.id))::text);
	perform pg_temp.base_assert(pg_temp.ms_events(b1.id) = jsonb_build_array(jsonb_build_object('sequence', b1.sequence,
		'body', jsonb_build_object('text', 'The machine stopped; 2 commands were stopped', 'reason', 'MACHINE_STOPPED',
			'stopped', '[{"commandId":"52100000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"},
				{"commandId":"52100000-0000-4000-8000-0000000000c2","turn":1,"command":"npm test -- --watch"}]'::jsonb,
			'moreStopped', 0))),
		'b1''s commands, stopped with its machine: ' || pg_temp.ms_events(b1.id)::text);
	perform pg_temp.base_assert(pg_temp.ms_events(b2.id) = jsonb_build_array(jsonb_build_object('sequence', b2.sequence,
		'body', '{"text":"The machine stopped","reason":"MACHINE_STOPPED","stopped":[],"moreStopped":0}'::jsonb)),
		'b2 is told too, with nothing running: ' || pg_temp.ms_events(b2.id)::text);
	perform pg_temp.base_assert(not pg_temp.ms_detached('52100000-0000-4000-8000-0000000000b3')
		and (pg_temp.c3_session('52100000-0000-4000-8000-0000000000b3')).attached_machine_id = '52100000-0000-4000-8000-0000000000d2'
		and (pg_temp.c3_session('52100000-0000-4000-8000-0000000000b3')).attachment_token = current_setting('qorpera_test.ms_b3')::uuid
		and (pg_temp.c3_session('52100000-0000-4000-8000-0000000000b3')).running_commands
			= '[{"commandId":"52100000-0000-4000-8000-0000000000c3","turn":1,"command":"npm run build"}]'::jsonb
		and pg_temp.ms_events('52100000-0000-4000-8000-0000000000b3') = '[]'::jsonb, 'another machine''s session is not touched');
end $$;

-- 3. The same stop recorded again changes nothing ------------------------------------------------------------------------
select pg_temp.base_assert(pg_temp.ms_stopped('52100000-0000-4000-8000-0000000000d1') = '{"schema":"qorpera.coding-machine-stopped/v1",
	"machineId":"52100000-0000-4000-8000-0000000000d1","detached":[]}'::jsonb
	and jsonb_array_length(pg_temp.ms_events('52100000-0000-4000-8000-0000000000b1')) = 1
	and jsonb_array_length(pg_temp.ms_events('52100000-0000-4000-8000-0000000000b2')) = 1
	and not pg_temp.ms_detached('52100000-0000-4000-8000-0000000000b3'), 'a second record detaches nobody');

-- 4. The reason's words; the others keep theirs ---------------------------------------------------------------------------
select pg_temp.base_assert(public.qorpera_coding_stopped_event(v.reason, v.stopped) ->> 'text' = v.text, 'the words for ' || v.reason)
from (values
	('MACHINE_STOPPED', '[]'::jsonb, 'The machine stopped'),
	('MACHINE_STOPPED', '[{"commandId":"52100000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"}]',
		'The machine stopped; 1 command was stopped'),
	('SLEEP', '[]', 'The machine went to sleep'), ('EXPIRED', '[]', 'The session lost its machine'),
	('EXECUTOR_DISABLED', '[]', 'Coding is not enabled here any more')
) v(reason, stopped, text);

-- 5. b1's next turn reads its commands as stopped with the machine -------------------------------------------------------
do $$
declare v_claim jsonb; v_token uuid; v_pass jsonb; v_turn jsonb; v_context jsonb;
begin
	perform pg_temp.c3_answer('52100000-0000-4000-8000-0000000000b1', 'Start the dev server again.');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-521', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '52100000-0000-4000-8000-0000000000b1', 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session('52100000-0000-4000-8000-0000000000b1')).lease_token;
	perform public.qorpera_begin_coding_turn('52100000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	update public.qorpera_coding_sessions set vm_allocation_id = '52100000-0000-4000-8000-0000000000d1'
	where worker_id = '52100000-0000-4000-8000-0000000000b1';
	v_context := public.qorpera_read_coding_turn_context(v_turn);
	perform pg_temp.base_assert(v_context ->> 'sequence' = '2' and v_context -> 'commands' = jsonb_build_object('running', '[]'::jsonb,
		'stopped', '[{"commandId":"52100000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev","reason":"MACHINE_STOPPED"},
			{"commandId":"52100000-0000-4000-8000-0000000000c2","turn":1,"command":"npm test -- --watch","reason":"MACHINE_STOPPED"}]'::jsonb,
		'omitted', 0), 'the next turn''s commands: ' || (v_context -> 'commands')::text);
end $$;

-- 6. Grants and markers ---------------------------------------------------------------------------------------------------
select pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_record_coding_machine_stopped(uuid,text,text,text)', 'execute')
	and not exists (select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) r(role)
		where has_function_privilege(r.role, 'public.qorpera_record_coding_machine_stopped(uuid,text,text,text)', 'execute'))
	and not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
		where has_function_privilege(r.role, 'public.qorpera_coding_stopped_event(text,jsonb)', 'execute')),
	'only the executor records a stop; the words stay internal');
select pg_temp.base_assert(not exists (select 1 from unnest(array['public.qorpera_record_coding_machine_stopped(uuid,text,text,text)',
		'public.qorpera_coding_stopped_event(text,jsonb)']) f(name)
	where position('20260930431000' in pg_get_functiondef(f.name::regprocedure)) = 0), 'each new or replaced function names this migration');

rollback;
