do $$ begin
	if to_regprocedure('public.qorpera_authorize_machine_account_fill(jsonb,jsonb,uuid,text)') is not null then
		raise exception '20260930781000 is already applied'; end if;
	if to_regprocedure('public.qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text)') is null
		or to_regprocedure('public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)') is null
		or to_regprocedure('public.qorpera_company_computer_fill_key_valid(text)') is null
		or to_regprocedure('public.qorpera_machine_desktop_picture_check(uuid,bigint,uuid)') is null then
		raise exception '20260930781000 needs company accounts (20260928429975, 20260930072000), save from the machine (20260930705000) and member desktop control (20260930713000)';
	end if;
end $$;

set local lock_timeout = '3s';

-- 1. The call's arguments ---------------------------------------------------------------------------------------------------

-- fill_company_account's arguments, as the machine tools record them: the call's key, the machine's name, the account's id
-- (as find and open answer it, in lower case) and which of its values. Exactly these four, each a string.
create function public.qorpera_valid_machine_account_fill_call(p_args jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
	if jsonb_typeof(p_args) is distinct from 'object'
		or p_args - array['operationKey', 'machine', 'account', 'field'] <> '{}'::jsonb
		or not (p_args ?& array['operationKey', 'machine', 'account', 'field']) then
		return false; end if;
	if exists (select 1 from jsonb_each(p_args) as field where jsonb_typeof(field.value) <> 'string') then
		return false; end if;
	return (p_args ->> 'operationKey') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		and (p_args ->> 'machine') ~ '^[a-z0-9][a-z0-9-]{0,39}$'
		and (p_args ->> 'account') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		and (p_args ->> 'field') in ('login', 'password', 'code');
end
$$;
revoke all on function public.qorpera_valid_machine_account_fill_call(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One fill_company_account call's operation envelope, or null: the machine tools' call of exactly that shape, its target
-- the machine (and nothing else), its key the call's own. Read before any lock.
create function public.qorpera_machine_account_fill_operation(p_envelope text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
	v_envelope jsonb;
	v_operation jsonb;
begin
	if p_envelope is null or octet_length(p_envelope) > 65536 then return null; end if;
	begin
		v_envelope := p_envelope::jsonb;
	exception when others then
		return null;
	end;
	v_operation := v_envelope -> 'operation';
	if jsonb_typeof(v_envelope) is distinct from 'object'
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or jsonb_typeof(v_operation) is distinct from 'object'
		or v_operation ->> 'tool' is distinct from 'fill_company_account'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.machine-tools/v1'
		or v_operation -> 'requiresCompanyRevision' is distinct from 'false'::jsonb
		or not coalesce(public.qorpera_valid_machine_account_fill_call(v_operation -> 'arguments'), false)
		or v_operation #>> '{arguments,operationKey}' is distinct from v_operation ->> 'logicalOperationKey'
		or jsonb_typeof(v_operation -> 'target') is distinct from 'object'
		or (v_operation -> 'target') - array['realm', 'machineId'] <> '{}'::jsonb
		or v_operation #>> '{target,realm}' is distinct from 'company_machine'
		or coalesce(v_operation #>> '{target,machineId}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', true) then
		return null;
	end if;
	return v_operation;
end
$$;
revoke all on function public.qorpera_machine_account_fill_operation(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The coding executor's read: where the machine runs, and the helper's target ---------------------------------------------

-- The executor runs the helper only after this read, on the machine's node (or forwards the call to that node's executor,
-- which reads it again). The run's live tool authority in a company conversation on the company folder; the call and its
-- own executing receipt; a company agent's run, not a worker's, of a company neither paused nor being deleted. What the agent
-- can act on is answered (state refused, with a reason): accounts switched off, a machine not running now, no such open
-- account. Every other failure raises. Plain reads; writes nothing.
create function public.qorpera_authorize_machine_account_fill(p_binding jsonb, p_scope jsonb, p_receipt_id uuid,
	p_envelope text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_operation jsonb;
	v_identity jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_account public.qorpera_company_accounts%rowtype;
	v_schema constant text := 'qorpera.machine-account-fill-authority/v1';
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_scope) is distinct from 'object'
		or p_scope - 'machineId' <> '{}'::jsonb or coalesce(p_scope ->> 'machineId' !~ v_uuid, true) or p_receipt_id is null then
		raise exception 'Machine account fill request is malformed' using errcode = '22023'; end if;
	v_operation := public.qorpera_machine_account_fill_operation(p_envelope);
	if v_operation is null or v_operation #>> '{target,machineId}' is distinct from p_scope ->> 'machineId' then
		raise exception 'Machine account fill request is malformed' using errcode = '22023'; end if;
	-- The run's live tool authority: a company conversation's run on the company folder.
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	if v_identity ->> 'audienceKind' is distinct from 'company' then
		raise exception 'Machines belong to company conversations' using errcode = '42501'; end if;
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Accounts need a company on the company folder' using errcode = '0A000'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = (p_binding ->> 'runId')::uuid;
	-- This call's own receipt, still executing.
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or v_receipt.requires_company_revision is distinct from false
		or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
		or v_receipt.logical_operation_key is distinct from 'fill_company_account:' || (v_operation ->> 'logicalOperationKey') then
		raise exception 'Machine account fill receipt is unavailable' using errcode = '42501'; end if;
	-- A company agent's own run, never a worker's; a company not paused and not being deleted.
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Machine account fill authority is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if public.qorpera_company_deleting(v_run.profile_id) then
		raise exception 'This company is being deleted' using errcode = '55000'; end if;
	-- The agent hears these.
	if not coalesce((select settings.enabled from public.qorpera_company_account_settings as settings), false) then
		return jsonb_build_object('schema', v_schema, 'state', 'refused', 'reason', 'ACCOUNTS_SWITCHED_OFF'); end if;
	-- The machine the call names, of the run's company and environment.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = (p_scope ->> 'machineId')::uuid and machine.profile_id = v_run.profile_id
		and machine.environment_id = v_run.environment_id and machine.removed_at is null
		and machine.name = v_operation #>> '{arguments,machine}';
	if not found then
		raise exception 'Machine account fill authority is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', v_schema, 'state', 'refused', 'reason', 'MACHINE_NOT_RUNNING',
			'machine', v_machine.name); end if;
	if coalesce(v_machine.desktop_member_until > clock_timestamp(), false) then
		return jsonb_build_object('schema', v_schema, 'state', 'refused', 'reason', 'DESKTOP_MEMBER_IN_CONTROL',
			'machine', v_machine.name); end if;
	-- The company's open website account the call names: its site and sign-in hosts are where its values may be typed.
	select account.* into v_account from public.qorpera_company_accounts as account
	join public.qorpera_cloud_secrets as secret on secret.id = account.secret_id
	where account.secret_id = (v_operation #>> '{arguments,account}')::uuid and account.profile_id = v_run.profile_id
		and account.environment_id = v_run.environment_id and account.status <> 'closed'
		and secret.profile_id = v_run.profile_id and secret.environment_id = v_run.environment_id
		and secret.connector_id = 'website' and secret.owner_kind = 'company' and secret.status = 'active';
	if not found then
		return jsonb_build_object('schema', v_schema, 'state', 'refused', 'reason', 'ACCOUNT_NOT_OPEN'); end if;
	return jsonb_build_object(
		'schema', v_schema,
		'state', 'authorized',
		-- Where it runs: the executor of its node, and the instance there.
		'machineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'executorOwner', v_placement.owner,
		'providerId', v_placement.binding ->> 'providerId',
		'receiptId', p_receipt_id,
		'companyId', v_run.profile_id,
		'desktopGeneration', v_machine.desktop_member_generation,
		-- What the helper binds the box to, and the pages it checks before the vault is asked.
		'target', jsonb_build_object(
			'schema', 'qorpera.machine-account-fill-target/v1',
			'companyId', v_run.profile_id,
			'companyMachineId', v_machine.id,
			'placementId', v_placement.id,
			'bootId', v_placement.boot_id,
			'receiptId', p_receipt_id,
			'accountId', v_account.secret_id,
			'field', v_operation #>> '{arguments,field}',
			'hosts', to_jsonb(array[v_account.site] || v_account.sign_in_hosts)));
end
$$;
revoke all on function public.qorpera_authorize_machine_account_fill(jsonb, jsonb, uuid, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_authorize_machine_account_fill(jsonb, jsonb, uuid, text) to service_role;

-- 3. The broker's read for one machine fill ------------------------------------------------------------------------------------

-- The vault's read for one fill_company_account call, asked by the machine's executor with the helper's public key. Bound to
-- the agent's executing receipt of exactly this call (its SHA-256 is the receipt's input digest), the company's own open
-- website account, and the company machine the call names, running on the placement and boot the executor names, under
-- that executor. Authorization by plain read before any lock, every comparison null-safe; then the run check, the run's
-- kind, the machine (plain reads), the account's secret and row (rank 8), and last the receipt.
create function public.qorpera_fill_company_account_on_machine(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text,
	p_executor_owner text,
	p_placement_id uuid,
	p_boot_id uuid,
	p_fill_public_key text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_operation jsonb;
	v_account_id uuid;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_account public.qorpera_company_accounts%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if not coalesce((select settings.enabled from public.qorpera_company_account_settings as settings), false) then
		raise exception 'Company accounts are switched off' using errcode = '0A000';
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'company account run binding is malformed' using errcode = '22023';
	end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	if not found or p_broker_capability_sha256 is null or v_authority.status is distinct from 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	if coalesce((p_binding ->> 'jobId') !~ v_uuid, true)
		or not exists (select 1 from public.qorpera_runner_jobs as job
			where job.id = (p_binding ->> 'jobId')::uuid and job.profile_id = v_authority.profile_id) then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- Only the company folder is served, decided through the authority's job before any lock.
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Accounts need a company on the company folder' using errcode = '0A000';
	end if;
	-- The call itself: one fill_company_account of a company machine, read before any lock.
	v_operation := public.qorpera_machine_account_fill_operation(p_envelope);
	if v_operation is null then
		raise exception 'company account fill call is malformed' using errcode = '22023';
	end if;
	v_account_id := (v_operation #>> '{arguments,account}')::uuid;
	-- Where the executor runs the helper, and the helper's key: the executor's own words, checked against SQL below.
	if p_executor_owner is null or p_placement_id is null or p_boot_id is null
		or not coalesce(public.qorpera_company_computer_fill_key_valid(p_fill_public_key), false) then
		raise exception 'company machine fill key is unavailable' using errcode = '42501';
	end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- A company agent's own run, never a worker's: a plain read. Accounts are the company's, so no requester role is asked
	-- (as the office's fill and an opening ask none).
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'company account fill authority is unavailable' using errcode = '42501';
	end if;
	-- The company machine the call names, of the run's company and environment, running now on its current placement,
	-- reserved and with a known boot: exactly the placement, boot and executor the executor names. Plain reads, as the
	-- executor's own read.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = (v_operation #>> '{target,machineId}')::uuid and machine.profile_id = v_run.profile_id
		and machine.environment_id = v_run.environment_id and machine.removed_at is null
		and machine.name = v_operation #>> '{arguments,machine}';
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.id is null or v_machine.desired_state is distinct from 'running' or v_placement.id is null
		or v_placement.running_at is null or v_placement.boot_id is null
		or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false)
		or v_placement.id is distinct from p_placement_id or v_placement.boot_id is distinct from p_boot_id
		or v_placement.owner is distinct from p_executor_owner then
		raise exception 'company machine is not running' using errcode = '42501';
	end if;
	-- Rank 8: the account's secret, then its row.
	v_account := public.qorpera_company_account_locked(v_run.profile_id, v_run.environment_id, v_authority.id,
		v_account_id);
	-- Run-owned rows after the vault rows (C1C §5.7): this fill_company_account call's receipt.
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id
	for update;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or v_receipt.requires_company_revision is distinct from false
		or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or v_receipt.downstream_idempotency_sha256 is distinct from p_downstream_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from 'fill_company_account:' || (v_operation ->> 'logicalOperationKey') then
		raise exception 'company account fill receipt is unavailable' using errcode = '42501';
	end if;
	select version.* into v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id = v_account_id
		and version.version = (select secret.current_version from public.qorpera_cloud_secrets as secret where secret.id = v_account_id);
	if not found or v_version.broker_authority_id is distinct from v_authority.id
		or v_version.key_id is distinct from v_authority.key_id then
		raise exception 'company account version is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_company_accounts as account
	set last_used_at = statement_timestamp(), last_used_by_staff_agent_id = v_run.staff_agent_id,
		updated_at = statement_timestamp()
	where account.secret_id = v_account_id;
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_run.profile_id, v_run.environment_id, v_account_id, v_version.version, v_run.id, p_receipt_id,
		'account_used', v_run.created_by_user_id, 'website');
	return public.qorpera_company_account_descriptor(v_account, v_version.version) || jsonb_build_object(
		'schema', 'qorpera.company-account-machine-fill-context/v1',
		-- The envelope's associated data, for the broker to open it.
		'companyId', v_account.profile_id,
		'environmentId', v_account.environment_id,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		-- What the sealed box is bound to.
		'receiptId', p_receipt_id,
		'field', v_operation #>> '{arguments,field}',
		'companyMachineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'fillPublicKey', p_fill_public_key
	);
end
$$;
revoke all on function public.qorpera_fill_company_account_on_machine(uuid,text,jsonb,uuid,text,text,text,uuid,uuid,text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_fill_company_account_on_machine(uuid,text,jsonb,uuid,text,text,text,uuid,uuid,text)
	to qorpera_secret_broker;

-- 4. The operations a run's observations may name, after save_coding_value (20260930705000) ---------------------------------

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_fill_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930781000' in v_definition) > 0 then
		raise exception '20260930781000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930781000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930781000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

do $$ begin execute pg_temp.machine_fill_patched('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	array[$old$/* 20260930705000 */'save_coding_value',$old$,
	$new$/* 20260930705000 */'save_coding_value',/* 20260930781000 */'fill_company_account',$new$]); end $$;

drop function pg_temp.machine_fill_patched(regprocedure, text[]);

-- 5. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_valid_machine_account_fill_call(jsonb)',
		'public.qorpera_machine_account_fill_operation(text)',
		'public.qorpera_authorize_machine_account_fill(jsonb,jsonb,uuid,text)',
		'public.qorpera_fill_company_account_on_machine(uuid,text,jsonb,uuid,text,text,text,uuid,uuid,text)',
		'public.qorpera_record_runtime_observation(uuid,jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930781000') = 0 then
			raise exception '20260930781000 marker is missing in %', v_function; end if;
	end loop;
	-- The office's fill and save_coding_value keep their own.
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text)'::regprocedure),
			'20260930072000') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
			'20260930705000') = 0 then
		raise exception '20260930781000: an earlier marker is lost'; end if;
end $guard$;
