-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- The folder service that serves a view, and the code host's view (20260930446000; F3 step 5a:
-- deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "The folder service"). A coding or code host view is renewed by
-- the service that serves it: the first renewal names it (served_by), a renewal from another service closes the view as
-- 'service_crashed', and a clean stop lets go of the service's views, which stay open. The code host's view is opened
-- by the platform with an empty anchor and acts as the platform, on code/ only. The office, the folders (shared/,
-- secret/, rules/, code/) and the helpers are 639's; 980 covers the renewal's other fields.

-- Every patched body carries this migration's marker, and the earlier markers stay. The new functions are the service's,
-- and the fence is no role's.
do $$
declare v_lost text;
begin
	select string_agg(f.sig, ', ') into v_lost from (values
			('qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', '20260930104000'),
			('qorpera_folder_view_open(uuid,jsonb,text,jsonb)', '20260930183000'),
			('qorpera_folder_view_valid(public.qorpera_folder_views)', '20260930446000'),
			('qorpera_folder_view_resolve(uuid,uuid,jsonb)', '20260930446000'),
			('qorpera_folder_actor_allowed(uuid,uuid,jsonb,text,text)', '20260930446000'),
			('qorpera_folder_actor_keys_allowed(uuid,uuid,jsonb,text,text[],text)', '20260930446000'),
			('qorpera_folder_paths_authority(uuid,uuid,jsonb,text[])', '20260930446000'),
			('qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', '20260930445000'),
			('qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)', '20260930445000'),
			('qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)', '20260930446000')) f(sig, earlier)
		where strpos(pg_get_functiondef(('public.' || f.sig)::regprocedure), '20260930446000') = 0
			or strpos(pg_get_functiondef(('public.' || f.sig)::regprocedure), f.earlier) = 0;
	if v_lost is not null then raise exception 'Lost a marker: %', v_lost; end if;
	if has_function_privilege('authenticated', 'public.qorpera_folder_service_stopped(uuid)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_folder_service_stopped(uuid)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_folder_service_stopped(uuid)', 'EXECUTE') then
		raise exception 'service_stopped''s privileges are wrong'; end if;
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role)
		where has_function_privilege(r.role, 'public.qorpera_folder_code_host_outside(jsonb,text)', 'EXECUTE')) then
		raise exception 'code_host_outside is callable'; end if;
end $$;

-- A coding session's view on its own coding machine (980's setup); the answer adds the coding machine's id.
create function pg_temp.coding(p_key text) returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
	tok uuid := extensions.gen_random_uuid(); cm uuid := extensions.gen_random_uuid();
	repo jsonb := '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), p_key, 'coding', 'Code', 'read', 'each', '{}', '63200000-0000-4000-8000-000000000002',
		(p ->> 'runId')::uuid, '63200000-0000-4000-8000-000000000002', '63200000-0000-4000-8000-0000000000b1', 1);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values (cm, 'member', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-000000000002', 'exec-1', encode(extensions.digest(cm::text, 'sha256'), 'hex'), '{}');
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
		attachment_token, attachment_until, attachment_turn, attached_at)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', 'claude-code', repo, 'qorpera/' || p_key, cm,
		tok, clock_timestamp() + interval '60 seconds', 1, clock_timestamp());
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1', repo, true) on conflict do nothing;
	insert into public.qorpera_coding_executors(environment_id, owner, enabled)
	values ('63200000-0000-4000-8000-000000000020', 'exec-1', true) on conflict do nothing;
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (cm, '63200000-0000-4000-8000-000000000010', 'lxd', encode(extensions.digest('i' || cm::text, 'sha256'), 'hex'), cm,
		clock_timestamp());
	set local session_replication_role = origin;
	return pg_temp.open('coding_session', jsonb_build_object('workerId', w, 'attachmentToken', tok))
		|| jsonb_build_object('codingMachineId', cm);
end $$;
create function pg_temp.renew(p_view jsonb, p_service uuid) returns jsonb language sql as $$
	select public.qorpera_folder_view_renew((p_view ->> 'viewId')::uuid, p_view ->> 'pass', null, p_service)
