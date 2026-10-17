-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- A coding machine restarted for the company folder (20260930501000; F3 step 5g-5, part 2:
-- deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md rule 4, "A crashed service"). A coding view closed as
-- service_crashed marks its machine and closes the machine's other open coding views ('ended'); the executor marks one
-- too. No coding view opens on a marked machine, a renewal of one closes it, and its stop custody is granted under a
-- leased turn. After the stop the executor's record detaches every session attached to it, each with one FOLDER_RESTART
-- event, and clears the mark; it is not an outside stop. The office, the folders and the helpers are 639's; 487 covers
-- the service that serves a view, 521 the machine stopped from outside.

-- 0. Markers and privileges: each patched, replaced or new function names this migration and keeps the earlier
-- markers; the executor (service_role) marks and records, and the words stay internal.
do $$
declare v_lost text;
begin
	select string_agg(f.sig || ' ' || m.marker, ', ') into v_lost
	from (values
		('qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', array['20260930104000', '20260930446000', '20260930496000']),
		('qorpera_folder_view_open(uuid,jsonb,text,jsonb)',
			array['20260930183000', '20260930342000', '20260930420000', '20260930445000', '20260930446000']),
		('qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)', array[]::text[]),
		('qorpera_coding_stopped_event(text,jsonb)', array['20260930431000']),
		('qorpera_mark_coding_machine_folder_restart(uuid,text,text,text)', array[]::text[]),
		('qorpera_record_coding_machine_folder_restart(uuid,text,text,text)', array[]::text[])) f(sig, earlier)
	cross join lateral unnest(f.earlier || '20260930501000'::text) m(marker)
	where strpos(pg_get_functiondef(('public.' || f.sig)::regprocedure), m.marker) = 0;
	if v_lost is not null then raise exception 'Lost a marker: %', v_lost; end if;
	if exists (select 1 from unnest(array['public.qorpera_mark_coding_machine_folder_restart(uuid,text,text,text)',
			'public.qorpera_record_coding_machine_folder_restart(uuid,text,text,text)']) f(name)
		where not has_function_privilege('service_role', f.name, 'execute')
			or exists (select 1 from unnest(array['anon', 'authenticated', 'qorpera_secret_broker']) r(role)
				where has_function_privilege(r.role, f.name, 'execute')))
		or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker']) r(role)
			where has_function_privilege(r.role, 'public.qorpera_coding_stopped_event(text,jsonb)', 'execute')) then
		raise exception 'Only the executor marks and records; the words stay internal'; end if;
end $$;

-- The node, the executor exec-1 and agent A's repository grant.
do $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
		headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
	values ('52300000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-523', 'UTF8')), 'hex'), 'node-523', 1, 16000,
		68719476736, 1000, 4294967296, 4000, 8589934592, true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled)
	values ('63200000-0000-4000-8000-000000000020', 'exec-1', true) on conflict do nothing;
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true) on conflict do nothing;
	set local session_replication_role = origin;
end $$;

-- The node's machine id, and a machine's exact binding text.
create function pg_temp.fr_node() returns text language sql as $$
	select encode(sha256(convert_to('node-523', 'UTF8')), 'hex')
$$;
create function pg_temp.fr_binding(p_machine uuid) returns text language sql as $$
	select jsonb_build_object('machineId', p_machine, 'providerPolicySha256', repeat('d', 64))::text
$$;
-- A member machine of exec-1 on the node, pinned to its binding text, with its allocation and reserved demand.
create function pg_temp.fr_machine() returns uuid language plpgsql as $$
declare cm uuid := extensions.gen_random_uuid(); v_instance text;
begin
	v_instance := encode(extensions.digest(convert_to(pg_temp.fr_binding(cm), 'utf8'), 'sha256'), 'hex');
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
		instance_sha256)
	values (cm, 'member', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-000000000002', 'exec-1', pg_temp.fr_node(), pg_temp.fr_binding(cm)::jsonb, v_instance);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (cm, '63200000-0000-4000-8000-000000000010', 'lxd', v_instance, cm, clock_timestamp());
	insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
		memory_bytes, reserved_at)
	values (cm, '52300000-0000-4000-8000-0000000000e1', 'coding', 'lxd', repeat('d', 64), 2000, 4294967296, clock_timestamp());
	set local session_replication_role = origin;
	return cm;
