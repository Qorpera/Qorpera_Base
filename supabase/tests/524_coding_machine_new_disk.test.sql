-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- A coding machine that gets a new disk (20260930505000; F3 step 5g-5, part 3: deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md
-- rule 4b, "A new disk"). The executor marks a machine for a new disk; both marks are set, and the restart's mark does
-- what it did: no coding view opens, a renewal closes one. The rebuild's custody is granted only for a machine marked for
-- a new disk, under a leased turn too, and changes nothing. A start's record on such a machine detaches every session
-- attached there, each with one MACHINE_NEW_DISK event, keeps both marks and answers 'new-disk'. The rebuild's record
-- empties the machine's read set, detaches any session still attached, clears both marks and answers 'replaced'; a
-- second record of the rebuild answers what the first did and changes nothing. The take-in that marks a machine is in
-- 485 (I) and 486 (9); 523 covers the plain restart. The office, the folders and the helpers are 639's.

-- 0. Markers and privileges: each patched, replaced or new function names this migration and keeps the earlier
-- markers; the executor (service_role) marks and records, the words stay internal, and the take-in's callers' owners
-- may set both marks.
do $$
declare v_lost text;
begin
	select string_agg(f.sig || ' ' || m.marker, ', ') into v_lost
	from (values
		('qorpera_folder_read_wake(jsonb)', array['20260930445000', '20260930500000']),
		('qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)', array['20260930445000']),
		('qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)', array['20260930501000']),
		('qorpera_coding_stopped_event(text,jsonb)', array['20260930431000', '20260930501000']),
		('qorpera_mark_coding_machine_new_disk(uuid,text,text,text)', array[]::text[]),
		('qorpera_record_coding_machine_folder_restart(uuid,uuid,text,text,text)', array['20260930501000']),
		('qorpera_record_coding_machine_new_disk(uuid,uuid,text,text,text)', array[]::text[])) f(sig, earlier)
	cross join lateral unnest(f.earlier || '20260930505000'::text) m(marker)
	where strpos(pg_get_functiondef(('public.' || f.sig)::regprocedure), m.marker) = 0;
	if v_lost is not null then raise exception 'Lost a marker: %', v_lost; end if;
	if exists (select 1 from unnest(array['public.qorpera_mark_coding_machine_new_disk(uuid,text,text,text)',
			'public.qorpera_record_coding_machine_folder_restart(uuid,uuid,text,text,text)',
			'public.qorpera_record_coding_machine_new_disk(uuid,uuid,text,text,text)']) f(name)
		where not has_function_privilege('service_role', f.name, 'execute')
			or exists (select 1 from unnest(array['anon', 'authenticated', 'qorpera_secret_broker']) r(role)
				where has_function_privilege(r.role, f.name, 'execute')))
		or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) r(role)
			where has_function_privilege(r.role, 'public.qorpera_coding_stopped_event(text,jsonb)', 'execute')) then
		raise exception 'Only the executor marks and records; the words stay internal'; end if;
	if exists (select 1 from pg_proc p cross join unnest(array['new_disk_at', 'folder_restart_at']) c(name)
		where p.oid in ('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
			'public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)'::regprocedure)
			and not has_column_privilege(p.proowner, 'public.qorpera_coding_machines', c.name, 'update')) then
		raise exception 'The take-in''s callers mark their machine'; end if;
	if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) r(role)
			where has_column_privilege(r.role, 'public.qorpera_coding_machines', 'new_disk_at', 'update')) then
		raise exception 'No API role sets the mark'; end if;
end $$;

-- The node, the executor exec-1 and agent A's repository grant.
do $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
		headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
	values ('52400000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-524', 'UTF8')), 'hex'), 'node-524', 1, 16000,
		68719476736, 1000, 4294967296, 4000, 8589934592, true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled)
	values ('63200000-0000-4000-8000-000000000020', 'exec-1', true) on conflict do nothing;
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true) on conflict do nothing;
	set local session_replication_role = origin;
end $$;

-- The node's machine id, and a machine's exact binding text.
create function pg_temp.nd_node() returns text language sql as $$
	select encode(sha256(convert_to('node-524', 'UTF8')), 'hex')
$$;
create function pg_temp.nd_binding(p_machine uuid) returns text language sql as $$
	select jsonb_build_object('machineId', p_machine, 'providerPolicySha256', repeat('d', 64))::text
