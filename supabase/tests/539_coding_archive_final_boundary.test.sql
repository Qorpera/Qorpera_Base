-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- A coding archive's final boundary (20260930517000; F3 step 5g-5: deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md,
-- "Boundaries": "Detach, sleep or archive of a session: a final boundary for its view, then close and unmount"). An
-- archive that finds the attachment live keeps the session's view for that boundary, until 240 s after the archive at
-- most, which nothing renews; the executor's take-off saves, closes the view and records the detach. The detach, every
-- other refusal (the owner left, the repository withdrawn, the executor switched off) and the agent's archive still end
-- the view at once, and an attachment that had lapsed before the archive gets no time. The office, the folders and the
-- helpers are 639's; 523 covers a restarted machine, 639 and 644 the other ends of a coding view.

-- 0. The marker: qorpera_folder_view_valid names this migration and keeps the earlier markers.
do $$
declare v_lost text;
begin
	select string_agg(m.marker, ', ') into v_lost
	from unnest(array['20260930183000', '20260930420000', '20260930446000', '20260930517000']) m(marker)
	where strpos(pg_get_functiondef('public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure), m.marker) = 0;
	if v_lost is not null then raise exception 'Lost a marker: %', v_lost; end if;
end $$;

-- The node, the executor exec-1, agent A's repository grant, and a member who will leave.
do $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_nodes(id, machine_id_sha256, label, version, cpu_millis, memory_bytes, headroom_cpu_millis,
		headroom_memory_bytes, standard_cpu_millis, standard_memory_bytes, enabled)
	values ('53900000-0000-4000-8000-0000000000e1', encode(sha256(convert_to('node-539', 'UTF8')), 'hex'), 'node-539', 1, 16000,
		68719476736, 1000, 4294967296, 4000, 8589934592, true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled)
	values ('63200000-0000-4000-8000-000000000020', 'exec-1', true) on conflict do nothing;
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true) on conflict do nothing;
	insert into auth.users(id, email) values ('53900000-0000-4000-8000-000000000001', 'archive-leaver@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values ('63200000-0000-4000-8000-000000000010', '53900000-0000-4000-8000-000000000001', 'archive-leaver@example.test', 'Leaver',
		'contributor');
	set local session_replication_role = origin;
end $$;

-- The node's machine id, and a machine's exact binding text (523's).
create function pg_temp.ab_node() returns text language sql as $$
	select encode(sha256(convert_to('node-539', 'UTF8')), 'hex')
$$;
create function pg_temp.ab_binding(p_machine uuid) returns text language sql as $$
	select jsonb_build_object('machineId', p_machine, 'providerPolicySha256', repeat('d', 64))::text
$$;
-- A member machine of exec-1 on the node, pinned to its binding text, with its allocation and reserved demand.
create function pg_temp.ab_machine(p_member uuid default '63200000-0000-4000-8000-000000000002') returns uuid language plpgsql as $$
declare cm uuid := extensions.gen_random_uuid(); v_instance text;
begin
	v_instance := encode(extensions.digest(convert_to(pg_temp.ab_binding(cm), 'utf8'), 'sha256'), 'hex');
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
		instance_sha256)
	values (cm, 'member', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', p_member, 'exec-1',
		pg_temp.ab_node(), pg_temp.ab_binding(cm)::jsonb, v_instance);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (cm, '63200000-0000-4000-8000-000000000010', 'lxd', v_instance, cm, clock_timestamp());
	insert into public.qorpera_runtime_node_demands(allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis,
		memory_bytes, reserved_at)
	values (cm, '53900000-0000-4000-8000-0000000000e1', 'coding', 'lxd', repeat('d', 64), 2000, 4294967296, clock_timestamp());
	set local session_replication_role = origin;
	return cm;
end $$;
-- A coding session of agent A for p_owner, attached to p_machine for 10 minutes, between turns (its worker's turn
-- ended, so the archive has none to cancel); answers its view anchor.
create function pg_temp.ab_session(p_machine uuid, p_owner uuid default '63200000-0000-4000-8000-000000000002') returns jsonb
language plpgsql as $$
declare p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
	tok uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, state, result, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), 'w-539-' || w, 'coding', 'Code', 'read', 'each', '{}', 'succeeded', '{}',
		'63200000-0000-4000-8000-000000000002', (p ->> 'runId')::uuid, p_owner, '63200000-0000-4000-8000-0000000000b1', 1);
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
		attachment_token, attachment_until, attachment_turn, attached_at)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', 'claude-code',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/539-' || w, p_machine, tok,
		clock_timestamp() + interval '10 minutes', 1, clock_timestamp());
	set local session_replication_role = origin;
	return jsonb_build_object('workerId', w, 'attachmentToken', tok);
