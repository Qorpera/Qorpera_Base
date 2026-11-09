-- 20260930705000: an agent saves a coding value from its company machine (Jonas, 9 November 2026: "Save from the
-- machine").
--
-- Production has no offices since 3 October; agents work on their own company machines, which have a desktop with
-- Chromium (#1576). There the agent makes the key on the service's site itself and presses the site's Copy, so the key
-- is on the machine's clipboard; then it calls save_coding_value {operationKey, machine, service, variable, repository,
-- purpose}, which never takes the value. The coding executor runs a fixed helper on the machine (shipped in its image)
-- that reads the clipboard, checks the value against the service's pattern, seals it to the value's capture key and
-- clears the clipboard; the secret broker opens the box and stores it, as for an office's capture (20260930695000). The
-- agent shares the machine with the browser, so it has seen the key: what this keeps is that the key is never stored
-- outside the vault and is in no tool input, tool output, chat, run history or company file.
-- * qorpera_valid_machine_coding_value_call: save_coding_value's arguments, checked as vault_capture's codingValue is
--   (the service seeded, the variable a name a coding value may have, the repository owner/name in lower case, the
--   purpose 1 to 300 characters of trimmed text), with the call's key and the machine's name. Granted to no role.
-- * qorpera_folder_coding_value_capture_context, the core of the broker's four calls, takes a second call: the agent's
--   executing save_coding_value receipt of exactly this call (receipt key save_coding_value:<operationKey>), bound to
--   the company machine it names, of the run's company and environment, running now on its current placement, reserved
--   and with a known boot (plain reads, as machine_run's command authority reads them; the machine is the company's, so
--   any agent of the company may use it), in place of the computer_browser call and the run's office screen lease. The
--   rest is unchanged and in the same order: the run check with the requester's member row FOR SHARE, a company
--   agent's run and not a worker's, the company not being deleted, the requester an owner or admin, the capture key FOR
--   UPDATE, the secrets FOR UPDATE, and last the receipt FOR UPDATE. It answers the machine, its placement and its boot
--   beside the computer and its generation (one pair is null), so its answer's type changes: it is made again, its
--   body patched, and granted to no role as before.
-- * qorpera_folder_read_coding_value_capture names the machine, its placement and its boot instead of the computer
--   and its generation for such a call: the broker opens the machine's box under them. Describe, prepare and store
--   are unchanged: they take the new call through the context.
-- * qorpera_authorize_machine_coding_value, the coding executor's read (service_role): the run's live tool authority
--   in a company conversation on the company folder; the call's own executing receipt; a company agent's run, not a
--   worker's, of a company neither paused nor being deleted, whose requester is an owner or admin; the machine running
--   (else MACHINE_NOT_RUNNING); the service and a current capture key, as the office's read checks it. It answers where
--   the machine runs (its executor) and what the helper seals to and binds the box to. Plain reads; writes nothing.
-- * save_coding_value joins the operations a run's observations may name.
-- Every new or patched body names this migration (20260930705000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)') is not null then
		raise exception '20260930705000 is already applied'; end if;
	if to_regprocedure('public.qorpera_folder_describe_coding_value_capture(uuid,text,jsonb,uuid,text,text)') is null
		or to_regprocedure('public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)') is null then
		raise exception '20260930705000 needs coding value capture (20260930695000, 20260930698000) and company machines'; end if;
end $$;

set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_save_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930705000' in v_definition) > 0 then
		raise exception '20260930705000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930705000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930705000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The call's arguments ---------------------------------------------------------------------------------------------------

-- save_coding_value's arguments, as the machine tools record them: the call's key and the machine's name, and the coding
-- value's four, checked as qorpera_valid_office_browser_action checks vault_capture's codingValue. Each check runs only
-- after the ones it needs (no null passes). It reads the services table, so it is STABLE.
create function public.qorpera_valid_machine_coding_value_call(p_args jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
begin
	-- 20260930705000: exactly these six, each a string.
	if jsonb_typeof(p_args) is distinct from 'object'
		or p_args - array['operationKey', 'machine', 'service', 'variable', 'repository', 'purpose'] <> '{}'::jsonb
		or not (p_args ?& array['operationKey', 'machine', 'service', 'variable', 'repository', 'purpose']) then
		return false; end if;
	if exists (select 1 from jsonb_each(p_args) as field where jsonb_typeof(field.value) <> 'string') then
		return false; end if;
	return (p_args ->> 'operationKey') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		and (p_args ->> 'machine') ~ '^[a-z0-9][a-z0-9-]{0,39}$'
		and exists (select 1 from public.qorpera_coding_value_services as known where known.service = p_args ->> 'service')
		and public.qorpera_coding_environment_name_allowed(p_args ->> 'variable')
		and (p_args ->> 'repository') ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'
		and char_length(p_args ->> 'purpose') between 1 and 300
		and (p_args ->> 'purpose') = btrim(p_args ->> 'purpose')
		and (p_args ->> 'purpose') !~ '[[:cntrl:]]';
end
$$;
revoke all on function public.qorpera_valid_machine_coding_value_call(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The broker's context: a save_coding_value call on a company machine ----------------------------------------------------

-- Its answer's type changes, so it is made anew from its patched definition (its callers are function bodies, which
-- resolve it when they run), and granted to no role, as before.
do $do$
declare v_definition text := pg_temp.machine_save_patched(
	'public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,jsonb,uuid,text,text,boolean)'::regprocedure,
	array[
	'computer_generation bigint)',
	'computer_generation bigint, company_machine_id uuid, machine_placement_id uuid, machine_boot_id uuid)',
	$old$	v_office public.qorpera_runtime_offices%rowtype;
$old$,
	$new$	v_office public.qorpera_runtime_offices%rowtype;
	-- 20260930705000: a save_coding_value call, the company machine it names and where that machine runs now.
	v_machine_call boolean;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
$new$,
	$old$	v_operation := v_envelope -> 'operation';
	v_target := v_operation #> '{target,binding}';
	v_value := v_operation #> '{arguments,codingValue}';
	if jsonb_typeof(v_envelope) is distinct from 'object'
$old$,
	$new$	v_operation := v_envelope -> 'operation';
	-- 20260930705000: or one save_coding_value of a coding value off a company machine's clipboard: the machine tools'
	-- call, its target the machine, its arguments the value's four with the call's key and the machine's name.
	v_machine_call := coalesce(jsonb_typeof(v_envelope) = 'object' and v_operation ->> 'tool' = 'save_coding_value', false);
	v_target := v_operation #> (case when v_machine_call then '{target}' else '{target,binding}' end)::text[];
	v_value := case when v_machine_call then (v_operation -> 'arguments') - array['operationKey', 'machine']
		else v_operation #> '{arguments,codingValue}' end;
	if v_machine_call then
		if v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
			or v_operation ->> 'toolVersion' is distinct from 'qorpera.machine-tools/v1'
			or not coalesce(public.qorpera_valid_machine_coding_value_call(v_operation -> 'arguments'), false)
			or v_operation #>> '{arguments,operationKey}' is distinct from v_operation ->> 'logicalOperationKey'
			or jsonb_typeof(v_target) is distinct from 'object' or v_target - array['realm', 'machineId'] <> '{}'::jsonb
			or v_target ->> 'realm' is distinct from 'company_machine'
			or coalesce(v_target ->> 'machineId' !~ v_uuid, true) then
			raise exception 'coding value capture call is malformed' using errcode = '22023';
		end if;
	elsif jsonb_typeof(v_envelope) is distinct from 'object'
$new$,
	$old$	-- The computer the run's screen lease holds now, at the generation the call names: plain reads. The box is sealed to
	-- the value's capture key, so no boot key is needed.
	select office.* into v_office from public.qorpera_runtime_offices as office
	where office.id = (v_target ->> 'companyComputerId')::uuid
		and office.profile_id = v_run.profile_id and office.environment_id = v_run.environment_id;
	if not found or v_office.generation is distinct from (v_target ->> 'computerGeneration')::bigint
		or not exists (select 1 from public.qorpera_runtime_office_screens as screen
			where screen.id = (v_target ->> 'screenId')::uuid and screen.office_id = v_office.id
				and screen.run_id = v_run.id and screen.staff_agent_id = v_run.staff_agent_id
				and screen.lease_id is not null and screen.lease_expires_at > clock_timestamp()) then
		raise exception 'company computer lease is unavailable' using errcode = '42501';
	end if;
$old$,
	$new$	if v_machine_call then
		-- 20260930705000: the company machine the call names, of the run's company and environment, running now on its
		-- current placement, reserved and with a known boot: plain reads, as machine_run's command authority reads them.
		-- The machine is the company's, so any agent of the company may use it. The box is bound to the placement and the
		-- boot, and sealed to the value's capture key.
		select machine.* into v_machine from public.qorpera_company_machines as machine
		where machine.id = (v_target ->> 'machineId')::uuid and machine.profile_id = v_run.profile_id
			and machine.environment_id = v_run.environment_id and machine.removed_at is null
			and machine.name = v_operation #>> '{arguments,machine}';
		v_placement := public.qorpera_company_machine_placement(v_machine.id);
		if v_machine.id is null or v_machine.desired_state is distinct from 'running' or v_placement.id is null
			or v_placement.running_at is null or v_placement.boot_id is null
			or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
			raise exception 'company machine is not running' using errcode = '42501';
		end if;
	else
	-- The computer the run's screen lease holds now, at the generation the call names: plain reads. The box is sealed to
	-- the value's capture key, so no boot key is needed.
	select office.* into v_office from public.qorpera_runtime_offices as office
	where office.id = (v_target ->> 'companyComputerId')::uuid
		and office.profile_id = v_run.profile_id and office.environment_id = v_run.environment_id;
	if not found or v_office.generation is distinct from (v_target ->> 'computerGeneration')::bigint
		or not exists (select 1 from public.qorpera_runtime_office_screens as screen
			where screen.id = (v_target ->> 'screenId')::uuid and screen.office_id = v_office.id
				and screen.run_id = v_run.id and screen.staff_agent_id = v_run.staff_agent_id
				and screen.lease_id is not null and screen.lease_expires_at > clock_timestamp()) then
		raise exception 'company computer lease is unavailable' using errcode = '42501';
	end if;
	end if;
$new$,
	$old$		or v_receipt.logical_operation_key is distinct from 'computer_browser:' || (v_operation ->> 'logicalOperationKey') then$old$,
	$new$		or v_receipt.logical_operation_key is distinct from (case when v_machine_call then 'save_coding_value:'
			else 'computer_browser:' end) || (v_operation ->> 'logicalOperationKey') then$new$,
	$old$		v_key.secret_id, v_current, v_key.key_id, v_key.public_key, v_office.id, v_office.generation;$old$,
	$new$		v_key.secret_id, v_current, v_key.key_id, v_key.public_key, v_office.id, v_office.generation,
		v_machine.id, v_placement.id, v_placement.boot_id;$new$
	]);
begin
	drop function public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities, jsonb,
		uuid, text, text, boolean);
	execute v_definition;
end $do$;
revoke all on function public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,
	jsonb, uuid, text, text, boolean) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The broker's read: a machine's call names the machine, its placement and its boot.
