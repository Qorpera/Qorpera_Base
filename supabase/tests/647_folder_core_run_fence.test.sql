-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Company folder core, C1c-2a (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5): a folder-v2 run's tool calls on
-- the folder fence. The run check, the lease check, the wake check, the actor entry point, the context assertion, the
-- presence routes and the reading callers serve folder-v2; the stop counts deletions; the office, machine start, the
-- self-approval and the legacy effects refuse it. Snapshot-v1 keeps its text (a digest of each body) and its behaviour.
-- Runs are hand-built as in 634, with the native login, runner, assignment, lease, reservation and budget rows added
-- (foreign keys and triggers off while they go in). Races are in 648.

-- A snapshot-v1 company for the controls, with one leased job a binding can name.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('64700000-0000-4000-8000-000000000011','Snapshot control','63400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('64700000-0000-4000-8000-000000000011','63400000-0000-4000-8000-000000000001','authority-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('64700000-0000-4000-8000-000000000021','64700000-0000-4000-8000-000000000011','Environment',1,'63400000-0000-4000-8000-000000000001');
select pg_temp.fx($q$insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id,
	required_capability, job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at)
	values ('64700000-0000-4000-8000-0000000000c1', '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		'63400000-0000-4000-8000-000000000001', 'leased', extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('a', 64),
		clock_timestamp() + interval '1 hour')$q$);
select set_config('qorpera_test.snapshot_binding', jsonb_build_object('leaseId',extensions.gen_random_uuid(),
	'runId',extensions.gen_random_uuid(),'jobId','64700000-0000-4000-8000-0000000000c1','runnerId',extensions.gen_random_uuid(),
	'assignmentId',extensions.gen_random_uuid(),'credentialCapsuleId',extensions.gen_random_uuid(),
	'computeIdentityId',extensions.gen_random_uuid(),'provider','openai','nativeHarness','codex-cli','model','gpt-test')::text, true);