end $$;
-- A coding session of agent A attached to p_machine, its commands last seen running p_running (487's setup); answers
-- its view anchor.
create function pg_temp.fr_session(p_machine uuid, p_running jsonb default '[]') returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
	tok uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), 'w-523-' || w, 'coding', 'Code', 'read', 'each', '{}', '63200000-0000-4000-8000-000000000002',
		(p ->> 'runId')::uuid, '63200000-0000-4000-8000-000000000002', '63200000-0000-4000-8000-0000000000b1', 1);
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
		attachment_token, attachment_until, attachment_turn, attached_at, running_commands)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', 'claude-code',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/523-' || w, p_machine, tok,
		clock_timestamp() + interval '10 minutes', 1, clock_timestamp(), p_running);
	set local session_replication_role = origin;
	return jsonb_build_object('workerId', w, 'attachmentToken', tok);
end $$;
-- A session's coding view, with its anchor.
create function pg_temp.fr_view(p_session jsonb) returns jsonb language sql as $$
	select pg_temp.open('coding_session', p_session) || p_session
$$;
create function pg_temp.fr_renew(p_view jsonb, p_service uuid) returns jsonb language sql as $$
	select public.qorpera_folder_view_renew((p_view ->> 'viewId')::uuid, p_view ->> 'pass', null, p_service)
$$;
create function pg_temp.fr_row(p_view jsonb) returns public.qorpera_folder_views language sql as $$
	select * from public.qorpera_folder_views where id = (p_view ->> 'viewId')::uuid
$$;
create function pg_temp.fr_mark_at(p_machine uuid) returns timestamptz language sql as $$
	select folder_restart_at from public.qorpera_coding_machines where id = p_machine
$$;
-- The executor's mark or record (p_rpc) of p_machine under p_role's claims, with this custody (the machine's own unless
-- given).
create function pg_temp.fr_call(p_rpc text, p_machine uuid, p_role text default 'service_role', p_owner text default 'exec-1',
	p_binding text default null, p_sha256 text default null) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
	execute format('select public.%I($1, $2, $3, $4)', p_rpc) into v_result
	using p_machine, p_owner, coalesce(p_binding, pg_temp.fr_binding(p_machine)), coalesce(p_sha256, pg_temp.fr_node());
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return v_result;
end $$;
create function pg_temp.fr_custody(p_machine uuid, p_intent text) returns jsonb language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return public.qorpera_authorize_coding_machine_custody(p_machine, 'exec-1', pg_temp.fr_binding(p_machine), pg_temp.fr_node(), p_intent);
end $$;
-- Runs p_sql, which must fail with p_state and p_message; answers the error's detail.
create function pg_temp.fr_refused(p_sql text, p_state text, p_message text) returns text language plpgsql as $$
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
create function pg_temp.fr_events(p_worker uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_object('sequence', e.sequence, 'body', e.body) order by e.id), '[]'::jsonb)
	from public.qorpera_coding_session_events e where e.worker_id = p_worker and e.kind = 'step' and e.actor = 'executor'
