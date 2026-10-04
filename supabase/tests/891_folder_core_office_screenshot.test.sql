-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core C1c-3l part 3 (20260930030200): an agent's screenshot of the Company Computer on a folder-v2
-- company goes back to the model only. The capture authorizes without storage and answers the image's identity under
-- the operation's receipt; nothing is stored; the completed receipt is the capture's record for the read and the
-- capture-set check, and the run's next operation begins. Folder-v2 only (the founder's decision of 3 October). 648's
-- committed fixture; everything is removed at the end.

-- A session holds a row and waits; the fences' helpers, as 850's.
create function pg_temp.hold(p_sql text) returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', p_sql) as t(x integer);
end $$;
create function pg_temp.release() returns void language plpgsql as $$
begin
	perform dblink_exec('fence_one', 'commit');
end $$;
create function pg_temp.claims(p_conn text, p_role text, p_user text default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text));
end $$;
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
-- Sends a call and waits up to ten seconds for it to end; its text answer, or the error as "<sqlstate> <message>".
create function pg_temp.settled(p_conn text, p_sql text) returns text language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '10 seconds'; v_answer text;
begin
	perform dblink_send_query(p_conn, p_sql);
	while dblink_is_busy(p_conn) = 1 loop
		if clock_timestamp() > v_until then return 'WAITED'; end if;
		perform pg_sleep(0.02);
	end loop;
	begin
		select r into v_answer from dblink_get_result(p_conn) as t(r text);
	exception when others then v_answer := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return coalesce(v_answer, 'null');
end $$;
-- The company row held FOR NO KEY UPDATE: a KEY SHARE goes through, FOR SHARE, NO KEY UPDATE and FOR UPDATE wait.
create function pg_temp.company_hold(p_company text) returns text language sql as $$
	select format('select 1 from public.qorpera_profiles where id = %L for no key update', '64800000-0000-4000-8000-0000000000' || p_company)
$$;
create function pg_temp.member_hold(p_user text) returns text language sql as $$
	select format('select 1 from public.qorpera_profile_members where profile_id = %L and user_id = %L for no key update',
		'64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-0000000000' || p_user)
$$;
create function pg_temp.office_free() returns boolean language sql as $$
	select pg_temp.row_free(format('select 1 from public.qorpera_runtime_offices where id = %L for update',
		current_setting('qorpera_test.office_id')))
$$;

select pg_temp.claims('fence_two', 'authenticated', '64800000-0000-4000-8000-000000000001');

-- The company's computer, started by its owner and brought up by the provider (893's chain).
do $$
declare v_office jsonb; v_scope text; v_generation text; v_answer text;
begin
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_register_runtime_office(%L, %L, %L, %L, 2)::text',
		'64800000-0000-4000-8000-000000000020', '89100000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64)));
	v_office := v_answer::jsonb;
	v_scope := (v_office - 'state')::text;
	v_generation := (select generation::text from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid);
	perform set_config('qorpera_test.scope', v_scope, false);
	perform set_config('qorpera_test.office_id', v_office ->> 'companyComputerId', false);
	perform set_config('qorpera_test.generation', v_generation, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_set_runtime_office_provider(%L, %s, %L, %L, 0, true)::text',
		v_scope, v_generation, '89100000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	v_answer := pg_temp.settled('fence_two', format('select public.qorpera_request_runtime_office_start(%L, %s, %L)::text', v_scope,
		v_generation, '89100000-0000-4000-8000-0000000000d4'));
	if v_answer !~ '"state": "requested"' then raise exception 'Setup: the owner starts the computer: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_reserve_runtime_office_start(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89100000-0000-4000-8000-0000000000d4', '89100000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('a', 64), repeat('b', 64),
		repeat('d', 64), '89100000-0000-4000-8000-0000000000b0', repeat('f', 64)));
	if v_answer !~ '"state": "reserved"' then raise exception 'Setup: the provider reserves the start: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format(
		'select public.qorpera_prepare_runtime_office_activation(%L, %s, %L, %L, %L, %L, %L, %L, %L, %L)::text', v_scope, v_generation,
		'89100000-0000-4000-8000-0000000000d4', '89100000-0000-4000-8000-0000000000a9', repeat('c', 64), repeat('d', 64),
		'89100000-0000-4000-8000-0000000000b0', repeat('f', 64), '[]', jsonb_build_object('schema', 'qorpera.office-activation-attestation/v1',
			'activationId', '89100000-0000-4000-8000-0000000000f1', 'bootId', '89100000-0000-4000-8000-0000000000f2',
			'preparationObservationSha256', repeat('1', 64), 'configurationObservationSha256', repeat('2', 64),
			'configurationSha256', repeat('3', 64), 'adoptionReceiptSha256', repeat('4', 64), 'nativePort', 5900, 'viewerPort', 6080)));
	if v_answer !~ '"state": "prepared"' then raise exception 'Setup: the provider prepares the activation: %', v_answer; end if;
	perform set_config('qorpera_test.startup', jsonb_build_object('scope', v_scope::jsonb, 'computerGeneration', v_generation::bigint,
		'allocationId', '89100000-0000-4000-8000-0000000000a9', 'instanceSha256', repeat('c', 64), 'imageSha256', repeat('a', 64),
		'bootstrapSha256', repeat('b', 64), 'bootId', '89100000-0000-4000-8000-0000000000f2', 'configurationSha256', repeat('3', 64),
		'serviceInvocationId', repeat('5', 32))::text, false);
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_report_runtime_office_ready(%L, %L, 5900, 6080)::text',
		current_setting('qorpera_test.startup'), '89100000-0000-4000-8000-0000000000f1'));
	if v_answer !~ '"state": "ready"' then raise exception 'Setup: the computer reports ready: %', v_answer; end if;
	v_answer := pg_temp.settled('fence_three', format('select public.qorpera_activate_runtime_office(%L, %s, %L, %L, %L, %L, %L)::text',
		v_scope, v_generation, '89100000-0000-4000-8000-0000000000d4', '89100000-0000-4000-8000-0000000000f1',
		'89100000-0000-4000-8000-0000000000b0', repeat('f', 64), repeat('5', 32)));
	if (select state from public.qorpera_runtime_offices where id = (v_office ->> 'companyComputerId')::uuid) <> 'active' then
		raise exception 'Setup: the computer is active: %', v_answer; end if;