-- The native rows a hand-built run needs before the runtime can call a tool with it: the company's compute identity
-- and saved login (connection b3, version 1, a native subscription), the run's runner, accepted assignment, native
-- lease, sponsor reservation, model policy and budget row. Returns the binding the runtime sends.
create function pg_temp.native(p_actor jsonb) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_identity uuid := '64700000-0000-4000-8000-0000000000d1';
	v_capsule uuid := '64700000-0000-4000-8000-0000000000d2'; v_lease uuid := extensions.gen_random_uuid();
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	set local session_replication_role = replica;
	insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
	values (v_identity, v_run.profile_id, 'company', v_identity, 'Run fence fixture') on conflict (id) do nothing;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values (v_capsule, v_run.profile_id, v_identity, 'company', 'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64),
		v_run.created_by_user_id) on conflict (id) do nothing;
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness, billing_source,
		consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id, max_native_concurrency, quota_policy, allow_autonomous)
	values (v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, 'native_subscription', 'codex-cli', 'subscription',
		'fixture', v_run.created_by_user_id, v_run.created_by_user_id, v_capsule, 8,
		'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
		true)
	on conflict (connection_id, version) do nothing;
	-- The company login pays for unattended work too, so a wake run's sponsor test passes (and takes the connection).
	update public.qorpera_execution_sponsor_versions set allow_autonomous = true
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values ((p_actor ->> 'runnerId')::uuid, v_run.profile_id, (p_actor ->> 'runnerId')::uuid, 'Run fence runner', '["agent_turn"]',
		'active', repeat('e', 64), clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour',
		v_run.created_by_user_id, v_identity);
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values ((p_actor ->> 'assignmentId')::uuid, extensions.gen_random_uuid(), v_run.job_id, v_run.id, (p_actor ->> 'runnerId')::uuid,
		repeat('e', 64), 'accepted', clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run.id, v_run.job_id, v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, v_capsule,
		v_identity, (p_actor ->> 'runnerId')::uuid, (p_actor ->> 'assignmentId')::uuid, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run.id, v_run.job_id, v_run.profile_id, v_run.sponsor_binding_id, v_run.sponsor_version, v_sponsor.provider_connection_id,
		v_sponsor.provider_connection_version, date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_run.job_id, v_run.profile_id, v_run.environment_id, '["gpt-test"]', 32, 1000, 1000, v_run.created_by_user_id);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run.id);
	update public.qorpera_execution_runs set compute_identity_id = v_identity where id = v_run.id;
	set local session_replication_role = origin;
	return jsonb_build_object('leaseId', v_lease, 'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', p_actor ->> 'runnerId',
		'assignmentId', p_actor ->> 'assignmentId', 'credentialCapsuleId', v_capsule, 'computeIdentityId', v_identity,
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-test');
end $$;
create function pg_temp.path_claims(p_role text, p_user uuid default null) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', p_role, 'sub', p_user)::text, true)::text::void
$$;
create function pg_temp.ntlr(p_binding jsonb) returns public.qorpera_execution_runs language sql as $$
	select public.qorpera_native_tool_locked_run(p_binding)
$$;
create function pg_temp.lease(p_binding jsonb) returns jsonb language sql as $$
	select public.qorpera_validate_native_provider_execution_lease((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli')
$$;
create function pg_temp.wake(p_actor jsonb) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where run_id = (p_actor ->> 'runId')::uuid
$$;
-- Raises with this SQLSTATE and a message like this one.
create function pg_temp.raises_like(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected SQLSTATE % from %', p_state, p_sql using errcode = 'QTF02';
exception when others then
	if sqlstate = 'QTF02' then raise; end if;
	if sqlstate <> p_state or sqlerrm not like p_message then
		raise exception 'Expected % "%" from %, got % "%"', p_state, p_message, p_sql, sqlstate, sqlerrm using errcode = 'QTF03'; end if;
end $$;
-- The same call on a snapshot-v1 company must not be refused as folder-v2 (it may fail for its own reasons, retired
-- offices with their own 0A000).
create function pg_temp.not_refused(p_sql text) returns void language plpgsql as $$
begin
	execute p_sql;
exception when others then
	if sqlerrm = 'This Company File path does not serve folder-v2 companies' then
		raise exception 'A snapshot-v1 company was refused as folder-v2 by %', p_sql; end if;
end $$;

-- 1. Snapshot-v1 keeps its text: each body with the inserted line removed, or each text patch reversed, is byte for
-- byte the definition before this migration. A later change to one of these functions updates its digest here, once
-- its folder-v2 line is checked to still come first.
create function pg_temp.without_guard(p_definition text) returns text language plpgsql as $$
declare v_body integer := position('$function$' in p_definition); v_at integer; v_end integer;
begin
	v_at := v_body + position(E'\nbegin\n' in substr(p_definition, v_body)) - 1 + length(E'\nbegin\n');
	v_end := v_at + position(E'\n' in substr(p_definition, v_at));
	return substr(p_definition, 1, v_at - 1) || substr(p_definition, v_end);
end $$;
do $$
declare v record; v_text text; v_bad text[] := '{}';
begin
	for v in select * from (values
		('qorpera_native_tool_locked_run(jsonb)', 'guard', '05ff6cf43bcb0108234f8d4bafff592f'),
		('qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)', 'guard', '9695f5dc4c068fd8e7a69a38ea3e01c4'),
		-- Re-pinned for Sign in with ChatGPT (20260928359950): a ChatGPT plan never pays for a file-change or
		-- event wake, nor for work that follows from one; the snapshot-v1 text is otherwise unchanged.
		('qorpera_wake_authorized(qorpera_wake_occurrences)', 'guard', '025e118587495df4f03ef7634a9eadab'),
		('qorpera_company_path_assert_context(jsonb)', 'guard', '885499e6425c36e3d55ac3976c1459c6'),
		('qorpera_presence_path_routes(jsonb,text[],boolean)', 'guard', '8e5f14e3327ac4e308f17ed4e61d25c0'),
		('qorpera_native_office_start(jsonb,text,text,uuid,text)', 'guard', '9a5b091f9db1cda8437c8f34af3f5a98'),
		('qorpera_native_office_start_descriptor(jsonb,boolean)', 'guard', '13a84c634df05db103ac3e37af3ec1a6'),
		('qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)', 'guard', '1df3854ac567e4e0c9eb3b23d4c8923f'),
		('qorpera_native_office_file_export(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)', 'guard', 'd59292a74936b34ecf70782bda467019'),
		('qorpera_native_shared_file_export_source(jsonb,jsonb)', 'guard', '07f303ad8158c42fcf15cebe407ac3ce'),
		('qorpera_self_approve_organization_proposal(jsonb,uuid)', 'guard', 'c975bdeee11aa81db54a2169b6fce819'),
		('qorpera_native_machine_start(jsonb,text,text,uuid,text)', 'guard', 'c80526fec0e2c46669823c57f174b78e'),
		('qorpera_begin_native_tool_operation(jsonb,uuid,text,text,text,boolean)', 'guard', '68f9ad7a781178f4b075f0e92f1e5efd'),
		('qorpera_complete_native_tool_operation(jsonb,uuid,text,jsonb,uuid,uuid)', 'guard', '9744401a09208bef038836ff1c93559c'),
		('qorpera_begin_run_operation_receipt(uuid,text,uuid,text,uuid,uuid,text,text,text,text,boolean)', 'guard', '37c1883fe91cde03ab295f55d69a077c'),
		('qorpera_complete_run_operation_receipt(uuid,text,uuid,text,uuid,uuid,text,jsonb,uuid,uuid)', 'guard', 'd58c2d536891199866a31d1477c6f3a0'),
		('qorpera_send_native_agent_message(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)', 'guard', 'c21e35f7f2420dbe98dfc18ef41b4251'),
		('qorpera_send_runner_agent_message(uuid,text,uuid,text,uuid,text,text,text)', 'guard', 'b2109b5064f5d0def5d0a0bf72b1c5ba'),
		('qorpera_append_native_interaction_request(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,jsonb)', 'guard', '4d143aed500a29b11f813b06094a80ae'),
		('qorpera_append_runner_transcript_event(uuid,text,uuid,text,uuid,uuid,text,jsonb,bigint)', 'guard', 'a2831b21140af7098ada4d3f491b2783'),
		('qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)', 'actor', '3b5736c1cf409a623f10007429aa2f68'),
		('qorpera_read_company_run_context(jsonb,text,uuid,text,integer,integer)', 'actor', '65725e9941e3dae609539d722faed13f'),
		('qorpera_native_presence_register(jsonb,uuid,text)', 'actor', '32f9f1dd6f8106351cf53ab012e8b34a'),
		('qorpera_describe_agent_open_work(jsonb)', 'actor', 'b70d3ac1bbcfe97baf7c9a7baf8f79e3'),
		('qorpera_native_company_object_actor(jsonb,uuid)', 'actor', '57a44af9c107b7c0a3da5bfc6d3eafa7'),
		('qorpera_company_presence_scope(uuid,jsonb,text[])', 'actor', 'a9398c12528abddb25f91544455da044'),
		('qorpera_native_presence_subject(uuid,uuid,text[])', 'actor', '0f6897f705023a6b7d6e467aa5346a53'),
		('qorpera_list_member_file_exports(uuid,uuid,integer)', 'actor', 'f02bc3ed8bf29611092444de8f3e7d57'),
		('qorpera_member_file_export_source(uuid,jsonb)', 'export', '86298f73423ef925bc049b2e55f9fa2b'),
		('qorpera_describe_company_run_context(jsonb)', 'describe', '2b55ddb0f9c9dba700e36ffd4ecc1f42')) t(fn, kind, digest)
	loop
		v_text := pg_get_functiondef(('public.' || v.fn)::regprocedure);
		if v.kind = 'guard' then
			v_text := pg_temp.without_guard(v_text);
		else
			v_text := replace(v_text, 'public.qorpera_company_run_actor(', 'public.qorpera_company_path_actor(');
		end if;
		if v.kind = 'export' then
			v_text := replace(v_text, E' if not public.qorpera_environment_is_folder_v2(p_environment_id) then\n'
				|| E'  perform public.qorpera_lock_profile_gc_fence((v_actor->>''companyId'')::uuid);\n end if;\n',
				E' perform public.qorpera_lock_profile_gc_fence((v_actor->>''companyId'')::uuid);\n');
		elsif v.kind = 'describe' then
			v_text := replace(v_text, E'v_continuation jsonb; v_recorded jsonb; v_folder jsonb;\n', E'v_continuation jsonb; v_recorded jsonb;\n');
			v_text := replace(v_text, E'\tif public.qorpera_environment_is_folder_v2(v_run.environment_id) then\n'
				|| E'\t\tselect name into v_company_name from public.qorpera_folder_company_index where environment_id = v_run.environment_id;\n'
				|| E'\t\tif not found then raise exception ''Company folder is unavailable'' using errcode = ''42501''; end if;\n'
				|| E'\telse\n'
				|| E'\t\tselect name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;\n'
				|| E'\tend if;\n',
				E'\tselect name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;\n');
			v_text := replace(v_text, E'\tif public.qorpera_environment_is_folder_v2(v_run.environment_id) then\n'
				|| E'\t\texecute ''select public.qorpera_company_state_run_folder($1, $2, $3)'' into v_folder\n'
				|| E'\t\tusing v_run.environment_id, v_run.staff_agent_id,\n'
				|| E'\t\t\t(select coalesce(array_agg((coworker ->> ''id'')::uuid), ''{}''::uuid[]) from jsonb_array_elements(v_coworkers) coworker);\n'
				|| E'\tend if;\n', '');
			v_text := replace(v_text, E'\t\t\telse jsonb_build_object(''serviceTier'',v_run.service_tier) end\n'
				|| E'\t\t|| case when v_folder is null then ''{}''::jsonb else jsonb_build_object(''folder'', v_folder) end;\n',
				E'\t\t\telse jsonb_build_object(''serviceTier'',v_run.service_tier) end;\n');
		end if;
		if md5(v_text) <> v.digest then v_bad := v_bad || v.fn; end if;
	end loop;
	if cardinality(v_bad) > 0 then raise exception 'Snapshot-v1 text changed in: %', v_bad; end if;
	-- qorpera_run_wake_authorized keeps its text: it reaches the folder wake check through qorpera_wake_authorized.
	if md5(pg_get_functiondef('public.qorpera_run_wake_authorized(uuid)'::regprocedure)) <> 'b1d8f8610f59ff4e532f1e06c5b5b100' then
		raise exception 'qorpera_run_wake_authorized changed'; end if;
end $$;

-- 2. The lease check without locks is the legacy check without its three FOR SHARE, and nothing else.
do $$
begin
	if replace(pg_get_functiondef('public.qorpera_folder_native_lease_current(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure),
			'FUNCTION public.qorpera_folder_native_lease_current(', 'FUNCTION public.qorpera_validate_native_provider_execution_lease_before_recover(')
		is distinct from replace(pg_get_functiondef(
			'public.qorpera_validate_native_provider_execution_lease_before_recover(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure),
			E'\n\tfor share;', ';') then
		raise exception 'The lock-free lease check differs from the legacy one'; end if;
	if pg_get_functiondef('public.qorpera_folder_native_lease_current(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure)
		~* 'for (update|share|no key update|key share)' then raise exception 'The folder lease check locks'; end if;
end $$;

-- 3. A folder-v2 run's tool call: the run check, the lease check, the actor, the wake check and the reading callers.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	p jsonb; b jsonb; r public.qorpera_execution_runs%rowtype; t jsonb; a jsonb; l jsonb; o jsonb;
begin
	p := pg_temp.run(c_a, 'human', c_member);
	b := pg_temp.native(p);
	r := pg_temp.ntlr(b);
	if r.id::text <> p ->> 'runId' or r.profile_id <> c_profile or r.job_id::text <> p ->> 'jobId' then
		raise exception 'The run check must return the run row: %', to_jsonb(r); end if;
	-- An upper-case spelling of the same binding names the same run; the folder actor carries normalized ids.
	t := public.qorpera_folder_tool_run(b || jsonb_build_object('runId', upper(b ->> 'runId'), 'jobId', upper(b ->> 'jobId')), '[]');
	if t -> 'actor' <> p or t -> 'resolved' ->> 'kind' <> 'staff_agent' or t -> 'resolved' ->> 'runId' <> p ->> 'runId'
		or t -> 'resolved' ->> 'fenceRevision' is null or t -> 'run' ->> 'id' <> p ->> 'runId' then
		raise exception 'The folder run check result: %', t; end if;
	if (select to_jsonb(x) from pg_temp.ntlr(b || jsonb_build_object('runId', upper(b ->> 'runId'), 'jobId', upper(b ->> 'jobId'))) x)
		<> to_jsonb(r) then raise exception 'Either spelling must give the same run row'; end if;
	-- The actor entry point: the legacy field names, the core and the folder actor, with no locks.
	a := public.qorpera_company_run_actor(c_env, b);
	if a ->> 'core' <> 'folder-v2' or a ->> 'companyId' <> c_profile::text or a ->> 'runId' <> p ->> 'runId'
		or a ->> 'staffAgentId' <> c_a::text or a ->> 'userId' <> c_member::text or a ->> 'audience' <> 'company'
		or a ->> 'assignmentId' <> p ->> 'assignmentId' or a ->> 'jobId' <> p ->> 'jobId'
		or a -> 'folder' -> 'actor' <> p or a -> 'folder' -> 'resolved' ->> 'runId' <> p ->> 'runId'
		or a -> 'folder' -> 'resolved' ? 'lockTargets' then
		raise exception 'The folder run actor: %', a; end if;
	-- Another company's environment is not this run's (the legacy actor, after the folder run check).
	perform pg_temp.raises_like(format('select public.qorpera_company_run_actor(%L, %L)', '64700000-0000-4000-8000-000000000021', b), '42501',
		'Company File authority is unavailable');
	-- The lease check the runtime calls directly.
	l := pg_temp.lease(b);
	if l ->> 'lease_id' <> b ->> 'leaseId' or l ->> 'compute_identity_epoch' <> '0' or l ->> 'status' <> 'active' then
		raise exception 'The folder lease check: %', l; end if;
	-- The wake checks.
	if not public.qorpera_wake_authorized(pg_temp.wake(p)) or not public.qorpera_run_wake_authorized((p ->> 'runId')::uuid) then
		raise exception 'A folder-v2 human wake must be authorized'; end if;
	-- The reading callers.
	o := public.qorpera_describe_agent_open_work(b);
	if o ->> 'runId' <> p ->> 'runId' or o -> 'todos' ->> 'open' <> '0' then raise exception 'Open work: %', o; end if;
	o := public.qorpera_native_company_object_actor(b, c_profile);
	if o ->> 'core' <> 'folder-v2' or o ->> 'runId' <> p ->> 'runId' then raise exception 'Object actor: %', o; end if;
	perform pg_temp.raises(format('select public.qorpera_native_company_object_actor(%L, %L)', b, '64700000-0000-4000-8000-000000000011'), '42501');

	-- The binding's shape is checked as the legacy run check checks it.
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b || '{"provider":"anthropic"}'), '22023', 'native tool binding is invalid');
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b - 'model'), '22023', 'native tool binding is invalid');
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b || '{"extra":"x"}'), '22023', 'native tool binding is invalid');
	perform pg_temp.raises_like(format('select public.qorpera_folder_tool_run(%L, %L)', b, '{}'), 'XX000', 'Folder lock targets are malformed');
	-- The run's model, the lease and the runner are checked after the locks.
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b || '{"model":"gpt-other"}'), '42501', 'native tool run is unavailable');
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b || jsonb_build_object('leaseId', extensions.gen_random_uuid())),
		'42501', 'native execution binding is unavailable');
	perform pg_temp.fx(format('update public.qorpera_native_provider_connection_leases set created_at = clock_timestamp() - interval ''1 hour'', expires_at = clock_timestamp() - interval ''1 second'' where id = %L', b ->> 'leaseId'));
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b), '42501', 'native provider execution authority is unavailable');
	perform pg_temp.raises_like(format('select pg_temp.lease(%L)', b), '42501', 'native provider execution authority is unavailable');
	-- The actor entry point makes the same lease checks without the run check (presence calls it alone).
	perform pg_temp.raises_like(format('select public.qorpera_company_run_actor(%L, %L)', c_env, b), '42501',
		'native provider execution authority is unavailable');
	perform pg_temp.raises_like(format('select public.qorpera_company_presence_scope(%L, %L, %L)', c_env, b, array['shared/doc.md']),
		'42501', 'native provider execution authority is unavailable');
	perform pg_temp.fx(format('update public.qorpera_native_provider_connection_leases set expires_at = clock_timestamp() + interval ''1 hour'' where id = %L', b ->> 'leaseId'));
	perform pg_temp.fx(format('update public.qorpera_member_compute_identities set recovery_epoch = 1 where id = %L', b ->> 'computeIdentityId'));
	perform pg_temp.raises(format('select pg_temp.ntlr(%L)', b), '42501');
	perform pg_temp.raises_like(format('select pg_temp.lease(%L)', b), '42501', 'native execution generation is fenced for recovery');
	perform pg_temp.fx(format('update public.qorpera_member_compute_identities set recovery_epoch = 0 where id = %L', b ->> 'computeIdentityId'));
	-- An identity waiting for recovery is fenced before the lease itself is checked.
	perform pg_temp.fx(format('update public.qorpera_member_compute_identities set status = ''disabled'' where id = %L', b ->> 'computeIdentityId'));
	perform pg_temp.raises_like(format('select pg_temp.lease(%L)', b), '42501', 'native execution generation is fenced for recovery');
	perform pg_temp.fx(format('update public.qorpera_member_compute_identities set status = ''active'' where id = %L', b ->> 'computeIdentityId'));
	-- A runner from another generation of the identity is fenced too.
	perform pg_temp.fx(format('update public.qorpera_runners set compute_recovery_epoch = 1 where id = %L', b ->> 'runnerId'));
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b), '42501', 'native execution generation is fenced for recovery');
	perform pg_temp.raises_like(format('select pg_temp.lease(%L)', b), '42501', 'native execution generation is fenced for recovery');
	perform pg_temp.fx(format('update public.qorpera_runners set compute_recovery_epoch = 0 where id = %L', b ->> 'runnerId'));
	perform pg_temp.fx(format('update public.qorpera_runners set session_expires_at = clock_timestamp() - interval ''1 second'' where id = %L', b ->> 'runnerId'));
	perform pg_temp.raises(format('select pg_temp.ntlr(%L)', b), '42501');
	perform pg_temp.fx(format('update public.qorpera_runners set session_expires_at = clock_timestamp() + interval ''1 hour'' where id = %L', b ->> 'runnerId'));
	-- A dismissed agent's run is refused by the folder resolve (under the run check), not by the legacy actor.
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''archived'' where staff_agent_id = %L', c_a));
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b), '42501', 'Run agent is unavailable');
	perform pg_temp.raises_like(format('select public.qorpera_company_run_actor(%L, %L)', c_env, b), '42501', 'Run agent is unavailable');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''active'' where staff_agent_id = %L', c_a));
	-- A run without its budget row has no run mutex: refused.
	perform pg_temp.fx(format('delete from public.qorpera_execution_run_budgets where run_id = %L', p ->> 'runId'));
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b), '42501', 'native tool run is unavailable');
	perform pg_temp.fx(format('insert into public.qorpera_execution_run_budgets(run_id) values (%L)', p ->> 'runId'));
	r := pg_temp.ntlr(b);