$$;
-- A member machine of exec-1 on the node, pinned to its binding text, with its allocation and reserved demand (523's).
create function pg_temp.nd_machine() returns uuid language plpgsql as $$
declare cm uuid := extensions.gen_random_uuid(); v_instance text;
begin
	v_instance := encode(extensions.digest(convert_to(pg_temp.nd_binding(cm), 'utf8'), 'sha256'), 'hex');
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
		instance_sha256)
	values (cm, 'member', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-000000000002', 'exec-1', pg_temp.nd_node(), pg_temp.nd_binding(cm)::jsonb, v_instance);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (cm, '63200000-0000-4000-8000-000000000010', 'lxd', v_instance, cm, clock_timestamp());
	insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
		memory_bytes, reserved_at)
	values (cm, '52400000-0000-4000-8000-0000000000e1', 'coding', 'lxd', repeat('d', 64), 2000, 4294967296, clock_timestamp());
	set local session_replication_role = origin;
	return cm;
end $$;
-- A coding session of agent A attached to p_machine, its commands last seen running p_running (523's); answers its
-- view anchor.
create function pg_temp.nd_session(p_machine uuid, p_running jsonb default '[]') returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
	tok uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), 'w-524-' || w, 'coding', 'Code', 'read', 'each', '{}', '63200000-0000-4000-8000-000000000002',
		(p ->> 'runId')::uuid, '63200000-0000-4000-8000-000000000002', '63200000-0000-4000-8000-0000000000b1', 1);
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
		attachment_token, attachment_until, attachment_turn, attached_at, running_commands)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', 'claude-code',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/524-' || w, p_machine, tok,
		clock_timestamp() + interval '10 minutes', 1, clock_timestamp(), p_running);
	set local session_replication_role = origin;
	return jsonb_build_object('workerId', w, 'attachmentToken', tok);
end $$;
-- A session attached to p_machine anew, under p_token.
create function pg_temp.nd_attach(p_session jsonb, p_machine uuid, p_token uuid) returns jsonb language plpgsql as $$
begin
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set attached_machine_id = %L, attachment_token = %L,
		attachment_until = clock_timestamp() + interval %L, attachment_turn = 2, attached_at = clock_timestamp() where worker_id = %L',
		p_machine, p_token, '10 minutes', p_session ->> 'workerId'));
	return jsonb_build_object('workerId', p_session ->> 'workerId', 'attachmentToken', p_token);
end $$;
-- A session's coding view, with its anchor.
create function pg_temp.nd_view(p_session jsonb) returns jsonb language sql as $$
	select pg_temp.open('coding_session', p_session) || p_session
$$;
create function pg_temp.nd_renew(p_view jsonb, p_service uuid) returns jsonb language sql as $$
	select public.qorpera_folder_view_renew((p_view ->> 'viewId')::uuid, p_view ->> 'pass', null, p_service)
$$;
create function pg_temp.nd_new_disk_at(p_machine uuid) returns timestamptz language sql as $$
	select new_disk_at from public.qorpera_coding_machines where id = p_machine
$$;
create function pg_temp.nd_restart_at(p_machine uuid) returns timestamptz language sql as $$
	select folder_restart_at from public.qorpera_coding_machines where id = p_machine
$$;
-- The executor's mark or record (p_rpc) of p_machine under p_role's claims, with this custody (the machine's own unless
-- given); a record names the start or rebuild p_operation.
create function pg_temp.nd_call(p_rpc text, p_machine uuid, p_role text default 'service_role', p_owner text default 'exec-1',
	p_binding text default null, p_sha256 text default null, p_operation uuid default '52400000-0000-4000-8000-0000000000f1')
	returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
	execute format(case when p_rpc like 'qorpera_record_%' then 'select public.%I($1, $5, $2, $3, $4)'
		else 'select public.%I($1, $2, $3, $4)' end, p_rpc) into v_result
	using p_machine, p_owner, coalesce(p_binding, pg_temp.nd_binding(p_machine)), coalesce(p_sha256, pg_temp.nd_node()), p_operation;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return v_result;
end $$;
create function pg_temp.nd_custody(p_machine uuid, p_intent text, p_worker uuid default null) returns jsonb language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return public.qorpera_authorize_coding_machine_custody(p_machine, 'exec-1', pg_temp.nd_binding(p_machine), pg_temp.nd_node(), p_intent,
		p_worker);
