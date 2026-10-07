-- @fixture 639_folder_core_views.test.sql until "-- A run box: opened by its run"
-- A view's renewal says what the view is and which machine it belongs to (20260930104000; F3 step 4, slice 4a:
-- deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md). The open answer carries the view's kind and machine_id: the
-- allocation of the office's activation for a desktop, the coding machine's allocation for a coding session, null for
-- a run box. The closed answer is unchanged, and so is what renew checks and sets. The office, screen and helpers are
-- 639's.

-- Renew carries this migration's marker and is still the service's alone.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz)'::regprocedure);
begin
	if strpos(v_definition, '20260930104000') = 0 then raise exception 'renew has no marker 20260930104000'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_folder_view_renew(uuid,text,timestamptz)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_folder_view_renew(uuid,text,timestamptz)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_folder_view_renew(uuid,text,timestamptz)', 'EXECUTE') then
		raise exception 'renew''s privileges changed'; end if;
end $$;

-- A run box: kind run_box, no machine. Renew still records unsaved changes and moves the lease.
do $$
declare b jsonb := pg_temp.open('run_box', '{}', pg_temp.run('human', '63200000-0000-4000-8000-000000000002')); r jsonb;
	v public.qorpera_folder_views%rowtype; t timestamptz := clock_timestamp() - interval '3 seconds';
begin
	r := public.qorpera_folder_view_renew((b ->> 'viewId')::uuid, b ->> 'pass', t);
	-- Every check here is null-safe (`is distinct from`): a missing or null field fails it.
	if r ->> 'schema' is distinct from 'qorpera.folder-view-renew/v1' or r ->> 'state' is distinct from 'open'
		or r ->> 'kind' is distinct from 'run_box' or jsonb_typeof(r -> 'machineId') is distinct from 'null'
		or r ->> 'leaseUntil' is null then
		raise exception 'Run box renewal: %', r; end if;
	if (select count(*) from jsonb_object_keys(r)) <> 5 then raise exception 'Run box renewal fields: %', r; end if;
	select * into v from public.qorpera_folder_views where id = (b ->> 'viewId')::uuid;
	if v.unsaved_since is distinct from t or v.lease_until is distinct from (r ->> 'leaseUntil')::timestamptz then
		raise exception 'Run box renewal sets: %', to_jsonb(v); end if;
	r := public.qorpera_folder_view_renew((b ->> 'viewId')::uuid, b ->> 'pass');
	if r ->> 'kind' is distinct from 'run_box'
		or (select unsaved_since from public.qorpera_folder_views where id = (b ->> 'viewId')::uuid) is not null then
		raise exception 'Run box renewal without unsaved changes: %', r; end if;
	-- Closed: the answer is as it was, with no kind or machine.
	perform public.qorpera_folder_view_close((b ->> 'viewId')::uuid, b ->> 'pass');
	r := public.qorpera_folder_view_renew((b ->> 'viewId')::uuid, b ->> 'pass');
	if r is distinct from jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','closed','reason','closed') then
		raise exception 'Closed renewal: %', r; end if;
end $$;

-- A desktop, held by a run and then by a member: kind computer_desktop, and the machine is the allocation of the
-- office's current activation. A desktop whose activation is gone renews closed, with no kind or machine.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); d jsonb; m jsonb; r jsonb;
begin
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4','holderRunId',v ->> 'runId'));
	r := public.qorpera_folder_view_renew((d ->> 'viewId')::uuid, d ->> 'pass');
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'computer_desktop'
		or r ->> 'machineId' is distinct from '63900000-0000-4000-8000-0000000000e1' then
		raise exception 'Run-held desktop renewal: %', r; end if;
	perform pg_temp.hold(null, '63200000-0000-4000-8000-000000000001');
	m := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4',
		'holderUserId','63200000-0000-4000-8000-000000000001'));
	r := public.qorpera_folder_view_renew((m ->> 'viewId')::uuid, m ->> 'pass');
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'computer_desktop'
		or r ->> 'machineId' is distinct from '63900000-0000-4000-8000-0000000000e1' then
		raise exception 'Member-held desktop renewal: %', r; end if;
	-- The member's view superseded the run's.
	r := public.qorpera_folder_view_renew((d ->> 'viewId')::uuid, d ->> 'pass');
	if r ->> 'state' is distinct from 'closed' or r ? 'kind' or r ? 'machineId' then
		raise exception 'Superseded desktop renewal: %', r; end if;
	perform pg_temp.fx('update public.qorpera_runtime_office_activations set superseded_at = clock_timestamp()
		where activation_id = ''63900000-0000-4000-8000-0000000000e3''');
	r := public.qorpera_folder_view_renew((m ->> 'viewId')::uuid, m ->> 'pass');
	if r ->> 'state' is distinct from 'closed' or r ? 'kind' or r ? 'machineId' then
		raise exception 'Desktop renewal after its activation: %', r; end if;
	raise exception 'Undo' using errcode = 'QTF80';
exception when sqlstate 'QTF80' then null;
end $$;

-- A coding session (as in 639): kind coding_session, and the machine is the coding machine's allocation (which has the
-- coding machine's id).
do $$
declare p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); w uuid := extensions.gen_random_uuid();
	tok uuid := extensions.gen_random_uuid(); cm uuid := extensions.gen_random_uuid(); cv jsonb; r jsonb;
	repo jsonb := '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}';
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), 'w-coding', 'coding', 'Code', 'read', 'each', '{}', '63200000-0000-4000-8000-000000000002',
		(p ->> 'runId')::uuid, '63200000-0000-4000-8000-000000000002', '63200000-0000-4000-8000-0000000000b1', 1);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values (cm, 'member', '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020',
		'63200000-0000-4000-8000-000000000002', 'exec-1', repeat('8', 64), '{}');
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, attached_machine_id,
		attachment_token, attachment_until, attachment_turn, attached_at)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', 'claude-code', repo, 'qorpera/w-coding', cm,
		tok, clock_timestamp() + interval '60 seconds', 1, clock_timestamp());
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values ('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1', repo, true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled) values ('63200000-0000-4000-8000-000000000020', 'exec-1', true);
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (cm, '63200000-0000-4000-8000-000000000010', 'lxd', repeat('9', 64), cm, clock_timestamp());
	set local session_replication_role = origin;
	cv := pg_temp.open('coding_session', jsonb_build_object('workerId', w, 'attachmentToken', tok));
	r := public.qorpera_folder_view_renew((cv ->> 'viewId')::uuid, cv ->> 'pass');
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'coding_session'
		or r ->> 'machineId' is distinct from cm::text then
		raise exception 'Coding session renewal: %', r; end if;
	raise exception 'Undo' using errcode = 'QTF80';
exception when sqlstate 'QTF80' then null;
end $$;

rollback;