end $$;

-- 4. The run entry's caller targets: rank 0 is only this company's row, KEY SHARE; ranks 6 and 7 KEY SHARE; no 8 or 9.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	v jsonb; e jsonb;
begin
	foreach v in array array[
		jsonb_build_object('rank', 0, 'tbl', 'qorpera_profiles', 'key', '64700000-0000-4000-8000-000000000011', 'mode', 'keyshare'),
		jsonb_build_object('rank', 0, 'tbl', 'qorpera_profiles', 'key', c_profile, 'mode', 'share'),
		jsonb_build_object('rank', 1, 'tbl', 'qorpera_profiles', 'key', c_profile, 'mode', 'keyshare'),
		jsonb_build_object('rank', 0, 'tbl', 'qorpera_profile_staff', 'key', c_profile, 'mode', 'keyshare'),
		jsonb_build_object('rank', 6, 'tbl', 'qorpera_company_path_resources', 'key', (pg_temp.root()).id, 'mode', 'share'),
		jsonb_build_object('rank', 8, 'tbl', 'qorpera_company_rooms', 'key', extensions.gen_random_uuid(), 'mode', 'keyshare'),
		jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'mode', 'keyshare'),
		jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', 'x', 'mode', 'exclusive'),
		'"not an object"'::jsonb] loop
		perform pg_temp.raises_like(format('select public.qorpera_folder_run_enter(%L, %L, %L, %L)', c_env, c_profile, p,
			jsonb_build_array(v)), 'XX000', 'Folder lock targets are malformed');
	end loop;
	perform pg_temp.raises_like(format('select public.qorpera_folder_run_enter(%L, %L, %L, %L)', c_env, c_profile, p, '{}'),
		'XX000', 'Folder lock targets are malformed');
	-- Valid targets: this company's row, a resource at rank 6; a required row that is missing refuses.
	v := public.qorpera_folder_run_enter(c_env, c_profile, p, jsonb_build_array(
		jsonb_build_object('rank', 0, 'tbl', 'qorpera_profiles', 'key', c_profile, 'mode', 'keyshare', 'required', true),
		jsonb_build_object('rank', 6, 'tbl', 'qorpera_company_path_resources', 'key', (pg_temp.root()).id, 'mode', 'keyshare', 'required', true)));
	if v ->> 'runId' <> p ->> 'runId' or v ? 'lockTargets' then raise exception 'The run entry with targets: %', v; end if;
	perform pg_temp.raises_like(format('select public.qorpera_folder_run_enter(%L, %L, %L, %L)', c_env, c_profile, p,
		jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', extensions.gen_random_uuid(),
			'mode', 'keyshare', 'required', true))), '42501', 'A row this change set relies on is unavailable');
	-- The three-argument entry is the four-argument one with no targets.
	e := public.qorpera_folder_run_enter(c_env, c_profile, p);
	if e <> public.qorpera_folder_run_enter(c_env, c_profile, p, '[]') then raise exception 'The two entries differ'; end if;