end $$;
-- The custody's receipt for p_machine and p_intent.
create function pg_temp.nd_receipt(p_machine uuid, p_intent text) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.coding-machine-admission/v1', 'machineId', p_machine, 'workerId', null,
		'instanceSha256', encode(extensions.digest(convert_to(pg_temp.nd_binding(p_machine), 'utf8'), 'sha256'), 'hex'), 'intent', p_intent,
		'guestUid', null, 'validForMs', 5000, 'nodeId', '52400000-0000-4000-8000-0000000000e1', 'nodeVersion', 1)
$$;
-- Runs p_sql, which must fail with p_state and p_message; answers the error's detail (523's).
create function pg_temp.nd_refused(p_sql text, p_state text, p_message text) returns text language plpgsql as $$
declare v_state text; v_message text; v_detail text;
begin
	begin
		execute p_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
	end;
	if v_state is distinct from p_state or v_message is distinct from p_message then
		raise exception 'Expected % (%) from %, got % (%)', p_state, p_message, p_sql, v_state, v_message; end if;
	return v_detail;
end $$;
-- The executor's step events in a session's thread, oldest first (521's).
create function pg_temp.nd_events(p_worker uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('sequence', e.sequence, 'body', e.body) order by e.id), '[]'::jsonb)
	from public.qorpera_coding_session_events e where e.worker_id = p_worker and e.kind = 'step' and e.actor = 'executor'
$$;
-- Whether a session is attached nowhere and runs nothing, as a detach leaves it (521's).
create function pg_temp.nd_detached(p_worker uuid) returns boolean language sql as $$
	select s.attached_machine_id is null and s.attachment_token is null and s.attachment_until is null and s.attachment_turn is null
		and s.attached_at is null and s.running_commands = '[]'::jsonb
	from public.qorpera_coding_sessions s where s.worker_id = p_worker
$$;
-- The sessions attached to p_machine, as a record names them.
create function pg_temp.nd_attached(p_machine uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('workerId', worker_id, 'attachmentToken', attachment_token) order by worker_id), '[]'::jsonb)
	from public.qorpera_coding_sessions where attached_machine_id = p_machine
$$;
-- A machine's read set: its pairs and its records.
create function pg_temp.nd_reads(p_machine uuid) returns bigint language sql as $$
	select (select count(*) from public.qorpera_coding_machine_reads where coding_machine_id = p_machine)
		+ (select count(*) from public.qorpera_coding_machine_read_records where coding_machine_id = p_machine)
$$;
-- A value kept for the later steps, until the rollback.
create function pg_temp.nd_put(p_name text, p_value text) returns void language plpgsql as $$
begin
	perform set_config('qorpera_test.nd_' || p_name, p_value, true);
end $$;
create function pg_temp.nd_get(p_name text) returns text language sql as $$
	select current_setting('qorpera_test.nd_' || p_name)
$$;
-- A view's or session's anchor.
create function pg_temp.nd_anchor(p jsonb) returns jsonb language sql as $$
	select jsonb_build_object('workerId', p ->> 'workerId', 'attachmentToken', p ->> 'attachmentToken')
$$;

-- 1. The executor's mark: only the service role, with the machine's exact custody. It sets both marks; marking again
-- keeps the first ones, and a machine marked only to restart keeps that mark and gains the new disk's. The new disk's
-- mark never stands alone.
do $$
declare cm1 uuid := pg_temp.nd_machine(); cm2 uuid := pg_temp.nd_machine(); cm3 uuid := pg_temp.nd_machine(); r jsonb;
	v_new timestamptz; v_restart timestamptz;
