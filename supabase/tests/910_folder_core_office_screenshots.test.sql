-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core P06d part 2 (20260930057000): an agent's screenshot of the Company Computer on a folder-v2
-- company, stored nowhere. Its capture authorizes with storage none and publishes the image's identity under the
-- operation's receipt; nothing is stored; the office resource keeps the resources it was taken under. The read, the
-- capture-set check and the context view accept it while the agent's access, the computer's privacy and the browser
-- grant are as they were, also with the computer not running, and refuse it once any of them changed, for another
-- run's receipt, or a changed identity. Folder-v2 only (the founder's decision of 3 October). 648's committed fixture;
-- everything is removed at the end. H (20260930183000): a shell start's begin on the same screen makes its command's row.

create function pg_temp.claims(p_conn text, p_role text, p_user text default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
		jsonb_strip_nulls(jsonb_build_object('role', p_role, 'sub', p_user))::text));
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

-- Ada's screen on the folder-v2 computer is hers (acquire).
do $$
declare v_screen jsonb := public.qorpera_native_office_screen(current_setting('qorpera_test.binding')::jsonb,
	current_setting('qorpera_test.scope')::jsonb, 'acquire');
begin
	if v_screen ->> 'state' is distinct from 'admitted' then raise exception 'Setup: Ada''s screen is hers: %', v_screen; end if;
	perform set_config('qorpera_test.lease', (v_screen -> 'lease')::text, false);
end $$;
-- An operation of Ada's run on her screen, as the runtime sends it.
create function pg_temp.envelope(p_key text, p_arguments jsonb) returns text language plpgsql as $$
declare v_descriptor jsonb := public.qorpera_native_office_descriptor(current_setting('qorpera_test.binding')::jsonb);
begin
	return jsonb_build_object('schema', 'qorpera.cloud-tool-operation/v2',
		'principals', (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.binding')::jsonb) -> 'identity')
			- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation', jsonb_build_object('tool', 'computer_' || (p_arguments ->> 'kind'), 'toolVersion', 'qorpera.company-computer-tools/v2',
			'logicalOperationKey', p_key, 'arguments', p_arguments,
			'target', jsonb_build_object('realm', 'company_computer', 'binding', current_setting('qorpera_test.lease')::jsonb -> 'binding',
				'resources', v_descriptor -> 'resources'),
			'requiresCompanyRevision', false))::text;
end $$;
-- The office operation's answer, or its error as "<sqlstate> <message>".
create function pg_temp.operation(p_envelope text, p_action text, p_receipt uuid) returns text language plpgsql as $$
begin
	return public.qorpera_native_office_operation(current_setting('qorpera_test.binding')::jsonb,
		current_setting('qorpera_test.scope')::jsonb, current_setting('qorpera_test.lease')::jsonb, p_envelope, p_action, p_receipt,
		case when p_receipt is null then null else repeat('9', 64) end)::text;
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.sha(p_envelope text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
$$;


-- The office capture's answer, or its error as "<sqlstate> <message>".
create function pg_temp.capture(p_envelope text, p_action text, p_receipt uuid, p_image jsonb) returns text language plpgsql as $$
begin
	return public.qorpera_native_office_capture(current_setting('qorpera_test.binding')::jsonb,
		current_setting('qorpera_test.scope')::jsonb, current_setting('qorpera_test.lease')::jsonb, p_envelope, p_receipt, repeat('9', 64),
		p_image, p_action)::text;
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
-- A call's answer, or its error as "<sqlstate> <message>".
create function pg_temp.answer(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	execute p_sql into v;
	return v;
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.read(p_asset uuid) returns text language sql as $$
	select pg_temp.answer(format('select public.qorpera_read_native_office_capture(%L, %L)::text',
		current_setting('qorpera_test.binding'), p_asset))
$$;
create function pg_temp.assert(p_assets jsonb) returns text language sql as $$
	select pg_temp.answer(format('select public.qorpera_assert_native_office_captures(%L, %L)::text',
		current_setting('qorpera_test.binding'), p_assets))
$$;
-- Ada takes a desktop screenshot under operation key p_key, as the runtime and the office service do: the operation's
-- authorize and begin, the capture's authorize and publish, the finish, and the receipt completed with the answer.
create function pg_temp.shoot(p_key text, p_receipt uuid) returns jsonb language plpgsql as $$
declare v_envelope text := pg_temp.envelope(p_key, '{"kind":"screenshot","surface":"desktop"}'); v_answer text; v_asset jsonb;
	v_image jsonb := jsonb_build_object('sha256', encode(extensions.digest(p_key, 'sha256'), 'hex'), 'bytes', 4096,
		'mediaType', 'image/png', 'width', 1920, 'height', 1200);
begin
	v_answer := pg_temp.operation(v_envelope, 'authorize', null);
	if v_answer is distinct from '{"state": "authorized"}' then raise exception 'Shot %: authorized: %', p_key, v_answer; end if;
	perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, p_receipt,
		'computer_screenshot:' || p_key, pg_temp.sha(v_envelope), repeat('9', 64), false);
	v_answer := pg_temp.operation(v_envelope, 'begin', p_receipt);
	if v_answer !~ '"state": "admitted"' then raise exception 'Shot %: admitted: %', p_key, v_answer; end if;
	v_answer := pg_temp.capture(v_envelope, 'authorize', p_receipt, v_image);
	if v_answer is distinct from '{"state": "authorized", "storage": "none"}' then
		raise exception 'Shot %: the capture is stored nowhere: %', p_key, v_answer; end if;
	v_answer := pg_temp.capture(v_envelope, 'publish', p_receipt, v_image);
	if v_answer !~ '^[{]' then raise exception 'Shot %: published: %', p_key, v_answer; end if;
	v_asset := v_answer::jsonb;
	if v_asset is distinct from v_image || jsonb_build_object('assetId', p_receipt,
			'screenId', current_setting('qorpera_test.lease')::jsonb #>> '{binding,screenId}', 'surface', 'desktop') then
		raise exception 'Shot %: the identity under the receipt: %', p_key, v_asset; end if;
	v_answer := pg_temp.operation(v_envelope, 'finish', p_receipt);
	if v_answer is distinct from '{"state": "drained"}' then raise exception 'Shot %: finished: %', p_key, v_answer; end if;
	perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, p_receipt, pg_temp.sha(v_envelope),
		jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'inputSha256', pg_temp.sha(v_envelope),
			'content', jsonb_build_object('kind', 'json', 'value', v_asset)));
	return v_asset;