$$;
-- Whether a session is attached nowhere and runs nothing, as a detach leaves it (521's).
create function pg_temp.fr_detached(p_worker uuid) returns boolean language sql as $$
	select s.attached_machine_id is null and s.attachment_token is null and s.attachment_until is null and s.attachment_turn is null
		and s.attached_at is null and s.running_commands = '[]'::jsonb
	from public.qorpera_coding_sessions s where s.worker_id = p_worker
$$;
-- A value kept for the later steps, until the rollback.
create function pg_temp.fr_put(p_name text, p_value text) returns void language plpgsql as $$
begin
	perform set_config('qorpera_test.fr_' || p_name, p_value, true);
end $$;
create function pg_temp.fr_get(p_name text) returns text language sql as $$
	select current_setting('qorpera_test.fr_' || p_name)
$$;
-- A view's or session's anchor.
create function pg_temp.fr_anchor(p jsonb) returns jsonb language sql as $$
	select jsonb_build_object('workerId', p ->> 'workerId', 'attachmentToken', p ->> 'attachmentToken')
$$;

-- 1. A crashed service's coding view marks its machine: views a and b on cm, c on cm2, all served by s1; s2 renews a,
-- which closes as service_crashed. cm is marked and b closes ('ended'); cm2 and c are not touched. A code host's crash
-- marks nothing.
do $$
declare cm uuid := pg_temp.fr_machine(); cm2 uuid := pg_temp.fr_machine(); a jsonb; b jsonb; c jsonb; ch jsonb; r jsonb;
	s1 uuid := extensions.gen_random_uuid(); s2 uuid := extensions.gen_random_uuid(); v_before timestamptz; v_marked bigint;
	v public.qorpera_folder_views%rowtype;
begin
	a := pg_temp.fr_view(pg_temp.fr_session(cm)); b := pg_temp.fr_view(pg_temp.fr_session(cm)); c := pg_temp.fr_view(pg_temp.fr_session(cm2));
	if pg_temp.fr_renew(a, s1) ->> 'state' is distinct from 'open' or pg_temp.fr_renew(b, s1) ->> 'state' is distinct from 'open'
		or pg_temp.fr_renew(c, s1) ->> 'state' is distinct from 'open' or (pg_temp.fr_row(a)).machine_id is distinct from cm then
		raise exception 'The views open on their machines'; end if;
	v_before := clock_timestamp();
	r := pg_temp.fr_renew(a, s2);
	if r is distinct from '{"schema":"qorpera.folder-view-renew/v1","state":"closed","reason":"service_crashed"}'::jsonb then
		raise exception 'The crash: %', r; end if;
	if pg_temp.fr_mark_at(cm) is null or pg_temp.fr_mark_at(cm) not between v_before and clock_timestamp()
		or pg_temp.fr_mark_at(cm2) is not null then
		raise exception 'The crash marks its machine only: % %', pg_temp.fr_mark_at(cm), pg_temp.fr_mark_at(cm2); end if;
	v := pg_temp.fr_row(b);
	if v.state <> 'closed' or v.close_reason is distinct from 'ended' or v.closed_at is null then
		raise exception 'The machine''s other view closes: %', to_jsonb(v); end if;
	if pg_temp.fr_renew(b, s1) is distinct from '{"schema":"qorpera.folder-view-renew/v1","state":"closed","reason":"ended"}'::jsonb
		or pg_temp.fr_renew(a, s1) ->> 'reason' is distinct from 'service_crashed' then
		raise exception 'Both stay closed'; end if;
	if pg_temp.fr_renew(c, s1) ->> 'state' is distinct from 'open' or (pg_temp.fr_row(c)).state <> 'open' then
		raise exception 'Another machine''s view stays open'; end if;
	-- A code host's view has no machine.
	select count(*) into v_marked from public.qorpera_coding_machines where folder_restart_at is not null;
	ch := pg_temp.open('code_host', '{}');
	if pg_temp.fr_renew(ch, s1) ->> 'state' is distinct from 'open'
		or pg_temp.fr_renew(ch, s2) ->> 'reason' is distinct from 'service_crashed'
		or (select count(*) from public.qorpera_coding_machines where folder_restart_at is not null) <> v_marked then
		raise exception 'A code host''s crash marks nothing'; end if;
	perform pg_temp.fr_put('cm', cm::text); perform pg_temp.fr_put('cm2', cm2::text);
	perform pg_temp.fr_put('a', a::text); perform pg_temp.fr_put('b', b::text); perform pg_temp.fr_put('c', c::text);
	perform pg_temp.fr_put('s1', s1::text);
end $$;

-- 2. The executor's mark: only the service role, with the machine's exact custody. A view open on the machine closes
-- ('ended') at its next renewal, by the service that serves it. Marking again keeps the first mark.
do $$
declare cm4 uuid := pg_temp.fr_machine(); d jsonb := pg_temp.fr_view(pg_temp.fr_session(cm4)); s1 uuid := pg_temp.fr_get('s1')::uuid;
	r jsonb; v_at timestamptz; v public.qorpera_folder_views%rowtype;
begin
	if pg_temp.fr_renew(d, s1) ->> 'state' is distinct from 'open' then raise exception 'd opens'; end if;
	perform pg_temp.fr_refused(format('select pg_temp.fr_call(%L, %L, p_role => %L)', 'qorpera_mark_coding_machine_folder_restart', cm4,
		x.role), '42501', 'Coding machine custody required') from unnest(array['anon', 'authenticated']) x(role);
	perform pg_temp.fr_refused(format('select pg_temp.fr_call(%L, %L, p_owner => %L, p_binding => %L, p_sha256 => %L)',
		'qorpera_mark_coding_machine_folder_restart', x.machine, x.owner, x.binding, x.sha256), '42501', 'Coding machine custody differs')
	from (values
		-- An unknown machine, another executor's, another node's, another binding, the same binding as other text.
		(extensions.gen_random_uuid(), 'exec-1', pg_temp.fr_binding(cm4), null),
		(cm4, 'exec-2', null, null),
		(cm4, 'exec-1', null, repeat('8', 64)),
		(cm4, 'exec-1', pg_temp.fr_binding(extensions.gen_random_uuid()), null),
		(cm4, 'exec-1', jsonb_pretty(pg_temp.fr_binding(cm4)::jsonb), null)) x(machine, owner, binding, sha256);
	if pg_temp.fr_mark_at(cm4) is not null then raise exception 'A refused mark marks nothing'; end if;
	r := pg_temp.fr_call('qorpera_mark_coding_machine_folder_restart', cm4);
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm4, 'state', 'marked')
		or pg_temp.fr_mark_at(cm4) is null then
		raise exception 'The mark: %', r; end if;
	v_at := pg_temp.fr_mark_at(cm4);
	if pg_temp.fr_call('qorpera_mark_coding_machine_folder_restart', cm4) ->> 'state' is distinct from 'marked'
		or pg_temp.fr_mark_at(cm4) is distinct from v_at then
		raise exception 'Marking again keeps the first mark'; end if;
	if (pg_temp.fr_row(d)).state <> 'open' then raise exception 'The mark closes nothing itself'; end if;
	r := pg_temp.fr_renew(d, s1);
	v := pg_temp.fr_row(d);
	if r is distinct from '{"schema":"qorpera.folder-view-renew/v1","state":"closed","reason":"ended"}'::jsonb
		or v.state <> 'closed' or v.close_reason is distinct from 'ended' or v.closed_at is null then
		raise exception 'A view on a marked machine closes at its renewal: % %', r, to_jsonb(v); end if;
	perform pg_temp.fr_put('cm4', cm4::text); perform pg_temp.fr_put('d', d::text);