begin
	perform pg_temp.nd_refused(format('select pg_temp.nd_call(%L, %L, p_role => %L)', 'qorpera_mark_coding_machine_new_disk', cm1,
		x.role), '42501', 'Coding machine custody required') from unnest(array['anon', 'authenticated']) x(role);
	perform pg_temp.nd_refused(format('select pg_temp.nd_call(%L, %L, p_owner => %L, p_binding => %L, p_sha256 => %L)',
		'qorpera_mark_coding_machine_new_disk', x.machine, x.owner, x.binding, x.sha256), '42501', 'Coding machine custody differs')
	from (values
		-- An unknown machine, another executor's, another node's, another binding, the same binding as other text.
		(extensions.gen_random_uuid(), 'exec-1', pg_temp.nd_binding(cm1), null),
		(cm1, 'exec-2', null, null),
		(cm1, 'exec-1', null, repeat('8', 64)),
		(cm1, 'exec-1', pg_temp.nd_binding(extensions.gen_random_uuid()), null),
		(cm1, 'exec-1', jsonb_pretty(pg_temp.nd_binding(cm1)::jsonb), null)) x(machine, owner, binding, sha256);
	if pg_temp.nd_new_disk_at(cm1) is not null or pg_temp.nd_restart_at(cm1) is not null then
		raise exception 'A refused mark marks nothing'; end if;
	r := pg_temp.nd_call('qorpera_mark_coding_machine_new_disk', cm1);
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm1, 'state', 'marked')
		or pg_temp.nd_new_disk_at(cm1) is null or pg_temp.nd_restart_at(cm1) is null then
		raise exception 'The mark sets both: %', r; end if;
	v_new := pg_temp.nd_new_disk_at(cm1); v_restart := pg_temp.nd_restart_at(cm1);
	if pg_temp.nd_call('qorpera_mark_coding_machine_new_disk', cm1) ->> 'state' is distinct from 'marked'
		or pg_temp.nd_new_disk_at(cm1) is distinct from v_new or pg_temp.nd_restart_at(cm1) is distinct from v_restart then
		raise exception 'Marking again keeps the first marks'; end if;
	if pg_temp.nd_new_disk_at(cm2) is not null or pg_temp.nd_restart_at(cm2) is not null then raise exception 'Only cm1 is marked'; end if;
	-- Marked only to restart, then for a new disk.
	perform pg_temp.nd_call('qorpera_mark_coding_machine_folder_restart', cm2);
	v_restart := pg_temp.nd_restart_at(cm2);
	if v_restart is null or pg_temp.nd_new_disk_at(cm2) is not null then raise exception 'cm2 is marked to restart only'; end if;
	perform pg_temp.nd_call('qorpera_mark_coding_machine_new_disk', cm2);
	if pg_temp.nd_restart_at(cm2) is distinct from v_restart or pg_temp.nd_new_disk_at(cm2) is null then
		raise exception 'A machine marked to restart keeps that mark and gains the new disk''s'; end if;
	-- Alone, the new disk's mark is refused: set on an unmarked machine, or kept while the restart's is cleared.
	perform pg_temp.nd_refused(x.sql, '23514',
		'new row for relation "qorpera_coding_machines" violates check constraint "qorpera_coding_machines_new_disk_restarts"')
	from (values (format('update public.qorpera_coding_machines set new_disk_at = clock_timestamp() where id = %L', cm3)),
		(format('update public.qorpera_coding_machines set folder_restart_at = null where id = %L', cm1))) x(sql);
	if pg_temp.nd_new_disk_at(cm3) is not null or pg_temp.nd_restart_at(cm1) is null then
		raise exception 'A refused update changes nothing'; end if;
end $$;

-- 2. A machine marked for a new disk opens no coding view, and its open one (a) closes ('ended') at its next renewal:
-- not for a session with no view (e), nor for a, with the restart's code.
do $$
declare cm uuid := pg_temp.nd_machine(); a jsonb := pg_temp.nd_view(pg_temp.nd_session(cm)); e jsonb := pg_temp.nd_session(cm);
	s uuid := extensions.gen_random_uuid(); r jsonb; v_session jsonb;
begin
	if pg_temp.nd_renew(a, s) ->> 'state' is distinct from 'open' then raise exception 'a opens'; end if;
	perform pg_temp.nd_call('qorpera_mark_coding_machine_new_disk', cm);
	r := pg_temp.nd_renew(a, s);
	if r is distinct from '{"schema":"qorpera.folder-view-renew/v1","state":"closed","reason":"ended"}'::jsonb then
		raise exception 'A view on a machine marked for a new disk closes at its renewal: %', r; end if;
	foreach v_session in array array[e, a] loop
		if pg_temp.nd_refused(format('select pg_temp.open(%L, %L)', 'coding_session', pg_temp.nd_anchor(v_session)),
				'42501', 'Coding machine must restart first') is distinct from 'qorpera.coding-machine/folder-restart' then
			raise exception 'The refusal''s detail: %', v_session; end if;
	end loop;
	if exists (select 1 from public.qorpera_folder_views where worker_id = (e ->> 'workerId')::uuid) then
		raise exception 'A refused open opens nothing'; end if;
	perform pg_temp.nd_put('cm', cm::text); perform pg_temp.nd_put('e', e::text);
end $$;