$$;
create function pg_temp.served_by(p_view jsonb) returns uuid language sql as $$
	select served_by from public.qorpera_folder_views where id = (p_view ->> 'viewId')::uuid
$$;

-- A coding session's view: renewed only with a service. The first renewal names it and the same service renews; a clean
-- stop lets go of the service's views, which stay open, and the next service takes over. The old service again: the view
-- may hold reads it never released, so it closes as service_crashed and stays closed.
do $$
declare cv jsonb := pg_temp.coding('w-served-1'); cv2 jsonb := pg_temp.coding('w-served-2');
	s1 uuid := extensions.gen_random_uuid(); s2 uuid := extensions.gen_random_uuid(); r jsonb; v public.qorpera_folder_views%rowtype;
begin
	perform pg_temp.raises(format('select public.qorpera_folder_view_renew(%L, %L)', cv ->> 'viewId', cv ->> 'pass'), '22023');
	perform pg_temp.raises(format('select pg_temp.renew(%L, null)', cv), '22023');
	if pg_temp.served_by(cv) is not null then raise exception 'A view opens served'; end if;
	r := pg_temp.renew(cv, s1);
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'coding_session'
		or r ->> 'companyId' is distinct from '63200000-0000-4000-8000-000000000010'
		or r ->> 'codingMachineId' is distinct from cv ->> 'codingMachineId' or pg_temp.served_by(cv) is distinct from s1 then
		raise exception 'First renewal: %', r; end if;
	if pg_temp.renew(cv, s1) ->> 'state' is distinct from 'open' or pg_temp.renew(cv2, s1) ->> 'state' is distinct from 'open'
		or pg_temp.served_by(cv) is distinct from s1 or pg_temp.served_by(cv2) is distinct from s1 then
		raise exception 'The same service renews'; end if;
	-- A clean stop.
	if public.qorpera_folder_service_stopped(s1) is distinct from 2 then raise exception 'Stop counts the service''s views'; end if;
	if exists (select 1 from public.qorpera_folder_views where id in ((cv ->> 'viewId')::uuid, (cv2 ->> 'viewId')::uuid)
		and (served_by is not null or state <> 'open')) then
		raise exception 'A stopped service''s views stay open, served by no one'; end if;
	r := pg_temp.renew(cv, s2);
	if r ->> 'state' is distinct from 'open' or pg_temp.served_by(cv) is distinct from s2 then
		raise exception 'The next service takes over: %', r; end if;
	-- The old service again.
	r := pg_temp.renew(cv, s1);
	select * into v from public.qorpera_folder_views where id = (cv ->> 'viewId')::uuid;
	if r ->> 'state' is distinct from 'closed' or r ->> 'reason' is distinct from 'service_crashed' or r ? 'kind'
		or v.state <> 'closed' or v.close_reason is distinct from 'service_crashed' or v.closed_at is null then
		raise exception 'Another service closes the view: % %', r, to_jsonb(v); end if;
	r := pg_temp.renew(cv, s2);
	if r ->> 'state' is distinct from 'closed' or r ->> 'reason' is distinct from 'service_crashed' then
		raise exception 'A crashed view stays closed: %', r; end if;
	-- A stop of no one's service, and of none.
	if public.qorpera_folder_service_stopped(extensions.gen_random_uuid()) is distinct from 0 then
		raise exception 'An unknown service serves nothing'; end if;
	perform pg_temp.raises('select public.qorpera_folder_service_stopped(null)', '22023');
end $$;

-- A run box is renewed by its runner: a service id names nothing.
do $$
declare b jsonb := pg_temp.open('run_box', '{}', pg_temp.run('human', '63200000-0000-4000-8000-000000000002')); r jsonb;
begin
	r := pg_temp.renew(b, extensions.gen_random_uuid());
	if r ->> 'state' is distinct from 'open' or r -> 'codingMachineId' is distinct from 'null'::jsonb
		or pg_temp.served_by(b) is not null or pg_temp.renew(b, extensions.gen_random_uuid()) ->> 'state' is distinct from 'open'
		or pg_temp.renew(b, null) ->> 'state' is distinct from 'open' then
		raise exception 'Run box renewal: %', r; end if;