end $$;

-- 3. No coding view opens on a marked machine: not for a session with no view (e), nor for the sessions whose views
-- closed (a, d), with its own code. An attachment that is not current is refused first, as before.
do $$
declare cm uuid := pg_temp.fr_get('cm')::uuid; e jsonb := pg_temp.fr_session(cm); a jsonb := pg_temp.fr_get('a')::jsonb;
	v_session jsonb;
begin
	foreach v_session in array array[e, a, pg_temp.fr_get('d')::jsonb] loop
		if pg_temp.fr_refused(format('select pg_temp.open(%L, %L)', 'coding_session', pg_temp.fr_anchor(v_session)),
				'42501', 'Coding machine must restart first') is distinct from 'qorpera.coding-machine/folder-restart' then
			raise exception 'The refusal''s detail: %', v_session; end if;
	end loop;
	perform pg_temp.fr_refused(format('select pg_temp.open(%L, %L)', 'coding_session',
		jsonb_build_object('workerId', e ->> 'workerId', 'attachmentToken', extensions.gen_random_uuid())),
		'42501', 'Folder view attachment is not current');
	if exists (select 1 from public.qorpera_folder_views where worker_id = (e ->> 'workerId')::uuid)
		or (select count(*) from public.qorpera_folder_views where worker_id = (a ->> 'workerId')::uuid) <> 1 then
		raise exception 'A refused open opens nothing'; end if;
	perform pg_temp.fr_put('e', e::text);
end $$;

-- 4. Stop custody: a marked machine stops under a leased turn (l on cm); an unmarked one does not (l5 on cm5), and a
-- marked one is not removed under it.
do $$
declare cm uuid := pg_temp.fr_get('cm')::uuid; cm5 uuid := pg_temp.fr_machine();
	l jsonb := pg_temp.fr_session(cm, '[{"commandId":"52300000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"}]');
	l5 jsonb := pg_temp.fr_session(cm5); r jsonb;