-- 3. Rebuild custody: only for a machine marked for a new disk (cm, and the idle cm6 once so marked), under a leased
-- turn too (l on cm), and it changes nothing on the machine. An unmarked machine or one marked only to restart is
-- refused (MACHINE_NO_NEW_DISK idle, MACHINE_IN_USE under a leased turn, l5 on cm5); a marked one is not removed under
-- the turn, and a rebuild names no session.
do $$
declare cm uuid := pg_temp.nd_get('cm')::uuid; cm5 uuid := pg_temp.nd_machine(); cm6 uuid := pg_temp.nd_machine();
	l jsonb := pg_temp.nd_session(cm, '[{"commandId":"52400000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"}]');
	l5 jsonb := pg_temp.nd_session(cm5); r jsonb; v_before jsonb;
begin
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set phase = %L, lease_owner = %L,
		lease_token = extensions.gen_random_uuid(), lease_until = clock_timestamp() + interval %L, started_at = clock_timestamp(),
		vm_allocation_id = attached_machine_id where worker_id in (%L, %L)', 'preparing', 'exec-1', '5 minutes', l ->> 'workerId',
		l5 ->> 'workerId'));
	-- Idle: unmarked, then marked only to restart, then for a new disk.
	r := pg_temp.nd_custody(cm6, 'rebuild');
	if r is distinct from '{"state":"refused","reason":"MACHINE_NO_NEW_DISK"}'::jsonb then raise exception 'An unmarked machine: %', r; end if;
	perform pg_temp.nd_call('qorpera_mark_coding_machine_folder_restart', cm6);
	r := pg_temp.nd_custody(cm6, 'rebuild');
	if r is distinct from '{"state":"refused","reason":"MACHINE_NO_NEW_DISK"}'::jsonb then
		raise exception 'A machine marked only to restart: %', r; end if;
	perform pg_temp.nd_call('qorpera_mark_coding_machine_new_disk', cm6);
	r := pg_temp.nd_custody(cm6, 'rebuild');
	if r is distinct from pg_temp.nd_receipt(cm6, 'rebuild') then raise exception 'An idle machine marked for a new disk: %', r; end if;
	-- Under a leased turn: unmarked, then marked only to restart.
	r := pg_temp.nd_custody(cm5, 'rebuild');
	if r is distinct from '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb then raise exception 'An unmarked machine in use: %', r; end if;
	perform pg_temp.nd_call('qorpera_mark_coding_machine_folder_restart', cm5);
	r := pg_temp.nd_custody(cm5, 'rebuild');
	if r is distinct from '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb then
		raise exception 'A machine in use marked only to restart: %', r; end if;
	-- Marked for a new disk, under l's turn: granted, and nothing on the machine changes.
	select to_jsonb(m) into v_before from public.qorpera_coding_machines m where id = cm;
	r := pg_temp.nd_custody(cm, 'rebuild');
	if r is distinct from pg_temp.nd_receipt(cm, 'rebuild')
		or (select to_jsonb(m) from public.qorpera_coding_machines m where id = cm) is distinct from v_before then
		raise exception 'A machine marked for a new disk is rebuilt under a leased turn, and nothing changes: %', r; end if;
	r := pg_temp.nd_custody(cm, 'delete');
	if r is distinct from '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb then raise exception 'Its removal waits: %', r; end if;
	perform pg_temp.nd_refused(format('select pg_temp.nd_custody(%L, %L, %L)', cm, 'rebuild', l ->> 'workerId'), '22023',
		'Coding machine custody input invalid');
	perform pg_temp.nd_put('l', l::text);
end $$;

-- 4. The record of start f1 on cm, marked for a new disk: every session attached (a, e and the leased l) is detached,
-- each with one MACHINE_NEW_DISK event naming its commands; both marks stay, so the rebuild's custody is still granted,
-- and it is not an outside stop. Again for f1, it answers what it did and changes nothing.
do $$
declare cm uuid := pg_temp.nd_get('cm')::uuid; l jsonb := pg_temp.nd_get('l')::jsonb; v_expected jsonb := pg_temp.nd_attached(cm);
	r jsonb; v_worker jsonb; v_new timestamptz := pg_temp.nd_new_disk_at(cm); v_restart timestamptz := pg_temp.nd_restart_at(cm);