end $$;
-- Ada's run has its launch provenance, so its context views record (652's recipe).
set session_replication_role = replica;
insert into public.qorpera_native_execution_launches(run_id, runtime_bundle_id, runtime_bundle_sha256, binary_sha256, reasoning_effort,
	reasoning_policy_sha256, tool_catalog_text, context_sha256, context_bytes)
values ('64800000-0000-4000-8000-0000000000f1', extensions.gen_random_uuid(), repeat('b', 64), repeat('c', 64), 'low', repeat('d', 64),
	'{}', repeat('e', 64), 1);
set session_replication_role = origin;

-- A. Ada's desktop screenshot is stored nowhere: its identity is published under the operation's receipt, the receipt
--    completes with it, its office resource keeps the resources it was taken under, and no artifact, capture row or
--    company object exists.
do $$
declare v_asset jsonb := pg_temp.shoot('shot-1', '91000000-0000-4000-8000-0000000000e1');
begin
	perform set_config('qorpera_test.asset', v_asset::text, false);
	if (select target_resources from public.qorpera_runtime_office_resources where receipt_id = '91000000-0000-4000-8000-0000000000e1')
			is distinct from public.qorpera_native_office_descriptor(current_setting('qorpera_test.binding')::jsonb) -> 'resources' then
		raise exception 'A: the resource keeps the resources the screenshot was taken under'; end if;
	if exists (select 1 from public.qorpera_artifacts where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_runtime_office_captures where receipt_id = '91000000-0000-4000-8000-0000000000e1')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010'
			and sha256 = v_asset ->> 'sha256') then
		raise exception 'A: a folder-v2 screenshot stores nothing'; end if;
end $$;

-- B. The receipt is the capture's record: the read and the capture-set check answer it; a changed identity, an unknown
--    one, and another run's receipt are refused.
do $$
declare v_asset jsonb := current_setting('qorpera_test.asset')::jsonb; v_answer text;
begin
	if pg_temp.read((v_asset ->> 'assetId')::uuid)::jsonb is distinct from v_asset then raise exception 'B: the read answers it'; end if;
	if pg_temp.assert(jsonb_build_array(v_asset))::jsonb is distinct from jsonb_build_object('state', 'authorized', 'assets',
			jsonb_build_array(v_asset)) then raise exception 'B: the capture set is authorized'; end if;
	v_answer := pg_temp.assert(jsonb_build_array(v_asset || '{"width": 1}'));
	if v_answer !~ '^42501 Office capture authority changed' then raise exception 'B: a changed identity is refused: %', v_answer; end if;
	v_answer := pg_temp.read(extensions.gen_random_uuid());
	if v_answer !~ '^42501 ' then raise exception 'B: an unknown screenshot is refused: %', v_answer; end if;
	set local session_replication_role = replica;
	-- Another run's screenshot: its receipt and its resource both name that run. (Replica mode: the other run need not
	-- exist for them to name it.)
	perform set_config('qorpera_test.other_run', extensions.gen_random_uuid()::text, true);
	update public.qorpera_run_operation_receipts set run_id = current_setting('qorpera_test.other_run')::uuid
	where id = (v_asset ->> 'assetId')::uuid;
	update public.qorpera_runtime_office_resources set run_id = current_setting('qorpera_test.other_run')::uuid
	where receipt_id = (v_asset ->> 'assetId')::uuid;
	v_answer := pg_temp.assert(jsonb_build_array(v_asset));
	if v_answer !~ '^42501 ' then raise exception 'B: another run''s receipt is refused: %', v_answer; end if;
	update public.qorpera_run_operation_receipts set run_id = '64800000-0000-4000-8000-0000000000f1'
	where id = (v_asset ->> 'assetId')::uuid;
	update public.qorpera_runtime_office_resources set run_id = '64800000-0000-4000-8000-0000000000f1'
	where receipt_id = (v_asset ->> 'assetId')::uuid;