begin
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set phase = %L, lease_owner = %L,
		lease_token = extensions.gen_random_uuid(), lease_until = clock_timestamp() + interval %L, started_at = clock_timestamp(),
		vm_allocation_id = attached_machine_id where worker_id in (%L, %L)', 'preparing', 'exec-1', '5 minutes', l ->> 'workerId',
		l5 ->> 'workerId'));
	r := pg_temp.fr_custody(cm5, 'stop');
	if r is distinct from '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb then raise exception 'An unmarked machine in use: %', r; end if;
	if (select stop_authorized_at from public.qorpera_coding_machines where id = cm) is not null then
		raise exception 'cm was never stopped'; end if;
	r := pg_temp.fr_custody(cm, 'stop');
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-admission/v1', 'machineId', cm, 'workerId', null,
			'instanceSha256', encode(extensions.digest(convert_to(pg_temp.fr_binding(cm), 'utf8'), 'sha256'), 'hex'), 'intent', 'stop',
			'guestUid', null, 'validForMs', 5000, 'nodeId', '52300000-0000-4000-8000-0000000000e1', 'nodeVersion', 1)
		or (select stop_authorized_at from public.qorpera_coding_machines where id = cm) is null then
		raise exception 'A marked machine stops under a leased turn: %', r; end if;
	r := pg_temp.fr_custody(cm, 'delete');
	if r is distinct from '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb then raise exception 'Its removal waits: %', r; end if;
	perform pg_temp.fr_put('l', l::text);
end $$;

-- 5. The record: only the service role, with the machine's exact custody. Every session attached to cm (a, b, e and
-- the leased l) is detached, each with one FOLDER_RESTART event naming its commands; the mark is cleared and no outside
-- stop is kept. cm2's session is not touched. Again, or on an unmarked machine, it answers 'unmarked' and changes
-- nothing.
do $$
declare cm uuid := pg_temp.fr_get('cm')::uuid; cm2 uuid := pg_temp.fr_get('cm2')::uuid; c jsonb := pg_temp.fr_get('c')::jsonb;
	l jsonb := pg_temp.fr_get('l')::jsonb;
	v_expected jsonb; r jsonb; v_worker jsonb; v_before timestamptz;