begin
	if jsonb_array_length(v_expected) <> 3 or v_new is null or v_restart is null then
		raise exception 'Three sessions on the marked machine: %', v_expected; end if;
	r := pg_temp.nd_call('qorpera_record_coding_machine_folder_restart', cm);
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm, 'state', 'new-disk',
			'detached', v_expected) then
		raise exception 'The record names each attachment it ended: % (expected %)', r, v_expected; end if;
	for v_worker in select value from jsonb_array_elements(v_expected) loop
		if not pg_temp.nd_detached((v_worker ->> 'workerId')::uuid) then raise exception 'Detached: %', v_worker; end if;
		if pg_temp.nd_events((v_worker ->> 'workerId')::uuid) is distinct from jsonb_build_array(jsonb_build_object('sequence', 1,
				'body', case when v_worker ->> 'workerId' = l ->> 'workerId' then jsonb_build_object(
					'text', 'The machine got a new disk; only the company folder was kept; 1 command was stopped', 'reason', 'MACHINE_NEW_DISK',
					'stopped', '[{"commandId":"52400000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"}]'::jsonb,
					'moreStopped', 0)
				else '{"text":"The machine got a new disk; only the company folder was kept","reason":"MACHINE_NEW_DISK","stopped":[],"moreStopped":0}'::jsonb
				end)) then
			raise exception 'Each is told once: % %', v_worker, pg_temp.nd_events((v_worker ->> 'workerId')::uuid); end if;
	end loop;
	if not exists (select 1 from public.qorpera_coding_sessions where worker_id = (l ->> 'workerId')::uuid and phase = 'preparing'
			and lease_token is not null and vm_allocation_id = cm) then
		raise exception 'The leased turn keeps its lease'; end if;
	if pg_temp.nd_new_disk_at(cm) is distinct from v_new or pg_temp.nd_restart_at(cm) is distinct from v_restart
		or exists (select 1 from public.qorpera_coding_machine_outside_stops where machine_id = cm) then
		raise exception 'Both marks stay, and it is not an outside stop'; end if;
	if pg_temp.nd_custody(cm, 'rebuild') is distinct from pg_temp.nd_receipt(cm, 'rebuild') then
		raise exception 'The rebuild is still granted'; end if;
	r := pg_temp.nd_call('qorpera_record_coding_machine_folder_restart', cm);
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm, 'state', 'new-disk',
			'detached', v_expected)
		or exists (select 1 from jsonb_array_elements(v_expected) x
			where jsonb_array_length(pg_temp.nd_events((x.value ->> 'workerId')::uuid)) <> 1)
		or pg_temp.nd_new_disk_at(cm) is distinct from v_new or pg_temp.nd_restart_at(cm) is distinct from v_restart then
		raise exception 'A second record of the start answers the first and changes nothing: %', r; end if;
	perform pg_temp.nd_put('f1', v_expected::text);
end $$;