end $$;

-- C. The computer not running (here in maintenance) does not withdraw the screenshot: an idle power-off must not end
--    the run at its next model request.
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'maintenance' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;
do $$
declare v_asset jsonb := current_setting('qorpera_test.asset')::jsonb;
begin
	if pg_temp.read((v_asset ->> 'assetId')::uuid)::jsonb is distinct from v_asset then
		raise exception 'C: a screenshot of a computer that is not running is still readable'; end if;
end $$;
set session_replication_role = replica;
update public.qorpera_runtime_offices set state = 'active' where id = current_setting('qorpera_test.office_id')::uuid;
set session_replication_role = origin;

-- D. A privacy change, a member's private session, a changed or revoked grant, and a browser grant the screenshot was
--    taken under that is no longer active, each withdraw it.
do $$
declare v_asset jsonb := current_setting('qorpera_test.asset')::jsonb; v_change text; v_answer text;
begin
	set local session_replication_role = replica;
	foreach v_change in array array[
		'update public.qorpera_runtime_offices set privacy_version = privacy_version + 1 where id = %L',
		'update public.qorpera_runtime_offices set privacy_state = ''private'' where id = %L',
		'update public.qorpera_runtime_office_access set version = version + 1 where office_id = %L',
		'update public.qorpera_runtime_office_access set state = ''revoked'' where office_id = %L',
		'update public.qorpera_runtime_office_resources set target_resources = target_resources || jsonb_build_object(''browserProfileId'',
			extensions.gen_random_uuid(), ''browserGrantId'', extensions.gen_random_uuid(), ''browserGrantVersion'', 1)
			where office_id = %L'] loop
		begin
			execute format(v_change, current_setting('qorpera_test.office_id'));
			v_answer := pg_temp.read((v_asset ->> 'assetId')::uuid);
			if v_answer !~ '^42501 Office capture authority changed' then
				raise exception 'D: % withdraws the screenshot: %', v_change, v_answer; end if;
			raise exception 'undo' using errcode = 'QTU01';
		exception when sqlstate 'QTU01' then null;
		end;
	end loop;
	if pg_temp.read((v_asset ->> 'assetId')::uuid)::jsonb is distinct from v_asset then raise exception 'D: each change was undone'; end if;
end $$;

-- E. The folder-v2 context view records a view with the screenshot, and refuses a changed one.
do $$
declare v_asset jsonb := current_setting('qorpera_test.asset')::jsonb; v_view jsonb; v_answer text;
begin
	v_view := jsonb_build_object('schema', 'qorpera.native-context-view/v1', 'requestId', 'req-1', 'threadId', 't', 'turnId', null,
		'purpose', 'turn', 'outputs', jsonb_build_array(jsonb_build_object('callId', 'c1', 'kind', 'function_call_output',
			'sha256', repeat('8', 64), 'bytes', 10, 'readId', null, 'readSha256', null, 'includedBytes', null, 'includedSha256', null,
			'capture', v_asset)));
	v_answer := pg_temp.answer(format('select public.qorpera_record_native_context_view(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', current_setting('qorpera_test.binding'), v_view));
	if v_answer !~ '"ordinal": 1' then raise exception 'E: the view with the screenshot records: %', v_answer; end if;
	v_answer := pg_temp.answer(format('select public.qorpera_record_native_context_view(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', current_setting('qorpera_test.binding'),
		jsonb_set(jsonb_set(v_view, '{requestId}', '"req-2"'), '{outputs,0,capture,width}', '1')));
	if v_answer !~ '^42501 Office capture authority changed' then raise exception 'E: a changed screenshot is refused: %', v_answer; end if;
end $$;