end $$;

-- 5. The stop: a pause row, and a deletion row with no pause row, refuse the run check, the actor, the lease check,
-- the run entry and a run's commit; the pause and resume functions still read the pause row itself.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	b jsonb := pg_temp.native(p); v_stop text;
begin
	foreach v_stop in array array[
		format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
			c_profile, '63400000-0000-4000-8000-000000000001', 'test'),
		format('insert into public.qorpera_company_deletions(profile_id, requested_by_user_id) values (%L, null)', c_profile)] loop
		perform pg_temp.fx(v_stop);
		perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', b), '55000', 'Company execution is paused');
		perform pg_temp.raises_like(format('select public.qorpera_company_run_actor(%L, %L)', c_env, b), '55000', 'Company execution is paused');
		perform pg_temp.raises_like(format('select pg_temp.lease(%L)', b), '55000', 'Company execution is paused');
		perform pg_temp.raises_like(format('select public.qorpera_folder_run_enter(%L, %L, %L)', c_env, c_profile, p), '55000',
			'Company execution is paused');
		perform pg_temp.raises_like(format('select public.qorpera_folder_read_actor(%L, %L)', c_env, p), '55000', 'Company execution is paused');
		perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', p, 'stopped-' || left(md5(v_stop), 6),
			'[{"op":"mkdir","path":"stopped"}]'), '55000');
		perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));
		perform pg_temp.fx(format('delete from public.qorpera_company_deletions where profile_id = %L', c_profile));
	end loop;
	perform pg_temp.ntlr(b);
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'qorpera_folder%'
			and prosrc like '%from public.qorpera_company_execution_pauses where profile_id%'
			and proname not in ('qorpera_folder_pause', 'qorpera_folder_pause_drain', 'qorpera_folder_resume')) <> 0 then
		raise exception 'A folder function still reads only the pause row'; end if;