end $$;

-- Ada's run gets an executable runtime bundle and acknowledges first, as a human wake requires (824 B's recipe); the
-- company's login may pay for her work.
set session_replication_role = replica;
update public.qorpera_execution_runs run set runtime_bundle_id = bundle.id, runtime_bundle_sha256 = bundle.sha256, reasoning_effort = 'low',
	reasoning_policy_sha256 = encode(extensions.digest(convert_to((bundle.manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex'),
	service_tier = 'standard'
from public.qorpera_active_runtime_bundle active join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
where run.id = '64800000-0000-4000-8000-0000000000f1';
update public.qorpera_session_inputs input set runtime_bundle_id = run.runtime_bundle_id, runtime_bundle_sha256 = run.runtime_bundle_sha256
from public.qorpera_execution_runs run where run.id = '64800000-0000-4000-8000-0000000000f1' and input.execution_run_id = run.id;
set session_replication_role = origin;
select public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid,
	(b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid, (b ->> 'computeIdentityId')::uuid,
	'openai', 'codex-cli', 'shot-ack', 'Looking at the screen.', 'progress')
from (select current_setting('qorpera_test.binding')::jsonb b) x \g /dev/null

-- A. Ada's screenshot of her screen on the folder-v2 computer: the screen is hers (acquire), the operation is authorized
--    and begun under its receipt, and the capture authorizes without storage and publishes the image's identity under
--    the receipt. The operation finishes and completes its receipt with that answer.
create function pg_temp.shot_envelope(p_key text) returns text language plpgsql as $$
declare v_descriptor jsonb := public.qorpera_native_office_descriptor(current_setting('qorpera_test.binding')::jsonb);
begin
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.binding')::jsonb) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'computer_screenshot', 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'arguments', '{"kind":"screenshot","surface":"desktop"}'::jsonb,
			'target', jsonb_build_object('realm', 'company_computer', 'binding', current_setting('qorpera_test.lease')::jsonb -> 'binding',
				'resources', v_descriptor -> 'resources'),
			'requiresCompanyRevision', false))::text;
end $$;
do $$
declare v_screen jsonb := public.qorpera_native_office_screen(current_setting('qorpera_test.binding')::jsonb,
	current_setting('qorpera_test.scope')::jsonb, 'acquire');
begin
	if v_screen ->> 'state' is distinct from 'admitted' then raise exception 'A: Ada''s screen is hers: %', v_screen; end if;
	perform set_config('qorpera_test.lease', (v_screen -> 'lease')::text, false);
end $$;
select set_config('qorpera_test.envelope', pg_temp.shot_envelope('shot-1'), false);
select set_config('qorpera_test.image', jsonb_build_object('sha256', repeat('e', 64), 'bytes', 4096, 'mediaType', 'image/png',
	'width', 1920, 'height', 1200)::text, false);
create function pg_temp.call(p_fn text, p_action text, p_receipt uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	if p_fn = 'operation' then
		v := public.qorpera_native_office_operation(current_setting('qorpera_test.binding')::jsonb, current_setting('qorpera_test.scope')::jsonb,
			current_setting('qorpera_test.lease')::jsonb, current_setting('qorpera_test.envelope'), p_action, p_receipt,
			case when p_receipt is null then null else repeat('9', 64) end);
	else
		v := public.qorpera_native_office_capture(current_setting('qorpera_test.binding')::jsonb, current_setting('qorpera_test.scope')::jsonb,
			current_setting('qorpera_test.lease')::jsonb, current_setting('qorpera_test.envelope'), p_receipt, repeat('9', 64),
			current_setting('qorpera_test.image')::jsonb, p_action);
	end if;
	return v;
end $$;
do $$
declare v_receipt uuid := '89100000-0000-4000-8000-0000000000e1'; v_sha text := encode(extensions.digest(convert_to(
		current_setting('qorpera_test.envelope'), 'UTF8'), 'sha256'), 'hex');
	v_answer jsonb; v_asset jsonb;
begin
	if pg_temp.call('operation', 'authorize', null) ->> 'state' is distinct from 'authorized' then
		raise exception 'A: the screenshot is authorized'; end if;
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, v_receipt,
		'computer_screenshot:shot-1', v_sha, repeat('9', 64), false);
	if pg_temp.call('operation', 'begin', v_receipt) ->> 'state' is distinct from 'admitted' then
		raise exception 'A: the screenshot begins'; end if;
	v_answer := pg_temp.call('capture', 'authorize', v_receipt);
	if v_answer is distinct from '{"state":"authorized","storage":"none"}'::jsonb then
		raise exception 'A: the capture authorizes without storage: %', v_answer; end if;
	v_asset := pg_temp.call('capture', 'publish', v_receipt);
	if v_asset is distinct from current_setting('qorpera_test.image')::jsonb || jsonb_build_object('assetId', v_receipt,
		'screenId', current_setting('qorpera_test.lease')::jsonb #>> '{binding,screenId}', 'surface', 'desktop') then
		raise exception 'A: the capture answers the image under its receipt: %', v_asset; end if;
	if pg_temp.call('operation', 'finish', v_receipt) ->> 'state' is distinct from 'drained' then
		raise exception 'A: the screenshot finishes'; end if;
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, v_receipt, v_sha,
		jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'inputSha256', v_sha,
			'content', jsonb_build_object('kind', 'json', 'value', v_asset)));
	perform set_config('qorpera_test.asset', v_asset::text, false);
end $$;

-- B. Nothing was stored: no artifact, no capture row, no company object.
do $$
begin
	if exists (select 1 from public.qorpera_artifacts where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_office_captures where receipt_id = '89100000-0000-4000-8000-0000000000e1')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010'
			and sha256 = repeat('e', 64)) then
		raise exception 'B: a folder-v2 screenshot stores nothing'; end if;