-- 5. The record of rebuild d1 on cm: only the service role, with the machine's exact custody, and a rebuild named that
-- no start's record used. It empties cm's read set (cm2's stays), detaches k, attached since the start's record, with
-- one MACHINE_NEW_DISK event, and clears both marks; the turn keeps its lease. A session attached anew opens a view.
-- Again for d1, even after a new mark, it answers what it did and changes nothing, and a start's record named by d1
-- answers the same. On a machine not marked (cm2) it gives the new disk all the same.
do $$
declare cm uuid := pg_temp.nd_get('cm')::uuid; cm2 uuid := pg_temp.nd_machine(); l jsonb := pg_temp.nd_get('l')::jsonb;
	k jsonb := pg_temp.nd_session(cm); c jsonb; r jsonb; v_first jsonb; v_at timestamptz; v jsonb;
	d1 uuid := '52400000-0000-4000-8000-0000000000d1'; d2 uuid := '52400000-0000-4000-8000-0000000000d2';
	u1 uuid := '52400000-0000-4000-8000-0000000000f3';
begin
	c := pg_temp.nd_session(cm2);
	-- Each machine's reads, by hand: cm a read with no grant and one with, cm2 one; a record for each.
	insert into public.qorpera_coding_machine_reads(coding_machine_id, environment_id, resource_id, grant_id, resource_revision, grant_revision)
	values (cm, '63200000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), null, 1, null),
		(cm, '63200000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), extensions.gen_random_uuid(), 1, 1),
		(cm2, '63200000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), null, 1, null);
	insert into public.qorpera_coding_machine_read_records(coding_machine_id, release_id, environment_id, resource_id, reads, output_sha256)
	select coding_machine_id, extensions.gen_random_uuid(), environment_id, resource_id, '[]', repeat('3', 64)
	from public.qorpera_coding_machine_reads where coding_machine_id in (cm, cm2);
	if pg_temp.nd_reads(cm) <> 4 or pg_temp.nd_reads(cm2) <> 2 then raise exception 'The read sets'; end if;
	-- Refused: another role, other custody, no rebuild named, a start's record's operation (f1).
	perform pg_temp.nd_refused(format('select pg_temp.nd_call(%L, %L, p_role => %L, p_operation => %L)',
		'qorpera_record_coding_machine_new_disk', cm, x.role, d1), '42501', 'Coding machine custody required')
	from unnest(array['anon', 'authenticated']) x(role);
	perform pg_temp.nd_refused(format('select pg_temp.nd_call(%L, %L, p_owner => %L, p_binding => %L, p_sha256 => %L, p_operation => %L)',
		'qorpera_record_coding_machine_new_disk', x.machine, x.owner, x.binding, x.sha256, d1), '42501', 'Coding machine custody differs')
	from (values
		(extensions.gen_random_uuid(), 'exec-1', pg_temp.nd_binding(cm), null),
		(cm, 'exec-2', null, null),
		(cm, 'exec-1', null, repeat('8', 64)),
		(cm, 'exec-1', jsonb_pretty(pg_temp.nd_binding(cm)::jsonb), null)) x(machine, owner, binding, sha256);
	perform pg_temp.nd_refused(format('select pg_temp.nd_call(%L, %L, p_operation => null)', 'qorpera_record_coding_machine_new_disk', cm),
		'22023', 'Coding machine input invalid');
	perform pg_temp.nd_refused(format('select pg_temp.nd_call(%L, %L)', 'qorpera_record_coding_machine_new_disk', cm), '22023',
		'Coding machine input invalid');
	if exists (select 1 from public.qorpera_coding_machine_folder_restarts where machine_id = cm and operation_id <> '52400000-0000-4000-8000-0000000000f1')
		or pg_temp.nd_reads(cm) <> 4 or pg_temp.nd_new_disk_at(cm) is null or pg_temp.nd_attached(cm) <> jsonb_build_array(k) then
		raise exception 'A refused record keeps and changes nothing'; end if;
	-- d1.
	v_first := pg_temp.nd_call('qorpera_record_coding_machine_new_disk', cm, p_operation => d1);
	if v_first is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm, 'state', 'replaced',
			'detached', jsonb_build_array(k)) then
		raise exception 'The rebuild''s record names the attachment it ended: %', v_first; end if;
	if not pg_temp.nd_detached((k ->> 'workerId')::uuid) or pg_temp.nd_events((k ->> 'workerId')::uuid) is distinct from
			'[{"sequence":1,"body":{"text":"The machine got a new disk; only the company folder was kept","reason":"MACHINE_NEW_DISK","stopped":[],"moreStopped":0}}]'::jsonb then
		raise exception 'k is detached and told once: %', pg_temp.nd_events((k ->> 'workerId')::uuid); end if;
	if exists (select 1 from jsonb_array_elements(pg_temp.nd_get('f1')::jsonb) x
			where jsonb_array_length(pg_temp.nd_events((x.value ->> 'workerId')::uuid)) <> 1) then
		raise exception 'The sessions the start''s record detached are told nothing more'; end if;
	if pg_temp.nd_new_disk_at(cm) is not null or pg_temp.nd_restart_at(cm) is not null then raise exception 'Both marks are cleared'; end if;
	if pg_temp.nd_reads(cm) <> 0 or pg_temp.nd_reads(cm2) <> 2 then raise exception 'cm''s read set goes, cm2''s stays'; end if;
	if not exists (select 1 from public.qorpera_coding_sessions where worker_id = (l ->> 'workerId')::uuid and phase = 'preparing'
			and lease_token is not null and vm_allocation_id = cm) then
		raise exception 'The leased turn keeps its lease'; end if;
	if pg_temp.nd_attached(cm2) <> jsonb_build_array(c) or pg_temp.nd_events((c ->> 'workerId')::uuid) <> '[]'::jsonb
		or pg_temp.nd_new_disk_at(cm2) is not null then
		raise exception 'Another machine is not touched'; end if;
	if pg_temp.nd_custody(cm, 'rebuild') is distinct from '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb then
		raise exception 'No second rebuild without a new mark'; end if;
	-- Attached anew, k opens a view on the new disk, and a service serves it.
	k := pg_temp.nd_attach(k, cm, extensions.gen_random_uuid());
	v := pg_temp.nd_view(k);
	r := pg_temp.nd_renew(v, extensions.gen_random_uuid());
	if r ->> 'state' is distinct from 'open' or r ->> 'codingMachineId' is distinct from cm::text then
		raise exception 'A view opens after the new disk: %', r; end if;
	-- Again for d1, after a new mark; then a start's record named by d1.
	perform pg_temp.nd_call('qorpera_mark_coding_machine_new_disk', cm);
	v_at := pg_temp.nd_new_disk_at(cm);
	r := pg_temp.nd_call('qorpera_record_coding_machine_new_disk', cm, p_operation => d1);
	if r is distinct from v_first or v_at is null or pg_temp.nd_new_disk_at(cm) is distinct from v_at
		or pg_temp.nd_attached(cm) <> jsonb_build_array(k) or jsonb_array_length(pg_temp.nd_events((k ->> 'workerId')::uuid)) <> 1 then
		raise exception 'A second record of the rebuild answers the first and changes nothing: %', r; end if;
	r := pg_temp.nd_call('qorpera_record_coding_machine_folder_restart', cm, p_operation => d1);
	if r is distinct from v_first or pg_temp.nd_new_disk_at(cm) is distinct from v_at or pg_temp.nd_attached(cm) <> jsonb_build_array(k) then
		raise exception 'A start''s record named by the rebuild answers the rebuild''s: %', r; end if;
	if (select jsonb_agg(jsonb_build_object('operationId', operation_id, 'state', state, 'detached', detached) order by operation_id)
			from public.qorpera_coding_machine_folder_restarts where machine_id = cm) is distinct from jsonb_build_array(
			jsonb_build_object('operationId', d1, 'state', 'replaced', 'detached', v_first -> 'detached'),
			jsonb_build_object('operationId', '52400000-0000-4000-8000-0000000000f1', 'state', 'new-disk', 'detached',
				pg_temp.nd_get('f1')::jsonb)) then
		raise exception 'Each record is kept'; end if;
	-- cm2, not marked: a start's record (u1) answers 'unmarked', and its operation is then refused for a rebuild; d2's
	-- record gives cm2 a new disk all the same.
	if pg_temp.nd_call('qorpera_record_coding_machine_folder_restart', cm2, p_operation => u1) ->> 'state' is distinct from 'unmarked' then
		raise exception 'cm2 is not marked'; end if;
	perform pg_temp.nd_refused(format('select pg_temp.nd_call(%L, %L, p_operation => %L)', 'qorpera_record_coding_machine_new_disk', cm2,
		u1), '22023', 'Coding machine input invalid');
	r := pg_temp.nd_call('qorpera_record_coding_machine_new_disk', cm2, p_operation => d2);
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm2, 'state', 'replaced',
			'detached', jsonb_build_array(c))
		or pg_temp.nd_reads(cm2) <> 0 or not pg_temp.nd_detached((c ->> 'workerId')::uuid)
		or pg_temp.nd_events((c ->> 'workerId')::uuid) -> 0 -> 'body' ->> 'reason' is distinct from 'MACHINE_NEW_DISK' then
		raise exception 'An unmarked machine''s rebuild: %', r; end if;
end $$;

-- 6. The reason's words; the others keep theirs.
do $$
begin
	if exists (select 1 from (values
			('MACHINE_NEW_DISK', '[]'::jsonb, 'The machine got a new disk; only the company folder was kept'),
			('MACHINE_NEW_DISK', '[{"commandId":"52400000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"},
				{"commandId":"52400000-0000-4000-8000-0000000000c2","turn":1,"command":"npm test"}]',
				'The machine got a new disk; only the company folder was kept; 2 commands were stopped'),
			('FOLDER_RESTART', '[]', 'The machine restarted for the company folder'),
			('MACHINE_STOPPED', '[]', 'The machine stopped'), ('SLEEP', '[]', 'The machine went to sleep'),
			('RETIRED', '[]', 'The machine was replaced by a newer one'),
			('EXECUTOR_DISABLED', '[]', 'Coding is not enabled here any more')) v(reason, stopped, text)
		where public.qorpera_coding_stopped_event(v.reason, v.stopped) ->> 'text' is distinct from v.text
			or public.qorpera_coding_stopped_event(v.reason, v.stopped) ->> 'reason' is distinct from v.reason) then
		raise exception 'The words'; end if;
end $$;

rollback;