end $$;

-- 6. The context assertion decides by the company's core: a folder-v2 run rechecks its folder reads (a revoked read
-- refuses rather than passing), an actor without the folder run actor refuses, a member has nothing to recheck. The wake
-- check of a coworker wake follows the parent's reads.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	p jsonb; b jsonb; a jsonb; v jsonb; vb jsonb; v_res uuid; v_ga uuid; v_gb uuid;
begin
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'vault', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_ga := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'vault-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','vault'),
		jsonb_build_object('op','write','path','vault/v.txt','file',pg_temp.stage('vault')))), 2, 'saved');
	p := pg_temp.run(c_a, 'human', c_member);
	b := pg_temp.native(p);
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('vault/v.txt', p) -> 'entry'));
	a := public.qorpera_company_run_actor(c_env, b);
	perform public.qorpera_company_path_assert_context(a);
	perform public.qorpera_describe_agent_open_work(b);
	-- Agent B's coworker wake from this run: B may not read what A read, so the wake is not authorized; once B may, it is.
	v := pg_temp.run(c_b, 'agent', c_member, 'coworker', p);
	if public.qorpera_wake_authorized(pg_temp.wake(v)) or public.qorpera_run_wake_authorized((v ->> 'runId')::uuid) then
		raise exception 'A coworker wake whose parent read what the recipient cannot must not be authorized'; end if;
	v_gb := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_b, array['read']) ->> 'grantId';
	if not public.qorpera_wake_authorized(pg_temp.wake(v)) or not public.qorpera_run_wake_authorized((v ->> 'runId')::uuid) then
		raise exception 'The coworker wake must be authorized once the recipient may read the parent''s reads'; end if;
	-- The coworker run's own tool call: a wake run, so the sponsor test asks whether the login pays for unattended work.
	vb := pg_temp.native(v);
	if (pg_temp.ntlr(vb)).id::text <> v ->> 'runId' then raise exception 'A wake run''s tool call'; end if;
	perform pg_temp.fx('update public.qorpera_provider_connection_versions set allow_autonomous = false
		where connection_id = ''63400000-0000-4000-8000-0000000000b3''');
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', vb), '42501', 'native provider execution authority is unavailable');
	perform pg_temp.fx('update public.qorpera_provider_connection_versions set allow_autonomous = true
		where connection_id = ''63400000-0000-4000-8000-0000000000b3''');
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_gb);
	if public.qorpera_wake_authorized(pg_temp.wake(v)) then raise exception 'A revoked parent read must refuse the coworker wake'; end if;
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', vb), '42501', 'Admitted wake authority is unavailable');
	-- A's read is revoked: the assertion refuses, and so does every reading caller that asserts.
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_ga);
	perform pg_temp.raises_like(format('select public.qorpera_company_path_assert_context(%L)', a), '42501', 'A read is no longer readable');
	perform pg_temp.raises_like(format('select public.qorpera_describe_agent_open_work(%L)', b), '42501', 'A read is no longer readable');
	perform pg_temp.raises_like(format('select public.qorpera_native_company_object_actor(%L, %L)', b, '63400000-0000-4000-8000-000000000010'),
		'42501', 'A read is no longer readable');
	-- A folder-v2 actor without the folder run actor, or with another run's, refuses; the legacy loop is never reached.
	perform pg_temp.raises_like(format('select public.qorpera_company_path_assert_context(%L)', a - 'folder'), '42501',
		'Company File authority is unavailable');
	-- The core is looked up from the environment: an actor without its core field is still folder-v2.
	perform pg_temp.raises_like(format('select public.qorpera_company_path_assert_context(%L)', a - 'core' - 'folder'), '42501',
		'Company File authority is unavailable');
	perform pg_temp.raises_like(format('select public.qorpera_company_path_assert_context(%L)',
		jsonb_set(a, '{folder,resolved,runId}', to_jsonb(extensions.gen_random_uuid()::text))), '42501', 'Company File authority is unavailable');
	-- A member actor has no read set.
	perform pg_temp.path_claims('authenticated', c_member);
	a := public.qorpera_company_run_actor(c_env, null);
	perform pg_temp.path_claims('service_role');
	if a ->> 'core' <> 'folder-v2' or a ->> 'userId' <> c_member::text or a ->> 'audience' <> 'human' or a ->> 'runId' is not null
		or a -> 'folder' -> 'resolved' <> jsonb_build_object('kind', 'member', 'userId', c_member) then
		raise exception 'The folder member actor: %', a; end if;
	perform public.qorpera_company_path_assert_context(a);
	-- A non-member is refused.
	perform pg_temp.path_claims('authenticated', '64700000-0000-4000-8000-0000000000ff');
	perform pg_temp.raises(format('select public.qorpera_company_run_actor(%L, null)', c_env), '42501');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.raises(format('select public.qorpera_company_run_actor(%L, null)', c_env), '42501');