end $$;

-- C. The receipt is the capture's record: the read and the capture-set check answer the same identity; a changed one is
--    refused.
do $$
declare v_asset jsonb := current_setting('qorpera_test.asset')::jsonb;
begin
	if public.qorpera_read_native_office_capture(current_setting('qorpera_test.binding')::jsonb, (v_asset ->> 'assetId')::uuid)
		is distinct from v_asset then raise exception 'C: the read answers the screenshot'; end if;
	if public.qorpera_assert_native_office_captures(current_setting('qorpera_test.binding')::jsonb, jsonb_build_array(v_asset))
		is distinct from jsonb_build_object('state', 'authorized', 'assets', jsonb_build_array(v_asset)) then
		raise exception 'C: the capture set is authorized'; end if;
	begin
		perform public.qorpera_assert_native_office_captures(current_setting('qorpera_test.binding')::jsonb,
			jsonb_build_array(v_asset || '{"width": 1}'));
		raise exception 'C: a changed capture is refused' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_read_native_office_capture(current_setting('qorpera_test.binding')::jsonb, extensions.gen_random_uuid());
		raise exception 'C: an unknown capture is refused' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
end $$;

-- D. The run goes on: its next operation begins (no open receipt fences it).
do $$
declare v_begun jsonb := public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb,
	'89100000-0000-4000-8000-0000000000e2', 'computer_screenshot:shot-2', repeat('a', 64), repeat('9', 64), false);
begin
	if v_begun ->> 'state' is distinct from 'executing' then raise exception 'D: the run''s next operation begins: %', v_begun; end if;
end $$;

-- E. Once the computer is no longer the agent's to use (it went to maintenance), the screenshot's authority is gone.
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'maintenance' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
do $$
begin
	perform public.qorpera_read_native_office_capture(current_setting('qorpera_test.binding')::jsonb,
		'89100000-0000-4000-8000-0000000000e1');
	raise exception 'E: a screenshot of a computer no longer in use is not readable' using errcode = 'QTF01';
exception when insufficient_privilege then null;
end $$;

-- F. Exactly the patched functions and the helper name this migration.
do $$
begin
	if (select count(*) from pg_proc where prosrc ~ '20260930030200') <> 4 then
		raise exception 'F: 3 patched functions and the helper name 20260930030200 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930030200'); end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 850 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_offices uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	select array_agg(id) into v_offices from public.qorpera_runtime_offices where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('office_id','profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' and c.table_name <> 'qorpera_runtime_offices'
		order by c.column_name = 'office_id' desc loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'office_id' then v_offices when 'profile_id' then v_profiles
			when 'environment_id' then v_envs when 'run_id' then v_runs when 'job_id' then v_jobs
			when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_runtime_offices where id = any (v_offices);
	delete from public.qorpera_logical_computers where profile_id = any (v_profiles);
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_runtime_offices where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_logical_computers where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The fixture must be removed'; end if;
end $$;