-- F. A set of 64 screenshots is checked with one authority read, well within the runtime's 3 s budget for a batch.
do $$
declare v_asset jsonb := current_setting('qorpera_test.asset')::jsonb; v_at timestamptz := clock_timestamp(); v_answer text;
begin
	v_answer := pg_temp.assert((select jsonb_agg(v_asset) from generate_series(1, 64)));
	if v_answer !~ '"state": "authorized"' or clock_timestamp() - v_at > interval '2 seconds' then
		raise exception 'F: 64 screenshots are checked at once (% ms): %',
			extract(milliseconds from clock_timestamp() - v_at), left(v_answer, 200); end if;
end $$;

-- G. Exactly the patched functions and the new one name this migration.
do $$
begin
	if (select count(*) from pg_proc where prosrc ~ '20260930057000') <> 6 then
		raise exception 'G: 5 patched functions and 1 new one name 20260930057000 (found %)',
			(select count(*) from pg_proc where prosrc ~ '20260930057000'); end if;
end $$;

-- H. 20260930183000 (C1B §8): a shell start's begin makes its command's row before the guest runs anything, keyed by
--    the start's receipt, with the screen's generation, the run's member and whether the command uses the network
--    (absent: it does not); the office's report fills in the guest's session id later. The older one-shot form and
--    the other shell actions make no row.
do $$
declare v_envelope text; v_answer text; v_receipt uuid; v_n integer := 0; v_arguments jsonb;
	v_run public.qorpera_execution_runs; v_office public.qorpera_runtime_offices; v_screen public.qorpera_runtime_office_screens;
begin
	select * into v_run from public.qorpera_execution_runs where id = '64800000-0000-4000-8000-0000000000f1';
	select * into v_office from public.qorpera_runtime_offices where id = current_setting('qorpera_test.office_id')::uuid;
	select * into v_screen from public.qorpera_runtime_office_screens
	where id = (current_setting('qorpera_test.lease')::jsonb #>> '{binding,screenId}')::uuid;
	foreach v_arguments in array array[
		'{"kind":"shell","action":"start","command":"make all","waitMs":0}',
		'{"kind":"shell","action":"start","command":"npm ci","network":true,"waitMs":10000}',
		'{"kind":"shell","action":"start","command":"make test","network":false,"waitMs":0}',
		'{"kind":"shell","command":"ls","timeoutMs":1000}',
		'{"kind":"shell","action":"list"}']::jsonb[] loop
		v_n := v_n + 1;
		v_receipt := ('91000000-0000-4000-8000-0000000000f' || v_n)::uuid;
		v_envelope := pg_temp.envelope('shell-' || v_n, v_arguments);
		v_answer := pg_temp.operation(v_envelope, 'authorize', null);
		if v_answer is distinct from '{"state": "authorized"}' then raise exception 'H: % is authorized: %', v_arguments, v_answer; end if;
		perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, v_receipt,
			'computer_shell:shell-' || v_n, pg_temp.sha(v_envelope), repeat('9', 64), false);
		v_answer := pg_temp.operation(v_envelope, 'begin', v_receipt);
		if v_answer !~ '"state": "admitted"' then raise exception 'H: % begins: %', v_arguments, v_answer; end if;
		if v_arguments ->> 'action' is distinct from 'start' then
			if exists (select 1 from public.qorpera_runtime_office_shell_commands where id = v_receipt or receipt_id = v_receipt) then
				raise exception 'H: % makes no row', v_arguments; end if;
		elsif not exists (select 1 from public.qorpera_runtime_office_shell_commands c
			where c.id = v_receipt and c.receipt_id = v_receipt and c.command_id is null and c.office_id = v_office.id
				and c.computer_generation = v_office.generation and c.screen_id = v_screen.id and c.screen_generation = v_screen.generation
				and c.staff_agent_id = v_run.staff_agent_id and c.run_id = v_run.id
				and c.requested_by_user_id is not distinct from v_run.requested_by_user_id and c.conversation_run_id = v_run.id
				and c.session_id is not distinct from v_run.session_id and c.command = v_arguments ->> 'command'
				and c.network = coalesce((v_arguments ->> 'network')::boolean, false) and c.ended_at is null and c.told_at is null) then
			raise exception 'H: % makes its row: %', v_arguments, (select to_jsonb(c) from public.qorpera_runtime_office_shell_commands c
				where c.id = v_receipt); end if;
		-- The operation ends, as the office service and the runtime end it (a run has one open operation at a time).
		v_answer := pg_temp.operation(v_envelope, 'finish', v_receipt);
		if v_answer is distinct from '{"state": "drained"}' then raise exception 'H: % finishes: %', v_arguments, v_answer; end if;
		perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.binding')::jsonb, v_receipt,
			pg_temp.sha(v_envelope), jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'inputSha256',
				pg_temp.sha(v_envelope), 'content', jsonb_build_object('kind', 'json', 'value', '{}'::jsonb)));
	end loop;
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