end $$;
-- A session's coding view, with its anchor, renewed once by the folder service that serves it (one service id for
-- every view: another would close it as service_crashed).
create function pg_temp.ab_view(p_session jsonb) returns jsonb language plpgsql as $$
declare v jsonb := pg_temp.open('coding_session', p_session) || p_session;
begin
	if pg_temp.ab_renew(v) ->> 'state' is distinct from 'open' then raise exception 'The view opens: %', v; end if;
	return v;
end $$;
create function pg_temp.ab_renew(p_view jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_view_renew((p_view ->> 'viewId')::uuid, p_view ->> 'pass', null, '53900000-0000-4000-8000-0000000005e1')
$$;
create function pg_temp.ab_closed(p_reason text) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.folder-view-renew/v1', 'state', 'closed', 'reason', p_reason)
$$;
create function pg_temp.ab_row(p_view jsonb) returns public.qorpera_folder_views language sql as $$
	select * from public.qorpera_folder_views where id = (p_view ->> 'viewId')::uuid
$$;
create function pg_temp.ab_cs(p_session jsonb) returns public.qorpera_coding_sessions language sql as $$
	select * from public.qorpera_coding_sessions where worker_id = (p_session ->> 'workerId')::uuid
$$;
-- The owner archives the session from its thread (qorpera_archive_coding_session's archive, the worker held).
create function pg_temp.ab_archive(p_session jsonb) returns boolean language sql as $$
	select public.qorpera_archive_coding_worker(w, 'member', null, w.owner_user_id)
	from public.qorpera_runtime_workers w where w.id = (p_session ->> 'workerId')::uuid
$$;
-- Moves a session's archive and the end the archive left it back by p_by, as that much time passing would.
create function pg_temp.ab_shift(p_session jsonb, p_by interval) returns void language plpgsql as $$
begin
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set archived_at = archived_at - %L::interval,
		attachment_until = attachment_until - %L::interval where worker_id = %L', p_by, p_by, p_session ->> 'workerId'));
end $$;
-- The executor's keep of p_machine (no observation), and its detach record of a session.
create function pg_temp.ab_keep(p_machine uuid) returns jsonb language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return public.qorpera_keep_coding_attachments(p_machine, 'exec-1', pg_temp.ab_binding(p_machine), pg_temp.ab_node(), null);
end $$;
create function pg_temp.ab_detach(p_machine uuid, p_session jsonb, p_reason text) returns jsonb language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return public.qorpera_record_coding_session_detached(p_machine, 'exec-1', pg_temp.ab_binding(p_machine), pg_temp.ab_node(),
		(p_session ->> 'workerId')::uuid, (p_session ->> 'attachmentToken')::uuid, p_reason, '[]');
end $$;
-- Whether a session is attached nowhere, as a detach leaves it (521's).
create function pg_temp.ab_detached(p_session jsonb) returns boolean language sql as $$
	select s.attached_machine_id is null and s.attachment_token is null and s.attachment_until is null and s.attachment_turn is null
		and s.attached_at is null
	from public.qorpera_coding_sessions s where s.worker_id = (p_session ->> 'workerId')::uuid
$$;
-- Runs p_sql, which must fail with p_state and p_message (523's).
create function pg_temp.ab_refused(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
declare v_state text; v_message text;
begin
	begin
		execute p_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
	end;
	if v_state is distinct from p_state or v_message is distinct from p_message then
		raise exception 'Expected % (%) from %, got % (%)', p_state, p_message, p_sql, v_state, v_message; end if;
end $$;
-- A save as the view that must be refused with p_message.
create function pg_temp.ab_save_refused(p_view jsonb, p_key text, p_message text default 'Folder view has ended') returns void
language sql as $$
	select pg_temp.ab_refused(format('select pg_temp.vcommit(%L, %L, %L)', p_view, p_key, '[{"op":"mkdir","path":"code/refused"}]'),
		'42501', p_message)
$$;

-- 1. The take-off of an archived session (the defect: its view ended at the archive, so the final boundary found none
-- and what the session wrote last went unsaved). The owner archives it, which ends the attachment now. The keep answers
-- release and keeps that end, and no view opens for it any more; the open view still renews, reads and saves, and the
-- executor's final boundary saves, closes it and records the detach.
do $$
declare cm uuid := pg_temp.ab_machine(); s jsonb := pg_temp.ab_session(cm); v jsonb := pg_temp.ab_view(s); r jsonb;
	cs public.qorpera_coding_sessions%rowtype;
begin
	if not pg_temp.ab_archive(s) then raise exception 'The owner archives the session'; end if;
	cs := pg_temp.ab_cs(s);
	if cs.archived_at is null or cs.archived_by is distinct from 'member' or cs.attachment_until < cs.archived_at
		or cs.attachment_until > clock_timestamp() then
		raise exception 'The archive ends the live attachment now: %', to_jsonb(cs); end if;
	r := pg_temp.ab_keep(cm);
	if r -> 'sessions' is distinct from jsonb_build_array(jsonb_build_object('workerId', s ->> 'workerId', 'state', 'release',
			'reason', 'ARCHIVED', 'attachmentToken', s ->> 'attachmentToken')) then
		raise exception 'The keep releases it: %', r; end if;
	if (pg_temp.ab_cs(s)).attachment_until is distinct from cs.attachment_until then raise exception 'The keep keeps its end'; end if;
	perform pg_temp.ab_refused(format('select pg_temp.open(%L, %L)', 'coding_session', s), '42501', 'Folder view attachment is not current');
	if pg_temp.ab_renew(v) ->> 'state' is distinct from 'open' then raise exception 'The view renews after the archive'; end if;
	if (pg_temp.read('shared/a.txt', pg_temp.vactor(v)) ->> 'found')::boolean is not true then
		raise exception 'The view reads after the archive'; end if;
	-- The final boundary.
	perform pg_temp.expect(pg_temp.vcommit(v, 'ab-1-final', '[{"op":"mkdir","path":"code/ab-1"}]'), 1, 'saved');
	r := public.qorpera_folder_view_close((v ->> 'viewId')::uuid, v ->> 'pass');
	if r is distinct from '{"schema":"qorpera.folder-view-close/v1","state":"closed","reason":"closed"}'::jsonb then
		raise exception 'The executor closes the view: %', r; end if;
	r := pg_temp.ab_detach(cm, s, 'ARCHIVED');
	if r is distinct from jsonb_build_object('schema', 'qorpera.coding-detached/v1', 'workerId', s ->> 'workerId', 'state', 'detached')
		or not pg_temp.ab_detached(s) then
		raise exception 'The executor records the detach: %', r; end if;
	perform pg_temp.ab_save_refused(v, 'ab-1-closed');
	if (select count(*) from public.qorpera_folder_entries where environment_id = '63200000-0000-4000-8000-000000000020'
			and key_text in ('code/ab-1', 'code/refused')) <> 1 then
		raise exception 'The final boundary''s save is kept, and only it'; end if;
end $$;

-- 2. The detach ends the view at once: when the executor records it first (a take-off without a final boundary, or
-- its retry), the next save is refused and the view's renewal closes it.
do $$
declare cm uuid := pg_temp.ab_machine(); s jsonb := pg_temp.ab_session(cm); v jsonb := pg_temp.ab_view(s);
begin
	perform pg_temp.ab_archive(s);
	perform pg_temp.expect(pg_temp.vcommit(v, 'ab-2-before', '[{"op":"mkdir","path":"code/ab-2"}]'), 1, 'saved');
	if pg_temp.ab_detach(cm, s, 'ARCHIVED') ->> 'state' is distinct from 'detached' then raise exception 'The detach'; end if;
	perform pg_temp.ab_save_refused(v, 'ab-2-after');
	if pg_temp.ab_renew(v) is distinct from pg_temp.ab_closed('ended') then raise exception 'The detach closes the view'; end if;
end $$;

-- 3. The bound: 240 s after the archive, which nothing renews. 200 s on (both times moved back, as they stand after the
-- archive) the view still saves and renews, and a second archive and the keep move neither time. At 241 s a save and a
-- read are refused at once, though the view's lease (renewed 41 s before) has not run out; its next renewal closes it
-- ('ended'), which is where the folder service stops serving its reads, one renewal (40 s) later at most. It does not
-- come back.
do $$
declare cm uuid := pg_temp.ab_machine(); s jsonb := pg_temp.ab_session(cm); v jsonb := pg_temp.ab_view(s);
	cs public.qorpera_coding_sessions%rowtype; vr public.qorpera_folder_views%rowtype;
begin
	perform pg_temp.ab_archive(s);
	perform pg_temp.ab_shift(s, '200 seconds');
	cs := pg_temp.ab_cs(s);
	if pg_temp.ab_archive(s) then raise exception 'A second archive changes nothing'; end if;
	if pg_temp.ab_keep(cm) -> 'sessions' -> 0 ->> 'reason' is distinct from 'ARCHIVED' then raise exception 'The keep releases it'; end if;
	if (pg_temp.ab_cs(s)).archived_at is distinct from cs.archived_at
		or (pg_temp.ab_cs(s)).attachment_until is distinct from cs.attachment_until then
		raise exception 'Nothing moves the archive or its end: % %', to_jsonb(cs), to_jsonb(pg_temp.ab_cs(s)); end if;
	perform pg_temp.expect(pg_temp.vcommit(v, 'ab-3-inside', '[{"op":"mkdir","path":"code/ab-3"}]'), 1, 'saved');
	if pg_temp.ab_renew(v) ->> 'state' is distinct from 'open' then raise exception 'The view renews 200 s on'; end if;
	perform pg_temp.ab_shift(s, '41 seconds');
	vr := pg_temp.ab_row(v);
	if vr.state <> 'open' or vr.lease_until < clock_timestamp() + interval '60 seconds' then
		raise exception 'The view''s lease is live: %', to_jsonb(vr); end if;
	perform pg_temp.ab_save_refused(v, 'ab-3-past');
	perform pg_temp.ab_refused(format('select pg_temp.read(%L, %L)', 'shared/a.txt', pg_temp.vactor(v)), '42501', 'Folder view has ended');
	if pg_temp.ab_renew(v) is distinct from pg_temp.ab_closed('ended') or (pg_temp.ab_row(v)).state <> 'closed' then
		raise exception 'Its renewal past the bound closes it'; end if;
	perform pg_temp.ab_shift(s, '-41 seconds');
	if pg_temp.ab_renew(v) is distinct from pg_temp.ab_closed('ended') then raise exception 'It stays closed'; end if;
	perform pg_temp.ab_refused(format('select pg_temp.open(%L, %L)', 'coding_session', s), '42501', 'Folder view attachment is not current');
end $$;

-- 4. An attachment that had lapsed before the archive gets no time: the archive keeps its earlier end, and the view
-- is refused and closes at its renewal.
do $$
declare cm uuid := pg_temp.ab_machine(); s jsonb := pg_temp.ab_session(cm); v jsonb := pg_temp.ab_view(s);
	cs public.qorpera_coding_sessions%rowtype;
begin
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set attachment_until = clock_timestamp() - interval ''5 seconds''
		where worker_id = %L', s ->> 'workerId'));
	if not pg_temp.ab_archive(s) then raise exception 'The owner archives the session'; end if;
	cs := pg_temp.ab_cs(s);
	if cs.attachment_until >= cs.archived_at then raise exception 'The archive keeps the lapsed end: %', to_jsonb(cs); end if;
	perform pg_temp.ab_save_refused(v, 'ab-4-lapsed');
	if pg_temp.ab_renew(v) is distinct from pg_temp.ab_closed('ended') then raise exception 'The lapsed view closes'; end if;
end $$;

-- 5. Inside the bound, every other refusal still ends an archived session's view at once: its owner left the company,
-- its repository grant was withdrawn, its executor switched off, or (in resolve and renew) agent A was archived. Each
-- view saves after the archive, then is refused, and closes at its renewal; each change is undone after.
do $$
declare c record; s jsonb; v jsonb;
begin
	for c in select * from (values
		('owner-left', '53900000-0000-4000-8000-000000000001'::uuid,
			$q$delete from public.qorpera_profile_members where user_id = '53900000-0000-4000-8000-000000000001'$q$, null,
			'Folder view has ended'),
		('repository-withdrawn', '63200000-0000-4000-8000-000000000002',
			$q$update public.qorpera_coding_repository_grants set enabled = false where environment_id = '63200000-0000-4000-8000-000000000020'
				and staff_agent_id = '63200000-0000-4000-8000-0000000000a1'$q$,
			$q$update public.qorpera_coding_repository_grants set enabled = true where environment_id = '63200000-0000-4000-8000-000000000020'
				and staff_agent_id = '63200000-0000-4000-8000-0000000000a1'$q$,
			'Folder view has ended'),
		('executor-disabled', '63200000-0000-4000-8000-000000000002',
			$q$update public.qorpera_coding_executors set enabled = false where environment_id = '63200000-0000-4000-8000-000000000020'
				and owner = 'exec-1'$q$,
			$q$update public.qorpera_coding_executors set enabled = true where environment_id = '63200000-0000-4000-8000-000000000020'
				and owner = 'exec-1'$q$,
			'Folder view has ended'),
		('agent-archived', '63200000-0000-4000-8000-000000000002',
			$q$update public.qorpera_profile_staff set employment_status = 'archived' where staff_agent_id = '63200000-0000-4000-8000-0000000000a1'$q$,
			$q$update public.qorpera_profile_staff set employment_status = 'active' where staff_agent_id = '63200000-0000-4000-8000-0000000000a1'$q$,
			'Folder view agent is unavailable')) x(name, owner, refuse, restore, message) loop
		s := pg_temp.ab_session(pg_temp.ab_machine(c.owner), c.owner);
		v := pg_temp.ab_view(s);
		perform pg_temp.ab_archive(s);
		perform pg_temp.expect(pg_temp.vcommit(v, 'ab-5-' || c.name, jsonb_build_array(jsonb_build_object('op', 'mkdir',
			'path', 'code/ab-5-' || c.name))), 1, 'saved');
		perform pg_temp.fx(c.refuse);
		perform pg_temp.ab_save_refused(v, 'ab-5-refused-' || c.name, c.message);
		if pg_temp.ab_renew(v) is distinct from pg_temp.ab_closed('ended') then raise exception 'The view closes: %', c.name; end if;
		if c.restore is not null then perform pg_temp.fx(c.restore); end if;
	end loop;
end $$;

rollback;