end $$;

-- 7. Presence on the folder resolver: routes for what the run's agent and requester may read, a refusal (absent for the
-- subject lookup) for what they may not; the device register and the subject lookup work for folder-v2.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	p jsonb; b jsonb; s jsonb; v_res uuid; v_shared uuid; v_token text; v_client uuid := extensions.gen_random_uuid();
begin
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'closed', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	p := pg_temp.run(c_a, 'human', c_member);
	b := pg_temp.native(p);
	s := public.qorpera_company_presence_scope(c_env, b, array['shared/doc.md']);
	if s ->> 'companyId' <> '63400000-0000-4000-8000-000000000010' or jsonb_array_length(s -> 'paths') <> 1
		or jsonb_array_length(s #> '{paths,0,routes}') <> 3 or s #>> '{paths,0,routes,0,path}' <> ''
		or s #>> '{paths,0,routes,2,path}' <> 'shared/doc.md' then raise exception 'Folder presence scope: %', s; end if;
	perform pg_temp.raises_like(format('select public.qorpera_company_presence_scope(%L, %L, %L)', c_env, b, array['closed/x.md']),
		'42501', 'Company File path is unavailable');
	-- The same token for the same authority; another token once the grant set changes.
	if public.qorpera_company_presence_scope(c_env, b, array['shared/doc.md']) <> s then raise exception 'Presence tokens must be stable'; end if;
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), (pg_temp.root()).id, 'member', '63400000-0000-4000-8000-000000000004',
		array['read']);
	if public.qorpera_company_presence_scope(c_env, b, array['shared/doc.md']) #>> '{paths,0,routes,0,token}' = s #>> '{paths,0,routes,0,token}' then
		raise exception 'A grant change must change the root token'; end if;
	-- A narrower resource: its token changes with every access change (its authority revision), and every token changes
	-- with the membership.
	v_shared := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'shared', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), v_shared, 'staff_agent', c_a, array['read']);
	v_token := public.qorpera_company_presence_scope(c_env, b, array['shared/doc.md']) #>> '{paths,0,routes,1,token}';
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'shared', 'exact', 'company_shared', 'normal');
	if public.qorpera_company_presence_scope(c_env, b, array['shared']) #>> '{paths,0,routes,1,token}' = v_token then
		raise exception 'An access change on a resource must change its presence token'; end if;
	v_token := public.qorpera_company_presence_scope(c_env, b, array['shared']) #>> '{paths,0,routes,0,token}';
	perform pg_temp.fx('update public.qorpera_profile_members set role = ''contributor'' where profile_id = ''63400000-0000-4000-8000-000000000010''
		and user_id = ''63400000-0000-4000-8000-000000000003''');
	if public.qorpera_company_presence_scope(c_env, b, array['shared']) #>> '{paths,0,routes,0,token}' = v_token then
		raise exception 'A membership change must change the presence tokens'; end if;
	s := public.qorpera_native_presence_register(b, v_client, 'MCowBQYDK2VwAyEA' || repeat('A', 43) || '=');
	if s ->> 'runId' <> p ->> 'runId' then raise exception 'Presence register: %', s; end if;
	s := public.qorpera_native_presence_subject(c_env, v_client, array['shared/doc.md']);
	if s #>> '{identity,staffAgentId}' <> c_a::text or jsonb_array_length(s #> '{paths,0,routes}') <> 3 then
		raise exception 'Presence subject: %', s; end if;
	-- The subject lookup does not require the target: a closed path has no route beyond the root.
	s := public.qorpera_native_presence_subject(c_env, v_client, array['closed/x.md']);
	if jsonb_array_length(s #> '{paths,0,routes}') <> 1 then raise exception 'Presence subject of a closed path: %', s; end if;
	-- A dismissed agent's device is absent.
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''archived'' where staff_agent_id = %L', c_a));
	if public.qorpera_native_presence_subject(c_env, v_client, array['shared/doc.md']) is not null then
		raise exception 'A refused presence subject must be absent'; end if;
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = ''active'' where staff_agent_id = %L', c_a));
	-- A folder actor for another company is refused.
	perform pg_temp.raises_like(format('select public.qorpera_folder_presence_routes(%L, %L, false)',
		jsonb_set(public.qorpera_company_run_actor(c_env, b), '{companyId}', '"64700000-0000-4000-8000-000000000011"'), array['shared/doc.md']),
		'42501', 'Company File authority is unavailable');
	-- A member's shared exports: no company fence, and nothing listed yet.
	perform pg_temp.path_claims('authenticated', c_member);
	s := public.qorpera_list_member_file_exports(c_env);
	if s -> 'items' <> '[]'::jsonb then raise exception 'Member exports: %', s; end if;
	perform pg_temp.raises_like(format('select public.qorpera_member_file_export_source(%L, %L)', c_env,
		jsonb_build_object('realm','object_storage','assetId',extensions.gen_random_uuid(),'sha256',repeat('a',64))), '42501',
		'Completed shared export required');
	perform pg_temp.path_claims('service_role');
end $$;

-- 8. The run context: the company name from the folder index and F2's agent folders (F2-1b, 20260929440000), whose
-- helper the run context calls by name.
do $$
begin
	if to_regprocedure('public.qorpera_company_state_run_folder(uuid,uuid,uuid[])') is null then
		raise exception 'F2-1b''s qorpera_company_state_run_folder is missing'; end if;
end $$;
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	p jsonb; b jsonb; c jsonb; v_bundle public.qorpera_active_runtime_bundle%rowtype; v_manifest jsonb;
begin
	-- The run carries the active runtime bundle, whose model policy the context checks.
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	select manifest into strict v_manifest from public.qorpera_runtime_bundles
	where id = v_bundle.runtime_bundle_id and sha256 = v_bundle.runtime_bundle_sha256;
	p := pg_temp.run(c_a, 'human', '63400000-0000-4000-8000-000000000002');
	b := pg_temp.native(p);
	perform pg_temp.fx(format('update public.qorpera_execution_runs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L,
		reasoning_effort = %L, reasoning_policy_sha256 = %L, service_tier = ''standard'' where id = %L', v_bundle.runtime_bundle_id,
		v_bundle.runtime_bundle_sha256,
		v_manifest #>> '{modelPolicy,effort}',
		encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex'), p ->> 'runId'));
	perform pg_temp.fx(format('update public.qorpera_session_inputs set runtime_bundle_id = %L, runtime_bundle_sha256 = %L
		where execution_run_id = %L', v_bundle.runtime_bundle_id, v_bundle.runtime_bundle_sha256, p ->> 'runId'));
	perform pg_temp.raises_like(format('select public.qorpera_describe_company_run_context(%L)', b), '42501', 'Company folder is unavailable');
	perform pg_temp.fx(format('insert into public.qorpera_folder_company_index(environment_id, profile_id, name, vision_path_version,
		vision_seeded, commit_id) values (%L, %L, %L, %L, true, %L)', c_env, c_profile, 'Nordlys', extensions.gen_random_uuid(),
		extensions.gen_random_uuid()));
	-- Agents without folders: no folder facts, and the name from the folder index, not the profile row.
	c := public.qorpera_describe_company_run_context(b);
	if c #>> '{company,name}' <> 'Nordlys' or c ? 'folder' or c -> 'coworkers' -> 0 ->> 'id' <> c_b::text then
		raise exception 'Folder-v2 run context without folders: %', c - 'jobSpecification' - 'job'; end if;
	-- Both agents have folders: the facts name the agent and the coworker the context lists.
	perform pg_temp.fx(format('update public.qorpera_profile_staff set folder_environment_id = %L,
		folder_path = case staff_agent_id when %L then ''agents/ada'' else ''agents/bo'' end, folder_path_version = extensions.gen_random_uuid(),
		folder_commit_id = extensions.gen_random_uuid() where profile_id = %L', c_env, c_a, c_profile));
	c := public.qorpera_describe_company_run_context(b);
	if c -> 'folder' is distinct from jsonb_build_object('agent', 'ada', 'coworkers', jsonb_build_object(c_b, 'bo')) then
		raise exception 'Folder-v2 run context folders: %', c -> 'folder'; end if;
end $$;

-- 9. Refusals: the office, machine start and the self-approval until C1c-3; the runner broker's send, direct receipts
-- and transcript append until C3 (the native send, the interaction request and the tool operation receipts have folder
-- bodies since C1c-2b, tests 650 and 652). The same calls on a snapshot-v1 company are not refused as folder-v2.
do $$
declare
	p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	b jsonb := pg_temp.native(p); s jsonb := current_setting('qorpera_test.snapshot_binding')::jsonb; v jsonb; v_sql text;
begin
	foreach v in array array[b, s] loop
		foreach v_sql in array array[
			format('select public.qorpera_native_office_start(%L, %L, %L, %L, %L)', v, '{}', 'start', extensions.gen_random_uuid(), repeat('a', 64)),
			format('select public.qorpera_native_office_start_descriptor(%L, false)', v),
			format('select public.qorpera_native_office_capture(%L, %L, %L, %L, %L, %L, %L, %L)', v, '{}', '{}', '{}',
				extensions.gen_random_uuid(), repeat('a', 64), '{}', 'begin'),
			format('select public.qorpera_native_office_file_export(%L, %L, %L, %L, %L, %L, %L, %L)', v, '{}', '{}', '{}',
				extensions.gen_random_uuid(), repeat('a', 64), '{}', 'begin'),
			format('select public.qorpera_native_shared_file_export_source(%L, %L)', v, '{}'),
			format('select public.qorpera_self_approve_organization_proposal(%L, %L)', v, extensions.gen_random_uuid()),
			format('select public.qorpera_native_machine_start(%L, %L, %L, %L, %L)', v, '{}', 'start', extensions.gen_random_uuid(), repeat('a', 64)),
			format('select public.qorpera_begin_run_operation_receipt(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, false)', v ->> 'runnerId',
				repeat('f', 64), v ->> 'jobId', repeat('a', 64), v ->> 'assignmentId', extensions.gen_random_uuid(), 'k', 'tool', repeat('a', 64),
				repeat('b', 64)),
			format('select public.qorpera_complete_run_operation_receipt(%L, %L, %L, %L, %L, %L, %L, %L)', v ->> 'runnerId', repeat('f', 64),
				v ->> 'jobId', repeat('a', 64), v ->> 'assignmentId', extensions.gen_random_uuid(), repeat('a', 64), '{}'),
			format('select public.qorpera_send_runner_agent_message(%L, %L, %L, %L, %L, %L, %L, %L)', v ->> 'runnerId', repeat('f', 64),
				v ->> 'jobId', repeat('a', 64), v ->> 'assignmentId', 'k', 'Hello.', 'progress'),
			format('select public.qorpera_append_runner_transcript_event(%L, %L, %L, %L, %L, %L, %L, %L, 0)', v ->> 'runnerId', repeat('f', 64),
				v ->> 'jobId', repeat('a', 64), v ->> 'assignmentId', extensions.gen_random_uuid(), 'message', '{}')] loop
			if v = b then
				perform pg_temp.raises_like(v_sql, '0A000', 'This Company File path does not serve folder-v2 companies');
			else
				perform pg_temp.not_refused(v_sql);
			end if;
		end loop;
	end loop;
	-- A refusal leaves no budget use behind.
	if (select operation_count + transcript_event_count from public.qorpera_execution_run_budgets where run_id = (p ->> 'runId')::uuid) <> 0 then
		raise exception 'A refused effect must not count'; end if;
end $$;

-- 10. Snapshot-v1 controls: each dispatcher runs its legacy body for a snapshot-v1 company.
do $$
declare s jsonb := current_setting('qorpera_test.snapshot_binding')::jsonb; v jsonb;
begin
	-- The run check and the lease check fail in the legacy lease check (the stored tuple), not in the folder run check.
	perform pg_temp.raises_like(format('select pg_temp.ntlr(%L)', s), '42501', 'native execution binding is unavailable');
	perform pg_temp.raises_like(format('select pg_temp.lease(%L)', s), '42501', 'native execution binding is unavailable');
	-- The context assertion runs the legacy loop: a run with no legacy read paths passes, with no folder actor.
	perform public.qorpera_company_path_assert_context(jsonb_build_object('environmentId', '64700000-0000-4000-8000-000000000021',
		'companyId', '64700000-0000-4000-8000-000000000011', 'runId', extensions.gen_random_uuid()));
	-- Presence routes run the legacy resolver: no folder actor needed, and no route on a company without a gateway.
	v := public.qorpera_presence_path_routes(jsonb_build_object('environmentId', '64700000-0000-4000-8000-000000000021',
		'companyId', '64700000-0000-4000-8000-000000000011'), array['shared/doc.md'], false);
	if v #> '{0,routes}' <> '[]'::jsonb then raise exception 'Legacy presence routes: %', v; end if;
	-- The actor entry point is the legacy actor: a company without the path gateway refuses as it did.
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select public.qorpera_company_run_actor(%L, null)', '64700000-0000-4000-8000-000000000021'),
		'55000', 'Company File gateway is unavailable');
	perform pg_temp.path_claims('service_role');
	-- The legacy actor still refuses folder-v2 for good (C1C §2), after the folder run check.
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000002');
	perform pg_temp.raises(format('select public.qorpera_company_path_actor(%L, null)', '63400000-0000-4000-8000-000000000020'), '55000');
	perform pg_temp.path_claims('service_role');
end $$;

-- 11. Privileges: the new functions are postgres-only; the runtime reaches them through the dispatching functions.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_folder_run_enter(uuid,uuid,jsonb,jsonb)',
		'public.qorpera_folder_native_lease_current(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)',
		'public.qorpera_folder_validate_native_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)',
		'public.qorpera_folder_native_actor(jsonb)', 'public.qorpera_folder_native_run_current(jsonb)',
		'public.qorpera_folder_tool_run(jsonb,jsonb)', 'public.qorpera_company_run_actor(uuid,jsonb)',
		'public.qorpera_folder_presence_routes(jsonb,text[],boolean)'] loop
		if has_function_privilege('public', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('authenticated', v_fn, 'execute') or has_function_privilege('service_role', v_fn, 'execute') then
			raise exception '% must be postgres-only', v_fn; end if;
	end loop;
end $$;

rollback;
