-- Company accounts A1-3: a company account's value typed into the Company Computer without any agent,
-- person or the native host seeing it (deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md, "Filling").
--
-- The office service makes an X25519 key pair in memory when it starts and reports the public half with
-- its readiness; it is kept on that activation row only, once. For a `computer_browser` `vault_fill` tool
-- call the vault reads the account's envelope and the computer's current key with
-- qorpera_fill_company_account, makes the value and seals it to that key; the host only carries the
-- sealed box to the office, which opens it inside the same tool call. A boot without a key gets no fill.

-- 1. The computer's fill key: 32 bytes as one fixed base64url form, never a low-order point (all-zero,
--    one, the two points of order 8, p-1, p, p+1; libsodium's list, with the unused top bit ignored).
create function public.qorpera_company_computer_fill_key_valid(p_key text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
	v_raw bytea;
	v_masked bytea;
begin
	-- 43 characters, the last carrying 4 bits, so exactly one spelling per key.
	if p_key is null or p_key !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' then
		return false;
	end if;
	v_raw := decode(translate(p_key, '-_', '+/') || '=', 'base64');
	if octet_length(v_raw) <> 32 then
		return false;
	end if;
	v_masked := set_byte(v_raw, 31, get_byte(v_raw, 31) & 127);
	return v_masked <> all (array[
		'\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
		'\x0100000000000000000000000000000000000000000000000000000000000000'::bytea,
		'\xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800'::bytea,
		'\x5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157'::bytea,
		'\xecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'::bytea,
		'\xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'::bytea,
		'\xeeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'::bytea
	]);
end
$$;
revoke all on function public.qorpera_company_computer_fill_key_valid(text) from public, anon, authenticated, service_role;

alter table public.qorpera_runtime_office_activations
	add column fill_public_key text
		check (fill_public_key is null or public.qorpera_company_computer_fill_key_valid(fill_public_key));

-- 2. The ready report takes the key. An older office reports without one and keeps working; its boot
--    gets no fill. The body is the current one (20260908001800 with 20260908002200's successor patch)
--    plus the key, which is checked before any lock and kept on this activation only: once, while it is
--    not yet active; the same key again (the office repeats its report until it is active) is accepted,
--    another key never.
do $$
begin
	if position('where activation_id=v_activation.activation_id returning * into v_activation;' in
		pg_get_functiondef('public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer)'::regprocedure)) = 0 then
		raise exception 'qorpera_report_runtime_office_ready differs from the reviewed body';
	end if;
end
$$;
drop function public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer);
create function public.qorpera_report_runtime_office_ready(p_startup jsonb,p_activation_id uuid,p_native_port integer,
	p_viewer_port integer,p_fill_public_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	if p_fill_public_key is not null and not public.qorpera_company_computer_fill_key_valid(p_fill_public_key) then
		raise exception 'Office fill key is malformed' using errcode='22023'; end if;
	v_activation:=public.qorpera_lock_runtime_office_startup(p_startup);
	if p_activation_id is distinct from v_activation.activation_id
		or p_native_port is distinct from (v_activation.attestation->>'nativePort')::integer
		or p_viewer_port is distinct from (v_activation.attestation->>'viewerPort')::integer then
		raise exception 'Office readiness differs' using errcode='42501'; end if;
	if p_fill_public_key is not null and (v_activation.fill_public_key is distinct from p_fill_public_key)
		and (v_activation.fill_public_key is not null or v_activation.state='active') then
		raise exception 'Office fill key differs' using errcode='42501'; end if;
	if v_activation.state<>'active' then
		update public.qorpera_runtime_office_activations set state='ready',service_invocation_id=p_startup->>'serviceInvocationId',
			ready_at=clock_timestamp(),fill_public_key=coalesce(fill_public_key,p_fill_public_key)
		where activation_id=v_activation.activation_id returning * into v_activation;
	end if;
	return public.qorpera_runtime_office_startup_result(v_activation);
end
$$;
revoke all on function public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer,text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer,text) to service_role;

-- 3. The browser action. `vault_fill` names the box as `fill` does, the account and the field; the text
--    never appears in the action, a receipt or a transcript.
create or replace function public.qorpera_valid_office_browser_action(p_args jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_action text:=p_args->>'action'; v_keys text[]; v_key_pattern text:=
    '^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$';
begin
    if jsonb_typeof(p_args) is distinct from 'object' then return false; end if;
    if p_args->>'kind'='screenshot' then return p_args='{"kind":"screenshot","surface":"browser"}'::jsonb; end if;
    if p_args->>'kind' is distinct from 'browser' or v_action is null then return false; end if;
    v_keys:=array['kind','action'];
    case v_action
    when 'snapshot' then null;
    when 'list_tabs' then
        if p_args ? 'afterTabId' then
            v_keys:=v_keys||array['afterTabId'];
            if jsonb_typeof(p_args->'afterTabId') is distinct from 'string' or (p_args->>'afterTabId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return false; end if;
        end if;
    when 'select_tab' then
        v_keys:=v_keys||array['tabId'];
        if jsonb_typeof(p_args->'tabId') is distinct from 'string' or (p_args->>'tabId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return false; end if;
    when 'navigate' then
        v_keys:=v_keys||array['url'];
        if jsonb_typeof(p_args->'url') is distinct from 'string' or octet_length(p_args->>'url')>8192
            or (p_args->>'url') !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(/[^[:cntrl:]]*)?$' then return false; end if;
    when 'click', 'fill' then
        v_keys:=v_keys||array['role','name'];
        if coalesce(p_args->>'role','') not in ('button','link','textbox','checkbox','radio','combobox','tab')
            or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
            or octet_length(p_args->>'name')>512 then return false; end if;
        if v_action='fill' then
            v_keys:=v_keys||array['text'];
            if p_args->>'role' not in ('textbox','combobox') or jsonb_typeof(p_args->'text') is distinct from 'string'
                or octet_length(p_args->>'text')>16384 then return false; end if;
        end if;
    when 'vault_fill' then
        -- A password box is a textbox to the accessibility tree; a number box for a code is a spinbutton.
        v_keys:=v_keys||array['role','name','account','field'];
        if coalesce(p_args->>'role','') not in ('textbox','spinbutton')
            or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
            or octet_length(p_args->>'name')>512
            or jsonb_typeof(p_args->'account') is distinct from 'string'
            or (p_args->>'account') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or coalesce(p_args->>'field','') not in ('login','password','code') then return false; end if;
    when 'press' then
        v_keys:=v_keys||array['key'];
        if jsonb_typeof(p_args->'key') is distinct from 'string' or (p_args->>'key') !~ v_key_pattern then return false; end if;
    else return false;
    end case;
    return p_args-v_keys='{}'::jsonb;
end
$$;
revoke all on function public.qorpera_valid_office_browser_action(jsonb) from public,anon,authenticated,service_role;

-- 4. The vault's read for one fill. Bound to the agent's executing `computer_browser` receipt of exactly
--    this `vault_fill` call (the broker passes the call's operation envelope; its SHA-256 is the receipt's
--    input digest), the company's own website account, and the computer the run's screen lease holds:
--    its current generation and its current active activation, which must have a key. Checks in the
--    account calls' order (qorpera_company_account_call): authorization by plain read before any lock,
--    every comparison null-safe.
create function public.qorpera_fill_company_account(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_envelope jsonb;
	v_operation jsonb;
	v_target jsonb;
	v_account_id uuid;
	v_field text;
	v_office public.qorpera_runtime_offices%rowtype;
	v_key text;
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
	if public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Accounts for folder companies come with their connection file' using errcode = '0A000';
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
	-- The call itself: one vault_fill of the company computer's browser, read before any lock.
	if p_envelope is null or octet_length(p_envelope) > 65536 then
		raise exception 'company account fill call is malformed' using errcode = '22023';
	end if;
	begin
		v_envelope := p_envelope::jsonb;
	exception when others then
		raise exception 'company account fill call is malformed' using errcode = '22023';
	end;
	v_operation := v_envelope -> 'operation';
	v_target := v_operation #> '{target,binding}';
	if jsonb_typeof(v_envelope) is distinct from 'object'
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_operation ->> 'tool' is distinct from 'computer_browser'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.company-computer-tools/v2'
		or v_operation #>> '{target,realm}' is distinct from 'company_computer'
		or not coalesce(public.qorpera_valid_office_browser_action(v_operation -> 'arguments'), false)
		or v_operation #>> '{arguments,action}' is distinct from 'vault_fill'
		or jsonb_typeof(v_target) is distinct from 'object'
		or coalesce(v_target ->> 'companyComputerId' !~ v_uuid, true)
		or coalesce(v_target ->> 'screenId' !~ v_uuid, true)
		or coalesce(v_target ->> 'computerGeneration' !~ '^[1-9][0-9]{0,15}$', true) then
		raise exception 'company account fill call is malformed' using errcode = '22023';
	end if;
	v_account_id := (v_operation #>> '{arguments,account}')::uuid;
	v_field := v_operation #>> '{arguments,field}';
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id
	for update;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or v_receipt.requires_company_revision is distinct from false
		or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or v_receipt.downstream_idempotency_sha256 is distinct from p_downstream_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from 'computer_browser:' || (v_operation ->> 'logicalOperationKey') then
		raise exception 'company account fill receipt is unavailable' using errcode = '42501';
	end if;
	-- The computer the run's screen lease holds now, at the generation the call names, and that boot's key.
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
	select activation.fill_public_key into v_key from public.qorpera_runtime_office_activations as activation
	where activation.office_id = v_office.id and activation.computer_generation = v_office.generation
		and activation.superseded_at is null and activation.state = 'active';
	if v_key is null then
		raise exception 'This computer cannot type account values until it restarts on a newer image' using errcode = '0A000';
	end if;
	v_account := public.qorpera_company_account_locked(v_run.profile_id, v_run.environment_id, v_authority.id,
		v_account_id);
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
		'schema', 'qorpera.company-account-fill-context/v1',
		-- The envelope's associated data, for the broker to open it.
		'companyId', v_account.profile_id,
		'environmentId', v_account.environment_id,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		-- What the sealed box is bound to.
		'receiptId', p_receipt_id,
		'field', v_field,
		'companyComputerId', v_office.id,
		'computerGeneration', v_office.generation,
		'fillPublicKey', v_key
	);
end
$$;
revoke all on function public.qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text) to qorpera_secret_broker;