do $$ begin execute pg_temp.machine_save_patched(
	'public.qorpera_folder_read_coding_value_capture(uuid,text,jsonb,uuid,text,text)'::regprocedure, array[
	$old$		'receiptId', p_receipt_id,
		'companyComputerId', v_context.company_computer_id,
		'computerGeneration', v_context.computer_generation)
$old$,
	$new$		'receiptId', p_receipt_id)
		-- 20260930705000: what the box is bound to: the computer and its generation (an office's capture), or the company
		-- machine, its placement and its boot (save_coding_value).
		|| case when v_context.company_machine_id is null
			then jsonb_build_object('companyComputerId', v_context.company_computer_id,
				'computerGeneration', v_context.computer_generation)
			else jsonb_build_object('companyMachineId', v_context.company_machine_id,
				'placementId', v_context.machine_placement_id, 'bootId', v_context.machine_boot_id) end
$new$]); end $$;

-- 3. The coding executor's read: where the machine runs, and what the helper seals to ------------------------------------

-- The executor runs the helper only after this read, on the machine's node (or forwards the call to that node's
-- executor, which reads it again). The run's live tool authority in a company conversation on the company folder; the
-- call (exactly the agent's save_coding_value of this machine) and its own executing receipt; a company agent's run, not
-- a worker's, of a company neither paused nor being deleted, whose requester is an owner or admin; the machine; the
-- service; and a current capture key, as the office's read checks it (qorpera_native_office_coding_value_capture). A
-- machine not running now is answered (MACHINE_NOT_RUNNING); every other failure raises. Plain reads; writes nothing.
create function public.qorpera_authorize_machine_coding_value(p_binding jsonb, p_scope jsonb, p_receipt_id uuid,
	p_envelope text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_envelope jsonb;
	v_operation jsonb;
	v_value jsonb;
	v_identity jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_known public.qorpera_coding_value_services%rowtype;
	v_key public.qorpera_coding_value_capture_keys%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_named public.qorpera_cloud_secrets%rowtype;
	v_reserved public.qorpera_cloud_secrets%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930705000: the request, the run's authority, the receipt, the run, the machine, the service and the key.
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_scope) is distinct from 'object'
		or p_scope - 'machineId' <> '{}'::jsonb or coalesce(p_scope ->> 'machineId' !~ v_uuid, true) or p_receipt_id is null
		or p_envelope is null or octet_length(p_envelope) > 65536 then
		raise exception 'Machine coding value request is malformed' using errcode = '22023'; end if;
	begin
		v_envelope := p_envelope::jsonb;
	exception when others then
		raise exception 'Machine coding value request is malformed' using errcode = '22023';
	end;
	v_operation := v_envelope -> 'operation';
	if jsonb_typeof(v_envelope) is distinct from 'object'
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_operation ->> 'tool' is distinct from 'save_coding_value'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.machine-tools/v1'
		or not coalesce(public.qorpera_valid_machine_coding_value_call(v_operation -> 'arguments'), false)
		or v_operation #>> '{arguments,operationKey}' is distinct from v_operation ->> 'logicalOperationKey'
		or v_operation -> 'target' is distinct from jsonb_build_object('realm', 'company_machine',
			'machineId', p_scope ->> 'machineId') then
		raise exception 'Machine coding value request is malformed' using errcode = '22023'; end if;
	v_value := (v_operation -> 'arguments') - array['operationKey', 'machine'];
	-- The run's live tool authority: a company conversation's run on the company folder.
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	if v_identity ->> 'audienceKind' is distinct from 'company' then
		raise exception 'Machines belong to company conversations' using errcode = '42501'; end if;
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Coding values need a company on the company folder' using errcode = '0A000'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = (p_binding ->> 'runId')::uuid;
	-- This call's own receipt, still executing.
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or v_receipt.requires_company_revision is distinct from false
		or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
		or v_receipt.logical_operation_key is distinct from 'save_coding_value:' || (v_operation ->> 'logicalOperationKey') then
		raise exception 'Machine coding value receipt is unavailable' using errcode = '42501'; end if;
	-- A company agent's own run, never a worker's; a company not paused and not being deleted; a requester who is an
	-- owner or an admin.
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Coding value authority is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if public.qorpera_company_deleting(v_run.profile_id) then
		raise exception 'This company is being deleted' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can save coding values; ask one of them' using errcode = '42501'; end if;
	-- The machine the call names, of the run's company and environment.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = (p_scope ->> 'machineId')::uuid and machine.profile_id = v_run.profile_id
		and machine.environment_id = v_run.environment_id and machine.removed_at is null
		and machine.name = v_operation #>> '{arguments,machine}';
	if not found then
		raise exception 'Machine coding value authority is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	-- The agent hears this one: it starts the machine again.
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.machine-coding-value-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', v_machine.name); end if;
	-- The service, and the value's capture key: current, as the office's read requires it.
	select known.* into v_known from public.qorpera_coding_value_services as known where known.service = v_value ->> 'service';
	select capture.* into v_key from public.qorpera_coding_value_capture_keys as capture
	where capture.environment_id = v_run.environment_id and capture.secret_name = v_value ->> 'variable';
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.profile_id = v_run.profile_id;
	select secret.* into v_named from public.qorpera_cloud_secrets as secret
	where secret.profile_id = v_run.profile_id and secret.environment_id = v_run.environment_id
		and secret.owner_kind = 'company' and secret.connector_id = 'environment'
		and secret.secret_name = v_value ->> 'variable' and secret.status = 'active';
	select secret.* into v_reserved from public.qorpera_cloud_secrets as secret where secret.id = v_key.secret_id;
	if v_key.secret_id is null or v_authority.id is distinct from v_key.broker_authority_id
		or v_authority.key_id is distinct from v_key.key_id or v_authority.status is distinct from 'active'
		or (v_named.id is not null and v_named.id <> v_key.secret_id)
		or (v_named.id is null and v_reserved.id is not null) then
		raise exception 'The coding value''s capture key must be made again' using errcode = '55000'; end if;
	return jsonb_build_object(
		'schema', 'qorpera.machine-coding-value-authority/v1',
		'state', 'authorized',
		-- Where it runs: the executor of its node, and the instance there.
		'machineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'executorOwner', v_placement.owner,
		'providerId', v_placement.binding ->> 'providerId',
		'receiptId', p_receipt_id,
		-- What the helper checks the value against, seals it to and binds the box to.
		'target', jsonb_build_object(
			'schema', 'qorpera.coding-value-machine-target/v1',
			'service', v_known.service,
			'valuePattern', v_known.value_pattern,
			'variable', v_value ->> 'variable',
			'companyId', v_run.profile_id,
			'companyMachineId', v_machine.id,
			'placementId', v_placement.id,
			'bootId', v_placement.boot_id,
			'receiptId', p_receipt_id,
			'capturePublicKey', v_key.public_key));
end
$$;
revoke all on function public.qorpera_authorize_machine_coding_value(jsonb, jsonb, uuid, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_authorize_machine_coding_value(jsonb, jsonb, uuid, text) to service_role;

-- 4. The operations a run's observations may name, after the Co-Founder's (20260930702000) ----------------------------------

do $$ begin execute pg_temp.machine_save_patched('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	array[$old$/* 20260930702000 */'crew_and_members','offer_agents_to_member',$old$,
	$new$/* 20260930702000 */'crew_and_members','offer_agents_to_member',/* 20260930705000 */'save_coding_value',$new$]); end $$;

-- 5. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_valid_machine_coding_value_call(jsonb)',
		'public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,jsonb,uuid,text,text,boolean)',
		'public.qorpera_folder_read_coding_value_capture(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)',
		'public.qorpera_record_runtime_observation(uuid,jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930705000') = 0 then
			raise exception '20260930705000 marker is missing in %', v_function; end if;
	end loop;
	-- The office's path keeps its own marker in the context it shares.
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,jsonb,uuid,text,text,boolean)'::regprocedure),
			'20260930695000') = 0 then
		raise exception '20260930705000: the context lost its 20260930695000 marker'; end if;
	if (select provolatile from pg_proc where oid = 'public.qorpera_valid_machine_coding_value_call(jsonb)'::regprocedure) <> 's' then
		raise exception '20260930705000: the call check is not STABLE'; end if;
end $guard$;

drop function pg_temp.machine_save_patched(regprocedure, text[]);