end $$;

-- The code host's view: the platform opens it, anchored to nothing, and its service renews it. It has no agent, member,
-- worker or machine, and resolves as the platform with its view.
do $$
declare ch jsonb; s uuid := extensions.gen_random_uuid(); r jsonb; a jsonb; v public.qorpera_folder_views%rowtype;
begin
	perform pg_temp.raises($q$select pg_temp.open('code_host', '{"repository":"app"}')$q$, '22023');
	perform pg_temp.raises(format('select pg_temp.open(%L, %L, %L)', 'code_host', '{}', pg_temp.member(1)), '22023');
	ch := pg_temp.open('code_host', '{}');
	select * into v from public.qorpera_folder_views where id = (ch ->> 'viewId')::uuid;
	if ch ->> 'schema' is distinct from 'qorpera.folder-view/v1' or ch ->> 'pass' is null or v.kind <> 'code_host' or v.state <> 'open'
		or v.profile_id <> '63200000-0000-4000-8000-000000000010' or v.staff_agent_id is not null or v.member_user_id is not null
		or v.machine_id is not null or v.worker_id is not null or v.run_id is not null or v.served_by is not null then
		raise exception 'Code host open: % %', ch, to_jsonb(v); end if;
	perform pg_temp.raises(format('select pg_temp.renew(%L, null)', ch), '22023');
	r := pg_temp.renew(ch, s);
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'code_host'
		or r ->> 'companyId' is distinct from '63200000-0000-4000-8000-000000000010' or r -> 'machineId' is distinct from 'null'::jsonb
		or r -> 'codingMachineId' is distinct from 'null'::jsonb or pg_temp.served_by(ch) is distinct from s then
		raise exception 'Code host renewal: %', r; end if;
	a := public.qorpera_folder_view_resolve('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010',
		pg_temp.vactor(ch));
	if a ->> 'kind' is distinct from 'platform' or a -> 'view' ->> 'kind' is distinct from 'code_host'
		or a -> 'view' ->> 'id' is distinct from ch ->> 'viewId' or a ? 'userId' or a ? 'staffAgentId' then
		raise exception 'Code host resolve: %', a; end if;
	-- The table holds the shape.
	perform pg_temp.raises(format('update public.qorpera_folder_views set staff_agent_id = %L where id = %L',
		'63200000-0000-4000-8000-0000000000a1', ch ->> 'viewId'), '23514');
	perform pg_temp.raises(format('update public.qorpera_folder_views set machine_id = %L where id = %L',
		extensions.gen_random_uuid(), ch ->> 'viewId'), '23514');
	perform pg_temp.raises(format('update public.qorpera_folder_views set member_user_id = null where id = %L',
		(select id from public.qorpera_folder_views where kind = 'run_box' limit 1)), '23514');
	-- Another service while it is served closes it, as a coding session's view.
	if pg_temp.renew(ch, extensions.gen_random_uuid()) ->> 'reason' is distinct from 'service_crashed' then
		raise exception 'Code host crash'; end if;
end $$;

-- What it may do: code/ (and the folder code itself) as the platform; nothing outside, though the platform may.
do $$
declare env uuid := '63200000-0000-4000-8000-000000000020'; prof uuid := '63200000-0000-4000-8000-000000000010';
	ch jsonb := pg_temp.open('code_host', '{}'); a jsonb;