begin
	perform pg_temp.fr_refused(format('select pg_temp.fr_call(%L, %L, p_role => %L)', 'qorpera_record_coding_machine_folder_restart', cm,
		x.role), '42501', 'Coding machine custody required') from unnest(array['anon', 'authenticated']) x(role);
	perform pg_temp.fr_refused(format('select pg_temp.fr_call(%L, %L, p_owner => %L, p_binding => %L, p_sha256 => %L)',
		'qorpera_record_coding_machine_folder_restart', x.machine, x.owner, x.binding, x.sha256), '42501', 'Coding machine custody differs')
	from (values
		(extensions.gen_random_uuid(), 'exec-1', pg_temp.fr_binding(cm), null),
		(cm, 'exec-2', null, null),
		(cm, 'exec-1', null, repeat('8', 64)),
		(cm, 'exec-1', jsonb_pretty(pg_temp.fr_binding(cm)::jsonb), null)) x(machine, owner, binding, sha256);
	select jsonb_agg(jsonb_build_object('workerId', worker_id, 'attachmentToken', attachment_token) order by worker_id) into v_expected
	from public.qorpera_coding_sessions where attached_machine_id = cm;
	if jsonb_array_length(v_expected) <> 4 or pg_temp.fr_mark_at(cm) is null then
		raise exception 'Four sessions on the marked machine: %', v_expected; end if;
	v_before := clock_timestamp();
	r := pg_temp.fr_call('qorpera_record_coding_machine_folder_restart', cm);
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm, 'state', 'restarted',
			'detached', v_expected) then
		raise exception 'The record names each attachment it ended: % (expected %)', r, v_expected; end if;
	for v_worker in select value from jsonb_array_elements(v_expected) loop
		if not pg_temp.fr_detached((v_worker ->> 'workerId')::uuid)
			or (select coalesce(observed_at, '-infinity') from public.qorpera_coding_sessions
				where worker_id = (v_worker ->> 'workerId')::uuid) < v_before then
			raise exception 'Detached: %', v_worker; end if;
		if pg_temp.fr_events((v_worker ->> 'workerId')::uuid) is distinct from jsonb_build_array(jsonb_build_object('sequence', 1,
				'body', case when v_worker ->> 'workerId' = l ->> 'workerId' then jsonb_build_object(
					'text', 'The machine restarted for the company folder; 1 command was stopped', 'reason', 'FOLDER_RESTART',
					'stopped', '[{"commandId":"52300000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"}]'::jsonb,
					'moreStopped', 0)
				else '{"text":"The machine restarted for the company folder","reason":"FOLDER_RESTART","stopped":[],"moreStopped":0}'::jsonb
				end)) then
			raise exception 'Each is told once: % %', v_worker, pg_temp.fr_events((v_worker ->> 'workerId')::uuid); end if;
	end loop;
	if not exists (select 1 from public.qorpera_coding_sessions where worker_id = (l ->> 'workerId')::uuid and phase = 'preparing'
			and lease_token is not null and vm_allocation_id = cm) then
		raise exception 'The leased turn keeps its lease'; end if;
	if pg_temp.fr_mark_at(cm) is not null or exists (select 1 from public.qorpera_coding_machine_outside_stops where machine_id = cm) then
		raise exception 'The mark is cleared, and it is not an outside stop'; end if;
	if not exists (select 1 from public.qorpera_coding_sessions where worker_id = (c ->> 'workerId')::uuid and attached_machine_id = cm2
			and attachment_token = (c ->> 'attachmentToken')::uuid) or pg_temp.fr_events((c ->> 'workerId')::uuid) <> '[]'::jsonb then
		raise exception 'Another machine''s session is not touched'; end if;
	-- Again, and on an unmarked machine.
	r := pg_temp.fr_call('qorpera_record_coding_machine_folder_restart', cm);
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-machine-folder-restart/v1', 'machineId', cm, 'state', 'unmarked',
			'detached', '[]'::jsonb)
		or exists (select 1 from jsonb_array_elements(v_expected) x
			where jsonb_array_length(pg_temp.fr_events((x.value ->> 'workerId')::uuid)) <> 1) then
		raise exception 'A second record changes nothing: %', r; end if;
	r := pg_temp.fr_call('qorpera_record_coding_machine_folder_restart', cm2);
	if r ->> 'state' is distinct from 'unmarked'
		or not exists (select 1 from public.qorpera_coding_sessions where worker_id = (c ->> 'workerId')::uuid and attached_machine_id = cm2)
		or (pg_temp.fr_row(c)).state <> 'open' then
		raise exception 'An unmarked machine''s record changes nothing: %', r; end if;
end $$;

-- 6. The reason's words; the others keep theirs.
do $$
begin
	if exists (select 1 from (values
			('FOLDER_RESTART', '[]'::jsonb, 'The machine restarted for the company folder'),
			('FOLDER_RESTART', '[{"commandId":"52300000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"},
				{"commandId":"52300000-0000-4000-8000-0000000000c2","turn":1,"command":"npm test"}]',
				'The machine restarted for the company folder; 2 commands were stopped'),
			('MACHINE_STOPPED', '[]', 'The machine stopped'), ('SLEEP', '[]', 'The machine went to sleep'),
			('EXECUTOR_DISABLED', '[]', 'Coding is not enabled here any more')) v(reason, stopped, text)
		where public.qorpera_coding_stopped_event(v.reason, v.stopped) ->> 'text' is distinct from v.text) then
		raise exception 'The words'; end if;
end $$;

-- 7. Once restarted, a session attached anew opens a view on the machine, and the next service serves it.
do $$
declare cm uuid := pg_temp.fr_get('cm')::uuid; e jsonb := pg_temp.fr_get('e')::jsonb; tok uuid := extensions.gen_random_uuid();
	v jsonb; r jsonb;
begin
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set attached_machine_id = %L, attachment_token = %L,
		attachment_until = clock_timestamp() + interval %L, attachment_turn = 1, attached_at = clock_timestamp() where worker_id = %L',
		cm, tok, '10 minutes', e ->> 'workerId'));
	v := pg_temp.fr_view(jsonb_build_object('workerId', e ->> 'workerId', 'attachmentToken', tok));
	r := pg_temp.fr_renew(v, extensions.gen_random_uuid());
	if r ->> 'state' is distinct from 'open' or r ->> 'codingMachineId' is distinct from cm::text then
		raise exception 'A view opens after the restart: %', r; end if;
end $$;

rollback;