begin
	a := public.qorpera_folder_view_resolve(env, prof, pg_temp.vactor(ch));
	if not public.qorpera_folder_actor_allowed(env, prof, a, 'code', 'read')
		or not public.qorpera_folder_actor_allowed(env, prof, a, 'code/acme/app.git/HEAD', 'write')
		or not public.qorpera_folder_actor_allowed(env, prof, a, 'Code/acme', 'write')
		or public.qorpera_folder_actor_allowed(env, prof, a, 'shared/x', 'read')
		or public.qorpera_folder_actor_allowed(env, prof, a, 'QorperaOS/rules', 'read')
		or public.qorpera_folder_actor_allowed(env, prof, a, 'codex', 'write')
		or not public.qorpera_folder_actor_allowed(env, prof, '{"kind":"platform"}', 'shared/x', 'read') then
		raise exception 'Code host fence (actor_allowed)'; end if;
	if not public.qorpera_folder_actor_keys_allowed(env, prof, a, 'code', array['code/acme', 'code/acme/app.git'], 'write')
		or public.qorpera_folder_actor_keys_allowed(env, prof, a, 'code', array['code/acme', 'shared/x'], 'write')
		or public.qorpera_folder_actor_keys_allowed(env, prof, a, 'shared', array['shared/x'], 'read') then
		raise exception 'Code host fence (keys_allowed)'; end if;
	if (select array_agg(p.path order by p.path) from public.qorpera_folder_paths_authority(env, prof, a,
			array['code/acme', 'secret/s', 'shared/x']) p where p.ok) is distinct from array['code/acme']
		or (select count(*) from public.qorpera_folder_paths_authority(env, prof, a, array['code/acme', 'secret/s', 'shared/x'])) <> 3 then
		raise exception 'Code host fence (paths_authority)'; end if;
end $$;

-- Its commits save under code/ as the platform, with the view; outside code/ they are denied. Its releases record
-- nothing: the platform reads under no grant.
do $$
declare env uuid := '63200000-0000-4000-8000-000000000020'; ch jsonb := pg_temp.open('code_host', '{}'); r jsonb;
	c public.qorpera_folder_commits; rel uuid := extensions.gen_random_uuid();
begin
	r := pg_temp.vcommit(ch, 'code-host-1', '[{"op":"mkdir","path":"code/acme"},{"op":"mkdir","path":"shared/by-host"}]');
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	c := pg_temp.last_commit(r);
	if c.actor_kind <> 'platform' or c.actor_id is not null or c.requester_kind is distinct from 'platform' or c.requester_id is not null
		or c.view_id is distinct from (ch ->> 'viewId')::uuid or c.view_kind is distinct from 'code_host' or c.run_id is not null
		or c.session_kind is not null then
		raise exception 'Code host commit: %', to_jsonb(c); end if;
	perform pg_temp.expect(pg_temp.vcommit(ch, 'code-host-2', '[{"op":"mkdir","path":"code/acme/app.git"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.vcommit(ch, 'code-host-3', '[{"op":"mkdir","path":"QorperaOS/rules/by-host"}]'), 1, 'denied', 'denied');
	r := public.qorpera_folder_record_release(env, pg_temp.vactor(ch), rel, jsonb_build_array(jsonb_build_object('path', 'code/acme',
		'authority', jsonb_build_object('resourceId', extensions.gen_random_uuid(), 'resourceRevision', '1'))), repeat('a', 64));
	if r is distinct from jsonb_build_object('schema','qorpera.folder-release/v1','releaseId',rel,'reads',1,'replay',false,'runId',null)
		or exists (select 1 from public.qorpera_folder_view_releases where view_id = (ch ->> 'viewId')::uuid) then
		raise exception 'Code host release: %', r; end if;
end $$;

-- A pause does not stop it (the platform's); a deletion does, as it stops the platform.
do $$
declare env uuid := '63200000-0000-4000-8000-000000000020'; prof uuid := '63200000-0000-4000-8000-000000000010';
	ch jsonb := pg_temp.open('code_host', '{}');
begin
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		prof, '63200000-0000-4000-8000-000000000001', 'test'));
	perform pg_temp.expect(pg_temp.vcommit(ch, 'code-host-paused', '[{"op":"mkdir","path":"code/paused"}]'), 1, 'saved');
	perform pg_temp.fx(format('insert into public.qorpera_company_deletions(profile_id) values (%L)', prof));
	perform pg_temp.raises(format('select public.qorpera_folder_view_resolve(%L, %L, %L)', env, prof, pg_temp.vactor(ch)), '55000');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L, %L)', ch, 'code-host-deleting', '[{"op":"mkdir","path":"code/gone"}]'),
		'55000');
	raise exception 'Undo' using errcode = 'QTF80';
exception when sqlstate 'QTF80' then null;
end $$;
